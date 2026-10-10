// i18n-core.js - the translate function shared by i18n.js (the site) and the views' English fallback.
//
// Every translated view starts with this scriptlet (EJS tags written as [% %] here, because EJS includes this
// file and would run a real tag):
//   [% const t = locals.i18nT || new Function(include('../i18n-core.js'))()(JSON.parse(include('../locales/en.json'))); -%]
// so a template rendered without the site's middleware (the tests use ejs.renderFile directly) still gets English
// from locales/en.json. That's why this file is plain ES5 that also works as a function body (no EJS tags, no
// require): CommonJS allows the top-level `return`, and new Function(src)() returns makeT too.
//
// makeT(catalog, fallback, lang) -> t(key, vars)
//   * catalog values are trusted, HTML-safe text (views print them raw, with the dash tag); English is the
//     fallback for a missing key, and the key itself is the last resort
//   * {name} inserts vars.name HTML-escaped (the same escaping as EJS's escaped tag), {!name} inserts it raw
//     (markup the view built itself, e.g. a link)
//   * a value can be a plural object {"one": "...", "other": "..."} (CLDR categories via Intl.PluralRules), picked
//     by vars.count; a missing category uses "other"
//   * t.lang, t.dir, t.num(n, opts), t.date(d, opts), t.has(key)
"use strict";
var ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&#34;", "'": "&#39;" };
var RTL = { ar: 1, fa: 1, he: 1, ur: 1 };
function escHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
function intlLocale(lang) { return lang === "en" ? "en-US" : lang; }
function makeT(catalog, fallback, lang) {
  var C = catalog || {}, F = fallback || C, L = lang || "en", plural = null, nums = {};
  function pick(s, v) {
    if (!s || typeof s !== "object") return s;
    var n = v && v.count != null ? Number(v.count) : NaN, cat = "other";
    if (!isNaN(n)) {
      try { plural = plural || new Intl.PluralRules(intlLocale(L)); cat = plural.select(n); } catch (e) { cat = n === 1 ? "one" : "other"; }
    }
    return s[cat] != null ? s[cat] : s.other;
  }
  function t(key, vars) {
    var s = pick(C[key], vars);
    if (s == null || s === "") s = pick(F[key], vars);
    if (s == null) return escHtml(key);
    return String(s).replace(/\{(!?)(\w+)\}/g, function (m, raw, name) {
      if (!vars || vars[name] == null) return m;
      return raw ? String(vars[name]) : escHtml(vars[name]);
    });
  }
  t.lang = L;
  t.dir = RTL[String(L).split("-")[0]] ? "rtl" : "ltr";
  t.has = function (key) { return C[key] != null || F[key] != null; };
  t.num = function (n, opts) {
    var k = JSON.stringify(opts || {});
    try { nums[k] = nums[k] || new Intl.NumberFormat(intlLocale(L), opts); return nums[k].format(n); } catch (e) { return String(n); }
  };
  t.date = function (d, opts) {
    try { return new Intl.DateTimeFormat(intlLocale(L), opts).format(d instanceof Date ? d : new Date(d)); } catch (e) { return String(d); }
  };
  t.esc = escHtml;
  return t;
}
makeT.escHtml = escHtml;
makeT.RTL = RTL;
if (typeof module !== "undefined" && module.exports) module.exports = makeT;
return makeT;
