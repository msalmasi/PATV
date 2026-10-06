// credit.js — the PAT credit score (1.99bg), the website half of Pepe's pepe_credit.py.
//
// A 300-850 score (the range people already read as a credit score) built additively from named
// factors, so the wallet can show exactly why. Pepe owns the loan book: his /api/wallet/loans sync
// carries the weights (reserve.credit) and, per borrower, the history counts (reserve.limits[name].credit:
// loans repaid on time / late, defaults, late now, auto-collections, open debt). This file applies
// those weights with the user's level and account age from our users table - the same inputs Pepe
// uses in chat - so both show the same number.
//
//   base 580 · +20 per on-time repayment (max +160) · -30 per late repayment (max -150)
//   -120 per default (max -240) · -100 per loan late right now (max -200) · -10 per collection (max -50)
//   debt load (owed now / (10k + 2k x level)): none +20 · <=0.5 +10 · <=1 0 · <=2 -30 · more -60
//   account age: <7d -20 · <30d 0 · <90d +10 · <1y +25 · older +40 · level: +3 each (max +60)
//   bands: 800 Excellent · 740 Very good · 670 Good · 580 Fair · below Poor
const DEFAULT_W = {
  base: 580, min: 300, max: 850,
  on_time: 20, on_time_cap: 160, late_repaid: -30, late_repaid_cap: -150,
  default: -120, default_cap: -240, late_now: -100, late_now_cap: -200, collection: -10, collection_cap: -50,
  per_level: 3, level_cap: 60, debt_none: 20,
  debt: [[0.5, 10], [1.0, 0], [2.0, -30], [null, -60]],
  age: [[7, -20], [30, 0], [90, 10], [365, 25], [null, 40]],
  bands: [[800, "Excellent"], [740, "Very good"], [670, "Good"], [580, "Fair"], [0, "Poor"]],
  capacity_base: 10000, capacity_per_level: 2000,
};
const HIST = ["on_time", "late_repaid", "defaults", "late_now", "collections", "open_debt", "open_loans", "forgiven"];
const int = (v) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? n : 0; };

// Pepe's weights as synced, checked field by field (anything missing or malformed = the default).
function cleanWeights(w) {
  const out = {};
  w = w && typeof w === "object" && !Array.isArray(w) ? w : {};
  for (const [k, d] of Object.entries(DEFAULT_W)) {
    if (Array.isArray(d)) {
      const ok = Array.isArray(w[k]) && w[k].length && w[k].length <= 10 && w[k].every((r) => Array.isArray(r) && r.length === 2
        && (r[0] === null || Number.isFinite(Number(r[0]))) && (k === "bands" ? typeof r[1] === "string" : Number.isFinite(Number(r[1]))));
      out[k] = ok ? w[k].map((r) => [r[0] === null ? null : Number(r[0]), k === "bands" ? String(r[1]).slice(0, 20) : Number(r[1])]) : d;
    } else {
      out[k] = Number.isFinite(Number(w[k])) ? Number(w[k]) : d;
    }
  }
  return out;
}

function cleanHistory(h) {
  const out = {};
  for (const k of HIST) out[k] = Math.max(0, int((h || {})[k]));
  return out;
}

function band(score, w) {
  for (const [floor, name] of (w || DEFAULT_W).bands) if (score >= floor) return name;
  return "Poor";
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// {score, band, factors: [{key, label, points}] biggest first, thin}
function creditScore(weights, history, level, ageDays) {
  const w = weights ? cleanWeights(weights) : DEFAULT_W;
  const h = cleanHistory(history);
  const lv = Math.max(0, int(level));
  const f = [];
  const add = (key, label, points) => f.push({ key, label, points: Math.round(points) });
  if (h.on_time) add("on_time", `${plural(h.on_time, "loan")} repaid on time`, Math.min(w.on_time_cap, w.on_time * h.on_time));
  if (h.late_repaid) add("late_repaid", `${plural(h.late_repaid, "loan")} repaid late`, Math.max(w.late_repaid_cap, w.late_repaid * h.late_repaid));
  if (h.defaults) add("defaults", `${plural(h.defaults, "default")} (written off or forgiven while late)`, Math.max(w.default_cap, w.default * h.defaults));
  if (h.late_now) add("late_now", `late on ${plural(h.late_now, "loan")} right now`, Math.max(w.late_now_cap, w.late_now * h.late_now));
  if (h.collections) add("collections", `Pepe had to collect on ${plural(h.collections, "loan")}`, Math.max(w.collection_cap, w.collection * h.collections));
  const cap = w.capacity_base + w.capacity_per_level * lv;
  let dp = w.debt_none;
  if (h.open_debt > 0) {
    const u = h.open_debt / Math.max(1, cap);
    const row = w.debt.find(([b]) => b === null || u <= b);
    dp = row ? row[1] : w.debt[w.debt.length - 1][1];
  }
  add("debt", h.open_debt > 0 ? `owes PAT ${h.open_debt.toLocaleString("en-US")} (${(h.open_debt / Math.max(1, cap)).toFixed(1)}x their level capacity of ${cap.toLocaleString("en-US")})` : "no debt right now", dp);
  if (ageDays !== null && ageDays !== undefined && Number.isFinite(Number(ageDays))) {
    const a = Math.max(0, Math.floor(Number(ageDays)));
    const row = w.age.find(([b]) => b === null || a < b);
    add("age", `account ${plural(a, "day")} old`, row ? row[1] : 0);
  }
  if (lv) add("level", `level ${lv}`, Math.min(w.level_cap, w.per_level * lv));
  const thin = !(h.on_time || h.late_repaid || h.defaults || h.late_now || h.open_loans || h.forgiven);
  if (thin) add("thin", "no loan history yet", 0);
  const raw = w.base + f.reduce((t, x) => t + x.points, 0);
  const score = Math.max(w.min, Math.min(w.max, Math.round(raw)));
  f.sort((a, b) => (Math.abs(b.points) - Math.abs(a.points)) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { score, band: band(score, w), factors: f, thin, min: w.min, max: w.max };
}

// SQLite CURRENT_TIMESTAMP ("YYYY-MM-DD HH:MM:SS", UTC) -> whole days old (null if unknown)
function ageDays(createdAt, now) {
  if (!createdAt) return null;
  const s = String(createdAt);
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z");
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor(((now || Date.now()) - t) / 86400000));
}

// The score for a Camfrog name from a loans snapshot (wallet.js) + that user's row {level, created_at}.
function forCamfrog(reserve, camfrog, userRow, now) {
  if (!camfrog || !reserve) return null;
  const lim = (reserve.limits || {})[String(camfrog).toLowerCase()] || {};
  return creditScore(reserve.credit || null, lim.credit || null, userRow ? userRow.level : 0, userRow ? ageDays(userRow.created_at, now) : null);
}

// "Good" -> a CSS-friendly class
const bandClass = (b) => String(b || "").toLowerCase().replace(/[^a-z]+/g, "-");

module.exports = { creditScore, cleanWeights, cleanHistory, band, ageDays, forCamfrog, bandClass, DEFAULT_W };
