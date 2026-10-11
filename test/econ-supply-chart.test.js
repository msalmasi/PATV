// /economy supply history charts: total-supply ticks read differently on nearly flat data, the made/burned bars sit
// inside the plot (one slot per day, clipped) with 1, 2 or 90 days of data, and the burned side is labelled below zero.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const ejs = require("ejs");

const repo = path.join(__dirname, "..");
const view = path.join(repo, "views", "economy.ejs");
const opts = { views: [path.join(repo, "views")] };

const day = (i) => new Date(Date.UTC(2026, 6, 1) + i * 864e5).toISOString().slice(0, 10);
const rows = (n, f) => Array.from({ length: n }, (_, i) => Object.assign({ day: day(i), total: 1062e6 + i * 1000, fed: 100e6, floor: 25e6,
  ceiling: 150e6, minted: 0, burned: 0, mints: {} }, f ? f(i) : {}));
// the real live-section shape (econpage.live), with the history swapped in
const render = async (history) => {
  const live = await require(path.join(repo, "econpage")).live({});
  return ejs.renderFile(view, { user: null, treasury: null, roomVaults: null, ogBase: "http://t", live: Object.assign({}, live, { history }) }, opts);
};

// the SVG of the chart whose title key renders as `title`
const svgAfter = (html, title) => {
  const at = html.indexOf(title);
  assert.ok(at > 0, "chart missing: " + title);
  const s = html.indexOf("<svg", at), e = html.indexOf("</svg>", s);
  return html.slice(s, e);
};
const yLabels = (svg) => [...svg.matchAll(/<text class="yl"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
const X0 = 80, X1 = 632;

test("total supply: nearly flat data still gets distinct y-axis labels", async () => {
  const html = await render(rows(2, (i) => ({ total: 1062345678 + i * 20000 })));
  const ls = yLabels(svgAfter(html, "Total supply"));
  assert.ok(ls.length >= 3, "a few ticks: " + ls);
  assert.equal(new Set(ls).size, ls.length, "labels differ: " + ls.join(", "));
  assert.ok(ls.every((l) => /^1\.06\d+B$/.test(l)), "billions with extra precision: " + ls.join(", "));
  // perfectly flat too
  const flat = yLabels(svgAfter(await render(rows(3, () => ({ total: 1062e6 }))), "Total supply"));
  assert.equal(new Set(flat).size, flat.length, "flat labels differ: " + flat.join(", "));
  // staging's sandbox supply is in the quadrillions: short labels in Q, still distinct
  const huge = yLabels(svgAfter(await render(rows(1, () => ({ total: 30.25e15 }))), "Total supply"));
  assert.equal(new Set(huge).size, huge.length, "huge labels differ: " + huge.join(", "));
  assert.ok(huge.every((l) => /^\d+\.\d+Q$/.test(l) && l.length <= 8), "short Q labels: " + huge.join(", "));
});

for (const n of [1, 2, 90]) {
  test(`made/burned bars stay inside the plot with ${n} day(s)`, async () => {
    const html = await render(rows(n, (i) => ({ minted: 5e6 + i, burned: i % 2 ? 67.5e6 : 3e6 })));
    const svg = svgAfter(html, "Made and burned each day");
    assert.match(svg, /<clipPath id="shFlowClip">/);
    assert.match(svg, /<g class="bars" clip-path="url\(#shFlowClip\)">/);
    const bars = svg.slice(svg.indexOf('<g class="bars"'), svg.indexOf("</g>"));
    const rects = [...bars.matchAll(/<rect x="([\d.-]+)" y="([\d.-]+)" width="([\d.]+)" height="([\d.]+)"/g)].map((m) => m.slice(1).map(Number));
    assert.equal(rects.length, n * 2, "one made + one burned bar per day");
    for (const [x, y, w, h] of rects) {
      assert.ok(x >= X0 && x + w <= X1 + 0.05, `bar inside the plot: x=${x} w=${w}`);
      assert.ok(w <= (X1 - X0) / n + 0.05, "no wider than its day slot");
      assert.ok(y >= 4 && y + h <= 108.05, "vertically inside");
    }
    const ls = yLabels(svg);
    const top = n === 1 ? "5M" : "67.5M";
    assert.equal(ls[1], "0");
    assert.equal(ls[0], top);
    assert.equal(ls[2], "−" + top, "burned side carries a minus sign");
  });
}

test("no history: the placeholder, not a chart", async () => {
  const html = await render([]);
  assert.match(html, /The daily supply record starts/);
});
