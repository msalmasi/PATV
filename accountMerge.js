// accountMerge.js — move everything one PATV account owns to another.
//
// Used when a Camfrog name is linked (!verify): Pepe's auto-made "CF…" account for that name is
// merged into the user's real account and then deleted. Before this existed, only PAT, XP and the
// transaction history moved; badges, cosmetics, roles, spins, orders… stayed behind under a deleted
// userId. The site then saw the achievements as missing and awarded them again with full XP + PAT.
//
// Each entry: [table, column, mode]
//   "update" — rows simply change owner.
//   "unique" — the table allows one row per user (or per user+key): rows the target already has win,
//              the rest move (UPDATE OR IGNORE), and the leftover duplicates of the old account go.
const { runQuery, getQuery } = require("./dbUtils");

const OWNED = [
  ["user_badges", "userId", "unique"],
  ["user_roles", "userId", "unique"],
  ["user_cosmetic_equips", "user_id", "unique"],
  ["user_badge_showcase", "user_id", "unique"],
  ["shop_prefs", "user_id", "unique"],
  ["profile_layout", "user_id", "unique"],
  ["inbox", "user_id", "unique"],          // unique (user_id, ref): a notice both accounts got stays once
  ["inbox_prefs", "user_id", "unique"],
  ["user_cosmetics", "user_id", "update"],
  ["achievement_feed", "userId", "update"],
  ["blackjack", "userId", "update"],
  ["user_redemptions", "userId", "update"],
  ["wheel_spins", "userId", "update"],
  ["jackpot_rakes", "userId", "update"],
  ["poker_cashier", "userId", "update"],
  ["poker_now_games", "userId", "update"],
  ["bonus_winners", "userId", "update"],
  ["reserve_claims", "userId", "update"],
  ["cosmetic_listings", "seller_id", "update"],
  ["cosmetic_listings", "buyer_id", "update"],
  ["shop_orders", "buyer_id", "update"],
  ["shop_orders", "seller_id", "update"],
  ["prizes", "seller_id", "update"],
  ["market_orders", "user_id", "update"],
  ["bounty_actions", "user_id", "update"],
  ["pepe_actions", "user_id", "update"],
];

async function tableHas(table, column) {
  const cols = await getQuery(`SELECT name FROM pragma_table_info(?)`, [table]).catch(() => []);
  return cols.some((c) => c.name === column);
}

/** Move every row `fromId` owns to `toId`. Returns {table.column: rowsMoved}. Safe to re-run. */
async function moveUserRows(fromId, toId) {
  const moved = {};
  if (!fromId || !toId || fromId === toId) return moved;
  for (const [table, col, mode] of OWNED) {
    if (!(await tableHas(table, col))) continue;          // not every deployment has every table
    try {
      const r = await runQuery(`UPDATE ${mode === "unique" ? "OR IGNORE " : ""}${table} SET ${col} = ? WHERE ${col} = ?`,
                               [toId, fromId]);
      if (mode === "unique") await runQuery(`DELETE FROM ${table} WHERE ${col} = ?`, [fromId]);
      if (r && r.changes) moved[`${table}.${col}`] = r.changes;
    } catch (e) {
      console.error(`[MERGE] moving ${table}.${col} ${fromId} -> ${toId}:`, e.message);
    }
  }
  return moved;
}

/** A Camfrog name moving from one real account to another takes its Camfrog achievements (cf_*)
 *  along — copied, quietly (no XP/PAT), so they aren't earned a second time. */
async function copyCamfrogBadges(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return 0;
  const r = await runQuery(
    `INSERT OR IGNORE INTO user_badges (userId, badgeId, awardedAt)
     SELECT ?, badgeId, awardedAt FROM user_badges WHERE userId = ? AND badgeId LIKE 'cf_%'`, [toId, fromId]);
  return (r && r.changes) || 0;
}

module.exports = { moveUserRows, copyCamfrogBadges, OWNED };
