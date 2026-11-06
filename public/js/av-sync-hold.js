// av-sync-hold.js - iosdelay (1.99alg): the cam delay for browsers that have no delay of their own. Safari, iPhone and iPad before
// Safari / iOS 27 (every iPhone browser is WebKit inside, Chrome too) have neither RTCRtpReceiver.jitterBufferTarget nor
// playoutDelayHint, so av-sync.js hands such a cam's receiver to this worker (an RTCRtpScriptTransform) and it holds the cam's
// ENCODED frames for av-sync's target: in their order, never changed, never dropped while the cam plays, never stored, never sent
// anywhere. Video only (av-sync.js never attaches audio). One worker per page, one state per receiver (the transform's options.id).
//
// Timing. A frame is released at its arrival + the applied delay - its lateness: how much later than the earliest frame of the last
// few seconds it arrived, judged by the cam's own clock (its RTP timestamp, 90 kHz), at most SMOOTH_MS. So network jitter is smoothed
// as the browser's own jitter buffer would (the browser decodes a held frame at once: it is already late), and a cam whose clock
// can't be trusted is never held more than SMOOTH_MS short of the target. The applied delay moves towards the target at most
// 100 ms a second (as Chrome's own delay does): a new target, or the viewer's toggle turning off, plays the cam slightly slower or
// faster - never a freeze, never a jump back. The first frame waits the whole target (as Chrome's, set before the first frame); a cam
// whose first frames already played before this worker was ready (options.ramp) starts at 0 and ramps.
//
// Fails open, never closed: a tile over its memory cap, or the page over the total, releases what it holds and plays undelayed from
// then on (av-sync.js says so once in the console); an iPhone tab that slept releases its backlog at once, in order.
//
// Messages in: {ping} -> {ready}; {id, hold: ms} (0 = pass-through); {id, close} (the cam's connection is gone: its held frames are
// dropped, never shown). Out, about once a second per cam that has frames: {id, applied, target, frames, kb, over}.
'use strict';
var RATE = 0.1;                 // ms of delay change per ms (Chrome: 100 ms a second)
var SMOOTH_MS = 120;            // at most this much jitter is smoothed out of the cam's arrival times
var WINDOW_MS = 4000;           // the earliest arrival (vs the cam's clock) is looked for over this long
var JUMP_MS = 1500;             // the cam's clock jumping this far from real time (a re-publish) starts the window again
var MAX_AGE_MS = 6000;          // a frame held this long goes out at once, whatever (a safety net: none waits over MAX_HOLD_MS)
var MAX_HOLD_MS = 4000;         // av-sync.js never asks more (its cap); a bigger ask is clamped
var TILE_FRAMES = 300, TILE_BYTES = 4 * 1024 * 1024;     // one cam (320x240 at 30 fps held 4 s is ~120 frames, a few hundred KB)
var ALL_FRAMES = 2000, ALL_BYTES = 24 * 1024 * 1024;     // the whole page
var REPORT_MS = 1000;
var S = Object.create(null), total = { frames: 0, bytes: 0 }, anon = 0;
function now() { return performance.now(); }
function holdOf(v) { v = Number(v); return v > 0 && isFinite(v) ? Math.min(MAX_HOLD_MS, v) : 0; }
function state(id) {
  return S[id] || (S[id] = { id: id, target: 0, applied: null, at: 0, q: [], bytes: 0, writer: null, dead: false, closed: false, over: '',
    ramp: false, win: [], raw: null, ext: 0, lastA: null, lastT: null, timer: null, told: -Infinity });
}
// The frame's RTP timestamp (metadata first; older WebKit / Chrome: the frame's own timestamp, the same RTP value), or null.
function rtpOf(frame) {
  try { var m = typeof frame.getMetadata === 'function' ? frame.getMetadata() : null; if (m && typeof m.rtpTimestamp === 'number' && isFinite(m.rtpTimestamp)) return m.rtpTimestamp >>> 0; } catch (e) { /* none */ }
  return typeof frame.timestamp === 'number' && isFinite(frame.timestamp) ? frame.timestamp >>> 0 : null;
}
function sizeOf(frame) { try { var d = frame.data; return d && typeof d.byteLength === 'number' ? d.byteLength : 0; } catch (e) { return 0; } }
// The frame's time on the cam's clock, in ms (RTP unwrapped across 2^32); no timestamp: its arrival (= no smoothing).
function clockOf(s, frame, arrived) {
  var r = rtpOf(frame);
  if (r == null) { s.raw = null; return arrived; }
  if (s.raw == null) s.ext = arrived;
  else { var d = (r - s.raw) >>> 0; if (d >= 2147483648) d -= 4294967296; s.ext += d / 90; }
  s.raw = r; return s.ext;
}
// How late this frame is against the earliest of the last WINDOW_MS (a monotonic deque of arrival - clock), at most SMOOTH_MS.
function latenessOf(s, arrived, t) {
  var v = arrived - t, w = s.win;
  var jump = s.lastA != null && Math.abs((t - s.lastT) - (arrived - s.lastA)) > JUMP_MS;
  s.lastA = arrived; s.lastT = t;
  if (jump) w.length = 0;
  while (w.length && w[w.length - 1].v >= v) w.pop();
  w.push({ a: arrived, v: v });
  while (w[0].a < arrived - WINDOW_MS) w.shift();       // never empties: the newest entry is this frame
  return Math.max(0, Math.min(SMOOTH_MS, v - w[0].v));
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
  try { var p = s.writer.write(frame); if (p && typeof p.then === 'function') p.then(null, function () { die(s); }); } catch (e) { die(s); }
}
function release(s) {
  var item = s.q.shift(); s.bytes -= item.b; total.frames--; total.bytes -= item.b;
  put(s, item.f);
}
function drop(s) {
  s.q.forEach(function (item) { total.frames--; total.bytes -= item.b; });
  s.q.length = 0; s.bytes = 0;
}
// The cam's stream is broken (a write failed): nothing more can be shown through it.
function die(s) { clearTimeout(s.timer); s.timer = null; s.dead = true; drop(s); }
function tell(s, t, force) {
  if (!force && t - s.told < REPORT_MS) return;
  s.told = t;
  try { self.postMessage({ id: s.id, applied: s.applied == null ? 0 : Math.max(0, Math.round(s.applied)), target: Math.round(s.target), frames: s.q.length, kb: Math.round(s.bytes / 1024), over: s.over }); } catch (e) { /* the page is gone */ }
}
// Fail open: release everything in order and play undelayed from now on.
function stopHolding(s, why) {
  clearTimeout(s.timer); s.timer = null;
  while (s.q.length) release(s);
  s.over = why; s.target = 0; s.applied = 0;
  tell(s, now(), true);
}
function pump(s) {
  clearTimeout(s.timer); s.timer = null;
  if (s.dead || s.closed) return;
  var t = now();
  step(s, t);
  while (s.q.length && t - s.q[0].a > MAX_AGE_MS) release(s);       // (never: a frame waits at most MAX_HOLD_MS - a safety net)
  while (s.q.length && dueOf(s, s.q[0].r, t) <= t) release(s);
  if (s.writer) tell(s, t, false);
  if (s.q.length) s.timer = setTimeout(function () { pump(s); }, Math.max(1, Math.ceil(dueOf(s, s.q[0].r, t) - t)));
}
function onFrame(s, frame) {
  if (s.dead) return;
  if (s.over || s.closed) { put(s, frame); return; }        // undelayed from now on
  var arrived = now(), t = clockOf(s, frame, arrived), late = latenessOf(s, arrived, t), b = sizeOf(frame);
  if (s.applied == null) { s.applied = s.ramp ? 0 : s.target; s.at = arrived; }
  s.q.push({ f: frame, a: arrived, r: arrived - late, b: b }); s.bytes += b; total.frames++; total.bytes += b;
  var over = s.q.length > TILE_FRAMES || s.bytes > TILE_BYTES ? 'tile' : total.frames > ALL_FRAMES || total.bytes > ALL_BYTES ? 'page' : '';
  if (over) { stopHolding(s, over); return; }
  pump(s);
}
function failOpen(s, frame) {
  var queued = s.q.some(function (item) { return item.f === frame; });
  try { stopHolding(s, 'error'); } catch (e) { s.over = 'error'; }
  if (!queued) put(s, frame);
}
self.onmessage = function (event) {
  var d = event && event.data || {};
  if (d.ping) { try { self.postMessage({ ready: true }); } catch (e) { /* the page is gone */ } return; }
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
  s.target = holdOf(d.hold); pump(s);
};
self.onrtctransform = function (event) {
  var tr = event && event.transformer, o = tr && tr.options || {};
  var id = o && typeof o.id === 'string' && o.id ? o.id : 'anon' + (++anon), s = state(id), reader;
  s.ramp = o.ramp === true;
  try { reader = tr.readable.getReader(); s.writer = tr.writable.getWriter(); } catch (e) { return; }
  (function next() {
    reader.read().then(function (r) {
      if (!r || r.done) { die(s); return; }
      try { onFrame(s, r.value); } catch (e) { failOpen(s, r.value); }   // a bug here must never stop the cam
      if (!s.dead) next();
    }, function () { die(s); });
  })();
};
