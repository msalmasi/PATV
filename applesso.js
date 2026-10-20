// applesso.js — "Sign in with Apple" on /login and /register + link / unlink on Settings → Account → Connections, and Apple's
// server-to-server notifications.
//
// Apple's web flow (OpenID Connect, authorization code, response_mode form_post):
//   GET  /auth/apple                (sign in)        \  a fresh state + nonce in a short-lived SIGNED cookie (apple_sso: HMAC-SHA256,
//   POST /auth/apple/link           (signed in, link) /  HttpOnly, Secure, SameSite=None, Path=/auth/apple/callback, 10 minutes;
//                                                        plus a twin, apple_sso_l, with no SameSite attribute for Safari on iOS 12 /
//                                                        macOS 10.14, which treats SameSite=None as Strict - WebKit bug 198181)
//                                                        -> appleid.apple.com/auth/authorize, response_type code, scope "name email"
//   POST /auth/apple/callback       Apple POSTs the answer back CROSS-SITE, so a SameSite=Lax cookie (the login, the session) is not
//                                   sent with it - hence the state's own SameSite=None cookie. This route is mounted BEFORE the session
//                                   middleware (registerEarly), so it never mints a fresh session cookie over the member's real one.
//                                   The cookie's signature, age and state must match (timing-safe) and the state is single use
//                                   (ssolinks.useOnce); the code goes to Apple's token endpoint with the client secret, and the ID
//                                   token that comes back is VERIFIED: RS256 against Apple's JWKS (kid), iss https://appleid.apple.com,
//                                   aud = our Services ID, exp / iat with 60 s skew, nonce = the cookie's. The result waits server-side
//                                   (apple_handoff: keyed by the SHA-256 of a random token, 2 minutes, single use); the browser gets
//                                   that token in a SameSite=Lax cookie (Path=/auth/apple/continue) and a 303 to
//   GET  /auth/apple/continue       same-site, with the normal session and login: link / sign in / park for /auth/sso/new
//                                   (ssolinks.js - the same steps as Google, Telegram and Plex). Nothing but the state is ever in a URL.
//   POST /api/sso/apple/unlink      the last-method guard and the link going in one transaction (ssolinks.unlinkGuarded), then
//                                   Apple's refresh token is revoked (appleid.apple.com/auth/revoke; a failed call is retried from
//                                   apple_revokes)
//   POST /auth/apple/notifications  Apple's server-to-server notifications ({payload: <JWS>}): verified against Apple's JWKS (RS256,
//                                   iss, aud = APPLE_APP_ID - the primary App ID the endpoint is registered on - or the Services
//                                   ID, iat at most a week old / exp); consent-revoked and account-deleted (Apple's name; the older
//                                   "account-delete" is accepted too) -> unlinked + the sessions signed in with Apple before the
//                                   event end (consent-revoked on an account Apple is the only way into keeps the link, minus the
//                                   token: see onNotification); email-disabled / email-enabled -> the relay address's contact flag
//                                   (sso_links.email_off, newest event wins). Each one is applied once (apple_notices); one about
//                                   an event before the current link / the last Apple sign-in never undoes those. CSRF-exempt by
//                                   design: Apple's server calls it (no cookie, no Origin) and only Apple's signature counts.
//
// The identity is Apple's `sub` (stable per developer team - v2's identity service imports these rows by it), NEVER the email.
// Apple sends the name (the unsigned `user` form field) ONLY the first time someone authorizes PATV; it and the ID token's email
// are display only (sso_links.name / email), like Google's. A privaterelay.appleid.com address is contact only: never a lookup key
// and never the new account's users.email (sso_links.email_relay = 1). Apple's refresh token is kept AES-256-GCM encrypted
// (sso_links.refresh_token_enc; key derived from SECRET_KEY, Apple's sub as AAD) only so it can be revoked on unlink / account
// deletion / merge; the access token is never used or stored. Every revocation goes through the apple_revokes queue, written in
// the same transaction that removes the link (a restart can't lose a token), then tried at once; a token from a sign-in that never
// ends up on a link (an abandoned sign-up) is queued too, and revoked if nothing claims it within UNUSED_MS. Revoking ends PATV's
// whole authorization at Apple, so a queued one is dropped unsent when that Apple ID is linked again by then.
//
// The client secret is an ES256 JWT (iss Team ID, sub Services ID, aud https://appleid.apple.com, kid Key ID; 30 days - Apple allows
// up to 6 months) signed with the .p8 key: made at boot, remade a day before it expires or when the keys change.
//
// Configure (.env only): APPLE_SERVICES_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY (base64 of the .p8 PEM) - all four,
// or the buttons stay hidden (ssoconf.appleClient). APPLE_APP_ID: the primary App ID's bundle id - Apple's notifications name it as
// their audience, so without it they are refused (a boot warning + the /admin/users#signin card say so). At Apple (Services ID
// -> Sign in with Apple): domain + Return URL <site>/auth/apple/callback; the App ID's server-to-server notification endpoint
// <site>/auth/apple/notifications. Switch: ssoconf apple_sso (default on).
//
//   apple_handoff   k PK (SHA-256 of the hand-off token), at, data (JSON: mode, uid, next, who - the refresh token encrypted)
//   apple_revokes   k PK (SHA-256 of the token), apple_sub, token_enc, why (unlinked | account deleted | merged away | unused),
//                   tries, next_at, last_error, created - revocations still to send, retried with backoff
//   apple_notices   k PK ('n:' + SHA-256 of the notification's jti), at, type - the notifications already applied (kept
//                   NOTICE_KEEP_MS, longer than the NOTICE_MAX_AGE_MS a notification may be old); 'last:ok' = the newest one
"use strict";
const crypto = require("crypto");
const conf = require("./ssoconf");
const sso = require("./ssolinks");
const guard = require("./middleware/authGuard");
const { runQuery, getQuery, tx } = require("./dbUtils");

const ISSUER = "https://appleid.apple.com";
const AUTH_URL = ISSUER + "/auth/authorize";
const TOKEN_URL = ISSUER + "/auth/token";
const REVOKE_URL = ISSUER + "/auth/revoke";
const JWKS_URL = ISSUER + "/auth/keys";
const TTL = 10 * 60 * 1000;                // a sign-in must come back from Apple within this
const HANDOFF_TTL = 2 * 60 * 1000;         // the callback -> continue hand-off
const SKEW_S = 60;
const SECRET_LIFE_S = 30 * 86400;          // the client secret JWT (Apple: at most 15777000 s)
const SECRET_RENEW_S = 86400;              // remade when less than this is left
const STATE_COOKIE = "apple_sso";
const STATE_COOKIE_LEGACY = "apple_sso_l";   // the same value WITHOUT a SameSite attribute, for older browsers (see start())
const STATE_PATH = "/auth/apple/callback";
const HANDOFF_COOKIE = "apple_sso_h";
const HANDOFF_PATH = "/auth/apple/continue";
const ACCOUNT_PAGE = "/settings/account#connections";
const SUB_RE = /^[A-Za-z0-9._-]{1,255}$/;
const RELAY_RE = /@privaterelay\.appleid\.com$/i;
const ERRS = new Set(["expired", "cancelled", "failed", "off", "slow"]);
const REVOKE_MAX_TRIES = 10;
const RETRY_MS = 5 * 60e3;                 // a revocation Apple didn't take: tried again after this (then backing off)
const UNUSED_MS = TTL + HANDOFF_TTL + 3 * 60e3;   // a sign-in's token not on a link by then (abandoned) is revoked
const NOTICE_MAX_AGE_MS = 7 * 86400e3;     // Apple's notifications carry no exp: one issued longer ago than this is refused
const NOTICE_KEEP_MS = 8 * 86400e3;        // applied notifications are remembered longer than that (a replay finds its record)
let clock = () => Date.now();

// HTTP (tests swap it): post(url, form) / get(url) -> {status, data, headers}. axios (Node 16 has no global fetch).
let http = {
  async post(url, form) {
    const axios = require("axios");
    const r = await axios.post(url, new URLSearchParams(form).toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      timeout: 10000, validateStatus: () => true });
    return { status: r.status, data: r.data, headers: r.headers || {} };
  },
  async get(url) {
    const axios = require("axios");
    const r = await axios.get(url, { timeout: 10000, validateStatus: () => true });
    return { status: r.status, data: r.data, headers: r.headers || {} };
  },
};

const startLimit = guard.limiter({ max: 12, windowMs: 15 * 60 * 1000 });
const callbackLimit = guard.limiter({ max: 30, windowMs: 15 * 60 * 1000 });

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a.length) return false;
  const x = Buffer.from(a), y = Buffer.from(b);          // (byte lengths: a multi-byte string of the same length never throws)
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function site() {
  return String(process.env.PUBLIC_BASE_URL || process.env.SITE_URL || (process.env.STAGING ? "https://staging.publicaccess.tv" : "https://publicaccess.tv")).replace(/\/+$/, "");
}
const redirectUri = () => site() + "/auth/apple/callback";
const notificationsUri = () => site() + "/auth/apple/notifications";
const appId = () => String(process.env.APPLE_APP_ID || "").trim();
function enabled() { return conf.on.apple(); }

// ── keys derived from the server secret: the state cookie's MAC, the refresh token's encryption ──
function serverSecret() {
  const s = String(process.env.SECRET_KEY || process.env.APP_SESSION_SECRET || "");
  if (s.length < 8) throw new Error("SECRET_KEY is not set");
  return s;
}
const derived = new Map();
function subKey(info) {
  const s = serverSecret();
  const k = info + "\u0000" + sha(s);
  if (!derived.has(k)) { derived.clear(); derived.set(k, Buffer.from(crypto.hkdfSync("sha256", Buffer.from(s), Buffer.from("patv-apple-v1"), Buffer.from(info), 32))); }
  return derived.get(k);
}

/** Apple's refresh token -> "v1.<iv>.<tag>.<ciphertext>" (AES-256-GCM, Apple's sub as AAD). */
function encryptToken(plain, subject) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", subKey("refresh-token"), iv);
  c.setAAD(Buffer.from("apple:" + subject));
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return ["v1", b64url(iv), b64url(c.getAuthTag()), b64url(ct)].join(".");
}
function decryptToken(blob, subject) {
  const p = String(blob || "").split(".");
  if (p.length !== 4 || p[0] !== "v1") throw new Error("bad ciphertext");
  const d = crypto.createDecipheriv("aes-256-gcm", subKey("refresh-token"), fromB64url(p[1]));
  d.setAAD(Buffer.from("apple:" + subject));
  d.setAuthTag(fromB64url(p[2]));
  return Buffer.concat([d.update(fromB64url(p[3])), d.final()]).toString("utf8");
}

// ── the state cookie: {s: state, n: nonce, at, m: mode, u: userId (link), x: next}, MACed ──
function sealState(st) {
  const body = b64url(JSON.stringify(st));
  return body + "." + b64url(crypto.createHmac("sha256", subKey("state-cookie")).update(body).digest());
}
function openState(v) {
  const s = typeof v === "string" ? v : "";
  const i = s.indexOf(".");
  if (i < 1 || s.length > 2000) return null;
  const body = s.slice(0, i);
  if (!same(s.slice(i + 1), b64url(crypto.createHmac("sha256", subKey("state-cookie")).update(body).digest()))) return null;
  try { const st = JSON.parse(fromB64url(body).toString("utf8")); return st && typeof st === "object" ? st : null; } catch (e) { return null; }
}
const cookieOpts = (path, sameSite, maxAge) => Object.assign({ httpOnly: true, secure: true, sameSite, path }, maxAge ? { maxAge } : {});
function cookiesOf(req) {
  if (req.cookies) return req.cookies;
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { /* skip */ } }
  }
  return out;
}

// ── the client secret (ES256 JWT) ──
let secretMemo = { fp: "", jwt: "", exp: 0 };
function clientSecret(c = conf.appleClient(), nowMs = clock()) {
  if (!c) throw new Error("not configured");
  const fp = [c.servicesId, c.teamId, c.keyId, c.fp].join("|");
  const nowS = Math.floor(nowMs / 1000);
  if (secretMemo.fp === fp && secretMemo.exp - nowS > SECRET_RENEW_S) return secretMemo.jwt;
  const head = b64url(JSON.stringify({ alg: "ES256", kid: c.keyId }));
  const body = b64url(JSON.stringify({ iss: c.teamId, iat: nowS, exp: nowS + SECRET_LIFE_S, aud: ISSUER, sub: c.servicesId }));
  const sig = crypto.sign("sha256", Buffer.from(head + "." + body), { key: c.key, dsaEncoding: "ieee-p1363" });
  secretMemo = { fp, jwt: `${head}.${body}.${b64url(sig)}`, exp: nowS + SECRET_LIFE_S };
  return secretMemo.jwt;
}

// ── Apple's signing keys (JWKS), cached per Cache-Control max-age; an unknown kid refetches at most once a minute ──
let jwks = { keys: new Map(), until: 0, fetchedAt: 0 };
async function loadJwks(force) {
  const t = clock();
  if (!force && jwks.until > t && jwks.keys.size) return jwks.keys;
  if (force && t - jwks.fetchedAt < 60e3 && jwks.keys.size) return jwks.keys;
  const r = await http.get(JWKS_URL);
  if (r.status !== 200 || !r.data || !Array.isArray(r.data.keys)) throw new Error(`jwks answered ${r.status}`);
  const keys = new Map();
  for (const k of r.data.keys) {
    if (!k || k.kty !== "RSA" || !k.kid || (k.use && k.use !== "sig") || (k.alg && k.alg !== "RS256")) continue;
    try { keys.set(String(k.kid), crypto.createPublicKey({ key: { kty: "RSA", n: k.n, e: k.e }, format: "jwk" })); } catch (e) { /* skip a bad key */ }
  }
  const cc = String((r.headers && (r.headers["cache-control"] || r.headers["Cache-Control"])) || "");
  const maxAge = Math.min(Math.max(Number((/max-age=(\d+)/.exec(cc) || [])[1]) || 3600, 60), 86400);
  jwks = { keys, until: t + maxAge * 1000, fetchedAt: t };
  return keys;
}
async function keyFor(kid) {
  let keys = await loadJwks(false);
  if (!keys.has(kid)) keys = await loadJwks(true);
  return keys.get(kid) || null;
}

class Bad extends Error { constructor(code) { super(code); this.code = code; } }
/** An Apple-signed JWT (RS256) -> its claims, or throws Bad: E_FORMAT, E_ALG, E_KID, E_SIG, E_ISS, E_AUD, E_EXP, E_IAT, E_NONCE, E_SUB. */
async function verifyJwt(token, { audiences, nonce = null, idToken = true, now = clock(), getKey = keyFor } = {}) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p)) || String(token).length > 16384) throw new Bad("E_FORMAT");
  let header, claims;
  try { header = JSON.parse(fromB64url(parts[0]).toString("utf8")); claims = JSON.parse(fromB64url(parts[1]).toString("utf8")); }
  catch (e) { throw new Bad("E_FORMAT"); }
  if (!header || header.alg !== "RS256") throw new Bad("E_ALG");
  if (!header.kid || typeof header.kid !== "string") throw new Bad("E_KID");
  const key = await getKey(header.kid);
  if (!key) throw new Bad("E_KID");
  if (!crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), key, fromB64url(parts[2]))) throw new Bad("E_SIG");
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) throw new Bad("E_FORMAT");
  if (claims.iss !== ISSUER) throw new Bad("E_ISS");
  const auds = (Array.isArray(claims.aud) ? claims.aud : [claims.aud]).filter((a) => typeof a === "string");
  if (!auds.length || !auds.some((a) => (audiences || []).includes(a))) throw new Bad("E_AUD");
  const nowS = Math.floor(now / 1000);
  const exp = Number(claims.exp), iat = Number(claims.iat);
  if (idToken || claims.exp !== undefined) { if (!Number.isFinite(exp) || exp + SKEW_S < nowS) throw new Bad("E_EXP"); }
  if (!Number.isFinite(iat) || iat - SKEW_S > nowS) throw new Bad("E_IAT");
  if (idToken) {
    if (!same(typeof claims.nonce === "string" ? claims.nonce : "", nonce || "")) throw new Bad("E_NONCE");
    if (typeof claims.sub !== "string" || !SUB_RE.test(claims.sub)) throw new Bad("E_SUB");
  }
  return claims;
}
/** Verify the ID token from Apple's token endpoint (aud = the Services ID, nonce = this browser's). */
const verifyIdToken = (idToken, { clientId, nonce, now, getKey } = {}) => verifyJwt(idToken, { audiences: [clientId], nonce, idToken: true, now, getKey });

/** The code -> {claims (verified), refresh (Apple's refresh token or null)}. The access token is dropped unused. */
async function exchange(code, nonce) {
  const c = conf.appleClient();
  if (!c) throw new Error("not configured");
  const r = await http.post(TOKEN_URL, { client_id: c.servicesId, client_secret: clientSecret(c), code: String(code), grant_type: "authorization_code",
                                         redirect_uri: redirectUri() });
  if (r.status !== 200 || !r.data || typeof r.data.id_token !== "string") {
    throw new Error(`token endpoint answered ${r.status}${r.data && typeof r.data.error === "string" ? " " + r.data.error.slice(0, 40) : ""}`);
  }
  const claims = await verifyIdToken(r.data.id_token, { clientId: c.servicesId, nonce });
  const refresh = typeof r.data.refresh_token === "string" && r.data.refresh_token.length <= 4096 ? r.data.refresh_token : null;
  return { claims, refresh };
}

const cleanName = (v) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f<>]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) : "");
const isRelay = (email, flag) => !!email && (flag === true || flag === "true" || RELAY_RE.test(email));
/**
 * The verified claims (+ the `user` form field Apple adds the FIRST time only - unsigned, so only a name is taken from it) ->
 * the identity for the shared flow. email = a real address for a new account (never a relay one); contact = whatever Apple gave
 * (display / contact only); relay = it's a private relay address.
 */
function who(claims, userField) {
  const raw = typeof claims.email === "string" && claims.email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email) ? claims.email : null;
  const relay = isRelay(raw, claims.is_private_email);
  const verified = claims.email_verified === true || claims.email_verified === "true";
  let first = "", last = "";
  if (typeof userField === "string" && userField.length <= 4096) {
    try { const u = JSON.parse(userField); const n = u && u.name; if (n && typeof n === "object") { first = cleanName(n.firstName); last = cleanName(n.lastName); } }
    catch (e) { /* not JSON: no name */ }
  }
  const name = [first, last].filter(Boolean).join(" ").slice(0, 64);
  return { provider: "apple", subject: claims.sub, email: relay ? null : raw, email_verified: verified && !relay, contact: raw, relay, name,
           username: first || name || (raw && !relay ? raw.split("@")[0] : ""), handle: null };
}
const shown = (p) => p.name || (p.relay ? "" : p.contact) || "";

// the shared flow's Apple provider ("I already have an account" and a new account link through here)
sso.provider("apple", {
  label: "Apple",
  icon: "",
  readsEmail: true,
  note: "auth.sso.note_apple",
  linkedUser: (subject) => sso.linkedUser("apple", subject),
  async linkTo(user, p) {
    const r = await sso.addLink("apple", user.userId, { subject: p.subject, proof: "oidc", email: p.contact || null, name: p.name || null,
                                                       secret: p.secret || null, relay: !!p.relay });
    await stored(p.subject);
    if (!r.already) await sso.notifyLinked(user, "Apple", shown(p));
  },
});

// ── tables ──
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await sso.init();
      await runQuery("CREATE TABLE IF NOT EXISTS apple_handoff (k TEXT PRIMARY KEY, at INTEGER NOT NULL, data TEXT NOT NULL)");
      await runQuery(`CREATE TABLE IF NOT EXISTS apple_revokes (k TEXT PRIMARY KEY, apple_sub TEXT NOT NULL, token_enc TEXT NOT NULL, why TEXT,
        tries INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, last_error TEXT, created INTEGER NOT NULL)`);
      await runQuery("CREATE INDEX IF NOT EXISTS apple_revokes_sub ON apple_revokes (apple_sub)");
      await runQuery("CREATE TABLE IF NOT EXISTS apple_notices (k TEXT PRIMARY KEY, at INTEGER NOT NULL, type TEXT)");
    })().catch((e) => { ready = null; console.error("[applesso] init:", e.message); throw e; });
  }
  return ready;
}

// ── the callback -> continue hand-off ──
async function putHandoff(data) {
  await init();
  const token = b64url(crypto.randomBytes(32));
  const t = clock();
  await runQuery("DELETE FROM apple_handoff WHERE at < ?", [t - HANDOFF_TTL]);
  await runQuery("INSERT INTO apple_handoff (k, at, data) VALUES (?, ?, ?)", [sha("h:" + token), t, JSON.stringify(data)]);
  return token;
}
/** The hand-off for this token, ONCE (deleted as it's read), or null when unknown / used / older than HANDOFF_TTL. */
async function takeHandoff(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) return null;
  await init();
  const k = sha("h:" + token);
  return tx(async () => {
    const r = (await getQuery("SELECT at, data FROM apple_handoff WHERE k = ?", [k]))[0];
    if (!r) return null;
    const del = await runQuery("DELETE FROM apple_handoff WHERE k = ?", [k]);
    if (!del || !del.changes || clock() - Number(r.at) > HANDOFF_TTL) return null;
    try { return JSON.parse(r.data); } catch (e) { return null; }
  });
}
/** End the cross-site POST: an error code (no row) or the result (a row), then 303 to the same-site GET. */
async function handBack(res, data) {
  let v;
  if (data.err) v = "e." + (ERRS.has(data.err) ? data.err : "failed");
  else v = "t." + (await putHandoff(data));
  res.cookie(HANDOFF_COOKIE, v, cookieOpts(HANDOFF_PATH, "lax", HANDOFF_TTL));
  return res.redirect(303, HANDOFF_PATH);
}

// ── revocation (unlink, account deletion, merge, abandoned sign-ins), through a queue ──
/** Revoke one refresh token at Apple. -> {ok, gone?, retry?, why?} */
async function revokeToken(token) {
  const c = conf.appleClient();
  if (!c) return { ok: false, retry: true, why: "not configured" };
  let r;
  try { r = await http.post(REVOKE_URL, { client_id: c.servicesId, client_secret: clientSecret(c), token: String(token), token_type_hint: "refresh_token" }); }
  catch (e) { return { ok: false, retry: true, why: String(e && e.message || e).slice(0, 80) }; }
  if (r.status === 200) return { ok: true };
  const err = r.data && typeof r.data.error === "string" ? r.data.error.slice(0, 40) : "";
  if (r.status === 400 && err === "invalid_grant") return { ok: true, gone: true };       // already revoked / expired at Apple
  return { ok: false, retry: r.status >= 500 || r.status === 429 || err === "invalid_client", why: `${r.status} ${err}`.trim() };
}
async function queueRevoke(subject, tokenEnc, why, error, { tries = 1, delayMs = RETRY_MS } = {}) {
  await init();
  const t = clock();
  await runQuery(`INSERT INTO apple_revokes (k, apple_sub, token_enc, why, tries, next_at, last_error, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(k) DO NOTHING`, [sha(tokenEnc), String(subject), tokenEnc, String(why || "").slice(0, 40), tries, t + delayMs, String(error || "").slice(0, 120), t]);
}
/**
 * This Apple ID's token is on a link now (linked, or signed in again): whatever of its was waiting to be revoked goes unsent -
 * an abandoned sign-in's token, or an older unlink's that Apple didn't take yet. Revoking would end the authorization the link
 * now relies on (Apple's revoke ends PATV's whole authorization, not one token).
 */
async function stored(subject) {
  if (!subject) return;
  try { await init(); await runQuery("DELETE FROM apple_revokes WHERE apple_sub = ?", [String(subject)]); }
  catch (e) { console.error("[applesso] revoke queue:", e.message); }
}
/**
 * These sso_links rows' Apple tokens ({subject, refresh_token_enc}) -> the revocation queue, due in RETRY_MS. No network: call it
 * INSIDE the transaction that removes the rows (unlink, account deletion), so a restart between the two can't lose a token; then
 * flushQueued(keys) after it tries them at once. -> the queue keys. (init() must have run before the transaction.)
 */
async function queueRows(rows, why) {
  const keys = [];
  for (const row of rows || []) {
    if (!row || !row.refresh_token_enc || !row.subject) continue;
    await queueRevoke(row.subject, row.refresh_token_enc, why, "", { tries: 0, delayMs: RETRY_MS });
    keys.push(sha(row.refresh_token_enc));
  }
  return keys;
}
/** Try these queued revocations now (after the transaction that queued them); what fails stays queued. -> how many Apple took. */
async function flushQueued(keys) {
  let n = 0;
  for (const k of keys || []) {
    const q = (await getQuery("SELECT * FROM apple_revokes WHERE k = ?", [k]))[0];
    if (q && (await attempt(q, clock())) === "revoked") n++;
  }
  return n;
}
/**
 * accountMerge.moveUserRows (inside the merge's transaction, so no network here): when BOTH accounts have Apple linked, the
 * merged-away account's link is folded away (sso_links keeps one per provider and account) - its authorization ends at Apple
 * too, from the retry queue (revokeTick, the next tick). One that moves to the surviving account is kept. -> how many queued.
 */
async function queueDroppedOnMerge(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return 0;
  // (no sso_links table, or one from before the Apple columns: nothing of Apple's to revoke)
  if (!(await getQuery("SELECT name FROM pragma_table_info('sso_links')")).some((c) => c.name === "refresh_token_enc")) return 0;
  const rows = await getQuery("SELECT user_id, subject, refresh_token_enc FROM sso_links WHERE provider = 'apple' AND user_id IN (?, ?)", [String(fromId), String(toId)]);
  const from = rows.find((r) => r.user_id === String(fromId));
  if (!from || !from.refresh_token_enc || !rows.some((r) => r.user_id === String(toId))) return 0;
  await queueRevoke(from.subject, from.refresh_token_enc, "merged away", "", { tries: 0, delayMs: 0 });
  return 1;
}
/**
 * One queued revocation -> "revoked" | "dropped" (its Apple ID is linked again: unsent) | "retry" (backing off: 5 min, then
 * 5 min x 2^tries, at most a day) | "given up" (Apple refused it for good, it can't be decrypted, or REVOKE_MAX_TRIES).
 */
async function attempt(q, t) {
  const drop = () => runQuery("DELETE FROM apple_revokes WHERE k = ?", [q.k]);
  // linked again by now (the same Apple ID linked or signed in since - or, for an unused sign-in's token, it was the sign-in of a
  // linked Apple ID): that link's authorization is live, and revoking this older token would end it too
  if (await sso.linkBySubject("apple", q.apple_sub)) { await drop(); return "dropped"; }
  let token;
  try { token = decryptToken(q.token_enc, q.apple_sub); }
  catch (e) {
    await drop();
    console.error(`[applesso] revoke (${q.why}): the stored token can't be decrypted (SECRET_KEY changed?) - dropped`);
    return "given up";
  }
  const r = await revokeToken(token);
  if (r.ok) { await drop(); return "revoked"; }
  const tries = Number(q.tries) + 1;
  if (!r.retry || tries >= REVOKE_MAX_TRIES) {
    await drop();
    console.error(`[applesso] revoke (${q.why}) given up after ${tries} tr${tries === 1 ? "y" : "ies"}: ${r.why}`);
    return "given up";
  }
  console.error(`[applesso] revoke (${q.why}): ${r.why} - queued`);
  await runQuery("UPDATE apple_revokes SET tries = ?, next_at = ?, last_error = ? WHERE k = ?",
                 [tries, t + (tries <= 1 ? RETRY_MS : Math.min(RETRY_MS * 2 ** tries, 86400e3)), String(r.why || "").slice(0, 120), q.k]);
  return "retry";
}
/** The queue's due rows (attempt each); also sweeps the hand-offs nobody came back for and the old notification records. */
async function revokeTick({ limit = 20 } = {}) {
  await init();
  const t = clock();
  // (a used hand-off is deleted as it's read; an abandoned one's token is revoked from the queue - see the callback)
  await runQuery("DELETE FROM apple_handoff WHERE at < ?", [t - HANDOFF_TTL]);
  await runQuery("DELETE FROM apple_notices WHERE k LIKE 'n:%' AND at < ?", [t - NOTICE_KEEP_MS]);
  const due = await getQuery("SELECT * FROM apple_revokes WHERE next_at <= ? ORDER BY next_at LIMIT ?", [t, limit]);
  let done = 0;
  for (const q of due) if ((await attempt(q, t)) === "revoked") done++;
  return done;
}

// ── server-to-server notifications ──
const NOTICE = {
  removed: { "consent-revoked": "auth.apple.revoked_body", "account-deleted": "auth.apple.deleted_body" },
  kept: "auth.apple.revoked_kept_body",
  renewed: "auth.apple.revoked_renewed_body",
};
/** Apple's event_time (seconds or milliseconds) -> ms, never later than the notification was issued (iat, whole seconds); that
 *  when it's missing. */
function eventMs(v, iatMs) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return iatMs + 999;
  return Math.min(n < 1e11 ? n * 1000 : n, iatMs + 999);
}
/**
 * A notification's JWS -> what was done. Throws Bad on a bad signature / issuer / audience / shape, or one issued more than
 * NOTICE_MAX_AGE_MS ago (E_STALE). Each notification is applied ONCE (apple_notices, by its jti): Apple's retries and a replay of
 * a captured one find it done. Everything is measured against Apple's event time (events.event_time, else iat):
 *   consent-revoked  the member stopped using Sign in with Apple with PATV (Apple: "treat it as a sign-out"): the sessions signed
 *                    in with Apple before the event end and the link goes - unless Apple is the account's only way in (the
 *                    last-method guard, as for an unlink): then the link stays, without Apple's (now dead) token, so signing in
 *                    with Apple again still reaches this account and nobody is locked out of it
 *   account-deleted  the Apple Account is gone for good (its sub never comes back): sessions end and the link goes, always.
 *                    (Apple's documented name; "account-delete" is accepted as the same thing)
 *   email-disabled / email-enabled   the relay address's contact flag (sso_links.email_off); an older event never overrides a
 *                    newer one (sso_links.email_event_at)
 * Linked, or signed in with Apple (a new token, sso_links.token_at), AFTER the event = a new authorization: the link and its
 * token stay, and only the Apple sessions from before the event end.
 */
async function onNotification(payload, { now = clock(), getKey = keyFor } = {}) {
  const c = conf.appleClient();
  if (!c) throw new Bad("E_OFF");
  const claims = await verifyJwt(payload, { audiences: [appId(), c.servicesId].filter(Boolean), idToken: false, now, getKey });
  const iatMs = Number(claims.iat) * 1000;
  if (now - iatMs > NOTICE_MAX_AGE_MS) throw new Bad("E_STALE");
  let ev = claims.events;
  if (typeof ev === "string") { try { ev = JSON.parse(ev); } catch (e) { throw new Bad("E_FORMAT"); } }
  if (!ev || typeof ev !== "object") throw new Bad("E_FORMAT");
  const type = String(ev.type || "").slice(0, 40);
  const kind = type === "account-delete" ? "account-deleted" : type;
  const sub = typeof ev.sub === "string" ? ev.sub : "";
  if (!SUB_RE.test(sub)) throw new Bad("E_SUB");
  const evMs = eventMs(ev.event_time, iatMs);
  const jti = typeof claims.jti === "string" && claims.jti ? claims.jti.slice(0, 200) : "";
  const key = "n:" + sha(jti ? "jti:" + jti : ["ev", sub, kind, claims.iat, ev.event_time].join("|"));
  await init();
  if ((await getQuery("SELECT 1 AS x FROM apple_notices WHERE k = ?", [key]))[0]) return { ok: true, type: kind, duplicate: true };
  // recorded in the transaction that applies it (a failure leaves it unrecorded, so Apple's retry applies it); false = it was
  // applied meanwhile (two deliveries at once)
  const mark = async () => { const r = await runQuery("INSERT OR IGNORE INTO apple_notices (k, at, type) VALUES (?, ?, ?)", [key, now, kind]); return !!(r && r.changes); };
  const link = await sso.linkBySubject("apple", sub);
  const skewMs = SKEW_S * 1000;

  if (kind === "consent-revoked" || kind === "account-deleted") {
    // Apple ended the authorization: its queued revocations from before the event have nothing left to revoke
    const dropQueued = () => runQuery("DELETE FROM apple_revokes WHERE apple_sub = ? AND created <= ?", [sub, evMs + skewMs]);
    if (!link) {
      let applied = false;
      await tx(async () => { if (await mark()) { applied = true; await dropQueued(); } });
      return applied ? { ok: true, type: kind, unlinked: false } : { ok: true, type: kind, duplicate: true };
    }
    const since = Math.max(Number(link.linked_at) || 0, Number(link.token_at) || 0);
    const renewed = since > evMs;
    // the sessions signed in with Apple up to the event (+ the clock skew; never the one a later Apple sign-in made)
    const cut = renewed ? Math.min(evMs + skewMs, since - 1) : evMs + skewMs;
    let applied = false, unlinked = false, dropped = false, keep = false, ended = 0;
    await tx(async () => {
      if (!(await mark())) return;
      applied = true;
      await dropQueued();
      // consent-revoked: the last-method guard decides keep (Apple is the only way in) vs unlink - checked HERE, in the
      // transaction that makes the change (like ssolinks.unlinkGuarded), so a Google / Telegram / Plex unlink at the same moment
      // can't also pass it and leave the account with no way in
      if (!renewed && kind === "consent-revoked") {
        try { await sso.guardUnlink(link.user_id, "apple"); }
        catch (e) { if (e && e.code === "E_LAST_METHOD") keep = true; else throw e; }
      }
      if (!renewed && keep) {
        const r = await runQuery("UPDATE sso_links SET refresh_token_enc = NULL WHERE provider = 'apple' AND subject = ? AND COALESCE(token_at, 0) <= ?", [sub, evMs]);
        dropped = !!(r && r.changes);
      } else if (!renewed) {
        // (the conditions again: a link / Apple sign-in made since the read above is a new authorization and stays)
        const r = await runQuery("DELETE FROM sso_links WHERE provider = 'apple' AND subject = ? AND linked_at <= ? AND COALESCE(token_at, 0) <= ?", [sub, evMs, evMs]);
        unlinked = !!(r && r.changes);
      }
      ended = await require("./sessions").revokeMethod(link.user_id, "apple", kind === "account-deleted" ? "apple account deleted" : "apple sign-in revoked",
                                                       { before: cut });
    });
    if (!applied) return { ok: true, type: kind, duplicate: true };
    const state = unlinked ? "removed" : !renewed && keep && dropped ? "kept" : "renewed";
    try { require("./verified").forget(link.user_id); } catch (e) { /* none */ }
    if (state !== "renewed" || ended) {
      try {
        const I = require("./i18n");
        const t = I.tFor(I.getPref(link.user_id) || "en");
        await require("./inbox").addSafe(link.user_id, { kind: "system", title: t(state === "removed" ? "auth.apple.removed_title" : "auth.apple.signedout_title"),
          body: t(state === "removed" ? NOTICE.removed[kind] : NOTICE[state]), link: "/settings/account#connections",
          ref: `applesso:${kind}:${state}:${sha(sub).slice(0, 16)}:${evMs}` });   // (once per event, even re-sent with a new jti)
      } catch (e) { /* logged there */ }
    }
    console.log(`[applesso] ${kind}: Apple ${state === "removed" ? "unlinked" : state === "kept" ? "kept (the account's only way in), token dropped"
                : "kept (linked / signed in with Apple again since)"} for ${link.user_id}, ${ended} session(s) signed in with Apple ended`);
    return { ok: true, type: kind, unlinked, kept: state === "kept", renewed: state === "renewed", sessions: ended };
  }

  if (kind === "email-disabled" || kind === "email-enabled") {
    const email = typeof ev.email === "string" && ev.email.length <= 254 && ev.email.includes("@") ? ev.email : null;
    let applied = false, updated = false;
    await tx(async () => {
      if (!(await mark())) return;
      applied = true;
      if (!link) return;
      // (an older event delivered late never overrides a newer one)
      const r = await runQuery(`UPDATE sso_links SET email_off = ?, email = COALESCE(?, email), email_relay = CASE WHEN ? IS NULL THEN email_relay ELSE ? END,
                                email_event_at = ? WHERE provider = 'apple' AND subject = ? AND COALESCE(email_event_at, 0) <= ?`,
                               [kind === "email-disabled" ? 1 : 0, email, email, isRelay(email, ev.is_private_email) ? 1 : 0, evMs, sub, evMs]);
      updated = !!(r && r.changes);
    });
    return applied ? { ok: true, type: kind, updated } : { ok: true, type: kind, duplicate: true };
  }
  await mark().catch(() => {});
  return { ok: true, type: kind, ignored: true };
}
let lastRefused = null;     // {at, code}: in memory - a forged POST mustn't cost a database write
/** For the /admin/users#signin card: is APPLE_APP_ID set, the endpoint, the newest accepted / refused notification. */
async function noticeHealth() {
  let lastOk = null;
  try { await init(); const r = (await getQuery("SELECT at, type FROM apple_notices WHERE k = 'last:ok'"))[0]; if (r) lastOk = { at: Number(r.at), type: r.type }; }
  catch (e) { /* none yet */ }
  return { endpoint: notificationsUri(), app_id: !!appId(), last_ok: lastOk, last_refused: lastRefused };
}

const tr = (req, key, en, vars) => (req && typeof req.t === "function" ? req.t(key, vars) : en);
const ERR_TEXT = {
  expired: ["auth.sso.expired", "That sign-in expired or didn't start here. Please try again."],
  cancelled: ["auth.apple.cancelled", "Apple sign-in was cancelled."],
  failed: ["auth.apple.failed", "Apple sign-in didn't work. Please try again."],
  off: ["auth.sso.off", "That sign-in method isn't available right now."],
  slow: ["auth.sso.slow_down", "Too many sign-ins from your network. Try again in a few minutes."],
};

/**
 * The two routes Apple calls cross-site: mount them BEFORE the session middleware (index.js, right after cookie-parser + the
 * sessions gate) so neither mints a session cookie. Each parses its own body.
 */
function registerEarly(app) {
  const express = require("express");
  const form = express.urlencoded({ extended: false, limit: "64kb" });
  const json = express.json({ limit: "64kb", type: ["application/json", "application/*+json"] });

  app.post("/auth/apple/callback", form, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const b = req.body || {};
    const got = typeof b.state === "string" ? b.state : "";
    const isFresh = (s) => !!s && Number(s.at) > 0 && clock() - Number(s.at) <= TTL && Number(s.at) - clock() <= 60e3;
    const isMatch = (s) => isFresh(s) && typeof s.s === "string" && typeof s.n === "string" && same(got, s.s);
    // the SameSite=None state cookie, else its attribute-less twin (older Safari / Chrome - see start)
    const jar = cookiesOf(req);
    const cands = [STATE_COOKIE, STATE_COOKIE_LEGACY].map((n) => { try { return openState(jar[n]); } catch (e) { return null; } });
    const st = cands.find(isMatch) || cands.find(isFresh) || null;
    const fresh = isFresh(st), matched = isMatch(st);
    // The state cookie is this browser's sign-in in progress. A POST that doesn't carry its state (another site's auto-submitted
    // form - the SameSite=None cookie rides along - or an old tab) leaves it alone, so it can't cancel the real one; an unusable
    // cookie (expired, tampered, none) is cleared. Both twins go together.
    if (matched || !fresh) {
      res.clearCookie(STATE_COOKIE, cookieOpts(STATE_PATH, "none"));
      res.clearCookie(STATE_COOKIE_LEGACY, cookieOpts(STATE_PATH, undefined));
    }
    try {
      if (!matched) return handBack(res, { err: "expired" });
      const link = st.m === "link";
      const base = { mode: link ? "link" : "signin", uid: link ? String(st.u || "") : null, next: link ? "" : guard.safeNext(st.x) || "" };
      // only a callback that matched its state counts against the network (the limit guards the token exchange): another
      // site's forms can't use it up and lock this network out of Apple sign-in
      const ip = guard.clientIp(req);
      if (callbackLimit.blocked(ip)) return handBack(res, { err: "slow" });
      callbackLimit.hit(ip);
      if (!(await sso.useOnce("apple-state:" + sha(st.s), TTL))) return handBack(res, { err: "expired" });          // replayed
      if (typeof b.error === "string" && b.error) return handBack(res, { err: b.error === "user_cancelled_authorize" ? "cancelled" : "failed" });
      await conf.init().catch(() => {});
      if (!enabled()) return handBack(res, { err: "off" });
      if (typeof b.code !== "string" || !b.code || b.code.length > 2048) return handBack(res, { err: "failed" });
      let tok;
      try { tok = await exchange(b.code, st.n); }
      catch (e) { console.error("[applesso] verify:", e && (e.code || e.message)); return handBack(res, { err: "failed" }); }
      const w = who(tok.claims, b.user);
      w.secret = tok.refresh ? encryptToken(tok.refresh, w.subject) : null;
      // Apple's token waits in the revocation queue until it lands on a link (stored()): a sign-in nobody finishes - the hand-off
      // never collected, an identity parked for /auth/sso/new and abandoned or cancelled - ends PATV's authorization at Apple
      // after UNUSED_MS instead of leaving it live (attempt() drops it unsent if that Apple ID is linked by then)
      if (w.secret) await queueRevoke(w.subject, w.secret, "unused", "", { tries: 0, delayMs: UNUSED_MS });
      return handBack(res, Object.assign(base, { who: w }));
    } catch (e) {
      console.error("[applesso] callback:", e && e.message);
      return handBack(res, { err: "failed" }).catch(() => res.redirect(303, "/login"));
    }
  });

  app.post("/auth/apple/notifications", json, form, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const b = req.body || {};
    const payload = typeof b.payload === "string" ? b.payload : "";
    if (!payload) return res.status(400).json({ ok: false, error: "no payload" });
    try {
      const r = await onNotification(payload);
      // the newest one Apple got through with (the admin card): only signed ones get this far
      runQuery(`INSERT INTO apple_notices (k, at, type) VALUES ('last:ok', ?, ?) ON CONFLICT(k) DO UPDATE SET at = excluded.at, type = excluded.type`,
               [clock(), String(r.type || "").slice(0, 40)]).catch(() => {});
      return res.json({ ok: true, type: r.type });
    } catch (e) {
      if (e instanceof Bad) {
        console.error(`[applesso] notification refused: ${e.code}${e.code === "E_AUD" && !appId() ? " (APPLE_APP_ID isn't set - Apple names the primary App ID as the audience)" : ""}`);
        if (e.code !== "E_OFF") lastRefused = { at: clock(), code: e.code };
        return res.status(e.code === "E_OFF" ? 404 : 400).json({ ok: false, error: e.code });
      }
      console.error("[applesso] notification:", e && e.message);
      return res.status(500).json({ ok: false });
    }
  });
}

function register(app, { addUser, noTimers = false }) {
  conf.init().catch(() => {});
  init().catch(() => {});
  // the client secret is made at boot (and the key checked) - never logged
  try {
    if (conf.appleConfigured()) {
      clientSecret();
      console.log(`[applesso] Sign in with Apple configured (return URL ${redirectUri()}, notifications ${notificationsUri()})`);
      if (!appId()) {
        console.warn("[applesso] APPLE_APP_ID is not set: Apple's server-to-server notifications (consent-revoked, account-deleted, email) name " +
                     "the primary App ID as their audience and will be refused - set it to that App ID's bundle id");
      }
    }
  } catch (e) { console.error("[applesso] client secret:", e.message); }
  if (!noTimers) {
    const iv = setInterval(() => { revokeTick().catch((e) => console.error("[applesso] revoke tick:", e.message)); }, 10 * 60 * 1000);
    if (iv.unref) iv.unref();
  }
  const fail = (req, res, err, back) => { const [k, en] = ERR_TEXT[err] || ERR_TEXT.failed; req.flash("error", tr(req, k, en)); return res.redirect(back || "/login"); };

  async function start(req, res, mode) {
    res.set("Cache-Control", "no-store");
    await conf.init().catch(() => {});
    const back = mode === "link" ? ACCOUNT_PAGE : "/login";
    if (!enabled()) return fail(req, res, "off", back);
    // only a top-level navigation from this site (or a typed / bookmarked address) starts a sign-in: another site's image, frame
    // or link can't mint state cookies in the visitor's browser or use up their network's start limit (it lands on /login)
    const dest = String(req.get("sec-fetch-dest") || ""), from = String(req.get("sec-fetch-site") || "");
    if (mode !== "link" && ((dest && dest !== "document") || from === "cross-site")) return res.redirect("/login");
    // the state cookie is per host: start on the host Apple will send them back to
    try { const s = new URL(site()); if (mode !== "link" && req.get("host") && s.host !== req.get("host")) return res.redirect(s.origin + req.originalUrl); }
    catch (e) { /* bad config: carry on */ }
    const ip = guard.clientIp(req);
    if (startLimit.blocked(ip)) return fail(req, res, "slow", back);
    startLimit.hit(ip);
    const st = { s: crypto.randomBytes(24).toString("hex"), n: b64url(crypto.randomBytes(24)), at: clock(), m: mode,
                 u: mode === "link" ? String(req.user.userId) : null, x: mode === "link" ? "" : guard.safeNext(req.query.next) || "" };
    const sealed = sealState(st);
    res.cookie(STATE_COOKIE, sealed, cookieOpts(STATE_PATH, "none", TTL));
    // its twin with NO SameSite attribute: Safari on iOS 12 / macOS 10.14 (WebKit bug 198181) treats SameSite=None as Strict, so
    // the cookie above never rides Apple's cross-site POST there, and Chrome 51-66 drops a SameSite=None cookie altogether - those
    // browsers do send an attribute-less cookie cross-site, and the callback reads the twin when the first is missing. Browsers
    // that default to Lax just don't send the twin (the callback clears both). Same value, MAC, flags, path and lifetime.
    res.cookie(STATE_COOKIE_LEGACY, sealed, cookieOpts(STATE_PATH, undefined, TTL));
    const q = [["client_id", conf.appleClient().servicesId], ["redirect_uri", redirectUri()], ["response_type", "code"], ["scope", "name email"],
               ["response_mode", "form_post"], ["state", st.s], ["nonce", st.n]];
    return res.redirect(AUTH_URL + "?" + q.map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&"));
  }

  app.get("/auth/apple", addUser, (req, res) => {
    if (req.user && req.user.username) return res.redirect(ACCOUNT_PAGE);
    return start(req, res, "signin");
  });
  app.post("/auth/apple/link", addUser, (req, res) => {
    if (!guard.sameSite(req)) return res.status(403).send("Cross-site request refused");
    if (!req.user || !req.user.userId) return res.redirect("/login");
    return start(req, res, "link");
  });

  app.get(HANDOFF_PATH, addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const raw = String((req.cookies && req.cookies[HANDOFF_COOKIE]) || "");
    res.clearCookie(HANDOFF_COOKIE, cookieOpts(HANDOFF_PATH, "lax"));
    const signedIn = !!(req.user && req.user.userId);
    if (raw.startsWith("e.")) return fail(req, res, ERRS.has(raw.slice(2)) ? raw.slice(2) : "failed", signedIn ? ACCOUNT_PAGE : "/login");
    let h = null;
    try { h = raw.startsWith("t.") ? await takeHandoff(raw.slice(2)) : null; } catch (e) { console.error("[applesso] hand-off:", e.message); }
    if (!h || !h.who) return fail(req, res, "expired", signedIn ? ACCOUNT_PAGE : "/login");
    await conf.init().catch(() => {});
    if (!enabled()) return fail(req, res, "off", signedIn ? ACCOUNT_PAGE : "/login");
    const w = h.who;
    try {
      if (h.mode === "link") {
        if (!signedIn || String(req.user.userId) !== String(h.uid)) return fail(req, res, "expired", "/login");
        try {
          const r = await sso.addLink("apple", req.user.userId, { subject: w.subject, proof: "oidc", email: w.contact || null, name: w.name || null,
                                                                 secret: w.secret || null, relay: !!w.relay });
          await stored(w.subject);
          if (!r.already) await sso.notifyLinked(req.user, "Apple", shown(w));
          req.flash("success", tr(req, "settings.connections.apple_linked", "Apple is linked. You can sign in with it now."));
        } catch (e) {
          if (!e.refuse) throw e;
          req.flash("error", e.message);
        }
        return res.redirect(ACCOUNT_PAGE);
      }
      if (req.user && req.user.username) return res.redirect(ACCOUNT_PAGE);
      // already linked: keep Apple's newest refresh token (revoked on unlink; token_at = this new authorization) and what it says
      // about the email now
      if (w.secret || w.contact) {
        const u = await runQuery(`UPDATE sso_links SET refresh_token_enc = COALESCE(?, refresh_token_enc), token_at = CASE WHEN ? IS NULL THEN token_at ELSE ? END,
                                  email = COALESCE(?, email), email_relay = CASE WHEN ? IS NULL THEN email_relay ELSE ? END WHERE provider = 'apple' AND subject = ?`,
                                 [w.secret || null, w.secret || null, clock(), w.contact || null, w.contact || null, w.relay ? 1 : 0, w.subject])
          .catch((e) => { console.error("[applesso] token update:", e.message); return null; });
        if (u && u.changes && w.secret) await stored(w.subject);
      }
      return res.redirect(await sso.signInOrPark(req, res, w, h.next));
    } catch (e) {
      console.error("[applesso] continue:", e && e.message);
      return fail(req, res, "failed", signedIn ? ACCOUNT_PAGE : "/login");
    }
  });

  app.post("/api/sso/apple/unlink", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!guard.sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      if (!(await sso.linkOf("apple", req.user.userId))) return res.json({ ok: true, removed: false });
      await init();
      // the last-method guard, the link going and its token joining the revocation queue: ONE transaction (another unlink at the
      // same moment can't also pass the guard; a restart before Apple answers can't lose the token); then PATV's authorization
      // ends at Apple too - the member's choice wins even when Apple is down (retried)
      let removed = false, keys = [];
      await sso.unlinkGuarded(req.user.userId, "apple", async () => {
        const l = await sso.linkOf("apple", req.user.userId);
        removed = !!l && (await sso.removeLink("apple", req.user.userId));
        if (removed) keys = await queueRows([l], "unlinked");
      });
      try { require("./verified").forget(req.user.userId); } catch (e) { /* none */ }
      const revoked = keys.length ? await flushQueued(keys).catch((e) => { console.error("[applesso] unlink revoke:", e.message); return 0; }) : 0;
      res.json({ ok: true, removed, revoked: revoked > 0 });
    } catch (e) {
      if (e && e.refuse) return res.status(e.status).json({ ok: false, error: e.message, code: e.code });
      console.error("[applesso] unlink:", e && e.message);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });
}

module.exports = {
  register, registerEarly, init, enabled, redirectUri, notificationsUri, verifyIdToken, verifyJwt, clientSecret, who, exchange, onNotification,
  noticeHealth, revokeToken, revokeTick, queueRows, flushQueued, queueDroppedOnMerge, encryptToken, decryptToken, sealState, openState,
  ISSUER, TTL, HANDOFF_TTL, UNUSED_MS, NOTICE_MAX_AGE_MS, STATE_COOKIE, STATE_COOKIE_LEGACY, HANDOFF_COOKIE,
  _setHttp: (h) => { http = h; jwks = { keys: new Map(), until: 0, fetchedAt: 0 }; },
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _resetSecret: () => { secretMemo = { fp: "", jwt: "", exp: 0 }; },
};
