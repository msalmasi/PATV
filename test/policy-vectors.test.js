// Phase 4: the policy engines' plans (policy/engines.js) replay Pepe's REAL Python on random economies
// (camfrog-bot tools/gen_policy_vectors.py -> test/fixtures/policy-vectors.json.gz): the Monday surplus waterfall, the daily
// release, the monetary day and the activity payouts must come out the SAME - every PAT, every leg (tid, source,
// destination, amount) in the same order, every float the plan keeps.
//   NODE_PATH=G:/PATV/node_modules node --test test/policy-vectors.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const E = require(path.join(__dirname, "..", "policy", "engines"));

const FIX = path.join(__dirname, "fixtures", "policy-vectors.json.gz");
const data = JSON.parse(zlib.gunzipSync(fs.readFileSync(FIX)).toString("utf8"));

/** Deep equality with numbers compared by value (Python's 7.0 is JSON 7.0, JavaScript's 7). */
function same(a, b, where, diffs) {
  if (typeof a === "number" && typeof b === "number") { if (a !== b && !(Number.isNaN(a) && Number.isNaN(b))) diffs.push(`${where}: ${a} !== ${b}`); return; }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") { if (a !== b) diffs.push(`${where}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); return; }
  if (Array.isArray(a) !== Array.isArray(b)) { diffs.push(`${where}: array vs object`); return; }
  if (Array.isArray(a)) {
    if (a.length !== b.length) diffs.push(`${where}: length ${a.length} !== ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) same(a[i], b[i], `${where}[${i}]`, diffs);
    return;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) same(a[k], b[k], `${where}.${k}`, diffs);
}

test("the vectors cover every engine", () => {
  const by = {};
  for (const c of data.cases) by[c.kind] = (by[c.kind] || 0) + 1;
  assert.ok(by.epoch >= 100 && by.daily >= 100 && by.monetary >= 100, JSON.stringify(by));
});

for (const kind of ["epoch", "daily", "monetary"]) {
  test(`${kind}: every plan equals Pepe's`, () => {
    const bad = [];
    let n = 0, legs = 0, pat = 0;
    for (const [i, c] of data.cases.entries()) {
      if (c.kind !== kind) continue;
      n++;
      let got;
      if (kind === "epoch") got = E.planEpoch(c.inputs);
      else if (kind === "daily") got = E.planDaily(c.inputs);
      else {
        got = E.planMonetary(c.inputs);
        const a = got.activity || {};
        got._activity_payouts = a.amount > 0 ? E.planActivity(c.inputs, a.local_day, a.amount) : [];
      }
      const diffs = [];
      same(got, c.expected, `case ${i}`, diffs);
      if (diffs.length) bad.push(diffs.slice(0, 6).join("\n"));
      legs += (got.legs || []).length;
      pat += (got.legs || []).reduce((s, l) => s + (l.amt || l.amount || 0), 0);
    }
    assert.equal(bad.length, 0, `${bad.length} of ${n} ${kind} plans differ:\n${bad.slice(0, 5).join("\n---\n")}`);
    assert.ok(legs > 0 && pat > 0, `${kind}: the vectors move PAT (${legs} legs, ${pat} PAT)`);
  });
}

// D2's safeguard (camfrog-bot 31c65d0): the vectors pay vaults with NO weekly cap in force on wholly time-weighted weeks
// (no cap), on weeks whose PAT-days began mid-way ("partial") and on weeks with none ("snapshot") - the last two under the 25%
// reference cap. The plans above match Pepe's in all of them; this checks they are really there.
test("epoch: the no-cap plans cover every weighting, the reference cap binding on the partial / snapshot weeks", () => {
  const by = { pat_days: 0, partial: 0, snapshot: 0 }, bound = { pat_days: 0, partial: 0, snapshot: 0 };
  for (const c of data.cases) {
    if (c.kind !== "epoch") continue;
    const cfg = E.C(c.inputs);
    if (cfg.share("wf_staker_cap_pct", Number(cfg.k("VAULT_CEIL_APR"))) > 0) continue;
    const lb = E.lastBoundaryOf(c.inputs, c.expected.epoch);
    for (const [v, x] of Object.entries(c.expected.vaults)) {
      if (!(x.stakers_share > 0)) continue;
      const w = E.weightingFor(c.inputs.vaults[v], c.expected.boundary, lb, c.expected.days);
      by[w]++;
      if (x.apr_cap < x.stakers_share) bound[w]++;
      if (w === "pat_days") assert.equal(x.apr_cap, x.stakers_share, "a wholly time-weighted week: no cap");
      else assert.ok(Math.abs(x.apr_cap - Math.trunc(x.staked * 0.25 * c.expected.days / 365)) <= 1, `${w}: the 25% reference cap`);   // staked is the plan's int()
    }
  }
  assert.ok(by.pat_days >= 5 && by.partial >= 5 && by.snapshot >= 5, JSON.stringify(by));
  assert.ok(bound.partial + bound.snapshot >= 5, "the reference cap actually binds: " + JSON.stringify(bound));
});

// Q11 (ECONOMY-V3 23.2): the activity-scaled guarantee target - pepe_monetary.gscale on random weekly participant series
// (pre-reference, clamps, smoothing, stale lists), the same numbers here
test("gscale: every activity-scaled target equals Pepe's", () => {
  const cases = data.gscale || [];
  assert.ok(cases.length >= 100, `gscale cases: ${cases.length}`);
  const bad = [];
  for (const [i, c] of cases.entries()) {
    const diffs = [];
    same(E.gscale(c.weeks, c.M, (k) => c.cfg[k]), c.expected, `gscale ${i}`, diffs);
    if (diffs.length) bad.push(diffs.slice(0, 4).join("\n"));
  }
  assert.equal(bad.length, 0, `${bad.length} differ:\n${bad.slice(0, 5).join("\n---\n")}`);
  assert.ok(cases.some((c) => !c.expected.collecting && c.expected.raws.some((x) => x === c.expected.min)), "a clamp at min");
  assert.ok(cases.some((c) => !c.expected.collecting && c.expected.raws.some((x) => x === c.expected.max)), "a clamp at max");
  assert.ok(cases.some((c) => c.expected.collecting), "a pre-reference case");
});
