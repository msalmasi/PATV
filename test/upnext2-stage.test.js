"use strict";
// upnext2 (owner 2026-11-05: "when does the 'next up' card actually show? ... I think I saw it come up once very briefly"): the PAGE half -
// public/js/stage-room.js / stage-player.js / room.ejs / home-dock.js in a small DOM on a clock we move (the upnext-card.test.js harness):
//   B  the pad's /live long-poll carries the stage version (mainstage.stageBump): a move makes the stage poll at once (pad page, homepage
//      Dock); the player's first retries come after 2.5 s (a playlist asked for before nginx wrote its first segment)
//   C  a card stays up at least 4 s; a 📼 queue's kept player hands over only once its old title's tail ran out; a page that learns late
//      never flashes a stale card
//   D  the classic "coming up" lower-third (UP NEXT in a 📼 title's last minute with a countdown; COMING UP AT for a booked start within
//      5 min - briefly, then every 2 min; ✕ for the visit), the off-air slate, the poll near a title's end - text only, known shapes only
//   node --test test/upnext2-stage.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8").replace(/\r\n/g, "\n");
const EN = JSON.parse(read("locales", "en.json"));


// ── a small DOM ──
function mkEl(tag) {
  const cls = new Set();
  const e = {
    tagName: String(tag || "div").toUpperCase(), children: [], parentNode: null, attrs: {}, style: {}, listeners: {}, _text: "",
    classList: { add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)),
                 toggle: (c, on) => { const v = on === undefined ? !cls.has(c) : !!on; if (v) cls.add(c); else cls.delete(c); return v; }, contains: (c) => cls.has(c) },
    get className() { return [...cls].join(" "); }, set className(v) { cls.clear(); String(v || "").split(/\s+/).filter(Boolean).forEach((x) => cls.add(x)); },
    get firstChild() { return this.children[0] || null; },
    get childNodes() { return this.children; },
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); }, set textContent(v) { this._text = String(v); this.children = []; },
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; },
    insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, removeAttribute(k) { delete this.attrs[k]; },
    hasAttribute(k) { return k in this.attrs; }, addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); }, removeEventListener() {},
    querySelectorAll(sel) { const c = sel.replace(/^\./, ""), out = []; const walk = (n) => n.children.forEach((k) => { if (k.classList.contains(c)) out.push(k); walk(k); }); walk(this); return out; },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }, play: () => Promise.resolve(), focus() {},
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; },
  };
  return e;
}
const T0 = 1_800_000_000_000;
function switcher(opts, env = {}) {
  const js = read("public", "js", "stage-room.js");
  const answers = [], calls = [], air = [], timers = [];
  const clock = { t: T0 + (env.skewMs || 0) };
  let seq = 0;
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(clock.t); } static now() { return clock.t; } }
  const add = (fn, ms, every) => { const h = ++seq; timers.push({ h, fn, at: clock.t + Math.max(0, ms || 0), every: every ? Math.max(1, ms) : 0 }); return h; };
  const clear = (h) => { const i = timers.findIndex((x) => x.h === h); if (i >= 0) timers.splice(i, 1); };
  const reconnect = mkEl("div"), unmute = mkEl("button");
  reconnect.classList.add("hide"); unmute.classList.add("hide");
  // (like stage-player.js: setSrc with the same URL is a no-op, another one restarts a running player - a new player starts muted; state()
  // says whether frames move. review: playing() = the first frame and the picture moving from then on, stall() = it froze / reconnects)
  const player = { srcs: [], cur: null, starts: 0, stops: 0, on: false, muted: true, moving: false, t0: 0,
    stop() { this.stops++; this.on = false; this.moving = false; this.muted = true; reconnect.classList.add("hide"); unmute.classList.add("hide"); },
    setSrc(s) { this.srcs.push(s); if (!s || s === this.cur) return; this.cur = s; if (this.on) { this.stop(); this.start(); } }, src() { return this.cur; },
    start() { if (this.on) return; this.starts++; this.on = true; this.moving = false; this.muted = true; reconnect.classList.remove("hide"); unmute.classList.remove("hide"); },
    running() { return this.on; }, state() { return this.on ? { playing: this.moving, time: this.moving ? (clock.t - this.t0) / 1000 : 0, muted: this.muted } : null; },
    playing() { reconnect.classList.add("hide"); this.moving = true; this.t0 = clock.t; }, stall() { reconnect.classList.remove("hide"); this.moving = false; },
    frozen() { reconnect.classList.add("hide"); this.moving = false; } };
  const ctx = { document: { readyState: "complete", createElement: mkEl, documentElement: { lang: "en" } }, console, Date: FakeDate, Intl, encodeURIComponent,
    setTimeout: (fn, ms) => add(fn, ms, false), clearTimeout: clear, setInterval: (fn, ms) => add(fn, ms, true), clearInterval: clear, location: { hostname: "x" },
    fetch: (url, init) => { calls.push({ url, init, at: clock.t });
      if (/\/api\/stage\/(pepe\/feature|slots\/)/.test(url)) return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
      const a = answers.length ? answers.shift() : { stale: true };
      return a === null ? Promise.reject(new Error("offline")) : Promise.resolve({ json: () => Promise.resolve(typeof a === "function" ? a() : a) }); },
    confirm: () => true, alert() {}, matchMedia: () => ({ matches: !!env.reduced }) };
  const store = new Map();                                    // (upnext2: the lower-third's ✕ for the visit)
  ctx.sessionStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); } };
  ctx.window = ctx; ctx.window.addEventListener = () => {};
  ctx.PATVStage = { player: () => player };
  ctx.PATVStageMic = { render: () => ({ update() {}, stop() {}, selection: () => ({ stream: "mic", embed: true, capture: false, nsfw: false }) }) };
  vm.runInNewContext(js, ctx);
  const tabs = mkEl("div"); let html = "";
  Object.defineProperty(tabs, "innerHTML", { set(v) { html = v; }, get() { return html; } });
  const wrap = mkEl("div");
  const sw = ctx.PATVStage.switcher(Object.assign({ tabs, wrap, reconnect, unmute, api: "/api/stage?room=pad", slots: [], pepeOn: true, pepeHere: true, slug: "pad", watch: false,
    onAir: (on, sub, extra) => air.push([on, sub, extra ? { ...extra } : null]) }, opts));
  const flush = () => new Promise((r) => setImmediate(r));
  /** move the clock, firing what's due (in order) */
  async function adv(ms) {
    const end = clock.t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.h - b.h);
      const x = timers[0];
      if (!x || x.at > end) break;
      clock.t = x.at;
      if (x.every) x.at += x.every; else timers.shift();
      x.fn();
      await flush();
    }
    clock.t = end;
    await flush();
  }
  const click = (v) => { const b = { hasAttribute: (k) => k === "data-v", getAttribute: () => v }; tabs.listeners.click[0]({ target: { closest: () => b } }); };
  const card = () => wrap.children.find((c) => c.classList.contains("st-upnext")) || null;
  const q = (sel) => { const c = card(); return c ? c.querySelector(sel) : null; };
  return { sw, wrap, tabs: () => html, air, calls, player, reconnect, unmute, card, q, adv, click, now: () => clock.t, doc: ctx.document, store,
           answer: (a) => answers.push(a), clearAnswers: () => { answers.length = 0; }, poll: async () => { await sw.poll(); await flush(); }, timers };
}
const MIC = (extra) => Object.assign({ v: 1, active: true, count: 2, default: "first", layout: "split", src: [{ id: "a" }, { id: "b" }] }, extra || {});
const MOVIE = (at, extra) => Object.assign({ title: "Night of the Living Dead", kind: "movie", year: 1968, show: null, season: null, episode: null, poster: true, key: "501",
  at, until: at + 90000, now: at }, extra || {});
const EPISODE = (at, extra) => Object.assign({ title: "Second", kind: "episode", year: null, show: "The Show", season: 1, episode: 2, poster: false, at, until: at + 90000, now: at }, extra || {});
const PEND = (next, extra) => Object.assign({ id: "lib1", live: false, by: "auto", went: false, next }, extra || {});
const LIB = (extra) => Object.assign({ id: "lib1", display: "Admin", featured: true, feature_by: "auto", hls: "/hls/lib1.m3u8", since: 1, title: "📼 Night of the Living Dead (1968)" }, extra || {});
const ans = (slots, featured, extra) => Object.assign({ active: true, pepe_here: true, slots, featured: featured === undefined ? null : featured, now: Date.now() }, extra || {});


// ── upnext2 (B) the instant wake: the pad's /live long-poll carries the stage version; a move -> the stage asks /api/stage now ──
test("B: room.ejs - a moved stage version (the /live answer's stv) makes the pad's stage poll at once; the first answer only notes it", () => {
  const src = read("views", "room.ejs");
  const i = src.indexOf("safe('stagever', function () {");
  assert.ok(i > 0, "the handler");
  const body = src.slice(i + "safe('stagever', function () {".length, src.indexOf("});", i));
  const polls = [];
  const run = new Function("d", "state", "window", "PATVPadStage", "var stvSeen = state.v;" + body + ";state.v = stvSeen;");
  const W = { PATVPadStage: { poll: () => polls.push(1) } }, st = { v: null };
  run({ stv: 3 }, st, W, W.PATVPadStage);
  assert.deepEqual([st.v, polls.length], [3, 0], "the first answer: noted, no poll");
  run({ stv: 3 }, st, W, W.PATVPadStage);
  assert.equal(polls.length, 0, "unchanged: nothing");
  run({ stv: 4 }, st, W, W.PATVPadStage);
  assert.equal(polls.length, 1, "moved: the stage asks now");
  run({}, st, W, W.PATVPadStage);
  assert.deepEqual([st.v, polls.length], [4, 1], "an answer without it (an older site) changes nothing");
  assert.match(src, /var stvSeen = null;\n    function apply\(d, first, late\) \{/);
  const hd = read("public", "js", "home-dock.js");
  assert.match(hd, /if \(sv != null && sv !== d\.stv && sw && typeof sw\.poll === 'function' && slug && slug === frontSlug\) \{ try \{ sw\.poll\(\); \}/, "the homepage Dock: the same, for the stage's own pad");
  assert.match(read("bridge.js"), /stv: \(\(\) => \{ try \{ return require\("\.\/mainstage"\)\.stageVer\(R\.id\); \} catch \(e\) \{ return 0; \} \}\)\(\),/);
});

test("B: stage-player.js - the first 3 retries come after 2.5 s (a playlist asked for before its first segment), then every 10 s; a frame resets it", () => {
  const js = read("public", "js", "stage-player.js");
  const timers = [], handlers = {};
  const fakeP = { on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); }, src: () => {}, play: () => Promise.resolve(), tech: () => null, dispose() {},
                  paused: () => false, ended: () => false, currentTime: () => 0, muted: () => true, volume: () => 1, buffered: () => null, playbackRate: () => 1 };
  const ctx = { document: { createElement: () => ({ setAttribute() {}, className: "" }) }, console,
                setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {} };
  ctx.window = ctx;
  ctx.videojs = Object.assign(() => fakeP, { browser: {}, Vhs: null });
  ctx.window.videojs = ctx.videojs;
  vm.runInNewContext(js, ctx);
  const wrap = { appendChild() {} }, rc = { classList: { toggle() {}, add() {}, remove() {} } };
  const p = ctx.PATVStage.player({ wrap, reconnect: rc, src: "/hls/x.m3u8" });
  p.start();
  handlers.error[0]();                                         // a 404: the playlist isn't there yet
  const delays = [];
  for (let k = 0; k < 5; k++) { const t = timers[timers.length - 1]; delays.push(t.ms); t.fn(); }
  assert.deepEqual(delays, [2500, 2500, 2500, 10000, 10000]);
  handlers.playing.forEach((f) => f());                        // it played
  handlers.error[0]();
  assert.equal(timers[timers.length - 1].ms, 2500, "the count starts again after a frame");
});

// ── upnext2 (C) the card's minimum and the kept player's hand-over ──
test("C: a card stays up at least 4 s - the stream listed and playing a moment after it came up doesn't take it down sooner", async () => {
  const x = switcher({ featured: PEND(MOVIE(T0)) });
  assert.ok(x.card());
  await x.adv(300);
  x.answer(ans([LIB()], { id: "lib1", live: true, by: "auto", went: true }, { now: x.now() }));
  await x.poll();
  x.player.playing();
  await x.adv(1500);
  assert.ok(x.card() && !x.card().classList.contains("is-out"), "1.8 s: still up");
  await x.adv(1800);
  assert.ok(x.card() && !x.card().classList.contains("is-out"), "3.6 s: still up");
  await x.adv(500);
  assert.ok(x.card().classList.contains("is-out"), "4 s: it fades");
  await x.adv(800);
  assert.equal(x.card(), null);
});

test("C: a 📼 queue's kept player still playing the title before's tail under the card hands over only after it stalled and moves again (it used to fade on the tail)", async () => {
  const x = switcher({ slots: [LIB({ title: "📼 The Show — S1E1 Pilot" })], featured: { id: "lib1", live: true, by: "auto", went: true } });
  x.player.playing(); x.player.muted = false;
  await x.adv(2000);
  // the queue moved on: the server names episode 2 - this viewer's player is ~6 s behind, still playing episode 1's last seconds
  x.answer(() => ans([], PEND(EPISODE(x.now()), { went: true }), { now: x.now() }));
  await x.poll();
  assert.ok(x.card(), "the card");
  assert.equal(x.player.stops, 0, "the same player under it");
  // the break is over, episode 2 is live - the tail still plays (picture moving, no overlay)
  await x.adv(2500);
  x.answer(() => ans([LIB({ title: "📼 The Show — S1E2 Second" })], { id: "lib1", live: true, by: "auto", went: true }, { now: x.now() }));
  await x.poll();
  await x.adv(3000);
  assert.ok(x.card() && !x.card().classList.contains("is-out"), "the tail moving is not the new title");
  x.player.frozen();                                            // the tail ran out: the picture stands
  await x.adv(1500);
  assert.ok(x.card() && !x.card().classList.contains("is-out"), "a stall isn't playing");
  x.player.playing();                                           // episode 2's first frames
  await x.adv(700);
  assert.ok(x.card().classList.contains("is-out"), "now it hands over");
  assert.equal(x.player.muted, false, "the viewer's sound carried on");
});

test("C: a page that first hears of the slot after its stream came up (featured live, no next) never shows a card", async () => {
  const x = switcher({ featured: { id: "lib1", live: true, by: "auto", went: true }, slots: [LIB()] });
  assert.equal(x.card(), null);
  x.answer(ans([LIB()], { id: "lib1", live: true, by: "auto", went: true }, { now: x.now() }));
  await x.poll();
  assert.equal(x.card(), null);
  assert.equal(x.sw.view(), "slot:lib1");
});

// ── upnext2 (D) the 📼 lower-third, "coming up at", the off-air slate ──
const l3 = (x) => x.wrap.children.find((c) => c.classList.contains("st-l3")) || null;
const slateOf = (x) => x.wrap.children.find((c) => c.classList.contains("st-slate")) || null;
const LIBP = (extra) => LIB(Object.assign({ lib: true, title: "📼 The Show — S1E1 Pilot" }, extra || {}));
const NEXT_EP = { title: "Second", kind: "episode", show: "The Show", season: 1, episode: 2, year: null, poster: false };

test("D: UP NEXT - over a 📼 title that plays, only in its last minute, with a countdown; ✕ hides it for the visit", async () => {
  const x = switcher({ slots: [LIBP()], featured: { id: "lib1", live: true, by: "auto", went: true }, coming: { ends_at: T0 + 90000, next: NEXT_EP } });
  assert.equal(x.sw.view(), "slot:lib1");
  assert.equal(l3(x), null, "90 s left: nothing yet");
  await x.adv(30500);
  const b = l3(x);
  assert.ok(b, "the last minute: the lower-third");
  assert.equal(b.getAttribute("data-mode"), "next");
  assert.equal(b.getAttribute("role"), "status");
  assert.equal(b.querySelector(".st-l3-tag").textContent, "Up next");
  assert.equal(b.querySelector(".st-l3-title").textContent, "The Show · S1E2 · Second");
  assert.equal(b.querySelector(".st-l3-when").textContent, "in 1:00");
  await x.adv(15000);
  assert.equal(l3(x).querySelector(".st-l3-when").textContent, "in 0:45", "it counts down");
  assert.equal(l3(x), b, "the same element (no flicker)");
  b.querySelector(".st-l3-x").listeners.click[0]();
  assert.equal(l3(x), null, "✕");
  await x.adv(2000);
  assert.equal(l3(x), null, "...for the visit");
  assert.equal(x.store.get("patv.l3x.pad.n:episode|The Show|Second|1|2|"), "1");
  // a card / another view: never over it
  const y = switcher({ slots: [LIBP()], featured: { id: "lib1", live: true, by: "auto", went: true }, coming: { ends_at: T0 + 20000, next: NEXT_EP } });
  assert.ok(l3(y));
  y.click("pepe");
  assert.equal(l3(y), null, "Pepe's stream picked: not this title's lower-third");
  // a 📼 title without a known end (paused): nothing
  const z = switcher({ slots: [LIBP()], featured: { id: "lib1", live: true, by: "auto", went: true }, coming: { next: NEXT_EP } });
  await z.adv(5000);
  assert.equal(l3(z), null);
});

test("D: COMING UP AT - a booked 📼 start within 5 min: 12 s when it first applies, then 12 s every 2 min; never further out", async () => {
  const at = T0 + 7 * 60000;
  const x = switcher({ slots: [], pepeOn: true, coming: { at, next: { title: "Night of the Living Dead", kind: "movie", year: 1968 } } });
  assert.equal(x.sw.view(), "pepe");
  assert.equal(l3(x), null, "7 min out: nothing");
  await x.adv(2 * 60000 + 1000);
  const b = l3(x);
  assert.ok(b, "within 5 min");
  assert.equal(b.getAttribute("data-mode"), "at");
  assert.match(b.querySelector(".st-l3-tag").textContent, /^Coming up at \d{1,2}:\d{2}/);
  assert.equal(b.querySelector(".st-l3-title").textContent, "Night of the Living Dead (1968)");
  assert.equal(b.querySelector(".st-l3-when").textContent, "");
  await x.adv(12500);
  assert.equal(l3(x), null, "briefly");
  await x.adv(60000);
  assert.equal(l3(x), null);
  await x.adv(48000);
  assert.ok(l3(x), "again a couple of minutes later");
});

test("D: the off-air slate names a booked 📼 start within the hour while nothing is on; it goes when something plays", async () => {
  const at = T0 + 30 * 60000;
  const x = switcher({ slots: [], pepeOn: false, pepeHere: false, coming: { at, next: NEXT_EP } });
  const s = slateOf(x);
  assert.ok(s, "the slate");
  assert.match(s.children[0].textContent, /^Coming up at /);
  assert.equal(s.children[1].textContent, "The Show · S1E2 · Second");
  assert.equal(s.children[2].textContent, "PATV");
  assert.deepEqual(x.air[x.air.length - 1], [true, null, { slate: true }], "the stage box opens for it - the page still says OFF AIR (room.ejs onAir)");
  const ro = read("views", "room.ejs");
  assert.match(ro, /var air = on && !\(x && x\.slate\);/);
  assert.match(ro, /stagePillText\.textContent = air \? _t\('js\.pad\.stage\.on_air', 'ON AIR'\) : _t\('js\.pad\.stage\.off_air', 'OFF AIR'\);/);
  assert.match(ro, /stageOn\(air\);/, "nothing live: no Live-tab dot");
  x.answer(ans([LIBP()], { id: "lib1", live: true, by: "auto", went: true }, { now: x.now(), pepe_here: false, active: false }));
  await x.poll();
  assert.equal(slateOf(x), null, "a stream on the stage: no slate");
  assert.deepEqual(x.air[x.air.length - 1].slice(0, 1), [true]);
  assert.equal(x.air[x.air.length - 1][2], null, "on air for real");
  const far = switcher({ slots: [], pepeOn: false, pepeHere: false, coming: { at: T0 + 61 * 60000, next: NEXT_EP } });
  assert.equal(slateOf(far), null, "more than an hour out: not yet");
  assert.deepEqual(far.air[far.air.length - 1], [false, "nothing streaming right now", null]);
  await far.adv(65000);
  assert.ok(slateOf(far), "its hour came: the slate (and the stage box) without waiting for a poll");
  assert.deepEqual(far.air[far.air.length - 1], [true, null, { slate: true }]);
});

test("D: the poll - every 5 s while a 📼 title is on screen, every 3 s from 15 s before its end; 10 s otherwise", async () => {
  const x = switcher({ slots: [LIBP()], featured: { id: "lib1", live: true, by: "auto", went: true }, coming: { ends_at: T0 + 60000, next: NEXT_EP } });
  const polls = () => x.calls.filter((c) => c.url === "/api/stage?room=pad").length;
  const keep = () => ans([LIBP()], { id: "lib1", live: true, by: "auto", went: true }, { now: x.now(), coming: { ends_at: T0 + 60000, next: NEXT_EP } });
  for (let k = 0; k < 30; k++) x.answer(keep);
  await x.adv(20500);
  assert.equal(polls(), 4, "5, 10, 15, 20 s");
  await x.adv(30000);                                          // 50.5 s: inside the last 15 s
  const n0 = polls();
  await x.adv(9000);
  assert.ok(polls() - n0 >= 3, "every 3 s near the end: " + (polls() - n0));
  const y = switcher({ slots: [LIB()], featured: { id: "lib1", live: true, by: "auto", went: true } });
  const yp = () => y.calls.filter((c) => c.url === "/api/stage?room=pad").length;
  await y.adv(20500);
  assert.equal(yp(), 2, "not a 📼 title: the ordinary 10 s");
});

test("D: only known shapes, text only - a bad key / a stray field never reaches the page; no innerHTML in the lower-third or the slate", async () => {
  const x = switcher({ slots: [LIBP()], featured: { id: "lib1", live: true, by: "auto", went: true },
                       coming: { ends_at: T0 + 30000, by: "someone", next: { title: "<b>A</b>\u0000", kind: "movie", key: "1234567890123", poster: true, username: "nope" } } });
  const b = l3(x);
  assert.equal(b.querySelector(".st-l3-title").textContent, "<b>A</b>");
  const js = read("public", "js", "stage-room.js");
  const code = js.slice(js.indexOf("// ── upnext2 (D): the 📼"), js.indexOf("    function show() {"));
  assert.ok(code.length > 2000);
  assert.doesNotMatch(code, /innerHTML/);
  assert.equal(EN["js.stage.l3.next"], "Up next");
  assert.equal(EN["js.stage.l3.at"], "Coming up at {time}");
  assert.equal(EN["js.stage.l3.in"], "in {time}");
  assert.equal(EN["js.stage.l3.hide"], "Hide");
  assert.equal(EN["js.stage.slate.at"], "Coming up at {time}");
  const css = read("public", "css", "stage-upnext.css");
  for (const sel of [".st-l3 {", ".st-l3-tag {", ".st-l3-title {", ".st-l3-when {", ".st-l3-x {", ".st-slate {", ".st-slate-kick {", ".st-slate-title {"]) assert.ok(css.includes(sel), sel);
  const rm = (/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css) || [])[1] || "";
  assert.match(rm, /\.st-l3 \{ animation: none; \}/);
  assert.match(read("views", "room.ejs"), /coming: <%- JSON\.stringify\(RS\.coming \|\| null\)\.replace\(\/<\/g, '\\\\u003c'\) %>,/);
});
