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
  assert.match(src, /@media \(max-width: 420px\) \{\s*\.navbar \{ padding: 10px 8px; gap: 6px; \}/);
  // the narrow block must come after the 760px block, or its .navbar padding wins
  assert.ok(src.indexOf(".navbar { padding: 10px 8px;") > src.indexOf("@media (max-width: 760px)"));
});
