// The styleguide hub + brand guide (1.99qa): docs/brand.md, mdlite.js (the safe markdown renderer), styleguide.js
// routes and views/styleguide-hub.ejs, the hub chrome strings in en.json.   node --test test/brand-hub.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
const rd = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");
const md = require(path.join(repo, "mdlite"));
const sg = require(path.join(repo, "styleguide"));

test("mdlite escapes raw HTML and only allows safe links", () => {
  const { html } = md.render('# Hi <img src=x onerror=alert(1)>\n\nA <script>alert(1)</script> [x](javascript:alert(1)) [y](/ok) [z](https://e.com) [d](design-system.md)\n\n```\n<b>\n```');
  assert.doesNotMatch(html, /<script|<img/);
  assert.doesNotMatch(html, /href="javascript/i);
  assert.match(html, /href="\/ok"/);
  assert.match(html, /href="https:\/\/e\.com" rel="noopener" target="_blank"/);
  assert.match(html, /github\.com\/msalmasi\/PATV\/blob\/staging\/docs\/design-system\.md/);
  assert.match(html, /<pre><code>&lt;b&gt;<\/code><\/pre>/);
});

test("mdlite renders headings with ids, tables, lists, task lists and quotes", () => {
  const { html, toc } = md.render("## 1. One\n\n### Sub `code`\n\n| a | b |\n|---|---|\n| `x\\|y` | **b** |\n\n- one\n  - nested\n- two\n\n- [ ] task\n\n> quote");
  assert.match(html, /<h2 id="1-one">1\. One<\/h2>/);
  assert.match(html, /<h3 id="sub-code">Sub <code>code<\/code><\/h3>/);
  assert.match(html, /<table>.*<code>x\|y<\/code>.*<strong>b<\/strong>/s);
  assert.match(html, /<li>one<ul><li>nested<\/li><\/ul><\/li>/);
  assert.match(html, /class="md-tasks".*☐/s);
  assert.match(html, /<blockquote><p>quote<\/p><\/blockquote>/);
  assert.deepEqual(toc.map((h) => h.id), ["1-one", "sub-code"]);
});

test("brand.md has the six numbered sections the hub tabs split on, and links the design system", () => {
  const doc = rd("docs", "brand.md");
  const nums = md.sections(doc).map((s) => s.n).filter((n) => n);
  assert.deepEqual(nums, [1, 2, 3, 4, 5, 6]);
  for (const s of ["design-system.md", "no cash value", "Family terms", "DM privacy", "Be funny first", "Naming an achievement", "Writing a Pepe line"]) assert.ok(doc.includes(s), s);
  for (const tab of ["brand", "pepe", "writing"]) assert.ok(sg.brandTab(tab).html.length > 1000, tab + " tab has content");
  assert.ok(rd("docs", "design-system.md").includes("brand.md"), "design-system.md points at brand.md");
  assert.ok(rd("docs", "README.md").includes("brand.md") && rd("docs", "README.md").includes("design-system.md"));
});

test("hub views render every tab, with the tab nav and the hub strings", async () => {
  const en = JSON.parse(rd("locales", "en.json"));
  for (const k of ["sg.hub.tab.home", "sg.hub.tab.brand", "sg.hub.tab.design", "sg.hub.tab.pepe", "sg.hub.tab.writing", "sg.hub.toc", "sg.hub.looks.h"]) assert.ok(en[k], k);
  for (const tab of ["home", "brand", "pepe", "writing"]) {
    const html = await ejs.renderFile(path.join(repo, "views", "styleguide-hub.ejs"), {
      title: "x", user: null, tab, doc: tab === "home" ? null : sg.brandTab(tab), looks: tab === "pepe" ? sg.pepeLooks() : [] });
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, tab + ": one h1");
    assert.match(html, /class="ds-tab on" href="\/styleguide(\/\w+)?" aria-current="page"/, tab + ": current tab");
    assert.ok(html.includes('href="/styleguide/design"'), tab + ": links the design system");
    if (tab === "pepe") assert.match(html, /pepe-looks\/base-pixel\.png/);
    if (tab === "home") assert.match(html, /location\.replace\('\/styleguide\/design#'/);
  }
  const design = await ejs.renderFile(path.join(repo, "views", "styleguide.ejs"), { title: "x", user: null, ...sg });
  assert.match(design, /class="ds-tab on" href="\/styleguide\/design" aria-current="page"/);
});

test("routes: /styleguide hub, /styleguide/{brand,design,pepe,writing}, all noindex", () => {
  const routes = {};
  sg.register({ get: (p, _mw, h) => { routes[p] = h; } }, { addUser: () => {} });
  assert.deepEqual(Object.keys(routes).sort(), ["/styleguide", "/styleguide/brand", "/styleguide/design", "/styleguide/pepe", "/styleguide/writing"]);
  for (const [p, h] of Object.entries(routes)) {
    const hdr = {}; let view = null;
    h({ user: null }, { set: (k, v) => { hdr[k] = v; }, render: (v) => { view = v; } });
    assert.equal(hdr["X-Robots-Tag"], "noindex", p);
    assert.equal(view, p === "/styleguide/design" ? "styleguide" : "styleguide-hub", p);
  }
});
