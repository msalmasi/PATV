// vwm.js — economy v2 E-5: VERIFIED watch-minutes, rolled up per day (camfrog-bot docs/ECONOMY-V2.md 7.2, 10, 12 E-5).
//
// The stage player's heartbeats (econ.js POST /api/econ/watch/beat) already decide what a viewer's minute is worth:
// signed in, ONE counted session per account across tabs and devices, consecutive 30 s beats echoing the server's
// one-time nonce, the page visible, the media playing and its position advancing; the streamer, accounts sharing a
// strong key with them (Camfrog / Discord / Twitch / email / device, the welcome dedupe's dup_of) and anyone watching
// from the streamer's own browser or address are 'self'; the 4th+ account on one browser or one network (IPv4 /24,
// IPv6 /64) for a stream, and accounts the welcome dedupe flagged, are 'alt'. Muted / volume-0 seconds are counted
// apart (muted_secs).
//
// This module turns those rows into the number the recipe pays on (the streamer slice: 25% of the pad's budget, filled
// linearly to 600 VWM, shared by sqrt(VWM), each streamer <= 60% - Pepe's pepe_recipe.plan_slices):
//
//   stage_watch   (day, room_id, streamer_id) PK
//                 vwm         verified minutes: status 'ok' rows, minus muted minutes, from viewers who pass the gates
//                             (account >= 7 days old, level >= 2, a verified email / Discord / Twitch link, not archived),
//                             at most 120 per viewer per STREAMER per day (across all the streamer's slots and pads; a
//                             capped viewer's minutes are shared between the pads in proportion)
//                 viewers     distinct viewers who contributed
//                 raw_min / muted_min / self_min / alt_min / gate_min / cap_min   what was left out, and why
//                 final       1 once the UTC day is over (the numbers no longer change), computed (ms)
//   Only stage SLOTS have a streamer to pay (Pepe's own stream, pepe:<room>, has none; embeds can't be verified).
//
//   POST /api/g/vwm/daily  (bot token) {day, rooms?: [room ids]} -> {ok, day, final, rows: [{room, streamer, vwm, viewers, ...}]}
//   GET  /api/admin/econ/vwm?day=YYYY-MM-DD  (staff) the same, every pad
//   recipe.js inputs read their `streamers` from here (forRoom).
// A closed day is rolled up once more and frozen by the half-hourly tick (and on first use); an open day is recomputed
// on each read.
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

const DAY_MS = 86400000;
const GATES = Object.freeze({ min_age_days: 7, min_level: 2, cap_min: 120 });
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
let clock = () => Date.now();
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await require("./econ").ready;                    // econ_watch
      await runQuery(`CREATE TABLE IF NOT EXISTS stage_watch (day TEXT NOT NULL, room_id TEXT NOT NULL, streamer_id TEXT NOT NULL,
                      vwm REAL NOT NULL DEFAULT 0, viewers INTEGER NOT NULL DEFAULT 0, raw_min REAL DEFAULT 0, muted_min REAL DEFAULT 0,
                      self_min REAL DEFAULT 0, alt_min REAL DEFAULT 0, gate_min REAL DEFAULT 0, cap_min REAL DEFAULT 0,
                      final INTEGER NOT NULL DEFAULT 0, computed INTEGER, PRIMARY KEY (day, room_id, streamer_id))`);
      await runQuery("CREATE INDEX IF NOT EXISTS stage_watch_room ON stage_watch (room_id, day)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const ageDays = (created, t) => {
  const s = String(created || "");
  const ms = Date.parse(s.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? "" : "Z"));
  return Number.isFinite(ms) ? (t - ms) / DAY_MS : 0;
};
const r1 = (x) => Math.round(x * 10) / 10;

/** The viewer gates (doc 7.2) for one joined row. */
function viewerOk(r, t) {
  if (!r || r.uid == null) return false;                                   // the account is gone
  if (r.archived_at) return false;
  if (ageDays(r.created_at, t) < GATES.min_age_days) return false;
  if ((Number(r.level) || 0) < GATES.min_level) return false;
  return Number(r.isEmailVerified) === 1 || !!r.discordId || !!r.twitchId;
}

async function watchRows(day) {
  const base = `SELECT w.room_id, w.streamer_id, w.viewer_id, w.secs, w.muted_secs, w.status, u.userId AS uid, u.level, u.created_at,
                       u.isEmailVerified, u.discordId, u.twitchId`;
  const tail = ` FROM econ_watch w LEFT JOIN users u ON u.userId = w.viewer_id
                 WHERE w.day = ? AND w.stream LIKE 'slot:%' AND w.streamer_id IS NOT NULL AND w.streamer_id != ''`;
  try { return await getQuery(base + ", u.archived_at" + tail, [day]); } catch (e) { /* no archived_at column */ }
  try { return await getQuery(base + ", NULL AS archived_at" + tail, [day]); } catch (e) { return []; }
}

/** The pure rollup of one day's heartbeat rows -> [{room_id, streamer_id, vwm, viewers, raw_min, ...}]. */
function rollupRows(rows, t) {
  const per = new Map();                 // streamer -> viewer -> room -> verified minutes (before the cap)
  const acc = new Map();                 // `${room}|${streamer}` -> the row being built
  const cell = (room, s) => {
    const k = room + "|" + s;
    if (!acc.has(k)) acc.set(k, { room_id: room, streamer_id: s, vwm: 0, viewers: 0, raw_min: 0, muted_min: 0, self_min: 0, alt_min: 0, gate_min: 0, cap_min: 0 });
    return acc.get(k);
  };
  for (const r of rows) {
    const room = String(r.room_id || ""), s = String(r.streamer_id || "");
    if (!room || !s) continue;
    const c = cell(room, s);
    const raw = Math.max(0, Number(r.secs) || 0) / 60;
    const muted = Math.min(raw, Math.max(0, Number(r.muted_secs) || 0) / 60);
    c.raw_min += raw;
    if (r.status === "self") { c.self_min += raw; continue; }
    if (r.status === "alt") { c.alt_min += raw; continue; }
    c.muted_min += muted;
    const net = raw - muted;
    if (net <= 0) continue;
    if (!viewerOk(r, t)) { c.gate_min += net; continue; }
    if (!per.has(s)) per.set(s, new Map());
    const pv = per.get(s);
    if (!pv.has(r.viewer_id)) pv.set(r.viewer_id, new Map());
    const pr = pv.get(r.viewer_id);
    pr.set(room, (pr.get(room) || 0) + net);
  }
  for (const [s, pv] of per) {
    for (const [, pr] of pv) {
      const tot = [...pr.values()].reduce((a, b) => a + b, 0);
      const k = tot > GATES.cap_min ? GATES.cap_min / tot : 1;          // 120 per viewer per streamer per day, all pads
      for (const [room, m] of pr) {
        const c = cell(room, s);
        c.vwm += m * k;
        c.cap_min += m * (1 - k);
        if (m * k > 0) c.viewers += 1;
      }
    }
  }
  return [...acc.values()].map((c) => ({ ...c, vwm: r1(c.vwm), raw_min: r1(c.raw_min), muted_min: r1(c.muted_min), self_min: r1(c.self_min),
                                         alt_min: r1(c.alt_min), gate_min: r1(c.gate_min), cap_min: r1(c.cap_min) }));
}

/** Recompute one day (unless it is already final and `force` is off). -> {day, final, rows} */
async function rollupDay(day, { force = false } = {}) {
  await init();
  if (!DAY_RE.test(String(day || ""))) throw new Error("bad day");
  const t = clock();
  const final = day < utcDay(t) ? 1 : 0;
  const had = await getQuery("SELECT COUNT(*) AS n, MIN(final) AS f FROM stage_watch WHERE day = ?", [day]);
  if (!force && had[0] && Number(had[0].n) > 0 && Number(had[0].f) === 1) return { day, final: 1, rows: await stored(day) };
  const rows = rollupRows(await watchRows(day), t);
  // a streamer whose account is gone is not paid (and not listed)
  const ids = [...new Set(rows.map((r) => r.streamer_id))];
  const live = ids.length ? new Set((await getQuery(`SELECT userId FROM users WHERE userId IN (${ids.map(() => "?").join(",")})`, ids)).map((r) => r.userId)) : new Set();
  const keep = rows.filter((r) => live.has(r.streamer_id));
  await tx(async () => {
    await runQuery("DELETE FROM stage_watch WHERE day = ?", [day]);
    for (const r of keep) {
      await runQuery(`INSERT INTO stage_watch (day, room_id, streamer_id, vwm, viewers, raw_min, muted_min, self_min, alt_min, gate_min, cap_min, final, computed)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                     [day, r.room_id, r.streamer_id, r.vwm, r.viewers, r.raw_min, r.muted_min, r.self_min, r.alt_min, r.gate_min, r.cap_min, final, t]);
    }
  });
  return { day, final, rows: keep };
}

async function stored(day, rooms) {
  const want = Array.isArray(rooms) && rooms.length ? rooms.map(String).slice(0, 300) : null;
  const q = want ? `SELECT * FROM stage_watch WHERE day = ? AND room_id IN (${want.map(() => "?").join(",")}) ORDER BY room_id, vwm DESC`
                 : "SELECT * FROM stage_watch WHERE day = ? ORDER BY room_id, vwm DESC";
  return getQuery(q, want ? [day, ...want] : [day]);
}

/** The rollup for `day` (computed now for an open day, frozen once final). */
async function daily(day, rooms) {
  const r = await rollupDay(day);
  const rows = Array.isArray(rooms) && rooms.length ? await stored(day, rooms) : r.rows;
  return { ok: true, day, final: !!r.final, rows: rows.map(pub) };
}
const pub = (r) => ({ room: r.room_id, streamer: r.streamer_id, vwm: Number(r.vwm) || 0, viewers: Number(r.viewers) || 0, raw_min: Number(r.raw_min) || 0,
                      muted_min: Number(r.muted_min) || 0, self_min: Number(r.self_min) || 0, alt_min: Number(r.alt_min) || 0,
                      gate_min: Number(r.gate_min) || 0, cap_min: Number(r.cap_min) || 0, final: !!Number(r.final) });

/** recipe.js: the verified watch-minutes per streamer on one pad's stage that day -> [{userId, vwm, viewers}]. */
async function forRoom(roomId, day) {
  await rollupDay(day);
  return (await stored(day, [String(roomId)])).filter((r) => Number(r.vwm) > 0)
    .map((r) => ({ userId: r.streamer_id, vwm: Number(r.vwm), viewers: Number(r.viewers) || 0 }));
}

// the half-hourly tick: freeze the last two closed days (late beats near midnight land in the day they were sent)
let timer = null;
async function tick() {
  const t = clock();
  for (const d of [utcDay(t - DAY_MS), utcDay(t - 2 * DAY_MS)]) {
    try { await rollupDay(d); } catch (e) { console.error("[vwm] rollup", d, e.message); }
  }
}
function start() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, 30 * 60000);
  if (timer.unref) timer.unref();
}

function register(app, { isBotToken, addUser }) {
  app.post("/api/g/vwm/daily", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try {
      if (!DAY_RE.test(String(b.day || ""))) return res.status(400).json({ ok: false, error: "bad day" });
      res.json(await daily(String(b.day), b.rooms));
    } catch (e) { console.error("[vwm]", e); res.status(500).json({ ok: false, error: "Something went wrong." }); }
  });
  if (addUser) {
    app.get("/api/admin/econ/vwm", addUser, async (req, res) => {
      res.set("Cache-Control", "no-store");
      try {
        if (!SP.can(req.user, "econ.vwm_view")) return res.status(403).json({ ok: false, error: "Admins only." });
        const d = DAY_RE.test(String(req.query.day || "")) ? String(req.query.day) : utcDay(clock());
        res.json(await daily(d));
      } catch (e) { console.error("[vwm]", e); res.status(500).json({ ok: false, error: "Something went wrong." }); }
    });
  }
  start();
}

module.exports = { init, rollupRows, rollupDay, daily, forRoom, tick, register, GATES, viewerOk,
                   _setClock: (fn) => { clock = fn || (() => Date.now()); }, _stop: () => { if (timer) clearInterval(timer); timer = null; } };
