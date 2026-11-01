// seethrough.js - 1.99afn: the see-through audit (spec E.5; follow-ups FU-3 section 3.4) and the reveal toggle (owner J-18).
//
// See-through = showing an admin, or a pad's owner on their own pad, WHO is behind a frog name. It is never passive: a
// viewer with the right sees exactly what members see until they ask, and every ask is a row here:
//   * one reveal (a line, a board row): one row, ended at once (scope "<surface>_line": the login it showed, the reason);
//   * the toggle ("Show real names on this pad", on until turned off - owner J-18: no time limit): one row when it goes on
//     (scope "<surface>_toggle"), updated with a running count and the logins it showed while on, `ended` when it goes off
//     (by the viewer, or because they lost the right).
// Plain viewing writes nothing (it reveals nothing). Rows are kept 180 days (like livecam_audit) and are never shown to the
// person revealed (spec E.5); admins read them at /admin/bridge#seethrough. The capability is chatlog.see_through
// (siteperms-core.js: Admin, locked "privacy" - Staff never hold it, owner decision J-2).
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");

const KEEP_MS = 180 * 864e5;
const SCOPE_RE = /^[a-z_]{2,32}$/;
const LOGINS_MAX = 200;
let clock = () => Date.now();
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS seethrough_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, user_id TEXT NOT NULL,
                      role TEXT NOT NULL, scope TEXT NOT NULL, room_id TEXT, logins TEXT, n INTEGER NOT NULL DEFAULT 0, reason TEXT, ref TEXT, ended INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS seethrough_log_at ON seethrough_log (at)");
      await runQuery("CREATE INDEX IF NOT EXISTS seethrough_log_room ON seethrough_log (room_id, at)");
      await runQuery(`CREATE TABLE IF NOT EXISTS seethrough_toggle (user_id TEXT NOT NULL, scope TEXT NOT NULL, room_id TEXT NOT NULL, on_at INTEGER NOT NULL,
                      log_id INTEGER, PRIMARY KEY (user_id, scope, room_id))`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const loginList = (a) => [...new Set((Array.isArray(a) ? a : [a]).map((x) => clean(x, 40).toLowerCase()).filter(Boolean))].slice(0, LOGINS_MAX);
function scopeOf(s) { const v = String(s || ""); if (!SCOPE_RE.test(v)) throw new Error("bad see-through scope"); return v; }

/** One reveal: a row, ended at once. -> its id */
async function log({ userId, role, scope, roomId = null, logins = [], reason = "", ref = null }) {
  await init();
  if (!userId) throw new Error("no viewer");
  const ls = loginList(logins);
  const t = clock();
  const r = await runQuery(`INSERT INTO seethrough_log (at, user_id, role, scope, room_id, logins, n, reason, ref, ended) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                           [t, String(userId), clean(role, 20) || "?", scopeOf(scope), roomId == null ? null : clean(roomId, 64), JSON.stringify(ls), ls.length,
                            clean(reason, 200) || null, ref == null ? null : clean(ref, 80), t]);
  return Number(r && r.id) || null;
}
/** The viewer's toggle for (scope, room): {on_at, log_id} or null. */
async function toggleOf(userId, scope, roomId) {
  if (!userId) return null;
  await init();
  return (await getQuery("SELECT on_at, log_id FROM seethrough_toggle WHERE user_id = ? AND scope = ? AND room_id = ?",
                         [String(userId), scopeOf(scope), String(roomId)]))[0] || null;
}
/** Turn the toggle on (a row in the log). Already on: nothing new. -> {on: true, logId, fresh}
 *  Review fix: ONE dbUtils.tx claims the toggle row first and only the claimant writes the log row - two "on" POSTs at the same
 *  moment no longer leave a second log row that nothing ever closes ("still on" in /admin/bridge until the prune). */
async function toggleOn({ userId, role, scope, roomId, reason = "" }) {
  const have = await toggleOf(userId, scope, roomId);
  if (have) return { on: true, logId: have.log_id, fresh: false };
  const sc = scopeOf(scope);
  const won = await tx(async () => {
    const t = clock();
    const claim = await runQuery(`INSERT INTO seethrough_toggle (user_id, scope, room_id, on_at, log_id) VALUES (?, ?, ?, ?, NULL)
                                  ON CONFLICT(user_id, scope, room_id) DO NOTHING`, [String(userId), sc, String(roomId), t]);
    if (!(claim && claim.changes)) return null;                // the other request turned it on a moment ago
    const r = await runQuery(`INSERT INTO seethrough_log (at, user_id, role, scope, room_id, logins, n, reason, ref, ended) VALUES (?, ?, ?, ?, ?, '[]', 0, ?, 'on', NULL)`,
                             [t, String(userId), clean(role, 20) || "?", sc, clean(roomId, 64), clean(reason, 200) || null]);
    const logId = Number(r && r.id) || null;
    if (!logId) throw new Error("see-through: no log row");    // never a toggle without its row (nothing is shown unlogged)
    await runQuery("UPDATE seethrough_toggle SET log_id = ? WHERE user_id = ? AND scope = ? AND room_id = ?", [logId, String(userId), sc, String(roomId)]);
    return logId;
  });
  if (won) return { on: true, logId: won, fresh: true };
  const now = await toggleOf(userId, scope, roomId);
  return { on: !!now, logId: now ? now.log_id : null, fresh: false };
}
/** Turn it off (why: "viewer" | "lost_right" | ...): the toggle's log row is closed. -> was it on? */
async function toggleOff({ userId, scope, roomId, why = "viewer" }) {
  const have = await toggleOf(userId, scope, roomId);
  if (!have) return false;
  await runQuery("DELETE FROM seethrough_toggle WHERE user_id = ? AND scope = ? AND room_id = ?", [String(userId), scope, String(roomId)]);
  if (have.log_id) await runQuery("UPDATE seethrough_log SET ended = ?, ref = ? WHERE id = ? AND ended IS NULL", [clock(), "off:" + clean(why, 20), have.log_id]);
  return true;
}
/** A page drawn while the toggle is on: the running count (+1) and the logins it showed, on the toggle's row. */
async function toggleUsed(logId, logins) {
  if (!logId) throw new Error("see-through: the toggle has no log row");        // the caller then shows nothing (never unlogged)
  await init();
  const r = (await getQuery("SELECT logins, n FROM seethrough_log WHERE id = ?", [logId]))[0];
  if (!r) throw new Error("see-through: the toggle's log row is gone");
  let have = [];
  try { have = JSON.parse(r.logins) || []; } catch (e) { have = []; }
  const all = loginList([...have, ...loginList(logins)]);
  await runQuery("UPDATE seethrough_log SET logins = ?, n = n + 1 WHERE id = ?", [JSON.stringify(all), logId]);
}
/** /admin/bridge#seethrough: the newest rows (with the viewer's username). */
async function list({ limit = 100, roomId = null } = {}) {
  await init();
  const n = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const args = roomId ? [String(roomId), n] : [n];
  const rows = await getQuery(`SELECT s.id, s.at, s.user_id, u.username, s.role, s.scope, s.room_id, s.logins, s.n, s.reason, s.ref, s.ended
                               FROM seethrough_log s LEFT JOIN users u ON u.userId = s.user_id ${roomId ? "WHERE s.room_id = ?" : ""}
                               ORDER BY s.id DESC LIMIT ?`, args).catch(async (e) => {
    if (!/no such table: users/i.test(String(e && e.message))) throw e;
    return getQuery(`SELECT id, at, user_id, NULL AS username, role, scope, room_id, logins, n, reason, ref, ended FROM seethrough_log
                     ${roomId ? "WHERE room_id = ?" : ""} ORDER BY id DESC LIMIT ?`, args);
  });
  return rows.map((r) => {
    let logins = [];
    try { logins = JSON.parse(r.logins) || []; } catch (e) { logins = []; }
    return { id: r.id, at: Number(r.at), user_id: r.user_id, username: r.username || null, role: r.role, scope: r.scope, room_id: r.room_id,
             logins, n: Number(r.n) || 0, reason: r.reason || "", ref: r.ref || null, ended: r.ended == null ? null : Number(r.ended) };
  });
}
// ── wave 2 WP-2 (spec E.1 / E.2 / E.5 / E.6, owner J-2 / J-18): see-through for the pad CHAT ──
/** The owner era of userId on pad roomId (ms): max(chatlog_rooms.owner_since, the pad's last 'owner' event) while they own it - 0 when
 *  they don't, or nothing dates the ownership (owner_since 0 with no 'owner' event: fails closed). chatlog_rooms.owner_grant is NEVER
 *  read (CL6's "may read the earlier era" - any Staff member can set it, and Staff have no see-through, J-2). Shared by room analytics
 *  (roomstats adds its 90-day rule, D-15) and the chat reveals (a line said at or after the era only). */
async function ownerEra(roomId, userId) {
  if (!roomId || !userId) return 0;
  let row = null;
  try { row = (await getQuery("SELECT owner_id, owner_since FROM chatlog_rooms WHERE room_id = ?", [String(roomId)]))[0]; } catch (e) { return 0; }
  if (!row || String(row.owner_id || "") !== String(userId)) return 0;
  let evTs = 0;
  try {
    const ev = (await getQuery("SELECT MAX(ts) AS ts FROM room_events WHERE room_id = ? AND what = 'owner'", [String(roomId)]))[0];
    evTs = ev && ev.ts != null ? Number(ev.ts) || 0 : 0;
  } catch (e) { evTs = 0; }
  const since = Math.max(Number(row.owner_since) || 0, evTs);
  return since > 0 ? since : 0;
}
/** Who may reveal frog names in pad roomId's CHAT: {role: "admin", since: 0} (chatlog.see_through, every pad and era) | {role: "owner",
 *  since} (the pad's registered owner, lines said since their era began) | null. Never Staff; a check that can't run says null. */
const ROLE_CACHE = new Map();            // "userId|room" -> {v, at}: the live long-poll asks on every answer (30 s; a loss of the
const ROLE_MS = 30e3;                    // right shows within 30 s - a reveal itself always re-checks: revealChat's caller asks fresh)
async function chatRoleCached(user, roomId) {
  if (!user || !user.userId || !roomId) return null;
  const k = String(user.userId) + "|" + String(roomId), c = ROLE_CACHE.get(k), t = clock();
  if (c && t - c.at < ROLE_MS) return c.v;
  const v = await chatRole(user, roomId);
  ROLE_CACHE.set(k, { v, at: t });
  if (ROLE_CACHE.size > 5000) ROLE_CACHE.delete(ROLE_CACHE.keys().next().value);
  return v;
}
async function chatRole(user, roomId) {
  if (!user || !user.userId || !roomId) return null;
  try { if (await require("./siteperms").canId(user.userId, "chatlog.see_through")) return { role: "admin", since: 0 }; } catch (e) { return null; }
  try {
    const R = require("./rooms");
    const pad = (R.getCached && R.getCached(roomId)) || (R.get ? await R.get(roomId) : null);
    if (!pad || !pad.owner || String(pad.owner.userId) !== String(user.userId)) return null;
    const since = await ownerEra(roomId, user.userId);
    return since > 0 ? { role: "owner", since } : null;
  } catch (e) { return null; }
}
/** May this role reveal a line said at ts? */
const mayReveal = (role, ts) => !!role && (role.role === "admin" || (role.since > 0 && Number(ts) >= role.since));

// E.6: a pad owner's reveals are counted per day; past 3 toggle-ons or 100 line reveals an admin is told (once per owner per day)
const DAY = new Map();                    // "userId|day" -> {lines, toggles, told}
const LIMIT_LINES = 100, LIMIT_TOGGLES = 3;
async function noteOwnerUse(user, roomId, what, n = 1) {
  const day = new Date(clock()).toISOString().slice(0, 10);
  const k = String(user.userId) + "|" + day;
  const c = DAY.get(k) || { lines: 0, toggles: 0, told: false };
  c[what] += n;
  DAY.set(k, c);
  if (DAY.size > 5000) DAY.delete(DAY.keys().next().value);
  if (c.told || (c.lines <= LIMIT_LINES && c.toggles <= LIMIT_TOGGLES)) return false;
  c.told = true;
  try {
    const SP = require("./siteperms");
    const rows = await getQuery("SELECT userId, class FROM users").catch(() => []);
    const admins = rows.filter((u) => { try { return SP.can(u, "chatlog.see_through"); } catch (e) { return false; } }).map((u) => String(u.userId));
    const note = { kind: "admin", link: "/admin/bridge#seethrough", ref: `seethrough-limit-${day}:${user.userId}`,
                   title: "A pad owner is revealing a lot of frog names",
                   body: `${user.username || "A pad owner"} revealed ${c.lines} chat line(s) and turned "show real names" on ${c.toggles} time(s) today in their pad. Every reveal is in the see-through log.` };
    for (const id of admins) await require("./inbox").addSafe(id, note).catch(() => false);
  } catch (e) { console.error("[seethrough] limit notice:", e.message); }
  return true;
}

/** Admins' answers carry the PATV account of each revealed login (o.account = the /admin/users search), when one is linked. */
async function accountLinks(items) {
  try {
    const logins = [...new Set(items.map((o) => o.login.toLowerCase()))];
    if (!logins.length) return;
    const rows = await getQuery(`SELECT username, lower(camfrogUsername) AS cf FROM users WHERE lower(camfrogUsername) IN (${logins.map(() => "?").join(",")})`, logins);
    const by = new Map(rows.map((x) => [x.cf, x.username]));
    for (const o of items) { const u = by.get(o.login.toLowerCase()); if (u) o.account = "/admin/users?q=" + encodeURIComponent(u); }
  } catch (e) { /* no account links */ }
}

/**
 * Reveal veiled chat lines (E.1): for each cursor c the viewer may reveal (role, pad, owner era, a veil row present), the real login
 * and display name, a hidden speaker's words and (admins) the account. One seethrough_log row (scope chat_line). -> {items, refused}
 * lookup(c) -> {ts, vz, vw} | null (the live item, else the archive's chat_log_veil row - bridge.revealRows).
 */
async function revealChat({ user, role, roomId, cs, reason = "", lookup }) {
  const items = [], refused = [];
  for (const c of [...new Set((cs || []).map(Number).filter((x) => x > 0))].slice(0, 50)) {
    let r = null;
    try { r = await lookup(c); } catch (e) { r = null; }
    if (!r || !r.vz || !r.vz.login) { refused.push({ c, why: "no_veil" }); continue; }
    if (!mayReveal(role, r.ts)) { refused.push({ c, why: "era" }); continue; }
    const o = { c, login: String(r.vz.login), display: r.vz.display ? String(r.vz.display) : null };
    if (r.vz.kind === "hidden" && typeof r.vw === "string") o.words = r.vw;
    items.push(o);
  }
  if (items.length) {
    if (role.role === "admin") await accountLinks(items);
    await log({ userId: user.userId, role: role.role, scope: "chat_line", roomId, logins: items.map((o) => o.login), reason,
                ref: "c:" + items.map((o) => o.c).slice(0, 8).join(",") });
    if (role.role === "owner") await noteOwnerUse(user, roomId, "lines", items.length);
  }
  return { items, refused };
}

/** Rows older than 180 days go (an open toggle's row stays while it is on). -> deleted */
async function prune(t = clock()) {
  await init();
  const r = await runQuery(`DELETE FROM seethrough_log WHERE at < ? AND (ended IS NOT NULL OR id NOT IN (SELECT log_id FROM seethrough_toggle WHERE log_id IS NOT NULL))`,
                           [t - KEEP_MS]);
  return (r && r.changes) || 0;
}

function register(app, { addUser, noTimers = false }) {
  const SP = require("./siteperms");
  init().catch((e) => console.error("[seethrough] init:", e.message));
  if (!noTimers) {
    const iv = setInterval(() => prune().catch((e) => console.error("[seethrough] prune:", e.message)), 6 * 3600e3);
    if (iv.unref) iv.unref();
  }
  // ── wave 2 WP-2: chat reveals (E.1, J-18) - fetch-only, same-origin, no-store, no-referrer, rate-limited; never through the homepage
  // panel, embeds, the hub or downloads (those never call these). Per line (scope chat_line), or in batches while the viewer's toggle
  // for this pad is on (scope chat_toggle: its one row counts the batches and the logins shown) ──
  const guard = require("./middleware/authGuard");
  const json = require("express").json({ limit: "8kb" });
  const RL = new Map();
  const limited = (uid, n) => {
    const t = clock(), w = RL.get(uid) || { t, n: 0 };
    if (t - w.t > 60e3) { w.t = t; w.n = 0; }
    w.n += n;
    RL.set(uid, w);
    if (RL.size > 5000) RL.delete(RL.keys().next().value);
    return w.n > 300;
  };
  // wave 2 WP-5 (spec E.3): a revealed live veiled 🎙 line that can be saved as moderation evidence right now gets ev: 1 - a flag
  // only (evidence.offerable: the evidence switch and privacy wire v2 on, Pepe's 15 minutes); the save itself re-checks everything
  const evFlags = (R, items) => {
    try { const EV = require("./evidence"); for (const o of items || []) if (EV.offerable(R, o.c)) o.ev = 1; } catch (e) { /* no offer */ }
  };
  async function chatCtx(req, res) {
    res.set("Cache-Control", "private, no-store");
    res.set("Referrer-Policy", "no-referrer");
    if (!guard.sameOriginFetch(req)) { res.status(403).json({ ok: false, error: "Security check failed - reload the page." }); return null; }
    if (!req.user || !req.user.userId) { res.status(401).json({ ok: false, error: "Sign in first." }); return null; }
    const B = require("./bridge");
    const slug = clean(req.body && req.body.room, 80).toLowerCase();
    const R = slug ? [...B._rooms.values()].find((x) => x.slug === slug || x.id === slug) : null;
    if (!R) { res.status(404).json({ ok: false, error: "No such pad." }); return null; }
    const role = await chatRole(req.user, R.id);
    if (!role) { res.status(403).json({ ok: false, error: "Only PATV admins, and a pad's owner in their own pad, can reveal who is behind a frog name." }); return null; }
    return { R, role };
  }
  // ── wave 2 WP-4 x WP-2 (spec F.4 / E.1 / A.6, owner J-18): Reveal on a mic-stage COVER tile - {room, tile, reason?, toggle?}. The
  // same refusals as a line reveal (fetch-only, same-origin, signed in, the pad, the role, the rate limit, no-store / no-referrer),
  // plus the privacy wire v2 on (else 409: no covers, nothing to reveal) and the tile a cover shown NOW (micfollow.coverWho, else
  // 404). The role is the LIVE stage's (veilstage.stageRole): an Admin (chatlog.see_through) or the pad's owner NOW - not the chat's
  // owner-era rule (that dates past lines; a cover is someone speaking now). Logged like a line, BEFORE the answer: one row scope
  // stage_line (ref tile:<id>) - or, toggle: true, while the viewer's J-18 toggle for this pad is on, counted on that toggle's row
  // (one "Show real names" toggle per pad covers its chat lines AND its stage tiles, scope chat_toggle); 409 while it is off.
  async function tileReveal(req, res) {
    res.set("Cache-Control", "private, no-store");
    res.set("Referrer-Policy", "no-referrer");
    if (!guard.sameOriginFetch(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    const B = require("./bridge");
    const slug = clean(req.body.room, 80).toLowerCase();
    const R = slug ? [...B._rooms.values()].find((x) => x.slug === slug || x.id === slug) : null;
    if (!R) return res.status(404).json({ ok: false, error: "No such pad." });
    let on = false;
    try { on = require("./privwire").isOn() === true; } catch (e) { on = false; }
    if (!on) return res.status(409).json({ ok: false, code: "privwire_off", error: "Nothing on this mic stage can be revealed right now." });
    const role = await require("./veilstage").stageRole(req.user, R.id);
    if (!role) return res.status(403).json({ ok: false, error: "Only PATV admins, and a pad's owner in their own pad, can reveal who is behind a frog name." });
    if (limited(String(req.user.userId), 1)) return res.status(429).json({ ok: false, error: "Too many reveals - wait a minute." });
    const tile = clean(req.body.tile, 40);
    let who = null;
    try { who = require("./micfollow").coverWho(R.id, tile); } catch (e) { who = null; }
    if (!who) return res.status(404).json({ ok: false, code: "gone", error: "That veiled speaker isn't on the mic stage any more." });
    if (req.body.toggle === true) {
      const tg = await toggleOf(req.user.userId, "chat_toggle", R.id);
      if (!tg) {
        // integration review (T-3): ONE toggle, ONE rule - it's turned on by the chat's rule (chatRole: an Admin, or the owner in a
        // dated era). A stage role that rule refuses (an owner nothing dates) could never turn it on: toggle_na, so the page never
        // offers that viewer the bar (pad-reveal.js / stage-mic.js) - their per-tile Reveal still works
        const can = !!(await chatRole(req.user, R.id));
        return res.status(409).json(can ? { ok: false, code: "toggle_off", error: "Show real names is off - turn it on first." }
          : { ok: false, code: "toggle_na", error: "Show real names isn't available to you on this pad - use Reveal on the tile." });
      }
      await toggleUsed(tg.log_id, [who.login]);
    } else {
      await log({ userId: req.user.userId, role, scope: "stage_line", roomId: R.id, logins: [who.login], reason: req.body.reason, ref: "tile:" + tile });
      if (role === "owner") await noteOwnerUse(req.user, R.id, "lines", 1);
    }
    const out = { tile, login: who.login, display: who.display };
    if (role === "admin") await accountLinks([out]);
    return res.json({ ok: true, ...out });
  }
  app.post("/api/chatlog/reveal", addUser, json, async (req, res) => {
    try {
      if (req.body && req.body.tile != null) return await tileReveal(req, res);
      const ctx = await chatCtx(req, res);
      if (!ctx) return;
      const cs = Array.isArray(req.body.c) ? req.body.c : [req.body.c];
      if (limited(String(req.user.userId), cs.length)) return res.status(429).json({ ok: false, error: "Too many reveals - wait a minute." });
      const lookup = (c) => require("./bridge").revealLookup(ctx.R.id, c);
      if (req.body.toggle === true) {
        // the toggle's batch fetch: no new row - the toggle's own row counts it (refused unless the toggle is on)
        const tg = await toggleOf(req.user.userId, "chat_toggle", ctx.R.id);
        if (!tg) return res.status(409).json({ ok: false, error: "Show real names is off - turn it on first." });
        const items = [], refused = [];
        for (const c of [...new Set(cs.map(Number).filter((x) => x > 0))].slice(0, 50)) {
          const r = await lookup(c).catch(() => null);
          if (!r || !r.vz || !r.vz.login) { refused.push({ c, why: "no_veil" }); continue; }
          if (!mayReveal(ctx.role, r.ts)) { refused.push({ c, why: "era" }); continue; }
          items.push({ c, login: String(r.vz.login), display: r.vz.display || null, ...(r.vz.kind === "hidden" && typeof r.vw === "string" ? { words: r.vw } : {}) });
        }
        if (items.length) await toggleUsed(tg.log_id, items.map((o) => o.login));
        evFlags(ctx.R, items);
        return res.json({ ok: true, items, refused });
      }
      const out = await revealChat({ user: req.user, role: ctx.role, roomId: ctx.R.id, cs, reason: req.body.reason, lookup });
      evFlags(ctx.R, out.items);
      res.json({ ok: true, ...out });
    } catch (e) {
      console.error("[seethrough] reveal:", e && e.code ? e.code : "error");
      res.status(500).json({ ok: false, error: "Couldn't reveal it - try again." });
    }
  });
  // the toggle (J-18): {room, on, reason?} - on until turned off (or the right is lost); each on / off is logged
  app.post("/api/chatlog/seethrough", addUser, json, async (req, res) => {
    try {
      const on = req.body && req.body.on === true;
      if (!on) {
        res.set("Cache-Control", "private, no-store");
        if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
        const B = require("./bridge");
        const slug = clean(req.body && req.body.room, 80).toLowerCase();
        const R = [...B._rooms.values()].find((x) => x.slug === slug || x.id === slug);
        if (R) await toggleOff({ userId: req.user.userId, scope: "chat_toggle", roomId: R.id, why: "viewer" });
        return res.json({ ok: true, on: false });
      }
      const ctx = await chatCtx(req, res);
      if (!ctx) return;
      const r = await toggleOn({ userId: req.user.userId, role: ctx.role.role, scope: "chat_toggle", roomId: ctx.R.id, reason: req.body.reason });
      if (r.fresh && ctx.role.role === "owner") await noteOwnerUse(req.user, ctx.R.id, "toggles", 1);
      res.json({ ok: true, on: true });
    } catch (e) {
      console.error("[seethrough] chat toggle:", e && e.code ? e.code : "error");
      res.status(500).json({ ok: false, error: "Couldn't change it - try again." });
    }
  });
  app.get("/api/admin/seethrough", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!req.user || !(await SP.canId(req.user.userId, "chatlog.see_through"))) return res.status(403).json({ ok: false, error: "Admins only." });
      const room = clean(req.query.room, 64) || null;
      res.json({ ok: true, rows: await list({ limit: req.query.limit, roomId: room }) });
    } catch (e) {
      console.error("[seethrough] list:", e.message);
      res.status(500).json({ ok: false, error: "Couldn't load the see-through log." });
    }
  });
}

module.exports = { init, log, toggleOf, toggleOn, toggleOff, toggleUsed, list, prune, register, KEEP_MS,
                   ownerEra, chatRole, chatRoleCached, mayReveal, revealChat, noteOwnerUse,
                   _setClock: (f) => { clock = f || (() => Date.now()); }, _day: DAY };
