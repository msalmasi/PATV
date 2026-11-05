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
  assert.match(src, /\.navbar a\.nav-golive \{ background: linear-gradient\(90deg, var\(--ds-live\), var\(--ds-live-2\)\)/, "Go live keeps its red gradient (1.99pj: ds tokens, white text >= 3.9:1)");
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
  // 1.99za: Watch & hang out first, You after Play (the user: pads come first on a phone)
  assert.deepEqual(heads(more), ["nm-watch", "nm-play", "nm-you", "nm-shop", "nm-info", "nm-staff"]);
  assert.deepEqual(heads(burger), ["nb-watch", "nb-play", "nb-you", "nb-shop", "nb-info", "nb-staff"]);
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

test("casino links follow the site flags: the old Pepe-table pages while dark, /casino/<game> once its flag is on", async () => {
  const links = async (casinoOn) => {
    const n = nav(await render(Object.assign({ user: "someuser" }, casinoOn ? { casinoOn } : {})));
    return [hrefs(pop(n, "nav-burger")), hrefs(pop(n, "nav-more"))];
  };
  const both = (pair, h) => pair.every((x) => x.includes(h));
  const none = (pair, h) => pair.every((x) => !x.includes(h));
  for (const flags of [null, () => false]) {
    const p = await links(flags);
    assert.ok(both(p, "/blackjack") && both(p, "/poker"), "dark: the old pages keep their menu entries");
    assert.ok(none(p, "/casino/blackjack") && none(p, "/casino/holdem"), "dark: no casino-table links");
  }
  let p = await links((g) => g === "bj");
  assert.ok(both(p, "/casino/blackjack") && none(p, "/blackjack") && both(p, "/poker") && none(p, "/casino/holdem"), "blackjack on");
  p = await links((g) => g === "holdem");
  assert.ok(both(p, "/blackjack") && both(p, "/casino/holdem") && none(p, "/poker") && none(p, "/casino/blackjack"), "hold'em on");
  p = await links(() => true);
  assert.ok(both(p, "/casino/blackjack") && both(p, "/casino/holdem") && none(p, "/blackjack") && none(p, "/poker"), "both on");
});

test("1.99ol: the casino FRONT-END setting picks the links, independent of the engine flags (auto = follow them)", async () => {
  // casino/service.js opens ./myapp.db when required: do it from a temp dir
  const os = require("os");
  const here = process.cwd();
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "navbar-front-")));
  const svc = require(path.join(repo, "casino", "service"));
  process.chdir(here);
  const links = async (st) => {
    const n = nav(await render({ user: "someuser", casinoOn: (g) => svc.frontOf(st, g) === "patv" }));
    return [hrefs(pop(n, "nav-burger")), hrefs(pop(n, "nav-more"))];
  };
  const both = (pair, h) => pair.every((x) => x.includes(h));
  const none = (pair, h) => pair.every((x) => !x.includes(h));
  const on = { bj_enabled: true, hm_enabled: true };
  // auto (the default): today's behaviour - engine on -> /casino/<game>
  let p = await links(Object.assign({ bj_front: "auto", hm_front: "auto" }, on));
  assert.ok(both(p, "/casino/blackjack") && both(p, "/casino/holdem") && none(p, "/blackjack") && none(p, "/poker"), "auto + engines on");
  // Pepe's tables chosen while both engines are ON
  p = await links(Object.assign({ bj_front: "pepe", hm_front: "pepe" }, on));
  assert.ok(both(p, "/blackjack") && both(p, "/poker") && none(p, "/casino/blackjack") && none(p, "/casino/holdem"), "pepe + engines on");
  // the PATV casino chosen while both engines are OFF; mixed per game
  p = await links({ bj_enabled: false, hm_enabled: false, bj_front: "patv", hm_front: "auto" });
  assert.ok(both(p, "/casino/blackjack") && both(p, "/poker") && none(p, "/blackjack") && none(p, "/casino/holdem"), "bj patv, hold'em auto (off)");
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

// 1.99za: "My pads" = the pads you own + the pads you follow (padowner.navPads via app.locals, the ids from
// follows.navPads), right under Watch & hang out; live ones first; yours keep a ⚙ owner-panel shortcut; capped + See all
test("My pads: owned + followed under Watch, live first, owner-panel shortcut, See all", async () => {
  const navPads = (u, ids) => {
    assert.equal(u, "someuser");
    assert.deepEqual(ids, ["r2", "r3"]);
    return { items: [
      { slug: "live-one", title: "Live <One>", href: "/p/live-one", owned: false, live: true, owner: null },
      { slug: "mine", title: "Mine", href: "/p/mine", owned: true, live: false, owner: "/p/mine/owner" },
      { slug: "fol", title: "Followed", href: "/p/fol", owned: false, live: false, owner: null },
    ], more: true };
  };
  const n = nav(await render({ user: "someuser", navPads, followedPadIds: ["r2", "r3"] }));
  for (const [cls, pre] of [["nav-burger", "nb-"], ["nav-more", "nm-"]]) {
    const p = pop(n, cls);
    assert.deepEqual(heads(p).slice(0, 3), [pre + "watch", pre + "mypads", pre + "play"]);
    const sec = new RegExp('aria-labelledby="' + pre + 'mypads"[^]*?</div></div>').exec(p)[0];
    assert.deepEqual(hrefs(sec), ["/p/live-one", "/p/mine", "/p/fol", "/p#following"], "pads open the pad itself, then See all");
    assert.match(sec, /class="nav-link nav-pad nav-padlive"/, "a live pad is marked");
    assert.match(sec, /<span class="nav-livedot" role="img" aria-label="Live now"><\/span>/);
    assert.match(sec, /Live &lt;One&gt;/, "titles are escaped");
    assert.match(sec, /<div class="nav-row"><a href="\/p\/mine"[^]*?<\/a><a href="\/p\/mine\/owner" class="nav-sub"/, "your pad keeps the owner panel shortcut");
    assert.doesNotMatch(sec, /href="\/p\/fol\/owner"/, "no owner panel for a followed pad");
  }
});

test("My pads: none when you own and follow nothing, and nothing signed out", async () => {
  for (const locals of [{ user: "someuser", navPads: () => ({ items: [], more: false }) }, { navPads: () => { throw new Error("not called signed out"); } }]) {
    const n = nav(await render(locals));
    assert.doesNotMatch(n, /mypads/);
  }
});

// homegap2 (owner 2026-11-05 "Ok fix all 3", blank 3: "make the navbar wrap or shrink its labels before it overflows"): at 1024px in de / id /
// tr (and signed in at 501-520 / 761-1040px in every language - the fixture sweep) the bar's pieces were wider than the window and the whole
// page scrolled sideways. #navFit measures the bar and, while it doesn't fit, takes the next give-way step (nav-f1 .. nav-f6).
const I18N = require(path.join(repo, "i18n-core.js"));
const catalog = (c) => JSON.parse(fs.readFileSync(path.join(repo, "locales", c + ".json"), "utf8"));
const vm = require("vm");
const fitSrc = (html) => { const m = /<script id="navFit">([\s\S]*?)<\/script>/.exec(html); assert.ok(m, "the fit script"); return m[1]; };
// a model bar: `need` px of pieces at step 0, each step saving save[i]; the header grows to the pieces (as it does), the window doesn't
function modelBar(src, { vw, need, save, open = false }) {
  const cls = new Set(), L = { listeners: {} }, frames = [];
  const level = () => [1, 2, 3, 4, 5, 6].filter((i) => cls.has("nav-f" + i)).length;
  const width = () => need - save.slice(0, level()).reduce((a, b) => a + b, 0);
  const box = () => Math.max(S.vw, width());
  const S = { vw };
  const left = { get scrollWidth() { return 400; }, get clientWidth() { return 400; } };
  const navEl = {
    classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) },
    getBoundingClientRect: () => ({ width: box() }), get scrollWidth() { return Math.ceil(box()); }, get clientWidth() { return Math.round(box()); },
    parentNode: { get clientWidth() { return box(); } },
    querySelector: (q) => (q === ".navbar-left" ? left : q === "details[open]" ? (S.open ? {} : null) : null),
    addEventListener: (t, f) => { (L.listeners["nav:" + t] = L.listeners["nav:" + t] || []).push(f); },
  };
  S.open = open;
  const win = { requestAnimationFrame: (f) => { frames.push(f); return frames.length; }, addEventListener: (t, f) => { (L.listeners[t] = L.listeners[t] || []).push(f); } };
  const doc = { querySelector: (q) => (q === "header .navbar" ? navEl : null), documentElement: { get clientWidth() { return S.vw; } }, fonts: null };
  vm.runInNewContext(src, Object.assign(win, { window: win, document: doc, setTimeout }));
  const flush = () => { while (frames.length) frames.shift()(); };
  return { level, width, S, win, flush, fire: (t, e) => { (L.listeners[t] || []).forEach((f) => f(e || {})); flush(); }, cls };
}

test("homegap2: the navbar's fit takes the give-way steps in order only while the bar doesn't fit - from nothing each time, never with a menu open", async () => {
  const src = fitSrc(await render({ user: "someuser" }));
  const save = [73, 66, 90, 95, 48, 300];
  assert.equal(modelBar(src, { vw: 1100, need: 1070, save }).level(), 0, "it fits: every label");
  assert.equal(modelBar(src, { vw: 1024, need: 1070, save }).level(), 1, "tr at 1024px: Post icon-only (46px short)");
  assert.equal(modelBar(src, { vw: 1024, need: 1024, save }).level(), 0, "exactly the window: no step");
  assert.equal(modelBar(src, { vw: 1024, need: 1024.4, save }).level(), 1, "0.4px over is a 1px sideways scroll (WebKit, nl): a step");
  assert.equal(modelBar(src, { vw: 900, need: 1070, save }).level(), 3, "short by 170: Post, More's label, Go live");
  assert.equal(modelBar(src, { vw: 320, need: 9999, save }).level(), 6, "never more than the phone bar (nav-f6)");
  const b = modelBar(src, { vw: 900, need: 1070, save });
  assert.equal(b.level(), 3);
  b.S.vw = 1200; b.fire("resize");
  assert.equal(b.level(), 0, "a wider window gets the labels back");
  b.S.vw = 960; b.fire("resize");
  assert.equal(b.level(), 2, "and a narrower one gives way again");
  b.S.open = true; b.S.vw = 1200; b.fire("resize");
  assert.equal(b.level(), 2, "not while a menu is open (its pop overflows the bar on purpose)");
  b.S.open = false; b.fire("nav:toggle", { target: { open: false } });
  assert.equal(b.level(), 0, "fitted again when it closes");
  assert.equal(typeof b.win.PATV_navFit, "function", "window.PATV_navFit() for anything that changes the bar");
  for (const t of ["resize", "load", "nav:toggle", "nav:transitionend", "nav:focusin", "nav:focusout"]) assert.ok(src.includes("addEventListener('" + t.replace("nav:", "") + "'"), "fits again on " + t);
  assert.match(src, /document\.fonts\.addEventListener\('loadingdone', later\)/, "when the web fonts arrive");
});

test("homegap2: the navbar's give-way steps - the fit after the bar's styles, labels kept as accessible names, More's ⋯, every language", async () => {
  const src = fs.readFileSync(layout, "utf8").replace(/\r\n/g, "\n");
  const html = await render({ user: "someuser" });
  const fit = html.indexOf('<script id="navFit">');
  for (const s of [".navbar.nav-f6 .nav-burger { display: block; }", ".nav-search { display: none; position: relative;", "@media (min-width: 1280px) { .nav-search { display: inline-flex; } }"])
    assert.ok(html.indexOf(s) > 0 && html.indexOf(s) < fit, "the fit runs after the bar's styles: " + s);
  assert.ok(fit < html.indexOf('<template id="siteFootTpl">') && fit > html.indexOf("</nav>"), "right after them, before the page");
  // the steps, in order
  for (const r of [
    ".navbar.nav-f1 .nav-post .nav-lbl, .navbar.nav-f2 .nav-more-lbl, .navbar.nav-f3 .nav-golive .nav-lbl { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }",
    "@media (min-width: 501px) { .navbar.nav-f1 a.nav-post, .navbar.nav-f3 a.nav-golive { width: 34px; min-width: 0; padding: 0; } }",
    ".navbar.nav-f2 .nav-more-ic { display: inline-flex;",
    ".navbar.nav-f4 .logo-full { display: none; }", ".navbar.nav-f4 .logo-short { display: inline; }",
    ".navbar.nav-f5 .nav-search, .navbar.nav-f5 a.nav-sbtn { display: none; }",
    ".navbar.nav-f6 .nav-main, .navbar.nav-f6 .nav-more { display: none; }", ".navbar.nav-f6 .nav-burger { display: block; }",
  ]) assert.ok(src.includes(r), r);
  assert.doesNotMatch(src, /\.nav-f\d[^{]*\.nav(-more)?-lbl[^{]*\{[^}]*display: none/, "a collapsed label is visually hidden, never display: none (it is the link's name)");
  assert.ok(src.indexOf(".navbar.nav-f1 .nav-post .nav-lbl") > src.indexOf("@media (max-width: 420px) {"), "after the phone rules (they keep their 34 / 32px squares)");
  // More: the ⋯ is decorative, the label its name; Post / Go live keep their titles
  for (const user of [undefined, "someuser"]) {
    const n = nav(await render({ user }));
    assert.match(n, /<summary><span class="nav-more-ic" aria-hidden="true">⋯<\/span><span class="nav-more-lbl">More<\/span> <span aria-hidden="true">▾<\/span><\/summary>/);
    assert.match(n, /class="nav-post" title="[^"]+"/); assert.match(n, /class="nav-golive" title="[^"]+"/);
  }
  // every language: the same bar - its labels capped (i18n.test.js pins the 7.5em), the fit and More's ⋯ there, right to left too
  const langs = fs.readdirSync(path.join(repo, "locales")).filter((f) => /^[a-z]{2}(-[A-Z]{2})?\.json$/.test(f)).map((f) => f.slice(0, -5));
  assert.ok(langs.length >= 23);
  for (const l of langs) {
    const h = await render({ user: "someuser", i18nT: I18N(catalog(l), catalog("en"), l) });
    assert.ok(h.includes('<script id="navFit">') && h.includes('class="nav-more-ic" aria-hidden="true">⋯</span><span class="nav-more-lbl">'), l);
    for (const k of ["nav.post", "nav.golive", "nav.more", "nav.signin"]) assert.ok(String(catalog(l)[k] || catalog("en")[k]).length <= 30, l + " " + k + ": a short label");
  }
});
