// 1.99lv: the casino backend's No-Limit Hold'em (casino/hmengine.js, casino/holdem.js) + the shared bits added with it
// (one table per room across games, no site-wide table limit, table / proof links in chat, Pepe's stream slot):
//   * engine parity with Pepe's poker_engine.py (250 recorded tables: every event, stack and error text identical)
//   * the table session: buy-in charged, chips paid back on stand / bust / close / idle, the 2% rake to the House
//   * private hole cards: never in the public view or an event; the web gets only its own; Pepe's poll gets room players'
//   * timers (time-out = check, or fold + sit out; next hand; idle close), restart mid-hand, interrupted buy-in / cash-out
//   * anti-collusion basics (linked accounts, one address, repeated folds to one player), High Roller stakes
//   * the stream slot: first come, FIFO queue, admin override, released on close / idle
//   NODE_PATH=G:/PATV/node_modules node --test test/casino-hm.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "casino-hm-test-"));
process.chdir(tmp);
delete process.env.STAGING;
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const H = require(path.join(repo, "casino", "hmengine"));
const E = require(path.join(repo, "casino", "bjengine"));
const fair = require(path.join(repo, "casino", "fair"));
const svc = require(path.join(repo, "casino", "service"));
const funding = require(path.join(repo, "funding"));
const parity = require(path.join(__dirname, "casino-hm-parity"));

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

test("engine parity: 250 tables recorded from Pepe's poker_engine.py replay identically (events, stacks, errors)", () => {
  const st = parity.replay();
  assert.equal(st.vectors, 250);
  assert.ok(st.showdowns > 300 && st.sidepots > 100 && st.errors > 300 && st.rake > 0, JSON.stringify(st));
});

test("engine: hand ranks (wheel, royal, kickers) and side pots", () => {
  assert.equal(H.describe(H.bestHand(["As", "2d", "3c", "4h", "5s", "Kd", "Kc"])), "Straight, Five-high");
  assert.equal(H.describe(H.bestHand(["As", "Ks", "Qs", "Js", "Ts", "2d", "3c"])), "Royal Flush");
  assert.ok(H.cmp(H.eval5(["As", "Ad", "Kc", "Qh", "2s"]), H.eval5(["Ah", "Ac", "Kd", "Jh", "9s"])) > 0);
  const pots = H.buildPots(["a", "b", "c"], { a: 100, b: 300, c: 300 }, ["c"]);
  assert.deepEqual(pots, [{ amount: 300, eligible: ["a", "b"] }, { amount: 400, eligible: ["b"] }]);
});

test("a hand: buy-ins charged, showdown, the 2% rake to the House, the stack paid back on stand; links + proof in chat", async () => {
  await fresh();
  const tid = await table();
  const T = svc.getTable(tid);
  assert.ok(T.log.some((l) => l.text.includes(`/casino/holdem/t/${tid}`)), "the open line links the table's web page");
  assert.ok((await A(ann, "sit", ["1000"], { table: tid })).ok);
  assert.ok((await A(bob, "sit", ["1000"], { table: tid })).ok);
  assert.equal(await bal("u1"), 99000);
  deck(ACES);
  const commit = T.next.commitment;
  assert.ok((await A(ann, "deal", [], { table: tid })).ok);
  assert.equal(T.eng.hand_active, true);
  // public view: no hole cards anywhere
  const pub = JSON.stringify(svc.publicView(T));
  for (const c of ["As", "Ah", "Ks", "Kh"]) assert.ok(!pub.includes(`"${c}"`), "no hole card in the public view: " + c);
  const ev = JSON.stringify(await getQuery("SELECT data FROM casino_events"));
  assert.ok(!ev.includes('"Ks"') && !ev.includes('"As"'), "no hole card in any event");
  assert.deepEqual((await svc.meView(T, "u1")).cards, ["As", "Ah"]);
  assert.deepEqual((await svc.meView(T, "u2")).cards, ["Ks", "Kh"]);
  // heads-up: Ann is the button / small blind and acts first preflop; Bob first after the flop
  assert.ok((await A(ann, "call", [], { table: tid })).ok);
  assert.ok((await A(bob, "check", [], { table: tid })).ok);
  for (let i = 0; i < 3; i++) {
    assert.ok((await A(bob, "check", [], { table: tid })).ok);
    assert.ok((await A(ann, "check", [], { table: tid })).ok);
  }
  assert.equal(T.eng.hand_active, false);
  assert.equal(T.eng.chips.u1, 1048);                   // 100 pot - 2 rake
  assert.equal(T.eng.chips.u2, 950);
  assert.equal(await house(), 10000002);
  assert.ok(T.log.some((l) => l.text.includes(`/casino/fair/${tid}/1`)), "the hand's proof is linked in chat");
  const rec = await svc.fairRecord(tid, 1);
  assert.equal(rec.commitment, commit);
  assert.equal(fair.commitment(rec.server_seed), commit, "the deck was committed before the deal");
  assert.ok((await A(ann, "fair", [], { table: tid })).reply.includes(`/casino/fair/${tid}/1`));
  assert.ok((await A(ann, "stand", [], { table: tid })).ok);
  assert.equal(await bal("u1"), 99000 + 1048);
  assert.ok(T.log.some((l) => /cashes out 1,048/.test(l.text)));
  // Bob alone: the table waits, then closes idle and pays him
  await later(301);
  assert.equal(T.status, "closed");
  assert.equal(await bal("u2"), 99000 + 950);
});

test("time-outs: a check when free, a fold (and sat out) when facing a bet; the next hand deals itself", async () => {
  await fresh();
  const tid = await table();
  const T = svc.getTable(tid);
  await A(ann, "sit", ["1000"], { table: tid });
  await A(bob, "sit", ["1000"], { table: tid });
  await A(dan, "sit", ["1000"], { table: tid });
  deck(["As", "Ah", "Ks", "Kh", "Qs", "Qh", "2c", "7d", "9h", "3s", "4c"]);
  await A(ann, "deal", [], { table: tid });
  // 3-handed: button Ann, SB Bob, BB Dan, Ann first to act facing 50
  await later(61);
  assert.ok(T.eng.folded.includes("u1") && T.eng.leaving.includes("u1"), "folded on time-out and sat out");
  await A(bob, "call", [], { table: tid });
  await later(61);                                        // Dan can check: he checks
  assert.ok(T.log.some((l) => /Dan timed out — checks/.test(l.text)));
  for (let i = 0; i < 3; i++) { await A(bob, "check", [], { table: tid }); await A(dan, "check", [], { table: tid }); }
  assert.equal(T.eng.hand_active, false);
  assert.ok(!T.eng.seats.includes("u1"), "Ann was cashed out after the hand");
  assert.equal(await bal("u1"), 99000 + 1000);
  assert.ok(T.dl.next);
  await later(16);
  assert.equal(T.eng.hand_active, true, "the next hand dealt itself");
  assert.equal(T.eng.hand_no, 2);
});

test("restart mid-hand: the table reloads, the actor gets a fresh clock, the hand finishes; an interrupted buy-in is refunded", async () => {
  await fresh();
  const tid = await table();
  await A(ann, "sit", ["1000"], { table: tid });
  await A(bob, "sit", ["1000"], { table: tid });
  deck(ACES);
  await A(ann, "deal", [], { table: tid });
  NOW += 120 * 1000;
  svc.stop();
  await svc.boot({ tick: false });
  const T = svc.getTable(tid);
  assert.ok(T.eng.hand_active && T.dl.turn > NOW);
  await svc.tickOnce();
  assert.equal(T.eng.hand_active, true, "not timed out by the restart");
  await A(ann, "fold", [], { table: tid });
  assert.equal(T.eng.chips.u2, 1025);
  // a buy-in charged but never seated
  const money = require(path.join(repo, "casino", "money"));
  const kk = `chm:${tid}:u4:buy:99`;
  assert.ok((await money.charge(kk, "u4", 700, "holdem buy-in")).ok);
  const row = JSON.parse((await getQuery("SELECT state FROM casino_tables WHERE id = ?", [tid]))[0].state);
  row.intent = { kind: "buy", key: kk, uid: "u4", amount: 700 };
  await runQuery("UPDATE casino_tables SET state = ? WHERE id = ?", [JSON.stringify(row), tid]);
  svc.stop();
  await svc.boot({ tick: false });
  assert.equal(await bal("u4"), 100000);
});

test("an interrupted cash-out is finished at restart, paid exactly once", async () => {
  await fresh();
  const tid = await table();
  await A(ann, "sit", ["1000"], { table: tid });
  await A(bob, "sit", ["1000"], { table: tid });
  const row = JSON.parse((await getQuery("SELECT state FROM casino_tables WHERE id = ?", [tid]))[0].state);
  row.intent = { kind: "out", key: `chm:${tid}:u1:out:77`, uid: "u1", amount: 1000 };
  await runQuery("UPDATE casino_tables SET state = ? WHERE id = ?", [JSON.stringify(row), tid]);
  svc.stop();
  await svc.boot({ tick: false });
  assert.equal(await bal("u1"), 100000);
  assert.ok(!svc.getTable(tid).eng.seats.includes("u1"));
  svc.stop();
  await svc.boot({ tick: false });
  assert.equal(await bal("u1"), 100000, "not twice");
});

test("limits: blinds cap, buy-in range, High Roller stakes, top-ups between hands only, casino ban", async () => {
  await fresh();
  let r = await A(ann, "start", ["10000/20000"], { room: null });
  assert.match(r.reply, /max blinds are 5,000\/10,000\. 💎 High Roller tables play 100K\/200K, 250K\/500K, 500K\/1M, 1M\/2M, 2\.5M\/5M, 5M\/10M\./);
  assert.match((await A(ann, "start", ["100k/200k"], { room: null })).reply, /High Roller tables are for High Rollers/);
  await runQuery("INSERT INTO user_roles (userId, role) VALUES ('u1', 'High Roller')");
  r = await A(ann, "start", ["10000/20000"], { room: null });
  assert.match(r.reply, /max blinds are 5,000\/10,000/, "1.99ov: off the ladder - not even for a High Roller");
  r = await A(ann, "start", ["2.5m/5m"], { room: null });
  assert.ok(r.ok, "a High Roller opens a ladder table");
  const hrT = svc.getTable(r.table);
  assert.ok(hrT.high_stakes);
  assert.deepEqual([hrT.eng.sb, hrT.eng.bb, hrT.min_buy, hrT.max_buy], [2500000, 5000000, 100000000, 1000000000]);
  assert.equal(svc.lobby().find((x) => x.id === r.table).high_stakes, true);
  assert.match((await A(bob, "sit", ["100000000"], { table: r.table })).reply, /only High Rollers can sit here/);
  await A(ann, "end", [], { table: r.table });
  r = await A(ann, "start", ["hr"], { room: null });
  assert.deepEqual([svc.getTable(r.table).eng.sb, svc.getTable(r.table).eng.bb], [100000, 200000], "!holdem start hr = the ladder's first rung");
  await A(ann, "end", [], { table: r.table });
  const tid = await table("25/50");
  assert.match((await A(bob, "sit", ["500"], { table: tid })).reply, /buy-in must be 1,000–10,000/);
  assert.match((await A(bob, "sit", ["20000"], { table: tid })).reply, /buy-in must be 1,000–10,000 for these stakes\.$/);
  assert.match((await A(ann, "sit", ["20000"], { table: tid })).reply, /buy-in must be 1,000–10,000/, "1.99ov: a High Roller can't buy in over the max");
  assert.ok((await A(ann, "sit", ["10000"], { table: tid })).ok);
  assert.match((await A(ann, "sit", ["1000"], { table: tid })).reply, /over the 10,000 max\.$/);
  await runQuery("UPDATE users SET casino_banned = 1 WHERE userId = 'u4'");
  assert.match((await A(dan, "sit", ["1000"], { table: tid })).reply, /banned/);
  await A(bob, "sit", ["1000"], { table: tid });
  deck(ACES);
  await A(ann, "deal", [], { table: tid });
  assert.match((await A(bob, "sit", ["1000"], { table: tid })).reply, /between hands/);
});

test("anti-collusion: linked accounts and one address can't share a table; repeated folds to one player are flagged", async () => {
  await fresh();
  await runQuery("INSERT INTO welcome_bonus (userId, dup_of) VALUES ('u4', 'u1')");
  const tid = await table();
  const T = svc.getTable(tid);
  await A(ann, "sit", ["5000"], { table: tid });
  assert.match((await A(dan, "sit", ["1000"], { table: tid })).reply, /linked to yours/);
  await A(bob, "sit", ["10000"], { table: tid });
  assert.match((await A(cat, "sit", ["1000"], { table: tid })).reply, /another account from your connection/);
  // Ann folds to Bob 5 times after putting chips in
  for (let i = 0; i < 8 && !T.multi.some((m) => m.kind === "repeated folds to one player"); i++) {
    svc.S.rate.clear();                                   // the test clock stands still: keep under the per-user rate limit
    deck(ACES);
    await A(ann, "deal", [], { table: tid });
    const actor = H.currentActor(T.eng);
    if (actor === "u1") { await A(ann, "raise", ["600"], { table: tid }); await A(bob, "raise", ["2000"], { table: tid }); await A(ann, "fold", [], { table: tid }); }
    else { await A(bob, "raise", ["600"], { table: tid }); await A(ann, "raise", ["1200"], { table: tid }); await A(bob, "raise", ["3000"], { table: tid }); await A(ann, "fold", [], { table: tid }); }
    if ((T.eng.chips.u1 || 0) < 2000) await A(ann, "sit", ["3000"], { table: tid });
    if ((T.eng.chips.u2 || 0) < 4000) await A(bob, "sit", ["4000"], { table: tid });
  }
  assert.ok(T.multi.some((m) => m.kind === "repeated folds to one player"), JSON.stringify(T.multi) + " / " + JSON.stringify(T.dump) + " / " + T.log.slice(-12).map((l) => l.text).join(" / "));
});

test("rooms: one table per room across both games; no site-wide limit; Pepe's poll carries room players' cards, privately", async () => {
  await fresh();
  svc.noteRooms([{ id: "PepeLab", name: "Pepe Lab" }]);
  const tid = await table("25/50", { room: "PepeLab" });
  const r = await svc.act(bob, "start", [], { room: "PepeLab", game: "bj" }, key());
  assert.match(r.reply, /Hold'em table is already open here/);
  const bjr = await svc.act(bob, "bet", ["100"], { room: "PepeLab", table: tid }, key());
  assert.match(bjr.reply, /no Hold'em hand in progress/, "a bare !bet at a Hold'em table is the Hold'em verb");
  for (let i = 0; i < 6; i++) assert.ok((await svc.act(dan, "start", [], { room: null, game: i % 2 ? "bj" : "holdem" }, key())).ok, "no limit");
  await A(ann, "sit", ["1000"], { table: tid });
  await A(bob, "sit", ["1000"], { table: tid });
  deck(ACES);
  await A(ann, "deal", [], { table: tid });
  const p = await svc.poll(-1, 0);
  assert.deepEqual(p.private.anncf.cards, ["As", "Ah"], "Ann (a Camfrog player) gets her cards through Pepe");
  assert.equal(Object.keys(p.private).length, 1, "Bob has no Camfrog name: nobody gets his");
  assert.ok(!JSON.stringify(p.tables).includes('"Ks"'));
  assert.match((await A(ann, "cards", [], { table: tid })).reply, /A♠ A♥/);
  assert.ok((await A(ann, "cards", [], { table: tid })).pm, "!cards answers privately");
});

test("1.99ox cross-room: one table in several Camfrog rooms - events to every room, cards PM'd per room, one table per room", async () => {
  await fresh();
  svc.noteRooms([{ id: "RA", name: "Room A" }, { id: "RB", name: "Room B" }, { id: "RC", name: "Room C" }]);
  const tid = await table("25/50", { room: "RA" });
  const T = svc.getTable(tid);
  assert.match((await svc.push(tid, "RB", bob, "add")).reply, /host or an admin/);
  const r = await svc.push(tid, "RB", ann, "add");
  assert.ok(r.ok, r.reply);
  assert.deepEqual(T.rooms, ["RA", "RB"]);
  assert.equal(T.room, "RA", "the home room stays first");
  assert.equal(svc.tableForRoom("RB").id, tid);
  assert.deepEqual(svc.publicView(T).rooms, [{ id: "RA", name: "Room A" }, { id: "RB", name: "Room B" }]);
  assert.deepEqual(svc.lobby().find((x) => x.id === tid).rooms.map((x) => x.id), ["RA", "RB"]);
  // still one table per room: RB can't open its own, and RB can't be attached to a second table
  assert.match((await svc.act(dan, "start", [], { room: "RB", game: "bj" }, key())).reply, /already open/);
  const other = (await svc.act(dan, "start", ["25/50"], { room: "RC", game: "holdem" }, key())).table;
  assert.match((await svc.push(other, "RB", dan, "add")).reply, /already has a casino table/);
  // a player in each room: Ann from RA, Bob from RB (a Camfrog player there)
  const bobRB = Object.assign({}, bob, { camfrog: "BobCF", via: "room", room: "RB", iph: null });
  const annRA = Object.assign({}, ann, { room: "RA" });
  await A(annRA, "sit", ["1000"], { table: tid });
  await A(bobRB, "sit", ["1000"], { table: tid });
  assert.equal(await bal("u2"), 99000, "money as before: the buy-in once");
  const before = svc.S.lastSeq;
  deck(ACES);
  await A(annRA, "deal", [], { table: tid });
  const p = await svc.poll(before, 0);
  assert.equal(p.private.anncf.room, "RA");
  assert.equal(p.private.bobcf.room, "RB", "Bob's hole cards are PM'd in the room he plays from");
  const evs = p.events.filter((e) => e.table === tid);
  assert.ok(evs.length > 0);
  for (const e of evs) assert.deepEqual(e.data.rooms, ["RA", "RB"], "every event goes to both rooms");
  // the push / leave announcements go to the rooms they concern
  const all = (await svc.poll(0, 0)).events.filter((e) => e.table === tid);
  const pushed = all.find((e) => e.kind === "pushed");
  assert.deepEqual(pushed.data.rooms, ["RB"]);
  assert.match(pushed.data.text, /Also playing in Room A/);
  assert.ok(all.some((e) => e.kind === "line" && /also playing in Room B/.test(e.data.text) && e.data.rooms.join() === "RA"));
  // detach the HOME room: RB becomes home; the table keeps playing
  const rm = await svc.push(tid, "RA", ann, "remove");
  assert.ok(rm.ok, rm.reply);
  assert.deepEqual(T.rooms, ["RB"]);
  assert.equal(T.room, "RB");
  assert.equal(svc.tableForRoom("RA"), null);
  const un = (await svc.poll(0, 0)).events.filter((e) => e.table === tid && e.kind === "unpushed");
  assert.deepEqual(un[un.length - 1].data.rooms, ["RA"]);
  // web only
  assert.ok((await svc.push(tid, null, ann)).ok);
  assert.deepEqual(T.rooms, []);
  assert.equal(T.room, null);
  // 1.99sk: no push spam - removing and re-adding a room inside 10 minutes re-attaches it silently
  const s1 = svc.S.lastSeq;
  const again = await svc.push(tid, "RB", ann, "add");
  assert.ok(again.ok && /no new announcement/.test(again.reply), again.reply);
  assert.deepEqual(T.rooms, ["RB"], "the room is attached (gameplay works) even without the announcement");
  assert.ok((await svc.push(tid, "RB", ann, "remove")).ok);
  assert.ok((await svc.push(tid, "RB", ann, "add")).ok);
  const quietEvs = (await svc.poll(s1, 0)).events.filter((e) => e.table === tid && ["pushed", "unpushed"].includes(e.kind));
  assert.equal(quietEvs.length, 0, `no pushed / left lines inside the window: ${quietEvs.map((e) => e.kind)}`);
  // after the window it's announced again
  for (const m of [T.push_ts, T.unpush_ts]) for (const k of Object.keys(m || {})) m[k] -= svc.PUSH_ANNOUNCE_MS;
  assert.ok((await svc.push(tid, "RB", ann, "remove")).ok);
  const back = await svc.push(tid, "RB", ann, "add");
  assert.equal(back.reply, "Announced in the room.");
  const s2evs = (await svc.poll(s1, 0)).events.filter((e) => e.table === tid);
  assert.equal(s2evs.filter((e) => e.kind === "pushed").length, 1);
  assert.equal(s2evs.filter((e) => e.kind === "unpushed").length, 1);
});

test("1.99pc adverts: one line (+ rate-limited reminders) in other rooms, never the gameplay; host only; a chat command", async () => {
  await fresh();
  svc.noteRooms([{ id: "RA", name: "Room A" }, { id: "RB", name: "Room B" }, { id: "RC", name: "Room C" }]);
  const tid = await table("25/50", { room: "RA" });
  const T = svc.getTable(tid);
  const s0 = svc.S.lastSeq;
  assert.match((await svc.advertise(tid, "RB", bob, true)).reply, /host or an admin/);
  assert.match((await svc.advertise(tid, "Nowhere", ann, true)).reply, /isn't in that room/);
  assert.match((await svc.advertise(tid, "RA", ann, true)).reply, /already playing in that room/);
  const r = await svc.advertise(tid, "room b", ann, true);              // by display name
  assert.ok(r.ok, r.reply);
  assert.deepEqual(T.adverts, ["RB"]);
  assert.deepEqual(svc.publicView(T).adverts, [{ id: "RB", name: "Room B" }]);
  assert.deepEqual(svc.lobby().find((x) => x.id === tid).adverts.map((x) => x.id), ["RB"]);
  // the chat command from the table's room (bot/act: room RA -> this table)
  const c = await svc.act(ann, "advertise", ["RC"], { room: "RA", table: tid, game: "holdem" }, key());
  assert.ok(c.ok, c.reply);
  assert.deepEqual(T.adverts, ["RB", "RC"]);
  await A(ann, "sit", ["1000"], { table: tid });
  await A(bob, "sit", ["1000"], { table: tid });
  deck(ACES);
  await A(ann, "deal", [], { table: tid });
  const evs = (await svc.poll(s0, 0)).events.filter((e) => e.table === tid);
  const ads = evs.filter((e) => e.kind === "advert");
  assert.equal(ads.length, 2, "one line per advertised room, no reminder within 10 minutes");
  assert.match(ads[0].data.text, /No-Limit Hold'em at Ann's table — blinds 25\/50, \d seats? free\. Play on the web: .*\/casino\/holdem\/t\//);
  for (const e of evs.filter((x) => x.kind !== "advert")) {
    assert.ok(!(e.data.rooms || []).some((x) => x === "RB" || x === "RC") && e.room === "RA", "no gameplay in advertised rooms");
  }
  // a reminder when a hand is about to start, once 10 minutes have passed
  for (const k of Object.keys(T.advert_ts)) T.advert_ts[k] -= svc.ADVERT_REPEAT_MS;
  const s1 = svc.S.lastSeq;
  await svc.HM.recover(T).catch(() => {});
  const H2 = require("../casino/hmengine");
  while (T.eng.hand_active) { const k = H2.currentActor(T.eng); await A(k === "u1" ? ann : bob, "fold", [], { table: tid }); }
  T.dl.next = null;
  svc.S.rate.clear();
  await A(ann, "deal", [], { table: tid });
  const rem = (await svc.poll(s1, 0)).events.filter((e) => e.table === tid && e.kind === "advert");
  assert.equal(rem.length, 1);
  assert.deepEqual(rem[0].data.rooms, ["RB", "RC"]);
  assert.equal(rem[0].data.repeat, true);
  assert.ok((await svc.act(ann, "unadvertise", ["RB"], { room: "RA", table: tid, game: "holdem" }, key())).ok);
  assert.deepEqual(T.adverts, ["RC"]);
  // a web-only table's advert still reaches Pepe (the event's room is the advertised one)
  const web = await table("25/50");
  const s2 = svc.S.lastSeq;
  assert.ok((await svc.advertise(web, "RB", ann, true)).ok);
  const we = (await svc.poll(s2, 0)).events.filter((e) => e.table === web);
  assert.equal(we.length, 1);
  assert.equal(we[0].room, "RB");
  // 1.99se: no spam - advertising again, or stop + advertise, inside the 10 minutes posts nothing new
  const s3 = svc.S.lastSeq;
  const again = await svc.advertise(web, "RB", ann, true);
  assert.ok(again.ok && /recently/.test(again.reply), again.reply);
  assert.ok((await svc.advertise(web, "RB", ann, false)).ok);
  assert.ok((await svc.advertise(web, "RB", ann, true)).ok);
  assert.deepEqual(svc.getTable(web).adverts, ["RB"]);
  assert.equal((await svc.poll(s3, 0)).events.filter((e) => e.table === web && e.kind === "advert").length, 0);
});

test("Pepe's stream: first come, a FIFO queue, admin override, released when the table closes or goes idle", async () => {
  await fresh();
  svc.noteRooms([{ id: "R1", name: "One" }, { id: "R2", name: "Two" }, { id: "R3", name: "Three" }]);
  const t1 = (await svc.act(ann, "start", ["25/50"], { room: "R1", game: "holdem" }, key())).table;
  const t2 = (await svc.act(bob, "start", [], { room: "R2", game: "bj" }, key())).table;
  const t3 = (await svc.act(dan, "start", ["25/50"], { room: "R3", game: "holdem" }, key())).table;
  const t4 = (await svc.act(eve, "start", ["25/50"], { room: null, game: "holdem" }, key())).table;
  assert.match((await svc.stream(t1, true, bob)).reply, /host or an admin/);
  assert.ok((await svc.stream(t1, true, ann)).reply.includes("on Pepe's stream"));
  assert.match((await svc.stream(t2, true, bob)).reply, /you're next in line/);
  assert.match((await svc.stream(t3, true, dan)).reply, /number 2 in line/);
  assert.equal(svc.publicView(svc.getTable(t3)).stream_queue, 2);
  // an admin override: t3 now, t1 back to the head of the queue
  assert.match((await svc.stream(t3, true, Object.assign({}, eve, { admin: true }), true)).reply, /override/);
  assert.equal(svc.S.stream.table, t3);
  assert.deepEqual(svc.S.stream.queue, [t1, t2]);
  // t3 closes -> t1 takes it
  await svc.act(dan, "end", [], { table: t3 }, key());
  assert.equal(svc.S.stream.table, t1);
  // 5 minutes on the stream with no hand dealt -> released, the next in line (t2) takes it
  svc.getTable(t1).last_activity = NOW - 6 * 60 * 1000;
  svc.S.stream.ts = NOW - 6 * 60 * 1000;
  await svc.tickOnce();
  assert.equal(svc.S.stream.table, t2);
  assert.ok(svc.getTable(t1).log.some((l) => /no round in 5 minutes/.test(l.text)));
  assert.ok(svc.getTable(t2).log.some((l) => /on Pepe's stream now/.test(l.text)));
  // the poll tells Pepe which table is on stream
  assert.equal((await svc.poll(-1, 0)).stream, svc.S.stream.table);
  // 1.99pc: a web-only table can be on Pepe's stream too, and the poll always carries the stream table
  assert.match((await svc.stream(t4, true, eve)).reply, /next in line/);
  await svc.act(bob, "end", [], { table: t2 }, key());
  assert.equal(svc.S.stream.table, t4);
  const pl = await svc.poll(-1, 0);
  assert.equal(pl.stream, t4);
  assert.ok(pl.tables[t4] && pl.tables[t4].room === null, "the web-only stream table rides in the poll");
  assert.ok(svc.openList().some((x) => x.id === t4 && x.game === "holdem" && x.bb === 50));
});

test("blackjack: the open line links the table, each round links its proof, !bj fair answers", async () => {
  await fresh();
  const r = await svc.act(ann, "start", [], { room: null, game: "bj" }, key());
  const T = svc.getTable(r.table);
  assert.ok(T.log.some((l) => l.text.includes(`/casino/blackjack/t/${T.id}`)));
  svc.S.hooks.shoe = () => ["Ts", "9h", "Qd", "7d", "Kc"].concat(E.makeShoe(6));
  await svc.act(ann, "bet", ["100"], { table: T.id }, key());
  await svc.act(ann, "deal", [], { table: T.id }, key());
  await svc.act(ann, "stand", [], { table: T.id }, key());
  assert.ok(T.log.some((l) => l.text.includes(`/casino/fair/${T.id}/1`)));
  assert.ok((await svc.act(ann, "fair", [], { table: T.id }, key())).reply.includes(`/casino/fair/${T.id}/1`));
});

test("HTTP: a web player opens a Hold'em table, sits, and sees ONLY their own hole cards", async () => {
  await fresh();
  const express = require("express");
  const routes = require(path.join(repo, "casino", "routes"));
  const app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  const users = { u2: { userId: "u2" }, u5: { userId: "u5" } };
  app.use((req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users[u] || null : null; next(); });
  routes.register(app, { isBotToken: (p) => p === "tok", addUser: (req, res, next) => next() });
  const server = app.listen(0);
  const base = "http://127.0.0.1:" + server.address().port;
  const J = (uid) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" },
                                   uid ? { "x-test-user": uid, "x-forwarded-for": "10.0.0." + uid.slice(1) } : {});
  const post = async (url, body, uid) => { const r = await fetch(base + url, { method: "POST", headers: J(uid), body: JSON.stringify(body) }); return { status: r.status, j: await r.json() }; };
  try {
    let r = await post("/api/casino/open", { game: "holdem", blinds: "10/20", idem: "open-hm-0001" }, "u2");
    assert.equal(r.status, 200, JSON.stringify(r.j));
    const tid = r.j.table;
    assert.ok((await post(`/api/casino/t/${tid}/act`, { verb: "sit", amount: 1000, idem: "sit-bob-0001" }, "u2")).j.ok);
    assert.ok((await post(`/api/casino/t/${tid}/act`, { verb: "sit", amount: 1000, idem: "sit-eve-0001" }, "u5")).j.ok);
    deck(ACES);
    assert.ok((await post(`/api/casino/t/${tid}/act`, { verb: "deal", idem: "deal-0001" }, "u2")).j.ok);
    const sb = await (await fetch(base + `/api/casino/t/${tid}`, { headers: J("u2") })).json();
    const se = await (await fetch(base + `/api/casino/t/${tid}`, { headers: J("u5") })).json();
    const anon = await (await fetch(base + `/api/casino/t/${tid}`)).text();
    assert.deepEqual(sb.me.cards, ["As", "Ah"]);
    assert.deepEqual(se.me.cards, ["Ks", "Kh"]);
    assert.ok(!JSON.stringify(sb.table).includes('"Ks"') && !JSON.stringify(se.table).includes('"As"'), "nobody else's cards");
    assert.ok(!anon.includes('"As"') && !anon.includes('"Ks"'), "a spectator sees no hole cards");
    const g = await fetch(base + `/casino/holdem/t/${tid}`);
    assert.equal(g.status, 200);
    assert.match(await g.text(), /casinohm\.js/);
    const g2 = await fetch(base + `/casino/blackjack/t/${tid}`, { redirect: "manual" });
    assert.equal(g2.status, 302, "a Hold'em table's id on the blackjack page goes to its own page");
  } finally {
    server.close();
  }
});
