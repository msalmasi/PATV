// feedgallery.js — 1.99fn: the feeds' Gallery view (Instagram style).
//
// Every feed (a pad's Feed tab, /feed, /feed/following, a profile's Posts) has a ☰ List / ▦ Gallery toggle by its sort
// bar (views/partials/feed-sort.ejs + feed-gallery.ejs; public/js/feed-gallery.js). Gallery is a grid of square tiles,
// three across on desktop AND phones, one per post with media: a picture (its thumbnail), a video or a captured clip
// (its poster frame), an AI picture. A tile shows a small corner icon for a video / clip / several pictures, and the
// votes on hover; NSFW tiles are blurred by the feed's usual rule (signed-out visitors never get NSFW at all - Hop's
// sfw filter; signed-in members see a blur unless they chose "always show", localStorage patvFeedNsfw). A tap opens
// Hop (hop.js) at that post, in that feed's sort. Text-only posts aren't in the grid; a quiet "N text posts hidden in
// gallery" line switches back to the list.
//
// Data: GET /api/feed/gallery?scope=&sort=&t=&cursor= -> {ok, scope, tiles, next, text: {n, more}}. Scopes are Hop's
// (all | following | p/<slug> | u/<username>) plus "u/<username>/profile" (the profile's "Profile only" view: just their
// profile pad). Paging is Hop's opaque offset cursor over the SAME media-only list (feedstore.list({media: true})) -
// the grid and Hop always agree on which posts are in it. `text` (first page only) counts the scope's text-only posts
// in the same sort window (feedstore.list({textOnly: true}), capped at TEXT_MAX).
//
// The chosen view is remembered per scope: per browser (localStorage patvFeedView, the client) and, signed in, per
// ACCOUNT (feed_view below - the feedseen.js pattern). On a page load ?view=list|gallery wins (a deep link), then the
// account's choice, then the browser's, then List.
//   feed_view   user_id, scope, view ('list' | 'gallery'), updated     PK (user_id, scope)
//   GET  /api/feed/view?scope=          -> {ok, view|null}                  (signed in)
//   POST /api/feed/view {scope, view}   -> {ok, view}  (same-site, JSON, X-Requested-With: fetch; signed in)
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const store = require("./feedstore");
const rooms = require("./rooms");
const hop = require("./hop");

const PAGE = 24;                        // a multiple of 3: whole rows
const TEXT_MAX = 999;
const VIEWS = new Set(["list", "gallery"]);
const SCOPE_RE = /^(?:all|following|p\/[A-Za-z0-9._:~\-]{1,64}|u\/[A-Za-z0-9._\-]{1,40}(?:\/profile)?)$/;
const SORTS = new Set(store.SORTS);
const TOPS = new Set(Object.keys(store.WINDOWS));
let NOW = () => Date.now();

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS feed_view (
        user_id TEXT NOT NULL, scope TEXT NOT NULL, view TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (user_id, scope))`);
    })().catch((e) => { console.error("[feedgallery] init:", e.message); ready = null; throw e; });
  }
  return ready;
}

const cleanScope = (s) => { const v = String(s == null ? "" : s).trim(); return SCOPE_RE.test(v) ? v : null; };
const cleanView = (v) => (VIEWS.has(String(v || "")) ? String(v) : null);

// ── per-account view prefs ──
async function getView(userId, scope) {
  const s = cleanScope(scope);
  if (!userId || !s) return null;
  await init();
  const r = (await getQuery("SELECT view FROM feed_view WHERE user_id = ? AND scope = ?", [String(userId), s]))[0];
  return r ? cleanView(r.view) : null;
}
async function setView(userId, scope, view) {
  const s = cleanScope(scope), v = cleanView(view);
  if (!userId || !s || !v) return null;
  await init();
  await runQuery(`INSERT INTO feed_view (user_id, scope, view, updated) VALUES (?, ?, ?, ?)
                  ON CONFLICT(user_id, scope) DO UPDATE SET view = excluded.view, updated = excluded.updated`, [String(userId), s, v, NOW()]);
  return v;
}

// ── scopes ──
/** Hop's scopes + "u/<name>/profile" (one member's profile pad). -> Hop's scope object (+ hopScope) or null */
async function resolveScope(raw) {
  const s = cleanScope(raw || "all");
  if (!s) return null;
  const m = /^u\/([A-Za-z0-9._\-]{1,40})\/profile$/.exec(s);
  if (m) {
    const S = await hop.resolveScope("u/" + m[1]);
    if (!S) return null;
    const pad = await rooms.profileOf(S.user.userId).catch(() => null);
    if (!pad) return null;
    return { ...S, kind: "profilepad", key: S.key + "/profile", R: pad, hopScope: S.key };
  }
  const S = await hop.resolveScope(s);
  return S ? { ...S, hopScope: S.key } : null;
}
function listArgs(S, viewer) {
  if (S.kind === "following") return { following: viewer ? viewer.userId : "-" };
  if (S.kind === "pad" || S.kind === "profilepad") return { room: S.R.id };
  if (S.kind === "user") return { author: S.user.userId };
  return {};
}

// ── tiles ──
/** A Hop item -> a gallery tile (or null: nothing to show). */
function tileOf(it, S, { sort, t }) {
  if (!it || !it.media || !it.media.length) return null;
  const m0 = it.media[0];
  const thumb = m0.kind === "image" ? m0.thumb || m0.src : m0.poster || null;
  const video = it.media.some((x) => x.kind === "video");
  // 1.99fp: a chat quote is a text tile - its first line (quotes.js, via Hop's item)
  const q0 = m0.kind === "quote" && m0.lines && m0.lines[0] ? { name: String(m0.lines[0].name || "").slice(0, 40), text: String(m0.lines[0].text || "").slice(0, 160), mic: !!m0.lines[0].mic } : null;
  return {
    id: it.id, url: it.url, title: it.title,
    hop: hop.hopHref(S.base, { post: it.id, sort, t: store.TIMED.has(sort) ? t : "" }),
    thumb, kind: m0.kind, video, clip: video && !!it.capture, ai: it.media.some((x) => x.ai),
    multi: it.media.length > 1 ? it.media.length : 0,
    score: Number(it.score) || 0, comments: Number(it.comments) || 0, nsfw: !!it.nsfw,
    author: it.author ? it.author.display || it.author.username : null,
    ...(q0 ? { quote: q0 } : {}),
  };
}

/** One page of tiles for `viewer` in scope S. -> {tiles, next, text: {n, more} | null} (text on the first page only) */
async function page(viewer, S, { sort = "hot", t = "week", cursor = null, limit = PAGE } = {}) {
  await store.init();
  const signed = !!(viewer && viewer.userId);
  if (S.kind === "following" && !signed) return { tiles: [], next: null, text: null, signin: true };
  const so = SORTS.has(sort) ? sort : "hot", tw = TOPS.has(t) ? t : "week";
  // Hop's filter exactly: media posts only; signed-out visitors never get NSFW
  // (an explicit offset means no pinned-first block: pins sit in the ranking, as in Hop)
  const base = { ...listArgs(S, viewer), sort: so, top: tw, viewer, sfw: !signed };
  const off = hop.decCursor(cursor);
  const n = Math.max(3, Math.min(48, Number(limit) || PAGE));
  const L = await store.list({ ...base, media: true, quotesToo: true, offset: off, limit: n });   // 1.99fp: + chat quotes, as in Hop
  const tiles = L.posts.map(hop.itemOf).map((it) => tileOf(it, S, { sort: so, t: tw })).filter(Boolean);
  let text = null;
  if (!cursor) {
    const T = await store.list({ ...base, textOnly: true, quotesToo: true, offset: 0, limit: TEXT_MAX, idsOnly: true });
    text = { n: T.ids.length, more: !!T.more };
  }
  return { tiles, next: L.more ? hop.encCursor(off + n) : null, text };
}

/**
 * What a feed page needs for its toggle + grid: the scope, the view the server can decide (?view= or the account's
 * choice; src "" = undecided, the browser's localStorage then decides) and, for Gallery, the first page of tiles.
 */
async function forFeed(viewer, scope, { query = {}, sort = "hot", t = "week" } = {}) {
  const key = cleanScope(scope);
  const out = { scope: key, view: "list", src: "", sort, t, tiles: null, next: null, text: null };
  if (!key) return out;
  const q = cleanView(query && query.view);
  if (q) { out.view = q; out.src = "query"; }
  else if (viewer && viewer.userId) {
    const v = await getView(viewer.userId, key).catch(() => null);
    if (v) { out.view = v; out.src = "account"; }
  }
  if (out.view === "gallery") {
    try {
      const S = await resolveScope(key);
      if (S) Object.assign(out, await page(viewer, S, { sort, t }));
    } catch (e) { console.error("[feedgallery] first page:", e.message); }
  }
  return out;
}

function register(app, { addUser }) {
  const guard = require("./middleware/authGuard");
  const viewerOf = async (req) => (req.user && req.user.userId ? store.account(req.user.userId) : null);
  app.get("/api/feed/gallery", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    res.set("X-Robots-Tag", "noindex");
    try {
      const S = await resolveScope(req.query.scope);
      if (!S) return res.status(404).json({ ok: false, error: "No such pad or member." });
      const q = req.query || {};
      const r = await page(await viewerOf(req), S, { sort: q.sort, t: q.t, cursor: q.cursor ? String(q.cursor).slice(0, 200) : null });
      if (r.signin) return res.status(401).json({ ok: false, error: "Sign in to see your Following feed." });
      res.json({ ok: true, scope: S.key, hopScope: S.hopScope, tiles: r.tiles, next: r.next, text: r.text });
    } catch (e) {
      console.error("[feedgallery] api:", e);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });
  app.get("/api/feed/view", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try { res.json({ ok: true, view: await getView(req.user.userId, req.query.scope) }); } catch (e) {
      console.error("[feedgallery] view get:", e.message);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });
  app.post("/api/feed/view", addUser, async (req, res) => {
    if (!guard.sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      const b = req.body || {};
      const v = await setView(req.user.userId, b.scope, b.view);
      if (!v) return res.status(400).json({ ok: false, error: "Bad scope or view." });
      res.json({ ok: true, view: v });
    } catch (e) {
      console.error("[feedgallery] view set:", e.message);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });
}

module.exports = { init, register, page, forFeed, resolveScope, tileOf, getView, setView, cleanScope, PAGE, TEXT_MAX, SCOPE_RE,
                   _setClock: (fn) => { NOW = fn; } };
