// 1.99aoj - two follow-ups from wave 1's reviews, on a temp DB:
//   * the BLACKJACK PAYOUT FIX: settle() used to log a REFUSED payout (the account is gone: ledger.post finds no row to credit) and mark
//     the round done - the payout was lost. Now it stays owed at the table (T.owed, by its own payout key), the round isn't done while it is
//     the table's round, supply.js counts it, and payOwed tries it again by that key on the table's clock, at every boot and before the
//     table closes - it lands exactly once, ever. The table plays on meanwhile; it is never CLOSED with a payout owed (frozen: no new bets,
//     until it lands). A crash mid-settle, a restart, and a staging copy (casino/retire.js pays it by its key) change none of that.
//   * the SUPPLY between Hold'em hands: supply.js casinoHeld counts a cash table's last-hand contributions on top of the stacks the pot was
//     paid into - the figure runs high by the last pot at every open table between hands. 1.99aoj (review) leaves that count exactly as
//     1.99aoi has it (patSupply().total is an economy-engine input and the engines move to the site at H2a): its fix ships on its own
//     after H2a's first clean gate, with the owner's OK. The test below pins today's count; conservation is checked without it.
//   node --test test/casino-owed-supply.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "casino-owed-supply-")));
delete process.env.STAGING;
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const E = require(path.join(repo, "casino", "bjengine"));
const svc = require(path.join(repo, "casino", "service"));
const SUP = require(path.join(repo, "supply"));
const K = require(path.join(repo, "deploy", "keep-staging-tables"));
require(path.join(repo, "casino", "veil"))._hooks.kind = async () => null;        // nobody is veiled here
require(path.join(repo, "casino", "rewards")).hooks.updateLevel = async () => {};
const funding = require(path.join(repo, "funding"));

let NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
svc.S.hooks.now = () => NOW;
const later = async (secs) => { NOW += secs * 1000; await svc.tickOnce(); };
let k = 0;
const mk = (uid, name) => ({ uid, name, username: name.toLowerCase(), camfrog: null, via: "web", iph: null, admin: false });
const ann = mk("u1", "Ann"), bob = mk("u2", "Bob"), cat = mk("u3", "Cat");
const boss = Object.assign(mk("u4", "Boss"), { admin: true });
const A = (who, verb, args, opts) => { svc.S.rate.clear(); return svc.act(who, verb, args || [], opts || {}, "owed-" + ++k); };
const ok = (r) => { assert.ok(r && r.ok, r && r.reply); return r; };
const bal = async (uid) => ((await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [uid]))[0] || {}).b;
const house = async () => (await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM jackpot_rakes"))[0].t;
const wallets = async () => (await getQuery("SELECT COALESCE(SUM(points_balance),0) AS t FROM users"))[0].t;
const keys = async (key) => (await getQuery("SELECT points FROM transactions WHERE transactionId = ?", [key])).map((r) => r.points);
const row = async (id) => { const r = (await getQuery("SELECT status, state FROM casino_tables WHERE id = ?", [id]))[0]; return { status: r.status, s: JSON.parse(r.state) }; };
const events = async (id) => (await getQuery("SELECT kind FROM casino_events WHERE table_id = ? ORDER BY seq", [id])).map((r) => r.kind);
// an account that is gone (account deletion): its balance is kept aside here so the conservation sum can count it
let away = 0;
async function gone(uid) {
  away += await bal(uid);
  await runQuery("DELETE FROM users WHERE userId = ?", [uid]);
}
async function back(uid, name) {
  await runQuery("INSERT INTO users (userId, username, displayname, password, points_balance) VALUES (?, ?, ?, 'x', ?)", [uid, name.toLowerCase(), name, away]);
  away = 0;
}
/** every PAT there is: the wallets (+ an account set aside), the House and what supply.js counts at the casino tables */
const total = async () => (await wallets()) + away + (await house()) + (await SUP.casinoHeld());

async function fresh() {
  svc.stop();
  svc.S.hooks.shoe = null;
  svc.S.hooks.deck = null;
  svc.S.hooks.crash = null;
  svc.S.rate.clear();
  for (const t of ["casino_tables", "casino_events", "casino_rounds", "casino_actions", "transactions", "reserve_claims", "casino_settings"]) {
    await runQuery(`DELETE FROM ${t}`).catch(() => {});
  }
  for (const [id, name] of [["u1", "Ann"], ["u2", "Bob"], ["u3", "Cat"], ["u4", "Boss"]]) {
    await runQuery("INSERT OR IGNORE INTO users (userId, username, displayname, password, points_balance) VALUES (?, ?, ?, 'x', 100000)", [id, name.toLowerCase(), name]);
  }
  await runQuery("UPDATE users SET points_balance = 100000, casino_banned = 0");
  away = 0;
  await runQuery("DELETE FROM jackpot_rakes");
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, amount) VALUES ('seed', 'seed', 10000000)");
  funding.sync({});
  NOW += 3600e3;
  await svc.boot({ tick: false });
  for (const [kk, v] of [["bj_enabled", "1"], ["hm_enabled", "1"]]) await svc.setSetting(kk, v, "test");
}
async function restart(crash) {
  svc.stop();
  svc.S.hooks.crash = crash || null;
  await svc.boot({ tick: false });
}
const get = (id) => svc.getTable(id);
// round 1: two players (Ann 20, Bob 20 vs Pepe 9+7 who hits a K = bust: both win 1000 on 1000); later rounds: one player, the same
const TWO = ["Ts", "Js", "9h", "Qd", "Kd", "7d", "Kc"];
const ONE = ["Ts", "9h", "Qd", "7d", "Kc"];
function shoes() { svc.S.hooks.shoe = (T) => (Object.keys(T.eng.bets).length >= 2 ? TWO : ONE).concat(E.makeShoe(6)); }

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, level INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await runQuery(`CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL, points INTEGER NOT NULL,
                  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE user_roles (userId TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (userId, role))");
  await runQuery("CREATE TABLE welcome_bonus (userId TEXT PRIMARY KEY, dup_of TEXT)");
  await runQuery("CREATE TABLE badges (badgeId TEXT PRIMARY KEY, name TEXT, description TEXT, icon TEXT, points INTEGER, requirement TEXT, pat INTEGER DEFAULT 0)");
  await funding.init();
});
test.after(() => svc.stop());

/** Ann and Bob bet 1000 each and both win; Ann's account is gone before the round settles -> {t, key} (Ann's payout key) */
async function refusedRound() {
  const t = ok(await A(bob, "start", [], { room: null })).table;
  shoes();
  ok(await A(bob, "bet", ["1000"], { table: t }));
  ok(await A(ann, "bet", ["1000"], { table: t }));
  ok(await A(bob, "deal", [], { table: t }));
  assert.equal(get(t).eng.phase, "player");
  assert.deepEqual(get(t).eng.round_players, ["u2", "u1"]);
  await gone("u1");                                                  // the account is deleted mid-round
  ok(await A(bob, "stand", [], { table: t }));
  ok(await A(ann, "stand", [], { table: t }));
  return { t, key: `cbj:${t}:r1:u1:pay` };
}

test("a refused blackjack payout stays owed at the table (counted in the supply), the table plays on, and it lands once - by its own key, on its clock", async () => {
  await fresh();
  const start = await total();
  const errs = [], ce = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  let t, key;
  try { ({ t, key } = await refusedRound()); } finally { console.error = ce; }
  assert.ok(errs.some((l) => l.includes("refused") && l.includes("kept owed")), errs.join("\n"));
  const T = get(t);
  assert.deepEqual(Object.keys(T.owed), [key], "Ann's payout is owed, by its own payout key");
  assert.equal(T.owed[key].amount, 2000);
  assert.equal(T.owed[key].round, 1);
  assert.deepEqual(await keys(key), [], "nothing was credited");
  assert.deepEqual(await keys(`cbj:${t}:r1:u2:pay`), [2000], "Bob's payout landed");
  assert.equal(await SUP.casinoHeld(), 2000, "supply.js counts the owed payout as PAT at the table");
  assert.equal(await total(), start, "no PAT lost or made while it is owed");
  assert.equal((await row(t)).s.owed[key].amount, 2000, "the owed payout is saved with the table");
  // the table plays on: round 2 opened, Bob turns autobet on and plays it
  assert.equal(T.status, "open");
  assert.equal(T.eng.phase, "betting");
  assert.equal(T.round.no, 2);
  ok(await A(bob, "autobet", ["500"], { table: t }));
  ok(await A(bob, "bet", ["500"], { table: t }));
  ok(await A(bob, "deal", [], { table: t }));
  ok(await A(bob, "stand", [], { table: t }));
  assert.deepEqual(await keys(`cbj:${t}:r2:u2:pay`), [1000]);
  assert.equal(await total(), start);
  // Ann's account is back (an admin restored it) - but the payout waits for its clock (C.OWED_RETRY_MS after the refusal)
  await back("u1", "Ann");
  const annBefore = await bal("u1");
  await later(300);                                                  // round 3: Bob's autobet deals; his turn clock runs
  assert.equal(get(t).eng.phase, "player");
  await svc.tickOnce();
  assert.deepEqual(await keys(key), [], "not before its clock (5 of 10 minutes)");
  assert.equal(await total(), start);
  await later(301);                                                  // Bob times out (stands): round 3 settles, round 4 opens
  await svc.tickOnce();                                              // nothing else due: the owed payout's clock
  assert.deepEqual(await keys(key), [2000], "paid once, by the round's own payout key");
  assert.equal(await bal("u1"), annBefore + 2000);
  assert.equal(get(t).owed && Object.keys(get(t).owed).length, 0);
  assert.equal(await SUP.casinoHeld(), Object.values(get(t).escrowed).reduce((s, v) => s + v, 0), "nothing owed is counted any more");
  assert.equal(await total(), start);
  // more clocks, a restart, the table's close: nothing is paid twice
  for (let i = 0; i < 3; i++) await later(700);
  await restart();
  for (let i = 0; i < 3; i++) await later(700);
  assert.deepEqual(await keys(key), [2000]);
  assert.equal(await bal("u1"), annBefore + 2000);
  assert.equal(await total(), start);
});

test("a table is never closed with a payout owed: it stays open, frozen (no new bets), retried on its clock and at boot, and closes once it lands", async () => {
  await fresh();
  const start = await total();
  const t = ok(await A(ann, "start", [], { room: null })).table;
  shoes();
  ok(await A(ann, "bet", ["1000"], { table: t }));
  ok(await A(ann, "deal", [], { table: t }));
  ok(await A(ann, "leave", [], { table: t }));                     // she leaves once this round finishes
  await gone("u1");
  ok(await A(ann, "stand", [], { table: t }));
  const key = `cbj:${t}:r1:u1:pay`;
  let T = get(t);
  assert.equal(T.status, "open", "everyone left - but a payout is owed: not closed");
  assert.equal(T.closing, "everyone left");
  assert.equal(T.round.settle, "owed", "the round isn't done while its payout is owed");
  assert.deepEqual(T.dl, { bet: null, ins: null, turn: null });
  assert.equal(T.eng.seats.length, 0);
  assert.ok(!(await events(t)).includes("closed"));
  assert.equal(await total(), start);
  // frozen: nobody bets, queues or autobets here; the host / an admin can't close it either (it closes by itself)
  for (const verb of ["bet", "autobet"]) {
    const r = await A(cat, verb, ["500"], { table: t });
    assert.equal(r.ok, false);
    assert.match(r.reply, /closing/);
  }
  const end = await A(boss, "end", [], { table: t });
  assert.equal(end.ok, false);
  assert.match(end.reply, /still owed/);
  assert.equal(get(t).status, "open");
  assert.equal(await bal("u3"), 100000, "nothing charged");
  // still refused at its clock and at a restart: tried, still owed, still open
  await later(601);
  assert.ok(get(t).owed[key].tries >= 2);
  await restart();
  T = get(t);
  assert.equal(T.status, "open");
  assert.equal(T.closing, "closed by Boss", "the latest close asked for");
  assert.ok(T.owed[key].tries >= 3, "tried again at boot");
  assert.deepEqual(T.dl, { bet: null, ins: null, turn: null }, "the restart gives a frozen table no deadline");
  assert.deepEqual(await keys(key), []);
  // the account is back: the next clock pays it, once, the round is done and the table closes
  await back("u1", "Ann");
  const annBefore = await bal("u1");
  await later(60);
  assert.deepEqual(await keys(key), [], "its clock hasn't run out yet");
  await later(600);
  assert.deepEqual(await keys(key), [2000]);
  assert.equal(await bal("u1"), annBefore + 2000);
  assert.equal(get(t).status, "closed");
  assert.equal(get(t).round.settle, "done");
  assert.equal(get(t).closing, undefined);
  assert.equal((await row(t)).status, "closed");
  assert.equal((await events(t)).filter((x) => x === "closed").length, 1);
  assert.equal(await total(), start);
  await restart();
  await later(700);
  assert.deepEqual(await keys(key), [2000], "never paid twice");
  assert.equal(await total(), start);
});

test("a frozen table (its close asked for in a betting window while a payout is owed) deals no round on the bets it refunded - not by a bettor, a stranger or a restart", async () => {
  // (1.99aoj review: closeTable's frozen branch refunded the window's stakes but left them in the engine, and !bj deal dealt them - a win
  //  paid a stake nobody held, a loss put one into the House from nothing)
  await fresh();
  const start = await total();
  const { t, key } = await refusedRound();                           // Ann's payout owed; round 2's betting window open
  const b0 = await bal("u2");
  ok(await A(bob, "bet", ["1000"], { table: t }));
  assert.equal(await bal("u2"), b0 - 1000);
  const end = await A(bob, "end", [], { table: t });
  assert.equal(end.ok, false);
  assert.match(end.reply, /still owed/);
  let T = get(t);
  assert.equal(T.status, "open");
  assert.equal(T.closing, "closed by Bob");
  assert.equal(await bal("u2"), b0, "Bob's bet went back");
  assert.deepEqual(T.stakes, []);
  assert.deepEqual(T.eng.bets, {}, "the refunded bet left the engine too");
  assert.deepEqual((await row(t)).s.eng.bets, {}, "and the saved table");
  assert.equal(await total(), start);
  const refused = async () => {
    for (const who of [bob, cat]) {                                  // the bettor, and a stranger who never sat
      const r = await A(who, "deal", [], { table: t });
      assert.equal(r.ok, false, `${who.name}'s deal`);
      assert.match(r.reply, /closing/);
    }
    assert.equal(get(t).eng.phase, "betting");
    assert.equal(get(t).eng.round_no, 1, "no round dealt");
    assert.equal((await A(bob, "stand", [], { table: t })).ok, false);
    assert.equal(await bal("u2"), b0);
    assert.deepEqual(await keys(`cbj:${t}:r2:u2:pay`), [], "nothing paid on the refunded bet");
    assert.equal(await total(), start, "no PAT made or lost");
  };
  await refused();
  await restart();
  T = get(t);
  assert.equal(T.closing, "closed by Bob");
  await refused();
  // the payout lands on its clock: the table closes, and Bob's bet is not refunded a second time
  await back("u1", "Ann");
  await later(601);
  assert.deepEqual(await keys(key), [2000]);
  assert.equal(get(t).status, "closed");
  const refunds = await getQuery("SELECT points FROM transactions WHERE transactionId LIKE ? AND transactionId LIKE '%:refund'", [`cbj:${t}:r2:u2:%`]);
  assert.deepEqual(refunds.map((r) => r.points), [1000], "Bob's bet refunded exactly once");
  assert.equal(await bal("u2"), b0);
  assert.equal(await total(), start);
});

test("a restart while a payout is owed tries it at once; a crash mid-settle settles again (owed again, the same key) - paid once either way", async () => {
  // (1) owed at a restart: the boot pays it at once
  await fresh();
  let start = await total();
  let { t, key } = await refusedRound();
  await back("u1", "Ann");
  const b0 = await bal("u1");
  await restart();
  assert.deepEqual(await keys(key), [2000], "the boot tried every owed payout at once");
  assert.equal(await bal("u1"), b0 + 2000);
  assert.equal(Object.keys(get(t).owed).length, 0);
  assert.equal(await total(), start);
  // (2) a crash mid-settle with the payout refused: the restart settles again, it is owed again (one entry), then paid once
  await fresh();
  start = await total();
  t = ok(await A(ann, "start", [], { room: null })).table;
  key = `cbj:${t}:r1:u1:pay`;
  shoes();
  ok(await A(ann, "bet", ["1000"], { table: t }));
  ok(await A(ann, "deal", [], { table: t }));
  await gone("u1");
  svc.S.hooks.crash = "settle";
  await A(ann, "stand", [], { table: t }).catch(() => null);
  assert.equal((await row(t)).s.round.settle, "pending");
  await restart();
  assert.deepEqual(Object.keys(get(t).owed), [key], "settled again after the crash: owed again, one entry");
  assert.deepEqual(await keys(key), []);
  assert.equal(await total(), start);
  await back("u1", "Ann");
  const b1 = await bal("u1");
  await restart();
  assert.deepEqual(await keys(key), [2000]);
  await restart();
  assert.deepEqual(await keys(key), [2000]);
  assert.equal(await bal("u1"), b1 + 2000);
  assert.equal(await total(), start);
  // (3) the same crash, but the account is back before the restart: the second settle pays it - and nothing is owed
  await fresh();
  start = await total();
  t = ok(await A(ann, "start", [], { room: null })).table;
  key = `cbj:${t}:r1:u1:pay`;
  shoes();
  ok(await A(ann, "bet", ["1000"], { table: t }));
  ok(await A(ann, "deal", [], { table: t }));
  await gone("u1");
  svc.S.hooks.crash = "settle";
  await A(ann, "stand", [], { table: t }).catch(() => null);
  await back("u1", "Ann");
  await restart();
  assert.deepEqual(await keys(key), [2000]);
  assert.equal(Object.keys(get(t).owed || {}).length, 0);
  assert.equal(get(t).round.settle === "done" || get(t).round.no === 2, true);
  assert.equal(await total(), start);
});

test("a staging copy of a table with a payout owed: the retire pays it by its own key (or keeps the copy out of play while it is refused)", async () => {
  await fresh();
  const start = await total();
  const { t, key } = await refusedRound();
  // the copy's scrub (deploy/keep-staging-tables.js), then staging's boot: Ann's account still gone - the copy stays out of play
  for (const s of K.CASINO_SCRUB) await runQuery(s.sql.replace(/\bmain\./g, "")).catch((e) => { if (!/no such table/.test(e.message)) throw e; });
  const errs = [], ce = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  try { await restart(); } finally { console.error = ce; }
  assert.equal(get(t), null, "not loaded: out of play");
  assert.equal((await row(t)).status, "open", "its row stays open and copied: the next boot tries again");
  assert.ok(errs.some((l) => l.includes("couldn't be retired")), errs.join("\n"));
  assert.deepEqual(await keys(key), []);
  await back("u1", "Ann");
  const b0 = await bal("u1");
  await restart();
  assert.equal((await row(t)).status, "closed");
  assert.deepEqual(await keys(key), [2000], "the owed payout paid by its own key");
  assert.equal(await bal("u1"), b0 + 2000);
  await restart();
  assert.deepEqual(await keys(key), [2000]);
  assert.equal(await total(), start);
});

test("nothing changes when every payout lands: no owed entry, the round done, the table closes as before", async () => {
  await fresh();
  const start = await total();
  const t = ok(await A(ann, "start", [], { room: null })).table;
  shoes();
  ok(await A(ann, "bet", ["1000"], { table: t }));
  ok(await A(ann, "deal", [], { table: t }));
  ok(await A(ann, "leave", [], { table: t }));
  ok(await A(ann, "stand", [], { table: t }));
  assert.equal(get(t).status, "closed");
  assert.equal(get(t).owed, undefined, "no owed field on a table that never owed");
  assert.equal(get(t).closing, undefined);
  assert.equal(get(t).round.settle, "done");
  assert.deepEqual(await keys(`cbj:${t}:r1:u1:pay`), [2000]);
  assert.equal(await total(), start);
});

// ── the supply between Hold'em hands (supply.js casinoHeld) ──
const deck = (prefix) => { svc.S.hooks.deck = () => prefix.concat(E.makeShoe(1).filter((c) => !prefix.includes(c))); };
const ACES = ["As", "Ah", "Ks", "Kh", "2c", "7d", "9h", "3s", "4c"];
const HA = (who, verb, args, opts) => A(who, verb, args, Object.assign({ game: "holdem" }, opts || {}));
const stacks = (T) => Object.values(T.eng.chips).reduce((s, v) => s + v, 0);

// 1.99aoj (review): the count stays 1.99aoi's this release (an economy-engine input - see the header); the PAT itself is conserved
test("supply: a cash Hold'em table counts as 1.99aoi counts it - the stacks + the last hand's contributions between hands; the PAT itself is conserved", async () => {
  await fresh();
  const contrib = (T) => Object.values(T.eng.contrib || {}).reduce((s, v) => s + v, 0);
  const real = async (T) => (await wallets()) + away + (await house()) + stacks(T);     // (every PAT, without supply.js)
  const start = await total();
  const t = ok(await HA(ann, "start", ["25/50"], { room: null })).table;
  ok(await HA(ann, "sit", ["2000"], { table: t }));
  ok(await HA(bob, "sit", ["2000"], { table: t }));
  assert.equal(await SUP.casinoHeld(), 4000);
  assert.equal(await total(), start);
  // a hand won uncontested: the blinds' pot goes into the winner's stack
  ok(await HA(ann, "deal", [], { table: t }));
  const T = get(t);
  assert.equal(T.eng.hand_active, true);
  assert.equal(await SUP.casinoHeld(), 4000, "mid-hand: the stacks + the pot");
  const actor = T.eng.actor;
  ok(await HA(actor === "u1" ? ann : bob, "fold", [], { table: t }));
  assert.equal(T.eng.hand_active, false);
  assert.ok(contrib(T) > 0, "the engine keeps the last hand's contributions between hands");
  assert.equal(stacks(T), 4000);
  assert.equal(await SUP.casinoHeld(), 4000 + contrib(T), "between hands: the stacks + the last pot, as 1.99aoi counts it");
  assert.equal(await real(T), start);
  // a showdown with the 2% rake: the rake is the House's once booked, the pot is in the stacks
  deck(ACES);
  ok(await HA(ann, "deal", [], { table: t }));
  for (let i = 0; i < 12 && T.eng.hand_active; i++) {
    const who = T.eng.actor === "u1" ? ann : bob;
    const r = await HA(who, "check", [], { table: t });
    if (!r.ok) ok(await HA(who, "call", [], { table: t }));
  }
  assert.equal(T.eng.hand_active, false);
  assert.ok(T.last_round && T.last_round.rake > 0, "a raked showdown");
  assert.equal(T.rake_due, null, "the rake is booked");
  assert.equal(stacks(T), 4000 - T.last_round.rake);
  assert.equal(await SUP.casinoHeld(), stacks(T) + contrib(T));
  assert.equal(await real(T), start, "wallets + House + the stacks: nothing made or lost across the hands");
  // a saved state between the awards and the House row (afterHand books the rake): not counted at the table, as before
  const s = (await row(t)).s;
  s.rake_due = { key: `chm-test:${t}:rake`, n: 99, amount: 7 };
  await runQuery("UPDATE casino_tables SET state = ? WHERE id = ?", [JSON.stringify(s), t]);
  assert.equal(await SUP.casinoHeld(), stacks(T) + contrib(T), "T.rake_due isn't counted (1.99aoi's count)");
});
