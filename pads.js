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
//   - padHref / padSlug: the one way the site builds a pad link;
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
/** 1.99df: a user's profile address (their profile pad's page - the profile feed lives on the profile). */
const profileHref = (username) => "/u/" + encodeURIComponent(String(username || "")) + "/profile";
/** "/p/<slug>" (+ an optional sub-page: "settings", "analytics", "audio"). R is a pad or a slug. 1.99df: a profile pad -> the profile. */
function padHref(R, sub = "") {
  if (R && typeof R === "object" && R.profile && R.profile.username) return profileHref(R.profile.username) + (sub ? "#posts" : "");
  const slug = typeof R === "string" ? R : padSlug(R);
  return "/p/" + encodeURIComponent(String(slug || "").toLowerCase()) + (sub ? "/" + sub : "");
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
  if (!Object.prototype.hasOwnProperty.call(OLD_SLUGS, s)) return null;
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
    const href = OLD_SLUGS[s] && R.slug && R.slug !== s ? R.slug : s;
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
  // 1.99x: /p/<retired slug> and every page under it -> the pad's current slug, query kept (GET / HEAD only)
  app.use("/p/:slug", (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    // 1.99df: a profile pad's page (and anything under it) is the member's profile
    const P = require("./rooms").bySlugCached(String(req.params.slug || "").toLowerCase());
    if (P && P.profile && P.profile.username) return res.redirect(301, profileHref(P.profile.username) + "#posts");
    const cur = currentSlugFor(req.params.slug);
    if (!cur) return next();
    const rest = req.path && req.path !== "/" ? req.path : "";
    res.redirect(301, "/p/" + encodeURIComponent(cur) + rest + qsOf(req));
  });
  // 1.99df: /u/<username> (what u/<name> reads like) -> the profile, where the profile feed lives
  app.get("/u/:username", (req, res) => res.redirect(301, profileHref(req.params.username) + qsOf(req)));
  app.get("/rooms", to(() => "/p"));
  app.get("/pads", to(() => "/p"));
  app.get("/rooms/admin", to(() => "/pads/admin"));
  app.get("/rooms/:slug", to((req) => "/p/" + enc(req)));
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
  app.get("/rooms/:slug/analytics", to((req) => "/p/" + enc(req) + "/analytics"));
  app.get("/rooms/:slug/audio", to((req) => "/p/" + enc(req) + "/audio"));
  app.get("/feed/c/:slug", to((req) => "/p/" + enc(req)));
}

/** 1.99df: a pad's label: "p/<slug>", or "u/<username>" for a profile pad. */
const padLabel = (R) => (R && R.profile && R.profile.username ? "u/" + R.profile.username : "p/" + (R ? padSlug(R) || R.slug || "" : ""));

module.exports = { register, padSlug, padHref, padRefs, padBySlugSync, qsOf, PAD_REF_RE, OLD_SLUGS, currentSlugFor,
                   PLATFORM_INFO, platformOf, padBadge, USER_REF_RE, userRefs, profileHref, padLabel, _setNames: (m) => { NAMES = m; namesAt = m ? Date.now() : 0; } };
