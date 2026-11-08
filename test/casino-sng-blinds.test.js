// h22 phase 2 (1.99amj), commit "sng: blind planner" - an SNG BEHAVIOUR CHANGE (DELIVERY.md): the scheduled tournaments' blind planner
// (casino/mttseat.js blindPlan) at a Sit & Go too. Phase 1 already moves a busted BUTTON back to the nearest seat still in (the next hand
// moves it on clockwise); it still skipped a big blind when the big blind or the small blind busted (hmengine.startHand moves the button
// one seat, so the seat after the busted big blind posted the small blind instead), and going heads-up after the button busted gave last
// hand's big blind the big blind again. With the planner: the big blind always moves forward one seat, a small blind that falls on last
// hand's small blind is dead (0), heads-up never posts the big blind twice in a row. Phase 1's own button test still holds.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "casino-sng-blinds-")));
delete process.env.STAGING;
const { runQuery } = require(path.join(repo, "dbUtils"));
const H = require(path.join(repo, "casino", "hmengine"));
const E = require(path.join(repo, "casino", "bjengine"));
const svc = require(path.join(repo, "casino", "service"));
const ESC = require(path.join(repo, "escrow", "ledger"));
require(path.join(repo, "casino", "veil"))._hooks.kind = async () => null;
const funding = require(path.join(repo, "funding"));

let NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
svc.S.hooks.now = () => NOW;
const later = async (secs) => { NOW += secs * 1000; await svc.tickOnce(); };
let k = 0;
const key = () => `sngb-${++k}`;
const mk = (uid, name) => ({ uid, name, username: name.toLowerCase(), camfrog: null, via: "web", iph: null, admin: false });
const P = ["Ann", "Bob", "Cat", "Dan", "Eve", "Fay"].map((n, i) => mk("u" + (i + 1), n));
const byUid = Object.fromEntries(P.map((p) => [p.uid, p]));
const S = (who, verb, args) => { svc.S.rate.clear(); return svc.act(who, verb, args || [], { game: "sng", room: null }, key()); };
const A = (who, verb, tid) => { svc.S.rate.clear(); return svc.act(who, verb, [], { game: "holdem", table: tid }, key()); };
const deck = (prefix) => { svc.S.hooks.deck = () => prefix.concat(E.makeShoe(1).filter((c) => !prefix.includes(c))); };

async function fresh() {
  svc.stop();
  svc.S.hooks.deck = null;
  for (const t of ["casino_tables", "casino_events", "casino_rounds", "casino_actions", "transactions", "casino_settings", "escrow_holds", "escrow_moves"]) await runQuery(`DELETE FROM ${t}`).catch(() => {});
  await runQuery("UPDATE users SET points_balance = 100000");
  await svc.boot({ tick: false });
  await svc.setSetting("hm_enabled", "1", "test");
  await svc.setSetting("casino_sng", "everyone", "test");
}
async function sng(n) {
  const r = await S(P[0], "new", [String(n), "1k"]);
  assert.ok(r.ok, r.reply);
  for (const p of P.slice(1, n)) { const x = await S(p, "join", [r.table]); assert.ok(x.ok, x.reply); }
  return svc.getTable(r.table);
}
async function playHand(T, policy) {
  for (let i = 0; i < 60 && T.eng.hand_active; i++) {
    const a = H.currentActor(T.eng);
    const verb = policy(T, a) || (H.toCall(T.eng, a) ? "fold" : "check");
    const r = await A(byUid[a], verb, T.id);
    assert.ok(r.ok, `${a} ${verb}: ${r.reply}`);
  }
}
const blinds = (T) => [T.eng.button, T.eng.sb_key, T.eng.bb_key];
const fold = (T, a) => (H.toCall(T.eng, a) ? "fold" : "check");

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, level INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery(`CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL, points INTEGER NOT NULL,
                  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT, note TEXT)`);
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE user_roles (userId TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (userId, role))");
  await runQuery("CREATE TABLE welcome_bonus (userId TEXT PRIMARY KEY, dup_of TEXT)");
  for (const p of P) await runQuery("INSERT INTO users (userId, username, displayname, password, points_balance) VALUES (?, ?, ?, 'x', 100000)", [p.uid, p.username, p.name]);
  await funding.init();
  await ESC.init();
});
test.after(() => svc.stop());

test("the big blind busts: the next seat posts the big blind (no skip), last hand's small blind is dead (0) - phase 1 skipped Dan's big blind", async () => {
  await fresh();
  const T = await sng(4);
  T.eng.chips.u3 = 400;                                    // Cat (the big blind of hand 1) is short
  deck(["Kd", "Qh", "8h", "3s", "7c", "2d", "As", "Ad", "9d", "4c", "Kh", "Qc", "Jd"]);   // Cat 7-2, Dan aces
  await later(16);
  assert.deepEqual(blinds(T), ["u1", "u2", "u3"], "hand 1: Ann button, Bob small blind, Cat big blind");
  await playHand(T, (TT, a) => (a === "u3" ? "allin" : a === "u4" ? "call" : "fold"));
  svc.S.hooks.deck = null;
  assert.ok(!T.eng.seats.includes("u3"), "Cat is out");
  await later(16);
  assert.equal(T.eng.hand_no, 2);
  assert.equal(T.eng.bb_key, "u4", "Dan - the seat after Cat - posts the big blind (phase 1: Ann posted it, Dan's was skipped)");
  assert.equal(T.eng.sb_key, "u2", "the small blind falls on Bob again ...");
  assert.equal(T.eng.street_paid.u2 || 0, 0, "... and is dead: Bob posts nothing");
  assert.equal(T.tourney.last.bb_key, "u4");
  assert.equal(T.eng.sb, svc.TN.levelAt(T.tourney, T.tourney.level)[0], "the table shows the level's small blind");
  assert.ok(!T.log.some((l) => /posts SB 0/.test(l.text)), "no 'posts SB 0' line");
  await playHand(T, fold);
  await later(16);
  assert.deepEqual(blinds(T), ["u2", "u4", "u1"], "hand 3: the big blind moves on to Ann");
});

test("the button busts 3-handed: heads-up, last hand's big blind is never the big blind again", async () => {
  await fresh();
  const T = await sng(3);
  T.eng.chips.u1 = 300;
  deck(["7c", "2d", "8h", "3s", "As", "Ad", "9d", "4c", "Kh", "Qc", "Jd"]);     // Ann 7-2, Bob 8-3, Cat aces
  await later(16);
  assert.deepEqual(blinds(T), ["u1", "u2", "u3"]);
  await playHand(T, (TT, a) => (a === "u1" ? "allin" : a === "u3" ? "call" : "fold"));
  svc.S.hooks.deck = null;
  assert.deepEqual(T.eng.seats.slice().sort(), ["u2", "u3"], "Ann is out");
  await later(16);
  assert.equal(T.eng.bb_key, "u2", "Bob (last hand's small blind) posts the big blind - not Cat again");
  assert.equal(T.eng.button, "u3", "heads-up: Cat on the button posts the small blind");
  assert.equal(T.eng.sb_key, "u3");
});

test("phase 1's rule still holds: a busted button - the button moves on clockwise, the blinds follow", async () => {
  await fresh();
  const T = await sng(4);
  for (let h = 1; h <= 2; h++) { await later(16); await playHand(T, fold); }
  Object.assign(T.eng.chips, { u1: 2000, u2: 1500, u3: 500, u4: 2000 });
  deck(["As", "Ad", "7c", "2d", "8h", "3s", "9d", "4c", "Ah", "Kc", "Qd", "Js", "5h"]);
  await later(16);
  assert.deepEqual([T.eng.hand_no, ...blinds(T)], [3, "u3", "u4", "u1"]);
  await playHand(T, (TT, a) => (a === "u3" ? "allin" : a === "u1" ? "call" : "fold"));
  svc.S.hooks.deck = null;
  await later(16);
  assert.deepEqual([T.eng.hand_no, ...blinds(T)], [4, "u4", "u1", "u2"], "Dan has the button, Ann the small blind, Bob the big blind");
});
