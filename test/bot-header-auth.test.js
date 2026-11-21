// 1.99aou: bot credentials in headers.
//   * userlookup.js requireBot: a request whose X-PATV-Key resolved passes with no X-Bot-Token at all; without a key it is
//     still 401 with no token and 403 with a wrong one (the middleware alone, then through the real botkeys.js middleware).
//   * index.js: Pepe's three polling GETs (/api/g/reserve-claims, /api/g/achievement-feed, /api/stale/notice-logins) read
//     the token from X-Bot-Token first; ?password= still works for older bots.
// Invented values only.
//   node --test test/bot-header-auth.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const repo = path.resolve(__dirname, "..");
const SHARED = "test-shared-token-not-real";
const DISCORD = "test-discord-token-not-real";
const THREE = ["/api/g/reserve-claims", "/api/g/achievement-feed", "/api/stale/notice-logins"];
// the exact credential expression the three routes use (pinned against index.js below, run by the mirror routes)
const HEADER_FIRST = 'isBotToken(req.get("x-bot-token") || req.query.password)';

// ── requireBot on its own (no database): the real middleware with an injected authority function ──
const source = fs.readFileSync(path.join(repo, "userlookup.js"), "utf8");
const context = { module: { exports: {} }, require: () => ({}) };
vm.runInNewContext(source, context);

function runRequireBot(headers, keyed) {
  let status = 200, advanced = false, asked = [];
  const req = { get: (name) => headers[String(name).toLowerCase()] };
  const res = { status(n) { status = n; return this; }, json() { return this; } };
  const isPlatformBot = (t) => { asked.push(t); return keyed || t === SHARED; };
  context.module.exports.requireBot(isPlatformBot)(req, res, () => { advanced = true; });
  return { status, advanced, asked };
}

test("requireBot: a resolved key passes with no token; otherwise 401 without a token, 403 with a wrong one", () => {
  const pick = ({ status, advanced }) => ({ status, advanced });
  assert.deepEqual(pick(runRequireBot({}, false)), { status: 401, advanced: false }, "anonymous");
  assert.deepEqual(pick(runRequireBot({ "x-bot-token": "wrong" }, false)), { status: 403, advanced: false }, "wrong token");
  assert.deepEqual(pick(runRequireBot({ authorization: "Bearer wrong" }, false)), { status: 403, advanced: false }, "wrong bearer");
  assert.deepEqual(pick(runRequireBot({ "x-bot-token": SHARED }, false)), { status: 200, advanced: true }, "the token");
  assert.deepEqual(pick(runRequireBot({ authorization: "Bearer " + SHARED }, false)), { status: 200, advanced: true }, "bearer");
  assert.deepEqual(pick(runRequireBot({}, true)), { status: 200, advanced: true }, "key only (was 401)");
  assert.deepEqual(pick(runRequireBot({ "x-bot-token": "wrong" }, true)), { status: 200, advanced: true }, "key + any token (as before)");
  assert.deepEqual(runRequireBot({}, false).asked, [null], "no token is asked as null (never a placeholder)");
});

test("index.js: the three polling GETs read X-Bot-Token before their ?password= fallback", () => {
  const index = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  for (const route of THREE) {
    const start = index.indexOf('app.get("' + route + '"');
    assert.ok(start >= 0, route);
    const head = index.slice(start, index.indexOf("\n", index.indexOf("\n", start) + 1));
    assert.ok(head.includes("if (!" + HEADER_FIRST + ") return res.status(403)"), route + ": " + head);
  }
  assert.doesNotMatch(index, /isBotToken\(req\.query\.password\)/, "no route reads the query string alone");
});

// ── through the real botkeys.js middleware (a temp DB; a key minted for the test) ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bot-header-auth-test-"));
process.chdir(tmp);                                      // dbUtils opens ./myapp.db
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret-not-real";
process.env.TWITCH_BOT_TOKEN = SHARED;
process.env.DISCORD_BOT_TOKEN = DISCORD;
const express = require("express");
const bk = require(path.join(repo, "botkeys"));
const userlookup = require(path.join(repo, "userlookup"));
const opsalerts = require(path.join(repo, "opsalerts"));
bk._setArgon({ t: 1, m: 64, p: 1 });                     // fast for tests
opsalerts.alert = async () => ({ admins: 0 });

let base, server, KEY;
test.before(async () => {
  await bk.init();
  KEY = (await bk.mint("pepe", "test caller", { userId: "u-test-owner", username: "test-owner" })).key;
  const app = express();
  app.use(express.json());
  app.use(bk.middleware);
  app.get("/api/users/camfrog/:login", userlookup.requireBot(bk.isPlatformBot), (req, res) => res.json({ ok: true }));
  const isBotToken = bk.isBotToken;
  // eslint-disable-next-line no-new-func
  const allowed = new Function("isBotToken", "req", "return " + HEADER_FIRST + ";");
  for (const route of THREE) {
    app.get(route, (req, res) => (allowed(isBotToken, req) ? res.json({ ok: true }) : res.status(403).json({ error: "unauthorized" })));
  }
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(async () => { if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); } });

const get = async (p, headers = {}) => (await fetch(base + p, { headers })).status;
const badKey = () => "pepe." + "A".repeat(43);           // well-formed, never minted

test("user lookups: key only -> 200 (was 401); no credentials 401; a wrong token 403; the legacy tokens still work", async () => {
  const p = "/api/users/camfrog/test-login";
  assert.equal(await get(p, { "x-patv-key": KEY }), 200, "the key alone");
  assert.equal(await get(p, { "x-patv-key": KEY, "x-bot-token": "wrong" }), 200, "the key with any token, as before");
  assert.equal(await get(p), 401, "nothing");
  assert.equal(await get(p, { "x-bot-token": "wrong" }), 403, "a wrong token");
  assert.equal(await get(p, { "x-bot-token": SHARED }), 200, "the shared token");
  assert.equal(await get(p, { "x-bot-token": DISCORD }), 200, "the Discord bot's token");
  assert.equal(await get(p, { "x-patv-key": badKey() }), 401, "a key that doesn't resolve is no key (no token -> 401)");
  assert.equal(await get(p, { "x-patv-key": badKey(), "x-bot-token": "wrong" }), 403);
});

test("the three polling GETs: the header, the key or the query fallback; nothing else", async () => {
  for (const route of THREE) {
    assert.equal(await get(route, { "x-bot-token": SHARED }), 200, route + ": header");
    assert.equal(await get(route, { "x-patv-key": KEY }), 200, route + ": key");
    assert.equal(await get(route + "?password=" + SHARED), 200, route + ": the query fallback (older bots)");
    assert.equal(await get(route), 403, route + ": nothing");
    assert.equal(await get(route, { "x-bot-token": "wrong" }), 403, route + ": a wrong header");
    assert.equal(await get(route + "?password=wrong"), 403, route + ": a wrong query");
    assert.equal(await get(route, { "x-bot-token": DISCORD }), 403, route + ": the Discord bot's token was never enough here");
  }
});
