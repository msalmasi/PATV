// roomrtc.js — low-latency room audio over WebRTC (1.99il). The pad's room player can hear the Camfrog room about
// half a second behind (WHEP through MediaMTX) instead of ~1.5 s (the MP3-over-HTTP relay in bridge.js, which stays
// as the automatic fallback).
//
//   Pepe   net_audio's per-room mix -> ffmpeg (Opus, WHIP muxer) -> MediaMTX path <PREFIX><16 hex>, ONE path per room,
//          only while the site says someone wants it (the `rtc` field of the /api/bridge/audio answer, below)
//   viewer POST /api/rooms/<slug>/audio/rtc -> a 2-minute read ticket on the WHEP URL (?pt=) -> WHEP -> MediaMTX
//          asks the auth hook (webrtc.js -> auth() here), which checks the ticket AND that the viewer may still hear
//          the room (padaccess.full: the same rule as /p/<slug>/audio). Anything that fails -> the page plays MP3.
//
// Who gets it: the stage setting `room_rtc` (/stage/admin): "off" (default) | "prime" (Prime Time pads - pad.primeTime -
// plus comped admin pads, the house pad included) | "all". It also needs webrtc_enabled (the MediaMTX / TURN servers)
// and a Pepe that can publish (he says rtc_cap on each audio post; an older Pepe never gets asked).
// TURN capacity: `room_rtc_cap` WebRTC room listeners site-wide (MediaMTX's readers of room paths, plus tickets handed
// out in the last few seconds); over it, the ticket says "busy" and the page plays MP3.
//
// Publish lifecycle (the "want"): a ticket, a hook read and a MediaMTX reader each keep a room wanted for GRACE_MS;
// while wanted, Pepe's audio post gets {rtc: {url, token, path, ready}} and he publishes; after that it gets rtc: null
// and he stops. Rooms that could be asked (eligible) get rtc_beat: 1 so his heartbeat runs every second, not every 3.
//
// Path names: prod "room-<16 hex>", staging "stgr-<16 hex>" - an HMAC of the room id (room names never reach a URL).
// One MediaMTX, one auth hook: the site that's called forwards the other site's prefix (webrtc.js, WHIP_AUTH_PEER).
// Pepe's bearer per path is an HMAC of SECRET_KEY (nothing new to store); ROOM_RTC_KEY_VERSION rotates it.
"use strict";
const crypto = require("crypto");

const STAGING = !!process.env.STAGING;
const PREFIX = STAGING ? "stgr-" : "room-";
const PATH_RE = /^(room|stgr)-[0-9a-f]{16}$/;
const MODES = Object.freeze(["off", "prime", "all"]);
const GRACE_MS = 30 * 1000;            // a room stays published this long after its last listener / ticket
const TICKET_MS = 2 * 60 * 1000;       // a read ticket is good this long (it's only used to open the WHEP session)
const PENDING_MS = 10 * 1000;          // a ticket counts against the cap this long (until MediaMTX lists the reader)
const SYNC_FRESH_MS = 15 * 1000;       // MediaMTX's reader counts older than this are ignored
const CAP_FRESH_MS = 60 * 1000;        // Pepe's "I can publish" from an audio post within this long
const SECRET = process.env.SECRET_KEY || crypto.randomBytes(32).toString("hex");

let clock = () => Date.now();
const now = () => clock();
const W = () => require("./webrtc");
const bridgeRooms = () => { try { return require("./bridge")._rooms; } catch (e) { return new Map(); } };

// ── settings (stage_config, mainstage.js) ──
function cfg() {
  try { const c = require("./mainstage").config(); return { mode: MODES.includes(c.room_rtc) ? c.room_rtc : "off", cap: Number(c.room_rtc_cap) || 0 }; }
  catch (e) { return { mode: "off", cap: 0 }; }
}
const mode = () => cfg().mode;
const on = () => mode() !== "off" && W().enabled();

/** Prime Time (pad.primeTime, the premium pad tier) or a comped admin pad (the house pad). */
function isPrime(roomId) {
  let R = null;
  try { R = require("./rooms").getCached(String(roomId || "")); } catch (e) { R = null; }
  if (!R) return false;
  const p = R.primeTime;
  if (p === true || (p && typeof p === "object" && p.active !== false)) return true;
  return !!R.house;
}

// ── names + secrets ──
function pathFor(roomId) {
  return PREFIX + crypto.createHmac("sha256", SECRET).update("room-audio-path:" + String(roomId)).digest("hex").slice(0, 16);
}
/** The bridged room behind one of THIS site's paths (null when none / the other site's). */
function roomForPath(p) {
  if (!PATH_RE.test(String(p || "")) || !String(p).startsWith(PREFIX)) return null;
  for (const R of bridgeRooms().values()) if (R && R.id && pathFor(R.id) === p) return R;
  return null;
}
function pubKey(p) {
  const v = String(process.env.ROOM_RTC_KEY_VERSION || "1").trim();
  if (!v || v === "off") return null;
  return "ra" + crypto.createHmac("sha256", SECRET).update("room-audio-pub:" + p + ":" + v).digest("base64url").slice(0, 40);
}
function sameSecret(got, want) {
  if (!want) return false;
  const a = crypto.createHash("sha256").update(String(got)).digest(), b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}
const b64 = (s) => Buffer.from(String(s)).toString("base64url");
const unb64 = (s) => { try { return Buffer.from(String(s), "base64url").toString("utf8"); } catch (e) { return ""; } };
const sign = (body, p) => crypto.createHmac("sha256", SECRET).update("room-read:" + body + "|" + p).digest("base64url").slice(0, 32);
/** A read ticket for `userId` (null = signed out, for a Public pad) on path `p`: "ra1.<exp>.<uid b64 | ->.<sig>". */
function readTicket(userId, p, t = now()) {
  const body = "ra1." + (t + TICKET_MS) + "." + (userId ? b64(userId) : "-");
  return body + "." + sign(body, p);
}
/** -> {uid} (uid null = signed out) when the ticket is good for `p` and not expired; else null. */
function checkTicket(tok, p, t = now()) {
  const m = /^ra1\.(\d{10,16})\.(-|[A-Za-z0-9_-]{1,120})\.([A-Za-z0-9_-]{32})$/.exec(String(tok || ""));
  if (!m || Number(m[1]) < t) return null;
  const want = sign("ra1." + m[1] + "." + m[2], p);
  const a = Buffer.from(m[3]), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (m[2] === "-") return { uid: null };
  const uid = unb64(m[2]);
  return uid ? { uid } : null;
}

// ── per-room state ──
const ST = new Map();                  // room id -> {wantUntil, readers, ready, seenAt}
const pending = [];                    // times tickets were handed out (the cap counts them for PENDING_MS)
function st(id) {
  let s = ST.get(id);
  if (!s) { s = { wantUntil: 0, readers: 0, ready: false, seenAt: 0 }; ST.set(id, s); }
  return s;
}
function want(id, t = now()) { const s = st(id); s.wantUntil = Math.max(s.wantUntil, t + GRACE_MS); }

/** Can this room's audio go out over WebRTC right now (setting, servers, tier, a capable Pepe streaming it)? */
function eligible(R, t = now()) {
  if (!R || !R.id || !on() || !R.audio) return false;
  if (!R.rtcCapAt || t - R.rtcCapAt > CAP_FRESH_MS) return false;   // also "the room is live": his posts stopped
  return mode() === "all" || isPrime(R.id);
}

/** WebRTC room listeners site-wide right now: MediaMTX's readers (fresh) + tickets not yet seen as readers. */
function active(t = now()) {
  while (pending.length && t - pending[0] > PENDING_MS) pending.shift();
  let n = 0;
  for (const s of ST.values()) if (t - s.seenAt <= SYNC_FRESH_MS) n += s.readers;
  return n + pending.length;
}

/**
 * A viewer asks to listen over WebRTC. The caller has already checked they may hear the room (padaccess.full).
 * -> {ok: true, whep, ready} | {ok: false, fallback: why}   ("off" / "busy" / ...: the page plays MP3)
 */
function ticket(user, R, t = now()) {
  if (!on()) return { ok: false, fallback: "off" };
  if (!eligible(R, t)) return { ok: false, fallback: R && R.audio ? "not-eligible" : "no-audio" };
  const { cap } = cfg();
  if (cap <= 0 || active(t) >= cap) return { ok: false, fallback: "busy" };
  const p = pathFor(R.id);
  pending.push(t);
  want(R.id, t);
  const s = st(R.id);
  const url = W().whepUrl(p) + "?pt=" + encodeURIComponent(readTicket(user && user.userId ? user.userId : null, p, t));
  return { ok: true, whep: url, ready: !!s.ready && t - s.seenAt <= SYNC_FRESH_MS, expires: t + TICKET_MS };
}

/** What Pepe's audio post gets back for room R: rtc = publish now (url, bearer, path) or null = don't; rtc_beat. */
function forBot(R, t = now()) {
  if (!eligible(R, t)) return { rtc: null };
  const s = st(R.id);
  const p = pathFor(R.id);
  const key = pubKey(p);
  const wanted = s.wantUntil > t && !!key;
  return { rtc: wanted ? { url: W().whipUrl(p), token: key, path: p, ready: !!s.ready && t - s.seenAt <= SYNC_FRESH_MS } : null, rtc_beat: 1 };
}

/** webrtc.sync hands over MediaMTX's path list every 5 s: readers per room path (a reader keeps it wanted). */
function noteSync(items, t = now()) {
  const seen = new Set();
  for (const p of items || []) {
    if (!p || typeof p.name !== "string" || !p.name.startsWith(PREFIX) || !PATH_RE.test(p.name)) continue;
    const R = roomForPath(p.name);
    if (!R) continue;
    const s = st(R.id);
    s.ready = !!(p.ready || p.available);
    s.readers = (Array.isArray(p.readers) ? p.readers : []).filter((r) => r && r.type === "webRTCSession").length;
    s.seenAt = t;
    if (s.readers > 0) want(R.id, t);
    seen.add(R.id);
  }
  for (const [id, s] of ST) {
    if (seen.has(id)) continue;
    s.ready = false; s.readers = 0; s.seenAt = t;           // not on MediaMTX at all
    if (s.wantUntil < t - 10 * 60 * 1000) ST.delete(id);
  }
}

const loopbackIp = (a) => /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.test(String(a || ""));
/**
 * The MediaMTX auth hook for one of THIS site's room paths (webrtc.whipAuth forwards the other site's).
 * publish: WHIP with Pepe's bearer for that path. read: WHEP only, with a good ticket from a viewer who may still
 * hear the room. -> HTTP status (200 = allowed).
 */
async function auth(b, action, proto) {
  b = b || {};
  if (!on()) return 403;
  const p = String(b.path || "");
  const R = roomForPath(p);
  if (!R) return 403;
  if (action === "publish") {
    if (proto !== "webrtc") return 403;
    const cred = String(b.token || b.password || "").trim();
    if (!cred) return 401;
    return sameSecret(cred, pubKey(p)) ? 200 : 403;
  }
  if (action === "read") {
    if (proto !== "webrtc") return 403;                     // no HLS / RTSP of room audio
    if (!eligible(R)) return 403;
    let tok = null;
    try { tok = new URLSearchParams(String(b.query || "").replace(/^\?/, "")).get("pt"); } catch (e) { tok = null; }
    if (!tok && /^ra1\./.test(String(b.token || ""))) tok = String(b.token);
    const c = checkTicket(tok, p);
    if (!c) return loopbackIp(b.ip) ? 403 : 401;
    if (!(await require("./padaccess").fullFor(c.uid, R.id))) return 403;
    want(R.id);
    return 200;
  }
  return 403;
}

/** Pepe's audio post said he can publish this room (bridge.js /api/bridge/audio, rtc_cap). */
function noteCap(R, t = now()) { if (R) R.rtcCapAt = t; }
/** For the pad's live view: may this room's player try WebRTC first? */
function hint(R) { return eligible(R); }

module.exports = {
  PREFIX, PATH_RE, MODES, GRACE_MS, TICKET_MS, PENDING_MS,
  pathFor, roomForPath, pubKey, readTicket, checkTicket, isPrime, eligible, active, ticket, forBot, noteSync, noteCap, auth, hint, want,
  _state: ST,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _reset: () => { ST.clear(); pending.length = 0; },
};
