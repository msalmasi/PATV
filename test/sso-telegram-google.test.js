// Offline tests for 1.99lb: Sign in with Telegram (telegramsso.js) + Sign in with Google (googlesso.js), the shared SSO flow
// (ssolinks.js: /auth/sso/new|create, link after a password sign-in), the last-method guard, and the Sign-in methods switches.
// Telegram and Google are stubs; nothing leaves the process.
//   NODE_PATH=G:/PATV/node_modules node --test test/sso-telegram-google.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sso-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.SENDGRID_API_KEY;
delete process.env.MEDIACTL_URL;
process.env.SECRET_KEY = "test-secret";
process.env.APP_SESSION_SECRET = "test-session-secret";
const BOT_TOKEN = "123456789:" + "A".repeat(20) + "bcdefghijklmn_-XYZ";
const CLIENT_ID = "test-client-1234.apps.googleusercontent.com";
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
process.env.GOOGLE_CLIENT_SECRET = "test-google-secret";

const express = require("express");
const session = require("express-session");
const flash = require("connect-flash");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const SSO = require(path.join(repo, "ssolinks"));
const CONF = require(path.join(repo, "ssoconf"));
const TG = require(path.join(repo, "telegram"));
const TGSSO = require(path.join(repo, "telegramsso"));
const GSSO = require(path.join(repo, "googlesso"));
const PM = require(path.join(repo, "plexmembers"));
const PLEXSSO = require(path.join(repo, "plexsso"));
const UC = require(path.join(repo, "user.controller"));
require(path.join(repo, "terms"))._setRequired && require(path.join(repo, "terms"))._setRequired(false);

let T = Date.now();
TGSSO._setClock(() => T);
GSSO._setClock(() => T);
SSO._setClock(() => T);

// ── Telegram: sign auth data like the Login Widget does ──
function tgAuth(fields, { token = BOT_TOKEN, at = Math.floor(T / 1000) } = {}) {
  const d = { auth_date: at, ...fields };
  const dcs = Object.keys(d).sort().map((k) => `${k}=${d[k]}`).join("\n");
  const secret = crypto.createHash("sha256").update(token).digest();
  return { ...d, hash: crypto.createHmac("sha256", secret).update(dcs).digest("hex") };
}

// ── Google: a test JWKS + ID tokens ──
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const KID = "test-kid-1";
const jwk = { ...publicKey.export({ format: "jwk" }), kid: KID, use: "sig", alg: "RS256" };
const b64u = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function idToken(claims, { key = privateKey, kid = KID, alg = "RS256" } = {}) {
  const h = b64u(JSON.stringify({ alg, kid, typ: "JWT" }));
  const p = b64u(JSON.stringify(claims));
  const sig = crypto.sign("RSA-SHA256", Buffer.from(h + "." + p), key);
  return `${h}.${p}.${b64u(sig)}`;
}
const nowS = () => Math.floor(T / 1000);
const baseClaims = (o) => ({ iss: "https://accounts.google.com", aud: CLIENT_ID, azp: CLIENT_ID, sub: "1000001", iat: nowS(), exp: nowS() + 3600,
                            nonce: "n-123", email: "x@gmail.test", email_verified: true, name: "X", ...o });
let GOOGLE_USER = null;            // claims (minus nonce) the fake token endpoint signs
const tokenCalls = [];
GSSO._setHttp({
  async get(url) {
    if (url === "https://www.googleapis.com/oauth2/v3/certs") return { status: 200, data: { keys: [jwk] }, headers: { "cache-control": "public, max-age=3600" } };
    return { status: 404, data: null, headers: {} };
  },
  async post(url, form) {
    tokenCalls.push(form);
    if (url !== "https://oauth2.googleapis.com/token") return { status: 404, data: null, headers: {} };
    const st = pendingGoogle.get(form.code);
    if (!st || form.client_id !== CLIENT_ID || form.client_secret !== "test-google-secret" || form.grant_type !== "authorization_code") return { status: 400, data: { error: "invalid_grant" }, headers: {} };
    // PKCE: S256(verifier) must be the challenge the browser was sent with
    if (b64u(crypto.createHash("sha256").update(form.code_verifier || "").digest()) !== st.challenge) return { status: 400, data: { error: "invalid_grant" }, headers: {} };
    return { status: 200, data: { access_token: "ya29.unused", id_token: idToken(baseClaims({ ...GOOGLE_USER, nonce: st.nonce })) }, headers: {} };
  },
});
const pendingGoogle = new Map();   // code -> {nonce, challenge}
let codeSeq = 0;

let base, server;
const PASSWORD = "correct horse battery 9";
async function mkUser(name, o = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, email, isEmailVerified, casino_banned)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [id, name, name, await bcrypt.hash(PASSWORD, 4), o.cls || "pleb", o.email || null, o.verified ? 1 : 0, o.banned ? 1 : 0]);
  return { userId: id, username: name, class: o.cls || "pleb" };
}
function browser(ip) {
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  async function go(method, p, body, json) {
    const headers = { "cf-connecting-ip": ip, cookie: cookieHeader() };
    let payload;
    if (json) { headers["content-type"] = "application/json"; headers["x-requested-with"] = "fetch"; payload = JSON.stringify(body || {}); }
    else if (body) { headers["content-type"] = "application/x-www-form-urlencoded"; payload = new URLSearchParams(body).toString(); }
    const r = await fetch(base + p, { method, headers, body: payload, redirect: "manual" });
    for (const c of r.headers.getSetCookie ? r.headers.getSetCookie() : []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (!v || /Expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(k); else jar.set(k, v);
    }
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch (e) { /* html */ }
    return { status: r.status, location: r.headers.get("location") || "", text, json: j };
  }
  return {
    jar, go,
    get: (p) => go("GET", p),
    post: (p, b) => go("POST", p, b || {}),
    api: (p, b) => go("POST", p, b || {}, true),
    who: () => { const t = jar.get("jwt"); if (!t) return null; try { return jwt.verify(decodeURIComponent(t), process.env.SECRET_KEY).username; } catch (e) { return null; } },
  };
}
const tgSignIn = (b, auth, next) => b.api("/auth/telegram/callback", { auth, next: next || "" });
async function googleSignIn(b, user, { link = false } = {}) {
  GOOGLE_USER = user;
  const s = link ? await b.post("/auth/google/link") : await b.get("/auth/google");
  assert.equal(s.status, 302);
  assert.match(s.location, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  const q = new URL(s.location).searchParams;
  assert.equal(q.get("client_id"), CLIENT_ID);
  assert.equal(q.get("redirect_uri"), base + "/auth/google/callback");
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("scope"), "openid email profile");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.ok(q.get("state") && q.get("nonce") && q.get("code_challenge"));
  const code = "code-" + (++codeSeq);
  pendingGoogle.set(code, { nonce: q.get("nonce"), challenge: q.get("code_challenge") });
  return { state: q.get("state"), cb: await b.get(`/auth/google/callback?code=${code}&state=${encodeURIComponent(q.get("state"))}`) };
}
const flashText = async (b) => (await b.get("/login")).text;

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
  await TG.init();
  await PM.init();

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
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
    plexSso: PLEXSSO.enabled(), tgSso: TGSSO.button(), googleSso: GSSO.enabled() }, extra || {});
  app.get("/login", addUser, (req, res) => {
    const sp = SSO.pendingFor(req);
    res.render("login", authView(req, sp ? { ssoPending: { provider: sp.provider, label: SSO.PROVIDERS[sp.provider].label, who: sp.handle ? "@" + sp.handle : sp.name } } : null));
  });
  app.get("/register", addUser, (req, res) => res.render("register", authView(req)));
  app.post("/login", UC.loginUser);
  SSO.register(app, { addUser, authView });
  TGSSO.register(app, { addUser });
  GSSO.register(app, { addUser });
  CONF.register(app, { addUser });
  TG.register(app, { isBotToken: (p) => p === "bot-secret", addUser });
  PM.register(app, { addUser, noTimers: true });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_BASE_URL = base;
});
test.after(() => { server && server.close(); });

// ───────────────────────── Telegram ─────────────────────────
test("Telegram hash verification: valid, tampered, wrong token, stale, future, malformed", () => {
  const good = tgAuth({ id: 42, first_name: "Ann", username: "ann_tg" });
  let v = TGSSO.verifyAuth(good, BOT_TOKEN, { now: T });
  assert.equal(v.ok, true); assert.equal(v.user.tg_id, "42"); assert.equal(v.user.handle, "ann_tg");
  assert.equal(TGSSO.verifyAuth({ ...good, id: 43 }, BOT_TOKEN, { now: T }).code, "E_HASH", "a changed id breaks the hash");
  assert.equal(TGSSO.verifyAuth({ ...good, username: "admin" }, BOT_TOKEN, { now: T }).code, "E_HASH");
  assert.equal(TGSSO.verifyAuth({ ...good, extra: "x" }, BOT_TOKEN, { now: T }).code, "E_HASH", "an added field breaks it too");
  assert.equal(TGSSO.verifyAuth(tgAuth({ id: 42 }, { token: "999:" + "B".repeat(35) }), BOT_TOKEN, { now: T }).code, "E_HASH", "signed by another bot");
  assert.equal(TGSSO.verifyAuth(tgAuth({ id: 42 }, { at: nowS() - 2 * 3600 }), BOT_TOKEN, { now: T }).code, "E_STALE");
  assert.equal(TGSSO.verifyAuth(tgAuth({ id: 42 }, { at: nowS() - 50 * 60 }), BOT_TOKEN, { now: T }).ok, true, "inside the hour");
  assert.equal(TGSSO.verifyAuth(tgAuth({ id: 42 }, { at: nowS() + 600 }), BOT_TOKEN, { now: T }).code, "E_FUTURE");
  assert.equal(TGSSO.verifyAuth({ id: 42, auth_date: nowS() }, BOT_TOKEN, { now: T }).code, "E_BAD", "no hash");
  assert.equal(TGSSO.verifyAuth({ ...good, hash: "zz" }, BOT_TOKEN, { now: T }).code, "E_BAD");
  assert.equal(TGSSO.verifyAuth(good, null, { now: T }).code, "E_OFF");
  assert.equal(TGSSO.verifyAuth(null, BOT_TOKEN).code, "E_BAD");
  assert.equal(TGSSO.verifyAuth({ ...good, id: { $gt: 1 } }, BOT_TOKEN).code, "E_BAD");
});

test("Telegram: a bridge-linked account signs in; replaying the same signed data is refused", async () => {
  const tom = await mkUser("tom");
  await runQuery("INSERT INTO telegram_links (user_id, tg_id, handle, link_source, proof, linked_at) VALUES (?, '7001', 'tomtg', 'self', 'start_code', ?)", [tom.userId, T]);
  const auth = tgAuth({ id: 7001, first_name: "Tom", username: "tomtg" });
  const b = browser("10.1.0.1");
  const r = await tgSignIn(b, auth, "/feed");
  assert.equal(r.status, 200); assert.equal(r.json.redirect, "/feed");
  assert.equal(b.who(), "tom");
  // replay (a captured payload, a fresh browser)
  const evil = browser("10.1.0.2");
  const again = await tgSignIn(evil, auth);
  assert.equal(again.json.ok, false); assert.equal(again.json.redirect, "/login");
  assert.equal(evil.who(), null, "single use");
  assert.match(await flashText(evil), /expired/);
  // cross-site / non-fetch posts are refused
  const raw = await evil.post("/auth/telegram/callback", { "auth[id]": "7001" });
  assert.equal(raw.status, 403);
});

test("Telegram: unlinked -> create an account (username prefilled), linked as the bridge's link; NOT matched by username", async () => {
  const sam = await mkUser("sam");    // a PATV user whose name equals the Telegram username - must not be picked
  const b = browser("10.1.0.3");
  const r = await tgSignIn(b, tgAuth({ id: 7002, first_name: "Sam", last_name: "T", username: "sam" }));
  assert.equal(r.json.redirect, "/auth/sso/new");
  assert.equal(b.who(), null, "NOT signed in as the PATV user 'sam'");
  const page = await b.get("/auth/sso/new");
  assert.equal(page.status, 200);
  assert.match(page.text, /action="\/auth\/sso\/create"/);
  assert.match(page.text, /value="sam1"/, "prefilled from Telegram, a FREE name");
  assert.match(page.text, /@sam/);
  let c = await b.post("/auth/sso/create", { username: "Sam" });
  assert.equal(c.location, "/auth/sso/new", "the taken name is refused (any case)");
  c = await b.post("/auth/sso/create", { username: "sam_tg" });
  assert.equal(c.status, 302);
  assert.equal(b.who(), "sam_tg");
  const nu = (await getQuery("SELECT * FROM users WHERE username = 'sam_tg'"))[0];
  const l = (await getQuery("SELECT * FROM telegram_links WHERE tg_id = '7002'"))[0];
  assert.equal(l.user_id, nu.userId); assert.equal(l.link_source, "self"); assert.equal(l.proof, "login_widget");
  assert.equal((await TG.whois({ tg_id: "7002" })).user.username, "sam_tg", "the bridge knows the account (alerts / commands)");
  assert.equal(nu.password_set, 0, "a random password: not a sign-in method");
  assert.equal(nu.email, null);
  assert.ok((await getQuery("SELECT 1 FROM welcome_bonus WHERE userId = ? AND source = 'telegram'", [nu.userId])).length, "sign-up welcome enrolment");
  assert.equal(sam.username, "sam");
  // next time: straight in
  const b2 = browser("10.1.0.4");
  T += 1000;
  await tgSignIn(b2, tgAuth({ id: 7002, first_name: "Sam", username: "sam" }));
  assert.equal(b2.who(), "sam_tg");
});

test("Telegram: \"I already have an account\" links after the password (only when the form asks); a banned account can't link", async () => {
  const uma = await mkUser("uma");
  const b = browser("10.1.0.5");
  await tgSignIn(b, tgAuth({ id: 7003, first_name: "Uma" }));
  const lp = await b.get("/login");
  assert.match(lp.text, /name="link_sso" value="telegram"/);
  await b.post("/login", { username: "uma", password: PASSWORD, link_sso: "telegram" });
  assert.equal(b.who(), "uma");
  assert.equal((await TG.linkByTg("7003")).user_id, uma.userId);
  // a plain sign-in elsewhere links nothing
  await mkUser("vic");
  const b2 = browser("10.1.0.6");
  T += 1000;
  await tgSignIn(b2, tgAuth({ id: 7004, first_name: "Vic" }));
  await b2.post("/login", { username: "vic", password: PASSWORD });
  assert.equal(b2.who(), "vic");
  assert.equal(await TG.linkByTg("7004"), null);
  // site-banned (global feed ban): Telegram isn't available -> the link is refused (like the bridge)
  const wes = await mkUser("wes");
  await runQuery("INSERT INTO feed_bans (user_id, room_id, until) VALUES (?, '', NULL)", [wes.userId]);
  const b3 = browser("10.1.0.7");
  T += 1000;
  await tgSignIn(b3, tgAuth({ id: 7005, first_name: "Wes" }));
  await b3.post("/login", { username: "wes", password: PASSWORD, link_sso: "telegram" });
  assert.equal(b3.who(), "wes", "the password sign-in itself works");
  assert.equal(await TG.linkByTg("7005"), null, "but nothing is linked");
  assert.match(await flashText(b3), /isn&#39;t available|isn't available/);
});

test("Telegram: a banned member already linked signs in exactly like with a password (the one finishLogin gate)", async () => {
  const xan = await mkUser("xan", { banned: true });
  await runQuery("INSERT INTO telegram_links (user_id, tg_id, link_source, proof, linked_at) VALUES (?, '7006', 'self', 'start_code', ?)", [xan.userId, T]);
  const b = browser("10.1.0.8");
  T += 1000;
  await tgSignIn(b, tgAuth({ id: 7006, first_name: "Xan" }));
  assert.equal(b.who(), "xan");
  assert.equal((await getQuery("SELECT casino_banned FROM users WHERE userId = ?", [xan.userId]))[0].casino_banned, 1);
  const src = fs.readFileSync(path.join(repo, "ssolinks.js"), "utf8") + fs.readFileSync(path.join(repo, "telegramsso.js"), "utf8") + fs.readFileSync(path.join(repo, "googlesso.js"), "utf8");
  assert.doesNotMatch(src, /issueLogin/, "no SSO module issues a login itself");
});

// ───────────────────────── Google ─────────────────────────
test("Google ID token verification: good, then bad signature / alg / kid / aud / azp / iss / exp / iat / nonce / sub", async () => {
  const getKey = async (kid) => (kid === KID ? publicKey : null);
  const v = (claims, o) => GSSO.verifyIdToken(idToken(claims, o), { clientId: CLIENT_ID, nonce: "n-123", now: T, getKey });
  const code = async (p) => { try { await p; return "OK"; } catch (e) { return e.code; } };
  assert.equal((await v(baseClaims())).sub, "1000001");
  assert.equal(await code(v(baseClaims({ iss: "accounts.google.com" }))), "OK", "both Google issuers");
  assert.equal(await code(v(baseClaims(), { key: other.privateKey })), "E_SIG");
  assert.equal(await code(v(baseClaims(), { alg: "HS256" })), "E_ALG");
  assert.equal(await code(v(baseClaims(), { alg: "none" })), "E_ALG");
  assert.equal(await code(v(baseClaims(), { kid: "nope" })), "E_KID");
  assert.equal(await code(v(baseClaims({ aud: "someone-else.apps.googleusercontent.com", azp: undefined }))), "E_AUD");
  assert.equal(await code(v(baseClaims({ aud: [CLIENT_ID, "x"], azp: "x" }))), "E_AUD");
  assert.equal(await code(v(baseClaims({ azp: "other" }))), "E_AUD");
  assert.equal(await code(v(baseClaims({ iss: "https://evil.example" }))), "E_ISS");
  assert.equal(await code(v(baseClaims({ exp: nowS() - 120 }))), "E_EXP");
  assert.equal(await code(v(baseClaims({ exp: nowS() - 30 }))), "OK", "60 s skew");
  assert.equal(await code(v(baseClaims({ iat: nowS() + 600 }))), "E_IAT");
  assert.equal(await code(v(baseClaims({ nonce: "n-999" }))), "E_NONCE");
  assert.equal(await code(v(baseClaims({ nonce: undefined }))), "E_NONCE");
  assert.equal(await code(v(baseClaims({ sub: "" }))), "E_SUB");
  assert.equal(await code(GSSO.verifyIdToken("a.b", { clientId: CLIENT_ID, nonce: "n", getKey })), "E_FORMAT");
  // a tampered payload (signature over the original)
  const tok = idToken(baseClaims()).split(".");
  tok[1] = b64u(JSON.stringify(baseClaims({ sub: "attacker" })));
  assert.equal(await code(GSSO.verifyIdToken(tok.join("."), { clientId: CLIENT_ID, nonce: "n-123", now: T, getKey })), "E_SIG");
});

test("Google: unlinked -> create; email verified only when Google says so AND unused; never auto-linked by (verified) email", async () => {
  const yan = await mkUser("yan", { email: "yan@gmail.test", verified: true });
  // a Google account with yan's verified email is NOT yan
  let b = browser("10.2.0.1");
  let { cb } = await googleSignIn(b, { sub: "g-1", email: "yan@gmail.test", email_verified: true, name: "Yan Q", given_name: "Yan" });
  assert.equal(cb.location, "/auth/sso/new");
  assert.equal(b.who(), null, "not signed in as yan");
  assert.ok(tokenCalls.length && !JSON.stringify(await getQuery("SELECT * FROM sso_links")).includes("ya29"), "the access token is never stored");
  const page = await b.get("/auth/sso/new");
  assert.match(page.text, /value="Yan1"/i);
  await b.post("/auth/sso/create", { username: "yan_g" });
  assert.equal(b.who(), "yan_g");
  let nu = (await getQuery("SELECT * FROM users WHERE username = 'yan_g'"))[0];
  assert.equal(nu.email, null, "yan's email stays yan's");
  const l = await SSO.linkBySubject("google", "g-1");
  assert.equal(l.user_id, nu.userId); assert.equal(l.proof, "oidc"); assert.equal(l.link_source, "self");
  assert.equal(yan.username, "yan");
  // a fresh email, verified by Google -> verified here
  b = browser("10.2.0.2");
  await googleSignIn(b, { sub: "g-2", email: "zed@gmail.test", email_verified: true, name: "Zed" });
  await b.post("/auth/sso/create", { username: "zed" });
  nu = (await getQuery("SELECT * FROM users WHERE username = 'zed'"))[0];
  assert.equal(nu.email, "zed@gmail.test"); assert.equal(nu.isEmailVerified, 1);
  // unverified -> kept, not verified
  b = browser("10.2.0.3");
  await googleSignIn(b, { sub: "g-3", email: "amy@other.test", email_verified: false, name: "Amy" });
  await b.post("/auth/sso/create", { username: "amyg" });
  nu = (await getQuery("SELECT * FROM users WHERE username = 'amyg'"))[0];
  assert.equal(nu.isEmailVerified, 0);
  // next time: straight in
  b = browser("10.2.0.4");
  ({ cb } = await googleSignIn(b, { sub: "g-2", email: "zed@gmail.test", email_verified: true }));
  assert.equal(cb.location, "/u/zed/wheel"); assert.equal(b.who(), "zed");
});

test("Google: state / single use / expiry / cancelled; \"I already have an account\" links", async () => {
  // a callback that never started here
  const s = browser("10.2.0.5");
  let r = await s.get("/auth/google/callback?code=x&state=abc");
  assert.equal(r.location, "/login"); assert.equal(s.who(), null);
  // wrong state
  let b = browser("10.2.0.6");
  GOOGLE_USER = { sub: "g-9" };
  await b.get("/auth/google");
  r = await b.get("/auth/google/callback?code=x&state=" + "0".repeat(48));
  assert.equal(r.location, "/login"); assert.equal(b.who(), null);
  // a good one, then replayed
  const bea = await mkUser("bea");
  b = browser("10.2.0.7");
  const { state } = await googleSignIn(b, { sub: "g-10", name: "Bea" });
  const lp = await b.get("/login");
  assert.match(lp.text, /name="link_sso" value="google"/);
  await b.post("/login", { username: "bea", password: PASSWORD, link_sso: "google" });
  assert.equal(b.who(), "bea");
  assert.equal((await SSO.linkBySubject("google", "g-10")).user_id, bea.userId);
  b.jar.delete("jwt");
  pendingGoogle.set("replay", { nonce: "x", challenge: "y" });
  r = await b.get(`/auth/google/callback?code=replay&state=${state}`);
  assert.equal(r.location, "/login"); assert.equal(b.who(), null, "the state is single use");
  // expired (> 10 minutes)
  b = browser("10.2.0.8");
  GOOGLE_USER = { sub: "g-10" };
  const st = await b.get("/auth/google");
  const q = new URL(st.location).searchParams;
  pendingGoogle.set("late", { nonce: q.get("nonce"), challenge: q.get("code_challenge") });
  T += 11 * 60 * 1000;
  r = await b.get(`/auth/google/callback?code=late&state=${q.get("state")}`);
  T += 1000;
  assert.equal(r.location, "/login"); assert.equal(b.who(), null);
  // cancelled at Google
  b = browser("10.2.0.9");
  await b.get("/auth/google");
  r = await b.get("/auth/google/callback?error=access_denied");
  assert.equal(r.location, "/login");
  assert.match(await flashText(b), /cancelled/);
});

test("Google: link from Edit profile (signed in), one per account, unlink", async () => {
  const cal = await mkUser("cal");
  const b = browser("10.2.0.10");
  await b.post("/login", { username: "cal", password: PASSWORD });
  assert.equal(b.who(), "cal");
  let { cb } = await googleSignIn(b, { sub: "g-20", email: "cal@gmail.test", email_verified: true }, { link: true });
  assert.equal(cb.location, "/settings/account#connections");   // 1.99vz: Connections live on Settings -> Account
  assert.equal((await SSO.linkOf("google", cal.userId)).subject, "g-20");
  // someone else's Google (already linked to zed) can't be linked here
  ({ cb } = await googleSignIn(b, { sub: "g-2" }, { link: true }));
  assert.equal((await SSO.linkBySubject("google", "g-2")).user_id, "u_zed".replace("u_zed", (await getQuery("SELECT userId FROM users WHERE username='zed'"))[0].userId));
  assert.equal((await SSO.linkOf("google", cal.userId)).subject, "g-20", "unchanged");
  // unlink (cal has a password)
  const r = await b.api("/api/sso/google/unlink");
  assert.equal(r.json.ok, true); assert.equal(r.json.removed, true);
  assert.equal(await SSO.linkOf("google", cal.userId), null);
});

// ───────────────────────── guard, limits, switches ─────────────────────────
test("the last-method guard: an SSO-only account can't unlink its only way in until it sets a password", async () => {
  const zed = (await getQuery("SELECT userId, username FROM users WHERE username = 'zed'"))[0];
  const b = browser("10.3.0.1");
  T += 1000;
  await googleSignIn(b, { sub: "g-2" });
  assert.equal(b.who(), "zed");
  assert.deepEqual(await SSO.methods(zed.userId), ["google"]);
  let r = await b.api("/api/sso/google/unlink");
  assert.equal(r.status, 409); assert.equal(r.json.code, "E_LAST_METHOD");
  assert.ok(await SSO.linkOf("google", zed.userId), "still linked");
  // a Telegram link too -> Google can go, but then Telegram is the last one
  await runQuery("INSERT INTO telegram_links (user_id, tg_id, link_source, proof, linked_at) VALUES (?, '7100', 'self', 'login_widget', ?)", [zed.userId, T]);
  r = await b.api("/api/sso/google/unlink");
  assert.equal(r.json.ok, true);
  r = await b.api("/api/telegram/unlink");
  assert.equal(r.status, 409); assert.equal(r.json.code, "E_LAST_METHOD");
  // the bot's /unlink is guarded the same way
  r = await b.api("/api/telegram/unlink-tg", { password: "bot-secret", tg_id: "7100" });
  assert.equal(r.status, 409); assert.equal(r.json.code, "E_LAST_METHOD");
  // a Plex link is guarded too
  const sam = (await getQuery("SELECT userId, username FROM users WHERE username = 'sam_tg'"))[0];
  await PM.linkSelf(sam, { plex_id: "8001", username: "samplex" });
  await runQuery("DELETE FROM telegram_links WHERE user_id = ?", [sam.userId]);
  await assert.rejects(PM.unlinkSelf(sam, "8001"), (e) => e.code === "E_LAST_METHOD");
  // setting a password lifts it
  await SSO.markPassword(zed.userId, true);
  r = await b.api("/api/telegram/unlink");
  assert.equal(r.json.ok, true);
  // a Twitch id counts as a way in
  await runQuery("UPDATE users SET twitchId = 'tw1' WHERE userId = ?", [sam.userId]);
  await PM.unlinkSelf(sam, "8001");
  // updatePassword marks password_set
  const src = fs.readFileSync(path.join(repo, "user.controller.js"), "utf8");
  assert.match(src.slice(src.indexOf("async function updatePassword")), /markPassword\(userId, true\)/);
  assert.match(fs.readFileSync(path.join(repo, "index.js"), "utf8"), /markPassword\(rows\[0\]\.userId, true\)/, "the reset sets it too");
});

test("rate limits: Telegram callbacks and Google starts per network", async () => {
  const b = browser("10.4.0.1");
  let last;
  for (let i = 0; i < 31; i++) last = await tgSignIn(b, { id: 1, hash: "x" });
  assert.match(await flashText(b), /Too many/);
  assert.equal(last.json.ok, false);
  const g = browser("10.4.0.2");
  for (let i = 0; i < 13; i++) last = await g.get("/auth/google");
  assert.equal(last.location, "/login", "the 13th start in 15 minutes is refused");
  // creating accounts shares the sign-up limit (createSsoAccount's per-network register limit)
  const ucSrc = fs.readFileSync(path.join(repo, "user.controller.js"), "utf8");
  assert.match(ucSrc.slice(ucSrc.indexOf("async function createSsoAccount")), /registerLimit\.blocked\(ip\)/);
});

test("switches + config: buttons show only when on AND configured; admin card API; no token in the page", async () => {
  let page = await browser("10.5.0.1").get("/login");
  assert.match(page.text, /href="\/auth\/google"/);
  assert.match(page.text, /data-tg-login data-bot="123456789"/);
  assert.match(page.text, /telegram\.org\/js\/telegram-widget\.js/);
  assert.ok(!page.text.includes(BOT_TOKEN.split(":")[1]), "the token's secret part is never in a page");
  page = await browser("10.5.0.1").get("/register");
  assert.match(page.text, /Sign up with Google/);
  await CONF.set({ telegram_sso: false, google_sso: false }, "test");
  page = await browser("10.5.0.2").get("/login");
  assert.doesNotMatch(page.text, /\/auth\/google|data-tg-login|telegram-widget/);
  const off = browser("10.5.0.2");
  assert.equal((await off.get("/auth/google")).location, "/login");
  assert.equal((await tgSignIn(off, tgAuth({ id: 7001 }))).json.ok, false);
  await CONF.set({ telegram_sso: true, google_sso: true }, "test");
  const tok = process.env.TELEGRAM_BOT_TOKEN, gid = process.env.GOOGLE_CLIENT_ID;
  delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.GOOGLE_CLIENT_ID;
  page = await browser("10.5.0.3").get("/login");
  assert.doesNotMatch(page.text, /\/auth\/google|data-tg-login/, "not configured: hidden even when switched on");
  assert.deepEqual(CONF.status().telegram, { switch: true, configured: false, on: false });
  process.env.TELEGRAM_BOT_TOKEN = tok; process.env.GOOGLE_CLIENT_ID = gid;
  // the admin card API: admins only
  const adm = await mkUser("boss", { cls: "Admin" });
  const a = browser("10.5.0.4");
  await a.post("/login", { username: "boss", password: PASSWORD });
  let r = await a.go("GET", "/api/admin/signin-methods");
  assert.equal(r.json.ok, true); assert.equal(r.json.google.on, true);
  assert.ok(!r.text.includes("test-google-secret") && !r.text.includes(BOT_TOKEN), "never the keys");
  r = await a.api("/api/admin/signin-methods", { google_sso: false });
  assert.equal(r.json.google.switch, false);
  assert.equal(GSSO.enabled(), false);
  await a.api("/api/admin/signin-methods", { google_sso: true });
  const pleb = browser("10.5.0.5");
  await pleb.post("/login", { username: "bea", password: PASSWORD });
  r = await pleb.api("/api/admin/signin-methods", { google_sso: false });
  assert.equal(r.status, 403);
  assert.equal(GSSO.enabled(), true);
  assert.equal(adm.class, "Admin");
});

test("Settings -> Account: Connections has a Google row (link / unlink) and the Telegram sign-in hint", async () => {
  const ejs = require("ejs");
  const layout = require(path.join(repo, "profilelayout"));
  const loc = (extra) => Object.assign({ username: "pb", displayname: "pb", twitchDisplayname: null, discordUsername: null, camfrogUsername: null,
    avatar: "/a.png", email: "", points_balance: 0, level: 41, classh: "Admin", profileCosmetics: null, layout: layout.sanitize(layout.DEFAULT),
    sections: layout.SECTIONS, subSections: layout.SUBS, privPanels: layout.PRIV, errors: [], success: [], ogPath: "/u/pb/edit", plex: { rows: [], member: null },
    plexLink: true, plexPin: null, user: "pb", cryptoW: null, telegram: null }, extra);
  const file = path.join(repo, "views", "settingsAccount.ejs");   // 1.99vz: moved from Edit profile
  let html = await ejs.renderFile(file, loc({ google: { on: true, linked: false, email: "" }, telegram: { linked: false, handle: null, signin: true } }));
  assert.match(html, /id="googleDiv"/);
  assert.match(html, /action="\/auth\/google\/link" method="POST"/);
  assert.match(html, /you can also sign in with Telegram/);
  html = await ejs.renderFile(file, loc({ google: { on: true, linked: true, email: "pb@gmail.test" } }));
  assert.match(html, /data-google-unlink/);
  assert.match(html, /pb@gmail\.test/);
  assert.match(html, /\/api\/sso\/google\/unlink/);
  html = await ejs.renderFile(file, loc({ google: { on: false, linked: false } }));
  assert.doesNotMatch(html, /id="googleDiv"/, "hidden when Google isn't set up");
});
