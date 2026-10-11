// casino/money.js — every PAT movement of the casino backend, each done ONCE by its key (1.99lj).
//
// A key looks like "cbj:<table>:r<round>:<userId>:<op>". For a player it is the transactions.transactionId (ledger.post
// with that id), for the House it is the jackpot_rakes.jackpotId (spinId = "cbj:<table>:r<round>", which jackpotflows.js
// reports as "casino tables"). Before moving, the key is looked up: found = already done (a retry after a crash or a
// replayed request), so nothing moves twice. The service serialises its own calls (one mutex), so the
// look-up-then-move pair can't race another casino step.
"use strict";
const { runQuery, getQuery } = require("../dbUtils");
const ledger = require("../ledger");
const funding = require("../funding");

const txDone = async (key) => (await getQuery("SELECT points FROM transactions WHERE transactionId = ?", [key])).length > 0;
const houseDone = async (key) => (await getQuery("SELECT 1 FROM jackpot_rakes WHERE jackpotId = ?", [key])).length > 0;

/** Take a stake from the player (never overdraws). -> {ok, code?, replay?} */
async function charge(key, userId, amount, type) {
  amount = Math.trunc(Number(amount));
  if (!(amount > 0)) return { ok: false, code: ledger.E_BAD_AMOUNT };
  if (await txDone(key)) return { ok: true, replay: true };
  const r = await ledger.post(userId, -amount, type, { transactionId: key, requireCover: true, source: "casino" });
  return r.ok ? { ok: true } : { ok: false, code: r.code };
}

/** Pay the player (payout or refund). -> {ok, code?, replay?} */
async function credit(key, userId, amount, type) {
  amount = Math.trunc(Number(amount));
  if (!(amount > 0)) return { ok: true, none: true };
  if (await txDone(key)) return { ok: true, replay: true };
  const r = await ledger.post(userId, amount, type, { transactionId: key, resolveMerged: true, source: "casino" });
  return r.ok ? { ok: true } : { ok: false, code: r.code };
}

/** Move `amount` into (+) or out of (-) the House. */
async function house(key, spinId, userId, amount) {
  amount = Math.trunc(Number(amount));
  if (!amount) return { ok: true, none: true };
  if (await houseDone(key)) return { ok: true, replay: true };
  await runQuery("INSERT OR IGNORE INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)",
                 [key, spinId, userId || null, amount]);
  return { ok: true };
}

const houseBalance = () => funding.jackpotPot();

/** Before `profit` leaves the House: book the Fed flash claim if it would go below its hard floor (once per key). */
async function flashCover(key, profit) {
  profit = Math.trunc(Number(profit));
  if (!(profit > 0)) return { used: false };
  const prev = await getQuery("SELECT claimId, amount FROM reserve_claims WHERE flow = 'flash:house:blackjack' AND meta LIKE ?",
                              [`%"ref":"${key}"%`]).catch(() => []);
  if (prev.length) return { used: true, gap: prev[0].amount, replay: true };
  return funding.houseFlashCover("blackjack", profit, null, "blackjack payout", key);
}

const isDone = txDone;

module.exports = { charge, credit, house, houseBalance, flashCover, isDone, houseDone };
