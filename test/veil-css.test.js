// 1.99aij: veil.css (frog names' text tag, the blacked-out bars of hidden lines) must read on the site's dark page whatever the
// visitor's computer is set to. The site is dark-only (ds.css color-scheme: dark, no light theme); veil.css used to keep its light
// values unless prefers-color-scheme was dark, so on a light-mode computer the bars nearly vanished and the tag read about 2.3:1.
//   node --test test/veil-css.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const css = (f) => fs.readFileSync(path.resolve(__dirname, "..", "public", "css", f), "utf8");

function lum(hex) {
  const n = hex.replace("#", "");
  const c = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const token = (src, name) => { const m = src.match(new RegExp("--" + name + ":\\s*(#[0-9a-fA-F]{6})")); return m && m[1]; };

test("veil.css has one set of values, not one that depends on the computer's light/dark setting", () => {
  const v = css("veil.css");
  assert.equal(/prefers-color-scheme/.test(v), false, "no prefers-color-scheme block");
  assert.equal(/data-theme/.test(v), false, "no data-theme block (the site has no theme switch)");
  assert.equal((v.match(/--veil-tag-ink:/g) || []).length, 1, "the tag ink is defined once");
});

test("the frog-name tag and the hidden-line bars read on the site's dark page", () => {
  const v = css("veil.css"), ds = css("ds.css");
  const bg = token(ds, "ds-bg"), surface = token(ds, "ds-surface");
  assert.ok(bg && surface, "ds.css page colours found");
  const ink = token(v, "veil-tag-ink"), a = token(v, "redact-a"), b = token(v, "redact-b");
  for (const ground of [bg, surface]) {
    assert.ok(contrast(ink, ground) >= 4.5, `tag ink ${ink} on ${ground}: ${contrast(ink, ground).toFixed(2)}:1`);
    assert.ok(contrast(a, ground) >= 3, `bar ${a} on ${ground}: ${contrast(a, ground).toFixed(2)}:1`);
    assert.ok(contrast(b, ground) >= 3, `bar ${b} on ${ground}: ${contrast(b, ground).toFixed(2)}:1`);
  }
});
