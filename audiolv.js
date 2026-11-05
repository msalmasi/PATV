// audiolv.js — micvad 1.99akk: the room's loudness for the pad page's mic bars where the page can't measure the sound itself
// (owner 2026-11-05: "Real bars on iPhone too would be nice" - iOS has no Web Audio for the room player, room-bridge.js 1.99bk).
//
// Pepe (camfrog-bot pepe_audiolv.py) sends one coarse level per 100 ms on each room-audio post (/api/bridge/audio), pinned to
// that post's own MP3 frames: lv = {v: 1, h: byte offset of its first frame header, a: ms from that frame to the first level,
// d: one hex digit per 100 ms}. The site is a dumb pass-through: it checks the shape (clean), keeps it beside the 0.5 s prime
// in memory (bridge.js a.recent) and hands it on INSIDE the viewer's own MP3 response - GET /p/:slug/audio?lv=1, only while the
// room-audio setting `levels` is on (roomaudiocfg.js). Same gate, same listener object, same lifetime: paused = the fetch closes =
// nothing arrives. The site never parses the MP3, never computes a level, never logs or stores one, and never names anyone.
//
// A framed response (Content-Type application/octet-stream, X-Audio-Frames: 1) is a run of records:
//   [u8 type][u24 big-endian length][payload]   type 1 = MP3 bytes (exactly the relay's), type 2 = JSON {h?, a?, d} for the type-1
//   record just before it (h relative to that record). Other types: the page skips them.
// Every framed session starts ON a frame header (the prime is cut at the first post that names one), so the page can count the
// frames it appends from byte 0 and read the level at <audio>.currentTime - the media timeline, no clocks.
"use strict";

const DIGITS = /^[0-9a-f]{0,64}$/;
const KEYS = new Set(["v", "h", "a", "d"]);
const A_MAX_MS = 10000;
const REC_MAX = 0xffffff;
const T_MP3 = 1, T_LV = 2;

/** Pepe's lv for a post of `len` MP3 bytes -> a FRESH {h?, a?, d} (nothing else can ride along) | null (any doubt). */
function clean(lv, len) {
  if (!lv || typeof lv !== "object" || Array.isArray(lv) || lv.v !== 1) return null;
  if (Object.keys(lv).some((k) => !KEYS.has(k))) return null;      // nothing else may ride along (a name, an id) - not even dropped quietly
  if (typeof lv.d !== "string" || !DIGITS.test(lv.d)) return null;
  if (!Number.isInteger(len) || len <= 0) return null;
  const out = {};
  if (lv.h != null) {
    if (!Number.isInteger(lv.h) || lv.h < 0 || lv.h >= len) return null;
    out.h = lv.h;
  }
  if (lv.d) {
    if (out.h == null) return null;                 // levels with nothing to pin them to
    if (typeof lv.a !== "number" || !Number.isFinite(lv.a) || Math.abs(lv.a) > A_MAX_MS) return null;
    out.a = Math.round(lv.a * 10) / 10;
  }
  out.d = lv.d;
  return out;
}

/** One record: [type][u24 BE length][payload]. */
function rec(type, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload), "utf8");
  if (body.length > REC_MAX) throw new RangeError("record too long");
  const head = Buffer.allocUnsafe(4);
  head[0] = type;
  head.writeUIntBE(body.length, 1, 3);
  return Buffer.concat([head, body]);
}

/**
 * Turn an MP3 relay response into a framed one: res.framed(buf, lv) for the broadcast, then the prime from hub.recent - cut at
 * the first remembered post whose lv names a header (that header becomes byte 0, its lv h: 0), the later ones as they came.
 * No remembered post names one (an old Pepe, levels off on his side): the prime goes out as plain MP3 records and the page,
 * which can't line it up, never shows levels for this session. Nothing remembered: the first post that names a header is cut.
 */
function open(res, hub) {
  let started = false;
  const send = (buf, lv) => {
    if (!buf || !buf.length) return;
    if (!started) {
      started = true;
      if (lv && lv.h != null) {
        res.write(rec(T_MP3, buf.subarray(lv.h)));
        res.write(rec(T_LV, { ...lv, h: 0 }));
        return;
      }
    }
    for (let i = 0; i < buf.length; i += REC_MAX) res.write(rec(T_MP3, buf.subarray(i, i + REC_MAX)));
    if (lv && buf.length <= REC_MAX) res.write(rec(T_LV, lv));
  };
  res.framed = send;
  const recent = (hub && hub.recent) || [];
  const first = recent.findIndex((r) => r && r.lv && r.lv.h != null);
  for (const r of first >= 0 ? recent.slice(first) : recent) send(r.buf, r.lv);
}

module.exports = { clean, rec, open, T_MP3, T_LV, A_MAX_MS };
