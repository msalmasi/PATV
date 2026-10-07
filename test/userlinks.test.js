// Clickable names (1.99dt, userlinks.js): a Camfrog login / PATV username on an economy page links to that
// person's profile - display name as the text, the login in the tooltip - in ONE users lookup per page.
// No live account (unknown, archived) -> the plain name; anonymised people (!incognito -> "someone") are
// never looked up; the 🌐 "made on the website" marker stays.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "userlinks-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const markets = require(path.join(repo, "markets"));
const UL = require(path.join(repo, "userlinks"));
const rooms = require(path.join(repo, "rooms"));

const now = Date.now() / 1000;
const B = 50000;
const M27 = {
  id: 27, model: "lmsr", question: "Will Bitcoin hit $87,000 today?", options: ["Yes", "No"], b: B, volume: 30000,
  q: { Yes: 0, No: 0 }, status: "settled", result: "No", settled_by: "pepefrog",
  creator: "ritchiecuh", judge: "pepefrog", room: "plant_based_chatting", created: now - 86400, closes: now - 3600, ended: now - 600,
  paid_out: { at: now - 600, total: 10000, result: "No" },
  positions: { foamy1111: { nick: "foamy1111", shares: { Yes: 10, No: 0 }, cost: { Yes: 10, No: 0 } } },
  trades: [
    { ts: now - 5000, nick: "foamy1111", side: "buy", option: "Yes", shares: 20000, pat: 10000, web: true },
    { ts: now - 4000, nick: "tsyko", side: "buy", option: "No", shares: 20000, pat: 10000, web: true },
    { ts: now - 3000, nick: "RitchieCuh", side: "buy", option: "No", shares: 20000, pat: 10000 },
    { ts: now - 2000, nick: "someone", side: "buy", option: "No", shares: 100, pat: 50 },
    { ts: now - 1000, nick: "<img src=x onerror=alert(1)>", side: "buy", option: "No", shares: 100, pat: 50 },
  ],
  history: [],
};

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0,
                  camfrogUsername TEXT, archived_at INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  const add = (id, username, displayname, cf, archived = null) => runQuery(
    "INSERT INTO users (userId, username, displayname, password, camfrogUsername, archived_at) VALUES (?, ?, ?, 'x', ?, ?)",
    [id, username, displayname, cf, archived]);
  await add("u1", "pb", "Foamy <3", "foamy1111");                  // linked web account: display name shown, login in the tooltip
  await add("u2", "CFa1b2c3d4", "CFa1b2c3d4", "foamy1111");          // Pepe's random auto account on the same login: never preferred
  await add("u3", "ritchie", "Ritchie", "ritchiecuh");
  await add("u4", "tsyko_old", "Tsyko", "tsyko", Date.now());        // archived: plain text
  await add("u5", "someone", "Someone Real", null);                   // even a real "someone" account: the anonymised name never links
  await rooms.init();
  await rooms.noteBridged("plant_based_chatting", "Houseplants");   // a known pad
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  app.use(express.json({ limit: "5mb" }));
  const addUser = (req, res, next) => { req.user = null; next(); };
  markets.register(app, { isBotToken: (t) => t === "bot-token", addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  const r = await fetch(base + "/api/markets/sync", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "bot-token", markets: [M27] }) });
  assert.equal(r.status, 200);
});
test.after(() => server.close());
const page = async (p) => (await fetch(base + p)).text();

test("an existing user is linked: display name, profile href, login in the title; 🌐 kept", async () => {
  const h = await page("/markets/27");
  assert.match(h, /<tr><td><a class="ulink" href="\/u\/pb" title="foamy1111">Foamy &lt;3<\/a>&nbsp;<span class="ulink-web" title="Made on the website">🌐<\/span><\/td>/);
  assert.doesNotMatch(h, /\/u\/CFa1b2c3d4/, "the real account wins over a random CF one on the same login");
  // the header: creator linked (by Camfrog login), case-insensitive in the trades too
  assert.match(h, /created by <a class="ulink" href="\/u\/ritchie" title="ritchiecuh">Ritchie<\/a> in <a class="pad-link" href="\/p\/[a-z0-9_-]+" title="p\/[a-z0-9_-]+">plant_based_chatting<\/a>/);
  assert.match(h, /<a class="ulink" href="\/u\/ritchie" title="RitchieCuh">Ritchie<\/a><\/td>/);
});

test("a missing or archived user stays plain text", async () => {
  const h = await page("/markets/27");
  assert.match(h, /judge pepefrog · created by/, "no account for pepefrog: plain");
  assert.match(h, /judged by pepefrog · settled /);   // 1.99dy: the settlement banner
  assert.match(h, /<tr><td>tsyko&nbsp;<span class="ulink-web"[^>]*>🌐<\/span><\/td>/, "archived: plain, marker kept");
  assert.doesNotMatch(h, /tsyko_old/);
  assert.doesNotMatch(h, /<!--ul/, "no marker is left in the page");
});

test("incognito / anonymised names are never looked up or linked; odd names stay escaped", async () => {
  const h = await page("/markets/27");
  assert.match(h, /<tr><td>someone<\/td>/);
  assert.doesNotMatch(h, /\/u\/someone/);
  assert.match(h, /<tr><td>&lt;img src=x onerror=alert\(1\)&gt;<\/td>/);
  assert.equal(UL.keyOf("someone"), "");
  assert.equal(UL.keyOf("@Foamy1111"), "foamy1111");
  assert.equal(UL.ul("foamy1111", { anon: true }), "foamy1111");
});

test("one users lookup per page, however many names", async () => {
  const seen = [];
  UL._setQuery((sql, args) => { if (/FROM users/.test(sql) && !/PRAGMA/.test(sql)) seen.push(sql); return getQuery(sql, args); });
  try {
    const before = UL.stats.lookups;
    await page("/markets/27");
    assert.equal(UL.stats.lookups - before, 1);
    assert.equal(seen.length, 1, "exactly one SELECT ... FROM users for the page");
    await page("/markets/27");
    assert.equal(UL.stats.lookups - before, 2, "and one more for the next page view");
  } finally { UL._setQuery(null); }
});

test("lookup() resolves logins and usernames, skips archived accounts", async () => {
  const m = await UL.lookup(["foamy1111", "PB", "tsyko", "tsyko_old", "nobody", "someone"]);
  assert.deepEqual(m.get("foamy1111"), { username: "pb", display: "Foamy <3" });
  assert.deepEqual(m.get("pb"), { username: "pb", display: "Foamy <3" });
  assert.equal(m.has("tsyko"), false);
  assert.equal(m.has("tsyko_old"), false);
  assert.equal(m.has("nobody"), false);
  assert.equal(m.has("someone"), false);
  assert.equal(UL.padLink("not_a_pad_<x>"), "not_a_pad_&lt;x&gt;", "an unknown room stays plain (escaped)");
  assert.equal(UL.padLink("", "a room"), "a room");
});
