// supplylayers.js — the economy v2 layers on the supply page (/rankings#supply, /supply).
//
// camfrog-bot docs/ECONOMY-V2.md section 2 (phase E-1): every PAT pool belongs to one layer. The supply
// snapshot rows (wallets + the casino jackpot here, everything else posted by Pepe on /api/stats/supply)
// are grouped by their key; the total is unchanged - this only labels and orders the rows.
//
//   fed        🏛️ Federal Reserve (backstop)  vault:reserve - the only minter, untouchable
//   treasury   🏦 Protocol Treasury           the House (jackpot), the Bank and Market-maker vaults
//   incentive  🎁 Incentive layer             incentive budget, Fort Knox, the Casino vault, room vaults
//   pots       🎲 Pots, games and escrow      lotto pot, bingo, prediction markets, escrow, turf, gangs
//   players    👛 Players                     wallets, personal vaults (stashes)
//   burn       🔥 Out of circulation          the burn reserve (waiting to be burned)
"use strict";

const LAYERS = [
  { key: "players", label: "👛 Players", blurb: "wallets and personal vaults" },
  { key: "fed", label: "🏛️ Federal Reserve (backstop)", blurb: "untouchable: the only minter, by written policy; it pays no rewards and nobody robs it" },
  { key: "treasury", label: "🏦 Protocol Treasury", blurb: "the House, the Bank and the Market maker" },
  { key: "incentive", label: "🎁 Incentive layer", blurb: "the incentive budget and the vaults heists and rooms pay from (Fort Knox, the Casino vault, room vaults)" },
  { key: "pots", label: "🎲 Pots, games and escrow", blurb: "the lotto pot, bingo, prediction markets, escrow, turf and gang treasuries" },
  { key: "burn", label: "🔥 Out of circulation", blurb: "the burn reserve, waiting to be burned" },
];
const ORDER = LAYERS.map((l) => l.key);

/** Which layer a supply row belongs to, by its key. Unknown pools fall in "pots" (still counted). */
function layerOf(key) {
  const k = String(key || "");
  if (k === "wallets" || k === "stashes") return "players";
  if (k === "vault:reserve") return "fed";
  if (k === "jackpot" || k === "vault:bank" || k === "vault:mm" || k === "vault:vaultfloat") return "treasury";
  if (k === "vault:incentives" || k === "vault:fortknox" || k === "vault:heist" || k === "room_vault_escrow" || k.startsWith("room:")) return "incentive";
  if (k === "vault:burn") return "burn";
  return "pots";
}

/** rows [{key, label, amount}] -> [{key, label, blurb, amount, rows}] in layer order (empty layers dropped). */
function group(rows) {
  const by = new Map(LAYERS.map((l) => [l.key, { ...l, amount: 0, rows: [] }]));
  for (const r of rows || []) {
    const g = by.get(layerOf(r.key));
    g.amount += Math.max(0, Math.floor(Number(r.amount) || 0));
    g.rows.push(r);
  }
  for (const g of by.values()) g.rows.sort((a, b) => b.amount - a.amount);
  return ORDER.map((k) => by.get(k)).filter((g) => g.rows.length);
}

module.exports = { LAYERS, layerOf, group };
