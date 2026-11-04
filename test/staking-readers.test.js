// PO-4 (economy policy -> site plan, "Phase 6"): the staking readers on policy_runs (capital/vaults.js wfView + publicRecord) and the
// cutover's enrichment (policy/scheduler.js cutover). While the treasury engine is NOT live every reader answers from Pepe's capital
// push exactly as before; once it is live (H2a) they answer from the treasury's weekly rows of policy_runs - with NO capital push
// at all (capital_meta has no cfg row: the defaults + the site-owned settings).
//   * cutover: Pepe's waterfall in his push -> the handed treasury W rows carry result.public + done_s; no push -> today's result;
//     monetary / daily handed rows unchanged; the enrichment never fails the cutover
//   * live, no push: publish's staking_state.waterfall = a site-run record, an enriched handed one and a minimal handed one; a tagged
//     W...-r1 is dropped from the list but counted by lastSettled; lateMonday's settled = the run's done time; watch.weekly
//     cross-checks the site's own record (its notices present: no notice finding); trackCap = engines.trackOf; adminData's
//     waterfall = the last site record
//   * shadow, with a push: wfView hands back the very same object - every reader reads what it read before
//   NODE_PATH=G:/PATV/node_modules node --test test/staking-readers.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "staking-readers-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery, tx } = require(path.join(repo, "dbUtils"));
const P = require(path.join(repo, "pools"));
const ES = require(path.join(repo, "econstore"));
const ST = require(path.join(repo, "stashes"));
const CC = require(path.join(repo, "capital", "core"));
const CS = require(path.join(repo, "capital", "service"));
const V = require(path.join(repo, "capital", "vaults"));
const W = require(path.join(repo, "capital", "watch"));
const C = require(path.join(repo, "policy", "core"));
const E = require(path.join(repo, "policy", "engines"));
const PC = require(path.join(repo, "policy", "config"));
const SCH = require(path.join(repo, "policy", "scheduler"));
const FX = require("./fixtures/policycfg");
const OPS = require(path.join(repo, "opsalerts"));
const inbox = require(path.join(repo, "inbox"));

OPS.alert = async () => ({ admins: 0 });
const M = 1000000;
const POOLS = { reserve: 40 * M, bank: 3 * M, mm: 1 * M, fortknox: 16 * M, heist: 1 * M, incentives: 4 * M, vaultfloat: 0 };
const NOW = Date.now() / 1000;
const HOUR = 4;
const B = E.weekStart(NOW, HOUR);                       // this week's boundary (the real clock: capital/watch reads it)
const EID = E.epochId(NOW, HOUR);
const wk = (n) => ({ eid: E.epochId(B - n * 7 * 86400, HOUR), b: B - n * 7 * 86400 });
let base, server;
const bot = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot" }, body)) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

/** A settled site-run week: its plan (per-vault totals + the stakers' legs to stashes 1 and 2), stash moves for the legs, notices. */
function sitePlan(eid, b) {
  const legs = [{ tid: `wf-${eid}-house-stk-1`, src: "jackpot", dst: "stash:1", amt: 4000, why: "waterfall stakers", vault: "house" },
                { tid: `wf-${eid}-house-stk-2`, src: "jackpot", dst: "stash:2", amt: 1000, why: "waterfall stakers", vault: "house" },
                { tid: `wf-${eid}-house-fed`, src: "jackpot", dst: "reserve", amt: 10000, why: "waterfall fed", vault: "house" },
                { tid: `wf-${eid}-house-inc`, src: "jackpot", dst: "incentives", amt: 10000, why: "waterfall incentives", vault: "house" }];
  const house = { nav: 20 * M, target: 15 * M, price: 2.0, protocol_value: 19 * M, basis: 8 * M, earnings: 11 * M, free_cash: 15 * M, surplus: 25000,
                  fed_loan_repaid: 0, stakers_share: 5000, staked: 500000, apr_cap: 5000, stakers: 5000, stakers_n: 2, fed: 10000, incentives: 10000, phase: "split" };
  return { epoch: eid, boundary: b, ts: b + 30, days: 7.0, fed_before: 40 * M, fed_target: 150 * M, fed_cap: 150 * M, staker_share: 0.2, fed_split: 0.5,
           vaults: { house }, legs, totals: { surplus: 25000, stakers: 5000, fed: 10000, incentives: 10000, fed_loan_repaid: 0 }, fed_after: 40 * M + 10000, release_per_day: 1428 };
}
const siteInputs = { cfg: { wf_staker_cap_pct: 0 }, consts: E.CONSTS, vaults: {}, journal: [] };
async function landSite(eid, plan) {
  for (const l of plan.legs) {
    if (l.why !== "waterfall stakers") continue;
    await runQuery("INSERT OR IGNORE INTO stash_moves (key, stash_id, kind, amount, via, ts) VALUES (?, ?, 'vault', ?, 'waterfall stakers', ?)", [`${l.tid}:in`, l.dst.slice(6), l.amt, Date.now()]);
    const s = await ST.get(l.dst.slice(6));
    await inbox.add(s.owner_id, { kind: "staking", title: "Staking payout", body: "x", ref: `wf:${eid}:s${l.dst.slice(6)}` });
  }
}

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
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES ('seed', 's', NULL, ?)", [20 * M]);
  await runQuery("INSERT INTO supply_snapshot (id, pools) VALUES (1, '[]')");
  await P.init();
  await require(path.join(repo, "funding")).init();
  await P._setMeta("enabled", true);
  const payload = JSON.stringify({ v: 1, source: "pepe", pools: POOLS, docs: {}, routes: {}, econ_cfg: {}, econ_cfg_log: [], catalog: {} });
  assert.equal((await P.importFromPepe({ key: "pc-readers-test", payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"),
                                         totals: { sum: Object.values(POOLS).reduce((t, v) => t + v, 0), count: Object.keys(POOLS).length, per_pool: POOLS } })).ok, true);
  await P._setMeta("imported", Object.assign((await P.exportState()).imported, { at: 0 }));
  await ST.init();
  await runQuery("INSERT INTO stash_meta (key, value) VALUES ('enabled', 'true')");
  const sp = JSON.stringify([{ id: "1", owner: "ann_cf", name: "nest", balance: 1000, staked: 0, earned: 0, members: [] },
                             { id: "2", owner: "bob_cf", name: "pot", balance: 0, staked: 0, earned: 0, members: [] }]);
  assert.equal((await ST.importFromPepe({ payload: sp, digest: crypto.createHash("sha256").update(sp, "utf8").digest("hex"), total: 1000, count: 2, seq: 2 })).ok, true);
  await CC.init();
  await CC.putDoc("vaults", {
    v: { house: { total: 10 * M, holders: { protocol: 9.5 * M, s1: 400000.0, s2: 100000.0 }, basis: 8 * M },
         bank: { total: 3 * M, holders: { protocol: 3 * M }, basis: 3 * M }, mm: { total: 1 * M, holders: { protocol: 1 * M }, basis: 1 * M } },
    auto: { total: 0.0, holders: {} }, queue: {}, epochs: [{ ts: B + 10, price: { bank: 1, house: 2, mm: 1, auto: 1 }, nav: { bank: 3 * M, house: 20 * M, mm: M }, staked: {} }],
    seq: 0, inited: 1, insured: [], next_epoch: B + 86400 + 60 });
  await CC.setMeta("live", true);
  CC.forgetLive();
  await ES.putDocs({ econ_layers: { rev: 1, doc: { fed_mints: {}, fed_loans: {}, fed_loan_repaid: {} } },
                     econ_treasury: { rev: 1, doc: { week: { id: EID, budgets: {}, spent: {} }, bank_lent: [], days: {} } } });
  require(path.join(repo, "econ"));
  await require(path.join(repo, "staking")).ready;
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const deps = { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() };
  ES.register(app, deps);
  SCH.register(app, deps);
  PC.register(app, deps);
  CS.register(app, deps);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  assert.equal((await bot("/api/policy/bot/config", { cfg: FX.policyPush({ journal: [] }) })).body.ok, true);
  assert.equal((await bot("/api/capital/bot/config", { cfg: FX.capitalPush() })).body.ok, true);
  assert.equal((await bot("/api/econ/settings/put", { pat_routes: FX.routes(), catalog: FX.catalog(), econ_cfg: {}, econ_cfg_log: [] })).body.ok, true);
  await tx(async () => { await PC.putOwner("cfg", "site", { by: "test", handoverKey: "t".repeat(64) }); });
  await PC.refresh();
  for (const e of ["treasury", "monetary"]) await C.setMode(e, "shadow", { by: "test", armedAt: B - 60 * 86400 });
});
test.after(() => server && server.close());

test("shadow, with a push: wfView hands back the very object - every reader reads Pepe's push as before", async () => {
  const pushWf = [{ epoch: wk(1).eid, boundary: wk(1).b, state: "done", done: wk(1).b + 40, days: 7, vaults: { house: { surplus: 1, stakers: 1, stakers_share: 1 } } }];
  assert.equal((await bot("/api/capital/bot/config", { cfg: FX.capitalPush({ waterfall: pushWf }) })).body.ok, true);
  const c = await CC.cfg();
  assert.equal(await V.wfView(c), c, "the same object (today's path, byte for byte)");
  assert.deepEqual(V.waterfallFrom(await V.wfView(c)).map((r) => r.epoch), [wk(1).eid]);
  // publish: the staking_state it writes equals the one built from the push directly
  await V.publish();
  const a = JSON.parse((await getQuery("SELECT data FROM staking_state WHERE id = 1"))[0].data);
  const orig = V.wfView;
  V.wfView = async (x) => x;
  try { await V.publish(); } finally { V.wfView = orig; }
  const b = JSON.parse((await getQuery("SELECT data FROM staking_state WHERE id = 1"))[0].data);
  delete a.updated; delete b.updated;
  assert.deepEqual(a.waterfall, b.waterfall);
  assert.deepEqual(a.waterfall.map((r) => r.epoch), [wk(1).eid]);
});

test("cutover: Pepe's waterfall in his push -> the handed W rows carry result.public + done_s; no push -> today's result; monetary unchanged", async () => {
  // (1) no record for the week in his push: today's result
  await CC.setMeta("cfg", Object.assign((await CC.meta("cfg")) || {}, { waterfall: [], wf_settled: [] }));
  const h1 = { treasury: { armed_at: B - 3600, done: [{ period: wk(4).eid, boundary: wk(4).b, incentives_after: 123 }] },
               monetary: { armed_at: B - 3600, done: [{ period: "D2026-10-01" }] } };
  const c1 = await SCH.cutover({ key: "po4-cut-1", engines: ["treasury", "monetary"], handover: h1, actor: "test" });
  assert.equal(c1.ok, true, JSON.stringify(c1));
  assert.deepEqual((await C.run("treasury", wk(4).eid)).result, { incentives_after: 123, boundary: wk(4).b });
  assert.deepEqual((await C.run("monetary", "D2026-10-01")).result, { incentives_after: null, boundary: null }, "monetary: unchanged");
  assert.equal((await SCH.rollback({ key: "po4-roll-1", engines: ["treasury", "monetary"], actor: "test" })).ok, true);
  // (2) his push carries the weeks: the handed rows keep his per-vault record and the settled time; a daily row is unchanged
  const pub = (e, b, done) => ({ epoch: e, boundary: b, ts: b + 30, days: 7.0, state: "done", done, staker_share: 0.2, staker_cap_pct: 0.0, ref_cap_pct: 25.0,
                                 vaults: { house: { surplus: 30000, stakers_share: 6000, apr_cap: 6000, staked: 400000, stakers: 5990, stakers_n: 2, fed: 12000, incentives: 12010,
                                                    fed_loan_repaid: 0, would_cap25: 1917, weighting: "pat_days", cap_pct: 0.0, fallback: false } },
                                 totals: { surplus: 30000, stakers: 5990, fed: 12000, incentives: 12010, fed_loan_repaid: 0 } });
  const wf = [pub(wk(3).eid, wk(3).b, wk(3).b + 41), pub(wk(2).eid, wk(2).b, wk(2).b + 42)];
  assert.equal((await bot("/api/capital/bot/config", { cfg: FX.capitalPush({ waterfall: wf }) })).body.ok, true);
  const h2 = { treasury: { armed_at: B - 3600, done: [{ period: wk(3).eid, boundary: wk(3).b, incentives_after: 1 }, { period: wk(2).eid, boundary: wk(2).b, incentives_after: 2 },
                                                      { period: "D2026-10-20", boundary: 1 }] } };
  const c2 = await SCH.cutover({ key: "po4-cut-2", engines: ["treasury"], handover: h2, actor: "test" });
  assert.equal(c2.ok, true, JSON.stringify(c2));
  const r3 = (await C.run("treasury", wk(3).eid)).result;
  assert.equal(r3.incentives_after, 1);
  assert.equal(r3.done_s, wk(3).b + 41);
  assert.deepEqual(r3.public, V.waterfallFrom({ waterfall: wf })[0], "the push's row, as waterfallFrom cleaned it");
  assert.equal((await C.run("treasury", wk(2).eid)).result.done_s, wk(2).b + 42);
  assert.deepEqual((await C.run("treasury", "D2026-10-20")).result, { incentives_after: null, boundary: 1 }, "a daily row: unchanged");
  // (3) a broken push never fails the cutover
  assert.equal((await SCH.rollback({ key: "po4-roll-2", engines: ["treasury"], actor: "test" })).ok, true);
  await CC.setMeta("cfg", { waterfall: "not a list", wf_settled: { x: 1 } });
  const c3 = await SCH.cutover({ key: "po4-cut-3", engines: ["treasury"], handover: { treasury: { armed_at: B - 3600, done: [{ period: wk(5).eid, boundary: wk(5).b }] } }, actor: "test" });
  assert.equal(c3.ok, true, JSON.stringify(c3));
  assert.deepEqual((await C.run("treasury", wk(5).eid)).result, { incentives_after: null, boundary: wk(5).b });
});

test("live, NO capital push: publish / lastSettled / lateMonday / weekly / trackCap / adminData read the site's policy_runs", async () => {
  await runQuery("DELETE FROM capital_meta WHERE key = 'cfg'");
  assert.equal(await CC.meta("cfg"), null, "no capital push at all");
  assert.equal((await C.engines()).treasury.mode, "live");
  // this week: a site-run record; a tagged rehearsal run (dropped from the list, counted by lastSettled); last week: minimal handed
  const plan = sitePlan(EID, B);
  await C.putRun("treasury", EID, { state: "done", boundary: B, via: "site", inputs: siteInputs, plan, result: { done_legs: plan.legs.map((l) => l.tid), conserved: true } });
  const doneS = Number((await getQuery("SELECT done FROM policy_runs WHERE key = ?", [`treasury:${EID}`]))[0].done) / 1000;
  await landSite(EID, plan);
  await C.putRun("treasury", `${EID}-r1`, { state: "done", boundary: B + 600, via: "site", inputs: siteInputs, plan: Object.assign(sitePlan(`${EID}-r1`, B + 600)) });
  await C.putRun("treasury", wk(1).eid, { state: "handed", via: "pepe", boundary: wk(1).b, result: { incentives_after: 5, boundary: wk(1).b } });
  const c = await CC.cfg();
  assert.equal(c.tr_live, true, "the site-owned settings");
  const cw = await V.wfView(c);
  assert.notEqual(cw, c);
  assert.equal(cw.wf_source, "policy_runs");
  const list = V.waterfallFrom(cw);
  assert.deepEqual(list.map((r) => r.epoch).slice(-5), [wk(5).eid, wk(4).eid, wk(3).eid, wk(2).eid, wk(1).eid, EID].slice(-5));
  const mine = list.find((r) => r.epoch === EID);
  const tr = E.trackOf(siteInputs, plan);
  assert.deepEqual(mine, V.waterfallFrom({ waterfall: [V.publicRecord(plan, tr, doneS)] })[0], "the site-run record in Pepe's push shape");
  assert.equal(mine.vaults.house.would_cap25, tr.vaults.house.would25);
  assert.equal(list.find((r) => r.epoch === wk(3).eid).vaults.house.stakers, 5990, "an enriched handed record keeps Pepe's per-vault totals");
  assert.deepEqual(list.find((r) => r.epoch === wk(1).eid), { epoch: wk(1).eid, boundary: wk(1).b, days: null, done: null, state: "done", staker_share: null,
                                                             staker_cap_pct: null, ref_cap_pct: null, vaults: {} }, "a minimal handed record");
  assert.ok(!list.some((r) => r.epoch === `${EID}-r1`), "the tagged run is dropped from the list...");
  assert.equal(V.lastSettled(cw, EID), B + 600, "...but lastSettled counts it");
  assert.equal(V.lastSettled(cw, `${EID}-r1`), B);
  // lateMonday: a cut-off 2 h after the boundary - the week was settled at the run's done time
  const lm = V.lateMonday(B - 86400 + 60, B + 7200, HOUR, cw);
  assert.equal(lm.boundary, B);
  assert.equal(lm.settled, doneS <= B + 7200 ? doneS : null);
  // publish: /staking's list from policy_runs
  await V.publish();
  const st = JSON.parse((await getQuery("SELECT data FROM staking_state WHERE id = 1"))[0].data);
  assert.ok(st.waterfall.some((r) => r.epoch === EID) && st.waterfall.some((r) => r.epoch === wk(1).eid) && st.waterfall.some((r) => r.epoch === wk(3).eid),
            JSON.stringify(st.waterfall.map((r) => r.epoch)));
  // trackCap: the rows are engines.trackOf's numbers
  const rows = await W.trackCap(cw);
  const t = rows.find((r) => r.eid === EID);
  assert.equal(t.vaults.house.would25, tr.vaults.house.would25);
  assert.equal(t.vaults.house.paid, tr.vaults.house.paid);
  // adminData: the last site record
  const ad = await W.adminData({ userId: "u1" });
  assert.equal(ad.waterfall.epoch, EID);
  // the weekly cross-check on the site's own record: its tids and notices (an hour after the boundary, real clock)
  if (Date.now() / 1000 >= B + 3600) {
    await runQuery("DELETE FROM capital_meta WHERE key LIKE 'wf_watch%'");
    const f = await W.weekly(c);
    assert.ok(Array.isArray(f), "the cross-check ran on the site record");
    assert.ok(!f.some((x) => x.vault === "notices"), JSON.stringify(f));
    assert.ok(!f.some((x) => x.code === "I6" && x.vault === "house"), "the stashes received what the record says");
  }
});
