// 1.99il: the room player's ⚡ WebRTC-first / MP3-fallback choice (public/js/room-bridge.js + webrtc-client.js's listen),
// in a tiny fake DOM: which way it plays for each ticket answer and connection outcome, the "⚡ live" / "standard"
// badge, the user's volume / mute on both elements, and the "this network blocks WebRTC" memory.
//   NODE_PATH=G:/PATV/node_modules node --test test/room-rtc-player.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(repo, "public", "js", "room-bridge.js"), "utf8");

function fakeEl(tag) {
  const cls = new Set();
  const e = {
    tagName: tag, children: [], attrs: {}, style: {}, disabled: false, title: "", textContent: "", paused: true, muted: false, volume: 1,
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
/** Load the player with a stubbed fetch (the ticket) and PATVRtc.listen (the WHEP connection). */
function load({ ticket, listen, rtc = true, failMemory = null }) {
  const store = new Map(failMemory ? [["patvRoomRtcFail", String(failMemory)]] : []);
  const calls = { ticket: 0, listen: [] };
  const win = { addEventListener() {} };
  win.fetch = async (url, o) => {
    if (/\/audio\/rtc$/.test(url)) { calls.ticket++; return { json: async () => ticket }; }
    throw new Error("unexpected fetch " + url);
  };
  if (rtc) {
    win.PATVRtc = { listen: (url, el, o) => { calls.listen.push({ url, o }); return listen(url, el, o); } };
  }
  const ctx = { window: win, document: { createElement: fakeEl, addEventListener() {}, hidden: false }, navigator: {}, fetch: win.fetch,
                sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
                localStorage: { getItem: () => null, setItem() {} },
                setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, console };
  win.document = ctx.document;
  vm.runInNewContext(SRC, ctx);
  const host = fakeEl("div");
  const p = win.PATVRoom.audio(host, "alpha", { showOff: true });
  p.update({ room: { audio: true, live: true, rtc: true } });
  const box = host.children[0];
  const kids = (cls) => box.children.find((c) => c.className.split(" ").includes(cls));
  const audios = box.children.filter((c) => c.tagName === "audio");
  return { p, box, play: kids("rb-play"), mode: kids("rb-mode"), state: kids("rb-state"), mute: kids("rb-mute"), au: audios[0], rau: audios[1], calls, store };
}
const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 10; i++) await tick(); }
function click(btn, P) { P.p.listen("alpha"); }      // listen(home slug) = the ▶ path (start())

function fakeSession() { return { closed: false, close() { this.closed = true; }, onfail: null }; }

test("⚡ first: a ticket + a WHEP connection -> plays over WebRTC, badge '⚡ live', the MP3 relay untouched", async () => {
  const sess = fakeSession();
  const P = load({ ticket: { ok: true, whep: "https://stream.publicaccess.tv/whep/room-0123456789abcdef?pt=ra1.x", ready: true },
                   listen: async (url, el) => { el.srcObject = { fake: true }; return sess; } });
  click(P.play, P);
  await settle();
  assert.equal(P.calls.ticket, 1);
  assert.equal(P.calls.listen.length, 1);
  assert.match(P.calls.listen[0].url, /\/whep\/room-[0-9a-f]{16}\?pt=/);
  assert.equal(P.mode.textContent, "⚡ live");
  assert.equal(P.mode.classList.contains("hide"), false);
  assert.equal(P.au.src, undefined, "no MP3 request");
  assert.equal(P.state.textContent, "LIVE");
  // the connection drops later (a network blip, or Pepe / MediaMTX restarting the publish): carries on with the MP3
  // relay; not held against the network (it did connect)
  sess.onfail();
  await settle();
  assert.equal(P.mode.textContent, "standard");
  assert.match(String(P.au.src), /^\/p\/alpha\/audio\?t=/);
  assert.equal(P.store.get("patvRoomRtcFail"), undefined);
  // stop closes everything
  P.p.listen("alpha");
  assert.equal(P.mode.classList.contains("hide"), true, "no badge while stopped");
});

for (const why of ["busy", "off", "not-eligible"]) {
  test(`the site says ${why} -> the MP3 relay at once, 'standard', no "blocked network" memory`, async () => {
    const P = load({ ticket: { ok: false, fallback: why }, listen: async () => { throw new Error("not called"); } });
    click(P.play, P);
    await settle();
    assert.equal(P.calls.listen.length, 0);
    assert.equal(P.mode.textContent, "standard");
    assert.match(String(P.au.src), /^\/p\/alpha\/audio\?t=/);
    assert.equal(P.store.get("patvRoomRtcFail"), undefined);
  });
}

test("ICE never connects (no UDP, TURN full) -> MP3, and the next ▶ goes straight to MP3 for a while", async () => {
  const P = load({ ticket: { ok: true, whep: "https://x/whep/room-0123456789abcdef?pt=t" },
                   listen: async () => { const e = new Error("Low latency audio timed out"); e.timeout = true; throw e; } });
  click(P.play, P);
  await settle();
  assert.equal(P.mode.textContent, "standard");
  assert.ok(P.store.get("patvRoomRtcFail"));
  // a fresh page in the same tab session
  const Q = load({ ticket: { ok: true, whep: "x" }, listen: async () => fakeSession(), failMemory: Date.now() });
  click(Q.play, Q);
  await settle();
  assert.equal(Q.calls.ticket, 0, "doesn't even ask");
  assert.equal(Q.mode.textContent, "standard");
});

test("Pepe didn't publish in time (WHEP 404 until the timeout) -> MP3, but no network memory", async () => {
  const P = load({ ticket: { ok: true, whep: "https://x/whep/room-0123456789abcdef?pt=t", ready: false },
                   listen: async () => { const e = new Error("404"); e.status = 404; throw e; } });
  click(P.play, P);
  await settle();
  assert.equal(P.mode.textContent, "standard");
  assert.equal(P.store.get("patvRoomRtcFail"), undefined);
});

test("no WebRTC client on the page (the site's WebRTC is off) or the pad says rtc:false -> the MP3 relay as before", async () => {
  const P = load({ rtc: false, ticket: null, listen: null });
  click(P.play, P);
  await settle();
  assert.equal(P.calls.ticket, 0);
  assert.equal(P.mode.textContent, "standard");
  const Q = load({ ticket: { ok: true, whep: "x" }, listen: async () => fakeSession() });
  Q.p.update({ room: { audio: true, live: true, rtc: false } });
  click(Q.play, Q);
  await settle();
  assert.equal(Q.calls.ticket, 0, "a pad without ⚡ never asks");
});

test("volume + mute are the user's on both players (MP3 and WebRTC)", async () => {
  const P = load({ ticket: { ok: true, whep: "x" }, listen: async (u, el) => { el.srcObject = {}; return fakeSession(); } });
  click(P.play, P);
  await settle();
  assert.equal(P.au.muted, P.rau.muted);
  assert.equal(P.au.volume, P.rau.volume);
  assert.equal(P.rau.volume, 0.8, "the default 80%");
  const js = SRC;
  assert.match(js, /\[au, rau\]\.forEach\(function \(x\) \{[^}]*x\.muted = userMuted;/);
});

test("webrtc-client.js: listen() is audio-only WHEP and retries a 404 (not published yet) until its timeout", () => {
  const js = fs.readFileSync(path.join(repo, "public", "js", "webrtc-client.js"), "utf8");
  const fn = js.slice(js.indexOf("function listen("), js.indexOf("function preferH264("));
  assert.match(fn, /addTransceiver\('audio', \{ direction: 'recvonly' \}\)/);
  assert.doesNotMatch(fn, /addTransceiver\('video'/);
  assert.match(fn, /e\.status === 404 && Date\.now\(\) \+ 800 < deadline/);
  assert.match(js, /window\.PATVRtc = \{ ice: ice, play: play, publish: publish, listen: listen \}/);
});
