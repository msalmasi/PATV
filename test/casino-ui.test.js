// D10 (2026-10-11): the casino tables' design pass - the read-only additions the pages use, and the pages themselves:
//   * GET /api/casino/t/:id adds each seat's public avatar and a spectator count (web viewers, minus the seated)
//   * GET /api/casino/t/:id/history: revealed rounds only, the felt's public summary, never account ids
//   * GET /api/casino/lobby: the viewer's balance + High Roller flag, each table's latest proof link
//   * app.locals.casinoOn(game): the navbar's switch, from the cached casino settings
//   * the pages: lobby + table render from the shared partials, no hole cards in the HTML, and every page-script string
//     (__t "js.casino.*") has its English default in locales/en.json (CI translates from there)
//   NODE_PATH=G:/PATV/node_modules node --test test/casino-ui.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "casino-ui-test-"));
process.chdir(tmp);
delete process.env.STAGING;
const { runQuery } = require(path.join(repo, "dbUtils"));
const E = require(path.join(repo, "casino", "bjengine"));
const svc = require(path.join(repo, "casino", "service"));
const funding = require(path.join(repo, "funding"));

let server, base;
const users = { u1: { userId: "u1" }, u2: { userId: "u2" }, u3: { userId: "u3" } };
let app;
const H = (uid, ip) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" },
                                     uid ? { "x-test-user": uid } : {}, { "x-forwarded-for": ip || "10.0.0." + (uid ? uid.slice(1) : "99") });
const post = async (url, body, uid) => (await fetch(base + url, { method: "POST", headers: H(uid), body: JSON.stringify(body) })).json();
const get = async (url, uid, ip) => (await fetch(base + url, { headers: H(uid, ip) })).json();

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, level INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery(`CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL, points INTEGER NOT NULL,
                  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE user_roles (userId TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (userId, role))");
  await runQuery("CREATE TABLE welcome_bonus (userId TEXT PRIMARY KEY, dup_of TEXT)");
  for (const [id, u, d, av] of [["u1", "ann", "Ann", "https://cdn.example/ann.png"], ["u2", "bob", "Bob", "javascript:alert(1)"], ["u3", "cat", "Cat", null]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, points_balance, avatar) VALUES (?, ?, ?, 'x', 100000, ?)", [id, u, d, av]);
  }
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, amount) VALUES ('seed', 'seed', 10000000)");
  await runQuery("INSERT INTO user_roles (userId, role) VALUES ('u3', 'High Roller')");
  await funding.init();
  await svc.boot({ tick: false });
  await svc.setSetting("bj_enabled", "1", "test");
  await svc.setSetting("hm_enabled", "0", "test");
  const express = require("express");
  const routes = require(path.join(repo, "casino", "routes"));
  app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; const u = req.get("x-test-user"); req.user = u ? users[u] || null : null; next(); });
  routes.register(app, { isBotToken: () => false, addUser: (req, res, next) => next() });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { svc.stop(); if (server) server.close(); });

test("table view: seat avatars (only safe URLs), a spectator count without the seated; history = revealed rounds, no account ids", async () => {
  const open = await post("/api/casino/open", { game: "bj", idem: "ui-open-0001" }, "u1");
  assert.ok(open.ok, JSON.stringify(open));
  const tid = open.table;
  svc.S.rate.clear();
  assert.ok((await post(`/api/casino/t/${tid}/act`, { verb: "bet", amount: 500, idem: "ui-bet-ann-01" }, "u1")).ok);
  assert.ok((await post(`/api/casino/t/${tid}/act`, { verb: "bet", amount: 500, idem: "ui-bet-bob-01" }, "u2")).ok);
  let d = await get(`/api/casino/t/${tid}`, "u1");
  assert.deepEqual(d.table.seats.map((s) => [s.name, s.avatar]), [["Ann", "https://cdn.example/ann.png"], ["Bob", null]], "a javascript: avatar is dropped");
  // spectators: two signed-out viewers on different addresses + Cat; the seated players never count
  await get(`/api/casino/t/${tid}`, null, "10.9.9.1");
  await get(`/api/casino/t/${tid}`, null, "10.9.9.2");
  await get(`/api/casino/t/${tid}`, "u3");
  d = await get(`/api/casino/t/${tid}`, "u2");
  assert.equal(d.watching, 3);
  assert.ok(!JSON.stringify(d.table).includes('"u1"') && !JSON.stringify(d.table).includes('"u2"'), "no account ids in the view");

  // no rounds revealed yet
  assert.deepEqual((await get(`/api/casino/t/${tid}/history`)).rounds, []);
  svc.S.hooks.shoe = () => { const pre = ["Ts", "9h", "7d", "9s", "8h", "Kc"]; return pre.concat(E.makeShoe(6).slice(pre.length)); };
  svc.S.rate.clear();
  assert.ok((await post(`/api/casino/t/${tid}/act`, { verb: "deal", idem: "ui-deal-0001" }, "u1")).ok);
  for (const [u, k] of [["u1", "ui-st-ann-01"], ["u2", "ui-st-bob-01"]]) await post(`/api/casino/t/${tid}/act`, { verb: "stand", idem: k }, u);
  svc.S.hooks.shoe = null;
  const h = await (await fetch(base + `/api/casino/t/${tid}/history`)).text();
  const j = JSON.parse(h);
  assert.equal(j.rounds.length, 1);
  assert.equal(j.rounds[0].round, 1);
  assert.equal(j.rounds[0].proof, `/casino/fair/${tid}/1`);
  assert.ok(j.rounds[0].results.players.some((p) => p.name === "Ann"));
  assert.ok(!/"u[123]"/.test(h), "the history never carries account ids (the players column)");
  assert.equal((await fetch(base + "/api/casino/t/nothex/history")).status, 404);
});

test("lobby: the viewer's balance and High Roller flag; each row links its latest proof", async () => {
  const j = await get("/api/casino/lobby", "u3");
  assert.equal(j.me.balance, 100000);
  assert.equal(j.me.high_roller, true);
  const row = j.tables.find((t) => t.game === "bj");
  assert.match(row.proof, /^\/casino\/fair\/[0-9a-f]{10}\/1$/);
  assert.equal((await get("/api/casino/lobby")).me, null, "signed out: no balance");
  // 1.99ov: the limits the lobby shows (blackjack + the 💎 tables, the Hold'em High Roller ladder)
  assert.equal(j.limits.bj.max_bet, 100000);
  assert.equal(j.limits.bj.hr_max_bet, 1000000);
  assert.equal(j.limits.holdem.hr_ladder.length, 6);
  assert.deepEqual(j.limits.holdem.hr_ladder[5], [5000000, 10000000]);
});

test("casinoOn: the navbar switch follows the site flags (cached settings)", async () => {
  await svc.loadSettings(true);
  assert.equal(app.locals.casinoOn("bj"), true);
  assert.equal(app.locals.casinoOn("holdem"), false);
  await svc.setSetting("hm_enabled", "1", "test");
  assert.equal(app.locals.casinoOn("holdem"), true);
  await svc.setSetting("hm_enabled", "0", "test");
});

test("pages: the lobby and a table render from the shared partials; a Hold'em page never carries hole cards", async () => {
  let html = await (await fetch(base + "/casino/blackjack", { headers: H("u1") })).text();
  for (const s of ['id="cz-lobby"', 'id="cz-tables"', "casino-ui.js", "casinobj.js", 'data-game="bj"']) assert.ok(html.includes(s), s);
  const tid = svc.lobby().find((t) => t.game === "bj").id;
  html = await (await fetch(base + `/casino/blackjack/t/${tid}`, { headers: H("u1") })).text();
  for (const s of ['id="cz-table"', 'id="cz-dock"', 'id="cz-histsheet"', 'id="cz-host"', 'aria-live="polite"']) assert.ok(html.includes(s), s);
  // hold'em: open, sit two, deal; the page HTML has no cards at all (they come from the per-user API)
  await svc.setSetting("hm_enabled", "1", "test");
  const o = await post("/api/casino/open", { game: "holdem", blinds: "10/20", idem: "ui-open-hm-01" }, "u1");
  assert.ok(o.ok, JSON.stringify(o));
  svc.S.rate.clear();
  assert.ok((await post(`/api/casino/t/${o.table}/act`, { verb: "sit", amount: 1000, idem: "ui-sit-ann-01" }, "u1")).ok);
  assert.ok((await post(`/api/casino/t/${o.table}/act`, { verb: "sit", amount: 1000, idem: "ui-sit-cat-01" }, "u3")).ok);
  assert.ok((await post(`/api/casino/t/${o.table}/act`, { verb: "deal", idem: "ui-deal-hm-01" }, "u1")).ok);
  const me = await get(`/api/casino/t/${o.table}`, "u1");
  assert.equal(me.me.cards.length, 2);
  html = await (await fetch(base + `/casino/holdem/t/${o.table}`, { headers: H("u1") })).text();
  for (const c of me.me.cards) assert.ok(!html.includes(`"${c}"`), "no hole card in the page");
  assert.ok(html.includes("casinohm.js") && html.includes('id="cz-buy"'));
});

test("strings: every js.casino.* default in the page scripts equals locales/en.json; every view key exists", () => {
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  const seen = new Map();
  for (const f of ["casino-ui.js", "casinobj.js", "casinohm.js"]) {
    const src = fs.readFileSync(path.join(repo, "public", "js", f), "utf8");
    for (const m of src.matchAll(/\bT\("([a-z0-9_]+)",\s*"((?:[^"\\]|\\.)*)"/g)) {
      const key = "js.casino." + m[1], def = JSON.parse('"' + m[2] + '"');
      assert.equal(en[key], def, `${f}: ${key} default matches en.json`);
      if (seen.has(key)) assert.equal(seen.get(key), def, key + " has one English text");
      seen.set(key, def);
    }
    assert.doesNotMatch(src, /\bT\((?!")/, f + ": T() keys are literals (the i18n sync finds them)");
  }
  assert.ok(seen.size > 100);
  for (const f of ["casino-bj.ejs", "casino-hm.ejs", "partials/casino-top.ejs", "partials/casino-lobby.ejs", "partials/casino-sheets.ejs"]) {
    const src = fs.readFileSync(path.join(repo, "views", f), "utf8");
    for (const m of src.matchAll(/t\('(casino\.[a-z0-9_]+)'\)/g)) assert.ok(typeof en[m[1]] === "string", f + ": " + m[1]);
  }
});
