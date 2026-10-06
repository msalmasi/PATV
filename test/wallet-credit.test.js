// /wallet credit score + welcome bonus + donations (1.99bg): my own score with its factors next to the
// borrow limit, the admins' request cards show each requester's live score, a lender can look up a
// borrower's score for the P2P form (linked users only), the pending welcome bonus card, and the
// donate / lend forms queue the same chat commands.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-credit-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const wallet = require(path.join(repo, "wallet"));
const welcome = require(path.join(repo, "welcome"));

const ago = (d) => new Date(Date.now() - d * 86400000).toISOString().replace("T", " ").slice(0, 19);
const TERMS = { rate_week: 0.03, max_days: 30, enabled: true, book: 0, room: 2_500_000, base: 10000, per_level: 2000, max_auto: 250000,
  max_open: 1, min: 1000, credit: { base: 580, min: 300, max: 850, capacity_base: 10000, capacity_per_level: 2000 } };
const H = (o) => Object.assign({ on_time: 0, late_repaid: 0, defaults: 0, late_now: 0, collections: 0, open_debt: 0, open_loans: 0, forgiven: 0 }, o);
const LIMITS = {
  alicecf: { repaid: 3, lates: 0, open: 0, late: false, reason: null, credit: H({ on_time: 3 }) },
  davecf: { repaid: 0, lates: 1, open: 0, late: false, reason: null, credit: H({ defaults: 1, late_repaid: 1, collections: 1 }) },
};

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0,
                  camfrogUsername TEXT, discordId TEXT, twitchId TEXT, email TEXT, isEmailVerified INTEGER DEFAULT 0,
                  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE IF NOT EXISTS markets (id INTEGER PRIMARY KEY, status TEXT, data TEXT)");
  for (const [id, name, cf, lv, days, cls] of [["u1", "alice", "AliceCF", 12, 200, "pleb"], ["u2", "boss", "bosscf", 40, 900, "Admin"],
    ["u3", "carol", null, 5, 30, "pleb"], ["u4", "dave", "davecf", 4, 40, "pleb"], ["u5", "newbie", "newbiecf", 0, 0.2, "pleb"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, level, points_balance, created_at, class) VALUES (?, ?, ?, 'x', ?, ?, 5000, ?, ?)",
      [id, name, name, cf, lv, ago(days), cls]);
  }
  await welcome.ready;
  await welcome.enroll("u5", "camfrog", null, null, "newbiecf");
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  app.use(express.json());
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  wallet.register(app, { isBotToken: (t) => t === "bot-token", addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  const r = await fetch(base + "/api/wallet/loans", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "bot-token", loans: [], reserve: { ...TERMS, limits: LIMITS },
      requests: [{ id: 7, nick: "davecf", amount: 400000, term: 1209600, why: "new hideout", status: "pending", created: Date.now() / 1000, credit: 470, credit_band: "Poor" }] }) });
  assert.equal(r.status, 200);
});
test.after(() => server.close());
const page = async (u, p = "/wallet") => (await fetch(base + p, { headers: u ? { "x-test-user": u } : {} }));

test("my credit score, band and factors sit next to my borrow limit", async () => {
  const h = await (await page("u1")).text();
  assert.match(h, /📊 Your credit score/);
  assert.match(h, /<span class="num">721<\/span>/);
  assert.match(h, /class="band good">Good/);
  assert.match(h, /3 loans repaid on time<\/span><b class="up">\+60/);
  assert.match(h, /Level 12<\/span><b class="up">\+36/);
  assert.ok(h.indexOf("Your credit score") > h.indexOf("you can borrow up to"), "after the limit card");
  assert.doesNotMatch(h, /davecf|462|470/, "nobody else's score");
});

test("admins see each requester's live score on the request cards", async () => {
  const h = await (await page("u2")).text();
  assert.match(h, /LR7/);
  assert.match(h, /📊 Credit <b>462<\/b> <span class="band poor">Poor/);
  assert.match(h, /was 470 when asked/);
});

test("a lender can look up a borrower's score; unlinked or signed-out can't", async () => {
  const r = await page("u1", "/wallet/credit?u=@davecf");
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.name, "davecf");
  assert.equal(d.score, 462);
  assert.equal(d.band, "Poor");
  assert.equal(d.top[0].key, "defaults");
  assert.equal((await page("u3", "/wallet/credit?u=davecf")).status, 403);
  assert.equal((await page(null, "/wallet/credit?u=davecf")).status, 401);
  assert.equal((await page("u1", "/wallet/credit?u=nobody")).status, 404);
  assert.equal((await page("u1", "/wallet/credit?u=%3Cscript%3E")).status, 400);
});

test("lend + donate forms queue the same chat commands", async () => {
  const h = await (await page("u1")).text();
  assert.match(h, /id="lend"><input type="hidden" name="kind" value="cmd"><input type="hidden" name="cmd" value="loan">/);
  assert.match(h, /id="donate"><input type="hidden" name="kind" value="cmd"><input type="hidden" name="cmd" value="donate">/);
  assert.match(h, /<option value="lotto">/);
});

test("a pending welcome bonus shows what's left to do", async () => {
  const h = await (await page("u5")).text();
  assert.match(h, /Welcome bonus: PAT 10,000 — on its way/);
  assert.match(h, /reach level 2/);
  assert.match(h, /active on 2 different days/);
  const a = await (await page("u1")).text();
  assert.doesNotMatch(a, /Welcome bonus/);
});
