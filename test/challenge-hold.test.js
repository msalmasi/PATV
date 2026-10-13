// Offline tests for economy v2 E-8 on the site (challengepay.js holds; camfrog-bot pepe_challenge.py with econ_challenges):
//   * a hold moves the prize room:<id> -> chalhold (keyed, once), counted as paid by the 24 h (5%) and 7-day (15%) caps
//   * resolve pays min(prize, held) from the hold to the winner and returns the rest to the pad vault, keyed, once
//   * glory (no winner) returns everything; a hold Pepe never resolved goes back by itself after hold_ttl_min (expired)
//   * the supply never moves: pools + wallets are the same before and after every step
//   * pools still in Pepe -> pools_local (Pepe keeps the interim path); the pad page list (no names for incognito)
//   NODE_PATH=G:/PATV/node_modules node --test test/challenge-hold.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "challenge-hold-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const B = require(path.join(repo, "boosts"));
const CP = require(path.join(repo, "challengepay"));
const P = require(path.join(repo, "pools"));
const rooms = require(path.join(repo, "rooms"));
const S = require(path.join(repo, "mainstage"));

const MIN = 60000, HOUR = 3600000, DAY = 24 * HOUR;
let T = Date.UTC(2026, 9, 20, 18, 0, 0);
rooms._setClock(() => T); B._setClock(() => T); S._setClock(() => T); CP._setClock(() => T);
const PLANT = "plant_based_chatting";
let base, server, singer;

const supply = async () => {
  const p = (await getQuery("SELECT COALESCE(SUM(balance),0) AS t FROM pools"))[0].t;
  const w = (await getQuery("SELECT COALESCE(SUM(points_balance),0) AS t FROM users"))[0].t;
  return Number(p) + Number(w);
};
const pool = async (k) => Number(((await getQuery("SELECT balance FROM pools WHERE key = ?", [k]))[0] || { balance: 0 }).balance);
const bal = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  await runQuery("INSERT INTO users (userId, username, password, points_balance, camfrogUsername) VALUES ('o1', 'pb', 'x', 0, 'foamy1111'), ('s1', 'singer', 'x', 1000, 'singer')");
  singer = { userId: "s1" };
  await S.init(); await rooms.init(); await B.init(); await CP.init(); await P.init();
  await rooms.setOwner(PLANT, "foamy1111", "test");
  await runQuery("INSERT INTO pools (key, label, balance, updated) VALUES (?, '', 1000000, 0), ('fortknox', '', 5000000, 0)", ["room:" + PLANT]);
  const app = express();
  app.use(express.json());
  CP.register(app, { addUser: (req, res, next) => next(), isBotToken: (t) => t === "bot-token" });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { CP._stopSweeper(); if (server) server.close(); });
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot-token" }, body)) })
  .then((r) => r.json().then((j) => Object.assign({ status: r.status }, j)));

test("pools still in Pepe: the hold answers pools_local (Pepe keeps the interim path)", async () => {
  const r = await post(`/api/rooms/${PLANT}/challenge/hold`, { ref: "AC1-1", amount: 20000, min: 5000 });
  assert.equal(r.ok, false); assert.equal(r.code, "pools_local");
  await P._setMeta("live", true); P._forgetLive();
});

test("hold: room -> chalhold, keyed once; the 24 h cap counts held prizes as paid", async () => {
  const s0 = await supply();
  let r = await post(`/api/rooms/${PLANT}/challenge/hold`, { ref: "AC1-1", amount: 20000, min: 5000, pct: 5, cap: 60000, cat: "sing", login: "singer" });
  assert.equal(r.ok, true); assert.equal(r.held, 20000);
  assert.equal(await pool("room:" + PLANT), 980000); assert.equal(await pool("chalhold"), 20000);
  r = await post(`/api/rooms/${PLANT}/challenge/hold`, { ref: "AC1-1", amount: 20000, min: 5000 });   // the same ref: the first answer
  assert.equal(r.dup, true); assert.equal(r.held, 20000); assert.equal(await pool("chalhold"), 20000);
  // 5% of (980k + 20k held) = 50k a day: 20k + 20k + 10k, then nothing
  assert.equal((await post(`/api/rooms/${PLANT}/challenge/hold`, { ref: "AC2-1", amount: 20000, min: 5000, pct: 5, cap: 60000 })).held, 20000);
  assert.equal((await post(`/api/rooms/${PLANT}/challenge/hold`, { ref: "AC3-1", amount: 20000, min: 5000, pct: 5, cap: 60000 })).held, 10000);
  r = await post(`/api/rooms/${PLANT}/challenge/hold`, { ref: "AC4-1", amount: 20000, min: 5000, pct: 5, cap: 60000 });
  assert.equal(r.ok, false); assert.equal(r.code, "cap");
  assert.equal(await supply(), s0);
});

test("resolve: the prize from the hold, the rest back to the pad vault - once", async () => {
  const s0 = await supply();
  let r = await post(`/api/rooms/${PLANT}/challenge/resolve`, { ref: "AC1-1", userId: singer.userId, amount: 14000, cat: "sing", score: 7, login: "singer" });
  assert.equal(r.ok, true); assert.equal(r.paid, 14000); assert.equal(r.released, 6000);
  assert.equal(await bal("s1"), 1000 + 14000);
  r = await post(`/api/rooms/${PLANT}/challenge/resolve`, { ref: "AC1-1", userId: singer.userId, amount: 14000 });
  assert.equal(r.dup, true); assert.equal(r.paid, 14000); assert.equal(await bal("s1"), 15000);
  const row = (await getQuery("SELECT * FROM room_flow_ledger WHERE ref = 'challenge:AC1-1'"))[0];
  assert.equal(row.kind, "challenge"); assert.equal(row.room_vault, -14000); assert.equal(row.rv_to, "room");
  // glory: no winner - everything goes back
  r = await post(`/api/rooms/${PLANT}/challenge/resolve`, { ref: "AC2-1", userId: null, amount: 0 });
  assert.equal(r.paid, 0); assert.equal(r.released, 20000);
  // a prize can never exceed what was held
  assert.equal(await supply(), s0);
  assert.equal(await pool("chalhold"), 10000);
  // a resolve from another pad for this hold is refused
  await rooms.addRoom("Other.Room", null, "test");
  assert.equal((await post(`/api/rooms/Other.Room/challenge/resolve`, { ref: "AC3-1", userId: "s1", amount: 5000 })).code, "bad");
});

test("a hold Pepe never resolved goes back by itself after hold_ttl_min; a late resolve is told it expired", async () => {
  const s0 = await supply();
  T += 31 * MIN;
  assert.equal(await CP.sweepHolds(), 1);
  assert.equal(await pool("chalhold"), 0);
  const r = await post(`/api/rooms/${PLANT}/challenge/resolve`, { ref: "AC3-1", userId: "s1", amount: 9000 });
  assert.equal(r.ok, false); assert.equal(r.code, "expired"); assert.equal(r.paid, 0);
  assert.equal(await supply(), s0);
  assert.equal((await getQuery("SELECT state FROM challenge_holds WHERE ref = 'AC3-1'"))[0].state, "expired");
});

test("the 7-day cap: 15% of (balance + held + paid in 7 days)", async () => {
  // a fresh day: the 24 h cap is open again, the week has paid 14,000 so far; pretend 140k more paid this week
  T += DAY;
  await runQuery(`INSERT INTO room_flow_ledger (ref, kind, room_id, amount, fortknox, room_vault, created, rv_to) VALUES ('challenge:old-1', 'challenge', ?, -140000, 0, -140000, ?, 'room')`,
                 [PLANT, T - 3 * DAY]);
  const b = await CP.holdBudget(PLANT, { pct: 10, cap: 150000 });
  // balance 986,000; week: 15% x (986,000 + 154,000) = 171,000 - 154,000 = 17,000
  assert.equal(b.week_cap - b.paid7, 17000);
  assert.equal(b.left, 17000);
  const r = await post(`/api/rooms/${PLANT}/challenge/hold`, { ref: "AC5-1", amount: 20000, min: 5000, pct: 10, cap: 150000 });
  assert.equal(r.held, 17000);
});

test("results for the pad page: public, newest first, no name for an incognito performer", async () => {
  await post(`/api/rooms/${PLANT}/challenge/result`, { ref: "AC1-1", cat: "sing", mode: "solo", name: "singer", score: 7, paid: 14000 });
  await post(`/api/rooms/${PLANT}/challenge/result`, { ref: "AC2-1", cat: "moan", mode: "open", name: null, score: 3, paid: 0 });
  await post(`/api/rooms/${PLANT}/challenge/result`, { ref: "AC1-1", cat: "sing", mode: "solo", name: "singer", score: 7, paid: 14000 });   // a repeat
  const j = await (await fetch(base + "/api/rooms/" + PLANT + "/challenges")).json();
  assert.equal(j.ok, true);
  assert.equal(j.runs.length, 2);
  assert.equal(j.runs.find((x) => x.cat === "moan").name, null);
  assert.equal(j.runs.find((x) => x.cat === "sing").paid, 14000);
  assert.ok(j.budget && j.budget.held === 17000);
  assert.equal((await fetch(base + "/api/rooms/nope/challenges")).status, 404);
  assert.equal((await fetch(base + `/api/rooms/${PLANT}/challenge/result`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 403);
});
