// staffgrant.js — the /admin/economy "PAT grant" card (POST /api/admin/transfer/:username).
//
// 1.99jt (user decision 2026-10-10): a staff grant is PAID BY THE FEDERAL RESERVE, never minted. The site books a
// "staff_grant" reserve_claims row (funding.takeReserveRef - always the Reserve, whatever the PAT Routing table says)
// that Pepe settles by draining his Reserve (the same vault `!econ fedmint` tops up). A grant the Reserve can't cover
// right now (its synced balance net of unsettled claims; a Reserve Pepe never synced covers nothing) is refused.
// A negative amount takes PAT back from the member (only what they have) and returns it to the Reserve.
// The member's history entry is unchanged: "staff transfer" (shown as "Staff transfer").
"use strict";
const funding = require("./funding");
const ledger = require("./ledger");
const { getQuery } = require("./dbUtils");

const FLOW = "staff_grant";
const MAX = 1e12;
const fmt = (n) => Math.trunc(Number(n) || 0).toLocaleString("en-US");

// -> {status, body: {message, ...}}; success keeps the old "Points transferred successfully." message
async function grant(username, rawAmount, by) {
  const amount = Number(rawAmount);
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > MAX) {
    return { status: 400, body: { message: "Amount must be a whole number of PAT (not 0)." } };
  }
  const rows = await getQuery("SELECT userId FROM users WHERE username = ?", [String(username || "")]);
  if (!rows.length) return { status: 404, body: { message: `No account called ${username}.` } };
  const userId = rows[0].userId;
  const src = { source: "admin transfer" + (by ? ` by ${by}` : "") };

  if (amount > 0) {
    const take = await funding.takeReserveRef(FLOW, amount, userId, "staff transfer");
    if (!take.ok) {
      const msg = take.available === null
        ? "The Federal Reserve's balance isn't known yet (Pepe hasn't synced it) - nothing was granted."
        : `The Federal Reserve can't cover ${fmt(amount)} PAT (it has ${fmt(take.available)} PAT available) - nothing was granted.`;
      return { status: 409, body: { message: msg, code: "E_RESERVE_SHORT", available: take.available } };
    }
    const r = await ledger.post(userId, amount, "staff transfer", src);
    if (!r.ok) {
      try { await take.undo(); } catch (e) { console.error("[staffgrant] undo failed:", e.message); }
      return { status: 500, body: { message: "Failed to transfer points.", code: r.code } };
    }
    console.log(`[staffgrant] ${fmt(amount)} PAT -> ${username} from the Federal Reserve${by ? ` (by ${by})` : ""}`);
    return { status: 200, body: { message: "Points transferred successfully.", from: "reserve" } };
  }

  // a clawback: only what the member has, and it goes back into the Reserve
  const r = await ledger.post(userId, amount, "staff transfer", Object.assign({ requireCover: true }, src));
  if (!r.ok) {
    if (r.code === ledger.E_INSUFFICIENT) return { status: 409, body: { message: `${username} doesn't have ${fmt(-amount)} PAT.`, code: r.code } };
    return { status: 500, body: { message: "Failed to transfer points.", code: r.code } };
  }
  try {
    await funding.takeReserveRef(FLOW, amount, userId, "staff transfer");
  } catch (e) {
    await ledger.reverse(r, amount);
    return { status: 500, body: { message: "Failed to transfer points." } };
  }
  console.log(`[staffgrant] ${fmt(-amount)} PAT <- ${username} back to the Federal Reserve${by ? ` (by ${by})` : ""}`);
  return { status: 200, body: { message: "Points transferred successfully.", from: "reserve" } };
}

module.exports = { grant, FLOW };
