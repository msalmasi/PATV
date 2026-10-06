// 1.99by: vault APR on /staking. Pepe sends apr null until a vault has the window's history, plus
// the plain return so far ({r, days}) and the Market maker's book ({seeds, value}); clean() keeps them
// and the page shows "Return so far" instead of a wildly annualised figure.
//   node --test test/staking-apr.test.js      (needs the repo's node_modules; temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "staking-apr-test-"));
process.chdir(tmp);
const staking = require(path.join(repo, "staking.js"));
const ejs = require("ejs");

const body = {
  prices: { bank: 1, house: 0.87, mm: 0.988, auto: 1.003 },
  nav: { bank: 5215085, house: 15728678, mm: 975255 },
  staked: { bank: 210000, house: 54000, mm: 33800 },
  apr: { bank: { 7: null, 30: null }, house: { 7: null, 30: null }, mm: { 7: null, 30: null }, auto: { 7: 0.12, 30: null } },
  so_far: { bank: { r: 0.000976, days: 1.0 }, house: null, mm: { r: -0.0137, days: 1.0 }, auto: { r: "x", days: 1 } },
  mm_book: { seeds: 317814, value: 254761.4 },
  targets: { bank: 0.7, house: 0.18, mm: 0.12 },
  settings: {}, epochs: [], positions: {}, queue: [],
};

test("clean keeps so_far and mm_book, drops junk", () => {
  const c = staking.clean(body);
  assert.deepEqual(c.so_far.bank, { r: 0.000976, days: 1 });
  assert.deepEqual(c.so_far.mm, { r: -0.0137, days: 1 });
  assert.equal(c.so_far.house, null);
  assert.equal(c.so_far.auto, null);              // non-numeric r
  assert.deepEqual(c.mm_book, { seeds: 317814, value: 254761.4 });
  assert.equal(c.apr.mm[7], null);
  assert.equal(c.apr.auto[7], 0.12);
  assert.equal(staking.clean({}).mm_book, null);  // an older Pepe without the field
});

test("page shows the return so far while APR is null", async () => {
  const snap = staking.clean(body);
  const file = path.join(repo, "views", "staking.ejs");
  const src = fs.readFileSync(file, "utf8");
  // the same locals the /staking route passes
  const html = ejs.render(src, {
    user: null, signedIn: false, camfrog: null, msg: null, acts: [], now: Date.now() / 1000, snap, mine: [],
    chart: staking.chart(snap.epochs || []),
    rev: [staking.revenue(snap.epochs || [], 7), staking.revenue(snap.epochs || [], 30)].filter(Boolean),
    pending: [],
  }, { filename: file });
  assert.match(html, /Return so far/);
  assert.match(html, /-1\.37%/);
  assert.match(html, /Seeds in markets/);
  assert.match(html, /317,814/);
  assert.match(html, /12\.0%/);                    // auto's real 7d APR still shows
  assert.doesNotMatch(html, /e\+\d+%/);
});
