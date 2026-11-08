// casino/mttpay.js — the prize arithmetic of a scheduled multi-table tournament (hand-off 22 phase 2, 1.99??; docs/casino-backend.md
// "Scheduled tournaments (MTT)"). Pure, integer arithmetic on what is paid: the curve is computed once (basis points, an integer array,
// fixed when late registration closes); every PAT amount after that is floor / remainder arithmetic, so the prizes add up to the pool
// exactly, to the PAT.
//
//   paid(E): fields of 2-9 use the owner's small-field bands (mtt_payouts_small, the Sit & Go's format: 100 | 65,35 | 50,30,20);
//            10 or more pay min(E - 1, max(min_paid, floor(E * paid_pct / 100))) places (defaults: max(3, 15 %)).
//   planBp(E): the bands x 100, or w_i = i^-exp normalised to 10,000 basis points (floor each; the rest to 1st: non-increasing).
//   split(P, bp): floor(P * bp / 10000) each, the remainder to 1st (decision 4: the odd PAT goes to the higher place).
//   places(entries): the winner 1st; then later bust batches higher; within a batch the bigger starting stack higher; equal = a tie group.
//   tie split: the group shares the prizes of the places it occupies (unpaid places = 0): floor each, the remainder one PAT each to the
//              first members in odd-chip order (the table number, then the seat order after the button) - phase 1's rule, across tables.
"use strict";

const BANDS = Object.freeze([[2, 3], [4, 6], [7, 9]]);
const bandFor = (small, n) => small[Math.max(0, BANDS.findIndex(([lo, hi]) => n >= lo && n <= hi))];

/** places paid for E entries. money: {small_pcts, paid_pct, min_paid} */
function paid(E, money) {
  E = Math.max(0, Math.floor(Number(E) || 0));
  if (E < 2) return E;
  if (E <= 9) return bandFor(money.small_pcts, E).length;
  return Math.min(E - 1, Math.max(money.min_paid, Math.floor((E * money.paid_pct) / 100)));
}
/** the payout curve in basis points (sums to 10,000, non-increasing). money: {small_pcts, paid_pct, min_paid, exp} */
function planBp(E, money) {
  E = Math.max(0, Math.floor(Number(E) || 0));
  if (E < 2) return [10000];
  if (E <= 9) return bandFor(money.small_pcts, E).map((p) => p * 100);
  const n = paid(E, money), exp = Number(money.exp);
  const w = [];
  for (let i = 1; i <= n; i++) w.push(Math.pow(i, -exp));
  const sum = w.reduce((a, b) => a + b, 0);
  const bp = w.map((x) => Math.floor((10000 * x) / sum));
  bp[0] += 10000 - bp.reduce((a, b) => a + b, 0);
  return bp;
}
/** amount P split by the curve: floor each, the remainder to 1st - sums to P exactly */
function split(P, bp) {
  P = Math.max(0, Math.floor(Number(P) || 0));
  const out = bp.map((b) => Math.floor((P * b) / 10000));
  if (out.length) out[0] += P - out.reduce((a, b) => a + b, 0);
  return out;
}
/**
 * Places from the bust batches. entries: [{key, bust_seq, bust_stack, bust_table_no, bust_oc, winner}] (every counted entry; the winner is
 * the one left with chips) -> [{key, place, tied: [a, b] | null, group}] sorted by place (1..E, each once); a group = one tie group's index.
 */
function places(entries) {
  const list = entries.slice();
  const win = list.filter((x) => x.winner);
  const rest = list.filter((x) => !x.winner);
  rest.sort((a, b) => (Number(b.bust_seq) || 0) - (Number(a.bust_seq) || 0) || (Number(b.bust_stack) || 0) - (Number(a.bust_stack) || 0) || ocCmp(a, b));
  const out = [];
  let place = 1, group = 0;
  for (const w of win) out.push({ key: w.key, place: place++, tied: null, group: group++ });
  for (let i = 0; i < rest.length;) {
    let j = i;
    while (j < rest.length && Number(rest[j].bust_seq) === Number(rest[i].bust_seq) && Number(rest[j].bust_stack) === Number(rest[i].bust_stack)) j++;
    const g = rest.slice(i, j).sort(ocCmp), n = g.length;
    g.forEach((x, k) => out.push({ key: x.key, place: place + k, tied: n > 1 ? [place, place + n - 1] : null, group }));
    place += n; group += 1; i = j;
  }
  return out;
}
/** odd-chip order across tables: the table number, then the seat order after the button, then the key (deterministic) */
function ocCmp(a, b) {
  return (Number(a.bust_table_no) || 0) - (Number(b.bust_table_no) || 0) || (Number(a.bust_oc) || 0) - (Number(b.bust_oc) || 0) ||
         (String(a.key) < String(b.key) ? -1 : String(a.key) > String(b.key) ? 1 : 0);
}
/**
 * The prize of every placed entry: `amounts` = the per-place amounts (split(P, bp); places past its end are unpaid = 0). A tie group shares
 * the sum of its places; floor each; the remainder one PAT each to the first members in odd-chip order (their place order already is).
 * -> Map key -> amount (sums to Σ amounts exactly)
 */
function award(placed, amounts) {
  const out = new Map();
  const groups = new Map();
  for (const p of placed) { if (!groups.has(p.group)) groups.set(p.group, []); groups.get(p.group).push(p); }
  for (const g of groups.values()) {
    g.sort((a, b) => a.place - b.place);
    const pot = g.reduce((s, p) => s + (amounts[p.place - 1] || 0), 0);
    const share = Math.floor(pot / g.length), rem = pot - share * g.length;
    g.forEach((p, i) => out.set(p.key, share + (i < rem ? 1 : 0)));
  }
  return out;
}
/** leaderboard points for a finish: floor(100 * (sqrt(E / place) - 1)), 0 for the last place */
function points(place, E) {
  place = Math.floor(Number(place) || 0); E = Math.floor(Number(E) || 0);
  if (!(place >= 1) || !(E >= 1) || place >= E) return 0;
  return Math.max(0, Math.floor(100 * (Math.sqrt(E / place) - 1)));
}
/** the estimated length: the first level whose big blind is >= the chips in play / 20, levels x level_ms (bound: min(12 h, 1.5x)) */
function estimate(structure, maxEntries, levelAt) {
  const total = Math.max(2, Math.floor(Number(maxEntries) || 0)) * structure.start_chips;
  let L = 0;
  while (L < 400 && levelAt({ levels: structure.levels }, L)[1] < total / 20) L++;
  const est = (L + 1) * structure.level_ms;
  return { levels: L + 1, est_ms: est, bound_ms: Math.min(12 * 3600e3, Math.floor(1.5 * est)) };
}

module.exports = { BANDS, bandFor, paid, planBp, split, places, ocCmp, award, points, estimate };
