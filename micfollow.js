// micfollow.js — 🎙 MIC FOLLOWS on a pad's own stage (v1 of layer 2, "dynamic stages"). In a pad whose stage is bridged to
// a Camfrog room, while the pad's owner has it on, whoever holds the Camfrog mic gets their cam on THAT pad's stage, and
// several people holding the mic at once are shown together in a layout the browser draws from one WebRTC (WHEP) stream
// per cam (no transcode). It is not a stage slot and not featuring, and nothing of it reaches Pepe's stream, on-air,
// Twitch, HLS, VOD, clips, snaps, the homepage, Top Pads, the guide or /api/stage.
//
//   in    Pepe's room snapshots (bridge.ingest -> onSync): R.mic with `proven` (his identity resolver says this 0x16 holder IS
//         that login - bot 1.99add + micfollow bot) and `since`; R.members (on cam). Holders without `proven` are never
//         staged (an old Pepe: the program sits idle). The 1 s timer steps pads that wait on the clock; the consent hooks
//         (livecam opt-out / relay end, camaccess, profilelayout, stage bans, the new switch) step at once.
//   rules micfollow-core.js (pure): hold >= 2 s, hand-over, min on stage, cooldown, a change budget, layouts, pictures.
//   video livecam.js sessions held by the holder "mf:<room id>" (shared with a manual cam slot / ▶ Live viewers), Pepe opens
//         them by exact name; viewers ask POST /api/rooms/:slug/micfollow/watch for a ticket of their own (the live-cam
//         audience: signed in, padaccess.full, the 💎 bridge perk, no bridge block on live cams, not blocked by the cam's
//         owner, the owner's cam-access mode, the bandwidth budget). Degrades: fewer live tiles -> stills (a quiet snapshot
//         every 20 s, never saveable) -> name cards.
//   page  /api/rooms/:slug/live carries stage_program (per viewer; bridge.liveView), the stage draws "🎙 On the mic"
//         (public/js/stage-mic.js).
// Consent: the live-cam rules + "Pads may put my cam on their stage while I hold the mic" (micfollow_optout, default on) +
// never a cam whose owner's mode is followers / on request + the pad's exclusions + stage bans; an opt-out cuts within ~2 s.
// A cut that lands while a hold or a still job is on its way never opens the cam (wantsCam: livecam re-checks it after
// the hold's awaits, bridge-relay before Pepe gets a still job); a relay only the mic stage held ends when it lets go.
// relays_max covers every relay only the mic stage holds (warm ones whose ▶ Live viewers left too); ▶ Live, manual cam
// slots and Pepe's own "full" win (yieldRelay / shed).
// Off by default per pad (micfollow_pads) and site-wide on prod (micfollow_cfg.enabled, the staff kill switch).
// Records: micfollow_spans = one row per person-on-stage span (30 days; the person sees theirs on the privacy card, admins
// on /stage/admin) - the privacy record of "why was my cam shown". Console lines carry no logins or names.
// Before prod (addendum 14.1.2, owner-accepted 2026-10-19):
//   notice first   the pad's first notice goes out at the person's first qualifying grab there (inbox, or a Camfrog PM via
//                  Pepe queued under the pad owner - or, on a house pad, under Pepe's own account); they can be picked only
//                  notice_lead_s (120 s) later. Re-notices per pad every notice_gap_h never re-gate. micfollow_notices.
//   blocks         a viewer and the person shown who DM-blocked each other (dm_blocks, either way) get "isn't available"
//                  and no ticket; a person who blocked the pad owner from their cam (cam_blocks) is never put on that
//                  owner's mic stage (CUT blocked_owner). train2 merge (stagefix): a DM block either way with the pad's
//                  owner, or "Take me off this Stage" on this pad, is the neutral CUT "unavailable" - the rules
//                  livecam.stageConsent refuses a hold for, so they aren't re-picked every cooldown_s.
//   bans           a site ban of a linked account (a whole-site or this pad's feed ban, an archived account) or Pepe's own
//                  refusal of the login (feed_restricted: red list, a recent kick / ban here) cut like a stage ban.
//   Clear / report the owner's 🧹 Clear the stage (everyone off, frozen); ⚑ on each tile for viewers: the reporter's view
//                  hides at once; two distinct qualified reporters (engagement.qualified, not each other's alts) within
//                  report_window_s cut the person and keep them off this pad's mic stage report_out_h, pending staff
//                  review (/stage/admin: dismiss lifts it and voids those reporters' weight on them for 24 h). micfollow_reports.
//   18+ pads       mic follows can't be switched on, and stops, on a pad marked 18+ (until a per-pad ask flow exists).
//   viewers        counted, never named, to the person shown (livecam.watchersOf `mf` -> camviewers.watching mic_stage_n).
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery, tx } = require("./dbUtils");
const SP = require("./siteperms");
const guard = require("./middleware/authGuard");
const core = require("./micfollow-core");

const STAGING = !!process.env.STAGING;
const LOGIN_RE = /^[\w.\-]{1,40}$/;
const SECRET = process.env.SECRET_KEY || crypto.randomBytes(32).toString("hex");
const AUDIT = "micfollow_cfg";
const GATE_MS = 30 * 1000, BAN_MS = 60 * 1000, MANAGE_MS = 30 * 1000;
const YIELD_BLOCK_MS = 60 * 1000;

let clock = () => Date.now();
const now = () => clock();
let bootAt = Date.now();             // R.mic reloaded from the DB after a site restart is never acted on (it predates this)
const LC = () => require("./livecam");
const BR = () => require("./bridge");
const ROOMS = () => require("./rooms");
const CV = () => require("./camviewers");
const MFH = (roomId) => "mf:" + String(roomId);
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();
const bridgeOk = (id) => { try { return require("./premium").bridgeAllowed(id); } catch (e) { return true; } };
const webrtcOn = () => { try { return !!require("./webrtc").enabled(); } catch (e) { return false; } };
class Refuse extends Error { constructor(status, msg, code, extra) { super(msg); this.status = status; this.refuse = true; this.code = code; this.extra = extra || null; } }

// ── settings ──
let CFG = { v: 0, cfg: { ...core.DEFAULTS }, at: null, by: null };
const cfg = () => CFG.cfg;

// ── state (in memory) ──
const PADS = new Map();        // room id -> {roomId, settings, state (core), stills: Map(login -> {next}), spans: Map(login -> Promise<id>), cold: [ms]}
let MFOPT = new Set();         // logins who switched the mic stage off for their cam
const EXCL = new Map();        // room id -> Map(login -> {until (null = always), reason, by, at, user_id})
const FACTS = new Map();       // login -> {userIds, priv, at}
const BANS = new Map();        // "login|room" -> {b, at}: a stage ban, a site ban of a linked account, or Pepe's refusal of the login
const INFLIGHT = new Map();    // "login|room" -> Promise
const HOLDING = new Set();     // the relay holds on their way (doHold) - only so the tests' _idle can wait for them too
const GATE = new Map();        // "login|userId" -> {code, at}
const BLK = new Map();         // "room|userId" -> {b, at}
const MANAGE = new Map();      // "userId|room" -> {ok, at}
const NOTES = new Map();       // "room|login" -> {first, last} (micfollow_notices; read by refresh) + {busy, retryAt} in flight
const HIDE = new Map();        // "room|userId" -> Map(login -> until): tiles a viewer reported are hidden for them
const COLD = [];               // cold opens site-wide (times)
let pendingCold = 0;
let yieldUntil = 0;            // a manual cam slot was just given a relay: no cold opens until its retry is through (§7.4)
let shedUntil = 0;             // Pepe refused a manual cam / ▶ Live as full: no cold opens or stills, stills stop (§7.1)
const YIELD_WINDOW_MS = 10 * 1000, SHED_MS = 60 * 1000;
const POOL_FREE = 2;           // Pepe's open cams mic follows always leaves for ▶ Live and manual cam slots
const RELAYS_GRACE_MS = 5 * 1000;   // relays only the mic stage holds above relays_max for this long: the excess is given up
let relaysOverSince = 0;

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS micfollow_cfg (id INTEGER PRIMARY KEY CHECK (id = 1), v INTEGER NOT NULL, data TEXT NOT NULL,
                      updated_at INTEGER, updated_by TEXT)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS micfollow_pads (room_id TEXT PRIMARY KEY, on_ INTEGER NOT NULL DEFAULT 0, layout TEXT, default_view TEXT,
                      max_people INTEGER, max_live INTEGER, updated INTEGER, updated_by TEXT)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS micfollow_excl (room_id TEXT NOT NULL, login TEXT NOT NULL, user_id TEXT, until INTEGER, reason TEXT NOT NULL,
                      by TEXT, at INTEGER NOT NULL, PRIMARY KEY (room_id, login))`);
      await runQuery(`CREATE TABLE IF NOT EXISTS micfollow_optout (login TEXT PRIMARY KEY, off INTEGER NOT NULL, updated INTEGER NOT NULL, user_id TEXT)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS micfollow_spans (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, login TEXT NOT NULL,
                      started INTEGER NOT NULL, ended INTEGER, secs INTEGER, video_secs INTEGER, peak_viewers INTEGER, end_reason TEXT,
                      noticed INTEGER NOT NULL DEFAULT 0)`);
      await runQuery("CREATE INDEX IF NOT EXISTS micfollow_spans_login ON micfollow_spans (login, started)");
      await runQuery("CREATE INDEX IF NOT EXISTS micfollow_spans_started ON micfollow_spans (started)");
      // the pad's notices to a person (DF-11: the first one gates their first pick there by notice_lead_s)
      await runQuery(`CREATE TABLE IF NOT EXISTS micfollow_notices (room_id TEXT NOT NULL, login TEXT NOT NULL, first_at INTEGER, last_at INTEGER,
                      PRIMARY KEY (room_id, login))`);
      // ⚑ reports on mic-stage tiles (DF-31), kept for staff review
      await runQuery(`CREATE TABLE IF NOT EXISTS micfollow_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, login TEXT NOT NULL,
                      reporter_id TEXT NOT NULL, reason TEXT, at INTEGER NOT NULL, qualified INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'open',
                      resolved_by TEXT, resolved_at INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS micfollow_reports_subject ON micfollow_reports (room_id, login, at)");
      await runQuery("CREATE INDEX IF NOT EXISTS micfollow_reports_reporter ON micfollow_reports (reporter_id, at)");
      const r = (await getQuery("SELECT v, data, updated_at, updated_by FROM micfollow_cfg WHERE id = 1"))[0];
      if (r) {
        let d = {};
        try { d = JSON.parse(r.data) || {}; } catch (e) { d = {}; }
        CFG = { v: Number(r.v) || 0, cfg: core.normalize(d, { lenient: true }).cfg, at: r.updated_at || null, by: r.updated_by || null };
      }
      for (const p of await getQuery("SELECT * FROM micfollow_pads")) {
        const P = padOf(p.room_id, true);
        P.settings = core.normalizePad({ on: !!p.on_, layout: p.layout, default_view: p.default_view, max_people: p.max_people, max_live: p.max_live },
          { lenient: true }).cfg;
      }
      MFOPT = new Set((await getQuery("SELECT login FROM micfollow_optout WHERE off = 1")).map((x) => low(x.login)));
      EXCL.clear();
      for (const e of await getQuery("SELECT * FROM micfollow_excl")) exclMap(e.room_id).set(low(e.login), rowExcl(e));
      // a span open at a site restart is closed now (the program lives in memory)
      const t = now();
      // ⚑ a tile someone reported stays hidden for them across a restart (24 h)
      for (const r of await getQuery("SELECT room_id, login, reporter_id, at FROM micfollow_reports WHERE at > ?", [t - 24 * 3600e3])) {
        const k = String(r.room_id) + "|" + String(r.reporter_id);
        const m = HIDE.get(k) || new Map();
        m.set(low(r.login), Math.max(m.get(low(r.login)) || 0, Number(r.at) + 24 * 3600e3));
        HIDE.set(k, m);
      }
      await runQuery("UPDATE micfollow_spans SET ended = ?, secs = MAX(0, ROUND((? - started) / 1000.0)), end_reason = 'restart' WHERE ended IS NULL", [t, t]);
      // until cam access has loaded, nobody's mode is known: the mode check fails closed (mode_closed) and retries the load
      try { await require("./camaccess").init(); } catch (e) { console.error("[micfollow] camaccess:", e.message); }
      try { LC().onEnd(onSessionEnd); LC().onOptout((login) => { recheck(login).catch(() => {}); }); } catch (e) { /* no live cams */ }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
let loaded = false;
function padOf(roomId, create) {
  const id = String(roomId || "");
  let P = PADS.get(id);
  if (!P && create && id) {
    P = { roomId: id, settings: { ...core.PAD_DEFAULTS }, state: core.newState(), stills: new Map(), spans: new Map(), cold: [], met: new Map() };
    PADS.set(id, P);
  }
  return P || null;
}
const exclMap = (roomId) => { let m = EXCL.get(String(roomId)); if (!m) { m = new Map(); EXCL.set(String(roomId), m); } return m; };
const rowExcl = (e) => ({ until: e.until == null ? null : Number(e.until), reason: e.reason || "owner", by: e.by || null, at: Number(e.at) || 0, user_id: e.user_id || null });
/** Is `login` kept off this pad's mic stage? By that Camfrog login, or - for an exclusion made by PATV name - by the PATV
 *  account: `userIds` = the accounts linked to `login` NOW (so a later re-link to another Camfrog name is still caught). */
function excluded(roomId, login, t = now(), userIds = null) {
  const m = EXCL.get(String(roomId));
  if (!m) return false;
  const live = (e) => !!(e && (e.until == null || e.until > t));
  if (live(m.get(login))) return true;
  if (userIds && userIds.length) {
    const ids = new Set(userIds.map(String));
    for (const e of m.values()) if (e.user_id && ids.has(String(e.user_id)) && live(e)) return true;
  }
  return false;
}

// ── logs: no logins, no names (a per-person tag that changes every day) ──
function ptag(login, t = now()) {
  return crypto.createHmac("sha256", SECRET).update(new Date(t).toISOString().slice(0, 10) + "|" + low(login)).digest("hex").slice(0, 8);
}

// ── metrics (counts and durations, 24 h, in memory) ──
const MET = new Map();        // hour -> {key: n}
const LAT = { warm: [], cold: [] };
const PER_MIN = new Map();    // minute -> changes (site-wide)
let PEAK = 0;
/** Count k: site-wide, and for pad P too when given (§12: per pad and site-wide). */
function bump(k, n = 1, t = now(), P = null) {
  const h = Math.floor(t / 3600e3);
  for (const M of P && P.met ? [MET, P.met] : [MET]) {
    let b = M.get(h);
    if (!b) { b = {}; M.set(h, b); for (const x of [...M.keys()]) if (x < h - 24) M.delete(x); }
    b[k] = (b[k] || 0) + n;
  }
}
/** The last 24 h of counts in an hour map. */
function countsOf(M, t = now()) {
  const h = Math.floor(t / 3600e3), out = {};
  for (const [x, b] of M || []) if (x > h - 24) for (const [k, n] of Object.entries(b)) out[k] = (out[k] || 0) + n;
  return out;
}
function metrics(t = now()) {
  const out = countsOf(MET, t);
  const pct = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  const lat = (k) => { const a = LAT[k].filter((x) => t - x.at < 24 * 3600e3).map((x) => x.ms); return { n: a.length, p50: pct(a, 0.5), p95: pct(a, 0.95) }; };
  const mins = [...PER_MIN.entries()].filter(([m]) => m > Math.floor(t / 60000) - 24 * 60).map(([, n]) => n);
  let tiles = 0, live = 0, stills = 0;
  for (const P of PADS.values()) for (const x of P.state.tiles) { tiles++; if (x.video === "still") stills++; if (core.liveish(x)) live++; }
  let mfOnly = 0;
  try { mfOnly = LC().mfOnlyCount(t); } catch (e) { mfOnly = 0; }
  return { counts: out, qualify_to_picture: { warm: lat("warm"), cold: lat("cold") }, changes_per_min: { max: mins.length ? Math.max(...mins) : 0, p95: pct(mins, 0.95) || 0 },
           peak_viewers: PEAK, current: { tiles, live, stills, mf_only_relays: mfOnly } };
}

// ── who may be shown (§4.1) ──
const memberOf = (R, login) => ((R && R.members) || []).find((x) => x && !x.anon && !x.self && low(x.login) === login) || null;
/** The cam owner's access mode - null while it can't be read (cam access not loaded / failing): that FAILS CLOSED. */
let caRetryAt = 0;
function modeOf(login, t = now()) {
  try {
    const CA = require("./camaccess");
    if (typeof CA.loaded === "function" && !CA.loaded()) {
      if (t - caRetryAt > 30 * 1000) {                      // try the load again now and then; once it's in, every pad steps
        caRetryAt = t;
        Promise.resolve().then(() => CA.init()).then(() => clearAll(), (e) => console.error("[micfollow] camaccess:", e && e.message));
      }
      return null;
    }
    return CA.accessOf(login).mode;
  } catch (e) { return null; }
}
/** Pepe's hidden list (!bridge hide / !incognito), as the site keeps it - a second check beside his redacted roster
 *  (which can be up to a sync old, and the stale hold rides out a missing sync). */
const hiddenLogin = (login) => { try { return !!require("./quotes").isHidden(login); } catch (e) { return false; } };
/** E(login) in pad P (bridge room R): "ok" | "off_cam" | "pending" (not known yet) | a CUT code. Unknown facts are fetched. */
function eligOf(P, R, login, t, want) {
  if (!memberOf(R, login)) return "not_member";
  if (hiddenLogin(login)) return "hidden";
  if (LC().optedOut(login)) return "opted_out";
  if (MFOPT.has(login)) return "mf_opted_out";
  const c = cfg();
  const f = FACTS.get(login);
  if (!f || t - f.at > c.private_cache_s * 1000) want.add(login);
  if (f && f.priv) return "private";
  if (excluded(P.roomId, login, t, f ? f.userIds : null)) return "excluded";
  const b = BANS.get(login + "|" + P.roomId);
  if (!b || t - b.at > BAN_MS) want.add(login);
  if (b && b.b) return "banned";                       // a stage ban, a site ban of a linked account, Pepe's own refusal
  // train2 merge: stagefix's "Take me off this Stage" on this pad (stageleave.js memory, synchronous) - livecam.stageConsent
  // refuses every hold meanwhile, so it is a sticky CUT here too (the neutral "unavailable"), not a re-pick every cooldown_s
  if (stageLeftHere(P.roomId, login, t)) return "unavailable";
  // the person blocked the pad's owner from their cam (cam_blocks): never on that owner's mic stage (D-17 "against the director")
  const owner = padOwnerId(P.roomId);
  if (owner) { try { if (CV().blocked(login, owner)) return "blocked_owner"; } catch (e) { /* no cam blocks */ } }
  // train2 merge: a DM block either way with the pad's owner (livecam.dmBlockedSet, read by refresh) - the DM half of
  // stageConsent's block rule; the same neutral "unavailable" (never which)
  if (b && b.blk) return "unavailable";
  const mode = modeOf(login, t);
  if (mode == null || mode === "followers" || mode === "request") return "mode_closed";
  if (LC().cooling(P.roomId, login, t)) return "ended_by";
  const n = NOTES.get(P.roomId + "|" + login);
  if (!n) want.add(login);
  if (!f || !b || !n) return "pending";
  // DF-11: the pad's first notice went out at least notice_lead_s ago (sent at the first qualifying grab: notice_first)
  if (!n.first || t - n.first < c.notice_lead_s * 1000) return "notice";
  return memberOf(R, login).on_cam === true ? "ok" : "off_cam";
}
/** stagefix: is `login` keeping their cam off this pad's Stage ("Take me off this Stage")? Synchronous (stageleave.js keeps
 *  them in memory; refresh() makes sure it has loaded). */
function stageLeftHere(roomId, login, t) {
  try { return require("./stageleave").excludedUntil(roomId, login, t) > 0; } catch (e) { return false; }
}
/** The pad owner's PATV account (a house pad has none). */
function padOwnerId(roomId) {
  try { const p = ROOMS().getCached(roomId); return p && p.owner && p.owner.userId ? String(p.owner.userId) : null; } catch (e) { return null; }
}
/** An 18+ pad (rooms_registry.adult): mic follows can't run there until a per-pad ask flow exists (addendum 14.1.2 #8). */
function padAdult(roomId) {
  try { const p = ROOMS().getCached(roomId); return !!(p && p.adult); } catch (e) { return false; }
}
/** A site ban of one of the linked accounts (a whole-site or this pad's feed ban, an archived account) or Pepe's own
 *  refusal of the login (feed_restricted: the red list, a recent kick / ban - this room or everywhere). A missing table =
 *  no such ban; any other failure fails closed. */
async function siteBanned(login, ids, roomId, t) {
  const q = async (sql, args) => {
    try { return await getQuery(sql, args); } catch (e) { if (/no such (table|column)/i.test(String(e && e.message))) return []; throw e; }
  };
  try {
    if (ids.length) {
      const ph = ids.map(() => "?").join(",");
      if ((await q(`SELECT 1 AS x FROM feed_bans WHERE user_id IN (${ph}) AND (room_id = '' OR room_id = ?) AND (until IS NULL OR until > ?) LIMIT 1`, [...ids, roomId, t])).length) return true;
      if ((await q(`SELECT 1 AS x FROM users WHERE userId IN (${ph}) AND archived_at IS NOT NULL LIMIT 1`, ids)).length) return true;
    }
    return (await q("SELECT 1 AS x FROM feed_restricted WHERE login = ? AND (room_id = '' OR room_id = ?) AND (until IS NULL OR until > ?) LIMIT 1", [login, roomId, t])).length > 0;
  } catch (e) { console.error("[micfollow] site bans:", e.message); return true; }
}
/** Fetch "private activity" + stage bans for a login (linked accounts), then step the pad. Fails closed on private.
 *  force: a hook says it just changed - a fetch already on its way may have read the old value, so another one follows it. */
function refresh(login, roomId, { force = false } = {}) {
  const k = login + "|" + roomId;
  if (INFLIGHT.has(k)) return force ? INFLIGHT.get(k).then(() => refresh(login, roomId)) : INFLIGHT.get(k);
  const p = (async () => {
    // train2 merge: stagefix's block rule for a Stage (livecam.directorBlocked - no actor on the mic stage, so blocks with the
    // pad's owner), the check stageConsent refuses a hold for. Its cam_blocks half eligOf reads live (blocked_owner); this is
    // its DM half (livecam.dmBlockedSet, the same rows both ways), cached like the bans. A throw fails closed; a dm_blocks
    // read that fails is "no block" there, as in stageConsent, so the two always agree. Started first and awaited below, so
    // it runs beside the ban look-ups instead of after them. Plus stageleave's "Take me off this Stage" memory, which eligOf
    // reads synchronously (loaded once).
    const owner = padOwnerId(roomId);
    const blkP = (async () => { try { return owner ? (await LC().dmBlockedSet([login], [owner])).has(login) : false; } catch (e) { return true; } })();
    const slP = (async () => { try { await require("./stageleave").init(); } catch (e) { /* no stageleave */ } })();
    let ids = [];
    try { ids = (await getQuery("SELECT userId FROM users WHERE lower(camfrogUsername) = ?", [login])).map((u) => String(u.userId)); } catch (e) { ids = []; }
    let priv = false;
    try { priv = (await require("./stories").privateLogins([login])).has(login); } catch (e) { priv = true; }
    let b = false;
    for (const id of ids) {
      try { if (await require("./mainstage").isBanned(id, roomId)) { b = true; break; } } catch (e) { /* no stage */ }
    }
    if (!b) b = await siteBanned(login, ids, roomId, now());
    const blk = await blkP;
    await slP;
    // the pad's notices to this person (DF-11); a failed read leaves them "pending" (never picked)
    let note = null;
    try {
      const r = (await getQuery("SELECT first_at, last_at FROM micfollow_notices WHERE room_id = ? AND login = ?", [String(roomId), login]))[0];
      note = { first: r && r.first_at != null ? Number(r.first_at) : null, last: r && r.last_at != null ? Number(r.last_at) : null };
    } catch (e) { note = null; }
    const t = now();
    const was = FACTS.get(login), wasB = BANS.get(k);
    FACTS.set(login, { userIds: ids, priv, at: t });
    BANS.set(k, { b, blk, at: t });
    if (FACTS.size > 5000) FACTS.delete(FACTS.keys().next().value);
    if (BANS.size > 5000) BANS.delete(BANS.keys().next().value);
    let notesMoved = false;
    if (note) {
      const nk = String(roomId) + "|" + login, cur = NOTES.get(nk);
      // what this process sent meanwhile wins over an older read
      const next = { ...(cur || {}), first: (cur && cur.first) || note.first, last: Math.max((cur && cur.last) || 0, note.last || 0) || null };
      notesMoved = !cur || cur.first !== next.first;
      NOTES.set(nk, next);
      if (NOTES.size > 20000) NOTES.delete(NOTES.keys().next().value);
    }
    return !was || was.priv !== priv || !wasB || wasB.b !== b || wasB.blk !== blk || notesMoved;
  })().then((moved) => { INFLIGHT.delete(k); if (moved) stepPad(roomId); return moved; },
            (e) => { INFLIGHT.delete(k); console.error("[micfollow] refresh:", e.message); return false; });
  INFLIGHT.set(k, p);
  return p;
}

/**
 * Does the mic stage still want `login`'s cam in pad P right now? kind "hold": a tile whose hold is on its way; "still": a
 * still tile. Plus: the pad runs and E(login) is "ok" (the mic-stage switch, private activity, the pad's exclusions, stage
 * bans, cam access, ...). Synchronous - livecam.stageHold asks it AFTER its awaits (opts.ok) and bridge-relay before it
 * hands Pepe a still job: a cut that lands while either is on its way never opens the cam (§4.3).
 */
function wantsCam(P, login, kind, t = now()) {
  if (!P || !loaded || !P.settings.on) return false;
  const l = low(login);
  const x = core.tileOf(P.state, l);
  if (!x) return false;
  if (kind === "hold" ? !x.pend : x.video !== "still" || !P.stills.has(l)) return false;
  const R = roomOf(P.roomId);
  if (!R) return false;
  const w = whyOff(P, R, t);
  if (w && w !== "stale") return false;
  return eligOf(P, R, l, t, new Set()) === "ok";
}
/** bridge-relay: is this mic-stage still job still wanted? */
const stillWanted = (roomId, login, t = now()) => wantsCam(PADS.get(String(roomId)), login, "still", t);

// ── RUN (§3.2) ──
function whyOff(P, R, t) {
  const c = cfg();
  if (!P.settings.on) return "pad_off";
  if (!c.enabled) return "site_off";
  if (padAdult(P.roomId || (R && R.id))) return "adult";              // an 18+ pad (addendum 14.1.2 #8): no mic follows yet
  const L = LC();
  if (!L.enabled()) return "livecams_off";
  if (!webrtcOn()) return "webrtc_off";
  if (!R || !R.cams || R.livecams === false) return "room_off";
  if (!bridgeOk(R.id)) return "prime";
  if (!L.botOk(t)) return "pepe";
  if (L.botMf() < 1) return "pepe_old";
  if (!(Number(R.updated) >= bootAt) || t - Number(R.updated) > c.sync_fresh_s * 1000) return "stale";
  return null;
}
/** R.mic -> {holders: proven real logins (the only people ever staged), unproven (count), others: [{key, since}] the holders
 *  nobody can show (unproven, anonymous, account keys, bots - for the neutral "Someone is speaking" card, never a tile),
 *  pepe: since | true | null (Pepe himself holds the mic)}. */
function holdersOf(R) {
  const out = [], seen = new Set(), others = [];
  let unproven = 0, pepe = null;
  const sinceOf = (u) => (Number.isFinite(u.since) ? u.since : undefined);
  (((R && R.mic) || [])).forEach((u, i) => {
    if (!u) return;
    if (u.self) { pepe = Number.isFinite(u.since) ? u.since : true; return; }
    const l = low(u.login);
    // a key that never names anyone to the page (an anonymous entry has no login: its place in the list)
    const okey = () => (u.anon || !LOGIN_RE.test(l) ? "anon:" + String(u.id || u.display || i).slice(0, 60) : "x:" + l);
    if (u.anon || u.bot || u.acct || !LOGIN_RE.test(l)) { others.push({ key: okey(), since: sinceOf(u) }); return; }
    if (u.proven !== true) { unproven++; others.push({ key: okey(), since: sinceOf(u) }); return; }
    if (seen.has(l)) return;
    seen.add(l);
    out.push({ login: l, since: sinceOf(u) });
  });
  return { holders: out, unproven, others, pepe };
}
function siteBudget(P, t) {
  const c = cfg(), L = LC(), lc = L.cfg();
  while (COLD.length && t - COLD[0] > 60 * 1000) COLD.shift();
  P.cold = P.cold.filter((x) => t - x < 60 * 1000);
  let stills = 0;
  for (const Q of PADS.values()) for (const x of Q.state.tiles) if (x.video === "still") stills++;
  const mfOnly = L.mfOnlyCount(t);
  const yielding = t < yieldUntil;                 // a manual cam slot is taking the relay we gave up: don't race it
  const coldLeft = c.cold_open && !yielding ? Math.max(0, Math.min(c.relays_max - mfOnly - pendingCold, lc.max_live - L.liveCount() - pendingCold,
    c.cold_opens_per_min - COLD.length, c.cold_opens_per_pad - P.cold.length)) : 0;
  // Pepe's cam pool (his learned capacity, else pool_max): every relay (▶ Live, cam slots, the mic stage's) and every
  // still is an open cam there - mic follows opens nothing new that would leave fewer than POOL_FREE for ▶ Live and
  // manual cam slots
  let poolCap = Number(lc.pool_max) || 6;
  try { const bp = L.botPool ? L.botPool() : null; if (bp && Number(bp.capacity) > 0) poolCap = Number(bp.capacity); } catch (e) { /* the knob */ }
  const poolLeft = Math.max(0, poolCap - POOL_FREE - L.liveCount() - stills - pendingCold);
  return { maxLive: lc.max_live, coldLeft, stillsLeft: c.stills ? Math.max(0, c.stills_max - stills) : 0, poolLeft, shed: t < shedUntil };
}
const roomOf = (roomId) => { try { return BR()._rooms.get(String(roomId)) || null; } catch (e) { return null; } };

/** Run the engine for one pad (synchronous; never awaits). R = its bridge room (looked up when not given). */
function stepPad(roomId, t = now(), R) {
  const P = PADS.get(String(roomId));
  if (!P || !loaded) return null;
  if (R === undefined) R = roomOf(roomId);
  const why = whyOff(P, R, t);
  if (why === "pad_off" && !P.state.tiles.length && P.state.whyOff === "pad_off") return null;
  const { holders, unproven, others, pepe } = R ? holdersOf(R) : { holders: [], unproven: 0, others: [], pepe: null };
  const elig = new Map(), sess = new Map(), want = new Set();
  if (!why || why === "stale") {
    for (const l of new Set([...holders.map((h) => h.login), ...P.state.tiles.map((x) => x.login)])) {
      elig.set(l, R ? eligOf(P, R, l, t, want) : "not_member");
      sess.set(l, LC().mfState(P.roomId, l, t));
    }
  }
  const s = P.settings, c = cfg();
  // the site knobs max_people / max_live cap every pad's own (§3.6: an owner may only narrow them)
  const input = { why_off: why, holders: why ? [] : holders, unproven_n: unproven, elig, sess, others: why ? [] : others, pepe: why ? null : pepe,
                  pad: { layout: s.layout, max_people: Math.min(s.max_people, c.max_people), max_live: Math.min(s.max_live, c.max_live), default_view: s.default_view },
                  room: { cams: !!(R && R.cams) }, site: siteBudget(P, t) };
  if (!why) { bump("holders_seen", holders.length + unproven, t, P); bump("proven", holders.length, t, P); bump("unproven", unproven, t, P); }
  const r = core.step(P.state, input, cfg(), t);
  apply(P, R, r.actions, t);
  for (const l of want) refresh(l, P.roomId);
  return r;
}

/** Carry out the engine's actions. */
function apply(P, R, actions, t) {
  let touch = null, add = 0, rem = 0, cut = 0;
  const who = [];                                // per-person tags for the log line (a daily HMAC, never the login)
  for (const a of actions || []) {
    switch (a.a) {
      case "hold": doHold(P, a.login, a.cold, t); break;
      // a relay only the mic stage held (no cam slot, no ▶ Live viewer) ends at once - it never lingers against max_live
      case "release": try { LC().stageDrop(P.roomId, a.login, MFH(P.roomId), t, "mf_released"); } catch (e) { /* none */ } break;
      case "still": P.stills.set(a.login, { next: t }); bump("stills_started", 1, t, P); stillTick(P, t); break;
      // a still stops (live now, left, cut): its queued / claimed job is cancelled - Pepe never takes a frame of someone
      // the mic stage no longer shows (a cut person above all)
      case "still_stop": P.stills.delete(a.login); try { require("./bridge-relay").mfSnapCancel(P.roomId, a.login); } catch (e) { /* no relay */ } break;
      case "span_open": spanOpen(P, a.login, t); bump("adds", 1, t, P); add++; who.push("+" + ptag(a.login, t)); break;
      case "span_close": spanClose(P, a, t); bump("removes", 1, t, P); bump("remove:" + a.reason, 1, t, P); if (String(a.reason).startsWith("cut:")) cut++; else rem++;
        who.push("-" + ptag(a.login, t) + ":" + a.reason);
        if (a.peak > PEAK) PEAK = a.peak; break;
      case "picture":
        if (a.lat != null) { const k = a.warm ? "warm" : "cold"; LAT[k].push({ ms: a.lat, at: t }); if (LAT[k].length > 500) LAT[k].shift(); }
        renotice(P, R, a.login, t).catch((e) => console.error("[micfollow] notice:", e.message));
        break;
      // DF-11: the pad's first notice, at the first qualifying grab - the person can be picked notice_lead_s after it
      case "notice_first": firstNotice(P, R, a.login, t).catch((e) => console.error("[micfollow] notice:", e.message)); break;
      case "spam": bump("grab_spam", a.n || 1, t, P); break;
      case "touch": touch = touch || a.why; if (a.why === "change") { const m = Math.floor(t / 60000); PER_MIN.set(m, (PER_MIN.get(m) || 0) + 1); if (PER_MIN.size > 1500) PER_MIN.delete(PER_MIN.keys().next().value); bump("changes", 1, t, P); } break;
      case "deferred": bump("deferred", 1, t, P); break;
      default: break;
    }
  }
  if (touch) {
    try { BR().touch(P.roomId); } catch (e) { /* no bridge */ }
    const S = P.state;
    console.log(`[micfollow] pad=${P.roomId} v=${S.v} tiles=${S.tiles.length} layout=${core.shapeOf(S, P.settings)} +${add} -${rem} cut=${cut} why=${touch}` +
                (who.length ? " p=" + who.join(",") : ""));
  }
}
function doHold(P, login, cold, t) {
  const R = roomOf(P.roomId);
  if (cold) { COLD.push(t); P.cold.push(t); pendingCold++; }
  const done = (ok, code) => {
    if (cold) pendingCold = Math.max(0, pendingCold - 1);
    if (code !== "gone") {
      bump((cold ? "cold_" : "warm_") + (ok ? "ok" : "failed"), 1, now(), P);
      if (!ok) bump("open_failed:" + code, 1, now(), P);
    } else bump("hold_withdrawn", 1, now(), P);
    // (a hold that came back for a tile that left meanwhile is released at once: livecam.stageDrop ends a relay nobody else
    // holds or watches, so nothing lingers on in Pepe's want list)
    apply(P, roomOf(P.roomId), core.holdDone(P.state, login, ok, code, cfg(), now()), now());
    // livecam refused on consent (opted out / private activity): re-read the facts, so the next step knows it too
    // (train2 merge: stagefix's neutral "unavailable" is such a refusal too)
    if (!ok && (code === "opted_out" || code === "unavailable")) recheck(login, { refresh: true }).catch(() => {});
    else if (!ok && code === "gone") stepPad(P.roomId);
  };
  if (!R) { done(false, "offline"); return; }
  // opts.ok: the mic stage's own rules, re-checked by livecam after its awaits, right before the hold (§4.3)
  const p = Promise.resolve().then(() => LC().stageHold(R, login, MFH(P.roomId), t, { mf: true, ok: () => wantsCam(P, login, "hold") }))
    .then(() => done(true, null), (e) => done(false, e && e.refuse ? e.code : "failed"));
  // train2 merge: stagefix's stageConsent made a hold several look-ups longer, so the tests' _idle waits for holds as well
  // (finally: a throw in done() still surfaces as before)
  HOLDING.add(p);
  p.finally(() => HOLDING.delete(p));
}
function spanOpen(P, login, t) {
  const n = NOTES.get(P.roomId + "|" + login);
  const noticed = n && n.last && t - n.last < cfg().notice_gap_h * 3600e3 ? 1 : 0;   // the span is covered by a notice
  const p = runQuery("INSERT INTO micfollow_spans (room_id, login, started, noticed) VALUES (?, ?, ?, ?)", [P.roomId, login, t, noticed])
    .then((r) => (r && r.id ? Number(r.id) : null)).catch((e) => { console.error("[micfollow] span:", e.message); return null; });
  P.spans.set(login, p);
}
function spanClose(P, a, t) {
  const p = P.spans.get(a.login);
  P.spans.delete(a.login);
  if (!p) return;
  p.then((id) => id && runQuery(`UPDATE micfollow_spans SET ended = ?, secs = MAX(0, ROUND((? - started) / 1000.0)), video_secs = ?, peak_viewers = ?, end_reason = ?
                                 WHERE id = ? AND ended IS NULL`, [t, t, Math.round((a.video_ms || 0) / 1000), a.peak || 0, String(a.reason || "").slice(0, 40), id]))
    .catch((e) => console.error("[micfollow] span:", e.message));
}

// ── the person shown: the pad's FIRST notice before their first pick there (DF-11), then one per pad per notice_gap_h ──
const PEPE_ACCOUNT = "pepe-bot";                 // Pepe's own site account (feedstore.PEPE_ID): house pads queue their PMs under it
/** Deliver the notice. kind "first" = before the first pick ("you can show there in about N minutes"), "again" = a
 *  re-notice while they show. Linked: the inbox (+ a Camfrog PM if their preference allows, rooms.notify). Not linked: a
 *  Camfrog PM via Pepe, queued under the pad owner's account, or Pepe's own on a house pad (D-19: there is no public room
 *  line for the mic stage). -> true when it went out */
async function sendNotice(P, R, login, t, kind) {
  const pad = (() => { try { return ROOMS().getCached(P.roomId); } catch (e) { return null; } })() || {};
  const padTitle = String(pad.title || (R && R.name) || P.roomId).slice(0, 60), roomName = String((R && R.name) || P.roomId).slice(0, 60);
  const link = "/p/" + encodeURIComponent(pad.slug || P.roomId);
  const u = (await getQuery("SELECT userId FROM users WHERE lower(camfrogUsername) = ? ORDER BY CASE WHEN username LIKE 'CF%' THEN 1 ELSE 0 END LIMIT 1", [login]))[0];
  // in the person's own language (their saved preference; a Camfrog PM via Pepe stays English, like his other lines)
  const I18N = require("./i18n");
  let lang = "en";
  if (u) { try { lang = I18N.getPref(u.userId) || "en"; } catch (e) { lang = "en"; } }
  const T = I18N.tFor(lang);
  const mins = Math.max(2, Math.round(cfg().notice_lead_s / 60));
  const title = kind === "first" ? T("mf.notice.first_title", { pad: padTitle }) : T("mf.notice.title", { pad: padTitle });
  const body = kind === "first" ? T("mf.notice.first_body", { room: roomName, pad: padTitle, n: mins }) : T("mf.notice.body", { room: roomName, pad: padTitle });
  if (u) {
    await ROOMS().notify(u.userId, { kind: "stage", title, body, link, ref: "micfollow:" + kind + ":" + P.roomId + ":" + login + ":" + t });
    bump("notices_inbox", 1, t, P);
    return true;
  }
  const site = process.env.SITE_URL || (STAGING ? "https://staging.publicaccess.tv" : "https://publicaccess.tv");
  const by = pad.owner && pad.owner.userId ? String(pad.owner.userId) : PEPE_ACCOUNT;   // like camNotify; a house pad: Pepe's own
  await require("./actions").queue(by, { kind: "notify", args: [login, `${title} - ${body} ${site}${link}`.slice(0, 300), "stage"],
                                         tag: "stage-notify", label: "🎙 mic stage notice" });
  bump(by === PEPE_ACCOUNT ? "notices_pm_house" : "notices_pm", 1, t, P);
  return true;
}
/** DF-11: the pad's first notice to `login`, at their first qualifying grab. Until it went out (and notice_lead_s after)
 *  they are "notice" in eligOf - never picked. A failed send tries again in a minute (they stay unpicked meanwhile). */
async function firstNotice(P, R, login, t) {
  const k = P.roomId + "|" + login;
  const n = NOTES.get(k);
  if (!n || n.first || n.busy || (n.retryAt && n.retryAt > t)) return false;
  n.busy = true;
  try {
    const ok = await sendNotice(P, R, login, t, "first").catch((e) => { console.error("[micfollow] notice:", e.message); return false; });
    if (!ok) { n.retryAt = now() + 60 * 1000; bump("notice_failed", 1, t, P); return false; }
    const at = now();
    await runQuery(`INSERT INTO micfollow_notices (room_id, login, first_at, last_at) VALUES (?, ?, ?, ?)
                    ON CONFLICT(room_id, login) DO UPDATE SET first_at = COALESCE(micfollow_notices.first_at, excluded.first_at), last_at = excluded.last_at`,
                   [P.roomId, login, at, at]);
    n.first = n.first || at; n.last = at;
    bump("notices_first", 1, t, P);
    return true;
  } finally { n.busy = false; }
}
/** A re-notice while they show (at a picture), once per pad per notice_gap_h - it never re-gates (DF-11). */
async function renotice(P, R, login, t) {
  const k = P.roomId + "|" + login;
  const n = NOTES.get(k);
  const gap = cfg().notice_gap_h * 3600e3;
  if (!n || n.busy || (n.last && t - n.last < gap)) return false;
  n.busy = true;
  try {
    const ok = await sendNotice(P, R, login, t, "again");
    if (!ok) return false;
    const at = now();
    n.last = at;
    await runQuery(`INSERT INTO micfollow_notices (room_id, login, first_at, last_at) VALUES (?, ?, ?, ?)
                    ON CONFLICT(room_id, login) DO UPDATE SET last_at = excluded.last_at`, [P.roomId, login, n.first || at, at]);
    const sp = P.spans.get(login);
    const id = sp ? await sp : null;
    if (id) await runQuery("UPDATE micfollow_spans SET noticed = 1 WHERE id = ?", [id]);
    return true;
  } finally { n.busy = false; }
}

// ── stills (§7.3) ──
function stillTick(P, t = now()) {
  const c = cfg();
  for (const [login, s] of P.stills) {
    if (s.next > t) continue;
    s.next = t + c.still_refresh_s * 1000;
    try { const r = require("./bridge-relay").mfSnap(P.roomId, login); if (r && r.id) bump("still_jobs", 1, t, P); } catch (e) { /* no relay */ }
  }
}
/** bridge-relay: Pepe answered a mic-stage still (img or a refusal). */
function onStillResult(roomId, login, ok, t = now()) {
  const P = PADS.get(String(roomId));
  if (!P) return;
  bump(ok ? "still_frames" : "still_refusals", 1, t, P);
  if (!ok) apply(P, roomOf(P.roomId), core.stillFailed(P.state, low(login), cfg(), t), t);
}

// ── hooks ──
/** livecam ended a relay (opt-out, cam closed, failed, ended by someone ...). */
function onSessionEnd(S, why) {
  if (!S) return;
  // Pepe refused a relay that WASN'T the mic stage's (a manual cam slot, a viewer's ▶ Live) because his cams are full:
  // a manual action wins - mic follows stops its stills, opens nothing new for a minute and gives one relay back
  if (why === "slots_busy" && !(S.lastHolds && [...S.lastHolds].some((h) => String(h).startsWith("mf:")))) shed(now());
  const P = PADS.get(String(S.roomId));
  if (!P || !core.tileOf(P.state, S.login)) return;
  const t = now();
  const r = core.sessionEnded(P.state, S.login, why, cfg(), t);
  apply(P, roomOf(P.roomId), r.actions, t);
  if (why === "ended_by" || why === "ended_by_admin") {
    excludeFor(P.roomId, S.login, Math.round(LC().END_COOLDOWN_MS / 60000), "ended_by", "system").catch(() => {});
  }
}
/** Step every pad where `login` is on the stage or holds the mic. refresh: re-read "private activity" + bans first. */
async function recheck(login, { refresh: re = false } = {}) {
  await init();
  const l = low(login);
  if (!LOGIN_RE.test(l)) return 0;
  for (const k of [...GATE.keys()]) if (k.startsWith(l + "|")) GATE.delete(k);
  let n = 0;
  for (const P of PADS.values()) {
    const R = roomOf(P.roomId);
    const on = core.tileOf(P.state, l) || ((R && R.mic) || []).some((u) => u && low(u.login) === l);
    if (!on) continue;
    if (re) { FACTS.delete(l); BANS.delete(l + "|" + P.roomId); await refresh(l, P.roomId, { force: true }); }
    stepPad(P.roomId);
    n++;
  }
  return n;
}
/** A PATV account's settings / bans changed: recheck its linked Camfrog login. */
async function recheckUser(userId) {
  let login = null;
  try { const r = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [String(userId || "")]))[0]; login = r && r.camfrogUsername ? low(r.camfrogUsername) : null; }
  catch (e) { login = null; }
  if (!login) return 0;
  return recheck(login, { refresh: true });
}
/** A manual cam slot needs a relay and live cams are full: give one up (the oldest-added mic-only live tile). The freed
 *  place is the slot's: no cold opens for YIELD_WINDOW_MS (its stageHold retry runs right after this), and the pad isn't
 *  stepped here (a step would hand the place straight to another mic tile) - the 1 s timer gives the tile a still / card. */
function yieldRelay(t = now(), { forSlot = true } = {}) {
  let best = null;
  for (const P of PADS.values()) {
    for (const x of P.state.tiles) {
      if (!core.liveish(x) || x.pend) continue;
      const st = LC().mfState(P.roomId, x.login, t);
      if (!st.held || !st.mfOnly) continue;
      if (!best || x.addedAt < best.x.addedAt) best = { P, x };
    }
  }
  if (!best) return false;
  if (forSlot) yieldUntil = Math.max(yieldUntil, t + YIELD_WINDOW_MS);
  core.yieldTile(best.P.state, best.x.login, t, YIELD_BLOCK_MS);
  LC().stageYield(best.P.roomId, best.x.login, MFH(best.P.roomId), t);
  bump(forSlot ? "yields" : "relays_trimmed", 1, t, best.P);
  try { BR().touch(best.P.roomId); } catch (e) { /* no bridge */ }
  return true;
}
/** relays_max covers EVERY relay only the mic stage holds - a warm one whose ▶ Live viewers left counts too (§7.1): above
 *  it for RELAYS_GRACE_MS (a viewer's beat can lapse for a moment), the oldest-added ones are given up (still / card). */
function enforceRelays(t = now()) {
  let n = 0;
  try { n = LC().mfOnlyCount(t); } catch (e) { return 0; }
  const max = cfg().relays_max;
  if (n <= max) { relaysOverSince = 0; return 0; }
  if (!relaysOverSince) { relaysOverSince = t; return 0; }
  if (t - relaysOverSince < RELAYS_GRACE_MS) return 0;
  let k = 0;
  while (n - k > max && yieldRelay(t, { forSlot: false })) k++;
  relaysOverSince = 0;
  return k;
}
/** livecam: Pepe's exact flag moved on a relay the mic stage holds - step that pad now (a relay that stops being exact
 *  comes off live at once; one he just confirmed goes live). */
function onExact(roomId, login) {
  const P = PADS.get(String(roomId));
  if (P && loaded && core.tileOf(P.state, low(login))) stepPad(P.roomId);
}
/** stageleave.leave (train2 merge): `login` took their cam off this pad's Stage ("Take me off this Stage" / "!stage off me") -
 *  step that pad now, so a mic-stage tile of theirs comes off at once (eligOf: the neutral CUT "unavailable") and lets go of
 *  its relay, like stagefix's cam slots end at once. Nothing to do while mic follows isn't loaded (no init from here). */
function onStageLeave(roomId, login) {
  const P = PADS.get(String(roomId));
  if (P && loaded) stepPad(P.roomId);
}
/** Pepe's own cams are full for a manual action: shed for SHED_MS (stills stop, nothing new opens) and give one relay up. */
function shed(t = now()) {
  const was = t < shedUntil;
  shedUntil = t + SHED_MS;
  if (was) return;
  bump("sheds", 1, t);
  yieldRelay(t);
  for (const P of PADS.values()) if (P.state.tiles.some((x) => x.video === "still")) stepPad(P.roomId, t);
}
/** Keep `login` off this pad's mic stage: minutes (null / 0 with reason owner+always = always). */
async function excludeFor(roomId, login, minutes, reason, by, { always = false, userId = null } = {}) {
  await init();
  const l = low(login);
  if (!LOGIN_RE.test(l)) throw new Refuse(400, "That isn't a Camfrog name.", "bad");
  const t = now();
  if (!always && !(Number(minutes) > 0)) return null;
  const until = always ? null : t + Math.round(Number(minutes) * 60 * 1000);
  const m = exclMap(roomId), cur = m.get(l);
  // never shorten a longer exclusion the owner set (a ✂ Cut after "always" keeps "always")
  if (cur && (cur.until == null || (until != null && cur.until > until)) && reason !== "owner") return cur;
  const row = { until, reason: String(reason || "owner").slice(0, 20), by: by ? String(by).slice(0, 80) : null, at: t, user_id: userId || null };
  await runQuery(`INSERT INTO micfollow_excl (room_id, login, user_id, until, reason, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(room_id, login) DO UPDATE SET user_id = excluded.user_id, until = excluded.until, reason = excluded.reason, by = excluded.by, at = excluded.at`,
                 [String(roomId), l, row.user_id, until, row.reason, row.by, t]);
  m.set(l, row);
  const P = PADS.get(String(roomId));
  if (P) { apply(P, roomOf(P.roomId), core.cutNow(P.state, l, "excluded", t), t); stepPad(P.roomId, t); }
  return row;
}
/**
 * The exclusion form's name -> {login, userId}. kind "camfrog" = a Camfrog login as typed; "patv" = a PATV username ->
 * its linked Camfrog login (+ the account, so a later re-link to another Camfrog name is caught too). No kind (the API, an
 * older page): a name that is a PATV username AND someone else's Camfrog login in this room is refused as ambiguous.
 */
async function exclTarget(R, name, kind) {
  const n = String(name || "").trim().replace(/^@/, "").slice(0, 60);
  if (!n) throw new Refuse(400, "Whose name?", "bad");
  if (kind === "camfrog") return { login: low(n), userId: null };
  const acc = (await getQuery("SELECT userId, camfrogUsername FROM users WHERE lower(username) = lower(?) LIMIT 1", [n]))[0] || null;
  const linked = acc && acc.camfrogUsername ? low(acc.camfrogUsername) : null;
  if (kind === "patv") {
    if (!acc) throw new Refuse(404, "There's no PATV account by that name.", "nouser");
    if (!linked) throw new Refuse(409, "They don't have a Camfrog name linked.", "unlinked");
    return { login: linked, userId: String(acc.userId) };
  }
  if (!acc) return { login: low(n), userId: null };
  if (linked === low(n)) return { login: linked, userId: String(acc.userId) };      // the same person both ways
  const B = roomOf(R.id);
  const here = !!B && [...(B.members || []), ...(B.mic || [])].some((u) => u && !u.anon && !u.self && low(u.login) === low(n));
  if (here || !linked) {
    throw new Refuse(409, here ? "That's a PATV name and also someone else's Camfrog name in this room - say which one you mean."
      : "There's a PATV account by that name with no Camfrog name linked - to keep a Camfrog name off, pick \"Camfrog name\".", "ambiguous");
  }
  return { login: linked, userId: String(acc.userId) };
}
async function unexclude(roomId, login) {
  await init();
  const l = low(login);
  await runQuery("DELETE FROM micfollow_excl WHERE room_id = ? AND login = ?", [String(roomId), l]);
  const m = EXCL.get(String(roomId));
  if (m) m.delete(l);
  return true;
}
// ── 🧹 Clear the stage + ⚑ reports (addendum 14.1.2 #3; DF-31's thresholds) ──
/** The owner's 🧹 Clear the stage: everyone off now, the program idles and freezes (❄, the same length). -> frozen_until */
function clearStage(roomId, t = now()) {
  const P = padOf(roomId, true);
  const mins = Math.min(30, cfg().freeze_max_min);
  const A = core.clearStage(P.state, t, mins * 60 * 1000);
  apply(P, roomOf(P.roomId), A, t);
  bump("cleared", 1, t, P);
  return P.state.frozenUntil || null;
}
const REPORT_REASONS = Object.freeze(["impersonation", "sexual", "abuse", "minor", "other"]);
const HIDE_MS = 24 * 3600e3;
const REPORT_RECENT_MS = 2 * 60 * 1000;          // a tile that left this recently can still be reported
/** A reporter whose report counts toward a cut: >= 7 days, level >= 2, verified or linked, not archived, not a flagged alt
 *  (engagement.qualified - the same gate as everywhere a vote counts). A failed read: not qualified. */
async function qualifiedReporter(userId) {
  try { const q = await require("./engagement").qualified([String(userId)]); return !!(q && q[String(userId)] && q[String(userId)].ok); } catch (e) { return false; }
}
/**
 * ⚑ A signed-in viewer reports `login`'s tile on pad `roomId` (the route checked they can see the pad's live room).
 * The tile hides for them at once (24 h). A qualified report counts unless that reporter's report on this person was
 * dismissed by staff in the last 24 h; two DISTINCT qualified reporters (not each other's alts) within report_window_s cut
 * the person and keep them off this pad's mic stage for report_out_h ("reported"), pending staff review. At most
 * reports_per_hour reports per reporter per pad count. -> {hidden, counted, qualified, cut}
 */
async function report(roomId, login, user, reason, t = now()) {
  await init();
  const P = PADS.get(String(roomId));
  const l = low(login);
  if (!LOGIN_RE.test(l)) throw new Refuse(400, "Who?", "bad");
  const left = P ? P.state.leftAt.get(l) : null;
  if (!P || !P.settings.on || !(core.tileOf(P.state, l) || (left && t - left < REPORT_RECENT_MS))) throw new Refuse(404, "They aren't on the mic stage any more.", "gone");
  const uid = String(user.userId);
  if (user.camfrogUsername && low(user.camfrogUsername) === l) throw new Refuse(400, "That's you.", "self");
  const why = REPORT_REASONS.includes(String(reason)) ? String(reason) : "other";
  const hk = P.roomId + "|" + uid;
  const hm = HIDE.get(hk) || new Map();
  hm.set(l, t + HIDE_MS);
  HIDE.set(hk, hm);
  if (HIDE.size > 20000) HIDE.delete(HIDE.keys().next().value);
  try { LC().stageUnwatch(uid, P.roomId, l, MFH(P.roomId)); } catch (e) { /* no live cams */ }   // their live view of it ends now
  try { BR().touch(P.roomId); } catch (e) { /* no bridge */ }
  const c = cfg(), win = c.report_window_s * 1000;
  const mine = (await getQuery("SELECT COUNT(*) AS n FROM micfollow_reports WHERE reporter_id = ? AND room_id = ? AND at > ?", [uid, P.roomId, t - 3600e3]))[0].n;
  if (Number(mine) >= c.reports_per_hour) { bump("reports_over_rate", 1, t, P); return { hidden: true, counted: false, qualified: false, cut: false }; }
  const again = (await getQuery("SELECT 1 AS x FROM micfollow_reports WHERE reporter_id = ? AND room_id = ? AND login = ? AND at > ? LIMIT 1", [uid, P.roomId, l, t - win])).length;
  if (again) return { hidden: true, counted: false, qualified: false, cut: false };
  const voided = (await getQuery(`SELECT 1 AS x FROM micfollow_reports WHERE reporter_id = ? AND room_id = ? AND login = ? AND state = 'dismissed' AND resolved_at > ? LIMIT 1`,
    [uid, P.roomId, l, t - 24 * 3600e3])).length > 0;
  const qualified = !voided && (await qualifiedReporter(uid));
  await runQuery("INSERT INTO micfollow_reports (room_id, login, reporter_id, reason, at, qualified, state) VALUES (?, ?, ?, ?, ?, ?, 'open')",
                 [P.roomId, l, uid, why, t, qualified ? 1 : 0]);
  bump("reports", 1, t, P);
  if (!qualified) return { hidden: true, counted: true, qualified: false, cut: false };
  bump("reports_qualified", 1, t, P);
  const ids = (await getQuery(`SELECT DISTINCT reporter_id FROM micfollow_reports WHERE room_id = ? AND login = ? AND qualified = 1 AND state = 'open' AND at > ?`,
    [P.roomId, l, t - win])).map((r) => String(r.reporter_id));
  if (ids.length < 2) return { hidden: true, counted: true, qualified: true, cut: false };
  let alts = new Set();
  try { alts = await require("./engagement").altPairs(ids); } catch (e) { alts = new Set(); }
  const distinct = [];
  for (const id of ids) if (!distinct.some((d) => alts.has(d + "|" + id))) distinct.push(id);
  if (distinct.length < 2) return { hidden: true, counted: true, qualified: true, cut: false };
  await excludeFor(P.roomId, l, c.report_out_h * 60, "reported", "reports");
  await runQuery("UPDATE micfollow_reports SET state = 'cut' WHERE room_id = ? AND login = ? AND state = 'open'", [P.roomId, l]);
  bump("report_cuts", 1, t, P);
  try { ROOMS().event(P.roomId, "micfollow", null, `two reports: someone was taken off the mic stage for ${c.report_out_h} h (staff review)`); } catch (e) { /* none */ }
  return { hidden: true, counted: true, qualified: true, cut: true };
}
/** Staff: dismiss (lifts a "reported" hold-out; those reporters carry no weight on that person for 24 h) or uphold the
 *  open reports on `login` in pad `roomId`. Audited. -> {n} */
async function resolveReports(user, roomId, login, action, t = now()) {
  await init();
  if (!SP.can(user, "micfollow.kill")) throw new Refuse(403, "Staff only.", "forbidden");
  if (action !== "dismiss" && action !== "uphold") throw new Refuse(400, "dismiss or uphold", "bad");
  const rid = String(roomId || ""), l = low(login);
  const rows = await getQuery("SELECT id FROM micfollow_reports WHERE room_id = ? AND login = ? AND state IN ('open', 'cut')", [rid, l]);
  if (!rows.length) throw new Refuse(404, "Nothing open on them there.", "none");
  const by = String(user.username || user.userId || "?").slice(0, 80);
  await require("./adminaudit").init();
  await tx(async () => {
    await runQuery("UPDATE micfollow_reports SET state = ?, resolved_by = ?, resolved_at = ? WHERE room_id = ? AND login = ? AND state IN ('open', 'cut')",
                   [action === "dismiss" ? "dismissed" : "upheld", by, t, rid, l]);
    await require("./adminaudit").record(user, AUDIT, null, { action: "reports_" + action, room: rid, n: rows.length }, null);
  });
  if (action === "dismiss") {
    const e = (EXCL.get(rid) || new Map()).get(l);
    if (e && e.reason === "reported") await unexclude(rid, l);
  }
  return { n: rows.length };
}
function clearPad(roomId) { const P = PADS.get(String(roomId)); if (P) stepPad(P.roomId); }
function clearAll() { for (const P of PADS.values()) stepPad(P.roomId); }
/** bridge.ingest: Pepe synced room R (synchronous - never awaits inside the sync). */
function onSync(R, t = now()) {
  if (!loaded || !R) return;
  const P = PADS.get(String(R.id));
  if (!P || (!P.settings.on && !P.state.tiles.length)) return;
  stepPad(P.roomId, t, R);
}
/** The bridge dropped a room (Pepe left it). */
function onRoomGone(roomId) {
  const P = PADS.get(String(roomId));
  if (P && loaded) stepPad(P.roomId, now(), null);
}
/** Rooms where a pad's mic stage is running (Pepe's live-cam poll: early roster reads). */
function roomsOn() {
  const out = [];
  for (const P of PADS.values()) if (P.settings.on && P.state.running) out.push(P.roomId);
  return out;
}

// ── views ──
async function canManageId(userId, roomId, t = now()) {
  const k = String(userId) + "|" + roomId, c = MANAGE.get(k);
  if (c && t - c.at < MANAGE_MS) return c.ok;
  let ok = false;
  try {
    const u = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [String(userId)]))[0];
    ok = !!u && (await ROOMS().canManage(u, roomId));
  } catch (e) { ok = false; }
  MANAGE.set(k, { ok, at: t });
  if (MANAGE.size > 5000) MANAGE.delete(MANAGE.keys().next().value);
  return ok;
}
async function blockedHere(roomId, userId, t = now(), feature = "livecams") {
  const k = roomId + "|" + userId + "|" + feature, c = BLK.get(k);
  if (c && t - c.at < GATE_MS) return c.b;
  let b = false;
  try { b = !!(await require("./bridgeblocks").refusal(roomId, userId, feature)); } catch (e) { b = false; }
  BLK.set(k, { b, at: t });
  if (BLK.size > 5000) BLK.delete(BLK.keys().next().value);
  return b;
}
/** A viewer and the person shown blocked each other in DMs (messages.js dm_blocks, either way; any account linked to
 *  that Camfrog login) - "blocked or ignored" (addendum 14.1.2 #2). A failed read fails closed. */
async function dmBlocked(login, userId) {
  const f = FACTS.get(login);
  let ids = f ? f.userIds : null;
  try {
    if (!ids) ids = (await getQuery("SELECT userId FROM users WHERE lower(camfrogUsername) = ?", [login])).map((u) => String(u.userId));
    if (!ids.length) return false;
    const ph = ids.map(() => "?").join(","), me = String(userId);
    return (await getQuery(`SELECT 1 AS x FROM dm_blocks WHERE (blocker_id = ? AND blocked_id IN (${ph})) OR (blocked_id = ? AND blocker_id IN (${ph})) LIMIT 1`,
      [me, ...ids, me, ...ids])).length > 0;
  } catch (e) { return !/no such table/i.test(String(e && e.message)); }
}
/** The viewer reported this tile (⚑): it's hidden for them (DF-31). */
function hiddenFor(roomId, userId, login, t = now()) {
  const m = HIDE.get(String(roomId) + "|" + String(userId));
  const until = m && m.get(login);
  return !!(until && until > t);
}
/** This viewer and that cam: "ok" | "members_only" | "unavailable" | "hidden" (cached gates; the watch route re-checks for real). */
async function watchOf(login, userId, t = now(), roomId = null) {
  if (roomId != null && hiddenFor(roomId, userId, login, t)) return "hidden";
  try { if (CV().blocked(login, userId)) return "unavailable"; } catch (e) { /* none */ }
  const k = login + "|" + userId, c = GATE.get(k);
  if (c && t - c.at < GATE_MS) return c.code;
  let code = "ok";
  try {
    const g = await require("./camaccess").gate(login, userId);
    if (g) code = g.code === "cam_members" ? "members_only" : "unavailable";
  } catch (e) { code = "unavailable"; }
  if (code === "ok" && (await dmBlocked(login, userId))) code = "unavailable";
  GATE.set(k, { code, at: t });
  if (GATE.size > 20000) GATE.delete(GATE.keys().next().value);
  return code;
}
/** A synchronous copy of the pad's program (bridge.liveView takes it before any await, like members / mic). */
function snapshot(roomId, t = now()) {
  const P = PADS.get(String(roomId));
  if (!P || !P.settings.on) return null;
  const S = P.state, nw = core.newest(S), lay = S.layoutOverride || P.settings.layout;
  return { roomId: P.roomId, v: S.v, running: S.running && !S.whyOff, whyOff: S.whyOff || null, active: !!S.active, default_view: P.settings.default_view,
           layout: core.layoutFor(lay, S.tiles.length), fixed: lay !== "auto", frozen_until: S.frozenUntil > t ? S.frozenUntil : null,
           override: S.layoutOverride, padLayout: P.settings.layout, unproven: S.unproven, neutral: S.tiles.length ? null : S.neutral || null,
           excluded_n: [...(EXCL.get(P.roomId) || new Map()).values()].filter((e) => e.until == null || e.until > t).length,
           tiles: S.tiles.map((x) => ({ login: x.login, pos: x.pos, newest: x === nw, since: x.addedAt, video: x.video || "card", why: x.why || null })) };
}
/**
 * stage_program for one viewer (§9.9). snap = snapshot(R.id); nameOf({login, display}) -> the page's user ref (withPatv).
 * null = mic follows is off on this pad.
 */
async function viewFor(snap, R, userId, nameOf, t = now()) {
  if (!snap) return null;
  // speaking: the neutral card that replaced the tiles while the mic is held only by people nobody can show ("someone", no
  // name, no avatar) or by Pepe alone ("pepe") - DF-30 / DF-12
  const base = { v: snap.v, by: "rule", rule: "mic_follows", on: snap.running, active: snap.active, default: snap.default_view, layout: snap.layout,
                 fixed: snap.fixed, frozen_until: snap.frozen_until, count: snap.tiles.length, still_s: cfg().still_refresh_s, manage: null,
                 speaking: snap.neutral || null };
  const manage = userId ? await canManageId(userId, snap.roomId, t) : false;
  if (manage) {
    base.why_off = snap.whyOff;
    base.manage = { excluded_n: snap.excluded_n, unproven_n: snap.unproven, frozen_until: snap.frozen_until, layout_override: snap.override, layout_pad: snap.padLayout,
                    freeze_min: Math.min(30, cfg().freeze_max_min) };      // ❄ / 🧹 freeze this long (the site's freeze_max_min caps it)
  }
  if (userId) base.report = true;                                          // ⚑ on each tile (signed in; the route checks the rest)
  if (!userId) return { ...base, signin: true, src: [] };
  if (await blockedHere(snap.roomId, String(userId), t)) return { ...base, blocked: true, src: [] };
  const src = [];
  for (const x of snap.tiles) {
    const m = memberOf(R, x.login);
    const ref = { login: x.login, display: (m && m.display) || x.login };
    let u = ref;
    try { u = nameOf ? nameOf(ref) || ref : ref; } catch (e) { u = ref; }
    const patv = u && u.patv ? u.patv : null;
    // the label: a linked person's PATV name; anyone else by their Camfrog LOGIN - a Camfrog display name is free text
    // (someone could call themselves another member's name and show their own cam under it)
    const name = patv ? String((u && u.display) || x.login) : x.login;
    let watch = await watchOf(x.login, String(userId), t, snap.roomId);
    // a still is a snapshot: a bridge block on cam snapshots for this viewer here says so on the tile
    if (watch === "ok" && x.video === "still" && (await blockedHere(snap.roomId, String(userId), t, "snapshots"))) watch = "blocked";
    src.push({ kind: "cam", id: x.login, name: name.slice(0, 40), avatar: patv && patv.avatar ? patv.avatar : null,
               nameCss: patv && patv.style ? patv.style : "", pos: x.pos, newest: x.newest, since: x.since,
               video: x.video, why: x.video === "card" ? x.why || "full" : null, watch });
  }
  return { ...base, src };
}

/** Pad settings -> Stage card. */
async function ownerState(roomId, t = now()) {
  await init();
  const P = padOf(roomId, false);
  const s = P ? P.settings : { ...core.PAD_DEFAULTS };
  const R = roomOf(roomId);
  const why = P ? whyOff(P, R, t) : "pad_off";
  const runWhy = why === "pad_off" ? whyOff({ roomId: String(roomId), settings: { ...s, on: true } }, R, t) : why;
  const caps = padCaps();
  const ex = [...(EXCL.get(String(roomId)) || new Map()).entries()].filter(([, e]) => e.until == null || e.until > t)
    .map(([login, e]) => ({ login, until: e.until, reason: e.reason, by: e.by, at: e.at })).sort((a, b) => b.at - a.at);
  return { settings: { ...s }, on: !!s.on, running: !!(P && P.state.running && s.on), why_off: s.on ? why : null, can_run: !runWhy, run_why: runWhy || null,
           tiles: P ? P.state.tiles.length : 0, unproven_n: P ? P.state.unproven : 0, excluded: ex, max_live_cap: caps.maxLive, max_people_cap: caps.maxPeople,
           site_on: cfg().enabled === true, layouts: core.LAYOUTS, default_views: core.DEFAULT_VIEWS };
}
/** How far a pad owner may go: the site knobs max_people / max_live (micfollow_cfg) and live cams' own max_live (§3.6). */
function padCaps() {
  const c = cfg();
  let lcMax = 4;
  try { lcMax = LC().cfg().max_live; } catch (e) { lcMax = 4; }
  return { maxLive: Math.max(1, Math.min(4, lcMax, c.max_live)), maxPeople: Math.max(1, Math.min(9, c.max_people)) };
}
/** The pad settings card's status line (the same words views/partials/pad-micfollow.ejs prints) - t = the request's t(). */
function statusText(t, mf) {
  const why = (w) => t("pad.settings.mf.why_off." + w);
  const main = !mf.site_on ? t("pad.settings.mf.status.cant", { why: why("site_off") })
    : mf.on && mf.running ? t("pad.settings.mf.status.running", { n: mf.tiles })
    : mf.on && mf.why_off ? t("pad.settings.mf.status.cant", { why: why(mf.why_off) })
    : !mf.on && mf.can_run ? t("pad.settings.mf.status.ready")
    : !mf.on && mf.run_why ? t("pad.settings.mf.status.cant", { why: why(mf.run_why) }) : t("pad.settings.mf.status.off");
  return main + (mf.unproven_n > 0 ? " " + t("pad.settings.mf.status.unproven", { n: mf.unproven_n }) : "");
}
async function setPad(roomId, body, actor, t = now()) {
  await init();
  const P = padOf(roomId, true);
  const caps = padCaps();
  const r = core.normalizePad(body, { base: P.settings, maxLive: caps.maxLive, maxPeople: caps.maxPeople });
  if (Object.keys(r.errors).length) { const f = Object.entries(r.errors)[0]; throw new Refuse(400, `${f[0]}: ${f[1]}`, "bad", { fields: r.errors }); }
  const n = r.cfg;
  // an 18+ pad: no mic follows until a per-pad ask flow exists (addendum 14.1.2 #8) - switching it OFF always works
  if (n.on && padAdult(P.roomId)) throw new Refuse(409, "Mic follows can't be switched on for an 18+ pad yet.", "adult");
  await runQuery(`INSERT INTO micfollow_pads (room_id, on_, layout, default_view, max_people, max_live, updated, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(room_id) DO UPDATE SET on_ = excluded.on_, layout = excluded.layout, default_view = excluded.default_view,
                  max_people = excluded.max_people, max_live = excluded.max_live, updated = excluded.updated, updated_by = excluded.updated_by`,
                 [P.roomId, n.on ? 1 : 0, n.layout, n.default_view, n.max_people, n.max_live, t, actor ? String(actor).slice(0, 80) : null]);
  P.settings = { ...n };
  stepPad(P.roomId, t);
  return P.settings;
}

// ── personal switch (Settings → Privacy) ──
async function privacyState(userId, t = now()) {
  await init();
  const r = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [String(userId)]))[0];
  const login = r && r.camfrogUsername ? low(r.camfrogUsername) : null;
  if (!login || !LOGIN_RE.test(login)) return { linked: false, login: null, auto: true, spans: [] };
  const rows = await getQuery(`SELECT room_id, started, ended, secs, video_secs, end_reason FROM micfollow_spans WHERE login = ? AND started > ?
                               ORDER BY started DESC LIMIT 20`, [login, t - 30 * 24 * 3600e3]);
  const spans = rows.map((x) => {
    let title = x.room_id, slug = null;
    try { const p = ROOMS().getCached(x.room_id); if (p) { title = p.title || title; slug = p.slug || null; } } catch (e) { /* none */ }
    return { pad: String(title).slice(0, 60), slug, started: Number(x.started), secs: x.secs == null ? Math.max(0, Math.round((t - Number(x.started)) / 1000)) : Number(x.secs),
             video_secs: Number(x.video_secs) || 0, open: x.ended == null };
  });
  return { linked: true, login, auto: !MFOPT.has(login), spans };
}
async function setOptout(login, off, userId = null, t = now()) {
  await init();
  const l = low(login);
  if (!LOGIN_RE.test(l)) return false;
  await runQuery(`INSERT INTO micfollow_optout (login, off, updated, user_id) VALUES (?, ?, ?, ?)
                  ON CONFLICT(login) DO UPDATE SET off = excluded.off, updated = excluded.updated, user_id = COALESCE(excluded.user_id, micfollow_optout.user_id)`,
                 [l, off ? 1 : 0, t, userId]);
  if (off) MFOPT.add(l); else MFOPT.delete(l);
  await recheck(l);
  return true;
}

// ── site settings (admins) + the kill switch (staff) ──
function diff(a, b) { const out = {}; for (const k of Object.keys(core.FIELDS)) if (a[k] !== b[k]) out[k] = [a[k], b[k]]; return out; }
async function saveCfg(user, next, reason, action) {
  const changed = diff(CFG.cfg, next);
  if (!Object.keys(changed).length && CFG.v > 0) return { v: CFG.v, cfg: { ...CFG.cfg }, changed: {}, same: true };
  await require("./adminaudit").init();
  const t = now(), by = String(user.username || user.userId || "?").slice(0, 80);
  const v = await tx(async () => {
    const row = (await getQuery("SELECT v FROM micfollow_cfg WHERE id = 1"))[0];
    const nv = (row ? Number(row.v) || 0 : CFG.v) + 1;
    await runQuery(`INSERT INTO micfollow_cfg (id, v, data, updated_at, updated_by) VALUES (1, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET v = excluded.v, data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
                   [nv, JSON.stringify(next), t, by]);
    await require("./adminaudit").record(user, AUDIT, null, { action, v: nv, changed, to: next }, reason ? String(reason).slice(0, 200) : null);
    return nv;
  });
  CFG = { v, cfg: { ...next }, at: t, by };
  clearAll();                                    // every pad steps with the new knobs (off -> cleared at once)
  return { v, cfg: { ...next }, changed };
}
async function setKill(user, enabled, reason) {
  await init();
  if (!SP.can(user, "micfollow.kill")) throw new Refuse(403, "Staff only.", "forbidden");
  if (typeof enabled !== "boolean") throw new Refuse(400, "enabled must be true or false", "bad");
  return saveCfg(user, { ...CFG.cfg, enabled }, reason, enabled ? "on" : "kill");
}
async function setCfg(user, body = {}) {
  await init();
  if (!SP.can(user, "micfollow.admin")) throw new Refuse(403, "Admins only.", "forbidden");
  const r = core.normalize(body.cfg || body, { base: CFG.cfg });
  if (Object.keys(r.errors).length) { const f = Object.entries(r.errors)[0]; throw new Refuse(400, `${f[0]}: ${f[1]}`, "bad", { fields: r.errors }); }
  return saveCfg(user, r.cfg, body.reason, "save");
}
async function adminView(user, t = now()) {
  await init();
  const admin = SP.can(user, "micfollow.admin");
  const pads = [];
  for (const P of PADS.values()) {
    if (!P.settings.on && !P.state.tiles.length) continue;
    let title = P.roomId, slug = null;
    try { const p = ROOMS().getCached(P.roomId); if (p) { title = p.title || title; slug = p.slug || null; } } catch (e) { /* none */ }
    const S = P.state;
    pads.push({ room: P.roomId, title, slug, on: !!P.settings.on, layout: core.shapeOf(S, P.settings), tiles: S.tiles.length,
                live: S.tiles.filter(core.liveish).length, stills: S.tiles.filter((x) => x.video === "still").length, why_off: P.settings.on ? whyOff(P, roomOf(P.roomId), t) : "pad_off",
                unproven_n: S.unproven, frozen_until: S.frozenUntil > t ? S.frozenUntil : null, counts: countsOf(P.met, t) });   // §12: per pad too
  }
  let audit = [];
  try { audit = await require("./adminaudit").recent(AUDIT, 15); } catch (e) { audit = []; }
  // ⚑ reports waiting for staff (open, or already cut by two qualified reporters), the last 7 days
  let reports = [];
  try {
    reports = (await getQuery(`SELECT room_id, login, COUNT(*) AS n, SUM(qualified) AS q, MAX(at) AS last, GROUP_CONCAT(DISTINCT reason) AS reasons,
                                      MAX(CASE WHEN state = 'cut' THEN 1 ELSE 0 END) AS cut
                               FROM micfollow_reports WHERE state IN ('open', 'cut') AND at > ? GROUP BY room_id, login ORDER BY last DESC LIMIT 100`, [t - 7 * 24 * 3600e3]))
      .map((r) => {
        let title = r.room_id, slug = null;
        try { const p = ROOMS().getCached(r.room_id); if (p) { title = p.title || title; slug = p.slug || null; } } catch (e) { /* none */ }
        return { room: r.room_id, title, slug, login: r.login, n: Number(r.n) || 0, qualified: Number(r.q) || 0, last: Number(r.last) || 0,
                 reasons: String(r.reasons || "").split(",").filter(Boolean), cut: !!Number(r.cut) };
      });
  } catch (e) { reports = []; }
  const out = { now: t, v: CFG.v, cfg: { ...CFG.cfg }, defaults: { ...core.DEFAULTS }, fields: core.FIELDS, updated_at: CFG.at, updated_by: CFG.by,
                admin, pads, metrics: metrics(t), audit, reports };
  if (admin) {
    out.spans = (await getQuery(`SELECT id, room_id, login, started, ended, secs, video_secs, peak_viewers, end_reason, noticed FROM micfollow_spans
                                 ORDER BY id DESC LIMIT 200`)).map((x) => ({ ...x }));
  }
  return out;
}

// ── upkeep ──
let lastPrune = 0;
async function prune(t = now()) {
  lastPrune = t;
  const keep = cfg().spans_keep_days * 24 * 3600e3;
  await runQuery("DELETE FROM micfollow_spans WHERE started < ? AND ended IS NOT NULL", [t - keep]);
  await runQuery("DELETE FROM micfollow_excl WHERE until IS NOT NULL AND until < ?", [t]);
  // reports: as long as the appearance log; notices: 180 days after the last one (then the next first notice gates again)
  await runQuery("DELETE FROM micfollow_reports WHERE at < ?", [t - keep]);
  await runQuery("DELETE FROM micfollow_notices WHERE COALESCE(last_at, first_at, 0) < ?", [t - 180 * 24 * 3600e3]);
  for (const m of EXCL.values()) for (const [l, e] of [...m]) if (e.until != null && e.until < t) m.delete(l);
  for (const [k, g] of [...GATE]) if (t - g.at > GATE_MS) GATE.delete(k);
  for (const [k, m] of [...HIDE]) { for (const [l, until] of [...m]) if (until <= t) m.delete(l); if (!m.size) HIDE.delete(k); }
}
function tick(t = now()) {
  if (!loaded) return;
  enforceRelays(t);
  for (const P of PADS.values()) {
    if (!P.settings.on && !P.state.tiles.length) continue;
    if (core.hot(P.state, t)) stepPad(P.roomId, t);
    if (P.stills.size) stillTick(P, t);
  }
  if (t - lastPrune > 3600e3) prune(t).catch((e) => console.error("[micfollow] prune:", e.message));
}

// ── routes ──
function register(app, { addUser, bySlug, isLive }) {
  init().then(() => { loaded = true; }).catch((e) => console.error("[micfollow] init:", e.message));
  const tm = setInterval(() => { try { tick(); } catch (e) { console.error("[micfollow] tick:", e.message); } }, 1000);
  if (tm.unref) tm.unref();
  const fetchOnly = (req, res) => {
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) { res.status(403).json({ ok: false, error: "Security check failed - reload the page." }); return false; }
    return true;
  };
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status).json({ ok: false, code: e.code, error: e.message, ...(e.extra || {}) });
    console.error("[micfollow]", e);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  const me = async (req) => {
    if (!req.user || !req.user.userId) return null;
    return (await getQuery("SELECT userId, username, displayname, camfrogUsername, class FROM users WHERE userId = ?", [req.user.userId]))[0] || null;
  };
  const watchHit = guard.limiter({ max: 60, windowMs: 60 * 1000 });
  const stillHit = guard.limiter({ max: 30, windowMs: 60 * 1000 });
  const manageHit = guard.limiter({ max: 30, windowMs: 60 * 1000 });
  const rate = (lim, key, res) => { const w = lim.blocked(key); if (w) { res.set("Retry-After", String(w)); res.status(429).json({ ok: false, code: "rate", error: "Slow down a little." }); return true; } lim.hit(key); return false; };
  /** The live-cam audience for a mic-stage tile (§4.2), checked at every ticket and beat. -> null | Refuse */
  const viewerRefusal = async (u, R, login, feature) => {
    if (hiddenLogin(login)) return new Refuse(403, "That cam isn't available right now.", "unavailable");   // !bridge hide / !incognito
    if (!(await require("./bridge-relay").padFull(u.userId, R.id))) return new Refuse(403, "This pad's live room is for its approved members.", "pad_access");
    if (!bridgeOk(R.id)) return new Refuse(403, "This pad's live chat room comes with 💎 Prime Time Plus.", "prime");
    const blk = await require("./bridgeblocks").refusal(R.id, u.userId, feature);
    if (blk) return new Refuse(403, blk, "blocked");
    if (CV().blocked(login, u.userId)) return new Refuse(403, "That cam isn't available right now.", "unavailable");
    if (hiddenFor(R.id, u.userId, login)) return new Refuse(403, "You reported this - it's hidden for you.", "hidden");
    const g = await require("./camaccess").gate(login, u.userId);
    if (g) return new Refuse(403, g.error, g.code === "cam_members" ? "members_only" : "unavailable");
    if (await dmBlocked(login, u.userId)) return new Refuse(403, "That cam isn't available right now.", "unavailable");   // DM blocks, either way
    return null;
  };
  const padRoom = async (slug) => {
    const RR = ROOMS();
    const R = (await RR.bySlug(String(slug || ""))) || (await RR.get(String(slug || "")));
    if (!R) throw new Refuse(404, "No such pad.", "nopad");
    return R;
  };
  /** ownerState + the status line in the request's language (the settings card repaints it after a save). */
  const ownerStateFor = async (req, roomId) => {
    const st = await ownerState(roomId);
    let t = req.t;
    if (typeof t !== "function") { try { t = require("./i18n").tFor("en"); } catch (e) { t = null; } }
    return t ? { ...st, status_text: statusText(t, st) } : st;
  };
  const owner = async (req) => {
    const u = await me(req);
    if (!u) throw new Refuse(401, "Sign in first.", "signin");
    const R = await padRoom(req.params.slug);
    if (!(await ROOMS().canManage(u, R.id))) throw new Refuse(403, "Only this pad's owner can do that.", "forbidden");
    if (manageHit.blocked("u:" + u.userId)) throw new Refuse(429, "Slow down a little.", "rate");
    manageHit.hit("u:" + u.userId);
    return { u, R };
  };

  app.post("/api/rooms/:slug/micfollow/watch", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!fetchOnly(req, res)) return;
    try {
      const u = await me(req);
      if (!u) throw new Refuse(401, "Sign in to watch cams live.", "signin");
      const b = req.body || {};
      const beat = b.beat === true, stop = b.stop === true;
      const login = low(b.login);
      if (!LOGIN_RE.test(login)) throw new Refuse(400, "Whose cam?", "bad");
      if (!beat && !stop && rate(watchHit, "u:" + u.userId, res)) return;
      const R = bySlug(req.params.slug);
      if (!R || !isLive(R)) return res.json({ ok: true, state: "ended", why: "offline" });
      if (stop) { LC().stageUnwatch(u.userId, R.id, login, MFH(R.id)); return res.json({ ok: true }); }
      const P = PADS.get(R.id);
      const x = P && P.settings.on ? core.tileOf(P.state, login) : null;
      // only a LIVE tile on a relay Pepe confirmed is exactly this person's (never the wrong "Bob"): a "starting" one may
      // not be yet, and his report can move between two steps
      if (!x || x.video !== "live" || LC().mfState(R.id, login).exact !== true) {
        LC().stageUnwatch(u.userId, R.id, login, MFH(R.id));
        return res.json({ ok: true, state: "ended", why: "gone" });
      }
      const ref = await viewerRefusal(u, R, login, "livecams");
      if (ref) { LC().stageUnwatch(u.userId, R.id, login, MFH(R.id)); bump("ticket_refused:" + ref.code, 1, now(), P); throw ref; }
      const r = await LC().stageWatch(u, R, MFH(R.id), { login, beatOnly: beat });
      if (!beat) bump("tickets", 1, now(), P);
      res.json(r);
    } catch (e) { if (e && e.refuse && e.code === "budget") bump("ticket_refused:budget"); fail(res, e); }
  });

  app.get("/api/rooms/:slug/micfollow/still/:login", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const u = await me(req);
      if (!u) throw new Refuse(401, "Sign in to watch cams live.", "signin");
      if (rate(stillHit, "u:" + u.userId, res)) return;
      const login = low(req.params.login);
      const R = bySlug(req.params.slug);
      if (!R || !isLive(R) || !LOGIN_RE.test(login)) return res.json({ ok: true, state: "none" });
      const P = PADS.get(R.id);
      const x = P && P.settings.on ? core.tileOf(P.state, login) : null;
      if (!x || x.video !== "still") return res.json({ ok: true, state: "none" });
      const ref = (await viewerRefusal(u, R, login, "livecams")) || (await viewerRefusal(u, R, login, "snapshots"));
      if (ref) throw ref;
      const f = require("./bridge-relay").mfFrame(R.id, login);
      res.json({ ok: true, state: ["ok", "pending", "refused"].includes(f.state) ? f.state : "none", ...(f.state === "ok" ? { ts: f.ts, img: f.img } : {}) });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/rooms/:slug/micfollow/settings", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!fetchOnly(req, res)) return;
    try {
      const { u, R } = await owner(req);
      const s = await setPad(R.id, req.body || {}, u.username);
      ROOMS().event(R.id, "micfollow", u.username || null, `mic follows ${s.on ? "on" : "off"} · ${s.layout} · ${s.default_view} · ${s.max_people}/${s.max_live}`);
      res.json({ ok: true, settings: s, state: await ownerStateFor(req, R.id) });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/rooms/:slug/micfollow/exclude", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!fetchOnly(req, res)) return;
    try {
      const { u, R } = await owner(req);
      const b = req.body || {};
      let login = low(b.login), userId = null;
      if (!login && b.name) ({ login, userId } = await exclTarget(R, b.name, b.kind));
      if (!LOGIN_RE.test(login)) throw new Refuse(400, "That isn't a Camfrog name.", "bad");
      if (b.remove === true) {
        const was = (EXCL.get(String(R.id)) || new Map()).get(login);
        await unexclude(R.id, login);
        // lifting a hold-out two reports caused = the host vouches for them (logged; the reports stay for staff)
        ROOMS().event(R.id, "micfollow", u.username || null, was && was.reason === "reported" ? "vouched for someone held out by reports" : "removed an exclusion");
        return res.json({ ok: true, state: await ownerStateFor(req, R.id) });
      }
      const hours = Number(b.hours);
      if (![0, 1, 24].includes(hours)) throw new Refuse(400, "Pick 1 hour, 24 hours or always.", "bad");
      await excludeFor(R.id, login, hours * 60, "owner", u.username, { always: hours === 0, userId });
      ROOMS().event(R.id, "micfollow", u.username || null, hours === 0 ? "excluded someone (always)" : `excluded someone (${hours} h)`);
      res.json({ ok: true, state: await ownerStateFor(req, R.id) });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/rooms/:slug/micfollow/freeze", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!fetchOnly(req, res)) return;
    try {
      const { u, R } = await owner(req);
      const P = padOf(R.id, true);
      const mins = Math.max(0, Math.min(cfg().freeze_max_min, Math.round(Number((req.body || {}).minutes) || 0)));
      P.state.frozenUntil = mins > 0 ? now() + mins * 60 * 1000 : 0;
      P.state.v++;
      try { BR().touch(R.id); } catch (e) { /* none */ }
      stepPad(R.id);
      ROOMS().event(R.id, "micfollow", u.username || null, mins > 0 ? `froze the mic stage (${mins} min)` : "unfroze the mic stage");
      res.json({ ok: true, frozen_until: P.state.frozenUntil || null });
    } catch (e) { fail(res, e); }
  });

  // 🧹 Clear the stage (owner bar): everyone off now, the program idles and freezes
  app.post("/api/rooms/:slug/micfollow/clear", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!fetchOnly(req, res)) return;
    try {
      const { u, R } = await owner(req);
      const until = clearStage(R.id);
      ROOMS().event(R.id, "micfollow", u.username || null, "cleared the mic stage");
      res.json({ ok: true, frozen_until: until });
    } catch (e) { fail(res, e); }
  });

  // ⚑ a viewer reports a tile: hidden for them at once; two qualified reporters cut it (DF-31)
  const reportHit = guard.limiter({ max: 10, windowMs: 60 * 1000 });
  app.post("/api/rooms/:slug/micfollow/report", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!fetchOnly(req, res)) return;
    try {
      const u = await me(req);
      if (!u) throw new Refuse(401, "Sign in first.", "signin");
      if (rate(reportHit, "u:" + u.userId, res)) return;
      const b = req.body || {};
      const R = bySlug(req.params.slug);
      if (!R || !isLive(R)) throw new Refuse(404, "That room isn't live right now.", "offline");
      // only someone who can see the pad's live room reports what it shows
      if (!(await require("./bridge-relay").padFull(u.userId, R.id))) throw new Refuse(403, "This pad's live room is for its approved members.", "pad_access");
      if (!bridgeOk(R.id)) throw new Refuse(403, "This pad's live chat room comes with 💎 Prime Time Plus.", "prime");
      if (await blockedHere(R.id, String(u.userId), now())) throw new Refuse(403, "Live cams from this room are blocked for you.", "blocked");
      const r = await report(R.id, b.login, u, b.reason);
      res.json({ ok: true, ...r });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/rooms/:slug/micfollow/layout", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!fetchOnly(req, res)) return;
    try {
      const { u, R } = await owner(req);
      const P = padOf(R.id, true);
      const want = (req.body || {}).layout;
      if (want != null && !core.LAYOUTS.includes(String(want))) throw new Refuse(400, "Pick auto, single, split, grid or pip.", "bad");
      P.state.layoutOverride = want == null || want === "" ? null : String(want);
      P.state.v++;
      try { BR().touch(R.id); } catch (e) { /* none */ }
      stepPad(R.id);
      ROOMS().event(R.id, "micfollow", u.username || null, "layout " + (P.state.layoutOverride || "reset"));
      res.json({ ok: true, layout: P.state.layoutOverride });
    } catch (e) { fail(res, e); }
  });

  // Settings → Privacy: "Pads may put my cam on their stage while I hold the mic" + "Your mic stages (30 days)"
  app.get("/api/privacy/micfollow", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try { res.json({ ok: true, ...(await privacyState(req.user.userId)) }); } catch (e) { fail(res, e); }
  });
  const privHit = guard.limiter({ max: 20, windowMs: 60 * 60 * 1000 });
  app.post("/api/privacy/micfollow", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!fetchOnly(req, res)) return;
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      const auto = (req.body || {}).auto;
      if (typeof auto !== "boolean") throw new Refuse(400, "auto must be true or false", "bad");
      const st = await privacyState(req.user.userId);
      if (!st.linked) throw new Refuse(409, "Link your Camfrog name first - this is about your cam there.", "unlinked");
      if (privHit.blocked("u:" + req.user.userId)) throw new Refuse(429, "That's a lot of switching - try again in a while.", "rate");
      privHit.hit("u:" + req.user.userId);
      await setOptout(st.login, !auto, String(req.user.userId));
      res.json({ ok: true, ...(await privacyState(req.user.userId)) });
    } catch (e) { fail(res, e); }
  });

  // /stage/admin: 🎙 Mic follows (micfollow.kill = staff: the kill switch, one pad off; micfollow.admin = admins: knobs, log)
  const staffOnly = (req, res, next) => {
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    if (!SP.can(req.user, "micfollow.kill") && !SP.can(req.user, "micfollow.admin")) return res.status(403).json({ ok: false, error: "Staff only." });
    next();
  };
  app.get("/api/stage/admin/micfollow", addUser, staffOnly, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, ...(await adminView(req.user)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stage/admin/micfollow/kill", addUser, staffOnly, async (req, res) => {
    if (!fetchOnly(req, res)) return;
    try { const b = req.body || {}; const r = await setKill(req.user, b.enabled, b.reason); res.json({ ok: true, ...r, view: await adminView(req.user) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stage/admin/micfollow/pad", addUser, staffOnly, async (req, res) => {
    if (!fetchOnly(req, res)) return;
    try {
      if (!SP.can(req.user, "micfollow.kill")) throw new Refuse(403, "Staff only.", "forbidden");
      const b = req.body || {};
      if (b.on !== false) throw new Refuse(400, "Staff can only turn it off here.", "bad");
      const P = PADS.get(String(b.room || ""));
      if (!P) throw new Refuse(404, "That pad doesn't use mic follows.", "nopad");
      await setPad(P.roomId, { on: false }, req.user.username);
      await require("./adminaudit").record(req.user, AUDIT, null, { action: "pad_off", room: P.roomId }, b.reason ? String(b.reason).slice(0, 200) : null);
      ROOMS().event(P.roomId, "micfollow", req.user.username || null, "site staff turned mic follows off");
      const pad = ROOMS().getCached(P.roomId);
      if (pad && pad.owner && pad.owner.userId) {
        ROOMS().notify(pad.owner.userId, { kind: "stage", title: "🎙 Mic follows was turned off on your pad by site staff", body: b.reason ? String(b.reason).slice(0, 200) : "",
                                           link: "/p/" + encodeURIComponent(pad.slug || P.roomId) + "/settings?tab=stage", ref: "micfollow-off:" + P.roomId + ":" + now(), pm: false }).catch(() => {});
      }
      res.json({ ok: true, view: await adminView(req.user) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/stage/admin/micfollow/config", addUser, staffOnly, async (req, res) => {
    if (!fetchOnly(req, res)) return;
    try { const r = await setCfg(req.user, req.body || {}); res.json({ ok: true, ...r, view: await adminView(req.user) }); } catch (e) { fail(res, e); }
  });
  // ⚑ staff review of mic-stage reports: dismiss (lifts the hold-out) or uphold
  app.post("/api/stage/admin/micfollow/report", addUser, staffOnly, async (req, res) => {
    if (!fetchOnly(req, res)) return;
    try {
      const b = req.body || {};
      const r = await resolveReports(req.user, b.room, b.login, b.action);
      res.json({ ok: true, ...r, view: await adminView(req.user) });
    } catch (e) { fail(res, e); }
  });
}

module.exports = {
  register, init, cfg, current: () => ({ v: CFG.v, cfg: { ...CFG.cfg } }), onSync, onRoomGone, stepPad, snapshot, viewFor, ownerState, setPad, adminView, setKill, setCfg,
  recheck, recheckUser, yieldRelay, enforceRelays, shed, exclTarget, excludeFor, unexclude, clearPad, clearAll, roomsOn, onStillResult, onSessionEnd, onExact,
  onStageLeave, stillWanted, privacyState, setOptout, metrics, statusText, clearStage, report, resolveReports, REPORT_REASONS,
  tick, prune, ptag, Refuse,
  _pads: PADS, _notes: NOTES, _hide: HIDE,
  /** tests: the pad's first notice to `login` went out at `at` (null = never) */
  _noticed: async (roomId, login, at) => {
    await init();
    const k = String(roomId) + "|" + low(login);
    if (at == null) { NOTES.delete(k); await runQuery("DELETE FROM micfollow_notices WHERE room_id = ? AND login = ?", [String(roomId), low(login)]); return; }
    NOTES.set(k, { first: at, last: at });
    await runQuery(`INSERT INTO micfollow_notices (room_id, login, first_at, last_at) VALUES (?, ?, ?, ?)
                    ON CONFLICT(room_id, login) DO UPDATE SET first_at = excluded.first_at, last_at = excluded.last_at`, [String(roomId), low(login), at, at]);
  },
  _ready: async () => { await init(); loaded = true; },
  _idle: async () => {
    for (let i = 0; i < 5 && (INFLIGHT.size || HOLDING.size); i++) await Promise.all([...INFLIGHT.values(), ...[...HOLDING].map((p) => p.catch(() => {}))]);
  },
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _setBoot: (t) => { bootAt = t; },
  _reset: () => { PADS.clear(); MFOPT = new Set(); EXCL.clear(); FACTS.clear(); BANS.clear(); INFLIGHT.clear(); HOLDING.clear(); GATE.clear(); BLK.clear(); MANAGE.clear(); NOTES.clear(); HIDE.clear();
                   COLD.length = 0; pendingCold = 0; yieldUntil = 0; shedUntil = 0; caRetryAt = 0; relaysOverSince = 0; MET.clear(); PER_MIN.clear(); LAT.warm = []; LAT.cold = []; PEAK = 0;
                   CFG = { v: 0, cfg: { ...core.DEFAULTS }, at: null, by: null }; ready = null; loaded = false; },
};
