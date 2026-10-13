// googlesso.js — "Sign in with Google" on /login and /register + link / unlink on Edit profile → Connections (1.99lb).
//
// OpenID Connect, authorization code flow + PKCE (S256):
//   GET  /auth/google              (sign in)       \  a fresh state, nonce and PKCE verifier IN THIS BROWSER'S SESSION
//   POST /auth/google/link         (signed in, link) /  (single use, 10 minutes) -> accounts.google.com, scope openid email profile
//   GET  /auth/google/callback     state must match (timing-safe), then the code + verifier go to Google's token endpoint
//                                  (with the client secret); the ID token that comes back is VERIFIED here anyway:
//                                  RS256 signature against Google's JWKS (kid), iss accounts.google.com, aud = our client
//                                  id (azp too when aud is a list), exp / iat with 60 s skew, nonce = the session's.
//                                  The access token is never used or stored.
//   The identity is the ID token's `sub` - NEVER the email (emails change hands; Google says so). Links are proven links:
//   ssolinks sso_links provider 'google', link_source 'self', proof 'oidc'.
//     linked     -> user.controller finishLogin (the shared sign-in finish)
//     not yet    -> /auth/sso/new (ssolinks.js): create an account or "I already have an account" - like Plex
//     link mode  -> linked to the signed-in account that started it (the session's user must still be the same)
//   Never auto-linked by email, verified or not. A new account gets Google's email (marked verified only when Google says
//   email_verified) only if no other PATV account uses it - createSsoAccount.
//
// Configure: GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET in .env (see .env.example); redirect URI = <site>/auth/google/callback.
// Switch: ssoconf google_sso (default on), effective only when configured.
"use strict";
const crypto = require("crypto");
const conf = require("./ssoconf");
const sso = require("./ssolinks");
const guard = require("./middleware/authGuard");

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const TTL = 10 * 60 * 1000;
const SKEW_S = 60;
let clock = () => Date.now();

// HTTP (tests swap it): post(url, form) / get(url) -> {status, data, headers}
let http = {
  async post(url, form) {
    const axios = require("axios");
    const r = await axios.post(url, new URLSearchParams(form).toString(), { headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 10000, validateStatus: () => true });
    return { status: r.status, data: r.data, headers: r.headers || {} };
  },
  async get(url) {
    const axios = require("axios");
    const r = await axios.get(url, { timeout: 10000, validateStatus: () => true });
    return { status: r.status, data: r.data, headers: r.headers || {} };
  },
};

const startLimit = guard.limiter({ max: 12, windowMs: 15 * 60 * 1000 });
const callbackLimit = guard.limiter({ max: 30, windowMs: 15 * 60 * 1000 });

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
function site() {
  return String(process.env.PUBLIC_BASE_URL || process.env.SITE_URL || (process.env.STAGING ? "https://staging.publicaccess.tv" : "https://publicaccess.tv")).replace(/\/+$/, "");
}
const redirectUri = () => site() + "/auth/google/callback";
function enabled() { return conf.on.google(); }

// ── Google's signing keys (JWKS), cached per Cache-Control max-age; an unknown kid refetches at most once a minute ──
let jwks = { keys: new Map(), until: 0, fetchedAt: 0 };
async function loadJwks(force) {
  const t = clock();
  if (!force && jwks.until > t && jwks.keys.size) return jwks.keys;
  if (force && t - jwks.fetchedAt < 60e3 && jwks.keys.size) return jwks.keys;
  const r = await http.get(JWKS_URL);
  if (r.status !== 200 || !r.data || !Array.isArray(r.data.keys)) throw new Error(`jwks answered ${r.status}`);
  const keys = new Map();
  for (const k of r.data.keys) {
    if (!k || k.kty !== "RSA" || !k.kid || (k.use && k.use !== "sig")) continue;
    try { keys.set(String(k.kid), crypto.createPublicKey({ key: { kty: "RSA", n: k.n, e: k.e }, format: "jwk" })); } catch (e) { /* skip a bad key */ }
  }
  const cc = String((r.headers && (r.headers["cache-control"] || r.headers["Cache-Control"])) || "");
  const maxAge = Math.min(Math.max(Number((/max-age=(\d+)/.exec(cc) || [])[1]) || 3600, 60), 86400);
  jwks = { keys, until: t + maxAge * 1000, fetchedAt: t };
  return keys;
}
async function keyFor(kid) {
  let keys = await loadJwks(false);
  if (!keys.has(kid)) keys = await loadJwks(true);
  return keys.get(kid) || null;
}

class Bad extends Error { constructor(code) { super(code); this.code = code; } }
/**
 * Verify a Google ID token. -> the claims. Throws Bad(code): E_FORMAT, E_ALG, E_KID, E_SIG, E_ISS, E_AUD, E_EXP, E_IAT, E_NONCE, E_SUB.
 * opts: {clientId, nonce, now, getKey(kid) -> KeyObject|null}
 */
async function verifyIdToken(idToken, { clientId, nonce, now = clock(), getKey = keyFor } = {}) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Bad("E_FORMAT");
  let header, claims;
  try { header = JSON.parse(fromB64url(parts[0]).toString("utf8")); claims = JSON.parse(fromB64url(parts[1]).toString("utf8")); }
  catch (e) { throw new Bad("E_FORMAT"); }
  if (!header || header.alg !== "RS256") throw new Bad("E_ALG");
  if (!header.kid || typeof header.kid !== "string") throw new Bad("E_KID");
  const key = await getKey(header.kid);
  if (!key) throw new Bad("E_KID");
  const ok = crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), key, fromB64url(parts[2]));
  if (!ok) throw new Bad("E_SIG");
  if (!claims || typeof claims !== "object") throw new Bad("E_FORMAT");
  if (!ISSUERS.includes(claims.iss)) throw new Bad("E_ISS");
  const aud = claims.aud;
  if (Array.isArray(aud) ? !(aud.includes(clientId) && claims.azp === clientId) : aud !== clientId) throw new Bad("E_AUD");
  if (claims.azp !== undefined && claims.azp !== clientId) throw new Bad("E_AUD");
  const nowS = Math.floor(now / 1000);
  if (!Number.isFinite(Number(claims.exp)) || Number(claims.exp) + SKEW_S < nowS) throw new Bad("E_EXP");
  if (!Number.isFinite(Number(claims.iat)) || Number(claims.iat) - SKEW_S > nowS) throw new Bad("E_IAT");
  const n = typeof claims.nonce === "string" ? claims.nonce : "";
  if (!nonce || n.length !== nonce.length || !crypto.timingSafeEqual(Buffer.from(n), Buffer.from(nonce))) throw new Bad("E_NONCE");
  if (typeof claims.sub !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(claims.sub)) throw new Bad("E_SUB");
  return claims;
}

/** The code -> verified claims (the access token is dropped unused). */
async function exchange(code, st) {
  const c = conf.googleClient();
  if (!c) throw new Error("not configured");
  const r = await http.post(TOKEN_URL, { code: String(code), client_id: c.id, client_secret: c.secret, redirect_uri: redirectUri(),
                                         grant_type: "authorization_code", code_verifier: st.verifier });
  if (r.status !== 200 || !r.data || typeof r.data.id_token !== "string") throw new Error(`token endpoint answered ${r.status}`);
  return verifyIdToken(r.data.id_token, { clientId: c.id, nonce: st.nonce });
}

function who(claims) {
  const email = typeof claims.email === "string" && claims.email.length <= 254 ? claims.email : null;
  const name = typeof claims.name === "string" ? claims.name.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 64) : "";
  const local = email ? email.split("@")[0] : "";
  return { provider: "google", subject: claims.sub, email, email_verified: claims.email_verified === true || claims.email_verified === "true",
           name, username: (typeof claims.given_name === "string" && claims.given_name) || name || local, handle: null };
}

// the shared flow's Google provider
sso.provider("google", {
  label: "Google",
  icon: "G",
  readsEmail: true,
  linkedUser: (subject) => sso.linkedUser("google", subject),
  async linkTo(user, p) {
    await sso.addLink("google", user.userId, { subject: p.subject, proof: "oidc", email: p.email, name: p.name });
    await sso.notifyLinked(user, "Google", p.email || p.name || "");
  },
});

const tr = (req, key, en, vars) => (req && typeof req.t === "function" ? req.t(key, vars) : en);

function register(app, { addUser }) {
  conf.init().catch(() => {});
  const fail = (req, res, key, en, back) => { req.flash("error", tr(req, key, en)); return res.redirect(back || "/login"); };
  const editPage = (u) => "/settings/account#connections";   // 1.99vz: Connections live on Settings -> Account

  async function start(req, res, mode) {
    res.set("Cache-Control", "no-store");
    await conf.init().catch(() => {});
    const back = mode === "link" ? editPage(req.user) : "/login";
    if (!enabled()) return fail(req, res, "auth.sso.off", "That sign-in method isn't available right now.", back);
    // the session cookie is per host: start on the host Google will send them back to
    try { const s = new URL(site()); if (mode !== "link" && req.get("host") && s.host !== req.get("host")) return res.redirect(s.origin + req.originalUrl); }
    catch (e) { /* bad config: carry on */ }
    const ip = guard.clientIp(req);
    if (startLimit.blocked(ip)) return fail(req, res, "auth.sso.slow_down", "Too many sign-ins from your network. Try again in a few minutes.", back);
    startLimit.hit(ip);
    const verifier = b64url(crypto.randomBytes(32));
    const st = { state: crypto.randomBytes(24).toString("hex"), nonce: b64url(crypto.randomBytes(24)), verifier, at: clock(),
                 next: mode === "link" ? "" : guard.safeNext(req.query.next) || "", mode, uid: mode === "link" ? req.user.userId : null };
    req.session.googleSso = st;
    const url = AUTH_URL + "?" + new URLSearchParams({ client_id: conf.googleClient().id, redirect_uri: redirectUri(), response_type: "code",
      scope: "openid email profile", state: st.state, nonce: st.nonce, code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256", prompt: "select_account" }).toString();
    return res.redirect(url);
  }

  app.get("/auth/google", addUser, (req, res) => {
    if (req.user && req.user.username) return res.redirect(editPage(req.user));
    return start(req, res, "signin");
  });
  app.post("/auth/google/link", addUser, (req, res) => {
    if (!guard.sameSite(req)) return res.status(403).send("Cross-site request refused");
    if (!req.user || !req.user.userId) return res.redirect("/login");
    return start(req, res, "link");
  });

  app.get("/auth/google/callback", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const st = req.session && req.session.googleSso;
    if (req.session) delete req.session.googleSso;                     // single use, whatever happens next
    const back = st && st.mode === "link" && req.user ? editPage(req.user) : "/login";
    if (req.query.error) return fail(req, res, "auth.google.cancelled", "Google sign-in was cancelled.", back);
    const got = typeof req.query.state === "string" ? req.query.state : "";
    if (!st || !st.state || Number(st.at) <= 0 || clock() - Number(st.at) > TTL || got.length !== st.state.length ||
        !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(st.state)) || typeof req.query.code !== "string" || !req.query.code)
      return fail(req, res, "auth.sso.expired", "That sign-in expired or didn't start here. Please try again.", back);
    if (!enabled()) return fail(req, res, "auth.sso.off", "That sign-in method isn't available right now.", back);
    const ip = guard.clientIp(req);
    if (callbackLimit.blocked(ip)) return fail(req, res, "auth.sso.slow_down", "Too many sign-ins from your network. Try again in a few minutes.", back);
    callbackLimit.hit(ip);
    let claims;
    try { claims = await exchange(req.query.code, st); }
    catch (e) {
      console.error("[googlesso] verify:", e && (e.code || e.message));
      return fail(req, res, "auth.google.failed", "Google sign-in didn't work. Please try again.", back);
    }
    const w = who(claims);
    try {
      if (st.mode === "link") {
        if (!req.user || req.user.userId !== st.uid) return fail(req, res, "auth.sso.expired", "That sign-in expired or didn't start here. Please try again.", "/login");
        try {
          await sso.addLink("google", req.user.userId, { subject: w.subject, proof: "oidc", email: w.email, name: w.name });
          await sso.notifyLinked(req.user, "Google", w.email || w.name || "");
          req.flash("success", tr(req, "settings.connections.google_linked", "Google is linked. You can sign in with it now."));
        } catch (e) {
          if (!e.refuse) throw e;
          req.flash("error", e.message);
        }
        return res.redirect(editPage(req.user));
      }
      if (req.user && req.user.username) return res.redirect(editPage(req.user));
      return res.redirect(await sso.signInOrPark(req, res, w, st.next));
    } catch (e) {
      console.error("[googlesso] callback:", e && e.message);
      return fail(req, res, "auth.google.failed", "Google sign-in didn't work. Please try again.", back);
    }
  });

  app.post("/api/sso/google/unlink", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!guard.sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      if (!(await sso.linkOf("google", req.user.userId))) return res.json({ ok: true, removed: false });
      await sso.guardUnlink(req.user.userId, "google");
      res.json({ ok: true, removed: await sso.removeLink("google", req.user.userId) });
    } catch (e) {
      if (e && e.refuse) return res.status(e.status).json({ ok: false, error: e.message, code: e.code });
      console.error("[googlesso] unlink:", e && e.message);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });
}

module.exports = {
  register, verifyIdToken, enabled, redirectUri, who, ISSUERS, TTL,
  _setHttp: (h) => { http = h; jwks = { keys: new Map(), until: 0, fetchedAt: 0 }; },
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
};
