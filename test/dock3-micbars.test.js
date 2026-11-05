"use strict";
// dock3 (owner 2026-11-05 item 2: "the mic indicator in mobile I was talking about wasn't just a mic icon on the name - that's pointless. I meant
// the one with the bars like we have in desktop") 1.99akf: the room audio bar's eq meter (room-bridge.js) is no longer hidden INLINE on iOS - it
// is marked rb-nolvl (no real level: no Web Audio on iOS, 1.99bk), which room-bridge.css hides as before and the Room Dock turns into the
// "someone's on the mic" bars (pad-dock.css .rmd-now.rmd-talk). The real level marks the meter rb-lvl (see pad-dock-pol.test.js for the CSS).
//   node --test test/dock3-micbars.test.js
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { Document, Event } = require("./fixtures/pad-dock/dom.cjs");
const repo = path.resolve(__dirname, "..");
function player(ua, platform, touch) {
  const doc = new Document(), store = new Map();
  const ctx = { console, document: doc, navigator: { userAgent: ua, platform, maxTouchPoints: touch || 0 },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) }, crypto: require("crypto").webcrypto,
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    fetch: () => Promise.resolve({ status: 200, json: async () => ({ ok: true }) }), CustomEvent: Event, addEventListener() {}, removeEventListener() {} };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(repo, "public/js/room-bridge.js"), "utf8"), ctx);
  const host = doc.createElement("div"); doc.body.appendChild(host);
  ctx.PATVRoom.audio(host, "pad", { idle: "Listen to the room" });
  return { meter: host.querySelector(".rb-meter"), vol: host.querySelector(".rb-vol") };
}

test("iPhone (any iOS browser - CriOS too): the meter is marked rb-nolvl, never hidden inline; the volume slider stays hidden (hardware buttons)", () => {
  for (const ua of ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1"]) {
    const p = player(ua, "iPhone", 5);
    assert.ok(p.meter, "the meter is built");
    assert.ok(p.meter.classList.contains("rb-nolvl"), "no real level on iOS");
    assert.notEqual(p.meter.style.display, "none", "no inline hide (it beat every rule - the Dock could never show the bars)");
    assert.equal(p.vol.style.display, "none");
    assert.equal(p.meter.classList.contains("rb-lvl"), false, "not playing: no real level");
  }
});

test("micvad 1.99akk: room-bridge.css hides an iOS meter only while it has no real level (rb-lvl: Pepe's levels / ⚡'s getStats)", () => {
  const css = fs.readFileSync(path.join(repo, "public/css/room-bridge.css"), "utf8");
  assert.match(css, /\n\.rb-meter\.rb-nolvl:not\(\.rb-lvl\) \{ display: none; \}/);
  assert.doesNotMatch(css, /\n\.rb-meter\.rb-nolvl \{/, "the 1.99akf rule is gone");
});

test("Android / desktop: a plain meter (the analyser gives it a real level while playing - rb-lvl)", () => {
  for (const [ua, pf] of [["Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36", "Linux armv8l"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "Win32"]]) {
    const p = player(ua, pf, 0);
    assert.equal(p.meter.classList.contains("rb-nolvl"), false, ua);
    assert.notEqual(p.meter.style.display, "none");
    assert.notEqual(p.vol.style.display, "none");
  }
});
