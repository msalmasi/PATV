// boostmark.js — the one shared 🚀 boost badge (1.99ek): a pad's ACTIVE boost PAT (boosts.activeMap -
// each boost decays with a 1-hour half-life) as a short number plus a tooltip. Pure - views get it as
// the `boostMark` local (app.locals via install(), and passed explicitly by the homepage and /p).
//
//   fmtPat(12400)   -> "12.4k"      950 -> "950", 1234567 -> "1.2M"
//   boostTip(12400) -> "Boosted: 12,400 PAT still active · boosts fade by half every hour"
//   boostMark(12400, "pill ch-mark") -> '<span class="pill ch-mark boost-mark" title="…" aria-label="…">🚀 12.4k</span>'
//   boostMark(0) -> ""   (a pad that isn't boosted shows nothing)
"use strict";

const UNITS = [[1e3, "k"], [1e6, "M"], [1e9, "B"]];

/** Rounded active boost PAT (0 when not boosted / not a number). */
const amount = (n) => { const v = Math.round(Number(n) || 0); return v > 0 ? v : 0; };

/** 950, 12.4k, 124k, 1.2M, 12M, 3.4B - one decimal under 100 of a unit, trailing ".0" dropped. */
function fmtPat(n) {
  const v = amount(n);
  if (v < 1000) return String(v);
  const one = (x) => (x < 100 ? (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, "") : String(Math.round(x)));
  for (let i = 0; i < UNITS.length; i++) {
    const s = one(v / UNITS[i][0]);
    // 999,960 is "1000k" at k precision: go up a unit ("1M") unless this is the last one
    if (Number(s) < 1000 || i === UNITS.length - 1) return s + UNITS[i][1];
  }
  return String(v);
}

function boostTip(n) {
  return `Boosted: ${amount(n).toLocaleString("en-US")} PAT still active · boosts fade by half every hour`;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** The badge's HTML, or "" when the pad isn't boosted. cls = extra classes for the context (e.g. "pill ch-mark"). */
function boostMark(n, cls) {
  const v = amount(n);
  if (!v) return "";
  const tip = esc(boostTip(v));
  return `<span class="${esc(((cls || "") + " boost-mark").trim())}" title="${tip}" aria-label="${tip}">🚀 ${fmtPat(v)}</span>`;
}

function install(app) { app.locals.boostMark = boostMark; }

module.exports = { fmtPat, boostTip, boostMark, install };
