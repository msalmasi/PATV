// The daily gang tick's incentive leg and the weekly budget: with Pepe owning the week the move runs as always (he counts it); once the site owns
// it the turf group is checked and counted in the move's own transaction, and a refusal refuses the whole move.
//   NODE_PATH=G:/PATV/node_modules node --test test/gangs-tick-budget.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const path = require("path");
const H = require("./fixtures/budget-harness");

H.setProcess("gangs-tick-budget");
const repo = path.resolve(__dirname, "..");
const { T0, WEEK } = H;
let X, B, GG;
const GID = "aa11bb22";
const tick = (key, amount) => GG.move({ key, gid: GID, legs: [["incentives", -amount], ["gang", amount]], why: "daily turf tick", flow: "turf_tick" }, "pepe");
const treasury = () => X.P.balance("gang:" + GID);

test.before(async () => {
  X = await H.boot(repo);
  B = X.R("policy", "budget");
  GG = X.R("gangs");
  await B.init();
  await GG.init();
  await GG._setMeta("enabled", true);
  const payload = JSON.stringify({ v: 1, source: "pepe", gangs: { [GID]: { name: "One", tag: "ONE", boss: "ann_cf", officers: [], members: ["ann_cf"], treasury: 100, rep: 1, created: "2026-07-04", wars: {} } },
                                   members: { ann_cf: GID }, users: { ann_cf: { userId: "u1" } }, disbanded: {}, supply_gangs: 100, casino_rep_done: [], cfg: {} });
  assert.equal((await GG.importFromPepe({ key: "gc-tick-1", payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"),
                                          totals: { gangs: 1, members: 1, treasury: 100, rep: 1 } })).ok, true);
});

test("Pepe owns the week: the tick moves as always, nothing is counted here", async () => {
  const i = await X.P.balance("incentives"), g = await treasury();
  const r = await tick("turf-tick:2026-11-16:" + GID, 1000);
  assert.equal(r.ok, true);
  assert.equal(await X.P.balance("incentives"), i - 1000);
  assert.equal(await treasury(), g + 1000);
  assert.equal((await X.getQuery("SELECT COUNT(*) AS n FROM incentive_spends"))[0].n, 0);
  // more than the group could take: Pepe decides, the site doesn't
  assert.equal((await tick("turf-tick:2026-11-17:" + GID, 400000)).ok, true);
  assert.equal((await X.getQuery("SELECT COUNT(*) AS n FROM incentive_spends"))[0].n, 0);
});

test("the site owns the week: checked and counted in the move's transaction, once per key", async () => {
  await X.owner("site");
  const i = await X.P.balance("incentives");
  const left0 = await B.remaining("turf");
  assert.equal(left0, Math.floor(500000 * 3 / 7));
  const key = "turf-tick:2026-11-18:" + GID;
  const r = await tick(key, 5000);
  assert.equal(r.ok, true);
  assert.equal(await X.P.balance("incentives"), i - 5000);
  assert.equal(await B.remaining("turf"), left0 - 5000);
  const row = (await X.getQuery("SELECT eid, grp, flow, amount, status, via FROM incentive_spends WHERE key = ?", ["g:" + key]))[0];
  assert.deepEqual([row.eid, row.grp, row.flow, row.amount, row.status], [WEEK, "turf", "turf_income", 5000, "paid"]);
  const again = await tick(key, 5000);
  assert.equal(again.ok, true);
  assert.equal(await B.remaining("turf"), left0 - 5000, "the move's key answers first: nothing more is counted");
  assert.equal(await X.P.balance("incentives"), i - 5000);
});

test("over the turf budget: the whole move is refused, no treasury credit, no row, and the same key can come back later", async () => {
  const i = await X.P.balance("incentives"), g = await treasury();
  const key = "turf-tick:2026-11-19:" + GID;
  await assert.rejects(() => tick(key, 400000), (e) => e.code === "E_OVER_BUDGET");
  assert.equal(await X.P.balance("incentives"), i);
  assert.equal(await treasury(), g);
  assert.equal((await X.getQuery("SELECT COUNT(*) AS n FROM incentive_spends WHERE key = ?", ["g:" + key]))[0].n, 0);
  X.setNow(T0 + 4 * 86400e3);                                        // Sunday: more of the paced budget is open
  assert.equal((await tick(key, 100000)).ok, true);
  X.setNow(T0);
});

test("other gang moves and other flows don't touch the budget", async () => {
  const n = (await X.getQuery("SELECT COUNT(*) AS n FROM incentive_spends"))[0].n;
  assert.equal((await GG.move({ key: "turf:d1:" + GID, gid: GID, legs: [["gang", 50]], why: "turf tick income", flow: "turf_income" }, "pepe")).ok, true);
  assert.equal((await GG.move({ key: "turf:d2:" + GID, gid: GID, legs: [["reserve", -50], ["gang", 50]], why: "tick", flow: "turf_tick" }, "pepe")).ok, true);
  assert.equal((await X.getQuery("SELECT COUNT(*) AS n FROM incentive_spends"))[0].n, n);
});
