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
// Audit: livecam_audit, one row per viewer session (viewer, target, room, start, end, seconds, why it ended). MediaMTX
// records nothing and cam HLS is refused. The one RTSP exception is an authorized mic-stage snap / forward clip:
// stagemiccap scopes a loopback reader to one running capture and re-checks the viewer's consent and privacy gates.
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
// wave2 WP-4 (F.2): a relay whose mic-stage tile left the stage may stay warm under "mfw:<room>" (stageWarm) - a mic-stage
// holder for every count, never watchable (stageWatch refuses it), listed on /admin/pepe/livecams as "warm".
// Viewers who watch ONLY through the mic stage are not noted to the cam's owner one by one (micfollow sends one stage
// notice instead); watchersOf marks them `mf` and the owner's lists (!whowatching, the privacy card) COUNT them, never name
// them (D-19, owner 2026-10-19; camaccess still sees them to drop the ones a mode change refuses). Such a viewer reads only a relay Pepe
// reports exact, and never gets the 👻 ghost bypass. The mic stage's hold re-checks micfollow's own rules after its awaits
// (opts.ok -> "gone"); its release (stageDrop) ends a relay nobody else holds or watches at once (no linger); a ▶ Live
// start that finds max_live full asks micfollow.yieldRelay first. Hooks: onEnd(fn(S, why)) after a session ends,
// onOptout(fn(login, off)) after an opt-out change (a throwing hook is logged and ignored).
// mfix: each session has an id of its own (S.sid) that rides want[] to Pepe and comes back on his refused[] lines - a
// refusal Pepe keeps re-sending for a while (30 s) never ends a NEWER session of the same cam (a manual ▶ Live / cam slot
// started right after a failed mic-stage open). A refusal of an EXACT open (refused[].x - the mic stage asked for it) of a
// relay that a cam slot / a ▶ Live viewer / a pin also uses lets only the mic stage go (micfollow.onExactRefused): the relay
// lives on for the others and Pepe opens it his ordinary way again.
//
// 1.99ahn dead relay (owner 2026-11-02, "Scarface's cam isn't loading here even though on the VM I see it loaded"): ~7% of
// Pepe's WHIP publishes are one-sided - MediaMTX answers the POST, then drops the session ("deadline exceeded while waiting
// connection"), but ffmpeg still prints its connected line and never exits, so Pepe reports the relay "live" for good. A
// relay counts as live (liveAt) only when MediaMTX has its stream (noteSync); Pepe's word is kept as botLiveAt. While the
// path lists are fresh (syncFresh - MediaMTX's API answers), a relay Pepe reports live whose path hasn't been ready for
// NOMEDIA_MS (LOST_MS for one that WAS ready) carries want[].nomedia - Pepe ends that publish and his restart loop puts it
// back (bot 1.99ahn) - and it ends as "start_timeout" (never ready: START_MS, and BOT_GRACE_MS after Pepe's first "live") or
// "relay_lost" (was ready: START_MS after the first nomedia) - both soft, so the mic stage tries again. A stale path list
// (MediaMTX's API unreachable) changes nothing: Pepe's word counts as before and nothing is ended for it. Every "hasn't been
// ready for N s" is what the lists saw (missedSince: up to the latest list, never up to now - review F1). Neither ends a relay
// before the restart nomedia asked for has had its chance (restartSpent - review F2): a dead publish Pepe reports live gets
// its nomedia first, then RESTART_MS for him to act, START_MS for a restart to come live, BOT_GRACE_MS of lists for the
// restarted publish - capped at RESTART_CAP_MS after the first nomedia / START_CAP_MS after the hold.
//
// 1.99?? (privacy controls S5, G:/ops/privacy-controls-spec-2026-11-02.md section 5 "S5" + the owner's answers, section 8):
// INCOGNITO CAMS (incogcams.js, the incog_cams switch - dark). Incognito hides the NAME, never the cam (Q4): an incognito person's cam
// is watched under their FROG NAME, by the opaque id of their frog-name session's roster entry ({id} instead of {login} on start /
// beat / stop / end). Such a session is VEILED (S.veil {id, sess, alias, hood}): its WHEP path is its own (vpathFor: an HMAC of the
// room, the login AND that session - never the named path, never another frog session's), every answer carries the opaque id (start
// `key`, hint `watching`), never the login or keyOf; the console, the moderation history (the End line names the frog name) and
// /admin/pepe/livecams carry the frog name, never the login (livecam_audit.veil). A cam session belongs to ONE identity: a veil
// change (incognito on / off, !bridge hide, the frog-name session ending - incogcams.identityOf) ends it at once (sweep, veilEnded),
// and a named ▶ Live waits while the person has any veiled presence in the room (a hold frozen veiled - spec 2.2). Q23: a veiled cam
// is withheld only from viewers the person's own rules exclude (cam access mode, blocks, live cam off, private activity) - with the
// generic "That cam isn't available right now.", never "ask to watch" or a reason. Switch off (or no word from Pepe): exactly as
// before - a veiled person has no on_cam on the page and start() takes logins only.
//
// 1.99?? (privacy controls S4, G:/ops/privacy-controls-spec-2026-11-02.md section 3.2 "The new CAM REVEAL" + the owner's answers,
// section 8): CAM REVEALS (camreveal.js holds the rules - who, which cam, the audit rows, the notice; the cam_reveal switch, dark). A
// reveal is a session of its own (S.rv): its key is keyOf(room, login) + ":rv:" + sid (so nothing that asks SESS by keyOf - ▶ Live,
// a stage hold, the mic stage, warm keep, a capture - ever finds it), its WHEP path is RANDOM (never pathFor / vpathFor: a URL ties
// nothing to anyone), its viewers are only the moderators who revealed it (each with their own audit row and 3-minute cap -
// revealStart / revealExtend), it never counts as anyone's ▶ Live slot, a block / an opt-out / a veil change never ends it (it got
// past those on purpose - logged as livecam_audit.bypass "reveal:<what>"), it runs no END_HOOKS (micfollow never sees it), and
// relayHold / holdOf / watchersOf name nobody through it. Pepe's want carries {rv, reveal, exact, bypass, quiet}: he opens it by the
// exact name, says nothing in the room, writes no room mod-log line and closes the cam window when it ends; his live[] / refused[]
// lines name it by rv. The person is told at the FIRST FRAME (a moderator's reader authenticated AND MediaMTX had the stream:
// revealNotices -> camreveal's notice hook), unless that moderator is in 👻 ghost mode - re-checked on every beat, so a ghost who
// turns ghost off mid-reveal tells them then. A reveal with no frame by the dead-relay timeouts ends "no_video" and tells nobody.
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
// 1.99ahn dead relay (see the header): Pepe says live, a FRESH MediaMTX path list says the path isn't ready this long -> nomedia
const NOMEDIA_MS = 15 * 1000;
const LOST_MS = 20 * 1000;              // ...for a relay that WAS ready (then "relay_lost" START_MS after the first nomedia)
const BOT_GRACE_MS = 15 * 1000;         // a never-ready relay Pepe reported live ends no sooner than this after his first "live"
// 1.99ahn dead relay review (F2): a nomedia restart moves those deadlines - Pepe acts on it within RESTART_MS (his next poll ends
// that publish), a restart that isn't live yet gets START_MS (like a fresh open), a restarted publish BOT_GRACE_MS of lists -
// and a relay's restarts never hold it past RESTART_CAP_MS after the first nomedia (START_CAP_MS after the hold, never ready)
const RESTART_MS = 10 * 1000;
const RESTART_CAP_MS = 2 * START_MS;
const START_CAP_MS = 3 * START_MS;
const EXACT_REFUSAL_SLACK_MS = 3 * 1000;   // mfix review: refused[].age is measured when Pepe sends it (his poll's round trip)
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
      // 1.99?? (privacy controls S5): a veiled session's row - the frog name it was watched under (admin views show it, never the
      // login; the target column keeps the login server-side for the person's own records and the see-through)
      if (!acols.includes("veil")) await runQuery("ALTER TABLE livecam_audit ADD COLUMN veil TEXT");
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
  const was = OPTOUT.has(l);
  await runQuery(`INSERT INTO livecam_optout (login, off, updated, via, user_id) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(login) DO UPDATE SET off = excluded.off, updated = excluded.updated, via = excluded.via, user_id = COALESCE(excluded.user_id, livecam_optout.user_id)`,
                 [l, off ? 1 : 0, ts, via === "chat" ? "chat" : "web", userId]);
  if (off) { OPTOUT.add(l); for (const S of [...SESS.values()]) if (S.login === l && !S.rv) ownerClosed(S, "opted_out"); }   // (S4: a reveal got past it)
  else OPTOUT.delete(l);
  runHooks(OPTOUT_HOOKS, [l, !!off], "opt-out");      // micfollow: the mic stage drops them at once too
  // 1.99?? (privacy controls S6): a real change files one inbox notice while the privacy switchboard v3 is in effect (privacystate.js;
  // nothing otherwise) - never waited for
  if (was !== !!off) { try { require("./privacystate").camChanged(l, !!off, via, ts).catch(() => {}); } catch (e) { /* none */ } }
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
/** 1.99?? (privacy controls S5): the path of a VEILED cam session - one per frog-name session `sess` (a different HMAC input from
 *  pathFor and from the room audio's): a URL can't tie two frog names together, or one to the person's named cam. */
function vpathFor(roomId, login, sess) {
  return PREFIX + crypto.createHmac("sha256", SECRET).update("live-cam-vpath:" + String(roomId) + "|" + String(login).toLowerCase() + "|" + String(sess)).digest("hex").slice(0, 16);
}
const IC = () => require("./incogcams");
const icEffective = (t) => { try { return IC().effective(t) === true; } catch (e) { return false; } };
/** 1.99?? (privacy controls S5): the identity a session runs under ("n" named, "v:<sess>" one frog-name session) - and whether a
 *  request for `veil` (null = named) is the same one. */
const idOfSess = (S) => (S && S.veil ? "v:" + S.veil.sess : "n");
const sameIdentity = (S, veil) => idOfSess(S) === (veil ? "v:" + veil.sess : "n");
/** What a session is called where its login must never show (the console, the moderation history, admin views): its frog name. */
const shownTarget = (S) => (S.veil ? S.veil.alias || "someone" : S.login);
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
/** wave2 WP-4 (F.2 warm keep): "mfw:<room>" - the mic stage keeps a relay warm for a while after its tile left the stage (no
 *  viewer can ever watch through it: stageWatch refuses it; the tile is on no program). A mic-stage holder like "mf:" for every
 *  count (mfOnlyCount / relays_max, S.mf / want[].mf exact opens, sharedBeyondMf); mfState.held stays "mf:" only. */
const MFW_PREFIX = "mfw:";
const isMfHolder = (h) => /^mfw?:/.test(String(h || ""));
/** micfollow: a stage viewer who came ONLY through the mic stage (no cam slot): no 👻 ghost bypass, exact relays only. */
const mfOnlyVia = (v) => !!(v && v.via instanceof Set && v.via.size > 0 && [...v.via].every(isMfHolder));
/** A new session object (one per room + cam). 1.99?? (privacy controls S5): veil = {id, sess, alias, hood} for an incognito
 *  person's cam under their frog name (its own path - vpathFor), null for a named one. */
function newSess(R, login, m, t, veil = null) {
  const p = veil ? vpathFor(R.id, login, veil.sess) : pathFor(R.id, login);
  const S = { key: keyOf(R.id, login), roomId: R.id, login, display: veil ? veil.alias || "someone" : (m && m.display) || login, path: p, viewers: new Map(), createdAt: t,
              veil: veil ? { id: String(veil.id), sess: String(veil.sess), alias: veil.alias || null, hood: veil.hood == null ? null : veil.hood } : null,
              wantUntil: t + cfg().linger_s * 1000, liveAt: 0, ready: false, readers: 0, seenAt: 0, sourceId: null, botState: null, botWhy: null,
              // 1.99ahn dead relay: liveAt = MediaMTX had the stream; botLiveAt = Pepe's first "live"; botLiveSince = his current
              // live streak (a restart / a new publisher starts it over); missSince = fresh path lists without it since;
              // nomediaAt = the first want[].nomedia of this loss; botDownAt = when his last live streak ended (review F2)
              botLiveAt: 0, botLiveSince: 0, botRestarts: 0, missSince: 0, nomediaAt: 0, botDownAt: 0,
              ended: 0, endWhy: null, holds: new Set(), lastHolds: null, mf: false, stageViewers: new Map(),
              sid: crypto.randomBytes(6).toString("hex") };   // mfix: this session's id (want[].sid -> refused[] / live[])
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
/** 1.99??: timing only; an optional room binding keeps server-side clips on their own room's relay. */
function relayHold(path, roomId) {
  const S = camForPath(path), b = S && S.botInfo;
  // (1.99?? privacy controls S4: never a reveal's relay - nothing but its moderators' players may lean on it)
  return !S || S.ended || S.rv || !b || roomId != null && S.roomId !== roomId ? null : { src: b.source, hold_ms: b.hold_ms == null ? null : b.hold_ms };
}
/** 1.99??: never reveal whether an unheld cam exists; use the same fresh-slot rule as WHEP auth. */
function holdOf(path, userId, roomId) {
  const S = camForPath(path), t = now(), fresh = (v) => !!v && Number.isFinite(v.beat) && t >= v.beat && t - v.beat <= BEAT_MS;
  if (!S || S.ended || S.rv || userId == null || !(fresh(S.viewers.get(String(userId))) || held(S) && S.stageViewers && fresh(S.stageViewers.get(String(userId))))) return null;
  return relayHold(path, roomId);
}
const freshViewers = (S, t = now()) => [...S.viewers.entries()].filter(([, v]) => t - v.beat <= BEAT_MS);
function slotsOf(userId, t = now()) {
  let n = 0;
  for (const S of SESS.values()) if (!S.ended && !S.rv) { const v = S.viewers.get(String(userId)); if (v && t - v.beat <= BEAT_MS) n++; }   // (S4: a reveal is no slot)
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
  console.log(`[livecam] end room=${S.roomId} target=${S.mfEver || S.veil || S.rv ? "-" : S.login} why=${why}`);
  if (S.rv) return;                                   // 1.99?? (privacy controls S4): a reveal is nobody's tile, slot or pin
  runHooks(END_HOOKS, [S, why], "end");               // micfollow: the mic stage's tile follows its relay
}
// ── 1.99ahn dead relay (see the header) ──
let SYNC_AT = 0;                         // the last MediaMTX path list (noteSync)
/** Is MediaMTX's path list fresh (its API answered within SYNC_FRESH_MS)? Stale = nothing is judged by it. */
const syncFresh = (t = now()) => SYNC_AT > 0 && t - SYNC_AT <= SYNC_FRESH_MS;
/** 1.99ahn dead relay review (F1): how long the path lists THEMSELVES have shown this relay without its stream, counted from
 *  `from` (Pepe's "live") when that is later - up to the latest list (SYNC_AT), never up to now: a list is trusted for
 *  SYNC_FRESH_MS, but it proves nothing about the time after it was taken (MediaMTX's API may have gone quiet just before the
 *  stream arrived). 0 = the latest list had it. */
const missedSince = (S, from = 0) => (S.missSince ? SYNC_AT - Math.max(S.missSince, from || 0) : 0);
/** Never live within START_MS? Pepe never said live: as before. Pepe said live: only on a fresh path list, after the lists
 *  have shown no stream for NOMEDIA_MS, BOT_GRACE_MS of them after his first "live" (a slow but real open isn't cut) - and
 *  (review F2) a dead publish he reports live gets its restart (want[].nomedia) first, and that restart its chance
 *  (restartSpent), at most until START_CAP_MS after the hold. */
function startOver(S, t) {
  if (S.liveAt || t - S.createdAt <= START_MS) return false;
  if (!S.botLiveAt) return true;
  if (!syncFresh(t) || missedSince(S) < NOMEDIA_MS || missedSince(S, S.botLiveAt) < BOT_GRACE_MS) return false;
  if (t - S.createdAt > START_CAP_MS) return true;
  if (!S.nomediaAt) return !(S.botLiveSince && botOk(t));   // he's live on it: his next poll gets the nomedia (forBot)
  return restartSpent(S, t);
}
/** A relay that WAS ready lost its stream, Pepe was asked to restart it (nomediaAt) and the lists still don't have it
 *  START_MS later - nor once his restart has had its chance (review F2). */
function lostOver(S, t) {
  return !!(S.liveAt && S.nomediaAt && S.missSince > 0 && syncFresh(t) && SYNC_AT - S.nomediaAt > START_MS && restartSpent(S, t));
}
/** 1.99ahn dead relay review (F2): has the restart Pepe was asked for (nomediaAt, the first of this loss) had its chance? Not
 *  within RESTART_MS (he acts on his next poll). Not live yet (backoff / starting): START_MS from when he went down, like a
 *  fresh open. Still the publish he was asked to end (an older Pepe ignores nomedia): yes. A restarted publish: once the lists
 *  have shown BOT_GRACE_MS without it since its "live". Never past RESTART_CAP_MS. */
function restartSpent(S, t) {
  const since = t - S.nomediaAt;
  if (since > RESTART_CAP_MS) return true;
  if (since <= RESTART_MS) return false;
  if (!S.botLiveSince) return !S.botDownAt || t - S.botDownAt > START_MS;
  if (S.botLiveSince <= S.nomediaAt) return true;
  return missedSince(S, S.botLiveSince) >= BOT_GRACE_MS;
}
/** Pepe reports this relay live (botLive: on this poll), but the fresh path lists haven't had its stream for NOMEDIA_MS (LOST_MS
 *  for one that was ready) - NOMEDIA_MS of them since his latest (re)start's "live". -> true = want[].nomedia */
function noMedia(S, t, botLive) {
  if (!botLive || !S.botLiveSince || !S.missSince || !syncFresh(t)) return false;
  return missedSince(S) >= (S.liveAt ? LOST_MS : NOMEDIA_MS) && missedSince(S, S.botLiveSince) >= NOMEDIA_MS;
}
/** 1.99?? (privacy controls S5): why session S can't go on under its identity any more (null = it can): a veiled one whose frog-name
 *  session isn't the person's open incognito one now (incognito off, !bridge hide, the session ended, the switch off / Pepe's word
 *  gone); a named one whose person shows veiled in its room now (while incognito cams are effective - before that Pepe ends it). */
function veilWhy(S, t = now()) {
  if (!S || S.ended || S.rv) return null;             // (1.99?? privacy controls S4: a reveal got past the veil on purpose)
  const R = bridgeRooms().get(String(S.roomId));
  if (S.veil) {
    if (!icEffective(t)) return "switched_off";
    if (!R) return null;                                  // (the room is gone: the usual end follows)
    let v = null;
    try { v = IC().entryOf(R, S.veil.id); } catch (e) { v = null; }
    return v && v.login === S.login && String(v.sess) === S.veil.sess ? null : "veil_changed";
  }
  if (!R || !icEffective(t)) return null;
  try { return IC().veiledPresence(R, S.login) ? "veil_changed" : null; } catch (e) { return null; }
}
/** incogcams.setOn(false): every veiled session ends now. -> how many */
function veilSwitchOff(t = now()) {
  let n = 0;
  for (const S of [...SESS.values()]) if (!S.ended && S.veil) { endSession(S, "switched_off", t); n++; }
  return n;
}
/** frognames.onEnd (veilstage.js): frog-name session `sess` of room `roomId` ended - its cam sessions end now. -> how many */
function veilEnded(roomId, sess, t = now()) {
  let n = 0;
  for (const S of [...SESS.values()]) if (!S.ended && S.veil && S.roomId === String(roomId) && S.veil.sess === String(sess)) { endSession(S, "veil_changed", t); n++; }
  return n;
}
function sweep(t = now()) {
  for (const S of [...SESS.values()]) {
    if (!S.ended) { const vw = veilWhy(S, t); if (vw) endSession(S, vw, t); }   // 1.99?? (privacy controls S5)
    if (!S.ended && S.rv) revealSweep(S, t);                                     // 1.99?? (privacy controls S4)
    else if (!S.ended) {
      for (const [uid, v] of [...S.viewers.entries()]) if (t - v.beat > BEAT_MS) dropViewer(S, uid, "gone", t);
      if (S.stageViewers) for (const [uid, v] of [...S.stageViewers.entries()]) if (t - v.beat > BEAT_MS) { S.stageViewers.delete(uid); for (const rid of v.readers || []) kickReader(rid); }
      if (held(S)) S.wantUntil = Math.max(S.wantUntil || 0, t + cfg().linger_s * 1000);   // 1.99zc: held by a stage slot / the mic stage
      if (!S.viewers.size && !held(S) && S.wantUntil && S.wantUntil < t) endSession(S, "unwatched", t);
      // 1.99ahn dead relay: Pepe opened it but MediaMTX never had it -> start_timeout (not an older refusal's botWhy)
      else if (startOver(S, t)) endSession(S, S.botLiveAt ? "start_timeout" : (S.botWhy || "start_timeout"), t);
      else if (lostOver(S, t)) endSession(S, "relay_lost", t);
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
async function start(u, R, login, t = now(), opts = {}) {
  await init();
  if (!u || !u.userId) throw refuse("signin");
  if (!on()) throw refuse("off");
  if (R.livecams === false) throw refuse("room_off");
  if (!(await require("./bridge-relay").padFull(u.userId, R.id))) throw refuse("pad_access");
  // 1.99?? (privacy controls S5): {id} = an incognito person's cam by the opaque id of their frog-name roster entry (incogcams.camOf:
  // the switch and Pepe's word, their open session, on cam) - the login is resolved here, server-side, and never answered
  let veil = null, m = null;
  if (opts && opts.id != null) {
    const V = IC().camOf(R, String(opts.id), t);
    if (!V) throw refuse("not_on_cam");
    login = V.login;
    veil = { id: V.id, sess: V.sess, alias: V.alias, hood: V.hood };
    m = { display: V.alias || "someone", on_cam: true };
  } else {
    login = String(login || "").toLowerCase();
    m = LOGIN_RE.test(login) ? memberOf(R, login) : null;
    if (!m || !m.on_cam) throw refuse("not_on_cam");
    // 1.99?? (privacy controls S5, spec 2.2): a NAMED cam waits while the person shows veiled in this room (a mic hold frozen
    // veiled at its grab): one face under the frog name and the real name at once would unveil what that hold said
    if (icEffective(t) && IC().veiledPresence(R, login)) throw refuse("unavailable");
  }
  // 1.99aak: staff in 👻 ghost mode get past the owner's opt-out, "private" and blocks (moderation - the user's decision,
  // 2026-10-15); the bypass is audited (livecam_audit / cam_views bypass) and nobody is told. Everyone else: the owner's rules.
  // 1.99?? (privacy controls S5, owner Q9: the ghost bypass covers veiled cams too). A veiled cam's refusals are ONE generic
  // "unavailable" (Q23): never a reason, a mode or "ask to watch" - they would describe the person behind the frog name
  const ghost = isGhost(u.userId);
  let bypass = null;
  if (optedOut(login)) { if (!ghost) throw refuse(veil ? "unavailable" : "opted_out"); bypass = "opted_out"; }
  try { if ((await require("./stories").privateLogins([login])).has(login)) { if (!ghost) throw refuse(veil ? "unavailable" : "opted_out"); bypass = bypass || "private"; } }
  catch (e) { if (e.refuse) throw e; }
  if (CV().blocked(login, u.userId)) { if (!ghost) throw refuse("unavailable"); bypass = bypass || "blocked"; }   // 1.99yq: !blockviewer
  // 1.99aar: the owner's mode (members / followers / on request + their "always" list, camaccess.js); a refused viewer may ask
  const g = await require("./camaccess").gate(login, u.userId);
  if (g) {
    if (!ghost) throw veil ? refuse("unavailable") : new Refuse(403, g.error, g.code, { can_ask: g.can_ask, pending: g.pending, mode: g.mode });
    bypass = bypass || g.code;
  }
  const k = keyOf(R.id, login);
  if ((COOL.get(k) || 0) > t) throw refuse(veil ? "unavailable" : "ended_by");
  if (!botOk(t)) throw refuse("nopepe");
  let S = SESS.get(k);
  if (S && S.ended) { SESS.delete(k); S = null; }
  // 1.99?? (privacy controls S5): a session belongs to ONE identity - one started under the other (named vs this frog-name session)
  // ends now, everyone on it included (the sweep would end it within seconds anyway)
  if (S && !sameIdentity(S, veil)) { endSession(S, "veil_changed", t); SESS.delete(k); if (BY_PATH.get(S.path) === k) BY_PATH.delete(S.path); S = null; }
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
  // 1.99?? (privacy controls review RV-4, owner Q8 + Q9: the ghost bypass is "behind the reveal audit log", veiled cams included): a 👻
  // view that gets past someone's rules writes its rows FIRST, in ONE transaction - livecam_audit, the see-through log (cam_reveal, ref
  // "ghost:<audit id>:g") and admin_audit - and a failed write refuses it (nothing opened). For a veiled cam always (the S5 path); for a
  // named one while cam reveals are in effect - with that switch off a named bypass is logged as before (best effort).
  const strictGhost = bypass != null && !(S && S.viewers.get(uid)) && (!!veil || crEffective(t));
  let preAudit = null;
  if (strictGhost) {
    try { preAudit = await ghostRows(u, R, login, veil ? veil.alias || "someone" : null, bypass, t); }
    catch (e) { console.error("[livecam] ghost audit:", e && e.message); preAudit = null; }
    if (!preAudit) throw new Refuse(500, "Couldn't log it - nothing was opened.", "audit");
  }
  if (!S) {
    S = newSess(R, login, m, t, veil);
    console.log(`[livecam] start room=${R.id} target=${veil ? "-" : login} viewer=${u.username || uid}`);
  }
  let v = S.viewers.get(uid);
  if (!v) {
    v = { since: t, beat: t, username: u.username || null, readers: new Set(), auditId: preAudit, ghost: isGhost(uid), bypass };
    S.viewers.set(uid, v);
    if (!preAudit) {
      try {
        const r = await runQuery("INSERT INTO livecam_audit (room_id, target, viewer_id, viewer_name, started, ghost, bypass, veil) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                                 [R.id, login, uid, u.username || null, t, v.ghost ? 1 : 0, bypass, S.veil ? S.veil.alias || "someone" : null]);
        v.auditId = r && r.id ? Number(r.id) : null;
      } catch (e) { console.error("[livecam] audit:", e.message); }
    }
  }
  v.beat = t;
  S.wantUntil = Math.max(S.wantUntil, t + cfg().linger_s * 1000);
  // (1.99?? privacy controls S5: a veiled session's key is its opaque id - never keyOf / the login)
  return { ok: true, key: S.veil ? S.veil.id : k, whep: W().whepUrl(S.path) + "?pt=" + encodeURIComponent(readTicket(uid, S.path, t)), state: stateOf(S, t),
           slots: { used: slotsOf(uid, t), max }, kbps: rateOf(S), expires: t + TICKET_MS };
}
/** 1.99?? (privacy controls review RV-4): cam reveals in effect (camreveal.js)? Fails closed. */
function crEffective(t = now()) { try { return require("./camreveal").effective(t) === true; } catch (e) { return false; } }
/** 1.99?? (privacy controls review RV-4): a 👻 ghost's bypass view - its rows in ONE transaction BEFORE any ticket: livecam_audit (ghost,
 *  what it got past, the frog name for a veiled cam), seethrough_log (scope cam_reveal, ref "ghost:<audit id>:g") and admin_audit
 *  (seethrough.cam_reveal). -> the livecam_audit id | throws (the caller refuses the view) */
async function ghostRows(u, R, login, veilLabel, bypass, t = now()) {
  const ST = require("./seethrough"), AA = require("./adminaudit");
  await ST.init(); await AA.init();
  const uid = String(u.userId);
  return tx(async () => {
    const r = await runQuery("INSERT INTO livecam_audit (room_id, target, viewer_id, viewer_name, started, ghost, bypass, veil) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                             [String(R.id), login, uid, u.username || null, t, 1, bypass, veilLabel]);
    const id = r && r.id ? Number(r.id) : null;
    if (!id) throw new Error("livecam: no audit row");
    const st = await ST.log({ userId: uid, role: "ghost", scope: "cam_reveal", roomId: String(R.id), logins: [login], reason: "", ref: "ghost:" + id + ":g" });
    if (!st) throw new Error("livecam: no see-through row");
    await AA.record({ userId: uid, username: u.username || null }, "seethrough.cam_reveal", null,
                    { room: String(R.id), ghost: true, live: true, veiled: veilLabel != null, bypass, audit: id, st }, null);
    return id;
  });
}
function stateOf(S, t = now()) {
  if (!S) return "none";
  if (S.ended) return "ended";
  return S.ready && t - S.seenAt <= SYNC_FRESH_MS ? "live" : "connecting";
}
/** 1.99?? (privacy controls S5): the session a page names - {id} = a veiled one by its opaque id; a login (or {login}) = a NAMED
 *  one only (a login never reaches a veiled session: guessing who is behind a frog name and beating that login tells nothing). */
function sessOf(roomId, ref) {
  if (ref && typeof ref === "object" && ref.id != null) {
    const id = String(ref.id);
    for (const S of SESS.values()) if (S.roomId === String(roomId) && S.veil && S.veil.id === id && !S.ended) return S;
    for (const S of SESS.values()) if (S.roomId === String(roomId) && S.veil && S.veil.id === id) return S;
    return null;
  }
  const login = ref && typeof ref === "object" ? ref.login : ref;
  const S = SESS.get(keyOf(roomId, String(login == null ? "" : login)));
  return S && !S.veil ? S : null;
}
/** The page's beat: keeps the slot. -> {state, why, viewers}  (ref: a login, or {id} - 1.99?? privacy controls S5) */
function beat(userId, roomId, login, t = now()) {
  const S = sessOf(roomId, login);
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
    if (S.ended || S.login !== l || S.rv) continue;    // (1.99?? privacy controls S4: a block doesn't stop a moderation view)
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
    // 1.99?? (privacy controls S4): a moderator viewing it through a reveal - `reveal`: camviewers counts them as "someone moderating
    // <pad>", never by name (owner Q11); a 👻 ghost is never counted (isGhost: the live switch, not the one at the start)
    // (review RV-3: only once the person was TOLD - the first frame, not a ghost: before it, or after a failed open, nobody is listed)
    if (S.rv) { for (const [uid, v] of freshViewers(S, t)) if (v.told) out.push({ userId: uid, username: null, room: S.roomId, since: v.since, ghost: isGhost(uid), reveal: true }); continue; }
    for (const [uid, v] of freshViewers(S, t)) out.push({ userId: uid, username: v.username, room: S.roomId, since: v.since, ghost: !!v.ghost });
    // 1.99zc; micfollow (D-19): `mf` = they watch ONLY through a pad's mic stage - counted for the cam's owner, never named
    for (const [uid, v] of freshStage(S, t)) out.push({ userId: uid, username: v.username || null, room: S.roomId, since: v.since, stage: true, ghost: !!v.ghost, mf: mfOnlyVia(v) });
  }
  return out;
}
function stop(userId, roomId, login, t = now()) {
  const S = sessOf(roomId, login);
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
/** 1.99?? (privacy controls review ID-6): would ending `login` by its typed name touch a veiled cam - a frog-name session under that
 *  login's key, or (incognito cams in effect) the person showing veiled in R now (a cooldown would then refuse their frog-name ▶ Live)? */
function veiledByLogin(R, login, t = now()) {
  const S = SESS.get(keyOf(R.id, String(login || "").toLowerCase()));
  if (S && S.veil) return true;
  try { return icEffective(t) && !!IC().veiledPresence(R, String(login || "").toLowerCase()); } catch (e) { return false; }
}
function endBy(u, R, login, t = now()) {
  login = String(login || "").toLowerCase();
  const k = keyOf(R.id, login);
  const S = SESS.get(k);
  COOL.set(k, t + END_COOLDOWN_MS);
  if (S) endSession(S, endsAny(u) && String(u.camfrogUsername || "").toLowerCase() !== login ? "ended_by_admin" : "ended_by", t);
  console.log(`[livecam] ended room=${R.id} target=${S && S.veil ? "-" : login} by=${u.username || u.userId}`);
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
async function stageConsent(R, login, t = now(), { actor = null, mf = false, veil = null } = {}) {
  if (!on()) throw refuse("off");
  if (!R || !R.cams) throw refuse("room_off");
  if (R.livecams === false) throw refuse("room_off");
  if (!bridgeOk(R.id)) throw refuse("room_off");
  login = String(login || "").toLowerCase();
  // 1.99?? (privacy controls S5): `veil` = an incognito person's cam under that frog-name session (the mic stage's veiled cam tile):
  // their incognito roster entry of THAT session (incogcams.entryByLogin - the switch and Pepe's word too); a named hold never
  // takes a person who shows veiled here now (a hold frozen veiled - spec 2.2)
  let m;
  if (veil) {
    const V = icEffective(t) ? IC().entryByLogin(R, login, veil.sess) : null;
    m = V ? { display: V.alias || "someone", on_cam: V.onCam } : null;
  } else {
    m = LOGIN_RE.test(login) ? memberOf(R, login) : null;
    if (m && icEffective(t) && IC().veiledPresence(R, login)) throw refuse("unavailable");
  }
  // 1.99afl (S2): the mic stage may ask for a cam Pepe's roster can't classify yet (on_cam unknown - a warm relay, or its one
  // exact open per list-read epoch; micfollow-core decides). Review: a Pepe through 1.99afk opens no such cam - he refuses it at
  // once as "not_on_cam" (_lv_why_not), which the mic stage reads as "checking their cam…" - so the epoch open waits for a Pepe
  // that says he opens one by its exact name (micfollow-core.MF_UNK_OPEN). A cam the roster says is OFF is never asked for;
  // every other holder still needs it on cam.
  if (!m || !(m.on_cam || (mf === true && m.on_cam == null))) throw refuse("not_on_cam");
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
  // 1.99?? (privacy controls S5): one identity per session - a session of the other one (named / another frog-name session) ends now
  const veil = opts.veil && opts.veil.sess != null ? opts.veil : null;
  if (S && !sameIdentity(S, veil)) { endSession(S, "veil_changed", t); SESS.delete(k); if (BY_PATH.get(S.path) === k) BY_PATH.delete(S.path); S = null; }
  if (S && !isMfHolder(H)) {
    for (const h of S.holds) if (h !== H && !isMfHolder(h)) throw new Refuse(409, "That cam is already on the stage.", "on_stage");
  }
  if (!S && liveCount() >= cfg().max_live) throw refuse("slots_busy");
  if (!S) S = newSess(R, login, m, t, veil);
  if (!S.stageViewers) S.stageViewers = new Map();
  if (!S.holds) S.holds = new Set();
  const had = S.holds.has(H);
  S.holds.add(H);
  if (opts.mf === true || isMfHolder(H)) { S.mf = true; S.mfEver = true; if (!had) S.mfHeldAt = t; }   // mfix review: an exact refusal from before this hold is ignored
  S.wantUntil = Math.max(S.wantUntil, t + cfg().linger_s * 1000);
  if (!had) console.log(`[livecam] stage hold room=${R.id} target=${isMfHolder(H) || S.veil ? "-" : login} holder=${isMfHolder(H) ? "mf" : H}`);
  return { display: S.veil ? S.veil.alias || "someone" : m.display || login };
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
/** wave2 WP-4 (F.2): the mic stage's tile of `login` left the stage - keep its relay WARM instead of dropping it: the warm
 *  holder "mfw:<room>" goes on first (synchronously, so the session never has a moment without a holder and never ends),
 *  then "mf:<room>" lets go (its stage viewers are kicked, as on any release). -> true when the mic stage held it */
function stageWarm(roomId, login, t = now()) {
  const S = SESS.get(keyOf(roomId, String(login || "").toLowerCase()));
  const H = MF_PREFIX + String(roomId);
  if (!S || S.ended || !S.holds || !S.holds.has(H)) return false;
  S.holds.add(MFW_PREFIX + String(roomId));
  releaseHolder(S, H, t);
  S.mf = true;                                         // (still a mic-stage relay: Pepe keeps it exact - want[].mf)
  S.wantUntil = Math.max(S.wantUntil || 0, t + cfg().linger_s * 1000);
  console.log(`[livecam] stage warm room=${S.roomId} target=-`);
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
           kept: holds.includes(MFW_PREFIX + roomId),          // wave2 WP-4 (F.2): kept warm by the mic stage (no tile, no viewer)
           mfOnly: holds.length > 0 && holds.every(isMfHolder) && !freshViewers(S, t).length, viewers: shownCount(freshStage(S, t)) };
}
/** mfix: does anything besides the mic stage use this relay - a cam slot / pin holder, or a fresh ▶ Live viewer? */
function sharedBeyondMf(S, t = now()) {
  return !!(S && ((S.holds && [...S.holds].some((h) => !isMfHolder(h))) || freshViewers(S, t).length > 0));
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
  // wave2 WP-4 (F.2): a relay the mic stage only keeps warm is on no program - nobody can ever get a ticket through it
  if (H.startsWith(MFW_PREFIX)) throw new Refuse(404, "That cam isn't on the stage any more.", "gone");
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

// ── 1.99?? (privacy controls S4): cam reveals (see the header; camreveal.js decides who may and writes the rows) ──
const REVEAL_MS = 3 * 60 * 1000;          // a moderator's view lasts this long; "Extend" writes a new row and gives another REVEAL_MS (Q15)
const RV_KEY = ":rv:";
const SID_RE = /^[0-9a-f]{12}$/;
const RV_STARTING = new Set();             // "room|login" while a reveal of them is being opened (its audit rows are on their way)
let RV_NOTICE = null;                      // camreveal's hook: fn(S, userId, v) - tell the person (called once per moderator per session)
function onRevealNotice(fn) { RV_NOTICE = typeof fn === "function" ? fn : null; }
/** The reveal session `sid` of room `roomId` (an ended one too, for a last beat's "why"), or null. */
function revealSess(roomId, sid) {
  const s = String(sid == null ? "" : sid);
  if (!SID_RE.test(s)) return null;
  for (const S of SESS.values()) if (S.rv && S.sid === s && S.roomId === String(roomId)) return S;
  return null;
}
/** The open reveal of `login`'s cam in room `roomId` - one per person at a time (a second moderator joins it). */
function revealOf(roomId, login) {
  const l = low(login);
  for (const S of SESS.values()) if (S.rv && !S.ended && S.roomId === String(roomId) && S.login === l) return S;
  return null;
}
/** The open reveal a moderator is viewing now (one at a time each), or null. */
function revealOfViewer(userId, t = now()) {
  for (const S of SESS.values()) {
    if (!S.rv || S.ended) continue;
    const v = S.viewers.get(String(userId));
    if (v && t - v.beat <= BEAT_MS && t <= v.until) return S;
  }
  return null;
}
function newRevealSess(R, login, sid, meta, t) {
  const p = PREFIX + crypto.randomBytes(8).toString("hex");      // RANDOM: never pathFor / vpathFor (a URL ties nothing to anyone)
  const S = { key: keyOf(R.id, login) + RV_KEY + sid, roomId: R.id, login, display: meta.label || "someone", path: p, viewers: new Map(), createdAt: t,
              veil: null, rv: { why: String(meta.why || "withheld"), veiled: meta.veiled === true, label: meta.label || null, bylogin: meta.bylogin === true },
              wantUntil: t + REVEAL_MS, liveAt: 0, ready: false, readers: 0, seenAt: 0, sourceId: null, botState: null, botWhy: null,
              botLiveAt: 0, botLiveSince: 0, botRestarts: 0, missSince: 0, nomediaAt: 0, botDownAt: 0,
              ended: 0, endWhy: null, holds: new Set(), lastHolds: null, mf: false, stageViewers: new Map(), sid };
  SESS.set(S.key, S);
  BY_PATH.set(p, S.key);
  console.log(`[livecam] reveal start room=${R.id} target=-`);
  return S;
}
/**
 * A moderator opens (or joins) a reveal of `login`'s cam in room R. The caller (camreveal.js) has checked the right, the target and
 * that the cam is withheld from them. meta = {why, label, veiled, bylogin, role}. writeRows(sid) -> Promise<{auditId}> writes the reveal's
 * rows in ONE transaction BEFORE any ticket - a throw refuses it and nothing is opened.
 * -> {ok, rv, whep, state, until, expires, ghost?} | throws Refuse
 */
async function revealStart(u, R, login, meta, writeRows, t0 = now()) {
  await init();
  if (!on()) throw refuse("off");
  if (!R || !R.cams || R.livecams === false || !bridgeOk(R.id)) throw refuse("room_off");   // (Q13: the pad's own switches)
  if (!botOk(t0)) throw refuse("nopepe");
  login = low(login);
  if (!LOGIN_RE.test(login)) throw refuse("not_on_cam");
  const uid = String(u.userId);
  const mine = revealOfViewer(uid, t0);
  if (mine && !(mine.roomId === R.id && mine.login === login)) throw new Refuse(409, "Close the cam you're viewing for moderation first.", "one_open");
  const rk = keyOf(R.id, login);
  if (RV_STARTING.has(rk)) throw new Refuse(409, "Someone is opening that cam right now - try again in a moment.", "busy");
  let S = revealOf(R.id, login);
  if (!S || !S.viewers.has(uid)) {
    if (!fitsBudget(S, t0)) throw refuse("budget");
    if (!S && liveCount() >= cfg().max_live) throw refuse("slots_busy");
  }
  const sid = S ? S.sid : crypto.randomBytes(6).toString("hex");
  RV_STARTING.add(rk);
  let a;
  try { a = await writeRows(sid); }
  finally { RV_STARTING.delete(rk); }
  if (!a || !a.auditId) throw new Refuse(500, "Couldn't log it - nothing was opened.", "audit");
  const t = now();
  S = revealOf(R.id, login);
  if (!S) S = newRevealSess(R, login, sid, meta, t);
  const old = S.viewers.get(uid);
  if (old) audit(S, uid, old, "reopened", t);                    // (the new rows are this view's; the old row closes)
  const v = { since: old ? old.since : t, beat: t, username: u.username || null, readers: old ? old.readers : new Set(), auditId: a.auditId,
              ghost: isGhost(uid), bypass: "reveal:" + S.rv.why, role: meta.role || null, until: t + REVEAL_MS, readAt: old ? old.readAt : 0,
              told: old ? old.told : false, rv: true };
  S.viewers.set(uid, v);
  S.wantUntil = Math.max(S.wantUntil, v.until);
  return { ok: true, rv: S.sid, whep: W().whepUrl(S.path) + "?pt=" + encodeURIComponent(readTicket(uid, S.path, t)), state: stateOf(S, t),
           until: v.until, expires: t + TICKET_MS, ...(v.ghost ? { ghost: true } : {}) };
}
/** Drop one moderator from a reveal; the reveal ends when nobody is left (no linger: Pepe closes the cam window). */
function revealDrop(S, userId, why, t = now()) {
  if (!S || !S.rv) return false;
  const had = dropViewer(S, String(userId), why, t);
  if (!S.ended && !freshViewers(S, t).length) endSession(S, why, t);
  return had;
}
/** The reveal player's beat (the route re-checked the right and the target first). -> {ok, state, until?, why?, ghost?} */
function revealBeat(userId, roomId, sid, t = now()) {
  const S = revealSess(roomId, sid);
  if (!S) return { ok: true, state: "ended", why: "gone" };
  if (S.ended) return { ok: true, state: "ended", why: S.endWhy || "ended" };
  const v = S.viewers.get(String(userId));
  if (!v || t - v.beat > BEAT_MS) return { ok: true, state: "ended", why: "gone" };
  if (t > v.until) { revealDrop(S, userId, "time_up", t); return { ok: true, state: "ended", why: "time_up" }; }
  v.beat = t;
  revealNotices(S, t);                                           // (a ghost who turned ghost off since: the person is told now)
  return { ok: true, state: stateOf(S, t), until: v.until, ...(isGhost(userId) ? { ghost: true } : {}) };
}
/** "Extend (logged)": the route wrote the new rows (auditId); the old livecam_audit row closes, the cap moves. -> bool */
function revealExtend(userId, roomId, sid, auditId, t = now()) {
  const S = revealSess(roomId, sid);
  const v = S && !S.ended ? S.viewers.get(String(userId)) : null;
  if (!v || t - v.beat > BEAT_MS || t > v.until) return false;
  audit(S, userId, v, "extended", t);
  v.auditId = auditId;
  v.until = t + REVEAL_MS;
  v.beat = t;
  S.wantUntil = Math.max(S.wantUntil, v.until);
  return true;
}
/** The moderator closes the player (or the route ends it: lost_right, visible, left_out ...). */
function revealStop(userId, roomId, sid, why = "stopped", t = now()) {
  const S = revealSess(roomId, sid);
  if (!S || S.ended) return false;
  return revealDrop(S, userId, why, t);
}
/** camreveal.setOn(false): every reveal ends now. -> how many */
function revealSwitchOff(t = now()) {
  let n = 0;
  for (const S of [...SESS.values()]) if (!S.ended && S.rv) { endSession(S, "switched_off", t); n++; }
  return n;
}
/** The first frame: a moderator's reader authenticated (v.readAt) AND MediaMTX had the stream (S.liveAt) - the person is told, once
 *  per moderator per session, unless that moderator is a 👻 ghost NOW (asked again on every beat). A failed open never gets here. */
function revealNotices(S, t = now()) {
  if (!S || !S.rv || S.ended || !S.liveAt) return 0;
  let n = 0;
  for (const [uid, v] of S.viewers) {
    if (v.told || !v.readAt || isGhost(uid)) continue;
    v.told = true;
    n++;
    if (RV_NOTICE) { try { RV_NOTICE(S, uid, v); } catch (e) { console.error("[livecam] reveal notice:", e && e.message); } }
  }
  return n;
}
/** The sweep's turn for a reveal: stale beats ("gone") and spent caps ("time_up") drop their moderator; empty -> it ends; never a
 *  frame by the dead-relay timeouts -> "no_video" (nobody is told); a lost stream -> "relay_lost". */
function revealSweep(S, t) {
  let last = null;
  for (const [uid, v] of [...S.viewers.entries()]) {
    if (t - v.beat > BEAT_MS) { dropViewer(S, uid, "gone", t); last = "gone"; }
    else if (t > v.until) { dropViewer(S, uid, "time_up", t); last = "time_up"; }
  }
  if (!S.viewers.size) return endSession(S, last || "unwatched", t);
  if (startOver(S, t)) return endSession(S, "no_video", t);
  if (lostOver(S, t)) return endSession(S, "relay_lost", t);
  revealNotices(S, t);
}

// ── Pepe ──
const str = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);
const TERMINAL = new Set(["opted_out", "not_on_cam", "room_off", "slots_busy", "open_failed", "not_that_cam", "noswitch", "busy", "spawn_failed",
  "failed", "cam_closed", "ambiguous",     // micfollow: "ambiguous" = an exact open found two people with that name
  "list_unread"]);                         // 1.99afl: Pepe can't read the room's participant list (bot 1.99afk; the mic stage pauses the room)
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
  // 1.99?? (privacy controls S4): Pepe's line about a reveal names it by rv (its sid) - never matched by keyOf (that's ▶ Live's)
  const lineSess = (x) => {
    if (x.rv == null) return SESS.get(keyOf(str(x.room, 128), str(x.login, 40)));
    const S = revealSess(str(x.room, 128), str(x.rv, 24));
    return S && S.login === low(str(x.login, 40)) ? S : null;
  };
  for (const x of live) {
    if (!x || typeof x !== "object") continue;
    const S = lineSess(x);
    if (!S || S.ended) continue;
    seen.add(S.key);
    const prevState = S.botState;
    S.botState = str(x.state, 20);
    // 1.99ahn dead relay: Pepe's word is his, never MediaMTX's - liveAt comes from noteSync only. His live streak starts over
    // when he wasn't live on his last report, or his publisher restarted / is a new one (its restart count moved).
    const restarts = Math.max(0, Math.floor(Number(x.restarts) || 0));
    if (S.botState === "live") {
      if (!S.botLiveAt) S.botLiveAt = t;
      if (!S.botLiveSince || prevState !== "live" || restarts !== S.botRestarts) S.botLiveSince = t;
    } else liveEnded(S, t);
    S.botRestarts = restarts;
    const wasExact = S.botInfo ? S.botInfo.exact : null;
    if (S.mf && wasExact !== (typeof x.exact === "boolean" ? x.exact : null)) exactMoved.push(S);
    S.botInfo = { grab_fps: Number(x.grab_fps) || null, grab_ms: Number(x.grab_ms) || null, size: Array.isArray(x.size) ? x.size.slice(0, 2) : null,
                  restarts: Number(x.restarts) || 0, up_s: Number(x.up_s) || 0, setup_ms: Number(x.setup_ms) || null,
                  source: x.source === "passthrough" ? "passthrough" : "reencode", fps: Number(x.fps) || null, fallback: str(x.fallback, 60) || null,
                  hold_ms: typeof x.hold_ms === "number" && Number.isFinite(x.hold_ms) ? Math.round(Math.max(0, Math.min(10000, x.hold_ms))) : null,
                  kbps: Number.isFinite(Number(x.kbps)) && Number(x.kbps) >= 0 ? Math.min(100000, Number(x.kbps)) : null,
                  exact: typeof x.exact === "boolean" ? x.exact : null };   // micfollow: opened / verified by its exact name
    if (S.botState === "ended" || S.botState === "stopped") {
      const why = str(x.why, 30);
      if (S.rv) { if (TERMINAL.has(why)) endSession(S, why, t); }          // (S4: a reveal has no "ghost keeps watching")
      else if (why === "opted_out") ownerClosed(S, why, t);                // 1.99aak: a ghost keeps watching
      else if (TERMINAL.has(why)) endSession(S, why, t);
    }
  }
  for (const S of SESS.values()) if (!S.ended && !seen.has(S.key)) liveEnded(S, t);   // 1.99ahn: not on his report = not live now
  for (const S of exactMoved) {
    if (S.ended) continue;
    try { require("./micfollow").onExact(S.roomId, S.login); } catch (e) { /* no mic follows */ }
  }
  for (const x of (Array.isArray(body.refused) ? body.refused.slice(0, 50) : [])) {
    const S = x && typeof x === "object" ? lineSess(x) : null;
    if (!S || S.ended) continue;
    // mfix: Pepe says which session it was about (he re-sends a refusal for 30 s): an older one's never ends this one
    if (x.sid != null && str(x.sid, 24) !== S.sid) continue;
    const why = str(x.why, 30);
    // 1.99?? (privacy controls S4): a reveal Pepe couldn't open ends with his reason (nobody is told: no frame ever came); a passing
    // one ("cam_unknown" - he is reading the participant list again) only notes it
    if (S.rv) { if (!seen.has(S.key)) { S.botWhy = why; if (TERMINAL.has(why) || why === "opted_out") endSession(S, why, t); } continue; }
    if (x.x === true && why !== "opted_out") {
      // mfix review: an exact refusal from before the mic stage's latest hold of this cam is about an earlier hold (Pepe
      // re-sends one for 30 s; the mic stage may re-hold after soft_retry_s) - never a second soft failure of the new hold
      const age = Number(x.age);
      if (Number.isFinite(age) && age >= 0 && S.mfHeldAt && t - age * 1000 < S.mfHeldAt - EXACT_REFUSAL_SLACK_MS) continue;
      // mfix: an EXACT open failed (the mic stage asked for it) but a cam slot / ▶ Live viewer / pin uses the relay too - or
      // (mfix review) the relay is live anyway (Pepe put a shared relay back the ordinary way after a failed exact re-open):
      // only the mic stage lets go - the relay lives on for the others (opted_out ends it for all)
      if (seen.has(S.key) || (TERMINAL.has(why) && sharedBeyondMf(S, t))) {
        if (S.mf) { try { require("./micfollow").onExactRefused(S, why); } catch (e) { console.error("[livecam] micfollow:", e && e.message); } }
        continue;
      }
    }
    if (seen.has(S.key)) continue;
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
      // 1.99?? (privacy controls S4): a reveal - opened by its EXACT name, past the person's opt-out (bypass: it's a moderation view),
      // quiet (no room line, no room mod-log line), never the mic stage's; ghost_only while every moderator on it is a 👻 ghost
      if (S.rv) {
        const rkey = pubKey(S.path);
        if (!rkey) continue;
        const rfv = freshViewers(S, t);
        const rnm = noMedia(S, t, seen.has(S.key) && S.botState === "live");
        if (rnm && !S.nomediaAt) S.nomediaAt = t;
        want.push({ room: S.roomId, login: S.login, url: W().whipUrl(S.path), token: rkey, path: S.path, viewers: 1, sid: S.sid, rv: S.sid,
                    reveal: true, exact: true, bypass: true, quiet: true,
                    ...(rnm ? { nomedia: true } : {}), ...(rfv.length && rfv.every(([uid]) => isGhost(uid)) ? { ghost_only: true } : {}) });
        continue;
      }
      if (optedOut(S.login) && !ownerClosed(S, "opted_out", t)) continue;     // 1.99aak: only staff in ghost mode stay
      const key = pubKey(S.path);
      if (!key) continue;
      // 1.99aaf: ghosts aren't counted; ghost_only = nobody but staff in ghost mode watches -> Pepe says nothing in the room
      const fv = freshViewers(S, t), shown = shownCount(fv);
      // 1.99ahn dead relay: Pepe says live, MediaMTX has no stream -> he ends that publish and restarts it (an older Pepe ignores it)
      const nomedia = noMedia(S, t, seen.has(S.key) && S.botState === "live");
      if (nomedia && !S.nomediaAt) {
        S.nomediaAt = t;
        console.log(`[livecam] no media room=${S.roomId} target=${S.mfEver ? "-" : S.login} ${S.liveAt ? "lost" : "never"}=${Math.round((t - S.missSince) / 1000)}s`);
      }
      want.push({ room: S.roomId, login: S.login, url: W().whipUrl(S.path), token: key, path: S.path, viewers: Math.max(1, shown), sid: S.sid,
                  ...(nomedia ? { nomedia: true } : {}),
                  ...(fv.length && !shown && !held(S) ? { ghost_only: true } : {}),
                  ...(S.mf ? { mf: true } : {}),                                     // micfollow: open it by its exact name, never fuzzy
                  // mfix review: a ▶ Live viewer / cam slot / pin uses it too - a failed exact re-open is put back the ordinary way
                  ...(S.mf && sharedBeyondMf(S, t) ? { shared: true } : {}),
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
  // 1.99ahn dead relay: a gap in the lists (MediaMTX's API didn't answer for SYNC_FRESH_MS) starts every not-ready clock over
  const streak = syncFresh(t);
  SYNC_AT = t;
  const seen = new Set();
  for (const p of items || []) {
    const S = p && typeof p.name === "string" ? camForPath(p.name) : null;
    if (!S) continue;
    S.ready = !!(p.ready || p.available);
    if (S.ready && !S.liveAt) S.liveAt = t;
    noteMiss(S, S.ready, streak, t);
    S.readers = (Array.isArray(p.readers) ? p.readers : []).filter((r) => r && r.type === "webRTCSession").length;
    S.sourceId = p.source && p.source.type === "webRTCSession" ? String(p.source.id || "") || null : null;
    S.seenAt = t;
    seen.add(S.key);
  }
  for (const S of SESS.values()) if (!seen.has(S.key)) { S.ready = false; S.readers = 0; S.seenAt = t; noteMiss(S, false, streak, t); }
  for (const S of SESS.values()) if (S.rv && !S.ended && S.liveAt) revealNotices(S, t);   // 1.99?? (privacy controls S4): the first frame
}
/** 1.99ahn dead relay: Pepe isn't live on this relay now (review F2: botDownAt - when a restart's START_MS starts). */
function liveEnded(S, t) { if (S.botLiveSince) S.botDownAt = t; S.botLiveSince = 0; }
/** 1.99ahn dead relay: since when fresh path lists have gone without this relay's stream (0 = it's there). */
function noteMiss(S, ready, streak, t) {
  if (ready) { S.missSince = 0; S.nomediaAt = 0; return; }
  if (!streak) { S.missSince = t; S.nomediaAt = 0; }
  else if (!S.missSince) S.missSince = t;
}
const loopbackIp = (a) => /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.test(String(a || ""));
/** The auth hook for a cam path. publish: WHIP with the path's bearer. read: a fresh viewer's WHEP ticket, or the
 *  job-scoped loopback RTSP exception for a mic-stage capture. -> HTTP status. */
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
    if (S.rv) return revealAuth(S, b, p, proto);           // 1.99?? (privacy controls S4): a reveal's own rules
    // 1.99??: only a running mic-stage capture may authenticate a loopback RTSP reader.
    if (action === "read" && proto === "rtsp") return require("./stagemiccap").rtspAuth(b, p);
    if (proto !== "webrtc") return 403;                      // cam HLS and every other protocol remain refused
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
    // (review ID-4: a veiled session's row carries its frog name - the 👻 views list shows that, never the login)
    if (!v.noted && !mfVia) { v.noted = true; CV().noteViewers("live", S.roomId, S.login, [String(c.uid)], undefined, S.veil ? S.veil.alias || "someone" : null); }
    return 200;
  }
  return 403;
}

/** 1.99?? (privacy controls S4): a reader of a reveal's path. WebRTC: only a moderator on it (a fresh beat, inside their cap) with a
 *  valid ticket for THIS path, who may still see the pad (padFull) and still holds the right (camreveal.stillMay - asked fresh, as on
 *  every beat). RTSP: only a running evidence capture of it (camevidence.rtspAuth - loopback, job-scoped). Nothing else, ever. */
async function revealAuth(S, b, p, proto) {
  if (proto === "rtsp") { try { return require("./camevidence").rtspAuth(b, p); } catch (e) { return 403; } }
  if (proto !== "webrtc") return 403;
  let tok = null;
  try { tok = new URLSearchParams(String(b.query || "").replace(/^\?/, "")).get("pt"); } catch (e) { tok = null; }
  const c = checkTicket(tok, p);
  if (!c) return loopbackIp(b.ip) ? 403 : 401;
  const t = now();
  const v = S.viewers.get(String(c.uid));
  if (!v || t - v.beat > BEAT_MS || t > v.until) return 403;
  if (!(await require("./bridge-relay").padFull(c.uid, S.roomId))) return 403;
  try { if (!(await require("./camreveal").stillMay(c.uid, S))) return 403; } catch (e) { return 403; }
  if (S.ended) return 403;
  if (b.id && /^[0-9a-f-]{36}$/i.test(String(b.id))) v.readers.add(String(b.id));
  if (!v.readAt) v.readAt = t;
  revealNotices(S, t);
  return 200;
}

// ── views ──
/** For the pad's live view: may the ▶ Live button show, and the viewer's slots. null = no live cams here. */
function hint(R, userId) {
  if (!R || !R.cams || R.livecams === false || !on() || !botOk()) return null;
  if (!userId) return { on: true, signin: true };
  const t = now();
  const watching = [];
  // (1.99?? privacy controls S5: a veiled session by its opaque id - never the login)
  for (const S of SESS.values()) if (!S.ended && !S.rv && S.roomId === R.id) { const v = S.viewers.get(String(userId)); if (v && t - v.beat <= BEAT_MS) watching.push(S.veil ? S.veil.id : S.login); }
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
  // wave2 WP-4 (F.2): relays the mic stage keeps warm - "warm (mic stage, Ns left)"
  const keptOf = (S) => { try { return require("./micfollow").keptOf(S.roomId, S.login, t); } catch (e) { return null; } };
  const sessions = [...SESS.values()].filter((S) => !S.ended).map((S) => ({
    ...(S.holds && S.holds.has(MFW_PREFIX + S.roomId) ? { warm: true, warm_s: (() => { const k = keptOf(S); return k ? Math.max(0, Math.round((k.until - t) / 1000)) : null; })() } : {}),
    // 1.99?? (privacy controls S5): a veiled session shows its frog name only - never the login or keyOf (livecam.admin is "ops":
    // it may be granted to Staff, who never see through a veil - J-2); the End button names it by "v:<opaque id>"
    // 1.99?? (privacy controls S4): a reveal shows "rv:<sid>" and, for a veiled person, the frog name or "veiled" - never the login (the
    // login of a veiled reveal is only in the see-through log, /admin/bridge#seethrough)
    key: S.rv ? "rv:" + S.sid : S.veil ? "v:" + S.veil.id : S.key, room: S.roomId, login: S.veil || (S.rv && S.rv.veiled) ? null : S.login,
    display: S.rv ? (S.rv.veiled ? (S.rv.label || "veiled") + " (veiled)" : S.login) : S.veil ? (S.veil.alias || "someone") + " (incognito)" : S.display,
    ...(S.veil || (S.rv && S.rv.veiled) ? { veiled: true } : {}), ...(S.rv ? { reveal: true } : {}), state: stateOf(S, t), since: S.createdAt, liveAt: S.liveAt || null,
    viewers: freshViewers(S, t).map(([uid, v]) => ({ userId: uid, username: v.username, since: v.since, ghost: !!v.ghost })), readers: S.readers, bot: S.botInfo || null,
    kbps: Math.round(rateOf(S, c)), measured: !!(S.botInfo && S.botInfo.source === "passthrough" && Number(S.botInfo.kbps) > 0),
    outKbps: Math.round(rateOf(S, c) * (freshViewers(S, t).length + freshStage(S, t).length)),
    // 1.99ahn dead relay: Pepe says live, MediaMTX has had no stream this long (he was asked to restart it)
    ...(S.nomediaAt && S.missSince ? { nomedia: true, nomedia_s: Math.max(0, Math.round((t - S.missSince) / 1000)), lost: !!S.liveAt } : {}),
    botState: S.botState, botWhy: S.botWhy, stage: (S.holds ? [...S.holds].find((h) => !isMfHolder(h)) : null) || null, mf: !!S.mf,
    stageViewers: freshStage(S, t).length }));
  const viewers = totalViewers(t);
  // (1.99?? privacy controls S5: a row watched under a frog name shows that name, never the login)
  // (1.99?? privacy controls S4: a reveal's row says so - reveal: true - and a veiled person's shows "<frog name or veiled> (veiled)")
  const recent = (await getQuery(`SELECT room_id, target, viewer_name, started, ended, secs, end_reason, ghost, veil, bypass FROM livecam_audit ORDER BY id DESC LIMIT 30`))
    .map((r) => {
      const o = { ...r };
      const rv = String(o.bypass || "").startsWith("reveal:");
      if (o.veil != null) { o.target = String(o.veil) + (rv ? " (veiled)" : " (incognito)"); o.veiled = true; }
      if (rv) o.reveal = true;
      delete o.veil; delete o.bypass;
      return o;
    });
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
  /** 1.99?? (privacy controls S5): a request's cam: {id} (a veiled session's opaque id) or the login string. */
  const refOf = (b) => (b && b.id != null && b.id !== "" ? { id: String(b.id).slice(0, 40) } : String((b && b.login) || ""));

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
      const b = req.body || {};
      // (1.99?? privacy controls S5: {id} = an incognito person's cam by its opaque id)
      res.json(b.id != null && b.id !== "" ? await start(u, R, "", now(), { id: String(b.id).slice(0, 40) }) : await start(u, R, String(b.login || "")));
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
      // (1.99?? privacy controls S5: never for a veiled cam - asking would describe the person behind the frog name, Q23)
      if ((req.body || {}).id != null && icEffective()) throw refuse("unavailable");
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
    const ref = refOf(req.body);
    if (!(await require("./bridge-relay").padFull(req.user.userId, R.id))) {
      stop(req.user.userId, R.id, ref);
      return fail(res, refuse("pad_access"));
    }
    const blk = await require("./bridgeblocks").refusal(R.id, req.user.userId, "livecams");   // 1.99zf: blocked mid-stream -> it ends
    if (blk) {
      stop(req.user.userId, R.id, ref);
      return res.status(403).json({ ok: false, code: "blocked", error: blk, blocked: true, feature: "livecams", state: "ended" });
    }
    res.json(beat(req.user.userId, R.id, ref));
  });
  app.post("/api/rooms/:slug/livecam/stop", addUser, (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!fetchOnly(req, res)) return;
    if (!req.user || !req.user.userId) return fail(res, refuse("signin"));
    const R = bySlug(req.params.slug);
    res.json(R ? stop(req.user.userId, R.id, refOf(req.body)) : { ok: true });
  });
  app.post("/api/rooms/:slug/livecam/end", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!fetchOnly(req, res)) return;
    try {
      const u = await me(req);
      if (!u) throw refuse("signin");
      const R = bySlug(req.params.slug);
      if (!R) throw refuse("offline");
      // (1.99?? privacy controls S5: {id} = a veiled session - its login is resolved here and never answered; the moderation
      // history names its frog name)
      const ref = refOf(req.body);
      let login, VS = null;
      if (typeof ref === "object") {
        VS = sessOf(R.id, ref);
        if (!VS || VS.ended) throw new Refuse(404, "That live cam already ended.", "gone");
        login = VS.login;
      } else login = String(ref || "").toLowerCase();
      if (!LOGIN_RE.test(login)) throw new Refuse(400, "Whose cam?", "bad");
      if (!mayEnd(u, R, login)) throw new Refuse(403, "Only the cam's owner, the room's mods and the pad owner can end it.", "forbidden");
      // 1.99?? (privacy controls review ID-6): a typed login never reaches a VEILED cam - neither its session (same key as a named one)
      // nor the login's cooldown (which a frog-name ▶ Live checks too). The answer and the history line are the ones a wrong guess
      // gets, so ending by a guessed login can't confirm who is behind a frog name. Only {id} ends a veiled session.
      let out;
      if (!VS && veiledByLogin(R, login)) out = { ok: true };
      else out = endBy(u, R, login);
      // 1.99zf: a mod / the owner / staff ending someone else's live cam goes in the room's moderation history (pepemodlog.js)
      if (String(u.camfrogUsername || "").toLowerCase() !== login) {
        require("./rooms").event(R.id, "livecam-end", u.username || null, `ended the live view of ${VS ? VS.veil.alias || "someone" : login}'s cam`);
      }
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
      // (1.99?? privacy controls S4: cr = the by-login reveal card, only while cam reveals are in effect)
      let cr = null;
      try { cr = require("./camreveal").effective() ? { on: true } : null; } catch (e) { cr = null; }
      res.render("admin/pepeLivecams", { user: req.user.username, title: "Admin · Live cams", section: "pepe", isAdmin: true, v: await adminView(), cr });
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
    const key = String((req.body || {}).key || "");
    // (1.99?? privacy controls S5: a veiled session by "v:<opaque id>"; S4: a reveal by "rv:<sid>" - its "<room>|<login>:rv:" key is
    // never accepted, nor shown)
    const S = key.startsWith("v:") ? [...SESS.values()].find((x) => x.veil && x.veil.id === key.slice(2) && !x.ended) || null
      : key.startsWith("rv:") ? [...SESS.values()].find((x) => x.rv && x.sid === key.slice(3) && !x.ended) || null
      : key.includes(RV_KEY) ? null : SESS.get(key);
    if (!S || S.ended) return res.status(404).json({ ok: false, error: "That live cam already ended." });
    if (!S.rv) COOL.set(S.key, now() + END_COOLDOWN_MS);
    endSession(S, "ended_by_admin");
    console.log(`[livecam] admin end ${S.rv ? "rv:" + S.sid : S.veil ? "v:" + S.veil.id : S.key} by=${req.user.username || req.user.userId}`);
    res.json({ ok: true, view: await adminView() });
  });
}

module.exports = {
  register, init, normalize, save, current, viewerCap, pathFor, vpathFor, sessOf, veilWhy, veilSwitchOff, veilEnded, pubKey, readTicket, checkTicket, camForPath, holdOf, relayHold, start, beat, stop, endBy, mayEnd,
  forBot, noteSync, auth, hint, adminView, stageConsent, stageHold, stageRelease, stageState, stageWatch, setOptout, optoutState, optedOut, sweep, dropViewerOf, watchersOf,
  kickReader, recheck,                // adultgate site: roomrtc ends WebRTC room listeners through kickReader too
  stageRecheck, stageViewerWhy, directorBlocked, directorBlockedSet, blockedWith, blockedSet, stageOffMeOk,   // stagefix site
  stageOkOk, bannedSet, subjectBanned,                                                                       // stagefix site (final round)
  mfState, mfOnlyCount, stageUnwatch, stageYield, stageDrop, cooling, liveCount, fitsBudget, onEnd, onOptout, keyOf, held, botOk, MF_PREFIX,   // micfollow
  dmBlockedSet,                                                                                              // train2 merge (micfollow's eligOf)
  sharedBeyondMf,                                                                                            // mfix
  stageWarm, isMfHolder, MFW_PREFIX,                                                                         // wave2 WP-4 (F.2 warm keep)
  revealStart, revealSess, revealOf, revealOfViewer, revealBeat, revealExtend, revealStop, revealSwitchOff, revealNotices, onRevealNotice,
  REVEAL_MS,                                                                                                 // 1.99?? (privacy controls S4)
  botMf: () => (BOT && BOT.mf) || 0, botPool: () => (BOT && BOT.pool) || null, enabled: () => cfg().enabled === true, cfg,
  PREFIX, PATH_RE, FIELDS, DEFAULTS, BEAT_MS, TICKET_MS,
  END_COOLDOWN_MS, START_MS,
  syncFresh, NOMEDIA_MS, LOST_MS, BOT_GRACE_MS,                                                              // 1.99ahn dead relay
  _sessions: SESS,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _setKick: (fn) => { kickImpl = fn; },
  _reset: () => { SESS.clear(); BY_PATH.clear(); COOL.clear(); RV_STARTING.clear(); BOT = null; OPTOUT = new Set(); CFG = { v: 0, cfg: { ...DEFAULTS }, at: null, by: null }; ready = null; SYNC_AT = 0; },
};
