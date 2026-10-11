// Offline tests for the design system (1.99pj): public/css/ds.css, docs/design-system.md, /styleguide, and the
// layout wiring (ds.css before styles.css, real Ubuntu weights).   node --test test/design-system.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
const rd = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");
const css = rd("public", "css", "ds.css");

test("ds.css: balanced braces, tokens on :root, one accent indirection", () => {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal((noComments.match(/\{/g) || []).length, (noComments.match(/\}/g) || []).length, "braces balance");
  assert.doesNotMatch(noComments, /(^|[^:])\/\/ /m, "no // line comments (CSS has none - they eat the next declaration)");
  for (const t of ["--ds-bg", "--ds-surface", "--ds-line", "--ds-text", "--ds-text-muted", "--ds-text-faint", "--ds-gold", "--ds-ac", "--ds-on-ac",
    "--ds-fs-display", "--ds-fs-body", "--ds-sp-4", "--ds-r-xl", "--ds-r-2xl", "--ds-e-3", "--ds-z-modal", "--ds-focus", "--ds-gutter", "--shadow-elevation-1"]) {
    assert.match(css, new RegExp(t.replace(/-/g, "\\-") + ":"), t + " defined");
  }
  // every var(--ds-*) used is defined somewhere in the file (or is a component-local --b-* / --ds-w / --ds-col)
  const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  for (const m of css.matchAll(/var\((--[a-z0-9-]+)/g)) assert.ok(defined.has(m[1]), "defined: " + m[1]);
});

test("ds.css: only ds- classes are styled (old pages unaffected), logical properties, reduced motion", () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@keyframes[^{]+\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, "");
  for (const m of rules.matchAll(/(^|\})\s*([^{}@]+)\{/g)) {
    const sel = m[2].trim();
    if (!sel || /^(from|to|\d+%)/.test(sel)) continue;
    const ok = /^:root/.test(sel) || sel === "html" || sel === "body" || /\.ds-|\.sr-only|\[class\*="ds-"\]/.test(sel);
    assert.ok(ok, "selector scoped to ds-: " + sel);
  }
  assert.doesNotMatch(rules, /(^|[^-])(margin|padding)-(left|right)\s*:/, "logical margins/paddings only");
  assert.doesNotMatch(rules, /[{;]\s*(left|right)\s*:/, "inset-inline-* instead of left/right");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\[class\*="ds-"\]/);
  assert.match(css, /\.ds-in\.ds-in, \.ds-select\.ds-select, \.ds-textarea\.ds-textarea \{/, "fields outrank styles.css's legacy input rule");
  assert.match(css, /--ds-on-ac: #04150a/, "dark ink on the green fill (white is 2.8:1)");
});

test("layout: ds.css loads before styles.css, Ubuntu 400/500/700 in one fonts request, theme colour = header", () => {
  const layout = rd("views", "layout.ejs");
  const ds = layout.indexOf("/public/css/ds.css?v="), st = layout.indexOf("/public/css/styles.css?v=");
  assert.ok(ds > 0 && st > ds, "ds.css first");
  assert.match(layout, /family=Press\+Start\+2P&family=Ubuntu:ital,wght@0,400;0,500;0,700;1,400&display=swap/);
  assert.doesNotMatch(layout, /css\?family=Ubuntu"/, "the old 400-only link is gone");
  assert.match(layout, /<meta name="theme-color" content="#18181b">/);
  // RTL: the shell's popovers / badge / search icon use logical insets
  for (const r of [/\.nav-more \.nav-pop \{ inset-inline-start: 0; \}/, /\.nav-burger \.nav-pop \{ inset-inline-end: 0; \}/, /\.nav-badge \{[^}]*inset-inline-end: 0;/, /\.nav-s-ic \{[^}]*inset-inline-start: 11px;/]) assert.match(layout, r);
  assert.match(layout, /e\.key !== 'Escape'/, "Esc closes the menus");
});

test("styles.css: the // comments and the broken nested comment are gone", () => {
  const s = rd("public", "css", "styles.css");
  assert.doesNotMatch(s, /;\s*\/\/ /, "no // comments");
  assert.doesNotMatch(s, /\} \*\//, "no stray '} */'");
  assert.match(s, /\* \{ scrollbar-width: thin;/);
});

test("/styleguide renders every token group and the main components", async () => {
  const sg = require(path.join(repo, "styleguide"));
  const html = await ejs.renderFile(path.join(repo, "views", "styleguide.ejs"), { title: "Design system · PATV", user: null, ...sg });
  for (const cls of ["ds-hero", "ds-btn gold", "ds-chip live", "ds-tabs", "ds-card", "ds-stats", "ds-in", "ds-select", "ds-tbl", "ds-note warn", "ds-empty", "ds-modal", "ds-pat", "ds-bar", "ds-av", "ds-pager"]) {
    assert.ok(html.includes(cls), cls);
  }
  for (const names of Object.values(sg.TOKENS)) for (const n of names) {
    assert.ok(html.includes('data-token="' + n + '"'), n);
    assert.match(css, new RegExp(n.replace(/-/g, "\\-") + ":"), n + " exists in ds.css");
  }
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, "one h1 - the examples use the classes on divs");
});

test("the spec exists and documents the tokens it promises", () => {
  const doc = rd("docs", "design-system.md");
  for (const s of ["--ds-surface", "--ds-gold", "--ds-on-ac", ".ds-btn", ".ds-ic", "tabular-nums", "prefers-reduced-motion", "inset-inline-start", "/styleguide"]) assert.ok(doc.includes(s), s);
});
