// P4-1: the Fed's one-off operations on the site (fed/service.js) - the switch, the cutover import (digest, totals, nothing
// half-done, the supply unchanged, a dry run that rolls back), the admin mint, the monthly caps with two writers racing
// (two mints in the same second, the scheduler's floor mint), grants (pool caps, the floor's second confirm, protocol shares),
// Fed loans (the shortfall mint, the outstanding cap, flash loans + their repayment from the Bank, the waterfall's booking,
// the early manual repayment), the donation mints (wallet + incentive bonus, the claim settled here, Pepe no longer sees it),
// replayed requests, and the way back.
//   NODE_PATH=G:/PATV/node_modules node --test test/fed.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fed-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.DB_BACKUP_DIR = path.join(tmp, "backups");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const P = require(path.join(repo, "pools"));
const ES = require(path.join(repo, "econstore"));
const CC = require(path.join(repo, "capital", "core"));
const C = require(path.join(repo, "policy", "core"));
const E = require(path.join(repo, "policy", "engines"));
const G = require(path.join(repo, "policy", "gather"));
const A = require(path.join(repo, "policy", "apply"));
const F = require(path.join(repo, "fed", "service"));
const FUND = require(path.join(repo, "funding"));

const M = 1000000;
const T0 = Date.UTC(2026, 9, 20, 15, 0) / 1000;                 // Tuesday 2026-10-20 15:00 UTC (fixed: never the real clock)
F._setClock(() => T0 * 1000);
C._setClock(() => T0 * 1000);
const POOLS = { reserve: 60 * M, bank: 3 * M, mm: 1 * M, fortknox: 5 * M, heist: 1 * M, incentives: 4 * M, vaultfloat: 0 };
const HOUSE = 20 * M;
const wallets = async () => (await getQuery("SELECT COALESCE(SUM(points_balance),0) AS w FROM users"))[0].w;
const supply = async () => (await wallets()) + (await A.base());
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

let base, server;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot" }, body)) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
let opn = 0;
const op = (name, args, extra = {}) => post("/api/fed/bot/op", Object.assign({ op: name, op_key: `t-${name}-${++opn}`, args }, extra)).then((r) => r.body);

const CFG = {
  econ_cfg: Object.assign({}, E.DEFAULTS, { fed_floor: 50 * M, fed_ceiling: 150 * M, mintcap_total: 100 * M, mintcap_loan: -1, fedloan_cap: 10 * M,
                                            heist_cap_mode: "fixed", fortknox_cap: 15 * M, room_vault_cap: 50 * M }),
  consts: E.CONSTS, flags: { layers: true, tr_live: true }, tz: "America/New_York", journal: [], days_done: [],
};
// Pepe's journal at the cutover (his econ_layers + econ_monetary.flash_repaid)
const PEPE = {
  v: 1,
  fed_mints: {
    "fedseed-100000000": { key: "fedseed-100000000", ts: T0 - 10 * 86400, amount: 40 * M, policy: "seed", source: "seed", dest: "reserve", reason: "economy v3 seed", actor: "pb", state: "done" },
    "admin-a1-x": { key: "admin-a1-x", ts: T0 - 2 * 86400, amount: 5 * M, policy: "admin", source: "admin", dest: "reserve", reason: "an admin mint this month", actor: "pb", state: "done" },
  },
  fed_grants: { "grant-g1-x": { key: "grant-g1-x", ts: T0 - 86400, pool: "incentives", dest: "incentives", amount: 2 * M, reason: "top up for the season", actor: "pb", state: "done" } },
  fed_loans: { FL1: { id: "FL1", vault: "fortknox", principal: 1 * M, outstanding: 1 * M, reason: "knox loan for the test", actor: "pb", ts: T0 - 3 * 86400, state: "open", auto: false,
                      shares: false, flash: false, mint: 0, repayments: [] } },
  fed_loan_repaid: { "W2026-10-12-house": { amount: 0, applied: 0, ts: T0 - 8 * 86400 } },
  flash_repaid: {},
  fed_loan_seq: 1,
};

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT, casino_banned INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE supply_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), pools TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("INSERT INTO users (userId, username, password, points_balance, camfrogUsername, class) VALUES ('u1', 'ann', 'x', 7000000, 'ann_cf', 'pleb')");
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES ('seed', 's', NULL, ?)", [HOUSE]);
  await runQuery("INSERT INTO supply_snapshot (id, pools) VALUES (1, '[]')");
  await P.init();
  await FUND.init();
  await P._setMeta("enabled", true);
  const payload = JSON.stringify({ v: 1, source: "pepe", pools: POOLS, docs: {}, routes: {}, econ_cfg: {}, econ_cfg_log: [], catalog: {} });
  const pr = await P.importFromPepe({ key: "pc-fed-test", payload, digest: sha(payload),
                                      totals: { sum: Object.values(POOLS).reduce((t, v) => t + v, 0), count: Object.keys(POOLS).length, per_pool: POOLS } });
  assert.equal(pr.ok, true);
  await CC.init();
  await CC.putDoc("vaults", {
    v: { house: { total: 10 * M, holders: { protocol: 9.5 * M, s1: 500000.0 }, basis: 8 * M },
         bank: { total: 3 * M, holders: { protocol: 3 * M }, basis: 2.5 * M },
         mm: { total: 1 * M, holders: { protocol: 1 * M }, basis: 1 * M } },
    auto: { total: 0, holders: {} }, queue: {}, epochs: [], seq: 0, inited: 1, insured: [] });
  await CC.setMeta("live", true);
  CC.forgetLive();
  await ES.putDocs({ econ_layers: { rev: 1, doc: { fed_mints: PEPE.fed_mints, fed_loans: PEPE.fed_loans, fed_loan_repaid: PEPE.fed_loan_repaid } } });
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const deps = { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() };
  P.register(app, deps);
  ES.register(app, deps);
  require(path.join(repo, "policy", "scheduler")).register(app, deps);
  F.register(app, deps);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  assert.equal((await post("/api/policy/bot/config", { cfg: CFG })).body.ok, true);
});
test.after(() => server && server.close());

const exportOf = (x) => { const payload = JSON.stringify(x); return { payload, digest: sha(payload), totals: F.totalsOf(Object.assign({ fed_loan_seq: 0 }, x)) }; };

test("before the cutover: ops are refused (the books are Pepe's), the engines read his pushed doc", async () => {
  assert.equal(await F.live(), false);
  const r = await op("mint", { amount: 1000, policy: "admin", reason: "not live yet here", key: "admin-nl-1" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "not_live");
  const L = await G.layersOf(await G.docs());
  assert.ok(L.fed_mints["admin-a1-x"], "Pepe's doc");
});

test("the cutover import: digest, totals, nothing half-done, a dry run rolls back, then live with the supply unchanged", async () => {
  await F.setMeta("enabled", true);
  const ex = exportOf(PEPE);
  let r = await post("/api/fed/admin/import", Object.assign({ key: "fc-test-1" }, ex, { digest: "0".repeat(64) }));
  assert.equal(r.body.code, "E_DIGEST");
  r = await post("/api/fed/admin/import", Object.assign({ key: "fc-test-1" }, ex, { totals: Object.assign({}, ex.totals, { mint_sum: 1 }) }));
  assert.equal(r.body.code, "E_TOTALS");
  const half = JSON.parse(JSON.stringify(PEPE));
  half.fed_mints["admin-a1-x"].state = "pending";
  r = await post("/api/fed/admin/import", Object.assign({ key: "fc-test-1" }, exportOf(half)));
  assert.equal(r.body.code, "E_PENDING");
  const s0 = await supply();
  r = await post("/api/fed/admin/import", Object.assign({ key: "fc-dry-1", dry: true }, ex));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.dry, true);
  assert.equal(r.body.rolled_back, true);
  assert.equal(r.body.totals.mints, 2);
  assert.equal(await F.live(), false, "a dry run leaves nothing");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM fed_records"))[0].n, 0);
  r = await post("/api/fed/admin/import", Object.assign({ key: "fc-test-1", actor: "boss" }, ex));
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.deepEqual(r.body.totals, ex.totals);
  assert.equal(await F.live(), true);
  assert.equal(await supply(), s0, "nothing moved");
  r = await post("/api/fed/admin/import", Object.assign({ key: "fc-test-1" }, ex));
  assert.equal(r.body.already, true, "the same key again answers the stored result");
  const st = (await post("/api/fed/bot/state", {})).body;
  assert.equal(st.live, true);
  assert.equal(st.doc.fed_loans.FL1.outstanding, 1 * M);
  assert.equal(st.doc.fed_loan_seq, 1);
  assert.equal(st.mtd.admin, 5 * M, "this month's admin mints count");
  const fj = await getQuery("SELECT id FROM fed_journal ORDER BY id");
  assert.ok(fj.some((x) => x.id === "loan:FL1") && fj.some((x) => x.id === "grant:grant-g1-x"));
  // the engines read the site's own journal now
  const L = await G.layersOf(await G.docs());
  assert.ok(L.fed_loans.FL1 && L.fed_mints["fedseed-100000000"]);
});

test("the admin mint: Fed only, journaled, a replayed request answers the same, a reused key never mints twice", async () => {
  const f0 = await P.balance("reserve"), s0 = await supply();
  const body = { op: "mint", op_key: "t-admin-replay", args: { amount: 3 * M, policy: "admin", reason: "admin mint for the season", actor: "boss", key: "admin-b2-y", via: "chat" } };
  const r = (await post("/api/fed/bot/op", body)).body;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rec.state, "done");
  assert.equal(r.rec.conserved, true);
  assert.equal(await P.balance("reserve"), f0 + 3 * M);
  assert.equal(await supply(), s0 + 3 * M, "the supply rises by exactly the mint");
  const again = (await post("/api/fed/bot/op", body)).body;
  assert.equal(again.replay, true);
  const dup = await op("mint", { amount: 3 * M, policy: "admin", reason: "admin mint for the season", key: "admin-b2-y" });
  assert.equal(dup.dup, true);
  assert.equal(await P.balance("reserve"), f0 + 3 * M);
  const bad = await op("mint", { amount: 1 * M, policy: "admin", reason: "into the House please", key: "admin-b3-z", dest: "jackpot" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /only into the Federal Reserve/);
  const reused = await op("mint", { amount: 2 * M, policy: "admin", reason: "admin mint for the season", key: "admin-b2-y" });
  assert.equal(reused.code, "E_KEY_USED");
});

test("the monthly cap: two mints racing in the same second - only what fits lands; the scheduler's mint shares the cap", async () => {
  // capped sources this month: admin 5M + 3M = 8M; total cap 10M -> 2M left
  const cfg = Object.assign({}, CFG.econ_cfg, { mintcap_total: 10 * M });
  const f0 = await P.balance("reserve");
  const [a, b] = await Promise.all([
    op("mint", { amount: 1500000, policy: "admin", reason: "racing admin mint one", key: "admin-race-1" }, { econ_cfg: cfg }),
    op("mint", { amount: 1500000, policy: "admin", reason: "racing admin mint two", key: "admin-race-2" }, { econ_cfg: cfg }),
  ]);
  const oks = [a, b].filter((x) => x.ok);
  assert.equal(oks.length, 1, JSON.stringify([a, b]));
  const no = [a, b].find((x) => !x.ok);
  assert.equal(no.cap, true);
  assert.equal(no.source, "admin");
  assert.equal(no.room, 500000);
  assert.equal(await P.balance("reserve"), f0 + 1500000);
  // the scheduler's floor mint (policy/apply.fedMint, live) checks the SAME journal: 500k left
  await post("/api/policy/bot/config", { cfg: Object.assign({}, CFG, { econ_cfg: cfg }) });
  const m = await require(path.join(repo, "dbUtils")).tx(() => A.fedMint({ amount: 600000, policy: "floor", reason: "the Fed back up to its floor", actor: "schedule",
                                                                           key: "mo-D2026-10-20-floor", period: "D2026-10-20", engine: "monetary", nowS: T0 }));
  assert.equal(m.ok, false);
  assert.equal(m.cap, true);
  const m2 = await require(path.join(repo, "dbUtils")).tx(() => A.fedMint({ amount: 500000, policy: "floor", reason: "the Fed back up to its floor", actor: "schedule",
                                                                            key: "mo-D2026-10-20-floor2", period: "D2026-10-20", engine: "monetary", nowS: T0 }));
  assert.equal(m2.ok, true);
  const st = (await post("/api/fed/bot/state", {})).body;
  assert.equal(st.doc.fed_mints["mo-D2026-10-20-floor2"].via, "site");
  assert.equal(st.mtd.floor, 500000);
  await post("/api/policy/bot/config", { cfg: CFG });
});

test("grants: pool caps, the floor's second confirm, protocol shares for the House, never more than the Fed holds", async () => {
  const fk0 = await P.balance("fortknox");
  let r = await op("grant", { key: "grant-fk-1", pool: "fortknox", amount: 11 * M, reason: "fill fort knox for the raid" });
  assert.equal(r.code, "E_POOL_CAP", "15M cap, 5M held");
  r = await op("grant", { key: "grant-fk-1", pool: "fortknox", amount: 2 * M, reason: "fill fort knox for the raid", actor: "boss" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await P.balance("fortknox"), fk0 + 2 * M);
  assert.equal(r.rec.conserved, true);
  const h0 = await require(path.join(repo, "capital", "core")).houseBalance();
  r = await op("grant", { key: "grant-h-1", pool: "house", amount: 1 * M, reason: "house capital for the test" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rec.booked, true);
  assert.equal(await require(path.join(repo, "capital", "core")).houseBalance(), h0 + 1 * M);
  assert.ok(await CC.seen("vaults:proto-grant-grant-h-1"), "booked on the share book under Pepe's key");
  const fed = await P.balance("reserve");
  r = await op("grant", { key: "grant-big-1", pool: "incentives", amount: fed - 40 * M, reason: "below the floor test" });
  assert.equal(r.code, "E_FLOOR_ACK");
  r = await op("grant", { key: "grant-big-1", pool: "incentives", amount: fed - 40 * M, reason: "below the floor test", ack_floor: true });
  assert.equal(r.ok, true);
  assert.equal(r.rec.below_floor, true);
  r = await op("grant", { key: "grant-huge-1", pool: "incentives", amount: 999 * M, reason: "more than the fed has" });
  assert.equal(r.code, "E_FED_SHORT");
  r = await op("grant", { key: "grant-w-1", pool: "wallet", amount: 1, reason: "never a wallet ever" });
  assert.equal(r.code, "E_POOL");
});

test("Fed loans: the shortfall minted first, the outstanding cap, flash loans repaid from the Bank, the waterfall's booking, an early repayment", async () => {
  // the Fed now holds 40M; a 12M loan would pass the 10M outstanding cap (1M open)
  let r = await op("loan_open", { vault: "fortknox", amount: 9500000, reason: "too much for the cap" });
  assert.equal(r.code, "E_LOAN_CAP");
  assert.equal(r.room, 9 * M);
  r = await op("loan_open", { vault: "fortknox", amount: 9 * M, reason: "past fort knox's cap", actor: "boss" });
  assert.equal(r.code, "E_POOL_CAP", "Fort Knox holds 7M of its 15M cap");
  r = await op("loan_open", { vault: "incentives", amount: 1 * M, reason: "grant only pool here" });
  assert.equal(r.code, "E_LOAN", "incentives are grant only");
  // a flash loan to the Bank (protocol shares), keyed
  const b0 = await P.balance("bank");
  r = await op("loan_open", { key: "fx-loan-77", vault: "bank", amount: 2 * M, reason: "flash: player loan 77", actor: "auto", auto: true, flash: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rec.id, "FL-fx-loan-77");
  assert.equal(r.rec.shares, true);
  assert.equal(await P.balance("bank"), b0 + 2 * M);
  const again = await op("loan_open", { key: "fx-loan-77", vault: "bank", amount: 2 * M, reason: "flash: player loan 77", auto: true, flash: true });
  assert.equal(again.dup, true);
  // an admin loan without a key takes the next FL<n>
  r = await op("loan_open", { vault: "fortknox", amount: 500000, reason: "a small knox loan", actor: "boss" });
  assert.equal(r.rec.id, "FL2");
  // the Bank's loan repayments come back: the flash loan is repaid first (shares leave with the capital)
  const fed0 = await P.balance("reserve");
  r = await op("flash_repay", { key: "bankrep-1", vault: "bank", amount: 1500000 });
  assert.equal(r.amount, 1500000);
  assert.equal(await P.balance("reserve"), fed0 + 1500000);
  r = await op("flash_repay", { key: "bankrep-1", vault: "bank", amount: 1500000 });
  assert.equal(r.dup, true);
  let st = (await post("/api/fed/bot/state", {})).body;
  assert.equal(st.doc.fed_loans["FL-fx-loan-77"].outstanding, 500000);
  assert.ok(st.doc.flash_repaid["bankrep-1"]);
  // the waterfall's step-1 leg moved 300k for Fort Knox's loans: booked once by its mark
  r = await op("loan_repaid", { mark: "D2026-10-20-fortknox", vault: "fortknox", amount: 300000, epoch: "D2026-10-20" });
  assert.equal(r.applied, 300000);
  r = await op("loan_repaid", { mark: "D2026-10-20-fortknox", vault: "fortknox", amount: 300000 });
  assert.equal(r.dup, true);
  st = (await post("/api/fed/bot/state", {})).body;
  assert.equal(st.doc.fed_loans.FL1.outstanding, 700000, "oldest first");
  // an early manual repayment from Fort Knox
  const fk0 = await P.balance("fortknox");
  r = await op("loan_repay", { key: "mr1abcd", id: "FL1", amount: 700000, actor: "boss" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.rec.state, "repaid");
  assert.equal(await P.balance("fortknox"), fk0 - 700000);
});

test("a loan whose shortfall mint passes the loan cap is refused whole - nothing journaled, nothing moved", async () => {
  const cfg = Object.assign({}, CFG.econ_cfg, { mintcap_loan: 1000, fedloan_cap: 999 * M });
  const fed = await P.balance("reserve");
  // drain the Fed below the loan so it must mint
  const g = await op("grant", { key: "grant-drain-1", pool: "incentives", amount: fed - 100000, reason: "drain for the shortfall test", ack_floor: true }, { econ_cfg: cfg });
  assert.equal(g.ok, true, JSON.stringify(g));
  const seq0 = Number((await F.meta("loan_seq")) || 0);
  const r = await op("loan_open", { vault: "bank", amount: 2 * M, reason: "needs a big shortfall mint", actor: "boss" }, { econ_cfg: cfg });
  assert.equal(r.ok, false);
  assert.equal(r.cap, true);
  assert.equal(r.source, "loan");
  assert.equal(Number((await F.meta("loan_seq")) || 0), seq0, "the loan number was rolled back too");
  assert.equal(await P.balance("reserve"), 100000);
});

test("donations: the site journals the wallet + bonus mints and settles the claim; Pepe no longer sees it", async () => {
  const meta = JSON.stringify({ bonus: 200000, usd_cents: 200, rate: 500000, bonus_pct: 20, via: "crypto" });
  await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount, meta) VALUES ('cdon-abc123', 'mint:donation', 'u1', 'donation', 1000000, ?)", [meta]);
  const visible = (await FUND.claims()).map((c) => c.claimId);
  assert.ok(!visible.includes("cdon-abc123"), "Pepe's claim list leaves the donation to the site");
  const inc0 = await P.balance("incentives");
  assert.equal(await F.donationSweep(), 1);
  const st = (await post("/api/fed/bot/state", {})).body;
  const w = st.doc.fed_mints["cdon-abc123-w"], b = st.doc.fed_mints["cdon-abc123-b"];
  assert.equal(w.dest, "site");
  assert.equal(w.amount, 1000000);
  assert.equal(w.actor, "crypto");
  assert.equal(w.user, "u1");
  assert.equal(w.reason, "donation $2.00 by ann (cdon-abc123)");
  assert.equal(w.conserved, true);
  assert.equal(b.dest, "incentives");
  assert.equal(b.amount, 200000);
  assert.equal(b.reason, "donation $2.00 by ann (cdon-abc123) - incentives bonus");
  assert.equal(await P.balance("incentives"), inc0 + 200000);
  assert.equal((await getQuery("SELECT settled FROM reserve_claims WHERE claimId = 'cdon-abc123'"))[0].settled, 1);
  assert.equal(await F.donationSweep(), 0, "once");
  assert.equal(st.mtd.donation, 1200000, "tracked, outside the caps");
});

test("the way back: rollback hands the books to Pepe and the engines read his doc again", async () => {
  const r = (await post("/api/fed/admin/rollback", { key: "fr-test-1", actor: "boss" })).body;
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.live, false);
  assert.equal(r.digest, sha(r.payload));
  const x = JSON.parse(r.payload);
  assert.ok(x.fed_loans["FL-fx-loan-77"] && x.fed_mints["cdon-abc123-b"] && x.flash_repaid["bankrep-1"]);
  assert.equal(await F.live(), false);
  const again = (await post("/api/fed/admin/rollback", { key: "fr-test-1" })).body;
  assert.equal(again.dup, true);
  const o = await op("mint", { amount: 1000, policy: "admin", reason: "after the rollback", key: "admin-after-1" });
  assert.equal(o.code, "not_live");
  // the cutover again with the books Pepe got back (a new key)
  const ex = { payload: r.payload, digest: r.digest, totals: r.totals };
  const c2 = (await post("/api/fed/admin/import", Object.assign({ key: "fc-test-2" }, ex))).body;
  assert.equal(c2.ok, true, JSON.stringify(c2));
  assert.equal(await F.live(), true);
});
