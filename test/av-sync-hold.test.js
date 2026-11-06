// iosdelay (1.99alg): public/js/av-sync-hold.js - the worker that holds a cam's encoded frames where the browser has no delay of its own
// (Safari / iPhone / iPad before iOS 27; every iPhone browser, Chrome too). Run in a vm with a fake clock, fake timers and fake
// RTCRtpScriptTransform streams: the order of frames, the first-frame wait, the 100 ms a second ramp (no freeze, no jump back),
// jitter smoothing and its bound, clock jumps / wrap-around, the memory caps (fail open), a closed cam, a rejected write, reports.
// iosdelay review fixes: jitter beyond 120 ms smoothed once the baseline is settled (cellular, Wi-Fi), a drifting clock followed, a
// lasting step re-based once, frames never read for their bytes, fewer timers, reports only on request, dead / in / key messages,
// a bug anywhere fails open.
//   node --test test/av-sync-hold.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../public/js/av-sync-hold.js"), "utf8");

function worker() {
  let now = 1000, seq = 0, set = 0, boom = false;
  const timers = new Map(), posted = [];
  // (review fixes: `boom` makes the worker's Math.ceil throw - a bug inside it, wherever it runs)
  const M = Object.create(Math); M.ceil = (x) => { if (boom) throw new Error("boom"); return Math.ceil(x); };
  const ctx = { performance: { now: () => now }, console, Math: M, Number, Object, isFinite, Promise,
    setTimeout: (fn, ms = 0) => { set++; const id = ++seq; timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn }); return id; },
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
  function transform(options, { reject = false, noReader = false } = {}) {
    const queue = [], waiting = [], written = [];
    const readable = { getReader: () => { if (noReader) throw new Error("locked"); return { read: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((res, rej) => waiting.push({ res, rej })) }; } };
    const writable = { getWriter: () => ({ write: (f) => { written.push({ f, at: now }); return reject ? Promise.reject(new Error("closed")) : Promise.resolve(); } }) };
    ctx.onrtctransform({ transformer: { readable, writable, options } });
    const give = (item) => { if (waiting.length) waiting.shift().res(item); else queue.push(item); };
    return { push: (frame) => give({ done: false, value: frame }), end: () => give({ done: true }), fail: () => waiting.length && waiting.shift().rej(new Error("broken")), written };
  }
  return { ctx, posted, transform, advance, flush, timers, now: () => now, sleep: (ms) => { now += ms; }, timersSet: () => set, boom: (v) => { boom = v; },
    send: (m) => ctx.onmessage({ data: m }) };
}
const RTP = (ms) => Math.round(ms * 90);
// (review fix F3: reading a WebKit frame's `data` copies it - and writing it back copies it again; the worker never reads it)
let dataReads = 0;
function frame(n, rtpMs) { return { n, getMetadata: () => ({ rtpTimestamp: RTP(rtpMs) >>> 0 }), get data() { dataReads++; return { byteLength: 1000 }; } }; }
// frames at fps, each arriving at its slot + jitter(i) (never before the previous one); rtp(i) = its time on the cam's clock (ms)
// (review fixes: cap(n) - when frame n was captured, ms after the first; its clock reads rtp(n) or cap(n); `sleep` - no timers run)
async function feed(w, tr, { count, fps = 30, jitter = () => 0, rtp = null, first = 0, make = null, cap = null, sleep = false }) {
  const iv = 1000 / fps, t0 = w.now() + (first ? iv : 0), out = [];     // a later batch goes on at the same cadence
  for (let i = 0; i < count; i++) {
    const n = first + i, c = cap ? cap(n) : i * iv, at = Math.max(w.now(), t0 + c + jitter(n));     // (cap: one batch, first 0)
    if (at > w.now()) { if (sleep) w.sleep(at - w.now()); else await w.advance(at - w.now()); }
    const f = make ? make(n) : frame(n, rtp ? rtp(n) : cap ? cap(n) : n * iv); f.sent = w.now(); f.cap = t0 + c; out.push(f); tr.push(f); await w.flush();
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
  assert.equal(dataReads, 0, "never read for its bytes (WebKit would copy it out and back in)");
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

test("the page's total (2000 frames) also fails open - only the cam that crossed it lets go", async () => {
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

test("close drops the held frames (the connection is gone - never shown); a rejected write ends that cam and says so (dead)", async () => {
  const w = worker(), tr = w.transform({ id: "h1" }); w.send({ id: "h1", hold: 1000 });
  await feed(w, tr, { count: 20 }); w.send({ id: "h1", close: true }); await w.advance(3000);
  assert.equal(tr.written.length, 0, "held frames dropped, never flushed");
  assert.equal(w.timers.size, 0, "no timer left");
  const r = worker(), bad = r.transform({ id: "r" }, { reject: true }); r.send({ id: "r", hold: 0 });
  await feed(r, bad, { count: 3 }); await r.advance(100);
  assert.equal(bad.written.length, 1, "after the first failed write nothing more is written");
  // review fix (C2): the page is told, so it takes the transform off and WebKit passes the frames straight through again
  assert.deepEqual(r.posted.filter((m) => m.dead), [{ id: "r", dead: true, over: "error" }]);
});

test("review fix (C2): a transform that can't be read, a read that fails and a stream that ends are each reported dead - once", async () => {
  const w = worker(); w.transform({ id: "a" }, { noReader: true });
  assert.deepEqual(w.posted.filter((m) => m.dead), [{ id: "a", dead: true, over: "error" }], "setup failed: never silently holding the cam's frames");
  const b = w.transform({ id: "b" }); w.send({ id: "b", hold: 500 }); await feed(w, b, { count: 5 }); b.fail(); await w.flush();
  assert.deepEqual(w.posted.filter((m) => m.dead && m.id === "b"), [{ id: "b", dead: true, over: "error" }]);
  assert.equal(w.timers.size, 0, "its held frames dropped (they can't get through any more)");
  const c = w.transform({ id: "c" }); c.end(); await w.flush();
  assert.deepEqual(w.posted.filter((m) => m.dead && m.id === "c"), [{ id: "c", dead: true, over: "ended" }], "the receiver stopped: said as such");
});

test("reports go to the page only while it asks (?avsync=1: ping report) - about once a second a cam; a cam that stops holding says so at once; a bug inside fails open", async () => {
  const quiet = worker(); quiet.send({ ping: true }); const q = quiet.transform({ id: "q" }); quiet.send({ id: "q", hold: 500 });
  await feed(quiet, q, { count: 120 });
  assert.deepEqual(quiet.posted, [{ ready: true }, { id: "q", in: true }], "no ?avsync=1 panel: nothing but its first frame (review fix F4)");
  const w = worker(); w.send({ ping: true, report: true }); const tr = w.transform({ id: "h1" }); w.send({ id: "h1", hold: 500 });
  await feed(w, tr, { count: 120 });
  const reports = w.posted.filter((m) => m.id === "h1" && "frames" in m);
  assert.ok(reports.length >= 3 && reports.length <= 5, "about once a second: " + reports.length);
  const last = reports.at(-1);
  assert.deepEqual([last.applied, last.target, last.over], [500, 500, ""]); assert.ok(last.frames >= 14 && last.frames <= 16, last.frames);
  assert.ok(!("kb" in last), "frames only - their bytes are never read (review fix F3)");
  const evil = { n: 999, get timestamp() { throw new Error("boom"); } };
  tr.push(evil); await w.flush();
  assert.equal(tr.written.at(-1).f, evil, "the frame still goes out"); assert.equal(w.posted.at(-1).over, "error");
  const q2 = worker(), t2 = q2.transform({ id: "x" }); q2.send({ id: "x", hold: 4000 });
  await feed(q2, t2, { count: 301, fps: 100 });
  assert.deepEqual(q2.posted.filter((m) => m.over).map((m) => m.over), ["tile"], "a cap is said without being asked");
});

// ── iosdelay review fixes (finding 1 / 5): every held frame reaches WebKit already late, so its own jitter buffer is out of play -
// the worker smooths jitter up to the delay - 100 ms once the cam's baseline is settled (Chrome's jitterBufferTarget is only a
// minimum: it absorbs jitter inside the whole target), along the clock's drift, and a lasting step is re-based once. ──
const syncOf = (tr, target) => tr.written.map((x) => x.at - x.f.cap - target);     // 0 = shown exactly the target after capture
const after = (tr, ms) => { const t0 = tr.written[0].f.cap; return { written: tr.written.filter((x) => x.f.cap >= t0 + ms) }; };
const hitches = (tr, iv) => gaps(tr).filter((g) => g > iv * 1.6).length;
const bursts = (tr, iv) => gaps(tr).filter((g) => g < iv * 0.4).length;

test("review fix F1: cellular jitter (spikes of 150-400 ms) and Wi-Fi stalls (300 ms every 3 s) are smoothed once settled - no freeze, no burst, frames in sync", async () => {
  const iv = 1000 / 30;
  const cell = (n) => (n === 0 ? 0 : ((n * 7919) % 97) / 97 * 60 + (n % 50 === 17 ? 150 + ((n * 37) % 250) : 0));
  const w = worker(), tr = w.transform({ id: "c" }); w.send({ id: "c", hold: 1500 });
  await feed(w, tr, { count: 900, jitter: cell }); await w.advance(3000);
  const late = after(tr, 5000);
  assert.ok(ascending(order(tr)));
  assert.equal(hitches(late, iv), 0, "no freeze: max gap " + Math.max(...gaps(late)).toFixed(1));
  assert.equal(bursts(late, iv), 0, "no burst: min gap " + Math.min(...gaps(late)).toFixed(1));
  assert.ok(syncOf(late, 1500).every((d) => Math.abs(d) <= 2), "each frame the target after its capture: " + Math.min(...syncOf(late, 1500)) + ".." + Math.max(...syncOf(late, 1500)));
  const wifi = (n) => { const t = (n * iv) % 3000; return (n === 0 ? 0 : ((n * 7919) % 97) / 97 * 20) + (t < 300 && n > 0 ? 300 - t : 0); };
  const v = worker(), t2 = v.transform({ id: "w" }); v.send({ id: "w", hold: 1300 });
  await feed(v, t2, { count: 900, jitter: wifi }); await v.advance(3000);
  const l2 = after(t2, 5000);
  assert.equal(hitches(l2, iv), 0, "Wi-Fi: max gap " + Math.max(...gaps(l2)).toFixed(1)); assert.equal(bursts(l2, iv), 0);
});

test("review fix F1: a short later arrival (the route slower by 300 ms for 2 s) stays in sync - smoothed, never a freeze", async () => {
  const iv = 1000 / 30, w = worker(), tr = w.transform({ id: "c" }); w.send({ id: "c", hold: 1500 });
  await feed(w, tr, { count: 600, jitter: (n) => (n >= 300 && n < 360 ? 300 : 0) }); await w.advance(3000);
  const late = after(tr, 5000);
  assert.equal(hitches(late, iv), 0, "max gap " + Math.max(...gaps(late)).toFixed(1));
  assert.ok(syncOf(late, 1500).every((d) => Math.abs(d) <= 2), Math.min(...syncOf(late, 1500)) + ".." + Math.max(...syncOf(late, 1500)));
});

test("review fix F1: a clock that drifts (a relay counting frames while its capture runs 10% slow or fast) is followed - the whole delay, smooth", async () => {
  for (const rate of [0.9, 1.1]) {
    const iv = 1000 / 30, w = worker(), tr = w.transform({ id: "d" }); w.send({ id: "d", hold: 1200 });
    await feed(w, tr, { count: 600, rtp: (n) => n * iv * rate, jitter: (n) => (n === 0 ? 0 : ((n * 7919) % 97) / 97 * 30) }); await w.advance(2500);
    const late = after(tr, 6000);
    assert.ok(syncOf(late, 1200).every((d) => Math.abs(d) <= 15), rate + ": " + Math.min(...syncOf(late, 1200)).toFixed(0) + ".." + Math.max(...syncOf(late, 1200)).toFixed(0));
    assert.equal(hitches(late, iv), 0, String(rate)); assert.equal(bursts(late, iv), 0, String(rate));
  }
});

test("review fix F1: a frozen clock is never held more than 120 ms short, and once followed it gets the whole delay", async () => {
  const w = worker(), tr = w.transform({ id: "f" }); w.send({ id: "f", hold: 800 });
  await feed(w, tr, { count: 300, rtp: () => 5000 }); await w.advance(1000);
  assert.ok(delays(tr).every((d) => d >= 800 - 121 && d <= 801), Math.min(...delays(tr)) + ".." + Math.max(...delays(tr)));
  assert.ok(delays(after(tr, 5000)).every((d) => d >= 799 && d <= 801), "followed: " + Math.min(...delays(after(tr, 5000))));
  assert.ok(Math.max(...gaps(tr)) <= 1000 / 30 + 125, "at most the 120 ms it was short, once: " + Math.max(...gaps(tr)));
  assert.ok(hitches(tr, 1000 / 30) <= 1);
});

test("review fix F5: a lasting later arrival (a relay's capture stalled 1 s, its clock counting frames) is re-based once - one freeze of the stall, then the whole delay; no hitch seconds later", async () => {
  const iv = 1000 / 30, w = worker(), tr = w.transform({ id: "s" }); w.send({ id: "s", hold: 1500 });
  await feed(w, tr, { count: 750, cap: (n) => n * iv + (n >= 300 ? 1000 : 0), rtp: (n) => n * iv }); await w.advance(3000);
  assert.ok(ascending(order(tr)));
  const big = gaps(tr).filter((g) => g > iv * 1.6);
  assert.equal(big.length, 1, "one freeze: " + big.map((g) => g.toFixed(0))); assert.ok(big[0] >= 950 && big[0] <= 1050, String(big[0]));
  assert.equal(bursts(tr, iv), 0);
  const back = tr.written.filter((x) => x.f.n >= 300 + 30 * 6);                 // 6 s after the stall: re-based
  assert.ok(back.every((x) => Math.abs(x.at - x.f.sent - 1500) <= 2), "the whole delay again: " + back.map((x) => x.at - x.f.sent).slice(0, 3));
});

test("review fix F4: no new timer per frame - the head's timer stands; a late timer (a throttled tab) is caught up by the next frame's arrival", async () => {
  const w = worker(), tr = w.transform({ id: "t" }); w.send({ id: "t", hold: 1000 });
  const before = w.timersSet();
  await feed(w, tr, { count: 300 }); await w.advance(1500);
  assert.ok(w.timersSet() - before <= 300 * 1.05 + 5, "about one timer per frame released: " + (w.timersSet() - before));
  const s = worker(), t2 = s.transform({ id: "s" }); s.send({ id: "s", hold: 1000 });
  await feed(s, t2, { count: 90, sleep: true });                 // timers never run: only arrivals
  assert.ok(t2.written.length >= 55 && t2.written.length <= 62, "what is due went out with the arrivals: " + t2.written.length);
  assert.ok(ascending(order(t2)));
});

test("review fix F2: a bug in the worker (in a timer or a message) fails open - what it holds goes out in order, the page is told, the cam plays undelayed", async () => {
  const w = worker(), tr = w.transform({ id: "b" }); w.send({ id: "b", hold: 1500 });
  await feed(w, tr, { count: 30 });
  w.boom(true); await w.advance(1000);                            // the next timer throws
  assert.equal(tr.written.length, 30, "everything held went out"); assert.ok(ascending(order(tr)));
  assert.equal(w.posted.filter((m) => m.over).at(-1).over, "error");
  w.boom(false);
  const more = await feed(w, tr, { count: 10, first: 30 });
  assert.ok(more.every((f) => tr.written.find((x) => x.f === f).at === f.sent), "undelayed from then on");
  const m = worker(), t2 = m.transform({ id: "m" }); m.send({ id: "m", hold: 1500 });
  await feed(m, t2, { count: 20 }); m.boom(true); m.send({ id: "m", hold: 900 }); m.boom(false);   // a message that throws
  assert.equal(t2.written.length, 20); assert.equal(m.posted.filter((x) => x.over).at(-1).over, "error");
});

test("in / key: the page hears once that a cam's frames reach the worker and once that its first key frame went out (its watchdog)", async () => {
  const w = worker(), tr = w.transform({ id: "k" }); w.send({ id: "k", hold: 500 });
  const make = (n) => Object.assign(frame(n, n * 33.3), { type: n === 3 || n === 40 ? "key" : "delta" });
  await feed(w, tr, { count: 2, make });
  assert.deepEqual(w.posted, [{ id: "k", in: true }], "in at its first frame");
  await feed(w, tr, { count: 60, first: 2, make }); await w.advance(1000);
  const keys = w.posted.filter((m) => m.key);
  assert.deepEqual(keys, [{ id: "k", key: true }], "once"); assert.equal(w.posted.filter((m) => m.in).length, 1);
  const k3 = tr.written.find((x) => x.f.n === 3);
  assert.ok(k3 && k3.at - k3.f.sent >= 499, "the key frame went out after its hold - and only then was it said");
});
