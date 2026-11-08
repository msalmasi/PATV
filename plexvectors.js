// Text-only, rebuildable int8 vectors on plexcatalog's own serialized writer.
// No provider, media-file access, new native extension, timer or model-name constant.
"use strict";
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");

const KEY = /^\d{1,12}$/, HASH = /^[a-f0-9]{64}$/;
const DAY = 86400000, BUDGET = 400, MAX_MOVIES = 20000, MAX_EPISODES = 3000, MAX_BODY = 16384;
// plexvectors 1.99amg (prod 2026-11-08: every embed_todo refused "catalog_down", /admin/media "waiting for the bot's model
// configuration"; 255,835 rows, every doc dirty, 0 vectors, the bot's model already stored). prepare() read every dirty doc
// joined with the catalog and sorted it (565-713 ms) and the card's count walked the whole catalog (1.2-1.4 s) - both on the
// 400 ms chat search budget, so every call stopped (too_broad). The backfill (embed_todo / embed_put) and the card are
// background work now: the catalog's admin lane (its own bound; a waiting chat read goes first) and short reads that never
// walk the catalog - an index range from the bot's cursor, a page at a time:
const BG_BUDGET_MS = 6000;          // one embed_todo / embed_put / card status, end to end (the bot's HTTP call waits 10 s)
const PREPARE_BATCH = 256;          // summaries hashed a round (the bot embeds 32 a call)
const PREPARE_ROUNDS = 4;           // rounds a call may hash while nothing it hashed needs a vector (a sweep that changed only plays)
const PAGE = 4096;                  // pending docs looked at per read (plex_vector_docs_todo)
const CENSUS_PAGE = 2048;           // catalog rows per count read (~25 ms on prod's 255k rows; the whole count ~2 s, page by page)
const CENSUS_BUDGET_MS = 60000;     // one whole count
const CENSUS_MIN_MS = 5 * 60000;    // the visible-title total is counted again at most every 5 minutes (a sync changes it page by page)
const QUICK_REFRESH_MS = 60000;     // the clerk's quick look starts a background recount when its numbers are older than this
const PURGE_PAGE = 2048;            // stored vectors re-checked per write after a policy change
const BUSY = new Set(["too_broad", "busy", "slow", "SQLITE_BUSY", "SQLITE_LOCKED", "policy_changed"]);
const INPUT = new Set(["bad_embed_model", "bad_cursor", "bad_vectors", "bad_vector"]);
const clean = (v, max = 1200) => typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
const error = (code, message = code) => Object.assign(new Error(message), { code });
const parse = (v, fallback = null) => { try { return JSON.parse(v); } catch (_) { return fallback; } };
const blocked = (settings) => String(settings.clerk_block_ratings == null ? "X,XXX,AO,R18,R18+" : settings.clerk_block_ratings)
  .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).sort();
const modelPair = (value) => value && typeof value.model === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,159}$/.test(value.model)
  && Number.isInteger(value.dim) && value.dim >= 1 && value.dim <= 4096 ? { model: value.model, dim: value.dim } : null;

function documentText(row) {
  // Explicit fields only. Never JSON.stringify(row): provider extensions may include file paths.
  return [clean(row.title, 200), row.type === "episode" ? clean(row.show, 200) : "",
    Number.isInteger(row.year) ? String(row.year) : "",
    Array.isArray(row.genres) ? row.genres.filter((g) => typeof g === "string").slice(0, 20).map((g) => clean(g, 80)).join(", ") : "",
    clean(row.summary, 1000)].filter(Boolean).join("\n").slice(0, 1200);
}
const textHash = (text) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
function decodeVector(value, dim) {
  if (!value || typeof value.v !== "string" || !Number.isFinite(value.scale) || value.scale <= 0 || value.scale > 1e6
      || !Number.isInteger(dim) || dim < 1 || dim > 4096 || value.v.length > Math.ceil(dim / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.v)) return null;
  const bytes = Buffer.from(value.v, "base64");
  if (bytes.length !== dim || bytes.toString("base64") !== value.v) return null;
  const vector = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let sum = 0;
  for (let i = 0; i < dim; i++) sum += vector[i] * vector[i];
  return sum ? { bytes, vector, norm: Math.sqrt(sum), scale: value.scale } : null;
}
function quantize(input) {
  if (!Array.isArray(input) && !ArrayBuffer.isView(input)) throw error("bad_vector");
  if (!input.length || input.length > 4096) throw error("bad_vector");
  let max = 0;
  for (const value of input) { if (!Number.isFinite(value)) throw error("bad_vector"); max = Math.max(max, Math.abs(value)); }
  if (!max) throw error("bad_vector");
  const scale = max / 127, bytes = new Int8Array(input.length);
  for (let i = 0; i < input.length; i++) bytes[i] = Math.max(-127, Math.min(127, Math.round(input[i] / scale)));
  return { v: Buffer.from(bytes.buffer).toString("base64"), scale };
}

function createVectors(options = {}) {
  const catalog = options.catalog || require("./plexcatalog");
  const settings = options.settings || (() => require("./mediaconf").get());
  const now = options.now || Date.now, clock = options.clock || (() => performance.now());
  const log = options.log || console;
  let initialized = null, policyStamp = null, movieCache = null, episodeCache = null;
  let purgeJob = null, census = null, censusJob = null, lastCounts = null, kicked = null;
  const on = () => settings().clerk_embed === true || settings().clerk_embed === "true" || settings().clerk_embed === "1" || settings().clerk_embed === 1;
  const invalidate = () => { movieCache = null; episodeCache = null; };
  const remaining = (deadline) => { const ms = deadline - clock(); if (ms <= 0) throw error("slow"); return Math.max(1, Math.min(BUDGET, ms)); };
  // Two lanes. chat: nearest() and the clerk's quick look, on the 400 ms search budget. bg: the backfill and the card, on the
  // catalog's admin lane (plexcatalog ADMIN_BUDGET_MS a read, behind any waiting chat read); a read that fails says which step.
  const chat = (sql, args, deadline) => catalog.read(sql, args || [], { budgetMs: remaining(deadline) });
  const adminRead = catalog.admin && typeof catalog.admin.read === "function" ? (sql, args) => catalog.admin.read(sql, args || []) : (sql, args) => catalog.read(sql, args || []);
  const adminRows = (keys) => catalog.admin && typeof catalog.admin.getByKeys === "function" ? catalog.admin.getByKeys(keys) : catalog.getByKeys(keys);
  const due = (deadline) => { if (deadline - clock() <= 0) throw error("slow"); };
  const step = (name, e) => { if (e && typeof e === "object" && !e.step) try { e.step = name; } catch (_) { /* a frozen error */ } return e; };
  async function bg(name, sql, args, deadline) {
    due(deadline);
    try { return await adminRead(sql, args); } catch (e) { throw step(name, e); }
  }
  const bgLane = (name) => (sql, args, deadline) => bg(name, sql, args, deadline);

  // A refusal: busy (a read past its bound, a full read queue, a locked file, the policy moving under the call - ask again) or
  // down (anything else, the catalog not ready). The real reason goes to the server log once a streak per place - its code, message
  // and step, never a title (catalog errors carry none) - and the caller is told it was logged (plexchat adds no line of its own).
  const told = new Map();
  function refused(where, e) {
    const code = e && BUSY.has(e.code) ? "embed_busy" : "catalog_down";
    const what = e && e.code === "not_ready" ? clean(String(e.message), 200)
      : clean(String((e && e.code) || "error"), 60) + (e && e.message && e.message !== e.code ? " - " + clean(String(e.message), 200) : "");
    const line = "[plexvectors] " + where + " refused (" + code + "): " + what + (e && e.step ? " [" + clean(String(e.step), 40) + "]" : "");
    if (told.get(where) !== line) { told.set(where, line); try { (log.error || log.log).call(log, line); } catch (_) { /* never fails a call */ } }
    return { ok: false, code, logged: true };
  }
  const fine = (where) => { told.delete(where); };
  function notReady(m) {
    const state = parse(m.full_at);
    const why = parse(m.allow_list_set) !== true ? "the allow-list isn't set" : parse(m.supported) !== true ? "media-control is too old"
      : !(Number(state) > 0) ? "no full sync yet" : "the last full sync was " + Math.round((now() - Number(state)) / 3600000) + " h ago";
    return error("not_ready", "catalog not ready (" + why + ")");
  }

  function visible(args, c = "c") {
    const list = blocked(settings());
    const notBlocked = (name) => {
      if (!list.length) return "1";
      args.push(...list);
      return "upper(trim(COALESCE(" + name + ".content_rating,''))) NOT IN (" + list.map(() => "?").join(",") + ")";
    };
    return "s.policy='allowed' AND " + notBlocked(c) + " AND (" + c + ".type<>'episode' OR EXISTS " +
      "(SELECT 1 FROM plex_catalog p JOIN plex_sections ps ON ps.id=p.section WHERE p.key=" + c + ".show_key AND p.type='show' " +
      "AND p.section=" + c + ".section AND ps.policy='allowed' AND " + notBlocked("p") + "))";
  }

  async function init() {
    if (!initialized) initialized = catalog.write(async (tx) => {
      await tx.run("CREATE TABLE IF NOT EXISTS plex_vectors (key TEXT PRIMARY KEY,model TEXT NOT NULL,dim INTEGER NOT NULL,hash TEXT NOT NULL,scale REAL NOT NULL,v BLOB NOT NULL,kind TEXT NOT NULL,show_key TEXT,FOREIGN KEY(key) REFERENCES plex_catalog(key) ON DELETE CASCADE)");
      await tx.run("CREATE INDEX IF NOT EXISTS plex_vectors_kind ON plex_vectors(kind)");
      await tx.run("CREATE INDEX IF NOT EXISTS plex_vectors_show ON plex_vectors(show_key)");
      // Dirty hashes make metadata changes immediately unusable without hashing 200k summaries per request.
      await tx.run("CREATE TABLE IF NOT EXISTS plex_vector_docs (key TEXT PRIMARY KEY,hash TEXT,dirty INTEGER NOT NULL DEFAULT 1,vec INTEGER NOT NULL DEFAULT 0,FOREIGN KEY(key) REFERENCES plex_catalog(key) ON DELETE CASCADE)");
      await tx.run("CREATE INDEX IF NOT EXISTS plex_vector_docs_dirty ON plex_vector_docs(dirty,key)");
      await tx.run("CREATE TABLE IF NOT EXISTS plex_vector_meta (id INTEGER PRIMARY KEY CHECK(id=1),model TEXT NOT NULL DEFAULT '',dim INTEGER NOT NULL DEFAULT 0,catalog_rev INTEGER NOT NULL DEFAULT 0,vector_rev INTEGER NOT NULL DEFAULT 0,policy_rev INTEGER NOT NULL DEFAULT 0)");
      await tx.run("INSERT OR IGNORE INTO plex_vector_meta(id) VALUES(1)");
      // plexvectors 1.99amg: docs.vec = 1 when the doc's stored vector matches its current hash and the configured model, kept by the
      // triggers below (the only writers). The work left is then an index range - (dirty=0, vec=0) after the cursor - never a scan
      // past every finished doc, and "done" an index count. A cache from before the column gets it (and its value) once here.
      if (!(await tx.all("PRAGMA table_info(plex_vector_docs)")).some((col) => col.name === "vec")) {
        await tx.run("ALTER TABLE plex_vector_docs ADD COLUMN vec INTEGER NOT NULL DEFAULT 0");
        await tx.run("UPDATE plex_vector_docs SET vec=1 WHERE key IN (SELECT v.key FROM plex_vectors v CROSS JOIN plex_vector_meta m CROSS JOIN plex_vector_docs d ON d.key=v.key " +
          "WHERE m.id=1 AND v.model=m.model AND v.dim=m.dim AND v.hash IS d.hash)");
      }
      await tx.run("CREATE INDEX IF NOT EXISTS plex_vector_docs_todo ON plex_vector_docs(dirty,vec,key)");
      await tx.run("INSERT OR IGNORE INTO plex_vector_docs(key) SELECT key FROM plex_catalog");
      await tx.run(`CREATE TRIGGER IF NOT EXISTS plex_vectors_catalog_insert AFTER INSERT ON plex_catalog BEGIN
        INSERT OR IGNORE INTO plex_vector_docs(key) VALUES(NEW.key);
        UPDATE plex_vector_meta SET catalog_rev=catalog_rev+1 WHERE id=1; END`);
      await tx.run(`CREATE TRIGGER IF NOT EXISTS plex_vectors_catalog_update AFTER UPDATE OF data ON plex_catalog WHEN OLD.data<>NEW.data BEGIN
        INSERT INTO plex_vector_docs(key,dirty) VALUES(NEW.key,1) ON CONFLICT(key) DO UPDATE SET dirty=1;
        UPDATE plex_vector_meta SET catalog_rev=catalog_rev+1 WHERE id=1; END`);
      await tx.run(`CREATE TRIGGER IF NOT EXISTS plex_vectors_catalog_policy AFTER UPDATE OF section,content_rating,type,show_key ON plex_catalog
        WHEN OLD.section<>NEW.section OR COALESCE(OLD.content_rating,'')<>COALESCE(NEW.content_rating,'') OR OLD.type<>NEW.type OR COALESCE(OLD.show_key,'')<>COALESCE(NEW.show_key,'') BEGIN
        UPDATE plex_vector_meta SET policy_rev=policy_rev+1 WHERE id=1; END`);
      await tx.run(`CREATE TRIGGER IF NOT EXISTS plex_vectors_catalog_delete AFTER DELETE ON plex_catalog BEGIN
        DELETE FROM plex_vectors WHERE key=OLD.key; DELETE FROM plex_vector_docs WHERE key=OLD.key;
        UPDATE plex_vector_meta SET catalog_rev=catalog_rev+1,policy_rev=policy_rev+1 WHERE id=1; END`);
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        await tx.run(`CREATE TRIGGER IF NOT EXISTS plex_vectors_section_${operation.toLowerCase()} AFTER ${operation} ON plex_sections BEGIN
          UPDATE plex_vector_meta SET policy_rev=policy_rev+1 WHERE id=1; END`);
        await tx.run(`CREATE TRIGGER IF NOT EXISTS plex_vectors_change_${operation.toLowerCase()} AFTER ${operation} ON plex_vectors BEGIN
          UPDATE plex_vector_meta SET vector_rev=vector_rev+1 WHERE id=1; END`);
      }
      const matches = (row) => `CASE WHEN EXISTS (SELECT 1 FROM plex_vectors v CROSS JOIN plex_vector_meta m WHERE m.id=1 AND v.key=${row}.key
        AND v.hash IS ${row}.hash AND v.model=m.model AND v.dim=m.dim) THEN 1 ELSE 0 END`;
      for (const operation of ["INSERT", "UPDATE"]) await tx.run(`CREATE TRIGGER IF NOT EXISTS plex_vectors_vec_${operation.toLowerCase()} AFTER ${operation} ON plex_vectors BEGIN
        UPDATE plex_vector_docs SET vec=${matches("plex_vector_docs")} WHERE key=NEW.key; END`);
      await tx.run(`CREATE TRIGGER IF NOT EXISTS plex_vectors_vec_delete AFTER DELETE ON plex_vectors BEGIN
        UPDATE plex_vector_docs SET vec=0 WHERE key=OLD.key; END`);
      await tx.run(`CREATE TRIGGER IF NOT EXISTS plex_vector_docs_vec_insert AFTER INSERT ON plex_vector_docs WHEN NEW.hash IS NOT NULL BEGIN
        UPDATE plex_vector_docs SET vec=${matches("NEW")} WHERE key=NEW.key; END`);
      await tx.run(`CREATE TRIGGER IF NOT EXISTS plex_vector_docs_vec_hash AFTER UPDATE OF hash ON plex_vector_docs BEGIN
        UPDATE plex_vector_docs SET vec=${matches("NEW")} WHERE key=NEW.key; END`);
      // a model change touches only docs that were current or have a vector of the new pair - not all 255k
      await tx.run(`CREATE TRIGGER IF NOT EXISTS plex_vector_meta_vec_model AFTER UPDATE OF model,dim ON plex_vector_meta
        WHEN OLD.model IS NOT NEW.model OR OLD.dim IS NOT NEW.dim BEGIN
        UPDATE plex_vector_docs SET vec=${matches("plex_vector_docs")} WHERE vec=1 OR key IN (SELECT key FROM plex_vectors WHERE model=NEW.model AND dim=NEW.dim); END`);
    }).catch((e) => { initialized = null; throw e; });
    return initialized;
  }

  async function meta(deadline, rd = chat) {
    const rows = await rd(`SELECT m.*,
      (SELECT value FROM plex_catalog_state WHERE key='allow_list_set') AS allow_list_set,
      (SELECT value FROM plex_catalog_state WHERE key='full_at') AS full_at,
      (SELECT value FROM plex_catalog_state WHERE key='supported') AS supported FROM plex_vector_meta m WHERE id=1`, [], deadline);
    const m = rows[0];
    if (!m) throw error("catalog_down");
    m.ready = parse(m.allow_list_set) === true && parse(m.supported) === true && Number(parse(m.full_at)) > 0 && now() - Number(parse(m.full_at)) <= 3 * DAY;
    return m;
  }
  // plexvectors 1.99amg: a policy change re-checks the stored vectors once, however many calls arrive together (each used to queue
  // its own whole-catalog DELETE ... NOT IN on the writer), a page of vectors per write.
  async function purge() {
    let after = "";
    for (;;) {
      const page = await catalog.write(async (tx) => {
        const args = [], where = visible(args);
        args.push(after, PURGE_PAGE);
        const rows = await tx.all("SELECT w.key AS key,CASE WHEN c.key IS NULL THEN 0 WHEN " + where + " THEN 1 ELSE 0 END AS vis FROM " +
          "(SELECT key FROM plex_vectors WHERE key>? ORDER BY key LIMIT ?) w LEFT JOIN plex_catalog c ON c.key=w.key LEFT JOIN plex_sections s ON s.id=c.section", args);
        const gone = rows.filter((r) => !r.vis).map((r) => r.key);
        for (let i = 0; i < gone.length; i += 400) {
          const part = gone.slice(i, i + 400);
          await tx.run("DELETE FROM plex_vectors WHERE key IN (" + part.map(() => "?").join(",") + ")", part);
        }
        return { n: rows.length, last: rows.reduce((max, r) => r.key > max ? r.key : max, after) };
      });
      if (page.n < PURGE_PAGE) return;
      after = page.last;
    }
  }
  async function guard(deadline, rd = chat) {
    await init();
    let m = await meta(deadline, rd);
    const want = m.policy_rev + ":" + blocked(settings()).join(",");
    if (policyStamp !== want) {
      if (!purgeJob || purgeJob.want !== want) {
        const before = purgeJob ? purgeJob.done.catch(() => {}) : Promise.resolve();
        const job = { want };
        job.done = before.then(() => purge()).then(() => { policyStamp = want; invalidate(); })
          .finally(() => { if (purgeJob === job) purgeJob = null; });
        purgeJob = job;
      }
      await purgeJob.done;
      m = await meta(deadline, rd);
    }
    return m;
  }
  const stamp = (m) => [m.model, m.dim, m.catalog_rev, m.vector_rev, m.policy_rev, blocked(settings()).join(",")].join("|");
  const policyOf = (m) => [m.ready, m.model, m.dim, m.policy_rev, blocked(settings()).join(",")].join("|");

  async function configure(pair) {
    if (!on()) return { ok: false, code: "embed_off" };
    const selected = modelPair(pair);
    if (!selected) throw error("bad_embed_model");
    await init();
    await catalog.write(async (tx) => {
      await tx.run("UPDATE plex_vector_meta SET model=?,dim=?,vector_rev=vector_rev+1 WHERE id=1 AND (model<>? OR dim<>?)",
        [selected.model, selected.dim, selected.model, selected.dim]);
    });
    if (lastCounts && lastCounts.pair !== selected.model + "|" + selected.dim) lastCounts = null;
    invalidate();
    return { ok: true, ...selected };
  }

  // plexvectors 1.99amg: the summaries changed since they were last hashed - from the bot's cursor on, then from the start (an
  // index range of plex_vector_docs_dirty: no policy join, no sort). Hashing a title the policy hides is harmless: no text leaves
  // here, and what the bot gets is read again through the catalog's own visibility check. Returns how many it hashed.
  async function prepare(after, deadline) {
    const from = after == null ? "" : String(after);
    const sql = "SELECT d.key AS key,c.data AS data FROM plex_vector_docs d INDEXED BY plex_vector_docs_dirty CROSS JOIN plex_catalog c ON c.key=d.key WHERE d.dirty=1 AND ";
    let pending = await bg("prepare", sql + "d.key>? ORDER BY d.key LIMIT ?", [from, PREPARE_BATCH], deadline);
    if (pending.length < PREPARE_BATCH && from) pending = pending.concat(await bg("prepare", sql + "d.key<=? ORDER BY d.key LIMIT ?", [from, PREPARE_BATCH - pending.length], deadline));
    if (!pending.length) return 0;
    const changed = pending.map((r) => ({ ...r, hash: textHash(documentText(parse(r.data, {}))) }));
    await catalog.write(async (tx) => {
      for (const r of changed) await tx.run("UPDATE plex_vector_docs SET hash=?,dirty=0 WHERE key=? AND dirty=1 AND EXISTS (SELECT 1 FROM plex_catalog c WHERE c.key=? AND c.data=?)", [r.hash, r.key, r.key, r.data]);
      await tx.run("UPDATE plex_vector_meta SET vector_rev=vector_rev+1 WHERE id=1");
    });
    invalidate();
    return pending.length;
  }
  // The docs that need a vector (hashed, no current vector) the policy shows, in key order after the cursor, then - the bot's
  // cursor is only where it stopped - from the start up to it. A page of the plex_vector_docs_todo range per read.
  async function pendingRows(after, limit, deadline) {
    const found = [], seen = new Set();
    const passes = after == null ? [["", null]] : [[String(after), null], ["", String(after)]];
    const todoSql = "FROM plex_vector_docs d INDEXED BY plex_vector_docs_todo";
    for (const [start, upTo] of passes) {
      let from = start;
      for (;;) {
        const endArgs = upTo == null ? [from, PAGE - 1] : [from, upTo, PAGE - 1];
        const end = (await bg("pending", "SELECT d.key AS key " + todoSql + " WHERE d.dirty=0 AND d.vec=0 AND d.key>?" + (upTo == null ? "" : " AND d.key<=?") +
          " ORDER BY d.key LIMIT 1 OFFSET ?", endArgs, deadline))[0];
        const last = end ? end.key : upTo;
        const args = [from];
        if (last != null) args.push(last);
        const where = visible(args);
        args.push(limit - found.length);
        const rows = await bg("pending", "SELECT d.key AS key,d.hash AS hash " + todoSql + " CROSS JOIN plex_catalog c INDEXED BY plex_catalog_visibility ON c.key=d.key " +
          "CROSS JOIN plex_sections s ON s.id=c.section WHERE d.dirty=0 AND d.vec=0 AND d.key>?" + (last == null ? "" : " AND d.key<=?") + " AND " + where +
          " ORDER BY d.key LIMIT ?", args, deadline);
        for (const r of rows) if (!seen.has(r.key)) { seen.add(r.key); found.push(r); }
        if (found.length >= limit) return { rows: found.slice(0, limit), end: false };
        if (!end) break;
        from = end.key;
      }
    }
    return { rows: found, end: true };
  }

  // How many visible titles there are (the card's total): a page of the catalog's covering visibility index per read, kept until
  // the catalog or its policy changes (and then counted again at most every CENSUS_MIN_MS); one count at a time.
  async function runCensus(key) {
    const deadline = clock() + CENSUS_BUDGET_MS;
    let after = "", total = 0;
    for (;;) {
      const args = [], where = visible(args, "win");
      args.push(after, CENSUS_PAGE);
      const r = (await bg("count", "SELECT COUNT(*) AS n,MAX(win.key) AS last,COALESCE(SUM(CASE WHEN " + where + " THEN 1 ELSE 0 END),0) AS visible " +
        "FROM (SELECT key,section,content_rating,type,show_key FROM plex_catalog INDEXED BY plex_catalog_visibility WHERE key>? ORDER BY key LIMIT ?) win " +
        "LEFT JOIN plex_sections s ON s.id=win.section", args, deadline))[0];
      total += Number(r.visible) || 0;
      if (!r.n || r.n < CENSUS_PAGE) break;
      after = r.last;
    }
    census = { key, at: now(), total };
    return total;
  }
  async function catalogTotal(m) {
    const key = [m.catalog_rev, m.policy_rev, blocked(settings()).join(",")].join("|");
    if (census && (census.key === key || now() - census.at < CENSUS_MIN_MS)) return census.total;
    if (!censusJob) {
      const job = censusJob = runCensus(key);
      job.then(() => {}, () => {}).then(() => { if (censusJob === job) censusJob = null; });
    }
    try { return await censusJob; }
    catch (e) { if (census) { refused("count", e); return census.total; } throw e; }
  }
  async function counts(m, deadline) {
    if (!m.ready || !m.model || !m.dim) return { total: 0, done: 0, left: 0 };
    const total = await catalogTotal(m);
    // stored vectors are of visible titles only (put checks, a policy change purges), so "done" needs no policy join
    const done = Number((await bg("count", "SELECT COUNT(*) AS n FROM plex_vector_docs INDEXED BY plex_vector_docs_todo WHERE dirty=0 AND vec=1", [], deadline))[0].n) || 0;
    const n = { total, done, left: Math.max(0, total - done) };
    lastCounts = { pair: m.model + "|" + m.dim, at: now(), ...n };
    return n;
  }
  // A recount the clerk's quick look asked for, in the background (no timer: a promise; one at a time).
  function kick() {
    if (kicked) return;
    kicked = (async () => {
      const deadline = clock() + BG_BUDGET_MS;
      await counts(await guard(deadline, bgLane("count")), deadline);
      fine("count");
    })().catch((e) => { refused("count", e); }).finally(() => { kicked = null; });
  }
  async function idle() {
    for (let i = 0; i < 20 && (kicked || censusJob || purgeJob); i++)
      await Promise.all([kicked, censusJob, purgeJob && purgeJob.done].filter(Boolean).map((p) => p.catch(() => {})));
  }

  async function status(opts = {}) {
    if (!on()) return { enabled: false, ready: false, model: null, dim: null, done: 0, left: 0 };
    if (opts && opts.quick) return quickStatus();
    let m = null;
    try {
      const deadline = clock() + BG_BUDGET_MS;
      m = await guard(deadline, bgLane("status"));
      const n = await counts(m, deadline);
      fine("status");
      return { enabled: true, ready: m.ready && n.done > 0, model: m.model || null, dim: m.dim || null, ...n, counted: true };
    } catch (e) {
      refused("status", e);
      if (!m) throw e;
      // the model is known; the numbers couldn't be read just now - the last ones for this model, or none (never made up)
      const last = lastCounts && lastCounts.pair === m.model + "|" + m.dim ? lastCounts : null;
      return { enabled: true, ready: !!(m.ready && last && last.done > 0), model: m.model || null, dim: m.dim || null,
        ...(last ? { total: last.total, done: last.done, left: last.left, counted: true } : { done: 0, left: null, counted: false }) };
    }
  }
  // opShelves (a person's ask): the stored model and the last numbers, no count on the chat path; a stale or missing count is
  // started in the background for the next look.
  async function quickStatus() {
    const deadline = clock() + BUDGET;
    await init();
    const m = await meta(deadline);
    const base = { enabled: true, model: m.model || null, dim: m.dim || null };
    if (!m.ready || !m.model || !m.dim) return { ...base, ready: false, done: 0, left: 0, counted: true };
    if (lastCounts && lastCounts.pair === m.model + "|" + m.dim) {
      if (now() - lastCounts.at >= QUICK_REFRESH_MS) kick();
      return { ...base, ready: lastCounts.done > 0, total: lastCounts.total, done: lastCounts.done, left: lastCounts.left, counted: true };
    }
    const any = (await chat("SELECT 1 AS x FROM plex_vector_docs INDEXED BY plex_vector_docs_todo WHERE dirty=0 AND vec=1 LIMIT 1", [], deadline)).length > 0;
    kick();
    return { ...base, ready: any, done: 0, left: null, counted: false };
  }

  async function todo(request = {}) {
    if (!on()) return { ok: false, code: "embed_off" };
    const pair = request.model != null || request.dim != null ? modelPair(request) : null;
    if ((request.model != null || request.dim != null) && !pair) throw error("bad_embed_model");
    const limit = Number.isInteger(request.limit) ? Math.max(1, Math.min(64, request.limit)) : 32;
    if (request.after != null && !KEY.test(String(request.after))) throw error("bad_cursor");
    const after = request.after == null ? null : String(request.after);
    try {
      if (pair) await configure(pair);
      const deadline = clock() + BG_BUDGET_MS, rd = bgLane("todo");
      let m = await guard(deadline, rd);
      if (!m.ready) return refused("todo", notReady(m));
      if (!m.model || !m.dim) return { ok: false, code: "embed_model" };
      const policy = policyOf(m);
      let pending = { rows: [], end: true };
      for (let round = 0; round < PREPARE_ROUNDS; round++) {
        const hashed = await prepare(after, deadline);
        pending = await pendingRows(after, limit, deadline);
        if (pending.rows.length || hashed < PREPARE_BATCH) break;
      }
      // A fresh catalog read is the output boundary; a policy change during prepare cannot expose text.
      const safe = new Map((await adminRows(pending.rows.map((r) => r.key))).map((r) => [r.key, r]));
      const rows = pending.rows.map((r) => { const item = safe.get(r.key); if (!item) return null;
        const text = documentText(item); return textHash(text) === r.hash ? { key: r.key, text, hash: r.hash } : null; }).filter(Boolean);
      m = await meta(deadline, rd);
      let n = await counts(m, deadline);
      if (!rows.length) {
        // nothing to embed: finished (left 0, the bot stops) only when no doc anywhere needs a vector and none is still to hash -
        // then every visible title is done, and a total that says otherwise is an old count (counted again on the next call)
        const dirty = (await bg("todo", "SELECT 1 AS x FROM plex_vector_docs INDEXED BY plex_vector_docs_dirty WHERE dirty=1 LIMIT 1", [], deadline)).length > 0;
        if (!pending.rows.length && !dirty) {
          if (n.total !== n.done && census) census.at = -Infinity;
          n = { total: n.done, done: n.done, left: 0 };
          lastCounts = { pair: m.model + "|" + m.dim, at: now(), ...n };
        } else n = { ...n, left: Math.max(1, n.left) };
      }
      const current = await meta(deadline, rd);
      if (!on()) return { ok: false, code: "embed_off" };
      if (!current.ready) return refused("todo", notReady(current));
      if (policyOf(current) !== policy) return refused("todo", error("policy_changed", "the catalog's policy changed during the call"));
      fine("todo");
      return { ok: true, rows, model: m.model, dim: m.dim, ...n, next: rows.length ? rows[rows.length - 1].key : null };
    } catch (e) {
      if (e && INPUT.has(e.code)) throw e;
      return refused("todo", e);
    }
  }
  async function put(request = {}) {
    if (!on()) return { ok: false, code: "embed_off" };
    if (Buffer.byteLength(JSON.stringify(request), "utf8") > MAX_BODY || !modelPair(request)
        || !Array.isArray(request.vecs) || !request.vecs.length || request.vecs.length > 64) throw error("bad_vectors");
    const input = request.vecs.map((row) => {
      if (!row || !KEY.test(String(row.key)) || !HASH.test(row.hash || "")) throw error("bad_vectors");
      const decoded = decodeVector(row, request.dim);
      if (!decoded) throw error("bad_vectors");
      return { key: String(row.key), hash: row.hash, ...decoded };
    });
    if (new Set(input.map((r) => r.key)).size !== input.length) throw error("bad_vectors");
    try {
      const m = await guard(clock() + BG_BUDGET_MS, bgLane("put"));
      if (!m.ready) return refused("put", notReady(m));
      if (request.model !== m.model || request.dim !== m.dim) return { ok: false, code: "embed_model" };
      const answer = await catalog.write(async (tx) => {
        const active = (await tx.all("SELECT model,dim FROM plex_vector_meta WHERE id=1"))[0];
        if (!on() || active.model !== request.model || active.dim !== request.dim) return { ok: false, code: "embed_model" };
        let stored = 0;
        for (const row of input) {
          const args = [], where = visible(args); args.push(row.key);
          const found = (await tx.all("SELECT c.key,c.data,c.type,c.show_key FROM plex_catalog c JOIN plex_sections s ON s.id=c.section WHERE " + where + " AND c.key=?", args))[0];
          if (!found || textHash(documentText(parse(found.data, {}))) !== row.hash) continue;
          await tx.run("INSERT INTO plex_vector_docs(key,hash,dirty) VALUES(?,?,0) ON CONFLICT(key) DO UPDATE SET hash=excluded.hash,dirty=0", [row.key, row.hash]);
          await tx.run(`INSERT INTO plex_vectors(key,model,dim,hash,scale,v,kind,show_key) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
            model=excluded.model,dim=excluded.dim,hash=excluded.hash,scale=excluded.scale,v=excluded.v,kind=excluded.kind,show_key=excluded.show_key`,
          [row.key, request.model, request.dim, row.hash, row.scale, row.bytes, found.type, found.show_key]);
          stored++;
        }
        return { ok: true, stored, rejected: input.length - stored };
      });
      invalidate();
      if (answer.ok) fine("put");
      return answer;
    } catch (e) {
      return refused("put", e);
    }
  }

  async function load(kind, show, keys, m, deadline) {
    const old = kind === "movie" ? movieCache : episodeCache, version = stamp(m);
    if (old && old.version === version && old.show === show && !old.partial) return old;
    const args = [], where = visible(args);
    args.push(m.model, m.dim, kind);
    const showSql = kind === "episode" ? " AND v.show_key=?" : "";
    if (showSql) args.push(show);
    const cap = kind === "movie" ? MAX_MOVIES : MAX_EPISODES;
    args.push(cap + 1);
    const sql = `SELECT v.key,v.hash,v.scale,v.v FROM plex_vectors v INDEXED BY ${kind === "episode" ? "plex_vectors_show" : "plex_vectors_kind"} JOIN plex_vector_docs d ON d.key=v.key JOIN plex_catalog c ON c.key=v.key JOIN plex_sections s ON s.id=c.section
      WHERE d.dirty=0 AND d.hash=v.hash AND ` + where + " AND v.model=? AND v.dim=? AND v.kind=?" + showSql;
    let rows = await chat(sql + " LIMIT ?", args, deadline), partial = rows.length > cap;
    if (partial) {
      // Very large movie libraries still allow an explicitly filtered <=20k pool; no arbitrary truncation.
      rows = []; args.pop();
      for (let start = 0; start < keys.length; start += 400) {
        const chunk = keys.slice(start, start + 400);
        rows.push(...await chat(sql + " AND v.key IN (" + chunk.map(() => "?").join(",") + ")", [...args, ...chunk], deadline));
      }
    }
    const by = new Map();
    for (const row of rows) {
      if (!Buffer.isBuffer(row.v) || row.v.byteLength !== m.dim || !Number.isFinite(row.scale) || row.scale <= 0) continue;
      const vector = new Int8Array(row.v.buffer, row.v.byteOffset, row.v.byteLength);
      let sum = 0; for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
      if (sum) by.set(row.key, { key: row.key, hash: row.hash, vector, norm: Math.sqrt(sum) });
    }
    const cache = { version, show, by, partial };
    if (kind === "movie") movieCache = cache; else episodeCache = cache;
    return cache;
  }
  async function nearest(request = {}) {
    if (!on()) return [];
    const kind = request.kind, show = request.show_key == null ? null : String(request.show_key);
    if (!["movie", "episode"].includes(kind) || kind === "episode" && !KEY.test(show || "")
        || !Array.isArray(request.keys) || !request.keys.length || request.keys.length > (kind === "movie" ? MAX_MOVIES : MAX_EPISODES)
        || request.keys.some((key) => !KEY.test(String(key)))) return [];
    const q = request.qvec, selected = modelPair(q), decoded = selected && decodeVector(q, q.dim);
    if (!decoded) return [];
    const keys = [...new Set(request.keys.map(String))];
    const budget = Math.max(1, Math.min(BUDGET, Number(request.budgetMs) || BUDGET)), deadline = clock() + budget;
    const work = async () => { try {
      const m = await guard(deadline);
      if (!m.ready || q.model !== m.model || q.dim !== m.dim) return [];
      const version = stamp(m); // capture current settings before awaits; don't recompute both sides after a change
      const cache = await load(kind, show, keys, m, deadline), top = [];
      const limit = Math.max(1, Math.min(50, Math.floor(Number(request.limit) || Number(settings().clerk_embed_k) || 30)));
      const query = decoded.vector, norm = decoded.norm, dim = m.dim;
      for (let index = 0; index < keys.length; index++) {
        if (!(index & 127)) remaining(deadline);
        const row = cache.by.get(keys[index]); if (!row) continue;
        let dot = 0; const vector = row.vector;
        for (let i = 0; i < dim; i++) dot += vector[i] * query[i];
        const score = dot / (row.norm * norm);
        if (top.length === limit && score <= top[top.length - 1].score) continue;
        let pos = top.length;
        while (pos > 0 && top[pos - 1].score < score) pos--;
        top.splice(pos, 0, { key: row.key, hash: row.hash, score, why: "vector" });
        if (top.length > limit) top.pop();
      }
      remaining(deadline);
      if (!top.length) return [];
      const args = [], where = visible(args); args.push(...top.map((r) => r.key));
      const currentRows = await chat("SELECT c.key,c.data FROM plex_catalog c JOIN plex_sections s ON s.id=c.section WHERE " + where +
        " AND c.key IN (" + top.map(() => "?").join(",") + ")", args, deadline);
      const fresh = new Map(currentRows.map((r) => [r.key, parse(r.data, {})]));
      const current = await meta(deadline);
      if (!on() || !current.ready || stamp(current) !== version) return [];
      remaining(deadline);
      return top.filter((r) => { const item = fresh.get(r.key); return item && item.type === kind
        && (kind !== "episode" || String(item.show_key) === show) && textHash(documentText(item)) === r.hash; })
        .map(({ key, score, why }) => ({ key, score, why }));
    } catch (_) { return []; } }; // busy, corrupt/stale cache or deadline -> word search, without provider text.
    // A queued writer/init cannot be interrupted safely; return on time and let it finish silently.
    // Every subsequent read/loop checks the original deadline, so no late result is ever emitted.
    let timer;
    try { return await Promise.race([work(), new Promise((resolve) => { timer = setTimeout(() => resolve([]), budget); })]); }
    finally { clearTimeout(timer); }
  }
  return { init, configure, todo, put, status, nearest, invalidate, idle };
}

let singleton;
const current = () => singleton || (singleton = createVectors());
module.exports = { createVectors, documentText, textHash, decodeVector, quantize, BUDGET, MAX_MOVIES, MAX_EPISODES, MAX_BODY, BG_BUDGET_MS, PAGE, CENSUS_PAGE };
for (const name of ["init", "configure", "todo", "put", "status", "nearest", "invalidate", "idle"]) module.exports[name] = (...args) => current()[name](...args);
