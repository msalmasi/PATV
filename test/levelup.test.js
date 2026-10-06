// Level-ups under concurrency: one reward per (user, level), no lost XP (2026-10-06 race fix).
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

test("concurrent XP awards pay each level once and keep every point of XP", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-"));
  const cwd = process.cwd();
  process.chdir(dir);                                    // dbUtils opens ./myapp.db
  try {
    const repo = path.join(__dirname, "..");
    const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
    await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT, xp REAL DEFAULT 0,
                    level INTEGER DEFAULT 1, points_balance INTEGER DEFAULT 0)`);
    await runQuery(`CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT,
                    points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)`);
    await runQuery("INSERT INTO users (userId, username, xp, level, points_balance) VALUES ('u1', 'tester', 0, 1, 0)");
    const funding = require(path.join(repo, "funding"));
    const paid = [];
    funding.fundPayout = async (userId, amount, flow, type) => {        // the Reserve always covers it here
      await new Promise((r) => setTimeout(r, 5));                       // widen the race window
      await runQuery("UPDATE users SET points_balance = points_balance + ? WHERE userId = ?", [amount, userId]);
      paid.push(type);
      return true;
    };
    const uc = require(path.join(repo, "user.controller"));
    const updateLevel = uc.updateLevel || uc._updateLevelForTest;
    assert.ok(updateLevel, "updateLevel is exported");
    const need = (lv) => (uc.xpForNextLevel ? uc.xpForNextLevel(lv) : null);
    const step = need(1) || 1000;
    // 6 concurrent awards, each enough for a level on its own
    await Promise.all(Array.from({ length: 6 }, () => updateLevel("u1", step)));
    const u = (await getQuery("SELECT xp, level FROM users WHERE userId = 'u1'"))[0];
    const counts = paid.reduce((m, t) => (m[t] = (m[t] || 0) + 1, m), {});
    for (const [t, n] of Object.entries(counts)) assert.strictEqual(n, 1, `${t} paid ${n} times`);
    // total XP conserved: replaying the same 6 awards sequentially on a fresh user ends identical
    await runQuery("INSERT INTO users (userId, username, xp, level, points_balance) VALUES ('u2', 'seq', 0, 1, 0)");
    for (let i = 0; i < 6; i++) await updateLevel("u2", step);
    const v = (await getQuery("SELECT xp, level FROM users WHERE userId = 'u2'"))[0];
    assert.deepStrictEqual({ xp: u.xp, level: u.level }, { xp: v.xp, level: v.level }, "concurrent result == sequential result");
    // the same level can't be paid again even if something calls with the old level state
    const before = paid.length;
    await runQuery("UPDATE users SET level = 2, xp = 0 WHERE userId = 'u1'");
    await updateLevel("u1", step);
    assert.strictEqual(paid.length, before, "a level already rewarded is not paid again");
  } finally {
    process.chdir(cwd);
  }
});
