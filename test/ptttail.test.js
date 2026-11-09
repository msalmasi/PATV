"use strict";
// relaymic 1.99?? (owner 2026-11-08: "It seems like Pepe cuts out the last word or so of web relay mic ups if the speaker doesn't leave
// a gap before hitting button to end the mic up"). The diagnosis found the end lost on the PAGE: the recorder stopped in the very
// handler that ended the press (room-bridge.js up() -> stop() -> rec.stop() + the mic tracks), so whatever was said as the finger
// lifted was never recorded - Chrome's Opus encoder drops its last partial frame on top (30-60 ms, measured in Chromium 156 with the
// real page). Pepe's playback cuts nothing (his transcript of the exact WAV already ends early).
// The fix is a release tail, like Discord's "release delay": letting go (or the tap / Enter that sends) keeps the recorder running
// room.pttTail ms more (pttlimits tail_ms: /admin/bridge "Push-to-talk clips", 0-1000 ms, 400 by default); the button says
// "Sending…" at once and a press meanwhile is ignored; the recorder then stops and its onstop lets the mic go and uploads. The
// max-length timer, a hidden / closed page, the room's mic switched off and destroy() still stop at once. On iOS the release stays
// inside the gesture unless room.pttTailIos (tail_ios, off by default) - the room player only resumes from a gesture there, and
// play-and-record holds while any track is live. Hold to talk captures its pointer (a mouse sliding off the 40 px dock button fired
// pointerleave and ended the clip mid-word).
//   node --test test/ptttail.test.js
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), vm = require("vm");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "ptttail-test-")));     // (pttlimits -> dbUtils opens ./myapp.db)
const { Event, Document } = require("./fixtures/pad-dock/dom.cjs");
const repo = path.resolve(__dirname, "..");
const read = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8").replace(/\r\n/g, "\n");
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1";

// room-bridge.js in a deterministic page: a recorder that behaves like a browser's (stop() returns at once, the last data and onstop
// come a task later), mic tracks that log their stop, a clock and timers the test runs by hand, uploads captured
function rig(o = {}) {
  const doc = new Document(), clock = { t: 1000000 }, timers = [], fetches = [], log = [], recs = [];
  class Win {
    constructor() { this.l = {}; }
    addEventListener(t, f) { (this.l[t] = this.l[t] || []).push(f); }
    removeEventListener(t, f) { this.l[t] = (this.l[t] || []).filter((x) => x !== f); }
    dispatchEvent() { return true; }
    fire(t) { (this.l[t] || []).slice().forEach((f) => f(new Event(t))); }
  }
  const win = new Win();
  win.document = doc; doc.defaultView = win;
  class FakeDate extends Date { static now() { return clock.t; } }
  win.MediaRecorder = class {
    constructor(s) { this.stream = s; this.state = "inactive"; this.mimeType = "audio/webm"; recs.push(this); }
    static isTypeSupported(t) { return t === "audio/webm"; }
    start() { this.state = "recording"; log.push("rec.start"); }
    stop() {
      if (this.state !== "recording") throw new Error("InvalidStateError");
      this.state = "inactive"; log.push("rec.stop");
      setImmediate(() => { log.push("onstop"); if (this.ondataavailable) this.ondataavailable({ data: { size: 9 } }); if (this.onstop) this.onstop(); });
    }
  };
  let gum = 0;
  const ctx = {
    window: win, document: doc, console,
    navigator: { userAgent: o.ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0 Safari/537.36",
      platform: o.platform || "Win32", maxTouchPoints: o.touch || 0,
      mediaDevices: { getUserMedia: () => { gum++; return Promise.resolve({ getTracks: () => [{ stop() { log.push("track.stop"); } }] }); } } },
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, set: clock.t }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    setInterval: () => 0, clearInterval: () => {}, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    fetch: (url, init) => { fetches.push({ url, init }); return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ ok: true, id: "j1" }) }); },
    Blob: class { constructor(p, b) { this.type = b.type; } },
    CustomEvent: Event, Date: FakeDate, JSON, Math, Number, String, Object, Array, Promise, isFinite, Uint8Array,
  };
  win.fetch = ctx.fetch; ctx.MediaRecorder = win.MediaRecorder;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(repo, "public", "js", "room-bridge.js"), "utf8"), ctx);
  const host = doc.createElement("div"); doc.body.appendChild(host);
  const p = win.PATVRoom.ptt(host, "pepes-pad");
  const room = Object.assign({ micRelay: true, pttMax: 30 }, o.room || {});
  p.update({ room, mine: [] });
  const btn = host.querySelector(".rb-talk");
  const captures = [];
  btn.setPointerCapture = o.captureThrows ? () => { throw new Error("NotFoundError"); } : (id) => captures.push(id);
  const live = () => timers.filter((t) => !t.cleared && !t.ran);
  const r = {
    p, win, doc, btn, host, clock, timers, fetches, log, recs, captures, room, gum: () => gum,
    rec: () => recs[recs.length - 1],
    down: async (id = 7) => { btn.dispatchEvent(new Event("pointerdown", { pointerId: id, pointerType: "mouse" })); await flush(); },
    up: (id = 7) => { btn.dispatchEvent(new Event("pointerup", { pointerId: id, pointerType: "mouse" })); },
    key: async () => { btn.dispatchEvent(new Event("keydown", { key: "Enter" })); await flush(); },
    live,
    // the timer set for `ms` that hasn't run (the release tail is the one set after the recorder started)
    timer: (ms) => live().filter((t) => t.ms === ms).pop() || null,
    run: (t) => { t.ran = true; r.clock.t = Math.max(r.clock.t, t.set + t.ms); t.fn(); },
  };
  return r;
}
// hold the button for `secs`, then let go
async function hold(r, secs) { await r.down(); assert.equal(r.rec().state, "recording", "recording"); r.clock.t += secs * 1000; r.up(); }

test("ptttail: letting go keeps the recorder running PTT tail ms - Sending… at once, the mic open until the tail ends; onstop lets it go and uploads", async () => {
  const r = rig({ room: { pttTail: 400 } });
  await hold(r, 3);
  assert.equal(r.rec().state, "recording", "still recording right after the release - the word said as the finger lifts is in the clip");
  assert.ok(!r.log.includes("rec.stop") && !r.log.includes("track.stop"), "nothing stopped yet: " + r.log.join(", "));
  assert.equal(r.btn.textContent, "🎙 Sending…", "the button says it is sending at once");
  assert.equal(r.btn.getAttribute("aria-pressed"), "false");
  const t = r.timer(400);
  assert.ok(t, "the tail: one 400 ms timer - " + JSON.stringify(r.live().map((x) => x.ms)));
  assert.equal(r.fetches.length, 0, "not uploaded during the tail");
  r.run(t);
  assert.deepEqual(r.log.slice(-1), ["rec.stop"], "after the tail: the recorder stops - " + r.log.join(", "));
  assert.ok(!r.log.includes("track.stop"), "the mic tracks stop in onstop, not before it");
  assert.ok(!r.timer(29500), "the max-length timer is cleared with it");
  await flush();
  const tail = r.log.slice(r.log.indexOf("rec.stop"));
  assert.deepEqual(tail, ["rec.stop", "onstop", "track.stop"], "rec.stop -> onstop -> the mic released: " + r.log.join(", "));
  assert.equal(r.fetches.length, 1, "uploaded once");
  assert.equal(r.fetches[0].init.headers["x-clip-secs"], "3.4", "x-clip-secs is the wall time to onstop, the tail included");
  assert.equal(r.btn.textContent, "🎙 Hold to talk", "idle again");
  // the same for the tap that sends (a quick tap starts tap mode; the next tap / Enter sends)
  const k = rig({ room: { pttTail: 400 } });
  await k.key();
  assert.equal(k.rec().state, "recording");
  k.clock.t += 2000;
  await k.key();
  assert.equal(k.rec().state, "recording", "the tap that sends gets the tail too");
  assert.equal(k.btn.textContent, "🎙 Sending…");
  k.run(k.timer(400));
  await flush();
  assert.equal(k.fetches.length, 1);
  assert.equal(k.fetches[0].init.headers["x-clip-secs"], "2.4");
  // the en.json string = the page's default
  assert.equal(JSON.parse(read("locales", "en.json"))["js.pad.ptt.rec_sending"], "🎙 Sending…");
});

test("ptttail: 'too short' is still about the press - a quick double tap isn't sent because the tail made it longer; x-clip-secs keeps the tail", async () => {
  // a 300 ms tap + tap: 0.7 s of wall time with the tail, but the person held it 0.3 s - too short, never uploaded (as before the tail)
  let r = rig({ room: { pttTail: 400 } });
  await r.key();
  r.clock.t += 300;
  await r.key();
  const t = r.timer(400);
  assert.ok(t, "the tap that sends gets the tail");
  r.run(t);
  await flush();
  assert.equal(r.fetches.length, 0, "too short: never sent");
  assert.equal(r.host.querySelector(".rb-ptt-txt").textContent, "too short — hold the button while you talk");
  // 0.8 s pressed + the tail: sent, its length the wall time (1.2 s)
  r = rig({ room: { pttTail: 400 } });
  await r.key();
  r.clock.t += 800;
  await r.key();
  r.run(r.timer(400));
  await flush();
  assert.equal(r.fetches.length, 1, "0.8 s pressed: sent");
  assert.equal(r.fetches[0].init.headers["x-clip-secs"], "1.2");
});

test("ptttail: the max-length timer, pagehide, a hidden page, the mic switched off and destroy() stop at once - also during a tail", async () => {
  // the max-length timer (0.5 s before the max, so Pepe's +0.5 s check still holds): no tail
  let r = rig({ room: { pttTail: 400 } });
  await r.down();
  const max = r.timer(29500);
  assert.ok(max, "the max-length timer");
  r.clock.t += 29500; r.run(max);
  assert.deepEqual(r.log.slice(-2), ["rec.stop", "track.stop"], "stopped and released at once: " + r.log.join(", "));
  assert.ok(!r.timer(400), "no tail after the max");
  await flush();
  assert.equal(r.fetches.length, 1);
  assert.equal(r.fetches[0].init.headers["x-clip-secs"], "29.5");
  // pagehide (the Dock pops in / the tab closes)
  r = rig({ room: { pttTail: 400 } });
  await r.down();
  r.win.fire("pagehide");
  assert.deepEqual(r.log.slice(-2), ["rec.stop", "track.stop"], "pagehide: at once - " + r.log.join(", "));
  // the page hidden
  r = rig({ room: { pttTail: 400 } });
  await r.down();
  r.doc.hidden = true; r.doc.dispatchEvent(new Event("visibilitychange"));
  assert.deepEqual(r.log.slice(-2), ["rec.stop", "track.stop"], "hidden: at once - " + r.log.join(", "));
  // ...and each of them during a tail: the tail is cut short, the clip still goes
  for (const how of ["pagehide", "hidden", "max", "micoff"]) {
    r = rig({ room: { pttTail: 400 } });
    await hold(r, 4);
    const t = r.timer(400);
    assert.ok(t, how + ": a tail");
    if (how === "pagehide") r.win.fire("pagehide");
    else if (how === "hidden") { r.doc.hidden = true; r.doc.dispatchEvent(new Event("visibilitychange")); }
    else if (how === "max") { const m = r.timer(29500); m.ran = true; m.fn(); }
    else r.p.update({ room: { micRelay: false }, mine: [] });
    assert.deepEqual(r.log.slice(-2), ["rec.stop", "track.stop"], how + " during the tail: at once - " + r.log.join(", "));
    assert.ok(t.cleared, how + ": the tail timer is cleared");
    await flush();
    assert.equal(r.fetches.length, 1, how + ": the clip so far is still sent");
    assert.equal(r.btn.textContent, "🎙 Hold to talk");
  }
  // destroy() (the chat window wiping itself) during a tail: at once, and never uploaded
  r = rig({ room: { pttTail: 400 } });
  await hold(r, 4);
  const t = r.timer(400);
  r.p.destroy();
  assert.deepEqual(r.log.slice(-2), ["rec.stop", "track.stop"], "destroy: at once");
  assert.ok(t.cleared);
  await flush();
  assert.equal(r.fetches.length, 0, "a destroyed recorder never uploads");
});

test("ptttail: iOS keeps the release inside the gesture by default (tail_ios off); room.pttTailIos turns the tail on there", async () => {
  for (const o of [{ ua: IPHONE }, { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.1 Safari/605.1.15", platform: "MacIntel", touch: 5 }]) {
    const r = rig(Object.assign({ room: { pttTail: 400 } }, o));
    assert.equal(r.win.PATVRoom._ios, true, "an iOS page (" + o.ua.slice(13, 30) + ")");
    await hold(r, 3);
    assert.deepEqual(r.log.slice(-2), ["rec.stop", "track.stop"], "iOS: stopped and released in the pointerup itself - " + r.log.join(", "));
    assert.ok(!r.timer(400), "no tail on iOS by default");
    await flush();
    assert.equal(r.fetches.length, 1);
    assert.equal(r.fetches[0].init.headers["x-clip-secs"], "3.0");
  }
  const r = rig({ ua: IPHONE, room: { pttTail: 400, pttTailIos: true } });
  await hold(r, 3);
  assert.equal(r.rec().state, "recording", "tail_ios on: the tail on iOS too");
  assert.equal(r.btn.textContent, "🎙 Sending…");
  r.run(r.timer(400));
  await flush();
  assert.deepEqual(r.log.slice(-3), ["rec.stop", "onstop", "track.stop"]);
  assert.equal(r.fetches[0].init.headers["x-clip-secs"], "3.4");
  // only a real true turns it on
  const s = rig({ ua: IPHONE, room: { pttTail: 400, pttTailIos: "yes" } });
  await hold(s, 3);
  assert.ok(!s.timer(400), "pttTailIos must be true");
});

test("ptttail: a press during the tail is ignored - no second recording, the tail isn't cut short, the next press after it works", async () => {
  const r = rig({ room: { pttTail: 400 } });
  await hold(r, 3);
  const t = r.timer(400), gum = r.gum();
  await r.down(8);
  assert.equal(r.gum(), gum, "the press during the tail opens no microphone");
  r.clock.t += 50; r.up(8);
  assert.ok(!r.log.includes("rec.stop"), "its release doesn't stop the clip early: " + r.log.join(", "));
  assert.ok(!t.cleared, "the tail runs on");
  await r.key();
  assert.equal(r.gum(), gum, "Enter during the tail is ignored too");
  assert.ok(!r.log.includes("rec.stop"));
  assert.equal(r.btn.textContent, "🎙 Sending…");
  assert.deepEqual(r.captures, [7], "the ignored press doesn't capture the pointer");
  r.run(t);
  await flush();
  assert.equal(r.fetches.length, 1, "one clip");
  assert.equal(r.recs.length, 1, "one recorder");
  await r.down(9);
  assert.equal(r.gum(), gum + 1, "after the tail, a press records again");
  assert.equal(r.rec().state, "recording");
});

test("ptttail: Hold to talk captures its pointer (a mouse sliding off the 40 px dock button no longer ends the clip); one it can't capture still records", async () => {
  const r = rig({ room: { pttTail: 400 } });
  await r.down(7);
  assert.deepEqual(r.captures, [7], "setPointerCapture(e.pointerId) on pointerdown");
  assert.equal(r.rec().state, "recording");
  const x = rig({ room: { pttTail: 400 }, captureThrows: true });
  await x.down(7);
  assert.equal(x.rec().state, "recording", "a synthetic pointer the browser can't capture: recorded as before");
  // the source: the capture is on the press, the pointerleave fallback stays (a browser without pointer capture)
  const src = read("public", "js", "room-bridge.js");
  assert.match(src, /btn\.setPointerCapture\(e\.pointerId\)/);
  assert.match(src, /btn\.addEventListener\('pointerleave', up\)/);
});

test("ptttail: the tail is the live view's room.pttTail - 0, missing or bad = the release as before; at most 1000 ms; a new view changes it at once", async () => {
  for (const v of [0, undefined, null, "abc", -50, NaN]) {
    const r = rig({ room: { pttTail: v } });
    await hold(r, 3);
    assert.deepEqual(r.log.slice(-2), ["rec.stop", "track.stop"], JSON.stringify(v) + ": stopped at once");
    assert.equal(r.live().filter((t) => t.ms < 1000 && t.ms > 0).length, 0, JSON.stringify(v) + ": no tail timer");
  }
  let r = rig({ room: { pttTail: 99999 } });
  await hold(r, 3);
  assert.ok(r.timer(1000), "clamped to 1000 ms");
  r = rig({ room: { pttTail: 250.7 } });
  await hold(r, 3);
  assert.ok(r.timer(250), "whole milliseconds");
  // the view changes it at once (the next release uses it)
  r = rig({ room: { pttTail: 400 } });
  r.p.update({ room: { micRelay: true, pttMax: 30, pttTail: 150 }, mine: [] });
  await hold(r, 3);
  assert.ok(r.timer(150) && !r.timer(400), "the newest view's tail");
});

test("ptttail: the setting - pttlimits tail_ms (0-1000, 400) and tail_ios (off) on the Push-to-talk clips card, sent with the live view", () => {
  const PT = require(path.join(repo, "pttlimits"));
  assert.equal(PT.DEFAULTS.tail_ms, 400, "a 400 ms release tail by default");
  assert.equal(PT.DEFAULTS.tail_ios, 0, "off on iOS by default");
  assert.deepEqual(PT.LIMITS.tail_ms, [0, 1000]);
  assert.deepEqual(PT.LIMITS.tail_ios, [0, 1]);
  assert.deepEqual(PT.validate({ tail_ms: "250", tail_ios: true }, PT.DEFAULTS).cfg, Object.assign({}, PT.DEFAULTS, { tail_ms: 250, tail_ios: 1 }));
  assert.equal(PT.validate({ tail_ios: false }, Object.assign({}, PT.DEFAULTS, { tail_ios: 1 })).cfg.tail_ios, 0);
  for (const bad of [{ tail_ms: -1 }, { tail_ms: 1001 }, { tail_ms: 2.5 }, { tail_ms: "" }, { tail_ios: 2 }, { tail_ios: "maybe" }]) {
    const k = Object.keys(bad)[0];
    assert.ok(PT.validate(bad, PT.DEFAULTS).errors[k], JSON.stringify(bad) + " refused");
  }
  assert.deepEqual(PT.clean({ tail_ms: 99999, tail_ios: true }), Object.assign({}, PT.DEFAULTS, { tail_ms: 1000, tail_ios: 1 }), "a hand-edited row is clamped");
  assert.deepEqual(PT.clean({}), PT.DEFAULTS, "an older row (no tail fields): the defaults");
  const bridge = read("bridge.js");
  assert.match(bridge, /pttTail: require\("\.\/pttlimits"\)\.current\(\)\.tail_ms/, "the live view sends the tail");
  assert.match(bridge, /pttTailIos: require\("\.\/pttlimits"\)\.current\(\)\.tail_ios === 1/, "...and whether it applies on iOS");
  const card = read("views", "admin", "bridge.ejs");
  assert.match(card, /<input[^>]*name="tail_ms"[^>]*>/, "the card's tail field");
  assert.match(card, /<input[^>]*type="checkbox"[^>]*name="tail_ios"[^>]*>/, "the card's iOS switch");
  assert.match(card, /NAMES = \['gap_s', 'burst', 'max_secs', 'tail_ms'\]/, "the card's script saves the tail");
});

test("ptttail: cache-busters - room-bridge.js v34 wherever it loads", () => {
  for (const v of ["room.ejs", "home.ejs"]) {
    const s = read("views", v);
    assert.match(s, /room-bridge\.js\?v=34/, v);
    assert.doesNotMatch(s, /room-bridge\.js\?v=(?!34\b)\d+/, v + ": one version");
  }
});

test("ptttail review F1: the release tail keeps the talk button busy (rb-sending) - the homepage dock's busy() never swaps the front pad away from a clip the user already let go of", async () => {
  // home-dock.js busy(): the front pad's swap (frontChanged / the 4 s idle poll) tears the block down - ptt.destroy() - only while the
  // viewer isn't busy; before the tail the button stayed aria-pressed until onstop (the upload already started by then). With the tail
  // the button reads "Sending…" (aria-pressed false) for 400 ms - a swap then destroyed the clip and its notice without a word.
  const hd = read("public", "js", "home-dock.js");
  const m = /var talk = \$\('rmPtt'\) && \$\('rmPtt'\)\.querySelector\('([^']+)'\); if \(talk\) return true;/.exec(hd);
  assert.ok(m, "home-dock.js busy(): the talk button's selector");
  const sel = m[1];
  assert.match(sel, /\.rb-talk\[aria-pressed="true"\]/, "held: busy, as before");
  assert.match(sel, /\.rb-talk\.rb-sending/, "the release tail: busy too");
  // a swap poll at every step: when busy() says idle, the block is torn down (ptt.destroy())
  const r = rig({ room: { pttTail: 400 } });
  let swapped = false;
  const poll = () => { if (!swapped && !r.host.querySelector(sel)) { swapped = true; r.p.destroy(); } };
  await r.down(); poll();
  assert.ok(!swapped, "recording: busy");
  r.clock.t += 3000; r.up(); poll();
  assert.ok(r.btn.classList.contains("rb-sending"), "the tail: the button is rb-sending");
  assert.equal(r.btn.getAttribute("aria-pressed"), "false");
  assert.ok(!swapped, "the tail: busy - no swap");
  r.run(r.timer(400)); poll();
  assert.ok(!swapped, "rec.stop() -> onstop: still busy until onstop");
  await flush();
  assert.equal(r.fetches.length, 1, "uploaded");
  assert.ok(!r.btn.classList.contains("rb-sending"), "idle again after onstop");
  poll();
  assert.ok(swapped, "then the swap may happen - the upload had started");
  assert.equal(r.fetches.length, 1, "the clip was sent once");
  // a tail stopped some other way (pagehide, a hidden page, the max timer, the mic switched off) leaves no rb-sending behind
  for (const how of ["pagehide", "hidden", "max", "micoff"]) {
    const s = rig({ room: { pttTail: 400 } });
    await hold(s, 3);
    assert.ok(s.btn.classList.contains("rb-sending"), how);
    if (how === "pagehide") s.win.fire("pagehide");
    else if (how === "hidden") { s.doc.hidden = true; s.doc.dispatchEvent(new Event("visibilitychange")); }
    else if (how === "max") { const t = s.timer(29500); t.ran = true; t.fn(); }
    else s.p.update({ room: { micRelay: false }, mine: [] });
    await flush();
    assert.ok(!s.btn.classList.contains("rb-sending") && !s.host.querySelector(sel), how + ": not busy once it stopped");
  }
  // a recorder whose stop() throws at the end of the tail: the mic is let go and the button is idle - never busy for good
  const x = rig({ room: { pttTail: 400 } });
  await hold(x, 3);
  x.rec().stop = () => { throw new Error("InvalidStateError"); };
  x.run(x.timer(400));
  await flush();
  assert.ok(x.log.includes("track.stop"), "the mic let go");
  assert.ok(!x.btn.classList.contains("rb-sending") && !x.host.querySelector(sel), "not busy for good");
  assert.equal(x.btn.textContent, "🎙 Hold to talk");
  // without a tail (0 / iOS by default) nothing changes: aria-pressed until onstop, no rb-sending
  const z = rig({ room: { pttTail: 0 } });
  await hold(z, 3);
  assert.ok(!z.btn.classList.contains("rb-sending"), "no tail: no rb-sending");
});

test("ptttail review F2: the icon-only talk button (a phone / narrow pad Dock, the homepage's card) shows ⏳ during the release tail - not the idle 🎙️", () => {
  const pd = read("public", "css", "pad-dock.css"), hd = read("public", "css", "home-dock.css");
  const blk = /@media \(max-width: 1023px\) \{([\s\S]*?)\n\}/.exec(pd);
  assert.ok(blk, "pad-dock.css: the narrow block");
  assert.match(blk[1], /main\.rm\.rm-dock \.rmd-composer \.rb-talk\[aria-pressed="true"\]::before \{ content: "⏺"; \}\n\s*main\.rm\.rm-dock \.rmd-composer \.rb-talk\.rb-sending::before \{ content: "⏳"; \}/,
    "pad-dock.css: ⏳ while sending, after the held ⏺");
  assert.match(hd, /main\.rm\.rm-dock\.rmd-home \.rmd-composer \.rb-talk\[aria-pressed="true"\]::before \{ content: "⏺"; \}\nmain\.rm\.rm-dock\.rmd-home \.rmd-composer \.rb-talk\.rb-sending::before \{ content: "⏳"; \}/,
    "home-dock.css: the same on the homepage's card (its own icon rules outrank pad-dock.css's)");
  // cache-busters: pad-dock.css v13 (every page that loads it), home-dock.css v8, home-dock.js v8
  for (const v of ["room.ejs", "home.ejs", "casino-bj.ejs", "casino-hm.ejs"]) {
    const s = read("views", v);
    assert.match(s, /pad-dock\.css\?v=13"/, v);
    assert.doesNotMatch(s, /pad-dock\.css\?v=(?!13")\d+/, v + ": one css version");
  }
  const home = read("views", "home.ejs");
  assert.match(home, /home-dock\.css\?v=8"/);
  assert.match(home, /home-dock\.js\?v=8"/);
});
