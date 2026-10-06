// Stale / junk accounts (1.99bm, staleaccounts.js): tiers, read-only dry runs, archive -> Reserve
// reclaim (negative reserve_claims), restore on touch, idempotency, purge grace + holds, leaderboard
// filter, duplicate merge.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-"));
process.chdir(dir);                                      // dbUtils opens ./myapp.db
const repo = path.join(__dirname, "..");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const stale = require(path.join(repo, "staleaccounts"));

const DAY = 86400000;
const NOW = Date.parse("2026-10-06T12:00:00Z");
const ts = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString().replace("T", " ").slice(0, 19);

const setup = (async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT, class TEXT DEFAULT 'pleb', email TEXT,
    isEmailVerified INTEGER DEFAULT 0, discordId TEXT, twitchId TEXT, camfrogUsername TEXT, points_balance INTEGER DEFAULT 0,
    xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, displayname TEXT, created_at TIMESTAMP)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT, note TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS bonus_winners (bonusId TEXT, type TEXT, userId TEXT, transactionId TEXT, amount INTEGER, timestamp DATETIME)");
  await runQuery("CREATE TABLE IF NOT EXISTS reserve_claims (claimId TEXT PRIMARY KEY, flow TEXT, userId TEXT, type TEXT, amount INTEGER, created DATETIME DEFAULT CURRENT_TIMESTAMP, settled INTEGER DEFAULT 0)");
  await runQuery("CREATE TABLE IF NOT EXISTS user_badges (userId TEXT, badgeId TEXT, PRIMARY KEY (userId, badgeId))");
  await runQuery("CREATE TABLE IF NOT EXISTS user_roles (userId TEXT, role TEXT)");
  await runQuery("CREATE TABLE IF NOT EXISTS wallet_snapshots (key TEXT PRIMARY KEY, data TEXT, updated INTEGER)");
  await runQuery("CREATE TABLE IF NOT EXISTS camfrog_userstats (login TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER)");
})();

let seq = 0;
async function user(id, o = {}) {
  await runQuery(`INSERT INTO users (userId, username, class, email, isEmailVerified, discordId, twitchId, camfrogUsername, points_balance, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, o.username || id, o.cls || "pleb", o.email === undefined ? "abcdefghij1234" : o.email,
    o.verified ? 1 : 0, o.discord || null, o.twitch || null, o.cf || null, o.bal || 0, ts(o.created == null ? 300 : o.created)]);
}
async function txn(id, type, points, daysAgo, cp) {
  await runQuery("INSERT INTO transactions (transactionId, userId, type, points, timestamp, counterparty) VALUES (?, ?, ?, ?, ?, ?)",
                 ["t" + ++seq, id, type, points, ts(daysAgo), cp || null]);
}
const tierOf = async (opts = {}) => {
  const p = await stale.plan(Object.assign({ now: NOW, supply: { total: 1, wallets: 1 } }, opts));
  return Object.fromEntries(p.rows.map((r) => [r.f.userId, r.tier]));
};

test("tiers: A / B / C / G / M / A2 / D / X / active, and a dry run writes nothing", async () => {
  await setup;
  await user("a1", { username: "CFaaaaaaa1", cf: "ghostly", bal: 120000, created: 200 });     // passive mints only
  await txn("a1", "Level-up reward (Lv 1)", 50000, 199);
  await txn("a1", "bonus win", 70000, 150);
  await user("b1", { username: "CFbbbbbbb1", cf: "spinner", bal: 30000, created: 300 });       // one spin, long ago
  await txn("b1", "Wager: Public Spin", -5000, 250);
  await user("c1", { username: "webjunk", email: "nobody", bal: 50000, created: 400 });        // junk email, no link
  await user("g1", { username: "CFggggggg1", cf: null, bal: 10000, created: 20 });             // no login at all
  await user("m0", { username: "realtricon", cf: "tricon", bal: 5, created: 100, verified: 1, email: "x@gmail.com" });
  await user("m1", { username: "CFmmmmmmm1", cf: "tricon", bal: 60000, created: 2 });           // duplicate of m0
  await user("t1", { username: "twitchguy", twitch: "123", email: "twitchguy", bal: 9000, created: 500 });
  await user("d1", { username: "CFddddddd1", cf: "tipper", bal: 777, created: 400 });           // tipped someone
  await txn("d1", "tip sent", -1000, 300, "a1");
  await user("x1", { username: "CFxxxxxxx1", cf: "borrower", bal: 5000, created: 400 });        // open loan
  await runQuery("INSERT INTO wallet_snapshots (key, data) VALUES ('loans', ?)", [JSON.stringify({ loans: [{ lender: "foamy", borrower: "borrower", status: "active" }] })]);
  await user("adm", { username: "boss", cls: "Admin", bal: 1, created: 900 });
  await user("act", { username: "CFactive01", cf: "chatty", bal: 1000, created: 200 });
  await runQuery("INSERT INTO camfrog_userstats (login, data) VALUES ('chatty', ?)", [JSON.stringify({ last: (NOW - 3 * DAY) / 1000 })]);

  const t = await tierOf();
  assert.deepStrictEqual([t.a1, t.b1, t.c1, t.g1, t.m1, t.m0, t.t1, t.d1, t.x1, t.adm, t.act],
                         ["A", "B", "C", "G", "M", "active", "A2", "D", "X", "X", "active"]);
  // the counterparty of d1's tip is referenced, so it would never be purged
  const p = await stale.plan({ now: NOW, supply: { total: 1, wallets: 1 } });
  assert.strictEqual(p.rows.find((r) => r.f.userId === "a1").f.cpRefs, 1);
  // read-only: no archive column, no archive table
  assert.ok(!(await getQuery("SELECT name FROM pragma_table_info('users')")).some((c) => c.name === "archived_at"));
  assert.strictEqual((await getQuery("SELECT name FROM sqlite_master WHERE name = 'account_archive'")).length, 0);
  // thresholds move tiers: at a 365-day A threshold a1 (unseen 150d) is no longer A
  assert.strictEqual((await tierOf({ tierADays: 365, dormantDays: 365 })).a1, "active");
});

test("archive reclaims to the Reserve, hides the account, restore gives it back; both idempotent", async () => {
  await setup;
  assert.strictEqual(stale.LIVE(), "1 = 1");                        // no column yet: filter is a no-op
  assert.ok(await stale.ensure());
  assert.strictEqual(stale.LIVE("u"), "u.archived_at IS NULL");
  await runQuery("UPDATE users SET points_balance = 120000.5 WHERE userId = 'a1'");
  const r = await stale.archiveOne("a1", { runId: "run1", tier: "A", why: "test", now: NOW, graceDays: 60 });
  assert.deepStrictEqual(r, { userId: "a1", reclaimed: 120000 });
  assert.strictEqual(await stale.archiveOne("a1", { runId: "run1", tier: "A", now: NOW }), null);   // twice = once
  const u = (await getQuery("SELECT points_balance, archived_at FROM users WHERE userId = 'a1'"))[0];
  assert.strictEqual(u.points_balance, 0.5);                       // sub-1 dust stays
  assert.strictEqual(u.archived_at, NOW);
  const claims = await getQuery("SELECT flow, amount FROM reserve_claims WHERE userId = 'a1'");
  assert.deepStrictEqual(claims.map((c) => [c.flow, c.amount]), [["stale_reclaim", -120000]]);
  assert.strictEqual((await getQuery("SELECT points FROM transactions WHERE userId = 'a1' AND type = 'stale-reclaim'"))[0].points, -120000);
  const live = await getQuery(`SELECT userId FROM users WHERE ${stale.LIVE()}`);
  assert.ok(!live.some((x) => x.userId === "a1"));
  assert.strictEqual((await tierOf()).a1, "archived");

  assert.strictEqual(await stale.touch("act", "sign-in"), null);   // not archived: nothing happens
  const back = await stale.touch("a1", "sign-in");
  assert.deepStrictEqual(back, { restored: 120000 });
  assert.strictEqual(await stale.touch("a1", "sign-in"), null);    // twice = once
  const u2 = (await getQuery("SELECT points_balance, archived_at FROM users WHERE userId = 'a1'"))[0];
  assert.strictEqual(u2.points_balance, 120000.5);
  assert.strictEqual(u2.archived_at, null);
  const net = await getQuery("SELECT SUM(amount) AS s FROM reserve_claims WHERE userId = 'a1'");
  assert.strictEqual(net[0].s, 0);                                 // Reserve made whole both ways
  const a = (await getQuery("SELECT restored_via, restore_claim FROM account_archive WHERE userId = 'a1'"))[0];
  assert.strictEqual(a.restored_via, "sign-in");
  assert.ok(a.restore_claim);
});

test("purge: only tier A, only after the grace period, only while still archived and free of holds", async () => {
  await setup;
  await stale.ensure();
  await user("p1", { username: "CFppppppp1", cf: "purgeme", bal: 3000, created: 300 });
  await runQuery("INSERT INTO user_badges (userId, badgeId) VALUES ('p1', 'fresh_meat')");
  await stale.archiveOne("p1", { runId: "run2", tier: "A", now: NOW, graceDays: 60 });
  await stale.archiveOne("b1", { runId: "run2", tier: "B", now: NOW, graceDays: 60 });
  let r = await stale.purge({ now: NOW + 30 * DAY, dryRun: false });
  assert.strictEqual(r.due, 0);                                    // grace not over
  r = await stale.purge({ now: NOW + 61 * DAY, dryRun: true });
  assert.deepStrictEqual([r.due, r.purged], [1, 1]);               // dry run counts, deletes nothing
  assert.strictEqual((await getQuery("SELECT 1 FROM users WHERE userId = 'p1'")).length, 1);
  r = await stale.purge({ now: NOW + 61 * DAY, dryRun: false });
  assert.strictEqual(r.purged, 1);
  assert.strictEqual((await getQuery("SELECT 1 FROM users WHERE userId = 'p1'")).length, 0);
  assert.strictEqual((await getQuery("SELECT 1 FROM user_badges WHERE userId = 'p1'")).length, 0);
  assert.strictEqual((await getQuery("SELECT 1 FROM transactions WHERE userId = 'p1' AND type = 'stale-reclaim'")).length, 1);  // ledger kept
  const snap = JSON.parse((await getQuery("SELECT snapshot FROM account_archive WHERE userId = 'p1'"))[0].snapshot);
  assert.strictEqual(snap.camfrog, "purgeme");
  assert.strictEqual((await getQuery("SELECT 1 FROM users WHERE userId = 'b1'")).length, 1);  // B is never purged
  // purged = gone for good: touch can't bring it back
  assert.strictEqual(await stale.touch("p1", "sign-in"), null);
});

test("duplicate merge: balance, XP and history move to the primary, the copy goes", async () => {
  await setup;
  await txn("m1", "Welcome PAT", 60000, 1);
  const r = await stale.mergeDuplicate("m1", "m0");
  assert.strictEqual(r.balance, 60000);
  assert.strictEqual((await getQuery("SELECT points_balance FROM users WHERE userId = 'm0'"))[0].points_balance, 60005);
  assert.strictEqual((await getQuery("SELECT 1 FROM users WHERE userId = 'm1'")).length, 0);
  assert.strictEqual((await getQuery("SELECT COUNT(*) AS n FROM transactions WHERE userId = 'm1'"))[0].n, 0);
});

test("emailCategory never needs the address back", () => {
  assert.strictEqual(stale.emailCategory(""), "empty");
  assert.strictEqual(stale.emailCategory("k3j4h5g6f7d8s9"), "no-at");
  assert.strictEqual(stale.emailCategory("a@mailinator.com"), "disposable");
  assert.strictEqual(stale.emailCategory("a@gmail.com"), "major");
  assert.strictEqual(stale.emailCategory("a@example.com"), "placeholder");
});
