// av-sync-hold.js - iosdelay (1.99alg): the cam delay for browsers that have no delay of their own. Safari, iPhone and iPad before
// Safari / iOS 27 (every iPhone browser is WebKit inside, Chrome too) have neither RTCRtpReceiver.jitterBufferTarget nor
// playoutDelayHint, so av-sync.js hands such a cam's receiver to this worker (an RTCRtpScriptTransform) and it holds the cam's
// ENCODED frames for av-sync's target: in their order, never changed or read (not even their bytes), never dropped while the cam
// plays, never stored, never sent anywhere. Video only (av-sync.js never attaches audio). One worker per page, one state per
// receiver (the transform's options.id).
//
// Timing. A frame is released at its arrival + the applied delay - its lateness: how much later than the cam's baseline it arrived,
// judged by the cam's own clock (its RTP timestamp, 90 kHz). Every held frame reaches the browser already late, so the browser
// decodes it at once: its own jitter buffer is out of play and this does that job. The baseline is the lower envelope of
// (arrival - clock) over the last 4 s, along the clock's drift (a Theil-Sen slope through the half-second lows of the last 8 s, used
// only when both halves agree - a relay whose timestamps count frames runs slow or fast when its capture does; a latency step is not
// a drift); it moves at most 100 ms a second beyond that drift, so a change plays the cam slightly slower or faster - but a later
// arrival that lasts (over SNAP_MS, still there once the old lows are 4 s old: a capture that stalled, a slower route) re-bases at
// once, as Chrome's own timing does after a few seconds. While that baseline is settled, jitter up to the delay - 100 ms (at most
// 1 s) is smoothed out, as Chrome's jitter buffer does inside its jitterBufferTarget; while it isn't (the first ~3 s, after a
// clock jump, a clock that can't be followed), at most SMOOTH_MS - so a bad clock never eats more than that of the delay. The bound
// grows at once and shrinks at 100 ms a second (a smoothed frame's place never jumps later). The applied delay moves towards the
// target at most 100 ms a second too (as Chrome's own delay does). The first frame waits the whole target (as Chrome's, set before
// the first frame); a cam whose first frames already played before this worker was ready (options.ramp) starts at 0 and ramps.
//
// Fails open, never closed: a tile over its frame cap, or the page over the total, releases what it holds and plays undelayed from
// then on; a bug in here does the same; an iPhone tab that slept releases its backlog at once, in order. A cam whose frames can no
// longer get through this worker (a rejected write, a broken stream) is reported dead, and av-sync.js takes the transform off so
// WebKit passes its frames straight through again.
//
// Messages in: {ping, report} -> {ready} (report: the page shows the ?avsync=1 panel - a report per cam about once a second);
// {id, hold: ms} (0 = pass-through); {id, close} (the cam's connection is gone: its held frames are dropped, never shown).
// Out: {id, in: true} once its first frame arrived; {id, key: true} once its first key frame went out (av-sync.js's watchdog);
// {id, applied, target, frames, over} (reports, and at once when it stops holding); {id, dead: true, over: 'error' | 'ended'}.
'use strict';
var RATE = 0.1;                 // ms of delay change per ms (Chrome: 100 ms a second); the baseline and the smoothing bound too
var SMOOTH_MS = 120;            // jitter smoothed while the cam's baseline isn't settled (and the least once it is)
var SMOOTH_MAX = 1000;          // the most jitter ever smoothed
var MARGIN_MS = 100;            // once settled, smoothing leaves at least this much of the applied delay
var BUCKET_MS = 500, SPAN_MS = 8000, FIT_MIN = 6;   // the half-second lows of (arrival - clock) over 8 s; a slope from 5 closed ones
var ENV_MS = 4000;              // the baseline is the lowest of the last 4 s (a step is smoothed this long, then re-based)
var SNAP_MS = 250;              // the lows that far above the baseline re-base it at once (a lasting step); else it moves at RATE
var SLOPE_MIN = 0.02;           // a drift below 2% is a real clock's (0): what jitter does to a fitted slope
var JUMP_MS = 1500;             // the cam's clock jumping this far from real time (a re-publish) starts the baseline again
var MAX_AGE_MS = 6000;          // a frame held this long goes out at once, whatever (a safety net: none waits over ~4.1 s)
var MAX_HOLD_MS = 4000;         // av-sync.js never asks more (its cap); a bigger ask is clamped
var TILE_FRAMES = 300;          // one cam (320x240 at 30 fps held 4 s is ~120 frames, a few hundred KB)
var ALL_FRAMES = 2000;          // the whole page
var REPORT_MS = 1000;
var S = Object.create(null), total = { frames: 0 }, anon = 0, report = false;
function now() { return performance.now(); }
function holdOf(v) { v = Number(v); return v > 0 && isFinite(v) ? Math.min(MAX_HOLD_MS, v) : 0; }
function state(id) {
  return S[id] || (S[id] = { id: id, target: 0, applied: null, at: 0, q: [], writer: null, dead: false, closed: false, over: '',
    ramp: false, raw: null, ext: 0, lastA: null, lastT: null, bk: [], slope: 0, base: null, baseAt: 0, cap: SMOOTH_MS, capAt: 0,
    timer: null, told: -Infinity, seen: false, key: false });
}
function post(m) { try { self.postMessage(m); } catch (e) { /* the page is gone */ } }
// The frame's RTP timestamp (metadata first; older WebKit / Chrome: the frame's own timestamp, the same RTP value), or null.
function rtpOf(frame) {
  try { var m = typeof frame.getMetadata === 'function' ? frame.getMetadata() : null; if (m && typeof m.rtpTimestamp === 'number' && isFinite(m.rtpTimestamp)) return m.rtpTimestamp >>> 0; } catch (e) { /* none */ }
  return typeof frame.timestamp === 'number' && isFinite(frame.timestamp) ? frame.timestamp >>> 0 : null;
}
// The frame's time on the cam's clock, in ms (RTP unwrapped across 2^32); no timestamp: its arrival (= no smoothing).
function clockOf(s, frame, arrived) {
  var r = rtpOf(frame);
  if (r == null) { s.raw = null; return arrived; }
  if (s.raw == null) s.ext = arrived;
  else { var d = (r - s.raw) >>> 0; if (d >= 2147483648) d -= 4294967296; s.ext += d / 90; }
  s.raw = r; return s.ext;
}
// The clock's drift: the median slope between half-second lows at least BUCKET_MS apart (Theil-Sen), used only when the older and
// the newer half of the lows each give about the same (a step between or inside them is not a drift: one half then reads ~0);
// 0 below SLOPE_MIN (a real clock) or with too few lows.
function median(list) { list.sort(function (x, y) { return x - y; }); var n = list.length; return n % 2 ? list[(n - 1) / 2] : (list[n / 2 - 1] + list[n / 2]) / 2; }
function sen(bk, from, to) {
  var list = [];
  for (var i = from; i < to; i++) for (var j = i + 1; j < to; j++) { var da = bk[j].a - bk[i].a; if (da >= BUCKET_MS) list.push((bk[j].v - bk[i].v) / da); }
  return list.length ? median(list) : 0;
}
function slopeOf(bk, n) {
  if (n < FIT_MIN - 1) return 0;
  var half = n >> 1, a = sen(bk, 0, half + (n % 2)), b = sen(bk, half, n), k = sen(bk, 0, n);
  var lo = Math.min(Math.abs(a), Math.abs(b)), hi = Math.max(Math.abs(a), Math.abs(b));
  if (a * b <= 0 || lo < SLOPE_MIN || hi > 2 * lo) return 0;
  return Math.abs(k) < SLOPE_MIN ? 0 : Math.max(-1, Math.min(1.5, k));
}
// How late this frame is against the cam's baseline (negative: early, held a little longer - at most SMOOTH_MS and never past a
// pass-through), within the smoothing bound.
function latenessOf(s, arrived, t) {
  var v = arrived - t, bk = s.bk;
  var jump = s.lastA != null && Math.abs((t - s.lastT) - (arrived - s.lastA)) > JUMP_MS;
  s.lastA = arrived; s.lastT = t;
  if (jump) { bk.length = 0; s.base = null; s.slope = 0; }
  var last = bk[bk.length - 1];
  if (!last || arrived - last.a0 >= BUCKET_MS) {
    bk.push({ a0: arrived, a: arrived, v: v });
    while (bk[0].a0 < arrived - SPAN_MS) bk.shift();
    s.slope = slopeOf(bk, bk.length - 1);                 // the closed lows (the newest is still open)
  } else if (v < last.v) { last.a = arrived; last.v = v; }
  var k = s.slope, low = Infinity;
  for (var i = 0; i < bk.length; i++) { if (bk[i].a0 < arrived - ENV_MS) continue; var x = bk[i].v - k * bk[i].a; if (x < low) low = x; }
  var want = k * arrived + low;                            // the lower envelope along the drift (this frame is in it: want <= v)
  if (s.base == null) s.base = want;
  else {
    var dt = Math.max(0, arrived - s.baseAt), pred = s.base + k * dt, m = RATE * dt;
    s.base = want - pred > SNAP_MS ? want : pred + Math.max(-m, Math.min(m, want - pred));     // (down: always at RATE - a lone early frame)
  }
  s.baseAt = arrived;
  var applied = Math.max(0, s.applied || 0), settled = bk.length >= FIT_MIN && Math.abs(want - s.base) <= SMOOTH_MS;
  var full = settled ? Math.max(SMOOTH_MS, Math.min(SMOOTH_MAX, applied - MARGIN_MS)) : SMOOTH_MS;
  var dc = Math.max(0, arrived - s.capAt); s.capAt = arrived;
  s.cap = full >= s.cap ? full : Math.max(full, s.cap - RATE * dc);
  return Math.max(-Math.min(SMOOTH_MS, applied), Math.min(s.cap, v - s.base));
}
// The applied delay moves towards the target at RATE.
function step(s, t) {
  if (s.applied == null) return;
  var max = RATE * Math.max(0, t - s.at); s.at = t;
  s.applied += Math.max(-max, Math.min(max, s.target - s.applied));
}
// The first moment >= t at which a frame with this reference time (arrival - lateness) is due, the applied delay still ramping.
function dueOf(s, ref, t) {
  var d = s.target - s.applied;
  if (!d) return ref + s.applied;
  var sg = d > 0 ? 1 : -1, hit = t + Math.abs(d) / RATE, t1 = Math.max(t, (ref + s.applied - sg * RATE * t) / (1 - sg * RATE));
  return t1 < hit ? t1 : Math.max(hit, ref + s.target);
}
function put(s, frame) {
  if (!s.writer || s.dead) return;
  try { var p = s.writer.write(frame); if (p && typeof p.then === 'function') p.then(null, function () { die(s); }); } catch (e) { die(s); return; }
  if (!s.key) { var key = false; try { key = frame.type === 'key'; } catch (e) { /* no type */ } if (key) { s.key = true; post({ id: s.id, key: true }); } }
}
function release(s) { s.q.shift(); total.frames--; }
function drop(s) { total.frames -= s.q.length; s.q.length = 0; }
// The cam's stream is broken (a write or a read failed): nothing more can be shown through this worker - the page takes it off.
// why: 'error' (a write or a read failed, a transform we can't read from), 'ended' (the stream ended: the receiver stopped).
function die(s, why) {
  if (s.dead) return;
  clearTimeout(s.timer); s.timer = null; s.dead = true; drop(s); s.over = why || 'error';
  post({ id: s.id, dead: true, over: s.over });
}
function tell(s, t, force) {
  if (!force && (!report || t - s.told < REPORT_MS)) return;
  s.told = t;
  post({ id: s.id, applied: s.applied == null ? 0 : Math.max(0, Math.round(s.applied)), target: Math.round(s.target), frames: s.q.length, over: s.over });
}
// Fail open: release everything in order and play undelayed from now on.
function stopHolding(s, why) {
  clearTimeout(s.timer); s.timer = null;
  while (s.q.length) { var f = s.q[0].f; release(s); put(s, f); }
  s.over = why; s.target = 0; s.applied = 0;
  tell(s, now(), true);
}
// A bug in here must never stop a cam: whatever threw, that cam lets go of what it holds and plays undelayed.
function guard(s, fn) {
  try { fn(); } catch (e) { try { if (!s.dead) stopHolding(s, 'error'); } catch (e2) { s.over = 'error'; } }
}
function arm(s, ms) { s.timer = setTimeout(function () { s.timer = null; guard(s, function () { pump(s); }); }, ms); }
function pump(s) {
  clearTimeout(s.timer); s.timer = null;
  if (s.dead || s.closed) return;
  var t = now();
  step(s, t);
  while (s.q.length && t - s.q[0].a > MAX_AGE_MS) { var f = s.q[0].f; release(s); put(s, f); }     // (a safety net)
  while (s.q.length && dueOf(s, s.q[0].r, t) <= t) { var g = s.q[0].f; release(s); put(s, g); }
  if (s.writer) tell(s, t, false);
  if (s.q.length) arm(s, Math.max(1, Math.ceil(dueOf(s, s.q[0].r, t) - t)));
}
function onFrame(s, frame) {
  if (s.dead) return;
  if (s.over || s.closed) { put(s, frame); return; }        // undelayed from now on
  var arrived = now(), t = clockOf(s, frame, arrived);
  if (s.applied == null) { s.applied = s.ramp ? 0 : s.target; s.at = arrived; }
  step(s, arrived);
  var late = latenessOf(s, arrived, t);
  s.q.push({ f: frame, a: arrived, r: arrived - late }); total.frames++;
  if (!s.seen) { s.seen = true; post({ id: s.id, in: true }); }
  var over = s.q.length > TILE_FRAMES ? 'tile' : total.frames > ALL_FRAMES ? 'page' : '';
  if (over) { stopHolding(s, over); return; }
  // the head's timer still stands (a frame behind it is never due first): no new timer per frame - unless that timer is late (a
  // throttled tab), then this frame's arrival releases what is due
  if (s.timer && s.q.length > 1 && dueOf(s, s.q[0].r, arrived) > arrived) return;
  pump(s);
}
function failOpen(s, frame) {
  var queued = s.q.some(function (item) { return item.f === frame; });
  try { stopHolding(s, 'error'); } catch (e) { s.over = 'error'; }
  if (!queued) put(s, frame);
}
self.onmessage = function (event) {
  var d = event && event.data || {};
  if (d.ping) { report = d.report === true; post({ ready: true }); return; }
  var id = typeof d.id === 'string' ? d.id : '';
  if (!id) return;
  if (d.close) {
    // the cam's connection is gone: what it holds is dropped (never shown); anything still coming passes straight through
    var c = S[id]; delete S[id];
    if (c) { clearTimeout(c.timer); c.timer = null; drop(c); c.closed = true; }
    return;
  }
  var s = state(id);
  if (s.closed || s.over) return;
  guard(s, function () { s.target = holdOf(d.hold); pump(s); });
};
self.onrtctransform = function (event) {
  var tr = event && event.transformer, o = tr && tr.options || {};
  var id = o && typeof o.id === 'string' && o.id ? o.id : 'anon' + (++anon), s = state(id), reader;
  s.ramp = o.ramp === true;
  // a transform we can't read from would hold the cam's frames forever: say so, the page takes it off
  try { reader = tr.readable.getReader(); s.writer = tr.writable.getWriter(); } catch (e) { die(s); return; }
  (function next() {
    reader.read().then(function (r) {
      if (!r || r.done) { die(s, 'ended'); return; }
      try { onFrame(s, r.value); } catch (e) { failOpen(s, r.value); }   // a bug here must never stop the cam
      if (!s.dead) next();
    }, function () { die(s); });
  })();
};
