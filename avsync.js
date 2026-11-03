// avsync.js — measured room-audio/cam timing, viewer-scoped browser targets and audited rollout settings.
// Ships off. This module never delays audio or a shared relay: each allowed viewer applies the video target locally.
// noteAudio/audioMeta are synchronous so stage clips can read the hidden-mic mark for the exact chunk being written.
// Public replies contain timing numbers and opaque cam paths only; admin diagnostics remain capability-gated.
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");
const SP = require("./siteperms");
const guard = require("./middleware/authGuard");

const FIELDS = Object.freeze({
  mode: { def: "off", choices: ["off", "admins", "everyone"] },
  apply_video: { def: true }, apply_mic: { def: true },
  // 1.99ahm: the "On the mic" card and the chat's grab/drop lines, each its own switch (off until an admin ticks it); they use the
  // mic-sign offset (ind_path_ms / k_ind_ms / cap_ind_ms) and the same who / audio-playing rules as apply_mic
  apply_mic_card: { def: false }, apply_mic_chat: { def: false },
  // 1.99ahm: the people list's 🎙 icons and on-mic order (and the homepage's mic chips) - its own switch, the same offset and rules
  apply_mic_list: { def: false },
  // 1.99?? avf (F5): whether a viewer's own "Sync to the audio" toggle also holds the mic signs (true = as before). false: the mic
  // signs are held for every viewer the switches apply to, whatever their toggle says; the toggle then holds the cams only
  mic_follow_toggle: { def: true },
  apply_mp3: { def: true },
  engine_chromium: { def: true }, engine_firefox: { def: false }, engine_safari: { def: false },
  fallback_rtc_ms: { def: 500, min: 0, max: 4000 }, fallback_mp3_ms: { def: 1500, min: 0, max: 4000 },
  // 1.99?? avf (F4): the mic signs' own fallback while the room audio isn't measured (they need about the whole audio path, the
  // cams far less - one shared number could not serve both)
  fallback_ind_rtc_ms: { def: 2000, min: 0, max: 5000 }, fallback_ind_mp3_ms: { def: 3000, min: 0, max: 5000 },
  k_pt_ms: { def: 0, min: -3000, max: 3000 }, k_re_ms: { def: 0, min: -3000, max: 3000 },
  ind_path_ms: { def: 300, min: 0, max: 3000 }, k_ind_ms: { def: 0, min: -3000, max: 3000 },
  cap_ms: { def: 3000, min: 0, max: 4000 }, cap_ind_ms: { def: 3000, min: 0, max: 5000 },
  deadband_ms: { def: 40, min: 0, max: 500 }, period_s: { def: 2, min: 1, max: 10 },
  mods_instant: { def: false },
});
const DEFAULTS = Object.freeze(Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.def])));
const LAT_KEYS = ["mix_ms", "helper_ms", "rtc_ms", "mp3_ms"];
const LAT_MAX_MS = 30000, FRESH_MS = 30000, CACHE_MS = 2000, AUDIT = "avsync_cfg";
const adminHits = guard.limiter({ max: 20, windowMs: 60000 });
let NOW = () => Date.now(), ready = null, saving = Promise.resolve();
let CFG = { v: 0, cfg: { ...DEFAULTS }, at: null };
const AUDIO = new Map(), ROOM_CACHE = new Map();
class Refuse extends Error { constructor(status, msg, fields) { super(msg); this.refuse = true; this.status = status; this.fields = fields || null; } }

function normalize(input, { base = DEFAULTS, lenient = false } = {}) {
  const src = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const cfg = {}, errors = {};
  for (const [key, f] of Object.entries(FIELDS)) {
    const raw = Object.prototype.hasOwnProperty.call(src, key) && src[key] !== "" && src[key] != null ? src[key] : base[key];
    if (f.choices) {
      const value = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
      cfg[key] = f.choices.includes(value) ? value : f.def;
      if (!f.choices.includes(value) && !lenient) errors[key] = "one of " + f.choices.join(", ");
    } else if (typeof f.def === "boolean") {
      const value = raw === true || raw === 1 || raw === "true" || raw === "1" ? true :
        raw === false || raw === 0 || raw === "false" || raw === "0" ? false : null;
      cfg[key] = value == null ? f.def : value;
      if (value == null && !lenient) errors[key] = "on or off";
    } else {
      const value = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(raw) ? Number(raw) : NaN;
      cfg[key] = Number.isFinite(value) ? Math.round(Math.max(f.min, Math.min(f.max, value))) : f.def;
      if (!Number.isFinite(value) && !lenient) errors[key] = "a number";
      else if ((value < f.min || value > f.max) && !lenient) errors[key] = `${f.min}–${f.max}`;
    }
  }
  return { cfg, errors };
}

function init() {
  if (!ready) ready = (async () => {
    await runQuery(`CREATE TABLE IF NOT EXISTS avsync_cfg (id INTEGER PRIMARY KEY CHECK (id = 1), v INTEGER NOT NULL,
                    data TEXT NOT NULL, updated_at INTEGER)`);
    const row = (await getQuery("SELECT v, data, updated_at FROM avsync_cfg WHERE id = 1"))[0];
    if (row) {
      let data = {}; try { data = JSON.parse(row.data) || {}; } catch (e) { /* bad stored row stays dark by default */ }
      CFG = { v: Number(row.v) || 0, cfg: normalize(data, { lenient: true }).cfg, at: row.updated_at || null };
    }
  })().catch((e) => { ready = null; throw e; });
  return ready;
}
const current = () => ({ v: CFG.v, cfg: { ...CFG.cfg } });

async function save(user, body = {}) {
  await init();
  if (!SP.can(user, "pepe.rooms_commands_audio")) throw new Refuse(403, "Admins only.");
  const key = String(user.userId || user.username || "").toLowerCase();
  if (adminHits.blocked(key)) throw new Refuse(429, "Slow down - at most 20 changes a minute.");
  adminHits.hit(key);
  const task = saving.then(async () => {
    const normalized = normalize(body.cfg, { base: CFG.cfg });
    if (body.reset !== true && Object.keys(normalized.errors).length) {
      const [field, why] = Object.entries(normalized.errors)[0];
      throw new Refuse(400, field + ": " + why, normalized.errors);
    }
    const cfg = body.reset === true ? { ...DEFAULTS } : normalized.cfg, changed = {};
    for (const name of Object.keys(FIELDS)) if (CFG.cfg[name] !== cfg[name]) changed[name] = [CFG.cfg[name], cfg[name]];
    await require("./adminaudit").init();
    const at = NOW();
    const v = await tx(async () => {
      const row = (await getQuery("SELECT v FROM avsync_cfg WHERE id = 1"))[0];
      const next = (row ? Number(row.v) || 0 : CFG.v) + 1;
      await runQuery(`INSERT INTO avsync_cfg (id, v, data, updated_at) VALUES (1, ?, ?, ?)
                      ON CONFLICT(id) DO UPDATE SET v=excluded.v, data=excluded.data, updated_at=excluded.updated_at`,
                      [next, JSON.stringify(cfg), at]);
      await require("./adminaudit").record(user, AUDIT, null, { action: body.reset === true ? "reset" : "save", v: next, changed, to: cfg },
        body.reason ? String(body.reason).slice(0, 200) : null);
      return next;
    });
    CFG = { v, cfg, at };
    return { v, cfg: { ...cfg }, changed };
  });
  saving = task.catch(() => {});
  return task;
}

function cleanLat(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const lat = {};
  for (const key of LAT_KEYS) lat[key] = typeof src[key] === "number" && Number.isFinite(src[key]) ? Math.round(Math.max(0, Math.min(LAT_MAX_MS, src[key]))) : null;
  return lat;
}
function noteAudio(roomId, body) {
  if (typeof roomId !== "string" || !roomId || roomId.length > 128) return;
  body = body && typeof body === "object" ? body : {};
  AUDIO.set(roomId, { lat: cleanLat(body.lat), hm: body.hm === 0 || body.hm === 1 ? body.hm : null, at: NOW() });
}
function audioMeta(roomId) {
  const meta = AUDIO.get(String(roomId));
  return meta ? { lat: { ...meta.lat }, hm: meta.hm, at: meta.at } : null;
}
function roomAudio(roomId) {
  const t = NOW(), cached = ROOM_CACHE.get(roomId);
  if (cached && t >= cached.at && t - cached.at < CACHE_MS) return { ...cached.audio,
    age_s: cached.audio.age_s == null ? null : cached.audio.age_s + (t - cached.at) / 1000 };
  const meta = audioMeta(roomId), audio = { ...cleanLat(meta && meta.lat), age_s: meta ? Math.max(0, (t - meta.at) / 1000) : null };
  ROOM_CACHE.set(roomId, { at: t, audio });
  return { ...audio };
}
function serverOffsetMs(roomId, path, mode) {
  if (mode !== "rtc" && mode !== "mp3") return null;
  const meta = audioMeta(roomId), t = NOW(), hold = require("./livecam").relayHold(path, roomId);
  if (!meta || t < meta.at || t - meta.at > FRESH_MS || !hold || hold.hold_ms == null) return null;
  const audio = meta.lat[mode + "_ms"];
  if (audio == null) return null;
  return audio - hold.hold_ms + CFG.cfg[hold.src === "passthrough" ? "k_pt_ms" : "k_re_ms"];
}
/** review fix: whether the mode applies to this viewer. Pads load av-sync.js only then, so a dark rollout never polls. */
function viewerOn(user) {
  const mode = CFG.cfg.mode;
  return !!(user && user.userId) && (mode === "everyone" || mode === "admins" && SP.can(user, "pepe.rooms_commands_audio"));
}
function answer(roomId, paths, user) {
  const c = CFG.cfg, dbg = SP.can(user, "pepe.rooms_commands_audio"), cams = {};
  const LC = require("./livecam");
  for (const path of paths) {
    const hold = LC.holdOf(path, user.userId, roomId);
    if (hold) cams[path] = hold;
  }
  return { ok: true, on: viewerOn(user), dbg, audio: roomAudio(roomId), cams,
    k: { pt: c.k_pt_ms, re: c.k_re_ms, ind: c.k_ind_ms }, fallback: { rtc: c.fallback_rtc_ms, mp3: c.fallback_mp3_ms },
    fallback_ind: { rtc: c.fallback_ind_rtc_ms, mp3: c.fallback_ind_mp3_ms }, mic_follow_toggle: c.mic_follow_toggle,   // 1.99?? avf (F4, F5)
    cap: c.cap_ms, cap_ind: c.cap_ind_ms, deadband: c.deadband_ms, period_s: c.period_s,
    apply: { video: c.apply_video, mic: c.apply_mic, mp3: c.apply_mp3, mic_card: c.apply_mic_card, mic_chat: c.apply_mic_chat,
             mic_list: c.apply_mic_list },   // 1.99ahm: + card / chat / people list
    engines: { chromium: c.engine_chromium, firefox: c.engine_firefox, safari: c.engine_safari }, ind_path_ms: c.ind_path_ms, mods_instant: c.mods_instant };
}
async function view() {
  await init();
  const t = NOW(), rooms = [], relays = [];
  for (const [room, meta] of AUDIO) {
    if (t - meta.at <= 90000) rooms.push({ room, lat: { ...meta.lat }, age_s: Math.max(0, (t - meta.at) / 1000) });
  }
  const LC = require("./livecam");
  for (const session of LC._sessions.values()) {
    if (session.ended) continue;
    const hold = LC.relayHold(session.path);
    if (hold) relays.push({ path: session.path, ...hold });
  }
  let audit = []; try { audit = await require("./adminaudit").recent(AUDIT, 15); } catch (e) { /* no saves yet */ }
  return { now: t, v: CFG.v, cfg: { ...CFG.cfg }, defaults: { ...DEFAULTS }, fields: FIELDS, updated_at: CFG.at, rooms, relays, audit };
}

function register(app, { addUser }) {
  init().catch((e) => console.error("[avsync] init:", e.message));
  const hits = require("./webrtc").limiter(30, 60000);
  const admin = (req, res, next) => {
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    if (!SP.can(req.user, "pepe.rooms_commands_audio")) return res.status(403).json({ ok: false, error: "Admins only." });
    next();
  };
  const fetchOnly = (req, res, next) => guard.sameSite(req) && req.get("X-Requested-With") === "fetch" ? next() :
    res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status).json({ ok: false, error: e.message, fields: e.fields || undefined });
    console.error("[avsync]", e);
    return res.status(500).json({ ok: false, error: "unavailable" });
  };
  app.get("/api/rooms/:slug/avsync", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "denied" });
    try {
      const B = require("./bridge"), PA = require("./padaccess");
      await B.load(); await PA.init(); await init();
      const room = B.bySlug(req.params.slug);
      if (!room) return res.status(404).json({ ok: false, error: "unavailable" });
      if (!PA.full(req.user, room.id)) return res.status(403).json({ ok: false, error: "denied" });
      const wait = hits("u:" + req.user.userId);
      if (wait) { res.set("Retry-After", String(wait)); return res.status(429).json({ ok: false, error: "rate" }); }
      const paths = typeof req.query.p === "string" ? req.query.p.split(",") : [];
      if (paths.length > 12 || paths.some((path) => path.length > 128)) return res.status(400).json({ ok: false, error: "paths" });
      res.json(answer(room.id, [...new Set(paths)], req.user));
    } catch (e) { fail(res, e); }
  });
  app.get("/api/admin/pepe/avsync", addUser, admin, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, ...(await view()) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/pepe/avsync", addUser, admin, fetchOnly, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { const result = await save(req.user, req.body || {}); res.json({ ok: true, ...result, view: await view() }); } catch (e) { fail(res, e); }
  });
}
module.exports = { register, init, normalize, current, save, cleanLat, noteAudio, audioMeta, serverOffsetMs, viewerOn, view, FIELDS, DEFAULTS,
  _setClock: (fn) => { NOW = fn || (() => Date.now()); },
  _reset: () => { CFG = { v: 0, cfg: { ...DEFAULTS }, at: null }; AUDIO.clear(); ROOM_CACHE.clear(); ready = null; saving = Promise.resolve(); } };
