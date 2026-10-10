// staffgrant.js — the /admin/economy "PAT grant" card (POST /api/admin/transfer/:username) and the /admin/games
// House adjustment (POST /api/g/wheel/jackpot).
//
// 1.99jw (Economy v3, user decision 2026-10-10: "the Reserve only funds the protocol"):
//   * the PAT grant is ADMIN ONLY and PAID BY THE INCENTIVE BUDGET, never by the Federal Reserve and never minted. The
//     site books an "incentives:staff_grant" reserve_claims row (funding.takeIncentivesRef) that Pepe settles against
//     his incentive budget. Outside every weekly group budget, but refused when the budget isn't known yet, when its
//     balance net of unsettled incentive claims can't cover it (409 E_INCENTIVES_SHORT), or when Pepe's weekly staff
//     grant cap (monetary.grant_weekly_cap, -1 = unlimited) would be passed (409 E_GRANT_CAP). Never queued.
//     A negative amount takes PAT back from the member (only what they have) and returns it to the incentive budget.
//     The member's history entry is unchanged: "staff transfer" (shown as "Staff transfer").
//   * the House adjustment is ADMIN ONLY, needs a written reason, and is a Fed <-> House MOVE, never a free mint:
//     + = a "house_adjust" Reserve claim first (refused when the Reserve can't cover it), then the House row;
//     - = only what the House holds, and a negative "house_adjust" claim (Pepe credits the Reserve). Audited (adminaudit).
// (1.99jt had the grant on the Reserve; before that it was an uncapped mint open to Staff.)
"use strict";
const { v4: uuidv4 } = require("uuid");
const funding = require("./funding");
const ledger = require("./ledger");
const { runQuery, getQuery } = require("./dbUtils");

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
    const take = await funding.takeIncentivesRef(FLOW, amount, userId, "staff transfer");
    if (!take.ok) {
      if (take.reason === "unknown") {
        return { status: 409, body: { message: "The incentive budget isn't known yet - Pepe hasn't synced it. Nothing was granted.",
                                      code: "E_INCENTIVES_UNKNOWN", available: null } };
      }
      if (take.reason === "cap") {
        return { status: 409, body: { message: `That would pass this week's staff grant cap of ${fmt(take.cap)} PAT (${fmt(take.used)} PAT granted so far this week) - nothing was granted.`,
                                      code: "E_GRANT_CAP", cap: take.cap, used: take.used, available: take.available } };
      }
      return { status: 409, body: { message: `The incentive budget can't cover ${fmt(amount)} PAT (it has ${fmt(take.available)} PAT available) - nothing was granted.`,
                                    code: "E_INCENTIVES_SHORT", available: take.available } };
    }
    const r = await ledger.post(userId, amount, "staff transfer", src);
    if (!r.ok) {
      try { await take.undo(); } catch (e) { console.error("[staffgrant] undo failed:", e.message); }
      return { status: 500, body: { message: "Failed to transfer points.", code: r.code } };
    }
    console.log(`[staffgrant] ${fmt(amount)} PAT -> ${username} from the incentive budget${by ? ` (by ${by})` : ""}`);
    return { status: 200, body: { message: "Points transferred successfully.", from: "incentives" } };
  }

  // a clawback: only what the member has, and it goes back into the incentive budget
  const r = await ledger.post(userId, amount, "staff transfer", Object.assign({ requireCover: true }, src));
  if (!r.ok) {
    if (r.code === ledger.E_INSUFFICIENT) return { status: 409, body: { message: `${username} doesn't have ${fmt(-amount)} PAT.`, code: r.code } };
    return { status: 500, body: { message: "Failed to transfer points.", code: r.code } };
  }
  try {
    await funding.takeIncentivesRef(FLOW, amount, userId, "staff transfer");
  } catch (e) {
    await ledger.reverse(r, amount);
    return { status: 500, body: { message: "Failed to transfer points." } };
  }
  console.log(`[staffgrant] ${fmt(-amount)} PAT <- ${username} back to the incentive budget${by ? ` (by ${by})` : ""}`);
  return { status: 200, body: { message: "Points transferred successfully.", from: "incentives" } };
}

// 1.99jw: the House adjustment. admin = {userId, username} (an Admin - the route checks the class). -> {status, body}
async function houseAdjust(admin, rawAmount, rawReason) {
  const amount = Number(rawAmount);
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > MAX) {
    return { status: 400, body: { message: "Amount must be a whole number of PAT (not 0)." } };
  }
  const reason = String(rawReason == null ? "" : rawReason).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200);
  if (reason.length < 8) return { status: 400, body: { message: "Write a reason (at least 8 characters) - it goes in the admin log." } };
  const tx = require("./boosts").tx;
  let out;
  try {
    out = await tx(async () => {
      const before = await funding.jackpotPot();
      let claim;
      if (amount > 0) {
        // Fed -> House: the Reserve pays it (a claim Pepe settles by draining the Reserve into the House)
        claim = await funding.takeReserveRef("house_adjust", amount, admin.userId, reason);
        if (!claim.ok) {
          return { status: 409, body: { code: "E_RESERVE_SHORT", available: claim.available,
            message: claim.available === null ? "The Federal Reserve's balance isn't known yet (Pepe hasn't synced it) - the House wasn't changed."
                                              : `The Federal Reserve can't cover ${fmt(amount)} PAT (it has ${fmt(claim.available)} PAT available) - the House wasn't changed.` } };
        }
      } else if (before < -amount) {
        return { status: 409, body: { code: "E_HOUSE_SHORT", available: Math.max(0, before),
                                      message: `The House only holds ${fmt(Math.max(0, before))} PAT - it can't return ${fmt(-amount)} PAT to the Reserve.` } };
      }
      const spinId = "admin:" + uuidv4();       // 1.99gx: tagged - an admin's adjustment (jackpotflows.js)
      await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)", [uuidv4(), spinId, admin.userId, amount]);
      // House -> Fed: a negative claim, Pepe credits the Reserve
      if (amount < 0) claim = await funding.takeReserveRef("house_adjust", amount, admin.userId, reason);
      return { status: 200, before, after: before + amount, claimId: claim.claimId, spinId };
    });
  } catch (e) {
    console.error("[house_adjust]", e);
    return { status: 500, body: { message: "Failed to update the jackpot." } };
  }
  if (out.status !== 200) return out;
  console.log(`[house_adjust] ${admin.username || admin.userId}: ${amount > 0 ? "Fed -> House" : "House -> Fed"} ${fmt(Math.abs(amount))} PAT `
    + `(House ${fmt(out.before)} -> ${fmt(out.after)}, claim ${out.claimId}): ${reason}`);
  try {
    await require("./adminaudit").record(admin, "house_adjust", null,
      { amount, house_before: out.before, house_after: out.after, claimId: out.claimId, spinId: out.spinId }, reason);
  } catch (e) { console.error("[house_adjust] audit:", e.message); }
  return { status: 200, body: { message: "Jackpot updated successfully.", jackpotTotal: out.after, direction: amount > 0 ? "fed_to_house" : "house_to_fed" } };
}

module.exports = { grant, houseAdjust, FLOW };
