// Phase 5 (5.17): the cosmetic drop table on the site (cosmetics.js).
//   * before the hand-over: Pepe's push (the wheel / casino rows + cap + gates) is the table, the rest are his defaults
//   * the hand-over: refused while the switch is off; once on, his whole table lands in one transaction, idempotent; an
//     (older) Pepe's push never overwrites the site's table afterwards
//   * admins edit it (clamped, logged) only while the site owns it; the site's own rolls (the wheel, the casino tables) read
//     the same numbers
//   * the way back hands the numbers to Pepe
//   NODE_PATH=G:/PATV/node_modules node --test test/cosmetic-drops.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cosdrops-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const { runQuery } = require(path.join(repo, "dbUtils"));
let C;

const PEPE_TABLE = { crack: 0.25, arena: 0.1, bingo: 0.1, bingo_line: 0.05, bounty: 0.15, bounty_post: 0.05, duel: 0.04, brawl: 0.03, convoy: 0.05,
  door: 0.02, store: 0.01, lotto: 0.02, lotto_jackpot: 1, blackjack: 0.03, holdem: 0.015, wheel: 0.001, wheel_jackpot: 0.25,
  cap: 4, min_stake: 10000, min_bj_bet: 3000, min_holdem_pot: 20000, min_level: 2, pair_rolls: 3, event_pool_share: 0.5 };

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  C = require(path.join(repo, "cosmetics"));
  await C.ready;
});

test("before the hand-over: Pepe's push is the table for the rows the site rolls; the rest are his defaults", async () => {
  await C.setDropConfig({ wheel: 0.002, blackjack: 0.05 }, 5, { min_bj_bet: 1000 });
  const c = await C.dropConfig(true);
  assert.deepEqual([c.wheel, c.blackjack, c.cap, c.min_bj_bet, c.crack, c.event_pool_share], [0.002, 0.05, 5, 1000, 0.25, 0.5]);
  assert.equal(await C.dropLive(), false);
});

test("the hand-over: refused while off; then his whole table in one go, idempotent; his later pushes are ignored", async () => {
  let r = await C.importDropConfig("cd-1", PEPE_TABLE, "foamy");
  assert.equal(r.code, "E_FEATURE_OFF");
  await C.setDropMeta("enabled", true);
  r = await C.importDropConfig("cd-1", Object.assign({}, PEPE_TABLE, { duel: "x" }), "foamy");
  assert.equal(r.ok, false, "a broken table is refused whole");
  r = await C.importDropConfig("cd-1", PEPE_TABLE, "foamy");
  assert.equal(r.ok, true);
  assert.deepEqual(r.config, PEPE_TABLE);
  assert.equal(await C.dropLive(), true);
  r = await C.importDropConfig("cd-2", Object.assign({}, PEPE_TABLE, { duel: 0.5 }), "foamy");
  assert.equal(r.already, true);
  assert.equal(r.config.duel, 0.04, "the site keeps its table");
  await C.setDropConfig({ wheel: 0.9 }, 50, {});
  assert.equal((await C.dropConfig(true)).wheel, 0.001, "an old Pepe's push doesn't overwrite it");
});

test("admins edit it while the site owns it: clamped, logged; unknown keys refused", async () => {
  let r = await C.adminSetDrops({ duel: 2, cap: 7.9, event_pool_share: 0.25 }, "admin1");
  assert.equal(r.ok, true);
  assert.deepEqual(r.changed, { duel: 1, cap: 7, event_pool_share: 0.25 });
  r = await C.adminSetDrops({ nope: 1 }, "admin1");
  assert.equal(r.ok, false);
  const v = await C.dropAdminView();
  assert.equal(v.log[0].by, "admin1");
  assert.deepEqual(v.log[0].changed.duel, [0.04, 1]);
  // the site's own rolls (the casino tables, the wheel) read the same table
  const cfg = await C.dropConfig();
  assert.deepEqual([cfg.cap, cfg.min_bj_bet, cfg.blackjack], [7, 3000, 0.03]);
});

test("the way back: the numbers go to Pepe, the site's table stops being THE table, edits refused", async () => {
  const r = await C.releaseDropConfig("cr-1", "foamy");
  assert.equal(r.ok, true);
  assert.equal(r.config.duel, 1);
  assert.equal(await C.dropLive(), false);
  const e = await C.adminSetDrops({ duel: 0.1 }, "admin1");
  assert.equal(e.ok, false);
  await C.setDropConfig({ wheel: 0.003 }, 3, {});
  assert.equal((await C.dropConfig(true)).wheel, 0.003, "Pepe's pushes count again");
});
