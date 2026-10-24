// padaccess.js — who can see a pad on the website (1.99fu). Pad owners pick one of three levels in pad settings
// (General → "Who can see this pad"):
//
//   public    anyone, signed out too: the pad page and every tab, the feed, stories (with their pictures), the stage
//             stream, the live Camfrog room bridge (chat, people, mic, room audio) and analytics. It lifts every
//             "sign in to see this" gate for THIS pad's content. NSFW stays hidden from signed-out visitors (the feed's
//             own sfw rules are untouched).
//   members   the DEFAULT, and exactly what every pad did before 1.99fu: signed-out visitors see the pad page, its
//             (SFW) posts, its stage stream and its story circles; the live Camfrog room (chat / people / mic /
//             audio), the story pictures, the room topic and analytics are for signed-in members.
//   approved  only members the owner approved (pad_members), plus the pad's owner, site Admins and Staff. Everyone
//             else gets a locked card with "Request access" on the pad's own address and the pad is left out of
//             everything else - /p, Trending, Top Pads, the homepage pick, story strips, feeds (All / Following /
//             profiles / Hop / gallery / search), post pages, media files, the stage's MediaMTX reads, the bridge APIs,
//             analytics, follows, DM post cards. Its title, description, posts and media never reach a non-member.
//
// Pepe's Camfrog room itself is not affected: this only governs the website.
//
// adultgate site: the 18+ pad gate (adultgate.js - one owner switch on /pads/admin#adult, OFF by default). While it is on,
// an 18+ pad's members-tier content (everything full() guards) also needs a signed-in viewer who confirmed they're 18 or
// older (the pad's owner and site staff exempt) - full() includes it, adultGate() says why not ("signin" | "confirm"), and
// register()'s second /api/rooms/:slug gate covers the live-room APIs (adultgate.LIVE_API, any letter case), which also
// check the room they resolved themselves. adultSlots() blanks a stage cam slot's name, adultGateFor() is the async
// per-account form (open streams re-check with it). Off: no change.
// stagefix site: camVisible() / camSlotsFor() - a stage's 🎬 cam slots are listed only to signed-in viewers who may see the
// pad's live room (full(), so the 18+ gate too); signed-out visitors never learn a cam is on a stage, Public pads included.
//
// Data (this module owns both tables; nothing is written unless an owner changes a setting or someone asks to join)
//   pad_access   room_id PK, level ('public' | 'members' | 'approved'), updated, updated_by. No row = "members".
//   pad_members  room_id + user_id PK, status ('pending' | 'approved' | 'denied' | 'removed'), note (the request's
//                message), requested_at, decided_at, decided_by. Only 'approved' rows grant access.
//
// Everything that reads access is synchronous off an in-memory cache (levels + approved member sets), loaded once at
// init() and updated on every write - pages call it per row without a query. Callers that may run before the first
// load await init() (it is cheap afterwards).
//
// Stage reads (webrtc.js): MediaMTX's auth hook has no idea who the viewer is, so a viewer of an Approved pad's
// stage gets a signed read token (readToken: bound to the stream name + their user id, 12 h) on the slot's HLS / WHEP
// URLs (?pt=...). The hook checks it (still a member?), and a viewer whose token checked out may fetch that stream's
// HLS parts from the same IP for READ_IP_MS without it (players drop the query on segment URLs).
// 1.99gk: RTMP slots' HLS (nginx-rtmp, /hls/...) is checked the same way through nginx auth_request (hlsauth.js), which
// also accepts the viewer's login cookie; the player now keeps ?pt= on every request. Any level / member change
// forgets the remembered IPs (bump).
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)
const rooms = require("./rooms");
const AG = require("./adultgate");   // adultgate site: the 18+ pad gate (off by default)

const LEVELS = Object.freeze(["public", "members", "approved"]);
const DEFAULT = "members";
const INFO = Object.freeze({
  public: { icon: "🌐", label: "Public", what: "Anyone, signed out too: the page, feed, stories, stage stream, the live Camfrog room chat and analytics. NSFW stays hidden from signed-out visitors." },
  members: { icon: "👥", label: "Members", what: "Anyone signed in to PATV. Signed-out visitors still see the page, posts and stage, but not the live room chat, story pictures or analytics. (The default.)" },
  approved: { icon: "🔒", label: "Approved", what: "Only members you approve (plus you and the site admins). Everyone else sees a locked card and can ask to join." },
});
const NOTE_MAX = 200;
const RETRY_MS = 24 * 3600e3;            // after a denial / a removal, a new request waits this long
const PENDING_MAX = 500;                 // open requests kept per pad
const READ_TTL_MS = 12 * 3600e3;         // a stage read token
const READ_IP_MS = 10 * 60e3;            // an IP that showed a good token may read that stream's HLS parts this long
const SECRET = process.env.SECRET_KEY || crypto.randomBytes(32).toString("hex");
let NOW = () => Date.now();

const insideAll = (u) => SP.can(u, "pads.approved_inside");   // 1.99ack (siteperms.js): inside every Approved pad
const cleanLevel = (v) => (LEVELS.includes(String(v || "").toLowerCase()) ? String(v).toLowerCase() : null);

class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }

// ── cache ──
let LEVEL = new Map();         // room id -> level (rows that aren't the default)
let MEMBERS = new Map();       // room id -> Set(user id) - approved only
let loaded = false;
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS pad_access (room_id TEXT PRIMARY KEY, level TEXT NOT NULL DEFAULT 'members',
                      updated INTEGER, updated_by TEXT)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS pad_members (room_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
                      note TEXT, requested_at INTEGER, decided_at INTEGER, decided_by TEXT, PRIMARY KEY (room_id, user_id))`);
      await runQuery("CREATE INDEX IF NOT EXISTS pad_members_user ON pad_members (user_id)");
      await seedLevels();
      await load();
      // adultgate site: the 18+ gate's switch + confirmed accounts load with the levels. A failure doesn't stop the levels:
      // the gate itself fails closed (18+ pads stay gated), retries and logs (adultgate.init)
      try { await AG.init(); } catch (e) { /* adultgate logged it; 18+ pads stay gated until it loads */ }
    })().catch((e) => { console.error("[padaccess] init:", e.message); ready = null; throw e; });
  }
  return ready;
}
/**
 * S1 Q4 (ADR 0007 D1): a seeded pad's level (rooms.SEEDS `access`: the chat hub's staff and canary pads are Approved) - once
 * per pad (rooms_kv seeded_access:<id>), only when its registry row exists and it has no level of its own yet, so an owner's
 * or admin's later choice stays. Never in the way of the levels: a failure is logged and retried at the next start.
 */
async function seedLevels() {
  try {
    await rooms.init();
    for (const s of rooms.SEEDS) {
      const lv = cleanLevel(s.access);
      if (!lv || (await rooms.kvGet("seeded_access:" + s.room_id))) continue;
      if (!(await getQuery("SELECT 1 FROM rooms_registry WHERE room_id = ?", [s.room_id])).length) continue;
      await runQuery("INSERT INTO pad_access (room_id, level, updated, updated_by) VALUES (?, ?, ?, 'seed') ON CONFLICT(room_id) DO NOTHING",
                     [s.room_id, lv, NOW()]);
      await rooms.kvSet("seeded_access:" + s.room_id, lv);
    }
  } catch (e) { console.error("[padaccess] seed levels:", e.message); }
}
async function load() {
  const L = new Map(), M = new Map();
  const rowed = new Set();
  for (const r of await getQuery("SELECT room_id, level FROM pad_access")) {
    rowed.add(String(r.room_id));
    const lv = cleanLevel(r.level);
    if (lv && lv !== DEFAULT) L.set(r.room_id, lv);
  }
  // S1 Q4 (review): a seeded pad without a level row yet (seedLevels failed or hasn't run) reads as its seed's level - the
  // staff and canary pads are Approved from their first moment, never open to every member while the row is missing
  for (const s of rooms.SEEDS) {
    const lv = cleanLevel(s.access);
    if (lv && lv !== DEFAULT && !rowed.has(s.room_id)) L.set(s.room_id, lv);
  }
  for (const r of await getQuery("SELECT room_id, user_id FROM pad_members WHERE status = 'approved'")) {
    if (!M.has(r.room_id)) M.set(r.room_id, new Set());
    M.get(r.room_id).add(String(r.user_id));
  }
  LEVEL = L; MEMBERS = M; loaded = true;
}

// ── reads (synchronous, off the cache) ──
/** A pad's level. Profile pads are always "members" (a profile has its own privacy settings). */
function levelOf(roomId) {
  const id = String(roomId || "");
  if (!id || rooms.isProfile(id)) return DEFAULT;
  return LEVEL.get(id) || DEFAULT;
}
const isPublic = (roomId) => levelOf(roomId) === "public";
const isApproved = (roomId) => levelOf(roomId) === "approved";
/** Any Approved pads at all? (the gates skip all work while there are none) */
const anyApproved = () => [...LEVEL.values()].some((v) => v === "approved");
function ownerIdOf(roomId) {
  const R = rooms.getCached(String(roomId || ""));
  return R && R.owner && R.owner.userId ? String(R.owner.userId) : null;
}
const isMember = (userId, roomId) => !!userId && !!(MEMBERS.get(String(roomId || "")) || new Set()).has(String(userId));
/** Inside an Approved pad: its owner, site Admins / Staff, and the members the owner approved. */
function inside(u, roomId) {
  if (!u || !u.userId) return false;
  if (insideAll(u)) return true;
  const own = ownerIdOf(roomId);
  if (own && own === String(u.userId)) return true;
  return isMember(u.userId, roomId);
}
/** May `u` (null = signed out) see this pad at all - its title, posts, media? Public / Members: everyone. */
function canSee(u, roomId) {
  return levelOf(roomId) !== "approved" || inside(u, roomId);
}
/**
 * adultgate site: the 18+ rule alone (adultgate.gate) -> "ok" | "signin" | "confirm". "ok" for every pad while the switch
 * is off; opts.always applies it anyway (features that gate 18+ pads on their own terms, e.g. CL3's chat history).
 */
function adultGate(u, roomId, opts) { return AG.gate(u || null, roomId, opts); }
/**
 * adultgate site: a stage's public slots for `viewer`: a 🎬 cam slot (someone's Camfrog cam, mainstage source 'cam') on an
 * 18+ pad the gate stops them at carries no name or title (the cam itself needs a ticket - padFull - anyway). Off: as is.
 */
function adultSlots(slots, viewer) {
  if (!Array.isArray(slots)) return slots;
  return slots.map((s) => (s && s.cam && s.room_id && AG.gate(viewer || null, s.room_id) !== "ok" ? { ...s, display: "", title: null, adult: true } : s));
}
/**
 * stagefix site: may `viewer` know a 🎬 cam slot (someone's Camfrog cam on the pad's stage, mainstage source 'cam') is there -
 * its name, that it's on? Only a SIGNED-IN viewer (live cams are never for signed-out visitors, Public pads included) who
 * may see the pad's live room: full() - inside an Approved pad, past the 18+ gate (adultGate). The picture is gated per
 * viewer on top (livecam.stageViewerWhy).
 */
function camVisible(viewer, roomId) {
  return !!(viewer && viewer.userId) && full(viewer, roomId);
}
/** stagefix site: a stage's slot list for `viewer` without the 🎬 cam slots they may not know about (camVisible). */
function camSlotsFor(slots, viewer) {
  if (!Array.isArray(slots)) return slots;
  return slots.filter((s) => !(s && s.cam) || camVisible(viewer || null, s.room_id));
}
/**
 * May `u` see this pad's members-tier content - the live Camfrog room (chat, people, mic, audio), story pictures, the
 * room topic, analytics? Public: everyone. Members: signed in. Approved: inside. adultgate site: with the 18+ switch on,
 * an 18+ pad's also needs a signed-in, age-confirmed viewer (owner / staff exempt).
 */
function full(u, roomId) {
  if (AG.gate(u || null, roomId) !== "ok") return false;
  const lv = levelOf(roomId);
  if (lv === "public") return true;
  if (lv === "approved") return inside(u, roomId);
  return !!(u && u.userId);
}
/** The Approved pads `u` may NOT see (staff: none). The feed's queries leave their placements out. */
function blockedFor(u) {
  if (insideAll(u)) return [];
  const out = [];
  for (const [id, lv] of LEVEL) if (lv === "approved" && !inside(u, id)) out.push(id);
  return out;
}
/** Filter any list of rows by pad id (`key`: the field holding it, or a function). */
function visibleRows(u, list, key = "id") {
  const get = typeof key === "function" ? key : (r) => r && r[key];
  return (list || []).filter((r) => canSee(u, get(r)));
}
/**
 * gatefix site: the Camfrog rooms (pad room ids) of the Approved pads `u` is outside of. Who's around in a pad's live
 * room, who's on the mic and what's said there are its members-tier content, so Pepe's answers to this member - his
 * site DMs (messages.pepeClaim) and his Telegram chat (telegram.whois) - leave those rooms out of the live context they
 * are written from (camfrog-bot pepe_dmctx reads user.rooms_gated). Not tied to any switch; site-only pads have no room.
 */
function liveRoomsOutside(u) {
  return blockedFor(u && u.userId ? u : null).filter((id) => !rooms.isCommunityOnly(id));
}
/**
 * gatefix site: add liveRoomsOutside(u) to a "who they are" object for Pepe as user.rooms_gated - joined with whatever is
 * there already (staging's 18+ gate fills the same field), each room once; nothing left out = no field (as before).
 * Loads the levels first: if they can't be read it throws, and the caller answers nothing rather than everything.
 */
async function gateLiveRooms(who, u) {
  await init();
  const ids = new Set(Array.isArray(who.rooms_gated) ? who.rooms_gated : []);
  for (const id of liveRoomsOutside(u)) ids.add(id);
  if (ids.size) who.rooms_gated = [...ids];
  return who;
}

// ── requests / members ──
async function row(roomId, userId) {
  return (await getQuery("SELECT * FROM pad_members WHERE room_id = ? AND user_id = ?", [String(roomId), String(userId)]))[0] || null;
}
/** What `u` sees about their own access to a pad: {level, see, full, inside, owner, staff, member, request, retryAt}. */
async function state(u, roomId) {
  await init();
  const lv = levelOf(roomId);
  const signed = !!(u && u.userId);
  const r = signed ? await row(roomId, u.userId) : null;
  const own = signed && ownerIdOf(roomId) === String(u.userId);
  const retryAt = r && (r.status === "denied" || r.status === "removed") ? Number(r.decided_at || 0) + RETRY_MS : null;
  return { level: lv, info: INFO[lv], see: canSee(u, roomId), full: full(u, roomId), inside: inside(u, roomId), owner: own, staff: insideAll(u),
           member: signed && isMember(u.userId, roomId), request: r ? r.status : null, retryAt: retryAt && retryAt > NOW() ? retryAt : null };
}

const padName = (R) => (R ? "p/" + require("./pads").padSlug(R) : "the pad");
async function userName(userId) {
  const r = (await getQuery("SELECT username FROM users WHERE userId = ?", [String(userId)]).catch(() => []))[0];
  return r ? r.username : null;
}

/** `u` asks to join Approved pad R. Idempotent while a request is waiting. -> state */
async function request(u, R, note) {
  await init();
  if (!u || !u.userId) throw new Refuse(401, "Sign in to ask for access.");
  if (!R || !R.id) throw new Refuse(404, "No such pad.");
  if (levelOf(R.id) !== "approved") throw new Refuse(409, "This pad is open to members - no need to ask.");
  if (inside(u, R.id)) throw new Refuse(409, "You already have access to this pad.");
  const have = await row(R.id, u.userId);
  if (have && have.status === "pending") return state(u, R.id);
  if (have && (have.status === "denied" || have.status === "removed") && NOW() - Number(have.decided_at || 0) < RETRY_MS) {
    throw new Refuse(429, "The pad's owner said no for now - you can ask again tomorrow.");
  }
  const open = (await getQuery("SELECT COUNT(*) AS n FROM pad_members WHERE room_id = ? AND status = 'pending'", [R.id]))[0].n;
  if (open >= PENDING_MAX) throw new Refuse(429, "This pad has too many requests waiting - try again later.");
  const text = String(note == null ? "" : note).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim().slice(0, NOTE_MAX) || null;
  const t = NOW();
  await runQuery(`INSERT INTO pad_members (room_id, user_id, status, note, requested_at, decided_at, decided_by) VALUES (?, ?, 'pending', ?, ?, NULL, NULL)
                  ON CONFLICT(room_id, user_id) DO UPDATE SET status = 'pending', note = excluded.note, requested_at = excluded.requested_at,
                  decided_at = NULL, decided_by = NULL`, [R.id, String(u.userId), text, t]);
  const own = ownerIdOf(R.id);
  if (own) {
    const slug = require("./pads").padSlug(R);
    rooms.notify(own, { kind: "room", title: `${u.username || "Someone"} asked to join ${padName(R)}`, body: text ? `"${text}"` : "",
                        link: "/p/" + encodeURIComponent(slug) + "/settings#access", ref: `pad-access:${R.id}:${u.userId}` }).catch(() => {});
  }
  return state(u, R.id);
}

/** The owner's view: the level, the requests waiting and the approved members. */
async function listFor(roomId) {
  await init();
  const rows = await getQuery(`SELECT m.user_id, m.status, m.note, m.requested_at, m.decided_at, m.decided_by, u.username, u.displayname
                               FROM pad_members m LEFT JOIN users u ON u.userId = m.user_id
                               WHERE m.room_id = ? AND m.status IN ('pending', 'approved') ORDER BY m.requested_at DESC`, [String(roomId)]);
  const shape = (r) => ({ userId: r.user_id, username: r.username || null, display: r.displayname || r.username || "[gone]", note: r.note || null,
                          requested_at: Number(r.requested_at) || null, decided_at: Number(r.decided_at) || null, decided_by: r.decided_by || null });
  return { level: levelOf(roomId), levels: LEVELS.map((k) => ({ key: k, ...INFO[k] })),
           pending: rows.filter((r) => r.status === "pending").map(shape), members: rows.filter((r) => r.status === "approved").map(shape) };
}

async function mustManage(actor, roomId) {
  if (!actor || !actor.userId) throw new Refuse(401, "Sign in first.");
  if (!(await rooms.canManage(actor, roomId))) throw new Refuse(403, "Only this pad's owner (and site admins) can change who sees it.");
}

/** The owner sets the level. Approved members are kept when it changes (switching back to Approved restores them). */
async function setLevel(actor, R, level) {
  await init();
  await mustManage(actor, R.id);
  const lv = cleanLevel(level);
  if (!lv) throw new Refuse(400, "Pick Public, Members or Approved.");
  if (rooms.isProfile(R.id)) throw new Refuse(400, "A profile's visibility is set on the profile itself.");
  await runQuery(`INSERT INTO pad_access (room_id, level, updated, updated_by) VALUES (?, ?, ?, ?)
                  ON CONFLICT(room_id) DO UPDATE SET level = excluded.level, updated = excluded.updated, updated_by = excluded.updated_by`,
                 [R.id, lv, NOW(), actor.username || actor.userId]);
  if (lv === DEFAULT) LEVEL.delete(R.id); else LEVEL.set(R.id, lv);
  await rooms.event(R.id, "access", actor.username || "?", `level=${lv}`);
  bump();
  // CL3: the pad chat's watermarks move now - an Approved pad opening up never shows its Approved-era lines to non-members (aud_m)
  try { await require("./chatlogview").reconcileNow(R.id); require("./bridge").refreshRoom(R.id); } catch (e) { console.error("[padaccess] chat watermarks:", e.message); }
  return listFor(R.id);
}

/** Approve / deny a request (an owner may also approve someone they denied or removed earlier). */
async function decide(actor, R, userId, approve) {
  await init();
  await mustManage(actor, R.id);
  const uid = String(userId || "");
  const have = uid ? await row(R.id, uid) : null;
  if (!have) throw new Refuse(404, "No such request.");
  if (approve && have.status === "approved") return listFor(R.id);
  if (!approve && have.status !== "pending") throw new Refuse(409, "Only a waiting request can be denied - use Remove for a member.");
  const st = approve ? "approved" : "denied";
  await runQuery("UPDATE pad_members SET status = ?, decided_at = ?, decided_by = ? WHERE room_id = ? AND user_id = ?",
                 [st, NOW(), actor.username || actor.userId, R.id, uid]);
  if (approve) {
    if (!MEMBERS.has(R.id)) MEMBERS.set(R.id, new Set());
    MEMBERS.get(R.id).add(uid);
    const slug = require("./pads").padSlug(R);
    rooms.notify(uid, { kind: "room", title: `You're in: ${padName(R)}`, body: `${actor.username || "The owner"} approved your request.`,
                        link: "/p/" + encodeURIComponent(slug), ref: `pad-access-ok:${R.id}:${uid}` }).catch(() => {});
  }
  await rooms.event(R.id, "access", actor.username || "?", `${st} ${(await userName(uid)) || uid}`);
  bump();
  return listFor(R.id);
}

/** Take someone's access away (they can ask again after RETRY_MS). */
async function remove(actor, R, userId) {
  await init();
  await mustManage(actor, R.id);
  const uid = String(userId || "");
  const have = uid ? await row(R.id, uid) : null;
  if (!have || have.status !== "approved") throw new Refuse(404, "They aren't an approved member.");
  await runQuery("UPDATE pad_members SET status = 'removed', decided_at = ?, decided_by = ? WHERE room_id = ? AND user_id = ?",
                 [NOW(), actor.username || actor.userId, R.id, uid]);
  const s = MEMBERS.get(R.id);
  if (s) s.delete(uid);
  await rooms.event(R.id, "access", actor.username || "?", `removed ${(await userName(uid)) || uid}`);
  bump();
  return listFor(R.id);
}

// Anything that caches per-pad results (the stage read cache) listens here.
const listeners = new Set();
function onChange(fn) { listeners.add(fn); }
function bump() { ipOk.clear(); for (const fn of listeners) { try { fn(); } catch (e) { /* a listener's problem */ } } }

// ── stage read tokens (webrtc.js) ──
const b64 = (s) => Buffer.from(String(s)).toString("base64url");
const unb64 = (s) => { try { return Buffer.from(String(s), "base64url").toString("utf8"); } catch (e) { return ""; } };
const sign = (body) => crypto.createHmac("sha256", SECRET).update("pad-read:" + body).digest("base64url").slice(0, 32);
/** A read token for `userId` on stream `stream` ("r1.<exp>.<uid b64>.<sig>"). The expiry is rounded to READ_TTL_MS / 2
 *  buckets, so a page that polls the stage gets the SAME URL for hours (the player only reloads on a new URL) and every
 *  token is good for at least READ_TTL_MS. */
function readToken(userId, stream, t = NOW()) {
  const B = READ_TTL_MS / 2;
  const body = "r1." + ((Math.floor(t / B) + 3) * B) + "." + b64(userId);
  return body + "." + sign(body + "|" + stream);
}
/** The user id a token was made for, when it's good for this stream and not expired; else null. */
function checkReadToken(tok, stream, t = NOW()) {
  const m = /^r1\.(\d{10,16})\.([A-Za-z0-9_-]{1,120})\.([A-Za-z0-9_-]{32})$/.exec(String(tok || ""));
  if (!m || Number(m[1]) < t) return null;
  const want = sign("r1." + m[1] + "." + m[2] + "|" + stream);
  const a = Buffer.from(m[3]), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return unb64(m[2]) || null;
}
const STREAM_RE = /\/((?:stg-|stage-)[0-9a-f]{16})(?=[/.?]|$)/;
const addQuery = (url, k, v) => (url ? url + (url.includes("?") ? "&" : "?") + k + "=" + encodeURIComponent(v) : url);
/** A stage's public slots for `viewer`: on an Approved pad (viewer inside) each HLS / WHEP URL carries a read token. */
function tokenizeSlots(slots, viewer, roomId) {
  if (!Array.isArray(slots) || levelOf(roomId) !== "approved" || !inside(viewer, roomId)) return slots;
  return slots.map((s) => {
    const m = STREAM_RE.exec(String(s.hls || s.whep || ""));
    if (!m) return s;
    const tok = readToken(viewer.userId, m[1]);
    const o = { ...s, hls: addQuery(s.hls, "pt", tok) };
    if (s.whep) o.whep = addQuery(s.whep, "pt", tok);
    return o;
  });
}
const ipOk = new Map();         // "<ip>|<stream>" -> until (ms)
const classCache = new Map();   // user id -> {at, u: {userId, class} | null}
async function accountLite(userId) {
  const c = classCache.get(userId);
  if (c && NOW() - c.at < 60e3) return c.u;
  const r = (await getQuery("SELECT userId, class FROM users WHERE userId = ?", [userId]).catch(() => []))[0] || null;
  classCache.set(userId, { at: NOW(), u: r });
  if (classCache.size > 5000) classCache.clear();
  return r;
}
/**
 * The MediaMTX read check for a stream on an Approved pad. b = the auth hook's body ({query, token, ip, ...}).
 * A good read token for a viewer who is still inside -> allowed (and their IP remembered for READ_IP_MS); no token ->
 * allowed only for an IP that showed one for this stream lately (HLS parts / child playlists don't carry the query).
 */
async function readAllowed(b, stream, roomId) {
  b = b || {};
  await init();
  let tok = null;
  try { tok = new URLSearchParams(String(b.query || "").replace(/^\?/, "")).get("pt"); } catch (e) { tok = null; }
  if (!tok && /^r1\./.test(String(b.token || ""))) tok = String(b.token);
  const ipKey = String(b.ip || "") + "|" + stream;
  if (tok) {
    const uid = checkReadToken(tok, stream);
    const u = uid ? await accountLite(uid) : null;
    if (!u || !inside(u, roomId)) return false;
    ipOk.set(ipKey, NOW() + READ_IP_MS);
    if (ipOk.size > 20000) ipOk.clear();
    return true;
  }
  const until = ipOk.get(ipKey);
  return !!until && until > NOW();
}
/** 1.99gk (hlsauth.js): is this signed-in account inside the pad (owner / staff / approved)? Class from a 60 s cache. */
async function userInside(userId, roomId) {
  if (!userId) return false;
  await init();
  const u = await accountLite(String(userId));
  return !!u && inside(u, roomId);
}
/** 1.99il (roomrtc.js): may this account (null = signed out) hear the pad's live room - padaccess.full - right now?
 *  Class from a 60 s cache, like userInside. */
async function fullFor(userId, roomId) {
  await init();
  if (!userId) return full(null, roomId);
  const u = await accountLite(String(userId));
  return full(u || null, roomId);
}
/** adultgate site: the 18+ gate alone for an account id (null = signed out) - class from the same 60 s cache. */
async function adultGateFor(userId, roomId) {
  await init();
  if (!userId) return AG.gate(null, roomId);
  const u = await accountLite(String(userId));
  return AG.gate(u || null, roomId);
}
/** 1.99gk: remember an IP that proved itself another way (a session cookie) for this stream's HLS parts. */
function rememberIp(ip, stream) {
  if (!ip || !stream) return;
  ipOk.set(String(ip) + "|" + stream, NOW() + READ_IP_MS);
  if (ipOk.size > 20000) ipOk.clear();
}

// ── routes ──
// The page gate (/p/<slug>/...) and the API gate (/api/rooms/<slug>/...) keep an Approved pad's own pages and APIs
// away from everyone outside it; the request / settings endpoints live under /api/pads/<slug>/access.
const RESERVED = new Set(["owners", "royalties", "stage", "admin", "front", "action", "boost"]);
function register(app, { addUser }) {
  init().catch(() => {});
  const withUser = (req, res) => new Promise((resolve) => {
    if (req.user !== undefined) return resolve(req.user);
    addUser(req, res, () => resolve(req.user));
  });
  const resolveSlug = async (slug) => {
    try { return await require("./roomsweb").resolveRoom(String(slug || "").slice(0, 128)); } catch (e) { return null; }
  };
  const sameSite = (req) => {
    const host = req.get("host"), src = req.get("origin") || req.get("referer");
    if (!src || !host) return true;
    try { return new URL(src).host === host; } catch (e) { return false; }
  };

  // pages: the pad page itself becomes the locked card; its other pages refuse (a post 404s on its own)
  app.use("/p/:slug", async (req, res, next) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      await init();
      if (!anyApproved()) return next();
      const R = await resolveSlug(req.params.slug);
      if (!R || !isApproved(R.id)) return next();
      res.set("X-Robots-Tag", "noindex");
      res.set("Cache-Control", "private, no-store");
      const sub = req.path && req.path !== "/" ? req.path : "";
      if (/^\/posts\//.test(sub)) return next();                 // the post page decides (404 for outsiders)
      const u = await withUser(req, res);
      if (inside(u, R.id)) return next();
      if (/^\/settings\/?$/.test(sub)) return next();             // padsettings.js: owners + staff only anyway
      if (/^\/owner\/?$/.test(sub)) return next();                // 1.99qr: padowner.js - owners + staff only anyway
      return lockedPage(req, res, R, u);
    } catch (e) { next(e); }
  });
  app.use("/api/rooms/:slug", async (req, res, next) => {
    try {
      if (RESERVED.has(String(req.params.slug || "").toLowerCase())) return next();
      await init();
      if (!anyApproved()) return next();
      const R = await resolveSlug(req.params.slug);
      if (!R || !isApproved(R.id)) return next();
      const u = await withUser(req, res);
      if (inside(u, R.id)) return next();
      res.set("Cache-Control", "no-store");
      return res.status(u && u.userId ? 403 : 401).json({ ok: false, locked: true, error: "This pad is for approved members." });
    } catch (e) { next(e); }
  });
  // adultgate site: the 18+ gate (switch on) for the live-room APIs (adultgate.LIVE_API, matched in any letter case like the
  // routes themselves) - the routes refuse on their own too (full() / adultgate.refuseJson on the room THEY resolved).
  // Off: never in the way.
  app.use("/api/rooms/:slug", async (req, res, next) => {
    try {
      if (RESERVED.has(String(req.params.slug || "").toLowerCase()) || !AG.LIVE_API.test(req.path || "")) return next();
      await init();
      if (!AG.enabled() && !AG.unknown()) return next();          // off: no lookup at all
      const R = await resolveSlug(req.params.slug);
      if (!R || !AG.applies(R.id)) return next();
      const u = await withUser(req, res);
      const g = AG.gate(u, R.id);
      if (g === "ok") return next();
      res.set("Cache-Control", "no-store");
      return res.status(AG.statusOf(g)).json(AG.refusal(g, "/p/" + encodeURIComponent(require("./pads").padSlug(R)), req.t));
    } catch (e) { next(e); }
  });

  async function lockedPage(req, res, R, u) {
    const pads = require("./pads");
    const slug = pads.padSlug(R);
    const st = await state(u, R.id);
    // no title, description, banner or owner: only the address the visitor already has
    res.locals.og = { title: `p/${slug} on PATV`, description: "A members-only pad on Public Access TV.",
                      image: res.locals.ogBase ? res.locals.ogBase + require("./og").pageUrl(("p/" + slug).slice(0, 60)) : "",
                      url: (res.locals.ogBase || "") + "/p/" + encodeURIComponent(slug) };
    res.status(u && u.userId ? 403 : 401).render("padLocked", { user: u ? u.username : null, slug, st, next: "/p/" + encodeURIComponent(slug), noteMax: NOTE_MAX });
  }

  const fail = (res, e) => {
    const st = e && e.status && e.status < 500 ? e.status : 500;
    if (st === 500) console.error("[padaccess]", e);
    res.status(st).json({ ok: false, error: st === 500 ? "Something went wrong." : e.message });
  };
  const write = async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!sameSite(req) || req.get("X-Requested-With") !== "fetch") { res.status(403).json({ ok: false, error: "Bad request." }); return null; }
    if (!req.is("application/json")) { res.status(415).json({ ok: false, error: "JSON only." }); return null; }
    const u = await withUser(req, res);
    if (!u || !u.userId) { res.status(401).json({ ok: false, error: "Sign in first." }); return null; }
    const R = await resolveSlug(req.params.slug);
    if (!R) { res.status(404).json({ ok: false, error: "No such pad." }); return null; }
    return { u, R };
  };
  app.get("/api/pads/:slug/access", async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const u = await withUser(req, res);
      const R = await resolveSlug(req.params.slug);
      if (!R) return res.status(404).json({ ok: false, error: "No such pad." });
      const me = await state(u, R.id);
      const manage = await rooms.canManage(u, R.id);
      res.json({ ok: true, me, ...(manage ? { manage: await listFor(R.id) } : {}) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/pads/:slug/access/request", async (req, res) => {
    try {
      const w = await write(req, res); if (!w) return;
      res.json({ ok: true, me: await request(w.u, w.R, (req.body || {}).note) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/pads/:slug/access/level", async (req, res) => {
    try {
      const w = await write(req, res); if (!w) return;
      res.json({ ok: true, manage: await setLevel(w.u, w.R, (req.body || {}).level) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/pads/:slug/access/decide", async (req, res) => {
    try {
      const w = await write(req, res); if (!w) return;
      const b = req.body || {};
      res.json({ ok: true, manage: await decide(w.u, w.R, b.userId, b.approve === true || b.approve === "1" || b.approve === 1) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/pads/:slug/access/remove", async (req, res) => {
    try {
      const w = await write(req, res); if (!w) return;
      res.json({ ok: true, manage: await remove(w.u, w.R, (req.body || {}).userId) });
    } catch (e) { fail(res, e); }
  });
}

module.exports = {
  init, load, register, LEVELS, DEFAULT, INFO, levelOf, isPublic, isApproved, anyApproved, inside, canSee, full, adultGate, adultSlots, adultGateFor, blockedFor, visibleRows,
  camVisible, camSlotsFor,                  // stagefix site
  state, request, listFor, setLevel, decide, remove, onChange, readToken, checkReadToken, tokenizeSlots, readAllowed, userInside, fullFor, rememberIp, Refuse, NOTE_MAX, RETRY_MS,
  READ_IP_MS, isReady: () => loaded, _setClock: (fn) => { NOW = fn || (() => Date.now()); }, _reset: () => { ready = null; loaded = false; LEVEL = new Map(); MEMBERS = new Map(); ipOk.clear(); classCache.clear(); },
};
// gatefix site: what Pepe's DM / Telegram answers leave out (liveRoomsOutside, gateLiveRooms)
Object.assign(module.exports, { liveRoomsOutside, gateLiveRooms });
