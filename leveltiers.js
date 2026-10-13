// leveltiers.js — 1.99xi: a name for every 10 levels (Lv 0-9 Tadpole, 10-19 Froglet, 20-29 Pond Hopper, ...).
//
// The ladder lives in ONE data file, data/level-tiers.json (key, English name, emoji per tier, plus the `beyond` name for
// levels past the last tier: Pond Deity I, II, ... one numeral per further 10 levels - levels are unbounded, the XP curve is
// (level + 1)^2 x 1,000). The name a page shows is the i18n string tier.<key> (locales/en.json carries the English, the sync
// translates it); a catalog without it falls back to the file's name.
//
// Shown next to the level on the profile, the rankings, the home page and Pepe's !level / !rank (GET /api/u/:username/level
// carries `tier`). Views get it through app.locals.levelTier (index.js); views rendered without the site (tests) skip it.
"use strict";
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "data", "level-tiers.json");
let LADDER = null;

function load() {
  if (LADDER) return LADDER;
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch (e) { console.error("[leveltiers] data/level-tiers.json:", e.message); }
  const step = Math.max(1, Math.floor(Number(raw.step) || 10));
  const tiers = (Array.isArray(raw.tiers) ? raw.tiers : []).filter((t) => t && t.key && t.name)
    .map((t, i) => ({ key: String(t.key), name: String(t.name), emoji: String(t.emoji || ""), min: i * step }));
  if (!tiers.length) tiers.push({ key: "tadpole", name: "Tadpole", emoji: "🫧", min: 0 });
  const b = raw.beyond && raw.beyond.key ? raw.beyond : { key: "pond_deity", name: "Pond Deity", emoji: "🌟" };
  LADDER = { step, tiers, beyond: { key: String(b.key), name: String(b.name), emoji: String(b.emoji || "") } };
  return LADDER;
}

const ROMAN = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
function roman(n) {
  let x = Math.max(1, Math.min(3999, Math.floor(n))), s = "";
  for (const [v, r] of ROMAN) while (x >= v) { s += r; x -= v; }
  return s;
}

/**
 * The tier for a level -> {key, name, emoji, min, max, rank (1 = the first tier), numeral ("" or "I", "II"...), label}
 * `label` = English name (+ numeral). `name`/`label` are English; nameIn(tier, t) localizes.
 */
function tierOf(level) {
  const L = load();
  const lv = Math.max(0, Math.floor(Number(level) || 0));
  const idx = Math.floor(lv / L.step);
  if (idx < L.tiers.length) {
    const t = L.tiers[idx];
    return { key: t.key, name: t.name, emoji: t.emoji, min: t.min, max: t.min + L.step - 1, rank: idx + 1, numeral: "", label: t.name };
  }
  const extra = idx - L.tiers.length + 1;                       // 1 = the first `beyond` band
  const min = idx * L.step;
  const numeral = roman(extra);
  return { key: L.beyond.key, name: L.beyond.name, emoji: L.beyond.emoji, min, max: min + L.step - 1, rank: idx + 1, numeral,
           label: L.beyond.name + " " + numeral };
}

/** A tier's name in the viewer's language (i18n tier.<key>, the file's English otherwise) + its numeral. */
function nameIn(tier, t) {
  if (!tier) return "";
  const has = t && typeof t.has === "function" && t.has("tier." + tier.key);
  const base = has ? t("tier." + tier.key) : (t && t.esc ? t.esc(tier.name) : tier.name);
  return tier.numeral ? base + " " + tier.numeral : base;
}

/** "🐸 Froglet" for a level (HTML-safe when `t` is the i18n function: its strings are already escaped). */
function labelOf(level, t) {
  const tier = tierOf(level);
  return (tier.emoji ? tier.emoji + " " : "") + nameIn(tier, t);
}

/** The whole ladder (for a help / about page and the tests). */
function ladder() {
  const L = load();
  return { step: L.step, tiers: L.tiers.map((t) => ({ ...t, max: t.min + L.step - 1 })), beyond: { ...L.beyond, min: L.tiers.length * L.step } };
}

/** The tier as JSON for an API answer (Pepe's !level). */
function forApi(level) {
  const t = tierOf(level);
  return { key: t.key, name: t.label, emoji: t.emoji, min: t.min, max: t.max, rank: t.rank };
}

module.exports = { tierOf, nameIn, labelOf, ladder, forApi, roman, _reload: () => { LADDER = null; return load(); } };
