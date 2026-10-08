// webrtc.js — ultra-low-latency WebRTC on the stages (1.99et): WHIP ingest + WHEP playback through
// MediaMTX, and short-lived TURN REST credentials for a self-hosted coturn (deploy/webrtc/).
//
// Everything is behind the stage setting `webrtc_enabled` (stage_config, /stage/admin, default OFF).
// Off = nothing changes for anyone: /api/turn and the browser WHIP token route answer 404, no page gets a
// WebRTC field / script / button, the MediaMTX auth hook refuses every publish and read of this site's
// paths, and the MediaMTX sync doesn't run.
//
// How a WHIP stream becomes a stage slot:
//   publish   OBS 30+ ("WHIP" service) or the Go live page POSTs an SDP offer to
//             <WEBRTC_BASE>/whip/<slot stream name> with "Authorization: Bearer <credential>" (the slot's
//             stream key - the same key as RTMP - or a 10-minute browser token from
//             POST /api/stage/slots/:id/whip). MediaMTX asks POST /api/stage/whip-auth (loopback only), which
//             runs the SAME publish gate as nginx-rtmp's on_publish (mainstage.publishGate) and also checks
//             the path is that slot's stream name.
//   live      every 5 s the site reads MediaMTX's API (GET /v3/paths/list, loopback) - a ready path with an
//             open slot is that slot's heartbeat (publishing = 1, beat, via = 'whip'), exactly what on_update
//             does for RTMP, so billing / idle / ending work unchanged. A ready path WITHOUT an open slot
//             (ended, cut, banned) is kicked (POST /v3/webrtc/sessions/kick/<id>).
//   watch     MediaMTX remuxes the stream to HLS (<WEBRTC_BASE>/<stream>/index.m3u8 - the fallback and the
//             default player) and serves WHEP (<WEBRTC_BASE>/whep/<stream>) for the ⚡ Low latency toggle.
//             Reads are public for any open slot (there are no private stages).
// Pepe's RTMP stream and RTMP slots are untouched: they stay on nginx-rtmp's HLS (no WHEP - MediaMTX can't
// turn AAC into Opus), and bridge.js still reads /mnt/hls/broadcast.m3u8 freshness for ON AIR.
//
// 1.99fe: PARKED - everything below about Pepe's main stream over WHIP is OFF unless PEPE_WHIP=on is in the .env
// (default off: his paths are refused like any unknown path, no bot route, no ⚡ for his stage). MediaMTX has no
// "pepe" path and no relay yet (deploy/webrtc is unchanged); this is the site half, kept for the revisit.
// 1.99fg: switched on - deploy/webrtc ships the "pepe" path + pepe-relay.sh again (1.99fd templates); the env flag
// PEPE_WHIP=on still decides per site (prod has it, staging doesn't).
// 1.99fd: Pepe's MAIN stream can come in over WHIP too (⚡ for his stage). His OBS publishes H.264 + Opus to
// <WEBRTC_BASE>/whip/<PEPE_PATH> ("pepe" on prod, "stg-pepe" on staging) with Pepe's own bearer (pepeWhipKey: an
// HMAC of SECRET_KEY - nothing new to store; the bot fetches it with its token, POST /api/stage/pepe-whip). MediaMTX
// runs deploy/webrtc/pepe-relay.sh while the path is up: it reads the stream back over loopback RTSP and pushes it
// to nginx-rtmp (H.264 copied, Opus -> AAC) under his usual RTMP name, so /mnt/hls/broadcast.m3u8 and everything on
// it (ON AIR, snaps, clips, the HLS player) are unchanged. Pepe's path is NOT a slot: the sync never beats or kicks
// it, it only notes that it's up (pepeWhep() -> bridge.stage().whep -> the ⚡ toggle on his stage). His publish and
// the relay's loopback read work with webrtc_enabled off as well (it's his main stream); viewers' WHEP / HLS reads
// of it need the flag, like every other WebRTC read.
//
// env (all optional; defaults match deploy/webrtc/):
//   WEBRTC_BASE     public base of MediaMTX behind nginx                 https://stream.publicaccess.tv
//   MEDIAMTX_API    MediaMTX control API, loopback only                  http://127.0.0.1:9997
//   TURN_HOST       coturn host name                                     stream.publicaccess.tv
//   TURN_SECRET     coturn static-auth-secret (use-auth-secret). Never logged. Unset = STUN only.
//   TURN_TTL        TURN credential lifetime, seconds                    3600
//   WHIP_AUTH_PEER  the OTHER site's whip-auth URL. One MediaMTX serves prod ("stage-") and staging ("stg-")
//                   paths but has one auth hook; the site it calls forwards the other prefix to its peer.
//   PEPE_WHIP       "on" turns Pepe's main-stream WHIP handling on (1.99fe: parked, default off)
//   PEPE_WHIP_KEY_VERSION  bump to rotate Pepe's WHIP bearer (default 1); "off" refuses his WHIP publish
"use strict";
const crypto = require("crypto");
const http = require("http");

const BASE = String(process.env.WEBRTC_BASE || "https://stream.publicaccess.tv").replace(/\/+$/, "");
const API = String(process.env.MEDIAMTX_API || "http://127.0.0.1:9997").replace(/\/+$/, "");
const TURN_HOST = String(process.env.TURN_HOST || "stream.publicaccess.tv").trim();
const TURN_TTL = Math.max(300, Math.min(86400, Math.floor(Number(process.env.TURN_TTL)) || 3600));
const peer = () => String(process.env.WHIP_AUTH_PEER || "").trim();   // read per call
const TOKEN_SECRET = process.env.SECRET_KEY || crypto.randomBytes(32).toString("hex");
const TOKEN_TTL_MS = 10 * 60 * 1000;
// a stage stream name: prod "stage-<16 hex>", staging "stg-<16 hex>" (mainstage.book)
const PATH_RE = /^(stage|stg)-[0-9a-f]{16}$/;
const SYNC_MS = 5000;
// 1.99fd: Pepe's main-stream WHIP path - prod "pepe", staging "stg-pepe" (the other one belongs to the peer site)
const PEPE_PATHS = { prod: "pepe", staging: "stg-pepe" };
const pepePath = () => (process.env.STAGING ? PEPE_PATHS.staging : PEPE_PATHS.prod);
const isPepePath = (p) => p === PEPE_PATHS.prod || p === PEPE_PATHS.staging;
const pepeWhipOn = () => String(process.env.PEPE_WHIP || "").trim().toLowerCase() === "on";   // 1.99fe: parked, off
let pepeSeen = { ready: false, at: 0 };          // from the sync: is his path up right now?

let clock = () => Date.now();
const now = () => clock();
const ms = () => require("./mainstage");
const turnSecret = () => String(process.env.TURN_SECRET || "");   // read per call: never cached, never logged

function enabled() {
  try { return ms().config().webrtc_enabled === true; } catch (e) { return false; }
}
const whipUrl = (stream) => `${BASE}/whip/${stream}`;
const whepUrl = (stream) => `${BASE}/whep/${stream}`;
const hlsUrl = (stream) => `${BASE}/${stream}/index.m3u8`;
/** What the pages need (app.locals.webrtcCfg): null when off - templates render no WebRTC UI then. */
function webrtcCfg() {
  return enabled() ? { base: BASE, turn: "/api/turn" } : null;
}

// ── TURN REST credentials (draft-uberti-behave-turn-rest; coturn use-auth-secret) ──
// username = "<unix expiry>:<userId>", credential = base64(HMAC-SHA1(secret, username))
function turnCredentials(userId, secret, nowMs = now(), ttlSec = TURN_TTL) {
  const expiry = Math.floor(nowMs / 1000) + ttlSec;
  const username = expiry + ":" + String(userId).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
  const credential = crypto.createHmac("sha1", secret).update(username).digest("base64");
  return { username, credential, expiry };
}
/** iceServers for a viewer: STUN for everyone, TURN (udp, tcp, TLS 5349) only for a signed-in user. */
function iceServers(user, t = now()) {
  const stun = { urls: [`stun:${TURN_HOST}:3478`] };
  const secret = turnSecret();
  if (!user || !user.userId || !secret) return { iceServers: [stun], ttl: 0 };
  const c = turnCredentials(user.userId, secret, t, TURN_TTL);
  return {
    iceServers: [stun, { urls: [`turn:${TURN_HOST}:3478?transport=udp`, `turn:${TURN_HOST}:3478?transport=tcp`, `turns:${TURN_HOST}:5349?transport=tcp`],
                         username: c.username, credential: c.credential }],
    ttl: TURN_TTL, expires: c.expiry * 1000,
  };
}

// a small sliding-window limiter: hit(key) -> 0 (allowed) or seconds to wait
function limiter(max, windowMs) {
  const seen = new Map();
  return function hit(key, t = now()) {
    const a = (seen.get(key) || []).filter((x) => t - x < windowMs);
    if (a.length >= max) { seen.set(key, a); return Math.max(1, Math.ceil((windowMs - (t - a[0])) / 1000)); }
    a.push(t);
    seen.set(key, a);
    if (seen.size > 10000) for (const [k, v] of seen) if (!v.length || t - v[v.length - 1] >= windowMs) seen.delete(k);
    return 0;
  };
}
const TURN_LIMIT = { user: 20, anon: 30, windowMs: 10 * 60 * 1000 };
let turnUserHit = limiter(TURN_LIMIT.user, TURN_LIMIT.windowMs);
let turnIpHit = limiter(TURN_LIMIT.anon, TURN_LIMIT.windowMs);

// ── browser WHIP tokens: "w.<slotId>.<expiry ms>.<sig>" (the page never needs the stream key) ──
function whipToken(slotId, t = now()) {
  const exp = t + TOKEN_TTL_MS;
  const body = "w." + slotId + "." + exp;
  return body + "." + crypto.createHmac("sha256", TOKEN_SECRET).update("stage-whip:" + body).digest("base64url").slice(0, 32);
}
function parseWhipToken(tok, t = now()) {
  const m = /^w\.([A-Za-z0-9-]{8,64})\.(\d{10,16})\.([A-Za-z0-9_-]{32})$/.exec(String(tok || ""));
  if (!m || Number(m[2]) < t) return null;
  const want = crypto.createHmac("sha256", TOKEN_SECRET).update("stage-whip:w." + m[1] + "." + m[2]).digest("base64url").slice(0, 32);
  const a = Buffer.from(m[3]), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? m[1] : null;
}

// ── 1.99fd: Pepe's main-stream WHIP bearer: "pw" + an HMAC of SECRET_KEY (per site: prod and staging differ) ──
function pepeWhipKey() {
  const v = String(process.env.PEPE_WHIP_KEY_VERSION || "1").trim();
  if (!v || v === "off") return null;
  return "pw" + crypto.createHmac("sha256", TOKEN_SECRET).update("pepe-whip:" + pepePath() + ":" + v).digest("base64url").slice(0, 40);
}
function sameSecret(got, want) {
  if (!want) return false;
  const a = crypto.createHash("sha256").update(String(got)).digest(), b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}
const loopbackIp = (a) => /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.test(String(a || ""));
/** The auth hook for THIS site's Pepe path. Publish: WHIP with Pepe's bearer (works with the flag off - it's his
 *  main stream). Read: the relay (loopback RTSP, pepe-relay.sh) always; viewers (WHEP / MediaMTX HLS) only while
 *  webrtc_enabled is on. */
function pepeAuth(b, action, proto) {
  if (action === "publish") {
    if (proto !== "webrtc") return 403;
    const cred = String(b.token || b.password || "").trim();
    if (!cred) return 401;
    return sameSecret(cred, pepeWhipKey()) ? 200 : 403;
  }
  if (action === "read") {
    if (proto === "rtsp") return loopbackIp(b.ip) ? 200 : 403;
    if (!enabled()) return 403;
    return proto === "webrtc" || proto === "hls" ? 200 : 403;
  }
  return 403;
}
/** ⚡ for Pepe's stage: his WHEP URL while his WHIP path is up (seen by a sync in the last 15 s) and the flag is on. */
function pepeWhep() {
  if (!pepeWhipOn() || !enabled() || !pepeSeen.ready || now() - pepeSeen.at > 15000) return null;
  return whepUrl(pepePath());
}

// ── the MediaMTX auth hook (authMethod: http) ──
// Request: POST JSON {user, password, token, ip, action, path, protocol, id, query, userAgent}; any 2xx =
// allowed, anything else = refused (MediaMTX answers the client 401). The Bearer header arrives as `token`.
const readCache = new Map();   // path -> {at, ok}
async function whipAuth(b, opts = {}) {
  b = b || {};
  const action = String(b.action || ""), path = String(b.path || ""), proto = String(b.protocol || "");
  if (isPepePath(path)) {                                         // 1.99fd: Pepe's main stream (not a slot)
    if (!pepeWhipOn()) return 403;                                // 1.99fe: parked - refused like any unknown path
    if (path === pepePath()) return pepeAuth(b, action, proto);
    return peer() && !opts.forwarded ? forward(b) : 403;          // the other site's Pepe path
  }
  if (!PATH_RE.test(path)) return 403;
  const S = ms();
  if (!path.startsWith(S.STREAM_PREFIX)) {                       // the other site's path (prod <-> staging)
    return peer() && !opts.forwarded ? forward(b) : 403;
  }
  if (!enabled()) return 403;
  if (action === "publish") {
    if (proto !== "webrtc") return 403;                           // WHIP only (RTSP / RTMP / SRT are off in MediaMTX)
    const cred = String(b.token || b.password || "").trim();
    if (!cred) return 401;
    const slotId = parseWhipToken(cred);
    // relay keys never work here (noRelay): they are for the server's own ffmpeg -> nginx-rtmp
    const s = await S.publishGate(slotId ? { slotId } : { key: cred, noRelay: true });
    return s && s.stream === path ? 200 : 403;
  }
  if (action === "read" || action === "playback") {
    if (action === "playback") return 403;                        // no recordings
    const c = readCache.get(path);
    if (c && now() - c.at < 2000) return c.ok ? 200 : 403;
    const s = await S.openSlotByStream(path);
    const ok = !!s && s.mode !== "embed";
    readCache.set(path, { at: now(), ok });
    if (readCache.size > 500) readCache.clear();
    return ok ? 200 : 403;
  }
  return 403;                                                     // api / metrics / pprof are excluded in mediamtx.yml
}
function forward(b) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(peer()); } catch (e) { return resolve(403); }
    const body = Buffer.from(JSON.stringify(b));
    const req = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname, method: "POST", timeout: 4000,
      headers: { "Content-Type": "application/json", "Content-Length": body.length, "X-PATV-Forwarded": "1" } }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 300 ? 200 : (res.statusCode === 401 ? 401 : 403));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve(403));
    req.end(body);
  });
}

// ── MediaMTX control API (loopback) ──
let apiImpl = function (method, p) {
  return new Promise((resolve, reject) => {
    const u = new URL(API + p);
    const req = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method, timeout: 3000 }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode > 299) return reject(new Error("mediamtx " + res.statusCode));
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(e); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
};
let lastApiError = 0;
async function sync() {
  if (!enabled()) { pepeSeen = { ready: false, at: 0 }; return { skipped: true }; }
  let list;
  try { list = await apiImpl("GET", "/v3/paths/list?itemsPerPage=1000"); } catch (e) {
    pepeSeen = { ready: false, at: 0 };
    if (now() - lastApiError > 10 * 60 * 1000) { lastApiError = now(); console.error("[webrtc] MediaMTX API:", e.message); }
    return { error: true };       // MediaMTX down: no beats, so WHIP slots age off air like a dropped RTMP stream
  }
  const S = ms();
  const ready = new Map();
  // 1.99fd: Pepe's path is only noted (⚡ on his stage) - PATH_RE below keeps it out of the slot beats / kicks
  pepeSeen = { ready: ((list && list.items) || []).some((p) => p && p.name === pepePath() && (p.ready || p.available)), at: now() };
  for (const p of (list && list.items) || []) {
    if (p && (p.ready || p.available) && typeof p.name === "string" && PATH_RE.test(p.name) && p.name.startsWith(S.STREAM_PREFIX)) ready.set(p.name, p);
  }
  const orphans = await S.whipBeat([...ready.keys()]);
  let kicked = 0;
  for (const name of orphans) {
    const src = ready.get(name) && ready.get(name).source;
    if (src && src.type === "webRTCSession" && /^[0-9a-f-]{36}$/i.test(String(src.id || ""))) {
      try { await apiImpl("POST", "/v3/webrtc/sessions/kick/" + src.id); kicked++; } catch (e) { /* gone already */ }
    }
  }
  return { live: ready.size - orphans.length, kicked };
}
let soonT = null;
/** A slot just ended / was cut: run the sync now, so its WHIP publisher is kicked within a second. */
function soon() {
  if (soonT || !enabled()) return;
  soonT = setTimeout(() => { soonT = null; sync().catch(() => {}); }, 300);
  if (soonT.unref) soonT.unref();
}
let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => sync().catch((e) => console.error("[webrtc] sync:", e.message)), SYNC_MS);
  timer.unref();
}

// ── routes ──
const isLoopback = (a) => /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.test(String(a || ""));
function clientIp(req) {
  try { return require("./middleware/authGuard").clientIp(req); } catch (e) { return (req.socket && req.socket.remoteAddress) || "?"; }
}
function register(app, { addUser, isBotToken, noTimers } = {}) {
  app.locals.webrtcCfg = webrtcCfg;
  if (!noTimers) start();

  // 1.99fd: Pepe (bot token) fetches his main-stream WHIP URL + bearer to put into his OBS (obs_control.py)
  app.post("/api/stage/pepe-whip", (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!pepeWhipOn()) return res.status(404).json({ ok: false, error: "Not found." });   // 1.99fe: parked
    const b = req.body || {};
    if (typeof isBotToken !== "function" || !isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    const token = pepeWhipKey();
    if (!token) return res.status(409).json({ ok: false, error: "Pepe's WHIP publish is switched off (PEPE_WHIP_KEY_VERSION=off)." });
    res.json({ ok: true, url: whipUrl(pepePath()), token, path: pepePath(), whep: whepUrl(pepePath()) });
  });

  // MediaMTX's auth hook: only straight from the box (no proxy headers = not through the public nginx)
  app.post("/api/stage/whip-auth", async (req, res) => {
    const ra = req.socket.remoteAddress;
    if (!isLoopback(ra) || req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.headers["cf-connecting-ip"]) return res.status(403).end();
    try { res.status(await whipAuth(req.body || {}, { forwarded: req.headers["x-patv-forwarded"] === "1" })).end(); } catch (e) {
      console.error("[webrtc] whip-auth:", e.message);
      res.status(500).end();
    }
  });

  // ICE servers for the WHEP / WHIP clients: TURN for signed-in users, STUN only otherwise
  app.get("/api/turn", addUser, (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!enabled()) return res.status(404).json({ ok: false, error: "Not found." });
    const signed = !!(req.user && req.user.userId);
    const wait = signed ? turnUserHit("u:" + req.user.userId) : turnIpHit("ip:" + clientIp(req));
    if (wait) { res.set("Retry-After", String(wait)); return res.status(429).json({ ok: false, error: "Too many requests - try again in a bit." }); }
    res.json({ ok: true, ...iceServers(signed ? req.user : null) });
  });

  // the Go live page's browser WHIP: the slot owner gets the URL + a 10-minute token (never the stream key)
  app.post("/api/stage/slots/:id/whip", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!enabled()) return res.status(404).json({ ok: false, error: "Not found." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      const s = await ms().getSlot(req.params.id);
      if (!s || s.userId !== req.user.userId) return res.status(404).json({ ok: false, error: "That isn't your stream slot." });
      if (s.settled || s.mode === "embed" || !["waiting", "active"].includes(s.status)) {
        return res.status(409).json({ ok: false, error: "Your slot isn't open for streaming right now." });
      }
      if (await ms().isBanned(s.userId, s.room_id)) return res.status(403).json({ ok: false, error: "You can't use the stage." });
      res.json({ ok: true, url: whipUrl(s.stream), token: whipToken(s.id), expires: now() + TOKEN_TTL_MS });
    } catch (e) {
      console.error("[webrtc] whip token:", e.message);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });
}

module.exports = {
  register, start, sync, soon, enabled, webrtcCfg, whipAuth, turnCredentials, iceServers, whipToken, parseWhipToken,
  whipUrl, whepUrl, hlsUrl, limiter, PATH_RE, BASE, TURN_LIMIT,
  pepePath, pepeWhipKey, pepeWhep, PEPE_PATHS,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _setApi: (fn) => { apiImpl = fn; },
  _resetLimits: () => { turnUserHit = limiter(TURN_LIMIT.user, TURN_LIMIT.windowMs); turnIpHit = limiter(TURN_LIMIT.anon, TURN_LIMIT.windowMs); readCache.clear(); },
};
