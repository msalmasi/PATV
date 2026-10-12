// Phase 5 (5.15): the AI judge as an oracle client (oracle.js).
//   * propose: refused while the switch is off; keyed (a retry answers the same); a new proposal supersedes the open one
//   * site-owned items (an AI-judged parimutuel pool live on the escrow engine): the window ends -> the SITE settles it as
//     Pepe's judge, once, through the real escrow settle (payouts from the holds); a decided item is superseded, not settled
//   * disputes: only people in it (the site checks its own items; Pepe vouches for his), enough of them -> disputed, never settled
//   * Pepe-owned items (LMSR markets before Phase 3): the proposal turns "due" on the feed; Pepe settles and acks
//   * a resolver registered later (Phase 3's markets) takes over the "market" kind with no other change
//   NODE_PATH=G:/PATV/node_modules node --test test/oracle.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.DB_BACKUP_DIR = path.join(tmp, "backups");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const P = require(path.join(repo, "pools"));
const L = require(path.join(repo, "escrow", "ledger"));
const G = require(path.join(repo, "escrow", "games"));
const O = require(path.join(repo, "oracle"));

const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const bal = async (id) => Number((await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b);
const actor = (login, username, extra = {}) => Object.assign({ login, username, admin: false, room: "Lab", via: "room" }, extra);
const PEPE = actor("PepeBot", "pepebot", { pepe: true });
let n = 0;
const act = (verb, a, args) => G.act("pools", { verb, actor: a, args, idem: `idem-o-${++n}` });
const age = (key) => runQuery("UPDATE oracle_proposals SET until = ? WHERE key = ?", [Date.now() - 1, key]);

let ref;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, created DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE supply_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), pools TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("INSERT INTO supply_snapshot (id, pools) VALUES (1, '[]')");
  for (const [id, name, b, cf] of [["u1", "ann", 100000, "ann_cf"], ["u2", "bob", 100000, "bob_cf"], ["u3", "carol", 100000, "carol_cf"]]) {
    await runQuery("INSERT INTO users (userId, username, password, points_balance, camfrogUsername) VALUES (?, ?, 'x', ?, ?)", [id, name, b, cf]);
  }
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES ('seed', 's', NULL, 1000000)");
  await require(path.join(repo, "funding")).init();
  await P.init();
  const app = express();
  app.use(express.json());
  const deps = { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() };
  P.register(app, deps);
  L.register(app, deps);
  G.register(app, deps);
  await P._setMeta("live", true);
  P._forgetLive();
  await P.move({ key: "seed-pools", legs: [["reserve", 100000], ["mm", 10]], flow: "test", kind: "admin" });
  await L.setMeta("enabled", true);
  const payload = JSON.stringify({ v: 1, source: "pepe", holds: [], seq: 1, supply: [] });
  assert.equal((await L.importFromPepe({ key: "ec-o-0001", payload, digest: sha(payload), totals: { sum: 0, count: 0, per_kind: {} } })).ok, true);
  await L.setMeta("enabled:pools", true);
  const empty = JSON.stringify({ v: 1, source: "pepe", pools: [], seq: 1 });
  assert.equal((await G.importGame({ game: "pools", key: "gc-o-1", payload: empty, digest: sha(empty), totals: { sum: 0, count: 0 } })).ok, true);
  const c = await act("create", actor("ann_cf", "ann"), { question: "Will the oracle work?", ai_judge: true, pepe: "PepeBot", secs: 3600 });
  assert.equal(c.ok, true, JSON.stringify(c));
  ref = c.ref;
  assert.equal((await act("bet", actor("ann_cf", "ann"), { ref, option: "yes", amount: 2000 })).ok, true);
  assert.equal((await act("bet", actor("bob_cf", "bob"), { ref, option: "no", amount: 3000 })).ok, true);
});

const PROP = (key, extra = {}) => Object.assign({ key, kind: "pool", ref: undefined, outcome: "yes", raw: "yes", result: "yes", confidence: 0.9,
  reason: "the logs say so", evidence: { web: "x", camfrog: "y" }, window_s: 3600, need_disputes: 2, pepe_login: "PepeBot" }, extra);

test("propose: off by default on prod; keyed; supersedes the open one", async () => {
  await assert.rejects(O.propose(PROP("aj:pool:1:1", { ref })), (e) => e.code === "E_FEATURE_OFF");
  await O.setMeta("enabled", true);
  const r = await O.propose(PROP("aj:pool:1:1", { ref }));
  assert.equal(r.state, "proposed");
  assert.equal(r.owner, "site", "the pool lives on the site's escrow engine");
  const again = await O.propose(PROP("aj:pool:1:1", { ref }));
  assert.equal(again.already, true);
  const r2 = await O.propose(PROP("aj:pool:1:2", { ref, outcome: "no", result: "no" }));
  assert.equal(r2.state, "proposed");
  assert.equal((await getQuery("SELECT state FROM oracle_proposals WHERE key = 'aj:pool:1:1'"))[0].state, "superseded");
  await assert.rejects(O.propose(PROP("aj:pool:1:3", { ref: "M999999999x" })), /bad ref/);
});

test("disputes: only people in it; one isn't enough on a pool; two -> disputed and never settled by the window", async () => {
  let d = await O.dispute({ kind: "pool", ref, login: "carol_cf", why: "?" });
  assert.equal(d.code, "not_in_it");
  d = await O.dispute({ kind: "pool", ref, login: "ann_cf", why: "wrong" });
  assert.deepEqual([d.ok, d.state, d.n, d.need], [true, "proposed", 1, 2]);
  assert.equal((await O.dispute({ kind: "pool", ref, login: "ANN_CF" })).code, "already");
  d = await O.dispute({ kind: "pool", ref, login: "bob_cf", why: "no" });
  assert.equal(d.state, "disputed");
  await age("aj:pool:1:2");
  await O.tick();
  assert.equal((await O.get("pool", ref)).state, "disputed", "a disputed call waits for an admin");
  const f = await O.feed(0);
  assert.deepEqual(f.events.map((e) => e.event), ["proposed", "superseded", "proposed", "disputed"]);
});

test("the window ends undisputed: the SITE settles the pool as Pepe's judge, once, through the escrow engine", async () => {
  const r = await O.propose(PROP("aj:pool:1:4", { ref, outcome: "yes" }));
  assert.equal(r.state, "proposed");
  const a0 = await bal("u1");
  assert.deepEqual(await O.tick(), [], "not before the window ends");
  await age("aj:pool:1:4");
  assert.deepEqual(await O.tick(), ["aj:pool:1:4"]);
  const p = await O.get("pool", ref);
  assert.equal(p.state, "settled");
  assert.equal(p.settle_result.ok, true);
  const rec = await G.load("pools", Number(ref.slice(1)));
  assert.equal(rec.status, "settled");
  assert.equal(rec.result, "yes");
  assert.equal(rec.settled_by, "PepeBot");
  assert.ok((await bal("u1")) > a0, "the winner was paid from the holds");
  assert.deepEqual(await O.tick(), [], "never twice");
  // a decided item: a later proposal on it can't be made
  await assert.rejects(O.propose(PROP("aj:pool:1:5", { ref })), (e) => e.code === "E_NOT_DECIDABLE");
});

test("Pepe-owned (an LMSR market before Phase 3): due on the feed, Pepe settles and acks", async () => {
  const r = await O.propose(PROP("aj:market:7:1", { kind: "market", ref: "M7", outcome: "no", result: "no" }));
  assert.equal(r.owner, "pepe");
  assert.equal((await O.dispute({ kind: "market", ref: "M7", login: "anyone", checked: true })).n, 1, "Pepe vouches for his own items' people");
  await age("aj:market:7:1");
  await O.tick();
  const f = await O.feed(0);
  const due = f.events.filter((e) => e.event === "due");
  assert.equal(due.length, 1);
  assert.deepEqual([due[0].key, due[0].data.outcome], ["aj:market:7:1", "no"]);
  assert.equal((await O.settled({ key: "aj:market:7:1", ok: true })).state, "settled");
  assert.equal((await O.settled({ key: "aj:market:7:1", ok: true })).already, true);
});

test("a resolver registered later (Phase 3) owns the market kind: the site settles through it", async () => {
  const calls = [];
  O.registerResolver("market", { owner: async () => "site", decidable: async () => true,
                                  settle: async (r, outcome, key) => { calls.push([r, outcome, key]); return { ok: true }; } });
  await O.propose(PROP("aj:market:8:1", { kind: "market", ref: "M8", outcome: "void Pepe's ruling: unanswerable" }));
  await age("aj:market:8:1");
  await O.tick();
  assert.deepEqual(calls, [["M8", "void Pepe's ruling: unanswerable", "aj:market:8:1"]]);
  assert.equal((await O.get("market", "M8")).state, "settled");
});
