// Offline tests for economy v2 phase E-2 on the site (camfrog-bot docs/ECONOMY-V2.md 6.5 / 11.5 / 12):
//   * funding.sync: the incentive budget is "live" only while Pepe reports it (every sync resets it);
//     grant flows map to it only then
//   * grants paid from the budget are "incentives:<flow>" claims, within the group's weekly budget AND the
//     budget's balance (minus what's paid but not yet settled by Pepe)
//   * over budget a grant is QUEUED (not credited, invisible to Pepe), FIFO per group; the drain pays it once
//     a sync shows room, exactly once (deterministic transaction id), with crash recovery; a gone account is dropped
//   * the Reserve's own cover ignores the budget's claims
//   * conservation on the site side: wallet credits == the incentive claims Pepe settles; queued = nothing moved yet
//   * /economy explains the budget only while it's live ("coming soon" otherwise)
//   NODE_PATH=G:/PATV/node_modules node --test test/econ-treasury.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "econ-treasury-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const F = require(path.join(repo, "funding"));

let n = 0;
async function mkUser(bal = 0) {
  const id = "u" + (++n);
  await runQuery(`INSERT INTO users (userId, username, displayname, password, points_balance, class) VALUES (?, ?, ?, 'x', ?, 'pleb')`,
                 [id, "user" + n, "User " + n, bal]);
  return id;
}
const bal = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;
const wallets = async () => (await getQuery("SELECT COALESCE(SUM(points_balance), 0) AS w FROM users"))[0].w;
const GROUPS = { new_account: "welcome", levelup: "levelup", achievements: "achievements",
                 connect_bonus: "misc", redeem_codes: "misc", platform_rewards: "misc" };
const FLOWS = Object.fromEntries(Object.keys(GROUPS).map((f) => [f, "incentives"]));
function live(balance, remaining) {
  F.sync({ reserve: 5000000, flows: FLOWS, fortknox: 0,
           incentives: { balance, week: "W2026-10-05", remaining, budgets: { welcome: 1500000, levelup: 1400000, achievements: 2100000, misc: 350000 },
                         groups: GROUPS, share: 700000, release_per_day: 100000 } });
}
// Pepe's side of a funding tick: settle every paid claim against his incentive budget
let pepeBudget = 0;
async function pepeSettle() {
  const cs = await F.claims();
  for (const c of cs) if (c.flow.startsWith("incentives:")) pepeBudget -= c.amount;
  await F.settle(cs.map((c) => c.claimId));
  return cs;
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  await F.claims();                                    // wait for the table + E-2 columns
});

test("sync: the budget is live only while Pepe reports it; grant flows follow it", async () => {
  assert.equal(F.treasuryLive(), false, "never synced: not live");
  live(100000, { welcome: 100000, levelup: 100000, achievements: 100000, misc: 100000 });
  assert.equal(F.treasuryLive(), true);
  assert.equal(F.vaultFor("levelup"), "incentives");
  assert.equal(F.vaultFor("room_owner"), "reserve", "not a grant: stays on the Reserve");
  F.sync({ reserve: 5000000, flows: FLOWS });         // an older Pepe / treasury off: no key
  assert.equal(F.treasuryLive(), false);
  assert.equal(F.vaultFor("levelup"), "reserve", "flow says incentives but the budget isn't live: Reserve, as before");
  F.sync({ reserve: 5000000, flows: FLOWS, incentives: { balance: "lots" } });
  assert.equal(F.treasuryLive(), false, "a malformed budget is ignored");
});

test("grants pay from the budget as incentives:<flow> claims, within the group budget and the balance", async () => {
  live(100000, { welcome: 60000, levelup: 30000, achievements: 100000, misc: 100000 });
  const a = await mkUser(), b = await mkUser();
  assert.equal(await F.fundPayout(a, 25000, "levelup", "Level-up reward (Lv 2)"), true);
  assert.equal(await bal(a), 25000);
  const cs = await F.claims();
  assert.deepEqual(cs.map((c) => [c.flow, c.amount]), [["incentives:levelup", 25000]]);
  // the level-up group has 30k this week, 25k of it is paid but unsettled -> 5k left
  assert.equal(await F.canFund("levelup", 6000), false, "group budget minus unsettled");
  assert.equal(await F.canFund("levelup", 5000), true);
  // the balance: 100k minus 25k unsettled = 75k, the welcome group has 60k
  assert.equal(await F.canFund("new_account", 60000), true);
  assert.equal(await F.canFund("new_account", 60001), false);
  assert.equal(await F.fundPayout(b, 50000, "new_account", "Welcome PAT"), true);
  assert.equal(await F.canFund("achievements", 25001), false, "balance 100k - 75k unsettled = 25k");
  await pepeSettle();
  assert.equal((await F.claims()).length, 0);
});

test("the Reserve's cover ignores the budget's claims", async () => {
  live(1000000, { welcome: 1000000, levelup: 1000000, achievements: 1000000, misc: 1000000 });
  const u = await mkUser();
  await F.fundPayout(u, 900000, "achievements", "Achievement: big");
  F.state.flows.room_owner = "reserve";
  assert.equal(await F.canFund("room_owner", 5000000), true, "an unsettled incentives claim doesn't eat the Reserve");
  await pepeSettle();
});

test("over budget a grant is QUEUED (not credited, not visible to Pepe), FIFO per group, then paid once", async () => {
  live(40000, { welcome: 1500000, levelup: 30000, achievements: 2100000, misc: 350000 });
  const a = await mkUser(), b = await mkUser(), c = await mkUser();
  const w0 = await wallets();
  assert.equal(await F.fundPayout(a, 25000, "levelup", "Level-up reward (Lv 3)"), true);
  assert.equal(await F.fundPayout(b, 25000, "levelup", "Level-up reward (Lv 4)"), "queued", "group budget gone: queued");
  assert.equal(await bal(b), 0, "a queued grant isn't credited");
  assert.equal(await F.fundPayout(c, 1000, "levelup", "Level-up reward (Lv 5)"), "queued", "FIFO: nobody jumps the queue");
  assert.equal(await F.fundPayout(c, 10000, "achievements", "Achievement: x"), true, "another group isn't blocked");
  const r = await F.fundPayoutEx(c, 500000, "achievements", "Achievement: huge");
  assert.deepEqual([r.ok, r.queued], [true, true], "the balance can't cover it: queued too");
  assert.deepEqual((await F.claims()).map((x) => x.amount).sort(), [10000, 25000], "Pepe only sees paid claims");
  assert.equal(await wallets(), w0 + 35000);
  const credited = await pepeSettle();
  assert.equal(credited.reduce((t, x) => t + x.amount, 0), 35000, "CONSERVATION: credits == what Pepe settles");
  // a new week: budgets reset, Pepe's balance refilled
  live(600000, { welcome: 1500000, levelup: 1400000, achievements: 2100000, misc: 350000 });
  await F.drainQueue();
  assert.equal(await bal(b), 25000, "queued level-up paid");
  assert.equal(await bal(c), 10000 + 1000 + 500000, "queued in order: then the next");
  await F.drainQueue();
  assert.equal(await bal(b), 25000, "drained twice: paid once");
  const tx = await getQuery("SELECT COUNT(*) AS n FROM transactions WHERE transactionId LIKE 'iq-%'");
  assert.equal(tx[0].n, 3, "one deterministic transaction per queued grant");
  const s = await pepeSettle();
  assert.equal(s.reduce((t, x) => t + x.amount, 0), 526000, "CONSERVATION: the queue's credits reach Pepe as claims");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM reserve_claims WHERE queued = 1"))[0].n, 0);
});

test("the queue stops at a group's head it can't cover (strict FIFO) and honours the balance", async () => {
  live(0, { welcome: 1500000, levelup: 1400000, achievements: 2100000, misc: 350000 });
  const a = await mkUser(), b = await mkUser();
  assert.equal(await F.fundPayout(a, 300000, "new_account", "Welcome PAT"), "queued");
  assert.equal(await F.fundPayout(b, 50000, "new_account", "Welcome PAT"), "queued");
  live(100000, { welcome: 1500000, levelup: 1400000, achievements: 2100000, misc: 350000 });
  await F.drainQueue();
  assert.equal(await bal(a), 0, "the head doesn't fit the balance");
  assert.equal(await bal(b), 0, "and the one behind it waits (FIFO), even though it would fit");
  live(400000, { welcome: 1500000, levelup: 1400000, achievements: 2100000, misc: 350000 });
  await F.drainQueue();
  assert.equal(await bal(a), 300000);
  assert.equal(await bal(b), 50000);
  await pepeSettle();
});

test("crash mid-pay is recovered, never paid twice; a gone account is dropped", async () => {
  live(0, { welcome: 1500000, levelup: 1400000, achievements: 2100000, misc: 350000 });
  const a = await mkUser(), b = await mkUser(), gone = await mkUser();
  await F.fundPayout(a, 1000, "achievements", "Achievement: a");
  await F.fundPayout(b, 2000, "achievements", "Achievement: b");
  await F.fundPayout(gone, 3000, "achievements", "Achievement: c");
  const q = await getQuery("SELECT claimId, userId FROM reserve_claims WHERE queued = 1 ORDER BY created, rowid");
  // a: paid, then the process died before the claim was flipped back to 0
  await runQuery("UPDATE reserve_claims SET queued = 2 WHERE claimId = ?", [q[0].claimId]);
  await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, 'Achievement: a', 1000)", ["iq-" + q[0].claimId, a]);
  await runQuery("UPDATE users SET points_balance = points_balance + 1000 WHERE userId = ?", [a]);
  // b: claimed for paying, then died before the credit
  await runQuery("UPDATE reserve_claims SET queued = 2 WHERE claimId = ?", [q[1].claimId]);
  await runQuery("DELETE FROM users WHERE userId = ?", [gone]);
  live(100000, { welcome: 1500000, levelup: 1400000, achievements: 2100000, misc: 350000 });
  await F.drainQueue();
  assert.equal(await bal(a), 1000, "a: recovered as paid, not paid again");
  assert.equal(await bal(b), 2000, "b: recovered as waiting, then paid");
  const st = await getQuery("SELECT queued FROM reserve_claims WHERE claimId = ?", [q[2].claimId]);
  assert.equal(st[0].queued, 9, "the gone account's grant is dropped, never reaches Pepe");
  const s = await pepeSettle();
  assert.deepEqual(s.map((x) => x.amount).sort((x, y) => x - y), [1000, 2000]);
});

test("queueSummary lists groups and the oldest waiting grants", async () => {
  live(0, { welcome: 1500000, levelup: 1400000, achievements: 2100000, misc: 350000 });
  const a = await mkUser();
  await F.fundPayout(a, 25000, "levelup", "Level-up reward (Lv 9)");
  const s = await F.queueSummary();
  assert.equal(s.live, true);
  assert.equal(s.groups.levelup.n, 1);
  assert.equal(s.groups.levelup.t, 25000);
  assert.equal(s.items[0].type, "Level-up reward (Lv 9)");
});

test("treasury off: grants go back to the Reserve (skip when short), the queue waits", async () => {
  F.sync({ reserve: 0, flows: FLOWS });
  const a = await mkUser();
  assert.equal(await F.fundPayout(a, 1000, "levelup", "Level-up"), false, "Reserve 0: skipped as in v1, not queued");
  const before = (await getQuery("SELECT COUNT(*) AS n FROM reserve_claims WHERE queued = 1"))[0].n;
  await F.drainQueue();
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM reserve_claims WHERE queued = 1"))[0].n, before, "nothing drains while off");
});

test("/economy explains the budget only while it's live", async () => {
  const ejs = require("ejs");
  const view = path.join(repo, "views", "economy.ejs");
  const opts = { views: [path.join(repo, "views")] };
  const off = await ejs.renderFile(view, { user: null, treasury: null, ogBase: "http://t" }, opts);
  assert.match(off, /Coming soon/);
  assert.doesNotMatch(off, /📅 The weekly settlement/);
  live(1234567, { welcome: 1500000, levelup: 1400000, achievements: 2100000, misc: 350000 });
  const on = await ejs.renderFile(view, { user: null, treasury: F.state.incentives, ogBase: "http://t" }, opts);
  assert.match(on, /📅 The weekly settlement/);
  assert.match(on, /1,234,567 PAT/);
  assert.doesNotMatch(on, /Coming soon/);
});
