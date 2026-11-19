// KLIPY GIFs. The browser loads media from KLIPY; PATV never stores/proxies a GIF file.
// 1.99aot gifs: two modes behind the Room Dock card's GIF control (paddock.js `gifs`: off | free | partner, default off):
//   free     KLIPY's free (standard) plan - the member's BROWSER calls KLIPY (search / trending / share trigger) with the browser
//            key KLIPY_PUBLIC_KEY, which the page carries; PATV's server makes NO request to KLIPY at all. A send carries the GIF's
//            details; the server checks what it can without KLIPY (freeGif) and keeps them with the line (gf - URLs and sizes, never
//            the media). It cannot confirm a posted GIF's rating - see the moderation block list below.
//   partner  KLIPY's paid server-side plan - today's code: our server searches KLIPY with KLIPY_API_KEY (never sent to a browser),
//            keeps GIF details 24 h in memory and only lets members post an id its filtered search returned.
// Both: the Room Dock off is the kill switch, a moderator's block (gif_blocks) removes a GIF everywhere - by its id, its slug and its
// picture's media key, in either mode - the privacy notice first. No server request ever goes to KLIPY in free mode (and linkpreview.js
// never fetches a KLIPY link in any mode).
// 1.99aot gifs (owner 2026-11-19, "lets stick to their rules"): KLIPY's integration rules say Search and Trending results are shown as
// KLIPY gives them - never removed, suppressed or filtered. So neither mode leaves anything we judge out of KLIPY's answers: a GIF our
// moderators removed, or one whose title the text guard refuses, is still offered in its place; the say route refuses to SEND it
// (gif_removed: "This GIF was removed on PATV."). Only an item that can't be drawn safely (malformed - normalize) is skipped.
"use strict";
const guard = require("./middleware/authGuard");
const { runQuery, getQuery, tx } = require("./dbUtils");
// Official v2 ID lookup + itemurl contract (v1 Items instead accepts slugs):
// https://docs.klipy.com/migrate-from-tenor/search.md
// https://docs.klipy.com/migrate-from-tenor/features.md
// https://docs.klipy.com/migrate-from-tenor/posts.md
const KLIPY_API_BASE = "https://api.klipy.com/v2";
// 1.99aot gifs: the browser's (free mode) API - KLIPY's native v1 API on the same host (docs.klipy.com/gifs-api/*: api/v1/{app_key}/gifs/
// search | trending | share/{slug}); public/js/pad-picker.js holds the same base.
const KLIPY_BROWSER_API = "https://api.klipy.com/api/v1";
// https://docs.klipy.com/network-requirements.md — exact hosts, never suffix matches.
const MEDIA_HOSTS = Object.freeze(["static.klipy.com", "static1.klipy.com", "static2.klipy.com"]);
const PAGE_HOSTS = Object.freeze(["klipy.com"]);
// 1.99aot gifs: what a page that shows the picker needs from a Content-Security-Policy, if the site ever sends one (it sends none for
// pages today): the browser's API calls and the CDN pictures, exactly these hosts.
const CSP_SOURCES = Object.freeze({ connect: Object.freeze(["https://api.klipy.com"]), img: Object.freeze(MEDIA_HOSTS.map((h) => "https://" + h)) });
// https://docs.klipy.com/content-filtering.md — high = G (strictest).
const CONTENT_FILTER = "high", CACHE_TTL_MS = 24 * 60 * 60 * 1000, CACHE_MAX = 1000;
// 1.99aot gifs: free mode's rating per pad (owner 2026-11-19): general pads high (G), 18+ pads low (G, PG, PG-13); "off" (adds R) only
// once the 18+ age gate is on - not yet
const RATINGS = Object.freeze({ general: "high", adult: "low" });
const SEARCH_LIMIT = 20, LOOKUP_LIMIT = 60, WINDOW_MS = 60000, LOOKUP_RETRY_MS = 60000;
const SEND_LIMIT = 6;                      // 1.99aot gifs: free-mode GIF sends a minute per member (on top of the say caps)
const RESPONSE_MAX_BYTES = 2 * 1024 * 1024, REQUEST_TIMEOUT_MS = 8000, ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;  // 1.99aot gifs: the browser key's shape (it rides in a URL path)
const SRC_MAX = 512, DIM_MAX = 4096, NOTICE_V = "2026-11-19";
// 1.99aot gifs: review - GIF removals by a pad's owner / mods (staff: no cap) a day per account - each one is site-wide
const BLOCK_DAY_MAX = 20, DAY_MS = 24 * 60 * 60 * 1000;
const cache = new Map(), pending = new Map(), retried = new Map(), hits = new Map(), blockHits = new Map();
let clock = () => Date.now();
class Refuse extends Error { constructor(status, code) { super(code); this.status = status; this.refuse = true; } }
const key = () => String(process.env.KLIPY_API_KEY || "").trim(); // call-time only; never retained/logged/exported
const rawPublicKey = () => String(process.env.KLIPY_PUBLIC_KEY || "").trim();
// 1.99aot gifs: the browser key - meant for pages (KLIPY's free plan: client-direct requests). Malformed = unset. review: the same value
// as the server key is no browser key either - free mode would publish the partner (server-side) key to every member's page
const publicKey = () => { const k = rawPublicKey(); return KEY_RE.test(k) && k !== key() ? k : ""; };
const cfg = () => require("./paddock").current().cfg;
/** 1.99aot gifs: the GIF mode the admin chose - off | free | partner (the Room Dock's own off is checked by available()). */
const mode = () => { const g = cfg().gifs; return g === "free" || g === "partner" ? g : "off"; };
// 1.99aiw dock: review - the Room Dock off is the kill switch too: no KLIPY request and no KLIPY media in a line while it is off
// 1.99aot gifs: GIFs are on in the chosen mode with that mode's key
const available = () => { const c = cfg(); if (c.mode === "off") return false; const m = mode(); return m === "partner" ? !!key() : m === "free" ? !!publicKey() : false; };
/** 1.99aot gifs: the server may call KLIPY (partner mode with its key) - the only gate on request(). */
const partnerOn = () => available() && mode() === "partner";
const freeOn = () => available() && mode() === "free";
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
// 1.99aot gifs: review - a KLIPY picture's MEDIA KEY: every size and format of one GIF lives in one CDN directory,
// /ii/<32 hex>/<2 hex>/<2 hex>/<file>.<ext> (docs.klipy.com gifs-api trending and migrate-from-tenor search examples; v1 and v2 alike).
// A removal blocks it too, so a removed picture can't come back under another slug / id - and a v2 (numeric) id and a v1 slug of the
// same GIF meet in it, whichever GIF mode the removal or the send happened in. null = not a KLIPY CDN picture of that shape.
const MK_PATH_RE = /^\/ii\/([0-9a-fA-F]{32})\/([0-9a-fA-F]{2})\/([0-9a-fA-F]{2})\/[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9]{2,5}$/;
function mediaKey(src) {
  if (typeof src !== "string" || !safeUrl(src, MEDIA_HOSTS)) return null;
  let u;
  try { u = new URL(src); } catch (_) { return null; }
  const m = MK_PATH_RE.exec(u.pathname);
  return m ? (m[1] + "/" + m[2] + "/" + m[3]).toLowerCase() : null;
}
// a GIF's KLIPY page (v2 itemurl; the free picker's FREE_PAGE + slug) -> its slug, the v1 API's name for it
const PAGE_RE = /^https:\/\/klipy\.com\/gifs\/([A-Za-z0-9_-]{1,64})$/;
const slugOfPage = (page) => { const m = typeof page === "string" ? PAGE_RE.exec(page) : null; return m ? m[1] : null; };
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
  // 1.99aot gifs: partner mode only - free mode never reaches KLIPY from the server (no search, no Posts lookup, no cache refill)
  if (!secret || !partnerOn()) throw new Refuse(403, "gif");
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
    if (!partnerOn() || key() !== secret || !body || !Array.isArray(body.results)) throw new Error("response");
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
  // 1.99aot gifs (owner 2026-11-19: KLIPY's rules - results as KLIPY gives them): every item that can be drawn safely (normalize), in
  // KLIPY's order. A GIF a moderator removed everywhere, or whose title the text guard refuses (Pepe says the title in the Camfrog
  // room - 1.99aiw dock), is offered like the rest and refused at the send (bridge-relay.js sendSayLine: removed / titleBad)
  for (const raw of items.slice(0, 50)) { const item = normalize(raw); if (item) { remember(item, true); out.push(clone(item)); } }
  return out;
}
/** 1.99aiw dock: the GIF a say line may post - only an id a filtered (contentfilter=high) search / featured answer gave in the
 *  cache's 24 h. Never the Posts lookup (resolve), which has no rating filter: a hand-made "[gif:<id>]" could otherwise put any
 *  GIF in the chat for everyone, and distinct bogus ids could spend the global lookup budget. Synchronous: no provider request.
 *  (1.99aot gifs: partner mode only; never a blocked id) */
function picked(id) {
  if (typeof id !== "string" || !ID_RE.test(id) || !partnerOn() || BLOCKED.has(id)) return null;
  const entry = cache.get(id);
  return entry && entry.filtered === true && !itemBlocked(entry.item) ? peek(id) : null;
}
/** 1.99aot gifs: a GIF title the text guard refuses - Pepe says the title in the Camfrog room (1.99aiw dock). The partner search offers
 *  such a GIF (KLIPY's results as given); the say route refuses to send it. */
const titleBad = (title) => require("./textguard").bad(titleOf(title));
function resolve(id) {
  if (typeof id !== "string" || !ID_RE.test(id) || !partnerOn()) return Promise.resolve(null);
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

// ── 1.99aot gifs: free mode - the server's checks on a GIF the browser picked ──
/** The pad's rating for the browser's KLIPY requests: 18+ pads (rooms_registry.adult) "low", every other pad "high". */
function ratingFor(roomId) {
  let adult = false;
  try { adult = require("./adultgate").isAdultPad(roomId); } catch (e) { adult = false; }
  return adult ? RATINGS.adult : RATINGS.general;
}
// A KLIPY CDN picture URL: https, an exact host, no userinfo / port / fragment / percent-encoding, KLIPY's own path shape
// /ii/<32 hex>/<2 hex>/<2 hex>/<name>.gif|webp (review: never any other path on the CDN - so its media key can always be read), an
// optional plain query (KLIPY's URLs are used as given)
const SRC_PATH_RE = /^\/ii\/[0-9a-fA-F]{32}\/[0-9a-fA-F]{2}\/[0-9a-fA-F]{2}\/[A-Za-z0-9_-]{1,64}\.(?:gif|webp)$/;
const SRC_QUERY_RE = /^[A-Za-z0-9._~=&-]{0,256}$/;
function cdnSrc(value) {
  if (typeof value !== "string" || !value || value.length > SRC_MAX || /[\u0000-\u0020\u007f\\%#"'<>]/.test(value)) return null;
  if (!/^https:\/\//.test(value) || safeUrl(value, MEDIA_HOSTS) !== value) return null;
  let url;
  try { url = new URL(value); } catch (_) { return null; }
  if (url.port || url.hash || !SRC_PATH_RE.test(url.pathname) || !SRC_QUERY_RE.test(url.search.replace(/^\?/, ""))) return null;
  if (url.href !== value) return null;      // exactly as KLIPY gave it - never a variant the parser normalized (case, dots, ...)
  return value;
}
const dim = (n) => Number.isInteger(n) && n >= 1 && n <= DIM_MAX;
const pageFor = (id) => "https://klipy.com/gifs/" + id;
/**
 * The details a free-mode send carries ({src, w, h, title, page}) for GIF `id` (the token's) -> {ok, media, gf} | {ok: false, code}.
 * Exact CDN hosts and URL shape, integer sizes, a cleaned title the text guard passes, the page link exactly
 * https://klipy.com/gifs/<id> (or none), never a blocked GIF - by its slug or by its picture (the media key: review - a removed picture
 * under a fresh slug is still removed). No provider request: the rating can't be confirmed here (rating = the one the page was told
 * to use, kept with the line).
 */
function freeGif(id, body, roomId) {
  if (typeof id !== "string" || !ID_RE.test(id)) return { ok: false, code: "gif" };
  if (BLOCKED.has(id)) return { ok: false, code: "gif_removed" };
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  if (!b) return { ok: false, code: "gif" };
  const src = cdnSrc(b.src);
  if (!src || !dim(b.w) || !dim(b.h)) return { ok: false, code: "gif" };
  if (blockedAny([id], src)) return { ok: false, code: "gif_removed" };
  if (b.title != null && (typeof b.title !== "string" || b.title.length > 200)) return { ok: false, code: "gif" };
  const title = titleOf(b.title);
  if (require("./textguard").bad(title)) return { ok: false, code: "gif_title" };
  const page = b.page == null || b.page === "" ? "" : b.page === pageFor(id) ? pageFor(id) : null;
  if (page === null) return { ok: false, code: "gif" };
  const r = ratingFor(roomId);
  return { ok: true, media: { type: "gif", id, title, page }, gf: { src, w: b.w, h: b.h, title, r } };
}
/** A line's stored free-mode details (bridge.mediaMark copied them from its say job) - re-checked, or null. r = the rating it was sent
 *  under (null: none / unknown - treated as the laxest). */
function storedOf(gf) {
  if (!gf || typeof gf !== "object") return null;
  const src = cdnSrc(gf.src);
  if (!src || !dim(gf.w) || !dim(gf.h)) return null;
  return { src, w: gf.w, h: gf.h, title: titleOf(gf.title), r: Object.prototype.hasOwnProperty.call(RANK, gf.r) ? gf.r : null };
}
// 1.99aot gifs: review - KLIPY's content_filter from the strictest (high = G) to the laxest (off adds R)
const RANK = Object.freeze({ high: 0, medium: 1, low: 2, off: 3 });
/** The rating a pad allows NOW, from the chat view (chatlogview.view: `adult` = the registry's 18+ flag, as ratingFor reads it);
 *  no view = the strictest */
const ratingOfView = (view) => (view && view.adult === true ? RATINGS.adult : RATINGS.general);
/** A GIF sent under rating `r` is laxer than `now` allows (an unknown r always is) */
const laxer = (r, now) => !Object.prototype.hasOwnProperty.call(RANK, r) || RANK[r] > RANK[now];
/** One free-mode GIF send a minute bucket: false = over SEND_LIMIT. */
const sendOk = (userId) => hit("send:" + userId, SEND_LIMIT);

// ── 1.99aot gifs: the block list (a moderator's "Remove this GIF everywhere") + the one-time notice, both in memory ──
// review: a removal blocks the GIF by every name it is known by - the line's token id (a v1 slug in free mode, a v2 id in partner mode),
// its KLIPY slug, and its picture's media key (mediaKey) - so it holds across both GIF modes and under any slug a browser picks.
// review (privacy): a block row has no personal data - no line number, no reason (the hidden line keeps that, as any 🙈 Hide does),
// no account: the GIF's keys, when, the pad and the kind of moderator (owner / mod / staff).
// (owner 2026-11-19: the list stays on the server - no page gets it; the picker never leaves a GIF out of KLIPY's results)
let BLOCKED = new Set(), MKS = new Set(), SEEN = new Set(), ready = null, loaded = false;
const MK_RE = /^[0-9a-f]{32}\/[0-9a-f]{2}\/[0-9a-f]{2}$/;
async function loadBlocks() {
  const b = new Set(), m = new Set();
  for (const r of await getQuery("SELECT id, slug, mk FROM gif_blocks")) {
    b.add(String(r.id)); if (r.slug) b.add(String(r.slug)); if (r.mk) m.add(String(r.mk));
  }
  BLOCKED = b; MKS = m;
}
function init() {
  if (!ready) ready = (async () => {
    await runQuery(`CREATE TABLE IF NOT EXISTS gif_blocks (id TEXT PRIMARY KEY, at INTEGER NOT NULL, room TEXT, kind TEXT, slug TEXT, mk TEXT)`);
    await runQuery(`CREATE TABLE IF NOT EXISTS gif_notice_seen (user_id TEXT PRIMARY KEY, at INTEGER NOT NULL, v TEXT)`);
    const s = new Set();
    await loadBlocks();
    for (const r of await getQuery("SELECT user_id FROM gif_notice_seen")) s.add(String(r.user_id));
    SEEN = s; loaded = true;
  })().catch((e) => { ready = null; throw e; });
  return ready;
}
const isBlocked = (id) => BLOCKED.has(String(id));
/** review: is a GIF removed everywhere - any of `ids` (its token id, its slug) or the picture at `src` (its media key)? */
function blockedAny(ids, src) {
  for (const id of ids || []) if (typeof id === "string" && id && BLOCKED.has(id)) return true;
  const mk = typeof src === "string" && src ? mediaKey(src) : null;
  return !!(mk && MKS.has(mk));
}
/** a partner (v2) item - normalize()'s {id, page, media, preview}: its v2 id, its itemurl's slug, its pictures */
function itemBlocked(item) {
  if (!item || typeof item !== "object") return false;
  return blockedAny([item.id, slugOfPage(item.page)], item.media && item.media.src) || blockedAny([], item.preview && item.preview.src);
}
/** review: a GIF the say route checked is still sendable at its last check - free mode by its slug + picture (gf.src), partner mode
 *  by its id + the cache's item */
const removed = (id, gf) => (gf ? blockedAny([id], gf.src) : BLOCKED.has(String(id)) || itemBlocked(peek(String(id))));
/**
 * The keys a removal of this line's GIF blocks -> {id, slug, mk}. A free-mode line (its stored details, gf): the token id IS the slug
 * the browser named, the media key comes from its picture. A partner-mode line: the cache's item, when it is there (its itemurl's
 * slug, its picture's media key); else the id alone.
 */
function keysOf(id, stored) {
  const gf = stored && typeof stored === "object" ? storedOf(stored.gf) : null;
  if (gf) return { id, slug: id, mk: mediaKey(gf.src) };
  const it = peek(id);
  return { id, slug: it ? slugOfPage(it.page) : null, mk: it ? mediaKey(it.media.src) || mediaKey(it.preview.src) : null };
}
function keysIn(keys) {
  const k = typeof keys === "string" ? { id: keys } : keys && typeof keys === "object" ? keys : {};
  if (typeof k.id !== "string" || !ID_RE.test(k.id)) throw new Refuse(400, "gif");
  return { id: k.id, slug: typeof k.slug === "string" && ID_RE.test(k.slug) ? k.slug : null, mk: typeof k.mk === "string" && MK_RE.test(k.mk) ? k.mk : null };
}
/** Inside the caller's transaction (chatlogmod.gifBlock): block a GIF site-wide by its keys ({id, slug, mk}, or an id). -> inserted?
 *  A GIF already blocked by that id gains the slug / media key it lacked. Memory follows after the commit (noteBlocked). */
async function blockInTx(keys, { room = null, kind = null } = {}, at = clock()) {
  const k = keysIn(keys);
  await init();
  const r = await runQuery(`INSERT INTO gif_blocks (id, at, room, kind, slug, mk) VALUES (?, ?, ?, ?, ?, ?)
                            ON CONFLICT(id) DO UPDATE SET slug = COALESCE(gif_blocks.slug, excluded.slug), mk = COALESCE(gif_blocks.mk, excluded.mk)`,
                           [k.id, at, room ? String(room).slice(0, 128) : null, kind ? String(kind).slice(0, 16) : null, k.slug, k.mk]);
  return !!(r && r.changes);
}
function noteBlocked(keys) {
  let k;
  try { k = keysIn(keys); } catch (e) { return; }
  BLOCKED.add(k.id); if (k.slug) BLOCKED.add(k.slug); if (k.mk) MKS.add(k.mk);
  cache.delete(k.id);
}
/** review: whether account `userId` may remove one more GIF everywhere today (owners / mods: BLOCK_DAY_MAX a day; staff: always) */
function blockQuota(userId, staff) {
  if (staff) return true;
  const t = clock(), list = (blockHits.get(String(userId)) || []).filter((x) => t - x < DAY_MS);
  blockHits.set(String(userId), list);
  return list.length < BLOCK_DAY_MAX;
}
function noteBlockUse(userId, staff) { if (!staff) { const k = String(userId), l = blockHits.get(k) || []; l.push(clock()); blockHits.set(k, l); } }
/** review: on open pad pages, which live lines show this block's GIF (bridge.gifRedo) - by the token's id or slug, a free line's stored
 *  picture, or the partner cache's item */
function lineMatcher(rec) {
  const ids = [rec && rec.id, rec && rec.slug].filter(Boolean), mk = rec && rec.mk;
  return (tok, it) => {
    if (ids.includes(tok.id)) return true;
    const gf = it && it.gf && typeof it.gf === "object" ? it.gf : null;
    if (gf) return !!mk && mediaKey(gf.src) === mk;
    const v = peek(tok.id);
    return !!v && (ids.includes(slugOfPage(v.page)) || (!!mk && (mediaKey(v.media.src) === mk || mediaKey(v.preview.src) === mk)));
  };
}
function redo(rec) {
  // (its lines redrawn on open pad pages - when the bridge runs in this process; never loads it just for this)
  try { const B = require.cache[require.resolve("./bridge")]; if (B && B.exports.gifRedo) B.exports.gifRedo(lineMatcher(rec)); } catch (e) { /* the next load shows it */ }
}
async function blocks(limit = 50) {
  await init();
  return (await getQuery("SELECT id, at, room, kind FROM gif_blocks ORDER BY at DESC LIMIT ?", [Math.max(1, Math.min(200, limit))]))
    .map((r) => ({ id: r.id, at: Number(r.at), room: r.room || null, kind: r.kind || null }));
}
/** A site admin (pads.config) lifts a block - one transaction with its admin_audit row. -> {ok, removed} */
async function unblock(user, id, reason) {
  if (!require("./siteperms").can(user, "pads.config")) throw new Refuse(403, "denied");
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Refuse(400, "invalid");
  await init(); await require("./adminaudit").init();
  let gone = false, rec = null;
  await tx(async () => {
    const row = (await getQuery("SELECT id, slug, mk FROM gif_blocks WHERE id = ?", [id]))[0];
    const r = row ? await runQuery("DELETE FROM gif_blocks WHERE id = ?", [id]) : null;
    gone = !!(r && r.changes);
    if (gone) { rec = { id: row.id, slug: row.slug || null, mk: row.mk || null }; await require("./adminaudit").record(user, "gif_unblock", null, { id }, reason ? String(reason).slice(0, 200) : null); }
  });
  if (gone) {
    // (review: from the table again - another removal may still block the same slug or picture)
    try { await loadBlocks(); } catch (e) { BLOCKED.delete(id); }
    redo(rec);
  }
  return { ok: true, removed: gone };
}
const noticeSeen = (userId) => !!userId && SEEN.has(String(userId));
async function noteNotice(userId) {
  if (!userId) throw new Refuse(401, "signin");
  await init();
  const at = clock();
  await tx(async () => { await runQuery("INSERT OR IGNORE INTO gif_notice_seen (user_id, at, v) VALUES (?, ?, ?)", [String(userId), at, NOTICE_V]); });
  SEEN.add(String(userId));
  return { ok: true };
}
/** The page data for an eligible viewer in free mode: {k: browser key, r: rating, n: notice seen} | null (bridge.js liveView).
 *  (owner 2026-11-19: no list of removed GIFs - the picker shows KLIPY's results as KLIPY gives them; the say route refuses a removed one) */
function pageData(roomId, userId) {
  if (!freeOn()) return null;
  if (!loaded) init().catch(() => {});
  return { k: publicKey(), r: ratingFor(roomId), n: noticeSeen(userId) };
}
/** The admin card's status - never a key: which modes have their key, the mode chosen, the recent blocks. review: a browser key equal to
 *  the server key is "same_as_server" (refused: free mode would publish the server's key) */
async function adminStatus() {
  const raw = rawPublicKey();
  const free = !raw ? "missing" : !KEY_RE.test(raw) ? "malformed" : raw === key() ? "same_as_server" : "set";
  return { mode: mode(), keys: { free, partner: key() ? "set" : "missing" }, on: available(), blocks: await blocks(50) };
}

// 1.99ajc dockfu: the line must carry the server's GIF mark (D3: bridge.js mediaMark - a relayed pick's own say job; a "[gif:x]" typed
// in Camfrog has none) - and that is all: D2 (owner answer 6) a veiled sender's GIF (incognito frog name, "someone") gets its picture
// like anyone's (no web mark or name rides with it). Never on a masked bar or a removed line.
// 1.99aot gifs: `src` = the stored item (chatlogview.dress): a free-mode line's own details (src.gf) draw it in either mode; otherwise
// the partner cache (and, in partner mode only, one throttled lookup). A blocked GIF gets {gone: 1} - the page's "GIF no longer
// available"; free mode never asks KLIPY anything here.
// review: blocked by any of its keys (the token's id, a free line's picture, the cached item's slug / picture), and `view` = the chat
// view (chatlogview.dress: its `adult`) - a free line sent under a laxer rating than the pad allows NOW (an 18+ pad made general: its
// PG-13 GIFs) is "gone" too.
function attach(item, src, view) {
  if (!item || typeof item !== "object") return item;
  delete item.gif;
  if (!available() || item.k !== "msg" || item.md !== "gif" || item.mask || item.removed) return item;
  const token = require("./public/js/chatlog-core").mediaOf(item);
  if (!token || token.type !== "gif") return item;
  const stored = src && typeof src === "object" ? storedOf(src.gf) : null;
  if (blockedAny([token.id], stored ? stored.src : null)) { item.gif = { gone: 1 }; return item; }
  if (stored) {
    item.gif = laxer(stored.r, ratingOfView(view)) ? { gone: 1 } : { src: stored.src, w: stored.w, h: stored.h, title: stored.title };
    return item;
  }
  const value = peek(token.id);
  if (value && itemBlocked(value)) item.gif = { gone: 1 };
  else if (value) item.gif = { ...value.media, title: value.title };
  else if (partnerOn()) void resolve(token.id); // cache-only render path; one throttled/in-flight lookup per id
  return item;
}
// 1.99ajc dockfu: review - the search body's 4 kB limit, whichever path spelling reached the route. Express (not strict, not case
// sensitive) routes /api/gifs/search/ and /API/GIFS/SEARCH here too, but index.js's skip list compares req.path exactly, so its
// global (100 kB) parser read those first and express.json below saw an already-read body. A body another parser took is kept only
// with a Content-Length within the limit.
const SEARCH_BODY_MAX = 4096;
function searchBodyLimit(req, res, next) {
  if (!req._body) return next();
  const n = Number(req.get("content-length"));
  if (Number.isFinite(n) && n >= 0 && n <= SEARCH_BODY_MAX) return next();
  res.set("Cache-Control", "no-store");
  return res.status(413).json({ ok: false, code: "too_large", error: "GIF search unavailable." });
}
function register(app, { addUser }) {
  init().catch((e) => console.error("[gifs] init:", e.message));
  // 1.99aiw dock: review - privacy: POST {q, pad}, never a GET - what people look for (often a name) never sits in a URL, so it stays
  // out of nginx's and Cloudflare's request logs (spec O.1: q is never logged), as the pad chat's own search does (chatlogsearch.js)
  app.post("/api/gifs/search", addUser, searchBodyLimit, require("express").json({ limit: SEARCH_BODY_MAX }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!guard.sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, code: "security", error: "GIF search unavailable." });
    try {
      const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
      // 1.99aiw dock: review - a slug only: a pad object ({id, relay, ...}) is what sayEligibility would take as the room itself
      const pad = typeof body.pad === "string" ? body.pad : "";
      const access = await require("./bridge-relay").sayEligibility(req, pad);
      if (!access.ok) return res.status(access.status).json(access.body);
      if (!partnerOn()) throw new Refuse(403, "gif");       // (1.99aot gifs: free mode searches from the browser - never here)
      const q = body.q == null ? "" : body.q;
      if (typeof q !== "string" || q.length > 50) throw new Refuse(400, "query");
      if (!hit("search:" + access.u.userId, SEARCH_LIMIT)) throw new Refuse(429, "rate");
      const result = await search(q);
      // Permissions/switches may change during the provider request.
      const current = await require("./bridge-relay").sayEligibility(req, pad);
      if (!current.ok) return res.status(current.status).json(current.body);
      if (!partnerOn()) throw new Refuse(403, "gif");
      res.json(result);
    } catch (e) { res.status(e && e.refuse ? e.status : 503).json({ ok: false, code: e && e.refuse ? e.message : "unavailable", error: "GIF search unavailable." }); }
  });
  // 1.99aot gifs: the free picker's one-time notice ("GIF search is provided by KLIPY ...") - recorded once per account, so it shows
  // before a member's first search on any device. Signed in, same-site fetch, free mode on. No pad or query in it.
  app.post("/api/gifs/notice", addUser, require("express").json({ limit: "1kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!guard.sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, code: "security" });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, code: "signin" });
    if (!freeOn()) return res.status(403).json({ ok: false, code: "gif" });
    try { res.json(await noteNotice(req.user.userId)); }
    catch (e) { if (!(e && e.refuse)) console.error("[gifs] notice:", e && e.message); res.status(e && e.refuse ? e.status : 503).json({ ok: false, code: e && e.refuse ? e.message : "unavailable" }); }
  });
  // 1.99aot gifs: the Room Dock card's block list - site admins (pads.config), same-site fetch; unblock is audited
  const admin = (req, res) => {
    if (!req.user || !req.user.userId) { res.status(401).json({ ok: false, error: "signin" }); return false; }
    if (!require("./siteperms").can(req.user, "pads.config")) { res.status(403).json({ ok: false, error: "denied" }); return false; }
    return true;
  };
  app.post("/api/admin/gifs/unblock", addUser, require("express").json({ limit: "2kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!admin(req, res)) return;
    if (!guard.sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "security" });
    const b = req.body && typeof req.body === "object" ? req.body : {};
    try { res.json(await unblock(req.user, b.id, b.reason)); }
    catch (e) { if (!(e && e.refuse)) console.error("[gifs] unblock:", e && e.message); res.status(e && e.refuse ? e.status : 500).json({ ok: false, error: e && e.refuse ? e.message : "unavailable" }); }
  });
}
module.exports = { available, mode, partnerOn, freeOn, publicKey, ratingFor, freeGif, storedOf, sendOk, pageData, adminStatus, normalize, peek, picked,
  resolve, search, attach, register, init, isBlocked, blockedAny, itemBlocked, removed, keysOf, mediaKey, slugOfPage, lineMatcher, blockInTx, noteBlocked,
  blockQuota, noteBlockUse, blocks, unblock, noticeSeen, noteNotice, titleBad,
  KLIPY_API_BASE, KLIPY_BROWSER_API, MEDIA_HOSTS, PAGE_HOSTS, CSP_SOURCES, CONTENT_FILTER, RATINGS, RANK,
  CACHE_TTL_MS, CACHE_MAX, SEARCH_LIMIT, SEND_LIMIT, LOOKUP_LIMIT, LOOKUP_RETRY_MS, RESPONSE_MAX_BYTES, SRC_MAX, DIM_MAX, NOTICE_V, BLOCK_DAY_MAX,
  _reset: () => { cache.clear(); pending.clear(); retried.clear(); hits.clear(); blockHits.clear(); clock = () => Date.now(); }, _clock: fn => { clock = fn; },
  _resetStore: () => { BLOCKED = new Set(); MKS = new Set(); SEEN = new Set(); ready = null; loaded = false; } };
