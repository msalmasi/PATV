// hlsauth.js — nginx auth_request check for RTMP-slot HLS on Approved pads (1.99gk).
//
// nginx-rtmp writes every RTMP stage slot's HLS to /mnt/hls (prod, "stage-<16 hex>") or /mnt/hls/staging (staging,
// "stg-<16 hex>"), and the publicaccess.tv server block serves it under /hls/... as static files. Before 1.99gk
// anyone holding a slot's URL could play it, even on an Approved pad (padaccess.js). Now nginx asks this site first
// (deploy/hls-auth/: `auth_request` on the slot-stream locations only):
//
//   GET /api/stage/hls-auth      loopback only, no proxy headers (= nginx's internal /_hls_auth, never the public proxy)
//     X-Original-URI   the viewer's request ("/hls/stage-0123456789abcdef-17.ts?pt=...")
//     X-HLS-Client-IP  the viewer's real IP ($remote_addr after Cloudflare realip)
//     Cookie           the viewer's cookies (same origin on prod: the site's jwt login cookie comes along)
//   -> 200 allowed / 403 refused (body-less; nginx serves or refuses the file). Anything else (site down, a 500)
//      makes nginx answer 500: slot streams fail CLOSED while the site is down. Pepe's `broadcast` never asks (its own
//      nginx location), so his stream doesn't depend on the site.
//
// The decision (first match wins):
//   1. no slot stream name in the URI                         -> 200 (nginx only sends slot paths; nothing to guard)
//   2. a slot name with the OTHER site's prefix               -> 403 (nginx routes /hls/staging/ to staging: a mismatch
//                                                                   is a misroute, refuse rather than guess)
//   3. a name no slot ever had (stage_slots.stream)           -> 200 (= before 1.99gk; there is no pad to protect)
//   4. the slot's pad is Public / Members                     -> 200 (stage streams are public there, as before)
//   5. Approved pad:
//      a. ?pt= read token good for THIS stream, viewer inside -> 200 (padaccess.readAllowed; remembers the IP)
//      b. the IP showed a good token / session lately          -> 200 (READ_IP_MS, the same store as MediaMTX reads)
//      c. the jwt login cookie is an account inside the pad    -> 200 (owner, approved member, Admin / Staff)
//      d. otherwise                                            -> 403
//   The player (public/js/stage-player.js) puts ?pt= on EVERY request of a tokenized stream (VHS drops the query on
//   segments), so (a) is the normal path and (b) the safety net.
//
// Speed: per call it's a regex, a Map hit for the stream's pad (stage_slots is read once per stream per 10 min - the
// stream -> pad mapping never changes; misses retry after 10 s), padaccess's in-memory level / member sets, an HMAC,
// and a 15 s decision cache (stream|ip|pt|login -> allowed); refusals are cached 2 s. No DB per segment. The route is
// registered before the session / body middleware (index.js) so a segment check doesn't make a session.
"use strict";
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { getQuery } = require("./dbUtils");

const STAGING = !!process.env.STAGING;
const PREFIX = STAGING ? "stg-" : "stage-";
const STREAM_RE = /\/((?:stage|stg)-[0-9a-f]{16})(?=[/.?-]|$)/;
const ROOM_TTL_MS = 10 * 60e3;       // stream -> pad (never changes for a slot)
const MISS_TTL_MS = 10e3;            // a stream name with no slot (yet)
const OK_TTL_MS = 15e3;              // a cached "allowed"
const NO_TTL_MS = 2e3;               // a cached "refused"
const LOGIN_TTL_MS = 60e3;           // a verified login cookie -> user id
let NOW = () => Date.now();

const roomCache = new Map();         // stream -> {room|null, until}
const roomLoads = new Map();         // stream -> in-flight promise
const decisions = new Map();         // key -> {ok, why, until}
const logins = new Map();            // sha256(jwt) -> {uid|null, until}
const stats = { calls: 0, cached: 0, db: 0 };

const isLoopback = (a) => /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.test(String(a || ""));
const trim = (m, max) => { if (m.size > max) m.clear(); };

/** The pad (room id) a slot stream belongs to, or null when no slot ever had that name. */
async function roomOf(stream) {
  const c = roomCache.get(stream);
  if (c && c.until > NOW()) return c.room;
  if (roomLoads.has(stream)) return roomLoads.get(stream);
  const p = (async () => {
    stats.db++;
    const r = (await getQuery("SELECT room_id FROM stage_slots WHERE stream = ? LIMIT 1", [stream]))[0];
    const room = r ? r.room_id || require("./rooms").HOUSE_ROOM : null;
    roomCache.set(stream, { room, until: NOW() + (room ? ROOM_TTL_MS : MISS_TTL_MS) });
    trim(roomCache, 5000);
    return room;
  })().finally(() => roomLoads.delete(stream));
  roomLoads.set(stream, p);
  return p;
}

/** The user id of a valid jwt login cookie (verified once a minute per cookie), else null. */
function loginOf(cookieHeader) {
  const m = /(?:^|;\s*)jwt=([^;]+)/.exec(String(cookieHeader || ""));
  if (!m || !process.env.SECRET_KEY) return null;
  let tok = m[1];
  try { tok = decodeURIComponent(tok); } catch (e) { /* as is */ }
  const k = crypto.createHash("sha256").update(tok).digest("base64url");
  const c = logins.get(k);
  if (c && c.until > NOW()) return c.uid;
  let uid = null;
  try { uid = (jwt.verify(tok, process.env.SECRET_KEY) || {}).userId || null; } catch (e) { uid = null; }
  logins.set(k, { uid: uid ? String(uid) : null, until: NOW() + LOGIN_TTL_MS });
  trim(logins, 20000);
  return uid ? String(uid) : null;
}

/**
 * The decision for one HLS request. {uri, ip, cookie} -> {ok, why}. Throws only when the slot lookup fails (the route
 * answers 500 -> nginx refuses: fail closed).
 */
async function decide({ uri, ip, cookie } = {}) {
  stats.calls++;
  const raw = String(uri || "");
  const q = raw.indexOf("?");
  const pathPart = q < 0 ? raw : raw.slice(0, q);
  const query = q < 0 ? "" : raw.slice(q + 1);
  const m = STREAM_RE.exec(pathPart);
  if (!m) return { ok: true, why: "not-a-slot" };
  const stream = m[1];
  if (!stream.startsWith(PREFIX)) return { ok: false, why: "other-site" };
  const PA = require("./padaccess");
  if (!PA.isReady()) await PA.init();
  if (!PA.anyApproved()) return { ok: true, why: "no-approved-pads" };
  const room = await roomOf(stream);
  if (!room) return { ok: true, why: "unknown-stream" };
  if (!PA.isApproved(room)) return { ok: true, why: "open-pad" };

  let pt = "";
  try { pt = new URLSearchParams(query).get("pt") || ""; } catch (e) { pt = ""; }
  const uid = loginOf(cookie);
  const key = stream + "|" + (ip || "") + "|" + pt + "|" + (uid || "");
  const c = decisions.get(key);
  if (c && c.until > NOW()) { stats.cached++; return { ok: c.ok, why: c.why + "/cached" }; }

  let ok = false, why = "refused";
  if (pt && (await PA.readAllowed({ query: "pt=" + encodeURIComponent(pt), ip }, stream, room))) { ok = true; why = "token"; }
  else if (await PA.readAllowed({ ip }, stream, room)) { ok = true; why = "ip"; }
  else if (uid && (await PA.userInside(uid, room))) { ok = true; why = "session"; PA.rememberIp(ip, stream); }
  decisions.set(key, { ok, why, until: NOW() + (ok ? OK_TTL_MS : NO_TTL_MS) });
  trim(decisions, 50000);
  return { ok, why };
}

function register(app) {
  app.get("/api/stage/hls-auth", async (req, res) => {
    const ra = req.socket && req.socket.remoteAddress;
    // straight from nginx's internal location only: the public proxy always sets these headers
    if (!isLoopback(ra) || req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.headers["cf-connecting-ip"]) {
      return res.status(403).end();
    }
    try {
      const d = await decide({ uri: req.headers["x-original-uri"], ip: String(req.headers["x-hls-client-ip"] || "").trim(), cookie: req.headers.cookie });
      res.set("X-HLS-Auth", d.why);
      res.status(d.ok ? 200 : 403).end();
    } catch (e) {
      console.error("[hlsauth]", e.message);
      res.status(500).end();
    }
  });
}

/** Any pad's level / members changed: forget cached decisions (refusals AND allowances). */
function flush() { decisions.clear(); }
try { require("./padaccess").onChange(flush); } catch (e) { /* padaccess missing in a partial test */ }

module.exports = {
  register, decide, roomOf, loginOf, flush, stats, PREFIX, STREAM_RE,
  _setClock: (fn) => { NOW = fn || (() => Date.now()); },
  _reset: () => { roomCache.clear(); roomLoads.clear(); decisions.clear(); logins.clear(); stats.calls = stats.cached = stats.db = 0; },
};
