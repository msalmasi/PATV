// localtime.js - 1.99jx: times in the viewer's own time zone, always with the zone's label.
// Loaded by layout.ejs on every page. The zone: the signed-in user's saved choice (window.PATV_TZ_SAVED,
// Edit profile -> Time zone), else the browser's (Intl...resolvedOptions().timeZone), else UTC.
// - stores the browser's zone in the patv_tz cookie so server-rendered pages (tz.js) come out local next time;
// - rewrites every <time data-tz="style"> (tz.js tzTime) - also ones page scripts add later;
// - window.PATVTime.format(ts, style) / .tag(ts, style) / .zone for page scripts (ts = unix s, ms, Date, ISO).
(function () {
  'use strict';
  var STYLES = {
    full: { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' },
    datetime: { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' },
    long: { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' },
    time: { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' },
    date: { year: 'numeric', month: 'short', day: 'numeric' },
    day: { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }
  };
  function okZone(z) {
    if (!z) return null;
    try { return new Intl.DateTimeFormat('en-US', { timeZone: z }).resolvedOptions().timeZone; } catch (e) { return null; }
  }
  var browser = null;
  try { browser = okZone(Intl.DateTimeFormat().resolvedOptions().timeZone); } catch (e) { browser = null; }
  var zone = okZone(window.PATV_TZ_SAVED) || browser || 'UTC';
  // remember the browser's zone for server-rendered pages (the saved choice, if any, wins on the server)
  try {
    if (browser) {
      var m = document.cookie.match(/(?:^|;\s*)patv_tz=([^;]*)/);
      var have = m ? decodeURIComponent(m[1]) : '';
      if (have !== browser) document.cookie = 'patv_tz=' + encodeURIComponent(browser) + '; path=/; max-age=31536000; samesite=lax';
    }
  } catch (e) {}

  var lang = document.documentElement.lang || undefined;
  var cache = {};
  function formatter(style) {
    var k = style in STYLES ? style : 'datetime';
    if (!cache[k]) {
      var o = {}, s = STYLES[k];
      for (var p in s) o[p] = s[p];
      o.timeZone = zone;
      try { cache[k] = new Intl.DateTimeFormat(lang, o); } catch (e) { cache[k] = new Intl.DateTimeFormat('en-US', o); }
    }
    return cache[k];
  }
  function toDate(ts) {
    if (ts instanceof Date) return ts;
    if (typeof ts === 'string' && !/^\d+(\.\d+)?$/.test(ts)) return new Date(ts);
    var n = Number(ts);
    if (!isFinite(n) || n <= 0) return new Date(NaN);
    return new Date(n < 1e11 ? n * 1000 : n);
  }
  function format(ts, style) {
    var d = toDate(ts);
    if (isNaN(d.getTime())) return '';
    try { return formatter(style || 'datetime').format(d); } catch (e) { return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function tag(ts, style) {
    var d = toDate(ts);
    if (isNaN(d.getTime())) return '';
    var iso = d.toISOString();
    return '<time datetime="' + iso + '" data-tz="' + esc(style || 'datetime') + '" title="' + iso.slice(0, 19).replace('T', ' ') + ' UTC">' + esc(format(d, style)) + '</time>';
  }
  function apply(root) {
    var list = (root || document).querySelectorAll ? (root || document).querySelectorAll('time[data-tz]') : [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i], iso = el.getAttribute('datetime');
      if (!iso || el.getAttribute('data-tz-done') === zone) continue;
      var txt = format(iso, el.getAttribute('data-tz'));
      if (txt) { el.textContent = txt; el.setAttribute('data-tz-done', zone); }
    }
  }
  window.PATVTime = { zone: zone, browser: browser, format: format, tag: tag, apply: apply };
  function start() {
    apply(document);
    if (window.MutationObserver) {
      var pending = false;
      new MutationObserver(function () {
        if (pending) return;
        pending = true;
        setTimeout(function () { pending = false; apply(document); }, 50);
      }).observe(document.body, { childList: true, subtree: true });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
