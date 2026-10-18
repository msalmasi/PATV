// streaks.js — 1.99xi: 🔥 daily activity streaks.
//
// A DAY counts for an account when it did at least one qualifying thing that calendar day in the economy's time zone
// (America/New_York - the day "today only" offers, the lotto and Pepe's ledger use; DST-safe: the day key is the local date):
//   chat / mic / cmd   Camfrog chat lines, a mic-up, a command - from Pepe's syncs (econ.js participation, per pad room per
//                      day; userstats.js analytics, per day), linked login or an account key "u:<userId>" (web relay lines)
//   relay              a line sent into a pad's room from the website (bridge-relay.js)
//   post / comment     a feed post or comment (feedstore.js)
//   spin               a settled wheel spin (index.js)
//   game               a hand at the site's casino tables (casino/rewards.js), a Pepeball ticket bought on the web
//   tip                a tip sent (tips.js)
// Each (account, day, source) is ONE row in activity_days - the same thing many times a day, or from two feeds, is still
// one day. The streak is COMPUTED from those rows (compute(): pure, tested with injected clocks), never stored, so there's
// nothing to drift: current = consecutive days up to today (today not done yet keeps yesterday's run alive - "at risk"),
// best = the longest run ever.
//
// Grace: `freeze_per_week` (streak_meta; 0 = OFF, the default) lets up to N missed days per Monday-start week bridge a run
// (a bridged day doesn't add to the count). Admins set it with POST /api/admin/streaks/config.
//
// Rewards: ONLY the 🔥 milestone achievements (achievements.json cf_daily_7 / 30 / 100 / 365, metric activity_streak = best
// run, side web): XP + PAT from the incentive budget's achievements group like every achievement, announced by Pepe through
// the achievement feed (he skips the chat line for an !incognito login). No other PAT. History from before this shipped
// (Pepe's 90 days of analytics + the site's own tables) is imported once (backfill, achievement_meta 'streak_backfill_1');
// the milestones that history already reached are given QUIETLY (badge only), like every achievement launch.
//
// Incognito: a streak still counts (it's activity, not something Pepe remembers about what they said); the profile shows
// it like the level (the owner can hide the 🔥 Streak header item in Edit profile → layout); Pepe doesn't congratulate an
// incognito login in chat and !streak @them answers that they keep it to themselves.
//
// Merges: activity_days rows move to the surviving account (accountMerge.js, folded per day + source).
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

const TZ = "America/New_York";
const SOURCES = ["chat", "mic", "cmd", "relay", "post", "comment", "spin", "game", "tip"];
const SRC = new Set(SOURCES);
const MILESTONES = [7, 30, 100, 365];
const METRIC = "activity_streak";
const BACKFILL_FLAG = "streak_backfill_1";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOGIN_RE = /^[\w.\-]{1,40}$/;
const ACCOUNT_KEY_RE = /^u:([A-Za-z0-9-]{6,64})$/i;
const LIVE_DAYS = 2;              // a Pepe sync may (re)report today and the two days before it; older days only via the backfill

let clock = () => Date.now();

const ready = (async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS activity_days (userId TEXT NOT NULL, day TEXT NOT NULL, src TEXT NOT NULL, at INTEGER,
                  PRIMARY KEY (userId, day, src))`);
  await runQuery("CREATE INDEX IF NOT EXISTS activity_days_day ON activity_days (day)");
  await runQuery("CREATE TABLE IF NOT EXISTS streak_meta (k TEXT PRIMARY KEY, v TEXT)");
})().catch((e) => console.error("[streaks] init:", e));

// ── days ──
const FMT = new Map();
/** The local date 'YYYY-MM-DD' of a moment (ms) in a time zone (default the economy's). */
function dayOf(ms, tz = TZ) {
  let f = FMT.get(tz);
  if (!f) { f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }); FMT.set(tz, f); }
  const p = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}
/** 'YYYY-MM-DD' -> a day number (days since 1970-01-01, calendar arithmetic only - no time zone in it). */
const dn = (d) => Math.round(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5);
const dk = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
/** Monday-start week index of a day number (1970-01-01 was a Thursday). */
const weekOf = (n) => Math.floor((n + 3) / 7);
const today = () => dayOf(clock());

/**
 * The streak from a list of active days. Pure.
 * days: ['YYYY-MM-DD', ...] (any order, duplicates fine); on: the day to measure at (today); freezePerWeek: grace (0 = off).
 * -> { current, best, lastDay, startDay, todayDone, atRisk, frozen: [bridged days in the current run], pendingFreeze: [missed
 *      days a freeze is covering right now], days: active days in total }
 */
function compute(days, on, { freezePerWeek = 0 } = {}) {
  const t = dn(on);
  const act = [...new Set((days || []).filter((d) => DAY_RE.test(String(d))).map((d) => dn(String(d))))].filter((n) => n <= t).sort((a, b) => a - b);
  const empty = { current: 0, best: 0, lastDay: null, startDay: null, todayDone: false, atRisk: false, frozen: [], pendingFreeze: [], days: 0 };
  if (!act.length) return empty;
  const fpw = Math.max(0, Math.floor(Number(freezePerWeek) || 0));
  const used = new Map();                                   // week -> freezes spent
  const bridge = (from, to) => {                            // cover every missed day strictly between two days, or null
    if (!fpw) return null;
    const tmp = new Map(used), miss = [];
    for (let n = from + 1; n < to; n++) {
      const w = weekOf(n), c = tmp.get(w) || 0;
      if (c >= fpw) return null;
      tmp.set(w, c + 1);
      miss.push(n);
    }
    for (const [w, c] of tmp) used.set(w, c);
    return miss;
  };
  let run = 1, best = 1, start = act[0], frozen = [];
  for (let i = 1; i < act.length; i++) {
    if (act[i] - act[i - 1] === 1) run++;
    else {
      const m = bridge(act[i - 1], act[i]);
      if (m) { run++; frozen = frozen.concat(m); } else { run = 1; start = act[i]; frozen = []; }
    }
    if (run > best) best = run;
  }
  const last = act[act.length - 1];
  let current = run, alive = true, pending = [];
  if (last < t - 1) {
    const m = bridge(last, t);
    if (m) pending = m; else { current = 0; alive = false; }
  }
  return { current, best, lastDay: dk(last), startDay: alive ? dk(start) : null, todayDone: last === t, atRisk: alive && last !== t,
           frozen: alive ? frozen.map(dk) : [], pendingFreeze: pending.map(dk), days: act.length };
}

// ── config ──
let cfgCache = null;
async function config() {
  if (cfgCache) return cfgCache;
  await ready;
  const rows = await getQuery("SELECT k, v FROM streak_meta WHERE k = 'freeze_per_week'").catch(() => []);
  cfgCache = { freeze_per_week: Math.max(0, Math.min(7, Math.floor(Number(rows[0] && rows[0].v) || 0))) };
  return cfgCache;
}
async function setConfig(patch) {
  await ready;
  if (patch && patch.freeze_per_week != null) {
    const n = Math.max(0, Math.min(7, Math.floor(Number(patch.freeze_per_week) || 0)));
    await runQuery("INSERT INTO streak_meta (k, v) VALUES ('freeze_per_week', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [String(n)]);
  }
  cfgCache = null;
  return config();
}

// ── reading ──
async function daysOf(userId) {
  await ready;
  return (await getQuery("SELECT DISTINCT day FROM activity_days WHERE userId = ?", [String(userId)])).map((r) => r.day);
}
/** The streak of one account, as of now. */
async function forUser(userId) {
  if (!userId) return compute([], today());
  const c = await config();
  return compute(await daysOf(userId), today(), { freezePerWeek: c.freeze_per_week });
}
/** Today's sources for an account (the profile's "today: chat, spin" hint for the owner). */
async function sourcesOn(userId, day) {
  await ready;
  return (await getQuery("SELECT src FROM activity_days WHERE userId = ? AND day = ? ORDER BY at", [String(userId), day || today()])).map((r) => r.src);
}
/** The next milestone above `best` (null past the last). */
const nextMilestone = (n) => MILESTONES.find((m) => m > (Number(n) || 0)) || null;

// ── writing ──
const after = new Set();                 // hooks run when an account gets a NEW day (achievements poke)
function onNewDay(fn) { after.add(fn); }

/**
 * Note one qualifying action. -> true when this made a new (day, source) row, "day" when it was the account's first action
 * that day. Never throws (the action that called it must never fail because of a streak).
 */
async function touch(userId, src, { at, day } = {}) {
  try {
    if (!userId || !SRC.has(src) || isPepeId(userId)) return false;
    await ready;
    const ms = Number(at) || clock();
    const d = day && DAY_RE.test(day) ? day : dayOf(ms);
    const uid = String(userId);
    const r = await runQuery("INSERT OR IGNORE INTO activity_days (userId, day, src, at) VALUES (?, ?, ?, ?)", [uid, d, src, ms]);
    if (!r || !r.changes) return false;
    const n = await getQuery("SELECT COUNT(*) AS n FROM activity_days WHERE userId = ? AND day = ?", [uid, d]);
    if (Number(n[0] && n[0].n) !== 1) return true;
    for (const fn of after) { try { fn(uid, d); } catch (e) { /* never */ } }
    return "day";
  } catch (e) {
    console.error("[streaks] touch:", e.message);
    return false;
  }
}
/** Fire-and-forget touch for the hooks in other modules. */
function note(userId, src, opts) {
  if (!userId) return;
  Promise.resolve().then(() => touch(userId, src, opts)).catch(() => {});
}

// ── Pepe's logins -> accounts ──
const loginCache = new Map();            // login -> { id, at }
const LOGIN_TTL = 10 * 60 * 1000;
/** The account behind a Pepe record key: a Camfrog login (the real account before an auto "CF…" one) or "u:<userId>". */
async function accountOf(login) {
  const k = String(login || "").trim().toLowerCase();
  if (!k) return null;
  const m = ACCOUNT_KEY_RE.exec(k);
  const hit = loginCache.get(k);
  if (hit && clock() - hit.at < LOGIN_TTL) return hit.id;
  let id = null;
  if (m) {
    const r = await getQuery("SELECT userId FROM users WHERE LOWER(userId) = ?", [m[1].toLowerCase()]).catch(() => []);
    id = r[0] ? r[0].userId : null;
  } else if (LOGIN_RE.test(k)) {
    const r = await getQuery(`SELECT userId FROM users WHERE LOWER(camfrogUsername) = ?
                              ORDER BY CASE WHEN username LIKE 'CF%' THEN 1 ELSE 0 END LIMIT 1`, [k]).catch(() => []);
    id = r[0] ? r[0].userId : null;
  }
  loginCache.set(k, { id, at: clock() });
  if (loginCache.size > 5000) loginCache.delete(loginCache.keys().next().value);
  return id;
}

/** Is `day` within the live window (today and LIVE_DAYS before it, nothing in the future)? */
function liveDay(day) {
  if (!DAY_RE.test(String(day || ""))) return false;
  const t = dn(today()), n = dn(day);
  return n <= t && n >= t - LIVE_DAYS;
}

/**
 * Pepe's per-login day activity (econ.js participation rows, userstats.js day maps): [{login, day, src}].
 * Only days in the live window count here (old days come from the backfill). -> rows that were new
 */
async function fromLogins(items, { live = true } = {}) {
  let n = 0;
  for (const it of (Array.isArray(items) ? items : []).slice(0, 20000)) {
    if (!it || !SRC.has(it.src) || !DAY_RE.test(String(it.day || ""))) continue;
    if (live && !liveDay(it.day)) continue;
    const id = await accountOf(it.login);
    if (!id) continue;
    if (await touch(id, it.src, { day: it.day, at: it.at })) n++;
  }
  return n;
}

/** econ.js participation rows -> [{login, day, src}] (lines -> chat, mic minutes -> mic, commands -> cmd). */
function fromParticipation(rows) {
  const out = [];
  for (const x of Array.isArray(rows) ? rows : []) {
    if (!x || !x.login) continue;
    const login = String(x.login).toLowerCase();
    if ((Number(x.lines) || 0) > 0) out.push({ login, day: x.day, src: "chat" });
    if ((Number(x.mic_min) || 0) > 0) out.push({ login, day: x.day, src: "mic" });
    if ((Number(x.cmds) || 0) > 0) out.push({ login, day: x.day, src: "cmd" });
  }
  return out;
}

/** A cleaned userstats row (userstats.clean) -> [{login, day, src}] from its chat / mic / command day maps. */
function fromUserstats(row, { all = false } = {}) {
  const out = [];
  if (!row || !row.login) return out;
  for (const [key, src] of [["chat", "chat"], ["mic", "mic"], ["cmds", "cmd"]]) {
    const days = (row[key] && row[key].days) || {};
    for (const [d, v] of Object.entries(days)) {
      if (!(Number(v) > 0) || !DAY_RE.test(d)) continue;
      if (!all && !liveDay(d)) continue;
      out.push({ login: row.login, day: d, src });
    }
  }
  return out;
}

// ── the one-off history import + quiet milestones ──
const tsMs = (ts) => {
  if (ts == null) return NaN;
  if (typeof ts === "number") return ts < 1e11 ? ts * 1000 : ts;
  const s = String(ts).trim();
  if (/^\d+(\.\d+)?$/.test(s)) { const n = Number(s); return n < 1e11 ? n * 1000 : n; }
  return Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z");
};

async function insertMany(rows) {
  let n = 0;
  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400);
    await tx(async () => {
      for (const r of chunk) {
        const q = await runQuery("INSERT OR IGNORE INTO activity_days (userId, day, src, at) VALUES (?, ?, ?, ?)", [r.userId, r.day, r.src, r.at || null]);
        n += (q && q.changes) || 0;
      }
    });
  }
  return n;
}

let backfilling = null;
/** Once: import the history every source still has, then give the milestones it reached quietly. */
function backfill({ force = false } = {}) {
  if (backfilling && !force) return backfilling;
  backfilling = (async () => {
    await ready;
    await runQuery("CREATE TABLE IF NOT EXISTS achievement_meta (k TEXT PRIMARY KEY, v TEXT)");
    const done = await getQuery("SELECT v FROM achievement_meta WHERE k = ?", [BACKFILL_FLAG]);
    if (done.length && !force) return { done: true, already: true };
    await loadPepeIds();
    const rows = [];
    const add = (userId, day, src, at) => { if (userId && DAY_RE.test(String(day)) && SRC.has(src)) rows.push({ userId: String(userId), day, src, at }); };
    // Pepe's analytics (90 days per login, his local day = Eastern) and his per-room participation (Eastern)
    for (const r of await getQuery("SELECT login, data FROM camfrog_userstats").catch(() => [])) {
      let row; try { row = JSON.parse(r.data); } catch (e) { continue; }
      const id = await accountOf(r.login);
      if (!id) continue;
      for (const x of fromUserstats(row, { all: true })) add(id, x.day, x.src, null);
    }
    const part = await getQuery(`SELECT login, day, SUM(lines) AS lines, SUM(mic_min) AS mic_min, SUM(cmds) AS cmds
                                 FROM econ_participation GROUP BY login, day`).catch(() => []);
    for (const x of fromParticipation(part)) {
      const id = await accountOf(x.login);
      if (id) add(id, x.day, x.src, null);
    }
    // the site's own records: hour buckets (UTC) -> the Eastern day (offsets are whole hours)
    const hours = async (sql, src) => {
      for (const r of await getQuery(sql).catch(() => [])) {
        const ms = tsMs(r.h);
        if (Number.isFinite(ms)) add(r.u, dayOf(ms), src, ms);
      }
    };
    await hours(`SELECT author_id AS u, (created / 3600000) * 3600000 AS h FROM feed_posts WHERE deleted_at IS NULL GROUP BY author_id, created / 3600000`, "post");
    await hours(`SELECT author_id AS u, (created / 3600000) * 3600000 AS h FROM feed_comments WHERE deleted_at IS NULL GROUP BY author_id, created / 3600000`, "comment");
    await hours(`SELECT userId AS u, substr(timestamp, 1, 13) || ':00:00' AS h FROM wheel_spins WHERE result = 'SETTLED' GROUP BY userId, substr(timestamp, 1, 13)`, "spin");
    await hours(`SELECT userId AS u, substr(timestamp, 1, 13) || ':00:00' AS h FROM transactions WHERE type = 'tip sent' GROUP BY userId, substr(timestamp, 1, 13)`, "tip");
    const known = new Set((await getQuery("SELECT userId FROM users").catch(() => [])).map((r) => String(r.userId)));
    const keep = rows.filter((r) => known.has(r.userId) && !isPepeId(r.userId));
    const inserted = await insertMany(keep);
    // the milestones history already reached: badge only (no XP, PAT or announcement)
    const A = require("./achievements");
    await A.ready;
    const ach = A.list().filter((a) => a.side === "web" && a.metric === METRIC);
    const c = await config();
    const users = [...new Set(keep.map((r) => r.userId))];
    const given = [];
    for (const id of users) {
      const s = compute(await daysOf(id), today(), { freezePerWeek: c.freeze_per_week });
      for (const a of ach) {
        if (s.best < (a.threshold || 1)) continue;
        const r = await A.award({ userId: id }, a.id, null, { silent: true });
        if (r.ok && r.awarded) given.push({ userId: id, badgeId: a.id });
      }
    }
    const by = {};
    for (const g of given) by[g.badgeId] = (by[g.badgeId] || 0) + 1;
    const rec = { at: new Date(clock()).toISOString(), rows: keep.length, inserted, accounts: users.length, given: given.length, by };
    await runQuery("INSERT OR REPLACE INTO achievement_meta (k, v) VALUES (?, ?)", [BACKFILL_FLAG, JSON.stringify(rec)]);
    console.log(`[streaks] backfill: ${inserted} day row(s) for ${users.length} account(s); ${given.length} milestone badge(s) given quietly ${JSON.stringify(by)}`);
    return Object.assign({ done: true }, rec);
  })().catch((e) => { backfilling = null; throw e; });
  return backfilling;
}
async function backfilled() {
  await ready;
  const r = await getQuery("SELECT 1 FROM achievement_meta WHERE k = ?", [BACKFILL_FLAG]).catch(() => []);
  return r.length > 0;
}

// Pepe / platform bot accounts never hold a streak (the feed hooks skip Pepe already; this covers the imports)
let pepeIds = null;
function isPepeId(id) { return String(id) === "pepe-bot" || !!(pepeIds && pepeIds.has(String(id))); }
async function loadPepeIds() {
  const r = await getQuery("SELECT userId FROM users WHERE LOWER(username) IN ('pepe', 'pepebot', 'pepebeta') OR LOWER(camfrogUsername) IN ('pepe', 'pepebot', 'pepebeta')").catch(() => []);
  pepeIds = new Set(["pepe-bot", ...r.map((x) => String(x.userId))]);       // feedstore.js PEPE_ID = "pepe-bot"
}

/** achievements.js webMetrics: the best run, once the backfill has run (0 before, so nothing old is announced). */
async function metric(userId) {
  if (!(await backfilled())) return 0;
  return (await forUser(userId)).best;
}

// ── the API ──
/** The streak answer for an account: public fields only. */
async function card(user, { self = false } = {}) {
  const s = await forUser(user.userId);
  let hidden = false;
  if (!self) {
    try {
      const PL = require("./profilelayout");
      hidden = PL.stateOf(await PL.get(user.userId), "streak") === "hidden";
    } catch (e) { hidden = false; }
  }
  const LT = require("./leveltiers");
  const base = { ok: true, username: user.username, displayname: user.displayname || null, level: Number(user.level) || 0,
                 tier: LT.forApi(user.level) };
  if (hidden) return Object.assign(base, { hidden: true });
  return Object.assign(base, { current: s.current, best: s.best, todayDone: s.todayDone, atRisk: s.atRisk, lastDay: s.lastDay,
                               startDay: s.startDay, next: nextMilestone(s.best), today: today() });
}

function register(app, { addUser, isBotToken }) {
  setImmediate(() => loadPepeIds().catch(() => {}));
  // Pepe's !streak [@user]: {password, login | username, self}
  app.post("/api/streaks/bot/lookup", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try {
      let user = null;
      if (b.login) {
        const id = await accountOf(b.login);
        if (id) user = (await getQuery("SELECT userId, username, displayname, level FROM users WHERE userId = ?", [id]))[0] || null;
      }
      if (!user && b.username) {
        user = (await getQuery("SELECT userId, username, displayname, level FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(camfrogUsername) = LOWER(?) ORDER BY CASE WHEN username LIKE 'CF%' THEN 1 ELSE 0 END LIMIT 1",
          [String(b.username), String(b.username)]))[0] || null;
      }
      if (!user) return res.status(404).json({ ok: false, error: "no such account" });
      res.json(await card(user, { self: !!b.self }));
    } catch (e) {
      console.error("[streaks] lookup:", e.message);
      res.status(500).json({ ok: false });
    }
  });
  // the signed-in member's own streak (+ today's sources)
  app.get("/api/streaks/me", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.user) return res.status(401).json({ ok: false });
    try {
      const u = (await getQuery("SELECT userId, username, displayname, level FROM users WHERE userId = ?", [req.user.userId]))[0];
      if (!u) return res.status(404).json({ ok: false });
      res.json(Object.assign(await card(u, { self: true }), { sources: await sourcesOn(u.userId) }));
    } catch (e) { res.status(500).json({ ok: false }); }
  });
  // admins: the grace rule
  app.get("/api/admin/streaks/config", addUser, async (req, res) => {
    if (!SP.can(req.user, "games.config")) return res.status(403).json({ ok: false });
    res.json(Object.assign({ ok: true }, await config(), { milestones: MILESTONES, sources: SOURCES, backfill: await backfilled() }));
  });
  app.post("/api/admin/streaks/config", addUser, async (req, res) => {
    if (!SP.can(req.user, "games.config")) return res.status(403).json({ ok: false });
    if (!require("./middleware/authGuard").sameSite(req)) return res.status(403).json({ ok: false });
    res.json(Object.assign({ ok: true }, await setConfig(req.body || {})));
  });
}

// a new day for an account -> the 🔥 milestone achievements get a look (achievements.checkWeb, fire-and-forget)
onNewDay((userId) => { try { require("./achievements").poke(userId); } catch (e) { /* never */ } });

if (!process.env.NODE_TEST_CONTEXT) {
  const kick = setTimeout(() => backfill().catch((e) => console.error("[streaks] backfill:", e.message)), 110e3);
  if (kick.unref) kick.unref();
}

module.exports = { ready, compute, dayOf, dn, dk, weekOf, touch, note, forUser, sourcesOn, config, setConfig, accountOf, fromLogins,
                   fromParticipation, fromUserstats, backfill, backfilled, metric, card, register, onNewDay, nextMilestone,
                   SOURCES, MILESTONES, METRIC, TZ, BACKFILL_FLAG,
                   _setClock: (f) => { clock = f; loginCache.clear(); }, _clearCache: () => { cfgCache = null; loginCache.clear(); } };
