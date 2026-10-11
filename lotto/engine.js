// lotto/engine.js — Pepeball's rules, schedule, fairness and prize plan (pure: no I/O). 1.99mj, docs/lotto-backend.md.
//
// The rules are Pepe's pepe_lotto.py, unchanged: pick 4 of 1-30 + a Pepe Ball 1-10, PAT 1,000 a ticket (an admin setting
// on Pepe - carried over at the cutover), the draw every Sunday 21:00 America/New_York, sales close 5 minutes before.
// 40% of every ticket (pot_share) builds the jackpot pot, the other 60% goes to the House (jackpot_rakes). Fixed prizes
// are paid by the House (scaled down pro rata if it can't cover them, after the Fed's flash liquidity), the jackpot
// (4 + Pepe Ball) by the pot, capped at 100M, split per winning ticket.
//
// Fairness (new with the backend - Pepe used SystemRandom): commit / reveal with the players' tickets as the client seed.
//   * when a draw opens its sales, a secret server_seed (32 random bytes, hex) is made and commitment = sha256(server_seed)
//     is published before anyone buys;
//   * when sales close, tickets_digest = sha256 of every ticket of the draw, one line "<id>:<w1>,<w2>,<w3>,<w4>:<pb>\n" in
//     id order, is published (the full list is public, without owners) - nobody, the site included, knows it before;
//   * the numbers come from the casino's byte stream (casino/fair.js words: HMAC-SHA256(server_seed,
//     `${tickets_digest}:${draw}:${counter}`)): a partial Fisher-Yates over 1..30 picks the four (sorted), then the
//     Pepe Ball = 1 + below(10); after the draw the seed is revealed and anyone can re-derive the numbers (verify()).
"use strict";
const crypto = require("crypto");
const { words, below } = require("../casino/fair");

const WHITE_MAX = 30, WHITE_PICK = 4, PB_MAX = 10;
const RULES = Object.freeze({
  PRICE: 1000,                 // Pepe's LOTTO_PRICE (admin setting price_lotto_ticket) - the cutover carries the live value
  POT_SHARE: 0.40,             // Pepe's LOTTO_POT_SHARE (admin setting lotto_pot_share)
  JACKPOT_CAP: 100000000,
  CLOSE_SECS: 300,
  DRAW_DOW: 0,                 // Sunday (JS: Sun = 0; Pepe's Mon=0 weekday 6)
  DRAW_HOUR: 21,
  TZ: "America/New_York",
  MAX_PER_BUY: 500,
  POT_RESEED: 1000000,         // after a jackpot hit Pepe reseeds the pot (House surplus, then the incentive budget)
  MILESTONE: 1000,             // tickets: Pepe announces every multiple
  CLOSING_SECS: 3600,          // "last call" this long before sales close
});
// (white matches, pepe ball) -> PAT; the jackpot is (4, true)
const PRIZES = Object.freeze({ "4:0": 500000, "3:1": 150000, "3:0": 15000, "2:1": 7500, "2:0": 1000, "1:1": 3000, "0:1": 1500 });
const PRIZE_ORDER = [[4, false], [3, true], [3, false], [2, true], [2, false], [1, true], [0, true]];   // Pepe's dict order

const tierKey = (w, ball) => `${w}:${ball ? 1 : 0}`;
const reasonOf = (w, ball) => `lotto-${w}${ball ? "pb" : ""}`;

function validPick(w, pb) {
  if (!Array.isArray(w) || w.length !== WHITE_PICK) return false;
  const s = new Set(w);
  return s.size === WHITE_PICK && w.every((n) => Number.isInteger(n) && n >= 1 && n <= WHITE_MAX) && Number.isInteger(pb) && pb >= 1 && pb <= PB_MAX;
}

/** A quick pick from a crypto RNG. */
function quickPick() {
  const pool = Array.from({ length: WHITE_MAX }, (_, i) => i + 1);
  for (let i = 0; i < WHITE_PICK; i++) {
    const j = i + crypto.randomInt(WHITE_MAX - i);
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }
  return [pool.slice(0, WHITE_PICK).sort((a, b) => a - b), 1 + crypto.randomInt(PB_MAX)];
}

// ── schedule: Sunday 21:00 America/New_York ──
const fmtParts = new Intl.DateTimeFormat("en-US", { timeZone: RULES.TZ, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
                                                    hour: "numeric", minute: "numeric", second: "numeric", weekday: "short" });
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function zoned(tsSec) {
  const o = {};
  for (const p of fmtParts.formatToParts(new Date(tsSec * 1000))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd: WD[o.weekday] };
}
/** The epoch seconds of a wall-clock time in the lotto's time zone. */
function wallToTs(y, m, d, h) {
  const want = Date.UTC(y, m - 1, d, h) / 1000;
  let guess = want + 5 * 3600;
  for (let i = 0; i < 3; i++) {
    const p = zoned(guess);
    guess += want - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) / 1000;
  }
  return guess;
}
/** Pepe's _lotto_next_draw_ts: the next Sunday 21:00 ET strictly after `after` (epoch seconds). */
function nextDrawTs(after) {
  const p = zoned(after);
  const days = (RULES.DRAW_DOW - p.wd + 7) % 7;
  const base = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  let t = wallToTs(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), RULES.DRAW_HOUR);
  if (t <= after) {
    const b2 = new Date(Date.UTC(p.y, p.m - 1, p.d + days + 7));
    t = wallToTs(b2.getUTCFullYear(), b2.getUTCMonth() + 1, b2.getUTCDate(), RULES.DRAW_HOUR);
  }
  return t;
}

// ── fairness ──
const newServerSeed = () => crypto.randomBytes(32).toString("hex");
const commitment = (seed) => crypto.createHash("sha256").update(String(seed), "utf8").digest("hex");
const ticketLine = (t) => `${t.id}:${t.w.join(",")}:${t.pb}\n`;
/** tickets: [{id, w, pb}] in id order */
function ticketsDigest(tickets) {
  const h = crypto.createHash("sha256");
  for (const t of tickets) h.update(ticketLine(t), "utf8");
  return h.digest("hex");
}
function drawNumbers(serverSeed, digest, draw) {
  const next = words(serverSeed, digest, draw);
  const pool = Array.from({ length: WHITE_MAX }, (_, i) => i + 1);
  for (let i = 0; i < WHITE_PICK; i++) {
    const j = i + below(next, WHITE_MAX - i);
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }
  return { white: pool.slice(0, WHITE_PICK).sort((a, b) => a - b), pb: 1 + below(next, PB_MAX) };
}
/** rec: {draw, commitment, server_seed, tickets_digest, white, pb, tickets?} -> {ok, commitment_ok, digest_ok, numbers_ok, white, pb} */
function verify(rec) {
  if (!rec || !rec.server_seed) return { ok: false, reason: "the seed isn't revealed yet" };
  const commitmentOk = commitment(rec.server_seed) === String(rec.commitment || "");
  const digestOk = !Array.isArray(rec.tickets) || ticketsDigest(rec.tickets.map((t) => (Array.isArray(t) ? { id: t[0], w: t[1], pb: t[2] } : t))) === rec.tickets_digest;
  const n = drawNumbers(rec.server_seed, rec.tickets_digest, rec.draw);
  const numbersOk = !rec.white || (n.pb === Number(rec.pb) && n.white.join(",") === (rec.white || []).join(","));
  return { ok: commitmentOk && digestOk && numbersOk, commitment_ok: commitmentOk, digest_ok: digestOk, numbers_ok: numbersOk, white: n.white, pb: n.pb };
}

// ── prizes ──
function tierOf(t, white, pb) {
  const s = new Set(white);
  return { w: t.w.filter((n) => s.has(n)).length, ball: t.pb === pb };
}

/**
 * Pepe's _lotto_run_draw, as a plan. tickets: [{uid, name, w, pb}]; house / pot = the balances at the draw.
 * Per TICKET like Pepe (int() of each scaled prize, the jackpot split per winning ticket); then grouped per player and
 * reason for the credits. -> {white, pb, scale, jackpot, jackpot_tickets, fixed_total, entries:[{uid,name,reason,amount,
 *    tickets}], winners (winning tickets paid), paid}
 */
function plan({ tickets, white, pb, house, pot, cap = RULES.JACKPOT_CAP }) {
  const fixed = [], jp = [];
  for (const t of tickets) {
    const tr = tierOf(t, white, pb);
    if (tr.w === WHITE_PICK && tr.ball) jp.push(t);
    else if (PRIZES[tierKey(tr.w, tr.ball)] !== undefined) fixed.push({ t, amount: PRIZES[tierKey(tr.w, tr.ball)], reason: reasonOf(tr.w, tr.ball) });
  }
  house = Math.max(0, Math.trunc(Number(house) || 0));
  const fixedTotal = fixed.reduce((s, x) => s + x.amount, 0);
  const scale = fixedTotal <= house ? 1 : house / fixedTotal;
  const perTicket = fixed.map((x) => ({ uid: x.t.uid, name: x.t.name, reason: x.reason, amount: Math.trunc(x.amount * scale) }));
  const jackpot = Math.max(0, Math.min(Math.trunc(Number(pot) || 0), cap));
  if (jp.length && jackpot) {
    const each = Math.floor(jackpot / jp.length);
    for (const t of jp) perTicket.push({ uid: t.uid, name: t.name, reason: "lotto-jackpot", amount: each });
  }
  const groups = new Map();
  for (const p of perTicket) {
    const k = p.uid + "|" + p.reason;
    const g = groups.get(k) || { uid: p.uid, name: p.name, reason: p.reason, amount: 0, tickets: 0 };
    g.amount += p.amount; g.tickets += 1;
    groups.set(k, g);
  }
  return { white, pb, scale, jackpot, jackpot_tickets: jp.length, jackpot_winners: jp.map((t) => t.name), fixed_total: fixedTotal,
           entries: Array.from(groups.values()), winners: perTicket.length, paid: perTicket.reduce((s, p) => s + p.amount, 0) };
}

/** "1 in N" odds for matching exactly `w` whites, with or without the Pepe Ball (lotto.js oddsFor). */
function C(n, k) { if (k < 0 || k > n) return 0; let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return Math.round(r); }
function oddsFor(w, ball) {
  const pW = (C(WHITE_PICK, w) * C(WHITE_MAX - WHITE_PICK, WHITE_PICK - w)) / C(WHITE_MAX, WHITE_PICK);
  const p = pW * (ball ? 1 / PB_MAX : (PB_MAX - 1) / PB_MAX);
  return p > 0 ? Math.round(1 / p) : null;
}

module.exports = { WHITE_MAX, WHITE_PICK, PB_MAX, RULES, PRIZES, PRIZE_ORDER, tierKey, reasonOf, validPick, quickPick, zoned, wallToTs,
                   nextDrawTs, newServerSeed, commitment, ticketsDigest, ticketLine, drawNumbers, verify, tierOf, plan, oddsFor };
