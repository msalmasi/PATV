// nopat.js — 1.99ans: THE HARD RULE "no PAT for dollars" (NY S5935-A; the owner, 2026-11-11: donations are "Perks only,
// no PAT").
//
// Real money never buys PAT. A Stripe card donation or a crypto (USDC / USDT) donation:
//   * credits NO PAT to the donor's wallet (no "donation" / "donation-crypto" transactions row),
//   * books NO "mint:donation" reserve_claims row, so nothing is minted - not the donor's PAT, not the +bonus% for the
//     incentive budget,
//   * gets no promo rate (donationpromo.js: a promo can't be created, and none applies),
// and gives 💚 supporter perks instead (supporter.js: the Supporter flair and its tier, the two achievements and their
// cosmetics). Card subscriptions (Prime Time / Season Pass / Prime Time Plus by card, stripebilling.js) were never PAT -
// they extend the tier itself.
//
// NOT A SETTING. Pepe's synced donation_rate / donation_bonus_pct (policy/cfgspec.js, funding.donationTerms()) are still
// carried for the record, but nothing applies them: no setting, promo, admin or sync can turn PAT-for-dollars back on.
// It is enforced in three places (test/nopat.test.js):
//   1. donorTerms()    the one donation "credit" both rails take their numbers from (donationpromo.creditTerms): 0 PAT, 0 bonus
//   2. the rails       stripebilling.handleEvent / cryptopay.settle record the donation and never post a credit or a claim
//   3. ledger.post()   refuses ANY positive credit labelled as a dollar donation (refusedCredit), whoever calls it
// Every donation is still RECORDED as before: stripe_events (outcome "donation-perks"), crypto_payments (status 'credited',
// pat 0) and donation_usd_log (status 'credited' = counted, pat 0) - donations.js reads them. Balances credited before 1.99ans
// are untouched, and so are their mint:donation claims.
"use strict";

const PAT_PER_USD = 0;
const BONUS_PCT = 0;
// what a dollar donation's PAT credit was labelled (stripebilling.js / cryptopay.js before 1.99ans)
const DOLLAR_TYPES = Object.freeze(["donation", "donation-crypto"]);
const DOLLAR_SOURCES = Object.freeze(["stripe donation", "crypto donation"]);

/**
 * The terms of a dollar donation of `cents`: always 0 PAT and 0 bonus. The fields are the old credit shape
 * (donationpromo.split), so every caller that used to read a PAT amount reads 0.
 */
function donorTerms(cents) {
  const c = Math.max(0, Math.floor(Number(cents) || 0));
  return Object.freeze({ usd_cents: c, pat: 0, bonus: 0, rate: PAT_PER_USD, bonus_pct: BONUS_PCT,
                         promo_cents: 0, normal_cents: c, promo_pat: 0, normal_pat: 0, promo_rate: 0, promo: null, perks_only: true });
}

/** Would this ledger post credit PAT for dollars? (ledger.post refuses it) */
function refusedCredit(amount, type, opts = {}) {
  if (!(Number(amount) > 0)) return false;
  return DOLLAR_TYPES.includes(String(type || "")) || DOLLAR_SOURCES.includes(String((opts && opts.source) || "").toLowerCase());
}

/** Throws when someone tries to give PAT for a dollar donation (a guard for code paths that compute an amount). */
function assertNoPat(amount, where = "donation") {
  if (Number(amount) !== 0) throw Object.assign(new Error(`no PAT for dollars (${where}): refused ${amount} PAT`), { code: "E_NO_PAT_FOR_DOLLARS" });
  return 0;
}

module.exports = { PAT_PER_USD, BONUS_PCT, DOLLAR_TYPES, DOLLAR_SOURCES, donorTerms, refusedCredit, assertNoPat };
