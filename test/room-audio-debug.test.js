"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), vm = require("node:vm"), fs = require("node:fs"), path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "../public/js/room-bridge.js"), "utf8");
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };
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

// options: fail (the check's request fails), answer (the check's response object), context (an AudioContext class), ios,
// listen + ticket (the ⚡ WebRTC path: PATVRtc.listen and the /audio/rtc ticket)
async function load(search, status = 200, pending = false, options = {}) {
  const requests = [], intervals = [], cleared = [], copied = [], events = new Map();
  const host = fakeEl("div");
  const document = { createElement(tag) { const e = fakeEl(tag); e.addEventListener = (n, f) => events.set(e, f); return e; }, addEventListener() {} };
  let resolve;
  const response = options.fail ? Promise.reject(new Error("offline")) : pending ? new Promise(r => { resolve = r; }) : Promise.resolve(options.answer || { status });
  const window = { location: { search }, addEventListener() {} };
  const navigator = { userAgent: "ExampleBrowser on ExampleOS", platform: "ExampleOS", audioSession: { type: "auto" }, clipboard: { writeText: async t => copied.push(t) } };
  if (options.ios) navigator.userAgent = 'iPhone ExampleSafari';
  if (options.context) window.AudioContext = options.context;
  const fetch = (url, opts) => {
    requests.push({ url, opts });
    if (/\/audio\/rtc$/.test(url)) return Promise.resolve({ json: async () => options.ticket || null });
    return response;
  };
  window.fetch = fetch;
  if (options.listen) window.PATVRtc = { listen: options.listen };
  vm.runInNewContext(source, { window, document, navigator, fetch,
    localStorage: { getItem: () => null }, setInterval: f => { intervals.push(f); return intervals.length; }, clearInterval: i => cleared.push(i),
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, console });
  const player = window.PATVRoom.audio(host, "example", { showOff: true });
  await new Promise(setImmediate);
  const checks = () => requests.filter((r) => r.url === "/api/admin/pepe/audio").length;
  return { host, player, requests, checks, intervals, cleared, copied, events, navigator, resolve, window };
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
test("a redirect never counts as the admin answer (a sign-in, proxy or maintenance page answering 200)", async () => {
  const x = await load("?audiodebug=1");
  assert.equal(x.requests[0].opts.redirect, "error", "the check rejects a redirect instead of following it");
  const moved = await load("?audiodebug=1", 200, false, { answer: { status: 200, redirected: true, type: "basic" } });
  assert.equal(moved.host.children.length, 1, "a 200 reached through a redirect shows no panel");
});
test("one capability check per page, however many players it has", async () => {
  const x = await load("?audiodebug=1");
  const second = fakeEl("div"); x.window.PATVRoom.audio(second, "example-two", { showOff: true }); await settle();
  assert.equal(x.checks(), 1);
  assert.equal(x.host.children.length, 2); assert.equal(second.children.length, 2, "both players show the panel from the one answer");
});
test("live local snapshot includes ducking and unavailable levels; copy uses a fresh snapshot", async () => {
  const x = await load("?audiodebug=1"); const panel = x.host.children[1], button = panel.children[1], pre = panel.children[2];
  let d = JSON.parse(pre.textContent); assert.equal(d.recording, false); assert.equal(d.duckOn, false); assert.equal(d.rms, null); assert.equal(d.peak, null);
  assert.equal(d.duckActive, false);
  x.player.duck(true); x.intervals.at(-1)(); d = JSON.parse(pre.textContent);
  assert.equal(d.duckOn, true); assert.equal(d.duckActive, false, "ducking on alone is not ducking"); assert.equal(d.volume, 0.8);
  x.player.setRecording(true); x.intervals.at(-1)(); d = JSON.parse(pre.textContent);
  assert.equal(d.duckActive, true); assert.equal(d.volume, 0.8 * 0.2); assert.equal(d.userVol, 0.8);
  x.player.setRecording(false); x.events.get(button)(); await new Promise(setImmediate); d = JSON.parse(x.copied[0]);
  assert.equal(d.recording, false); assert.equal(d.duckOn, true); assert.equal(d.duckActive, false, "the recording ended: no longer ducked");
  assert.equal(d.volume, 0.8); assert.equal(d.session, "auto"); assert.ok(d.at);
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
class Context {
  constructor() { Context.made++; this.state = "running"; this.destination = {}; }
  createMediaElementSource() { return { connect() {} }; }
  createMediaStreamSource() { return { connect() {} }; }
  createAnalyser() { return { fftSize: 64, frequencyBinCount: 32, connect() {}, getByteFrequencyData(a) { a.fill(20); }, getByteTimeDomainData(a) { a.fill(192); } }; }
  resume() { return Promise.resolve(); }
}
Context.made = 0;
test("existing analyser supplies linear RMS and peak; iOS diagnostics never create a context", async () => {
  const before = Context.made, x = await load("?audiodebug=1", 200, false, { context: Context });
  assert.equal(Context.made, before, "diagnostics alone never create a graph");
  x.player.listen("example"); const d = x.host.children[0].rbDebug();
  assert.equal(d.rms, 0.5); assert.equal(d.peak, 0.5); assert.equal(d.level, 20); assert.equal(d.ctx, "running");
  const ios = await load("?audiodebug=1", 200, false, { context: Context, ios: true });
  const count = Context.made; ios.player.listen("example"); assert.equal(Context.made, count);
  assert.equal(ios.host.children[0].rbDebug().rms, null);
});
test("⚡ live: the snapshot reads the WebRTC element and its analyser, never the paused MP3 element or its buffer", async () => {
  const x = await load("?audiodebug=1", 200, false, { context: Context, ticket: { ok: true, whep: "https://example.test/whep/room-0123456789abcdef?pt=t", ready: true },
    listen: async (url, el) => { el.srcObject = { stream: true }; return { close() {}, onfail: null }; } });
  x.player.update({ room: { audio: true, live: true, rtc: true } });
  x.player.listen("example"); await settle();
  const box = x.host.children[0], [au, rau] = box.children.filter((c) => c.tagName === "audio");
  // the MP3 element: paused, its own volume / position and a buffer - none of it may show while ⚡ plays
  au.currentTime = 5; au.buffered = { length: 1, start: () => 0, end: () => 7 }; au.volume = 0.33; rau.currentTime = 9;
  const d = box.rbDebug();
  assert.equal(d.mode, "rtc"); assert.equal(d.rtc, true);
  assert.equal(au.paused, true); assert.equal(d.paused, false, "the ⚡ element plays");
  assert.equal(d.volume, 0.8); assert.equal(d.t, 9);
  assert.equal(d.ahead, null, "no MP3 buffer on ⚡");
  assert.equal(d.meter, true); assert.equal(d.rms, 0.5); assert.equal(d.peak, 0.5);
  x.player.duck(true); x.player.setRecording(true); assert.equal(box.rbDebug().volume, 0.8 * 0.2);
  x.player.setRecording(false); assert.equal(box.rbDebug().duckActive, false); assert.equal(box.rbDebug().volume, 0.8);
});
test("cache-busters: room-bridge.js v36 and room-bridge.css v17 (1.99apj audiodebug) in every view that loads them, one version each", () => {
  const views = path.join(__dirname, "..", "views");
  for (const v of ["room.ejs", "home.ejs"]) {
    const s = fs.readFileSync(path.join(views, v), "utf8");
    assert.match(s, /room-bridge\.js\?v=36\b/, v); assert.match(s, /room-bridge\.css\?v=17\b/, v);
    assert.doesNotMatch(s, /room-bridge\.js\?v=(?!36\b)\d+/, v + ": one room-bridge.js version");
    assert.doesNotMatch(s, /room-bridge\.css\?v=(?!17\b)\d+/, v + ": one room-bridge.css version");
  }
  const home = fs.readFileSync(path.join(views, "home.ejs"), "utf8");
  assert.equal((home.match(/room-bridge\.css\?v=17\b/g) || []).length, 2, "home.ejs loads the stylesheet in both places");
});

// The differential trace: the real player through ⚡ / MP3, ducking, a recording, the ⚡ -> MP3 fallback and rejoin, the cushion,
// Copy, the handover pause / resume and destroy - once without ?audiodebug=1 and once with the panel (the check answers 200).
// Every write to the two audio elements, every audio-engine call and every audio-session write is logged; both logs must match.
async function trace({ search, ios, scenario }) {
  const log = [], ids = { n: 0 }, intervals = new Map(), timeouts = new Map(), rafs = new Map();
  const WATCH = new Set(["paused", "muted", "volume", "playbackRate", "src", "srcObject", "currentTime", "preload", "autoplay", "preservesPitch"]);
  let els = 0, contexts = 0, copied = 0, reads = 0;
  const doc = { createElement: (t) => mediaEl(t), addEventListener() {}, hidden: false };
  function mediaEl(tag) {
    const id = tag + "#" + (++els), cls = new Set(), on = {}, audio = tag === "audio";
    const base = {
      tagName: tag, children: [], attrs: {}, style: {}, disabled: false, title: "", textContent: "", type: "", ownerDocument: doc,
      paused: true, muted: false, volume: 1, playbackRate: 1, currentTime: 0, srcObject: null, buffered: { length: 0, start: () => 0, end: () => 0 },
      classList: {
        add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
        toggle: (c, v) => { const x = v === undefined ? !cls.has(c) : !!v; if (x) cls.add(c); else cls.delete(c); return x; },
      },
      get className() { return [...cls].join(" "); },
      set className(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => cls.add(c)); },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; },
      removeAttribute(k) { if (audio) log.push(id + ".removeAttribute(" + k + ")"); delete this.attrs[k]; },
      appendChild(c) { this.children.push(c); return c; }, querySelector() { return null; },
      addEventListener(n, f) { (on[n] = on[n] || []).push(f); }, fire(n) { (on[n] || []).forEach((f) => f({ type: n })); },
      pause() { if (audio) log.push(id + ".pause()"); this.paused = true; },
      load() { if (audio) log.push(id + ".load()"); },
      play() { if (audio) log.push(id + ".play()"); this.paused = false; const self = this; Promise.resolve().then(() => self.fire("playing")); return Promise.resolve(); },
    };
    return new Proxy(base, { set(t, k, v) {
      if (audio && WATCH.has(k)) log.push(id + "." + String(k) + "=" + (v && typeof v === "object" ? "[obj]" : String(v).replace(/t=\d+/, "t=N")));
      t[k] = v; return true;
    } });
  }
  const analyser = () => ({ fftSize: 64, frequencyBinCount: 32, connect() { log.push("analyser.connect"); },
    getByteFrequencyData(a) { reads++; a.fill(40); }, getByteTimeDomainData(a) { reads++; a.fill(150); } });
  class AC {
    constructor() { contexts++; log.push("ctx.new"); this.state = "running"; this.destination = {}; }
    createMediaElementSource() { log.push("ctx.createMediaElementSource"); return { connect() { log.push("source.connect"); } }; }
    createMediaStreamSource() { log.push("ctx.createMediaStreamSource"); return { connect() { log.push("source.connect"); } }; }
    createAnalyser() { log.push("ctx.createAnalyser"); return analyser(); }
    createGain() { log.push("ctx.createGain"); return { gain: {}, connect() {} }; }
    resume() { log.push("ctx.resume"); return Promise.resolve(); }
    suspend() { log.push("ctx.suspend"); return Promise.resolve(); }
    close() { log.push("ctx.close"); return Promise.resolve(); }
  }
  let sessType = "auto", sess = null;
  const navigator = { userAgent: ios ? "Mozilla/5.0 (iPhone) ExampleBrowser" : "Mozilla/5.0 (ExampleOS) ExampleBrowser", platform: ios ? "iPhone" : "ExampleOS",
    maxTouchPoints: ios ? 5 : 0, audioSession: { get type() { return sessType; }, set type(v) { log.push("session=" + v); sessType = v; } },
    clipboard: { writeText: async () => { copied++; } } };
  const win = { location: { search }, addEventListener() {}, AudioContext: AC, document: doc };
  win.fetch = (url) => {
    if (url === "/api/admin/pepe/audio") return Promise.resolve({ status: 200 });
    if (/\/audio\/rtc$/.test(url)) return Promise.resolve({ json: async () => ({ ok: true, whep: "https://example.test/whep/x", ready: true, levels: false }) });
    return Promise.reject(new Error("unexpected " + url));
  };
  win.PATVRtc = { listen: (u, el) => { el.srcObject = { stream: 1 }; sess = { pc: {}, close() { log.push("rtc.close"); }, onfail: null }; return Promise.resolve(sess); } };
  let next = 1;
  vm.runInNewContext(source, { window: win, document: doc, navigator, fetch: win.fetch,
    sessionStorage: { getItem: () => null, setItem() {} }, localStorage: { getItem: () => null, setItem() {} },
    setTimeout: (f, ms) => { const i = next++; timeouts.set(i, { f, ms }); return i; }, clearTimeout: (i) => timeouts.delete(i),
    setInterval: (f, ms) => { const i = next++; intervals.set(i, { f, ms }); return i; }, clearInterval: (i) => intervals.delete(i),
    requestAnimationFrame: (f) => { const i = next++; rafs.set(i, f); return i; }, cancelAnimationFrame: (i) => rafs.delete(i), console });
  async function step(label, n = 3) {
    log.push("-- " + label);
    for (let k = 0; k < n; k++) {
      for (const [, v] of [...intervals]) v.f();
      for (const [i, f] of [...rafs]) { rafs.delete(i); f(); }
      await settle();
    }
  }
  const host = mediaEl("div"), p = win.PATVRoom.audio(host, "example", { showOff: true });
  const box = host.children[0], au = box.children.filter((c) => c.tagName === "audio")[0];
  await settle();
  p.update({ room: { audio: true, live: true, rtc: scenario === "rtc" } }); await step("idle");
  p.listen("example"); await settle(); await step("started");
  p.duck(true); await step("duck on"); p.setRecording(true); await step("recording"); p.setRecording(false); await step("released");
  if (scenario === "rtc" && sess && sess.onfail) { sess.onfail(); await settle(); }
  au.buffered = { length: 1, start: () => 0, end: () => 1.2 };
  await step("mp3 cushion", 6);
  for (const [i, t] of [...timeouts]) if (t.ms <= 4000) { timeouts.delete(i); t.f(); }      // the stall / ⚡ rejoin timers that are due
  await step("timeouts");
  const panel = host.children[1] || null;
  if (panel) { panel.children[1].fire("click"); await settle(); }
  await step("after copy");
  p.pause(); await step("handover pause"); p.resume(); await settle(); await step("handover resume");
  p.destroy(); await step("destroyed");
  return { log, contexts, copied, reads, panel: !!panel, intervalsLeft: intervals.size, session: sessType };
}
test("the diagnostics never touch playback: the same media, audio-engine and session writes with and without the panel", async () => {
  for (const scenario of ["rtc", "mp3"]) for (const ios of [false, true]) {
    const what = scenario + (ios ? " on iOS" : " on desktop");
    const off = await trace({ search: "", ios, scenario }), on = await trace({ search: "?audiodebug=1", ios, scenario });
    assert.equal(off.panel, false, what); assert.equal(on.panel, true, what); assert.equal(on.copied, 1, what + ": Copy ran");
    assert.ok(off.log.some((l) => /\.play\(\)$/.test(l)), what + ": the trace saw the player play");
    assert.deepEqual(on.log, off.log, what);
    assert.equal(on.session, off.session, what);
    assert.equal(on.intervalsLeft, 0, what + ": destroy leaves no timer"); assert.equal(off.intervalsLeft, 0, what);
    if (ios) assert.equal(on.contexts, 0, what + ": no audio context on iOS");
    else assert.ok(on.reads > off.reads, what + ": the panel refreshed from the existing analyser");
  }
});
