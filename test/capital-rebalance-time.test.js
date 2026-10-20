// 1.99adk: a site rebalance records when it ran (rebalances[tid].done, seconds), so Pepe's staking audit can place it
// on its cut-off by time instead of by prices alone (two cut-offs with equal prices made it "can't place it").
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "capital", "vaults.js"), "utf8");

test("rebalance() stamps done when it marks a rebalance done", () => {
  const body = src.slice(src.indexOf("async function rebalance("), src.indexOf("async function guarded("));
  assert.ok(body.length > 0, "rebalance() found");
  const doneState = body.indexOf('d.rebalances[tid].state = "done"');
  const doneTime = body.indexOf("d.rebalances[tid].done = C.nowS()");
  assert.ok(doneState > 0, "the done state is set");
  assert.ok(doneTime > doneState, "the done time is set right after the done state");
});

test("the core clock it uses is exported", () => {
  const C = require("../capital/core");
  assert.strictEqual(typeof C.nowS, "function");
  const t = C.nowS();
  assert.ok(Math.abs(t - Date.now() / 1000) < 5);
});
