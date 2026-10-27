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
const { runQuery, getQuery } = require("./dbUtils");

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
/** Turn the toggle on (a row in the log). Already on: nothing new. -> {on: true, logId, fresh} */
async function toggleOn({ userId, role, scope, roomId, reason = "" }) {
  const have = await toggleOf(userId, scope, roomId);
  if (have) return { on: true, logId: have.log_id, fresh: false };
  const t = clock();
  const r = await runQuery(`INSERT INTO seethrough_log (at, user_id, role, scope, room_id, logins, n, reason, ref, ended) VALUES (?, ?, ?, ?, ?, '[]', 0, ?, 'on', NULL)`,
                           [t, String(userId), clean(role, 20) || "?", scopeOf(scope), clean(roomId, 64), clean(reason, 200) || null]);
  const logId = Number(r && r.id) || null;
  await runQuery(`INSERT INTO seethrough_toggle (user_id, scope, room_id, on_at, log_id) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(user_id, scope, room_id) DO NOTHING`, [String(userId), scope, String(roomId), t, logId]);
  return { on: true, logId, fresh: true };
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
  if (!logId) return;
  await init();
  const r = (await getQuery("SELECT logins, n FROM seethrough_log WHERE id = ?", [logId]))[0];
  if (!r) return;
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
                   _setClock: (f) => { clock = f || (() => Date.now()); } };
