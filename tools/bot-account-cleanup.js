// tools/bot-account-cleanup.js — 1.99nk: clean up the PATV account of a Camfrog ROOM BOT (first: players_lounge1, the
// Players Lounge's bot, which Pepe now ignores - camfrog-bot CamfrogBot.IGNORED_BOTS). DRY RUN BY DEFAULT.
//
//   node tools/bot-account-cleanup.js --login=players_lounge1 [--dir=<folder with myapp.db>] [--apply] [--backup-dir=<dir>]
//
// With --apply (a VACUUM INTO backup is taken first, always), in ONE transaction:
//   1. queued incentive grants it is still owed (reserve_claims queued = 1: level-ups, achievements, welcome PAT) are
//      dropped (queued = 9, the funding queue's "dropped" state) - they were never credited, so nothing moves
//   2. its whole-PAT balance goes to the Federal Reserve THROUGH THE LEDGER (not a burn): a ledger.post debit
//      "bot account cleanup" + a negative reserve_claims row (flow "bot_cleanup") that Pepe's funding tick credits to
//      the Fed (frida-bot _funding_tick: a plain negative claim -> the Reserve, why = "bot_cleanup")
//   3. achievements, cosmetics and XP are removed: user_badges, user_badge_showcase, achievement_feed, user_cosmetics,
//      user_cosmetic_equips; users.xp = 0, level = 0
//   4. analytics / leaderboard presence: camfrog_userstats and econ_participation rows for the login
//   5. marked as a bot: archived (users.archived_at - hidden from search, mentions, flair...) with an account_archive
//      row of tier "BOT" (reclaimed 0: the balance went to the Fed in step 2, so nothing can be "restored" to it), and
//      staleaccounts.restore() refuses to un-archive a BOT row automatically (a lookup / sign-in won't revive it)
// Idempotent: every step works from the current state (a second run finds nothing to drop, a 0 balance, no rows,
// the archive row already there) and changes nothing. History stays: transactions, the inbox welcome note, the
// levelup_rewards / welcome_bonus records (they keep those rewards from being granted again).
"use strict";
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const appDir = path.resolve(__dirname, "..");
if (args.dir) process.chdir(path.resolve(String(args.dir)));          // dbUtils opens ./myapp.db
if (!fs.existsSync(path.join(process.cwd(), "myapp.db"))) { console.error(`no myapp.db in ${process.cwd()}`); process.exit(2); }
const { runQuery, getQuery } = require(path.join(appDir, "dbUtils"));
const ledger = require(path.join(appDir, "ledger"));

const LOGIN = String(args.login || "").trim().toLowerCase();
const apply = !!args.apply;
const REASON = `bot account cleanup: ${LOGIN} is a Camfrog room bot (Pepe ignores it)`;
if (!/^[\w.\-]{1,40}$/.test(LOGIN)) { console.error("--login=<camfrog login> required"); process.exit(2); }

const tableExists = async (t) => (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t])).length > 0;
const hasColumn = async (t, c) => (await getQuery(`SELECT name FROM pragma_table_info('${t}')`)).some((r) => r.name === c);

async function count(table, col, key) {
  if (!(await tableExists(table)) || !(await hasColumn(table, col))) return null;
  return (await getQuery(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${col}" = ?`, [key]))[0].n;
}

// rows removed in steps 3-4: [table, column, key kind]
const REMOVE = [["user_badges", "userId", "id"], ["user_badge_showcase", "user_id", "id"], ["achievement_feed", "userId", "id"],
  ["user_cosmetics", "user_id", "id"], ["user_cosmetic_equips", "user_id", "id"],
  ["camfrog_userstats", "login", "login"], ["econ_participation", "login", "login"]];

async function survey(u) {
  const s = { userId: u.userId, username: u.username, camfrog: u.camfrogUsername, balance: Number(u.points_balance) || 0,
              xp: u.xp, level: u.level, archived_at: u.archived_at == null ? null : u.archived_at, rows: {} };
  s.queued = (await getQuery("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS pat FROM reserve_claims WHERE userId = ? AND queued = 1", [u.userId]))[0];
  s.queued_list = await getQuery("SELECT flow, type, amount FROM reserve_claims WHERE userId = ? AND queued = 1 ORDER BY created", [u.userId]);
  for (const [t, c, k] of REMOVE) s.rows[t] = await count(t, c, k === "id" ? u.userId : LOGIN);
  s.archive = (await tableExists("account_archive")) ? (await getQuery("SELECT tier, reason, reclaimed FROM account_archive WHERE userId = ?", [u.userId]))[0] || null : null;
  s.cleanup_tx = (await getQuery("SELECT COUNT(*) AS n, COALESCE(SUM(points), 0) AS pts FROM transactions WHERE userId = ? AND type = 'bot account cleanup'", [u.userId]))[0];
  return s;
}

async function backup(dir) {
  const d = path.resolve(String(dir || "db-backups"));
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, `myapp-pre-botclean-${LOGIN}-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  await runQuery(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  if (fs.statSync(file).size < 4096) throw new Error("backup looks empty");
  return file;
}

async function cleanup(u) {
  const out = { dropped: 0, dropped_pat: 0, moved_to_fed: 0, removed: {}, archived: false };
  const now = Date.now();
  if (!(await require(path.join(appDir, "staleaccounts")).ensure())) throw new Error("couldn't set up account_archive");
  await ledger.ensure();
  await runQuery("BEGIN IMMEDIATE");
  try {
    // 1. queued grants -> dropped
    const q = (await getQuery("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS pat FROM reserve_claims WHERE userId = ? AND queued = 1", [u.userId]))[0];
    await runQuery("UPDATE reserve_claims SET queued = 9 WHERE userId = ? AND queued = 1", [u.userId]);
    out.dropped = q.n; out.dropped_pat = q.pat;
    // 2. balance -> the Fed, through the ledger
    const bal = Number((await getQuery("SELECT points_balance FROM users WHERE userId = ?", [u.userId]))[0].points_balance) || 0;
    const amt = Math.floor(bal);
    if (amt > 0) {
      const r = await ledger.post(u.userId, -amt, "bot account cleanup", { requireCover: true, source: "bot-account-cleanup" });
      if (!r.ok) throw new Error(`ledger refused the debit: ${r.code}`);
      await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES (?, ?, ?, ?, ?)",
                     ["botclean-" + uuidv4(), "bot_cleanup", u.userId, `bot account cleanup: ${LOGIN} -> Federal Reserve`.slice(0, 120), -amt]);
      out.moved_to_fed = amt;
    }
    // 3-4. achievements, cosmetics, analytics; XP
    for (const [t, c, k] of REMOVE) {
      if (!(await tableExists(t)) || !(await hasColumn(t, c))) continue;
      const r = await runQuery(`DELETE FROM "${t}" WHERE "${c}" = ?`, [k === "id" ? u.userId : LOGIN]);
      out.removed[t] = r.changes || 0;
    }
    const xr = await runQuery("UPDATE users SET xp = 0, level = 0 WHERE userId = ? AND (COALESCE(xp, 0) != 0 OR COALESCE(level, 0) != 0)", [u.userId]);
    out.xp_reset = !!xr.changes;
    // 5. marked as a bot (archived, tier BOT; the table / column come from staleaccounts.ensure() before BEGIN)
    const a =await runQuery("UPDATE users SET archived_at = ? WHERE userId = ? AND archived_at IS NULL", [now, u.userId]);
    const snap = JSON.stringify({ username: u.username, displayname: u.displayname, camfrog: u.camfrogUsername, xp: u.xp, level: u.level, created_at: u.created_at });
    const had = (await getQuery("SELECT tier FROM account_archive WHERE userId = ?", [u.userId]))[0];
    if (!had || had.tier !== "BOT") {
      await runQuery(`INSERT INTO account_archive (userId, run_id, tier, reason, archived_at, balance, reclaimed, purge_after, snapshot)
                      VALUES (?, ?, 'BOT', ?, ?, 0, 0, NULL, ?)
                      ON CONFLICT(userId) DO UPDATE SET run_id = excluded.run_id, tier = 'BOT', reason = excluded.reason,
                        archived_at = excluded.archived_at, reclaimed = 0, purge_after = NULL, restored_at = NULL, restored_via = NULL,
                        snapshot = excluded.snapshot`,
                     [u.userId, "botclean-" + LOGIN, REASON.slice(0, 300), now, snap]);
    }
    out.archived = !!a.changes || !had || had.tier !== "BOT";
    await runQuery("COMMIT");
  } catch (e) {
    await runQuery("ROLLBACK").catch(() => {});
    throw e;
  }
  return out;
}

(async () => {
  const users = await getQuery("SELECT * FROM users WHERE LOWER(camfrogUsername) = ?", [LOGIN]);
  if (users.length !== 1) {
    console.error(`expected exactly one account linked to ${LOGIN}, found ${users.length}: ${users.map((u) => u.username).join(", ")}`);
    process.exit(3);
  }
  const u = users[0];
  const before = await survey(u);
  console.log(JSON.stringify({ mode: apply ? "APPLY" : "DRY RUN", login: LOGIN, before }, null, 1));
  if (!apply) {
    console.log(`DRY RUN: would drop ${before.queued.n} queued grant(s) (${before.queued.pat} PAT never credited), move ` +
                `${Math.floor(Math.max(0, before.balance))} PAT to the Federal Reserve, reset XP ${before.xp} -> 0, remove ` +
                Object.entries(before.rows).filter(([, n]) => n).map(([t, n]) => `${n} ${t}`).join(", ") +
                `, and mark it a bot (archive tier BOT). Re-run with --apply.`);
    process.exit(0);
  }
  const file = await backup(args["backup-dir"]);
  console.log("backup:", file);
  const did = await cleanup(u);
  const after = await survey((await getQuery("SELECT * FROM users WHERE userId = ?", [u.userId]))[0]);
  console.log(JSON.stringify({ did, after }, null, 1));
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
