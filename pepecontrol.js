// pepecontrol.js - the admin-only "Pepe control panel" at the bottom of the homepage.
//
// Restarting Pepe from outside Camfrog. It must work when Pepe himself is hung or crashed, so it
// does NOT go through Pepe's web-action queue (actions.js): the VM supervisor (camfrog-bot
// vm/pepe-supervisor.ps1 + vm/control.py) polls this site over HTTPS, outbound only:
//
//   admin (homepage) --POST /api/pepe/control/command--> pepe_control_cmds (status "pending")
//   VM poller        --GET  /api/pepe/control/pending--> claims it atomically (at most once)
//   VM poller        --POST /api/pepe/control/ack-----> accepted / waiting / running / done / failed
//   VM poller        --POST /api/pepe/control/heartbeat-> status shown in the panel
//
// Guards on a command: Admin class (page + API), CSRF token (HMAC, bound to the admin) + same-site
// Origin check, step-up re-auth (the account password, every time), a single-use nonce, pickup
// within 2 minutes or it expires, 3 commands per 10 minutes (all admins together), and an audit
// log (admin, salted IP hash, command, time, result) shown in the panel. Kinds and modes are a
// fixed list; the VM runs nothing else.
"use strict";
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const { runQuery, getQuery } = require("./dbUtils");
const guard = require("./middleware/authGuard");

const KINDS = { pepe: "Restart Pepe", full: "Restart Camfrog + Pepe" };
const MODES = { games: "between games", now: "now" };
const PICKUP_MS = 2 * 60 * 1000;         // not picked up by the VM within this -> expired
const RATE_MAX = 3;                       // commands ...
const RATE_WINDOW_MS = 10 * 60 * 1000;    // ... per 10 minutes, all admins together
const NONCE_TTL_MS = 5 * 60 * 1000;
const CSRF_TTL_MS = 12 * 3600 * 1000;
const ONLINE_MS = 60 * 1000;              // heartbeat age that still counts as online (VM beats every 20 s)
const MAX_STATUS_BYTES = 16 * 1024;
const STUCK_MS = 15 * 60 * 1000;          // claimed/running with no ack for this long -> failed
const ACTIVE = ["pending", "claimed", "accepted", "running", "waiting"];
const TERMINAL = new Set(["done", "failed", "expired", "superseded"]);
const ACK_STATES = new Set(["accepted", "running", "waiting", "done", "failed", "superseded"]);

let now = () => Date.now();
function _setClock(fn) { now = fn; }

// Wrong passwords: 5 per 15 minutes per admin, then locked out for the rest of the window.
const pwFails = guard.limiter({ max: 5, windowMs: 15 * 60 * 1000 });
const nonces = new Map();                 // nonce -> { user, exp }

function secret() { return process.env.PEPE_CONTROL_SECRET || process.env.SECRET_KEY || ""; }
const hmac = (s) => crypto.createHmac("sha256", secret()).update(s).digest("base64url");
const userKey = (u) => String((u && u.username) || "").toLowerCase();
function ipHash(ip) { return secret() ? hmac("pepectl-ip|" + String(ip || "?")).slice(0, 16) : "?"; }
function safeEq(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** CSRF token for an admin: "<issued ms, base36>.<HMAC(user|issued)>", valid 12 h. */
function csrfToken(username) {
  if (!secret() || !username) return "";
  const ts = now().toString(36);
  return ts + "." + hmac("pepectl-csrf|" + String(username).toLowerCase() + "|" + ts);
}
function csrfOk(username, token) {
  if (!secret() || typeof token !== "string") return false;
  const [ts, sig] = token.split(".");
  const at = parseInt(ts, 36);
  if (!ts || !sig || !Number.isFinite(at) || now() - at > CSRF_TTL_MS || at - now() > 60000) return false;
  return safeEq(sig, hmac("pepectl-csrf|" + String(username).toLowerCase() + "|" + ts));
}

function issueNonce(user) {
  const t = now();
  for (const [k, v] of nonces) if (v.exp <= t) nonces.delete(k);
  const n = crypto.randomBytes(18).toString("base64url");
  nonces.set(n, { user: userKey(user), exp: t + NONCE_TTL_MS });
  return n;
}
/** Single use: removed on the first try, whatever happens next. */
function takeNonce(user, n) {
  if (typeof n !== "string" || !nonces.has(n)) return false;
  const v = nonces.get(n);
  nonces.delete(n);
  return v.user === userKey(user) && v.exp > now();
}

async function init() {
  await runQuery(`CREATE TABLE IF NOT EXISTS pepe_control_cmds (
    id TEXT PRIMARY KEY, nonce TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, mode TEXT NOT NULL,
    userId TEXT, username TEXT, ip_hash TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    claimed_at INTEGER, updated_at INTEGER, finished_at INTEGER, status TEXT NOT NULL, detail TEXT)`);
  await runQuery("CREATE INDEX IF NOT EXISTS idx_pepe_control_cmds_status ON pepe_control_cmds (status, created_at)");
  await runQuery(`CREATE TABLE IF NOT EXISTS pepe_control_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, userId TEXT, username TEXT, ip_hash TEXT,
    action TEXT NOT NULL, cmd_id TEXT, result TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS pepe_control_status (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL, data TEXT)");
}
let ready = null;
const ensure = () => (ready = ready || init().catch((e) => { ready = null; throw e; }));

async function audit(user, ip, action, cmdId, result) {
  try {
    await runQuery("INSERT INTO pepe_control_audit (at, userId, username, ip_hash, action, cmd_id, result) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [now(), user ? user.userId || null : null, user ? user.username || null : null, ip == null ? null : ipHash(ip), action, cmdId || null, result == null ? null : String(result).slice(0, 300)]);
  } catch (e) { console.error("[pepecontrol] audit:", e.message); }
}

const label = (c) => (KINDS[c.kind] || c.kind) + " (" + (MODES[c.mode] || c.mode) + ")";

/** Commands the VM never picked up in time. */
async function expireStale() {
  const t = now();
  const rows = await getQuery("SELECT id, kind, mode, userId, username FROM pepe_control_cmds WHERE status = 'pending' AND expires_at <= ?", [t]);
  for (const r of rows) {
    const u = await runQuery("UPDATE pepe_control_cmds SET status = 'expired', finished_at = ?, updated_at = ?, detail = ? WHERE id = ? AND status = 'pending'",
      [t, t, "not picked up by the VM within 2 minutes", r.id]);
    if (u.changes) await audit({ userId: r.userId, username: r.username }, null, "result", r.id, "expired: " + label(r) + " was not picked up by the VM within 2 minutes");
  }
  // claimed but the VM went quiet (it gives up on its own after 10 min): don't block the panel forever
  const stuck = await getQuery("SELECT id, kind, mode, userId, username FROM pepe_control_cmds WHERE status IN ('claimed','accepted','running') AND updated_at <= ?", [t - STUCK_MS]);
  for (const r of stuck) {
    const u = await runQuery("UPDATE pepe_control_cmds SET status = 'failed', finished_at = ?, updated_at = ?, detail = ? WHERE id = ? AND status IN ('claimed','accepted','running')",
      [t, t, "no word from the VM for 15 minutes", r.id]);
    if (u.changes) await audit({ userId: r.userId, username: r.username }, null, "result", r.id, "failed: " + label(r) + " - no word from the VM for 15 minutes");
  }
}

function fail(status, message) { const e = new Error(message); e.status = status; return e; }

/** An admin asks for a restart. Throws {status, message} when refused (every refusal is audited). */
async function request(user, { kind, mode, nonce, password }, ip) {
  await ensure();
  if (!user || user.class !== "Admin") throw fail(403, "Admins only.");
  if (!Object.prototype.hasOwnProperty.call(KINDS, kind) || !Object.prototype.hasOwnProperty.call(MODES, mode)) throw fail(400, "Unknown command.");
  const what = KINDS[kind] + " (" + MODES[mode] + ")";
  if (!takeNonce(user, nonce)) {
    await audit(user, ip, "denied", null, what + ": missing, reused or expired nonce");
    throw fail(409, "That confirmation was already used or has expired - start again.");
  }
  const who = userKey(user);
  const wait = pwFails.blocked(who);
  if (wait) {
    await audit(user, ip, "denied", null, what + ": locked out after wrong passwords");
    throw fail(429, "Too many wrong passwords. Try again in " + guard.waitText(wait) + ".");
  }
  const row = (await getQuery("SELECT password FROM users WHERE userId = ?", [user.userId]))[0];
  const hash = row && typeof row.password === "string" && row.password.startsWith("$2") ? row.password : null;
  if (!hash) {
    await audit(user, ip, "denied", null, what + ": account has no password");
    throw fail(403, "Your account has no password to confirm with - set one (forgot password) first.");
  }
  if (typeof password !== "string" || !password || Buffer.byteLength(password, "utf8") > 200 || !(await bcrypt.compare(password, hash))) {
    pwFails.hit(who);
    await audit(user, ip, "denied", null, what + ": wrong password");
    throw fail(403, "Wrong password.");
  }
  pwFails.reset(who);
  await expireStale();
  const t = now();
  const recent = (await getQuery("SELECT COUNT(*) AS n FROM pepe_control_cmds WHERE created_at > ?", [t - RATE_WINDOW_MS]))[0].n;
  if (recent >= RATE_MAX) {
    await audit(user, ip, "denied", null, what + ": rate limit (3 per 10 min)");
    throw fail(429, "Rate limit: at most 3 restarts per 10 minutes.");
  }
  // One at a time. A restart that is only WAITING for a game may be overridden (e.g. "now").
  const busy = (await getQuery(`SELECT id, kind, mode, status FROM pepe_control_cmds WHERE status IN ('pending','claimed','accepted','running') ORDER BY created_at DESC LIMIT 1`))[0];
  if (busy) {
    await audit(user, ip, "denied", null, what + ": another restart is in progress (" + busy.id + ")");
    throw fail(409, "Another restart is already in progress.");
  }
  const id = crypto.randomBytes(8).toString("hex");
  await runQuery(`INSERT INTO pepe_control_cmds (id, nonce, kind, mode, userId, username, ip_hash, created_at, expires_at, updated_at, status)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [id, nonce, kind, mode, user.userId, user.username, ipHash(ip), t, t + PICKUP_MS, t]);
  await audit(user, ip, "requested", id, what);
  return { id, kind, mode, status: "pending", expires_at: t + PICKUP_MS };
}

/** The VM claims the oldest live command. Atomic: a command is handed out at most once. */
async function claim() {
  await ensure();
  await expireStale();
  const t = now();
  const rows = await getQuery("SELECT * FROM pepe_control_cmds WHERE status = 'pending' AND expires_at > ? ORDER BY created_at LIMIT 3", [t]);
  for (const r of rows) {
    const u = await runQuery("UPDATE pepe_control_cmds SET status = 'claimed', claimed_at = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ?", [t, t, r.id, t]);
    if (u.changes === 1) {
      return { id: r.id, nonce: r.nonce, kind: r.kind, mode: r.mode, by: r.username, created_at: r.created_at };
    }
  }
  return null;
}

/** The VM reports progress / the result. Idempotent: a finished command never changes again. */
async function ack({ id, nonce, status, detail }) {
  await ensure();
  if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id)) throw fail(400, "bad id");
  if (!ACK_STATES.has(status)) throw fail(400, "bad status");
  const r = (await getQuery("SELECT * FROM pepe_control_cmds WHERE id = ?", [id]))[0];
  if (!r || !safeEq(r.nonce, nonce)) throw fail(404, "unknown command");
  if (TERMINAL.has(r.status)) return { ok: true, unchanged: true, status: r.status };
  if (r.status === "pending") throw fail(409, "not claimed");
  const t = now();
  const fin = TERMINAL.has(status);
  const d = detail == null ? null : String(detail).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
  const u = await runQuery(`UPDATE pepe_control_cmds SET status = ?, detail = ?, updated_at = ?, finished_at = ? WHERE id = ? AND status NOT IN ('done','failed','expired','superseded')`,
    [status, d, t, fin ? t : null, id]);
  if (!u.changes) return { ok: true, unchanged: true };
  if (fin) await audit({ userId: r.userId, username: r.username }, null, "result", id, status + ": " + label(r) + (d ? " - " + d : ""));
  return { ok: true, status };
}

async function heartbeat(data) {
  await ensure();
  let s = JSON.stringify(data && typeof data === "object" ? data : {});
  if (s.length > MAX_STATUS_BYTES) throw fail(413, "status too large");
  await runQuery("INSERT INTO pepe_control_status (id, at, data) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at, data = excluded.data", [now(), s]);
  return { ok: true };
}

const parse = (s) => { try { return JSON.parse(s); } catch (e) { return null; } };

/** Everything the panel shows. Admin only (the route checks). */
async function view() {
  await ensure();
  await expireStale();
  const t = now();
  const st = (await getQuery("SELECT at, data FROM pepe_control_status WHERE id = 1"))[0] || null;
  const cmds = await getQuery("SELECT id, kind, mode, username, created_at, claimed_at, finished_at, status, detail FROM pepe_control_cmds ORDER BY created_at DESC LIMIT 10");
  const log = await getQuery("SELECT at, username, ip_hash, action, cmd_id, result FROM pepe_control_audit ORDER BY id DESC LIMIT 30");
  const recent = (await getQuery("SELECT COUNT(*) AS n FROM pepe_control_cmds WHERE created_at > ?", [t - RATE_WINDOW_MS]))[0].n;
  return {
    now: t,
    online: !!(st && t - st.at < ONLINE_MS),
    last_seen: st ? st.at : null,
    status: st ? parse(st.data) : null,
    active: cmds.find((c) => ACTIVE.includes(c.status)) || null,
    last: cmds.find((c) => TERMINAL.has(c.status) && c.status !== "expired") || null,
    commands: cmds,
    audit: log,
    rate: { used: recent, max: RATE_MAX, window_min: RATE_WINDOW_MS / 60000 },
    kinds: KINDS, modes: MODES,
  };
}

function register(app, { isBotToken, addUser }) {
  ensure().catch((e) => console.error("[pepecontrol] init:", e.message));
  // the homepage partial makes its CSRF token with this (views/partials/pepe-control.ejs)
  app.locals.pepeCtlCsrf = csrfToken;

  const botToken = (req) => req.get("x-bot-token") || (req.body && typeof req.body.password === "string" ? req.body.password : "");
  const bot = (req, res, next) => (isBotToken(botToken(req)) ? next() : res.status(403).json({ error: "unauthorized" }));
  const admin = (req, res, next) => {
    if (!req.user || !req.user.userId) return res.status(401).json({ error: "Sign in first." });
    if (req.user.class !== "Admin") return res.status(403).json({ error: "Admins only." });
    next();
  };
  const csrf = (req, res, next) => {
    if (!guard.sameSite(req) || !csrfOk(req.user.username, req.get("x-csrf-token"))) {
      audit(req.user, guard.clientIp(req), "denied", null, "CSRF check failed on " + req.path);
      return res.status(403).json({ error: "Security check failed - reload the page." });
    }
    next();
  };
  const send = (res, e) => res.status(e.status || 500).json({ error: e.status ? e.message : "Something went wrong." });
  const noStore = (req, res, next) => { res.set("Cache-Control", "no-store"); next(); };

  app.get("/api/pepe/control/status", noStore, addUser, admin, async (req, res) => {
    try { res.json(await view()); } catch (e) { console.error("[pepecontrol] view:", e.message); send(res, e); }
  });
  app.post("/api/pepe/control/nonce", noStore, addUser, admin, csrf, (req, res) => res.json({ nonce: issueNonce(req.user) }));
  app.post("/api/pepe/control/command", noStore, addUser, admin, csrf, async (req, res) => {
    const b = req.body || {};
    try {
      res.json({ ok: true, command: await request(req.user, { kind: b.kind, mode: b.mode, nonce: b.nonce, password: b.password }, guard.clientIp(req)) });
    } catch (e) { if (!e.status) console.error("[pepecontrol] command:", e.message); send(res, e); }
  });

  // ── the VM supervisor (bot token; it only ever calls out) ──
  app.get("/api/pepe/control/pending", noStore, bot, async (req, res) => {
    try { res.json({ command: await claim() }); } catch (e) { console.error("[pepecontrol] claim:", e.message); send(res, e); }
  });
  app.post("/api/pepe/control/ack", bot, async (req, res) => {
    const b = req.body || {};
    try { res.json(await ack({ id: b.id, nonce: b.nonce, status: b.status, detail: b.detail })); } catch (e) { send(res, e); }
  });
  app.post("/api/pepe/control/heartbeat", bot, async (req, res) => {
    try { res.json(await heartbeat((req.body || {}).status)); } catch (e) { send(res, e); }
  });
}

module.exports = { register, request, claim, ack, heartbeat, view, csrfToken, csrfOk, issueNonce, ipHash, init, expireStale,
  KINDS, MODES, PICKUP_MS, RATE_MAX, _setClock };
