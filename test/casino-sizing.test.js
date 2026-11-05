"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseSize, presetTo } = require("../casino/sizing");
const turn = { current_bet: 100, to_call: 50, min_to: 200, max_to: 2000 };
test("raise-TO grammar and pot-after-call sizing", () => {
  for (const [s, to] of [["min",200],["max",2000],["all",2000],["pot",600],["half",350],["75%",475],["3bb",300],["+2bb",300],["2.5x",250],["1k",1000],["0.001m",1000],["1,250",1250]]) {
    assert.deepEqual(parseSize(s, turn, 100, 450), { to }, s);
    assert.deepEqual(presetTo(s, turn, 100, 450), { to }, s);
  }
});
test("clamps to legal totals including a short all-in", () => {
  assert.equal(parseSize("300.9", turn, 100, 450).to, 300, "plain amounts keep the original truncation");
  assert.equal(parseSize("1", turn, 100, 450).to, 200);
  assert.equal(parseSize("100bb", turn, 100, 450).to, 2000);
  assert.equal(parseSize("min", {...turn, max_to:150},100,450).to,150);
});
test("rejects malformed and unsafe amounts", () => {
  for (const s of ["", "NaN", "Infinity", "-1", "3 bb", "1e3", "3bb extra", "1.2.3", "999999999999999999999m"]) assert.ok(parseSize(s,turn,100,450).error,s);
  assert.ok(parseSize("pot",null,100,450).error);
});
test("the exact same module runs in the browser", () => {
  const vm = require("node:vm"), fs = require("node:fs");
  const context = { window: { CZ: {} } };
  vm.runInNewContext(fs.readFileSync(require.resolve("../casino/sizing"),"utf8"),context);
  assert.equal(context.parseSize, undefined, "parser helpers stay private to the shared module");
  assert.equal(context.presetTo, undefined);
  for (const s of ["33%","50%","75%","100%","150%","2.5bb","3bb","4bb","+1bb","+5bb","min","all"]) assert.equal(context.window.CZ.sizing.presetTo(s,turn,100,450).to,presetTo(s,turn,100,450).to);
});
