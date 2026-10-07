// feedweb.js — the feed's pages and APIs (1.99bv): /feed (posts + Pepe's clips & snaps, room
// filter), a post and its comments (1.99dv: /p/<pad>/posts/<id>/<slug> or /u/<username>/posts/<id>/<slug>;
// the old /feed/p/<id> 301s there), /feed/admin (reports, settings, bans), the room page's Feed section
// (bridge.js calls roomFeed), chunked uploads, link previews and the files (1.99dv: /media/f/<file>; the old
// /feed/f/<file> 301s there).
//
// Every write is JSON with X-Requested-With: fetch from this site (sameSite) - a cross-site form or
// image tag can't send that. Data and rules: feedstore.js. Upload pipeline: feedmedia.js. Link
// previews: linkpreview.js.
"use strict";
const fs = require("fs");
const express = require("express");
const { runQuery, getQuery } = require("./dbUtils");
const store = require("./feedstore");
const media = require("./feedmedia");
const lp = require("./linkpreview");
const rooms = require("./rooms");
const embeds = require("./stageembed");
const audit = require("./contentaudit");
const terms = require("./terms");

const STAGING = !!process.env.STAGING;
const SITE = () => process.env.SITE_URL || (STAGING ? "https://staging.publicaccess.tv" : "https://publicaccess.tv");

// ── text rendering: escape everything, then turn bare http(s) links into safe anchors ──
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"'`]/g, (c) => ESC[c]);
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]{2,2000}/gi;
// 1.99ck: the plain-text parts also get p/<slug> pad links (pads.js; known pads only, never inside a URL)
// 1.99df: and u/<username> profile links
const padText = (t) => { const P = require("./pads"); return P.userRefs(P.padRefs(esc(t))); };
function linkify(text) {
  const s = String(text == null ? "" : text);
  let out = "", last = 0, m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(s))) {
    let url = m[0];
    const trail = url.match(/[).,;:!?\]}]+$/);        // "see (https://x.y/z)." - keep the punctuation outside
    if (trail) url = url.slice(0, -trail[0].length);
    out += padText(s.slice(last, m.index));
    let ok = false;
    try { const u = new URL(url); ok = u.protocol === "http:" || u.protocol === "https:"; } catch (e) { ok = false; }
    out += ok ? `<a href="${esc(url)}" rel="nofollow noopener noreferrer ugc" target="_blank">${esc(url.length > 80 ? url.slice(0, 77) + "…" : url)}</a>` : esc(url);
    last = m.index + url.length;
    URL_RE.lastIndex = last;
  }
  return out + padText(s.slice(last));
}
const body = (text) => linkify(text).replace(/\n/g, "<br>");
function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  if (s < 30 * 86400) return Math.floor(s / 86400) + "d";
  return new Date(ms).toISOString().slice(0, 10);
}
const fileUrl = (name) => (name && media.FILE_RE.test(name) ? "/media/f/" + name : null);     // 1.99dv: was /feed/f/

// ── one icon set for every post / comment control (24-unit grid, stroke = currentColor) ──
const ICON_PATHS = {
  up: '<path d="M12 4 4.5 12.5H9V20h6v-7.5h4.5Z"/>',
  down: '<path d="M12 20 4.5 11.5H9V4h6v7.5h4.5Z"/>',
  comment: '<path d="M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4 19.5l1.4-4.4A7.5 7.5 0 1 1 20 11.5Z"/>',
  share: '<path d="M12 15V3.5M7.5 8 12 3.5 16.5 8"/><path d="M5 12.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-6.5"/>',
  more: '<circle cx="5.5" cy="12" r="1.4" class="f"/><circle cx="12" cy="12" r="1.4" class="f"/><circle cx="18.5" cy="12" r="1.4" class="f"/>',
  edit: '<path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17Z"/><path d="m14 8 3 3"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M9 7V4.5h6V7"/><path d="m6 7 1 13h10l1-13"/>',
  flag: '<path d="M5 21V4M5 4h12l-2.5 4.5L17 13H5"/>',
  nsfw: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
  hide: '<path d="M3 12s3.5-6.5 9-6.5S21 12 21 12s-3.5 6.5-9 6.5S3 12 3 12Z"/><circle cx="12" cy="12" r="2.5"/><path d="M4 4l16 16"/>',
  show: '<path d="M3 12s3.5-6.5 9-6.5S21 12 21 12s-3.5 6.5-9 6.5S3 12 3 12Z"/><circle cx="12" cy="12" r="2.5"/>',
  remove: '<circle cx="12" cy="12" r="8.5"/><path d="M8 12h8"/>',
  restore: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  reply: '<path d="M10 8V4.5L3.5 11 10 17.5V14c5 0 8 1.5 10.5 5-.8-5.5-4-10.2-10.5-11Z"/>',
  hot: '<path d="M12 21c3.9 0 6.5-2.6 6.5-6.2 0-3.6-2.6-5.3-3.8-8.3-1 1.9-2 2.7-3 2.7.2-2.6-.8-4.8-2.7-6.2.1 3.7-4.5 6.2-4.5 11.8C4.5 18.4 8.1 21 12 21Z"/>',
  new: '<path d="M12 3.5 14 10l6.5 2-6.5 2-2 6.5-2-6.5-6.5-2 6.5-2Z"/>',
  top: '<path d="M4 20h16M7 16.5V12M12 16.5V6.5M17 16.5V9.5"/>',
  controversial: '<path d="M13.5 3 5 13.5h6L10 21l9-10.5h-6Z"/>',
  rising: '<path d="m3.5 17 6-6 4 4 7-7.5"/><path d="M15 7.5h5.5V13"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  back: '<path d="M15 5 8 12l7 7"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/>',
  unlock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 6.8-1.2"/>',
  pin: '<path d="M9 3.5h6l-1 6 3.5 3.5h-11L10 9.5Z"/><path d="M12 13v7.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  shield: '<path d="M12 3 5 6v5.5c0 4.5 3 8 7 9.5 4-1.5 7-5 7-9.5V6Z"/>',
  xpost: '<path d="M4 8.5h12.5L13 5M20 15.5H7.5L11 19"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>',
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.6-3.3 2.8-5 5.5-5s4.9 1.7 5.5 5"/><path d="M15.5 5.6a3 3 0 0 1 0 5.8M17.5 14.2c1.6.6 2.6 2.2 3 4.8"/>',
  door: '<path d="M14 4H6v16h8"/><path d="M10 12h10M17 9l3 3-3 3"/>',
};
/** Inline SVG (a fixed string per name - nothing user-supplied goes in). */
function icon(name, cls = "") {
  const p = ICON_PATHS[name];
  if (!p) return "";
  return `<svg class="ic${cls ? " " + cls : ""}" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
}
/** A stable hue (0-359) for an author's initial bubble. */
function hue(s) {
  let h = 0;
  for (const ch of String(s || "")) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
}
const initial = (s) => (Array.from(String(s || "?").replace(/^[^\p{L}\p{N}]+/u, ""))[0] || "?").toUpperCase();
/** Compact number: 999, 1.2k, 15k, 1.1m. */
function num(n) {
  const v = Number(n) || 0, a = Math.abs(v);
  if (a < 1000) return String(v);
  if (a < 10000) return (v / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  if (a < 1e6) return Math.round(v / 1000) + "k";
  return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "m";
}
const SORT_LABELS = { hot: "Hot", new: "New", top: "Top", controversial: "Controversial", rising: "Rising" };
const WINDOW_LABELS = { hour: "Past hour", day: "Today", week: "This week", month: "This month", year: "This year", all: "All time" };
const CSORT_LABELS = { best: "Best", top: "Top", new: "New", controversial: "Controversial" };
/**
 * 1.99ci: a feed address. where: "all" | "following" | a pad slug; params: sort, t, p, by (empty
 * values and the defaults are left out). -> "/feed", "/feed/following", "/p/<slug>?sort=new" (1.99ck: a pad's
 * feed lives on its pad page)
 */
function feedUrl(where, params = {}) {
  const path = !where || where === "all" ? "/feed" : where === "following" ? "/feed/following" : "/p/" + encodeURIComponent(where);
  const qs = new URLSearchParams();
  for (const k of ["sort", "t", "p", "by"]) {
    const v = params[k];
    if (v === undefined || v === null || v === "" || (k === "sort" && v === "hot") || (k === "p" && Number(v) <= 1)) continue;
    qs.set(k, String(v));
  }
  const s = qs.toString();
  return path + (s ? "?" + s : "");
}
/** A community's badge: the frog for Pepe's (house) rooms, a sofa for the site's own communities, else its initial. */
const cBadge = (c) => (c && c.community ? "🛋️" : c && c.house ? "🐸" : initial(c && c.title));
/** 1.99x: a pad's platform badge html ("🐸 Camfrog Pad" / "🌐 Site Pad"; compact = the icon only) - pads.js */
const padBadge = (c, opts) => require("./pads").padBadge(c, opts);
const fx = { esc, body, ago, fileUrl, fmtSecs: media.fmtSecs, icon, hue, initial, num, feedUrl, cBadge, padBadge, SORT_LABELS, WINDOW_LABELS, CSORT_LABELS,
             SORTS: store.SORTS, WINDOWS: Object.keys(store.WINDOWS), TIMED: store.TIMED, CSORTS: store.CSORTS };

// ── captures (Pepe's !snap / !clip, media.js) for a room: signed-in only, like /feed always was.
// 1.99bz: stories.js owns them (privacy: anonymous subjects, missing files skipped) ──
const stories = require("./stories");
const follows = require("./follows");
async function captures(roomId, limit = 12) { return stories.captures(roomId, limit, { windowMs: stories.WINDOW_MS }); }

async function viewerOf(req) {
  if (!req.user || !req.user.userId) return null;
  const a = await store.account(req.user.userId);
  return a ? { ...a, display: a.displayname || a.username } : null;
}
const SORTS = new Set(store.SORTS);
const TOPS = new Set(Object.keys(store.WINDOWS));

/**
 * Everything the composer needs (limits, what this viewer may do) and (1.99ci) the communities they can post
 * in: exactly one is picked; `roomId` (a room page / a community view) is the default when they may post there.
 */
async function composerFor(viewer, roomId) {
  if (!viewer) return null;
  const C = store.config();
  // 1.99bz: announce = the room owner lets Pepe announce new posts there (the author then gets a per-post checkbox)
  const list = await store.communities(viewer);
  // 1.99cu: ann = store.announceState {ok, code, why, manage}: the checkbox is always shown for the picked pad,
  //         enabled + ticked when ok, greyed out with the reason otherwise
  const all = await Promise.all(list.filter((r) => r.canPost).map(async (r) => {
    const ann = await store.announceState(r.id, viewer);
    // 1.99dc: "Posting in p/x: read the rules" - the pad's own rules (n), or Padiquette (n = 0)
    const own = await require("./padrules").get(r.id).catch(() => null);
    return { id: r.id, slug: r.slug, title: r.title, followers: r.followers, community: r.community, platform: r.platform, house: r.house,
             announce: ann.ok, ann, rules: own ? own.rules.length : 0 };
  }));
  const refusal = await store.postRefusal(viewer, []);
  const mediaRefusal = refusal ? refusal : await store.postRefusal(viewer, [], { media: true });
  // 1.99df: "Your profile (u/<username>)" heads the picker - only ever the viewer's own; its value "u/<username>" makes
  // the profile pad on the first post (feedstore.profileKey). Profiles follow Padiquette and have no Camfrog room.
  if (!refusal) {
    const P = rooms.profileOfCached(viewer.userId);
    all.unshift({ id: "u/" + viewer.username, slug: P ? P.slug : "u-" + rooms.slugify(viewer.username), title: "Your profile", label: "u/" + viewer.username,
                  profile: true, platform: "profile", followers: 0, community: true, house: false, announce: false, ann: null, rules: 0 });
  }
  if (roomId === "profile") roomId = refusal ? null : "u/" + viewer.username;
  const here = roomId ? (all.find((r) => r.id === roomId) ? { ...all.find((r) => r.id === roomId), canPost: true } : list.find((r) => r.id === roomId)) : null;
  const prices = { post: C.price_post, link: C.price_link, image: C.price_image, audio: C.price_audio, video: C.price_video };
  // 1.99cc: "By posting you agree to the Terms" - and a one-time tick box until this account has accepted the current version
  // 1.99cf: only while the admin switch terms_enforced is on (default off: no line, no tick box)
  const termsNeeded = await terms.needs(viewer.userId).catch(() => false);
  // 1.99di: "✨ Generate" (aigen.js) - Pepe's !imagine / !video price for each pad the viewer may post in (its Camfrog
  // room's price, else the global one); same eligibility as uploads (mediaRefusal)
  const aigen = require("./aigen");
  const aiPrices = {}, refPrices = {};
  for (const r of all) aiPrices[r.id] = await aigen.pricesFor(r.id).catch(() => ({ image: aigen.DEFAULT_PRICES.imagine, video: aigen.DEFAULT_PRICES.video }));
  // 1.99dn: + a reference picture = Pepe's -cam surcharge (the pad's room's, else global)
  for (const r of all) refPrices[r.id] = await aigen.refPriceFor(r.id).catch(() => aigen.DEFAULT_SURCHARGE);
  return { user: viewer.username, terms: { enforced: terms.enforced(), needed: termsNeeded, version: terms.VERSION }, rooms: all,
           room: here && here.canPost ? here.id : null, roomRefusal: here && !here.canPost ? here.refusal : null, roomTitle: here ? here.title : null,
           refusal: refusal ? refusal.message : (all.length ? null : "There's no pad you can post in right now."), mediaRefusal: mediaRefusal ? mediaRefusal.message : null,
           caps: { image: C.max_image_mb, audio: C.max_audio_mb, video: C.max_video_mb, audioSecs: C.max_audio_secs, videoSecs: C.max_video_secs },
           prices, paid: Object.values(prices).some((p) => p > 0), maxImages: store.MAX_IMAGES, maxRooms: store.MAX_ROOMS, chunk: media.CHUNK,
           aigen: { prices: aiPrices, global: await aigen.pricesFor(null).catch(() => null), eta: aigen.ETA, promptMax: aigen.PROMPT_MAX,
                    refPrices, refGlobal: await aigen.refPriceFor(null).catch(() => aigen.DEFAULT_SURCHARGE),
                    // 1.99dr: pads with a Camfrog room - the panel's "📷 From a cam in this room" shows for these
                    camPads: all.filter((r) => aigen.camfrogRoomOf(r.id)).map((r) => r.id) } };
}

/** The room page's Feed section (bridge.js /rooms/:slug). */
async function roomFeed(roomId, reqUser, query = {}) {
  await store.init();
  const viewer = reqUser && reqUser.userId ? await viewerOf({ user: reqUser }) : null;
  const sort = SORTS.has(query.fsort) ? query.fsort : "new";
  const top = TOPS.has(query.ft) ? query.ft : "week";
  const page = Math.max(1, parseInt(query.fp, 10) || 1);
  const L = await store.list({ room: roomId, sort, top, page, viewer, limit: 10 });
  const mod = viewer ? { admin: store.isStaff(viewer), owner: await rooms.canManage(viewer, roomId) } : { admin: false, owner: false };
  return {
    room: roomId, sort, top, page, posts: L.posts, more: L.more, viewer, mod,
    slug: (rooms.getCached(roomId) || {}).slug || rooms.slugify(roomId),
    caps: viewer ? await captures(roomId, 24) : [],
    // 1.99bz: signed-out viewers get the room's story circle (sign-in prompt), never the pictures
    storyRooms: viewer ? [] : await stories.forViewer(null, { room: roomId }),
    follow: { following: viewer ? await follows.isFollowing(viewer.userId, "room", roomId) : false, followers: await follows.followers("room", roomId) },
    composer: await composerFor(viewer, roomId),
    rules: await require("./padrules").effective(roomId),                   // 1.99dc: the pad page's Rules card
    mention: mod.owner ? await store.mentionOn(roomId) : null,
    queue: mod.owner || mod.admin ? (await store.roomReports(roomId)).length + (await store.roomPending(roomId, viewer)).length : 0,
  };
}

function register(app, { addUser, isBotToken }) {
  const sameSite = (req) => {
    const host = req.get("host"), src = req.get("origin") || req.get("referer");
    if (!src || !host) return true;
    try { return new URL(src).host === host; } catch (e) { return false; }
  };
  // every state change: signed in + JSON (or a chunk) + X-Requested-With: fetch + same site
  const guard = (raw) => (req, res, next) => {
    if (!sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (!raw && !req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    next();
  };
  const fail = (res, e) => {
    const st = e && e.status && e.status < 500 ? e.status : 500;
    if (st === 500) console.error("[feed]", e);
    res.status(st).json({ ok: false, error: st === 500 ? "Something went wrong." : e.message });
  };
  const viewOpts = (req) => ({ host: req.hostname || "publicaccess.tv" });

  // ── pages ──
  // URL scheme: /feed = All (every pad), /feed/following; one pad's feed is on its pad page /p/<slug>
  // (1.99ck; the old /feed/c/<slug> 301s there - pads.js). Sort, time window, page and ?by= stay query
  // strings. The old ?tab= / ?room= links redirect (301).
  app.get("/feed", addUser, async (req, res, next) => {
    try {
      const q = req.query || {};
      if (q.tab || q.room) {
        // 1.99bz: no separate "Clips & snaps" tab any more (captures are the story strip); 1.99ci: ?room= and ?tab=following are paths
        let path = "/feed";
        if (q.tab === "following") path = "/feed/following";
        else if (q.room) {
          const raw = String(q.room).slice(0, 128);
          const R = (await rooms.get(raw)) || (await require("./roomsweb").resolveRoom(raw));
          path = R ? require("./pads").padHref(R) : "/p/" + encodeURIComponent(raw);
        }
        const keep = new URLSearchParams();
        for (const k of ["sort", "t", "p", "by"]) if (q[k] && !(k === "by" && path !== "/feed")) keep.set(k, String(q[k]).slice(0, 64));
        const qs = keep.toString();
        return res.redirect(301, path + (qs ? "?" + qs : ""));
      }
      await feedPage(req, res, { mode: "all" });
    } catch (e) { next(e); }
  });
  app.get("/feed/following", addUser, (req, res) => feedPage(req, res, { mode: "following" }));

  // ── 1.99ec: the create-post page ──
  // /submit (pick any pad) and /p/<pad>/submit (that pad preselected; the navbar's "✏️ Post" goes there from a pad's
  // pages). /submit?pad=<slug> 302s to /p/<slug>/submit (one address per pad). An unknown pad is a 404; signed out ->
  // /login?next=<this page>. The full composer, open (no "Create post" bar); posting lands on the new post's canonical
  // address (feed-composer.js: off a pad / profile page it opens d.url).
  app.get("/submit", addUser, async (req, res, next) => {
    try {
      const pad = String((req.query || {}).pad || "").trim().toLowerCase().slice(0, 64);
      if (pad) return res.redirect(302, "/p/" + encodeURIComponent(pad) + "/submit");
      await submitPage(req, res, null);
    } catch (e) { next(e); }
  });
  app.get("/p/:slug/submit", addUser, async (req, res, next) => {
    try {
      const raw = String(req.params.slug || "").toLowerCase().slice(0, 64);
      const R = (await rooms.bySlug(raw)) || (await require("./roomsweb").resolveRoom(raw));
      if (!R) {
        return res.status(404).render("notFound", { user: req.user ? req.user.username : null, heading: "No such pad",
          message: "There's no pad at p/" + raw + " to post in.", title: "Pad not found" });
      }
      await submitPage(req, res, R);
    } catch (e) { next(e); }
  });
  async function submitPage(req, res, R) {
    await store.init();
    const here = R ? require("./pads").padHref(R, "submit") : "/submit";
    if (!req.user || !req.user.userId) return res.redirect(302, "/login?next=" + encodeURIComponent(here));
    const viewer = await viewerOf(req);
    if (!viewer) return res.redirect(302, "/login?next=" + encodeURIComponent(here));
    res.set("X-Robots-Tag", "noindex");
    res.set("Cache-Control", "private, no-store");
    const pad = R ? { id: R.id, slug: require("./pads").padSlug(R) || R.slug, title: R.title || R.name || R.slug, href: require("./pads").padHref(R) } : null;
    res.render("submit", { user: viewer.username, viewer, pad, composer: await composerFor(viewer, R ? R.id : null), here, fx });
  }

  async function feedPage(req, res, { mode, room: R = null }) {
    try {
      await store.init();
      const viewer = await viewerOf(req);
      const sort = SORTS.has(req.query.sort) ? req.query.sort : "hot";
      const top = TOPS.has(req.query.t) ? req.query.t : "week";
      const page = Math.max(1, parseInt(req.query.p, 10) || 1);
      const roomList = await rooms.list();
      let author = null;
      if (req.query.by && mode === "all") author = await rooms.findUser(String(req.query.by).slice(0, 60));
      let L = { posts: [], more: false };
      let follow = null;
      if (mode === "following") {
        if (viewer) {
          L = await store.list({ following: viewer.userId, sort, page, top, viewer });
          follow = { ...(await follows.lists(viewer.userId)), prefs: await follows.prefs(viewer.userId) };
        }
      } else {
        L = await store.list({ room: R ? R.id : null, author: !R && author ? author.userId : null, sort, page, top, viewer });
      }
      // the community bar: All, Following, then every community (icon, followers, posts)
      const comms = await store.communities(viewer);
      let header = null;
      if (R) {
        const c = comms.find((x) => x.id === R.id) || { followers: 0, posts: 0 };
        header = { id: R.id, slug: R.slug, title: R.title, description: R.description || "", house: !!R.house, community: !!R.community, platform: R.platform || rooms.platformOf(R.id),
                   owner: R.owner ? (R.owner.display || R.owner.username) : null, ownerUser: R.owner ? R.owner.username : null,
                   followers: c.followers, posts: c.posts, following: viewer ? await follows.isFollowing(viewer.userId, "room", R.id) : false,
                   roomHref: require("./pads").padHref(R), mod: viewer ? await rooms.canManage(viewer, R.id) : false };
      }
      // the story strip: one room's captures as thumbnails, or a circle per room with fresh ones
      const story = {
        room: R ? R.id : null,
        caps: viewer && R ? await captures(R.id, 24) : [],
        rooms: viewer && R ? [] : await stories.forViewer(viewer, { room: R ? R.id : null }),
        signed: !!viewer,
      };
      res.set("X-Robots-Tag", "noindex");
      res.render("feed", {
        user: viewer ? viewer.username : null, viewer, mode, tab: mode === "following" ? "following" : "posts", sort, top, page, room: R, header, author, story, follow,
        rooms: roomList, communities: comms, posts: L.posts, more: L.more, fx, embeds, host: viewOpts(req).host,
        authorFollow: author && viewer && author.userId !== viewer.userId ? await follows.isFollowing(viewer.userId, "user", author.userId) : null,
        composer: await composerFor(viewer, R ? R.id : null),
        // 1.99df: + the viewer's own profile pad (not in the pad list); staff: every profile pad of the posts on this page
        modRooms: viewer ? new Set((await Promise.all(roomList.concat(L.posts.flatMap((p) => p.roomsAll.filter((r) => r.profile)))
          .map(async (x) => ((await rooms.canManage(viewer, x.id)) ? x.id : null)))).filter(Boolean)) : new Set(),
      });
    } catch (e) {
      console.error("[feed] /feed:", e);
      res.status(500).send("Something went wrong.");
    }
  }

  // 1.99ci: the communities (pickers in the composer and the crosspost dialog): canPost per viewer
  app.get("/api/feed/communities", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const viewer = await viewerOf(req);
      const list = await store.communities(viewer);
      // ?post=<id>: mark where that post (its original, for a crosspost) already is - the crosspost dialog greys those out
      const here = new Set();
      if (req.query.post) {
        let o = await store.getRow(String(req.query.post));
        if (o && o.crosspost_of) o = await store.getRow(o.crosspost_of);
        if (o) {
          const rows = await getQuery(`SELECT pr.room_id FROM feed_post_rooms pr JOIN feed_posts x ON x.id = pr.post_id
                                       WHERE (x.id = ? OR (x.crosspost_of = ? AND x.deleted_at IS NULL)) AND pr.removed_at IS NULL`, [o.id, o.id]);
          for (const r of rows) here.add(r.room_id);
        }
      }
      // 1.99cu: ann = can Pepe announce a crosspost there ({ok, code, why, manage}; signed in only)
      const anns = new Map();
      if (viewer) for (const c of list) if (c.canPost) anns.set(c.id, await store.announceState(c.id, viewer));
      const out = list.map((c) => ({ id: c.id, slug: c.slug, title: c.title, description: c.description, followers: c.followers, label: "p/" + c.slug,
                                     posts: c.posts, canPost: c.canPost, refusal: c.refusal, community: c.community, platform: c.platform, house: c.house, here: here.has(c.id),
                                     ann: anns.get(c.id) || null }));
      // 1.99df: "Your profile" first (share to profile) - the viewer's own only, made on the first crosspost
      if (viewer) {
        const P = rooms.profileOfCached(viewer.userId);
        const refusal = await store.postRefusal(viewer, []);
        out.unshift({ id: "u/" + viewer.username, slug: P ? P.slug : "u-" + rooms.slugify(viewer.username), title: "Your profile", label: "u/" + viewer.username,
                      description: "", followers: 0, posts: 0, canPost: !refusal, refusal: refusal ? refusal.message : null, community: true, platform: "profile", house: false,
                      profile: true, here: !!(P && here.has(P.id)), ann: null });
      }
      res.json({ ok: true, crosspostMax: store.config().crosspost_max_pads, communities: out });
    } catch (e) { fail(res, e); }
  });

  // 1.99dv: a post's address is /p/<pad>/posts/<id>/<title-slug> (its first live pad) or /u/<username>/posts/<id>/<title-slug>
  // (a profile post) - pads.postHref. The id alone resolves: any other pad / username / slug, no slug, and the old
  // /feed/p/<id>, 301 to the canonical address with the query string kept (the browser keeps the #anchor). A post the
  // viewer may not see 404s on every address, before any redirect (its canonical address carries its title).
  app.get(["/feed/p/:id", "/p/:pad/posts/:id", "/p/:pad/posts/:id/:slug", "/u/:username/posts/:id", "/u/:username/posts/:id/:slug"], addUser, async (req, res, next) => {
    if (!/^[A-Za-z0-9]{8,16}$/.test(String(req.params.id || ""))) return next();
    try {
      const viewer = await viewerOf(req);
      const p = await store.get(req.params.id, viewer, { detail: true });
      const staff = store.isStaff(viewer);
      const modRooms = new Set();
      if (p && viewer) for (const r of p.roomsAll) if (await rooms.canManage(viewer, r.id)) modRooms.add(r.id);
      // only waiting for approval / hidden / taken out everywhere it was posted: its author, those rooms' owners and staff
      const shownSomewhere = p && p.roomsAll.some((r) => !r.removed && !r.pending && !r.hidden);
      if (!p || (p.deleted && !staff) || (p.hidden && !staff && !p.mine) || (!shownSomewhere && !staff && !p.mine && !modRooms.size)) {
        return res.status(404).render("notFound", { user: viewer ? viewer.username : null, heading: "Post not found",
          message: "It was deleted, or it never existed.", title: "Post not found" });
      }
      if ((req.baseUrl + req.path).replace(/\/+$/, "") !== p.url) return res.redirect(301, p.url + require("./pads").qsOf(req));
      const csort = store.cleanCSort(req.query.csort);
      const C = await store.comments(p.id, viewer, csort);
      const desc = (p.nsfw ? "NSFW post" : (p.body || (p.link && p.link.title) || "")).replace(/\s+/g, " ").slice(0, 180) || "A post on the PATV feed";
      res.locals.og = { title: (p.nsfw ? "[NSFW] " : "") + (p.title || (p.link && p.link.title) || `Post by ${p.author.display}`).slice(0, 90) + " — PATV feed",
                        description: desc, image: res.locals.ogBase + "/og/page.png?t=" + encodeURIComponent((p.title || "PATV feed").slice(0, 60)),
                        url: res.locals.ogBase + p.url };
      if (p.nsfw || p.hidden) res.set("X-Robots-Tag", "noindex");
      res.render("post", { user: viewer ? viewer.username : null, viewer, p, comments: C, csort, fx, embeds, host: viewOpts(req).host, modRooms, canLock: await store.canLock(viewer, p.id),
                           reasons: store.REASONS, staff, termsEnforced: terms.enforced(), termsNeeded: viewer ? await terms.needs(viewer.userId).catch(() => false) : false,
                           pepeMuted: await require("./pepefeed").isMuted(p.id).catch(() => false) });
    } catch (e) {
      console.error("[feed] post page:", e);
      res.status(500).send("Something went wrong.");
    }
  });

  app.get("/feed/admin", addUser, async (req, res) => {
    const viewer = await viewerOf(req);
    if (!store.isStaff(viewer)) return res.status(403).render("notFound", { user: viewer ? viewer.username : null, heading: "Admins only", message: "This page is for site staff.", title: "Admins only" });
    await store.init();
    let used = 0, free = Infinity;
    try { used = await store.usedBytes(null); free = media.diskFreeBytes(); } catch (e) { /* shown as unknown */ }
    res.set("X-Robots-Tag", "noindex");
    const isAdmin = audit.isAdmin(viewer);
    res.set("Cache-Control", "no-store");
    res.render("feedAdmin", { user: viewer.username, viewer, C: store.config(), D: store.DEFAULTS, reports: await store.reports(), bans: await store.bans(),
                              used, free, dir: media.dir(), fx, roomsById: new Map((await rooms.list()).map((r) => [r.id, r])),
                              userReports: await store.userReports(), isAdmin, viewLog: isAdmin ? await audit.viewLog(30) : [],
                              dmReports: isAdmin ? await require("./messages").reportQueue().catch((e) => { console.error("[feed] dm reports:", e.message); return []; }) : [],
                              termsPH: terms.placeholders(), termsLive: terms.enforced(),
                              pepe: await require("./pepefeed").adminView().catch((e) => { console.error("[feed] pepe admin view:", e.message); return null; }),
                              // 1.99dc: Pepe's automod - global caps, the All scope, recent calls everywhere
                              automod: await (async () => { const AM = require("./feedautomod");
                                return { global: await AM.globalCaps(), main: await AM.settings(""), used: await AM.usage(), list: await AM.adminList(60), AM }; })()
                                .catch((e) => { console.error("[feed] automod admin view:", e.message); return null; }),
                              PF: require("./pepefeed") });
  });

  // ── files ──
  // 1.99dv: uploaded / processed media live under /media/ - a post's files at /media/f/<file> (captures stay
  // /media/<id>, DM pictures stay /messages/media/<file>: private, checked per conversation). The old /feed/f/<file>
  // 301s (embeds, OG images, saved drafts and Pepe's fetches all follow a redirect; the file's own rules run at /media/f/).
  app.get("/feed/f/:file", (req, res) => res.redirect(301, "/media/f/" + encodeURIComponent(String(req.params.file || "")) + require("./pads").qsOf(req)));
  app.get("/media/f/:file", addUser, async (req, res) => {
    const name = String(req.params.file || "");
    const p = media.filePath(name);
    if (!p) return res.status(404).end();
    try {
      await store.init();
      const a = (await getQuery(`SELECT a.*, p.deleted_at, p.hidden_at, p.nsfw, p.nsfw_admin, p.author_id FROM feed_attachments a
                                 LEFT JOIN feed_posts p ON p.id = a.post_id WHERE (a.file = ? OR a.thumb = ? OR a.poster = ?) AND a.state = 'ready' LIMIT 1`, [name, name, name]))[0];
      if (!a) return res.status(404).end();
      const uid = req.user && req.user.userId;
      const staff = store.isStaff(req.user);
      if (!a.post_id && !(uid && uid === a.owner_id) && !staff) return res.status(404).end();
      if (a.post_id && (a.deleted_at || a.hidden_at) && !staff && !(a.hidden_at && !a.deleted_at && uid === a.author_id)) return res.status(404).end();
      const nsfw = a.nsfw_admin === 0 || a.nsfw_admin === 1 ? !!a.nsfw_admin : !!a.nsfw;
      if (nsfw && !uid) return res.status(403).end();
      const ct = name.endsWith(".webp") ? "image/webp" : name.endsWith(".m4a") ? "audio/mp4" : "video/mp4";
      const ext = name.split(".").pop();
      res.set({
        "Content-Type": ct,
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `inline; filename="patv-${a.id}.${ext}"`,
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox",
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Robots-Tag": "noindex",
        "Cache-Control": nsfw || !a.post_id ? "private, max-age=600" : "public, max-age=3600",
      });
      res.sendFile(p, { acceptRanges: true, headers: { "Content-Type": ct } }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
    } catch (e) {
      console.error("[feed] file:", e.message);
      if (!res.headersSent) res.status(500).end();
    }
  });

  // ── uploads (chunked) ──
  app.post("/api/feed/uploads", addUser, guard(false), async (req, res) => {
    try {
      await store.init();
      const C = store.config();
      const u = await store.account(req.user.userId);
      const b = req.body || {};
      const kind = ["image", "audio", "video"].includes(b.kind) ? b.kind : null;
      const size = Math.floor(Number(b.size));
      if (!kind) return res.status(400).json({ ok: false, error: "Only pictures, audio and video." });
      const capMb = { image: C.max_image_mb, audio: C.max_audio_mb, video: C.max_video_mb }[kind];
      if (!Number.isFinite(size) || size < 12) return res.status(400).json({ ok: false, error: "That file is empty." });
      if (size > capMb * 1024 * 1024) return res.status(413).json({ ok: false, error: `${kind === "image" ? "Pictures" : kind === "audio" ? "Audio files" : "Videos"} can be up to ${capMb} MB.` });
      const refusal = await store.postRefusal(u, [], { media: true });
      if (refusal) return res.status(refusal.status).json({ ok: false, error: refusal.message });
      const t = Date.now();
      if (!store.isStaff(u)) {
        const recent = await getQuery("SELECT COUNT(*) AS n, COALESCE(SUM(size_declared), 0) AS b FROM feed_attachments WHERE owner_id = ? AND kind != 'preview' AND created > ?", [u.userId, t - 3600e3]);
        if (recent[0].n >= C.uploads_per_hour) return res.status(429).json({ ok: false, error: "You've uploaded a lot this hour - try again later." });
        const day = await getQuery("SELECT COALESCE(SUM(size_declared), 0) AS b FROM feed_attachments WHERE owner_id = ? AND kind != 'preview' AND created > ?", [u.userId, t - 86400e3]);
        if (day[0].b + size > C.upload_mb_per_day * 1024 * 1024) return res.status(429).json({ ok: false, error: "You've hit today's upload allowance." });
        const open = await getQuery("SELECT COUNT(*) AS n FROM feed_attachments WHERE owner_id = ? AND state IN ('uploading','processing')", [u.userId]);
        if (open[0].n >= 4) return res.status(429).json({ ok: false, error: "Finish the uploads you have going first." });
        if ((await store.usedBytes(u.userId)) + size > C.user_quota_mb * 1024 * 1024) {
          return res.status(413).json({ ok: false, error: `You're using your ${C.user_quota_mb} MB of space - delete some old posts to make room.` });
        }
      }
      if ((await store.usedBytes(null)) + size > C.global_quota_gb * 1024 ** 3 || media.diskFreeBytes() - size * 2 < C.min_free_gb * 1024 ** 3) {
        console.error("[feed] upload refused: storage full (quota or disk floor)");
        return res.status(507).json({ ok: false, error: "The feed's storage is full right now - try again later." });
      }
      const id = require("crypto").randomBytes(12).toString("hex");
      await runQuery(`INSERT INTO feed_attachments (id, owner_id, kind, state, created, size_declared, received) VALUES (?, ?, ?, 'uploading', ?, ?, 0)`,
                     [id, u.userId, kind, t, size]);
      fs.writeFileSync(media.tmpPath(id), Buffer.alloc(0), { flag: "wx" });
      res.json({ ok: true, id, chunk: media.CHUNK });
    } catch (e) { fail(res, e); }
  });

  const rawChunk = express.raw({ type: "application/octet-stream", limit: media.CHUNK_MAX });
  app.put("/api/feed/uploads/:id", addUser, guard(true), rawChunk, async (req, res) => {
    try {
      const a = (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [String(req.params.id)]))[0];
      if (!a || a.owner_id !== req.user.userId) return res.status(404).json({ ok: false, error: "No such upload." });
      if (a.state !== "uploading") return res.status(409).json({ ok: false, error: "That upload is finished." });
      const buf = Buffer.isBuffer(req.body) ? req.body : null;
      const off = Math.floor(Number(req.query.offset));
      if (!buf || !buf.length) return res.status(400).json({ ok: false, error: "Empty chunk." });
      if (off !== a.received) return res.status(409).json({ ok: false, error: "Out of order.", received: a.received });
      if (a.received + buf.length > a.size_declared) {
        await failUpload(a, "That file is bigger than it said.");
        return res.status(413).json({ ok: false, error: "That file is bigger than it said." });
      }
      if (off === 0) {
        const sn = media.sniff(buf);
        const ok = !sn.bad && (sn.kind === a.kind || (sn.kind === "av" && (a.kind === "video" || a.kind === "audio")));
        if (!ok) {
          const msg = sn.bad || `That file isn't ${a.kind === "image" ? "a picture" : a.kind === "audio" ? "audio" : "a video"}.`;
          await failUpload(a, msg);
          return res.status(415).json({ ok: false, error: msg });
        }
        await runQuery("UPDATE feed_attachments SET sniff = ? WHERE id = ?", [JSON.stringify(sn), a.id]);
      }
      fs.appendFileSync(media.tmpPath(a.id), buf);
      const r = await runQuery("UPDATE feed_attachments SET received = received + ? WHERE id = ? AND received = ?", [buf.length, a.id, off]);
      if (!r.changes) return res.status(409).json({ ok: false, error: "Out of order." });
      res.json({ ok: true, received: off + buf.length });
    } catch (e) { fail(res, e); }
  });

  async function failUpload(a, msg) {
    await runQuery("UPDATE feed_attachments SET state = 'failed', error = ? WHERE id = ?", [String(msg).slice(0, 300), a.id]);
    try { fs.unlinkSync(media.tmpPath(a.id)); } catch (e) { /* none */ }
  }

  app.post("/api/feed/uploads/:id/finish", addUser, guard(false), async (req, res) => {
    try {
      const a = (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [String(req.params.id)]))[0];
      if (!a || a.owner_id !== req.user.userId) return res.status(404).json({ ok: false, error: "No such upload." });
      if (a.state !== "uploading") return res.json({ ok: true, state: a.state });
      if (a.received !== a.size_declared) return res.status(409).json({ ok: false, error: "Not all of the file arrived.", received: a.received });
      const r = await runQuery("UPDATE feed_attachments SET state = 'processing' WHERE id = ? AND state = 'uploading'", [a.id]);
      if (!r.changes) return res.json({ ok: true, state: "processing" });
      processUpload(a).catch((e) => console.error("[feed] process:", e));
      res.json({ ok: true, state: "processing" });
    } catch (e) { fail(res, e); }
  });

  async function processUpload(a) {
    const tmp = media.tmpPath(a.id);
    try {
      const head = Buffer.alloc(64);
      const fd = fs.openSync(tmp, "r");
      fs.readSync(fd, head, 0, 64, 0);
      fs.closeSync(fd);
      const sn = media.sniff(head);                       // again, on the assembled file
      if (sn.bad) throw new media.MediaError(sn.bad);
      const C = store.config();
      const out = sn.kind === "image" ? await media.processImage(tmp, sn.fmt)
        : await media.processAv(tmp, { ...sn, kind: sn.kind === "av" ? a.kind : sn.kind }, C);
      if (a.kind === "image" && out.kind !== "image") throw new media.MediaError("That file isn't a picture.");
      if (a.kind !== "image" && out.kind === "image") throw new media.MediaError("That file is a picture, not " + a.kind + ".");
      await runQuery(`UPDATE feed_attachments SET state = 'ready', kind = ?, ct = ?, file = ?, thumb = ?, poster = ?, w = ?, h = ?, secs = ?, bytes = ?, error = NULL
                      WHERE id = ? AND state = 'processing'`, [out.kind, out.ct, out.file, out.thumb, out.poster, out.w, out.h, out.secs, out.bytes, a.id]);
    } catch (e) {
      const msg = e && e.refuse ? e.message : "That file couldn't be processed.";
      if (!(e && e.refuse)) console.error("[feed] process", a.id, e);
      await runQuery("UPDATE feed_attachments SET state = 'failed', error = ? WHERE id = ?", [msg.slice(0, 300), a.id]);
    } finally {
      try { fs.unlinkSync(tmp); } catch (e) { /* none */ }
    }
  }

  app.get("/api/feed/uploads/:id", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false });
    const a = (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [String(req.params.id)]))[0];
    if (!a || a.owner_id !== req.user.userId) return res.status(404).json({ ok: false, error: "No such upload." });
    res.json({ ok: true, state: a.state, error: a.error, received: a.received,
               attachment: a.state === "ready" ? { id: a.id, kind: a.kind, w: a.w, h: a.h, secs: a.secs, url: fileUrl(a.thumb || a.poster || a.file), file: fileUrl(a.file) } : null });
  });
  app.post("/api/feed/uploads/:id/discard", addUser, guard(false), async (req, res) => {
    const a = (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [String(req.params.id)]))[0];
    if (!a || a.owner_id !== req.user.userId || a.post_id) return res.status(404).json({ ok: false });
    media.removeFiles([a.file, a.thumb, a.poster].filter(Boolean));
    try { fs.unlinkSync(media.tmpPath(a.id)); } catch (e) { /* none */ }
    await runQuery("UPDATE feed_attachments SET state = 'deleted' WHERE id = ?", [a.id]);
    res.json({ ok: true });
  });

  // ── link previews (cached per user + url for 30 min; the post re-uses the cached one) ──
  const pvCache = new Map();
  async function previewFor(url, userId) {
    const key = userId + "|" + String(url).trim();
    const hit = pvCache.get(key);
    if (hit && Date.now() - hit.at < 30 * 60e3) {
      // the cached preview image is only reusable while no post has taken it
      const t = hit.v.thumb && (await getQuery("SELECT post_id FROM feed_attachments WHERE id = ?", [hit.v.thumb.id]))[0];
      if (!hit.v.thumb || (t && !t.post_id)) return hit.v;
    }
    const pv = await lp.preview(url);
    let thumb = null;
    if (pv.image) {
      const im = await media.processPreviewImage(pv.image);
      if (im) {
        const id = require("crypto").randomBytes(12).toString("hex");
        await runQuery(`INSERT INTO feed_attachments (id, owner_id, kind, ct, file, thumb, w, h, bytes, state, created, size_declared, received)
                        VALUES (?, ?, 'preview', 'image/webp', ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
                       [id, userId, im.file, im.file, im.w, im.h, im.bytes, Date.now(), im.bytes, im.bytes]);
        thumb = { id, file: im.file };
      }
    }
    const v = { url: pv.url, domain: pv.domain, title: pv.title, description: pv.description, site: pv.site, embed: pv.embed, thumb };
    pvCache.set(key, { at: Date.now(), v });
    if (pvCache.size > 2000) for (const [k, x] of pvCache) if (Date.now() - x.at > 30 * 60e3) pvCache.delete(k);
    return v;
  }
  app.post("/api/feed/preview", addUser, guard(false), async (req, res) => {
    try {
      const g = store.burst("preview|" + req.user.userId, 1500);
      if (g) return res.status(429).json({ ok: false, error: "One moment…" });
      const v = await previewFor(String((req.body || {}).url || ""), req.user.userId);
      res.json({ ok: true, preview: { url: v.url, domain: v.domain, title: v.title, description: v.description, site: v.site,
                                      embed: v.embed ? embeds.label(v.embed) : null, image: v.thumb ? fileUrl(v.thumb.file) : null } });
    } catch (e) {
      if (e instanceof lp.PreviewError) return res.status(400).json({ ok: false, error: e.message });
      fail(res, e);
    }
  });
  // a link whose site doesn't answer (or says 404) is still postable - as a plain link card
  const previewDep = async (url, userId) => {
    try { return await previewFor(url, userId); } catch (e) {
      if (e instanceof lp.PreviewError) {
        if (["fetch", "timeout", "status", "encoding", "size", "redirect"].includes(e.code)) {
          const u = lp.checkUrl(url);
          let embed = null;
          try { embed = embeds.parse(u.toString()); } catch (_) { embed = null; }
          return { url: u.toString(), domain: lp.domainOf(u.toString()), title: lp.domainOf(u.toString()), description: "", site: "", embed, thumb: null };
        }
        throw new store.Refuse(400, e.message);
      }
      throw e;
    }
  };

  // ── posts ──
  // 1.99cc: the Terms gate (428 + code "terms" until accepted; {acceptTerms: true} accepts and goes on) and the
  // admin-only abuse record (contentaudit.js) of every create / edit. Neither ever shows in a response.
  // 1.99cf: only while the admin switch terms_enforced is on (feedstore's config sets it on load, hence init first)
  const termsGate = async (req) => {
    await store.init();
    if (!(await terms.needs(req.user.userId))) return false;
    if ((req.body || {}).acceptTerms === true) { await terms.accept(req.user.userId); return false; }
    return true;
  };
  const termsRefusal = (res) => res.status(428).json({ ok: false, code: "terms", error: "Please read and accept the Terms of Service first.", url: "/terms", version: terms.VERSION });
  const record = async (req, what) => {
    const u = await store.account(req.user.userId).catch(() => null);
    await audit.record(audit.fromRequest(req), { ...what, user: u });
  };
  app.post("/api/feed/posts", addUser, guard(false), async (req, res) => {
    try {
      if (await termsGate(req)) return termsRefusal(res);
      const p = await store.create(req.user.userId, req.body || {}, { preview: previewDep });
      await record(req, { kind: "post", id: p.id, postId: p.id, event: "create" });
      res.json({ ok: true, id: p.id, url: p.url });
    } catch (e) { fail(res, e); }
  });
  // 1.99ci: crosspost {community, title?} -> a new post in that community embedding this one
  // 1.99ct: {pads: [...], title?} (or communities: [...]) -> one crosspost per pad, each pad checked on its own:
  //         {ok, results: [{community, pad, status: created|pending|refused, id?, url?, error?}], created, pending, refused}
  app.post("/api/feed/posts/:id/crosspost", addUser, guard(false), async (req, res) => {
    try {
      if (await termsGate(req)) return termsRefusal(res);
      const b = req.body || {};
      const many = b.pads !== undefined ? b.pads : b.communities;
      if (many !== undefined) {
        const r = await store.crosspostMany(req.user.userId, String(req.params.id), { pads: many, title: b.title, announce: b.announce });
        for (const x of r.results) if (x.id) await record(req, { kind: "post", id: x.id, postId: x.id, event: "crosspost" });
        return res.json({ ok: true, ...r });
      }
      const p = await store.crosspost(req.user.userId, String(req.params.id), { community: b.community, title: b.title, announce: b.announce });
      await record(req, { kind: "post", id: p.id, postId: p.id, event: "crosspost" });
      res.json({ ok: true, id: p.id, url: p.url, pending: !!p.pendingApproval, community: p.rooms[0] || (p.roomsAll[0] || null) });
    } catch (e) { fail(res, e); }
  });
  const postAct = (path, fn) => app.post("/api/feed/posts/:id/" + path, addUser, guard(false), async (req, res) => {
    try {
      const viewer = await viewerOf(req);
      res.json({ ok: true, ...(await fn(viewer, String(req.params.id), req.body || {})) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/feed/posts/:id/edit", addUser, guard(false), async (req, res) => {
    try {
      const id = String(req.params.id);
      await store.edit(await viewerOf(req), id, req.body || {});
      await record(req, { kind: "post", id, postId: id, event: "edit" });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  postAct("delete", async (v, id, b) => { await store.remove(v, id, b.reason); return {}; });
  // {dir: 1 | -1 | 0} sets the vote; {} toggles the upvote and {on} sets it (the 1.99bw API)
  postAct("vote", async (v, id, b) => store.vote(v, id, b.dir, b.on === undefined ? undefined : !!b.on));
  postAct("remove-room", async (v, id, b) => { await store.removeFromRoom(v, id, String(b.room || "")); return {}; });
  postAct("restore-room", async (v, id, b) => { await store.restoreToRoom(v, id, String(b.room || "")); return {}; });
  postAct("admin", async (v, id, b) => {
    const patch = {};
    if ("nsfw" in b) patch.nsfw = b.nsfw === null ? null : !!b.nsfw;
    if ("hidden" in b) patch.hidden = !!b.hidden;
    if ("locked" in b) patch.locked = !!b.locked;
    await store.adminSet(v, id, patch);
    return {};
  });
  postAct("report", async (v, id, b) => store.report(v, { post: id, comment: b.comment || null, reason: b.reason, note: b.note }));
  app.post("/api/feed/posts/:id/comments", addUser, guard(false), async (req, res) => {
    try {
      if (await termsGate(req)) return termsRefusal(res);
      const b = req.body || {}, postId = String(req.params.id);
      const r = await store.comment(await viewerOf(req), postId, { body: b.body, parent: b.parent });
      await record(req, { kind: "comment", id: r.id, postId, event: "create" });
      res.json({ ok: true, ...r });
    } catch (e) { fail(res, e); }
  });
  // 1.99cc: the report modal's reasons (public: labels + hints only)
  app.get("/api/feed/report-reasons", (req, res) => {
    res.set("Cache-Control", "public, max-age=300");
    res.json({ ok: true, post: store.reportMenu(false), user: store.reportMenu(true) });
  });
  // 1.99cc: report an account (the profile's "Report user")
  app.post("/api/users/:username/report", addUser, guard(false), async (req, res) => {
    try {
      const b = req.body || {};
      res.json({ ok: true, ...(await store.reportUser(await viewerOf(req), { username: req.params.username, reason: b.reason, note: b.note })) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/feed/comments/:id/vote", addUser, guard(false), async (req, res) => {
    try { res.json({ ok: true, ...(await store.voteComment(await viewerOf(req), req.params.id, (req.body || {}).dir)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/feed/comments/:id/edit", addUser, guard(false), async (req, res) => {
    try {
      await store.editComment(await viewerOf(req), req.params.id, (req.body || {}).body);
      const c = (await getQuery("SELECT post_id FROM feed_comments WHERE id = ?", [String(req.params.id)]))[0];
      await record(req, { kind: "comment", id: String(req.params.id), postId: c ? c.post_id : null, event: "edit" });
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/feed/comments/:id/delete", addUser, guard(false), async (req, res) => {
    try { await store.removeComment(await viewerOf(req), req.params.id, (req.body || {}).reason); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });

  // ── room owners: their room's feed (1.99bx). Owner or staff, checked per room in feedstore.roomMod ──
  const roomOf = async (slug) => (await rooms.get(String(slug || ""))) || (await require("./roomsweb").resolveRoom(String(slug || "")));
  app.post("/api/rooms/:slug/feed/mod", addUser, guard(false), async (req, res) => {
    try {
      const R = await roomOf(req.params.slug);
      if (!R) return res.status(404).json({ ok: false, error: "No such pad." });
      const b = req.body || {};
      res.json(await store.roomMod(await viewerOf(req), R.id, String(b.op || ""), { post: b.post ? String(b.post) : null, comment: b.comment || null,
                                                                                  reason: b.reason, settings: b.settings, user: b.user, userId: b.userId }));
    } catch (e) { fail(res, e); }
  });
  // (the page: the pad settings hub /p/:slug/settings, padsettings.js - 1.99dc; /p/:slug/mod redirects there)

  // 1.99df: your profile feed's settings (your own profile only): {pepe: bool} = Pepe answers mentions on your profile
  // posts (default on). Blocking people from commenting uses /api/feed/ban + /api/feed/unban with room = the profile
  // pad's slug, like any pad owner's ban.
  app.post("/api/profile/settings", addUser, guard(false), async (req, res) => {
    try {
      const v = await viewerOf(req);
      const b = req.body || {};
      const P = await rooms.ensureProfile(v.userId);
      if (!P) return res.status(403).json({ ok: false, error: "Your account can't have a profile feed." });
      const out = { ok: true, slug: P.slug };
      if (b.pepe !== undefined) out.pepe = (await require("./pepefeed").setScope(v, P.id, { respond: !!b.pepe })).respond !== false;
      // 1.99dn: "Don't post my room generations" (aigen.js: a room's !imagine / !video -> its pad feed)
      if (b.roomgenOff !== undefined) out.roomgenOff = await require("./aigen").setOptOut(v.userId, !!b.roomgenOff);
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  // ── admin ──
  app.post("/api/feed/admin/config", addUser, guard(false), async (req, res) => {
    try {
      const v = await viewerOf(req);
      if (!v || v.class !== "Admin") return res.status(403).json({ ok: false, error: "Admins only." });
      res.json({ ok: true, config: await store.setConfig(req.body || {}, v.username) });
    } catch (e) { fail(res, e); }
  });
  // 1.99cc: the abuse details panel (site Admins only; every view is logged in content_audit_views first)
  app.get("/api/feed/admin/details", addUser, async (req, res) => {
    res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
    if (!sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      const v = await viewerOf(req);
      if (!audit.isAdmin(v)) return res.status(403).json({ ok: false, error: "Admins only." });
      const q = req.query || {};
      const target = q.post ? { post: String(q.post).slice(0, 32) } : q.comment ? { comment: String(q.comment).slice(0, 32) } : q.user ? { user: String(q.user).slice(0, 64) } : {};
      res.json({ ok: true, details: await audit.details(v, target, { reason: q.why }) });
    } catch (e) {
      const st = e && e.status && e.status < 500 ? e.status : 500;
      if (st === 500) console.error("[feed] details:", e && e.message);
      res.status(st).json({ ok: false, error: st === 500 ? "Something went wrong." : e.message });
    }
  });
  // 1.99cc: an admin outcome on a report target: dismiss | false | remove | ban (+ tell the reporters, default on)
  app.post("/api/feed/admin/report-action", addUser, guard(false), async (req, res) => {
    try {
      const b = req.body || {};
      res.json(await store.reportAction(await viewerOf(req), { post: String(b.post || ""), comment: b.comment ? String(b.comment) : null, action: String(b.action || ""),
                                                              tell: b.notify !== false, days: Number(b.days) || 0, reason: b.reason }));
    } catch (e) { fail(res, e); }
  });
  app.post("/api/feed/admin/user-report-action", addUser, guard(false), async (req, res) => {
    try {
      const b = req.body || {};
      res.json(await store.userReportAction(await viewerOf(req), { userId: String(b.userId || ""), action: String(b.action || ""), tell: b.notify !== false,
                                                                  days: Number(b.days) || 0, reason: b.reason }));
    } catch (e) { fail(res, e); }
  });
  app.post("/api/feed/admin/resolve", addUser, guard(false), async (req, res) => {
    try { await store.resolveReports(await viewerOf(req), String((req.body || {}).post || ""), (req.body || {}).action); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  // bans: no room = the whole feed (staff); a room slug = that room (its owner or staff)
  app.post("/api/feed/ban", addUser, guard(false), async (req, res) => {
    try {
      const b = req.body || {};
      let roomId = "";
      if (b.room) { const R = await require("./roomsweb").resolveRoom(String(b.room)); if (!R) return res.status(404).json({ ok: false, error: "No such pad." }); roomId = R.id; }
      res.json({ ok: true, ban: await store.ban(await viewerOf(req), String(b.user || ""), { room: roomId, reason: b.reason, days: b.days }) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/feed/unban", addUser, guard(false), async (req, res) => {
    try {
      const b = req.body || {};
      let roomId = "";
      if (b.room) { const R = await require("./roomsweb").resolveRoom(String(b.room)); if (!R) return res.status(404).json({ ok: false, error: "No such pad." }); roomId = R.id; }
      await store.unban(await viewerOf(req), String(b.userId || ""), roomId);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // the room owner's "Pepe mentions new posts in the room" switch
  app.post("/api/rooms/:slug/feed/mention", addUser, guard(false), async (req, res) => {
    try {
      const R = await require("./roomsweb").resolveRoom(req.params.slug);
      if (!R) return res.status(404).json({ ok: false, error: "No such pad." });
      res.json({ ok: true, on: await store.setMention(await viewerOf(req), R.id, !!(req.body || {}).on) });
    } catch (e) { fail(res, e); }
  });

  // ── housekeeping ──
  const sweep = () => store.sweep(media).then((r) => { if (r.purged || r.orphans || r.tmp) console.log(`[feed] sweep: ${JSON.stringify(r)}`); })
    .catch((e) => console.error("[feed] sweep:", e.message));
  setTimeout(sweep, 60e3).unref();
  setInterval(sweep, 30 * 60e3).unref();
  audit.start();            // 1.99cc: the daily retention job (raw IPs / user agents nulled after 90 days)
  // uploads stuck in "processing" after a restart: fail them (the browser shows the error)
  store.init().then(() => runQuery("UPDATE feed_attachments SET state = 'failed', error = 'The server restarted while processing - upload it again.' WHERE state = 'processing'"))
    .catch(() => {});
  void isBotToken;
}

/** For /api/rooms/owners (Pepe's 2-min sync): store his refusals, hand him the room mentions. */
async function botSync(body) {
  const out = {};
  if (Array.isArray(body.restricted)) out.restricted = await store.setRestricted(body.restricted);
  if (body.feed_mentions === true) out.feed_mentions = await store.takeMentions(SITE());
  return out;
}

/**
 * The profile's Posts panel + follow chip (1.99bz). profileUser: {userId, username}; reqUser: the
 * session user or null. The panel itself obeys the profile layout (section "posts"); the posts are the
 * same ones /feed?by=<username> lists (deleted / report-hidden ones left out for everyone but staff).
 */
//
// 1.99df: the Posts panel IS the profile feed (Reddit's u/ page): full post cards with votes, Hot / New / Top /
// Controversial / Rising (?psort, ?pt, ?pp - the anchor is #posts), and a view switch (?pview): "all" = every post
// they made (their profile + every pad, as before) or "profile" = just their profile pad. The owner gets the
// composer with "Your profile" picked, and the profile's settings (Pepe answers mentions here, who's blocked from
// commenting). show = false (the layout hides "posts" from this viewer): nothing is loaded - not the posts, not the
// profile pad's posts.
async function profileSocial(profileUser, reqUser, { show = true, query = {}, host = "publicaccess.tv" } = {}) {
  await store.init();
  const viewer = reqUser && reqUser.userId ? await viewerOf({ user: reqUser }) : null;
  const self = !!(viewer && viewer.userId === profileUser.userId);
  const q = query || {};
  const sort = SORTS.has(q.psort) ? q.psort : "new";
  const top = TOPS.has(q.pt) ? q.pt : "week";
  const page = Math.max(1, Math.min(200, parseInt(q.pp, 10) || 1));
  const view = q.pview === "profile" ? "profile" : "all";
  const pad = await rooms.profileOf(profileUser.userId);
  let L = { posts: [], more: false };
  if (show) {
    if (view === "profile") L = pad ? await store.list({ room: pad.id, sort, top, page, viewer, limit: 10, pins: false }) : L;
    else L = await store.list({ author: profileUser.userId, sort, top, page, viewer, limit: 10 });
  }
  const modRooms = new Set();
  if (viewer) for (const p of L.posts) for (const r of p.roomsAll) if (!modRooms.has(r.id) && (await rooms.canManage(viewer, r.id))) modRooms.add(r.id);
  const c = await follows.counts("user", profileUser.userId);
  let settings = null;
  if (self && show) {
    const PF = require("./pepefeed");
    settings = {
      pepe: pad ? (await PF.scopeSettings(pad.id)).respond !== false : true,
      bans: pad ? (await store.bans(pad.id)).filter((b) => !b.until || b.until > Date.now()).map((b) => ({ userId: b.user_id, username: b.username, until: b.until, reason: b.reason })) : [],
      slug: pad ? pad.slug : null,
      roomgenOff: await require("./aigen").optedOut(profileUser.userId).catch(() => false),     // 1.99dn
    };
  }
  return {
    posts: L.posts, more: L.more, counts: c, sort, top, page, view, show,
    self,
    following: viewer && !self ? await follows.isFollowing(viewer.userId, "user", profileUser.userId) : false,
    signed: !!viewer, viewer, modRooms, host, fx, embeds, settings,
    padId: pad ? pad.id : null,
    composer: self && show ? await composerFor(viewer, "profile") : null,
  };
}

/** The homepage's "Hot on PATV" card (1.99ci): the top 5 hot posts across All (no NSFW for signed-out visitors). */
async function hotMini(reqUser, limit = 5) {
  await store.init();
  const viewer = reqUser && reqUser.userId ? await viewerOf({ user: reqUser }) : null;
  return { posts: await store.hot(viewer, limit), signed: !!viewer };
}

module.exports = { register, roomFeed, botSync, fx, linkify, captures, composerFor, profileSocial, hotMini };
