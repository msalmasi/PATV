// roomaudiocfg.js — 🔊 room-audio settings (1.99yd): the knobs of the room audio Pepe streams to pads, for site Admins.
//
//   /admin/pepe/audio#room-audio   the page (views/admin/pepeAudio.ejs): the settings (one global default), the values
//                                  Pepe runs right now, and the latest [AUDIO-STATS] line per streamed room. Reset to
//                                  defaults. Every save -> one admin_audit row ("room_audio_cfg", from -> to).
//
// The SITE owns these settings (table room_audio_cfg, one row, version v; no row = the defaults, v 0). Pepe
// (camfrog-bot pepe_audiocfg.py + pepe_roomrtc.normalize_cfg, which validates again) learns them two ways:
//   * the answer to each room-audio post (/api/bridge/audio, bridge.js -> forBot): {audio_cfg: {v, cfg}} whenever the
//     post's acfg_v isn't the current v - a save reaches a streaming Pepe in 1-3 s;
//   * the answer to his state push (POST /api/pepe/audio/state, every 20 s) - also covers a Pepe that streams nothing.
// The push carries what he runs (v, values, source) and per streamed room the latest [AUDIO-STATS] line + the
// publisher's numbers (pacing in use, buffer / target ms, restarts) - kept in memory + one row, shown read-only.
// !audiostats latency <s> in chat writes through here (POST /api/pepe/audio/set, bot token) - so the admin setting
// stays the one home; audited as "Pepe (!audiostats, <nick>)".
//
// The browser's ⚡ jitter buffer target is served with the WHEP ticket (roomrtc.ticket -> jitter_ms; room-bridge.js).
// No per-pad overrides (one global default): the pacing / mixer knobs are per Pepe process, not per pad.
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");
const guard = require("./middleware/authGuard");

// The settings: defaults = what bot 1.99ya / 1.99yb and site 1.99ya shipped. Ranges match pepe_roomrtc.CFG_RANGES.
const FIELDS = Object.freeze({
  pacing:              { def: "helper", choices: ["helper", "inprocess"] },
  helper_mode:         { def: "adaptive", choices: ["adaptive", "fixed"] },
  helper_fixed_ms:     { def: 1000, min: 100, max: 3000 },
  helper_min_ms:       { def: 200, min: 100, max: 3000 },
  helper_max_ms:       { def: 1000, min: 100, max: 3000 },
  helper_headroom_ms:  { def: 120, min: 0, max: 1000 },
  helper_window_s:     { def: 60, min: 5, max: 600 },
  inproc_prebuffer_ms: { def: 140, min: 40, max: 2000 },
  inproc_splice_ms:    { def: 600, min: 200, max: 3000 },
  mixer_latency_s:     { def: 0.7, min: 0.2, max: 3.0, step: 0.05 },
  jitter_ms:           { def: 200, min: 0, max: 2000 },
  opus_kbps:           { def: 64, min: 16, max: 256 },
  mp3_kbps:            { def: 64, choices: [32, 48, 64, 96, 128, 160, 192] },
});
const DEFAULTS = Object.freeze(Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.def])));
const ONLINE_MS = 90 * 1000;               // Pepe pushes every 20 s
const STATE_MAX = 32 * 1024;
const RATE = { max: 20, windowMs: 60 * 1000 };
const hits = guard.limiter(RATE);
const AUDIT = "room_audio_cfg";

let NOW = () => Date.now();
function _setClock(fn) { NOW = fn || (() => Date.now()); }

let CFG = { v: 0, cfg: { ...DEFAULTS }, at: null, by: null };
let BOT = null;                            // {at, data}: Pepe's last state push
let ready = null;
let loaded = false;                        // the stored row is in CFG (forBot says nothing before - no flip to defaults)
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS room_audio_cfg (id INTEGER PRIMARY KEY CHECK (id = 1), v INTEGER NOT NULL,
                      data TEXT NOT NULL, updated_at INTEGER, updated_by TEXT)`);
      await runQuery("CREATE TABLE IF NOT EXISTS room_audio_state (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL, data TEXT)");
      const r = (await getQuery("SELECT v, data, updated_at, updated_by FROM room_audio_cfg WHERE id = 1"))[0];
      if (r) {
        let d = {};
        try { d = JSON.parse(r.data) || {}; } catch (e) { d = {}; }
        CFG = { v: Number(r.v) || 0, cfg: normalize(d, { lenient: true }).cfg, at: r.updated_at || null, by: r.updated_by || null };
      }
      const s = (await getQuery("SELECT at, data FROM room_audio_state WHERE id = 1"))[0];
      if (s && !BOT) { try { BOT = { at: Number(s.at), data: JSON.parse(s.data) }; } catch (e) { BOT = null; } }
      loaded = true;
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

class Refuse extends Error { constructor(status, msg, fields) { super(msg); this.status = status; this.refuse = true; this.fields = fields || null; } }

/**
 * Validate a full or partial settings object (missing keys = `base`, else the defaults).
 * strict (default): any bad value -> errors {key: why}; lenient: bad -> the default (what's stored / what Pepe sent).
 * Cross-field: adaptive min <= max; in-process splice threshold >= prebuffer + 100 ms.
 * -> {cfg, errors}
 */
function normalize(input, { base = DEFAULTS, lenient = false } = {}) {
  const src = input && typeof input === "object" ? input : {};
  const cfg = {}, errors = {};
  for (const [k, f] of Object.entries(FIELDS)) {
    const has = Object.prototype.hasOwnProperty.call(src, k) && src[k] !== "" && src[k] != null;
    const raw = has ? src[k] : (base && base[k] != null ? base[k] : f.def);
    if (f.choices) {
      const want = typeof f.def === "number" ? Number(raw) : String(raw).trim().toLowerCase();
      if (f.choices.includes(want)) cfg[k] = want;
      else { cfg[k] = f.def; if (!lenient) errors[k] = `one of ${f.choices.join(", ")}`; }
      continue;
    }
    const n = typeof raw === "number" ? raw : (typeof raw === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(raw) ? Number(raw) : NaN);
    if (!Number.isFinite(n)) { cfg[k] = f.def; if (!lenient) errors[k] = "a number"; continue; }
    if (n < f.min || n > f.max) {
      if (!lenient) errors[k] = `${f.min}–${f.max}`;
      cfg[k] = Math.max(f.min, Math.min(f.max, n));
    } else cfg[k] = n;
    cfg[k] = k === "mixer_latency_s" ? Math.round(cfg[k] * 100) / 100 : Math.round(cfg[k]);
  }
  if (cfg.helper_min_ms > cfg.helper_max_ms) {
    if (!lenient) errors.helper_min_ms = "can't be more than the adaptive max";
    else [cfg.helper_min_ms, cfg.helper_max_ms] = [cfg.helper_max_ms, cfg.helper_min_ms];
  }
  if (cfg.inproc_splice_ms < cfg.inproc_prebuffer_ms + 100) {
    if (!lenient) errors.inproc_splice_ms = "must be at least the prebuffer + 100 ms";
    else cfg.inproc_splice_ms = Math.min(3000, cfg.inproc_prebuffer_ms + 100);
  }
  return { cfg, errors };
}

/** The settings now (sync; defaults until init() ran). */
const current = () => ({ v: CFG.v, cfg: { ...CFG.cfg } });
const jitterMs = () => CFG.cfg.jitter_ms;

/** For Pepe's room-audio post answer (bridge.js): the settings when his version (acfg_v) isn't ours. */
function forBot(body) {
  if (!loaded) { init().catch(() => {}); return {}; }
  const have = body && body.acfg_v != null ? Number(body.acfg_v) : null;
  return have === CFG.v ? {} : { audio_cfg: current() };
}

function diff(a, b) {
  const out = {};
  for (const k of Object.keys(FIELDS)) if (a[k] !== b[k]) out[k] = [a[k], b[k]];
  return out;
}

/** Store a validated cfg as the next version + one admin_audit row (one transaction). -> {v, cfg, changed} */
async function store(admin, cfg, { action = "save", reason = null } = {}) {
  await init();
  await require("./adminaudit").init();
  const before = { ...CFG.cfg };
  const changed = diff(before, cfg);
  const t = NOW();
  const by = String(admin.username || admin.userId || "?").slice(0, 80);
  const v = await tx(async () => {
    const row = (await getQuery("SELECT v FROM room_audio_cfg WHERE id = 1"))[0];
    const next = (row ? Number(row.v) || 0 : CFG.v) + 1;
    await runQuery(`INSERT INTO room_audio_cfg (id, v, data, updated_at, updated_by) VALUES (1, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET v = excluded.v, data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
                    [next, JSON.stringify(cfg), t, by]);
    await require("./adminaudit").record(admin, AUDIT, null, { action, v: next, changed, to: cfg }, reason);
    return next;
  });
  CFG = { v, cfg: { ...cfg }, at: t, by };
  return { v, cfg: { ...cfg }, changed };
}

/** An admin's save (partial or full) or reset. Strict validation; nothing changes on any error. */
async function save(user, body = {}) {
  await init();
  if (!user || user.class !== "Admin") throw new Refuse(403, "Admins only.");
  const key = String(user.userId || user.username || "").toLowerCase();
  if (hits.blocked(key)) throw new Refuse(429, `Slow down - at most ${RATE.max} changes a minute.`);
  hits.hit(key);
  const reset = body.reset === true;
  let cfg;
  if (reset) cfg = { ...DEFAULTS };
  else {
    const r = normalize(body.cfg, { base: CFG.cfg });
    if (Object.keys(r.errors).length) {
      const first = Object.entries(r.errors)[0];
      throw new Refuse(400, `${first[0]}: ${first[1]}`, r.errors);
    }
    cfg = r.cfg;
  }
  if (!Object.keys(diff(CFG.cfg, cfg)).length && CFG.v > 0) return { v: CFG.v, cfg: { ...CFG.cfg }, changed: {}, same: true };
  return store(user, cfg, { action: reset ? "reset" : "save", reason: body.reason ? String(body.reason).slice(0, 200) : null });
}

/** Pepe's !audiostats latency <s> (bot token): one key, written through, audited as Pepe on behalf of the chat admin. */
async function botSet(body = {}) {
  await init();
  if (String(body.key || "") !== "mixer_latency_s") throw new Refuse(400, "only mixer_latency_s can be set from chat");
  const r = normalize({ mixer_latency_s: body.value }, { base: CFG.cfg });
  if (r.errors.mixer_latency_s) throw new Refuse(400, `mixer_latency_s: ${r.errors.mixer_latency_s}`);
  const nick = String(body.by || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 60) || "?";
  if (r.cfg.mixer_latency_s === CFG.cfg.mixer_latency_s && CFG.v > 0) return current();
  await store({ userId: "pepe", username: `Pepe (!audiostats, ${nick})` }, r.cfg, { action: "chat" });
  return current();
}

// ── Pepe's state push (display only) ──
const str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
function cleanState(s) {
  if (!s || typeof s !== "object") return null;
  const rooms = {};
  const src = s.rooms && typeof s.rooms === "object" ? s.rooms : {};
  for (const [room, r] of Object.entries(src).slice(0, 30)) {
    if (!r || typeof r !== "object" || !str(room, 128)) continue;
    const rtc = r.rtc && typeof r.rtc === "object" ? {
      state: str(r.rtc.state, 20), pacing: str(r.rtc.pacing, 20), buffer_ms: num(r.rtc.buffer_ms), target_ms: num(r.rtc.target_ms),
      restarts: num(r.rtc.restarts), underruns: num(r.rtc.underruns), trimmed_ms: num(r.rtc.trimmed_ms), opus_kbps: num(r.rtc.opus_kbps),
      up_s: num(r.rtc.up_s) } : null;
    rooms[str(room, 128)] = { streaming: !!r.streaming, mp3_listeners: num(r.mp3_listeners), rtc, mixer_latency_s: num(r.mixer_latency_s),
      stats: r.stats ? str(r.stats, 600) : null, stats_at: Number(r.stats_at) > 0 ? Math.round(Number(r.stats_at) * 1000) : null };
  }
  return { v: s.v == null ? null : Number(s.v) || 0, src: str(s.src, 20), cfg: s.cfg && typeof s.cfg === "object" ? normalize(s.cfg, { lenient: true }).cfg : null,
           helper_enabled: s.helper_enabled !== false, net_audio: !!s.net_audio, rooms };
}

async function setBotState(raw) {
  await init();
  const data = cleanState(raw);
  if (!data) return false;
  const json = JSON.stringify(data);
  if (json.length > STATE_MAX) return false;
  BOT = { at: NOW(), data };
  await runQuery("INSERT INTO room_audio_state (id, at, data) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at, data = excluded.data",
                 [BOT.at, json]);
  return true;
}

async function view() {
  await init();
  const t = NOW();
  let audit = [];
  try { audit = await require("./adminaudit").recent(AUDIT, 15); } catch (e) { audit = []; }
  return { now: t, v: CFG.v, cfg: { ...CFG.cfg }, defaults: { ...DEFAULTS }, fields: FIELDS, updated_at: CFG.at, updated_by: CFG.by,
           online: !!(BOT && t - BOT.at < ONLINE_MS), bot_at: BOT ? BOT.at : null, bot: BOT ? BOT.data : null, audit };
}

function register(app, { isBotToken, addUser }) {
  init().catch((e) => console.error("[roomaudiocfg] init:", e.message));
  const admin = (json) => (req, res, next) => {
    if (!req.user || !req.user.userId) return json ? res.status(401).json({ ok: false, error: "Sign in first." }) : res.redirect("/login?next=/admin/pepe/audio");
    if (req.user.class !== "Admin") return json ? res.status(403).json({ ok: false, error: "Admins only." }) : res.status(403).send("Admins only.");
    next();
  };
  const fetchOnly = (req, res, next) => (guard.sameSite(req) && req.get("X-Requested-With") === "fetch"
    ? next() : res.status(403).json({ ok: false, error: "Security check failed - reload the page." }));
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status).json({ ok: false, error: e.message, fields: e.fields || undefined });
    console.error("[roomaudiocfg]", e);
    res.status(500).json({ ok: false, error: "Something went wrong - nothing was changed." });
  };
  const bot = (req) => isBotToken(String((req.body || {}).password || req.get("x-bot-token") || ""));

  app.post("/api/pepe/audio/state", async (req, res) => {
    if (!bot(req)) return res.status(403).json({ error: "unauthorized" });
    try {
      const ok = await setBotState((req.body || {}).state);
      const st = (req.body || {}).state || {};
      res.json({ ok, ...forBot({ acfg_v: st.src === "site" ? st.v : null }) });
    } catch (e) { console.error("[roomaudiocfg] state:", e.message); res.status(500).json({ ok: false }); }
  });
  app.post("/api/pepe/audio/set", async (req, res) => {
    if (!bot(req)) return res.status(403).json({ error: "unauthorized" });
    try { res.json({ ok: true, audio_cfg: await botSet(req.body || {}) }); } catch (e) { fail(res, e); }
  });
  app.get("/admin/pepe/audio", addUser, admin(false), async (req, res) => {
    try {
      res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
      res.render("admin/pepeAudio", { user: req.user.username, title: "Admin · Room audio", section: "pepe", isAdmin: true, v: await view() });
    } catch (e) { console.error("[roomaudiocfg] page:", e); res.status(500).send("Couldn't load the page."); }
  });
  app.get("/api/admin/pepe/audio", addUser, admin(true), async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, ...(await view()) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/pepe/audio", addUser, admin(true), fetchOnly, async (req, res) => {
    try { const r = await save(req.user, req.body || {}); res.json({ ok: true, ...r, view: await view() }); } catch (e) { fail(res, e); }
  });
}

module.exports = { register, init, normalize, current, jitterMs, forBot, save, botSet, setBotState, cleanState, view, FIELDS, DEFAULTS,
  _setClock, _reset: () => { CFG = { v: 0, cfg: { ...DEFAULTS }, at: null, by: null }; BOT = null; ready = null; loaded = false; } };
