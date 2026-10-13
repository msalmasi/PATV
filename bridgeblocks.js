// bridgeblocks.js — 1.99xa: block a WEB sender from relaying into a pad's chat room (the "!bridge block" family).
//
// A room's mods / the pad's owner / Pepe's admins can stop one PATV account from talking into a bridged Camfrog room from the
// website (relay lines, clips, typed "!" commands, the 🐸 Pepe menu) - for a while or until lifted, with a reason. It blocks the
// ACCOUNT's web relay only: a linked chat login keeps its normal Camfrog chat (that is what !kick / !ban / !timeout are for).
// Pepe admins (site Admins on the web) can block an account in every room at once (room_id '' = global).
//
// The SITE is the source of truth:
//   bridge_blocks  (room_id, user_id) PK - room_id '' = every room; username (shown), reason, blocked_by (the blocker's
//                  userId when known), blocker_name (a label: PATV username or "chat:<login>"), via (web | chat | admin),
//                  created, until (ms, NULL = until lifted), updated, op_key (the bot call's idempotency key)
// Every write is one dbUtils.tx (never a raw BEGIN); a block / unblock is idempotent by its key (room, account) - a bot call
// replayed with the same `key` changes nothing. Audit: a room block / unblock goes in the pad's event log (rooms.event,
// "bridge-block"), a global one in admin_audit (action "bridge_block").
//
// Enforced twice: bridge-relay.js refuses a blocked account's say / clip / command (`refusal`), and Pepe refuses its relay jobs
// from his MIRROR (camfrog-bot pepe_bridgeblock.py) - the bridge sync response carries the rows whenever Pepe's mirror version
// differs (`forSync`), so a stale or unreachable site is still covered by what he already knows.
//
// Routes:
//   POST /api/bridge/blocks                 Pepe (bot token): {op: block|unblock|list, room, global, target, by, until, secs, reason, key}
//                                           - Pepe has already checked that `by` may do it in that room (his own mod / owner / admin checks)
//   GET  /api/rooms/:slug/blocks            the pad's blocks (owner, site staff, or a room mod by Pepe's caps for their linked login)
//   POST /api/rooms/:slug/blocks            {op: block|unblock, target, hours, reason} (same people; JSON + X-Requested-With + same site)
//   GET  /api/admin/bridge/blocks           every block (site Admins)
//   POST /api/admin/bridge/blocks           {op, room ('' = every room), target, hours, reason} (site Admins)
"use strict";
const express = require("express");
const { runQuery, getQuery, tx } = require("./dbUtils");

const REASON_MAX = 120;
const MAX_MS = 365 * 24 * 3600 * 1000;
const ACCT_RE = /^u:([A-Za-z0-9-]{6,64})$/;
const NAME_RE = /^[\w.\-$]{1,40}$/;
const WEB_MARK = "\u{1f310}";

let clock = () => Date.now();
const now = () => clock();
let ver = "boot-" + Date.now().toString(36);      // Pepe re-reads the mirror after a site restart
let seq = 0;
const bump = () => { ver = now().toString(36) + "-" + (++seq); };

const CTRL = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const clean = (s, n) => String(s == null ? "" : s).replace(CTRL, " ").replace(/<[^<>]{0,60}>/g, "").replace(/\s+/g, " ").trim().slice(0, n);

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS bridge_blocks (room_id TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT, reason TEXT,
        blocked_by TEXT, blocker_name TEXT, via TEXT, created INTEGER NOT NULL, until INTEGER, updated INTEGER NOT NULL, op_key TEXT,
        PRIMARY KEY (room_id, user_id))`);
      await runQuery("CREATE INDEX IF NOT EXISTS bridge_blocks_user ON bridge_blocks (user_id)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function hasArchived() {
  try { return (await getQuery("PRAGMA table_info(users)")).some((c) => c.name === "archived_at"); } catch (e) { return false; }
}

/**
 * Who a mod means: "🌐name" (a PATV username), "u:<userId>", a linked chat login, or a PATV username.
 * -> {userId, username, login} | {error}. A bare name tries the chat login first (what the room sees), then the username.
 */
async function resolveTarget(raw) {
  let s = String(raw == null ? "" : raw).trim().replace(/^@/, "");
  if (!s) return { error: "Who? Give a name." };
  const live = (await hasArchived()) ? "AND archived_at IS NULL" : "";
  const pick = (r) => (r ? { userId: String(r.userId), username: r.username, login: r.camfrogUsername || null } : null);
  const m = ACCT_RE.exec(s);
  if (m) {
    const r = (await getQuery(`SELECT userId, username, camfrogUsername FROM users WHERE userId = ? ${live}`, [m[1]]))[0];
    return pick(r) || { error: "No PATV account has that id." };
  }
  let webOnly = false;
  if (s.startsWith(WEB_MARK)) { s = s.slice(WEB_MARK.length).trim(); webOnly = true; }
  s = s.replace(/^@/, "");
  if (!NAME_RE.test(s)) return { error: "That isn't a name." };
  const low = s.toLowerCase();
  if (!webOnly) {
    const r = (await getQuery(`SELECT userId, username, camfrogUsername FROM users WHERE lower(camfrogUsername) = ? ${live} LIMIT 2`, [low]));
    if (r.length === 1) return pick(r[0]);
  }
  const r = (await getQuery(`SELECT userId, username, camfrogUsername FROM users WHERE lower(username) = ? ${live} LIMIT 1`, [low]))[0];
  return pick(r) || { error: `No PATV account called ${s}.` };
}

const rowOut = (r) => r && ({ room: r.room_id, global: r.room_id === "", userId: r.user_id, username: r.username, reason: r.reason || "",
  by: r.blocker_name || "", via: r.via || "", created: Number(r.created) || 0, until: r.until == null ? null : Number(r.until) });

/** The active block on this account in this room (a room block first, else a global one), or null. */
async function active(roomId, userId, t = now()) {
  if (!userId) return null;
  await init();
  const rows = await getQuery("SELECT * FROM bridge_blocks WHERE user_id = ? AND (room_id = ? OR room_id = '') AND (until IS NULL OR until > ?)",
    [String(userId), String(roomId || ""), t]);
  const r = rows.find((x) => x.room_id !== "") || rows[0];
  return r ? rowOut(r) : null;
}

/** Why the relay refuses this account in this room (null = it may). For bridge-relay.js. */
async function refusal(roomId, userId) {
  let b = null;
  try { b = await active(roomId, userId); } catch (e) { b = null; }
  if (!b) return null;
  const when = b.until ? " until " + new Date(b.until).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "";
  return (b.global ? "You're blocked from talking into chat rooms from the website" : "A mod of this room blocked you from talking in it from the website")
    + when + (b.reason ? " (" + b.reason + ")" : "") + ".";
}

function untilFrom({ until, secs, hours }, t) {
  if (until != null && until !== "") {
    const u = Math.floor(Number(until));
    if (!(u > t)) return { error: "That time is already over." };
    return { until: Math.min(u, t + MAX_MS) };
  }
  const s = secs != null && secs !== "" ? Number(secs) : hours != null && hours !== "" ? Number(hours) * 3600 : null;
  if (s == null || s === 0) return { until: null };                // until lifted
  if (!(s > 0)) return { error: "That isn't a length of time." };
  return { until: t + Math.min(Math.floor(s * 1000), MAX_MS) };
}

/**
 * Block (or re-block) `target` in `roomId` ('' = every room). by = {userId?, name, via}. key = the caller's idempotency key.
 * -> {block, again} | {error}
 */
async function block({ roomId, target, until = null, reason = "", by = {}, key = null }) {
  await init();
  const room = String(roomId == null ? "" : roomId).slice(0, 128);
  const k = key ? String(key).slice(0, 80) : null;
  const t = now();
  const why = clean(reason, REASON_MAX);
  const out = await tx(async () => {
    const cur = (await getQuery("SELECT * FROM bridge_blocks WHERE room_id = ? AND user_id = ?", [room, target.userId]))[0];
    if (cur && k && cur.op_key === k) return { block: rowOut(cur), again: true };
    await runQuery(`INSERT INTO bridge_blocks (room_id, user_id, username, reason, blocked_by, blocker_name, via, created, until, updated, op_key)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(room_id, user_id) DO UPDATE SET username = excluded.username, reason = excluded.reason,
                      blocked_by = excluded.blocked_by, blocker_name = excluded.blocker_name, via = excluded.via, until = excluded.until,
                      updated = excluded.updated, op_key = excluded.op_key`,
      [room, target.userId, target.username || null, why || null, by.userId || null, clean(by.name, 60) || null, clean(by.via, 12) || null,
       t, until, t, k]);
    const detail = `${cur ? "re-blocked" : "blocked"} ${target.username || target.userId} from the web relay`
      + (until ? " until " + new Date(until).toISOString().slice(0, 16).replace("T", " ") + " UTC" : " until lifted")
      + (why ? " - " + why : "") + ` (${clean(by.via, 12) || "?"})`;
    await audit(room, "block", by, target, detail, { until, reason: why });
    const row = (await getQuery("SELECT * FROM bridge_blocks WHERE room_id = ? AND user_id = ?", [room, target.userId]))[0];
    return { block: rowOut(row), again: false };
  });
  if (!out.again) bump();
  return out;
}

/** Lift a block. -> {removed} (false = there was none; idempotent). */
async function unblock({ roomId, target, by = {}, key = null }) {
  await init();
  const room = String(roomId == null ? "" : roomId).slice(0, 128);
  const out = await tx(async () => {
    const cur = (await getQuery("SELECT * FROM bridge_blocks WHERE room_id = ? AND user_id = ?", [room, target.userId]))[0];
    if (!cur) return { removed: false };
    await runQuery("DELETE FROM bridge_blocks WHERE room_id = ? AND user_id = ?", [room, target.userId]);
    await audit(room, "unblock", by, target, `unblocked ${target.username || target.userId} on the web relay (${clean(by.via, 12) || "?"})`, { key });
    return { removed: true };
  });
  if (out.removed) bump();
  return out;
}

async function audit(room, op, by, target, detail, extra) {
  if (room) {
    await require("./rooms").event(room, "bridge-block", clean(by.name, 60) || null, detail);
  } else {
    await require("./adminaudit").record({ userId: by.userId || "pepe", username: clean(by.name, 60) || "pepe" }, "bridge_block",
      { userId: target.userId, username: target.username || null }, Object.assign({ op, room: "*", via: clean(by.via, 12) || null }, extra || {}),
      extra && extra.reason ? extra.reason : null);
  }
}

/** Active blocks: a room's (with the global ones when `withGlobal`), or every one (roomId null). */
async function list(roomId = null, { withGlobal = true } = {}) {
  await init();
  const t = now();
  let rows;
  if (roomId == null) rows = await getQuery("SELECT * FROM bridge_blocks WHERE until IS NULL OR until > ? ORDER BY updated DESC LIMIT 500", [t]);
  else {
    rows = await getQuery(`SELECT * FROM bridge_blocks WHERE (room_id = ? ${withGlobal ? "OR room_id = ''" : ""}) AND (until IS NULL OR until > ?)
                           ORDER BY updated DESC LIMIT 300`, [String(roomId), t]);
  }
  return rows.map(rowOut);
}

/** Pepe's mirror: every active block + the account's CURRENT chat login (a relay job from an old site may carry only it). */
async function mirror() {
  await init();
  const rows = await getQuery(`SELECT b.room_id, b.user_id, b.username, b.until, b.reason, u.camfrogUsername AS login FROM bridge_blocks b
                               LEFT JOIN users u ON u.userId = b.user_id WHERE b.until IS NULL OR b.until > ? LIMIT 5000`, [now()]);
  return { v: ver, rows: rows.map((r) => ({ room: r.room_id, user_id: r.user_id, username: r.username || null, login: r.login || null,
                                            until: r.until == null ? null : Number(r.until), reason: r.reason || "" })) };
}

/** The bridge sync response's extra field: the mirror when Pepe (relay_cap) has an older version than ours. */
async function forSync(body) {
  if (!body || !(body.relay_cap === 1 || body.relay_cap === true)) return {};
  if (String(body.blocks_v || "") === ver) return {};
  try { return { bridge_blocks: await mirror() }; } catch (e) { console.error("[bridgeblocks] mirror:", e.message); return {}; }
}

function parseHours(v) {
  if (v == null || v === "" || v === "perm") return { hours: 0 };
  const n = Number(v);
  if (n === 0) return { hours: 0 };
  return Number.isFinite(n) && n > 0 && n <= 24 * 365 ? { hours: n } : { error: "Pick a length (in hours), or until lifted." };
}

function register(app, { isBotToken, addUser, bySlug }) {
  init().catch((e) => console.error("[bridgeblocks] init:", e.message));
  const guard = require("./middleware/authGuard");
  const bad = (res, st, error) => res.status(st).json({ ok: false, error });
  const fail = (res, e) => { console.error("[bridgeblocks]", e); bad(res, 500, "Something went wrong - nothing changed."); };

  // ── Pepe: !bridge block / unblock / blocks ──
  app.post("/api/bridge/blocks", express.json({ limit: "4kb" }), async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    res.set("Cache-Control", "no-store");
    try {
      const op = String(b.op || "");
      const room = b.global ? "" : String(b.room || "").slice(0, 128);
      if (!b.global && !room) return bad(res, 400, "Which room?");
      if (op === "list") return res.json({ ok: true, blocks: await list(room || null, { withGlobal: true }), v: ver });
      if (op !== "block" && op !== "unblock") return bad(res, 400, "op must be block, unblock or list");
      const target = await resolveTarget(b.target);
      if (target.error) return bad(res, 404, target.error);
      const by = { userId: null, name: "chat:" + clean(b.by, 40), via: "chat" };
      try {
        const byAcc = (await getQuery("SELECT userId, username FROM users WHERE lower(camfrogUsername) = ? LIMIT 1", [clean(b.by, 40).toLowerCase()]))[0];
        if (byAcc) { by.userId = String(byAcc.userId); by.name = byAcc.username + " (chat " + clean(b.by, 40) + ")"; }
      } catch (e) { /* the label is enough */ }
      if (op === "unblock") return res.json({ ok: true, target, ...(await unblock({ roomId: room, target, by, key: b.key })), v: ver });
      const u = untilFrom({ until: b.until, secs: b.secs }, now());
      if (u.error) return bad(res, 400, u.error);
      return res.json({ ok: true, target, ...(await block({ roomId: room, target, until: u.until, reason: b.reason, by, key: b.key })), v: ver });
    } catch (e) { fail(res, e); }
  });

  // ── the pad's owner page ("Moderate your room") ──
  async function padCtx(req, res, write) {
    if (write && (!req.is("application/json") || req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req))) { bad(res, 400, "Bad request."); return null; }
    if (!req.user || !req.user.userId) { bad(res, 401, "Sign in first."); return null; }
    const R = await require("./roomsweb").resolveRoom(req.params.slug);
    if (!R) { bad(res, 404, "No such pad."); return null; }
    const rooms = require("./rooms");
    const me = (await getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [req.user.userId]))[0];
    if (!me) { bad(res, 401, "Sign in first."); return null; }
    let ok = await rooms.canManage(me, R.id);
    if (!ok && me.camfrogUsername && bySlug) {
      // a mod of the room by Pepe's own roles (the caps his snapshot sent for this linked login) - kick powers or more
      try {
        const L = bySlug(req.params.slug);
        const caps = L && L.id === R.id ? require("./padmod").capsFor(L, me.camfrogUsername) : null;
        ok = !!(caps && Array.isArray(caps.actions) && caps.actions.includes("kick"));
      } catch (e) { ok = false; }
    }
    if (!ok) { bad(res, 403, "Only this room's mods, the pad's owner and admins can do that."); return null; }
    return { R, me };
  }
  app.get("/api/rooms/:slug/blocks", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const c = await padCtx(req, res, false); if (!c) return;
      res.json({ ok: true, blocks: await list(c.R.id, { withGlobal: true }) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/blocks", addUser, express.json({ limit: "2kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const c = await padCtx(req, res, true); if (!c) return;
      const b = req.body || {};
      const target = await resolveTarget(b.target);
      if (target.error) return bad(res, 404, target.error);
      const by = { userId: String(c.me.userId), name: c.me.username, via: "web" };
      if (b.op === "unblock") return res.json({ ok: true, target, ...(await unblock({ roomId: c.R.id, target, by })) });
      if (b.op !== "block") return bad(res, 400, "block or unblock");
      if (target.userId === String(c.me.userId)) return bad(res, 400, "That's you.");
      const h = parseHours(b.hours);
      if (h.error) return bad(res, 400, h.error);
      const u = untilFrom({ hours: h.hours }, now());
      res.json({ ok: true, target, ...(await block({ roomId: c.R.id, target, until: u.until, reason: b.reason, by })) });
    } catch (e) { fail(res, e); }
  });

  // ── admins: every block, and global ones ──
  async function admin(req, res, write) {
    if (write && (!req.is("application/json") || req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req))) { bad(res, 400, "Bad request."); return null; }
    if (!req.user || !req.user.userId) { bad(res, 401, "Sign in first."); return null; }
    const me = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]))[0];
    if (!me || me.class !== "Admin") { bad(res, 403, "Admins only."); return null; }
    return me;
  }
  app.get("/api/admin/bridge/blocks", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { if (!(await admin(req, res, false))) return; res.json({ ok: true, blocks: await list(null) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/bridge/blocks", addUser, express.json({ limit: "2kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const me = await admin(req, res, true); if (!me) return;
      const b = req.body || {};
      const room = String(b.room || "").trim().slice(0, 128);
      const target = await resolveTarget(b.target);
      if (target.error) return bad(res, 404, target.error);
      const by = { userId: String(me.userId), name: me.username, via: "admin" };
      if (b.op === "unblock") return res.json({ ok: true, target, ...(await unblock({ roomId: room, target, by })) });
      if (b.op !== "block") return bad(res, 400, "block or unblock");
      const h = parseHours(b.hours);
      if (h.error) return bad(res, 400, h.error);
      res.json({ ok: true, target, ...(await block({ roomId: room, target, until: untilFrom({ hours: h.hours }, now()).until, reason: b.reason, by })) });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { init, register, resolveTarget, active, refusal, block, unblock, list, mirror, forSync, untilFrom, parseHours,
  version: () => ver, _setClock: (f) => { clock = f; } };
