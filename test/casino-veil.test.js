"use strict";
// 1.99ajw casino2 rework (the owner, 2026-11-04, on incognito players at the casino tables: "Yes, just show them masked at the table if
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
//   * (1.99ajw casino2 verify - the review's probes) a seat session's id is a NEW epoch's (never shown before: not on a blip, not in place
//     of a named result); what was shown under the name reads "someone" - never the later frog name - and a session's start or end
//     changes nothing on it; one-character names are masked; a masked room player shows no Camfrog tag
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
  require(path.join(repo, "blocks")).register(app, { addUser: (req, res, next) => next() });        // (casmask gap b: the seat's Block)
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
  assert.deepEqual(pp.seats[vseat], { veil: true, display: frog, bk: 1 }, "(bk: a frog-named seat's menu offers Block - casmask)");
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

// ── 1.99ajw casino2 verify: the review's three probes (each now asserting the safe outcome), and what they led to ──
const dealRound = async (tid, who) => {
  svc.S.hooks.shoe = () => ["Ts", "9h", "7d", "9s", "8h", "Kc"].concat(E.makeShoe(6).slice(6));
  assert.ok((await A(who[0], "deal", [], { table: tid })).ok);
  svc.S.hooks.shoe = null;
  await playRound(tid, who);
};
const entry = (lr, seat) => ((lr && lr.players) || []).find((p) => p.seat === seat);

test("verify (probe 1): a fail-closed blip's seat ids are old-content ids - steady through the blip, the viewer's own seat matches - never the id of a later masked seat session", async () => {
  await fresh();
  const tid = (await A(ann, "start", [], { room: null })).table;
  assert.ok((await A(ann, "bet", ["500"], { table: tid })).ok);
  assert.ok((await A(cat, "bet", ["500"], { table: tid })).ok);
  let d = (await get(`/api/casino/t/${tid}`, "u5")).d;
  const catPos = d.table.seats.findIndex((s) => s.name === "Cat");
  VK.set("u:u1", "unknown"); VK.set("u:u3", "unknown"); tick(3);
  d = (await get(`/api/casino/t/${tid}`, "u5")).d;
  const blipId = d.table.seats[catPos].seat;
  assert.match(blipId, /^v[0-9a-f]{11}$/);
  assert.notEqual(blipId, svc.uidHash("u3"));
  tick(3);
  const again = (await get(`/api/casino/t/${tid}`, "u3")).d;
  assert.equal(again.table.seats[catPos].seat, blipId, "steady through the blip (no flicker)");
  assert.equal(again.me.seat, blipId, "the viewer's own seat matches (the page still knows it's theirs)");
  VK.clear(); tick(3);
  d = (await get(`/api/casino/t/${tid}`, "u5")).d;
  assert.equal(d.table.seats[catPos].seat, svc.uidHash("u3"), "named again after the blip");
  assert.ok((await A(cat, "leave", [], { table: tid })).ok);
  await get(`/api/casino/t/${tid}`, "u5");
  VK.set("u:u3", "incognito");
  for (let i = 0; i < 10; i++) { tick(120); await get(`/api/casino/t/${tid}`, "u5"); }   // (20 minutes incognito: C.2 allows a frog name)
  assert.ok((await A(cat, "bet", ["500"], { table: tid })).ok);
  d = (await get(`/api/casino/t/${tid}`, "u5")).d;
  const vs = d.table.seats.find((s) => s.veil);
  assert.ok(isFrog(vs.name), vs.name);
  assert.notEqual(vs.seat, blipId, "the masked seat session's id was never shown during the blip next to Cat's seat");
});

test("verify (probes 2 + 3): what was shown under the name reads 'someone' under an old-content id - never the frog name or the session's id; the session's start and end change nothing on it", async () => {
  await fresh();
  const tid = (await A(ann, "start", [], { room: null })).table;
  assert.ok((await A(ann, "bet", ["500"], { table: tid })).ok);
  assert.ok((await A(cat, "bet", ["700"], { table: tid })).ok);
  await dealRound(tid, [ann, cat]);
  let v = (await get(`/api/casino/t/${tid}`, "u5")).d;
  assert.ok(entry(v.table.last_round, svc.uidHash("u3")), "round 1 played named");
  const namedTs = v.table.log.filter((l) => /\bCat\b/.test(l.text)).map((l) => l.ts);
  assert.ok(namedTs.length >= 2);
  assert.ok((await A(cat, "leave", [], { table: tid })).ok);
  await get(`/api/casino/t/${tid}`, "u5");
  VK.set("u:u3", "incognito"); tick(3);
  v = (await get(`/api/casino/t/${tid}`, "u5")).d;
  const old = v.table.last_round.players.find((p) => p.name === "someone");
  assert.ok(old, "veiled off the seats: his named result reads 'someone'");
  assert.match(old.seat, /^v[0-9a-f]{11}$/);
  assert.notEqual(old.seat, svc.uidHash("u3"));
  const oldId = old.seat;
  assert.ok((await get(`/api/casino/t/${tid}/history`)).d.rounds.some((r) => r.results.players.some((p) => p.seat === oldId && p.name === "someone")), "the history too");
  // 20 minutes incognito (C.2 then allows a frog name), then he sits down
  for (let i = 0; i < 10; i++) { tick(120); await get(`/api/casino/t/${tid}`, "u5"); }
  const before = JSON.stringify((await get(`/api/casino/t/${tid}`, "u5")).d.table.last_round.players);
  const histBefore = JSON.stringify((await get(`/api/casino/t/${tid}/history`)).d.rounds);
  assert.ok((await A(cat, "bet", ["500"], { table: tid })).ok);
  v = (await get(`/api/casino/t/${tid}`, "u5")).d;
  const vs = v.table.seats.find((s) => s.veil);
  assert.ok(isFrog(vs.name), "a frog name 20 minutes on: " + vs.name);
  assert.notEqual(vs.seat, oldId, "probe 2: the frog seat never has the id shown in place of Cat's named result");
  assert.equal(JSON.stringify(v.table.last_round.players), before, "sitting down changed nothing on the old result");
  assert.equal(JSON.stringify((await get(`/api/casino/t/${tid}/history`)).d.rounds), histBefore, "nor on the history");
  const same = v.table.log.filter((l) => namedTs.includes(l.ts));
  assert.ok(same.length >= 2 && same.every((l) => !l.text.includes(vs.name) && !/\bCat\b/.test(l.text)), "probe 3: a line first shown as Cat's never carries the frog name");
  assert.ok(same.some((l) => /\bsomeone\b/.test(l.text)), "it reads 'someone'");
  const h1 = await get(`/api/casino/t/${tid}/history`);
  assert.ok(!h1.text.includes(vs.name) && !/\bCat\b/.test(h1.text), "probe 3: round 1 (played named) never reads as the frog");
  // a round as the frog: written under the label + the session's id, for good
  await dealRound(tid, [ann, cat]);
  v = (await get(`/api/casino/t/${tid}`, "u5")).d;
  assert.equal((entry(v.table.last_round, vs.seat) || {}).name, vs.name);
  // incognito off while seated (the seat stays masked), then he leaves; after the grace he is named again - and NOTHING changes on what
  // was masked: round 1 is still 'someone' under the same old-content id, round 2 the frog (a session's end unmasks nothing)
  VK.delete("u:u3"); tick(3);
  assert.equal((await get(`/api/casino/t/${tid}`, "u5")).d.table.seats.find((s) => s.seat === vs.seat).name, vs.name, "sticky for the seat session");
  assert.ok((await A(cat, "leave", [], { table: tid })).ok);
  await get(`/api/casino/t/${tid}`, "u5");
  const histIn = (await get(`/api/casino/t/${tid}/history`)).d.rounds;
  tick(V.LEAVE_GRACE_MS / 1000 + 5);
  await get(`/api/casino/t/${tid}`, "u5");
  const histOut = (await get(`/api/casino/t/${tid}/history`)).d.rounds;
  assert.deepEqual(histOut, histIn, "the session's end changed nothing in the history");
  assert.ok(histOut.some((r) => r.results.players.some((p) => p.seat === oldId && p.name === "someone")), "round 1 still 'someone' under the same id");
  assert.ok(histOut.some((r) => r.results.players.some((p) => p.seat === vs.seat && p.name === vs.name)), "round 2 still the frog");
  assert.ok(!/\bCat\b/.test(JSON.stringify(histOut)));
  // named again: his NEW named activity is his (only what was shown masked stays masked)
  assert.ok((await A(cat, "bet", ["500"], { table: tid })).ok);
  await dealRound(tid, [ann, cat]);
  v = (await get(`/api/casino/t/${tid}`, "u5")).d;
  assert.equal(v.table.seats.find((s) => s.seat === svc.uidHash("u3")).name, "Cat", "named seat");
  assert.equal((entry(v.table.last_round, svc.uidHash("u3")) || {}).name, "Cat", "his named round is his");
  assert.ok(v.table.log.some((l) => l.text === "💰 Cat bets 500."), "his named line is his");
  const h3 = (await get(`/api/casino/t/${tid}/history`)).d.rounds;
  assert.ok(h3.some((r) => r.results.players.some((p) => p.seat === svc.uidHash("u3") && p.name === "Cat")), "the named round in the history");
  assert.ok(h3.some((r) => r.results.players.some((p) => p.seat === oldId && p.name === "someone")), "round 1 still masked");
});

test("verify: a one-character name is masked in the lines too (never a card's rank: 'K♠'); a masked room player shows no Camfrog tag; the homepage list re-reads the veils", async () => {
  const T = { id: "tbl1", veil: { u9: { n: ["K"], k: "incognito", m: 1, lab: "Mellow Glassfrog", ep: 1, w: 1 } }, eng: { seats: ["u9"], names: { u9: "K" } }, players: {} };
  assert.equal(V.maskText(T, "💰 K bets 500. Pepe draws K♠ → 20. K's turn."), "💰 someone bets 500. Pepe draws K♠ → 20. someone's turn.");
  assert.equal(V.maskText(T, "💰 K bets 500.", { fresh: true }), "💰 Mellow Glassfrog bets 500.");
  assert.equal(V.maskText(T, "OK, Kc and k stay"), "OK, Kc and k stay", "only the name as written, as a word of its own");
  // a Camfrog room player who is masked: no 🐸 Camfrog tag on the seat (it would say where they play from)
  await fresh();
  VK.set("dancf", "incognito");
  const tid = (await A(ann, "start", [], { room: null })).table;
  assert.ok((await A(dan, "bet", ["500"], { table: tid })).ok);
  const d = (await get(`/api/casino/t/${tid}`, "u5")).d;
  const s = d.table.seats.find((x) => x.veil);
  assert.ok(s, "Dan's seat is masked");
  assert.equal(s.via, "web", "no Camfrog tag");
  assert.ok(!d.table.seats.some((x) => x.veil && x.via === "room"));
  // the homepage's table list asks for the same masks as the table view (its veils re-read before the view)
  const home = fs.readFileSync(path.join(repo, "home.js"), "utf8");
  assert.match(home, /if \(T\) \{ try \{ await csvc\.refreshVeil\(T\); \} catch \(e\) \{[^}]*\} \}\s*\r?\n\s*const v = T \? csvc\.publicView\(T\) : null;/);
});

test("verify: a seat masked WITHOUT a session (a check that keeps failing) never shares an id with the result first shown under the name; a new one each time they sit", async () => {
  await fresh();
  const tid = (await A(ann, "start", [], { room: null })).table;
  assert.ok((await A(ann, "bet", ["500"], { table: tid })).ok);
  assert.ok((await A(cat, "bet", ["500"], { table: tid })).ok);
  await dealRound(tid, [ann, cat]);
  assert.ok((await A(cat, "leave", [], { table: tid })).ok);
  await get(`/api/casino/t/${tid}`, "u5");
  VK.set("u:u3", "unknown"); tick(3);                                // (hidden, but no check says which veil: masked, never a session)
  assert.ok((await A(cat, "bet", ["500"], { table: tid })).ok);
  let d = (await get(`/api/casino/t/${tid}`, "u5")).d;
  const s1 = d.table.seats.find((s) => s.veil);
  assert.equal(s1.name, "someone");
  const res = d.table.last_round.players.find((p) => p.name === "someone");
  assert.ok(res, "his named result reads 'someone'");
  assert.notEqual(s1.seat, res.seat, "the seat and the result first shown as Cat's don't share an id");
  assert.equal(V.state(svc.getTable(tid), "u3").m, 0, "no seat session (nothing is kept from a failed check)");
  assert.ok((await A(cat, "leave", [], { table: tid })).ok);
  await get(`/api/casino/t/${tid}`, "u5");
  tick(3);
  assert.ok((await A(cat, "bet", ["500"], { table: tid })).ok);
  d = (await get(`/api/casino/t/${tid}`, "u5")).d;
  const s2 = d.table.seats.find((s) => s.veil);
  assert.notEqual(s2.seat, s1.seat, "a new one each time they sit");
  assert.equal(d.table.last_round.players.find((p) => p.name === "someone").seat, res.seat, "the old result keeps its id");
});

// ── 1.99akb casmask (the 1.99ajw verifier's gap c): a closed table that is no longer in memory is masked by its SAVED state ──
test("casmask (gap c): a closed table no longer in memory keeps its masks - rounds up to a masked seat session stay 'someone' (its saved omr / old-content ids), the current veil applies, a row that can't be read masks everyone", async () => {
  await fresh();
  const tid = (await A(ann, "start", [], { room: null })).table;
  assert.ok((await A(ann, "bet", ["500"], { table: tid })).ok);
  assert.ok((await A(cat, "bet", ["700"], { table: tid })).ok);
  await dealRound(tid, [ann, cat]);                                  // round 1: Cat named
  assert.ok((await A(cat, "leave", [], { table: tid })).ok);
  await get(`/api/casino/t/${tid}`, "u5");
  VK.set("u:u3", "incognito");
  for (let i = 0; i < 10; i++) { tick(120); await get(`/api/casino/t/${tid}`, "u5"); }   // (C.2: a frog name 20 minutes on)
  assert.ok((await A(cat, "bet", ["500"], { table: tid })).ok);
  const frog = (await get(`/api/casino/t/${tid}`, "u5")).d.table.seats.find((s) => s.veil);
  assert.ok(isFrog(frog.name), frog.name);
  await dealRound(tid, [ann, cat]);                                  // round 2: Cat as the frog
  VK.delete("u:u3"); tick(3);
  assert.ok((await A(cat, "leave", [], { table: tid })).ok);
  await get(`/api/casino/t/${tid}`, "u5");
  tick(V.LEAVE_GRACE_MS / 1000 + 5);
  await get(`/api/casino/t/${tid}`, "u5");                          // (his seat session is over: named again)
  const live = (await get(`/api/casino/t/${tid}/history`)).d.rounds;
  const r1 = (h) => h.find((r) => r.round === 1), r2 = (h) => h.find((r) => r.round === 2);
  assert.ok(r1(live).results.players.some((p) => p.name === "someone") && !/\bCat\b/.test(JSON.stringify(live)), "in memory: round 1 'someone' (omr)");
  assert.ok(r2(live).results.players.some((p) => p.name === frog.name && p.seat === frog.seat), "in memory: round 2 the frog");
  const fair1 = (await get(`/api/casino/fair/${tid}/1`)).d;
  // the table closes and leaves memory (its linger is over / a restart): the history and the fairness record still mask round 1
  assert.ok((await A(ann, "end", [], { table: tid })).ok);
  svc.S.tables.delete(tid); V._reset();
  assert.equal(svc.getTable(tid), null, "no longer in memory");
  const gone = await get(`/api/casino/t/${tid}/history`);
  assert.ok(!/\bCat\b/.test(gone.text), "never the name: " + gone.text.slice(0, 300));
  assert.ok(r1(gone.d.rounds).results.players.some((p) => p.name === "someone"), "round 1 stays 'someone' for good (the saved omr)");
  assert.deepEqual(r1(gone.d.rounds).results, r1(live).results, "round 1 exactly as it read in memory (the saved old-content id)");
  assert.deepEqual(r2(gone.d.rounds).results, r2(live).results, "round 2: the frog, as written");
  assert.ok(r1(gone.d.rounds).results.players.some((p) => p.name === "Ann" && p.seat === svc.uidHash("u1")), "a named player stays named");
  const fairGone = await get(`/api/casino/fair/${tid}/1`);
  assert.deepEqual(fairGone.d.results, fair1.results, "the fairness record: the same mask");
  assert.ok(!/\bCat\b/.test(fairGone.text));
  // the current veil still applies to a table out of memory: Ann incognito now -> her entries read "someone"
  VK.set("u:u1", "incognito"); V._reset();
  const now = await get(`/api/casino/t/${tid}/history`);
  assert.ok(!/\bAnn\b/.test(now.text) && !now.text.includes(svc.uidHash("u1")), "veiled now: masked (no seat hash either)");
  VK.clear(); V._reset();
  assert.ok(/\bAnn\b/.test((await get(`/api/casino/t/${tid}/history`)).text), "named again");
  // fail closed: the saved state can't be read -> every entry of those rounds is 'someone' (never the current veil alone)
  await runQuery("UPDATE casino_tables SET state = ? WHERE id = ?", ["{not json", tid]); V._reset();
  const bad = await get(`/api/casino/t/${tid}/history`);
  assert.ok(bad.d.ok && bad.d.rounds.length >= 2);
  assert.ok(!/\bAnn\b|\bCat\b/.test(bad.text) && !bad.text.includes(svc.uidHash("u1")), "nobody named, no seat ids");
  assert.ok(bad.d.rounds.every((r) => r.results.players.every((p) => p.name === "someone" && p.seat === null)));
  await runQuery("DELETE FROM casino_tables WHERE id = ?", [tid]); V._reset();
  const none = await get(`/api/casino/fair/${tid}/1`);
  assert.ok(!/\bAnn\b|\bCat\b/.test(none.text) && none.d.results.players.every((p) => p.name === "someone"), "no saved row: masked too");
});

// ── 1.99akb casmask (the 1.99ajw verifier's gap b): a masked seat's menu offers a FROG-NAME Block (Unblock once blocked) ──
test("casmask (gap b): a masked seat's Block is a frog-name block by the masked seat's own id - the server finds who and never says; Unblock once blocked (frog names only); signed out: none", async () => {
  await fresh();
  const B = require(path.join(repo, "blocks"));
  await B.init(); await runQuery("DELETE FROM veil_blocks"); B._reset();
  const post = async (body, uid) => { const r = await fetch(base + "/api/blocks", { method: "POST", headers: H(uid), body: JSON.stringify(body) }); const text = await r.text(); return { status: r.status, text, d: JSON.parse(text) }; };
  VK.set("u:u2", "incognito");
  const tid = (await A(ann, "start", [], { room: null })).table;
  assert.ok((await A(ann, "bet", ["500"], { table: tid })).ok);
  assert.ok((await A(bob, "bet", ["500"], { table: tid })).ok);
  const vs = (await get(`/api/casino/t/${tid}`, "u5")).d.table.seats.find((s) => s.veil);
  assert.ok(vs && isFrog(vs.name), "Bob's seat: a frog name");
  const ref = { k: "cseat", t: tid, s: vs.seat };
  assert.deepEqual((await get(`/api/casino/t/${tid}/people`, "u5")).d.seats[vs.seat], { veil: true, display: vs.name, bk: 1 }, "nothing blocked yet: Block (bk), no vb");
  assert.equal((await post({ ref, on: true }, null)).status, 401, "signed out: no block");
  const b1 = await post({ ref, on: true }, "u5");
  assert.equal(b1.status, 200, b1.text);
  assert.deepEqual(b1.d, { ok: true, blocked: true, veil: true, label: vs.name });
  for (const s of ["Bob", "bob", "u2", svc.uidHash("u2")]) assert.ok(!b1.text.includes(s), "the answer never says who: " + s);
  let rows = await getQuery("SELECT blocked_id, blocked_login, label FROM veil_blocks WHERE blocker_id = 'u5'");
  assert.deepEqual(rows, [{ blocked_id: "u2", blocked_login: null, label: vs.name }], "a frog-name block on the person behind the seat");
  B._reset();
  assert.ok((await B.veilKeysOf("u5")).has("u:u2"), "it hides their veiled activity under ANY frog name (blocks.veilKeysOf)");
  assert.equal((await B.towards("u2", "u5", { veiled: false })), false, "never a named block (what they do under their own name is untouched)");
  const b2 = await post({ ref, on: true }, "u5");
  assert.deepEqual(b2.d, b1.d, "blocking again: the same answer");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM veil_blocks WHERE blocker_id = 'u5'"))[0].n, 1, "and no second row");
  B._reset();
  assert.deepEqual((await get(`/api/casino/t/${tid}/people`, "u5")).d.seats[vs.seat], { veil: true, display: vs.name, bk: 1, vb: 1 }, "blocked: the menu offers Unblock");
  assert.deepEqual((await get(`/api/casino/t/${tid}/people`, "u3")).d.seats[vs.seat], { veil: true, display: vs.name, bk: 1 }, "only for the blocker");
  const u1 = await post({ ref, on: false }, "u5");
  assert.deepEqual(u1.d, { ok: true, blocked: false, veil: true, label: vs.name });
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM veil_blocks WHERE blocker_id = 'u5'"))[0].n, 0, "unblocked: every frog-name block on that person lifted");
  B._reset();
  assert.deepEqual((await get(`/api/casino/t/${tid}/people`, "u5")).d.seats[vs.seat], { veil: true, display: vs.name, bk: 1 });
  // yourself; a seat id that is no masked seat here (a named seat's hash isn't a masked id at all); another table's id
  assert.equal((await post({ ref, on: true }, "u2")).d.error, "That's you.");
  const fake = await post({ ref: { k: "cseat", t: tid, s: "v" + "0".repeat(11) }, on: true }, "u5");
  assert.deepEqual([fake.status, fake.d.error], [404, "They aren't at the table any more."]);
  assert.equal((await post({ ref: { k: "cseat", t: tid, s: svc.uidHash("u1") }, on: true }, "u5")).status, 404, "a named seat's hash: refused (named people are blocked by name)");
  assert.equal((await post({ ref: { k: "cseat", t: "0123456789", s: vs.seat }, on: true }, "u5")).status, 404, "another table");
  // a "someone" seat (switched on mid-session - C.2): neither Block nor Unblock (casmask review - see the next test)
  assert.ok((await A(cat, "bet", ["500"], { table: tid })).ok);
  await get(`/api/casino/t/${tid}`, "u5");
  VK.set("u:u3", "incognito"); tick(3);
  const cs = (await get(`/api/casino/t/${tid}`, "u5")).d.table.seats.find((s) => s.veil && s.name === "someone");
  assert.ok(cs, "Cat's seat reads 'someone'");
  const b3 = await post({ ref: { k: "cseat", t: tid, s: cs.seat }, on: true }, "u5");
  assert.deepEqual([b3.status, b3.d.error], [404, "Only a frog-named seat can be blocked from the table."]);
  B._reset();
  assert.deepEqual((await get(`/api/casino/t/${tid}/people`, "u5")).d.seats[cs.seat], { veil: true, display: "someone" }, "a 'someone' seat: no bk, no vb");
  // the page: the masked seat's small menu carries Block / Unblock (the chat's words), nothing that says who; signed-out viewers get no menu
  const ui = fs.readFileSync(path.join(repo, "public", "js", "casino-ui.js"), "utf8");
  const vm = ui.slice(ui.indexOf("function veilMenu("), ui.indexOf("if (tableId) {", ui.indexOf("function veilMenu(")));
  assert.match(vm, /ref: \{ k: "cseat", t: tableId, s: String\(seat\) \}, name, veil: true, on, anchor/);
  assert.match(vm, /bt\("js\.block\.menu", "Block…"\)/);
  assert.match(vm, /bt\("js\.block\.menu_un", "Unblock"\)/);
  assert.match(vm, /const on = !p\.vb;/);
  assert.match(vm, /if \(signed && seat && p\.bk && window\.PATVBlockSheet\)/);
  assert.match(vm, /\}, null, on\]\);/, "Block in the danger colour (the chat's masked-entry item)");
  assert.doesNotMatch(vm.replace(/PATVBlockSheet/g, ""), /\/u\/|tip|patv|login/i, "no profile, no tip, nothing that says who");
});

test("casmask: asking for Pepe's stream while another table holds it names THAT table's host as its own veil shows them (never the name)", async () => {
  await fresh();
  VK.set("u:u2", "incognito");
  const t1 = (await A(bob, "start", [], { room: null })).table;     // Bob (web, incognito) hosts the table on the stream
  assert.ok((await A(bob, "bet", ["500"], { table: t1 })).ok);
  await get(`/api/casino/t/${t1}`, "u5");
  assert.ok((await svc.stream(t1, true, Object.assign({}, bob), false)).ok);
  assert.equal(svc.S.stream.table, t1);
  const t2 = (await A(ann, "start", [], { room: null })).table;
  const r = await svc.stream(t2, true, Object.assign({}, ann), false);
  assert.ok(r.ok && r.queued === 1, r.reply);
  assert.ok(!/\bBob\b/.test(r.reply), "never the name: " + r.reply);
  assert.ok(r.reply.includes(V.label(svc.getTable(t1), "u2") + "'s table"), "the other table's label: " + r.reply);
});

// ── 1.99akb casmask review fixes (gap b): a "someone" seat is never blocked or unblocked from the table; {k:'cseat'} is opt-in ──
test("casmask review: a 'someone' seat the viewer just saw NAMED - Block and Unblock both refused (the same answer whoever sits there): no frog-name block tied to the name, no Settings row lifted, no oracle", async () => {
  await fresh();
  const B = require(path.join(repo, "blocks"));
  await B.init(); await runQuery("DELETE FROM veil_blocks"); B._reset();
  const post = async (body, uid) => { const r = await fetch(base + "/api/blocks", { method: "POST", headers: H(uid), body: JSON.stringify(body) }); const text = await r.text(); return { status: r.status, text, d: JSON.parse(text) }; };
  // Eve blocked a frog name in a pad's chat earlier - it is Cat (Eve doesn't know)
  await runQuery("INSERT INTO veil_blocks (blocker_id, blocked_id, blocked_login, label, room_id, created) VALUES ('u5', 'u3', 'catcf', 'Mossy Toad', 'r1', 1)");
  B._reset();
  const tid = (await A(ann, "start", [], { room: null })).table;
  assert.ok((await A(ann, "bet", ["500"], { table: tid })).ok);
  assert.ok((await A(cat, "bet", ["700"], { table: tid })).ok);
  assert.ok((await get(`/api/casino/t/${tid}`, "u5")).d.table.seats.some((s) => s.name === "Cat"), "Cat shown named");
  VK.set("u:u3", "incognito"); tick(3);
  const cs = (await get(`/api/casino/t/${tid}`, "u5")).d.table.seats.find((s) => s.veil && s.name === "someone");
  assert.ok(cs, "her seat now reads 'someone' - the watcher saw it was Cat");
  const keys0 = [...(await B.veilKeysOf("u5"))].sort();
  for (const on of [true, false]) {
    const r = await post({ ref: { k: "cseat", t: tid, s: cs.seat }, on }, "u5");
    assert.deepEqual([r.status, r.d.error], [404, "Only a frog-named seat can be blocked from the table."], "on=" + on + ": " + r.text);
  }
  B._reset();
  assert.deepEqual((await getQuery("SELECT label FROM veil_blocks WHERE blocker_id = 'u5'")).map((x) => x.label), ["Mossy Toad"], "nothing added, nothing lifted");
  assert.deepEqual([...(await B.veilKeysOf("u5"))].sort(), keys0);
  // the same answer for a 'someone' seat whose person Eve never blocked (Ann switched on mid-session too)
  VK.set("u:u1", "incognito"); tick(3);
  const as = (await get(`/api/casino/t/${tid}`, "u5")).d.table.seats.filter((s) => s.veil && s.name === "someone").find((s) => s.seat !== cs.seat);
  assert.ok(as);
  const r2 = await post({ ref: { k: "cseat", t: tid, s: as.seat }, on: true }, "u5");
  assert.deepEqual([r2.status, r2.d.error], [404, "Only a frog-named seat can be blocked from the table."]);
  const pp = (await get(`/api/casino/t/${tid}/people`, "u5")).d.seats;
  assert.deepEqual([pp[cs.seat], pp[as.seat]], [{ veil: true, display: "someone" }, { veil: true, display: "someone" }], "no Block / Unblock offered");
});

test("casmask review: {k:'cseat'} resolves only for a caller that opts in (blocks.js) - pad bans, gifts and mentions never reach the person behind a masked seat", async () => {
  await fresh();
  const PR = require(path.join(repo, "personref"));
  VK.set("u:u2", "incognito");
  const tid = (await A(ann, "start", [], { room: null })).table;
  assert.ok((await A(ann, "bet", ["500"], { table: tid })).ok);
  assert.ok((await A(bob, "bet", ["500"], { table: tid })).ok);
  const vs = (await get(`/api/casino/t/${tid}`, "u5")).d.table.seats.find((s) => s.veil);
  const ref = { k: "cseat", t: tid, s: vs.seat };
  const viewer = { userId: "u5" };
  assert.equal(await PR.padOk(ref, viewer, null), false, "padOk: no opt-in - refused");
  assert.equal(await PR.padOk(ref, viewer, null, { cseat: true }), true, "padOk: opted in (signed in)");
  assert.equal(await PR.padOk(ref, null, null, { cseat: true }), false, "signed out: never");
  const r0 = await PR.resolve(ref, {});
  assert.ok(r0.error && !r0.userId && !r0.login, "resolve: no opt-in - an error, nobody behind it");
  const r1 = await PR.resolve(ref, { cseat: true });
  assert.equal(r1.userId, "u2", "opted in: the server finds the person (never sent to a page)");
  // only blocks.js opts in
  for (const f of ["padbans.js", "veilgift.js", "bridge-relay.js"]) {
    const src = fs.readFileSync(path.join(repo, f), "utf8");
    assert.ok(!/cseat\s*:\s*true/.test(src), f + " never opts in");
  }
  const bsrc = fs.readFileSync(path.join(repo, "blocks.js"), "utf8");
  assert.ok(/PR\.resolve\(ref, \{ R, cseat: true \}\)/.test(bsrc) && /PR\.padOk\(b\.ref, me, R, \{ cseat: true \}\)/.test(bsrc), "blocks.js does");
});

test("casmask review (gap c): a closed table out of memory reads a room seat's veil by the login it played from too - as it does in memory", async () => {
  await fresh();
  const danAlt = mk("u4", "Dan", { camfrog: "DanAlt", via: "room", room: "Casino.Room" });   // an alt login Pepe folds into his account
  const tid = (await A(ann, "start", [], { room: null })).table;
  assert.ok((await A(ann, "bet", ["500"], { table: tid })).ok);
  assert.ok((await A(danAlt, "bet", ["700"], { table: tid })).ok);
  await dealRound(tid, [ann, danAlt]);                                // round 1: Dan named
  assert.ok((await A(danAlt, "leave", [], { table: tid })).ok);
  await get(`/api/casino/t/${tid}`, "u5"); tick(120);
  VK.set("danalt", "incognito"); tick(3);                             // incognito on the login he played from (not his account's)
  await get(`/api/casino/t/${tid}`, "u5");
  const live = await get(`/api/casino/t/${tid}/history`);
  assert.ok(!/\bDan\b/.test(live.text), "in memory: masked");
  assert.ok((await A(ann, "end", [], { table: tid })).ok);
  svc.S.tables.delete(tid); V._reset();
  const gone = await get(`/api/casino/t/${tid}/history`);
  assert.ok(!/\bDan\b/.test(gone.text), "out of memory: masked too (the saved player's room login) - " + gone.text.slice(0, 300));
  assert.ok(/\bAnn\b/.test(gone.text), "a named player stays named");
});

test("casmask review: the stream reply to a CAMFROG asker - the other table's host as a room line gives them (a website host's label; a room host keeps the name the room saw)", async () => {
  await fresh();
  VK.set("u:u2", "incognito");
  const t1 = (await A(bob, "start", [], { room: null })).table;     // Bob (web, incognito) hosts the table on the stream
  assert.ok((await A(bob, "bet", ["500"], { table: t1 })).ok);
  await get(`/api/casino/t/${t1}`, "u5");
  assert.ok((await svc.stream(t1, true, Object.assign({}, bob), false)).ok);
  const t2 = (await A(dan, "start", [], { room: null })).table;     // Dan (Camfrog room) hosts another table and asks for the stream
  const r = await svc.stream(t2, true, Object.assign({}, dan), false);
  assert.ok(r.ok && r.queued >= 1, r.reply);                         // (a queue an earlier test saved may be ahead)
  assert.ok(!/\bBob\b/.test(r.reply) && r.reply.includes(V.label(svc.getTable(t1), "u2") + "'s table"), "a website host: their label - " + r.reply);
  // a ROOM host on the stream, incognito: a room asker hears the name the room sees them type under; a website asker never
  await fresh();
  VK.set("dancf", "incognito");
  const t3 = (await A(dan, "start", [], { room: null })).table;
  assert.ok((await A(dan, "bet", ["500"], { table: t3 })).ok);
  await get(`/api/casino/t/${t3}`, "u5");
  assert.ok((await svc.stream(t3, true, Object.assign({}, dan), false)).ok);
  const eveRoom = Object.assign({}, eve, { via: "room", camfrog: "EveCF", room: "Casino.Room" });
  const t4 = (await A(eveRoom, "start", [], { room: null })).table;
  const roomAsk = await svc.stream(t4, true, Object.assign({}, eveRoom), false);
  assert.ok(roomAsk.ok && roomAsk.reply.includes("Dan's table"), "a room asker: the room's name for a room host - " + roomAsk.reply);
  const t5 = (await A(cat, "start", [], { room: null })).table;
  const webAsk = await svc.stream(t5, true, Object.assign({}, cat), false);
  assert.ok(webAsk.ok && !/\bDan\b/.test(webAsk.reply), "a website asker: never the name - " + webAsk.reply);
});
