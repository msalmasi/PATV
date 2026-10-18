// plexstats.js — 1.99nj: 📼 Plex watch stats on profiles, from Tautulli (the Plex server's watch history).
//
// WHO: an account with a PROVEN Plex link only - a plex_members row whose link_source is self / admin / wizarr / overseerr
// (the same rule as Sign in with Plex, plexsso.js). The sync's verified-email guess and any same-name match never count:
// watch history is personal, so it is never attached to an account by a guess. Tautulli's user_id IS the Plex account id
// (plex_members.plex_id), so no name matching happens anywhere.
//
// SYNC (never per page view): every TAUTULLI_SYNC_MIN minutes (default 60; first run a few minutes after boot), plus
// "Sync now" for admins (POST /api/media/admin/plexstats/sync). Per linked account, read-only Tautulli calls:
//   get_user_watch_time_stats (today / 7 / 30 days / all time), get_user_player_stats (platforms - never device names),
//   get_history (the last HISTORY_LEN plays: recently watched, the streak, favourites, genres), get_home_stats with the
//   user filter (top movies / top shows - each row must also be in their history, or it's dropped: an old Tautulli that
//   ignores the filter would otherwise show the whole server's favourites), and once per sync for everyone
//   get_libraries + get_library_user_stats (plays + time per library per user). Genres come from the titles' metadata
//   (plexpad.js plex_meta, filled through Tautulli get_metadata and cached).
// The result is one JSON row per account in plex_watch_stats; a failed sync keeps the last good data (+ the error).
//
// PRIVACY: the profile's 📼 Plex tab has two panels with Public / Only me & admins / Hidden (profilelayout.js PRIV),
// both "Only me & admins" by default (px_watch: these stats; px_pads: what they put on PATV pads). The server only loads a
// panel's data when this viewer may see it (forProfile takes the layout's show()).
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)
const tautulli = require("./tautulli");

const TRUSTED = ["self", "admin", "wizarr", "overseerr"];
const HISTORY_LEN = 1000;
const FAV_RANGE_DAYS = 3650;
const GENRE_LOOKUPS = 25;           // titles per account whose genres we look up per sync (the rest wait for the next one)
const DAY = 24 * 3600 * 1000;
let clock = () => Date.now();
const syncMin = () => Math.max(15, Math.min(24 * 60, Number(process.env.TAUTULLI_SYNC_MIN) || 60));

let ready = null;
function init() {
  if (!ready) {
    ready = runQuery(`CREATE TABLE IF NOT EXISTS plex_watch_stats (
      user_id TEXT PRIMARY KEY, plex_ids TEXT, data TEXT, synced_at INTEGER, error TEXT, error_at INTEGER)`).catch((e) => { ready = null; throw e; });
  }
  return ready;
}
const J = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } };
const T = (cmd, p) => tautulli.call(cmd, p, { timeout: 30000 });
const arr = (v) => (Array.isArray(v) ? v : []);

/** PATV account -> its proven Plex account ids (never a guess). */
async function linkedIds(userId) {
  const rows = await getQuery(`SELECT plex_id FROM plex_members WHERE user_id = ? AND link_source IN (${TRUSTED.map(() => "?").join(",")})`,
                              [String(userId), ...TRUSTED]).catch(() => []);
  return rows.map((r) => String(r.plex_id)).filter((x) => /^\d{1,15}$/.test(x));
}
async function linkedAccounts() {
  const rows = await getQuery(`SELECT m.user_id, m.plex_id FROM plex_members m JOIN users u ON u.userId = m.user_id
                               WHERE m.user_id IS NOT NULL AND m.link_source IN (${TRUSTED.map(() => "?").join(",")})`, TRUSTED).catch(() => []);
  const by = new Map();
  for (const r of rows) if (/^\d{1,15}$/.test(String(r.plex_id))) (by.get(r.user_id) || by.set(r.user_id, []).get(r.user_id)).push(String(r.plex_id));
  return by;
}

// ── pure helpers (tested) ──
function dayKey(ms, zone) {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: zone || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms)); }
  catch (e) { return new Date(ms).toISOString().slice(0, 10); }
}
const dayNum = (k) => Math.round(Date.parse(k + "T00:00:00Z") / DAY);
/** Days with at least one play -> {best, current, last} (current counts back from the last day; forProfile drops it when stale). */
function streak(msList, zone) {
  const days = [...new Set(msList.filter((x) => x > 0).map((ms) => dayNum(dayKey(ms, zone))))].sort((a, b) => a - b);
  if (!days.length) return { best: 0, current: 0, last: null };
  let best = 1, run = 1;
  for (let i = 1; i < days.length; i++) { run = days[i] === days[i - 1] + 1 ? run + 1 : 1; best = Math.max(best, run); }
  let cur = 1;
  for (let i = days.length - 1; i > 0 && days[i - 1] === days[i] - 1; i--) cur++;
  return { best, current: cur, last: days[days.length - 1] };
}
/** The history's plays grouped into works (a movie, a show) by time watched. */
function favourites(history) {
  const works = new Map();
  for (const h of history) {
    const type = h.media_type;
    if (!["movie", "episode"].includes(type)) continue;
    const key = type === "episode" ? String(h.grandparent_rating_key || h.grandparent_title || "") : String(h.rating_key || h.title || "");
    if (!key) continue;
    const w = works.get(type + ":" + key) || { type: type === "episode" ? "show" : "movie", key, title: type === "episode" ? h.grandparent_title : h.title,
                                               year: type === "movie" ? Number(h.year) || null : null, plays: 0, seconds: 0, rating_key: String(h.rating_key || "") };
    w.plays++;
    w.seconds += Number(h.play_duration != null ? h.play_duration : h.duration) || 0;
    works.set(type + ":" + key, w);
  }
  return [...works.values()].sort((a, b) => b.seconds - a.seconds || b.plays - a.plays);
}
const histDuration = (h) => Number(h.play_duration != null ? h.play_duration : h.duration) || 0;

/** get_home_stats rows of one stat that also appear in the user's own history (see the header). */
function checkedHome(home, statId, history) {
  const stat = arr(home).find((s) => s && s.stat_id === statId);
  if (!stat) return null;
  const mine = new Set();
  for (const h of history) { if (h.rating_key) mine.add(String(h.rating_key)); if (h.grandparent_rating_key) mine.add(String(h.grandparent_rating_key)); }
  return arr(stat.rows).filter((r) => mine.has(String(r.rating_key || "")) || mine.has(String(r.grandparent_rating_key || "")))
    .map((r) => ({ title: String(r.title || r.grandparent_title || "").slice(0, 120), year: Number(r.year) || null, plays: Number(r.total_plays) || 0,
                   seconds: Number(r.total_duration) || 0 }));
}

// ── one account ──
async function build(userId, plexIds, shared) {
  const watch = { today: { s: 0, n: 0 }, week: { s: 0, n: 0 }, month: { s: 0, n: 0 }, all: { s: 0, n: 0 } };
  const platforms = new Map();
  let history = [];
  const homeRows = { top_movies: [], top_tv: [] };
  let homeOk = { top_movies: false, top_tv: false };
  let found = false;
  for (const id of plexIds) {
    if (shared.users && !shared.users.has(id)) continue;          // not a user Tautulli knows
    found = true;
    for (const r of arr(await T("get_user_watch_time_stats", { user_id: id, query_days: "1,7,30,0" }))) {
      const k = { 1: "today", 7: "week", 30: "month", 0: "all" }[Number(r.query_days)];
      if (k) { watch[k].s += Number(r.total_time) || 0; watch[k].n += Number(r.total_plays) || 0; }
    }
    for (const r of arr(await T("get_user_player_stats", { user_id: id }))) {
      const name = String(r.platform_name || r.platform || "").slice(0, 40);      // a platform, never the device's own name
      if (name) platforms.set(name, (platforms.get(name) || 0) + (Number(r.total_plays) || 0));
    }
    const h = await T("get_history", { user_id: id, length: HISTORY_LEN, order_column: "date", order_dir: "desc" });
    history = history.concat(arr(h && h.data));
    const home = await T("get_home_stats", { user_id: id, time_range: FAV_RANGE_DAYS, stats_type: "duration", stats_count: 10 }).catch(() => null);
    for (const sid of ["top_movies", "top_tv"]) {
      const rows = checkedHome(home, sid, arr(h && h.data));
      if (rows) { homeOk[sid] = true; homeRows[sid] = homeRows[sid].concat(rows); }
    }
  }
  if (!found) return { found: false };
  history.sort((a, b) => (Number(b.started || b.date) || 0) - (Number(a.started || a.date) || 0));
  const zone = (() => { try { const tz = require("./tz"); return tz.getPref(userId) || "UTC"; } catch (e) { return "UTC"; } })();
  const st = streak(history.map((x) => (Number(x.started || x.date) || 0) * 1000), zone);
  const works = favourites(history);
  // Tautulli's (checked) favourites first, then filled up from their own history: a long-time viewer's all-time favourites
  // are often older than the history we read, so the checked ones alone can leave the list short
  const fav = (type, sid) => {
    const out = homeOk[sid] ? homeRows[sid].slice() : [];
    const seen = new Set(out.map((x) => x.title.toLowerCase()));
    for (const w of works.filter((x) => x.type === type)) {
      const title = String(w.title || "").slice(0, 120);
      if (!title || seen.has(title.toLowerCase())) continue;
      seen.add(title.toLowerCase());
      out.push({ title, year: w.year, plays: w.plays, seconds: w.seconds });
    }
    return out.slice(0, 5);
  };
  // genres, weighted by time watched, from the top works' metadata (plexpad's cached plex_meta)
  const PP = require("./plexpad");
  await PP.init();
  const genreSec = new Map();
  let looked = 0;
  for (const w of works.slice(0, 60)) {
    const key = w.type === "show" ? (w.key && /^\d+$/.test(w.key) ? w.key : null) : w.rating_key;
    if (!key) continue;
    let m = (await getQuery("SELECT genres, taut_ok FROM plex_meta WHERE rating_key = ?", [key]))[0];
    if ((!m || !m.taut_ok) && looked < GENRE_LOOKUPS) { looked++; await PP.enrich(key).catch(() => false); m = (await getQuery("SELECT genres FROM plex_meta WHERE rating_key = ?", [key]))[0]; }
    for (const g of J(m && m.genres, [])) genreSec.set(g, (genreSec.get(g) || 0) + w.seconds);
  }
  const gTotal = [...genreSec.values()].reduce((s, x) => s + x, 0) || 1;
  // libraries: per-library totals for this user's ids (get_library_user_stats, read once per sync)
  const libs = [];
  for (const L of shared.libraries || []) {
    let plays = 0, sec = 0;
    for (const id of plexIds) { const r = (L.users || new Map()).get(id); if (r) { plays += r.plays; sec += r.seconds; } }
    if (plays) libs.push({ name: L.name, type: L.type, plays, seconds: sec });
  }
  libs.sort((a, b) => b.seconds - a.seconds || b.plays - a.plays);
  const recent = history.slice(0, 8).map((x) => ({
    title: String(x.full_title || x.title || "").slice(0, 140), type: x.media_type === "episode" ? "episode" : x.media_type === "movie" ? "movie" : "other",
    year: Number(x.year) || null, at: (Number(x.started || x.date) || 0) * 1000, pct: Math.max(0, Math.min(100, Number(x.percent_complete) || 0)),
    done: Number(x.watched_status) === 1 }));
  return {
    found: true,
    total_seconds: watch.all.s, total_plays: watch.all.n, month_seconds: watch.month.s, month_plays: watch.month.n,
    week_seconds: watch.week.s, week_plays: watch.week.n,
    movies: history.filter((x) => x.media_type === "movie").length, episodes: history.filter((x) => x.media_type === "episode").length,
    history_seconds: history.reduce((s, x) => s + histDuration(x), 0), history_n: history.length,
    streak: st, zone,
    genres: [...genreSec.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, s]) => ({ name: String(name).slice(0, 40), pct: Math.round((s / gTotal) * 100) })),
    libraries: libs.slice(0, 6),
    top_movies: fav("movie", "top_movies"), top_shows: fav("show", "top_tv"),
    platforms: [...platforms.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, plays]) => ({ name, plays })),
    recent,
  };
}

/** What every account's sync shares: Tautulli's users + each library's per-user totals. */
async function shared() {
  const out = { users: null, libraries: [] };
  const users = await T("get_users", {}).catch(() => null);
  if (Array.isArray(users)) out.users = new Set(users.map((u) => String(u.user_id)));
  for (const L of arr(await T("get_libraries", {}).catch(() => []))) {
    if (!["movie", "show"].includes(L.section_type)) continue;
    const rows = arr(await T("get_library_user_stats", { section_id: L.section_id }).catch(() => []));
    out.libraries.push({ name: String(L.section_name || "").slice(0, 60), type: L.section_type,
                         users: new Map(rows.map((r) => [String(r.user_id), { plays: Number(r.total_plays) || 0, seconds: Number(r.total_time) || 0 }])) });
  }
  return out;
}

let syncing = null, lastRun = null;
/** Sync every linked account (or one: {userId}). */
function sync({ userId = null, actor = "system" } = {}) {
  if (syncing) return syncing;
  syncing = (async () => {
    await init();
    if (!tautulli.configured()) return { ok: false, configured: false, error: "Tautulli isn't configured (TAUTULLI_URL, TAUTULLI_API_KEY)." };
    const t0 = clock();
    const sh = await shared();
    const all = await linkedAccounts();
    const ids = userId ? (all.has(String(userId)) ? [String(userId)] : []) : [...all.keys()];
    let ok = 0, failed = 0, none = 0;
    for (const u of ids) {
      const plexIds = all.get(u);
      try {
        const data = await build(u, plexIds, sh);
        if (!data.found) none++;
        await runQuery(`INSERT INTO plex_watch_stats (user_id, plex_ids, data, synced_at, error, error_at) VALUES (?, ?, ?, ?, NULL, NULL)
                        ON CONFLICT(user_id) DO UPDATE SET plex_ids = excluded.plex_ids, data = excluded.data, synced_at = excluded.synced_at, error = NULL, error_at = NULL`,
                       [u, JSON.stringify(plexIds), JSON.stringify(data), clock()]);
        ok++;
      } catch (e) {
        failed++;
        await runQuery(`INSERT INTO plex_watch_stats (user_id, plex_ids, error, error_at) VALUES (?, ?, ?, ?)
                        ON CONFLICT(user_id) DO UPDATE SET error = excluded.error, error_at = excluded.error_at`,
                       [u, JSON.stringify(plexIds), String(e.message || e).slice(0, 200), clock()]).catch(() => {});
      }
    }
    // a link that's gone (unlinked, merged away) takes its cached stats with it
    if (!userId) {
      const keep = new Set(all.keys());
      for (const r of await getQuery("SELECT user_id FROM plex_watch_stats").catch(() => [])) {
        if (!keep.has(r.user_id)) await runQuery("DELETE FROM plex_watch_stats WHERE user_id = ?", [r.user_id]).catch(() => {});
      }
    }
    lastRun = { at: clock(), ms: clock() - t0, accounts: ids.length, synced: ok, failed, not_in_tautulli: none, actor };
    console.log(`[plexstats] sync: ${ok} account(s) ok, ${failed} failed, ${none} not in Tautulli (${lastRun.ms} ms)`);
    return { ok: true, ...lastRun };
  })().finally(() => { syncing = null; });
  return syncing;
}

/**
 * The profile's 📼 Plex tab for one viewer. show(id) = profilelayout view().show - a panel's data is only loaded when
 * this viewer may see it. -> null when there is nothing to show at all.
 */
async function forProfile(userId, { show = () => true, owner = false } = {}) {
  await init();
  const out = { linked: false, configured: tautulli.configured(), watch: null, pads: null, synced_at: null, owner };
  const ids = await linkedIds(userId);
  out.linked = ids.length > 0;
  if (show("px_watch") && out.linked) {
    const r = (await getQuery("SELECT data, synced_at, error FROM plex_watch_stats WHERE user_id = ?", [String(userId)]))[0];
    const d = r ? J(r.data, null) : null;
    if (d && d.found) {
      // the streak only counts while it's alive: a last play before yesterday (their zone) = 0 now
      const today = dayNum(dayKey(clock(), d.zone));
      if (d.streak && d.streak.last != null && today - d.streak.last > 1) d.streak = { ...d.streak, current: 0 };
      out.watch = d;
    } else if (d && !d.found) out.watch = { found: false };
    out.synced_at = r ? r.synced_at : null;
  }
  if (show("px_pads")) {
    try {
      const p = await require("./plexpad").profileStats(userId);
      if (p.plays || (owner && out.linked)) out.pads = p;
    } catch (e) { out.pads = null; }
  }
  // nothing to show: no tab (a linked owner still gets it - it says when the stats arrive)
  if (!out.watch && !out.pads && !(owner && out.linked)) return null;
  return out;
}

let timer = null;
function start() {
  if (timer || process.env.NODE_TEST_CONTEXT) return;
  let last = 0;
  const run = () => {
    if (!tautulli.configured() || clock() - last < syncMin() * 60000 - 30000) return;
    last = clock();
    sync().catch((e) => console.error("[plexstats] sync:", String(e.message || e).slice(0, 200)));
  };
  const t0 = setTimeout(run, 3 * 60 * 1000);
  if (t0.unref) t0.unref();
  timer = setInterval(run, 5 * 60 * 1000);
  if (timer.unref) timer.unref();
}

function register(app, { addUser, noTimers } = {}) {
  init().catch((e) => console.error("[plexstats] init:", e.message));
  if (!noTimers) { start(); require("./plexpad").start(); }
  const conf = require("./mediaconf");
  const guard = require("./middleware/authGuard");
  const admin = (req, res, next) => {
    if (!SP.can(req.user, "media.admin")) return res.status(403).json({ ok: false, error: "Admins only." });
    if (req.method === "POST" && !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    res.set("Cache-Control", "no-store");
    next();
  };
  app.get("/api/media/admin/plexstats", addUser, admin, async (req, res) => {
    try {
      await init();
      const rows = await getQuery(`SELECT s.user_id, u.username, s.synced_at, s.error, s.error_at, json_extract(s.data, '$.found') AS found
                                   FROM plex_watch_stats s LEFT JOIN users u ON u.userId = s.user_id ORDER BY u.username`);
      res.json({ ok: true, configured: tautulli.configured(), every_min: syncMin(), last: lastRun, accounts: rows });
    } catch (e) { res.status(500).json({ ok: false, error: "Something went wrong." }); }
  });
  app.post("/api/media/admin/plexstats/sync", addUser, admin, async (req, res) => {
    try { res.json(await sync({ actor: req.user.username, userId: (req.body || {}).user_id || null })); }
    catch (e) { res.status(502).json({ ok: false, error: String(e.message || "sync failed").slice(0, 200) }); }
  });
}

module.exports = { init, register, sync, forProfile, build, shared, linkedIds, streak, favourites, checkedHome, dayKey, TRUSTED,
                   _setClock: (fn) => { clock = fn || (() => Date.now()); }, _lastRun: () => lastRun };
