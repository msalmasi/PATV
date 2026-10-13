// accountsadmin.js — /admin/accounts: Account security for site admins (1.99wl). Sits on the 1.99wj APIs (sessions.js,
// accountdelete.js) and adds what the page needs to read:
//
//   GET  /admin/accounts[?u=<username>]               the page (views/admin/accounts.ejs, public/js/admin-accounts.js): look up a
//                                                     member, their sessions + deletion status, every pending / held deletion,
//                                                     recent account-security events
//   GET  /api/admin/accounts/people?q=                the people search (storealerts.searchPeople: username, display name or
//                                                     Camfrog login, any length)
//   GET  /api/admin/accounts/user?u=<username|id>     {user, sessions, deletion: {state, execute_at, held_reason, blockers}, events}
//   GET  /api/admin/accounts/deletions                pending + held deletions with their dates and live blockers
//   GET  /api/admin/accounts/events                   recent events (chat sign-ins, new-device notices, revocations, admin actions)
//
// The actions are the 1.99wj admin routes - "Sign out everywhere" (POST /api/admin/users/:id/sessions/revoke), "Schedule
// deletion" (POST /api/admin/users/:id/delete) and "Cancel deletion" (POST /api/admin/account-deletions/:id/cancel). Each one
// needs a reason and the member's username typed as the confirmation, and is written to admin_audit.
// Admins only (class Admin in the database): IPs and sign-in history are not for Staff.
"use strict";
const { getQuery } = require("./dbUtils");

const DAY = 86400000;
const tableExists = async (t) => (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t])).length > 0;
const safe = async (fn, d) => { try { return await fn(); } catch (e) { return d; } };

async function adminOf(req) {
  if (!req.user || !req.user.userId) return null;
  const r = (await safe(() => getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]), []))[0];
  return r && r.class === "Admin" ? r : null;
}

/** A member by username (any case), Camfrog login or id. */
async function findUser(q) {
  const s = String(q == null ? "" : q).trim().replace(/^@/, "").slice(0, 120);
  if (!s) return null;
  return (await getQuery(`SELECT userId, username, displayname, class, camfrogUsername, points_balance FROM users
                          WHERE userId = ? OR LOWER(username) = LOWER(?) OR LOWER(COALESCE(camfrogUsername, '')) = LOWER(?)
                          ORDER BY (userId = ?) DESC, (LOWER(username) = LOWER(?)) DESC LIMIT 1`, [s, s, s, s, s]))[0] || null;
}

/** Their deletion status: none | scheduled | held | cancelled | done (+ the live blockers while pending). */
async function deletionOf(userId) {
  const D = require("./accountdelete");
  await D.init();
  const r = (await getQuery("SELECT * FROM account_deletions WHERE user_id = ? ORDER BY id DESC LIMIT 1", [String(userId)]))[0];
  if (!r) return { state: "none" };
  const out = { id: r.id, state: r.state, requested_at: r.requested_at, execute_at: r.execute_at, requested_by: r.requested_by, reauth: r.reauth,
                reason: r.reason, held_reason: r.held_reason, cancelled_at: r.cancelled_at, cancel_via: r.cancel_via, done_at: r.done_at };
  if (r.state === "scheduled" || r.state === "held") out.blockers = (await safe(() => D.blockers(userId), { block: [] })).block;
  return out;
}

/** Recent account-security events, newest first: [{at, kind, user_id, username, detail}] (one account, or everyone). */
async function events({ userId = null, limit = 100 } = {}) {
  const lim = Math.max(1, Math.min(300, Number(limit) || 100));
  const W = (col) => (userId ? ` AND ${col} = ?` : "");
  const P = userId ? [String(userId)] : [];
  const out = [];
  if (await tableExists("chat_signin_log")) {
    for (const r of await getQuery(`SELECT l.at, l.kind, l.user_id, l.ip, l.agent, l.why, u.username FROM chat_signin_log l LEFT JOIN users u ON u.userId = l.user_id
                                    WHERE l.kind IN ('used','refused')${W("l.user_id")} ORDER BY l.at DESC LIMIT ?`, [...P, lim])) {
      out.push({ at: r.at, kind: r.kind === "used" ? "chat_signin" : "chat_signin_refused", user_id: r.user_id, username: r.username,
                 detail: [r.why, r.ip, r.agent].filter(Boolean).join(" · ") });
    }
  }
  if (await tableExists("sessions")) {
    for (const r of await getQuery(`SELECT s.notified AS at, s.user_id, s.device, s.country, s.ip, s.method, u.username FROM sessions s LEFT JOIN users u ON u.userId = s.user_id
                                    WHERE s.notified IS NOT NULL${W("s.user_id")} ORDER BY s.notified DESC LIMIT ?`, [...P, lim])) {
      out.push({ at: r.at, kind: "new_device", user_id: r.user_id, username: r.username, detail: [r.method, r.device, r.country, r.ip].filter(Boolean).join(" · ") });
    }
    for (const r of await getQuery(`SELECT s.revoked_at AS at, s.revoked_why, s.user_id, s.device, u.username FROM sessions s LEFT JOIN users u ON u.userId = s.user_id
                                    WHERE s.revoked_at IS NOT NULL${W("s.user_id")} ORDER BY s.revoked_at DESC LIMIT ?`, [...P, lim])) {
      out.push({ at: r.at, kind: "revoked", user_id: r.user_id, username: r.username, detail: [r.revoked_why, r.device].filter(Boolean).join(" · ") });
    }
  }
  if (await tableExists("admin_audit")) {
    for (const r of await getQuery(`SELECT at, action, admin_name, target_id, target_name, reason FROM admin_audit
                                    WHERE action IN ('sessions.revoke_all','account.delete','account.delete_cancel')${W("target_id")} ORDER BY at DESC LIMIT ?`, [...P, lim])) {
      out.push({ at: r.at, kind: r.action, user_id: r.target_id, username: r.target_name, detail: [r.admin_name ? "by " + r.admin_name : null, r.reason].filter(Boolean).join(" · ") });
    }
  }
  return out.sort((a, b) => Number(b.at) - Number(a.at)).slice(0, lim);
}

/** Every pending / held deletion with its date and live blockers. */
async function pending() {
  const D = require("./accountdelete");
  await D.init();
  const rows = await getQuery(`SELECT d.id, d.user_id, u.username, u.class, d.state, d.requested_at, d.execute_at, d.requested_by, d.held_reason
                               FROM account_deletions d LEFT JOIN users u ON u.userId = d.user_id
                               WHERE d.state IN ('scheduled','held') ORDER BY d.execute_at LIMIT 200`);
  for (const r of rows) r.blockers = (await safe(() => D.blockers(r.user_id), { block: [] })).block;
  return rows;
}

function register(app, { addUser }) {
  const deny = (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) { res.status(401).json({ ok: false, error: "Sign in first." }); return true; }
    res.status(403).json({ ok: false, error: "Admins only." });
    return true;
  };
  app.get("/admin/accounts", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent("/admin/accounts"));
    try {
      const me = await adminOf(req);
      res.set("Cache-Control", "no-store");
      res.set("X-Robots-Tag", "noindex");
      if (!me) return res.status(403).render("notFound", { user: req.user.username, heading: "Admins only", message: "Account security is for site admins.", title: "Admins only" });
      res.render("admin/accounts", { title: "Admin · Account security", user: me.username, isAdmin: true, me,
                                     q: String(req.query.u || "").slice(0, 120), pending: await pending(), events: await events({ limit: 60 }) });
    } catch (e) { console.error("[accountsadmin] page:", e); res.status(500).send("Couldn't load the admin page."); }
  });
  app.get("/api/admin/accounts/people", addUser, async (req, res) => {
    if (!(await adminOf(req))) return deny(req, res);
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, people: await require("./storealerts").searchPeople(req.query.q) }); }
    catch (e) { res.status(500).json({ ok: false }); }
  });
  app.get("/api/admin/accounts/user", addUser, async (req, res) => {
    if (!(await adminOf(req))) return deny(req, res);
    res.set("Cache-Control", "no-store");
    try {
      const u = await findUser(req.query.u);
      if (!u) return res.status(404).json({ ok: false, error: "No such member." });
      const S = require("./sessions");
      res.json({ ok: true, user: { userId: u.userId, username: u.username, display: u.displayname, class: u.class, camfrog: u.camfrogUsername,
                                   elevated: await safe(() => require("./chatsignin").elevated(u), false) },
                 sessions: (await S.list(u.userId)).map((s) => ({ id: s.id.slice(0, 12), device: s.device, method: s.method, ip: s.ip, country: s.country,
                                                                  created: s.created, last_seen: s.last_seen, legacy_before: s.legacy_before })),
                 deletion: await deletionOf(u.userId), events: await events({ userId: u.userId, limit: 40 }) });
    } catch (e) { console.error("[accountsadmin] user:", e.message); res.status(500).json({ ok: false }); }
  });
  app.get("/api/admin/accounts/deletions", addUser, async (req, res) => {
    if (!(await adminOf(req))) return deny(req, res);
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, rows: await pending() }); } catch (e) { res.status(500).json({ ok: false }); }
  });
  app.get("/api/admin/accounts/events", addUser, async (req, res) => {
    if (!(await adminOf(req))) return deny(req, res);
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, events: await events({ limit: req.query.limit }) }); } catch (e) { res.status(500).json({ ok: false }); }
  });
}

module.exports = { register, findUser, deletionOf, events, pending, DAY };
