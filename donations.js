// donations.js — 1.99ans: every donation PATV has received (card or crypto), both eras, read from ONE place - the readers
// that used to look only for "mint:donation" claims (supporter.js, achievements.js, supportpage.js, hublooks.js).
//
//   before 1.99ans  a donation credited PAT and booked a reserve_claims "mint:donation" row (meta.usd_cents; claimId
//                   "don-<stripe event>" for a card, "cdon-<hash>" for crypto). Its donation_usd_log row (since 1.99ts) has
//                   the SAME ref as the claim, so it's counted once.
//   since 1.99ans   no PAT for dollars (nopat.js): a donation is only its donation_usd_log row (status 'credited', pat 0) -
//                   there is no claim.
// SQL = a subquery (user_id, usd_cents, at (ms), ref, via) over both. Call init() once before using it (both tables exist).
"use strict";
const { getQuery } = require("./dbUtils");

const SQL = `(SELECT c.userId AS user_id, CAST(COALESCE(json_extract(c.meta, '$.usd_cents'), 0) AS INTEGER) AS usd_cents,
                     CAST(strftime('%s', c.created) AS INTEGER) * 1000 AS at, c.claimId AS ref,
                     CASE WHEN c.claimId LIKE 'cdon-%' THEN 'crypto' ELSE 'card' END AS via
                FROM reserve_claims c WHERE c.flow = 'mint:donation' AND c.amount > 0 AND c.userId IS NOT NULL
              UNION ALL
              SELECT l.user_id, l.usd_cents, l.paid_at, l.ref, l.via FROM donation_usd_log l
                WHERE l.status = 'credited' AND l.user_id IS NOT NULL
                  AND NOT EXISTS (SELECT 1 FROM reserve_claims c2 WHERE c2.claimId = l.ref AND c2.flow = 'mint:donation'))`;

let ready = null;
/** Both tables exist (reserve_claims: funding.js; donation_usd_log: donationpromo.js). */
function init() {
  if (!ready) {
    ready = (async () => {
      await require("./funding").init();
      await require("./donationpromo").init();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** One account's donations: {n, cents}. */
async function totalsFor(userId) {
  await init();
  const r = (await getQuery(`SELECT COUNT(*) AS n, COALESCE(SUM(usd_cents), 0) AS cents FROM ${SQL} d WHERE d.user_id = ?`, [String(userId)]))[0];
  return { n: Number(r.n) || 0, cents: Number(r.cents) || 0 };
}

module.exports = { SQL, init, totalsFor };
