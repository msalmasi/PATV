// casino/mttseat.js — the seating rules of a scheduled multi-table tournament (hand-off 22 phase 2, 1.99??; docs/casino-backend.md
// "Scheduled tournaments (MTT)"). Pure functions on plain arrays / objects: no I/O, no clock, no randomness of their own.
//
//   * drawOrder: the provably fair seating draw - an HMAC-SHA256 Fisher-Yates over the sorted entry keys, keyed by the tournament's
//     draw seed (committed as sha256(seed) when registration opens, revealed when it is over). Labels: "start", "break:<no>:<n>", "final".
//   * blindPlan: who posts what at a tournament table's next hand. The big blind always moves forward one seat; a player who arrives
//     (a move, a broken table, a late entry) is inserted just before the next big blind, so the first arrival is this hand's big blind,
//     the next one the hand after - nobody skips a big blind and nobody gets a free hand; heads-up nobody posts the big blind twice in a
//     row; when the small blind would fall on the player who posted it last hand, it is DEAD (0 this hand only - the button may stay on
//     the same player twice, the standard compromise). It sets e.button so the UNCHANGED engine (hmengine.startHand advances the button
//     one seat) posts exactly that.
//   * the table rules: effective players (seated with chips + inbound transit), the late seat target, balancing (TDA: the player who would
//     be big blind next moves from the fullest table to the shortest, tables within one player), breaking (the shortest table, ties the
//     highest number, never one opened in the last 2 levels while late registration is open), the final-table condition.
"use strict";
const crypto = require("crypto");

const TWO48 = 2 ** 48;

/** a 48-bit integer from HMAC-SHA256(seed, msg) */
function h48(seedHex, msg) {
  const d = crypto.createHmac("sha256", Buffer.from(String(seedHex), "hex")).update(String(msg)).digest();
  return d.readUIntBE(0, 6);
}
/** an unbiased integer in 0..m-1 for (label, i): rejection sampling below floor(2^48 / m) * m, re-hashed with ":<k>" on a reject */
function pick(seedHex, label, i, m) {
  const lim = Math.floor(TWO48 / m) * m;
  let x = h48(seedHex, `${label}:${i}`);
  for (let k = 1; x >= lim; k++) x = h48(seedHex, `${label}:${i}:${k}`);
  return x % m;
}
/** the draw: `ids` sorted first (so the input order never matters), then Fisher-Yates from the end with HMAC picks -> a new array */
function drawOrder(seedHex, label, ids) {
  const a = Array.from(new Set((ids || []).map(String))).sort();
  for (let i = a.length - 1; i >= 1; i--) {
    const j = pick(seedHex, label, i, i + 1);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
const newSeed = () => crypto.randomBytes(32).toString("hex");
const commitOf = (seedHex) => crypto.createHash("sha256").update(Buffer.from(String(seedHex), "hex")).digest("hex");

/**
 * The next hand's blinds at a tournament table.
 *   ring     the seats with chips in ring order (e.seats)
 *   last     the last hand's record {bb_key, sb_key, order} (T.tourney.last) or null (a new table / the first hand)
 *   arrivals the uids being seated now, in transit order
 * -> {ring: the new ring order (arrivals inserted), button: what to set e.button to (null = the engine takes ring[0]), deadSb, bbUid}
 */
function blindPlan(ring, last, arrivals) {
  ring = (ring || []).map(String);
  arrivals = (arrivals || []).map(String).filter((k) => !ring.includes(k));
  const fresh = () => ({ ring: ring.concat(arrivals), button: null, deadSb: false, bbUid: null, fresh: true });
  if (!last || !Array.isArray(last.order) || !last.order.length || last.bb_key == null) return fresh();
  // the next big blind: the first player after last hand's big blind (in last hand's order) who is still at this table
  const ord = last.order.map(String), bi = ord.indexOf(String(last.bb_key));
  let nbb = null;
  if (bi >= 0) for (let o = 1; o <= ord.length && nbb === null; o++) { const k = ord[(bi + o) % ord.length]; if (ring.includes(k)) nbb = k; }
  if (nbb === null) return fresh();
  // arrivals sit just before the next big blind: the first arrival is this hand's big blind, the next one the hand after
  const at = ring.indexOf(nbb);
  const p = ring.slice(0, at).concat(arrivals, ring.slice(at));
  const n = p.length;
  let bbUid = arrivals[0] || nbb;
  if (n < 2) return { ring: p, button: null, deadSb: false, bbUid: null };
  if (n === 2) {
    if (bbUid === String(last.bb_key)) bbUid = p.find((k) => k !== bbUid);       // heads-up: never the big blind twice in a row
    return { ring: p, button: bbUid, deadSb: false, bbUid };                     // the engine advances to the other player (button + SB)
  }
  const bbI = p.indexOf(bbUid);
  const button = p[(bbI - 3 + 3 * n) % n];                                       // the engine advances one: button p[bbI-2], SB p[bbI-1]
  const deadSb = last.sb_key != null && p[(bbI - 1 + n) % n] === String(last.sb_key);
  return { ring: p, button, deadSb, bbUid };
}
/** who posts at the next hands (repeated blindPlan on simulated hands, nobody arriving or leaving): the big blinds in order, `count` of them */
function upcomingBB(ring, last, count) {
  const out = [];
  let lr = last, r = ring.slice();
  for (let h = 0; h < (count || ring.length) && r.length >= 2; h++) {
    const pl = blindPlan(r, lr, []);
    r = pl.ring;
    const seen = simulate(r, pl.button, pl.deadSb);
    out.push(seen.bb_key);
    lr = { bb_key: seen.bb_key, sb_key: seen.sb_key, order: r.slice(), button: seen.button };
  }
  return out;
}
/** what hmengine.startHand does with the button (its own rule, copied for the planner's tests and upcomingBB) */
function simulate(ring, button, deadSb) {
  const n = ring.length;
  const btn = ring.includes(button) ? ring[(ring.indexOf(button) + 1) % n] : ring[0];
  const b = ring.indexOf(btn);
  const sbI = n === 2 ? b : (b + 1) % n, bbI = n === 2 ? (b + 1) % 2 : (b + 2) % n;
  return { button: btn, sb_key: ring[sbI], bb_key: ring[bbI], dead_sb: !!deadSb };
}
/** the order the next big blinds fall in at a table (the mover for balancing is the first of these who didn't just arrive) */
function bbOrder(ring, last) {
  ring = (ring || []).map(String);
  if (!ring.length) return [];
  let start = 0;
  if (last && Array.isArray(last.order) && last.bb_key != null) {
    const pl = blindPlan(ring, last, []);
    if (pl.bbUid) start = ring.indexOf(pl.bbUid);
  }
  if (start < 0) start = 0;
  return ring.slice(start).concat(ring.slice(0, start));
}

// ── the table rules (tables: [{no, state: "live"|"breaking"|"closed", final, opened_level, seated, inbound}]) ──
const isLive = (t) => t.state === "live" || t.state === "breaking";
const eff = (t) => (t.seated || 0) + (t.inbound || 0);
/** candidates for arrivals / balancing: live, not breaking, not the final table */
const candidates = (tables) => tables.filter((t) => t.state === "live" && !t.final);
/** the table with the fewest effective players, ties the lowest number (never `not`) */
function minTable(tables, not) {
  let best = null;
  for (const t of candidates(tables)) {
    if (not != null && t.no === not) continue;
    if (!best || eff(t) < eff(best) || (eff(t) === eff(best) && t.no < best.no)) best = t;
  }
  return best;
}
/** a late entrant's table: the fewest effective players (ties the lowest number); when every candidate is full, a breaking table with room
 *  is un-marked and used; else a new table is needed -> {no} | {unbreak: no} | {open: true} */
function lateTarget(tables, size) {
  const m = minTable(tables);
  if (m && eff(m) < size) return { no: m.no };
  const br = tables.filter((t) => t.state === "breaking" && eff(t) < size).sort((a, b) => eff(a) - eff(b) || a.no - b.no)[0];
  if (br) return { unbreak: br.no };
  return { open: true };
}
/** may table `no` give a player now? (it has the most effective players among the candidates and max - min >= 2) -> the target's no | null */
function balanceTarget(tables, no) {
  const c = candidates(tables);
  const me = c.find((t) => t.no === no);
  if (!me || c.length < 2) return null;
  const mx = Math.max(...c.map(eff)), mn = Math.min(...c.map(eff));
  if (eff(me) !== mx || mx - mn < 2) return null;
  const t = minTable(tables, no);
  return t ? t.no : null;
}
/** the break condition: live players fit in one table fewer (with `slack` while late registration is open) */
function shouldBreak(liveN, tables, size, slack) {
  const k = tables.filter(isLive).length;
  return k > 1 && liveN <= (k - 1) * size - (slack || 0);
}
/** the table to break: the fewest effective players, ties the highest number; while late registration is open never one opened within
 *  the last 2 levels (a late table - the start tables, opened_level null, never count as opened then); never the final table -> its no | null */
function breaker(tables, { lateOpen, level } = {}) {
  let best = null;
  for (const t of tables) {
    if (t.state !== "live" || t.final) continue;
    if (lateOpen && t.opened_level != null && level - t.opened_level < 2) continue;   // (review: a start table, opened_level null, isn't protected)
    if (!best || eff(t) < eff(best) || (eff(t) === eff(best) && t.no > best.no)) best = t;
  }
  return best ? best.no : null;
}
/** a broken table's players, in draw order, each to the candidate with the fewest effective players (ties the lowest number) -> [[uid, no]] */
function assignBreak(order, tables, breakingNo) {
  const ts = tables.map((t) => Object.assign({}, t));
  const out = [];
  for (const uid of order) {
    const t = minTable(ts.filter((x) => x.no !== breakingNo));
    if (!t) return null;
    out.push([uid, t.no]);
    t.inbound = (t.inbound || 0) + 1;
  }
  return out;
}
/** the final table: late registration closed, everyone left fits one table, more than one live table */
const finalDue = (lateOpen, liveN, tables, size) => !lateOpen && liveN <= size && tables.filter(isLive).length > 1;
/** start seating: k = ceil(E / size) tables, player i of the draw -> table (i mod k) + 1 (counts differ by at most one) */
function startSplit(order, size) {
  const k = Math.max(1, Math.ceil(order.length / size));
  const tables = Array.from({ length: k }, () => []);
  order.forEach((uid, i) => tables[i % k].push(uid));
  return tables;
}

module.exports = { drawOrder, newSeed, commitOf, blindPlan, upcomingBB, simulate, bbOrder, eff, isLive, candidates, minTable, lateTarget, balanceTarget,
                   shouldBreak, breaker, assignBreak, finalDue, startSplit, _h48: h48 };
