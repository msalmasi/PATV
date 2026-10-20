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
// The slot HOLDS the session (S.holds has the slot id): it stays wanted while the slot is open (never ended as "unwatched"), with
// the same consent rules as a viewer's ▶ Live (on cam, not opted out, not private, not ended by them, the room's switch).
// Stage viewers ask for a ticket of their own (stageWatch: signed in + padaccess.full, inside the bandwidth budget) and beat
// like a viewer; they are counted in the site-wide budget but never in anyone's personal live-cam slots. One publish by
// Pepe serves the strip, the popover and the stage alike. When the session ends (opt-out, cam closed, ended by the owner /
// a mod / staff) stageState says so and mainstage ends the slot.
// stagefix site (V1-2 of the dynamic-stages design): the Stage follows the person on cam, not just the room.
//   * putting someone up (stageConsent / stageHold, `actor` = who does it): also refused - with the neutral "unavailable",
//     never the reason - when the pad has no 💎 bridge perk (room_off), when they took themselves off this pad's Stage
//     (stageleave.js, "Take me off this Stage": 1 h, repeats up to 24 h), or when they and whoever puts them up - or the
//     pad's owner, whose Stage it is - blocked one another (cam_blocks, or a DM block either way). Staff follow the same
//     rules (DF-43). camBeat re-checks it all every tick (stageRecheck: + opt-out and private activity).
//     stagefix fix: a block counts in both directions even when the person on cam IS the actor or the pad's owner (staff
//     putting up the owner's cam, or their own on a pad whose owner blocked them); private activity, a take-off and a block
//     are all the same "unavailable" (and the slot's end reason "cam_unavailable"), so the actor can't tell them apart.
//     stagefix (final round): + a stage ban of an account linked to the cam's login (site-wide stage_bans, or this pad's
//     stage_room_bans - bannedSet), on the put and every tick. The person's own say over pins (never / off / the per-pad yes /
//     the 10-minute "Keep going?" check) is stagepin.js; Pepe's "!stage ok" capability is stageOkOk.
//   * every Stage viewer (stageWatch, on the ticket AND every beat; the MediaMTX hook too): padFull (18+ gate included),
//     the room's bridge perk, the room's live-cam block on them (bridgeblocks), the cam owner's block, the cam's own access
//     mode (camaccess.gate - members / followers / request; no "Ask to watch" on a Stage) and a DM block either way. A
//     refused viewer gets the neutral "unavailable" card. 👻 ghost mode never gets past a Stage tile (DF-43).
//
// micfollow: a session can have SEVERAL stage holders (S.holds, a Set): a cam slot's id and/or "mf:<room id>" - the pad's
// 🎙 mic-follows stage (micfollow.js), so a manual cam slot and the mic stage share ONE Pepe publish. Two cam SLOTS still
// can't hold the same cam (409 on_stage). Each stage viewer remembers which holder(s) they came through (v.via): letting
// go of a holder kicks only the viewers who came through it alone. A session held by the mic stage is marked S.mf and
// Pepe is asked to open it by its exact name (want[].mf); he reports live[].exact and advertises mf: 1 on his poll.
// Viewers who watch ONLY through the mic stage are not noted to the cam's owner one by one (micfollow sends one stage
// notice instead); watchersOf marks them `mf` and the owner's lists (!whowatching, the privacy card) COUNT them, never name
// them (D-19, owner 2026-10-19; camaccess still sees them to drop the ones a mode change refuses). Such a viewer reads only a relay Pepe
// reports exact, and never gets the 👻 ghost bypass. The mic stage's hold re-checks micfollow's own rules after its awaits
// (opts.ok -> "gone"); its release (stageDrop) ends a relay nobody else holds or watches at once (no linger); a ▶ Live
// start that finds max_live full asks micfollow.yieldRelay first. Hooks: onEnd(fn(S, why)) after a session ends,
// onOptout(fn(login, off)) after an opt-out change (a throwing hook is logged and ignored).
//
// Path names share the room-audio family on MediaMTX (deploy/webrtc/mediamtx.yml "~^(room|stgr)-[0-9a-f]{16}$"), so no
// MediaMTX change is needed: prod "room-<16 hex>", staging "stgr-<16 hex>", an HMAC of "live-cam-path:<room>|<login>"
// that never collides with a room's audio path (different HMAC input). webrtc.js asks camForPath first.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery, tx } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)
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
// stagefix: the 💎 bridge perk (premium.bridgeAllowed via bridge.js): a pad without it shows no live room on the site
const bridgeOk = (roomId) => { try { return require("./bridge").bridgeOk(String(roomId)); } catch (e) { return true; } };
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();

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
      if (!acols.includes("bypass")) await runQuery("ALTER TABLE livecam_audit ADD COLUMN bypass TEXT");   // 1.99aak: what a ghost got past
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
  if (!SP.can(user, "livecam.admin")) throw new Refuse(403, "Admins only.");
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
  if (off) { OPTOUT.add(l); for (const S of [...SESS.values()]) if (S.login === l) ownerClosed(S, "opted_out"); }
  else OPTOUT.delete(l);
  runHooks(OPTOUT_HOOKS, [l, !!off], "opt-out");      // micfollow: the mic stage drops them at once too
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
/** micfollow: does any stage holder (a cam slot or the mic stage) hold this session? */
const held = (S) => !!(S && S.holds && S.holds.size > 0);
const MF_PREFIX = "mf:";
const isMfHolder = (h) => String(h || "").startsWith(MF_PREFIX);
/** micfollow: a stage viewer who came ONLY through the mic stage (no cam slot): no 👻 ghost bypass, exact relays only. */
const mfOnlyVia = (v) => !!(v && v.via instanceof Set && v.via.size > 0 && [...v.via].every(isMfHolder));
/** A new session object (one per room + cam). */
function newSess(R, login, m, t) {
  const p = pathFor(R.id, login);
  const S = { key: keyOf(R.id, login), roomId: R.id, login, display: (m && m.display) || login, path: p, viewers: new Map(), createdAt: t,
              wantUntil: t + cfg().linger_s * 1000, liveAt: 0, ready: false, readers: 0, seenAt: 0, sourceId: null, botState: null, botWhy: null,
              ended: 0, endWhy: null, holds: new Set(), lastHolds: null, mf: false, stageViewers: new Map() };
  SESS.set(S.key, S);
  BY_PATH.set(p, S.key);
  return S;
}
// ── hooks (micfollow.js) ──
const END_HOOKS = [], OPTOUT_HOOKS = [];
function runHooks(list, args, what) {
  for (const fn of list) { try { fn(...args); } catch (e) { console.error(`[livecam] ${what} hook:`, e && e.message); } }
}
function onEnd(fn) { if (typeof fn === "function" && !END_HOOKS.includes(fn)) END_HOOKS.push(fn); }
function onOptout(fn) { if (typeof fn === "function" && !OPTOUT_HOOKS.includes(fn)) OPTOUT_HOOKS.push(fn); }
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
  if (held(S)) S.lastHolds = new Set(S.holds);      // 1.99zc: the stage slot reads why it ended (stageState)
  for (const uid of [...S.viewers.keys()]) dropViewer(S, uid, why, t);
  if (S.stageViewers) { for (const v of S.stageViewers.values()) for (const rid of v.readers || []) kickReader(rid); S.stageViewers.clear(); }
  S.wantUntil = 0;
  if (S.sourceId) kickReader(S.sourceId);
  // micfollow: a relay the mic stage ever held is logged without its login (spec §12 - mic stages relay people who never
  // asked to be watched; the appearance log is their record)
  console.log(`[livecam] end room=${S.roomId} target=${S.mfEver ? "-" : S.login} why=${why}`);
  runHooks(END_HOOKS, [S, why], "end");               // micfollow: the mic stage's tile follows its relay
}
function sweep(t = now()) {
  for (const S of [...SESS.values()]) {
    if (!S.ended) {
      for (const [uid, v] of [...S.viewers.entries()]) if (t - v.beat > BEAT_MS) dropViewer(S, uid, "gone", t);
      if (S.stageViewers) for (const [uid, v] of [...S.stageViewers.entries()]) if (t - v.beat > BEAT_MS) { S.stageViewers.delete(uid); for (const rid of v.readers || []) kickReader(rid); }
      if (held(S)) S.wantUntil = Math.max(S.wantUntil || 0, t + cfg().linger_s * 1000);   // 1.99zc: held by a stage slot / the mic stage
      if (!S.viewers.size && !held(S) && S.wantUntil && S.wantUntil < t) endSession(S, "unwatched", t);
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
/**
 * adultgate site: the 18+ gate now applies to a room (the switch on, the pad marked 18+, or every TICK while on): drop the
 * live-cam viewers (and stage-slot viewers of a room's cam) it stops - their WHEP reader is kicked, as when a viewer stops
 * beating. -> how many were dropped
 */
async function recheck() {
  const AG = require("./adultgate");
  const PA = require("./padaccess");
  let n = 0;
  const t = now();
  for (const S of SESS.values()) {
    if (S.ended || !AG.applies(S.roomId)) continue;
    for (const uid of [...S.viewers.keys()]) {
      if ((await PA.adultGateFor(uid, S.roomId)) !== "ok") { if (dropViewer(S, uid, "pad_access", t)) n++; }
    }
    if (S.stageViewers) {
      for (const [uid, v] of [...S.stageViewers.entries()]) {
        if ((await PA.adultGateFor(uid, S.roomId)) === "ok") continue;
        S.stageViewers.delete(uid);
        for (const rid of v.readers || []) kickReader(rid);
        n++;
      }
    }
  }
  if (n) console.log(`[livecam] 18+ gate: dropped ${n} live cam viewer(s)`);
  return n;
}

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
const endsAny = (u) => SP.can(u, "livecam.end_any");   // 1.99ack (siteperms.js): end any cam's relay
const passOf = (userId) => { try { return !!require("./premium").hasPass(userId); } catch (e) { return false; } };
const maxSlots = (userId) => (passOf(userId) ? cfg().viewers_sp : cfg().viewers_free);
const botOk = (t = now()) => !!(BOT && t - BOT.at < BOT_FRESH_MS);
/** stagefix fix: does Pepe forward "!stage off me" (from everyone, to /api/rooms/stage/act)? His live-cam poll says so
 *  (`stage_off_me: true`, a bot change). Until it does, nothing tells people to type it (mainstage camNotify, the privacy card). */
const stageOffMeOk = () => !!(BOT && BOT.stageOffMe);
/** stagefix (D-17 / DF-45): does Pepe forward "!stage ok" / "!stage no" (stagepin.js: answers to "keep going?" and to a pin ask)?
 *  His live-cam poll says so (`stage_ok: true`, a bot change). Until it does, an unlinked cam can't answer, so stagepin asks no one
 *  who has no PATV account. */
const stageOkOk = () => !!(BOT && BOT.stageOk);

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
  // 1.99aak: staff in 👻 ghost mode get past the owner's opt-out, "private" and blocks (moderation - the user's decision,
  // 2026-10-15); the bypass is audited (livecam_audit / cam_views bypass) and nobody is told. Everyone else: the owner's rules.
  const ghost = isGhost(u.userId);
  let bypass = null;
  if (optedOut(login)) { if (!ghost) throw refuse("opted_out"); bypass = "opted_out"; }
  try { if ((await require("./stories").privateLogins([login])).has(login)) { if (!ghost) throw refuse("opted_out"); bypass = bypass || "private"; } }
  catch (e) { if (e.refuse) throw e; }
  if (CV().blocked(login, u.userId)) { if (!ghost) throw refuse("unavailable"); bypass = bypass || "blocked"; }   // 1.99yq: !blockviewer
  // 1.99aar: the owner's mode (members / followers / on request + their "always" list, camaccess.js); a refused viewer may ask
  const g = await require("./camaccess").gate(login, u.userId);
  if (g) { if (!ghost) throw new Refuse(403, g.error, g.code, { can_ask: g.can_ask, pending: g.pending, mode: g.mode }); bypass = bypass || g.code; }
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
    if (!S && liveCount() >= cfg().max_live) {
      // micfollow: a viewer's ▶ Live wins over the mic stage - it gives one relay it alone holds back (spec §7.1 / §7.4)
      let freed = false;
      try { freed = !!require("./micfollow").yieldRelay(t); } catch (e) { freed = false; }
      if (!freed || liveCount() >= cfg().max_live) throw refuse("slots_busy");
    }
  }
  if (!S) {
    S = newSess(R, login, m, t);
    console.log(`[livecam] start room=${R.id} target=${login} viewer=${u.username || uid}`);
  }
  let v = S.viewers.get(uid);
  if (!v) {
    v = { since: t, beat: t, username: u.username || null, readers: new Set(), auditId: null, ghost: isGhost(uid), bypass };
    S.viewers.set(uid, v);
    try {
      const r = await runQuery("INSERT INTO livecam_audit (room_id, target, viewer_id, viewer_name, started, ghost, bypass) VALUES (?, ?, ?, ?, ?, ?, ?)",
                               [R.id, login, uid, u.username || null, t, v.ghost ? 1 : 0, bypass]);
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
/** 1.99aak: the cam's owner switched it off for the website: everyone but staff in 👻 ghost mode is dropped (a stage slot
 *  ends - it's public); the session ends when nobody is left. -> true when it lives on (ghosts only). */
function ownerClosed(S, why, t = now()) {
  if (!S || S.ended) return false;
  if (held(S)) { endSession(S, why, t); return false; }
  for (const [uid, v] of [...S.viewers.entries()]) if (!(v.ghost && isGhost(uid))) dropViewer(S, uid, why, t);
  if (!S.viewers.size) { endSession(S, why, t); return false; }
  return true;
}
/** 1.99yq: the owner blocked this viewer - drop them from every live relay of the cam now (the reader is kicked). -> count */
function dropViewerOf(login, userId, why = "blocked", t = now()) {
  let n = 0;
  const l = String(login || "").toLowerCase();
  const ghost = isGhost(userId);                       // 1.99aak: a block doesn't stop staff in 👻 ghost mode (audited) -
  for (const S of SESS.values()) {                     // stagefix: on their personal ▶ Live only; a Stage tile never (DF-43)
    if (S.ended || S.login !== l) continue;
    if (!ghost && dropViewer(S, String(userId), why, t)) n++;
    // 1.99zc: a stage viewer of that cam, too - through a cam slot or the 🎙 mic stage alike (stagefix DF-43: no ghost on a
    // Stage tile; micfollow §3.5: none on the mic stage either)
    if (dropStageViewer(S, String(userId))) n++;
  }
  return n;
}
/** 1.99yq: who has `login`'s cam open live right now -> [{userId, username, room, since}] */
function watchersOf(login, t = now()) {
  const l = String(login || "").toLowerCase(), out = [];
  for (const S of SESS.values()) {
    if (S.ended || S.login !== l) continue;
    for (const [uid, v] of freshViewers(S, t)) out.push({ userId: uid, username: v.username, room: S.roomId, since: v.since, ghost: !!v.ghost });
    // 1.99zc; micfollow (D-19): `mf` = they watch ONLY through a pad's mic stage - counted for the cam's owner, never named
    for (const [uid, v] of freshStage(S, t)) out.push({ userId: uid, username: v.username || null, room: S.roomId, since: v.since, stage: true, ghost: !!v.ghost, mf: mfOnlyVia(v) });
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
  if (endsAny(u)) return true;
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
  if (S) endSession(S, endsAny(u) && String(u.camfrogUsername || "").toLowerCase() !== login ? "ended_by_admin" : "ended_by", t);
  console.log(`[livecam] ended room=${R.id} target=${login} by=${u.username || u.userId}`);
  return { ok: true };
}

// ── 1.99zc: 🎬 stage cams (see the header) ──
// stagefix: blocks between the person on cam and whoever puts them up / owns the Stage, and the per-viewer gate.
/** The pad's owner account (rooms registry), or null. */
function padOwnerId(roomId) {
  try { const r = require("./rooms").getCached(String(roomId || "")); return r && r.owner && r.owner.userId ? String(r.owner.userId) : null; } catch (e) { return null; }
}
const placeholders = (n) => new Array(n).fill("?").join(", ");
/**
 * stagefix (D-17; §12.9.5.1 row 8): which of `logins` may NOT be put on room `roomId`'s Stage by `actorId` because of a block -
 * between the person on cam and whoever puts them up, or the pad's owner (it's their Stage): the cam's owner blocked them
 * from the cam (cam_blocks), or a DM block either way (messages.js dm_blocks) between an account linked to the cam's login
 * and theirs. Never bypassed (staff pins follow the subject's rules, DF-43). -> Set(login)
 */
async function directorBlockedSet(logins, roomId, actorId) {
  return blockedSet(logins, [actorId, padOwnerId(roomId)]);
}
/** stagefix: the cam_blocks memory is camviewers.js's (its init loads it; the server runs it at start - tests and early calls too). */
async function cvReady() { try { await CV().init(); } catch (e) { /* no camviewers: no cam blocks */ } }
/**
 * stagefix: which of `logins` have a block with any of the accounts `ids` (either way): the cam's owner blocked that account
 * from the cam (cam_blocks), or a DM block either way between an account linked to the login and it. -> Set(login)
 * Also onair.js: a cam an admin puts on Pepe's stream (D-17's "blocks against the director" for layer 3).
 */
async function blockedSet(logins, ids0) {
  const out = new Set();
  const list = [...new Set((logins || []).map(low).filter((l) => LOGIN_RE.test(l)))];
  const ids = [...new Set((ids0 || []).filter(Boolean).map(String))];
  if (!list.length || !ids.length) return out;
  await cvReady();
  for (const l of list) if (ids.some((id) => CV().blocked(l, id))) out.add(l);
  for (const l of await dmBlockedSet(list, ids)) out.add(l);
  return out;
}
/**
 * The DM half of blockedSet (train2 merge: split out so micfollow can cache it - its eligOf reads the cam_blocks half live
 * from camviewers' memory): which of `logins` have a DM block either way (messages.js dm_blocks) between an account linked to
 * the login and one of the accounts `ids`. -> Set(login)
 */
async function dmBlockedSet(logins, ids0) {
  const out = new Set();
  const list = [...new Set((logins || []).map(low).filter((l) => LOGIN_RE.test(l)))];
  const ids = [...new Set((ids0 || []).filter(Boolean).map(String))];
  if (!list.length || !ids.length) return out;
  let accts = [];
  try { accts = await getQuery(`SELECT userId, lower(camfrogUsername) AS l FROM users WHERE lower(camfrogUsername) IN (${placeholders(list.length)})`, list); }
  catch (e) { accts = []; }
  const loginOfId = new Map(accts.map((r) => [String(r.userId), String(r.l)]));
  if (!loginOfId.size) return out;
  let rows = [];
  try { rows = await getQuery(`SELECT blocker_id, blocked_id FROM dm_blocks WHERE blocker_id IN (${placeholders(ids.length)}) OR blocked_id IN (${placeholders(ids.length)})`, ids.concat(ids)); }
  catch (e) { rows = []; }                          // no DMs here (no table): no DM blocks
  // stagefix fix: each row both ways - one side one of `ids`, the other an account linked to the cam's login. A row between
  // two of `ids` counts too when one of them IS the person on cam (the pad's owner on their own Stage, staff putting up their
  // own cam): only a row between two accounts that aren't the person on cam is about someone else.
  for (const r of rows) {
    const a = String(r.blocker_id), b = String(r.blocked_id);
    if (a === b) continue;
    if (ids.includes(a) && loginOfId.has(b)) out.add(loginOfId.get(b));
    if (ids.includes(b) && loginOfId.has(a)) out.add(loginOfId.get(a));
  }
  return out;
}
const directorBlocked = async (login, roomId, actorId) => (await directorBlockedSet([login], roomId, actorId)).has(low(login));
const blockedWith = async (login, ids) => (await blockedSet([login], ids)).has(low(login));
/**
 * stagefix (§12.9.5.1 rows 9-10, "stage bans of the linked account"): which of `logins` have a linked PATV account banned from
 * the stages - site-wide (mainstage stage_bans, staff) or from room `roomId`'s Stage (stage_room_bans, the pad's owner). A
 * banned person can't be put on a Stage either (refused, and an open cam slot ends, with the neutral "unavailable"). -> Set(login)
 */
async function bannedSet(logins, roomId) {
  const out = new Set();
  const list = [...new Set((logins || []).map(low).filter((l) => LOGIN_RE.test(l)))];
  if (!list.length) return out;
  let accts = [];
  try { accts = await getQuery(`SELECT userId, lower(camfrogUsername) AS l FROM users WHERE lower(camfrogUsername) IN (${placeholders(list.length)})`, list); }
  catch (e) { accts = []; }
  if (!accts.length) return out;
  const loginOfId = new Map(accts.map((r) => [String(r.userId), String(r.l)]));
  const ids = [...loginOfId.keys()];
  let rows = [];
  try { rows = rows.concat(await getQuery(`SELECT userId FROM stage_bans WHERE userId IN (${placeholders(ids.length)})`, ids)); } catch (e) { /* no stage yet */ }
  if (roomId) {
    try { rows = rows.concat(await getQuery(`SELECT userId FROM stage_room_bans WHERE room_id = ? AND userId IN (${placeholders(ids.length)})`, [String(roomId)].concat(ids))); }
    catch (e) { /* no stage yet */ }
  }
  for (const r of rows) if (loginOfId.has(String(r.userId))) out.add(loginOfId.get(String(r.userId)));
  return out;
}
const subjectBanned = async (roomId, login) => (await bannedSet([login], roomId)).has(low(login));
/** stagefix: "Take me off this Stage" (stageleave.js) - they're keeping their cam off this pad's Stage right now. */
async function stageLeft(roomId, login, t = now()) {
  try { const SL = require("./stageleave"); await SL.init(); return SL.excludedUntil(roomId, login, t) > 0; } catch (e) { return false; }
}
/** A DM block either way between viewer `uid` and an account linked to `login` (not their own). */
async function dmBlockedWith(login, uid) {
  if (!uid) return false;
  let rows = [];
  try { rows = await getQuery("SELECT userId FROM users WHERE lower(camfrogUsername) = ?", [low(login)]); } catch (e) { rows = []; }
  const ids = rows.map((r) => String(r.userId)).filter((id) => id !== String(uid));
  if (!ids.length) return false;
  try {
    return (await getQuery(`SELECT 1 AS x FROM dm_blocks WHERE (blocker_id = ? AND blocked_id IN (${placeholders(ids.length)}))
                            OR (blocked_id = ? AND blocker_id IN (${placeholders(ids.length)})) LIMIT 1`, [String(uid)].concat(ids, [String(uid)], ids))).length > 0;
  } catch (e) { return false; }
}
/**
 * stagefix (§12.9.5.1, the per-viewer gate): may viewer `uid` - signed in and padFull, the caller's checks - get the picture of
 * `login`'s cam on room `roomId`'s Stage? null = yes; "room_off" when the pad has no 💎 bridge perk; else the neutral
 * "unavailable" for every reason about the viewer and the person on cam (never which): the cam owner blocked them, the room's
 * live-cam block on them (bridgeblocks), the cam's own access mode (camaccess.gate: members / followers / request and the
 * owner's "always" list - no "Ask to watch" on a Stage), a DM block either way. No 👻 ghost bypass here (DF-43).
 */
async function stageViewerWhy(login, roomId, uid) {
  if (!bridgeOk(roomId)) return "room_off";
  const u = String(uid);
  await cvReady();
  if (CV().blocked(login, u)) return "unavailable";
  try { if (await require("./bridgeblocks").refusal(roomId, u, "livecams")) return "unavailable"; } catch (e) { /* no bridge blocks */ }
  if (await require("./camaccess").gate(login, u)) return "unavailable";
  if (await dmBlockedWith(login, u)) return "unavailable";
  return null;
}
function dropStageViewer(S, uid) {
  const v = S && S.stageViewers ? S.stageViewers.get(String(uid)) : null;
  if (!v) return false;
  S.stageViewers.delete(String(uid));
  for (const rid of v.readers || []) kickReader(rid);
  return true;
}
/**
 * May `login`'s cam in room R go on a stage right now? The same rules as a viewer's ▶ Live, minus the viewer's own.
 * stagefix: + the pad's bridge perk, "Take me off this Stage" and blocks with `actor` (who puts them up) or the pad's owner -
 * refused with the neutral "unavailable" (the actor is never told why).
 */
async function stageConsent(R, login, t = now(), { actor = null } = {}) {
  if (!on()) throw refuse("off");
  if (!R || !R.cams) throw refuse("room_off");
  if (R.livecams === false) throw refuse("room_off");
  if (!bridgeOk(R.id)) throw refuse("room_off");
  login = String(login || "").toLowerCase();
  const m = LOGIN_RE.test(login) ? memberOf(R, login) : null;
  if (!m || !m.on_cam) throw refuse("not_on_cam");
  if (optedOut(login)) throw refuse("opted_out");
  // stagefix fix: private activity, "Take me off this Stage" and a block are all the one neutral "unavailable" - whoever puts
  // them up can't tell which (private used to say "opted_out", i.e. "switched live video off" - not even true)
  try { if ((await require("./stories").privateLogins([login])).has(login)) throw refuse("unavailable"); } catch (e) { if (e.refuse) throw e; }
  if (await stageLeft(R.id, login, t)) throw refuse("unavailable");
  if (await directorBlocked(login, R.id, actor && actor.userId)) throw refuse("unavailable");
  if (await subjectBanned(R.id, login)) throw refuse("unavailable");      // stagefix: a stage ban of their linked account (site / this pad)
  if ((COOL.get(keyOf(R.id, login)) || 0) > t) throw refuse("ended_by");
  if (!botOk(t)) throw refuse("nopepe");
  return m;
}
/**
 * stagefix: mainstage camBeat's re-check of a cam its slot holds, every tick - what the person (or the pad) changed since it went
 * up: the pad's bridge perk, the live-video opt-out, private activity, "Take me off this Stage", a block with whoever put them
 * up (`actorId`) or the pad's owner. -> null | a reason (the slot ends with "cam_<reason>"). stagefix fix: private activity,
 * "Take me off this Stage" and a block all come back as the one neutral "unavailable" (the slot's end reason, which whoever put
 * the cam up sees on /stage and in the pad's log, never says which).
 */
async function stageRecheck(roomId, login, { actorId = null } = {}, t = now()) {
  login = low(login);
  if (!bridgeOk(roomId)) return "room_off";
  if (optedOut(login)) return "opted_out";
  try { if ((await require("./stories").privateLogins([login])).has(login)) return "unavailable"; } catch (e) { /* none */ }
  if (await stageLeft(roomId, login, t)) return "unavailable";
  if (await directorBlocked(login, roomId, actorId)) return "unavailable";
  if (await subjectBanned(roomId, login)) return "unavailable";           // stagefix: banned from the stages since it went up
  return null;
}
/** A stage holder takes hold of `login`'s live cam in room R: a cam slot (mainstage, source 'cam'; opts.actor = who puts it
 *  there) or the pad's mic stage ("mf:<room id>", micfollow.js; opts.mf). Several holders may share the session; two cam SLOTS
 *  may not (409 on_stage). -> {display} | throws Refuse */
async function stageHold(R, login, holderId, t = now(), opts = {}) {
  if (!opts || typeof opts !== "object") opts = {};
  await init();
  login = String(login || "").toLowerCase();
  const H = String(holderId);
  // stagefix: stageConsent's person-on-cam rules (the bridge perk, "Take me off this Stage", blocks with the actor / the pad's
  // owner, stage bans) hold for every holder - the mic stage has no actor, so its blocks are with the pad's owner
  const m = await stageConsent(R, login, t, opts);
  // micfollow: the mic stage re-checks ITS rules (the tile is still wanted; opt-outs, private activity, the pad's
  // exclusions, stage bans, cam access) here, after the awaits and right before the hold: a cut that landed while this
  // hold was on its way never leaves a relay behind - nothing is created, Pepe is never asked (spec §4.3)
  if (typeof opts.ok === "function" && opts.ok() !== true) throw new Refuse(409, "That cam isn't wanted on the stage any more.", "gone");
  const k = keyOf(R.id, login);
  let S = SESS.get(k);
  if (S && S.ended) { SESS.delete(k); S = null; }
  if (S && !isMfHolder(H)) {
    for (const h of S.holds) if (h !== H && !isMfHolder(h)) throw new Refuse(409, "That cam is already on the stage.", "on_stage");
  }
  if (!S && liveCount() >= cfg().max_live) throw refuse("slots_busy");
  if (!S) S = newSess(R, login, m, t);
  if (!S.stageViewers) S.stageViewers = new Map();
  if (!S.holds) S.holds = new Set();
  const had = S.holds.has(H);
  S.holds.add(H);
  if (opts.mf === true || isMfHolder(H)) { S.mf = true; S.mfEver = true; }
  S.wantUntil = Math.max(S.wantUntil, t + cfg().linger_s * 1000);
  if (!had) console.log(`[livecam] stage hold room=${R.id} target=${isMfHolder(H) ? "-" : login} holder=${isMfHolder(H) ? "mf" : H}`);
  return { display: m.display || login };
}
/** The session a cam SLOT holds (an "mf:" holder may hold several - see mfState). */
const stageSess = (slotId) => { for (const S of SESS.values()) if (S.holds && S.holds.has(String(slotId))) return S; return null; };
/** Let go of one holder: stage viewers who came only through it are kicked; with no holder left the relay lingers for
 *  the strip / popover viewers. key = only that session (keyOf(room, login)); null = every session it holds. */
function releaseHolder(S, H, t) {
  if (!S || !S.holds || !S.holds.has(H)) return false;
  S.holds.delete(H);
  if (S.stageViewers) {
    for (const [uid, v] of [...S.stageViewers.entries()]) {
      const via = v.via instanceof Set ? v.via : new Set();
      via.delete(H);
      if (!via.size) { S.stageViewers.delete(uid); for (const rid of v.readers || []) kickReader(rid); }
    }
  }
  if (![...S.holds].some(isMfHolder)) S.mf = false;
  if (!held(S) && !freshViewers(S, t).length) S.wantUntil = Math.min(S.wantUntil || Infinity, t + cfg().linger_s * 1000);
  return true;
}
function stageRelease(holderId, key = null, t = now()) {
  if (typeof key === "number") { t = key; key = null; }      // 1.99zc callers: stageRelease(slotId[, t])
  const H = String(holderId);
  let n = 0;
  if (key != null) { if (releaseHolder(SESS.get(String(key)), H, t)) n++; return n; }
  for (const S of SESS.values()) if (releaseHolder(S, H, t)) n++;
  return n;
}
/** micfollow: give the relay back (a manual cam slot needs it): let go, and end it when nobody else holds / watches it. */
function stageYield(roomId, login, holderId, t = now()) {
  const S = SESS.get(keyOf(roomId, login));
  if (!S || S.ended) return false;
  releaseHolder(S, String(holderId), t);
  if (!held(S) && !freshViewers(S, t).length) endSession(S, "yielded", t);
  return true;
}
/** micfollow: the mic stage lets go of `login`'s cam. A relay it held that nobody else holds or watches (no cam slot, no
 *  fresh ▶ Live viewer) ends AT ONCE - it never lingers, so it can't keep counting against max_live where relays_max and
 *  yieldRelay no longer see it. -> true when this holder held it */
function stageDrop(roomId, login, holderId, t = now(), why = "released") {
  const S = SESS.get(keyOf(roomId, String(login || "").toLowerCase()));
  if (!S || S.ended) return false;
  if (!releaseHolder(S, String(holderId), t)) return false;
  if (!held(S) && !freshViewers(S, t).length) endSession(S, why, t);
  return true;
}
/** -> {state: none | connecting | live | ended, why} for a stage slot's cam. */
function stageState(slotId, t = now()) {
  const S = stageSess(slotId);
  if (!S) {
    for (const X of SESS.values()) if (X.ended && X.lastHolds && X.lastHolds.has(String(slotId))) return { state: "ended", why: X.endWhy || "ended" };
    return { state: "none", why: null };
  }
  if (S.ended) return { state: "ended", why: S.endWhy || "ended" };
  return { state: stateOf(S, t), why: S.botWhy || null, viewers: shownCount(freshStage(S, t)) };
}
/** micfollow: the relay of `login`'s cam in room `roomId` as the mic stage sees it.
 *  -> {state: none | connecting | live | ended, why, exact (null until Pepe says), held (the mic stage holds it),
 *      mfOnly (only mic-stage holders and no fresh ▶ Live viewers), viewers (fresh stage viewers)} */
function mfState(roomId, login, t = now()) {
  const S = SESS.get(keyOf(roomId, String(login || "").toLowerCase()));
  if (!S) return { state: "none", why: null, exact: null, held: false, mfOnly: false, viewers: 0 };
  const exact = S.botInfo && typeof S.botInfo.exact === "boolean" ? S.botInfo.exact : null;
  if (S.ended) return { state: "ended", why: S.endWhy || "ended", exact, held: false, mfOnly: false, viewers: 0 };
  const holds = S.holds ? [...S.holds] : [];
  return { state: stateOf(S, t), why: S.botWhy || null, exact, held: holds.includes(MF_PREFIX + roomId),
           mfOnly: holds.length > 0 && holds.every(isMfHolder) && !freshViewers(S, t).length, viewers: shownCount(freshStage(S, t)) };
}
/** micfollow: relays held only by the mic stage (none of them for a slot or a ▶ Live viewer), site-wide. */
function mfOnlyCount(t = now()) {
  let n = 0;
  for (const S of SESS.values()) {
    if (S.ended || !held(S)) continue;
    if ([...S.holds].every(isMfHolder) && !freshViewers(S, t).length) n++;
  }
  return n;
}
/** A stage viewer asks to watch a held cam (or beats): a cam slot's (`holderId` = slot id) or the mic stage's
 *  ("mf:<room id>" + opts.login). -> {ok, whep, state, expires} | {ok, state} | throws Refuse */
async function stageWatch(u, R, holderId, { beatOnly = false, login = null } = {}, t = now()) {
  await init();
  if (!u || !u.userId) throw refuse("signin");
  if (!on()) throw refuse("off");
  const H = String(holderId);
  let S;
  if (isMfHolder(H)) {
    S = SESS.get(keyOf(R.id, String(login || "").toLowerCase()));
    if (S && !(S.holds && S.holds.has(H))) S = null;
  } else S = stageSess(H);
  if (!S || S.ended || S.roomId !== R.id) throw new Refuse(404, "That cam isn't on the stage any more.", "gone");
  const uid = String(u.userId);
  // stagefix: the pad's rule (padFull: signed in, inside an Approved pad, past the 18+ gate - padaccess.adultGate) and the
  // per-viewer gate (stageViewerWhy), on the ticket AND every beat - a block or a tighter cam mode ends their picture within a beat
  let why = (await require("./bridge-relay").padFull(uid, R.id)) ? null : "pad_access";
  if (!why) why = await stageViewerWhy(S.login, S.roomId, uid);
  if (why) { dropStageViewer(S, uid); throw refuse(why); }
  let v = S.stageViewers.get(uid);
  if (!v || t - v.beat > BEAT_MS) {
    if (beatOnly) return { ok: true, state: "ended", why: "gone" };
    if (!fitsBudget(S, t)) throw refuse("budget");
    // (👻 ghost mode is for ▶ Live and 1.99zc cam slots - never the mic stage, spec §3.5: an mf: viewer is never a ghost)
    v = { since: t, beat: t, username: u.username || null, readers: new Set(), ghost: isMfHolder(H) ? false : isGhost(uid), via: new Set() };
    S.stageViewers.set(uid, v);
  }
  if (!(v.via instanceof Set)) v.via = new Set();
  v.via.add(H);
  v.beat = t;
  if (beatOnly) return { ok: true, state: stateOf(S, t) };
  return { ok: true, whep: W().whepUrl(S.path) + "?pt=" + encodeURIComponent(readTicket(uid, S.path, t)), state: stateOf(S, t), expires: t + TICKET_MS };
}
/** micfollow: a viewer stops watching a held cam through `holderId` (their tile left the stage). */
function stageUnwatch(userId, roomId, login, holderId, t = now()) {
  const S = SESS.get(keyOf(roomId, String(login || "").toLowerCase()));
  if (!S || !S.stageViewers) return false;
  const v = S.stageViewers.get(String(userId));
  if (!v) return false;
  const via = v.via instanceof Set ? v.via : new Set();
  via.delete(String(holderId));
  if (!via.size) { S.stageViewers.delete(String(userId)); for (const rid of v.readers || []) kickReader(rid); }
  return true;
}
/** micfollow: is `login`'s cam in this room in its ended-by cooldown (an owner / mod / admin ended its relay)? */
const cooling = (roomId, login, t = now()) => (COOL.get(keyOf(roomId, String(login || "").toLowerCase())) || 0) > t;

// ── Pepe ──
const str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
const TERMINAL = new Set(["opted_out", "not_on_cam", "room_off", "slots_busy", "open_failed", "not_that_cam", "noswitch", "busy", "spawn_failed",
  "failed", "cam_closed", "ambiguous"]);   // micfollow: "ambiguous" = an exact open found two people with that name
/** Pepe's poll: his report in, the wanted cams + settings + opt-outs out. */
async function forBot(body, t = now()) {
  await init();
  body = body || {};
  sweep(t);
  BOT = { at: t, cap: body.cap === true, pool: body.pool && typeof body.pool === "object" ? body.pool : null, cfgFrom: str(body.cfg_from, 20),
          stageOffMe: body.stage_off_me === true,         // stagefix fix: he forwards "!stage off me" (stageOffMeOk)
          stageOk: body.stage_ok === true,                // stagefix: ...and "!stage ok" / "!stage no" (stageOkOk, stagepin.js)
          mf: Math.max(0, Math.min(99, Math.floor(Number(body.mf) || 0))) };   // micfollow: Pepe can do the mic stage (exact opens, proven holders)
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
  const exactMoved = [];          // micfollow: relays the mic stage holds whose exact flag changed (the pad steps at once)
  for (const x of live) {
    if (!x || typeof x !== "object") continue;
    const S = SESS.get(keyOf(str(x.room, 128), str(x.login, 40)));
    if (!S || S.ended) continue;
    seen.add(S.key);
    S.botState = str(x.state, 20);
    const wasExact = S.botInfo ? S.botInfo.exact : null;
    if (S.mf && wasExact !== (typeof x.exact === "boolean" ? x.exact : null)) exactMoved.push(S);
    S.botInfo = { grab_fps: Number(x.grab_fps) || null, grab_ms: Number(x.grab_ms) || null, size: Array.isArray(x.size) ? x.size.slice(0, 2) : null,
                  restarts: Number(x.restarts) || 0, up_s: Number(x.up_s) || 0, setup_ms: Number(x.setup_ms) || null,
                  source: x.source === "passthrough" ? "passthrough" : "reencode", fps: Number(x.fps) || null, fallback: str(x.fallback, 60) || null,
                  kbps: Number.isFinite(Number(x.kbps)) && Number(x.kbps) >= 0 ? Math.min(100000, Number(x.kbps)) : null,
                  exact: typeof x.exact === "boolean" ? x.exact : null };   // micfollow: opened / verified by its exact name
    if (S.botState === "live" && !S.liveAt) S.liveAt = t;
    if (S.botState === "ended" || S.botState === "stopped") {
      const why = str(x.why, 30);
      if (why === "opted_out") ownerClosed(S, why, t);                     // 1.99aak: a ghost keeps watching
      else if (TERMINAL.has(why)) endSession(S, why, t);
    }
  }
  for (const S of exactMoved) {
    if (S.ended) continue;
    try { require("./micfollow").onExact(S.roomId, S.login); } catch (e) { /* no mic follows */ }
  }
  for (const x of (Array.isArray(body.refused) ? body.refused.slice(0, 50) : [])) {
    const S = x && SESS.get(keyOf(str(x.room, 128), str(x.login, 40)));
    if (!S || S.ended || seen.has(S.key)) continue;
    const why = str(x.why, 30);
    S.botWhy = why;
    if (why === "opted_out") ownerClosed(S, why, t);
    else if (TERMINAL.has(why)) endSession(S, why, t);
  }
  const want = [];
  if (on()) {
    for (const S of SESS.values()) {
      if (S.ended) continue;
      const R = rooms.get ? rooms.get(S.roomId) : null;
      if (!R || R.livecams === false || !R.cams) { endSession(S, R ? "room_off" : "offline", t); continue; }
      if (optedOut(S.login) && !ownerClosed(S, "opted_out", t)) continue;     // 1.99aak: only staff in ghost mode stay
      const key = pubKey(S.path);
      if (!key) continue;
      // 1.99aaf: ghosts aren't counted; ghost_only = nobody but staff in ghost mode watches -> Pepe says nothing in the room
      const fv = freshViewers(S, t), shown = shownCount(fv);
      want.push({ room: S.roomId, login: S.login, url: W().whipUrl(S.path), token: key, path: S.path, viewers: Math.max(1, shown),
                  ...(fv.length && !shown && !held(S) ? { ghost_only: true } : {}),
                  ...(S.mf ? { mf: true } : {}),                                     // micfollow: open it by its exact name, never fuzzy
                  ...(optedOut(S.login) ? { bypass: true } : {}) });     // 1.99aak: Pepe publishes it for the ghost despite !livecam off
    }
  }
  const c = cfg();
  let cvNotify = [];
  try { cvNotify = CV().forBot(body, t); } catch (e) { cvNotify = []; }   // 1.99yq: "X opened your cam" notices for Pepe to PM
  let caAsks = [];
  try { caAsks = require("./camaccess").forBot(body, t); } catch (e) { caAsks = []; }   // 1.99aar: "X asks to watch your cam" for Pepe to PM
  let mfRooms = [];
  try { mfRooms = require("./micfollow").roomsOn(); } catch (e) { mfRooms = []; }   // micfollow: rooms with a running mic stage (early roster reads)
  // micfollow: mic-stage still jobs the site cancelled lately (a cut / the tile left): Pepe drops any he already claimed -
  // no cam open, no frame (the site-only cuts Pepe can't see himself: the mic-stage switch, exclusions, cam access, ...)
  let mfCancel = [];
  try { mfCancel = require("./bridge-relay").mfCancelled(); } catch (e) { mfCancel = []; }
  return { ok: true, v: CFG.v, cfg: Object.fromEntries(BOT_KEYS.map((k) => [k, c[k]])), want, optout: [...OPTOUT].slice(0, 5000), cv_notify: cvNotify,
           ca_asks: caAsks, mf_rooms: mfRooms, mf_cancel: mfCancel };
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
    const fresh = (x) => !!x && now() - x.beat <= BEAT_MS;
    const lv = S.viewers.get(String(c.uid)) || null;
    const sv = held(S) && S.stageViewers ? S.stageViewers.get(String(c.uid)) : null;   // 1.99zc: or a stage viewer (micfollow: any holder)
    const v = fresh(lv) ? lv : fresh(sv) ? sv : null;
    if (!v) return 403;
    // micfollow: a viewer who watches ONLY through the mic stage: only a relay Pepe opened - or verified - by the EXACT name
    // (never the wrong "Bob", §7.2 / S-19)
    const mfVia = v === sv && mfOnlyVia(v);
    if (mfVia && !(S.botInfo && S.botInfo.exact === true)) return 403;
    // 1.99aak: 👻 staff in ghost mode get past these - stagefix: never on a Stage (DF-43), so never on the mic stage either (§3.5)
    const gh = v === lv && !!v.ghost && isGhost(c.uid);
    if (optedOut(S.login) && !gh) return 403;
    if (CV().blocked(S.login, c.uid) && !gh) return 403;
    if (!(await require("./bridge-relay").padFull(c.uid, S.roomId))) return 403;
    if (v === sv && (await stageViewerWhy(S.login, S.roomId, c.uid))) { dropStageViewer(S, c.uid); return 403; }   // stagefix: the per-viewer gate
    if (b.id && /^[0-9a-f-]{36}$/i.test(String(b.id))) v.readers.add(String(b.id));
    // 1.99yq: the video really reaches them now -> Pepe PMs the cam's owner who it is (camviewers.js rate-limits it)
    // micfollow: a viewer who watches ONLY through the mic stage isn't noted one by one (one stage notice instead, OD-3)
    // (noted only when the note really went out: a viewer who later watches the same cam through a cam slot or ▶ Live
    // is still noted then)
    if (!v.noted && !mfVia) { v.noted = true; CV().noteViewers("live", S.roomId, S.login, [String(c.uid)]); }
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
    botState: S.botState, botWhy: S.botWhy, stage: (S.holds ? [...S.holds].find((h) => !isMfHolder(h)) : null) || null, mf: !!S.mf,
    stageViewers: freshStage(S, t).length }));
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
  require("./adultgate").onChange(() => recheck());     // adultgate site: viewers the 18+ gate now stops are dropped
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
  // 1.99aar: 🙋 ask the cam's owner to let you watch (their mode is members / followers / on request) + the answer so far
  const askHit = guard.limiter({ max: 30, windowMs: 60 * 60 * 1000 });
  app.post("/api/rooms/:slug/livecam/ask", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!fetchOnly(req, res)) return;
    try {
      const u = await me(req);
      if (!u) throw refuse("signin");
      if (askHit.blocked("u:" + u.userId)) return res.status(429).json({ ok: false, code: "rate", error: "That's a lot of asking - try again later." });
      askHit.hit("u:" + u.userId);
      const R = room(req);
      if (!(await require("./bridge-relay").padFull(u.userId, R.id))) throw refuse("pad_access");
      const login = String((req.body || {}).login || "").toLowerCase();
      const m = LOGIN_RE.test(login) ? memberOf(R, login) : null;
      if (!m) throw refuse("not_on_cam");
      const r = await require("./camaccess").ask(login, u, R.id);
      res.status(r.ok ? 200 : r.code === "rate" ? 429 : 409).json(r);
    } catch (e) { fail(res, e); }
  });
  app.get("/api/rooms/:slug/livecam/ask", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const u = await me(req);
      if (!u) throw refuse("signin");
      const login = String(req.query.login || "").toLowerCase();
      if (!LOGIN_RE.test(login)) return res.status(400).json({ ok: false, error: "Whose cam?" });
      res.json({ ok: true, ...(await require("./camaccess").askState(login, u.userId)) });
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
    if (!SP.can(req.user, "livecam.admin")) return json ? res.status(403).json({ ok: false, error: "Admins only." }) : res.status(403).send("Admins only.");
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
  kickReader, recheck,                // adultgate site: roomrtc ends WebRTC room listeners through kickReader too
  stageRecheck, stageViewerWhy, directorBlocked, directorBlockedSet, blockedWith, blockedSet, stageOffMeOk,   // stagefix site
  stageOkOk, bannedSet, subjectBanned,                                                                       // stagefix site (final round)
  mfState, mfOnlyCount, stageUnwatch, stageYield, stageDrop, cooling, liveCount, fitsBudget, onEnd, onOptout, keyOf, held, botOk, MF_PREFIX,   // micfollow
  dmBlockedSet,                                                                                              // train2 merge (micfollow's eligOf)
  botMf: () => (BOT && BOT.mf) || 0, botPool: () => (BOT && BOT.pool) || null, enabled: () => cfg().enabled === true, cfg,
  PREFIX, PATH_RE, FIELDS, DEFAULTS, BEAT_MS, TICKET_MS,
  END_COOLDOWN_MS, START_MS,
  _sessions: SESS,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _setKick: (fn) => { kickImpl = fn; },
  _reset: () => { SESS.clear(); BY_PATH.clear(); COOL.clear(); BOT = null; OPTOUT = new Set(); CFG = { v: 0, cfg: { ...DEFAULTS }, at: null, by: null }; ready = null; },
};
