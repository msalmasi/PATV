// 1.99oy: the card-table achievements on the site's casino tables (casino/rewards.js + casino/achhands.js), played through the
// real service: a doubled win, Five-Card Charlie, win / dealer-bust streaks, a royal flush + a knock-out at a showdown,
// hands played, each counted once (a settlement re-run counts nothing twice), and the quiet backfill of the new thresholds on
// counts the site already had (cf_bj_10 for 15 old hands: badge only, before any new hand could announce it).
//   node --test test/casino-ach-hands.test.js      (temp DB; node_modules = G:/PATV/node_modules)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "casino-ach-hands-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const E = require(path.join(repo, "casino", "bjengine"));
let svc, COS, A, rewards, funding;

let NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
let k = 0;
const key = () => `ah-key-${++k}`;
const mk = (uid, name, extra) => Object.assign({ uid, name, username: name.toLowerCase(), camfrog: null, via: "web", iph: null, admin: false }, extra || {});
const bob = mk("u2", "Bob", { iph: "ip-2" });
const eve = mk("u3", "Eve", { iph: "ip-3" });
const act = (who, verb, args, opts) => svc.act(who, verb, args || [], opts || {}, key());
const badges = async (uid) => (await getQuery("SELECT badgeId FROM user_badges WHERE userId = ? ORDER BY badgeId", [uid])).map((r) => r.badgeId);
const feed = async (uid) => (await getQuery("SELECT badgeId FROM achievement_feed WHERE userId = ? ORDER BY id", [uid])).map((r) => r.badgeId);
const count = async (uid, m) => ((await rewards.counts(uid))[m]) || 0;

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, level INTEGER DEFAULT 0, avatar TEXT,
                  archived_at INTEGER, xp INTEGER DEFAULT 0)`);
  await runQuery(`CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL, points INTEGER NOT NULL,
                  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, amount) VALUES ('seed', 'seed', 100000000)");
  await runQuery("CREATE TABLE user_roles (userId TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (userId, role))");
  await runQuery("CREATE TABLE welcome_bonus (userId TEXT PRIMARY KEY, dup_of TEXT)");
  await runQuery(`CREATE TABLE badges (badgeId TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, icon TEXT,
                  points INTEGER DEFAULT 0, requirement TEXT NOT NULL, createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery(`CREATE TABLE user_badges (userId TEXT NOT NULL, badgeId TEXT NOT NULL, awardedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (userId, badgeId))`);
  for (const [id, u, d] of [["u1", "old", "Old"], ["u2", "bob", "Bob"], ["u3", "eve", "Eve"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, points_balance) VALUES (?, ?, ?, 'x', 10000000)", [id, u, d]);
  }
  svc = require(path.join(repo, "casino", "service"));
  svc.S.hooks.now = () => NOW;
  rewards = require(path.join(repo, "casino", "rewards"));
  rewards.hooks.now = () => NOW;
  rewards.hooks.updateLevel = async () => null;
  COS = require(path.join(repo, "cosmetics"));
  A = require(path.join(repo, "achievements"));
  A.setUpdateLevel(async () => null);
  funding = require(path.join(repo, "funding"));
  await funding.init();
  await A.ready;
  await COS.ready;
  // history from before 1.99oy: 15 site-counted blackjack hands for "old" (and Pepe's base of 0)
  await rewards.ensure();
  await runQuery("INSERT INTO casino_ach_counts (userId, metric, n, updated) VALUES ('u1', 'bj_hands', 15, 1)");
  await svc.boot({ tick: false });
  await svc.setSetting("bj_enabled", "1", "t");
  await svc.setSetting("hm_enabled", "1", "t");
  await COS.setDropConfig({ blackjack: 0, holdem: 0 }, 50, { min_bj_bet: 2500, min_holdem_pot: 0, min_level: 2, pair_rolls: 3 });
});
test.after(() => svc.stop());

test("the quiet backfill runs before any new hand: 15 old hands -> Pull Up a Chair as a badge only (no announcement)", async () => {
  const r = await rewards.quietBackfill();
  assert.equal(r.given, 1);
  assert.deepEqual(await badges("u1"), ["cf_bj_10"]);
  assert.deepEqual(await feed("u1"), []);
  assert.equal((await rewards.quietBackfill()).given, 1, "once");
});

test("blackjack: a double-down win, Five-Card Charlie, and the win + dealer-bust streaks", async () => {
  const r = await act(bob, "start", [], { game: "bj", room: null });
  assert.ok(r.ok, r.reply);
  const tid = r.table;
  const T = svc.getTable(tid);
  const round = async (shoe, moves) => {
    svc.S.hooks.shoe = () => shoe.concat(E.makeShoe(6));
    svc.S.rate.clear();
    const b = await act(bob, "bet", ["1000"], { table: tid });
    assert.ok(b.ok, b.reply);
    const d = await act(bob, "deal", [], { table: tid });
    assert.ok(d.ok, "deal: " + d.reply + " " + T.eng.phase);
    for (const m of moves) if (T.eng.phase === "player") await act(bob, m, [], { table: tid });
    if (T.eng.phase === "player") await act(bob, "stand", [], { table: tid });
    assert.ok(["done", "betting"].includes(T.eng.phase), "round settled: " + T.eng.phase);
  };
  // 5+6 = 11, double -> K = 21; dealer 9+7 = 16 draws K: bust
  await round(["5s", "9h", "6d", "7d", "Kc", "Ks"], ["double"]);
  assert.equal(await count("u2", "bj_double_wins"), 1);
  assert.ok((await feed("u2")).includes("cf_bj_double"));
  // 2+3+2+3+4 = 14 on five cards; dealer 16 draws K: bust -> Five-Card Charlie
  await round(["2s", "9h", "3d", "7d", "2h", "3c", "4s", "Ks"], ["hit", "hit", "hit"]);
  assert.ok((await feed("u2")).includes("cf_bj_charlie"));
  for (let i = 0; i < 3; i++) await round(["Ts", "9h", "9d", "7d", "Ks"], []);     // 19 vs a busting dealer
  const f = await feed("u2");
  assert.ok(f.includes("cf_bj_streak_5"), "5 rounds won in a row: " + f.join(","));
  assert.ok(f.includes("cf_bj_dealer_bust"), "the dealer busted 5 rounds in a row");
  assert.equal(await count("u2", "bj_streak_run"), 5);
  // a loss breaks the win streak (and the dealer-bust run)
  await round(["Ts", "9h", "6d", "Td", "Ks"], ["hit"]);
  assert.equal(await count("u2", "bj_streak_run"), 0);
  assert.equal(await count("u2", "bj_dbust_run"), 0);
  // a settlement re-run counts nothing twice
  await act(bob, "end", [], { table: tid });
  const TR = { id: "rerun", players: {}, eng: { results: { dealer: { bust: true } } } };
  const res = [{ key: "u3", hands: [{ cards: ["2s", "3d", "2h", "3c", "4s"], outcome: "win", bet: 200, doubled: true }], total_bet: 200, total_payout: 400 }];
  await rewards.blackjackRound(TR, 1, res, 10000);
  const once = JSON.stringify(await rewards.counts("u3"));
  assert.match(once, /"bj_charlies":1/);
  await rewards.blackjackRound(TR, 1, res, 10000);
  assert.equal(JSON.stringify(await rewards.counts("u3")), once);
});

test("hold'em: a royal flush (the hole cards make it) that busts the other player -> Royal Flush, Straight Flush, Double Up, Knockout; hands counted", async () => {
  const r = await act(bob, "start", ["25/50"], { room: null, game: "holdem" });
  const tid = r.table;
  await act(bob, "sit", ["2000"], { table: tid });
  await act(eve, "sit", ["2000"], { table: tid });
  const T = svc.getTable(tid);
  // Bob: Ah Kh, Eve: Qs Qd; board Qh Jh Th 2c 3d -> Bob's royal flush against Eve's trips
  const DECK = ["Ah", "Kh", "Qs", "Qd", "Qh", "Jh", "Th", "2c", "3d"];
  svc.S.hooks.deck = () => DECK.concat(E.makeShoe(1).filter((c) => !DECK.includes(c)));
  svc.S.rate.clear();
  await act(bob, "deal", [], { table: tid });
  const first = T.eng.actor === "u2" ? bob : eve, second = first === bob ? eve : bob;
  await act(first, "allin", [], { table: tid });
  await act(second, "call", [], { table: tid });
  assert.equal(T.eng.hand_active, false);
  const f = await feed("u2");
  for (const id of ["cf_holdem_royal", "cf_holdem_sflush", "cf_holdem_allin", "cf_holdem_bust"]) assert.ok(f.includes(id), id + " in " + f.join(","));
  assert.ok(!(await feed("u3")).includes("cf_holdem_badbeat"), "trips that lost to a made royal flush on the turn isn't a bad beat");
  assert.equal(await count("u2", "holdem_hands"), 1);
  assert.equal(await count("u3", "holdem_hands"), 1);
  // the same showdown again (a re-render) counts nothing twice
  const before = JSON.stringify(await rewards.counts("u2"));
  await rewards.holdemShowdown(T, T.eng.hand_no, { board: DECK.slice(4), shown: [{ cards: ["Ah", "Kh"] }, { cards: ["Qs", "Qd"] }], cf: [{ uid: "u2" }, { uid: "u3" }] },
                               [{ who: "u2", amount: 4000, pot: "main pot" }]);
  assert.equal(JSON.stringify(await rewards.counts("u2")), before);
});

test("a knock-out of your own alt doesn't count", async () => {
  await runQuery("INSERT OR REPLACE INTO welcome_bonus (userId, dup_of) VALUES ('u3', 'u2')");
  const T = { id: "alt-t", eng: { chips: { u2: 4000, u3: 0 } }, high_stakes: false };
  await rewards.holdemShowdown(T, 1, { board: ["2c", "7d", "9h", "3s", "4c"], shown: [{ cards: ["As", "Ad"] }, { cards: ["Ks", "Kd"] }], cf: [{ uid: "u2" }, { uid: "u3" }] },
                               [{ who: "u2", amount: 4000, pot: "main pot" }]);
  assert.equal(await count("u2", "hm_busts"), 1, "still only the real knock-out from before");
});
