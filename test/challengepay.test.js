// Offline tests for mic challenge prizes out of a pad's room-vault escrow (challengepay.js) and the staked
// head-to-head fee routed like a boost (Fort Knox half + the room's escrow half).
//   NODE_PATH=G:/PATV/node_modules node --test test/challengepay.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "challengepay-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const B = require(path.join(repo, "boosts"));
const CP = require(path.join(repo, "challengepay"));
const rooms = require(path.join(repo, "rooms"));
const S = require(path.join(repo, "mainstage"));
const F = require(path.join(repo, "funding"));

const HOUR = 3600 * 1000;
let T = Date.UTC(2026, 9, 8, 18, 0, 0);
const adv = (ms) => { T += ms; };
rooms._setClock(() => T); B._setClock(() => T); S._setClock(() => T); CP._setClock(() => T);
const START = 1000000;
const PLANT = "plant_based_chatting", DRAMA = "DRAMA_CENTRAL", EMPTY = "Quiet.Room";

let n = 0;
async function mkUser(extra = {}) {
  const id = "c" + (++n);
  const name = extra.username || "user" + n;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, points_balance, camfrogUsername, class)
                  VALUES (?, ?, ?, 'x', ?, ?, 'pleb')`, [id, name, name, extra.bal != null ? extra.bal : START, extra.camfrog || null]);
  return { userId: id, username: name };
}
const bal = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;
const escrowOf = async (room) => (await getQuery("SELECT COALESCE(SUM(room_vault),0) AS t FROM room_flow_ledger WHERE room_id = ? AND migrated_rv IS NULL", [room]))[0].t;
let refN = 0;
const ref = () => "AC" + (++refN) + "-1760000000";

let owner, booster, singer;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  owner = await mkUser({ username: "pb", camfrog: "foamy1111" });
  booster = await mkUser({ username: "fan" });
  singer = await mkUser({ username: "singer", camfrog: "singer" });
  await S.init();
  await rooms.init();
  await B.init();
  await CP.init();
  for (const id of [DRAMA, EMPTY]) await rooms.addRoom(id, null, "test");
  await rooms.setOwner(PLANT, "foamy1111", "test");
  // fill two escrows the real way: boosts (half of each lands in the room's escrow)
  const r1 = await B.boost(booster, PLANT, { amount: 200000, ref: "boost-ref-plant1" });
  assert.equal(r1.room_vault, 100000);
  const r2 = await B.boost(booster, DRAMA, { amount: 10000, ref: "boost-ref-drama1" });
  assert.equal(r2.room_vault, 5000);
});

test("budget: 5% of the room's escrow per 24 h, capped, clamped to the site's ceilings", async () => {
  let b = await CP.budget(PLANT, { pct: 5, cap: 25000 });
  assert.deepEqual(b, { balance: 100000, paid24: 0, cap: 5000, left: 5000, pct: 5 });
  b = await CP.budget(PLANT, { pct: 50, cap: 25000 });
  assert.equal(b.pct, 10, "a pct over the site's ceiling is clamped to 10");
  assert.equal(b.cap, 10000);
  b = await CP.budget(PLANT, { pct: 10, cap: 3000 });
  assert.equal(b.cap, 3000, "the absolute cap");
  b = await CP.budget(PLANT, {});
  assert.equal(b.cap, 5000, "defaults when Pepe sends nothing (5% of 100k, under the 60,000 cap)");
  assert.deepEqual([CP.DEFAULTS.pct, CP.DEFAULTS.cap, CP.DEFAULTS.pct_max, CP.DEFAULTS.cap_max, CP.DEFAULTS.payout_max],
                   [5, 60000, 10, 150000, 25000], "site defaults + ceilings");
  assert.equal((await CP.budget(PLANT, { pct: 5, cap: 999999 })).cap, 5000, "a cap over 150,000 is clamped, 5% still binds");
  assert.equal((await CP.budget(EMPTY, {})).left, 0);
});

test("payout: debits the room's escrow, credits the winner, records kind 'challenge'", async () => {
  const b0 = await bal(singer.userId);
  const r = await CP.payout(PLANT, { ref: ref(), userId: singer.userId, login: "singer", amount: 3500, min: 500, pct: 5, cap: 25000, cat: "sing", score: 7 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.paid, 3500);
  assert.equal(await bal(singer.userId), b0 + 3500);
  assert.equal(await escrowOf(PLANT), 100000 - 3500);
  const row = (await getQuery("SELECT * FROM room_flow_ledger WHERE kind = 'challenge'"))[0];
  assert.equal(row.room_id, PLANT); assert.equal(row.room_vault, -3500); assert.equal(row.amount, -3500); assert.equal(row.fortknox, 0);
  assert.equal(row.payer_id, singer.userId, "payer_* = the winner");
  assert.match(row.detail, /sing 7\/10 by singer/);
  const tx = (await getQuery("SELECT * FROM transactions WHERE userId = ? AND points = 3500", [singer.userId]))[0];
  assert.match(tx.type, /mic challenge prize p\//);
  const claims = await getQuery("SELECT * FROM reserve_claims WHERE flow LIKE '%challenge%'");
  assert.equal(claims.length, 0, "a prize never touches the Reserve / Fort Knox");
});

test("payout: idempotent - the same ref (also concurrently) pays once", async () => {
  const b0 = await bal(singer.userId);
  const e0 = await escrowOf(PLANT);
  const R = ref();
  const body = { ref: R, userId: singer.userId, amount: 1000, min: 500, pct: 5, cap: 25000 };
  const [a, b] = await Promise.all([CP.payout(PLANT, body), CP.payout(PLANT, body)]);
  assert.deepEqual([a.dup, b.dup].sort(), [false, true]);
  assert.equal(a.paid, 1000); assert.equal(b.paid, 1000, "the replay reports the first result");
  const c = await CP.payout(PLANT, body);
  assert.equal(c.dup, true);
  assert.equal(await bal(singer.userId), b0 + 1000);
  assert.equal(await escrowOf(PLANT), e0 - 1000);
});

test("payout: the 24 h cap trims the prize, then refuses ('cap'), and frees up a day later", async () => {
  // 4,500 of PLANT's 5,000 a day is used: 500 left
  let r = await CP.payout(PLANT, { ref: ref(), userId: singer.userId, amount: 5000, min: 100, pct: 5, cap: 25000 });
  assert.equal(r.ok, true); assert.equal(r.paid, 500, "trimmed to what's left of today's 5%");
  r = await CP.payout(PLANT, { ref: ref(), userId: singer.userId, amount: 5000, min: 500, pct: 5, cap: 25000 });
  assert.deepEqual(r, { ok: false, code: "cap", paid: 0 });
  r = await CP.payout(PLANT, { ref: ref(), userId: singer.userId, amount: 100, min: 50, pct: 5, cap: 25000 });
  assert.equal(r.code, "cap", "nothing left at all");
  const left = (await CP.budget(PLANT, { pct: 5, cap: 25000 }));
  assert.equal(left.left, 0); assert.equal(left.paid24, 5000);
  adv(24 * HOUR + 1000);
  const b = await CP.budget(PLANT, { pct: 5, cap: 25000 });
  assert.equal(b.paid24, 0);
  assert.equal(b.cap, Math.floor(b.balance * 5 / 100), "a new day: 5% of what's left (the escrow decays at most 5%/day)");
  r = await CP.payout(PLANT, { ref: ref(), userId: singer.userId, amount: 20000, min: 500, pct: 5, cap: 25000 });
  assert.equal(r.paid, Math.min(25000, b.left), "one prize is at most payout_max (25,000) and today's budget");
});

test("payout: insufficient / empty escrow, no pad, unknown account, bad input, switched off - nothing moves", async () => {
  const before = (await getQuery("SELECT COUNT(*) AS n FROM room_flow_ledger"))[0].n;
  const b0 = await bal(singer.userId);
  // DRAMA has 5,000: 5% = 250 a day - under the 500 minimum prize
  let r = await CP.payout(DRAMA, { ref: ref(), userId: singer.userId, amount: 3500, min: 500, pct: 5, cap: 25000 });
  assert.deepEqual(r, { ok: false, code: "cap", paid: 0 });
  r = await CP.payout(EMPTY, { ref: ref(), userId: singer.userId, amount: 3500, min: 500 });
  assert.deepEqual(r, { ok: false, code: "empty", paid: 0 }, "a pad with nothing in escrow");
  r = await CP.payout("No.Such.Room", { ref: ref(), userId: singer.userId, amount: 3500, min: 500 });
  assert.equal(r.code, "no_room");
  r = await CP.payout(PLANT, { ref: ref(), userId: "ghost", amount: 1000, min: 500 });
  assert.equal(r.code, "no_account");
  r = await CP.payout(PLANT, { ref: "x y", userId: singer.userId, amount: 1000 });
  assert.equal(r.code, "bad");
  r = await CP.payout(PLANT, { ref: ref(), userId: singer.userId, amount: -5 });
  assert.equal(r.code, "bad");
  await CP.setConfig({ on: false });
  r = await CP.payout(PLANT, { ref: ref(), userId: singer.userId, amount: 1000, min: 500 });
  assert.equal(r.code, "off");
  await CP.setConfig({ on: true });
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM room_flow_ledger"))[0].n, before, "no row written");
  assert.equal(await bal(singer.userId), b0, "no PAT moved");
  // only that room's escrow: DRAMA's balance is untouched by everything paid from PLANT
  assert.equal(await escrowOf(DRAMA), 5000);
});

test("payout: a merged-away winner is followed; the escrow never goes negative", async () => {
  const ledger = require(path.join(repo, "ledger"));
  const keep = await mkUser({ username: "kept" });
  await ledger.recordMerge("gone-id", keep.userId, "test");
  const r = await CP.payout(PLANT, { ref: ref(), userId: "gone-id", amount: 600, min: 500, pct: 10, cap: 100000 });
  assert.equal(r.ok, true); assert.equal(await bal(keep.userId), START + 600);
  for (const room of [PLANT, DRAMA, EMPTY]) assert.ok(await escrowOf(room) >= 0);
});

test("fee: a staked head-to-head's fee is routed like a boost - Fort Knox half + this room's escrow half", async () => {
  const e0 = await escrowOf(PLANT);
  let r = await CP.fee(PLANT, { ref: "AC50-p7-1760000000", amount: 1001, a: "ann", b: "bob" });
  assert.equal(r.ok, true); assert.equal(r.fortknox, 501); assert.equal(r.room_vault, 500, "odd PAT to Fort Knox, like a boost");
  assert.equal(await escrowOf(PLANT), e0 + 500);
  let claim = (await getQuery("SELECT * FROM reserve_claims WHERE flow = 'challenge_fee'"))[0];
  assert.equal(claim.amount, -501, "the Fort Knox half is a negative claim Pepe's funding tick credits");
  r = await CP.fee(PLANT, { ref: "AC50-p7-1760000000", amount: 1001, a: "ann", b: "bob" });
  assert.equal(r.dup, true, "a retried fee is booked once");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM reserve_claims WHERE flow LIKE '%challenge_fee'"))[0].n, 1);
  // the room's owner in the duel: all Fort Knox (self-spend never feeds your own vault)
  r = await CP.fee(PLANT, { ref: "AC51-p9-1760000000", amount: 1000, a: "Foamy1111", b: "bob" });
  assert.equal(r.fortknox, 1000); assert.equal(r.room_vault, 0);
  // no pad: nowhere to hold a room half -> all Fort Knox
  r = await CP.fee("No.Pad.Room", { ref: "AC52-p1-1760000000", amount: 400, a: "x", b: "y" });
  assert.equal(r.fortknox, 400); assert.equal(r.room_vault, 0);
  // E-1: Fort Knox live -> the claim is Fort Knox's
  F.sync({ reserve: 1000, flows: {}, fortknox: 5 });
  r = await CP.fee(DRAMA, { ref: "AC53-p2-1760000000", amount: 100, a: "x", b: "y" });
  assert.equal(r.fk_to, "fortknox");
  claim = (await getQuery("SELECT * FROM reserve_claims WHERE flow = 'fortknox:challenge_fee'"))[0];
  assert.equal(claim.amount, -50);
  F.sync({ reserve: 1000, flows: {}, fortknox: null });
  assert.ok(B.ROOM_FLOWS.includes("challenge_fee"), "the E-1 migration summary waits for unsettled fee claims too");
  r = await CP.fee(PLANT, { ref: "AC54", amount: 0 });
  assert.equal(r.code, "bad");
});

test("conservation: wallets + Reserve claims + room escrow = what everyone started with", async () => {
  const wallets = (await getQuery("SELECT COALESCE(SUM(points_balance),0) AS b FROM users"))[0].b;
  const rv = (await getQuery("SELECT COALESCE(SUM(room_vault),0) AS t FROM room_flow_ledger"))[0].t;
  const fkBoost = -(await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM reserve_claims WHERE flow IN ('boost')"))[0].t;
  const users = (await getQuery("SELECT COUNT(*) AS n FROM users"))[0].n;
  // fees: their PAT left the wallets through Pepe's escrow (not modelled here): the room halves are "external" money in rv
  const fees = (await getQuery("SELECT COALESCE(SUM(room_vault),0) AS t FROM room_flow_ledger WHERE kind = 'challenge_fee'"))[0].t;
  assert.equal(wallets + rv + fkBoost, users * START + fees, "every PAT paid as a prize came out of a room escrow");
  const rows = await getQuery("SELECT * FROM room_flow_ledger");
  for (const r of rows) assert.equal(r.amount, r.fortknox + r.room_vault, `row ${r.ref}: amount = fortknox + room_vault`);
  const moved = (await getQuery("SELECT COALESCE(SUM(points),0) AS t FROM transactions"))[0].t;
  assert.equal(moved, wallets - users * START, "every wallet move has its transaction row");
});

test("E-3: the migration moves the NET balance - payout rows are stamped, nothing paid out is migrated", async () => {
  const net = await escrowOf(PLANT);
  const gross = (await getQuery("SELECT COALESCE(SUM(room_vault),0) AS t FROM room_flow_ledger WHERE room_id = ? AND room_vault > 0", [PLANT]))[0].t;
  const paid = -(await getQuery("SELECT COALESCE(SUM(room_vault),0) AS t FROM room_flow_ledger WHERE room_id = ? AND kind = 'challenge'", [PLANT]))[0].t;
  assert.equal(net, gross - paid);
  assert.equal((await B.escrow()).rooms.find((r) => r.room_id === PLANT).room_vault, net, "the admin escrow view is net too");
  // what E-3 will do: stamp every un-migrated row of the room and move `net`
  await runQuery("UPDATE room_flow_ledger SET migrated_rv = ? WHERE room_id = ? AND migrated_rv IS NULL", [T, PLANT]);
  assert.equal(await escrowOf(PLANT), 0);
  const r = await CP.payout(PLANT, { ref: ref(), userId: singer.userId, amount: 1000, min: 500 });
  assert.equal(r.code, "empty", "after the migration the escrow has nothing left to pay from");
});

test("HTTP: bot token required, JSON in/out; admin config is staff-only", async () => {
  const express = require("express");
  const app = express();
  app.use(express.json());
  const staff = await mkUser({ username: "staffer" });
  await runQuery("UPDATE users SET class = 'Admin' WHERE userId = ?", [staff.userId]);
  const users = { [staff.userId]: { ...staff, class: "Admin" }, [singer.userId]: { ...singer, class: "pleb" } };
  const addUser = (req, res, next) => { const id = req.headers["x-test-user"]; req.user = id ? users[id] || null : null; next(); };
  CP.register(app, { addUser, isBotToken: (t) => t === "bot" });
  const srv = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = "http://127.0.0.1:" + srv.address().port;
  const J = (url, body, user) => fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": user } : {}) },
    body: JSON.stringify(body || {}) }).then(async (r) => ({ status: r.status, j: await r.json() }));
  try {
    const room = encodeURIComponent(DRAMA);
    let r = await J(`/api/rooms/${room}/challenge/payout`, { password: "nope", ref: ref(), userId: singer.userId, amount: 100 });
    assert.equal(r.status, 403);
    r = await J(`/api/rooms/${room}/challenge/payout`, { ref: ref(), userId: singer.userId, amount: 100 });
    assert.equal(r.status, 403, "no token at all");
    r = await J(`/api/rooms/${room}/challenge/vault`, { password: "nope" });
    assert.equal(r.status, 403);
    r = await J(`/api/rooms/${room}/challenge/fee`, { password: "nope", ref: "AC9", amount: 10 });
    assert.equal(r.status, 403);
    r = await J(`/api/rooms/${room}/challenge/vault`, { password: "bot", pct: 5, cap: 25000 });
    assert.equal(r.j.ok, true); assert.ok(r.j.balance > 0); assert.equal(r.j.pct, 5);
    r = await J(`/api/rooms/${encodeURIComponent("No.Such.Room")}/challenge/vault`, { password: "bot" });
    assert.equal(r.j.code, "no_room");
    const b0 = await bal(singer.userId);
    r = await J(`/api/rooms/${room}/challenge/payout`, { password: "bot", ref: ref(), userId: singer.userId, amount: 200, min: 100, pct: 10, cap: 25000 });
    assert.equal(r.j.ok, true, JSON.stringify(r.j)); assert.equal(r.j.paid, 200);
    assert.equal(await bal(singer.userId), b0 + 200);
    r = await J(`/api/rooms/${room}/challenge/fee`, { password: "bot", ref: "AC77-p1-1", amount: 10, a: "x", b: "y" });
    assert.equal(r.j.ok, true);
    r = await J("/api/challenge/admin", { pct: 7 }, singer.userId);
    assert.equal(r.status, 403, "not staff");
    r = await J("/api/challenge/admin", { pct: 7, pct_max: 8 }, staff.userId);
    assert.equal(r.j.ok, true); assert.equal(r.j.config.pct, 7); assert.equal(r.j.config.pct_max, 8);
    const g = await fetch(base + "/api/challenge/admin", { headers: { "x-test-user": staff.userId } }).then((x) => x.json());
    assert.equal(g.ok, true); assert.ok(g.escrow && Array.isArray(g.escrow.rooms));
    await CP.setConfig({ pct: 5, pct_max: 10 });
  } finally { srv.close(); }
});
