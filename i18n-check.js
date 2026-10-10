// i18n-check.js - 1.99kf: the rules a translated string must follow, shared by the sync tool (tools/i18n-sync.js),
// the translation-suggestion overlay (i18nfeedback.js) and the fold script (tools/i18n-overrides.js).
//
// They mirror test/i18n.test.js (placeholders, tags, plural shape, no EJS tags, no double quotes outside tags, js.*
// plain text, brand names kept) and add what text from a model or a user needs on top, because catalog values are
// printed RAW (HTML-safe text) by the views:
//   * the markup must be EXACTLY English's: the same <...> tokens, attributes included (an extra attribute such as
//     onmouseover= is refused), no stray < or > outside them, and & only as a complete entity or a bare "& "
//   * a plural value only uses CLDR categories and has "other"
//   * nothing absurdly long
// No dependencies: it also runs in the deploy updater's bare checkout and in CI.
"use strict";
const crypto = require("crypto");

const BRANDS = ["PATV", "PAT", "Pepe", "Camfrog", "Prime Time", "Season Pass"];
const PLURAL_CATS = new Set(["zero", "one", "two", "few", "many", "other"]);

const strings = (v) => (v && typeof v === "object" ? Object.values(v) : [v]);
function holders(v) {
  const out = new Set();
  for (const s of strings(v)) for (const m of String(s).matchAll(/\{(!?\w+)\}/g)) out.add(m[1]);
  return out;
}
const tagNames = (s) => [...String(s).matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1].toLowerCase()).sort().join(",");
const tagTokens = (s) => (String(s).match(/<[^>]*>/g) || []).sort().join("\u0001");

/** A short, stable fingerprint of an English value (string or plural object). */
function hash(en) {
  const v = en && typeof en === "object" ? Object.keys(en).sort().map((k) => [k, en[k]]) : en;
  return crypto.createHash("sha1").update(JSON.stringify(v)).digest("hex").slice(0, 12);
}

/**
 * Problems with `value` as the translation of English `en` under `key` ([] = fine).
 * opts.brands: names that must survive (default BRANDS); opts.strict (default true): the exact-markup rules above.
 */
function check(key, en, value, opts = {}) {
  const brands = opts.brands || BRANDS;
  const strict = opts.strict !== false;
  const out = [];
  if (en == null) return ["not an English key"];
  const plural = typeof en === "object";
  if (plural) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return ["must be a plural object like English (one/other...)"];
    if (value.other == null) out.push('plural needs "other"');
    for (const c of Object.keys(value)) if (!PLURAL_CATS.has(c)) out.push("unknown plural category " + c);
  } else if (typeof value !== "string") {
    return ["must be a string"];
  }
  const want = holders(en), got = holders(value);
  if (plural) { want.delete("count"); got.delete("count"); }
  const w = [...want].sort().join(","), g = [...got].sort().join(",");
  if (w !== g) out.push(`placeholders {${g}} should be {${w}}`);
  const enFirst = strings(en)[0];
  for (const s of strings(value)) {
    if (typeof s !== "string") { out.push("not text"); continue; }
    if (!s.trim()) { out.push("empty"); continue; }
    if (/<%|%>/.test(s)) out.push("EJS tag");
    const bare = s.replace(/<[^>]*>/g, "");
    if (/"/.test(bare)) out.push("double quote outside a tag");
    if (tagNames(s) !== tagNames(enFirst)) out.push("HTML tags differ from English");
    else if (strict && tagTokens(s) !== tagTokens(enFirst)) out.push("HTML tag attributes differ from English");
    if (strict && /[<>]/.test(bare)) out.push("stray < or >");
    if (strict && /&(?!(?:[a-z][a-z0-9]*|#\d+|#x[0-9a-f]+);|\s)/i.test(bare)) out.push("broken HTML entity");
    if (key.startsWith("js.") && /<[a-z\/]|&[a-z#0-9]+;/i.test(s)) out.push("js.* strings are plain text");
    if (strict && s.length > String(enFirst).length * 5 + 60) out.push("far longer than English");
  }
  if (!plural) {
    for (const b of brands) {
      if (new RegExp("(^|[^A-Za-z])" + b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|[^A-Za-z])").test(en) && !String(value).includes(b)) out.push(`keep "${b}"`);
    }
  }
  return [...new Set(out)];
}

/** Read a catalog JSON without its _meta. */
function body(cat) {
  const o = Object.assign({}, cat || {});
  delete o._meta;
  return o;
}

module.exports = { check, hash, holders, strings, tagNames, tagTokens, body, BRANDS, PLURAL_CATS };
