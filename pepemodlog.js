// pepemodlog.js — 1.99zf: Pepe's mod log per room, on the site (the pad owner panel's "🛡️ Moderation history").
//
// Pepe keeps his mod log in daily JSONL files (camfrog-bot modlogs/, log_mod_event): kicks, bans, time-outs (punish), mic
// blocks, role changes, topic changes - what the Camfrog server announces and what Pepe did himself - plus his automod notes
// (strikes, mic-hog strikes, suspensions, demotions, fines, !say refusals). pepe_modlogsync.py hooks the same place,
// queues each MODERATION entry (an allow-list: never relayed chat lines, tips, PMs or economy moves) and posts batches here
// from a worker thread - never on the packet path; a one-off backfill sends the last 30 days. Each entry carries a key
// (a hash of its log line), so a replay or the backfill never doubles a row.
//
//   pepe_modlog (id, k UNIQUE, room_id, room_l, ts ms, type, cat, actor, target, details, src 'pepe')
//
// The history also shows the site's own room moderation from room_events (bridge-block = web bridge blocks / unblocks,
// livecam-end = a mod ending someone's live cam view, and any other livecam-* / snap-* / cam-* room event).
//
// Routes:
//   POST /api/bridge/modlog          Pepe (bot token): {events: [{k, ts, type, actor, target, details, room}]} (<= 500)
//   GET  /api/rooms/:slug/modlog     the pad's owner, site staff, or a room mod by Pepe's caps: ?cat= &q= &page= &limit=
//   GET  /api/admin/pepe/modlog      site Admins, every room: ?room= &cat= &q= &page= &limit=
// Owners only ever see their own room (the query is pinned to the pad's room id); Admins see all.
"use strict";
const express = require("express");
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

const KEEP_MS = 400 * 24 * 3600 * 1000;
const BATCH_MAX = 500;
const PAGE_MAX = 100;
const CATS = ["kick", "ban", "timeout", "mic", "roles", "automod", "bridge", "room", "misc"];
// the moderation entries the site keeps (Pepe filters with the same list); "pepe_<x>" = Pepe did <x> on someone's order
const ALLOW = /^(?:(?:pepe_)?(?:kick|ban|unban|punish|unpunish|block|unblock|role_[a-z]+|topic|room_untimeout|timeout|untimeout)|strike|michog_strike|suspension|demoted|fine|modfine|modfine-warning|say_mod_[a-z_]+)$/;
const SITE_WHAT = ["bridge-block", "livecam-end"];
const SITE_LIKE = ["livecam-%", "snap-%", "cam-%"];

const CTRL = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const clean = (s, n) => String(s == null ? "" : s).replace(CTRL, " ").replace(/\s+/g, " ").trim().slice(0, n);

function catOf(type) {
  const t = String(type || "").replace(/^pepe_/, "");
  if (t === "kick") return "kick";
  if (t === "ban" || t === "unban") return "ban";
  if (/^(punish|unpunish|room_untimeout|timeout|untimeout)$/.test(t)) return "timeout";
  if (t === "block" || t === "unblock") return "mic";
  if (/^role_/.test(t)) return "roles";
  if (/^(strike|michog_strike|suspension|demoted|fine|modfine|modfine-warning|say_mod_.+)$/.test(t)) return "automod";
  if (t === "bridge-block" || /^(livecam|snap|cam)-/.test(t)) return "bridge";
  if (t === "topic") return "room";
  return "misc";
}

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS pepe_modlog (id INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT NOT NULL UNIQUE, room_id TEXT NOT NULL,
        room_l TEXT NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL, cat TEXT NOT NULL, actor TEXT, target TEXT, details TEXT, src TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS pepe_modlog_room ON pepe_modlog (room_l, ts)");
      await runQuery("CREATE INDEX IF NOT EXISTS pepe_modlog_ts ON pepe_modlog (ts)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

let lastPrune = 0;
/** Store Pepe's entries (deduped by key). -> {stored, skipped} */
async function ingest(events, t = Date.now()) {
  await init();
  let stored = 0, skipped = 0;
  for (const e of (Array.isArray(events) ? events : []).slice(0, BATCH_MAX)) {
    const type = clean(e && e.type, 40);
    const k = clean(e && e.k, 64);
    const room = clean(e && e.room, 128);
    const ts = Math.floor(Number(e && e.ts));
    if (!k || !room || !ALLOW.test(type) || !(ts > 0) || ts > t + 3600 * 1000 || ts < t - KEEP_MS) { skipped++; continue; }
    const r = await runQuery(`INSERT OR IGNORE INTO pepe_modlog (k, room_id, room_l, ts, type, cat, actor, target, details, src)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pepe')`,
      [k, room, room.toLowerCase(), ts, type, catOf(type), clean(e.actor, 80) || null, clean(e.target, 80) || null, clean(e.details, 300) || null]);
    if (r && r.changes) stored++; else skipped++;
  }
  if (t - lastPrune > 24 * 3600 * 1000) {
    lastPrune = t;
    runQuery("DELETE FROM pepe_modlog WHERE ts < ?", [t - KEEP_MS]).catch((err) => console.error("[pepemodlog] prune:", err.message));
  }
  return { stored, skipped };
}

/**
 * The history, newest first: Pepe's entries + the site's room moderation events. room = a room id (null = every room - Admins).
 * -> {rows: [{ts, type, cat, actor, target, details, room, src}], page, more}
 */
async function history({ room = null, cat = "", q = "", page = 0, limit = 50 } = {}) {
  await init();
  const lim = Math.max(1, Math.min(PAGE_MAX, Math.floor(Number(limit)) || 50));
  const pg = Math.max(0, Math.min(1000, Math.floor(Number(page)) || 0));
  const c = CATS.includes(String(cat)) ? String(cat) : "";
  const needle = clean(q, 40).toLowerCase();
  const pw = [], pa = [], sw = [], sa = [];
  if (room != null) { pw.push("room_l = ?"); pa.push(String(room).toLowerCase()); sw.push("lower(room_id) = ?"); sa.push(String(room).toLowerCase()); }
  sw.push("(" + SITE_WHAT.map(() => "what = ?").concat(SITE_LIKE.map(() => "what LIKE ?")).join(" OR ") + ")");
  sa.push(...SITE_WHAT, ...SITE_LIKE);
  if (needle) {
    const like = "%" + needle.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
    pw.push("(lower(coalesce(actor,'')) LIKE ? ESCAPE '\\' OR lower(coalesce(target,'')) LIKE ? ESCAPE '\\' OR lower(coalesce(details,'')) LIKE ? ESCAPE '\\')");
    pa.push(like, like, like);
    sw.push("(lower(coalesce(actor,'')) LIKE ? ESCAPE '\\' OR lower(coalesce(detail,'')) LIKE ? ESCAPE '\\')");
    sa.push(like, like);
  }
  const parts = [], args = [];
  if (!c || c !== "bridge") {
    parts.push(`SELECT ts, type, cat, actor, target, details, room_id AS room, 'pepe' AS src FROM pepe_modlog
                WHERE ${pw.length ? pw.join(" AND ") : "1"} ${c ? "AND cat = ?" : ""}`);
    args.push(...pa); if (c) args.push(c);
  }
  if (!c || c === "bridge") {
    parts.push(`SELECT ts, what AS type, 'bridge' AS cat, actor, NULL AS target, detail AS details, room_id AS room, 'site' AS src FROM room_events
                WHERE ${sw.join(" AND ")}`);
    args.push(...sa);
  }
  if (c === "bridge") {         // Pepe's own bridge-ish rows (none are on his allow-list today, kept for symmetry)
    parts.push(`SELECT ts, type, cat, actor, target, details, room_id AS room, 'pepe' AS src FROM pepe_modlog
                WHERE ${pw.length ? pw.join(" AND ") + " AND" : ""} cat = 'bridge'`);
    args.push(...pa);
  }
  const rows = await getQuery(`SELECT * FROM (${parts.join(" UNION ALL ")}) ORDER BY ts DESC LIMIT ? OFFSET ?`, [...args, lim + 1, pg * lim]);
  const more = rows.length > lim;
  return { rows: rows.slice(0, lim).map((r) => ({ ts: Number(r.ts) || 0, type: r.type, cat: r.cat || catOf(r.type), actor: r.actor || "",
    target: r.target || "", details: r.details || "", room: r.room || "", src: r.src })), page: pg, more, cats: CATS };
}

function register(app, { isBotToken, addUser, bySlug }) {
  init().catch((e) => console.error("[pepemodlog] init:", e.message));
  const bad = (res, st, error) => res.status(st).json({ ok: false, error });
  const fail = (res, e) => { console.error("[pepemodlog]", e); bad(res, 500, "Couldn't load the moderation history."); };

  app.post("/api/bridge/modlog", express.json({ limit: "512kb" }), async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, ...(await ingest(b.events)) }); } catch (e) { console.error("[pepemodlog] ingest:", e); res.status(500).json({ ok: false }); }
  });

  // the pad's owner panel: the owner, site staff (rooms.canManage), or a room mod by Pepe's caps (kick powers or more)
  app.get("/api/rooms/:slug/modlog", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!req.user || !req.user.userId) return bad(res, 401, "Sign in first.");
      const R = await require("./roomsweb").resolveRoom(req.params.slug);
      if (!R) return bad(res, 404, "No such pad.");
      const me = (await getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [req.user.userId]))[0];
      if (!me) return bad(res, 401, "Sign in first.");
      let ok = await require("./rooms").canManage(me, R.id);
      if (!ok && me.camfrogUsername && bySlug) {
        try {
          const L = bySlug(req.params.slug);
          const caps = L && L.id === R.id ? require("./padmod").capsFor(L, me.camfrogUsername) : null;
          ok = !!(caps && Array.isArray(caps.actions) && caps.actions.includes("kick"));
        } catch (e) { ok = false; }
      }
      if (!ok) return bad(res, 403, "Only this room's mods, the pad's owner and admins can see its moderation history.");
      res.json({ ok: true, room: R.id, ...(await history({ room: R.id, cat: req.query.cat, q: req.query.q, page: req.query.page, limit: req.query.limit })) });
    } catch (e) { fail(res, e); }
  });

  app.get("/api/admin/pepe/modlog", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!req.user || !req.user.userId) return bad(res, 401, "Sign in first.");
      const me = (await getQuery("SELECT class FROM users WHERE userId = ?", [req.user.userId]))[0];
      if (!SP.can(me, "pepe.modlog")) return bad(res, 403, "Admins only.");
      const room = req.query.room ? clean(req.query.room, 128) : null;
      res.json({ ok: true, ...(await history({ room, cat: req.query.cat, q: req.query.q, page: req.query.page, limit: req.query.limit })) });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { init, register, ingest, history, catOf, ALLOW, CATS };
