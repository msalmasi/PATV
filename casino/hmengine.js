// casino/hmengine.js — the No-Limit Texas Hold'em engine of the casino backend (1.99lv). A straight port of Pepe's
// camfrog-bot/poker_engine.py (hand evaluation, side pots, the betting state machine, the rake) with the SAME rules
// and the same event shapes ("hand_start", "blind", "deal", "prompt", "acted", "refund", "board", "win_uncontested",
// "showdown", "awards", "hand_end") and error texts. test/casino-hm.test.js replays 250 recorded Python tables.
//
// Pure: the table is one plain JSON object (newTable) - no I/O, no money, no clock, no randomness. The deck for a hand
// comes from the caller (fair.js: one committed seed per hand; the PokerNow-style per-board reshuffle of the Python
// table isn't needed when the whole deck is committed before the deal). Chips are table chips; the service turns them
// into PAT on buy-in / cash-out, and books the rake to the House.
"use strict";

const RANKS = "23456789TJQKA";
const RANK_VAL = Object.fromEntries(RANKS.split("").map((r, i) => [r, i + 2]));
const RANK_NAME = { 14: "Ace", 13: "King", 12: "Queen", 11: "Jack", 10: "Ten", 9: "Nine", 8: "Eight", 7: "Seven", 6: "Six",
                    5: "Five", 4: "Four", 3: "Three", 2: "Two" };
const RANK_PLURAL = { 14: "Aces", 13: "Kings", 12: "Queens", 11: "Jacks", 10: "Tens", 9: "Nines", 8: "Eights", 7: "Sevens",
                      6: "Sixes", 5: "Fives", 4: "Fours", 3: "Threes", 2: "Twos" };
const RIVER = 3;
const STREET_NAME = { 0: "preflop", 1: "flop", 2: "turn", 3: "river" };

class PokerError extends Error {}

// ── hand evaluation ──
function eval5(cards) {
  const vals = cards.map((c) => RANK_VAL[c[0]]).sort((a, b) => b - a);
  const isFlush = new Set(cards.map((c) => c[1])).size === 1;
  const uniq = Array.from(new Set(vals)).sort((a, b) => b - a);
  let straightHigh = null;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq.join(",") === "14,5,4,3,2") straightHigh = 5;    // the wheel
  }
  const cnt = new Map();
  for (const v of vals) cnt.set(v, (cnt.get(v) || 0) + 1);
  const groups = Array.from(cnt.entries()).sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]));
  const counts = groups.map((g) => g[1]);
  const gr = groups.map((g) => g[0]);
  if (straightHigh && isFlush) return [8, straightHigh];
  if (counts[0] === 4) return [7, gr[0], gr[1]];
  if (counts[0] === 3 && counts[1] === 2) return [6, gr[0], gr[1]];
  if (isFlush) return [5, ...vals];
  if (straightHigh) return [4, straightHigh];
  if (counts[0] === 3) return [3, gr[0], ...gr.slice(1)];
  if (counts[0] === 2 && counts[1] === 2) return [2, gr[0], gr[1], gr[2]];
  if (counts[0] === 2) return [1, gr[0], ...gr.slice(1)];
  return [0, ...vals];
}

function cmp(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] === undefined ? -Infinity : a[i], y = b[i] === undefined ? -Infinity : b[i];
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function bestHand(seven) {
  let best = null;
  const n = seven.length;
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++)
    for (let d = c + 1; d < n; d++) for (let e = d + 1; e < n; e++) {
      const r = eval5([seven[a], seven[b], seven[c], seven[d], seven[e]]);
      if (!best || cmp(r, best) > 0) best = r;
    }
  return best;
}

function describe(rank) {
  const cat = rank[0];
  if (cat === 8) return rank[1] === 14 ? "Royal Flush" : `Straight Flush, ${RANK_NAME[rank[1]]}-high`;
  if (cat === 7) return `Four of a Kind, ${RANK_PLURAL[rank[1]]}`;
  if (cat === 6) return `Full House, ${RANK_PLURAL[rank[1]]} full of ${RANK_PLURAL[rank[2]]}`;
  if (cat === 5) return `Flush, ${RANK_NAME[rank[1]]}-high`;
  if (cat === 4) return `Straight, ${RANK_NAME[rank[1]]}-high`;
  if (cat === 3) return `Three of a Kind, ${RANK_PLURAL[rank[1]]}`;
  if (cat === 2) return `Two Pair, ${RANK_PLURAL[rank[1]]} and ${RANK_PLURAL[rank[2]]}`;
  if (cat === 1) return `Pair of ${RANK_PLURAL[rank[1]]}`;
  return `${RANK_NAME[rank[1]]}-high`;
}

/** Main + side pots. order: the players in seat order (contributions are read in that order), folded: array. */
function buildPots(order, contrib, folded) {
  const fold = new Set(folded);
  const remaining = new Map();
  for (const p of order) if ((contrib[p] || 0) > 0) remaining.set(p, contrib[p]);
  const pots = [];
  while (remaining.size) {
    const level = Math.min(...remaining.values());
    const contributors = Array.from(remaining.keys());
    const amount = level * contributors.length;
    const eligible = contributors.filter((p) => !fold.has(p));
    const last = pots[pots.length - 1];
    if (last && last.eligible.length === eligible.length && eligible.every((p) => last.eligible.includes(p))) last.amount += amount;
    else pots.push({ amount, eligible });
    for (const p of contributors) {
      remaining.set(p, remaining.get(p) - level);
      if (remaining.get(p) === 0) remaining.delete(p);
    }
  }
  const cleaned = [];
  let carry = 0;
  for (const pot of pots) {
    if (!pot.eligible.length) { carry += pot.amount; continue; }
    pot.amount += carry;
    carry = 0;
    cleaned.push(pot);
  }
  if (carry && cleaned.length) cleaned[cleaned.length - 1].amount += carry;
  return cleaned;
}

// ── the table ──
function newTable({ sb, bb, rake = 0 }) {
  const t = { sb: Math.trunc(sb), bb: Math.trunc(bb), rake: Number(rake) || 0, last_rake: 0, seats: [], chips: {}, names: {},
              button: null, hand_active: false, leaving: [], hand_no: 0 };
  resetHand(t);
  return t;
}
function resetHand(t) {
  Object.assign(t, { players: [], folded: [], allin: [], contrib: {}, street_paid: {}, current_bet: 0, min_raise: t.bb, street: 0,
                     need_act: [], actor: null, last_raiser: null, sb_key: null, bb_key: null, deck: [], di: 0, hole: {}, board: [] });
}
const has = (arr, k) => arr.includes(k);
const add = (arr, k) => { if (!arr.includes(k)) arr.push(k); };
const del = (arr, k) => { const i = arr.indexOf(k); if (i >= 0) arr.splice(i, 1); };

function sit(t, key, name, chips) {
  if (t.hand_active && !has(t.seats, key)) {
    t.seats.push(key);
    t.chips[key] = (t.chips[key] || 0) + chips;
    t.names[key] = name;
    return;
  }
  if (has(t.seats, key)) t.chips[key] += chips;
  else { t.seats.push(key); t.chips[key] = chips; }
  t.names[key] = name;
}

function stand(t, key) {
  if (!has(t.seats, key)) throw new PokerError("you're not seated at the table.");
  if (t.hand_active && has(t.players, key) && !has(t.folded, key)) {
    throw new PokerError("you're in a live hand — !fold first (you'll be cashed out after the hand).");
  }
  const chips = t.chips[key] || 0;
  delete t.chips[key];
  del(t.seats, key);
  delete t.names[key];
  del(t.leaving, key);
  if (t.button === key) t.button = null;
  return chips;
}

function requestStand(t, key) {
  if (!has(t.seats, key)) throw new PokerError("you're not seated.");
  add(t.leaving, key);
}

const seatedWithChips = (t) => t.seats.filter((k) => (t.chips[k] || 0) > 0);
const canStart = (t) => !t.hand_active && seatedWithChips(t).length >= 2;
const pot = (t) => Object.values(t.contrib).reduce((s, v) => s + v, 0);
const toCall = (t, key) => Math.max(0, t.current_bet - (t.street_paid[key] || 0));
const currentActor = (t) => (t.hand_active ? t.actor : null);

function draw(t) {
  if (t.di >= t.deck.length) throw new PokerError("the deck ran out.");
  return t.deck[t.di++];
}
function pay(t, key, amount) {
  amount = Math.min(amount, t.chips[key]);
  t.chips[key] -= amount;
  t.contrib[key] += amount;
  t.street_paid[key] += amount;
  if (t.chips[key] === 0) add(t.allin, key);
  return amount;
}
const activeCanAct = (t) => t.players.filter((k) => !has(t.folded, k) && !has(t.allin, k));
const idx = (t, key) => t.players.indexOf(key);
function firstToAct(t, start) {
  const n = t.players.length;
  for (let off = 0; off < n; off++) { const k = t.players[(start + off) % n]; if (has(t.need_act, k)) return k; }
  return null;
}
function nextToAct(t, from) {
  const n = t.players.length, s = idx(t, from);
  for (let off = 1; off <= n; off++) { const k = t.players[(s + off) % n]; if (has(t.need_act, k)) return k; }
  return null;
}
function toCallAllMatched(t) {
  for (const k of activeCanAct(t)) if (toCall(t, k) > 0) return false;
  return true;
}
function prompt(t) {
  const a = t.actor;
  return { t: "prompt", who: a, name: t.names[a], stack: t.chips[a], to_call: toCall(t, a), can_check: toCall(t, a) === 0, pot: pot(t),
           current_bet: t.current_bet, min_raise_to: t.current_bet > 0 ? t.current_bet + t.min_raise : t.bb, street: t.street,
           board: t.board.slice() };
}

/** Begin a hand with `deck` (52 cards, the fair shuffle). -> events */
function startHand(t, deck) {
  const active = seatedWithChips(t);
  if (active.length < 2) throw new PokerError("need at least 2 players with chips to deal.");
  t.hand_no += 1;
  resetHand(t);
  t.hand_active = true;
  t.players = active.slice();
  const n = t.players.length;
  if (!has(t.players, t.button)) t.button = t.players[0];
  else t.button = t.players[(idx(t, t.button) + 1) % n];
  const btn = idx(t, t.button);
  let sbI, bbI, first;
  if (n === 2) { sbI = btn; bbI = (btn + 1) % 2; first = btn; }
  else { sbI = (btn + 1) % n; bbI = (btn + 2) % n; first = (bbI + 1) % n; }
  for (const k of t.players) { t.contrib[k] = 0; t.street_paid[k] = 0; }
  t.deck = deck.slice();
  t.di = 0;
  const events = [{ t: "hand_start", hand_no: t.hand_no, button: t.button, names: Object.assign({}, t.names), sb: t.sb, bb: t.bb }];
  const sbKey = t.players[sbI], bbKey = t.players[bbI];
  t.sb_key = sbKey; t.bb_key = bbKey;
  const sbPaid = pay(t, sbKey, t.sb);
  const bbPaid = pay(t, bbKey, t.bb);
  events.push({ t: "blind", who: sbKey, name: t.names[sbKey], kind: "SB", amount: sbPaid, allin: has(t.allin, sbKey) });
  events.push({ t: "blind", who: bbKey, name: t.names[bbKey], kind: "BB", amount: bbPaid, allin: has(t.allin, bbKey) });
  t.current_bet = Math.max(...t.players.map((k) => t.street_paid[k]));
  t.min_raise = t.bb;
  t.last_raiser = bbKey;
  for (const k of t.players) t.hole[k] = [draw(t), draw(t)];
  const hole = {};
  for (const k of t.players) hole[k] = t.hole[k].slice();
  events.push({ t: "deal", hole, players: t.players.slice() });
  t.need_act = activeCanAct(t).slice();
  if (activeCanAct(t).length < 2 && toCallAllMatched(t)) return events.concat(closeAction(t));
  t.actor = firstToAct(t, first);
  if (t.actor === null) return events.concat(closeAction(t));
  events.push(prompt(t));
  return events;
}

function act(t, key, action, amount) {
  if (!t.hand_active) throw new PokerError("no hand is in progress.");
  if (key !== t.actor) throw new PokerError(`it's not your turn — waiting on ${t.names[t.actor] !== undefined ? t.names[t.actor] : "someone else"}.`);
  action = String(action).toLowerCase();
  const tocall = toCall(t, key);
  let ev;
  if (action === "fold") {
    add(t.folded, key);
    del(t.need_act, key);
    ev = { t: "acted", who: key, name: t.names[key], action: "folds" };
  } else if (action === "check") {
    if (tocall !== 0) throw new PokerError(`there's ${tocall} to call — !call or !fold (or !raise).`);
    del(t.need_act, key);
    ev = { t: "acted", who: key, name: t.names[key], action: "checks" };
  } else if (action === "call") {
    if (tocall === 0) {
      del(t.need_act, key);
      ev = { t: "acted", who: key, name: t.names[key], action: "checks" };
    } else {
      const paid = pay(t, key, tocall);
      del(t.need_act, key);
      const allin = has(t.allin, key);
      ev = { t: "acted", who: key, name: t.names[key], action: allin ? "calls all-in" : "calls", amount: paid, allin };
    }
  } else if (action === "bet" || action === "raise" || action === "allin") {
    const stack = t.chips[key];
    let target;
    if (action === "allin") target = t.street_paid[key] + stack;
    else {
      if (amount === null || amount === undefined) throw new PokerError("specify an amount, e.g. !raise 400 (raise TO 400).");
      target = Math.trunc(Number(amount));
    }
    let need = target - t.street_paid[key];
    if (need <= 0) throw new PokerError(`that's not more than you've already put in — !call to match ${t.current_bet}.`);
    const isAllin = need >= stack;
    if (isAllin) { target = t.street_paid[key] + stack; need = stack; }
    if (t.current_bet === 0) {
      if (target < t.bb && !isAllin) throw new PokerError(`minimum bet is ${t.bb}.`);
    } else {
      if (target <= t.current_bet) throw new PokerError(`a raise must exceed the current bet of ${t.current_bet}.`);
      const inc = target - t.current_bet;
      if (inc < t.min_raise && !isAllin) {
        throw new PokerError(`minimum raise is to ${t.current_bet + t.min_raise} (raise by at least ${t.min_raise}).`);
      }
    }
    pay(t, key, need);
    const newtotal = t.street_paid[key];
    const verb = has(t.allin, key) ? "goes all-in" : (t.current_bet === 0 ? "bets" : "raises to");
    if (newtotal > t.current_bet) {
      t.min_raise = Math.max(t.min_raise, newtotal - t.current_bet);
      t.current_bet = newtotal;
      t.last_raiser = key;
      t.need_act = activeCanAct(t).filter((k) => k !== key);
    } else {
      del(t.need_act, key);
    }
    ev = { t: "acted", who: key, name: t.names[key], action: verb, amount: newtotal, allin: has(t.allin, key) };
  } else {
    throw new PokerError(`unknown action '${action}'.`);
  }
  const events = [ev];
  if (nonfolded(t).length === 1) return events.concat(awardUncontested(t));
  const nxt = nextToAct(t, key);
  if (nxt === null) return events.concat(closeAction(t));
  t.actor = nxt;
  events.push(prompt(t));
  return events;
}

const nonfolded = (t) => t.players.filter((k) => !has(t.folded, k));

function refundUncalled(t) {
  const nf = nonfolded(t);
  const paids = nf.map((k) => t.street_paid[k]).sort((a, b) => b - a);
  if (paids.length < 2 || paids[0] <= paids[1]) return null;
  let top = nf[0];
  for (const k of nf) if (t.street_paid[k] > t.street_paid[top]) top = k;
  if (nf.filter((k) => t.street_paid[k] === paids[0]).length !== 1) return null;
  const excess = paids[0] - paids[1];
  t.chips[top] += excess;
  t.contrib[top] -= excess;
  t.street_paid[top] -= excess;
  if (t.chips[top] > 0) del(t.allin, top);
  return { t: "refund", who: top, name: t.names[top], amount: excess };
}

function closeAction(t) {
  const events = [];
  const ref = refundUncalled(t);
  if (ref) events.push(ref);
  if (t.street === RIVER) return events.concat(showdown(t));
  for (;;) {
    t.street += 1;
    for (const k of t.players) t.street_paid[k] = 0;
    t.current_bet = 0;
    t.min_raise = t.bb;
    t.last_raiser = null;
    if (t.street === 1) t.board.push(draw(t), draw(t), draw(t));
    else t.board.push(draw(t));
    events.push({ t: "board", street: STREET_NAME[t.street], cards: t.board.slice(), pot: pot(t) });
    const can = activeCanAct(t);
    if (can.length >= 2) {
      t.need_act = can.slice();
      const btn = idx(t, t.button);
      t.actor = firstToAct(t, (btn + 1) % t.players.length);
      if (t.actor === null) continue;
      events.push(prompt(t));
      return events;
    }
    if (t.street === RIVER) return events.concat(showdown(t));
  }
}

function awardUncontested(t) {
  const winner = nonfolded(t)[0];
  const amt = pot(t);
  t.chips[winner] += amt;
  return [{ t: "win_uncontested", who: winner, name: t.names[winner], amount: amt }].concat(finishHand(t));
}

function showdown(t) {
  const nf = nonfolded(t);
  const ranks = {};
  for (const k of nf) ranks[k] = bestHand(t.hole[k].concat(t.board));
  const reveals = nf.map((k) => ({ who: k, name: t.names[k], cards: t.hole[k].slice(), hand: describe(ranks[k]) }));
  const pots = buildPots(t.players, t.contrib, t.folded);
  const awards = [];
  const n = t.players.length, btn = idx(t, t.button);
  const order = [];
  for (let i = 0; i < n; i++) order.push(t.players[(btn + 1 + i) % n]);
  let totalRake = 0;
  pots.forEach((p, pi) => {
    const elig = p.eligible.filter((k) => k in ranks);
    if (!elig.length) return;
    let best = null;
    for (const k of elig) if (!best || cmp(ranks[k], best) > 0) best = ranks[k];
    const winners = order.filter((k) => elig.includes(k) && cmp(ranks[k], best) === 0);
    const raked = t.rake > 0 ? Math.trunc(p.amount * t.rake) : 0;
    totalRake += raked;
    const payout = p.amount - raked;
    const share = Math.floor(payout / winners.length), rem = payout % winners.length;
    winners.forEach((w, i) => {
      const got = share + (i < rem ? 1 : 0);
      t.chips[w] += got;
      awards.push({ who: w, name: t.names[w], amount: got, hand: describe(ranks[w]), pot: pi === 0 ? "main pot" : `side pot ${pi}` });
    });
  });
  t.last_rake = totalRake;
  return [{ t: "showdown", reveals, board: t.board.slice() }, { t: "awards", awards, rake: totalRake }].concat(finishHand(t));
}

function finishHand(t) {
  t.hand_active = false;
  const busted = t.players.filter((k) => (t.chips[k] || 0) === 0);
  const stacks = {};
  for (const k of t.seats) stacks[k] = t.chips[k] || 0;
  return [{ t: "hand_end", button: t.button, stacks, busted, leaving: t.leaving.slice() }];
}

const SUIT = { s: "♠", h: "♥", d: "♦", c: "♣" };
const cardStr = (c) => (c[0] === "T" ? "10" : c[0]) + SUIT[c[1]];
const cardsStr = (cs) => cs.map(cardStr).join(" ");

module.exports = {
  PokerError, RIVER, STREET_NAME, eval5, bestHand, describe, buildPots, cmp, newTable, sit, stand, requestStand, seatedWithChips,
  canStart, pot, toCall, currentActor, startHand, act, nonfolded, cardStr, cardsStr,
};
