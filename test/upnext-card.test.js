"use strict";
// upnext (owner 2026-11-05: "Yes up next card sounds good. Do it a classic / retro Public Access tv style."): the PAGE half of the 📼
// "Coming up next" card - public/js/stage-room.js's switcher in a small DOM (real class lists / attributes / children) on a clock we move:
//   * a featured marker WITH next is the featured stage: it beats an active mic stage and shows the card (a page that never saw the slot
//     live too - the one exception to dock3's C2); the C2 marker without next still never does
//   * the card: role=status / aria-live (filled after mount), the title / year / episode as text, the poster only for a signed-in viewer
//     through /api/medialib/poster (none on error), "PLEASE STAND BY" from 30 s, the server's clock
//   * at next.until it goes and the defaults are back (mic follows) without waiting for a poll; a stale answer can't bring it back
//   * the stream comes up: the player starts behind the card, which fades once it plays (or after 20 s: the player's own overlay)
//   * a viewer who picked a tab stays; a held 📼 queue slot gets the card; a 3 s poll while it's up; never captured
//   node --test test/upnext-card.test.js
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
  const player = { src: [], starts: 0, stops: 0, on: false,
    stop() { this.stops++; this.on = false; reconnect.classList.add("hide"); unmute.classList.add("hide"); },
    setSrc(s) { this.src.push(s); }, start() { if (this.on) return; this.starts++; this.on = true; reconnect.classList.remove("hide"); unmute.classList.remove("hide"); },
    running() { return this.on; }, playing() { reconnect.classList.add("hide"); } };
  const ctx = { document: { readyState: "complete", createElement: mkEl, documentElement: { lang: "en" } }, console, Date: FakeDate, Intl, encodeURIComponent,
    setTimeout: (fn, ms) => add(fn, ms, false), clearTimeout: clear, setInterval: (fn, ms) => add(fn, ms, true), clearInterval: clear, location: { hostname: "x" },
    fetch: (url, init) => { calls.push({ url, init, at: clock.t });
      if (/\/api\/stage\/(pepe\/feature|slots\/)/.test(url)) return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
      const a = answers.length ? answers.shift() : { stale: true };
      return a === null ? Promise.reject(new Error("offline")) : Promise.resolve({ json: () => Promise.resolve(typeof a === "function" ? a() : a) }); },
    confirm: () => true, alert() {}, matchMedia: () => ({ matches: !!env.reduced }) };
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
  return { sw, wrap, tabs: () => html, air, calls, player, reconnect, unmute, card, q, adv, click, now: () => clock.t,
           answer: (a) => answers.push(a), poll: async () => { await sw.poll(); await flush(); }, timers };
}
const MIC = (extra) => Object.assign({ v: 1, active: true, count: 2, default: "first", layout: "split", src: [{ id: "a" }, { id: "b" }] }, extra || {});
const MOVIE = (at, extra) => Object.assign({ title: "Night of the Living Dead", kind: "movie", year: 1968, show: null, season: null, episode: null, poster: true, key: "501",
  at, until: at + 90000, now: at }, extra || {});
const EPISODE = (at, extra) => Object.assign({ title: "Second", kind: "episode", year: null, show: "The Show", season: 1, episode: 2, poster: false, at, until: at + 90000, now: at }, extra || {});
const PEND = (next, extra) => Object.assign({ id: "lib1", live: false, by: "auto", went: false, next }, extra || {});
const LIB = (extra) => Object.assign({ id: "lib1", display: "Admin", featured: true, feature_by: "auto", hls: "/hls/lib1.m3u8", since: 1, title: "📼 Night of the Living Dead (1968)" }, extra || {});
const ans = (slots, featured, extra) => Object.assign({ active: true, pepe_here: true, slots, featured: featured === undefined ? null : featured, now: Date.now() }, extra || {});

test("a featured marker WITH next is the pad's featured stage: it beats an active mic stage, shows the card, stops the player, the tab says 📼 Up next", async () => {
  const x = switcher({ featured: PEND(MOVIE(T0)), posters: true });
  x.sw.setMic(MIC());
  assert.equal(x.sw.view(), "slot:lib1", "not the mic stage (the page never saw the slot live - the card is still the featured stage)");
  const c = x.card();
  assert.ok(c, "the card is on the stage");
  assert.equal(x.wrap.children[0], c, "the first child of the player's box");
  assert.equal(c.getAttribute("role"), "status");
  assert.equal(c.getAttribute("aria-live"), "polite");
  assert.equal(c.getAttribute("data-state"), "starting");
  assert.equal(c.getAttribute("data-len"), "s");
  assert.equal(x.q(".st-un-title").textContent, "Night of the Living Dead");
  assert.equal(x.q(".st-un-meta").textContent, "1968 · Movie");
  assert.equal(x.q(".st-un-kick").textContent, "Coming up next");
  assert.equal(x.q(".st-un-word").textContent, "Starting");
  assert.equal(x.q(".st-un-bug").textContent, "PATV");
  assert.equal(x.q(".st-un-screen").getAttribute("aria-hidden"), "true");
  assert.equal(x.q(".st-un-bars").children.length, 7, "seven 75% bars");
  assert.equal(x.q(".st-un-sr").textContent, "", "the live region goes in empty...");
  await x.adv(80);
  assert.equal(x.q(".st-un-sr").textContent, "Up next on the stage: Night of the Living Dead (1968) – starting…", "...and is filled a moment later (announced)");
  assert.ok(x.player.stops > 0 && x.player.starts === 0, "no player under a card");
  assert.equal(x.reconnect.style.visibility, "hidden", "the player's own overlays are out of the way");
  assert.equal(x.unmute.style.visibility, "hidden");
  assert.deepEqual(x.air[x.air.length - 1], [true, "📼 Night of the Living Dead (1968)", { pending: true }], "ON AIR (clears the old homepage's off-air slate)");
  assert.match(x.tabs(), /<button type="button" class="stab feat off pending" role="tab" data-v="slot:lib1" aria-selected="true" title="Night of the Living Dead \(1968\)">/);
  assert.match(x.tabs(), /<span class="star"[^>]*>★<\/span><span class="n">📼 Up next<\/span>/);
  assert.deepEqual({ ...x.sw.selection() }, { stream: "lib1", label: "📼", embed: true, capture: false, nsfw: false }, "never captured, no watch-minutes");
});

test("dock3's C2 holds: the server's marker WITHOUT next never beats the mic stage (no card)", () => {
  const x = switcher({ featured: { id: "lib1", live: false, by: "auto", went: true } });
  x.sw.setMic(MIC());
  assert.equal(x.sw.view(), "mic");
  assert.equal(x.card(), null);
  assert.doesNotMatch(x.tabs(), /pending/);
  const y = switcher({ featured: PEND(MOVIE(T0 - 95000, { now: T0 })) });   // its 90 s are over already (the server's clock says so)
  y.sw.setMic(MIC());
  assert.equal(y.sw.view(), "mic", "an up next past its until is no up next");
  assert.equal(y.card(), null);
});

test("the poster: a signed-in viewer's comes through the site's proxy; signed out, no poster - and one that fails to load is the plain card", async () => {
  const s = switcher({ featured: PEND(MOVIE(T0)), posters: true });
  const img = s.q(".st-un-pic") && s.q(".st-un-pic").children[0];
  assert.ok(img, "signed in: a poster sleeve");
  assert.equal(img.src, "/api/medialib/poster/501", "only ever the site's own proxy");
  assert.equal(img.alt, "");
  assert.equal(s.card().getAttribute("data-poster"), "1");
  img.onerror();
  assert.equal(s.card().getAttribute("data-poster"), "0", "a poster that doesn't load: the plain CG card, never a broken image");
  const o = switcher({ featured: PEND(MOVIE(T0)), posters: false });
  assert.equal(o.q(".st-un-pic"), null, "signed out: no request at all");
  assert.equal(o.card().getAttribute("data-poster"), "0");
  const n = switcher({ featured: PEND(MOVIE(T0, { poster: false, key: undefined })), posters: true });
  assert.equal(n.q(".st-un-pic"), null, "no poster in Plex");
  const bad = switcher({ featured: PEND(MOVIE(T0, { key: "../x?X-Plex-Token=1" })), posters: true });
  assert.equal(bad.q(".st-un-pic"), null, "a key that isn't a rating key never becomes a URL");
});

test("an episode: the show big, S1 · E2 and its title under it; the screen-reader line in words", async () => {
  const x = switcher({ featured: PEND(EPISODE(T0)) });
  assert.equal(x.q(".st-un-title").textContent, "The Show");
  assert.equal(x.q(".st-un-meta").textContent, "S1 · E2");
  assert.equal(x.q(".st-un-ep").textContent, "Second");
  await x.adv(80);
  assert.equal(x.q(".st-un-sr").textContent, "Up next on the stage: The Show, season 1, episode 2, Second – starting…");
  assert.equal(x.air[x.air.length - 1][1], "📼 The Show – Second");
  const long = switcher({ featured: PEND(MOVIE(T0, { title: "The Incredibly Strange Creatures Who Stopped Living and Became Mixed-Up Zombies!!?" })) });
  assert.equal(long.card().getAttribute("data-len"), "xl");
  const html = switcher({ featured: PEND(MOVIE(T0, { title: "<img src=x onerror=alert(1)>" })) });
  assert.equal(html.q(".st-un-title").textContent, "<img src=x onerror=alert(1)>", "server text is text (textContent), never markup");
  assert.equal(html.q(".st-un-title").children.length, 0);
});

test("30 s in: PLEASE STAND BY; at next.until the card goes and the defaults are back (mic follows) without a poll - and a stale answer can't bring it back", async () => {
  const x = switcher({ featured: PEND(MOVIE(T0)) });
  x.sw.setMic(MIC());
  assert.equal(x.sw.view(), "slot:lib1");
  await x.adv(29000);
  assert.equal(x.card().getAttribute("data-state"), "starting");
  await x.adv(1100);
  assert.equal(x.card().getAttribute("data-state"), "standby");
  assert.equal(x.q(".st-un-word").textContent, "Please stand by");
  // the 3 s poll answers "stale" (moves nothing) all along: the timer alone ends it
  await x.adv(58000);
  assert.ok(x.card() && !x.card().classList.contains("is-out"), "88.1 s: still up");
  assert.equal(x.sw.view(), "slot:lib1");
  await x.adv(2000);
  assert.equal(x.sw.view(), "mic", "90 s: mic follows takes the stage");
  assert.ok(x.card() && x.card().classList.contains("is-out"), "fading");
  await x.adv(800);
  assert.equal(x.card(), null, "gone");
  assert.equal(x.reconnect.style.visibility, "", "overlays back");
  assert.doesNotMatch(x.tabs(), /pending/);
  // a poll whose server still names it (its clock a little behind) never puts it back
  x.answer(ans([], PEND(MOVIE(T0), { now: T0 + 89000 }), { now: T0 + 89000 }));
  await x.poll();
  assert.equal(x.sw.view(), "mic");
  assert.equal(x.card(), null);
  // a NEW up next on that slot (a later title) is its own card
  x.answer(ans([], PEND(MOVIE(T0 + 120000, { title: "Charade", year: 1963, key: "500", now: T0 + 121000 })), { now: T0 + 121000 }));
  await x.poll();
  assert.equal(x.sw.view(), "slot:lib1");
  assert.equal(x.q(".st-un-title").textContent, "Charade");
});

test("timers run on the SERVER's clock: a viewer whose clock is 2 min ahead (first render: next.now) still gets its 90 s, and the stand-by on time", async () => {
  const x = switcher({ featured: PEND(MOVIE(T0)) }, { skewMs: 120000 });
  x.sw.setMic(MIC());
  assert.equal(x.sw.view(), "slot:lib1", "not taken for expired by a fast local clock");
  await x.adv(30100);
  assert.equal(x.card().getAttribute("data-state"), "standby");
  await x.adv(58000);
  assert.equal(x.sw.view(), "slot:lib1");
  await x.adv(2500);
  assert.equal(x.sw.view(), "mic");
});

test("the stream comes up: its player starts behind the card, which fades once it plays; the view never moved", async () => {
  const x = switcher({ featured: PEND(MOVIE(T0)) });
  x.sw.setMic(MIC());
  await x.adv(4000);
  x.answer(ans([LIB()], { id: "lib1", live: true, by: "auto", went: true }));
  await x.poll();
  assert.equal(x.sw.view(), "slot:lib1");
  assert.deepEqual(x.player.src.slice(-1), ["/hls/lib1.m3u8"]);
  assert.equal(x.player.starts, 1, "started behind the card");
  assert.ok(x.card() && !x.card().classList.contains("is-out"), "the card stays until the first frame");
  assert.equal(x.reconnect.style.visibility, "hidden", "...over the player's 'Reconnecting…'");
  assert.doesNotMatch(x.tabs(), /pending/, "the tab is the live slot's now");
  await x.adv(1000);
  assert.ok(!x.card().classList.contains("is-out"), "not playing yet");
  x.player.playing();                                           // the first frame: the reconnect overlay hides
  await x.adv(300);
  assert.ok(x.card().classList.contains("is-out"), "fading out");
  assert.equal(x.reconnect.style.visibility, "", "the player's overlays are its own again");
  await x.adv(800);
  assert.equal(x.card(), null);
  assert.deepEqual({ ...x.sw.selection() }, { stream: "lib1", label: "Admin", embed: false, capture: true, nsfw: false }, "a live stream: snaps / clips again");
  // reduced motion: the same, a shorter fade
  const r = switcher({ featured: PEND(MOVIE(T0)) }, { reduced: true });
  r.answer(ans([LIB()], { id: "lib1", live: true, by: "auto", went: true })); await r.poll();
  r.player.playing(); await r.adv(300);
  assert.ok(r.card().classList.contains("is-out"));
  await r.adv(300);
  assert.equal(r.card(), null, "gone in ~0.25 s");
});

test("a stream that's listed but never plays: after 20 s the card goes and the player's own reconnecting overlay shows", async () => {
  const x = switcher({ featured: PEND(MOVIE(T0)) });
  x.answer(ans([LIB()], { id: "lib1", live: true, by: "auto", went: true }));
  await x.poll();
  await x.adv(19000);
  assert.ok(x.card());
  await x.adv(1500);
  assert.equal(x.card(), null);
  assert.equal(x.reconnect.classList.contains("hide"), false, "Reconnecting… (the player's retry runs)");
  assert.equal(x.reconnect.style.visibility, "");
});

test("a 📼 queue between two titles: the slot this page held gets the card (tagged pending), then the next title's stream", async () => {
  const x = switcher({ slots: [LIB({ title: "📼 The Show — S1E1 Pilot" })], featured: { id: "lib1", live: true, by: "auto", went: true } });
  x.sw.setMic(MIC());
  assert.equal(x.sw.view(), "slot:lib1");
  assert.equal(x.card(), null);
  // title 1 ended: not listed, still featured, next = title 2
  x.answer(ans([], PEND(EPISODE(T0), { went: true })));
  await x.poll();
  assert.equal(x.sw.view(), "slot:lib1", "held");
  assert.ok(x.card(), "the card instead of 'Reconnecting…'");
  assert.equal(x.q(".st-un-title").textContent, "The Show");
  assert.match(x.tabs(), /class="stab feat off pending"/);
  // a plain drop (a 📼 pause: no next) is the old hold - no card
  const y = switcher({ slots: [LIB()], featured: { id: "lib1", live: true, by: "auto", went: true } });
  y.answer(ans([], { id: "lib1", live: false, by: "auto", went: true }));
  await y.poll();
  assert.equal(y.sw.view(), "slot:lib1");
  assert.equal(y.card(), null, "a pause is still 'Reconnecting…'");
  // the next title publishes
  x.answer(ans([LIB({ title: "📼 The Show — S1E2 Second" })], { id: "lib1", live: true, by: "auto", went: true }));
  await x.poll();
  x.player.playing(); await x.adv(1200);
  assert.equal(x.card(), null);
  assert.equal(x.sw.view(), "slot:lib1");
});

test("while the card is up the page asks every 3 s; it stops once the card is gone", async () => {
  const x = switcher({ featured: PEND(MOVIE(T0)) });
  const polls = () => x.calls.filter((c) => c.url === "/api/stage?room=pad").length;
  await x.adv(9500);
  assert.equal(polls(), 3, "3, 6, 9 s");
  x.answer(ans([LIB()], { id: "lib1", live: true, by: "auto", went: true }));
  await x.adv(3000);
  const n0 = polls();
  await x.adv(9000);
  assert.ok(polls() - n0 <= 1, "back on the ordinary 10 s poll");
});

test("a viewer who picked a tab is never moved by an up next - the 📼 Up next tab is there if they want it", async () => {
  const other = { id: "s2", display: "Willow", featured: false, feature_by: null, hls: "/hls/s2.m3u8", since: 1 };
  const x = switcher({ slots: [other] });
  x.click("pepe");
  assert.equal(x.sw.view(), "pepe");
  x.answer(ans([other], PEND(MOVIE(T0))));
  await x.poll();
  assert.equal(x.sw.view(), "pepe", "theirs");
  assert.equal(x.card(), null);
  assert.match(x.tabs(), /data-v="slot:lib1"[^>]*>.*📼 Up next/);
  x.click("slot:lib1");
  assert.ok(x.card(), "the card when they pick it");
  x.click("slot:s2");
  assert.ok(x.card().classList.contains("is-out"), "and it goes when they pick another stream");
  // a viewer who never chose goes to it
  const y = switcher({ slots: [other] });
  y.answer(ans([other], PEND(MOVIE(T0))));
  await y.poll();
  assert.equal(y.sw.view(), "slot:lib1");
});

test("destroy() (the homepage's front-pad swap) stops the card and its timers", async () => {
  const x = switcher({ featured: PEND(MOVIE(T0)) });
  assert.ok(x.card());
  x.sw.destroy();
  assert.equal(x.card(), null);
  const n0 = x.calls.length;
  await x.adv(10000);
  assert.equal(x.calls.length, n0, "no more polls");
});

test("cleanFeat keeps only known shapes of next (and the card never takes a key that isn't digits)", () => {
  const x = switcher({ featured: PEND({ title: "A\u0000B", kind: "weird", year: "1968x", at: T0, until: T0 + 10 * 3600000, now: T0, key: "12345678901234", poster: true }) });
  assert.equal(x.q(".st-un-title").textContent, "A B");
  assert.equal(x.q(".st-un-meta").textContent, "Movie", "no year that isn't one");
  assert.equal(x.q(".st-un-pic"), null, "no 13-digit key");
  const y = switcher({ featured: PEND({ title: "", show: "", at: T0 }) });
  assert.equal(y.card(), null, "nothing to say: no card");
});

test("views + strings + styles: the css is linked, stage-room.js v23, the posters flag on every surface, en.json, motion rules", () => {
  for (const v of ["room.ejs", "home.ejs"]) {
    const src = read("views", v);
    assert.match(src, /stage-room\.js\?v=23/, v);
    assert.match(src, /\/public\/css\/stage-upnext\.css\?v=1/, v);
  }
  assert.match(read("views", "room.ejs"), /posters: <%= signedIn_ \? 'true' : 'false' %>/);
  assert.match(read("views", "home.ejs"), /posters: <%= typeof me !== 'undefined' && me \? 'true' : 'false' %>/);
  assert.match(read("public", "js", "home-dock.js"), /posters: !!I\.signed/);
  assert.match(read("views", "home.ejs"), /home-dock\.js\?v=5/);
  for (const [k, v] of Object.entries({ "js.stage.upnext.kicker": "Coming up next", "js.stage.upnext.starting": "Starting", "js.stage.upnext.standby": "Please stand by",
    "js.stage.upnext.aria": "Up next on the stage: {title} – starting…", "js.stage.upnext.episode_aria": "season {season}, episode {episode}",
    "js.stage.upnext.movie": "Movie", "js.stage.upnext.episode": "S{season} · E{episode}", "js.stage.upnext.tab": "📼 Up next" })) assert.equal(EN[k], v, k);
  const css = read("public", "css", "stage-upnext.css");
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /infinite/, "nothing loops: every animation ends within ~5 s (WCAG 2.2.2)");
  assert.match(css, /animation: stUnBlink 1s steps\(1, end\) 5;/, "the cursor: 1 blink a second, 5 times, then lit");
  assert.match(css, /animation: stUnRoll 4\.5s linear \.6s 1 both;/, "the hum bar rolls once");
  const rm = (/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css) || [])[1] || "";
  assert.match(rm, /\.st-un-roll \{ display: none; animation: none; \}/);
  assert.match(rm, /\.st-un-cur \{ display: none; animation: none; \}/);
  assert.match(css, /\.st-upnext\[data-state="standby"\] :is\(\.st-un-play, \.st-un-cur, \.st-un-dots\) \{ display: none; \}/);
  assert.match(css, /#rmStage\.rmd-controls-on \.st-upnext :is\(\.st-un-top, \.st-un-foot\) \{ opacity: 0; \}/);
  assert.match(css, /container: stun \/ size;/);
  assert.doesNotMatch(css, /VT323|@import|url\(["']?https?:/i, "only the site's own fonts, nothing external");
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /(^|[^-])\.upnext\b/m, "never the schedule list's .upnext class");
  const js = read("public", "js", "stage-room.js");
  const card = js.slice(js.indexOf("function upCard("), js.indexOf("function upShow("));
  assert.ok(card.length > 1000);
  assert.doesNotMatch(card, /innerHTML/, "the card is built with textContent only");
});
