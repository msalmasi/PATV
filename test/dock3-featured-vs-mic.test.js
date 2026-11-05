"use strict";
// dock3 (owner 2026-11-05 item 6: "mic follows seems to sometimes interrupt another featured stage") 1.99akf: a featured stage - featured
// automatically, by hand or booked, or Pepe's stream featured - always beats the 🎙 mic stage as the default view (stage-room.js featWins),
// and the races that handed the view to the mic stage are closed:
//   1. an auto-featured stream yielded to the mic stage (the prod case: every featured stage on 11-03..05 was 'auto')
//   2. a featured stream that drops out of /api/stage for a moment (📼 pause / seek, an OBS reconnect, a missed heartbeat) handed the view to
//      the mic stage - and a viewer who had clicked its tab (the owner always has) stayed stuck there; now the slot is HELD while the server
//      still names it featured (/api/stage `featured`), and a server error answers `stale` instead of "nothing is live"
//   3. the 🎙 tab grabbed a viewer back off a featured stage at the next mic-up
// Each test below failed on 1.99ajy (they reproduce the races first).
//   node --test test/dock3-featured-vs-mic.test.js
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
// a switcher whose polls answer from a queue (an answer of `null` = the request failed)
function switcher(opts) {
  const js = read("public", "js", "stage-room.js");
  const answers = [], timers = [], src = [], calls = [];
  const ctx = { document: { readyState: "complete", createElement: mk }, console, setInterval: () => 0, clearInterval() {},
    setTimeout: (fn, ms) => { if (ms >= 40000) { timers.push(fn); return 1000 + timers.length; } return setTimeout(fn, ms); },
    clearTimeout: (h) => { if (h > 1000) timers[h - 1001] = null; else clearTimeout(h); }, location: { hostname: "x" },
    fetch: (url, init) => { calls.push({ url, init });
      if (/\/api\/stage\/pepe\/feature$/.test(url)) return Promise.resolve({ json: () => Promise.resolve({ ok: true }) });
      const a = answers.length ? answers.shift() : {}; return a === null ? Promise.reject(new Error("offline")) : Promise.resolve({ json: () => Promise.resolve(a) }); },
    confirm: () => true, alert() {} };
  ctx.window = ctx; ctx.window.addEventListener = () => {};
  ctx.PATVStage = { player: () => ({ stop() {}, setSrc(s) { src.push(s); }, start() {}, running: () => false }) };
  ctx.PATVStageMic = { render: () => ({ update() {}, stop() {}, selection: () => ({ stream: "mic", embed: true, capture: false, nsfw: false }) }) };
  vm.runInNewContext(js, ctx);
  const tabs = mk(); let html = "";
  Object.defineProperty(tabs, "innerHTML", { set(v) { html = v; }, get() { return html; } });
  const sw = ctx.PATVStage.switcher(Object.assign({ tabs, wrap: mk(), api: "/api/stage?room=pad", slots: [], pepeOn: true, pepeHere: true, slug: "pad", watch: false }, opts));
  const click = (v) => { const b = { hasAttribute: (k) => k === "data-v", getAttribute: () => v }; tabs.listeners.click[0]({ target: { closest: () => b } }); };
  const act = (a) => { const b = { hasAttribute: (k) => k === "data-act", getAttribute: (k) => (k === "data-act" ? a : null), disabled: false }; tabs.listeners.click[0]({ target: { closest: () => b } }); };
  return { sw, tabs: () => html, src, click, act, calls, answer: (a) => answers.push(a), poll: () => sw.poll(), grace: () => { const f = timers.splice(0); for (const x of f) if (x) x(); } };
}
const MIC = (extra) => Object.assign({ v: 1, active: true, count: 2, default: "first", layout: "split", src: [{ id: "a" }, { id: "b" }] }, extra || {});
const S1 = (by, extra) => Object.assign({ id: "s1", display: "Willow", featured: true, feature_by: by, hls: "/hls/s1.m3u8", since: 1 }, extra || {});
const live = (slots, featured, extra) => Object.assign({ active: true, pepe_here: true, slots, featured: featured === undefined ? null : featured, now: Date.now() }, extra || {});

test("race 1 (the prod case): an AUTO-featured stream beats the mic stage - and so does a hand / booked feature, and Pepe's stream featured", () => {
  for (const by of ["auto", "owner", "booked"]) {
    const x = switcher({ slots: [S1(by)] });
    x.sw.setMic(MIC());
    assert.equal(x.sw.view(), "slot:s1", by + ": featured means featured");
    assert.match(x.tabs(), /data-v="mic"/, "the 🎙 tab is still there to pick");
  }
  const p = switcher({ pepeSrc: { mode: "stream", featured: true } });
  p.sw.setMic(MIC()); assert.equal(p.sw.view(), "pepe");
  // a stored after_streams behaves the same as first now
  const a = switcher({ slots: [S1("auto")] }); a.sw.setMic(MIC({ default: "after_streams" })); assert.equal(a.sw.view(), "slot:s1");
  // nothing featured: the mic stage first, as before
  const n = switcher({ slots: [S1("auto", { featured: false, feature_by: null })] }); n.sw.setMic(MIC()); assert.equal(n.sw.view(), "mic");
});

test("race 1b: a mic stage that is up when a stream gets featured gives the view to it at the next poll (a viewer who never picked a tab)", async () => {
  const x = switcher({});
  x.sw.setMic(MIC()); assert.equal(x.sw.view(), "mic");
  x.answer(live([S1("auto")], { id: "s1", live: true, by: "auto", went: true })); await x.poll();
  assert.equal(x.sw.view(), "slot:s1");
  x.sw.setMic(MIC({ count: 3, src: [{ id: "a" }, { id: "b" }, { id: "c" }] }));
  assert.equal(x.sw.view(), "slot:s1", "the next mic-up doesn't take it back");
});

test("race 2: a featured stream that drops out of /api/stage while the server still names it featured is HELD - the view, the tab, the player", async () => {
  const x = switcher({ slots: [S1("auto")] });
  x.sw.setMic(MIC()); assert.equal(x.sw.view(), "slot:s1");
  x.answer(live([], { id: "s1", live: false, by: "auto", went: true })); await x.poll();
  assert.equal(x.sw.view(), "slot:s1", "held through the gap (📼 pause / seek, an OBS reconnect)");
  assert.match(x.tabs(), /data-v="slot:s1"/, "its tab stays");
  assert.equal(x.src[x.src.length - 1], "/hls/s1.m3u8", "the same source - the player keeps reconnecting");
  x.sw.setMic(MIC({ count: 1, src: [{ id: "a" }] }));
  assert.equal(x.sw.view(), "slot:s1", "a mic-up during the gap doesn't take it");
  x.answer(live([S1("auto")], { id: "s1", live: true, by: "auto", went: true })); await x.poll();
  assert.equal(x.sw.view(), "slot:s1", "and it's back");
  // the server stops naming it (it ended / was unfeatured): the mic stage may come back
  x.answer(live([], null)); await x.poll();
  assert.equal(x.sw.view(), "mic", "mic follows resumes once featuring ends");
});

test("race 2b: the viewer who CLICKED the featured stream's tab (the owner always has) is held too - and never left stuck on the mic stage", async () => {
  const x = switcher({ slots: [S1("owner")] });
  x.click("slot:s1");
  x.sw.setMic(MIC());
  x.answer(live([], { id: "s1", live: false, by: "owner", went: true })); await x.poll();
  assert.equal(x.sw.view(), "slot:s1", "held");
  x.answer(live([S1("owner")], { id: "s1", live: true, by: "owner", went: true })); await x.poll();
  assert.equal(x.sw.view(), "slot:s1");
  // it really ends: the viewer's pick is over - the default again, and a NEW featured stream is taken up (chosen reset)
  x.answer(live([], null)); await x.poll();
  assert.equal(x.sw.view(), "mic", "their stage ended: the default (the mic stage)");
  x.answer(live([S1("auto", { id: "s2" })], { id: "s2", live: true, by: "auto", went: true })); await x.poll();
  assert.equal(x.sw.view(), "slot:s2", "a new featured stream is the default again - the old pick no longer pins the viewer");
});

test("race 2c: a failed poll, a stale server answer (`stale`) or ok:false never moves the view or drops the slots", async () => {
  const x = switcher({ slots: [S1("auto")] });
  x.sw.setMic(MIC());
  x.answer(null); await x.poll(); assert.equal(x.sw.view(), "slot:s1", "offline");
  x.answer(live([], null, { stale: true })); await x.poll(); assert.equal(x.sw.view(), "slot:s1", "stale: the server had an error");
  assert.match(x.tabs(), /data-v="slot:s1"/);
  x.answer({ ok: false, error: "x" }); await x.poll(); assert.equal(x.sw.view(), "slot:s1", "ok: false");
});

// (dock3 review 1.99akf C2: the marker alone - a page loaded during the featured slot's drop - no longer keeps the mic stage off: it showed
// Pepe's stream, or his off-air slate, for up to a 📼 pause; test/dock3-review-stage.test.js)
test("the server's featured marker with nothing to show (not listed for this page) leaves the mic stage the default", () => {
  const x = switcher({ featured: { id: "s9", live: false, by: "owner", went: true } });
  x.sw.setMic(MIC());
  assert.equal(x.sw.view(), "mic");
  // a featured slot that never went live yet (booked, opened, not publishing) doesn't hold the mic stage off
  const y = switcher({ featured: { id: "s9", live: false, by: "booked", went: false } });
  y.sw.setMic(MIC());
  assert.equal(y.sw.view(), "mic");
});

test("race 3: the 🎙 tab never grabs a viewer back off a featured stage; with nothing featured it still does (mfix)", async () => {
  const x = switcher({ slots: [] });
  x.sw.setMic(MIC({ default: "tab" }));
  x.click("mic"); assert.equal(x.sw.view(), "mic");
  x.sw.setMic(MIC({ default: "tab", count: 0, src: [], active: false }));
  x.answer(live([S1("auto")], { id: "s1", live: true, by: "auto", went: true })); await x.poll();
  x.grace();
  assert.equal(x.sw.view(), "slot:s1", "after the grace: the featured stream");
  x.sw.setMic(MIC({ default: "tab" }));
  assert.equal(x.sw.view(), "slot:s1", "the mic coming back doesn't pull them off it");
  x.answer(live([], null)); await x.poll();
  x.sw.setMic(MIC({ default: "tab", count: 0, src: [], active: false })); x.sw.setMic(MIC({ default: "tab" }));
  assert.equal(x.sw.view(), "mic", "nothing featured: their 🎙 pick comes back by itself (mfix)");
});

test("server: /api/stage carries `featured` (live or not, the homepage / cam rule) and answers `stale` on an error; the pages pass the first value in", () => {
  const br = read("bridge.js"), ms = read("mainstage.js"), room = read("views", "room.ejs"), home = read("views", "home.ejs"), hj = read("home.js");
  assert.match(ms, /async function featuredOf\(roomId, viewer, \{ front = false \} = \{\}\)/);
  // (dock3 review 1.99akf: `home` - the front stage, or a Dock's own pad asked with home=1 - test/dock3-review-server.test.js)
  assert.match(br, /featured = await MS\.featuredOf\(R\.id, req\.user \|\| null, \{ front: home \}\)/);
  assert.match(br, /\} catch \(e\) \{ slots = \[\]; stale = true; \}/);
  assert.match(br, /res\.json\(\{ \.\.\.stage\(roomId\), slots, front, featured, pepe_here: here !== false, now: t, \.\.\.\(next !== undefined \? \{ next \} : \{\}\), \.\.\.\(stale \? \{ stale: true \} : \{\}\) \}\)/);
  assert.match(room, /featured: <%- JSON\.stringify\(RS\.featured \|\| null\)/);
  assert.match(hj, /stageFeatured = await require\("\.\/mainstage"\)\.featuredOf\(front\.id, viewer, \{ front: true \}\)/);
  assert.equal((home.match(/featured: locals\.stageFeatured \|\| null|featured: <%- JSON\.stringify\(locals\.stageFeatured \|\| null\)/g) || []).length, 2, "the Dock's init and the old switcher");
});

// ── dock3 item 5 (owner: "I actually see where the feature button is now. We just need to add it to Pepe's stage"): the SAME ★ Feature ──
test("item 5: ★ Feature on Pepe's stage - the slot buttons' markup for the pad's managers; ☆ Unfeature while THIS pad features him; none for the site-wide event, off air, or viewers", () => {
  const adm = (x) => (/<span class="adm">(.*?)<\/span>/.exec(x.tabs()) || [])[1] || "";
  let x = switcher({ manage: true });
  assert.match(adm(x), /^<button type="button" data-act="pepe-feature">★ Feature<\/button>$/, "Pepe alone: his tab and the button (the Dock's source chip lists it)");
  assert.match(x.tabs(), /data-v="pepe"/, "his tab is drawn so the Dock shows the chip");
  x = switcher({ manage: true, pepeSrc: { mode: "stream", featured: true, pad_featured: true } });
  assert.match(adm(x), /data-act="pepe-unfeature">☆ Unfeature</);
  assert.match(x.tabs(), /data-v="pepe"[^>]*><span class="dot" aria-hidden="true"><\/span><span class="star"/, "his tab carries the ★");
  x = switcher({ manage: true, pepeSrc: { mode: "stream", featured: true, pad_featured: false } });
  assert.equal(adm(x), "", "only the site-wide event: /stage/admin's, no button here");
  x = switcher({ manage: true, pepeOn: false });
  assert.equal(adm(x), "", "off air: nothing to feature");
  x = switcher({ manage: true, pepeOn: false, pepeSrc: { mode: "stream", featured: true, pad_featured: true } });
  assert.match(adm(x), /pepe-unfeature/, "off air but featured here: ☆ Unfeature stays");
  x = switcher({ manage: false });
  assert.equal(adm(x), "", "a viewer: no button");
  x = switcher({ manage: true, pepeHere: false });
  assert.equal(adm(x), "", "Pepe isn't in this pad: no button");
  // a slot selected: the slot's own buttons, never Pepe's
  x = switcher({ manage: true, slots: [S1("owner")] });
  assert.match(adm(x), /data-act="unfeature" data-id="s1"/); assert.doesNotMatch(x.tabs(), /pepe-feature/);
  x.click("pepe"); assert.match(adm(x), /data-act="pepe-feature"/, "his tab picked: his button");
});

test("item 5: ★ Feature posts {room, on} to /api/stage/pepe/feature, then polls; a viewer who never picked a tab goes to his stream (and back to the mic stage on ☆)", async () => {
  const x = switcher({ manage: true });
  x.sw.setMic(MIC());
  assert.equal(x.sw.view(), "mic");
  x.click("pepe");                                        // the manager picks his tab (the button is on it)
  x.act("pepe-feature");
  await new Promise((r) => setTimeout(r, 5));
  const post = x.calls.find((c) => c.url === "/api/stage/pepe/feature");
  assert.ok(post, "posted"); assert.equal(post.init.method, "POST"); assert.deepEqual(JSON.parse(post.init.body), { room: "pad", on: true });
  // a viewer (never chose) on the same pad: the poll brings the pad feature - mic -> pepe
  const v = switcher({});
  v.sw.setMic(MIC()); assert.equal(v.sw.view(), "mic");
  v.answer(live([], null, { pepe_src: { mode: "stream", featured: true, pad_featured: true } })); await v.poll();
  assert.equal(v.sw.view(), "pepe", "Pepe featured on this pad: his stream is the default");
  v.sw.setMic(MIC({ count: 3, src: [{ id: "a" }, { id: "b" }, { id: "c" }] })); assert.equal(v.sw.view(), "pepe", "the next mic-up doesn't take it");
  v.answer(live([], null, { pepe_src: { mode: "stream", featured: false, pad_featured: false } })); await v.poll();
  assert.equal(v.sw.view(), "mic", "☆ Unfeature: mic follows again");
  // the old homepage switcher (no room in its api): the front pad's slug from the poll
  const h = switcher({ manage: true, slug: "", api: "/api/stage" });
  h.answer(live([], null, { front: { id: "R", slug: "front-pad", title: "Front" } })); await h.poll();
  h.act("pepe-feature"); await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(JSON.parse(h.calls.find((c) => c.url === "/api/stage/pepe/feature").init.body), { room: "front-pad", on: true });
});
