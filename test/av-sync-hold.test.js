// iosdelay (1.99alg): public/js/av-sync-hold.js - the worker that holds a cam's encoded frames where the browser has no delay of its own
// (Safari / iPhone / iPad before iOS 27; every iPhone browser, Chrome too). Run in a vm with a fake clock, fake timers and fake
// RTCRtpScriptTransform streams: the order of frames, the first-frame wait, the 100 ms a second ramp (no freeze, no jump back),
// jitter smoothing and its bound, clock jumps / wrap-around, the memory caps (fail open), a closed cam, a rejected write, reports.
//   node --test test/av-sync-hold.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../public/js/av-sync-hold.js"), "utf8");

function worker() {
  let now = 1000, seq = 0;
  const timers = new Map(), posted = [];
  const ctx = { performance: { now: () => now }, console, Math, Number, Object, isFinite, Promise,
    setTimeout: (fn, ms = 0) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); } };
  ctx.self = ctx; ctx.postMessage = (m) => posted.push(JSON.parse(JSON.stringify(m)));
  vm.runInNewContext(source, ctx);
  async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
  async function advance(ms) {
    const end = now + ms; let turns = 0;
    await flush();
    for (;;) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at || t.at === next[1].at && id < next[0])) next = [id, t];
      if (!next) break;
      if (++turns > 200000) throw new Error("timer loop");
      now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
    }
    now = end; await flush();
  }
  function transform(options, { reject = false } = {}) {
    const queue = [], waiting = [], written = [];
    const readable = { getReader: () => ({ read: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((res) => waiting.push(res)) }) };
    const writable = { getWriter: () => ({ write: (f) => { written.push({ f, at: now }); return reject ? Promise.reject(new Error("closed")) : Promise.resolve(); } }) };
    ctx.onrtctransform({ transformer: { readable, writable, options } });
    const give = (item) => { if (waiting.length) waiting.shift()(item); else queue.push(item); };
    return { push: (frame) => give({ done: false, value: frame }), end: () => give({ done: true }), written };
  }
  return { ctx, posted, transform, advance, flush, timers, now: () => now, sleep: (ms) => { now += ms; },
    send: (m) => ctx.onmessage({ data: m }) };
}
const RTP = (ms) => Math.round(ms * 90);
function frame(n, rtpMs, bytes = 1000) { return { n, getMetadata: () => ({ rtpTimestamp: RTP(rtpMs) >>> 0 }), data: { byteLength: bytes } }; }
// frames at fps, each arriving at its slot + jitter(i) (never before the previous one); rtp(i) = its time on the cam's clock (ms)
async function feed(w, tr, { count, fps = 30, jitter = () => 0, rtp = null, bytes = 1000, first = 0, make = null }) {
  const iv = 1000 / fps, t0 = w.now() + (first ? iv : 0), out = [];     // a later batch goes on at the same cadence
  for (let i = 0; i < count; i++) {
    const n = first + i, at = Math.max(w.now(), t0 + i * iv + jitter(n));
    if (at > w.now()) await w.advance(at - w.now());
    const f = make ? make(n) : frame(n, rtp ? rtp(n) : n * iv, bytes); f.sent = w.now(); out.push(f); tr.push(f); await w.flush();
  }
  return out;
}
const delays = (tr) => tr.written.map((x) => x.at - x.f.sent);
const order = (tr) => tr.written.map((x) => x.f.n);
const gaps = (tr, from = 1) => tr.written.slice(from).map((x, i) => x.at - tr.written[from + i - 1].at);
const ascending = (list) => list.every((v, i) => i === 0 || v > list[i - 1]);
// a fixed pseudo-random jitter in [0, max) - frame 0 always on time (the earliest arrival is known from the start)
const jitterOf = (max) => (n) => (n === 0 ? 0 : ((n * 7919) % 97) / 97 * max);

test("ping answers ready; hold 0 is a pass-through: every frame written the moment it arrives, in order, unchanged", async () => {
  const w = worker(); w.send({ ping: true }); assert.deepEqual(w.posted, [{ ready: true }]);
  const tr = w.transform({ id: "h1" }); w.send({ id: "h1", hold: 0 });
  const sent = await feed(w, tr, { count: 60, jitter: jitterOf(50) });
  assert.deepEqual(order(tr), sent.map((f) => f.n)); assert.ok(delays(tr).every((d) => d === 0), "no delay: " + delays(tr).slice(0, 5));
  tr.written.forEach((x, i) => assert.equal(x.f, sent[i], "the same frame object, never copied or changed"));
});

test("the first frame waits the whole target and the cam keeps it; frames are released in order", async () => {
  const w = worker(), tr = w.transform({ id: "h1" }); w.send({ id: "h1", hold: 1000 });
  await feed(w, tr, { count: 90 }); await w.advance(1500);
  assert.equal(tr.written.length, 90); assert.ok(ascending(order(tr)));
  assert.equal(delays(tr)[0], 1000, "the first frame waits the target (as Chrome's jitterBufferTarget set before the first frame)");
  assert.ok(delays(tr).every((d) => d >= 1000 && d <= 1001), "steady: " + Math.min(...delays(tr)) + ".." + Math.max(...delays(tr)));
});

test("a hold sent before the transform starts is used for the first frame; ids are independent cams", async () => {
  const w = worker(); w.send({ id: "a", hold: 600 }); w.send({ id: "b", hold: 200 });
  const a = w.transform({ id: "a" }), b = w.transform({ id: "b" });
  await Promise.all([feed(w, a, { count: 1 })]); await feed(w, b, { count: 1 }); await w.advance(1000);
  assert.equal(delays(a)[0], 600); assert.equal(delays(b)[0], 200);
});

test("the target falling (the toggle off, the audio stopping) drains at 100 ms a second - the cam plays ~1.1x, never a freeze or a jump back", async () => {
  const w = worker(), tr = w.transform({ id: "h1" }); w.send({ id: "h1", hold: 1000 });
  await feed(w, tr, { count: 90 });
  const at = w.now(); w.send({ id: "h1", hold: 0 });
  await feed(w, tr, { count: 450, first: 90 }); await w.advance(200);
  assert.ok(ascending(order(tr)), "in order");
  const d = (t) => { const x = tr.written.find((y) => y.at >= t); return x.at - x.f.sent; };
  assert.ok(Math.abs(d(at + 5000) - 500) <= 40, "about 500 ms after 5 s: " + d(at + 5000));
  assert.ok(d(at + 11000) <= 5, "drained after ~10 s: " + d(at + 11000));
  const g = gaps(tr, 2), iv = 1000 / 30;
  assert.ok(Math.max(...g) <= iv + 1.5, "never a freeze: max gap " + Math.max(...g));
  assert.ok(Math.min(...g) >= iv / 1.1 - 1.5, "never a burst (at most 1.1x): min gap " + Math.min(...g));
});

test("the target rising plays the cam ~0.9x until it is reached - no gap longer than a frame / 0.9", async () => {
  const w = worker(), tr = w.transform({ id: "h1" }); w.send({ id: "h1", hold: 0 });
  await feed(w, tr, { count: 30 });
  const at = w.now(); w.send({ id: "h1", hold: 1000 });
  await feed(w, tr, { count: 420, first: 30 }); await w.advance(1200);
  const d = (t) => { const x = tr.written.find((y) => y.at >= t); return x.at - x.f.sent; };
  assert.ok(Math.abs(d(at + 5000) - 500) <= 40, "about 500 ms after 5 s: " + d(at + 5000));
  assert.ok(Math.abs(d(at + 13000) - 1000) <= 2, "reached: " + d(at + 13000));
  const g = gaps(tr, 2), iv = 1000 / 30;
  assert.ok(Math.max(...g) <= iv / 0.9 + 1.5, "slow motion, never a freeze: max gap " + Math.max(...g));
  assert.ok(ascending(order(tr)));
});

test("options.ramp (frames already played before the worker was ready): starts at 0 and ramps up instead of freezing", async () => {
  const w = worker(), tr = w.transform({ id: "h1", ramp: true }); w.send({ id: "h1", hold: 1000 });
  await feed(w, tr, { count: 60 });
  assert.equal(delays(tr)[0], 0, "the first frame shows at once");
  assert.ok(Math.max(...gaps(tr)) <= 1000 / 30 / 0.9 + 1.5, "no freeze");
  assert.ok(delays(tr).at(-1) > 150 && delays(tr).at(-1) < 250, "ramping: " + delays(tr).at(-1));
});

test("network jitter is smoothed by the cam's own clock: steady frame spacing out, the earliest frame held exactly the target", async () => {
  const w = worker(), tr = w.transform({ id: "h1" }); w.send({ id: "h1", hold: 500 });
  await feed(w, tr, { count: 150, jitter: jitterOf(80) }); await w.advance(1000);
  const g = gaps(tr), iv = 1000 / 30;
  assert.ok(g.every((x) => Math.abs(x - iv) <= 1.5), "spacing " + Math.min(...g).toFixed(1) + ".." + Math.max(...g).toFixed(1));
  assert.ok(Math.abs(delays(tr)[0] - 500) <= 1, "the earliest frame: " + delays(tr)[0]);
  assert.ok(Math.min(...delays(tr)) >= 500 - 80 && Math.max(...delays(tr)) <= 501);
});

test("a cam clock that can't be trusted (a constant timestamp) is never held more than 120 ms short of the target, still in order", async () => {
  const w = worker(), tr = w.transform({ id: "h1" }); w.send({ id: "h1", hold: 800 });
  await feed(w, tr, { count: 200, rtp: () => 5000 }); await w.advance(1000);
  assert.ok(ascending(order(tr)));
  assert.ok(delays(tr).every((d) => d >= 800 - 120 - 1 && d <= 801), Math.min(...delays(tr)) + ".." + Math.max(...delays(tr)));
});

test("a clock jump (a relay re-publish) and the 32-bit wrap never stall the cam", async () => {
  const w = worker(), tr = w.transform({ id: "h1" }); w.send({ id: "h1", hold: 600 });
  const iv = 1000 / 30, wrap = 2 ** 32 / 90;     // ms on the cam's clock where its RTP timestamp wraps
  await feed(w, tr, { count: 300, rtp: (n) => (n < 100 ? wrap - 50 * iv + n * iv : n < 200 ? 777777 + n * iv : 1000 + n * iv) });
  await w.advance(1000);
  assert.equal(tr.written.length, 300); assert.ok(ascending(order(tr)));
  const g = gaps(tr);
  assert.ok(Math.max(...g) <= iv + 1.5, "max gap " + Math.max(...g)); assert.ok(delays(tr).every((d) => d >= 600 - 120 - 1 && d <= 601));
  // no timestamp at all: arrival + target
  const w2 = worker(), t2 = w2.transform({ id: "x" }); w2.send({ id: "x", hold: 300 });
  await feed(w2, t2, { count: 30, jitter: jitterOf(40), make: (n) => ({ n }) }); await w2.advance(500);
  assert.ok(delays(t2).every((d) => d >= 300 && d <= 301), delays(t2).join());
});

test("a cam over its memory cap (300 frames) releases what it holds in order and plays undelayed from then on; the report says why", async () => {
  const w = worker(), tr = w.transform({ id: "h1" }); w.send({ id: "h1", hold: 4000 });
  await feed(w, tr, { count: 301, fps: 100 });
  assert.equal(tr.written.length, 301, "everything held went out at once"); assert.ok(ascending(order(tr)));
  const over = w.posted.filter((m) => m.over); assert.equal(over.length, 1); assert.deepEqual([over[0].id, over[0].over, over[0].frames, over[0].applied], ["h1", "tile", 0, 0]);
  w.send({ id: "h1", hold: 3000 });                                       // a new target no longer applies to this cam
  const more = await feed(w, tr, { count: 10, first: 301 });
  assert.ok(more.every((f) => tr.written.find((x) => x.f === f).at === f.sent), "undelayed");
});

test("the byte cap (4 MB a cam) and the page's total (2000 frames) also fail open", async () => {
  const w = worker(), tr = w.transform({ id: "big" }); w.send({ id: "big", hold: 4000 });
  await feed(w, tr, { count: 220, fps: 60, bytes: 20000 });
  assert.equal(w.posted.filter((m) => m.over).map((m) => m.over).join(), "tile"); assert.equal(tr.written.length, 220);
  const p = worker(), cams = [];
  for (let i = 0; i < 8; i++) { cams.push(p.transform({ id: "c" + i })); p.send({ id: "c" + i, hold: 4000 }); }
  for (let k = 0; k < 260; k++) { for (const c of cams) { const f = frame(k, k * 10); f.sent = p.now(); c.push(f); } await p.flush(); await p.advance(10); }
  const overs = p.posted.filter((m) => m.over);
  assert.equal(overs.length, 1); assert.equal(overs[0].over, "page");
  assert.equal(cams.reduce((n, c) => n + (c.written.length === 260 ? 1 : 0), 0), 1, "only the cam that crossed the total let go");
});

test("a tab that slept releases its backlog at once, in order, and goes on holding", async () => {
  const w = worker(), tr = w.transform({ id: "h1" }); w.send({ id: "h1", hold: 2000 });
  await feed(w, tr, { count: 30 });
  w.sleep(7000);                                   // no timer ran (an iPhone tab in the background)
  await feed(w, tr, { count: 1, first: 30 });
  assert.equal(tr.written.length, 30, "the backlog"); assert.ok(ascending(order(tr)));
  await w.advance(2500); assert.equal(tr.written.length, 31); assert.equal(delays(tr).at(-1), 2000);
});

test("close drops the held frames (the connection is gone - never shown); a rejected write ends that cam quietly", async () => {
  const w = worker(), tr = w.transform({ id: "h1" }); w.send({ id: "h1", hold: 1000 });
  await feed(w, tr, { count: 20 }); w.send({ id: "h1", close: true }); await w.advance(3000);
  assert.equal(tr.written.length, 0, "held frames dropped, never flushed");
  assert.equal(w.timers.size, 0, "no timer left");
  const r = worker(), bad = r.transform({ id: "r" }, { reject: true }); r.send({ id: "r", hold: 0 });
  await feed(r, bad, { count: 3 }); await r.advance(100);
  assert.equal(bad.written.length, 1, "after the first failed write nothing more is written");
});

test("about once a second each cam reports what it applies and holds (for the ?avsync=1 panel); a bug inside fails open", async () => {
  const w = worker(), tr = w.transform({ id: "h1" }); w.send({ id: "h1", hold: 500 });
  await feed(w, tr, { count: 120, bytes: 2048 });
  const reports = w.posted.filter((m) => m.id === "h1");
  assert.ok(reports.length >= 3 && reports.length <= 5, "about once a second: " + reports.length);
  const last = reports.at(-1);
  assert.deepEqual([last.applied, last.target, last.over], [500, 500, ""]); assert.ok(last.frames >= 14 && last.frames <= 16, last.frames); assert.equal(last.kb, last.frames * 2);
  const evil = { n: 999, get timestamp() { throw new Error("boom"); } };
  tr.push(evil); await w.flush();
  assert.equal(tr.written.at(-1).f, evil, "the frame still goes out"); assert.equal(w.posted.at(-1).over, "error");
});
