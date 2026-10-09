// ledger.js — 1.99ga: the one way to move PAT into or out of a user's balance.
//
// Why: 2,604 transaction rows (59 userIds) were found pointing at accounts that no longer exist. The
// newest (2026-10-08) was an achievement payout that raced a Camfrog !verify merge: award() looked the
// account up, the merge moved its balance and history and deleted it, and then fundPayout ran
// "UPDATE users ... WHERE userId = ?" (0 rows - nobody credited) followed by an unconditional
// "INSERT INTO transactions" (a row for a deleted account). The older ones are history that was never
// moved when accounts were deleted or merged by hand.
//
// post() makes the pair safe:
//   1. the transaction row is inserted ONLY IF the users row exists (INSERT ... SELECT ... FROM users),
//      and for a debit with requireCover only if the balance covers it;
//   2. then the balance moves; if that UPDATE did not change exactly one row (the account vanished in
//      between, or a concurrent spend took the cover), our own row is deleted again by its id - a
//      compensating delete that can't touch anybody else's statements on the shared connection (a
//      ROLLBACK TO a savepoint could).
//   Both statements join the caller's transaction when there is one (BEGIN ... COMMIT around it).
//   Nothing is written when the account is missing: post() returns {ok:false, code:"E_TARGET_NOT_FOUND"}
//   and logs it. With {resolveMerged:true} a merged-away id is first followed to the account it was
//   merged into (account_merges, written by every merge - recordMerge()).
//
// The database backs this up for every other writer: the trigger transactions_user_must_exist refuses
// any INSERT INTO transactions whose userId has no users row (RAISE ABORT "E_TARGET_NOT_FOUND ...").
"use strict";
const { v4: uuidv4 } = require("uuid");
const { runQuery, getQuery } = require("./dbUtils");

const E_TARGET_NOT_FOUND = "E_TARGET_NOT_FOUND";
const E_INSUFFICIENT = "E_INSUFFICIENT";
const E_BAD_AMOUNT = "E_BAD_AMOUNT";

let readyP = null;
let cols = null;               // optional transactions columns this database has: {counterparty, note}
function ensure() {
  if (readyP) return readyP;
  readyP = (async () => {
    const t = await getQuery("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'transactions')");
    if (t.length < 2) { readyP = null; return false; }     // tables not made yet (tests / first boot): try again later
    const c = (await getQuery("SELECT name FROM pragma_table_info('transactions')")).map((r) => r.name);
    cols = { counterparty: c.includes("counterparty"), note: c.includes("note") };
    await runQuery(`CREATE TABLE IF NOT EXISTS account_merges (
      old_id TEXT PRIMARY KEY, new_id TEXT NOT NULL, merged_at INTEGER NOT NULL, via TEXT)`);
    await runQuery("CREATE INDEX IF NOT EXISTS account_merges_new ON account_merges (new_id)");
    await runQuery(`CREATE TRIGGER IF NOT EXISTS transactions_user_must_exist
      BEFORE INSERT ON transactions
      WHEN NOT EXISTS (SELECT 1 FROM users WHERE userId = NEW.userId)
      BEGIN SELECT RAISE(ABORT, 'E_TARGET_NOT_FOUND: transactions.userId has no users row'); END`);
    return true;
  })().catch((e) => { readyP = null; console.error("[ledger] setup:", e.message); return false; });
  return readyP;
}

/** Record that `oldId` was merged into `newId` (call it in the merge, before the old row is deleted). */
async function recordMerge(oldId, newId, via) {
  if (!oldId || !newId || oldId === newId) return false;
  await ensure();
  await runQuery(`INSERT INTO account_merges (old_id, new_id, merged_at, via) VALUES (?, ?, ?, ?)
                  ON CONFLICT(old_id) DO UPDATE SET new_id = excluded.new_id, merged_at = excluded.merged_at, via = excluded.via`,
                 [oldId, newId, Date.now(), via ? String(via).slice(0, 60) : null]);
  // anything that had been merged into oldId now lives on newId
  await runQuery("UPDATE account_merges SET new_id = ? WHERE new_id = ?", [newId, oldId]);
  return true;
}

/** The live account an id stands for: itself if it exists, else the account it was merged into. */
async function resolveUserId(id) {
  if (!id) return null;
  await ensure();
  let cur = String(id);
  for (let hop = 0; hop < 6; hop++) {
    if ((await getQuery("SELECT 1 FROM users WHERE userId = ?", [cur])).length) return cur;
    const m = await getQuery("SELECT new_id FROM account_merges WHERE old_id = ?", [cur]).catch(() => []);
    if (!m.length || !m[0].new_id || m[0].new_id === cur) return null;
    cur = m[0].new_id;
  }
  return null;
}

const userExists = async (id) => !!id && (await getQuery("SELECT 1 FROM users WHERE userId = ?", [id])).length > 0;

/**
 * Credit (points > 0) or debit (points < 0) `userId` and log it, or write nothing.
 * opts: counterparty, note, transactionId, requireCover (a debit only if the balance covers it),
 *       resolveMerged (follow account_merges when userId is gone), source (for the log line).
 * Returns {ok:true, userId, transactionId} or {ok:false, code, userId}.
 */
async function post(userId, points, type, opts = {}) {
  const amount = Math.trunc(Number(points));
  if (!Number.isFinite(amount)) return { ok: false, code: E_BAD_AMOUNT, userId };
  await ensure();
  let target = userId ? String(userId) : null;
  if (opts.resolveMerged && target && !(await userExists(target))) {
    const to = await resolveUserId(target);
    if (to && to !== target) {
      console.log(`[ledger] ${type} ${amount} for merged account ${target} -> ${to}`);
      target = to;
    }
  }
  const txId = opts.transactionId || uuidv4();
  const cover = opts.requireCover && amount < 0;
  // a column added after the first look (tipNoteReady adds note / counterparty) - look again
  if ((opts.note !== undefined && !(cols && cols.note)) || (opts.counterparty !== undefined && !(cols && cols.counterparty))) {
    const c2 = (await getQuery("SELECT name FROM pragma_table_info('transactions')")).map((r) => r.name);
    cols = { counterparty: c2.includes("counterparty"), note: c2.includes("note") };
  }
  const c = cols || { counterparty: false, note: false };
  const names = ["transactionId", "userId", "type", "points"];
  const vals = [txId, type, amount];
  if (c.counterparty && opts.counterparty !== undefined) { names.push("counterparty"); vals.push(opts.counterparty || null); }
  if (c.note && opts.note !== undefined) { names.push("note"); vals.push(opts.note == null ? null : String(opts.note)); }
  const sel = ["?", "userId", ...names.slice(2).map(() => "?")];
  // the row goes in only if the account is there (and, for a covered debit, can pay)
  const ins = await runQuery(
    `INSERT INTO transactions (${names.join(", ")}) SELECT ${sel.join(", ")} FROM users WHERE userId = ?${cover ? " AND points_balance >= ?" : ""}`,
    [...vals, target, ...(cover ? [-amount] : [])]);
  if (!ins || ins.changes !== 1) {
    const exists = target && (await userExists(target));
    const code = exists && cover ? E_INSUFFICIENT : E_TARGET_NOT_FOUND;
    if (code === E_TARGET_NOT_FOUND) {
      console.warn(`[ledger] refused ${type} ${amount} for missing account ${target}${opts.source ? ` (${opts.source})` : ""}`);
    }
    return { ok: false, code, userId: target };
  }
  const upd = await runQuery(
    `UPDATE users SET points_balance = points_balance + ? WHERE userId = ?${cover ? " AND points_balance >= ?" : ""}`,
    [amount, target, ...(cover ? [-amount] : [])]);
  if (!upd || upd.changes !== 1) {
    await runQuery("DELETE FROM transactions WHERE transactionId = ?", [txId]);
    const exists = await userExists(target);
    const code = exists && cover ? E_INSUFFICIENT : E_TARGET_NOT_FOUND;
    console.warn(`[ledger] ${type} ${amount} for ${target}: balance not moved (${code}) - row withdrawn`);
    return { ok: false, code, userId: target };
  }
  return { ok: true, userId: target, transactionId: txId };
}

/** Undo a successful post() of `points` (its row goes, the balance moves back). */
async function reverse(res, points) {
  if (!res || !res.ok) return false;
  await runQuery("DELETE FROM transactions WHERE transactionId = ?", [res.transactionId]);
  await runQuery("UPDATE users SET points_balance = points_balance - ? WHERE userId = ?", [Math.trunc(Number(points)), res.userId]);
  return true;
}

/** post() that throws (for code inside its own BEGIN/COMMIT whose catch rolls back). */
async function postOrThrow(userId, points, type, opts = {}) {
  const r = await post(userId, points, type, opts);
  if (!r.ok) { const e = new Error(`${r.code}: ${type} ${points} for ${userId}`); e.code = r.code; throw e; }
  return r;
}

module.exports = { post, postOrThrow, reverse, recordMerge, resolveUserId, ensure, userExists,
                   E_TARGET_NOT_FOUND, E_INSUFFICIENT, E_BAD_AMOUNT };
