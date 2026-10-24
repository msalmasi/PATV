// mainstage.js — room stages: user stream slots per room, featuring, scheduling, a queue (1.99al, 1.99bi).
//
// Every Camfrog room on PATV has a STAGE: Pepe's stream (always there) plus N user SLOTS that people
// stream to (the room owner sets N, default 1; rooms.js). Viewers switch freely between a room's live
// slots and Pepe's stream. One slot per room can be FEATURED - it becomes the room's default stream
// (and the homepage's, when that room is the front room): the room owner (or site staff) features any
// open slot, free.
// 1.99ee: featuring can't be BOUGHT (boosts.js: "featuring is earned" - people boost a pad instead, which
// feeds the front-page ranking). 1.99ep: the last of paid featuring is gone - no "feature me" upgrade route,
// no paid-feature billing / refunds, no legacy (Reserve / jackpot) settlement; purgePaidFeaturing() removes
// the old settled paid-feature booking rows (their PAT ledger rows - transactions, reserve_claims - stay).
//
// Slot kinds:
//   slot     an ordinary slot. Price = the room's slot_price (default 0 = FREE; the owner may charge up
//            to price_per_min). Since 1.99ee its fee settles as a ROOM FLOW (revenue_vault 'room_flow',
//            boosts.routeInTx): half to the Federal Reserve (Fort Knox's stand-in until E-1), half held
//            for the pad's room vault (room_flow_ledger escrow, until E-3).
// Sources: an RTMP key (OBS…), the browser (MediaRecorder relay), or an EMBED - a YouTube video/live or
// Twitch channel/VOD (stageembed.js: parsed to {p,t,id}, rendered only with the official players). An
// embed slot is "live" from the moment it opens (we can't see inside YouTube/Twitch).
//
// 1.99zc: 🎬 CAM slots (source 'cam', cam_login): the pad's owner (or staff) puts someone's live Camfrog cam on the stage
// (camOpen). The video is the live-cam relay (livecam.js stageHold: ONE Pepe publish, shared with the strip / popover
// viewers), so the same consent rules apply - on cam, not opted out of live video, not private, not ended by them.
// Free, live-only (never scheduled / queued), inside the pad's slot count and max_concurrent; live while the relay is
// live (tick -> camBeat), ended when the cam goes away (they opt out / leave cam / end it, or Pepe closes it). Stage
// viewers get their own WHEP ticket (POST /api/stage/slots/:id/cam), counted in the live-cam bandwidth budget, never in
// a viewer's personal live-cam slots. The cam's owner is told (inbox + Camfrog PM, or a PM via Pepe when unlinked).
// userId / username = who put it there; displayname = the cam's name (what the stage tab shows).
// stagefix site (V1-2 of the dynamic-stages design - holes that were live on prod):
//   * who: livecam.stageConsent also refuses (neutrally) a person who took themselves off this pad's Stage (stageleave.js,
//     "Take me off this Stage") or who blocked / was blocked by whoever puts them up or the pad's owner - staff included;
//     a pad without the 💎 bridge perk can't put cams up. camBeat re-checks it all every tick, with their opt-out and private
//     activity (livecam.stageRecheck), and ends the slot ("cam_<why>").
//   * who sees it: a cam slot is listed (publicSlots' consumers: the pad page, /api/stage, /api/rooms/:slug/stage, the
//     schedule, the /p guide, the homepage's front stage and Top Pads "now playing") only to a SIGNED-IN viewer who may see
//     the pad's live room (padaccess.camSlotsFor: padaccess.full - Approved pads, the 18+ gate); everyone else gets the list
//     without it. The picture itself is gated per viewer (livecam.stageViewerWhy: the cam's own access mode, blocks both
//     ways, the room's live-cam block). slotsFor() also marks the viewer's OWN cam (mine: true -> "Take me off this Stage").
//   * where it can't go: a cam slot is never public egress - onair.slotWhyNot refuses it ("cam_slot": a cam goes on Pepe's
//     stream only as a cam, with its owner's on-air OK), restream.js never relays it, and it has no HLS / clips / snaps.
//   * stagefix fix (review): a cam slot is never AUTO-featured (autoFeature) and never on the homepage's front stage (a cam on a
//     Stage plays only on its pad page, D-21); a viewer who may not see a cam slot doesn't count it either (roomStage open /
//     free); the slot's end reason for private activity, "Take me off this Stage" and a block is the one neutral
//     "cam_unavailable"; the owner's candidate list marks a followers / request cam `limited` (only some viewers will see it).
//   * stagefix (final round - D-17 (a) / DF-45, accepted 2026-10-19): the person's own say over pins (stagepin.js). camOpen asks
//     pinGate(): "never" -> "unavailable"; level "off" without their yes for this pad -> an ASK instead of a slot ({asked: true};
//     it goes up by itself once they allow it); camBeat asks slotWhy() every tick (the level, and after 10 live minutes without
//     their per-pad yes "Keep going / Take me off" - no answer in 2 minutes ends it, "cam_unavailable"). A stage ban of their
//     linked account (site or this pad) refuses / ends it too (livecam.bannedSet).
//
// Lifecycle (status):
//   requested --owner approves--> scheduled --start_at - lead--> waiting --first publish--> active --> ended
//   (now)  ------------------------------------------------------> waiting | active (embed)
//   queue entry --a slot frees up--> waiting (booked for them; a notice says "you're up")
// Scheduled bookings hold their PAT when booked; denied / never approved / no room at start / cancelled
// = a full refund. A reminder goes out ~15 min before the start (inbox + a Camfrog PM via Pepe).
//
// Money: book = one transaction (debit the whole hold + slot row). Billing ticks only move the slot's
// own bookkeeping (live_ms -> charged, never more than held). Settling = one transaction, guarded by
// `settled = 0`, that refunds held - charged to the user and books the charged part as revenue: a room flow
// (revenue_vault 'room_flow', boosts.routeInTx in the same transaction - every slot since 1.99ee; 1.99ep
// moved the few older unsettled rows onto it too, see purgePaidFeaturing).
// A server restart loses nothing: slots are in the DB, the next tick resumes them.
//
// Streaming: two nginx-rtmp applications, both calling POST /api/stage/rtmp (on_publish /
// on_update / on_publish_done, answered only from loopback):
//   INGEST ("stage"; staging "stage_staging") - no HLS. Users publish here with their slot key
//     (random, shown once, stored only as a SHA-256 hash, cleared when the slot ends; regenerate from
//     the booking page). A valid key is answered with a 3xx to rtmp://127.0.0.1/<OUT>/<slot stream
//     name>, which makes nginx PUSH the stream there - so the key is never an HLS filename.
//   OUT ("live"; staging "live_staging") - the HLS application. Takes Pepe's own key ("broadcast",
//     prod only - Pepe's stream DEPENDS on this answering 200) and the pushes of open slots.
// on_update (every 10 s) is the liveness heartbeat for billing, and answering it with 403 is how a
// cut / ended slot is kicked off the server. The browser mode posts MediaRecorder chunks to
// /api/stage/slots/:id/relay; one ffmpeg per slot turns them into RTMP to the local INGEST app.
"use strict";
const crypto = require("crypto");
const childProcess = require("child_process");
const { v4: uuidv4 } = require("uuid");
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)
const rooms = require("./rooms");
const embeds = require("./stageembed");

const STAGING = !!process.env.STAGING;
const RTMP_APP = process.env.STAGE_RTMP_APP || (STAGING ? "stage_staging" : "stage");   // ingest
const OUT_APP = process.env.STAGE_OUT_APP || (STAGING ? "live_staging" : "live");         // HLS
const RTMP_PUBLIC = process.env.STAGE_RTMP_URL || `rtmp://stream.publicaccess.tv/${RTMP_APP}`;
// 1.99aaz: where a remote player (Pepe's OBS on the homelab VM) pulls a slot as ONE continuous RTMP stream from the HLS app.
// HLS made OBS's media source play in 2 s jumps (one segment, then a freeze until the next - measured 2026-10-15).
const RTMP_PLAY = process.env.STAGE_RTMP_PLAY || RTMP_PUBLIC.replace(/\/[^/]*$/, "/" + OUT_APP);
const RTMP_LOCAL = process.env.STAGE_RTMP_LOCAL || `rtmp://127.0.0.1/${RTMP_APP}`;
const OUT_LOCAL = process.env.STAGE_OUT_LOCAL || `rtmp://127.0.0.1/${OUT_APP}`;
// nginx-rtmp wants a distinct hls_path per application: the staging app writes to /mnt/hls/staging
const HLS_BASE = String(process.env.STAGE_HLS_BASE || ("https://publicaccess.tv/hls" + (STAGING ? "/staging" : ""))).replace(/\/+$/, "");
const STREAM_PREFIX = STAGING ? "stg-" : "stage-";
// Pepe's OBS key(s): let through untouched, only on the prod HLS application.
const PEPE_KEYS = new Set(OUT_APP === "live"
  ? String(process.env.STAGE_PEPE_KEYS || "broadcast").split(",").map((s) => s.trim()).filter(Boolean) : []);
const RELAY_SECRET = process.env.SECRET_KEY || crypto.randomBytes(32).toString("hex");
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

const DEFAULTS = {
  enabled: true,
  price_per_min: 1000,     // the most a pad owner may charge per live minute for a slot (1.99ee: paid featuring is gone)
  min_minutes: 5,
  max_minutes: 60,         // a slot's longest length where the pad's owner hasn't set one (1.99lw: pad settings)
  pad_max_minutes: 360,    // 1.99lw: the most a pad's owner may allow (6 h); also a 📼 Plex slot's limit on a pad without its own
  max_concurrent: 6,       // user streams open at the same time, site-wide (server/bandwidth guard)
  max_slots_per_room: 4,   // the most slots an owner can give a room
  start_window_min: 10,    // must go live within this long of the slot opening, or it's refunded in full
  idle_grace_min: 5,       // after going live, ends if the stream is down this long
  bookings_per_hour: 3,    // per user
  schedule_days: 14,       // how far ahead slots can be booked
  schedule_per_user: 3,    // future bookings one user can hold
  lead_min: 5,             // a scheduled slot opens (key works) this long before its start
  queue_max: 10,           // people waiting per room
  // 1.99cw: the admin kill switch for viewers' stage snaps / clips (stagecap.js) + one per kind
  stagecap_enabled: true,
  stagecap_snaps: true,
  stagecap_clips: true,
  // 1.99et: ultra-low-latency WebRTC (webrtc.js: WHIP ingest, WHEP ⚡ playback, TURN) - OFF until the
  // MediaMTX / coturn install (deploy/webrtc/) is live; off = nothing WebRTC anywhere
  webrtc_enabled: false,
  // 1.99il: the pads' room audio over WebRTC (roomrtc.js; needs webrtc_enabled): "off" | "prime" (Prime Time pads +
  // comped admin pads) | "all". Anything that can't use it plays the MP3 relay, as before. room_rtc_cap = WebRTC room
  // listeners site-wide (TURN relay capacity); over it, new listeners get the MP3 relay.
  room_rtc: "off",
  room_rtc_cap: 25,
  // 1.99fv: what Pepe's main stage plays. null = his own stream (HLS + the ⚡ WHEP toggle) - the default.
  // An admin may put a YouTube / Twitch embed there instead ({p,t,id}, the same parse/clean as a slot's
  // link - stageembed.js). Twitch being live no longer swaps anything by itself (Twitch is a relay of
  // his stream since 1.99fk). Live detection, snaps / clips and the front-pad pick stay on his HLS.
  pepe_embed: null,
  // 1.99lm: AUTO-FEATURE ("take-over"). "when_idle" = a user stream (RTMP / browser / WHIP slot, 📼 library play,
  // embed) that goes live on a pad where nothing is featured becomes that pad's FEATURED stream by itself
  // (feature_by 'auto') until it ends - then the earliest other live one, else nobody (Pepe's stream again). It is
  // the ordinary featuring (the stage's default view, ★, the homepage when it's the front pad, Top Pads' now
  // playing, the guide), just started by the system. Never over a real feature (owner / staff / a booked featured
  // slot) and never while Pepe's stream is featured (pepe_feature). "off" = only people feature. A pad may
  // override it (rooms.takeover: off | when_idle; null = this setting).
  takeover_mode: "when_idle",
  // 1.99lm: FEATURE PEPE'S STREAM (events): null, or {from, until, by, at, note} - active while from <= now (null =
  // already) and now < until (null = until an admin turns it off). While active no user stream is auto-featured
  // anywhere (one that is up is dropped); a pad owner can still feature a slot by hand.
  pepe_feature: null,
};
const TAKEOVER_MODES = ["off", "when_idle"];
const AUTO_HOLD_MS = 60 * 1000;      // an auto-featured stream that drops keeps the feature this long before another live one gets it
// 1.99fv: Pepe's Twitch channel (the "Use Twitch" shortcut on /stage/admin + the viewers' "Watch on Twitch" link)
const TW_LOGIN_RE = /^[A-Za-z0-9_]{3,25}$/;
function pepeTwitchChannel() {
  const c = String(process.env.PEPE_TWITCH_CHANNEL || "publicaccess_ttv").trim();
  return TW_LOGIN_RE.test(c) ? c.toLowerCase() : "publicaccess_ttv";
}
const OPEN = "('waiting','active')";
const FUTURE = "('requested','scheduled')";
const BEAT_STALE_MS = 30 * 1000;     // on_update comes every 10 s; 3 missed = not live
const TICK_MS = 5000;
const MAX_TICK_GAP_MS = 15 * 1000;   // never bill more than this per tick (server paused/restarted)
const REMIND_MS = 15 * 60 * 1000;
const QUEUE_TTL_MS = 2 * 3600 * 1000;
const RELAY_IDLE_MS = 20 * 1000;
const RELAY_MAX_KBPS = 8000;         // average over RELAY_WINDOW_MS; above it the relay is stopped
const RELAY_WINDOW_MS = 10 * 1000;
const RELAY_MAX_CHUNK = 4 * 1024 * 1024;

let clock = () => Date.now();
const now = () => clock();

class Refuse extends Error {
  constructor(status, message) { super(message); this.status = status; this.refuse = true; }
}

// ── storage ──
let ready = null;
async function addColumn(table, col, decl) {
  const cols = await getQuery(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === col)) await runQuery(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS stage_slots (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        username TEXT,
        displayname TEXT,
        status TEXT NOT NULL,            -- requested | scheduled | waiting | active | ended
        created INTEGER NOT NULL,
        max_minutes INTEGER NOT NULL,
        price_per_min INTEGER NOT NULL,
        held INTEGER NOT NULL,
        live_ms INTEGER NOT NULL DEFAULT 0,
        charged INTEGER NOT NULL DEFAULT 0,
        refunded INTEGER,
        key_hash TEXT,
        stream TEXT NOT NULL,
        publishing INTEGER NOT NULL DEFAULT 0,
        beat INTEGER,
        went_live INTEGER,
        last_live INTEGER,
        ended INTEGER,
        end_reason TEXT,
        ended_by TEXT,
        revenue_vault TEXT,
        settled INTEGER NOT NULL DEFAULT 0
      )`);
      // 1.99bi: per-room stages. Added columns; existing rows are kept and moved to the house room.
      await addColumn("stage_slots", "room_id", "TEXT");
      await addColumn("stage_slots", "kind", "TEXT");                 // slot (1.99ep: the legacy 'feature' kind is gone)
      await addColumn("stage_slots", "featured", "INTEGER NOT NULL DEFAULT 0");
      await addColumn("stage_slots", "feature_by", "TEXT");           // owner (1.99ep: 'paid' is gone)
      await addColumn("stage_slots", "mode", "TEXT");                 // stream | embed
      await addColumn("stage_slots", "embed", "TEXT");                // JSON {p,t,id}
      await addColumn("stage_slots", "start_at", "INTEGER");
      await addColumn("stage_slots", "bill_base_ms", "INTEGER NOT NULL DEFAULT 0");
      await addColumn("stage_slots", "title", "TEXT");
      await addColumn("stage_slots", "approved_by", "TEXT");
      await addColumn("stage_slots", "notified", "INTEGER NOT NULL DEFAULT 0");
      await addColumn("stage_slots", "via", "TEXT");                  // 1.99et: how it's live now - rtmp | browser | whip
      await addColumn("stage_slots", "source", "TEXT");               // 1.99ji: 'library' = 📼 played from the Plex library (medialib.js)
      await addColumn("stage_slots", "auto_off", "INTEGER NOT NULL DEFAULT 0");   // 1.99lm: its auto-feature was cancelled by a person
      await addColumn("stage_slots", "cam_login", "TEXT");            // 1.99zc: 🎬 a cam slot's Camfrog login (source 'cam')
      await runQuery(`UPDATE stage_slots SET room_id = ?, kind = COALESCE(kind, 'slot'), mode = COALESCE(mode, 'stream'),
                      start_at = COALESCE(start_at, created) WHERE room_id IS NULL`, [rooms.HOUSE_ROOM]);
      await runQuery("CREATE INDEX IF NOT EXISTS stage_slots_status ON stage_slots (status)");
      await runQuery("CREATE INDEX IF NOT EXISTS stage_slots_user ON stage_slots (userId, created)");
      await runQuery("CREATE INDEX IF NOT EXISTS stage_slots_room ON stage_slots (room_id, status)");
      await runQuery("CREATE TABLE IF NOT EXISTS stage_config (key TEXT PRIMARY KEY, value TEXT)");
      await runQuery(`CREATE TABLE IF NOT EXISTS stage_bans (
        userId TEXT PRIMARY KEY, username TEXT, reason TEXT, by TEXT, at INTEGER)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS stage_room_bans (
        room_id TEXT NOT NULL, userId TEXT NOT NULL, username TEXT, reason TEXT, by TEXT, at INTEGER, PRIMARY KEY (room_id, userId))`);
      await runQuery(`CREATE TABLE IF NOT EXISTS stage_events (
        slot_id TEXT, ts INTEGER, what TEXT, actor TEXT, detail TEXT)`);
      await addColumn("stage_events", "room_id", "TEXT");
      await runQuery(`CREATE TABLE IF NOT EXISTS stage_queue (
        id TEXT PRIMARY KEY, room_id TEXT NOT NULL, userId TEXT NOT NULL, username TEXT, displayname TEXT,
        minutes INTEGER NOT NULL, feature INTEGER NOT NULL DEFAULT 0, mode TEXT, embed TEXT, title TEXT,
        created INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'waiting', slot_id TEXT, note TEXT, done INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS stage_queue_room ON stage_queue (room_id, status, created)");
      await runQuery(`CREATE TABLE IF NOT EXISTS reserve_claims (
        claimId TEXT PRIMARY KEY, flow TEXT NOT NULL, userId TEXT, type TEXT, amount INTEGER NOT NULL,
        created DATETIME DEFAULT CURRENT_TIMESTAMP, settled INTEGER DEFAULT 0)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS jackpot_rakes (
        jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)`).catch(() => {});
      await rooms.init();
      await require("./royalties").init();
      await require("./boosts").init();          // 1.99ee: room_flow_ledger (slot fees settle into it)
      await loadConfig();
      // 1.99ep: never blocks the stage - a failed backup / purge is logged and retried at the next start
      await purgePaidFeaturing().catch((e) => console.error("[stage] paid-featuring purge (retried next start):", e.message));
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

// ── 1.99ep: purge the old paid featuring (replaced by boosts in 1.99ee) ──
// Idempotent, runs at every start (a no-op once done). Before touching anything it writes a full DB backup
// (VACUUM INTO backups/myapp-pre-feature-purge-<time>.db - skipped when there is nothing to do). Then:
//   1. deletes SETTLED paid-feature bookings (kind 'feature' or feature_by 'paid') from stage_slots, and their
//      stage_events rows - metadata only: their money already moved and stays in the ledger (the holds /
//      refunds in `transactions`, the Reserve credit in `reserve_claims`, any royalty_ledger accrual); none of
//      those point at the slot row (reserve_claims.type only names its first 8 characters as text). A row
//      something still needs (a stage_captures save, a royalty_ledger ref) is kept and only relabelled.
//   2. an UNSETTLED paid-feature row (none on prod 2026-10-07) is kept and becomes an owner feature on a room flow:
//      it settles like any slot (its hold is billed per live minute at its own price, the rest refunded).
//   3. unsettled slots on the legacy revenue routes ("reserve" / "jackpot") move to "room_flow" - the only
//      settlement left (prod: one free scheduled slot, nothing held).
//   4. clears the dead stage_config row "revenue_vault" (the legacy-revenue switch).
// The result of the first run that did anything is kept in stage_config "purge_paid_feature_v1".
async function purgePaidFeaturing() {
  const PAID = "(kind = 'feature' OR feature_by = 'paid')";
  const settled = await getQuery(`SELECT id, held, charged, refunded FROM stage_slots WHERE ${PAID} AND settled = 1`);
  const open = await getQuery(`SELECT id FROM stage_slots WHERE ${PAID} AND settled = 0`);
  const legacy = await getQuery("SELECT id FROM stage_slots WHERE settled = 0 AND (revenue_vault IS NULL OR revenue_vault != 'room_flow')");
  const cfg = await getQuery("SELECT 1 FROM stage_config WHERE key = 'revenue_vault'");
  if (!settled.length && !open.length && !legacy.length && !cfg.length) return null;
  const backup = await backupDb("pre-feature-purge");
  const out = { at: now(), backup, deleted: [], kept: [], reopened: open.map((s) => s.id), rerouted: legacy.map((s) => s.id),
                held: 0, charged: 0, refunded: 0 };
  await tx(async () => {
    for (const s of settled) {
      let needed = false;
      try {
        needed = (await getQuery("SELECT 1 FROM stage_captures WHERE slot_id = ? LIMIT 1", [s.id])).length > 0
          || (await getQuery("SELECT 1 FROM royalty_ledger WHERE ref = ? LIMIT 1", ["stage:" + s.id])).length > 0;
      } catch (e) { needed = false; }      // a table that doesn't exist yet references nothing
      if (needed) {
        await runQuery("UPDATE stage_slots SET kind = 'slot', feature_by = NULL, featured = 0 WHERE id = ?", [s.id]);
        out.kept.push(s.id);
        continue;
      }
      await runQuery("DELETE FROM stage_events WHERE slot_id = ?", [s.id]);
      await runQuery("DELETE FROM stage_slots WHERE id = ? AND settled = 1", [s.id]);
      out.deleted.push(s.id);
      out.held += Number(s.held) || 0; out.charged += Number(s.charged) || 0; out.refunded += Number(s.refunded) || 0;
    }
    if (open.length) {
      await runQuery(`UPDATE stage_slots SET kind = 'slot', feature_by = CASE WHEN featured = 1 THEN 'owner' ELSE NULL END,
                      revenue_vault = 'room_flow' WHERE ${PAID} AND settled = 0`);
    }
    await runQuery("UPDATE stage_slots SET revenue_vault = 'room_flow' WHERE settled = 0 AND (revenue_vault IS NULL OR revenue_vault != 'room_flow')");
    await runQuery("DELETE FROM stage_config WHERE key = 'revenue_vault'");
    if (!(await getQuery("SELECT 1 FROM stage_config WHERE key = 'purge_paid_feature_v1'")).length) {
      await runQuery("INSERT INTO stage_config (key, value) VALUES ('purge_paid_feature_v1', ?)", [JSON.stringify(out)]);
    }
  });
  console.log(`[stage] 1.99ep paid-featuring purge: deleted ${out.deleted.length} settled booking(s) (held ${out.held}, charged ${out.charged}, ` +
              `refunded ${out.refunded} - ledger rows kept), kept ${out.kept.length}, reopened ${out.reopened.length}, rerouted ${out.rerouted.length}; backup ${backup || "-"}`);
  return out;
}
/** A full copy of the DB before a data migration (VACUUM INTO, consistent while the app runs). -> path */
async function backupDb(tag) {
  const fs = require("fs"), path = require("path");
  const dir = path.resolve(process.env.DB_BACKUP_DIR || "backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `myapp-${tag}-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  await runQuery(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  if (!fs.existsSync(file) || fs.statSync(file).size < 4096) throw new Error("backup looks empty: " + file);
  return file;
}

let CONFIG = { ...DEFAULTS };
async function loadConfig() {
  const rows = await getQuery("SELECT key, value FROM stage_config");
  const c = { ...DEFAULTS };
  for (const r of rows) { try { if (r.key in DEFAULTS) c[r.key] = JSON.parse(r.value); } catch (e) { /* skip */ } }
  CONFIG = cleanConfig(c);
  return CONFIG;
}
const onOff = (v, d) => (v === undefined || v === null || v === "" ? d
  : v === true || v === "true" || v === 1 || v === "1" || v === "on");
function cleanConfig(c) {
  const int = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const o = {
    enabled: c.enabled === true || c.enabled === "true" || c.enabled === 1 || c.enabled === "1" || c.enabled === "on",
    price_per_min: int(c.price_per_min, 1, 10000000, DEFAULTS.price_per_min),
    min_minutes: int(c.min_minutes, 1, 600, DEFAULTS.min_minutes),
    max_minutes: int(c.max_minutes, 1, 360, DEFAULTS.max_minutes),
    pad_max_minutes: int(c.pad_max_minutes, 5, 360, DEFAULTS.pad_max_minutes),
    max_concurrent: int(c.max_concurrent, 0, 32, DEFAULTS.max_concurrent),
    max_slots_per_room: int(c.max_slots_per_room, 1, 8, DEFAULTS.max_slots_per_room),
    start_window_min: int(c.start_window_min, 1, 120, DEFAULTS.start_window_min),
    idle_grace_min: int(c.idle_grace_min, 1, 60, DEFAULTS.idle_grace_min),
    bookings_per_hour: int(c.bookings_per_hour, 1, 100, DEFAULTS.bookings_per_hour),
    schedule_days: int(c.schedule_days, 0, 60, DEFAULTS.schedule_days),
    schedule_per_user: int(c.schedule_per_user, 0, 20, DEFAULTS.schedule_per_user),
    lead_min: int(c.lead_min, 0, 30, DEFAULTS.lead_min),
    queue_max: int(c.queue_max, 0, 50, DEFAULTS.queue_max),
    stagecap_enabled: onOff(c.stagecap_enabled, DEFAULTS.stagecap_enabled),
    stagecap_snaps: onOff(c.stagecap_snaps, DEFAULTS.stagecap_snaps),
    stagecap_clips: onOff(c.stagecap_clips, DEFAULTS.stagecap_clips),
    webrtc_enabled: onOff(c.webrtc_enabled, DEFAULTS.webrtc_enabled),
    room_rtc: ["off", "prime", "all"].includes(String(c.room_rtc)) ? String(c.room_rtc) : DEFAULTS.room_rtc,
    room_rtc_cap: int(c.room_rtc_cap, 0, 500, DEFAULTS.room_rtc_cap),
    pepe_embed: (() => { try { return pepeEmbedFrom(c.pepe_embed); } catch (e) { return null; } })(),
    takeover_mode: TAKEOVER_MODES.includes(String(c.takeover_mode)) ? String(c.takeover_mode) : DEFAULTS.takeover_mode,
    pepe_feature: cleanPepeFeature(c.pepe_feature),
  };
  if (o.max_minutes < o.min_minutes) o.max_minutes = o.min_minutes;
  if (o.pad_max_minutes < o.max_minutes) o.pad_max_minutes = o.max_minutes;
  return o;
}
/** 1.99fv: Pepe's stage source from an admin's input -> null (his own stream) or a clean {p,t,id}.
 *  Accepts a stored {p,t,id}, "" / "pepe" / "hls" / "stream" (back to his stream), a bare Twitch channel
 *  name, or any YouTube / Twitch link a slot accepts (stageembed.parse). Throws a 400 Refuse otherwise. */
function pepeEmbedFrom(v) {
  if (v === undefined || v === null || v === false) return null;
  if (typeof v === "object") {
    const c = embeds.clean(v);
    if (!c) throw new Refuse(400, "That isn't a YouTube or Twitch embed we can play.");
    return c;
  }
  const s = String(v).trim();
  if (!s || /^(pepe|hls|stream|none|off)$/i.test(s)) return null;
  if (/^twitch$/i.test(s)) return { p: "twitch", t: "channel", id: pepeTwitchChannel() };
  if (TW_LOGIN_RE.test(s)) return { p: "twitch", t: "channel", id: s.toLowerCase() };        // a bare channel name
  try { return embeds.parse(s); } catch (e) { throw new Refuse(400, e.message || "That isn't a YouTube or Twitch link we can play."); }
}
/** 1.99lm: a stored "feature Pepe's stream" window -> {from, until, by, at, note} or null (bad / empty). */
function cleanPepeFeature(v) {
  if (!v || typeof v !== "object") return null;
  const ms = (x) => (x === null || x === undefined || x === "" ? null : (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.floor(Number(x)) : NaN));
  const from = ms(v.from), until = ms(v.until), at = ms(v.at);
  if (Number.isNaN(from) || Number.isNaN(until)) return null;
  if (from != null && until != null && until <= from) return null;
  return { from, until, at: Number.isNaN(at) ? null : at, by: v.by ? String(v.by).slice(0, 40) : null, note: v.note ? cleanTitle(v.note) : null };
}
/** 1.99lm: Pepe's stream is featured right now (an admin's event window) -> that window, or null. */
function pepeFeatured(t = now(), C = CONFIG) {
  const f = C && C.pepe_feature;
  if (!f) return null;
  if (f.from != null && t < f.from) return null;
  if (f.until != null && t >= f.until) return null;
  return f;
}
/** 1.99lm: an admin features Pepe's stream. {on: false} clears it; else {minutes} (from now, or from `from`) or
 *  {from, until} (ms or a date string); no end = until turned off. At most 30 days ahead / long. -> the window */
async function setPepeFeature(b, actor) {
  await init();
  b = b || {};
  let next = null;
  if (!(b.on === false || b.on === "false" || b.on === "0" || b.on === 0 || b.on === "off")) {
    const t = now();
    const when = (x) => {
      if (x === undefined || x === null || x === "") return null;
      const n = typeof x === "number" || /^[0-9]+$/.test(String(x)) ? Number(x) : Date.parse(String(x));
      if (!Number.isFinite(n) || n <= 0) throw new Refuse(400, "That isn't a time we can read.");
      return Math.floor(n);
    };
    let from = when(b.from);
    if (from != null && from <= t) from = null;
    let until = when(b.until);
    const mins = b.minutes === undefined || b.minutes === null || b.minutes === "" ? null : Math.floor(Number(b.minutes));
    if (mins != null) {
      if (!Number.isFinite(mins) || mins < 1 || mins > 30 * 24 * 60) throw new Refuse(400, "Pick 1 minute to 30 days.");
      until = (from || t) + mins * 60000;
    }
    const LIM = 30 * 86400000;
    if (from != null && from > t + LIM) throw new Refuse(400, "That's more than 30 days ahead.");
    if (until != null && until <= (from || t)) throw new Refuse(400, "The end has to be after the start.");
    if (until != null && until - (from || t) > LIM) throw new Refuse(400, "At most 30 days.");
    next = { from, until, at: t, by: actor || null, note: cleanTitle(b.note) };
  }
  const cfg = await setConfig({ pepe_feature: next }, actor);
  await event(null, next ? "pepe_featured" : "pepe_unfeatured", actor,
              next ? `from ${next.from ? new Date(next.from).toISOString() : "now"} until ${next.until ? new Date(next.until).toISOString() : "turned off"}${next.note ? " - " + next.note : ""}` : null);
  await autoFeatureAll().catch((e) => console.error("[stage] auto-feature:", e.message));
  return cfg.pepe_feature;
}
/** 1.99fv: what Pepe's main stage shows - {mode: 'stream'} (HLS + ⚡) or {mode: 'embed', embed, label, url};
 *  plus his Twitch channel for the viewers' "Watch on Twitch" link (twitch_live = our relay to it is running). */
function pepeSource(cfg = CONFIG) {
  const e = embeds.clean(cfg && cfg.pepe_embed);
  let twLive = false;
  try { twLive = require("./restream").mainRelayLive(); } catch (err) { /* the relay is optional */ }
  const twitch = { login: pepeTwitchChannel(), url: "https://www.twitch.tv/" + pepeTwitchChannel(), live: twLive };
  const featured = !!pepeFeatured(now(), cfg);            // 1.99lm: an admin featured his stream (the ★ on his tab)
  return e ? { mode: "embed", embed: e, label: embeds.label(e), url: embedUrl(e), twitch, featured } : { mode: "stream", twitch, featured };
}
/** 1.99fv: the player Pepe's stage uses, from his stream state (bridge.stage()) and the source above. The
 *  page (stage-room.js) does the same. Live = HLS only: Twitch never turns it on or swaps it in by itself. */
function pepePlayer(st, src = pepeSource()) {
  if (!st || !st.active) return { kind: "off" };
  if (src && src.mode === "embed" && embeds.clean(src.embed)) return { kind: "embed", embed: embeds.clean(src.embed) };
  return { kind: "hls", hls: "https://publicaccess.tv/hls/broadcast.m3u8", whep: typeof st.whep === "string" && st.whep ? st.whep : null };
}
async function setConfig(patch, actor) {
  await init();
  patch = { ...(patch || {}) };
  if ("pepe_embed" in patch) patch.pepe_embed = pepeEmbedFrom(patch.pepe_embed);    // a bad link -> 400 (never silently "stream")
  const next = cleanConfig({ ...CONFIG, ...patch });
  for (const k of Object.keys(DEFAULTS)) {
    await runQuery("INSERT INTO stage_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                   [k, JSON.stringify(next[k])]);
  }
  CONFIG = next;
  pubCache.clear();                       // 1.99et: webrtc_enabled changes what the stage lists carry
  await event(null, "config", actor, JSON.stringify(next));
  return CONFIG;
}
const config = () => ({ ...CONFIG });

async function event(slotId, what, actor, detail, roomId) {
  try {
    await runQuery("INSERT INTO stage_events (slot_id, ts, what, actor, detail, room_id) VALUES (?, ?, ?, ?, ?, ?)",
                   [slotId || null, now(), what, actor || null, detail ? String(detail).slice(0, 500) : null, roomId || null]);
  } catch (e) { console.error("[stage] event:", e.message); }
}

// ── transactions: 1.99st - the site's one primitive (dbUtils.tx: one global chain, a savepoint when nested) ──
const tx = (fn) => require("./dbUtils").tx(fn);

// ── keys ──
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
function newKey() { return "ps" + crypto.randomBytes(30).toString("base64url"); }   // 42 chars
// 1.99aay: the key a streamer pastes into OBS is "<the slot's public stream name>?k=<secret>". nginx-rtmp splits the publish
// name at "?": the name (public anyway - it's the HLS file name) is what its "notify: push" error line prints, the args ride
// only in the on_publish POST (field k). The old bare-secret form still works (a key booked before, 📼 mediactl's keys).
const pubKey = (stream, key) => `${stream}?k=${key}`;
// 1.99abc: 📼 Plex (mediactl >= 1.5.0) gets the same form; STAGE_LIBRARY_PUBKEY=off = bare keys again (an older mediactl)
const libKey = (stream, key) => (String(process.env.STAGE_LIBRARY_PUBKEY || "on").toLowerCase() === "off" || !stream ? key : pubKey(stream, key));
function relayKey(slotId) {
  return "r." + slotId + "." + crypto.createHmac("sha256", RELAY_SECRET).update("stage-relay:" + slotId).digest("base64url").slice(0, 32);
}
function parseRelayKey(name) {
  const m = /^r\.([A-Za-z0-9-]{8,64})\.([A-Za-z0-9_-]{32})$/.exec(String(name || ""));
  if (!m) return null;
  const want = relayKey(m[1]);
  const a = Buffer.from(String(name)), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? m[1] : null;
}

// ── billing math (pure) ──
const billedMinutes = (liveMs) => Math.ceil(Math.max(0, Number(liveMs) || 0) / 60000);
function chargeFor(slot, liveMs) {
  if (!slot.price_per_min || !slot.held) return 0;
  return Math.min(slot.held, Math.min(billedMinutes(liveMs), slot.max_minutes) * slot.price_per_min);
}
const startOf = (s) => Number(s.start_at) || Number(s.created);
// the latest moment a slot may still be running, whatever happens
function deadline(slot, C = CONFIG) {
  return startOf(slot) + (C.start_window_min + slot.max_minutes * 2 + C.idle_grace_min) * 60000;
}
// the time a booking is expected to use, for capacity planning
function projEnd(s, C = CONFIG) {
  const base = s.went_live || (startOf(s) + (s.mode === "embed" ? 0 : C.start_window_min * 60000));
  return base + s.max_minutes * 60000;
}
const isEmbed = (s) => !!s && s.mode === "embed";
const isLive = (s, t = now()) => !!s && (s.status === "waiting" || s.status === "active") &&
  (isEmbed(s) ? s.status === "active" : (!!s.publishing && !!s.beat && t - s.beat < BEAT_STALE_MS));
const embedOf = (s) => { try { return embeds.clean(JSON.parse(s.embed || "null")); } catch (e) { return null; } };
const cleanTitle = (v) => String(v || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || null;
const truthy = (v) => v === true || v === "1" || v === 1 || v === "true" || v === "on";

// ── queries ──
async function getSlot(id) {
  await init();
  return (await getQuery("SELECT * FROM stage_slots WHERE id = ?", [String(id || "")]))[0] || null;
}
async function openSlots(roomId) {
  await init();
  if (roomId) return getQuery(`SELECT * FROM stage_slots WHERE status IN ${OPEN} AND room_id = ? ORDER BY created`, [roomId]);
  return getQuery(`SELECT * FROM stage_slots WHERE status IN ${OPEN} ORDER BY created`);
}
async function futureSlots(roomId) {
  await init();
  if (roomId) return getQuery(`SELECT * FROM stage_slots WHERE status IN ${FUTURE} AND room_id = ? ORDER BY start_at`, [roomId]);
  return getQuery(`SELECT * FROM stage_slots WHERE status IN ${FUTURE} ORDER BY start_at`);
}
async function isBanned(userId, roomId) {
  await init();
  if ((await getQuery("SELECT 1 AS b FROM stage_bans WHERE userId = ?", [userId])).length) return true;
  if (roomId && (await getQuery("SELECT 1 AS b FROM stage_room_bans WHERE userId = ? AND room_id = ?", [userId, roomId])).length) return true;
  return false;
}
// the bookings that overlap [a, b) (open ones by their projected end, scheduled ones by theirs)
function overlapping(list, a, b, excludeId) {
  return list.filter((s) => s.id !== excludeId && startOf(s) < b && projEnd(s) > a);
}

// ── 1.99lw: how long a slot may be on a pad ──
// the pad's own limit (owner: pad settings -> Stage, slot_max_min; empty = the site's max_minutes), never above
// pad_max_minutes (6 h). Every kind of slot: OBS / browser / WHIP streams, video links and 📼 Plex.
function maxMinutesFor(RS, C = CONFIG) {
  const own = RS && Number(RS.slot_max_min) > 0 ? Number(RS.slot_max_min) : null;
  return Math.max(C.min_minutes, Math.min(C.pad_max_minutes, own || C.max_minutes));
}
// a 📼 Plex slot is as long as its runtime: the pad's own limit when its owner set one, else pad_max_minutes (so a
// film runs its length on a pad that never touched the setting)
function libraryMaxFor(RS, C = CONFIG) {
  const own = RS && Number(RS.slot_max_min) > 0 ? Number(RS.slot_max_min) : null;
  return Math.min(C.pad_max_minutes, own || C.pad_max_minutes);
}
async function limitsFor(roomId) {
  await init();
  const RS = await rooms.stageSettings(String(roomId || rooms.HOUSE_ROOM));
  return { max: maxMinutesFor(RS), library_max: libraryMaxFor(RS), min: CONFIG.min_minutes };
}

// ── book ──
// opts: {room, minutes, mode: stream|embed, embed: url, title, start_at (ms; omitted / now = right now)}
// (every booking is an ordinary slot; the owner can feature it for free - featuring is never bought)
async function book(user, opts = {}) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in to book the stage.");
  const C = CONFIG;
  if (!C.enabled || C.max_concurrent < 1) throw new Refuse(403, "Stage booking is closed right now.");
  const roomId = String(opts.room || rooms.HOUSE_ROOM);
  const R = await rooms.get(roomId);
  if (!R && roomId !== rooms.HOUSE_ROOM) throw new Refuse(404, "No such pad.");
  const RS = R || (await rooms.stageSettings(roomId));
  const minutes = Math.floor(Number(opts.minutes));
  // 1.99lw: the pad's own longest slot; a 📼 Plex booking is its runtime (the caller sized it) under the Plex limit
  const library = !!opts.library;
  const maxM = library ? libraryMaxFor(RS, C) : maxMinutesFor(RS, C);
  if (!Number.isFinite(minutes) || minutes < (library ? 1 : C.min_minutes) || minutes > maxM) {
    throw new Refuse(400, `Pick between ${C.min_minutes} and ${maxM} minutes.`);
  }
  if (await isBanned(user.userId, roomId)) throw new Refuse(403, "You can't book the stage.");
  const mode = library ? "stream" : opts.mode === "embed" ? "embed" : "stream";
  let embed = null;
  if (mode === "embed") {
    try { embed = embeds.parse(opts.embed); } catch (e) { throw new Refuse(400, e.message); }
  }
  const title = cleanTitle(opts.title);
  const t = now();
  let startAt = Number(opts.start_at) || 0;
  const scheduled = startAt > t + 60 * 1000;
  if (library && !scheduled) throw new Refuse(400, "Pick a start time (to play it now, use ▶ Play).");
  if (scheduled) {
    startAt = Math.floor(startAt / 60000) * 60000;
    if (C.schedule_days < 1 || startAt > t + C.schedule_days * 86400000) throw new Refuse(400, `Book up to ${C.schedule_days} days ahead.`);
  } else startAt = t;
  // the owner's slot price; 0 = free (the default). 1.99lw: a 📼 Plex slot has no slot fee (the title is paid as it plays)
  const price = library ? 0 : Math.min(C.price_per_min, RS.slot_price || 0);
  const hold = minutes * price;
  const staffOrOwner = SP.can(user, "stage.approval_bypass") || !!(RS.owner && RS.owner.userId === user.userId);
  const needsApproval = scheduled && !!RS.approval && !staffOrOwner;
  const key = mode === "stream" && !library ? newKey() : null;      // a 📼 slot gets its key when it starts (mediaqueue.js)
  const id = uuidv4();
  const out = await tx(async () => {
    const mineOpen = await getQuery(`SELECT id FROM stage_slots WHERE userId = ? AND status IN ${OPEN}`, [user.userId]);
    const open = await getQuery(`SELECT * FROM stage_slots WHERE room_id = ? AND status IN ${OPEN}`, [roomId]);
    const fut = await getQuery(`SELECT * FROM stage_slots WHERE room_id = ? AND status = 'scheduled'`, [roomId]);
    const until = startAt + minutes * 60000 + (mode === "embed" ? 0 : C.start_window_min * 60000);
    if (!scheduled) {
      if (mineOpen.length) throw new Refuse(409, "You already have a stage slot.");
      const all = await getQuery(`SELECT COUNT(*) AS n FROM stage_slots WHERE status IN ${OPEN}`);
      if (all[0].n >= C.max_concurrent) throw new Refuse(409, "The stage is taken right now - try again when the current slot ends.");
      if (open.length + overlapping(fut, startAt, until).length >= RS.slot_count) {
        throw new Refuse(409, RS.slot_count > 1 ? `All ${RS.slot_count} slots in this pad are taken right now - join the queue.`
                                                : "The stage is taken right now - try again when the current slot ends.");
      }
    } else {
      const mine = await getQuery(`SELECT COUNT(*) AS n FROM stage_slots WHERE userId = ? AND status IN ${FUTURE}`, [user.userId]);
      if (mine[0].n >= C.schedule_per_user) throw new Refuse(429, `You can hold ${C.schedule_per_user} upcoming bookings at once.`);
      const clash = overlapping(open.concat(fut), startAt, until);
      if (clash.some((s) => s.userId === user.userId)) throw new Refuse(409, "You already have a booking then.");
      if (clash.length >= RS.slot_count) throw new Refuse(409, "Every slot in this pad is booked then - pick another time.");
    }
    const recent = await getQuery("SELECT COUNT(*) AS n FROM stage_slots WHERE userId = ? AND created > ?", [user.userId, t - 3600 * 1000]);
    if (recent[0].n >= C.bookings_per_hour) throw new Refuse(429, "You've booked the stage a lot this hour - try again later.");
    const u = (await getQuery("SELECT username, displayname FROM users WHERE userId = ?", [user.userId]))[0];
    if (!u) throw new Refuse(404, "Couldn't find your account.");
    if (hold > 0) {
      const paid = await runQuery("UPDATE users SET points_balance = points_balance - ? WHERE userId = ? AND points_balance >= ?",
                                  [hold, user.userId, hold]);
      if (!paid.changes) throw new Refuse(402, `A ${minutes}-minute slot holds ${hold.toLocaleString("en-US")} PAT - you don't have enough.`);
      await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
                     [uuidv4(), user.userId, `stage slot hold (${minutes} min max)`, -hold]);
    }
    const stream = STREAM_PREFIX + crypto.randomBytes(8).toString("hex");
    const status = needsApproval ? "requested" : scheduled ? "scheduled" : (mode === "embed" ? "active" : "waiting");
    await runQuery(`INSERT INTO stage_slots (id, userId, username, displayname, status, created, max_minutes, price_per_min, held,
                    key_hash, stream, revenue_vault, room_id, kind, featured, feature_by, mode, embed, start_at, title, went_live, last_live, source)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                   [id, user.userId, u.username, u.displayname || u.username, status, t, minutes, price, hold, key ? sha(key) : null, stream,
                    "room_flow", roomId, "slot", 0, null, mode,
                    embed ? JSON.stringify(embed) : null, startAt, title,
                    status === "active" ? t : null, status === "active" ? t : null, library ? "library" : null]);
    return { id, status };
  });
  pubCache.clear();
  await event(out.id, scheduled ? (needsApproval ? "requested" : "scheduled") : "booked", user.username,
              `${minutes} min, held ${hold}${mode === "embed" ? ", " + embeds.label(embed) : ""}${scheduled ? ", starts " + new Date(startAt).toISOString() : ""}`, roomId);
  if (needsApproval && RS.owner) {
    rooms.notify(RS.owner.userId, { kind: "stage", title: `${user.username || "Someone"} asked for a stage slot in ${RS.title}`,
      body: `${minutes} min on ${new Date(startAt).toUTCString()}. Approve or deny it on your pad page.`,
      link: `/p/${encodeURIComponent(RS.slug)}/settings#stage`, ref: "stage-req:" + out.id }).catch(() => {});
  }
  let slot = await getSlot(out.id);
  if (slot && slot.status === "active" && slot.went_live) {
    require("./golive").slotLive(slot);   // 1.99kp: an embed on now
    // 1.99lm: ...and maybe the pad's featured stream from now
    if (await autoFeature(roomId).catch((e) => { console.error("[stage] auto-feature:", e.message); return null; })) slot = await getSlot(out.id);
  }
  const pk = key && slot ? pubKey(slot.stream, key) : key;            // 1.99aay: "<stream>?k=<secret>" (the secret never reaches a log)
  return { slot: view(slot), key: pk, rtmp: pk ? { server: RTMP_PUBLIC, key: pk } : null };
}

// ── 1.99ji: 📼 library slots (medialib.js) ──
// An admin plays a movie / episode from the Plex library on a pad's stage: the homelab media-control service
// pushes it with this slot's one-time key to the ordinary RTMP ingest, so HLS, WHEP, snaps and the Twitch relay
// see a normal slot. Free (nothing held), as long as the title (+ slack), outside the per-user booking limits;
// still one per pad at a time and inside the pad's slot count and the site-wide max_concurrent.
let libraryIdleMin = 30;
const idleMinFor = (s, C = CONFIG) => (s && s.source === "library" ? Math.max(C.idle_grace_min, libraryIdleMin) : C.idle_grace_min);
function setLibraryIdle(min) { const n = Math.floor(Number(min)); if (Number.isFinite(n) && n >= 1 && n <= 24 * 60) libraryIdleMin = n; return libraryIdleMin; }
async function libraryOpen(user, opts = {}) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const C = CONFIG;
  const roomId = String(opts.room || rooms.HOUSE_ROOM);
  const R = await rooms.get(roomId);
  if (!R && roomId !== rooms.HOUSE_ROOM) throw new Refuse(404, "No such pad.");
  const RS = R || (await rooms.stageSettings(roomId));
  const minutes = Math.floor(Number(opts.minutes));
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 24 * 60) throw new Refuse(400, "Bad length.");
  const title = cleanTitle(opts.title);
  const key = newKey();
  const id = uuidv4();
  const t = now();
  await tx(async () => {
    const open = await getQuery(`SELECT * FROM stage_slots WHERE room_id = ? AND status IN ${OPEN}`, [roomId]);
    if (open.some((s) => s.source === "library")) throw new Refuse(409, "This pad's stage is already playing something from the library - stop it first.");
    const all = await getQuery(`SELECT COUNT(*) AS n FROM stage_slots WHERE status IN ${OPEN}`);
    if (all[0].n >= C.max_concurrent) throw new Refuse(409, `The site already has ${all[0].n} streams open (the most at once) - end one first.`);
    if (open.length >= RS.slot_count) throw new Refuse(409, RS.slot_count > 1 ? `All ${RS.slot_count} slots in this pad are taken.` : "This pad's stage slot is taken - end it first.");
    const u = (await getQuery("SELECT username, displayname FROM users WHERE userId = ?", [user.userId]))[0];
    if (!u) throw new Refuse(404, "Couldn't find your account.");
    const stream = STREAM_PREFIX + crypto.randomBytes(8).toString("hex");
    await runQuery(`INSERT INTO stage_slots (id, userId, username, displayname, status, created, max_minutes, price_per_min, held,
                    key_hash, stream, revenue_vault, room_id, kind, featured, feature_by, mode, embed, start_at, title, source)
                    VALUES (?, ?, ?, ?, 'waiting', ?, ?, 0, 0, ?, ?, 'room_flow', ?, 'slot', 0, NULL, 'stream', NULL, ?, ?, 'library')`,
                   [id, user.userId, u.username, u.displayname || u.username, t, minutes, sha(key), stream, roomId, t, title]);
  });
  pubCache.clear();
  await event(id, "library", user.username, `📼 ${title || "library"} (${minutes} min max)`, roomId);
  const sl = await getSlot(id);
  const lk = libKey(sl && sl.stream, key);                              // 1.99abc
  return { slot: view(sl), key: lk, rtmp: { server: RTMP_PUBLIC, key: lk } };
}
/** A library slot needs more time (seeking back, a long pause): raise its max_minutes. */
async function libraryExtend(slotId, minutes) {
  await init();
  const m = Math.min(24 * 60, Math.floor(Number(minutes)) || 0);
  const r = await runQuery("UPDATE stage_slots SET max_minutes = MAX(max_minutes, ?) WHERE id = ? AND source = 'library' AND settled = 0", [m, String(slotId || "")]);
  return !!(r && r.changes);
}
/** 1.99lr: 📼 a queue moved on to its next title - the slot's title (the stage, "now playing", the pad's live info). */
async function libraryRetitle(slotId, title) {
  await init();
  const r = await runQuery("UPDATE stage_slots SET title = ? WHERE id = ? AND source = 'library' AND settled = 0", [cleanTitle(title), String(slotId || "")]);
  if (r && r.changes) pubCache.clear();
  return !!(r && r.changes);
}
/**
 * 1.99lw: a BOOKED 📼 Plex slot's start time came (mediaqueue.startScheduled): it opens like libraryOpen does - a key,
 * 'waiting' until the encoder publishes - inside the same limits (one library stream per pad, the site's max_concurrent).
 * -> the raw key, or throws Refuse.
 */
async function libraryActivate(slotId, { title, minutes } = {}) {
  await init();
  const s = await getSlot(slotId);
  if (!s || s.source !== "library" || s.status !== "scheduled" || s.settled) throw new Refuse(409, "That booking isn't waiting to start.");
  const key = newKey();
  const m = Math.max(1, Math.min(24 * 60, Math.floor(Number(minutes)) || s.max_minutes));
  await tx(async () => {
    const open = await getQuery(`SELECT * FROM stage_slots WHERE room_id = ? AND status IN ${OPEN}`, [s.room_id]);
    if (open.some((x) => x.source === "library")) throw new Refuse(409, "This pad's stage is already playing something from the library.");
    const all = await getQuery(`SELECT COUNT(*) AS n FROM stage_slots WHERE status IN ${OPEN}`);
    if (all[0].n >= CONFIG.max_concurrent) throw new Refuse(409, "The site has the most streams open it allows right now.");
    const r = await runQuery("UPDATE stage_slots SET status = 'waiting', key_hash = ?, max_minutes = ?, title = COALESCE(?, title), start_at = ? WHERE id = ? AND status = 'scheduled'",
                             [sha(key), m, cleanTitle(title), now(), s.id]);
    if (!r.changes) throw new Refuse(409, "That booking isn't waiting to start.");
  });
  pubCache.clear();
  await event(s.id, "library", s.username, `📼 booked slot started (${m} min max)`, s.room_id);
  return libKey(s.stream, key);                                         // 1.99abc
}
/** 1.99lr: a fresh one-time key for an open library slot (the site restarted and forgot the raw key; the next title of a
 *  📼 queue publishes with it). The old key stops working for NEW publishes; one already on keeps its connection. */
async function libraryRekey(slotId) {
  await init();
  const key = newKey();
  const r = await runQuery("UPDATE stage_slots SET key_hash = ? WHERE id = ? AND source = 'library' AND settled = 0 AND status IN ('waiting','active')",
                           [sha(key), String(slotId || "")]);
  if (!(r && r.changes)) return null;
  const sl = await getSlot(slotId);                                     // 1.99abc
  return libKey(sl && sl.stream, key);
}

// ── settle: the ONLY place money comes back out of a slot ──
async function end(slotId, reason, actor) {
  await init();
  let fee = null;
  const res = await tx(async () => {
    const s = (await getQuery("SELECT * FROM stage_slots WHERE id = ?", [String(slotId || "")]))[0];
    if (!s || s.settled) return null;
    const charged = chargeFor(s, s.live_ms);
    const refund = s.held - charged;
    const r = await runQuery(`UPDATE stage_slots SET status = 'ended', settled = 1, charged = ?, refunded = ?, ended = ?,
                              end_reason = ?, ended_by = ?, key_hash = NULL, publishing = 0, featured = 0 WHERE id = ? AND settled = 0`,
                             [charged, refund, now(), String(reason || "ended"), actor || null, s.id]);
    if (!r.changes) return null;
    if (refund > 0) {   // 1.99ga: logged only when it really moved (a merged-away booker's refund follows the merge)
      const r2 = await require("./ledger").post(s.userId, refund, `stage slot refund (${billedMinutes(s.live_ms)} of ${s.max_minutes} min used)`,
                                                { resolveMerged: true, source: "stage refund" });
      if (!r2.ok) console.error(`[stage] slot ${s.id}: refund ${refund} not credited (${r2.code})`);
    }
    if (charged > 0) {
      // 1.99ee: a slot fee is a room flow - half to the Reserve (the Fort Knox half), half held for the pad's room vault
      // (1.99ep: the only settlement - the legacy Reserve / jackpot routes are gone, purgePaidFeaturing moved old rows)
      const roomId = s.room_id || rooms.HOUSE_ROOM;
      const RS = await rooms.stageSettings(roomId);
      fee = await require("./boosts").routeInTx({ ref: "slot:" + s.id, kind: "slot_fee", room_id: roomId, payer_id: s.userId, payer_name: s.username,
        amount: charged, owner_self: !!(RS.owner && RS.owner.userId === s.userId), via: "web", flow: "stage_slot",
        detail: `${s.displayname || s.username}: ${billedMinutes(s.live_ms)} min` });
    }
    return { id: s.id, charged, refund, userId: s.userId, room_id: s.room_id, status: s.status, source: s.source || null, cam_login: s.cam_login || null };
  });
  if (res && fee) { try { require("./boosts").telemetry(fee, fee.payer_name, "web"); } catch (e) { /* telemetry only */ } }
  if (res) {
    if (res.source === "cam") { try { require("./livecam").stageRelease(res.id); } catch (e) { /* 1.99zc: no live cams */ } }
    // micfollow: an owner / staff ✂ Cut of a cam slot = "this cam off my stage" - not straight back on the 🎙 mic stage either
    if (res.source === "cam" && res.cam_login && (reason === "cut" || reason === "owner_ended") && actor && actor !== "system") {
      try {
        const MF = require("./micfollow"), mins = MF.cfg().exclude_on_cut_min;
        if (mins > 0) MF.excludeFor(res.room_id || rooms.HOUSE_ROOM, res.cam_login, mins, "cut", String(actor)).catch((e) => console.error("[stage] micfollow:", e.message));
      } catch (e) { /* no mic follows */ }
    }
    stopRelay(res.id);
    try { require("./stageaudio").stop(res.id); } catch (e) { /* none */ }   // 1.99aay
    for (const [cid, sid] of clients) if (sid === res.id) clients.delete(cid);
    lastTick.delete(res.id);
    pubCache.clear();
    try { require("./webrtc").soon(); } catch (e) { /* 1.99et: kicks an ended slot's WHIP publisher */ }
    await event(res.id, "ended", actor, `${reason}: charged ${res.charged}, refunded ${res.refund}`, res.room_id);
    // 1.99lm: its feature (auto or not) is gone - hand the pad to the next live stream, or back to Pepe
    await autoFeature(res.room_id || rooms.HOUSE_ROOM).catch((e) => console.error("[stage] auto-feature:", e.message));
  }
  return res;
}

// ── featuring (free: the pad owner / staff pick the pad's main stream; 1.99ep: never paid) ──
async function unfeature(slotId, actor, why = "unfeatured") {
  await init();
  const s = (await getQuery(`SELECT * FROM stage_slots WHERE id = ? AND settled = 0`, [String(slotId || "")]))[0];
  if (!s || !s.featured) return null;
  // 1.99lm: a PERSON taking an auto-feature away cancels it for good on that slot (the system never re-features it)
  const cancel = s.feature_by === "auto" && actor !== "system";
  const r = await runQuery(`UPDATE stage_slots SET featured = 0, feature_by = NULL${cancel ? ", auto_off = 1" : ""} WHERE id = ? AND featured = 1`, [s.id]);
  if (!r.changes) return null;
  pubCache.clear();
  await event(s.id, "unfeatured", actor, s.feature_by === "auto" ? "auto-feature: " + why : why, s.room_id);
  return { id: s.id, room_id: s.room_id, userId: s.userId, auto: s.feature_by === "auto" };
}

// ── 1.99lm: AUTO-FEATURE - a live user stream on a pad with nothing featured is featured by the system ──
// The rule, per pad (re-checked when a stream goes live / ends, and every tick):
//   * off (the pad's takeover, else the site's takeover_mode), Pepe's stream featured (pepe_feature), or a REAL
//     feature on an open slot (owner / staff / a booked featured slot)  -> no auto-feature; one that is up is dropped
//   * an auto-featured slot keeps it while it's live, and through a drop of up to AUTO_HOLD_MS (or longer while
//     no other stream is live); then it's handed over
//   * else the live slot that went live FIRST (not one whose auto-feature a person cancelled) is featured
//   * no live user stream -> nothing is featured: the stage is Pepe's stream again
// It is the ordinary `featured` flag (feature_by 'auto'): everything that follows a featured slot follows it.
async function takeoverModeFor(roomId) {
  let pad = null;
  try { pad = (await rooms.stageSettings(roomId)).takeover || null; } catch (e) { pad = null; }
  return TAKEOVER_MODES.includes(pad) ? pad : CONFIG.takeover_mode;
}
async function autoFeature(roomId, t = now()) {
  await init();
  roomId = roomId || rooms.HOUSE_ROOM;
  const open = await openSlots(roomId);
  // stagefix fix: a 🎬 cam slot (someone's Camfrog cam a pad's owner put up) is never featured by the system - featured means the
  // pad's default view (and the homepage's, on the front pad), and a cam on a Stage shows only on its pad page to the viewers
  // its owner's settings allow. One featured before this rule (or by a race) is dropped here; an owner may still feature it.
  for (const c of open.filter((s) => s.source === "cam" && s.featured && s.feature_by === "auto")) await unfeature(c.id, "system", "a cam on the stage is never auto-featured");
  const autos = open.filter((s) => s.featured && s.feature_by === "auto" && s.source !== "cam");
  const real = open.some((s) => s.featured && s.feature_by !== "auto");
  const mode = await takeoverModeFor(roomId);
  const why = mode === "off" ? "auto-featuring is off" : pepeFeatured(t) ? "Pepe's stream is featured" : real ? "a slot was featured by hand" : null;
  if (why) {
    for (const a of autos) await unfeature(a.id, "system", why);
    return null;
  }
  const live = open.filter((s) => isLive(s, t) && !s.auto_off && !s.featured && s.source !== "cam")
    .sort((a, b) => (a.went_live || startOf(a)) - (b.went_live || startOf(b)) || (a.created || 0) - (b.created || 0) || String(a.id).localeCompare(String(b.id)));
  const cur = autos[0] || null;
  for (const extra of autos.slice(1)) await unfeature(extra.id, "system", "one featured stream per pad");
  if (cur) {
    if (isLive(cur, t) || !live.length || t - (cur.last_live || cur.went_live || startOf(cur)) < AUTO_HOLD_MS) return cur.id;
    await unfeature(cur.id, "system", "its stream dropped - handed over");
  }
  const next = live[0];
  if (!next) return null;
  // guarded: never a second featured slot in the pad (an owner may have featured one a moment ago)
  const r = await runQuery(`UPDATE stage_slots SET featured = 1, feature_by = 'auto' WHERE id = ? AND settled = 0 AND featured = 0 AND auto_off = 0
                            AND status IN ${OPEN} AND NOT EXISTS (SELECT 1 FROM stage_slots o WHERE o.room_id = ? AND o.featured = 1 AND o.settled = 0
                            AND o.status IN ${OPEN})`, [next.id, roomId]);
  if (!r.changes) return null;
  pubCache.clear();
  await event(next.id, "featured", "system", cur ? "auto: took over from the stream before it" : "auto: live while nothing else was featured", roomId);
  await featuredMark(next);                                        // 1.99mt: ⭐ Headliner
  return next.id;
}
/** 1.99mt: ⭐ Headliner - a durable mark (the featured flag itself goes away later) + the achievement check. */
async function featuredMark(slot) {
  if (!slot || !slot.userId || (slot.mode || "stream") !== "stream" || slot.source === "library" || slot.source === "cam") return;   // your own stream only
  try {
    const A = require("./achievements");
    if (await A.mark(slot.userId, "stream_featured")) A.poke(slot.userId);
  } catch (e) { /* achievements never block */ }
}
/** Every pad with an open slot (or an auto-feature to drop). */
async function autoFeatureAll(t = now()) {
  await init();
  const ids = new Set((await getQuery(`SELECT DISTINCT room_id FROM stage_slots WHERE status IN ${OPEN}`)).map((r) => r.room_id || rooms.HOUSE_ROOM));
  for (const id of ids) {
    try { await autoFeature(id, t); } catch (e) { console.error("[stage] auto-feature", id + ":", e.message); }
  }
}
/** Admin / owner: cancel an auto-feature. The slot stays on as an ordinary one and is never auto-featured again. */
async function cancelAutoFeature(slotId, actor) {
  await init();
  const s = await getSlot(slotId);
  if (!s || s.settled) throw new Refuse(404, "That slot isn't open.");
  if (!s.featured || s.feature_by !== "auto") {
    await runQuery("UPDATE stage_slots SET auto_off = 1 WHERE id = ? AND settled = 0", [s.id]);
    return { done: false };
  }
  return { done: !!(await unfeature(s.id, actor || "admin", "cancelled")) };
}
// The owner / staff feature an open slot (free). Whatever was featured in that room stops being so.
async function featureByOwner(slotId, actor) {
  await init();
  const s = await getSlot(slotId);
  if (!s || s.settled || !["waiting", "active", "scheduled"].includes(s.status)) throw new Refuse(404, "That slot isn't open.");
  if (s.featured) return { already: true };
  const others = await getQuery(`SELECT id, feature_by FROM stage_slots WHERE room_id = ? AND featured = 1 AND settled = 0 AND id != ? AND status IN ${OPEN}`, [s.room_id, s.id]);
  // 1.99lm: an auto-feature just yields (not cancelled - it may come back when this one ends)
  for (const o of others) await unfeature(o.id, o.feature_by === "auto" ? "system" : actor, "the owner featured another slot");
  await runQuery("UPDATE stage_slots SET featured = 1, feature_by = 'owner' WHERE id = ? AND settled = 0", [s.id]);
  pubCache.clear();
  await event(s.id, "featured", actor, "by the pad owner", s.room_id);
  // 1.99mt: ⭐ Headliner - featured by someone else (an owner featuring their own slot doesn't count)
  if (s.went_live) {
    const R = await rooms.get(s.room_id).catch(() => null);
    if (!(R && R.owner && R.owner.userId === s.userId)) await featuredMark(s);
  }
  rooms.notify(s.userId, { kind: "stage", title: "You're featured on the stage", body: "The pad owner featured your slot - it's the pad's main stream now.",
    link: "/stage", ref: "featured:" + s.id + ":" + now(), pm: false }).catch(() => {});
  return { ok: true };
}
// ── owner approval for scheduled requests ──
async function approve(slotId, actor) {
  await init();
  const s = await getSlot(slotId);
  if (!s || s.status !== "requested") throw new Refuse(404, "That request isn't waiting.");
  const RS = await rooms.stageSettings(s.room_id);
  const fut = await getQuery(`SELECT * FROM stage_slots WHERE room_id = ? AND (status = 'scheduled' OR status IN ${OPEN})`, [s.room_id]);
  const clash = overlapping(fut, startOf(s), projEnd(s));
  if (clash.length >= RS.slot_count) throw new Refuse(409, "Every slot is booked then - deny it, or raise the slot count.");
  if (s.featured && clash.some((x) => x.featured)) throw new Refuse(409, "Someone else is featured then.");
  await runQuery("UPDATE stage_slots SET status = 'scheduled', approved_by = ? WHERE id = ? AND status = 'requested'", [actor || null, s.id]);
  await event(s.id, "approved", actor, null, s.room_id);
  rooms.notify(s.userId, { kind: "stage", title: `Your stage slot in ${RS.title} was approved`,
    body: `It opens ${new Date(startOf(s)).toUTCString()}.`, link: "/stage", ref: "stage-ok:" + s.id }).catch(() => {});
  return true;
}
async function deny(slotId, actor, reason) {
  const s = await getSlot(slotId);
  if (!s || s.status !== "requested") throw new Refuse(404, "That request isn't waiting.");
  const r = await end(s.id, "denied", actor);
  const RS = await rooms.stageSettings(s.room_id);
  rooms.notify(s.userId, { kind: "stage", title: `Your stage request in ${RS.title} was declined`,
    body: (reason ? String(reason).slice(0, 200) + " " : "") + (s.held ? "Your hold was refunded in full." : ""), link: "/stage", ref: "stage-no:" + s.id }).catch(() => {});
  return r;
}

// ── queue: next up when every slot is busy ──
async function joinQueue(user, opts = {}) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const C = CONFIG;
  const roomId = String(opts.room || rooms.HOUSE_ROOM);
  const R = await rooms.get(roomId);
  if (!R && roomId !== rooms.HOUSE_ROOM) throw new Refuse(404, "No such pad.");
  const minutes = Math.floor(Number(opts.minutes));
  const maxM = maxMinutesFor(R || (await rooms.stageSettings(roomId)), C);           // 1.99lw: the pad's own limit
  if (!Number.isFinite(minutes) || minutes < C.min_minutes || minutes > maxM) throw new Refuse(400, `Pick between ${C.min_minutes} and ${maxM} minutes.`);
  if (await isBanned(user.userId, roomId)) throw new Refuse(403, "You can't book the stage.");
  const mode = opts.mode === "embed" ? "embed" : "stream";
  let embed = null;
  if (mode === "embed") { try { embed = embeds.parse(opts.embed); } catch (e) { throw new Refuse(400, e.message); } }
  if ((await getQuery("SELECT 1 FROM stage_queue WHERE userId = ? AND status = 'waiting'", [user.userId])).length) throw new Refuse(409, "You're already in a queue.");
  if ((await getQuery(`SELECT 1 FROM stage_slots WHERE userId = ? AND status IN ${OPEN}`, [user.userId])).length) throw new Refuse(409, "You already have a stage slot.");
  const n = await getQuery("SELECT COUNT(*) AS n FROM stage_queue WHERE room_id = ? AND status = 'waiting'", [roomId]);
  if (n[0].n >= C.queue_max) throw new Refuse(409, "The queue is full - try again later.");
  const u = (await getQuery("SELECT username, displayname FROM users WHERE userId = ?", [user.userId]))[0];
  if (!u) throw new Refuse(404, "Couldn't find your account.");
  const id = uuidv4();
  await runQuery(`INSERT INTO stage_queue (id, room_id, userId, username, displayname, minutes, feature, mode, embed, title, created)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                 [id, roomId, user.userId, u.username, u.displayname || u.username, minutes, 0, mode,
                  embed ? JSON.stringify(embed) : null, cleanTitle(opts.title), now()]);
  await event(null, "queued", u.username, `${minutes} min`, roomId);
  return { id, position: n[0].n + 1 };
}
async function leaveQueue(user, entryId) {
  const r = await runQuery("UPDATE stage_queue SET status = 'left', done = ? WHERE id = ? AND userId = ? AND status = 'waiting'",
                           [now(), String(entryId || ""), user && user.userId]);
  return r.changes > 0;
}
async function queueFor(roomId) {
  await init();
  return getQuery("SELECT * FROM stage_queue WHERE room_id = ? AND status = 'waiting' ORDER BY created", [roomId]);
}

// ── the tick: billing, ending, opening scheduled slots, reminders, the queue ──
const lastTick = new Map();   // slotId -> ms of the last accrual (memory only: a restart never bills downtime)
async function tick() {
  await init();
  const t = now();
  const C = CONFIG;
  for (const s of await openSlots()) {
    try {
      if (s.source === "cam" && (await camBeat(s, t)) === "ended") continue;   // 1.99zc
      const live = isLive(s, t);
      const prev = lastTick.get(s.id);
      lastTick.set(s.id, t);
      let liveMs = s.live_ms;
      if (live && prev != null) liveMs += Math.min(MAX_TICK_GAP_MS, Math.max(0, t - prev));
      if (liveMs !== s.live_ms || live) {
        await runQuery("UPDATE stage_slots SET live_ms = ?, charged = ?, last_live = CASE WHEN ? THEN ? ELSE last_live END WHERE id = ? AND settled = 0",
                       [liveMs, chargeFor(s, liveMs), live ? 1 : 0, t, s.id]);
      }
      if (s.publishing && !live && !isEmbed(s)) {
        await runQuery("UPDATE stage_slots SET publishing = 0 WHERE id = ? AND settled = 0", [s.id]);   // heartbeat lost
      }
      let why = null;
      if (liveMs >= s.max_minutes * 60000) why = "time_up";
      else if (s.status === "waiting" && t - startOf(s) > C.start_window_min * 60000) why = "never_live";
      // 1.99ji: a 📼 library slot may sit paused (pause = its ffmpeg stopped) for longer than a streamer may drop out
      else if (s.status === "active" && !isEmbed(s) && !live && t - (s.last_live || s.went_live || startOf(s)) > idleMinFor(s, C) * 60000) why = "idle";
      else if (t > deadline(s, C)) why = "deadline";
      if (why) await end(s.id, why, "system");
    } catch (e) {
      console.error("[stage] tick:", e.message);
    }
  }
  try { await tickFuture(t); } catch (e) { console.error("[stage] schedule:", e.message); }
  try { await tickQueue(t); } catch (e) { console.error("[stage] queue:", e.message); }
  try { await autoFeatureAll(t); } catch (e) { console.error("[stage] auto-feature:", e.message); }   // 1.99lm
}

async function tickFuture(t) {
  const C = CONFIG;
  for (const s of await futureSlots()) {
    const start = startOf(s);
    const RS = await rooms.stageSettings(s.room_id);
    if (s.status === "requested") {
      if (t > start + C.start_window_min * 60000) {
        await end(s.id, "not_approved", "system");
        rooms.notify(s.userId, { kind: "stage", title: `Your stage request in ${RS.title} wasn't approved in time`,
          body: s.held ? "Your hold was refunded in full." : "", link: "/stage", ref: "stage-na:" + s.id }).catch(() => {});
      }
      continue;
    }
    // 1.99lw: a booked 📼 Plex slot is started by mediaqueue.watchBookings (it gets its key then); one that nobody
    // started (the media watcher down) ends after the start window like any slot that never went live
    if (s.source === "library") {
      if (t > start + (C.start_window_min + 5) * 60000) await end(s.id, "no_room", "system");
      continue;
    }
    // reminder ~15 min before
    if (!s.notified && t >= start - REMIND_MS && t < start) {
      await runQuery("UPDATE stage_slots SET notified = 1 WHERE id = ?", [s.id]);
      rooms.notify(s.userId, { kind: "stage", title: `Your stage slot in ${RS.title} starts in ${Math.max(1, Math.round((start - t) / 60000))} min`,
        body: isEmbed(s) ? "Your video goes on at the start time." : `Get OBS (or the browser tab) ready - your key works from ${C.lead_min} min before the start.`,
        link: "/stage", ref: "stage-remind:" + s.id }).catch(() => {});
    }
    const opensAt = isEmbed(s) ? start : start - C.lead_min * 60000;
    if (t < opensAt) continue;
    if (t > start + C.start_window_min * 60000) {          // never got a free slot in its window
      await end(s.id, "no_room", "system");
      rooms.notify(s.userId, { kind: "stage", title: `Your stage slot in ${RS.title} couldn't start`,
        body: "Every slot was still busy at your start time. Your hold was refunded in full.", link: "/stage", ref: "stage-noroom:" + s.id }).catch(() => {});
      continue;
    }
    // open it if there's room right now
    const open = await openSlots(s.room_id);
    const all = await getQuery(`SELECT COUNT(*) AS n FROM stage_slots WHERE status IN ${OPEN}`);
    if (open.length >= RS.slot_count || all[0].n >= C.max_concurrent) continue;
    if (open.some((x) => x.userId === s.userId)) continue;
    if (s.featured && open.some((x) => x.featured)) {
      if (t < start && !open.some((x) => x.featured && x.feature_by !== "auto")) {
        // 1.99lm: an auto-feature never holds up a booked featured slot - it yields once the slot opens
      } else if (t < start) continue;
      // a booking the owner featured ahead of time takes over the pad's main stream when it starts
      const f = open.find((x) => x.featured);
      await unfeature(f.id, "system", "a booked featured slot started");
    }
    const embed = isEmbed(s);
    const r = await runQuery(`UPDATE stage_slots SET status = ?, went_live = CASE WHEN ? THEN ? ELSE went_live END,
                              last_live = CASE WHEN ? THEN ? ELSE last_live END, notified = 2 WHERE id = ? AND status = 'scheduled'`,
                             [embed ? "active" : "waiting", embed ? 1 : 0, t, embed ? 1 : 0, t, s.id]);
    if (r.changes) {
      pubCache.clear();
      await event(s.id, "opened", "system", "scheduled", s.room_id);
      if (embed) require("./golive").slotLive(s);   // 1.99kp: an embed slot is live the moment it opens
      if (embed) await autoFeature(s.room_id, t).catch((e) => console.error("[stage] auto-feature:", e.message));   // 1.99lm
      if (!embed) {
        rooms.notify(s.userId, { kind: "stage", title: `Your stage slot in ${RS.title} is open - go live`,
          body: `Start streaming within ${C.start_window_min} min of the start time or it's cancelled and refunded.`, link: "/stage", ref: "stage-open:" + s.id }).catch(() => {});
      }
    }
  }
}

async function tickQueue(t) {
  const C = CONFIG;
  await runQuery("UPDATE stage_queue SET status = 'expired', done = ?, note = 'waited too long' WHERE status = 'waiting' AND created < ?", [t, t - QUEUE_TTL_MS]);
  const roomsWithQueue = await getQuery("SELECT DISTINCT room_id FROM stage_queue WHERE status = 'waiting'");
  for (const { room_id: roomId } of roomsWithQueue) {
    for (let guard = 0; guard < 4; guard++) {
      const head = (await queueFor(roomId))[0];
      if (!head) break;
      const RS = await rooms.stageSettings(roomId);
      const open = await openSlots(roomId);
      const all = await getQuery(`SELECT COUNT(*) AS n FROM stage_slots WHERE status IN ${OPEN}`);
      if (open.length >= RS.slot_count || all[0].n >= C.max_concurrent) break;
      // a scheduled booking that opens within its lead time keeps its place
      const soon = await getQuery(`SELECT COUNT(*) AS n FROM stage_slots WHERE room_id = ? AND status = 'scheduled' AND start_at < ?`,
                                  [roomId, t + (C.lead_min + 5) * 60000]);
      if (open.length + soon[0].n >= RS.slot_count) break;
      let res = null, err = null;
      try {
        res = await book({ userId: head.userId, username: head.username }, {
          room: roomId, minutes: head.minutes, mode: head.mode,
          embed: head.embed ? embedUrl(JSON.parse(head.embed)) : undefined, title: head.title });
      } catch (e) { err = e; }
      if (res) {
        await runQuery("UPDATE stage_queue SET status = 'promoted', slot_id = ?, done = ? WHERE id = ?", [res.slot.id, t, head.id]);
        rooms.notify(head.userId, { kind: "stage", title: `You're up on the stage in ${RS.title}!`,
          body: head.mode === "embed" ? "Your video is on now." : `Go live within ${C.start_window_min} min - open the Go live page for your key, or stream from the browser.`,
          link: "/stage", ref: "stage-up:" + head.id }).catch(() => {});
        continue;
      }
      if (err && err.status === 409 && /taken|featured|slots/i.test(err.message)) break;   // still busy: wait
      await runQuery("UPDATE stage_queue SET status = 'expired', done = ?, note = ? WHERE id = ?", [t, String(err ? err.message : "failed").slice(0, 200), head.id]);
      rooms.notify(head.userId, { kind: "stage", title: `Your turn on the stage in ${RS.title} was skipped`,
        body: String(err ? err.message : ""), link: "/stage", ref: "stage-skip:" + head.id }).catch(() => {});
    }
  }
}
function embedUrl(e) {
  const c = embeds.clean(e);
  if (!c) return "";
  if (c.p === "youtube") return c.t === "channel" ? `https://www.youtube.com/channel/${c.id}/live` : `https://youtu.be/${c.id}`;
  return c.t === "vod" ? `https://www.twitch.tv/videos/${c.id}` : `https://www.twitch.tv/${c.id}`;
}

// Startup: anything still open from before the restart either resumes (the next on_update brings
// it back to live) or, if its time is up, is settled now. Nothing is billed for the downtime.
async function reconcile() {
  await init();
  const t = now();
  let ended = 0;
  for (const s of await openSlots()) {
    lastTick.delete(s.id);
    if (t > deadline(s) || s.live_ms >= s.max_minutes * 60000 ||
        (s.status === "waiting" && t - startOf(s) > CONFIG.start_window_min * 60000)) {
      if (await end(s.id, "restart", "system")) ended++;
    } else if (s.publishing && !isLive(s, t)) {
      await runQuery("UPDATE stage_slots SET publishing = 0 WHERE id = ?", [s.id]);
    }
  }
  return ended;
}

// ── nginx-rtmp callbacks ──
const clients = new Map();    // nginx clientid -> slotId (memory; names are the fallback after a restart)
async function slotByName(name) {
  name = String(name || "");
  if (!name) return null;
  const relayFor = parseRelayKey(name);
  if (relayFor) return getSlot(relayFor);
  if (name.startsWith(STREAM_PREFIX)) {
    return (await getQuery(`SELECT * FROM stage_slots WHERE stream = ? AND status IN ${OPEN}`, [name]))[0] || null;
  }
  return (await getQuery(`SELECT * FROM stage_slots WHERE key_hash = ? AND status IN ${OPEN}`, [sha(name)]))[0] || null;
}

// Returns {status, location?}. 2xx = allow, 3xx = allow + push to `location`, else reject/drop.
async function rtmpCallback(f) {
  await init();
  const call = String(f.call || "");
  // 1.99aay: nginx-rtmp splits "<stream>?k=<secret>" into name + an args field k; a caller that didn't split (or a test) is
  // split here the same way, so both arrive as name = the stream, f.k = the secret
  let name = String(f.name || "");
  const qi = name.indexOf("?");
  if (qi >= 0) {
    if (!(typeof f.k === "string" && f.k)) f = { ...f, k: new URLSearchParams(name.slice(qi + 1)).get("k") || "" };
    name = name.slice(0, qi);
  }
  const app = String(f.app || "");
  const cid = String(f.clientid || "") + "@" + app;
  const t = now();
  if (call === "play" || call === "update_play" || call === "play_done") return { status: 200 };

  // ── the HLS application: Pepe's key, and the local pushes of open slots ──
  if (app === OUT_APP) {
    if (PEPE_KEYS.has(name)) {
      try { require("./restream").noteMain(call, t); } catch (e) { /* the relay is optional */ }   // 1.99fk: Twitch relay liveness
      return { status: 200 };
    }
    if (call === "publish_done") return { status: 200 };
    if (typeof f.k === "string" && f.k) return { status: 403 };        // 1.99aay: a slot key is never right on the HLS app
    if (!name.startsWith(STREAM_PREFIX)) return { status: 403 };
    if (call === "publish" && !isLoopback(f.addr)) return { status: 403 };
    // 1.99aay: "<stream>-a" = stageaudio.js's repaired copy of an open slot (local only, like the slot's own push)
    const base = require("./stageaudio").baseName(name) || name;
    const s = (await getQuery(`SELECT * FROM stage_slots WHERE stream = ? AND status IN ${OPEN}`, [base]))[0];
    if (!s || s.settled || isEmbed(s)) return { status: 403 };
    return { status: 200 };
  }
  if (app !== RTMP_APP) return { status: 403 };

  // ── the ingest application: slot keys + relay keys ──
  if (call === "publish") {
    const relayFor = parseRelayKey(name);
    // 1.99aay: the new key form "<stream>?k=<secret>" arrives as name = the stream, f.k = the secret; the old form as name = the secret
    const secret = typeof f.k === "string" && f.k ? f.k : null;
    const s = secret ? await publishGate({ key: secret, stream: name, addr: f.addr }, t) : await publishGate({ key: name, addr: f.addr }, t);
    if (!s) return { status: 403 };
    if (!(await goLive(s, t, relayFor ? "browser" : "rtmp"))) return { status: 403 };
    clients.set(cid, s.id);
    if (!relayFor) { try { require("./stageaudio").check(s); } catch (e) { /* the repair is optional */ } }   // 1.99aay: OBS audio check
    return { status: 302, location: `${OUT_LOCAL}/${s.stream}` };
  }

  if (call === "update_publish" || call === "publish_done") {
    const s = clients.has(cid) ? await getSlot(clients.get(cid)) : await slotByName(name);
    if (!s) return { status: call === "publish_done" ? 200 : 403 };
    if (call === "publish_done") {
      clients.delete(cid);
      try { require("./stageaudio").stop(s.id); } catch (e) { /* none */ }   // 1.99aay
      await runQuery("UPDATE stage_slots SET publishing = 0, last_live = ? WHERE id = ? AND settled = 0", [t, s.id]);
      pubCache.clear();
      return { status: 200 };
    }
    if (s.status === "ended" || s.settled) { clients.delete(cid); return { status: 403 }; }   // cut / over: drop it
    clients.set(cid, s.id);
    await runQuery("UPDATE stage_slots SET publishing = 1, beat = ? WHERE id = ? AND settled = 0", [t, s.id]);
    return { status: 200 };
  }
  return { status: 200 };
}

// ── 1.99et: THE publish gate - nginx-rtmp's on_publish (above) and MediaMTX's WHIP auth hook (webrtc.js)
// both ask it, so who may publish to a slot is decided in one place. -> the open slot, or null.
//   {key}      a slot's stream key (OBS: RTMP key, or the WHIP bearer token - the same key), or a relay
//              key (the server's own ffmpeg; loopback only, never with noRelay)
//   {slotId}   a caller that already proved who it is (webrtc.js: a signed browser WHIP token)
async function publishGate(o = {}, t = now()) {
  await init();
  let key = String(o.key || "");
  // 1.99aay: the whole "<stream>?k=<secret>" (a WHIP bearer token pasted from the RTMP key, a direct caller) = stream + secret
  const qi = key.indexOf("?");
  if (qi >= 0) {
    o = { ...o, stream: o.stream || key.slice(0, qi) };
    key = new URLSearchParams(key.slice(qi + 1)).get("k") || "";
  }
  let s = null;
  const relayFor = o.slotId ? null : parseRelayKey(key);
  if (o.slotId) s = await getSlot(o.slotId);
  else if (relayFor) {
    if (o.noRelay || !isLoopback(o.addr)) return null;
    s = await getSlot(relayFor);
  } else if (key && !key.startsWith(STREAM_PREFIX)) {
    s = (await getQuery(`SELECT * FROM stage_slots WHERE key_hash = ? AND status IN ${OPEN}`, [sha(key)]))[0] || null;
    if (s && o.stream && s.stream !== o.stream) s = null;           // 1.99aay: "<stream>?k=<secret>" - the secret must be THAT slot's
  }
  if (!s || !["waiting", "active"].includes(s.status) || s.settled || isEmbed(s) || t > deadline(s)) return null;
  if (await isBanned(s.userId, s.room_id)) return null;
  return s;
}
/** A publisher came on: the slot is active and live from now (billing heartbeat = beat). -> changed? */
async function goLive(s, t, via) {
  const r = await runQuery(`UPDATE stage_slots SET publishing = 1, beat = ?, status = 'active', via = ?,
                            went_live = COALESCE(went_live, ?), last_live = ? WHERE id = ? AND settled = 0`, [t, via || null, t, t, s.id]);
  if (!r.changes) return false;
  pubCache.clear();
  if (!s.went_live) {
    event(s.id, "live", s.username, via || "rtmp", s.room_id);
    if (s.source !== "cam") {                 // 1.99zc: a cam slot isn't the booker's own stream - no go-live alert / achievement
      require("./golive").slotLive(s);          // 1.99kp: 🎥 followers + the pad's announcement (once per stream)
      try { require("./achievements").poke(s.userId); } catch (e) { /* achievements never block */ }   // 1.99mt: 🔴 On Air / 🎬 Now Showing / 🛋️ Binge Mode
    }
  }
  await autoFeature(s.room_id || rooms.HOUSE_ROOM, t).catch((e) => console.error("[stage] auto-feature:", e.message));   // 1.99lm
  return true;
}
/** The open slot streaming under this public stream name (WHEP / HLS reads), or null. */
async function openSlotByStream(name) {
  await init();
  return (await getQuery(`SELECT * FROM stage_slots WHERE stream = ? AND status IN ${OPEN}`, [String(name || "")]))[0] || null;
}
/** 1.99et: MediaMTX's ready WHIP paths (webrtc.sync, every 5 s) = on_update for WHIP slots: each one with
 *  an open slot is that slot's heartbeat; WHIP slots no longer in the list stop publishing (publish_done).
 *  -> the names with NO open slot (ended / cut / banned / past the deadline): webrtc.js kicks them. */
async function whipBeat(names, t = now()) {
  await init();
  const orphans = [];
  const seen = new Set();
  for (const name of names || []) {
    const s = await openSlotByStream(name);
    if (!s || s.settled || isEmbed(s) || t > deadline(s) || (await isBanned(s.userId, s.room_id))) { orphans.push(name); continue; }
    seen.add(s.id);
    if (!s.publishing || s.via !== "whip") await goLive(s, t, "whip");
    else await runQuery("UPDATE stage_slots SET beat = ? WHERE id = ? AND settled = 0", [t, s.id]);
  }
  const gone = await getQuery(`SELECT id FROM stage_slots WHERE via = 'whip' AND publishing = 1 AND status IN ${OPEN}`);
  for (const g of gone) {
    if (seen.has(g.id)) continue;
    await runQuery("UPDATE stage_slots SET publishing = 0, last_live = ? WHERE id = ? AND settled = 0", [t, g.id]);
    pubCache.clear();
  }
  return orphans;
}

function isLoopback(a) {
  a = String(a || "");
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

// ── browser relay: MediaRecorder chunks in, one ffmpeg -> RTMP per slot ──
const relays = new Map();     // slotId -> {proc, next, window:[{t,n}], last}
let spawnImpl = (args) => childProcess.spawn(FFMPEG, args, { stdio: ["pipe", "ignore", "pipe"] });
function ffmpegArgs(slotId) {
  return ["-hide_banner", "-loglevel", "error", "-fflags", "+genpts", "-i", "pipe:0",
          "-vf", "scale=w='trunc(min(1280,iw)/2)*2':h=-2", "-r", "30",
          "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p",
          "-b:v", "2500k", "-maxrate", "2500k", "-bufsize", "5000k", "-g", "60",
          "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
          "-f", "flv", `${RTMP_LOCAL}/${relayKey(slotId)}`];
}
function stopRelay(slotId) {
  const r = relays.get(slotId);
  if (!r) return false;
  relays.delete(slotId);
  try { r.proc.stdin.end(); } catch (e) { /* gone */ }
  setTimeout(() => { try { r.proc.kill("SIGKILL"); } catch (e) { /* gone */ } }, 3000).unref();
  return true;
}
function startRelay(slotId) {
  stopRelay(slotId);
  const proc = spawnImpl(ffmpegArgs(slotId));
  const r = { proc, next: 0, window: [], last: now(), started: now() };
  const key = relayKey(slotId);
  if (proc.stderr) {
    proc.stderr.on("data", (d) => {
      // never let the relay key reach the log
      const line = String(d).split(key).join("<relay>").trim().slice(0, 300);
      if (line) console.error(`[stage] ffmpeg ${slotId.slice(0, 8)}: ${line}`);
    });
  }
  if (proc.stdin) proc.stdin.on("error", () => {});
  proc.on("exit", () => { if (relays.get(slotId) === r) relays.delete(slotId); });
  proc.on("error", (e) => { console.error("[stage] ffmpeg failed to start:", e.code || e.message); if (relays.get(slotId) === r) relays.delete(slotId); });
  relays.set(slotId, r);
  return r;
}
// The owner of the slot posts chunk #seq. seq 0 (re)starts the relay; anything out of order asks
// the browser to restart its recorder (a fresh WebM header).
async function relayChunk(user, slotId, seq, buf) {
  const s = await getSlot(slotId);
  if (!user || !user.userId || !s || s.userId !== user.userId) throw new Refuse(403, "Not your slot.");
  if (s.status === "ended" || s.settled) { stopRelay(s.id); throw new Refuse(410, "This slot has ended."); }
  if (!["waiting", "active"].includes(s.status) || isEmbed(s)) throw new Refuse(409, "This slot isn't open for streaming yet.");
  if (await isBanned(s.userId, s.room_id)) { stopRelay(s.id); throw new Refuse(403, "You can't use the stage."); }
  seq = Math.floor(Number(seq));
  if (!Number.isFinite(seq) || seq < 0) throw new Refuse(400, "bad seq");
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Refuse(400, "empty chunk");
  if (buf.length > RELAY_MAX_CHUNK) throw new Refuse(413, "Chunk too big.");
  let r = relays.get(s.id);
  if (seq === 0) r = startRelay(s.id);
  if (!r || r.next !== seq) return { ok: false, restart: true, expect: r ? r.next : 0 };
  const t = now();
  r.window = r.window.filter((w) => t - w.t < RELAY_WINDOW_MS);
  r.window.push({ t, n: buf.length });
  const bytes = r.window.reduce((a, w) => a + w.n, 0);
  const span = Math.max(1000, Math.min(RELAY_WINDOW_MS, t - r.started));
  const kbps = (bytes * 8) / span;   // bits per ms = kbit/s
  if (t - r.started > 3000 && kbps > RELAY_MAX_KBPS) {
    stopRelay(s.id);
    throw new Refuse(413, "Your stream is over the bitrate cap - lower the quality and start again.");
  }
  r.next = seq + 1;
  r.last = t;
  try { r.proc.stdin.write(buf); } catch (e) { stopRelay(s.id); return { ok: false, restart: true, expect: 0 }; }
  return { ok: true, next: r.next, kbps: Math.round(kbps) };
}
function sweepRelays() {
  const t = now();
  for (const [id, r] of relays) if (t - r.last > RELAY_IDLE_MS) stopRelay(id);
}

// A fresh key for your own open (or upcoming) stream slot; the old one stops working.
async function regenKey(user, slotId) {
  const s = await getSlot(slotId);
  if (!user || !s || s.userId !== user.userId || s.settled || isEmbed(s)) throw new Refuse(404, "That isn't your stream slot.");
  const key = newKey();
  await runQuery("UPDATE stage_slots SET key_hash = ? WHERE id = ? AND settled = 0", [sha(key), s.id]);
  await event(s.id, "key", user.username, "new key", s.room_id);
  const pk = pubKey(s.stream, key);                                     // 1.99aay
  return { key: pk, rtmp: { server: RTMP_PUBLIC, key: pk } };
}

// 1.99fu: pad visibility (padaccess.js) - an Approved pad's stage takes bookings only from the people inside it
// ── 1.99zc: 🎬 cam slots (see the header) ──
const LC = () => require("./livecam");
const CAM_LOGIN_RE = /^[\w.\-$]{1,40}$/;
// refusals that end a cam slot (stagefix: + "unavailable" - a block / "Take me off this Stage" found when it takes hold again)
const CAM_END = new Set(["not_on_cam", "opted_out", "room_off", "ended_by", "off", "on_stage", "unavailable"]);
function bridgeRoom(roomId) {
  try { const B = require("./bridge")._rooms.get(String(roomId)); return B && Date.now() - (B.updated || 0) < 90 * 1000 ? B : null; } catch (e) { return null; }
}
const camMember = (B, login) => ((B && B.members) || []).find((x) => x && !x.anon && !x.self && String(x.login || "").toLowerCase() === login) || null;
/** Tell the cam's owner: their linked PATV account (inbox + PM), else a Camfrog PM via Pepe (queued as the actor). */
async function camNotify(login, actorUser, title, link) {
  try {
    const u = (await getQuery("SELECT userId FROM users WHERE LOWER(camfrogUsername) = ? LIMIT 1", [login]))[0];
    if (u) {
      // stagefix: "Take me off this Stage" (stageleave.js) is on the pad's page and in Settings → Privacy
      await rooms.notify(u.userId, { kind: "stage", title, body: "Not OK? Press Take me off this Stage on the pad's page or in Settings → Privacy - that pad can't put your cam back for an hour. Or switch off live video of your cam (!livecam off in Camfrog).",
                                     link, ref: "stage-cam:" + login + ":" + now() });
      return;
    }
    const site = process.env.SITE_URL || (STAGING ? "https://staging.publicaccess.tv" : "https://publicaccess.tv");
    if (actorUser && actorUser.userId) {
      // stagefix: + "!stage off me" (this pad, 1 h; Pepe forwards it to /api/rooms/stage/act - a bot change, see stageleave.js).
      // stagefix fix: only once Pepe says he forwards it (livecam.stageOffMeOk) - before that his !stage is owners / admins only,
      // so the PM keeps the way off that works today
      const text = LC().stageOffMeOk()
        ? `${title} - not OK? Say !stage off me in that room (it can't put you back for an hour), or !livecam off (everywhere). ${site}${link}`
        : `${title} - say !livecam off to take it down. ${site}${link}`;
      await require("./actions").queue(actorUser.userId, { kind: "notify", args: [login, text.slice(0, 300), "stage"],
                                                           tag: "stage-notify", label: title });
    }
  } catch (e) { console.error("[stage] cam notify:", e.message); }
}
/** The pad's owner / staff put `login`'s live cam on the stage. -> {slot} | throws Refuse */
async function camOpen(user, opts = {}) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const C = CONFIG;
  if (!C.enabled) throw new Refuse(409, "The stage is switched off right now.");
  const roomId = String(opts.room || "");
  const R = await rooms.get(roomId);
  if (!R) throw new Refuse(404, "No such pad.");
  const B = bridgeRoom(roomId);
  if (!B) throw new Refuse(409, "This pad's Camfrog room isn't live right now.");
  const login = String(opts.login || "").toLowerCase();
  if (!CAM_LOGIN_RE.test(login)) throw new Refuse(400, "Whose cam?");
  const RS = await rooms.stageSettings(roomId);
  const id = uuidv4();
  const t = now();
  // capacity first (cheap, nothing to undo), then the cam itself (the live-cam consent rules), then the row
  const open0 = await getQuery(`SELECT * FROM stage_slots WHERE room_id = ? AND status IN ${OPEN}`, [roomId]);
  if (open0.some((x) => x.source === "cam" && String(x.cam_login || "").toLowerCase() === login)) throw new Refuse(409, "That cam is already on this pad's stage.");
  if (open0.length >= RS.slot_count) throw new Refuse(409, RS.slot_count > 1 ? `All ${RS.slot_count} slots in this pad are taken - end one first.` : "This pad's stage slot is taken - end it first.");
  // stagefix (D-17 (a)): the person's own say over pins (stagepin.js) - "never" (and a "No" to this pad < 6 h ago) is the neutral
  // "unavailable"; "off" without their yes for this pad turns the pin into an ASK: nothing goes up until they allow it
  const PIN = require("./stagepin");
  const gate = await PIN.pinGate(roomId, login, t);
  const unavailable = () => Object.assign(new Refuse(403, "That cam isn't available right now."), { code: "unavailable" });
  if (gate === "never" || gate === "declined") throw unavailable();
  if (gate === "waiting") throw Object.assign(new Refuse(409, "Already asked - waiting for their OK."), { code: "waiting" });
  if (gate === "ask") {
    const m = await LC().stageConsent(B, login, t, { actor: user });      // every other refusal first: never ask someone who can't go up
    const a = await PIN.askPin({ roomId, login, actor: user, display: m && m.display }, t);
    if (!a) throw unavailable();
    await event(null, "cam_ask", user.username || "?", `📷 ${login} asked`, roomId);
    return { asked: true, ask: { id: a.id, expires: a.expires }, display: String((m && m.display) || login).slice(0, 60) };
  }
  let held;
  try { held = await LC().stageHold(B, login, id, t, { actor: user }); }     // stagefix: blocks with the actor / pad owner, Take me off
  catch (e) {
    // micfollow: live cams are full - a manual action wins: the mic stage gives up one of its own relays, then try once more
    if (!(e && e.refuse && e.code === "slots_busy")) throw e;
    let freed = false;
    try { freed = require("./micfollow").yieldRelay(t); } catch (x) { freed = false; }
    if (!freed) throw e;
    held = await LC().stageHold(B, login, id, t, { actor: user });
  }
  let SL = null;
  try { SL = require("./stageleave"); await SL.init(); } catch (e) { SL = null; }
  try {
    await tx(async () => {
      // stagefix: "Take me off this Stage" again, inside the write - a take-off that landed after stageHold's check is seen
      // here, or it ends this slot itself (stageleave.leave ends the open slots after its own write)
      if (SL && (await SL.excludedInTx(roomId, login, t))) throw Object.assign(new Refuse(403, "That cam isn't available right now."), { code: "unavailable" });
      const open = await getQuery(`SELECT * FROM stage_slots WHERE room_id = ? AND status IN ${OPEN}`, [roomId]);
      if (open.length >= RS.slot_count) throw new Refuse(409, "This pad's stage slots are taken - end one first.");
      const all = await getQuery(`SELECT COUNT(*) AS n FROM stage_slots WHERE status IN ${OPEN}`);
      if (all[0].n >= C.max_concurrent) throw new Refuse(409, `The site already has ${all[0].n} streams open (the most at once) - try again later.`);
      const u = (await getQuery("SELECT username FROM users WHERE userId = ?", [user.userId]))[0];
      if (!u) throw new Refuse(404, "Couldn't find your account.");
      const display = String(held.display || login).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 60);
      await runQuery(`INSERT INTO stage_slots (id, userId, username, displayname, status, created, max_minutes, price_per_min, held,
                      key_hash, stream, revenue_vault, room_id, kind, featured, feature_by, mode, embed, start_at, title, source, cam_login, via)
                      VALUES (?, ?, ?, ?, 'waiting', ?, ?, 0, 0, NULL, ?, 'room_flow', ?, 'slot', 0, NULL, 'stream', NULL, ?, ?, 'cam', ?, 'cam')`,
                     [id, user.userId, u.username, display, t, libraryMaxFor(RS), "cam-" + crypto.randomBytes(8).toString("hex"), roomId, t,
                      cleanTitle("📷 " + display), login]);
    });
  } catch (e) { LC().stageRelease(id); throw e; }
  pubCache.clear();
  await event(id, "cam", user.username || "?", `📷 ${login} put on the stage`, roomId);
  camNotify(login, user, `Your cam is on the stage of ${RS.title || "a pad"} on PATV`, "/p/" + encodeURIComponent(RS.slug || roomId)).catch(() => {});
  // stagefix fix: a followers / request cam shows only to the few its owner allows (Stage viewers follow the cam's mode) - say so
  return { slot: view(await getSlot(id)), ...((await camLimited(login)) ? { limited: true } : {}) };
}
/** stagefix fix: does `login`'s cam show only to some viewers (its owner's mode is followers or request)? The pad's owner is told
 *  ("only some viewers will see it"), never which mode - the Live button already shows anyone that much. */
async function camLimited(login) {
  try { const CA = require("./camaccess"); await CA.init(); const m = CA.accessOf(login).mode; return m === "followers" || m === "request"; }
  catch (e) { return false; }
}
/** tick: a cam slot follows its relay. -> "ended" when it ended the slot, else the relay's state */
async function camBeat(s, t = now()) {
  const login = String(s.cam_login || "").toLowerCase();
  const B = bridgeRoom(s.room_id);
  let why = null;
  if (B) {
    const m = camMember(B, login);
    if (!m || !m.on_cam) why = "left_cam";
    else if (B.livecams === false || !B.cams) why = "room_off";
  }
  if (!why && LC().optedOut(login)) why = "opted_out";
  // stagefix: what the person (or the pad) changed since it went up - private activity, Take me off this Stage, a block with
  // whoever put it up or the pad's owner, the pad's bridge perk (livecam.stageRecheck)
  if (!why) why = await LC().stageRecheck(s.room_id, login, { actorId: s.userId }, t);
  // stagefix (D-17 (a) / DF-45): their level ("never"; "off" without a yes) and the 10-minute "Keep going / Take me off" check
  if (!why) { try { why = await require("./stagepin").slotWhy(s, t); } catch (e) { console.error("[stage] stagepin:", e.message); } }
  let st = LC().stageState(s.id, t);
  if (!why && st.state === "ended") why = st.why || "ended";
  if (!why && st.state === "none" && B) {                    // the site restarted (sessions are in memory): take hold again
    try { await LC().stageHold(B, login, s.id, t, { actor: { userId: s.userId } }); st = LC().stageState(s.id, t); }
    catch (e) { if (e && e.refuse && CAM_END.has(e.code)) why = e.code; }
  }
  if (why) { await end(s.id, "cam_" + String(why).slice(0, 24), "system"); return "ended"; }
  if (st.state === "live") {
    if (!s.publishing) await goLive(s, t, "cam");
    else await runQuery("UPDATE stage_slots SET beat = ? WHERE id = ? AND settled = 0", [t, s.id]);
  }
  return st.state;
}
/** For the owner's UI: who is on cam in the pad's room right now, and whether they can go on the stage. actor = who's asking
 *  (stagefix: someone they can't put up - a block either way with them or the pad's owner, or Take me off this Stage - is
 *  blocked: "unavailable", never the reason). */
async function camCandidates(roomId, actor) {
  await init();
  const B = bridgeRoom(roomId);
  if (!B) return { live: false, livecams: false, cams: [] };
  const open = await openSlots(roomId);
  const onStage = new Map(open.filter((s) => s.source === "cam").map((s) => [String(s.cam_login || "").toLowerCase(), s.id]));
  const list = (B.members || []).filter((x) => x && !x.anon && !x.self && x.on_cam && CAM_LOGIN_RE.test(String(x.login || ""))).slice(0, 80);
  let priv = new Set();
  try { priv = await require("./stories").privateLogins(list.map((x) => String(x.login).toLowerCase())); } catch (e) { priv = new Set(); }
  let no = new Set();
  try { no = await LC().directorBlockedSet(list.map((x) => String(x.login)), roomId, actor && actor.userId); } catch (e) { no = new Set(); }
  let SL = null;
  try { SL = require("./stageleave"); await SL.init(); } catch (e) { SL = null; }
  let CA = null;
  try { CA = require("./camaccess"); await CA.init(); } catch (e) { CA = null; }
  // stagefix (final round): a stage ban of their linked account; their own say over pins (stagepin.js: "never" / a recent "No" ->
  // "unavailable"; "off" without a yes for this pad -> ask: true, the button asks them; an ask out -> waiting: true)
  let banned = new Set();
  try { banned = await LC().bannedSet(list.map((x) => String(x.login)), roomId); } catch (e) { banned = new Set(); }
  let PIN = null, waiting = new Set();
  try { PIN = require("./stagepin"); await PIN.init(); waiting = await PIN.waitingIn(roomId); } catch (e) { PIN = null; }
  const t = now();
  const cams = list.map((x) => {
    const login = String(x.login).toLowerCase();
    // stagefix fix: private activity is "unavailable" like a block or a take-off (one neutral word - "opted_out" is only the
    // live-video switch, which everyone can see anyway); limited = a followers / request cam: only some viewers will see it
    const md = CA ? CA.accessOf(login).mode : null;
    const lv = PIN ? PIN.levelOf(login) : "on";
    const blocked = LC().optedOut(login) ? "opted_out"
      : priv.has(login) || no.has(login) || banned.has(login) || (SL && SL.excludedUntil(roomId, login)) || lv === "never" || (PIN && PIN.noUntil(roomId, login, t)) ? "unavailable" : null;
    const ask = !blocked && lv === "off" && !(PIN && PIN.padYes(roomId, login));
    return { login, display: String(x.display || x.login).slice(0, 60), slot: onStage.get(login) || null, blocked,
             limited: md === "followers" || md === "request", ...(ask ? { ask: true, waiting: waiting.has(login) } : {}) };
  });
  return { live: true, livecams: B.livecams !== false && !!B.cams, cams };
}

async function seesPad(user, roomId) {
  const PA = require("./padaccess");
  await PA.init();
  return PA.canSee(user || null, roomId);
}

// ── views ──
function view(s, t = now()) {
  if (!s) return null;
  const e = embedOf(s);
  return {
    id: s.id, username: s.username, display: s.displayname || s.username, status: s.status,
    live: isLive(s, t), created: s.created, went_live: s.went_live || null, ended: s.ended || null,
    max_minutes: s.max_minutes, price_per_min: s.price_per_min, held: s.held,
    live_seconds: Math.floor((s.live_ms || 0) / 1000), billed_minutes: billedMinutes(s.live_ms),
    charged: s.settled ? s.charged : chargeFor(s, s.live_ms), refunded: s.refunded == null ? null : s.refunded,
    end_reason: s.end_reason || null, ended_by: s.ended_by || null,
    stream: s.stream, hls: hlsOf(s), relay: relays.has(s.id),
    start_at: startOf(s), start_by: startOf(s) + CONFIG.start_window_min * 60000,
    opens_at: isEmbed(s) ? startOf(s) : startOf(s) - CONFIG.lead_min * 60000,
    room_id: s.room_id || rooms.HOUSE_ROOM, kind: s.kind || "slot", featured: !!s.featured, feature_by: s.feature_by || null,
    mode: s.mode || "stream", embed: e, embed_label: e ? embeds.label(e) : null, title: s.title || null,
    // 1.99cr (stagecap.js): may viewers snap / clip this slot (its streamer's choice, default yes), is it NSFW
    capture: !s.capture_off && !isEmbed(s) && (s.via !== "whip" || whipRelayed(s, t)) && s.source !== "cam", nsfw: !!s.nsfw,
    // 1.99abe: the streamer's own choice (the Go-live checkbox) apart from whether snaps / clips can work on this stream at all -
    // the page re-synced the box from `capture`, which is false for a WHIP stream, so a click was undone on the next poll
    capture_allowed: !s.capture_off,
    capture_na: isEmbed(s) ? "embed" : s.via === "whip" && !whipRelayed(s, t) ? "whip" : s.source === "cam" ? "cam" : null,
    library: s.source === "library",                                     // 1.99ji: 📼 played from the Plex library
    cam: s.source === "cam" ? { login: s.cam_login || null } : null,    // 1.99zc: 🎬 someone's live cam
  };
}
// 1.99et: a WHIP slot's HLS comes from MediaMTX (webrtc.js), everything else from nginx-rtmp's /hls
function hlsOf(s) {
  if (s.via === "whip") { try { return require("./webrtc").hlsUrl(s.stream); } catch (e) { /* fall through */ } }
  // 1.99aay: a stream with a broken audio track plays from its repaired copy (stageaudio.js: video copied + silent audio)
  try { const fx = require("./stageaudio").fixedName(s); if (fx) return `${HLS_BASE}/${fx}.m3u8`; } catch (e) { /* no repair */ }
  return `${HLS_BASE}/${s.stream}.m3u8`;
}
// 1.99aaz: what Pepe's OBS plays for an on-air slot: the RTMP play URL of the slot's HLS-app stream (its audio-repaired copy
// when there is one); a WHIP slot lives in MediaMTX, not nginx-rtmp, so it keeps its HLS. ONAIR_PULL=hls = the old behaviour.
// 1.99abf: a WHIP slot is ALSO in nginx-rtmp while MediaMTX's slot-relay.sh runs (H.264 copy, Opus -> AAC): its playlist on
// disk is fresh then. That copy is what stage snaps / clips cut and what Pepe's OBS pulls; viewers keep WHEP / MediaMTX HLS.
const RELAY_HLS_DIR = require("path").resolve(process.env.STAGECAP_HLS_DIR || ("/mnt/hls" + (STAGING ? "/staging" : "")));
const relayCache = new Map();   // stream -> {at, ok}
function whipRelayed(s, t = now()) {
  if (!s || s.via !== "whip" || !s.stream) return false;
  const c = relayCache.get(s.stream);
  if (c && t - c.at < 5000) return c.ok;
  let ok = false;
  try { ok = t - require("fs").statSync(require("path").join(RELAY_HLS_DIR, s.stream + ".m3u8")).mtimeMs < 30 * 1000; } catch (e) { ok = false; }
  relayCache.set(s.stream, { at: t, ok });
  if (relayCache.size > 500) relayCache.clear();
  return ok;
}
function playUrlOf(s) {
  if ((s.via === "whip" && !whipRelayed(s)) || String(process.env.ONAIR_PULL || "rtmp").toLowerCase() === "hls") return hlsOf(s);
  let name = s.stream;
  try { name = require("./stageaudio").fixedName(s) || s.stream; } catch (e) { /* no repair */ }
  return `${RTMP_PLAY}/${name}`;
}
// ...and, while webrtc_enabled is on, its WHEP URL for the ⚡ Low latency toggle (absent otherwise)
function whepOf(s) {
  if (s.via !== "whip" || isEmbed(s)) return null;
  try { const w = require("./webrtc"); return w.enabled() ? w.whepUrl(s.stream) : null; } catch (e) { return null; }
}
// What a stage shows: the slots live right now in a room (cached briefly; pages poll it).
const pubCache = new Map();   // room id ("" = every room) -> {at, list, camLogins}
async function publicSlots(roomId) {
  const k = String(roomId || "");
  const c = pubCache.get(k);
  if (c && Date.now() - c.at < 2000) return c.list;
  const t = now();
  let nameStyle = () => "";
  try { nameStyle = require("./cosmetics").nameStyle; } catch (e) { /* no cosmetics */ }
  const rows = (await openSlots(roomId || undefined)).filter((s) => isLive(s, t));
  // stagefix fix: each live cam slot's Camfrog login, cached WITH the list but never on it (slotsFor's mine: true reads it here
  // instead of querying every open slot on every poll)
  const camLogins = new Map();
  for (const s of rows) if (s.source === "cam") camLogins.set(s.id, String(s.cam_login || "").toLowerCase());
  const list = rows.map((s) => {
    const e = embedOf(s);
    if (s.source === "cam") {               // 1.99zc: 🎬 the viewer asks for a WHEP ticket of their own (POST /api/stage/slots/:id/cam)
      return { id: s.id, username: null, display: s.displayname || s.cam_login || "cam", nameCss: "", hls: null, embed: null, cam: true, since: s.went_live,
               room_id: s.room_id, featured: !!s.featured, feature_by: s.feature_by || null, title: s.title || null, mode: "stream", capture: false, nsfw: !!s.nsfw };
    }
    const whep = e ? null : whepOf(s);
    return {
      id: s.id, username: s.username, display: s.displayname || s.username, nameCss: nameStyle(s.username) || "",
      hls: e ? null : hlsOf(s), embed: e, since: s.went_live, room_id: s.room_id,
      featured: !!s.featured, feature_by: s.feature_by || null, title: s.title || null, mode: s.mode || "stream",
      capture: !e && !s.capture_off && (s.via !== "whip" || whipRelayed(s)), nsfw: !!s.nsfw,     // 1.99cr: the stage's Snap / Clip buttons (stagecap.js; 1.99abf: a WHIP slot once slot-relay.sh writes its HLS)
      ...(whep ? { whep } : {}),                                              // 1.99et: only while webrtc_enabled is on
    };
  }).sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || (a.since || 0) - (b.since || 0));
  pubCache.set(k, { at: Date.now(), list, camLogins });
  return list;
}
/** stagefix fix: slot id -> Camfrog login of a room's live cam slots, from publicSlots' cache (server side only). */
async function camLoginsOf(roomId) {
  await publicSlots(roomId);
  const c = pubCache.get(String(roomId || ""));
  return (c && c.camLogins) || new Map();
}
/** stagefix fix: a viewer's own linked Camfrog login (lower case, "" = none), cached 30 s - the stage polls every 10 s per viewer. */
const ownLogins = new Map();       // userId -> {at, login}
async function viewerLogin(userId) {
  const k = String(userId), c = ownLogins.get(k);
  if (c && Date.now() - c.at < 30 * 1000) return c.login;
  const me = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [k]))[0];
  const login = me && me.camfrogUsername ? String(me.camfrogUsername).toLowerCase() : "";
  if (ownLogins.size > 5000) ownLogins.clear();
  ownLogins.set(k, { at: Date.now(), login });
  return login;
}
/**
 * stagefix: a pad's live stage slots as `viewer` (null = signed out) may see them - on an Approved pad the HLS / WHEP URLs carry
 * their read token (padaccess.tokenizeSlots); a 🎬 cam slot only for a signed-in viewer who may see the pad's live room
 * (padaccess.camSlotsFor - the 18+ gate included) and its name blanked past the 18+ gate (padaccess.adultSlots); and a cam
 * slot showing the viewer's OWN Camfrog cam carries mine: true (the page's "Take me off this Stage"). list = publicSlots(roomId).
 */
const camVisible = (roomId, viewer) => require("./padaccess").camVisible(viewer, roomId);
async function slotsFor(roomId, viewer, list) {
  const PA = require("./padaccess");
  await PA.init();
  if (!list) list = await publicSlots(roomId);
  let out = PA.adultSlots(PA.camSlotsFor(PA.tokenizeSlots(list, viewer, roomId), viewer), viewer);
  if (viewer && viewer.userId && out.some((s) => s && s.cam)) {
    const login = await viewerLogin(viewer.userId);              // stagefix fix: cached, and the cam logins from publicSlots' cache
    if (login) {
      const cams = await camLoginsOf(roomId);
      if (out.some((s) => s && s.cam && cams.get(s.id) === login)) out = out.map((s) => (s && s.cam && cams.get(s.id) === login ? { ...s, mine: true } : s));
    }
  }
  return out;
}
/** One room's stage for its pages: live slots, capacity, upcoming bookings, the queue. */
async function roomStage(roomId, viewer) {
  await init();
  await require("./padaccess").init();
  const RS = await rooms.stageSettings(roomId);
  const t = now();
  const open = await openSlots(roomId);
  const live = await publicSlots(roomId);
  const fut = (await futureSlots(roomId)).filter((s) => s.status === "scheduled");
  const q = await queueFor(roomId);
  const mine = viewer && viewer.userId ? q.findIndex((x) => x.userId === viewer.userId) : -1;
  let featured = open.find((s) => s.featured) || null;
  // stagefix: a featured 🎬 cam slot is named only to viewers who may see it (padaccess.camSlotsFor's rule)
  if (featured && featured.source === "cam" && !camVisible(roomId, viewer)) featured = null;
  // stagefix fix: ...nor counted for them - "1/4 slots in use" with nothing listed would say a cam is up
  const shown = open.filter((s) => s.source !== "cam" || camVisible(roomId, viewer)).length;
  let boost = null;
  try { boost = await require("./boosts").status(roomId); } catch (e) { boost = null; }   // 1.99ee: the Stage card's boost line
  return {
    room: { id: roomId, slug: RS.slug, title: RS.title, slot_count: RS.slot_count, slot_price: RS.slot_price, approval: RS.approval },
    // 1.99fu: an Approved pad's HLS / WHEP URLs carry the viewer's read token (padaccess.tokenizeSlots; webrtc.js checks it)
    // adultgate site: + a cam slot's name blanked for a viewer the 18+ gate stops (padaccess.adultSlots; off: as is)
    // stagefix: + cam slots only for viewers who may see the live room, and mine: true on the viewer's own cam (slotsFor)
    slots: await slotsFor(roomId, viewer, live), open: shown, free: Math.max(0, RS.slot_count - shown),
    featured: featured ? { id: featured.id, display: featured.displayname || featured.username, live: isLive(featured, t), by: featured.feature_by } : null,
    upcoming: fut.slice(0, 6).map((s) => ({ id: s.id, display: s.displayname || s.username, username: s.username || null, start_at: startOf(s), minutes: s.max_minutes,
      featured: !!s.featured, title: s.title || null, mode: s.mode || "stream" })),
    queue: { length: q.length, position: mine >= 0 ? mine + 1 : null, entry: mine >= 0 ? q[mine].id : null },
    price: CONFIG.price_per_min, enabled: CONFIG.enabled && CONFIG.max_concurrent > 0, boost,
  };
}
/** A room's schedule for its page (1.99bx): what's on now, the booked / scheduled slots ahead, the
 *  queue. Only public facts: names as shown on the stage, titles, featured / ordinary, stream / embed.
 *  Requests still waiting for the owner's OK are shown to the room's managers (manage = true) and, as
 *  their own, to the person who asked - never to anyone else. No user ids, slot ids or keys. */
async function roomSchedule(roomId, viewer, manage) {
  await init();
  const t = now();
  const me = viewer && viewer.userId ? viewer.userId : null;
  await require("./padaccess").init();
  // stagefix: a 🎬 cam slot (someone's Camfrog cam) is only on the schedule of viewers who may see the pad's live room
  const open = (await openSlots(roomId)).filter((s) => s.source !== "cam" || camVisible(roomId, viewer));
  const fut = await futureSlots(roomId);
  const q = await queueFor(roomId);
  const row = (s) => {
    const e = embedOf(s);
    return { display: s.displayname || s.username, username: s.source === "cam" ? null : s.username || null, title: s.title || null, featured: !!s.featured, mode: isEmbed(s) ? "embed" : "stream",
             embed_label: e ? embeds.label(e) : null, minutes: s.max_minutes, mine: !!me && s.userId === me };
  };
  const live = open.map((s) => ({ ...row(s), live: isLive(s, t), since: s.went_live || null, start_at: startOf(s),
                                  ends_by: (s.went_live || startOf(s)) + s.max_minutes * 60000 }))
    .sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || (b.live ? 1 : 0) - (a.live ? 1 : 0) || (a.since || a.start_at) - (b.since || b.start_at));
  const upcoming = fut.filter((s) => s.status === "scheduled" || (s.status === "requested" && (manage || (me && s.userId === me))))
    .slice(0, 40)
    .map((s) => ({ ...row(s), start_at: startOf(s), status: s.status === "requested" ? "requested" : "scheduled" }));
  const queue = q.map((e, i) => ({ position: i + 1, display: e.displayname || e.username, username: e.username || null, minutes: e.minutes, featured: !!e.feature,
                                   title: e.title || null, mode: e.mode === "embed" ? "embed" : "stream", mine: !!me && e.userId === me }));
  // 1.99dt: the booker's profile link (one users lookup for the whole schedule; archived / unknown -> no link).
  // 1.99en: a slot's username is the PATV account that booked it (not a Camfrog login): resolved by username.
  try {
    const ul = require("./userlinks");
    const all = [...live, ...upcoming, ...queue];
    const found = await ul.lookupUsers(all.map((r) => r.username).filter(Boolean));
    for (const r of all) { const a = r.username ? found.get(ul.refKey(r.username).toLowerCase()) : null; r.href = a ? ul.profileHref(a.username) : null; }
  } catch (e) { console.error("[stage] schedule links:", e.message); }
  const out = { live, upcoming, queue };
  if (manage) out.pending = fut.filter((s) => s.status === "requested").length;
  return out;
}
/** The channel guide: per room, what's on now and what's next. Map room id -> {now[], next[]}. */
async function guide() {
  await init();
  const t = now();
  const open = await openSlots();
  const fut = (await futureSlots()).filter((s) => s.status === "scheduled" && startOf(s) < t + 7 * 86400000);
  const by = new Map();
  const add = (id) => { if (!by.has(id)) by.set(id, { now: [], next: [] }); return by.get(id); };
  for (const s of open) {
    const e = embedOf(s);
    add(s.room_id).now.push({ id: s.id, display: s.displayname || s.username, username: s.username || null, live: isLive(s, t), featured: !!s.featured,
      ...(s.source === "cam" ? { cam: true } : {}),     // adultgate site: a 🎬 cam slot (roomsweb.guideRows blanks its name past the 18+ gate)
      title: s.title || null, mode: s.mode || "stream", embed_label: e ? embeds.label(e) : null, since: s.went_live || null,
      ends_by: (s.went_live || startOf(s)) + s.max_minutes * 60000 });
  }
  for (const s of fut) {
    add(s.room_id).next.push({ id: s.id, display: s.displayname || s.username, username: s.username || null, start_at: startOf(s), minutes: s.max_minutes,
      featured: !!s.featured, title: s.title || null, mode: s.mode || "stream" });
  }
  for (const v of by.values()) {
    v.now.sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0));
    v.next.sort((a, b) => a.start_at - b.start_at);
  }
  return by;
}
/** The signed-in user's bookings: open + upcoming + recently ended, the last one, queue entries. */
async function mine(userId) {
  await init();
  const rows = await getQuery(`SELECT * FROM stage_slots WHERE userId = ? AND (status != 'ended' OR ended > ?) ORDER BY start_at`,
                              [userId, now() - 30 * 60000]);
  const last = (await getQuery("SELECT * FROM stage_slots WHERE userId = ? ORDER BY created DESC LIMIT 1", [userId]))[0];
  const q = await getQuery("SELECT * FROM stage_queue WHERE userId = ? AND status = 'waiting'", [userId]);
  const queue = [];
  for (const e of q) {
    const pos = await getQuery("SELECT COUNT(*) AS n FROM stage_queue WHERE room_id = ? AND status = 'waiting' AND created <= ?", [e.room_id, e.created]);
    queue.push({ id: e.id, room_id: e.room_id, minutes: e.minutes, feature: !!e.feature, mode: e.mode, position: pos[0].n, created: e.created });
  }
  return { slots: rows.map((s) => view(s)), last: view(last), queue };
}

// ── bans ──
/** micfollow: a stage ban / unban re-checks that account's linked login on the 🎙 mic stage (never blocks the caller). */
function mfRecheck(userId) {
  try { require("./micfollow").recheckUser(userId).catch((e) => console.error("[stage] micfollow:", e.message)); } catch (e) { /* no mic follows */ }
}
async function ban(username, reason, actor) {
  await init();
  const u = (await getQuery("SELECT userId, username FROM users WHERE LOWER(username) = LOWER(?)", [String(username || "").trim()]))[0];
  if (!u) throw new Refuse(404, "No such user.");
  await runQuery("INSERT OR REPLACE INTO stage_bans (userId, username, reason, by, at) VALUES (?, ?, ?, ?, ?)",
                 [u.userId, u.username, String(reason || "").slice(0, 200), actor || null, now()]);
  await event(null, "ban", actor, u.username + (reason ? ": " + reason : ""));
  const open = await getQuery("SELECT id FROM stage_slots WHERE userId = ? AND status != 'ended'", [u.userId]);
  for (const s of open) await end(s.id, "banned", actor);
  await runQuery("UPDATE stage_queue SET status = 'left', done = ?, note = 'banned' WHERE userId = ? AND status = 'waiting'", [now(), u.userId]);
  mfRecheck(u.userId);                            // micfollow: a stage ban keeps them off the 🎙 mic stage too
  return u;
}
async function unban(userId, actor) {
  await init();
  const r = await runQuery("DELETE FROM stage_bans WHERE userId = ?", [String(userId || "")]);
  if (r.changes) { await event(null, "unban", actor, userId); mfRecheck(userId); }
  return r.changes > 0;
}
async function roomBan(roomId, who, reason, actor) {
  await init();
  const w = String(who || "").trim();
  let u = (await getQuery("SELECT userId, username FROM users WHERE LOWER(username) = LOWER(?)", [w]))[0];
  if (!u) u = await rooms.findUser(w);
  if (!u) throw new Refuse(404, "No such user.");
  const RS = await rooms.stageSettings(roomId);
  if (RS.owner && RS.owner.userId === u.userId) throw new Refuse(400, "That's the pad's owner.");
  await runQuery("INSERT OR REPLACE INTO stage_room_bans (room_id, userId, username, reason, by, at) VALUES (?, ?, ?, ?, ?, ?)",
                 [roomId, u.userId, u.username, String(reason || "").slice(0, 200), actor || null, now()]);
  await event(null, "room_ban", actor, u.username + (reason ? ": " + reason : ""), roomId);
  const open = await getQuery("SELECT id FROM stage_slots WHERE userId = ? AND room_id = ? AND status != 'ended'", [u.userId, roomId]);
  for (const s of open) await end(s.id, "banned", actor);
  await runQuery("UPDATE stage_queue SET status = 'left', done = ?, note = 'banned' WHERE userId = ? AND room_id = ? AND status = 'waiting'", [now(), u.userId, roomId]);
  mfRecheck(u.userId);
  return u;
}
async function roomUnban(roomId, userId, actor) {
  const r = await runQuery("DELETE FROM stage_room_bans WHERE room_id = ? AND userId = ?", [roomId, String(userId || "")]);
  if (r.changes) { await event(null, "room_unban", actor, userId, roomId); mfRecheck(userId); }
  return r.changes > 0;
}
async function roomBans(roomId) {
  await init();
  return getQuery("SELECT userId, username, reason, by, at FROM stage_room_bans WHERE room_id = ? ORDER BY at DESC", [roomId]);
}

async function adminState() {
  await init();
  const t = now();
  const open = (await openSlots()).map((s) => view(s, t));
  const upcoming = (await futureSlots()).map((s) => view(s, t));
  const log = (await getQuery("SELECT * FROM stage_slots ORDER BY created DESC LIMIT 50")).map((s) => view(s, t));
  const bans = await getQuery("SELECT userId, username, reason, by, at FROM stage_bans ORDER BY at DESC");
  const events = await getQuery("SELECT slot_id, ts, what, actor, detail, room_id FROM stage_events ORDER BY ts DESC LIMIT 60");
  return { config: config(), open, upcoming, log, bans, events, rtmp_app: RTMP_APP + " -> " + OUT_APP, relays: relays.size, pepe_src: pepeSource(),
           pepe_feature: CONFIG.pepe_feature, pepe_featured: !!pepeFeatured(t), now: t };   // 1.99lm
}
/** What a room owner sees on the manage page. */
async function ownerState(roomId) {
  await init();
  const t = now();
  const open = (await openSlots(roomId)).map((s) => view(s, t));
  const fut = (await futureSlots(roomId)).map((s) => view(s, t));
  const queue = (await queueFor(roomId)).map((e, i) => ({ id: e.id, position: i + 1, display: e.displayname || e.username, minutes: e.minutes,
    feature: !!e.feature, mode: e.mode, created: e.created }));
  const log = (await getQuery("SELECT * FROM stage_slots WHERE room_id = ? ORDER BY created DESC LIMIT 25", [roomId])).map((s) => view(s, t));
  const events = await getQuery("SELECT slot_id, ts, what, actor, detail FROM stage_events WHERE room_id = ? ORDER BY ts DESC LIMIT 30", [roomId]);
  return { open, requested: fut.filter((s) => s.status === "requested"), scheduled: fut.filter((s) => s.status === "scheduled"),
           queue, log, events, bans: await roomBans(roomId) };
}

// ── routes ──
let timers = null;
function start() {
  if (timers) return;
  init().then(() => reconcile()).then((n) => { if (n) console.log(`[stage] settled ${n} slot(s) left over from before the restart`); })
    .catch((e) => console.error("[stage] reconcile:", e.message));
  timers = [setInterval(() => tick().catch((e) => console.error("[stage] tick:", e.message)), TICK_MS),
            setInterval(sweepRelays, 5000)];
  for (const x of timers) x.unref();
}

function register(app, { addUser, isBotToken, noTimers }) {
  require("./userlinks").install(app);   // 1.99dt: <%- ul(name) %> in its views links names to profiles
  const express = require("express");
  if (!noTimers) start();
  require("./webrtc").register(app, { addUser, isBotToken, noTimers });   // 1.99et: WHIP auth hook, /api/turn, browser WHIP (flag webrtc_enabled); 1.99fd: Pepe's WHIP bearer (bot)
  const stageStaff = (u) => SP.can(u, "stage.admin");   // 1.99ack (siteperms.js): /stage/admin and its APIs
  const fail = (res, e) => {
    // stagefix: + the refusal's code when it has one (livecam's: "unavailable", "not_on_cam"... - the page words it)
    if (e && (e.refuse || (e.status && e.status < 500 && e.message))) return res.status(e.status).json({ ok: false, error: e.message, ...(e.code ? { code: e.code } : {}) });
    console.error("[stage]", e);
    res.status(500).json({ ok: false, error: "Something went wrong - nothing was charged." });
  };
  const needUser = (req, res, next) => (req.user && req.user.userId ? next() : res.status(401).json({ ok: false, error: "Sign in first." }));
  const needStaff = (req, res, next) => (stageStaff(req.user) ? next() : res.status(403).json({ ok: false, error: "Admins only." }));
  const actor = (req) => (req.user && req.user.username) || "?";
  // the slot's room: may this user run it (owner of that room, or staff)?
  const manages = async (req, s) => !!s && (await rooms.canManage(req.user, s.room_id || rooms.HOUSE_ROOM));
  const roomOf = async (v) => (v ? ((await rooms.bySlug(v)) || (await rooms.get(v))) : null);

  // nginx-rtmp: only straight from the box (no proxy headers = not through the public nginx)
  app.post("/api/stage/rtmp", async (req, res) => {
    const ra = req.socket.remoteAddress;
    if (!isLoopback(ra) || req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || req.headers["cf-connecting-ip"]) {
      return res.status(403).end();
    }
    try {
      const r = await rtmpCallback(req.body || {});
      if (r.status >= 300 && r.status < 400) return res.redirect(r.status, r.location);
      res.status(r.status).end();
    } catch (e) {
      console.error("[stage] rtmp callback:", e.message);
      res.status(500).end();
    }
  });

  // the "Go live" hub: pick a room, book now / later / join the queue, stream or embed
  const bookPage = async (req, res) => {
    await init();
    let me = null, twitchUrl = null;
    if (req.user && req.user.userId) {
      const hasLogin = await require("./twitchlogin").ensure();     // 1.99bu: the real Twitch login
      me = (await getQuery(`SELECT userId, username, displayname, points_balance, class, twitchId, twitchDisplayname${hasLogin ? ", twitchLogin" : ""}
                            FROM users WHERE userId = ?`, [req.user.userId]))[0] || null;
      // the link field suggests the signed-in user's OWN connected Twitch channel (server-rendered, no API)
      twitchUrl = embeds.twitchChannelUrl(me);
      if (me) { delete me.twitchId; delete me.twitchDisplayname; delete me.twitchLogin; }
    }
    // 1.99fu: an Approved pad (padaccess.js) is only offered to the people inside it
    const PA = require("./padaccess");
    await PA.init();
    const want = String(req.query.room || "");
    // S1 Q4 (review): the stage picker is a listing (no unlisted pads) - but ?room= naming an unlisted pad (its own page's
    // "Go live" link) offers that one pad, to the people who can see it
    const named = want ? rooms.getCached(want) || rooms.bySlugCached(want) : null;
    const listed = await rooms.list();
    const all = PA.visibleRows(req.user || null, named && named.listed === false && !rooms.isProfile(named.id) ? [named, ...listed] : listed);
    const pick = all.find((r) => r.slug === want || r.id === want) || all.find((r) => r.id === rooms.HOUSE_ROOM) || all[0] || null;
    // 1.99jn: 📼 Play from Plex (medialib.js): shown to admins + Plex users, locked for the rest; never breaks the page
    let plex = null;
    if (me) { try { plex = await require("./medialib").goLiveInfo({ userId: me.userId, username: me.username, class: me.class }); } catch (e) { plex = null; } }
    res.locals.og = { title: "Go live on PATV", description: "Stream to a pad's stage on publicaccess.tv - from OBS, your browser, or a YouTube/Twitch link. Slots are free on most pads.",
                      image: res.locals.ogBase + require("./og").pageUrl("Go live on PATV"), url: res.locals.ogBase + "/stage" };
    res.render("stageBook", { user: me ? me.username : null, me, C: config(), rtmpServer: RTMP_PUBLIC, staff: stageStaff(req.user),
                              rooms: all.map((r) => ({ id: r.id, slug: r.slug, title: r.title, slot_count: r.slot_count, slot_price: r.slot_price, approval: r.approval, house: r.house,
                                                       max_min: maxMinutesFor(r), library_max: libraryMaxFor(r),   // 1.99lw
                                                        owner: r.owner ? r.owner.display || r.owner.username : null })),
                              pick: pick ? pick.id : null, twitchUrl, plex });
  };
  app.get("/stage", addUser, bookPage);
  app.get("/stage/book", addUser, bookPage);

  app.get("/api/stage/me", addUser, needUser, async (req, res) => {
    try {
      const m = await mine(req.user.userId);
      const bal = (await getQuery("SELECT points_balance FROM users WHERE userId = ?", [req.user.userId]))[0];
      let R = await roomOf(String(req.query.room || ""));
      if (R && !(await seesPad(req.user, R.id))) R = null;              // 1.99fu: an Approved pad, to an outsider
      const roomInfo = R ? await roomStage(R.id, req.user) : null;
      const openMine = m.slots.find((s) => s.status === "waiting" || s.status === "active") || null;
      res.set("Cache-Control", "no-store");
      res.json({ ok: true, slot: openMine || m.last, slots: m.slots, queue: m.queue, config: config(), balance: bal ? bal.points_balance : 0,
                 banned: await isBanned(req.user.userId, R ? R.id : null), room: roomInfo, busy: roomInfo ? roomInfo.free < 1 : false });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/stage/book", addUser, needUser, async (req, res) => {
    try {
      const b = req.body || {};
      const R = await roomOf(b.room);
      if (b.room && (!R || !(await seesPad(req.user, R.id)))) throw new Refuse(404, "No such pad.");     // 1.99fu
      res.set("Cache-Control", "no-store");
      res.json({ ok: true, ...(await book(req.user, { ...b, room: R ? R.id : undefined })) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/stage/queue", addUser, needUser, async (req, res) => {
    try {
      const b = req.body || {};
      const R = await roomOf(b.room);
      if (!R || !(await seesPad(req.user, R.id))) throw new Refuse(404, "No such pad.");                  // 1.99fu
      res.json({ ok: true, ...(await joinQueue(req.user, { ...b, room: R.id })) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/stage/queue/:id/leave", addUser, needUser, async (req, res) => {
    try { res.json({ ok: await leaveQueue(req.user, req.params.id) }); } catch (e) { fail(res, e); }
  });

  app.post("/api/stage/slots/:id/end", addUser, needUser, async (req, res) => {
    try {
      const s = await getSlot(req.params.id);
      const own = s && s.userId === req.user.userId;
      if (!s || (!own && !(await manages(req, s)))) throw new Refuse(404, "No such slot.");
      const reason = own ? (["requested", "scheduled"].includes(s.status) ? "cancelled" : "owner_ended") : "cut";
      const r = await end(s.id, reason, actor(req));
      res.json({ ok: true, settled: r, slot: view(await getSlot(s.id)) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/stage/slots/:id/key", addUser, needUser, async (req, res) => {
    try { res.set("Cache-Control", "no-store"); res.json({ ok: true, ...(await regenKey(req.user, req.params.id)) }); } catch (e) { fail(res, e); }
  });
  // owner / staff controls on a slot in their room
  app.post("/api/stage/slots/:id/feature", addUser, needUser, async (req, res) => {
    try {
      const s = await getSlot(req.params.id);
      if (!(await manages(req, s))) throw new Refuse(403, "Only this pad's owner can feature slots.");
      res.json({ ok: true, ...(await featureByOwner(s.id, actor(req))) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/stage/slots/:id/unfeature", addUser, needUser, async (req, res) => {
    try {
      const s = await getSlot(req.params.id);
      if (!(await manages(req, s))) throw new Refuse(403, "Only this pad's owner can do that.");
      res.json({ ok: true, done: await unfeature(s.id, actor(req), "the pad owner unfeatured it") });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/stage/slots/:id/cut", addUser, needUser, async (req, res) => {
    try {
      const s = await getSlot(req.params.id);
      if (!(await manages(req, s))) throw new Refuse(403, "Only this pad's owner can cut slots.");
      const r = await end(s.id, "cut", actor(req));
      const b = req.body || {};
      if (b.ban && s.source !== "cam") await roomBan(s.room_id, s.username, b.reason || "cut from the stage", actor(req));   // 1.99zc: a cam slot's username is who put it up
      if (r && s.source !== "cam") rooms.notify(s.userId, { kind: "stage", title: "Your stage slot was cut", body: r.refund ? `${r.refund.toLocaleString("en-US")} PAT unused was refunded.` : "",
                                      link: "/stage", ref: "stage-cut:" + s.id, pm: false }).catch(() => {});
      res.json({ ok: true, settled: r });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/stage/slots/:id/approve", addUser, needUser, async (req, res) => {
    try {
      const s = await getSlot(req.params.id);
      if (!(await manages(req, s))) throw new Refuse(403, "Only this pad's owner can approve.");
      res.json({ ok: await approve(s.id, actor(req)) });
    } catch (e) { fail(res, e); }
  });
  // 1.99zc: 🎬 cam slots - the owner's list + "put on the stage" (rooms.canManage), and a stage viewer's WHEP ticket / beat
  const AG = require("./middleware/authGuard");
  const camFetchOnly = (req, res) => {
    if (req.get("X-Requested-With") !== "fetch" || !AG.sameSite(req)) { res.status(403).json({ ok: false, error: "Security check failed - reload the page." }); return false; }
    return true;
  };
  app.get("/api/rooms/:slug/stage/cams", addUser, needUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const R = await roomOf(req.params.slug);
      if (!R || !(await rooms.canManage(req.user, R.id))) throw new Refuse(403, "Only this pad's owner can do that.");
      res.json({ ok: true, ...(await camCandidates(R.id, req.user)) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/rooms/:slug/stage/cam", addUser, needUser, async (req, res) => {
    if (!camFetchOnly(req, res)) return;
    try {
      const R = await roomOf(req.params.slug);
      if (!R || !(await rooms.canManage(req.user, R.id))) throw new Refuse(403, "Only this pad's owner can put a cam on the stage.");
      res.json({ ok: true, ...(await camOpen(req.user, { room: R.id, login: (req.body || {}).login })) });
    } catch (e) { fail(res, e); }
  });
  const camHits = AG.limiter({ max: 40, windowMs: 60 * 1000 });
  app.post("/api/stage/slots/:id/cam", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!camFetchOnly(req, res)) return;
    try {
      if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, code: "signin", error: "Sign in to watch cams live." });
      const beatOnly = (req.body || {}).beat === true;
      if (!beatOnly) {
        const wait = camHits.blocked("u:" + req.user.userId);
        if (wait) { res.set("Retry-After", String(wait)); return res.status(429).json({ ok: false, code: "rate", error: "Slow down a little." }); }
        camHits.hit("u:" + req.user.userId);
      }
      const s = await getSlot(req.params.id);
      if (!s || s.source !== "cam" || s.settled || !["waiting", "active"].includes(s.status)) return res.json({ ok: true, state: "ended", why: "gone" });
      res.json(await LC().stageWatch(req.user, { id: s.room_id }, s.id, { beatOnly }));
    } catch (e) {
      if (e && e.refuse) return res.status(e.status).json({ ok: false, code: e.code, error: e.message });
      fail(res, e);
    }
  });
  app.post("/api/stage/slots/:id/deny", addUser, needUser, async (req, res) => {
    try {
      const s = await getSlot(req.params.id);
      if (!(await manages(req, s))) throw new Refuse(403, "Only this pad's owner can deny.");
      res.json({ ok: true, settled: await deny(s.id, actor(req), (req.body || {}).reason) });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/stage/slots/:id/relay", addUser, needUser,
    express.raw({ type: () => true, limit: RELAY_MAX_CHUNK }), async (req, res) => {
      try {
        const r = await relayChunk(req.user, req.params.id, req.query.seq, req.body);
        res.status(r.ok ? 200 : 409).json(r);
      } catch (e) { fail(res, e); }
    });

  // ── admin ──
  app.get("/stage/admin", addUser, async (req, res) => {
    if (!stageStaff(req.user)) return res.redirect("/login");
    let mf = null;     // micfollow: the 🎙 Mic follows card (micfollow.kill / micfollow.admin)
    if (SP.can(req.user, "micfollow.kill") || SP.can(req.user, "micfollow.admin")) { try { mf = await require("./micfollow").adminView(req.user); } catch (e) { mf = null; } }
    res.render("stageAdmin", { user: req.user.username, isAdmin: SP.can(req.user, "onair.config"), state: await adminState(), mf });
  });
  app.get("/api/stage/admin/state", addUser, needStaff, async (req, res) => {
    try { res.set("Cache-Control", "no-store"); res.json({ ok: true, ...(await adminState()) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stage/admin/config", addUser, needStaff, async (req, res) => {
    try { res.json({ ok: true, config: await setConfig(req.body || {}, actor(req)) }); } catch (e) { fail(res, e); }
  });
  // 1.99lm: ★ feature Pepe's stream (events): {on:false} | {minutes} | {from, until} (+ note)
  app.post("/api/stage/admin/pepe-feature", addUser, needStaff, async (req, res) => {
    try { res.json({ ok: true, pepe_feature: await setPepeFeature(req.body || {}, actor(req)), pepe_featured: !!pepeFeatured() }); } catch (e) { fail(res, e); }
  });
  // 1.99lm: cancel a slot's auto-feature (it stays on as an ordinary slot and isn't auto-featured again)
  app.post("/api/stage/admin/autofeature/cancel", addUser, needStaff, async (req, res) => {
    try { res.json({ ok: true, ...(await cancelAutoFeature((req.body || {}).id, actor(req))) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stage/admin/cut", addUser, needStaff, async (req, res) => {
    try {
      const b = req.body || {};
      const ids = b.id ? [String(b.id)] : (await openSlots(b.room || undefined)).map((s) => s.id);
      const out = [];
      for (const id of ids) { const r = await end(id, "cut", actor(req)); if (r) out.push(r); }
      if (b.ban && ids.length === 1) {
        const s = await getSlot(ids[0]);
        if (s) await ban(s.username, b.reason || "cut from the stage", actor(req));
      }
      res.json({ ok: true, cut: out.length });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/stage/admin/ban", addUser, needStaff, async (req, res) => {
    try { const u = await ban((req.body || {}).username, (req.body || {}).reason, actor(req)); res.json({ ok: true, username: u.username }); }
    catch (e) { fail(res, e); }
  });
  app.post("/api/stage/admin/unban", addUser, needStaff, async (req, res) => {
    try { res.json({ ok: await unban((req.body || {}).userId, actor(req)) }); } catch (e) { fail(res, e); }
  });
  // Pepe ("!stage cut"): cut open slots back to Pepe's stream - every room, or {room} only (1.99bi)
  app.post("/api/stage/cut", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ error: "unauthorized" });
    try {
      let n = 0;
      const room = b.room ? String(b.room) : null;
      for (const s of await openSlots(room || undefined)) if (await end(s.id, "cut", "pepe:" + String(b.by || "bot").slice(0, 40))) n++;
      res.json({ ok: true, cut: n });
    } catch (e) { fail(res, e); }
  });
}

module.exports = {
  register, start, init, book, end, tick, reconcile, rtmpCallback, relayChunk, stopRelay, publicSlots, adminState, ownerState,
  setConfig, config, ban, unban, roomBan, roomUnban, roomBans, getSlot, view, chargeFor, billedMinutes, deadline, isLive, relayKey, parseRelayKey,
  unfeature, featureByOwner, purgePaidFeaturing, approve, deny, joinQueue, leaveQueue, queueFor, roomStage, roomSchedule, guide, mine, regenKey, openSlots, futureSlots,
  isBanned, seesPad, Refuse, RTMP_APP, OUT_APP, STREAM_PREFIX, DEFAULTS, RTMP_PUBLIC,
  libraryOpen, libraryExtend, libraryRetitle, libraryRekey, libraryActivate, setLibraryIdle, idleMinFor, maxMinutesFor, libraryMaxFor, limitsFor,
  publishGate, goLive, whipBeat, openSlotByStream, hlsOf, playUrlOf, whipRelayed, RTMP_PLAY, OUT_LOCAL, pubKey, clearCache: () => pubCache.clear(),
  camOpen, camBeat, camCandidates, slotsFor,
  pepeSource, pepePlayer, pepeEmbedFrom, pepeTwitchChannel,
  autoFeature, autoFeatureAll, cancelAutoFeature, pepeFeatured, setPepeFeature, takeoverModeFor, TAKEOVER_MODES,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _setSpawn: (fn) => { spawnImpl = fn; },
  _relays: relays, _clients: clients, _lastTick: lastTick, _pubCache: pubCache, _tx: tx,
};
