// 1.99aom: tools/policy-backend.js preflight - once H1 is done (policy_ownership cfg = site) the H1 gate "dual read recorded every
// day" is retired: the readers read policy_cfg and compare no push (policy/config.js capitalCfg / sourceView return before noteDual),
// so it can never record again and must not FAIL the H2a preflight. While Pepe owns the settings (or they are frozen for the
// hand-over) it FAILs on a missing day as before; every other line is unchanged.
//   NODE_PATH=G:/PATV/node_modules node --test test/policy-backend-h1done.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { evidenceChecks } = require(path.join(__dirname, "..", "tools", "policy-backend.js"));

const days = ["2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16"];
const clean = { missing: 0, unknown: 0, invalid: 0, whole: 0, disagree: 0 };
function state(owner, { dual = [], mirror = true } = {}) {
  return {
    evidence: { from: days[0], today: "2026-11-17", days, since: null, dual,
                mirror: Object.fromEntries([...days, "2026-11-17"].map((d) => [d, mirror ? { pushes: 288, changes: 0, max: clean } : null])) },
    backends: { capital: { live: true } }, engines: { treasury: { mode: "shadow" }, monetary: { mode: "shadow" }, burn: { mode: "shadow" } },
    push: { age_s: 60 }, features: { cfg: { owner, since: Date.parse("2026-11-03T15:24:00Z"), handover_key: "8889409bdeadbeef" } },
  };
}
const find = (out, re) => out.filter((r) => re.test(r.check));

test("cfg = site: the dual-read evidence line is INFO 'H1 done (cfg=site): dual read retired', never a FAIL", () => {
  const out = evidenceChecks(state("site"));
  const h1 = find(out, /^H1 done \(cfg=site\): dual read retired$/);
  assert.equal(h1.length, 1, JSON.stringify(out));
  assert.equal(h1[0].level, "INFO");
  assert.match(h1[0].detail, /since 2026-11-03 15:24Z \(hand-over 8889409bdead\)/);
  assert.deepEqual(find(out, /^dual read recorded every day/), [], "the H1 gate is gone");
  assert.deepEqual(out.filter((r) => r.level === "FAIL"), [], "nothing fails");
});
test("cfg = pepe or frozen (cutting): a day with no comparison still FAILs, exactly as before", () => {
  for (const owner of ["pepe", "cutting"]) {
    const out = evidenceChecks(state(owner));
    const rec = find(out, /^dual read recorded every day 2026-11-13\.\.2026-11-16 \(capital\.cutoff, policy\.source, funding\.monetary\)$/);
    assert.equal(rec.length, 1, owner);
    assert.equal(rec[0].level, "FAIL", owner);
    assert.match(rec[0].detail, /^no comparison recorded: 2026-11-13 capital\.cutoff/);
    assert.deepEqual(find(out, /^H1 done/), [], owner);
  }
  // and recorded every day: PASS
  const dual = days.flatMap((d) => ["capital.cutoff", "policy.source", "funding.monetary"].map((consumer) => ({ day: d, consumer, checks: 3, diffs: 0 })));
  const ok = find(evidenceChecks(state("pepe", { dual })), /^dual read recorded every day/);
  assert.equal(ok[0].level, "PASS");
});
test("cfg = site keeps every other line: the mirror diff gate and a dual-read difference still FAIL", () => {
  const out = evidenceChecks(state("site", { mirror: false, dual: [{ day: "2026-11-17", consumer: "fed.cfgNow", checks: 2, diffs: 1 }] }));
  assert.equal(find(out, /^mirror diff empty every day/)[0].level, "FAIL");
  assert.equal(find(out, /^dual read clean 2026-11-13\.\.2026-11-17/)[0].level, "FAIL");
  assert.equal(find(out, /^H1 done/)[0].level, "INFO");
  const same = evidenceChecks(state("pepe", { mirror: false, dual: [{ day: "2026-11-17", consumer: "fed.cfgNow", checks: 2, diffs: 1 }] }));
  assert.deepEqual(find(out, /^(mirror diff|dual read clean|dual read, other)/), find(same, /^(mirror diff|dual read clean|dual read, other)/), "identical to the pepe-owned lines");
});
