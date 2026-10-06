// Level-ups: one reward per (user, level) under concurrency, no lost XP (2026-10-06 race fix), and
// the 1.99ax "option E" rewards: 25k every level + a milestone every 5 levels (250k x L/5, owed when
// the Reserve can't cover it) + that milestone's level cosmetics, and the quiet cosmetics backfill.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lvl-"));
process.chdir(dir);                                      // dbUtils opens ./myapp.db
const repo = path.join(__dirname, "..");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const funding = require(path.join(repo, "funding"));
const paid = [];                                         // [{userId, amount, type}]
let reserveCovers = () => true;
funding.fundPayout = async (userId, amount, flow, type) => {
  await new Promise((r) => setTimeout(r, 5));            // widen the race window
  if (!reserveCovers(amount, type)) return false;
  await runQuery("UPDATE users SET points_balance = points_balance + ? WHERE userId = ?", [amount, userId]);
  paid.push({ userId, amount, type });
  return true;
};
let uc, cosmetics;
const setup = (async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT, xp REAL DEFAULT 0,
                  level INTEGER DEFAULT 1, points_balance INTEGER DEFAULT 0)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT,
                  points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)`);
  uc = require(path.join(repo, "user.controller"));
  cosmetics = require(path.join(repo, "cosmetics"));
  await cosmetics.ready;
})();
const addUser = (id, level = 1, xp = 0) =>
  runQuery("INSERT INTO users (userId, username, xp, level, points_balance) VALUES (?, ?, ?, ?, 0)", [id, id, xp, level]);
const paidTo = (id) => paid.filter((p) => p.userId === id);
const xpTo = (from, to) => { let n = 0; for (let l = from; l < to; l++) n += uc.xpForNextLevel(l); return n; };
const owned = async (id) => (await getQuery("SELECT item_id FROM user_cosmetics WHERE user_id = ?", [id])).map((r) => r.item_id);
const settle = () => new Promise((r) => setTimeout(r, 150));   // grantUnlocks runs after updateLevel returns

test("concurrent XP awards pay each level once and keep every point of XP", async () => {
  await setup;
  await addUser("u1");
  const step = uc.xpForNextLevel(1);
  await Promise.all(Array.from({ length: 6 }, () => uc.updateLevel("u1", step)));   // each enough for a level alone
  const u = (await getQuery("SELECT xp, level FROM users WHERE userId = 'u1'"))[0];
  const counts = paidTo("u1").reduce((m, p) => (m[p.type] = (m[p.type] || 0) + 1, m), {});
  for (const [t, n] of Object.entries(counts)) assert.strictEqual(n, 1, `${t} paid ${n} times`);
  // total XP conserved: replaying the same 6 awards sequentially on a fresh user ends identical
  await addUser("u2");
  for (let i = 0; i < 6; i++) await uc.updateLevel("u2", step);
  const v = (await getQuery("SELECT xp, level FROM users WHERE userId = 'u2'"))[0];
  assert.deepStrictEqual({ xp: u.xp, level: u.level }, { xp: v.xp, level: v.level }, "concurrent result == sequential result");
  // the same level can't be paid again even if something calls with the old level state
  const before = paid.length;
  await runQuery("UPDATE users SET level = 2, xp = 0 WHERE userId = 'u1'");
  await uc.updateLevel("u1", step);
  assert.strictEqual(paid.length, before, "a level already rewarded is not paid again");
});

test("reward table: 25k every level, + 250k x L/5 on every 5th", async () => {
  await setup;
  const t = (l) => uc.levelReward(l);
  assert.strictEqual(t(1), 25000);
  assert.strictEqual(t(4), 25000);
  assert.strictEqual(t(5), 25000 + 250000);
  assert.strictEqual(t(10), 25000 + 500000);
  assert.strictEqual(t(25), 25000 + 1250000);
  assert.strictEqual(t(50), 25000 + 2500000);
  assert.strictEqual(uc.milestoneReward(51), 0);
  assert.strictEqual(uc.milestoneReward(55), 2750000);
});

test("levelling 1 -> 11 pays 25k per level and the Lv 5 + Lv 10 milestones once, with their cosmetics", async () => {
  await setup;
  await addUser("u3");
  const r = await uc.updateLevel("u3", xpTo(1, 11));
  assert.strictEqual(r.newLevel, 11);
  const got = paidTo("u3");
  const base = got.filter((p) => p.type.startsWith("Level-up reward"));
  assert.strictEqual(base.length, 10);
  assert.ok(base.every((p) => p.amount === 25000));
  const ms = got.filter((p) => / milestone$/.test(p.type)).map((p) => [p.type, p.amount]);
  assert.deepStrictEqual(ms, [["Level 5 milestone", 250000], ["Level 10 milestone", 500000]]);
  assert.strictEqual(r.bonusPoints, 10 * 25000 + 750000);
  await settle();
  const items = await owned("u3");
  for (const id of ["nc_tadpole", "nc_double", "bn_lilystripes", "gh_party", "gf_pixel"]) assert.ok(items.includes(id), id);
  assert.ok(!items.includes("ad_ripple"), "no Lv 15 item at 11");
  // granted once: another pass changes nothing
  await cosmetics.grantUnlocks("u3", { level: 11 });
  await uc.updateLevel("u3", 1);
  const again = await owned("u3");
  assert.strictEqual(again.length, items.length);
  assert.strictEqual(new Set(again).size, again.length, "no duplicate copies");
  assert.strictEqual(paidTo("u3").length, got.length, "nothing paid twice");
});

test("concurrent awards across a milestone pay it exactly once", async () => {
  await setup;
  await addUser("u4", 4, 0);
  const step = uc.xpForNextLevel(4);
  await Promise.all(Array.from({ length: 8 }, () => uc.updateLevel("u4", step)));
  const ms = paidTo("u4").filter((p) => p.type === "Level 5 milestone");
  assert.strictEqual(ms.length, 1);
  const rows = await getQuery("SELECT paid FROM levelup_milestones WHERE userId = 'u4' AND level = 5");
  assert.deepStrictEqual(rows.map((r) => r.paid), [1]);
});

test("a milestone the Reserve can't cover is owed (paid later, once); the cosmetic is granted anyway", async () => {
  await setup;
  await addUser("u5", 4, 0);
  reserveCovers = () => false;                           // the Reserve is dry
  try {
    const r = await uc.updateLevel("u5", uc.xpForNextLevel(4));
    assert.strictEqual(r.newLevel, 5);
    assert.strictEqual(r.bonusPoints, 0);
    assert.strictEqual(paidTo("u5").length, 0);
    await settle();
    assert.ok((await owned("u5")).includes("nc_tadpole"), "cosmetic granted without the PAT");
    await uc.updateLevel("u5", 1);                       // still dry: still owed
    const row = (await getQuery("SELECT paid FROM levelup_milestones WHERE userId = 'u5' AND level = 5"))[0];
    assert.strictEqual(row.paid, 0);
  } finally {
    reserveCovers = () => true;
  }
  const r2 = await uc.updateLevel("u5", 1);              // the Reserve refilled: any XP award settles it
  assert.strictEqual(r2.milestonePoints, 250000);
  await Promise.all([uc.updateLevel("u5", 1), uc.updateLevel("u5", 1), uc.updateLevel("u5", 1)]);
  const ms = paidTo("u5").filter((p) => p.type === "Level 5 milestone");
  assert.strictEqual(ms.length, 1, "owed milestone paid once");
  // the base reward that was skipped stays skipped (as before)
  assert.strictEqual(paidTo("u5").filter((p) => p.type.startsWith("Level-up reward")).length, 0);
});

test("backfill grants only the level cosmetics a user qualifies for and is missing, and is idempotent", async () => {
  await setup;
  await addUser("b3", 3);
  await addUser("b12", 12);
  await addUser("b47", 47);
  // b12 already has the Lv 10 name colour - it must not get a second copy
  await cosmetics.grant("b12", "nc_double", "level", "unlock:nc_double:b12");
  const r = await cosmetics.backfillLevelUnlocks({ force: true });
  assert.ok(r.granted > 0);
  assert.deepStrictEqual(await owned("b3"), []);
  const b12 = (await owned("b12")).sort();
  assert.deepStrictEqual(b12, ["bn_lilystripes", "gf_pixel", "gh_party", "nc_double", "nc_tadpole"].sort());
  const b47 = await owned("b47");
  for (const id of ["nc_tadpole", "ad_ripple", "gb_lilypond", "nc_veteran", "pb_pearl", "gf_laurel", "bn_sunken", "gh_lotus"]) assert.ok(b47.includes(id), id);
  for (const id of ["nc_elder", "gh_halo", "pb_prestige60"]) assert.ok(!b47.includes(id), id);
  assert.strictEqual(paid.filter((p) => p.userId.startsWith("b")).length, 0, "no PAT backfill");
  const again = await cosmetics.backfillLevelUnlocks({ force: true });
  assert.strictEqual(again.granted, 0);
  const skip = await cosmetics.backfillLevelUnlocks();
  assert.ok(skip.skipped, "runs once per set of level items");
});

test("every 5-level milestone up to 50 has a level cosmetic, plus prestige every 10 to 100", async () => {
  await setup;
  const lv = new Set(cosmetics.catalog().filter((it) => it.unlock && it.unlock.level).map((it) => it.unlock.level));
  for (let l = 5; l <= 50; l += 5) assert.ok(lv.has(l), `Lv ${l}`);
  for (let l = 60; l <= 100; l += 10) assert.ok(lv.has(l), `Lv ${l}`);
});
