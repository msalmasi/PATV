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
