// PO-0b (the owner's 2026-10-20 finding (b)): the escrow / gangs / capital op-status endpoints answer like the fixed (1.99adl)
// stash / pool move_status - IN ORDER (queued behind every transaction already waiting, so an op that reached the site
// first is answered, not "not yet") and FROM COMMITTED ROWS (never an OPEN transaction's journal row that a rollback then
// takes back). Pepe's clients read "no record yet" as unknown (their side, PO-0c).
//   POST /api/escrow/bot/status {keys, hids}   escrow/ledger.settledStatus
//   POST /api/gangs/bot/op-status {key}        gangs.settledOpStatus
//   POST /api/capital/bot/op-status {key}      capital/core.settledOpStatus
//   NODE_PATH=G:/PATV/node_modules node --test test/op-status-settled.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "op-status-settled-test-")));
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery, tx } = require(path.join(repo, "dbUtils"));
const L = require(path.join(repo, "escrow", "ledger"));
const G = require(path.join(repo, "gangs"));
const C = require(path.join(repo, "capital", "core"));

let base, server;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot" }, body)) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await L.init();
  await G.init();
  await C.init();
  const app = express();
  app.use(express.json());
  const deps = { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() };
  L.register(app, deps);
  G.register(app, deps);
  require(path.join(repo, "capital", "service")).register(app, deps);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());

const JOURNALS = [
  // [name, the INSERT of one journal row for key k, the plain read, the endpoint -> its answer for k]
  ["escrow", (k) => runQuery("INSERT INTO escrow_moves (key, op, ts, amount, result) VALUES (?, 'hold', ?, 5, ?)", [k, Date.now(), JSON.stringify({ ok: true, key: k })]),
   async (k) => (await L.status([k]))[k], async (k) => (await post("/api/escrow/bot/status", { keys: [k], hids: [] })).body.results[k]],
  ["gangs", (k) => runQuery("INSERT INTO gang_ops (key, gid, op, ts, result) VALUES (?, 'aa11bb22', 'move', ?, ?)", [k, Date.now(), JSON.stringify({ ok: true, key: k })]),
   (k) => G.opStatus(k), async (k) => (await post("/api/gangs/bot/op-status", { key: k })).body.result],
  ["capital", (k) => runQuery("INSERT INTO capital_ops (key, op, ts, result) VALUES (?, 'vaults:stake', ?, ?)", [k, Date.now(), JSON.stringify({ ok: true, key: k })]),
   (k) => C.opStatus(k), async (k) => (await post("/api/capital/bot/op-status", { key: k })).body.result],
];

for (const [name, insert, plain, endpoint] of JOURNALS) {
  test(`${name}: an op queued behind an open transaction is answered (the endpoint waits), not "not recorded"`, async () => {
    const k = `${name}-queued-0001`;
    let release;
    const held = new Promise((r) => { release = r; });
    const blocker = tx(async () => { await held; });
    const op = tx(() => insert(k));                    // the op Pepe gave up on: queued behind the blocker
    let r;
    try {
      await tick();
      assert.equal(await plain(k), null, "the plain read says not recorded YET");
      let answered = false;
      r = endpoint(k).then((x) => { answered = true; return x; });
      await tick();
      assert.equal(answered, false, "Pepe's status waits behind the queued op");
    } finally {
      release();
    }
    await blocker;
    await op;
    const got = await r;
    assert.equal(got && got.ok, true, "...and then reports it: " + JSON.stringify(got));
  });

  test(`${name}: an OPEN transaction's row that is rolled back is never reported`, async () => {
    const k = `${name}-doomed-0001`;
    let go, inserted;
    const gate = new Promise((res) => { go = res; });
    const ins = new Promise((res) => { inserted = res; });
    const doomed = tx(async () => {
      await insert(k);
      inserted();
      await gate;
      throw new Error("COMMIT failed");
    }).catch((e) => e.message);
    await ins;
    let r;
    try {
      assert.equal(((await plain(k)) || {}).ok, true, "the plain read sees the uncommitted row (one shared connection)");
      r = endpoint(k);
      await tick();
    } finally {
      go();
    }
    assert.equal(await doomed, "COMMIT failed");
    assert.equal(await r, null, "not recorded - it never committed");
  });
}

test("escrow games: a game rollback's \"already done?\" check never answers from an open transaction's row (review PO-0b)", async () => {
  // Pepe retries a game rollback after a timeout while the first attempt's tx has written rollback:<game>:<key> but not
  // committed. The retry must not take that row as a dup (and run the game locally) - it waits, sees nothing committed,
  // and gets the real answer (here: the game isn't live on the site -> 409 E_NOT_LIVE, nothing handed back).
  const GM = require(path.join(repo, "escrow", "games"));
  const key = "gm-rollback-doomed-0001";
  const mk = `rollback:wagers:${key}`;
  let go, inserted;
  const gate = new Promise((res) => { go = res; });
  const ins = new Promise((res) => { inserted = res; });
  const doomed = tx(async () => {
    await runQuery("INSERT INTO escrow_moves (key, op, ts, amount, result) VALUES (?, 'rollback', ?, 0, ?)",
                   [mk, Date.now(), JSON.stringify({ ok: true, game: "wagers", key, records: [], sum: 0, count: 0 })]);
    inserted();
    await gate;
    throw new Error("COMMIT failed");
  }).catch((e) => e.message);
  await ins;
  let r;
  try {
    assert.equal(((await L.status([mk]))[mk] || {}).ok, true, "the plain read sees the uncommitted row (one shared connection)");
    r = GM.rollbackGame({ game: "wagers", key, actor: "pepe" }).then((x) => ({ ok: true, x }), (e) => ({ ok: false, e }));
    await tick();
  } finally {
    go();
  }
  assert.equal(await doomed, "COMMIT failed");
  const got = await r;
  assert.equal(got.ok, false, "not a dup of a row that never committed: " + JSON.stringify(got.x));
  assert.equal(got.e.code, "E_NOT_LIVE");
  assert.equal(got.e.status, 409);
  assert.equal((await L.status([mk]))[mk], null, "and nothing was recorded under the key");
});

test("the settled readers: a bad key is null; escrow's answers the holds asked about in the same read", async () => {
  assert.equal(await G.settledOpStatus("bad key!"), null);
  assert.equal(await C.settledOpStatus("x"), null);
  const s = await L.settledStatus(["not a key!"], ["nope"]);
  assert.deepEqual(s, { results: {}, holds: [] });
});
