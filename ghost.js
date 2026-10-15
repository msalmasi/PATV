// ghost.js — 1.99aaf: 👻 ghost mode for site staff (Admin / Staff only), for moderation: while it's on, a staff member's
// views of Camfrog cams through the website (▶ Live, snapshots, clips) don't tell anyone - no "X opened your cam" PM /
// digest to the owner (camviewers.noteView), they're left out of !whowatching and the privacy card's "who's watching",
// out of the live viewer counts the page and Pepe see, and Pepe leaves them out of his room mod log (the job says ghost).
//
// NEVER silent: every ghost view is still written - cam_views (ghost = 1, kept GHOST_KEEP_MS, not the 7-day window) and
// livecam_audit (ghost = 1) - and every switch on / off is in admin_audit ("ghost_mode") and this module's ghost_log.
// Admins see both on /admin/pepe/livecams (👻 Ghost views). The ghost sees a 👻 badge on the cam popover while it's on.
//
// Who: only accounts whose class is Admin or Staff can switch it on (checked on every switch AND on every view: a
// demoted account is no longer a ghost even if its row still says on). Default off. One home: the 👻 card in
// Settings → Privacy (shown to staff only) - POST /api/privacy/ghost {on}; Pepe's `!ghost on|off` (Pepe admins whose
// linked PATV account is Admin / Staff) writes the same row through POST /api/bridge/ghost (bot token).
//
// Consent: ghost mode does NOT bypass the cam owner's opt-out (!livecam off), "private", or their blocks - those still
// refuse a ghost like anyone else (camviewers.camRefusal). Moderation viewing of a cam that opted out is a policy decision
// left to the user.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const guard = require("./middleware/authGuard");

const STAFF = new Set(["Admin", "Staff"]);
const GHOST_KEEP_MS = 180 * 24 * 3600 * 1000;
let clock = () => Date.now();
const now = () => clock();

let ON = new Map();            // userId -> {username, class}   (accounts with ghost on AND a staff class, as of the last load)
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS staff_ghost (user_id TEXT PRIMARY KEY, username TEXT, on_ INTEGER NOT NULL, updated INTEGER NOT NULL, via TEXT)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS ghost_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, username TEXT, on_ INTEGER NOT NULL,
                      via TEXT, at INTEGER NOT NULL)`);
      await load();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
async function load() {
  const rows = await getQuery(`SELECT g.user_id, u.username, u.class FROM staff_ghost g JOIN users u ON u.userId = g.user_id WHERE g.on_ = 1`);
  ON = new Map(rows.filter((r) => STAFF.has(r.class)).map((r) => [String(r.user_id), { username: r.username || "", class: r.class }]));
}

/** Is this account a ghost right now? (sync; staff class re-checked on every load and switch) */
const isGhost = (userId) => userId != null && ON.has(String(userId));
const isStaff = (u) => !!u && STAFF.has(u.class);

async function userOf(userId) {
  return (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [String(userId)]))[0] || null;
}
/** Switch it. -> {ok, on} | {ok:false, status, error}. Non-staff can never switch it on. */
async function set(userId, on, { via = "web" } = {}) {
  await init();
  const u = await userOf(userId);
  if (!u) return { ok: false, status: 404, error: "No such account." };
  if (on && !isStaff(u)) return { ok: false, status: 403, error: "Ghost mode is for site staff only." };
  const t = now();
  await runQuery(`INSERT INTO staff_ghost (user_id, username, on_, updated, via) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, on_ = excluded.on_, updated = excluded.updated, via = excluded.via`,
                 [String(u.userId), u.username || null, on ? 1 : 0, t, via === "chat" ? "chat" : "web"]);
  await runQuery("INSERT INTO ghost_log (user_id, username, on_, via, at) VALUES (?, ?, ?, ?, ?)", [String(u.userId), u.username || null, on ? 1 : 0,
    via === "chat" ? "chat" : "web", t]);
  try {
    await require("./adminaudit").init();
    await require("./adminaudit").record({ userId: u.userId, username: u.username, class: u.class }, "ghost_mode", String(u.userId),
      { on: !!on, via });
  } catch (e) { console.error("[ghost] audit:", e.message); }
  if (on) ON.set(String(u.userId), { username: u.username || "", class: u.class }); else ON.delete(String(u.userId));
  console.log(`[ghost] ${u.username} ghost ${on ? "ON" : "OFF"} via ${via}`);
  return { ok: true, on: !!on };
}
async function state(userId) {
  await init();
  const u = await userOf(userId);
  return { staff: isStaff(u), on: isGhost(userId) };
}
/** For /admin/pepe/livecams: who's a ghost now, recent switches, recent ghost cam views. */
async function adminView(limit = 50) {
  await init();
  const log = await getQuery("SELECT username, on_, via, at FROM ghost_log ORDER BY id DESC LIMIT 30");
  let views = [];
  try {
    views = await getQuery(`SELECT owner, room_id, username, kind, at FROM cam_views WHERE ghost = 1 ORDER BY id DESC LIMIT ?`, [limit]);
  } catch (e) { views = []; }
  return { on: [...ON.values()].map((x) => x.username), log: log.map((r) => ({ username: r.username, on: !!r.on_, via: r.via, at: Number(r.at) })),
           views: views.map((r) => ({ owner: r.owner, room: r.room_id, username: r.username, kind: r.kind, at: Number(r.at) })) };
}

function register(app, { addUser, isBotToken }) {
  init().catch((e) => console.error("[ghost] init:", e.message));
  const tm = setInterval(() => {
    load().catch(() => {});                                       // a demotion ends ghost mode within minutes
    runQuery("DELETE FROM ghost_log WHERE at < ?", [now() - GHOST_KEEP_MS]).catch(() => {});
  }, 5 * 60 * 1000);
  if (tm.unref) tm.unref();
  const hit = guard.limiter({ max: 30, windowMs: 60 * 60 * 1000 });

  app.get("/api/privacy/ghost", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try { res.json({ ok: true, ...(await state(req.user.userId)) }); } catch (e) { res.status(500).json({ ok: false, error: "Something went wrong." }); }
  });
  app.post("/api/privacy/ghost", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    const on = (req.body || {}).on;
    if (typeof on !== "boolean") return res.status(400).json({ ok: false, error: "on must be true or false" });
    const key = "u:" + req.user.userId;
    if (hit.blocked(key)) return res.status(429).json({ ok: false, error: "That's a lot of switching - try again in a while." });
    hit.hit(key);
    try {
      const r = await set(req.user.userId, on, { via: "web" });
      res.status(r.ok ? 200 : r.status || 400).json(r);
    } catch (e) { console.error("[ghost]", e); res.status(500).json({ ok: false, error: "Something went wrong." }); }
  });
  // Pepe's !ghost on|off: {password, login (the Camfrog login typing it), on?} -> the linked account's state
  app.post("/api/bridge/ghost", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    try {
      const login = String(b.login || "").trim().toLowerCase();
      if (!/^[\w.\-$]{1,40}$/.test(login)) return res.status(400).json({ ok: false, error: "bad login" });
      const rows = await getQuery("SELECT userId FROM users WHERE lower(camfrogUsername) = ? LIMIT 2", [login]);
      if (rows.length !== 1) return res.status(404).json({ ok: false, error: "Link your Camfrog name to your PATV account first." });
      const uid = String(rows[0].userId);
      if (typeof b.on === "boolean") {
        const r = await set(uid, b.on, { via: "chat" });
        return res.status(r.ok ? 200 : r.status || 400).json(r);
      }
      res.json({ ok: true, ...(await state(uid)) });
    } catch (e) { console.error("[ghost] bot:", e); res.status(500).json({ ok: false, error: "Something went wrong." }); }
  });
}

module.exports = {
  init, register, isGhost, isStaff, set, state, adminView, load, GHOST_KEEP_MS,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _reset: () => { ON = new Map(); ready = null; },
};
