"use strict";
// dock3 review fixes 1.99?? - the stage switcher (public/js/stage-room.js) after the item 5 / item 6 reviews. Each test failed on the
// dock3 build before these fixes (they reproduce the reviewers' probes first):
//   C1 / MF1  Pepe's stream featured (on this pad, or the site-wide event) beat the mic stage while his stream was OFF AIR or he wasn't in
//             the pad - the viewer sat on "nothing streaming right now" with people on the mic; now it counts while he is on air and here,
//             through a short drop (PEPE_HOLD_MS) so a blip never hands the view to the mic stage and back
//   C2        the server's featured marker for a slot this page can't show (not listed - a new page load during a drop) kept the mic stage
//             off: Pepe's off-air slate for up to a 📼 pause's 30 min; now only something this page shows (a listed / held slot) counts
//   MF5       polls were not ordered - an older answer landing last undid a newer one (the ★ Feature action's own poll)
//   C6        the old (non-Dock) homepage: the ★ / slot buttons were drawn for whichever pad was on the front page now, with `manage`
//             computed for the first one (a 403 on press); and Pepe's ★ only came after the first poll
//   node --test test/dock3-review-stage.test.js
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
// a switcher whose polls answer from a queue (null = the request failed; a function = a slow answer resolved later) on a clock we move
function switcher(opts) {
  const js = read("public", "js", "stage-room.js");
  const answers = [], timers = [], src = [], calls = [], air = [];
  const clock = { t: 1_800_000_000_000 };
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(clock.t); } static now() { return clock.t; } }
  const ctx = { document: { readyState: "complete", createElement: mk }, console, setInterval: () => 0, clearInterval() {}, Date: FakeDate,
    setTimeout: (fn, ms) => { if (ms >= 40000) { timers.push(fn); return 1000 + timers.length; } return setTimeout(fn, ms); },
    clearTimeout: (h) => { if (h > 1000) timers[h - 1001] = null; else clearTimeout(h); }, location: { hostname: "x" },
    fetch: (url, init) => { calls.push({ url, init });
      if (/\/api\/stage\/(pepe\/feature|slots\/)/.test(url)) return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
      const a = answers.length ? answers.shift() : {};
      if (typeof a === "function") return new Promise((ok) => a((v) => ok({ json: () => Promise.resolve(v) })));
      return a === null ? Promise.reject(new Error("offline")) : Promise.resolve({ json: () => Promise.resolve(a) }); },
    confirm: () => true, alert() {} };
  ctx.window = ctx; ctx.window.addEventListener = () => {};
  ctx.PATVStage = { player: () => ({ stop() {}, setSrc(s) { src.push(s); }, start() {}, running: () => false }) };
  ctx.PATVStageMic = { render: () => ({ update() {}, stop() {}, selection: () => ({ stream: "mic", embed: true, capture: false, nsfw: false }) }) };
  vm.runInNewContext(js, ctx);
  const tabs = mk(); let html = "";
  Object.defineProperty(tabs, "innerHTML", { set(v) { html = v; }, get() { return html; } });
  const sw = ctx.PATVStage.switcher(Object.assign({ tabs, wrap: mk(), api: "/api/stage?room=pad", slots: [], pepeOn: true, pepeHere: true, slug: "pad", watch: false,
    onAir: (on, sub) => air.push([on, sub]) }, opts));
  const click = (v) => { const b = { hasAttribute: (k) => k === "data-v", getAttribute: () => v }; tabs.listeners.click[0]({ target: { closest: () => b } }); };
  const act = (a) => { const b = { hasAttribute: (k) => k === "data-act", getAttribute: (k) => (k === "data-act" ? a : null), disabled: false }; tabs.listeners.click[0]({ target: { closest: () => b } }); };
  return { sw, tabs: () => html, src, air, click, act, calls, answer: (a) => answers.push(a), poll: () => sw.poll(), adv: (ms) => { clock.t += ms; } };
}
const MIC = (extra) => Object.assign({ v: 1, active: true, count: 2, default: "first", layout: "split", src: [{ id: "a" }, { id: "b" }] }, extra || {});
const S1 = (by, extra) => Object.assign({ id: "s1", display: "Willow", featured: true, feature_by: by, hls: "/hls/s1.m3u8", since: 1 }, extra || {});
const live = (slots, featured, extra) => Object.assign({ active: true, pepe_here: true, slots, featured: featured === undefined ? null : featured, now: Date.now() }, extra || {});
const PAD = { mode: "stream", featured: true, pad_featured: true };
const tick = () => new Promise((r) => setTimeout(r, 5));

test("C1 / MF1: Pepe featured on this pad while his stream is OFF AIR - the mic stage is the default (nothing featured can show), and ☆ stays for the manager", () => {
  const x = switcher({ pepeOn: false, pepeSrc: PAD, manage: true });
  x.sw.setMic(MIC());
  assert.equal(x.sw.view(), "mic", "off air: his feature doesn't hold the mic stage off");
  assert.match(x.tabs(), /data-v="pepe"/, "his tab is still there");
  x.click("pepe");                                            // the manager picks his tab: ☆ stops featuring him, off air too
  assert.match(x.tabs(), /data-act="pepe-unfeature"/);
});

test("C1 / MF1: he goes off air while featured - held for a short drop (no flip to the mic stage and back), then mic follows; back on air: his stream again", async () => {
  const x = switcher({ pepeSrc: PAD });
  x.sw.setMic(MIC());
  assert.equal(x.sw.view(), "pepe", "on air: his featured stream beats the mic stage");
  x.answer(live([], null, { active: false, pepe_src: PAD })); await x.poll();
  assert.equal(x.sw.view(), "pepe", "an OBS blip: held");
  x.adv(30000); x.answer(live([], null, { active: false, pepe_src: PAD })); await x.poll();
  x.sw.setMic(MIC({ count: 3, src: [{ id: "a" }, { id: "b" }, { id: "c" }] }));
  assert.equal(x.sw.view(), "pepe", "still inside the hold");
  x.adv(31000); x.answer(live([], null, { active: false, pepe_src: PAD })); await x.poll();
  assert.equal(x.sw.view(), "mic", "a minute off air: mic follows takes the stage");
  x.answer(live([], null, { active: true, pepe_src: PAD })); await x.poll();
  assert.equal(x.sw.view(), "pepe", "back on air: his featured stream is the default again");
});

test("C1 / MF1 (F1c): the site-wide Pepe event on a pad he isn't in - no Pepe tab, so the mic stage, not 'nothing streaming'", () => {
  const x = switcher({ pepeHere: false, pepeSrc: { mode: "stream", featured: true, pad_featured: false } });
  x.sw.setMic(MIC());
  assert.equal(x.sw.view(), "mic");
  const y = switcher({ pepeOn: false, pepeSrc: { mode: "stream", featured: true, pad_featured: false } });
  y.sw.setMic(MIC());
  assert.equal(y.sw.view(), "mic", "the event, off air (first load): the mic stage");
});

test("C2: the server's featured marker for a slot this page doesn't list (a page loaded during a drop) never beats the mic stage - on or off air", async () => {
  for (const pepeOn of [false, true]) {
    const x = switcher({ pepeOn, featured: { id: "s9", live: false, by: "auto", went: true } });
    x.sw.setMic(MIC());
    assert.equal(x.sw.view(), "mic", "pepeOn " + pepeOn + ": the mic stage, not " + (pepeOn ? "Pepe's stream" : "the off-air slate"));
    // the featured slot comes back: a viewer who never picked a tab goes to it
    x.answer(live([S1("auto", { id: "s9" })], { id: "s9", live: true, by: "auto", went: true })); await x.poll();
    assert.equal(x.sw.view(), "slot:s9");
  }
  // a viewer who HAD it listed is still held through the drop (dock3 race 2)
  const h = switcher({ slots: [S1("auto")] });
  h.sw.setMic(MIC());
  h.answer(live([], { id: "s1", live: false, by: "auto", went: true })); await h.poll();
  assert.equal(h.sw.view(), "slot:s1");
});

test("MF5: an older poll answer that lands after a newer one is dropped - the ★ Feature action's own poll isn't undone", async () => {
  const x = switcher({ manage: true, slots: [S1(null, { featured: false })] });
  x.sw.setMic(MIC());
  assert.equal(x.sw.view(), "mic");
  let late = null;
  x.answer((r) => { late = r; });                            // the 10 s poll, slow
  const p1 = x.poll();
  x.answer(live([S1("owner")], { id: "s1", live: true, by: "owner", went: true }));
  await x.poll();
  assert.equal(x.sw.view(), "slot:s1");
  late(live([S1(null, { featured: false })], null));       // from before the feature
  await p1; await tick();
  assert.equal(x.sw.view(), "slot:s1", "the out-of-date answer moved nothing");
  assert.match(x.tabs(), /class="stab feat"/, "and the tab still carries the ★");
  // a failed newer poll doesn't block an older good one that lands later
  const y = switcher({ slots: [] });
  let slow = null;
  y.answer((r) => { slow = r; }); const q1 = y.poll();
  y.answer(null); await y.poll();
  slow(live([S1("auto")], { id: "s1", live: true, by: "auto", went: true })); await q1; await tick();
  assert.equal(y.sw.view(), "slot:s1");
});

test("C6: the old homepage - ★ on Pepe's stage from the first render (the front pad's slug), and no buttons once the front page shows another pad", async () => {
  const adm = (x) => (/<span class="adm">(.*?)<\/span>/.exec(x.tabs()) || [])[1] || "";
  const x = switcher({ manage: true, slug: "", front: "pad-a", api: "/api/stage", slots: [] });
  assert.match(adm(x), /data-act="pepe-feature"/, "before the first poll");
  x.act("pepe-feature"); await tick();
  assert.deepEqual(JSON.parse(x.calls.find((c) => c.url === "/api/stage/pepe/feature").init.body), { room: "pad-a", on: true });
  x.answer(live([S1("auto")], { id: "s1", live: true, by: "auto", went: true }, { front: { id: "B", slug: "pad-b", title: "B" } })); await x.poll();
  assert.equal(adm(x), "", "pad B's slot: the buttons were computed for pad A");
  x.answer(live([], null, { front: { id: "B", slug: "pad-b", title: "B" } })); await x.poll();
  assert.equal(adm(x), "", "nor Pepe's ★ on pad B");
  x.answer(live([], null, { front: { id: "A", slug: "pad-a", title: "A" } })); await x.poll();
  assert.match(adm(x), /data-act="pepe-feature"/, "pad A is back: its manager's ★ is back");
  // the pad page and the Dock (slug given) are unchanged
  const p = switcher({ manage: true });
  assert.match(adm(p), /data-act="pepe-feature"/);
  p.answer(live([], null, { front: { id: "B", slug: "pad-b" } })); await p.poll();
  assert.match(adm(p), /data-act="pepe-feature"/, "a pad page's switcher never follows a front");
});

test("C6: home.ejs passes the first front pad to the old homepage switcher", () => {
  const home = read("views", "home.ejs");
  assert.match(home, /api: '\/api\/stage', front: frontSlug, slots: initSlots/);
});

// ── item 4 on phones (review-mobile M1-M3) + the mic bars under reduced motion (C5): pad-dock.css. Browser evidence:
//    scratchpad dock3/fix/shots (fix-m1-*, m2after-*, m3after-*) - Pixel 7 / iPhone 14 (Chrome engine + WebKit) / iPhone SE / 360x640 ──
test("M1: a phone on its side - the stage is the screen's height UNDER the navbar (its bar row was below the fold: no control on screen)", () => {
  const css = read("public", "css", "pad-dock.css");
  const blk = (/@media \(orientation: landscape\) and \(max-height: 500px\) and \(pointer: coarse\) \{([\s\S]*?)\n\}/.exec(css) || [])[1] || "";
  assert.match(blk, /body\.pad-dock-live main\.rm\.rm-dock #rmStage \{ block-size: calc\(100dvh - var\(--ds-nav-h\) - var\(--ds-sp-2\) - var\(--ds-sp-2\) - 4px\);/);
  assert.doesNotMatch(blk, /#rmStage \{ block-size: calc\(100dvh - var\(--ds-sp-2\) - var\(--ds-sp-2\)\);/, "not a full 100dvh under a 61-65px navbar");
});
test("M2: the chat inside a fullscreen stage has no log floor (it needed ~306px whatever box it got) and is a side column on a phone on its side", () => {
  const css = read("public", "css", "pad-dock.css");
  assert.match(css, /main\.rm\.rm-dock :is\(#rmStage\.rmd-full, \.rmd-fullscreen\) > \.rmd-overlay \.rmd-log \{ min-block-size: 0; \}/);
  assert.match(css, /@media \(orientation: landscape\) and \(max-width: 760px\) \{\n  main\.rm\.rm-dock #rmStage\.rmd-full:not\(\.rmd-embed\) > \.rmd-overlay \{ inset-block-start: calc\(var\(--ds-sp-2\) \+ 44px\); inset-inline: auto var\(--ds-sp-2\); inline-size: min\(360px, 50%\); \}/);
});
test("M3: with 💬 Show chat on in fullscreen, ⏯ is back in the bar row (the 56px centre button sat on the chat's header)", () => {
  const css = read("public", "css", "pad-dock.css");
  assert.match(css, /main\.rm\.rm-dock #rmStage\.rmd-full\.rmd-chat-on \.rmd-ov-bot \.rmd-media-play \{ position: static; inset: auto; margin-inline: 0; inline-size: 44px;/);
});
test("C5: under reduced motion the 'on the mic' bars keep the still shape over a real level too (meterLoop's inline heights)", () => {
  const css = read("public", "css", "pad-dock.css");
  const rm = css.split("@media (prefers-reduced-motion: reduce) {").slice(1).join("\n");
  assert.match(rm, /main\.rm\.rm-dock \.rmd-now\.rmd-talk > \.rb-meter > i:nth-child\(3\) \{ height: 14px !important; \}/);
  assert.match(rm, /main\.rm\.rm-dock \.rmd-now\.rmd-talk > \.rb-meter > i \{ transition: none; animation: none; transform: none; \}/);
});
test("M1 (the homepage): a phone on its side - home-dock.css clamps the stage to the screen's height AFTER its phone-width `max-block-size: none` (pad-dock.css's clamp lost to it: a 404px stage in a 340px screen)", () => {
  const css = read("public", "css", "home-dock.css");
  const none = css.indexOf("main.rm.rm-dock.rmd-home #rmStage { max-block-size: none; }");
  const clamp = css.indexOf("@media (orientation: landscape) and (max-height: 500px) and (pointer: coarse) {\n  main.rm.rm-dock.rmd-home #rmStage { max-block-size: calc(100svh - var(--ds-sp-2) - var(--ds-sp-2)); }");
  assert.ok(none > 0 && clamp > none, "the clamp comes after (same specificity: the later one wins)");
  assert.match(read("views", "home.ejs"), /home-dock\.css\?v=5"/);
});
