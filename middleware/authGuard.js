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
function sameSite(req) {
  const host = req.get("host");
  const src = req.get("origin") || req.get("referer");
  if (!src || !host) return true;
  try {
    return new URL(src).host === host;
  } catch (e) {
    return false;
  }
}

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
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,24}$/;

/** null when fine, else a message. */
function checkUsername(u, req) {
  const s = String(u == null ? "" : u).trim();
  if (!s) return tr(req, "auth.err.choose_username", "Choose a username.");
  if (!USERNAME_RE.test(s)) return tr(req, "auth.err.username_chars", "Usernames are 3-24 characters: letters, numbers, dot, dash or underscore.");
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
