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
  // PO-0b (D-6): the policy mode is a Pepe OWNER's - boss (Admin) holds the owner role on his linked login
  await require(path.join(repo, "staffroles")).init();
  await runQuery("INSERT INTO pepe_roles (login, role, ts, by, via) VALUES ('boss_cf', 'owner', 1, 'test', 'web')");
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
  // PO-1 (D-15): no differences, but no boundary snapshot either (a Pepe before PO-0c): compared with the site's view at report
  // time - which may already hold his legs - so the period is NOT clean (test/policy-boundary.test.js: with the handshake)
  assert.equal(r.body.basis, "report");
  assert.equal(r.body.clean, false);
  assert.equal((await getQuery("SELECT ok FROM policy_sims WHERE key = ?", [`shadow:treasury:${eid}`]))[0].ok, 0);
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

test("PO-1: the diff cap - 400 differences listed, all of them counted, the comparison marked truncated (and never clean)", async () => {
  const many = {};
  for (let i = 0; i < 500; i++) many[`k${i}`] = i;
  const d = SCH.diffCapped(many, {});
  assert.equal(d.list.length, SCH.DIFF_CAP);
  assert.equal(SCH.DIFF_CAP, 400);
  assert.equal(d.n, 500);
  assert.equal(d.truncated, true);
  assert.equal(SCH.diffCapped({ a: 1 }, { a: 2 }).truncated, false);
  assert.equal(SCH.diff(many, {}).length, 400, "diff() = the capped list");
  // a report whose plan differs everywhere: the engine diff stops at 400, the row says truncated
  const inputs = await G.daily(MON_0405, "D2026-10-19-cap");
  const plan = Object.assign({}, E.planDaily(inputs), many);
  const r = await post("/api/policy/bot/report", { engine: "treasury", period: "D2026-10-19-cap", inputs, plan });
  assert.equal(r.body.engine_diff.length, 400);
  assert.equal(r.body.truncated.engine, true);
  assert.equal(r.body.clean, false);
  const row = (await getQuery("SELECT truncated, ok FROM policy_sims WHERE key = 'shadow:treasury:D2026-10-19-cap'"))[0];
  assert.deepEqual([row.truncated, row.ok], [1, 0]);
});

test("PO-1 burn: a day summary of each closed policy day (even at zero); Pepe's daily burn report is compared with it", async () => {
  // the burn engine is in shadow since the rollback. The pool history has REAL timestamps (pools.js: Date.now()), and a day
  // is summarized / compared only once it has closed by that clock (PO-1 review) - so: real days, six to two days ago
  assert.equal((await C.engines()).burn.mode, "shadow");
  const R = E.dayStart(Date.now() / 1000, 4);                     // the open day's start (the last 04:00 UTC)
  const D = R - 6 * 86400;
  const day = (i) => E.dayId(D + i * 86400, 4);
  const did = day(0), next = day(1);
  await runQuery("UPDATE policy_engines SET armed_at = ? WHERE engine = 'burn'", [D + 1]);      // armed during day 0
  const at = async (keys, ts) => runQuery(`UPDATE pool_move_legs SET ts = ? WHERE move_key IN (${keys.map(() => "?").join(",")})`, [Math.round(ts * 1000), ...keys]);
  const before = await G.burnDay(D + 86400, did, D, D + 86400);
  await P.move({ key: "test-feed-burn-2", legs: [["reserve", -7000], ["burn", 7000]], why: "fed ceiling release" });
  await P.move({ key: "pepe-burn-b1", legs: [["burn", -4000]], kind: "burn", why: "waterfall leftover (burned on accrual)" });
  await P.move({ key: "pepe-burn-b2", legs: [["burn", -3000]], kind: "burn", why: "waterfall leftover (burned on accrual)" });
  await at(["test-feed-burn-2", "pepe-burn-b1", "pepe-burn-b2"], D + 3600);                    // they happened on day 0
  // the first pass after the day closed records it once (shadow:burn:D...), as that day's boundary snapshot too - the
  // armed day only (the days before the engine was armed aren't summarized)
  const ran = await SCH.pass(D + 86400 + 300, { only: ["burn"] });
  assert.deepEqual(ran, [`shadow burn ${did}`]);
  assert.deepEqual(await SCH.pass(D + 86400 + 400, { only: ["burn"] }), [], "once");
  const row = (await getQuery("SELECT site_plan, site_boundary_plan, boundary_ts FROM policy_sims WHERE key = ?", [`shadow:burn:${did}`]))[0];
  const plan = JSON.parse(row.site_plan);
  assert.deepEqual(plan, { day: did, from: D, to: D + 86400, mode: "accrual", burned: before.burned + 7000, burns: before.burns + 2 });
  assert.equal(row.site_boundary_plan, row.site_plan);
  assert.ok(row.boundary_ts > 0);
  // a day with no burn is recorded too
  assert.deepEqual(await SCH.pass(D + 2 * 86400 + 300, { only: ["burn"] }), [`shadow burn ${next}`]);
  assert.equal(JSON.parse((await getQuery("SELECT site_plan FROM policy_sims WHERE key = ?", [`shadow:burn:${next}`]))[0].site_plan).burned, 0);
  // Pepe's daily burn report (his burns.json for the same closed day): accepted (planOf("burn")), compared - clean
  const pin = { kind: "burn", now: D + 86400 + 500, did, from: D, to: D + 86400, mode: "accrual", burned: plan.burned, burns: plan.burns, inflight: 0 };
  const r = await post("/api/policy/bot/report", { engine: "burn", period: did, inputs: pin, plan: E.planBurn(pin) });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.deepEqual([r.body.engine_diff, r.body.total_diff, r.body.basis, r.body.clean], [[], [], "boundary", true]);
  // his record of the zero day says he burned something: a real difference
  const bad = { kind: "burn", now: D + 2 * 86400 + 500, did: next, from: D + 86400, to: D + 2 * 86400, mode: "accrual", burned: 1, burns: 1 };
  const rb = await post("/api/policy/bot/report", { engine: "burn", period: next, inputs: bad, plan: E.planBurn(bad) });
  assert.deepEqual(rb.body.total_diff, ["burned: site 0 / pepe 1", "burns: site 0 / pepe 1"]);
  assert.equal(rb.body.clean, false);
  // a report that arrives before the scheduler's summary takes the day's snapshot itself (the day is closed: same answer)
  const d3 = day(2);
  const z = { kind: "burn", now: D + 3 * 86400 + 5, did: d3, from: D + 2 * 86400, to: D + 3 * 86400, mode: "accrual", burned: 0, burns: 0 };
  const rz = await post("/api/policy/bot/report", { engine: "burn", period: d3, inputs: z, plan: E.planBurn(z) });
  assert.deepEqual([rz.body.basis, rz.body.clean], ["boundary", true]);
  // a burn report needs burn inputs
  assert.equal((await post("/api/policy/bot/report", { engine: "burn", period: d3, inputs: { kind: "daily" }, plan: {} })).body.ok, false);
  // a comparison row that exists WITHOUT a snapshot (Pepe's report came first and its snapshot failed) gets the day's snapshot
  // from the scheduler - his report stays
  await runQuery(`INSERT INTO policy_sims (key, mode, engine, period, pepe_plan, ok, created, updated) VALUES (?, 'shadow', 'burn', ?, '{"burned":0}', 0, 1, 1)`,
                 [`shadow:burn:${day(3)}`, day(3)]);
  // PO-1 review: days a pause skipped are summarized once the engine runs again (BURN_BACKFILL_DAYS back)
  await SCH.setPause(["burn"], true, { by: "boss", auditId: "ua", via: "admin", note: "burn check" });
  assert.deepEqual(await SCH.pass(D + 5 * 86400 + 300, { only: ["burn"] }), [], "paused: nothing summarized");
  await SCH.setPause(["burn"], false, { by: "boss", auditId: "ua", via: "admin" });
  assert.deepEqual(await SCH.pass(D + 5 * 86400 + 400, { only: ["burn"] }), [`shadow burn ${day(3)}`, `shadow burn ${day(4)}`], "the skipped days, oldest first");
  assert.equal(SCH.BURN_BACKFILL_DAYS, 7);
  const filled = (await getQuery("SELECT boundary_ts, site_boundary_plan, pepe_plan FROM policy_sims WHERE key = ?", [`shadow:burn:${day(3)}`]))[0];
  assert.ok(filled.boundary_ts > 0 && JSON.parse(filled.site_boundary_plan).day === day(3), "the snapshot-less row got its snapshot");
  assert.equal(filled.pepe_plan, '{"burned":0}', "his report is kept");
  // PO-1 review: a day that hasn't CLOSED (today's, by the pool history's clock) is never snapshotted - neither by a boundary
  // call nor by an early report (refused, nothing recorded) - a burn later today still lands in its summary
  const today = E.dayId(R, 4);
  const ob = await post("/api/policy/bot/boundary", { engine: "burn", period: today, now: R + 60 });
  assert.equal(ob.body.ok, false);
  assert.match(ob.body.error, /hasn't closed yet/);
  const oz = { kind: "burn", now: R + 60, did: today, from: R, to: R + 86400, mode: "accrual", burned: 0, burns: 0 };
  const orp = await post("/api/policy/bot/report", { engine: "burn", period: today, inputs: oz, plan: E.planBurn(oz) });
  assert.equal(orp.body.ok, false);
  assert.match(orp.body.error, /hasn't closed yet/);
  assert.equal(await getQuery("SELECT 1 FROM policy_sims WHERE period = ?", [today]).then((x) => x.length), 0, "nothing recorded for the open day");
  assert.equal((await post("/api/policy/bot/boundary", { engine: "burn", period: E.dayId(R + 86400, 4), now: R })).body.ok, false, "a future day neither");
  // ...and the scheduler doesn't summarize it either (a pass whose clock - a staging test clock - says it closed)
  const ahead = await SCH.pass(R + 86400 + 300, { only: ["burn"] });
  assert.ok(!ahead.some((y) => y.includes(today)), JSON.stringify(ahead));
  assert.equal(await getQuery("SELECT 1 FROM policy_sims WHERE period = ?", [today]).then((x) => x.length), 0);
});

test("PO-1 pause: a paused live engine runs nothing (its due periods missed 'paused', the mode unchanged); a resume lets only the current period run, late", async () => {
  const SAT = MON_0405 + 12 * 86400, SUN = SAT + 86400;          // 2026-10-31 / 2026-11-01 04:05
  const engs0 = await C.engines();
  assert.deepEqual([engs0.treasury.mode, engs0.monetary.mode], ["live", "live"]);
  // the re-cutover above armed them at the real clock: arm them on the test's Friday instead (the periods below are due)
  await runQuery("UPDATE policy_engines SET armed_at = ? WHERE engine IN ('treasury', 'monetary')", [MON_0405 + 11 * 86400]);
  const res = await SCH.setPause(["treasury", "monetary"], true, { by: "boss", auditId: "ua", via: "admin", note: "checking the waterfall" });
  assert.deepEqual(res.map((x) => [x.engine, x.paused, x.was]), [["treasury", true, false], ["monetary", true, false]]);
  assert.deepEqual((await SCH.setPause(["treasury"], true, { by: "boss", auditId: "ua", via: "admin", note: "again" }))[0].unchanged, true, "idempotent");
  const s0 = await supply();
  assert.deepEqual(await SCH.pass(SAT, { only: ["treasury", "monetary"] }), [], "nothing runs");
  assert.deepEqual(await SCH.pass(SUN, { only: ["treasury", "monetary"] }), []);
  assert.equal(await supply(), s0, "nothing moved");
  for (const [e, p] of [["treasury", "D2026-10-31"], ["monetary", "D2026-10-31"], ["treasury", "D2026-11-01"], ["monetary", "D2026-11-01"]]) {
    const r = await C.run(e, p);
    assert.equal(r.state, "missed", `${e} ${p}`);
    assert.equal(r.result.missed, "paused");
    assert.match(r.error, /^paused by boss \(checking the waterfall\)/);
  }
  const engs1 = await C.engines();
  assert.deepEqual([engs1.treasury.mode, engs1.monetary.mode, engs1.treasury.paused, engs1.treasury.paused_by], ["live", "live", 1, "boss"], "the mode is unchanged");
  assert.equal((await post("/api/policy/bot/state", {})).body.engines.treasury.paused, true, "Pepe sees it");
  assert.ok((await getQuery("SELECT 1 FROM policy_audit WHERE engine = 'treasury' AND old = 'running' AND new = 'paused' AND by = 'boss'"))[0]);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'policy.pause' AND admin_id = 'ua' AND reason = 'checking the waterfall'"))[0].n, 2);
  // a paused engine isn't cut over (nothing would run it): the burn engine (shadow) paused -> refused; in shadow it plans nothing
  await SCH.setPause(["burn"], true, { by: "boss", auditId: "ua", via: "admin", note: "rehearsal" });
  assert.equal((await post("/api/policy/admin/cutover", { key: "pc-cut-0005", engines: ["burn"], actor: "test" })).body.code, "paused");
  const sims0 = (await getQuery("SELECT COUNT(*) AS n FROM policy_sims WHERE engine = 'burn'"))[0].n;
  assert.deepEqual(await SCH.pass(MON_0405 + 30 * 86400, { only: ["burn"], tag: "p1" }), []);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM policy_sims WHERE engine = 'burn'"))[0].n, sims0, "a paused shadow engine plans nothing");
  await SCH.setPause(["burn"], false, { by: "boss", auditId: "ua", via: "admin" });
  // RESUME on Sunday 05:05: only the CURRENT day may still run (late); Saturday stays missed (D-18)
  C._setClock(() => (SUN + 3600) * 1000);
  try {
    const rs = await SCH.setPause(["treasury", "monetary"], false, { by: "boss", auditId: "ua", via: "admin" });
    assert.deepEqual(rs.map((x) => [x.engine, x.released]), [["treasury", ["D2026-11-01"]], ["monetary", ["D2026-11-01"]]]);
    const ran = await SCH.pass(SUN + 3600);
    assert.ok(ran.includes("treasury D2026-11-01") && ran.includes("monetary D2026-11-01"), JSON.stringify(ran));
  } finally { C._setClock(null); }
  const t = await C.run("treasury", "D2026-11-01"), m = await C.run("monetary", "D2026-11-01");
  assert.equal(t.state, "done");
  assert.equal(t.result.late.why, "paused", "flagged late on the record");
  assert.equal(t.result.late.late_s, 3900);
  assert.equal(m.result.late.why, "paused");
  assert.equal((await C.run("treasury", "D2026-10-31")).state, "missed", "the older day stays missed");
  assert.equal((await C.run("monetary", "D2026-10-31")).state, "missed");
  assert.ok((await effects("alert")).some((e) => e.key === "alert:late:treasury:D2026-11-01"), "the admins are told (Pepe's notice)");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM policy_meta WHERE key LIKE 'late:%'"))[0].n, 0, "the late marks are used up");
  const v = await SCH.view();
  assert.ok(v.missed.some((x) => x.key === "treasury:D2026-10-31"));
  assert.deepEqual(v.whitelist.map((w) => `${w.on} ${w.engine} ${w.field}`),
                   ["plan treasury release", "inputs treasury week.*", "inputs monetary week.*", "inputs monetary rows / days / skip", "decision monetary guarantee"]);
  assert.ok(v.whitelist.every((w) => /^test\/policy-boundary\.test\.js: /.test(w.test)), "each entry names its proving test");
  assert.equal(v.engines.find((e) => e.engine === "treasury").paused, false);
});

test("PO-1 / D-18: a Monday outage - the week's epoch still runs on Tuesday (the current week), flagged late; Monday's day stays missed", async () => {
  // the scheduler last passed on Sunday 05:05; it comes back on Tuesday 06:05
  const TUE = MON_0405 + 15 * 86400 + 3600;                       // 2026-11-03 06:05
  const ran = await SCH.pass(TUE);
  assert.ok(ran.includes("treasury W2026-11-02") && ran.includes("treasury D2026-11-03") && ran.includes("monetary D2026-11-03"), JSON.stringify(ran));
  const w = await C.run("treasury", "W2026-11-02");
  assert.equal(w.result.late.why, "site_down");
  assert.ok(w.result.late.late_s > 86400);
  assert.equal((await C.run("treasury", "D2026-11-03")).result.late.why, "site_down");
  assert.equal((await C.run("treasury", "D2026-11-02")).state, "missed", "the outage's day: missed, never run late");
  assert.equal((await C.run("monetary", "D2026-11-02")).state, "missed");
  // on time: no flag
  const WED = MON_0405 + 16 * 86400;
  await SCH.pass(WED);
  assert.equal((await C.run("treasury", "D2026-11-04")).result.late, undefined);
});

test("PO-1 review: the pause is enforced at WRITE time - a pause during a pass stops its later runs, a resume during one is never undone, a failed period is released, an alert each time", async () => {
  const B = Date.UTC(2026, 10, 9, 4) / 1000;                      // Monday 2026-11-09 04:00 UTC
  const OA = require(path.join(repo, "opsalerts"));
  const oAlert = OA.alert, alerts = [];
  OA.alert = async (a) => { alerts.push(a); return oAlert(a); };
  const both = { only: ["treasury", "monetary"] };
  const by = { by: "boss", auditId: "ua", via: "admin" };
  const atClock = async (s, fn) => { C._setClock(() => s * 1000); try { return await fn(); } finally { C._setClock(null); } };
  try {
    // (a) the owner presses Pause while the epoch's transaction holds the write gate: it commits right after the epoch - the
    // daily of the SAME pass re-reads the switch inside its own transaction (apply.gate) and doesn't run: missed "paused"
    const oEpoch = A.runTreasuryEpoch;
    A.runTreasuryEpoch = async (...a) => { const r = await oEpoch(...a); await SCH.setPause(["treasury"], true, Object.assign({ note: "stop it" }, by)); return r; };
    let ran;
    try { ran = await SCH.pass(B + 60, both); } finally { A.runTreasuryEpoch = oEpoch; }
    assert.ok(ran.includes("treasury W2026-11-09") && !ran.includes("treasury D2026-11-09"), JSON.stringify(ran));
    const d0 = await C.run("treasury", "D2026-11-09");
    assert.deepEqual([d0.state, d0.result.missed], ["missed", "paused"]);
    assert.match(d0.error, /^paused by boss \(stop it\)/);
    assert.equal((await C.run("monetary", "D2026-11-09")), null, "the Monday monetary day waits for the daily release");
    assert.ok(alerts.some((a) => a.source === "policy" && /treasury PAUSED by boss/.test(a.title) && /Note: stop it/.test(a.body)), "every admin is told (opsalerts)");
    // the outage before it (11-05..11-08, never run) was swept on that pass: recorded missed, one alert per sweep
    for (const d of ["D2026-11-05", "D2026-11-06", "D2026-11-07", "D2026-11-08"]) assert.equal((await C.run("treasury", d)).state, "missed", d);
    assert.ok((await effects("alert")).some((e) => e.key === "alert:missed:treasury:D2026-11-09" && /D2026-11-05 \(site_down\)/.test(e.data.text)));
    const rs = await atClock(B + 120, () => SCH.setPause(["treasury"], false, by));
    assert.deepEqual(rs[0].released, ["D2026-11-09"]);
    assert.ok(alerts.some((a) => /treasury resumed by boss/.test(a.title)), "the resume is announced too");
    ran = await SCH.pass(B + 180, both);
    assert.ok(ran.includes("treasury D2026-11-09") && ran.includes("monetary D2026-11-09"), JSON.stringify(ran));
    assert.equal((await C.run("treasury", "D2026-11-09")).result.late.why, "paused");
    // (b) a RESUME that lands between the pass's read of the engines and its paused pass: the paused pass re-reads the flag in
    // its own transaction - the current period is NOT recorded missed (it runs at the next pass, late: its boundary fell in the pause)
    const TUE = B + 86400;
    await atClock(TUE - 3600, () => SCH.setPause(["treasury"], true, Object.assign({ note: "night check" }, by)));
    const oEng = C.engines;
    let fire = true;
    C.engines = async (...a) => {
      const r = await oEng(...a);
      if (fire) { fire = false; await atClock(TUE + 600, () => SCH.setPause(["treasury"], false, by)); }
      return r;
    };
    try { ran = await SCH.pass(TUE + 600, both); } finally { C.engines = oEng; }
    assert.ok(!ran.includes("treasury D2026-11-10"), "this pass read the engine as paused");
    assert.equal(await C.run("treasury", "D2026-11-10"), null, "not recorded missed after the resume");
    assert.equal((await C.engines()).treasury.paused, 0);
    ran = await SCH.pass(TUE + 900, both);
    assert.ok(ran.includes("treasury D2026-11-10"), JSON.stringify(ran));
    assert.equal((await C.run("treasury", "D2026-11-10")).result.late.why, "paused");
    // (c) a FAILED current period, then a pause: the paused pass records it missed "paused" - and the resume releases it
    const WED2 = B + 2 * 86400;
    await C.putRun("treasury", "D2026-11-11", { state: "failed", via: "site", error: "boom" });
    await atClock(WED2 + 30, () => SCH.setPause(["treasury"], true, Object.assign({ note: "after a failure" }, by)));
    await SCH.pass(WED2 + 60, both);
    const f = await C.run("treasury", "D2026-11-11");
    assert.deepEqual([f.state, f.result.missed], ["missed", "paused"], "the failed row is recorded missed (paused)");
    assert.deepEqual((await atClock(WED2 + 120, () => SCH.setPause(["treasury"], false, by)))[0].released, ["D2026-11-11"]);
    ran = await SCH.pass(WED2 + 180, both);
    assert.ok(ran.includes("treasury D2026-11-11"), JSON.stringify(ran));
    // (d) a pause across the boundary with NO pass during it (nothing recorded): the resume still releases the current period
    // (its boundary fell inside the pause), flagged late
    const THU = B + 3 * 86400;
    await atClock(THU - 3600, () => SCH.setPause(["treasury"], true, Object.assign({ note: "quiet night" }, by)));
    assert.deepEqual((await atClock(THU + 600, () => SCH.setPause(["treasury"], false, by)))[0].released, ["D2026-11-12"]);
    ran = await SCH.pass(THU + 700, both);
    assert.ok(ran.includes("treasury D2026-11-12"), JSON.stringify(ran));
    assert.equal((await C.run("treasury", "D2026-11-12")).result.late.why, "paused");
    // (e) a current period left "missed paused" while the engine runs (an older site's race): it heals - runs, late
    const FRI = B + 4 * 86400;
    await C.putRun("treasury", "D2026-11-13", { state: "missed", boundary: FRI, via: "site", error: "paused by old - not run (D-18)", result: { missed: "paused", paused_by: "old" } });
    ran = await SCH.pass(FRI + 60, both);
    assert.ok(ran.includes("treasury D2026-11-13"), JSON.stringify(ran));
    const h = (await C.run("treasury", "D2026-11-13")).result.late;
    assert.deepEqual([h.why, h.healed], ["paused", true]);
    // (f) a pause that began AFTER the boundary (on the scheduler's clock - paused_at is on it too, so a staging rehearsal on the
    // test clock releases what prod would) and no pass recorded anything: the resume releases nothing; it runs on time
    const SAT = B + 5 * 86400;
    await atClock(SAT + 300, () => SCH.setPause(["treasury"], true, Object.assign({ note: "after the boundary" }, by)));
    assert.equal(Math.round((await C.engines()).treasury.paused_at / 1000), SAT + 300, "paused_at on the scheduler's clock");
    assert.deepEqual((await atClock(SAT + 400, () => SCH.setPause(["treasury"], false, by)))[0].released, []);
    ran = await SCH.pass(SAT + 500, both);
    assert.ok(ran.includes("treasury D2026-11-14"), JSON.stringify(ran));
    assert.equal((await C.run("treasury", "D2026-11-14")).result.late, undefined);
    // (g) the same in-transaction re-read stops a run whose engine was handed back (a rollback committed after the pass read
    // it): nothing runs, nothing is recorded
    await runQuery("UPDATE policy_engines SET mode = 'shadow' WHERE engine = 'treasury'");
    try {
      const s0 = await supply();
      assert.deepEqual(await A.runTreasuryDaily("D2026-11-15", B + 6 * 86400 + 60), { ok: true, skipped: "not_live", mode: "shadow" });
      assert.equal(await C.run("treasury", "D2026-11-15"), null);
      assert.equal(await supply(), s0);
    } finally { await runQuery("UPDATE policy_engines SET mode = 'live' WHERE engine = 'treasury'"); }
  } finally { OA.alert = oAlert; }
});

test("PO-1 review (D-18): a multi-day outage records every period it skipped (a Monday's guarantee named), a failed run is missed at the rollover, and 'late' survives a failed retry and a lease takeover", async () => {
  const B = Date.UTC(2026, 10, 9, 4) / 1000;
  const both = { only: ["treasury", "monetary"] };
  // the scheduler last passed Saturday 11-14; it comes back Tuesday 11-17 06:05
  const TUE = B + 8 * 86400 + 2 * 3600 + 300;
  let ran = await SCH.pass(TUE, both);
  assert.ok(ran.includes("treasury W2026-11-16") && ran.includes("treasury D2026-11-17") && ran.includes("monetary D2026-11-17"), JSON.stringify(ran));
  for (const d of ["D2026-11-15", "D2026-11-16"]) {
    for (const e of ["treasury", "monetary"]) assert.equal((await C.run(e, d)).state, "missed", `${e} ${d}`);
  }
  assert.equal((await C.run("treasury", "D2026-11-14")).state, "done", "the day it ran stays done");
  const mon = await C.run("monetary", "D2026-11-16");
  assert.equal(mon.result.guarantee_unpaid, true);
  assert.match(mon.error, /Monday guarantee top-up rides on this day and was NOT paid/);
  assert.equal((await C.run("monetary", "D2026-11-15")).result.guarantee_unpaid, undefined, "a Sunday carries no guarantee");
  const al = (await effects("alert")).find((e) => e.key === "alert:missed:monetary:D2026-11-17");
  assert.ok(al && /2 period\(s\) missed/.test(al.data.title) && /guarantee top-up of D2026-11-16 was NOT paid/.test(al.data.text), JSON.stringify(al));
  assert.equal((await C.run("treasury", "W2026-11-16")).result.late.why, "site_down", "the current week's epoch runs late (D-18)");
  // a run that FAILED and was still being retried when its day ended: recorded missed at the rollover, never run late
  const WED = B + 9 * 86400 + 300;
  const oDaily = A.runTreasuryDaily;
  A.runTreasuryDaily = async () => { throw new Error("daily boom"); };
  try { await SCH.pass(WED, both); } finally { A.runTreasuryDaily = oDaily; }
  assert.equal((await C.run("treasury", "D2026-11-18")).state, "failed");
  await SCH.pass(WED + 86400, both);
  const fm = await C.run("treasury", "D2026-11-18");
  assert.deepEqual([fm.state, fm.result.missed], ["missed", "failed"]);
  assert.match(fm.error, /^failed \(daily boom\) and its period ended/);
  // LATE survives a failed run: the site comes back at 04:20:15 on Monday 11-23 (down across the boundary), the epoch fails,
  // its retry at 04:30 is still late (the scheduler FIRST SAW the period at 04:20:15 - not "its last pass was after the boundary")
  const MON2 = B + 14 * 86400;
  const oEpoch = A.runTreasuryEpoch;
  A.runTreasuryEpoch = async () => { throw new Error("epoch boom"); };
  try { await SCH.pass(MON2 + 20 * 60 + 15, both); } finally { A.runTreasuryEpoch = oEpoch; }
  assert.equal((await C.run("treasury", "W2026-11-23")).state, "failed");
  await runQuery("UPDATE policy_runs SET created = 0 WHERE key = 'treasury:W2026-11-23'");      // its retry is due
  ran = await SCH.pass(MON2 + 30 * 60, both);
  assert.ok(ran.includes("treasury W2026-11-23"), JSON.stringify(ran));
  const wl = (await C.run("treasury", "W2026-11-23")).result.late;
  assert.equal(wl.why, "site_down");
  assert.equal(wl.seen_at, MON2 + 20 * 60 + 15);
  // ...and a LEASE TAKEOVER is not late: the scheduler saw Tuesday's boundary at 04:00:10 (its daily failed), the process died,
  // a new one (nothing in memory) runs it at 04:20 - the site was up at the boundary
  const TUE2 = MON2 + 86400;
  A.runTreasuryDaily = async () => { throw new Error("daily boom"); };
  try { await SCH.pass(TUE2 + 10, both); } finally { A.runTreasuryDaily = oDaily; }
  SCH._resetPassClock();
  await runQuery("UPDATE policy_runs SET created = 0 WHERE key = 'treasury:D2026-11-24'");
  ran = await SCH.pass(TUE2 + 20 * 60, both);
  assert.ok(ran.includes("treasury D2026-11-24"), JSON.stringify(ran));
  assert.equal((await C.run("treasury", "D2026-11-24")).result.late, undefined, "the site was up at the boundary");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM policy_meta WHERE key LIKE 'seen:treasury:%'"))[0].n, 2, "only the current periods' marks are kept");
});

test("PO-1: every reader of Pepe's policy push goes through policy/source.js (T14) - today it answers the push", async () => {
  const S = require(path.join(repo, "policy", "source"));
  const snap = await S.read();
  assert.equal(snap.from, "push");
  assert.equal(snap.owner, "pepe");
  assert.deepEqual(snap.flags, CFG.flags);
  assert.equal(S.hourOf(snap.consts), 4);
  assert.equal((await SCH.clockInfo(MON_0405)).hour, 4);
  assert.deepEqual((await G.config()).cfg, CFG.econ_cfg, "the engines' config = Pepe's effective econ_cfg");
  assert.deepEqual((await S.burn()).cfg, CFG.burn_cfg);
  // the push changes -> every reader follows (one read source)
  const push = Object.assign({}, CFG, { consts: Object.assign({}, CFG.consts, { VAULT_EPOCH_UTC_HOUR: 5 }), flags: { layers: true, tr_live: false } });
  assert.equal((await post("/api/policy/bot/config", { cfg: push })).body.ok, true);
  try {
    assert.equal((await SCH.clockInfo(MON_0405)).hour, 5);
    assert.equal((await SCH.clockInfo(MON_0405)).flags.tr_live, false);
    assert.equal((await G.config()).consts.VAULT_EPOCH_UTC_HOUR, 5);
  } finally { assert.equal((await post("/api/policy/bot/config", { cfg: CFG })).body.ok, true); }
  // no other module opens the push: the site's JS outside policy/source.js (and policy/core.js, which stores it) never calls
  // policy/core's push reader nor reads policy_meta's "cfg" row (tools/policy-backend.js's read-only status aside). PO-1
  // review: the reader is named _pushForSource and core has no cfg() any more - a module that binds core under ANY name
  // (const PCX = require("../policy/core"); PCX.cfg()) fails at once, and one that calls the new name is found here
  assert.equal(C.cfg, undefined, "policy/core.cfg is gone (renamed _pushForSource)");
  assert.equal(typeof C._pushForSource, "function");
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", "test", "public", ".git", "locales", "views", "docs", "data"].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith(".js")) files.push(p);
    }
  };
  walk(repo);
  // review of the PO-3 follow-up: policy/config.js's phase4bView read the push with C.meta("cfg") - policy/core's generic meta
  // reader on the push's row - and the scan above (only _pushForSource / SQL text) missed it. So a meta("cfg") call is a second
  // reader too when its receiver is bound to policy/core (under any name, destructured, or chained on the require).
  // capital/core.js and gangs.js have meta("cfg") readers of their OWN stores - a receiver bound to another module is not one.
  const coreAbs = path.join(repo, "policy", "core.js");
  const isPolicyCore = (fromAbs, spec) => {
    if (!spec.startsWith(".")) return false;
    let p = path.resolve(path.dirname(fromAbs), spec);
    if (!p.endsWith(".js")) p += ".js";
    return p === coreAbs;
  };
  const CFG_ARG = String.raw`\s*\(\s*['"\x60]cfg['"\x60]\s*\)`;
  const esc = (s) => s.replace(/[$]/g, "\\$");
  const coreMetaCfg = (fromAbs, src) => {
    const hits = [];
    const reqRe = /(?:(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*)?require\(\s*['"]([^'"]+)['"]\s*\)(\s*\.\s*meta\s*\(\s*['"\x60]cfg['"\x60]\s*\))?/g;
    const names = new Set(), bare = new Set();
    let m;
    while ((m = reqRe.exec(src))) {
      if (!isPolicyCore(fromAbs, m[2])) continue;
      if (m[3]) hits.push(`require(${m[2]}).meta("cfg")`);
      const b = m[1];
      if (!b) continue;
      if (b.startsWith("{")) {
        for (const part of b.slice(1, -1).split(",")) {
          const [k, v] = part.split(":").map((x) => x.trim());
          if (k === "meta") bare.add(v || k);
        }
      } else names.add(b);
    }
    for (const n of names) if (new RegExp(String.raw`(^|[^\w$.])` + esc(n) + String.raw`\s*\.\s*meta` + CFG_ARG).test(src)) hits.push(`${n}.meta("cfg")`);
    for (const n of bare) if (new RegExp(String.raw`(^|[^\w$.])` + esc(n) + CFG_ARG).test(src)) hits.push(`${n}("cfg")`);
    return hits;
  };
  const bad = [];
  for (const f of files) {
    const rel = path.relative(repo, f).replace(/\\/g, "/");
    if (rel === "policy/source.js" || rel === "policy/core.js") continue;
    const src = fs.readFileSync(f, "utf8");
    if (/_pushForSource\b/.test(src)) bad.push(`${rel}: _pushForSource`);
    if (rel !== "tools/policy-backend.js" && /policy_meta[^\n]*['"]cfg['"]/.test(src)) bad.push(`${rel}: policy_meta cfg`);
    for (const h of coreMetaCfg(f, src)) bad.push(`${rel}: ${h}`);
  }
  assert.deepEqual(bad, []);
  // the scan finds a second reader under any binding (the review's mutation: capital/vaults reading the push itself)
  const probe = 'const PCX = require("../policy/core");\nasync function bonusCap() { return (await PCX._pushForSource()) || {}; }';
  assert.ok(/_pushForSource\b/.test(probe));
  // ... and policy/core's meta("cfg") under any binding (the review's finding: config.js's phase4bView), never another store's
  const inPolicy = path.join(repo, "policy", "x.js"), inCapital = path.join(repo, "capital", "x.js"), atRoot = path.join(repo, "x.js");
  assert.deepEqual(coreMetaCfg(inPolicy, 'const C = require("./core");\nasync function v() { return C.meta("cfg").catch(() => null); }'), ['C.meta("cfg")']);
  assert.deepEqual(coreMetaCfg(inPolicy, "const C = require('./core.js');\nconst p = await C . meta( 'cfg' );"), ['C.meta("cfg")']);
  assert.deepEqual(coreMetaCfg(inCapital, 'const { meta: pm, setMeta } = require("../policy/core");\nconst p = await pm("cfg");'), ['pm("cfg")']);
  assert.deepEqual(coreMetaCfg(atRoot, 'const { meta } = require("./policy/core");\nconst p = await meta("cfg");'), ['meta("cfg")']);
  assert.deepEqual(coreMetaCfg(atRoot, 'const p = await require("./policy/core").meta("cfg");'), ['require(./policy/core).meta("cfg")']);
  assert.deepEqual(coreMetaCfg(inPolicy, 'const C = require("./core");\nconst k = await require("../capital/core").meta("cfg");\nconst r = await C.meta("cfg_pepe_rev");'), []);
  assert.deepEqual(coreMetaCfg(inCapital, 'const C = require("./core");\nconst c = await C.meta("cfg");'), [], "capital/core's own store");
  assert.deepEqual(coreMetaCfg(atRoot, 'const { meta } = require("./gangs");\nconst c = await meta("cfg");'), []);
  // the finding's very code, at its own path, is caught
  assert.deepEqual(coreMetaCfg(path.join(repo, "policy", "config.js"), 'const C = require("./core");\nasync function phase4bView() {\n  const push = await C.meta("cfg").catch(() => null);\n}'), ['C.meta("cfg")']);
});

test("the test clock and the tagged rehearsal tick exist only on staging", async () => {
  const r = await fetch(base + "/api/policy/admin/tick", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "bot", at: MON_0405 }) });
  assert.equal(r.status, 404);
  await assert.rejects(C.setTestClock(MON_0405), /only on staging/);
});

test("review of the owner answers (A4 / A6 / A7): the write-time gate holds on EVERY run - the weekly epoch, the monetary day and a burn slot skip a paused or handed-back engine (nothing moves)", async () => {
  const rows = await getQuery("SELECT * FROM policy_engines WHERE engine IN ('treasury', 'monetary', 'burn')");
  const B = Date.UTC(2026, 11, 7, 4) / 1000;                     // Monday 2026-12-07 04:00 UTC
  await P.move({ key: "test-feed-burn-gate", legs: [["reserve", -777], ["burn", 777]], why: "gate test" });
  const s0 = await supply();
  const burn0 = await P.balance("burn");
  assert.ok(burn0 >= 777);
  try {
    // paused after the scheduler read the engines (the pause committed while the run waited for the write gate)
    await runQuery("UPDATE policy_engines SET mode = 'live', paused = 1, paused_by = 'boss', paused_at = ?, pause_note = 'gate test' WHERE engine IN ('treasury', 'monetary', 'burn')",
                   [(B - 3600) * 1000]);
    assert.deepEqual(await A.runTreasuryEpoch("W2026-12-07", B + 60), { ok: true, skipped: "paused" });
    const w = await C.run("treasury", "W2026-12-07");
    assert.deepEqual([w.state, w.result.missed], ["missed", "paused"], "the week is recorded missed (paused)");
    assert.deepEqual(await A.runMonetary("D2026-12-07", B + 60, false), { ok: true, skipped: "paused" });
    const m = await C.run("monetary", "D2026-12-07");
    assert.deepEqual([m.state, m.result.missed], ["missed", "paused"]);
    const b = await A.runBurn("A-gate-test-1", B + 60);
    assert.deepEqual([b.ok, b.skipped, b.amount, b.id], [true, "paused", 0, null]);
    assert.equal(await C.run("burn", "A-gate-test-1"), null, "a burn slot records nothing");
    assert.equal(await P.balance("burn"), burn0, "nothing burned");
    assert.equal(await supply(), s0, "nothing moved");
    // handed back (no longer live) after the read: nothing runs, nothing is recorded
    await runQuery("UPDATE policy_engines SET paused = 0, mode = 'shadow' WHERE engine IN ('treasury', 'monetary', 'burn')");
    assert.equal((await A.runTreasuryEpoch("W2026-12-14", B + 7 * 86400 + 60)).skipped, "not_live");
    assert.equal((await A.runMonetary("D2026-12-08", B + 86400 + 60, false)).skipped, "not_live");
    assert.equal((await A.runBurn("A-gate-test-2", B + 60)).skipped, "not_live");
    assert.equal(await C.run("treasury", "W2026-12-14"), null);
    assert.equal(await C.run("monetary", "D2026-12-08"), null);
    assert.equal(await P.balance("burn"), burn0);
    assert.equal(await supply(), s0);
  } finally {
    for (const r of rows) {
      await runQuery("UPDATE policy_engines SET mode = ?, paused = ?, paused_by = ?, paused_at = ?, pause_note = ? WHERE engine = ?",
                     [r.mode, r.paused, r.paused_by, r.paused_at, r.pause_note, r.engine]);
    }
  }
});

test("review of the owner answers (SC40): the MONETARY day left 'missed paused' while its engine runs heals too - it runs, late (healed)", async () => {
  const WED3 = Date.UTC(2026, 10, 25, 4) / 1000;                 // the day after the previous tests' last pass
  const both = { only: ["treasury", "monetary"] };
  assert.equal((await C.engines()).monetary.mode, "live");
  await C.putRun("monetary", "D2026-11-25", { state: "missed", boundary: WED3, via: "site", error: "paused by old - not run (D-18)",
                                             result: { missed: "paused", paused_by: "old" } });
  const ran = await SCH.pass(WED3 + 60, both);
  assert.ok(ran.includes("monetary D2026-11-25"), JSON.stringify(ran));
  const r = await C.run("monetary", "D2026-11-25");
  assert.equal(r.state, "done");
  assert.deepEqual([r.result.late.why, r.result.late.healed], ["paused", true]);
});

test("review of the owner answers (SC8): the paused pass re-reads the run INSIDE its transaction - a period that settled since its first read is never overwritten 'missed'", async () => {
  const THU3 = Date.UTC(2026, 10, 26, 4) / 1000;
  const both = { only: ["treasury", "monetary"] };
  const by = { by: "boss", auditId: "ua", via: "admin" };
  C._setClock(() => (THU3 - 600) * 1000);
  try { await SCH.setPause(["treasury"], true, Object.assign({ note: "sc8" }, by)); } finally { C._setClock(null); }
  // the day ran (done) after the paused pass's first read of it - the read-before-the-transaction still says "nothing yet"
  await C.putRun("treasury", "D2026-11-26", { state: "done", boundary: THU3, via: "site", result: { ok: true } });
  const oRun = C.run;
  let stale = true;
  C.run = async (...a) => {
    if (stale && a[0] === "treasury" && a[1] === "D2026-11-26") { stale = false; return null; }
    return oRun(...a);
  };
  try { await SCH.pass(THU3 + 60, both); } finally { C.run = oRun; }
  assert.equal(stale, false, "the stale first read happened");
  assert.equal((await C.run("treasury", "D2026-11-26")).state, "done", "the done run stands - never recorded missed (paused)");
  C._setClock(() => (THU3 + 120) * 1000);
  try { await SCH.setPause(["treasury"], false, by); } finally { C._setClock(null); }
});
