// patvAuth.js - how the Twitch bot authenticates to the site (twitch.js). 1.99fy: the PATV user lookups
// (/api/users/twitch/...) are bot-only - the bot token rides an X-Bot-Token header on calls to
// BACKEND_BASE_URL/api/users/ (and nowhere else).
// 1.99acf (R-11, the per-caller key split; botkeys.js on the site): with PATV_KEY set (this bot's key from
// publicaccess.tv/admin/keys, "twitch.<secret>"), every axios request to BACKEND_BASE_URL's exact origin carries it as
// X-PATV-Key, and so do the /events streams (patvSse) and the !spin fetch (siteHeaders). The body passwords and
// X-Bot-Token stay for now.
//   * Only over https, or plain http to this machine (loopback): never in cleartext across a network.
//   * A redirect off the site drops it (axios: beforeRedirect). The eventsource package keeps custom headers on a
//     redirect, so the https / loopback rule is what protects the streams (the site never redirects /events).
//   * Requests to the site say User-Agent patv-twitch-bot/1, so the site's legacy-token counts (/admin/keys) tell this
//     bot from the Discord bot (both send the same shared token from loopback).
"use strict";

const UA = "patv-twitch-bot/1";
const LOOPBACK_RE = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;

const patvKey = () => String(process.env.PATV_KEY || "").trim();
/** Is url on the site itself (BACKEND_BASE_URL's exact origin - scheme, host and port)? */
const patvSite = (url) => { try { return new URL(String(url)).origin === new URL(String(process.env.BACKEND_BASE_URL || "")).origin; } catch (e) { return false; } };
/** R-11 review (SEC-1): does url's PATH hold a "." / ".." segment (literal, %2e - decoded twice - or behind a backslash)?
 *  The URL parser resolves those before the request leaves, so a chat name in a path could walk it onto another route: such
 *  a URL never gets a credential (it still goes out, as an anonymous visitor would). The query is not looked at. */
function hasDotSegments(url) {
  let p = String(url || "").replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "").split(/[?#]/)[0];
  for (let i = 0; i < 2; i++) {
    let q;
    try { q = decodeURIComponent(p); } catch (e) { break; }        // a stray "%": nothing more to decode
    if (q === p) break;
    p = q;
  }
  return p.replace(/\\/g, "/").split("/").some((s) => s === "." || s === "..");
}
/** May the key go to url? The site's exact origin, over https or to loopback - never a walked path. */
function keyAllowed(url) {
  if (!patvSite(url) || hasDotSegments(url)) return false;
  try { const u = new URL(String(url)); return u.protocol === "https:" || LOOPBACK_RE.test(u.hostname); } catch (e) { return false; }
}
/** Headers for a request to the site made without axios (fetch, EventSource): our User-Agent, + X-PATV-Key when allowed. */
function siteHeaders(url) {
  if (!patvSite(url)) return {};
  return Object.assign({ "User-Agent": UA }, patvKey() && keyAllowed(url) ? { "X-PATV-Key": patvKey() } : {});
}
/** EventSource options for a /events stream on the site, or {} for another host. */
function patvSse(url) {
  const h = siteHeaders(url);
  return Object.keys(h).length ? { headers: h } : {};
}
/** follow-redirects' options for the next hop: the key only stays on the site. */
function stripOffSite(opts) {
  if (!opts || !opts.headers) return;
  const href = opts.href || ((opts.protocol || "http:") + "//" + (opts.host || opts.hostname || "") + (opts.path || "/"));
  if (keyAllowed(href)) return;
  for (const h of Object.keys(opts.headers)) if (h.toLowerCase() === "x-patv-key") delete opts.headers[h];
}

/** The axios interceptor (once per axios instance). */
function install(axios) {
  if (axios.__patvBotAuth) return axios;
  axios.__patvBotAuth = true;
  axios.interceptors.request.use((cfg) => {
    const set = (name, value) => {
      if (cfg.headers && typeof cfg.headers.set === "function") cfg.headers.set(name, value);
      else cfg.headers = Object.assign({}, cfg.headers, { [name]: value });
    };
    const base = String(process.env.BACKEND_BASE_URL || "").replace(/\/+$/, "");
    const t = process.env.TWITCH_BOT_TOKEN;
    if (base && t && String(cfg.url || "").startsWith(base + "/api/users/") && !hasDotSegments(cfg.url)) set("X-Bot-Token", t);
    if (patvSite(cfg.url)) {
      set("User-Agent", UA);
      if (patvKey() && keyAllowed(cfg.url)) {
        set("X-PATV-Key", patvKey());
        const theirs = cfg.beforeRedirect;
        cfg.beforeRedirect = (opts, details) => { stripOffSite(opts); if (typeof theirs === "function") theirs(opts, details); };
      }
    }
    return cfg;
  });
  return axios;
}

module.exports = { install, patvKey, patvSite, keyAllowed, hasDotSegments, siteHeaders, patvSse, stripOffSite, UA };
