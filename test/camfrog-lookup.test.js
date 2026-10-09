// 1.99fz: GET /api/users/camfrog/:login is bot-only (userlookup.js) - 401 without the bot token, 403
// with a wrong one, a minimal field set (no balance / xp / password / email / tokens), and touch()
// (un-archive) only for the bot.
//   NODE_PATH=G:/PATV/node_modules node --test test/camfrog-lookup.test.js   (temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cf-lookup-test-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const stale = require(path.join(repo, "staleaccounts"));
const userlookup = require(path.join(repo, "userlookup"));

const SECRET_KEYS = /password|email|token|reset/i;

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, displayname TEXT, class TEXT DEFAULT 'pleb',
    email TEXT, password TEXT NOT NULL DEFAULT 'x', points_balance REAL DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0,
    liked INTEGER DEFAULT 0, discordId TEXT, discordUsername TEXT, twitchId TEXT, twitchDisplayname TEXT, twitchLogin TEXT,
    camfrogUsername TEXT, emailVerificationToken TEXT, tokenExpires DATETIME, isEmailVerified INTEGER DEFAULT 0,
    resetPasswordToken TEXT, resetPasswordExpires DATETIME, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT, note TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS user_roles (userId TEXT, role TEXT)");
  await runQuery("CREATE TABLE IF NOT EXISTS reserve_claims (claimId TEXT PRIMARY KEY, flow TEXT, userId TEXT, type TEXT, amount INTEGER, created DATETIME DEFAULT CURRENT_TIMESTAMP, settled INTEGER DEFAULT 0)");
  await runQuery("CREATE TABLE IF NOT EXISTS user_badges (userId TEXT, badgeId TEXT, awardedAt TEXT, PRIMARY KEY (userId, badgeId))");
  assert.equal(await stale.ensure(), true);

  const userRoles = async (id) => (await getQuery("SELECT role FROM user_roles WHERE userId = ?", [id])).map((r) => r.role);
  const app = express();
  userlookup.register(app, { isPlatformBot: (t) => t === "bot-token", stale, userRoles });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;

  await runQuery(`INSERT INTO users (userId, username, displayname, email, password, points_balance, xp, level, discordId, discordUsername,
      twitchId, camfrogUsername, emailVerificationToken, resetPasswordToken)
    VALUES ('cf1', 'CFabc12345', 'Froggy', 'cf1@example.com', '$2b$12$hashhashhash', 4321, 999, 7, 'D1', 'disc_cf1', 'T1', 'froglogin',
      'verify-tok', 'reset-tok')`);
  await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES ('t1', 'cf1', 'bonus win', 4321)");
  await runQuery("INSERT INTO user_roles (userId, role) VALUES ('cf1', 'high roller')");
});
test.after(() => server && server.close());

const row = async (id) => (await getQuery("SELECT * FROM users WHERE userId = ?", [id]))[0];
const get = (p, headers = {}) => fetch(base + p, { headers });
const BOT = { "x-bot-token": "bot-token" };

test("camfrog lookup: no token -> 401, wrong token -> 403, no user data either way", async () => {
  const r = await get("/api/users/camfrog/froglogin");
  assert.equal(r.status, 401);
  assert.equal((await r.json()).user, undefined);
  assert.equal((await get("/api/users/camfrog/froglogin", { "x-bot-token": "nope" })).status, 403);
  assert.equal((await get("/api/users/camfrog/froglogin", { authorization: "Bearer nope" })).status, 403);
  assert.equal((await get("/api/users/camfrog/froglogin?token=bot-token")).status, 401, "never a token in the URL");
  assert.equal((await get("/api/users/camfrog/nobody")).status, 401, "no existence oracle without a token");
});

test("camfrog lookup: the bot gets the minimal field set (+ roles), case-insensitive", async () => {
  for (const h of [BOT, { authorization: "Bearer bot-token" }]) {
    const r = await get("/api/users/camfrog/FrogLogin", h);
    assert.equal(r.status, 200);
    const { user: u } = await r.json();
    assert.deepEqual(Object.keys(u).sort(), [...userlookup.CAMFROG_FIELDS, "roles"].sort());
    assert.equal(u.userId, "cf1");
    assert.equal(u.username, "CFabc12345");
    assert.equal(u.displayname, "Froggy");
    assert.equal(u.camfrogUsername, "froglogin");
    assert.equal(u.discordId, "D1");
    assert.equal(u.level, 7);
    assert.ok(u.created_at);
    assert.deepEqual(u.roles, ["high roller"]);
    for (const k of ["points_balance", "xp", "discordUsername", "twitchId", "email", "password"]) assert.ok(!(k in u), `${k} returned`);
    for (const k of Object.keys(u)) assert.ok(!SECRET_KEYS.test(k), `secret field ${k}`);
    const raw = JSON.stringify(u);
    for (const s of ["hashhash", "verify-tok", "reset-tok", "@example.com", "4321", "disc_cf1"]) assert.ok(!raw.includes(s), `${s} leaked`);
  }
  assert.equal((await get("/api/users/camfrog/nobody", BOT)).status, 404);
});

test("camfrog lookup: touch() (un-archive) only fires for the bot", async () => {
  await stale.archiveOne("cf1", { runId: "t", tier: "A", why: "test" });
  assert.notEqual((await row("cf1")).archived_at, null);
  assert.equal((await row("cf1")).points_balance, 0);
  assert.equal((await get("/api/users/camfrog/froglogin")).status, 401);
  assert.equal((await get("/api/users/camfrog/froglogin", { "x-bot-token": "nope" })).status, 403);
  assert.notEqual((await row("cf1")).archived_at, null, "an unauthenticated caller un-archived it");
  assert.equal((await row("cf1")).points_balance, 0);
  const r = await get("/api/users/camfrog/froglogin", BOT);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).user.userId, "cf1");
  assert.equal((await row("cf1")).archived_at, null, "the bot's lookup restores it");
  assert.equal((await row("cf1")).points_balance, 4321);
});

test("index.js: the open camfrog lookup is gone; the bot-only one is registered with userRoles", () => {
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  assert.ok(!/app\.get\(['"]\/api\/users\/camfrog\/:/.test(src));
  assert.ok(src.includes('require("./userlookup").register(app, { isPlatformBot, stale, userRoles })'));
});
