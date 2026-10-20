// Phase 4: the policy engines on ONE site scheduler (policy/*): modes, the lease, dry runs, shadow reports, the cutover
// handshake, the live runs (the Monday waterfall with the protocol's shares redeemed on the capital book, the daily release,
// the monetary day with a floor mint, the guarantee, a ceiling burn and the activity rewards, the burn accrual), the
// done-keys (a period never runs twice), Pepe's own leg keys (a leg he already moved is a no-op here), the effects Pepe
// mirrors, rollback, the catch-up cap, the test clock and the admin card.
//   NODE_PATH=G:/PATV/node_modules node --test test/policy.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "policy-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const P = require(path.join(repo, "pools"));
const ES = require(path.join(repo, "econstore"));
const S = require(path.join(repo, "stashes"));
const CC = require(path.join(repo, "capital", "core"));
const C = require(path.join(repo, "policy", "core"));
const E = require(path.join(repo, "policy", "engines"));
const G = require(path.join(repo, "policy", "gather"));
const A = require(path.join(repo, "policy", "apply"));
const SCH = require(path.join(repo, "policy", "scheduler"));

const M = 1000000;
const MON_0405 = Date.UTC(2026, 9, 19, 4, 5) / 1000;          // Monday 2026-10-19 04:05 UTC
const TUE_0405 = MON_0405 + 86400;
const POOLS = { reserve: 40 * M, bank: 3 * M, mm: 1 * M, fortknox: 16 * M, heist: 1 * M, incentives: 4 * M, vaultfloat: 0 };
const HOUSE = 20 * M;
const bal = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;
const wallets = async () => (await getQuery("SELECT COALESCE(SUM(points_balance),0) AS w FROM users"))[0].w;
const supply = async () => (await wallets()) + (await A.base());
const effects = async (kind) => (await getQuery("SELECT key, data FROM policy_effects WHERE kind = ? ORDER BY created, rowid", [kind])).map((r) => Object.assign(r, { data: JSON.parse(r.data) }));

let base, server;
const post = (p, body, headers = {}) => fetch(base + p, { method: "POST", headers: Object.assign({ "content-type": "application/json" }, headers),
                                                          body: JSON.stringify(Object.assign({ password: "bot" }, body)) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

// Pepe's config push: his effective econ_cfg (pepe_econcfg._ec_all), constants, flags, journals, burn settings
const CFG = {
  econ_cfg: Object.assign({}, E.DEFAULTS, { fed_floor: 50 * M, fed_ceiling: 150 * M, incentive_guarantee_target: 25 * M, activity_rewards: true,
                                            budget_activity: 7 * M, issuance_to_guarantee: false, heist_cap_mode: "pct", mintcap_floor: 30 * M }),
  consts: E.CONSTS, flags: { layers: true, tr_live: true, ap_on: false }, tz: "America/New_York", skip: ["pepebeta", "drama1"],
  journal: [{ eid: "W2026-10-12", boundary: Date.UTC(2026, 9, 12, 4) / 1000, state: "done", incentives_after: 3 * M }], days_done: [],
  burn_cfg: { mode: "accrual", accrual_every_min: 5 }, burn_inflight: 0,
};

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT, casino_banned INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE bonus_winners (bonusId TEXT PRIMARY KEY, type TEXT, userId TEXT, transactionId TEXT, amount INTEGER)");
  await runQuery("CREATE TABLE supply_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), pools TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  for (const [id, name, cf, cls] of [["u1", "ann", "ann_cf", "pleb"], ["u2", "bob", "bob_cf", "pleb"], ["u3", "carl", "carl_cf", "pleb"], ["ua", "boss", "boss_cf", "Admin"]]) {
    await runQuery("INSERT INTO users (userId, username, password, points_balance, camfrogUsername, class) VALUES (?, ?, 'x', 0, ?, ?)", [id, name, cf, cls]);
  }
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES ('seed', 's', NULL, ?)", [HOUSE]);
  await runQuery("INSERT INTO supply_snapshot (id, pools) VALUES (1, '[]')");
  // Phase 1: the pools on the site
  await P.init();
  await require(path.join(repo, "funding")).init();
  await P._setMeta("enabled", true);
  const payload = JSON.stringify({ v: 1, source: "pepe", pools: POOLS, docs: {}, routes: {}, econ_cfg: {}, econ_cfg_log: [], catalog: {} });
  const keys = Object.keys(POOLS);
  const pr = await P.importFromPepe({ key: "pc-policy-test", payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"),
                                      totals: { sum: Object.values(POOLS).reduce((t, v) => t + v, 0), count: keys.length, per_pool: POOLS } });
  assert.equal(pr.ok, true);
  await P._setMeta("imported", Object.assign((await P.exportState()).imported, { at: 0 }));
  // the stashes
  await S.init();
  await runQuery("INSERT INTO stash_meta (key, value) VALUES ('enabled', 'true')");
  const sp = JSON.stringify([{ id: "1", owner: "ann_cf", name: "nest", balance: 1000, staked: 0, earned: 0, members: [] },
                             { id: "2", owner: "bob_cf", name: "pot", balance: 0, staked: 0, earned: 0, members: [] }]);
  assert.equal((await S.importFromPepe({ payload: sp, digest: crypto.createHash("sha256").update(sp, "utf8").digest("hex"), total: 1000, count: 2, seq: 2 })).ok, true);
  // Phase 3: the capital share book on the site (House NAV = the jackpot 20M over 10M shares = 2.0)
  await CC.init();
  await CC.putDoc("vaults", {
    v: { house: { total: 10 * M, holders: { protocol: 9.5 * M, s1: 400000.0, auto: 100000.0 }, basis: 8 * M },
         bank: { total: 3 * M, holders: { protocol: 3 * M }, basis: 2.5 * M },
         mm: { total: 1 * M, holders: { protocol: 1 * M }, basis: 1 * M } },
    auto: { total: 100000.0, holders: { s2: 100000.0 } }, queue: {}, epochs: [], seq: 0, inited: 1, insured: [] });
  await CC.setMeta("live", true);
  CC.forgetLive();
  // Pepe's econ docs (pushed on every change): a Fed loan to the House, this week's budgets
  await ES.putDocs({
    econ_layers: { rev: 1, doc: { fed_mints: { "m-old": { key: "m-old", amount: 1000, policy: "admin", state: "done", ts: MON_0405 - 3 * 86400 } },
                                  fed_loans: { FL1: { id: "FL1", vault: "house", principal: 300000, outstanding: 300000, state: "open", ts: MON_0405 - 9 * 86400 } },
                                  fed_loan_repaid: {} } },
    econ_treasury: { rev: 1, doc: { week: { id: "W2026-10-12", budgets: {}, spent: { activity: 0 } }, bank_lent: [], days: {} } },
  });
  // participation (E-0): the local day that just ended at Tuesday 04:05 UTC = 2026-10-19 (New York)
  require(path.join(repo, "econ"));
  await runQuery(`CREATE TABLE IF NOT EXISTS econ_participation (room_id TEXT NOT NULL, day TEXT NOT NULL, login TEXT NOT NULL, lines INTEGER DEFAULT 0,
                  mic_min REAL DEFAULT 0, cmds INTEGER DEFAULT 0, active_min INTEGER DEFAULT 0, updated INTEGER, PRIMARY KEY (room_id, day, login))`);
  for (const [day, login, lines, mic] of [["2026-10-19", "ann_cf", 40, 0], ["2026-10-19", "bob_cf", 5, 6.5], ["2026-10-19", "carl_cf", 3, 0],
                                          ["2026-10-19", "drama1", 900, 0], ["2026-10-19", "ghost_cf", 20, 0]]) {
    await runQuery("INSERT INTO econ_participation (room_id, day, login, lines, mic_min) VALUES ('r1', ?, ?, ?, ?)", [day, login, lines, mic]);
  }
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); if (u) req.user = { userId: u, username: u, class: u === "ua" ? "Admin" : "pleb" }; next(); };
  const deps = { isBotToken: (t) => t === "bot", addUser };
  P.register(app, deps);
  ES.register(app, deps);
  require(path.join(repo, "escrow", "ledger")).register(app, deps);
  SCH.register(app, deps);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  assert.equal((await post("/api/policy/bot/config", { cfg: CFG })).body.ok, true);
});
test.after(() => server && server.close());

test("every engine starts OFF; the admin card can't set live, only Pepe's cutover", async () => {
  const st = (await post("/api/policy/bot/state", {})).body;
  assert.deepEqual(Object.values(st.engines).map((e) => e.mode), ["off", "off", "off"]);
  const s0 = await supply();
  assert.deepEqual(await SCH.pass(MON_0405), [], "nothing runs while off");
  assert.equal(await supply(), s0);
  const r = await fetch(base + "/api/admin/policy/mode", { method: "POST", headers: { "content-type": "application/json", "x-test-user": "ua", "X-Requested-With": "fetch",
                                                                                    origin: base, host: new URL(base).host },
                                                           body: JSON.stringify({ engine: "treasury", mode: "live" }) });
  assert.equal(r.status, 400);
  const v = await fetch(base + "/api/admin/policy", { headers: { "x-test-user": "ua" } }).then((x) => x.json());
  assert.equal(v.ok, true);
  assert.equal(v.engines.length, 3);
  assert.ok(v.retired.automint && v.retired.wheel_cut && v.retired.casino_feed && v.stays.room_payouts);
  const pleb = await fetch(base + "/api/admin/policy", { headers: { "x-test-user": "u1" } });
  assert.equal(pleb.status, 403);
});

test("the lease: one scheduler process at a time", async () => {
  assert.equal(await C.acquireLease("t-lease"), true);
  assert.equal(await C.acquireLease("t-lease"), true, "the holder renews");
  await runQuery("UPDATE policy_lease SET holder = 'other-process' WHERE name = 't-lease'");
  assert.equal(await C.acquireLease("t-lease"), false, "another holder's live lease is respected");
  await runQuery("UPDATE policy_lease SET expires = 0 WHERE name = 't-lease'");
  assert.equal(await C.acquireLease("t-lease"), true, "an expired lease is taken over");
});

test("DRY RUN: the Monday epoch is planned and recorded, nothing moves", async () => {
  await C.setMode("treasury", "dry", { by: "test", armedAt: MON_0405 - 3600 });
  const s0 = await supply();
  const house0 = await CC.houseBalance();
  const ran = await SCH.pass(MON_0405);
  assert.deepEqual(ran, ["dry treasury W2026-10-19", "dry treasury D2026-10-19"]);
  assert.equal(await supply(), s0);
  assert.equal(await CC.houseBalance(), house0);
  const sim = (await getQuery("SELECT site_plan FROM policy_sims WHERE key = 'dry:treasury:W2026-10-19'"))[0];
  const plan = JSON.parse(sim.site_plan);
  // House: NAV 20M, target 15M, protocol 9.5M shares x 2.0 = 19M vs basis 8M, free cash 15M -> surplus 5M; the Fed loan first
  assert.equal(plan.vaults.house.surplus, 5 * M);
  assert.equal(plan.vaults.house.fed_loan_repaid, 300000);
  assert.ok(plan.legs.some((l) => l.dst === "stash:1") && plan.legs.some((l) => l.dst === "stash:2"), "stakers (Auto looked through)");
  assert.deepEqual(await SCH.pass(MON_0405 + 60), [], "a period is planned once");
});

test("SHADOW: Pepe's report - the engine diff (the port), the inputs and the total diff are empty when both saw the same state", async () => {
  await C.setMode("treasury", "shadow", { by: "test" });
  const eid = "W2026-10-19";
  const inputs = await G.epoch(MON_0405, eid);
  const plan = E.planEpoch(inputs);
  const r = await post("/api/policy/bot/report", { engine: "treasury", period: eid, inputs, plan });
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.engine_diff, []);
  assert.deepEqual(r.body.input_diff, []);
  assert.deepEqual(r.body.total_diff, []);
  // a wrong plan from Pepe shows up in the engine diff
  const bad = JSON.parse(JSON.stringify(plan));
  bad.legs[0].amt += 1;
  const r2 = await post("/api/policy/bot/report", { engine: "treasury", period: eid + "-x1", inputs, plan: bad });
  assert.ok(r2.body.engine_diff.length >= 1 && /legs\[0\]\.amt/.test(r2.body.engine_diff[0]), JSON.stringify(r2.body.engine_diff));
  const card = await SCH.view();
  assert.equal(card.engines.find((e) => e.engine === "treasury").last_diff.ok, false, "the card shows the last diff");
});

test("CUTOVER: refused from dry / off and while the share book is Pepe's; recorded handover periods never run again", async () => {
  assert.equal((await post("/api/policy/admin/cutover", { key: "pc-cut-0001", engines: ["monetary"] })).body.code, "not_shadow");
  await CC.setMeta("live", false); CC.forgetLive();
  assert.equal((await post("/api/policy/admin/cutover", { key: "pc-cut-0001", engines: ["treasury"] })).body.code, "capital_local");
  await CC.setMeta("live", true); CC.forgetLive();
  const r = await post("/api/policy/admin/cutover", { key: "pc-cut-0001", engines: ["treasury"], actor: "test",
                                                      handover: { treasury: { armed_at: MON_0405 - 3600, done: [{ period: "D2026-10-18", boundary: MON_0405 - 86400 - 300 }] } } });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.deepEqual(r.body.handed, ["treasury:D2026-10-18"]);
  assert.equal((await C.engines()).treasury.mode, "live");
  const again = await post("/api/policy/admin/cutover", { key: "pc-cut-0001", engines: ["treasury"] });
  assert.equal(again.body.dup, true, "idempotent by key");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM policy_audit WHERE engine = 'treasury' AND new = 'live'"))[0].n, 1);
});

test("LIVE: the Monday epoch - shares redeemed on the capital book (Pepe's key), the legs, the effects; supply unchanged; never twice", async () => {
  const s0 = await supply();
  const house0 = await CC.houseBalance();
  const fed0 = await P.balance("reserve");
  const ran = await SCH.pass(MON_0405);
  assert.ok(ran.includes("treasury W2026-10-19") && ran.includes("treasury D2026-10-19"), JSON.stringify(ran));
  const run = await C.run("treasury", "W2026-10-19");
  assert.equal(run.state, "done");
  const plan = run.plan;
  assert.equal(await supply(), s0, "CONSERVATION: the waterfall and the release move PAT between pools, the House and stashes");
  assert.equal(run.result.conserved, true);
  assert.equal(house0 - (await CC.houseBalance()), plan.vaults.house.surplus, "the House paid exactly its surplus");
  // the protocol's House shares: 5M at 2.0 = 2.5M shares redeemed, once, under Pepe's own booking key
  const book = await CC.doc("vaults", null);
  assert.ok(Math.abs(book.v.house.holders.protocol - 7 * M) < 1e-6, String(book.v.house.holders.protocol));
  assert.ok((await getQuery("SELECT 1 FROM capital_ops WHERE key = 'vaults:proto-wf-W2026-10-19-house'"))[0]);
  // stakers paid into their stashes (the key Pepe's stash leg uses)
  const s1 = (await S.get("1")).balance, s2 = (await S.get("2")).balance;
  const leg1 = plan.legs.find((l) => l.dst === "stash:1"), leg2 = plan.legs.find((l) => l.dst === "stash:2");
  assert.equal(s1, 1000 + leg1.amt);
  assert.equal(s2, leg2.amt);
  // the Fed loan repaid first (an effect Pepe applies with _fl_apply_repay), the Fed's split
  assert.equal(await P.balance("reserve") - fed0 >= 300000, true);
  const reps = await effects("loan_repay");
  assert.deepEqual(reps.map((e) => e.data), [{ mark: "W2026-10-19-house", epoch: "W2026-10-19", vault: "house", amount: 300000 }]);
  assert.equal((await effects("epoch_record"))[0].data.rec.state, "done");
  const tr = (await effects("epoch_record"))[0].data.rec.track;
  assert.ok(tr && tr.vaults && tr.cap_in_force_pct !== undefined, "the record carries the D2 monitoring (engines.trackOf), as Pepe's");
  assert.equal((await effects("week_share"))[0].data.share, plan.totals.incentives);
  // the overlay: until Pepe's doc shows the repayment, the site sees the loan repaid
  const loans = await G.fedLoans((await G.docs()).econ_layers.doc);
  assert.equal(loans.find((l) => l.id === "FL1").outstanding, 0);
  // never twice: the done-key
  const s1b = await supply();
  assert.deepEqual((await SCH.pass(MON_0405 + 120)).filter((x) => x.startsWith("treasury W")), []);
  assert.equal((await A.runTreasuryEpoch("W2026-10-19", MON_0405 + 200)).already, true);
  assert.equal(await supply(), s1b);
});

test("a leg Pepe already moved (same key) is not moved again", async () => {
  await P.move({ key: "tr-test-dup:out", legs: [["fortknox", -1000]], why: "pepe did it" });
  await P.move({ key: "tr-test-dup:in", legs: [["incentives", 1000]], why: "pepe did it" });
  const fk = await P.balance("fortknox"), inc = await P.balance("incentives");
  const { tx } = require(path.join(repo, "dbUtils"));
  assert.equal(await tx(() => A.transfer("tr-test-dup", "fortknox", "incentives", 1000, "test")), "dup");
  assert.equal(await P.balance("fortknox"), fk);
  assert.equal(await P.balance("incentives"), inc);
});

test("LIVE monetary: floor mint (journaled, capped), the guarantee, the activity rewards; then shadow -> cutover", async () => {
  await C.setMode("monetary", "shadow", { by: "test", armedAt: MON_0405 - 3600 });
  // the Fed below its floor: take it to 30M (a keyed move to Fort Knox stands in for spending)
  const fed = await P.balance("reserve");
  await P.move({ key: "test-drain-fed", legs: [["reserve", -(fed - 30 * M)], ["fortknox", fed - 30 * M]], why: "test" });
  assert.equal((await post("/api/policy/admin/cutover", { key: "pc-cut-0002", engines: ["monetary"], actor: "test",
                                                          handover: { monetary: { armed_at: MON_0405 - 3600 } } })).body.ok, true);
  const s0 = await supply();
  const fed0 = await P.balance("reserve"), inc0 = await P.balance("incentives");
  const ran = await SCH.pass(TUE_0405);
  assert.ok(ran.includes("treasury D2026-10-20") && ran.includes("monetary D2026-10-20"), JSON.stringify(ran));
  const run = await C.run("monetary", "D2026-10-20");
  const plan = run.plan;
  assert.equal(plan.floor_mint, 5 * M, "the floor mint is capped by the daily limit (5M)");
  assert.equal(plan.guarantee, false, "not the Monday of the epoch");
  const mint = (await getQuery("SELECT rec FROM policy_mints WHERE key = 'floor-D2026-10-20'"))[0];
  assert.ok(mint, "the mint is journaled");
  assert.equal(JSON.parse(mint.rec).conserved, true);
  assert.ok((await getQuery("SELECT 1 FROM pool_moves WHERE key = 'fedmint-floor-D2026-10-20:in'"))[0], "the mint leg uses Pepe's key");
  assert.equal((await effects("fed_mint"))[0].data.key, "floor-D2026-10-20");
  // activity: ann (40 lines) and bob (6.5 mic minutes) are active; carl (3 lines), drama1 (a bot) and ghost (no account) not / unpaid
  const act = (await effects("activity_record"))[0].data.rec;
  assert.deepEqual(Object.keys(act.payouts).sort(), ["ann_cf", "bob_cf", "ghost_cf"]);
  assert.equal(act.state.ghost_cf, "failed", "no account: nothing debited");
  assert.ok((await bal("u1")) > 0 && (await bal("u2")) > 0, JSON.stringify(act));
  assert.equal(await bal("u3"), 0);
  assert.equal(act.paid, (await bal("u1")) + (await bal("u2")));
  const spend = (await effects("budget_spend"))[0].data;
  assert.equal(spend.group, "activity");
  assert.equal(spend.amount, act.paid);
  // supply: + the floor mint exactly (the activity rewards move incentives -> wallets)
  assert.equal(await supply(), s0 + 5 * M);
  void fed0; void inc0;
  // the supply history shows the site's mint that day (merged with Pepe's map, which leaves the site's records out)
  const SH = require(path.join(repo, "supplyhistory"));
  SH._setClock(() => (TUE_0405 + 3600) * 1000);
  await SH.record({ total: await supply(), circulating: await supply(), rows: [], layers: [] }, null);
  const hrow = (await SH.history(3)).find((r) => r.day === "2026-10-20");
  assert.equal(hrow.mints.floor, 5 * M, JSON.stringify(hrow));
  SH._setClock(null);
  // the daily ran first (ordering): the monetary day reads after the release
  assert.equal((await C.run("treasury", "D2026-10-20")).state, "done");
  assert.equal((await A.runMonetary("D2026-10-20", TUE_0405 + 60, false)).already, true, "never twice");
});

test("the Monday guarantee waits for the epoch, then tops the incentive budget up to its target", async () => {
  const NEXT_MON = MON_0405 + 7 * 86400;
  // the epoch for W2026-10-26 hasn't run: monetary waits (less than 12 h)
  await runQuery("UPDATE policy_engines SET mode = 'shadow' WHERE engine = 'treasury'");
  const r0 = await SCH.pass(NEXT_MON, { only: ["monetary"] });
  assert.deepEqual(r0, [], "waits for the epoch");
  await runQuery("UPDATE policy_engines SET mode = 'live' WHERE engine = 'treasury'");
  // ...and this epoch's monitoring fails: like Pepe's try / except around _tr_track, the settlement still commits (all legs),
  // the record has no track, the error is logged
  const oTrack = E.trackOf, oErr = console.error;
  const logged = [];
  E.trackOf = () => { throw new Error("track boom"); };
  console.error = (...a) => { logged.push(a.join(" ")); };
  let ran;
  try {
    ran = await SCH.pass(NEXT_MON);
  } finally { E.trackOf = oTrack; console.error = oErr; }
  assert.ok(ran.includes("treasury W2026-10-26") && ran.includes("monetary D2026-10-26"), JSON.stringify(ran));
  const wrun = await C.run("treasury", "W2026-10-26");
  assert.equal(wrun.state, "done", "a monitoring error doesn't roll the weekly payout back");
  assert.equal(wrun.result.done_legs.length, wrun.plan.legs.length);
  const wrec = (await effects("epoch_record")).find((e) => e.data.eid === "W2026-10-26").data.rec;
  assert.equal(wrec.state, "done");
  assert.equal("track" in wrec, false, "no track on the record, as Pepe's");
  assert.ok(logged.some((l) => /\[policy\] epoch W2026-10-26: track: track boom/.test(l)), JSON.stringify(logged));
  const plan = (await C.run("monetary", "D2026-10-26")).plan;
  assert.equal(plan.guarantee, true);
  assert.equal(plan.guarantee_target, 25 * M);
  const inc = (await C.run("treasury", "W2026-10-26")).result.incentives_after;
  assert.equal(plan.guarantee_base, inc, "the base is the budget as the epoch left it");
  assert.equal(plan.guarantee_paid, Math.max(0, 25 * M - inc));
});

test("the catch-up cap: a day the site was down through is MISSED, never run late", async () => {
  const LATER = MON_0405 + 9 * 86400;              // Wednesday 10-28 04:05: Tuesday 10-27 was never run
  await SCH.pass(LATER);
  assert.equal((await C.run("monetary", "D2026-10-27")).state, "missed");
  assert.equal((await C.run("treasury", "D2026-10-27")).state, "missed");
  assert.equal((await C.run("monetary", "D2026-10-28")).state, "done");
});

test("BURN accrual: the burn reserve is burned (pool move kind burn + a public log row); supply falls by exactly that", async () => {
  await P.move({ key: "test-feed-burn", legs: [["reserve", -12345], ["burn", 12345]], why: "fed ceiling release" });
  await C.setMode("burn", "shadow", { by: "test" });
  assert.equal((await post("/api/policy/admin/cutover", { key: "pc-cut-0003", engines: ["burn"], actor: "test" })).body.ok, true);
  const s0 = await supply();
  const ran = await SCH.pass(MON_0405 + 10 * 86400, { only: ["burn"] });
  assert.ok(ran.some((x) => x.startsWith("burn A")), JSON.stringify(ran));
  assert.equal(await P.balance("burn"), 0);
  assert.equal(await supply(), s0 - 12345);
  const row = (await getQuery("SELECT * FROM pat_burns"))[0];
  assert.equal(row.amount, 12345);
  assert.equal(row.actor_kind, "auto");
  assert.equal((await effects("burn"))[0].data.amount, 12345);
});

test("ROLLBACK: the periods this site ran + every effect Pepe hasn't applied; the engines go back to shadow; a new key cuts over again", async () => {
  const st = (await post("/api/policy/bot/state", {})).body;
  assert.ok(st.effects.length >= 8);
  const r = await post("/api/policy/admin/rollback", { key: "pr-roll-0001", engines: ["treasury", "monetary", "burn"], actor: "test" });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.deepEqual(r.body.ran.treasury.map((x) => x.period), ["W2026-10-19", "D2026-10-19", "D2026-10-20", "W2026-10-26", "D2026-10-26", "D2026-10-28"]);
  assert.ok(r.body.effects.length === st.effects.length);
  const eng = await C.engines();
  assert.deepEqual([eng.treasury.mode, eng.monetary.mode, eng.burn.mode], ["shadow", "shadow", "shadow"]);
  // Pepe applies and acks them
  assert.equal((await post("/api/policy/bot/ack", { keys: r.body.effects.map((e) => e.key) })).body.acked, r.body.effects.length);
  assert.equal((await post("/api/policy/bot/state", {})).body.effects.length, 0);
  assert.equal((await post("/api/policy/admin/rollback", { key: "pr-roll-0001", engines: ["treasury"] })).body.dup, true);
  // shadow again: the site computes alongside, moves nothing
  const s0 = await supply();
  await SCH.pass(MON_0405 + 11 * 86400);
  assert.equal(await supply(), s0);
  assert.equal((await post("/api/policy/admin/cutover", { key: "pc-cut-0004", engines: ["treasury", "monetary"], actor: "test" })).body.ok, true);
});

test("the test clock and the tagged rehearsal tick exist only on staging", async () => {
  const r = await fetch(base + "/api/policy/admin/tick", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "bot", at: MON_0405 }) });
  assert.equal(r.status, 404);
  await assert.rejects(C.setTestClock(MON_0405), /only on staging/);
});
