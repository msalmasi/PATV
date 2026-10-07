// Offline tests for the site navbar (views/layout.ejs, 1.99ej): no leftover paid-featuring copy
// ("get featured" - replaced by 🚀 Boost in 1.99ee) and the narrow-phone fit rules stay in place.
//   node --test test/navbar.test.js      (needs the repo's node_modules)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
const layout = path.join(repo, "views", "layout.ejs");
const nav = (html) => {
  const m = /<nav class="navbar">[\s\S]*?<\/nav>/.exec(html);
  assert.ok(m, "navbar rendered");
  return m[0];
};
const render = (locals) => ejs.renderFile(layout, Object.assign({ title: "T", ogPath: "/p/somepad" }, locals));

test("navbar has no 'get featured' text, signed in or out", async () => {
  for (const locals of [{}, { user: "someuser", dmUnread: 3, inboxUnread: 120 }]) {
    const n = nav(await render(locals));
    assert.doesNotMatch(n, /get featured/i);
    assert.match(n, /title="Go live: stream to a pad's stage"/);
  }
});

test("layout source has no 'get featured' text at all", () => {
  assert.doesNotMatch(fs.readFileSync(layout, "utf8"), /get featured/i);
});

test("signed-in navbar keeps the bell and avatar, and has the narrow-phone fit rules", async () => {
  const n = nav(await render({ user: "someuser" }));
  assert.match(n, /id="navBell"/);
  assert.match(n, /id="userAvatar"/);
  const src = fs.readFileSync(layout, "utf8");
  assert.match(src, /@media \(max-width: 500px\) \{ \.nav-golive \.lb, \.nav-post \.lb \{ display: none; \}/);
  // 1.99ek: icon-only they're equal squares (34px; 32px under 420px)
  assert.match(src, /@media \(max-width: 500px\) \{[^\n]*\.navbar a\.nav-post, \.navbar a\.nav-golive \{ width: 34px; min-width: 0; padding: 0; \}/);
  assert.match(src, /@media \(max-width: 420px\) \{[\s\S]*?\.navbar a\.nav-post, \.navbar a\.nav-golive \{ width: 32px; height: 32px; \}/);
  assert.match(src, /@media \(max-width: 420px\) \{\s*\.navbar \{ padding: 10px 8px; gap: 6px; \}/);
  // the narrow block must come after the 760px block, or its .navbar padding wins
  assert.ok(src.indexOf(".navbar { padding: 10px 8px;") > src.indexOf("@media (max-width: 760px)"));
});

test("Post and Go live share one pill base: same height, padding, font, radius, min-width and icon box (1.99ek)", async () => {
  const src = fs.readFileSync(layout, "utf8");
  const base = /\.navbar a\.nav-post, \.navbar a\.nav-golive \{([^}]*)\}/.exec(src);
  assert.ok(base, "one shared rule for both");
  for (const d of ["height: 34px", "min-width: 104px", "padding: 0 14px", "border-radius: 999px", "font: bold 14px/1 Ubuntu, sans-serif", "border: 1px solid transparent", "box-sizing: border-box"]) {
    assert.ok(base[1].includes(d), "shared: " + d);
  }
  // only colours in the per-button rules - no size / padding / font that would make them differ
  for (const cls of ["nav-post", "nav-golive"]) {
    const own = new RegExp("^\\s*\\.navbar a\\." + cls + " \\{([^}]*)\\}", "m").exec(src);
    assert.ok(own, cls + " has its colour rule");
    assert.doesNotMatch(own[1], /padding|font|height|width|border-radius/, cls + " only sets colours");
  }
  assert.match(src, /\.navbar a\.nav-golive \{ background: linear-gradient\(90deg, #e53935, #ff7043\)/, "Go live keeps its red gradient");
  assert.match(src, /\.navbar a\.nav-post \{ border-color: #3c7a46; background: #12301a;/, "Post keeps its green outline");
  assert.doesNotMatch(src, /\.nav-post \{ padding: 5px|\.nav-golive \{ padding: 6px/, "no old per-button paddings left");
  const n = nav(await render({ user: "someuser" }));
  assert.match(n, /class="nav-post"[^>]*><span class="cta-ic" aria-hidden="true">✏️<\/span><span class="lb">Post<\/span>/);
  assert.match(n, /class="nav-golive"[^>]*><span class="cta-ic" aria-hidden="true">🎥<\/span><span class="lb">Go live<\/span>/);
});
