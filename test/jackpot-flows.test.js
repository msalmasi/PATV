// Offline tests for jackpotflows.js (1.99gx): the House's site-side flows per America/New_York day for
// Pepe's vault flow table.
//   * classification: wheel stake / reseed / prize / refund, web blackjack, funded rewards, store boosts,
//     admin + Pepe's own (bot) adjustments, untagged legacy rows
//   * NY day boundaries (EDT 04:00 UTC, EST 05:00 UTC)
//   * open/close are the balance at the NY midnights; conservation: close - open == every row of the day
//   * a reseed whose spin was staked before the range is still a reseed (lookback)
//   * funding.takeFunds tags its House rows "fund:<flow>"
//   * the bot route needs the bot token
//   NODE_PATH=G:/PATV/node_modules node --test test/jackpot-flows.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jackpot-flows-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const JF = require(path.join(repo, "jackpotflows"));
const F = require(path.join(repo, "funding"));

let n = 0;
async function rake(spinId, amount, ts) {
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount, timestamp) VALUES (?, ?, ?, ?, ?)",
                 ["j" + (++n), spinId, "u1", amount, ts]);
}
async function spin(id, result = "SETTLED", type = "public") {
  await runQuery("INSERT INTO wheel_spins (spinId, userId, type, result) VALUES (?, 'u1', ?, ?)", [id, type, result]);
}
const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, points_balance INTEGER DEFAULT 0)`);
  await runQuery(`CREATE TABLE wheel_spins (spinId TEXT PRIMARY KEY, userId TEXT, type TEXT, result TEXT, payout INTEGER,
                  segment_index INTEGER, jackpot_pct INTEGER, transactionId TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery(`CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER NOT NULL,
                  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  // before the range: the opening balance (and a stake whose reseed lands on 10-07)
  await rake("bot:seed", 10000000, "2026-10-01 12:00:00");
  await spin("s0");
  await rake("s0", 5000, "2026-10-07 03:30:00");            // 10-06 23:30 NY: the stake (in the lookback)
  // 10-07 (NY) = 2026-10-07 04:00 .. 2026-10-08 04:00 UTC
  await rake("s0", -400000, "2026-10-07 04:00:05");         // its jackpot prize, after midnight
  await rake("s0", 120000, "2026-10-07 04:00:06");          // v1 reseed back to the floor
  await spin("s1"); await rake("s1", 5000, "2026-10-07 10:00:00"); await rake("s1", -2700, "2026-10-07 10:00:30");
  await spin("s2", "SETTLED", "gold"); await rake("s2", 5000, "2026-10-07 11:00:00"); await rake("s2", -46000, "2026-10-07 11:00:20");
  await spin("s3", "FAILED"); await rake("s3", 5000, "2026-10-07 12:00:00"); await rake("s3", -5000, "2026-10-07 12:05:00");
  await rake("bj:t1", 2000, "2026-10-07 13:00:00");
  await rake("bj:t2", -4000, "2026-10-07 13:01:00");
  await rake(null, 1000, "2026-10-07 13:02:00");            // a pre-1.99gx blackjack wager
  await rake("fund:levelup", -300, "2026-10-07 14:00:00");
  await rake("shop-order:7", 25000, "2026-10-07 15:00:00");
  await rake("admin:x", 50000, "2026-10-07 16:00:00");
  await rake("bot:y", 77777, "2026-10-07 17:00:00");        // Pepe's own: he logs it himself
  await rake("bot:z", -11111, "2026-10-07 18:00:00");
  await rake("0b7c-legacy-uuid", 999, "2026-10-07 19:00:00");
  await spin("s4"); await rake("s4", 5000, "2026-10-08 03:59:59");    // still 10-07 in New York
  // 10-08 (NY)
  await rake("s4", -5350, "2026-10-08 04:00:00");           // its prize: 10-08
  await rake("bot:w", 1, "2026-10-08 20:00:00");
  // 10-09: nothing at all
  const app = express();
  app.use(express.json());
  JF.register(app, { isBotToken: (t) => t === "bot-token" });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

test("NY day boundaries: EDT midnight is 04:00 UTC, EST midnight 05:00 UTC", () => {
  assert.equal(new Date(JF.nyMidnight("2026-10-07")).toISOString(), "2026-10-07T04:00:00.000Z");
  assert.equal(new Date(JF.nyMidnight("2027-01-15")).toISOString(), "2027-01-15T05:00:00.000Z");
  assert.equal(new Date(JF.nyMidnight("2026-11-01")).toISOString(), "2026-11-01T04:00:00.000Z");   // DST ends at 02:00 that day
  assert.equal(new Date(JF.nyMidnight("2026-11-02")).toISOString(), "2026-11-02T05:00:00.000Z");
  assert.equal(JF.nyDay(Date.UTC(2026, 9, 8, 3, 59, 59)), "2026-10-07");
  assert.equal(JF.nyDay(Date.UTC(2026, 9, 8, 4, 0, 0)), "2026-10-08");
  assert.equal(JF.nextDay("2026-12-31"), "2027-01-01");
});

test("each row is named by what made it; Pepe's own rows are kept apart", async () => {
  const [d7, d8, d9] = await JF.summary("2026-10-07", "2026-10-09");
  assert.equal(d7.day, "2026-10-07");
  assert.equal(d7.spins, 4, "s1, s2, s3, s4 staked on 10-07 (s0 was staked the day before)");
  assert.deepEqual(d7.in, { "wheel reseeds": 120000, "wheel spins": 20000, "web blackjack": 3000, "store boosts": 25000,
                            "admin (website)": 50000 });
  assert.deepEqual(d7.out, { "wheel prizes": 400000 + 2700 + 46000, "wheel refunds": 5000, "web blackjack": 4000,
                             "funded: levelup": 300 });
  assert.deepEqual(d7.bot, { in: 77777, out: 11111 });
  assert.deepEqual(d7.untagged, { in: 999, out: 0 });
  assert.equal(d8.spins, 0);
  assert.deepEqual(d8.out, { "wheel prizes": 5350 });
  assert.deepEqual(d8.bot, { in: 1, out: 0 });
  assert.deepEqual(d9.in, {}); assert.deepEqual(d9.out, {});
});

test("open/close are the balance at the NY midnights, and every day conserves", async () => {
  const days = await JF.summary("2026-10-07", "2026-10-09");
  assert.equal(days[0].open, 10000000 + 5000, "everything before 10-07 00:00 NY");
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const net = sum(d.in) - sum(d.out) + d.bot.in - d.bot.out + d.untagged.in - d.untagged.out;
    assert.equal(d.close - d.open, net, `${d.day} conserves`);
    if (i) assert.equal(d.open, days[i - 1].close, "a day opens where the last closed");
  }
  const total = (await getQuery("SELECT SUM(amount) AS t FROM jackpot_rakes"))[0].t;
  assert.equal(days[2].close, total);
  const one = await JF.summary("2026-10-08", "2026-10-08");
  assert.equal(one[0].open, days[1].open);
  assert.equal(one[0].close, days[1].close);
});

test("ranges are checked", async () => {
  await assert.rejects(JF.summary("2026-10-09", "2026-10-07"), /range/);
  await assert.rejects(JF.summary("2026-01-01", "2026-12-31"), /range/);
  await assert.rejects(JF.summary("yesterday", "2026-10-07"), /range/);
});

test("the route needs the bot token and answers the range", async () => {
  assert.equal((await post("/api/g/vault/jackpot-flows", { password: "nope", from: "2026-10-07", to: "2026-10-08" })).status, 403);
  assert.equal((await post("/api/g/vault/jackpot-flows", { from: "2026-10-07", to: "2026-10-08" })).status, 403);
  const r = await post("/api/g/vault/jackpot-flows", { password: "bot-token", from: "2026-10-07", to: "2026-10-08" });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.tz, "America/New_York");
  assert.deepEqual(r.body.days.map((d) => d.day), ["2026-10-07", "2026-10-08"]);
  assert.equal(r.body.days[0].in["wheel spins"], 20000);
  const bad = await post("/api/g/vault/jackpot-flows", { password: "bot-token", from: "2026-10-09", to: "2026-10-01" });
  assert.equal(bad.status, 400);
});

test("funding.takeFunds tags a House-paid reward fund:<flow>", async () => {
  F.sync({ reserve: 0, flows: { levelup: "jackpot" } });
  assert.equal(await F.takeFunds("levelup", 123, "u1", "level up"), true);
  const r = await getQuery("SELECT spinId, amount FROM jackpot_rakes WHERE amount = -123");
  assert.deepEqual(r.map((x) => [x.spinId, x.amount]), [["fund:levelup", -123]]);
});
