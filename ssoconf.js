// ssoconf.js — "Sign-in methods" (1.99lb): which single-sign-on buttons /login and /register show.
//
//   Plex      plexsso.js     switch plex_sso (kept in mediaconf, where 1.99jr put it - plexhub.js reads it there)
//   Telegram  telegramsso.js switch telegram_sso (here) + TELEGRAM_BOT_TOKEN in .env (the Login Widget's bot)
//   Google    googlesso.js   switch google_sso (here) + GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env
//   Apple     applesso.js    switch apple_sso (here) + APPLE_SERVICES_ID / APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_PRIVATE_KEY
//                            (base64 of the .p8 PEM) in .env - all four, or the button stays hidden
//
// A switch is ON by default but a method only shows when its keys are configured too. The keys never leave the server:
// not in a page, a log line or a response (status() reports configured yes/no only).
// All the switches are on the admin card /admin/users#signin (GET/POST /api/admin/signin-methods, admins only).
//
//   sso_settings   k -> JSON value (only keys of DEFAULTS are read)
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

const DEFAULTS = { telegram_sso: true, google_sso: true, apple_sso: true };
const S = { ...DEFAULTS };
const TG_TOKEN_RE = /^(\d{3,15}):[A-Za-z0-9_-]{30,64}$/;

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS sso_settings (k TEXT PRIMARY KEY, v TEXT)");
      for (const r of await getQuery("SELECT k, v FROM sso_settings")) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULTS, r.k)) continue;
        try { S[r.k] = JSON.parse(r.v); } catch (e) { /* keep the default */ }
      }
    })().catch((e) => { ready = null; console.error("[ssoconf] init:", e.message); throw e; });
  }
  return ready;
}
const get = () => ({ ...S });

/** TELEGRAM_BOT_TOKEN when it looks like a BotFather token, else null. Never logged, never sent anywhere but HMAC. */
function telegramToken() {
  const t = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  return TG_TOKEN_RE.test(t) ? t : null;
}
/** The bot's numeric id (the token's public prefix - the Login Widget needs it), or null. */
function telegramBotId() {
  const t = telegramToken();
  return t ? TG_TOKEN_RE.exec(t)[1] : null;
}
const telegramConfigured = () => !!telegramToken();
function googleClient() {
  const id = String(process.env.GOOGLE_CLIENT_ID || "").trim();
  const secret = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
  return /^[A-Za-z0-9._-]{10,200}\.apps\.googleusercontent\.com$/.test(id) && secret.length >= 8 ? { id, secret } : null;
}
const googleConfigured = () => !!googleClient();

// Sign in with Apple (applesso.js): the Services ID (the web client id, reverse-DNS), the Team ID and the Key ID (10 upper-case
// letters / digits each, from developer.apple.com) and APPLE_PRIVATE_KEY = the downloaded AuthKey_<KeyID>.p8, base64-encoded
// (a raw PEM with \n escapes works too). It must be an EC P-256 private key (it signs the ES256 client secret). Parsed once per
// value; never logged and never sent anywhere - only signatures made with it leave the server.
let appleKeyMemo = { raw: null, key: null, fp: "" };
function appleKey(raw) {
  if (appleKeyMemo.raw === raw) return appleKeyMemo;
  const crypto = require("crypto");
  let key = null;
  try {
    const pem = /-----BEGIN/.test(raw) ? raw.split("\\n").join("\n") : Buffer.from(raw.replace(/\s+/g, ""), "base64").toString("utf8");
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) {
      const k = crypto.createPrivateKey({ key: pem, format: "pem" });
      const d = k.asymmetricKeyDetails || {};
      if (k.asymmetricKeyType === "ec" && (!d.namedCurve || d.namedCurve === "prime256v1")) key = k;
    }
  } catch (e) { key = null; }
  appleKeyMemo = { raw, key, fp: key ? crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16) : "" };
  return appleKeyMemo;
}
/** {servicesId, teamId, keyId, key (KeyObject), fp} when all four APPLE_* values are set and valid, else null. */
function appleClient() {
  const servicesId = String(process.env.APPLE_SERVICES_ID || "").trim();
  const teamId = String(process.env.APPLE_TEAM_ID || "").trim();
  const keyId = String(process.env.APPLE_KEY_ID || "").trim();
  const raw = String(process.env.APPLE_PRIVATE_KEY || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{2,199}$/.test(servicesId) || !/^[A-Z0-9]{10}$/.test(teamId) || !/^[A-Z0-9]{10}$/.test(keyId) || raw.length < 100) return null;
  const k = appleKey(raw);
  return k.key ? { servicesId, teamId, keyId, key: k.key, fp: k.fp } : null;
}
const appleConfigured = () => !!appleClient();
function plexOn() { try { return require("./plexsso").enabled(); } catch (e) { return false; } }

const on = {
  telegram: () => S.telegram_sso !== false && telegramConfigured(),
  google: () => S.google_sso !== false && googleConfigured(),
  apple: () => S.apple_sso !== false && appleConfigured(),
  plex: plexOn,
};

/** For the admin card: switches + whether the keys are there (never the keys). */
function status() {
  let plexSwitch = true;
  try { plexSwitch = require("./mediaconf").get().plex_sso !== false; } catch (e) { /* default */ }
  return {
    plex: { switch: plexSwitch, configured: true, on: plexOn() },
    telegram: { switch: S.telegram_sso !== false, configured: telegramConfigured(), on: on.telegram() },
    google: { switch: S.google_sso !== false, configured: googleConfigured(), on: on.google() },
    apple: { switch: S.apple_sso !== false, configured: appleConfigured(), on: on.apple() },
  };
}

/** Save switches {telegram_sso, google_sso, apple_sso, plex_sso} (booleans; anything else ignored). -> status() */
async function set(patch, actor) {
  await init();
  const p = patch || {};
  const b = (v) => v === true || v === "on" || v === "true" || v === 1 || v === "1";
  for (const k of Object.keys(DEFAULTS)) {
    if (!(k in p)) continue;
    const v = b(p[k]);
    if (S[k] === v) continue;
    S[k] = v;
    await runQuery("INSERT INTO sso_settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [k, JSON.stringify(v)]);
    console.log(`[ssoconf] ${k} = ${v} by ${actor || "?"}`);
  }
  if ("plex_sso" in p) {
    const conf = require("./mediaconf");
    await conf.init();
    await conf.set({ plex_sso: b(p.plex_sso) }, actor);
  }
  return status();
}

function register(app, { addUser }) {
  init().catch(() => {});
  const guard = require("./middleware/authGuard");
  const admin = async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    const row = (await getQuery("SELECT class FROM users WHERE userId = ?", [req.user.userId]).catch(() => []))[0];
    if (!SP.can(row, "auth.signin_methods")) return res.status(403).json({ ok: false, error: "Admins only." });
    if (req.method === "POST" && (!guard.sameSite(req) || req.get("X-Requested-With") !== "fetch")) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    next();
  };
  // + Apple's notification health (applesso.noticeHealth: APPLE_APP_ID set? the newest accepted / refused one)
  const withHealth = async (st) => {
    if (st.apple && st.apple.configured) { try { st.apple.notices = await require("./applesso").noticeHealth(); } catch (e) { /* none */ } }
    return st;
  };
  app.get("/api/admin/signin-methods", addUser, admin, async (req, res) => {
    try { await init(); res.json({ ok: true, ...(await withHealth(status())) }); } catch (e) { res.status(500).json({ ok: false, error: "Couldn't load the sign-in methods." }); }
  });
  app.post("/api/admin/signin-methods", addUser, admin, async (req, res) => {
    try { res.json({ ok: true, ...(await withHealth(await set(req.body || {}, req.user.username))) }); }
    catch (e) { console.error("[ssoconf] save:", e.message); res.status(500).json({ ok: false, error: "Couldn't save." }); }
  });
}

module.exports = { init, get, set, status, on, register, telegramToken, telegramBotId, telegramConfigured, googleClient, googleConfigured,
                   appleClient, appleConfigured, DEFAULTS };
