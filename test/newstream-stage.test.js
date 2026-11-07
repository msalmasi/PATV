"use strict";
// newstream 1.99ala (owner 2026-11-05: "When a new stream is created, the website isnt aware of it so you need to refresh to see it. Thats
// annoying."): the stage switcher (public/js/stage-room.js) follows a stream that starts AFTER the page loaded the way a reload would show it:
//   1. a featured stream (the pad's takeover auto-features one that goes live) becomes the default at the next poll; an UNFEATURED one gets
//      its tab and is never made everyone's default (review F2: the pad's "Feature a live stream automatically: Off", a person's ☆ Unfeature,
//      Pepe's feature decide what everyone sees - a reload shows the same), so a blip of Pepe's stream moves nobody (review F3 / M1)
//   2. the 10 s poll follows the tab: a hidden tab skips its turn ONLY while the stage plays nothing (the off-air slate) - a running player
//      (muted too: the poll is what stops an ended slot's player - review M2), an embed, a cam, the mic stage, a stage moved to the Dock's
//      picture-in-picture window (review F1) keep it as before; back in view it asks at once, and the 10 s turn right after that is skipped
//      (review L4: one call, not two)
// 1a, 1c, 2a, 2b, 2c failed on the build (166574d7 rebased: 14493c6f); 1b, 1d, 2d, 2e are guards.
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
    querySelectorAll: () => [], querySelector: () => null, contains: () => false, play: () => Promise.resolve(), focus() {} };
  return e;
}
// a switcher whose polls answer from a queue; its 10 s timer is captured (x.tick() runs one turn), document.hidden is x.hide(bool),
// the player's state is x.media({running, muted}), the page's clock is x.later(ms)
function switcher(opts, env) {
  env = env || {};
  const js = read("public", "js", "stage-room.js");
  const answers = [], calls = [], intervals = [], dl = {}, wl = {};
  let hidden = false, media = { running: false, muted: true }, skew = 0, stops = 0;
  const realNow = Date.now;
  class PageDate extends Date { static now() { return realNow() + skew; } }
  const on = (map) => (k, fn) => { (map[k] = map[k] || []).push(fn); };
  const off = (map) => (k, fn) => { map[k] = (map[k] || []).filter((x) => x !== fn); };
  const document = { readyState: "complete", createElement: mk };
  if (!env.bareDocument) {
    Object.defineProperty(document, "hidden", { get: () => hidden });
    document.addEventListener = on(dl); document.removeEventListener = off(dl);
  }
  const ctx = { document, console, Date: PageDate, setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }, clearInterval: (h) => { if (intervals[h - 1]) intervals[h - 1].dead = true; },
    setTimeout: (fn, ms) => (ms >= 40000 ? 0 : setTimeout(fn, ms)), clearTimeout: (h) => clearTimeout(h), location: { hostname: "x" },
    fetch: (url, init) => { calls.push({ url, init });
      const a = answers.length ? answers.shift() : null; return a === null ? Promise.reject(new Error("offline")) : Promise.resolve({ json: () => Promise.resolve(a) }); },
    confirm: () => true, alert() {} };
  ctx.window = ctx; ctx.window.addEventListener = on(wl); ctx.window.removeEventListener = off(wl);
  const src = [];
  ctx.PATVStage = { player: () => ({ stop() { stops++; media.running = false; }, setSrc(s) { src.push(s); }, start() { media.running = true; }, running: () => media.running,
                                     state: () => (media.running ? { playing: true, time: 1, muted: media.muted } : null) }) };
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
           hide: (h) => { hidden = h; }, media: (m) => { media = Object.assign(media, m); }, stops: () => stops, later: (ms) => { skew += ms; },
           tick: async () => { const t = poll10(); assert.equal(t.length, 1, "one 10 s poll timer"); t[0].fn(); await settle(); },
           fire: async (map, k, ev) => { (map === "doc" ? dl : wl)[k] && (map === "doc" ? dl : wl)[k].forEach((f) => f(ev || {})); await settle(); },
           listeners: () => ({ doc: Object.keys(dl).filter((k) => dl[k].length), win: Object.keys(wl).filter((k) => wl[k].length && k !== "load") }),
           stageCalls: () => calls.filter((c) => /^\/api\/stage\?room=/.test(c.url)).length };
}
const H = (id, extra) => Object.assign({ id, display: "Juniper", featured: false, feature_by: null, hls: "/hls/" + id + ".m3u8", since: 1, live: true }, extra || {});
const F = (id, extra) => H(id, Object.assign({ featured: true, feature_by: "auto" }, extra || {}));
const FH = (id) => ({ id, live: true, by: "auto", went: true });
const live = (slots, extra) => Object.assign({ active: false, pepe_here: true, slots, featured: null, now: Date.now() }, extra || {});
const MIC = (extra) => Object.assign({ v: 1, active: true, count: 2, default: "first", layout: "split", src: [{ id: "a" }, { id: "b" }] }, extra || {});

test("1a: an UNFEATURED live stream is never made the default - not at a poll, not at load, not when Pepe goes off air (review F2); its tab is there to pick", async () => {
  // (the default takeover features a stream that goes live; an unfeatured one next to nothing featured = the pad's takeover is Off, a person
  // took the feature away (auto_off) or Pepe's stream is featured - each a choice about what everyone sees)
  const x = switcher({ pepeOn: false });
  x.answer(live([H("s1")])); await x.poll();
  assert.equal(x.sw.view(), "pepe", "the off-air slate - as a reload shows it");
  assert.match(x.tabs(), /data-v="slot:s1" aria-selected="false"/, "the page knows the stream: its tab");
  const atLoad = switcher({ pepeOn: false, slots: [H("s1")] });
  assert.equal(atLoad.sw.view(), "pepe", "at load the same");
  const embed = switcher({ pepeOn: false, slots: [H("v1", { hls: null, embed: { p: "youtube", t: "video", id: "bbbbbbbbbbb" } })] });
  assert.equal(embed.sw.view(), "pepe");
  const away = switcher({ pepeOn: true, pepeHere: false, slots: [H("s1")] });
  assert.equal(away.sw.view(), "pepe", "a pad Pepe isn't in: \"pick a stream above\"");
  const y = switcher({ pepeOn: true, slots: [H("s1")] });
  y.answer(live([H("s1")], { active: false })); await y.poll();
  assert.equal(y.sw.view(), "pepe", "Pepe off air while it is live: nobody is moved onto it");
});

test("1b: a FEATURED stream that starts after load is the default at the next poll - the owner's report on a pad's stage (guard)", async () => {
  const x = switcher({ pepeOn: false });
  assert.equal(x.sw.view(), "pepe");
  x.answer(live([F("s1")], { featured: FH("s1") })); await x.poll();
  assert.equal(x.sw.view(), "slot:s1", "no refresh, no pick");
  assert.equal(x.src[x.src.length - 1], "/hls/s1.m3u8");
  const p = switcher({ pepeOn: true });
  p.answer(live([F("s1")], { active: true, featured: FH("s1") })); await p.poll();
  assert.equal(p.sw.view(), "slot:s1", "over Pepe's stream too, as a reload");
  const m = switcher({ pepeOn: false });
  m.sw.setMic(MIC()); assert.equal(m.sw.view(), "mic");
  m.answer(live([F("s1")], { featured: FH("s1") })); await m.poll();
  assert.equal(m.sw.view(), "slot:s1", "a featured stream beats the mic stage (dock3)");
  const c = switcher({ pepeOn: false });
  c.click("pepe");
  c.answer(live([F("s1")], { featured: FH("s1") })); await c.poll();
  assert.equal(c.sw.view(), "pepe", "a viewer who picked a tab keeps it");
  assert.match(c.tabs(), /data-v="slot:s1"/);
});

test("1c: Pepe's stream blips (an OBS reconnect: off air for one poll; his room sync late: pepe_here false) - a viewer on him stays on him (review F3 / M1)", async () => {
  for (const blip of [{ active: false }, { active: true, pepe_here: false }]) {
    const x = switcher({ pepeOn: true, slots: [H("s1")] });
    assert.equal(x.sw.view(), "pepe");
    x.answer(live([H("s1")], blip)); await x.poll();
    x.answer(live([H("s1")], { active: true })); await x.poll();
    assert.equal(x.sw.view(), "pepe", JSON.stringify(blip));
  }
});

test("1d: nothing jumps under a viewer - a second stream never moves them; the one they watch ends: back to the defaults (guard)", async () => {
  const x = switcher({ pepeOn: false });
  x.answer(live([H("s1")])); await x.poll();
  x.click("slot:s1");
  assert.equal(x.sw.view(), "slot:s1");
  x.answer(live([H("s1"), H("s2")], { active: true })); await x.poll();
  assert.equal(x.sw.view(), "slot:s1", "Pepe on air again + a second stream: the stream they picked stays");
  assert.match(x.tabs(), /data-v="slot:s2"/);
  x.answer(live([H("s2")], { active: true })); await x.poll();
  assert.equal(x.sw.view(), "pepe", "it ended: Pepe's stream");
});

test("2a: a hidden tab showing nothing skips its 10 s turn - and asks once when it comes back, not again at the turn right after (review L4)", async () => {
  const x = switcher({ pepeOn: false });
  x.hide(true);
  x.answer(live([F("s1")], { featured: FH("s1") }));
  await x.tick();
  assert.equal(x.stageCalls(), 0, "hidden, the slate: no /api/stage call");
  await x.fire("doc", "visibilitychange");
  assert.equal(x.stageCalls(), 0, "still hidden: nothing");
  x.hide(false);
  await x.fire("doc", "visibilitychange");
  assert.equal(x.stageCalls(), 1, "back in view: one call at once");
  assert.equal(x.sw.view(), "slot:s1", "and the stream that started meanwhile is up");
  await x.tick();
  assert.equal(x.stageCalls(), 1, "the 10 s turn a moment later: skipped (it just asked)");
  x.answer(live([F("s1")], { featured: FH("s1") }));
  x.later(10000); await x.tick();
  assert.equal(x.stageCalls(), 2, "visible: the 10 s turn runs as before");
  // a back/forward-cache restore and the network coming back ask too (not twice within a moment)
  x.answer(live([F("s1")], { featured: FH("s1") })); x.answer(live([F("s1")], { featured: FH("s1") }));
  await x.fire("win", "pageshow", { persisted: false });
  assert.equal(x.stageCalls(), 2, "an ordinary load's pageshow: nothing");
  x.later(2000);
  await x.fire("win", "pageshow", { persisted: true });
  assert.equal(x.stageCalls(), 3);
  await x.fire("win", "online");
  assert.equal(x.stageCalls(), 3, "within 1.5 s of the last call: no second one");
  // an action's own poll (★ Feature, ✂ Cut) counts too: the timer's turn right after it is skipped
  x.later(10000); await x.sw.poll(); await x.tick();
  assert.equal(x.stageCalls(), 4);
  // a clock set back (an hour) never stops the poll
  x.answer(live([F("s1")], { featured: FH("s1") }));
  x.later(-3600000); await x.tick();
  assert.equal(x.stageCalls(), 5);
});

test("2b: a hidden tab whose player RUNS keeps its turn - muted too: the slot ends, the poll stops the player (its m3u8 retries, its watch beats) (review M2)", async () => {
  const x = switcher({ pepeOn: false, slots: [F("s1")], featured: FH("s1") });
  assert.equal(x.sw.view(), "slot:s1");
  assert.equal(x.src[x.src.length - 1], "/hls/s1.m3u8");
  x.media({ running: true, muted: true });
  x.hide(true);
  x.answer(live([]));
  x.later(10000); await x.tick();
  assert.equal(x.stageCalls(), 1, "muted, hidden, playing: the poll runs as before");
  assert.equal(x.sw.view(), "pepe", "the slot ended: the defaults");
  assert.ok(x.stops() >= 1, "the player stopped");
  x.later(10000); await x.tick();
  assert.equal(x.stageCalls(), 1, "now nothing plays: hidden turns skip");
  // unmuted the same; an embed (its player isn't ours) too
  const u = switcher({ pepeOn: true });
  u.media({ running: true, muted: false }); u.hide(true);
  u.answer(live([], { active: true }));
  await u.tick(); assert.equal(u.stageCalls(), 1);
  const e = switcher({ pepeOn: false, slots: [F("v1", { hls: null, embed: { p: "youtube", t: "video", id: "bbbbbbbbbbb" } })], featured: FH("v1") });
  e.hide(true);
  e.answer(live([F("v1", { hls: null, embed: { p: "youtube", t: "video", id: "bbbbbbbbbbb" } })], { featured: FH("v1") }));
  await e.tick(); assert.equal(e.stageCalls(), 1, "an embed");
});

test("2c: the stage in the Dock's picture-in-picture window - the pad tab hidden, that window seen: the turn runs, a new featured stream arrives there (review F1)", async () => {
  const pipDoc = { hidden: false };
  const x = switcher({ pepeOn: false, wrap: Object.assign(mk(), { ownerDocument: pipDoc }) });
  assert.equal(x.sw.view(), "pepe", "the off-air slate - nothing playing");
  x.hide(true);
  x.answer(live([F("s1")], { featured: FH("s1") }));
  await x.tick();
  assert.equal(x.stageCalls(), 1, "the window shows the stage: it keeps up");
  assert.equal(x.sw.view(), "slot:s1");
  // that window minimised too: like a hidden tab
  pipDoc.hidden = true;
  const y = switcher({ pepeOn: false, wrap: Object.assign(mk(), { ownerDocument: pipDoc }) });
  y.hide(true); await y.tick();
  assert.equal(y.stageCalls(), 0);
  // the mic stage is a picture too
  const m = switcher({ pepeOn: false });
  m.sw.setMic(MIC()); assert.equal(m.sw.view(), "mic");
  m.hide(true); m.answer(live([])); await m.tick();
  assert.equal(m.stageCalls(), 1, "the mic stage");
});

test("2d: destroy() drops the tab listeners (the homepage's front-pad swap); a page whose document has no events API still works", async () => {
  const x = switcher({ pepeOn: false });
  assert.deepEqual(x.listeners(), { doc: ["visibilitychange"], win: ["pageshow", "online"] });
  x.sw.destroy();
  assert.deepEqual(x.listeners(), { doc: [], win: [] });
  const bare = switcher({ pepeOn: false }, { bareDocument: true });
  bare.answer(live([F("s1")], { featured: FH("s1") }));
  await bare.tick();
  assert.equal(bare.stageCalls(), 1, "no document.hidden: visible");
  assert.equal(bare.sw.view(), "slot:s1");
});

test("2e: room.ejs and home.ejs load the new stage-room.js (v=24; upnext2: v=25; upnext3: v=26)", () => {
  for (const v of ["room.ejs", "home.ejs"]) assert.match(read("views", v), /stage-room\.js\?v=26/, v);
});

test("1e: \"Watch ›\" (the Feed / About line) is the viewer's OWN pick - the first live stream when the stage shows nothing; never over Pepe's stream, a stream on screen or the mic stage; never a cam", async () => {
  const x = switcher({ pepeOn: false });
  x.answer(live([H("c1", { hls: null, cam: true }), H("s1"), H("s2")])); await x.poll();
  assert.equal(x.sw.view(), "pepe", "nobody's default (F2)");
  assert.equal(x.sw.watchLive(), true);
  assert.equal(x.sw.view(), "slot:s1", "the first live stream - not the cam");
  x.answer(live([H("c1", { hls: null, cam: true }), H("s1"), H("s2")], { featured: null })); await x.poll();
  assert.equal(x.sw.view(), "slot:s1", "a pick: kept like a tab click");
  assert.equal(x.sw.watchLive(), false, "a stream is on screen: nothing changes");
  const p = switcher({ pepeOn: true, slots: [H("s1")] });
  assert.equal(p.sw.watchLive(), false); assert.equal(p.sw.view(), "pepe", "Pepe's stream shows: his");
  const m = switcher({ pepeOn: false, slots: [H("s1")] });
  m.sw.setMic(MIC()); assert.equal(m.sw.watchLive(), false); assert.equal(m.sw.view(), "mic");
  const c = switcher({ pepeOn: false, slots: [H("c1", { hls: null, cam: true })] });
  assert.equal(c.sw.watchLive(), false); assert.equal(c.sw.view(), "pepe", "only a cam: its tab");
});
