// tz.js - 1.99jx: every time on the site in the viewer's own time zone, with its label.
//
// The zone for a request, first match wins:
//   1. a signed-in user's saved choice (user_timezone table; Edit profile -> Time zone)
//   2. the patv_tz cookie, which public/js/localtime.js sets from the browser
//      (Intl.DateTimeFormat().resolvedOptions().timeZone)
//   3. UTC
// Views get res.locals.tz (the zone), tzPref ("auto" or a zone), tzTime(ts, style) -> a <time> tag already
// formatted in that zone WITH its label ("Sat Oct 10, 1:52 PM EDT"), and tzFmt(ts, style) -> the plain text.
// localtime.js rewrites every time[data-tz] in the browser (so a page cached / rendered before the cookie
// existed still ends up local), and exposes window.PATVTime.format(ts, style) for page scripts.
"use strict";

const COOKIE = "patv_tz";
const makeTz = require("./tz-core");
const STYLES = makeTz.STYLES;

let ZONES = null;
/** Every IANA zone this runtime knows (sorted), UTC first. */
function zones() {
  if (ZONES) return ZONES;
  let list = [];
  try { list = Intl.supportedValuesOf("timeZone"); } catch (e) { list = []; }
  ZONES = ["UTC", ...list.filter((z) => z !== "UTC")];
  return ZONES;
}
const ZSET = () => new Set(zones().map((z) => z.toLowerCase()));
let zset = null;

/** A zone name -> its canonical spelling, or null (unknown / garbage). "Etc/UTC" and "utc" are UTC. */
function valid(z) {
  const s = String(z || "").trim();
  if (!s || s.length > 64 || !/^[A-Za-z0-9_+\-\/]+$/.test(s)) return null;
  if (/^(etc\/)?(utc|gmt|zulu|universal)$/i.test(s)) return "UTC";
  zset = zset || ZSET();
  if (zset.has(s.toLowerCase())) return zones().find((x) => x.toLowerCase() === s.toLowerCase());
  try { return new Intl.DateTimeFormat("en-US", { timeZone: s }).resolvedOptions().timeZone; } catch (e) { return null; }
}

const toMs = makeTz.toMs;
/** Plain text: the time in `zone` with its label. */
const fmt = (ts, { zone = "UTC", lang = "en", style = "datetime" } = {}) => makeTz(valid(zone) || "UTC", lang).fmt(ts, style);
/** A <time> tag: formatted for `zone` on the server, rewritten in the browser by localtime.js; UTC on hover. */
const tag = (ts, { zone = "UTC", lang = "en", style = "datetime", cls = "" } = {}) => makeTz(valid(zone) || "UTC", lang).time(ts, style, cls);

// ---- saved preferences (signed-in users) --------------------------------------------------------------------
const prefs = new Map();
let ready = null;
function ensure() {
  if (ready) return ready;
  const { runQuery, getQuery } = require("./dbUtils");
  ready = runQuery(`CREATE TABLE IF NOT EXISTS user_timezone (
      userId TEXT PRIMARY KEY,
      tz TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')))`)
    .then(() => getQuery("SELECT userId, tz FROM user_timezone"))
    .then((rows) => { for (const r of rows || []) prefs.set(r.userId, r.tz); })
    .catch((e) => { console.error("[tz] user_timezone:", e.message); ready = null; });
  return ready;
}
async function savePref(userId, zone) {
  if (!userId) return;
  const { runQuery } = require("./dbUtils");
  await ensure();
  if (!zone) {
    await runQuery("DELETE FROM user_timezone WHERE userId = ?", [userId]);
    prefs.delete(userId);
  } else {
    await runQuery("INSERT INTO user_timezone (userId, tz, updated_at) VALUES (?, ?, strftime('%s','now')) "
      + "ON CONFLICT(userId) DO UPDATE SET tz = excluded.tz, updated_at = excluded.updated_at", [userId, zone]);
    prefs.set(userId, zone);
  }
}
const getPref = (userId) => (userId && prefs.get(userId)) || null;

/** The zone for a request: saved choice > browser cookie > UTC. */
function negotiate({ user, cookie } = {}) {
  return valid(user) || valid(cookie) || "UTC";
}

// ---- express -----------------------------------------------------------------------------------------------
/** res.locals.tz / tzPref / tzSaved / tzTime(ts, style) / tzFmt(ts, style) / tzZones() for every page. Mount AFTER i18n
 *  (the time format follows the page language). */
function middleware(cookieUserId) {
  return (req, res, next) => {
    let uid = null;
    try { uid = cookieUserId ? cookieUserId(req) : null; } catch (e) { uid = null; }
    const saved = getPref(uid);
    const zone = negotiate({ user: saved, cookie: req.cookies && req.cookies[COOKIE] });
    const lang = () => res.locals.lang || req.lang || "en";
    req.tz = zone;
    res.locals.tz = zone;
    res.locals.tzPref = saved || "auto";
    res.locals.tzSaved = saved;
    let made = null;
    const T = () => (made && made.lang === lang() ? made : (made = makeTz(zone, lang())));
    res.locals.tzTime = (ts, style, cls) => T().time(ts, style, cls);
    res.locals.tzFmt = (ts, style) => T().fmt(ts, style);
    res.locals.tzZones = zones;
    next();
  };
}

function register(app, { addUser }) {
  // Edit profile -> Time zone: {tz: "auto" | "<IANA zone>"}
  app.post("/api/settings/timezone", addUser, async (req, res) => {
    const t = req.t || ((k) => k);
    if (!req.user || !req.user.userId) return res.status(401).json({ success: false, message: t("err.session_expired") });
    const v = String((req.body && req.body.tz) || "");
    const zone = v === "auto" ? null : valid(v);
    if (v !== "auto" && !zone) return res.status(400).json({ success: false, message: t("err.bad_timezone") });
    try { await savePref(req.user.userId, zone); } catch (e) { return res.status(500).json({ success: false, message: t("err.generic") }); }
    res.json({ success: true, tz: zone || "auto" });
  });
}

module.exports = { COOKIE, STYLES, zones, valid, toMs, fmt, tag, negotiate, middleware, register, ensure, savePref, getPref, _prefs: prefs };
