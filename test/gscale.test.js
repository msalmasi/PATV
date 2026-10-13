// Q11 (ECONOMY-V3 23.2): the activity-scaled guarantee target - the engine's arithmetic (pre-reference, clamps, smoothing,
// stale lists), the weekly participant series from the recipe ledger (policy/gscale.js), the gather adding it only while
// the switch is on, the monetary plan using it, Pepe's endpoint and the admin card's dry run.
//   NODE_PATH=G:/PATV/node_modules node --test test/gscale.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gscale-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const E = require(path.join(repo, "policy", "engines"));
const C = require(path.join(repo, "policy", "core"));
const G = require(path.join(repo, "policy", "gather"));
const GS = require(path.join(repo, "policy", "gscale"));
const R = require(path.join(repo, "recipe"));

const M = 1000000;
const W = 7 * 86400;
const MON = (y, mo, d) => Date.UTC(y, mo - 1, d, 4) / 1000;     // an epoch boundary (Monday 04:00 UTC)
const W0 = MON(2026, 10, 12);                                    // payouts went live
const DEF = { guarantee_base: 25 * M, guarantee_min: 15 * M, guarantee_max: 40 * M, guarantee_smooth_weeks: 3, guarantee_ref_weeks: 4 };
const gs = (weeks, m, over = {}) => E.gscale(weeks, m, (k) => Object.assign({}, DEF, over)[k]);
const series = (ns) => ns.map((n, i) => [W0 + i * W, n]);

test("pre-reference: the target stays at base until ref_weeks complete weeks exist", () => {
  const ws = series([10, 20, 30, 40]);
  for (const m of [W0, W0 + W, W0 + 2 * W, W0 + 3 * W]) {
    const g = gs(ws, m);
    assert.equal(g.collecting, true);
    assert.equal(g.target, 25 * M);
    assert.equal(g.raw, 25 * M);
  }
  assert.equal(gs(ws, W0 + 3 * W).weeks_have, 3);
  assert.equal(gs([], W0 + 10 * W).target, 25 * M);
  // the 4th week completes on 2026-11-09: reference = median(10,20,30,40) = 25; last week 40 -> 40M raw; smoothed (40+25+25)/3
  const g = gs(ws, W0 + 4 * W);
  assert.equal(g.collecting, false);
  assert.equal(g.reference, 25);
  assert.equal(g.participants, 40);
  assert.equal(g.raw, 40 * M);
  assert.deepEqual(g.raws, [40 * M, 25 * M, 25 * M]);
  assert.equal(g.target, 30 * M);
});

test("clamps at min and max, and the running week is ignored", () => {
  const lo = gs(series([100, 100, 100, 100, 1]), W0 + 5 * W, { guarantee_smooth_weeks: 1 });
  assert.equal(lo.raw, 15 * M);                                 // 25M x 1/100 -> clamped up to 15M
  const hi = gs(series([100, 100, 100, 100, 1000]), W0 + 5 * W, { guarantee_smooth_weeks: 1 });
  assert.equal(hi.raw, 40 * M);                                 // 25M x 10 -> clamped down to 40M
  const mid = gs(series([100, 100, 100, 100, 120]), W0 + 5 * W, { guarantee_smooth_weeks: 1 });
  assert.equal(mid.raw, 30 * M);
  const zero = gs(series([100, 100, 100, 100, 0]), W0 + 5 * W, { guarantee_smooth_weeks: 1 });
  assert.equal(zero.raw, 15 * M);
  // the running week (starts at M) never counts
  const run = gs(series([100, 100, 100, 100, 120, 5000]), W0 + 5 * W, { guarantee_smooth_weeks: 1 });
  assert.equal(run.raw, 30 * M);
});

test("smoothing: the mean of the last N raw targets; a stale list carries the latest week", () => {
  const ws = series([100, 100, 100, 100, 120, 80, 160]);
  const g = gs(ws, W0 + 7 * W);                                 // raws: 160 -> 40M, 80 -> 20M, 120 -> 30M
  assert.deepEqual(g.raws, [40 * M, 20 * M, 30 * M]);
  assert.equal(g.target, 30 * M);
  assert.equal(gs(ws, W0 + 7 * W, { guarantee_smooth_weeks: 2 }).target, 30 * M);
  assert.equal(gs(ws, W0 + 7 * W, { guarantee_smooth_weeks: 1 }).target, 40 * M);
  assert.equal(gs([[1, 0]].concat(ws), W0 + 7 * W).weeks_have, 8);
  // even reference count: the mean of the middle two (an odd count: the middle one)
  assert.equal(gs(series([1, 2, 3, 50]), W0 + 4 * W).reference, 2.5);
  assert.equal(gs(series([1, 2, 3, 50, 7]), W0 + 5 * W, { guarantee_ref_weeks: 5 }).reference, 3);
  // stale (last week missing): the latest week the list has
  const stale = gs(series([100, 100, 100, 100, 120]), W0 + 6 * W, { guarantee_smooth_weeks: 1 });
  assert.equal(stale.participants, null);
  assert.equal(stale.raw, 30 * M);
  // a reference of 0 -> base
  assert.equal(gs(series([0, 0, 0, 0, 50]), W0 + 5 * W).target, 25 * M);
});

test("the guarantee and the heist caps use the scaled target only while the switch is on", () => {
  const now = W0 + 5 * W + 300;
  const base = { kind: "monetary", now, did: "D2026-11-16", guarantee: true, local_day: "2026-11-15",
                 cfg: Object.assign({}, E.DEFAULTS, { incentive_guarantee_target: 25 * M, issuance_to_guarantee: false, fed_floor: 0 }),
                 consts: E.CONSTS, flags: { layers: true }, pools: { reserve: 100 * M, incentives: 0 }, mints: [], journal: [], rows: [], days: [], skip: [],
                 gweeks: series([100, 100, 100, 100, 160]) };
  const off = E.planMonetary(base);
  assert.equal(off.guarantee_target, 25 * M);
  const on = E.planMonetary(Object.assign({}, base, { cfg: Object.assign({}, base.cfg, { guarantee_scaled: true }) }));
  assert.equal(on.guarantee_target, Math.floor((40 * M + 25 * M + 25 * M) / 3));
  assert.equal(on.guarantee_paid, 30 * M);
  const c = E.C({ cfg: Object.assign({}, base.cfg, { guarantee_scaled: true }), consts: E.CONSTS });
  assert.equal(E.heistCap(base, c, "fortknox", now), Math.trunc(30 * M * 60 / 100));
});

let server, baseUrl;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, class TEXT DEFAULT 'pleb', password TEXT, camfrogUsername TEXT,
                  level INTEGER DEFAULT 0, created_at TEXT)`);
  await R.init();
  await C.init();
  await C.putCfg({ econ_cfg: Object.assign({}, E.DEFAULTS, { incentive_guarantee_target: 25 * M }), consts: E.CONSTS, flags: { layers: true } });
  let i = 0;
  const credit = (week, user, slice, offset = 3600) =>
    runQuery("INSERT INTO recipe_credits (ref, room_id, day, slice, userId, amount, created) VALUES (?, 'r1', '2026-10-13', ?, ?, 100, ?)",
             [`ref-${++i}`, slice, user, (W0 + week * W + offset) * 1000]);
  // before payouts went live: ignored
  await credit(-1, "early", "people");
  // week 0: 3 people (one twice, one as owner too), week 1: none, week 2: 2 + a gang credit (not a participant)
  await credit(0, "u1", "people"); await credit(0, "u1", "people", 90000); await credit(0, "u2", "streamers"); await credit(0, "u3", "owner");
  await credit(0, "u1", "owner");
  await credit(2, "u4", "people"); await credit(2, "u5", "people"); await credit(2, "u9", "gang");
  // week 3: the week boundary itself belongs to week 3 (Monday 04:00:00 UTC)
  await credit(3, "u6", "people", 0); await credit(3, "u7", "people", W - 1);
  // week 4 (running at "now" below)
  await credit(4, "u8", "people");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); if (u) req.user = { userId: u, username: u, class: u === "ua" ? "Admin" : "pleb" }; next(); };
  GS.register(app, { isBotToken: (t) => t === "bot", addUser });
  server = app.listen(0);
  baseUrl = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());

test("the weekly series: distinct gated payout participants per epoch week, contiguous, complete weeks only", async () => {
  const now = W0 + 4 * W + 600;
  assert.deepEqual(await GS.weeks(now), [[W0, 3], [W0 + W, 0], [W0 + 2 * W, 2], [W0 + 3 * W, 2]]);
  assert.equal(await GS.running(now), 1);
  assert.deepEqual(await GS.weeks(W0 + 100), []);
});

test("gather adds gweeks only while the switch is on", async () => {
  const now = W0 + 4 * W + 600;
  const off = await G.withGweeks({ now, cfg: { guarantee_scaled: false }, consts: E.CONSTS });
  assert.equal("gweeks" in off, false);
  const on = await G.withGweeks({ now, cfg: { guarantee_scaled: true }, consts: E.CONSTS });
  assert.deepEqual(on.gweeks, await GS.weeks(now));
});

test("Pepe's endpoint and the admin card (dry run while off)", async () => {
  const now = W0 + 4 * W + 600;
  const r = await fetch(baseUrl + "/api/policy/bot/gweeks", { method: "POST", headers: { "content-type": "application/json" },
                                                               body: JSON.stringify({ password: "bot", now }) }).then((x) => x.json());
  assert.equal(r.ok, true);
  assert.deepEqual(r.weeks, await GS.weeks(now));
  const bad = await fetch(baseUrl + "/api/policy/bot/gweeks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "x" }) });
  assert.equal(bad.status, 403);
  const v = await GS.view(now);
  assert.equal(v.on, false);
  assert.equal(v.collecting, false);                            // 4 complete weeks: 3, 0, 2, 2 -> median 2
  assert.equal(v.reference, 2);
  assert.equal(v.last_week.participants, 2);
  assert.equal(v.this_week.participants, 1);
  assert.equal(v.raw, 25 * M);
  assert.equal(v.fixed_target, 25 * M);
  assert.equal(v.in_force, 25 * M);
  assert.equal(v.history.length, 4);                             // Mondays 10-19 .. 11-09, newest first
  assert.equal(v.history[0].monday, W0 + 4 * W);
  assert.equal(v.history[3].collecting, true);
  const pleb = await fetch(baseUrl + "/api/admin/econ/gscale", { headers: { "x-test-user": "u1" } });
  assert.equal(pleb.status, 403);
});
