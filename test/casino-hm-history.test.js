// Own-hand replay, showdown display and privacy integration tests on the real service.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "casino-history-test-"));
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

async function hand(show=false) {
  await fresh(); const tid=await table();
  const move=async(p,v,a=[])=>{svc.S.rate.clear();return A(p,v,a,{table:tid});};
  await move(ann,"sit",["2000"]); await move(bob,"sit",["2000"]);
  if(show) await move(bob,"showhand",["1"]);
  deck(ACES); await move(ann,"deal");
  const T=svc.getTable(tid);
  while(T.eng.hand_active) { const uid=H.currentActor(T.eng); assert.ok((await move(uid==="u1"?ann:bob,H.toCall(T.eng,uid)?"call":"check")).ok); }
  return {tid,T,move};
}
test("own history excludes nonparticipants and unshown opponent cards; replay conserves chips",async()=>{
  const {tid,T}=await hand();
  const hands=await svc.myHands("u1",20); assert.equal(hands.length,1); const h=hands[0];
  assert.deepEqual(h.cards,["As","Ah"]); assert.equal(h.net,48);
  assert.ok(!JSON.stringify(h).includes('"Ks"')); assert.ok(!JSON.stringify(h).includes('"u2"'));
  assert.equal((await svc.myHands("u5",20)).length,0);
  assert.deepEqual((await svc.myHands("u2",20))[0].cards,["Ks","Kh"]);
  assert.ok(h.replay.some((s)=>s.action==="calls"&&s.amount===25));
  assert.deepEqual(h.replay.filter((s)=>s.action==="board").map((s)=>s.street),["flop","turn","river"]);
  assert.equal(h.replay.at(-1).pot,0); assert.equal(h.replay.at(-1).stacks.reduce((sum,s)=>sum+s.stack,0),3998);
  assert.equal(h.proof,`/casino/fair/${tid}/1`);
  assert.equal(T.last_round.shown.length,1);
  const showdown=(await getQuery("SELECT data FROM casino_events WHERE table_id=? AND kind='showdown'",[tid])).map((r)=>JSON.parse(r.data));
  assert.equal(showdown[0].shown.length,1); assert.ok(!JSON.stringify(showdown).includes("Ks"));
  assert.ok(!T.log.some((l)=>l.text.includes("K♠")));
  const proof=await svc.fairRecord(tid,1); assert.ok(proof.shoe.includes("Ks")); assert.equal(proof.verified,false); // deterministic fixture deck, not the seed's shuffle
});
test("show preference reveals a losing hand in the table, log, room event and own history",async()=>{
  const {tid,T}=await hand(true); assert.equal(T.last_round.shown.length,2);
  assert.ok(T.log.some((l)=>l.text.includes("K♠")));
  const events=await getQuery("SELECT data FROM casino_events WHERE table_id=? AND kind='showdown'",[tid]);
  assert.ok(events[0].data.includes("Ks"));
  const h=(await svc.myHands("u1"))[0]; assert.equal(h.shown.length,2); assert.ok(JSON.stringify(h).includes('"Ks"'));
});
test("replay labels retain casino masking and never expose raw identity keys",async()=>{
  const V=require(path.join(repo,"casino/veil"));
  V._hooks.kind=async(keys)=>keys.includes("u:u2")?"incognito":null; V._reset();
  // The fixture's first fresh() boots before these actors act, so each masked seat is entered at the source.
  const {tid,T}=await hand(true);
  const h=(await svc.myHands("u1"))[0], wire=JSON.stringify(h);
  assert.ok(!wire.includes('"Bob"')); assert.ok(!wire.includes('"u2"'));
  assert.ok(!h.players.some((p)=>p.seat===svc.uidHash("u2")));
  svc.stop(); await svc.boot({tick:false});
  assert.ok(!JSON.stringify(await svc.myHands("u1")).includes('"Bob"'));
  V._hooks.kind=async()=>null; V._reset();
});
test("older hands retain own cards and proof but advertise replay as unavailable",async()=>{
  const {tid}=await hand(); await runQuery("DELETE FROM casino_actions WHERE key=?",[`hm-replay:${tid}:1`]);
  const h=(await svc.myHands("u1"))[0]; assert.deepEqual(h.cards,["As","Ah"]); assert.deepEqual(h.replay,[]);
});
test("a later veil masks old replay labels even after the table closes and restarts",async()=>{
  const {T,move}=await hand(true); const V=require(path.join(repo,"casino/veil"));
  V._hooks.kind=async(keys)=>keys.includes("u:u2")?"incognito":null; V._reset(); NOW+=3000;
  let h=(await svc.myHands("u1"))[0]; assert.ok(!JSON.stringify(h).includes('"Bob"'));
  assert.equal(h.players[1].name,"someone");
  await move(ann,"end"); svc.stop(); await svc.boot({tick:false}); V._reset();
  h=(await svc.myHands("u1"))[0]; assert.ok(!JSON.stringify(h).includes('"Bob"'));
  V._hooks.kind=async()=>null; V._reset();
});
test("history HTTP endpoint requires sign-in, is private, and ignores requested identities",async()=>{
  await hand(); const express=require("express"), app=express(); app.use(express.json());
  app.use((req,res,next)=>{req.user=req.get("x-test-user")?{userId:req.get("x-test-user")}:null;next();});
  require(path.join(repo,"casino/routes")).register(app,{isBotToken:()=>false,addUser:(req,res,next)=>next()});
  const server=app.listen(0,"127.0.0.1"); await new Promise((r)=>server.once("listening",r)); const base="http://127.0.0.1:"+server.address().port;
  try {
    assert.equal((await fetch(base+"/api/casino/me/hands")).status,401);
    const r=await fetch(base+"/api/casino/me/hands?uid=u1",{headers:{"x-test-user":"u5"}});
    assert.equal(r.headers.get("cache-control"),"no-store"); assert.deepEqual((await r.json()).hands,[]);
    // 1.99?? train3 verify: 20 a minute per account (each call scans the finished rounds)
    const codes=[];
    for(let i=0;i<22;i++) codes.push((await fetch(base+"/api/casino/me/hands",{headers:{"x-test-user":"u6"}})).status);
    assert.deepEqual(codes.slice(0,19),Array(19).fill(200)); assert.deepEqual(codes.slice(19),[200,429,429]);
    assert.equal((await fetch(base+"/api/casino/me/hands",{headers:{"x-test-user":"u7"}})).status,200,"another account isn't held up");
  } finally {server.close();}
});
test("replay accounts for all-ins, uncalled refunds, side pots and rake without revealing a mucked hand",async()=>{
  await fresh(); const tid=await table(); const move=async(p,v,a=[])=>{svc.S.rate.clear();return A(p,v,a,{table:tid});};
  for(const [p,stack] of [[ann,1000],[bob,2000],[dan,3000]]) await move(p,"sit",[String(stack)]);
  deck(["As","Ah","Ks","Kh","Qs","Qh","2c","7d","9h","3s","4c"]);
  await move(ann,"deal"); await move(ann,"allin"); await move(bob,"allin"); await move(dan,"allin");
  const h=(await svc.myHands("u1"))[0], end=h.replay.at(-1);
  assert.equal(end.pot,0); assert.equal(end.stacks.reduce((sum,p)=>sum+p.stack,0),5900);
  assert.equal(h.net,1940); assert.equal(h.pots.length,2);
  assert.ok(h.replay.some((s)=>s.action==="refund"&&s.amount===1000));
  assert.equal(h.shown.length,2); assert.ok(!JSON.stringify(h).includes('"Qs"'));
});
