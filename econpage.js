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
  return { user: req.user ? req.user.username : null, treasury: F.treasuryOn() ? F.state.incentives : null, roomVaults, live: L };
}

module.exports = { locals, live, series, pools, DAYS };
