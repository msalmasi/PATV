// Phase 5 (5.16): the supply counts every pool the site owns from its own tables (supply.js).
//   * Pepe's snapshot shrinks to the rows he still holds once the pools live on the site: the total doesn't move by one PAT
//     (his old full snapshot and the shrunk one give the same total)
//   * the casino backend's tables: blackjack stakes in a round and hold'em stacks / pots are PAT out of the wallets and not in
//     the House yet - counted as "casino:tables" (closed tables never)
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
  await runQuery("INSERT INTO casino_tables (id, game, status, state) VALUES ('h1', 'holdem', 'open', ?)", [JSON.stringify({ eng: { chips: { u1: 900, u2: 0 }, contrib: { u1: 100, u2: 100 } } })]);
  await runQuery("INSERT INTO casino_tables (id, game, status, state) VALUES ('h2', 'holdem', 'closed', ?)", [JSON.stringify({ eng: { chips: { u1: 5 } } })]);
  assert.equal(await SUP.casinoHeld(), 250 + 1100);
  const s = await SUP.patSupply();
  assert.equal(s.rows.find((r) => r.key === "casino:tables").amount, 1350);
  assert.equal(s.total, WANT + 1350);
});
