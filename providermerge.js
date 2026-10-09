// providermerge.js - 1.99fy (security): merging the PATV account that already has a Twitch / Discord id
// into the signed-in account that is linking it (POST /merge-accounts-twitch|discord, index.js).
//
// Before: no transaction and a session flag as the only guard, so two parallel POSTs (MemoryStore
// sessions race) credited the old account's balance twice, and a crash partway through left the PAT
// on both accounts. Now:
//   * one merge per account at a time in this process (busy set), then ONE "BEGIN IMMEDIATE"
//     transaction on the shared connection (staleaccounts.tx - the same queue mergeDuplicate uses);
//   * inside it the old account is read again: gone, or no longer holding this Twitch / Discord id,
//     or archived -> nothing happens;
//   * its balance is zeroed with a guard (WHERE points_balance = <what we read>, exactly one row)
//     before the new account is credited - a second merge can never move it again;
//   * an archived old account is restored first (touch), so its archived PAT comes along;
//   * an old account with anything in flight (room ownership, stage slots, loans / escrow / stashes,
//     market / bounty / wager positions, open shop orders - staleaccounts.holdsFor) is refused:
//     staff merge those by hand;
//   * xp, level and liked move like mergeDuplicate / the Camfrog !verify merge; the history and every
//     owned row move (accountMerge.moveUserRows); an "account merge" ledger row on the new account and
//     an account_archive snapshot of the old row (tier "MERGE", no password / email / tokens) record it.
"use strict";
const { v4: uuidv4 } = require("uuid");
const { runQuery, getQuery } = require("./dbUtils");
const stale = require("./staleaccounts");
const { moveUserRows } = require("./accountMerge");

// holds that don't stop a merge: a pending welcome bonus (most bot-made accounts have one) and a
// pending Camfrog link code
const NON_BLOCKING = new Set(["pending welcome bonus", "pending Camfrog link"]);
// never copied into the archive snapshot
const SECRET = /password|email|token|reset|secret/i;

const busy = new Set();

async function hasColumn(t, c) {
  const cols = await getQuery("SELECT name FROM pragma_table_info(?)", [t]).catch(() => []);
  return cols.some((x) => x.name === c);
}
async function tableExists(t) {
  return (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t])).length > 0;
}

/**
 * Merge account `fromId` (holding the Twitch / Discord id `linkId`) into `toId`.
 * L: {label, idCol, nameCol, otherIdCol, otherNameCol} (index.js LINKS[provider]).
 * Returns {ok: true, amount, xp, from, moved, otherMoved, twitch} or {ok: false, code, holds?}
 *   code: "busy" | "gone" | "changed" | "holds" | "archived" | "negative"
 * Throws (after rolling back) if the database fails partway.
 */
async function mergeProviderAccount({ provider, L, fromId, toId, linkId, linkName }) {
  if (!fromId || !toId || fromId === toId || !linkId) return { ok: false, code: "gone" };
  if (busy.has(fromId) || busy.has(toId)) return { ok: false, code: "busy" };
  busy.add(fromId); busy.add(toId);
  try {
    // an archived account gets its PAT back first (restore() runs its own transaction)
    await stale.touch(fromId, `${provider} merge`);
    const holds = (await stale.holdsFor(fromId)).filter((h) => !NON_BLOCKING.has(h));
    if (holds.length) return { ok: false, code: "holds", holds };
    await stale.ensure();
    const hasLiked = await hasColumn("users", "liked");
    const hasCp = await hasColumn("transactions", "counterparty");
    const hasNote = await hasColumn("transactions", "note");

    return await stale.tx(async () => {
      const from = (await getQuery("SELECT * FROM users WHERE userId = ?", [fromId]))[0];
      const to = (await getQuery("SELECT * FROM users WHERE userId = ?", [toId]))[0];
      if (!from || !to) return { ok: false, code: "gone" };
      if (String(from[L.idCol] || "") !== String(linkId)) return { ok: false, code: "changed" };
      if (from.archived_at != null) return { ok: false, code: "archived" };
      const bal = Number(from.points_balance) || 0;
      if (bal < 0) return { ok: false, code: "negative" };

      // the balance moves exactly once: zero it only if it is still what we read
      const z = await runQuery("UPDATE users SET points_balance = 0 WHERE userId = ? AND points_balance = ?", [fromId, from.points_balance]);
      if (!z || z.changes !== 1) throw new Error("merge: the old account's balance changed underneath");

      // ids leave the old row before they land on the new one (unique Twitch / Discord / Camfrog indexes)
      const moveOther = !to[L.otherIdCol] && !!from[L.otherIdCol];
      const moveCf = !to.camfrogUsername && !!from.camfrogUsername;
      const clear = [`${L.idCol} = NULL`];
      if (from[L.otherIdCol]) clear.push(`${L.otherIdCol} = NULL`);
      if (from.camfrogUsername) clear.push("camfrogUsername = NULL");
      await runQuery(`UPDATE users SET ${clear.join(", ")} WHERE userId = ?`, [fromId]);
      if (moveOther) {
        await runQuery(`UPDATE users SET ${L.otherIdCol} = ?, ${L.otherNameCol} = ? WHERE userId = ?`,
                       [from[L.otherIdCol], from[L.otherNameCol] || null, toId]);
      }
      if (moveCf) await runQuery("UPDATE users SET camfrogUsername = ? WHERE userId = ?", [from.camfrogUsername, toId]);

      const xp = Number(from.xp) || 0, liked = Number(from.liked) || 0;
      const c = await runQuery(`UPDATE users SET points_balance = points_balance + ?, xp = COALESCE(xp, 0) + ?,
                                  level = MAX(COALESCE(level, 0), ?)${hasLiked ? ", liked = COALESCE(liked, 0) + ?" : ""},
                                  ${L.idCol} = ?, ${L.nameCol} = ? WHERE userId = ?`,
                               [bal, xp, Number(from.level) || 0].concat(hasLiked ? [liked] : [], [String(linkId), linkName || null, toId]));
      if (!c || c.changes !== 1) throw new Error("merge: the new account is gone");

      // the history comes along with the balance (so /history still adds up), and everything it owned
      await runQuery("UPDATE transactions SET userId = ? WHERE userId = ?", [toId, fromId]);
      if (hasCp) await runQuery("UPDATE transactions SET counterparty = ? WHERE counterparty = ?", [toId, fromId]);
      // the old account's archive warning doesn't follow it (alt_merge.js does the same)
      if (await tableExists("stale_notice")) await runQuery("DELETE FROM stale_notice WHERE userId = ?", [fromId]);
      if (await hasColumn("inbox", "ref")) await runQuery("DELETE FROM inbox WHERE user_id = ? AND ref LIKE 'stale-notice:%'", [fromId]);
      const moved = await moveUserRows(fromId, toId);
      for (const t of ["levelup_rewards", "levelup_milestones"]) {
        if (!(await hasColumn(t, "userId"))) continue;
        await runQuery(`UPDATE OR IGNORE ${t} SET userId = ? WHERE userId = ?`, [toId, fromId]);
        await runQuery(`DELETE FROM ${t} WHERE userId = ?`, [fromId]);
      }

      const note = `${L.label} merge: ${from.username} merged in (${bal} PAT, ${xp} XP)`;
      if (hasNote) {
        await runQuery("INSERT INTO transactions (transactionId, userId, type, points, note) VALUES (?, ?, 'account merge', 0, ?)", [uuidv4(), toId, note]);
      } else {
        await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, 'account merge', 0)", [uuidv4(), toId]);
      }
      const snap = {};
      for (const [k, v] of Object.entries(from)) if (!SECRET.test(k)) snap[k] = v;
      snap.merged_into = toId;
      const now = Date.now();
      await runQuery(`INSERT INTO account_archive (userId, run_id, tier, reason, archived_at, balance, reclaimed, purged_at, snapshot)
                      VALUES (?, ?, 'MERGE', ?, ?, ?, 0, ?, ?)
                      ON CONFLICT(userId) DO UPDATE SET run_id = excluded.run_id, tier = excluded.tier, reason = excluded.reason,
                        archived_at = excluded.archived_at, balance = excluded.balance, reclaimed = 0, purged_at = excluded.purged_at,
                        snapshot = excluded.snapshot`,
                     [fromId, `merge-${provider}-${uuidv4().slice(0, 8)}`, `merged into ${to.username} (${L.label} link)`.slice(0, 300),
                      now, bal, now, JSON.stringify(snap)]);
      await require("./ledger").recordMerge(fromId, toId, `${provider} merge`);   // 1.99ga: late credits follow it to toId
      const d = await runQuery("DELETE FROM users WHERE userId = ?", [fromId]);
      if (!d || d.changes !== 1) throw new Error("merge: the old account could not be removed");
      console.log(`[auth] ${provider} merge ${fromId} -> ${toId}: +${bal} PAT, +${xp} XP, ${JSON.stringify(moved)}`);
      return { ok: true, amount: bal, xp, from: from.username, moved, otherMoved: moveOther,
               twitch: from.twitchId && from.twitchLogin ? { id: from.twitchId, login: from.twitchLogin } : null };
    });
  } finally {
    busy.delete(fromId); busy.delete(toId);
  }
}

/** Twitch / Discord sign-in by email (no account has that id yet): only into an account whose email
 *  is VERIFIED and which has no other id for that provider. */
function emailLinkable(row, idCol, providerId) {
  if (!row || Number(row.isEmailVerified) !== 1) return false;
  return !row[idCol] || String(row[idCol]) === String(providerId);
}

module.exports = { mergeProviderAccount, emailLinkable, NON_BLOCKING };
