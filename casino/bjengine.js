// casino/bjengine.js — the blackjack engine of the casino backend (1.99lj). A straight port of Pepe's
// camfrog-bot/blackjack_engine.py with the SAME rules, so a table plays identically on the site and in Camfrog:
//
//   6-deck shoe (a fresh provably-fair shuffle each round, see fair.js), blackjack pays 3:2, the dealer HITS soft 17,
//   double on any first two cards, split pairs (equal value) to 4 hands, split aces get one card each (no resplit,
//   no double), double after split allowed, insurance (half the bet, pays 2:1) when the dealer shows an Ace, the
//   dealer peeks under a ten, no surrender.
//
// Pure: no I/O, no money, no clock, no randomness. The whole table is ONE plain JSON object (newTable), so the service
// can save it after every change and load it after a restart. Every call returns a list of event objects with the
// same shapes as the Python engine's ("round_start", "deal", "insurance_offer", "insurance_result", "prompt",
// "acted", "dealer_reveal", "dealer_draw", "settle", "round_end"). Illegal actions throw BJError (message for the
// player). Money is moved by the service (casino/service.js); the engine only tracks bet AMOUNTS.
"use strict";

const BLACKJACK_PAYOUT = 1.5;      // 3:2
const RANKS = "23456789TJQKA";
const SUITS = "shdc";

class BJError extends Error {}

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push(r + s);
  return d;
}
function makeShoe(numDecks) {
  let s = [];
  for (let i = 0; i < numDecks; i++) s = s.concat(makeDeck());
  return s;
}

function cardValue(c) {
  const r = c[0];
  if ("TJQK".includes(r)) return 10;
  if (r === "A") return 11;
  return Number(r);
}

/** [best total, is soft] - aces count 11 until that would bust */
function handValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) { total += cardValue(c); if (c[0] === "A") aces++; }
  while (total > 21 && aces) { total -= 10; aces--; }
  return [total, aces > 0];
}
const isBlackjack = (cards) => cards.length === 2 && handValue(cards)[0] === 21;

const SUIT_SYM = { s: "♠", h: "♥", d: "♦", c: "♣" };
const cardStr = (c) => (c[0] === "T" ? "10" : c[0]) + SUIT_SYM[c[1]];
const cardsStr = (cs) => cs.map(cardStr).join(" ");

function newTable({ numDecks = 6, minBet = 100, maxBet = 100000, hitSoft17 = true } = {}) {
  return {
    num_decks: numDecks, min_bet: minBet, max_bet: maxBet, hit_soft_17: !!hitSoft17,
    seats: [], names: {}, round_no: 0, phase: "idle", leaving: [],
    bets: {}, insurance: {}, hands: [], hand_ptr: 0, round_players: [], dealer: [], shoe: [], si: 0, actor: null,
    results: null,
  };
}

function newRoundFields(t) {
  t.bets = {}; t.insurance = {}; t.hands = []; t.hand_ptr = 0; t.round_players = []; t.dealer = [];
  t.shoe = []; t.si = 0; t.actor = null; t.results = null;
}

const newHand = (key, bet) => ({ key, cards: [], bet, doubled: false, done: false, is_bj: false, from_split: false,
                                 split_aces: false, outcome: null, payout: 0 });

function draw(t) {
  if (t.si >= t.shoe.length) throw new BJError("the shoe ran out.");     // 312 cards: never in practice
  return t.shoe[t.si++];
}

// ── seating & bets ──
function sit(t, key, name) {
  if (!t.seats.includes(key)) t.seats.push(key);
  t.names[key] = name;
}

/** Remove a player between rounds (true), or queue it while a round is live (false). */
function leave(t, key) {
  if (!t.seats.includes(key)) throw new BJError("you're not at the table.");
  if (["insurance", "player", "dealer"].includes(t.phase)) {
    if (!t.leaving.includes(key)) t.leaving.push(key);
    return false;
  }
  t.seats = t.seats.filter((k) => k !== key);
  delete t.names[key]; delete t.bets[key]; delete t.insurance[key];
  return true;
}

function openBetting(t) {
  newRoundFields(t);
  t.phase = "betting";
}

/** 1.99ov: the table's limits hold for everyone (the High Roller role no longer lifts the maximum - it opens 💎 tables) */
function placeBet(t, key, name, amount) {
  if (!["betting", "idle"].includes(t.phase)) throw new BJError("betting is closed — wait for the next round.");
  amount = Math.trunc(Number(amount));
  if (!(amount >= t.min_bet) || amount > t.max_bet) {
    throw new BJError(`bet must be ${t.min_bet.toLocaleString("en-US")}–${t.max_bet.toLocaleString("en-US")}.`);
  }
  sit(t, key, name);
  t.bets[key] = amount;
  if (t.phase === "idle") t.phase = "betting";
  return amount;
}

const insuranceAmount = (t, key) => Math.floor((t.bets[key] || 0) / 2);
const hasBet = (t) => Object.values(t.bets).some((v) => v > 0);

function handView(t, h) {
  const [total, soft] = handValue(h.cards);
  return { key: h.key, name: t.names[h.key], cards: h.cards.slice(), value: total, soft, blackjack: h.is_bj };
}

// ── round lifecycle ──
/** Deal a round from `shoe` (the fair shuffle, fair.js). commitment is echoed in the round_start event. */
function startRound(t, shoe, commitment = null) {
  const players = t.seats.filter((k) => (t.bets[k] || 0) > 0);
  if (!players.length) throw new BJError("no bets placed.");
  t.round_no += 1;
  t.round_players = players;
  t.hands = []; t.hand_ptr = 0; t.dealer = []; t.insurance = {}; t.results = null;
  t.shoe = shoe.slice(); t.si = 0;
  for (const k of players) t.hands.push(newHand(k, t.bets[k]));
  for (const h of t.hands) h.cards.push(draw(t));
  t.dealer.push(draw(t));
  for (const h of t.hands) h.cards.push(draw(t));
  t.dealer.push(draw(t));
  for (const h of t.hands) if (isBlackjack(h.cards)) { h.is_bj = true; h.done = true; }

  const ev = [{ t: "round_start", round_no: t.round_no, commitment },
              { t: "deal", dealer_up: t.dealer[0], hands: t.hands.map((h) => handView(t, h)) }];
  const up = t.dealer[0];
  if (up[0] === "A") {
    t.phase = "insurance";
    ev.push({ t: "insurance_offer", dealer_up: up });
    return ev;
  }
  if (cardValue(up) === 10 && isBlackjack(t.dealer)) return ev.concat(dealerRevealAndSettle(t));
  return ev.concat(beginPlayerPhase(t));
}

function takeInsurance(t, key) {
  if (t.phase !== "insurance") throw new BJError("insurance isn't open.");
  if ((t.bets[key] || 0) <= 0) throw new BJError("you're not in this round.");
  if (key in t.insurance) throw new BJError("you already took insurance.");
  const amt = Math.floor(t.bets[key] / 2);
  if (amt <= 0) throw new BJError("your bet is too small to insure.");
  t.insurance[key] = amt;
  return amt;
}

/** Close the insurance window and peek the hole card. */
function finishInsurance(t) {
  if (t.phase !== "insurance") throw new BJError("insurance isn't open.");
  if (isBlackjack(t.dealer)) return dealerRevealAndSettle(t);
  return [{ t: "insurance_result", dealer_bj: false }].concat(beginPlayerPhase(t));
}

// ── player actions ──
function handIndex(t, h) {
  const same = t.hands.filter((x) => x.key === h.key);
  return [same.indexOf(h), same.length];
}
const canDoubleHand = (h) => h.cards.length === 2 && !h.split_aces;
function canSplitHand(t, h) {
  if (h.cards.length !== 2 || h.split_aces) return false;
  if (cardValue(h.cards[0]) !== cardValue(h.cards[1])) return false;
  return t.hands.filter((x) => x.key === h.key).length < 4;
}

function promptEvent(t, h) {
  const [idx, n] = handIndex(t, h);
  const [total, soft] = handValue(h.cards);
  return { t: "prompt", who: h.key, name: t.names[h.key], cards: h.cards.slice(), value: total, soft,
           can_double: canDoubleHand(h), can_split: canSplitHand(t, h), hand_index: idx, num_hands: n };
}

function beginPlayerPhase(t) {
  t.phase = "player";
  t.hand_ptr = 0;
  return resumePlayer(t);
}

function resumePlayer(t) {
  while (t.hand_ptr < t.hands.length && t.hands[t.hand_ptr].done) t.hand_ptr++;
  if (t.hand_ptr < t.hands.length) {
    const h = t.hands[t.hand_ptr];
    t.actor = h.key;
    return [promptEvent(t, h)];
  }
  return dealerPlay(t);
}

function currentHand(t) {
  if (t.phase !== "player" || t.hand_ptr >= t.hands.length) return null;
  return t.hands[t.hand_ptr];
}
const canDouble = (t) => { const h = currentHand(t); return !!h && canDoubleHand(h); };
const canSplit = (t) => { const h = currentHand(t); return !!h && canSplitHand(t, h); };

function act(t, key, action) {
  if (t.phase !== "player") throw new BJError("there's no blackjack decision to make right now.");
  const h = t.hands[t.hand_ptr];
  if (h.key !== key) throw new BJError(`it's not your turn — waiting on ${t.names[t.actor] || "another player"}.`);
  action = String(action).toLowerCase();
  const name = t.names[key];

  if (action === "hit") {
    h.cards.push(draw(t));
    const total = handValue(h.cards)[0];
    const ev = [{ t: "acted", who: key, name, action: "hits", cards: h.cards.slice(), value: total, bust: total > 21 }];
    if (total >= 21) { h.done = true; return ev.concat(resumePlayer(t)); }
    return ev.concat([promptEvent(t, h)]);
  }
  if (action === "stand") {
    h.done = true;
    const total = handValue(h.cards)[0];
    return [{ t: "acted", who: key, name, action: "stands", cards: h.cards.slice(), value: total }].concat(resumePlayer(t));
  }
  if (action === "double") {
    if (!canDoubleHand(h)) throw new BJError("you can only double on a two-card hand.");
    h.bet *= 2; h.doubled = true;
    h.cards.push(draw(t));
    h.done = true;
    const total = handValue(h.cards)[0];
    return [{ t: "acted", who: key, name, action: "doubles", cards: h.cards.slice(), value: total, bust: total > 21 }]
      .concat(resumePlayer(t));
  }
  if (action === "split") {
    if (!canSplitHand(t, h)) throw new BJError("you can't split that hand.");
    const ev = [{ t: "acted", who: key, name, action: "splits", cards: h.cards.slice() }];
    doSplit(t, h);
    const cur = t.hands[t.hand_ptr];
    if (cur.done) return ev.concat(resumePlayer(t));                 // split aces: one card each, done
    if (handValue(cur.cards)[0] >= 21) { cur.done = true; return ev.concat(resumePlayer(t)); }
    t.actor = cur.key;
    return ev.concat([promptEvent(t, cur)]);
  }
  throw new BJError(`unknown action '${action}'.`);
}

function doSplit(t, h) {
  const [c1, c2] = h.cards;
  const aces = c1[0] === "A";
  h.cards = [c1, draw(t)];
  h.from_split = true;
  const h2 = newHand(h.key, h.bet);
  h2.cards = [c2, draw(t)];
  h2.from_split = true;
  if (aces) { h.split_aces = h2.split_aces = true; h.done = h2.done = true; }
  t.hands.splice(t.hand_ptr + 1, 0, h2);
}

// ── dealer & settlement ──
function dealerShouldHit(t) {
  const [total, soft] = handValue(t.dealer);
  if (total < 17) return true;
  return total === 17 && soft && t.hit_soft_17;
}

function dealerPlay(t) {
  t.phase = "dealer";
  const ev = [{ t: "dealer_reveal", cards: t.dealer.slice(), value: handValue(t.dealer)[0], blackjack: isBlackjack(t.dealer) }];
  const live = t.hands.some((h) => !h.is_bj && handValue(h.cards)[0] <= 21);
  if (live) {
    while (dealerShouldHit(t)) {
      const c = draw(t);
      t.dealer.push(c);
      ev.push({ t: "dealer_draw", card: c, cards: t.dealer.slice(), value: handValue(t.dealer)[0] });
    }
  }
  return ev.concat(settle(t));
}

function dealerRevealAndSettle(t) {
  return [{ t: "dealer_reveal", cards: t.dealer.slice(), value: handValue(t.dealer)[0], blackjack: true }].concat(settle(t));
}

function settle(t) {
  const dv = handValue(t.dealer)[0];
  const dealerBust = dv > 21;
  const dealerBj = isBlackjack(t.dealer);
  for (const h of t.hands) {
    const v = handValue(h.cards)[0];
    if (v > 21) { h.outcome = "bust"; h.payout = 0; }
    else if (h.is_bj) {
      if (dealerBj) { h.outcome = "push"; h.payout = h.bet; }
      // Python: int(round(bet * 2.5)) - banker's rounding on .5; bets are whole PAT so bet*2.5 ends in .0 or .5
      else { h.outcome = "blackjack"; h.payout = roundHalfEven(h.bet * (1 + BLACKJACK_PAYOUT)); }
    } else if (dealerBj) { h.outcome = "lose"; h.payout = 0; }
    else if (dealerBust || v > dv) { h.outcome = "win"; h.payout = h.bet * 2; }
    else if (v === dv) { h.outcome = "push"; h.payout = h.bet; }
    else { h.outcome = "lose"; h.payout = 0; }
  }
  t.phase = "done";
  const results = [];
  for (const k of t.round_players) {
    const ph = t.hands.filter((h) => h.key === k);
    const ins = k in t.insurance ? t.insurance[k] : null;
    const insWon = ins !== null && dealerBj;
    const insPayout = insWon ? ins * 3 : 0;             // 2:1 win + the stake back
    const totalPayout = ph.reduce((s, h) => s + h.payout, 0) + insPayout;
    const totalBet = ph.reduce((s, h) => s + h.bet, 0) + (ins || 0);
    const lost = ph.filter((h) => h.outcome === "lose" || h.outcome === "bust").reduce((s, h) => s + h.bet, 0)
      + (ins !== null && !insWon ? ins : 0);
    results.push({
      key: k, name: t.names[k],
      hands: ph.map((h) => ({ cards: h.cards.slice(), value: handValue(h.cards)[0], outcome: h.outcome, bet: h.bet,
                              payout: h.payout, is_bj: h.is_bj, doubled: !!h.doubled, from_split: !!h.from_split })),
      insurance: ins !== null ? { amount: ins, won: insWon, payout: insPayout } : null,
      total_bet: totalBet, total_payout: totalPayout, lost,
    });
  }
  t.results = { t: "settle", dealer: { cards: t.dealer.slice(), value: dv, bust: dealerBust, blackjack: dealerBj }, results };
  return [t.results, { t: "round_end" }];
}

function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

module.exports = {
  BJError, BLACKJACK_PAYOUT, makeDeck, makeShoe, cardValue, handValue, isBlackjack, cardStr, cardsStr,
  newTable, sit, leave, openBetting, placeBet, insuranceAmount, hasBet, startRound, takeInsurance, finishInsurance,
  act, currentHand, canDouble, canSplit, handIndex, roundHalfEven,
};
