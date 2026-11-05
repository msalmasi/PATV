// Plex clerk's rebuildable, section-filtered metadata cache. No media files or personal history live here.
"use strict";
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3");

const DAY = 86400000, SEARCH_BUDGET_MS = 400, SEARCH_QUEUE = 4;
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
const ratings = (v) => new Set(String(v == null ? DEFAULT_BLOCK : v).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
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
    content_rating: text(r.content_rating, 40), rating: Math.max(0, Math.min(10, number(r.rating, 0))) || null,
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
  let running = false;
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
      await run(writer, "CREATE TABLE IF NOT EXISTS plex_catalog_state (key TEXT PRIMARY KEY,value TEXT)");
      try {
        if (options.noFts) throw new Error("FTS disabled by test");
        await run(writer, "CREATE VIRTUAL TABLE temp.plex_fts_probe USING fts5(text,tokenize='unicode61 remove_diacritics 2')");
        await run(writer, "INSERT INTO temp.plex_fts_probe(text) VALUES ('probe café')");
        if ((await all(writer, "SELECT rowid FROM temp.plex_fts_probe WHERE plex_fts_probe MATCH ?", ['"cafe"'])).length !== 1) throw new Error("FTS probe failed");
        await run(writer, "DROP TABLE temp.plex_fts_probe");
        await run(writer, "CREATE VIRTUAL TABLE IF NOT EXISTS plex_catalog_fts USING fts5(key UNINDEXED,title,show,summary,genres,shelves,people,tokenize='unicode61 remove_diacritics 2')");
        fts = true;
        const counts = (await all(writer, "SELECT (SELECT COUNT(*) FROM plex_catalog) AS rows,(SELECT COUNT(*) FROM plex_catalog_fts) AS indexed"))[0];
        if (counts.rows !== counts.indexed) {
          // A cache built on SQLite without FTS is still usable when FTS becomes available later.
          await run(writer, "DELETE FROM plex_catalog_fts");
          for (const stored of await all(writer, "SELECT data FROM plex_catalog")) {
            const r = crow(parsed(stored.data, {}));
            if (r) await run(writer, "INSERT INTO plex_catalog_fts(key,title,show,summary,genres,shelves,people) VALUES (?,?,?,?,?,'',?)", [r.key, r.title, r.show, r.summary, r.genres.join(" "), [...r.directors, ...r.cast].join(" ")]);
          }
          await rebuildShelfFts({ run: (s, p) => run(writer, s, p), all: (s, p) => all(writer, s, p) });
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
      try { const out = await fn({ run: (s, p) => run(writer, s, p), all: (s, p) => all(writer, s, p) }); await run(writer, "COMMIT"); return out; }
      catch (e) { await run(writer, "ROLLBACK").catch(() => {}); throw e; }
    });
    tail = job.catch(() => {});
    return job;
  }
  function read(sql, params = [], { budgetMs = SEARCH_BUDGET_MS } = {}) {
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
      const t = setTimeout(() => {
        expired = true; interrupt();
        // sqlite3 schedules work on its pool. An interrupt just before the statement starts is a no-op;
        // repeat until its callback settles so the deadline also covers that scheduling race.
        retry = setInterval(interrupt, 5);
      }, Math.max(1, Math.min(SEARCH_BUDGET_MS, number(job.budgetMs, SEARCH_BUDGET_MS))));
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
      return { ready: s.allow_list_set === true && !!s.full_at && now() - s.full_at <= 3 * DAY && s.supported === true,
        at: s.at || null, full_at: s.full_at || null, version: s.version || null, allow_list_set: s.allow_list_set === true,
        requires_1_7: s.supported === false, sections, count, blocked: s.blocked || {}, dropped: s.dropped || 0,
        error: s.error || null, fts, syncing: !!syncing, v: s.v || 0 };
    } catch (_) { return { ready: false, at: null, full_at: null, version: null, sections: [], count: 0, error: "catalog unavailable", fts: false, v: 0 }; }
  }
  function condition({ kind, show_key, keys } = {}, args = []) {
    const where = ["s.policy='allowed'"];
    const block = [...ratings(settings().clerk_block_ratings)];
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
  async function shelves() {
    const s = await status();
    if (!s.ready) return { ok: true, genres: [], shelves: [], v: s.v, catalog: { ready: false, at: s.at } };
    const args = [], where = condition({}, args);
    const genres = await read("SELECT DISTINCT g.genre FROM plex_catalog_genres g JOIN plex_catalog c ON c.key=g.key JOIN plex_sections s ON s.id=c.section WHERE " + where + " ORDER BY g.genre LIMIT 80", args);
    const sh = await read("SELECT sh.name,sh.kind,sh.source,sh.ranked,COUNT(*) AS count FROM plex_shelves sh JOIN plex_shelf_members m ON m.shelf=sh.key JOIN plex_catalog c ON c.key=m.key JOIN plex_sections s ON s.id=c.section WHERE " + where + " GROUP BY sh.key ORDER BY sh.name LIMIT 150", args);
    return { ok: true, genres: genres.map((r) => r.genre), shelves: sh.map((r) => ({ ...r, ranked: !!r.ranked })),
      v: s.v, catalog: { ready: true, at: s.at } };
  }
  async function revoke(tx, keys) {
    const clean = [...new Set(keys.map(String).filter((k) => KEY.test(k)))];
    for (let i = 0; i < clean.length; i += 400) {
      const part = clean.slice(i, i + 400), marks = part.map(() => "?").join(",");
      const where = "key IN (" + marks + ") OR show_key IN (" + marks + ")";
      if (fts) await tx.run("DELETE FROM plex_catalog_fts WHERE key IN (SELECT key FROM plex_catalog WHERE " + where + ")", [...part, ...part]);
      await tx.run("DELETE FROM plex_catalog WHERE " + where, [...part, ...part]);
    }
  }
  async function purgeOrphans(tx) {
    const where = "type='episode' AND NOT EXISTS (SELECT 1 FROM plex_catalog parent WHERE parent.key=plex_catalog.show_key AND parent.type='show' AND parent.section=plex_catalog.section)";
    if (fts) await tx.run("DELETE FROM plex_catalog_fts WHERE key IN (SELECT key FROM plex_catalog WHERE " + where + ")");
    return (await tx.run("DELETE FROM plex_catalog WHERE " + where)).changes;
  }
  async function removeUnsafe(tx, sections, block) {
    const allowed = new Set(sections.filter((s) => s.policy === "allowed").map((s) => s.id));
    const denied = (await tx.all("SELECT key,section,content_rating FROM plex_catalog")).filter((r) => !allowed.has(r.section) || block.has(String(r.content_rating || "").toUpperCase()));
    await revoke(tx, denied.map((r) => r.key));
    await purgeOrphans(tx);
    await tx.run("DELETE FROM plex_shelves WHERE source='kometa' AND section NOT IN (SELECT id FROM plex_sections WHERE policy='allowed')");
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
      await tx.run("DELETE FROM plex_catalog_fts WHERE key=?", [r.key]);
      const names = await tx.all("SELECT s.name FROM plex_shelves s JOIN plex_shelf_members m ON m.shelf=s.key WHERE m.key=?", [r.key]);
      await tx.run("INSERT INTO plex_catalog_fts(key,title,show,summary,genres,shelves,people) VALUES (?,?,?,?,?,?,?)", [r.key, r.title, r.show, r.summary,
        r.genres.join(" "), names.map((s) => s.name).join(" "), [...r.directors, ...r.cast].join(" ")]);
    }
  }
  async function storeShelves(tx, section, list) {
    await tx.run("DELETE FROM plex_shelves WHERE source='kometa' AND section=?", [section]);
    for (const s of list || []) {
      const name = text(s.name || s.title), prefix = "kometa:" + section + ":", rawKey = text(String(s.key || ""), 160);
      const key = rawKey.startsWith(prefix) ? rawKey : prefix + rawKey;
      if (!name || !s.key) continue;
      const members = [...new Set((s.members || []).map(String).filter((k) => KEY.test(k)))].slice(0, 2000);
      const found = members.length ? await tx.all("SELECT key,type FROM plex_catalog WHERE section=? AND key IN (" + members.map(() => "?").join(",") + ")", [section, ...members]) : [];
      if (!found.length) continue;
      const kind = s.kind || (found.every((r) => r.type === "movie") ? "movie" : "show");
      await tx.run("INSERT INTO plex_shelves(key,name,kind,source,ranked,section) VALUES (?,?,?,'kometa',0,?)", [key, name, kind, section]);
      for (const r of found) await tx.run("INSERT INTO plex_shelf_members(shelf,key,rank) VALUES (?,?,NULL)", [key, r.key]);
    }
  }
  async function rebuildShelfFts(tx) {
    if (!fts) return;
    const joined = await tx.all("SELECT m.key,group_concat(s.name,' ') AS names FROM plex_shelf_members m JOIN plex_shelves s ON s.key=m.shelf GROUP BY m.key");
    await tx.run("UPDATE plex_catalog_fts SET shelves=''");
    for (const r of joined) await tx.run("UPDATE plex_catalog_fts SET shelves=? WHERE key=?", [r.names, r.key]);
  }
  async function provider(route) {
    if (quiet(now())) throw coded("quiet", "catalog maintenance window");
    const r = await mediactl("GET", route, null, { timeout: 15000 });
    if (r.status === 404 && route === "/sections") throw coded("old", "needs media-control 1.7.0");
    if (r.status !== 200 || !r.json || r.json.ok === false) throw coded("upstream", "catalog source unavailable");
    return r.json;
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
    full = !!full || !previous.full_at || new Date(previous.full_at).toISOString().slice(0, 10) !== new Date(at).toISOString().slice(0, 10) || previous.block_fingerprint !== fingerprint;
    let received = 0, dropped = 0, blocked = {}, sections = [];
    const revokedInRun = new Set();
    try {
      const source = await provider("/sections");
      sections = sectionRows(source.sections);
      const allow = source.allow_list_set === true;
      if (!dry) await write(async (tx) => { await installSections(tx, sections, allow, block); await putState(tx, "supported", true); });
      if (!allow) {
        if (!dry) await write((tx) => putState(tx, "error", "set MEDIACTL_SECTIONS"));
        return { ok: false, dry, error: "set MEDIACTL_SECTIONS", sections, received: 0, dropped: 0 };
      }
      let version = null;
      try { const h = await provider("/health"); version = /^\d+\.\d+\.\d+$/.test(h.version || "") ? h.version : null; } catch (_) {}
      const allowed = new Set(sections.filter((s) => s.policy === "allowed").map((s) => s.id));
      const seen = dry ? at : await write(async (tx) => {
        const prior = await tx.all("SELECT value FROM plex_catalog_state WHERE key='seen_generation'");
        const next = Math.max(at, number(prior[0] && parsed(prior[0].value, 0)) + 1);
        await putState(tx, "seen_generation", next);
        return next;
      });
      for (const s of sections.filter((r) => r.policy === "allowed")) {
        for (const type of s.type === "show" ? [2, 4] : [1]) {
          let start = 0;
          for (;;) {
            const route = "/catalog?section=" + encodeURIComponent(s.id) + "&type=" + type + "&start=" + start + "&size=500" + (!full && previous.at ? "&since=" + Math.max(0, Math.floor(previous.at / 1000) - 1) : "");
            const page = await provider(route), clean = [], revoked = [];
            if (!Array.isArray(page.rows)) throw coded("upstream");
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
            });
            if (page.next == null) break;
            const next = Number(page.next);
            if (!Number.isInteger(next) || next <= start || next > 10000000) throw coded("upstream");
            start = next;
          }
        }
        const collections = await provider("/collections?section=" + encodeURIComponent(s.id));
        if (!Array.isArray(collections.collections)) throw coded("upstream");
        if (!dry) await write((tx) => storeShelves(tx, s.id, collections.collections));
      }
      if (!dry) {
        await counts(sections, false);
        await write(async (tx) => {
          if (full) {
            if (fts) await tx.run("DELETE FROM plex_catalog_fts WHERE key IN (SELECT key FROM plex_catalog WHERE seen_at<>?)", [seen]);
            await tx.run("DELETE FROM plex_catalog WHERE seen_at<>?", [seen]);
            await purgeOrphans(tx);
            await putState(tx, "full_at", at);
          }
          await rebuildShelfFts(tx);
          for (const [key, value] of Object.entries({ at, version, block_fingerprint: fingerprint, blocked, dropped, error: null, v: (previous.v || 0) + 1 })) await putState(tx, key, value);
        });
      }
      log.log("[plexcatalog] " + (dry ? "dry " : "") + (full ? "full" : "delta") + " received=" + received + " dropped=" + dropped + " blocked=" + Object.values(blocked).reduce((a, b) => a + b, 0));
      return { ok: true, dry, full, received, dropped, blocked, sections, version };
    } catch (e) {
      const error = e.code === "old" ? "needs media-control 1.7.0" : e.code === "quiet" ? "maintenance window" : "catalog source unavailable";
      if (!dry) await write(async (tx) => { await putState(tx, "error", error); if (e.code === "old") await putState(tx, "supported", false); }).catch(() => {});
      log.log("[plexcatalog] sync failed: " + error);
      return { ok: false, dry, error, received, dropped };
    }
  }
  function sync(opts = {}) {
    if (syncing) return syncing;
    syncing = doSync(opts).catch(() => ({ ok: false, dry: !!opts.dry, error: "catalog unavailable" })).finally(() => { syncing = null; });
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
      for (const [k, v] of Object.entries({ at: Math.min(stamp, number(snapshot.at, stamp)), full_at: Math.min(stamp, number(snapshot.full_at, stamp)), supported: true, allow_list_set: true, version: "snapshot", v: stamp,
        block_fingerprint: [...block].sort().join(","), blocked, dropped, error: null })) await putState(tx, k, v);
    });
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
  function start() {
    if (timer || closed || options.readOnly) return;
    const tick = async () => {
      try { await require("./mediaconf").init(); } catch (_) { /* injected test/tool settings */ }
      if (!closed && !quiet(now())) await sync();
      if (!closed) { timer = setTimeout(tick, Math.max(10, Math.min(1440, number(settings().catalog_sync_min, 60))) * 60000); if (timer.unref) timer.unref(); }
    };
    timer = setTimeout(tick, 0);
    if (timer.unref) timer.unref();
  }
  async function close() {
    closed = true;
    clearTimeout(timer); timer = null;
    for (const q of queue.splice(0)) q.reject(coded("unavailable"));
    await tail;
    if (syncing) await syncing.catch(() => {});
    while (running) await new Promise((resolve) => setImmediate(resolve));
    await Promise.all([closeDb(writer), closeDb(searchDb)]);
    writer = searchDb = null;
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
    app.get("/api/media/admin/catalog", ...route(async () => ({ ok: true, ...(await status()) })));
    app.post("/api/media/admin/catalog/sync", ...route(async () => {
      if (quiet(now())) return { ok: true, started: false, skipped: "maintenance" };
      const started = !syncing;
      sync({ full: true }).catch(() => {});
      return { ok: true, started, syncing: true };
    }));
    app.post("/api/media/admin/catalog/dry", ...route(() => dryCount()));
    if (!noTimers) start();
  }
  return { init, sync, dryCount, status, shelves, rows, getByKeys, search, read, write, importSnapshot, exportSnapshot, start, close, register, file };
}

let singleton;
const current = () => {
  if (!singleton) {
    singleton = createCatalog();
    try { require("./shutdown").onExit((done) => singleton.close().then(done, done)); } catch (_) { /* standalone tool */ }
  }
  return singleton;
};
module.exports = { createCatalog, crow, fold, ratings, quiet, SEARCH_BUDGET_MS, SEARCH_QUEUE };
for (const name of ["init", "sync", "dryCount", "status", "shelves", "rows", "getByKeys", "search", "read", "write", "importSnapshot", "exportSnapshot", "start", "close", "register"]) module.exports[name] = (...args) => current()[name](...args);
