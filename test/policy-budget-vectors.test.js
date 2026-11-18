// The incentive week (policy/budget.js, policy/budgetshadow.js) replays Pepe's REAL Python (camfrog-bot tools/gen_budget_vectors.py ->
// test/fixtures/policy-budget-vectors.json.gz, byte-identical with the bot's ci/fixtures/ copy, sha256 pinned here and there), 0 differences:
//   maps    the flow / group tables          left    the week record, what each group may still spend, uncapped groups
//   spend   a week through ordered counts    fund    the paying vault, the Fed guard, the House gap, the balance and budget checks
//   groups  which group a website claim counts in   block   the funding sync's block   ledger  the leg classifier's sum = Pepe's spent
//   PEPE_BOT_DIR=<camfrog-bot checkout> also compares the bot's copies byte for byte.
//   NODE_PATH=G:/PATV/node_modules node --test test/policy-budget-vectors.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "budget-vectors-")));
process.env.SECRET_KEY = "test-secret";
const E = require(path.join(repo, "policy", "engines"));
const B = require(path.join(repo, "policy", "budget"));
const SH = require(path.join(repo, "policy", "budgetshadow"));
const FUND = require(path.join(repo, "funding"));

const FIX = path.join(__dirname, "fixtures", "policy-budget-vectors.json.gz");
// Update together with camfrog-bot's copy: python tools/gen_budget_vectors.py prints the new sha.
const PIN = "43c6dd9c10e19dff53e03b7b71c8228fcfbac8607e13bac491b8bf6425741070";
const RAW = fs.readFileSync(FIX);
const data = JSON.parse(zlib.gunzipSync(RAW).toString("utf8"));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

function same(a, b, where, diffs) {
  if (typeof a === "number" && typeof b === "number") { if (a !== b) diffs.push(`${where}: ${a} !== ${b}`); return; }
  if (a === null || b === null || a === undefined || b === undefined || typeof a !== "object" || typeof b !== "object") {
    if (a !== b && !((a === null || a === undefined) && (b === null || b === undefined))) diffs.push(`${where}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
    return;
  }
  if (Array.isArray(a) !== Array.isArray(b)) { diffs.push(`${where}: array vs object`); return; }
  if (Array.isArray(a)) {
    if (a.length !== b.length) diffs.push(`${where}: length ${a.length} !== ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) same(a[i], b[i], `${where}[${i}]`, diffs);
    return;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) same(a[k], b[k], `${where}.${k}`, diffs);
}
const noDiff = (diffs) => assert.equal(diffs.length, 0, `${diffs.length} differences, first: ${diffs.slice(0, 8).join("\n")}`);

test("the fixture is the pinned one (and the bot's copy, when given)", () => {
  assert.equal(sha(RAW), PIN);
  if (process.env.PEPE_BOT_DIR) assert.ok(RAW.equals(fs.readFileSync(path.join(process.env.PEPE_BOT_DIR, "ci", "fixtures", "policy-budget-vectors.json.gz"))));
});

test("maps: the flow and group tables are Pepe's", () => {
  const m = data.maps, d = [];
  same(Object.assign({}, B.GRANT_FLOWS), m.GRANT_FLOWS, "GRANT_FLOWS", d);
  same(Object.assign({}, B.BOT_FLOWS), m.BOT_FLOWS, "BOT_FLOWS", d);
  same(Object.assign({}, B.ACTIVITY_FLOWS), m.ACTIVITY_FLOWS, "ACTIVITY_FLOWS", d);
  same(Object.assign({}, B.CLAIM_GROUPS), m.CLAIM_GROUPS, "CLAIM_GROUPS", d);
  same([...B.UNGROUPED].sort(), m.UNGROUPED_CLAIMS, "UNGROUPED", d);
  same([...E.PACED].sort(), m.PACED, "PACED", d);
  same([...E.UNCAPPABLE].sort(), m.UNCAPPABLE, "UNCAPPABLE", d);
  same(Object.keys(E.BUDGETS).sort(), Object.keys(m.BUDGETS).sort(), "BUDGETS", d);
  noDiff(d);
  assert.deepEqual(m.FORTKNOX_PAYOUTS, [], "a Fort Knox payout list would need the same rule in resolveVault");
  for (const [f, g] of Object.entries(B.BOT_FLOWS)) assert.equal(B.SPEND_FLOWS[f].group, g);
  assert.equal(B.SPEND_FLOWS.activity_rewards.vault, "incentives");
});

test("left: the week by the clock, each group's room, the uncapped groups, a flow's room", () => {
  const d = [];
  assert.ok(data.left.length >= 300);
  for (const [i, x] of data.left.entries()) {
    const inp = x.inputs, c = E.C(inp), w = B.weekOfInputs(inp, c, inp.now), ex = x.expected;
    const at = `left[${i}]`;
    same(w.id, ex.week.id, `${at}.id`, d);
    same(w.budgets, ex.week.budgets, `${at}.budgets`, d);
    same(w.spent, Object.fromEntries(E.GROUPS.map((g) => [g, ex.week.spent[g] || 0])), `${at}.spent`, d);
    same(w.remaining, ex.left, `${at}.left`, d);
    same(w.uncapped, ex.uncapped, `${at}.uncapped`, d);
    for (const [f, v] of Object.entries(ex.flow_left)) same(B.groupOfSpend(f) ? w.remaining[B.groupOfSpend(f)] : null, v, `${at}.flow.${f}`, d);
  }
  noDiff(d);
});

test("spend: ordered checks and counts across time and a rollover", () => {
  const d = [];
  for (const [i, x] of data.spend.entries()) {
    const inp = JSON.parse(JSON.stringify(x.inputs));
    const c = E.C(inp);
    for (const [j, s] of x.steps.entries()) {
      inp.week = E.resolveWeek(inp, c, s.t);
      const g = B.groupOfSpend(s.flow);
      let ok = null;
      if (s.op === "ok") ok = !g || s.amount <= E.budgetLeft(inp, c, g, s.t);
      else if (g) inp.week.spent[g] = Math.max(0, E.pyInt(inp.week.spent[g] || 0) + (s.op === "spend" ? s.amount : -s.amount));
      same(ok, s.ok, `spend[${i}][${j}].ok`, d);
      same(inp.week.id, s.week.id, `spend[${i}][${j}].id`, d);
      same(E.resolveWeek(inp, c, s.t).spent, Object.assign(Object.fromEntries(E.GROUPS.map((k) => [k, 0])), s.week.spent), `spend[${i}][${j}].spent`, d);
    }
  }
  noDiff(d);
});

test("fund: the paying vault, the Fed guard, the House cover, the balance and budget checks", () => {
  const d = [];
  const seen = new Set();
  for (const [i, x] of data.fund.entries()) {
    const inp = x.inputs, c = E.C(inp), ex = x.expected, now = inp.now, spec = B.SPEND_FLOWS[x.flow], at = `fund[${i}] ${x.flow}`;
    const vault = B.resolveVault(x.flow, spec, x.shares, inp.flags);
    same(vault, ex.vault, `${at}.vault`, d);
    let ok = !B.fedGuarded(vault, inp.flags);
    let gap = 0, cash = vault === "jackpot" ? inp.jackpot : E.pyInt(inp.pools[vault]);
    if (ok && vault === "jackpot") {
      const g = B.houseGap(x.amount, Math.max(0, cash), E.pyInt(c.k("HOUSE_MIN_CASH")));
      if (g > 0 && B.flashHouseOn(c, inp.flags)) { gap = g; if (x.flash_ok) cash += g; }
    }
    if (ok && cash < x.amount + x.keep) ok = false;
    const group = vault === "incentives" ? spec.group : null;
    if (ok && group && x.amount > E.budgetLeft(inp, c, group, now)) ok = false;
    same(ok, ex.ok, `${at}.ok`, d);
    same(gap, ex.gap, `${at}.gap`, d);
    same(ok ? x.amount : 0, ex.debit, `${at}.debit`, d);
    same(ok && group ? x.amount : 0, ex.count, `${at}.count`, d);
    seen.add(`${vault}:${ok}`);
  }
  noDiff(d);
  for (const k of ["incentives:true", "incentives:false", "reserve:false", "jackpot:true", "fortknox:true"]) assert.ok(seen.has(k), `no ${k} case`);
});

test("groups: where each website claim counts", () => {
  assert.ok(data.groups.length >= 10);
  for (const x of data.groups) { assert.ok(x.settled, x.flow); assert.equal(B.groupOfClaim(x.flow), x.group, x.flow); }
});

test("block: the funding sync's incentives block (after the site's own clean-up)", () => {
  const d = [];
  for (const [i, x] of data.block.entries()) {
    const inp = x.inputs, c = E.C(inp);
    const raw = B.blockOfInputs(inp, c, inp.now);
    same(raw, x.expected, `block[${i}].raw`, d);
    same(FUND.cleanIncentives(raw), FUND.cleanIncentives(x.expected), `block[${i}].clean`, d);
  }
  noDiff(d);
});

test("ledger: the classifier's sum of the pool legs = Pepe's own count; a dropped, extra or unknown leg shows", () => {
  const d = [];
  let mutated = 0;
  for (const [i, x] of data.ledger.entries()) {
    const opt = { fromMs: x.from_ms, toMs: x.from_ms + E.WEEK * 1000, doc: {}, nowMs: x.now_ms };
    const r = SH.siteWeek(x.legs, opt);
    same(r.spent, x.spent, `ledger[${i}]`, d);
    same(r.unmapped, [], `ledger[${i}].unmapped`, d);
    const victim = r.events.find((e) => !e.back && e.delta > 0 && !r.events.some((o) => o.back && o.group === e.group));
    if (victim) {
      mutated++;
      const dropped = SH.siteWeek(x.legs.filter((l) => l.move_key !== victim.key), opt);
      assert.equal(SH.driftOf(x.spent, dropped.spent)[victim.group], victim.delta, `ledger[${i}] dropped leg`);
    }
    const extra = x.legs.concat({ move_key: "pv-extra", amount: -7, ts: x.from_ms + 5, kind: "move", flow: "beg", why: "beg" });
    if (!r.events.some((e) => e.back && e.group === "roomgames")) assert.equal(SH.driftOf(x.spent, SH.siteWeek(extra, opt).spent).roomgames, -7, `ledger[${i}] extra leg`);
    const unknown = x.legs.concat({ move_key: "pv-new", amount: -9, ts: x.from_ms + 6, kind: "move", flow: "brand_new", why: "brand_new" });
    assert.equal(SH.siteWeek(unknown, opt).unmapped.length, 1, `ledger[${i}] unknown leg`);
  }
  noDiff(d);
  assert.ok(mutated > 20);
});
