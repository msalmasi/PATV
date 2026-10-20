// Offline tests for Sign in with Apple (applesso.js) on the shared SSO flow (ssolinks.js): config + the ES256 client secret,
// ID token verification, the cross-site form_post callback (its SameSite=None state cookie, no session minted there, the
// same-site hand-off), state / nonce / replay, first-authorization-only name + email, private relay addresses (contact
// only), "I already have an account", Settings -> Account link / unlink with revocation at Apple (+ the retry queue) and
// the last-method guard, and Apple's server-to-server notifications. Apple is a stub; nothing leaves the process.
//   NODE_PATH=G:/PATV/node_modules node --test test/applesso.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "applesso-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.SENDGRID_API_KEY;
delete process.env.MEDIACTL_URL;
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.APPLE_APP_ID;
process.env.SECRET_KEY = "test-secret";
process.env.APP_SESSION_SECRET = "test-session-secret";

// ── the Apple developer account (generated keys - never a real .p8) ──
const SERVICES = "tv.publicaccess.test.signin";
const TEAM = "TEAM123456";
const KEY_ID = "KEY1234567";
const p8 = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const P8_PEM = p8.privateKey.export({ type: "pkcs8", format: "pem" });
const setAppleEnv = () => {
  process.env.APPLE_SERVICES_ID = SERVICES;
  process.env.APPLE_TEAM_ID = TEAM;
  process.env.APPLE_KEY_ID = KEY_ID;
  process.env.APPLE_PRIVATE_KEY = Buffer.from(P8_PEM).toString("base64");
};
setAppleEnv();

const express = require("express");
const session = require("express-session");
const flash = require("connect-flash");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { runQuery, getQuery, tx } = require(path.join(repo, "dbUtils"));
const SSO = require(path.join(repo, "ssolinks"));
const CONF = require(path.join(repo, "ssoconf"));
const AS = require(path.join(repo, "applesso"));
const UC = require(path.join(repo, "user.controller"));
const SESS = require(path.join(repo, "sessions"));
require(path.join(repo, "terms"))._setRequired && require(path.join(repo, "terms"))._setRequired(false);

let T = Date.now();
AS._setClock(() => T);
SSO._setClock(() => T);
SESS._setClock(() => T);          // session rows' created on the same clock (Apple's event times are compared with it)
const nowS = () => Math.floor(T / 1000);
const b64u = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

// ── Apple's signing key (JWKS) + ID tokens / notification JWS ──
const appleKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "apple-kid-1";
const jwk = { ...appleKey.publicKey.export({ format: "jwk" }), kid: KID, use: "sig", alg: "RS256" };
function signJwt(claims, { key = appleKey.privateKey, kid = KID, alg = "RS256" } = {}) {
  const h = b64u(JSON.stringify({ alg, kid }));
  const p = b64u(JSON.stringify(claims));
  const sig = alg === "RS256" ? crypto.sign("RSA-SHA256", Buffer.from(h + "." + p), key) : Buffer.from("x");
  return `${h}.${p}.${b64u(sig)}`;
}
const idClaims = (o) => ({ iss: "https://appleid.apple.com", aud: SERVICES, iat: nowS(), exp: nowS() + 600, sub: "000111.aaa.0001",
                           nonce: "n-1", nonce_supported: true, email: "ann@example.test", email_verified: "true", is_private_email: "false", ...o });

// ── the stub of appleid.apple.com ──
const APPLE = { codes: new Map(), tokenCalls: [], revokes: [], revokeStatus: 200, revokeError: null, jwksCalls: 0, revokeHook: null };
/** Apple checks the client secret: ES256 by the .p8's public key, kid, iss Team ID, sub Services ID, aud, exp. */
function clientSecretOk(s) {
  const [h, p, sig] = String(s || "").split(".");
  if (!sig) return false;
  const head = JSON.parse(unb64u(h)), c = JSON.parse(unb64u(p));
  const okSig = crypto.verify("sha256", Buffer.from(h + "." + p), { key: p8.publicKey, dsaEncoding: "ieee-p1363" }, unb64u(sig));
  return okSig && head.alg === "ES256" && head.kid === KEY_ID && c.iss === TEAM && c.sub === SERVICES && c.aud === "https://appleid.apple.com" &&
         c.exp > nowS() && c.exp - c.iat <= 15777000;
}
AS._setHttp({
  async get(url) {
    if (url === "https://appleid.apple.com/auth/keys") { APPLE.jwksCalls++; return { status: 200, data: { keys: [jwk] }, headers: { "cache-control": "public, max-age=3600" } }; }
    return { status: 404, data: null, headers: {} };
  },
  async post(url, form) {
    if (url === "https://appleid.apple.com/auth/token") {
      APPLE.tokenCalls.push(form);
      const c = APPLE.codes.get(form.code);
      if (!clientSecretOk(form.client_secret)) return { status: 400, data: { error: "invalid_client" }, headers: {} };
      if (!c || form.client_id !== SERVICES || form.grant_type !== "authorization_code" || form.redirect_uri !== base + "/auth/apple/callback") {
        return { status: 400, data: { error: "invalid_grant" }, headers: {} };
      }
      APPLE.codes.delete(form.code);   // a code is single use at Apple too
      return { status: 200, data: { access_token: "a.unused", token_type: "Bearer", expires_in: 3600, refresh_token: c.refresh,
                                    id_token: signJwt(idClaims({ ...c.claims, nonce: c.nonce }), c.sign || {}) }, headers: {} };
    }
    if (url === "https://appleid.apple.com/auth/revoke") {
      APPLE.revokes.push(form);
      if (APPLE.revokeHook) await APPLE.revokeHook(form);
      if (!clientSecretOk(form.client_secret) || form.client_id !== SERVICES) return { status: 400, data: { error: "invalid_client" }, headers: {} };
      return APPLE.revokeStatus === 200 ? { status: 200, data: "", headers: {} }
                                        : { status: APPLE.revokeStatus, data: { error: APPLE.revokeError || "server_error" }, headers: {} };
    }
    return { status: 404, data: null, headers: {} };
  },
});

let base, server;
const PASSWORD = "correct horse battery 9";
async function mkUser(name, o = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, email, isEmailVerified)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, name, name, await bcrypt.hash(PASSWORD, 4), o.cls || "pleb", o.email || null, o.verified ? 1 : 0]);
  return { userId: id, username: name, class: o.cls || "pleb" };
}

/** A browser with a cookie jar that keeps Path and SameSite: a CROSS-SITE POST (Apple's form_post) carries only
 *  SameSite=None cookies, like a real browser (a cookie without the attribute is Lax by default: not sent); everything else
 *  carries the cookies for the path. legacy: Safari on iOS 12 / macOS 10.14 (WebKit bug 198181) - SameSite=None is taken as
 *  Strict (never sent cross-site) while a cookie without the attribute IS sent cross-site. */
function browser(ip, { legacy = false } = {}) {
  const jar = new Map();   // name -> {v, path, sameSite ("unset" = no attribute)}
  const crossOk = (c) => (legacy ? c.sameSite === "unset" : c.sameSite === "none");
  const cookieHeader = (p, cross) => [...jar].filter(([, c]) => p.startsWith(c.path) && (!cross || crossOk(c)))
    .map(([k, c]) => `${k}=${c.v}`).join("; ");
  async function go(method, p, body, { json = false, cross = false, headers: extra = {} } = {}) {
    const pathname = new URL(base + p).pathname;
    const headers = { "cf-connecting-ip": ip, cookie: cookieHeader(pathname, cross && method !== "GET"), ...extra };
    if (cross) { headers.origin = "https://appleid.apple.com"; headers.referer = "https://appleid.apple.com/"; }
    let payload;
    if (json) { headers["content-type"] = "application/json"; headers["x-requested-with"] = "fetch"; payload = JSON.stringify(body || {}); }
    else if (body) { headers["content-type"] = "application/x-www-form-urlencoded"; payload = new URLSearchParams(body).toString(); }
    const r = await fetch(base + p, { method, headers, body: payload, redirect: "manual" });
    const setCookie = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    for (const c of setCookie) {
      const [kv, ...attrs] = c.split(";").map((s) => s.trim());
      const i = kv.indexOf("=");
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      const a = Object.fromEntries(attrs.map((x) => { const j = x.indexOf("="); return j < 0 ? [x.toLowerCase(), true] : [x.slice(0, j).toLowerCase(), x.slice(j + 1)]; }));
      if (!v || /Expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(k);
      else jar.set(k, { v, path: a.path || "/", sameSite: String(a.samesite || "unset").toLowerCase() });
    }
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) { /* html */ }
    return { status: r.status, location: r.headers.get("location") || "", text, json: j, setCookie };
  }
  return {
    jar, go,
    get: (p) => go("GET", p),
    post: (p, b) => go("POST", p, b || {}),
    api: (p, b) => go("POST", p, b || {}, { json: true }),
    who: () => { const t = jar.get("jwt"); if (!t) return null; try { return jwt.verify(decodeURIComponent(t.v), process.env.SECRET_KEY).username; } catch (e) { return null; } },
  };
}
const flashText = async (b) => (await b.get("/login")).text;
let seq = 0;

/** Start a sign-in (GET /auth/apple) or a link (POST /auth/apple/link) -> the authorize request's state + nonce. */
async function appleStart(b, { link = false } = {}) {
  const s = link ? await b.post("/auth/apple/link") : await b.get("/auth/apple");
  assert.equal(s.status, 302, s.text);
  assert.match(s.location, /^https:\/\/appleid\.apple\.com\/auth\/authorize\?/);
  const q = new URL(s.location).searchParams;
  return { state: q.get("state"), nonce: q.get("nonce"), q, start: s };
}
/** Apple's answer: a cross-site form POST to the callback (code, state and, the first time only, the `user` JSON). */
async function appleReturn(b, st, claims, { user = null, refresh = "r-apple-" + (++seq), code = "c-" + (++seq), sign } = {}) {
  APPLE.codes.set(code, { nonce: st.nonce, claims, refresh, sign });
  const body = { state: st.state, code };
  if (user) body.user = JSON.stringify(user);
  return b.go("POST", "/auth/apple/callback", body, { cross: true });
}
async function appleSignIn(b, claims, o = {}) {
  const st = await appleStart(b, o);
  const cb = await appleReturn(b, st, claims, o);
  assert.equal(cb.status, 303); assert.equal(cb.location, "/auth/apple/continue");
  const cont = await b.get("/auth/apple/continue");
  return { st, cb, cont };
}
function notification(type, sub, o = {}) {
  return signJwt({ iss: "https://appleid.apple.com", aud: SERVICES, iat: nowS(), jti: "jti-" + (++seq),
                   events: JSON.stringify({ type, sub, event_time: T, ...(o.events || {}) }), ...(o.claims || {}) }, o.sign || {});
}
async function notify(payload, { raw = null } = {}) {
  const r = await fetch(base + "/auth/apple/notifications", { method: "POST", headers: { "content-type": "application/json" },
                                                             body: raw != null ? raw : JSON.stringify({ payload }) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, avatar TEXT, email TEXT UNIQUE, isEmailVerified INTEGER DEFAULT 0,
                  emailVerificationToken TEXT, tokenExpires DATETIME, camfrogUsername TEXT, discordId TEXT, twitchId TEXT, casino_banned INTEGER DEFAULT 0,
                  archived_at INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery("CREATE TABLE IF NOT EXISTS badges (badgeId TEXT PRIMARY KEY, points INTEGER)");
  await runQuery("CREATE TABLE IF NOT EXISTS user_badges (userId TEXT, badgeId TEXT, awardedAt DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (userId, badgeId))");
  await runQuery("CREATE TABLE IF NOT EXISTS levelup_rewards (userId TEXT, level INTEGER, amount INTEGER, paid INTEGER DEFAULT 0, PRIMARY KEY (userId, level))");
  await runQuery("CREATE TABLE IF NOT EXISTS levelup_milestones (userId TEXT, level INTEGER, amount INTEGER, paid INTEGER DEFAULT 0, paid_at DATETIME, PRIMARY KEY (userId, level))");
  await runQuery("CREATE TABLE IF NOT EXISTS feed_bans (user_id TEXT, room_id TEXT, until INTEGER)");
  await runQuery("INSERT OR IGNORE INTO badges (badgeId, points) VALUES ('fresh_meat', 50)");
  await SSO.init();
  await CONF.init();
  await AS.init();

  const app = express();
  app.use(cookieParser());
  // like index.js: Apple's two cross-site routes BEFORE the session middleware (they parse their own bodies)
  AS.registerEarly(app);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(session({ secret: process.env.APP_SESSION_SECRET, resave: true, saveUninitialized: true, cookie: { secure: "auto" } }));
  app.use(flash());
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  const addUser = (req, res, next) => {
    try { req.user = req.cookies.jwt ? jwt.verify(req.cookies.jwt, process.env.SECRET_KEY) : null; } catch (e) { req.user = null; }
    next();
  };
  const authView = (req, extra) => Object.assign({ user: req.user ? req.user.username : null, errors: req.flash("error"), success: req.flash("success"),
    form: (() => { try { return JSON.parse(req.flash("authForm").slice(-1)[0] || "{}"); } catch (e) { return {}; } })(), next: "",
    plexSso: false, tgSso: null, googleSso: false, appleSso: AS.enabled() }, extra || {});
  app.get("/login", addUser, (req, res) => {
    const sp = SSO.pendingFor(req);
    res.render("login", authView(req, sp ? { ssoPending: { provider: sp.provider, label: SSO.PROVIDERS[sp.provider].label, who: sp.handle ? "@" + sp.handle : sp.name } } : null));
  });
  app.get("/register", addUser, (req, res) => res.render("register", authView(req)));
  app.get("/settings/account", addUser, (req, res) => res.send("account " + JSON.stringify({ errors: req.flash("error"), success: req.flash("success") })));
  app.post("/login", UC.loginUser);
  SSO.register(app, { addUser, authView });
  AS.register(app, { addUser, noTimers: true });
  require(path.join(repo, "googlesso")).register(app, { addUser });   // its unlink (the concurrent-unlink test)
  CONF.register(app, { addUser });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_BASE_URL = base;
});
test.after(() => { server && server.close(); });

// ───────────────────────── config + the client secret ─────────────────────────
test("config: hidden until all four APPLE_* values are set and the key is an EC P-256 key; the switch; status never shows the key", async () => {
  assert.equal(AS.enabled(), true);
  assert.deepEqual(CONF.status().apple, { switch: true, configured: true, on: true });
  let page = await browser("10.9.0.1").get("/login");
  assert.match(page.text, /class="au-oauth apple" href="\/auth\/apple"/);
  assert.match(page.text, /Sign in with Apple/);
  assert.match((await browser("10.9.0.1").get("/register")).text, /Sign up with Apple/);
  for (const k of ["APPLE_SERVICES_ID", "APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY"]) {
    const v = process.env[k];
    delete process.env[k];
    assert.equal(AS.enabled(), false, "missing " + k);
    process.env[k] = v;
  }
  // a raw PEM (\n-escaped) works too; an RSA key, a short value or a bad Team ID doesn't
  process.env.APPLE_PRIVATE_KEY = P8_PEM.replace(/\n/g, "\\n");
  assert.equal(AS.enabled(), true, "raw PEM with \\n escapes");
  process.env.APPLE_PRIVATE_KEY = Buffer.from(otherKey.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
  assert.equal(AS.enabled(), false, "an RSA key can't sign ES256");
  process.env.APPLE_PRIVATE_KEY = "bm90IGEga2V5".repeat(10);
  assert.equal(AS.enabled(), false, "not a key");
  setAppleEnv();
  process.env.APPLE_TEAM_ID = "team12345";
  assert.equal(AS.enabled(), false, "a Team ID is 10 upper-case letters / digits");
  setAppleEnv();
  assert.equal(AS.enabled(), true);
  page = await browser("10.9.0.1").get("/login");
  assert.ok(!page.text.includes(process.env.APPLE_PRIVATE_KEY.slice(0, 40)) && !page.text.includes(TEAM), "never the key or the Team ID in a page");
  assert.ok(!JSON.stringify(CONF.status()).includes(process.env.APPLE_PRIVATE_KEY.slice(0, 40)));
  // the switch: off hides it even when configured
  await CONF.set({ apple_sso: false }, "test");
  assert.equal(AS.enabled(), false);
  assert.doesNotMatch((await browser("10.9.0.2").get("/login")).text, /\/auth\/apple/);
  const off = await browser("10.9.0.2").get("/auth/apple");
  assert.equal(off.location, "/login");
  await CONF.set({ apple_sso: true }, "test");
  assert.equal(AS.enabled(), true);
  // the return URL the owner registers at Apple
  assert.equal(AS.redirectUri(), base + "/auth/apple/callback");
  const pub = process.env.PUBLIC_BASE_URL;
  delete process.env.PUBLIC_BASE_URL;
  process.env.STAGING = "1";
  assert.equal(AS.redirectUri(), "https://staging.publicaccess.tv/auth/apple/callback");
  delete process.env.STAGING;
  assert.equal(AS.redirectUri(), "https://publicaccess.tv/auth/apple/callback");
  assert.equal(AS.notificationsUri(), "https://publicaccess.tv/auth/apple/notifications");
  process.env.PUBLIC_BASE_URL = pub;
});

test("client secret: an ES256 JWT signed with the .p8 (kid, iss Team ID, sub Services ID, aud Apple, under 6 months), remade before it expires", () => {
  AS._resetSecret();
  const s = AS.clientSecret();
  assert.ok(clientSecretOk(s), "Apple accepts it");
  const [h, p] = s.split(".");
  assert.deepEqual(JSON.parse(unb64u(h)), { alg: "ES256", kid: KEY_ID });
  const c = JSON.parse(unb64u(p));
  assert.deepEqual([c.iss, c.sub, c.aud], [TEAM, SERVICES, "https://appleid.apple.com"]);
  assert.ok(c.exp - c.iat <= 180 * 86400 && c.exp - c.iat >= 86400);
  assert.equal(AS.clientSecret(), s, "reused while it's fresh");
  const t0 = T;
  T += (c.exp - c.iat - 3600) * 1000;     // less than a day left
  const s2 = AS.clientSecret();
  assert.notEqual(s2, s);
  assert.ok(clientSecretOk(s2));
  T = t0;
  AS._resetSecret();
  // another key (a rotated .p8) -> a new secret at once
  const s3 = AS.clientSecret();
  const k2 = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  process.env.APPLE_PRIVATE_KEY = Buffer.from(k2.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
  assert.notEqual(AS.clientSecret(), s3);
  setAppleEnv();
  AS._resetSecret();
});

test("ID token verification: good, then bad signature / alg / kid / iss / aud / exp / iat / nonce / sub", async () => {
  const getKey = async (kid) => (kid === KID ? appleKey.publicKey : null);
  const v = (tok, o = {}) => AS.verifyIdToken(tok, { clientId: SERVICES, nonce: "n-1", now: T, getKey, ...o });
  const code = (p) => p.then(() => "ok", (e) => e.code);
  assert.equal((await v(signJwt(idClaims()))).sub, "000111.aaa.0001");
  assert.equal(await code(v(signJwt(idClaims(), { key: otherKey.privateKey }))), "E_SIG");
  assert.equal(await code(v(signJwt(idClaims(), { alg: "HS256" }))), "E_ALG");
  assert.equal(await code(v(signJwt(idClaims(), { alg: "none" }))), "E_ALG");
  assert.equal(await code(v(signJwt(idClaims(), { kid: "nope" }))), "E_KID");
  assert.equal(await code(v(signJwt(idClaims({ iss: "https://accounts.google.com" })))), "E_ISS");
  assert.equal(await code(v(signJwt(idClaims({ aud: "tv.someone.else" })))), "E_AUD");
  assert.equal(await code(v(signJwt(idClaims({ aud: ["tv.someone.else", SERVICES] })))), "ok", "an aud list containing ours");
  assert.equal(await code(v(signJwt(idClaims({ exp: nowS() - 120 })))), "E_EXP");
  assert.equal(await code(v(signJwt(idClaims({ exp: nowS() - 30 })))), "ok", "inside the 60 s skew");
  assert.equal(await code(v(signJwt(idClaims({ iat: nowS() + 600 })))), "E_IAT");
  assert.equal(await code(v(signJwt(idClaims({ nonce: "n-2" })))), "E_NONCE");
  assert.equal(await code(v(signJwt(idClaims({ nonce: undefined })))), "E_NONCE", "no nonce");
  assert.equal(await code(v(signJwt(idClaims({ sub: "" })))), "E_SUB");
  assert.equal(await code(v(signJwt(idClaims({ sub: { $ne: 1 } })))), "E_SUB");
  assert.equal(await code(v("a.b")), "E_FORMAT");
  assert.equal(await code(v("not a jwt at all")), "E_FORMAT");
  // the JWKS: fetched once and cached; an unknown kid refetches at most once a minute
  const AS2 = AS;
  const n0 = APPLE.jwksCalls;
  await AS2.verifyIdToken(signJwt(idClaims()), { clientId: SERVICES, nonce: "n-1", now: T });
  await AS2.verifyIdToken(signJwt(idClaims()), { clientId: SERVICES, nonce: "n-1", now: T });
  assert.ok(APPLE.jwksCalls - n0 <= 1, "cached");
  for (let i = 0; i < 3; i++) await code(AS2.verifyIdToken(signJwt(idClaims(), { kid: "unknown-" + i }), { clientId: SERVICES, nonce: "n-1", now: T }));
  assert.ok(APPLE.jwksCalls - n0 <= 2, "an unknown kid can't make us hammer Apple");
});

// ───────────────────────── the web flow ─────────────────────────
test("the authorize request: code, form_post, scope 'name email', state + nonce; the state cookie is HttpOnly, Secure, SameSite=None, scoped to the callback", async () => {
  const b = browser("10.1.0.1");
  const { q, start } = await appleStart(b);
  assert.equal(q.get("client_id"), SERVICES);
  assert.equal(q.get("redirect_uri"), base + "/auth/apple/callback");
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("response_mode"), "form_post");
  assert.equal(q.get("scope"), "name email");
  assert.match(q.get("state"), /^[0-9a-f]{48}$/);
  assert.ok(q.get("nonce").length >= 32);
  assert.equal([...q.keys()].sort().join(","), "client_id,nonce,redirect_uri,response_mode,response_type,scope,state", "nothing else in the URL");
  const c = start.setCookie.find((x) => x.startsWith("apple_sso="));
  assert.ok(c, "the state cookie");
  assert.match(c, /; HttpOnly/i); assert.match(c, /; Secure/i); assert.match(c, /; SameSite=None/i);
  assert.match(c, /; Path=\/auth\/apple\/callback/i); assert.match(c, /Max-Age=600/i);
  // its twin for older Safari (WebKit bug 198181: SameSite=None taken as Strict): the same value and flags, NO SameSite attribute
  const l = start.setCookie.find((x) => x.startsWith("apple_sso_l="));
  assert.ok(l, "the legacy twin");
  assert.match(l, /; HttpOnly/i); assert.match(l, /; Secure/i); assert.doesNotMatch(l, /SameSite/i);
  assert.match(l, /; Path=\/auth\/apple\/callback/i); assert.match(l, /Max-Age=600/i);
  assert.equal(b.jar.get("apple_sso_l").v, b.jar.get("apple_sso").v, "the same sealed state");
  // it's MACed: a changed byte is a cookie we never made
  const v = decodeURIComponent(b.jar.get("apple_sso").v);
  assert.ok(AS.openState(v));
  const [body, mac] = v.split(".");
  assert.equal(AS.openState(body.slice(0, -2) + (body.slice(-2) === "AA" ? "AB" : "AA") + "." + mac), null);
  assert.equal(AS.openState(body + "." + mac.replace(/^./, (ch) => (ch === "A" ? "B" : "A"))), null);
  // a signed-in member starting a sign-in goes to the account page instead
  const s = await mkUser("sid");
  const sb = browser("10.1.0.2");
  await sb.post("/login", { username: "sid", password: PASSWORD });
  assert.equal(sb.who(), "sid");
  assert.equal((await sb.get("/auth/apple")).location, "/settings/account#connections");
  assert.equal(s.username, "sid");
});

test("the cross-site callback works with ONLY the SameSite=None cookie, mints no session or login cookie, and hands off to a same-site GET", async () => {
  const b = browser("10.1.0.3");
  // the member already has a session (and its Lax cookie): Apple's POST must not replace it
  await b.get("/login");
  const sid0 = b.jar.get("connect.sid") && b.jar.get("connect.sid").v;
  assert.ok(sid0, "a session cookie exists");
  const st = await appleStart(b);
  const cb = await appleReturn(b, st, { sub: "000111.cross.0001", email: "cross@example.test" }, { user: { name: { firstName: "Cora", lastName: "Cross" } } });
  assert.equal(cb.status, 303);
  assert.equal(cb.location, "/auth/apple/continue", "no code, token or identity in the URL");
  const names = cb.setCookie.map((x) => x.split("=")[0]).sort();
  assert.deepEqual(names, ["apple_sso", "apple_sso_h", "apple_sso_l"], "only the state cookie + its twin (cleared) and the hand-off - no session, no login");
  const h = cb.setCookie.find((x) => x.startsWith("apple_sso_h="));
  assert.match(h, /; HttpOnly/i); assert.match(h, /; SameSite=Lax/i); assert.match(h, /; Path=\/auth\/apple\/continue/i); assert.match(h, /Max-Age=120/i);
  assert.equal(b.jar.get("connect.sid").v, sid0, "the member's session is untouched");
  assert.ok(!b.jar.has("apple_sso"), "the state cookie is cleared");
  assert.ok(!b.jar.has("apple_sso_l"), "its twin too (a browser that defaults to Lax never sent it)");
  // the token exchange used our client secret + the registered return URL
  const call = APPLE.tokenCalls[APPLE.tokenCalls.length - 1];
  assert.equal(call.redirect_uri, base + "/auth/apple/callback");
  assert.ok(clientSecretOk(call.client_secret));
  // the same-site GET continues with the normal session: parked for /auth/sso/new
  const cont = await b.get("/auth/apple/continue");
  assert.equal(cont.location, "/auth/sso/new");
  assert.ok(!b.jar.has("apple_sso_h"), "the hand-off cookie is cleared");
  const page = await b.get("/auth/sso/new");
  assert.equal(page.status, 200);
  assert.match(page.text, /Cora Cross/, "the name Apple sent the first time");
  assert.match(page.text, /We only read your Apple Account id/);
  // the hand-off is single use
  b.jar.set("apple_sso_h", { v: decodeURIComponent(h.split(";")[0].split("=")[1]), path: "/auth/apple/continue", sameSite: "lax" });
  const again = await b.get("/auth/apple/continue");
  assert.equal(again.location, "/login");
  assert.match(await flashText(b), /expired/);
});

test("unlinked -> a new account: Apple's sub is the link (never the email), the name only from the first authorization, the refresh token encrypted", async () => {
  // a PATV member who already uses this (verified) email must NOT be picked or matched
  const ann = await mkUser("ann", { email: "ann@example.test", verified: true });
  const b = browser("10.1.0.4");
  const { cont } = await appleSignIn(b, { sub: "000111.ann.0002", email: "ann@example.test", email_verified: "true" },
                                     { user: { name: { firstName: "Ann", lastName: "Appleseed" }, email: "ann@example.test" }, refresh: "r-ann-secret-1" });
  assert.equal(cont.location, "/auth/sso/new");
  assert.equal(b.who(), null, "NOT signed in as the member with that email");
  const page = await b.get("/auth/sso/new");
  assert.match(page.text, /value="Ann1?"|value="ann1"/i, "the username suggestion comes from the first name");
  const c = await b.post("/auth/sso/create", { username: "ann_apple" });
  assert.equal(c.status, 302);
  assert.equal(b.who(), "ann_apple");
  const nu = (await getQuery("SELECT * FROM users WHERE username = 'ann_apple'"))[0];
  assert.equal(nu.email, null, "never someone else's email");
  assert.equal(nu.password_set, 0, "a random password: not a sign-in method");
  const l = await SSO.linkBySubject("apple", "000111.ann.0002");
  assert.equal(l.user_id, nu.userId); assert.equal(l.link_source, "self"); assert.equal(l.proof, "oidc");
  assert.equal(l.name, "Ann Appleseed"); assert.equal(l.email, "ann@example.test"); assert.equal(l.email_relay, null);
  assert.ok(l.refresh_token_enc && !l.refresh_token_enc.includes("r-ann-secret-1"), "encrypted at rest");
  assert.equal(AS.decryptToken(l.refresh_token_enc, l.subject), "r-ann-secret-1");
  assert.ok((await getQuery("SELECT 1 FROM welcome_bonus WHERE userId = ? AND source = 'apple'", [nu.userId])).length, "sign-up welcome enrolment");
  const sess = await getQuery("SELECT method FROM sessions WHERE user_id = ? AND revoked_at IS NULL", [nu.userId]);
  assert.deepEqual(sess.map((s) => s.method), ["apple"], "the session says how it was signed in");
  assert.equal(ann.username, "ann");
  // next time: straight in. Apple sends no `user` field again - the stored name stays; the newest refresh token is kept
  const b2 = browser("10.1.0.5");
  T += 1000;
  const { cont: c2 } = await appleSignIn(b2, { sub: "000111.ann.0002", email: "ann@example.test" }, { refresh: "r-ann-secret-2" });
  assert.match(c2.location, /^\/u\/ann_apple\/wheel$/);
  assert.equal(b2.who(), "ann_apple");
  const l2 = await SSO.linkBySubject("apple", "000111.ann.0002");
  assert.equal(l2.name, "Ann Appleseed", "kept: the name comes only the first time");
  assert.equal(AS.decryptToken(l2.refresh_token_enc, l2.subject), "r-ann-secret-2");
  // an account with a free, Apple-verified email gets it as its account email (verified)
  const b3 = browser("10.1.0.6");
  await appleSignIn(b3, { sub: "000111.bo.0003", email: "bo@example.test", email_verified: true }, { user: { name: { firstName: "Bo" } } });
  await b3.post("/auth/sso/create", { username: "bo_apple" });
  const bo = (await getQuery("SELECT email, isEmailVerified FROM users WHERE username = 'bo_apple'"))[0];
  assert.deepEqual([bo.email, bo.isEmailVerified], ["bo@example.test", 1]);
});

test("a private relay address is contact only: never the account email, never a lookup key; the page says so", async () => {
  const relay = "x7k2m9p4q1@privaterelay.appleid.com";
  // even an account that (somehow) uses that address is never matched by it
  await mkUser("relayowner", { email: relay, verified: true });
  const b = browser("10.1.0.7");
  const { cont } = await appleSignIn(b, { sub: "000111.rel.0004", email: relay, is_private_email: "true", email_verified: "true" },
                                     { user: { name: { firstName: "", lastName: "" } } });
  assert.equal(cont.location, "/auth/sso/new");
  assert.equal(b.who(), null);
  const page = await b.get("/auth/sso/new");
  assert.match(page.text, /Apple is hiding your email/);
  assert.doesNotMatch(page.text, /privaterelay/, "the relay address isn't shown");
  await b.post("/auth/sso/create", { username: "rel_apple" });
  assert.equal(b.who(), "rel_apple");
  const u = (await getQuery("SELECT email FROM users WHERE username = 'rel_apple'"))[0];
  assert.equal(u.email, null, "the relay address is not the account email");
  const l = await SSO.linkBySubject("apple", "000111.rel.0004");
  assert.equal(l.email, relay); assert.equal(l.email_relay, 1);
  // detected by the domain too (is_private_email missing)
  const w = AS.who({ sub: "s", email: "abc@privaterelay.appleid.com" }, null);
  assert.deepEqual([w.relay, w.email, w.contact, w.email_verified], [true, null, "abc@privaterelay.appleid.com", false]);
  // the unsigned `user` field gives a (cleaned) name only, never an email
  const w2 = AS.who({ sub: "s" }, JSON.stringify({ name: { firstName: "<b>Eve</b>", lastName: "x".repeat(80) }, email: "evil@example.test" }));
  assert.equal(w2.email, null);
  assert.ok(!/[<>]/.test(w2.name) && w2.name.length <= 64);
  assert.equal(AS.who({ sub: "s" }, "not json").name, "");
});

test("state: never started here / wrong state / tampered or missing cookie / older than 10 minutes / a replayed POST -> expired, nobody signed in", async () => {
  // a callback that never started here
  let b = browser("10.1.1.1");
  let r = await b.go("POST", "/auth/apple/callback", { state: "abc", code: "x" }, { cross: true });
  assert.equal(r.location, "/auth/apple/continue");
  r = await b.get("/auth/apple/continue");
  assert.equal(r.location, "/login");
  assert.match(await flashText(b), /expired/);
  // wrong state
  b = browser("10.1.1.2");
  let st = await appleStart(b);
  r = await appleReturn(b, { ...st, state: "0".repeat(48) }, { sub: "000111.s.1" });
  await b.get("/auth/apple/continue");
  assert.equal(b.who(), null); assert.match(await flashText(b), /expired/);
  // the state cookie missing (another browser) or forged
  b = browser("10.1.1.3");
  st = await appleStart(b);
  const stolen = b.jar.get("apple_sso");
  b.jar.delete("apple_sso");
  await appleReturn(b, st, { sub: "000111.s.1" });
  await b.get("/auth/apple/continue");
  assert.equal(b.who(), null);
  b.jar.set("apple_sso", { ...stolen, v: (stolen.v[0] === "e" ? "f" : "e") + stolen.v.slice(1) });   // one byte changed
  await appleReturn(b, st, { sub: "000111.s.1" });
  await b.get("/auth/apple/continue");
  assert.equal(b.who(), null);
  // a sign-in that took longer than 10 minutes
  b = browser("10.1.1.4");
  st = await appleStart(b);
  T += 11 * 60 * 1000;
  await appleReturn(b, st, { sub: "000111.s.1" });
  T += 1000;
  r = await b.get("/auth/apple/continue");
  assert.equal(r.location, "/login"); assert.equal(b.who(), null);
  // a good one, then the very same POST replayed (same cookie, same state, a fresh code) -> the state is single use
  const kim = await mkUser("kim");
  await SSO.addLink("apple", kim.userId, { subject: "000111.kim.0005", proof: "oidc" });
  b = browser("10.1.1.5");
  st = await appleStart(b);
  const cookie = { ...b.jar.get("apple_sso") };
  await appleReturn(b, st, { sub: "000111.kim.0005" });
  await b.get("/auth/apple/continue");
  assert.equal(b.who(), "kim");
  const evil = browser("10.1.1.6");
  evil.jar.set("apple_sso", cookie);
  await appleReturn(evil, st, { sub: "000111.kim.0005" });
  await evil.get("/auth/apple/continue");
  assert.equal(evil.who(), null, "a captured callback can't be replayed");
  assert.match(await flashText(evil), /expired/);
});

test("nonce + errors: an ID token for another nonce fails; a bad code fails; Apple's user_cancelled_authorize -> cancelled", async () => {
  let b = browser("10.1.1.7");
  let st = await appleStart(b);
  // Apple (or an attacker's code from another flow) answers with a token bound to a different nonce
  await appleReturn(b, { state: st.state, nonce: "someone-elses-nonce" }, { sub: "000111.kim.0005" });
  let r = await b.get("/auth/apple/continue");
  assert.equal(r.location, "/login"); assert.equal(b.who(), null);
  assert.match(await flashText(b), /Apple sign-in didn(&#39;|')t work/);
  // a code Apple doesn't know
  b = browser("10.1.1.8");
  st = await appleStart(b);
  await b.go("POST", "/auth/apple/callback", { state: st.state, code: "never-issued" }, { cross: true });
  await b.get("/auth/apple/continue");
  assert.equal(b.who(), null);
  assert.match(await flashText(b), /Apple sign-in didn(&#39;|')t work/);
  // cancelled at Apple
  b = browser("10.1.1.9");
  st = await appleStart(b);
  await b.go("POST", "/auth/apple/callback", { state: st.state, error: "user_cancelled_authorize" }, { cross: true });
  r = await b.get("/auth/apple/continue");
  assert.equal(r.location, "/login");
  assert.match(await flashText(b), /cancelled/);
  // an ID token signed by someone else is refused even with the right nonce
  b = browser("10.1.2.1");
  st = await appleStart(b);
  await appleReturn(b, st, { sub: "000111.kim.0005" }, { sign: { key: otherKey.privateKey } });
  await b.get("/auth/apple/continue");
  assert.equal(b.who(), null);
});

test("login CSRF: another page's cross-site POST carries the state cookie but can't know the state; the code is bound to this browser's nonce", async () => {
  const mal = await mkUser("mallory");
  await SSO.addLink("apple", mal.userId, { subject: "000111.mal.0006", proof: "oidc" });
  // the victim starts a sign-in (or an attacker's page navigates them to /auth/apple) - the state cookie is in their browser
  const victim = browser("10.1.2.2");
  const vst = await appleStart(victim);
  // the attacker's own flow gets them a valid code + state for THEIR Apple account
  const att = browser("10.1.2.3");
  const ast = await appleStart(att);
  // ... and their page makes the victim's browser POST it (the SameSite=None state cookie rides along)
  APPLE.codes.set("att-code", { nonce: ast.nonce, claims: { sub: "000111.mal.0006" }, refresh: "r" });
  await victim.go("POST", "/auth/apple/callback", { state: ast.state, code: "att-code" }, { cross: true });
  await victim.get("/auth/apple/continue");
  assert.equal(victim.who(), null, "not signed in as the attacker");
  // with the victim's state (which the attacker can't read) the attacker's code still fails: wrong nonce
  APPLE.codes.set("att-code-2", { nonce: ast.nonce, claims: { sub: "000111.mal.0006" }, refresh: "r" });
  const v2 = browser("10.1.2.4");
  const v2st = await appleStart(v2);
  await v2.go("POST", "/auth/apple/callback", { state: v2st.state, code: "att-code-2" }, { cross: true });
  await v2.get("/auth/apple/continue");
  assert.equal(v2.who(), null);
  assert.ok(vst.state && v2st.state);
});

test("\"I already have an account\": the password sign-in links Apple (sub, encrypted token, relay flag)", async () => {
  const bea = await mkUser("bea");
  const b = browser("10.1.2.5");
  const { cont } = await appleSignIn(b, { sub: "000111.bea.0007", email: "q9@privaterelay.appleid.com", is_private_email: true },
                                     { user: { name: { firstName: "Bea" } }, refresh: "r-bea" });
  assert.equal(cont.location, "/auth/sso/new");
  const lp = await b.get("/login");
  assert.match(lp.text, /name="link_sso" value="apple"/);
  await b.post("/login", { username: "bea", password: PASSWORD, link_sso: "apple" });
  assert.equal(b.who(), "bea");
  const l = await SSO.linkBySubject("apple", "000111.bea.0007");
  assert.equal(l.user_id, bea.userId);
  assert.equal(l.email_relay, 1);
  assert.equal(AS.decryptToken(l.refresh_token_enc, l.subject), "r-bea");
  assert.ok((await getQuery("SELECT 1 FROM inbox WHERE user_id = ? AND title LIKE '%Apple%'", [bea.userId])).length, "the 'not you? unlink it' notice");
});

test("Settings -> Account: link (same-site POST only, bound to the account that started it), one per account, someone else's Apple refused", async () => {
  const cal = await mkUser("cal");
  const b = browser("10.1.2.6");
  await b.post("/login", { username: "cal", password: PASSWORD });
  // a cross-site POST can't start a link
  const x = await b.go("POST", "/auth/apple/link", {}, { headers: { origin: "https://evil.example" } });
  assert.equal(x.status, 403);
  // signed out: back to /login
  assert.equal((await browser("10.1.2.7").post("/auth/apple/link")).location, "/login");
  const { cont } = await appleSignIn(b, { sub: "000111.cal.0008", email: "cal@icloud.test" }, { link: true, user: { name: { firstName: "Cal" } }, refresh: "r-cal" });
  assert.equal(cont.location, "/settings/account#connections");
  const l = await SSO.linkOf("apple", cal.userId);
  assert.equal(l.subject, "000111.cal.0008"); assert.equal(l.name, "Cal");
  assert.equal(AS.decryptToken(l.refresh_token_enc, l.subject), "r-cal");
  // the Apple ID linked to kim can't be linked here
  await appleSignIn(b, { sub: "000111.kim.0005" }, { link: true });
  assert.equal((await SSO.linkBySubject("apple", "000111.kim.0005")).user_id, "u_kim");
  assert.equal((await SSO.linkOf("apple", cal.userId)).subject, "000111.cal.0008", "unchanged");
  assert.match((await b.get("/settings/account")).text, /already linked to another PATV account|already has one linked/);
  // a link started by cal can't land on another account that signs in on the same browser before it returns
  const dan = await mkUser("dan");
  const b2 = browser("10.1.2.8");
  await b2.post("/login", { username: "cal", password: PASSWORD });
  const st = await appleStart(b2, { link: true });
  await appleReturn(b2, st, { sub: "000111.dan.0009" });
  b2.jar.delete("jwt");
  await b2.post("/login", { username: "dan", password: PASSWORD });
  assert.equal(b2.who(), "dan");
  await b2.get("/auth/apple/continue");
  assert.equal(await SSO.linkOf("apple", dan.userId), null, "not linked to dan");
  assert.equal(await SSO.linkBySubject("apple", "000111.dan.0009"), null);
});

test("unlink: revoked at Apple with the stored refresh token + a valid client secret; a failed call is queued and retried; the last-method guard", async () => {
  const cal = (await getQuery("SELECT userId, username FROM users WHERE username = 'cal'"))[0];
  // (the tokens of the sign-ins earlier tests parked and never finished wait in the queue as "unused" - not this test's)
  await runQuery("DELETE FROM apple_revokes");
  const b = browser("10.1.3.1");
  await b.post("/login", { username: "cal", password: PASSWORD });
  // not a same-site fetch -> refused
  assert.equal((await b.post("/api/sso/apple/unlink")).status, 403);
  APPLE.revokes.length = 0;
  // while Apple is being asked, the token is already in the queue: written in the unlink's own transaction, so a restart
  // between the two can't lose it
  const during = [];
  APPLE.revokeHook = async () => { during.push((await getQuery("SELECT COUNT(*) AS n FROM apple_revokes WHERE apple_sub = '000111.cal.0008'"))[0].n); };
  let r = await b.api("/api/sso/apple/unlink");
  APPLE.revokeHook = null;
  assert.deepEqual(during, [1]);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM apple_revokes"))[0].n, 0, "revoked -> off the queue");
  assert.equal(r.json.ok, true); assert.equal(r.json.removed, true); assert.equal(r.json.revoked, true);
  assert.equal(await SSO.linkOf("apple", cal.userId), null);
  assert.equal(APPLE.revokes.length, 1);
  assert.deepEqual([APPLE.revokes[0].client_id, APPLE.revokes[0].token, APPLE.revokes[0].token_type_hint], [SERVICES, "r-cal", "refresh_token"]);
  assert.ok(clientSecretOk(APPLE.revokes[0].client_secret));
  r = await b.api("/api/sso/apple/unlink");
  assert.deepEqual([r.json.ok, r.json.removed], [true, false], "nothing left to unlink");
  // Apple down: unlinked here anyway (the member's choice wins), the revocation waits in the queue with backoff
  await appleSignIn(b, { sub: "000111.cal.0008" }, { link: true, refresh: "r-cal-2" });
  APPLE.revokeStatus = 503;
  r = await b.api("/api/sso/apple/unlink");
  assert.deepEqual([r.json.ok, r.json.removed, r.json.revoked], [true, true, false]);
  let q = await getQuery("SELECT * FROM apple_revokes");
  assert.equal(q.length, 1);
  assert.ok(!q[0].token_enc.includes("r-cal-2"), "queued encrypted");
  assert.equal(await AS.revokeTick(), 0, "not due yet");
  T += 6 * 60 * 1000;
  assert.equal(await AS.revokeTick(), 0, "still down");
  q = await getQuery("SELECT tries, next_at FROM apple_revokes");
  assert.equal(q[0].tries, 2); assert.ok(q[0].next_at >= T + 19 * 60 * 1000, "backs off");
  APPLE.revokeStatus = 200;
  T += 25 * 60 * 1000;
  APPLE.revokes.length = 0;
  assert.equal(await AS.revokeTick(), 1);
  assert.equal(APPLE.revokes[0].token, "r-cal-2");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM apple_revokes"))[0].n, 0);
  // an Apple-only account (a random password) can't unlink its only way in
  const rel = (await getQuery("SELECT userId FROM users WHERE username = 'rel_apple'"))[0];
  const rb = browser("10.1.3.2");
  T += 1000;
  await appleSignIn(rb, { sub: "000111.rel.0004", email: "x7k2m9p4q1@privaterelay.appleid.com", is_private_email: "true" });
  assert.equal(rb.who(), "rel_apple");
  assert.deepEqual(await SSO.methods(rel.userId), ["apple"]);
  r = await rb.api("/api/sso/apple/unlink");
  assert.equal(r.status, 409); assert.equal(r.json.code, "E_LAST_METHOD");
  assert.ok(await SSO.linkOf("apple", rel.userId), "still linked");
  await SSO.markPassword(rel.userId, true);
  r = await rb.api("/api/sso/apple/unlink");
  assert.equal(r.json.removed, true);
  await SSO.markPassword(rel.userId, false);
  // relink for the notification tests below
  await SSO.addLink("apple", rel.userId, { subject: "000111.rel.0004", proof: "oidc", email: "x7k2m9p4q1@privaterelay.appleid.com", relay: true,
                                           secret: AS.encryptToken("r-rel", "000111.rel.0004") });
});

test("the refresh token at rest: AES-256-GCM bound to its Apple sub (can't be moved to another link); revoke skips one that won't decrypt", async () => {
  await runQuery("DELETE FROM apple_revokes");
  const enc = AS.encryptToken("r-secret", "sub-a");
  assert.match(enc, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.notEqual(AS.encryptToken("r-secret", "sub-a"), enc, "a fresh IV each time");
  assert.equal(AS.decryptToken(enc, "sub-a"), "r-secret");
  assert.throws(() => AS.decryptToken(enc, "sub-b"), "another sub (AAD)");
  const p = enc.split(".");
  assert.throws(() => AS.decryptToken([p[0], p[1], p[2], p[3].slice(0, -2) + (p[3].endsWith("AA") ? "AB" : "AA")].join("."), "sub-a"), "tampered");
  APPLE.revokes.length = 0;
  // how unlink / account deletion revoke: queued inside the transaction that removes the rows, then tried at once
  const revokeNow = async (rows, why) => AS.flushQueued(await tx(() => AS.queueRows(rows, why)));
  assert.equal(await revokeNow([{ subject: "sub-b", refresh_token_enc: enc }], "test"), 0);
  assert.equal(APPLE.revokes.length, 0, "nothing sent");
  assert.equal(await revokeNow([{ subject: "sub-a", refresh_token_enc: enc }], "test"), 1);
  assert.equal(APPLE.revokes[0].token, "r-secret");
  const queued = async () => (await getQuery("SELECT COUNT(*) AS n FROM apple_revokes"))[0].n;
  // Apple says it's already revoked / expired (invalid_grant) -> done, not queued
  APPLE.revokeStatus = 400; APPLE.revokeError = "invalid_grant";
  assert.equal(await revokeNow([{ subject: "sub-a", refresh_token_enc: enc }], "test"), 1);
  assert.equal(await queued(), 0);
  // a request Apple will never accept -> logged, not retried forever
  APPLE.revokeError = "invalid_request";
  assert.equal(await revokeNow([{ subject: "sub-a", refresh_token_enc: enc }], "test"), 0);
  assert.equal(await queued(), 0);
  // rate limited -> queued
  APPLE.revokeStatus = 429; APPLE.revokeError = null;
  assert.equal(await revokeNow([{ subject: "sub-a", refresh_token_enc: enc }], "test"), 0);
  assert.equal(await queued(), 1);
  APPLE.revokeStatus = 200;
  T += 6 * 60 * 1000;
  assert.equal(await AS.revokeTick(), 1);
  assert.equal(await queued(), 0);
  // a row without a token (a link made before Apple sent one) is skipped quietly
  assert.equal(await revokeNow([{ subject: "sub-a", refresh_token_enc: null }], "test"), 0);
});

// ───────────────────────── server-to-server notifications ─────────────────────────
test("notifications: only Apple's signature, issuer and audience count; malformed / unsigned / forged / other app -> 400; CSRF-exempt", async () => {
  const kim = (await getQuery("SELECT userId FROM users WHERE username = 'kim'"))[0];
  const bad = [
    notification("consent-revoked", "000111.kim.0005", { sign: { key: otherKey.privateKey } }),          // forged signature
    notification("consent-revoked", "000111.kim.0005", { sign: { alg: "none" } }),                       // unsigned
    notification("consent-revoked", "000111.kim.0005", { sign: { kid: "unknown" } }),                    // unknown key
    notification("consent-revoked", "000111.kim.0005", { claims: { aud: "tv.another.app" } }),           // another app's
    notification("consent-revoked", "000111.kim.0005", { claims: { iss: "https://evil.example" } }),     // not Apple
    notification("consent-revoked", "000111.kim.0005", { claims: { iat: nowS() + 3600 } }),              // from the future
    notification("consent-revoked", "000111.kim.0005", { claims: { exp: nowS() - 3600 } }),              // expired
    notification("consent-revoked", "", {}),                                                              // no sub
    signJwt({ iss: "https://appleid.apple.com", aud: SERVICES, iat: nowS(), events: "{not json" }),       // malformed events
  ];
  for (const p of bad) {
    const r = await notify(p);
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.equal(r.json.ok, false);
  }
  assert.equal((await notify(null, { raw: "{}" })).status, 400, "no payload");
  assert.ok(await SSO.linkOf("apple", kim.userId), "nothing happened");
  // the primary App ID is accepted as the audience too once it's configured
  process.env.APPLE_APP_ID = "tv.another.app";
  const ok = await notify(notification("email-enabled", "000111.kim.0005", { claims: { aud: "tv.another.app" } }));
  assert.equal(ok.status, 200);
  delete process.env.APPLE_APP_ID;
  // not configured -> 404 (and nothing read)
  const sid = process.env.APPLE_SERVICES_ID;
  delete process.env.APPLE_SERVICES_ID;
  assert.equal((await notify(notification("consent-revoked", "000111.kim.0005"))).status, 404);
  process.env.APPLE_SERVICES_ID = sid;
});

test("notifications: consent-revoked unlinks and ends ONLY the Apple sign-ins (once); email-disabled / -enabled flag the relay; unknown ids are fine", async () => {
  const kim = (await getQuery("SELECT userId FROM users WHERE username = 'kim'"))[0];
  // kim signed in twice: once with Apple, once with the password
  const ab = browser("10.1.4.1");
  T += 1000;
  await appleSignIn(ab, { sub: "000111.kim.0005" });
  assert.equal(ab.who(), "kim");
  const pb = browser("10.1.4.2");
  await pb.post("/login", { username: "kim", password: PASSWORD });
  const live = async () => (await getQuery("SELECT method FROM sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY method", [kim.userId])).map((r) => r.method);
  assert.ok((await live()).includes("apple") && (await live()).includes("password"));
  // email events first (the relay address's contact flag)
  await runQuery("UPDATE sso_links SET email = 'k1@privaterelay.appleid.com', email_relay = 1 WHERE subject = '000111.kim.0005'");
  let r = await notify(notification("email-disabled", "000111.kim.0005", { events: { email: "k1@privaterelay.appleid.com", is_private_email: "true" } }));
  assert.equal(r.status, 200);
  assert.equal((await SSO.linkOf("apple", kim.userId)).email_off, 1);
  r = await notify(notification("email-enabled", "000111.kim.0005", { events: { email: "k1@privaterelay.appleid.com", is_private_email: "true" } }));
  assert.equal((await SSO.linkOf("apple", kim.userId)).email_off, 0);
  // consent revoked (kim has a password, so Apple is not the last way in): unlinked, the Apple session ends, the password one stays
  T += 1000;
  const cr = notification("consent-revoked", "000111.kim.0005");
  r = await notify(cr);
  assert.equal(r.status, 200); assert.equal(r.json.type, "consent-revoked");
  assert.equal(await SSO.linkOf("apple", kim.userId), null);
  assert.deepEqual(await live(), ["password"]);
  const notes = await getQuery("SELECT title, body FROM inbox WHERE user_id = ? AND title LIKE '%Sign in with Apple%'", [kim.userId]);
  assert.equal(notes.length, 1);
  assert.match(notes[0].body, /stopped using Sign in with Apple/);
  // the same notification again (Apple retries), and another one about the same event, change nothing and file no second notice
  r = await notify(cr);
  assert.equal(r.status, 200);
  r = await notify(notification("consent-revoked", "000111.kim.0005"));
  assert.equal(r.status, 200);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = ? AND title LIKE '%Sign in with Apple%'", [kim.userId]))[0].n, 1);
  // an Apple ID we never saw - Apple's "account-deleted", and the older spelling "account-delete" read as the same event
  r = await notify(notification("account-deleted", "000999.nobody.0000"));
  assert.deepEqual([r.status, r.json.type], [200, "account-deleted"]);
  r = await notify(notification("account-delete", "000999.nobody.0001"));
  assert.deepEqual([r.status, r.json.type], [200, "account-deleted"]);
  // an unknown event type is accepted and ignored
  assert.equal((await notify(notification("something-new", "000111.kim.0005"))).status, 200);
});

test("notifications: one issued before the current link never undoes it; consent-revoked keeps an account's ONLY way in (token dropped); account-deleted always unlinks", async () => {
  const kim = (await getQuery("SELECT userId FROM users WHERE username = 'kim'"))[0];
  const old = notification("consent-revoked", "000111.kim.0005");   // issued now...
  T += 5 * 60 * 1000;
  await SSO.addLink("apple", kim.userId, { subject: "000111.kim.0005", proof: "oidc", secret: AS.encryptToken("r-kim", "000111.kim.0005") });   // ...relinked later
  const r = await notify(old);
  assert.equal(r.status, 200);
  assert.ok(await SSO.linkOf("apple", kim.userId), "a stale (or replayed) notification doesn't unlink the newer link");
  // rel_apple: Apple is the only way in
  const rel = (await getQuery("SELECT userId FROM users WHERE username = 'rel_apple'"))[0];
  const rb = browser("10.1.4.3");
  T += 1000;
  await appleSignIn(rb, { sub: "000111.rel.0004" }, { refresh: "r-rel-2" });
  assert.equal(rb.who(), "rel_apple");
  T += 1000;
  await notify(notification("consent-revoked", "000111.rel.0004"));
  const kept = await SSO.linkOf("apple", rel.userId);
  assert.ok(kept, "kept: otherwise the account would have no way in");
  assert.equal(kept.refresh_token_enc, null, "Apple's (now dead) token is dropped");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND method = 'apple' AND revoked_at IS NULL", [rel.userId]))[0].n, 0, "signed out");
  assert.ok((await getQuery("SELECT 1 FROM inbox WHERE user_id = ? AND body LIKE '%stays linked%'", [rel.userId])).length);
  // signing in with Apple again reaches the same account (and stores the new token)
  const rb2 = browser("10.1.4.4");
  T += 1000;
  await appleSignIn(rb2, { sub: "000111.rel.0004" }, { refresh: "r-rel-3" });
  assert.equal(rb2.who(), "rel_apple");
  assert.equal(AS.decryptToken((await SSO.linkOf("apple", rel.userId)).refresh_token_enc, "000111.rel.0004"), "r-rel-3");
  // the Apple Account is deleted (Apple's type "account-deleted"): unlinked even though it was the only way in (its sub never
  // comes back)
  T += 1000;
  const del = await notify(notification("account-deleted", "000111.rel.0004"));
  assert.deepEqual([del.status, del.json.type], [200, "account-deleted"]);
  assert.equal(await SSO.linkOf("apple", rel.userId), null);
  assert.ok((await getQuery("SELECT 1 FROM inbox WHERE user_id = ? AND body LIKE '%was deleted%'", [rel.userId])).length);
  // nothing queued to revoke for an Apple ID Apple itself ended
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM apple_revokes WHERE apple_sub = '000111.rel.0004'"))[0].n, 0);
});

test("notifications: applied ONCE - Apple's retry or a captured replay never signs out a later Apple sign-in or drops its token; a late one only ends older sessions", async () => {
  // an account Apple is the only way into (made by Sign in with Apple)
  const b = browser("10.1.5.1");
  T += 1000;
  await appleSignIn(b, { sub: "000111.rep.0010", email: "rep@example.test" }, { user: { name: { firstName: "Rae" } }, refresh: "r-rep-1" });
  await b.post("/auth/sso/create", { username: "rep_apple" });
  assert.equal(b.who(), "rep_apple");
  const u = (await getQuery("SELECT userId FROM users WHERE username = 'rep_apple'"))[0];
  const live = async () => (await getQuery("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND method = 'apple' AND revoked_at IS NULL", [u.userId]))[0].n;
  const signedOut = async () => (await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = ? AND title LIKE '%signed out%'", [u.userId]))[0].n;
  assert.equal(await live(), 1);
  T += 1000;
  const n1 = notification("consent-revoked", "000111.rep.0010");
  let r = await notify(n1);
  assert.equal(r.status, 200);
  let l = await SSO.linkBySubject("apple", "000111.rep.0010");
  assert.ok(l, "kept: the account's only way in");
  assert.equal(l.refresh_token_enc, null);
  assert.equal(await live(), 0);
  assert.equal(await signedOut(), 1);
  // an hour later the member signs in with Apple again: a new authorization (a new session, a new token)
  T += 3600e3;
  const b2 = browser("10.1.5.2");
  await appleSignIn(b2, { sub: "000111.rep.0010" }, { refresh: "r-rep-2" });
  assert.equal(b2.who(), "rep_apple");
  assert.equal(await live(), 1);
  // Apple retries the very same notification / someone replays the captured JWS: already applied - nothing happens
  r = await notify(n1);
  assert.equal(r.status, 200);
  assert.equal(await live(), 1, "the later sign-in stays");
  l = await SSO.linkBySubject("apple", "000111.rep.0010");
  assert.equal(AS.decryptToken(l.refresh_token_enc, l.subject), "r-rep-2", "and so does its token");
  // another notification about an event from BEFORE that sign-in, delivered late: the link, the token and the newer session stay
  const late = notification("consent-revoked", "000111.rep.0010", { events: { event_time: T - 1800e3 }, claims: { iat: nowS() - 1800 } });
  r = await notify(late);
  assert.equal(r.status, 200);
  assert.equal(await live(), 1);
  l = await SSO.linkBySubject("apple", "000111.rep.0010");
  assert.equal(AS.decryptToken(l.refresh_token_enc, l.subject), "r-rep-2");
  assert.equal(await signedOut(), 1, "no second notice");
  // ... but a session from before that event would end: one signed in with Apple earlier on another device
  await runQuery("UPDATE sessions SET created = ? WHERE user_id = ? AND method = 'apple' AND revoked_at IS NULL", [T - 2 * 3600e3, u.userId]);
  r = await notify(notification("consent-revoked", "000111.rep.0010", { events: { event_time: T - 1800e3 }, claims: { iat: nowS() - 1800 } }));
  assert.equal(await live(), 0, "a session older than the event ends");
  assert.ok(await SSO.linkBySubject("apple", "000111.rep.0010"), "the link (renewed since) stays");
  // the processed notifications are remembered by their jti only
  assert.ok((await getQuery("SELECT COUNT(*) AS n FROM apple_notices WHERE k LIKE 'n:%'"))[0].n >= 3);
});

test("notifications: one older than a week is refused (Apple's carry no exp); an older email event delivered late never overrides a newer one", async () => {
  const sub = "000111.rep.0010";
  let r = await notify(notification("email-disabled", sub, { claims: { iat: nowS() - 8 * 86400 } }));
  assert.deepEqual([r.status, r.json.error], [400, "E_STALE"]);
  r = await notify(notification("email-disabled", sub, { claims: { iat: nowS() - 6 * 86400 }, events: { event_time: T - 6 * 86400e3 } }));
  assert.equal(r.status, 200, "inside the week");
  const off = async () => (await SSO.linkBySubject("apple", sub)).email_off;
  T += 1000;
  r = await notify(notification("email-disabled", sub, { events: { email: "rq@privaterelay.appleid.com", is_private_email: "true" } }));
  assert.equal(await off(), 1);
  // an email-enabled from ten minutes before that, arriving now
  r = await notify(notification("email-enabled", sub, { events: { event_time: T - 600e3, email: "rq@privaterelay.appleid.com" }, claims: { iat: nowS() - 600 } }));
  assert.equal(r.status, 200);
  assert.equal(await off(), 1, "the newer email-disabled stands");
  T += 1000;
  await notify(notification("email-enabled", sub, { events: { email: "rq@privaterelay.appleid.com", is_private_email: "true" } }));
  assert.equal(await off(), 0);
});

test("APPLE_APP_ID: notifications naming the primary App ID are refused without it (the admin card shows that + the newest accepted / refused)", async () => {
  delete process.env.APPLE_APP_ID;
  const sub = "000111.rep.0010";
  let h = await AS.noticeHealth();
  assert.equal(h.app_id, false);
  assert.equal(h.endpoint, base + "/auth/apple/notifications");
  assert.ok(h.last_ok && h.last_ok.at > 0, "the newest accepted one");
  let r = await notify(notification("email-enabled", sub, { claims: { aud: "tv.publicaccess.app" } }));
  assert.deepEqual([r.status, r.json.error], [400, "E_AUD"]);
  h = await AS.noticeHealth();
  assert.equal(h.last_refused.code, "E_AUD");
  process.env.APPLE_APP_ID = "tv.publicaccess.app";
  try {
    T += 1000;
    r = await notify(notification("email-enabled", sub, { claims: { aud: "tv.publicaccess.app" } }));
    assert.equal(r.status, 200);
    assert.equal((await AS.noticeHealth()).app_id, true);
  } finally { delete process.env.APPLE_APP_ID; }
  assert.match(fs.readFileSync(path.join(repo, "views", "admin", "users.ejs"), "utf8"), /notifications REFUSED until APPLE_APP_ID/);
  assert.match(fs.readFileSync(path.join(repo, ".env.example"), "utf8"), /# APPLE_APP_ID=/);
});

test("revocation queue: a failed unlink revocation never ends a NEWER link of the same Apple ID (dropped on re-link, and unsent at the tick)", async () => {
  await runQuery("DELETE FROM apple_revokes");
  const quinn = await mkUser("quinn");
  const b = browser("10.1.5.3");
  await b.post("/login", { username: "quinn", password: PASSWORD });
  T += 1000;
  await appleSignIn(b, { sub: "000111.q.0011" }, { link: true, refresh: "r-q-old" });
  assert.ok(await SSO.linkOf("apple", quinn.userId));
  const queued = async () => (await getQuery("SELECT COUNT(*) AS n FROM apple_revokes WHERE apple_sub = '000111.q.0011'"))[0].n;
  assert.equal(await queued(), 0, "the sign-in's token is on the link: nothing waits");
  APPLE.revokeStatus = 500;
  let r = await b.api("/api/sso/apple/unlink");
  APPLE.revokeStatus = 200;
  assert.deepEqual([r.json.removed, r.json.revoked], [true, false]);
  assert.equal(await queued(), 1, "Apple was down: queued");
  // the member links the same Apple ID again before the retry: revoking the old token would end the new authorization
  T += 60e3;
  await appleSignIn(b, { sub: "000111.q.0011" }, { link: true, refresh: "r-q-new" });
  assert.equal(await queued(), 0, "dropped");
  T += 30 * 60e3;
  APPLE.revokes.length = 0;
  await AS.revokeTick();
  assert.deepEqual(APPLE.revokes, []);
  // a queued one that is due while its Apple ID is linked (however it got there) is dropped unsent too
  await AS.queueRows([{ subject: "000111.q.0011", refresh_token_enc: AS.encryptToken("r-q-stale", "000111.q.0011") }], "unlinked");
  T += 6 * 60e3;
  await AS.revokeTick();
  assert.deepEqual(APPLE.revokes, []);
  assert.equal(await queued(), 0);
  const l = await SSO.linkOf("apple", quinn.userId);
  assert.equal(AS.decryptToken(l.refresh_token_enc, l.subject), "r-q-new");
});

test("an abandoned sign-in: Apple's token from a sign-up nobody finished is revoked after UNUSED_MS; a finished one, or a linked Apple ID's, never is", async () => {
  await runQuery("DELETE FROM apple_revokes");
  const why = async (sub) => (await getQuery("SELECT why FROM apple_revokes WHERE apple_sub = ?", [sub])).map((x) => x.why);
  // parked for /auth/sso/new and never finished
  const b = browser("10.1.5.4");
  T += 1000;
  await appleSignIn(b, { sub: "000111.ab.0012" }, { user: { name: { firstName: "Abe" } }, refresh: "r-ab-1" });
  assert.deepEqual(await why("000111.ab.0012"), ["unused"]);
  // a finished sign-up: its token is on the link, nothing waits
  const b2 = browser("10.1.5.5");
  await appleSignIn(b2, { sub: "000111.fin.0013" }, { user: { name: { firstName: "Fin" } }, refresh: "r-fin-1" });
  assert.deepEqual(await why("000111.fin.0013"), ["unused"]);
  await b2.post("/auth/sso/create", { username: "fin_apple" });
  assert.equal(b2.who(), "fin_apple");
  assert.deepEqual(await why("000111.fin.0013"), []);
  // a sign-in of that (linked) Apple ID whose hand-off is never collected: the browser went away after Apple's POST
  const b3 = browser("10.1.5.6");
  const st = await appleStart(b3);
  await appleReturn(b3, st, { sub: "000111.fin.0013" }, { refresh: "r-fin-lost" });
  assert.deepEqual(await why("000111.fin.0013"), ["unused"]);
  T += 60e3;
  APPLE.revokes.length = 0;
  await AS.revokeTick();
  assert.deepEqual(APPLE.revokes, [], "nothing before UNUSED_MS");
  T += AS.UNUSED_MS;
  await AS.revokeTick();
  assert.deepEqual(APPLE.revokes.map((x) => x.token), ["r-ab-1"], "only the abandoned sign-up's (revoking the other would end fin_apple's link)");
  assert.deepEqual([await why("000111.ab.0012"), await why("000111.fin.0013")], [[], []]);
  assert.equal(AS.decryptToken((await SSO.linkBySubject("apple", "000111.fin.0013")).refresh_token_enc, "000111.fin.0013"), "r-fin-1");
});

test("callback: another site's POSTs can't cancel a sign-in in progress or lock the network out; starts only from a top-level navigation here", async () => {
  const b = browser("10.1.5.7");
  const st = await appleStart(b);
  // another site's page auto-submits forms to the callback from the visitor's browser: the SameSite=None state cookie rides along
  for (let i = 0; i < 40; i++) {
    const r = await b.go("POST", "/auth/apple/callback", { state: "f".repeat(48), code: "x" }, { cross: true });
    assert.equal(r.status, 303);
  }
  assert.ok(b.jar.has("apple_sso") && b.jar.has("apple_sso_l"), "the sign-in in progress survives (both twins)");
  // a multi-byte state the same length as ours is just a mismatch
  assert.equal((await b.go("POST", "/auth/apple/callback", { state: "é".repeat(48), code: "x" }, { cross: true })).status, 303);
  // Apple's real answer still works, and the network isn't rate-limited
  const cb = await appleReturn(b, st, { sub: "000111.dos.0014" }, { user: { name: { firstName: "Dot" } } });
  assert.equal(cb.status, 303);
  assert.equal((await b.get("/auth/apple/continue")).location, "/auth/sso/new");
  assert.ok(!b.jar.has("apple_sso") && !b.jar.has("apple_sso_l"), "cleared once it matched (both twins)");
  // starts: another site's image / frame / link doesn't start one (no state cookie, not counted) - it lands on /login
  const g = browser("10.1.5.8");
  for (let i = 0; i < 20; i++) {
    const r = await g.go("GET", "/auth/apple", null, { headers: { "sec-fetch-dest": i % 2 ? "image" : "iframe", "sec-fetch-site": "cross-site" } });
    assert.equal(r.location, "/login");
    assert.ok(!r.setCookie.some((c) => c.startsWith("apple_sso=") || c.startsWith("apple_sso_l=")));
  }
  const nav = await g.go("GET", "/auth/apple", null, { headers: { "sec-fetch-dest": "document", "sec-fetch-site": "cross-site" } });
  assert.equal(nav.location, "/login");
  // the visitor's own click on the button still starts one
  const own = await g.go("GET", "/auth/apple", null, { headers: { "sec-fetch-dest": "document", "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" } });
  assert.match(own.location, /^https:\/\/appleid\.apple\.com\/auth\/authorize\?/);
});

// ───────────────────────── limits, pages, wiring ─────────────────────────
test("rate limits: Apple starts per network", async () => {
  const g = browser("10.6.0.1");
  let last;
  for (let i = 0; i < 13; i++) last = await g.get("/auth/apple");
  assert.equal(last.location, "/login", "the 13th start in 15 minutes is refused");
});

test("Settings -> Account: the Apple row (Continue with Apple / Unlink; a relay address shown as Hidden email, never spelled out)", async () => {
  const ejs = require("ejs");
  const layout = require(path.join(repo, "profilelayout"));
  const loc = (extra) => Object.assign({ username: "pb", displayname: "pb", twitchDisplayname: null, discordUsername: null, camfrogUsername: null,
    avatar: "/a.png", email: "", points_balance: 0, level: 41, classh: "Admin", profileCosmetics: null, layout: layout.sanitize(layout.DEFAULT),
    sections: layout.SECTIONS, subSections: layout.SUBS, privPanels: layout.PRIV, errors: [], success: [], ogPath: "/u/pb/edit", plex: { rows: [], member: null },
    plexLink: true, plexPin: null, user: "pb", cryptoW: null, telegram: null, google: null }, extra);
  const file = path.join(repo, "views", "settingsAccount.ejs");
  let html = await ejs.renderFile(file, loc({ apple: { on: true, linked: false } }));
  assert.match(html, /id="appleDiv"/);
  assert.match(html, /action="\/auth\/apple\/link" method="POST"/);
  assert.match(html, /Continue with Apple/);
  assert.match(html, /Core Member/, "the achievement hint");
  html = await ejs.renderFile(file, loc({ apple: { on: true, linked: true, name: "", email: "", relay: true, mailOff: true } }));
  assert.match(html, /data-apple-unlink/);
  assert.match(html, /Hidden email \(Apple relay\)/);
  assert.match(html, /forwarding to this address turned off/);
  assert.match(html, /\/api\/sso\/apple\/unlink/);
  assert.doesNotMatch(html, /Core Member/, "no hint once linked");
  html = await ejs.renderFile(file, loc({ apple: { on: false, linked: false } }));
  assert.doesNotMatch(html, /id="appleDiv"/, "hidden when Apple isn't set up");
  // the admin card has the switch
  const adm = fs.readFileSync(path.join(repo, "views", "admin", "users.ejs"), "utf8");
  assert.match(adm, /name="apple_sso"/);
});

test("wiring: the session method, the verified-identity proof, the Connections count, index.js mounts the cross-site routes before the session", async () => {
  assert.ok(SESS.METHODS.includes("apple"));
  const src = fs.readFileSync(path.join(repo, "user.controller.js"), "utf8");
  assert.match(src, /\["plex", "google", "apple", "telegram"/);
  const V = require(path.join(repo, "verified"));
  const kim = (await getQuery("SELECT userId FROM users WHERE username = 'kim'"))[0];
  V.forget(kim.userId);
  assert.ok((await V.tableProofs(kim.userId).catch(() => [])).includes("apple"), "a self link counts as a proven identity");
  const idx = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  const early = idx.indexOf("appleSso.registerEarly(app)"), sess = idx.indexOf("session({");
  assert.ok(early > 0 && sess > 0 && early < sess, "before express-session");
  assert.ok(idx.indexOf("app.use(loginSessions.gate)") < early, "after cookie-parser + the sessions gate");
  assert.match(idx, /appleSso: appleSso\.enabled\(\)/, "the button's flag for the auth pages");
});

// ───────────────────────── final-verification fixes ─────────────────────────
test("older Safari (iOS 12 / macOS 10.14 - WebKit bug 198181 takes SameSite=None as Strict): the attribute-less twin carries the sign-in; MACed and single use like the first", async () => {
  const lu = await mkUser("legacy_lu");
  await SSO.addLink("apple", lu.userId, { subject: "000111.leg.0020", proof: "oidc" });
  // that Safari never sends the SameSite=None cookie on Apple's cross-site POST - only the twin
  const b = browser("10.1.6.1", { legacy: true });
  const st = await appleStart(b);
  assert.ok(b.jar.has("apple_sso") && b.jar.has("apple_sso_l"));
  const cb = await appleReturn(b, st, { sub: "000111.leg.0020" });
  assert.equal(cb.status, 303); assert.equal(cb.location, "/auth/apple/continue");
  assert.ok(!b.jar.has("apple_sso") && !b.jar.has("apple_sso_l"), "both cleared once it matched");
  await b.get("/auth/apple/continue");
  assert.equal(b.who(), "legacy_lu", "signed in through the twin alone");
  // the twin is MACed: one changed byte -> expired, nobody signed in
  const c = browser("10.1.6.2", { legacy: true });
  const st2 = await appleStart(c);
  const tw = c.jar.get("apple_sso_l");
  c.jar.set("apple_sso_l", { ...tw, v: (tw.v[0] === "e" ? "f" : "e") + tw.v.slice(1) });
  await appleReturn(c, st2, { sub: "000111.leg.0020" });
  await c.get("/auth/apple/continue");
  assert.equal(c.who(), null);
  // single use: the very same POST replayed from another (older) browser with the captured twin
  const d = browser("10.1.6.3", { legacy: true });
  const st3 = await appleStart(d);
  const twin = { ...d.jar.get("apple_sso_l") };
  await appleReturn(d, st3, { sub: "000111.leg.0020" });
  await d.get("/auth/apple/continue");
  assert.equal(d.who(), "legacy_lu");
  const evil = browser("10.1.6.4", { legacy: true });
  evil.jar.set("apple_sso_l", twin);
  await appleReturn(evil, st3, { sub: "000111.leg.0020" });
  await evil.get("/auth/apple/continue");
  assert.equal(evil.who(), null, "a captured callback can't be replayed through the twin either");
  assert.match(await flashText(evil), /expired/);
  // a browser that sends BOTH (Safari today has no Lax default): whichever of the two carries this sign-in's state is used
  for (const which of ["apple_sso", "apple_sso_l"]) {
    const e = browser("10.1.6." + (which === "apple_sso" ? 5 : 6));
    const old = await appleStart(e);
    const stale = { ...e.jar.get(which) };            // an older sign-in's cookie...
    const cur = await appleStart(e);
    e.jar.set(which, stale);                           // ...left in one of the two
    e.jar.set("apple_sso_l", { ...e.jar.get("apple_sso_l"), sameSite: "none" });   // sent cross-site too
    assert.notEqual(old.state, cur.state);
    await appleReturn(e, cur, { sub: "000111.leg.0020" });
    await e.get("/auth/apple/continue");
    assert.equal(e.who(), "legacy_lu", "matched through " + (which === "apple_sso" ? "the twin" : "the first cookie"));
  }
});

test("the last-method guard holds under concurrent unlinks: Apple + Google at once on a no-password account leave exactly one; consent-revoked racing a Google unlink too", async (t) => {
  const signedIn = (b, u) => b.jar.set("jwt", { v: jwt.sign({ userId: u.userId, username: u.username, class: "pleb" }, process.env.SECRET_KEY), path: "/", sameSite: "lax" });
  // Google set up for this test (so a Google link counts as a way in)
  process.env.GOOGLE_CLIENT_ID = "1234567890-race.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "gsecret-race-1";
  t.after(() => { delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET; });
  for (let round = 0; round < 4; round++) {
    const u = await mkUser("racer" + round);
    await SSO.markPassword(u.userId, false);
    await SSO.addLink("google", u.userId, { subject: "g-racer-" + round, proof: "oidc" });
    const sub = "000111.race.000" + round;
    await SSO.addLink("apple", u.userId, { subject: sub, proof: "oidc", secret: AS.encryptToken("r-race-" + round, sub) });
    assert.deepEqual(await SSO.methods(u.userId), ["google", "apple"]);
    const b = browser("10.1.7." + (round + 1));
    signedIn(b, u);
    // both fired at once (round 2 and 3: the other order)
    const calls = [() => b.api("/api/sso/apple/unlink"), () => b.api("/api/sso/google/unlink")];
    const [a, g] = round < 2 ? await Promise.all(calls.map((f) => f())) : (await Promise.all(calls.reverse().map((f) => f()))).reverse();
    assert.deepEqual([a.status, g.status].sort(), [200, 409], `one unlink wins, the other is refused: ${a.status} ${g.status}`);
    assert.equal((a.status === 409 ? a : g).json.code, "E_LAST_METHOD");
    assert.equal((a.status === 200 ? a : g).json.removed, true);
    assert.equal((await SSO.methods(u.userId)).length, 1, "the account keeps a way in");
  }
  // Apple's consent-revoked (keep vs unlink is the same guard) racing the member's own Google unlink
  for (let round = 0; round < 2; round++) {
    const v = await mkUser("racer_n" + round);
    await SSO.markPassword(v.userId, false);
    await SSO.addLink("google", v.userId, { subject: "g-racer-n" + round, proof: "oidc" });
    const nsub = "000111.racen.000" + round;
    await SSO.addLink("apple", v.userId, { subject: nsub, proof: "oidc", secret: AS.encryptToken("r-racen-" + round, nsub) });
    T += 5000;
    const vb = browser("10.1.7." + (10 + round));
    signedIn(vb, v);
    const payload = notification("consent-revoked", nsub);
    const getKey = async () => appleKey.publicKey;
    const [n, g] = round === 0 ? await Promise.all([AS.onNotification(payload, { getKey }), vb.api("/api/sso/google/unlink")])
                               : (await Promise.all([vb.api("/api/sso/google/unlink"), AS.onNotification(payload, { getKey })])).reverse();
    assert.equal((await SSO.methods(v.userId)).length, 1, "the account keeps a way in");
    if (g.status === 200) {
      // Google went first: Apple is the only way in now -> the link stays, minus its token
      assert.equal(n.kept, true);
      const l = await SSO.linkOf("apple", v.userId);
      assert.ok(l && !l.refresh_token_enc);
    } else {
      assert.equal(g.status, 409); assert.equal(g.json.code, "E_LAST_METHOD");
      assert.equal(n.unlinked, true);
      assert.ok(await SSO.linkOf("google", v.userId));
    }
  }
  // the helper every guarded unlink uses: the check and the change in one transaction, nothing removed on a refusal
  const w = await mkUser("racer_w");
  await SSO.markPassword(w.userId, false);
  await SSO.addLink("google", w.userId, { subject: "g-racer-w", proof: "oidc" });
  let called = 0;
  await assert.rejects(SSO.unlinkGuarded(w.userId, "google", async () => { called++; }), (e) => e.code === "E_LAST_METHOD");
  assert.equal(called, 0);
  assert.equal(await SSO.unlinkGuarded(w.userId, "twitch", async () => "x"), "x", "not one of its methods: the guard lets it through");
  for (const f of ["googlesso.js", "applesso.js", "telegram.js", "plexmembers.js"]) {
    assert.match(fs.readFileSync(path.join(repo, f), "utf8"), /unlinkGuarded\(/, f + " unlinks through the guarded transaction");
  }
});
