// Offline tests for 1.99jr: "Sign in with Plex" (plexsso.js), the shared sign-in finish (user.controller finishLogin /
// createSsoAccount), Edit profile → Connections → 📼 Plex, and /subscriptions (moved from /settings/subscriptions).
// plex.tv is a stub; nothing leaves the process.
//   NODE_PATH=G:/PATV/node_modules node --test test/plex-sso.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plexsso-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.SENDGRID_API_KEY;
delete process.env.MEDIACTL_URL;
process.env.SECRET_KEY = "test-secret";
process.env.APP_SESSION_SECRET = "test-session-secret";

const express = require("express");
const session = require("express-session");
const flash = require("connect-flash");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const conf = require(path.join(repo, "mediaconf"));
const PM = require(path.join(repo, "plexmembers"));
const SSO = require(path.join(repo, "plexsso"));
const UC = require(path.join(repo, "user.controller"));
require(path.join(repo, "terms"))._setRequired && require(path.join(repo, "terms"))._setRequired(false);

let T = Date.now();
SSO._setClock(() => T);
SSO._setSleep(async () => {});

// ── a fake plex.tv: pins -> (once "signed in") a one-time token -> the user ──
const TOKEN = "plex-one-time-token-XYZ";
let PLEX_USER = null;              // what /api/v2/user answers
let pinSeq = 900;
const pinDone = new Set();
const calls = [];
PM._set({
  plexTv: async (method, p, hdr) => {
    calls.push({ method, p, token: hdr && hdr["X-Plex-Token"] });
    if (method === "POST" && p.startsWith("/api/v2/pins")) { pinSeq++; return { status: 201, json: { id: pinSeq, code: "code" + pinSeq } }; }
    const m = /^\/api\/v2\/pins\/(\d+)$/.exec(p);
    if (m) return { status: 200, json: pinDone.has(m[1]) ? { id: Number(m[1]), authToken: TOKEN } : { id: Number(m[1]) } };
    if (p === "/api/v2/user") return hdr && hdr["X-Plex-Token"] === TOKEN ? { status: 200, json: { ...PLEX_USER, authToken: TOKEN } } : { status: 401, json: null };
    return { status: 404, json: null };
  },
});

let base, server;
const PASSWORD = "correct horse battery 9";
async function mkUser(name, o = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, email, isEmailVerified, casino_banned)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [id, name, name, await bcrypt.hash(PASSWORD, 4), o.cls || "pleb", o.email || null, o.verified ? 1 : 0, o.banned ? 1 : 0]);
  return { userId: id, username: name, class: o.cls || "pleb" };
}

// a tiny cookie jar per "browser"
function browser(ip) {
  const jar = new Map();
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  async function go(method, p, body) {
    const headers = { "cf-connecting-ip": ip, cookie: cookieHeader() };
    let payload;
    if (body) { headers["content-type"] = "application/x-www-form-urlencoded"; payload = new URLSearchParams(body).toString(); }
    const r = await fetch(base + p, { method, headers, body: payload, redirect: "manual" });
    for (const c of r.headers.getSetCookie ? r.headers.getSetCookie() : []) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (!v || /Expires=Thu, 01 Jan 1970/i.test(c)) jar.delete(k); else jar.set(k, v);
    }
    const text = await r.text();
    return { status: r.status, location: r.headers.get("location") || "", text };
  }
  return {
    jar, go,
    get: (p) => go("GET", p),
    post: (p, b) => go("POST", p, b || {}),
    who: () => { const t = jar.get("jwt"); if (!t) return null; try { return jwt.verify(decodeURIComponent(t), process.env.SECRET_KEY).username; } catch (e) { return null; } },
  };
}
// start -> Plex "signs them in" -> back to the callback
async function plexSignIn(b, { finish = true } = {}) {
  const s = await b.get("/auth/plex");
  assert.equal(s.status, 302, "start redirects to Plex");
  assert.match(s.location, /^https:\/\/app\.plex\.tv\/auth#\?/);
  const q = new URLSearchParams(s.location.split("#?")[1]);
  assert.equal(q.get("forwardUrl"), base + "/auth/plex/callback");
  assert.ok(q.get("clientID") && q.get("clientID").startsWith("patv-"));
  const pin = String(pinSeq);
  if (finish) pinDone.add(pin);
  return { pin, cb: await b.get("/auth/plex/callback") };
}
const flashText = async (b) => (await b.get("/login")).text;

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, avatar TEXT, email TEXT UNIQUE, isEmailVerified INTEGER DEFAULT 0,
                  emailVerificationToken TEXT, tokenExpires DATETIME, camfrogUsername TEXT, discordId TEXT, twitchId TEXT, casino_banned INTEGER DEFAULT 0,
                  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery("CREATE TABLE IF NOT EXISTS badges (badgeId TEXT PRIMARY KEY, points INTEGER)");
  await runQuery("CREATE TABLE IF NOT EXISTS user_badges (userId TEXT, badgeId TEXT, awardedAt DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (userId, badgeId))");
  await runQuery("CREATE TABLE IF NOT EXISTS levelup_rewards (userId TEXT, level INTEGER, amount INTEGER, paid INTEGER DEFAULT 0, PRIMARY KEY (userId, level))");
  await runQuery("CREATE TABLE IF NOT EXISTS levelup_milestones (userId TEXT, level INTEGER, amount INTEGER, paid INTEGER DEFAULT 0, paid_at DATETIME, PRIMARY KEY (userId, level))");
  await runQuery("INSERT OR IGNORE INTO badges (badgeId, points) VALUES ('fresh_meat', 50)");
  await conf.init();
  await PM.init();

  const app = express();
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
    form: (() => { try { return JSON.parse(req.flash("authForm").slice(-1)[0] || "{}"); } catch (e) { return {}; } })(), next: "", plexSso: SSO.enabled() }, extra || {});
  app.get("/login", addUser, (req, res) => {
    const pp = SSO.pendingFor(req);
    res.render("login", authView(req, pp ? { plexPending: { username: pp.username } } : null));
  });
  app.post("/login", UC.loginUser);
  SSO.register(app, { addUser, authView });
  require(path.join(repo, "subscriptions")).register(app, { addUser, noTimers: true });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_BASE_URL = base;
});
test.after(() => { server && server.close(); });

test("a linked Plex account signs in (same login cookie as a password sign-in); the Plex token is never stored", async () => {
  const alice = await mkUser("alice");
  await PM.linkSelf(alice, { plex_id: "5001", username: "alicePlex", email: "alice@plex.test" });
  PLEX_USER = { id: 5001, username: "alicePlex", email: "alice@plex.test", confirmed: true };
  const b = browser("10.0.0.1");
  const { cb } = await plexSignIn(b);
  assert.equal(cb.status, 302);
  assert.equal(cb.location, "/u/alice/wheel");
  assert.equal(b.who(), "alice", "signed in as alice");
  const dump = JSON.stringify([await getQuery("SELECT * FROM plex_members"), await getQuery("SELECT * FROM plex_member_log"),
                               await getQuery("SELECT * FROM users")]);
  assert.ok(!dump.includes(TOKEN), "the Plex token isn't in the database");
  assert.ok(calls.some((c) => c.p === "/api/v2/user" && c.token === TOKEN), "the token was used once to read who it is");
  // signed in already: /auth/plex goes to Connections
  const again = await b.get("/auth/plex");
  assert.equal(again.location, "/u/alice/edit#connections");
});

test("NEVER auto-linked by email or username: an unlinked Plex account matching an existing account isn't signed in to it", async () => {
  const bob = await mkUser("bob", { email: "bob@example.test", verified: true });
  // a sync's email guess (link_source 'email') is not enough to sign in either
  await runQuery("INSERT INTO plex_members (plex_id, username, on_server, user_id, link_source, access) VALUES ('5002', 'bob', 1, ?, 'email', 'pre-existing')", [bob.userId]);
  PLEX_USER = { id: 5002, username: "bob", email: "bob@example.test", confirmed: true };
  const b = browser("10.0.0.2");
  const { cb } = await plexSignIn(b);
  assert.equal(cb.location, "/auth/plex/new", "offered: create / I already have an account");
  assert.equal(b.who(), null, "NOT signed in as bob");
  const page = await b.get("/auth/plex/new");
  assert.equal(page.status, 200);
  assert.match(page.text, /action="\/auth\/plex\/create"/);
  assert.match(page.text, /href="\/login"/);
  assert.match(page.text, /value="bob1"/, "the suggested username is a FREE one");
  // creating with bob's name is refused (unique username), the account isn't bob's
  let r = await b.post("/auth/plex/create", { username: "Bob" });
  assert.equal(r.location, "/auth/plex/new");
  assert.equal(b.who(), null);
  r = await b.post("/auth/plex/create", { username: "bobplex" });
  assert.equal(r.status, 302);
  assert.equal(b.who(), "bobplex", "a NEW account");
  const nu = (await getQuery("SELECT * FROM users WHERE username = 'bobplex'"))[0];
  assert.equal(nu.email, null, "bob's email stays bob's (never copied onto another account)");
  const row = (await getQuery("SELECT * FROM plex_members WHERE plex_id = '5002'"))[0];
  assert.equal(row.user_id, nu.userId, "the Plex account is linked to the new account (self)");
  assert.equal(row.link_source, "self");
  assert.equal((await getQuery("SELECT * FROM users WHERE userId = ?", [bob.userId]))[0].username, "bob", "bob untouched");
  assert.ok((await getQuery("SELECT 1 FROM welcome_bonus WHERE userId = ?", [nu.userId])).length, "the sign-up welcome bonus enrolment applies");
});

test("create with Plex: email verified only when Plex says so; the next Plex sign-in goes straight in", async () => {
  PLEX_USER = { id: 5003, username: "carol plex", email: "carol@plex.test", confirmed: true };
  let b = browser("10.0.0.3");
  await plexSignIn(b);
  assert.match((await b.get("/auth/plex/new")).text, /value="carol_plex"/);
  await b.post("/auth/plex/create", { username: "carol_plex" });
  let u = (await getQuery("SELECT * FROM users WHERE username = 'carol_plex'"))[0];
  assert.equal(u.email, "carol@plex.test"); assert.equal(u.isEmailVerified, 1);
  b = browser("10.0.0.3");
  const { cb } = await plexSignIn(b);
  assert.equal(cb.location, "/u/carol_plex/wheel"); assert.equal(b.who(), "carol_plex");

  PLEX_USER = { id: 5004, username: "dave", email: "dave@plex.test", confirmed: false };
  b = browser("10.0.0.4");
  await plexSignIn(b);
  await b.post("/auth/plex/create", { username: "davep" });
  u = (await getQuery("SELECT * FROM users WHERE username = 'davep'"))[0];
  assert.equal(u.isEmailVerified, 0, "an unconfirmed Plex email isn't marked verified");
  assert.ok(u.emailVerificationToken, "it gets the usual verification link");
});

test("\"I already have an account\": a password sign-in links the Plex account (only when that form asked)", async () => {
  const erin = await mkUser("erin");
  PLEX_USER = { id: 5005, username: "erinP", email: null };
  const b = browser("10.0.0.5");
  await plexSignIn(b);
  const lp = await b.get("/login");
  assert.match(lp.text, /name="link_plex" value="1"/);
  assert.match(lp.text, /erinP/);
  const r = await b.post("/login", { username: "erin", password: PASSWORD, link_plex: "1" });
  assert.equal(r.status, 302);
  assert.equal(b.who(), "erin");
  const row = (await getQuery("SELECT * FROM plex_members WHERE plex_id = '5005'"))[0];
  assert.equal(row.user_id, erin.userId); assert.equal(row.link_source, "self");
  // a plain password sign-in in another browser never links anything
  const frank = await mkUser("frank");
  PLEX_USER = { id: 5006, username: "frankP" };
  const b2 = browser("10.0.0.6");
  await plexSignIn(b2);
  await b2.post("/login", { username: "frank", password: PASSWORD });
  assert.equal(b2.who(), "frank");
  assert.equal((await getQuery("SELECT * FROM plex_members WHERE plex_id = '5006'")).length, 0, "no link without link_plex=1");
  assert.equal(frank.username, "frank");
});

test("expired, reused and unfinished Plex sign-ins are refused", async () => {
  const gina = await mkUser("gina");
  await PM.linkSelf(gina, { plex_id: "5007", username: "ginaP" });
  PLEX_USER = { id: 5007, username: "ginaP" };
  // expired: the pin is older than 10 minutes
  let b = browser("10.0.0.7");
  await b.get("/auth/plex");
  pinDone.add(String(pinSeq));
  T += 11 * 60 * 1000;
  let cb = await b.get("/auth/plex/callback");
  T -= 11 * 60 * 1000;
  assert.equal(cb.location, "/login"); assert.equal(b.who(), null);
  assert.match(await flashText(b), /expired/);
  // reused: the same browser replays the callback after a good sign-in
  b = browser("10.0.0.7");
  ({ cb } = await plexSignIn(b));
  assert.equal(b.who(), "gina");
  b.jar.delete("jwt");
  cb = await b.get("/auth/plex/callback");
  assert.equal(cb.location, "/login"); assert.equal(b.who(), null, "single use");
  // a callback that never started in this browser
  const stranger = browser("10.0.0.8");
  cb = await stranger.get("/auth/plex/callback");
  assert.equal(cb.location, "/login"); assert.equal(stranger.who(), null);
  // Plex never finished (no token)
  b = browser("10.0.0.7");
  ({ cb } = await plexSignIn(b, { finish: false }));
  assert.equal(cb.location, "/login"); assert.equal(b.who(), null);
  // a pending identity also expires: the create page sends them back
  PLEX_USER = { id: 5099, username: "lateP" };
  b = browser("10.0.0.9");
  await plexSignIn(b);
  T += 11 * 60 * 1000;
  const late = await b.get("/auth/plex/new");
  const lateCreate = await b.post("/auth/plex/create", { username: "latecomer" });
  T -= 11 * 60 * 1000;
  assert.equal(late.location, "/login"); assert.equal(lateCreate.location, "/login");
  assert.equal((await getQuery("SELECT 1 FROM users WHERE username = 'latecomer'")).length, 0);
});

test("a banned / restricted member signs in exactly like with a password (the one finishLogin gate), and stays restricted", async () => {
  const hank = await mkUser("hank", { banned: true });
  await PM.linkSelf(hank, { plex_id: "5010", username: "hankP" });
  PLEX_USER = { id: 5010, username: "hankP" };
  const b = browser("10.0.0.10");
  const { cb } = await plexSignIn(b);
  assert.equal(b.who(), "hank");
  assert.equal(cb.location, "/u/hank/wheel");
  assert.equal((await getQuery("SELECT casino_banned FROM users WHERE userId = ?", [hank.userId]))[0].casino_banned, 1, "the casino ban stays");
  const pw = browser("10.0.0.11");
  await pw.post("/login", { username: "hank", password: PASSWORD });
  assert.equal(pw.who(), "hank", "password sign-in: the same outcome");
  // both paths finish through user.controller finishLogin (where any sign-in gate lives)
  const src = fs.readFileSync(path.join(repo, "user.controller.js"), "utf8");
  const login = src.slice(src.indexOf("async function loginUser"), src.indexOf("// Update username"));
  assert.match(login, /await finishLogin\(req, res, user, "sign-in"\)/);
  assert.doesNotMatch(login, /issueLogin\(/, "no second way to issue the login");
  const sso = fs.readFileSync(path.join(repo, "plexsso.js"), "utf8");
  assert.doesNotMatch(sso, /issueLogin/, "plexsso never issues a login itself");
  assert.ok((sso.match(/finishLogin\(/g) || []).length >= 2);
  // an archived account comes back on a Plex sign-in too (the gate's stale-account restore)
  assert.ok(/staleaccounts"\)\.touch/.test(src.slice(src.indexOf("async function finishLogin"), src.indexOf("async function createSsoAccount"))));
});

test("plex_sso off: no button, /auth/plex refuses; rate limit on starts", async () => {
  await conf.set({ plex_sso: false }, "test");
  assert.equal(conf.get().plex_sso, false);
  const off = browser("10.0.0.12");
  assert.equal((await off.get("/auth/plex")).location, "/login");
  assert.doesNotMatch((await off.get("/login")).text, /href="\/auth\/plex/, "no Plex button");
  await conf.set({ plex_sso: true }, "test");
  assert.match((await browser("10.0.0.13").get("/login")).text, /href="\/auth\/plex"/, "on: the Plex button");
  const b = browser("10.0.0.14");
  let last;
  for (let i = 0; i < 13; i++) last = await b.get("/auth/plex");
  assert.equal(last.location, "/login", "the 13th start in 15 minutes from one network is refused");
});

test("/settings/subscriptions redirects to /subscriptions (query kept)", async () => {
  const b = browser("10.0.0.15");
  const r = await b.get("/settings/subscriptions?plex=123");
  assert.equal(r.status, 301);
  assert.equal(r.location, "/subscriptions?plex=123");
  const s = await b.get("/subscriptions");
  assert.equal(s.location, "/login?next=%2Fsubscriptions");
});

test("Edit profile: Connections has 📼 Plex (link / unlink / member status) and one pill style in the hero", async () => {
  const ejs = require("ejs");
  const layout = require(path.join(repo, "profilelayout"));
  const loc = (plex, extra) => Object.assign({ username: "pb", displayname: "pb", twitchDisplayname: null, discordUsername: null, camfrogUsername: null,
    avatar: "/a.png", email: "", points_balance: 0, level: 41, classh: "Admin", profileCosmetics: null, layout: layout.sanitize(layout.DEFAULT),
    sections: layout.SECTIONS, subSections: layout.SUBS, privPanels: layout.PRIV, errors: [], success: [], ogPath: "/u/pb/edit", plex, plexLink: true, plexPin: null }, extra);
  const file = path.join(repo, "views", "editProfile.ejs");
  let html = await ejs.renderFile(file, loc({ rows: [], member: null }));
  assert.match(html, /id="plexDiv"/);
  assert.match(html, /id="plexLinkBtn" data-back="profile"/);
  assert.match(html, /href="\/subscriptions"/);
  assert.match(html, /\/public\/js\/plex-link\.js/);
  assert.doesNotMatch(html, /class="chip pv"/, "the Preview pill no longer shares the privacy panel's .pv class");
  assert.match(html, /class="chip chip-preview"/);
  html = await ejs.renderFile(file, loc({ rows: [{ plex_id: "77", username: "pbplex", on_server: 1, pending: 0, access: "monthly", expires: Date.UTC(2026, 10, 1), link_source: "self", active: true }],
                                          member: { plex_id: "77", username: "pbplex", access: "monthly", expires: Date.UTC(2026, 10, 1) } }));
  assert.match(html, /pbplex/);
  assert.match(html, /data-plex-unlink="77"/);
  assert.match(html, /2026-11-01/);
  html = await ejs.renderFile(file, loc({ rows: [{ plex_id: "78", username: "adm", on_server: 1, pending: 0, access: "manual", link_source: "admin", active: true }], member: null }));
  assert.doesNotMatch(html, /data-plex-unlink/, "an admin's link can't be undone here");
  const css = fs.readFileSync(file, "utf8");
  assert.match(css, /\.pe \.chips \{ display: flex; flex-wrap: wrap; align-items: center;/);
  assert.match(css, /\.pe \.chip \{ display: inline-flex; align-items: center;[^}]*height: 24px;[^}]*line-height: 1;/);
});

test("the start route links back where it started (profile vs subscriptions)", async () => {
  const u = await mkUser("ivy");
  const p = await PM.linkStart(u, { back: "profile" });
  assert.match(decodeURIComponent(p.url), /forwardUrl=.*\/u\/ivy\/edit\?plex=\d+/);
  const s = await PM.linkStart(u);
  assert.match(decodeURIComponent(s.url), /forwardUrl=.*\/subscriptions\?plex=\d+/);
});
