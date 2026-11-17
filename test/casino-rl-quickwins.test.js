"use strict";
// 1.99aoh (quick wins) - the browser side, in a vm with test/fixtures/mini-dom.js (no browser):
//   * O8: the history strip, the history sheet rows and the Room Dock's recent line colour each pocket from the client's red list
//     (14 and 18 red, 0 zero, 2 black - never the server's color field), say the colour as a word, and emphasise the newest pocket
//   * O7: the table page's limits placard (t.limits) and the player's "left this spin" meter (me.room_left)
//   * O13(1): the iPhone touch rules on the betting board
//   * O3: the layout's 🛞 Roulette link follows app.locals.rouletteOn (given the view's can) and the guest-access rule
//   node --test test/casino-rl-quickwins.test.js
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const ejs = require("ejs");
const { El, makeWindow } = require("./fixtures/mini-dom");
const repo = path.resolve(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(repo, f), "utf8");
const RED = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
const LIMITS = {
  rl_min_bet: 100, rl_max_straight: 5000, rl_max_split: 10000, rl_max_street: 15000, rl_max_corner: 20000, rl_max_line: 30000,
  rl_max_outside: 50000, rl_max_spin: 100000, rl_max_positions: 30, rl_max_lines: 20, rl_max_players: 30,
  rl_bet_secs: 25, rl_spin_secs: 8, rl_result_secs: 5,
};
// the server's color field is deliberately WRONG here: the page must colour pockets from PATVRlBets.red, not from it
const HISTORY = [
  { round_no: 1, number: 14, color: "black" },
  { round_no: 2, number: 18, color: "green" },
  { round_no: 3, number: 0, color: "green" },
  { round_no: 4, number: 2, color: "red" },
];

// mini-dom has no insertBefore-style helpers or focus - just enough for casinorl.js
El.prototype.before = function (...nodes) {
  const p = this.parentNode,
    at = p.children.indexOf(this);
  for (const n of nodes) {
    if (n.parentNode) n.parentNode.children.splice(n.parentNode.children.indexOf(n), 1);
    n.parentNode = p;
  }
  p.children.splice(at, 0, ...nodes);
};
El.prototype.focus = function () {};

const el = (tag, id, kids) => {
  const e = new El(tag);
  if (id) e.setAttribute("id", id);
  if (kids) e.append(...kids);
  return e;
};
function view(phase, me, extra) {
  return {
    ok: true,
    now: Date.now(),
    table: Object.assign(
      { id: "abcdef0123", game: "roulette", status: "open", phase, round_no: 5, last_revealed: 4, history: HISTORY, limits: LIMITS,
        deadline: phase === "betting" ? Date.now() + 20000 : null, land_at: null, result_until: null, spin: null,
        commit_round: 5, commitment: "ab", client_seed: "cd", totals: { players: me && me.staked ? 1 : 0, staked: (me && me.staked) || 0 },
        seats: [], lobby: true },
      extra || {},
    ),
    me: me ? Object.assign({ lines: [], staked: 0, room_left: 100000, pending: null, last_slip: null, banned: false, net: null,
                             private_note: null, notice: null }, me) : null,
  };
}
/** views/casino-rl.ejs's elements + a stub CZ (casino-ui.js), then rlbets / the dock / casinorl.js as the page loads them */
function tablePage() {
  const W = makeWindow((url) => (String(url).startsWith("/api/casino/lobby") ? { ok: true, roulette: { wheels: [] } } : { ok: false }));
  // (roulette2 WP5b: the rebuilt page - the felt's wheel canvas and croupier, the layout column (rl-table), the trail; no wheel module
  // here, so the page keeps its felt and history without one)
  const root = el("main", "cb", [
    el("div", "cz-felt", [
      el("canvas", "rl-wheel"),
      el("div", "cz-msg"), el("p", "rl-net"),
      el("div", "rl-table", [
        el("span", "rl-phase"), el("span", "rl-totals"), el("div", "rl-modes"), el("output", "rl-instruction"),
        el("div", "rl-board", [el("div", "rl-grid"), el("div", "rl-outside")]), el("div", "rl-race"),
      ]),
      el("ol", "rl-history"),
    ]),
    el("div", "cz-dock"), el("nav", "rl-wheels"), el("span", "rl-proof"), el("button", "cz-histbtn"),
  ]);
  const $ = (id) => [root, ...root.all()].find((e) => e.attrs.id === id || e.id === id) || null;
  Object.assign(W.document, { createElementNS: (ns, tag) => new El(tag), querySelector: () => null, getElementById: $,
                              addEventListener() {}, dispatchEvent() { return true; } });
  W.CustomEvent = function (type, init) { this.type = type; this.detail = init && init.detail; };
  W.matchMedia = () => ({ matches: false, addEventListener() {} });
  const fill = (d, v) => String(d).replace(/\{(\w+)\}/g, (m, n) => (v && v[n] != null ? v[n] : m));
  const CZ = (W.CZ = {
    tableId: "abcdef0123", signed: true, $,
    T: (k, d, v) => fill(typeof d === "object" ? (v && v.count === 1 ? d.one : d.other) : d, v),
    fmt: (n) => Math.trunc(Number(n) || 0).toLocaleString("en-US"),
    short: (n) => String(n), skew: () => 0,
    esc: (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
    announce() {}, note() {}, toast() {}, openSheet() {}, theme() {}, armClock() {}, pop() {},
    pileHTML: (n) => String(n), stackHTML: (n) => String(n), avatarHTML: () => "", seatWho: (s, inner) => inner, net: (n) => String(n),
    loadHistory(fn) { CZ.row = fn; },
    actor: () => async () => ({}),
    wireHost() {},
    startTable(render) { CZ.render = render; return async () => {}; },
  });
  for (const f of ["public/js/patamount.js", "casino/rlbets.js", "public/js/casinorl-dock.js", "public/js/casinorl.js"]) W.run(read(f), f);
  return { W, CZ, $, root };
}
const pockets = (box) => box.querySelectorAll("span").filter((s) => s.classList.contains("rl-pocket"));

test("O8: PATVRoulette.pocket colours every pocket from the client's red list (14 and 18 red, 0 zero, 2 black) and says the colour", () => {
  const { W } = tablePage();
  const R = W.PATVRoulette;
  for (let n = 0; n <= 36; n++) assert.equal(R.pocketColor(n), n === 0 ? "zero" : RED.includes(n) ? "red" : "black", String(n));
  const want = { 14: ["red", "14 red"], 18: ["red", "18 red"], 0: ["zero", "0 green"], 2: ["black", "2 black"] };
  for (const [n, [cls, word]] of Object.entries(want)) {
    const p = R.pocket(+n, 41, false);
    assert.equal(p.className, "rl-pocket " + cls);
    assert.equal(p.textContent, n);
    assert.equal(p.getAttribute("role"), "img");
    assert.equal(p.getAttribute("aria-label"), "Spin 41: " + word, "the colour as a word - a cue that isn't colour");
  }
  assert.equal(R.pocket(14, 41, true).className, "rl-pocket red newest");
  assert.equal(R.pocketLabel(2), "2 black");
});

test("O8: the table's history strip - pockets in the felt's colours (not the server's color field), newest first and emphasised", async () => {
  const { CZ, $ } = tablePage();
  CZ.render(view("betting", { lines: [{ text: "red 2500", amount: 2500 }], staked: 2500, room_left: 97500 }));
  const strip = $("rl-history");
  assert.equal(strip.children.length, 4);
  assert.ok(strip.children.every((li) => li.tagName === "LI"));
  const got = pockets(strip).map((p) => [p.textContent, p.className, p.getAttribute("aria-label")]);
  assert.deepEqual(got, [
    ["2", "rl-pocket black newest", "Spin 4: 2 black"],
    ["0", "rl-pocket zero", "Spin 3: 0 green"],
    ["18", "rl-pocket red", "Spin 2: 18 red"],
    ["14", "rl-pocket red", "Spin 1: 14 red"],
  ]);
  assert.doesNotMatch(strip.textContent, /[◆●]/, "the glyph is the CSS's (::after), not text in the number");
  // the history sheet's rows: the same pocket, then the spin's number
  $("cz-histbtn").onclick();
  const row14 = CZ.row({ round: 41, results: { number: 14 }, proof: "/casino/fair/abcdef0123/41" }),
    row0 = CZ.row({ round: 42, results: { number: 0 }, proof: "/casino/fair/abcdef0123/42" }),
    row2 = CZ.row({ round: 43, results: { number: 2 }, proof: "/casino/fair/abcdef0123/43" });
  assert.match(row14, /<b><span class="rl-pocket red" role="img" aria-label="14 red" title="14 red">14<\/span> Spin 41<\/b>/);
  assert.match(row0, /<span class="rl-pocket zero" role="img" aria-label="0 green" title="0 green">0<\/span> Spin 42/);
  assert.match(row2, /<span class="rl-pocket black" role="img" aria-label="2 black" title="2 black">2<\/span> Spin 43/);
  assert.match(CZ.row({ round: 44, results: {}, proof: "/x" }), /<b>Spin 44<\/b>/, "no pocket: just the spin");
});

test("O7: the limits placard names every limit in plain words and the player's 'left this spin' while bets are open", () => {
  const { CZ, $ } = tablePage();
  const box = $("rl-limits");
  assert.ok(box, "the placard is on the felt");
  assert.equal(box.tagName, "DETAILS");
  const column = $("rl-table");
  assert.ok(column.children.indexOf(box) >= 0 && column.children.indexOf(box) < column.children.indexOf($("rl-modes")), "above the board's modes");
  // (roulette2 WP5b: folded by default on every screen - its summary line keeps the key limits and the meter; the viewer's choice is kept)
  assert.equal(box.open, false);
  CZ.render(view("betting", { lines: [{ text: "red 2500", amount: 2500 }], staked: 2500, room_left: 97500 }));
  assert.equal(box.hidden, false);
  const sum = box.querySelector("summary"),
    items = box.querySelectorAll("li").map((li) => li.textContent);
  assert.match(sum.textContent, /^Table limits/);
  assert.equal(box.querySelector(".rl-left").textContent, "Your bets this spin: 2,500 PAT · 97,500 PAT left");
  assert.deepEqual(items, [
    "All your bets together: up to 100,000 PAT a spin",
    "Minimum bet: 100 PAT each time you bet",
    "One number (straight up): up to 5,000 PAT",
    "Split, 2 numbers: up to 10,000 PAT",
    "Street or trio, 3 numbers: up to 15,000 PAT",
    "Corner or first four, 4 numbers: up to 20,000 PAT",
    "Line, 6 numbers: up to 30,000 PAT",
    "Dozens, columns, red or black, odd or even, 1–18 or 19–36: up to 50,000 PAT each",
    "Up to 30 spots a spin",
    "Every limit is per player and per spin. A spot's limit counts all your chips on that spot.",
  ]);
  assert.ok(box.querySelector(".rl-lim-spin"), "the per-spin maximum stands out");
  // no more bets / the result: no "left" meter; signed out: the limits without a meter; an admin's new limit shows on the next poll
  CZ.render(view("spinning", { staked: 2500, room_left: 97500 }));
  assert.equal(box.querySelector(".rl-left").textContent, "");
  CZ.render(view("idle", null, { limits: Object.assign({}, LIMITS, { rl_max_spin: 250000 }) }));
  assert.equal(box.hidden, false);
  assert.equal(box.querySelector(".rl-left").textContent, "");
  assert.equal(box.querySelectorAll("li")[0].textContent, "All your bets together: up to 250,000 PAT a spin");
  CZ.render(view("idle", { banned: true }));
  assert.equal(box.querySelector(".rl-left").textContent, "", "a casino-banned player has nothing left to bet");
  CZ.render(view("idle", {}, { limits: {} }));
  assert.equal(box.hidden, true, "no limits in the view: no placard");
});

test("O8: the Room Dock's recent line uses the same pockets, newest first", async () => {
  const W = makeWindow((url) => {
    const u = new URL(url, "http://dock.test");
    if (u.pathname === "/api/casino/roulette/pad/test-pad") return { ok: true, table: "aaaaaaaaaa", here: false };
    if (u.pathname.startsWith("/api/casino/t/")) return Object.assign(view("idle", {}), { table: Object.assign(view("idle", {}).table, { id: "aaaaaaaaaa" }) });
    return { status: 404, body: { ok: false } };
  });
  for (const f of ["public/js/patamount.js", "casino/rlbets.js", "public/js/casinorl-dock.js"]) W.run(read(f), f);
  const box = W.document.createElement("div");
  W.PATVRoulette.mount(box, { slug: "test-pad" });
  await W.settle();
  const recent = box.querySelector(".rl-recent");
  assert.match(recent.textContent, /^Last spins/);
  assert.deepEqual(pockets(recent).map((p) => p.textContent + " " + p.className), [
    "2 rl-pocket black newest",
    "0 rl-pocket zero",
    "18 rl-pocket red",
    "14 rl-pocket red",
  ]);
  assert.equal(pockets(recent)[3].getAttribute("aria-label"), "Spin 1: 14 red");
});

// roulette2 WP5b (contract 9): the .rl-pocket rules moved from casinorl-dock.css to public/css/casino-chips.css (WP5a's file, loaded by the
// table page and by the pad page) - checked there once that file is in the tree
const CHIPS = path.join(repo, "public", "css", "casino-chips.css");
const pocketCss = () => (fs.existsSync(CHIPS) ? fs.readFileSync(CHIPS, "utf8") : null);
test("O8 / O13(1): one shared pocket style on both pages, the iPhone touch rules on the board", (t) => {
  const dockCss = read("public/css/casinorl-dock.css"),
    felt = read("views/partials/casino-rl-css.ejs");
  assert.doesNotMatch(dockCss, /^\.rl-pocket/m, "no second copy of the pocket rules");
  assert.match(read("views/casino-rl.ejs"), /\/public\/css\/casino-chips\.css\?v=\d+/, "the table page loads the shared chips");
  for (const v of ["views/casino-rl.ejs", "views/room.ejs"]) assert.match(read(v), /\/public\/css\/casinorl-dock\.css\?v=4/, v);
  const css = pocketCss();
  assert.ok(css, "public/css/casino-chips.css (WP5a) is in the tree");
  {
    assert.match(read("views/room.ejs"), /\/public\/css\/casino-chips\.css/, "the pad page (the Room Dock) loads them too");
    assert.match(css, /^\.rl-pocket\.red\b[^{]*\{[^}]*background: #c62828;/m, "the rule itself (1.99aoj: anchored - the file's header comment names .rl-pocket.red too)");
    assert.match(css, /^\.rl-pocket\.black\b[^{]*\{[^}]*background: #141418;/m);
    assert.match(css, /^\.rl-pocket\.zero\b[^{]*\{[^}]*background: #1e7f4f;/m);
    assert.match(css, /^\.rl-pocket\.red::after\s*\{[^}]*content: "◆"/m);
    assert.match(css, /^\.rl-pocket\.black::after\s*\{[^}]*content: "●"/m);
  }
  assert.doesNotMatch(felt, /\.rl-trail li \{[^}]*background/, "no one dark box for every entry");
  assert.match(felt, /\.rl-grid button,\s*\.rl-outside button \{\s*touch-action: manipulation;\s*-webkit-user-select: none;\s*user-select: none;\s*-webkit-touch-callout: none;/);
  assert.match(dockCss, /\.rl-controls button,\s*\.rl-quick button \{\s*touch-action: manipulation;/);
  const page = read("public/js/casinorl.js");
  assert.doesNotMatch(page, /r\.color/, "the page never colours a pocket from the server's field");
});

test("O7 / O8: every new string's English default equals locales/en.json (the i18n bot translates from there)", () => {
  const EN = JSON.parse(read("locales/en.json"));
  const keys = ["rl_pocket_red", "rl_pocket_black", "rl_pocket_zero", "rl_pocket_spin", "rl_recent", "rl_limits", "rl_lim_spin",
    "rl_lim_min", "rl_lim_straight", "rl_lim_split", "rl_lim_street", "rl_lim_corner", "rl_lim_line", "rl_lim_outside", "rl_lim_spots",
    "rl_lim_note", "rl_left"];
  const src = read("public/js/casinorl.js") + read("public/js/casinorl-dock.js");
  for (const k of keys) {
    const m = new RegExp('T\\("' + k + '",\\s*"((?:[^"\\\\]|\\\\.)*)"').exec(src);
    assert.ok(m, k + " is used");
    assert.equal(EN["js.casino." + k], m[1], k);
    assert.doesNotMatch(m[1], /<|&[a-z#0-9]+;/i, k + ": plain text");
  }
  assert.equal(EN["nav.roulette"], "Roulette");
});

test("O3: the layout's 🛞 Roulette link sits after Hold'em in Play when rouletteOn(can) says so, and obeys guest access", async () => {
  const layout = path.join(repo, "views", "layout.ejs");
  const nav = (html) => /<nav class="navbar">[\s\S]*?<\/nav>/.exec(html)[0];
  const can = () => false;
  let given = null;
  const render = (extra) => ejs.renderFile(layout, Object.assign({ title: "T", ogPath: "/", casinoOn: () => true, can }, extra));
  let n = nav(await render({ user: "someuser", rouletteOn: (c) => ((given = c), true) }));
  assert.equal(given, can, "the layout passes its can() (the request's user)");
  for (const cls of ["nav-more", "nav-burger"]) {
    const pop = new RegExp('<details class="' + cls + '">[\\s\\S]*?</details>').exec(n)[0];
    // (roulette2 WP5a review: with the PATV casino the link is the lobby's 🛞 tab - test/casino-lobby.test.js covers every front)
    assert.match(pop, /href="\/casino\/holdem" class="nav-link"[^>]*>[\s\S]*?<\/a><a href="\/casino\/blackjack#roulette" class="nav-link" title="Roulette"><span class="ic">🛞<\/span><span class="nav-lbl">Roulette<\/span><\/a>/, cls);
  }
  assert.doesNotMatch(nav(await render({ user: "someuser", rouletteOn: () => false })), /\/casino\/roulette|title="Roulette"/);
  assert.doesNotMatch(nav(await render({ user: "someuser" })), /\/casino\/roulette|title="Roulette"/, "rendered without the casino routes: hidden");
  // a guest, with the casino closed to guests (guestaccess covers /casino/*): hidden even while it's open to everyone
  n = nav(await render({ rouletteOn: () => true, guestHides: (h) => /^\/casino(\/|$)/.test(h) }));
  assert.doesNotMatch(n, /\/casino\/roulette|title="Roulette"/);
  assert.match(nav(await render({ rouletteOn: () => true })), /href="\/casino\/blackjack#roulette" class="nav-link" title="Roulette"/, "a guest sees it while guests may visit");
});

// 1.99aoh review: measured in Chrome (320 / 360 px, dir=rtl, the summary's computed name, forced-colors: active) - these are
// the CSS rules those measurements came down to
test("O7 / O8 review: the placard fits a 320 px phone and RTL, its glyphs stay out of its name; pockets keep a readable glyph and colours in a Contrast theme", () => {
  const felt = read("views/partials/casino-rl-css.ejs"),
    dockCss = read("public/css/casinorl-dock.css");
  // the body of the rule whose selector line is exactly `sel {`
  const rule = (css, sel) => {
    const at = css.replace(/\r\n/g, "\n").split("\n" + sel + " {");
    assert.equal(at.length, 2, sel);
    return at[1].slice(0, at[1].indexOf("}"));
  };
  const ul = rule(felt, ".rl-limits ul");
  // 17rem columns made a list 272 px wide inside a ~217 px box on a 320 px phone: .rl-stage (overflow: hidden) cut every line off
  assert.match(ul, /grid-template-columns: repeat\(auto-fit, minmax\(min\(17rem, 100%\), 1fr\)\);/, "a column never wider than the box");
  // the bullets' room on the inline-start side in RTL too (ar / fa / he / ur): physical padding put the note past the border
  assert.match(ul, /padding-block: 0 0\.7rem;\s*padding-inline: 1\.9rem 0\.8rem;/);
  assert.doesNotMatch(ul, /(?:^|\s)padding(?:-left|-right)?:/, "no physical padding");
  assert.match(rule(felt, ".rl-limits .rl-lim-note"), /margin-inline-start: -1\.1rem;/);
  // the ⓘ and ▾ are decoration: empty alt text (after a plain fallback for an older WebKit) keeps them out of the spoken name
  assert.match(rule(felt, ".rl-limits-h::before"), /content: "ⓘ ";\s*content: "ⓘ " \/ "";/);
  assert.match(rule(felt, ".rl-limits-h::after"), /content: "▾";\s*content: "▾" \/ "";/);
  // the ◆ / ● cue that isn't colour: big enough to read (it was 7 px, about 3 px wide) and at full strength; forced colours: every
  // pocket was the same system colour and the newest lost its ring - they keep the felt's colours (WP5b: in casino-chips.css, contract 9)
  assert.doesNotMatch(dockCss.replace(/\/\*[\s\S]*?\*\//g, ""), /\.rl-pocket/, "(its comments aside)");
  const css = pocketCss();
  if (css) {
    const glyph = /\.rl-pocket::after\s*\{([^}]*)\}/.exec(css);
    assert.ok(glyph && +/font: (\d+(?:\.\d+)?)px/.exec(glyph[1])[1] >= 9, "the glyph is at least 9 px");
    assert.doesNotMatch(glyph[1], /opacity/);
    assert.match(css, /@media \(forced-colors: active\)\s*\{[^}]*\.rl-pocket[^{]*\{\s*forced-color-adjust: none;/);
  }
});
