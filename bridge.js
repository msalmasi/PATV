// bridge.js — Camfrog rooms live on PATV, read-only (room bridge v1, bot 1.99).
//
// Pepe streams what a bridged Camfrog room shows to anyone sitting in it — public chat lines, who's
// in the room, who's on the mic, who's on cam, the topic — as PCP-shaped events (the v2 Pepe
// Connector Protocol: message / member.join / member.leave / mic.grab / mic.release / cam.open /
// cam.close / room.joined / room.left / room.update) plus a roster snapshot per room, batched every
// ~1.5s:
//   POST /api/bridge/sync  {password: bot token, v, protocol, connector, session, events[], rooms[], closed[]}
// Rooms are opt-in on Pepe's side (`!bridge on|off`; Pepe's Pad is on by default). Pepe already
// redacts opted-out users (`!incognito`, `!bridge hide`) before anything leaves him, never sends PMs
// and drops slash commands; this side re-validates every field anyway, ignores `message.private`
// outright, and everything is rendered with textContent / EJS escaping.
//
// Kept: per room the latest snapshot + the last FEED_KEEP feed items (chat lines, joins/leaves, mic,
// topic changes), in memory, mirrored to SQLite so a restart doesn't blank the page.
// Pages (signed-in only — a room's chat is semi-private):
//   GET /p                     the Pads (was /rooms; pads.js 301s the old addresses)
//   GET /p/:slug               the pad page, with its Camfrog room live when one backs it
//   GET /api/rooms/:slug/live?after=<cursor>   JSON the page polls (~1.5s)
// Pepe's window room (1.99aj): the Camfrog room Pepe's OBS stream is showing = his active room
// (`!activeroom`). Pepe reports it with the stage state and the site shows it as information only.
// 1.99bi: the website no longer moves it - every room has its own stage (mainstage.js) and the
// homepage's featured room is a site setting (rooms.js front room), decoupled from !activeroom.
const express = require("express");
const { runQuery, getQuery } = require("./dbUtils");
const cosmetics = require("./cosmetics");
const relay = require("./bridge-relay");   // web -> room: chat relay, mic clips, cam snapshots (staging test)
const RA = require("./roomactivity");      // 1.99cj: rolling per-room activity (people only) for the homepage pick

const FEED_KEEP = 200;
const STALE_MS = 90 * 1000;              // no sync for this long -> the room shows as offline
const MAX_EVENTS = 500, MAX_ROOMS = 20, MAX_MEMBERS = 400;
const TRANSCRIPT = "x.pepe.transcript";      // Pepe's mic transcripts (a PCP extension event)
const FEED_TYPES = new Set(["message", TRANSCRIPT, "member.join", "member.leave", "mic.grab", "mic.release", "room.update"]);
const AUDIO_MAX_LISTENERS = 40, AUDIO_IDLE_MS = 30 * 1000, AUDIO_PRIME = 3;

const ready = (async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS bridge_rooms (
    id TEXT PRIMARY KEY, slug TEXT, name TEXT, snap TEXT, updated INTEGER)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS bridge_feed (
    c INTEGER PRIMARY KEY, room_id TEXT NOT NULL, ts INTEGER, data TEXT NOT NULL)`);
  await runQuery("CREATE INDEX IF NOT EXISTS bridge_feed_room ON bridge_feed (room_id, c)");
})().catch((e) => console.error("[bridge] init:", e));

// ── sanitising (Pepe already cleans; this is the second line) ──
const CTRL = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const str = (v, n) => String(v == null ? "" : v).replace(CTRL, " ").replace(/\s+/g, " ").trim().slice(0, n);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:~\-]{0,127}$/;
// a Camfrog display name as plain text: <b><n>lou</n></b> -> lou (Pepe strips it too; 1.99ea)
const plain = (v, n) => str(String(v == null ? "" : v).replace(/<[^>]*>/g, ""), n);
const LOGIN_RE = /^[\w.\-]{1,40}$/;
const slugify = (s) => String(s || "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "room";

function cleanUser(u) {
  if (!u || typeof u !== "object") return null;
  if (u.anonymous) return { anon: true, display: "someone" };
  const login = str(u.login || u.id, 40);
  if (!LOGIN_RE.test(login)) return null;
  const out = { login, display: plain(u.display, 40) || login };
  if (u.is_self) out.self = true;
  if (u.is_bot) out.bot = true;
  if (typeof u.on_cam === "boolean") out.on_cam = u.on_cam;
  if (u.on_mic) out.on_mic = true;
  if (u.src === "list" || u.src === "seen" || u.src === "self") out.src = u.src;
  if (u.unresolved) out.unresolved = true;
  return out;
}

function cleanRoomRef(r) {
  if (!r || typeof r !== "object") return null;
  const id = str(r.id, 128);
  if (!id) return null;
  return { id, name: str(r.name, 60) || id };
}

// ── state ──
const SEEN_EVENTS = new Map();          // recent PCP event ids (dedupe re-sent batches)
const rooms = new Map();                 // room id -> {id, name, slug, topic, members, mic, count, updated, listAt, joinedAt, feed[]}
let cursor = 0;
let loaded = null;

function roomFor(ref) {
  let R = rooms.get(ref.id);
  if (!R) {
    if (rooms.size >= MAX_ROOMS) return null;
    R = { id: ref.id, name: ref.name, slug: "", topic: "", members: [], mic: [], count: 0, updated: 0, listAt: null, joinedAt: null, feed: [] };
    rooms.set(ref.id, R);
  }
  if (ref.name && ref.name !== R.name) R.name = ref.name;
  // slug from the display name; another room already holding it gets the id-based one
  let slug = slugify(R.name);
  for (const o of rooms.values()) if (o !== R && o.slug === slug) slug = slugify(R.id);
  R.slug = slug;
  return R;
}

function load() {
  if (!loaded) {
    loaded = (async () => {
      await ready;
      const rs = await getQuery("SELECT id, name, snap, updated FROM bridge_rooms");
      for (const r of rs) {
        const R = roomFor({ id: r.id, name: r.name });
        if (!R) continue;
        try { Object.assign(R, JSON.parse(r.snap || "{}")); } catch (e) { /* keep the empty room */ }
        R.updated = Number(r.updated) || 0;
        const feed = await getQuery("SELECT c, data FROM bridge_feed WHERE room_id = ? ORDER BY c DESC LIMIT ?", [r.id, FEED_KEEP]);
        R.feed = feed.reverse().map((f) => { try { return Object.assign(JSON.parse(f.data), { c: f.c }); } catch (e) { return null; } }).filter(Boolean);
        replayActivity(R);
      }
      const m = await getQuery("SELECT MAX(c) AS c FROM bridge_feed");
      cursor = Math.max(cursor, Number(m[0] && m[0].c) || 0);
    })().catch((e) => { console.error("[bridge] load:", e); });
  }
  return loaded;
}

async function persistRoom(R) {
  const snap = { topic: R.topic, members: R.members, mic: R.mic, count: R.count, listAt: R.listAt, joinedAt: R.joinedAt,
                 listFresh: R.listFresh, seenTtl: R.seenTtl, listStaleAfter: R.listStaleAfter };
  await runQuery(`INSERT INTO bridge_rooms (id, slug, name, snap, updated) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, name = excluded.name, snap = excluded.snap, updated = excluded.updated`,
    [R.id, R.slug, R.name, JSON.stringify(snap), R.updated]);
}

// 1.99cj: after a restart, the persisted feed refills the activity tally (roomactivity.js)
function replayActivity(R) {
  const since = Date.now() - 90 * 60 * 1000;
  for (const it of R.feed) {
    if (!it || !it.u || !(it.ts > since)) continue;
    if (it.k === "msg") RA.line(R.id, it.u, it.ts);
    else if (it.k === "tx" || it.k === "mic") RA.spoke(R.id, it.u, it.ts);
    else if (it.k === "unmic") RA.micHeld(R.id, it.u, it.ms, it.ts);
  }
}

async function dropRoom(id) {
  rooms.delete(id);
  RA.drop(id);
  await runQuery("DELETE FROM bridge_rooms WHERE id = ?", [id]);
  await runQuery("DELETE FROM bridge_feed WHERE room_id = ?", [id]);
}

/** One PCP event -> a feed item (or null). */
function feedItem(ev) {
  const d = ev.data && typeof ev.data === "object" ? ev.data : {};
  const ts = Date.parse(ev.ts) || Date.now();
  switch (ev.type) {
    case "message": {
      const u = cleanUser(d.user);
      const text = str(d.text, 400);
      if (!u || !text || u.anon) return null;          // Pepe never sends an opted-out user's line; belt and braces
      return { k: "msg", ts, u, text };
    }
    case "member.join": {
      if (d.initial) return null;                        // the burst when Pepe enters the room
      const u = cleanUser(d.user);
      return u ? { k: "join", ts, u } : null;
    }
    case "member.leave": {
      const u = cleanUser(d.user);
      return u ? { k: "leave", ts, u } : null;
    }
    case "mic.grab": {
      const u = cleanUser(d.user);
      return u ? { k: "mic", ts, u } : null;
    }
    case "mic.release": {
      const u = cleanUser(d.user);
      return u ? { k: "unmic", ts, u, ms: Math.max(0, Math.min(864e5, Number(d.held_ms) || 0)) } : null;
    }
    case TRANSCRIPT: {
      const u = cleanUser(d.user);
      const text = str(d.text, 400);
      if (!u || !text || u.anon) return null;
      const id = /^tx-[0-9a-f]{8,32}$/.test(String(d.id || "")) ? String(d.id) : null;
      return id ? { k: "tx", ts, u, text, id } : { k: "tx", ts, u, text };
    }
    case "room.update": {
      const t = d.changes && typeof d.changes === "object" ? str(d.changes.topic, 200) : "";
      return t ? { k: "topic", ts, text: t } : null;
    }
    default:
      return null;
  }
}

// ── the main stage (OBS on air?), reported by Pepe every ~30s ──
let STAGE = { active: false, unknown: true, at: 0, room: null, roomName: "", pinned: false, rooms: [] };
const STAGE_ROOM_FRESH = 10 * 60 * 1000;     // Pepe silent this long -> the stage room is unknown
// ON AIR means the stream is actually playable: the HLS playlist on this server is being rewritten
// (nginx-rtmp updates it every few seconds while a stream comes in). Where there's no HLS directory
// (a dev box) Pepe's OBS state is used instead.
const fs = require("fs");
const pathMod = require("path");
const HLS_PLAYLIST = process.env.HLS_PLAYLIST_PATH || "/mnt/hls/broadcast.m3u8";
let HLS = { live: null, since: null, ended: null };
function hlsCheck() {
  fs.stat(HLS_PLAYLIST, (err, st) => {
    let live;
    if (err) live = fs.existsSync(pathMod.dirname(HLS_PLAYLIST)) ? false : null;
    else live = Date.now() - st.mtimeMs < 20 * 1000;
    if (live && !HLS.live) HLS.since = Date.now();
    if (live === false && HLS.live) HLS.ended = Date.now();
    HLS.live = live;
  });
}
hlsCheck();
setInterval(hlsCheck, 5000).unref();
/** The stage room as the site shows it: {name, slug (null when that room isn't bridged), pinned} or null. */
function stageRoom() {
  if (!STAGE.room || Date.now() - STAGE.at > STAGE_ROOM_FRESH) return null;
  const R = rooms.get(STAGE.room);
  return { name: (R && R.name) || STAGE.roomName || STAGE.room, slug: R ? R.slug : null, pinned: !!STAGE.pinned };
}
/** Admin-only extras: the rooms Pepe is in (what the stage can move to) and the current room id. */
/** {id} of Pepe's window room when it's known - admin / information only (1.99cj: the homepage's
 *  front room no longer reads it). */
function stageRoomRef() {
  if (!STAGE.room || Date.now() - STAGE.at > STAGE_ROOM_FRESH) return null;
  return { id: STAGE.room };
}
/** 1.99cj: is Pepe IN this room (so his stage - his broadcast - belongs on its stage)? true when the
 *  room is in the list of rooms Pepe reports being in, or he's bridging it live right now; false when
 *  we know where he is and it isn't here; null when we don't know (Pepe silent: no fresh report and
 *  no live bridged room) - callers then show his stream as before rather than hide it on a guess.
 *  This is about PRESENCE, never about which room his Camfrog window shows (`!activeroom`). */
function pepeIn(roomId) {
  const id = String(roomId || "");
  const fresh = Date.now() - STAGE.at < STAGE_ROOM_FRESH;
  if (fresh && (STAGE.rooms || []).some((r) => r.id === id)) return true;
  if (fresh && STAGE.room === id) return true;
  const R = rooms.get(id);
  if (R && isLive(R)) return true;
  const anyLive = [...rooms.values()].some(isLive);
  if ((fresh && (STAGE.rooms || []).length) || anyLive) return false;
  return null;
}
/** 1.99cw: the Camfrog room's !snap switch as Pepe last reported it: true / false, or null when we don't
 *  know (Pepe isn't in that room, isn't reporting, or is an older build). Stage snaps / clips
 *  (stagecap.js) follow it; unknown counts as OFF there, like the switch's own default. */
function snapSwitch(roomId) {
  const id = String(roomId || "");
  if (Date.now() - STAGE.at < STAGE_ROOM_FRESH) {
    const r = (STAGE.rooms || []).find((x) => x.id === id);
    if (r && typeof r.snap === "boolean") return r.snap;
  }
  const R = rooms.get(id);
  if (R && isLive(R) && typeof R.snapOn === "boolean") return R.snapOn;
  return null;
}
/** 1.99fa: the Camfrog room's !clip switch as Pepe last reported it: true / false, or null when unknown (same
 *  sources as snapSwitch). Website cam clips (camclip.js) follow it; unknown counts as OFF, like !snap. */
function clipSwitch(roomId) {
  const id = String(roomId || "");
  if (Date.now() - STAGE.at < STAGE_ROOM_FRESH) {
    const r = (STAGE.rooms || []).find((x) => x.id === id);
    if (r && typeof r.clip === "boolean") return r.clip;
  }
  const R = rooms.get(id);
  if (R && isLive(R) && typeof R.clipOn === "boolean") return R.clipOn;
  return null;
}
function stageAdmin() {
  const fresh = Date.now() - STAGE.at < STAGE_ROOM_FRESH;
  return { room: fresh ? STAGE.room : null, pinned: !!STAGE.pinned, rooms: fresh ? STAGE.rooms : [] };
}
/** 1.99fd: Pepe's WHEP URL while his main stream comes in over WHIP (webrtc.js), else null. */
function pepeWhep() {
  try { return require("./webrtc").pepeWhep(); } catch (e) { return null; }
}
/** 1.99fv: what Pepe's stage plays (mainstage.pepeSource: his stream, or an admin-chosen YouTube / Twitch embed). */
function pepeSrc() {
  try { return require("./mainstage").pepeSource(); } catch (e) { return { mode: "stream" }; }
}
function stage() {
  const fresh = Date.now() - STAGE.at < 120 * 1000;
  const room = stageRoom();
  // active / since come from Pepe's OWN stream only (HLS, else OBS) - never from Twitch; pepe_src is display only
  if (HLS.live !== null) {
    // 1.99fd: whep = the ⚡ Low latency toggle on Pepe's stage (only while his HLS is on air too)
    const whep = HLS.live ? pepeWhep() : null;
    return { active: HLS.live, since: HLS.live ? HLS.since : null, ended: HLS.ended || STAGE.ended || null, known: true, source: "hls", room,
             ...(whep ? { whep } : {}), pepe_src: pepeSrc() };
  }
  return { active: fresh && !!STAGE.active, since: STAGE.since || null, ended: STAGE.ended || null, known: fresh && !STAGE.unknown, source: "obs", room,
           pepe_src: pepeSrc() };
}

// ── room audio relay: Pepe POSTs ~1s MP3 chunks, we pass them to signed-in listeners. Nothing kept. ──
const audio = new Map();                 // room id -> {listeners:Set(res), recent:[Buffer], at}
function audioHub(id) {
  let a = audio.get(id);
  if (!a) { a = { listeners: new Set(), recent: [], at: 0 }; audio.set(id, a); }
  return a;
}
function audioClose(id) {
  const a = audio.get(id);
  if (!a) return;
  for (const res of a.listeners) { try { res.end(); } catch (e) { /* gone */ } }
  audio.delete(id);
}
setInterval(() => {
  for (const [id, a] of audio) if (a.listeners.size && Date.now() - a.at > AUDIO_IDLE_MS && a.at) audioClose(id);
}, 10 * 1000).unref();

let lastFrontTick = 0;
async function ingest(body) {
  await load();
  const now = Date.now();
  if (body.stage && typeof body.stage === "object") {
    const g = body.stage, n = (v) => (Number(v) > 0 ? Number(v) * 1000 : null);
    const rid = (v) => (typeof v === "string" && str(v, 128) ? str(v, 128) : null);   // same shape as cleanRoomRef's id
    const roomList = (Array.isArray(g.rooms) ? g.rooms : []).slice(0, MAX_ROOMS)
      .map((r) => (r && rid(r.id) ? { id: rid(r.id), name: str(r.name, 100) || rid(r.id),
                                      ...(typeof r.snap === "boolean" ? { snap: r.snap } : {}),     // 1.99cw: the room's !snap switch
                                      ...(typeof r.clip === "boolean" ? { clip: r.clip } : {}) } : null)).filter(Boolean);   // 1.99fa: its !clip switch
    STAGE = { active: !!g.active, unknown: !!g.unknown, since: n(g.since), ended: n(g.ended), at: now,
              room: rid(g.room), roomName: str(g.room_name, 100), pinned: !!g.pinned, rooms: roomList };
  }
  const touched = new Set();
  const lines = new Map();                 // room id -> new chat lines this batch (room activity)
  for (const id of (Array.isArray(body.closed) ? body.closed : []).slice(0, MAX_ROOMS)) {
    if (typeof id === "string" && rooms.has(id)) await dropRoom(id);
  }
  for (const s of (Array.isArray(body.rooms) ? body.rooms : []).slice(0, MAX_ROOMS)) {
    const ref = cleanRoomRef(s && s.room);
    if (!ref) continue;
    const R = roomFor(ref);
    if (!R) continue;
    R.topic = str(s.topic, 200);
    R.members = (Array.isArray(s.members) ? s.members : []).slice(0, MAX_MEMBERS).map(cleanUser).filter(Boolean);
    R.mic = (Array.isArray(s.mic) ? s.mic : []).slice(0, 20).map(cleanUser).filter(Boolean);
    R.count = Math.max(R.members.length, Math.min(5000, Number(s.count) || 0));
    R.listAt = Number(s.list_at) ? Number(s.list_at) * 1000 : null;
    // how much the roster can be trusted: a fresh participant-list read, or (stale / never read)
    // only people seen arriving / talking / on the mic within seenTtl - Pepe prunes the rest
    R.listFresh = typeof s.list_fresh === "boolean" ? s.list_fresh : null;
    R.seenTtl = Number(s.seen_ttl) > 0 ? Math.min(6 * 3600, Number(s.seen_ttl)) * 1000 : null;
    R.listStaleAfter = Number(s.list_stale_after) > 0 ? Math.min(6 * 3600, Number(s.list_stale_after)) * 1000 : null;
    R.joinedAt = Number(s.joined_at) ? Number(s.joined_at) * 1000 : null;
    R.transcripts = s.transcripts !== false;
    R.audio = !!s.audio;
    R.relay = !!s.relay;
    R.micRelay = !!s.mic_relay;
    R.cams = !!s.cams;
    R.snapOn = typeof s.snap === "boolean" ? s.snap : null;   // 1.99cw: the room's !snap switch (null = an older Pepe)
    R.clipOn = typeof s.clip === "boolean" ? s.clip : null;   // 1.99fa: the room's !clip switch (null = an older Pepe)
    R.cmds = relay.cleanCmds(s.cmds);          // chat commands from the relay: {"!topic": price} ({} = off)
    R.mod = require("./padmod").cleanModCaps(s.mod);   // 1.99co: Manage-panel caps per watching mod login ({} = none)
    if (!R.audio) audioClose(R.id);
    RA.micSample(R.id, R.mic, now);
    R.updated = now;
    touched.add(R);
  }
  const newItems = [];
  for (const ev of (Array.isArray(body.events) ? body.events : []).slice(0, MAX_EVENTS)) {
    if (!ev || typeof ev !== "object" || ev.op !== "event" || ev.type === "message.private") continue;
    // at-least-once delivery: a batch Pepe re-sends after a slow response must not double the feed
    const evId = typeof ev.id === "string" ? ev.id.slice(0, 128) : "";
    if (evId) {
      if (SEEN_EVENTS.has(evId)) continue;
      SEEN_EVENTS.set(evId, now);
      if (SEEN_EVENTS.size > 5000) SEEN_EVENTS.delete(SEEN_EVENTS.keys().next().value);
    }
    const ref = cleanRoomRef(ev.scope && ev.scope.room);
    if (!ref) continue;
    if (ev.type === "room.left") { if (rooms.has(ref.id)) { audioClose(ref.id); await dropRoom(ref.id); } continue; }
    const R = roomFor(ref);
    if (!R) continue;
    R.updated = now;
    touched.add(R);
    if (ev.type === "room.update" && ev.data && ev.data.changes && typeof ev.data.changes.topic === "string") R.topic = str(ev.data.changes.topic, 200);
    if (!FEED_TYPES.has(ev.type)) continue;
    const it = feedItem(ev);
    if (!it) continue;
    if (it.k === "tx" && it.id && R.feed.some((x) => x.k === "tx" && x.id === it.id)) continue;   // one line per mic-up
    it.c = ++cursor;
    if (it.k === "msg" || it.k === "tx") lines.set(R.id, (lines.get(R.id) || 0) + 1);
    if (it.k === "msg") RA.line(R.id, it.u, now);
    else if (it.k === "tx" || it.k === "mic") RA.spoke(R.id, it.u, now);
    R.feed.push(it);
    if (R.feed.length > FEED_KEEP) R.feed.splice(0, R.feed.length - FEED_KEEP);
    newItems.push([R.id, it]);
  }
  for (const [rid, it] of newItems) {
    const { c, ...rest } = it;
    await runQuery("INSERT INTO bridge_feed (c, room_id, ts, data) VALUES (?, ?, ?, ?)", [c, rid, it.ts, JSON.stringify(rest)]);
  }
  for (const R of touched) {
    if (rooms.get(R.id) !== R) continue;
    await persistRoom(R);
    if (R.feed.length >= FEED_KEEP && R.feed[0]) await runQuery("DELETE FROM bridge_feed WHERE room_id = ? AND c < ?", [R.id, R.feed[0].c]);
  }
  // 1.99bi: every bridged room gets a registry row (rooms.js), and its activity feeds the royalty thresholds
  try {
    const reg = require("./rooms");
    for (const R of touched) {
      if (rooms.get(R.id) !== R) continue;
      await reg.noteBridged(R.id, R.name);
      await reg.noteActivity(R.id, R.count, lines.get(R.id) || 0, now);
    }
  } catch (e) { console.error("[bridge] rooms:", e.message); }
  // 1.99cj: the homepage's automatic room pick is evaluated on Pepe's syncs too (not only when someone
  // loads the homepage), so its "N checks in a row" rule runs on a steady clock. Never blocks the sync.
  if (now - lastFrontTick >= 60 * 1000) {
    lastFrontTick = now;
    summary(false).then((s) => require("./rooms").frontRoom(s)).catch((e) => console.error("[bridge] front room:", e.message));
  }
  return { rooms: touched.size, items: newItems.length };
}

// ── names: PATV display name > Camfrog display name > login (1.99ea) ──
// Every bridge line / roster entry is resolved BY LOGIN (never by a display name - those are display
// only and anyone can pick one) against users.camfrogUsername ONLY (1.99eb: UL.lookup linkedOnly - no
// users.username fallback, so a Camfrog login that merely equals someone's PATV username never shows as
// them), case-insensitive; a real account beats a random "CF..." auto one; archived accounts never match.
// The result per login (hit or miss) is cached NAME_TTL, so the ~1.5 s polls cost a query only for
// logins not seen in the last minute. Anonymised people ("someone", !incognito / !bridge hide) carry
// no login and are never looked up.
const UL = require("./userlinks");
const NAME_TTL = 60 * 1000, NAME_MAX = 5000;
const nameCache = new Map();            // login key -> {acc: {username, display, avatar} | null, at}
async function resolveNames(users) {
  const now = Date.now(), miss = new Set();
  for (const u of users) {
    if (!u || u.anon || !u.login) continue;
    const k = UL.keyOf(u.login);
    if (!k) continue;
    const c = nameCache.get(k);
    if (!c || now - c.at > NAME_TTL) miss.add(k);
  }
  const keys = [...miss];
  for (let i = 0; i < keys.length; i += 400) {
    const part = keys.slice(i, i + 400);
    let found;
    try { found = await UL.lookup(part, { linkedOnly: true }); } catch (e) { console.error("[bridge] names:", e.message); break; }
    for (const k of part) { nameCache.delete(k); nameCache.set(k, { acc: found.get(k) || null, at: now }); }
  }
  while (nameCache.size > NAME_MAX) nameCache.delete(nameCache.keys().next().value);
  return nameCache;
}
const safeImg = (u) => (typeof u === "string" && (/^https:\/\/[^\s"'<>]+$/.test(u) || /^\/[A-Za-z0-9/_.\-]+$/.test(u)) ? u : null);

/** A bridge user as the page shows it: `display` = the PATV display name when the login has a live
 *  account (+ `patv` for the profile link / avatar / name colour), else the Camfrog display name,
 *  else the login. `login` stays (the tooltip); `cf` = the Camfrog display name when it isn't the
 *  login. Pepe himself keeps the name Pepe gave. Anonymised users pass through untouched. */
function withPatv(u, C) {
  if (!u || u.anon) return u;
  const login = String(u.login || "");
  const cfName = plain(u.display, 40);
  const out = { ...u, display: cfName || login };
  if (cfName && cfName.toLowerCase() !== login.toLowerCase()) out.cf = cfName;
  const hit = C && C.get(UL.keyOf(login));
  const acc = hit && hit.acc;
  if (!acc) return out;
  out.patv = { username: acc.username, avatar: safeImg(acc.avatar), style: cosmetics.nameStyle(acc.username) || "" };
  if (!u.self) out.display = str(acc.display, 40) || out.display;
  return out;
}

const isLive = (R) => Date.now() - R.updated < STALE_MS;
// 1.99bi: the room's PATV title (owner-editable, rooms.js) when it has one, else what Pepe calls it
const titleOf = (R) => { try { const r = require("./rooms").getCached(R.id); return (r && r.title) || R.name; } catch (e) { return R.name; } };

/** For the homepage / room list. `full` (signed-in) adds who's on the mic. 1.99fu: a Public pad's row always has them. */
async function summary(full) {
  await load();
  const PA = require("./padaccess");
  const open = (R) => full || PA.isPublic(R.id);
  const C = await resolveNames([...rooms.values()].filter(open).flatMap((R) => R.mic));   // 1.99ea: names on the mic
  return [...rooms.values()].sort((a, b) => b.count - a.count).map((R) => ({
    id: R.id, slug: R.slug, name: titleOf(R), count: R.count, live: isLive(R), micCount: R.mic.length, audio: !!R.audio && isLive(R),
    people: RA.people(R.count, R.members),
    mic: open(R) ? R.mic.map((u) => (u.anon ? "someone" : withPatv(u, C).display)) : [],
    topic: open(R) ? R.topic : "",
  }));
}

// ── 1.99fu: 💸 Tip from the pad's user lists ("In the Camfrog room" / "On the mic" ⋯ menus, public/js/room-mod.js) ──
// Server-side, per signed-in viewer, each roster entry gets `tip`: {to, href} = tip their linked PATV account through the
// site's own tip page (/u/<username>/tip: the same presets, confirm step, routing and idempotency as every web tip);
// {off: "..."} = shown greyed out (the site has no pending / held tips, so an unlinked Camfrog login can't be tipped);
// absent = no Tip at all: anonymised people, Pepe (the bridge's self, or his PATV account), other bots, and yourself.
const TIP_UNLINKED = "not linked to PATV yet";
let pepeName = { v: null, at: 0 };
async function pepeUsername() {
  if (Date.now() - pepeName.at < 10 * 60e3) return pepeName.v;
  let v = null;
  try { const r = (await getQuery("SELECT username FROM users WHERE userId = ?", [require("./feedstore").PEPE_ID]))[0]; v = r && r.username ? String(r.username).toLowerCase() : null; }
  catch (e) { v = pepeName.v; }
  pepeName = { v, at: Date.now() };
  return v;
}
/** The Tip item for roster entry `u` (already withPatv'd) as viewer `me` ({userId, username, login}) sees it - null = none. */
function tipFor(u, me, pepe = null) {
  if (!me || !me.userId || !u || u.anon || u.self || u.bot || !u.login) return null;
  const lc = (s) => String(s || "").toLowerCase();
  if (me.login && lc(u.login) === lc(me.login)) return null;                       // yourself (your Camfrog login)
  if (!u.patv || !u.patv.username) return { off: TIP_UNLINKED };
  const name = String(u.patv.username);
  if (me.username && lc(name) === lc(me.username)) return null;                      // yourself (your PATV account)
  if (pepe && lc(name) === pepe) return null;                                       // Pepe's PATV account
  return { to: name, href: "/u/" + encodeURIComponent(name) + "/tip" };
}

async function liveView(R, after, userId, login, username = null) {
  const items = R.feed.filter((it) => it.c > after).slice(-FEED_KEEP);
  const L = await resolveNames([...items.map((it) => it.u), ...R.members, ...R.mic]);
  const feed = items.map((it) => (it.u ? { ...it, u: withPatv(it.u, L) } : it));
  // 1.99fu: 💸 Tip (signed-in viewers only)
  const me = userId ? { userId, username, login } : null;
  const pepe = me ? await pepeUsername() : null;
  const withTip = (u) => { const x = withPatv(u, L); const t = tipFor(x, me, pepe); return t ? { ...x, tip: t } : x; };
  return {
    room: { name: R.name, slug: R.slug, topic: R.topic, count: R.count, live: isLive(R), updated: R.updated, listAt: R.listAt,
            listFresh: R.listFresh == null ? null : R.listFresh, seenTtl: R.seenTtl || null, listStaleAfter: R.listStaleAfter || null,
            transcripts: R.transcripts !== false, audio: !!R.audio && isLive(R),
            relay: !!R.relay && isLive(R), micRelay: !!R.micRelay && isLive(R), cams: !!R.cams && isLive(R),
            clip: clipSwitch(R.id),       // 1.99fp: the room's !clip switch (true / false / null = unknown) - 🔊 Clip on 🎙 lines
            cmds: R.relay && isLive(R) && R.cmds && Object.keys(R.cmds).length ? R.cmds : null },
    mine: userId ? relay.mineFor(userId, R.id) : [],
    // 1.99co: the Manage panel - only when Pepe says this viewer's linked login has mod powers here
    mod: login && isLive(R) ? require("./padmod").viewMod(R, login) : null,
    members: R.members.map(withTip),
    mic: R.mic.map(withTip),
    feed, cursor,
  };
}

/** The live view of the busiest live room, for the homepage (signed-in callers only). */
async function liveFor(slug) {
  await load();
  const R = bySlug(slug);
  return R ? liveView(R, 0) : null;
}

function bySlug(slug) {
  const s = String(slug || "").toLowerCase();
  for (const R of rooms.values()) if (R.slug === s || slugify(R.id) === s) return R;
  return null;
}

function register(app, { isBotToken, addUser }) {
  require("./userlinks").install(app);   // 1.99dt: <%- ul(name) %> in its views links names to profiles
  load();
  app.post("/api/bridge/sync", express.json({ limit: "1mb" }), async (req, res) => {
    const body = req.body || {};
    if (!isBotToken(body.password)) return res.status(403).json({ success: false, error: "unauthorized" });
    try {
      relay.applyAcks(body.acks);
      require("./quotes").setHidden(body.hidden_h);   // 1.99fp: who is private right now (hashes) - quotes never name them
      const r = await ingest(body);
      const liveIds = new Set([...rooms.values()].filter(isLive).map((R) => R.id));
      // 1.99co: the linked logins watching each pad -> Pepe sends their Manage-panel caps (padmod.js)
      res.json({ success: true, ...r, jobs: relay.takeJobs(liveIds), viewers: require("./padmod").viewersFor(liveIds) });
    } catch (e) {
      console.error("[bridge] sync:", e);
      res.status(500).json({ success: false, error: "sync failed" });
    }
  });

  // Pepe's room audio: {password, room, seq, data: base64 MP3 ("" = heartbeat)} -> {listeners}
  app.post("/api/bridge/audio", express.json({ limit: "512kb" }), async (req, res) => {
    const body = req.body || {};
    if (!isBotToken(body.password)) return res.status(403).json({ success: false, error: "unauthorized" });
    await load();
    const R = rooms.get(String(body.room || ""));
    if (!R || !R.audio) return res.json({ success: true, listeners: 0 });
    const a = audioHub(R.id);
    const buf = typeof body.data === "string" && body.data ? Buffer.from(body.data, "base64") : null;
    if (buf && buf.length) {
      a.at = Date.now();
      a.recent.push(buf);
      if (a.recent.length > AUDIO_PRIME) a.recent.shift();
      for (const l of a.listeners) { try { l.write(buf); } catch (e) { a.listeners.delete(l); } }
    }
    res.json({ success: true, listeners: a.listeners.size });
  });

  app.get("/p/:slug/audio", addUser, async (req, res) => {
    await load();
    const R = bySlug(req.params.slug);
    // 1.99fu: the room's audio is members-tier (padaccess.full): signed in, or anyone on a Public pad, inside an Approved one
    if (R && !require("./padaccess").full(req.user, R.id)) return res.status(req.user && req.user.userId ? 403 : 401).send("Sign in to listen.");
    if (!R && (!req.user || !req.user.userId)) return res.status(401).send("Sign in to listen.");
    if (!R || !R.audio || !isLive(R)) return res.status(404).send("This room's audio isn't on.");
    const a = audioHub(R.id);
    if (a.listeners.size >= AUDIO_MAX_LISTENERS) return res.status(503).send("Too many listeners right now.");
    res.status(200).set({ "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "X-Accel-Buffering": "no", Connection: "keep-alive" });
    res.flushHeaders();
    for (const b of a.recent) res.write(b);
    a.listeners.add(res);
    req.on("close", () => { a.listeners.delete(res); });
  });

  app.get("/api/rooms/:slug/live", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    await load();
    const R = bySlug(req.params.slug);
    // 1.99fu: the live room is members-tier (padaccess.full): signed in; anyone on a Public pad; inside an Approved one
    const signed = !!(req.user && req.user.userId);
    if (!R) return signed ? res.status(404).json({ error: "No such room." }) : res.status(401).json({ error: "Sign in to watch the room." });
    if (!require("./padaccess").full(req.user, R.id)) return res.status(signed ? 403 : 401).json({ error: signed ? "This pad is for approved members." : "Sign in to watch the room." });
    const after = Math.max(0, Number(req.query.after) || 0);
    const pm = require("./padmod");
    const login = signed ? await pm.linkedLogin(req.user.userId) : null;
    if (login) pm.noteViewer(R.id, login);
    res.json(await liveView(R, after > cursor ? 0 : after, signed ? req.user.userId : null, login, signed ? req.user.username : null));
  });

  relay.register(app, { isBotToken, addUser, bySlug, isLive });
  require("./camclip").register(app, { isBotToken, addUser, bySlug, isLive });   // 1.99ez: 🎬 cam clips from the snapshot popover
  require("./quotes").register(app, { isBotToken, addUser, bySlug });            // 1.99fp: ✂️ chat quotes (web + Pepe's !quote)
  require("./micclip").register(app, { isBotToken, addUser, bySlug, isLive });   // 1.99fp: 🔊 mic clips (web + Pepe's !clipmic)
  require("./padmod").register(app, { addUser, bySlug, isLive });     // 1.99co: the pad Manage panel

  // The stage of one room (?room=<slug>), else the homepage's front room: Pepe's stream state + that
  // room's live user slots (mainstage.js). Old clients that send no room get the front room.
  app.get("/api/stage", async (req, res) => {
    res.set("Cache-Control", "no-store");
    let slots = [], front = null, roomId = null;
    try {
      const reg = require("./rooms");
      const web = require("./roomsweb");
      const PA = require("./padaccess");
      await PA.init();
      // 1.99fu: who's asking only matters while some pad is Approved (this is polled - no sign-in read otherwise)
      if (PA.anyApproved() && req.user === undefined) await new Promise((r) => addUser(req, res, r));
      let R = req.query.room ? await web.resolveRoom(String(req.query.room)) : null;
      // 1.99fu: an Approved pad's stage is for the people inside it
      if (R && !PA.canSee(req.user, R.id)) return res.status(req.user && req.user.userId ? 403 : 401).json({ ok: false, locked: true, error: "This pad is for approved members." });
      if (!R) {
        const f = await reg.frontRoom(await summary(false), { viewer: req.user || null });
        R = f && f.id ? await reg.get(f.id) : null;
        if (R && !PA.canSee(req.user, R.id)) R = null;
        if (R) front = { id: R.id, slug: web.linkSlug(R), title: R.title, pinned: f.pinned };
      }
      // 1.99fu: on an Approved pad the HLS / WHEP URLs carry this viewer's read token (webrtc.js checks it)
      if (R) { roomId = R.id; slots = PA.tokenizeSlots(await require("./mainstage").publicSlots(R.id), req.user, R.id); }
    } catch (e) { slots = []; }
    // pepe_here: Pepe's stage (his broadcast) belongs to every room he's IN - not just his window room
    const here = roomId ? pepeIn(roomId) : null;
    res.json({ ...stage(), slots, front, pepe_here: here !== false });
  });

  // 1.99bi: the guide - every room, what's on its stage now and what's booked next. 1.99ck: the Pads at /p
  app.get("/p", addUser, async (req, res) => {
    const signedIn = !!(req.user && req.user.userId);
    const reg = require("./rooms");
    const g = await require("./roomsweb").guideRows(signedIn, req.user);
    res.locals.og = { title: "Pads — Public Access TV", description: "Every PATV pad: its feed, what's on its stage now and what's on next, and its Camfrog room live on the web.",
                      image: res.locals.ogBase + "/og/page.png?t=Pad%20Guide", url: res.locals.ogBase + "/p" };
    let owned = [];
    if (signedIn) { try { owned = await reg.ownedBy(req.user.userId); } catch (e) { owned = []; } }
    // 1.99x: ?platform=camfrog|site (|twitch|discord) narrows the list; the counts are for the filter chips
    const counts = {};
    for (const r of g.rows) counts[r.platform] = (counts[r.platform] || 0) + 1;
    const want = String((req.query && req.query.platform) || "").toLowerCase();
    const platform = reg.PLATFORMS.includes(want) ? want : "";
    const rows = platform ? g.rows.filter((r) => r.platform === platform) : g.rows;
    res.render("rooms", { padBadge: require("./pads").padBadge, boostMark: require("./boostmark").boostMark, PAD_PLATFORMS: require("./pads").PLATFORM_INFO, user: req.user ? req.user.username : null, rows, allCount: g.rows.length, counts, platform, pepe: g.pepe, signedIn, staff: reg.isStaff(req.user), owned });
  });

  // 1.99ck: the pad page /p/<slug> - one page per pad (was /rooms/<slug> + /feed/c/<slug>): its header
  // (follow, owner, p/<slug>), the stage + schedule, the live Camfrog room when one backs it (chat, people,
  // mic, DJ booth) and the pad's feed. Any of a pad's slugs works; a room id redirects to the slug.
  app.get("/p/:slug", addUser, async (req, res) => {
    await load();
    const signedIn = !!(req.user && req.user.userId);
    const reg = require("./rooms");
    const pads = require("./pads");
    const raw = String(req.params.slug || "").slice(0, 128);
    let R = bySlug(raw);
    let info = R ? await reg.get(R.id) : await require("./roomsweb").resolveRoom(raw);
    if (!R && !info) {
      // an old /feed/c/<room id> or /feed?room=<room id>: the registry id itself -> its pad address
      const byId = await reg.get(raw);
      if (byId) return res.redirect(301, pads.padHref(byId) + pads.qsOf(req));
    }
    if (!R && info) {
      // a registered pad Pepe isn't bridging right now (or a site-only pad): its page, stage and feed still work
      R = rooms.get(info.id) || { id: info.id, name: info.title, slug: info.slug, topic: "", members: [], mic: [], count: 0, updated: 0, feed: [], offline: true };
    }
    if (!R) {
      return res.status(404).render("notFound", { user: req.user ? req.user.username : null, heading: "No such pad",
        message: "There's no pad at p/" + raw.toLowerCase() + ".", title: "Pad not found" });
    }
    let linked = false, login = null;
    if (signedIn) {
      try { login = ((await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [req.user.userId]))[0] || {}).camfrogUsername || null; } catch (e) { login = null; }
      linked = !!login;
      if (login && !R.offline) require("./padmod").noteViewer(R.id, login);
    }
    const platform = (info && info.platform) || reg.platformOf(R.id);    // 1.99x: camfrog | site | twitch | discord
    const siteOnly = platform !== "camfrog";
    const slug = info ? pads.padSlug(info) : R.slug;
    const title = (info && info.title) || R.name;
    res.locals.og = { title: `p/${slug} — ${title} on PATV`, description: (info && info.description) || `${title}: a pad on Public Access TV.`,
                      image: res.locals.ogBase + "/og/page.png?t=" + encodeURIComponent(("p/" + slug).slice(0, 60)), url: res.locals.ogBase + "/p/" + encodeURIComponent(slug) };
    const manage = await reg.canManage(req.user, R.id);
    // 1.99fu: who can see this pad (padaccess.js). The page gate already turned anyone outside an Approved pad away;
    // liveOpen = the members-tier content (the live room, its topic, story pictures, analytics): signed in, or anyone
    // on a Public pad
    const PA = require("./padaccess");
    await PA.init();
    const liveOpen = PA.full(req.user, R.id);
    const access = { level: PA.levelOf(R.id), info: PA.INFO[PA.levelOf(R.id)] };
    if (access.level === "approved") res.set({ "X-Robots-Tag": "noindex", "Cache-Control": "private, no-store" });
    // the feed's sort / window / page: ?sort= &t= &p= (the feed's own names, so /feed links and old
    // /feed/c/<slug>?sort=... addresses carry over) or the older ?fsort= &ft= &fp=
    const q = req.query || {};
    const fq = { fsort: q.fsort || q.sort, ft: q.ft || q.t, fp: q.fp || q.p, view: q.view };      // 1.99fn: ?view=list|gallery (feedgallery.js)
    // 1.99dx: the pad page's tabs (Live/Stage · Feed · About, public/js/pad-tabs.js) - which one opens first
    const initial = liveOpen && !R.offline ? await liveView(R, 0, signedIn ? req.user.userId : null, login, signedIn ? req.user.username : null) : null;
    const roomStage = await require("./mainstage").roomStage(R.id, req.user);
    const feed = await require("./feedweb").roomFeed(R.id, req.user, fq).catch((e) => { console.error("[feed] room feed:", e.message); return null; });
    const here = pepeIn(R.id), st = stage();
    const latest = feed ? await padLatest(R.id, req.user, feed) : [];
    // 1.99ex: the Feed tab's seen state is per account for members (feedseen.js); signed out it stays in localStorage
    let feedSeen;
    if (feed && req.user && req.user.userId) {
      try { feedSeen = { scope: require("./feedseen").padScope(R.id), upto: await require("./feedseen").one(req.user.userId, require("./feedseen").padScope(R.id)) }; }
      catch (e) { feedSeen = undefined; }
    }
    const padTabs = padTabsFor({ platform, live: !R.offline && isLive(R), count: R.count, members: initial ? initial.members : null,
      pepeHere: here, pepeOn: !!st.active, slots: roomStage && roomStage.slots, feed: !!feed, query: req.originalUrl || req.url || "", latest });
    res.render("room", {
      user: req.user ? req.user.username : null, signedIn, linked, liveOpen, access,
      room: { id: R.id, name: title, slug, count: R.count, live: !R.offline && isLive(R), topic: liveOpen ? R.topic : "",
              bridged: !R.offline, siteOnly, platform, description: info ? info.description : "", banner: info ? info.banner : "",
              owner: info && info.owner ? (info.owner.display || info.owner.username) : null, ownerUser: info && info.owner ? info.owner.username : null,
              house: !!(info && info.house), camfrogName: siteOnly ? null : (R.name || (info && info.id)) },
      initial, padTabs, latest, feedSeen,
      dms: reg.hasRoute(app, "/messages"),          // 1.99co: the Manage panel's "Message" (DMs, when that page exists)
      pepeHere: here, stage: st,
      roomStage,
      manage,
      schedule: await require("./mainstage").roomSchedule(R.id, req.user, manage).catch((e) => { console.error("[stage] room schedule:", e.message); return null; }),
      analytics: reg.hasRoute(app, "/p/:slug/analytics"),
      // economy v2 E-3: the room vault card (About tab), Camfrog pads only (roomvaults.js)
      roomVault: siteOnly ? null : await require("./roomvaults").card(R.id, req.user, { canManage: manage, staff: reg.isStaff(req.user) })
        .catch((e) => { console.error("[roomvaults] card:", e.message); return null; }),
      feed,
      fx: require("./feedweb").fx, embeds: require("./stageembed"), host: req.hostname || "publicaccess.tv",
    });
  });
}

// ── 1.99dx: the pad page's tabs ──
// The newest few posts of a pad (the Live tab's "Latest from the feed" card and the Feed tab's "N new" badge):
// the page's own first page when it is sorted by new, else one extra newest-first read.
async function padLatest(roomId, user, feed) {
  let posts = feed && feed.sort === "new" && feed.page === 1 ? feed.posts : null;
  if (!posts) {
    try { posts = ((await require("./feedweb").roomFeed(roomId, user, {})) || {}).posts || []; } catch (e) { posts = []; }
  }
  return (posts || []).filter((p) => p && !p.deleted && !p.hidden && !p.pending && !p.roomHidden)
    .sort((a, b) => Number(b.created) - Number(a.created)).slice(0, 10)
    .map((p) => ({ id: p.id, url: typeof p.url === "string" && /^\/(?![/\\])/.test(p.url) ? p.url : null, created: Number(p.created) || 0, title: require("./postlabel").postLabel(p).slice(0, 120), titleFallback: require("./postlabel").labelOf(p).fallback,
                   text: String(p.body || "").replace(/\s+/g, " ").trim().slice(0, 140), nsfw: !!p.nsfw,
                   author: p.author ? (p.author.bot ? "Pepe" : p.author.display || p.author.username || "") : "" }));
}
/** Which tabs a pad page has and which opens first (before the browser's own choice: its remembered tab,
 *  #hash). The Live tab is "Stage" on pads without a Camfrog room; the room is "active" when people are in
 *  it (not counting Pepe) or its stage is on air. */
function padTabsFor(o) {
  const T = require("./public/js/pad-tabs");
  const camfrog = o.platform === "camfrog";
  const tabs = ["live"].concat(o.feed ? ["feed"] : [], ["about"]);
  const people = Array.isArray(o.members) ? o.members.filter((m) => m && !m.self && !m.bot).length
    : Math.max(0, (Number(o.count) || 0) - (o.pepeHere === true ? 1 : 0));
  const stageOn = (o.pepeOn && o.pepeHere !== false) || (Array.isArray(o.slots) && o.slots.length > 0);
  const active = !!((camfrog && o.live && people > 0) || stageOn);
  const qs = String(o.query || "").includes("?") ? String(o.query).slice(String(o.query).indexOf("?")) : "";
  const requested = T.requestedTab(qs, "");
  return { tabs, camfrog, active, people, stageOn, requested, initial: T.pickTab({ tabs, platform: o.platform, active, requested, stored: null }),
           posts: (o.latest || []).map((p) => ({ id: p.id, created: p.created })) };
}

module.exports = { register, load, padTabsFor, padLatest, summary, ingest, slugify, stage, stageRoom, stageAdmin, stageRoomRef, pepeIn, snapSwitch, clipSwitch, liveFor, bySlug, isLive, _rooms: rooms,
  liveView, withPatv, resolveNames, _nameCache: nameCache, tipFor, TIP_UNLINKED, _pepeName: (v) => { pepeName = { v, at: Date.now() }; } };
