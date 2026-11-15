"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const grammar = require("../casino/rlbets");
const browser = vm.createContext({});
vm.runInContext(fs.readFileSync(require.resolve("../casino/rlbets"), "utf8"), browser);
vm.runInContext(fs.readFileSync(require.resolve("../public/js/patamount"), "utf8"), browser);
for (const [env, g] of [
  ["browser", browser.PATVRlBets],
  ["node", grammar],
]) {
  test(env + " recognizes every spelling and returns re-parseable positions", () => {
    const valid = [
      ["0", "0"],
      ["st17", "16-17-18"],
      ["ln1", "1-2-3-4-5-6"],
      ["ｃ３", "c3"],
      ["2nd12", "d2"],
      ["col2", "c2"],
      ["⚫", "black"],
      ["🔴", "red"],
      ["1-12", "d1"],
      ["13-24", "d2"],
      ["25-36", "d3"],
      ["1-18", "low"],
      ["19-36", "high"],
      ["17—14", "14-17"],
      ["17/18", "17-18"],
      ["1-0-2-3", "0-1-2-3"],
    ];
    for (const [source, want] of valid) assert.equal(g.parse(source + " 100").bets[0].token, want);
    for (const b of Object.values(g.positions))
      assert.equal(g.parse(g.token(b) + " 100").bets[0].token, b.token);
    assert.deepEqual(
      Array.from(g.parse("7,17,27 1,000 17 1.5m red 25k").bets, (x) => [x.token, x.amount]),
      [
        ["7", 1000],
        ["17", 1501000],
        ["27", 1000],
        ["red", 25000],
      ],
    );
  });
  test(env + " refuses the complete line and returns a helpful correction", () => {
    for (const [s, re] of [
      ["500 red", /red 500/],
      ["17", /17 100/],
      ["17 18", /17-18 100/],
      ["17-19 100", /14-17/],
      ["00 100", /single zero/i],
      ["red 100 j 200", /unknown bet/i],
      ["red 100 red", /how much/i],
      ["red 0.1", /minimum/i],
      ["green 100", /unknown/i],
      ["12,000 100", /invalid list/i],
      ["3-4 100", /invalid combination/i],
      ["2-3-4 100", /invalid combination/i],
      ["ln36 100", /unknown/i],
    ]) {
      const r = g.parse(s);
      assert.equal(r.ok, false, s);
      assert.match(r.error + " " + r.hint, re, s);
      assert.equal(r.bets, undefined);
    }
    assert.equal(g.parse("red 100 ".repeat(7)).ok, false);
    assert.equal(g.parse("red 100 ".repeat(20), { maxPairs: 20 }).bets[0].amount, 2000);
    assert.equal(g.parse("red 100 ".repeat(21), { maxPairs: 20 }).ok, false);
    assert.equal(g.parse("red ".padEnd(161, " ") + "100").ok, false);
  });
}
