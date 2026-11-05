"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs");
const source = fs.readFileSync(require("node:path").join(__dirname, "../public/js/room-bridge.js"), "utf8");
function fakeEl(tag) {
  const cls = new Set();
  const e = {
    tagName: tag, children: [], attrs: {}, style: {}, disabled: false, title: "", textContent: "", buffered: { length: 0 }, currentTime: 0, playbackRate: 1, paused: true, muted: false, volume: 1,
    classList: {
      add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
      toggle: (c, on) => { const v = on === undefined ? !cls.has(c) : !!on; if (v) cls.add(c); else cls.delete(c); return v; },
    },
    get className() { return [...cls].join(" "); },
    set className(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => cls.add(c)); },
    setAttribute(k, v) { e.attrs[k] = String(v); }, getAttribute(k) { return e.attrs[k]; },
    appendChild(c) { e.children.push(c); return c; }, addEventListener() {}, removeAttribute(k) { delete e.attrs[k]; },
    pause() { e.paused = true; }, load() {}, play() { e.paused = false; return Promise.resolve(); }, querySelector() { return null; },
  };
  return e;
}

async function load(search, status = 200, pending = false, options = {}) {
  const requests = [], intervals = [], cleared = [], copied = [], events = new Map();
  const host = fakeEl("div");
  const document = { createElement(tag) { const e = fakeEl(tag); e.addEventListener = (n, f) => events.set(e, f); return e; }, addEventListener() {} };
  let resolve;
  const response = options.fail ? Promise.reject(new Error("offline")) : pending ? new Promise(r => { resolve = r; }) : Promise.resolve({ status });
  const window = { location: { search }, addEventListener() {} };
  const navigator = { userAgent: "ExampleBrowser on ExampleOS", platform: "ExampleOS", audioSession: { type: "auto" }, clipboard: { writeText: async t => copied.push(t) } };
  if (options.ios) navigator.userAgent = 'iPhone ExampleSafari';
  if (options.context) window.AudioContext = options.context;
  vm.runInNewContext(source, { window, document, navigator, fetch: (url, opts) => { requests.push({ url, opts }); return response; },
    localStorage: { getItem: () => null }, setInterval: f => { intervals.push(f); return intervals.length; }, clearInterval: i => cleared.push(i),
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, console });
  const player = window.PATVRoom.audio(host, "example", { showOff: true });
  await new Promise(setImmediate);
  return { host, player, requests, intervals, cleared, copied, events, navigator, resolve };
}
test("diagnostics require the explicit flag and successful server capability check", async () => {
  for (const flag of ["", "?audiodebug=0", "?audiodebug=10", "?x=audiodebug=1"]) {
    const x = await load(flag); assert.equal(x.requests.length, 0); assert.equal(x.host.children.length, 1);
  }
  for (const status of [401, 403, 500]) {
    const x = await load("?audiodebug=1", status); assert.equal(x.host.children.length, 1);
  }
  const x = await load("?audiodebug=1"); assert.equal(x.host.children.length, 2);
  assert.equal(x.requests[0].url, "/api/admin/pepe/audio"); assert.equal(x.requests[0].opts.cache, "no-store");
  assert.equal(x.navigator.audioSession.type, "auto", "diagnostics must not fix the state being reproduced");
});
test("live local snapshot includes ducking and unavailable levels; copy uses a fresh snapshot", async () => {
  const x = await load("?audiodebug=1"); const panel = x.host.children[1], button = panel.children[1], pre = panel.children[2];
  let d = JSON.parse(pre.textContent); assert.equal(d.recording, false); assert.equal(d.duckOn, false); assert.equal(d.rms, null); assert.equal(d.peak, null);
  x.player.duck(true); x.player.setRecording(true); x.intervals.at(-1)(); d = JSON.parse(pre.textContent);
  assert.equal(d.duckActive, true); assert.equal(d.volume, 0.8 * 0.2); assert.equal(d.userVol, 0.8);
  x.player.setRecording(false); x.events.get(button)(); await new Promise(setImmediate); d = JSON.parse(x.copied[0]);
  assert.equal(d.recording, false); assert.equal(d.volume, 0.8); assert.equal(d.session, "auto"); assert.ok(d.at);
  assert.ok(!("slug" in d)); assert.ok(!("audit" in d));
  x.player.destroy(); assert.ok(x.cleared.includes(x.intervals.length));
});
test("destroy before capability response prevents a detached panel and timer", async () => {
  const x = await load("?audiodebug=1", 200, true); x.player.destroy(); x.resolve({ status: 200 }); await new Promise(setImmediate);
  assert.equal(x.host.children.length, 1);
});


test("failed capability request and unavailable clipboard fail closed", async () => {
  const denied = await load("?audiodebug=1", 200, false, { fail: true }); assert.equal(denied.host.children.length, 1);
  const x = await load("?audiodebug=1"), button = x.host.children[1].children[1];
  x.navigator.clipboard = null; x.events.get(button)(); assert.match(button.textContent, /Select and copy/);
  const pre = x.host.children[1].children[2], frozen = pre.textContent;
  x.player.setRecording(true); x.intervals.at(-1)(); assert.equal(pre.textContent, frozen, "manual selection must survive refreshes");
  x.navigator.clipboard = { writeText: async () => { throw new Error("denied"); } };
  x.events.get(button)(); await new Promise(setImmediate); assert.match(button.textContent, /Select and copy/);
});
test("existing analyser supplies linear RMS and peak; iOS diagnostics never create a context", async () => {
  let contexts = 0;
  class Context {
    constructor() { contexts++; this.state = "running"; }
    createMediaElementSource() { return { connect() {} }; }
    createAnalyser() { return { fftSize: 64, frequencyBinCount: 32, connect() {}, getByteFrequencyData(a) { a.fill(20); }, getByteTimeDomainData(a) { a.fill(192); } }; }
  }
  const x = await load("?audiodebug=1", 200, false, { context: Context });
  assert.equal(contexts, 0, "diagnostics alone never create a graph");
  x.player.listen("example"); const d = x.host.children[0].rbDebug();
  assert.equal(d.rms, 0.5); assert.equal(d.peak, 0.5); assert.equal(d.level, 20); assert.equal(d.ctx, "running");
  const ios = await load("?audiodebug=1", 200, false, { context: Context, ios: true });
  const count = contexts; ios.player.listen("example"); assert.equal(contexts, count);
  assert.equal(ios.host.children[0].rbDebug().rms, null);
});
