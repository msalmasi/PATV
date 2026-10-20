// PO-1 (economy policy -> site plan, "Phase 6"): the site scheduler's Monday cut-off wait. On 2026-10-19 the site's shadow sim of
// the epoch was taken at 04:00:08 and the capital cut-off that closes the week's PAT-days bucket ran at 04:00:11 - the site
// planned the waterfall without the week's time weighting, Pepe (who waits for it: pepe_treasury._tr_cutoff_pending) with it.
// Now the scheduler's epoch waits up to TR_CUTOFF_WAIT (3600 s) past the boundary for the share book's newest cut-off to be at
// or after the boundary - in dry, shadow and live - and the Monday daily release waits with it (it runs after the epoch).
//   * cut-off at +3 s: the epoch waits, then plans with the boundary's PAT-days bucket (uncapped when the week is whole);
//   * a week whose PAT-days began mid-week: the bucket, paid under the 25% reference cap (partial);
//   * no cut-off at all, and none due on the site: the epoch waits the full hour, then runs on the snapshot (the reference cap);
//   * a live epoch waits the same way (nothing moves before the cut-off);
//   * PO-1 review: a site outage across Monday 04:00 - the hour is up when the site comes back, but its OWN cut-off is overdue
//     (the capital tick runs it at its next pass): the epoch keeps waiting for it, then pays the closed bucket, flagged late.
//   NODE_PATH=G:/PATV/node_modules node --test test/policy-scheduler-cutoff.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "policy-cutoff-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery, tx } = require(path.join(repo, "dbUtils"));
const P = require(path.join(repo, "pools"));
const ES = require(path.join(repo, "econstore"));
const S = require(path.join(repo, "stashes"));
const CC = require(path.join(repo, "capital", "core"));
const V = require(path.join(repo, "capital", "vaults"));
const C = require(path.join(repo, "policy", "core"));
const E = require(path.join(repo, "policy", "engines"));
const SCH = require(path.join(repo, "policy", "scheduler"));
// PO-1 review: past the hour the epoch keeps waiting only while the SITE's own capital cut-off is overdue - read on the CAPITAL
// clock (capital/core.nowS: capital/service.tick's own). Pinned per test so nothing here depends on the real date.
let capAt = null;
const capNow0 = CC.nowS;
CC.nowS = () => (capAt === null ? capNow0() : capAt);

const M = 1000000;
const DAY = 86400;
const B1 = Date.UTC(2026, 9, 26, 4) / 1000;           // Monday 2026-10-26 04:00 UTC
const B2 = B1 + 7 * DAY, B3 = B1 + 14 * DAY, B4 = B1 + 21 * DAY;
const wid = (b) => "W" + new Date(b * 1000).toISOString().slice(0, 10);
const did = (b) => "D" + new Date(b * 1000).toISOString().slice(0, 10);
const POOLS = { reserve: 40 * M, bank: 3 * M, mm: 1 * M, fortknox: 5 * M, heist: 2 * M, incentives: 4 * M, vaultfloat: 0 };
const HOUSE = 20 * M;
const CFG = {
  econ_cfg: Object.assign({}, E.DEFAULTS, { fed_floor: 25 * M, fed_ceiling: 150 * M, wf_staker_cap_pct: 0 }),   // D2: no weekly cap
  consts: E.CONSTS, flags: { layers: true, tr_live: true, ap_on: false }, tz: "America/New_York", skip: [], days_done: [],
  burn_cfg: { mode: "batch" }, burn_inflight: 0,
};
const sim = async (key) => {
  const r = (await getQuery("SELECT site_inputs, site_plan FROM policy_sims WHERE key = ?", [key]))[0];
  return r ? { inputs: JSON.parse(r.site_inputs), plan: JSON.parse(r.site_plan) } : null;
};
/** Pepe's push with his journal: the epoch before `b` settled (the week is 7 days). */
const pushFor = (b) => C.putCfg(Object.assign({}, CFG, { journal: [{ eid: wid(b - 7 * DAY), boundary: b - 7 * DAY, state: "done", incentives_after: 3 * M }] }));
/** The share book before the Monday cut-off of boundary b: the House (NAV 20M, price 2.0), stashes 1 and 2 with 250,000 shares
 *  (500,000 PAT) each; `lastCut` = the newest cut-off; `pd` = the House's PAT-days buckets so far. */
async function book(lastCut, pd) {
  const snap = { ts: lastCut, price: { house: 2.0, bank: 1.0, mm: 1.0, auto: 1.0 }, nav: { house: HOUSE, bank: 3 * M, mm: 1 * M },
                 staked: { house: 1 * M, bank: 0, mm: 0 }, staker_index: { house: 1.0, bank: 1.0, mm: 1.0 } };
  await CC.putDoc("vaults", {
    v: { house: { total: 10 * M, holders: { protocol: 9.5 * M, s1: 250000.0, s2: 250000.0 }, basis: 8 * M, pat_days: pd },
         bank: { total: 3 * M, holders: { protocol: 3 * M }, basis: 3 * M }, mm: { total: 1 * M, holders: { protocol: 1 * M }, basis: 1 * M } },
    auto: { total: 0.0, holders: {} }, queue: {}, epochs: [snap], seq: 0, inited: 1, insured: [], next_epoch: lastCut + DAY });
}
/** the site's capital cut-off (capital/vaults.epoch, as capital/service.tick runs it) at `at` */
const cutoff = (at) => tx(() => V.epoch({ nowS: at }));
const logs = [];
const LOG = console.log;

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
  assert.equal((await P.importFromPepe({ key: "pc-cutoff-test", payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"),
                                         totals: { sum: Object.values(POOLS).reduce((t, v) => t + v, 0), count: keys.length, per_pool: POOLS } })).ok, true);
  await P._setMeta("imported", Object.assign((await P.exportState()).imported, { at: 0 }));
  await S.init();
  await runQuery("INSERT INTO stash_meta (key, value) VALUES ('enabled', 'true')");
  const sp = JSON.stringify([{ id: "1", owner: "ann_cf", name: "nest", balance: 0, staked: 0, earned: 0, members: [] },
                             { id: "2", owner: "bob_cf", name: "pot", balance: 0, staked: 0, earned: 0, members: [] }]);
  assert.equal((await S.importFromPepe({ payload: sp, digest: crypto.createHash("sha256").update(sp, "utf8").digest("hex"), total: 0, count: 2, seq: 2 })).ok, true);
  await CC.init();
  await CC.setMeta("live", true);
  CC.forgetLive();
  await ES.putDocs({ econ_layers: { rev: 1, doc: { fed_mints: {}, fed_loans: {}, fed_loan_repaid: {} } },
                     econ_treasury: { rev: 1, doc: { week: { id: wid(B1 - 7 * DAY), budgets: {}, spent: {} }, bank_lent: [], days: {} } } });
  await C.init();
  await C.setMode("treasury", "dry", { by: "test", armedAt: B1 - 30 * DAY });
  console.log = (...a) => { logs.push(a.join(" ")); LOG(...a); };
});
test.after(() => { console.log = LOG; });

test("the epoch waits for the Monday cut-off (+3 s) and then plans with its PAT-days bucket: a whole week, uncapped (D2)", async () => {
  await pushFor(B1);
  // the week so far: an older bucket (the PAT-days ran the week before) and six days in this week's bucket (Tue..Sun cut-offs)
  await book(B1 - DAY, { [String(B1 - 7 * DAY)]: { 1: 3.5 * M, 2: 3.5 * M }, [String(B1)]: { 1: 3 * M, 2: 3 * M } });
  assert.equal(await SCH.cutoffPending(B1, B1 + 1), true, "the newest cut-off (Sunday's) is before the boundary");
  assert.deepEqual(await SCH.pass(B1 + 1), [], "the epoch waits - and the Monday daily with it");
  assert.equal(await sim(`dry:treasury:${wid(B1)}`), null);
  assert.equal(await sim(`dry:treasury:${did(B1)}`), null, "the daily runs after the epoch (as _tr_tick)");
  assert.deepEqual(await SCH.pass(B1 + 2), [], "still waiting");
  assert.equal(logs.filter((l) => l.includes(`treasury ${wid(B1)}: waiting for the Monday cut-off`)).length, 1, "the wait is logged once");
  // the site's cut-off at 04:00:03 closes the week's bucket (one more day: 7 x 500,000 per stash)
  await cutoff(B1 + 3);
  const d = await V.load();
  assert.equal(d.epochs[d.epochs.length - 1].ts, B1 + 3);
  assert.ok(Math.abs(d.v.house.pat_days[String(B1)]["1"] - 3.5 * M) < 1, JSON.stringify(d.v.house.pat_days));
  assert.equal(await SCH.cutoffPending(B1, B1 + 5), false);
  assert.deepEqual(await SCH.pass(B1 + 5), [`dry treasury ${wid(B1)}`, `dry treasury ${did(B1)}`]);
  const s = await sim(`dry:treasury:${wid(B1)}`);
  const pd = new Map(s.inputs.vaults.house.pat_days);
  assert.ok(pd.has(String(B1)), "the plan's inputs carry the boundary's bucket");
  const h = s.plan.vaults.house;
  assert.equal(h.surplus, 5 * M);
  assert.equal(h.stakers_share, 1 * M, "20% of the surplus");
  assert.equal(h.apr_cap, h.stakers_share, "a whole week with no cap: the stakers' full share (no reference cap)");
  assert.equal(h.stakers, 1 * M);
  assert.equal(E.weightingOf(s.inputs, s.plan).house, "pat_days", "the House week is wholly time-weighted");
});

test("a week whose PAT-days began mid-week: the bucket after the cut-off, paid under the 25% reference cap (partial)", async () => {
  await pushFor(B2);
  // the PAT-days began on Saturday: no bucket older than this week's
  await book(B2 - DAY, { [String(B2)]: { 1: 0.5 * M, 2: 0.5 * M } });
  assert.deepEqual(await SCH.pass(B2 + 1), []);
  await cutoff(B2 + 3);
  assert.deepEqual(await SCH.pass(B2 + 4), [`dry treasury ${wid(B2)}`, `dry treasury ${did(B2)}`]);
  const s = await sim(`dry:treasury:${wid(B2)}`);
  const h = s.plan.vaults.house;
  assert.deepEqual(E.weightingOf(s.inputs, s.plan).house, "partial");
  const staked = 2 * Math.trunc(2 * 500000 / 7);                 // 2 days of 500,000 each, averaged over the week
  assert.ok(Math.abs(h.staked - staked) <= 2, `${h.staked} vs ${staked}`);
  const ref = Math.trunc((1e6 / 7 + 1e6 / 7) * 0.25 * 7 / 365);
  assert.ok(Math.abs(h.apr_cap - ref) <= 1, `the reference cap (25% APR) on the PAT-days stake: ${h.apr_cap} vs ${ref}`);
  assert.ok(h.apr_cap < h.stakers_share, "capped below the stakers' share");
  assert.equal(E.trackOf(s.inputs, s.plan).vaults.house.fallback, true);
});

test("no cut-off at all, and none due on the site: the epoch waits the whole hour, then runs on the snapshot (the reference cap) - not later", async () => {
  await pushFor(B3);
  // the cut-offs stopped after Sunday a week ago: no bucket for this boundary - and the site's capital clock hasn't reached the
  // book's next cut-off (as on staging, whose test clock runs ahead of the real one): nothing of the site's own is overdue
  await book(B3 - 8 * DAY + 3, { [String(B3 - 7 * DAY)]: { 1: 3.5 * M, 2: 3.5 * M } });
  capAt = B3 - 8 * DAY + 60;
  try {
    assert.deepEqual(await SCH.pass(B3 + 1), []);
    assert.deepEqual(await SCH.pass(B3 + E.TR_CUTOFF_WAIT - 1), [], "59:59 past the boundary: still waiting");
    assert.equal(await SCH.cutoffWait(B3, B3 + E.TR_CUTOFF_WAIT), null, "the hour is up and no cut-off of the site's is due");
    assert.deepEqual(await SCH.pass(B3 + E.TR_CUTOFF_WAIT), [`dry treasury ${wid(B3)}`, `dry treasury ${did(B3)}`], "at the hour it runs");
  } finally { capAt = null; }
  const s = await sim(`dry:treasury:${wid(B3)}`);
  const h = s.plan.vaults.house;
  assert.equal(E.weightingOf(s.inputs, s.plan).house, "snapshot");
  assert.equal(h.staked, 1 * M, "the holdings now: 2 x 500,000");
  assert.equal(h.apr_cap, Math.trunc(1 * M * 0.25 * 7 / 365), "the 25% reference cap (D2's safeguard)");
});

test("a book with no cut-offs never waits (Pepe's rule); the wait is the scheduler's only (Pepe's boundary handshake doesn't wait)", () => {
  assert.equal(E.cutoffPending({ inited: 1, epochs: [] }, B1, B1 + 1), false);
  assert.equal(E.cutoffPending({ epochs: [{ ts: B1 - 3 }] }, B1, B1 + 1), false, "not launched");
  assert.equal(E.cutoffPending(null, B1, B1 + 1), false);
  assert.equal(E.cutoffPending({ inited: 1, epochs: [{ ts: B1 - 3 }] }, B1, B1 + 1), true);
  assert.equal(E.cutoffPending({ inited: 1, epochs: [{ ts: B1 }] }, B1, B1 + 1), false, "a cut-off AT the boundary closes it");
  assert.equal(E.cutoffPending({ inited: 1, epochs: [{ ts: B1 - 3 }] }, B1, B1 + 3600), false, "the hour is up");
});

test("LIVE: the epoch waits too - nothing moves before the cut-off; after it the waterfall runs with the bucket", async () => {
  await pushFor(B4);
  await book(B4 - DAY, { [String(B4 - 7 * DAY)]: { 1: 3.5 * M, 2: 3.5 * M }, [String(B4)]: { 1: 3 * M, 2: 3 * M } });
  await C.setMode("treasury", "live", { by: "test", via: "cutover", armedAt: B4 - DAY });
  const house0 = await CC.houseBalance();
  assert.deepEqual(await SCH.pass(B4 + 1), []);
  assert.equal(await C.run("treasury", wid(B4)), null, "no run record: it hasn't started");
  assert.equal(await C.run("treasury", did(B4)), null, "nor the daily");
  assert.equal(await CC.houseBalance(), house0, "nothing moved");
  await cutoff(B4 + 3);
  const ran = await SCH.pass(B4 + 6);
  assert.ok(ran.includes(`treasury ${wid(B4)}`) && ran.includes(`treasury ${did(B4)}`), JSON.stringify(ran));
  const r = await C.run("treasury", wid(B4));
  assert.equal(r.state, "done");
  assert.ok(new Map(r.inputs.vaults.house.pat_days).has(String(B4)), "the live run planned with the closed bucket");
  assert.equal(r.plan.vaults.house.apr_cap, r.plan.vaults.house.stakers_share, "uncapped (whole week)");
  assert.equal(r.result.late, undefined, "on time: not flagged late");
  assert.equal(house0 - (await CC.houseBalance()), r.plan.vaults.house.surplus);
});

test("PO-1 review: a site outage across Monday 04:00 (back at 06:00), LIVE - the epoch waits PAST the hour for the overdue cut-off, then pays the closed bucket, flagged late; the admins are told", async () => {
  const B5 = B1 + 28 * DAY;                                       // Monday 2026-11-23
  await pushFor(B5);
  // a partial week (the PAT-days began on Saturday); Sunday's cut-off ran, Monday's (next_epoch = B5) didn't: the site was down
  await book(B5 - DAY, { [String(B5)]: { 1: 0.5 * M, 2: 0.5 * M } });
  const refill = HOUSE - (await CC.houseBalance());                 // the House back to 20M (the LIVE test above paid its surplus)
  if (refill > 0) await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES ('refill-b5', 's', NULL, ?)", [refill]);
  await C.setMode("treasury", "live", { by: "test", via: "cutover", armedAt: B5 - DAY });
  SCH._resetPassClock();                                          // the process restarts with the site
  const OA = require(path.join(repo, "opsalerts"));
  const oAlert = OA.alert, alerts = [];
  OA.alert = async (a) => { alerts.push(a); return { admins: 0 }; };
  const back = B5 + 2 * 3600;
  capAt = back;
  try {
    const house0 = await CC.houseBalance();
    assert.equal(await SCH.cutoffWait(B5, back), "overdue", "the hour is up, but the site's own cut-off is due and hasn't run");
    // what the epoch would pay on the bucket as it stands (the review's probe: half of it)
    const early = E.planEpoch(await require(path.join(repo, "policy", "gather")).epoch(back, wid(B5)));
    assert.deepEqual(await SCH.pass(back), [], "it waits - past the hour");
    assert.equal(await C.run("treasury", wid(B5)), null, "nothing ran");
    assert.equal(await CC.houseBalance(), house0, "nothing moved");
    assert.equal(logs.filter((l) => l.includes(`treasury ${wid(B5)}: the site's capital cut-off is OVERDUE`)).length, 1, "logged once");
    assert.deepEqual(await SCH.pass(back + SCH.OVERDUE_ALERT_S - 15), []);
    assert.equal(alerts.length, 0, "no alert before OVERDUE_ALERT_S");
    assert.deepEqual(await SCH.pass(back + SCH.OVERDUE_ALERT_S), [], "still waiting (never on an open bucket)");
    assert.ok(alerts.some((a) => a.source === "policy" && a.title === `Policy engine treasury: ${wid(B5)} held - the capital cut-off is overdue`), JSON.stringify(alerts));
    const eff = (await getQuery("SELECT data FROM policy_effects WHERE key = ?", [`alert:cutoff:${wid(B5)}`]))[0];
    assert.ok(eff && /Nothing has moved/.test(JSON.parse(eff.data).text), "Pepe's notice too");
    await SCH.pass(back + SCH.OVERDUE_ALERT_S + 15);
    assert.equal(alerts.length, 1, "told once");
    // the capital tick comes round: the cut-off closes the week's bucket (Sunday -> Monday 06:15 accrued)
    await cutoff(back + 950);
    assert.equal(await SCH.cutoffWait(B5, back + 960), null);
    const ran = await SCH.pass(back + 960);
    assert.ok(ran.includes(`treasury ${wid(B5)}`) && ran.includes(`treasury ${did(B5)}`), JSON.stringify(ran));
    const r = await C.run("treasury", wid(B5));
    assert.equal(r.state, "done");
    const bucket = new Map(new Map(r.inputs.vaults.house.pat_days).get(String(B5)));
    assert.ok(bucket.get("1") > 0.5 * M, `the cut-off's Sunday-to-Monday day is in the bucket: ${bucket.get("1")}`);
    assert.equal(E.weightingOf(r.inputs, r.plan).house, "partial");
    const h = r.plan.vaults.house;
    assert.ok(h.stakers > early.vaults.house.stakers * 1.8, `the stakers get the whole bucket's pay: ${h.stakers} vs ${early.vaults.house.stakers} without the wait`);
    assert.equal(house0 - (await CC.houseBalance()), h.surplus);
    assert.equal(r.result.late.why, "site_down", "flagged late (D-18): the scheduler first saw the period at 06:00");
    assert.equal(r.result.late.seen_at, back);
  } finally { capAt = null; OA.alert = oAlert; }
});

test("PO-1 review: past the hour the epoch waits only for a cut-off that is the SITE's to run now - capital not live, vaults off or not due yet: Pepe's hour", async () => {
  const B6 = B1 + 35 * DAY;
  await book(B6 - DAY, { [String(B6)]: { 1: 0.5 * M, 2: 0.5 * M } });            // next_epoch = B6
  capAt = B6 + 7200;
  try {
    assert.equal(await SCH.cutoffWait(B6, B6 + 60), "hour", "within the hour: Pepe's wait");
    assert.equal(await SCH.cutoffWait(B6, B6 + 7200), "overdue");
    assert.equal(await SCH.cutoffPending(B6, B6 + 7200), true);
    const c0 = await CC.meta("cfg");
    await CC.setMeta("cfg", Object.assign({}, c0 || {}, { vaults_enabled: 0 }));
    try { assert.equal(await SCH.cutoffWait(B6, B6 + 7200), null, "vaults off: the capital tick runs no cut-off"); }
    finally { await CC.setMeta("cfg", c0 || {}); }
    await CC.setMeta("live", false); CC.forgetLive();
    try { assert.equal(await SCH.cutoffWait(B6, B6 + 7200), null, "the share book isn't the site's"); }
    finally { await CC.setMeta("live", true); CC.forgetLive(); }
    capAt = B6 - 60;
    assert.equal(await SCH.cutoffWait(B6, B6 + 7200), null, "not due on the capital clock (a staging test clock ahead of it)");
    capAt = B6 + 7200;
    await cutoff(B6 + 7000);
    assert.equal(await SCH.cutoffWait(B6, B6 + 7200), null, "the bucket closed");
  } finally { capAt = null; }
});
