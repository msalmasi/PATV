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
//   GET /rooms                 bridged rooms (counts only for visitors)
//   GET /rooms/:slug           the live room view
//   GET /api/rooms/:slug/live?after=<cursor>   JSON the page polls (~1.5s)
// The STAGE ROOM (1.99aj): the Camfrog room the main stage (OBS / HLS stream) is showing = Pepe's
// active room (`!activeroom`). Pepe reports it with the stage state; the homepage's room panel shows
// it ("On stage: <room>") and that room's live page shows the stream above its feed. Site Admins can
// move the stage: POST /api/stage/room {room} queues a "stage.room" action Pepe validates and runs
// (only rooms he is in; refused while a game or Pepe's mic/audio would be cut short).
const express = require("express");
const { runQuery, getQuery } = require("./dbUtils");
const cosmetics = require("./cosmetics");
const relay = require("./bridge-relay");   // web -> room: chat relay, mic clips, cam snapshots (staging test)

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
const LOGIN_RE = /^[\w.\-]{1,40}$/;
const slugify = (s) => String(s || "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "room";

function cleanUser(u) {
  if (!u || typeof u !== "object") return null;
  if (u.anonymous) return { anon: true, display: "someone" };
  const login = str(u.login || u.id, 40);
  if (!LOGIN_RE.test(login)) return null;
  const out = { login, display: str(u.display, 40) || login };
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
      }
      const m = await getQuery("SELECT MAX(c) AS c FROM bridge_feed");
      cursor = Math.max(cursor, Number(m[0] && m[0].c) || 0);
    })().catch((e) => { console.error("[bridge] load:", e); });
  }
  return loaded;
}

async function persistRoom(R) {
  const snap = { topic: R.topic, members: R.members, mic: R.mic, count: R.count, listAt: R.listAt, joinedAt: R.joinedAt };
  await runQuery(`INSERT INTO bridge_rooms (id, slug, name, snap, updated) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, name = excluded.name, snap = excluded.snap, updated = excluded.updated`,
    [R.id, R.slug, R.name, JSON.stringify(snap), R.updated]);
}

async function dropRoom(id) {
  rooms.delete(id);
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
function stageAdmin() {
  const fresh = Date.now() - STAGE.at < STAGE_ROOM_FRESH;
  return { room: fresh ? STAGE.room : null, pinned: !!STAGE.pinned, rooms: fresh ? STAGE.rooms : [] };
}
function stage() {
  const fresh = Date.now() - STAGE.at < 120 * 1000;
  const room = stageRoom();
  if (HLS.live !== null) {
    return { active: HLS.live, since: HLS.live ? HLS.since : null, ended: HLS.ended || STAGE.ended || null, known: true, source: "hls", room };
  }
  return { active: fresh && !!STAGE.active, since: STAGE.since || null, ended: STAGE.ended || null, known: fresh && !STAGE.unknown, source: "obs", room };
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

async function ingest(body) {
  await load();
  const now = Date.now();
  if (body.stage && typeof body.stage === "object") {
    const g = body.stage, n = (v) => (Number(v) > 0 ? Number(v) * 1000 : null);
    const rid = (v) => (typeof v === "string" && str(v, 128) ? str(v, 128) : null);   // same shape as cleanRoomRef's id
    const roomList = (Array.isArray(g.rooms) ? g.rooms : []).slice(0, MAX_ROOMS)
      .map((r) => (r && rid(r.id) ? { id: rid(r.id), name: str(r.name, 100) || rid(r.id) } : null)).filter(Boolean);
    STAGE = { active: !!g.active, unknown: !!g.unknown, since: n(g.since), ended: n(g.ended), at: now,
              room: rid(g.room), roomName: str(g.room_name, 100), pinned: !!g.pinned, rooms: roomList };
  }
  const touched = new Set();
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
    R.joinedAt = Number(s.joined_at) ? Number(s.joined_at) * 1000 : null;
    R.transcripts = s.transcripts !== false;
    R.audio = !!s.audio;
    R.relay = !!s.relay;
    R.micRelay = !!s.mic_relay;
    R.cams = !!s.cams;
    if (!R.audio) audioClose(R.id);
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
  return { rooms: touched.size, items: newItems.length };
}

// ── PATV accounts for Camfrog names (avatar + name colour), cached ──
let linkCache = new Map(), linkAt = 0, linkLoading = null;
function links() {
  if (Date.now() - linkAt < 60 * 1000) return Promise.resolve(linkCache);
  if (!linkLoading) {
    linkLoading = getQuery(`SELECT username, camfrogUsername, avatar FROM users WHERE camfrogUsername IS NOT NULL AND camfrogUsername != ''`)
      .then((rows) => {
        const m = new Map();
        for (const r of rows) {
          const k = String(r.camfrogUsername).toLowerCase();
          if (!m.has(k) || !String(r.username).startsWith("CF")) m.set(k, r);
        }
        linkCache = m; linkAt = Date.now();
        return m;
      })
      .catch((e) => { console.error("[bridge] links:", e.message); return linkCache; })
      .finally(() => { linkLoading = null; });
  }
  return linkLoading;
}
const safeImg = (u) => (typeof u === "string" && (/^https:\/\/[^\s"'<>]+$/.test(u) || /^\/[A-Za-z0-9/_.\-]+$/.test(u)) ? u : null);

function withPatv(u, L) {
  if (!u || u.anon) return u;
  const acc = L.get(String(u.login).toLowerCase());
  if (!acc) return u;
  return { ...u, patv: { username: acc.username, avatar: safeImg(acc.avatar), style: cosmetics.nameStyle(acc.username) || "" } };
}

const isLive = (R) => Date.now() - R.updated < STALE_MS;

/** For the homepage / room list. `full` (signed-in) adds who's on the mic. */
async function summary(full) {
  await load();
  return [...rooms.values()].sort((a, b) => b.count - a.count).map((R) => ({
    slug: R.slug, name: R.name, count: R.count, live: isLive(R), micCount: R.mic.length, audio: !!R.audio && isLive(R),
    mic: full ? R.mic.map((u) => (u.anon ? "someone" : u.display)) : [],
    topic: full ? R.topic : "",
  }));
}

async function liveView(R, after, userId) {
  const L = await links();
  const feed = R.feed.filter((it) => it.c > after).slice(-FEED_KEEP)
    .map((it) => (it.u ? { ...it, u: withPatv(it.u, L) } : it));
  return {
    room: { name: R.name, slug: R.slug, topic: R.topic, count: R.count, live: isLive(R), updated: R.updated, listAt: R.listAt,
            transcripts: R.transcripts !== false, audio: !!R.audio && isLive(R),
            relay: !!R.relay && isLive(R), micRelay: !!R.micRelay && isLive(R), cams: !!R.cams && isLive(R) },
    mine: userId ? relay.mineFor(userId, R.id) : [],
    members: R.members.map((u) => withPatv(u, L)),
    mic: R.mic.map((u) => withPatv(u, L)),
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
  load();
  app.post("/api/bridge/sync", express.json({ limit: "1mb" }), async (req, res) => {
    const body = req.body || {};
    if (!isBotToken(body.password)) return res.status(403).json({ success: false, error: "unauthorized" });
    try {
      relay.applyAcks(body.acks);
      const r = await ingest(body);
      const liveIds = new Set([...rooms.values()].filter(isLive).map((R) => R.id));
      res.json({ success: true, ...r, jobs: relay.takeJobs(liveIds) });
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

  app.get("/rooms/:slug/audio", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.status(401).send("Sign in to listen.");
    await load();
    const R = bySlug(req.params.slug);
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
    if (!req.user || !req.user.userId) return res.status(401).json({ error: "Sign in to watch the room." });
    await load();
    const R = bySlug(req.params.slug);
    if (!R) return res.status(404).json({ error: "No such room." });
    const after = Math.max(0, Number(req.query.after) || 0);
    res.json(await liveView(R, after > cursor ? 0 : after, req.user.userId));
  });

  relay.register(app, { isBotToken, addUser, bySlug, isLive });

  app.get("/api/stage", async (req, res) => {
    res.set("Cache-Control", "no-store");
    // 1.99al: paid stage slots live right now (mainstage.js) ride along with Pepe's stream state
    let slots = [];
    try { slots = await require("./mainstage").publicSlots(); } catch (e) { slots = []; }
    res.json({ ...stage(), slots });
  });

  // Move the main stage to another of Pepe's rooms (site Admins). JSON only (a cross-site form can't
  // send it). Pepe re-checks the room and his BUSY rules and answers through the action.
  const adminOf = async (req) => {
    if (!req.user || !req.user.userId) return null;
    const u = (await getQuery("SELECT class FROM users WHERE userId = ?", [req.user.userId]))[0];
    return u && u.class === "Admin" ? u : null;
  };
  app.post("/api/stage/room", addUser, express.json({ limit: "4kb" }), async (req, res) => {
    if (!req.is("application/json") || req.get("X-Requested-With") !== "fetch") return res.status(400).json({ ok: false, error: "Bad request." });
    if (!(await adminOf(req))) return res.status(403).json({ ok: false, error: "Admins only." });
    const want = String((req.body || {}).room || "").trim();
    const A = stageAdmin();
    if (!A.rooms.length) return res.status(503).json({ ok: false, error: "Pepe hasn't reported his rooms yet — try again in a minute." });
    const target = want.toLowerCase() === "auto" ? "auto" : (A.rooms.find((r) => r.id === want) || {}).id;
    if (!target) return res.status(400).json({ ok: false, error: "Pepe isn't in that room." });
    try {
      const id = await require("./actions").queue(req.user.userId, { kind: "stage.room", args: [target], tag: "stage",
        label: target === "auto" ? "stage: follow the open tab" : "stage: " + target });
      res.json({ ok: true, id });
    } catch (e) {
      res.status(e.message === "busy" ? 429 : 500).json({ ok: false, error: e.message === "busy" ? "You already have a few things waiting — give Pepe a moment." : "Something went wrong — nothing was sent." });
    }
  });
  app.get("/api/stage/room/:id", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!(await adminOf(req))) return res.status(403).json({ ok: false, error: "Admins only." });
    const a = (await getQuery("SELECT status, message FROM pepe_actions WHERE id = ? AND user_id = ? AND kind = 'stage.room'",
      [parseInt(req.params.id, 10) || 0, req.user.userId]))[0];
    if (!a) return res.status(404).json({ ok: false, error: "No such action." });
    res.json({ ok: true, status: a.status, message: a.message || "", stage: stage() });
  });

  app.get("/rooms", addUser, async (req, res) => {
    const list = await summary(!!(req.user && req.user.userId));
    res.locals.og = { title: "Live rooms — Public Access TV", description: "Camfrog rooms Pepe sits in, live on PATV: chat, who's here and who's on the mic.",
                      image: res.locals.ogBase + "/og/page.png?t=Live%20rooms", url: res.locals.ogBase + "/rooms" };
    res.render("rooms", { user: req.user ? req.user.username : null, list, signedIn: !!(req.user && req.user.userId) });
  });

  app.get("/rooms/:slug", addUser, async (req, res) => {
    await load();
    const R = bySlug(req.params.slug);
    const signedIn = !!(req.user && req.user.userId);
    if (!R) {
      return res.status(404).render("notFound", { user: req.user ? req.user.username : null, heading: "No such room",
        message: "That room isn't bridged to PATV right now.", title: "Room not found" });
    }
    let linked = false;
    if (signedIn) {
      try { linked = !!((await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [req.user.userId]))[0] || {}).camfrogUsername; } catch (e) { linked = false; }
    }
    res.render("room", {
      user: req.user ? req.user.username : null, signedIn, linked,
      room: { name: R.name, slug: R.slug, count: R.count, live: isLive(R), topic: signedIn ? R.topic : "" },
      initial: signedIn ? await liveView(R, 0, req.user.userId) : null,
      onStage: !!(STAGE.room === R.id && Date.now() - STAGE.at < STAGE_ROOM_FRESH), stage: stage(),
    });
  });
}

module.exports = { register, summary, ingest, slugify, stage, stageRoom, stageAdmin, liveFor, _rooms: rooms };
