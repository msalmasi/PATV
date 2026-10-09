// 1.99ga: no transaction row for an account that doesn't exist (ledger.js), payouts follow a merge
// (account_merges), and the one-shot re-homing of old orphan rows (orphantx.js / fix-orphan-transactions.js)
// is correct, never changes a balance, and is idempotent.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-orphans-"));
process.chdir(dir);                                      // dbUtils opens ./myapp.db
const repo = path.join(__dirname, "..");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const ledger = require(path.join(repo, "ledger"));
const funding = require(path.join(repo, "funding"));
const ot = require(path.join(repo, "orphantx"));

const setup = (async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT, camfrogUsername TEXT,
    points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL,
    points INTEGER NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT, note TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS jackpot_rakes (jackpotId TEXT, spinId TEXT, userId TEXT, amount INTEGER)");
  await ledger.ensure();
  funding.sync({ reserve: 1e9, flows: {} });
})();
const user = (id, bal = 0) => runQuery("INSERT INTO users (userId, username, points_balance) VALUES (?, ?, ?)", [id, id, bal]);
const bal = async (id) => { const r = await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]); return r.length ? r[0].b : null; };
const txs = (id) => getQuery("SELECT * FROM transactions WHERE userId = ? ORDER BY timestamp, transactionId", [id]);
const claims = (id) => getQuery("SELECT * FROM reserve_claims WHERE userId = ?", [id]).catch(() => []);

test("a credit to a missing account writes nothing and says E_TARGET_NOT_FOUND", async () => {
  await setup;
  const r = await ledger.post("ghost-1", 5000, "Achievement: Pepe, Do a Thing");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, ledger.E_TARGET_NOT_FOUND);
  assert.strictEqual((await txs("ghost-1")).length, 0);
  await assert.rejects(ledger.postOrThrow("ghost-1", 10, "x"), (e) => e.code === ledger.E_TARGET_NOT_FOUND);
});

test("a credit / covered debit to a live account moves the balance and logs exactly one row", async () => {
  await setup;
  await user("live-1", 100);
  const r = await ledger.post("live-1", 50, "bonus win", { counterparty: "someone", note: "hi" });
  assert.ok(r.ok);
  assert.strictEqual(await bal("live-1"), 150);
  const rows = await txs("live-1");
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].points, 50);
  assert.strictEqual(rows[0].counterparty, "someone");
  const d = await ledger.post("live-1", -500, "tip sent", { requireCover: true });
  assert.strictEqual(d.code, ledger.E_INSUFFICIENT);
  assert.strictEqual(await bal("live-1"), 150);
  assert.strictEqual((await txs("live-1")).length, 1);
  const d2 = await ledger.post("live-1", -150, "tip sent", { requireCover: true });
  assert.ok(d2.ok);
  assert.strictEqual(await bal("live-1"), 0);
  await ledger.reverse(d2, -150);
  assert.strictEqual(await bal("live-1"), 150);
  assert.strictEqual((await txs("live-1")).length, 1);
});

test("the database refuses any raw transaction row for a missing account (trigger)", async () => {
  await setup;
  await assert.rejects(runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES ('t-raw', 'ghost-2', 'x', 1)"),
                       /E_TARGET_NOT_FOUND/);
  assert.strictEqual((await getQuery("SELECT COUNT(*) AS n FROM transactions WHERE userId = 'ghost-2'"))[0].n, 0);
});

test("a payout to a merged-away account follows the merge; with no survivor nothing is taken", async () => {
  await setup;
  await user("survivor-1", 1000);
  await ledger.recordMerge("auto-1", "survivor-1", "camfrog link");     // auto-1 is already deleted
  assert.strictEqual(await ledger.resolveUserId("auto-1"), "survivor-1");
  assert.ok(await funding.fundPayout("auto-1", 5000, "achievements", "Achievement: Pepe, Do a Thing"));
  assert.strictEqual(await bal("survivor-1"), 6000);
  assert.strictEqual((await txs("auto-1")).length, 0);
  assert.strictEqual((await txs("survivor-1")).length, 1);
  // a chain auto-2 -> auto-1 -> survivor-1 collapses
  await ledger.recordMerge("auto-2", "auto-1", "x");
  assert.strictEqual(await ledger.resolveUserId("auto-2"), "survivor-1");
  // nobody to pay: false, no claim, no row
  assert.strictEqual(await funding.fundPayout("ghost-3", 5000, "achievements", "Achievement: X"), false);
  assert.strictEqual((await claims("ghost-3")).length, 0);
  assert.strictEqual((await txs("ghost-3")).length, 0);
  // the plain ledger (no resolveMerged) still refuses a merged-away id
  assert.strictEqual((await ledger.post("auto-1", 1, "x")).code, ledger.E_TARGET_NOT_FOUND);
});

test("an account deleted between the row and the balance update: the row is withdrawn", async () => {
  await setup;
  await user("vanish-1", 10);
  // run the update against a deleted row: wrap runQuery so the account goes right after the INSERT
  const dbu = require(path.join(repo, "dbUtils"));
  const real = dbu.runQuery;
  // ledger.js holds its own reference to runQuery, so simulate via a trigger that deletes the user on insert
  await real("CREATE TEMP TRIGGER vanish AFTER INSERT ON transactions WHEN NEW.userId = 'vanish-1' BEGIN DELETE FROM users WHERE userId = 'vanish-1'; END");
  const r = await ledger.post("vanish-1", 99, "late credit");
  await real("DROP TRIGGER vanish");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, ledger.E_TARGET_NOT_FOUND);
  assert.strictEqual((await getQuery("SELECT COUNT(*) AS n FROM transactions WHERE userId = 'vanish-1'"))[0].n, 0);
});

// ── the one-shot re-homing ──
const sqlite3 = require("sqlite3");
function scratchDb(file) {
  const db = new sqlite3.Database(file);
  const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { return e ? rej(e) : res({ changes: this.changes }); }));
  const q = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => (e ? rej(e) : res(r))));
  return { db, run, q };
}

async function seed(file) {
  const { db, run } = scratchDb(file);
  await run(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT, points_balance INTEGER DEFAULT 0)`);
  await run(`CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT, points INTEGER,
             timestamp DATETIME, counterparty TEXT, note TEXT)`);
  await run("CREATE TABLE account_archive (userId TEXT PRIMARY KEY)");
  // S1: a CF-MERGE survivor whose ledger is squared (gap 0); its old account A1 left 2 history rows + 1 late row
  await run("INSERT INTO users VALUES ('S1', 's1', 1000)");
  await run("INSERT INTO transactions VALUES ('s1a', 'S1', 'ledger-correction', 1000, '2026-01-01 00:00:00', NULL, NULL)");
  await run("INSERT INTO transactions VALUES ('a1a', 'A1', 'Reward: Public Spin', 300, '2026-10-08 10:00:00', NULL, NULL)");
  await run("INSERT INTO transactions VALUES ('a1b', 'A1', 'tip sent', -100, '2026-10-08 11:00:00', 'X', 'for you')");
  await run("INSERT INTO transactions VALUES ('a1c', 'A1', 'Achievement: Pepe, Do a Thing', 5000, '2026-10-08 14:46:55', NULL, NULL)");
  // S2: a hand merge (map) whose balance holds the rows but the ledger lacks them (gap == rows)
  await run("INSERT INTO users VALUES ('S2', 's2', 700)");
  await run("INSERT INTO transactions VALUES ('s2a', 'S2', 'bonus win', 500, '2026-05-01 00:00:00', NULL, NULL)");
  await run("INSERT INTO transactions VALUES ('b1a', 'B1', 'bonus win', 200, '2026-04-01 00:00:00', NULL, NULL)");
  // someone else's tip row naming B1 as the counterparty
  await run("INSERT INTO users VALUES ('Z', 'z', 0)");
  await run("INSERT INTO transactions VALUES ('z1', 'Z', 'tip received', 0, '2026-04-02 00:00:00', 'B1', NULL)");
  // C1: gone, nobody known
  await run("INSERT INTO transactions VALUES ('c1a', 'C1', 'bonus win', 50000, '2026-03-25 21:31:09', NULL, NULL)");
  await new Promise((r) => db.close(r));
}

const LOG = [
  "[2026-10-08T14:46:40.362Z] HIT /events endpoint. Type: spin, Identifier: x",
  "User A1 is now level 3 with 612 XP.",
  "[CF-MERGE] Merging auto account aaaaaaaa-0000-4000-8000-000000000001 into bbbbbbbb-0000-4000-8000-000000000001: +PAT 200, +XP 112",
  "[2026-10-08T14:47:27.987Z] HIT /events endpoint.",
].join("\n");

test("merge log parsing gives each merge its time window", () => {
  const m = ot.parseMergeLog(LOG);
  assert.strictEqual(m.length, 1);
  assert.deepStrictEqual([m[0].after, m[0].before, m[0].oldBalance], ["2026-10-08 14:46:40", "2026-10-08 14:47:27", 200]);
  assert.deepStrictEqual(ot.parseMap("# c\nB1 S2 2026-05-01 00:00:00\n"), [{ old: "B1", new: "S2", via: "staff map", at: "2026-05-01 00:00:00" }]);
});

test("re-homing: history moves with a note, the late row is listed as lost, balances never change, idempotent", async () => {
  await setup;
  const file = path.join(dir, "scratch.db");
  await seed(file);
  const extra = [
    { old: "A1", new: "S1", via: "camfrog link (log)", oldBalance: 200, after: "2026-10-08 14:46:40", before: "2026-10-08 14:47:27" },
    ...ot.parseMap("B1 S2\n"),
  ];
  const { db, q, run } = scratchDb(file);
  const p = await ot.plan(q, extra);
  assert.strictEqual(p.totals.orphanIds, 3);
  const s1 = p.survivors.find((s) => s.survivor === "S1");
  const s2 = p.survivors.find((s) => s.survivor === "S2");
  assert.deepStrictEqual(s1.olds[0].rows.sort(), ["a1a", "a1b"]);
  assert.strictEqual(s1.gap, 0);
  assert.strictEqual(s1.offset, -200);                     // ledger squared before: offset keeps it squared
  assert.strictEqual(s2.gap, 200);
  assert.strictEqual(s2.offset, 0);                        // balance already held them: the rows close the gap
  assert.deepStrictEqual(p.lost.map((l) => [l.transactionId, l.points]), [["a1c", 5000]]);
  assert.deepStrictEqual(p.noSurvivor.map((o) => o.userId), ["C1"]);

  const before = await q("SELECT userId, points_balance FROM users ORDER BY userId");
  await run("BEGIN IMMEDIATE");
  const done = await ot.apply(q, run, p);
  await run("COMMIT");
  assert.deepStrictEqual(done, { moved: 3, offsets: 1, counterparties: 1 });
  assert.deepStrictEqual(await q("SELECT userId, points_balance FROM users ORDER BY userId"), before);
  const sum = async (id) => (await q("SELECT COALESCE(SUM(points),0) AS s FROM transactions WHERE userId = ?", [id]))[0].s;
  assert.strictEqual(await sum("S1"), 1000);                // = balance
  assert.strictEqual(await sum("S2"), 700);                 // = balance
  const a1b = (await q("SELECT * FROM transactions WHERE transactionId = 'a1b'"))[0];
  assert.strictEqual(a1b.userId, "S1");
  assert.strictEqual(a1b.note, "for you " + ot.SUFFIX);
  assert.strictEqual(a1b.points, -100);
  assert.strictEqual((await q("SELECT note FROM transactions WHERE transactionId = 'a1a'"))[0].note, ot.SUFFIX);
  assert.strictEqual((await q("SELECT userId FROM transactions WHERE transactionId = 'a1c'"))[0].userId, "A1");   // lost row stays
  assert.strictEqual((await q("SELECT userId FROM transactions WHERE transactionId = 'c1a'"))[0].userId, "C1");   // no survivor: untouched
  assert.strictEqual((await q("SELECT counterparty FROM transactions WHERE transactionId = 'z1'"))[0].counterparty, "S2");
  assert.strictEqual((await q("SELECT new_id FROM account_merges WHERE old_id = 'B1'"))[0].new_id, "S2");

  // second run: nothing left to do
  const p2 = await ot.plan(q, extra);
  assert.strictEqual(p2.totals.toMoveRows, 0);
  await run("BEGIN IMMEDIATE");
  const again = await ot.apply(q, run, p2);
  await run("COMMIT");
  assert.deepStrictEqual(again, { moved: 0, offsets: 0, counterparties: 0 });
  assert.strictEqual(await sum("S1"), 1000);
  assert.strictEqual((await q("SELECT COUNT(*) AS n FROM transactions"))[0].n, 9);
  await new Promise((r) => db.close(r));
});

test("the script: dry run opens read-only and writes nothing; --apply backs up, applies once", async () => {
  await setup;
  const file = path.join(dir, "cli.db");
  await seed(file);
  const map = path.join(dir, "map.txt");
  fs.writeFileSync(map, "A1 S1 2026-10-08 12:00:00\nB1 S2\n");
  const env = { ...process.env, NODE_PATH: process.env.NODE_PATH || "" };
  const script = path.join(repo, "fix-orphan-transactions.js");
  const stat0 = fs.statSync(file).mtimeMs;
  const dry = execFileSync(process.execPath, [script, `--db=${file}`, `--map=${map}`, "--dry-run"], { env, encoding: "utf8" });
  assert.match(dry, /DRY RUN/);
  assert.match(dry, /possibly lost credits .*: 1 row/);
  assert.strictEqual(fs.statSync(file).mtimeMs, stat0);
  const out = execFileSync(process.execPath, [script, `--db=${file}`, `--map=${map}`, "--apply"], { env, encoding: "utf8" });
  assert.match(out, /APPLIED: 3 row\(s\) moved, 1 offset row\(s\)/);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("myapp-before-orphan-reattr-")));
  const out2 = execFileSync(process.execPath, [script, `--db=${file}`, `--map=${map}`, "--apply", "--no-backup"], { env, encoding: "utf8" });
  assert.match(out2, /APPLIED: 0 row\(s\) moved, 0 offset row\(s\)/);
});
