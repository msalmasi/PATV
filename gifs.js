// KLIPY metadata only. The browser loads media from KLIPY; PATV never stores/proxies a GIF file.
// Keep activation dark until the owner has the server-side plan/approval and the privacy disclosure.
"use strict";
const guard = require("./middleware/authGuard");
// Official v2 ID lookup + itemurl contract (v1 Items instead accepts slugs):
// https://docs.klipy.com/migrate-from-tenor/search.md
// https://docs.klipy.com/migrate-from-tenor/features.md
// https://docs.klipy.com/migrate-from-tenor/posts.md
const KLIPY_API_BASE = "https://api.klipy.com/v2";
// https://docs.klipy.com/network-requirements.md — exact hosts, never suffix matches.
const MEDIA_HOSTS = Object.freeze(["static.klipy.com", "static1.klipy.com", "static2.klipy.com"]);
const PAGE_HOSTS = Object.freeze(["klipy.com"]);
// https://docs.klipy.com/content-filtering.md — high = G (strictest).
const CONTENT_FILTER = "high", CACHE_TTL_MS = 24 * 60 * 60 * 1000, CACHE_MAX = 1000;
const SEARCH_LIMIT = 20, LOOKUP_LIMIT = 60, WINDOW_MS = 60000, LOOKUP_RETRY_MS = 60000;
const RESPONSE_MAX_BYTES = 2 * 1024 * 1024, REQUEST_TIMEOUT_MS = 8000, ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const cache = new Map(), pending = new Map(), retried = new Map(), hits = new Map();
let clock = () => Date.now();
class Refuse extends Error { constructor(status, code) { super(code); this.status = status; this.refuse = true; } }
const key = () => String(process.env.KLIPY_API_KEY || "").trim(); // call-time only; never retained/logged/exported
// 1.99aiw dock: review - the Room Dock off is the kill switch too: no KLIPY request and no KLIPY media in a line while it is off
const available = () => { const c = require("./paddock").current().cfg; return c.mode !== "off" && c.gifs === true && !!key(); };
function safeUrl(value, hosts) {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && hosts.includes(url.hostname) && !url.username && !url.password && (!url.port || url.port === "443") ? value : null;
  } catch (_) { return null; }
}
function titleOf(value) {
  return String(value == null ? "" : value).replace(/<[^>]*>/g, "").replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}
function imageOf(value) {
  if (!value || !Array.isArray(value.dims)) return null;
  const src = safeUrl(value.url, MEDIA_HOSTS), [w, h] = value.dims;
  if (!src || !Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 10000 || h > 10000) return null;
  return { src, w, h };
}
function normalize(item) {
  if (!item || typeof item.id !== "string" || !ID_RE.test(item.id)) return null;
  const formats = item.media_formats || {}, media = imageOf(formats.gif), preview = imageOf(formats.tinygif) || media;
  const page = item.itemurl ? safeUrl(item.itemurl, PAGE_HOSTS) : "";
  if (!media || !preview || page === null) return null;
  const result = { id: item.id, title: titleOf(item.title || item.content_description), preview, media, page };
  // A malformed upstream response must not reflect our credential into browser fields, either.
  const secret = key();
  const serialized = JSON.stringify(result);
  if (secret && (serialized.includes(secret) || serialized.includes(encodeURIComponent(secret)))) return null;
  return result;
}
function clone(item) { return { ...item, media: { ...item.media }, preview: { ...item.preview } }; }
function prune() {
  const now = clock();
  for (const [id, entry] of cache) if (now - entry.at >= CACHE_TTL_MS) cache.delete(id);
  for (const [id, at] of retried) if (now - at >= LOOKUP_RETRY_MS) retried.delete(id);
  for (const [id, entry] of hits) if (now - entry.at >= WINDOW_MS) hits.delete(id);
}
// 1.99aiw dock: `filtered` = the id came back from a contentfilter=high search / featured answer (only those can be sent)
function remember(item, filtered) {
  prune(); const old = cache.get(item.id); cache.delete(item.id);
  cache.set(item.id, { at: clock(), item: clone(item), filtered: !!filtered || !!(old && old.filtered) });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}
function peek(id) {
  const entry = cache.get(id);
  if (!entry) return null;
  if (clock() - entry.at >= CACHE_TTL_MS) { cache.delete(id); return null; }
  return clone(entry.item);
}
function hit(bucket, limit) {
  prune(); const now = clock(), entry = hits.get(bucket) || { at: now, count: 0 };
  if (entry.count >= limit) return false;
  entry.count++; hits.set(bucket, entry); return true;
}
async function request(endpoint, params) {
  const secret = key();
  if (!secret || !available()) throw new Refuse(403, "gif");
  const url = new URL(KLIPY_API_BASE + "/" + endpoint);
  url.searchParams.set("key", secret);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  try {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { Accept: "application/json" } });
    if (!response.ok || Number(response.headers.get("content-length")) > RESPONSE_MAX_BYTES) throw new Error("response");
    const parts = []; let bytes = 0;
    if (!response.body) throw new Error("body");
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > RESPONSE_MAX_BYTES) throw new Error("size");
      parts.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
    if (!available() || key() !== secret || !body || !Array.isArray(body.results)) throw new Error("response");
    return body.results;
  } catch (_) {
    // Fetch errors can contain the full URL/key/query. Do not log them or retain their cause.
    throw new Refuse(503, "unavailable");
  }
}
async function search(q) {
  if (typeof q !== "string" || q.length > 50) throw new Refuse(400, "query");
  const params = { contentfilter: CONTENT_FILTER, media_filter: "tinygif,gif", limit: 20 };
  if (q) params.q = q;
  const items = await request(q ? "search" : "featured", params), out = [];
  // 1.99aiw dock: review - Pepe says the title in the Camfrog room; the rating filter rates the picture, not the uploader's title,
  // so a title the text guard refuses (textguard.js) is never offered - and never becomes sendable
  for (const raw of items.slice(0, 50)) { const item = normalize(raw); if (item && !require("./textguard").bad(item.title)) { remember(item, true); out.push(clone(item)); } }
  return out;
}
/** 1.99aiw dock: the GIF a say line may post - only an id a filtered (contentfilter=high) search / featured answer gave in the
 *  cache's 24 h. Never the Posts lookup (resolve), which has no rating filter: a hand-made "[gif:<id>]" could otherwise put any
 *  GIF in the chat for everyone, and distinct bogus ids could spend the global lookup budget. Synchronous: no provider request. */
function picked(id) {
  if (typeof id !== "string" || !ID_RE.test(id) || !available()) return null;
  const entry = cache.get(id);
  return entry && entry.filtered === true ? peek(id) : null;
}
function resolve(id) {
  if (typeof id !== "string" || !ID_RE.test(id) || !available()) return Promise.resolve(null);
  const saved = peek(id); if (saved) return Promise.resolve(saved);
  if (pending.has(id)) return pending.get(id);
  prune();
  if (retried.has(id) || !hit("lookup", LOOKUP_LIMIT)) return Promise.resolve(null);
  retried.set(id, clock());
  // Posts supports key/ids/media_filter only. Do not invent rating support for this endpoint;
  // the high-rated search/trending picker and owner-configured KLIPY filtering are the discovery controls.
  const task = request("posts", { ids: id, media_filter: "tinygif,gif" }).then(items => {
    const item = items.map(normalize).find(x => x && x.id === id);
    if (item) remember(item, false);           // (1.99aiw dock: rendering metadata only - never makes the id sendable)
    return item || null;
  }).catch(() => null).finally(() => pending.delete(id));
  pending.set(id, task); return task;
}
function attach(item) {
  if (!item || typeof item !== "object") return item;
  delete item.gif;
  if (!available() || item.k !== "msg" || !item.u || item.u.web !== true || item.u.anon || item.mask || item.removed) return item;
  const token = require("./public/js/chatlog-core").mediaToken(item.text);
  if (!token || token.type !== "gif") return item;
  const value = peek(token.id);
  if (value) item.gif = { ...value.media, title: value.title };
  else void resolve(token.id); // cache-only render path; one throttled/in-flight lookup per id
  return item;
}
function register(app, { addUser }) {
  // 1.99aiw dock: review - privacy: POST {q, pad}, never a GET - what people look for (often a name) never sits in a URL, so it stays
  // out of nginx's and Cloudflare's request logs (spec O.1: q is never logged), as the pad chat's own search does (chatlogsearch.js)
  app.post("/api/gifs/search", addUser, require("express").json({ limit: "4kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!guard.sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, code: "security", error: "GIF search unavailable." });
    try {
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      // 1.99aiw dock: review - a slug only: a pad object ({id, relay, ...}) is what sayEligibility would take as the room itself
      const pad = typeof body.pad === "string" ? body.pad : "";
      const access = await require("./bridge-relay").sayEligibility(req, pad);
      if (!access.ok) return res.status(access.status).json(access.body);
      if (!available()) throw new Refuse(403, "gif");
      const q = body.q == null ? "" : body.q;
      if (typeof q !== "string" || q.length > 50) throw new Refuse(400, "query");
      if (!hit("search:" + access.u.userId, SEARCH_LIMIT)) throw new Refuse(429, "rate");
      const result = await search(q);
      // Permissions/switches may change during the provider request.
      const current = await require("./bridge-relay").sayEligibility(req, pad);
      if (!current.ok) return res.status(current.status).json(current.body);
      if (!available()) throw new Refuse(403, "gif");
      res.json(result);
    } catch (e) { res.status(e && e.refuse ? e.status : 503).json({ ok: false, code: e && e.refuse ? e.message : "unavailable", error: "GIF search unavailable." }); }
  });
}
module.exports = { available, normalize, peek, picked, resolve, search, attach, register, KLIPY_API_BASE, MEDIA_HOSTS, PAGE_HOSTS, CONTENT_FILTER,
  CACHE_TTL_MS, CACHE_MAX, SEARCH_LIMIT, LOOKUP_LIMIT, LOOKUP_RETRY_MS, RESPONSE_MAX_BYTES,
  _reset: () => { cache.clear(); pending.clear(); retried.clear(); hits.clear(); clock = () => Date.now(); }, _clock: fn => { clock = fn; } };
