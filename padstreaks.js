// padstreaks.js — 1.99zm: 🔥 PAD STREAKS (the user, 2026-10-14: "room streaks too, with achievements attached to them").
//
// Two streaks per pad, both on the economy's day (America/New_York, streaks.js dayOf) and computed with streaks.compute (no
// grace days):
//   PAD STREAK      consecutive days the pad was ALIVE: at least `min_users` (default 3, /admin/economy... no - /pads/admin
//                   #padstreaks) different people chatted or talked on the mic in its connected room that day. Pepe and his
//                   staging twin never count. Shown on the pad's About tab; the pad's OWNER earns the 💡 pad-streak achievements.
//   REGULAR STREAK  per member per pad: consecutive days that member chatted or was on the mic in that pad's room. Account-keyed
//                   (a Camfrog login -> its PATV account, like the daily streak); shown to the member on the pad page and as
//                   "Regular at" on their profile; earns the 🪑 regular achievements (the best run in any one pad).
//
// Sources: Pepe's participation rows (econ.js ingestParticipation: per room / day / login lines + mic minutes) as they arrive.
// History (once, quietly, achievement_meta 'padstreak_backfill_1'): every participation row the site has (since 2026-10-06), and
// for pad streaks only, Pepe's room analytics (camfrog_roomstats day maps, ~90 days: `c` = distinct people who chatted that day -
// a lower bound, mic-only people aren't in it). Milestones history already reached are given QUIETLY (badge only), like every
// achievement launch.
//
// Rewards: the achievements (achievements.json cf_regular_* / cf_padstreak_*, side web, metrics pad_regular_streak / pad_streak)
// carry XP + PAT like the 🔥 daily streak milestones (1.99zx, the user 2026-10-14: regular 15k / 60k / 200k / 400k, pad owner
// 25k / 100k / 300k / 600k at 7 / 30 / 60 / 100 days), paid like every achievement bonus (routing row "achievements": the incentive
// budget's achievements group with the economy layers on, else the Reserve). History-reached milestones: badge only, no retro PAT.
//
//   pad_days        room_id, day, users (distinct active people, the most any source reported), src   PK (room_id, day)
//   pad_regulars    room_id, userId, day                                                             PK (room_id, userId, day)
//   pad_streak_cfg  k / v: min_users
//
//   GET  /api/rooms/:slug/streak        public: the pad streak (+ the signed-in member's regular streak there)
//   GET  /api/admin/padstreaks/config   POST {min_users}  site Admins (/pads/admin#padstreaks)
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");

const BACKFILL_FLAG = "padstreak_backfill_1";       // the history import
const QUIET_FLAG = "padstreak_quiet_2";             // 1.99zx: the quiet badge pass - again for the 60-day tier (+ PAT from then on)
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ROOM_RE = /^[A-Za-z0-9_.:\-]{1,120}$/;
const PEPE_LOGINS = new Set(["pepefrog", "pepebeta", "pepe", "pepebot"]);
const MILESTONES = [7, 30, 60, 100];
const METRIC_PAD = "pad_streak", METRIC_REG = "pad_regular_streak";
const DEFAULTS = Object.freeze({ min_users: 3 });

const ready = (async () => {
  await runQuery("CREATE TABLE IF NOT EXISTS pad_days (room_id TEXT NOT NULL, day TEXT NOT NULL, users INTEGER NOT NULL DEFAULT 0, src TEXT, PRIMARY KEY (room_id, day))");
  await runQuery("CREATE TABLE IF NOT EXISTS pad_regulars (room_id TEXT NOT NULL, userId TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY (room_id, userId, day))");
  await runQuery("CREATE INDEX IF NOT EXISTS pad_regulars_user ON pad_regulars (userId, room_id)");
  await runQuery("CREATE TABLE IF NOT EXISTS pad_streak_cfg (k TEXT PRIMARY KEY, v TEXT)");
})().catch((e) => console.error("[padstreaks] init:", e));

const ST = () => require("./streaks");
let clock = () => Date.now();
const today = () => ST().dayOf(clock());

// ── config ──
let cfgCache = null;
async function config() {
  if (cfgCache) return cfgCache;
  await ready;
  const r = (await getQuery("SELECT v FROM pad_streak_cfg WHERE k = 'min_users'").catch(() => []))[0];
  const n = Math.floor(Number(r && r.v));
  cfgCache = { min_users: Number.isFinite(n) && n >= 1 && n <= 50 ? n : DEFAULTS.min_users };
  return cfgCache;
}
async function setConfig(patch) {
  await ready;
  const n = Math.floor(Number(patch && patch.min_users));
  if (!Number.isFinite(n) || n < 1 || n > 50) throw Object.assign(new Error("min_users must be 1..50"), { status: 400 });
  await runQuery("INSERT INTO pad_streak_cfg (k, v) VALUES ('min_users', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [String(n)]);
  cfgCache = null;
  return config();
}

// ── writing ──
/** Pepe's participation rows -> pad days + regular days. live: only today and the two days before (older = the backfill). */
async function fromParticipation(rows, { live = true } = {}) {
  await ready;
  const byPad = new Map();                 // room|day -> Set(login)
  const regs = [];
  for (const x of Array.isArray(rows) ? rows : []) {
    const room = String((x && (x.room || x.room_id)) || "");
    const day = String((x && x.day) || "");
    const login = String((x && x.login) || "").toLowerCase();
    if (!ROOM_RE.test(room) || !DAY_RE.test(day) || !login || PEPE_LOGINS.has(login)) continue;
    if (!((Number(x.lines) || 0) > 0 || (Number(x.mic_min) || 0) > 0)) continue;
    if (live) {
      const t = ST().dn(today()), n = ST().dn(day);
      if (n > t || n < t - 2) continue;
    }
    const k = room + "|" + day;
    if (!byPad.has(k)) byPad.set(k, new Set());
    byPad.get(k).add(login);
    regs.push({ room, day, login });
  }
  const touched = new Set();
  for (const [k] of byPad) {
    const [room, day] = k.split("|");
    // the whole day's distinct people from everything the site has for it (a sync carries only the rows that changed)
    const r = (await getQuery(`SELECT COUNT(DISTINCT login) AS n FROM econ_participation WHERE room_id = ? AND day = ? AND (lines > 0 OR mic_min > 0)
                               AND login NOT IN ('pepefrog', 'pepebeta', 'pepe', 'pepebot')`, [room, day]).catch(() => []))[0];
    const n = Math.max(Number(r && r.n) || 0, byPad.get(k).size);
    await runQuery(`INSERT INTO pad_days (room_id, day, users, src) VALUES (?, ?, ?, 'chat') ON CONFLICT(room_id, day)
                    DO UPDATE SET users = MAX(users, excluded.users)`, [room, day, n]);
    touched.add(room);
  }
  const users = new Set();
  for (const g of regs) {
    const id = await ST().accountOf(g.login);
    if (!id || isPepe(id)) continue;
    const q = await runQuery("INSERT OR IGNORE INTO pad_regulars (room_id, userId, day) VALUES (?, ?, ?)", [g.room, id, g.day]);
    if (q && q.changes) users.add(id);
  }
  // a new day can complete a milestone: the members, and the owners of the pads that got a day
  if (live && (await backfilled())) {
    const owners = [];
    for (const room of touched) {
      const R = await require("./rooms").get(room).catch(() => null);
      if (R && R.owner && R.owner.userId) owners.push(R.owner.userId);
    }
    try { require("./achievements").poke(...users, ...owners); } catch (e) { /* never */ }
  }
  return { pads: touched.size, regulars: users.size };
}

let pepeIds = null;
function isPepe(id) { return String(id) === "pepe-bot" || !!(pepeIds && pepeIds.has(String(id))); }
async function loadPepe() {
  const r = await getQuery("SELECT userId FROM users WHERE LOWER(username) IN ('pepe', 'pepebot', 'pepebeta') OR LOWER(camfrogUsername) IN ('pepe', 'pepebot', 'pepebeta', 'pepefrog')").catch(() => []);
  pepeIds = new Set(["pepe-bot", ...r.map((x) => String(x.userId))]);
}

// ── reading ──
async function padDays(roomId) {
  await ready;
  const c = await config();
  return (await getQuery("SELECT day FROM pad_days WHERE room_id = ? AND users >= ?", [String(roomId), c.min_users])).map((r) => r.day);
}
async function padStreak(roomId) {
  return ST().compute(await padDays(roomId), today());
}
async function regularStreak(roomId, userId) {
  await ready;
  const days = (await getQuery("SELECT day FROM pad_regulars WHERE room_id = ? AND userId = ?", [String(roomId), String(userId)])).map((r) => r.day);
  return ST().compute(days, today());
}
/** Every pad this member has regular days in -> [{room, current, best}] (best first). */
async function regularsOf(userId) {
  await ready;
  const rows = await getQuery("SELECT room_id, day FROM pad_regulars WHERE userId = ?", [String(userId)]);
  const by = new Map();
  for (const r of rows) { if (!by.has(r.room_id)) by.set(r.room_id, []); by.get(r.room_id).push(r.day); }
  const t = today();
  const out = [];
  for (const [room, days] of by) { const s = ST().compute(days, t); out.push({ room, current: s.current, best: s.best, todayDone: s.todayDone }); }
  return out.sort((a, b) => b.current - a.current || b.best - a.best);
}

async function hasFlag(k) {
  await ready;
  const r = await getQuery("SELECT 1 FROM achievement_meta WHERE k = ?", [k]).catch(() => []);
  return r.length > 0;
}
const imported = () => hasFlag(BACKFILL_FLAG);
/** The history is imported AND its quiet badge pass (the current tiers) has run: from then on milestones are live (XP + PAT). */
const backfilled = () => hasFlag(QUIET_FLAG);

/** achievements.js webMetrics: {pad_regular_streak: the best regular run in any one pad, pad_streak: the best run of a pad this
 *  member owns now}. 0 before the backfill (nothing old is announced). */
async function metrics(userId) {
  if (!userId || !(await backfilled())) return { [METRIC_PAD]: 0, [METRIC_REG]: 0 };
  return rawMetrics(userId);
}
async function rawMetrics(userId) {
  const regs = await regularsOf(userId);
  const owned = await getQuery("SELECT room_id FROM rooms_registry WHERE owner_kind = 'user' AND owner_user_id = ?", [String(userId)]).catch(() => []);
  let pad = 0;
  for (const o of owned) pad = Math.max(pad, (await padStreak(o.room_id)).best);
  return { [METRIC_PAD]: pad, [METRIC_REG]: regs.reduce((m, r) => Math.max(m, r.best), 0) };
}

// ── the one-off history import + quiet milestones ──
let backfilling = null;
function backfill({ force = false } = {}) {
  if (backfilling && !force) return backfilling;
  backfilling = (async () => {
    await ready;
    await runQuery("CREATE TABLE IF NOT EXISTS achievement_meta (k TEXT PRIMARY KEY, v TEXT)");
    if (!force && (await backfilled())) return { done: true, already: true };
    await loadPepe();
    if (force || !(await imported())) await importHistory();
    return quietPass();
  })().catch((e) => { backfilling = null; throw e; });
  return backfilling;
}

async function importHistory() {
    // 1. every participation row the site has (per room / day / login)
    const part = await getQuery("SELECT room_id AS room, day, login, lines, mic_min FROM econ_participation").catch(() => []);
    let fromPart = { pads: 0, regulars: 0 };
    for (let i = 0; i < part.length; i += 1000) {
      const r = await tx(() => fromParticipation(part.slice(i, i + 1000), { live: false }));
      fromPart = { pads: fromPart.pads + r.pads, regulars: fromPart.regulars + r.regulars };
    }
    // 2. Pepe's room analytics (pad streaks only): distinct chatters per day
    let rsDays = 0;
    for (const row of await getQuery("SELECT room_id, data FROM camfrog_roomstats").catch(() => [])) {
      let d; try { d = JSON.parse(row.data); } catch (e) { continue; }
      const days = (d && d.days) || {};
      await tx(async () => {
        for (const [day, v] of Object.entries(days)) {
          const c = Math.max(0, Math.floor(Number(v && v.c) || 0));
          if (!DAY_RE.test(day) || !c) continue;
          await runQuery(`INSERT INTO pad_days (room_id, day, users, src) VALUES (?, ?, ?, 'roomstats') ON CONFLICT(room_id, day)
                          DO UPDATE SET users = MAX(users, excluded.users)`, [row.room_id, day, c]);
          rsDays++;
        }
      });
    }
    const rec = { at: new Date().toISOString(), participation_rows: part.length, roomstats_days: rsDays };
    await runQuery("INSERT OR REPLACE INTO achievement_meta (k, v) VALUES (?, ?)", [BACKFILL_FLAG, JSON.stringify(rec)]);
    console.log(`[padstreaks] history import: ${part.length} participation row(s), ${rsDays} analytics day(s)`);
}

/** What the history already earned, for every tier in the catalog: badge only (no XP, PAT or announcement) - the 1.99xi pattern.
 *  Runs once per QUIET_FLAG (bumped when a tier is added: the 60-day ones, 1.99zx). */
async function quietPass() {
    const A = require("./achievements");
    await A.ready;
    const ach = A.list().filter((a) => a.side === "web" && (a.metric === METRIC_PAD || a.metric === METRIC_REG));
    const users = new Set((await getQuery("SELECT DISTINCT userId FROM pad_regulars")).map((r) => r.userId));
    for (const o of await getQuery("SELECT owner_user_id FROM rooms_registry WHERE owner_kind = 'user' AND owner_user_id IS NOT NULL").catch(() => [])) users.add(o.owner_user_id);
    const known = new Set((await getQuery("SELECT userId FROM users").catch(() => [])).map((r) => String(r.userId)));
    const given = {};
    for (const id of users) {
      if (!known.has(String(id)) || isPepe(id)) continue;
      const m = await rawMetrics(id);
      for (const a of ach) {
        if ((m[a.metric] || 0) < (a.threshold || 1)) continue;
        const r = await A.award({ userId: id }, a.id, null, { silent: true });
        if (r.ok && r.awarded) given[a.id] = (given[a.id] || 0) + 1;
      }
    }
    const rec = { at: new Date().toISOString(), accounts: users.size, given };
    await runQuery("INSERT OR REPLACE INTO achievement_meta (k, v) VALUES (?, ?)", [QUIET_FLAG, JSON.stringify(rec)]);
    console.log(`[padstreaks] quiet badges ${JSON.stringify(given)}`);
    return Object.assign({ done: true }, rec);
}

// ── API ──
async function card(roomId, user) {
  const c = await config();
  const s = await padStreak(roomId);
  const out = { ok: true, min_users: c.min_users, pad: { current: s.current, best: s.best, todayDone: s.todayDone, atRisk: s.atRisk, next: MILESTONES.find((m) => m > s.best) || null },
                me: null, today: today() };
  if (user && user.userId) {
    const r = await regularStreak(roomId, user.userId);
    out.me = { current: r.current, best: r.best, todayDone: r.todayDone, atRisk: r.atRisk, next: MILESTONES.find((m) => m > r.best) || null };
  }
  return out;
}

/** The profile's "Regular at": the member's longest running regular streak (null when none is running). */
async function topForUser(userId) {
  try {
    const regs = (await regularsOf(userId)).filter((r) => r.current > 0);
    if (!regs.length) return null;
    const R = await require("./rooms").get(regs[0].room).catch(() => null);
    if (!R) return null;
    return { room: R.id, title: R.title || R.id, slug: R.slug || null, current: regs[0].current, best: regs[0].best, more: regs.length - 1 };
  } catch (e) { return null; }
}

function register(app, { addUser }) {
  setImmediate(() => loadPepe().catch(() => {}));
  app.get("/api/rooms/:slug/streak", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      const R = await require("./roomsweb").resolveRoom(req.params.slug);
      if (!R) return res.status(404).json({ ok: false, error: "No such pad." });
      res.json(await card(R.id, req.user));
    } catch (e) { console.error("[padstreaks] card:", e.message); res.status(500).json({ ok: false }); }
  });
  const admin = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || req.user.class !== "Admin") return res.status(403).json({ ok: false, error: "Admins only." });
    next();
  };
  app.get("/api/admin/padstreaks/config", addUser, admin, async (req, res) => {
    res.json(Object.assign({ ok: true, defaults: DEFAULTS, milestones: MILESTONES, backfill: await backfilled() }, await config()));
  });
  app.post("/api/admin/padstreaks/config", addUser, admin, async (req, res) => {
    if (req.get("X-Requested-With") !== "fetch" || !require("./middleware/authGuard").sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    try {
      const c = await setConfig(req.body || {});
      await require("./adminaudit").record(req.user, "padstreak-cfg", null, c).catch(() => {});
      res.json(Object.assign({ ok: true }, c));
    } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : "Couldn't save." }); }
  });
}

if (!process.env.NODE_TEST_CONTEXT) {
  const kick = setTimeout(() => backfill().catch((e) => console.error("[padstreaks] backfill:", e.message)), 130e3);
  if (kick.unref) kick.unref();
}

module.exports = { ready, register, fromParticipation, padStreak, regularStreak, regularsOf, metrics, backfill, backfilled, card, topForUser,
                   config, setConfig, MILESTONES, METRIC_PAD, METRIC_REG, BACKFILL_FLAG, QUIET_FLAG, _clearCache: () => { cfgCache = null; },
                   _setClock: (f) => { clock = f || (() => Date.now()); } };
