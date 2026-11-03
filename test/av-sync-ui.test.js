// A/V sync browser controller: measured timing, receiver lifecycle and privacy-preserving mic merges.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../public/js/av-sync.js"), "utf8");
const plain = value => JSON.parse(JSON.stringify(value));

function sandbox(options = {}) {
  let now = 100000, sequence = 0;
  const timers = new Map(), events = {}, requests = [], storage = new Map(Object.entries(options.stored || {}));   // (1.99?? avf: stored - the viewer's saved toggle)
  const config = Object.assign({ ok: true, on: true, dbg: false, audio: { rtc_ms: 1000, mp3_ms: 1000, mix_ms: 700, helper_ms: 270, age_s: 0 },
    cams: { cam1: { src: "passthrough", hold_ms: 200 }, cam2: { src: "reencode", hold_ms: 300 } }, k: { pt: 100, re: -100, ind: 0 },
    fallback: { rtc: 500, mp3: 1500 }, cap: 3000, cap_ind: 3000, deadband: 40, period_s: 2,
    apply: { video: true, mic: true, mp3: true, mic_card: true, mic_chat: true, mic_list: true }, engines: { chromium: true, firefox: false, safari: false }, ind_path_ms: 300, mods_instant: false }, options.config || {});
  function element(tag) {
    const e = { tagName: tag.toUpperCase(), style: {}, attrs: {}, children: [], parentNode: null, hidden: false, textContent: "", events: {},
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; },
      addEventListener(k, fn) { (this.events[k] ||= []).push(fn); },
      appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
      removeChild(child) { this.children = this.children.filter(v => v !== child); child.parentNode = null; },
      click() { (this.events.click || []).forEach(fn => fn()); } };
    Object.defineProperty(e, "isConnected", { get: () => e === document.body || !!(e.parentNode && e.parentNode.isConnected) });
    Object.defineProperty(e, "innerHTML", { set() { throw new Error("No HTML injection"); } });
    return e;
  }
  const docEvents = {};
  const document = { createElement: element, body: null, hidden: false, addEventListener(k, fn) { (docEvents[k] ||= []).push(fn); } }; document.body = element("body");
  const setTimeout = (fn, delay = 0) => { const id = ++sequence; timers.set(id, { at: now + delay, fn }); return id; };
  const clearTimeout = id => timers.delete(id);
  const ctx = { document, console, Promise, Date: { now: () => now }, setTimeout, clearTimeout,
    navigator: { userAgent: options.ua || "Chrome/145.0", platform: options.platform || "Win32", maxTouchPoints: options.touch || 0 },
    location: { search: options.search || "" },
    localStorage: { getItem(k) { if (options.noStorage) throw new Error("denied"); return storage.get(k) || null; }, setItem(k, v) { if (options.noStorage) throw new Error("denied"); storage.set(k, v); } },
    addEventListener(k, fn) { (events[k] ||= []).push(fn); },
    fetch(url, init) { requests.push({ url, init, at: now }); return options.fetch ? options.fetch(url, init, config) : Promise.resolve({ ok: true, json: () => Promise.resolve(plain(config)) }); } };
  ctx.window = ctx; vm.runInNewContext(source, ctx);
  async function flush() { for (let i = 0; i < 24; i++) await Promise.resolve(); }
  async function advance(ms) {
    const end = now + ms; let turns = 0;
    await flush();
    while (true) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at || t.at === next[1].at && id < next[0])) next = [id, t];
      if (!next) break;
      if (++turns > 10000) throw new Error("Timer loop");
      now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
    }
    now = end; await flush();
  }
  function receiver(kind = "standard") {
    const writes = [], rx = { writes };
    if (kind !== "none") Object.defineProperty(rx, kind === "legacy" ? "playoutDelayHint" : "jitterBufferTarget", { configurable: true, get: () => writes.at(-1), set: v => { if (options.setterThrows) throw new Error("unsupported"); writes.push(v); } });
    return rx;
  }
  function peer(kind = "video", delayMs = 200, rtt = .1) {
    const pc = { signalingState: "stable", connectionState: "connected", remoteDescription: { sdp: "a=extmap:5 http://www.webrtc.org/experiments/rtp-hdrext/playout-delay" }, listeners: {}, fail: false,
      addEventListener(k, fn) { (this.listeners[k] ||= []).push(fn); }, removeEventListener(k, fn) { this.listeners[k] = (this.listeners[k] || []).filter(x => x !== fn); },
      close() { this.signalingState = "closed"; },
      getStats() { if (this.fail) return Promise.reject(new Error("stats failed")); if (this.hang) return new Promise(() => {});
        const count = 100 + (now - 100000) / 10;
        return Promise.resolve(new Map([["transport", { id: "transport", type: "transport", selectedCandidatePairId: "selected" }],
          ["wrong", { id: "wrong", type: "candidate-pair", currentRoundTripTime: 9, nominated: true, state: "succeeded" }],
          ["selected", { id: "selected", type: "candidate-pair", currentRoundTripTime: rtt }],
          ["in", { id: kind + "-1", type: "inbound-rtp", kind, jitterBufferDelay: count * delayMs / 1000, jitterBufferEmittedCount: count,
            jitterBufferTargetDelay: count * .5, jitterBufferMinimumDelay: count * .01, framesDropped: 3, freezeCount: 1, totalFreezesDuration: .2 }]])); }
    }; return pc;
  }
  function media(mode = "mp3", pad = "pad", extra = {}) { const input = { slug: pad, playing: true, mode, pc: mode === "rtc" ? peer("audio", 200, .3) : null, ahead: () => .5, ...extra }; ctx.PATVAvSync.audio(input); return input; }
  function tile(rx = receiver(), pc = peer(), pad) { ctx.PATVAvSync.video(rx, { pc, url: "https://relay.test/whep/cam1?pt=PRIVATE_TICKET", pad }); return { rx, pc }; }
  return { api: ctx.PATVAvSync, ctx, config, requests, storage, document, element, receiver, peer, media, tile, advance, flush, now: () => now,
    event: (name, value) => (events[name] || []).forEach(fn => fn(value)), docEvent: (name) => (docEvents[name] || []).forEach(fn => fn()) };
}

test("pure math: signed formula, caps, whole fallback, jitter deltas and ten-second exponential average", () => {
  const m = sandbox().api._math;
  const input = { fresh: true, statsOK: true, pepe: 1500, hold: 200, k: -100, browser: 250, net: 50, cap: 3000, fallback: 500 };
  assert.equal(m.videoTarget(input), 1500);
  assert.equal(m.videoTarget({ ...input, cap: 800 }), 800);
  assert.equal(m.videoTarget({ ...input, hold: 3000 }), null);
  assert.equal(m.videoTarget({ ...input, cap: 9000, pepe: 9000 }), 4000);
  assert.equal(m.videoTarget({ ...input, fresh: false }), 500);
  assert.equal(m.videoTarget({ ...input, statsOK: false }), 500);
  assert.equal(m.videoTarget({ ...input, hold: null }), 500);
  assert.equal(m.indicatorTarget({ ...input, path: 300 }), 1350);
  assert.equal(m.indicatorTarget({ ...input, fresh: false, path: 300 }), 500);
  assert.equal(m.delta({ ids: "a", count: 100, delay: 20 }, { ids: "a", count: 200, delay: 45 }), 250);
  assert.equal(m.delta({ ids: "a", count: 100, delay: 20 }, { ids: "a", count: 50, delay: 9 }), null);
  assert.equal(m.delta({ ids: "a", count: 100, delay: 20 }, { ids: "b", count: 200, delay: 45 }), null);
  assert.ok(Math.abs(m.average(100, 1100, 10000) - 732.1205588) < .00001);
  assert.equal(m.pathOf("https://x/whep/cam-123?pt=SECRET"), "cam-123");
  assert.equal(m.pathOf("https://x/whep/abc%2Fdef?pt=SECRET"), null);
});

test("MP3 uses measured ahead and calibration, ignores deadband, clears synchronously on pause and pad switch", async () => {
  const s = sandbox(); s.api.pad("pad"); const a = s.tile();
  await s.advance(0); assert.equal(a.rx.writes.at(-1), null);
  s.media(); await s.advance(0); assert.equal(a.rx.writes.at(-1), 1400);
  assert.equal(s.api.latency("pad", "mp3"), 1500);
  s.config.k.pt = 120; const before = a.rx.writes.length; await s.advance(5000);
  assert.equal(a.rx.writes.length, before, "20ms does not move a40ms deadband");
  s.config.k.pt = 200; await s.advance(5000); assert.equal(a.rx.writes.at(-1), 1500);
  s.api.audio({ slug: "pad", playing: false, mode: "mp3" }); assert.equal(a.rx.writes.at(-1), null);
  s.media(); await s.advance(0); assert.equal(a.rx.writes.at(-1), 1500);
  s.media("mp3", "other"); assert.equal(a.rx.writes.at(-1), null);
  s.api.audio({ slug: "pad", playing: false, mode: "mp3" });
  assert.equal(s.api.debug().playing, true, "late old-pad pause does not stopother audio");
});

test("RTC uses interval jitter and the selected RTT pair; stats failures and old telemetry use whole fallback", async () => {
  const s = sandbox(); s.api.pad("pad"); const a = s.tile(); s.media("rtc");
  await s.advance(0); assert.equal(a.rx.writes.at(-1), 500, "first stats have no interval");
  await s.advance(2000); assert.equal(a.rx.writes.at(-1), 1200, "1000-200+100+200+(0.3-0.1)*500");
  a.pc.fail = true; await s.advance(2000); assert.equal(a.rx.writes.at(-1), 500);
  a.pc.fail = false; s.config.audio.age_s = 31; await s.advance(1000); assert.equal(a.rx.writes.at(-1), 500);
  assert.equal(s.api.latency("pad", "rtc"), null);
});

test("toggle stays available to re-enable; unsupported and legacy browsers remain safe; engines only gate video", async () => {
  const s = sandbox({ noStorage: true, ua: "Firefox/145.0" }); s.api.pad("pad"); const box = s.element("div"); s.document.body.appendChild(box); s.api.decorate(box);
  const a = s.tile(s.receiver("legacy")); s.media(); await s.advance(0);
  assert.equal(a.rx.writes.at(-1), null); assert.equal(s.api.debug().indicator_ms, 1200);
  s.config.engines.firefox = true; await s.advance(5000); assert.equal(a.rx.writes.at(-1), 1.4);
  const button = box.children[0]; assert.equal(button.style.minHeight, "44px"); assert.equal(button.attrs["aria-pressed"], "true"); assert.equal(button.hidden, false);
  button.click(); assert.equal(a.rx.writes.at(-1), null); assert.equal(button.hidden, false); assert.equal(button.attrs["aria-pressed"], "false");
  button.click(); assert.equal(a.rx.writes.at(-1), 1.4);
  const unsupported = s.tile(s.receiver("none")); await s.advance(0); assert.equal(s.api.debug().tiles.at(-1).supported, false); unsupported.pc.close();
  await s.advance(2000); assert.equal(s.api.debug().tiles.length, 1, "closewithout event is pruned");
});

test("standard receiver API takes precedence; current target applied at registration; explicit pad overrides default", async () => {
  const s = sandbox(); let front = "pad"; s.api.pad(() => front); s.media(); await s.advance(0);
  const rx = s.receiver(); const legacy = []; Object.defineProperty(rx, "playoutDelayHint", { set: v => legacy.push(v) });
  const a = s.tile(rx); assert.equal(rx.writes.at(-1), 1400, "synchronous beforefirstframe"); assert.deepEqual(legacy, []);
  const other = s.tile(s.receiver(), s.peer(), "another"); assert.equal(other.rx.writes.at(-1), null);
  front = "another"; await s.advance(0); assert.equal(a.rx.writes.at(-1), 1400, "existingregistration keepsitsactualpad");
  s.config.apply.video = false; await s.advance(5000); assert.equal(rx.writes.at(-1), null);
  assert.equal(s.api.debug().indicator_ms, 1200);
});

test("iPad desktop UA remains Safari; missing APIs or throwing setters never affect the audio", async () => {
  const s = sandbox({ ua: "Mozilla/5.0 Chrome/145.0 Safari/605.1", platform: "MacIntel", touch: 5, setterThrows: true });
  s.api.pad("pad"); s.tile(); s.media(); await s.advance(0);
  assert.equal(s.api.debug().engine, "safari"); assert.equal(s.api.debug().playing, true);
  s.config.engines.safari = true; await s.advance(5000); assert.equal(s.api.debug().tiles[0].supported, false);
});

test("mode off, MP3 disabled and missing access clear targets; denied or late fetches do not revive them", async () => {
  let deny = false;
  const s = sandbox({ fetch: (url, init, config) => Promise.resolve(deny ? { ok: false, status: 403 } : { ok: true, json: async () => plain(config) }) });
  s.api.pad("pad"); const a = s.tile(); s.media(); await s.advance(0); assert.equal(a.rx.writes.at(-1), 1400);
  s.config.apply.mp3 = false; await s.advance(5000); assert.equal(a.rx.writes.at(-1), null); assert.equal(s.api.debug().indicator_ms, 0);
  s.config.apply.mp3 = true; s.config.on = false; await s.advance(5000); assert.equal(a.rx.writes.at(-1), null);
  // review fix: after an off answer the settings are asked for once a minute (a page left open after the switch went off)
  s.config.on = true; const asked = s.requests.length; await s.advance(55000);
  assert.equal(s.requests.length, asked, "off: no five-second polling"); assert.equal(a.rx.writes.at(-1), null);
  await s.advance(5000); assert.equal(s.requests.length, asked + 1); assert.equal(a.rx.writes.at(-1), 1400);
  deny = true; await s.advance(5000); assert.equal(a.rx.writes.at(-1), null);
  // review fix: a pad that refused this viewer (403) is not asked again before a reload
  const refused = s.requests.length; deny = false; await s.advance(120000);
  assert.equal(s.requests.length, refused); assert.equal(a.rx.writes.at(-1), null);
});

test("review fix: a signed-out answer (401) stops every settings request until a reload, and new cams don't restart it", async () => {
  const s = sandbox({ fetch: () => Promise.resolve({ ok: false, status: 401 }) }); s.api.pad("pad"); const a = s.tile(); s.media(); await s.advance(0);
  assert.equal(s.requests.length, 1); assert.equal(a.rx.writes.at(-1), null);
  s.tile(s.receiver(), s.peer()); s.media("mp3", "other"); await s.advance(120000);
  assert.equal(s.requests.length, 1, "no 401 every five seconds (three tabs used to hit the 30 a minute limit)");
});

function program(ids, extra = {}) { return { v: 1, src: ids.map((id, i) => ({ id, name: id.toUpperCase(), pos: i, newest: i === ids.length - 1, recent: false, video: "live", watch: "ok" })), count: ids.length, active: !!ids.length, layout: ids.length > 1 ? "split" : "single", manage: { layout_override: null }, fixed: false, ...extra }; }
async function gated(options) { const s = sandbox(options); s.api.pad("pad"); s.media("mp3", "pad", { ahead: () => 0 }); await s.advance(0); return s; }

test("gateProgram delays additions/ring and keeps current names, permissions, layout overrides and removals", async () => {
  const s = await gated(); const seen = []; const cb = p => seen.push(plain(p));
  s.api.gateProgram("pad", program(["a"]), cb); assert.equal(seen.at(-1).src.length, 0); assert.equal(seen.at(-1).active, false);
  await s.advance(699); assert.equal(seen.at(-1).src.length, 0);
  await s.advance(1); assert.equal(seen.at(-1).src[0].id, "a"); assert.equal(seen.at(-1).src[0].newest, true);
  const next = program(["a", "b"]); next.src[0].name = "NEW DISPLAY"; next.src[0].watch = "blocked"; next.manage = { layout_override: "grid9", can: true }; next.layout = "grid9";
  s.api.gateProgram("pad", next, cb);
  assert.equal(seen.at(-1).src.length, 1); assert.equal(seen.at(-1).src[0].name, "NEW DISPLAY"); assert.equal(seen.at(-1).src[0].watch, "blocked");
  assert.equal(seen.at(-1).layout, "grid9"); assert.equal(seen.at(-1).manage.can, true); assert.equal(seen.at(-1).src[0].newest, true);
  await s.advance(700); assert.equal(seen.at(-1).src.length, 2); assert.equal(seen.at(-1).src[1].newest, true); assert.equal(seen.at(-1).src[0].newest, false);
  s.api.gateProgram("pad", program(["b"]), cb); assert.deepEqual(seen.at(-1).src.map(x => x.id), ["b"], "privacy removal is immediate");
  s.api.gateProgram("pad", null, cb); assert.equal(seen.at(-1), null);
});

test("gateProgram never resurrects removed names, delays neutral someone, and passes Pepe and audio-off immediately", async () => {
  const s = await gated(); let shown;
  const cb = p => { shown = plain(p); };
  s.api.gateProgram("pad", program(["secret"]), cb); await s.advance(700);
  s.api.gateProgram("pad", program([], { speaking: "someone", count: 1, active: true }), cb);
  assert.equal(shown.src.length, 0); assert.equal(shown.speaking, null); await s.advance(700); assert.equal(shown.speaking, "someone");
  s.api.gateProgram("pad", program([], { speaking: "pepe", active: true }), cb); assert.equal(shown.speaking, "pepe");
  s.api.gateProgram("pad", program([], { speaking: null }), cb); assert.equal(shown.speaking, null, "Pepe clearing is also immediate");
  s.api.gateProgram("pad", program(["new"]), cb); assert.equal(shown.src.length, 0);
  s.api.audio({ slug: "pad", playing: false, mode: "mp3" }); assert.equal(shown.src[0].id, "new");
  const raw = program(["instant"]); const got = s.api.gateProgram("pad", raw, cb); assert.equal(got, raw);
});

test("review fix: a tile already shown stays, with its count, when D rises (RTC fallback -> measured, play start); new tiles wait the new D", async () => {
  const s = sandbox(); s.api.pad("pad"); s.media("rtc"); await s.advance(0);
  assert.equal(s.api.debug().indicator_ms, 500, "first RTC stats have no interval: the whole fallback");
  let shown; const cb = p => { shown = plain(p); }; const ids = () => shown.src.map(t => t.id);
  s.api.gateProgram("pad", program([]), cb); await s.advance(1200);
  s.api.gateProgram("pad", program(["a"]), cb); assert.deepEqual(ids(), []);
  await s.advance(500); assert.deepEqual(ids(), ["a"]); assert.equal(shown.count, 1); assert.equal(shown.active, true);
  await s.advance(300); assert.equal(s.api.debug().indicator_ms, 900, "measured: 1000 + 200 - 300");
  assert.deepEqual(ids(), ["a"], "not pulled and re-added (that reconnected its cam)");
  assert.equal(shown.count, 1, "the stage does not go idle under it"); assert.equal(shown.active, true);
  s.api.gateProgram("pad", program(["a", "b"]), cb); await s.advance(899); assert.deepEqual(ids(), ["a"], "a new tile waits the whole new D");
  await s.advance(1); assert.deepEqual(ids(), ["a", "b"]); assert.equal(shown.count, 2);
  s.api.gateProgram("pad", program(["b"]), cb); assert.deepEqual(ids(), ["b"], "removals stay immediate");
  // play start: paused audio shows everything at once; starting it again (D 0 -> fallback) pulls none of it
  s.api.audio({ slug: "pad", playing: false, mode: "rtc" }); s.api.gateProgram("pad", program(["b", "c"]), cb); assert.deepEqual(ids(), ["b", "c"]);
  await s.advance(100); s.media("rtc"); await s.advance(0); assert.equal(s.api.debug().indicator_ms, 500);
  assert.deepEqual(ids(), ["b", "c"]); assert.equal(shown.count, 2);
  s.api.gateProgram("pad", program(["b", "c", "d"]), cb); assert.deepEqual(ids(), ["b", "c"], "the gate still holds new tiles");
  const veiled = program(["b", "c", "d"]); veiled.src[1].anon = true; veiled.src[1].name = "someone";
  s.api.gateProgram("pad", veiled, cb); assert.deepEqual(ids(), ["b"], "a veil change is a new key: the named tile goes at once");
});

function roster(mic, members = ["a", "b"], extra = {}) { return { room: { topic: "current" }, members: members.map(login => ({ login, display: login.toUpperCase(), on_mic: mic.includes(login), can: "current" })), mic: mic.map(login => ({ login, display: login.toUpperCase(), on_mic: true })), ...extra }; }
test("C2 micView delays grab/drop and sorting flags, keeps new identity/permission data, removes privacy entries immediately", async () => {
  const s = await gated(); let shown; const cb = d => { shown = plain(d); };
  shown = plain(s.api.micView("pad", roster([]), cb)); shown = plain(s.api.micView("pad", roster(["a"]), cb));
  assert.equal(shown.mic.length, 0); assert.equal(shown.members[0].on_mic, false); await s.advance(700); assert.equal(shown.mic[0].login, "a");
  const dropped = roster([]); dropped.members[0].display = "CURRENT NAME"; dropped.members[0].can = "changed";
  shown = plain(s.api.micView("pad", dropped, cb)); assert.equal(shown.mic[0].display, "CURRENT NAME"); assert.equal(shown.mic[0].can, "changed");
  await s.advance(699); assert.equal(shown.mic.length, 1); await s.advance(1); assert.equal(shown.mic.length, 0);
  shown = plain(s.api.micView("pad", roster(["a"]), cb)); await s.advance(700); assert.equal(shown.mic[0].login, "a");
  shown = plain(s.api.micView("pad", roster([], ["b"]), cb)); assert.equal(shown.mic.length, 0); assert.equal(shown.members.length, 1);
  s.config.mods_instant = true; await s.advance(5000); assert.equal(s.api.modsInstant("pad"), true);
});

test("review fix: C2 people already shown stay when D rises; (1.99ahm) a grab shorter than the delay shows late for its own length", async () => {
  const s = sandbox(); s.api.pad("pad"); s.media("rtc"); await s.advance(0);
  let shown; const cb = d => { shown = plain(d); };
  s.api.micView("pad", roster([]), cb); await s.advance(1200);
  shown = plain(s.api.micView("pad", roster(["a"]), cb)); assert.equal(shown.mic.length, 0);
  await s.advance(500); assert.equal(shown.mic[0].login, "a"); assert.equal(shown.members[0].on_mic, true);
  await s.advance(300); assert.equal(s.api.debug().indicator_ms, 900);
  assert.equal(shown.mic.length, 1, "not pulled when D rises"); assert.equal(shown.members[0].on_mic, true);
  // the view held at +1500 since D rose catches up at +2400: b's grab (+2000) shows at +2900, its drop (+2400) at +3300
  shown = plain(s.api.micView("pad", roster(["a", "b"]), cb)); await s.advance(400);
  shown = plain(s.api.micView("pad", roster(["a"]), cb)); await s.advance(499);
  assert.deepEqual(shown.mic.map(p => p.login), ["a"]);
  await s.advance(1); assert.deepEqual(shown.mic.map(p => p.login), ["a", "b"], "1.99ahm: b's 400 ms grab is held back, not dropped"); assert.equal(shown.members[1].on_mic, true);
  await s.advance(399); assert.deepEqual(shown.mic.map(p => p.login), ["a", "b"]);
  await s.advance(1); assert.deepEqual(shown.mic.map(p => p.login), ["a"], "for as long as it lasted"); assert.equal(shown.members[1].on_mic, false);
});

test("C2 brief grabs show late for their own length (1.99ahm), same-key veil replacement drops names, and lines retain their insertion order", async () => {
  const s = await gated(); let shown; const cb = d => { shown = plain(d); };
  s.api.micView("pad", roster([]), cb); s.api.micView("pad", roster(["a"]), cb); await s.advance(200);
  shown = plain(s.api.micView("pad", roster([]), cb)); assert.equal(shown.mic.length, 0);
  await s.advance(500); assert.equal(shown.mic.length, 1, "1.99ahm: a 200 ms grab shows one offset late");
  await s.advance(200); assert.equal(shown.mic.length, 0, "and goes 200 ms later, one offset after its drop");
  await s.advance(300);
  s.api.micView("pad", roster(["a"]), cb); await s.advance(700);
  shown = plain(s.api.micView("pad", { members: [{ login: "a", anon: true, display: "someone", on_mic: true }], mic: [{ anon: true, display: "someone" }] }, cb));
  assert.equal(shown.mic.length, 0, "anonymous key cannot borrow named history"); assert.equal(shown.members[0].display, "someone");
  const host = s.element("div"), one = s.element("div"), two = s.element("div"); s.document.body.appendChild(host); host.appendChild(one); host.appendChild(two);
  one.textContent = "mic line"; two.textContent = "later chat"; one.style.display = "flex";
  s.api.holdLine("pad", one); assert.equal(one.style.display, "none"); assert.deepEqual(host.children, [one, two]);
  await s.advance(700); assert.equal(one.style.display, "flex"); assert.deepEqual(host.children, [one, two]);
  s.api.holdLine("pad", two); s.api.audio({ slug: "pad", mode: "mp3", playing: false }); assert.equal(two.style.display, "");
});

test("debug never contains pad names, ticket URLs, source objects or old identities; admin overlay uses text only", async () => {
  const s = sandbox({ search: "?avsync=1", config: { dbg: true } }); s.api.pad("SECRET_PAD"); s.tile(); s.media("mp3", "SECRET_PAD"); await s.advance(0);
  const dump = JSON.stringify(s.api.debug());
  for (const word of ["SECRET_PAD", "PRIVATE_TICKET", "relay.test", "cam1"]) assert.ok(!dump.includes(word), word);
  assert.equal(s.api.debug().tiles[0].playout_delay_extension, true); assert.equal(s.api.debug().tiles[0].stats.freezeCount, 1);
  assert.equal(s.document.body.children.length, 1); assert.ok(s.document.body.children[0].children[2].textContent.includes("pepe_ms"));
});

test("silent pc.close is forgotten, hung getStats times out, and every fetched path excludes its ticket", async () => {
  const s = sandbox(); s.api.pad("pad"); const a = s.tile(); s.media(); await s.advance(0);
  a.pc.hang = true; await s.advance(4500); assert.equal(a.rx.writes.at(-1), 1500, "timeout uses MP3 wholefallback");
  a.pc.close(); await s.advance(2000); assert.equal(s.api.debug().tiles.length, 0);
  assert.ok(s.requests.length); s.requests.forEach(r => { assert.ok(!r.url.includes("PRIVATE_TICKET")); assert.equal(r.init.headers["X-Requested-With"], "fetch"); });
});

test("paused/off controllers do not poll stats, late stats cannot restore targets, and settings still refresh every five seconds", async () => {
  const s = sandbox({ config: { on: false, period_s: 10 } }); s.api.pad("pad"); const a = s.tile();
  let calls = 0; const stats = a.pc.getStats; a.pc.getStats = function () { calls++; return stats.call(this); };
  s.media(); await s.advance(0); assert.equal(calls, 0, "site mode off does not collect stats");
  // review fix: an off answer is asked again after a minute (not every five seconds); once on, every five seconds again
  s.config.on = true; await s.advance(59999); assert.equal(s.requests.length, 1, "off: no five-second polling"); assert.equal(calls, 0);
  await s.advance(1); assert.equal(s.requests.length, 2);
  await s.advance(5000); assert.equal(s.requests.length, 3, "settings poll is independent of the ten-second controller period");
  assert.notEqual(a.rx.writes.at(-1), null);
  let complete;
  a.pc.getStats = () => new Promise(resolve => { complete = resolve; });
  await s.advance(5000); assert.equal(typeof complete, "function");
  s.api.audio({ slug: "pad", mode: "mp3", playing: false }); const requests = s.requests.length;
  complete(await stats.call(a.pc)); await s.advance(0); assert.equal(a.rx.writes.at(-1), null, "late stats never restore a paused target");
  await s.advance(30000); assert.equal(s.requests.length, requests, "paused room audio makes no settings requests");
});

// Real mini-player integration: only browser media events, not a resolved play() promise,
// prove room audio is currently playing. Keep these fixtures separate from controller maths.
const bridgeSource = fs.readFileSync(path.join(__dirname, "../public/js/room-bridge.js"), "utf8");
function bridgeSandbox(options = {}) {
  const timers = [], intervals = [], publications = [], changes = [], requests = [], storage = new Map();
  let measured = null;
  function element(tag) {
    const cls = new Set(), events = {};
    const e = { tagName: tag, children: [], attrs: {}, style: {}, paused: true, muted: false, volume: 1, currentTime: 0,
      buffered: { length: 1, end: () => 1 }, textContent: "", title: "",
      classList: { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c), toggle(c, v) { const on = v === undefined ? !cls.has(c) : !!v; if (on) cls.add(c); else cls.delete(c); return on; } },
      get className() { return [...cls].join(" "); }, set className(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach(c => cls.add(c)); },
      setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k]; }, removeAttribute(k) { delete this.attrs[k]; },
      appendChild(child) { this.children.push(child); return child; }, addEventListener(k, fn) { (events[k] ||= []).push(fn); },
      dispatch(k) { if (k === "playing") this.paused = false; if (k === "pause" || k === "ended") this.paused = true; (events[k] || []).forEach(fn => fn({ type: k })); },
      play() { this.paused = false; return Promise.resolve(); }, pause() { const was = this.paused; this.paused = true; if (!was) this.dispatch("pause"); }, load() {}, querySelector() { return null; } };
    return e;
  }
  const win = { addEventListener() {}, PATVAvSync: {
    audio: input => publications.push(input), decorate() {}, latency: () => measured, onChange: cb => changes.push(cb)
  } };
  win.fetch = async url => { requests.push(url); return { json: async () => options.ticket || { ok: true, whep: "https://relay.test/whep/audio?pt=SECRET", ready: true } }; };
  if (options.rtc !== false) win.PATVRtc = { listen: (url, el, opts) => options.listen(url, el, opts) };
  const context = { window: win, document: { createElement: element, addEventListener() {}, hidden: false }, navigator: {}, fetch: win.fetch, console,
    sessionStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, String(v)) }, localStorage: { getItem: () => null, setItem() {} },
    setTimeout: (fn, ms) => { const t = { fn, ms, active: true }; timers.push(t); return t; }, clearTimeout: t => { if (t) t.active = false; },
    setInterval: (fn, ms) => { const t = { fn, ms, active: true }; intervals.push(t); return t; }, clearInterval: t => { if (t) t.active = false; }, requestAnimationFrame: () => 0, cancelAnimationFrame() {} };
  win.document = context.document; vm.runInNewContext(bridgeSource, context);
  const host = element("div"), player = win.PATVRoom.audio(host, "alpha", { showOff: true }); player.update({ room: { audio: true, live: true, rtc: true } });
  const box = host.children[0], audios = box.children.filter(e => e.tagName === "audio"), mode = box.children.find(e => e.classList.contains("rb-mode"));
  return { player, box, au: audios[0], rau: audios[1], mode, timers, intervals, publications, requests,
    measure(ms) { measured = ms; changes.forEach(fn => fn()); }, last: () => publications.at(-1),
    async settle() { for (let i = 0; i < 24; i++) await Promise.resolve(); },
    run(ms) { const timer = timers.filter(t => t.active && t.ms === ms).at(-1); assert.ok(timer, `timer ${ms}`); timer.active = false; timer.fn(); } };
}
function roomSession() { return { pc: { connectionState: "connected" }, close() { this.closed = true; }, onfail: null }; }

test("room player waits for actual RTC playing and its session, including playing before listen() resolves", async () => {
  let resolve; const session = roomSession();
  const s = bridgeSandbox({ listen: async (url, el) => { el.srcObject = {}; el.dispatch("playing"); return new Promise(done => { resolve = done; }); } });
  s.player.listen("alpha"); await s.settle();
  assert.ok(s.publications.length); assert.ok(s.publications.every(p => p.playing === false), "request/connecting/early playing without session never publishes true");
  resolve(session); await s.settle(); assert.equal(s.last().playing, true); assert.equal(s.last().pc, session.pc); assert.equal(s.last().mode, "rtc");
  // review fix: a brief stall keeps the sync, one past 4 s clears it; pause and ended (even mid-stall) clear at once
  const stallTimer = () => s.timers.some(t => t.active && t.ms === 4000);
  s.rau.dispatch("waiting"); assert.equal(s.last().playing, true, "a brief stall keeps the sync");
  s.rau.dispatch("playing"); assert.equal(s.last().playing, true); assert.equal(stallTimer(), false, "playing again cancels the stall");
  s.rau.dispatch("waiting"); s.au.dispatch("pause"); assert.equal(s.last().playing, true, "the idle MP3 element's late pause");
  s.run(4000); assert.equal(s.last().playing, false, "a stall past 4 s clears it (the other element's event never cancels it)");
  s.rau.dispatch("playing"); assert.equal(s.last().playing, true);
  for (const event of ["pause", "ended"]) {
    s.rau.dispatch("waiting"); s.rau.dispatch(event); assert.equal(s.last().playing, false, event); assert.equal(stallTimer(), false);
    s.rau.dispatch("playing"); assert.equal(s.last().playing, true);
  }
  s.measure(1789); assert.match(s.mode.title, /1\.8 s/); s.measure(null); assert.match(s.mode.title, /half a second/);
  s.player.listen("alpha"); assert.equal(s.last().playing, false);
});

test("room player resolved connection/play promises alone do not enable sync; only MP3 stalls past 4 s clear it", async () => {
  const rtc = bridgeSandbox({ listen: async (url, el) => { el.srcObject = {}; return roomSession(); } });
  rtc.player.listen("alpha"); await rtc.settle(); assert.ok(rtc.publications.every(p => !p.playing));
  rtc.rau.dispatch("playing"); assert.equal(rtc.last().playing, true);
  const s = bridgeSandbox({ rtc: false }); s.player.listen("alpha"); await s.settle();
  s.intervals.find(t => t.active && t.ms === 250).fn(); await s.settle();
  assert.ok(s.publications.every(p => !p.playing), "resolved MP3 play() is not an actual playing event");
  s.au.dispatch("playing"); assert.equal(s.last().playing, true); assert.equal(s.last().mode, "mp3"); assert.equal(s.last().ahead(), 1);
  // review fix: a brief stall keeps the sync, one past 4 s clears it; pause, ended, stop and a new start clear at once
  const stallTimer = () => s.timers.some(t => t.active && t.ms === 4000);
  s.au.dispatch("waiting"); assert.equal(s.last().playing, true, "a brief stall keeps the sync");
  s.au.dispatch("playing"); assert.equal(stallTimer(), false, "playing again cancels the stall");
  s.au.dispatch("waiting"); s.run(4000); assert.equal(s.last().playing, false, "a stall past 4 s clears it");
  s.au.dispatch("playing"); assert.equal(s.last().playing, true);
  for (const event of ["pause", "ended"]) {
    s.au.dispatch("waiting"); s.au.dispatch(event); assert.equal(s.last().playing, false, event); assert.equal(stallTimer(), false);
    s.au.dispatch("playing"); assert.equal(s.last().playing, true);
  }
  s.measure(2350); assert.match(s.mode.title, /2\.4 s/); s.measure(null); assert.match(s.mode.title, /1\.5 s/);
  s.au.dispatch("waiting"); s.player.listen("alpha"); assert.equal(s.last().playing, false, "stop clears at once"); assert.equal(stallTimer(), false, "and drops the stall");
  s.player.listen("alpha"); s.au.dispatch("playing"); assert.equal(s.last().playing, true);
  s.au.dispatch("waiting"); s.player.listen("beta"); assert.equal(s.last().playing, false, "a new start clears at once"); assert.equal(stallTimer(), false);
});

test("quiet MP3-to-RTC rejoin keeps audible MP3 during setup and ignores delayed old MP3 pauses", async () => {
  const first = roomSession(), second = roomSession(); let calls = 0, resolve;
  const s = bridgeSandbox({ listen: async (url, el) => {
    calls++; el.srcObject = {}; el.dispatch("playing");
    return calls === 1 ? first : new Promise(done => { resolve = done; });
  } });
  s.player.listen("alpha"); await s.settle(); assert.equal(s.last().mode, "rtc"); assert.equal(s.last().playing, true);
  first.onfail(); await s.settle(); assert.equal(s.last().playing, false); s.au.dispatch("playing");
  assert.equal(s.last().mode, "mp3"); assert.equal(s.last().playing, true);
  const start = s.publications.length; s.run(2500); await s.settle();
  assert.ok(s.publications.slice(start).every(p => p.playing && p.mode === "mp3"), "quiet setup never clears the active MP3");
  resolve(second); await s.settle(); assert.equal(s.last().playing, true); assert.equal(s.last().mode, "rtc"); assert.equal(s.last().pc, second.pc);
  s.au.dispatch("pause"); s.au.dispatch("ended"); assert.equal(s.last().playing, true, "late events belong to the inactive MP3 element");
});


test("C2 keyless anonymous panel counts retain drop timing in a mixed roster without borrowing named positions", async () => {
  const s = await gated(); let shown; const cb = d => { shown = plain(d); };
  const anon = { anon: true, display: "someone" }, named = { login: "a", display: "A" };
  shown = s.api.micView("pad", { members: [named, anon], mic: [anon] }, cb); await s.advance(700);
  assert.deepEqual(shown.mic.map(p => p.display), ["someone"]);
  shown = s.api.micView("pad", { members: [named, anon], mic: [] }, cb);
  assert.equal(shown.mic.length, 1, "generic anonymous release stays for D while an anonymous room entry remains");
  await s.advance(699); assert.equal(shown.mic.length, 1); await s.advance(1); assert.equal(shown.mic.length, 0);
});

test("1.99ahm: review fix (PRIV-L1) - a keyless someone's slot kept after the drop is a bare someone of its own veil level, never another member's object", async () => {
  const s = await gated(); let shown; const cb = d => { shown = plain(d); };
  const I = { anon: true, display: "someone", veil: "incognito" }, Hd = { anon: true, display: "someone", veil: "hidden", src: "list", rv: 1 }, Y = { login: "yname", display: "Y" };
  // veil.js orders alias-less veiled people by a keyed hash: here the hidden member (never on the mic) sorts before the incognito holder
  s.api.micView("pad", { members: [Y, Hd, { ...I, on_mic: true }], mic: [I] }, cb); await s.advance(2000);
  assert.deepEqual(shown.mic, [{ ...I, on_mic: true }], "holding: the holder's own entry");
  shown = plain(s.api.micView("pad", { members: [Y, Hd, I], mic: [] }, cb));
  assert.deepEqual(shown.mic, [{ anon: true, display: "someone", veil: "incognito", on_mic: true }], "dropped: one offset more as a bare someone · incognito (no src, no rv)");
  await s.advance(699); assert.deepEqual(shown.mic.map(p => p.veil), ["incognito"]);
  await s.advance(1); assert.deepEqual(shown.mic, []);
  // the holder drops and leaves the room: no incognito someone is left - the slot goes at once; the hidden member never stands in
  s.api.micView("pad", { members: [Y, Hd, { ...I, on_mic: true }], mic: [I] }, cb); await s.advance(2000); assert.equal(shown.mic.length, 1);
  shown = plain(s.api.micView("pad", { members: [Y, Hd], mic: [] }, cb)); assert.deepEqual(shown.mic, []);
  await s.advance(2000);
  // two keyless holders of different levels; the hidden one drops: for the offset each slot keeps its own level
  s.api.micView("pad", { members: [Y, { ...Hd, on_mic: true }, { ...I, on_mic: true }], mic: [Hd, I] }, cb); await s.advance(2000);
  assert.deepEqual(shown.mic.map(p => p.veil), ["hidden", "incognito"]);
  shown = plain(s.api.micView("pad", { members: [Y, Hd, { ...I, on_mic: true }], mic: [I] }, cb));
  assert.deepEqual(shown.mic.map(p => [p.display, p.veil]), [["someone", "hidden"], ["someone", "incognito"]]);
  assert.doesNotMatch(JSON.stringify(shown.mic), /"src"|"rv"/, "nothing copied from a member");
  await s.advance(700); assert.deepEqual(shown.mic, [{ ...I, on_mic: true }]);
});

test("C2 anonymous roster flags require their own explicit flag when there is no shared stable ID", async () => {
  const s = await gated(); let shown; const cb = d => { shown = plain(d); };
  const anon = { anon: true, display: "someone" };
  shown = s.api.micView("pad", { members: [anon], mic: [anon] }, cb); await s.advance(700);
  assert.equal(shown.mic.length, 1); assert.equal(shown.members[0].on_mic, false, "a panel slot is not evidence about a specific roster slot");
  shown = s.api.micView("pad", { members: [{ ...anon, on_mic: true }], mic: [anon] }, cb);
  assert.equal(shown.members[0].on_mic, false); await s.advance(700); assert.equal(shown.members[0].on_mic, true);
});

test("C2 retained anonymous panel count shrinks immediately with the newest room's anonymous count", async () => {
  const s = await gated(); let shown; const cb = d => { shown = plain(d); };
  const anon = { anon: true, display: "someone" }, named = { login: "a", display: "A" };
  shown = s.api.micView("pad", { members: [anon, named, anon], mic: [anon, anon] }, cb); await s.advance(700); assert.equal(shown.mic.length, 2);
  shown = s.api.micView("pad", { members: [named, anon], mic: [] }, cb); assert.equal(shown.mic.length, 1);
  shown = s.api.micView("pad", { members: [named], mic: [] }, cb); assert.equal(shown.mic.length, 0, "removed anonymous entries never reappear from history");
});

test("C2 stable anonymous IDs share exact timing between reordered mic and roster arrays", async () => {
  const s = await gated(); let shown; const cb = d => { shown = plain(d); };
  const a = { anon: true, id: "opaque-a", display: "someone" }, b = { anon: true, id: "opaque-b", display: "someone" };
  shown = s.api.micView("pad", { members: [a, b], mic: [b] }, cb); await s.advance(700);
  assert.deepEqual(shown.members.map(p => p.on_mic), [false, true]);
  shown = s.api.micView("pad", { members: [b, a], mic: [] }, cb);
  assert.equal(shown.mic[0].id, "opaque-b"); assert.deepEqual(plain(shown.members.map(p => p.on_mic)), [true, false]);
  shown = s.api.micView("pad", { members: [a], mic: [] }, cb); assert.equal(shown.mic.length, 0);
});

test("wave2 WP-4 (F.3): the dynamic layout's ring is delayed like newest; dyn follows the delayed view (the page re-fits the template when its n differs)", async () => {
  const s = await gated(); let shown; const cb = p => { shown = plain(p); };
  const dynP = (ids, ring, main) => { const p = program(ids, { dyn: { n: ids.length, t: "d" + ids.length, main } }); p.src.forEach((x) => { if (ring.includes(x.id)) x.ring = true; }); return p; };
  s.api.gateProgram("pad", dynP(["a"], [], "a"), cb); await s.advance(700);
  assert.equal(shown.src[0].ring, undefined);
  s.api.gateProgram("pad", dynP(["a"], ["a"], "a"), cb);
  assert.equal(shown.src[0].ring, undefined, "not before the sound catches up");
  await s.advance(700); assert.equal(shown.src[0].ring, true, "then the ring");
  s.api.gateProgram("pad", dynP(["a", "b"], ["a", "b"], "b"), cb);
  assert.equal(shown.src.length, 1, "b is born later");
  assert.deepEqual(shown.dyn, { n: 1, t: "d1", main: "a" }, "the delayed view's own dyn (n = what it shows)");
  await s.advance(700); assert.equal(shown.src.length, 2); assert.equal(shown.dyn.main, "b");
});

test("C1 follows the delayed newest/recent merge table for a short grab retained as a recent tile", async () => {
  const s = await gated(); let shown; const cb = p => { shown = plain(p); };
  s.api.gateProgram("pad", program(["a"]), cb); await s.advance(200);
  const recent = program(["a"], { count: 0, active: false }); recent.src[0].newest = false; recent.src[0].recent = true;
  s.api.gateProgram("pad", recent, cb); await s.advance(500);
  assert.equal(shown.src[0].newest, true); assert.equal(shown.src[0].recent, false);
  await s.advance(200); assert.equal(shown.src[0].newest, false); assert.equal(shown.src[0].recent, true);
});

// 1.99ahm: "Delay the On the mic card" (apply.mic_card) and "Delay mic grab/drop lines in chat" (apply.mic_chat) - each its own switch,
// the same mic-sign offset as "Delay mic signs" (apply.mic), the same who / audio-playing rules
test("1.99ahm: the card and chat-line switches are their own - an old server (no such keys) or a switch off hands the card back as given and holds no line", async () => {
  const s = await gated({ config: { apply: { video: true, mic: true, mp3: true } } });
  const cb = () => {}, raw = roster(["a"]);
  assert.equal(s.api.micView("pad", raw, cb), raw, "old server: the card is today's");
  const line = s.element("div"); s.document.body.appendChild(line); line.style.display = "flex";
  assert.equal(s.api.holdLine("pad", line), false); assert.equal(line.style.display, "flex", "old server: the line shows at once");
  assert.equal(s.api.gateProgram("pad", program(["a"]), cb).src.length, 0, "Delay mic signs still holds the mic stage back");
  assert.deepEqual([s.api.debug().indicator_ms, s.api.debug().card_ms, s.api.debug().chat_ms], [700, 0, 0]);
  s.config.apply.mic_card = true; await s.advance(5000);
  let shown; const view = d => { shown = plain(d); };
  shown = plain(s.api.micView("pad", roster(["a", "b"]), view));
  assert.deepEqual(shown.mic.map(p => p.login), ["a"], "the card switch alone: b waits for the audio");
  assert.equal(s.api.holdLine("pad", line), false, "... and chat lines are not held");
  await s.advance(699); assert.deepEqual(shown.mic.map(p => p.login), ["a"]);
  await s.advance(1); assert.deepEqual(shown.mic.map(p => p.login), ["a", "b"], "the same offset as the mic signs (700 ms)");
  s.config.apply.mic = false; s.config.apply.mic_card = false; s.config.apply.mic_chat = true; await s.advance(5000);
  const p = program(["x"]); assert.equal(s.api.gateProgram("pad", p, cb), p, "Delay mic signs off: the stage is immediate");
  const r2 = roster(["c"]); assert.equal(s.api.micView("pad", r2, view), r2, "the card switch off: immediate");
  assert.equal(s.api.holdLine("pad", line), true, "the chat switch alone holds lines"); assert.equal(line.style.display, "none");
  await s.advance(699); assert.equal(line.style.display, "none"); await s.advance(1); assert.equal(line.style.display, "flex");
  s.config.on = false; await s.advance(5000);
  const late = s.element("div"); s.document.body.appendChild(late);
  assert.equal(s.api.holdLine("pad", late), false, "sync not for this viewer: nothing held"); assert.equal(late.style.display, undefined);
});

test("1.99ahm: held chat lines show in their place once the audio catches up, and at once on a hidden or frozen tab, leaving, or the audio stopping; never a line outside the page", async () => {
  const s = await gated(); const host = s.element("div"); s.document.body.appendChild(host);
  const mk = (text) => { const e = s.element("div"); e.textContent = text; host.appendChild(e); return e; };
  const reveals = [];
  const reveal = (el, show) => { const r = { el, before: el.style.display }; show(); r.after = el.style.display; reveals.push(r); };
  const grab = mk("🎙️ Soggy Bullfrog grabbed the mic"), typed = mk("typed after it");
  assert.equal(s.api.holdLine("pad", grab, reveal), true);
  assert.equal(grab.style.display, "none"); assert.equal(typed.style.display, undefined, "typed chat is never touched");
  assert.deepEqual(grab.attrs, {}, "a held line carries no attribute (no login, no data-*)");
  assert.equal(s.api.holdLine("pad", grab, reveal), false, "never held twice");
  await s.advance(699); assert.equal(grab.style.display, "none"); assert.equal(reveals.length, 0);
  await s.advance(1); assert.equal(grab.style.display, ""); assert.deepEqual(host.children, [grab, typed], "in its true place, before the newer line");
  assert.deepEqual(reveals.map(r => [r.el === grab, r.before, r.after]), [[true, "none", ""]], "the page's reveal runs once, around the show");
  assert.equal(grab._patvAvSyncHeld, undefined);
  const loose = s.element("div"); assert.equal(s.api.holdLine("pad", loose), false, "a line not in the page yet is never held (it could not be shown)");
  assert.equal(loose.style.display, undefined);
  const a = mk("a"), b = mk("b"); s.api.holdLine("pad", a); s.api.holdLine("pad", b);
  s.document.hidden = true; s.docEvent("visibilitychange"); assert.deepEqual([a.style.display, b.style.display], ["", ""], "a hidden tab shows them at once");
  const c = mk("c"); assert.equal(s.api.holdLine("pad", c), false, "nothing is held while hidden"); assert.equal(c.style.display, undefined);
  s.document.hidden = false; s.docEvent("visibilitychange");
  const f = mk("f"); s.api.holdLine("pad", f); s.docEvent("freeze"); assert.equal(f.style.display, "", "a frozen tab too");
  const g = mk("g"); s.api.holdLine("pad", g); s.api.audio({ slug: "pad", mode: "mp3", playing: false }); assert.equal(g.style.display, "", "the audio stopping");
  s.media("mp3", "pad", { ahead: () => 0 }); await s.advance(0);
  const h = mk("h"); assert.equal(s.api.holdLine("pad", h, () => { throw new Error("page bug"); }), true);
  const gone = mk("gone"); s.api.holdLine("pad", gone); host.removeChild(gone);
  await s.advance(700); assert.equal(h.style.display, "", "a reveal that throws still shows the line"); assert.ok(!host.children.includes(gone), "a line the page took out stays out");
  const box = s.element("div"); s.document.body.appendChild(box); s.api.decorate(box);
  const t = mk("t"); s.api.holdLine("pad", t); box.children[0].click(); assert.equal(t.style.display, "", "the viewer's own toggle off");
  box.children[0].click(); const l = mk("l"); s.api.holdLine("pad", l); s.event("pagehide"); assert.equal(l.style.display, "", "leaving the page");
});

test("1.99ahm: review fix (T1) - when the offset rises, a turn already on the card stays until its drop catches up - in step with its held drop line", async () => {
  const s = await gated(); let shown; const cb = d => { shown = plain(d); };
  const host = s.element("div"); s.document.body.appendChild(host);
  const on = () => shown.mic.map(p => p.login);
  shown = plain(s.api.micView("pad", roster([]), cb));
  await s.advance(3800); shown = plain(s.api.micView("pad", roster(["a"]), cb));     // a grabs at +3800 (offset 700)
  await s.advance(700); assert.deepEqual(on(), ["a"], "on the card at +4500");
  await s.advance(450); shown = plain(s.api.micView("pad", roster([]), cb));          // and drops at +4950: a 1150 ms turn
  const dropLine = s.element("div"); host.appendChild(dropLine);
  assert.equal(s.api.holdLine("pad", dropLine), true, "its drop line is held");
  s.config.audio.mp3_ms = 2000;                                                        // the settings check at +5000: offset 1700
  await s.advance(50); assert.equal(s.api.debug().card_ms, 1700); assert.deepEqual(on(), ["a"]);
  await s.advance(1649); assert.deepEqual(on(), ["a"], "still on at +6649 (the old minimum-hold rule took a off at +5500)");
  assert.equal(dropLine.style.display, "none");
  await s.advance(1); assert.deepEqual(on(), [], "off at +6650 = the drop + the new offset"); assert.equal(dropLine.style.display, "", "the same moment as its drop line");
});

test("1.99ahm: review fix (T3) - caughtUp: a backlog answer's card, stage tiles and held lines show as they are now; changes after it wait the offset", async () => {
  const s = await gated(); let card, stage; const host = s.element("div"); s.document.body.appendChild(host);
  const view = d => { card = plain(d); }, show = p => { stage = plain(p); };
  const mic = () => card.mic.map(p => p.login), tiles = () => stage.src.map(t => t.id);
  s.api.micView("pad", roster(["a"]), view); s.api.gateProgram("pad", program(["a"]), show);
  await s.advance(2000); assert.deepEqual([mic(), tiles()], [["a"], ["a"]]);
  const older = s.element("div"); host.appendChild(older); assert.equal(s.api.holdLine("pad", older), true);   // a live line, still held
  await s.advance(100);
  // the backlog: a dropped, b on - long ago
  card = plain(s.api.micView("pad", roster(["b"]), view)); stage = plain(s.api.gateProgram("pad", program(["b"]), show));
  assert.deepEqual([mic(), tiles()], [["a"], []], "drawn as a live answer first");
  s.api.caughtUp("pad");
  assert.deepEqual(mic(), ["b"], "the card as it is now"); assert.deepEqual(tiles(), ["b"], "the stage too");
  assert.equal(older.style.display, "", "a line still held shows");
  // after it (the page's next answer comes 50 ms+ later), the offset as before
  await s.advance(50);
  card = plain(s.api.micView("pad", roster(["b", "a"]), view)); assert.deepEqual(mic(), ["b"]);
  const later = s.element("div"); host.appendChild(later); assert.equal(s.api.holdLine("pad", later), true);
  await s.advance(699); assert.deepEqual(mic(), ["b"]); assert.equal(later.style.display, "none");
  await s.advance(1); assert.deepEqual(mic(), ["b", "a"]); assert.equal(later.style.display, "");
});

test("1.99ahm: with only the card / chat switches on, the audio is still measured (not the whole fallback) and the viewer's toggle is offered", async () => {
  const s = sandbox({ config: { apply: { video: false, mic: false, mp3: true, mic_card: true, mic_chat: false } } });
  s.api.pad("pad"); const box = s.element("div"); s.document.body.appendChild(box); s.api.decorate(box);
  s.media("rtc"); await s.advance(0);
  assert.equal(s.api.debug().card_ms, 500, "first RTC stats have no interval: the whole fallback");
  await s.advance(2000); assert.equal(s.api.debug().card_ms, 900, "measured: 1000 + 200 - 300");
  assert.deepEqual([s.api.debug().indicator_ms, s.api.debug().chat_ms], [0, 0]);
  assert.equal(box.children[0].hidden, false, "the viewer can turn it off");
  box.children[0].click(); assert.equal(s.api.debug().card_ms, 0, "their toggle off: nothing held");
});

// 1.99ahm: "Delay the people list's 🎙 icons" (apply.mic_list) - micView's members: the pad page's people list (its 🎙 icons and on-mic
// order) and the homepage panel's mic chips. Its own switch; the same mic-sign offset and the same who / audio-playing rules.
test("1.99ahm: the people-list switch is its own - micView's members follow apply.mic_list, its mic the card's switch; off, or an older site: the list as given", async () => {
  const s = await gated({ config: { apply: { video: true, mic: true, mp3: true, mic_card: true, mic_chat: true } } });   // an older site: no mic_list
  let shown; const view = d => { shown = plain(d); };
  const lit = () => shown.members.filter(p => p.on_mic).map(p => p.login);
  s.api.micView("pad", roster([]), view); await s.advance(1000);
  let r = roster(["a"]), out = s.api.micView("pad", r, view);
  assert.equal(out.members, r.members, "an older site: the list is today's - the very array the page gave");
  assert.equal(out.mic.length, 0, "... while the card waits");
  assert.equal(s.api.debug().list_ms, 0);
  await s.advance(700);
  s.config.apply.mic_card = false; s.config.apply.mic_list = true; await s.advance(5000);
  assert.deepEqual([s.api.debug().card_ms, s.api.debug().list_ms, s.api.debug().indicator_ms], [0, 700, 700]);
  r = roster(["a", "b"]); out = s.api.micView("pad", r, view); shown = plain(out);
  assert.equal(out.mic, r.mic, "the card's switch off: the card is today's");
  assert.deepEqual(lit(), ["a"], "b's 🎙 waits for the audio");
  await s.advance(699); assert.deepEqual(lit(), ["a"]);
  await s.advance(1); assert.deepEqual(lit(), ["a", "b"], "the same offset as the mic signs (700 ms)");
  assert.deepEqual(shown.members.map(p => [p.display, p.can]), [["A", "current"], ["B", "current"]], "today's people, names and data");
  // the viewer's own toggle off: today's list at once; on again: held again
  const box = s.element("div"); s.document.body.appendChild(box); s.api.decorate(box);
  r = roster(["b"]); s.api.micView("pad", r, view); assert.deepEqual(lit(), ["a", "b"]);
  box.children[0].click(); assert.deepEqual(lit(), ["b"], "the toggle off: a's 🎙 goes out at once");
  assert.equal(s.api.micView("pad", r, view), r, "and micView hands back what it was given");
  box.children[0].click();
  // the switch off: as given
  s.config.apply.mic_list = false; await s.advance(5000);
  r = roster(["a"]); assert.equal(s.api.micView("pad", r, view), r, "both switches off: as given");
  // sync not for this viewer
  s.config.apply.mic_list = true; s.config.on = false; await s.advance(5000);
  r = roster(["b"]); assert.equal(s.api.micView("pad", r, view), r, "mode not for this viewer: as given");
  // only the list's switch on: the audio is measured for it and the viewer's toggle is offered
  const t = sandbox({ config: { apply: { video: false, mic: false, mp3: true, mic_card: false, mic_chat: false, mic_list: true } } });
  t.api.pad("pad"); const tb = t.element("div"); t.document.body.appendChild(tb); t.api.decorate(tb);
  t.media("rtc"); await t.advance(0);
  assert.equal(t.api.debug().list_ms, 500, "first RTC stats have no interval: the whole fallback");
  await t.advance(2000); assert.equal(t.api.debug().list_ms, 900, "measured: 1000 + 200 - 300");
  assert.deepEqual([t.api.debug().indicator_ms, t.api.debug().card_ms, t.api.debug().chat_ms], [0, 0, 0]);
  assert.equal(tb.children[0].hidden, false, "the viewer can turn it off");
  tb.children[0].click(); assert.equal(t.api.debug().list_ms, 0, "their toggle off: nothing held");
});

test("1.99ahm: people list privacy - an alias-less veiled holder's 🎙 stays one offset on a keyless person of the same veil level, never by position", async () => {
  const s = await gated(); let shown; const cb = d => { shown = plain(d); };
  const I = { anon: true, display: "someone", veil: "incognito" }, Hd = { anon: true, display: "someone", veil: "hidden", src: "list" };
  const H2 = { anon: true, display: "someone", veil: "hidden", src: "seen" }, Y = { login: "yname", display: "Y" };
  const lit = () => shown.members.filter(p => p.on_mic).map(p => p.veil || p.login);
  s.api.micView("pad", { members: [Y, Hd, { ...I, on_mic: true }], mic: [I] }, cb); await s.advance(2000);
  assert.deepEqual(lit(), ["incognito"]);
  // the holder drops as a hidden someone joins: veil.js's keyed-hash order puts the newcomer before them, so the incognito someone
  // is no longer the 2nd keyless entry - the 2nd is now the hidden someone who never held the mic
  shown = plain(s.api.micView("pad", { members: [Y, H2, Hd, I], mic: [] }, cb));
  assert.deepEqual(lit(), ["incognito"], "for one offset the incognito someone keeps the 🎙 - not the hidden someone now in that position");
  assert.deepEqual(shown.members.map(p => { const c = { ...p }; delete c.on_mic; return c; }), [Y, H2, Hd, I], "today's people as given: nothing from history");
  await s.advance(699); assert.deepEqual(lit(), ["incognito"]);
  await s.advance(1); assert.deepEqual(lit(), [], "then out - with the card's someone and the drop line");
  // a holder who drops and leaves: no incognito someone is left - the 🎙 goes at once, never onto a hidden one
  s.api.micView("pad", { members: [Y, Hd, { ...I, on_mic: true }], mic: [I] }, cb); await s.advance(2000); assert.deepEqual(lit(), ["incognito"]);
  shown = plain(s.api.micView("pad", { members: [Hd, Y, H2], mic: [] }, cb)); assert.deepEqual(lit(), []);
  await s.advance(2000);
  // two keyless people of one level, one grabs: one of them lights one offset later (today's holder first); the other level never
  s.api.micView("pad", { members: [Y, Hd, H2, I], mic: [] }, cb); await s.advance(2000);
  shown = plain(s.api.micView("pad", { members: [Y, Hd, { ...H2, on_mic: true }, I], mic: [H2] }, cb)); assert.deepEqual(lit(), []);
  await s.advance(700); assert.deepEqual(shown.members.map(p => !!p.on_mic), [false, false, true, false], "the hidden someone who holds it now");
});

test("1.99ahm: the list, the card and the held grab/drop lines agree - one moment for all three, when the offset rises, and on caughtUp", async () => {
  const s = await gated(); let shown; const cb = d => { shown = plain(d); };
  const host = s.element("div"); s.document.body.appendChild(host);
  const card = () => shown.mic.map(p => p.login), list = () => shown.members.filter(p => p.on_mic).map(p => p.login);
  shown = plain(s.api.micView("pad", roster([]), cb));
  await s.advance(3800); shown = plain(s.api.micView("pad", roster(["a"]), cb));     // a grabs at +3800 (offset 700)
  const grabLine = s.element("div"); host.appendChild(grabLine); assert.equal(s.api.holdLine("pad", grabLine), true);
  await s.advance(699); assert.deepEqual([card(), list(), grabLine.style.display], [[], [], "none"]);
  await s.advance(1); assert.deepEqual([card(), list(), grabLine.style.display], [["a"], ["a"], ""], "card, list and line at +4500");
  await s.advance(450); shown = plain(s.api.micView("pad", roster([]), cb));          // drops at +4950
  const dropLine = s.element("div"); host.appendChild(dropLine); assert.equal(s.api.holdLine("pad", dropLine), true);
  s.config.audio.mp3_ms = 2000;                                                        // the settings check at +5000: offset 1700
  await s.advance(50); assert.deepEqual([s.api.debug().card_ms, s.api.debug().list_ms], [1700, 1700]);
  await s.advance(1649); assert.deepEqual([card(), list(), dropLine.style.display], [["a"], ["a"], "none"]);
  await s.advance(1); assert.deepEqual([card(), list(), dropLine.style.display], [[], [], ""], "all three at +6650 = the drop + the new offset");
  // a backlog answer: the list is drawn as it is now with the card
  await s.advance(100);
  shown = plain(s.api.micView("pad", roster(["b"]), cb)); assert.deepEqual([card(), list()], [[], []]);
  s.api.caughtUp("pad"); assert.deepEqual([card(), list()], [["b"], ["b"]]);
});

test("1.99ahp stable slots: a stable program's places are delayed with it - an exchange of places (the dynamic main cell) shows when the voices do, never ahead of its main; without stable the latest places as before", async () => {
  const prog = (order, extra = {}) => ({ v: 1, src: order.map(([id, pos]) => ({ id, name: id.toUpperCase(), pos, newest: false, recent: false, video: "live", watch: "ok" })),
    count: order.length, active: true, layout: "grid4", dyn: { n: order.length, t: "d" + order.length, main: order.find(o => o[1] === 0)[0] }, manage: { layout_override: null }, fixed: true, stable: true, ...extra });
  const at = p => p.src.map(t => t.id + "@" + t.pos).sort().join(" ");
  let s = await gated(), shown; const cb = p => { shown = plain(p); };
  s.api.gateProgram("pad", prog([["a", 0], ["b", 1], ["c", 2]]), cb); await s.advance(700);
  assert.equal(at(shown), "a@0 b@1 c@2"); assert.equal(shown.dyn.main, "a");
  // the server: c takes the main cell - c and a trade places
  s.api.gateProgram("pad", prog([["c", 0], ["b", 1], ["a", 2]]), cb);
  assert.equal(at(shown), "a@0 b@1 c@2", "the places of then"); assert.equal(shown.dyn.main, "a", "with the main of then");
  await s.advance(700);
  assert.equal(at(shown), "a@2 b@1 c@0", "the exchange shows with the voices"); assert.equal(shown.dyn.main, "c");
  // a pin shown at once keeps its own place (the page gives a shared place's second claimant the next free cell)
  const withPin = prog([["c", 0], ["b", 1], ["a", 2], ["p", 3]]); withPin.src[3].pin = true;
  s.api.gateProgram("pad", withPin, cb);
  assert.equal(at(shown), "a@2 b@1 c@0 p@3", "the pin at once, at its own place");
  // without stable (the knob off): the latest places at once, as before
  s = await gated();
  const off = order => { const p = prog(order); delete p.stable; return p; };
  s.api.gateProgram("pad", off([["a", 0], ["b", 1], ["c", 2]]), cb); await s.advance(700);
  s.api.gateProgram("pad", off([["c", 0], ["b", 1], ["a", 2]]), cb);
  assert.equal(at(shown), "a@2 b@1 c@0", "off: today's (latest places)"); assert.equal(shown.dyn.main, "a");
});

// 1.99?? avf (F2): the viewer's toggle had one label, "Sync cams to the audio", on or off (only aria-pressed changed, and no CSS
// styled it), so a click meant to sync turned it off - the owner debugged A/V sync with it off
test("1.99?? avf (F2): the toggle shows its state - its label says on / off, the on class, a title naming the cams and the mic signs; the debug panel's first line says sync for you ON / OFF", async () => {
  const s = sandbox({ search: "?avsync=1", config: { dbg: true }, stored: { "patv.avsync.enabled": "0" } });
  s.api.pad("pad"); const box = s.element("div"); s.document.body.appendChild(box); s.api.decorate(box);
  s.tile(); s.media("rtc"); await s.advance(0);
  const button = box.children[0], classes = () => String(button.className || "").split(/\s+/);
  const pre = () => s.document.body.children.find((e) => e.tagName === "ASIDE").children[2].textContent, first = () => pre().split("\n")[0];
  assert.equal(button.hidden, false, "offered");
  assert.equal(button.textContent, "Sync to the audio: off"); assert.ok(classes().includes("rb-btn") && classes().includes("rb-avsync"));
  assert.ok(!classes().includes("on")); assert.equal(button.attrs["aria-pressed"], "false");
  assert.match(button.title, /cams and the mic signs/);
  assert.equal(first(), "sync for you: OFF (your toggle)");
  assert.ok(pre().includes("pepe_ms"), "the measurements follow");
  button.click();
  assert.equal(button.textContent, "Sync to the audio: on"); assert.ok(classes().includes("on")); assert.equal(button.attrs["aria-pressed"], "true");
  assert.equal(s.storage.get("patv.avsync.enabled"), "1"); assert.equal(first(), "sync for you: ON (your toggle)");
  s.event("storage", { key: "patv.avsync.enabled", newValue: "0" });
  assert.equal(button.textContent, "Sync to the audio: off", "another tab turned it off: this tab's button says so"); assert.ok(!classes().includes("on"));
  await s.advance(2000); assert.equal(button.textContent, "Sync to the audio: off", "each tick keeps it");
  // the CSS styles the on state (the attribute and the class) on this button only - the play and mute buttons use aria-pressed too
  const css = fs.readFileSync(path.join(__dirname, "../public/css/room-bridge.css"), "utf8");
  assert.match(css, /\.rb-btn\.rb-avsync\[aria-pressed="true"\], \.rb-btn\.rb-avsync\.on \{[^}]*border-color: var\(--ds-green\)[^}]*color: var\(--ds-green-2\)/);
  assert.match(css, /@media \(forced-colors: active\) \{\s*\.rb-btn\.rb-avsync\[aria-pressed="true"\]/, "high contrast too");
  assert.doesNotMatch(css, /(^|[,}\s])\.rb-btn\[aria-pressed/, "never every .rb-btn");
  // every string has its English text in locales/en.json (the other languages sync from it), and the JS fallback is that text
  const EN = JSON.parse(fs.readFileSync(path.join(__dirname, "../locales/en.json"), "utf8"));
  let n = 0;
  for (const m of source.matchAll(/translate\('(js\.[a-z0-9_.]+)', '((?:[^'\\]|\\.)*)'\)/g)) { n++; assert.equal(EN[m[1]], m[2], m[1]); }
  assert.ok(n >= 9, "the new strings are checked: " + n);
});

test("1.99?? avf (F4): unmeasured, the mic signs use their own fallback (not the cams' 500); the last measured latency is kept 30 s through a lull, then each falls back", async () => {
  const audio = { rtc_ms: 2400, mp3_ms: 1000, mix_ms: 700, helper_ms: 1500, age_s: 0 };
  const s = sandbox({ config: { audio, fallback_ind: { rtc: 2000, mp3: 3000 } } });
  s.api.pad("pad"); const a = s.tile(); s.media("rtc"); await s.advance(0);
  const d = () => s.api.debug();
  assert.deepEqual([d().card_ms, d().indicator_ms, a.rx.writes.at(-1)], [2000, 2000, 500], "first RTC stats have no interval: the mic signs' 2000, the cams' own 500");
  assert.equal(d().calibration.fallback_ind_ms, 2000);
  await s.advance(2000);
  assert.deepEqual([d().card_ms, a.rx.writes.at(-1)], [2300, 2600], "measured: 2400 + 200 - 300; the cam 2400 - 200 + 100 + 200 + 100");
  s.config.audio.rtc_ms = null;                                   // nobody heard for ~5 s: Pepe reports no latency
  await s.advance(3000);                                          // +5000: the settings check brings it
  assert.deepEqual([d().audio.pepe_ms, d().audio.pepe_held_ms], [null, 2400]);
  assert.deepEqual([d().card_ms, a.rx.writes.at(-1)], [2300, 2600], "the last measured value is kept: the next grab isn't 1.8 s early, the cams don't step");
  await s.advance(24000); assert.deepEqual([d().card_ms, a.rx.writes.at(-1)], [2300, 2600], "for up to 30 s");
  await s.advance(3000);                                          // +32000
  assert.deepEqual([d().card_ms, a.rx.writes.at(-1), d().audio.pepe_held_ms], [2000, 500, null], "then the fallbacks - the mic signs' 2000, the cams' 500");
  s.config.audio.rtc_ms = 2600; await s.advance(5000); assert.equal(d().card_ms, 2500, "measured again");
  s.media("rtc"); assert.equal(d().card_ms, 2000, "a new audio connection: the mic signs' fallback until it is measured, not 500");
  await s.advance(0); assert.equal(d().card_ms, 2000); await s.advance(2000); assert.equal(d().card_ms, 2500);
  // MP3: its own fallback, up to 5000 (the cap allowing)
  const m = sandbox({ config: { cap_ind: 5000, fallback_ind: { rtc: 2000, mp3: 4500 } } });
  m.api.pad("pad"); m.media("mp3", "pad", { ahead: () => null }); await m.advance(0);
  assert.equal(m.api.debug().card_ms, 4500, "MP3 unmeasured: fallback_ind_mp3_ms");
  // an older site (no fallback_ind): the shared fallback, as before
  const o = sandbox(); o.api.pad("pad"); o.media("rtc"); await o.advance(0); assert.equal(o.api.debug().card_ms, 500);
});

test("1.99?? avf (F4): turning the toggle on starts the mic signs at their own fallback, then the measured value", async () => {
  const s = sandbox({ stored: { "patv.avsync.enabled": "0" }, config: { audio: { rtc_ms: 2400, mp3_ms: 1000, mix_ms: 700, helper_ms: 1500, age_s: 0 }, fallback_ind: { rtc: 2000, mp3: 3000 } } });
  s.api.pad("pad"); const box = s.element("div"); s.document.body.appendChild(box); s.api.decorate(box);
  s.media("rtc"); await s.advance(4000);
  assert.deepEqual([s.api.debug().enabled, s.api.debug().card_ms], [false, 0], "off: nothing held");
  box.children[0].click(); assert.equal(s.api.debug().card_ms, 2000, "on: the mic signs' fallback at once (it was the cams' 500)");
  await s.advance(0); assert.equal(s.api.debug().card_ms, 2000);
  await s.advance(2000); assert.equal(s.api.debug().card_ms, 2300, "then measured");
});

// 1.99?? avf (F5): mic_follow_toggle - an admin setting (true = as before: the viewer's toggle governs the cams AND the mic signs)
test("1.99?? avf (F5): mic_follow_toggle false - the mic signs are held with the viewer's toggle off (the room audio still measured: rtc + browser - delivery); the toggle holds the cams only", async () => {
  const s = sandbox({ stored: { "patv.avsync.enabled": "0" }, search: "?avsync=1",
    config: { dbg: true, mic_follow_toggle: false, audio: { rtc_ms: 2400, mp3_ms: 1000, mix_ms: 700, helper_ms: 1500, age_s: 0 }, fallback_ind: { rtc: 2000, mp3: 3000 } } });
  s.api.pad("pad"); const box = s.element("div"); s.document.body.appendChild(box); s.api.decorate(box);
  s.media("rtc"); await s.advance(0);
  const d = () => s.api.debug(), signs = () => [d().indicator_ms, d().card_ms, d().chat_ms, d().list_ms];
  assert.deepEqual(signs(), [2000, 2000, 2000, 2000], "unmeasured: the mic signs' fallback");
  await s.advance(2000);
  assert.deepEqual(signs(), [2300, 2300, 2300, 2300], "the room audio is sampled with the toggle off: 2400 + 200 - 300");
  assert.deepEqual([d().enabled, d().mic_follow_toggle, d().audio.browser_ms], [false, false, 200]);
  const a = s.tile(); await s.advance(0); assert.equal(a.rx.writes.at(-1), null, "the toggle off: no cam delay");
  const button = box.children[0];
  assert.equal(button.hidden, false, "offered for the cams"); assert.equal(button.textContent, "Sync to the audio: off");
  assert.match(button.title, /^Holds the cams back/); assert.match(button.title, /mic signs are held for everyone/);
  const panel = s.document.body.children.find((e) => e.tagName === "ASIDE");
  assert.equal(panel.children[2].textContent.split("\n")[0], "sync for you: OFF (your toggle) · mic signs: held for everyone");
  // the chat's grab / drop line, the card and the people list wait for the audio
  const host = s.element("div"); s.document.body.appendChild(host);
  const line = s.element("div"); host.appendChild(line); line.style.display = "flex";
  assert.equal(s.api.holdLine("pad", line), true); assert.equal(line.style.display, "none");
  let shown; const view = (v) => { shown = plain(v); };
  s.api.micView("pad", roster([]), view); await s.advance(2299);
  assert.equal(line.style.display, "none");
  shown = plain(s.api.micView("pad", roster(["a"]), view)); assert.deepEqual([shown.mic.length, shown.members[0].on_mic], [0, false], "a's grab waits");
  await s.advance(1); assert.equal(line.style.display, "flex", "the line shows once the audio caught up (2300 ms)");
  await s.advance(2300); assert.deepEqual([shown.mic.map((p) => p.login), shown.members[0].on_mic], [["a"], true]);
  // on: the cams too; off again: the cams go back, the signs stay held
  button.click(); await s.advance(2000); assert.equal(a.rx.writes.at(-1), 2600);
  assert.equal(button.textContent, "Sync to the audio: on");
  button.click(); assert.equal(a.rx.writes.at(-1), null, "the toggle off releases the cams");
  assert.deepEqual(signs(), [2300, 2300, 2300, 2300], "... and only the cams");
  const later = s.element("div"); host.appendChild(later); assert.equal(s.api.holdLine("pad", later), true, "a line is still held");
  // no cam: nothing left for the toggle to hold - hidden
  a.pc.close(); await s.advance(2000); assert.equal(button.hidden, true);
  // the default (true): the toggle releases the signs, as before
  s.config.mic_follow_toggle = true; await s.advance(5000);
  assert.deepEqual(signs(), [0, 0, 0, 0], "mic_follow_toggle on: the viewer's toggle off holds nothing");
  assert.equal(later.style.display, "", "the held line shows at once");
  assert.equal(button.hidden, false, "the toggle is offered again (it governs the mic signs)"); assert.match(button.title, /cams and the mic signs/);
});

// 1.99?? avf review (product): the toggle's title and the debug panel's first line say what it holds for THIS viewer - a Firefox
// or Safari viewer (engine_firefox / engine_safari off: no cam delay) was told it holds the cams, and with mic_follow_toggle off
// and no mic switch on, "the mic signs are held for everyone" though nothing held them
test("1.99?? avf review: the toggle's title names only what it holds here - no cams on an engine that isn't enabled; 'held for everyone' only while a mic switch holds them", async () => {
  const f = sandbox({ ua: "Firefox/140.0", search: "?avsync=1", config: { dbg: true } });
  f.api.pad("pad"); const fbox = f.element("div"); f.document.body.appendChild(fbox); f.api.decorate(fbox);
  f.media("rtc"); await f.advance(2000);
  const fb = fbox.children[0];
  assert.equal(fb.hidden, false, "offered: the mic signs follow the toggle");
  assert.match(fb.title, /^Holds the mic signs/); assert.doesNotMatch(fb.title, /cams/, "Firefox's cams aren't delayed (engine_firefox off)");
  // Chrome, mic_follow_toggle off and none of the mic switches on: the cams only, nothing "held for everyone"
  const c = sandbox({ search: "?avsync=1", config: { dbg: true, mic_follow_toggle: false,
    apply: { video: true, mic: false, mp3: true, mic_card: false, mic_chat: false, mic_list: false } } });
  c.api.pad("pad"); const cbox = c.element("div"); c.document.body.appendChild(cbox); c.api.decorate(cbox);
  c.tile(); c.media("rtc"); await c.advance(2000);
  const cb = cbox.children[0], first = () => c.document.body.children.find((e) => e.tagName === "ASIDE").children[2].textContent.split("\n")[0];
  assert.equal(cb.hidden, false);
  assert.equal(cb.title, "Holds the cams back to match the room audio you hear."); assert.doesNotMatch(cb.title, /mic signs/);
  assert.equal(first(), "sync for you: ON (your toggle)", "no 'mic signs: held for everyone' when no switch holds them");
  // a mic switch on again: they are held for everyone, and both say so
  c.config.apply.mic_card = true; await c.advance(5000);
  assert.match(cb.title, /mic signs are held for everyone/); assert.equal(first(), "sync for you: ON (your toggle) · mic signs: held for everyone");
});
