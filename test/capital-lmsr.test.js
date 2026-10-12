// Phase 3: the site's LMSR port (capital/lmsr.js) replays the REAL Python AMM (camfrog-bot pepe_amm.py) to the bit.
// test/fixtures/capital-lmsr-vectors.json.gz = tools/gen_lmsr_vectors.py: 300 random markets (2-6 options, integer-like
// option names and nicks included), ~5,900 buys / sells, every option's resolution and the void, the Market maker's
// mark-to-market value. Every float must be === (not "close"), every integer equal.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const zlib = require("zlib");
const X = require(path.join(__dirname, "..", "capital", "lmsr"));

const V = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures", "capital-lmsr-vectors.json.gz"))).toString("utf8"));

function eqMap(a, b, keys, what) {
  for (const k of keys) assert.strictEqual(a[k], b[k], `${what}[${k}]`);
}

test("the vectors are the real thing", () => {
  assert.equal(V.markets.length, 300);
  assert.equal(V.b, X.LIQUIDITY_B);
  assert.equal(V.fee_pct, X.FEE_PCT);
  const sells = V.markets.reduce((t, m) => t + m.steps.filter((s) => s.op === "sell").length, 0);
  assert.ok(sells > 500, "the vectors exercise sells");
});

test("seed, buys, sells, prices and positions match Python bit for bit", () => {
  let trades = 0;
  for (const v of V.markets) {
    const m = { id: v.id, options: v.options.slice(), status: "open", closes: 4e9, positions: {} };
    X.newFields(m, 0);
    assert.strictEqual(m.seed, v.seed, `M${v.id} seed`);
    for (const [i, s] of v.steps.entries()) {
      const w = `M${v.id} step ${i} (${s.op})`;
      if (s.op === "buy") {
        assert.ok(s.ok, w);
        const r = X.applyBuy(m, { nick: s.nick, user: "u_" + s.nick.toLowerCase(), opt: s.option, spend: s.spend, nowS: 0 });
        assert.strictEqual(r.fee, s.fee, `${w} fee`);
        assert.strictEqual(r.shares, s.shares, `${w} shares`);
      } else {
        const plan = X.planSell(m, { nick: s.nick, opt: s.option, want: s.word });
        assert.strictEqual(plan.ok, s.ok, `${w} ok`);
        if (!plan.ok) continue;
        assert.strictEqual(plan.pay, s.pay, `${w} pay`);
        assert.strictEqual(plan.fee, s.fee, `${w} fee`);
        X.applySell(m, plan, { nick: s.nick, opt: s.option, nowS: 0 });
      }
      eqMap(m.q, s.q, v.options, `${w} q`);
      assert.strictEqual(m.pool, s.pool, `${w} pool`);
      eqMap(X.prices(m), s.prices, v.options, `${w} prices`);
      const p = m.positions[s.nick.toLowerCase()];
      eqMap(p.shares, s.pos.shares, Object.keys(s.pos.shares), `${w} pos.shares`);
      eqMap(p.cost, s.pos.cost, Object.keys(s.pos.cost), `${w} pos.cost`);
      trades++;
    }
    assert.strictEqual(m.volume, v.final.volume, `M${v.id} volume`);
    // every resolution: each option and the void
    for (const [r, want] of Object.entries(v.resolve)) {
      const plan = X.resolvePlan(m, r === "void" ? null : r);
      assert.deepStrictEqual(plan.payouts.map(([n, , a]) => [n, a]), want.payouts, `M${v.id} resolve ${r} payouts`);
      assert.strictEqual(plan.leftover, want.leftover, `M${v.id} resolve ${r} leftover`);
      assert.strictEqual(plan.paid, want.paid, `M${v.id} resolve ${r} paid`);
    }
    assert.strictEqual(X.mmValue(m), v.mm_value, `M${v.id} mark-to-market value`);
  }
  assert.ok(trades > 5000);
});

test("the Market maker's book sums the same way", () => {
  let book = 0;
  for (const v of V.markets) {
    const m = { id: v.id, options: v.options.slice(), positions: {} };
    X.newFields(m, 0);
    for (const s of v.steps) {
      if (s.op === "buy") X.applyBuy(m, { nick: s.nick, opt: s.option, spend: s.spend, nowS: 0 });
      else { const p = X.planSell(m, { nick: s.nick, opt: s.option, want: s.word }); if (p.ok) X.applySell(m, p, { nick: s.nick, opt: s.option, nowS: 0 }); }
    }
    book += X.mmValue(m);
  }
  assert.strictEqual(book, V.book_sum);
});

test("Python's float floor division", () => {
  assert.strictEqual(X.pyFloorDiv(199.99999999999997, 100), 1);
  assert.strictEqual(X.pyFloorDiv(200, 100), 2);
  assert.strictEqual(X.pyFloorDiv(0, 100), 0);
  assert.strictEqual(X.pyFloorDiv(12345.678 * 2, 100), 246);
});
