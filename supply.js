// supply.js — the total PAT supply (moved out of index.js for Phase 5, 5.16, so tools and tests can compute it too).
//
// Every PAT is in a wallet or a pool. Wallets, the casino jackpot (the House) and every pool the site now OWNS are counted
// from the site's own tables; Pepe's snapshot (POST /api/stats/supply -> supply_snapshot) carries only the rows he still
// really holds (turf stakes / tills / season pot / cargo, the room-wars bonds, journaled payouts on their way, the markets
// until Phase 3, and the pools / stashes / gangs / escrow while they are still local on his side).
//
// Site-owned rows (each replaces Pepe's row of the same key, which a stale snapshot can still carry for up to 5 minutes):
//   vault:lotto       the lotto service's pot (lotto/service.js)          stashes        stashes.js
//   vault:<pool>      pools.js (Phase 1) + room:<id> pad vaults            gangs          gangs.js treasuries (G1)
//   escrow:holds      escrow/ledger.js (Phase 2)                           route_intents  patroutes.js (charged, not routed yet)
//   room_vault_escrow boosts.js (held for the pads)                        casino:tables  PAT at the casino backend's tables:
//                                                                                          blackjack stakes in a round, hold'em stacks
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const supplyReady = runQuery(`CREATE TABLE IF NOT EXISTS supply_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1), pools TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`).catch(() => {});

/** Pepe's snapshot rows, cleaned (POST /api/stats/supply). */
function cleanRows(pools) {
  // economy v2 E-3: Pepe lists up to 40 room vaults (room:<room id>) on top of his ~20 pools -> room for 150 rows, longer keys
  return (Array.isArray(pools) ? pools : []).slice(0, 150).map((p) => ({ key: String(p.key || "").slice(0, 80), label: String(p.label || "").slice(0, 80),
                                                                         amount: Math.max(0, Math.floor(Number(p.amount) || 0)) }));
}
async function putSnapshot(pools) {
  await supplyReady;
  await runQuery("INSERT INTO supply_snapshot (id, pools, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP) " +
                 "ON CONFLICT(id) DO UPDATE SET pools = excluded.pools, updated_at = CURRENT_TIMESTAMP", [JSON.stringify(cleanRows(pools))]);
}

/** PAT sitting at the casino backend's tables (out of the wallets, not in the House yet). */
async function casinoHeld() {
  let n = 0;
  const rows = await getQuery("SELECT game, state FROM casino_tables WHERE status != 'closed'").catch(() => []);
  for (const r of rows) {
    let T = null;
    try { T = JSON.parse(r.state); } catch (e) { T = null; }
    if (!T) continue;
    if (r.game === "holdem") {
      const e = T.eng || {};
      for (const v of Object.values(e.chips || {})) n += Math.max(0, Math.floor(Number(v) || 0));
      for (const v of Object.values(e.contrib || {})) n += Math.max(0, Math.floor(Number(v) || 0));
    } else {
      for (const v of Object.values(T.escrowed || {})) n += Math.max(0, Math.floor(Number(v) || 0));
    }
  }
  return n;
}

async function patSupply() {
  await supplyReady;
  const stale = require("./staleaccounts");
  // every wallet counts toward supply (an archived one keeps only sub-1 PAT dust); the label counts live accounts
  const w = await getQuery(`SELECT COALESCE(SUM(points_balance), 0) AS w, SUM(CASE WHEN ${stale.LIVE()} THEN 1 ELSE 0 END) AS n FROM users`);
  const j = await getQuery("SELECT COALESCE(SUM(amount), 0) AS j FROM jackpot_rakes");
  const snap = await getQuery("SELECT pools, updated_at FROM supply_snapshot WHERE id = 1");
  let pools = [];
  try { pools = snap.length ? JSON.parse(snap[0].pools) : []; } catch (e) { pools = []; }
  // 1.99dk: burned PAT is gone - it's never a pool, whatever a snapshot says
  pools = pools.filter((p) => !/^burned/i.test(String(p.key || "")));
  // 1.99ml: once the lotto backend holds the jackpot pot (lotto_pot), it is counted here and Pepe's old "vault:lotto"
  // row (his local pot - 0 after the cutover, but a snapshot can be up to 5 minutes old) is not
  try {
    const LS = require("./lotto/service");
    if (await LS.potHasRows()) {
      pools = pools.filter((p) => String(p.key || "") !== "vault:lotto");
      pools.push({ key: "vault:lotto", label: "🎟️ Lotto jackpot pot", amount: Math.max(0, Math.floor(await LS.potBalance())) });
    }
  } catch (e) { /* no lotto tables yet */ }
  // 1.99ne: once the stashes live on the site (stashes.js) they are counted here, not from Pepe's (up to 5 min old) row
  try {
    const SS = require("./stashes");
    if (await SS.live()) {
      pools = pools.filter((p) => String(p.key || "") !== "stashes");
      const t = await SS.total();
      if (t.amount) pools.push({ key: "stashes", label: "🔐 Personal vaults", amount: Math.max(0, Math.floor(t.amount)) });
    }
  } catch (e) { /* no stash tables yet */ }
  // 1.99ns Phase 1: once the pools live on the site (pools.js) they are counted from its table, not Pepe's (up to 5 min old)
  // vault:<pool> / room:<id> rows; plus a routed charge's turf legs Pepe hasn't applied yet (turf_inbox)
  try { pools = await require("./pools").supplyRows(pools); } catch (e) { /* no pools tables yet */ }
  // G1: once the gangs live on the site their treasuries are counted from the table, not Pepe's "gangs" row
  try { pools = await require("./gangs").supplyRows(pools); } catch (e) { /* no gang tables yet */ }
  // 1.99ou Phase 2: once the escrow lives on the site its held stakes are counted from escrow_holds, not Pepe's "escrow:holds" row
  try { pools = await require("./escrow/ledger").supplyRows(pools); } catch (e) { /* no escrow tables yet */ }
  // 1.99ne: paid-command PAT already taken from wallets that Pepe hasn't routed into his pools yet (patroutes.js)
  try {
    const u = await require("./patroutes").unrouted();
    if (u.amount > 0) pools.push({ key: "route_intents", label: "⏳ Charged, waiting for Pepe to route it", amount: Math.floor(u.amount) });
  } catch (e) { /* no table yet */ }
  // Phase 5 (5.16): the casino backend's tables hold PAT between a stake / buy-in and the settle / cash-out (site-owned)
  try {
    const c = await casinoHeld();
    pools = pools.filter((p) => String(p.key || "") !== "casino:tables");
    if (c > 0) pools.push({ key: "casino:tables", label: "🃏 At the casino tables (stakes and stacks in play)", amount: c });
  } catch (e) { /* no casino tables yet */ }
  const rows = [{ key: "wallets", label: `👛 Player wallets (${Number(w[0].n).toLocaleString()} accounts)`, amount: Math.floor(Number(w[0].w) || 0) },
                { key: "jackpot", label: "🎰 Casino jackpot", amount: Math.floor(Number(j[0].j) || 0) }, ...pools];
  // 1.99ee: the room-vault half of boosts and stage slot fees, held on the site for each pad until room vaults open (boosts.js)
  try {
    const rv = (await require("./boosts").escrow()).room_vault;
    if (rv > 0) rows.push({ key: "room_vault_escrow", label: "🚀 Pad vault escrow (boosts + slot fees, held for the pads)", amount: Math.floor(rv) });
  } catch (e) { /* no boosts table yet */ }
  rows.sort((a, b) => b.amount - a.amount);
  // economy v2 E-1: each row's layer (Federal Reserve / Protocol Treasury / incentive layer / ...) - labels only
  const SL = require("./supplylayers");
  for (const r of rows) r.layer = SL.layerOf(r.key);
  const layers = SL.group(rows).map((g) => ({ key: g.key, label: g.label, blurb: g.blurb, amount: g.amount, rows: g.rows.map((r) => r.key) }));
  const total = rows.reduce((s, r) => s + r.amount, 0);
  // the burn reserve still exists until it's burned, but it's out of circulation
  const outOfCirculation = rows.filter((r) => r.key === "vault:burn").reduce((s, r) => s + r.amount, 0);
  let burned = null;
  try { burned = await require("./burns").burned(); } catch (e) { burned = null; }
  return { total, circulating: total - outOfCirculation, outOfCirculation, burned, rows, layers, updated: snap.length ? snap[0].updated_at : null };
}

module.exports = { patSupply, putSnapshot, cleanRows, casinoHeld, supplyReady };
