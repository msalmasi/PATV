// Text-only, rebuildable int8 vectors on plexcatalog's own serialized writer.
// No provider, media-file access, new native extension, timer or model-name constant.
"use strict";
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");

const KEY = /^\d{1,12}$/, HASH = /^[a-f0-9]{64}$/;
const DAY = 86400000, BUDGET = 400, MAX_MOVIES = 20000, MAX_EPISODES = 3000, MAX_BODY = 16384;
const clean = (v, max = 1200) => typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
const error = (code) => Object.assign(new Error(code), { code });
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
  let initialized = null, policyStamp = null, movieCache = null, episodeCache = null;
  const on = () => settings().clerk_embed === true || settings().clerk_embed === "true" || settings().clerk_embed === "1" || settings().clerk_embed === 1;
  const invalidate = () => { movieCache = null; episodeCache = null; };
  const remaining = (deadline) => { const ms = deadline - clock(); if (ms <= 0) throw error("slow"); return Math.max(1, Math.min(BUDGET, ms)); };
  const read = (sql, args, deadline) => catalog.read(sql, args || [], { budgetMs: remaining(deadline) });

  function visible(args) {
    const list = blocked(settings());
    const notBlocked = (name) => {
      if (!list.length) return "1";
      args.push(...list);
      return "upper(trim(COALESCE(" + name + ".content_rating,''))) NOT IN (" + list.map(() => "?").join(",") + ")";
    };
    return "s.policy='allowed' AND " + notBlocked("c") + " AND (c.type<>'episode' OR EXISTS " +
      "(SELECT 1 FROM plex_catalog p JOIN plex_sections ps ON ps.id=p.section WHERE p.key=c.show_key AND p.type='show' " +
      "AND p.section=c.section AND ps.policy='allowed' AND " + notBlocked("p") + "))";
  }

  async function init() {
    if (!initialized) initialized = catalog.write(async (tx) => {
      await tx.run("CREATE TABLE IF NOT EXISTS plex_vectors (key TEXT PRIMARY KEY,model TEXT NOT NULL,dim INTEGER NOT NULL,hash TEXT NOT NULL,scale REAL NOT NULL,v BLOB NOT NULL,kind TEXT NOT NULL,show_key TEXT,FOREIGN KEY(key) REFERENCES plex_catalog(key) ON DELETE CASCADE)");
      await tx.run("CREATE INDEX IF NOT EXISTS plex_vectors_kind ON plex_vectors(kind)");
      await tx.run("CREATE INDEX IF NOT EXISTS plex_vectors_show ON plex_vectors(show_key)");
      // Dirty hashes make metadata changes immediately unusable without hashing 200k summaries per request.
      await tx.run("CREATE TABLE IF NOT EXISTS plex_vector_docs (key TEXT PRIMARY KEY,hash TEXT,dirty INTEGER NOT NULL DEFAULT 1,FOREIGN KEY(key) REFERENCES plex_catalog(key) ON DELETE CASCADE)");
      await tx.run("CREATE INDEX IF NOT EXISTS plex_vector_docs_dirty ON plex_vector_docs(dirty,key)");
      await tx.run("CREATE TABLE IF NOT EXISTS plex_vector_meta (id INTEGER PRIMARY KEY CHECK(id=1),model TEXT NOT NULL DEFAULT '',dim INTEGER NOT NULL DEFAULT 0,catalog_rev INTEGER NOT NULL DEFAULT 0,vector_rev INTEGER NOT NULL DEFAULT 0,policy_rev INTEGER NOT NULL DEFAULT 0)");
      await tx.run("INSERT OR IGNORE INTO plex_vector_meta(id) VALUES(1)");
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
    }).catch((e) => { initialized = null; throw e; });
    return initialized;
  }

  async function meta(deadline) {
    const rows = await read(`SELECT m.*,
      (SELECT value FROM plex_catalog_state WHERE key='allow_list_set') AS allow_list_set,
      (SELECT value FROM plex_catalog_state WHERE key='full_at') AS full_at,
      (SELECT value FROM plex_catalog_state WHERE key='supported') AS supported FROM plex_vector_meta m WHERE id=1`, [], deadline);
    const m = rows[0];
    if (!m) throw error("catalog_down");
    m.ready = parse(m.allow_list_set) === true && parse(m.supported) === true && Number(parse(m.full_at)) > 0 && now() - Number(parse(m.full_at)) <= 3 * DAY;
    return m;
  }
  async function guard(deadline) {
    await init();
    let m = await meta(deadline);
    const stamp = m.policy_rev + ":" + blocked(settings()).join(",");
    if (policyStamp !== stamp) {
      await catalog.write(async (tx) => {
        const args = [], where = visible(args);
        await tx.run("DELETE FROM plex_vectors WHERE key NOT IN (SELECT c.key FROM plex_catalog c JOIN plex_sections s ON s.id=c.section WHERE " + where + ")", args);
      });
      policyStamp = stamp;
      invalidate();
      m = await meta(deadline);
    }
    return m;
  }
  const stamp = (m) => [m.model, m.dim, m.catalog_rev, m.vector_rev, m.policy_rev, blocked(settings()).join(",")].join("|");

  async function configure(pair) {
    if (!on()) return { ok: false, code: "embed_off" };
    const selected = modelPair(pair);
    if (!selected) throw error("bad_embed_model");
    await init();
    await catalog.write(async (tx) => {
      await tx.run("UPDATE plex_vector_meta SET model=?,dim=?,vector_rev=vector_rev+1 WHERE id=1 AND (model<>? OR dim<>?)",
        [selected.model, selected.dim, selected.model, selected.dim]);
    });
    invalidate();
    return { ok: true, ...selected };
  }

  async function prepare(limit, deadline) {
    const args = [], where = visible(args);
    args.push(limit);
    const pending = await read("SELECT c.key,c.data FROM plex_vector_docs d JOIN plex_catalog c ON c.key=d.key JOIN plex_sections s ON s.id=c.section WHERE d.dirty=1 AND " + where + " ORDER BY c.key LIMIT ?", args, deadline);
    if (!pending.length) return;
    const changed = pending.map((r) => ({ ...r, hash: textHash(documentText(parse(r.data, {}))) }));
    await catalog.write(async (tx) => {
      for (const r of changed) await tx.run("UPDATE plex_vector_docs SET hash=?,dirty=0 WHERE key=? AND EXISTS (SELECT 1 FROM plex_catalog c WHERE c.key=? AND c.data=?)", [r.hash, r.key, r.key, r.data]);
      await tx.run("UPDATE plex_vector_meta SET vector_rev=vector_rev+1 WHERE id=1");
    });
    invalidate();
  }
  async function counts(m, deadline) {
    if (!m.ready || !m.model || !m.dim) return { total: 0, done: 0, left: 0 };
    const args = [m.model, m.dim], where = visible(args);
    const r = (await read(`SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN d.dirty=0 AND d.hash=v.hash AND v.model=? AND v.dim=? THEN 1 ELSE 0 END),0) AS done
      FROM plex_catalog c JOIN plex_sections s ON s.id=c.section LEFT JOIN plex_vector_docs d ON d.key=c.key LEFT JOIN plex_vectors v ON v.key=c.key WHERE ` + where, args, deadline))[0];
    return { total: r.total, done: r.done, left: r.total - r.done };
  }
  async function status() {
    if (!on()) return { enabled: false, ready: false, model: null, dim: null, done: 0, left: 0 };
    const deadline = clock() + BUDGET, m = await guard(deadline), n = await counts(m, deadline);
    return { enabled: true, ready: m.ready && n.done > 0, model: m.model || null, dim: m.dim || null, ...n };
  }
  async function todo(request = {}) {
    if (!on()) return { ok: false, code: "embed_off" };
    if (request.model != null || request.dim != null) await configure(request);
    const deadline = clock() + BUDGET;
    let m = await guard(deadline);
    if (!m.ready) return { ok: false, code: "catalog_down" };
    if (!m.model || !m.dim) return { ok: false, code: "embed_model" };
    const limit = Number.isInteger(request.limit) ? Math.max(1, Math.min(64, request.limit)) : 32;
    if (request.after != null && !KEY.test(String(request.after))) throw error("bad_cursor");
    await prepare(256, deadline);
    m = await meta(deadline);
    const version = stamp(m);
    const args = [], where = visible(args);
    args.push(m.model, m.dim);
    const after = request.after == null ? "" : " AND c.key>?";
    if (after) args.push(String(request.after));
    args.push(limit);
    const pending = await read(`SELECT c.key,d.hash FROM plex_vector_docs d JOIN plex_catalog c ON c.key=d.key JOIN plex_sections s ON s.id=c.section
      LEFT JOIN plex_vectors v ON v.key=c.key WHERE d.dirty=0 AND ` + where + " AND (v.key IS NULL OR v.hash<>d.hash OR v.model<>? OR v.dim<>?)" + after + " ORDER BY c.key LIMIT ?", args, deadline);
    // A fresh catalog read is the output boundary; a policy change during prepare cannot expose text.
    const safe = new Map((await catalog.getByKeys(pending.map((r) => r.key))).map((r) => [r.key, r]));
    const rows = pending.map((r) => { const item = safe.get(r.key); if (!item) return null;
      const text = documentText(item); return textHash(text) === r.hash ? { key: r.key, text, hash: r.hash } : null; }).filter(Boolean);
    const n = await counts(m, deadline);
    const current = await meta(deadline);
    if (!on()) return { ok: false, code: "embed_off" };
    if (!current.ready || stamp(current) !== version) return { ok: false, code: "catalog_down" };
    return { ok: true, rows, model: m.model, dim: m.dim, ...n, next: rows.length ? rows[rows.length - 1].key : null };
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
    const m = await guard(clock() + BUDGET);
    if (!m.ready) return { ok: false, code: "catalog_down" };
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
    return answer;
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
    let rows = await read(sql + " LIMIT ?", args, deadline), partial = rows.length > cap;
    if (partial) {
      // Very large movie libraries still allow an explicitly filtered <=20k pool; no arbitrary truncation.
      rows = []; args.pop();
      for (let start = 0; start < keys.length; start += 400) {
        const chunk = keys.slice(start, start + 400);
        rows.push(...await read(sql + " AND v.key IN (" + chunk.map(() => "?").join(",") + ")", [...args, ...chunk], deadline));
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
      const currentRows = await read("SELECT c.key,c.data FROM plex_catalog c JOIN plex_sections s ON s.id=c.section WHERE " + where +
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
  return { init, configure, todo, put, status, nearest, invalidate };
}

let singleton;
const current = () => singleton || (singleton = createVectors());
module.exports = { createVectors, documentText, textHash, decodeVector, quantize, BUDGET, MAX_MOVIES, MAX_EPISODES, MAX_BODY };
for (const name of ["init", "configure", "todo", "put", "status", "nearest", "invalidate"]) module.exports[name] = (...args) => current()[name](...args);
