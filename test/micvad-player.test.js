// micvad 1.99akk (public/js/room-bridge.js): real mic bars where the page has no analyser (iPhone) - in a small fake DOM.
//   * MP3 relay: &lv=1 only on an MSE player without an analyser and without reduced motion (never desktop with one, never a
//     plain src); the framed answer's records parsed across 1-byte reads, the MP3 appended byte-exact; the level read at
//     <audio>.currentTime (9 -> bars up, rb-lvl; 0 -> flat bars, rb-lvl); stale past 1 s -> 1.99akf; a header that doesn't
//     match / a dropped append -> no levels for the session; ▶ again (stop) drops it all and aborts the fetch
//   * ⚡: the receiver's audioLevel (getStats every 100 ms) -> digits, the snap-down, given up after 3 polls without a level or
//     with totalSamplesDuration stuck; no polling when the ticket says levels: false, with an analyser, after rtcClose
//   TZ=UTC node --test test/micvad-player.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(repo, "public", "js", "room-bridge.js"), "utf8");
const AL = require(path.join(repo, "audiolv"));

const FRAME = Buffer.concat([Buffer.from("fffb5400", "hex"), Buffer.alloc(188)]);   // MPEG-1 L3 48 kHz 64 kbps: 24 ms
const frames = (n) => Buffer.concat(Array.from({ length: n }, () => FRAME));
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

function fakeEl(tag) {
  const cls = new Set(), on = {};
  const e = {
    tagName: tag, children: [], attrs: {}, style: {}, disabled: false, title: "", textContent: "", paused: true, muted: false, volume: 1,
    currentTime: 0, buffered: { length: 0, start: () => 0, end: () => 0 }, playbackRate: 1,
    classList: {
      add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
      toggle: (c, v) => { const x = v === undefined ? !cls.has(c) : !!v; if (x) cls.add(c); else cls.delete(c); return x; },
    },
    get className() { return [...cls].join(" "); },
    set className(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => cls.add(c)); },
    setAttribute(k, v) { e.attrs[k] = String(v); }, getAttribute(k) { return e.attrs[k] == null ? null : e.attrs[k]; },
    removeAttribute(k) { delete e.attrs[k]; },
    appendChild(c) { e.children.push(c); return c; },
    addEventListener(t, fn) { (on[t] = on[t] || []).push(fn); },
    fire(t) { (on[t] || []).forEach((fn) => fn({ type: t })); },
    pause() { e.paused = true; }, load() {}, play() { e.paused = false; return Promise.resolve(); }, querySelector() { return null; },
  };
  return e;
}
function stream() {
  const q = [], waiting = [];
  let done = false;
  return {
    push(b) { if (waiting.length) waiting.shift()({ done: false, value: new Uint8Array(b) }); else q.push(new Uint8Array(b)); },
    end() { done = true; while (waiting.length) waiting.shift()({ done: true }); },
    reader: { read: () => (q.length ? Promise.resolve({ done: false, value: q.shift() }) : done ? Promise.resolve({ done: true }) : new Promise((r) => waiting.push(r))),
              cancel() { done = true; } },
  };
}
/** The player in a fake page. ua / mse / reduce / audioCtx pick the device; ticket + session drive ⚡. */
function load({ ua = IPHONE, mse = true, reduce = false, audioCtx = false, framed = true, ticket = null, session = null, quota = false } = {}) {
  const clock = { t: 1000000 };
  class FakeDate extends Date { static now() { return clock.t; } }
  const rafs = new Map(), intervals = new Map(), timers = new Map(), ctrls = [], fetches = [], sources = [], appended = [], docOn = {};
  let ids = 0;
  const win = { addEventListener() {} };
  const audioStream = stream();
  win.fetch = async (url, o) => {
    fetches.push(url);
    if (/\/audio\/rtc$/.test(url)) return { json: async () => ticket };
    if (/^\/p\/alpha\/audio\?/.test(url)) {
      return { ok: true, status: 200, body: { getReader: () => audioStream.reader },
        headers: { get: (k) => (framed && /lv=1/.test(url) && k === "X-Audio-Frames" ? "1" : null) } };
    }
    throw new Error("unexpected fetch " + url);
  };
  if (mse) {
    let quotaLeft = quota ? 1 : 0;
    win.MediaSource = class {
      constructor() { this.on = {}; sources.push(this); }
      static isTypeSupported(t) { return t === "audio/mpeg"; }
      addEventListener(t, fn) { this.on[t] = fn; }
      addSourceBuffer() {
        const sb = { updating: false, on: {}, addEventListener(t, fn) { sb.on[t] = fn; }, remove() {},
          appendBuffer(b) {
            if (quotaLeft) { quotaLeft--; const e = new Error("full"); e.name = "QuotaExceededError"; throw e; }
            appended.push(Buffer.from(b)); sb.updating = true;
            Promise.resolve().then(() => { sb.updating = false; if (sb.on.updateend) sb.on.updateend(); });
          } };
        return sb;
      }
    };
  }
  win.URL = { createObjectURL: () => "blob:fake", revokeObjectURL() {} };
  win.AbortController = class { constructor() { this.signal = { aborted: false }; ctrls.push(this); } abort() { this.signal.aborted = true; } };
  if (audioCtx) {
    win.AudioContext = class {
      constructor() { this.state = "running"; this.destination = {}; }
      resume() { return Promise.resolve(); }
      createMediaElementSource() { return { connect() {} }; }
      createMediaStreamSource() { return { connect() {} }; }
      createAnalyser() { return { fftSize: 64, frequencyBinCount: 32, connect() {}, getByteFrequencyData(d) { d.fill(200); } }; }
    };
  }
  if (ticket) win.PATVRtc = { listen: async (url, el) => { el.srcObject = {}; return session; } };
  const mm = () => ({ matches: !!reduce });
  win.matchMedia = mm;
  const doc = { createElement: fakeEl, addEventListener(t, fn) { (docOn[t] = docOn[t] || []).push(fn); }, hidden: false };
  const ctx = { window: win, document: doc, navigator: { userAgent: ua, maxTouchPoints: 0 },
    fetch: win.fetch, URL: win.URL, AbortController: win.AbortController, matchMedia: mm, Date: FakeDate, Math, JSON, Uint8Array, TextDecoder,
    sessionStorage: { getItem: () => null, setItem() {} }, localStorage: { getItem: () => null, setItem() {} },
    setTimeout: (fn, ms) => { const id = ++ids; timers.set(id, { fn, ms }); return id; }, clearTimeout: (id) => { timers.delete(id); },
    setInterval: (fn, ms) => { const id = ++ids; intervals.set(id, { fn, ms }); return id; }, clearInterval: (id) => { intervals.delete(id); },
    requestAnimationFrame: (fn) => { const id = ++ids; rafs.set(id, fn); return id; }, cancelAnimationFrame: (id) => { rafs.delete(id); }, console };
  win.document = ctx.document;
  vm.runInNewContext(SRC, ctx);
  const host = fakeEl("div");
  const p = win.PATVRoom.audio(host, "alpha", { showOff: true });
  p.update({ room: { audio: true, live: true, rtc: !!ticket } });
  const box = host.children[0];
  const kid = (c) => box.children.find((x) => x.className.split(" ").includes(c));
  const audios = box.children.filter((c) => c.tagName === "audio");
  const meter = kid("rb-meter");
  return {
    p, box, meter, bars: meter.children, au: audios[0], rau: audios[1], clock, rafs, intervals, timers, ctrls, fetches, sources, appended, audioStream, win, doc,
    // the meter's next wake: an analyser's animation frame, or (micvad review fix) the level path's timer
    frame() {
      const fns = [...rafs.values()]; rafs.clear();
      for (const [id, t] of [...timers]) if (t.fn.name === "meterLoop") { timers.delete(id); fns.push(t.fn); }
      fns.forEach((fn) => fn());
    },
    meterTimers() { return [...timers.values()].filter((t) => t.fn.name === "meterLoop"); },
    docFire(t) { (docOn[t] || []).forEach((fn) => fn({ type: t })); },
    heights() { return meter.children.map((b) => b.style.height || ""); },
    polls() { return [...intervals.values()].filter((x) => x.ms === 100); },
    LV: win.PATVRoom._lv,
  };
}
const tick = () => new Promise((r) => setImmediate(r));
async function settle(n = 10) { for (let i = 0; i < n; i++) await tick(); }
async function playMp3(P) {
  P.p.listen("alpha");                        // ▶
  await settle();
  P.sources[0].on.sourceopen();               // MSE opens -> the fetch
  await settle();
}
const lvl = (P) => P.meter.classList.contains("rb-lvl");
const H = (P, v, k) => Array.from(P.LV.heights(v, k), (h) => h + "px");

test("&lv=1 only where it can be used: an MSE player with no analyser and no reduced motion", async () => {
  const ios = load();
  await playMp3(ios);
  assert.match(ios.fetches[0], /^\/p\/alpha\/audio\?t=\d+&lv=1$/, "iPhone + MSE asks for the levels");
  const desk = load({ ua: WINDOWS, audioCtx: true });
  await playMp3(desk);
  assert.doesNotMatch(desk.fetches[0], /lv=1/, "desktop with its analyser: never");
  const calm = load({ reduce: true });
  await playMp3(calm);
  assert.doesNotMatch(calm.fetches[0], /lv=1/, "reduced motion: never (the still eq shape stays)");
  const plain = load({ mse: false });
  plain.p.listen("alpha");
  await settle();
  assert.equal(plain.fetches.length, 0);
  assert.match(String(plain.au.src), /^\/p\/alpha\/audio\?t=\d+$/, "a plain src never gets lv=1 (it can't read records)");
  // desktop: the analyser drives the bars, as before (from the cushioned play())
  desk.au.buffered = { length: 1, start: () => 0, end: () => 1 };
  [...desk.intervals.values()].filter((x) => x.ms === 250).forEach((x) => x.fn());
  await settle();
  desk.au.fire("playing");
  desk.frame();
  assert.equal(desk.meter.getAttribute("data-lv"), "an");
  assert.ok(lvl(desk));
});

test("records across 1-byte reads: the MP3 appended byte-exact; the level at currentTime draws the bars", async () => {
  const P = load();
  await playMp3(P);
  // asked for levels: flat bars while it buffers (no animated flash) - but no rb-lvl until a real level (review fix: a meter the
  // Dock hides - iPhone, nobody on the mic - stays hidden instead of showing flat dots that vanish if no levels come)
  assert.equal(lvl(P), false);
  assert.deepEqual(P.heights(), ["", "", "", "", ""].map(() => "2px"));
  assert.ok(P.bars.every((b) => b.style.animation === "none" && b.style.transform === "none"), "the Dock's animated bars held flat");
  const mp3a = frames(10), mp3b = frames(10);
  const wire = Buffer.concat([AL.rec(1, mp3a), AL.rec(2, { h: 0, a: 0, d: "9900" }), AL.rec(7, Buffer.from("future")),
    AL.rec(1, mp3b), AL.rec(2, { h: 0, a: 0, d: "05" })]);
  for (const b of wire) { P.audioStream.push([b]); await tick(); }
  await settle();
  assert.deepEqual(Buffer.concat(P.appended), Buffer.concat([mp3a, mp3b]), "the MP3 payloads only, in order (an unknown record skipped)");
  P.au.fire("playing");
  P.au.currentTime = 0.05;
  P.frame();
  assert.equal(P.meter.getAttribute("data-lv"), "lv");
  assert.ok(lvl(P));
  assert.deepEqual(P.heights(), H(P, 9, 0));
  assert.ok(P.heights().every((h) => parseInt(h, 10) > 2), "digit 9: the bars are up");
  P.au.currentTime = 0.25;
  P.frame();
  assert.ok(lvl(P)); assert.deepEqual(P.heights(), ["2px", "2px", "2px", "2px", "2px"], "digit 0: flat, still a real level");
  P.au.currentTime = 0.24 + 0.15;                     // 2nd post: its levels start at its own header (0.24 s)
  P.frame();
  assert.deepEqual(P.heights(), H(P, 5, Math.round(2.4) + 1), "the second post's 2nd digit (5)");
  // past every level: rest for up to 1 s of PLAYED audio (review fix: media time - a stall never falls back), then 1.99akf's bars
  P.au.currentTime = 0.9;
  P.clock.t += 500; P.frame();
  assert.ok(lvl(P), "a moment without a level: flat bars");
  assert.deepEqual(P.heights(), ["2px", "2px", "2px", "2px", "2px"]);
  P.au.currentTime = 1.5;
  P.clock.t += 600; P.frame();
  assert.equal(lvl(P), false, "stale > 1 s of audio: rb-lvl off (1.99akf's bars)");
  assert.deepEqual(P.heights(), ["", "", "", "", ""]);
  assert.equal(P.meter.getAttribute("data-lv"), "");
  assert.equal(P.meterTimers().length + P.rafs.size, 0, "nothing coming: parked (no wake-ups) until a level record arrives");
  P.audioStream.push(Buffer.concat([AL.rec(1, frames(100)), AL.rec(2, { h: 0, a: 0, d: "f".repeat(30) })]));
  await settle();
  P.au.currentTime = 0.48 + 1;
  P.frame();
  assert.ok(lvl(P), "back when they resume");
  assert.equal(P.box.rbDebug().lv.framed, true);
  assert.equal(P.box.rbDebug().lv.recs, 3);
  // ▶ again = stop: the fetch is aborted, the bars and the ring go
  P.p.listen("alpha");
  assert.equal(P.ctrls[0].signal.aborted, true);
  assert.equal(lvl(P), false);
  assert.deepEqual(P.heights(), ["", "", "", "", ""]);
  assert.equal(P.box.rbDebug().lv.framed, false);
  assert.equal(P.rafs.size + P.meterTimers().length, 0, "no loop while paused");
});

test("a level record that doesn't match the frames counted (or a dropped append) = no levels for the session", async () => {
  const P = load();
  await playMp3(P);
  P.audioStream.push(Buffer.concat([AL.rec(1, Buffer.concat([FRAME.subarray(100), frames(5)])), AL.rec(2, { h: 0, a: 0, d: "99" })]));
  await settle();
  P.au.fire("playing"); P.frame();
  assert.equal(P.box.rbDebug().lv.bad, true, "the record says h 0, the walk found no header there");
  assert.equal(lvl(P), false);
  assert.equal(P.rafs.size + P.meterTimers().length, 0, "the loop stops: 1.99akf's bars");
  assert.ok(P.appended.length, "the audio itself still plays");
  const Q = load({ quota: true });
  await playMp3(Q);
  Q.audioStream.push(Buffer.concat([AL.rec(1, frames(5)), AL.rec(2, { h: 0, a: 0, d: "99" })]));
  await settle();
  Q.audioStream.push(AL.rec(1, frames(5)));
  await settle();
  assert.equal(Q.box.rbDebug().lv.bad, true, "QuotaExceededError dropped frames: the count can't be trusted");
  const R = load();
  await playMp3(R);
  R.audioStream.push(Buffer.from([1, 0x7f, 0xff, 0xff]));   // a 8 MB record: not ours
  await settle();
  assert.equal(R.box.rbDebug().lv.bad, true);
  const plainAnswer = load({ framed: false });              // an old site / the setting off: plain MP3 to ?lv=1
  await playMp3(plainAnswer);
  plainAnswer.audioStream.push(frames(3));
  await settle();
  assert.deepEqual(Buffer.concat(plainAnswer.appended), frames(3));
  plainAnswer.au.fire("playing"); plainAnswer.frame();
  assert.equal(lvl(plainAnswer), false);
  assert.equal(plainAnswer.box.rbDebug().lv.framed, false);
});

test("the pure pieces: header table, the walk across split headers, fromPeak with its snap-down, digitAt", () => {
  const P = load();
  const L = P.LV;
  assert.deepEqual({ ...L.header([0xff, 0xfb, 0x54, 0x00]) }, { size: 192, spf: 1152, rate: 48000 });
  assert.equal(L.header([0xff, 0xfb, 0x04, 0x00]), null, "free format");
  assert.deepEqual({ ...L.header([0xff, 0xf3, 0x88, 0x00]) }, { size: 288, spf: 576, rate: 16000 }, "MPEG-2 64 kbps 16 kHz");
  const s = L.session();
  const all = frames(3);
  L.walk(s, all.subarray(0, 193)); assert.equal(s.first, 0);
  L.walk(s, all.subarray(193, 195)); assert.equal(s.first, null, "a header's middle: none starts here");
  L.walk(s, all.subarray(195)); assert.equal(s.first, 189); assert.ok(Math.abs(s.tFirst - 0.048) < 1e-9);
  assert.equal(s.bad, false); assert.ok(Math.abs(s.T - 0.072) < 1e-9);
  assert.equal(L.fromPeak(0), 0); assert.equal(L.fromPeak(0.005), 0);
  assert.equal(L.fromPeak(1), 15); assert.equal(L.fromPeak(0.5), 13); assert.equal(L.fromPeak(0.01), 1);
  assert.equal(L.fromPeak(0.12, 0.5), 0, "a third or less of the last: silence at once");
  assert.equal(L.fromPeak(0.2, 0.5), 10);
  assert.deepEqual({ ...L.digitAt([{ g: 1, d: "0a" }], 1.15) }, { v: 10, k: 11, end: 1.2 });
  assert.equal(L.digitAt([{ g: 1, d: "0a" }], 1.2), null);
  assert.equal(L.digitAt([{ g: 1, d: "0a" }], 0.99), null);
  assert.deepEqual(Array.from(L.heights(0, 3)), [2, 2, 2, 2, 2]);
  assert.ok([...L.heights(15, 3)].every((h) => h >= 3 && h <= 14));
});

function report(level, tsd) {
  const rows = [{ type: "inbound-rtp", kind: "audio", ...(level === undefined ? {} : { audioLevel: level }), ...(tsd === undefined ? {} : { totalSamplesDuration: tsd }) }];
  return { forEach: (fn) => rows.forEach(fn) };
}
function rtcSession(reports) {
  const q = reports.slice();
  const s = { closed: false, calls: 0, close() { this.closed = true; }, onfail: null,
    pc: { getStats: () => { s.calls++; return Promise.resolve(q.length ? q.shift() : report(undefined)); } } };
  return s;
}
async function playRtc(P) {
  P.p.listen("alpha");
  await settle(20);
  P.rau.fire("playing");
}
async function poll(P) { P.polls()[0].fn(); await settle(); }

test("⚡ without an analyser: the receiver's audioLevel -> the bars, the snap-down, fresh for 400 ms", async () => {
  const sess = rtcSession([report(0.5, 1), report(0.12, 1.1), report(0.03, 1.2), report(0.3, 1.3)]);
  const P = load({ ticket: { ok: true, whep: "x", ready: true, levels: true }, session: sess });
  await playRtc(P);
  assert.equal(P.polls().length, 1, "polling every 100 ms");
  await poll(P); P.frame();
  assert.equal(P.meter.getAttribute("data-lv"), "st");
  assert.ok(lvl(P));
  assert.deepEqual(P.heights(), H(P, 13, 1));
  await poll(P); P.frame();
  assert.deepEqual(P.heights(), ["2px", "2px", "2px", "2px", "2px"], "0.12 after 0.5: snapped to silence");
  await poll(P); P.frame();
  assert.deepEqual(P.heights(), ["2px", "2px", "2px", "2px", "2px"]);
  await poll(P); P.frame();
  assert.deepEqual(P.heights(), H(P, 11, 4), "a rise: the level again");
  P.clock.t += 500; P.frame();
  assert.ok(lvl(P)); assert.deepEqual(P.heights(), ["2px", "2px", "2px", "2px", "2px"], "no fresh poll: flat for a moment");
  P.clock.t += 600; P.frame();
  assert.equal(lvl(P), false, "stale: 1.99akf's bars");
});

test("⚡: no audioLevel, or totalSamplesDuration stuck, 3 polls running -> given up for the session", async () => {
  const none = load({ ticket: { ok: true, whep: "x", levels: true }, session: rtcSession([report(undefined), report(undefined), report(undefined)]) });
  await playRtc(none);
  await poll(none); await poll(none);
  assert.equal(none.polls().length, 1);
  await poll(none);
  assert.equal(none.polls().length, 0, "given up");
  none.frame();
  assert.equal(lvl(none), false); assert.equal(none.rafs.size + none.meterTimers().length, 0);
  const stuck = load({ ticket: { ok: true, whep: "x", levels: true }, session: rtcSession([report(0.4, 5), report(0.4, 5), report(0.4, 5), report(0.4, 5)]) });
  await playRtc(stuck);
  await poll(stuck); await poll(stuck); await poll(stuck);
  assert.equal(stuck.polls().length, 1);
  await poll(stuck);
  assert.equal(stuck.polls().length, 0, "stuck playout: given up");
});

test("⚡: no polling when the ticket says levels: false, with an analyser, or after rtcClose", async () => {
  const off = load({ ticket: { ok: true, whep: "x", levels: false }, session: rtcSession([]) });
  await playRtc(off);
  assert.equal(off.polls().length, 0, "the setting is off");
  const desk = load({ ua: WINDOWS, audioCtx: true, ticket: { ok: true, whep: "x", levels: true }, session: rtcSession([]) });
  await playRtc(desk);
  assert.equal(desk.polls().length, 0, "an analyser measures it");
  desk.frame();
  assert.equal(desk.meter.getAttribute("data-lv"), "an");
  const sess = rtcSession([report(0.5, 1)]);
  const lost = load({ ticket: { ok: true, whep: "x", levels: true }, session: sess });
  await playRtc(lost);
  assert.equal(lost.polls().length, 1);
  sess.onfail();                                    // the ⚡ session is lost: the MP3 relay takes over
  await settle();
  assert.equal(lost.polls().length, 0, "rtcClose stopped the polling");
  const calm = load({ reduce: true, ticket: { ok: true, whep: "x", levels: true }, session: rtcSession([]) });
  await playRtc(calm);
  assert.equal(calm.polls().length, 0, "reduced motion: never");
  const stopped = load({ ticket: { ok: true, whep: "x", levels: true }, session: rtcSession([]) });
  await playRtc(stopped);
  stopped.p.listen("alpha");                        // pause
  assert.equal(stopped.polls().length, 0, "paused: no polling");
});

// -- micvad review fixes --
test("a new encoder mid-session (Pepe restarted, the bitrate changed): the walk finds its way back as a decoder does", async () => {
  // the old stream's last post ends mid-frame (every post does); the new stream starts on its own first header. A decoder (Chromium's
  // MP3 parser) lets the cut-short frame swallow the new stream's first bytes, finds the next header 3 frames confirm and plays on
  // at the media time it had - the new stream's frame 1 is lost. The page counts the same and pins the levels from there.
  const tail = Buffer.concat([frames(10), FRAME.subarray(0, 100)]);          // 10 frames + one cut short (11 counted = 0.264 s)
  const wire = Buffer.concat([AL.rec(1, tail), AL.rec(2, { h: 0, a: 0, d: "99" }), AL.rec(1, frames(20)), AL.rec(2, { h: 0, a: 0, d: "5555" })]);
  const P = load();
  const S = P.LV.session();
  for (const b of wire) P.LV.feed(S, new Uint8Array([b]), () => {});
  assert.equal(S.bad, false, "not given up");
  assert.equal(S.ring.length, 2);
  assert.ok(Math.abs(S.ring[1].g - (0.264 - 0.024)) < 1e-9, `the new stream's levels from its (lost) first frame: ${S.ring[1].g}`);
  assert.ok(Math.abs(S.T - (0.264 + 19 * 0.024)) < 1e-9, "its frames 2..20 counted from 0.264 s");
  await playMp3(P);
  P.audioStream.push(wire);
  await settle();
  P.au.fire("playing"); P.au.currentTime = 0.30; P.frame();
  assert.equal(P.box.rbDebug().lv.bad, false);
  assert.ok(lvl(P)); assert.deepEqual(P.heights(), H(P, 5, 2), "the new stream's level at 0.30 s");
  // a stream that never finds its way back (no header chain where its level record says): given up, as before
  const Q = P.LV.session();
  P.LV.feed(Q, new Uint8Array(Buffer.concat([AL.rec(1, tail), AL.rec(2, { h: 0, a: 0, d: "99" }), AL.rec(1, Buffer.alloc(400, 7)), AL.rec(2, { h: 0, a: 0, d: "5" })])), () => {});
  assert.equal(Q.bad, true);
});

test("the level path's loop: a timer at the level frames' edges (no per-frame work), parked while nothing is coming", async () => {
  const P = load();
  await playMp3(P);
  P.audioStream.push(Buffer.concat([AL.rec(1, frames(50)), AL.rec(2, { h: 0, a: 0, d: "9".repeat(12) })]));   // 1.2 s of levels
  await settle();
  P.au.fire("playing");
  P.au.currentTime = 0.05; P.frame();
  assert.ok(lvl(P));
  assert.equal(P.rafs.size, 0, "no animation frames for Pepe's levels");
  assert.deepEqual(P.meterTimers().map((t) => t.ms), [52], "the next wake: this level frame's end (0.1 s) + 2 ms");
  P.au.currentTime = 3; P.frame();
  assert.equal(lvl(P), false, "levels stopped (> 1 s of audio past them): 1.99akf's bars");
  assert.equal(P.meterTimers().length, 0, "parked");
  // a level record pinned ahead of the playhead wakes it, for exactly when it starts
  P.audioStream.push(Buffer.concat([AL.rec(1, frames(200)), AL.rec(2, { h: 0, a: 2000, d: "9999" })]));     // g = 1.2 + 2 = 3.2 s
  await settle();
  assert.deepEqual(P.meterTimers().map((t) => t.ms), [202], "woken for the level at 3.2 s");
  P.au.currentTime = 3.25; P.frame();
  assert.ok(lvl(P)); assert.deepEqual(P.heights(), H(P, 9, 32));
});

test("a stall stops the audio's clock: the bars rest (flat, rb-lvl) however long it lasts; 1.99akf's only after 1 s of PLAYED audio", async () => {
  const P = load();
  await playMp3(P);
  P.audioStream.push(Buffer.concat([AL.rec(1, frames(50)), AL.rec(2, { h: 0, a: 0, d: "9".repeat(12) })]));
  await settle();
  P.au.fire("playing"); P.au.currentTime = 1.15; P.frame();
  assert.ok(lvl(P));
  P.au.fire("waiting");                           // buffering
  P.clock.t += 10000; P.frame();
  assert.ok(lvl(P), "10 s of buffering: still the real meter, flat"); assert.deepEqual(P.heights(), ["2px", "2px", "2px", "2px", "2px"]);
  P.au.fire("playing"); P.au.currentTime = 1.5;   // (a stall the browser never announced looks the same: the clock doesn't move)
  P.clock.t += 10000; P.frame();
  assert.ok(lvl(P), "the playhead only 0.35 s past the last level: rest");
  P.au.currentTime = 2.2; P.frame();
  assert.equal(lvl(P), false, "1.05 s of played audio without a level: 1.99akf's bars");
  // never a level at all (an old Pepe on a new site): quiet (no rb-lvl) for the first 1.5 s of audio, then 1.99akf's
  const Q = load();
  await playMp3(Q);
  Q.audioStream.push(AL.rec(1, frames(100)));
  await settle();
  Q.au.fire("playing"); Q.au.currentTime = 0.2; Q.frame();
  assert.equal(lvl(Q), false); assert.deepEqual(Q.heights(), ["2px", "2px", "2px", "2px", "2px"], "quiet: flat, no rb-lvl");
  Q.au.currentTime = 1.8; Q.frame();
  assert.equal(lvl(Q), false); assert.deepEqual(Q.heights(), ["", "", "", "", ""], "then 1.99akf's bars (no inline heights)");
  assert.ok(Q.bars.every((b) => !b.style.animation && !b.style.transform), "the Dock's animation is theirs again");
});

test("⚡ in a hidden page: no getStats and no drawing; shown again, it rests until the next poll (no 1.99akf flash)", async () => {
  // (hidden = the document the player shows in: the Dock's own window has its own - box.ownerDocument, else the page's)
  const sess = rtcSession([report(0.5, 1), report(0.5, 1.1), report(0.5, 1.2), report(0.5, 1.3)]);
  const P = load({ ticket: { ok: true, whep: "x", ready: true, levels: true }, session: sess });
  await playRtc(P);
  await poll(P);
  assert.ok(lvl(P)); assert.equal(sess.calls, 1);
  P.doc.hidden = true;
  for (let i = 0; i < 5; i++) await poll(P);
  assert.equal(sess.calls, 1, "hidden: no getStats");
  assert.equal(P.polls().length, 1, "(the poll isn't given up)");
  P.clock.t += 5000; P.frame();
  assert.deepEqual(P.meterTimers().map((t) => t.ms), [1000], "hidden: the bars' loop only looks once a second");
  P.doc.hidden = false;
  P.frame();
  assert.ok(lvl(P), "shown again: the real meter, resting"); assert.deepEqual(P.heights(), ["2px", "2px", "2px", "2px", "2px"]);
  await poll(P);
  assert.equal(sess.calls, 2); assert.deepEqual(P.heights(), H(P, 13, 2), "the next poll's level");
});
