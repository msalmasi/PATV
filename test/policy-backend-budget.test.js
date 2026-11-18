// tools/policy-backend.js and the incentive week's daily verdicts: the preflight lines are information for every other hand-over, and a hard gate
// only for the week's own (--for=budget). Pure over the gathered rows, plus one read-only run of the real CLI on a small database.
//   NODE_PATH=G:/PATV/node_modules node --test test/policy-backend-budget.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const repo = path.resolve(__dirname, "..");
const { budgetChecks } = require(path.join(repo, "tools", "policy-backend.js"));

const NOW = Date.UTC(2026, 10, 30, 12);                       // Monday 2026-11-30 12:00 UTC
const day = (i) => new Date(Date.UTC(2026, 10, 30 - i)).toISOString().slice(0, 10);
const rows = (n, f = () => 1) => { const o = []; for (let i = n; i >= 1; i--) o.push({ period: `D${day(i)}`, ok: f(i), blocking: f(i) ? [] : ["spent.beg: site 1 / pepe 2"], attempts: 1 }); return o; };
const line = (res, re) => res.find((x) => re.test(x.check));

test("no rows yet: information only; for the week's own hand-over it fails", () => {
  assert.equal(line(budgetChecks({ budgetShadow: [] }, { now: NOW }), /recorded every day/).level, "INFO");
  assert.equal(line(budgetChecks({ budgetShadow: [] }, { now: NOW, strict: true }), /recorded every day/).level, "FAIL");
});
test("seven clean days and a reconciled closed week pass", () => {
  const s = { budgetShadow: rows(8).concat({ period: "W2026-11-23", ok: 1, blocking: [] }) };
  const r = budgetChecks(s, { now: NOW, strict: true });
  assert.equal(line(r, /recorded every day/).level, "PASS");
  assert.equal(line(r, /drift 0 per group for 7/).level, "PASS");
  assert.equal(line(r, /closed weeks/).level, "PASS");
});
test("an unclean day or a missing day: WARN by default, FAIL with --for=budget, naming the day and the group", () => {
  const bad = { budgetShadow: rows(8, (i) => (i === 3 ? 0 : 1)) };
  const w = line(budgetChecks(bad, { now: NOW }), /drift 0 per group/);
  assert.equal(w.level, "WARN"); assert.match(w.detail, new RegExp(day(3))); assert.match(w.detail, /spent\.beg/);
  assert.equal(line(budgetChecks(bad, { now: NOW, strict: true }), /drift 0 per group/).level, "FAIL");
  const gap = { budgetShadow: rows(8).filter((r) => r.period !== `D${day(2)}`) };
  assert.equal(line(budgetChecks(gap, { now: NOW, strict: true }), /recorded every day/).level, "FAIL");
  assert.match(line(budgetChecks(gap, { now: NOW }), /recorded every day/).detail, new RegExp(day(2)));
  const short = { budgetShadow: rows(3) };
  assert.equal(line(budgetChecks(short, { now: NOW }), /drift 0 per group/).level, "INFO");
  assert.equal(line(budgetChecks(short, { now: NOW, strict: true }), /drift 0 per group/).level, "FAIL");
  const wk = { budgetShadow: rows(8).concat({ period: "W2026-11-23", ok: 0, blocking: ["spent.turf: site 1 / pepe 2"] }) };
  assert.equal(line(budgetChecks(wk, { now: NOW }), /closed weeks/).level, "WARN");
});
test("the real CLI on a site with no shadow rows: the plain preflight doesn't fail on them; --for=budget does", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pb-budget-"));
  fs.writeFileSync(path.join(dir, "myapp.db"), "");
  const run = (extra) => spawnSync(process.execPath, [path.join(repo, "tools", "policy-backend.js"), "preflight", `--dir=${dir}`, "--json", ...extra], { encoding: "utf8", env: process.env, timeout: 60000 });
  const parse = (r) => { const m = /^\[$/m.exec(r.stdout || ""); assert.ok(m, `${r.status} ${r.stderr}`); return JSON.parse(r.stdout.slice(m.index)); };
  const plain = line(parse(run([])), /budget drift recorded/);
  assert.equal(plain.level, "INFO");
  assert.equal(line(parse(run(["--for=budget"])), /budget drift recorded/).level, "FAIL");
});
