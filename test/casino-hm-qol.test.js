// Hold'em QoL integration tests: real service, temporary database and fake clock.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "casino-qol-test-"));
process.chdir(tmp);
delete process.env.STAGING;
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const H = require(path.join(repo, "casino", "hmengine"));
const E = require(path.join(repo, "casino", "bjengine"));
const fair = require(path.join(repo, "casino", "fair"));
const svc = require(path.join(repo, "casino", "service"));
require(path.join(repo, "casino", "veil"))._hooks.kind = async () => null;   // (1.99ajw casino2 rework: nobody is veiled here - test/casino-veil.test.js is about veils)
const funding = require(path.join(repo, "funding"));

let NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
svc.S.hooks.now = () => NOW;
const later = async (secs) => { NOW += secs * 1000; await svc.tickOnce(); };
let k = 0;
const key = () => `hm-key-${++k}`;
const mk = (uid, name, extra) => Object.assign({ uid, name, username: name.toLowerCase(), camfrog: null, via: "web", iph: null, admin: false }, extra || {});
const ann = mk("u1", "Ann", { camfrog: "AnnCF", via: "room" });
const bob = mk("u2", "Bob", { iph: "ip-b" });
const cat = mk("u3", "Cat", { iph: "ip-b" });
const dan = mk("u4", "Dan");
const eve = mk("u5", "Eve");
const A = (who, verb, args, opts) => svc.act(who, verb, args || [], Object.assign({ game: "holdem" }, opts || {}), key());
const bal = async (uid) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [uid]))[0].b;
const house = async () => (await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM jackpot_rakes"))[0].t;
// the next hand's deck starts with these cards (heads-up: p1 p1 p2 p2, flop, turn, river); the rest of a deck follows
const deck = (prefix) => { svc.S.hooks.deck = () => prefix.concat(E.makeShoe(1).filter((c) => !prefix.includes(c))); };
const ACES = ["As", "Ah", "Ks", "Kh", "2c", "7d", "9h", "3s", "4c"];

async function fresh() {
  svc.stop();
  svc.S.hooks.deck = null;
  svc.S.hooks.shoe = null;
  svc.S.rate.clear();
  for (const t of ["casino_tables", "casino_events", "casino_rounds", "casino_actions", "transactions", "reserve_claims", "casino_settings"]) {
    await runQuery(`DELETE FROM ${t}`).catch(() => {});
  }
  for (const u of ["u1", "u2", "u3", "u4", "u5"]) await runQuery("UPDATE users SET points_balance = 100000, casino_banned = 0 WHERE userId = ?", [u]);
  await runQuery("DELETE FROM jackpot_rakes");
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, amount) VALUES ('seed', 'seed', 10000000)");
  await runQuery("DELETE FROM user_roles");
  await runQuery("DELETE FROM welcome_bonus");
  funding.sync({});
  await svc.boot({ tick: false });
  await svc.setSetting("hm_enabled", "1", "test");
  await svc.setSetting("bj_enabled", "1", "test");
}
async function table(blinds, opts) {
  const r = await A(ann, "start", [blinds || "25/50"], opts || { room: null });
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
  for (const [id, u, d, cf] of [["u1", "ann", "Ann", "AnnCF"], ["u2", "bob", "Bob", null], ["u3", "cat", "Cat", null], ["u4", "dan", "Dan", null], ["u5", "eve", "Eve", null]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, points_balance) VALUES (?, ?, ?, 'x', ?, 100000)", [id, u, d, cf]);
  }
  await funding.init();
});
test.after(() => svc.stop());

async function setup(count = 3) {
  await fresh(); const tid = await table();
  for (const p of [ann,bob,dan].slice(0,count)) assert.ok((await A(p,"sit",["2000"],{table:tid})).ok);
  assert.ok((await A(ann,"deal",[],{table:tid})).ok);
  return { tid, T: svc.getTable(tid), move: (p,v,a=[]) => { svc.S.rate.clear(); return A(p,v,a,{table:tid}); } };
}
test("sizing is parsed on the real service", async () => {
  const {T,move} = await setup();
  assert.ok((await move(ann,"raise",["3bb"])).ok);
  assert.equal(T.eng.current_bet,150);
  assert.ok(!(await move(bob,"raise",["nonsense"])).ok);
});
test("pre-moves are private, replaceable, invalidated by bets, and automatic", async () => {
  const {tid,T,move} = await setup();
  assert.ok(!(await move(bob,"pre",["check"])).ok);
  assert.ok((await move(bob,"pre",["call"])).ok);
  assert.equal((await svc.meView(T,"u2")).pre.amount,25);
  assert.equal((await svc.meView(T,"u1")).pre,null);
  assert.ok(!JSON.stringify(svc.publicView(T)).includes('"pre"'));
  assert.ok((await move(ann,"raise",["3bb"])).ok);
  assert.equal(T.pre.u2,undefined);
  assert.ok((await move(dan,"pre",["check_fold"])).ok);
  assert.ok((await move(bob,"call")).ok);
  assert.ok(T.eng.folded.includes("u4"));
  assert.ok(T.log.some((l)=>l.text==="auto: folded"));
  assert.ok(!(await getQuery("SELECT data FROM casino_events WHERE table_id=?",[tid])).some((r)=>r.data.includes("auto:")));
});
test("pre-moves survive a restart and clear at street boundaries", async () => {
  let {tid,T,move} = await setup(2);
  await move(bob,"pre",["check_fold"]);
  svc.stop(); await svc.boot({tick:false}); T=svc.getTable(tid);
  assert.equal((await svc.meView(T,"u2")).pre.kind,"check_fold");
  await move(ann,"call");
  assert.equal(T.eng.street,1);
  assert.deepEqual(T.pre,{});
});
test("call-any and fold pre-moves play immediately; off clears", async () => {
  const {T,move}=await setup();
  await move(bob,"pre",["fold"]); await move(bob,"pre",["off"]); assert.equal(T.pre.u2,undefined);
  await move(bob,"pre",["call_any"]); await move(dan,"pre",["fold"]);
  await move(ann,"raise",["3bb"]);
  assert.equal(T.eng.contrib.u2,150);
  assert.ok(T.eng.folded.includes("u4"));
});
test("time bank consumes elapsed seconds, survives restart, then timeout retains seat", async () => {
  let {tid,T,move}=await setup();
  await later(60); assert.ok(T.turn.bank_started); assert.equal(T.qol.u1.bank,30);
  NOW+=10000; svc.stop(); await svc.boot({tick:false}); T=svc.getTable(tid);
  assert.equal(T.qol.u1.bank,20);
  await later(21); assert.ok(T.eng.folded.includes("u1")); assert.ok(T.eng.seats.includes("u1")); assert.equal(T.qol.u1.bank,0);
  assert.equal(T.qol.u1.timeouts,1); assert.equal(T.qol.u1.out,false);
});
test("two consecutive timeouts sit out; expiry uses the keyed stand path exactly once", async () => {
  const {T,move}=await setup(); T.qol.u1.bank=0; T.qol.u1.timeouts=1;
  await later(61); assert.equal(T.qol.u1.out,true); assert.ok(T.eng.seats.includes("u1"));
  while(T.eng.hand_active) { const uid=H.currentActor(T.eng); await move([ann,bob,dan].find((p)=>p.uid===uid),H.toCall(T.eng,uid)?"call":"check"); }
  const stack=T.eng.chips.u1, balance=await bal("u1");
  T.dl.next=null;
  await later(601); assert.ok(!T.eng.seats.includes("u1")); assert.equal(await bal("u1"),balance+stack);
  await svc.tickOnce(); assert.equal(await bal("u1"),balance+stack);
});
test("sitting out preserves chips and excludes cards and blinds; post now returns", async () => {
  const {T,move}=await setup(); await move(ann,"sitout"); await move(ann,"fold");
  while(T.eng.hand_active) { const uid=H.currentActor(T.eng); await move([bob,dan].find((p)=>p.uid===uid),H.toCall(T.eng,uid)?"call":"check"); }
  const stack=T.eng.chips.u1;
  await move(bob,"deal"); assert.ok(!T.eng.players.includes("u1")); assert.equal(T.eng.chips.u1,stack);
  assert.equal(T.eng.hole.u1,undefined);
  await move(ann,"sitin",["post"]); assert.equal(T.qol.u1.back,"post");
});
test("settings validate presets and timers", async () => {
  await assert.rejects(svc.setSetting("hm_presets_bb","2.5,nope","test"));
  await assert.rejects(svc.setSetting("hm_sitout_mins","0","test"));
  await svc.setSetting("hm_presets_pot","25,50,100","test");
  assert.equal(svc.S.settings.hm_presets_pot,"25,50,100");
});
test("initial bank cannot exceed its configured cap", async () => {
  await fresh(); await svc.setSetting("hm_timebank_secs","90","test");
  const tid=await table(); await A(ann,"sit",["2000"],{table:tid});
  assert.equal(svc.getTable(tid).qol.u1.bank,60);
});
test("pre-deal idle and restart cannot shorten a seat's sit-out limit", async () => {
  await fresh(); const tid=await table();
  const move=async(p,v,a=[])=>{svc.S.rate.clear();return A(p,v,a,{table:tid});};
  await move(ann,"sit",["2000"]); await move(bob,"sit",["2000"]); await move(ann,"sitout");
  const deadline=svc.getTable(tid).dl.sitout.u1;
  assert.equal(deadline,NOW+600000);
  await move(dan,"sit",["2000"]); // a later buy-in restores the ordinary idle deadline
  await later(301);
  assert.equal(svc.getTable(tid).status,"open"); assert.ok(svc.getTable(tid).eng.seats.includes("u1")); assert.equal(await bal("u1"),98000);
  svc.stop(); await svc.boot({tick:false}); assert.equal(svc.getTable(tid).dl.sitout.u1,deadline); await later(300);
  assert.ok(!svc.getTable(tid).eng.seats.includes("u1")); assert.equal(await bal("u1"),100000);
  assert.equal(svc.getTable(tid).dl.sitout.u1,undefined);
});
test("an interrupted payout clears the departed seat's controls before a fresh buy-in", async () => {
  await fresh(); const tid=await table();
  await A(ann,"sit",["2000"],{table:tid}); await A(bob,"sit",["2000"],{table:tid}); await A(ann,"sitout",[],{table:tid});
  const T=svc.getTable(tid); T.qol.u1.bank=7; T.qol.u1.hands=9;
  T.intent={kind:"out",key:`chm:${tid}:u1:out:99`,uid:"u1",amount:2000,ts:NOW};
  await runQuery("UPDATE casino_tables SET state=? WHERE id=?",[JSON.stringify(T),tid]);
  svc.stop(); await svc.boot({tick:false}); const recovered=svc.getTable(tid);
  assert.equal(recovered.qol.u1,undefined); assert.equal(recovered.dl.sitout.u1,undefined); assert.equal(await bal("u1"),100000);
  svc.S.rate.clear(); assert.ok((await A(ann,"sit",["2000"],{table:tid})).ok);
  assert.equal(recovered.qol.u1.out,false); assert.equal(recovered.qol.u1.bank,30); assert.equal(recovered.qol.u1.hands,0);
});
test("returning waiters receive their first cards only as the big blind", async () => {
  const {T,move}=await setup();
  await move(ann,"sitout"); await move(ann,"fold");
  async function finish() { while(T.eng.hand_active) { const uid=H.currentActor(T.eng); await move([ann,bob,dan].find((p)=>p.uid===uid),"fold"); } }
  await finish(); await move(ann,"sitin");
  let joined=false;
  for(let n=0;n<6;n++) {
    const r=await move(bob,"deal"); assert.ok(r.ok,r.reply);
    if(T.eng.players.includes("u1")) { assert.equal(T.eng.bb_key,"u1"); joined=true; break; }
    assert.equal(T.eng.hole.u1,undefined); await finish();
  }
  assert.ok(joined,"big-blind orbit reaches the returning seat");
});
test("bank refills per ten hands, is capped, and a deliberate action resets timeout streak", async () => {
  const {T,move}=await setup(2); T.qol.u1.bank=58; T.qol.u1.hands=9; T.qol.u1.timeouts=1;
  await move(ann,"fold"); assert.equal(T.qol.u1.timeouts,0);
  await move(bob,"deal"); assert.equal(T.qol.u1.bank,60); assert.equal(T.qol.u1.hands,10);
});
test("post now pays exactly one big blind, participates next hand, and preserves chip totals", async () => {
  const {T,move}=await setup(); await move(ann,"sitout"); await move(ann,"fold");
  while(T.eng.hand_active) { const uid=H.currentActor(T.eng); await move([bob,dan].find((p)=>p.uid===uid),"fold"); }
  await move(ann,"sitin",["post"]); const stack=T.eng.chips.u1;
  const before=Object.values(T.eng.chips).reduce((a,b)=>a+b,0);
  assert.ok((await move(bob,"deal")).ok);
  assert.ok(T.eng.players.includes("u1")); assert.equal(T.eng.contrib.u1,50); assert.equal(T.eng.chips.u1,stack-50);
  assert.equal(Object.values(T.eng.chips).reduce((a,b)=>a+b,0)+H.pot(T.eng),before);
});
test("exact call and check pre-moves play only at their unchanged price", async () => {
  const {T,move}=await setup();
  await move(bob,"pre",["call"]); await move(dan,"pre",["check"]);
  await move(ann,"call");
  assert.equal(T.eng.street,1); assert.deepEqual(T.pre,{});
  assert.equal(T.eng.contrib.u2,50); assert.equal(T.eng.contrib.u4,50);
  await move(ann,"pre",["check"]);
  await move(bob,"bet",["100"]);
  assert.equal(T.pre.u1,undefined);
});
test("time bank uses only elapsed time on an action and keeps normal action limits", async () => {
  const {T,tid,move}=await setup(); await later(60); NOW+=7000;
  await move(ann,"call"); assert.equal(T.qol.u1.bank,23);
  svc.S.rate.clear();
  for(let i=0;i<12;i++) assert.ok((await A(dan,"pre",["off"],{table:tid})).ok);
  assert.ok(!(await A(dan,"pre",["off"],{table:tid})).ok);
});
