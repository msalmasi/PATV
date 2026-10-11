// plexpad.js — 1.99nj: 📼 Plex-on-pads achievements, counted from the site's OWN play records (media_plays: every title
// put on a pad's stage with 📼 Play from Plex, single plays and queues alike) - not from Tautulli, which never sees them
// (mediactl reads the files itself, outside Plex's player).
//
// WHAT COUNTS (anti-farming): a play counts once it has ENDED and actually aired: its slot went live and it was on air
// for at least 10 minutes, or half the title's runtime if that's shorter (min(600 s, runtime / 2)). "On air" = how far the
// title got from where it started (the end for a finished one), never more than the wall-clock time it ran - so a seek to
// the end doesn't count as watching it. A resume on a fresh slot (carried_from) continues its first play: one play.
//
// METADATA (plex_meta, one row per Plex rating key; plex_seasons for season sizes):
//   * at play time medialib / mediaqueue hand us the item they already fetched from mediactl (noteItem): type, year,
//     show / season keys, the first audio track's language;
//   * then the enrichment job adds what only the Plex metadata has, through Tautulli (tautulli.js, when configured):
//     genres, collections, studio, the server-wide play count (get_metadata, get_item_watch_time_stats; an episode
//     takes its show's genres / collections / studio) and season sizes (get_children_metadata, else mediactl's season
//     listing). Plays from before this existed are filled the same way (mediactl /item, then Tautulli).
//   Achievements that need a field only count plays whose title has it; a late fill re-checks the players (poke).
//
// QUIET BACKFILL: once (achievement_meta 'plexpad_backfill_1', its time = the CUTOFF) every account whose plays already
// earned one gets the badge only - no XP, PAT or announcement. After that an achievement that plays from before the
// cutoff ALONE would have earned (say their genres only arrived later) is still given quietly (metrics()._quiet,
// achievements.checkWeb); only new plays earn the loud award (XP + PAT from the incentive budget + Pepe's shout).
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const tautulli = require("./tautulli");

const MIN_AIR = 600;                 // seconds on air that always count...
const MIN_FRAC = 0.5;                // ...or this share of the runtime, if that's less
const CUTOFF_KEY = "plexpad_backfill_1";
const DAY = 24 * 3600 * 1000;
const RETRY_MS = 6 * 3600 * 1000;    // a title Tautulli couldn't fill is tried again after this long
const MAX_TRIES = 6;
const DEEP_MAX = { movie: 2, show: 10 };   // a deep cut: nobody had played it on a PATV pad AND the server played it this little
const DECADES = [1960, 1970, 1980, 1990, 2000, 2010, 2020];
let clock = () => Date.now();

// ── metadata storage ──
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS plex_meta (
        rating_key TEXT PRIMARY KEY, kind TEXT, title TEXT, year INTEGER, show_key TEXT, season_key TEXT, show_title TEXT,
        lang TEXT, genres TEXT, collections TEXT, studio TEXT, server_plays INTEGER,
        item_at INTEGER, taut_at INTEGER, taut_ok INTEGER NOT NULL DEFAULT 0, tries INTEGER NOT NULL DEFAULT 0, updated INTEGER)`);
      await runQuery("CREATE TABLE IF NOT EXISTS plex_seasons (season_key TEXT PRIMARY KEY, size INTEGER, updated INTEGER)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
const J = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } };
const isEnglish = (l) => /^(en|eng)$/i.test(String(l || ""));

/** Called with the mediactl item a play just started from (medialib.play / mediaqueue.startTitle). Never throws. */
async function noteItem(it) {
  try {
    if (!it || !it.key || !["movie", "episode"].includes(it.type)) return;
    await init();
    const audio = Array.isArray(it.audio) ? it.audio.slice().sort((a, b) => (a.index || 0) - (b.index || 0)) : [];
    const lang = audio.length ? audio[0].lang || null : null;
    await runQuery(`INSERT INTO plex_meta (rating_key, kind, title, year, show_key, season_key, show_title, lang, item_at, updated)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(rating_key) DO UPDATE SET kind = excluded.kind, title = excluded.title, year = COALESCE(excluded.year, plex_meta.year),
                      show_key = COALESCE(excluded.show_key, plex_meta.show_key), season_key = COALESCE(excluded.season_key, plex_meta.season_key),
                      show_title = COALESCE(excluded.show_title, plex_meta.show_title), lang = COALESCE(excluded.lang, plex_meta.lang),
                      item_at = excluded.item_at, updated = excluded.updated`,
                   [String(it.key), it.type, String(it.title || "").slice(0, 200), Number(it.year) || null, it.show_key || null, it.season_key || null,
                    it.show ? String(it.show).slice(0, 200) : null, lang, clock(), clock()]);
    kick();
  } catch (e) { /* metadata is decoration for achievements: never blocks a play */ }
}

// ── the upstreams (tests swap them with _set) ──
let fetchItem = async (key) => {
  const conf = require("./mediaconf");
  if (!conf.keys().mediactl) return null;
  return require("./medialib")._q.fetchItem(key);
};
const T = (cmd, p) => tautulli.call(cmd, p, { timeout: 15000 });

const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => (x && typeof x === "object" ? x.tag || x.title || x.name || "" : String(x))).filter(Boolean).map((s) => String(s).slice(0, 80));
/** Tautulli's get_metadata -> the fields we keep (an episode's genres etc. come from its show). */
async function tautMeta(key) {
  const m = await T("get_metadata", { rating_key: key });
  if (!m || !m.rating_key) return null;
  const out = { kind: m.media_type || null, title: m.title || null, year: Number(m.year) || null, genres: list(m.genres), collections: list(m.collections),
                studio: m.studio || null, show_key: null, season_key: null, show_title: null, lang: null };
  if (m.media_type === "episode") {
    out.show_key = m.grandparent_rating_key ? String(m.grandparent_rating_key) : null;
    out.season_key = m.parent_rating_key ? String(m.parent_rating_key) : null;
    out.show_title = m.grandparent_title || null;
    if (out.show_key) {
      const s = await T("get_metadata", { rating_key: out.show_key }).catch(() => null);
      if (s) {
        out.genres = out.genres.length ? out.genres : list(s.genres);
        out.collections = [...new Set([...out.collections, ...list(s.collections)])];
        out.studio = out.studio || s.studio || null;
      }
    }
  }
  // the first audio track's language (when mediactl didn't already give it)
  try {
    const parts = ((m.media_info || [])[0] || {}).parts || [];
    const streams = (parts[0] || {}).streams || [];
    const a = streams.find((s) => String(s.type) === "2" || s.stream_type === "2" || s.audio_language_code);
    if (a) out.lang = a.audio_language_code || null;
  } catch (e) { /* no media info */ }
  return out;
}
async function serverPlays(key) {
  const rows = await T("get_item_watch_time_stats", { rating_key: key, query_days: "0" }).catch(() => null);
  const r = (Array.isArray(rows) ? rows : []).find((x) => Number(x.query_days) === 0) || (Array.isArray(rows) ? rows[0] : null);
  return r && r.total_plays != null ? Number(r.total_plays) || 0 : null;
}
async function seasonSize(seasonKey) {
  const known = (await getQuery("SELECT size FROM plex_seasons WHERE season_key = ?", [seasonKey]))[0];
  if (known && known.size) return known.size;
  let n = null;
  if (tautulli.configured()) {
    const c = await T("get_children_metadata", { rating_key: seasonKey, media_type: "season" }).catch(() => null);
    if (c) n = Number(c.children_count) || (Array.isArray(c.children_list) ? c.children_list.length : null);
  }
  if (!n) {
    const it = await fetchItem(seasonKey).catch(() => null);
    if (it && Array.isArray(it.episodes)) n = it.episodes.length;
  }
  if (n) await runQuery("INSERT OR REPLACE INTO plex_seasons (season_key, size, updated) VALUES (?, ?, ?)", [seasonKey, n, clock()]);
  return n;
}

/** Fill one title's metadata (mediactl for the basics if we never saw it, Tautulli for the rest). -> changed? */
async function enrich(key) {
  await init();
  key = String(key);
  let row = (await getQuery("SELECT * FROM plex_meta WHERE rating_key = ?", [key]))[0] || null;
  let changed = false;
  if (!row || !row.item_at) {
    const it = await fetchItem(key).catch(() => null);
    if (it && it.key) { await noteItem(it); changed = true; }
    else {
      // not reachable / not in the library any more: counted, so it's only retried a few times
      await runQuery(`INSERT INTO plex_meta (rating_key, tries, updated) VALUES (?, 1, ?)
                      ON CONFLICT(rating_key) DO UPDATE SET tries = plex_meta.tries + 1, updated = excluded.updated`, [key, clock()]);
    }
    row = (await getQuery("SELECT * FROM plex_meta WHERE rating_key = ?", [key]))[0] || row;
  }
  if (tautulli.configured() && !(row && row.taut_ok)) {
    let m = null, err = null;
    try { m = await tautMeta(key); } catch (e) { err = e; }
    if (m) {
      const plays = await serverPlays(m.show_key || key);
      await runQuery(`INSERT INTO plex_meta (rating_key, kind, title, year, show_key, season_key, show_title, lang, genres, collections, studio, server_plays, taut_at, taut_ok, tries, updated)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)
                      ON CONFLICT(rating_key) DO UPDATE SET kind = COALESCE(plex_meta.kind, excluded.kind), title = COALESCE(plex_meta.title, excluded.title),
                        year = COALESCE(plex_meta.year, excluded.year), show_key = COALESCE(plex_meta.show_key, excluded.show_key),
                        season_key = COALESCE(plex_meta.season_key, excluded.season_key), show_title = COALESCE(plex_meta.show_title, excluded.show_title),
                        lang = COALESCE(plex_meta.lang, excluded.lang), genres = excluded.genres, collections = excluded.collections, studio = excluded.studio,
                        server_plays = COALESCE(plex_meta.server_plays, excluded.server_plays), taut_at = excluded.taut_at, taut_ok = 1,
                        tries = plex_meta.tries + 1, updated = excluded.updated`,
                     [key, m.kind, m.title, m.year, m.show_key, m.season_key, m.show_title, m.lang, JSON.stringify(m.genres), JSON.stringify(m.collections),
                      m.studio, plays, clock(), clock()]);
      changed = true;
    } else {
      await runQuery(`INSERT INTO plex_meta (rating_key, taut_at, tries, updated) VALUES (?, ?, 1, ?)
                      ON CONFLICT(rating_key) DO UPDATE SET taut_at = excluded.taut_at, tries = plex_meta.tries + 1`, [key, clock(), clock()]);
      if (err && err.status !== 503) console.warn("[plexpad] metadata", key + ":", String(err.message || err).slice(0, 160));
    }
  }
  row = (await getQuery("SELECT season_key FROM plex_meta WHERE rating_key = ?", [key]))[0];
  if (row && row.season_key) { const before = (await getQuery("SELECT size FROM plex_seasons WHERE season_key = ?", [row.season_key]))[0];
                               if (!before) { await seasonSize(row.season_key).catch(() => null); changed = true; } }
  return changed;
}

/** The enrichment job: titles played on a pad that miss metadata (or Tautulli's part, while it's configured). */
let running = null;
async function enrichPending(limit = 25) {
  if (running) return running;
  running = (async () => {
    await init();
    const t = clock();
    const keys = await getQuery(`SELECT DISTINCT p.rating_key AS k FROM media_plays p LEFT JOIN plex_meta m ON m.rating_key = p.rating_key
                                 WHERE p.rating_key IS NOT NULL AND p.kind IN ('movie','episode')
                                   AND (m.rating_key IS NULL
                                        OR (m.item_at IS NULL AND COALESCE(m.taut_ok, 0) = 0 AND m.tries < ? AND COALESCE(m.updated, 0) < ?)
                                        OR (? = 1 AND COALESCE(m.taut_ok, 0) = 0 AND m.tries < ? AND COALESCE(m.taut_at, 0) < ?))
                                 LIMIT ?`, [MAX_TRIES, t - 30 * 60 * 1000, tautulli.configured() ? 1 : 0, MAX_TRIES, t - RETRY_MS, limit]).catch(() => []);
    const done = [];
    for (const r of keys) {
      try { if (await enrich(r.k)) done.push(r.k); } catch (e) { console.warn("[plexpad] enrich:", String(e.message || e).slice(0, 160)); }
    }
    if (done.length) {
      // whoever played these may qualify now
      const users = await getQuery(`SELECT DISTINCT user_id FROM media_plays WHERE user_id IS NOT NULL AND rating_key IN (${done.map(() => "?").join(",")})`, done).catch(() => []);
      try { require("./achievements").poke(...users.map((u) => u.user_id)); } catch (e) { /* never blocks */ }
    }
    return { checked: keys.length, filled: done.length };
  })().finally(() => { running = null; });
  return running;
}
let kickT = null;
function kick() {
  if (kickT || process.env.NODE_TEST_CONTEXT) return;
  kickT = setTimeout(() => { kickT = null; enrichPending().catch(() => {}); }, 20000);
  if (kickT.unref) kickT.unref();
}

// ── matching: genres, franchises, languages ──
const norm = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]+/g, "")
  .replace(/\s+/g, " ").trim();
const GENRES = {
  horror: /\bhorror\b/,
  comedy: /\bcomedy\b|\bsitcom\b|stand ?up/,
  scifi: /sci ?fi|science ?fiction/,
  documentary: /documentary|docuseries/,
  animation: /\banimation\b|\banime\b|\banimated\b/,
};
// "title" or ["title", year] (a year also matches the one either side - release dates differ by region)
const FRANCHISES = {
  mcu: {
    coll: /marvel cinematic universe|\bmcu\b|the avengers collection|avengers collection|iron man collection|thor collection|captain america collection|guardians of the galaxy collection|antman collection|black panther collection|doctor strange collection|spiderman mcu|homecoming collection/,
    titles: [["iron man", 2008], ["iron man 2", 2010], ["iron man 3", 2013], ["the incredible hulk", 2008], ["thor", 2011], ["thor the dark world", 2013],
      ["thor ragnarok", 2017], ["thor love and thunder", 2022], ["captain america the first avenger", 2011], ["captain america the winter soldier", 2014],
      ["captain america civil war", 2016], ["captain america brave new world", 2025], ["the avengers", 2012], ["marvels the avengers", 2012],
      ["avengers age of ultron", 2015], ["avengers infinity war", 2018], ["avengers endgame", 2019], ["guardians of the galaxy", 2014],
      ["guardians of the galaxy vol 2", 2017], ["guardians of the galaxy vol 3", 2023], ["antman", 2015], ["antman and the wasp", 2018],
      ["antman and the wasp quantumania", 2023], ["doctor strange", 2016], ["doctor strange in the multiverse of madness", 2022],
      ["spiderman homecoming", 2017], ["spiderman far from home", 2019], ["spiderman no way home", 2021], ["black panther", 2018],
      ["black panther wakanda forever", 2022], ["captain marvel", 2019], ["the marvels", 2023], ["black widow", 2021],
      ["shangchi and the legend of the ten rings", 2021], ["eternals", 2021], ["deadpool and wolverine", 2024], ["thunderbolts", 2025],
      ["the fantastic four first steps", 2025], ["wandavision", 2021], ["the falcon and the winter soldier", 2021], ["loki", 2021], ["what if", 2021],
      ["hawkeye", 2021], ["moon knight", 2022], ["ms marvel", 2022], ["shehulk attorney at law", 2022], ["secret invasion", 2023], ["echo", 2024],
      ["agatha all along", 2024], ["daredevil born again", 2025], ["ironheart", 2025]],
  },
  starwars: {
    coll: /star wars/,
    prefix: /^star wars\b/,
    titles: ["rogue one", "rogue one a star wars story", "solo a star wars story", "the mandalorian", "andor", "the book of boba fett", "obiwan kenobi",
      "ahsoka", "the acolyte", "skeleton crew", "the bad batch", "tales of the jedi", "tales of the empire", "the clone wars"],
  },
  potter: { coll: /harry potter|wizarding world|fantastic beasts/, prefix: /^(harry potter|fantastic beasts)\b/, titles: [] },
  lotr: { coll: /lord of the rings|the hobbit|middleearth|middle earth/, prefix: /^(the lord of the rings|lord of the rings|the hobbit)\b/, titles: [] },
  bond: {
    coll: /james bond|\b007\b/,
    titles: [["dr no", 1962], ["from russia with love", 1963], ["goldfinger", 1964], ["thunderball", 1965], ["you only live twice", 1967],
      ["on her majestys secret service", 1969], ["diamonds are forever", 1971], ["live and let die", 1973], ["the man with the golden gun", 1974],
      ["the spy who loved me", 1977], ["moonraker", 1979], ["for your eyes only", 1981], ["octopussy", 1983], ["never say never again", 1983],
      ["a view to a kill", 1985], ["the living daylights", 1987], ["licence to kill", 1989], ["license to kill", 1989], ["goldeneye", 1995],
      ["tomorrow never dies", 1997], ["the world is not enough", 1999], ["die another day", 2002], ["casino royale", 2006], ["casino royale", 1967],
      ["quantum of solace", 2008], ["skyfall", 2012], ["spectre", 2015], ["no time to die", 2021]],
  },
  fast: {
    coll: /fast and (the )?furious/,
    prefix: /^(the )?fast and (the )?furious\b|hobbs and shaw/,
    titles: [["2 fast 2 furious", 2003], ["fast five", 2011], ["furious 7", 2015], ["furious seven", 2015], ["the fate of the furious", 2017], ["f9", 2021],
      ["f9 the fast saga", 2021], ["fast x", 2023]],
  },
  pixar: {
    studio: /pixar/,
    coll: /\bpixar\b/,
    titles: [["toy story", 1995], ["a bugs life", 1998], ["toy story 2", 1999], ["monsters inc", 2001], ["finding nemo", 2003], ["the incredibles", 2004],
      ["cars", 2006], ["ratatouille", 2007], ["walle", 2008], ["up", 2009], ["toy story 3", 2010], ["cars 2", 2011], ["brave", 2012],
      ["monsters university", 2013], ["inside out", 2015], ["the good dinosaur", 2015], ["finding dory", 2016], ["cars 3", 2017], ["coco", 2017],
      ["incredibles 2", 2018], ["toy story 4", 2019], ["onward", 2020], ["soul", 2020], ["luca", 2021], ["turning red", 2022], ["lightyear", 2022],
      ["elemental", 2023], ["inside out 2", 2024], ["elio", 2025]],
  },
};
function inFranchise(f, { title, year, collections, studio }) {
  const n = norm(title);
  if (f.studio && f.studio.test(norm(studio))) return true;
  if (f.coll && (collections || []).some((c) => f.coll.test(norm(c)))) return true;
  if (f.prefix && f.prefix.test(n)) return true;
  for (const e of f.titles || []) {
    const [t, y] = Array.isArray(e) ? e : [e, null];
    if (n === t && (!y || !year || Math.abs(Number(year) - y) <= 1)) return true;
  }
  return false;
}
const showOf = (title) => String(title || "").split(" — ")[0];

// ── the plays ──
/** On-air seconds of one play row (see the header). */
function airedOf(p) {
  if (!p.went_live || !p.ended_at) return 0;
  const start = Math.max(0, Number(p.offset_start) || 0);
  const pos = p.end_reason === "finished" && p.duration ? Number(p.duration) : Number(p.last_pos);
  if (!Number.isFinite(pos)) return 0;
  const wall = Math.max(0, (Number(p.ended_at) - Number(p.ts)) / 1000) + 60;
  return Math.max(0, Math.min(pos - start, wall));
}
const qualifies = (aired, duration) => aired >= Math.min(MIN_AIR, duration > 0 ? duration * MIN_FRAC : MIN_AIR);

/** One account's plays that count (a carried play folded into the one it continues), with their metadata. */
async function playsOf(userId) {
  await init();
  const rows = await getQuery(`SELECT p.id, p.ts, p.rating_key, p.kind, p.year, p.duration, p.offset_start, p.last_pos, p.ended_at, p.end_reason,
                                      p.carried_from, p.title, p.room_id, s.went_live,
                                      m.kind AS m_kind, m.year AS m_year, m.show_key, m.season_key, m.show_title, m.lang, m.genres, m.collections, m.studio,
                                      m.server_plays, m.title AS m_title
                               FROM media_plays p LEFT JOIN stage_slots s ON s.id = p.slot_id LEFT JOIN plex_meta m ON m.rating_key = p.rating_key
                               WHERE p.user_id = ? AND p.rating_key IS NOT NULL ORDER BY p.id`, [String(userId)]).catch(() => []);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const rootOf = (r) => { let x = r, n = 0; while (x.carried_from && byId.has(x.carried_from) && n++ < 20) x = byId.get(x.carried_from); return x; };
  const groups = new Map();
  for (const r of rows) {
    const root = rootOf(r);
    const g = groups.get(root.id) || { root, aired: 0, ended: true };
    g.aired += airedOf(r);
    if (!r.ended_at) g.ended = false;
    groups.set(root.id, g);
  }
  const out = [];
  for (const g of groups.values()) {
    const r = g.root;
    const kind = r.kind || r.m_kind;
    if (!g.ended || !["movie", "episode"].includes(kind)) continue;
    if (!qualifies(g.aired, Number(r.duration) || 0)) continue;
    out.push({
      id: r.id, ts: Number(r.ts), key: String(r.rating_key), kind, aired: g.aired, room: r.room_id,
      year: Number(r.m_year || r.year) || null,
      work: kind === "episode" ? (r.show_key ? "s:" + r.show_key : "t:" + norm(r.show_title || showOf(r.title))) : "m:" + r.rating_key,
      show_key: r.show_key || null, season_key: r.season_key || null,
      name: kind === "episode" ? (r.show_title || showOf(r.title)) : (r.m_title || String(r.title || "").replace(/ \(\d{4}\)$/, "")),
      title: r.title,
      lang: r.lang || null, genres: J(r.genres, null), collections: J(r.collections, []), studio: r.studio || null,
      server_plays: r.server_plays == null ? null : Number(r.server_plays),
    });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** When each work first went on a PATV pad in SOMEONE ELSE's play (their own earlier tries don't take it): work -> ms. */
async function firstAired(works, userId) {
  if (!works.length) return new Map();
  const rows = await getQuery(`SELECT CASE WHEN COALESCE(p.kind, m.kind) = 'episode' AND m.show_key IS NOT NULL THEN 's:' || m.show_key
                                           WHEN COALESCE(p.kind, m.kind) = 'episode' THEN NULL ELSE 'm:' || p.rating_key END AS work, MIN(p.ts) AS first
                               FROM media_plays p JOIN stage_slots s ON s.id = p.slot_id LEFT JOIN plex_meta m ON m.rating_key = p.rating_key
                               WHERE s.went_live IS NOT NULL AND p.rating_key IS NOT NULL AND COALESCE(p.user_id, '') != ? GROUP BY work`, [String(userId || "")]).catch(() => []);
  return new Map(rows.filter((r) => r.work).map((r) => [r.work, Number(r.first)]));
}

const METRICS = ["plexpad_movies", "plexpad_episodes", "plexpad_plays", "plexpad_same_title", "plexpad_horror", "plexpad_comedy", "plexpad_scifi",
  "plexpad_documentary", "plexpad_animation", "plexpad_genres", "plexpad_mcu", "plexpad_starwars", "plexpad_potter", "plexpad_lotr", "plexpad_bond",
  "plexpad_fast", "plexpad_pixar", "plexpad_deepcuts", "plexpad_oldies", "plexpad_decades", "plexpad_seasons", "plexpad_marathon", "plexpad_foreign"];

/** The metrics over a list of counted plays (pure, given others' first-aired map and the season sizes). */
function compute(Q, first, sizes) {
  const m = Object.fromEntries(METRICS.map((k) => [k, 0]));
  m.plexpad_plays = Q.length;
  const perKey = new Map(), genreWorks = {}, allGenres = new Set(), fran = {}, deep = new Set(), decades = new Set(), foreign = new Set(), seasons = new Map();
  for (const p of Q) {
    if (p.kind === "movie") m.plexpad_movies++; else m.plexpad_episodes++;
    perKey.set(p.key, (perKey.get(p.key) || 0) + 1);
    for (const g of p.genres || []) {
      const n = norm(g);
      if (n) allGenres.add(n);
      for (const [id, re] of Object.entries(GENRES)) if (re.test(n)) (genreWorks[id] = genreWorks[id] || new Set()).add(p.work);
    }
    for (const [id, f] of Object.entries(FRANCHISES)) {
      if (inFranchise(f, { title: p.name, year: p.year, collections: p.collections, studio: p.studio })) (fran[id] = fran[id] || new Set()).add(p.work);
    }
    const max = p.kind === "movie" ? DEEP_MAX.movie : DEEP_MAX.show;
    // a deep cut: nobody else had it on a pad before this play, and the server has barely played it
    if (!(first.get(p.work) < p.ts) && (p.server_plays == null || p.server_plays <= max)) deep.add(p.work);
    if (p.year && p.year < 1970) m.plexpad_oldies++;
    if (p.year) { const d = Math.floor(p.year / 10) * 10; if (DECADES.includes(d)) decades.add(d); }
    if (p.kind === "movie" && p.lang && !isEnglish(p.lang)) foreign.add(p.work);
    if (p.kind === "episode" && p.season_key) (seasons.get(p.season_key) || seasons.set(p.season_key, new Set()).get(p.season_key)).add(p.key);
  }
  m.plexpad_same_title = Math.max(0, ...perKey.values());
  for (const id of Object.keys(GENRES)) m["plexpad_" + id] = genreWorks[id] ? genreWorks[id].size : 0;
  m.plexpad_genres = allGenres.size;
  for (const id of Object.keys(FRANCHISES)) m["plexpad_" + id] = fran[id] ? fran[id].size : 0;
  m.plexpad_deepcuts = deep.size;
  m.plexpad_decades = decades.size;
  m.plexpad_foreign = foreign.size;
  for (const [sk, eps] of seasons) { const n = sizes.get(sk); if (n && n >= 2 && eps.size >= n) m.plexpad_seasons++; }
  // the most on-air time from plays started inside any 24 hours
  let best = 0;
  for (let i = 0, j = 0, sum = 0; j < Q.length; j++) {
    sum += Q[j].aired;
    while (Q[j].ts - Q[i].ts >= DAY) sum -= Q[i++].aired;
    best = Math.max(best, sum);
  }
  m.plexpad_marathon = Math.floor(best);
  return m;
}

async function cutoff() {
  const r = (await getQuery("SELECT v FROM achievement_meta WHERE k = ?", [CUTOFF_KEY]).catch(() => []))[0];
  if (!r) return null;
  const v = J(r.v, null);
  return v && v.cutoff ? Number(v.cutoff) : null;
}

/**
 * The 📼 pad metrics for one account -> {...metrics, _quiet: {...the same counted over plays from before the cutoff}}.
 * Before the quiet backfill has run: all 0 (nobody gets a loud award for old plays).
 */
async function metrics(userId) {
  const zero = Object.fromEntries(METRICS.map((k) => [k, 0]));
  const cut = await cutoff();
  if (cut == null) return { ...zero, _quiet: zero };
  const Q = await playsOf(userId);
  if (!Q.length) return { ...zero, _quiet: zero };
  const first = await firstAired([...new Set(Q.map((p) => p.work))], userId);
  const sk = [...new Set(Q.map((p) => p.season_key).filter(Boolean))];
  const sizes = new Map(sk.length ? (await getQuery(`SELECT season_key, size FROM plex_seasons WHERE season_key IN (${sk.map(() => "?").join(",")})`, sk).catch(() => []))
    .map((r) => [r.season_key, Number(r.size) || 0]) : []);
  const all = compute(Q, first, sizes);
  const old = Q.filter((p) => p.ts < cut);
  return { ...all, _quiet: old.length ? compute(old, first, sizes) : zero };
}

/** Once: quietly give the 📼 pad achievements that existing plays already earned (badge + cosmetics only). */
let backfilling = null;
function backfill() {
  if (!backfilling) {
    backfilling = (async () => {
      const A = require("./achievements");
      await A.ready;
      await init();
      await runQuery("CREATE TABLE IF NOT EXISTS achievement_meta (k TEXT PRIMARY KEY, v TEXT)");
      if ((await cutoff()) != null) return { done: true, already: true, given: 0 };
      const t = clock();
      // fill what metadata we can first (best effort - later fills are still quiet for these plays)
      for (let i = 0; i < 8; i++) { const r = await enrichPending(50).catch(() => null); if (!r || !r.checked) break; }
      await runQuery("INSERT OR REPLACE INTO achievement_meta (k, v) VALUES (?, ?)", [CUTOFF_KEY, JSON.stringify({ cutoff: t, at: new Date(t).toISOString() })]);
      const ach = A.list().filter((a) => a.side === "web" && METRICS.includes(a.metric));
      const users = await getQuery("SELECT DISTINCT user_id FROM media_plays WHERE user_id IS NOT NULL").catch(() => []);
      const given = [];
      for (const u of users) {
        const m = await metrics(u.user_id);
        for (const a of ach) {
          if ((m[a.metric] || 0) < (a.threshold || 1)) continue;
          const r = await A.award({ userId: u.user_id }, a.id, null, { silent: true });
          if (r.ok && r.awarded) given.push({ userId: u.user_id, badgeId: a.id });
        }
      }
      const by = {};
      for (const x of given) by[x.badgeId] = (by[x.badgeId] || 0) + 1;
      await runQuery("INSERT OR REPLACE INTO achievement_meta (k, v) VALUES (?, ?)",
                     [CUTOFF_KEY, JSON.stringify({ cutoff: t, at: new Date(t).toISOString(), users: users.length, given: given.length, by })]);
      console.log(`[plexpad] backfill: ${given.length} badge(s) given quietly to ${users.length} account(s) ${JSON.stringify(by)}`);
      return { done: true, given: given.length, users: users.length, by, list: given };
    })().catch((e) => { backfilling = null; throw e; });
  }
  return backfilling;
}

/** The PATV-plays part of the profile's 📼 Plex tab: what this account put on pads (counted plays only). */
async function profileStats(userId) {
  const Q = await playsOf(userId);
  const recent = Q.slice(-6).reverse().map((p) => ({ title: p.title, kind: p.kind, at: p.ts, room: p.room }));
  return { plays: Q.length, movies: Q.filter((p) => p.kind === "movie").length, episodes: Q.filter((p) => p.kind === "episode").length,
           hours: Math.round(Q.reduce((s, p) => s + p.aired, 0) / 360) / 10, titles: new Set(Q.map((p) => p.key)).size, recent };
}

let timer = null;
function start() {
  if (timer || process.env.NODE_TEST_CONTEXT) return;
  const t0 = setTimeout(() => { backfill().catch((e) => console.error("[plexpad] backfill:", String(e.message || e))); }, 2 * 60 * 1000);
  if (t0.unref) t0.unref();
  timer = setInterval(() => enrichPending().catch(() => {}), 10 * 60 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = { init, noteItem, enrich, enrichPending, metrics, compute, playsOf, backfill, profileStats, start, METRICS, GENRES, FRANCHISES, inFranchise,
                   airedOf, qualifies, norm, CUTOFF_KEY, MIN_AIR,
                   _setClock: (fn) => { clock = fn || (() => Date.now()); },
                   _set: (o) => { if (o.fetchItem) fetchItem = o.fetchItem; } };
