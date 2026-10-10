// medialib.js — 1.99ji: 📼 Play from library. An admin plays a movie or an episode from the homelab Plex library on a
// pad's stage.
//
// The homelab media-control service (deploy/mediactl, next to the files and the iGPU) does the Plex search and runs
// one `ffmpeg -re` per stage that pushes H.264 + AAC to the ordinary RTMP ingest with a 📼 LIBRARY SLOT's one-time key
// (mainstage.libraryOpen: free, as long as the title, one per pad). So the stage, HLS, WHEP, snaps and the Twitch relay
// all see an ordinary slot, and ending the slot (Cut, time up, a paused slot left too long) ends the stream.
//
// Calls to the service are signed (HMAC-SHA256 with MEDIACTL_SECRET - the same scheme as mediactl.js sign()) and,
// for https, the certificate is pinned by MEDIACTL_TLS_SHA256. The Plex token stays in the homelab.
//
// Admin-only for now (DMCA / rights): mediaconf library_allow = admins (class Admin) | staff. Flag library_enabled.
// Every play is logged (media_plays: who, what, pad, when, how it ended).
//
//   media_sessions   room_id -> the slot + play that pad's stage is running from the library
//   media_plays      the log
"use strict";
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const tls = require("tls");
const { runQuery, getQuery } = require("./dbUtils");
const conf = require("./mediaconf");
const stage = require("./mainstage");
const rooms = require("./rooms");

const STAGING = !!process.env.STAGING;
const WATCH_MS = 10 * 1000;
const SLACK_MIN = 20;          // a library slot runs this much longer than what's left of the title

class Refuse extends Error {
  constructor(status, message) { super(message); this.status = status; this.refuse = true; }
}

// ── the media-control client ──
const env = (k) => String(process.env[k] || "").trim();
function signHeaders(secret, method, pathQ, body) {
  const ts = String(Date.now());
  const nonce = crypto.randomBytes(16).toString("base64url");
  const bh = crypto.createHash("sha256").update(body || "").digest("hex");
  const sig = crypto.createHmac("sha256", secret).update(`${ts}\n${nonce}\n${method}\n${pathQ}\n${bh}`).digest("hex");
  return { "x-mc-ts": ts, "x-mc-nonce": nonce, "x-mc-sig": sig };
}
const bare = (h) => String(h || "").replace(/^\[|\]$/g, "");      // "[::1]" -> "::1" for net/tls
const normFp = (s) => String(s || "").replace(/[^A-Fa-f0-9]/g, "").toUpperCase();
// a TLS socket whose certificate matched the pin, before a single byte of the request is written
function pinnedSocket(u, pin, timeout) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: bare(u.hostname), port: Number(u.port) || 443, rejectUnauthorized: false,
                            servername: /^[\d.]+$|:/.test(u.hostname) ? undefined : u.hostname }, () => {
      const fp = normFp((s.getPeerCertificate() || {}).fingerprint256);
      if (!fp || fp !== normFp(pin)) { s.destroy(); return reject(Object.assign(new Error("media-control certificate doesn't match MEDIACTL_TLS_SHA256"), { status: 502 })); }
      resolve(s);
    });
    s.setTimeout(timeout, () => s.destroy(new Error("timeout")));
    s.once("error", reject);
  });
}
/** -> {status, json} (or {status, body, type} with raw). Throws {status: 502/503} when it can't be reached. */
async function call(method, pathQ, body = null, { raw = false, timeout = 15000 } = {}) {
  const base = env("MEDIACTL_URL").replace(/\/+$/, ""), secret = env("MEDIACTL_SECRET");
  if (!base || secret.length < 32) throw new Refuse(503, "The media-control service isn't configured.");
  const u = new URL(base + pathQ);
  const data = body == null ? "" : JSON.stringify(body);
  const headers = { ...signHeaders(secret, method, u.pathname + u.search, data), Accept: "application/json" };
  if (data) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(data); }
  const pin = env("MEDIACTL_TLS_SHA256");
  const opts = { host: bare(u.hostname), port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search, method, headers, timeout };
  let mod = http;
  if (u.protocol === "https:") {
    // pinned: our own already-verified TLS socket under a plain http request; unpinned: ordinary CA-checked https
    if (pin) { const sock = await pinnedSocket(u, pin, timeout); opts.createConnection = () => sock; }
    else { mod = https; }
  }
  return new Promise((resolve, reject) => {
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (raw) return resolve({ status: res.statusCode, body: buf, type: res.headers["content-type"] });
        let json = null;
        try { json = JSON.parse(buf.toString("utf8")); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => reject(Object.assign(new Error("The media-control service can't be reached (" + conf.errLine(e) + ")."), { status: 502, refuse: true })));
    if (data) req.write(data);
    req.end();
  });
}
// a JSON call that must succeed: its error message is shown to the admin as-is (mediactl's messages are written for that)
async function must(method, pathQ, body) {
  const r = await call(method, pathQ, body);
  if (r.status === 401) throw new Refuse(502, "The media-control service refused our signature - check MEDIACTL_SECRET on both sides (and the clocks).");
  if (r.status >= 400 || !r.json || r.json.ok === false) throw new Refuse(r.status >= 400 && r.status < 500 ? r.status : 502, (r.json && r.json.error) || `media-control answered ${r.status}`);
  return r.json;
}

// mediactl stage name for a pad: prod and staging share the one service, so staging's are prefixed
function stageName(roomId) {
  const id = String(roomId || "");
  const base = /^[A-Za-z0-9._-]{1,70}$/.test(id) ? id : "r-" + crypto.createHash("sha1").update(id).digest("hex").slice(0, 16);
  return (STAGING ? "stg." : "") + base;
}

// ── storage ──
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await conf.init();
      await stage.init();
      await runQuery(`CREATE TABLE IF NOT EXISTS media_plays (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT, username TEXT, room_id TEXT NOT NULL, slot_id TEXT,
        rating_key TEXT, title TEXT, kind TEXT, year INTEGER, duration INTEGER, quality INTEGER, offset_start INTEGER,
        audio INTEGER, sub INTEGER, ended_at INTEGER, end_reason TEXT, last_pos INTEGER, error TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS media_plays_ts ON media_plays (ts)");
      await runQuery(`CREATE TABLE IF NOT EXISTS media_sessions (
        room_id TEXT PRIMARY KEY, slot_id TEXT NOT NULL, play_id INTEGER NOT NULL, rating_key TEXT, title TEXT, state TEXT NOT NULL,
        by_user TEXT, started INTEGER NOT NULL, updated INTEGER NOT NULL, position INTEGER, duration INTEGER)`);
      stage.setLibraryIdle(conf.get().library_pause_max_min);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const keys = new Map();   // room id -> the slot's raw RTMP key (memory only; resume after a mediactl restart needs it)
const fmtTitle = (it) => (it.type === "episode" && it.show
  ? `${it.show} S${String(it.season || 0).padStart(2, "0")}E${String(it.episode || 0).padStart(2, "0")} · ${it.title}`
  : `${it.title}${it.year ? ` (${it.year})` : ""}`).slice(0, 72);

function assertUser(user) {
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  if (!conf.libraryAllowed(user)) throw new Refuse(403, "Playing from the library is for site admins.");
  if (!conf.on.library()) throw new Refuse(403, conf.keys().mediactl ? "Play from library is switched off (/admin/media)." : "The media-control service isn't configured yet.");
}
async function session(roomId) { return (await getQuery("SELECT * FROM media_sessions WHERE room_id = ?", [String(roomId)]))[0] || null; }
async function closePlay(playId, reason, pos, error) {
  await runQuery("UPDATE media_plays SET ended_at = COALESCE(ended_at, ?), end_reason = COALESCE(end_reason, ?), last_pos = COALESCE(?, last_pos), error = COALESCE(?, error) WHERE id = ?",
                 [Date.now(), reason, pos == null ? null : Math.round(pos), error || null, playId]);
}
async function dropSession(s, reason, pos, error) {
  await runQuery("DELETE FROM media_sessions WHERE room_id = ? AND slot_id = ?", [s.room_id, s.slot_id]);
  keys.delete(s.room_id);
  await closePlay(s.play_id, reason, pos, error);
}
const roomOf = async (v) => {
  const id = String(v || "");
  if (!id) return null;
  return (await rooms.bySlug(id)) || (await rooms.get(id)) || (id === rooms.HOUSE_ROOM ? { id, title: "Pepe's pad" } : null);
};

// ── actions ──
async function search(user, q) {
  assertUser(user);
  q = String(q || "").trim().slice(0, 100);
  if (q.length < 2) throw new Refuse(400, "Type at least 2 characters.");
  return (await must("GET", `/search?q=${encodeURIComponent(q)}&limit=24`)).results || [];
}
async function item(user, key) {
  assertUser(user);
  if (!/^\d{1,12}$/.test(String(key))) throw new Refuse(400, "Bad item.");
  return (await must("GET", `/item/${key}`)).item;
}
async function poster(user, key) {
  assertUser(user);
  if (!/^\d{1,12}$/.test(String(key))) throw new Refuse(400, "Bad item.");
  const r = await call("GET", `/poster/${key}`, null, { raw: true });
  if (r.status !== 200) throw new Refuse(404, "No poster.");
  return r;
}

// open a library slot + start the stream at `offset` (s). -> {slot, play_id}
async function startOn(user, R, it, o) {
  const left = Math.max(60, (it.duration || 0) - o.offset);
  const title = "📼 " + fmtTitle(it);
  const opened = await stage.libraryOpen(user, { room: R.id, title, minutes: Math.ceil(left / 60) + SLACK_MIN });
  const body = { rtmp: stage.RTMP_PUBLIC, key: opened.key, ratingKey: String(it.key), offset: o.offset, quality: o.quality,
                 audio: o.audio, sub: o.sub, title: fmtTitle(it) };
  try {
    await must("PUT", `/streams/${encodeURIComponent(stageName(R.id))}`, body);
  } catch (e) {
    await stage.end(opened.slot.id, "library_failed", user.username).catch(() => {});
    throw e;
  }
  keys.set(R.id, opened.key);
  return opened.slot;
}

async function play(user, b = {}) {
  await init();
  assertUser(user);
  const R = await roomOf(b.room);
  if (!R) throw new Refuse(404, "No such pad.");
  if (await session(R.id)) throw new Refuse(409, "This pad is already playing from the library - stop it first.");
  const it = await item(user, b.key);
  if (!it || !["movie", "episode"].includes(it.type) || !it.file) throw new Refuse(400, "Pick a movie or an episode.");
  const S = conf.get();
  const o = {
    offset: Math.max(0, Math.min(Math.floor(Number(b.offset) || 0), Math.max(0, (it.duration || 0) - 30))),
    quality: [1080, 720, 480].includes(Number(b.quality)) ? Number(b.quality) : S.library_quality,
    audio: b.audio !== undefined && b.audio !== null && b.audio !== "" && (it.audio || []).some((a) => a.index === Number(b.audio)) ? Number(b.audio) : null,
    sub: b.sub !== undefined && b.sub !== null && b.sub !== "" && (it.subs || []).some((s) => s.index === Number(b.sub) && s.burnable) ? Number(b.sub) : null,
  };
  const slot = await startOn(user, R, it, o);
  const t = Date.now();
  const p = await runQuery(`INSERT INTO media_plays (ts, user_id, username, room_id, slot_id, rating_key, title, kind, year, duration, quality, offset_start, audio, sub)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                           [t, user.userId, user.username, R.id, slot.id, String(it.key), fmtTitle(it), it.type, it.year || null, it.duration || null,
                            o.quality, o.offset, o.audio, o.sub]);
  await runQuery(`INSERT INTO media_sessions (room_id, slot_id, play_id, rating_key, title, state, by_user, started, updated, position, duration)
                  VALUES (?, ?, ?, ?, ?, 'playing', ?, ?, ?, ?, ?)`,
                 [R.id, slot.id, p.id, String(it.key), fmtTitle(it), user.username, t, t, o.offset, it.duration || null]);
  console.log(`[medialib] ${user.username} plays "${fmtTitle(it)}" (${it.key}) on ${R.id} at ${o.offset}s, ${o.quality}p - play #${p.id}`);
  return { ok: true, play_id: p.id, slot: { id: slot.id, stream: slot.stream, hls: slot.hls }, title: fmtTitle(it) };
}

async function needSession(user, room) {
  await init();
  assertUser(user);
  const R = await roomOf(room);
  if (!R) throw new Refuse(404, "No such pad.");
  const s = await session(R.id);
  if (!s) throw new Refuse(404, "Nothing from the library is playing on this pad.");
  return { R, s };
}

async function stop(user, room, reason = "stopped") {
  const { R, s } = await needSession(user, room);
  let pos = null;
  try { const r = await must("POST", `/streams/${encodeURIComponent(stageName(R.id))}/stop`, {}); pos = r.stream && r.stream.position; }
  catch (e) { console.warn("[medialib] stop: media-control:", conf.errLine(e)); }
  await stage.end(s.slot_id, "library_" + reason, user.username).catch(() => {});
  await dropSession(s, reason + " by " + user.username, pos);
  return { ok: true };
}

async function pause(user, room) {
  const { R, s } = await needSession(user, room);
  if (s.state !== "playing") throw new Refuse(409, "It isn't playing.");
  const r = await must("POST", `/streams/${encodeURIComponent(stageName(R.id))}/pause`, {});
  await runQuery("UPDATE media_sessions SET state = 'paused', position = ?, updated = ? WHERE room_id = ?", [r.stream ? r.stream.position : s.position, Date.now(), R.id]);
  return { ok: true, position: r.stream ? r.stream.position : null, resume_by: Date.now() + conf.get().library_pause_max_min * 60000 };
}

// resume (paused) or seek (any state): back on the same slot when it's still open, else on a fresh slot
async function restart(user, room, offset, how) {
  const { R, s } = await needSession(user, room);
  const slot = await stage.getSlot(s.slot_id);
  const open = slot && !slot.settled && ["waiting", "active"].includes(slot.status);
  const name = encodeURIComponent(stageName(R.id));
  const pos = offset == null ? (s.position || 0) : Math.max(0, Math.min(Math.floor(Number(offset) || 0), Math.max(0, (s.duration || 0) - 30)));
  if (open) {
    try {
      const r = how === "resume" && offset == null ? await must("POST", `/streams/${name}/resume`, {}) : await must("POST", `/streams/${name}/seek`, { offset: pos });
      if (s.duration) await stage.libraryExtend(s.slot_id, Math.ceil(((slot.live_ms || 0) / 1000 + (s.duration - pos)) / 60) + SLACK_MIN);
      await runQuery("UPDATE media_sessions SET state = 'playing', position = ?, updated = ? WHERE room_id = ?", [r.stream ? r.stream.offset : pos, Date.now(), R.id]);
      return { ok: true, position: pos, same_slot: true };
    } catch (e) {
      if (!(e.status === 409 || e.status === 404)) throw e;     // mediactl forgot it (restarted): start it again below
      await stage.end(s.slot_id, "library_restart", user.username).catch(() => {});
    }
  }
  // a fresh slot (the old one ended - a long pause - or mediactl lost the stream)
  const play = (await getQuery("SELECT * FROM media_plays WHERE id = ?", [s.play_id]))[0] || {};
  await dropSession(s, open ? "restarted" : "slot ended", pos);
  try { await call("POST", `/streams/${name}/stop`, {}); } catch (e) { /* best effort */ }
  return { ...(await play_(user, { room: R.id, key: s.rating_key, offset: pos, quality: play.quality, audio: play.audio, sub: play.sub })), same_slot: false };
}
const play_ = (u, b) => play(u, b);
const resume = (user, room) => restart(user, room, null, "resume");
const seek = (user, room, offset) => restart(user, room, offset, "seek");

// ── state ──
async function streamsNow() {
  try { const r = await call("GET", "/streams", null, { timeout: 6000 }); return r.status === 200 && r.json ? r.json.streams || [] : null; }
  catch (e) { return null; }
}
async function state(user) {
  await init();
  if (!conf.libraryAllowed(user)) throw new Refuse(403, "Admins only.");
  const S = conf.get(), K = conf.keys();
  const sessions = await getQuery("SELECT * FROM media_sessions ORDER BY started");
  const live = K.mediactl ? await streamsNow() : null;
  const byName = new Map((live || []).map((x) => [x.stage, x]));
  return {
    enabled: conf.on.library(), flag: !!S.library_enabled, configured: K.mediactl, pinned: K.mediactl_tls_pinned, reachable: live !== null,
    quality: S.library_quality, pause_max_min: S.library_pause_max_min,
    sessions: sessions.map((s) => {
      const m = byName.get(stageName(s.room_id));
      return { room: s.room_id, slot_id: s.slot_id, play_id: s.play_id, title: s.title, by: s.by_user, started: s.started,
               state: m ? m.state : s.state, position: m ? m.position : s.position, duration: (m && m.duration) || s.duration, error: m ? m.error : null };
    }),
    plays: await getQuery("SELECT id, ts, username, room_id, title, kind, quality, offset_start, ended_at, end_reason, last_pos, error FROM media_plays ORDER BY id DESC LIMIT 30"),
  };
}

// ── the watcher: keeps the slot and the stream together ──
async function watch() {
  await init();
  const sessions = await getQuery("SELECT * FROM media_sessions");
  if (!sessions.length) return 0;
  const live = await streamsNow();
  let n = 0;
  for (const s of sessions) {
    try {
      const slot = await stage.getSlot(s.slot_id);
      const name = stageName(s.room_id);
      const m = live ? live.find((x) => x.stage === name) : undefined;
      if (!slot || slot.settled || slot.status === "ended") {
        // the stage ended it (Cut, time up, paused too long): stop the encoder
        try { await call("POST", `/streams/${encodeURIComponent(name)}/stop`, {}); } catch (e) { /* unreachable: it'll fail to publish anyway */ }
        await dropSession(s, "slot " + ((slot && slot.end_reason) || "ended"), m ? m.position : s.position);
        n++; continue;
      }
      if (live === null) continue;                                    // can't see the service right now: change nothing
      if (!m) {
        if (s.state === "paused" && Date.now() - s.updated < 60000) continue;
        await stage.end(s.slot_id, "library_lost", "system").catch(() => {});
        await dropSession(s, "lost (media-control restarted?)", s.position);
        n++; continue;
      }
      if (m.state === "ended" || m.state === "error") {
        await stage.end(s.slot_id, m.state === "ended" ? "library_done" : "library_error", "system").catch(() => {});
        try { await call("POST", `/streams/${encodeURIComponent(name)}/stop`, {}); } catch (e) { /* best effort */ }
        await dropSession(s, m.state === "ended" ? "finished" : "error", m.position, m.error);
        n++; continue;
      }
      await runQuery("UPDATE media_sessions SET position = ?, state = ?, updated = ? WHERE room_id = ? AND slot_id = ?",
                     [m.position, m.state === "paused" ? "paused" : "playing", Date.now(), s.room_id, s.slot_id]);
    } catch (e) {
      console.error("[medialib] watch:", conf.errLine(e));
    }
  }
  return n;
}

// ── routes ──
let timer = null;
function register(app, { addUser, noTimers } = {}) {
  const guard = require("./middleware/authGuard");
  if (!noTimers && !timer) {
    timer = setInterval(() => watch().catch((e) => console.error("[medialib] watch:", conf.errLine(e))), WATCH_MS);
    timer.unref();
  }
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message });
    console.error("[medialib]", conf.errLine(e));
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  const gate = (req, res, next) => {
    if (!req.user || !conf.libraryAllowed(req.user)) return res.status(403).json({ ok: false, error: "Admins only." });
    if (req.method === "POST" && !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    next();
  };
  const me = (req) => ({ userId: req.user.userId, username: req.user.username, class: req.user.class });
  const J = (fn) => [addUser, gate, async (req, res) => { try { res.set("Cache-Control", "no-store"); res.json(await fn(req)); } catch (e) { fail(res, e); } }];

  app.get("/api/medialib/state", ...J(async (req) => ({ ok: true, ...(await state(me(req))) })));
  app.get("/api/medialib/search", ...J(async (req) => ({ ok: true, results: await search(me(req), req.query.q) })));
  app.get("/api/medialib/item/:key", ...J(async (req) => ({ ok: true, item: await item(me(req), req.params.key) })));
  app.get("/api/medialib/poster/:key", addUser, gate, async (req, res) => {
    try {
      const r = await poster(me(req), req.params.key);
      res.set("Content-Type", /^image\/(jpeg|png|webp)/.test(String(r.type)) ? String(r.type) : "image/jpeg");
      res.set("Cache-Control", "private, max-age=3600");
      res.send(r.body);
    } catch (e) { res.status(e.status === 403 ? 403 : 404).end(); }
  });
  app.post("/api/medialib/play", ...J(async (req) => play(me(req), req.body || {})));
  app.post("/api/medialib/stop", ...J(async (req) => stop(me(req), (req.body || {}).room)));
  app.post("/api/medialib/pause", ...J(async (req) => pause(me(req), (req.body || {}).room)));
  app.post("/api/medialib/resume", ...J(async (req) => resume(me(req), (req.body || {}).room)));
  app.post("/api/medialib/seek", ...J(async (req) => seek(me(req), (req.body || {}).room, (req.body || {}).offset)));
}

module.exports = { init, register, play, stop, pause, resume, seek, search, item, state, watch, stageName, call, signHeaders, fmtTitle, Refuse, _keys: keys };
