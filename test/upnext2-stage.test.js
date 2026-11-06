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
test("B: room.ejs hands the /live answer's stv to the stage (PATVPadStage.stv); the homepage Dock for the stage's own pad", () => {
  const src = read("views", "room.ejs");
  const i = src.indexOf("safe('stagever', function () {");
  assert.ok(i > 0, "the handler");
  const body = src.slice(i + "safe('stagever', function () {".length, src.indexOf("});", i));
  const got = [];
  const run = new Function("d", "window", "PATVPadStage", "var stvSeen = null;" + body);
  const W = { PATVPadStage: { stv: (v) => got.push(v) } };
  run({ stv: 3 }, W, W.PATVPadStage);
  run({}, W, W.PATVPadStage);
  assert.deepEqual(got, [3], "each answer that carries it (an older site's without: nothing)");
  const hd = read("public", "js", "home-dock.js");
  assert.match(hd, /if \(sw && typeof sw\.stv === 'function' && slug && slug === frontSlug\) \{ try \{ sw\.stv\(d\.stv\); \}/, "the homepage Dock: only the stage's own pad's");
  assert.match(read("bridge.js"), /stv: \(\(\) => \{ try \{ return require\("\.\/mainstage"\)\.stageVer\(R\.id\); \} catch \(e\) \{ return 0; \} \}\)\(\),/);
});

test("B + review F9 (1.99alc): the switcher's stv - the first answer only notes it; a move asks /api/stage within 750 ms (each page at its own moment, not all at once); the same again: nothing", async () => {
  const x = switcher({ slots: [], pepeOn: true });
  const polls = () => x.calls.filter((c) => c.url === "/api/stage?room=pad").length;
  x.sw.stv(3);
  await x.adv(1000);
  assert.equal(polls(), 0, "noted");
  x.sw.stv(3);
  await x.adv(1000);
  assert.equal(polls(), 0, "unchanged");
  const t0 = x.now();
  x.sw.stv(4);
  assert.equal(polls(), 0, "not in the same instant");
  await x.adv(760);
  assert.equal(polls(), 1, "within 750 ms");
  assert.ok(x.calls[x.calls.length - 1].at - t0 < 750);
  x.sw.stv(5); x.sw.stv(6);
  await x.adv(760);
  assert.equal(polls(), 2, "two moves close together: one ask");
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

test("C + review F2 (1.99alc): a 📼 queue's kept player plays the title before's tail to its last frame - the UP NEXT strip meanwhile, the card once it stalls, gone once the new title moves (>= 4 s)", async () => {
  const x = switcher({ slots: [LIB({ title: "📼 The Show — S1E1 Pilot" })], featured: { id: "lib1", live: true, by: "auto", went: true } });
  x.player.playing(); x.player.muted = false;
  await x.adv(2000);
  // the queue moved on: the server names episode 2 - this viewer's player is ~6 s behind, still playing episode 1's last seconds
  x.answer(() => ans([], PEND(EPISODE(x.now()), { went: true }), { now: x.now() }));
  await x.poll();
  assert.equal(x.card(), null, "no card over the tail (it hid the last 4-10 s of every title, sound on)");
  const strip = l3(x);
  assert.ok(strip, "the UP NEXT strip says what's next");
  assert.equal(strip.querySelector(".st-l3-title").textContent, "The Show · S1E2 · Second");
  assert.equal(strip.querySelector(".st-l3-when").textContent, "");
  assert.equal(x.player.stops, 0, "the same player");
  // the break is over, episode 2 is live - the tail still plays (picture moving, no overlay)
  await x.adv(2500);
  x.answer(() => ans([LIB({ title: "📼 The Show — S1E2 Second" })], { id: "lib1", live: true, by: "auto", went: true }, { now: x.now() }));
  await x.poll();
  await x.adv(3000);
  assert.equal(x.card(), null, "the tail moving is not the new title");
  x.player.frozen();                                            // the tail ran out: the picture stands
  await x.adv(900);
  assert.ok(x.card() && !x.card().classList.contains("is-out"), "the stall: the card goes up");
  assert.equal(l3(x), null, "...and the strip gives way to it");
  x.player.playing();                                           // episode 2's first frames
  await x.adv(1500);
  assert.ok(x.card() && !x.card().classList.contains("is-out"), "its 4 s minimum");
  await x.adv(2000);
  assert.ok(x.card() && x.card().classList.contains("is-out"), "now it hands over");
  assert.equal(x.player.muted, false, "the viewer's sound carried on");
});

test("C + review F2: a kept player that never stalls (the next title follows its tail straight on) - no card, the strip goes 12 s after the stream came up", async () => {
  const x = switcher({ slots: [LIB({ title: "📼 The Show — S1E1 Pilot" })], featured: { id: "lib1", live: true, by: "auto", went: true } });
  x.player.playing();
  await x.adv(2000);
  x.answer(() => ans([], PEND(EPISODE(x.now()), { went: true }), { now: x.now() }));
  await x.poll();
  assert.ok(l3(x) && !x.card());
  x.answer(() => ans([LIB({ title: "📼 The Show — S1E2 Second" })], { id: "lib1", live: true, by: "auto", went: true }, { now: x.now() }));
  await x.poll();
  await x.adv(11000);
  assert.ok(l3(x), "still the strip");
  await x.adv(1500);
  assert.equal(l3(x), null);
  assert.equal(x.card(), null, "never a card");
});

test("C: a fresh ▶ Play (no player to keep) still shows its card at once", async () => {
  const x = switcher({ slots: [], pepeOn: false, featured: PEND(MOVIE(T0)) });
  assert.ok(x.card(), "the card");
  assert.equal(l3(x), null);
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

test("D + review F7 (1.99alc): UP NEXT - over a 📼 title that plays, 12 s from a minute before its end, then its last 15 s, with a countdown; ✕ hides it for the visit", async () => {
  const x = switcher({ slots: [LIBP()], featured: { id: "lib1", live: true, by: "auto", went: true }, coming: { ends_at: T0 + 90000, next: NEXT_EP } });
  assert.equal(x.sw.view(), "slot:lib1");
  assert.equal(l3(x), null, "90 s left: nothing yet");
  await x.adv(30500);
  const b = l3(x);
  assert.ok(b, "a minute before the end: the lower-third");
  assert.equal(b.getAttribute("data-mode"), "next");
  assert.equal(b.querySelector(".st-l3-tag").textContent, "Up next");
  assert.equal(b.querySelector(".st-l3-title").textContent, "The Show · S1E2 · Second");
  assert.equal(b.querySelector(".st-l3-when").textContent, "in 1:00");
  await x.adv(6000);
  assert.equal(l3(x).querySelector(".st-l3-when").textContent, "in 0:54", "it counts down");
  assert.equal(l3(x), b, "the same element (no flicker)");
  await x.adv(6500);
  assert.equal(l3(x), null, "12 s, then off - not over the subtitles for the whole last minute");
  await x.adv(29000);
  assert.equal(l3(x), null, "47 s .. 16 s left: off");
  await x.adv(3500);
  const b2 = l3(x);
  assert.ok(b2, "the last 15 s: again");
  assert.equal(b2.querySelector(".st-l3-when").textContent, "in 0:15");
  b2.querySelector(".st-l3-x").listeners.click[0]();
  assert.equal(l3(x), null, "✕");
  await x.adv(2000);
  assert.equal(l3(x), null, "...for the visit");
  assert.equal(x.store.get("patv.l3x.pad.n:episode|The Show|Second|1|2|"), "1");
  // a card / another view: never over it
  const y = switcher({ slots: [LIBP()], featured: { id: "lib1", live: true, by: "auto", went: true }, coming: { ends_at: T0 + 10000, next: NEXT_EP } });
  assert.ok(l3(y));
  y.click("pepe");
  assert.equal(l3(y), null, "Pepe's stream picked: not this title's lower-third");
  // a 📼 title without a known end (paused): nothing
  const z = switcher({ slots: [LIBP()], featured: { id: "lib1", live: true, by: "auto", went: true }, coming: { next: NEXT_EP } });
  await z.adv(5000);
  assert.equal(l3(z), null);
});

test("review F1 (1.99alc): the strip is announced ONCE per title - a hidden status line; its countdown (aria-hidden) and ✕ are outside it; the slate's text is written only when it changes", async () => {
  const x = switcher({ slots: [LIBP()], featured: { id: "lib1", live: true, by: "auto", went: true }, coming: { ends_at: T0 + 14000, next: NEXT_EP } });
  const b = l3(x);
  assert.ok(b);
  assert.equal(b.getAttribute("role"), null, "the strip itself is no live region");
  const sr = b.querySelector(".st-l3-sr");
  assert.equal(sr.getAttribute("role"), "status");
  assert.equal(sr.textContent, "", "empty when it goes in");
  for (const c of [".st-l3-tag", ".st-l3-title", ".st-l3-when"]) assert.equal(b.querySelector(c).getAttribute("aria-hidden"), "true", c);
  let writes = 0;
  const desc = Object.getOwnPropertyDescriptor(sr, "textContent");
  Object.defineProperty(sr, "textContent", { configurable: true, get: desc.get, set(v) { writes++; desc.set.call(sr, v); } });
  await x.adv(10000);
  assert.equal(sr.textContent, "Up next on the stage: The Show · S1E2 · Second");
  assert.equal(writes, 1, "said once - not at every tick of its countdown");
  assert.equal(EN["js.stage.l3.sr_next"], "Up next on the stage: {title}");
  // the slate: one write per change, none per tick
  const y = switcher({ slots: [], pepeOn: false, pepeHere: false, coming: { at: T0 + 30 * 60000, next: NEXT_EP } });
  const s = slateOf(y);
  let sw = 0;
  for (const c of s.children.slice(0, 2)) {
    const d = Object.getOwnPropertyDescriptor(c, "textContent");
    Object.defineProperty(c, "textContent", { configurable: true, get: d.get, set(v) { sw++; d.set.call(c, v); } });
  }
  await y.adv(10000);
  assert.equal(sw, 0, "10 ticks, the same text: never rewritten");
  assert.equal(s.getAttribute("role"), "status");
});

test("review F4 (1.99alc): a tap / click on the strip never reaches the Room Dock (its controls woke and lifted the strip under the finger); over it, it stays put", async () => {
  const x = switcher({ slots: [LIBP()], featured: { id: "lib1", live: true, by: "auto", went: true }, coming: { ends_at: T0 + 10000, next: NEXT_EP } });
  const b = l3(x);
  for (const ev of ["pointerdown", "focusin"]) {
    let stopped = 0;
    b.listeners[ev].forEach((f) => f({ stopPropagation: () => stopped++ }));
    assert.equal(stopped, 1, ev + " stops here");
  }
  assert.ok(b.listeners.pointerenter && b.listeners.pointerleave, "frozen in place while a pointer is over it");
  const js = read("public", "js", "stage-room.js");
  assert.match(js, /box\.style\.bottom = window\.getComputedStyle\(box\)\.bottom;/);
  assert.match(js, /box\.fz = setTimeout\(function \(\) \{ box\.style\.bottom = ''; \}, 700\);/);
});

test("review F6 (1.99alc): no \"COMING UP AT\" strip over a stream - Pepe's, someone's OBS, an embed, a cam; the off-air slate names a booked 📼 start while nothing is on", async () => {
  const at = T0 + 3 * 60000, next = { title: "Night of the Living Dead", kind: "movie", year: 1968 };
  const over = [
    switcher({ slots: [], pepeOn: true, coming: { at, next } }),
    switcher({ slots: [LIB({ id: "obs1", lib: undefined, title: "Orchard session" })], featured: { id: "obs1", live: true, by: "owner", went: true }, coming: { at, next } }),
    switcher({ slots: [LIB({ id: "yt1", hls: null, embed: { p: "youtube", id: "dQw4w9WgXcQ" } })], featured: { id: "yt1", live: true, by: "owner", went: true }, coming: { at, next } }),
    switcher({ slots: [LIB({ id: "cam1", hls: null, cam: true })], featured: { id: "cam1", live: true, by: "owner", went: true }, coming: { at, next } }),
  ];
  for (const x of over) {
    await x.adv(30000);
    assert.equal(l3(x), null, "nothing over " + x.sw.view());
    assert.equal(slateOf(x), null);
  }
  const idle = switcher({ slots: [], pepeOn: false, pepeHere: true, coming: { at, next } });
  assert.ok(slateOf(idle), "nothing on: the slate");
  assert.equal(l3(idle), null);
  assert.doesNotMatch(read("public", "js", "stage-room.js"), /js\.stage\.l3\.at/);
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

test("D + review F10 / safety F8 (1.99alc): the poll - a page without the /live long-poll: 10 s, 5 s from 2 min before a 📼 title's end, 3 s in its last 15 s; on the long-poll (stv): the ordinary 10 s throughout", async () => {
  const END = T0 + 180000;
  const x = switcher({ slots: [LIBP()], featured: { id: "lib1", live: true, by: "auto", went: true }, coming: { ends_at: END, next: NEXT_EP } });
  const polls = (y) => y.calls.filter((c) => c.url === "/api/stage?room=pad").length;
  const keep = () => ans([LIBP()], { id: "lib1", live: true, by: "auto", went: true }, { now: x.now(), coming: { ends_at: END, next: NEXT_EP } });
  for (let k = 0; k < 60; k++) x.answer(keep);
  await x.adv(50500);
  assert.equal(polls(x), 5, "10 s while the end is far (it was every 5 s for the whole title)");
  await x.adv(40000);                                          // 90.5 s: 89.5 s left
  const n1 = polls(x);
  await x.adv(30000);
  assert.ok(polls(x) - n1 >= 5 && polls(x) - n1 <= 7, "every 5 s in the last 2 min: " + (polls(x) - n1));
  await x.adv(48000);                                          // 168.5 s: inside the last 15 s
  const n2 = polls(x);
  await x.adv(9000);
  assert.ok(polls(x) - n2 >= 3, "every 3 s near the end: " + (polls(x) - n2));
  // the same page on the pad's /live long-poll: the wake is its fast path
  const z = switcher({ slots: [LIBP()], featured: { id: "lib1", live: true, by: "auto", went: true }, coming: { ends_at: T0 + 100000, next: NEXT_EP } });
  const zk = () => ans([LIBP()], { id: "lib1", live: true, by: "auto", went: true }, { now: z.now(), coming: { ends_at: T0 + 100000, next: NEXT_EP } });
  for (let k = 0; k < 30; k++) z.answer(zk);
  for (let s = 0; s < 10; s++) { z.sw.stv(7); await z.adv(9000); }
  assert.ok(polls(z) <= 10, "10 s with the long-poll: " + polls(z));
  const y = switcher({ slots: [LIB()], featured: { id: "lib1", live: true, by: "auto", went: true } });
  await y.adv(20500);
  assert.equal(polls(y), 2, "not a 📼 title: the ordinary 10 s");
});

test("D: only known shapes, text only - a bad key / a stray field never reaches the page; no innerHTML in the lower-third or the slate", async () => {
  const x = switcher({ slots: [LIBP()], featured: { id: "lib1", live: true, by: "auto", went: true },
                       coming: { ends_at: T0 + 10000, by: "someone", next: { title: "<b>A</b>\u0000", kind: "movie", key: "1234567890123", poster: true, username: "nope" } } });
  const b = l3(x);
  assert.equal(b.querySelector(".st-l3-title").textContent, "<b>A</b>");
  const js = read("public", "js", "stage-room.js");
  const code = js.slice(js.indexOf("// ── upnext2 (D): the 📼"), js.indexOf("    function show() {"));
  assert.ok(code.length > 2000);
  assert.doesNotMatch(code, /innerHTML/);
  assert.equal(EN["js.stage.l3.next"], "Up next");
  assert.equal(EN["js.stage.l3.in"], "in {time}");
  assert.equal(EN["js.stage.l3.hide"], "Hide");
  assert.equal(EN["js.stage.slate.at"], "Coming up at {time}");
  const css = read("public", "css", "stage-upnext.css");
  for (const sel of [".st-l3 {", ".st-l3-tag {", ".st-l3-title {", ".st-l3-when {", ".st-l3-x {", ".st-slate {", ".st-slate-kick {", ".st-slate-title {"]) assert.ok(css.includes(sel), sel);
  const rm = (/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css) || [])[1] || "";
  assert.match(rm, /\.st-l3 \{ animation: none; \}/);
  assert.match(read("views", "room.ejs"), /coming: <%- JSON\.stringify\(RS\.coming \|\| null\)\.replace\(\/<\/g, '\\\\u003c'\) %>,/);
});

test("review F5 / safety F10 (1.99alc): the off-air slate ({slate}) is OFF AIR on the classic homepage and the homepage Dock too - their own slate / off-air bar with its Next up stays", () => {
  const hd = read("public", "js", "home-dock.js");
  const m = /onAir: function \(on, sub, x\) \{ (var air = [^\n]*) \}\n/.exec(hd);
  assert.ok(m, "home-dock.js onAir");
  const box = { cls: new Set(), classList: { toggle(c, v) { if (v) box.cls.add(c); else box.cls.delete(c); } } };
  const dock = new Function("box", "on", "sub", "x", m[1]);
  dock(box, true, null, { slate: true });
  assert.deepEqual([...box.cls].sort(), ["is-off"], "the slate: off (the Dock's off-air bar says Next up)");
  dock(box, true, "📼 x", null);
  assert.deepEqual([...box.cls].sort(), ["is-on"], "a stream: on");
  const he = read("views", "home.ejs");
  const h = /onAir: function \(on, sub, x\) \{ (var air = [^\n]*) \}\n/.exec(he);
  assert.ok(h, "home.ejs onAir");
  const pills = [];
  const home = new Function("setPill", "_t", "on", "sub", "x", h[1]);
  const t = (k, d) => d;
  home((on, how) => pills.push([on, how]), t, true, null, { slate: true });
  home((on, how) => pills.push([on, how]), t, true, null, null);
  home((on, how) => pills.push([on, how]), t, true, "📼 A title", null);
  assert.deepEqual(pills, [[false, "nothing streaming right now"], [true, "live now"], [true, "📼 A title"]]);
});

test("review F2 + F1: the countdown strip and the one over the kept player's tail are ONE strip (the same element, announced once) - the marker's poster key doesn't make it a new one", async () => {
  const x = switcher({ slots: [LIBP()], featured: { id: "lib1", live: true, by: "auto", went: true }, coming: { ends_at: T0 + 5000, next: NEXT_EP } });
  x.player.playing();
  const b = l3(x);
  assert.ok(b);
  await x.adv(5500);
  x.answer(() => ans([], PEND(EPISODE(x.now(), { key: "912", poster: true }), { went: true }), { now: x.now() }));
  await x.poll();
  assert.equal(x.card(), null, "the tail still plays");
  assert.equal(l3(x), b, "the same strip");
  assert.equal(b.querySelector(".st-l3-when").textContent, "", "no countdown over the tail");
});
