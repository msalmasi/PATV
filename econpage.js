// econpage.js — the locals for the public PAT Economy page (/economy, views/economy.ejs). 1.99lx design pass.
//
// Read-only: it only gathers numbers the site already has, for the page's live section -
//   * patSupply() (index.js, the same thing GET /api/stats/supply returns): total, layers, every pool's balance
//   * funding.state: the incentive budget (Pepe's E-2 treasury sync) and the Fed band (Pepe's monetary block)
//   * supplyhistory.history(): one row per UTC day (total, the Fed, its band, PAT minted by source, PAT burned) -
//     public aggregates only (no user data); the admin API (/api/admin/econ/supply-history) is unchanged
// No money logic, no new routes. Every part is optional: a missing piece renders as "not reported yet".
"use strict";

const DAYS = 90;

/** {key: amount} of the supply rows we name on the page. */
function pools(supply) {
  const out = {};
  for (const r of (supply && supply.rows) || []) out[r.key] = Math.max(0, Math.floor(Number(r.amount) || 0));
  return out;
}

/** Supply history rows -> what the chart needs (oldest first): day, total, fed, floor, ceiling, minted, burned. */
function series(rows) {
  return (rows || []).map((r) => {
    const m = r.mints && typeof r.mints === "object" ? r.mints : {};
    const minted = Object.values(m).reduce((t, v) => t + (Math.max(0, Number(v) || 0)), 0);
    const b = r.band || {};
    return { day: r.day, total: Number(r.total) || 0, fed: r.fed == null ? null : Number(r.fed) || 0,
             floor: b.floor == null ? null : Number(b.floor), ceiling: b.ceiling == null ? null : Number(b.ceiling),
             minted, burned: Math.max(0, Number(r.burns) || 0), mints: m };
  });
}

/** The live section's data (every field may be null). */
async function live({ patSupply } = {}) {
  const F = require("./funding");
  let supply = null;
  try { supply = patSupply ? await patSupply() : null; } catch (e) { supply = null; }
  let hist = [];
  try { hist = series(await require("./supplyhistory").history(DAYS)); } catch (e) { hist = []; }
  const P = pools(supply);
  const m = F.state.monetary;
  const lastBand = [...hist].reverse().find((h) => h.floor != null || h.ceiling != null) || null;
  const band = m && m.band && (m.band.floor != null || m.band.ceiling != null) ? m.band
    : lastBand ? { fed: lastBand.fed, floor: lastBand.floor, ceiling: lastBand.ceiling } : null;
  const fed = P["vault:reserve"] != null ? P["vault:reserve"] : band && band.fed != null ? band.fed : F.state.reserve;
  const sum = (k) => hist.slice(-30).reduce((t, h) => t + (h[k] || 0), 0);
  const first30 = hist.length ? hist[Math.max(0, hist.length - 30)] : null;
  const last = hist.length ? hist[hist.length - 1] : null;
  return {
    supply: supply ? { total: supply.total, circulating: supply.circulating, burned: supply.burned,
                       layers: (supply.layers || []).map((l) => ({ key: l.key, label: l.label, blurb: l.blurb, amount: l.amount })),
                       updated: supply.updated } : null,
    pools: P,
    fed: fed == null ? null : Math.floor(Number(fed) || 0),
    band: band ? { floor: band.floor == null ? null : Number(band.floor), ceiling: band.ceiling == null ? null : Number(band.ceiling) } : null,
    incentives: F.state.incentives || null,
    // Economy v3: the donation terms for the PAT map ($1 = rate PAT to the donor, + bonus_pct% to the incentive budget)
    donation: F.donationTerms(),
    fortknox: P["vault:fortknox"] != null ? P["vault:fortknox"] : F.state.fortknox,
    history: hist,
    month: { minted: sum("minted"), burned: sum("burned"),
             change: first30 && last && first30.total ? (last.total - first30.total) / first30.total : null },
  };
}

/** The paid-room-command split for the PAT map, from Pepe's live routing: the room_owner % he syncs per room flow
 *  (royalties.ownerShares(); the most common non-zero share, default 10) - the rest is half Fort Knox, half the room's
 *  vault (economy v2 room routing). -> {owner, fortknox, room} in %. */
function roomSplit() {
  let owner = 10;
  try {
    if (require("./royalties").frozen()) return { owner: 0, fortknox: 50, room: 50 };   // E-4: the share is room-vault income now
    const counts = new Map();
    for (const s of require("./royalties").ownerShares()) if (s.pct > 0) counts.set(s.pct, (counts.get(s.pct) || 0) + 1);
    if (counts.size) owner = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  } catch (e) { /* default */ }
  const half = Math.round(((100 - owner) / 2) * 100) / 100;
  return { owner, fortknox: half, room: half };
}

/** Is Pepe's pad launchpad switched on (launch grants paying)? Off -> the page shows launch grants as coming soon. */
function launchpadOn() {
  try { return require("./launchpad").isOn(); } catch (e) { return false; }
}

/** Everything views/economy.ejs takes. */
async function locals(req, { patSupply } = {}) {
  const F = require("./funding");
  // economy v2 E-3: the room vaults section, only while Pepe's room vaults are live (roomvaults.js)
  let roomVaults = null;
  if (F.roomVaultsLive()) {
    try { roomVaults = await require("./roomvaults").overview(10); } catch (e) { roomVaults = null; }
  }
  let L = null;
  try { L = await live({ patSupply }); } catch (e) { console.error("[econpage]", e.message); L = null; }
  return { user: req.user ? req.user.username : null, treasury: F.treasuryOn() ? F.state.incentives : null, roomVaults, live: L,
           roomSplit: roomSplit(), launchpadOn: launchpadOn(), staking: await stakingRules() };
}

/** The staking rules in force (the /staking snapshot's settings: the daily APR ceiling, the weekly payout cap, the cushion,
 *  the time-weighting) - the page words its staking section from them (staking fix plan 2026-10-19). null = not reported. */
async function stakingRules() {
  try {
    const snap = await require("./staking").latest();
    const s = (snap && snap.settings) || null;
    if (!s) return null;
    const n = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Number(x));
    // what stakers own of each vault right now (the limit sentence says so while Auto deposits skip the limit)
    const own = {};
    for (const v of ["bank", "house", "mm"]) {
      const nv = Number((snap.nav || {})[v]), sv = Number((snap.staked || {})[v]);
      if (nv > 0 && Number.isFinite(sv)) own[v] = sv / nv;
    }
    const wf = Array.isArray(snap.waterfall) ? snap.waterfall : [];
    const last = wf[wf.length - 1];
    return { ceil: n(s.ceil), bonus_cap: n(s.bonus_cap), cushion: !!s.cushion, cushion_days: n(s.cushion_days), weighted: !!s.weighted,
             staker_max: n(s.staker_max), auto_staker_cap: !!s.auto_staker_cap, own,
             staker_share: last && n(last.staker_share) != null ? n(last.staker_share) : null };
  } catch (e) { return null; }
}

module.exports = { locals, live, series, pools, roomSplit, launchpadOn, stakingRules, DAYS };
