// The read-only check of the incentive week while Pepe owns it (policy/budgetshadow.js): a correct stream reads 0 per group, everything in flight is
// only "not yet", a difference that lasts the day fails it, legs nobody can name block, the Monday boundary is excused only by named legs that cancel.
//   NODE_PATH=G:/PATV/node_modules node --test test/policy-budget-shadow.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const H = require("./fixtures/budget-harness");

H.setProcess("policy-budget-shadow");
const repo = path.resolve(__dirname, "..");
const { T0, WEEK, WEEK_START } = H;
const DAY = 86400e3, MIN = 60000;
const D = "D2026-11-18";
let X, B, SH, SCH;
let t;

async function leg(key, amount, why, ts, { kind = "move", flow = why } = {}) {
  await X.runQuery("INSERT INTO pool_moves (key, kind, flow, why, via, ts, net, legs, result) VALUES (?, ?, ?, ?, 'pepe', ?, ?, '[]', '{}')", [key, kind, flow, why, ts, amount]);
  await X.runQuery("INSERT INTO pool_move_legs (move_key, i, pool, amount, after, ts) VALUES (?, 0, 'incentives', ?, 0, ?)", [key, amount, ts]);
}
async function doc(d) { await X.ES.putDocs({ econ_treasury: { rev: Date.now() + (doc.n = (doc.n || 0) + 1), doc: d } }); }
/** Pepe's sync at `at` with these spent numbers (his budgets and remaining computed the way he does). */
async function sync(spent, at, over = {}) {
  const K = await B.weekCtx(at / 1000);
  K.inp.week.spent = Object.assign({}, spent);
  const w = B.weekOfInputs(K.inp, K.c, at / 1000);
  SH._setClock(() => at);
  SH.noteSync(Object.assign({ balance: 4000000, week: w.id, budgets: w.budgets, remaining: w.remaining, spent: w.spent, uncapped: w.uncapped, share: null, release_per_day: null }, over));
}
async function passAt(now) {
  t = now;
  X.setNow(now);
  SH._setClock(() => now);
  const info = await SCH.clockInfo(now / 1000);
  return SH.pass(now / 1000, info, await X.C.engines());
}
const row = (p = D) => SH.getRow(p);

test.before(async () => {
  X = await H.boot(repo);
  B = X.R("policy", "budget");
  SH = X.R("policy", "budgetshadow");
  SCH = X.R("policy", "scheduler");
  await B.init();
});
test.beforeEach(async () => {
  await X.runQuery("DELETE FROM pool_move_legs WHERE move_key NOT LIKE 'import:%'");
  await X.runQuery("DELETE FROM pool_moves WHERE key NOT LIKE 'import:%'");
  await X.runQuery("DELETE FROM policy_sims WHERE engine = 'budget'");
  await X.runQuery("DELETE FROM policy_effects");
  SH._reset();
  await doc({ week: { id: WEEK }, weeks: [], settled: {} });
});

test("a correct week reads 0 per group, and the day's row is final", async () => {
  await leg("pv-1", -2000, "beg", T0 - 3 * 3600e3);
  await leg("claim:c1", -25000, "levelup", T0 - 2 * 3600e3);
  await leg("g:turf-tick:2026-11-18:g1", -900, "daily turf tick", T0 - 2 * 3600e3, { kind: "gang", flow: "turf_tick" });
  await leg("rctopa-2026-11-18-p1:out", -300, "activity top-up pool", T0 - 3600e3);
  await leg("lp-grant-p1-1:out", -500, "launchpad grant", T0 - 3600e3);
  await leg("tr-D2026-11-18-floor:out", -700, "floor top-up", T0 - 3600e3);
  await leg("wf-1:in", 50000, "waterfall incentives", T0 - 3600e3);
  await leg("rr-1", -40, "beg refunds", T0 - 3600e3);
  await sync({ roomgames: 2000, levelup: 25000, turf: 900, activity: 300, launchpad: 500 }, T0 - 120000);
  assert.match(await passAt(T0), /clean/);
  const r = await row();
  assert.equal(r.ok, 1);
  assert.deepEqual(r.total_diff, []);
  assert.equal(r.site_plan.spent.levelup, 25000);
  assert.equal(r.pepe_plan.spent.roomgames, 2000);
  assert.equal(r.boundary_ts, (T0 - 120000) / 1000);
  assert.equal(await passAt(T0 + 16 * MIN), null, "final: nothing more that day");
  const v = await B.adminView();
  assert.equal(v.owner, "pepe");
  assert.equal(v.latest.ok, true);
  assert.equal(v.groups.find((g) => g.group === "levelup").drift, 0);
  assert.equal(v.streak, 1);
});

test("a difference is tried again: a later clean read closes the day; never clean -> the next day says so", async () => {
  await leg("pv-2", -1000, "beg", T0 - 3 * 3600e3);
  await sync({ roomgames: 999 }, T0 - 120000);
  assert.match(await passAt(T0), /differs/);
  let r = await row();
  assert.equal(r.ok, null);
  assert.match(r.total_diff[0], /spent\.roomgames: site 1000 \/ pepe 999/);
  assert.equal(r.site_inputs.attempts[0].drift.roomgames, -1);
  await sync({ roomgames: 1000 }, T0 + 15 * MIN);
  assert.match(await passAt(T0 + 17 * MIN), /clean/);
  r = await row();
  assert.equal(r.ok, 1, "the second read was clean");
  await X.runQuery("DELETE FROM policy_sims WHERE engine = 'budget'"); SH._reset();
  await sync({ roomgames: 7 }, T0 - 120000);
  await passAt(T0);
  await passAt(T0 + DAY);                                            // the next day's first pass closes it
  r = await row();
  assert.equal(r.ok, 0);
  assert.equal(r.site_inputs.final, "no clean attempt");
});

test("the day's attempts are counted past the 20 kept, and stop at the cap", async () => {
  const old = Array.from({ length: 20 }, (_, i) => ({ sample_at: i + 1 }));
  await sync({ roomgames: 7 }, T0 - 120000);
  await SH.putRow(D, { site_inputs: { eligible: T0 / 1000, attempts: old, n: 33 } });
  assert.match(await passAt(T0), /differs/);
  let r = await row();
  assert.equal(r.site_inputs.n, 34); assert.equal(r.site_inputs.attempts.length, 20, "only the newest are kept");
  await SH.putRow(D, { site_inputs: Object.assign({}, r.site_inputs, { n: SH.MAX_ATTEMPTS }), site_plan: r.site_plan, pepe_plan: r.pepe_plan, total_diff: r.total_diff, blocking: r.blocking, boundary_ts: r.boundary_ts });
  await sync({ roomgames: 7 }, T0 + 3600e3);
  const at = T0 + 3600e3 + 120000;
  assert.equal(await passAt(at), null);
  r = await row();
  assert.equal(r.site_inputs.n, SH.MAX_ATTEMPTS, "no attempt past the cap");
  assert.equal((await SH.view()).days[0].attempts, SH.MAX_ATTEMPTS, "and the card shows the real count");
});

test("no usable sample: nothing is compared, and the day closes as 'no quiet sample'", async () => {
  await leg("pv-3", -1000, "beg", T0 - 10000);                        // a leg inside the quiet window of the only sample
  await sync({ roomgames: 1000 }, T0 - 20000);
  assert.equal(await passAt(T0), null);
  let r = await row();
  assert.equal(r.ok, null); assert.equal((r.site_inputs.attempts || []).length, 0);
  await passAt(T0 + DAY);
  r = await row();
  assert.equal(r.ok, 0); assert.equal(r.site_inputs.final, "no quiet sample");
  assert.deepEqual(r.blocking, ["no quiet sample"]);
});

test("in flight: an unsure claim isn't counted until its grace ends, then it shows; site effects Pepe hasn't applied are added to his side", async () => {
  await leg("claim:u1", -5000, "achievements", T0 - 5 * MIN);
  await doc({ week: { id: WEEK }, unsure: { u1: (T0 - 5 * MIN) / 1000 }, settled: {} });
  await sync({}, T0 - 2 * MIN);
  assert.match(await passAt(T0), /clean/, "still in flight: not counted");
  await X.runQuery("DELETE FROM policy_sims WHERE engine = 'budget'"); SH._reset();
  await sync({}, T0 + 40 * MIN);
  assert.match(await passAt(T0 + 42 * MIN), /differs/, "past the grace period it is counted");
  const r = await row();
  assert.ok(r.site_inputs.stuck_unsure.includes("u1"));
  await X.runQuery("DELETE FROM policy_sims WHERE engine = 'budget'"); SH._reset();
  await doc({ week: { id: WEEK }, settled: {}, site_spends: {} });
  await leg("act-D2026-11-18-ann:out", -600, "activity_rewards", T0 - 3600e3);
  await X.runQuery("INSERT INTO policy_effects (key, engine, period, kind, data, created) VALUES ('budget_spend:act-D2026-11-18', 'monetary', ?, 'budget_spend', ?, ?)", [D, JSON.stringify({ week: WEEK, group: "activity", amount: 600 }), T0 - 3600e3]);
  await X.runQuery("DELETE FROM pool_moves WHERE key = 'claim:u1'"); await X.runQuery("DELETE FROM pool_move_legs WHERE move_key = 'claim:u1'");
  await sync({}, T0 - 2 * MIN);
  assert.match(await passAt(T0), /clean/, "pending effect covers the leg");
});

test("give-backs: <flow> returned, a lost answer's :undo, Pepe's floor at zero; an unknown returned / undo leg blocks", async () => {
  await leg("pv-4", -1000, "beg", T0 - 3 * 3600e3);
  await leg("pv-5", 1000, "beg returned", T0 - 3 * 3600e3 + 1000);
  await leg("pv-6", -800, "raffle", T0 - 2 * 3600e3);
  await leg("pv-6:undo", 800, "undo raffle (answer lost, caller gave up)", T0 - 2 * 3600e3 + 5000);
  await leg("pv-7", 300, "pictionary returned", WEEK_START + 1000);    // nothing counted yet: floor, not -300
  await sync({}, T0 - 2 * MIN);
  assert.match(await passAt(T0), /clean/);
  const c = (l) => SH.classifyLeg(Object.assign({ ts: T0, kind: "move" }, l), { nowMs: T0 });
  assert.equal(c({ move_key: "pv-x", amount: 5, why: "brand_new returned" }).c, "unmapped");
  assert.equal(c({ move_key: "pv-x:undo", amount: 5, why: "undo brand_new (answer lost)" }).c, "unmapped");
  assert.equal(c({ move_key: "pv-x", amount: -5, why: "brand_new" }).c, "unmapped");
  assert.equal(c({ move_key: "pv-x", amount: -5, why: "say refunds" }).c, "none");
  assert.equal(c({ move_key: "claim:s1", amount: -5, why: "staff_grant" }).c, "none");
  assert.equal(c({ move_key: "claim:s2", amount: -5, why: "website grant" }).group, "misc");
  assert.equal(c({ move_key: "cutover-1", amount: -5, why: "x", kind: "cutover" }).c, "none");
});

test("an unnamed debit blocks the day, whatever the counts say", async () => {
  await leg("mystery-1", -77, "some new spender", T0 - 3600e3);
  await sync({}, T0 - 2 * MIN);
  assert.match(await passAt(T0), /differs/);
  const r = await row();
  assert.equal(r.ok, null);
  assert.match(r.total_diff[0], /unmapped leg mystery-1/);
  assert.equal(r.site_inputs.attempts[0].unmapped, 1);
});

test("a budget or a capped 'remaining' that differs is a difference too", async () => {
  const K = await B.weekCtx((T0 - 2 * MIN) / 1000);
  const w = B.weekOfInputs(K.inp, K.c, (T0 - 2 * MIN) / 1000);
  await sync({}, T0 - 2 * MIN, { budgets: Object.assign({}, w.budgets, { misc: 1 }) });
  assert.match(await passAt(T0), /differs/);
  assert.ok((await row()).total_diff.some((x) => /budget\.misc/.test(x)));
});

test("claims count in the week Pepe marked them: a debit just before Monday's boundary, marked after it", async () => {
  const mon = WEEK_START + 7 * DAY;
  await leg("claim:m1", -5000, "achievements", mon - 2000);
  await doc({ week: { id: "W2026-11-23" }, weeks: [{ id: WEEK, spent: {} }], settled: { m1: Math.floor((mon + 3000) / 1000) } });
  await sync({ achievements: 5000 }, mon + 7 * 3600e3);
  assert.match(await passAt(mon + 7 * 3600e3 + 2 * MIN), /clean/);
});

test("a count before Monday's boundary with its leg after it: a visible carry, exact and named; anything else stays a difference", async () => {
  const mon = WEEK_START + 7 * DAY;
  await leg("pv-b1", -1200, "beg", mon + 2000);                       // Pepe counted it last week; the debit landed just after the boundary
  await doc({ week: { id: "W2026-11-23" }, weeks: [{ id: WEEK, spent: { roomgames: 1200 } }], settled: {} });
  await sync({}, mon + 7 * 3600e3);
  assert.match(await passAt(mon + 7 * 3600e3 + 2 * MIN), /clean/);
  let r = await row("D2026-11-23");
  assert.equal(r.ok, 1);
  assert.equal(r.site_inputs.carry.roomgames.amount, -1200);
  assert.match(r.notes[0], /carry -1200 over the Monday boundary \(pv-b1\)/);
  // the closed week is compared the same evening, and the same legs explain it
  const w = await row(WEEK);
  assert.equal(w.ok, 1); assert.match(w.notes[0], /roomgames/);
  await X.runQuery("DELETE FROM policy_sims WHERE engine = 'budget'"); SH._reset();
  await doc({ week: { id: "W2026-11-23" }, weeks: [{ id: WEEK, spent: { roomgames: 1100 } }], settled: {} });     // doesn't cancel
  await sync({}, mon + 7 * 3600e3);
  assert.match(await passAt(mon + 7 * 3600e3 + 2 * MIN), /differs/);
  assert.equal((await row(WEEK)).ok, 0);
});

test("a pad top-up journaled last week that lands days later matches by its key, with no time limit", async () => {
  const mon = WEEK_START + 7 * DAY;
  await leg("rctopa-2026-11-22-p1:out", -9000, "activity top-up pool", mon + 2 * DAY);
  await doc({ week: { id: "W2026-11-23" }, weeks: [{ id: WEEK, spent: { activity: 9000 } }], settled: {} });
  await sync({}, mon + 2.5 * DAY);
  assert.match(await passAt(mon + 2.5 * DAY + 2 * MIN), /clean/);
  assert.equal((await row("D2026-11-25")).site_inputs.carry.activity.amount, -9000);
});

test("it only runs when it may: not before 05:00 UTC, not after 03:30, not until the day's runs are done, not for a site-owned week, at most every 15 minutes", async () => {
  await sync({}, T0 - 2 * MIN);
  const dayStart = Date.UTC(2026, 10, 18, 4, 0, 0);
  assert.equal(await passAt(dayStart + 3000e3), null);
  assert.equal((await row()), null, "04:50: no row yet");
  assert.equal(await passAt(dayStart + 86000e3), null, "after 03:30");
  assert.equal((await row()), null);
  await X.C.setMode("treasury", "live", { by: "t", armedAt: 0 });
  assert.equal(await passAt(T0), null, "the day's treasury run hasn't happened");
  await X.C.putRun("treasury", D, { state: "done" });
  SH._reset(); await sync({}, T0 - 2 * MIN);
  assert.match(await passAt(T0), /clean/);
  await X.C.setMode("treasury", "off", { by: "t" });
  await X.runQuery("DELETE FROM policy_runs");
  await X.runQuery("DELETE FROM policy_sims WHERE engine = 'budget'");
  await X.owner("site");
  SH._reset(); await sync({}, T0 - 2 * MIN);
  assert.equal(await passAt(T0), null, "the site owns the week: nothing to compare");
  await X.owner("pepe");
  SH._reset(); await sync({}, T0 - 2 * MIN);
  await sync({ roomgames: 1 }, T0 - 90000);
  await passAt(T0);
  assert.equal(await passAt(T0 + 5 * MIN), null, "throttled");
});

test("a failing read never breaks the scheduler's pass; the sample ring is memory only and bounded", async () => {
  const real = X.R("policy", "budget").weekCtx;
  const Bm = X.R("policy", "budget");
  Bm.weekCtx = async () => { throw new Error("boom"); };
  const err = console.error;
  console.error = () => {};
  try { await sync.call; SH._reset(); SH.noteSync({ spent: {}, week: WEEK, budgets: {}, remaining: {} }); assert.equal(await passAt(T0), null); }
  finally { Bm.weekCtx = real; console.error = err; }
  SH._reset();
  for (let i = 0; i < 100; i++) SH.noteSync({ spent: {}, week: WEEK });
  assert.equal(SH._ring().length, SH.RING_MAX);
  SH.noteSync(null); SH.noteSync({ week: WEEK });
  assert.equal(SH._ring().length, SH.RING_MAX, "a block with no spent is ignored");
  assert.equal(t > 0, true);
});
