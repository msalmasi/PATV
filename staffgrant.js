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

// ── the two web routes (index.js mounts them; test/policy-owner-gates.test.js mounts the same functions) ──
// PO-0b (D-6): both are a Pepe OWNER's - the capability's class AND the owner role on the linked chat login, read fresh
// (staffroles.ownerOf). The owner check runs before anything moves.
// Owner answers 2026-10-20 (3): + the password step-up (stepup.js: a same-origin fetch, a single-use nonce from
// POST /api/admin/stepup/nonce {for: grant|house} and the account password, 5 wrong in 15 min -> 429) after the owner check
// and before anything moves. A refusal answers {message, code}.
async function stepUpOr(req, res, me) {
  try {
    await require("./stepup").check(req, me, req.body || {});
    return true;
  } catch (e) {
    if (e && e.refuse) { res.status(e.status).json({ message: e.message, code: e.code }); return false; }
    throw e;
  }
}

/** POST /api/g/wheel/jackpot (after addUser + requireUser). 1.99jw: Admins only (Staff lost it), a written reason, a Fed <->
 *  House MOVE (houseAdjust). The class as the DATABASE has it now (the JWT's can be stale). */
async function houseAdjustRoute(req, res) {
  try {
    const SP = require("./siteperms");
    const me = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]))[0];
    if (!SP.can(me, "econ.house_adjust")) return res.status(403).json({ message: "Admins only." });
    const SR = require("./staffroles");
    if (!(await SR.ownerOf(me, "econ.house_adjust"))) return res.status(403).json({ message: SR.OWNER_ONLY });
    if (!(await stepUpOr(req, res, me))) return;
    const r = await houseAdjust({ userId: me.userId, username: me.username }, (req.body || {}).amount, (req.body || {}).reason);
    res.status(r.status).json(r.body);
  } catch (error) {
    console.error("[house_adjust]", error);
    res.status(500).json({ message: "Failed to update the jackpot." });
  }
}

/** POST /api/admin/transfer/:username (after authenticateToken + addUser). 1.99jw: Admins only (Staff lost access), paid by
 *  the incentive budget (grant). */
async function grantRoute(req, res) {
  const SP = require("./siteperms");
  if (SP.can(req.user, "econ.grant_pat")) {
    const SR = require("./staffroles");
    const me = await SR.ownerOf(req.user, "econ.grant_pat");
    if (!me) return res.status(403).json({ message: SR.OWNER_ONLY });
    try {
      if (!(await stepUpOr(req, res, me))) return;
      const r = await grant(req.params.username, req.body && req.body.amount, req.user.username);
      return res.status(r.status).json(r.body);
    } catch (error) {
      console.error("[staffgrant]", error);
      return res.status(500).json({ message: "Failed to transfer points." });
    }
  }
  if (SP.can(req.user, "admin.area")) return res.status(403).json({ message: "PAT grants are for Admins only." });
  if (typeof req.flash === "function") req.flash("error", "Access denied. You must be an admin or staff to access this page.");
  return res.redirect("/login");
}

/** POST /api/admin/redemption-codes (after authenticateToken + addUser): add or change a redemption code. 1.99abn: Admins only
 *  (a code pays out of a vault). Owner answers 2026-10-20 (1): a Pepe OWNER's (the class + the owner role on the linked chat
 *  login, read fresh) - an Admin who isn't one gets 403 and nothing is written. Deleting a code (index.js) stays Admins'. */
async function codesRoute(req, res) {
  const SP = require("./siteperms");
  if (!SP.can(req.user, "econ.codes_manage")) {
    if (typeof req.flash === "function") req.flash("error", "Access denied. You must be an admin or staff to access this page.");
    return res.redirect("/login");
  }
  const SR = require("./staffroles");
  if (!(await SR.ownerOf(req.user, "econ.codes_manage"))) return res.status(403).json({ message: SR.OWNER_ONLY });
  const { code, points, uses_allowed, expiration_date } = req.body || {};
  try {
    const existingCode = await getQuery("SELECT code FROM redemption_codes WHERE code = ?", [code]);
    if (existingCode.length > 0) {
      await runQuery("UPDATE redemption_codes SET points = ?, uses_allowed = ?, uses_remaining = ?, expiration_date = ? WHERE code = ?", [points, uses_allowed, uses_allowed, expiration_date, code]);
    } else {
      await runQuery("INSERT INTO redemption_codes (code, points, uses_allowed, uses_remaining, expiration_date) VALUES (?, ?, ?, ?, ?)", [code, points, uses_allowed, uses_allowed, expiration_date]);
    }
    console.log(`[codes] ${req.user.username} saved a redemption code (${Number(points) || 0} PAT x ${Number(uses_allowed) || 0} uses)`);   // never the code itself
    res.json({ message: "Points transferred successfully." });
  } catch (error) {
    console.error("Failed to update redemption code:", error);
    res.status(500).send("Failed to update redemption code");
  }
}

module.exports = { grant, houseAdjust, houseAdjustRoute, grantRoute, codesRoute, FLOW };
