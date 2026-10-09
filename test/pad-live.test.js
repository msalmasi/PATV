// Offline tests for the pad page's live loop (views/room.ejs) and the room audio player's "relay off" state
// (public/js/room-bridge.js), 1.99hj.
//   NODE_PATH=G:/PATV/node_modules node --test test/pad-live.test.js
//
// The bug: 1.99ef gave the pad's live-status line (<p id="rmStatus"> with #rmCount / #rmStDot inside) the same id as
// the chat's poll status (<small id="rmStatus">). getElementById returned the status LINE, so every successful
// poll's setStatus('') emptied it, the next renderRoom() threw on the missing #rmCount, the poll's catch swallowed
// it - and chat, the mic list and the people list stopped updating until a reload (prod and staging).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const room = fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8");

test("room.ejs: the chat's poll status is the ONLY #rmStatus; the live-status line has its own id", () => {
  const ids = [...room.matchAll(/\bid="rmStatus"/g)];
  assert.equal(ids.length, 1, "exactly one element with id rmStatus");
  assert.match(room, /<small id="rmStatus" class="status"/, "it is the chat heading's status");
  assert.match(room, /<p class="lstat" id="rmLiveStat">/, "the live-status line is #rmLiveStat");
});

test("room.ejs: static ids used by the live loop are unique", () => {
  for (const id of ["rmCount", "rmStDot", "rmLive", "rmTopic", "rmFeed", "rmMic", "rmAudioBox", "rmLiveStat"]) {
    const n = [...room.matchAll(new RegExp(`\\bid="${id}"`, "g"))].length;
    assert.ok(n <= 1, `#${id} appears ${n} times`);
  }
});

test("room.ejs: one widget can't freeze the page - every sub-update is isolated and the poll always starts", () => {
  const apply = room.slice(room.indexOf("function apply(d, first)"), room.indexOf("function poll()"));
  for (const name of ["mod", "room", "compose", "audio", "feed", "clip"]) {
    assert.match(apply, new RegExp(`safe\\('${name}'`), `${name} update wrapped`);
  }
  assert.match(room, /try \{ apply\(data, true\); \} finally \{ schedule\(\); \}/);
  assert.match(room, /function setStatus\(t, err\) \{ var s = document\.getElementById\('rmStatus'\); if \(!s\) return;/);
  assert.match(room, /var cntEl = document\.getElementById\('rmCount'\); if \(cntEl\)/);
});

// ── the audio player in a tiny fake DOM ──
function fakeEl(tag) {
  const cls = new Set();
  const e = {
    tagName: tag, children: [], attrs: {}, style: {}, disabled: false, title: "", textContent: "",
    classList: {
      add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
      toggle: (c, on) => { const v = on === undefined ? !cls.has(c) : !!on; if (v) cls.add(c); else cls.delete(c); return v; },
    },
    get className() { return [...cls].join(" "); },
    set className(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => cls.add(c)); },
    setAttribute(k, v) { e.attrs[k] = String(v); }, getAttribute(k) { return e.attrs[k]; },
    appendChild(c) { e.children.push(c); return c; }, addEventListener() {}, removeAttribute(k) { delete e.attrs[k]; },
    pause() {}, load() {}, play() { return Promise.resolve(); }, querySelector() { return null; },
  };
  return e;
}
function loadBridge() {
  const win = { addEventListener() {} };
  const ctx = { window: win, document: { createElement: fakeEl, addEventListener() {}, hidden: false }, navigator: {},
                setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, console };
  win.document = ctx.document;
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "room-bridge.js"), "utf8"), ctx);
  return win.PATVRoom;
}
const find = (host, cls) => {
  const box = host.children[0];
  return cls ? box.children.find((c) => c.className.split(" ").includes(cls)) : box;
};

test("pad page: while the audio relay is off the player stays visible, greyed, and says why", () => {
  const R = loadBridge();
  const host = fakeEl("div");
  const p = R.audio(host, "drama-central", { showOff: true });
  p.update({ room: { audio: false, live: true } });
  assert.equal(find(host).classList.contains("hide"), false, "not hidden");
  assert.equal(find(host).classList.contains("off"), true, "greyed");
  assert.equal(find(host, "rb-play").disabled, true, "listen disabled");
  assert.match(find(host, "rb-state").textContent, /audio relay off/);
  p.update({ room: { audio: false, live: false } });
  assert.match(find(host, "rb-state").textContent, /room offline/);
  p.update({ room: { audio: true, live: true } });
  assert.equal(find(host).classList.contains("off"), false);
  assert.equal(find(host, "rb-play").disabled, false, "listen enabled once the relay is on");
});

test("homepage (no showOff): the player stays hidden while the relay is off, as before", () => {
  const R = loadBridge();
  const host = fakeEl("div");
  const p = R.audio(host, "x");
  p.update({ room: { audio: false, live: true } });
  assert.equal(find(host).classList.contains("hide"), true);
  p.update({ room: { audio: true, live: true } });
  assert.equal(find(host).classList.contains("hide"), false);
});
