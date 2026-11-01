"use strict";
// Human-facing share links only; service and canonical URLs keep their own origin.
//
// pa.tv is the owner's short domain: Cloudflare 302-redirects every https://pa.tv/<path>?<query> (and www.pa.tv - the same
// rule covers both) to https://publicaccess.tv/<same path>?<same query>, ALWAYS - whether SHORT_LINK_BASE is set or not. So a
// pa.tv link someone pastes IS a publicaccess.tv link, and every "is this URL one of ours?" check goes through the helpers below
// (canonicalUrl / isAliasHost / ownAliasHosts) instead of keeping its own copy of the alias:
//   * dmembeds.hosts (DM post cards; embedcards.liveRef, the frozen-preview gate, reads the same list)
//   * linkpreview.checkUrl (the unfurler fetches publicaccess.tv itself, never pa.tv's 302 - feed previews, on-air cards)
//   * onairmedia.liveDenied (pa.tv can't go on Pepe's stream as a live page, like the site's own hosts)
//   * public/js/embed-cards.js (the feed's live cards - a browser copy of ALIAS_HOSTS, with the same staging rule)
// On staging pa.tv still points at PRODUCTION, so there a pa.tv link is prod's, not one of staging's own: aliasActive() is
// false and canonicalUrl() leaves it as it is.
// The CSRF / Origin checks, login ?next= (authGuard.safeNext: local paths only), the SIWE domain and e-mail links compare
// the host that SERVED the request - pa.tv never serves a page (it only redirects), so none of them accept it.
const CANONICAL = "https://publicaccess.tv";
const SHORT_ORIGINS = Object.freeze(["https://pa.tv"]);   // the only origins SHORT_LINK_BASE may name (never www.pa.tv)
// hosts that always redirect to CANONICAL (path + query kept): the Cloudflare rule is host in {pa.tv, www.pa.tv}. Keep the
// browser copy in public/js/embed-cards.js (ALIASES) the same - test/share-links-alias.test.js compares them.
const ALIAS_HOSTS = Object.freeze(["pa.tv", "www.pa.tv"]);

/** The short origin for human share links ("https://pa.tv"), or "" - off by default, never on staging, allow-listed. */
function activeBase() {
  if (process.env.STAGING || !process.env.SHORT_LINK_BASE) return "";
  const raw = String(process.env.SHORT_LINK_BASE).trim().toLowerCase().replace(/\/$/, "");
  return SHORT_ORIGINS.includes(raw) ? raw : "";
}
function shareBase() {
  return activeBase() || String(process.env.PUBLIC_BASE_URL || process.env.SITE_URL ||
    (process.env.STAGING ? "https://staging.publicaccess.tv" : CANONICAL)).replace(/\/+$/, "");
}
function shareUrl(path) { return shareBase() + "/" + String(path || "").replace(/^\/+/, ""); }

/** Is pa.tv one of THIS site's own hosts here? (prod / local: yes; staging: no - pa.tv points at prod) */
function aliasActive() { return !process.env.STAGING; }
/** A hostname (any case, one trailing dot allowed) that is a short alias of publicaccess.tv - regardless of staging. */
function isAliasHost(host) {
  const h = String(host == null ? "" : host).trim().toLowerCase().replace(/\.$/, "");
  return ALIAS_HOSTS.includes(h);
}
/** The alias hosts this site treats as its own (for host lists): ["pa.tv", "www.pa.tv"], or [] on staging. */
function ownAliasHosts() { return aliasActive() ? [...ALIAS_HOSTS] : []; }

/**
 * A pa.tv link -> the publicaccess.tv address it redirects to (path, query and fragment kept); anything else comes back
 * exactly as given. Only http(s), no user:password@, the default port only, the host exactly pa.tv or www.pa.tv (parsed the
 * way a browser parses it: pa.tv.evil.com, evilpa.tv, wwwpa.tv and pa.tv@evil.com are not pa.tv). opts.schemeless: also
 * "pa.tv/<path>" / "www.pa.tv/<path>" with no scheme (for the inputs that already take a scheme-less publicaccess.tv/<path>).
 * Off on staging.
 */
function canonicalUrl(input, opts = {}) {
  if (typeof input !== "string" || !aliasActive()) return input;
  let s = input.trim();
  if (!s) return input;
  if (!/^https?:\/\//i.test(s)) {
    if (!opts.schemeless || !/^(?:www\.)?pa\.tv\.?(?=[/?#]|$)/i.test(s)) return input;
    s = "https://" + s;
  }
  let u;
  try { u = new URL(s); } catch (e) { return input; }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password || u.port) return input;
  if (!isAliasHost(u.hostname)) return input;
  return CANONICAL + u.pathname + u.search + u.hash;
}
/** Is this a pa.tv link this site treats as its own? (canonicalUrl would rewrite it) */
function isOwnAlias(input, opts) { return typeof input === "string" && canonicalUrl(input, opts) !== input; }

module.exports = { CANONICAL, SHORT_ORIGINS, ALIAS_HOSTS, activeBase, shareBase, shareUrl,
                   aliasActive, isAliasHost, ownAliasHosts, canonicalUrl, isOwnAlias };
