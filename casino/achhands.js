// casino/achhands.js — 1.99pa: what a settled casino hand is worth in achievements (pure: no I/O). Shared by the site's
// rewards (casino/rewards.js, every backend seat) and mirrored line for line by Pepe's local tables (camfrog-bot
// pepe_casinoach.py), so the same hand counts the same on both.
//
// Hold'em (a SHOWDOWN only - an uncontested pot shows nothing):
//   hm_boats / hm_quads / hm_sflush / hm_royal   won a pot with that hand, and the hole cards made it (the board alone
//                                                 wasn't already that good - a royal flush on the board is nobody's)
//   hm_72        won the main pot holding 7-2 offsuit           hm_big_pots  took 1,000,000+ chips from one hand
//   hm_allin_wins  won a pot with no chips behind (all-in: lose it and you were out)
//   hm_busts     one per player at the showdown who lost their last chip, to each main-pot winner
//   hm_badbeats  lost the main pot holding quads or better (hole cards counting), or as a BIG favourite with one card to
//                come: on the turn's board this hand won outright on at least BADBEAT_EQ of the river cards left
//   casino_hr_wins  won a pot at a High Roller table
//   hm_board_royal  1.99pk: the five board cards ARE a royal flush - every player still in the hand (at the showdown, or the
//                   one left when everyone else folded after the river)
// Blackjack (one seat's settled round):
//   bj_charlies (a winning hand of 5+ cards), bj_double_wins, bj_split_sweeps (split, and every hand won),
//   bj_insurance_wins, round result for the streaks (win / loss / push), casino_hr_wins (a hand won at a High Roller table)
"use strict";
const H = require("./hmengine");

const BIG_POT = 1000000;
const BADBEAT_EQ = 0.85;
const RANKS = "23456789TJQKA";
const SUITS = "shdc";

/** The five board cards are themselves a royal flush (1.99pk: 👑 Royal Treatment for everyone still in the hand). */
function boardRoyal(board) {
  if (!Array.isArray(board) || board.length !== 5) return false;
  const r = H.eval5(board);
  return r[0] === 8 && r[1] === 14;
}

/** Did the hole cards make this hand (better than the board's own five)? */
function holeMatters(rank, board) {
  return board.length === 5 ? H.cmp(rank, H.eval5(board)) > 0 : true;
}

/** Share of the possible river cards on which `who` wins outright, with every shown hand known (board = the turn's 4). */
function riverEquity(hands, who, board4) {
  const known = new Set(board4.concat(...Object.values(hands)));
  let n = 0, won = 0;
  for (const r of RANKS) for (const s of SUITS) {
    const c = r + s;
    if (known.has(c)) continue;
    n++;
    const b = board4.concat([c]);
    const mine = H.bestHand(hands[who].concat(b));
    let best = true;
    for (const [k, h] of Object.entries(hands)) if (k !== who && H.cmp(H.bestHand(h.concat(b)), mine) >= 0) { best = false; break; }
    if (best) won++;
  }
  return n ? won / n : 0;
}

/**
 * A hold'em showdown. reveals: [{who, cards}], board: 5 cards, awards: [{who, amount, pot}], stacks: {who: chips after the hand}.
 * -> {who: {metric: n}} (only the metrics that moved)
 */
function holdemShowdown({ reveals, board, awards, stacks, highStakes }) {
  const out = {};
  const add = (k, m, n = 1) => { (out[k] = out[k] || {})[m] = ((out[k] || {})[m] || 0) + n; };
  if (!Array.isArray(reveals) || reveals.length < 2 || !Array.isArray(board) || board.length !== 5) return out;
  const hands = {}, rank = {};
  for (const r of reveals) { hands[r.who] = r.cards.slice(); rank[r.who] = H.bestHand(r.cards.concat(board)); }
  const won = {};
  for (const a of awards || []) if (a.who in hands) won[a.who] = (won[a.who] || 0) + (Number(a.amount) || 0);
  const main = new Set((awards || []).filter((a) => a.pot === "main pot" || a.pot === undefined).map((a) => a.who));
  if (boardRoyal(board)) for (const k of Object.keys(hands)) add(k, "hm_board_royal");     // 1.99pk: everyone at the showdown
  for (const [k, amt] of Object.entries(won)) {
    if (!(amt > 0)) continue;
    const rk = rank[k], made = holeMatters(rk, board);
    if (made && rk[0] === 6) add(k, "hm_boats");
    if (made && rk[0] === 7) add(k, "hm_quads");
    if (made && rk[0] === 8) add(k, "hm_sflush");
    if (made && rk[0] === 8 && rk[1] === 14) add(k, "hm_royal");
    if (amt >= BIG_POT) add(k, "hm_big_pots");
    if (stacks && Number(stacks[k]) - amt === 0) add(k, "hm_allin_wins");
    if (highStakes) add(k, "casino_hr_wins");
    const [a, b] = hands[k];
    if (main.has(k) && a[1] !== b[1] && [a[0], b[0]].sort().join("") === "27") add(k, "hm_72");
  }
  const losers = Object.keys(hands).filter((k) => !main.has(k));
  const bustPairs = [];
  for (const k of losers) {
    if (stacks && Number(stacks[k]) === 0) for (const w of main) { add(w, "hm_busts"); bustPairs.push([w, k]); }
    const rk = rank[k];
    const monster = rk[0] >= 7 && holeMatters(rk, board);
    if (monster || riverEquity(hands, k, board.slice(0, 4)) >= BADBEAT_EQ) add(k, "hm_badbeats");
  }
  Object.defineProperty(out, "_bustPairs", { value: bustPairs, enumerable: false });   // [winner, busted] - the site checks alts
  return out;
}

/** One seat's settled blackjack round (the engine's settle result; highStakes = a 💎 High Roller table, 1.99ov).
 *  -> {metric: n, _result: 'win'|'loss'|'push'} */
function blackjackSeat(r, highStakes) {
  const out = {};
  const hands = (r && r.hands) || [];
  const winning = (h) => h.outcome === "win" || h.outcome === "blackjack";
  if (hands.some((h) => winning(h) && (h.cards || []).length >= 5)) out.bj_charlies = 1;
  const dbl = hands.filter((h) => h.doubled && winning(h)).length;
  if (dbl) out.bj_double_wins = dbl;
  const split = hands.filter((h) => h.from_split);
  if (split.length >= 2 && split.every(winning)) out.bj_split_sweeps = 1;
  if (r && r.insurance && r.insurance.won) out.bj_insurance_wins = 1;
  if (highStakes && hands.some(winning)) out.casino_hr_wins = 1;
  const net = (Number(r.total_payout) || 0) - (Number(r.total_bet) || 0);
  out._result = net > 0 ? "win" : net < 0 ? "loss" : "push";
  return out;
}

module.exports = { holdemShowdown, blackjackSeat, boardRoyal, riverEquity, holeMatters, BIG_POT, BADBEAT_EQ };
