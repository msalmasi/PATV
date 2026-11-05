"use strict";
// newstream 1.99akv (owner 2026-11-05: "When a new stream is created, the website isnt aware of it so you need to refresh to see it. Thats
// annoying."): the stage switcher (public/js/stage-room.js) picks up a stream that starts AFTER the page loaded:
//   1. a viewer who never chose a tab, sitting on Pepe's off-air slate (or on a pad he isn't in), gets a live stream that nobody featured as
//      the default - at load and at the next poll (it used to stay on "Pepe's stream is off air - pick a stream above", refresh or not) -
//      never a 🎬 cam, never over the mic stage, a featured stage or Pepe's stream while it shows; someone watching a stream is never moved
//   2. the 10 s poll follows the tab: a hidden tab skips its turn (unless the viewer may be listening: the player unmuted, an embed up) and
//      asks at once when the tab comes back (visibilitychange, a back/forward-cache restore, the network back) - a background tab came back
//      showing the stage as it was up to a minute before
// Each test failed on 1.99akr (eaaf29c9).
//   node --test test/newstream-stage.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");

function mk() {
  const e = { children: [], attrs: {}, style: {}, listeners: {}, className: "", classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { this.children.push(c); return c; }, insertBefore(c) { this.children.push(c); return c; }, removeChild(c) { return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, removeAttribute(k) { delete this.attrs[k]; },
    hasAttribute(k) { return k in this.attrs; }, addEventListener(k, fn) { (this.listeners[k] = this.listeners[k] || []).push(fn); }, removeEventListener() {},
    querySelectorAll: () => [], querySelector: () => null, play: () => Promise.resolve(), focus() {} };
  return e;
}
// a switcher whose polls answer from a queue; its 10 s timer is captured (x.tick() runs one turn), document.hidden is x.hide(bool),
// the player's state is x.media({running, muted})
function switcher(opts, env) {
  env = env || {};
  const js = read("public", "js", "stage-room.js");
  const answers = [], calls = [], intervals = [], dl = {}, wl = {};
  let hidden = false, media = { running: false, muted: true };
  const on = (map) => (k, fn) => { (map[k] = map[k] || []).push(fn); };
  const off = (map) => (k, fn) => { map[k] = (map[k] || []).filter((x) => x !== fn); };
  const document = { readyState: "complete", createElement: mk };
  if (!env.bareDocument) {
    Object.defineProperty(document, "hidden", { get: () => hidden });
    document.addEventListener = on(dl); document.removeEventListener = off(dl);
  }
  const ctx = { document, console, setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, clearInterval: (h) => { if (intervals[h - 1]) intervals[h - 1].dead = true; },
    setTimeout: (fn, ms) => (ms >= 40000 ? 0 : setTimeout(fn, ms)), clearTimeout: (h) => clearTimeout(h), location: { hostname: "x" },
    fetch: (url, init) => { calls.push({ url, init });
      const a = answers.length ? answers.shift() : null; return a === null ? Promise.reject(new Error("offline")) : Promise.resolve({ json: () => Promise.resolve(a) }); },
    confirm: () => true, alert() {} };
  ctx.window = ctx; ctx.window.addEventListener = on(wl); ctx.window.removeEventListener = off(wl);
  const src = [];
  ctx.PATVStage = { player: () => ({ stop() {}, setSrc(s) { src.push(s); }, start() {}, running: () => media.running, state: () => (media.running ? { playing: true, time: 1, muted: media.muted } : null) }) };
  ctx.PATVStageMic = { render: () => ({ update() {}, stop() {}, selection: () => ({ stream: "mic", embed: true, capture: false, nsfw: false }) }) };
  vm.runInNewContext(js, ctx);
  const tabs = mk(); let html = "";
  Object.defineProperty(tabs, "innerHTML", { set(v) { html = v; }, get() { return html; } });
  const embedHost = mk(); embedHost.innerHTML = "";
  const sw = ctx.PATVStage.switcher(Object.assign({ tabs, wrap: mk(), embedHost, api: "/api/stage?room=pad", slots: [], pepeOn: false, pepeHere: true, slug: "pad", watch: false }, opts));
  const click = (v) => { const b = { hasAttribute: (k) => k === "data-v", getAttribute: () => v }; tabs.listeners.click[0]({ target: { closest: () => b } }); };
  const settle = () => new Promise((r) => setTimeout(r, 5));
  const poll10 = () => intervals.filter((t) => !t.dead && t.ms === 10000);
  return { sw, tabs: () => html, src, click, calls, answer: (a) => answers.push(a), poll: () => sw.poll(), settle,
           hide: (h) => { hidden = h; }, media: (m) => { media = Object.assign(media, m); },
           tick: async () => { const t = poll10(); assert.equal(t.length, 1, "one 10 s poll timer"); t[0].fn(); await settle(); },
           fire: async (map, k, ev) => { (map === "doc" ? dl : wl)[k] && (map === "doc" ? dl : wl)[k].forEach((f) => f(ev || {})); await settle(); },
           listeners: () => ({ doc: Object.keys(dl).filter((k) => dl[k].length), win: Object.keys(wl).filter((k) => wl[k].length && k !== "load") }),
           stageCalls: () => calls.filter((c) => /^\/api\/stage\?room=/.test(c.url)).length };
}
const H = (id, extra) => Object.assign({ id, display: "Juniper", featured: false, feature_by: null, hls: "/hls/" + id + ".m3u8", since: 1, live: true }, extra || {});
const live = (slots, extra) => Object.assign({ active: false, pepe_here: true, slots, featured: null, now: Date.now() }, extra || {});
const MIC = (extra) => Object.assign({ v: 1, active: true, count: 2, default: "first", layout: "split", src: [{ id: "a" }, { id: "b" }] }, extra || {});

test("1a: a stream nobody featured that starts while Pepe is off air becomes the default at the next poll (the owner's report)", async () => {
  const x = switcher({ pepeOn: false });
  assert.equal(x.sw.view(), "pepe", "nothing on: Pepe's off-air slate");
  x.answer(live([H("s1")])); await x.poll();
  assert.equal(x.sw.view(), "slot:s1", "the new stream plays - no refresh, no pick");
  assert.equal(x.src[x.src.length - 1], "/hls/s1.m3u8");
  assert.match(x.tabs(), /data-v="slot:s1" aria-selected="true"/);
});

test("1b: the same at load - a page opened with an unfeatured stream live and Pepe off air (a refresh didn't help either)", () => {
  const x = switcher({ pepeOn: false, slots: [H("s1")] });
  assert.equal(x.sw.view(), "slot:s1");
  // an embed (a Go Live video link) counts; a cam never does (a cam is the default only when featured - D-21)
  const e = switcher({ pepeOn: false, slots: [H("v1", { hls: null, embed: { p: "youtube", t: "video", id: "bbbbbbbbbbb" } })] });
  assert.equal(e.sw.view(), "slot:v1");
  const c = switcher({ pepeOn: false, slots: [H("c1", { hls: null, cam: true })] });
  assert.equal(c.sw.view(), "pepe", "a cam: its tab, never the default");
  // a pad Pepe isn't in: no Pepe tab at all - the stream, not "pick a stream above"
  const away = switcher({ pepeOn: true, pepeHere: false, slots: [H("s1")] });
  assert.equal(away.sw.view(), "slot:s1");
});

test("1c: the existing rules still win - Pepe's stream while it shows, the mic stage, a featured stream, the viewer's own pick", async () => {
  const p = switcher({ pepeOn: true });
  p.answer(live([H("s1")], { active: true })); await p.poll();
  assert.equal(p.sw.view(), "pepe", "Pepe on air and nothing featured: his stream, as before");
  const m = switcher({ pepeOn: false });
  m.sw.setMic(MIC()); assert.equal(m.sw.view(), "mic");
  m.answer(live([H("s1")])); await m.poll();
  assert.equal(m.sw.view(), "mic", "the mic stage stays the default over an unfeatured stream");
  const f = switcher({ pepeOn: false });
  f.answer(live([H("s1"), H("s2", { featured: true, feature_by: "owner" })], { featured: { id: "s2", live: true, by: "owner", went: true } })); await f.poll();
  assert.equal(f.sw.view(), "slot:s2", "featured beats the first live one");
  const c = switcher({ pepeOn: false });
  c.click("pepe");
  c.answer(live([H("s1")])); await c.poll();
  assert.equal(c.sw.view(), "pepe", "a viewer who picked Pepe's tab keeps it");
});

test("1d: nothing jumps under a viewer - Pepe coming back on air leaves them on the stream; it ends: back to the defaults", async () => {
  const x = switcher({ pepeOn: false });
  x.answer(live([H("s1")])); await x.poll();
  assert.equal(x.sw.view(), "slot:s1");
  x.answer(live([H("s1")], { active: true })); await x.poll();
  assert.equal(x.sw.view(), "slot:s1", "Pepe on air again: the stream they're watching stays");
  x.answer(live([], { active: true })); await x.poll();
  assert.equal(x.sw.view(), "pepe", "the stream ended: Pepe's stream");
  // Pepe goes OFF air while a stream is live: the slate gives way to the stream at that poll
  const y = switcher({ pepeOn: true, slots: [H("s1")] });
  assert.equal(y.sw.view(), "pepe");
  y.answer(live([H("s1")], { active: false })); await y.poll();
  assert.equal(y.sw.view(), "slot:s1");
  // a second stream starting never moves a viewer from the first
  y.answer(live([H("s1"), H("s2")])); await y.poll();
  assert.equal(y.sw.view(), "slot:s1");
  assert.match(y.tabs(), /data-v="slot:s2"/, "its tab is there to pick");
});

test("2a: a hidden tab skips its 10 s turn - and asks at once when it comes back (visibilitychange, pageshow from the bfcache, online)", async () => {
  const x = switcher({ pepeOn: false });
  x.hide(true);
  x.answer(live([H("s1")]));
  await x.tick();
  assert.equal(x.stageCalls(), 0, "hidden: no /api/stage call");
  await x.fire("doc", "visibilitychange");
  assert.equal(x.stageCalls(), 0, "still hidden: nothing");
  x.hide(false);
  await x.fire("doc", "visibilitychange");
  assert.equal(x.stageCalls(), 1, "back in view: one call at once");
  assert.equal(x.sw.view(), "slot:s1", "and the stream that started meanwhile is up");
  await x.tick();
  assert.equal(x.stageCalls(), 2, "visible: the 10 s turn runs as before");
  // a back/forward-cache restore and the network coming back ask too (not twice within a moment)
  x.answer(live([H("s1")])); x.answer(live([H("s1")]));
  await x.fire("win", "pageshow", { persisted: false });
  assert.equal(x.stageCalls(), 2, "an ordinary load's pageshow: nothing");
  await new Promise((r) => setTimeout(r, 1600));
  await x.fire("win", "pageshow", { persisted: true });
  assert.equal(x.stageCalls(), 3);
  await x.fire("win", "online");
  assert.equal(x.stageCalls(), 3, "within 1.5 s of the last call: no second one");
});

test("2b: a hidden tab whose viewer may be LISTENING keeps its turn - the player running unmuted, or an embed up", async () => {
  const x = switcher({ pepeOn: true });
  x.hide(true);
  x.media({ running: true, muted: true });
  await x.tick(); assert.equal(x.stageCalls(), 0, "muted: nobody hears it");
  x.media({ running: true, muted: false });
  x.answer(live([], { active: true }));
  await x.tick(); assert.equal(x.stageCalls(), 1, "unmuted: a background listener - the stage keeps up (a new featured stream is heard)");
  const e = switcher({ pepeOn: false, slots: [H("v1", { hls: null, embed: { p: "youtube", t: "video", id: "bbbbbbbbbbb" } })] });
  e.hide(true);
  e.answer(live([H("v1", { hls: null, embed: { p: "youtube", t: "video", id: "bbbbbbbbbbb" } })]));
  await e.tick(); assert.equal(e.stageCalls(), 1, "an embed: its player isn't ours - it may be heard");
});

test("2c: destroy() drops the tab listeners (the homepage's front-pad swap); a page whose document has no events API still works", async () => {
  const x = switcher({ pepeOn: false });
  assert.deepEqual(x.listeners(), { doc: ["visibilitychange"], win: ["pageshow", "online"] });
  x.sw.destroy();
  assert.deepEqual(x.listeners(), { doc: [], win: [] });
  const bare = switcher({ pepeOn: false }, { bareDocument: true });
  bare.answer(live([H("s1")]));
  await bare.tick();
  assert.equal(bare.stageCalls(), 1, "no document.hidden: visible");
  assert.equal(bare.sw.view(), "slot:s1");
});

test("2d: room.ejs and home.ejs load the new stage-room.js (v=24)", () => {
  for (const v of ["room.ejs", "home.ejs"]) assert.match(read("views", v), /stage-room\.js\?v=24/, v);
});
