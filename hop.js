// hop.js — Hop (1.99eq): a full-screen, vertical media viewer for the feed. You hop from post to post: pictures,
// videos and clips one at a time, with the post's title, author, pad, votes and comment count over it and a tap
// through to the post. (Not "Reels": the name lives in HOP below - rename it there and everything follows.)
//
// Where it opens (public/js/hop.js is the viewer):
//   * tapping a picture or a video in a feed (a pad's Feed tab, /feed, /feed/following, a profile's Posts) opens Hop at
//     that post, over the page; hopping on continues through that same feed's media posts in its current sort;
//   * the "▶ Hop" button next to the Hot / New / Top sort bar opens it on the feed you're looking at;
//   * its own pages (the 1.99dv URL scheme): /hop (site-wide = All), /feed/following/hop, /p/<pad>/hop, /u/<user>/hop.
//     ?post=<id> starts at that post, ?sort= / ?t= as on the feeds. The viewer keeps the address on the post in view
//     (replaceState), so a shared link opens that post; Back / ✕ returns to where you were.
//
// Data: GET /api/hop?scope=all|following|p/<slug>|u/<username>&sort=&t=&cursor=&post= -> {items, next}. The cursor is
// opaque (an offset into the scope's media-only list - feedstore.list({media: true, offset})); the viewer drops any id
// it already has (a Hot list can shift between pages). The posts are exactly the ones that feed shows the viewer
// (deleted / hidden / removed left out, the same visibility); signed-out visitors never get NSFW posts, signed-in ones
// get them blurred behind a tap unless they chose "always show" (the feed's patvFeedNsfw setting).
"use strict";
const { getQuery } = require("./dbUtils");
const rooms = require("./rooms");
const store = require("./feedstore");
const fm = require("./feedmedia");

/** The viewer's name, in one place. */
const HOP = Object.freeze({ name: "Hop", icon: "🐸", button: "▶ Hop", hint: "Hop from post to post" });
const PAGE = 8;
const LOCATE_MAX = 200;           // ?post= is looked for in the first this-many media posts of the scope
const SORTS = new Set(store.SORTS);
const TOPS = new Set(Object.keys(store.WINDOWS));
const fileUrl = (f) => (f && fm.FILE_RE.test(f) ? "/media/f/" + f : null);

// ── scopes ──
/** "all" | "following" | "p/<slug>" | "u/<username>" -> {kind, key, R?, user?, base, back, label} or null (unknown pad / user) */
async function resolveScope(raw) {
  const s = String(raw || "all").trim().slice(0, 80);
  if (!s || s === "all") return { kind: "all", key: "all", base: "/hop", back: "/feed", label: "All" };
  if (s === "following") return { kind: "following", key: "following", base: "/feed/following/hop", back: "/feed/following", label: "Following" };
  let m = /^p\/([A-Za-z0-9._:~\-]{1,64})$/.exec(s);
  if (m) {
    const slug = m[1].toLowerCase();
    const R = (await rooms.bySlug(slug)) || (await require("./roomsweb").resolveRoom(slug).catch(() => null)) || (await rooms.get(m[1]));
    if (!R) return null;
    if (R.profile && R.profile.username) return resolveScope("u/" + R.profile.username);
    const P = require("./pads");
    return { kind: "pad", key: "p/" + P.padSlug(R), R, base: P.padHref(R) + "/hop", back: P.padHref(R), label: "p/" + P.padSlug(R) };
  }
  m = /^u\/([A-Za-z0-9._\-]{1,40})$/.exec(s);
  if (m) {
    const u = (await getQuery("SELECT userId, username FROM users WHERE lower(username) = lower(?) LIMIT 1", [m[1]]))[0];
    if (!u) return null;
    const P = require("./pads");
    return { kind: "user", key: "u/" + u.username, user: u, base: P.profileHref(u.username, "hop"), back: P.profileHref(u.username, "posts"), label: "u/" + u.username };
  }
  return null;
}
function listArgs(S, viewer) {
  if (S.kind === "following") return { following: viewer ? viewer.userId : "-" };
  if (S.kind === "pad") return { room: S.R.id };
  if (S.kind === "user") return { author: S.user.userId };
  return {};
}
/** A Hop address: <base>?post=<id>&sort=&t= (defaults left out). */
function hopHref(base, { post = null, sort = "hot", t = "" } = {}) {
  const q = new URLSearchParams();
  if (post) q.set("post", post);
  if (sort && sort !== "hot") q.set("sort", sort);
  if (t && store.TIMED.has(sort)) q.set("t", t);
  const s = q.toString();
  return base + (s ? "?" + s : "");
}
const encCursor = (o) => Buffer.from(JSON.stringify({ o })).toString("base64url");
function decCursor(c) {
  if (!c) return 0;
  try { const j = JSON.parse(Buffer.from(String(c).slice(0, 200), "base64url").toString("utf8")); return Math.max(0, Math.min(5000, Math.floor(Number(j.o)) || 0)); }
  catch (e) { return 0; }
}

// ── items ──
/** A decorated post -> the viewer's item, or null (no picture / video to show). */
const PL = require("./postlabel");
function itemOf(p) {
  const q = p.xpost ? (p.xpost.removed ? null : p.xpost.post) : p;
  if (!q || p.deleted) return null;
  const media = [];
  for (const im of q.images || []) { const src = fileUrl(im.file); if (src) media.push({ kind: "image", src, thumb: fileUrl(im.thumb), w: im.w || 0, h: im.h || 0, ai: !!im.ai }); }
  for (const v of q.video || []) { const src = fileUrl(v.file); if (src) media.push({ kind: "video", src, poster: fileUrl(v.poster), w: v.w || 0, h: v.h || 0, secs: v.secs || 0, ai: !!v.ai }); }
  // 1.99fp: a chat quote is a card of its lines (quotes.forPosts)
  if (!media.length && q.quote && q.quote.lines && q.quote.lines.length) {
    media.push({ kind: "quote", lines: q.quote.lines.slice(0, 12).map((l) => ({ name: l.name, text: l.text, mic: !!l.mic })), more: Math.max(0, q.quote.lines.length - 12) });
  }
  if (!media.length) return null;
  const home = (p.rooms || []).find((r) => !r.removed && !r.pending && !r.hidden) || (p.rooms || [])[0] || null;
  const pad = home ? { label: home.label || "p/" + home.slug, href: home.profile ? "/u/" + encodeURIComponent(home.profile) : "/p/" + encodeURIComponent(home.slug) } : null;
  return {
    // 1.99ex: the shared label (never empty, never a "no title" placeholder) + the author's photo and name style (feedstore.authors)
    id: p.id, url: p.url, title: PL.postLabel(p), titleFallback: PL.labelOf(p).fallback,
    author: { username: p.author.username, display: p.author.display, bot: !!p.author.bot, avatar: p.author.avatar || null, nameCss: p.author.nameCss || "" },
    pad, score: p.score, comments: p.comments, myVote: p.myVote || 0, mine: !!p.mine, nsfw: !!p.nsfw, created: p.created, media,
    capture: p.capture ? { room: p.capture.room.title } : null, xpost: !!p.xpost,
  };
}
function canSee(p, viewer) {
  if (!p || p.deleted) return false;
  const staff = store.isStaff(viewer);
  if (p.hidden && !staff && !p.mine) return false;
  return staff || p.mine || p.roomsAll.some((r) => !r.removed && !r.pending && !r.hidden);
}

/**
 * A page of Hop items for `viewer` in scope S. ?post= (no cursor): start at that post - found in the scope's first
 * LOCATE_MAX media posts, else shown first on its own (then the scope from the top). -> {items, next}
 */
async function page(viewer, S, { sort = "hot", t = "week", cursor = null, post = null, limit = PAGE } = {}) {
  await store.init();
  const signed = !!(viewer && viewer.userId);
  if (S.kind === "following" && !signed) return { items: [], next: null, signin: true };
  const base = { ...listArgs(S, viewer), sort: SORTS.has(sort) ? sort : "hot", top: TOPS.has(t) ? t : "week", viewer, media: true, quotesToo: true, sfw: !signed };
  let off = decCursor(cursor);
  let lead = null;
  if (post && !cursor && /^[A-Za-z0-9]{8,16}$/.test(String(post))) {
    const L = await store.list({ ...base, offset: 0, limit: LOCATE_MAX, idsOnly: true });
    const k = L.ids.indexOf(String(post));
    if (k >= 0) off = k;
    else {
      const p = await store.get(String(post), viewer);
      const it = canSee(p, viewer) && !(p.nsfw && !signed) ? itemOf(p) : null;
      if (it) lead = it;
    }
  }
  const n = Math.max(1, Math.min(20, Number(limit) || PAGE));
  const L = await store.list({ ...base, offset: off, limit: n });
  let items = L.posts.map(itemOf).filter(Boolean);
  if (lead) items = [lead].concat(items.filter((x) => x.id !== lead.id));
  return { items, next: L.more ? encCursor(off + n) : null };
}

function register(app, { addUser }) {
  if (app.locals) app.locals.HOP = HOP;          // views: the name (partials/hop-boot.ejs)
  const viewerOf = async (req) => (req.user && req.user.userId ? store.account(req.user.userId) : null);
  const qOf = (req) => {
    const q = req.query || {};
    const sort = SORTS.has(q.sort) ? q.sort : "hot";
    return { sort, t: TOPS.has(q.t) ? q.t : "week", post: q.post ? String(q.post).slice(0, 20) : null, cursor: q.cursor ? String(q.cursor).slice(0, 200) : null };
  };
  app.get("/api/hop", addUser, async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    res.set("X-Robots-Tag", "noindex");
    try {
      const S = await resolveScope(req.query.scope);
      if (!S) return res.status(404).json({ ok: false, error: "No such pad or member." });
      const o = qOf(req);
      const r = await page(await viewerOf(req), S, o);
      if (r.signin) return res.status(401).json({ ok: false, error: "Sign in to see your Following feed." });
      res.json({ ok: true, scope: S.key, base: S.base, items: r.items, next: r.next });
    } catch (e) {
      console.error("[hop] api:", e);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });
  const pageFor = (scopeOf) => async (req, res, next) => {
    try {
      const S = await resolveScope(scopeOf(req));
      if (!S) return next();
      const viewer = await viewerOf(req);
      if (S.kind === "following" && !viewer) return res.redirect(302, "/login?next=" + encodeURIComponent(req.originalUrl || "/feed/following/hop"));
      const o = qOf(req);
      const first = await page(viewer, S, o);
      res.set("X-Robots-Tag", "noindex");
      res.set("Cache-Control", "private, no-store");
      res.render("hop", { user: viewer ? viewer.username : null, HOP, scope: S.key, base: S.base, back: S.back, label: S.label, sort: o.sort, t: o.t,
                          post: o.post, first: { items: first.items, next: first.next }, signed: !!viewer });
    } catch (e) { next(e); }
  };
  app.get("/hop", addUser, pageFor(() => "all"));
  app.get("/feed/following/hop", addUser, pageFor(() => "following"));
  app.get("/p/:slug/hop", addUser, pageFor((req) => "p/" + String(req.params.slug || "")));
  app.get("/u/:username/hop", addUser, pageFor((req) => "u/" + String(req.params.username || "")));
}

module.exports = { HOP, register, resolveScope, page, itemOf, hopHref, encCursor, decCursor, PAGE };
