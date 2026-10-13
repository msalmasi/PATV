// chatsignin.js — !signin: a chat user whose Camfrog login is linked to a REAL PATV account gets a one-time sign-in link by PM.
//
// Trust: the same as !verify - Pepe knows which Camfrog login typed the command, so whoever controls that login gets in.
//
//   POST /api/chatsignin/link {password (bot), login}   Pepe asks for a link for the login that typed !signin
//        -> {ok:true, url, minutes, username} | {ok:false, reason: "signup" (no real account: use !signup) | "off" (the owner
//           turned chat sign-in off) | "elevated" (admin / staff: refused) | "rate" (5 an hour) | "bad"}
//   GET  /signin                     the landing page. The token is in the URL FRAGMENT (/signin#t=<token>): browsers never send
//                                    a fragment, so it never reaches nginx's access log or this server's, and a link preview /
//                                    scanner that fetches the URL gets an empty page it can't use. The page's script reads it,
//                                    removes it from the address bar, asks who it is for (peek) and shows ONE button.
//   POST /api/chatsignin/peek {token} (fetch, same-origin)  -> {ok, username} without spending it
//   POST /signin  token=<token>      the button: a same-origin form POST (Origin or Referer must be this host - a CSRF / link
//                                    scanner can't do it), spends the token atomically, re-checks the account, then signs in
//                                    exactly like the password form (user.controller.finishLogin: the same 90-day cookie)
//   GET/POST /api/settings/chat-signin {enabled}   the owner's switch (Settings -> Security), default ON
//
// Tokens: 32 random characters (24 bytes), only the SHA-256 kept, one use, TOKEN_TTL_MS, a new one cancels the older unused
// ones, at most PER_HOUR per login; peek and redemption are rate-limited per IP. Never logged.
// Every link issued / used / refused is a chat_signin_log row (the account's security log); a sign-in also leaves an inbox
// notice "Signed in from chat (!signin)" with the IP and browser.
// Accounts with elevated rights (users.class other than a plain member, or an admin / staff / moderator role) are REFUSED: the
// site has no second factor to ask for, and a hijacked Camfrog login must never become a hijacked admin account.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery, tx } = require("./dbUtils");

const TOKEN_TTL_MS = 10 * 60000;
const PER_HOUR = 5;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const ELEVATED_ROLE = /admin|staff|mod|owner_of_site/i;

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS chat_signin_tokens (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, login TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
        used_at INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS chat_signin_tokens_login ON chat_signin_tokens (login, created)");
      await runQuery("CREATE TABLE IF NOT EXISTS chat_signin_prefs (user_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL, updated INTEGER)");
      await runQuery(`CREATE TABLE IF NOT EXISTS chat_signin_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, login TEXT, at INTEGER NOT NULL, kind TEXT NOT NULL, ip TEXT, agent TEXT, why TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS chat_signin_log_user ON chat_signin_log (user_id, at)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const sha = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
const str = (v, n) => (v == null ? null : String(v).slice(0, n));
function siteBase() {
  return String(process.env.PUBLIC_BASE_URL || process.env.SITE_URL || (process.env.STAGING ? "https://staging.publicaccess.tv" : "https://publicaccess.tv")).replace(/\/+$/, "");
}
async function log(e) {
  try {
    await runQuery("INSERT INTO chat_signin_log (user_id, login, at, kind, ip, agent, why) VALUES (?, ?, ?, ?, ?, ?, ?)",
                   [str(e.userId, 80), str(e.login, 64), e.at || Date.now(), e.kind, str(e.ip, 64), str(e.agent, 200), str(e.why, 80)]);
  } catch (err) { console.error("[chatsignin] log:", err.message); }
}

/** The owner's switch (default on). */
async function enabledFor(userId) {
  await init();
  const r = (await getQuery("SELECT enabled FROM chat_signin_prefs WHERE user_id = ?", [String(userId || "")]))[0];
  return !r || Number(r.enabled) !== 0;
}
async function setEnabled(userId, on) {
  await init();
  await runQuery(`INSERT INTO chat_signin_prefs (user_id, enabled, updated) VALUES (?, ?, ?)
                  ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, updated = excluded.updated`, [String(userId), on ? 1 : 0, Date.now()]);
  await log({ userId, kind: on ? "setting-on" : "setting-off" });
  return on;
}

/** Admin / staff / moderator accounts (by class or a site role) never sign in from chat. */
async function elevated(user) {
  const cls = String((user && user.class) || "").trim();
  if (cls && cls.toLowerCase() !== "pleb") return true;
  try {
    const roles = await getQuery("SELECT role FROM user_roles WHERE userId = ?", [String(user.userId)]);
    if (roles.some((r) => ELEVATED_ROLE.test(String(r.role || "")))) return true;
  } catch (e) { /* no roles table */ }
  return false;
}

/** The account a Camfrog login belongs to, if it is a REAL one (not Pepe's auto account). */
async function realAccountFor(login) {
  const l = String(login || "").toLowerCase().trim();
  if (!l || l.length > 64) return null;
  const u = (await getQuery("SELECT userId, username, class FROM users WHERE lower(trim(camfrogUsername)) = ? LIMIT 1", [l]))[0];
  if (!u) return null;
  if (await require("./autoaccount").isAutoAccount(u.userId)) return null;
  return u;
}

/** Pepe: a sign-in link for the login that typed !signin. */
async function issue(login, { now = Date.now() } = {}) {
  await init();
  const l = String(login || "").toLowerCase().trim();
  if (!l || l.length > 64) return { ok: false, reason: "bad" };
  const u = await realAccountFor(l);
  if (!u) return { ok: false, reason: "signup" };
  if (await elevated(u)) { await log({ userId: u.userId, login: l, kind: "refused", why: "elevated", at: now }); return { ok: false, reason: "elevated" }; }
  if (!(await enabledFor(u.userId))) { await log({ userId: u.userId, login: l, kind: "refused", why: "off", at: now }); return { ok: false, reason: "off" }; }
  const recent = (await getQuery("SELECT COUNT(*) AS n FROM chat_signin_tokens WHERE login = ? AND created > ?", [l, now - 3600000]))[0].n;
  if (recent >= PER_HOUR) return { ok: false, reason: "rate" };
  const token = crypto.randomBytes(24).toString("base64url");
  await tx(async () => {
    await runQuery("UPDATE chat_signin_tokens SET expires = ? WHERE login = ? AND used_at IS NULL AND expires > ?", [now, l, now]);
    await runQuery("INSERT INTO chat_signin_tokens (token_hash, user_id, login, created, expires) VALUES (?, ?, ?, ?, ?)",
                   [sha(token), String(u.userId), l, now, now + TOKEN_TTL_MS]);
  });
  await log({ userId: u.userId, login: l, kind: "issued", at: now });
  return { ok: true, url: `${siteBase()}/signin#t=${token}`, minutes: TOKEN_TTL_MS / 60000, username: u.username };
}

/** Who an unspent token is for (nothing spent). -> {ok, username} | {ok:false, error} */
async function peek(token, { now = Date.now() } = {}) {
  if (!TOKEN_RE.test(String(token || ""))) return { ok: false, error: "expired" };
  await init();
  const r = (await getQuery(`SELECT t.user_id, t.expires, t.used_at, u.username FROM chat_signin_tokens t LEFT JOIN users u ON u.userId = t.user_id
                             WHERE t.token_hash = ?`, [sha(token)]))[0];
  if (!r || r.used_at || r.expires <= now || !r.username) return { ok: false, error: "expired" };
  return { ok: true, username: r.username };
}

/**
 * The button: spend the token, re-check everything, sign in. -> {ok, user} | {ok:false, error}. `signIn(user)` issues the
 * session (user.controller.finishLogin in production).
 */
async function redeem(token, { now = Date.now(), ip = null, agent = null, signIn } = {}) {
  if (!TOKEN_RE.test(String(token || ""))) return { ok: false, error: "expired" };
  await init();
  const h = sha(token);
  const r = (await getQuery("SELECT user_id, login, expires, used_at FROM chat_signin_tokens WHERE token_hash = ?", [h]))[0];
  if (!r || r.used_at || r.expires <= now) return { ok: false, error: "expired" };
  const spent = await runQuery("UPDATE chat_signin_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires > ?", [now, h, now]);
  if (!spent || spent.changes !== 1) return { ok: false, error: "expired" };
  // the account as it is NOW: still the login's real account, still allowed
  const u = (await getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [r.user_id]))[0];
  const why = !u ? "gone" : String(u.camfrogUsername || "").toLowerCase().trim() !== r.login ? "relinked"
    : (await elevated(u)) ? "elevated" : !(await enabledFor(u.userId)) ? "off" : null;
  if (why) {
    await log({ userId: r.user_id, login: r.login, kind: "refused", why, ip, agent, at: now });
    return { ok: false, error: why === "off" ? "off" : why === "elevated" ? "elevated" : "expired" };
  }
  await signIn(u);
  await log({ userId: u.userId, login: r.login, kind: "used", ip, agent, at: now });
  const where = [ip, agent].filter(Boolean).join(" · ") || "an unknown browser";
  await require("./inbox").addSafe(u.userId, { kind: "system", title: "Signed in from chat (!signin)",
    body: `Your Camfrog name ${r.login} used a one-time chat link to sign in to this account from ${where}. Not you? Change your Camfrog password, and turn chat sign-in off in Settings → Account → Security.`,
    link: "/settings/account#security", ref: `chatsignin:${h.slice(0, 16)}` });
  console.log(`[chatsignin] ${u.username} signed in from chat`);
  return { ok: true, user: u };
}

/** The account's recent chat sign-in log (Settings -> Security). */
async function recent(userId, limit = 10) {
  await init();
  return getQuery("SELECT at, kind, ip, agent, why FROM chat_signin_log WHERE user_id = ? ORDER BY at DESC LIMIT ?", [String(userId), limit]);
}

const sameOriginStrict = (req) => {
  const src = req.get("origin") || req.get("referer");
  try { return !!src && new URL(src).host === req.get("host"); } catch (e) { return false; }
};

function register(app, { isBotToken, addUser }) {
  init().catch((e) => console.error("[chatsignin] init:", e.message));
  const guard = require("./middleware/authGuard");
  const peekLimit = guard.limiter({ max: 30, windowMs: 15 * 60000 });
  const redeemLimit = guard.limiter({ max: 10, windowMs: 15 * 60000 });
  const noLeak = (res) => { res.set("Referrer-Policy", "same-origin"); res.set("X-Robots-Tag", "noindex"); res.set("Cache-Control", "no-store"); };
  const page = (req, res, status, view) => {
    noLeak(res);
    res.status(status).render("chatSignin", Object.assign({ user: req.user && req.user.username ? req.user.username : null, error: null, done: null }, view));
  };

  app.post("/api/chatsignin/link", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await issue(b.login)); } catch (e) { console.error("[chatsignin] link:", e.message); res.status(500).json({ ok: false, reason: "error" }); }
  });
  app.get("/signin", addUser, (req, res) => page(req, res, 200, {}));
  app.post("/api/chatsignin/peek", async (req, res) => {
    noLeak(res);
    if (req.get("X-Requested-With") !== "fetch" || !sameOriginStrict(req)) return res.status(403).json({ ok: false, error: "cross-site" });
    const ip = guard.clientIp(req);
    if (peekLimit.blocked(ip)) return res.status(429).json({ ok: false, error: "slow" });
    peekLimit.hit(ip);
    try { res.json(await peek((req.body || {}).token)); } catch (e) { console.error("[chatsignin] peek:", e.message); res.status(500).json({ ok: false, error: "error" }); }
  });
  app.post("/signin", addUser, async (req, res) => {
    if (!sameOriginStrict(req)) { noLeak(res); return res.status(403).send("Cross-site request refused"); }
    const ip = guard.clientIp(req);
    if (redeemLimit.blocked(ip)) return page(req, res, 429, { error: "slow" });
    redeemLimit.hit(ip);
    try {
      const uc = require("./user.controller");
      const r = await redeem((req.body || {}).token, { ip, agent: str(req.get("user-agent"), 200),
                                                      signIn: (u) => uc.finishLogin(req, res, u, "chat sign-in") });
      if (!r.ok) return page(req, res, r.error === "expired" ? 410 : 403, { error: r.error });
      noLeak(res);
      return res.redirect(303, `/u/${encodeURIComponent(r.user.username)}`);
    } catch (e) {
      console.error("[chatsignin] redeem:", e.message);
      return page(req, res, 500, { error: "error" });
    }
  });
  // the owner's switch + the account's chat sign-in log (Settings -> Security)
  app.get("/api/settings/chat-signin", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false });
    try { res.json({ ok: true, enabled: await enabledFor(req.user.userId), log: await recent(req.user.userId) }); }
    catch (e) { res.status(500).json({ ok: false }); }
  });
  app.post("/api/settings/chat-signin", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false });
    if (req.get("X-Requested-With") !== "fetch" || !sameOriginStrict(req)) return res.status(403).json({ ok: false, error: "cross-site" });
    const on = (req.body || {}).enabled;
    if (typeof on !== "boolean") return res.status(400).json({ ok: false, error: "enabled must be true or false" });
    try { res.json({ ok: true, enabled: await setEnabled(req.user.userId, on) }); } catch (e) { res.status(500).json({ ok: false }); }
  });
}

module.exports = { init, register, issue, peek, redeem, enabledFor, setEnabled, elevated, realAccountFor, recent, TOKEN_TTL_MS, PER_HOUR };
