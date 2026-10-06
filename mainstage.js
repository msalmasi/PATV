// mainstage.js — room stages: user stream slots per room, featuring, scheduling, a queue (1.99al, 1.99bi).
//
// Every Camfrog room on PATV has a STAGE: Pepe's stream (always there) plus N user SLOTS that people
// stream to (the room owner sets N, default 1; rooms.js). Viewers switch freely between a room's live
// slots and Pepe's stream. One slot per room can be FEATURED - it becomes the room's default stream
// (and the homepage's, when that room is the front room):
//   - the room owner (or site staff) features any open slot, free;
//   - or, while nothing is featured, a user PAYS to be featured: the original 1.99al take-over, now
//     per room - PAT held up front, billed per live minute, the rest refunded on every exit path.
//
// Slot kinds:
//   feature  a paid featured booking (book with feature=true; the old API default). Price = the global
//            price_per_min. It stays featured until it ends, unless the owner/staff unfeature it - then
//            the unused hold is refunded right away and it carries on as an ordinary slot for free.
//   slot     an ordinary slot. Price = the room's slot_price (default 0 = free; the owner may charge up
//            to the featured price). A FREE slot can be upgraded to featured by its streamer while
//            nothing is featured ("feature me": a hold for N minutes at the featured price, billed only
//            from that moment; when those minutes are used up it quietly stops being featured).
// Sources: an RTMP key (OBS…), the browser (MediaRecorder relay), or an EMBED - a YouTube video/live or
// Twitch channel/VOD (stageembed.js: parsed to {p,t,id}, rendered only with the official players). An
// embed slot is "live" from the moment it opens (we can't see inside YouTube/Twitch).
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
// `settled = 0`, that refunds held - charged to the user and books the charged part as revenue:
// "reserve" (default) = a NEGATIVE reserve_claims row, flow "stage_slot", which Pepe's funding tick
// credits to the Federal Reserve, or "jackpot" = a jackpot_rakes row. In the same transaction the
// room owner's royalty share is ACCRUED (royalties.js - released later by the Reserve, never minted).
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
const rooms = require("./rooms");
const embeds = require("./stageembed");

const STAGING = !!process.env.STAGING;
const RTMP_APP = process.env.STAGE_RTMP_APP || (STAGING ? "stage_staging" : "stage");   // ingest
const OUT_APP = process.env.STAGE_OUT_APP || (STAGING ? "live_staging" : "live");         // HLS
const RTMP_PUBLIC = process.env.STAGE_RTMP_URL || `rtmp://stream.publicaccess.tv/${RTMP_APP}`;
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
  price_per_min: 1000,     // PAT per started live minute of PAID FEATURING (and the cap on a room's slot price)
  min_minutes: 5,
  max_minutes: 60,
  max_concurrent: 6,       // user streams open at the same time, site-wide (server/bandwidth guard)
  max_slots_per_room: 4,   // the most slots an owner can give a room
  revenue_vault: "reserve", // "reserve" (Federal Reserve) | "jackpot" (casino pot)
  start_window_min: 10,    // must go live within this long of the slot opening, or it's refunded in full
  idle_grace_min: 5,       // after going live, ends if the stream is down this long
  bookings_per_hour: 3,    // per user
  schedule_days: 14,       // how far ahead slots can be booked
  schedule_per_user: 3,    // future bookings one user can hold
  lead_min: 5,             // a scheduled slot opens (key works) this long before its start
  queue_max: 10,           // people waiting per room
};
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
      await addColumn("stage_slots", "kind", "TEXT");                 // feature | slot
      await addColumn("stage_slots", "featured", "INTEGER NOT NULL DEFAULT 0");
      await addColumn("stage_slots", "feature_by", "TEXT");           // paid | owner
      await addColumn("stage_slots", "mode", "TEXT");                 // stream | embed
      await addColumn("stage_slots", "embed", "TEXT");                // JSON {p,t,id}
      await addColumn("stage_slots", "start_at", "INTEGER");
      await addColumn("stage_slots", "bill_base_ms", "INTEGER NOT NULL DEFAULT 0");
      await addColumn("stage_slots", "title", "TEXT");
      await addColumn("stage_slots", "approved_by", "TEXT");
      await addColumn("stage_slots", "notified", "INTEGER NOT NULL DEFAULT 0");
      await runQuery(`UPDATE stage_slots SET room_id = ?, kind = COALESCE(kind, 'feature'), mode = COALESCE(mode, 'stream'),
                      start_at = COALESCE(start_at, created), featured = CASE WHEN status != 'ended' THEN 1 ELSE featured END,
                      feature_by = CASE WHEN status != 'ended' THEN 'paid' ELSE feature_by END
                      WHERE room_id IS NULL`, [rooms.HOUSE_ROOM]);
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
      await loadConfig();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

let CONFIG = { ...DEFAULTS };
async function loadConfig() {
  const rows = await getQuery("SELECT key, value FROM stage_config");
  const c = { ...DEFAULTS };
  for (const r of rows) { try { if (r.key in DEFAULTS) c[r.key] = JSON.parse(r.value); } catch (e) { /* skip */ } }
  CONFIG = cleanConfig(c);
  return CONFIG;
}
function cleanConfig(c) {
  const int = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const o = {
    enabled: c.enabled === true || c.enabled === "true" || c.enabled === 1 || c.enabled === "1" || c.enabled === "on",
    price_per_min: int(c.price_per_min, 1, 10000000, DEFAULTS.price_per_min),
    min_minutes: int(c.min_minutes, 1, 600, DEFAULTS.min_minutes),
    max_minutes: int(c.max_minutes, 1, 600, DEFAULTS.max_minutes),
    max_concurrent: int(c.max_concurrent, 0, 32, DEFAULTS.max_concurrent),
    max_slots_per_room: int(c.max_slots_per_room, 1, 8, DEFAULTS.max_slots_per_room),
    revenue_vault: c.revenue_vault === "jackpot" ? "jackpot" : "reserve",
    start_window_min: int(c.start_window_min, 1, 120, DEFAULTS.start_window_min),
    idle_grace_min: int(c.idle_grace_min, 1, 60, DEFAULTS.idle_grace_min),
    bookings_per_hour: int(c.bookings_per_hour, 1, 100, DEFAULTS.bookings_per_hour),
    schedule_days: int(c.schedule_days, 0, 60, DEFAULTS.schedule_days),
    schedule_per_user: int(c.schedule_per_user, 0, 20, DEFAULTS.schedule_per_user),
    lead_min: int(c.lead_min, 0, 30, DEFAULTS.lead_min),
    queue_max: int(c.queue_max, 0, 50, DEFAULTS.queue_max),
  };
  if (o.max_minutes < o.min_minutes) o.max_minutes = o.min_minutes;
  return o;
}
async function setConfig(patch, actor) {
  await init();
  const next = cleanConfig({ ...CONFIG, ...(patch || {}) });
  for (const k of Object.keys(DEFAULTS)) {
    await runQuery("INSERT INTO stage_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                   [k, JSON.stringify(next[k])]);
  }
  CONFIG = next;
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

// ── transactions: one at a time on the shared connection, retried if another module's is open ──
let _chain = Promise.resolve();
function serial(fn) {
  const run = _chain.then(() => fn(), () => fn());
  _chain = run.catch(() => {});
  return run;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tx(fn) {
  return serial(async () => {
    for (let i = 0; ; i++) {
      try { await runQuery("BEGIN IMMEDIATE TRANSACTION"); break; } catch (e) {
        if (i >= 40 || !/within a transaction|SQLITE_BUSY|locked/i.test(e.message)) throw e;
        await sleep(50);
      }
    }
    try {
      const out = await fn();
      await runQuery("COMMIT");
      return out;
    } catch (e) {
      try { await runQuery("ROLLBACK"); } catch (_) { /* nothing open */ }
      throw e;
    }
  });
}

// ── keys ──
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
function newKey() { return "ps" + crypto.randomBytes(30).toString("base64url"); }   // 42 chars
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
  const billable = Math.max(0, (Number(liveMs) || 0) - (Number(slot.bill_base_ms) || 0));
  return Math.min(slot.held, Math.min(billedMinutes(billable), slot.max_minutes) * slot.price_per_min);
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

// ── book ──
// opts: {room, minutes, feature (default true = the 1.99al take-over), mode: stream|embed, embed: url,
//        title, start_at (ms; omitted / now = right now)}
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
  if (!Number.isFinite(minutes) || minutes < C.min_minutes || minutes > C.max_minutes) {
    throw new Refuse(400, `Pick between ${C.min_minutes} and ${C.max_minutes} minutes.`);
  }
  if (await isBanned(user.userId, roomId)) throw new Refuse(403, "You can't book the stage.");
  const feature = opts.feature === undefined ? true : truthy(opts.feature);
  const mode = opts.mode === "embed" ? "embed" : "stream";
  let embed = null;
  if (mode === "embed") {
    try { embed = embeds.parse(opts.embed); } catch (e) { throw new Refuse(400, e.message); }
  }
  const title = cleanTitle(opts.title);
  const t = now();
  let startAt = Number(opts.start_at) || 0;
  const scheduled = startAt > t + 60 * 1000;
  if (scheduled) {
    startAt = Math.floor(startAt / 60000) * 60000;
    if (C.schedule_days < 1 || startAt > t + C.schedule_days * 86400000) throw new Refuse(400, `Book up to ${C.schedule_days} days ahead.`);
  } else startAt = t;
  const price = feature ? C.price_per_min : Math.min(C.price_per_min, RS.slot_price || 0);
  const hold = minutes * price;
  const staffOrOwner = rooms.isStaff(user) || !!(RS.owner && RS.owner.userId === user.userId);
  const needsApproval = scheduled && !!RS.approval && !staffOrOwner;
  const key = mode === "stream" ? newKey() : null;
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
      if (feature && open.some((s) => s.featured)) throw new Refuse(409, "Someone is featured in this pad right now - book an ordinary slot, or join the queue.");
      if (feature && overlapping(fut.filter((s) => s.featured), startAt, until).length) throw new Refuse(409, "A featured slot is booked soon - pick a later time.");
    } else {
      const mine = await getQuery(`SELECT COUNT(*) AS n FROM stage_slots WHERE userId = ? AND status IN ${FUTURE}`, [user.userId]);
      if (mine[0].n >= C.schedule_per_user) throw new Refuse(429, `You can hold ${C.schedule_per_user} upcoming bookings at once.`);
      const clash = overlapping(open.concat(fut), startAt, until);
      if (clash.some((s) => s.userId === user.userId)) throw new Refuse(409, "You already have a booking then.");
      if (clash.length >= RS.slot_count) throw new Refuse(409, "Every slot in this pad is booked then - pick another time.");
      if (feature && clash.some((s) => s.featured)) throw new Refuse(409, "Someone is already featured then - pick another time or book an ordinary slot.");
    }
    const recent = await getQuery("SELECT COUNT(*) AS n FROM stage_slots WHERE userId = ? AND created > ?", [user.userId, t - 3600 * 1000]);
    if (recent[0].n >= C.bookings_per_hour) throw new Refuse(429, "You've booked the stage a lot this hour - try again later.");
    const u = (await getQuery("SELECT username, displayname FROM users WHERE userId = ?", [user.userId]))[0];
    if (!u) throw new Refuse(404, "Couldn't find your account.");
    if (hold > 0) {
      const paid = await runQuery("UPDATE users SET points_balance = points_balance - ? WHERE userId = ? AND points_balance >= ?",
                                  [hold, user.userId, hold]);
      if (!paid.changes) throw new Refuse(402, `A ${minutes}-minute ${feature ? "featured " : ""}slot holds ${hold.toLocaleString("en-US")} PAT - you don't have enough.`);
      await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
                     [uuidv4(), user.userId, `stage ${feature ? "feature" : "slot"} hold (${minutes} min max)`, -hold]);
    }
    const stream = STREAM_PREFIX + crypto.randomBytes(8).toString("hex");
    const status = needsApproval ? "requested" : scheduled ? "scheduled" : (mode === "embed" ? "active" : "waiting");
    await runQuery(`INSERT INTO stage_slots (id, userId, username, displayname, status, created, max_minutes, price_per_min, held,
                    key_hash, stream, revenue_vault, room_id, kind, featured, feature_by, mode, embed, start_at, title, went_live, last_live)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                   [id, user.userId, u.username, u.displayname || u.username, status, t, minutes, price, hold, key ? sha(key) : null, stream,
                    C.revenue_vault, roomId, feature ? "feature" : "slot", feature ? 1 : 0, feature ? "paid" : null, mode,
                    embed ? JSON.stringify(embed) : null, startAt, title,
                    status === "active" ? t : null, status === "active" ? t : null]);
    return { id, status };
  });
  pubCache.clear();
  await event(out.id, scheduled ? (needsApproval ? "requested" : "scheduled") : "booked", user.username,
              `${feature ? "featured " : ""}${minutes} min, held ${hold}${mode === "embed" ? ", " + embeds.label(embed) : ""}${scheduled ? ", starts " + new Date(startAt).toISOString() : ""}`, roomId);
  if (needsApproval && RS.owner) {
    rooms.notify(RS.owner.userId, { kind: "stage", title: `${user.username || "Someone"} asked for a stage slot in ${RS.title}`,
      body: `${minutes} min${feature ? ", featured" : ""} on ${new Date(startAt).toUTCString()}. Approve or deny it on your pad page.`,
      link: `/p/${encodeURIComponent(RS.slug)}/manage`, ref: "stage-req:" + out.id }).catch(() => {});
  }
  const slot = await getSlot(out.id);
  return { slot: view(slot), key, rtmp: key ? { server: RTMP_PUBLIC, key } : null };
}

// ── settle: the ONLY place money comes back out of a slot ──
async function end(slotId, reason, actor) {
  await init();
  const res = await tx(async () => {
    const s = (await getQuery("SELECT * FROM stage_slots WHERE id = ?", [String(slotId || "")]))[0];
    if (!s || s.settled) return null;
    const charged = chargeFor(s, s.live_ms);
    const refund = s.held - charged;
    const r = await runQuery(`UPDATE stage_slots SET status = 'ended', settled = 1, charged = ?, refunded = ?, ended = ?,
                              end_reason = ?, ended_by = ?, key_hash = NULL, publishing = 0, featured = 0 WHERE id = ? AND settled = 0`,
                             [charged, refund, now(), String(reason || "ended"), actor || null, s.id]);
    if (!r.changes) return null;
    if (refund > 0) {
      await runQuery("UPDATE users SET points_balance = points_balance + ? WHERE userId = ?", [refund, s.userId]);
      await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
                     [uuidv4(), s.userId, `stage slot refund (${billedMinutes(s.live_ms)} of ${s.max_minutes} min used)`, refund]);
    }
    if (charged > 0) {
      if (s.revenue_vault === "jackpot") {
        await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)", [uuidv4(), null, s.userId, charged]);
      } else {
        await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES (?, ?, ?, ?, ?)",
                       [uuidv4(), "stage_slot", s.userId, `stage slot ${s.id.slice(0, 8)}: ${billedMinutes(s.live_ms)} min`, -charged]);
      }
      // the room owner's royalty share: accrued here, released by the Reserve later (royalties.js)
      await require("./royalties").accrue({ room_id: s.room_id, source: "stage", base: charged, payer: s.userId,
                                            ref: "stage:" + s.id, detail: `${s.displayname || s.username}: ${billedMinutes(s.live_ms)} min` });
    }
    return { id: s.id, charged, refund, userId: s.userId, room_id: s.room_id, status: s.status };
  });
  if (res) {
    stopRelay(res.id);
    for (const [cid, sid] of clients) if (sid === res.id) clients.delete(cid);
    lastTick.delete(res.id);
    pubCache.clear();
    await event(res.id, "ended", actor, `${reason}: charged ${res.charged}, refunded ${res.refund}`, res.room_id);
  }
  return res;
}

// ── featuring ──
// Stop paid featuring now: charge what was used, refund the rest of the hold right away (held = charged,
// so it can't bill any more), and the slot carries on unfeatured.
async function unfeature(slotId, actor, why = "unfeatured") {
  await init();
  const res = await tx(async () => {
    const s = (await getQuery(`SELECT * FROM stage_slots WHERE id = ? AND settled = 0`, [String(slotId || "")]))[0];
    if (!s || !s.featured) return null;
    let refund = 0;
    if (s.feature_by === "paid") {
      const charged = chargeFor(s, s.live_ms);
      refund = s.held - charged;
      await runQuery("UPDATE stage_slots SET held = ?, charged = ? WHERE id = ? AND settled = 0", [charged, charged, s.id]);
      if (refund > 0) {
        await runQuery("UPDATE users SET points_balance = points_balance + ? WHERE userId = ?", [refund, s.userId]);
        await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
                       [uuidv4(), s.userId, `stage feature refund (${why})`, refund]);
      }
    }
    await runQuery("UPDATE stage_slots SET featured = 0, feature_by = NULL WHERE id = ?", [s.id]);
    return { id: s.id, refund, room_id: s.room_id, userId: s.userId, paid: s.feature_by === "paid" };
  });
  if (res) { pubCache.clear(); await event(res.id, "unfeatured", actor, `${why}, refunded ${res.refund}`, res.room_id); }
  return res;
}
// The owner / staff feature an open slot (free). Whatever was featured in that room stops being so.
async function featureByOwner(slotId, actor) {
  await init();
  const s = await getSlot(slotId);
  if (!s || s.settled || !["waiting", "active", "scheduled"].includes(s.status)) throw new Refuse(404, "That slot isn't open.");
  if (s.featured) return { already: true };
  const others = await getQuery(`SELECT id FROM stage_slots WHERE room_id = ? AND featured = 1 AND settled = 0 AND id != ? AND status IN ${OPEN}`, [s.room_id, s.id]);
  for (const o of others) await unfeature(o.id, actor, "the owner featured another slot");
  await runQuery("UPDATE stage_slots SET featured = 1, feature_by = 'owner' WHERE id = ? AND settled = 0", [s.id]);
  pubCache.clear();
  await event(s.id, "featured", actor, "by the pad owner", s.room_id);
  rooms.notify(s.userId, { kind: "stage", title: "You're featured on the stage", body: "The pad owner featured your slot - it's the pad's main stream now.",
    link: "/stage", ref: "featured:" + s.id + ":" + now(), pm: false }).catch(() => {});
  return { ok: true };
}
// A streamer pays to feature their own FREE open slot (nothing else featured in the room).
async function upgrade(user, slotId, minutes) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const C = CONFIG;
  const s0 = await getSlot(slotId);
  if (!s0 || s0.userId !== user.userId || s0.settled || !["waiting", "active"].includes(s0.status)) throw new Refuse(404, "That isn't your open slot.");
  if (s0.featured) throw new Refuse(409, "You're already featured.");
  if (s0.price_per_min > 0) throw new Refuse(409, "This pad charges for slots - book a featured slot instead.");
  const left = Math.max(1, s0.max_minutes - billedMinutes(s0.live_ms));
  const m = Math.min(left, Math.max(1, Math.floor(Number(minutes) || left)));
  const hold = m * C.price_per_min;
  await tx(async () => {
    const s = (await getQuery("SELECT * FROM stage_slots WHERE id = ? AND settled = 0", [s0.id]))[0];
    if (!s || s.featured) throw new Refuse(409, "Someone is featured already.");
    const f = await getQuery(`SELECT 1 FROM stage_slots WHERE room_id = ? AND featured = 1 AND status IN ${OPEN}`, [s.room_id]);
    if (f.length) throw new Refuse(409, "Someone is featured in this pad right now.");
    const paid = await runQuery("UPDATE users SET points_balance = points_balance - ? WHERE userId = ? AND points_balance >= ?", [hold, user.userId, hold]);
    if (!paid.changes) throw new Refuse(402, `Featuring for ${m} min holds ${hold.toLocaleString("en-US")} PAT - you don't have enough.`);
    await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
                   [uuidv4(), user.userId, `stage feature hold (${m} min max)`, -hold]);
    await runQuery(`UPDATE stage_slots SET featured = 1, feature_by = 'paid', price_per_min = ?, held = ?, bill_base_ms = live_ms
                    WHERE id = ? AND settled = 0`, [C.price_per_min, hold, s.id]);
  });
  pubCache.clear();
  await event(s0.id, "featured", user.username, `paid upgrade ${m} min, held ${hold}`, s0.room_id);
  return view(await getSlot(s0.id));
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
  if (!Number.isFinite(minutes) || minutes < C.min_minutes || minutes > C.max_minutes) throw new Refuse(400, `Pick between ${C.min_minutes} and ${C.max_minutes} minutes.`);
  if (await isBanned(user.userId, roomId)) throw new Refuse(403, "You can't book the stage.");
  const mode = opts.mode === "embed" ? "embed" : "stream";
  let embed = null;
  if (mode === "embed") { try { embed = embeds.parse(opts.embed); } catch (e) { throw new Refuse(400, e.message); } }
  const feature = truthy(opts.feature);
  if ((await getQuery("SELECT 1 FROM stage_queue WHERE userId = ? AND status = 'waiting'", [user.userId])).length) throw new Refuse(409, "You're already in a queue.");
  if ((await getQuery(`SELECT 1 FROM stage_slots WHERE userId = ? AND status IN ${OPEN}`, [user.userId])).length) throw new Refuse(409, "You already have a stage slot.");
  const n = await getQuery("SELECT COUNT(*) AS n FROM stage_queue WHERE room_id = ? AND status = 'waiting'", [roomId]);
  if (n[0].n >= C.queue_max) throw new Refuse(409, "The queue is full - try again later.");
  const u = (await getQuery("SELECT username, displayname FROM users WHERE userId = ?", [user.userId]))[0];
  if (!u) throw new Refuse(404, "Couldn't find your account.");
  const id = uuidv4();
  await runQuery(`INSERT INTO stage_queue (id, room_id, userId, username, displayname, minutes, feature, mode, embed, title, created)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                 [id, roomId, user.userId, u.username, u.displayname || u.username, minutes, feature ? 1 : 0, mode,
                  embed ? JSON.stringify(embed) : null, cleanTitle(opts.title), now()]);
  await event(null, "queued", u.username, `${minutes} min${feature ? " featured" : ""}`, roomId);
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
      // a paid upgrade of a free slot that has used its featured minutes: quietly unfeatured
      if (s.kind === "slot" && s.featured && s.feature_by === "paid" && s.held > 0 && chargeFor(s, liveMs) >= s.held) {
        await runQuery("UPDATE stage_slots SET featured = 0, feature_by = NULL WHERE id = ? AND settled = 0", [s.id]);
        pubCache.clear();
        await event(s.id, "unfeatured", "system", "featured minutes used up", s.room_id);
      }
      let why = null;
      if (liveMs >= s.max_minutes * 60000) why = "time_up";
      else if (s.status === "waiting" && t - startOf(s) > C.start_window_min * 60000) why = "never_live";
      else if (s.status === "active" && !isEmbed(s) && !live && t - (s.last_live || s.went_live || startOf(s)) > C.idle_grace_min * 60000) why = "idle";
      else if (t > deadline(s, C)) why = "deadline";
      if (why) await end(s.id, why, "system");
    } catch (e) {
      console.error("[stage] tick:", e.message);
    }
  }
  try { await tickFuture(t); } catch (e) { console.error("[stage] schedule:", e.message); }
  try { await tickQueue(t); } catch (e) { console.error("[stage] queue:", e.message); }
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
      if (t < start) continue;
      // a featured booking's start beats the owner's free pick; a PAID featured stream keeps its spot
      const f = open.find((x) => x.featured);
      if (f.feature_by === "owner") await unfeature(f.id, "system", "a booked featured slot started");
      else continue;
    }
    const embed = isEmbed(s);
    const r = await runQuery(`UPDATE stage_slots SET status = ?, went_live = CASE WHEN ? THEN ? ELSE went_live END,
                              last_live = CASE WHEN ? THEN ? ELSE last_live END, notified = 2 WHERE id = ? AND status = 'scheduled'`,
                             [embed ? "active" : "waiting", embed ? 1 : 0, t, embed ? 1 : 0, t, s.id]);
    if (r.changes) {
      pubCache.clear();
      await event(s.id, "opened", "system", "scheduled", s.room_id);
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
      const wantFeature = !!head.feature && !open.some((x) => x.featured);
      let res = null, err = null;
      try {
        res = await book({ userId: head.userId, username: head.username }, {
          room: roomId, minutes: head.minutes, feature: wantFeature, mode: head.mode,
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
  const name = String(f.name || "");
  const app = String(f.app || "");
  const cid = String(f.clientid || "") + "@" + app;
  const t = now();
  if (call === "play" || call === "update_play" || call === "play_done") return { status: 200 };

  // ── the HLS application: Pepe's key, and the local pushes of open slots ──
  if (app === OUT_APP) {
    if (PEPE_KEYS.has(name)) return { status: 200 };
    if (call === "publish_done") return { status: 200 };
    if (!name.startsWith(STREAM_PREFIX)) return { status: 403 };
    if (call === "publish" && !isLoopback(f.addr)) return { status: 403 };
    const s = (await getQuery(`SELECT * FROM stage_slots WHERE stream = ? AND status IN ${OPEN}`, [name]))[0];
    if (!s || s.settled || isEmbed(s)) return { status: 403 };
    return { status: 200 };
  }
  if (app !== RTMP_APP) return { status: 403 };

  // ── the ingest application: slot keys + relay keys ──
  if (call === "publish") {
    let s = null;
    const relayFor = parseRelayKey(name);
    if (relayFor) {
      if (!isLoopback(f.addr)) return { status: 403 };
      s = await getSlot(relayFor);
    } else if (name && !name.startsWith(STREAM_PREFIX)) {
      s = (await getQuery(`SELECT * FROM stage_slots WHERE key_hash = ? AND status IN ${OPEN}`, [sha(name)]))[0] || null;
    }
    if (!s || !["waiting", "active"].includes(s.status) || s.settled || isEmbed(s) || t > deadline(s)) return { status: 403 };
    if (await isBanned(s.userId, s.room_id)) return { status: 403 };
    const r = await runQuery(`UPDATE stage_slots SET publishing = 1, beat = ?, status = 'active',
                              went_live = COALESCE(went_live, ?), last_live = ? WHERE id = ? AND settled = 0`, [t, t, t, s.id]);
    if (!r.changes) return { status: 403 };
    clients.set(cid, s.id);
    pubCache.clear();
    if (!s.went_live) event(s.id, "live", s.username, relayFor ? "browser" : "rtmp", s.room_id);
    return { status: 302, location: `${OUT_LOCAL}/${s.stream}` };
  }

  if (call === "update_publish" || call === "publish_done") {
    const s = clients.has(cid) ? await getSlot(clients.get(cid)) : await slotByName(name);
    if (!s) return { status: call === "publish_done" ? 200 : 403 };
    if (call === "publish_done") {
      clients.delete(cid);
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
  return { key, rtmp: { server: RTMP_PUBLIC, key } };
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
    stream: s.stream, hls: `${HLS_BASE}/${s.stream}.m3u8`, relay: relays.has(s.id),
    start_at: startOf(s), start_by: startOf(s) + CONFIG.start_window_min * 60000,
    opens_at: isEmbed(s) ? startOf(s) : startOf(s) - CONFIG.lead_min * 60000,
    room_id: s.room_id || rooms.HOUSE_ROOM, kind: s.kind || "feature", featured: !!s.featured, feature_by: s.feature_by || null,
    mode: s.mode || "stream", embed: e, embed_label: e ? embeds.label(e) : null, title: s.title || null,
    bill_base_seconds: Math.floor((s.bill_base_ms || 0) / 1000),
    // 1.99cr (stagecap.js): may viewers snap / clip this slot (its streamer's choice, default yes), is it NSFW
    capture: !s.capture_off && !isEmbed(s), nsfw: !!s.nsfw,
  };
}
// What a stage shows: the slots live right now in a room (cached briefly; pages poll it).
const pubCache = new Map();   // room id ("" = every room) -> {at, list}
async function publicSlots(roomId) {
  const k = String(roomId || "");
  const c = pubCache.get(k);
  if (c && Date.now() - c.at < 2000) return c.list;
  const t = now();
  let nameStyle = () => "";
  try { nameStyle = require("./cosmetics").nameStyle; } catch (e) { /* no cosmetics */ }
  const list = (await openSlots(roomId || undefined)).filter((s) => isLive(s, t)).map((s) => {
    const e = embedOf(s);
    return {
      id: s.id, username: s.username, display: s.displayname || s.username, nameCss: nameStyle(s.username) || "",
      hls: e ? null : `${HLS_BASE}/${s.stream}.m3u8`, embed: e, since: s.went_live, room_id: s.room_id,
      featured: !!s.featured, feature_by: s.feature_by || null, title: s.title || null, mode: s.mode || "stream",
      capture: !e && !s.capture_off, nsfw: !!s.nsfw,     // 1.99cr: the stage's Snap / Clip buttons (stagecap.js)
    };
  }).sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || (a.since || 0) - (b.since || 0));
  pubCache.set(k, { at: Date.now(), list });
  return list;
}
/** One room's stage for its pages: live slots, capacity, upcoming bookings, the queue. */
async function roomStage(roomId, viewer) {
  await init();
  const RS = await rooms.stageSettings(roomId);
  const t = now();
  const open = await openSlots(roomId);
  const live = await publicSlots(roomId);
  const fut = (await futureSlots(roomId)).filter((s) => s.status === "scheduled");
  const q = await queueFor(roomId);
  const mine = viewer && viewer.userId ? q.findIndex((x) => x.userId === viewer.userId) : -1;
  const featured = open.find((s) => s.featured) || null;
  return {
    room: { id: roomId, slug: RS.slug, title: RS.title, slot_count: RS.slot_count, slot_price: RS.slot_price, approval: RS.approval },
    slots: live, open: open.length, free: Math.max(0, RS.slot_count - open.length),
    featured: featured ? { id: featured.id, display: featured.displayname || featured.username, live: isLive(featured, t), by: featured.feature_by } : null,
    upcoming: fut.slice(0, 6).map((s) => ({ id: s.id, display: s.displayname || s.username, start_at: startOf(s), minutes: s.max_minutes,
      featured: !!s.featured, title: s.title || null, mode: s.mode || "stream" })),
    queue: { length: q.length, position: mine >= 0 ? mine + 1 : null, entry: mine >= 0 ? q[mine].id : null },
    price: CONFIG.price_per_min, enabled: CONFIG.enabled && CONFIG.max_concurrent > 0,
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
  const open = await openSlots(roomId);
  const fut = await futureSlots(roomId);
  const q = await queueFor(roomId);
  const row = (s) => {
    const e = embedOf(s);
    return { display: s.displayname || s.username, title: s.title || null, featured: !!s.featured, mode: isEmbed(s) ? "embed" : "stream",
             embed_label: e ? embeds.label(e) : null, minutes: s.max_minutes, mine: !!me && s.userId === me };
  };
  const live = open.map((s) => ({ ...row(s), live: isLive(s, t), since: s.went_live || null, start_at: startOf(s),
                                  ends_by: (s.went_live || startOf(s)) + s.max_minutes * 60000 }))
    .sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0) || (b.live ? 1 : 0) - (a.live ? 1 : 0) || (a.since || a.start_at) - (b.since || b.start_at));
  const upcoming = fut.filter((s) => s.status === "scheduled" || (s.status === "requested" && (manage || (me && s.userId === me))))
    .slice(0, 40)
    .map((s) => ({ ...row(s), start_at: startOf(s), status: s.status === "requested" ? "requested" : "scheduled" }));
  const queue = q.map((e, i) => ({ position: i + 1, display: e.displayname || e.username, minutes: e.minutes, featured: !!e.feature,
                                   title: e.title || null, mode: e.mode === "embed" ? "embed" : "stream", mine: !!me && e.userId === me }));
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
    add(s.room_id).now.push({ id: s.id, display: s.displayname || s.username, live: isLive(s, t), featured: !!s.featured,
      title: s.title || null, mode: s.mode || "stream", embed_label: e ? embeds.label(e) : null, since: s.went_live || null,
      ends_by: (s.went_live || startOf(s)) + s.max_minutes * 60000 });
  }
  for (const s of fut) {
    add(s.room_id).next.push({ id: s.id, display: s.displayname || s.username, start_at: startOf(s), minutes: s.max_minutes,
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
  return u;
}
async function unban(userId, actor) {
  await init();
  const r = await runQuery("DELETE FROM stage_bans WHERE userId = ?", [String(userId || "")]);
  if (r.changes) await event(null, "unban", actor, userId);
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
  return u;
}
async function roomUnban(roomId, userId, actor) {
  const r = await runQuery("DELETE FROM stage_room_bans WHERE room_id = ? AND userId = ?", [roomId, String(userId || "")]);
  if (r.changes) await event(null, "room_unban", actor, userId, roomId);
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
  return { config: config(), open, upcoming, log, bans, events, rtmp_app: RTMP_APP + " -> " + OUT_APP, relays: relays.size };
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
  const express = require("express");
  if (!noTimers) start();
  const isStaff = rooms.isStaff;
  const fail = (res, e) => {
    if (e && (e.refuse || (e.status && e.status < 500 && e.message))) return res.status(e.status).json({ ok: false, error: e.message });
    console.error("[stage]", e);
    res.status(500).json({ ok: false, error: "Something went wrong - nothing was charged." });
  };
  const needUser = (req, res, next) => (req.user && req.user.userId ? next() : res.status(401).json({ ok: false, error: "Sign in first." }));
  const needStaff = (req, res, next) => (isStaff(req.user) ? next() : res.status(403).json({ ok: false, error: "Admins only." }));
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
    const all = await rooms.list();
    const want = String(req.query.room || "");
    const pick = all.find((r) => r.slug === want || r.id === want) || all.find((r) => r.id === rooms.HOUSE_ROOM) || all[0] || null;
    res.locals.og = { title: "Go live on PATV", description: "Stream to a pad's stage on publicaccess.tv - from OBS, your browser, or a YouTube/Twitch link. Get featured on the main stage.",
                      image: res.locals.ogBase + "/og/page.png?t=Go%20live%20on%20PATV", url: res.locals.ogBase + "/stage" };
    res.render("stageBook", { user: me ? me.username : null, me, C: config(), rtmpServer: RTMP_PUBLIC, staff: isStaff(req.user),
                              rooms: all.map((r) => ({ id: r.id, slug: r.slug, title: r.title, slot_count: r.slot_count, slot_price: r.slot_price, approval: r.approval, house: r.house,
                                                        owner: r.owner ? r.owner.display || r.owner.username : null })),
                              pick: pick ? pick.id : null, twitchUrl });
  };
  app.get("/stage", addUser, bookPage);
  app.get("/stage/book", addUser, bookPage);

  app.get("/api/stage/me", addUser, needUser, async (req, res) => {
    try {
      const m = await mine(req.user.userId);
      const bal = (await getQuery("SELECT points_balance FROM users WHERE userId = ?", [req.user.userId]))[0];
      const R = await roomOf(String(req.query.room || ""));
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
      if (b.room && !R) throw new Refuse(404, "No such pad.");
      res.set("Cache-Control", "no-store");
      res.json({ ok: true, ...(await book(req.user, { ...b, room: R ? R.id : undefined })) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/stage/queue", addUser, needUser, async (req, res) => {
    try {
      const b = req.body || {};
      const R = await roomOf(b.room);
      if (!R) throw new Refuse(404, "No such pad.");
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
  app.post("/api/stage/slots/:id/upgrade", addUser, needUser, async (req, res) => {
    try { res.json({ ok: true, slot: await upgrade(req.user, req.params.id, (req.body || {}).minutes) }); } catch (e) { fail(res, e); }
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
      if (b.ban) await roomBan(s.room_id, s.username, b.reason || "cut from the stage", actor(req));
      if (r) rooms.notify(s.userId, { kind: "stage", title: "Your stage slot was cut", body: r.refund ? `${r.refund.toLocaleString("en-US")} PAT unused was refunded.` : "",
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
    if (!isStaff(req.user)) return res.redirect("/login");
    res.render("stageAdmin", { user: req.user.username, state: await adminState() });
  });
  app.get("/api/stage/admin/state", addUser, needStaff, async (req, res) => {
    try { res.set("Cache-Control", "no-store"); res.json({ ok: true, ...(await adminState()) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stage/admin/config", addUser, needStaff, async (req, res) => {
    try { res.json({ ok: true, config: await setConfig(req.body || {}, actor(req)) }); } catch (e) { fail(res, e); }
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
  unfeature, featureByOwner, upgrade, approve, deny, joinQueue, leaveQueue, queueFor, roomStage, roomSchedule, guide, mine, regenKey, openSlots, futureSlots,
  isBanned, Refuse, RTMP_APP, OUT_APP, STREAM_PREFIX, DEFAULTS, RTMP_PUBLIC,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _setSpawn: (fn) => { spawnImpl = fn; },
  _relays: relays, _clients: clients, _lastTick: lastTick, _pubCache: pubCache,
};
