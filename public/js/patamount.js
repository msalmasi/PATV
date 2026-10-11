// patamount.js — ONE parser for a typed PAT amount (1.99nk), the same rules as Pepe's chat commands
// (camfrog-bot pepe_amount.parse_pat_amount). Used by the browser (window.PATVAmount.parse, loaded before the forms
// that use it) and by the server (require("./public/js/patamount")).
//
//   1000000  1,000,000  1_000_000  5k  1.5M  2,500k  1b  -> a whole number (rounded down)
//
// Commas must be real thousands groups (1-3 digits, then groups of three): "1,2,3" or "10,00" is NOT an amount (a
// comma there separates things). Spaces around are trimmed; anything else -> NaN. Negative amounts are not accepted.
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PATVAmount = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var RE = /^(\d{1,3}(?:,\d{3})+|\d+(?:_\d+)*)?(?:\.(\d+))?([kmb])?$/i;
  var MULT = { '': 1, k: 1e3, m: 1e6, b: 1e9 };
  var MAX = 1e15;
  function parse(v) {
    if (typeof v === 'number') return Number.isFinite(v) && v >= 0 && v <= MAX ? Math.floor(v) : NaN;
    var t = String(v == null ? '' : v).trim();
    if (!t || t.length > 32) return NaN;
    var m = RE.exec(t);
    if (!m || (!m[1] && m[2] == null)) return NaN;
    var whole = Number((m[1] || '0').replace(/[,_]/g, ''));
    var mult = MULT[(m[3] || '').toLowerCase()];
    var frac = m[2] ? Math.floor(Number('0.' + m[2]) * mult + 1e-9) : 0;
    var n = whole * mult + frac;
    return Number.isFinite(n) && n <= MAX ? Math.floor(n) : NaN;
  }
  /** An HTML pattern attribute that lets the same forms through (the server / Pepe still decide). */
  var PATTERN = '\\s*(\\d{1,3}(,\\d{3})+|\\d+(_\\d+)*)?(\\.\\d+)?[kKmMbB]?\\s*';
  return { parse: parse, PATTERN: PATTERN };
}));
