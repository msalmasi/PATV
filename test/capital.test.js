// Phase 3: the capital cluster on the site (capital/*): the LMSR markets + Market maker, the Federal Reserve's loans + Bank,
// the staking vaults.
//   * import: off unless enabled, only after the pools AND the stashes are live, digest + totals + record digest + every
//     account checked, verified backup first, idempotent by key; the pots, the NAVs (to the PAT) and the share book verified;
//     the supply total doesn't move by one PAT
//   * markets: buy / sell / settle / void / cancel / deadline, one transaction each, the pot a "market:<id>" pools row
//   * Reserve: instant borrow within the limit, a request over it, approve / deny, repay to the lender's pool, late
//     collection with penalties, the Bank's flash-liquidity hand-off
//   * vaults: a stake leaves the stash into vaultfloat at once, the 04:00 cut-off mints shares at that day's price,
//     an unstake burns them and pays the stash, the protocol's capital is booked by key
//   * rollback: the pots go back to Pepe under one key, everything is handed back, the supply total doesn't move
//   NODE_PATH=G:/PATV/node_modules node --test test/capital.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "capital-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const P = require(path.join(repo, "pools"));
const E = require(path.join(repo, "econstore"));
const S = require(path.join(repo, "stashes"));
const C = require(path.join(repo, "capital", "core"));
const SVC = require(path.join(repo, "capital", "service"));
const X = require(path.join(repo, "capital", "lmsr"));
const V = require(path.join(repo, "capital", "vaults"));
require(path.join(repo, "markets"));
require(path.join(repo, "staking"));

const bal = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;
async function supply() {
  const w = (await getQuery("SELECT COALESCE(SUM(points_balance),0) AS w FROM users"))[0].w;
  const j = (await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM jackpot_rakes"))[0].t;
  const snap = (await getQuery("SELECT pools FROM supply_snapshot WHERE id = 1"))[0];
  let rows = snap ? JSON.parse(snap.pools) : [];
  rows = rows.filter((r) => r.key !== "stashes");
  const st = await S.total();
  if (st.amount) rows.push({ key: "stashes", amount: st.amount });
  rows = await P.supplyRows(rows);
  rows = await SVC.supplyRows(rows);
  return { total: w + j + rows.reduce((t, r) => t + r.amount, 0), rows };
}
const POOLS = { reserve: 50000000, bank: 3000000, mm: 1000000, vaultfloat: 20000, fortknox: 500000, incentives: 200000 };
const SUPPLY0 = Object.entries(POOLS).map(([k, v]) => ({ key: "vault:" + k, label: k, amount: v }));
function packPools() {
  const payload = JSON.stringify({ v: 1, source: "pepe", pools: POOLS, supply: SUPPLY0, docs: {}, routes: {}, econ_cfg: {}, econ_cfg_log: [], catalog: {} });
  return { key: "pc-capital-test", payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"),
           totals: { sum: Object.values(POOLS).reduce((t, v) => t + v, 0), count: Object.keys(POOLS).length, per_pool: POOLS } };
}

// ── a Pepe export built with the same maths his code runs (the real one is replayed in the rehearsal) ──
function market(id, opts, seedFrom, trades, status = "open") {
  const m = { id, question: `Will thing ${id} happen?`, options: opts, creator: "ann_cf", judge: "bob_cf", room: "PepeLab", status,
              created: 1000, closes: 4e9, bets: [] };
  X.newFields(m, 1000);
  m.seed_from = seedFrom;
  for (const [nick, user, opt, spend] of trades) X.applyBuy(m, { nick, user, opt, spend, nowS: 1001 });
  return m;
}
const HOUSE = 8000000;
function build(over = {}) {
  const m1 = market(5, ["yes", "no"], "mm", [["ann_cf", "ann", "yes", 20000], ["carl_cf", "carl", "no", 5000]]);
  const m2 = market(7, ["red", "blue", "green"], "reserve", [["carl_cf", "carl", "red", 10000]]);
  const loans = [
    { id: 3, lender: "🏛️ Federal Reserve", borrower: "ann_cf", principal: 20000, rate: 3, rate_basis: "week", term: 7 * 86400, owed: 20600, paid: 0,
      penalty: 0, status: "active", room: "PepeLab", created: 1000, reserve: true, approved_by: "auto", request: null, holds: {}, payments: [],
      funded_by: "bank", uids: { borrower: "u1" }, accepted: 1000, due: Date.now() / 1000 + 86400 },
    { id: 4, lender: "🏛️ Federal Reserve", borrower: "bob_cf", principal: 10000, rate: 3, rate_basis: "week", term: 7 * 86400, owed: 10300, paid: 10300,
      penalty: 0, status: "repaid", room: "PepeLab", created: 900, reserve: true, holds: {}, payments: [{ hold: "h1", amount: 10300, interest: 300, source: "repay", ts: 950 }],
      funded_by: "bank", ended: 950 },
  ];
  const requests = [{ id: 2, nick: "carl_cf", amount: 500000, term: 14 * 86400, why: "a hideout", status: "pending", created: 1000, room: "PepeLab" }];
  const vaults = {
    v: { bank: { total: 3020000.0, holders: { protocol: 3000000.0, auto: 10000.0, s1: 10000.0 }, basis: 3000000 },
         house: { total: 8000000.0, holders: { protocol: 7990000.0, auto: 10000.0 }, basis: 7990000 },
         mm: { total: 1000000.0, holders: { protocol: 990000.0, auto: 10000.0 }, basis: 990000 } },
    auto: { total: 30000.0, holders: { s1: 30000.0 } },
    queue: { q5: { id: "q5", stash: "1", vault: "auto", kind: "deposit", ts: 1500, state: "pending", by: "ann_cf", amount: 20000, tid_hold: "q5-hold", held: true } },
    epochs: [], seq: 5, next_epoch: Date.now() / 1000 + 3600, inited: 1000, insured: [],
    launch: { seeds: true }, waterfall: {}, gifts: {},
  };
  return Object.assign({ markets: [m1, m2], loans, requests, vaults }, over);
}
function navsOf(st, cash) {
  const out = st.loans.filter((l) => l.funded_by === "bank" && ["funding", "active"].includes(l.status) && !l.insured && !l.written_off)
    .reduce((s, l) => s + Math.max(0, l.principal - (l.paid || 0)), 0);
  let seeds = 0, value = 0;
  for (const m of st.markets.slice().sort((a, b) => a.id - b.id)) {
    if (m.seed_from !== "mm" || !["open", "closed", "settling"].includes(m.status) || m.paid_out) continue;
    seeds += m.seed; value += X.mmValue(m);
  }
  const nav = { bank: cash.bank + out, house: cash.jackpot, mm: cash.mm + value };
  const p = {};
  for (const v of ["bank", "house", "mm"]) p[v] = st.vaults.v[v].total > 0 ? nav[v] / st.vaults.v[v].total : 1;
  let an = 0;
  for (const v of ["bank", "house", "mm"]) an += (st.vaults.v[v].holders.auto || 0) * p[v];
  p.auto = st.vaults.auto.total > 0 ? an / st.vaults.auto.total : 1;
  return { cash, loans_out: out, mm_book: { seeds, value }, nav, prices: p };
}
async function pack(st, key = "cc-0001", extra = {}) {
  const cash = { bank: await P.balance("bank"), mm: await P.balance("mm"), jackpot: await C.houseBalance() };
  const order = {};
  for (const m of st.markets) order[String(m.id)] = m._ord;
  const pots = st.markets.filter((m) => ["open", "closed"].includes(m.status)).reduce((s, m) => s + Math.trunc(m.pool), 0);
  const body = Object.assign({ v: 1, source: "pepe", markets: { seq: 9, records: st.markets, order }, loans: { seq: 6, rseq: 2, loans: st.loans, requests: st.requests, credit: { dave_cf: { on_time: 2 } } },
                               vaults: st.vaults, users: {}, navs: navsOf(st, cash), supply_markets: pots, cfg: { layers: false, tr_live: false, targets: { bank: 5000000, house: 20000000, mm: 1000000 } } },
                             extra.payload || {});
  const payload = JSON.stringify(body);
  const totals = Object.assign(SVC.totalsOf({ markets: st.markets, loans: st.loans, requests: st.requests, vaults: st.vaults }),
                               { digest: SVC.digestOf({ markets: st.markets, loans: st.loans, requests: st.requests, vaults: st.vaults }) }, extra.totals || {});
  return { key, payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"), totals, actor: "test" };
}

let base, server;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot" }, body)) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const op = (engine, verb, actor, args, idem) => post("/api/capital/bot/op", { engine, verb, actor, args, idem });
const PEPE = { login: "PepeBeta", pepe: true, admin: true, via: "room", room: "PepeLab" };
const ANN = { login: "ann_cf", username: "ann", userId: "u1", via: "room", room: "PepeLab" };
const CARL = { login: "carl_cf", username: "carl", userId: "u3", via: "room", room: "PepeLab" };
const BOB = { login: "bob_cf", username: "bob", userId: "u2", via: "room", room: "PepeLab" };
const ADMIN = { login: "boss_cf", username: "boss", userId: "u9", admin: true, via: "room", room: "PepeLab" };
let ST = null, SUPPLY_BEFORE = null;

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT, casino_banned INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, created DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE supply_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), pools TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  for (const [id, name, b, cf, lvl] of [["u1", "ann", 300000, "ann_cf", 10], ["u2", "bob", 5000, "bob_cf", 2], ["u3", "carl", 200000, "carl_cf", 4], ["u9", "boss", 0, "boss_cf", 50]]) {
    await runQuery("INSERT INTO users (userId, username, password, points_balance, camfrogUsername, level, created_at) VALUES (?, ?, 'x', ?, ?, ?, '2026-01-01 00:00:00')", [id, name, b, cf, lvl]);
  }
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES ('seed', 's', NULL, ?)", [HOUSE]);
  await runQuery("INSERT INTO supply_snapshot (id, pools) VALUES (1, ?)", [JSON.stringify(SUPPLY0)]);
  await require(path.join(repo, "funding")).init();
  P._setSupplyFn(supply);
  SVC._setSupplyFn(supply);
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); if (u) req.user = { userId: u, username: u }; next(); };
  const deps = { isBotToken: (t) => t === "bot", addUser };
  P.register(app, deps);
  E.register(app, deps);
  S.register(app, deps);
  require(path.join(repo, "escrow", "ledger")).register(app, deps);
  SVC.register(app, deps);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());

test("off by default on prod, and only after the pools and the stashes are live", async () => {
  ST = build();
  assert.equal(await C.enabled(), false);
  assert.equal((await post("/api/capital/admin/import", await pack(ST))).body.code, "E_FEATURE_OFF");
  assert.equal((await op("markets", "buy", ANN, { ref: "M5", option: "yes", amount: 1000 })).body.code, "not_live");
  await C.setMeta("enabled", true);
  assert.equal((await post("/api/capital/admin/import", await pack(ST))).body.code, "E_POOLS_LOCAL");
  await P._setMeta("enabled", true);
  const pr = await post("/api/pools/admin/import", packPools());
  assert.equal(pr.body.ok, true, JSON.stringify(pr.body));
  assert.equal((await post("/api/capital/admin/import", await pack(ST))).body.code, "E_STASHES_LOCAL");
  await S.init();
  await runQuery("INSERT INTO stash_meta (key, value) VALUES ('enabled', 'true')");
  const sp = JSON.stringify([{ id: "1", owner: "ann_cf", name: "nest", balance: 100000, staked: 0, earned: 0, members: [] }]);
  const si = await S.importFromPepe({ payload: sp, digest: crypto.createHash("sha256").update(sp, "utf8").digest("hex"), total: 100000, count: 1, seq: 1 });
  assert.equal(si.ok, true);
});

test("import: digests, totals and accounts are checked; a mismatch keeps nothing", async () => {
  const bad = await pack(ST);
  bad.digest = "0".repeat(64);
  assert.equal((await post("/api/capital/admin/import", bad)).body.code, "E_DIGEST");
  assert.equal((await post("/api/capital/admin/import", await pack(ST, "cc-0001", { totals: { pots: 1 } }))).body.code, "E_TOTALS");
  const ghost = build();
  ghost.markets[0].positions.zed_cf = { nick: "zed_cf", user: "nobody-here", shares: { yes: 5 }, cost: { yes: 10 } };
  ghost.markets[0]._ord.pos.push("zed_cf");
  assert.equal((await post("/api/capital/admin/import", await pack(ghost))).body.code, "E_IDENTITY");
  const busy = build();
  busy.vaults.queue.q5.state = "moving";
  assert.equal((await post("/api/capital/admin/import", await pack(busy))).body.code, "E_PENDING");
  assert.equal(await C.live(), false);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM capital_records"))[0].n, 0);
});

test("the cutover: records, pots, NAV to the PAT and the share book verified; the supply total doesn't move", async () => {
  // Pepe's supply push carries his market pots ("markets") - the import replaces it with the pools rows in the same transaction
  const pots0 = ST.markets.reduce((s, m) => s + Math.trunc(m.pool), 0);
  await runQuery("UPDATE supply_snapshot SET pools = ? WHERE id = 1", [JSON.stringify(SUPPLY0.concat([{ key: "markets", label: "pots", amount: pots0 }]))]);
  SUPPLY_BEFORE = (await supply()).total;
  const r = await post("/api/capital/admin/import", await pack(ST));
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.supply_before, r.body.supply_after);
  for (const v of ["bank", "house", "mm"]) {
    assert.equal(r.body.nav[v].match, true, v);
    assert.equal(r.body.nav[v].price_match, true, v);
  }
  assert.equal(r.body.nav.auto.price_match, true);
  assert.equal(r.body.components.loans_out, true);
  assert.equal(r.body.components.mm_book, true);
  assert.equal(await C.live(), true);
  const pots = ST.markets.reduce((s, m) => s + Math.trunc(m.pool), 0);
  assert.equal(r.body.pots, pots);
  assert.equal(await P.balance("market:5"), Math.trunc(ST.markets[0].pool));
  assert.equal((await P.balances())["market:5"], undefined, "the pots never show in the pool views");
  assert.equal((await supply()).total, SUPPLY_BEFORE);
  // the same key again answers the stored result
  const again = await post("/api/capital/admin/import", await pack(ST));
  assert.equal(again.body.already, true);
  // the M / L numbering continues above Pepe's
  assert.equal(await C.meta("seq:market"), 9);
});

test("markets: a buy, a sell and a settle move the PAT in one transaction each; the pot is the market's pool, to the PAT", async () => {
  const s0 = (await supply()).total;
  const a0 = await bal("u1");
  const mm0 = await P.balance("mm");
  const buy = await op("markets", "buy", ANN, { ref: "M5", option: "y", amount: 10000 }, "buy-000001");
  assert.equal(buy.body.ok, true, JSON.stringify(buy.body));
  assert.equal(await bal("u1"), a0 - 10000);
  assert.equal(await P.balance("mm"), mm0 + 200, "the Market maker keeps the 2% fee of a market it seeded");
  const m = await C.load("market", 5);
  assert.equal(await P.balance("market:5"), Math.trunc(m.pool));
  // a retry with the same key answers the first result, nothing moves twice
  const dup = await op("markets", "buy", ANN, { ref: "M5", option: "y", amount: 10000 }, "buy-000001");
  assert.equal(dup.body.dup, true);
  assert.equal(await bal("u1"), a0 - 10000);
  // the judge can't trade, the minimum, a bad option
  assert.equal((await op("markets", "buy", BOB, { ref: "M5", option: "yes", amount: 1000 }, "buy-000002")).body.code, "judge");
  assert.equal((await op("markets", "buy", CARL, { ref: "M5", option: "yes", amount: 10 }, "buy-000003")).body.code, "min");
  assert.equal((await op("markets", "buy", CARL, { ref: "M5", option: "maybe", amount: 1000 }, "buy-000004")).body.code, "bad_option");
  const sell = await op("markets", "sell", CARL, { ref: "M5", option: "no", shares: "all" }, "sell-000001");
  assert.equal(sell.body.ok, true, JSON.stringify(sell.body));
  assert.ok(sell.body.pay > 0);
  assert.equal(await P.balance("market:5"), Math.trunc((await C.load("market", 5)).pool));
  assert.equal((await supply()).total, s0, "trading moves PAT between wallets, the pot and the Market maker - never creates any");
  // the judge settles: 1 PAT per winning share, the rest of the pot back to the Market maker
  const mm1 = await P.balance("mm");
  const pot = await P.balance("market:5");
  const st = await op("markets", "settle", BOB, { ref: "M5", outcome: "yes" }, "settle-00001");
  assert.equal(st.body.ok, true, JSON.stringify(st.body));
  assert.equal(await P.balance("market:5"), 0);
  assert.equal(st.body.paid + st.body.leftover, pot);
  assert.equal(await P.balance("mm"), mm1 + st.body.leftover);
  assert.equal((await supply()).total, s0);
  assert.equal((await C.load("market", 5)).status, "settled");
  assert.equal((await op("markets", "settle", BOB, { ref: "M5", outcome: "no" }, "settle-00002")).body.code, "done");
});

test("markets: a judge's void needs a reason; a void gives the funder its seed first; Pepe opens new ones (seeded by the Market maker)", async () => {
  const s0 = (await supply()).total;
  assert.equal((await op("markets", "settle", BOB, { ref: "M7", outcome: "void" }, "void-000001")).body.code, "void_reason");
  const res0 = await P.balance("reserve");
  const v = await op("markets", "settle", BOB, { ref: "M7", outcome: "void the match was cancelled" }, "void-000002");
  assert.equal(v.body.ok, true, JSON.stringify(v.body));
  assert.ok(await P.balance("reserve") >= res0 + 34657, "the Reserve's seed comes back first");
  assert.equal((await supply()).total, s0);
  const mm0 = await P.balance("mm");
  const c = await op("markets", "create", PEPE, { question: "Will it rain on Saturday?", options: ["yes", "no"], secs: 86400, judge: { login: "bob_cf" },
                                                  creator: "carl_cf", room: "PepeLab" }, "create-00001");
  assert.equal(c.body.ok, true, JSON.stringify(c.body));
  assert.equal(c.body.ref, "M10");
  assert.equal(c.body.funder, "mm");
  assert.equal(await P.balance("mm"), mm0 - X.seed(2));
  assert.equal(await P.balance("market:10"), X.seed(2));
  assert.equal((await op("markets", "create", ANN, { question: "x?", options: ["a", "b"], secs: 600 }, "create-00002")).body.code, "forbidden");
  assert.equal((await supply()).total, s0);
});

test("Reserve: repay to the Bank, an instant loan within the limit, a request over it, approve / deny, the flash hand-off", async () => {
  const s0 = (await supply()).total;
  const b0 = await P.balance("bank");
  const a0 = await bal("u1");
  const rp = await op("reserve", "repay", ANN, { ref: "L3", amount: 5000 }, "repay-00001");
  assert.equal(rp.body.ok, true, JSON.stringify(rp.body));
  assert.equal(await P.balance("bank"), b0 + 5000);
  assert.equal(await bal("u1"), a0 - 5000);
  assert.equal(rp.body.left, 15600);
  const all = await op("reserve", "repay", ANN, { ref: "L3" }, "repay-00002");
  assert.equal(all.body.loan.status, "repaid");
  // bob: level 2 -> (10,000 + 2 x 2,000) x 1.25 (one repaid) = 17,500
  const info = await op("reserve", "info", BOB, {});
  assert.equal(info.body.limit, 17500, JSON.stringify(info.body));
  const big = await op("reserve", "borrow", BOB, { amount: 50000, term: "7d" }, "borrow-0001");
  assert.equal(big.body.ok, true, JSON.stringify(big.body));
  assert.equal(big.body.ref, "LR3", "over the limit -> a request");
  const b1 = await P.balance("bank");
  const ok = await op("reserve", "borrow", BOB, { amount: 15000, term: "7d" }, "borrow-0002");
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
  assert.equal(ok.body.ref, "L7", "the L numbering continues above Pepe's (and the P2P loans')");
  assert.equal(ok.body.loan.owed, 15000 + Math.round(15000 * 0.03));
  assert.equal(await P.balance("bank"), b1 - 15000);
  assert.equal((await op("reserve", "borrow", BOB, { amount: 2000, term: "7d" }, "borrow-0003")).body.code, "refused", "one open Reserve loan at a time");
  assert.equal((await op("reserve", "approve", BOB, { ref: "LR3" }, "appr-00001")).body.code, "forbidden");
  const den = await op("reserve", "deny", ADMIN, { ref: "LR3", why: "too much" }, "deny-000001");
  assert.equal(den.body.request.status, "denied");
  // carl's LR2 (500k): the Bank holds less -> Pepe's Fed flash liquidity would have to lend the gap
  await SVC.putConfig({ layers: true, flash: { bank: true, mm: true, room: 10000000 }, targets: { bank: 5000000, house: 20000000, mm: 1000000 } });
  const nf = await op("reserve", "approve", ADMIN, { ref: "LR2", amount: 4000000 }, "appr-00002");
  assert.equal(nf.body.code, "need_flash", JSON.stringify(nf.body));
  assert.equal((await C.load("request", 2)).status, "pending", "a refusal changes nothing");
  const ap = await op("reserve", "approve", ADMIN, { ref: "LR2" }, "appr-00003");
  assert.equal(ap.body.ok, true, JSON.stringify(ap.body));
  assert.equal((await C.load("request", 2)).status, "approved");
  await SVC.putConfig({ layers: false, flash: { bank: false, mm: false, room: 0 } });
  assert.equal((await supply()).total, s0);
});

test("Reserve: a late loan is collected, penalised and marked late by the tick", async () => {
  await C.setMeta("imported", Object.assign({}, await C.meta("imported"), { at: 0 }));     // past the cutover's 2-minute window
  const ln = await C.load("loan", 7);
  ln.due = C.nowS() - 2.5 * 86400;
  ln.next_collect = 0;
  await C.save("loan", ln, ln.due);
  await runQuery("UPDATE users SET points_balance = 3000 WHERE userId = 'u2'");
  const b0 = await P.balance("bank");
  await SVC.tick();
  const after = await C.load("loan", 7);
  assert.equal(after.late, true);
  assert.equal(after.penalty_days, 2);
  assert.ok(after.penalty > 0);
  assert.equal(after.paid, 3000, "everything bob had");
  assert.equal(await P.balance("bank"), b0 + 3000);
  assert.equal(await bal("u2"), 0);
});

test("vaults: the queued stake runs at the cut-off at that day's price; an unstake waits for the next; the protocol books its capital by key", async () => {
  const s0 = (await supply()).total;
  const vf0 = await P.balance("vaultfloat");
  const st = await op("vaults", "stake", ANN, { stash: "1", vault: "bank", amount: 30000 }, "stake-00001");
  assert.equal(st.body.ok, true, JSON.stringify(st.body));
  assert.equal(await P.balance("vaultfloat"), vf0 + 30000);
  assert.equal((await S.get("1")).balance, 70000);
  const d0 = await V.load();
  const k0 = await V.ctx();
  const p0 = V.prices(d0, k0);
  d0.next_epoch = C.nowS() - 1;
  await V.store(d0);
  const before = JSON.parse(JSON.stringify(d0));
  await C.setMeta("imported", Object.assign({}, await C.meta("imported"), { at: 0 }));
  await SVC.tick();
  const d1 = await V.load();
  assert.ok(d1.next_epoch > C.nowS());
  assert.equal(d1.epochs.length, 1);
  const qid = st.body.item.id;
  for (const id of ["q5", qid]) assert.equal(d1.queue[id].state, "done", id);
  assert.equal(await P.balance("vaultfloat"), vf0 - 20000, "both queued stakes left the float");
  // the stake: 30,000 into the Bank at the cut-off's price
  const minted = d1.v.bank.holders.s1 - before.v.bank.holders.s1;
  assert.ok(Math.abs(minted - 30000 / d1.queue[qid].prices.bank) < 1e-6);
  assert.ok(d1.queue[qid].prices.bank > 0);
  assert.ok(p0.bank > 0);
  // unstake half: queued, burnt at the next cut-off, paid into the stash
  const un = await op("vaults", "unstake", ANN, { stash: "1", vault: "bank", amount: 10000 }, "unstake-001");
  assert.equal(un.body.ok, true, JSON.stringify(un.body));
  const d2 = await V.load();
  d2.next_epoch = C.nowS() - 1;
  await V.store(d2);
  const stash0 = (await S.get("1")).balance;
  await SVC.tick();
  const d3 = await V.load();
  const uid = un.body.item.id;
  assert.equal(d3.queue[uid].state, "done");
  assert.equal((await S.get("1")).balance, stash0 + d3.queue[uid].legs.bank);
  // the protocol's capital (Pepe's policy engines): booked once per key at the site's price
  const pr = await op("vaults", "protocol", PEPE, { vault: "bank", amount: 100000, basis: "add" }, "proto-mint-001");
  assert.equal(pr.body.ok, true, JSON.stringify(pr.body));
  const pr2 = await op("vaults", "protocol", PEPE, { vault: "bank", amount: 100000, basis: "add" }, "proto-mint-001");
  assert.equal(pr2.body.dup, true);
  assert.equal((await op("vaults", "protocol", ANN, { vault: "bank", amount: 5 }, "proto-mint-002")).body.code, "forbidden");
  assert.equal((await supply()).total, s0, "staking moves PAT between stashes and vault cash - never creates any");
});

test("rollback: the pots go back to Pepe under one key, everything is handed back, the supply total doesn't move", async () => {
  const s0 = (await supply()).total;
  const potSum = Number((await getQuery("SELECT COALESCE(SUM(balance),0) AS t FROM pools WHERE key LIKE 'market:%'"))[0].t);
  const r = await post("/api/capital/admin/rollback", { key: "cr-0001", actor: "test" });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.pots, potSum);
  assert.equal(r.body.supply_before, r.body.supply_after);
  assert.equal(await C.live(), false);
  assert.equal(Number((await getQuery("SELECT COALESCE(SUM(balance),0) AS t FROM pools WHERE key LIKE 'market:%'"))[0].t), 0);
  assert.equal((await supply()).total, s0);
  assert.ok(r.body.markets.some((m) => m.id === 10));
  assert.ok(r.body.loans.some((l) => l.id === 7 && l.late));
  assert.ok(r.body.vaults.v.bank.holders.s1 > 0);
  assert.ok(r.body.credit.dave_cf && r.body.credit.dave_cf.on_time === 2, "the credit archive comes back in Pepe's keys");
  const dup = await post("/api/capital/admin/rollback", { key: "cr-0001", actor: "test" });
  assert.equal(dup.body.dup, true);
  assert.equal((await op("markets", "buy", ANN, { ref: "M10", option: "yes", amount: 1000 })).body.code, "not_live");
  // the cutover again, from what came back (a NEW key)
  const back = { markets: r.body.markets.filter((m) => m.status !== "settled" && m.status !== "void").map((m) => Object.assign({}, m)), loans: r.body.loans,
                 requests: r.body.requests, vaults: r.body.vaults };
  const again = await post("/api/capital/admin/import", await pack(back, "cc-0002"));
  assert.equal(again.body.ok, true, JSON.stringify(again.body));
  assert.equal((await supply()).total, s0);
  assert.equal(await P.balance("market:10"), Math.trunc(back.markets.find((m) => m.id === 10).pool));
});
