// casino/retire.js — FAIR-1 for the CARD tables (roulette2 WP1, decision D9): a blackjack or Hold'em table copied from another database.
//
// A staging refresh (deploy/refresh-staging-db.sh: VACUUM INTO, then deploy/keep-staging-tables.js on the copy) strips every open card
// table's secrets from the copy - blackjack T.round.seed, the live shoe T.eng.shoe and (mid-round) the dealer's hole card; Hold'em
// T.next.seed, T.hand.seed + deck, T.eng.deck and every T.eng.hole - and marks the row `copied`. Prod may still be playing that very round
// or hand, so the copy is NEVER played or revealed here. At boot (service.recover for blackjack, holdem.js recover for a cash Hold'em
// table; casino/tourney.js and casino/mtt.js retire their own copies) the copy is retired instead of resumed:
//   * every PAT movement is keyed and idempotent (money.js): a crash and a re-run credit nothing twice, and the table is marked closed
//     only after every credit returned ok (a refused credit throws - the table stays open in the database and out of play here, and the
//     next boot tries again);
//   * blackjack: a charged stake caught in its intent is refunded (<key>:refund); a round already DECIDED (settle pending with results)
//     is paid by settle's own keys (payouts, House legs, Fed flash) - money only: no casino_rounds reveal, no event, no rewards; any
//     other round is void: each stake of the betting window / each double, split and insurance by <key>:refund, then what is left
//     escrowed per player (the round's initial bets, dropped from T.stakes at the deal) by cbj:<table>:r<n>:<uid>:copy;
//   * Hold'em (cash): a buy-in intent is refunded if it was charged, a cash-out intent is finished by its own key; the rake owed goes to
//     the House by its key; a hand in play is void (every contributor gets back what they put in); every stack is cashed out by a keyed
//     credit (holdem.js cashout, quiet);
//   * quiet: no casino_events row (staging's Pepe never posts a line into prod's rooms), no casino_rounds reveal, no new round, the stream
//     slot let go without advancing to another (possibly copied) table - the first tick after boot does that.
"use strict";
const money = require("./money");
const H = require("./hmengine");

/** a card table copied from another database (deploy/keep-staging-tables.js), or one whose committed seed is missing */
function isCopy(T) {
  if (!T || T.status !== "open" || (T.game !== "bj" && T.game !== "holdem")) return false;
  if (T.copied) return true;
  if (T.game === "bj") return !!(T.round && !T.round.seed);
  return !!((T.next && !T.next.seed) || (T.hand && !T.hand.seed));
}

/** out of the stream slot and its queue WITHOUT advancing it (service.streamGone would put the next queued table on now - maybe another
 *  copy, with an event); service.streamTick advances it on the first tick after boot, when every copy is closed */
function unstream(S, id) {
  if (!S || !S.stream) return;
  S.stream.queue = (S.stream.queue || []).filter((x) => x !== id);
  if (S.stream.table === id) S.stream.table = null;
}

const strict = (r, what) => {
  if (!r || !r.ok) throw Object.assign(new Error(`copy retire: ${what} refused (${r && r.code ? r.code : "?"}) - retried at the next boot`), { code: r && r.code });
  return r;
};
const crashAt = (S, name) => { if (S && S.hooks && S.hooks.crash === name) throw new Error("test crash at " + name); };   // tests only

// the Hold'em engine's per-hand fields (hmengine resetHand) - read off a fresh table, so a field added there is reset here too
const HM_TABLE_FIELDS = new Set(["sb", "bb", "rake", "last_rake", "seats", "chips", "names", "button", "hand_active", "leaving", "hand_no"]);
/** a Hold'em hand in play is void: every contributor gets back what they put in, the hand's fields are reset (no cards left) */
function voidHand(e) {
  if (e.hand_active) {
    for (const [k, v] of Object.entries(e.contrib || {})) {
      const n = Math.max(0, Math.trunc(Number(v) || 0));
      if (n) e.chips[k] = (e.chips[k] || 0) + n;
    }
  }
  const fresh = H.newTable({ sb: e.sb || 1, bb: e.bb || 2 });
  for (const k of Object.keys(fresh)) if (!HM_TABLE_FIELDS.has(k)) e[k] = fresh[k];
  e.hand_active = false;
}

/** fail closed: a copy that couldn't be retired is taken out of play here (its row stays open + copied: the next boot tries again) */
async function guarded(S, T, fn) {
  try {
    return await fn();
  } catch (e) {
    if (S && S.tables) S.tables.delete(T.id);
    console.error(`[casino] ${T.id}: a ${T.game} table copied from another database couldn't be retired yet (${e && e.message ? e.message : e}) - out of play until the next boot`);
    throw e;
  }
}

/**
 * Retire a copied BLACKJACK table. d: {S, clock, save, settleMoney} (service.js; settleMoney(T, {strict: true}) = settle()'s money legs).
 * Nothing is saved before every credit went through: a crash re-runs the same keys from the same saved state.
 */
async function bj(T, d) {
  const { S, clock, save, settleMoney } = d;
  return guarded(S, T, async () => {
    // (a) a stake caught between its intent and the table: refunded if it was charged
    if (T.intent) {
      const it = T.intent;
      if (await money.isDone(it.key)) strict(await money.credit(it.key + ":refund", it.uid, it.amount, "blackjack refund (copy)"), "the refund of " + it.key);
      T.intent = null;
    }
    const n = T.round && T.round.no ? T.round.no : T.eng.round_no + (["betting", "idle"].includes(T.eng.phase) ? 1 : 0);
    if (T.round && T.round.settle === "pending" && T.eng.results) {
      // (b) the round was decided there: paid by settle's own keys (a payout already made replays) - never refunded on top
      await settleMoney(T, { strict: true });
    } else {
      // (c) void: every stake by its own refund key (a refund already made replays), then the rest escrowed per player by the copy key
      for (const s of T.stakes || []) {
        strict(await money.credit(s.key + ":refund", s.uid, s.amount, "blackjack refund (copy)"), "the refund of " + s.key);
        T.escrowed[s.uid] = Math.max(0, (T.escrowed[s.uid] || 0) - s.amount);
        crashAt(S, "copy:refund");
      }
      for (const [uid, amt] of Object.entries(T.escrowed || {})) {
        const a = Math.max(0, Math.trunc(Number(amt) || 0));
        if (a > 0) strict(await money.credit(`cbj:${T.id}:r${n}:${uid}:copy`, uid, a, "blackjack refund (copy)"), `the copy refund of ${uid}`);
      }
    }
    crashAt(S, "copy:close");
    // (d) never charged: the queued bets and autobets go; the engine forgets the round (no card of it is left)
    const e = T.eng;
    Object.assign(e, { phase: "idle", bets: {}, insurance: {}, hands: [], hand_ptr: 0, round_players: [], dealer: [], shoe: [], si: 0, actor: null, results: null, leaving: [] });
    T.pending = {};
    T.autobet = [];
    T.escrowed = {};
    T.stakes = [];
    if (T.round) delete T.round.seed;
    T.status = "closed";
    T.closed_at = clock();
    T.dl = { bet: null, ins: null, turn: null };
    T.turn = null;
    await save(T);
    unstream(S, T.id);
    console.log(`[casino] ${T.id}: a blackjack table copied from another database closed unrevealed (round ${n})`);
  });
}

/**
 * Retire a copied cash HOLD'EM table. d: {S, clock, save, bookRake, cashout} (holdem.js; cashout(T, uid) = the quiet keyed cash-out,
 * which throws when its credit is refused and keeps the stack at the table).
 */
async function holdem(T, d) {
  const { S, clock, save, bookRake, cashout } = d;
  return guarded(S, T, async () => {
    const e = T.eng;
    // (a) intents: a charged buy-in that never reached the table is refunded; a cash-out is finished by its own key
    if (T.intent) {
      const it = T.intent;
      if (it.kind === "buy") {
        if (await money.isDone(it.key)) strict(await money.credit(it.key + ":refund", it.uid, it.amount, "holdem refund (copy)"), "the refund of " + it.key);
      } else if (it.kind === "out") {
        strict(await money.credit(it.key, it.uid, it.amount, "holdem cash-out"), "the cash-out " + it.key);
        // those chips are paid: off the stack (whatever else the seat holds is cashed out below by its own key)
        e.chips[it.uid] = Math.max(0, (e.chips[it.uid] || 0) - Math.trunc(Number(it.amount) || 0));
      }
      T.intent = null;
    }
    // (b) the rake the last hand owes the House (keyed)
    await bookRake(T);
    // (c) a hand in play is void; nothing of it (or of the next one) is revealed or kept
    voidHand(e);
    T.hand = null;
    T.next = null;
    T.replay = null;
    T.sd = null;
    T.pre = {};
    T.turn = null;
    T.dl = { turn: null, next: null, idle: null };
    crashAt(S, "copy:void");
    // (d) every stack back as PAT (keyed; journalled as an intent first, so a crash finishes it above)
    for (const k of e.seats.slice()) {
      await cashout(T, k);
      crashAt(S, "copy:cashout");
    }
    // never closed with PAT on it (chips of someone not seated can't happen at a cash table - if they ever did, the table stays open)
    const left = Object.entries(e.chips || {}).filter(([, v]) => Math.trunc(Number(v) || 0) > 0);
    if (left.length) throw new Error(`chips left at the table after every cash-out (${left.map(([k2, v]) => k2 + " " + v).join(", ")})`);
    T.status = "closed";
    T.closed_at = clock();
    T.dl = { turn: null, next: null, idle: null };
    T.turn = null;
    await save(T);
    unstream(S, T.id);
    console.log(`[casino] ${T.id}: a Hold'em table copied from another database closed unrevealed (hand ${e.hand_no})`);
  });
}

module.exports = { isCopy, bj, holdem, voidHand, unstream, guarded };
