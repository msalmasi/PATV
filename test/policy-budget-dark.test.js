// While Pepe owns the incentive week the budget service must be invisible: POST /spend records nothing, the sync adds no database write, and one
// fixed stretch of economy (the engines' Monday, website grants, a gang tick, the claim sweep) leaves every table exactly as it does without the
// budget code. PATV_BASE_DIR=<a checkout of the release before it> also compares with that real tree.
//   NODE_PATH=G:/PATV/node_modules node --test test/policy-budget-dark.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const H = require("./fixtures/budget-harness");

H.setProcess("policy-budget-dark");
const repo = path.resolve(__dirname, "..");
const scenario = path.join(__dirname, "fixtures", "budget-dark-scenario.js");
function run(dir, mode) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dark-out-")), "o.json");
  const r = spawnSync(process.execPath, [scenario, dir, out].concat(mode ? [mode] : []), { encoding: "utf8", env: process.env, timeout: 90000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(fs.readFileSync(out, "utf8"));
}

test("the same economy with and without the budget code: identical tables, identical engine results", () => {
  const real = run(repo), without = run(repo, "stub");
  assert.ok(real.tables.moves.length > 5, "the scenario moved points");
  assert.ok(real.tables.effects.some((e) => e.includes("week_share")), "the epoch left its share for Pepe");
  assert.ok(real.tables.claims.some((c) => c.includes("incentives:levelup")), "grants are claims for Pepe");
  assert.ok(real.tables.legs.some((l) => l.includes("turf-tick")), "the gang tick ran");
  assert.deepEqual(real.tables, without.tables);
  assert.deepEqual(real.results, without.results);
  if (process.env.PATV_BASE_DIR) {
    const base = run(process.env.PATV_BASE_DIR);
    assert.deepEqual(real.tables, base.tables);
    assert.deepEqual(real.results, base.results);
  }
});

test("with Pepe as the owner: /spend answers not_owner and writes nothing, /spend-status 'unknown', /week the shadow; the sync writes nothing", async () => {
  const X = await H.boot(repo);
  const B = X.R("policy", "budget");
  await B.init();
  const express = require("express");
  const app = express();
  app.use(express.json());
  B.register(app, { isBotToken: (t) => t === "bot", addUser: (req, res, next) => { const u = req.get("x-test-user"); if (u) req.user = { userId: u }; next(); } });
  await X.runQuery("UPDATE users SET class = 'Admin' WHERE userId = 'u3'");
  const server = app.listen(0);
  try {
    const url = "http://127.0.0.1:" + server.address().port;
    const post = (p, b) => fetch(url + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot" }, b)) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const snap = async () => JSON.stringify([await H.pointTables(X.db), await X.getQuery("SELECT COUNT(*) AS n FROM incentive_spends"), await X.getQuery("SELECT COUNT(*) AS n FROM incentive_settled"),
                                             await X.getQuery("SELECT COUNT(*) AS n FROM incentive_weeks"), await X.getQuery("SELECT COUNT(*) AS n FROM policy_sims")]);
    const before = await snap();
    const r = await post("/api/policy/bot/spend", H.spendBody());
    assert.equal(r.status, 409);
    assert.equal(r.body.state, "not_owner");
    assert.equal((await post("/api/policy/bot/spend-status", { key: "beg:u1:aaaaaa" })).body.state, "unknown");
    const w = (await post("/api/policy/bot/week", {})).body;
    assert.equal(w.owner, "pepe");
    assert.equal(w.week, null);
    assert.equal(before, await snap());
    assert.equal(await B.isSite(), false);
    await assert.rejects(() => X.tx(() => B.spendInTx({ key: "mtt:9:guar", group: "misc", flow: "casino_mtt", legs: [{ userId: "u1", amount: 5 }] })), (e) => e.state === "not_owner");
    assert.equal(before, await snap(), "spendInTx throws before writing");
    // the admin card: admins only, read-only
    const card = (u) => fetch(url + "/api/admin/policy/budget", { headers: u ? { "x-test-user": u } : {} }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.equal((await card(null)).status, 401);
    assert.equal((await card("u1")).status, 403);
    const v = await card("u3");
    assert.equal(v.status, 200); assert.equal(v.body.owner, "pepe"); assert.deepEqual(v.body.days, []);
    assert.equal(before, await snap());
    // the noted sample stays in memory: only the funding state row (written today too) changes
    B.noteSync(H.syncBody().incentives);
    assert.equal(before, await snap());
  } finally { server.close(); }
});
