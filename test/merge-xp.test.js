// 1.99gg: account merges add the two CUMULATIVE XP totals (user.controller mergeXpOf). They used to keep the
// higher level and add only the in-level xp, losing everything the lower account spent reaching its level
// (32 past !verify merges: 144,000 XP short). A sum that reaches levels above both pays those new levels
// through the normal updateLevel path (afterMerge), deduped by levelup_rewards - never a level already paid.
//   NODE_PATH=<PATV>/node_modules node --test test/merge-xp.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "merge-xp-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
process.env.TWITCH_BOT_TOKEN = "bot-token";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const funding = require(path.join(repo, "funding"));
const paid = [];
funding.fundPayout = async (userId, amount, flow, type) => {
  await runQuery("UPDATE users SET points_balance = points_balance + ? WHERE userId = ?", [amount, userId]);
  paid.push({ userId, amount, type });
  return true;
};
let uc, AM;
const ready = (async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT,
                  points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, liked INTEGER DEFAULT 0,
                  twitchBonus INTEGER DEFAULT 0, twitchBonus_at TEXT, discordBonus INTEGER DEFAULT 0, discordBonus_at TEXT,
                  camfrogUsername TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT, userId TEXT, type TEXT, points INTEGER, note TEXT)");
  await runQuery("CREATE TABLE IF NOT EXISTS pending_camfrog_links (code TEXT, userId TEXT, camfrogUsername TEXT, expires_at TEXT)");
  await runQuery(`CREATE TABLE IF NOT EXISTS levelup_rewards (userId TEXT NOT NULL, level INTEGER NOT NULL, amount INTEGER NOT NULL,
                  paid INTEGER NOT NULL DEFAULT 0, created DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (userId, level))`);
  await runQuery(`CREATE TABLE IF NOT EXISTS levelup_milestones (userId TEXT NOT NULL, level INTEGER NOT NULL, amount INTEGER NOT NULL,
                  paid INTEGER NOT NULL DEFAULT 0, created DATETIME DEFAULT CURRENT_TIMESTAMP, paid_at DATETIME, PRIMARY KEY (userId, level))`);
  uc = require(path.join(repo, "user.controller"));
  AM = require(path.join(repo, "accountMerge"));
})();
const addUser = (id, level, xp, extra = {}) =>
  runQuery("INSERT INTO users (userId, username, password, xp, level, camfrogUsername) VALUES (?, ?, 'x', ?, ?, ?)",
           [id, extra.username || id, xp, level, extra.cf || null]);
const row = async (id) => (await getQuery("SELECT xp, level FROM users WHERE userId = ?", [id]))[0];
const paidTo = (id) => paid.filter((p) => p.userId === id);
const claimLevels = async (id, upTo) => {
  for (let l = 1; l <= upTo; l++) await runQuery("INSERT OR IGNORE INTO levelup_rewards (userId, level, amount, paid) VALUES (?, ?, 25000, 1)", [id, l]);
};

test("mergeXpOf: the cumulative totals add up, for any pair of levels", async () => {
  await ready;
  const T = uc.totalXpOf;
  const cases = [
    // [survivor, other, expected level, expected in-level xp]
    [{ level: 3, xp: 500 }, { level: 1, xp: 200 }, 3, 1700],              // 14,500 + 1,200 = 15,700 (old code: Lv3 / 700)
    [{ level: 6, xp: 0 }, { level: 5, xp: 0 }, 7, 6000],                  // 91,000 + 55,000 = 146,000 -> Lv7 (140,000) + 6,000
    [{ level: 20, xp: 0 }, { level: 1, xp: 0 }, 20, 1000],                // 2,870,000 + 1,000
    [{ level: 1, xp: 0 }, { level: 20, xp: 0 }, 20, 1000],                // the same, whichever side survives
    [{ level: 0, xp: 0 }, { level: 0, xp: 0 }, 0, 0],
    [{ level: 4, xp: 100 }, null, 4, 100],                                // nothing to add
  ];
  for (const [s, o, level, xp] of cases) {
    const m = uc.mergeXpOf(s, o);
    const want = T(s.level, s.xp) + (o ? T(o.level, o.xp) : 0);
    assert.equal(m.total, want, JSON.stringify([s, o]));
    assert.deepEqual({ level: m.level, xp: m.xp }, { level, xp }, JSON.stringify([s, o]));
    assert.deepEqual({ level: m.level, xp: m.xp }, uc.levelOfTotal(want));
    assert.equal(m.otherTotal, o ? T(o.level, o.xp) : 0);
    // what the merge stores: the higher level + the rest; the same total, settled by updateLevel
    assert.equal(m.store.level, Math.max(s.level, o ? o.level : 0));
    assert.equal(T(m.store.level, m.store.xp), want, "store holds the whole total");
  }
  assert.equal(uc.mergeXpOf({ level: 6, xp: 0 }, { level: 5, xp: 0 }).store.xp, 55000, "Lv6 + the Lv5 account's 55,000");
});

test("carryUserFields (duplicate + provider merges): Lv3 + Lv1 keeps every point, no level-up paid", async () => {
  await ready;
  await addUser("a-to", 3, 500); await addUser("a-from", 1, 200);
  await claimLevels("a-to", 3); await claimLevels("a-from", 1);
  const from = (await getQuery("SELECT * FROM users WHERE userId = 'a-from'"))[0];
  const c = await AM.carryUserFields(from, "a-to");
  assert.equal(c.xp, 1200, "reports the cumulative XP carried");
  await AM.moveUserRows("a-from", "a-to");
  await runQuery("DELETE FROM users WHERE userId = 'a-from'");
  await AM.afterMerge("a-to", {});
  assert.deepEqual({ ...(await row("a-to")) }, { xp: 1700, level: 3 });
  assert.equal(paidTo("a-to").length, 0, "no new level, nothing paid");
});

test("a merge past both levels pays only the NEW levels, through the normal level-up path", async () => {
  await ready;
  // survivor Lv6 + 40,000 (131,000), other Lv5 + 30,000 (85,000) = 216,000 -> Lv8 (204,000) + 12,000
  await addUser("b-to", 6, 40000); await addUser("b-from", 5, 30000);
  await claimLevels("b-to", 6); await claimLevels("b-from", 5);
  const from = (await getQuery("SELECT * FROM users WHERE userId = 'b-from'"))[0];
  await AM.carryUserFields(from, "b-to");
  assert.deepEqual({ ...(await row("b-to")) }, { xp: 216000 - uc.totalXpOf(6, 0), level: 6 }, "stored as Lv6 + the rest until settled");
  await AM.moveUserRows("b-from", "b-to");
  await runQuery("DELETE FROM users WHERE userId = 'b-from'");
  await AM.afterMerge("b-to", {});
  assert.deepEqual({ ...(await row("b-to")) }, { xp: 12000, level: 8 });
  assert.deepEqual(paidTo("b-to").map((p) => p.type).sort(), ["Level-up reward (Lv 7)", "Level-up reward (Lv 8)"]);
  // settling again pays nothing more
  await AM.afterMerge("b-to", {});
  await uc.updateLevel("b-to", 0);
  assert.equal(paidTo("b-to").length, 2);
});

test("a level the merged-in account was already paid for is not paid again", async () => {
  await ready;
  // the other account once reached Lv7 (paid), then lost it (admin) - its record moves with the rows
  await addUser("c-to", 6, 40000); await addUser("c-from", 5, 30000);
  await claimLevels("c-to", 6); await claimLevels("c-from", 7);
  const from = (await getQuery("SELECT * FROM users WHERE userId = 'c-from'"))[0];
  await AM.carryUserFields(from, "c-to");
  await AM.moveUserRows("c-from", "c-to");
  await runQuery("DELETE FROM users WHERE userId = 'c-from'");
  await AM.afterMerge("c-to", {});
  assert.deepEqual({ ...(await row("c-to")) }, { xp: 12000, level: 8 });
  assert.deepEqual(paidTo("c-to").map((p) => p.type), ["Level-up reward (Lv 8)"], "Lv7 was already paid");
});

test("Lv20 + Lv1 and a milestone level reached by the merge (Lv10) pays its milestone once", async () => {
  await ready;
  await addUser("d-to", 20, 0); await addUser("d-from", 1, 0);
  await claimLevels("d-to", 20);
  let from = (await getQuery("SELECT * FROM users WHERE userId = 'd-from'"))[0];
  await AM.carryUserFields(from, "d-to");
  await runQuery("DELETE FROM users WHERE userId = 'd-from'");
  await AM.afterMerge("d-to", {});
  assert.deepEqual({ ...(await row("d-to")) }, { xp: 1000, level: 20 });
  assert.equal(paidTo("d-to").length, 0);
  // Lv9 + Lv9: 2 x 285,000 = 570,000 -> Lv11 (506,000) + 64,000: pays Lv10 (+ its milestone) and Lv11
  await addUser("e-to", 9, 0); await addUser("e-from", 9, 0);
  await claimLevels("e-to", 9); await claimLevels("e-from", 9);
  from = (await getQuery("SELECT * FROM users WHERE userId = 'e-from'"))[0];
  await AM.carryUserFields(from, "e-to");
  await AM.moveUserRows("e-from", "e-to");
  await runQuery("DELETE FROM users WHERE userId = 'e-from'");
  await AM.afterMerge("e-to", {});
  assert.deepEqual({ ...(await row("e-to")) }, uc.levelOfTotal(2 * uc.totalXpOf(9, 0)));
  assert.equal((await row("e-to")).level, 11);
  const got = paidTo("e-to").map((p) => p.type).sort();
  assert.deepEqual(got, ["Level 10 milestone", "Level-up reward (Lv 10)", "Level-up reward (Lv 11)"]);
});

test("the Camfrog !verify merge (completeCamfrogLink) uses the same rule: Lv3 + a Lv1 auto account", async () => {
  await ready;
  await addUser("f-me", 3, 500, { username: "frank" });
  await addUser("f-auto", 1, 200, { username: "CFfrank", cf: "frankcf" });
  await runQuery("INSERT INTO pending_camfrog_links (code, userId, camfrogUsername, expires_at) VALUES ('XPX123', 'f-me', 'frankcf', ?)",
                 [new Date(Date.now() + 600000).toISOString()]);
  let out = null;
  const res = { status() { return this; }, json(d) { out = d; return this; } };
  await uc.verifyCamfrogLink({ body: { code: "XPX123", camfrogUsername: "frankcf", password: "bot-token" } }, res);
  assert.equal(out && out.success, true, JSON.stringify(out));
  assert.equal(out.merged, true);
  assert.equal(out.addedXp, 1200, "the auto account's cumulative XP");
  assert.deepEqual({ ...(await row("f-me")) }, { xp: 1700, level: 3 });
  assert.equal(await row("f-auto"), undefined);
});
