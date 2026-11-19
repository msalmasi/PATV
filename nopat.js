// nopat.js — 1.99ans / 1.99aor: THE HARD GUARD on PAT for dollars.
//
// History: 1.99ans (NY S5935-A; the owner, 2026-11-11) made every card or crypto donation "perks only". The owner, 2026-11-18:
// that state was temporary. Since 1.99aor it is one state of the donations switch (donationmode.js: on | perks | off), and it stays
// the default. What does NOT depend on the switch is this guard: PAT is credited for dollars through ONE path only.
//
//   1. donorTerms()    the perks-only terms: 0 PAT, 0 bonus. Every donation without PAT terms gets exactly this
//   2. the rails       stripebilling.handleEvent / cryptopay.settle never post a credit or book a claim themselves: they call
//                      donationpromo.creditDonor, and only with terms fixed when the donor was quoted while the switch was "on"
//   3. ledger.post()   refuses ANY positive credit labelled as a dollar donation (refusedCredit), whoever calls it, unless it
//                      carries a live one-shot grant for exactly that account, amount, type and transaction id
// takeIssuer() hands the grant issuer out ONCE, and donationpromo.js takes it when it loads: no other module can make a grant.
// A perks-only donation is RECORDED as it was since 1.99ans: stripe_events (outcome "donation-perks"), crypto_payments (status
// 'credited', pat 0) and donation_usd_log (status 'credited' = counted, pat 0) - donations.js reads them.
"use strict";

const PAT_PER_USD = 0;
const BONUS_PCT = 0;
// what a dollar donation's PAT credit is labelled (donationpromo.creditDonor); "donation-restored" = a won dispute giving it back
const DOLLAR_TYPES = Object.freeze(["donation", "donation-crypto", "donation-restored"]);
const DOLLAR_SOURCES = Object.freeze(["stripe donation", "crypto donation"]);

/**
 * The perks-only terms of a dollar donation of `cents`: 0 PAT and 0 bonus. The fields are the credit shape
 * (donationpromo.split), so every caller that reads a PAT amount reads 0.
 */
function donorTerms(cents) {
  const c = Math.max(0, Math.floor(Number(cents) || 0));
  return Object.freeze({ usd_cents: c, pat: 0, bonus: 0, rate: PAT_PER_USD, bonus_pct: BONUS_PCT,
                         promo_cents: 0, normal_cents: c, promo_pat: 0, normal_pat: 0, promo_rate: 0, promo: null, perks_only: true });
}

const GRANTS = new WeakMap();
let issuerTaken = false;
/** The grant issuer, once: donationpromo.js takes it at load. A second caller is refused. */
function takeIssuer() {
  if (issuerTaken) throw Object.assign(new Error("the donation credit issuer is already taken"), { code: "E_NO_PAT_FOR_DOLLARS" });
  issuerTaken = true;
  return ({ userId, amount, type, ref }) => {
    const grant = Object.freeze({});
    GRANTS.set(grant, { userId: String(userId), amount: Math.trunc(Number(amount)), type: String(type), ref: String(ref), used: false });
    return grant;
  };
}

/** Would this ledger post credit PAT for dollars without a grant? (ledger.post refuses it) A matching grant is spent here. */
function refusedCredit(amount, type, opts = {}, userId = null) {
  if (!(Number(amount) > 0)) return false;
  const o = opts || {};
  if (!DOLLAR_TYPES.includes(String(type || "")) && !DOLLAR_SOURCES.includes(String(o.source || "").toLowerCase())) return false;
  const g = o.donationGrant && typeof o.donationGrant === "object" ? GRANTS.get(o.donationGrant) : null;
  if (!g || g.used || g.amount !== Math.trunc(Number(amount)) || g.type !== String(type) || g.ref !== String(o.transactionId) || g.userId !== String(userId)) return true;
  g.used = true;
  return false;
}

/** Throws when terms that aren't PAT terms carry an amount (a guard for code paths that compute one). */
function assertNoPat(amount, where = "donation") {
  if (Number(amount) !== 0) throw Object.assign(new Error(`no PAT for dollars (${where}): refused ${amount} PAT`), { code: "E_NO_PAT_FOR_DOLLARS" });
  return 0;
}

module.exports = { PAT_PER_USD, BONUS_PCT, DOLLAR_TYPES, DOLLAR_SOURCES, donorTerms, refusedCredit, assertNoPat, takeIssuer };
