// Plex clerk's rebuildable, section-filtered metadata cache. No media files or personal history live here.
"use strict";
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3");

const DAY = 86400000, SEARCH_BUDGET_MS = 400, SEARCH_QUEUE = 4;
// 1.99alq train3 review: the shelves listing's two aggregates (every visible row's genres, each shelf's visible members) scan the
// whole library - a few hundred ms alone at 10k films + 200k episodes, past the 400 ms search budget under load. They get a
// budget of their own (internal only: a caller's read() is still capped at the search budget), and shelves() keeps its
// answer until the catalog changes (any write) or the block list does.
const SHELVES_BUDGET_MS = 2000;
const DEFAULT_BLOCK = "X,XXX,AO,R18,R18+";
const KEY = /^\d{1,12}$/;
const text = (v, max = 200) => typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
const fold = (v) => {
  const value = text(v, 1000).toLowerCase().normalize("NFKD").replace(/([a-z])[\u0300-\u036f]+/g, "$1").normalize("NFC").replace(/&/g, " and ").replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim();
  return /[\p{L}\p{N}]/u.test(value) ? value : "";
};
const number = (v, fallback = 0) => Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : fallback;
const strings = (v, n = 20, max = 80) => Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === "string").map((x) => text(x, max)).filter(Boolean))].slice(0, n) : [];
const parsed = (v, d = []) => { try { return JSON.parse(v); } catch (_) { return d; } };
const IDLE_CHECK_MIN = 5;      // 1.99alq train3 verify: minutes between looks while every clerk switch is off (start())
// 1.99alx catfix (prod 2026-11-08, "Last sync: Never" / "catalog source unavailable"): every read had the client's 15 s, and
// mediactl 1.7.0 answers a section's /collections only after walking every collection's members - the largest section has
// 1381 collections at 2-3 s a member read (about an hour) - so each run read that whole section, gave up on its collections,
// threw the run away (no "at", no "full_at"), and the next run started over. Now: a page gets PAGE_TIMEOUT_MS (the slowest
// real page measured ~3.6 s); shelves are read by the full sweep only; /collections is paged on mediactl 1.7.1+
// (COLLECTIONS_PAGE shelves an answer) and 1.7.0's one whole-section answer gets COLLECTIONS_WALK_TIMEOUT_MS, after which
// that section keeps the shelves it had; a read that fails for a passing reason (no answer, 429/5xx) is tried again after
// RETRY_WAITS_MS; a full sweep that still stops keeps its place ("progress") and the next run carries on from that page; the
// last error says which read failed and how; and the timer tries again after RETRY_MIN, not a whole interval.
const PAGE_TIMEOUT_MS = 60000;
const COLLECTIONS_PAGE = 5;                      // a member read takes Plex 2-3 s: a page answers in ~15 s (up to 4 reads a shelf)
const COLLECTIONS_PAGE_TIMEOUT_MS = 180000;
const COLLECTIONS_WALK_TIMEOUT_MS = 120000;      // 1.7.0's one whole-section answer (a 51-shelf section took 48 s on prod)
const RETRY_WAITS_MS = [2000, 10000, 30000];
const TRANSIENT = new Set([408, 425, 429, 500, 502, 503, 504]);
const PROGRESS_MAX_AGE_MS = 26 * 3600000;
const RETRY_MIN = 10;
const TYPE_NAME = { 1: "movie", 2: "show", 4: "episode" };
const semver = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v || ""); return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]) : 0; };
/** mediactl 1.7.1+ answers /collections?start=&size= one page of shelves at a time (1.7.0 ignores both: the whole section). */
const pagedCollections = (version) => semver(version) >= 1007001;
/** Which read a sync was making - section ids only, never a title. */
function describeRead(w) {
  if (!w || w.step === "sections") return "the section list";
  const sec = "section " + w.section + (w.kind ? " (" + (w.kind === "show" ? "shows" : "movies") + ")" : "");
  if (w.step === "collections") return "collections of " + sec + (w.start ? " from " + w.start : "");
  return TYPE_NAME[w.type] + " page from " + (w.start || 0) + " of " + sec + (w.since ? ", changes only" : "");
}
function describeWhy(f) {
  if (f.unusable) return "media-control's answer wasn't usable";
  if (f.unconfigured) return "media-control isn't configured on the site";
  if (f.pin) return "media-control's certificate doesn't match MEDIACTL_TLS_SHA256";
  if (f.bad_url) return "MEDIACTL_URL isn't a usable address";
  if (f.timeout) return "no answer within " + Math.round((f.timeout_ms || 0) / 1000) + " s";
  if (f.status == null) return "media-control can't be reached" + (f.reason ? " (" + f.reason + ")" : "");
  return "media-control answered " + f.status;
}
/** 1.99alx catfix review: what a failed call() says, as flags and a short reason - the error code only (never the message's
 *  address). A pin that doesn't match, a URL that can't be used and "not configured" are `lasting`: asking again can't fix them. */
function clientFailure(e) {
  const msg = String((e && e.message) || ""), code = e && typeof e.code === "string" ? e.code : "";
  const unconfigured = !!(e && e.extra && e.extra.code === "encoder_down");
  const pin = /certificate doesn't match/i.test(msg), bad_url = code === "ERR_INVALID_URL" || /^Invalid URL\b/i.test(msg);
  const timeout = !pin && (/\btime(?:d ?)?out\b/i.test(msg) || code === "ETIMEDOUT");
  const net = /^E[A-Z]{3,}$/.test(code) ? code : (/\b(E[A-Z]{3,})\b/.exec(msg) || [])[1];
  const reason = net || (/socket hang up|ended by the other party/i.test(msg) ? "connection closed" : null);
  const lasting = unconfigured || pin || bad_url;
  return { status: null, timeout, unconfigured, pin, bad_url, reason: timeout || lasting ? null : reason, lasting, transient: !lasting };
}
/** The admin card's "Last sync error": what was being read and why it failed, e.g. "catalog source unavailable: episode page
 *  from 0 of section N (shows) - media-control answered 503 (4 tries)". */
const sourceError = (d) => "catalog source unavailable" + (d ? ": " + describeRead(d) + " - " + describeWhy(d) + (d.attempts > 1 ? " (" + d.attempts + " tries)" : "") : "");
/** Minutes to the timer's next look: the setting while in use, sooner after a run that failed for a passing reason. */
function nextTickMin(cfg, on, last) {
  if (!on) return IDLE_CHECK_MIN;
  const every = Math.max(10, Math.min(1440, number((cfg || {}).catalog_sync_min, 60)));
  return last && last.ok === false && last.retry ? Math.min(every, RETRY_MIN) : every;
}
const ratings = (v) => new Set(String(v == null ? DEFAULT_BLOCK : v).split(",").map((s) => s.trim().toUpperCase().replace(/^[A-Z]{2}\/\s*/, "")).filter(Boolean));
/** 1.99alq train3 verify: a certification without Plex's country prefix ("gb/R18" -> "R18", "au/R18+" -> "R18+"); every rating
 *  check (the block list in SQL and in code, the warn list) compares exact names, so a prefixed adult rating slipped through. */
const normRating = (v) => { const t = text(v, 40); const m = /^[A-Za-z]{2}\/\s*(\S.*)$/.exec(t); return m ? m[1].trim() : t; };
const coded = (code, message = code) => Object.assign(new Error(message), { code });
const quiet = (ms) => { const d = new Date(ms), m = d.getUTCHours() * 60 + d.getUTCMinutes(); return m >= 220 && m < 260; };
const run = (db, sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, function (e) { e ? reject(e) : resolve({ changes: this.changes, lastID: this.lastID }); }));
const all = (db, sql, args = []) => new Promise((resolve, reject) => db.all(sql, args, (e, r) => e ? reject(e) : resolve(r)));
const closeDb = (db) => db ? new Promise((resolve) => db.close(() => resolve())) : Promise.resolve();

function sectionRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((s) => s && /^[A-Za-z0-9_-]{1,64}$/.test(String(s.id)) && ["movie", "show"].includes(s.type))
    .map((s) => ({ id: String(s.id), title: s.policy === "allowed" ? text(s.title) : "(hidden)", type: s.type,
      count: Math.max(0, Math.floor(number(s.count))), policy: ["allowed", "adult", "off"].includes(s.policy) ? s.policy : "off" }));
}

/** The one metadata boundary, used for provider reads and snapshot imports. Unknown fields are never copied. */
function crow(input) {
  const r = input || {}, type = { 1: "movie", 2: "show", 4: "episode" }[r.type] || r.type;
  if (!KEY.test(String(r.key)) || !["movie", "show", "episode"].includes(type) || !r.section) return null;
  const o = { key: String(r.key), type, title: text(r.title), year: number(r.year, null), aired: /^\d{4}-\d{2}-\d{2}$/.test(r.aired || "") ? r.aired : null,
    added: Math.max(0, Math.floor(number(r.added))), updated: Math.max(0, Math.floor(number(r.updated))), duration: Math.max(0, number(r.duration)),
    summary: text(r.summary, type === "episode" ? 500 : 1000), tagline: text(r.tagline, 500), genres: strings(r.genres),
    content_rating: normRating(r.content_rating), rating: Math.max(0, Math.min(10, number(r.rating, 0))) || null,
    audience_rating: Math.max(0, Math.min(10, number(r.audience_rating, 0))) || null, studio: text(r.studio),
    directors: strings(r.directors, 3), cast: strings(r.cast, 6), countries: strings(r.countries, 3),
    imdb: /^tt\d{1,12}$/.test(r.imdb || "") ? r.imdb : null, tmdb: KEY.test(String(r.tmdb || "")) ? String(r.tmdb) : null,
    tvdb: KEY.test(String(r.tvdb || "")) ? String(r.tvdb) : null, show_key: KEY.test(String(r.show_key || "")) ? String(r.show_key) : null,
    season_key: KEY.test(String(r.season_key || "")) ? String(r.season_key) : null, show: text(r.show),
    season: r.season == null ? null : Math.max(0, Math.floor(number(r.season))), episode: r.episode == null ? null : Math.max(0, Math.floor(number(r.episode))),
    section: text(String(r.section), 64), server_plays: Math.max(0, Math.floor(number(r.server_plays))), pad_plays: Math.max(0, Math.floor(number(r.pad_plays))) };
  return o.title ? o : null;
}

function createCatalog(options = {}) {
  const file = path.resolve(options.file || process.env.PLEX_CATALOG_DB || path.join(path.dirname(path.resolve("myapp.db")), "plexcatalog.db"));
  const now = options.now || (() => Date.now());
  const settings = options.settings || (() => require("./mediaconf").get());
  const mediactl = options.mediactl || ((...args) => require("./medialib").call(...args));
  const mainRead = options.mainRead || ((sql, args) => require("./dbUtils").getQuery(sql, args));
  const tautulli = options.tautulli || { configured: () => require("./tautulli").configured(), call: (...args) => require("./tautulli").call(...args) };
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = options.log || console;
  let writer = null, initPromise = null, searchDb = null, tail = Promise.resolve(), fts = false, syncing = null, timer = null, closed = false;
  let running = false, generation = 0, shelvesKept = null;
  const queue = [];

  async function connect(mode) {
    const db = await new Promise((resolve, reject) => {
      const d = new sqlite3.Database(file, mode, (e) => e ? reject(e) : resolve(d));
    });
    try {
      db.configure("busyTimeout", SEARCH_BUDGET_MS);
      await run(db, "PRAGMA busy_timeout = 400");
      if (mode !== sqlite3.OPEN_READONLY) {
        await run(db, "PRAGMA journal_mode = WAL");
        await run(db, "PRAGMA synchronous = NORMAL");
        await run(db, "PRAGMA foreign_keys = ON");
      }
      return db;
    } catch (e) { await closeDb(db); throw e; }
  }
  function init() {
    if (!initPromise) initPromise = (async () => {
      if (closed) throw coded("unavailable", "catalog closed");
      if (options.readOnly) {
        const probe = await connect(sqlite3.OPEN_READONLY);
        try {
          await all(probe, "SELECT key FROM plex_catalog_state LIMIT 0");
          await all(probe, "SELECT key FROM plex_catalog LIMIT 0");
          try { await all(probe, "SELECT key FROM plex_catalog_fts LIMIT 0"); fts = true; } catch (_) { fts = false; }
        } finally { await closeDb(probe); }
        return true;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writer = await connect(sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
      await run(writer, "CREATE TABLE IF NOT EXISTS plex_sections (id TEXT PRIMARY KEY,title TEXT,type TEXT,count INTEGER,policy TEXT)");
      await run(writer, `CREATE TABLE IF NOT EXISTS plex_catalog (key TEXT PRIMARY KEY,type TEXT,title TEXT,title_fold TEXT,show_key TEXT,show_fold TEXT,
        section TEXT NOT NULL,content_rating TEXT,data TEXT NOT NULL,seen_at INTEGER NOT NULL,server_plays INTEGER NOT NULL DEFAULT 0,pad_plays INTEGER NOT NULL DEFAULT 0)`);
      await run(writer, "CREATE INDEX IF NOT EXISTS plex_catalog_show ON plex_catalog(show_key)");
      await run(writer, "CREATE INDEX IF NOT EXISTS plex_catalog_title ON plex_catalog(title_fold)");
      await run(writer, "CREATE INDEX IF NOT EXISTS plex_catalog_section ON plex_catalog(section)");
      // Covers visibility/parent joins without loading the large JSON metadata payload for every episode.
      await run(writer, "CREATE INDEX IF NOT EXISTS plex_catalog_visibility ON plex_catalog(key,section,content_rating,type,show_key)");
      await run(writer, "CREATE TABLE IF NOT EXISTS plex_catalog_genres (key TEXT,genre TEXT,PRIMARY KEY(key,genre),FOREIGN KEY(key) REFERENCES plex_catalog(key) ON DELETE CASCADE)");
      await run(writer, "CREATE INDEX IF NOT EXISTS plex_catalog_genre_name ON plex_catalog_genres(genre,key)");
      await run(writer, "CREATE TABLE IF NOT EXISTS plex_shelves (key TEXT PRIMARY KEY,name TEXT,kind TEXT,source TEXT,ranked INTEGER NOT NULL DEFAULT 0,section TEXT)");
      await run(writer, "CREATE TABLE IF NOT EXISTS plex_shelf_members (shelf TEXT,key TEXT,rank INTEGER,PRIMARY KEY(shelf,key),FOREIGN KEY(shelf) REFERENCES plex_shelves(key) ON DELETE CASCADE,FOREIGN KEY(key) REFERENCES plex_catalog(key) ON DELETE CASCADE)");
      await run(writer, "CREATE INDEX IF NOT EXISTS plex_shelf_member_key ON plex_shelf_members(key)");
      // 1.99alx catfix review: a paged walk's shelves wait here until the section's last page lands (promoteShelves). Never read
      // by the clerk; members are checked against plex_catalog again when they move over.
      await run(writer, "CREATE TABLE IF NOT EXISTS plex_shelves_next (key TEXT PRIMARY KEY,name TEXT,kind TEXT,section TEXT)");
      await run(writer, "CREATE TABLE IF NOT EXISTS plex_shelf_members_next (shelf TEXT,key TEXT,PRIMARY KEY(shelf,key),FOREIGN KEY(shelf) REFERENCES plex_shelves_next(key) ON DELETE CASCADE)");
      await run(writer, "CREATE TABLE IF NOT EXISTS plex_catalog_state (key TEXT PRIMARY KEY,value TEXT)");
      try {
        if (options.noFts) throw new Error("FTS disabled by test");
        await run(writer, "CREATE VIRTUAL TABLE temp.plex_fts_probe USING fts5(text,tokenize='unicode61 remove_diacritics 2')");
        await run(writer, "INSERT INTO temp.plex_fts_probe(text) VALUES ('probe café')");
        if ((await all(writer, "SELECT rowid FROM temp.plex_fts_probe WHERE plex_fts_probe MATCH ?", ['"cafe"'])).length !== 1) throw new Error("FTS probe failed");
        await run(writer, "DROP TABLE temp.plex_fts_probe");
        await run(writer, "CREATE VIRTUAL TABLE IF NOT EXISTS plex_catalog_fts USING fts5(key UNINDEXED,title,show,summary,genres,shelves,people,tokenize='unicode61 remove_diacritics 2')");
        fts = true;
        // 1.99alx catfix: an index row's rowid is its Plex key (ftsRow); one built before that (or without FTS) is rebuilt here
        const counts = (await all(writer, "SELECT (SELECT COUNT(*) FROM plex_catalog) AS rows,(SELECT COUNT(*) FROM plex_catalog_fts) AS indexed," +
          "(SELECT COUNT(*) FROM plex_catalog_fts WHERE rowid<>CAST(key AS INTEGER)) AS loose"))[0];
        if (counts.rows !== counts.indexed || counts.loose) {
          // A cache built on SQLite without FTS is still usable when FTS becomes available later.
          const tx = { run: (sql, args) => run(writer, sql, args), all: (sql, args) => all(writer, sql, args) };
          await run(writer, "BEGIN IMMEDIATE");
          try {
            await run(writer, "DELETE FROM plex_catalog_fts");
            for (const stored of await all(writer, "SELECT key,data FROM plex_catalog")) {
              const r = crow(parsed(stored.data, {}));
              if (r && r.key === stored.key) await ftsRow(tx, r, "");
            }
            await rebuildShelfFts(tx);
            await run(writer, "COMMIT");
          } catch (e) { await run(writer, "ROLLBACK").catch(() => {}); throw e; }
          if (counts.loose) log.log("[plexcatalog] search index rebuilt keyed by the Plex key (" + counts.rows + " rows)");
        }
      } catch (_) { fts = false; log.log("[plexcatalog] FTS unavailable; using LIKE"); }
      return true;
    })().catch(async (e) => { await closeDb(writer); writer = null; initPromise = null; throw coded("unavailable", "catalog unavailable"); });
    return initPromise;
  }
  function write(fn) {
    if (options.readOnly) return Promise.reject(coded("readonly", "catalog opened read-only"));
    const job = tail.catch(() => {}).then(async () => {
      await init();
      await run(writer, "BEGIN IMMEDIATE");
      const spy = (sql) => { if (options.onWrite) try { options.onWrite(sql); } catch (_) { /* a test's observer */ } };
      try { const out = await fn({ run: (s, p) => { spy(s); return run(writer, s, p); }, all: (s, p) => { spy(s); return all(writer, s, p); } }); await run(writer, "COMMIT"); generation++; return out; }
      catch (e) { await run(writer, "ROLLBACK").catch(() => {}); throw e; }
    });
    tail = job.catch(() => {});
    return job;
  }
  function read(sql, params = [], { budgetMs = SEARCH_BUDGET_MS } = {}) {
    return queued(sql, params, Math.max(1, Math.min(SEARCH_BUDGET_MS, number(budgetMs, SEARCH_BUDGET_MS))));
  }
  function queued(sql, params, budgetMs) {
    if (closed) return Promise.reject(coded("unavailable"));
    if (running && queue.length >= SEARCH_QUEUE) return Promise.reject(coded("busy"));
    return new Promise((resolve, reject) => { queue.push({ sql, params, budgetMs, resolve, reject }); pump(); });
  }
  function pump() {
    if (running || !queue.length) return;
    running = true;
    const job = queue.shift();
    (async () => {
      await init();
      if (!searchDb) searchDb = await connect(sqlite3.OPEN_READONLY);
      let expired = false, retry = null;
      const interrupt = () => { try { searchDb.interrupt(); } catch (_) {} };
      const budget = Math.max(1, Math.min(SHELVES_BUDGET_MS, number(job.budgetMs, SEARCH_BUDGET_MS)));
      if (options.onRead) try { options.onRead({ sql: job.sql, budgetMs: budget }); } catch (_) { /* a test's observer */ }
      const t = setTimeout(() => {
        expired = true; interrupt();
        // sqlite3 schedules work on its pool. An interrupt just before the statement starts is a no-op;
        // repeat until its callback settles so the deadline also covers that scheduling race.
        retry = setInterval(interrupt, 5);
      }, budget);
      try { const result = await all(searchDb, job.sql, job.params); if (expired) throw coded("too_broad"); return result; }
      catch (e) { throw expired || /interrupt/i.test(e.message || "") ? coded("too_broad") : e; }
      finally { clearTimeout(t); clearInterval(retry); }
    })().then(job.resolve, job.reject).finally(() => { running = false; pump(); });
  }
  async function state() {
    const rows = await read("SELECT key,value FROM plex_catalog_state");
    return Object.fromEntries(rows.map((r) => [r.key, parsed(r.value, null)]));
  }
  const putState = (tx, key, value) => tx.run("INSERT INTO plex_catalog_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, JSON.stringify(value)]);
  async function status() {
    try {
      const s = await state(), sections = await read("SELECT id,title,type,count,policy FROM plex_sections ORDER BY id");
      const count = (await read("SELECT COUNT(*) AS n FROM plex_catalog"))[0].n;
      // 1.99alx catfix: an unfinished full sweep - how far it got (the next run carries on from there)
      const p = s.progress && typeof s.progress === "object" ? s.progress : null;
      const allowedIds = sections.filter((x) => x.policy === "allowed").map((x) => String(x.id));
      // 1.99alx catfix review: a section read earlier in the sweep and turned off since isn't "read" of the allowed ones
      const progress = p ? { started: number(p.at, null), done: Array.isArray(p.done) ? p.done.filter((id) => allowedIds.includes(String(id))).length : 0,
        total: allowedIds.length, received: Math.max(0, number(p.received)) } : null;
      return { ready: s.allow_list_set === true && !!s.full_at && now() - s.full_at <= 3 * DAY && s.supported === true,
        at: s.at || null, full_at: s.full_at || null, version: s.version || null, allow_list_set: s.allow_list_set === true,
        requires_1_7: s.supported === false, sections, count, blocked: s.blocked || {}, dropped: s.dropped || 0,
        error: s.error || null, error_at: s.error ? number(s.error_at, null) : null, progress,
        shelves_skipped: Array.isArray(s.shelves_skipped) ? s.shelves_skipped : [], fts, syncing: !!syncing, v: s.v || 0 };
    } catch (_) { return { ready: false, at: null, full_at: null, version: null, sections: [], count: 0, error: "catalog unavailable", fts: false, v: 0 }; }
  }
  function condition({ kind, show_key, keys } = {}, args = [], blockSet = ratings(settings().clerk_block_ratings)) {
    const where = ["s.policy='allowed'"];
    const block = [...blockSet];
    const unblocked = (alias) => {
      if (!block.length) return "1";
      args.push(...block);
      return "upper(trim(COALESCE(" + alias + ".content_rating,''))) NOT IN (" + block.map(() => "?").join(",") + ")";
    };
    where.push(unblocked("c"));
    // A copied show title must never let an episode expose a denied or blocked show. This also fails
    // closed for orphaned episode rows and is reevaluated on every read after a setting change.
    where.push("(c.type<>'episode' OR EXISTS (SELECT 1 FROM plex_catalog p JOIN plex_sections ps ON ps.id=p.section WHERE p.key=c.show_key AND p.type='show' AND p.section=c.section AND ps.policy='allowed' AND " + unblocked("p") + "))");
    if (kind) { where.push("c.type=?"); args.push(kind); }
    if (show_key) { where.push("c.show_key=?"); args.push(String(show_key)); }
    if (Array.isArray(keys)) {
      const good = keys.map(String).filter((k) => KEY.test(k));
      if (!good.length) where.push("0");
      else { where.push("c.key IN (" + good.map(() => "?").join(",") + ")"); args.push(...good); }
    }
    return where.join(" AND ");
  }
  async function safeRows(raw) {
    const block = ratings(settings().clerk_block_ratings);
    const result = raw.map((r) => {
      const obj = crow(parsed(r.data, {}));
      if (!obj || obj.key !== r.key || obj.section !== r.section || obj.type !== r.type || block.has(String(r.content_rating || "").toUpperCase())) return null;
      obj.server_plays = number(r.server_plays); obj.pad_plays = number(r.pad_plays);
      return obj;
    }).filter((r) => r && !block.has(r.content_rating.toUpperCase()));
    const keys = result.map((r) => r.key);
    if (!keys.length) return result;
    const by = new Map();
    for (let i = 0; i < keys.length; i += 400) {
      const part = keys.slice(i, i + 400);
      const members = await read("SELECT m.key,s.name FROM plex_shelf_members m JOIN plex_shelves s ON s.key=m.shelf WHERE m.key IN (" + part.map(() => "?").join(",") + ")", part);
      for (const m of members) { if (!by.has(m.key)) by.set(m.key, []); by.get(m.key).push(m.name); }
    }
    for (const r of result) r.shelves = by.get(r.key) || [];
    return result;
  }
  async function rows(filters = {}) {
    const args = [], where = condition(filters, args);
    return safeRows(await read("SELECT c.* FROM plex_catalog c JOIN plex_sections s ON s.id=c.section WHERE " + where, args));
  }
  async function getByKeys(keys) {
    const order = [...new Set((keys || []).map(String))];
    const out = [];
    for (let i = 0; i < order.length; i += 400) out.push(...await rows({ keys: order.slice(i, i + 400) }));
    const by = new Map(out.map((r) => [r.key, r]));
    return order.map((key) => by.get(key)).filter(Boolean);
  }
  async function search(query, filters = {}) {
    const words = fold(query).split(" ").filter(Boolean).slice(0, 20);
    if (!words.length) return [];
    const args = [], where = condition(filters, args), limit = Math.max(1, Math.min(500, Math.floor(number(filters.limit, 200))));
    if (fts) {
      args.push(words.map((w) => '"' + w + '"').join(" OR "), limit);
      return safeRows(await read("SELECT c.* FROM plex_catalog c JOIN plex_sections s ON s.id=c.section JOIN plex_catalog_fts f ON f.key=c.key WHERE " + where + " AND plex_catalog_fts MATCH ? ORDER BY bm25(plex_catalog_fts) LIMIT ?", args, filters));
    }
    const like = words.map((w) => {
      args.push("%" + w + "%", "%" + w + "%", "%" + w + "%", "%" + w + "%");
      return "(c.title_fold LIKE ? ESCAPE '\\' OR c.show_fold LIKE ? ESCAPE '\\' OR lower(c.data) LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM plex_shelf_members sm JOIN plex_shelves ss ON ss.key=sm.shelf WHERE sm.key=c.key AND lower(ss.name) LIKE ? ESCAPE '\\'))";
    }).join(" OR ");
    args.push(limit);
    return safeRows(await read("SELECT c.* FROM plex_catalog c JOIN plex_sections s ON s.id=c.section WHERE " + where + " AND (" + like + ") LIMIT ?", args, filters));
  }
  // A caller gets its own copy (a kept answer is never handed out to be changed).
  const shelvesCopy = (v) => ({ ...v, genres: [...v.genres], shelves: v.shelves.map((r) => ({ ...r })), catalog: { ...v.catalog } });
  async function shelves() {
    const s = await status();
    if (!s.ready) return { ok: true, genres: [], shelves: [], v: s.v, catalog: { ready: false, at: s.at } };
    // one block list for the key AND the query - a change during the reads can never be kept under the other list's key
    const block = ratings(settings().clerk_block_ratings);
    const key = JSON.stringify([generation, [...block].sort(), s.at, s.full_at, s.v, s.count]);
    if (shelvesKept && shelvesKept.key === key) return shelvesCopy(shelvesKept.value);
    const args = [], where = condition({}, args, block);
    const genres = await queued("SELECT DISTINCT g.genre FROM plex_catalog_genres g JOIN plex_catalog c ON c.key=g.key JOIN plex_sections s ON s.id=c.section WHERE " + where + " ORDER BY g.genre LIMIT 80", args, SHELVES_BUDGET_MS);
    const sh = await queued("SELECT sh.name,sh.kind,sh.source,sh.ranked,COUNT(*) AS count FROM plex_shelves sh JOIN plex_shelf_members m ON m.shelf=sh.key JOIN plex_catalog c ON c.key=m.key JOIN plex_sections s ON s.id=c.section WHERE " + where + " GROUP BY sh.key ORDER BY sh.name LIMIT 150", args, SHELVES_BUDGET_MS);
    const value = { ok: true, genres: genres.map((r) => r.genre), shelves: sh.map((r) => ({ ...r, ranked: !!r.ranked })),
      v: s.v, catalog: { ready: true, at: s.at } };
    shelvesKept = { key, value };
    return shelvesCopy(value);
  }
  async function revoke(tx, keys) {
    const clean = [...new Set(keys.map(String).filter((k) => KEY.test(k)))];
    for (let i = 0; i < clean.length; i += 400) {
      const part = clean.slice(i, i + 400), marks = part.map(() => "?").join(",");
      const where = "key IN (" + marks + ") OR show_key IN (" + marks + ")";
      if (fts) await ftsDrop(tx, (await tx.all("SELECT key FROM plex_catalog WHERE " + where, [...part, ...part])).map((r) => r.key));
      await tx.run("DELETE FROM plex_catalog WHERE " + where, [...part, ...part]);
    }
  }
  async function purgeOrphans(tx) {
    const where = "type='episode' AND NOT EXISTS (SELECT 1 FROM plex_catalog parent WHERE parent.key=plex_catalog.show_key AND parent.type='show' AND parent.section=plex_catalog.section)";
    if (fts) await ftsDrop(tx, (await tx.all("SELECT key FROM plex_catalog WHERE " + where)).map((r) => r.key));
    return (await tx.run("DELETE FROM plex_catalog WHERE " + where)).changes;
  }
  async function removeUnsafe(tx, sections, block) {
    const allowed = new Set(sections.filter((s) => s.policy === "allowed").map((s) => s.id));
    const denied = (await tx.all("SELECT key,section,content_rating FROM plex_catalog")).filter((r) => !allowed.has(r.section) || block.has(String(r.content_rating || "").toUpperCase()));
    await revoke(tx, denied.map((r) => r.key));
    await purgeOrphans(tx);
    await tx.run("DELETE FROM plex_shelves WHERE source='kometa' AND section NOT IN (SELECT id FROM plex_sections WHERE policy='allowed')");
    await tx.run("DELETE FROM plex_shelves_next WHERE section NOT IN (SELECT id FROM plex_sections WHERE policy='allowed')");
  }
  async function installSections(tx, sections, allow, block) {
    await tx.run("DELETE FROM plex_sections");
    for (const s of sections) await tx.run("INSERT INTO plex_sections(id,title,type,count,policy) VALUES (?,?,?,?,?)", [s.id, allow ? s.title : "(hidden)", s.type, s.count, allow ? s.policy : "off"]);
    await removeUnsafe(tx, allow ? sections : [], block);
    await putState(tx, "allow_list_set", allow);
  }
  async function upsert(tx, r, seen) {
    await tx.run(`INSERT INTO plex_catalog(key,type,title,title_fold,show_key,show_fold,section,content_rating,data,seen_at,server_plays,pad_plays)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET type=excluded.type,title=excluded.title,title_fold=excluded.title_fold,
      show_key=excluded.show_key,show_fold=excluded.show_fold,section=excluded.section,content_rating=excluded.content_rating,data=excluded.data,seen_at=excluded.seen_at,
      server_plays=MAX(plex_catalog.server_plays,excluded.server_plays),pad_plays=excluded.pad_plays`,
    [r.key, r.type, r.title, fold(r.title), r.show_key, fold(r.show), r.section, r.content_rating, JSON.stringify(r), seen, r.server_plays, r.pad_plays]);
    await tx.run("DELETE FROM plex_catalog_genres WHERE key=?", [r.key]);
    for (const genre of r.genres) await tx.run("INSERT INTO plex_catalog_genres(key,genre) VALUES (?,?)", [r.key, genre]);
    if (fts) {
      const names = await tx.all("SELECT s.name FROM plex_shelves s JOIN plex_shelf_members m ON m.shelf=s.key WHERE m.key=?", [r.key]);
      await ftsDrop(tx, [r.key]);
      await ftsRow(tx, r, names.map((s) => s.name).join(" "));
    }
  }
  // 1.99alx catfix: the search index row's rowid IS the Plex key (keys are 1-12 digits, KEY), so a write finds its row directly.
  // The key column is UNINDEXED: "WHERE key=?" read the whole index for every row written (85 ms each at 240k rows).
  const ftsRow = (tx, r, shelves) => tx.run("INSERT INTO plex_catalog_fts(rowid,key,title,show,summary,genres,shelves,people) VALUES (?,?,?,?,?,?,?,?)",
    [Number(r.key), r.key, r.title, r.show, r.summary, r.genres.join(" "), shelves, [...r.directors, ...r.cast].join(" ")]);
  async function ftsDrop(tx, keys) {
    for (const k of new Set(keys.map(String))) if (KEY.test(k)) await tx.run("DELETE FROM plex_catalog_fts WHERE rowid=?", [Number(k)]);
  }
  // 1.99alx catfix: paged collections (mediactl 1.7.1+) arrive a page at a time, and a shelf a page repeats (Plex's list moved
  // between two pages) is kept once. 1.99alx catfix review: the pages are staged (plex_shelves_next) and swapped in by
  // promoteShelves when the section's last page lands - page 0 used to delete the section's shelves and the rest came back five
  // at a time over an hour, so the clerk saw part of them (for days, when a walk stopped). A whole answer (1.7.0) is stored
  // straight away: it is one transaction anyway.
  async function storeShelves(tx, section, list, { replace = true, staged = false } = {}) {
    if (replace) await tx.run(staged ? "DELETE FROM plex_shelves_next WHERE section=?" : "DELETE FROM plex_shelves WHERE source='kometa' AND section=?", [section]);
    for (const s of list || []) {
      const name = text(s.name || s.title), prefix = "kometa:" + section + ":", rawKey = text(String(s.key || ""), 160);
      const key = rawKey.startsWith(prefix) ? rawKey : prefix + rawKey;
      if (!name || !s.key) continue;
      const members = [...new Set((s.members || []).map(String).filter((k) => KEY.test(k)))].slice(0, 2000);
      const found = members.length ? await tx.all("SELECT key,type FROM plex_catalog WHERE section=? AND key IN (" + members.map(() => "?").join(",") + ")", [section, ...members]) : [];
      if (!found.length) continue;
      const kind = s.kind || (found.every((r) => r.type === "movie") ? "movie" : "show");
      if (staged) {
        if ((await tx.run("INSERT OR IGNORE INTO plex_shelves_next(key,name,kind,section) VALUES (?,?,?,?)", [key, name, kind, section])).changes !== 1) continue;
        for (const r of found) await tx.run("INSERT OR IGNORE INTO plex_shelf_members_next(shelf,key) VALUES (?,?)", [key, r.key]);
        continue;
      }
      if ((await tx.run("INSERT OR IGNORE INTO plex_shelves(key,name,kind,source,ranked,section) VALUES (?,?,?,'kometa',0,?)", [key, name, kind, section])).changes !== 1) continue;
      for (const r of found) await tx.run("INSERT OR IGNORE INTO plex_shelf_members(shelf,key,rank) VALUES (?,?,NULL)", [key, r.key]);
    }
  }
  /** The section's staged shelves replace its live ones in one go; a member is kept only while its row is still in that section. */
  async function promoteShelves(tx, section) {
    await tx.run("DELETE FROM plex_shelves WHERE source='kometa' AND section=?", [section]);
    const live = "FROM plex_shelf_members_next m JOIN plex_catalog c ON c.key=m.key AND c.section=n.section";
    await tx.run("INSERT OR IGNORE INTO plex_shelves(key,name,kind,source,ranked,section) SELECT n.key,n.name,n.kind,'kometa',0,n.section FROM plex_shelves_next n " +
      "WHERE n.section=? AND EXISTS (SELECT 1 " + live + " WHERE m.shelf=n.key)", [section]);
    await tx.run("INSERT OR IGNORE INTO plex_shelf_members(shelf,key,rank) SELECT m.shelf,m.key,NULL FROM plex_shelves_next n JOIN plex_shelf_members_next m ON m.shelf=n.key " +
      "JOIN plex_catalog c ON c.key=m.key AND c.section=n.section JOIN plex_shelves s ON s.key=n.key AND s.source='kometa' AND s.section=n.section WHERE n.section=?", [section]);
    await clearStaged(tx, section);
  }
  const clearStaged = (tx, section = null) => tx.run("DELETE FROM plex_shelves_next" + (section == null ? "" : " WHERE section=?"), section == null ? [] : [section]);
  // 1.99alx catfix: rewrites only the index rows whose shelf names changed (by rowid). It blanked every row and then found each
  // member by the unindexed key column - a rewrite of the whole index and a scan per shelf member at the end of every sync.
  async function rebuildShelfFts(tx) {
    if (!fts) return;
    const want = new Map();
    for (const r of await tx.all("SELECT m.key,group_concat(s.name,' ') AS names FROM plex_shelf_members m JOIN plex_shelves s ON s.key=m.shelf GROUP BY m.key"))
      if (KEY.test(String(r.key))) want.set(String(r.key), String(r.names || ""));
    for (const r of await tx.all("SELECT rowid AS id,key,shelves FROM plex_catalog_fts WHERE shelves<>''")) {
      const names = want.get(String(r.key)) || "";
      want.delete(String(r.key));
      if (names !== r.shelves) await tx.run("UPDATE plex_catalog_fts SET shelves=? WHERE rowid=?", [names, r.id]);
    }
    for (const [key, names] of want) if (names) await tx.run("UPDATE plex_catalog_fts SET shelves=? WHERE rowid=?", [names, Number(key)]);
  }
  /** One read from media-control, tried again (RETRY_WAITS_MS) when it fails for a passing reason: no answer, the service
   *  unreachable, 408/425/429/5xx. Any other answer fails at once. A failure carries `detail` (which read, why, how many tries). */
  async function provider(route, { timeout = PAGE_TIMEOUT_MS, where = null, waits = RETRY_WAITS_MS } = {}) {
    for (let attempt = 1; ; attempt++) {
      if (quiet(now())) throw coded("quiet", "catalog maintenance window");
      let r = null, failure;
      try { r = await mediactl("GET", route, null, { timeout }); }
      catch (e) { failure = clientFailure(e); }
      if (r) {
        if (r.status === 404 && route === "/sections") throw coded("old", "needs media-control 1.7.0");
        if (r.status === 200 && r.json && r.json.ok !== false) return r.json;
        failure = { status: Number(r.status) || null, transient: TRANSIENT.has(Number(r.status)) };
      }
      const detail = { ...(where || { step: "sections" }), status: failure.status, timeout: !!failure.timeout, timeout_ms: timeout,
        unconfigured: !!failure.unconfigured, pin: !!failure.pin, bad_url: !!failure.bad_url, reason: failure.reason || null,
        lasting: !!failure.lasting, attempts: attempt };
      if (!failure.transient || attempt > waits.length) throw Object.assign(coded("upstream", "catalog source unavailable"), { detail });
      log.log("[plexcatalog] " + describeRead(detail) + ": " + describeWhy(detail) + " - trying again in " + Math.round(waits[attempt - 1] / 1000) + " s");
      await sleep(waits[attempt - 1]);
    }
  }
  const unusable = (where) => Object.assign(coded("upstream", "catalog source unavailable"), { detail: { ...where, unusable: true, attempts: 1 } });
  /** An unfinished full sweep worth carrying on: same block list, not too old, well formed. */
  function resumable(p, at, fingerprint) {
    if (!p || typeof p !== "object" || p.v !== 1 || p.fingerprint !== fingerprint || !Number.isFinite(p.seen) || !Number.isFinite(p.at)) return null;
    if (at - p.at > PROGRESS_MAX_AGE_MS || p.at > at || !Array.isArray(p.done)) return null;
    const c = p.cursor;
    if (c != null && (typeof c !== "object" || !/^[A-Za-z0-9_-]{1,64}$/.test(String(c.section)) || ![2, 4, 1, "collections"].includes(c.type) ||
      !Number.isInteger(c.start) || c.start < 0)) return null;
    // 1.99alx catfix review: `back` is where the page before the cursor started, `before` the counts as that page began
    const back = c && Number.isInteger(c.back) && c.back >= 0 && c.back <= c.start ? c.back : null;
    const b = c && back != null && c.before && typeof c.before === "object" ? c.before : null;
    const cursor = c ? { section: String(c.section), type: c.type, start: c.start, back,
      before: b ? { received: Math.max(0, number(b.received)), dropped: Math.max(0, number(b.dropped)), blocked: b.blocked && typeof b.blocked === "object" ? { ...b.blocked } : {} } : null } : null;
    return { v: 1, at: p.at, seen: p.seen, fingerprint, done: p.done.map(String), cursor,
      received: Math.max(0, number(p.received)), dropped: Math.max(0, number(p.dropped)), blocked: p.blocked && typeof p.blocked === "object" ? { ...p.blocked } : {},
      skipped: Array.isArray(p.skipped) ? p.skipped.filter((x) => x && typeof x === "object").map((x) => ({ section: String(x.section), why: text(String(x.why || ""), 120) })) : [] };
  }
  async function counts(sections, dry) {
    if (dry) return;
    let pad = [], meta = [];
    try { pad = await mainRead("SELECT rating_key,COUNT(*) AS n FROM media_plays WHERE rating_key IS NOT NULL GROUP BY rating_key", []); } catch (_) {}
    try { meta = await mainRead("SELECT rating_key,server_plays FROM plex_meta WHERE server_plays IS NOT NULL", []); } catch (_) {}
    await write(async (tx) => {
      await tx.run("UPDATE plex_catalog SET pad_plays=0");
      for (const p of pad) await tx.run("UPDATE plex_catalog SET pad_plays=? WHERE key=?", [Math.max(0, number(p.n)), String(p.rating_key)]);
      for (const p of meta) await tx.run("UPDATE plex_catalog SET server_plays=MAX(server_plays,?) WHERE key=?", [Math.max(0, number(p.server_plays)), String(p.rating_key)]);
    });
    if (!tautulli || !tautulli.configured()) return;
    for (const s of sections.filter((r) => r.policy === "allowed")) {
      let start = 0;
      for (;;) {
        if (quiet(now())) throw coded("quiet");
        await sleep(250);
        let r;
        try { r = await tautulli.call("get_library_media_info", { section_id: s.id, start, length: 500 }, { timeout: 15000 }); }
        catch (_) { log.log("[plexcatalog] play counts unavailable"); break; }
        const data = Array.isArray(r) ? r : (r && Array.isArray(r.data) ? r.data : []);
        await write(async (tx) => { for (const row of data) if (KEY.test(String(row.rating_key))) await tx.run("UPDATE plex_catalog SET server_plays=? WHERE key=? AND section=?", [Math.max(0, number(row.play_count)), String(row.rating_key), s.id]); });
        start += data.length;
        const total = r && number(r.recordsFiltered || r.recordsTotal, data.length);
        if (!data.length || data.length < 500 || start >= total || start >= 1000000) break;
      }
    }
  }
  async function doSync({ full = false, dry = false } = {}) {
    if (quiet(now())) return { ok: true, skipped: "maintenance", dry };
    await init();
    const previous = await state(), cfg = settings(), block = ratings(cfg.clerk_block_ratings), fingerprint = [...block].sort().join(",");
    const at = now();
    // 1.99alx catfix: an unfinished full sweep (a read that kept failing, the maintenance window, a restart) is carried on from
    // the page it stopped at - with its own start time and seen marker, so its end still removes what Plex no longer has.
    // Any run while one is unfinished is that sweep (a delta in between would stamp rows with another marker).
    const resume = dry ? null : resumable(previous.progress, at, fingerprint);
    full = !!resume || !!full || !previous.full_at || new Date(previous.full_at).toISOString().slice(0, 10) !== new Date(at).toISOString().slice(0, 10) || previous.block_fingerprint !== fingerprint;
    const keep = full && !dry;   // only a full sweep keeps its place; a failed delta is simply read again from the last "at"
    const run = resume || { v: 1, at, seen: null, fingerprint, done: [], cursor: null, received: 0, dropped: 0, blocked: {}, skipped: [] };
    let received = run.received, dropped = run.dropped, sections = [];
    const blocked = { ...run.blocked }, skipped = [...(run.skipped || [])];
    const revokedInRun = new Set();
    const saveRun = (tx, cursor, doneSection) => {
      if (!keep) return null;
      run.cursor = cursor;
      if (doneSection != null && !run.done.includes(doneSection)) run.done.push(doneSection);
      Object.assign(run, { received, dropped, blocked: { ...blocked }, skipped: skipped.map((x) => ({ ...x })) });
      return putState(tx, "progress", run);
    };
    try {
      const source = await provider("/sections");
      sections = sectionRows(source.sections);
      const allow = source.allow_list_set === true;
      if (!dry) await write(async (tx) => { await installSections(tx, sections, allow, block); await putState(tx, "supported", true); });
      if (!allow) {
        if (!dry) await write(async (tx) => { await putState(tx, "error", "set MEDIACTL_SECTIONS"); await putState(tx, "error_at", at); });
        return { ok: false, dry, error: "set MEDIACTL_SECTIONS", sections, received: 0, dropped: 0 };
      }
      let version = null;
      try { const h = await provider("/health", { waits: [] }); version = /^\d+\.\d+\.\d+$/.test(h.version || "") ? h.version : null; } catch (e) { if (e.code === "quiet") throw e; }
      const allowed = new Set(sections.filter((s) => s.policy === "allowed").map((s) => s.id));
      if (resume) log.log("[plexcatalog] carrying on the full sweep from " + new Date(run.at).toISOString() + ": " + run.done.filter((id) => allowed.has(id)).length + " of " + allowed.size + " sections done");
      const seen = dry ? at : resume ? run.seen : await write(async (tx) => {
        const prior = await tx.all("SELECT value FROM plex_catalog_state WHERE key='seen_generation'");
        const next = Math.max(at, number(prior[0] && parsed(prior[0].value, 0)) + 1);
        await putState(tx, "seen_generation", next);
        run.seen = next;
        if (full) await clearStaged(tx);   // a new sweep: nothing staged by an earlier one is carried into it
        await saveRun(tx, null, null);
        return next;
      });
      // 1.99alx catfix review: a resumed sweep starts at the page BEFORE its cursor (`back`), with the counts as that page began.
      // Plex's listing is read by offset: a title it removed before the cursor while the sweep waited (10 minutes, the window, a
      // day) shifts the rest down one place, and the title that moved from the cursor to just before it was never read - the
      // sweep's end then deleted it. Reading a page again is harmless (upserts, the same seen marker); a page holds 500.
      const backAt = (here) => {
        if (here.back == null) return here.start;
        if (here.before) {
          received = here.before.received; dropped = here.before.dropped;
          for (const k of Object.keys(blocked)) delete blocked[k];
          Object.assign(blocked, here.before.blocked);
        }
        return here.back;
      };
      const since = !full && previous.at ? Math.max(0, Math.floor(previous.at / 1000) - 1) : null;
      for (const s of sections.filter((r) => r.policy === "allowed")) {
        if (run.done.includes(s.id)) continue;
        const here = run.cursor && String(run.cursor.section) === s.id ? run.cursor : null;
        const types = s.type === "show" ? [2, 4] : [1];
        const from = here ? (here.type === "collections" ? types.length : Math.max(0, types.indexOf(here.type))) : 0;
        for (let ti = from; ti < types.length; ti++) {
          const type = types[ti];
          let start = here && here.type === type ? backAt(here) : 0;
          for (;;) {
            const mark = { received, dropped, blocked: { ...blocked } };
            const where = { step: "catalog", section: s.id, kind: s.type, type, start, since: since != null };
            const route = "/catalog?section=" + encodeURIComponent(s.id) + "&type=" + type + "&start=" + start + "&size=500" + (since != null ? "&since=" + since : "");
            const page = await provider(route, { where }), clean = [], revoked = [];
            if (!Array.isArray(page.rows)) throw unusable(where);
            const next = page.next == null ? null : Number(page.next);
            if (next != null && (!Number.isInteger(next) || next <= start || next > 10000000)) throw unusable(where);
            for (const input of page.rows) {
              const row = crow(input);
              if (!row || row.section !== s.id || !allowed.has(row.section)) { dropped++; if (input && KEY.test(String(input.key))) { revoked.push(String(input.key)); revokedInRun.add(String(input.key)); } continue; }
              if (block.has(row.content_rating.toUpperCase())) { const k = row.section + ":" + row.content_rating.toUpperCase(); blocked[k] = (blocked[k] || 0) + 1; revoked.push(row.key); revokedInRun.add(row.key); continue; }
              clean.push(row); received++;
            }
            if (!dry) await write(async (tx) => {
              await revoke(tx, revoked);
              for (const r of clean) {
                if (revokedInRun.has(r.key) || (r.show_key && revokedInRun.has(r.show_key))) continue;
                if (r.type === "episode" && !(await tx.all("SELECT key FROM plex_catalog WHERE key=? AND type='show' AND section=?", [r.show_key, r.section])).length) { dropped++; continue; }
                await upsert(tx, r, seen);
              }
              // the rows and the place after them, in one transaction
              await saveRun(tx, next != null ? { section: s.id, type, start: next, back: start, before: mark }
                : { section: s.id, type: ti + 1 < types.length ? types[ti + 1] : "collections", start: 0 }, null);
            });
            if (next == null) break;
            start = next;
          }
        }
        // Shelves (Plex collections) are the full sweep's only: a large section's are thousands of slow Plex reads (prod: 1381
        // collections, 2-3 s a member read). mediactl 1.7.1+ answers a page of shelves at a time; 1.7.0 ignores start/size and
        // answers the whole section at once (one try: 1.7.0 goes on walking after the site leaves). 1.99alx catfix review: the
        // catalog can do without shelves, so a shelves read that still fails - after its tries, or an answer that isn't usable -
        // never stops the sweep (on 1.7.1 that held every later run on the same page: no deltas, full_at never moved). The
        // section keeps the shelves it had, the sweep goes on, and the next day's sweep tries again.
        let paged = pagedCollections(version);
        let cstart = here && here.type === "collections" ? backAt(here) : 0;
        while (full) {
          const where = { step: "collections", section: s.id, kind: s.type, start: cstart };
          const route = "/collections?section=" + encodeURIComponent(s.id) + "&start=" + cstart + "&size=" + COLLECTIONS_PAGE;
          let c, pagedAnswer, next;
          try {
            c = await provider(route, paged ? { where, timeout: COLLECTIONS_PAGE_TIMEOUT_MS } : { where, timeout: COLLECTIONS_WALK_TIMEOUT_MS, waits: [] });
            if (!Array.isArray(c.collections)) throw unusable(where);
            pagedAnswer = Object.prototype.hasOwnProperty.call(c, "next");
            next = pagedAnswer && c.next != null ? Number(c.next) : null;
            if (next != null && (!Number.isInteger(next) || next <= cstart || next > 10000000)) throw unusable(where);
          } catch (e) {
            if (e.code !== "upstream" || !e.detail) throw e;   // the maintenance window, a write: the sweep stops and keeps its place
            const why = describeWhy(e.detail) + (e.detail.attempts > 1 ? " (" + e.detail.attempts + " tries)" : "");
            skipped.push({ section: s.id, why });
            log.log("[plexcatalog] " + describeRead(where) + " not refreshed: " + why + " - " + (paged ? "the section keeps the shelves it had" : "media-control 1.7.1 reads them a page at a time"));
            if (!dry) await write(async (tx) => { await clearStaged(tx, s.id); await saveRun(tx, null, s.id); });
            break;
          }
          if (pagedAnswer) paged = true;   // a 1.7.1 answer though /health didn't say so: the next pages are read as pages
          if (!dry) await write(async (tx) => {
            if (!pagedAnswer) { await clearStaged(tx, s.id); await storeShelves(tx, s.id, c.collections); }
            else {
              await storeShelves(tx, s.id, c.collections, { staged: true, replace: cstart === 0 });
              if (next == null) await promoteShelves(tx, s.id);
            }
            await saveRun(tx, next != null ? { section: s.id, type: "collections", start: next, back: cstart } : null, next != null ? null : s.id);
          });
          if (next == null) break;
          cstart = next;
        }
      }
      if (!dry) {
        await counts(sections, false);
        await write(async (tx) => {
          if (full) {
            if (fts) await ftsDrop(tx, (await tx.all("SELECT key FROM plex_catalog WHERE seen_at<>?", [seen])).map((r) => r.key));
            await tx.run("DELETE FROM plex_catalog WHERE seen_at<>?", [seen]);
            await purgeOrphans(tx);
            await putState(tx, "full_at", run.at);
          }
          await rebuildShelfFts(tx);
          if (full) await putState(tx, "shelves_skipped", skipped);
          for (const [key, value] of Object.entries({ at: run.at, version, block_fingerprint: fingerprint, blocked, dropped, error: null, error_at: null,
            error_detail: null, progress: null, v: (previous.v || 0) + 1 })) await putState(tx, key, value);
        });
      }
      log.log("[plexcatalog] " + (dry ? "dry " : "") + (full ? "full" : "delta") + (resume ? " (carried on)" : "") + " received=" + received + " dropped=" + dropped + " blocked=" + Object.values(blocked).reduce((a, b) => a + b, 0));
      return { ok: true, dry, full, received, dropped, blocked, sections, version, resumed: !!resume };
    } catch (e) {
      const error = e.code === "old" ? "needs media-control 1.7.0" : e.code === "quiet" ? "maintenance window"
        : e.code === "upstream" ? sourceError(e.detail) : "catalog sync failed: " + text(String((e && e.message) || e), 120).replace(/https?:\/\/\S+/g, "<url>");
      if (!dry) await write(async (tx) => {
        await putState(tx, "error", error); await putState(tx, "error_at", now()); await putState(tx, "error_detail", e.detail || null);
        if (e.code === "old") await putState(tx, "supported", false);
      }).catch(() => {});
      const ids = sections.filter((r) => r.policy === "allowed").map((r) => r.id);
      const kept = keep && run.seen != null ? " - kept: " + run.done.filter((id) => ids.includes(id)).length + " of " + ids.length + " sections done, the next run carries on" : "";
      log.log("[plexcatalog] sync failed: " + error + kept);
      // 1.99alx catfix review: no sooner look for what asking again can't fix (an old mediactl, the site's own configuration)
      return { ok: false, dry, error, received, dropped, retry: e.code !== "old" && !(e.detail && e.detail.lasting) };
    }
  }
  let outsideLists;
  function listsCache() {
    if (!outsideLists) outsideLists = options.lists || require("./plexlists").createLists({
      catalog: { write, read, rows, getByKeys }, settings, now,
      permissions: options.permissions, guard: options.guard
    });
    return outsideLists;
  }
  function sync(opts = {}) {
    if (syncing) return syncing;
    syncing = doSync(opts).then(async (result) => {
      if (result.ok && !opts.dry) {
        try { if (listsCache().enabled()) await listsCache().rematch(); } catch (_) { /* lists retain their last complete cache */ }
      }
      return result;
    }).catch(() => ({ ok: false, dry: !!opts.dry, error: "catalog unavailable" })).finally(() => { syncing = null; });
    return syncing;
  }
  async function dryCount() {
    if (quiet(now())) return { ok: true, dry: true, skipped: "maintenance" };
    try {
      const source = await provider("/sections"), allow = source.allow_list_set === true;
      const sections = sectionRows(source.sections).map((s) => allow ? s : { ...s, title: "(hidden)", policy: "off" });
      return { ok: true, dry: true, allow_list_set: allow, sections,
        allowed_count: sections.filter((s) => s.policy === "allowed").reduce((n, s) => n + s.count, 0) };
    } catch (e) { return { ok: false, dry: true, error: e.code === "old" ? "needs media-control 1.7.0" : "catalog source unavailable" }; }
  }
  async function importSnapshot(snapshot) {
    if (!snapshot || snapshot.v !== 1 || snapshot.allow_list_set !== true || !Array.isArray(snapshot.rows)) throw coded("bad_snapshot", "snapshot needs a reviewed allow-list");
    const sections = sectionRows(snapshot.sections), allowed = new Set(sections.filter((s) => s.policy === "allowed").map((s) => s.id)), block = ratings(settings().clerk_block_ratings);
    if (!allowed.size) throw coded("bad_snapshot", "snapshot needs allowed sections");
    const stamp = now();
    let kept = 0, dropped = 0, blocked = {};
    await write(async (tx) => {
      await tx.run("DELETE FROM plex_shelves");
      await clearStaged(tx);
      if (fts) await tx.run("DELETE FROM plex_catalog_fts");
      await tx.run("DELETE FROM plex_catalog");
      await installSections(tx, sections, true, block);
      for (const input of snapshot.rows) {
        const r = crow(input);
        if (!r || !allowed.has(r.section)) { dropped++; continue; }
        if (block.has(r.content_rating.toUpperCase())) { const k = r.section + ":" + r.content_rating.toUpperCase(); blocked[k] = (blocked[k] || 0) + 1; continue; }
        await upsert(tx, r, stamp); kept++;
      }
      const orphaned = await purgeOrphans(tx);
      kept -= orphaned; dropped += orphaned;
      for (const s of sections.filter((x) => x.policy === "allowed")) await storeShelves(tx, s.id, snapshot.shelves || []);
      await rebuildShelfFts(tx);
      // 1.99alx catfix review: the import replaces the catalog, so an unfinished sweep ends here too - carried on, its old seen
      // marker would make its end delete every imported row - and its error and skipped shelves go with it
      for (const [k, v] of Object.entries({ at: Math.min(stamp, number(snapshot.at, stamp)), full_at: Math.min(stamp, number(snapshot.full_at, stamp)), supported: true, allow_list_set: true, version: "snapshot", v: stamp,
        block_fingerprint: [...block].sort().join(","), blocked, dropped, error: null, error_at: null, error_detail: null, progress: null, shelves_skipped: [] })) await putState(tx, k, v);
    });
    // Import replaces the same rows as a full sync. Rebuild local list membership even
    // on staging without mediactl; no provider call is needed or allowed here.
    try { if (listsCache().enabled()) await listsCache().rematch(); } catch (_) { /* catalog import remains usable if lists are unavailable */ }
    return { ok: true, kept, dropped, blocked };
  }
  async function exportSnapshot() {
    const status_ = await status();
    if (!status_.ready) throw coded("catalog_down", "catalog is not ready");
    const data = await rows(), allowedKeys = new Set(data.map((r) => r.key));
    const lists = await read("SELECT * FROM plex_shelves WHERE source='kometa' ORDER BY key");
    const members = await read("SELECT shelf,key FROM plex_shelf_members ORDER BY shelf,key");
    return { v: 1, allow_list_set: true, at: status_.at, full_at: status_.full_at, sections: status_.sections,
      rows: data.map((r) => crow(r)), shelves: lists.map((s) => ({ key: s.key, name: s.name, kind: s.kind, source: "kometa", ranked: false,
        members: members.filter((m) => m.shelf === s.key && allowedKeys.has(m.key)).map((m) => m.key) })).filter((s) => s.members.length) };
  }
  // 1.99alq train3 verify: the timer syncs only while something uses the catalog (the clerk, its requests, its vectors or its
  // lists - any of them on); with every switch off it reads nothing (no mediactl /sections, no Tautulli, no catalog file) and
  // looks again every IDLE_CHECK_MIN, so a switch turned on is picked up within minutes. "Sync now" on /admin/media still
  // pre-warms it by hand with everything off.
  const inUse = (cfg) => ["clerk_enabled", "clerk_requests"].some((k) => cfg[k] && cfg[k] !== "off") || cfg.clerk_embed === true || cfg.clerk_lists === true;
  function start() {
    if (timer || closed || options.readOnly) return;
    const tick = async () => {
      if (!options.settings) { try { await require("./mediaconf").init(); } catch (_) { /* a standalone tool */ } }
      const on = inUse(settings() || {});
      let last = null;
      if (!closed && on && !quiet(now())) last = await sync();
      // 1.99alx catfix: a run that failed for a passing reason is tried again after RETRY_MIN (an unfinished sweep carries on)
      if (!closed) { timer = setTimeout(tick, nextTickMin(settings() || {}, on, last) * 60000); if (timer.unref) timer.unref(); }
    };
    timer = setTimeout(tick, 0);
    if (timer.unref) timer.unref();
  }
  async function close() {
    closed = true;
    clearTimeout(timer); timer = null;
    if (outsideLists) await outsideLists.close();
    for (const q of queue.splice(0)) q.reject(coded("unavailable"));
    await tail;
    if (syncing) await syncing.catch(() => {});
    while (running) await new Promise((resolve) => setImmediate(resolve));
    await Promise.all([closeDb(writer), closeDb(searchDb)]);
    writer = searchDb = null;
  }
  let adminVectors;
  function vectorsCache() {
    if (!adminVectors) adminVectors = options.vectors || require("./plexvectors").createVectors({ catalog: { read, write }, settings, now });
    return adminVectors;
  }
  function register(app, { addUser, noTimers } = {}) {
    const SP = options.permissions || require("./siteperms"), guard = options.guard || require("./middleware/authGuard");
    const admin = (req, res, next) => {
      if (!SP.can(req.user, "media.admin")) return res.status(403).json({ ok: false, error: "Admins only." });
      if (req.method === "POST" && !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
      next();
    };
    const route = (fn) => [addUser, admin, async (req, res) => {
      res.set("Cache-Control", "no-store");
      try { res.json(await fn(req)); } catch (_) { res.status(503).json({ ok: false, error: "catalog unavailable" }); }
    }];
    app.get("/api/media/admin/catalog", ...route(async () => {
      let embed = { enabled: false, ready: false, done: 0, left: 0 };
      try {
        embed = await vectorsCache().status();
      } catch (_) { embed = { enabled: !!settings().clerk_embed, ready: false, done: 0, left: 0 }; }
      return { ok: true, ...(await status()), embed };
    }));
    app.post("/api/media/admin/catalog/sync", ...route(async () => {
      if (quiet(now())) return { ok: true, started: false, skipped: "maintenance" };
      const started = !syncing;
      sync({ full: true }).catch(() => {});
      return { ok: true, started, syncing: true };
    }));
    app.post("/api/media/admin/catalog/dry", ...route(() => dryCount()));
    listsCache().register(app, { addUser, noTimers });
    if (!noTimers) start();
  }
  return { init, sync, dryCount, status, shelves, rows, getByKeys, search, read, write, importSnapshot, exportSnapshot, start, close, register, file, inUse };
}

let singleton;
const current = () => {
  if (!singleton) {
    singleton = createCatalog();
    try { require("./shutdown").onExit((done) => singleton.close().then(done, done)); } catch (_) { /* standalone tool */ }
  }
  return singleton;
};
module.exports = { createCatalog, crow, fold, ratings, normRating, quiet, nextTickMin, sourceError, SEARCH_BUDGET_MS, SHELVES_BUDGET_MS, SEARCH_QUEUE };
for (const name of ["init", "sync", "dryCount", "status", "shelves", "rows", "getByKeys", "search", "read", "write", "importSnapshot", "exportSnapshot", "start", "close", "register"]) module.exports[name] = (...args) => current()[name](...args);
