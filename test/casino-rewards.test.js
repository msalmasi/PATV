// 1.99mj (the user's D4): casino achievements and cosmetic drops for the players Pepe can't count, on the site
// (casino/rewards.js): web-only accounts, and any seat at a table that isn't in a Camfrog room. No seat is counted twice:
// the events Pepe reads name a seat's Camfrog name only when he counts it.
//   NODE_PATH=G:/PATV/node_modules node --test test/casino-rewards.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "casino-rewards-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const E = require(path.join(repo, "casino", "bjengine"));
let svc, COS, A, rewards, funding;

let NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
let k = 0;
const key = () => `rw-key-${++k}`;
const mk = (uid, name, extra) => Object.assign({ uid, name, username: name.toLowerCase(), camfrog: null, via: "web", iph: null, admin: false }, extra || {});
const ann = mk("u1", "Ann", { camfrog: "AnnCF", via: "room" });     // linked to Camfrog
const bob = mk("u2", "Bob", { iph: "ip-2" });                        // web-only
const eve = mk("u3", "Eve", { iph: "ip-3" });                        // web-only
const act = (who, verb, args, opts) => svc.act(who, verb, args || [], opts || {}, key());
const badges = async (uid) => (await getQuery("SELECT badgeId FROM user_badges WHERE userId = ? ORDER BY badgeId", [uid])).map((r) => r.badgeId);
const count = async (uid, m) => ((await rewards.counts(uid))[m]) || 0;
const drops = async (uid, ev) => (await getQuery("SELECT item_id FROM user_cosmetics WHERE user_id = ? AND source = ?", [uid, "drop:" + ev])).length;
const feed = async (uid) => (await getQuery("SELECT badgeId FROM achievement_feed WHERE userId = ? ORDER BY id", [uid])).map((r) => r.badgeId);
const xp = [];

async function fresh() {
  svc.stop();
  svc.S.hooks.shoe = null; svc.S.hooks.deck = null; svc.S.hooks.crash = null;
  svc.S.rate.clear();
  for (const t of ["casino_tables", "casino_events", "casino_rounds", "casino_actions", "transactions", "casino_ach_counts", "casino_reward_done",
                   "casino_pvp_rolls", "user_badges", "achievement_feed", "user_cosmetics"]) await runQuery(`DELETE FROM ${t}`).catch(() => {});
  await runQuery("UPDATE users SET points_balance = 1000000, level = 0");
  await runQuery("DELETE FROM jackpot_rakes");
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, amount) VALUES ('seed', 'seed', 100000000)");
  await svc.boot({ tick: false });
  await svc.setSetting("bj_enabled", "1", "t");
  await svc.setSetting("hm_enabled", "1", "t");
  await COS.setDropConfig({ blackjack: 1, holdem: 1 }, 50, { min_bj_bet: 2500, min_holdem_pot: 0, min_level: 2, pair_rolls: 3 });
}
// one blackjack round where `who` (alone) is dealt a natural on `bet`
async function natural(who, opts, bet, dealOk = true) {
  const r = await act(who, "start", [], Object.assign({ game: "bj" }, opts));
  assert.ok(r.ok, r.reply);
  svc.S.hooks.shoe = () => ["As", "9h", "Kd", "7d"].concat(E.makeShoe(6));
  assert.ok((await act(who, "bet", [String(bet || 5000)], { table: r.table })).ok);
  assert.equal((await act(who, "deal", [], { table: r.table })).ok, dealOk);
  return svc.getTable(r.table);
}
const settleEvent = async (tid) => JSON.parse((await getQuery("SELECT data FROM casino_events WHERE table_id = ? AND kind = 'settle' ORDER BY seq DESC LIMIT 1", [tid]))[0].data);

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, level INTEGER DEFAULT 0, avatar TEXT,
                  archived_at INTEGER, xp INTEGER DEFAULT 0)`);
  await runQuery(`CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL, points INTEGER NOT NULL,
                  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE user_roles (userId TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (userId, role))");
  await runQuery("CREATE TABLE welcome_bonus (userId TEXT PRIMARY KEY, dup_of TEXT)");
  await runQuery(`CREATE TABLE badges (badgeId TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, icon TEXT,
                  points INTEGER DEFAULT 0, requirement TEXT NOT NULL, createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery(`CREATE TABLE user_badges (userId TEXT NOT NULL, badgeId TEXT NOT NULL, awardedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (userId, badgeId))`);
  for (const [id, u, d, cf] of [["u1", "ann", "Ann", "AnnCF"], ["u2", "bob", "Bob", null], ["u3", "eve", "Eve", null]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, points_balance) VALUES (?, ?, ?, 'x', ?, 1000000)", [id, u, d, cf]);
  }
  svc = require(path.join(repo, "casino", "service"));
  svc.S.hooks.now = () => NOW;
  rewards = require(path.join(repo, "casino", "rewards"));
  rewards.hooks.now = () => NOW;
  COS = require(path.join(repo, "cosmetics"));
  A = require(path.join(repo, "achievements"));
  A.setUpdateLevel(async (userId, amount) => { xp.push({ userId, amount }); return null; });
  funding = require(path.join(repo, "funding"));
  await funding.init();
  await A.ready;
  await COS.ready;
});
test.after(() => svc.stop());

test("a web-only player's natural: hand + natural counted on the site, Natural awarded (XP, feed), a drop rolled; the event names nobody for Pepe", async () => {
  await fresh();
  const T = await natural(bob, { room: null }, 10000);   // the chance scales with bet / max: 10,000 = the full rate
  assert.equal(await count("u2", "bj_hands"), 1);
  assert.equal(await count("u2", "bj_naturals"), 1);
  assert.deepEqual(await badges("u2"), ["cf_bj_natural"]);
  assert.deepEqual(await feed("u2"), ["cf_bj_natural"], "Pepe announces it like any achievement");
  assert.ok(xp.some((x) => x.userId === "u2" && x.amount === 1000));
  assert.equal(await drops("u2", "blackjack"), 1, "a natural on a max bet drops at the full rate (forced to 1 here)");
  assert.ok(T.log.some((l) => /Bob found a cosmetic/.test(l.text)));
  assert.equal((await settleEvent(T.id)).results[0].camfrog, null, "Pepe doesn't count this seat");
});

test("no double counting: a Camfrog-linked seat at a ROOM table is Pepe's (named in the event, nothing on the site); at a web-only table it's the site's", async () => {
  await fresh();
  svc.noteRooms([{ id: "PepeLab", name: "Pepe Lab" }]);
  const T1 = await natural(ann, { room: "PepeLab" }, 5000);
  assert.equal((await settleEvent(T1.id)).results[0].camfrog, "AnnCF");
  assert.equal(await count("u1", "bj_hands"), 0);
  assert.deepEqual(await badges("u1"), []);
  assert.equal(await drops("u1", "blackjack"), 0);
  await act(ann, "end", [], { table: T1.id });
  const T2 = await natural(ann, { room: null }, 5000);
  assert.equal((await settleEvent(T2.id)).results[0].camfrog, null, "a web-only table: Pepe never sees it");
  assert.equal(await count("u1", "bj_hands"), 1);
  assert.deepEqual(await badges("u1"), ["cf_bj_natural"]);
});

test("a small natural doesn't drop; Card Counter at 100 hands; a settlement re-run after a crash counts nothing twice", async () => {
  await fresh();
  await runQuery("INSERT INTO casino_ach_counts (userId, metric, n, updated) VALUES ('u2', 'bj_hands', 99, 0)");
  svc.S.hooks.crash = "settle";                         // dies after the rewards, before the settle event
  const T = await natural(bob, { room: null }, 1000, false);
  svc.S.hooks.crash = null;
  svc.stop();
  await svc.boot({ tick: false });                       // recovery re-runs the settlement
  assert.equal(await count("u2", "bj_hands"), 100);
  assert.equal(await count("u2", "bj_naturals"), 1);
  assert.deepEqual(await badges("u2"), ["cf_bj_100", "cf_bj_natural"]);
  assert.equal(await drops("u2", "blackjack"), 0, "1,000 is under the 2,500 minimum");
  assert.ok(svc.getTable(T.id));
});

test("hold'em: a web-only winner's pots are counted (Pot Odds); showdown drops follow Pepe's gates (level, pairs a day, not uncontested)", async () => {
  await fresh();
  const r = await act(bob, "start", ["25/50"], { room: null, game: "holdem" });
  const tid = r.table;
  await act(bob, "sit", ["2000"], { table: tid });
  await act(eve, "sit", ["2000"], { table: tid });
  const T = svc.getTable(tid);
  const ACES = ["As", "Ah", "Ks", "Kh", "2c", "7d", "9h", "3s", "4c"];
  const deal = async () => { svc.S.hooks.deck = () => ACES.concat(E.makeShoe(1).filter((c) => !ACES.includes(c))); svc.S.rate.clear(); await act(bob, "deal", [], { table: tid }); };
  const showdown = async () => {
    await deal();
    const first = T.eng.actor === "u2" ? bob : eve, second = first === bob ? eve : bob;
    await act(first, "call", [], { table: tid }); await act(second, "check", [], { table: tid });
    for (let i = 0; i < 3; i++) {
      const a = T.eng.actor === "u2" ? bob : eve, b2 = a === bob ? eve : bob;
      await act(a, "check", [], { table: tid }); await act(b2, "check", [], { table: tid });
    }
    assert.equal(T.eng.hand_active, false);
  };
  // the deck gives the first-dealt seat (Bob) the aces
  await showdown();
  assert.equal(await count("u2", "holdem_pots"), 1);
  assert.deepEqual(await badges("u2"), ["cf_holdem_pot"]);
  assert.equal(await drops("u2", "holdem"), 0, "level 0 players: no PvP drop");
  await runQuery("UPDATE users SET level = 5");
  await COS.setDropConfig({}, 50, { pair_rolls: 1 });
  await showdown();
  const after2 = await drops("u2", "holdem") + await drops("u3", "holdem");
  assert.equal(after2, 1, "level 2+: the winner's pot drops");
  await showdown();
  assert.equal(await drops("u2", "holdem") + await drops("u3", "holdem"), 1, "one roll per pair a day (pair_rolls 1)");
  // an uncontested pot counts but never drops
  await deal();
  const first = T.eng.actor === "u2" ? bob : eve;
  await act(first, "fold", [], { table: tid });
  const winner = first === bob ? "u3" : "u2";
  assert.ok(await count(winner, "holdem_pots") >= 1);
  const ev = JSON.parse((await getQuery("SELECT data FROM casino_events WHERE table_id = ? AND kind = 'win' ORDER BY seq DESC LIMIT 1", [tid]))[0].data);
  assert.equal(ev.winners[0].camfrog, null);
});

test("drop config: Pepe can push the casino rows and gates (rates + params), clamped", async () => {
  await COS.setDropConfig({ blackjack: 0.05, holdem: 2 }, 3, { min_bj_bet: 1000, min_holdem_pot: 15000, min_level: 3, pair_rolls: 2 });
  const c = await COS.dropConfig();
  assert.deepEqual([c.blackjack, c.holdem, c.min_bj_bet, c.min_holdem_pot, c.min_level, c.pair_rolls, c.cap], [0.05, 1, 1000, 15000, 3, 2, 3]);
});
