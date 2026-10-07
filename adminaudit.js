// adminaudit.js — a general admin audit log (1.99cy). One row per admin action that changes an account
// outside the normal game / site rules, so "who did that, when, and from what to what" has an answer.
//   admin_audit  id, at (ms), admin_id, admin_name, action ("xp", ...), target_id, target_name, detail (JSON), reason
// First user: the Users & Accounts XP card (adminxp.js). Rows are never shown outside the admin area.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS admin_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, admin_id TEXT NOT NULL, admin_name TEXT,
        action TEXT NOT NULL, target_id TEXT, target_name TEXT, detail TEXT, reason TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS admin_audit_action ON admin_audit (action, at)");
      await runQuery("CREATE INDEX IF NOT EXISTS admin_audit_target ON admin_audit (target_id, at)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** Record one admin action. admin / target: {userId, username}. Throws on a DB error (callers decide). */
async function record(admin, action, target, detail = null, reason = null) {
  await init();
  await runQuery("INSERT INTO admin_audit (at, admin_id, admin_name, action, target_id, target_name, detail, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [Date.now(), admin.userId, admin.username || null, String(action), target ? target.userId : null, target ? target.username || null : null,
     detail == null ? null : JSON.stringify(detail), reason ? String(reason).slice(0, 200) : null]);
}

/** The newest rows for one action. */
async function recent(action, limit = 20) {
  await init();
  const rows = await getQuery("SELECT * FROM admin_audit WHERE action = ? ORDER BY id DESC LIMIT ?", [String(action), Math.min(200, Math.max(1, limit | 0))]);
  return rows.map((r) => {
    let detail = null;
    try { detail = r.detail ? JSON.parse(r.detail) : null; } catch (e) { detail = null; }
    return { id: r.id, at: r.at, admin: r.admin_name, target: r.target_name, targetId: r.target_id, detail, reason: r.reason };
  });
}

module.exports = { init, record, recent };
