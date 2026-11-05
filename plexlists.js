// Admin-configured MDBList cache. Chat reads local, currently allowed catalog members only.
"use strict";
const https = require("https");
const DAY = 86400000, TIMEOUT = 10000, MAX_LISTS = 20, MAX_ITEMS = 20000, DAILY_CALLS = 100;
const ID = /^[1-9]\d{0,11}$/;
const txt = (v, max = 200) => typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
const fold = (v) => txt(v, 1000).toLowerCase().normalize("NFKD").replace(/([a-z])[\u0300-\u036f]+/g, "$1").normalize("NFC")
  .replace(/&/g, " and ").replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim();
const integer = (v) => v !== null && v !== "" && Number.isSafeInteger(Number(v)) ? Number(v) : null;
const quiet = (at) => { const d = new Date(at), m = d.getUTCHours() * 60 + d.getUTCMinutes(); return m >= 220 && m < 260; };
const coded = (code) => Object.assign(new Error(code), { code });
const CODES = new Set(["needs_key", "invalid_list", "ambiguous_list", "not_found", "list_limit", "invalid_query", "quiet", "rate_limited", "daily_budget", "provider_auth", "provider_unavailable", "provider_invalid", "provider_timeout", "list_too_large", "lists_unavailable", "closed"]);
const failure = (e) => ({ ok: false, code: CODES.has(e && e.code) ? e.code : "lists_unavailable" });
const parsed = (s, fallback) => { try { return JSON.parse(s); } catch (_) { return fallback; } };

// Do not redirect: the query contains a credential. No URL, body, or native error escapes this function.
function requestJSON(url, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { signal, headers: { Accept: "application/json" } }, (res) => {
      let bytes = 0, body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 2 * 1024 * 1024) { req.destroy(); reject(coded("provider_invalid")); } else body += chunk;
      });
      res.on("error", () => reject(coded("provider_unavailable")));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, json: parsed(body, null) }));
    });
    req.on("error", () => reject(coded("provider_unavailable")));
  });
}

/** Accept only a numeric id or a canonical MDBList URL; never fetch an admin-supplied URL. */
function reference(input) {
  const value = String(input == null ? "" : input).trim();
  if (ID.test(value)) return { id: value, path: "/lists/" + value };
  let u; try { u = new URL(value); } catch (_) { throw coded("invalid_list"); }
  if (u.protocol !== "https:" || !["mdblist.com", "www.mdblist.com", "api.mdblist.com"].includes(u.hostname) || u.port || u.username || u.password || u.search || u.hash) throw coded("invalid_list");
  const parts = u.pathname.replace(/\/$/, "").split("/").filter(Boolean);
  if (parts[0] !== "lists") throw coded("invalid_list");
  if (parts.length === 2 && ID.test(parts[1])) return { id: parts[1], path: "/lists/" + parts[1] };
  if (u.hostname !== "api.mdblist.com" && parts.length === 3 && parts.slice(1).every((p) => /^[A-Za-z0-9_-]{1,120}$/.test(p))) return { path: "/lists/" + parts[1] + "/" + parts[2] };
  throw coded("invalid_list");
}

function createLists(options = {}) {
  const catalog = options.catalog || require("./plexcatalog");
  const settings = options.settings || (() => require("./mediaconf").get());
  const getKey = typeof options.key === "function" ? options.key : () => options.key === undefined ? process.env.MDBLIST_API_KEY : options.key;
  const now = options.now || Date.now, request = options.request || requestJSON;
  const timeoutMs = Math.max(1, Math.min(TIMEOUT, Number(options.timeoutMs) || TIMEOUT));
  const interval = options.setInterval || setInterval, clear = options.clearInterval || clearInterval;
  let initPromise, tail = Promise.resolve(), timer = null, closed = false, tickPromise = null;
  const keyed = () => typeof getKey() === "string" && getKey().trim().length > 0;
  const enabled = () => keyed() && settings().clerk_lists === true;
  const clean = (value, max) => { const s = txt(value, max), key = getKey(); return key && (s.includes(key) || s.includes(encodeURIComponent(key))) ? "" : s; };
  const listId = (id) => { const v = String(id || "").replace(/^mdblist:/, ""); if (!ID.test(v)) throw coded("invalid_list"); return v; };
  function init() {
    if (!initPromise) initPromise = catalog.write(async (tx) => {
      await tx.run(`CREATE TABLE IF NOT EXISTS plex_lists (id TEXT PRIMARY KEY,name TEXT NOT NULL,ranked INTEGER NOT NULL DEFAULT 0,
        items INTEGER NOT NULL DEFAULT 0,entries TEXT NOT NULL DEFAULT '[]',last_read INTEGER NOT NULL DEFAULT 0,
        last_attempt INTEGER NOT NULL DEFAULT 0,last_error TEXT,retry_at INTEGER NOT NULL DEFAULT 0)`);
      await tx.run(`CREATE TABLE IF NOT EXISTS plex_list_members (list_id TEXT,item_no INTEGER,key TEXT,rank INTEGER,
        PRIMARY KEY(list_id,item_no,key),FOREIGN KEY(list_id) REFERENCES plex_lists(id) ON DELETE CASCADE,
        FOREIGN KEY(key) REFERENCES plex_catalog(key) ON DELETE CASCADE)`);
      await tx.run("CREATE INDEX IF NOT EXISTS plex_list_member_key ON plex_list_members(key,list_id)");
    }).catch((e) => { initPromise = null; throw coded("lists_unavailable"); });
    return initPromise;
  }
  function queued(fn) {
    const job = tail.then(async () => { if (closed) throw coded("closed"); if (!keyed()) throw coded("needs_key"); await init(); return fn(); });
    tail = job.catch(() => {}); return job.catch(failure);
  }
  function item(raw) {
    const r = raw || {}, type = r.type || r.mediatype;
    if (!["movie", "show"].includes(type)) return null;
    const imdb = r.imdb || r.imdb_id || (r.ids || {}).imdb;
    const tmdb = r.tmdb || (r.ids || {}).tmdb || r.id, tvdb = r.tvdb || r.tvdb_id || (r.ids || {}).tvdb;
    const year = integer(r.year == null ? r.release_year : r.year), rank = integer(r.rank);
    return { rank: rank > 0 ? rank : null, imdb: /^tt\d{1,12}$/.test(imdb || "") ? imdb : null,
      tmdb: ID.test(String(tmdb)) ? String(tmdb) : null, tvdb: ID.test(String(tvdb)) ? String(tvdb) : null,
      type, title: clean(r.title, 200), year: year >= 1800 && year <= 2200 ? year : null };
  }
  function adapter(raw) {
    if (!raw || !ID.test(String(raw.id)) || !Array.isArray(raw.items)) throw coded("provider_invalid");
    if (raw.items.length > MAX_ITEMS) throw coded("list_too_large");
    const items = raw.items.map(item), ranked = raw.ranked !== false && items.some((r) => r && r.rank != null);
    if (!ranked) for (const r of items) if (r) r.rank = null;
    return { id: String(raw.id), name: clean(raw.name, 200) || "MDBList " + raw.id, ranked, items };
  }
  async function state(tx) {
    const rows = await tx.all("SELECT value FROM plex_catalog_state WHERE key='mdblist.http'");
    return parsed(rows[0] && rows[0].value, {}) || {};
  }
  const saveState = (tx, s) => tx.run("INSERT OR REPLACE INTO plex_catalog_state(key,value) VALUES ('mdblist.http',?)", [JSON.stringify(s)]);
  async function call(path, params = {}) {
    if (closed) throw coded("closed");
    if (!keyed()) throw coded("needs_key");
    if (quiet(now())) throw coded("quiet");
    // Reserve before I/O, shared across process restarts. 100/day leaves headroom on the free 1,000/day tier.
    await catalog.write(async (tx) => {
      const s = await state(tx), day = new Date(now()).toISOString().slice(0, 10);
      if (Number(s.backoff_until) > now()) throw coded("rate_limited");
      if (s.day !== day) { s.day = day; s.calls = 0; }
      if (Number(s.calls || 0) >= DAILY_CALLS) throw coded("daily_budget");
      s.calls = Number(s.calls || 0) + 1; await saveState(tx, s);
    });
    // The writer may have queued us just before the maintenance window started.
    if (quiet(now())) throw coded("quiet");
    if (!keyed()) throw coded("needs_key");
    const u = new URL(path, "https://api.mdblist.com");
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    u.searchParams.set("apikey", getKey());
    const controller = new AbortController(); let timeout;
    let res;
    try {
      res = await Promise.race([Promise.resolve().then(() => request(u, { signal: controller.signal })), new Promise((_, reject) => {
        timeout = setTimeout(() => { controller.abort(); reject(coded("provider_timeout")); }, timeoutMs);
      })]);
    } catch (e) { throw coded(e && e.code === "provider_timeout" ? "provider_timeout" : "provider_unavailable"); }
    finally { clearTimeout(timeout); }
    if (!keyed()) throw coded("needs_key");
    const header = (n) => res && res.headers && (typeof res.headers.get === "function" ? res.headers.get(n) : res.headers[n.toLowerCase()] || res.headers[n]);
    if (res && res.status === 429) {
      await catalog.write(async (tx) => {
        const s = await state(tx), attempts = Math.min(6, Number(s.attempts || 0) + 1);
        const retry = Number(header("retry-after")), reset = Number(header("x-ratelimit-reset")) * 1000;
        const fallback = Math.min(6 * 3600000, 60000 * 2 ** (attempts - 1));
        s.attempts = attempts;
        s.backoff_until = Math.max(now() + (retry > 0 && Number.isFinite(retry) ? Math.min(retry * 1000, 7 * DAY) : fallback), Number.isFinite(reset) && reset > now() ? Math.min(reset, now() + 7 * DAY) : 0);
        await saveState(tx, s);
      });
      throw coded("rate_limited");
    }
    if (res && [401, 403].includes(res.status)) throw coded("provider_auth");
    if (res && res.status === 404) throw coded("not_found");
    if (!res || res.status !== 200) throw coded("provider_unavailable");
    if (!res.json || typeof res.json !== "object") throw coded("provider_invalid");
    await catalog.write(async (tx) => {
      const s = await state(tx); s.attempts = 0;
      if (String(header("x-ratelimit-remaining")) === "0") {
        const reset = Number(header("x-ratelimit-reset")) * 1000;
        s.backoff_until = Number.isFinite(reset) && reset > now() ? Math.min(reset, now() + 7 * DAY) : now() + DAY;
      }
      await saveState(tx, s);
    });
    return { json: res.json, more: String(header("x-has-more")).toLowerCase() === "true" };
  }
  function metadata(raw, expected) {
    const rows = (Array.isArray(raw) ? raw : [raw]).filter((r) => r && ID.test(String(r.id)) && (!expected || String(r.id) === expected));
    if (rows.length !== 1) throw coded(rows.length > 1 ? "ambiguous_list" : "provider_invalid");
    return { id: String(rows[0].id), name: clean(rows[0].name, 200) || "MDBList " + rows[0].id };
  }
  async function fetchList(meta) {
    const items = [], cursors = new Set(); let cursor = null, offset = 0;
    for (let page = 0; page < 20; page++) {
      const query = { limit: 1000, sort: "rank", order: "asc" };
      if (cursor) query.cursor = cursor; else if (offset) query.offset = offset;
      const res = await call("/lists/" + meta.id + "/items", query), body = res.json;
      if (!Array.isArray(body.movies) || !Array.isArray(body.shows)) throw coded("provider_invalid");
      const batch = [...body.movies.map((r) => ({ ...r, type: "movie" })), ...body.shows.map((r) => ({ ...r, type: "show" }))];
      if (batch.length > 1000 || items.length + batch.length > MAX_ITEMS) throw coded("list_too_large");
      items.push(...batch);
      const next = body.next_cursor || (body.pagination || {}).next_cursor;
      if (next != null && next !== "" && (typeof next !== "string" || next.length > 1000 || cursors.has(next))) throw coded("provider_invalid");
      if (!next && !res.more) return adapter({ ...meta, items });
      if (!batch.length) throw coded("provider_invalid");
      if (next) { cursor = next; cursors.add(next); } else { cursor = null; offset = items.length; }
    }
    throw coded("list_too_large");
  }
  async function match(entries) {
    const rows = [...await catalog.rows({ kind: "movie" }), ...await catalog.rows({ kind: "show" })];
    const index = new Map();
    for (const r of rows) for (const [field, value] of [["imdb", r.imdb], ["tmdb", r.tmdb], ["tvdb", r.type === "show" && r.tvdb], ["title", fold(r.title)]]) {
      if (!value) continue; const id = r.type + ":" + field + ":" + value;
      if (!index.has(id)) index.set(id, []); index.get(id).push(r);
    }
    const members = [];
    entries.forEach((r, item_no) => {
      if (!r) return;
      let hits = [];
      for (const field of ["imdb", "tmdb", ...(r.type === "show" ? ["tvdb"] : [])]) {
        if (r[field]) hits = index.get(r.type + ":" + field + ":" + r[field]) || [];
        if (hits.length) break;
      }
      if (!hits.length && r.year && /[\p{L}\p{N}]/u.test(fold(r.title))) hits = (index.get(r.type + ":title:" + fold(r.title)) || []).filter((c) => c.year && Math.abs(c.year - r.year) <= (r.type === "movie" ? 1 : 0)
        && !["imdb", "tmdb", ...(r.type === "show" ? ["tvdb"] : [])].some((k) => r[k] && c[k] && String(r[k]) !== String(c[k])));
      for (const hit of hits) members.push({ key: hit.key, rank: r.rank, item_no });
    });
    const safe = new Set((await catalog.getByKeys([...new Set(members.map((m) => m.key))])).map((r) => r.key));
    return members.filter((m) => safe.has(m.key));
  }
  async function store(value, readAt = now(), replace = true) {
    const a = adapter(value), members = await match(a.items);
    if (!keyed()) throw coded("needs_key");
    await catalog.write(async (tx) => {
      const old = (await tx.all("SELECT id FROM plex_lists WHERE id=?", [a.id]))[0];
      if (!old && (await tx.all("SELECT COUNT(*) AS n FROM plex_lists"))[0].n >= MAX_LISTS) throw coded("list_limit");
      if (replace) await tx.run(`INSERT INTO plex_lists(id,name,ranked,items,entries,last_read,last_attempt,last_error,retry_at) VALUES (?,?,?,?,?,?,?,NULL,0)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,ranked=excluded.ranked,items=excluded.items,entries=excluded.entries,last_read=excluded.last_read,last_attempt=excluded.last_attempt,last_error=NULL,retry_at=0`,
      [a.id, a.name, a.ranked ? 1 : 0, a.items.length, JSON.stringify(a.items), readAt, readAt]);
      else if (!old) return;
      await tx.run("DELETE FROM plex_list_members WHERE list_id=?", [a.id]);
      for (const m of members) await tx.run("INSERT OR IGNORE INTO plex_list_members(list_id,item_no,key,rank) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM plex_catalog WHERE key=?)", [a.id, m.item_no, m.key, m.rank, m.key]);
    });
    return a.id;
  }
  async function safeMembers(filters = {}, publicRead = true) {
    if (publicRead ? !enabled() : !keyed()) return [];
    await init(); const args = [], where = [];
    if (filters.id) { where.push("l.id=?"); args.push(listId(filters.id)); }
    if (filters.name) { where.push("lower(l.name)=lower(?)"); args.push(txt(filters.name)); }
    if (filters.rank_max != null) { const n = integer(filters.rank_max); if (!n || n < 1) return []; where.push("l.ranked=1 AND m.rank BETWEEN 1 AND ?"); args.push(n); }
    const policy = () => String(settings().clerk_block_ratings == null ? "X,XXX,AO,R18,R18+" : settings().clerk_block_ratings);
    async function selected(final = false, blockPolicy = "") {
      const conditions = [...where], values = [...args];
      let base = "SELECT m.key,m.rank,m.item_no,l.id,l.name,l.ranked";
      if (final) base += ",c.type AS current_type";
      base += " FROM plex_list_members m JOIN plex_lists l ON l.id=m.list_id";
      if (final) {
        base += " JOIN plex_catalog c ON c.key=m.key JOIN plex_sections cs ON cs.id=c.section";
        // Membership contains only movie/show roots. Recheck both stored projections together with
        // current section policy in this same final read, after getByKeys may have yielded.
        conditions.push("cs.policy='allowed'", "c.type IN ('movie','show')", "json_valid(c.data)",
          "json_extract(c.data,'$.key')=c.key", "json_extract(c.data,'$.section')=c.section", "json_extract(c.data,'$.type')=c.type");
        const blocked = [...new Set(blockPolicy.split(",").map((r) => r.trim().toUpperCase()).filter(Boolean))];
        if (blocked.length) for (const field of ["c.content_rating", "json_extract(c.data,'$.content_rating')"]) {
          conditions.push("UPPER(TRIM(COALESCE(" + field + ",''))) NOT IN (" + blocked.map(() => "?").join(",") + ")"); values.push(...blocked);
        }
      }
      if (!Array.isArray(filters.keys)) return catalog.read(base + (conditions.length ? " WHERE " + conditions.join(" AND ") : ""), values);
      const keys = [...new Set(filters.keys.map(String).filter((k) => /^\d{1,12}$/.test(k)))], out = [];
      for (let n = 0; n < keys.length; n += 400) {
        const part = keys.slice(n, n + 400);
        out.push(...await catalog.read(base + " WHERE " + [...conditions, "m.key IN (" + part.map(() => "?").join(",") + ")"].join(" AND "), [...values, ...part]));
      }
      return out;
    }
    const candidates = await selected();
    const safe = new Map((await catalog.getByKeys([...new Set(candidates.map((m) => m.key))])).map((r) => [r.key, r]));
    // Removal/refresh can overlap the catalog lookup. Return only membership still configured now.
    const blockPolicy = policy(), current = await selected(true, blockPolicy);
    if (policy() !== blockPolicy) return []; // A settings edit during SQL cannot validate a stale allow decision.
    if (publicRead ? !enabled() : !keyed()) return [];
    return current.filter((m) => safe.has(m.key) && safe.get(m.key).type === m.current_type && (!filters.kind || m.current_type === filters.kind)).map((m) => ({ ...m, kind: m.current_type }));
  }
  async function list() {
    if (!keyed()) return { ok: true, configured: false, message: "needs MDBLIST_API_KEY" };
    try {
      await init(); const lists = await catalog.read("SELECT id,name,ranked,items,last_read,last_error FROM plex_lists ORDER BY name,id");
      const members = await safeMembers({}, false), by = new Map();
      for (const m of members) { if (!by.has(m.id)) by.set(m.id, new Set()); by.get(m.id).add(m.item_no); }
      if (!keyed()) return { ok: true, configured: false, message: "needs MDBLIST_API_KEY" };
      return { ok: true, configured: true, enabled: enabled(), lists: lists.map((l) => ({ ...l, ranked: !!l.ranked, matched: (by.get(l.id) || new Set()).size, unmatched: l.items - (by.get(l.id) || new Set()).size })) };
    } catch (e) { return failure(e); }
  }
  const add = (input) => queued(async () => {
    const ref = reference(input), meta = metadata((await call(ref.path)).json, ref.id);
    const old = (await catalog.read("SELECT id FROM plex_lists WHERE id=?", [meta.id]))[0];
    if (old) return { ok: true, id: old.id, existing: true };
    if ((await catalog.read("SELECT COUNT(*) AS n FROM plex_lists"))[0].n >= MAX_LISTS) throw coded("list_limit");
    const id = await store(await fetchList(meta)); return { ok: true, id };
  });
  const search = (query) => queued(async () => {
    const q = txt(query, 120); if (q.length < 2) throw coded("invalid_query");
    const body = (await call("/lists/search", { query: q, limit: 10, offset: 0 })).json;
    if (!Array.isArray(body)) throw coded("provider_invalid");
    return { ok: true, lists: body.filter((r) => r && ID.test(String(r.id)) && r.private !== true).slice(0, 10).map((r) => ({ id: String(r.id), name: clean(r.name, 200) || "MDBList " + r.id, items: Math.max(0, integer(r.items) || 0) })) };
  });
  async function refreshOne(id, force) {
    const l = (await catalog.read("SELECT * FROM plex_lists WHERE id=?", [listId(id)]))[0];
    if (!l) throw coded("not_found");
    if (!force && (l.last_read > now() - DAY || l.retry_at > now())) return { ok: true, id: l.id, cached: true };
    try {
      const meta = metadata((await call("/lists/" + l.id)).json, l.id);
      await store(await fetchList(meta)); return { ok: true, id: l.id };
    } catch (e) {
      const code = failure(e).code;
      await catalog.write((tx) => tx.run("UPDATE plex_lists SET last_attempt=?,last_error=?,retry_at=? WHERE id=?", [now(), code, now() + 30 * 60000, l.id]));
      throw coded(code);
    }
  }
  const refresh = (id) => queued(() => refreshOne(id, true));
  const remove = (id) => queued(async () => { await catalog.write((tx) => tx.run("DELETE FROM plex_lists WHERE id=?", [listId(id)])); return { ok: true }; });
  const rematch = () => queued(async () => {
    for (const l of await catalog.read("SELECT * FROM plex_lists")) await store({ id: l.id, name: l.name, ranked: !!l.ranked, items: parsed(l.entries, []) }, l.last_read, false);
    return { ok: true };
  });
  const importSnapshot = (snapshot) => queued(async () => {
    if (!snapshot || !Array.isArray(snapshot.configured) || snapshot.configured.length > MAX_LISTS) throw coded("invalid_list");
    const rows = snapshot.configured.map(adapter); // Validate before any writes. Fixture-only internal method; no HTTP route.
    for (const r of rows) await store(r); return { ok: true, count: rows.length };
  });
  async function shelves() {
    try {
      const rows = await safeMembers(), out = new Map();
      for (const r of rows) {
        if (!out.has(r.id)) out.set(r.id, { id: "mdblist:" + r.id, name: r.name, source: "mdblist", ranked: !!r.ranked, keys: new Set(), kinds: new Set() });
        out.get(r.id).keys.add(r.key); out.get(r.id).kinds.add(r.kind);
      }
      return [...out.values()].map((r) => ({ id: r.id, name: r.name, count: r.keys.size, kind: r.kinds.size === 1 ? [...r.kinds][0] : "mixed", source: r.source, ranked: r.ranked })).sort((a, b) => a.name.localeCompare(b.name));
    } catch (_) { return []; }
  }
  async function members(filters = {}) {
    try {
      const rows = await safeMembers(filters), unique = new Map();
      for (const r of rows) {
        const k = r.id + ":" + r.key, old = unique.get(k);
        if (!old || (r.rank != null && (old.rank == null || r.rank < old.rank))) unique.set(k, { key: r.key, rank: r.ranked ? r.rank : null, list_id: "mdblist:" + r.id, name: r.name, source: "mdblist", ranked: !!r.ranked });
      }
      return [...unique.values()].sort((a, b) => (a.rank == null ? Infinity : a.rank) - (b.rank == null ? Infinity : b.rank) || a.key.localeCompare(b.key));
    } catch (_) { return []; }
  }
  function tick() {
    if (!enabled() || closed || quiet(now())) return Promise.resolve({ ok: true, skipped: true });
    if (!tickPromise) tickPromise = queued(async () => {
      if (!enabled() || quiet(now())) return { ok: true, skipped: true };
      const due = await catalog.read("SELECT id FROM plex_lists WHERE last_read<=? AND retry_at<=? ORDER BY last_read,last_attempt,id LIMIT 1", [now() - DAY, now()]);
      return due.length ? refreshOne(due[0].id, false) : { ok: true, cached: true };
    }).finally(() => { tickPromise = null; });
    return tickPromise;
  }
  function start() { if (!timer && !closed) { timer = interval(() => { void tick(); }, 60000); if (timer && timer.unref) timer.unref(); } }
  async function close() { closed = true; if (timer) clear(timer); timer = null; await tail; }
  function register(app, { addUser, noTimers } = {}) {
    const SP = options.permissions || require("./siteperms"), guard = options.guard || require("./middleware/authGuard");
    const admin = (req, res, next) => {
      if (!SP.can(req.user, "media.admin")) return res.status(403).json({ ok: false, error: "Admins only." });
      if (req.method === "POST" && !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
      next();
    };
    const route = (fn) => [addUser, admin, async (req, res) => {
      res.set("Cache-Control", "no-store");
      try { res.json(await fn(req)); } catch (_) { res.status(503).json({ ok: false, code: "lists_unavailable" }); }
    }];
    app.get("/api/media/admin/lists", ...route(() => list()));
    app.get("/api/media/admin/lists/search", ...route((r) => search((r.query || {}).q)));
    app.post("/api/media/admin/lists/add", ...route((r) => add((r.body || {}).input)));
    app.post("/api/media/admin/lists/refresh", ...route((r) => refresh((r.body || {}).id)));
    app.post("/api/media/admin/lists/remove", ...route((r) => remove((r.body || {}).id)));
    if (!noTimers) start();
  }
  return { init, list, search, add, refresh, remove, rematch, importSnapshot, shelves, members, membership: (keys) => members({ keys }), tick, start, close, register, enabled };
}
let singleton;
const get = () => singleton || (singleton = createLists());
module.exports = { createLists, reference, quiet, DAY, TIMEOUT, MAX_LISTS, MAX_ITEMS, DAILY_CALLS };
for (const method of ["list", "search", "add", "refresh", "remove", "rematch", "importSnapshot", "shelves", "members", "membership", "tick", "start", "close", "register", "enabled"]) module.exports[method] = (...args) => get()[method](...args);
