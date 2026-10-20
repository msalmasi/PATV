// PO-2 (economy policy -> site plan, "Phase 6"): the site's port of Pepe's economy settings rules (policy/cfgspec.js) against
// vectors from Pepe's REAL code (camfrog-bot tools/gen_econcfg_vectors.py -> test/fixtures/policy-config-vectors.json.gz):
//   * the spec - the 69 econ_cfg keys in Pepe's order, their sections, labels, kinds, bounds, choices; the pairs, the groups, the
//     budget total cap, the economy sink-rate list; the defaults (D-8: wf_staker_cap_pct 0, patched on both sides)
//   * every change case: a base config, then a change -> _ec_change's ok, its message word for word, its errors, the whole config
//     after (single sets at and past the bounds, amounts, caps, bools, enums, pct rounding, defaults / resets, the pairs, the
//     budgets' total, the guarantee target, unknown keys, several errors, random multi-key changes; the alias names)
//   * parse_value of every kind on odd inputs
//   * D-7's fraction input (chat needs the %, the web takes a percent number) - the rule PO-3 implements in Pepe's chat
// 0 differences.
//   NODE_PATH=G:/PATV/node_modules node --test test/policy-config-vectors.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const repo = path.resolve(__dirname, "..");
const S = require(path.join(repo, "policy", "cfgspec"));
const V = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures", "policy-config-vectors.json.gz"))).toString("utf8"));

test("the vectors are there: hundreds of cases, Pepe's generator", () => {
  assert.equal(V.v, 1);
  assert.match(V.generated_by, /gen_econcfg_vectors\.py/);
  assert.ok(V.cases.length >= 300, `cases: ${V.cases.length}`);
  assert.ok(V.cases.filter((c) => c.ok).length > 100 && V.cases.filter((c) => !c.ok).length > 100, "both answers covered");
  assert.ok(V.cases.some((c) => c.kind === "alias"));
  assert.ok(V.parse.length > 100 && V.fraction.length > 20);
});

test("the spec: Pepe's 69 econ_cfg keys, in his order, with his sections, labels, kinds, bounds and choices", () => {
  assert.deepEqual(S.ECON_KEYS, V.spec.map((x) => x.key));
  for (const x of V.spec) {
    const sp = S.SPEC[x.key];
    assert.equal(sp.section, x.section, x.key + " section");
    assert.equal(sp.label, x.label, x.key + " label");
    assert.equal(sp.kind, x.kind, x.key + " kind");
    assert.equal(sp.min, x.min, x.key + " min");
    assert.equal(sp.max, x.max, x.key + " max");
    assert.deepEqual(sp.choices, x.choices, x.key + " choices");
  }
  assert.deepEqual(S.PAIRS, V.pairs);
  assert.equal(S.BUDGET_TOTAL_MAX, V.budget_total_max);
  assert.deepEqual(S.GROUPS, V.groups);
  assert.deepEqual(S.SINK_KEYS, V.sink_keys, "pepe_econcfg.ECON_SINK_KEYS");
  for (const sk of V.sink_keys) assert.ok(S.resolveKey(sk), `${sk}: a site key (or an alias of one)`);
});

test("the defaults are Pepe's (D-8: wf_staker_cap_pct 0 on both sides)", () => {
  assert.deepEqual(Object.keys(V.defaults).sort(), S.ECON_KEYS.slice().sort());
  for (const k of S.ECON_KEYS) assert.deepEqual(S.defaultOf(k), V.defaults[k], k);
  assert.equal(V.d8.wf_staker_cap_pct, 0);
});

test("every change case answers as Pepe's _ec_change: ok, the message, the errors, the whole config after - 0 differences", () => {
  const full = (diff) => Object.assign({}, V.defaults, diff || {});
  const bad = [];
  for (const c of V.cases) {
    let cur = S.defaults();
    const ch = (x) => { const o = {}; for (const [k, v] of Object.entries(x || {})) o[S.resolveKey(k) || k] = v; return o; };
    if (c.base) {
      const b = S.change(cur, ch(c.base), { via: "chat" });
      if (!b.ok) { bad.push(`${c.name}: the base was refused: ${b.msg}`); continue; }
      cur = b.next;
    }
    if (JSON.stringify(S.econView(cur)) !== JSON.stringify(full(c.before))) {
      try { assert.deepEqual(S.econView(cur), full(c.before)); } catch (e) { bad.push(`${c.name}: before differs`); continue; }
    }
    const r = S.change(cur, ch(c.changes), { via: "chat" });
    const after = r.ok ? r.next : cur;
    try {
      assert.equal(r.ok, c.ok, "ok");
      assert.equal(r.msg, c.msg, "msg");
      assert.deepEqual(r.errs, c.errs, "errs");
      assert.deepEqual(S.econView(after), full(c.after), "after");
    } catch (e) { bad.push(`${c.name}: ${e.message.split("\n")[0]} | site ${JSON.stringify(r.msg)} | pepe ${JSON.stringify(c.msg)}`); }
  }
  assert.deepEqual(bad.slice(0, 20), [], `${bad.length} of ${V.cases.length} differ`);
});

test("parse_value of every kind on odd inputs - 0 differences", () => {
  const bad = [];
  for (const p of V.parse) {
    const got = S.parseValue(S.SPEC[p.key], p.input);
    const want = p.value === undefined ? null : p.value;
    try { assert.deepEqual(got, want); } catch (e) { bad.push(`${p.kind} ${JSON.stringify(p.input)}: site ${JSON.stringify(got)} / pepe ${JSON.stringify(want)}`); }
  }
  assert.deepEqual(bad, []);
});

test("D-7: a fraction key's % input (chat must spell it, the web takes a percent number)", () => {
  const bad = [];
  for (const f of V.fraction) {
    const r = S.parseInput(f.key, f.input, { via: f.via });
    try {
      assert.equal(r.ok, f.ok, "ok");
      if (f.ok) assert.equal(r.value, f.value, "value");
      if (f.hint === "add %") assert.match(r.error, /add %/);
    } catch (e) { bad.push(`${f.key} ${f.via} ${JSON.stringify(f.input)}: ${e.message.split("\n")[0]}`); }
  }
  assert.deepEqual(bad, []);
  // a bare number from chat is refused with the hint; from the web it is a percent
  assert.match(S.change(S.defaults(), { vault_ceil_apr: "25" }, { via: "chat" }).msg, /add %/);
  assert.equal(S.change(S.defaults(), { vault_ceil_apr: 25 }, { via: "web" }).next.vault_ceil_apr, 0.25);
  assert.equal(S.change(S.defaults(), { vault_ceil_apr: "25%" }, { via: "chat" }).next.vault_ceil_apr, 0.25);
  assert.match(S.change(S.defaults(), { vault_ceil_apr: "600%" }, { via: "chat" }).msg, /vault_ceil_apr must be 0%\.\.500%/);
});
