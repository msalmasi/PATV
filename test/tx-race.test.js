// 1.99sr: overlapping money transactions on the shared SQLite connection keep the ledger whole.
// Prod 2026-10-12: the gold and public wheel acknowledges each ran a raw BEGIN/COMMIT; when they overlapped, one's
// failed BEGIN + bare ROLLBACK undid the other's half-written transaction (its ledger row), and the other's balance
// UPDATE then committed on its own - a 5,000 debit with no transactions row. Every such path now runs in mainstage's
// serialized tx(). This drives many overlapping tx() blocks (wager + payout + rake, a refused one rolled back) and
// checks SUM(transactions) == SUM(balances) per user.
//   node --test test/tx-race.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "txrace-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const ledger = require(path.join(repo, "ledger"));
const tx = (fn) => require(path.join(repo, "mainstage"))._tx(fn);

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT,
                  points_balance INTEGER DEFAULT 0)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL,
                  points INTEGER NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT, note TEXT)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS wheel_spins (spinId TEXT PRIMARY KEY, userId TEXT, result TEXT)`);
  for (let i = 0; i < 6; i++) {
    await runQuery("INSERT INTO users (userId, username, password, points_balance) VALUES (?, ?, 'x', 0)", ["u" + i, "user" + i]);
    await ledger.postOrThrow("u" + i, 1000000, "seed");
  }
});

// one wheel acknowledge, as index.js does it now: claim the spin inside the transaction, then wager + rake
function acknowledge(spinId, userId, type) {
  return tx(async () => {
    const up = await runQuery("UPDATE wheel_spins SET result = 'PENDING' WHERE spinId = ? AND result = 'INTENT'", [spinId]);
    if (!up || up.changes !== 1) return false;
    await ledger.postOrThrow(userId, -5000, "Wager: " + type, { source: type });
    await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, 5000)", ["j" + spinId, spinId, userId]);
    return true;
  });
}

test("overlapping wheel acknowledges + payouts + a refused step never lose a ledger row", async () => {
  // the spins exist before the burst (in index.js the INTENT row is written by an earlier request, /spin)
  for (let i = 0; i < 120; i++) await runQuery("INSERT INTO wheel_spins (spinId, userId, result) VALUES (?, ?, 'INTENT')", ["s" + i, "u" + (i % 6)]);
  const jobs = [];
  for (let i = 0; i < 120; i++) {
    const u = "u" + (i % 6), sid = "s" + i;
    jobs.push(acknowledge(sid, u, i % 2 ? "Gold Spin" : "Public Spin"));
    if (i % 3 === 0) jobs.push(acknowledge(sid, u, "Gold Spin"));            // a double acknowledge of the same spin
    jobs.push(tx(() => ledger.postOrThrow(u, 1234, "Reward: Spin")));
    if (i % 10 === 0) jobs.push(tx(async () => {                              // a step that fails half way: rolled back
      await ledger.postOrThrow(u, -777, "doomed");
      throw new Error("boom");
    }).catch(() => "refused"));
  }
  const out = await Promise.all(jobs);
  assert.equal(out.filter((x) => x === true).length, 120, "each spin is charged exactly once");
  const drift = await getQuery(`SELECT u.userId, u.points_balance - COALESCE(SUM(t.points), 0) AS d FROM users u
                                LEFT JOIN transactions t ON t.userId = u.userId GROUP BY u.userId HAVING d <> 0`);
  assert.deepEqual(drift, [], "every balance equals its transaction sum");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM transactions WHERE type = 'doomed'"))[0].n, 0, "the refused step left nothing");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM jackpot_rakes"))[0].n, 120, "one rake per spin");
});

test("no raw BEGIN left in the wheel acknowledges, the bonus payout or the store purchase", () => {
  const idx = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  for (const route of ["/api/u/acknowledge-spin", "/api/g/acknowledge-spin"]) {
    const at = idx.indexOf(`app.post("${route}"`);
    assert.ok(at > 0, route);
    const body = idx.slice(at, idx.indexOf("\napp.", at + 10));
    assert.ok(!/runQuery\("BEGIN/.test(body) && !/runQuery\("ROLLBACK"\)/.test(body), `${route}: no raw BEGIN / bare ROLLBACK`);
    assert.ok(/_tx\(/.test(body) && /result = 'INTENT'/.test(body), `${route}: claims the spin inside tx()`);
  }
  const uc = fs.readFileSync(path.join(repo, "user.controller.js"), "utf8");
  const ab = uc.slice(uc.indexOf("async function awardBonus"), uc.indexOf("module.exports"));
  assert.ok(!/BEGIN TRANSACTION/.test(ab) && !/runQuery\("ROLLBACK"\)/.test(ab) && /_tx\(/.test(ab), "awardBonus uses tx()");
  const sh = fs.readFileSync(path.join(repo, "shop.js"), "utf8");
  assert.ok(!/await runQuery\("BEGIN TRANSACTION"\)/.test(sh.slice(sh.indexOf("let orderId = null"))), "the store purchase uses tx()");
});

test.after(() => setTimeout(() => process.exit(0), 50));
