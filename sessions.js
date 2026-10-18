// sessions.js — server-side sign-in sessions: "Your devices", "Sign out everywhere", revocation that works (1.99wj).
//
// Before: a login was a self-contained 90-day JWT in the `jwt` cookie (middleware/loginCookie.js) and nothing on the
// server knew it existed, so nothing could end it early. Now every sign-in is a row here and the cookie's JWT carries
// its id (`sid` claim). The JWT is still what proves the cookie came from us (signed with SECRET_KEY); the row is what
// says it is still allowed.
//
//   sessions          id (PK = SHA-256 hex of the random sid in the cookie - the raw sid is never stored), user_id,
//                     created, last_seen (ms, written at most every SEEN_EVERY_MS), expires (ms: last_seen + 90 days -
//                     the same sliding 90 days the cookie always had), ip (the last one seen), country (Cloudflare's
//                     CF-IPCountry, only when the request really came through our proxy), device (coarse: "Chrome on
//                     Windows" - never the raw user agent), device_key (a hash of the welcome.js browser id: is this a
//                     browser the account used before?), method (password | google | plex | telegram | discord | twitch
//                     | chat | claim | legacy), legacy_key (for a converted pre-sessions cookie), legacy_before,
//                     notified (a new-device notice went out), revoked_at, revoked_why
//   session_cutoffs   user_id PK, after (ms): a pre-sessions cookie (no sid) issued before this can't be converted any
//                     more - "sign out everywhere" also kills cookies that were never seen since the switch-over
//
// The check (gate(), mounted right after cookie-parser in index.js, before anything else reads the cookie): a valid
// JWT with a sid whose row is missing, revoked, expired or someone else's is a signed-out request - the cookie is
// cleared and req.cookies.jwt removed, so every later reader (addUser, authenticateToken, the inbox bell, the DM
// stream, the language / time zone / welcome middlewares, the OAuth link callbacks) sees no login. Rows are cached in
// memory for CACHE_MS (5 s), so a revocation in this process is immediate (the cache entry goes) and one made by any
// other process (a CLI tool) lands within 5 s. A database error keeps the old behaviour (the JWT alone) and logs.
//
// Migration, no mass logout: a valid cookie WITHOUT a sid (issued before this shipped) is converted on its next
// request - a row is created ("Unknown device, signed in before <its iat>", method legacy) and the cookie is re-issued
// with a sid. The sid of a converted cookie is an HMAC of the old token, so two requests racing with the same old
// cookie make ONE row, and that old token keeps mapping to it (revoking the row kills the old token too). A cookie
// without a sid issued before the account's session_cutoffs.after is refused. See docs/sessions.md.
//
// Routes (signed-in member; POSTs need a same-origin fetch with X-Requested-With: fetch):
//   GET  /api/account/sessions                      -> {ok, sessions: [{id, current, device, country, ip, method, created,
//                                                       last_seen, legacy_before}]}
//   POST /api/account/sessions/revoke {id}          sign one device out (this one too: the cookie is cleared)
//   POST /api/account/sessions/revoke-others        everyone but this device (+ the cutoff)
//   POST /api/account/sessions/revoke-all           everyone including this device (+ the cutoff)
//   POST /api/admin/users/:id/sessions/revoke       an admin signs a member out everywhere (audit-logged)
"use strict";
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { runQuery, getQuery, tx } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

const DAY = 86400000;
const LOGIN_MS = 90 * DAY;                 // middleware/loginCookie.js LOGIN_DAYS
const CACHE_MS = 5000;                     // revocation by another process lands within this
const SEEN_EVERY_MS = 5 * 60000;           // last_seen / expires / ip writes, per session
const CACHE_MAX = 20000;
const NOTICE_MAX_PER_HOUR = 3;             // new-device inbox notices per account per hour
const FRESH_MS = 10 * 60000;               // a session this young counts as a fresh sign-in (re-authentication)
const METHODS = ["password", "google", "plex", "telegram", "discord", "twitch", "chat", "claim", "legacy"];

let clock = () => Date.now();
const now = () => clock();
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const str = (v, n) => (v == null || v === "" ? null : String(v).slice(0, n));

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created INTEGER NOT NULL, last_seen INTEGER, expires INTEGER NOT NULL,
        ip TEXT, country TEXT, device TEXT, device_key TEXT, method TEXT, legacy_key TEXT UNIQUE, legacy_before INTEGER,
        notified INTEGER, revoked_at INTEGER, revoked_why TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id, revoked_at)");
      await runQuery("CREATE TABLE IF NOT EXISTS session_cutoffs (user_id TEXT PRIMARY KEY, after INTEGER NOT NULL, why TEXT)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ── coarse device + place ──
/** "Chrome on Windows" from a user agent - families only, never versions or the raw string. */
function describe(ua) {
  const s = String(ua || "");
  if (!s) return "Unknown browser";
  const browser = /Edg(e|A|iOS)?\//.test(s) ? "Edge" : /OPR\/|Opera/.test(s) ? "Opera" : /SamsungBrowser/.test(s) ? "Samsung Internet"
    : /Firefox\/|FxiOS/.test(s) ? "Firefox" : /CriOS|Chrome\//.test(s) ? "Chrome" : /Safari\//.test(s) && /Version\//.test(s) ? "Safari"
    : /curl|wget|python|node-fetch|axios|bot|spider|crawl/i.test(s) ? "Script or bot" : "Browser";
  const os = /iPhone|iPad|iPod/.test(s) ? "iOS" : /Android/.test(s) ? "Android" : /CrOS/.test(s) ? "ChromeOS" : /Windows/.test(s) ? "Windows"
    : /Mac OS X|Macintosh/.test(s) ? "macOS" : /Linux/.test(s) ? "Linux" : null;
  return os ? `${browser} on ${os}` : browser;
}
/** {ip, country}: country only from Cloudflare's header, and only when the request really came through our proxy. */
function place(req) {
  let ip = null, country = null;
  try {
    const guard = require("./middleware/authGuard");
    const a = guard.clientAddr(req);
    ip = a.ip && a.ip !== "?" ? String(a.ip).slice(0, 64) : null;
    if (a.via === "cf") {
      const c = String(req.get("cf-ipcountry") || "").trim().toUpperCase();
      if (/^[A-Z]{2}$/.test(c) && c !== "XX" && c !== "T1") country = c;
    }
  } catch (e) { /* no request */ }
  return { ip, country };
}
function deviceKey(req) {
  const d = req && req.cookies && req.cookies.patv_dev;
  return typeof d === "string" && /^[a-f0-9]{32}$/.test(d) ? sha("dev:" + d).slice(0, 32) : null;
}

// ── the cache ──
const cache = new Map();                    // id -> {row, at}
function cached(id) {
  const c = cache.get(id);
  return c && now() - c.at < CACHE_MS ? c.row : undefined;
}
function remember(id, row) {
  cache.set(id, { row, at: now() });
  if (cache.size > CACHE_MAX) for (const k of [...cache.keys()].slice(0, cache.size - CACHE_MAX / 2)) cache.delete(k);
}
function forgetUser(userId) {
  const u = String(userId);
  for (const [k, c] of cache) if (!c.row || c.row.user_id === u) cache.delete(k);
  cutoffCache.delete(u);
}
const cutoffCache = new Map();               // userId -> {after, at}

async function load(id, { fresh = false } = {}) {
  if (!fresh) { const c = cached(id); if (c !== undefined) return c; }
  await init();
  const row = (await getQuery("SELECT * FROM sessions WHERE id = ?", [id]))[0] || null;
  remember(id, row);
  return row;
}
async function cutoffOf(userId) {
  const u = String(userId);
  const c = cutoffCache.get(u);
  if (c && now() - c.at < CACHE_MS) return c.after;
  await init();
  const r = (await getQuery("SELECT after FROM session_cutoffs WHERE user_id = ?", [u]))[0];
  const after = r ? Number(r.after) || 0 : 0;
  cutoffCache.set(u, { after, at: now() });
  if (cutoffCache.size > CACHE_MAX) cutoffCache.clear();
  return after;
}
const valid = (row, userId, t = now()) => !!row && row.user_id === String(userId) && !row.revoked_at && Number(row.expires) > t;

// ── create / revoke ──
/** A new session for a sign-in. -> {sid (for the cookie), id, row}. */
async function create(req, userId, method, { at = now() } = {}) {
  await init();
  const sid = crypto.randomBytes(32).toString("base64url");
  const id = sha(sid);
  const p = place(req);
  const m = METHODS.includes(method) ? method : "password";
  const row = { id, user_id: String(userId), created: at, last_seen: at, expires: at + LOGIN_MS, ip: p.ip, country: p.country,
                device: describe(req && req.get ? req.get("user-agent") : ""), device_key: deviceKey(req), method: m, legacy_key: null,
                legacy_before: null, notified: null, revoked_at: null, revoked_why: null };
  await runQuery(`INSERT INTO sessions (id, user_id, created, last_seen, expires, ip, country, device, device_key, method)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                 [id, row.user_id, at, at, row.expires, row.ip, row.country, row.device, row.device_key, m]);
  remember(id, row);
  return { sid, id, row };
}

// 1.99acf: every revocation runs in a dbUtils.tx, so the chat hub's outbox rows (huboutbox.js, topic sessions/revoked) commit
// with it: one row per revoked session from the sessions trigger (any writer), plus - in code - an ACCOUNT cutoff when nothing
// is excepted (sign out everywhere, admin, feed ban, password reset, deletion request: the hub closes every chat socket whose
// credential predates it) and a merge row for an account merged away. "Sign out everywhere else" and a password change keep
// this device, so they send only the per-session rows (a cutoff would close this device's chat too).
// Units (docs/chat-tickets.md): `before` is epoch SECONDS, rounded up - the ticket's iat unit, so the hub compares iat < before
// directly; `at` / `until` / created_at are epoch milliseconds. `account` / `into` are the hub's account_id (the ticket's sub:
// chatticket.subjectOf, a legacy id -> its UUIDv5), the raw users.userId beside them as v1_user / v1_into.
const hubSecs = (ms) => Math.ceil(Number(ms) / 1000);
const hubAccount = (userId) => require("./huboutbox").accountOf(userId);
async function revoke(userId, id, why = "signed out") {
  await init();
  const r = await tx(() => runQuery("UPDATE sessions SET revoked_at = ?, revoked_why = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
                                    [now(), str(why, 40), String(id), String(userId)]));
  cache.delete(String(id));
  return (r && r.changes) || 0;
}

/** Every session of the account (but `except`), and a cutoff for cookies from before sessions existed. -> how many. */
async function revokeAll(userId, { except = null, why = "signed out everywhere", cutoff = true } = {}) {
  if (!userId) return 0;
  await init();
  const t = now();
  const r = await tx(async () => {
    const out = except
      ? await runQuery("UPDATE sessions SET revoked_at = ?, revoked_why = ? WHERE user_id = ? AND revoked_at IS NULL AND id != ?", [t, str(why, 40), String(userId), String(except)])
      : await runQuery("UPDATE sessions SET revoked_at = ?, revoked_why = ? WHERE user_id = ? AND revoked_at IS NULL", [t, str(why, 40), String(userId)]);
    if (cutoff) {
      await runQuery(`INSERT INTO session_cutoffs (user_id, after, why) VALUES (?, ?, ?)
                      ON CONFLICT(user_id) DO UPDATE SET after = MAX(after, excluded.after), why = excluded.why`, [String(userId), t, str(why, 40)]);
    }
    if (!except) {
      await require("./huboutbox").emit("sessions/revoked", "acct:" + String(userId),
        { kind: "account", account: hubAccount(userId), v1_user: String(userId), before: hubSecs(t), why: str(why, 40) });
    }
    return out;
  });
  forgetUser(userId);
  return (r && r.changes) || 0;
}

/** accountMerge: the merged-away account's sessions end with the merge (inside the merge's transaction). They are deleted -
 *  an unknown sid is a signed-out request - and its old sid-less cookies can't be converted (the account row is gone).
 *  1.99acf: intoId (the surviving account) rides the hub's merge row - its chat sockets close with 4005. */
async function revokeForMerge(fromId, intoId = null) {
  if (!fromId) return 0;
  const t = (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'"))[0];
  if (!t) return 0;
  const at = now();
  const r = await tx(async () => {
    const out = await runQuery("DELETE FROM sessions WHERE user_id = ?", [String(fromId)]);
    await runQuery("DELETE FROM session_cutoffs WHERE user_id = ?", [String(fromId)]).catch(() => {});
    await require("./huboutbox").emit("sessions/revoked", "acct:" + String(fromId),
      { kind: "merge", account: hubAccount(fromId), into: intoId == null ? null : hubAccount(intoId), v1_user: String(fromId),
        v1_into: intoId == null ? null : String(intoId), before: hubSecs(at) });
    return out;
  });
  forgetUser(fromId);
  return (r && r.changes) || 0;
}

/** 1.99acd: is this session still allowed for this account? (webpush.js: a browser's notifications end with the sign-in
 *  they were turned on under.) The 5 s cache, like gate(). */
async function isLive(id, userId) {
  if (!id || !userId) return false;
  return valid(await load(String(id)), userId);
}

/** The member's live sessions (newest activity first). */
async function list(userId, { current = null } = {}) {
  await init();
  const rows = await getQuery(`SELECT id, created, last_seen, expires, ip, country, device, method, legacy_before FROM sessions
                               WHERE user_id = ? AND revoked_at IS NULL AND expires > ? ORDER BY COALESCE(last_seen, created) DESC LIMIT 100`,
                              [String(userId), now()]);
  return rows.map((r) => Object.assign({}, r, { current: !!current && r.id === current }));
}

/** Is this request's session a fresh sign-in (created within FRESH_MS)? Re-authentication for account deletion. */
async function isFresh(req, within = FRESH_MS) {
  const s = req && req.loginSession;
  if (!s || !s.id) return false;
  const row = await load(s.id, { fresh: true });
  return !!row && valid(row, s.userId) && row.method !== "legacy" && now() - Number(row.created) <= within;
}

// ── sign in: the one place a login cookie with a session is issued ──
/**
 * Create the session, issue the cookie, send a new-device notice if it is one. `method` is one of METHODS; opts.signup =
 * the sign-in that created the account (no notice). Also cancels a pending account deletion (signing in cancels it).
 * -> the session id.
 */
async function signIn(req, res, user, method, opts = {}) {
  const { issueLogin } = require("./middleware/loginCookie");
  // 1.99acd: ANOTHER account signing in over a live sign-in in this browser (a !signin link redeemed while signed in, a
  // shared computer): the cookie is replaced, so the old session can never be used from here again - end it, so what hangs
  // off it (webpush.js browser notifications) stops in this browser too, and it leaves the old account's device list.
  const prev = req && req.loginSession;
  if (prev && prev.id && prev.userId && String(prev.userId) !== String(user.userId)) {
    try { await revoke(prev.userId, prev.id, "another account signed in"); } catch (e) { console.error("[sessions] replaced revoke:", e.message); }
  }
  const s = await create(req, user.userId, method);
  issueLogin(res, { userId: user.userId, username: user.username, class: user.class, sid: s.sid });
  if (req) req.loginSession = { id: s.id, userId: String(user.userId) };
  try { await require("./accountdelete").cancelOnSignIn(user.userId, method); } catch (e) { console.error("[sessions] deletion cancel:", e.message); }
  if (!opts.signup && method !== "chat") {                 // chat sign-in files its own notice (chatsignin.js)
    try { await notifyIfNew(user.userId, s.row); } catch (e) { console.error("[sessions] notice:", e.message); }
  }
  return s.id;
}

const METHOD_LABEL = { password: "your password", google: "Google", plex: "Plex", telegram: "Telegram", discord: "Discord", twitch: "Twitch",
                       chat: "a chat sign-in link (!signin)", claim: "a !signup claim link", legacy: "an older sign-in" };
async function notifyIfNew(userId, row) {
  const u = String(userId);
  const seen = row.device_key
    ? (await getQuery("SELECT 1 FROM sessions WHERE user_id = ? AND device_key = ? AND id != ? LIMIT 1", [u, row.device_key, row.id])).length > 0
    : false;
  if (seen) return false;
  const any = (await getQuery("SELECT 1 FROM sessions WHERE user_id = ? AND id != ? LIMIT 1", [u, row.id])).length > 0;
  if (!any) return false;                                   // the account's first session on record: nothing to compare with
  const recent = (await getQuery("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND notified IS NOT NULL AND notified > ?", [u, now() - 3600000]))[0].n;
  if (recent >= NOTICE_MAX_PER_HOUR) return false;
  await runQuery("UPDATE sessions SET notified = ? WHERE id = ?", [now(), row.id]);
  const where = [row.device, row.country, row.ip].filter(Boolean).join(" · ") || "an unknown browser";
  await require("./inbox").addSafe(u, { kind: "system", title: "New sign-in on a new device",
    body: `Your account was signed in with ${METHOD_LABEL[row.method] || row.method} from ${where}. Not you? Sign that device out in Settings → Account → Security, and change your password.`,
    link: "/settings/account#security", ref: `newdev:${row.id.slice(0, 16)}` });
  return true;
}

// ── the per-request check ──
/**
 * A verified token -> {ok:true, id, token?} (token: a re-issued cookie for a converted old one) or {ok:false, why}.
 */
async function check(decoded, rawToken, req, res) {
  const userId = String(decoded.userId);
  const t = now();
  if (decoded.sid) {
    const id = sha(decoded.sid);
    const row = await load(id);
    if (!valid(row, userId, t)) return { ok: false, why: !row ? "unknown" : row.revoked_at ? "revoked" : "expired" };
    if (t - Number(row.last_seen || 0) >= SEEN_EVERY_MS) touchSeen(row, req, t);
    return { ok: true, id };
  }
  // a cookie from before sessions: convert it (once), unless the account signed out everywhere since it was issued
  const iatMs = Number(decoded.iat) > 0 ? Number(decoded.iat) * 1000 : 0;
  const after = await cutoffOf(userId);
  if (after && iatMs < after) return { ok: false, why: "cutoff" };
  const u = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [userId]))[0];
  if (!u) return { ok: false, why: "gone" };
  const secret = process.env.SECRET_KEY || "";
  const sid = crypto.createHmac("sha256", secret).update("legacy:" + rawToken).digest("base64url");
  const id = sha(sid);
  await init();
  const p = place(req);
  await runQuery(`INSERT OR IGNORE INTO sessions (id, user_id, created, last_seen, expires, ip, country, device, device_key, method, legacy_key, legacy_before)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'legacy', ?, ?)`,
                 [id, userId, iatMs || t, t, t + LOGIN_MS, p.ip, p.country, describe(req && req.get ? req.get("user-agent") : ""), deviceKey(req),
                  sha("legacy-token:" + rawToken), iatMs || null]);
  const row = await load(id, { fresh: true });
  if (!valid(row, userId, t)) return { ok: false, why: "revoked" };
  const { issueLogin } = require("./middleware/loginCookie");
  const token = res ? issueLogin(res, { userId: u.userId, username: u.username, class: u.class, sid }) : null;
  return { ok: true, id, token, converted: true };
}

function touchSeen(row, req, t) {
  row.last_seen = t;
  row.expires = t + LOGIN_MS;
  const p = place(req);
  if (p.ip) row.ip = p.ip;
  if (p.country) row.country = p.country;
  runQuery("UPDATE sessions SET last_seen = ?, expires = ?, ip = COALESCE(?, ip), country = COALESCE(?, country) WHERE id = ? AND revoked_at IS NULL",
           [t, row.expires, p.ip, p.country, row.id]).catch((e) => console.error("[sessions] last_seen:", e.message));
}

/** Middleware (index.js, right after cookie-parser): a revoked / expired / unknown session is a signed-out request. */
const SKIP = /^\/(public|uploads)\/|^\/(healthz|favicon\.ico|apple-touch-icon)/;
async function gate(req, res, next) {
  if (SKIP.test(req.path || "")) return next();                // static files never read the login
  const token = req.cookies && req.cookies.jwt;
  if (!token || !process.env.SECRET_KEY) return next();
  let decoded = null;
  try { decoded = jwt.verify(token, process.env.SECRET_KEY); } catch (e) { decoded = null; }
  if (!decoded || !decoded.userId) return next();             // not a login we issued: every reader ignores it anyway
  try {
    const r = await check(decoded, token, req, res);
    if (r.ok) {
      req.loginSession = { id: r.id, userId: String(decoded.userId) };
      if (r.token) req.cookies.jwt = r.token;
    } else {
      require("./middleware/loginCookie").clearLogin(res);
      delete req.cookies.jwt;
    }
  } catch (e) {
    console.error("[sessions] check failed (the cookie alone decides this request):", e.message);
  }
  next();
}

/** For readers that see the raw Cookie header outside express (hlsauth.js): the user id of a live session, else null. */
async function userIdOfToken(token) {
  if (!token || !process.env.SECRET_KEY) return null;
  let decoded = null;
  try { decoded = jwt.verify(token, process.env.SECRET_KEY); } catch (e) { return null; }
  if (!decoded || !decoded.userId) return null;
  try {
    if (decoded.sid) return valid(await load(sha(decoded.sid)), decoded.userId) ? String(decoded.userId) : null;
    const after = await cutoffOf(decoded.userId);
    if (after && Number(decoded.iat || 0) * 1000 < after) return null;
    // an unconverted old cookie: if it was converted, its row decides
    const sid = crypto.createHmac("sha256", process.env.SECRET_KEY).update("legacy:" + token).digest("base64url");
    const row = await load(sha(sid));
    if (row && !valid(row, decoded.userId)) return null;
    return String(decoded.userId);
  } catch (e) {
    console.error("[sessions] token check:", e.message);
    return String(decoded.userId);
  }
}

// ── routes ──
const sameOriginStrict = (req) => {
  const src = req.get("origin") || req.get("referer");
  try { return !!src && new URL(src).host === req.get("host"); } catch (e) { return false; }
};

function register(app, { addUser }) {
  init().catch((e) => console.error("[sessions] init:", e.message));
  const me = (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) { res.status(401).json({ ok: false, error: "Sign in first." }); return null; }
    return String(req.user.userId);
  };
  const post = (req, res) => {
    if (req.get("X-Requested-With") !== "fetch" || !sameOriginStrict(req)) { res.status(403).json({ ok: false, error: "cross-site" }); return false; }
    return true;
  };
  const current = (req) => (req.loginSession && req.loginSession.id) || null;

  app.get("/api/account/sessions", addUser, async (req, res) => {
    const uid = me(req, res); if (!uid) return;
    try {
      res.json({ ok: true, sessions: (await list(uid, { current: current(req) })).map((s) => ({
        id: s.id, current: s.current, device: s.device, country: s.country, ip: s.ip, method: s.method,
        created: s.created, last_seen: s.last_seen, legacy_before: s.legacy_before })) });
    } catch (e) { console.error("[sessions] list:", e.message); res.status(500).json({ ok: false }); }
  });
  app.post("/api/account/sessions/revoke", addUser, async (req, res) => {
    const uid = me(req, res); if (!uid || !post(req, res)) return;
    const id = String((req.body || {}).id || "");
    if (!/^[a-f0-9]{64}$/.test(id)) return res.status(400).json({ ok: false, error: "bad id" });
    try {
      const n = await revoke(uid, id, "signed out from Settings");
      const here = id === current(req);
      if (here) require("./middleware/loginCookie").clearLogin(res);
      res.json({ ok: true, revoked: n, signedOut: here });
    } catch (e) { console.error("[sessions] revoke:", e.message); res.status(500).json({ ok: false }); }
  });
  app.post("/api/account/sessions/revoke-others", addUser, async (req, res) => {
    const uid = me(req, res); if (!uid || !post(req, res)) return;
    const cur = current(req);
    if (!cur) return res.status(409).json({ ok: false, error: "Reload the page and try again." });
    try { res.json({ ok: true, revoked: await revokeAll(uid, { except: cur, why: "signed out everywhere else" }) }); }
    catch (e) { console.error("[sessions] revoke-others:", e.message); res.status(500).json({ ok: false }); }
  });
  app.post("/api/account/sessions/revoke-all", addUser, async (req, res) => {
    const uid = me(req, res); if (!uid || !post(req, res)) return;
    try {
      const n = await revokeAll(uid, { why: "signed out everywhere" });
      require("./middleware/loginCookie").clearLogin(res);
      res.json({ ok: true, revoked: n, signedOut: true });
    } catch (e) { console.error("[sessions] revoke-all:", e.message); res.status(500).json({ ok: false }); }
  });
  // an admin signs a member out everywhere (e.g. a compromised account)
  app.post("/api/admin/users/:id/sessions/revoke", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    if (!post(req, res)) return;
    const row = (await getQuery("SELECT class FROM users WHERE userId = ?", [req.user.userId]).catch(() => []))[0];
    if (!SP.can(row, "accounts.sessions_revoke")) return res.status(403).json({ ok: false, error: "Admins only." });
    const target = (await getQuery("SELECT userId, username FROM users WHERE userId = ?", [String(req.params.id)]))[0];
    if (!target) return res.status(404).json({ ok: false, error: "No such account." });
    // 1.99wl: a reason and the member's username typed as the confirmation (/admin/accounts); audited before it runs
    const b = req.body || {};
    const reason = String(b.reason || "").trim().slice(0, 200);
    if (String(b.confirm || "").trim() !== target.username) return res.status(400).json({ ok: false, error: "Type the member's username exactly to confirm.", code: "E_CONFIRM" });
    if (reason.length < 3) return res.status(400).json({ ok: false, error: "Give a reason.", code: "E_REASON" });
    try {
      const me = (await getQuery("SELECT userId, username FROM users WHERE userId = ?", [req.user.userId]))[0];
      await require("./adminaudit").record(me, "sessions.revoke_all", target, null, reason);
      const n = await revokeAll(target.userId, { why: "admin" });
      res.json({ ok: true, revoked: n });
    } catch (e) { console.error("[sessions] admin revoke:", e.message); res.status(500).json({ ok: false }); }
  });
}

module.exports = { init, register, gate, check, create, revoke, revokeAll, revokeForMerge, list, signIn, isFresh, isLive, userIdOfToken, describe,
                   notifyIfNew, cutoffOf, METHODS, LOGIN_MS, CACHE_MS, SEEN_EVERY_MS, FRESH_MS, sha,
                   _setClock: (f) => { clock = f || (() => Date.now()); }, _clearCache: () => { cache.clear(); cutoffCache.clear(); } };
