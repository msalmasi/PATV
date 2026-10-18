// backendAuth.js - 1.99fy: the PATV user lookups (/api/users/discord/:id ...) are bot-only now. This adds
// the bot token, as an X-Bot-Token header, to this process's axios calls to BACKEND_BASE_URL/api/users/
// - nowhere else. Loaded by userUtils.js, so the Discord bot AND blackjack (which runs from its own
// folder, whose .env has no token) both get it.
// 1.99acf (R-11, the per-caller key split; botkeys.js on the site): when PATV_KEY is set (this bot's key from
// publicaccess.tv/admin/keys, "discord.<secret>"), EVERY axios request to BACKEND_BASE_URL's exact origin carries it as
// X-PATV-Key (never another host or a look-alike; /chattip and the spin calls ride along), and the /events
// streams and the odd fetch() get it through sseHeaders() / siteHeaders(). The body passwords and X-Bot-Token stay
// until the site retires the shared tokens.
//   * Only over https, or plain http to this machine (loopback): never in cleartext across a network.
//   * A redirect off the site drops it (axios: beforeRedirect). The eventsource package keeps custom headers on a
//     redirect, so the https / loopback rule above is what protects the streams (the site never redirects /events).
//   * Requests to the site carry a User-Agent of their own (patv-discord-bot/1, blackjack: patv-blackjack/1), so the
//     site's legacy-token counts (/admin/keys) tell this bot from the Twitch bot.
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const UA = /blackjack/i.test(String((require.main && require.main.filename) || process.cwd())) ? "patv-blackjack/1" : "patv-discord-bot/1";

function envFileValue(name) {
  // blackjack's cwd is ../blackjack: read the value from this bot's own .env (never logged)
  try {
    const m = new RegExp("^\\s*" + name + "\\s*=\\s*(.*?)\\s*$", "m").exec(fs.readFileSync(path.join(__dirname, ".env"), "utf8"));
    if (m && m[1]) return m[1].replace(/^(['"])(.*)\1$/, "$2");
  } catch (e) { /* no .env next to the bot */ }
  return null;
}

let cached;
function token() {
  if (cached !== undefined) return cached;
  cached = process.env.DISCORD_BOT_TOKEN || envFileValue("DISCORD_BOT_TOKEN") || null;
  if (!cached) console.error("[backendAuth] no DISCORD_BOT_TOKEN - PATV user lookups will be refused");
  return cached;
}

let cachedKey;
/** This bot's PATV caller key (PATV_KEY), or null. */
function key() {
  if (cachedKey !== undefined) return cachedKey;
  cachedKey = String(process.env.PATV_KEY || envFileValue("PATV_KEY") || "").trim() || null;
  return cachedKey;
}

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

function isLookup(url) {
  const base = String(process.env.BACKEND_BASE_URL || "").replace(/\/+$/, "");
  return !!base && String(url || "").startsWith(base + "/api/users/") && !hasDotSegments(url);
}

/** Is url on the site itself (BACKEND_BASE_URL's exact origin - scheme, host and port)? */
function isSite(url) {
  try { return new URL(String(url)).origin === new URL(String(process.env.BACKEND_BASE_URL || "")).origin; } catch (e) { return false; }
}

const LOOPBACK_RE = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i;
/** May the key go to url? The site's exact origin, over https or to loopback. */
function keyAllowed(url) {
  if (!isSite(url) || hasDotSegments(url)) return false;
  try { const u = new URL(String(url)); return u.protocol === "https:" || LOOPBACK_RE.test(u.hostname); } catch (e) { return false; }
}

/** Headers for a request to the site made without axios (fetch, EventSource): our User-Agent, + X-PATV-Key when allowed. */
function siteHeaders(url) {
  if (!isSite(url)) return {};
  const k = key();
  return Object.assign({ "User-Agent": UA }, k && keyAllowed(url) ? { "X-PATV-Key": k } : {});
}

/** EventSource options for a /events stream on the site: {headers: {User-Agent, X-PATV-Key?}}, or {} for another host. */
function sseHeaders(url) {
  const h = siteHeaders(url);
  return Object.keys(h).length ? { headers: h } : {};
}

function setHeader(cfg, name, value) {
  if (cfg.headers && typeof cfg.headers.set === "function") cfg.headers.set(name, value);
  else cfg.headers = Object.assign({}, cfg.headers, { [name]: value });
}

/** follow-redirects' options for the next hop: the key only stays on the site (axios keeps custom headers otherwise). */
function stripOffSite(opts) {
  if (!opts || !opts.headers) return;
  const href = opts.href || ((opts.protocol || "http:") + "//" + (opts.host || opts.hostname || "") + (opts.path || "/"));
  if (keyAllowed(href)) return;
  for (const h of Object.keys(opts.headers)) if (h.toLowerCase() === "x-patv-key") delete opts.headers[h];
}

if (!axios.__patvBotAuth) {
  axios.__patvBotAuth = true;
  axios.interceptors.request.use((cfg) => {
    if (isLookup(cfg.url)) {
      const t = token();
      if (t) setHeader(cfg, "X-Bot-Token", t);
    }
    if (isSite(cfg.url)) {
      setHeader(cfg, "User-Agent", UA);
      const k = key();
      if (k && keyAllowed(cfg.url)) {
        setHeader(cfg, "X-PATV-Key", k);
        const theirs = cfg.beforeRedirect;
        cfg.beforeRedirect = (opts, details) => { stripOffSite(opts); if (typeof theirs === "function") theirs(opts, details); };
      }
    }
    return cfg;
  });
}

module.exports = { token, key, isLookup, isSite, keyAllowed, hasDotSegments, siteHeaders, sseHeaders, stripOffSite, UA };
