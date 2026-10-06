// pads.js — "pad" is PATV's word for its hubs (like a subreddit), written p/<slug> (1.99ck). A pad can be
// backed by a Camfrog room (the live bridge, Pepe, the mic) or be site-only (the PATV Lounge). Before
// this the same thing was called a room, a channel or a community depending on the page.
//
// This module owns the pad URLs that aren't a page of their own:
//   - the 301s from every old address (query string kept):
//       /rooms -> /p · /pads -> /p · /rooms/admin -> /pads/admin · /rooms/<s> -> /p/<s>
//       /rooms/<s>/manage -> /p/<s>/manage · /rooms/<s>/feed/mod -> /p/<s>/mod
//       /rooms/<s>/analytics -> /p/<s>/analytics · /rooms/<s>/audio -> /p/<s>/audio · /feed/c/<s> -> /p/<s>
//     (/feed?room=<x> is redirected by feedweb.js's /feed handler, which knows the feed's other params.)
//   - padHref / padSlug: the one way the site builds a pad link;
//   - padRefs: "p/<slug>" in post / comment text becomes a link to that pad (known pads only).
// The data layer keeps its old names (rooms.js, rooms_registry, /api/rooms/...): no churn there.
"use strict";

/** The slug a pad's links use: the bridge's (what Pepe posts) while it's bridged, else the registry's. */
function padSlug(R) {
  if (!R) return "";
  try { return require("./roomsweb").linkSlug(R); } catch (e) { return R.slug; }
}
/** "/p/<slug>" (+ an optional sub-page: "manage", "mod", "analytics", "audio"). R is a pad or a slug. */
function padHref(R, sub = "") {
  const slug = typeof R === "string" ? R : padSlug(R);
  return "/p/" + encodeURIComponent(String(slug || "").toLowerCase()) + (sub ? "/" + sub : "");
}
/** The query string of a request, "" or "?a=b" (kept verbatim through a redirect). */
function qsOf(req) {
  const u = String(req.originalUrl || req.url || "");
  const i = u.indexOf("?");
  return i >= 0 ? u.slice(i) : "";
}

/** A known pad by any of its slugs, synchronously (registry cache, then the bridge's slugs). */
function padBySlugSync(slug) {
  const s = String(slug || "").toLowerCase();
  if (!s) return null;
  const rooms = require("./rooms");
  let R = rooms.bySlugCached ? rooms.bySlugCached(s) : null;
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
    return `${pre}<a class="pad-ref" href="/p/${encodeURIComponent(s)}">p/${s}</a>`;
  });
}

function register(app) {
  const to = (path) => (req, res) => res.redirect(301, path(req) + qsOf(req));
  const enc = (req) => encodeURIComponent(String(req.params.slug || ""));
  app.get("/rooms", to(() => "/p"));
  app.get("/pads", to(() => "/p"));
  app.get("/rooms/admin", to(() => "/pads/admin"));
  app.get("/rooms/:slug", to((req) => "/p/" + enc(req)));
  app.get("/rooms/:slug/manage", to((req) => "/p/" + enc(req) + "/manage"));
  app.get("/rooms/:slug/feed/mod", to((req) => "/p/" + enc(req) + "/mod"));
  app.get("/rooms/:slug/analytics", to((req) => "/p/" + enc(req) + "/analytics"));
  app.get("/rooms/:slug/audio", to((req) => "/p/" + enc(req) + "/audio"));
  app.get("/feed/c/:slug", to((req) => "/p/" + enc(req)));
}

module.exports = { register, padSlug, padHref, padRefs, padBySlugSync, qsOf, PAD_REF_RE };
