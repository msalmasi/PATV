// pvpcfg.js — 1.99yc: the admins' knobs for Pepe's PvP challenges (!duel / !brawl, camfrog-bot pepe_pvp.py).
//
// The challenges themselves run in Pepe (ids X<n>, escrowed stakes, !accept / !decline / !withdraw). Two prod reports
// shaped these knobs: a bare !accept that took a challenge the challenger had just swapped in (X111 -> X113 -> X114, a
// small duel replaced by a brawl right before the target answered), and the replace spam that made it possible.
//
//   accept_quiet_secs    a bare `!accept` takes the one challenge waiting on you only when nothing aimed at you changed
//                        (made / replaced / withdrawn) in this many seconds; otherwise Pepe shows the terms and wants
//                        `!accept X114`. 0 = off. Default 15, 0 .. 300.
//   replace_max          challenges + replacements one challenger may aim at the same target ...
//   replace_window_secs  ... per this many seconds. Default 3 per 120 s; 1 .. 20, 30 .. 3600 s.
//
// 1.99aco: the win-streak achievements' anti-farming knobs (the duel / brawl "N in a row" badges; Pepe 1.99acn,
// pepe_pvpstreak.py). A win that fails one of them neither extends nor breaks the winner's streak (the loser's resets):
//   streak_min_stake        the stake (each side) a game needs to count. Default 10,000 PAT (= the achievement texts),
//                           1,000 .. 10,000,000 - free 1-PAT duel rings can't build a streak.
//   streak_min_acct_days    the opponent's PATV account must be this many days old ... Default 14, 0 .. 365.
//   streak_min_level        ... and at least this level. Default 5, 0 .. 1000. An unknown age / level never counts
//                           (throwaway Camfrog logins get an auto account the first time Pepe looks them up).
//   streak_min_sheet_games  brawls: the opponent's sheet must have this many heists + brawls + arena wins. Default 10.
//   streak_max_gap          brawls: the loser's clash strength (sum of the sheet's clash modifiers + arena gear) may be
//                           at most this far below the winner's - a thrown or hopeless fight doesn't count. Default 6, 0 .. 60.
//
// Pepe reads them with POST /api/pvp/cfg every 10 minutes (and keeps his built-in defaults, the same as DEFAULTS
// here, when the site doesn't answer). The clamp is the same on both sides (pepe_pvp.PVP_CFG_LIMITS).
//
//   GET  /api/admin/pvp-cfg   (admins)                        -> {ok, cfg, defaults, limits}
//   POST /api/admin/pvp-cfg   (admins, same-site fetch JSON)   {any of the knobs} -> {ok, cfg}
//   POST /api/pvp/cfg         (Pepe, bot token)                -> {ok, ...every knob}
//
// The card is on /admin/games#pvp (views/partials/admin-pvpcfg.ejs) - never on a public page.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

const DEFAULTS = { accept_quiet_secs: 15, replace_max: 3, replace_window_secs: 120,
  streak_min_stake: 10000, streak_min_acct_days: 14, streak_min_level: 5, streak_min_sheet_games: 10, streak_max_gap: 6 };
const LIMITS = { accept_quiet_secs: [0, 300], replace_max: [1, 20], replace_window_secs: [30, 3600],
  streak_min_stake: [1000, 10000000], streak_min_acct_days: [0, 365], streak_min_level: [0, 1000], streak_min_sheet_games: [0, 1000],
  streak_max_gap: [0, 60] };

let ready = null;
function init() {
  if (!ready) ready = runQuery("CREATE TABLE IF NOT EXISTS pvp_cfg (key TEXT PRIMARY KEY, value TEXT)").catch((e) => { ready = null; throw e; });
  return ready;
}

/** Every knob clamped to LIMITS; missing / junk = the default. */
function clean(c) {
  const out = { ...DEFAULTS };
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    const v = c && c[k] !== undefined && c[k] !== null && c[k] !== "" ? Math.floor(Number(c[k])) : NaN;
    if (Number.isFinite(v)) out[k] = Math.max(lo, Math.min(hi, v));
  }
  return out;
}

let cache = null, cacheAt = 0;
/** The current knobs (cached 30 s). */
async function get() {
  if (cache && Date.now() - cacheAt < 30000) return cache;
  await init();
  const row = (await getQuery("SELECT value FROM pvp_cfg WHERE key = 'cfg'"))[0];
  let raw = null;
  try { raw = row ? JSON.parse(row.value) : null; } catch (e) { raw = null; }
  cache = clean(raw);
  cacheAt = Date.now();
  return cache;
}

async function set(patch) {
  await init();
  const cur = await get();
  const next = clean({ ...cur, ...(patch || {}) });
  await runQuery("INSERT INTO pvp_cfg (key, value) VALUES ('cfg', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(next)]);
  cache = next;
  cacheAt = Date.now();
  return next;
}

function register(app, { isBotToken, addUser }) {
  app.post("/api/pvp/cfg", async (req, res) => {
    if (!isBotToken((req.body || {}).password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json({ ok: true, ...(await get()) }); } catch (e) { res.status(500).json({ ok: false, error: "server_error" }); }
  });
  const admin = async (req, res) => {
    if (!req.user || !req.user.userId) { res.status(401).json({ ok: false }); return false; }
    const row = (await getQuery("SELECT class FROM users WHERE userId = ?", [req.user.userId]).catch(() => []))[0];
    if (!SP.can(row, "games.config")) { res.status(403).json({ ok: false, error: "Admins only." }); return false; }
    return true;
  };
  app.get("/api/admin/pvp-cfg", addUser, async (req, res) => {
    if (!(await admin(req, res))) return;
    res.json({ ok: true, cfg: await get(), defaults: DEFAULTS, limits: LIMITS });
  });
  app.post("/api/admin/pvp-cfg", addUser, async (req, res) => {
    if (!(await admin(req, res))) return;
    if (req.get("X-Requested-With") !== "fetch" || !require("./middleware/authGuard").sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    const b = req.body || {};
    const patch = {};
    for (const k of Object.keys(LIMITS)) if (Object.prototype.hasOwnProperty.call(b, k)) patch[k] = b[k];   // a missing knob keeps its value
    const cfg = await set(patch);
    console.log(`[pvpcfg] ${req.user.username || req.user.userId}: quiet ${cfg.accept_quiet_secs}s, ${cfg.replace_max} per ${cfg.replace_window_secs}s; ` +
      `streaks: ${cfg.streak_min_stake}+ PAT, ${cfg.streak_min_acct_days}+ days, level ${cfg.streak_min_level}+, ${cfg.streak_min_sheet_games}+ sheet games, gap <= ${cfg.streak_max_gap}`);
    await require("./adminaudit").record(req.user, "pvp-cfg", null, cfg).catch((e) => console.warn(`[pvpcfg] audit: ${e.message}`));
    res.json({ ok: true, cfg });
  });
}

module.exports = { register, get, set, clean, DEFAULTS, LIMITS, _reset: () => { cache = null; } };
