// livecam.js — 📡 live cams on the pads (1.99yh): a signed-in viewer presses "▶ Live" on someone's cam in the pad's live
// room and watches it live over WebRTC (WHEP through MediaMTX), about a second behind the room. The still preview
// (bridge-relay.js snapshots) is unchanged; a live cam only starts when a viewer explicitly asks for it.
//
//   Pepe     opens the cam in Camfrog (like a snapshot), grabs its window in a helper process and publishes it -> ffmpeg
//            (H.264) -> WHIP -> ONE MediaMTX path per cam, only while the site wants it (camfrog-bot pepe_livecam.py).
//            He polls POST /api/bridge/livecam (~1 s while anything is live / wanted): his state in, the wanted cams out.
//   viewer   POST /api/rooms/<slug>/livecam {login} -> a 2-minute read ticket on the cam's WHEP URL (?pt=) -> WHEP. The
//            MediaMTX auth hook (webrtc.js -> auth() here) checks the ticket, that the viewer still holds a slot on that
//            cam and may still see the pad's live room (padaccess.full). The page beats every 15 s
//            (/livecam/beat); a slot not beaten for BEAT_MS is gone. ✕ = /livecam/stop (the slot is free at once).
//
// Who may watch: a signed-in PATV account (never signed out) that may see the pad's live room (padaccess.full - the same
// rule as the room audio; 18+ pads are signed-in anyway). Never the cam of Pepe himself, of someone off cam, private
// (!bridge hide / !incognito: Pepe shows them as "someone", so no login reaches the page), keeping their room activity
// private (Settings → Privacy → analytics) or opted out of live video (livecam_optout: /settings/privacy or !livecam off
// in Camfrog - one home, this table; Pepe's command writes through his poll; 1.99yq: it covers snapshots and clips too), or
// blocked by the owner (camviewers.js: !blockviewer / the privacy card - "isn't available", a block ends their stream at
// once). Every new viewer is noted (camviewers.noteView) and Pepe PMs the owner (the notices ride this poll: cv_notify).
// Caps: viewers_free (1) live cams at once per account, viewers_sp (4) with a Season Pass (premium.hasPass); every cam
// stream is the same kbps, so the site-wide viewer cap is budget_mbps / kbps; max_live cams publishing at once; Pepe's
// own pool (the cams his Camfrog keeps open) answers "slots_busy" when it can't make room.
//
// Settings (one home: /admin/pepe/livecams, admins; table livecam_cfg, versioned + admin_audit like room audio):
//   enabled (kill switch; default ON on staging, OFF on prod until an admin flips it), close_idle (Pepe closes cams
//   nobody used for idle_close_s; same defaults), fps, kbps, keyint_s, max_live, pool_max, viewers_free, viewers_sp,
//   budget_mbps, idle_close_s, linger_s (a cam keeps publishing this long after its last viewer), close_method,
//   ui_budget_ms. Per room: Pepe's `!bridge livecams on|off` (default on, needs !bridge cams on) -> R.livecams.
// Ending a relay: the cam owner (their linked login), the room's mods (Pepe's mod caps for their login), the pad owner and
// site staff can end it (POST /livecam/end): everyone watching is dropped and it can't restart for END_COOLDOWN_MS.
// Audit: livecam_audit, one row per viewer session (viewer, target, room, start, end, seconds, why it ended). Video is
// never stored anywhere (MediaMTX records nothing; the HLS remux of these paths is refused by the hook).
//
// 1.99zc: 🎬 STAGE CAMS (mainstage.js slot source 'cam'): a pad owner / admin puts someone's live cam on the pad's stage.
// The slot HOLDS the session (S.stage = slot id): it stays wanted while the slot is open (never ended as "unwatched"), with
// the same consent rules as a viewer's ▶ Live (on cam, not opted out, not private, not ended by them, the room's switch).
// Stage viewers ask for a ticket of their own (stageWatch: signed in + padaccess.full, inside the bandwidth budget) and beat
// like a viewer; they are counted in the site-wide budget but never in anyone's personal live-cam slots. One publish by
// Pepe serves the strip, the popover and the stage alike. When the session ends (opt-out, cam closed, ended by the owner /
// a mod / staff) stageState says so and mainstage ends the slot.
//
// Path names share the room-audio family on MediaMTX (deploy/webrtc/mediamtx.yml "~^(room|stgr)-[0-9a-f]{16}$"), so no
// MediaMTX change is needed: prod "room-<16 hex>", staging "stgr-<16 hex>", an HMAC of "live-cam-path:<room>|<login>"
// that never collides with a room's audio path (different HMAC input). webrtc.js asks camForPath first.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery, tx } = require("./dbUtils");
const guard = require("./middleware/authGuard");

const STAGING = !!process.env.STAGING;
const PREFIX = STAGING ? "stgr-" : "room-";
const PATH_RE = /^(room|stgr)-[0-9a-f]{16}$/;
const LOGIN_RE = /^[\w.\-$]{1,40}$/;
const SECRET = process.env.SECRET_KEY || crypto.randomBytes(32).toString("hex");
const TICKET_MS = 2 * 60 * 1000;
const BEAT_MS = 45 * 1000;              // a viewer slot lives this long after its last beat (the page beats every 15 s)
const BOT_FRESH_MS = 20 * 1000;         // Pepe's poll within this long = he can do live cams
const START_MS = 40 * 1000;             // a wanted cam Pepe hasn't reported live within this long -> "Pepe couldn't open it"
const END_COOLDOWN_MS = 10 * 60 * 1000; // after an owner / mod / admin ends a relay
const SYNC_FRESH_MS = 15 * 1000;
const AUDIT = "livecam_cfg";

const FIELDS = Object.freeze({
  enabled:      { def: STAGING, bool: true },
  close_idle:   { def: STAGING, bool: true },
  fps:          { def: 15, min: 5, max: 30 },
  kbps:         { def: 300, min: 80, max: 2000 },
  keyint_s:     { def: 1, min: 0.5, max: 4, step: 0.5 },
  max_live:     { def: 4, min: 0, max: 24 },
  pool_max:     { def: 6, min: 1, max: 24 },
  viewers_free: { def: 1, min: 0, max: 8 },
  viewers_sp:   { def: 4, min: 0, max: 8 },
  budget_mbps:  { def: 100, min: 1, max: 10000 },
  idle_close_s: { def: 300, min: 30, max: 3600 },
  linger_s:     { def: 20, min: 5, max: 300 },
  close_method: { def: "wmclose", choices: ["wmclose", "button", "off"] },
  capture:      { def: "blt", choices: ["blt", "pw2"] },   // how Pepe reads a cam's window (blt: no Camfrog UI-thread cost)
  ui_budget_ms: { def: 300, min: 50, max: 800 },
  // 1.99yr: where Pepe's video comes from (bot 1.99yp-1.99zw pepe_livecam_pt.py): reencode = grab the cam window + x264 /
  // passthrough = forward Camfrog's own H.264 untouched (native 30 fps, no encode) / auto = pass-through when Pepe can.
  // Pass-through falls back to re-encode by itself after pt_fallback_s without video. Prod default: reencode.
  source:        { def: STAGING ? "auto" : "reencode", choices: ["reencode", "passthrough", "auto"] },
  pt_fallback_s: { def: 6, min: 2, max: 30 },
});
const DEFAULTS = Object.freeze(Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, f.def])));
const BOT_KEYS = ["enabled", "close_idle", "fps", "kbps", "keyint_s", "max_live", "pool_max", "idle_close_s", "close_method", "ui_budget_ms", "capture",
  "source", "pt_fallback_s"];

let clock = () => Date.now();
const now = () => clock();
const W = () => require("./webrtc");
const bridgeRooms = () => { try { return require("./bridge")._rooms; } catch (e) { return new Map(); } };
const CV = () => require("./camviewers");     // 1.99yq: who's watching + blocks
const isGhost = (uid) => { try { return require("./ghost").isGhost(uid); } catch (e) { return false; } };   // 1.99aaf: 👻 staff ghost mode
/** 1.99aaf: the viewers anyone may be told about (a ghost is never counted where people see it; budgets still count them). */
const shownCount = (list) => list.filter(([, v]) => !v.ghost).length;

class Refuse extends Error { constructor(status, msg, code, extra) { super(msg); this.status = status; this.refuse = true; this.code = code; this.extra = extra || null; } }

// ── settings ──
let CFG = { v: 0, cfg: { ...DEFAULTS }, at: null, by: null };
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS livecam_cfg (id INTEGER PRIMARY KEY CHECK (id = 1), v INTEGER NOT NULL, data TEXT NOT NULL,
                      updated_at INTEGER, updated_by TEXT)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS livecam_optout (login TEXT PRIMARY KEY, off INTEGER NOT NULL, updated INTEGER NOT NULL,
                      via TEXT, user_id TEXT)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS livecam_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, target TEXT NOT NULL,
                      viewer_id TEXT NOT NULL, viewer_name TEXT, started INTEGER NOT NULL, ended INTEGER, secs INTEGER, end_reason TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS livecam_audit_started ON livecam_audit (started)");
      const acols = (await getQuery("PRAGMA table_info(livecam_audit)")).map((c) => c.name);   // 1.99aaf: 👻 ghost views are audited too
      if (!acols.includes("ghost")) await runQuery("ALTER TABLE livecam_audit ADD COLUMN ghost INTEGER NOT NULL DEFAULT 0");
      const r = (await getQuery("SELECT v, data, updated_at, updated_by FROM livecam_cfg WHERE id = 1"))[0];
      if (r) {
        let d = {};
        try { d = JSON.parse(r.data) || {}; } catch (e) { d = {}; }
        CFG = { v: Number(r.v) || 0, cfg: normalize(d, { lenient: true }).cfg, at: r.updated_at || null, by: r.updated_by || null };
      }
      await loadOptouts();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

function normalize(input, { base = DEFAULTS, lenient = false } = {}) {
  const src = input && typeof input === "object" ? input : {};
  const cfg = {}, errors = {};
  for (const [k, f] of Object.entries(FIELDS)) {
    const has = Object.prototype.hasOwnProperty.call(src, k) && src[k] !== "" && src[k] != null;
    const raw = has ? src[k] : (base && base[k] != null ? base[k] : f.def);
    if (f.bool) {
      if (typeof raw === "boolean") cfg[k] = raw;
      else if (raw === "true" || raw === "on" || raw === 1 || raw === "1") cfg[k] = true;
      else if (raw === "false" || raw === "off" || raw === 0 || raw === "0") cfg[k] = false;
      else { cfg[k] = f.def; if (!lenient) errors[k] = "on or off"; }
      continue;
    }
    if (f.choices) {
      const v = String(raw).trim().toLowerCase();
      if (f.choices.includes(v)) cfg[k] = v;
      else { cfg[k] = f.def; if (!lenient) errors[k] = `one of ${f.choices.join(", ")}`; }
      continue;
    }
    const n = typeof raw === "number" ? raw : (typeof raw === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(raw) ? Number(raw) : NaN);
    if (!Number.isFinite(n)) { cfg[k] = f.def; if (!lenient) errors[k] = "a number"; continue; }
    if (n < f.min || n > f.max) { if (!lenient) errors[k] = `${f.min}–${f.max}`; cfg[k] = Math.max(f.min, Math.min(f.max, n)); } else cfg[k] = n;
    cfg[k] = f.step ? Math.round(cfg[k] / f.step) * f.step : Math.round(cfg[k]);
  }
  return { cfg, errors };
}
const cfg = () => CFG.cfg;
const current = () => ({ v: CFG.v, cfg: { ...CFG.cfg } });
/** Viewers the bandwidth budget allows site-wide (every cam stream is cfg.kbps). */
const viewerCap = (c = cfg()) => Math.max(0, Math.floor((c.budget_mbps * 1000) / Math.max(1, c.kbps)));
const on = () => cfg().enabled === true && W().enabled();

function diff(a, b) { const out = {}; for (const k of Object.keys(FIELDS)) if (a[k] !== b[k]) out[k] = [a[k], b[k]]; return out; }
const hits = guard.limiter({ max: 20, windowMs: 60 * 1000 });
async function save(user, body = {}) {
  await init();
  if (!user || user.class !== "Admin") throw new Refuse(403, "Admins only.");
  const key = String(user.userId || user.username || "").toLowerCase();
  if (hits.blocked(key)) throw new Refuse(429, "Slow down - at most 20 changes a minute.");
  hits.hit(key);
  const reset = body.reset === true;
  let next;
  if (reset) next = { ...DEFAULTS };
  else {
    const r = normalize(body.cfg, { base: CFG.cfg });
    if (Object.keys(r.errors).length) { const f = Object.entries(r.errors)[0]; throw new Refuse(400, `${f[0]}: ${f[1]}`, "bad", { fields: r.errors }); }
    next = r.cfg;
  }
  const changed = diff(CFG.cfg, next);
  if (!Object.keys(changed).length && CFG.v > 0) return { v: CFG.v, cfg: { ...CFG.cfg }, changed: {}, same: true };
  await require("./adminaudit").init();
  const t = now(), by = String(user.username || user.userId || "?").slice(0, 80);
  const v = await tx(async () => {
    const row = (await getQuery("SELECT v FROM livecam_cfg WHERE id = 1"))[0];
    const nv = (row ? Number(row.v) || 0 : CFG.v) + 1;
    await runQuery(`INSERT INTO livecam_cfg (id, v, data, updated_at, updated_by) VALUES (1, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET v = excluded.v, data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
                   [nv, JSON.stringify(next), t, by]);
    await require("./adminaudit").record(user, AUDIT, null, { action: reset ? "reset" : "save", v: nv, changed, to: next },
      body.reason ? String(body.reason).slice(0, 200) : null);
    return nv;
  });
  CFG = { v, cfg: { ...next }, at: t, by };
  if (!next.enabled) for (const S of [...SESS.values()]) endSession(S, "switched_off");
  return { v, cfg: { ...next }, changed };
}

// ── opt-outs (one home: this table) ──
let OPTOUT = new Set();
async function loadOptouts() {
  OPTOUT = new Set((await getQuery("SELECT login FROM livecam_optout WHERE off = 1")).map((r) => String(r.login).toLowerCase()));
}
const optedOut = (login) => OPTOUT.has(String(login || "").toLowerCase());
/** Store an opt-out change (the website toggle or Pepe's !livecam). Newer wins; an off ends every relay of that login. */
async function setOptout(login, off, { via = "web", userId = null, ts = now() } = {}) {
  await init();
  const l = String(login || "").toLowerCase();
  if (!LOGIN_RE.test(l)) return false;
  const cur = (await getQuery("SELECT updated FROM livecam_optout WHERE login = ?", [l]))[0];
  if (cur && Number(cur.updated) > ts) return false;
  await runQuery(`INSERT INTO livecam_optout (login, off, updated, via, user_id) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(login) DO UPDATE SET off = excluded.off, updated = excluded.updated, via = excluded.via, user_id = COALESCE(excluded.user_id, livecam_optout.user_id)`,
                 [l, off ? 1 : 0, ts, via === "chat" ? "chat" : "web", userId]);
  if (off) { OPTOUT.add(l); for (const S of [...SESS.values()]) if (S.login === l) endSession(S, "opted_out"); }
  else OPTOUT.delete(l);
  return true;
}
async function optoutState(userId) {
  await init();
  const r = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [String(userId)]))[0];
  const login = r && r.camfrogUsername ? String(r.camfrogUsername).toLowerCase() : null;
  if (!login || !LOGIN_RE.test(login)) return { linked: false, login: null, off: false, updated: null, via: null };
  const s = (await getQuery("SELECT off, updated, via FROM livecam_optout WHERE login = ?", [login]))[0];
  return { linked: true, login, off: !!(s && s.off), updated: s ? Number(s.updated) : null, via: s ? s.via : null };
}

// ── names + secrets ──
function pathFor(roomId, login) {
  return PREFIX + crypto.createHmac("sha256", SECRET).update("live-cam-path:" + String(roomId) + "|" + String(login).toLowerCase()).digest("hex").slice(0, 16);
}
function pubKey(p) {
  const v = String(process.env.LIVECAM_KEY_VERSION || "1").trim();
  if (!v || v === "off") return null;
  return "lp" + crypto.createHmac("sha256", SECRET).update("live-cam-pub:" + p + ":" + v).digest("base64url").slice(0, 40);
}
function sameSecret(got, want) {
  if (!want) return false;
  const a = crypto.createHash("sha256").update(String(got)).digest(), b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}
const b64 = (s) => Buffer.from(String(s)).toString("base64url");
const unb64 = (s) => { try { return Buffer.from(String(s), "base64url").toString("utf8"); } catch (e) { return ""; } };
const sign = (body, p) => crypto.createHmac("sha256", SECRET).update("live-cam-read:" + body + "|" + p).digest("base64url").slice(0, 32);
function readTicket(userId, p, t = now()) {
  const body = "lc1." + (t + TICKET_MS) + "." + b64(userId);
  return body + "." + sign(body, p);
}
function checkTicket(tok, p, t = now()) {
  const m = /^lc1\.(\d{10,16})\.([A-Za-z0-9_-]{1,120})\.([A-Za-z0-9_-]{32})$/.exec(String(tok || ""));
  if (!m || Number(m[1]) < t) return null;
  const want = sign("lc1." + m[1] + "." + m[2], p);
  const a = Buffer.from(m[3]), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const uid = unb64(m[2]);
  return uid ? { uid } : null;
}

// ── sessions: one per (room, cam) ──
const SESS = new Map();        // "<room>|<login>" -> session
const BY_PATH = new Map();     // path -> key
const COOL = new Map();        // key -> until (ended by owner / mod / admin)
let BOT = null;                // {at, pool, live, refused}
const keyOf = (roomId, login) => String(roomId) + "|" + String(login).toLowerCase();
function camForPath(p) {
  if (!PATH_RE.test(String(p || "")) || !String(p).startsWith(PREFIX)) return null;
  const k = BY_PATH.get(p);
  return k ? SESS.get(k) || null : null;
}
const freshViewers = (S, t = now()) => [...S.viewers.entries()].filter(([, v]) => t - v.beat <= BEAT_MS);
function slotsOf(userId, t = now()) {
  let n = 0;
  for (const S of SESS.values()) if (!S.ended) { const v = S.viewers.get(String(userId)); if (v && t - v.beat <= BEAT_MS) n++; }
  return n;
}
const freshStage = (S, t = now()) => (S.stageViewers ? [...S.stageViewers.entries()].filter(([, v]) => t - v.beat <= BEAT_MS) : []);
function totalViewers(t = now()) { let n = 0; for (const S of SESS.values()) if (!S.ended) n += freshViewers(S, t).length + freshStage(S, t).length; return n; }
// 1.99aab: each relay counts at its REAL bitrate - a pass-through cam at what Pepe measures coming in (a rolling average of
// the broadcaster's own stream, ~20-60 kbit/s), a re-encoded one (or one Pepe hasn't reported yet) at cfg.kbps.
const MIN_KBPS = 16;
function rateOf(S, c = cfg()) {
  const b = S && S.botInfo;
  const k = b && b.source === "passthrough" ? Number(b.kbps) : NaN;
  return Number.isFinite(k) && k > 0 ? Math.max(MIN_KBPS, Math.min(4000, k)) : c.kbps;
}
/** kbit/s going out to viewers site-wide right now (every fresh viewer x their cam's rate). */
function usedKbps(t = now(), c = cfg()) {
  let k = 0;
  for (const S of SESS.values()) if (!S.ended) k += (freshViewers(S, t).length + freshStage(S, t).length) * rateOf(S, c);
  return k;
}
/** One more viewer of S (null = a cam not relayed yet, counted at cfg.kbps) fits the bandwidth budget? */
const fitsBudget = (S, t = now(), c = cfg()) => usedKbps(t, c) + rateOf(S, c) <= c.budget_mbps * 1000;
const liveCount = () => [...SESS.values()].filter((S) => !S.ended).length;

function audit(S, userId, v, why, t = now()) {
  if (!v || !v.auditId) return;
  const id = v.auditId;
  v.auditId = null;
  runQuery("UPDATE livecam_audit SET ended = ?, secs = ?, end_reason = ? WHERE id = ? AND ended IS NULL",
           [t, Math.max(0, Math.round((t - v.since) / 1000)), String(why).slice(0, 40), id]).catch((e) => console.error("[livecam] audit:", e.message));
}
function dropViewer(S, userId, why, t = now()) {
  const v = S.viewers.get(String(userId));
  if (!v) return false;
  S.viewers.delete(String(userId));
  audit(S, userId, v, why, t);
  for (const rid of v.readers || []) kickReader(rid);
  if (!freshViewers(S, t).length) S.wantUntil = Math.min(S.wantUntil || Infinity, t + cfg().linger_s * 1000);
  return true;
}
function endSession(S, why, t = now()) {
  if (!S || S.ended) return;
  S.ended = t;
  S.endWhy = why;
  if (S.stage) S.lastStage = S.stage;      // 1.99zc: the stage slot reads why it ended (stageState)
  for (const uid of [...S.viewers.keys()]) dropViewer(S, uid, why, t);
  if (S.stageViewers) { for (const v of S.stageViewers.values()) for (const rid of v.readers || []) kickReader(rid); S.stageViewers.clear(); }
  S.wantUntil = 0;
  if (S.sourceId) kickReader(S.sourceId);
  console.log(`[livecam] end room=${S.roomId} target=${S.login} why=${why}`);
}
function sweep(t = now()) {
  for (const S of [...SESS.values()]) {
    if (!S.ended) {
      for (const [uid, v] of [...S.viewers.entries()]) if (t - v.beat > BEAT_MS) dropViewer(S, uid, "gone", t);
      if (S.stageViewers) for (const [uid, v] of [...S.stageViewers.entries()]) if (t - v.beat > BEAT_MS) { S.stageViewers.delete(uid); for (const rid of v.readers || []) kickReader(rid); }
      if (S.stage) S.wantUntil = Math.max(S.wantUntil || 0, t + cfg().linger_s * 1000);   // 1.99zc: held by a stage slot
      if (!S.viewers.size && !S.stage && S.wantUntil && S.wantUntil < t) endSession(S, "unwatched", t);
      else if (!S.liveAt && t - S.createdAt > START_MS) endSession(S, S.botWhy || "start_timeout", t);
    }
    if (S.ended && t - S.ended > 60 * 1000) { SESS.delete(S.key); if (BY_PATH.get(S.path) === S.key) BY_PATH.delete(S.path); }
  }
  for (const [k, until] of COOL) if (until < t) COOL.delete(k);
}
let kickImpl = (id) => {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ""))) return;
  const http = require("http");
  const api = String(process.env.MEDIAMTX_API || "http://127.0.0.1:9997").replace(/\/+$/, "");
  for (const p of ["/v3/webrtcsessions/kick/", "/v3/webrtc/sessions/kick/"]) {
    try {
      const u = new URL(api + p + id);
      const req = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname, method: "POST", timeout: 3000 }, (r) => r.resume());
      req.on("error", () => {}); req.on("timeout", () => req.destroy());
      req.end();
    } catch (e) { /* no MediaMTX */ }
  }
};
function kickReader(id) { try { kickImpl(id); } catch (e) { /* best effort */ } }

// ── who may watch ──
const CODES = {
  signin: [401, "Sign in to watch cams live."],
  off: [404, "Live cams aren't switched on right now."],
  offline: [404, "That Camfrog room isn't live right now."],
  room_off: [403, "Live cams aren't on in this Camfrog room."],
  pad_access: [403, "This pad's live room is for its approved members."],
  not_on_cam: [400, "They aren't on cam."],
  opted_out: [403, "They've switched their cam off for the website."],
  unavailable: [403, "That cam isn't available right now."],     // 1.99yq: the owner blocked this viewer (camviewers.js) - said neutrally
  ended_by: [403, "Their live cam was ended - try again in a few minutes."],
  nopepe: [503, "Pepe can't do live cams right now."],
  viewer_cap: [429, "You're already watching as many live cams as you can."],
  budget: [503, "Live cams are full right now - try again in a bit."],
  slots_busy: [503, "All live cam slots are busy - try again in a bit."],
};
const refuse = (code, extra) => new Refuse(CODES[code][0], CODES[code][1], code, extra);
const isStaff = (u) => !!u && (u.class === "Admin" || u.class === "Staff");
const passOf = (userId) => { try { return !!require("./premium").hasPass(userId); } catch (e) { return false; } };
const maxSlots = (userId) => (passOf(userId) ? cfg().viewers_sp : cfg().viewers_free);
const botOk = (t = now()) => !!(BOT && t - BOT.at < BOT_FRESH_MS);

/** The member R lists for `login` (on cam, a real login - never Pepe, never "someone"). */
function memberOf(R, login) {
  return (R.members || []).find((x) => x && !x.anon && !x.self && String(x.login || "").toLowerCase() === login) || null;
}

/**
 * A viewer asks to watch `login`'s cam in room R. The caller checked R is live with cams on.
 * -> {ok, whep, key, state, slots: {used, max}, kbps} | throws Refuse
 */
async function start(u, R, login, t = now()) {
  await init();
  if (!u || !u.userId) throw refuse("signin");
  if (!on()) throw refuse("off");
  if (R.livecams === false) throw refuse("room_off");
  if (!(await require("./bridge-relay").padFull(u.userId, R.id))) throw refuse("pad_access");
  login = String(login || "").toLowerCase();
  const m = LOGIN_RE.test(login) ? memberOf(R, login) : null;
  if (!m || !m.on_cam) throw refuse("not_on_cam");
  if (optedOut(login)) throw refuse("opted_out");
  try { if ((await require("./stories").privateLogins([login])).has(login)) throw refuse("opted_out"); } catch (e) { if (e.refuse) throw e; }
  if (CV().blocked(login, u.userId)) throw refuse("unavailable");          // 1.99yq: !blockviewer / the privacy card
  const k = keyOf(R.id, login);
  if ((COOL.get(k) || 0) > t) throw refuse("ended_by");
  if (!botOk(t)) throw refuse("nopepe");
  let S = SESS.get(k);
  if (S && S.ended) { SESS.delete(k); S = null; }
  const uid = String(u.userId);
  const mine = S && S.viewers.get(uid);
  const used = slotsOf(uid, t), max = maxSlots(uid);
  if (!mine || t - mine.beat > BEAT_MS) {
    if (used >= max) throw refuse("viewer_cap", { slots: { used, max } });
    if (!fitsBudget(S, t)) throw refuse("budget");
    if (!S && liveCount() >= cfg().max_live) throw refuse("slots_busy");
  }
  if (!S) {
    const p = pathFor(R.id, login);
    S = { key: k, roomId: R.id, login, display: m.display || login, path: p, viewers: new Map(), createdAt: t, wantUntil: t + cfg().linger_s * 1000,
          liveAt: 0, ready: false, readers: 0, seenAt: 0, sourceId: null, botState: null, botWhy: null, ended: 0, endWhy: null, stage: null, stageViewers: new Map() };
    SESS.set(k, S);
    BY_PATH.set(p, k);
    console.log(`[livecam] start room=${R.id} target=${login} viewer=${u.username || uid}`);
  }
  let v = S.viewers.get(uid);
  if (!v) {
    v = { since: t, beat: t, username: u.username || null, readers: new Set(), auditId: null, ghost: isGhost(uid) };
    S.viewers.set(uid, v);
    try {
      const r = await runQuery("INSERT INTO livecam_audit (room_id, target, viewer_id, viewer_name, started, ghost) VALUES (?, ?, ?, ?, ?, ?)",
                               [R.id, login, uid, u.username || null, t, v.ghost ? 1 : 0]);
      v.auditId = r && r.id ? Number(r.id) : null;
    } catch (e) { console.error("[livecam] audit:", e.message); }
  }
  v.beat = t;
  S.wantUntil = Math.max(S.wantUntil, t + cfg().linger_s * 1000);
  return { ok: true, key: k, whep: W().whepUrl(S.path) + "?pt=" + encodeURIComponent(readTicket(uid, S.path, t)), state: stateOf(S, t),
           slots: { used: slotsOf(uid, t), max }, kbps: rateOf(S), expires: t + TICKET_MS };
}
function stateOf(S, t = now()) {
  if (!S) return "none";
  if (S.ended) return "ended";
  return S.ready && t - S.seenAt <= SYNC_FRESH_MS ? "live" : "connecting";
}
/** The page's beat: keeps the slot. -> {state, why, viewers} */
function beat(userId, roomId, login, t = now()) {
  const S = SESS.get(keyOf(roomId, login));
  if (!S) return { ok: true, state: "ended", why: "unwatched" };
  if (S.ended) return { ok: true, state: "ended", why: S.endWhy || "ended" };
  const v = S.viewers.get(String(userId));
  if (!v || t - v.beat > BEAT_MS) return { ok: true, state: "ended", why: "gone" };
  v.beat = t;
  S.wantUntil = Math.max(S.wantUntil, t + cfg().linger_s * 1000);
  return { ok: true, state: stateOf(S, t), viewers: shownCount(freshViewers(S, t)), botWhy: S.botWhy || null, ...(v.ghost ? { ghost: true } : {}) };
}
/** 1.99yq: the owner blocked this viewer - drop them from every live relay of the cam now (the reader is kicked). -> count */
function dropViewerOf(login, userId, why = "blocked", t = now()) {
  let n = 0;
  const l = String(login || "").toLowerCase();
  for (const S of SESS.values()) {
    if (S.ended || S.login !== l) continue;
    if (dropViewer(S, String(userId), why, t)) n++;
    const sv = S.stageViewers ? S.stageViewers.get(String(userId)) : null;          // 1.99zc: a stage viewer of that cam, too
    if (sv) { S.stageViewers.delete(String(userId)); for (const rid of sv.readers || []) kickReader(rid); n++; }
  }
  return n;
}
/** 1.99yq: who has `login`'s cam open live right now -> [{userId, username, room, since}] */
function watchersOf(login, t = now()) {
  const l = String(login || "").toLowerCase(), out = [];
  for (const S of SESS.values()) {
    if (S.ended || S.login !== l) continue;
    for (const [uid, v] of freshViewers(S, t)) out.push({ userId: uid, username: v.username, room: S.roomId, since: v.since, ghost: !!v.ghost });
    for (const [uid, v] of freshStage(S, t)) out.push({ userId: uid, username: v.username || null, room: S.roomId, since: v.since, stage: true, ghost: !!v.ghost });   // 1.99zc
  }
  return out;
}
function stop(userId, roomId, login, t = now()) {
  const S = SESS.get(keyOf(roomId, login));
  if (!S) return { ok: true };
  dropViewer(S, String(userId), "stopped", t);
  return { ok: true };
}
/** May `u` end this cam's relay? Its owner (linked login), the room's mods (Pepe's caps), the pad owner, site staff. */
function mayEnd(u, R, login) {
  if (!u) return false;
  if (isStaff(u)) return true;
  if (u.camfrogUsername && String(u.camfrogUsername).toLowerCase() === login) return true;
  try { if (u.camfrogUsername && require("./padmod").capsFor(R, u.camfrogUsername)) return true; } catch (e) { /* none */ }
  const r = require("./rooms").getCached ? require("./rooms").getCached(String(R.id)) : null;
  return !!(r && r.owner && r.owner.userId && String(r.owner.userId) === String(u.userId));
}
function endBy(u, R, login, t = now()) {
  login = String(login || "").toLowerCase();
  const k = keyOf(R.id, login);
  const S = SESS.get(k);
  COOL.set(k, t + END_COOLDOWN_MS);
  if (S) endSession(S, isStaff(u) && String(u.camfrogUsername || "").toLowerCase() !== login ? "ended_by_admin" : "ended_by", t);
  console.log(`[livecam] ended room=${R.id} target=${login} by=${u.username || u.userId}`);
  return { ok: true };
}

// ── 1.99zc: 🎬 stage cams (see the header) ──
/** May `login`'s cam in room R go on a stage right now? The same rules as a viewer's ▶ Live, minus the viewer's own. */
async function stageConsent(R, login, t = now()) {
  if (!on()) throw refuse("off");
  if (!R || !R.cams) throw refuse("room_off");
  if (R.livecams === false) throw refuse("room_off");
  login = String(login || "").toLowerCase();
  const m = LOGIN_RE.test(login) ? memberOf(R, login) : null;
  if (!m || !m.on_cam) throw refuse("not_on_cam");
  if (optedOut(login)) throw refuse("opted_out");
  try { if ((await require("./stories").privateLogins([login])).has(login)) throw refuse("opted_out"); } catch (e) { if (e.refuse) throw e; }
  if ((COOL.get(keyOf(R.id, login)) || 0) > t) throw refuse("ended_by");
  if (!botOk(t)) throw refuse("nopepe");
  return m;
}
/** A stage slot (mainstage, source 'cam') takes hold of `login`'s live cam in room R. -> {display} | throws Refuse */
async function stageHold(R, login, slotId, t = now()) {
  await init();
  login = String(login || "").toLowerCase();
  const m = await stageConsent(R, login, t);
  const k = keyOf(R.id, login);
  let S = SESS.get(k);
  if (S && S.ended) { SESS.delete(k); S = null; }
  if (S && S.stage && S.stage !== String(slotId)) throw new Refuse(409, "That cam is already on the stage.", "on_stage");
  if (!S && liveCount() >= cfg().max_live) throw refuse("slots_busy");
  if (!S) {
    const p = pathFor(R.id, login);
    S = { key: k, roomId: R.id, login, display: m.display || login, path: p, viewers: new Map(), createdAt: t, wantUntil: t + cfg().linger_s * 1000,
          liveAt: 0, ready: false, readers: 0, seenAt: 0, sourceId: null, botState: null, botWhy: null, ended: 0, endWhy: null, stage: null, stageViewers: new Map() };
    SESS.set(k, S);
    BY_PATH.set(p, k);
  }
  if (!S.stageViewers) S.stageViewers = new Map();
  S.stage = String(slotId);
  S.wantUntil = Math.max(S.wantUntil, t + cfg().linger_s * 1000);
  console.log(`[livecam] stage hold room=${R.id} target=${login} slot=${slotId}`);
  return { display: m.display || login };
}
const stageSess = (slotId) => { for (const S of SESS.values()) if (S.stage === String(slotId)) return S; return null; };
/** The slot ended / was cut: let go of the cam (viewers of the strip / popover keep watching). */
function stageRelease(slotId, t = now()) {
  for (const S of SESS.values()) {
    if (S.stage !== String(slotId)) continue;
    S.stage = null;
    for (const v of S.stageViewers.values()) for (const rid of v.readers || []) kickReader(rid);
    S.stageViewers.clear();
    if (!freshViewers(S, t).length) S.wantUntil = Math.min(S.wantUntil || Infinity, t + cfg().linger_s * 1000);
  }
}
/** -> {state: none | connecting | live | ended, why} for a stage slot's cam. */
function stageState(slotId, t = now()) {
  const S = stageSess(slotId);
  if (!S) {
    for (const X of SESS.values()) if (X.ended && X.lastStage === String(slotId)) return { state: "ended", why: X.endWhy || "ended" };
    return { state: "none", why: null };
  }
  if (S.ended) return { state: "ended", why: S.endWhy || "ended" };
  return { state: stateOf(S, t), why: S.botWhy || null, viewers: shownCount(freshStage(S, t)) };
}
/** A stage viewer asks to watch the cam on slot `slotId` (or beats). -> {ok, whep, state, beat_ms} | throws Refuse */
async function stageWatch(u, R, slotId, { beatOnly = false } = {}, t = now()) {
  await init();
  if (!u || !u.userId) throw refuse("signin");
  if (!on()) throw refuse("off");
  const S = stageSess(slotId);
  if (!S || S.ended || S.roomId !== R.id) throw new Refuse(404, "That cam isn't on the stage any more.", "gone");
  if (!(await require("./bridge-relay").padFull(u.userId, R.id))) throw refuse("pad_access");
  const uid = String(u.userId);
  if (CV().blocked(S.login, uid)) throw refuse("unavailable");          // 1.99yq rules: the owner blocked this viewer
  let v = S.stageViewers.get(uid);
  if (!v || t - v.beat > BEAT_MS) {
    if (beatOnly) return { ok: true, state: "ended", why: "gone" };
    if (!fitsBudget(S, t)) throw refuse("budget");
    v = { since: t, beat: t, username: u.username || null, readers: new Set(), ghost: isGhost(uid) };
    S.stageViewers.set(uid, v);
  }
  v.beat = t;
  if (beatOnly) return { ok: true, state: stateOf(S, t) };
  return { ok: true, whep: W().whepUrl(S.path) + "?pt=" + encodeURIComponent(readTicket(uid, S.path, t)), state: stateOf(S, t), expires: t + TICKET_MS };
}

// ── Pepe ──
const str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
const TERMINAL = new Set(["opted_out", "not_on_cam", "room_off", "slots_busy", "open_failed", "not_that_cam", "noswitch", "busy", "spawn_failed",
  "failed", "cam_closed"]);
/** Pepe's poll: his report in, the wanted cams + settings + opt-outs out. */
async function forBot(body, t = now()) {
  await init();
  body = body || {};
  sweep(t);
  BOT = { at: t, cap: body.cap === true, pool: body.pool && typeof body.pool === "object" ? body.pool : null, cfgFrom: str(body.cfg_from, 20) };
  for (const e of (Array.isArray(body.optout_events) ? body.optout_events : []).slice(0, 100)) {
    if (!e || typeof e !== "object") continue;
    await setOptout(e.login, e.off === true, { via: "chat", ts: Math.floor(Number(e.ts) || t) });
  }
  const rooms = bridgeRooms();
  for (const [room, r] of Object.entries(body.rooms && typeof body.rooms === "object" ? body.rooms : {}).slice(0, 50)) {
    const R = rooms.get ? rooms.get(room) : null;
    if (R && r && typeof r.livecams === "boolean") R.livecams = r.livecams;
  }
  const live = Array.isArray(body.live) ? body.live.slice(0, 50) : [];
  const seen = new Set();
  for (const x of live) {
    if (!x || typeof x !== "object") continue;
    const S = SESS.get(keyOf(str(x.room, 128), str(x.login, 40)));
    if (!S || S.ended) continue;
    seen.add(S.key);
    S.botState = str(x.state, 20);
    S.botInfo = { grab_fps: Number(x.grab_fps) || null, grab_ms: Number(x.grab_ms) || null, size: Array.isArray(x.size) ? x.size.slice(0, 2) : null,
                  restarts: Number(x.restarts) || 0, up_s: Number(x.up_s) || 0, setup_ms: Number(x.setup_ms) || null,
                  source: x.source === "passthrough" ? "passthrough" : "reencode", fps: Number(x.fps) || null, fallback: str(x.fallback, 60) || null,
                  kbps: Number.isFinite(Number(x.kbps)) && Number(x.kbps) >= 0 ? Math.min(100000, Number(x.kbps)) : null };
    if (S.botState === "live" && !S.liveAt) S.liveAt = t;
    if (S.botState === "ended" || S.botState === "stopped") {
      const why = str(x.why, 30);
      if (TERMINAL.has(why)) endSession(S, why, t);
    }
  }
  for (const x of (Array.isArray(body.refused) ? body.refused.slice(0, 50) : [])) {
    const S = x && SESS.get(keyOf(str(x.room, 128), str(x.login, 40)));
    if (!S || S.ended || seen.has(S.key)) continue;
    const why = str(x.why, 30);
    S.botWhy = why;
    if (TERMINAL.has(why)) endSession(S, why, t);
  }
  const want = [];
  if (on()) {
    for (const S of SESS.values()) {
      if (S.ended) continue;
      const R = rooms.get ? rooms.get(S.roomId) : null;
      if (!R || R.livecams === false || !R.cams) { endSession(S, R ? "room_off" : "offline", t); continue; }
      if (optedOut(S.login)) { endSession(S, "opted_out", t); continue; }
      const key = pubKey(S.path);
      if (!key) continue;
      // 1.99aaf: ghosts aren't counted; ghost_only = nobody but staff in ghost mode watches -> Pepe says nothing in the room
      const fv = freshViewers(S, t), shown = shownCount(fv);
      want.push({ room: S.roomId, login: S.login, url: W().whipUrl(S.path), token: key, path: S.path, viewers: Math.max(1, shown),
                  ...(fv.length && !shown && !S.stage ? { ghost_only: true } : {}) });
    }
  }
  const c = cfg();
  let cvNotify = [];
  try { cvNotify = CV().forBot(body, t); } catch (e) { cvNotify = []; }   // 1.99yq: "X opened your cam" notices for Pepe to PM
  return { ok: true, v: CFG.v, cfg: Object.fromEntries(BOT_KEYS.map((k) => [k, c[k]])), want, optout: [...OPTOUT].slice(0, 5000), cv_notify: cvNotify };
}

// ── MediaMTX ──
/** webrtc.sync hands over MediaMTX's path list every 5 s: readers + the publisher's session id per cam path. */
function noteSync(items, t = now()) {
  const seen = new Set();
  for (const p of items || []) {
    const S = p && typeof p.name === "string" ? camForPath(p.name) : null;
    if (!S) continue;
    S.ready = !!(p.ready || p.available);
    if (S.ready && !S.liveAt) S.liveAt = t;
    S.readers = (Array.isArray(p.readers) ? p.readers : []).filter((r) => r && r.type === "webRTCSession").length;
    S.sourceId = p.source && p.source.type === "webRTCSession" ? String(p.source.id || "") || null : null;
    S.seenAt = t;
    seen.add(S.key);
  }
  for (const S of SESS.values()) if (!seen.has(S.key)) { S.ready = false; S.readers = 0; S.seenAt = t; }
}
const loopbackIp = (a) => /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.test(String(a || ""));
/** The auth hook for a cam path. publish: WHIP with the path's bearer. read: WHEP only, a good ticket from a viewer who
 *  holds a slot on this cam and may still see the pad's live room. -> HTTP status. */
async function auth(b, action, proto) {
  b = b || {};
  const p = String(b.path || "");
  const S = camForPath(p);
  if (!S || S.ended || !on()) return 403;
  if (action === "publish") {
    if (proto !== "webrtc") return 403;
    const cred = String(b.token || b.password || "").trim();
    if (!cred) return 401;
    return sameSecret(cred, pubKey(p)) ? 200 : 403;
  }
  if (action === "read") {
    if (proto !== "webrtc") return 403;                      // no HLS / RTSP of a cam, ever
    let tok = null;
    try { tok = new URLSearchParams(String(b.query || "").replace(/^\?/, "")).get("pt"); } catch (e) { tok = null; }
    const c = checkTicket(tok, p);
    if (!c) return loopbackIp(b.ip) ? 403 : 401;
    const v = S.viewers.get(String(c.uid)) || (S.stage && S.stageViewers ? S.stageViewers.get(String(c.uid)) : null);   // 1.99zc: or a stage viewer
    if (!v || now() - v.beat > BEAT_MS) return 403;
    if (optedOut(S.login)) return 403;
    if (CV().blocked(S.login, c.uid)) return 403;
    if (!(await require("./bridge-relay").padFull(c.uid, S.roomId))) return 403;
    if (b.id && /^[0-9a-f-]{36}$/i.test(String(b.id))) v.readers.add(String(b.id));
    // 1.99yq: the video really reaches them now -> Pepe PMs the cam's owner who it is (camviewers.js rate-limits it)
    if (!v.noted) { v.noted = true; CV().noteViewers("live", S.roomId, S.login, [String(c.uid)]); }
    return 200;
  }
  return 403;
}

// ── views ──
/** For the pad's live view: may the ▶ Live button show, and the viewer's slots. null = no live cams here. */
function hint(R, userId) {
  if (!R || !R.cams || R.livecams === false || !on() || !botOk()) return null;
  if (!userId) return { on: true, signin: true };
  const t = now();
  const watching = [];
  for (const S of SESS.values()) if (!S.ended && S.roomId === R.id) { const v = S.viewers.get(String(userId)); if (v && t - v.beat <= BEAT_MS) watching.push(S.login); }
  return { on: true, slots: { used: slotsOf(userId, t), max: maxSlots(userId) }, watching, sp_max: cfg().viewers_sp,
           ...(isGhost(userId) ? { ghost: true } : {}) };   // 1.99aaf: the 👻 badge on the popover   // 1.99zc: sp_max for the strip's hint
}
async function ghostView() { try { return await require("./ghost").adminView(); } catch (e) { return null; } }
async function adminView() {
  await init();
  const t = now();
  sweep(t);
  let audit = [];
  try { audit = await require("./adminaudit").recent(AUDIT, 15); } catch (e) { audit = []; }
  const c = cfg();
  const sessions = [...SESS.values()].filter((S) => !S.ended).map((S) => ({
    key: S.key, room: S.roomId, login: S.login, display: S.display, state: stateOf(S, t), since: S.createdAt, liveAt: S.liveAt || null,
    viewers: freshViewers(S, t).map(([uid, v]) => ({ userId: uid, username: v.username, since: v.since, ghost: !!v.ghost })), readers: S.readers, bot: S.botInfo || null,
    kbps: Math.round(rateOf(S, c)), measured: !!(S.botInfo && S.botInfo.source === "passthrough" && Number(S.botInfo.kbps) > 0),
    outKbps: Math.round(rateOf(S, c) * (freshViewers(S, t).length + freshStage(S, t).length)),
    botState: S.botState, botWhy: S.botWhy, stage: S.stage || null, stageViewers: freshStage(S, t).length }));
  const viewers = totalViewers(t);
  const recent = await getQuery(`SELECT room_id, target, viewer_name, started, ended, secs, end_reason, ghost FROM livecam_audit ORDER BY id DESC LIMIT 30`);
  return { now: t, v: CFG.v, cfg: { ...c }, defaults: { ...DEFAULTS }, fields: FIELDS, updated_at: CFG.at, updated_by: CFG.by, webrtc: W().enabled(),
           bot: BOT ? { at: BOT.at, online: botOk(t), pool: BOT.pool, cfgFrom: BOT.cfgFrom } : null, sessions,
           usage: { viewers, viewerCap: viewerCap(c), mbps: Math.round(usedKbps(t, c) / 100) / 10, budget_mbps: c.budget_mbps, live: sessions.length,
                    max_live: c.max_live, publishMbps: Math.round(sessions.reduce((a, x) => a + x.kbps, 0) / 100) / 10 },
           optouts: OPTOUT.size, camviewers: CV().stats(), ghost: await ghostView(), audit, recent };
}

// ── routes ──
function register(app, { addUser, isBotToken, bySlug, isLive }) {
  init().catch((e) => console.error("[livecam] init:", e.message));
  const tm = setInterval(() => { try { sweep(); } catch (e) { /* next time */ } }, 5000);
  if (tm.unref) tm.unref();
  const fetchOnly = (req, res) => {
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) { res.status(403).json({ ok: false, error: "Security check failed - reload the page." }); return false; }
    return true;
  };
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status).json({ ok: false, code: e.code, error: e.message, ...(e.extra || {}) });
    console.error("[livecam]", e);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  const me = async (req) => {
    if (!req.user || !req.user.userId) return null;
    return (await getQuery("SELECT userId, username, displayname, camfrogUsername, class FROM users WHERE userId = ?", [req.user.userId]))[0] || null;
  };
  const room = (req) => {
    const R = bySlug(req.params.slug);
    if (!R || !isLive(R)) throw refuse("offline");
    if (!R.cams) throw refuse("room_off");
    return R;
  };
  const viewHit = guard.limiter({ max: 30, windowMs: 60 * 1000 });

  app.post("/api/rooms/:slug/livecam", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!fetchOnly(req, res)) return;
    try {
      const u = await me(req);
      if (!u) throw refuse("signin");
      const wait = viewHit.blocked("u:" + u.userId);
      if (wait) { res.set("Retry-After", String(wait)); return res.status(429).json({ ok: false, code: "rate", error: "Slow down a little." }); }
      viewHit.hit("u:" + u.userId);
      const R = room(req);
      const blk = await require("./bridgeblocks").refusal(R.id, u.userId, "livecams");   // 1.99zf: a bridge block on live cams
      if (blk) return res.status(403).json({ ok: false, code: "blocked", error: blk, blocked: true, feature: "livecams" });
      res.json(await start(u, R, String((req.body || {}).login || "")));
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/livecam/beat", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!fetchOnly(req, res)) return;
    if (!req.user || !req.user.userId) return fail(res, refuse("signin"));
    const R = bySlug(req.params.slug);
    if (!R) return res.json({ ok: true, state: "ended", why: "offline" });
    if (!(await require("./bridge-relay").padFull(req.user.userId, R.id))) {
      stop(req.user.userId, R.id, String((req.body || {}).login || ""));
      return fail(res, refuse("pad_access"));
    }
    const blk = await require("./bridgeblocks").refusal(R.id, req.user.userId, "livecams");   // 1.99zf: blocked mid-stream -> it ends
    if (blk) {
      stop(req.user.userId, R.id, String((req.body || {}).login || ""));
      return res.status(403).json({ ok: false, code: "blocked", error: blk, blocked: true, feature: "livecams", state: "ended" });
    }
    res.json(beat(req.user.userId, R.id, String((req.body || {}).login || "")));
  });
  app.post("/api/rooms/:slug/livecam/stop", addUser, (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!fetchOnly(req, res)) return;
    if (!req.user || !req.user.userId) return fail(res, refuse("signin"));
    const R = bySlug(req.params.slug);
    res.json(R ? stop(req.user.userId, R.id, String((req.body || {}).login || "")) : { ok: true });
  });
  app.post("/api/rooms/:slug/livecam/end", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!fetchOnly(req, res)) return;
    try {
      const u = await me(req);
      if (!u) throw refuse("signin");
      const R = bySlug(req.params.slug);
      if (!R) throw refuse("offline");
      const login = String((req.body || {}).login || "").toLowerCase();
      if (!LOGIN_RE.test(login)) throw new Refuse(400, "Whose cam?", "bad");
      if (!mayEnd(u, R, login)) throw new Refuse(403, "Only the cam's owner, the room's mods and the pad owner can end it.", "forbidden");
      const out = endBy(u, R, login);
      // 1.99zf: a mod / the owner / staff ending someone else's live cam goes in the room's moderation history (pepemodlog.js)
      if (String(u.camfrogUsername || "").toLowerCase() !== login) require("./rooms").event(R.id, "livecam-end", u.username || null, `ended the live view of ${login}'s cam`);
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  app.post("/api/bridge/livecam", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    try { res.json(await forBot(b)); } catch (e) { console.error("[livecam] bot:", e); res.status(500).json({ ok: false }); }
  });

  // Settings → Privacy: the cam owner's switch (their linked chat login)
  app.get("/api/privacy/livecam", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try { res.json({ ok: true, ...(await optoutState(req.user.userId)) }); } catch (e) { fail(res, e); }
  });
  const privHit = guard.limiter({ max: 20, windowMs: 60 * 60 * 1000 });
  app.post("/api/privacy/livecam", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!fetchOnly(req, res)) return;
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      const off = (req.body || {}).off;
      if (typeof off !== "boolean") throw new Refuse(400, "off must be true or false", "bad");
      const st = await optoutState(req.user.userId);
      if (!st.linked) throw new Refuse(409, "Link your Camfrog name first - this is about your cam there.", "unlinked");
      if (privHit.blocked("u:" + req.user.userId)) throw new Refuse(429, "That's a lot of switching - try again in a while.", "rate");
      privHit.hit("u:" + req.user.userId);
      await setOptout(st.login, off, { via: "web", userId: String(req.user.userId) });
      res.json({ ok: true, ...(await optoutState(req.user.userId)) });
    } catch (e) { fail(res, e); }
  });

  // /admin/pepe/livecams
  const admin = (json) => (req, res, next) => {
    if (!req.user || !req.user.userId) return json ? res.status(401).json({ ok: false, error: "Sign in first." }) : res.redirect("/login?next=/admin/pepe/livecams");
    if (req.user.class !== "Admin") return json ? res.status(403).json({ ok: false, error: "Admins only." }) : res.status(403).send("Admins only.");
    next();
  };
  app.get("/admin/pepe/livecams", addUser, admin(false), async (req, res) => {
    try {
      res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
      res.render("admin/pepeLivecams", { user: req.user.username, title: "Admin · Live cams", section: "pepe", isAdmin: true, v: await adminView() });
    } catch (e) { console.error("[livecam] page:", e); res.status(500).send("Couldn't load the page."); }
  });
  app.get("/api/admin/pepe/livecams", addUser, admin(true), async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, ...(await adminView()) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/pepe/livecams", addUser, admin(true), async (req, res) => {
    if (!fetchOnly(req, res)) return;
    try { const r = await save(req.user, req.body || {}); res.json({ ok: true, ...r, view: await adminView() }); } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/pepe/livecams/end", addUser, admin(true), async (req, res) => {
    if (!fetchOnly(req, res)) return;
    const S = SESS.get(String((req.body || {}).key || ""));
    if (!S || S.ended) return res.status(404).json({ ok: false, error: "That live cam already ended." });
    COOL.set(S.key, now() + END_COOLDOWN_MS);
    endSession(S, "ended_by_admin");
    console.log(`[livecam] admin end ${S.key} by=${req.user.username || req.user.userId}`);
    res.json({ ok: true, view: await adminView() });
  });
}

module.exports = {
  register, init, normalize, save, current, viewerCap, pathFor, pubKey, readTicket, checkTicket, camForPath, start, beat, stop, endBy, mayEnd,
  forBot, noteSync, auth, hint, adminView, stageConsent, stageHold, stageRelease, stageState, stageWatch, setOptout, optoutState, optedOut, sweep, dropViewerOf, watchersOf,
  PREFIX, PATH_RE, FIELDS, DEFAULTS, BEAT_MS, TICKET_MS,
  END_COOLDOWN_MS, START_MS,
  _sessions: SESS,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _setKick: (fn) => { kickImpl = fn; },
  _reset: () => { SESS.clear(); BY_PATH.clear(); COOL.clear(); BOT = null; OPTOUT = new Set(); CFG = { v: 0, cfg: { ...DEFAULTS }, at: null, by: null }; ready = null; },
};
