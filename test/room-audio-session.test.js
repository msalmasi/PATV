// 1.99apl room audio: public/js/room-bridge.js's audio session, volume and ducking state machine, in a small fake DOM
// (the real player + push-to-talk, a stubbed navigator.audioSession that logs every write):
//   * the room starts playing -> 'playback' (▶, inside the tap, before any element plays; each element's 'playing'): MP3 relay and ⚡,
//     iOS and desktop; never while the page holds a mic (between the hand-off's before() and after()); no API / a throwing one: no error
//   * push-to-talk's before / after hand-off unchanged: 'play-and-record' just before the mic opens, 'playback' / 'auto' after
//   * the user's saved volume / mute re-applied when playback starts (never read back, never saved)
//   * no duck level before the first recording; every way a recording ends clears it (pointerup, the release tail, pointercancel,
//     pointerleave, the tap / key that sends, the max length, a recorder error, a hidden page, pagehide, the mic relay off, destroy)
//   node --test test/room-audio-session.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(repo, "public", "js", "room-bridge.js"), "utf8");
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

// options: ios, session ('auto' | null = no Audio Session API | 'throw' = an API whose every access throws), rtc (the ⚡ path),
// stored (localStorage), gum (a getUserMedia stand-in)
function page(options = {}) {
  const { ios = false, rtc = false, stored = {} } = options;
  const log = [], timers = new Map(), intervals = new Map(), records = [], kv = new Map(Object.entries(stored));
  let now = 50000, next = 0, n = 0, stops = 0, type = options.session === undefined ? "auto" : options.session;
  function events(o) {
    o.listeners = {};
    o.addEventListener = (k, fn, capture = false) => { (o.listeners[k] ||= []).push({ fn, capture }); };
    o.removeEventListener = (k, fn, capture = false) => { o.listeners[k] = (o.listeners[k] || []).filter((x) => x.fn !== fn || x.capture !== capture); };
    o.fire = (k, e = {}) => {
      const all = (o.listeners[k] || []).slice();
      all.filter((x) => x.capture).concat(all.filter((x) => !x.capture)).forEach((x) => {
        if ((o.listeners[k] || []).includes(x)) x.fn(Object.assign({ type: k, preventDefault() {} }, e));
      });
    };
    o.dispatchEvent = (e) => { o.fire(e.type, e); return true; };
    return o;
  }
  const win = events({ location: { search: "" } });
  const doc = events({ hidden: false, defaultView: win });
  function element(tag) {
    const cls = new Set(), id = tag + "#" + (++n), media = tag === "audio";
    const e = events({ tagName: tag, ownerDocument: doc, children: [], options: [], attrs: {}, style: {}, disabled: false, title: "", value: "", type: "", textContent: "",
      paused: true, muted: false, volume: 1, currentTime: 0, playbackRate: 1, srcObject: null, buffered: { length: 0, start: () => 0, end: () => 0 },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; }, removeAttribute(k) { delete this.attrs[k]; },
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
      querySelectorAll(sel) { const all = this.children.flatMap((c) => [c, ...c.querySelectorAll(sel)]); return all.filter((c) => (sel[0] === "." ? c.classList.contains(sel.slice(1)) : c.tagName === sel)); },
      // a real element only plays (and fires 'playing') with something to play
      // (the log says whether it had one: the in-tap unlock plays both elements empty)
      play() {
        const has = !!(this.attrs.src || this.srcObject);
        if (media) log.push("play " + id + (has ? " +src" : " empty")); this.paused = false;
        const self = this; if (has) Promise.resolve().then(() => self.fire("playing")); return Promise.resolve();
      },
      pause() { if (media) log.push("pause " + id); this.paused = true; }, load() {},
    });
    Object.defineProperty(e, "src", { get() { return e.attrs.src; }, set(v) { e.attrs.src = String(v); } });
    e.classList = { add: (...v) => v.forEach((x) => cls.add(x)), remove: (...v) => v.forEach((x) => cls.delete(x)), contains: (x) => cls.has(x),
      toggle: (x, on) => { const v = on === undefined ? !cls.has(x) : !!on; if (v) cls.add(x); else cls.delete(x); return v; } };
    Object.defineProperty(e, "className", { get: () => [...cls].join(" "), set: (v) => { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((x) => cls.add(x)); } });
    return e;
  }
  doc.createElement = element;
  let audioSession;
  if (options.session === "throw") audioSession = { get type() { throw new Error("no session"); }, set type(v) { throw new Error("no session"); } };
  else if (options.session !== null) audioSession = { get type() { return type; }, set type(v) { log.push("session=" + v); type = v; } };
  function stream() { return { getTracks: () => [{ stop() { stops++; } }] }; }
  const navigator = { userAgent: ios ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) ExampleWebKit" : "Mozilla/5.0 (ExampleOS) ExampleBrowser",
    platform: ios ? "iPhone" : "ExampleOS", maxTouchPoints: ios ? 5 : 0,
    mediaDevices: { getUserMedia: () => { log.push("gum@" + (audioSession && options.session !== "throw" ? type : "-")); return options.gum ? options.gum(stream) : Promise.resolve(stream()); } } };
  if (audioSession) navigator.audioSession = audioSession;
  class Recorder {
    constructor(s) { this.stream = s; this.state = "inactive"; this.mimeType = "audio/webm"; records.push(this); }
    static isTypeSupported(t) { return t === "audio/webm"; }
    start() { this.state = "recording"; }
    stop() { if (this.state === "inactive") throw new Error("InvalidStateError"); this.state = "inactive"; const self = this; Promise.resolve().then(() => self.onstop && self.onstop()); }
  }
  win.MediaRecorder = Recorder;
  const sess = { pc: {}, close() {}, onfail: null };
  win.fetch = (url) => {
    log.push("fetch " + url);
    if (/\/audio\/rtc$/.test(url)) return Promise.resolve({ json: async () => ({ ok: true, whep: "https://example.test/whep/room-0123456789abcdef?pt=t", ready: true, levels: false }) });
    return Promise.resolve({ status: 200, json: async () => ({ ok: true }) });
  };
  if (rtc) win.PATVRtc = { listen: (u, el) => { el.srcObject = { stream: 1 }; el.play(); return Promise.resolve(sess); } };   // autoplay with the stream
  class FakeDate extends Date { static now() { return now; } }
  const ctx = { window: win, document: doc, navigator, fetch: win.fetch, console, Date: FakeDate, MediaRecorder: Recorder,
    Blob: class { constructor(p, c) { this.type = c && c.type; } }, CustomEvent: class { constructor(t, i) { this.type = t; Object.assign(this, i); } },
    localStorage: { getItem: (k) => (kv.has(k) ? kv.get(k) : null), setItem: (k, v) => kv.set(k, String(v)) },
    sessionStorage: { getItem: () => null, setItem() {} },
    setTimeout: (fn, ms) => { timers.set(++next, { fn, ms }); return next; }, clearTimeout: (i) => timers.delete(i),
    setInterval: (fn, ms) => { intervals.set(++next, { fn, ms }); return next; }, clearInterval: (i) => intervals.delete(i),
    requestAnimationFrame: () => 0, cancelAnimationFrame() {} };
  vm.runInNewContext(SRC, ctx);
  const api = win.PATVRoom;
  function player() {
    const host = element("div"), p = api.audio(host, "night-orchard", { showOff: true });
    p.update({ room: { audio: true, live: true, rtc } });
    const box = host.children[0], kid = (c) => box.children.find((x) => x.classList.contains(c));
    const [au, rau] = box.children.filter((x) => x.tagName === "audio");
    return { p, box, au, rau, play: kid("rb-play"), dbg: () => box.rbDebug() };
  }
  // the Room Dock's wiring (pad-dock.js decorateAudio): push-to-talk's recording state drives the player's ducking
  function talk(P, room = {}) {
    const host = element("div"), t = api.ptt(host, "night-orchard"), seen = [];
    if (P) t.onRecording((on) => { seen.push(on); P.p.setRecording(on); }); else t.onRecording((on) => seen.push(on));
    t.update({ room: Object.assign({ micRelay: true }, room), mine: [] });
    return { t, seen, btn: host.querySelector(".rb-talk") };
  }
  return {
    api, win, doc, log, kv, records, timers, intervals, player, talk, stopped: () => stops,
    writes: () => log.filter((l) => l.startsWith("session=")).map((l) => l.slice(8)),
    setType: (v) => { type = v; }, getType: () => type,
    advance: (ms) => { now += ms; },
    due: (ms) => { for (const [i, t] of [...timers]) if (t.ms === ms) { timers.delete(i); t.fn(); } },
    every: (ms) => { for (const [, t] of [...intervals]) if (t.ms === ms) t.fn(); },
  };
}
// ▶ and, for the MP3 relay, its cushion filling (the element plays after 0.75 s of audio is in)
async function playIt(E, P, mode) {
  P.play.fire("click"); await flush();
  if (mode === "mp3") { P.au.buffered = { length: 1, start: () => 0, end: () => 1 }; E.every(250); await flush(); }
}
const close = (a, b) => Math.abs(a - b) < 1e-9;

test("the room starts playing -> the 'playback' session, on ▶ before any sound plays (MP3 relay and ⚡, iOS and desktop)", async () => {
  for (const mode of ["mp3", "rtc"]) for (const ios of [false, true]) {
    const what = mode + (ios ? " on iOS" : " on desktop");
    const E = page({ ios, rtc: mode === "rtc" }), P = E.player();
    assert.deepEqual(E.writes(), [], what + ": page load leaves the session alone");
    assert.equal(E.getType(), "auto", what);
    P.play.fire("click");
    assert.deepEqual(E.writes(), ["playback"], what + ": set inside the tap");
    assert.ok(E.log.some((l) => / empty$/.test(l)), what + ": the in-tap unlock ran (empty plays)");
    await flush();
    if (mode === "mp3") { P.au.buffered = { length: 1, start: () => 0, end: () => 1 }; E.every(250); await flush(); }
    const sound = E.log.findIndex((l) => / \+src$/.test(l));
    assert.ok(sound > 0 && E.log.indexOf("session=playback") < sound, what + ": set before the first element with a source plays");
    const d = P.dbg();
    assert.equal(d.mode, mode, what); assert.equal(d.paused, false, what + ": it plays"); assert.equal(d.session, "playback", what);
    assert.equal(d.micHeld, false, what);
    assert.deepEqual(E.writes(), ["playback"], what + ": 'playing' found it set - not written again");
    // something else left the page's session (another script, the browser): the next 'playing' sets it again
    E.setType("auto");
    (mode === "rtc" ? P.rau : P.au).fire("waiting"); (mode === "rtc" ? P.rau : P.au).fire("playing");
    assert.deepEqual(E.writes(), ["playback", "playback"], what + ": every 'playing' of the playing player");
    P.play.fire("click");          // ❚❚
    (mode === "rtc" ? P.rau : P.au).fire("playing");
    assert.deepEqual(E.writes(), ["playback", "playback"], what + ": a stopped player's late event writes nothing");
  }
});

test("no Audio Session API (desktop Chrome, Firefox) or one that throws: the room plays, nothing throws", async () => {
  for (const session of [null, "throw"]) for (const mode of ["mp3", "rtc"]) {
    const E = page({ session, rtc: mode === "rtc" }), P = E.player();
    await playIt(E, P, mode);
    assert.equal(P.dbg().paused, false, String(session) + " " + mode); assert.equal(P.dbg().session, null);
    const T = E.talk(P); T.btn.fire("pointerdown"); await flush(); E.advance(1000); T.btn.fire("pointerup"); await flush();
    assert.equal(E.stopped(), 1, "push-to-talk still records and lets the mic go");
  }
});

test("never while the page holds a mic: ▶ / 'playing' during a recording leave 'play-and-record' to the hand-back", async () => {
  // the story camera (and anything else) through PATVRoom.session
  for (const ios of [false, true]) {
    const E = page({ ios }), P = E.player();
    E.api.session.before();
    assert.deepEqual(E.writes(), ["play-and-record"]); assert.equal(P.dbg().micHeld, true);
    await playIt(E, P, "mp3");
    assert.equal(P.dbg().paused, false, "the room plays");
    assert.deepEqual(E.writes(), ["play-and-record"], "no 'playback' while the mic is held (it would end the recording on iOS)");
    E.api.session.after();
    assert.deepEqual(E.writes(), ["play-and-record", "playback"], "the hand-back gives it 'playback' (a player plays)");
    assert.equal(P.dbg().micHeld, false);
  }
  // push-to-talk: recording, then ▶, then a stall and recovery mid-recording
  for (const ios of [false, true]) {
    const E = page({ ios }), P = E.player(), T = E.talk(P);
    T.btn.fire("pointerdown"); await flush();
    assert.equal(E.records[0].state, "recording");
    await playIt(E, P, "mp3");
    P.au.fire("waiting"); P.au.fire("playing");
    assert.deepEqual(E.writes(), ["play-and-record"], (ios ? "iOS" : "desktop") + ": nothing but the hand-off while recording");
    E.advance(1000); T.btn.fire("pointerup"); await flush();
    assert.deepEqual(E.writes(), ["play-and-record", "playback"]);
    P.au.fire("playing");
    assert.deepEqual(E.writes(), ["play-and-record", "playback"], "already 'playback': not written again");
  }
});

test("push-to-talk's before / after hand-off is unchanged: 'play-and-record' just before the mic opens, then 'playback' / 'auto'", async () => {
  for (const ios of [false, true]) {
    // nobody listens: the hand-back is 'auto', exactly as before
    let E = page({ ios }), T = E.talk(null);
    T.btn.fire("pointerdown"); await flush();
    assert.ok(E.log.includes("gum@play-and-record"), "the mic opens in a session that can record");
    E.advance(1000); T.btn.fire("pointerup"); await flush();
    assert.deepEqual(E.writes(), ["play-and-record", "auto"]); assert.deepEqual(T.seen, [false, true, false]);
    // the room plays: 'playback' on ▶, the press, 'playback' back - so the first press changes nothing it hands back
    E = page({ ios }); const P = E.player(); T = E.talk(P);
    await playIt(E, P, "mp3");
    T.btn.fire("pointerdown"); await flush(); E.advance(1000); T.btn.fire("pointerup"); await flush();
    T.btn.fire("pointerdown"); await flush(); E.advance(1000); T.btn.fire("pointerup"); await flush();
    assert.deepEqual(E.writes(), ["playback", "play-and-record", "playback", "play-and-record", "playback"]);
    assert.equal(E.stopped(), 2, "every mic track stopped at each release");
  }
});

test("the user's saved volume / mute are re-applied when playback starts (▶, each 'playing') - never read back, never saved", async () => {
  for (const mode of ["mp3", "rtc"]) {
    const E = page({ rtc: mode === "rtc", stored: { patvRoomVol: "40", patvRoomMuted: "1" } }), P = E.player();
    const els = [P.au, P.rau], tamper = () => els.forEach((x) => { x.volume = 1; x.muted = false; });
    els.forEach((x) => { assert.ok(close(x.volume, 0.4)); assert.equal(x.muted, true); });
    tamper();                                  // the browser / OS put the elements back to full and unmuted meanwhile
    P.play.fire("click");
    els.forEach((x) => { assert.ok(close(x.volume, 0.4), mode + ": ▶ re-applies the volume"); assert.equal(x.muted, true, mode + ": and the mute"); });
    await flush();
    if (mode === "mp3") { tamper(); P.au.buffered = { length: 1, start: () => 0, end: () => 1 }; E.every(250); await flush(); }
    els.forEach((x) => { assert.ok(close(x.volume, 0.4), mode); assert.equal(x.muted, true, mode); });
    tamper();
    const active = mode === "rtc" ? P.rau : P.au;
    active.fire("waiting"); active.fire("playing");             // a stall, then the sound comes back
    els.forEach((x) => { assert.ok(close(x.volume, 0.4), mode + ": 'playing' re-applies it"); assert.equal(x.muted, true, mode); });
    assert.equal(E.kv.get("patvRoomVol"), "40", "nothing saved"); assert.equal(E.kv.get("patvRoomMuted"), "1");
    assert.equal(P.dbg().userVol, 0.4); assert.equal(P.dbg().userMuted, true);
  }
  // iOS: element.volume is read-only there (the hardware buttons) - only the mute is the page's
  const E = page({ ios: true, stored: { patvRoomVol: "40", patvRoomMuted: "1" } }), P = E.player();
  P.au.muted = false; P.au.volume = 1;
  await playIt(E, P, "mp3");
  assert.equal(P.au.muted, true); assert.equal(P.au.volume, 1, "iOS: the volume is never written");
});

test("no duck level before the first recording: the duck applies only while a recording is live", async () => {
  const E = page(), P = E.player();
  P.p.duck(true);
  await playIt(E, P, "mp3");
  const T = E.talk(P);
  assert.deepEqual(T.seen, [false], "the Dock's subscription starts IDLE");
  [P.au, P.rau].forEach((x) => assert.equal(x.volume, 0.8, "duck switched on, nothing recorded yet: the user's volume"));
  let d = P.dbg();
  assert.equal(d.duckOn, true); assert.equal(d.recording, false); assert.equal(d.duckActive, false); assert.equal(d.volume, 0.8);
  T.btn.fire("pointerdown"); await flush();
  [P.au, P.rau].forEach((x) => assert.ok(close(x.volume, 0.16), "LIVE: ducked"));
  d = P.dbg(); assert.equal(d.recording, true); assert.equal(d.duckActive, true);
  P.au.fire("waiting"); P.au.fire("playing");
  assert.ok(close(P.au.volume, 0.16), "a 'playing' mid-recording keeps the duck (the recording is live)");
  E.advance(1000); T.btn.fire("pointerup"); await flush();
  [P.au, P.rau].forEach((x) => assert.equal(x.volume, 0.8));
  // without the Dock's 🦆 switch the room is never ducked, recording or not
  const F = page(), Q = F.player(), U = F.talk(Q);
  await playIt(F, Q, "mp3"); U.btn.fire("pointerdown"); await flush();
  assert.equal(Q.au.volume, 0.8); assert.equal(Q.dbg().duckActive, false);
});

// each way a recording ends: what to set up (room fields) and how it ends
const ENDS = {
  "pointerup": { end: (E, T) => { E.advance(1000); T.btn.fire("pointerup"); } },
  "pointerup after the release tail": { room: { pttTail: 300 }, end: (E, T, P) => {
    E.advance(1000); T.btn.fire("pointerup");
    assert.ok(close(P.au.volume, 0.16), "the tail still records: still ducked");
    assert.equal(P.dbg().recording, true);
    E.due(300);
  } },
  "pointercancel": { end: (E, T) => { E.advance(1000); T.btn.fire("pointercancel"); } },
  "pointerleave": { end: (E, T) => { E.advance(1000); T.btn.fire("pointerleave"); } },
  "the tap that sends (tap mode)": { start: async (E, T) => { T.btn.fire("pointerdown"); await flush(); T.btn.fire("pointerup"); }, end: (E, T, P) => {
    assert.ok(close(P.au.volume, 0.16), "a quick tap keeps recording (tap to send)");
    E.advance(1000); T.btn.fire("pointerdown"); T.btn.fire("pointerup");
  } },
  "the key that sends": { start: async (E, T) => { T.btn.fire("keydown", { key: "Enter", repeat: false }); await flush(); }, end: (E, T) => { E.advance(1000); T.btn.fire("keydown", { key: "Enter", repeat: false }); } },
  "the max length": { end: (E) => { E.advance(29500); E.due(29500); } },
  "a recorder error with no stop event after it": { end: (E) => { const r = E.records[0]; r.state = "inactive"; if (r.onerror) r.onerror({ type: "error" }); }, idle: true },
  "a recorder error, then the stop event": { end: (E) => { const r = E.records[0]; r.state = "inactive"; if (r.onerror) r.onerror({ type: "error" }); r.onstop(); }, idle: true },
  "the page hidden (visibilitychange)": { end: (E) => { E.doc.hidden = true; E.doc.fire("visibilitychange"); } },
  "pagehide": { end: (E) => { E.win.fire("pagehide"); } },
  "the mic relay switched off": { end: (E, T) => { T.t.update({ room: { micRelay: false }, mine: [] }); } },
  "destroy()": { end: (E, T) => { T.t.destroy(); } },
};
for (const [name, path_] of Object.entries(ENDS)) {
  test("every recording end path clears the duck and hands the session back: " + name, async () => {
    const E = page(), P = E.player();
    P.p.duck(true);
    await playIt(E, P, "mp3");
    const T = E.talk(P, path_.room);
    if (path_.start) await path_.start(E, T); else { T.btn.fire("pointerdown"); await flush(); }
    assert.equal(E.records[0].state, "recording", name + ": recording");
    assert.ok(close(P.au.volume, 0.16), name + ": LIVE (ducked)");
    assert.equal(P.dbg().micHeld, true);
    path_.end(E, T, P);
    await flush();
    [P.au, P.rau].forEach((x) => assert.equal(x.volume, 0.8, name + ": back to the user's volume"));
    const d = P.dbg();
    assert.equal(d.recording, false, name); assert.equal(d.duckActive, false, name); assert.equal(d.duckOn, true, name + ": the switch itself stays");
    assert.equal(d.micHeld, false, name);
    assert.equal(T.seen.at(-1), false, name + ": onRecording(false)");
    assert.equal(E.stopped(), 1, name + ": the mic track stopped");
    assert.deepEqual(E.writes(), ["playback", "play-and-record", "playback"], name + ": the session handed back once");
    if (path_.idle) assert.match(T.btn.textContent, /Hold to talk/, name + ": the button is idle again");
  });
}

test("a mic that never opened (refused, granted after the press was over) never ducks the room", async () => {
  const E = page({ gum: () => Promise.reject(new Error("NotAllowedError")) }), P = E.player();
  P.p.duck(true); await playIt(E, P, "mp3");
  const T = E.talk(P);
  T.btn.fire("pointerdown"); await flush();
  assert.equal(E.records.length, 0); assert.equal(P.au.volume, 0.8); assert.deepEqual(T.seen, [false]);
  assert.deepEqual(E.writes(), ["playback", "play-and-record", "playback"], "refused: handed back");
  let grant;
  const F = page({ gum: (s) => new Promise((r) => { grant = () => r(s()); }) }), Q = F.player();
  Q.p.duck(true); await playIt(F, Q, "mp3");
  const U = F.talk(Q);
  U.btn.fire("pointerdown"); F.advance(1500); U.btn.fire("pointerup"); grant(); await flush();
  assert.equal(F.records.length, 0, "a hold that was over: no recording"); assert.equal(Q.au.volume, 0.8); assert.deepEqual(U.seen, [false]);
  assert.equal(F.stopped(), 1); assert.equal(Q.dbg().micHeld, false);
});

test("the header comment writes the state machine down", () => {
  const head = SRC.slice(0, SRC.indexOf("(function () {"));
  assert.match(head, /state machine/);
  for (const words of ["page load", "'playback'", "'play-and-record'", "'auto'", "NOT while the page holds a mic", "IDLE (recording false)", "LIVE (recording true)",
    "pointerup", "pointercancel", "the max length", "a recorder error", "visibilitychange", "pagehide", "destroy()", "before the first recording", "userVol / userMuted"]) {
    assert.ok(head.includes(words), "the header names: " + words);
  }
});
