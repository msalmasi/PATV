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
  ["conversation_members", "user_id", "unique"],   // 1.99cp: direct messages (messages.js)
  ["dm_prefs", "user_id", "unique"],
  ["dm_blocks", "blocker_id", "unique"],
  ["dm_blocks", "blocked_id", "unique"],
  ["dm_alerts", "user_id", "unique"],
  ["messages", "sender_id", "update"],
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

/** 1.99bs: one PATV account per Camfrog login. Racing find_or_create_user calls in Pepe used to make
 *  several "CF…" accounts for one login (27 copies merged 2026-10-06); a unique index on the normalised
 *  login makes a second one impossible. If duplicates exist the index can't be built - it says which
 *  logins, and the register route's own check-first still holds. Returns true when the index exists. */
async function ensureCamfrogUnique() {
  try {
    await runQuery(`CREATE UNIQUE INDEX IF NOT EXISTS users_camfrog_login ON users (lower(trim(camfrogUsername)))
                    WHERE camfrogUsername IS NOT NULL AND trim(camfrogUsername) != ''`);
    return true;
  } catch (e) {
    const d = await getQuery(`SELECT lower(trim(camfrogUsername)) AS l, COUNT(*) AS n FROM users
      WHERE camfrogUsername IS NOT NULL AND trim(camfrogUsername) != '' GROUP BY l HAVING n > 1 LIMIT 20`).catch(() => []);
    console.error(`[accounts] unique Camfrog login index not built (${e.message}); duplicate logins: ${d.map((x) => x.l + " x" + x.n).join(", ") || "?"}`);
    return false;
  }
}

/** The account already on this Camfrog login (normalised), or null. */
async function accountForLogin(login) {
  const l = String(login || "").trim().toLowerCase();
  if (!l) return null;
  return (await getQuery(`SELECT userId, username, displayname, camfrogUsername, points_balance FROM users
                          WHERE lower(trim(camfrogUsername)) = ? LIMIT 1`, [l]))[0] || null;
}

module.exports = { moveUserRows, copyCamfrogBadges, ensureCamfrogUnique, accountForLogin, OWNED };
