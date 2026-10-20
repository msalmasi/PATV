// PO-1 (economy policy -> site plan, T9): the boundary handshake. Whichever side snapshots second sees the other's legs - Pepe
// reported his inputs BEFORE his legs moved, but the site gathered its own view when the report arrived (after them), so the
// "total diff" of a period Pepe ran could never be trusted. Now Pepe asks the site for its snapshot first
// (POST /api/policy/bot/boundary): inputs + plan in ONE dbUtils.tx, stored once in policy_sims (site_boundary_*, boundary_ts),
// never overwritten - and the report compares against it. A period is clean only with an empty engine diff, a boundary
// snapshot and no total diff outside the tested whitelist (D-15).
//   NODE_PATH=G:/PATV/node_modules node --test test/policy-boundary.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "policy-boundary-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const DB = require(path.join(repo, "dbUtils"));
const { runQuery, getQuery, tx } = DB;
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
const MON = Date.UTC(2026, 9, 19, 4, 5) / 1000;          // Monday 2026-10-19 04:05 UTC
const EID = "W2026-10-19", DID = "D2026-10-19";
const POOLS = { reserve: 40 * M, bank: 3 * M, mm: 1 * M, fortknox: 16 * M, heist: 1 * M, incentives: 4 * M, vaultfloat: 0 };
const HOUSE = 20 * M;
const CFG = {
  econ_cfg: Object.assign({}, E.DEFAULTS, { fed_floor: 25 * M, fed_ceiling: 150 * M, incentive_guarantee_target: 25 * M }),
  consts: E.CONSTS, flags: { layers: true, tr_live: true, ap_on: false }, tz: "America/New_York", skip: [],
  journal: [{ eid: "W2026-10-12", boundary: Date.UTC(2026, 9, 12, 4) / 1000, state: "done", incentives_after: 3 * M }], days_done: [],
  burn_cfg: { mode: "accrual", accrual_every_min: 5 }, burn_inflight: 0,
};
let base, server;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot" }, body)) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const row = async (key) => (await getQuery("SELECT * FROM policy_sims WHERE key = ?", [key]))[0] || null;

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT, casino_banned INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE bonus_winners (bonusId TEXT PRIMARY KEY, type TEXT, userId TEXT, transactionId TEXT, amount INTEGER)");
  await runQuery("CREATE TABLE supply_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), pools TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  for (const [id, name, cf] of [["u1", "ann", "ann_cf"], ["u2", "bob", "bob_cf"]]) {
    await runQuery("INSERT INTO users (userId, username, password, points_balance, camfrogUsername) VALUES (?, ?, 'x', 0, ?)", [id, name, cf]);
  }
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES ('seed', 's', NULL, ?)", [HOUSE]);
  await runQuery("INSERT INTO supply_snapshot (id, pools) VALUES (1, '[]')");
  await P.init();
  await require(path.join(repo, "funding")).init();
  await P._setMeta("enabled", true);
  const payload = JSON.stringify({ v: 1, source: "pepe", pools: POOLS, docs: {}, routes: {}, econ_cfg: {}, econ_cfg_log: [], catalog: {} });
  const keys = Object.keys(POOLS);
  assert.equal((await P.importFromPepe({ key: "pc-boundary-test", payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"),
                                         totals: { sum: Object.values(POOLS).reduce((t, v) => t + v, 0), count: keys.length, per_pool: POOLS } })).ok, true);
  await P._setMeta("imported", Object.assign((await P.exportState()).imported, { at: 0 }));
  await S.init();
  await runQuery("INSERT INTO stash_meta (key, value) VALUES ('enabled', 'true')");
  const sp = JSON.stringify([{ id: "1", owner: "ann_cf", name: "nest", balance: 1000, staked: 0, earned: 0, members: [] },
                             { id: "2", owner: "bob_cf", name: "pot", balance: 0, staked: 0, earned: 0, members: [] }]);
  assert.equal((await S.importFromPepe({ payload: sp, digest: crypto.createHash("sha256").update(sp, "utf8").digest("hex"), total: 1000, count: 2, seq: 2 })).ok, true);
  await CC.init();
  await CC.putDoc("vaults", {
    v: { house: { total: 10 * M, holders: { protocol: 9.5 * M, s1: 400000.0, s2: 100000.0 }, basis: 8 * M },
         bank: { total: 3 * M, holders: { protocol: 3 * M }, basis: 3 * M }, mm: { total: 1 * M, holders: { protocol: 1 * M }, basis: 1 * M } },
    auto: { total: 0.0, holders: {} }, queue: {}, epochs: [], seq: 0, inited: 1, insured: [] });
  await CC.setMeta("live", true);
  CC.forgetLive();
  await ES.putDocs({ econ_layers: { rev: 1, doc: { fed_mints: {}, fed_loans: {}, fed_loan_repaid: {} } },
                     econ_treasury: { rev: 1, doc: { week: { id: "W2026-10-12", budgets: {}, spent: {} }, bank_lent: [], days: {} } } });
  require(path.join(repo, "econ"));
  await runQuery(`CREATE TABLE IF NOT EXISTS econ_participation (room_id TEXT NOT NULL, day TEXT NOT NULL, login TEXT NOT NULL, lines INTEGER DEFAULT 0,
                  mic_min REAL DEFAULT 0, cmds INTEGER DEFAULT 0, active_min INTEGER DEFAULT 0, updated INTEGER, PRIMARY KEY (room_id, day, login))`);
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const deps = { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() };
  SCH.register(app, deps);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  assert.equal((await post("/api/policy/bot/config", { cfg: CFG })).body.ok, true);
  await C.setMode("treasury", "shadow", { by: "test", armedAt: MON - 7 * 86400 });
  await C.setMode("monetary", "shadow", { by: "test", armedAt: MON - 7 * 86400 });
});
test.after(() => server && server.close());

let pepeInputs, pepePlan;
test("the boundary snapshot is taken in ONE transaction before Pepe's legs; they don't change it; a re-report never overwrites it", async () => {
  // Pepe's view of the Monday boundary (the same state the site sees: his inputs builder reads the site's books)
  pepeInputs = await G.epoch(MON, EID);
  pepePlan = E.planEpoch(pepeInputs);
  assert.ok(pepePlan.legs.length >= 3 && pepePlan.release_per_day > 0, JSON.stringify(pepePlan.totals));
  // the handshake: the site's inputs + plan, inside a dbUtils transaction (the write gate holds every other write)
  const og = G.epoch;
  let inTx = null;
  G.epoch = async (...a) => { inTx = DB.inTx(); return og(...a); };
  let b;
  try { b = await post("/api/policy/bot/boundary", { engine: "treasury", period: EID, now: MON }); } finally { G.epoch = og; }
  assert.equal(b.body.ok, true, JSON.stringify(b.body));
  assert.equal(inTx, true, "gathered inside the transaction");
  const r0 = await row(`shadow:treasury:${EID}`);
  assert.ok(r0.boundary_ts > 0);
  assert.deepEqual(JSON.parse(r0.site_boundary_plan), pepePlan, "the same state: the same plan");
  // Pepe's legs land on the site (the house pays its surplus: the stakers' stashes, the Fed, the incentive budget)
  for (const l of pepePlan.legs) assert.notEqual(await tx(() => A.transfer(l.tid, l.src, l.dst, l.amt, l.why)), "none");
  // ...then his report: compared against the boundary snapshot - clean
  const rep = await post("/api/policy/bot/report", { engine: "treasury", period: EID, inputs: pepeInputs, plan: pepePlan });
  assert.equal(rep.body.ok, true);
  assert.equal(rep.body.basis, "boundary");
  assert.deepEqual(rep.body.engine_diff, []);
  assert.deepEqual(rep.body.total_diff, [], "his legs don't show: the snapshot was before them");
  assert.equal(rep.body.clean, true);
  assert.equal((await row(`shadow:treasury:${EID}`)).ok, 1);
  // the same report with NO boundary snapshot (a Pepe before PO-0c): the site's view now already has his legs - not clean
  const late = await post("/api/policy/bot/report", { engine: "treasury", period: `${EID}-x2`, inputs: pepeInputs, plan: pepePlan });
  assert.equal(late.body.basis, "report");
  assert.ok(late.body.total_diff.length > 0, "the T9 fragility: the second snapshot sees the first's legs");
  assert.equal(late.body.clean, false);
  // a re-report (a different plan) updates the comparison, never the boundary
  const bad = JSON.parse(JSON.stringify(pepePlan));
  bad.legs[0].amt += 1;
  const again = await post("/api/policy/bot/report", { engine: "treasury", period: EID, inputs: pepeInputs, plan: bad });
  assert.ok(again.body.engine_diff.length >= 1);
  assert.equal(again.body.clean, false);
  const r1 = await row(`shadow:treasury:${EID}`);
  assert.equal(r1.site_boundary_plan, r0.site_boundary_plan, "the boundary plan is never overwritten");
  assert.equal(r1.site_boundary_inputs, r0.site_boundary_inputs);
  assert.equal(r1.boundary_ts, r0.boundary_ts);
  assert.equal(r1.ok, 0);
  // and a second handshake for the same period keeps the first snapshot (the state has changed since)
  const dup = await post("/api/policy/bot/boundary", { engine: "treasury", period: EID, now: MON + 30 });
  assert.equal(dup.body.dup, true);
  assert.equal(dup.body.boundary_ts, r0.boundary_ts);
  assert.equal((await row(`shadow:treasury:${EID}`)).site_boundary_plan, r0.site_boundary_plan);
  // the clean report again (Pepe resends) is clean again
  assert.equal((await post("/api/policy/bot/report", { engine: "treasury", period: EID, inputs: pepeInputs, plan: pepePlan })).body.clean, true);
});

test("whitelist: the Monday daily's release is post-move - excused only on the epoch's day, in shadow; anything else blocks", async () => {
  // Pepe ran the epoch above: his week now has this week's share / release_per_day - but his econ_treasury doc push hasn't
  // landed on the site yet (it still shows last week's record)
  const R = pepePlan.release_per_day;
  const pepeWeek = { id: EID, budgets: {}, spent: {}, share: pepePlan.totals.incentives, release_per_day: R };
  const b = await post("/api/policy/bot/boundary", { engine: "treasury", period: DID, now: MON + 60 });
  assert.equal(b.body.ok, true);
  const dIn = Object.assign({}, await G.daily(MON + 60, DID), { week: pepeWeek });
  const dPlan = E.planDaily(dIn);
  assert.equal(dPlan.release, R);
  // a dry-mode comparison of the same Monday daily: the whitelist is shadow's only - the release blocks
  await C.setMode("treasury", "dry", { by: "test" });
  try {
    const dry = await post("/api/policy/bot/report", { engine: "treasury", period: DID, inputs: dIn, plan: dPlan });
    assert.deepEqual(dry.body.blocking, [`release: site null / pepe ${R}`], "dry: not excused");
    assert.equal(dry.body.input_blocking.length, 3, "nor the week record");
    assert.equal(dry.body.clean, false);
  } finally { await C.setMode("treasury", "shadow", { by: "test" }); }
  const rep = await post("/api/policy/bot/report", { engine: "treasury", period: DID, inputs: dIn, plan: dPlan });
  assert.deepEqual(rep.body.engine_diff, []);
  assert.deepEqual(rep.body.total_diff, [`release: site null / pepe ${R}`], "the only difference: the release his epoch set");
  assert.deepEqual(rep.body.whitelisted, rep.body.total_diff);
  assert.deepEqual(rep.body.blocking, []);
  // PO-1 review (D-15 counts the inputs): the week record itself differs too - the site still holds last week's (resolveWeek
  // discards it, nothing reads it), Pepe's epoch opened this one: post-move, excused under the same condition
  assert.deepEqual(rep.body.input_diff, [`week.id: site "W2026-10-12" / pepe "${EID}"`, `week.share: site null / pepe ${pepeWeek.share}`,
                                         `week.release_per_day: site null / pepe ${R}`]);
  assert.deepEqual(rep.body.input_whitelisted, rep.body.input_diff);
  assert.deepEqual(rep.body.input_blocking, []);
  assert.equal(rep.body.clean, true, "whitelisted (Monday, shadow)");
  assert.deepEqual(JSON.parse((await row(`shadow:treasury:${DID}`)).whitelisted), { plan: rep.body.total_diff, inputs: rep.body.input_diff, decision: [] });
  assert.deepEqual(JSON.parse((await row(`shadow:treasury:${DID}`)).blocking), { plan: [], inputs: [], decision: [] });
  // POST-MOVE, proven: once his doc push lands, the site's own plan has the same release and nothing differs
  await ES.putDocs({ econ_treasury: { rev: 2, doc: { week: pepeWeek, bank_lent: [], days: {} } } });
  const after = SCH.planOf("treasury", await G.daily(MON + 60, DID));
  assert.equal(after.release, R);
  assert.deepEqual(SCH.diff(after, dPlan), [], "with his record in, no difference at all");
  // on any other day the same field is a real difference: Tuesday's daily, Pepe's release off by one -> not clean
  const TUE = MON + 86400;
  assert.equal((await post("/api/policy/bot/boundary", { engine: "treasury", period: "D2026-10-20", now: TUE })).body.ok, true);
  const tIn = Object.assign({}, await G.daily(TUE, "D2026-10-20"), { week: Object.assign({}, pepeWeek, { release_per_day: R + 1 }) });
  const tRep = await post("/api/policy/bot/report", { engine: "treasury", period: "D2026-10-20", inputs: tIn, plan: E.planDaily(tIn) });
  assert.deepEqual(tRep.body.total_diff, [`release: site ${R} / pepe ${R + 1}`]);
  assert.deepEqual(tRep.body.whitelisted, []);
  assert.equal(tRep.body.clean, false, "not the epoch's day: it blocks");
  assert.deepEqual(tRep.body.input_blocking, [`week.release_per_day: site ${R} / pepe ${R + 1}`], "...and so does the input");
  // ...and on the Monday a LEG difference is never excused
  const ctx = { engine: "treasury", kind: "daily", mode: "shadow", monday: true, eid: EID, site: { week: { id: "W2026-10-12" } }, pepe: { week: pepeWeek } };
  const wl = SCH.applyWhitelist(["legs[0].amt: site 1 / pepe 2", "release: site null / pepe 5"], ctx);
  assert.deepEqual(wl, { excused: ["release: site null / pepe 5"], blocking: ["legs[0].amt: site 1 / pepe 2"] });
  assert.deepEqual(SCH.applyWhitelist(["release: site null / pepe 5"], Object.assign({}, ctx, { mode: "dry" })).excused, [], "shadow only");
  assert.deepEqual(SCH.applyWhitelist(["release: site null / pepe 5"], Object.assign({}, ctx, { kind: "epoch" })).excused, [], "the daily only");
  assert.deepEqual(SCH.applyWhitelist(["release: site null / pepe 5"], Object.assign({}, ctx, { monday: false })).excused, [], "the epoch's day only");
  // PO-1 review (tightened): only the post-move shape - the site still holding LAST week's record ("site null"); a site that
  // already has this week's record, or a different release on both sides, is a real difference
  assert.deepEqual(SCH.applyWhitelist(["release: site 4 / pepe 5"], ctx).excused, [], "site X / pepe Y blocks");
  assert.deepEqual(SCH.applyWhitelist(["release: site null / pepe 5"], Object.assign({}, ctx, { site: { week: { id: EID } } })).excused, [], "the site's week is current: blocks");
  assert.deepEqual(SCH.applyWhitelist(["week.id: x"], ctx, "inputs").excused, ["week.id: x"], "the stale week's inputs");
  assert.deepEqual(SCH.applyWhitelist(["week.id: x"], Object.assign({}, ctx, { pepe: { week: { id: "W2026-10-12" } } }), "inputs").excused, [], "not post-move");
  assert.deepEqual(SCH.applyWhitelist(["fed_loans[0].outstanding: site 1 / pepe 0"], ctx, "inputs").blocking.length, 1, "any other input blocks");
  // the whitelist's inventory: every entry names its proving test, and that test is in this file
  const src = fs.readFileSync(__filename, "utf8");
  for (const w of SCH.WHITELIST) {
    const m = /^test\/policy-boundary\.test\.js: (.+)$/.exec(w.test);
    assert.ok(m && src.includes(`test(${JSON.stringify(m[1])}`), `${w.on} ${w.engine} ${w.field}: ${w.test}`);
    assert.ok(w.when, `${w.on} ${w.engine} ${w.field}: has a condition`);
  }
  assert.deepEqual(SCH.WHITELIST.map((w) => `${w.on}:${w.engine}:${w.kind}:${w.field}`),
                   ["plan:treasury:daily:release", "inputs:treasury:daily:week.*", "inputs:monetary:monetary:week.*", "inputs:monetary:monetary:rows / days / skip",
                    "decision:monetary:monetary:guarantee"], "a new entry needs its own test (D-15)");
});

test("the Monday monetary day: the guarantee decision and the week record are post-move; a mismatched decision blocks", async () => {
  // the site's econ_treasury doc is back to LAST week's record (Pepe's push of the week his epoch opened hasn't landed), and
  // his journal push doesn't show this week's epoch yet: the site's own guarantee decision is "wait for the epoch"
  await ES.putDocs({ econ_treasury: { rev: 3, doc: { week: { id: "W2026-10-12", budgets: {}, spent: {} }, bank_lent: [], days: {} } } });
  const pepeWeek = { id: EID, budgets: {}, spent: {}, share: pepePlan.totals.incentives, release_per_day: pepePlan.release_per_day };
  const b = await post("/api/policy/bot/boundary", { engine: "monetary", period: DID, now: MON + 120, guarantee: true });
  assert.equal(b.body.ok, true);
  const r0 = await row(`shadow:monetary:${DID}`);
  assert.equal(JSON.parse(r0.site_boundary_inputs).guarantee, true, "the plan uses Pepe's flag (the plans compare on the same flag)");
  // PO-1 review: the site's OWN decision at the boundary is kept with the snapshot (and both flags)
  assert.deepEqual(JSON.parse(r0.boundary_meta).guarantee, { site: null, wait: "the epoch", gate: true, epoch: null, pepe: true });
  const mIn = Object.assign({}, await G.monetary(MON + 120, DID, true), { week: pepeWeek });       // Pepe's view: his new week
  const mPlan = SCH.planOf("monetary", mIn);
  const rep = await post("/api/policy/bot/report", { engine: "monetary", period: DID, inputs: mIn, plan: mPlan });
  assert.deepEqual(rep.body.engine_diff, []);
  assert.deepEqual(rep.body.total_diff, []);
  assert.deepEqual(rep.body.decision_diff, ["guarantee: site waits for the epoch / pepe true"]);
  assert.deepEqual(rep.body.decision_whitelisted, rep.body.decision_diff, "post-move: his epoch ran a moment earlier");
  assert.equal(rep.body.input_diff.length, 3);
  assert.deepEqual(rep.body.input_whitelisted, rep.body.input_diff, "the stale week record: post-move");
  assert.equal(rep.body.clean, true);
  // POST-MOVE, proven: once his journal push shows this week's epoch done, the site decides the same (and his week lands too)
  const cfg0 = await C._pushForSource();
  await C.putCfg(Object.assign({}, cfg0, { journal: cfg0.journal.concat([{ eid: EID, boundary: MON - 300, state: "done", incentives_after: 3 * M }]) }));
  try {
    const info = await SCH.clockInfo(MON + 120);
    const g = await SCH.monetaryGuarantee(MON + 120, info, info.src);
    assert.deepEqual([g.gate, g.guarantee, g.epoch], [true, true, "done"], "with his epoch's record in, the site pays the guarantee too");
  } finally { await C.putCfg(cfg0); }
  // the post-move excuse needs Pepe's TRUE: a site waiting for the epoch while Pepe ran WITHOUT the guarantee is a real difference
  const mctx = { engine: "monetary", kind: "monetary", mode: "shadow", monday: true, eid: EID };
  assert.deepEqual(SCH.applyWhitelist(["guarantee: site waits for the epoch / pepe false"], mctx, "decision").blocking.length, 1);
  assert.deepEqual(SCH.applyWhitelist(["guarantee: site waits for the epoch / pepe true"], Object.assign({}, mctx, { mode: "dry" }), "decision").excused, [], "shadow only");
  assert.deepEqual(SCH.decisionDiff({ guarantee: { site: false } }, { kind: "monetary", guarantee: true }), ["guarantee: site false / pepe true"]);
  assert.deepEqual(SCH.decisionDiff({ guarantee: { site: true } }, { kind: "monetary", guarantee: true }), []);
  assert.deepEqual(SCH.decisionDiff({}, { kind: "monetary", guarantee: false }), ["guarantee: site no decision recorded / pepe false"]);
  // a DECIDED mismatch blocks: Tuesday (not the epoch's day) - the site's gate is off, Pepe says he pays the guarantee
  const TUE = MON + 86400;
  assert.equal((await post("/api/policy/bot/boundary", { engine: "monetary", period: "D2026-10-20", now: TUE + 120, guarantee: true })).body.ok, true);
  const tIn = await G.monetary(TUE + 120, "D2026-10-20", true);
  const tRep = await post("/api/policy/bot/report", { engine: "monetary", period: "D2026-10-20", inputs: tIn, plan: SCH.planOf("monetary", tIn) });
  assert.deepEqual([tRep.body.engine_diff, tRep.body.total_diff], [[], []], "the plans agree (both on his flag)");
  assert.deepEqual(tRep.body.decision_blocking, ["guarantee: site false / pepe true"]);
  assert.equal(tRep.body.clean, false, "the site would not have paid it: not clean");
  assert.deepEqual(JSON.parse((await row("shadow:monetary:D2026-10-20")).blocking).decision, ["guarantee: site false / pepe true"]);
  // a report whose inputs don't fit the engine is refused (nothing recorded)
  const wrong = await post("/api/policy/bot/report", { engine: "monetary", period: "D2026-10-21", inputs: pepeInputs, plan: pepePlan });
  assert.equal(wrong.body.ok, false);
  assert.equal(await row("shadow:monetary:D2026-10-21"), null);
  await ES.putDocs({ econ_treasury: { rev: 4, doc: { week: pepeWeek, bank_lent: [], days: {} } } });
});

test("participation input diffs are tolerated only while no enabled rule reads them; any other input diff blocks", async () => {
  // Wednesday's monetary day (no guarantee): participation lags on the site (his counters have a row the E-0 sync hasn't sent)
  const WED = MON + 2 * 86400, did = "D2026-10-21";
  assert.equal((await post("/api/policy/bot/boundary", { engine: "monetary", period: did, now: WED + 120, guarantee: false })).body.ok, true);
  const site = await G.monetary(WED + 120, did, false);
  const pIn = Object.assign({}, site, { rows: site.rows.concat([[site.local_day, "zed_cf", 50, 0]]) });
  const pPlan = SCH.planOf("monetary", pIn);
  assert.equal(pPlan.activity.amount, 0, "no activity reward is paid (activity_rewards off)");
  const rep = await post("/api/policy/bot/report", { engine: "monetary", period: did, inputs: pIn, plan: pPlan });
  assert.deepEqual(rep.body.input_diff, ["rows: 0 items / pepe 1"]);
  assert.deepEqual(rep.body.input_whitelisted, rep.body.input_diff, "unread: tolerated");
  assert.equal(rep.body.clean, true);
  // the same difference once a rule reads the rows - activity rewards paid, or issuance scaled by activity - blocks
  const ctx = { engine: "monetary", kind: "monetary", mode: "shadow", monday: false, eid: "W2026-10-19", site, pepe: pIn, sitePlan: pPlan, pepePlan: pPlan };
  assert.deepEqual(SCH.applyWhitelist(["rows: 0 items / pepe 1"], ctx, "inputs").excused, ["rows: 0 items / pepe 1"]);
  const paying = Object.assign({}, pPlan, { activity: Object.assign({}, pPlan.activity, { amount: 5000 }) });
  assert.equal(SCH.applyWhitelist(["rows: 0 items / pepe 1"], Object.assign({}, ctx, { pepePlan: paying }), "inputs").blocking.length, 1, "activity rewards paid");
  const scaled = Object.assign({}, pIn, { cfg: Object.assign({}, pIn.cfg, { issuance_mode: "fixed", issuance_activity_scaling: true }) });
  assert.equal(SCH.applyWhitelist(["rows[0][2]: site 4 / pepe 5"], Object.assign({}, ctx, { pepe: scaled }), "inputs").blocking.length, 1, "issuance scaled by activity");
  assert.equal(SCH.applyWhitelist(["local_day: site \"a\" / pepe \"b\""], ctx, "inputs").blocking.length, 1, "the day itself is no participation row");
  // ANY other input difference blocks, even with identical plans (D-15) - the review's probe: an unread constant
  const odd = Object.assign({}, pepeInputs, { consts: Object.assign({}, pepeInputs.consts, { PROBE_UNREAD: 1 }) });
  const r2 = await post("/api/policy/bot/report", { engine: "treasury", period: EID, inputs: odd, plan: pepePlan });
  assert.deepEqual([r2.body.engine_diff, r2.body.total_diff], [[], []]);
  assert.deepEqual(r2.body.input_blocking, ["consts.PROBE_UNREAD: site undefined / pepe 1"]);
  assert.equal(r2.body.clean, false);
  assert.equal((await row(`shadow:treasury:${EID}`)).ok, 0);
  // a site-side gather failure blocks too (the review: it can't read as clean)
  assert.equal(SCH.applyWhitelist(["site gather failed: boom"], ctx, "inputs").blocking.length, 1);
  assert.equal((await post("/api/policy/bot/report", { engine: "treasury", period: EID, inputs: pepeInputs, plan: pepePlan })).body.clean, true, "his real report: clean again");
});

test("the handshake only while the site compares: off and live answer skipped (nothing stored); bad requests are refused", async () => {
  await C.setMode("burn", "off", { by: "test" });
  const off = await post("/api/policy/bot/boundary", { engine: "burn", period: "D2026-10-18", now: MON });
  assert.deepEqual(off.body, { ok: true, skipped: "off" });
  await runQuery("UPDATE policy_engines SET mode = 'live' WHERE engine = 'monetary'");
  const live = await post("/api/policy/bot/boundary", { engine: "monetary", period: "D2026-10-22", now: MON });
  assert.deepEqual(live.body, { ok: true, skipped: "live" }, "a live engine's own run is its boundary");
  await runQuery("UPDATE policy_engines SET mode = 'shadow' WHERE engine = 'monetary'");
  assert.equal(await row("shadow:monetary:D2026-10-22"), null);
  for (const bad of [{ engine: "nope", period: DID }, { engine: "treasury", period: "X2026" }, { engine: "monetary", period: EID }, { engine: "treasury", period: "bad period!" }]) {
    assert.equal((await post("/api/policy/bot/boundary", bad)).body.ok, false, JSON.stringify(bad));
  }
  const noTok = await fetch(base + "/api/policy/bot/boundary", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ engine: "treasury", period: DID }) });
  assert.equal(noTok.status, 403);
});
