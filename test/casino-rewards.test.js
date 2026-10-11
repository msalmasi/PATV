// 1.99mj (the user's D4) + 1.99mw: casino achievements, cosmetic drops, win XP and gang rep for EVERY seat on the site
// (casino/rewards.js) - web-only accounts and Camfrog players alike. Pepe awards nothing for backend hands (the events name
// nobody for him); his counts so far come in as a base, and gang rep goes to him through the bot poll's rep queue.
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
const xp = [];       // achievement XP (achievements.setUpdateLevel)
const winXp = [];    // 1.99mw: win XP (rewards.hooks.updateLevel)

async function fresh() {
  svc.stop();
  svc.S.hooks.shoe = null; svc.S.hooks.deck = null; svc.S.hooks.crash = null;
  svc.S.rate.clear();
  for (const t of ["casino_tables", "casino_events", "casino_rounds", "casino_actions", "transactions", "casino_ach_counts", "casino_reward_done",
                   "casino_pvp_rolls", "user_badges", "achievement_feed", "user_cosmetics", "casino_ach_base", "casino_rep_queue"]) await runQuery(`DELETE FROM ${t}`).catch(() => {});
  xp.length = 0; winXp.length = 0;
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
  rewards.hooks.updateLevel = async (userId, amount) => { winXp.push({ userId, amount }); return null; };
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
  assert.equal((await settleEvent(T.id)).results[0].camfrog, undefined, "the event names nobody for Pepe to award");
});

test("1.99mw: a Camfrog seat at a ROOM table is counted on the site too, and the event names nobody for Pepe to award", async () => {
  await fresh();
  svc.noteRooms([{ id: "PepeLab", name: "Pepe Lab" }]);
  const T1 = await natural(ann, { room: "PepeLab" }, 10000);
  const ev = await settleEvent(T1.id);
  assert.equal(ev.results[0].camfrog, undefined, "no Camfrog name: old and new Pepe both award nothing for it");
  assert.equal(await count("u1", "bj_hands"), 1);
  assert.equal(await count("u1", "bj_naturals"), 1);
  assert.deepEqual(await badges("u1"), ["cf_bj_natural"]);
  assert.equal(await drops("u1", "blackjack"), 1, "a max-bet natural: the full (forced) rate");
  await act(ann, "end", [], { table: T1.id });
  const T2 = await natural(ann, { room: null }, 5000);
  assert.equal((await settleEvent(T2.id)).results[0].camfrog, undefined);
  assert.equal(await count("u1", "bj_hands"), 2, "web table: counted the same way");
});

test("1.99mw: win XP (Pepe's 0.005 rate on the net win) + a gang-rep event for a Camfrog identity; once per round; acked once", async () => {
  await fresh();
  svc.noteRooms([{ id: "PepeLab", name: "Pepe Lab" }]);
  const TA = await natural(ann, { room: "PepeLab" }, 10000);     // natural 3:2: +15,000 net -> 75 XP
  await natural(bob, { room: null }, 10000);
  assert.deepEqual(winXp, [{ userId: "u1", amount: 75 }, { userId: "u2", amount: 75 }]);
  let rep = await rewards.repPending();
  assert.equal(rep.length, 1, "Bob has no Camfrog identity: no gang, nothing queued");
  assert.equal(rep[0].camfrog, "AnnCF");
  assert.equal(rep[0].amount, 75);
  // a re-run of the same win changes nothing
  assert.equal(await rewards.winReward(TA, rep[0].key, "u1", 15000), 0);
  assert.equal(winXp.length, 2);
  assert.equal((await rewards.repPending()).length, 1);
  assert.equal(await rewards.repAck([rep[0].key, rep[0].key, "nope"]), 1);
  assert.equal((await rewards.repPending()).length, 0);
  // a web seat on an account linked to Camfrog: the linked name gets the rep
  const T = { id: "t", players: { u1: { name: "Ann", camfrog: null } } };
  assert.equal(await rewards.winReward(T, "x:1", "u1", 2000), 10);
  rep = await rewards.repPending();
  assert.deepEqual(rep.map((r) => [r.camfrog, r.amount]), [["AnnCF", 10]]);
  // a loss / push earns nothing
  assert.equal(await rewards.winReward(T, "x:2", "u1", 0), 0);
  assert.equal(await rewards.winReward(T, "x:3", "u1", -500), 0);
});

test("1.99mw: Pepe's count so far is a base - thresholds use base + the site's count; a base alone awards nothing", async () => {
  await fresh();
  svc.noteRooms([{ id: "PepeLab", name: "Pepe Lab" }]);
  const r = await act(ann, "start", [], { game: "bj", room: "PepeLab" });
  assert.ok(r.ok, r.reply);
  svc.S.hooks.shoe = () => ["9s", "9h", "Kd", "7d", "8c"].concat(E.makeShoe(6));
  assert.ok((await act(ann, "bet", ["1000"], { table: r.table })).ok);
  const tables = () => Array.from(svc.S.tables.values());
  assert.deepEqual(await rewards.wantBases(tables()), ["AnnCF"], "Ann is seated: the poll asks Pepe for her counts");
  assert.equal(await rewards.setBases([{ camfrog: "anncf", m: { bj_hands: 99, bj_naturals: 0, holdem_pots: 4 } },
                                       { camfrog: "nobody", m: { bj_hands: 5 } }], tables()), 1);
  assert.deepEqual(await rewards.wantBases(tables()), [], "fresh base: not asked again");
  assert.deepEqual(await badges("u1"), [], "a base never awards by itself");
  await act(ann, "deal", [], { table: r.table });
  if (svc.getTable(r.table).eng.phase === "player") await act(ann, "stand", [], { table: r.table });
  assert.equal(await count("u1", "bj_hands"), 1);
  assert.deepEqual(await badges("u1"), ["cf_bj_10", "cf_bj_100"], "99 (Pepe) + 1 (site) = 100 hands (1.99pa: the 10-hand one too)");
  NOW += 2 * 3600 * 1000;
  assert.deepEqual(await rewards.wantBases(tables()), ["AnnCF"], "a stale base is asked for again");
  NOW -= 2 * 3600 * 1000;
});

test("1.99mw: the bot poll carries the rep queue + ach_want out and takes ach_base + rep_ack in", async () => {
  await fresh();
  const routes = require(path.join(repo, "casino", "routes"));
  const handlers = {};
  const app = { locals: {}, get: () => {}, post: (p, ...fns) => { handlers[p] = fns[fns.length - 1]; }, use: () => {} };
  routes.register(app, { isBotToken: (p) => p === "bot-token", addUser: (q, r, n) => n() });
  const call = (body) => new Promise((resolve) => {
    const res = { status() { return this; }, set() { return this; }, json: (j) => resolve(j), send: (t) => resolve({ sent: t }) };
    handlers["/api/casino/bot/poll"]({ body: Object.assign({ password: "bot-token", wait: 0 }, body) }, res);
  });
  svc.noteRooms([{ id: "PepeLab", name: "Pepe Lab" }]);
  await natural(ann, { room: "PepeLab" }, 10000);
  let j = await call({ after: -1, rooms: [{ id: "PepeLab", name: "Pepe Lab" }] });
  assert.equal(j.ok, true, JSON.stringify(j));
  assert.deepEqual(j.rep.map((r) => [r.camfrog, r.amount]), [["AnnCF", 75]]);
  assert.deepEqual(j.ach_want, ["AnnCF"]);
  j = await call({ after: j.cursor, rep_ack: j.rep.map((r) => r.key), ach_base: [{ camfrog: "AnnCF", m: { bj_hands: 3, bj_naturals: 1, holdem_pots: 0 } }] });
  assert.deepEqual(j.rep, []);
  assert.deepEqual(j.ach_want, []);
  assert.equal((await getQuery("SELECT n FROM casino_ach_base WHERE userId = 'u1' AND metric = 'bj_hands'"))[0].n, 3);
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
  assert.deepEqual(await badges("u2"), ["cf_bj_10", "cf_bj_100", "cf_bj_natural"]);
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
  assert.equal(ev.winners[0].camfrog, undefined);
  // 1.99mw: win XP on chips won minus chips put in, once per hand + seat
  assert.deepEqual(winXp, [], "checked-down 25/50 pots net 25-50 chips: under 1 XP at 0.005");
  await rewards.holdemHand(T, 999, { u2: 4000, u3: 100 }, { u2: 2000, u3: 300 });
  await rewards.holdemHand(T, 999, { u2: 4000 }, { u2: 2000 });            // the same hand again: nothing
  assert.deepEqual(winXp, [{ userId: "u2", amount: 10 }], "4,000 won - 2,000 put in -> 10 XP; a net loser gets none");
  assert.equal((await rewards.repPending()).length, 0, "web-only accounts: no Camfrog identity, no gang rep");
});

test("1.99nc: siteCount - market / lotto wins awarded by account (web-only too), once per key; the badge never twice", async () => {
  await fresh();
  await rewards.siteCount("mkt:pepe-payout:1:1", "u2", "market_wins", 1);
  await rewards.siteCount("mkt:pepe-payout:1:1", "u2", "market_wins", 1);          // a retried payout: same key
  await rewards.siteCount("mkt:pepe-payout:2:1", "u2", "market_wins", 1);          // a second win: counted, badge already held
  assert.equal(await count("u2", "market_wins"), 2);
  assert.deepEqual(await badges("u2"), ["cf_market"]);
  assert.deepEqual(await feed("u2"), ["cf_market"], "announced once by Pepe's feed");
  await rewards.siteCount("lotto:9:u2:wins", "u2", "lotto_wins", 2);
  await rewards.siteCount("lotto:9:u2:jackpots", "u2", "lotto_jackpots", 1);
  assert.deepEqual(await badges("u2"), ["cf_lotto_jackpot", "cf_lotto_win", "cf_market"]);
  assert.equal(await rewards.siteCount("x", "u2", "market_wins", 0), null, "nothing to count");
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  assert.ok(/market-win[\s\S]{0,400}siteCount\(`mkt:/.test(src), "the wager payout route awards cf_market");
});

test("drop config: Pepe can push the casino rows and gates (rates + params), clamped", async () => {
  await COS.setDropConfig({ blackjack: 0.05, holdem: 2 }, 3, { min_bj_bet: 1000, min_holdem_pot: 15000, min_level: 3, pair_rolls: 2 });
  const c = await COS.dropConfig();
  assert.deepEqual([c.blackjack, c.holdem, c.min_bj_bet, c.min_holdem_pot, c.min_level, c.pair_rolls, c.cap], [0.05, 1, 1000, 15000, 3, 2, 3]);
});
