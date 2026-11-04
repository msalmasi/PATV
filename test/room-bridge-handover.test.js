"use strict";
// 1.99?? dockpop: public/js/room-bridge.js PATVRoom.audio's hand-over hooks - the pad tab, the pad's chat in its own window and the homepage
// pass the room audio between them. pause() stops it but keeps "resume listening" (patvRoomAudio stays 1); resume() plays this player's
// own pad when it is idle and the relay is on; isPlaying() asks; start() now tells the onChange listeners too (the Dock broadcasts
// audio-on; Top Pads' 🎧 row lights when the Dock's player starts) - listen() no longer tells them twice.
//   node --test test/room-bridge-handover.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
function fakeEl(tag) {
  const cls = new Set(), listeners = {};
  const e = {
    tagName: tag, children: [], attrs: {}, style: {}, disabled: false, title: "", textContent: "",
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c), toggle: (c, on) => { const v = on === undefined ? !cls.has(c) : !!on; if (v) cls.add(c); else cls.delete(c); return v; } },
    get className() { return [...cls].join(" "); }, set className(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => cls.add(c)); },
    setAttribute(k, v) { e.attrs[k] = String(v); }, getAttribute(k) { return e.attrs[k]; }, removeAttribute(k) { delete e.attrs[k]; },
    appendChild(c) { e.children.push(c); return c; }, addEventListener(t, f) { (listeners[t] ||= []).push(f); }, click() { (listeners.click || []).forEach((f) => f({})); },
    pause() {}, load() {}, play() { return Promise.resolve(); }, querySelector() { return null; },
  };
  return e;
}
function load() {
  const kv = new Map();
  const win = { addEventListener() {} };
  const ctx = { window: win, document: { createElement: fakeEl, addEventListener() {}, hidden: false }, navigator: {},
    localStorage: { getItem: (k) => (kv.has(k) ? kv.get(k) : null), setItem: (k, v) => kv.set(k, String(v)), removeItem: (k) => kv.delete(k) },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, console };
  win.document = ctx.document;
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "room-bridge.js"), "utf8"), ctx);
  return { R: win.PATVRoom, kv };
}
const play = (host) => host.children[0].children.find((c) => c.className.split(" ").includes("rb-play"));

test("pause() stops without forgetting the viewer listens; resume() starts an idle player whose relay is on; isPlaying()", () => {
  const { R, kv } = load();
  const host = fakeEl("div"), p = R.audio(host, "night-orchard", { showOff: true });
  assert.equal(p.isPlaying(), false);
  assert.equal(p.resume(), false, "the relay isn't on yet (no answer) - nothing starts");
  p.update({ room: { audio: true, live: true } });
  const seen = []; p.onChange((s) => seen.push(s));
  assert.equal(p.resume(), true, "idle + relay on: it starts");
  assert.equal(p.isPlaying(), true); assert.equal(kv.get("patvRoomAudio"), "1");
  assert.deepEqual(seen, ["night-orchard"], "start() tells the listeners (the Dock broadcasts audio-on)");
  assert.equal(p.resume(), false, "already playing");
  assert.equal(p.pause(), true); assert.equal(p.isPlaying(), false);
  assert.equal(kv.get("patvRoomAudio"), "1", "pause keeps 'resume listening'");
  assert.deepEqual(seen, ["night-orchard", null]);
  assert.equal(p.pause(), false, "nothing to pause");
  play(host).click(); play(host).click();
  assert.equal(kv.get("patvRoomAudio"), "0", "the viewer's own ❚❚ still forgets it");
});

test("listen(): one notification per start (not two), another pad's audio, resume() goes back to this player's own pad", () => {
  const { R } = load();
  const host = fakeEl("div"), p = R.audio(host, "front", { showOff: true });
  p.update({ room: { audio: true, live: true } });
  const seen = []; p.onChange((s) => seen.push(s));
  p.listen("third", "Third Room");
  assert.deepEqual(seen, ["third"], "listen() lets start() tell them once");
  assert.equal(p.playingSlug(), "third");
  p.pause(); assert.equal(p.playingSlug(), null);
  assert.equal(p.resume(), true); assert.equal(p.playingSlug(), "front", "resume() plays this player's own pad");
});
