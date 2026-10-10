// tz-core.js - 1.99jx: format a time in a time zone, with the zone's label; shared by tz.js (the site) and the views'
// fallback when they're rendered without the site's middleware (tests use ejs.renderFile / a bare express app):
//   [% const tzT = locals.tzTime || new Function(include('../tz-core.js'))()('UTC', 'en').time; %]
// Like i18n-core.js this is plain ES5 that also works as a function body (no EJS tags, no require): CommonJS allows
// the top-level `return`, and new Function(src)() returns makeTz too.
//
// makeTz(zone, lang) -> { zone, lang, time(ts, style, cls) -> '<time datetime data-tz title=UTC>text</time>',
//                         fmt(ts, style) -> text }      ts = unix seconds, ms, a Date or an ISO string
// styles: full (Sat, Oct 10, 1:52 PM EDT) · datetime (Oct 10, 1:52 PM EDT) · long (Oct 10, 2026, 1:52 PM EDT)
//         · time (1:52 PM EDT) · date (Oct 10, 2026) · day (Sat, Oct 10, 2026 - a date heading, no clock)
"use strict";
var TZ_STYLES = {
  full: { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" },
  datetime: { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" },
  long: { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" },
  time: { hour: "numeric", minute: "2-digit", timeZoneName: "short" },
  date: { year: "numeric", month: "short", day: "numeric" },
  day: { weekday: "short", year: "numeric", month: "short", day: "numeric" }
};
var TZ_CACHE = {};
var TZ_CACHE_N = 0;

function tzToMs(ts) {
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === "string" && !/^\s*\d+(\.\d+)?\s*$/.test(ts)) {
    var s = ts.trim();
    return Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z");
  }
  var n = Number(ts);
  if (!isFinite(n) || n <= 0) return NaN;
  return n < 1e11 ? n * 1000 : n;              // unix seconds vs milliseconds
}

function tzEsc(s) {
  return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
}

function tzFormatter(lang, zone, style) {
  var key = lang + "|" + zone + "|" + style;
  var f = TZ_CACHE[key];
  if (!f) {
    var base = TZ_STYLES[style] || TZ_STYLES.datetime, o = { timeZone: zone }, k;
    for (k in base) o[k] = base[k];
    try { f = new Intl.DateTimeFormat(lang || "en-US", o); } catch (e) {
      try { f = new Intl.DateTimeFormat("en-US", o); } catch (e2) { o.timeZone = "UTC"; f = new Intl.DateTimeFormat("en-US", o); }
    }
    if (++TZ_CACHE_N > 2000) { TZ_CACHE = {}; TZ_CACHE_N = 0; }
    TZ_CACHE[key] = f;
  }
  return f;
}

function makeTz(zone, lang) {
  zone = zone || "UTC";
  lang = lang || "en";
  function fmt(ts, style) {
    var ms = tzToMs(ts);
    if (!isFinite(ms)) return "";
    return tzFormatter(lang, zone, style || "datetime").format(new Date(ms));
  }
  function time(ts, style, cls) {
    var ms = tzToMs(ts);
    if (!isFinite(ms)) return "";
    var iso = new Date(ms).toISOString();
    return '<time datetime="' + iso + '" data-tz="' + tzEsc(style || "datetime") + '" title="' + iso.slice(0, 19).replace("T", " ")
      + ' UTC"' + (cls ? ' class="' + tzEsc(cls) + '"' : "") + ">" + tzEsc(fmt(ms, style)) + "</time>";
  }
  return { zone: zone, lang: lang, fmt: fmt, time: time };
}
makeTz.STYLES = TZ_STYLES;
makeTz.toMs = tzToMs;
if (typeof module !== "undefined" && module.exports) module.exports = makeTz;
return makeTz;
