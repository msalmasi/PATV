// roomrtc.js — low-latency room audio over WebRTC (1.99il). The pad's room player can hear the Camfrog room about
// half a second behind (WHEP through MediaMTX) instead of ~1.5 s (the MP3-over-HTTP relay in bridge.js, which stays
// as the automatic fallback).
//
//   Pepe   net_audio's per-room mix -> ffmpeg (Opus, WHIP muxer) -> MediaMTX path <PREFIX><16 hex>, ONE path per room,
//          only while the site says someone wants it (the `rtc` field of the /api/bridge/audio answer, below)
//   viewer POST /api/rooms/<slug>/audio/rtc -> a 2-minute read ticket on the WHEP URL (?pt=) -> WHEP -> MediaMTX
//          asks the auth hook (webrtc.js -> auth() here), which checks the ticket AND that the viewer may still hear
//          the room (padaccess.full: the same rule as /p/<slug>/audio). Anything that fails -> the page plays MP3.
//          audiogate: and it keeps answering to that rule while it plays - recheck() kicks a session whose listener no longer
//          passes (a pad tightened, a member removed, signed out, the bridge perk lost), like the MP3 relay's listeners.
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
const ST = new Map();                  // room id -> {wantUntil, readers, ready, seenAt, readerIds}
const pending = [];                    // times tickets were handed out (the cap counts them for PENDING_MS)
// adultgate site: who each WebRTC reader session is (the auth hook's session id -> the account its ticket was for, null =
// signed out), so recheck() can end the sessions the 18+ gate stops once it applies to their room
const READERS = new Map();             // session id -> {uid, roomId, at, ls}
// audiogate: the sign-in (sessions.js id) each signed-in ticket was handed out under, by the ticket's signature - memory only,
// for TICKET_MS (a ticket only opens a session): the hook gives it to the session it opens (READERS.ls), so signing out ends
// that WebRTC session too, and a ticket from before a sign-out opens nothing. A restart forgets them: those sessions answer by
// account only (as before).
const TICKET_LS = new Map();           // ticket signature -> {uid, ls, until}
const TICKET_LS_MAX = 20000;
const ticketSig = (tok) => { const m = /\.([A-Za-z0-9_-]{32})$/.exec(String(tok || "")); return m ? m[1] : null; };
function noteTicketSession(tok, uid, ls, t = now()) {
  const sig = ticketSig(tok);
  if (!sig || !uid || !ls) return;
  for (const [k, v] of TICKET_LS) { if (v.until > t && TICKET_LS.size < TICKET_LS_MAX) break; TICKET_LS.delete(k); }
  TICKET_LS.set(sig, { uid: String(uid), ls: String(ls), until: t + TICKET_MS });
}
function ticketSession(tok, uid, t = now()) {
  const v = TICKET_LS.get(ticketSig(tok) || "");
  return v && v.until > t && v.uid === String(uid || "") ? v.ls : null;
}
function st(id) {
  let s = ST.get(id);
  if (!s) { s = { wantUntil: 0, readers: 0, ready: false, seenAt: 0, readerIds: [] }; ST.set(id, s); }
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
function ticket(user, R, t = now(), { session = null } = {}) {
  if (!on()) return { ok: false, fallback: "off" };
  if (!eligible(R, t)) return { ok: false, fallback: R && R.audio ? "not-eligible" : "no-audio" };
  const { cap } = cfg();
  if (cap <= 0 || active(t) >= cap) return { ok: false, fallback: "busy" };
  const p = pathFor(R.id);
  pending.push(t);
  want(R.id, t);
  const s = st(R.id);
  const uid = user && user.userId ? String(user.userId) : null;
  const tk = readTicket(uid, p, t);
  if (uid && session) noteTicketSession(tk, uid, session, t);      // audiogate
  const url = W().whepUrl(p) + "?pt=" + encodeURIComponent(tk);
  // 1.99yd: the player's jitter buffer target comes from the room-audio settings (/admin/pepe/audio)
  let jitter = 200;
  try { jitter = require("./roomaudiocfg").jitterMs(); } catch (e) { jitter = 200; }
  // micvad 1.99akk: levels = the page may read its own received audio level (getStats) for the mic bars where it has no analyser (iPhone)
  let levels = false;
  try { levels = require("./roomaudiocfg").levelsOn(); } catch (e) { levels = false; }
  return { ok: true, whep: url, ready: !!s.ready && t - s.seenAt <= SYNC_FRESH_MS, expires: t + TICKET_MS, jitter_ms: jitter, levels };
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
    const rd = (Array.isArray(p.readers) ? p.readers : []).filter((r) => r && r.type === "webRTCSession");
    s.readers = rd.length;
    s.readerIds = rd.map((r) => String(r.id || "")).filter((x) => /^[0-9a-f-]{36}$/i.test(x));     // adultgate site
    s.seenAt = t;
    if (s.readers > 0) want(R.id, t);
    seen.add(R.id);
  }
  for (const [id, s] of ST) {
    if (seen.has(id)) continue;
    s.ready = false; s.readers = 0; s.readerIds = []; s.seenAt = t;           // not on MediaMTX at all
    if (s.wantUntil < t - 10 * 60 * 1000) ST.delete(id);
  }
  // adultgate site: forget sessions MediaMTX no longer lists
  const live = new Set([...ST.values()].flatMap((s) => s.readerIds || []));
  for (const [sid, r] of READERS) if (!live.has(sid) && t - r.at > 60 * 1000) READERS.delete(sid);
}

/**
 * audiogate (was adultgate site's 18+-only re-check): the MP3 relay's audience rule for the WebRTC room listeners already
 * connected - on a change (padaccess.onChange: a level / members; adultgate.onChange: the 18+ switch, a pad marked 18+) and on
 * bridge.js's periodic tick (sign-outs, accounts gone or demoted, the 💎 bridge perk lost). Each session the hook let in is asked
 * again - padaccess.hearNow for its account and the sign-in its ticket came with, the pad's bridge perk - and one that fails is
 * kicked (the player falls back to the MP3 relay, which refuses them too). Every session the hook saw counts, also one MediaMTX
 * hasn't listed yet. A session the hook never saw (a site restart since) is ended on a change, not on the periodic tick - its
 * listener can ask for a new ticket. Never cut: a pad open to everyone (no lookups), a lookup that fails (kept, asked again).
 * only = a room id, a (roomId) -> boolean filter, or null (every room). -> how many were ended
 */
async function recheck(why = "change", only = null) {
  const PA = require("./padaccess");
  const inScope = typeof only === "function" ? only : only == null ? () => true : (id) => id === String(only);
  const perkOk = (id) => { try { return require("./bridge").bridgeOk(id); } catch (e) { return true; } };
  const byRoom = new Map();
  const add = (roomId, sid) => { if (!byRoom.has(roomId)) byRoom.set(roomId, new Set()); byRoom.get(roomId).add(sid); };
  for (const [sid, r] of READERS) if (r && r.roomId) add(r.roomId, sid);
  for (const [roomId, s] of ST) for (const sid of s.readerIds || []) add(roomId, sid);
  let n = 0, failed = 0;
  for (const [roomId, sids] of byRoom) {
    if (!inScope(roomId)) continue;
    const perk = perkOk(roomId);
    if (perk && PA.full(null, roomId)) continue;     // open to everyone right now: nothing to ask
    for (const sid of sids) {
      const r = READERS.get(sid);
      let stop;
      if (!perk) stop = true;
      else if (!r || r.roomId !== roomId) stop = why !== "tick";
      else { try { stop = !(await PA.hearNow(r.uid, roomId, { session: r.ls || null })); } catch (e) { stop = false; failed++; } }
      if (!stop) continue;
      try { require("./livecam").kickReader(sid); } catch (e) { /* best effort */ }
      READERS.delete(sid);
      n++;
    }
  }
  if (n) console.log(`[roomrtc] audiogate (${why}): ended ${n} WebRTC room listener(s)`);
  if (failed) console.error(`[roomrtc] audiogate (${why}): ${failed} listener check(s) failed - kept, asked again next pass`);
  return n;
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
    // audiogate: + the sign-in the ticket was asked under is still live (hearNow); a lookup that fails answers as before (fullFor:
    // as if signed out - a Public pad still plays)
    const ls = c.uid ? ticketSession(tok, c.uid) : null;
    let may;
    try { may = await require("./padaccess").hearNow(c.uid, R.id, { session: ls }); } catch (e) { may = require("./padaccess").full(null, R.id); }
    if (!may) return 403;
    want(R.id);
    // adultgate site: who this session is, for recheck() (MediaMTX passes the session id with the read); audiogate: + its sign-in
    if (b.id && /^[0-9a-f-]{36}$/i.test(String(b.id))) {
      READERS.set(String(b.id), { uid: c.uid || null, roomId: R.id, at: now(), ls });
      if (READERS.size > 20000) READERS.delete(READERS.keys().next().value);
    }
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
  pathFor, roomForPath, pubKey, readTicket, checkTicket, isPrime, eligible, active, ticket, forBot, noteSync, noteCap, auth, hint, want, recheck,
  _state: ST, _readers: READERS, _ticketSessions: TICKET_LS, ticketSession,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _reset: () => { ST.clear(); pending.length = 0; READERS.clear(); TICKET_LS.clear(); },
};
