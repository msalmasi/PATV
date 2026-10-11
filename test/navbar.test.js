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
  assert.match(src, /@media \(max-width: 500px\) \{ \.nav-golive \.nav-lbl, \.nav-post \.nav-lbl \{ display: none; \}/);
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
  assert.match(n, /class="nav-post"[^>]*><span class="cta-ic" aria-hidden="true">✏️<\/span><span class="nav-lbl">Post<\/span>/);
  assert.match(n, /class="nav-golive"[^>]*><span class="cta-ic" aria-hidden="true">🎥<\/span><span class="nav-lbl">Go live<\/span>/);
});

// 2026-10-11: More and ☰ are grouped into labelled sections (You / Watch / Play / Shop / Info / Staff)
const pop = (n, cls) => {
  const m = new RegExp('<details class="' + cls + '">[\\s\\S]*?</details>').exec(n);
  assert.ok(m, cls + " rendered");
  return m[0];
};
const hrefs = (html) => [...html.matchAll(/<a href="([^"]*)" class="nav-link/g)].map((m) => m[1]);
const heads = (html) => [...html.matchAll(/<div class="nav-sec-h" id="([^"]*)">/g)].map((m) => m[1]);

test("More and ☰ menus: labelled sections in order, search on top, More skips the top-bar links", async () => {
  const n = nav(await render({ user: "someuser", supportOn: () => true, casinoOn: () => true }));
  const more = pop(n, "nav-more"), burger = pop(n, "nav-burger");
  assert.deepEqual(heads(more), ["nm-you", "nm-watch", "nm-play", "nm-shop", "nm-info", "nm-staff"]);
  assert.deepEqual(heads(burger), ["nb-you", "nb-watch", "nb-play", "nb-shop", "nb-info", "nb-staff"]);
  for (const p of [more, burger]) {
    assert.ok(p.indexOf('class="nav-psearch"') < p.indexOf('class="nav-sec'), "search box first");
    assert.match(p, /role="group" aria-labelledby="n[mb]-you"/);
    // the staff section (and its link) stay hidden until the profile fetch unhides .adminLink
    assert.match(p, /<div class="nav-sec adminLink" role="group" aria-labelledby="n[mb]-staff" hidden>/);
    assert.match(p, /<a href="\/admin" class="nav-link adminLink" hidden/);
  }
  const top = ["/", "/p", "/u/someuser/wheel", "/feed", "/markets", "/wagers", "/gtf", "/rankings"];
  for (const h of top) {
    assert.ok(!hrefs(more).includes(h), "More skips top-bar " + h);
    assert.ok(hrefs(burger).includes(h), "☰ lists " + h);
  }
  const all = ["/wallet", "/staking", "/history", "/subscriptions", "/achievements", "/plex", "/lotto", "/casino/blackjack", "/casino/holdem", "/bounties",
    "/shop", "/premium", "/cosmetics", "/support", "/polls", "/help", "/economy", "/about", "/info", "/admin", "/u/someuser", "/settings/telegram"];
  for (const h of all) {
    assert.ok(hrefs(more).includes(h), "More has " + h);
    assert.ok(hrefs(burger).includes(h), "☰ has " + h);
  }
  assert.ok(hrefs(more).some((h) => h.startsWith("/language")));
});

test("menu gating: signed-out drops the personal links; Support only while a donation rail is on", async () => {
  const n = nav(await render({ supportOn: () => false }));
  const burger = pop(n, "nav-burger");
  for (const h of ["/subscriptions", "/settings/telegram", "/support"]) assert.ok(!hrefs(burger).includes(h), "no " + h);
  assert.ok(!hrefs(burger).some((h) => h.startsWith("/u/")), "no profile link signed out");
  assert.ok(hrefs(burger).includes("/wallet"));
  assert.ok(hrefs(burger).includes("/login"), "the wheel goes to sign-in");
});

test("casino links follow the site flags: each game shows only while its flag is on (prod is dark)", async () => {
  const links = async (casinoOn) => hrefs(pop(nav(await render(Object.assign({ user: "someuser" }, casinoOn ? { casinoOn } : {}))), "nav-burger"));
  let h = await links(null);
  assert.ok(!h.includes("/casino/blackjack") && !h.includes("/casino/holdem"), "no flags known = no casino links");
  h = await links(() => false);
  assert.ok(!h.includes("/casino/blackjack") && !h.includes("/casino/holdem"), "both off");
  h = await links((g) => g === "bj");
  assert.ok(h.includes("/casino/blackjack") && !h.includes("/casino/holdem"), "blackjack only");
  h = await links((g) => g === "holdem");
  assert.ok(!h.includes("/casino/blackjack") && h.includes("/casino/holdem"), "hold'em only");
  assert.ok(!h.includes("/blackjack") && !h.includes("/poker"), "the old Pepe-table pages aren't in the menu");
});

test("Polls sit under Play (interactive), not Info & links, in both More and ☰", async () => {
  const n = nav(await render({ user: "someuser", casinoOn: () => true }));
  for (const [cls, pre] of [["nav-more", "nm"], ["nav-burger", "nb"]]) {
    const p = pop(n, cls);
    const sec = (id) => {
      const m = new RegExp('aria-labelledby="' + pre + "-" + id + '"[^]*?</div></div>').exec(p);
      assert.ok(m, cls + " has section " + id);
      return hrefs(m[0]);
    };
    assert.ok(sec("play").includes("/polls"), cls + ": Polls in Play");
    assert.ok(!sec("info").includes("/polls"), cls + ": not in Info & links");
  }
});
