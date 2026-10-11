// 1.99nk: one PAT-amount parser for typed amounts (public/js/patamount.js, Pepe's pepe_amount rules), used by the
// server (markets, bounties, stashes, boosts) and the browser (pad boost, market estimate). The PAT forms that used
// <input type=number> (which can't hold "1,000,000") are text inputs with a matching pattern now.
//   node --test test/patamount.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const P = require(path.join(repo, "public", "js", "patamount"));

test("the parser: commas, underscores, k/m/b, decimals; junk and non-grouping commas are NaN", () => {
  const good = { "1000000": 1e6, "1,000,000": 1e6, "1_000_000": 1e6, "5,000": 5000, "5k": 5000, "5K": 5000, "1.5k": 1500,
                 "2m": 2e6, "1.5M": 1.5e6, "2,500k": 2.5e6, "1b": 1e9, "1.1m": 1100000, "0.29k": 290, " 7,500 ": 7500,
                 "12,345.6": 12345, ".5k": 500, "0": 0 };
  for (const [s, v] of Object.entries(good)) assert.equal(P.parse(s), v, s);
  for (const s of ["", "k", "abc", "5kk", "1,2,3", "10,00", "1,0000", ",000", "1,", "5 k", "-5", "1e6", "1..5", "1,000,00", "9".repeat(40)]) {
    assert.ok(Number.isNaN(P.parse(s)), "not an amount: " + JSON.stringify(s));
  }
  assert.equal(P.parse(2500), 2500, "a number passes through");
  assert.ok(Number.isNaN(P.parse(-1)));
  assert.ok(Number.isNaN(P.parse(null)) && Number.isNaN(P.parse(undefined)));
});

test("the HTML pattern accepts what the parser accepts (whole-value match, as browsers apply it)", () => {
  const re = new RegExp("^(?:" + P.PATTERN + ")$");
  for (const s of ["1,000,000", "5000", "5k", "1.5m", " 2,500 "]) assert.ok(re.test(s), s);
  for (const s of ["1,2,3", "abc", "5kk"]) assert.ok(!re.test(s), s);
});

test("it loads in the browser as window.PATVAmount", () => {
  const ctx = { self: {} };
  ctx.self = ctx;
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "patamount.js"), "utf8"), ctx);
  assert.equal(ctx.PATVAmount.parse("1,000,000"), 1e6);
});

test("server + forms use it: no PAT amount form is type=number any more; stashes / markets / bounties / boosts parse with it", () => {
  const S = require(path.join(repo, "stashes"));
  const src = (f) => fs.readFileSync(path.join(repo, f), "utf8");
  assert.match(src("stashes.js"), /require\("\.\/public\/js\/patamount"\)\.parse\(raw\)/);
  assert.match(src("markets.js"), /const amount = PATAmount\.parse\(\(req\.body \|\| \{\}\)\.amount\) \|\| 0;/);
  assert.match(src("bounties.js"), /amount = require\("\.\/public\/js\/patamount"\)\.parse\(body\.amount\) \|\| 0;/);
  assert.match(src("boosts.js"), /typeof opts\.amount === "string" \? require\("\.\/public\/js\/patamount"\)\.parse\(opts\.amount\)/);
  assert.match(src("public/js/pad-boost.js"), /window\.PATVAmount \? window\.PATVAmount\.parse\(input\.value\)/);
  const forms = { "views/room.ejs": /name="amount"/, "views/market.ejs": /name="amount"/, "views/bounty.ejs": /name="amount"/,
                  "views/bounties.ejs": /name="a1" /, "views/wagers.ejs": /name="a[12]" /};
  for (const [f, re] of Object.entries(forms)) {
    // line-based (an EJS tag's "%>" would end a naive <input ...> match early)
    const inputs = src(f).split("\n").filter((x) => /<input/.test(x) && re.test(x) && /inputmode="numeric"/.test(x));
    assert.ok(inputs.length, f + ": the amount input");
    for (const x of inputs) assert.match(x, /type="text".*pattern="/, f + ": " + x.slice(0, 80));
  }
  assert.match(src("views/room.ejs"), /<script src="\/public\/js\/patamount\.js\?v=1" defer><\/script><script src="\/public\/js\/pad-boost\.js\?v=2" defer>/);
  assert.match(src("views/market.ejs"), /<script src="\/public\/js\/patamount\.js\?v=1"><\/script>/);
  if (typeof S.parseAmount === "function") assert.equal(S.parseAmount("1,000,000"), 1e6);
});
