// i18n.js - 1.99jo: the site in many languages.
//
// Catalogs: locales/<code>.json, flat "area.name" keys -> HTML-safe text (see i18n-core.js for the format).
// English (locales/en.json) is the source and the fallback; the others are machine translations
// ("_meta": {"machine": true}) waiting for human review. Admin pages stay English.
//
// The language for a request, first match wins:
//   1. a signed-in user's saved preference (user_language table; Edit profile -> Language, or /lang/<code>)
//   2. the patv_lang cookie (the footer / More-menu switcher sets it)
//   3. the Accept-Language header
//   4. English
// Views get res.locals.t / lang / dir / i18nLangs; client JS gets window.PATV_I18N (layout.ejs) with the
// "js.*" strings, or fetches /i18n/<code>.json.
"use strict";
const fs = require("fs");
const path = require("path");
const makeT = require("./i18n-core");

// code, native name, English name. Order = the switcher's order.
const LANGS = [
  ["en", "English", "English"],
  ["es", "Español", "Spanish"],
  ["pt-BR", "Português (Brasil)", "Portuguese (Brazil)"],
  ["fr", "Français", "French"],
  ["de", "Deutsch", "German"],
  ["it", "Italiano", "Italian"],
  ["nl", "Nederlands", "Dutch"],
  ["pl", "Polski", "Polish"],
  ["tr", "Türkçe", "Turkish"],
  ["ru", "Русский", "Russian"],
  ["uk", "Українська", "Ukrainian"],
  ["ar", "العربية", "Arabic"],
  ["fa", "فارسی", "Persian"],
  ["he", "עברית", "Hebrew"],
  ["ur", "اردو", "Urdu"],
  ["hi", "हिन्दी", "Hindi"],
  ["id", "Bahasa Indonesia", "Indonesian"],
  ["vi", "Tiếng Việt", "Vietnamese"],
  ["th", "ไทย", "Thai"],
  ["ja", "日本語", "Japanese"],
  ["ko", "한국어", "Korean"],
  ["zh-CN", "简体中文", "Chinese (Simplified)"],
  ["zh-TW", "繁體中文", "Chinese (Traditional)"],
].map(([code, name, english]) => ({ code, name, english, dir: makeT.RTL[code.split("-")[0]] ? "rtl" : "ltr" }));

const COOKIE = "patv_lang";
const DIR = path.join(__dirname, "locales");
let catalogs = {};

/** (Re)load every catalog in locales/. A broken file is skipped (that language falls back to English). */
function load() {
  const next = {};
  for (const l of LANGS) {
    const f = path.join(DIR, l.code + ".json");
    if (!fs.existsSync(f)) continue;
    try {
      const c = JSON.parse(fs.readFileSync(f, "utf8"));
      delete c._meta;
      next[l.code] = c;
    } catch (e) {
      console.error("[i18n] " + l.code + ".json:", e.message);
    }
  }
  next.en = next.en || {};
  catalogs = next;
  return catalogs;
}
load();

const supported = () => LANGS.filter((l) => catalogs[l.code]);
const BY_LOWER = new Map(LANGS.map((l) => [l.code.toLowerCase(), l.code]));

/** A BCP-47-ish tag -> one of our codes, or null. pt -> pt-BR, zh-Hant/TW/HK/MO -> zh-TW, other zh -> zh-CN, iw -> he. */
function match(tag) {
  let s = String(tag || "").trim().toLowerCase().replace(/_/g, "-");
  if (!s || s === "*") return null;
  const have = (c) => (c && catalogs[c] ? c : null);
  if (BY_LOWER.has(s)) return have(BY_LOWER.get(s));
  const base = s.split("-")[0];
  if (base === "zh") return have(/-(hant|tw|hk|mo)\b/.test(s) ? "zh-TW" : "zh-CN");
  if (base === "pt") return have("pt-BR");
  if (base === "iw") return have("he");
  if (base === "in") return have("id");
  return BY_LOWER.has(base) ? have(BY_LOWER.get(base)) : null;
}

/** Accept-Language -> our codes in preference order (q-values honoured, q=0 dropped). */
function fromAccept(header) {
  const parts = String(header || "").split(",").slice(0, 20).map((p, i) => {
    const [tag, ...params] = p.trim().split(";");
    let q = 1;
    for (const x of params) { const m = /^\s*q=([0-9.]+)\s*$/.exec(x); if (m) q = Number(m[1]); }
    return { tag, q: isNaN(q) ? 0 : q, i };
  }).filter((p) => p.tag && p.q > 0).sort((a, b) => b.q - a.q || a.i - b.i);
  const out = [];
  for (const p of parts) { const c = match(p.tag); if (c && !out.includes(c)) out.push(c); }
  return out;
}

/** The negotiation order: saved preference, cookie, Accept-Language, English. */
function negotiate({ user, cookie, accept } = {}) {
  return match(user) || match(cookie) || fromAccept(accept)[0] || "en";
}

const tFor = (lang) => makeT(catalogs[lang] || catalogs.en, catalogs.en, catalogs[lang] ? lang : "en");
const info = (lang) => LANGS.find((l) => l.code === lang) || LANGS[0];

/** The "js.*" strings (or those under the given prefixes) for client code, English filled in for missing keys. */
function clientStrings(lang, prefixes) {
  const pre = prefixes && prefixes.length ? prefixes : ["js."];
  const en = catalogs.en, c = catalogs[lang] || en, out = {};
  for (const k of Object.keys(en)) {
    if (!pre.some((p) => k.startsWith(p))) continue;
    out[k] = c[k] != null && c[k] !== "" ? c[k] : en[k];
  }
  return out;
}

/** window.PATV_I18N's JSON (safe inside a <script>). */
function clientJson(lang, prefixes) {
  return JSON.stringify({ lang, dir: info(lang).dir, s: clientStrings(lang, prefixes) })
    .replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// ---- saved preferences (signed-in users) --------------------------------------------------------------------
const prefs = new Map();     // userId -> code; the whole table is small, so it lives in memory
let ready = null;
function ensure() {
  if (ready) return ready;
  const { runQuery, getQuery } = require("./dbUtils");
  ready = runQuery(`CREATE TABLE IF NOT EXISTS user_language (
      userId TEXT PRIMARY KEY,
      lang TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')))`)
    .then(() => getQuery("SELECT userId, lang FROM user_language"))
    .then((rows) => { for (const r of rows || []) prefs.set(r.userId, r.lang); })
    .catch((e) => { console.error("[i18n] user_language:", e.message); ready = null; });
  return ready;
}
async function savePref(userId, lang) {
  if (!userId) return;
  const { runQuery } = require("./dbUtils");
  await ensure();
  if (!lang) {
    await runQuery("DELETE FROM user_language WHERE userId = ?", [userId]);
    prefs.delete(userId);
  } else {
    await runQuery("INSERT INTO user_language (userId, lang, updated_at) VALUES (?, ?, strftime('%s','now')) "
      + "ON CONFLICT(userId) DO UPDATE SET lang = excluded.lang, updated_at = excluded.updated_at", [userId, lang]);
    prefs.set(userId, lang);
  }
}
const getPref = (userId) => (userId && prefs.get(userId)) || null;

// ---- express -----------------------------------------------------------------------------------------------
/** Sets req.lang / req.t and res.locals.t (+ i18nT), lang, dir, langInfo, i18nLangs, i18nClient(prefixes). */
function middleware(cookieUserId) {
  let lastLoad = Date.now();
  return (req, res, next) => {
    // I18N_DEV=1 (local development only): pick up edited catalogs without a restart
    if (process.env.I18N_DEV && Date.now() - lastLoad > 1000) { lastLoad = Date.now(); load(); }
    let uid = null;
    try { uid = cookieUserId ? cookieUserId(req) : null; } catch (e) { uid = null; }
    const cookie = req.cookies && req.cookies[COOKIE];
    const lang = negotiate({ user: getPref(uid), cookie, accept: req.headers["accept-language"] });
    const t = tFor(lang);
    req.lang = lang; req.t = t;
    res.locals.t = t;
    res.locals.i18nT = t;      // what the views use: a page may pass its own `t` local (hop.js does)
    res.locals.lang = lang;
    res.locals.dir = t.dir;
    res.locals.langInfo = info(lang);
    res.locals.i18nLangs = supported();
    res.locals.langPref = getPref(uid) || "auto";   // the signed-in user's saved choice (Edit profile)
    res.locals.i18nClient = (prefixes) => clientJson(lang, prefixes);
    if (!cookie && !getPref(uid)) res.vary("Accept-Language");
    next();
  };
}

/** A same-site path to go back to after switching (never an absolute or protocol-relative URL). */
function safeNext(n) {
  const s = String(n || "");
  return /^\/(?![\/\\])[^\s]*$/.test(s) && s.length < 500 ? s : "/";
}

function register(app, { addUser, cookieUserId }) {
  // the language picker page (linked from the More menu and the footer)
  app.get("/language", addUser, (req, res) => {
    res.render("language", { user: req.user ? req.user.username : null, next: safeNext(req.query.next),
      saved: getPref(req.user && req.user.userId) });
  });
  // switch: sets the cookie, and the saved preference when signed in. "auto" = follow the browser again.
  app.get("/lang/:code", async (req, res) => {
    const auto = req.params.code === "auto";
    const code = auto ? null : match(req.params.code);
    if (!auto && !code) return res.redirect(302, safeNext(req.query.next));
    if (auto) res.clearCookie(COOKIE);
    else res.cookie(COOKIE, code, { maxAge: 365 * 864e5, sameSite: "lax", httpOnly: false });
    const uid = cookieUserId ? cookieUserId(req) : null;
    if (uid) { try { await savePref(uid, code); } catch (e) { console.error("[i18n] save:", e.message); } }
    res.redirect(302, safeNext(req.query.next));
  });
  // the profile setting (Edit profile -> Language): {lang: "<code>" | "auto"}
  app.post("/api/settings/language", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.status(401).json({ success: false, message: req.t("err.session_expired") });
    const v = String((req.body && req.body.lang) || "");
    const code = v === "auto" ? null : match(v);
    if (v !== "auto" && !code) return res.status(400).json({ success: false, message: req.t("err.bad_language") });
    try { await savePref(req.user.userId, code); } catch (e) { return res.status(500).json({ success: false, message: req.t("err.generic") }); }
    if (code) res.cookie(COOKIE, code, { maxAge: 365 * 864e5, sameSite: "lax", httpOnly: false });
    else res.clearCookie(COOKIE);
    res.json({ success: true, lang: code || "auto" });
  });
  // client strings for scripts that load later
  app.get("/i18n/:code.json", (req, res) => {
    const code = match(req.params.code) || "en";
    res.set("Cache-Control", "public, max-age=3600");
    res.json({ lang: code, dir: info(code).dir, s: clientStrings(code) });
  });
}

module.exports = { LANGS, COOKIE, load, match, fromAccept, negotiate, tFor, info, supported, clientStrings, clientJson, middleware, register,
  ensure, savePref, getPref, safeNext, catalogs: () => catalogs, _prefs: prefs };
