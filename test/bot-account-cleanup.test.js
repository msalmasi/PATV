// 1.99nk: tools/bot-account-cleanup.js on a scratch database - dry run writes nothing; --apply drops the queued grants,
// moves the balance to the Fed through the ledger (debit + a negative "bot_cleanup" claim), removes badges / cosmetics /
// analytics rows, zeroes XP, archives the account as tier BOT; a second run changes nothing; restore() won't revive it.
//   node --test test/bot-account-cleanup.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "botclean-test-"));
process.chdir(tmp);
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const ID = "u-bot-1";
const run = (...a) => execFileSync(process.execPath, [path.join(repo, "tools", "bot-account-cleanup.js"), "--login=Players_Lounge1", `--dir=${tmp}`, ...a],
                                   { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery(`CREATE TABLE IF NOT EXISTS reserve_claims (claimId TEXT PRIMARY KEY, flow TEXT NOT NULL, userId TEXT, type TEXT, amount INTEGER NOT NULL,
                  created DATETIME DEFAULT CURRENT_TIMESTAMP, settled INTEGER DEFAULT 0, queued INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE IF NOT EXISTS user_badges (userId TEXT, badgeId TEXT)");
  await runQuery("CREATE TABLE IF NOT EXISTS user_cosmetics (id INTEGER PRIMARY KEY, user_id TEXT, item_id TEXT)");
  await runQuery("CREATE TABLE IF NOT EXISTS camfrog_userstats (login TEXT PRIMARY KEY, data TEXT)");
  await runQuery("CREATE TABLE IF NOT EXISTS econ_participation (room_id TEXT, day TEXT, login TEXT, lines INTEGER)");
  await runQuery("INSERT INTO users (userId, username, password, camfrogUsername, points_balance, xp, level) VALUES (?, 'CFbot', 'x', 'players_lounge1', 87, 2212, 2)", [ID]);
  await runQuery("INSERT INTO users (userId, username, password, camfrogUsername, points_balance, xp, level) VALUES ('u-real', 'alice', 'x', 'alicecf', 500, 10, 1)");
  await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES ('t1', ?, 'bonus win', 87)", [ID]);
  for (const [i, fl, amt] of [[1, "incentives:levelup", 25000], [2, "incentives:achievements", 10000], [3, "incentives:new_account", 10000]]) {
    await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount, queued) VALUES (?, ?, ?, 'grant', ?, 1)", ["q" + i, fl, ID, amt]);
  }
  await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount, queued) VALUES ('q-other', 'incentives:levelup', 'u-real', 'grant', 25000, 1)");
  await runQuery("INSERT INTO user_badges VALUES (?, 'cf_chat_100'), (?, 'cf_chat_1k'), ('u-real', 'cf_chat_100')", [ID, ID]);
  await runQuery("INSERT INTO user_cosmetics (user_id, item_id) VALUES (?, 'nc_loudmouth')", [ID]);
  await runQuery("INSERT INTO camfrog_userstats VALUES ('players_lounge1', '{}'), ('alicecf', '{}')");
  await runQuery("INSERT INTO econ_participation VALUES ('R', '2026-10-10', 'players_lounge1', 5), ('R', '2026-10-10', 'alicecf', 3)");
});

test("dry run writes nothing", async () => {
  const out = run();
  assert.match(out, /DRY RUN: would drop 3 queued grant\(s\) \(45000 PAT never credited\), move 87 PAT to the Federal Reserve/);
  const u = (await getQuery("SELECT points_balance, xp FROM users WHERE userId = ?", [ID]))[0];
  assert.deepEqual({ b: u.points_balance, xp: u.xp }, { b: 87, xp: 2212 });
  assert.equal((await getQuery("SELECT COUNT(*) n FROM reserve_claims WHERE queued = 1"))[0].n, 4);
});

test("--apply cleans exactly that account, once; the balance goes to the Fed through the ledger", async () => {
  run("--apply", `--backup-dir=${path.join(tmp, "bk")}`);
  assert.equal(fs.readdirSync(path.join(tmp, "bk")).length, 1, "a backup first");
  const u = (await getQuery("SELECT points_balance, xp, level, archived_at FROM users WHERE userId = ?", [ID]))[0];
  assert.deepEqual({ b: u.points_balance, xp: u.xp, lv: u.level, arch: u.archived_at != null }, { b: 0, xp: 0, lv: 0, arch: true });
  const tx = await getQuery("SELECT points FROM transactions WHERE userId = ? AND type = 'bot account cleanup'", [ID]);
  assert.deepEqual(tx.map((t) => t.points), [-87]);
  const fed = await getQuery("SELECT amount, settled, queued FROM reserve_claims WHERE userId = ? AND flow = 'bot_cleanup'", [ID]);
  assert.deepEqual(fed, [{ amount: -87, settled: 0, queued: 0 }], "a negative claim Pepe credits to the Fed");
  assert.equal((await getQuery("SELECT COUNT(*) n FROM reserve_claims WHERE userId = ? AND queued = 9", [ID]))[0].n, 3, "queued grants dropped");
  assert.equal((await getQuery("SELECT queued FROM reserve_claims WHERE claimId = 'q-other'"))[0].queued, 1, "someone else's grant untouched");
  for (const [t, c, k] of [["user_badges", "userId", ID], ["user_cosmetics", "user_id", ID], ["camfrog_userstats", "login", "players_lounge1"], ["econ_participation", "login", "players_lounge1"]]) {
    assert.equal((await getQuery(`SELECT COUNT(*) n FROM ${t} WHERE ${c} = ?`, [k]))[0].n, 0, t);
  }
  assert.equal((await getQuery("SELECT COUNT(*) n FROM user_badges WHERE userId = 'u-real'"))[0].n, 1);
  assert.equal((await getQuery("SELECT points_balance FROM users WHERE userId = 'u-real'"))[0].points_balance, 500);
  const a = (await getQuery("SELECT tier, reclaimed FROM account_archive WHERE userId = ?", [ID]))[0];
  assert.deepEqual(a, { tier: "BOT", reclaimed: 0 });
  // idempotent
  run("--apply", `--backup-dir=${path.join(tmp, "bk")}`);
  assert.equal((await getQuery("SELECT COUNT(*) n FROM transactions WHERE userId = ? AND type = 'bot account cleanup'", [ID]))[0].n, 1);
  assert.equal((await getQuery("SELECT COUNT(*) n FROM reserve_claims WHERE userId = ? AND flow = 'bot_cleanup'", [ID]))[0].n, 1);
});

test("a BOT archive isn't revived by a lookup / sign-in restore, only by an explicit unbot", async () => {
  const S = require(path.join(repo, "staleaccounts"));
  assert.equal(await S.restore(ID, "lookup"), null);
  assert.ok((await getQuery("SELECT archived_at FROM users WHERE userId = ?", [ID]))[0].archived_at != null);
  assert.deepEqual(await S.restore(ID, "unbot"), { restored: 0 });
});
