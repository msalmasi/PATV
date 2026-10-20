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
  const rep = await post("/api/policy/bot/report", { engine: "treasury", period: DID, inputs: dIn, plan: dPlan });
  assert.deepEqual(rep.body.engine_diff, []);
  assert.deepEqual(rep.body.total_diff, [`release: site null / pepe ${R}`], "the only difference: the release his epoch set");
  assert.deepEqual(rep.body.whitelisted, rep.body.total_diff);
  assert.deepEqual(rep.body.blocking, []);
  assert.equal(rep.body.clean, true, "whitelisted (Monday, shadow)");
  assert.deepEqual(JSON.parse((await row(`shadow:treasury:${DID}`)).whitelisted), rep.body.total_diff);
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
  // ...and on the Monday a LEG difference is never excused
  const wl = SCH.applyWhitelist(["legs[0].amt: site 1 / pepe 2", "release: site null / pepe 5"], { engine: "treasury", kind: "daily", mode: "shadow", monday: true });
  assert.deepEqual(wl, { excused: ["release: site null / pepe 5"], blocking: ["legs[0].amt: site 1 / pepe 2"] });
  assert.deepEqual(SCH.applyWhitelist(["release: site null / pepe 5"], { engine: "treasury", kind: "daily", mode: "dry", monday: true }).excused, [], "shadow only");
  assert.deepEqual(SCH.applyWhitelist(["release: site null / pepe 5"], { engine: "treasury", kind: "epoch", mode: "shadow", monday: true }).excused, [], "the daily only");
  assert.equal(SCH.WHITELIST.length, 1, "today's whitelist is the Monday daily release only (plan §3 PO-1) - a new entry needs its own test");
});

test("the monetary day: the boundary carries Pepe's guarantee flag; a clean report", async () => {
  const mIn = await G.monetary(MON + 120, DID, true);
  const mPlan = SCH.planOf("monetary", mIn);
  const b = await post("/api/policy/bot/boundary", { engine: "monetary", period: DID, now: MON + 120, guarantee: true });
  assert.equal(b.body.ok, true);
  const snap = JSON.parse((await row(`shadow:monetary:${DID}`)).site_boundary_inputs);
  assert.equal(snap.guarantee, true);
  const rep = await post("/api/policy/bot/report", { engine: "monetary", period: DID, inputs: mIn, plan: mPlan });
  assert.deepEqual(rep.body.engine_diff, []);
  assert.deepEqual(rep.body.total_diff, []);
  assert.equal(rep.body.clean, true);
  // a report whose inputs don't fit the engine is refused (nothing recorded)
  const wrong = await post("/api/policy/bot/report", { engine: "monetary", period: "D2026-10-21", inputs: pepeInputs, plan: pepePlan });
  assert.equal(wrong.body.ok, false);
  assert.equal(await row("shadow:monetary:D2026-10-21"), null);
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
