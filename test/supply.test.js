// Phase 5 (5.16): the supply counts every pool the site owns from its own tables (supply.js).
//   * Pepe's snapshot shrinks to the rows he still holds once the pools live on the site: the total doesn't move by one PAT
//     (his old full snapshot and the shrunk one give the same total)
//   * the casino backend's tables: blackjack stakes in a round and hold'em stacks / pots are PAT out of the wallets and not in
//     the House yet - counted as "casino:tables" (closed tables never)
//   * 1.99aoj: a cash hold'em table is counted exactly as 1.99aoi counts it (its stacks + e.contrib, between hands too; never
//     T.rake_due - the fix waits until after H2a); what a blackjack or Hold'em table owes counts (casino/owed.js held), and with
//     nothing owed the total is 1.99aoi's own supply.js's for the same state
//   NODE_PATH=G:/PATV/node_modules node --test test/supply.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "supply-test-"));
process.chdir(tmp);
process.env.STAGING = "1";                 // the pools switch's staging default (on)
process.env.SECRET_KEY = "test-secret";
process.env.DB_BACKUP_DIR = path.join(tmp, "backups");
const { runQuery } = require(path.join(repo, "dbUtils"));
const SUP = require(path.join(repo, "supply"));
const P = require(path.join(repo, "pools"));

const POOLS = { reserve: 1000000, fortknox: 500000, incentives: 200000, heist: 100000, "room:pad1": 7000 };
// what Pepe pushed before Phase 5 (pools local): every pool + pad vault + what only he holds
const FULL = [...Object.entries(POOLS).map(([k, v]) => ({ key: k.startsWith("room:") ? k : "vault:" + k, label: k, amount: v })),
              { key: "turf:stakes", label: "stakes", amount: 4321 }, { key: "turf:tills", label: "tills", amount: 99 }];
// what he pushes once the pools live on the site: only his own rows
const SHRUNK = FULL.filter((r) => r.key.startsWith("turf:"));

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT, points_balance INTEGER DEFAULT 0,
                  camfrogUsername TEXT, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, created DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("INSERT INTO users (userId, username, password, points_balance) VALUES ('u1', 'ann', 'x', 1000), ('u2', 'bob', 'x', 2500)");
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, amount) VALUES ('j1', 500)");
  await require(path.join(repo, "funding")).init();
  P._setSupplyFn(SUP.patSupply);
});

const total = async () => (await SUP.patSupply()).total;
const WANT = 1000 + 2500 + 500 + Object.values(POOLS).reduce((a, b) => a + b, 0) + 4321 + 99;

test("pools local: Pepe's full snapshot is the supply", async () => {
  await SUP.putSnapshot(FULL);
  assert.equal(await total(), WANT);
});

test("pools on the site: the old full snapshot and the shrunk one give the same total, to the PAT", async () => {
  const payload = JSON.stringify({ v: 1, source: "pepe", pools: POOLS, supply: FULL, docs: {}, routes: {}, econ_cfg: {}, econ_cfg_log: [], catalog: {} });
  const r = await P.importFromPepe({ key: "pc-supply-test", payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"),
                                     totals: { sum: Object.values(POOLS).reduce((a, b) => a + b, 0), count: Object.keys(POOLS).length, per_pool: POOLS } });
  assert.equal(r.ok, true);
  assert.equal(await total(), WANT, "with Pepe's old full rows");
  await SUP.putSnapshot(SHRUNK);
  assert.equal(await total(), WANT, "with only the rows Pepe holds");
  const keys = (await SUP.patSupply()).rows.map((x) => x.key);
  for (const k of ["vault:reserve", "vault:fortknox", "room:pad1", "turf:stakes", "turf:tills"]) assert.ok(keys.includes(k), k);
});

test("casino tables: stakes in a blackjack round and hold'em stacks + pot count; closed tables don't", async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS casino_tables (id TEXT PRIMARY KEY, game TEXT NOT NULL, status TEXT NOT NULL, room TEXT, host TEXT,
                  state TEXT NOT NULL, rev INTEGER DEFAULT 0, created INTEGER, updated INTEGER)`);
  assert.equal(await SUP.casinoHeld(), 0);
  await runQuery("INSERT INTO casino_tables (id, game, status, state) VALUES ('b1', 'bj', 'open', ?)", [JSON.stringify({ escrowed: { u1: 200, u2: 50 } })]);
  await runQuery("INSERT INTO casino_tables (id, game, status, state) VALUES ('h1', 'holdem', 'open', ?)", [JSON.stringify({ eng: { chips: { u1: 900, u2: 0 }, contrib: { u1: 100, u2: 100 }, hand_active: true } })]);
  await runQuery("INSERT INTO casino_tables (id, game, status, state) VALUES ('h2', 'holdem', 'closed', ?)", [JSON.stringify({ eng: { chips: { u1: 5 } } })]);
  assert.equal(await SUP.casinoHeld(), 250 + 1100);
  const s = await SUP.patSupply();
  assert.equal(s.rows.find((r) => r.key === "casino:tables").amount, 1350);
  assert.equal(s.total, WANT + 1350);
});

// h22 review (1.99alz): a 🏁 Sit & Go is a Hold'em table row too, but its stacks are TOURNAMENT CHIPS (casino/tourney.js) - the PAT
// behind them is the entries' TNY escrow holds, already counted with the escrow (escrow:holds / escrow:service). Counting the chips
// as well would add a fake mint while it runs and a fake burn when it ends (supply history, issuance %, the econ page).
test("casino tables: a sit & go's tournament chips are not PAT - never counted (its entries are escrow holds)", async () => {
  const before = await SUP.casinoHeld();
  for (const status of ["registering", "running", "settling"]) {
    await runQuery("INSERT INTO casino_tables (id, game, status, state) VALUES (?, 'holdem', 'open', ?)",
                   ["sng-" + status, JSON.stringify({ eng: { chips: { u1: 1500, u2: 1300 }, contrib: { u2: 200 } }, tourney: { v: 1, status } })]);
  }
  assert.equal(await SUP.casinoHeld(), before, "three sit & gos' tournament chips change nothing");
  assert.equal((await SUP.patSupply()).total, WANT + 1350);
});

// 1.99aoj (review): this release counts a cash Hold'em table exactly as 1.99aoi does - its stacks and e.contrib, between hands too
// (the last pot is in both: a known double count), never T.rake_due. patSupply().total is an input of the economy engines that move to
// the site at H2a, so the fix (contributions only while a hand is in play, the rake until the House books it) ships on its own after
// H2a's first clean gate, with the owner's OK: no step in the supply at this deploy, and none back at a rollback.
test("casino tables: a cash hold'em table counts as 1.99aoi counts it (stacks + contributions, between hands too) - no engine input moves at this deploy", async () => {
  const before = await SUP.casinoHeld();
  // a 2-player hand: both put in 100 (contrib), u1 won the 200 pot minus a 10 rake: stacks 1090 + 900, the hand is over
  const T = { eng: { chips: { u1: 1090, u2: 900 }, contrib: { u1: 100, u2: 100 }, hand_active: false }, rake_due: { key: "chm:h3:h7:rake", n: 7, amount: 10 } };
  await runQuery("INSERT INTO casino_tables (id, game, status, state) VALUES ('h3', 'holdem', 'open', ?)", [JSON.stringify(T)]);
  assert.equal(await SUP.casinoHeld(), before + 1090 + 900 + 200, "between hands: the stacks + the last hand's contributions, as before (not the rake owed)");
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, amount) VALUES ('chm:h3:h7:rake', 10)");
  assert.equal(await SUP.casinoHeld(), before + 1090 + 900 + 200, "the House's rake row changes nothing at the table");
  delete T.rake_due;
  T.eng.contrib = { u1: 25, u2: 50 }; T.eng.chips = { u1: 1065, u2: 850 }; T.eng.hand_active = true;     // the next hand: blinds in
  await runQuery("UPDATE casino_tables SET state = ? WHERE id = 'h3'", [JSON.stringify(T)]);
  assert.equal(await SUP.casinoHeld(), before + 1065 + 850 + 75, "a hand in play: the stacks + what is in the pot");
  await runQuery("DELETE FROM casino_tables WHERE id = 'h3'");
  await runQuery("DELETE FROM jackpot_rakes WHERE jackpotId = 'chm:h3:h7:rake'");
});

// 1.99aoj: a blackjack payout whose credit was refused stays owed at the table (casino/service.js payOwed) - PAT at the table until it lands
test("casino tables: a blackjack payout kept owed (a refused credit) counts at the table", async () => {
  const before = await SUP.casinoHeld();
  await runQuery("INSERT INTO casino_tables (id, game, status, state) VALUES ('b9', 'bj', 'open', ?)",
                 [JSON.stringify({ escrowed: {}, owed: { "cbj:b9:r3:u9:pay": { uid: "u9", amount: 2000, round: 3 } } })]);
  assert.equal(await SUP.casinoHeld(), before + 2000);
  await runQuery("DELETE FROM casino_tables WHERE id = 'b9'");
  assert.equal(await SUP.casinoHeld(), before);
});

// 1.99aoj (the owed casino PAT): supply.js counts what a blackjack or Hold'em table owes (casino/owed.js held) and nothing else
// new - with nothing owed, patSupply().total is the deployed base's (1.99aoi's own supply.js, vendored byte for byte in
// test/fixtures/casino-prev/ - test/casino-rl-store.test.js checks the copies against the base) for the same state: blackjack
// stakes, a Hold'em hand in play, between hands (the last pot counted twice, as 1.99aoi does) with its rake not booked / booked,
// a refused cash-out's seat (its stack is in the chips), a Sit & Go, an empty T.owed. (The roulette rows are checked against
// that build's own count in test/casino-rl-store.test.js: held() === its heldJson.)
test("casino tables: with nothing owed, patSupply().total is 1.99aoi's to the PAT; an owed item is the only difference, until it lands or is written off", async () => {
  const Module = require("module");
  const prevDir = path.join(__dirname, "fixtures", "casino-prev");
  const man = JSON.parse(fs.readFileSync(path.join(prevDir, "manifest.json"), "utf8"));
  const text = fs.readFileSync(path.join(prevDir, "supply.js.txt"), "utf8").replace(/\r\n/g, "\n");
  const bytes = Buffer.from(text, "utf8");
  assert.equal(crypto.createHash("sha1").update(Buffer.concat([Buffer.from("blob " + bytes.length + "\0"), bytes])).digest("hex"), man.files["supply.js"],
               "the vendored supply.js is the base's blob");
  // 1.99aoi's supply.js, compiled under this repo's supply.js path (its requires resolve to the same dbUtils / pools / ... as SUP's)
  const file = path.join(repo, "supply.js");
  const m = new Module(file, module);
  m.filename = file;
  m.paths = Module._nodeModulePaths(repo);
  m._compile(text, file);
  const PREV = m.exports;
  assert.notEqual(PREV.casinoHeld, SUP.casinoHeld);
  const same = async (why) => {
    assert.equal(await SUP.casinoHeld(), await PREV.casinoHeld(), "casino:tables - " + why);
    assert.equal((await SUP.patSupply()).total, (await PREV.patSupply()).total, "patSupply().total - " + why);
  };
  const apart = async (n, why) => assert.equal((await SUP.patSupply()).total - (await PREV.patSupply()).total, n, why);
  const put = (id, game, s) => runQuery("INSERT INTO casino_tables (id, game, status, state) VALUES (?, ?, 'open', ?)", [id, game, JSON.stringify(s)]);
  const set = (id, s) => runQuery("UPDATE casino_tables SET state = ? WHERE id = ?", [JSON.stringify(s), id]);
  await same("the tables the tests above left (blackjack stakes, a hand in play, sit & gos, a closed table)");
  const B = { escrowed: { u1: 400, u2: 150 }, owed: {}, closing: "an admin close" };
  await put("bq1", "bj", B);
  const H = { eng: { chips: { u1: 1090, u2: 900 }, contrib: { u1: 100, u2: 100 }, hand_active: false, seats: ["u1", "u2"] },
              rake_due: { key: "chm:hq1:h7:rake", n: 7, amount: 10 }, owed: {} };
  await put("hq1", "holdem", H);
  await same("a blackjack table with stakes and an empty T.owed; a Hold'em table between hands, its rake not booked");
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, amount) VALUES ('chm:hq1:h7:rake', 10)");
  await same("the rake booked");
  const C = { eng: { chips: { u2: 2500 }, contrib: {}, hand_active: false, seats: ["u2"] },
              qol: { u2: { out: true, refused: { key: "chm:hq2:out:u2:1", since: 1, tries: 2, code: "E_NO_ACCOUNT" } } } };
  await put("hq2", "holdem", C);
  await same("a refused cash-out's seat (its stack is in the chips; nothing in T.owed)");
  H.eng.contrib = { u1: 25, u2: 50 }; H.eng.chips = { u1: 1065, u2: 850 }; H.eng.hand_active = true;
  await set("hq1", H);
  await same("the next hand in play");
  // an item owed: the only difference, exactly its amount (1.99aoi never counted T.owed)
  B.owed = { "cbj:bq1:r3:u1:pay": { uid: "u1", amount: 2000, round: 3, kind: "payout" } };
  await set("bq1", B);
  H.owed = { "chm:hq1:i9:refund": { uid: "u2", amount: 3000, round: null, kind: "refund" } };
  await set("hq1", H);
  await apart(5000, "a blackjack payout + a Hold'em buy-in refund owed");
  // its credit landed while the table's save is behind: it isn't PAT at the table any more - identical again for that item
  await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES ('cbj:bq1:r3:u1:pay', 'u1', 'blackjack payout', 2000)");
  await runQuery("UPDATE users SET points_balance = points_balance + 2000 WHERE userId = 'u1'");
  await apart(3000, "the payout landed (the table's T.owed still lists it)");
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, amount) VALUES ('chm:hq1:i9:refund:writeoff', 'chm:hq1:owed', 3000)");
  await same("the refund written off to the House (the table's T.owed still lists it)");
  for (const id of ["bq1", "hq1", "hq2"]) await runQuery("DELETE FROM casino_tables WHERE id = ?", [id]);
  for (const k of ["chm:hq1:h7:rake", "chm:hq1:i9:refund:writeoff"]) await runQuery("DELETE FROM jackpot_rakes WHERE jackpotId = ?", [k]);
  await runQuery("DELETE FROM transactions WHERE transactionId = 'cbj:bq1:r3:u1:pay'");
  await runQuery("UPDATE users SET points_balance = points_balance - 2000 WHERE userId = 'u1'");
  await same("back to the tables the tests above left");
});
