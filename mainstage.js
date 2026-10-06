// mainstage.js — paid Main Stage slots (1.99al).
//
// A signed-in user books the main stage: they choose a maximum length, PAT for all of it is HELD
// up front (taken off their balance into the slot), and they are billed per minute ACTUALLY live.
// When the slot ends - for any reason - the unused part of the hold goes straight back:
//
//   booked (waiting) --first publish--> active --(time used up | owner ends | admin cut |
//        |                               |       idle too long | deadline)--> ended + settled
//        +--never went live in the start window----------------------------> ended + settled
//
// Money: book = one transaction (debit the whole hold + slot row). Billing ticks only move the
// slot's own bookkeeping (live_ms -> charged, never more than held). Settling = one transaction,
// guarded by `settled = 0`, that refunds held - charged to the user and books the charged part as
// revenue: "reserve" (default) = a NEGATIVE reserve_claims row, flow "stage_slot", which Pepe's
// funding tick credits to the Federal Reserve (same path as the prize-shop seller fee), or
// "jackpot" = a jackpot_rakes row into the casino pot. A server restart loses nothing: slots are
// in the DB, the next tick resumes them, and any slot whose deadline passed meanwhile is settled.
//
// Streaming: nginx-rtmp calls POST /api/stage/rtmp (on_publish / on_update / on_publish_done, only
// from loopback). A slot key (random, shown once, stored only as a SHA-256 hash, cleared when the
// slot ends) is accepted and REDIRECTED to the slot's public stream name, so the key never becomes
// the HLS filename. on_update (every 10 s) is the liveness heartbeat for billing, and answering it
// with 403 is how a cut / ended slot is kicked off the server. Pepe's own key ("broadcast") is
// passed through untouched on the prod application. The browser mode posts MediaRecorder chunks
// to /api/stage/slots/:id/relay (owner checked on every chunk); one ffmpeg per slot turns them
// into RTMP to the local nginx with an internal HMAC relay key.
//
// Several slots can be live at once in this model (ids everywhere); `max_concurrent` (default 1)
// is the only thing that limits it today.
const crypto = require("crypto");
const childProcess = require("child_process");
const { v4: uuidv4 } = require("uuid");
const { runQuery, getQuery } = require("./dbUtils");

const STAGING = !!process.env.STAGING;
const RTMP_APP = process.env.STAGE_RTMP_APP || (STAGING ? "live_staging" : "live");
const RTMP_PUBLIC = process.env.STAGE_RTMP_URL || `rtmp://stream.publicaccess.tv/${RTMP_APP}`;
const RTMP_LOCAL = process.env.STAGE_RTMP_LOCAL || `rtmp://127.0.0.1/${RTMP_APP}`;
const HLS_BASE = String(process.env.STAGE_HLS_BASE || "https://publicaccess.tv/hls").replace(/\/+$/, "");
const STREAM_PREFIX = STAGING ? "stg-" : "stage-";
// Pepe's OBS key(s): let through untouched, and only on the prod application (the staging app
// writes into the same HLS directory, so it must never accept "broadcast").
const PEPE_KEYS = new Set(RTMP_APP === "live"
  ? String(process.env.STAGE_PEPE_KEYS || "broadcast").split(",").map((s) => s.trim()).filter(Boolean) : []);
const RELAY_SECRET = process.env.SECRET_KEY || crypto.randomBytes(32).toString("hex");
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

const DEFAULTS = {
  enabled: true,
  price_per_min: 1000,     // PAT per started live minute
  min_minutes: 5,
  max_minutes: 60,
  max_concurrent: 1,       // stage slots booked/live at the same time
  revenue_vault: "reserve", // "reserve" (Federal Reserve) | "jackpot" (casino pot)
  start_window_min: 10,    // must go live within this long of booking, or it's refunded in full
  idle_grace_min: 5,       // after going live, ends if the stream is down this long
  bookings_per_hour: 3,    // per user
};
const BEAT_STALE_MS = 30 * 1000;     // on_update comes every 10 s; 3 missed = not live
const TICK_MS = 5000;
const MAX_TICK_GAP_MS = 15 * 1000;   // never bill more than this per tick (server paused/restarted)
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
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS stage_slots (
        id TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        username TEXT,
        displayname TEXT,
        status TEXT NOT NULL,            -- waiting | active | ended
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
      await runQuery("CREATE INDEX IF NOT EXISTS stage_slots_status ON stage_slots (status)");
      await runQuery("CREATE INDEX IF NOT EXISTS stage_slots_user ON stage_slots (userId, created)");
      await runQuery("CREATE TABLE IF NOT EXISTS stage_config (key TEXT PRIMARY KEY, value TEXT)");
      await runQuery(`CREATE TABLE IF NOT EXISTS stage_bans (
        userId TEXT PRIMARY KEY, username TEXT, reason TEXT, by TEXT, at INTEGER)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS stage_events (
        slot_id TEXT, ts INTEGER, what TEXT, actor TEXT, detail TEXT)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS reserve_claims (
        claimId TEXT PRIMARY KEY, flow TEXT NOT NULL, userId TEXT, type TEXT, amount INTEGER NOT NULL,
        created DATETIME DEFAULT CURRENT_TIMESTAMP, settled INTEGER DEFAULT 0)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS jackpot_rakes (
        jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)`).catch(() => {});
      await loadConfig();
    })();
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
    max_concurrent: int(c.max_concurrent, 0, 8, DEFAULTS.max_concurrent),
    revenue_vault: c.revenue_vault === "jackpot" ? "jackpot" : "reserve",
    start_window_min: int(c.start_window_min, 1, 120, DEFAULTS.start_window_min),
    idle_grace_min: int(c.idle_grace_min, 1, 60, DEFAULTS.idle_grace_min),
    bookings_per_hour: int(c.bookings_per_hour, 1, 100, DEFAULTS.bookings_per_hour),
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

async function event(slotId, what, actor, detail) {
  try {
    await runQuery("INSERT INTO stage_events (slot_id, ts, what, actor, detail) VALUES (?, ?, ?, ?, ?)",
                   [slotId || null, now(), what, actor || null, detail ? String(detail).slice(0, 500) : null]);
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
  return Math.min(slot.held, Math.min(billedMinutes(liveMs), slot.max_minutes) * slot.price_per_min);
}
// the latest moment a slot may still be running, whatever happens
function deadline(slot, C = CONFIG) {
  return slot.created + (C.start_window_min + slot.max_minutes * 2 + C.idle_grace_min) * 60000;
}
const isLive = (s, t = now()) => !!s && s.status !== "ended" && !!s.publishing && !!s.beat && t - s.beat < BEAT_STALE_MS;

// ── queries ──
async function getSlot(id) {
  await init();
  return (await getQuery("SELECT * FROM stage_slots WHERE id = ?", [String(id || "")]))[0] || null;
}
async function openSlots() {
  await init();
  return getQuery("SELECT * FROM stage_slots WHERE status != 'ended' ORDER BY created");
}
async function isBanned(userId) {
  await init();
  return (await getQuery("SELECT 1 AS b FROM stage_bans WHERE userId = ?", [userId])).length > 0;
}

// ── book ──
async function book(user, opts = {}) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in to book the stage.");
  const C = CONFIG;
  if (!C.enabled || C.max_concurrent < 1) throw new Refuse(403, "Stage booking is closed right now.");
  const minutes = Math.floor(Number(opts.minutes));
  if (!Number.isFinite(minutes) || minutes < C.min_minutes || minutes > C.max_minutes) {
    throw new Refuse(400, `Pick between ${C.min_minutes} and ${C.max_minutes} minutes.`);
  }
  if (await isBanned(user.userId)) throw new Refuse(403, "You can't book the stage.");
  const hold = minutes * C.price_per_min;
  const key = newKey();
  const id = uuidv4();
  const t = now();
  const out = await tx(async () => {
    const open = await getQuery("SELECT userId FROM stage_slots WHERE status != 'ended'");
    if (open.some((s) => s.userId === user.userId)) throw new Refuse(409, "You already have a stage slot.");
    if (open.length >= C.max_concurrent) throw new Refuse(409, "The stage is taken right now - try again when the current slot ends.");
    const recent = await getQuery("SELECT COUNT(*) AS n FROM stage_slots WHERE userId = ? AND created > ?", [user.userId, t - 3600 * 1000]);
    if (recent[0].n >= C.bookings_per_hour) throw new Refuse(429, "You've booked the stage a lot this hour - try again later.");
    const u = (await getQuery("SELECT username, displayname FROM users WHERE userId = ?", [user.userId]))[0];
    if (!u) throw new Refuse(404, "Couldn't find your account.");
    const paid = await runQuery("UPDATE users SET points_balance = points_balance - ? WHERE userId = ? AND points_balance >= ?",
                                [hold, user.userId, hold]);
    if (!paid.changes) throw new Refuse(402, `A ${minutes}-minute slot holds ${hold.toLocaleString("en-US")} PAT - you don't have enough.`);
    await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)",
                   [uuidv4(), user.userId, `stage slot hold (${minutes} min max)`, -hold]);
    const stream = STREAM_PREFIX + crypto.randomBytes(8).toString("hex");
    await runQuery(`INSERT INTO stage_slots (id, userId, username, displayname, status, created, max_minutes, price_per_min, held,
                    key_hash, stream, revenue_vault) VALUES (?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?, ?, ?)`,
                   [id, user.userId, u.username, u.displayname || u.username, t, minutes, C.price_per_min, hold, sha(key), stream, C.revenue_vault]);
    return { id };
  });
  await event(out.id, "booked", user.username, `${minutes} min, held ${hold}`);
  const slot = await getSlot(out.id);
  return { slot: view(slot), key, rtmp: { server: RTMP_PUBLIC, key } };
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
                              end_reason = ?, ended_by = ?, key_hash = NULL, publishing = 0 WHERE id = ? AND settled = 0`,
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
    }
    return { id: s.id, charged, refund, userId: s.userId };
  });
  if (res) {
    stopRelay(res.id);
    for (const [cid, sid] of clients) if (sid === res.id) clients.delete(cid);
    lastTick.delete(res.id);
    await event(res.id, "ended", actor, `${reason}: charged ${res.charged}, refunded ${res.refund}`);
  }
  return res;
}

// ── the billing tick ──
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
      if (s.publishing && !live) {
        await runQuery("UPDATE stage_slots SET publishing = 0 WHERE id = ? AND settled = 0", [s.id]);   // heartbeat lost
      }
      let why = null;
      if (liveMs >= s.max_minutes * 60000) why = "time_up";
      else if (s.status === "waiting" && t - s.created > C.start_window_min * 60000) why = "never_live";
      else if (s.status === "active" && !live && t - (s.last_live || s.went_live || s.created) > C.idle_grace_min * 60000) why = "idle";
      else if (t > deadline(s, C)) why = "deadline";
      if (why) await end(s.id, why, "system");
    } catch (e) {
      console.error("[stage] tick:", e.message);
    }
  }
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
        (s.status === "waiting" && t - s.created > CONFIG.start_window_min * 60000)) {
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
    return (await getQuery("SELECT * FROM stage_slots WHERE stream = ? AND status != 'ended'", [name]))[0] || null;
  }
  return (await getQuery("SELECT * FROM stage_slots WHERE key_hash = ? AND status != 'ended'", [sha(name)]))[0] || null;
}

// Returns {status, location?}. 2xx = allow, 3xx = allow + rename to `location`, else reject/drop.
async function rtmpCallback(f) {
  await init();
  const call = String(f.call || "");
  const name = String(f.name || "");
  const app = String(f.app || "");
  const cid = String(f.clientid || "") + "@" + app;
  const t = now();
  if (call === "play" || call === "update_play" || call === "play_done") return { status: 200 };
  if (app !== RTMP_APP) return { status: 403 };
  if (PEPE_KEYS.has(name)) return { status: 200 };

  if (call === "publish") {
    let s = null;
    const relayFor = parseRelayKey(name);
    if (relayFor) {
      if (!isLoopback(f.addr)) return { status: 403 };
      s = await getSlot(relayFor);
    } else if (name && !name.startsWith(STREAM_PREFIX)) {
      s = (await getQuery("SELECT * FROM stage_slots WHERE key_hash = ? AND status != 'ended'", [sha(name)]))[0] || null;
    }
    if (!s || s.status === "ended" || s.settled || t > deadline(s)) return { status: 403 };
    if (await isBanned(s.userId)) return { status: 403 };
    const r = await runQuery(`UPDATE stage_slots SET publishing = 1, beat = ?, status = 'active',
                              went_live = COALESCE(went_live, ?), last_live = ? WHERE id = ? AND settled = 0`, [t, t, t, s.id]);
    if (!r.changes) return { status: 403 };
    clients.set(cid, s.id);
    if (!s.went_live) event(s.id, "live", s.username, relayFor ? "browser" : "rtmp");
    return { status: 302, location: s.stream };
  }

  if (call === "update_publish" || call === "publish_done") {
    let s = clients.has(cid) ? await getSlot(clients.get(cid)) : await slotByName(name);
    if (!s) return { status: call === "publish_done" ? 200 : 403 };
    if (call === "publish_done") {
      clients.delete(cid);
      await runQuery("UPDATE stage_slots SET publishing = 0, last_live = ? WHERE id = ? AND settled = 0", [t, s.id]);
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
  if (await isBanned(s.userId)) { stopRelay(s.id); throw new Refuse(403, "You can't use the stage."); }
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

// ── views ──
function view(s, t = now()) {
  if (!s) return null;
  return {
    id: s.id, username: s.username, display: s.displayname || s.username, status: s.status,
    live: isLive(s, t), created: s.created, went_live: s.went_live || null, ended: s.ended || null,
    max_minutes: s.max_minutes, price_per_min: s.price_per_min, held: s.held,
    live_seconds: Math.floor((s.live_ms || 0) / 1000), billed_minutes: billedMinutes(s.live_ms),
    charged: s.settled ? s.charged : chargeFor(s, s.live_ms), refunded: s.refunded == null ? null : s.refunded,
    end_reason: s.end_reason || null, ended_by: s.ended_by || null,
    stream: s.stream, hls: `${HLS_BASE}/${s.stream}.m3u8`, relay: relays.has(s.id),
    start_by: s.created + CONFIG.start_window_min * 60000,
  };
}
// What the stage shows: the slots live right now (cached briefly; the homepage polls it).
let pubCache = { at: 0, list: [] };
async function publicSlots() {
  if (Date.now() - pubCache.at < 2000) return pubCache.list;
  const t = now();
  let nameStyle = () => "";
  try { nameStyle = require("./cosmetics").nameStyle; } catch (e) { /* no cosmetics */ }
  const list = (await openSlots()).filter((s) => isLive(s, t)).map((s) => ({
    id: s.id, username: s.username, display: s.displayname || s.username, nameCss: nameStyle(s.username) || "",
    hls: `${HLS_BASE}/${s.stream}.m3u8`, since: s.went_live,
  }));
  pubCache = { at: Date.now(), list };
  return list;
}

// ── admin ──
async function ban(username, reason, actor) {
  await init();
  const u = (await getQuery("SELECT userId, username FROM users WHERE LOWER(username) = LOWER(?)", [String(username || "").trim()]))[0];
  if (!u) throw new Refuse(404, "No such user.");
  await runQuery("INSERT OR REPLACE INTO stage_bans (userId, username, reason, by, at) VALUES (?, ?, ?, ?, ?)",
                 [u.userId, u.username, String(reason || "").slice(0, 200), actor || null, now()]);
  await event(null, "ban", actor, u.username + (reason ? ": " + reason : ""));
  const open = await getQuery("SELECT id FROM stage_slots WHERE userId = ? AND status != 'ended'", [u.userId]);
  for (const s of open) await end(s.id, "banned", actor);
  return u;
}
async function unban(userId, actor) {
  await init();
  const r = await runQuery("DELETE FROM stage_bans WHERE userId = ?", [String(userId || "")]);
  if (r.changes) await event(null, "unban", actor, userId);
  return r.changes > 0;
}
async function adminState() {
  await init();
  const t = now();
  const open = (await openSlots()).map((s) => view(s, t));
  const log = (await getQuery("SELECT * FROM stage_slots ORDER BY created DESC LIMIT 50")).map((s) => view(s, t));
  const bans = await getQuery("SELECT userId, username, reason, by, at FROM stage_bans ORDER BY at DESC");
  const events = await getQuery("SELECT slot_id, ts, what, actor, detail FROM stage_events ORDER BY ts DESC LIMIT 60");
  return { config: config(), open, log, bans, events, rtmp_app: RTMP_APP, relays: relays.size };
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
  const isStaff = (u) => !!u && (u.class === "Admin" || u.class === "Staff");
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status).json({ ok: false, error: e.message });
    console.error("[stage]", e);
    res.status(500).json({ ok: false, error: "Something went wrong - nothing was charged." });
  };
  const needUser = (req, res, next) => (req.user && req.user.userId ? next() : res.status(401).json({ ok: false, error: "Sign in first." }));
  const needStaff = (req, res, next) => (isStaff(req.user) ? next() : res.status(403).json({ ok: false, error: "Admins only." }));
  const actor = (req) => (req.user && req.user.username) || "?";

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

  app.get("/stage/book", addUser, async (req, res) => {
    await init();
    let me = null;
    if (req.user && req.user.userId) {
      me = (await getQuery("SELECT userId, username, displayname, points_balance FROM users WHERE userId = ?", [req.user.userId]))[0] || null;
    }
    res.locals.og = { title: "Book the Main Stage", description: "Take over the PATV main stage: stream from OBS or right from your browser, pay per minute live.",
                      image: res.locals.ogBase + "/og/page.png?t=Book%20the%20Main%20Stage", url: res.locals.ogBase + "/stage/book" };
    res.render("stageBook", { user: me ? me.username : null, me, C: config(), rtmpServer: RTMP_PUBLIC, staff: isStaff(req.user) });
  });

  app.get("/api/stage/me", addUser, needUser, async (req, res) => {
    try {
      const mine = (await getQuery("SELECT * FROM stage_slots WHERE userId = ? ORDER BY created DESC LIMIT 1", [req.user.userId]))[0];
      const bal = (await getQuery("SELECT points_balance FROM users WHERE userId = ?", [req.user.userId]))[0];
      const open = await openSlots();
      res.set("Cache-Control", "no-store");
      res.json({ ok: true, slot: view(mine), config: config(), balance: bal ? bal.points_balance : 0,
                 banned: await isBanned(req.user.userId), busy: open.filter((s) => s.userId !== req.user.userId).length >= CONFIG.max_concurrent });
    } catch (e) { fail(res, e); }
  });

  app.post("/api/stage/book", addUser, needUser, async (req, res) => {
    try { res.set("Cache-Control", "no-store"); res.json({ ok: true, ...(await book(req.user, req.body || {})) }); }
    catch (e) { fail(res, e); }
  });

  app.post("/api/stage/slots/:id/end", addUser, needUser, async (req, res) => {
    try {
      const s = await getSlot(req.params.id);
      if (!s || (s.userId !== req.user.userId && !isStaff(req.user))) throw new Refuse(404, "No such slot.");
      const r = await end(s.id, s.userId === req.user.userId ? "owner_ended" : "cut", actor(req));
      res.json({ ok: true, settled: r, slot: view(await getSlot(s.id)) });
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
      const ids = b.id ? [String(b.id)] : (await openSlots()).map((s) => s.id);
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
  // Pepe ("!stage cut" later): cut every open slot back to Pepe's stream
  app.post("/api/stage/cut", async (req, res) => {
    if (!isBotToken((req.body || {}).password)) return res.status(403).json({ error: "unauthorized" });
    try {
      let n = 0;
      for (const s of await openSlots()) if (await end(s.id, "cut", "pepe:" + String((req.body || {}).by || "bot").slice(0, 40))) n++;
      res.json({ ok: true, cut: n });
    } catch (e) { fail(res, e); }
  });
}

module.exports = {
  register, start, init, book, end, tick, reconcile, rtmpCallback, relayChunk, stopRelay, publicSlots, adminState,
  setConfig, config, ban, unban, getSlot, view, chargeFor, billedMinutes, deadline, isLive, relayKey, parseRelayKey,
  Refuse, RTMP_APP, STREAM_PREFIX, DEFAULTS,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _setSpawn: (fn) => { spawnImpl = fn; },
  _relays: relays, _clients: clients, _lastTick: lastTick,
};
