// !signin (chatsignin.js): a one-time sign-in link for a Camfrog login linked to a REAL account - single use, 10 minutes, hash
// only, a new one cancels the old, 5 an hour; refused for unlinked / auto accounts (-> !signup), admins / staff and when the
// owner turned it off; redemption only by a same-origin POST (a GET or a cross-site POST spends nothing); the session is the
// normal login cookie; the security log + the inbox notice; the token never in the URL path.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "chatsignin-test-")));
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const jwt = require("jsonwebtoken");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const CS = require(path.join(repo, "chatsignin"));

const MIN = 60000;
const tokenOf = (url) => url.split("#t=")[1];
let base, server;

async function user(id, o = {}) {
  await runQuery(`INSERT INTO users (userId, username, email, password, class, camfrogUsername, auto_source) VALUES (?, ?, ?, 'x', ?, ?, ?)`,
                 [id, o.username || id, o.email === undefined ? `${id}@example.com` : o.email, o.class || "pleb", o.cf || null, o.auto || null]);
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, email TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  discordId TEXT, twitchId TEXT, camfrogUsername TEXT, points_balance INTEGER DEFAULT 0, auto_source TEXT, archived_at INTEGER)`);
  await runQuery("CREATE TABLE user_roles (userId TEXT, role TEXT)");
  await user("ann", { username: "ann", cf: "ann_cf" });
  await user("boss", { username: "boss", cf: "boss_cf", class: "Admin" });
  await user("mod", { username: "moddy", cf: "mod_cf" });
  await runQuery("INSERT INTO user_roles (userId, role) VALUES ('mod', 'Moderator')");
  await user("auto", { username: "CFaaaa1111", cf: "lurker", email: "k3j4h5g6f7d8s", auto: "camfrog" });
  await user("cur", { username: "curator1", cf: "cur_cf" });
  await runQuery("INSERT INTO user_roles (userId, role) VALUES ('cur', 'curator')");
  await CS.init();
  // the real routes on a tiny app (express json + urlencoded, a stub addUser and finishLogin through the real login cookie)
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.render = (v, locals) => res.type("html").send(`VIEW ${v} ${JSON.stringify(locals)}`); next(); });
  const uc = require(path.join(repo, "user.controller"));
  uc.finishLogin = async (req, res, u) => { require(path.join(repo, "middleware", "loginCookie")).issueLogin(res, u); return u; };
  CS.register(app, { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const post = (p, body, headers = {}) => fetch(base + p, { method: "POST", redirect: "manual",
  headers: Object.assign({ "content-type": "application/x-www-form-urlencoded", origin: base }, headers), body: new URLSearchParams(body).toString() });

test("a link for a linked real account: 32-char token in the FRAGMENT, hash only, 10 minutes, a new one cancels the old", async () => {
  const a = await CS.issue("ANN_cf");
  assert.equal(a.ok, true);
  assert.equal(a.username, "ann");
  assert.match(a.url, /\/signin#t=[A-Za-z0-9_-]{32}$/);
  assert.equal(a.minutes, 10);
  const t = tokenOf(a.url);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chat_signin_tokens WHERE token_hash = ?", [t]))[0].n, 0, "only the hash is stored");
  assert.deepEqual(await CS.peek(t), { ok: true, username: "ann" });
  const b = await CS.issue("ann_cf");
  assert.equal((await CS.peek(t)).ok, false, "the newer link cancels the older");
  assert.equal((await CS.peek(tokenOf(b.url))).ok, true);
  const old = await CS.issue("ann_cf", { now: Date.now() - 11 * MIN });
  assert.equal((await CS.peek(tokenOf(old.url))).ok, false, "expired after 10 minutes");
});

test("refused: unlinked or auto-only logins (-> !signup), admins and staff / moderators, the owner's switch off", async () => {
  assert.deepEqual(await CS.issue("nobody_here"), { ok: false, reason: "signup" });
  assert.deepEqual(await CS.issue("lurker"), { ok: false, reason: "signup" }, "Pepe's auto account is not a real account");
  assert.deepEqual(await CS.issue("boss_cf"), { ok: false, reason: "elevated" });
  assert.deepEqual(await CS.issue("mod_cf"), { ok: false, reason: "elevated" });
  assert.equal((await CS.issue("cur_cf")).ok, true, "a curator is a member");
  await CS.setEnabled("cur", false);
  assert.deepEqual(await CS.issue("cur_cf"), { ok: false, reason: "off" });
  assert.equal(await CS.enabledFor("ann"), true, "default on");
  const log = await getQuery("SELECT kind, why FROM chat_signin_log WHERE user_id = 'boss'");
  assert.deepEqual(log.map((x) => [x.kind, x.why]), [["refused", "elevated"]]);
});

test("the rate limit: 5 links an hour per login", async () => {
  await user("rl", { username: "ratelimited", cf: "rl_cf" });
  for (let i = 0; i < 5; i++) assert.equal((await CS.issue("rl_cf")).ok, true);
  assert.deepEqual(await CS.issue("rl_cf"), { ok: false, reason: "rate" });
  assert.equal((await CS.issue("rl_cf", { now: Date.now() + 61 * MIN })).ok, true, "an hour later");
});

test("redemption: only a same-origin POST; a GET or a cross-site POST spends nothing; single use; the normal login cookie", async () => {
  await getQuery("DELETE FROM chat_signin_tokens WHERE login = 'ann_cf'");
  const t = tokenOf((await CS.issue("ann_cf")).url);
  // a link scanner / preview: GET /signin (the token is in the fragment - never sent) and GET /signin?token=... both spend nothing
  const g = await fetch(`${base}/signin?token=${t}`);
  assert.equal(g.status, 200);
  assert.equal((await CS.peek(t)).ok, true, "a GET spends nothing");
  // cross-site POST, or one with no Origin / Referer at all: refused, nothing spent
  assert.equal((await post("/signin", { token: t }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await fetch(base + "/signin", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `token=${t}` })).status, 403);
  assert.equal((await CS.peek(t)).ok, true);
  // the peek API wants the fetch header + same origin
  assert.equal((await fetch(base + "/api/chatsignin/peek", { method: "POST", headers: { "content-type": "application/json", origin: base },
                                                              body: JSON.stringify({ token: t }) })).status, 403);
  const pk = await fetch(base + "/api/chatsignin/peek", { method: "POST", headers: { "content-type": "application/json", origin: base, "X-Requested-With": "fetch" },
                                                          body: JSON.stringify({ token: t }) });
  assert.deepEqual(await pk.json(), { ok: true, username: "ann" });
  // the button
  const r = await post("/signin", { token: t }, { "user-agent": "TestBrowser/1.0" });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/u/ann");
  const cookie = r.headers.get("set-cookie") || "";
  assert.match(cookie, /jwt=[^;]+;.*HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  const claims = jwt.verify(/jwt=([^;]+)/.exec(cookie)[1], "test-secret");
  assert.deepEqual([claims.userId, claims.username, claims.class], ["ann", "ann", "pleb"]);
  // single use
  const again = await post("/signin", { token: t });
  assert.equal(again.status, 410);
  assert.match(await again.text(), /"error":"expired"/);
  // the security log + the inbox notice (IP + browser)
  const log = await getQuery("SELECT kind, agent FROM chat_signin_log WHERE user_id = 'ann' AND kind = 'used'");
  assert.equal(log.length, 1);
  assert.equal(log[0].agent, "TestBrowser/1.0");
  const n = await getQuery("SELECT title, body FROM inbox WHERE user_id = 'ann'");
  assert.equal(n.length, 1);
  assert.match(n[0].title, /Signed in from chat/);
  assert.match(n[0].body, /TestBrowser\/1\.0/);
});

test("redemption re-checks the account: switched off, made staff or relinked after the link was sent -> refused", async () => {
  await user("eve", { username: "eve", cf: "eve_cf" });
  const t1 = tokenOf((await CS.issue("eve_cf")).url);
  await CS.setEnabled("eve", false);
  const r1 = await CS.redeem(t1, { signIn: async () => assert.fail("must not sign in") });
  assert.deepEqual(r1, { ok: false, error: "off" });
  await CS.setEnabled("eve", true);
  const t2 = tokenOf((await CS.issue("eve_cf")).url);
  await runQuery("UPDATE users SET class = 'Staff' WHERE userId = 'eve'");
  assert.deepEqual(await CS.redeem(t2, { signIn: async () => assert.fail("must not sign in") }), { ok: false, error: "elevated" });
  await runQuery("UPDATE users SET class = 'pleb' WHERE userId = 'eve'");
  const t3 = tokenOf((await CS.issue("eve_cf")).url);
  await runQuery("UPDATE users SET camfrogUsername = 'someone_else' WHERE userId = 'eve'");
  assert.deepEqual(await CS.redeem(t3, { signIn: async () => assert.fail("must not sign in") }), { ok: false, error: "expired" });
});

test("the owner's switch: Settings -> Security (signed in, same-origin fetch only)", async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { userId: "ann", username: "ann" }; next(); });
  CS.register(app, { isBotToken: () => false, addUser: (req, res, next) => next() });
  const s2 = app.listen(0);
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  try {
    const g = await (await fetch(b2 + "/api/settings/chat-signin")).json();
    assert.equal(g.enabled, true);
    assert.ok(g.log.some((x) => x.kind === "used"));
    assert.equal((await fetch(b2 + "/api/settings/chat-signin", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example", "X-Requested-With": "fetch" },
                                                                  body: JSON.stringify({ enabled: false }) })).status, 403);
    const p = await fetch(b2 + "/api/settings/chat-signin", { method: "POST", headers: { "content-type": "application/json", origin: b2, "X-Requested-With": "fetch" },
                                                              body: JSON.stringify({ enabled: false }) });
    assert.deepEqual(await p.json(), { ok: true, enabled: false });
    assert.deepEqual(await CS.issue("ann_cf"), { ok: false, reason: "off" });
  } finally { s2.close(); }
});

test("the bot route needs the bot token; the token never reaches a log line", async () => {
  assert.equal((await fetch(base + "/api/chatsignin/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: "eve_cf" }) })).status, 403);
  const src = fs.readFileSync(path.join(repo, "chatsignin.js"), "utf8");
  assert.ok(!/console\.(log|warn|error)\([^)]*token/i.test(src), "no console line prints a token");
});
