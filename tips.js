// tips.js — the ONE PAT tip money path (1.99pv: moved out of index.js unchanged so posttips.js and future tip
// surfaces share it; the /u/<name>/tip page + pad modal, the chatbot !tip route and 💸 post tips all call transferPat).
//
// Routing (unchanged): the sender's "tip sent" row (-amount, requireCover) and the recipient's "tip received" row
// (+amount) through ledger.post - the recipient gets the FULL amount, there is no cut, no fee and no minimum beyond
// 1 PAT. Both rows carry counterparty (the other account) and the optional note; the achievements count those rows
// (achievements.js tips_sent_pat / tips_recv_pat, achsocial.js tip_people / tip_fans), so every caller counts alike.
//
//   transferPat(senderUsername, recipientUsername, amount, note = null, opts = {})
//     opts.notice   {title, body, link, ref} overrides the recipient's inbox notice (default: "<x> tipped you PAT n",
//                   link /history). The notice kind is always "tip" (so the Telegram "tip" alert follows it).
//   -> {ok, status, msg, amount, balance, sentTx, recvTx}  (sentTx / recvTx = the two transactions ids, 1.99pv)
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const ledger = require("./ledger");
const inbox = require("./inbox");

// Optional short message riding on a web tip, stored on both ledger rows (transactions.note) and
// shown to the recipient on their history and on the tip page. Plain text, one line, capped.
const TIP_NOTE_MAX = 80;
let noteP = null;
/** transactions.note exists (added on first use; index.js starts it at the same point it always did). */
function noteReady() {
  if (!noteP) noteP = runQuery("ALTER TABLE transactions ADD COLUMN note TEXT").catch(() => {});
  return noteP;
}
function cleanTipNote(v) {
  const s = String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ").trim();
  return s ? Array.from(s).slice(0, TIP_NOTE_MAX).join("") : null;
}

// Shared, overdraft-safe PAT transfer used by every tip endpoint.
// The debit is a single atomic conditional UPDATE (check + deduct in one statement),
// so concurrent tips can never overdraw a balance or mint PAT — this is what the old
// read-then-check-then-update flow got wrong (a TOCTOU race that created PAT).
// Returns { ok, status, msg }.
async function transferPat(senderUsername, recipientUsername, rawAmount, note = null, opts = {}) {
  const amount = Math.floor(Number(rawAmount));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, status: 400, msg: "Invalid tip amount" };
  }
  if (!senderUsername || !recipientUsername) {
    return { ok: false, status: 400, msg: "Missing sender or recipient" };
  }
  if (senderUsername === recipientUsername) {
    return { ok: false, status: 400, msg: "Cannot tip oneself" };
  }

  const users = await getQuery(
    "SELECT username, userId, points_balance FROM users WHERE username IN (?, ?)",
    [senderUsername, recipientUsername]
  );
  const sender = users.find((u) => u.username === senderUsername);
  const recipient = users.find((u) => u.username === recipientUsername);
  if (!sender || !recipient) {
    return { ok: false, status: 404, msg: "One or both users not found" };
  }

  // Atomic conditional debit: the balance check and the deduction are the SAME statement.
  // If the balance is insufficient, no row changes and nothing is deducted.
  // 1.99ga: through the ledger - each leg is logged only when its balance really moved, and a
  // recipient that vanished in the meantime (merged / deleted) puts the sender's PAT back.
  await noteReady();
  const debit = await ledger.post(sender.userId, -amount, "tip sent",
                                  { requireCover: true, counterparty: recipient.userId, note, source: "tip" });
  if (!debit.ok) {
    return debit.code === ledger.E_INSUFFICIENT
      ? { ok: false, status: 400, msg: "Insufficient balance" }
      : { ok: false, status: 404, msg: "One or both users not found" };
  }
  const credit = await ledger.post(recipient.userId, amount, "tip received",
                                   { counterparty: sender.userId, note, resolveMerged: true, source: "tip" });
  if (!credit.ok) {
    await ledger.reverse(debit, -amount);
    return { ok: false, status: 404, msg: "One or both users not found" };
  }

  // the recipient's inbox (1.99au): who, how much, and the note if there was one
  const n = opts && opts.notice ? opts.notice : null;
  inbox.addSafe(recipient.userId, n
    ? { kind: "tip", title: n.title, body: n.body != null ? n.body : (note ? `"${note}"` : ""), link: n.link || "/history", ref: n.ref || null }
    : { kind: "tip", title: `${sender.username} tipped you PAT ${amount.toLocaleString("en-US")}`,
        body: note ? `"${note}"` : "", link: "/history" });

  const achievements = require("./achievements");   // lazy: achievements.js pulls in a lot at load
  achievements.checkWeb(sender.userId);            // tipped / tips-received achievements
  achievements.checkWeb(recipient.userId);
  require("./streaks").note(sender.userId, "tip");   // 1.99xi: 🔥 sending a tip keeps the daily streak
  const after = await getQuery("SELECT points_balance FROM users WHERE userId = ?", [sender.userId]);
  return { ok: true, status: 200, msg: "Tip sent successfully.", amount,
           balance: after.length ? Math.floor(after[0].points_balance || 0) : null,
           senderId: sender.userId, recipientId: credit.userId || recipient.userId,
           sentTx: debit.transactionId, recvTx: credit.transactionId };
}

module.exports = { transferPat, cleanTipNote, noteReady, TIP_NOTE_MAX };
