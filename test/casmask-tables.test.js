"use strict";
// 1.99?? casmask (the 1.99ajw verifier's gap a): Pepe's OWN tables (his engines - a room with `!casino backend off`) on the website -
// /tables, /casino/t/<id> (GET /api/tables/state) and the homepage's first table block (home.js) - are masked by the SITE's veils too,
// on top of what Pepe masked himself before the sync (pepe_tables.py, privacy fix 2):
//   * who sits where comes from the sync's server-only `who` ({<id>: {seats: [login | "u:<id>"], host}}) - never on the wire
//   * a seat the site finds veiled (casino/veil.js kindOf: padweb.hiddenKey / Pepe's incognito report, for the login, its account's key
//     and the account's linked login) reads "someone" / "someone N" (numbered after Pepe's own labels), and so does its name in the
//     host, the turn, the result, the felt's last round and the public log; a named seat stays named
//   * fail closed: a table without `who` (an older Pepe), a key never read or a failed read masks that seat
//   * the viewer's own seat is still theirs: /api/tables/state's me.seats (by the index) and the homepage's "seated at" chip
//   * (review fixes) sticky for the table's life: after they stand up, switch their veil off, the table closes - its lines stay
//     masked; the host masked with their seat / by host_login; labels after every label of Pepe's the table shows (its log too);
//     each log line by its own table (tid); Pepe told: the sync answer's `veil` (confirmed veils only) and the claim's `veil: 1`
//   node --test test/casmask-tables.test.js      (uses a temp DB)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "casmask-tables-test-"));
process.chdir(tmp);
delete process.env.STAGING;
const { runQuery } = require(path.join(repo, "dbUtils"));
const V = require(path.join(repo, "casino", "veil"));
const tables = require(path.join(repo, "tables"));
const home = require(path.join(repo, "home"));

const VK = new Map();
V._hooks.kind = async (keys) => { for (const k of keys) if (VK.has(k)) { const v = VK.get(k); if (v === "throw") throw new Error("down"); return v; } return null; };

const TID = "abc12345";
const users = { ualice1: { userId: "ualice1", username: "alice_patv" }, ufrank1: { userId: "ufrank1", username: "frank_patv" },
                ubob001: { userId: "ubob001", username: "bob_patv" }, ueve001: { userId: "ueve001", username: "eve_patv" } };
let server, base;
const get = async (uid) => { const r = await fetch(base + "/api/tables/state", { headers: uid ? { "x-test-user": uid } : {} }); const text = await r.text(); return { text, d: JSON.parse(text) }; };
const sync = async (body) => { const r = await fetch(base + "/api/tables/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "tok" }, body)) }); return r.status; };

function holdem(extra) {
  return Object.assign({
    id: TID, game: "holdem", room: "PepeLab", room_name: "PepeLab", phase: "between", hand_no: 3, sb: 25, bb: 50, min_buy: 1000, max_buy: 10000,
    host: "Frankie", board: [], pot: 0, pots: [], current_bet: 0, max_seats: 9, act_secs: 60, home: { kind: "room", room: "PepeLab", room_name: "PepeLab" }, featured: true,
    // Pepe's own mask: seat 2 is private by HIS checks already ("someone")
    seats: [{ name: "Alice", stack: 1000, status: "waiting" }, { name: "Frankie", stack: 900, status: "waiting", host: true },
            { name: "someone", stack: 500, status: "waiting" }, { name: "Bob", stack: 700, status: "waiting" }],
    turn: null,
    result: { hand_no: 3, uncontested: false, rake: 0, winners: [{ name: "Frankie", amount: 600, hand: "a pair of aces", pot: "pot" }] },
    last_round: { hand_no: 3, uncontested: false, board: ["As", "Kd", "2c", "3h", "4s"], pot: 600, rake: 0,
                  shown: [{ name: "Frankie", cards: ["Ah", "Ad"], hand: "a pair of aces" }, { name: "Alice", cards: ["7c", "8d"], hand: "high card" }],
                  winners: [{ name: "Frankie", amount: 600, hand: "a pair of aces", pot: "pot" }] },
  }, extra || {});
}
const LOG = [{ ts: 1, game: "holdem", text: "Frankie sits down" }, { ts: 2, game: "holdem", text: "Alice bets 50" }, { ts: 3, game: "holdem", text: "Frankie wins 600 (pot) with a pair of aces" }];
const PRIV = { frank_patv: [{ table: TID, game: "holdem", seat: 1, name: "Frankie", cards: [], hand_no: 3 }],
               alice_patv: [{ table: TID, game: "holdem", seat: 0, name: "Alice", cards: [], hand_no: 3 }] };
const WHO = { [TID]: { seats: ["alice", "frankie", "hid1", "u:ubob001"], host: "frankie" } };
const reset = () => { VK.clear(); tables._reset(); V._reset(); };

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, level INTEGER DEFAULT 0, avatar TEXT)`);
  for (const [id, u, cf] of [["ualice1", "alice_patv", "alice"], ["ufrank1", "frank_patv", "Frankie"], ["ubob001", "bob_patv", null], ["ueve001", "eve_patv", "evecf"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES (?, ?, ?, 'x', ?)", [id, u, u, cf]);
  }
  const express = require("express");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users[u] || null : null; next(); };
  tables.register(app, { isBotToken: (p) => p === "tok", addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { if (server) server.close(); });

test("Pepe's own tables: a seat the SITE finds veiled is 'someone N' after Pepe's own labels - seat, host, result, last round, log; named seats stay named; who sits where never leaves the server", async () => {
  reset();
  VK.set("u:ufrank1", "incognito");                                  // Frankie: incognito by his ACCOUNT (Pepe's checks missed it)
  assert.equal(await sync({ tables: [holdem()], closed: [], log: LOG, private: PRIV, who: WHO, rooms: [] }), 200);
  const { d, text } = await get("ueve001");
  const t = d.tables[0];
  assert.deepEqual(t.seats.map((s) => s.name), ["Alice", "someone 2", "someone", "Bob"], "after Pepe's own 'someone'; seats in place");
  assert.equal(t.host, "someone 2", "the host: the same label as their seat");
  assert.deepEqual(t.result.winners.map((w) => w.name), ["someone 2"]);
  assert.deepEqual(t.last_round.shown.map((x) => x.name), ["someone 2", "Alice"]);
  assert.deepEqual(t.last_round.winners.map((x) => x.name), ["someone 2"]);
  assert.deepEqual(d.log.map((l) => l.text), ["someone 2 sits down", "Alice bets 50", "someone 2 wins 600 (pot) with a pair of aces"]);
  for (const s of ["Frankie", "frankie", "hid1", "u:ubob001", "\"who\"", "frank_patv"]) assert.ok(!text.includes(s), "never on the wire: " + s);
  // the viewer's own seat: still theirs (by its index), their own entry only
  const mine = await get("ufrank1");
  assert.deepEqual(mine.d.me.seats.map((x) => [x.table, x.seat]), [[TID, 1]], "his own seat entry (index 1)");
  assert.equal(mine.d.tables[0].seats[1].name, "someone 2", "the public seat is masked for him too (the page marks it 'you' by its index)");
  assert.ok(!/frank_patv|Frankie/.test(JSON.stringify(mine.d.tables)) && !(await get("ualice1")).text.includes("Frankie"));
  // the state kept for the next sync is untouched (masked per read)
  assert.equal(tables._state().STATE.tables[0].seats[1].name, "Frankie");
  assert.ok(!JSON.stringify(tables._state().STATE).includes("hid1"), "who is kept apart from the public state");
});

test("Pepe's own tables: the turn by its seat; an account key's linked login and a login's account key count; a named seat sharing a masked name keeps its own turn", async () => {
  reset();
  VK.set("evecf", "out");                                            // Eve: !bridge hide on her linked login - her seat is her ACCOUNT key
  VK.set("frankie", "incognito");                                    // Frankie by his login
  const live = holdem({ phase: "flop", host: "Alice", result: null, last_round: null,
    seats: [{ name: "Alice", stack: 1000, status: "active" }, { name: "Frankie", stack: 900, status: "active", turn: true }, { name: "🌐 Eve", stack: 400, status: "active" }],
    turn: { seat: 1, name: "Frankie", to_call: 50 } });
  assert.equal(await sync({ tables: [live], closed: [], log: [], private: {}, who: { [TID]: { seats: ["alice", "frankie", "u:ueve001"], host: "alice" } } }), 200);
  let t = (await get(null)).d.tables[0];
  assert.deepEqual(t.seats.map((s) => s.name), ["Alice", "someone 1", "someone 2"]);
  assert.equal(t.turn.name, "someone 1", "the turn: its seat's label");
  assert.equal(t.host, "Alice");
  VK.clear(); tables._reset();
  t = (await get(null)).d.tables[0];
  assert.deepEqual(t.seats.map((s) => s.name), ["Alice", "Frankie", "🌐 Eve"], "named again once nobody is veiled");
  assert.equal(t.turn.name, "Frankie");
});

test("Pepe's own tables fail closed: no `who` (an older Pepe), a failed read, a closed table lingering - every seat it can't check is masked", async () => {
  reset();
  assert.equal(await sync({ tables: [holdem()], closed: [], log: LOG, private: PRIV, rooms: [] }), 200);
  let { d, text } = await get(null);
  assert.deepEqual(d.tables[0].seats.map((s) => s.name), ["someone 2", "someone 3", "someone", "someone 4"], "no who: every seat masked");
  assert.ok(!/Alice|Frankie|Bob/.test(text), "nobody named");
  reset();
  VK.set("alice", "throw");
  assert.equal(await sync({ tables: [holdem()], closed: [], log: LOG, private: PRIV, who: WHO }), 200);
  d = (await get(null)).d;
  assert.equal(d.tables[0].seats[0].name, "someone 2", "a failed read masks that seat (after Pepe's own 'someone')");
  assert.ok(!d.log.some((l) => /Alice/.test(l.text)));
  assert.equal(d.tables[0].seats[1].name, "Frankie", "the others as they read");
  // a closed table lingering with its final round: masked the same way
  reset();
  VK.set("frankie", "incognito");
  const closed = Object.assign(holdem(), { phase: "closed", linger_until: Date.now() / 1000 + 30 });
  assert.equal(await sync({ bot_now: Date.now() / 1000, tables: [], closed: [closed], log: LOG, private: {}, who: WHO }), 200);
  ({ d, text } = await get(null));
  assert.equal(d.closed.length, 1);
  assert.deepEqual(d.closed[0].seats.map((s) => s.name), ["Alice", "someone 2", "someone", "Bob"]);
  assert.ok(!/Frankie/.test(text));
});

test("the homepage: Pepe's tables list masked, and the viewer's own seat found by their own seat list - a masked seat of theirs too", async () => {
  reset();
  VK.set("frankie", "incognito");
  assert.equal(await sync({ tables: [holdem()], closed: [], log: LOG, private: PRIV, who: WHO }), 200);
  const S = await home.stats();
  const row = (S.tables || []).find((t) => t.id === TID);
  assert.ok(row, "the table is listed");
  assert.deepEqual(row.seats, ["Alice", "someone 2", "someone", "Bob"], "the first table block: masked names");
  const frank = { userId: "ufrank1", username: "frank_patv", camfrogUsername: "Frankie" };
  const P = await home.personal(frank, S);
  assert.ok(P.seat && P.seat.id === TID, "his own (masked) seat: 'seated at' still shows");
  const eve = { userId: "ueve001", username: "eve_patv", camfrogUsername: "evecf" };
  assert.equal((await home.personal(eve, S)).seat, null, "someone not at the table");
  const src = fs.readFileSync(path.join(repo, "home.js"), "utf8");
  assert.match(src, /const T = await require\("\.\/tables"\)\.view\(\);/, "the homepage reads Pepe's tables through the site's veils");
});

test("Pepe's own tables: a seat whose key is the login an alias folds into is checked by the login it typed from too", async () => {
  reset();
  VK.set("frankalt", "incognito");                                   // incognito on the login he played from (Pepe's key: "frankie")
  assert.equal(await sync({ tables: [holdem()], closed: [], log: LOG, private: PRIV,
                            who: { [TID]: { seats: ["alice", "frankie", "hid1", "u:ubob001"], logins: [null, "frankalt", null, null], host: "frankie" } } }), 200);
  const { d, text } = await get(null);
  assert.equal(d.tables[0].seats[1].name, "someone 2");
  assert.ok(!text.includes("frankalt"), "the login never on the wire");
  reset();
  assert.equal(await sync({ tables: [holdem()], closed: [], log: LOG, private: PRIV,
                            who: { [TID]: { seats: ["alice", "frankie", "hid1", "u:ubob001"], logins: [null, "frankalt", null, null], host: "frankie" } } }), 200);
  assert.equal((await get(null)).d.tables[0].seats[1].name, "Frankie", "named when neither is veiled");
});

// ── 1.99?? casmask review fixes ──
const syncJ = async (body) => { const r = await fetch(base + "/api/tables/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "tok" }, body)) }); return { status: r.status, d: await r.json() }; };
const LR = { hand_no: 3, uncontested: false, board: ["As", "Kd", "2c", "3h", "4s"], pot: 600, rake: 0,
             shown: [{ name: "Frankie", cards: ["Ah", "Ad"], hand: "a pair of aces" }, { name: "Alice", cards: ["7c", "8d"], hand: "high card" }],
             winners: [{ name: "Frankie", amount: 600, hand: "a pair of aces", pot: "pot" }] };
const plain = (seats, extra) => holdem(Object.assign({ host: "Alice", result: { hand_no: 3, uncontested: false, rake: 0, winners: LR.winners }, last_round: LR,
  seats: seats.map((n, i) => ({ name: n, stack: 900 + i, status: "waiting", host: n === "Alice" })) }, extra || {}));

test("review: sticky for the table's life - a site-veiled player who stands up, switches the veil off, or whose table closes stays masked (seat, host, result, last round, every log line)", async () => {
  reset();
  VK.set("u:ufrank1", "incognito");                                  // only the SITE finds him veiled (Pepe's checks missed it)
  const log1 = [{ ts: 1, game: "holdem", text: "Frankie sits down", tid: TID }, { ts: 2, game: "holdem", text: "Frankie raises to 400", tid: TID },
                { ts: 3, game: "holdem", text: "Frankie wins 600 (pot) with a pair of aces", tid: TID }];
  const who = (seats) => ({ [TID]: { seats, host: "alice" } });
  assert.equal(await sync({ tables: [plain(["Alice", "Frankie", "Bob"])], closed: [], log: log1, who: who(["alice", "frankie", "u:ubob001"]) }), 200);
  let { d, text } = await get(null);
  assert.deepEqual(d.tables[0].seats.map((s) => s.name), ["Alice", "someone", "Bob"]);
  assert.ok(!/Frankie/.test(text));
  // he stands up between hands (Pepe logs it under his name, the felt's last round still shows his hand)
  const log2 = log1.concat([{ ts: 4, game: "holdem", text: "🚪 Frankie leaves the table — 1,500 chips back to PAT.", tid: TID }]);
  assert.equal(await sync({ tables: [plain(["Alice", "Bob"])], closed: [], log: log2, who: who(["alice", "u:ubob001"]) }), 200);
  ({ d, text } = await get(null));
  assert.ok(!/Frankie/.test(text), "after he left: still masked everywhere - " + text.slice(0, 400));
  assert.deepEqual(d.log.map((l) => l.text), ["someone sits down", "someone raises to 400", "someone wins 600 (pot) with a pair of aces",
                                              "🚪 someone leaves the table — 1,500 chips back to PAT."]);
  assert.equal(d.tables[0].last_round.winners[0].name, "someone");
  assert.equal(d.tables[0].result.winners[0].name, "someone");
  assert.ok(!d.log.some((l) => "tid" in l), "the line's table stays on the server");
  // back at the table with his veil switched OFF (re-read): the same seat keeps the mask for the rest of this table
  VK.clear(); tables._kinds();
  assert.equal(await sync({ tables: [plain(["Alice", "Frankie", "Bob"])], closed: [], log: log2, who: who(["alice", "frankie", "u:ubob001"]) }), 200);
  ({ d, text } = await get(null));
  assert.deepEqual(d.tables[0].seats.map((s) => s.name), ["Alice", "someone", "Bob"], "veil off mid-table: still 'someone' here");
  assert.ok(!/Frankie/.test(text));
  // the table closes (no linger): Pepe's log keeps its lines - still masked; they leave the log -> the record goes
  assert.equal(await sync({ tables: [], closed: [], log: log2, who: {} }), 200);
  ({ d, text } = await get(null));
  assert.ok(!/Frankie/.test(text) && d.log.length === 4, "closed: the lines it wrote stay masked");
  assert.ok(tables._state().STICKY.has(TID));
  assert.equal(await sync({ tables: [], closed: [], log: [{ ts: 9, game: "bj", text: "Round 1 - dealing", tid: "beef0001" }], who: {} }), 200);
  await get(null);
  assert.ok(!tables._state().STICKY.has(TID), "no line of it left: forgotten");
  // a NEW table (another id) with him named: named
  const T2 = "abc99999";
  assert.equal(await sync({ tables: [Object.assign(plain(["Alice", "Frankie"]), { id: T2 })], closed: [], log: [], who: { [T2]: { seats: ["alice", "frankie"], host: "alice" } } }), 200);
  assert.deepEqual((await get(null)).d.tables[0].seats.map((s) => s.name), ["Alice", "Frankie"], "another table: his own veil decides");
});

test("review: a check that can't say (no read, a failed read) masks for that answer only - never sticky", async () => {
  reset();
  VK.set("frankie", "throw");
  assert.equal(await sync({ tables: [plain(["Alice", "Frankie"])], closed: [], log: [], who: { [TID]: { seats: ["alice", "frankie"], host: "alice" } } }), 200);
  assert.equal((await get(null)).d.tables[0].seats[1].name, "someone", "a failed read: masked");
  VK.clear(); tables._kinds();
  assert.equal((await get(null)).d.tables[0].seats[1].name, "Frankie", "read fine now: named (a blip never sticks)");
  assert.equal(tables._state().STICKY.size, 0);
});

test("review: the host - masked with their seat (an alias seat masked by its typed login) and by host_login; a masked seat showing the host's name masks the host", async () => {
  reset();
  VK.set("frankalt", "incognito");
  const seats = [{ name: "Alice", stack: 1000, status: "waiting" }, { name: "Frankie", stack: 900, status: "waiting", host: true }];
  assert.equal(await sync({ tables: [holdem({ seats, host: "Frankie", result: null, last_round: null })], closed: [], log: [{ ts: 1, game: "holdem", text: "Frankie sits down", tid: TID }],
                            who: { [TID]: { seats: ["alice", "frankie"], logins: [null, "frankalt"], host: "frankie" } } }), 200);
  let { d, text } = await get(null);
  assert.deepEqual([d.tables[0].seats[1].name, d.tables[0].host], ["someone", "someone"], "the alias host's seat and the host field: one label");
  assert.ok(!/Frankie|frankalt/.test(text));
  // a host who never sat, veiled by the login they typed from (who.host_login)
  reset();
  VK.set("frankalt", "incognito");
  assert.equal(await sync({ tables: [holdem({ seats: [seats[0]], host: "Frankie", result: null, last_round: null })], closed: [], log: [],
                            who: { [TID]: { seats: ["alice"], host: "frankie", host_login: "frankalt" } } }), 200);
  ({ d, text } = await get(null));
  assert.equal(d.tables[0].host, "someone");
  assert.ok(!/Frankie|frankalt/.test(text));
  // a seated host masked by host_login alone: their seat (with its host mark) is masked with them
  reset();
  VK.set("frankalt", "incognito");
  assert.equal(await sync({ tables: [holdem({ seats, host: "Frankie", result: null, last_round: null })], closed: [], log: [],
                            who: { [TID]: { seats: ["alice", "frankie"], host: "frankie", host_login: "frankalt" } } }), 200);
  ({ d, text } = await get(null));
  assert.deepEqual([d.tables[0].seats[1].name, d.tables[0].seats[1].host, d.tables[0].host], ["someone", true, "someone"]);
  assert.ok(!/Frankie|frankalt/.test(text));
  // no keys to go by: a masked seat with the host's name masks the host too
  reset();
  VK.set("frankie", "incognito");
  assert.equal(await sync({ tables: [holdem({ seats, host: "Frankie", result: null, last_round: null })], closed: [], log: [],
                            who: { [TID]: { seats: ["alice", "frankie"], host: null } } }), 200);
  ({ d } = await get(null));
  assert.equal(d.tables[0].host, "someone", "the host's name on a masked seat: masked");
});

test("review: labels never reuse one of Pepe's - also a label only his log, result or last round still shows (someone who left)", async () => {
  reset();
  VK.set("frankie", "incognito");
  const log = [{ ts: 1, game: "holdem", text: "🏆 someone 2 +900", tid: TID }, { ts: 2, game: "holdem", text: "👋 someone 2 left the table", tid: TID },
               { ts: 3, game: "holdem", text: "💺 Frankie buys in", tid: TID }];
  const t = holdem({ host: "Alice", result: { hand_no: 3, uncontested: true, rake: 0, winners: [{ name: "someone 1", amount: 900, hand: "", pot: "pot" }] }, last_round: null,
                     seats: [{ name: "Alice", stack: 1000, status: "waiting" }, { name: "Frankie", stack: 900, status: "waiting" }] });
  assert.equal(await sync({ tables: [t], closed: [], log, who: { [TID]: { seats: ["alice", "frankie"], host: "alice" } } }), 200);
  const { d } = await get(null);
  assert.equal(d.tables[0].seats[1].name, "someone 3", "after Pepe's 'someone 2' (his log) - never a label he used for someone else");
  assert.deepEqual(d.log.map((l) => l.text), ["🏆 someone 2 +900", "👋 someone 2 left the table", "💺 someone 3 buys in"]);
});

test("review: each log line by its own table - another table's line keeps its name; an older Pepe's line (no tid) by its game", async () => {
  reset();
  VK.set("frankie", "incognito");
  const T2 = "def45678";
  const bj = { id: T2, game: "bj", room: "PepeLab", room_name: "PepeLab", phase: "betting", round_no: 1, min_bet: 100, max_bet: 1000, host: "Bob",
               max_seats: 7, act_secs: 30, decks: 6, dealer: { cards: [] }, seats: [{ name: "Bob", bet: 0, hands: [] }], turn: null, result: null, last_round: null,
               home: { kind: "room", room: "PepeLab", room_name: "PepeLab" }, featured: false };
  const log = [{ ts: 1, game: "holdem", text: "Frankie raises to 400", tid: TID }, { ts: 2, game: "bj", text: "Frankie says hi at blackjack", tid: T2 },
               { ts: 3, game: "holdem", text: "Frankie checks" }];
  assert.equal(await sync({ tables: [plain(["Alice", "Frankie"]), bj], closed: [], log,
                            who: { [TID]: { seats: ["alice", "frankie"], host: "alice" }, [T2]: { seats: ["bob"], host: "bob" } } }), 200);
  const { d } = await get(null);
  assert.deepEqual(d.log.map((l) => l.text), ["someone raises to 400", "Frankie says hi at blackjack", "someone checks"]);
});

test("review: Pepe is told - the sync answer names the seats the site finds veiled (confirmed veils + the sticky ones; never a failed or unread check)", async () => {
  reset();
  VK.set("frankie", "incognito"); VK.set("evecf", "out"); VK.set("bob", "throw");
  const t = plain(["Alice", "Frankie", "🌐 Eve", "Bob"]);
  const r1 = await syncJ({ tables: [t], closed: [], log: [], who: { [TID]: { seats: ["alice", "frankie", "u:ueve001", "bob"], host: "alice" } } });
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.d.veil && r1.d.veil[TID] && r1.d.veil[TID].sort(), ["frankie", "u:ueve001"], JSON.stringify(r1.d));
  VK.clear(); tables._kinds();
  const r2 = await syncJ({ tables: [t], closed: [], log: [], who: { [TID]: { seats: ["alice", "frankie", "u:ueve001", "bob"], host: "alice" } } });
  assert.deepEqual(r2.d.veil[TID].sort(), ["frankie", "u:ueve001"], "kept: they stay masked at this table (sticky)");
  reset();
  const r3 = await syncJ({ tables: [t], closed: [], log: [], who: { [TID]: { seats: ["alice", "frankie", "u:ueve001", "bob"], host: "alice" } } });
  assert.deepEqual(r3.d, { ok: true }, "nobody veiled: the answer as before");
});

test("review: a website action Pepe claims carries veil: 1 when the site finds its player veiled (by the login, the account or its linked login) - never on a failed read", async () => {
  reset();
  await runQuery("DELETE FROM pepe_actions");
  VK.set("u:ufrank1", "incognito"); VK.set("bob", "throw");
  const now = Date.now();
  for (const [uid, u, cf] of [["ufrank1", "frank_patv", "Frankie"], ["ualice1", "alice_patv", "alice"], ["ubob001", "bob_patv", "bob"]]) {
    await runQuery("INSERT INTO pepe_actions (user_id, username, camfrog, kind, args, status, created) VALUES (?, ?, ?, 'table', ?, 'pending', ?)",
      [uid, u, cf, JSON.stringify(["holdem", "check", "t=" + TID]), now]);
  }
  const r = await fetch(base + "/api/tables/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "tok" }) });
  const d = await r.json();
  const by = Object.fromEntries(d.actions.map((a) => [a.username, a]));
  assert.equal(by.frank_patv.veil, 1, "incognito by his account: veil");
  assert.ok(!("veil" in by.alice_patv), "named: no veil");
  assert.ok(!("veil" in by.bob_patv), "a failed read: no veil (Pepe's veil is sticky - never a blip)");
});
