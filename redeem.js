// redeem.js — redeeming a code for PAT (POST /api/redeem-code, index.js).
//
// 2026-10-11: the double-spend race fixed. Before, the "already used?" check and the vault draw ran BEFORE the
// transaction, so two redeems arriving together (a double-click, a script) could both pass the check and both be
// paid. Now everything happens inside ONE transaction, and the claim itself is conditional:
//   * the user's redemption row is inserted only if none exists (INSERT ... WHERE NOT EXISTS) - 0 rows = already used
//   * the code's use is taken only if one is left and it hasn't expired (UPDATE ... WHERE uses_remaining > 0) - 0 rows
//     = used up
// and only then does the vault pay (funding.takeFunds) and the ledger credit. A second concurrent redeem finds the
// row / the count already taken and fails without paying. Redeems also run one at a time in this process (the site
// shares one SQLite connection, so two BEGINs must never overlap).
"use strict";
const { v4: uuidv4 } = require("uuid");
const { runQuery, getQuery } = require("./dbUtils");
const funding = require("./funding");
const ledger = require("./ledger");

let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

class Refusal extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** -> {status, body} for the route to send */
function redeemCode(userId, code) {
  return serial(async () => {
    code = String(code == null ? "" : code);
    if (!userId) return { status: 401, body: { success: false, message: "Sign in to redeem a code." } };
    const live = await getQuery(`SELECT * FROM redemption_codes WHERE code = ? AND (expiration_date IS NULL OR expiration_date > CURRENT_TIMESTAMP)
                                 AND uses_remaining > 0`, [code]);
    if (!live.length) return { status: 404, body: { success: false, message: "That code isn't valid, has expired, or has been fully used." } };
    const points = Number(live[0].points) || 0;
    let began = false;
    try {
      await runQuery("BEGIN IMMEDIATE TRANSACTION");
      began = true;
      // the claim: one redemption per user, one use off the code - both conditional, inside the transaction
      const mine = await runQuery(`INSERT INTO user_redemptions (userId, code) SELECT ?, ?
                                   WHERE NOT EXISTS (SELECT 1 FROM user_redemptions WHERE userId = ? AND code = ?)`, [userId, code, userId, code]);
      if (!mine.changes) throw new Refusal(400, "You've already redeemed that code.");
      const use = await runQuery(`UPDATE redemption_codes SET uses_remaining = uses_remaining - 1
                                  WHERE code = ? AND uses_remaining > 0 AND (expiration_date IS NULL OR expiration_date > CURRENT_TIMESTAMP)`, [code]);
      if (!use.changes) throw new Refusal(404, "That code isn't valid, has expired, or has been fully used.");
      // 1.63: a code's PAT comes out of a vault ("redeem_codes" payout row), never minted.
      if (!(await funding.takeFunds("redeem_codes", points, userId, `redemption (${live[0].code})`))) {
        throw new Refusal(503, "The bank can't cover codes right now — try again later.");
      }
      await ledger.postOrThrow(userId, points, `redemption (${live[0].code})`, { transactionId: uuidv4(), source: "redeem" });
      await runQuery("COMMIT");
      began = false;
    } catch (e) {
      if (began) { try { await runQuery("ROLLBACK"); } catch (e2) { /* nothing to roll back */ } }
      if (e instanceof Refusal) return { status: e.status, body: { success: false, message: e.message } };
      console.error("Failed to redeem code:", e);
      return { status: 500, body: { success: false, message: "Something went wrong redeeming that code — no PAT was added." } };
    }
    const after = await getQuery("SELECT points_balance FROM users WHERE userId = ?", [userId]);
    const bal = after.length ? (after[0].points_balance || 0) : null;
    return { status: 200, body: { success: true, message: `Code redeemed successfully — +${points.toLocaleString()} PAT` +
                                  (bal === null ? "." : `. Balance: ${bal.toLocaleString()} PAT.`), points, balance: bal } };
  });
}

module.exports = { redeemCode };
