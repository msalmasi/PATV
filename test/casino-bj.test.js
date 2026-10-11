// 1.99lj: the casino backend's blackjack (casino/*.js, docs/casino-backend.md):
//   * engine parity with Pepe's Python engine (500 recorded rounds: every event and result identical),
//   * provably fair shoes (commit / reveal, deterministic, a full 6-deck shoe),
//   * the service on a temp DB: payouts, 3:2, splits / doubles / insurance money, the House rows, timers, AFK,
//     idempotent actions, restart mid-hand, a crash mid-settle, an interrupted stake, Fed flash when the House is
//     short, the cover rule, refunds on leave, linked accounts, High Roller, casino ban,
//   * the HTTP API: web acts (JSON + fetch only), Pepe's poll / act, pushing a table to a room, Telegram refused.
//   NODE_PATH=G:/PATV/node_modules node --test test/casino-bj.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "casino-bj-test-"));
process.chdir(tmp);
delete process.env.STAGING;
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const E = require(path.join(repo, "casino", "bjengine"));
const fair = require(path.join(repo, "casino", "fair"));
const svc = require(path.join(repo, "casino", "service"));
const funding = require(path.join(repo, "funding"));

let NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
svc.S.hooks.now = () => NOW;
const later = async (secs) => { NOW += secs * 1000; await svc.tickOnce(); };
let k = 0;
const key = () => `test-key-${++k}`;
const ann = { uid: "u1", name: "Ann", username: "ann", camfrog: "AnnCF", via: "room", iph: null, admin: false };
const bob = { uid: "u2", name: "Bob", username: "bob", camfrog: null, via: "web", iph: "ip-b", admin: false };
const cat = { uid: "u3", name: "Cat", username: "cat", camfrog: null, via: "web", iph: "ip-b", admin: false };
const dan = { uid: "u4", name: "Dan", username: "dan", camfrog: null, via: "web", iph: null, admin: false };
const A = (who, verb, args, opts) => svc.act(who, verb, args || [], opts || {}, key());
const bal = async (uid) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [uid]))[0].b;
const house = async () => (await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM jackpot_rakes"))[0].t;
const setBal = (uid, b) => runQuery("UPDATE users SET points_balance = ? WHERE userId = ?", [b, uid]);
const setHouse = async (amt) => { await runQuery("DELETE FROM jackpot_rakes"); await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, amount) VALUES ('seed', 'seed', ?)", [amt]); };
// the next round's shoe starts with these cards (1 player: p, dealer up, p, dealer hole, then draws)
const shoe = (prefix) => { svc.S.hooks.shoe = () => prefix.concat(E.makeShoe(6)); };

async function fresh() {
  svc.stop();
  svc.S.hooks.shoe = null;
  svc.S.hooks.crash = null;
  svc.S.rate.clear();
  for (const t of ["casino_tables", "casino_events", "casino_rounds", "casino_actions", "transactions", "reserve_claims"]) {
    await runQuery(`DELETE FROM ${t}`).catch(() => {});
  }
  for (const u of ["u1", "u2", "u3", "u4"]) await setBal(u, 100000);
  await setHouse(10000000);
  await runQuery("DELETE FROM user_roles");
  await runQuery("DELETE FROM welcome_bonus");
  await runQuery("UPDATE users SET casino_banned = 0");
  funding.sync({});
  await svc.boot({ tick: false });
  await svc.setSetting("bj_enabled", "1", "test");
}
async function openWith(who) {
  const r = await A(who, "start", [], { room: null });
  assert.ok(r.ok, r.reply);
  return r.table;
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, level INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery(`CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL, points INTEGER NOT NULL,
                  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE user_roles (userId TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (userId, role))");
  await runQuery("CREATE TABLE welcome_bonus (userId TEXT PRIMARY KEY, dup_of TEXT)");
  for (const [id, u, d, cf] of [["u1", "ann", "Ann", "AnnCF"], ["u2", "bob", "Bob", null], ["u3", "cat", "Cat", null], ["u4", "dan", "Dan", null]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, points_balance) VALUES (?, ?, ?, 'x', ?, 100000)", [id, u, d, cf]);
  }
  await funding.init();
});
test.after(() => svc.stop());

// ── engine ──
test("engine parity: 500 rounds recorded from Pepe's Python engine replay identically (events + results)", () => {
  const vectors = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures", "casino-bj-vectors.json.gz"))).toString("utf8"));
  assert.equal(vectors.length, 500);
  let splits = 0, ins = 0;
  for (const [i, v] of vectors.entries()) {
    const t = E.newTable({ numDecks: 6, minBet: 100, maxBet: 10000, hitSoft17: true });
    E.openBetting(t);
    for (const [kk, name, amt] of v.bets) E.placeBet(t, kk, name, amt);
    let events = E.startRound(t, v.shoe, null);
    if (t.phase === "insurance") {
      for (const kk of v.insured) { E.takeInsurance(t, kk); ins++; }
      events = events.concat(E.finishInsurance(t));
    }
    for (const [kk, a] of v.actions) {
      assert.equal(E.currentHand(t).key, kk, `vector ${i}`);
      if (a === "split") splits++;
      events = events.concat(E.act(t, kk, a));
    }
    assert.deepEqual(events, v.events, `vector ${i}: events`);
    assert.deepEqual(t.results, v.results, `vector ${i}: results`);
  }
  assert.ok(splits > 50 && ins > 50, "the vectors exercise splits and insurance");
});

test("engine rules: H17, 3:2 rounding, split aces, peek", () => {
  const t = E.newTable();
  t.dealer = ["As", "6d"];
  assert.deepEqual(E.handValue(t.dealer), [17, true]);
  assert.equal(E.roundHalfEven(832.5), 832);       // Python's round(): a 333 natural pays 832
  assert.equal(E.roundHalfEven(837.5), 838);
  E.openBetting(t);
  E.placeBet(t, "a", "A", 100);
  E.startRound(t, ["As", "9h", "Ad", "7c", "Kh", "Qh"].concat(E.makeShoe(1)));
  E.act(t, "a", "split");                           // aces: one card each, done, dealer plays
  assert.equal(t.phase, "done");
  assert.equal(t.hands.length, 2);
  assert.ok(t.hands.every((h) => h.split_aces && h.cards.length === 2));
  assert.throws(() => E.placeBet(E.newTable(), "x", "X", 50), E.BJError);
});

test("fairness: commitment, deterministic HMAC shuffle of a full 6-deck shoe, verify catches a tamper", () => {
  const seed = fair.newServerSeed();
  const c = fair.commitment(seed);
  assert.match(c, /^[0-9a-f]{64}$/);
  const s1 = fair.shuffleShoe(6, seed, "abc", 7);
  const s2 = fair.shuffleShoe(6, seed, "abc", 7);
  assert.deepEqual(s1, s2);
  assert.notDeepEqual(s1, fair.shuffleShoe(6, seed, "abc", 8));
  assert.equal(s1.length, 312);
  const counts = {};
  for (const x of s1) counts[x] = (counts[x] || 0) + 1;
  assert.equal(Object.keys(counts).length, 52);
  assert.ok(Object.values(counts).every((n) => n === 6));
  assert.ok(fair.verify({ commitment: c, server_seed: seed, client_seed: "abc", round: 7, num_decks: 6, shoe: s1 }).ok);
  const bad = s1.slice(); [bad[0], bad[1]] = [bad[1], bad[0]];
  assert.equal(fair.verify({ commitment: c, server_seed: seed, client_seed: "abc", round: 7, num_decks: 6, shoe: bad }).ok, false);
  assert.equal(fair.verify({ commitment: "00", server_seed: seed, client_seed: "abc", round: 7, num_decks: 6 }).ok, false);
});

// ── the service ──
test("a round: bet, deal, a win paid 2x out of the House; the seed is committed before bets and revealed after", async () => {
  await fresh();
  const tid = await openWith(ann);
  const T = svc.getTable(tid);
  const commit = T.round.commitment;
  shoe(["Ts", "9h", "Qd", "7d", "Kc"]);               // Ann 20; Pepe 9+7, hits K = bust
  assert.ok((await A(ann, "bet", ["1000"], { table: tid })).ok);
  assert.equal(await bal("u1"), 99000);
  assert.ok((await A(ann, "deal", [], { table: tid })).ok);
  assert.equal(T.eng.phase, "player");
  const r = await A(ann, "stand", [], { table: tid });
  assert.ok(r.ok, r.reply);
  assert.equal(await bal("u1"), 101000);
  assert.equal(await house(), 10000000 - 1000);
  assert.equal(T.eng.phase, "betting");               // straight into round 2's betting window
  assert.notEqual(T.round.commitment, commit);
  const rec = await svc.fairRecord(tid, 1);
  assert.equal(rec.commitment, commit);
  assert.equal(fair.commitment(rec.server_seed), commit);
  const txs = await getQuery("SELECT transactionId, points FROM transactions WHERE userId = 'u1' ORDER BY rowid");
  assert.deepEqual(txs.map((x) => x.points), [-1000, 2000]);
  assert.match(txs[1].transactionId, /^cbj:[0-9a-f]{10}:r1:u1:pay$/);
});

test("a natural pays 3:2 (a 333 bet gets 832, as in Pepe's engine)", async () => {
  await fresh();
  const tid = await openWith(ann);
  shoe(["As", "9h", "Kd", "7d"]);
  await A(ann, "bet", ["333"], { table: tid });
  await A(ann, "deal", [], { table: tid });            // natural: settled at the deal
  assert.equal(await bal("u1"), 100000 - 333 + 832);
  assert.equal(await house(), 10000000 - (832 - 333));
});

test("split + double + push / lose: every stake charged by key, the House gets only the lost stakes", async () => {
  await fresh();
  const tid = await openWith(ann);
  shoe(["8s", "9h", "8d", "7c", "3h", "2c", "Th", "5d"]);
  await A(ann, "bet", ["1000"], { table: tid });
  await A(ann, "deal", [], { table: tid });
  assert.ok((await A(ann, "split", [], { table: tid })).ok);
  assert.equal(await bal("u1"), 98000);
  assert.ok((await A(ann, "double", [], { table: tid })).ok);   // 8+3 = 11, doubles to 21
  assert.equal(await bal("u1"), 97000);
  await A(ann, "stand", [], { table: tid });                    // 8+2 = 10; Pepe 16 + 5 = 21
  // hand 1: 21 vs 21 push (2000 back); hand 2: 10 loses 1000
  assert.equal(await bal("u1"), 99000);
  assert.equal(await house(), 10000000 + 1000);
  const keys = (await getQuery("SELECT transactionId FROM transactions WHERE userId = 'u1'")).map((x) => x.transactionId.replace(/:\d+$/, ""));
  assert.ok(keys.some((x) => /:r1:u1:spl0$/.test(x)) && keys.some((x) => /:r1:u1:dbl0$/.test(x)));
});

test("insurance: half the bet, pays 2:1 when Pepe has blackjack (net 0 for a fully insured loss)", async () => {
  await fresh();
  const tid = await openWith(ann);
  shoe(["Ts", "Ah", "Qd", "Kc"]);
  await A(ann, "bet", ["1000"], { table: tid });
  await A(ann, "deal", [], { table: tid });
  assert.equal(svc.getTable(tid).eng.phase, "insurance");
  assert.ok((await A(ann, "insurance", [], { table: tid })).ok);
  assert.equal(await bal("u1"), 98500);
  await later(19);                                    // the insurance window closes; Pepe peeks: blackjack
  assert.equal(await bal("u1"), 100000);
  assert.equal(await house(), 10000000);
});

test("timers: a decision that runs out stands; 3 in a row = AFK, off the table after the hand; empty windows close the table", async () => {
  await fresh();
  const tid = await openWith(ann);
  const T = svc.getTable(tid);
  shoe(["Ts", "9h", "7d", "8c", "2c", "2d"]);           // Ann 17 vs Pepe 17: she waits, times out
  for (let round = 1; round <= 3; round++) {
    if (round === 1) {
      await A(ann, "bet", ["100"], { table: tid });     // a manual bet proves she's there (resets the strikes)...
      await A(ann, "autobet", [], { table: tid });      // ...autobet doesn't
      await A(ann, "deal", [], { table: tid });
    } else {
      await later(11);                                  // the window ends: her autobet goes in, the cards go out
    }
    assert.equal(T.eng.phase, "player");
    await later(31);
  }
  assert.ok(T.log.some((l) => /timed out 3x — AFK/.test(l.text)), T.log.map((l) => l.text).join(" / "));
  assert.equal(T.status, "closed");                   // she was the only player: everyone left
  await fresh();
  const t2 = await openWith(ann);
  await later(31);                                    // first window (30 s) passes with no bets: warning
  assert.equal(svc.getTable(t2).status, "open");
  await later(11);
  assert.equal(svc.getTable(t2).status, "closed");
});

test("idempotency: the same key twice charges once and replays the answer", async () => {
  await fresh();
  const tid = await openWith(ann);
  const r1 = await svc.act(ann, "bet", ["500"], { table: tid }, "same-key-123");
  const r2 = await svc.act(ann, "bet", ["500"], { table: tid }, "same-key-123");
  assert.ok(r1.ok && r2.ok && r2.replayed);
  assert.equal(await bal("u1"), 99500);
});

test("restart mid-hand: the table reloads from the database and the hand carries on (paid once)", async () => {
  await fresh();
  const tid = await openWith(ann);
  shoe(["Ts", "9h", "Qd", "7d", "Kc"]);
  await A(ann, "bet", ["1000"], { table: tid });
  await A(ann, "deal", [], { table: tid });
  NOW += 60 * 1000;                                   // the site was down past her deadline
  svc.stop();
  await svc.boot({ tick: false });
  const T = svc.getTable(tid);
  assert.ok(T && T.eng.phase === "player");
  assert.ok(T.dl.turn > NOW, "a fresh decision window after the restart");
  await svc.tickOnce();
  assert.equal(T.eng.phase, "player", "not timed out by our restart");
  assert.ok((await A(ann, "stand", [], { table: tid })).ok);
  assert.equal(await bal("u1"), 101000);
});

test("a crash mid-settle: the restart finishes the settlement, every step exactly once", async () => {
  await fresh();
  const tid = await openWith(ann);
  shoe(["Ts", "9h", "Qd", "7d", "Kc"]);
  await A(ann, "bet", ["1000"], { table: tid });
  await A(ann, "deal", [], { table: tid });
  svc.S.hooks.crash = "payouts";
  const r = await A(ann, "stand", [], { table: tid });
  assert.equal(r.ok, false);
  assert.equal(await bal("u1"), 101000, "the payout landed before the crash");
  assert.equal(await house(), 10000000, "the House row didn't");
  svc.S.hooks.crash = null;
  svc.stop();
  await svc.boot({ tick: false });
  assert.equal(await bal("u1"), 101000, "not paid twice");
  assert.equal(await house(), 10000000 - 1000);
  const T = svc.getTable(tid);
  assert.equal(T.round.settle, null);
  assert.equal(T.eng.phase, "betting");
});

test("a stake interrupted between its charge and the table is refunded at restart", async () => {
  await fresh();
  const tid = await openWith(ann);
  const money = require(path.join(repo, "casino", "money"));
  const kk = `cbj:${tid}:r1:u1:bet:99`;
  assert.ok((await money.charge(kk, "u1", 700, "blackjack bet")).ok);
  const row = (await getQuery("SELECT state FROM casino_tables WHERE id = ?", [tid]))[0];
  const st = JSON.parse(row.state);
  st.intent = { key: kk, uid: "u1", amount: 700, op: "bet" };
  await runQuery("UPDATE casino_tables SET state = ? WHERE id = ?", [JSON.stringify(st), tid]);
  assert.equal(await bal("u1"), 99300);
  svc.stop();
  await svc.boot({ tick: false });
  assert.equal(await bal("u1"), 100000);
  assert.equal(svc.getTable(tid).intent, null);
});

test("House short of its hard floor: the payout is made in full and a flash:house:blackjack claim is booked", async () => {
  await fresh();
  await setHouse(1000000);
  funding.sync({ flows: { wheel_shortfall: "jackpot" }, monetary: { flash: { house: true, bank: true, mm: true }, fedloan_room: 10000000, house_hard_floor: 995000 } });
  const tid = await openWith(ann);
  shoe(["Ts", "9h", "Qd", "7d", "Kc"]);
  await A(ann, "bet", ["10000"], { table: tid });
  await A(ann, "deal", [], { table: tid });
  await A(ann, "stand", [], { table: tid });
  assert.equal(await bal("u1"), 110000);
  const cl = await getQuery("SELECT amount, meta FROM reserve_claims WHERE flow = 'flash:house:blackjack'");
  assert.equal(cl.length, 1);
  assert.equal(cl[0].amount, 5000);                  // the House could pay 5,000 above its floor; the Fed lends the rest
  assert.match(cl[0].meta, /house-/);
});

test("the cover rule: a bet the House couldn't pay is refused", async () => {
  await fresh();
  await setHouse(1500);
  const tid = await openWith(ann);
  const r = await A(ann, "bet", ["1000"], { table: tid });
  assert.equal(r.ok, false);
  assert.match(r.reply, /can't cover/);
  assert.equal(await bal("u1"), 100000);
});

test("leaving between rounds gives the bet back; closing the table refunds every bet in the window", async () => {
  await fresh();
  const tid = await openWith(ann);
  await A(ann, "bet", ["800"], { table: tid });
  await A(bob, "bet", ["600"], { table: tid });
  assert.ok((await A(ann, "leave", [], { table: tid })).ok);
  assert.equal(await bal("u1"), 100000);
  const r = await A(bob, "end", [], { table: tid });
  assert.equal(r.ok, false, "only the host or an admin");
  assert.ok((await A(Object.assign({}, bob, { admin: true }), "end", [], { table: tid })).ok);
  assert.equal(await bal("u2"), 100000);
});

test("anti-abuse: linked accounts can't share a table; one address = flagged; casino ban; High Roller has no cap", async () => {
  await fresh();
  await runQuery("INSERT INTO welcome_bonus (userId, dup_of) VALUES ('u4', 'u1')");
  const tid = await openWith(ann);
  await A(ann, "bet", ["100"], { table: tid });
  const r = await A(dan, "bet", ["100"], { table: tid });
  assert.equal(r.ok, false);
  assert.match(r.reply, /linked to yours/);
  await A(bob, "bet", ["100"], { table: tid });
  await A(cat, "bet", ["100"], { table: tid });       // same address as Bob: allowed, flagged
  assert.equal(svc.getTable(tid).multi.length, 1);
  await runQuery("UPDATE users SET casino_banned = 1 WHERE userId = 'u3'");
  assert.match((await A(cat, "autobet", ["100"], { table: tid })).reply, /banned/);
  assert.match((await A(bob, "bet", ["20000"], { table: tid })).reply, /already bet|bet must/);
  await runQuery("INSERT INTO user_roles (userId, role) VALUES ('u2', 'High Roller')");
  const t2 = svc.getTable(tid);
  assert.match((await A(dan, "bet", ["20000"], { table: tid })).reply, /linked/);
  assert.ok(t2);
  await fresh();
  await runQuery("INSERT INTO user_roles (userId, role) VALUES ('u2', 'High Roller')");
  const t3 = await openWith(bob);
  assert.match((await A(bob, "bet", ["100001"], { table: t3 })).reply, /bet must be 100–100,000\.$/, "1.99ov: the role no longer lifts the maximum");
  assert.ok((await A(ann, "bet", ["50000"], { table: t3 })).ok, "1.99ov: the table maximum is 100,000 (was 10,000)");
  assert.ok((await A(bob, "bet", ["100000"], { table: t3 })).ok);
});

test("1.99ov: 💎 High Roller tables - High Rollers open, sit and bet (100,000-1,000,000); everyone else watches", async () => {
  await fresh();
  await setBal("u2", 3000000);
  await runQuery("INSERT INTO user_roles (userId, role) VALUES ('u2', 'High Roller')");
  assert.match((await A(ann, "start", ["hr"], { room: null })).reply, /High Roller tables are for High Rollers/);
  assert.match((await A(ann, "start", ["huge"], { room: null })).reply, /usage/);
  const r = await A(bob, "start", ["hr"], { room: null });
  assert.ok(r.ok, r.reply);
  const T = svc.getTable(r.table);
  assert.equal(T.high_stakes, true);
  assert.deepEqual([T.eng.min_bet, T.eng.max_bet], [100000, 1000000]);
  assert.equal(svc.lobby().find((x) => x.id === r.table).high_stakes, true, "the lobby marks it");
  assert.equal(svc.publicView(T).high_stakes, true);
  assert.match((await A(ann, "bet", ["100000"], { table: r.table })).reply, /only High Rollers can play here/);
  assert.match((await A(ann, "autobet", ["100000"], { table: r.table })).reply, /only High Rollers/);
  assert.equal(await bal("u1"), 100000, "nothing charged");
  assert.match((await A(bob, "bet", ["50000"], { table: r.table })).reply, /bet must be 100,000–1,000,000/);
  assert.match((await A(bob, "bet", ["1000001"], { table: r.table })).reply, /bet must be 100,000–1,000,000/);
  assert.ok((await A(bob, "bet", ["1000000"], { table: r.table })).ok);
  assert.equal(await bal("u2"), 2000000);
  // the limits are settings (new tables take them)
  await svc.setSetting("bj_hr_max_bet", "2000000", "test");
  await assert.rejects(svc.setSetting("bj_max_bet", "50", "test"), /minimum must not be above/);
  const lim = svc.limits();
  assert.deepEqual(lim.bj, { min_bet: 100, max_bet: 100000, hr_min_bet: 100000, hr_max_bet: 2000000 });
  assert.deepEqual(lim.holdem.hr_ladder[0], [100000, 200000]);
  await svc.setSetting("bj_hr_max_bet", "1000000", "test");
});

test("autobet and a bet queued during a round (charged when the next window opens)", async () => {
  await fresh();
  const tid = await openWith(ann);
  shoe(["Ts", "9h", "Qd", "7d", "Kc", "Ts", "9h", "Qd", "7d", "Kc"]);
  await A(ann, "bet", ["300"], { table: tid });
  assert.ok((await A(ann, "autobet", [], { table: tid })).ok);
  await A(ann, "deal", [], { table: tid });
  const q = await A(bob, "bet", ["200"], { table: tid });     // mid-round: queued, not charged
  assert.match(q.reply, /next round/);
  assert.equal(await bal("u2"), 100000);
  await A(ann, "stand", [], { table: tid });                  // win; next window opens, Bob's bet is charged
  assert.equal(await bal("u2"), 99800);
  await later(11);                                            // the window ends: Ann's autobet goes in, deal
  const T = svc.getTable(tid);
  assert.equal(T.eng.bets.u1, 300);
  assert.equal(T.eng.round_no, 2);
});

// ── HTTP ──
test("HTTP: web acts need JSON + fetch and a session; Pepe polls a pushed table's events and acts for room players", async () => {
  await fresh();
  const express = require("express");
  const ejs = require("ejs");
  const routes = require(path.join(repo, "casino", "routes"));
  const app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  const users = { u1: { userId: "u1", username: "ann" }, u2: { userId: "u2", username: "bob" } };
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users[u] || null : null; next(); };
  routes.register(app, { isBotToken: (p) => p === "tok", addUser });
  const server = app.listen(0);
  const base = "http://127.0.0.1:" + server.address().port;
  const J = (uid, extra) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, uid ? { "x-test-user": uid } : {}, extra || {});
  const post = async (url, body, headers) => { const r = await fetch(base + url, { method: "POST", headers, body: JSON.stringify(body) }); return { status: r.status, j: await r.json() }; };
  try {
    // open a web table as Bob (no Camfrog link)
    let r = await post("/api/casino/bj/open", { idem: "web-open-1" }, J("u2"));
    assert.equal(r.status, 200, JSON.stringify(r.j));
    const tid = r.j.table;
    r = await post(`/api/casino/bj/t/${tid}/act`, { verb: "bet", amount: 500, idem: "web-bet-0001" }, { "content-type": "application/json", "x-test-user": "u2" });
    assert.equal(r.status, 400, "no X-Requested-With: refused");
    r = await post(`/api/casino/bj/t/${tid}/act`, { verb: "bet", amount: 500, idem: "web-bet-0001" }, J(null));
    assert.equal(r.status, 401);
    r = await post(`/api/casino/bj/t/${tid}/act`, { verb: "bet", amount: 500, idem: "web-bet-0001" }, J("u2"));
    assert.ok(r.j.ok, JSON.stringify(r.j));
    assert.equal(await bal("u2"), 99500);
    // the page and the state
    let g = await fetch(base + `/api/casino/bj/t/${tid}`, { headers: J("u2") });
    let st = await g.json();
    assert.equal(st.table.seats[0].name, "Bob");
    assert.equal(st.me.bet, 500);
    assert.ok(!JSON.stringify(st).includes(svc.getTable(tid).round.seed), "the secret seed never leaves the server");
    g = await fetch(base + `/casino/blackjack/t/${tid}`, { headers: J("u2") });
    assert.equal(g.status, 200);
    assert.match(await g.text(), /casinobj\.js/);
    // Pepe's heartbeat makes a room available; Bob pushes his table there
    r = await post("/api/casino/bot/poll", { password: "tok", after: 0, wait: 0, rooms: [{ id: "PepeLab", name: "Pepe Lab" }] }, J(null));
    assert.ok(r.j.ok);
    const cursor = r.j.cursor;
    r = await post(`/api/casino/bj/t/${tid}/push`, { room: "PepeLab" }, J("u2"));
    assert.ok(r.j.ok, JSON.stringify(r.j));
    r = await post("/api/casino/bot/poll", { password: "tok", after: cursor, wait: 0 }, J(null));
    assert.ok(r.j.events.some((e) => e.kind === "pushed" && e.room === "PepeLab"));
    assert.ok(r.j.tables[tid]);
    // a room player bets through Pepe
    r = await post("/api/casino/bot/act", { password: "tok", room: "PepeLab", username: "ann", camfrog: "AnnCF", name: "Ann", verb: "bet",
                                            args: ["400"], idem: "pepe-cmd-0001" }, J(null));
    assert.ok(r.j.ok, JSON.stringify(r.j));
    assert.equal(await bal("u1"), 99600);
    r = await post("/api/casino/bot/act", { password: "tok", room: "PepeLab", username: "ann", verb: "bet", args: ["400"], idem: "pepe-cmd-0001" }, J(null));
    assert.ok(r.j.replayed);
    assert.equal(await bal("u1"), 99600);
    r = await post("/api/casino/bot/act", { password: "tok", room: "PepeLab", username: "ann", verb: "status", args: [], idem: "pepe-cmd-0002", channel: "telegram" }, J(null));
    assert.equal(r.status, 403, "no gambling over Telegram");
    r = await post("/api/casino/bot/act", { password: "nope", room: "PepeLab", username: "ann", verb: "status", idem: "pepe-cmd-0003" }, J(null));
    assert.equal(r.status, 403);
    // a long-poll wakes up on the next event
    const before = (await post("/api/casino/bot/poll", { password: "tok", after: 0, wait: 0 }, J(null))).j.cursor;
    const waiting = post("/api/casino/bot/poll", { password: "tok", after: before, wait: 5 }, J(null));
    await new Promise((res) => setTimeout(res, 100));
    shoe(["Ts", "9h", "Qd", "7d", "8c", "5s"]);        // no naturals: the round stays open (its seed secret)
    const dealt = await post(`/api/casino/bj/t/${tid}/act`, { verb: "deal", idem: "web-deal-0001" }, J("u2"));
    const woke = await waiting;
    assert.ok(woke.j.events.length > 0, JSON.stringify({ dealt: dealt.j, before, woke: woke.j }).slice(0, 600));
    // the switch: off blocks new tables (and the page redirects), the open one plays on
    r = await post("/api/casino/admin/settings", { key: "bj_enabled", value: "0" }, J("u2"));
    assert.equal(r.status, 403, "only an Admin or Pepe");
    r = await post("/api/casino/admin/settings", { password: "tok", key: "bj_enabled", value: "0" }, J(null));
    assert.ok(r.j.ok);
    r = await post("/api/casino/bj/open", { idem: "web-open-2" }, J("u1"));
    assert.equal(r.status, 409);
    g = await fetch(base + "/casino/blackjack", { headers: J("u1"), redirect: "manual" });
    assert.equal(g.status, 302);
    // the fairness page data
    g = await fetch(base + `/api/casino/fair/${tid}/1`);
    st = await g.json();
    assert.ok(st.ok && st.commitment && !st.server_seed, "the seed stays secret until the round is over");
  } finally {
    server.close();
  }
});
