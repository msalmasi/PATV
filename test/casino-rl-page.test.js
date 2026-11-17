"use strict";
// 1.99aoj - the roulette TABLE page (public/js/casinorl.js on casino-ui.js's CZ + casinorl-dock.js controls), in a vm with the
// little DOM of test/fixtures/mini-dom.js and a stub CZ / wheel module (no browser): the felt shows everyone's chips (D5) with mine
// highlighted, a spot's line names its odds, cap and my bet, the wheel module is driven by the view (spin / rest / idle on the site
// clock), Pepe's croupier lines, the players rail, the result moment and its client events (contract 8), call bets and ×2 as ONE
// ordinary line, the keyboard, the stats drawer's wording, the session line, the limits placard from t.rules.
//   node --test test/casino-rl-page.test.js
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path");
const { El, makeWindow } = require("./fixtures/mini-dom");
const repo = path.resolve(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(repo, f), "utf8");
const plain = (x) => JSON.parse(JSON.stringify(x));      // (objects made in the vm have its prototypes)
const RLW = require("../casino/rlwheel");
const G = require("../casino/rlbets");

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
El.prototype.appendChild = function (n) {
  this.append(n);
  return n;
};
El.prototype.insertBefore = function (n, ref) {
  const at = ref ? this.children.indexOf(ref) : -1;
  n.parentNode = this;
  if (at < 0) this.children.push(n);
  else this.children.splice(at, 0, n);
  return n;
};
Object.defineProperty(El.prototype, "nextSibling", {
  get() {
    const p = this.parentNode;
    return p ? p.children[p.children.indexOf(this) + 1] || null : null;
  },
});
El.prototype.remove = function () {
  if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
  this.parentNode = null;
};
El.prototype.contains = function (n) {
  for (let x = n; x; x = x.parentNode) if (x === this) return true;
  return false;
};
El.prototype.closest = function (sel) {
  for (let x = this; x && x.tagName; x = x.parentNode) if (x.matches(sel)) return x;
  return null;
};


const RULES = {
  min: 100,
  caps: { straight: 5000, split: 10000, street: 15000, corner: 20000, line: 30000, outside: 50000 },
  kinds: { trio: "street", first_four: "corner", dozen: "outside", column: "outside", red: "outside", black: "outside", even: "outside", odd: "outside", low: "outside", high: "outside" },
  max_spin: 100000,
  max_positions: 30,
  max_actions: 20,
  max_players: 30,
  max_people: 35,
  bet_secs: 25,
  spin_secs: 12,
  result_secs: 6,
  bank_straight: null,
};
const ID = "abcdef0123";
function view(phase, me, extra) {
  const now = Date.now();
  return {
    ok: true,
    now,
    table: Object.assign(
      {
        id: ID, game: "roulette", status: "open", phase, round_no: 7, last_revealed: 6, lobby: true, host: "Pepe", rooms: [], adverts: [],
        history: [{ round_no: 5, number: 14 }, { round_no: 6, number: 0 }], rules: RULES, limits: { rl_min_bet: 100, rl_max_spin: 100000 },
        deadline: phase === "betting" ? now + 20000 : null, land_at: phase === "spinning" ? now + 9000 : null,
        result_until: phase === "result" ? now + 5000 : null, spin: null, commit_round: 7, commitment: "ab", client_seed: "cd",
        totals: { players: 0, staked: 0 }, seats: [], felt: [], high_stakes: false, theme: "classic",
      },
      extra || {},
    ),
    me: me === null ? null : Object.assign(
      { name: "Mia", balance: 500000, banned: false, admin: false, host: false, lines: [], staked: 0, pending: null, last_slip: null,
        room_left: 100000, net: null, private_note: null, notice: null, seat: null, high_roller: false, used: { positions: 0, actions: 0, per_token: {} } },
      me || {},
    ),
  };
}
/** views/casino-rl.ejs's elements, a stub CZ (casino-ui.js) and wheel module, then the page's scripts as the page loads them */
function page(opts) {
  opts = opts || {};
  const posts = [];
  const W = makeWindow((url, o) => {
    if (o && o.method === "POST") {
      const body = JSON.parse(o.body);
      posts.push({ url, body });
      return (opts.reply && opts.reply(body)) || { ok: true, reply: "ok" };
    }
    return String(url).startsWith("/api/casino/lobby") ? { ok: true, roulette: { wheels: [] } } : { ok: false };
  });
  const el = (tag, id, kids) => {
    const e = new El(tag);
    if (id) e.setAttribute("id", id);
    if (kids) e.append(...kids);
    return e;
  };
  const canvas = el("canvas", "rl-wheel");
  canvas.getContext = () => ({});
  const bowl = el("div", "rl-bowl", [canvas]);
  const scrolled = [];
  bowl.scrollIntoView = (o) => scrolled.push(o);
  // (views/casino-rl.ejs: no .rl-title row - review: Pepe's line and the rail's head say the phase and the layout - and no #rl-proof)
  const root = el("main", "cb", [
    el("section", "cz-table", [
      el("div", "cz-felt", [
        bowl,
        el("div", "cz-msg"), el("p", "rl-net"), el("div", "cz-fclock"),
        el("div", "rl-modes"), el("output", "rl-instruction"),
        el("div", "rl-board", [el("div", "rl-grid"), el("div", "rl-outside")]),
        el("p", "rl-tip"), el("div", "rl-race"), el("ol", "rl-history"), el("button", "rl-statsbtn"), el("button", "rl-quick"), el("button", "rl-keys"),
      ]),
      el("div", "cz-meta"), el("div", "cz-watchbar"), el("section", "rl-players"), el("div", "cz-dock"), el("p", "rl-session"),
      el("nav", "rl-wheels"), el("div", "rl-float"),
    ]),
    el("button", "cz-histbtn"),
    el("dialog", "rl-stats", [el("div", "rl-stats-b")]),
  ]);
  const $ = (id) => [root, ...root.all()].find((e) => e.attrs.id === id || e.id === id) || null;
  const listeners = {},
    events = [],
    said = [];
  if (opts.io) W.IntersectionObserver = opts.io;
  Object.assign(W.document, {
    createElementNS: (ns, tag) => new El(tag),
    querySelector: () => null,
    getElementById: $,
    addEventListener: (type, fn) => (listeners[type] = listeners[type] || []).push(fn),
    dispatchEvent: (e) => { events.push(e); for (const fn of listeners[e.type] || []) fn(e); return true; },
  });
  W.CustomEvent = function (type, init) { this.type = type; this.detail = init && init.detail; };
  W.matchMedia = (q) => ({ matches: !!(opts.media && opts.media[q]), addEventListener() {} });
  if (opts.session) W.sessionStorage = opts.session;
  if (opts.local) W.localStorage = opts.local;
  const calls = [];
  const wheelApi = {};
  for (const k of ["setSkew", "spin", "rest", "idle", "setTilt", "setPalette", "setReduced"]) wheelApi[k] = (...a) => { calls.push([k, ...a]); return wheelApi; };
  W.PATVRlWheel = { WHEEL: RLW.WHEEL, mount: (c, o) => { calls.push(["mount", c === canvas, o]); return wheelApi; } };
  const fill = (d, v) => String(d).replace(/\{(\w+)\}/g, (m, n) => (v && v[n] != null ? v[n] : m));
  const pops = [],
    clocks = [];
  const CZ = (W.CZ = {
    tableId: ID, signed: opts.signed !== false, $,
    T: (k, d, v) => fill(typeof d === "object" ? (v && v.count === 1 ? d.one : d.other) : d, v),
    fmt: (n) => Math.trunc(Number(n) || 0).toLocaleString("en-US"),
    short: (n) => (n >= 1e6 ? +(n / 1e6).toFixed(1) + "M" : n >= 1e3 ? +(n / 1e3).toFixed(1) + "K" : String(n)),
    skew: () => 42,
    esc: (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]),
    pileHTML: (n) => `<span class="pile">${n}</span>`,
    stackHTML: (n) => `<span class="stack">${n}</span>`,
    avatarHTML: (s) => `<span class="av${s.veil ? " veil" : ""}"></span>`,
    seatWho: (s, inner) => inner,
    net: (n) => `<span class="net">${n}</span>`,
    pop: (elx, text, kind) => pops.push([elx, text, kind]),
    armClock: (elx, dl, secs) => clocks.push([elx && elx.attrs.id, dl, secs]),
    announce: (s) => said.push(s), note() {}, toast() {}, theme() {},
    openSheet: (id) => { $(id).open = true; },
    loadHistory(fn) { CZ.row = fn; },
    actor: () => async () => ({}),
    wireHost() {},
    startTable(render) { CZ.render = render; return async () => {}; },
  });
  for (const f of ["public/js/patamount.js", "casino/rlbets.js", "public/js/casinorl-dock.js", "public/js/casinorl.js"]) W.run(read(f), f);
  const spots = (token) => $("rl-grid").all().concat($("rl-outside").all()).filter((e) => e.tagName === "BUTTON" && e.dataset.token === token);
  const stk = (token) => spots(token)[0].children.find((c) => c.classList.contains("rl-stk"));
  const press = (key, target, extra) => {
    const e = Object.assign({ type: "keydown", key, target: target || W.document.body, ctrlKey: false, metaKey: false, altKey: false, repeat: false, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }, extra || {});
    for (const fn of listeners.keydown || []) fn(e);
    return e;
  };
  const fireDoc = (type, e) => { for (const fn of listeners[type] || []) fn(Object.assign({ type, preventDefault() {} }, e)); };
  /** b focused as Chrome on Windows does on a mouse click (or Android on a tap: how = "touch") - or by the keyboard (how = "key": Tab) */
  const focusBy = (b, how) => {
    if (how === "key") press("Tab", b);
    else fireDoc("pointerdown", { target: b, pointerType: how || "mouse", button: 0 });
    fireDoc("focusin", { target: b });
    if (how !== "key") fireDoc("pointerup", { target: b, pointerType: how || "mouse" });
    return b;
  };
  const release = (key, target) => {
    const e = { type: "keyup", key, target: target || W.document.body, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const fn of listeners.keyup || []) fn(e);
    return e;
  };
  return { W, CZ, $, root, posts, calls, events, pops, clocks, spots, stk, press, release, said, scrolled, focusBy };
}
const seat = (name, sid, chips, extra) =>
  Object.assign({ name, seat: sid, host: false, staked: chips.reduce((a, c) => a + c[1], 0), chips }, extra || {});

test("D5 / O10: the felt shows everyone's chips per spot - mine on top with the gold ring, others in their seat colour, total and count", () => {
  const P = page();
  const d = view("betting", { seat: "s2", lines: [{ text: "17 500", amount: 500 }], staked: 500, used: { positions: 1, actions: 1, per_token: { 17: 500 } } }, {
    seats: [seat("Rocco", "s1", [["17", 1000], ["red", 2500]]), seat("Mia", "s2", [["17", 500]]), seat("frog 7", "s3", [["17", 100]], { veil: 1 })],
    felt: [{ t: "17", n: 1600, k: 3 }, { t: "red", n: 2500, k: 1 }],
    totals: { players: 3, staked: 4100 },
  });
  P.CZ.render(d);
  const s17 = P.stk("17");
  assert.match(s17.className, /\brl-stk\b.*\bmine\b.*\bon\b/);
  assert.match(s17.innerHTML, /class="chip c500 rl-top"/, "my 500 on top, ringed");
  assert.equal((s17.innerHTML.match(/class="chip rl-oc"/g) || []).length, 2, "the two others' chips (a masked seat's too, under its label)");
  assert.match(s17.innerHTML, /--c:#4fc3f7/, "Rocco: seat 1's colour");
  assert.match(s17.innerHTML, /<b class="rl-amt">1\.6K<\/b>/, "the spot's total");
  assert.match(s17.innerHTML, /<i class="rl-k">3<\/i>/, "three players on it");
  const red = P.stk("red");
  assert.doesNotMatch(red.className, /\bmine\b/);
  assert.match(red.innerHTML, /2\.5K/);
  assert.equal(P.stk("18").className, "rl-stk", "an empty spot draws nothing");
  // the spot's spoken name: the felt's words, what it pays, its cap, my bet, everyone's - and WHO else (review, WCAG 1.4.1: the
  // others' chips are told apart by seat colour on the felt, so the line names them; a masked seat by its label)
  assert.equal(P.spots("17")[0].getAttribute("aria-label"), "17 ● Black · Number · pays 35 to 1 · up to 5,000 PAT · your bet 500 PAT · 1,600 PAT on it from 3 players (Rocco 1,000, frog 7 100)");
  assert.equal(P.spots("17")[0].title, P.spots("17")[0].getAttribute("aria-label"), "the hover title too");
  assert.equal(P.spots("red")[0].getAttribute("aria-label"), "◆ Red · Even money · pays 1 to 1 · up to 50,000 PAT · your bet 0 PAT · 2,500 PAT on it from 1 player (Rocco 2,500)");
  assert.match(P.spots("17-20")[0].getAttribute("aria-label"), /^17–20 · Split · pays 17 to 1 · up to 10,000 PAT · your bet 0 PAT$/);
  assert.match(P.spots("d2")[0].getAttribute("aria-label"), /^13–24 · Dozen · pays 2 to 1 · up to 50,000 PAT/);
  // the players rail: the biggest stake first, my seat marked, a masked seat by its label - one row per seat
  const rows = P.$("rl-players").querySelectorAll("li");
  assert.deepEqual(rows.map((li) => li.dataset.seat), ["s1", "s2", "s3"], "Rocco 3,500 · Mia 500 · frog 7 100");
  assert.equal(rows[1].className, "seat me");
  assert.match(rows[1].children[0].innerHTML, /Mia · you/);
  assert.match(rows[2].children[0].innerHTML, /<span class="av veil"><\/span><span class="plate"><span class="nm">frog 7<\/span>/);
  assert.match(rows[0].children[1].innerHTML, /^<span class="sub"><span class="stack">3500<\/span><\/span>$/, "the stake beside the person button");
  assert.match(P.$("rl-players").querySelector(".rl-ph").textContent, /Layout: 3 players · 4,100 PAT/);
  assert.doesNotMatch(rows.map((li) => li.children.map((c) => c.innerHTML).join("")).join(""), /uid|userId/);
  // the per-viewer "Others' bets" toggle: only mine stays
  const toggle = P.$("rl-others");
  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  toggle.click();
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  assert.doesNotMatch(P.stk("17").innerHTML, /rl-oc/);
  assert.match(P.stk("17").innerHTML, /<b class="rl-amt">500<\/b>/);
  assert.equal(P.stk("red").className, "rl-stk");
});

test("O11 / contract 7: the wheel module is mounted on the page's canvas and driven by the view on the site clock", () => {
  const P = page({ media: { "(min-width:900px) and (pointer:fine)": true } });
  const m = P.calls.find((c) => c[0] === "mount");
  assert.ok(m && m[1], "PATVRlWheel.mount(canvas)");
  assert.equal(m[2].tilt, 38, "a desktop's CSS tilt");
  assert.equal(typeof m[2].onEvent, "function", "the ball's moments reach the sound cues");
  const cues = [];
  P.W.CZSound = { cue: (n) => cues.push(n) };
  for (const e of ["launch", "drop", "diamond", "rotor", "hop", "settle"]) m[2].onEvent(e, {});
  assert.deepEqual(cues, ["rl_launch", "rl_drop", "rl_diamond", "rl_rotor", "rl_hop", "rl_settle"], "casino-sound.js's roulette cues");
  const at = () => P.calls.length;
  let n = at();
  P.CZ.render(view("betting", {}));
  assert.deepEqual(P.calls.slice(n).map((c) => c[0]), ["setSkew", "idle"]);
  assert.equal(P.calls[n][1], 42, "setSkew(CZ.skew())");
  const spin = { round_no: 7, number: 26, color: "black", started_at: Date.now() - 1000, ends_at: Date.now() + 11000, secs: 12 };
  n = at();
  const sv = view("spinning", {}, { spin });
  P.CZ.render(sv);
  assert.deepEqual(P.calls.slice(n).map((c) => c[0]), ["setSkew", "spin"]);
  assert.equal(P.calls[n + 1][1], sv.table, "spin(view.table): it plans from spin.started_at / ends_at and lands on spin.number");
  n = at();
  P.CZ.render(view("result", {}, { last_round: { round_no: 7, number: 26 } }));
  assert.deepEqual(P.calls.slice(n).map((c) => c[0]), ["setSkew", "rest"]);
  assert.equal(P.calls[n + 1][1], 26, "rest(last_round.number): the server's pocket");
  n = at();
  P.CZ.render(view("idle", {}, { high_stakes: true }));
  assert.deepEqual(P.calls.slice(n).map((c) => c[0]), ["setPalette", "setSkew", "idle"]);
  assert.equal(P.calls[n][1], "hr", "a High Roller wheel's ebony and gold");
  // the page loads the module from the site (contract 7) and the canvas is there
  const v = read("views/casino-rl.ejs");
  assert.match(v, /<canvas id="rl-wheel"/);
  assert.match(v, /<script src="\/api\/casino\/rlwheel\.js\?v=2"><\/script><script src="\/public\/js\/casinorl-dock\.js\?v=4"><\/script><script src="\/public\/js\/casinorl\.js\?v=4"><\/script>/);
});

test("contract 8 / O13(2) / O13(3): the croupier's lines, the result moment and its client events (live only), the covering spots", async () => {
  const P = page();
  const me = { seat: "s1", lines: [{ text: "26 100 · black 200", amount: 300 }], staked: 300 };
  const chips = [seat("Mia", "s1", [["26", 100], ["black", 200]]), seat("Rocco", "s2", [["red", 1000]])];
  const felt = [{ t: "26", n: 100, k: 1 }, { t: "black", n: 200, k: 1 }, { t: "red", n: 1000, k: 1 }];
  P.CZ.render(view("betting", me, { seats: chips, felt, deadline: Date.now() + 20000 }));
  assert.match(P.$("cz-msg").innerHTML, /^Place your bets<small>Spin 7<\/small>/);
  const ring = P.clocks.filter((c) => c[0] === "cz-fclock").at(-1);
  assert.ok(ring[1] > Date.now() + 15000 && ring[2] === 25, "the felt's ring on the betting deadline");
  P.CZ.render(view("betting", me, { seats: chips, felt, deadline: Date.now() + 4000 }));
  assert.match(P.$("cz-msg").innerHTML, /^Last bets…/, "5 s left");
  P.CZ.render(view("idle", {}));
  assert.match(P.$("cz-msg").innerHTML, /The clock starts with the first bet\./);
  const spin = { round_no: 7, number: 26, color: "black", started_at: Date.now() - 500, ends_at: Date.now() + 11500, secs: 12 };
  P.CZ.render(view("spinning", me, { spin, seats: chips, felt }));
  assert.match(P.$("cz-msg").innerHTML, /^No more bets/);
  const spinEv = P.events.find((e) => e.type === "cz:rl-spin");
  assert.deepEqual(plain(spinEv.detail), { table: ID, round: 7, pocket: 26, startedAt: spin.started_at, landAt: spin.ends_at });
  P.CZ.render(view("result", Object.assign({}, me, { net: 3300 }), {
    last_round: { round_no: 7, number: 26 }, seats: [Object.assign({}, chips[0], { net: 3300 }), Object.assign({}, chips[1], { net: -1000 })], felt,
  }));
  assert.match(P.$("cz-msg").innerHTML, /^26 black<small>Spin 7<\/small>/);
  assert.equal(P.$("rl-net").textContent, "Your net +3,300 PAT");
  const res = P.events.filter((e) => e.type === "cz:rl-result");
  assert.equal(res.length, 1);
  assert.deepEqual(plain(res[0].detail), { table: ID, round: 7, pocket: 26, net: 3300 });
  // the winning number, every covering spot (black, even, 19-36, the third dozen, column 2, 26's splits / corners / streets)
  assert.ok(P.spots("26")[0].classList.contains("won"));
  for (const t of ["26", "black", "even", "high", "d3", "c2", "25-26", "26-29", "25-26-28-29", "25-26-27"]) assert.ok(P.spots(t)[0].classList.contains("hit"), t);
  for (const t of ["red", "odd", "low", "d1", "c1", "27"]) assert.ok(!P.spots(t)[0].classList.contains("hit"), t);
  assert.match(P.stk("red").className, /\blost\b/, "the losing pile is raked");
  assert.match(P.stk("black").className, /\bhit\b/);
  assert.ok(P.$("rl-board").classList.contains("raking"), "seen land: the rake runs");
  assert.ok(P.spots("26")[0].children.some((c) => c.classList.contains("rl-burst")), "a straight-up hit's gold burst");
  assert.ok(P.spots("26")[0].classList.contains("pulse"), "seen land: the winning number pulses");
  // the pops come a moment later, over the winners' rail rows only and my winning spots
  for (const t of P.W.timers.filter((x) => !x.done && x.ms === 350)) { t.done = true; t.fn(); }
  assert.ok(P.pops.some((p) => p[1] === "+3.5K" && p[2] === "win"), "26 straight up: 100 at 35 to 1");
  assert.ok(P.pops.some((p) => p[1] === "+3,300" && p[0].dataset.seat === "s1"), "over Mia's row in the rail");
  assert.ok(!P.pops.some((p) => p[0].dataset && p[0].dataset.seat === "s2"), "never over a loser");
  assert.ok(P.pops.every((p) => p[2] === "win"));
  for (const t of P.W.timers.filter((x) => !x.done && x.ms === 3700)) { t.done = true; t.fn(); }
  assert.ok(!P.spots("26")[0].classList.contains("pulse"), "the pulse ends; the highlight stays");
  assert.ok(P.spots("26")[0].classList.contains("won"));
  // a page that OPENS on a result: no rake, no burst, no pops (and the event once)
  const Q = page();
  Q.CZ.render(view("result", me, { last_round: { round_no: 7, number: 26 }, seats: chips, felt }));
  assert.ok(!Q.$("rl-board").classList.contains("raking"));
  assert.ok(!Q.spots("26")[0].children.some((c) => c.classList.contains("rl-burst")));
  assert.ok(Q.spots("26")[0].classList.contains("won"), "the highlight is state, not motion");
  assert.ok(!Q.spots("26")[0].classList.contains("pulse"), "review: no pulse on a page that opens on a result");
});

test("O13(2): under reduced motion the result moment has no motion (no rake animation, no burst) but keeps its highlight", () => {
  const P = page({ media: { "(prefers-reduced-motion:reduce)": true } });
  const me = { seat: "s1", lines: [{ text: "26 100", amount: 100 }], staked: 100 };
  const chips = [seat("Mia", "s1", [["26", 100]])],
    felt = [{ t: "26", n: 100, k: 1 }];
  P.CZ.render(view("spinning", me, { spin: { round_no: 7, number: 26, started_at: Date.now(), ends_at: Date.now() + 12000, secs: 12 }, seats: chips, felt }));
  P.CZ.render(view("result", me, { last_round: { round_no: 7, number: 26 }, seats: chips, felt }));
  assert.ok(!P.$("rl-board").classList.contains("raking"));
  assert.ok(!P.spots("26")[0].children.some((c) => c.classList.contains("rl-burst")));
  assert.ok(P.spots("26")[0].classList.contains("won"));
  const css = read("views/partials/casino-rl-css.ejs");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.rl-board\.raking \.rl-stk\.lost,\s*\.rl-grid button\.won\.pulse \{\s*animation: none !important;\s*\}\s*\.rl-burst \{\s*display: none;/);
  assert.ok(!P.spots("26")[0].classList.contains("pulse"), "no pulse");
});

test("D8 call bets: Voisins / Tiers / Orphelins / Neighbours ±2 each go as ONE ordinary line (the selected chip is the unit)", async () => {
  const P = page();
  P.CZ.render(view("betting", {}));
  const race = P.$("rl-race").children.filter((c) => c.tagName === "BUTTON");
  assert.deepEqual(race.map((b) => b.dataset.call || b.id), ["voisins", "tiers", "orphelins", "rl-nb"]);
  assert.deepEqual(race.map((b) => b.children[0].textContent), ["9 chips", "6 chips", "5 chips", "5 chips"], "Voisins is 9 chips (17 numbers)");
  assert.match(race[0].getAttribute("aria-label"), /^Voisins du zéro: 9 chips on the numbers 0, 2, 3, 4, 7, 12, 15, 18, 19, 21, 22, 25, 26, 28, 29, 32, 35$/);
  race[0].onclick();
  await P.W.settle();
  assert.equal(P.posts.length, 1, "one line");
  assert.deepEqual(plain(P.posts[0].body.bets), [
    { b: "0-2-3", a: "200" }, { b: "4-7", a: "100" }, { b: "12-15", a: "100" }, { b: "18-21", a: "100" }, { b: "19-22", a: "100" },
    { b: "32-35", a: "100" }, { b: "25-26-28-29", a: "200" },
  ]);
  for (const b of P.posts[0].body.bets) assert.ok(G.positions[b.b], b.b + " is an ordinary position");
  assert.equal(P.posts[0].body.verb, "bet");
  assert.match(P.posts[0].body.idem, /^uuid-/);
  race[1].onclick();
  await P.W.settle();
  assert.deepEqual(P.posts[1].body.bets.map((b) => b.b), ["5-8", "10-11", "13-16", "23-24", "27-30", "33-36"]);
  race[2].onclick();
  await P.W.settle();
  assert.deepEqual(P.posts[2].body.bets.map((b) => b.b), ["1", "6-9", "14-17", "17-20", "31-34"]);
  // Neighbours: arm it, then a number - that number and two either side on the wheel (0: 3, 26, 0, 32, 15)
  race[3].onclick();
  assert.equal(race[3].getAttribute("aria-pressed"), "true");
  P.spots("0")[0].onclick();
  await P.W.settle();
  assert.deepEqual(plain(P.posts[3].body.bets), ["3", "26", "0", "32", "15"].map((b) => ({ b, a: "100" })));
  assert.equal(race[3].getAttribute("aria-pressed"), "false", "one call, then the board bets numbers again");
  assert.equal(new Set(P.posts.map((p) => p.body.idem)).size, 4, "an idempotency key per line");
  // over a cap: refused at once with the reason, nothing sent (25K chip: 2 x 25K on 0-2-3 is over the street cap)
  P.press("5");
  race[0].onclick();
  await P.W.settle();
  assert.equal(P.posts.length, 4);
  assert.match(P.$("cz-dock").querySelector(".rl-feedback").textContent, /^0–2–3: the most per player is 15,000 PAT a spin — you have 0 PAT there\.$/);
});

test("O13(7) / O13(8): ×2 and the keyboard - 1-5 chips, Z / C / R / D, Space spins now only for a sole bettor and never on a button", async () => {
  const P = page();
  const me = { seat: "s1", lines: [{ text: "17 500 · red 1000", amount: 1500 }], staked: 1500, used: { positions: 2, actions: 1, per_token: { 17: 500, red: 1000 } }, last_slip: "black 300" };
  P.CZ.render(view("betting", me, { totals: { players: 1, staked: 1500 }, seats: [seat("Mia", "s1", [["17", 500], ["red", 1000]])], felt: [] }));
  const chipBtns = P.$("cz-dock").querySelectorAll("button").filter((b) => b.classList.contains("chipbtn"));
  assert.deepEqual(chipBtns.map((b) => b.dataset.chip), ["100", "500", "1000", "5000", "25000"]);
  assert.equal(P.press("2").defaultPrevented, true);
  assert.deepEqual(chipBtns.map((b) => b.getAttribute("aria-pressed")), ["false", "true", "false", "false", "false"]);
  assert.equal(chipBtns[0].getAttribute("aria-keyshortcuts"), "1");
  // ×2 with chips on the layout: the same bets again, one line
  P.press("d");
  await P.W.settle();
  assert.deepEqual(plain(P.posts.at(-1).body.bets), [{ b: "17", a: "500" }, { b: "red", a: "1000" }]);
  P.press("z");
  await P.W.settle();
  assert.equal(P.posts.at(-1).body.verb, "undo");
  P.press("c");
  await P.W.settle();
  assert.equal(P.posts.at(-1).body.verb, "clear");
  P.press("r");
  await P.W.settle();
  assert.equal(P.posts.at(-1).body.verb, "rebet");
  // Space: the sole bettor's Spin now - not while a button has the focus (Space presses that button), not while typing
  const n = P.posts.length;
  P.press(" ", Object.assign(new El("button"), {}));
  P.press(" ", new El("input"));
  P.press("z", new El("textarea"));
  await P.W.settle();
  assert.equal(P.posts.length, n);
  P.press(" ");
  await P.W.settle();
  assert.equal(P.posts.at(-1).body.verb, "go");
  // two players on the layout: no Spin now, Space does nothing
  P.CZ.render(view("betting", me, { totals: { players: 2, staked: 3000 } }));
  const m = P.posts.length;
  P.press(" ");
  await P.W.settle();
  assert.equal(P.posts.length, m);
  // ×2 with nothing on the layout: the last spin's slip, doubled
  P.CZ.render(view("betting", { last_slip: "black 300 · 5 100", lines: [], staked: 0 }));
  P.press("d");
  await P.W.settle();
  assert.deepEqual(plain(P.posts.at(-1).body.bets), [{ b: "black", a: "600" }, { b: "5", a: "200" }]);
});

test("O7: a chip is checked against the spot's cap, the spots and the spin's maximum first; the server's refusal codes read in numbers", async () => {
  let reply = null;
  const P = page({ reply: () => reply });
  const me = { seat: "s1", lines: [{ text: "17 4900", amount: 4900 }], staked: 4900, used: { positions: 1, actions: 1, per_token: { 17: 4900 } } };
  P.CZ.render(view("betting", me, { seats: [seat("Mia", "s1", [["17", 4900]])], felt: [{ t: "17", n: 4900, k: 1 }] }));
  const fb = () => P.$("cz-dock").querySelector(".rl-feedback").textContent;
  P.press("2");                                       // 500 on 17: 4,900 + 500 > 5,000
  P.spots("17")[0].onclick();
  assert.equal(fb(), "17 ● Black: the most per player is 5,000 PAT a spin — you have 4,900 PAT there.");
  assert.equal(P.W.timers.filter((t) => !t.done && t.ms === 900).length, 0, "nothing queued");
  // hovering a spot dims the chips that no longer fit on it
  P.spots("17")[0].onfocus();
  const over = P.$("cz-dock").querySelectorAll("button").filter((b) => b.classList.contains("over")).map((b) => b.dataset.chip);
  assert.deepEqual(over, ["500", "1000", "5000", "25000"]);
  assert.match(P.$("rl-tip").textContent, /^17 ● Black · Number · pays 35 to 1 · up to 5,000 PAT · your bet 4,900 PAT/);
  assert.ok(P.spots("17")[0].classList.contains("cov"));
  P.spots("17")[0].onblur();
  assert.equal(P.$("rl-tip").textContent, "");
  // the spin's maximum
  P.CZ.render(view("betting", { lines: [{ text: "red 50000 · black 49900", amount: 99900 }], staked: 99900, room_left: 100,
    used: { positions: 2, actions: 2, per_token: { red: 50000, black: 49900 } } }));
  P.spots("d1")[0].onclick();
  assert.equal(fb(), "Your total this spin would be 100,400 PAT — the most per player per spin is 100,000 PAT.");
  assert.match(P.$("cz-dock").querySelector(".rl-meter").textContent, /^On the layout 99,900 PAT · 100 PAT left this spin$/);
  // the server's own refusal with its code: the numbers, in the felt's words
  P.CZ.render(view("betting", {}));
  reply = { ok: false, reply: "That line exceeds your per-spin limit.", code: "E_SPIN", max: 100000, have: 99800 };
  P.press("1");
  P.spots("d1")[0].onclick();
  const t = P.W.timers.filter((x) => !x.done && x.ms === 900).pop();
  t.done = true;
  await t.fn();
  await P.W.settle();
  assert.equal(fb(), "Your total this spin would be 99,900 PAT — the most per player per spin is 100,000 PAT.");
  reply = { ok: false, reply: "🏦 The wheel can take at most 300 more on d1 this spin.", code: "E_BANK", more: 300, token: "d1" };
  P.spots("d1")[0].onclick();
  const t2 = P.W.timers.filter((x) => !x.done && x.ms === 900).pop();
  t2.done = true;
  await t2.fn();
  await P.W.settle();
  assert.equal(fb(), "The wheel can take at most 300 PAT more on 1–12 this spin.", "never the raw d1");
});

test("O7 / contract 9: the chip rack - the casino's chips up to the wheel's largest cap; 💎 chips on a High Roller wheel", () => {
  const R = page().W.PATVRoulette;
  const vals = (t, me) => plain(R.rackFor(t, me).map((c) => c[0] + (c[1] ? ":" + c[1] : "")));
  assert.deepEqual(vals({ rules: RULES }, {}), ["100", "500:c500", "1000:c1k", "5000:c5k", "25000:c25k"]);
  assert.deepEqual(vals({ rules: RULES }, { high_roller: true }), ["100", "500:c500", "1000:c1k", "5000:c5k", "25000:c25k"], "no 💎 chip fits a 50,000 cap");
  const HR = { min: 1000, caps: { straight: 25000, split: 50000, street: 75000, corner: 100000, line: 150000, outside: 250000 }, max_spin: 500000 };
  assert.deepEqual(vals({ rules: HR, high_stakes: true }, {}), ["1000:c1k", "5000:c5k", "25000:c25k", "100000:c100k hrc"]);
  assert.deepEqual(vals({ limits: { rl_min_bet: 100, rl_max_straight: 1000, rl_max_outside: 1000, rl_max_spin: 100000 } }, {}), ["100", "500:c500", "1000:c1k"], "an older server's limits");
  const P = page();
  P.CZ.render(view("betting", {}, { rules: Object.assign({}, HR, { kinds: RULES.kinds }), high_stakes: true }));
  const chips = P.$("cz-dock").querySelectorAll("button").filter((b) => b.classList.contains("chipbtn"));
  assert.equal(chips.at(-1).className, "chipbtn hr");
  assert.equal(chips.at(-1).children[0].className, "chip c100k hrc");
  assert.equal(chips.at(-1).children[1].textContent, "100K");
  assert.equal(chips[0].getAttribute("aria-pressed"), "true", "the smallest chip first");
});

test("O7: the limits placard reads t.rules (the spin's own limits) and keeps the key limits in its folded summary", () => {
  const P = page();
  const box = P.$("rl-limits");
  assert.equal(box.tagName, "DETAILS");
  assert.equal(box.open, false, "folded until the viewer opens it (remembered)");
  P.CZ.render(view("betting", { staked: 2500, room_left: 97500 }, { rules: Object.assign({}, RULES, { caps: Object.assign({}, RULES.caps, { straight: 4000 }) }) }));
  assert.equal(box.hidden, false);
  assert.equal(box.querySelector(".rl-lim-key").textContent, "Min 100 · straight up to 4,000 · up to 100,000 PAT a spin per player");
  assert.equal(box.querySelectorAll("li")[2].textContent, "One number (straight up): up to 4,000 PAT");
  assert.equal(box.querySelector(".rl-left").textContent, "Your bets this spin: 2,500 PAT · 97,500 PAT left");
  // (review: the limits are said once - the placard on the felt - never again as a gold tag right under it)
  assert.doesNotMatch(P.$("cz-meta").innerHTML, /tag gold|Straight 4,000|a spin/);
  assert.equal(read("locales/en.json").includes('"js.casino.rl_meta_lim"'), false, "its string is gone too");
});

test("O9 / D4: the tags, the spectator ribbon (signed out, High Roller), the dock only for those who can bet", () => {
  const P = page({ signed: false });
  P.CZ.render(view("betting", null, { lobby: false, host: "Rocco", rooms: [{ id: "r1", name: "Swamp" }], on_stream: true }));
  const tags = P.$("cz-meta").innerHTML;
  assert.match(tags, /👑 Rocco/);
  assert.match(tags, /🐸 Chat room Swamp/);
  assert.match(tags, /class="tag red">📺 On Pepe&#39;s stream/);
  assert.match(P.$("cz-watchbar").innerHTML, /You&#39;re watching\. <a href="\/login">Sign in to play<\/a>/);
  assert.equal(P.$("cz-dock").hidden, true);
  const Q = page();
  Q.CZ.render(view("betting", { high_roller: false }, { high_stakes: true }));
  assert.match(Q.$("cz-watchbar").innerHTML, /^💎 A High Roller wheel: you&#39;re watching\. Only High Rollers can bet here\./);
  assert.equal(Q.$("cz-dock").hidden, true);
  assert.match(Q.$("cz-meta").innerHTML, /class="tag hr">💎 High Roller/);
  Q.CZ.render(view("betting", { high_roller: true }, { high_stakes: true }));
  assert.equal(Q.$("cz-watchbar").hidden, true);
  assert.equal(Q.$("cz-dock").hidden, false);
});

test("O13(9) / O13(10): the stats drawer always says each spin is independent (no hot / cold / due); the session line", () => {
  const store = {};
  const session = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
  const P = page({ session });
  const hist = [3, 0, 14, 14, 26, 7].map((n, i) => ({ round_no: i + 1, number: n }));
  P.CZ.render(view("betting", {}, { history: hist }));
  P.$("rl-statsbtn").listeners.click[0]();
  const html = P.$("rl-stats-b").innerHTML;
  assert.match(html, /^<p class="rl-indep">Each spin is independent: these counts say nothing about the next spin\.<\/p>/);
  assert.match(html, /The last 6 spins on this wheel\./);
  assert.match(html, /◆ Red<\/span><span class="rl-bar"><i style="width:67%"><\/i><\/span><span>4</, "3, 14, 14 and 7 of 6");
  assert.doesNotMatch(html.toLowerCase(), /\b(hot|cold|due|overdue|streak|lucky)\b/);
  const en = JSON.parse(read("locales/en.json"));
  for (const k of Object.keys(en).filter((x) => /^js\.casino\.rl_st_/.test(x))) assert.doesNotMatch(JSON.stringify(en[k]).toLowerCase(), /\b(hot|cold|due|overdue|streak|lucky)\b/, k);
  // the session: one count per spin played (a re-render of the same result doesn't count twice), net summed
  P.CZ.render(view("result", { net: 2400 }, { last_round: { round_no: 7, number: 26 } }));
  P.CZ.render(view("result", { net: 2400 }, { last_round: { round_no: 7, number: 26 } }));
  assert.equal(P.$("rl-session").textContent, "This session: 1 spin · net +2,400 PAT");
  P.CZ.render(view("result", { net: -3000 }, { round_no: 8, last_round: { round_no: 8, number: 1 } }));
  assert.equal(P.$("rl-session").textContent, "This session: 2 spins · net −600 PAT");
  assert.equal(JSON.parse(store["rl-session-v1"]).seen.length, 2);
  // blocked storage: the page still works and counts for this page only
  const Q = page({ session: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } } });
  Q.CZ.render(view("result", { net: 100 }, { last_round: { round_no: 7, number: 26 } }));
  Q.CZ.render(view("result", { net: 100 }, { last_round: { round_no: 7, number: 26 } }));
  assert.equal(Q.$("rl-session").textContent, "This session: 1 spin · net +100 PAT");
});

test("O9: the page is built on the shared parts (back link, felt, croupier, clock, meta, watchbar, players, dock) and the shared chips", () => {
  const v = read("views/casino-rl.ejs");
  // (1.99aoj: the back link is the lobby the navbar names - <%= rlLobby %>; test/casino-ui.test.js renders it)
  for (const s of ['<a class="back" href="<%= rlLobby %>">', '<div class="felt rl" id="cz-felt">', 'class="cz-who" data-pepe="1"',
    '<div class="clock" id="cz-fclock" hidden>', '<div class="felt-meta" id="cz-meta">', '<div class="watchbar" id="cz-watchbar" hidden>',
    '<section class="rl-players" id="rl-players"', '<div class="dock" id="cz-dock" hidden>', '<dialog class="sheet" id="rl-stats"'])
    assert.ok(v.includes(s), s);
  assert.match(v, /<%- include\('partials\/casino-css'\) %>\s*<link rel="stylesheet" href="\/public\/css\/casino-chips\.css\?v=1">/, "contract 9");
  assert.match(v, /casino-sound\.js\?v=3/);
  assert.match(v, /casino-ui\.js\?v=15/, "1.99aoj: the casino-ui.js the Blackjack and Hold'em pages load");
  assert.doesNotMatch(v, /rl-cabinet|rl-crown|rl-pin|<svg id="rl-wheel"/, "the old cabinet and SVG prize wheel are gone");
  const css = read("views/partials/casino-rl-css.ejs");
  assert.doesNotMatch(css, /max-width: 1480px|Georgia/);
  assert.doesNotMatch(css, /^\.(?:chip|chipbtn|rl-pocket|pile|stack)\b[^{]*\{/m, "the chips and pockets themselves stay in casino-chips.css");
  // contract 9: chip classes only (the page and the dock never invent chip classes of their own)
  const js = read("public/js/casinorl.js") + read("public/js/casinorl-dock.js");
  const used = new Set();
  // (the literal class lists; the denomination one is built from the DEN / HDEN lists checked below)
  for (const m of js.matchAll(/class="chip ?([^"']*)"/g)) for (const c of m[1].split(/\s+/).filter(Boolean)) used.add(c);
  for (const m of js.matchAll(/" rl-top"/g)) used.add("rl-top");
  for (const m of read("public/js/casinorl.js").matchAll(/\[\d+, "([a-z0-9 ]*)"\]/g)) for (const c of m[1].split(" ").filter(Boolean)) used.add(c);
  for (const c of used) assert.ok(/^(?:c500|c1k|c5k|c25k|cmax|c100k|c500k|c1m|c5m|hrc|rl-oc|rl-top)$/.test(c), "chip class " + c);
  assert.ok(used.has("rl-oc") && used.has("rl-top"));
});

test("O13(4): the roulette cues in casino-sound.js - off by default, only after a gesture, the table's toggle on a classic wheel", () => {
  const src = read("public/js/casino-sound.js");
  assert.match(src, /window\.CZSound = \{ update, cue, enabled: \(\) => on \};/);
  assert.match(src, /if \(t && t\.game === "roulette"\) \{ roulette = true;/);
  assert.match(src, /function cue\(name\) \{\s*if \(!on \|\| !gesture \|\| document\.hidden \|\| !CUES\[name\]\) return;/);
  for (const c of ["rl_launch", "rl_drop", "rl_diamond", "rl_rotor", "rl_hop", "rl_settle"]) assert.match(src, new RegExp("\\b" + c + ": \\(c, t\\) =>"), c);
  // a vm run: the toggle shows on a roulette table (classic) and stays silent until a click
  const W = makeWindow(() => ({}));
  const back = new El("a");
  back.className = "back";
  const wrap = new El("section");
  wrap.append(back);
  W.document.querySelector = (s) => (s === "#cz-table > .back" ? back : null);
  W.document.addEventListener = () => {};
  let made = 0;
  W.AudioContext = function () { made++; this.state = "running"; this.currentTime = 0; };
  W.localStorage = { getItem: () => null, setItem() {} };
  W.CZ = { T: (k, d) => d };
  W.run(src, "casino-sound.js");
  W.CZSound.update("classic", { game: "roulette" });
  const btn = wrap.children.find((c) => c.id === "cz-soundbtn");
  assert.ok(btn && !btn.hidden, "the toggle beside All tables");
  assert.equal(btn.getAttribute("aria-pressed"), "false", "off by default");
  W.CZSound.cue("rl_hop");
  assert.equal(made, 0, "no audio before a gesture and the toggle");
  W.CZSound.update("classic", { game: "bj" });
  assert.equal(btn.hidden, true, "a classic card table still has none");
});

test("O11: the per-viewer ⚡ Quick spin - the wheel's reduced path and no result motion, remembered in this browser", () => {
  const kept = {};
  const local = { getItem: (k) => (k in kept ? kept[k] : null), setItem: (k, v) => { kept[k] = String(v); } };
  const P = page({ local });
  assert.equal(P.calls.find((c) => c[0] === "mount")[2].reduced, undefined, "off: the wheel follows prefers-reduced-motion");
  const q = P.$("rl-quick");
  assert.equal(q.getAttribute("aria-pressed"), "false");
  q.click();
  assert.equal(q.getAttribute("aria-pressed"), "true");
  assert.deepEqual(P.calls.at(-1), ["setReduced", true]);
  assert.equal(kept["rl-quick"], "1");
  const me = { seat: "s1", lines: [{ text: "26 100", amount: 100 }], staked: 100 };
  const chips = [seat("Mia", "s1", [["26", 100]])],
    felt = [{ t: "26", n: 100, k: 1 }];
  P.CZ.render(view("spinning", me, { spin: { round_no: 7, number: 26, started_at: Date.now(), ends_at: Date.now() + 12000, secs: 12 }, seats: chips, felt }));
  P.CZ.render(view("result", me, { last_round: { round_no: 7, number: 26 }, seats: chips, felt }));
  assert.ok(!P.$("rl-board").classList.contains("raking"), "no rake");
  assert.ok(P.spots("26")[0].classList.contains("won"), "the highlight stays");
  assert.ok(!P.spots("26")[0].classList.contains("pulse"), "review: no pulse under Quick spin either");
  assert.ok(P.$("cb").classList.contains("rl-quick"), "the page's class (the rail's winner glow stops too)");
  assert.match(read("views/partials/casino-rl-css.ejs"), /\.rl-quick \.seat\.winner \.av \{\s*animation: none;/);
  const Q = page({ local });
  assert.equal(Q.calls.find((c) => c[0] === "mount")[2].reduced, true, "a reload keeps it");
  q.click();
  assert.deepEqual(P.calls.at(-1), ["setReduced", null], "off again: back to the system setting");
  assert.ok(!P.$("cb").classList.contains("rl-quick"));
});

// ── 1.99aoj review fixes ──
const SOLE = () => ({
  me: { seat: "s1", lines: [{ text: "17 100", amount: 100 }], staked: 100, used: { positions: 1, actions: 1, per_token: { 17: 100 } }, last_slip: "black 300" },
  extra: { totals: { players: 1, staked: 100 }, seats: [seat("Mia", "s1", [["17", 100]])], felt: [{ t: "17", n: 100, k: 1 }] },
});
test("review: Space after a MOUSE click on a spot is the table's (Spin now for a sole bettor), never that spot again; Tab-focused buttons keep Space", async () => {
  const P = page();
  const s = SOLE();
  P.CZ.render(view("betting", s.me, s.extra));
  const spot17 = P.focusBy(P.spots("17")[0], "mouse");
  let e = P.press(" ", spot17);
  assert.equal(e.defaultPrevented, true, "the browser never presses the mouse-focused spot on the key's release");
  assert.equal(P.release(" ", spot17).defaultPrevented, true, "(its keyup too)");
  await P.W.settle();
  assert.deepEqual(P.posts.map((p) => p.body.verb), ["go"], "Spin now - no second chip on 17");
  // not a sole bettor: Space on a mouse-focused spot still never places a chip there (and nothing is sent)
  P.CZ.render(view("betting", s.me, Object.assign({}, s.extra, { totals: { players: 2, staked: 900 } })));
  e = P.press(" ", P.focusBy(P.spots("17")[0], "mouse"));
  assert.equal(e.defaultPrevented, true);
  await P.W.settle();
  assert.equal(P.posts.length, 1);
  // the same after ×2 / a call bet clicked with the mouse
  const race = P.$("rl-race").children.filter((c) => c.tagName === "BUTTON");
  assert.equal(P.press(" ", P.focusBy(race[0], "mouse")).defaultPrevented, true);
  // a button the KEYBOARD focused (Tab): Space is its own - the page doesn't touch it
  P.CZ.render(view("betting", s.me, s.extra));
  e = P.press(" ", P.focusBy(P.spots("17")[0], "key"));
  assert.equal(e.defaultPrevented, false);
  assert.equal(P.release(" ").defaultPrevented, false);
  await P.W.settle();
  assert.equal(P.posts.length, 1, "nothing sent");
});

test("review: Space on the page spins only while the board is in view (otherwise it scrolls, as it always did)", async () => {
  let seen = null;
  const io = function (fn) { this.observe = (el) => { if (el.attrs.id === "rl-board") seen = fn; }; };
  const P = page({ io });
  const s = SOLE();
  P.CZ.render(view("betting", s.me, s.extra));
  seen([{ isIntersecting: false }]);
  assert.equal(P.press(" ").defaultPrevented, false, "the page scrolls");
  await P.W.settle();
  assert.equal(P.posts.length, 0);
  seen([{ isIntersecting: true }]);
  assert.equal(P.press(" ").defaultPrevented, true);
  await P.W.settle();
  assert.deepEqual(P.posts.map((p) => p.body.verb), ["go"]);
});

test("review: a held key never repeats a bet action (D / R / Z / C / Space auto-repeat sends nothing)", async () => {
  const P = page();
  const s = SOLE();
  P.CZ.render(view("betting", s.me, s.extra));
  for (const k of ["d", "r", "z", "c", " ", "D"]) {
    const e = P.press(k, undefined, { repeat: true });
    if (k !== " ") assert.equal(e.defaultPrevented, true, k + ": the repeat is swallowed");
  }
  P.press("2", undefined, { repeat: true });
  await P.W.settle();
  assert.equal(P.posts.length, 0, "no POST from a repeat");
  assert.equal(P.W.timers.filter((t) => !t.done && t.ms === 900).length, 0, "nothing queued");
  // the first press still works
  P.press("d");
  await P.W.settle();
  assert.equal(P.posts.length, 1);
  assert.deepEqual(plain(P.posts[0].body.bets), [{ b: "17", a: "100" }]);
});

test("review, WCAG 2.1.4: the shortcuts work only on the table and the viewer can turn them off (remembered); their hints follow", async () => {
  const kept = {};
  const local = { getItem: (k) => (k in kept ? kept[k] : null), setItem: (k, v) => { kept[k] = String(v); } };
  const P = page({ local });
  const s = SOLE();
  P.CZ.render(view("betting", s.me, s.extra));
  // a control off the table (the navbar, the chat), a person menu (appended to the body), a sheet: nothing
  const nav = new El("button");
  const menu = new El("div");
  menu.className = "pm-pop";
  const item = new El("button");
  menu.append(item);
  P.root.append(menu);
  for (const tg of [nav, item]) {
    for (const k of ["c", "d", "r", "z", "1"]) assert.equal(P.press(k, tg).defaultPrevented, false, k);
  }
  await P.W.settle();
  assert.equal(P.posts.length, 0, "never from off the table");
  // the ⌨ toggle: off - no shortcut, no aria-keyshortcuts hint
  const kb = P.$("rl-keys");
  assert.equal(kb.getAttribute("aria-pressed"), "true", "on by default");
  const dock = P.$("cz-dock");
  const hinted = () => dock.querySelectorAll("button").filter((b) => b.getAttribute("aria-keyshortcuts")).map((b) => b.getAttribute("aria-keyshortcuts"));
  assert.deepEqual(hinted(), ["1", "2", "3", "4", "5", "Z", "C", "R", "D", "Space"]);
  kb.click();
  assert.equal(kb.getAttribute("aria-pressed"), "false");
  assert.equal(kept["rl-keys"], "0");
  assert.deepEqual(hinted(), [], "the hints go with them");
  for (const k of ["d", "c", " ", "2"]) assert.equal(P.press(k).defaultPrevented, false, k);
  await P.W.settle();
  assert.equal(P.posts.length, 0);
  // a reload keeps it off; on again: the hints come back and D works
  const Q = page({ local });
  Q.CZ.render(view("betting", s.me, s.extra));
  assert.equal(Q.$("rl-keys").getAttribute("aria-pressed"), "false");
  assert.equal(Q.$("cz-dock").querySelectorAll("button").filter((b) => b.getAttribute("aria-keyshortcuts")).length, 0);
  Q.$("rl-keys").click();
  assert.equal(Q.$("cz-dock").querySelectorAll("button").filter((b) => b.getAttribute("aria-keyshortcuts")).length, 10);
  Q.press("d");
  await Q.W.settle();
  assert.equal(Q.posts.length, 1);
  const v = read("views/casino-rl.ejs");
  assert.match(v, /<button type="button" class="cz-btn ghost sm" id="rl-keys" aria-pressed="true" title="<%= t\('casino\.rl\.keys_help'\) %>">⌨ <%= t\('casino\.rl\.keys'\) %><\/button>/);
});

test("review: focus from a tap never leaves a spot lit as covered; the keyboard's focus previews; a blur clears only its own", () => {
  const P = page();
  P.CZ.render(view("betting", {}));
  const b14 = P.spots("14")[0];
  P.focusBy(b14, "touch");
  b14.onfocus();
  assert.ok(!b14.classList.contains("cov"), "a tap's focus (Android / Windows touch): no preview");
  assert.equal(P.$("rl-tip").textContent, "");
  P.focusBy(b14, "key").onfocus();
  assert.ok(b14.classList.contains("cov"), "Tab: the preview");
  // the mouse over 17, then a click on it moves the focus off 14: 14's blur leaves 17's preview
  P.spots("17")[0].onpointerenter({ pointerType: "mouse" });
  assert.match(P.$("rl-tip").textContent, /^17 ● Black/);
  b14.onblur();
  assert.match(P.$("rl-tip").textContent, /^17 ● Black/, "17 stays previewed");
  assert.ok(P.spots("17")[0].classList.contains("cov"));
  P.spots("17")[0].onpointerleave();
  assert.equal(P.$("rl-tip").textContent, "");
  // the call bets: the same
  const race = P.$("rl-race").children.filter((c) => c.tagName === "BUTTON");
  P.focusBy(race[1], "touch").onfocus();
  assert.ok(!P.spots("5")[0].classList.contains("cov"));
  P.focusBy(race[1], "key").onfocus();
  assert.ok(P.spots("5")[0].classList.contains("cov") && P.spots("36")[0].classList.contains("cov"), "Tiers' numbers");
});

test("review: the hover line follows the chips just placed on the spot under the mouse", async () => {
  const P = page();
  P.CZ.render(view("betting", {}));
  const d2 = P.spots("d2")[0];
  d2.onpointerenter({ pointerType: "mouse" });
  assert.match(P.$("rl-tip").textContent, /your bet 0 PAT$/);
  d2.onclick();
  assert.match(P.$("rl-tip").textContent, /^13–24 · Dozen · pays 2 to 1 · up to 50,000 PAT · your bet 100 PAT$/, "at once, with the chip waiting");
  d2.onclick();
  assert.match(P.$("rl-tip").textContent, /your bet 200 PAT$/);
  // another spot's chips never write over the line
  P.spots("red")[0].onclick();
  assert.match(P.$("rl-tip").textContent, /^13–24 .* your bet 200 PAT$/);
});

test("review: the players rail keeps each seat's row and person button across polls; it never reorders under the focus or a menu", () => {
  const P = page();
  const at = (a, b, c) => view("betting", { seat: "s9" }, {
    seats: [seat("Rocco", "s1", a ? [["red", a]] : []), seat("Dee", "s2", b ? [["17", b]] : []), seat("Tali", "s3", c ? [["5", c]] : [])],
  });
  P.CZ.render(at(500, 300, 0));
  const list = P.$("rl-players").querySelector("ol");
  const rowsOf = () => list.children.map((li) => li.dataset.seat);
  assert.deepEqual(rowsOf(), ["s1", "s2", "s3"]);
  const rocco = list.children[0],
    roccoWho = rocco.children[0],
    roccoHTML = roccoWho.innerHTML;
  // a seat with nothing on this spin: dimmed and says so, behind the bettors
  assert.equal(list.children[2].className, "seat out");
  assert.match(list.children[2].children[1].innerHTML, /^<span class="sub rl-out">No bet this spin<\/span>$/);
  assert.match(read("views/partials/casino-rl-css.ejs"), /\.rl-seats \.seat\.out \{\s*opacity: 0\.55;/);
  // Rocco's stake changes: his row and its .who (the person button) are the same nodes, only the stake beside it changed
  P.CZ.render(at(900, 300, 0));
  assert.equal(list.children[0], rocco);
  assert.equal(rocco.children[0], roccoWho);
  assert.equal(roccoWho.innerHTML, roccoHTML, "the button is not redrawn");
  assert.match(rocco.children[1].innerHTML, /900/);
  // Dee passes Rocco while the focus is on Rocco's button: nothing moves (a moved button drops the focus)
  P.W.document.activeElement = roccoWho;
  P.CZ.render(at(900, 2000, 0));
  assert.deepEqual(rowsOf(), ["s1", "s2", "s3"], "held while the rail has the focus");
  assert.match(list.children[1].children[1].innerHTML, /2000/, "the stake still updates");
  // a person menu open: held too
  P.W.document.activeElement = null;
  P.W.document.querySelector = (sel) => (sel === ".pm-pop" ? {} : null);
  P.CZ.render(at(900, 2000, 0));
  assert.deepEqual(rowsOf(), ["s1", "s2", "s3"]);
  // neither: the biggest stake first, by moving the same rows
  P.W.document.querySelector = () => null;
  P.CZ.render(at(900, 2000, 0));
  assert.deepEqual(rowsOf(), ["s2", "s1", "s3"]);
  assert.equal(list.children[1], rocco);
  // a seat that left: its row goes
  P.CZ.render(view("betting", { seat: "s9" }, { seats: [seat("Dee", "s2", [["17", 2000]])] }));
  assert.deepEqual(rowsOf(), ["s2"]);
  P.CZ.render(view("betting", { seat: "s9" }, { seats: [] }));
  assert.deepEqual(list.children.map((li) => li.className + ":" + li.textContent), ["rl-none:No bets yet this spin."]);
});

test("review: the live region never says a phrase twice; the felt has no second phase / layout line, no limits tag, no raw commitment", () => {
  const P = page();
  P.CZ.render(view("spinning", {}, { spin: { round_no: 7, number: 3, started_at: Date.now(), ends_at: Date.now() + 12000, secs: 12 } }));
  assert.equal(P.said.at(-1), "No more bets", "was: No more bets · No more bets");
  P.CZ.render(view("betting", {}));
  assert.equal(P.said.at(-1), "Bets open · Place your bets");
  P.CZ.render(view("result", { net: 300 }, { last_round: { round_no: 7, number: 3 } }));
  assert.equal(P.said.at(-1), "Result · 3 red · Your net +300 PAT");
  const v = read("views/casino-rl.ejs"),
    js = read("public/js/casinorl.js");
  assert.doesNotMatch(v, /rl-title|id="rl-phase"|id="rl-totals"|id="rl-proof"/);
  assert.doesNotMatch(js, /rl-proof|rl_meta_lim|\$\("rl-phase"\)|\$\("rl-totals"\)/);
  // (the commitment stays in the History sheet: casino-ui.js fairness writes #cz-commit for a roulette table)
  assert.match(read("public/js/casino-ui.js"), /const c = \$\("cz-commit"\);[\s\S]{0,120}t\.game === "roulette" \? T\("rl_commit_line"/);
});

test("review: the phone's floating wheel takes its own taps (brings the big wheel back) and never sits on the board's spots as a pass-through", () => {
  const P = page();
  P.$("rl-float").click();
  assert.equal(P.scrolled.length, 1, "a tap on it scrolls the big wheel into view");
  assert.equal(P.scrolled[0].block, "center");
  assert.equal(P.posts.length + P.W.timers.filter((t) => !t.done && t.ms === 900).length, 0, "no bet");
  const css = read("views/partials/casino-rl-css.ejs");
  const rule = /\.rl-float \{([^}]*)\}/.exec(css)[1];
  assert.match(rule, /pointer-events: auto;/);
  assert.doesNotMatch(rule, /pointer-events: none/);
});

test("review CSS: the phone's labels keep the pile's room, the rake goes up, the wide felt's outside rows apply, no filter on the canvas", () => {
  const css = read("views/partials/casino-rl-css.ejs").replace(/\r\n/g, "\n");      // (a Windows checkout's line ends)
  const phone = css.slice(css.indexOf("@media (max-width: 639px) {"));
  assert.match(phone, /\.rl-grid button:not\(\.edge\),\s*\.rl-outside button \{\s*padding-inline: 2px var\(--rl-pile, 54px\);/, "a label never under its pile");
  assert.match(phone, /\.rl-board\.raking \.rl-stk\.lost \{\s*animation-name: rlRakePhone;/);
  assert.match(css, /@keyframes rlRakePhone \{[^@]*to \{\s*opacity: 0;\s*transform: translateY\(-230%\) scale\(0\.5\);/, "straight up - never across the labels");
  assert.doesNotMatch(css, /rlRakeSide/);
  // the base outside rows come before the wide felt's 50 px ones (later wins at equal specificity)
  const base = css.indexOf(".rl-outside {\n  display: grid;"),
    wide = css.indexOf("@media (min-width: 640px) {\n  .rl-grid {");
  assert.ok(base > 0 && wide > base, "the 50 px rows apply");
  assert.match(css.slice(wide, wide + 400), /\.rl-outside \{\s*grid-template-rows: repeat\(2, minmax\(50px, auto\)\);/);
  assert.equal(css.slice(wide).indexOf("grid-template-rows: repeat(2, minmax(44px, auto))"), -1, "no base rule after it");
  const canvas = /\.rl-bowl canvas \{([^}]*)\}/.exec(css)[1];
  assert.doesNotMatch(canvas, /filter/);
  assert.match(canvas, /border-radius: 50%;\s*box-shadow: 0 10px 28px/);
  assert.doesNotMatch(css, /filter: drop-shadow/);
});

test("review CSS: the table page's chips are the casino's own size (casino-chips.css); only the Room Dock's are smaller", () => {
  const dock = read("public/css/casinorl-dock.css");
  assert.doesNotMatch(dock, /\.rl-controls \.chipbtn \{\s*width/, "no table-page size override");
  assert.match(dock, /\.rl-compact \.chipbtn \{\s*width: 44px;\s*height: 44px;\s*\}/);
});

test("review: casino-sound.js unlocks on a tap's pointerup / touchend / click (WebKit), and a cue never makes the AudioContext", () => {
  const src = read("public/js/casino-sound.js");
  const W = makeWindow(() => ({}));
  const back = new El("a");
  back.className = "back";
  new El("section").append(back);
  const ls = {};
  W.document.querySelector = (s) => (s === "#cz-table > .back" ? back : null);
  W.document.addEventListener = (type, fn, cap) => (ls[type] = ls[type] || []).push([fn, cap]);
  let gestureNow = false,
    made = 0;
  const inst = [];
  // WebKit's rule: resume() works only inside a user activation (a touch's pointerdown is not one)
  function AC() { made++; inst.push(this); this.state = gestureNow ? "running" : "suspended"; this.currentTime = 0; }
  AC.prototype.resume = function () { if (gestureNow) this.state = "running"; return Promise.resolve(); };
  W.localStorage = { getItem: (k) => (k === "cz-sound" ? "1" : null), setItem() {} };      // (left on, from an earlier visit)
  W.CZ = { T: (k, d) => d };
  W.run(src, "casino-sound.js");
  for (const t of ["pointerdown", "pointerup", "touchend", "click", "keydown"]) assert.ok((ls[t] || []).some((x) => x[1] === true), t + " (capture)");
  // a cue before any context exists makes none (it runs from a frame callback, outside any gesture)
  W.CZSound.update("classic", { game: "roulette" });
  for (const [fn] of ls.keydown) fn({});              // (a gesture with no AudioContext available yet: none made)
  W.AudioContext = AC;
  W.CZSound.cue("rl_settle");
  assert.equal(made, 0, "cue() never constructs the AudioContext");
  // a tap: pointerdown (not an activation) makes it suspended; the tap's click resumes it
  for (const [fn] of ls.pointerdown) fn({ pointerType: "touch" });
  assert.equal(made, 1);
  assert.equal(inst[0].state, "suspended", "a touch's pointerdown can't unlock it");
  gestureNow = true;
  for (const [fn] of ls.click || []) fn({});
  gestureNow = false;
  assert.equal(inst[0].state, "running", "the tap's click does - no need to toggle Sound off and on");
  assert.equal(made, 1, "one context");
});
