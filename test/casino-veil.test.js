"use strict";
// 1.99?? casino2 rework (the owner, 2026-11-04, on incognito players at the casino tables: "Yes, just show them masked at the table if
// incognito is on."): casino/veil.js. A veiled player's seat is MASKED - a frog name or "someone", no picture, a seat id of its own -
// in every web-facing name the table has, and so on Pepe's OBS board (the table state Pepe polls):
//   * the table view (seat, turn, host, the felt's last round / hand, the log), the people answer, the lobby, the history and the
//     fairness record; never the account's seat hash (the same at every table) and never the name anywhere on the wire
//   * the log and the last round are WRITTEN masked (casino_rounds.results too) - never unmasked later; anything still naming a person
//     masked now is masked again on the way out (a line from before they switched on)
//   * a seat session keeps its mask: incognito switched OFF mid-session leaves the seat masked until they leave (+ LEAVE_GRACE_MS);
//     switched ON mid-session (or sitting down within 15 minutes of being shown named here) masks it as "someone" (frognames C.2)
//   * Camfrog room lines / replies to a Camfrog player keep a ROOM player's name (the room sees them type); a WEBSITE player is their label
//     there too; a reply to a website player is masked for everyone
//   * fail closed: a hidden set loading / a failed read masks everyone for that answer only - nothing is kept
//   node --test test/casino-veil.test.js      (uses a temp DB)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "casino-veil-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.ALIAS_SECRET = "c4".repeat(32);
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const E = require(path.join(repo, "casino", "bjengine"));
const HE = require(path.join(repo, "casino", "hmengine"));
const svc = require(path.join(repo, "casino", "service"));
const V = require(path.join(repo, "casino", "veil"));
const F = require(path.join(repo, "frognames"));
const funding = require(path.join(repo, "funding"));

// who is veiled: chat key -> kind (the real read is padweb.hiddenKey + incognito_state - casino-people.test.js drives that one)
const VK = new Map();
V._hooks.kind = async (keys) => { for (const k of keys) if (VK.has(k)) return VK.get(k); return null; };
let NOW = Date.UTC(2026, 10, 4, 18, 0, 0);
svc.S.hooks.now = () => NOW;
const tick = (secs) => { NOW += secs * 1000; V._reset(); };         // (a veil re-read is at most every 2 s per table)
let kn = 0;
const key = () => `veil-key-${++kn}`;
const mk = (uid, name, extra) => Object.assign({ uid, name, username: name.toLowerCase(), camfrog: null, via: "web", iph: null, admin: false }, extra || {});
const ann = mk("u1", "Ann");
const bob = mk("u2", "Bob");                                        // a web player (incognito by his account key in most tests)
const cat = mk("u3", "Cat");
const dan = mk("u4", "Dan", { camfrog: "DanCF", via: "room", room: "Casino.Room" });   // a Camfrog room player
const eve = mk("u5", "Eve");
const A = async (who, verb, args, opts) => { const r = await svc.act(Object.assign({}, who), verb, args || [], opts || {}, key()); if (!r.ok && process.env.VDBG) console.log("REPLY", who.name, verb, r.reply); return r; };
const isFrog = (n) => typeof n === "string" && F.ADJ.some((a) => n.startsWith(a + " ")) && F.NOUN.some((x) => n.endsWith(" " + x));

let server, base;
const users = { u1: { userId: "u1" }, u2: { userId: "u2" }, u3: { userId: "u3" }, u4: { userId: "u4" }, u5: { userId: "u5" } };
const H = (uid) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, uid ? { "x-test-user": uid } : {});
const get = async (url, uid) => { const r = await fetch(base + url, { headers: H(uid) }); const text = await r.text(); return { text, d: JSON.parse(text) }; };

async function fresh() {
  svc.stop();
  svc.S.hooks.shoe = null; svc.S.hooks.deck = null;
  svc.S.rate.clear();
  for (const t of ["casino_tables", "casino_events", "casino_rounds", "casino_actions", "transactions", "reserve_claims"]) await runQuery(`DELETE FROM ${t}`).catch(() => {});
  for (const u of ["u1", "u2", "u3", "u4", "u5"]) await runQuery("UPDATE users SET points_balance = 1000000 WHERE userId = ?", [u]);
  svc.S.tables.clear();
  svc.S.stream.table = null; svc.S.stream.queue = [];
  VK.clear(); V._reset();
  funding.sync({});
  await svc.boot({ tick: false });
  await svc.setSetting("bj_enabled", "1", "test");
  await svc.setSetting("hm_enabled", "1", "test");
}
/** play out a blackjack round: everyone stands when it's their turn */
async function playRound(tid, who) {
  for (let i = 0; i < 12; i++) {
    const T = svc.getTable(tid);
    if (!T.turn) break;
    const p = who.find((x) => x.uid === T.turn.uid);
    assert.ok(p, "someone's turn");
    const r = await A(p, "stand", [], { table: tid });
    assert.ok(r.ok, r.reply);
  }
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, level INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery(`CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL, points INTEGER NOT NULL,
                  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE user_roles (userId TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (userId, role))");
  await runQuery("CREATE TABLE welcome_bonus (userId TEXT PRIMARY KEY, dup_of TEXT)");
  for (const [id, u, d, cf, av] of [["u1", "ann", "Ann", null, "https://cdn.example/ann.png"], ["u2", "bob", "Bob", null, "https://cdn.example/bob.png"],
                                    ["u3", "cat", "Cat", null, "https://cdn.example/cat.png"], ["u4", "dan", "Dan", "DanCF", "https://cdn.example/dan.png"],
                                    ["u5", "eve", "Eve", null, null]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, points_balance, avatar) VALUES (?, ?, ?, 'x', ?, 1000000, ?)", [id, u, d, cf, av]);
  }
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, amount) VALUES ('seed', 'seed', 100000000)");
  await funding.init();
  await svc.boot({ tick: false });
  const express = require("express");
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users[u] || null : null; next(); });
  require(path.join(repo, "casino", "routes")).register(app, { isBotToken: () => false, addUser: (req, res, next) => next() });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { svc.stop(); if (server) server.close(); });

test("blackjack: an incognito web player is a frog name under a seat id of its own - no picture, no name, no account seat hash anywhere a page or Pepe's board reads", async () => {
  await fresh();
  VK.set("u:u2", "incognito");                                     // Bob: incognito by his account key
  const tid = (await A(ann, "start", [], { room: null })).table;
  assert.ok((await A(ann, "bet", ["500"], { table: tid })).ok);
  assert.ok((await A(bob, "bet", ["500"], { table: tid })).ok);
  let { d, text } = await get(`/api/casino/t/${tid}`, "u5");
  const vs = d.table.seats.filter((s) => s.veil);
  assert.equal(vs.length, 1, "one masked seat");
  const frog = vs[0].name, vseat = vs[0].seat;
  assert.ok(isFrog(frog), "a frog name: " + frog);
  assert.match(vseat, /^v[0-9a-f]{11}$/);
  assert.notEqual(vseat, svc.uidHash("u2"));
  assert.equal(vs[0].avatar, null, "no picture on a masked seat (Bob has one)");
  const annSeat = d.table.seats.find((s) => !s.veil);
  assert.deepEqual([annSeat.name, annSeat.seat, annSeat.avatar], ["Ann", svc.uidHash("u1"), "https://cdn.example/ann.png"], "Ann as before");
  for (const s of ["Bob", "bob", svc.uidHash("u2"), "\"u2\"", "cdn.example/bob"]) assert.ok(!text.includes(s), "never on the wire: " + s);
  assert.ok(d.table.log.some((l) => l.text === `💰 ${frog} bets 500.`), "the log names the frog");
  // his own view: his seat is the masked one (the page outlines it), under the same label
  const mine = (await get(`/api/casino/t/${tid}`, "u2")).d;
  assert.equal(mine.me.seat, vseat);
  // the round: the turn, the felt's last round (seat id + label) - the felt matches a result to its seat by seat id
  svc.S.hooks.shoe = () => ["Ts", "9h", "7d", "9s", "8h", "Kc"].concat(E.makeShoe(6).slice(6));
  assert.ok((await A(ann, "deal", [], { table: tid })).ok);
  svc.S.hooks.shoe = null;
  let sawTurn = false;
  for (let i = 0; i < 12; i++) {
    const T = svc.getTable(tid);
    if (!T.turn) break;
    const v = (await get(`/api/casino/t/${tid}`, "u5")).d;
    if (T.turn.uid === "u2") { sawTurn = true; assert.deepEqual([v.table.turn.name, v.table.turn.seat], [frog, vseat], "Bob's turn reads as the frog"); }
    assert.ok((await A(T.turn.uid === "u2" ? bob : ann, "stand", [], { table: tid })).ok);
  }
  assert.ok(sawTurn);
  ({ d, text } = await get(`/api/casino/t/${tid}`, "u5"));
  const lr = d.table.last_round;
  assert.ok(lr && lr.players.length === 2);
  assert.deepEqual(lr.players.map((p) => [p.name, p.seat]).sort(), [["Ann", svc.uidHash("u1")], [frog, vseat]].sort());
  assert.ok(!/Bob/.test(text), "nothing names Bob after the round");
  // the history + the fairness record: written masked (casino_rounds.results), the real name only in the server-only players column
  const h = await get(`/api/casino/t/${tid}/history`);
  assert.ok(h.d.rounds[0].results.players.some((p) => p.name === frog));
  assert.ok(!/Bob|u2/.test(h.text));
  const row = (await getQuery("SELECT results, players FROM casino_rounds WHERE table_id = ? AND round_no = 1", [tid]))[0];
  assert.ok(row.results.includes(frog) && !row.results.includes("Bob"), "written masked");
  assert.ok(row.players.includes("Bob"), "(the players column - never served - keeps who played)");
  const fr = await get(`/api/casino/fair/${tid}/1`);
  assert.ok(fr.d.results.players.some((p) => p.name === frog) && !/Bob/.test(fr.text), "the fairness record too");
  // Pepe's OBS board draws the polled table state: masked at the source
  svc.S.stream.table = tid;
  const poll = await svc.poll(-1, 0);
  const pt = JSON.stringify(poll.tables[tid]);
  assert.ok(pt.includes(frog) && !pt.includes("Bob") && !pt.includes(svc.uidHash("u2")), "the board's seats / turn / last round");
  // the people answer: the masked seat is its label under its own id, nothing else
  const pp = (await get(`/api/casino/t/${tid}/people`, "u5")).d;
  assert.deepEqual(pp.seats[vseat], { veil: true, display: frog });
  assert.equal(pp.seats[svc.uidHash("u2")], undefined);
});

test("Camfrog lines and replies: a ROOM player keeps the name the room saw them type under; a WEBSITE player is their label there too; a website player's reply masks everyone", async () => {
  await fresh();
  VK.set("u:u2", "incognito");
  VK.set("dancf", "incognito");                                    // Dan: incognito on the bridge (his room login)
  const tid = (await A(ann, "start", [], { room: null })).table;
  assert.ok((await A(bob, "bet", ["500"], { table: tid })).ok);
  assert.ok((await A(dan, "bet", ["500"], { table: tid })).ok);
  const view = (await get(`/api/casino/t/${tid}`, "u5"));
  assert.equal(view.d.table.seats.filter((s) => s.veil).length, 2, "both masked on the web");
  assert.ok(!/\bBob\b|\bDan\b|dancf/i.test(view.text), "on the website neither is named");
  const T = svc.getTable(tid), bobLabel = V.label(T, "u2"), danLabel = V.label(T, "u4");
  assert.ok(isFrog(bobLabel) && isFrog(danLabel) && bobLabel !== danLabel, bobLabel + " / " + danLabel);
  assert.ok(view.d.table.log.some((l) => l.text === `💰 ${danLabel} bets 500.`), "the website's log names the room player's label");
  const ev = (await getQuery("SELECT data FROM casino_events WHERE table_id = ? ORDER BY seq", [tid])).map((r) => JSON.parse(r.data).text);
  assert.ok(ev.includes("💰 Dan bets 500."), "Pepe's room line keeps the room player's name");
  assert.ok(ev.includes(`💰 ${bobLabel} bets 500.`) && !ev.some((t) => /\bBob\b/.test(t)), "a website player is their label there too");
  // !bj status: to a website player everyone masked is their label; to a Camfrog player the room player is named, the web one isn't
  const w = await A(eve, "status", [], { table: tid });
  assert.ok(!/Bob|Dan/.test(w.reply), w.reply);
  const c = await A(dan, "status", [], { table: tid });
  assert.ok(/Dan/.test(c.reply) && !/Bob/.test(c.reply), c.reply);
});

test("switched on mid-session: \"someone\" at once (never a frog name right after the name) and the lines before are masked again; switched off: the seat stays masked until they leave", async () => {
  await fresh();
  const tid = (await A(ann, "start", [], { room: null })).table;
  assert.ok((await A(ann, "bet", ["500"], { table: tid })).ok);
  assert.ok((await A(cat, "bet", ["500"], { table: tid })).ok);
  let d = (await get(`/api/casino/t/${tid}`, "u5")).d;
  assert.equal(d.table.seats.find((s) => s.seat === svc.uidHash("u3")).name, "Cat", "named");
  VK.set("u:u3", "incognito"); tick(3);
  d = (await get(`/api/casino/t/${tid}`, "u5")).d;
  const s = d.table.seats.find((x) => x.veil);
  assert.equal(s.name, "someone", "C.2: shown named in this seat session - never a frog name");
  assert.ok(!JSON.stringify(d).includes("Cat"), "the earlier '💰 Cat bets' line is masked again");
  assert.ok(d.table.log.some((l) => l.text === "💰 someone bets 500."));
  // switched off again mid-session: still masked (the seat, its stack and its hands would tie the label to the name)
  VK.delete("u:u3"); tick(3);
  d = (await get(`/api/casino/t/${tid}`, "u5")).d;
  assert.equal(d.table.seats.find((x) => x.seat === s.seat).name, "someone", "sticky for the seat session");
  // a round played masked: its history keeps the label for good
  svc.S.hooks.shoe = () => ["Ts", "9h", "7d", "9s", "8h", "Kc"].concat(E.makeShoe(6).slice(6));
  assert.ok((await A(ann, "deal", [], { table: tid })).ok);
  svc.S.hooks.shoe = null;
  await playRound(tid, [ann, cat]);
  assert.ok((await A(cat, "leave", [], { table: tid })).ok);
  d = (await get(`/api/casino/t/${tid}`, "u5")).d;
  assert.ok(d.table.log.some((l) => l.text === "🚪 someone left the blackjack table."), "the leaving line under the label");
  // after the grace: a new seat session, named (incognito is off), under the account's seat hash again - and nothing earlier unmasked
  tick(V.LEAVE_GRACE_MS / 1000 + 5);
  await get(`/api/casino/t/${tid}`, "u5");
  assert.ok((await A(cat, "bet", ["500"], { table: tid })).ok);
  const after = await get(`/api/casino/t/${tid}`, "u5");
  assert.equal(after.d.table.seats.find((x) => x.seat === svc.uidHash("u3")).name, "Cat");
  assert.ok(after.d.table.log.some((l) => l.text === "🚪 someone left the blackjack table.") && after.d.table.log.some((l) => l.text === "💰 someone bets 500."),
            "what was written masked stays masked - the line from before the switch too (masked in place when the mask started)");
  assert.equal(after.d.table.log.filter((l) => /\bCat\b/.test(l.text)).length, 1, "only the new seat session's own line names Cat");
  const h = await get(`/api/casino/t/${tid}/history`);
  assert.ok(h.d.rounds[0].results.players.some((p) => p.name === "someone") && !/Cat/.test(h.text), "the masked round stays masked");
});

test("sitting down veiled within 15 minutes of being shown named here: \"someone\"; later: a frog name - a new one (and a new seat id) each seat session", async () => {
  await fresh();
  const tid = (await A(ann, "start", [], { room: null })).table;
  assert.ok((await A(ann, "bet", ["500"], { table: tid })).ok);
  assert.ok((await A(cat, "bet", ["500"], { table: tid })).ok);
  await get(`/api/casino/t/${tid}`, "u5");                         // (shown named)
  assert.ok((await A(cat, "leave", [], { table: tid })).ok);
  VK.set("u:u3", "incognito"); tick(5 * 60);
  assert.ok((await A(cat, "bet", ["500"], { table: tid })).ok);
  let d = (await get(`/api/casino/t/${tid}`, "u5")).d;
  const s1 = d.table.seats.find((x) => x.veil);
  assert.equal(s1.name, "someone", "5 minutes after being named here");
  assert.ok((await A(cat, "leave", [], { table: tid })).ok);
  await get(`/api/casino/t/${tid}`, "u5");                         // (seen off the seats: the grace starts)
  tick(20 * 60);
  await get(`/api/casino/t/${tid}`, "u5");                         // (the seat session ends)
  assert.ok((await A(cat, "bet", ["500"], { table: tid })).ok);
  d = (await get(`/api/casino/t/${tid}`, "u5")).d;
  const s2 = d.table.seats.find((x) => x.veil);
  assert.ok(isFrog(s2.name), "a frog name 20 minutes on: " + s2.name);
  assert.notEqual(s2.seat, s1.seat, "a new masked seat id each seat session");
  assert.notEqual(s2.seat, svc.uidHash("u3"));
  assert.ok((await A(cat, "leave", [], { table: tid })).ok);
  await get(`/api/casino/t/${tid}`, "u5");
  tick(V.LEAVE_GRACE_MS / 1000 + 5);
  await get(`/api/casino/t/${tid}`, "u5");
  assert.ok((await A(cat, "bet", ["500"], { table: tid })).ok);
  const s3 = (await get(`/api/casino/t/${tid}`, "u5")).d.table.seats.find((x) => x.veil);
  assert.ok(isFrog(s3.name) && s3.seat !== s2.seat, "and again a new id (a new epoch): " + s3.name);
});

test("hold'em: a veiled host and winner - the lobby, the host line, the winner's glow and the felt's result on the masked seat (by seat id)", async () => {
  await fresh();
  VK.set("u:u2", "incognito");
  const o = await A(bob, "start", ["25/50"], { room: null, game: "holdem" });
  assert.ok(o.ok, o.reply);
  const tid = o.table;
  assert.ok((await A(bob, "sit", ["1000"], { table: tid, game: "holdem" })).ok);
  assert.ok((await A(ann, "sit", ["1000"], { table: tid, game: "holdem" })).ok);
  let v = await get(`/api/casino/t/${tid}`, "u5");
  const bs = v.d.table.seats.find((s) => s.veil);
  assert.ok(isFrog(bs.name), bs.name);
  assert.equal(v.d.table.host, bs.name, "the host reads as the seat's label");
  assert.ok(v.d.table.log.some((l) => /^🃏 someone opened a No-Limit Hold'em table/.test(l.text)), "opened before he sat: \"someone\"");
  const lob = await get("/api/casino/lobby", "u5");
  assert.equal(lob.d.tables.find((t) => t.id === tid).host, bs.name);
  assert.ok(!/Bob/.test(lob.text) && !/Bob/.test(v.text));
  // a hand to a showdown: Bob's aces win; shown cards + the winner are under the label and matched to the masked seat
  svc.S.hooks.deck = () => { const pre = ["As", "Ah", "Ks", "Kh", "2c", "7d", "9h", "3s", "4c"]; return pre.concat(E.makeShoe(1).filter((c) => !pre.includes(c))); };
  assert.ok((await A(ann, "deal", [], { table: tid, game: "holdem" })).ok);
  svc.S.hooks.deck = null;
  const T = svc.getTable(tid);
  // his own view mid-hand: his masked seat, his cards, in the hand
  const meB = (await get(`/api/casino/t/${tid}`, "u2")).d.me;
  assert.deepEqual([meB.seat, meB.in_hand, meB.cards], [bs.seat, true, ["As", "Ah"]]);
  for (let i = 0; i < 12 && T.eng.hand_active; i++) {
    const who = HE.currentActor(T.eng) === "u1" ? ann : bob;
    const tc = HE.toCall(T.eng, who.uid);
    assert.ok((await A(who, tc ? "call" : "check", [], { table: tid, game: "holdem" })).ok);
  }
  assert.equal(T.eng.hand_active, false);
  v = await get(`/api/casino/t/${tid}`, "u5");
  const lr = v.d.table.last_round;
  const seatBob = v.d.table.seats.find((s) => s.veil);
  assert.ok(lr.winners.length >= 1);
  assert.deepEqual([lr.winners[0].name, lr.winners[0].seat], [bs.name, seatBob.seat], "the winner under the label + the masked seat id");
  assert.ok(lr.shown.some((s) => s.seat === seatBob.seat && s.name === bs.name));
  assert.equal(seatBob.winner, true, "the winner glow on the masked seat");
  assert.ok(seatBob.shown && seatBob.shown.length === 2, "its shown cards drawn on it");
  assert.ok(!/Bob/.test(v.text));
  const h = await get(`/api/casino/t/${tid}/history`);
  assert.ok(!/Bob/.test(h.text) && h.text.includes(bs.name));
});

test("fail closed: a hidden set loading or a failed read masks everyone for that answer only - nothing is kept, named again once it reads", async () => {
  await fresh();
  const tid = (await A(ann, "start", [], { room: null })).table;
  assert.ok((await A(cat, "bet", ["500"], { table: tid })).ok);
  VK.set("u:u1", "unknown"); VK.set("u:u3", "unknown"); tick(3);
  const d = (await get(`/api/casino/t/${tid}`, "u5")).d;
  assert.deepEqual(d.table.seats.map((s) => [s.name, !!s.veil]), [["someone", true]]);
  assert.equal(d.table.host, "someone");
  assert.ok(!/Cat|Ann/.test(JSON.stringify(d.table)));
  VK.clear(); tick(3);
  const back = (await get(`/api/casino/t/${tid}`, "u5")).d;
  assert.deepEqual(back.table.seats.map((s) => [s.name, s.seat]), [["Cat", svc.uidHash("u3")]], "no seat session was masked by it");
  assert.equal(back.table.host, "Ann");
});

test("veil.js: a masked seat id is the table's own (another table, another id); the state is saved with the table and comes back after a restart", async () => {
  await fresh();
  VK.set("u:u2", "incognito");
  const t1 = (await A(ann, "start", [], { room: null })).table;
  assert.ok((await A(bob, "bet", ["500"], { table: t1 })).ok);
  const id1 = V.seatOf(svc.getTable(t1), "u2");
  const fake = { id: "ffffffffff", eng: { seats: ["u2"] }, players: {}, veil: JSON.parse(JSON.stringify(svc.getTable(t1).veil)) };
  assert.notEqual(V.seatOf(fake, "u2"), id1, "the same person at another table: another id");
  const label = V.label(svc.getTable(t1), "u2");
  // a restart: the saved state comes back (casino_tables.state), so the seat keeps its label and id
  const saved = JSON.parse((await getQuery("SELECT state FROM casino_tables WHERE id = ?", [t1]))[0].state);
  assert.equal(saved.veil.u2.m, 1);
  assert.equal(saved.veil.u2.lab, label);
  svc.stop(); svc.S.tables.clear(); V._reset();
  await svc.boot({ tick: false });
  const T = svc.getTable(t1);
  assert.equal(V.label(T, "u2"), label);
  assert.equal(V.seatOf(T, "u2"), id1);
  // the public view never carries the state itself
  assert.ok(!JSON.stringify(svc.publicView(T)).includes('"veil":{'), "T.veil is server only");
});
