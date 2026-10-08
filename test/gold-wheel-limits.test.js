// Offline tests for 1.99fj: the gold wheel's daily limit (goldwheel.js: 100 + 25 x level + extra_daily_spins)
// and the "+100 Daily Gold Spins" shop item (shop.js): priced per buyer - 3M for the first copy, +1M for each
// copy already owned - computed by the server (a client-supplied price is only ever checked, never charged),
// with the proceeds going to the House (jackpot_rakes, like gold-wheel wagers) instead of the store owner.
//   NODE_PATH=G:/PATV/node_modules node --test test/gold-wheel-limits.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goldwheel-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const { goldDailyLimit, GOLD_BASE, GOLD_PER_LEVEL } = require(path.join(repo, "goldwheel"));
const shop = require(path.join(repo, "shop"));

let n = 0;
async function mkUser({ username, bal = 0, level = 1, extra = 0 } = {}) {
  const id = "g" + (++n);
  const name = username || "spinner" + n;
  await runQuery(`INSERT INTO users (userId, username, password, points_balance, level, extra_daily_spins) VALUES (?, ?, 'x', ?, ?, ?)`,
                 [id, name, bal, level, extra]);
  return { userId: id, username: name };
}
const bal = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;
const extra = async (id) => (await getQuery("SELECT extra_daily_spins AS e FROM users WHERE userId = ?", [id]))[0].e;
const house = async () => (await getQuery("SELECT COALESCE(SUM(amount), 0) AS t FROM jackpot_rakes"))[0].t;
const total = async () => (await getQuery("SELECT COALESCE(SUM(points_balance), 0) AS t FROM users"))[0].t + await house();
const buy = (u, expectedCost) => shop.purchasePrize({ userId: u.userId, username: u.username, prizeId: "spinboost100", source: "website", expectedCost });

let pb;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, extra_daily_spins INTEGER DEFAULT 0,
                  discordId TEXT, camfrogUsername TEXT, email TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE IF NOT EXISTS jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  await runQuery("CREATE TABLE IF NOT EXISTS user_roles (userId TEXT, role TEXT, source TEXT, PRIMARY KEY (userId, role))");
  await shop.ready;
  await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity) VALUES ('spinboost100', '+100 Daily Gold Spins', 3000000, 999999)");
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES ('seed', NULL, NULL, 5000000)");
  pb = await mkUser({ username: "pb", bal: 0 });
});

// ── 1. the gold wheel's daily limit ──
test("gold limit = 100 + 25 x level (levels 1, 5, 19, 41), plus extra_daily_spins, no cap", () => {
  assert.equal(GOLD_BASE, 100);
  assert.equal(GOLD_PER_LEVEL, 25);
  const want = { 1: 125, 5: 225, 19: 575, 41: 1125 };
  for (const [lvl, lim] of Object.entries(want)) {
    assert.equal(goldDailyLimit(Number(lvl), 0), lim, `level ${lvl}`);
    assert.equal(goldDailyLimit(Number(lvl), null), lim, `level ${lvl}, NULL extra`);
    assert.equal(goldDailyLimit(Number(lvl), 100), lim + 100, `level ${lvl} + one boost`);
    assert.equal(goldDailyLimit(Number(lvl), 300), lim + 300, `level ${lvl} + three boosts`);
  }
  assert.equal(goldDailyLimit(500, 0), 12600, "no cap");
  assert.equal(goldDailyLimit(null, 0), 100, "no level -> the base");
  assert.equal(goldDailyLimit(-3, -50), 100, "nothing negative");
});

test("index.js enforces and reports the limit through goldwheel.js only (old 10 x level is gone)", () => {
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  assert.match(src, /require\("\.\/goldwheel"\)/);
  assert.equal((src.match(/goldDailyLimit\(user\[0\]\.level, user\[0\]\.extra_daily_spins\)/g) || []).length, 2, "spin + spins-left");
  assert.doesNotMatch(src, /10 \* \(user\[0\]\.level/);
  const wheel = fs.readFileSync(path.join(repo, "views", "wheel.ejs"), "utf8");
  assert.match(wheel, /100 spins a day, plus 25 for each of your levels/);
  assert.doesNotMatch(wheel, /10 spins per day for each/);
});

// ── 2. the spin boost's price ──
test("spin boost price: 3M for the first copy, +1M per copy already owned", async () => {
  assert.deepEqual([0, 1, 2, 3, 10].map(shop.spinboostPrice), [3000000, 4000000, 5000000, 6000000, 13000000]);
  assert.equal(shop.spinboostOwned(0), 0);
  assert.equal(shop.spinboostOwned(100), 1);
  assert.equal(shop.spinboostOwned(250), 2);
  const fresh = await mkUser({ bal: 0 });
  const two = await mkUser({ bal: 0, extra: 200 });
  const listed = { prizeId: "spinboost100", cost: 3000000, seller_id: null };
  assert.equal(await shop.priceFor(listed, fresh.userId), 3000000);
  assert.equal(await shop.priceFor(listed, two.userId), 5000000);
  assert.equal(await shop.priceFor(listed, null), 3000000, "signed out: the first-copy price");
  const rows = await shop.personalise([{ ...listed }, { prizeId: "x", cost: 7, seller_id: null }], two.userId);
  assert.deepEqual([rows[0].cost, rows[0].list_cost, rows[0].escalating, rows[1].cost], [5000000, 3000000, true, 7]);
});

test("buying escalates per owned copy: 3M, 4M, 5M - each adds +100 daily spins", async () => {
  const u = await mkUser({ bal: 20000000 });
  for (const [i, price] of [[1, 3000000], [2, 4000000], [3, 5000000]]) {
    const before = await bal(u.userId);
    const r = await buy(u);
    assert.equal(r.success, true, r.message);
    assert.equal(r.cost, price);
    assert.equal(r.owned, i);
    assert.equal(r.next_cost, price + 1000000);
    assert.equal(before - await bal(u.userId), price);
    assert.equal(await extra(u.userId), 100 * i);
  }
  const orders = await getQuery("SELECT price FROM shop_orders WHERE buyer_id = ? ORDER BY id", [u.userId]);
  assert.deepEqual(orders.map((o) => o.price), [3000000, 4000000, 5000000]);
});

// ── 3. routing to the House, with conservation ──
test("proceeds go to the House (jackpot_rakes), not pb; debit == House credit exactly", async () => {
  const u = await mkUser({ bal: 9000000, extra: 100 });          // owns one -> pays 4M
  const pb0 = await bal(pb.userId), h0 = await house(), t0 = await total();
  const r = await buy(u);
  assert.equal(r.success, true, r.message);
  assert.equal(r.cost, 4000000);
  assert.equal(r.owner, "House");
  assert.equal(await bal(u.userId), 5000000);
  assert.equal(await house() - h0, 4000000, "House credited the full price");
  assert.equal(await bal(pb.userId), pb0, "the store owner gets nothing");
  assert.equal(await total(), t0, "conservation: nothing minted or burned");
  const rake = await getQuery("SELECT userId, amount, spinId FROM jackpot_rakes WHERE spinId = ?", [`shop-order:${r.order_id}`]);
  assert.deepEqual(rake.map((x) => [x.userId, x.amount]), [[u.userId, 4000000]]);
  const tx = await getQuery("SELECT points, type FROM transactions WHERE userId = ?", [u.userId]);
  assert.deepEqual(tx.map((x) => [x.points, x.type]), [[-4000000, "purchase of +100 Daily Gold Spins"]], "the buyer's transactions row stays");
  const pbTx = await getQuery("SELECT 1 FROM transactions WHERE userId = ?", [pb.userId]);
  assert.equal(pbTx.length, 0, "no store-sale row for pb");
});

test("other official items still pay the store owner", async () => {
  await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity) VALUES ('mug', 'PATV mug', 1000, 5)");
  const u = await mkUser({ bal: 5000 });
  const pb0 = await bal(pb.userId), h0 = await house();
  const r = await shop.purchasePrize({ userId: u.userId, username: u.username, prizeId: "mug", source: "website", expectedCost: 1000 });
  assert.equal(r.success, true, r.message);
  assert.equal(await bal(pb.userId) - pb0, 1000);
  assert.equal(await house(), h0);
});

// ── 4. the server's price, never the client's ──
test("a client-supplied price that isn't the server's is refused with nothing charged", async () => {
  const u = await mkUser({ bal: 50000000, extra: 200 });         // owns two -> 5M
  const t0 = await total(), h0 = await house();
  for (const bad of [1, 3000000, 25000000, "4999999"]) {
    const r = await buy(u, bad);
    assert.equal(r.success, false);
    assert.equal(r.status, 409);
    assert.equal(r.cost, 5000000, "tells them their real price");
    assert.match(r.message, /not been charged/);
  }
  assert.equal(await bal(u.userId), 50000000);
  assert.equal(await extra(u.userId), 200);
  assert.equal(await house(), h0);
  assert.equal(await total(), t0);
  const ok = await buy(u, 5000000);
  assert.equal(ok.success, true, ok.message);
  assert.equal(ok.cost, 5000000);
  // bots (Discord, Pepe) send no price: still the server's
  const r2 = await shop.purchasePrize({ userId: u.userId, username: u.username, prizeId: "spinboost100", source: "camfrog" });
  assert.equal(r2.success, true, r2.message);
  assert.equal(r2.cost, 6000000);
  assert.equal(await bal(u.userId), 50000000 - 5000000 - 6000000);
});

test("short of the per-buyer price -> refused, says how short", async () => {
  const u = await mkUser({ bal: 3500000, extra: 100 });          // needs 4M
  const r = await buy(u);
  assert.equal(r.success, false);
  assert.equal(r.status, 400);
  assert.equal(r.cost, 4000000);
  assert.match(r.message, /500,000 short/);
  assert.equal(await bal(u.userId), 3500000);
});

test("the House inflow is journaled for E-0 as a game flow", async () => {
  const econ = require(path.join(repo, "econ"));
  await econ.ready;
  const u = await mkUser({ bal: 3000000 });
  const r = await buy(u);
  assert.equal(r.success, true, r.message);
  let row;
  for (let i = 0; i < 50 && !row; i++) {
    row = (await getQuery("SELECT flow, kind, amount, via FROM econ_charges WHERE ref = ?", [`shop-spinboost-${r.order_id}`]))[0];
    if (!row) await new Promise((res) => setTimeout(res, 20));
  }
  assert.deepEqual(row, { flow: "spinboost", kind: "game", amount: 3000000, via: "web" });
});
