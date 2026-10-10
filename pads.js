// pads.js — "pad" is PATV's word for its hubs (like a subreddit), written p/<slug> (1.99ck). A pad can be
// backed by a Camfrog room (the live bridge, Pepe, the mic) or be a site pad (the Camfrog Lounge). Before
// this the same thing was called a room, a channel or a community depending on the page.
//
// This module owns the pad URLs that aren't a page of their own:
//   - the 301s from every old address (query string kept):
//       /rooms -> /p · /pads -> /p · /rooms/admin -> /pads/admin · /rooms/<s> -> /p/<s>
//       /rooms/<s>/manage + /p/<s>/manage -> /p/<s>/settings?tab=stage · /rooms/<s>/feed/mod + /p/<s>/mod -> /p/<s>/settings?tab=moderation (1.99dc)
//       /rooms/<s>/analytics -> /p/<s>/analytics · /rooms/<s>/audio -> /p/<s>/audio · /feed/c/<s> -> /p/<s>
//     (/feed?room=<x> is redirected by feedweb.js's /feed handler, which knows the feed's other params.)
//   - 1.99x: retired slugs (OLD_SLUGS, e.g. patv-lounge -> the Camfrog Lounge): /p/<old>[/<sub>] 301s to the
//     pad's current slug, and the /rooms + /feed/c aliases above go straight there;
//   - 1.99dv: a profile pad's address (/p/u-<name>[/...]) -> /u/<name>/posts in one hop, from /p, /rooms and /feed/c;
//     /p/<anything>/posts/<id> passes through to the post page, which 301s to the post's canonical address;
//   - padHref / padSlug: the one way the site builds a pad link; postHref (1.99dv): the one way it builds a post link
//     (/p/<pad>/posts/<id>/<title-slug> or /u/<username>/posts/<id>/<title-slug>); profileHref: /u/<username>[/<tab>];
//   - padRefs: "p/<slug>" in post / comment text becomes a link to that pad (known pads only; an old slug
//     still links, to the pad's current address);
//   - padBadge (1.99x): the pad's platform badge - "🐸 Camfrog Pad" / "🌐 Site Pad" (Twitch / Discord ready).
// The data layer keeps its old names (rooms.js, rooms_registry, /api/rooms/...): no churn there.
"use strict";

/** 1.99x: slugs a pad used to have -> its registry id (the pad's current slug is looked up, so a later rename still lands). */
const OLD_SLUGS = { "patv-lounge": "patv:lounge" };

/** The slug a pad's links use: the bridge's (what Pepe posts) while it's bridged, else the registry's. */
function padSlug(R) {
  if (!R) return "";
  try { return require("./roomsweb").linkSlug(R); } catch (e) { return R.slug; }
}
/** 1.99df: a user's profile address. 1.99dv: /u/<username> (was /u/<username>/profile), + a tab: "posts", "overview", "analytics", "edit". */
const profileHref = (username, tab = "") => "/u/" + encodeURIComponent(String(username || "")) + (tab ? "/" + tab : "");
/** "/p/<slug>" (+ an optional sub-page: "settings", "analytics", "audio"). R is a pad or a slug. 1.99df: a profile pad -> the profile
 *  (1.99dv: with a sub-page -> its posts tab, /u/<username>/posts). */
function padHref(R, sub = "") {
  if (R && typeof R === "object" && R.profile && R.profile.username) return profileHref(R.profile.username, sub ? "posts" : "");
  const slug = typeof R === "string" ? R : padSlug(R);
  return "/p/" + encodeURIComponent(String(slug || "").toLowerCase()) + (sub ? "/" + sub : "");
}

// ── post addresses (1.99dv) ──
// A post lives at /p/<pad>/posts/<id>/<title-slug> (its first pad: the first placement still live there, else its
// first placement), or /u/<username>/posts/<id>/<title-slug> for a post on a profile. The slug is cosmetic - the id
// alone resolves, and a wrong / missing slug or a wrong pad 301s to the canonical address (feedweb.js).
/** A title as a URL slug: ascii letters / digits joined by "-", at most ~60 characters, cut at a word. "" when nothing's left. */
function titleSlug(s) {
  let t = String(s == null ? "" : s).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/['\u2019]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (t.length > 60) {
    const cut = t.slice(0, 61), i = cut.lastIndexOf("-");
    t = (i >= 20 ? cut.slice(0, i) : t.slice(0, 60)).replace(/-+$/, "");
  }
  return t;
}
/** A post's slug: its title, else its link's title, else the first words of its body. */
function postSlug(p) {
  if (!p) return "";
  const body = require("./postlabel").firstWords(p.body).text;      // 1.99ex: the same words postLabel() uses
  return titleSlug(p.title) || titleSlug(p.link && p.link.title) || titleSlug(body);
}
/**
 * The placement a post's address uses. 1.99ep: its fixed HOME pad (feed_posts.home_pad, set at creation, never
 * changes - v2 decision 2026-10-07), whatever happens to its placements; the "first live pad" rule is gone. A post
 * without one (none in practice: old rows are backfilled) falls back to its first placement.
 */
function homeOf(p) {
  const all = (p && p.roomsAll) || [];
  if (p && p.homePad) {
    const h = all.find((r) => r.id === p.homePad);
    if (h) return h;
    let R = null;
    try { R = require("./rooms").getCached(p.homePad); } catch (e) { R = null; }
    return { id: p.homePad, slug: R ? R.slug : null, profile: R && R.profile ? R.profile.username || null : null };
  }
  return all[0] || null;
}
/**
 * A post's canonical path. p: a decorated post ({id, title, link, body, roomsAll: [{id, slug, profile, removed,
 * pending, hidden}], author: {username}}). A post with no placement at all goes under its author's profile.
 */
function postHref(p) {
  if (!p || !p.id) return "/feed";
  const h = homeOf(p);
  let base;
  if (h && h.profile) base = profileHref(h.profile);
  else if (h) base = "/p/" + encodeURIComponent(String(h.slug || padSlug(require("./rooms").getCached(h.id)) || h.id).toLowerCase());
  else base = profileHref((p.author && p.author.username) || "-");
  const s = postSlug(p);
  return base + "/posts/" + encodeURIComponent(p.id) + (s ? "/" + s : "");
}
/** The query string of a request, "" or "?a=b" (kept verbatim through a redirect). */
function qsOf(req) {
  const u = String(req.originalUrl || req.url || "");
  const i = u.indexOf("?");
  return i >= 0 ? u.slice(i) : "";
}
/** 1.99x: a retired slug's pad's current slug, or null when `slug` isn't a retired one (or still is the pad's slug). */
function currentSlugFor(slug) {
  const s = String(slug || "").toLowerCase();
  // 1.99iy: a slug a pad gave up when its owner changed its address (rooms.js pad_slug_aliases)
  if (!Object.prototype.hasOwnProperty.call(OLD_SLUGS, s)) {
    let id = null;
    try { id = require("./rooms").aliasTarget(s); } catch (e) { id = null; }
    if (!id) {
      // 1.99ja: any other slug of a pad whose address was chosen (its id-based slug - e.g. a Camfrog room's pad that a site
      // pad was connected to) -> the chosen one
      let R = null;
      try { R = require("./rooms").bySlugCached(s); } catch (e) { R = null; }
      return R && R.slug_set && R.slug && R.slug !== s && !R.profile ? R.slug : null;
    }
    const A = require("./rooms").getCached(id);
    const cur = A ? padSlug(A) : null;
    return cur && cur !== s ? cur : null;
  }
  let R = null;
  try { R = require("./rooms").getCached(OLD_SLUGS[s]); } catch (e) { R = null; }
  return R && R.slug && R.slug !== s ? R.slug : null;
}

/** A known pad by any of its slugs, synchronously (registry cache, then the bridge's slugs). */
function padBySlugSync(slug) {
  const s = String(slug || "").toLowerCase();
  if (!s) return null;
  const rooms = require("./rooms");
  let R = rooms.bySlugCached ? rooms.bySlugCached(s) : null;
  if (!R && OLD_SLUGS[s] && rooms.getCached) R = rooms.getCached(OLD_SLUGS[s]);
  if (!R) {
    try { const B = require("./bridge").bySlug(s); if (B) R = rooms.getCached(B.id) || { id: B.id, slug: B.slug, title: B.name }; } catch (e) { R = null; }
  }
  return R || null;
}

// p/<slug> inside already-escaped text: a word boundary before "p/" (not part of a URL path or a word),
// the slug's own characters, and no trailing hyphen. Only [a-z0-9-] can match, so escaping can't interfere.
const PAD_REF_RE = /(^|[^A-Za-z0-9_/.\-])p\/([a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?)(?![a-z0-9\-/])/gi;
/** Turn "p/<slug>" mentions of known pads in ESCAPED html text into links. `known` is injectable for tests. */
function padRefs(html, known = padBySlugSync) {
  return String(html == null ? "" : html).replace(PAD_REF_RE, (m, pre, slug) => {
    const R = known(slug.toLowerCase());
    if (!R) return m;
    const s = slug.toLowerCase();
    // 1.99x: an old slug (p/patv-lounge in older posts) keeps its text and links to the pad's current address
    const cur = currentSlugFor(s);                                   // 1.99iy: any retired slug (OLD_SLUGS or a renamed pad's)
    const href = cur || s;
    return `${pre}<a class="pad-ref" href="/p/${encodeURIComponent(href)}">p/${s}</a>`;
  });
}

// 1.99df: u/<username> inside already-escaped text -> a link to that profile (like p/<slug>). Same boundaries as
// PAD_REF_RE; a username is letters, digits, dot, dash, underscore and starts / ends with a letter or digit, so
// escaping can't interfere. `known(name)` -> the account's exact username, or null (not linked). The default checks
// a small in-memory username set (refreshed every few minutes); until it's loaded every well-formed name links (an
// unknown one lands on the profile 404).
const USER_REF_RE = /(^|[^A-Za-z0-9_/.\-])u\/([A-Za-z0-9](?:[A-Za-z0-9._-]{0,38}[A-Za-z0-9])?)(?![A-Za-z0-9_\-/])/g;
let NAMES = null, namesAt = 0, namesBusy = false;
function refreshNames() {
  if (namesBusy) return;
  namesBusy = true;
  require("./dbUtils").getQuery("SELECT username FROM users WHERE username IS NOT NULL")
    .then((rows) => { const m = new Map(); for (const r of rows) m.set(String(r.username).toLowerCase(), r.username); NAMES = m; namesAt = Date.now(); })
    .catch(() => {}).finally(() => { namesBusy = false; });
}
function knownUserSync(name) {
  if (!NAMES || Date.now() - namesAt > 5 * 60e3) refreshNames();
  if (!NAMES) return name;
  return NAMES.get(String(name).toLowerCase()) || null;
}
function userRefs(html, known = knownUserSync) {
  return String(html == null ? "" : html).replace(USER_REF_RE, (m, pre, name) => {
    const real = known(name);
    if (!real) return m;
    return `${pre}<a class="user-ref" href="${profileHref(real)}">u/${name}</a>`;
  });
}

// ── platform badges (1.99x) ──
const PLATFORM_INFO = {
  camfrog: { icon: "🐸", label: "Camfrog Pad", tip: "A Camfrog Pad: backed by a Camfrog room" },
  site: { icon: "🌐", label: "Site Pad", tip: "A Site Pad: made by the site, no Camfrog room behind it" },
  twitch: { icon: "🟣", label: "Twitch Pad", tip: "A Twitch Pad: backed by a Twitch channel" },
  discord: { icon: "💬", label: "Discord Pad", tip: "A Discord Pad: backed by a Discord server" },
  profile: { icon: "👤", label: "Profile", tip: "A member's profile: only they post here" },     // 1.99df
};
/** A pad's platform from a platform name, a pad ({platform} / {id} / {slug}) or a room id. Defaults to camfrog. */
function platformOf(x) {
  if (!x) return "camfrog";
  const rooms = require("./rooms");
  if (typeof x === "string") return PLATFORM_INFO[x] ? x : rooms.platformOf(x);
  if (x.platform && PLATFORM_INFO[x.platform]) return x.platform;
  if (x.id) return rooms.platformOf(x.id);
  if (x.slug) { const R = padBySlugSync(x.slug); return R ? platformOf(R.platform ? R : R.id) : "camfrog"; }
  return "camfrog";
}
/** The platform badge's html: "🐸 Camfrog Pad" (compact: just the icon, the label in its tooltip). */
function padBadge(x, opts = {}) {
  const p = platformOf(x);
  const I = PLATFORM_INFO[p];
  return `<span class="pad-plat pp-${p}${opts.compact ? " sm" : ""}" title="${I.tip}">${I.icon}${opts.compact ? "" : " " + I.label}</span>`;
}

function register(app) {
  if (app.locals) { app.locals.padBadge = padBadge; app.locals.PAD_PLATFORMS = PLATFORM_INFO; }
  const to = (path) => (req, res) => res.redirect(301, path(req) + qsOf(req));
  // a slug param, swapped for the pad's current slug when it's a retired one (one hop, not two)
  const enc = (req) => encodeURIComponent(currentSlugFor(req.params.slug) || String(req.params.slug || ""));
  // 1.99dv: a slug param's pad address - a profile pad's is its member's posts tab (/u/<username>/posts), in one hop
  const profilePad = (slug) => {
    const P = require("./rooms").bySlugCached(String(slug || "").toLowerCase());
    return P && P.profile && P.profile.username ? P : null;
  };
  const base = (req) => { const P = profilePad(req.params.slug); return P ? padHref(P, "posts") : "/p/" + enc(req); };
  // 1.99x: /p/<retired slug> and every page under it -> the pad's current slug, query kept (GET / HEAD only)
  app.use("/p/:slug", (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    // 1.99dv: a post (/p/<any slug>/posts/<id>[/<slug>]) - the post page 301s to the post's canonical address itself
    if (/^\/posts\/[^/]+/.test(req.path || "")) return next();
    // 1.99df: a profile pad's page (and anything under it) is the member's profile - 1.99dv: its posts tab
    const P = profilePad(req.params.slug);
    if (P) return res.redirect(301, padHref(P, "posts") + qsOf(req));
    const cur = currentSlugFor(req.params.slug);
    if (!cur) return next();
    const rest = req.path && req.path !== "/" ? req.path : "";
    res.redirect(301, "/p/" + encodeURIComponent(cur) + rest + qsOf(req));
  });
  // 1.99dv: the profile is /u/<username> (+ /posts, /overview, /analytics, /edit). /u/<username>/profile 301s there, query
  // kept: ?tab=<tab> becomes the path (/u/<username>/<tab>), an old profile-feed link (?psort / ?pp / ?pt / ?pview) goes
  // to the posts tab; the browser keeps an #anchor through the 301 and profile-tabs.js turns #posts / #overview /
  // #analytics into that tab's path. /u/<username>/profile/edit -> /u/<username>/edit.
  app.get("/u/:username/profile", (req, res) => {
    const q = new URLSearchParams(qsOf(req).slice(1));
    let tab = String(q.get("tab") || "").toLowerCase();
    q.delete("tab");
    if (!["posts", "overview", "analytics"].includes(tab)) tab = ["psort", "pp", "pt", "pview"].some((k) => q.has(k)) ? "posts" : "";
    const s = q.toString();
    res.redirect(301, profileHref(req.params.username, tab) + (s ? "?" + s : ""));
  });
  app.get("/u/:username/profile/edit", to((req) => profileHref(req.params.username, "edit")));
  app.get("/rooms", to(() => "/p"));
  app.get("/pads", to(() => "/p"));
  app.get("/rooms/admin", to(() => "/pads/admin"));
  app.get("/rooms/:slug", to(base));
  // 1.99dc: the pad's settings hub (padsettings.js) replaced /manage and /mod - straight there, the tab picked; the
  // browser keeps an old link's #anchor through the redirect and the hub has those anchors
  const hub = (tab) => (req, res) => {
    const q = new URLSearchParams(qsOf(req).slice(1));
    q.set("tab", tab);
    res.redirect(301, "/p/" + enc(req) + "/settings?" + q.toString());
  };
  app.get("/rooms/:slug/manage", hub("stage"));
  app.get("/rooms/:slug/feed/mod", hub("moderation"));
  app.get("/p/:slug/manage", hub("stage"));
  app.get("/p/:slug/mod", hub("moderation"));
  app.get("/rooms/:slug/analytics", to((req) => (profilePad(req.params.slug) ? base(req) : "/p/" + enc(req) + "/analytics")));
  app.get("/rooms/:slug/audio", to((req) => (profilePad(req.params.slug) ? base(req) : "/p/" + enc(req) + "/audio")));
  app.get("/feed/c/:slug", to(base));
}

/** 1.99df: a pad's label: "p/<slug>", or "u/<username>" for a profile pad. */
const padLabel = (R) => (R && R.profile && R.profile.username ? "u/" + R.profile.username : "p/" + (R ? padSlug(R) || R.slug || "" : ""));

module.exports = { register, padSlug, padHref, padRefs, padBySlugSync, qsOf, PAD_REF_RE, OLD_SLUGS, currentSlugFor,
                   PLATFORM_INFO, platformOf, padBadge, USER_REF_RE, userRefs, profileHref, padLabel, titleSlug, postSlug, postHref, homeOf, _setNames: (m) => { NAMES = m; namesAt = m ? Date.now() : 0; } };
