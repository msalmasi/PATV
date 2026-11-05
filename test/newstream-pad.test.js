"use strict";
// newstream 1.99akv (owner 2026-11-05: "When a new stream is created, the website isnt aware of it so you need to refresh to see it. Thats
// annoying."): the pad page's pieces that were drawn once, at load, follow the stage's own 10 s poll now:
//   1. the Live / Stage tab's red dot (it was PT_.active at render - a viewer on Feed / About, where a site pad always opens, never saw a
//      stream start) + a "Live on the stage now · Watch ›" line under the tabs for a stage that went on air while the page watched
//   2. the 📼 player (pad-plexq.js) and the Go live card (room-schedule.js) poll every 30 s on their own - they ask at once when the stage's
//      poll sees the set of live slots change
// Each test failed on 1.99akr (eaaf29c9).
//   node --test test/newstream-pad.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");
const renderRoom = (extra) => ejs.renderFile(path.join(repo, "views", "room.ejs"), {
  user: "u", signedIn: true, linked: true, room: { name: "Lounge", slug: "lounge", count: 0, live: false, topic: "", platform: "site", siteOnly: true, bridged: false },
  initial: { room: {}, members: [], mic: [], feed: [], cursor: 0 }, onStage: false, stage: {}, latest: [],
  padTabs: { tabs: ["live", "feed", "about"], initial: "feed", active: false, roomActive: false, stageOn: false, camfrog: false, posts: [] }, ...extra });

function el(id, extra) {
  const ls = {};
  return Object.assign({ id, hidden: false, attrs: {}, className: "", classList: { toggle() {}, add() {}, remove() {} }, textContent: "",
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, setAttribute(k, v) { this.attrs[k] = String(v); },
    addEventListener(k, f) { (ls[k] = ls[k] || []).push(f); }, dispatchEvent() {}, fire(k, e) { (ls[k] || []).forEach((f) => f(e || {})); } }, extra || {});
}
/** the page's stage script (room.ejs) run against stub nodes: -> {o: the switcher's options, dot, note, x, liveTab, docFire, polls} */
async function stageScript(extra) {
  const html = await renderRoom(extra);
  const at = html.indexOf("window.PATVPadStage = PATVStage.switcher(");
  assert.ok(at > 0, "the pad stage's script");
  const js = html.slice(html.lastIndexOf("<script>", at) + 8, html.indexOf("</script>", at));
  const nodes = {}, docL = {};
  for (const id of ["rmStage", "rmStPill", "rmStPillTxt", "rmCap", "rmTabs", "rmVideo", "rmStReconnect", "rmStUnmute", "rmEmbed"]) nodes[id] = el(id);
  if (html.includes('id="padLiveNote" hidden')) { nodes.padLiveNote = el("padLiveNote", { hidden: true }); nodes.padLiveNoteX = el("padLiveNoteX"); }
  nodes["padTab-live"] = el("padTab-live"); nodes["padTab-live"].attrs["aria-selected"] = String((extra && extra.padTabs ? extra.padTabs.initial : "feed") === "live");
  const dotHidden = /id="padTab-live"[^>]*>\s*<span class="pdot" aria-hidden="true" hidden>/.test(html);
  const dot = el("dot", { hidden: dotHidden });
  const polls = { plexq: 0, sched: 0 };
  let o = null;
  const ctx = { console, JSON, CustomEvent: function (t, d) { this.type = t; this.detail = d && d.detail; },
    document: { getElementById: (id) => nodes[id] || null, querySelector: (s) => (s === '#padTabs .ptab[data-tab="live"] .pdot' ? dot : null),
      addEventListener: (k, f) => { (docL[k] = docL[k] || []).push(f); } },
    PATVStage: { capture: () => ({ update() {} }), switcher: (opts) => { o = opts; return { poll() {}, setMic() {} }; } },
    PATVPlexQ: { poll: () => { polls.plexq++; } }, PATVRoomSchedule: { poll: () => { polls.sched++; } } };
  ctx.window = ctx;
  vm.runInNewContext(js, ctx);
  return { o, dot, note: nodes.padLiveNote || null, x: nodes.padLiveNoteX || null, liveTab: nodes["padTab-live"], polls, html,
           docFire: (k, e) => (docL[k] || []).forEach((f) => f(e || {})) };
}

const NONE = { slots: [], active: false, pepe_here: true, featured: null };
const ONE = { slots: [{ id: "s1" }], active: false, pepe_here: true, featured: { id: "s1", live: true, by: "auto", went: true } };
test("1a: a stream that starts while the viewer is on Feed lights the Live tab's dot and says so under the tabs (they never changed after load)", async () => {
  const p = await stageScript();
  assert.equal(p.dot.hidden, true, "nothing on at load: no dot");
  assert.equal(p.note.hidden, true);
  p.o.onAir(false); p.o.onPoll(NONE);   // (the first paint at load, the first poll: off air)
  assert.equal(p.dot.hidden, true);
  p.o.onPoll(ONE); p.o.onAir(true);     // the stage's poll: a stream is live
  assert.equal(p.dot.hidden, false, "the Live tab's dot");
  assert.equal(p.note.hidden, false, "Live on the stage now · Watch ›");
  assert.match(p.html, /<p class="plive" id="padLiveNote" hidden><a href="\?tab=live" data-pad-tab="live"><span class="pdot" aria-hidden="true"><\/span><span>Live on the stage now · <b>Watch ›<\/b><\/span><\/a><button type="button" id="padLiveNoteX" aria-label="Hide" title="Hide">✕<\/button><\/p>/,
    "a link pad-tabs.js already switches tabs for (data-pad-tab), and a ✕");
  p.o.onPoll({ slots: [], active: false, pepe_here: true, featured: { id: "s1", live: false, by: "auto", went: true } });
  assert.equal(p.note.hidden, false, "a held featured stream (a 📼 pause, an OBS reconnect) is still on - the line never flaps");
  p.o.onPoll(NONE); p.o.onAir(false);   // it ended
  assert.equal(p.dot.hidden, true, "off air (and the room isn't active): no dot");
  assert.equal(p.note.hidden, true, "nor the line");
  p.o.onPoll({ slots: [], active: true, pepe_here: true, featured: null });
  assert.equal(p.note.hidden, false, "Pepe's stream coming on air here counts");
  p.o.onPoll({ slots: [], active: true, pepe_here: false, featured: null });
  assert.equal(p.note.hidden, true, "...not while he is in another pad");
});

test("1b: the line - never for a stream already on at load, never for the 🎙 mic stage alone, never on Live, gone when Live opens or with ✕", async () => {
  const atLoad = await stageScript({ roomStage: { slots: [{ id: "s1", display: "A", hls: "/a.m3u8" }], upcoming: [], queue: {} },
    padTabs: { tabs: ["live", "feed", "about"], initial: "feed", active: true, roomActive: false, stageOn: true, camfrog: false, posts: [] } });
  atLoad.o.onAir(true); atLoad.o.onPoll(ONE);
  assert.equal(atLoad.dot.hidden, false);
  assert.equal(atLoad.note.hidden, true, "on air at load: the dot says it, as before");
  const mic = await stageScript();
  mic.o.onPoll(NONE); mic.o.onAir(true);   // the mic stage is the view (someone on the mic with a cam): ON AIR, no stream
  assert.equal(mic.dot.hidden, false, "the dot: the stage shows something");
  assert.equal(mic.note.hidden, true, "no line for a mic-up");
  const p = await stageScript();
  p.o.onPoll(NONE); p.o.onPoll(ONE);
  assert.equal(p.note.hidden, false);
  p.docFire("patv:padtab", { detail: { tab: "live" } });
  assert.equal(p.note.hidden, true, "the viewer opened Live");
  p.liveTab.attrs["aria-selected"] = "true";
  p.o.onPoll(NONE); p.o.onPoll(ONE);
  assert.equal(p.note.hidden, true, "on Live: no line (the stage is right there)");
  p.liveTab.attrs["aria-selected"] = "false";
  p.o.onPoll(NONE); p.o.onPoll(ONE);
  assert.equal(p.note.hidden, false, "back on Feed, the next stream says so again");
  p.x.fire("click");
  assert.equal(p.note.hidden, true, "✕");
  p.o.onPoll(NONE); p.o.onPoll(ONE);
  assert.equal(p.note.hidden, true, "✕ holds for this visit");
  assert.equal(p.dot.hidden, false, "the dot still follows the stage");
});

test("1c: a Camfrog room that was active at load keeps its dot when the stage goes off air (bridge.js padTabsFor roomActive)", async () => {
  const p = await stageScript({ padTabs: { tabs: ["live", "feed", "about"], initial: "feed", active: true, roomActive: true, stageOn: false, camfrog: true, posts: [] } });
  p.o.onAir(true); p.o.onAir(false);
  assert.equal(p.dot.hidden, false, "people in the room: the dot stays");
  const B = require("../bridge");
  const t = B.padTabsFor({ platform: "camfrog", live: true, count: 3, pepeHere: true, pepeOn: false, slots: [], feed: true });
  assert.equal(t.roomActive, true); assert.equal(t.stageOn, false); assert.equal(t.active, true);
  const s = B.padTabsFor({ platform: "site", live: false, count: 0, pepeOn: false, slots: [{ id: "a" }], feed: true });
  assert.equal(s.roomActive, false, "a site pad has no room"); assert.equal(s.stageOn, true); assert.equal(s.active, true);
});

test("2: the 📼 player and the Go live card ask at once when the stage's poll sees the live slots change - not on every poll", async () => {
  const p = await stageScript({ roomStage: { slots: [{ id: "a", display: "A", hls: "/a.m3u8" }], upcoming: [], queue: {} } });
  assert.equal(typeof p.o.onPoll, "function");
  p.o.onPoll({ slots: [{ id: "a" }] });
  assert.deepEqual(p.polls, { plexq: 0, sched: 0 }, "the same slots as at load: nothing");
  p.o.onPoll({ slots: [{ id: "a" }, { id: "b" }] });
  assert.deepEqual(p.polls, { plexq: 1, sched: 1 }, "a stream went live");
  p.o.onPoll({ slots: [{ id: "b" }, { id: "a" }] });
  assert.deepEqual(p.polls, { plexq: 1, sched: 1 }, "the same set in another order: nothing");
  p.o.onPoll({ slots: [{ id: "b" }] });
  assert.deepEqual(p.polls, { plexq: 2, sched: 2 }, "one ended");
  p.o.onPoll({ stale: true }); p.o.onPoll(null);
  assert.deepEqual(p.polls, { plexq: 2, sched: 2 }, "an answer without a slot list moves nothing");
  p.o.onPoll({ slots: [] });
  assert.deepEqual(p.polls, { plexq: 3, sched: 3 }, "the last one ended (a 📼 play stopped)");
  // the scripts hand their poll out; their cache-busters moved
  assert.match(read("public", "js", "pad-plexq.js"), /window\.PATVPlexQ = \{ poll: function \(\) \{ if \(Date\.now\(\) - askedAt >= 1500\) poll\(\); \} \};/, "(never twice in a moment)");
  assert.match(read("public", "js", "room-schedule.js"), /window\.PATVRoomSchedule = \{ poll: function \(\) \{ if \(Date\.now\(\) - askedAt >= 1500\) poll\(\); \} \};/);
  assert.match(read("views", "room.ejs"), /pad-plexq\.js\?v=5/);
  assert.match(read("views", "partials", "room-schedule.ejs"), /room-schedule\.js\?v=6/);
});
