// authGuard.js - shared helpers for the sign-in / register / password-reset pages.
//
//   safeNext(v)        a "return to" path that can only ever point back into this site
//   sameSite(req)      the site's Origin/Referer CSRF check (same as cosmetics.js / profilelayout.js)
//   limiter(opts)      a small in-memory fixed-window rate limiter (per process; fine for one VPS)
//   clientIp(req)      the caller's IP behind Cloudflare / the local proxy
//   checkUsername / checkPassword / checkEmail   the rules for NEW accounts and NEW passwords
//   undeliverable(e)   reserved test domains (example.*, *.invalid, *.test, ...) - never emailed
//
// Nothing here touches the login cookie (middleware/loginCookie.js) or password hashing.

// ---------------------------------------------------------------------------------------------
// Return-to paths
// ---------------------------------------------------------------------------------------------
const AUTH_PATHS = /^\/(login|register|logout|forgot-password|reset-password|auth\/|verify-email|resolve-|merge-accounts)/i;

/** A local path ("/wallet?tab=x") or null. Never "//host", "/\host", a scheme, or an auth page. */
function safeNext(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s || s.length > 512) return null;
  if (s[0] !== "/" || s[1] === "/" || s[1] === "\\") return null;
  if (/[\\\u0000-\u001f\u007f]/.test(s)) return null;
  let parsed;
  try {
    parsed = new URL(s, "http://local.invalid");
  } catch (e) {
    return null;
  }
  if (parsed.host !== "local.invalid") return null;
  if (AUTH_PATHS.test(parsed.pathname)) return null;
  const out = parsed.pathname + parsed.search + parsed.hash;
  // "/..//evil.com" normalises to "//evil.com" - a protocol-relative URL - so check again
  if (out[0] !== "/" || out[1] === "/" || out[1] === "\\") return null;
  return out;
}

/** The page the visitor came from (Referer), when it's this site and not an auth page. */
function refererNext(req) {
  const ref = req.get("referer");
  const host = req.get("host");
  if (!ref || !host) return null;
  try {
    const u = new URL(ref);
    if (u.host !== host) return null;
    return safeNext(u.pathname + u.search);
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// CSRF: same check as the rest of the site. The login cookie is SameSite=Lax; this is a second
// check for browsers that send Origin/Referer (they all do on form POSTs).
// ---------------------------------------------------------------------------------------------
// 1.99zl: hosts compare without a leading "www." (publicaccess.tv and www.publicaccess.tv are one site),
// case-insensitively. staging.publicaccess.tv stays separate from prod.
const siteHost = (h) => String(h || "").trim().toLowerCase().replace(/^www\./, "");
function hostMatches(srcUrl, host) {
  try {
    const h = siteHost(host);
    return !!h && siteHost(new URL(srcUrl).host) === h;
  } catch (e) {
    return false;
  }
}

function sameSite(req) {
  const host = req.get("host");
  const src = req.get("origin") || req.get("referer");
  if (!src || !host) return true;
  return hostMatches(src, host);   // "Origin: null" (opaque) is refused here - JSON/fetch APIs stay strict
}

/**
 * 1.99zl: where an auth FORM post came from - "same", "foreign", or "opaque" (no usable source: Origin
 * absent or "null" and no Referer). Browsers send "Origin: null" on a POST from a page served with
 * Referrer-Policy: no-referrer (the reset page used to be), from privacy modes and from some in-app
 * webviews (Gmail / Instagram / Facebook) - an opaque origin is not evidence of a cross-site post.
 */
function originState(req) {
  const host = req.get("host");
  if (!host) return "opaque";
  const origin = req.get("origin");
  if (origin && origin !== "null") return hostMatches(origin, host) ? "same" : "foreign";
  const ref = req.get("referer");
  if (ref) return hostMatches(ref, host) ? "same" : "foreign";
  return "opaque";
}

// Per-form token (double submit): a random value in a signed, httpOnly, SameSite=Lax cookie and the same value
// in a hidden field. A cross-site POST never carries a Lax cookie, so a matching pair proves the form came from
// a page of this site even when the browser hides the origin.
const FORM_COOKIE = "au_ft";
const FORM_TTL_MS = 2 * 3600 * 1000;
const FORM_RE = /^[a-f0-9]{32}$/;
function cookieValue(req) {
  const v = (req.signedCookies && req.signedCookies[FORM_COOKIE]) || null;
  return typeof v === "string" && FORM_RE.test(v) ? v : null;
}
/** The token for this visitor (reused while the cookie lives), setting the cookie when it's new. */
function formToken(req, res) {
  let v = cookieValue(req);
  if (!v) v = require("crypto").randomBytes(16).toString("hex");
  const secure = !!(req.secure || String(req.get("x-forwarded-proto") || "").split(",")[0].trim() === "https");
  try {
    res.cookie(FORM_COOKIE, v, { signed: true, httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: FORM_TTL_MS });
  } catch (e) {
    return null;   // no cookie secret - the form simply goes without a token
  }
  return v;
}
/** Express middleware for the auth pages: res.locals.authFormToken for the hidden "_ft" field. */
function formTokenMw(req, res, next) {
  res.locals.authFormToken = formToken(req, res);
  next();
}
function formTokenOk(req) {
  const c = cookieValue(req);
  const b = req.body && typeof req.body._ft === "string" ? req.body._ft : "";
  if (!c || !FORM_RE.test(b)) return false;
  return require("crypto").timingSafeEqual(Buffer.from(c), Buffer.from(b));
}

/**
 * The CSRF check for the unauthenticated auth forms (sign-in, sign-up, forgot / reset password).
 * same-site source: yes. foreign source: no. opaque: yes with a valid form token, yes when the browser
 * sent neither Origin nor Referer (as sameSite() always allowed), and for "Origin: null" without a token
 * only with opts.lowValue (forgot-password only mails the address typed; reset needs the secret token in
 * its URL).
 */
function authFormOk(req, opts) {
  const s = originState(req);
  if (s === "same") return true;
  if (s === "foreign") return false;
  if (formTokenOk(req)) return true;
  if (!req.get("origin")) return true;
  return !!(opts && opts.lowValue);
}

const FORM_REFUSED = "We couldn't confirm this form came from publicaccess.tv. Please open the link in your regular browser (Chrome, Safari or Firefox) and try again.";

// ---------------------------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------------------------
// 1.99cf: proxy headers are only believed when the TCP peer is this box (nginx on 127.0.0.1 / ::1). The app
// listens on loopback only (BIND_HOST), but if it were ever reachable directly, a caller could otherwise write
// any CF-Connecting-IP / X-Forwarded-For it liked and dodge the rate limits, the welcome-bonus dedupe and the
// abuse metadata. Behind nginx: CF-Connecting-IP (Cloudflare sets it), else the LAST X-Forwarded-For hop (the
// one nginx appended = its own peer; earlier hops are whatever the client sent), else the socket.
const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;
const isLoopback = (a) => LOOPBACK.test(String(a || ""));
const peerOf = (req) => (req && req.socket && req.socket.remoteAddress) || "";
/** {ip, via}: via is "cf" | "xff" (trusted proxy headers) or "direct" (the socket address). */
function clientAddr(req) {
  const peer = peerOf(req);
  if (isLoopback(peer)) {
    const h = (k) => { try { return req.get(k) || ""; } catch (e) { return ""; } };
    const cf = String(h("cf-connecting-ip")).trim();
    if (cf) return { ip: cf, via: "cf" };
    const hops = String(h("x-forwarded-for")).split(",").map((s) => s.trim()).filter(Boolean);
    if (hops.length) return { ip: hops[hops.length - 1], via: "xff" };
  }
  return { ip: peer || "?", via: "direct" };
}
function clientIp(req) {
  return clientAddr(req).ip;
}

/**
 * Fixed-window counter: hit(key) counts one, blocked(key) says whether the key is over `max` in
 * the current `windowMs`, and how long until it clears. reset(key) forgets it (a good login).
 */
function limiter({ max, windowMs }) {
  const hits = new Map(); // key -> { n, until }
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.until <= now) hits.delete(k);
  }, Math.min(windowMs, 10 * 60 * 1000));
  if (sweep.unref) sweep.unref();
  return {
    hit(key) {
      const now = Date.now();
      const cur = hits.get(key);
      if (!cur || cur.until <= now) hits.set(key, { n: 1, until: now + windowMs });
      else cur.n += 1;
    },
    blocked(key) {
      const cur = hits.get(key);
      if (!cur || cur.until <= Date.now()) return 0;
      return cur.n >= max ? Math.max(1, Math.ceil((cur.until - Date.now()) / 1000)) : 0;
    },
    reset(key) {
      hits.delete(key);
    },
  };
}

// i18n: the optional trailing `req` translates the message (req.t is set by i18n.js); without it, English.
const tr = (req, key, en, vars) => (req && typeof req.t === "function" ? req.t(key, vars) : en);

function waitText(sec, req) {
  const m = Math.ceil(sec / 60);
  return m <= 1 ? tr(req, "auth.err.wait_minute", "a minute") : tr(req, "auth.err.wait_minutes", `${m} minutes`, { n: m });
}

// ---------------------------------------------------------------------------------------------
// Rules for new accounts / new passwords
// ---------------------------------------------------------------------------------------------
// 1.99ui: 3..usernamerules.USERNAME_MAX (48) characters - was 24; the same limit the site recognises in @mentions / u/ refs
const { NEW_USERNAME_RE: USERNAME_RE } = require("../usernamerules");

/** null when fine, else a message. */
function checkUsername(u, req) {
  const s = String(u == null ? "" : u).trim();
  if (!s) return tr(req, "auth.err.choose_username", "Choose a username.");
  if (!USERNAME_RE.test(s)) return tr(req, "auth.err.username_chars", "Usernames are 3-48 characters: letters, numbers, dot, dash or underscore.");
  if (/^[._-]|[._-]$/.test(s)) return tr(req, "auth.err.username_ends", "Usernames can't start or end with a dot, dash or underscore.");
  // "CF..." names are Pepe's automatic Camfrog accounts (see completeCamfrogLink): a real account
  // named like that could be mistaken for one and merged away.
  if (/^cf/i.test(s)) return tr(req, "auth.err.username_cf", "Usernames starting with “CF” are reserved for Camfrog accounts.");
  return null;
}

function checkPassword(p, username, req) {
  const s = String(p == null ? "" : p);
  if (s.length < 8) return tr(req, "auth.err.short_password", "Use at least 8 characters for your password.");
  if (Buffer.byteLength(s, "utf8") > 72) return tr(req, "auth.err.long_password", "That password is too long (72 bytes max).");
  if (username && s.toLowerCase() === String(username).trim().toLowerCase()) return tr(req, "auth.err.password_is_username", "Your password can't be your username.");
  return null;
}

function checkEmail(e, req) {
  const s = String(e == null ? "" : e).trim();
  if (!s) return tr(req, "auth.err.enter_email", "Enter your email address.");
  if (s.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return tr(req, "auth.err.bad_email", "That doesn't look like an email address.");
  return null;
}

/** Reserved / test domains (RFC 2606, RFC 6761): never send mail to these. */
function undeliverable(email) {
  const d = String(email || "").trim().toLowerCase().split("@")[1] || "";
  if (!d) return true;
  return /(^|\.)(invalid|test|example|localhost|local)$/.test(d) || /^example\.(com|net|org)$/.test(d);
}

module.exports = {
  safeNext,
  refererNext,
  sameSite,
  originState,
  authFormOk,
  formToken,
  formTokenMw,
  FORM_REFUSED,
  clientIp,
  clientAddr,
  isLoopback,
  limiter,
  waitText,
  checkUsername,
  checkPassword,
  checkEmail,
  undeliverable,
};
