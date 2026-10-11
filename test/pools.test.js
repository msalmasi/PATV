// 1.99ns Phase 1: every protocol pool on the site (pools.js), the economy settings / journals (econstore.js), polls backend.
//   * import: off unless enabled, digest + totals + Pepe's supply rows checked, verified backup first, idempotent by key,
//     the supply total must not move by one PAT (in the same transaction), refused over PAT already held
//   * moves: keyed multi-leg all-or-nothing, a refused debit is not recorded (a retry may succeed), the burn reserve only burns
//   * /api/pat/charge: wallet debit + pool legs + House leg + turf_inbox rows in ONE transaction, replayed by key
//   * /api/pat/fund: pool -> wallet in one transaction; the site settles plain Reserve / Fort Knox claims itself
//   * rollback: every pool -> 0 under one key, live off, re-import with a new key allowed; supply rows from the table
//   * econstore: docs (rev-checked), fed_journal / incentive_groups derived, settings diff + logs; polls backend
//   NODE_PATH=G:/PATV/node_modules node --test test/pools.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pools-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const P = require(path.join(repo, "pools"));
const E = require(path.join(repo, "econstore"));
const POLLS = require(path.join(repo, "polls"));

const bal = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;
const house = async () => (await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM jackpot_rakes"))[0].t;
async function supply() {
  const w = (await getQuery("SELECT COALESCE(SUM(points_balance),0) AS w FROM users"))[0].w;
  const j = await house();
  const snap = (await getQuery("SELECT pools FROM supply_snapshot WHERE id = 1"))[0];
  let rows = snap ? JSON.parse(snap.pools) : [];
  rows = await P.supplyRows(rows);
  return { total: w + j + rows.reduce((t, r) => t + r.amount, 0), rows };
}
const POOLS = { reserve: 100126055, stakers: 0, bank: 2229369, mm: 940975, vaultfloat: 0, heist: 3484250, bingo: 1, fortknox: 15210809,
                incentives: 1244, burn: 0, "room:You_Were_Never_Here": 324875, "room:DRAMA_CENTRAL": 147892, "room:PepeFrog.Room": 165125 };
const SUPPLY = [
  ...Object.entries(POOLS).filter(([k, v]) => v && !k.startsWith("room:")).map(([k, v]) => ({ key: "vault:" + k, label: k, amount: v })),
  ...Object.entries(POOLS).filter(([k, v]) => v && k.startsWith("room:")).map(([k, v]) => ({ key: k, label: k, amount: v })),
  { key: "turf:stakes", label: "turf", amount: 777 }, { key: "gangs", label: "gangs", amount: 1000 },
];
function pack(pools, extra = {}, key = "cut-0001") {
  const payload = JSON.stringify({ v: 1, source: "pepe", pools, supply: extra.supply === undefined ? SUPPLY : extra.supply,
                                   docs: { econ_layers: { fed_mints: { "fedseed-1": { amount: 5, policy: "seed", dest: "reserve", state: "done", ts: 1 } }, fed_loans: {} },
                                           econ_treasury: { week: { id: "W1", budgets: { welcome: 100, misc: 50 }, spent: { welcome: 30 } } },
                                           vault_marks: { "launch-bank:out": 1 } },
                                   routes: { ask: [["reserve", 90], ["room_owner", 10]] }, econ_cfg: { fed_floor: 50000000 },
                                   econ_cfg_log: [{ ts: 1791000000, by: "foamy", via: "chat", key: "fed_floor", old: 25000000, new: 50000000 }],
                                   catalog: { flows: { ask: { label: "!ask" } } } });
  const keys = Object.keys(pools);
  return { key, payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"),
           totals: { sum: keys.reduce((t, k) => t + pools[k], 0), count: keys.length, per_pool: pools, ...(extra.totals || {}) } };
}

let base, server;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot" }, body)) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, created DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE supply_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), pools TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  for (const [id, name, b, cf, cls] of [["u1", "ann", 10000, "ann_cf", "pleb"], ["u2", "bob", 0, "bob_cf", "pleb"], ["u3", "adm", 0, "boss", "Admin"]]) {
    await runQuery("INSERT INTO users (userId, username, password, points_balance, camfrogUsername, class) VALUES (?, ?, 'x', ?, ?, ?)", [id, name, b, cf, cls]);
  }
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES ('seed', 's', NULL, 5000000)");
  await require(path.join(repo, "funding")).init();
  P._setSupplyFn(supply);
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const deps = { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() };
  P.register(app, deps);
  E.register(app, deps);
  POLLS.register(app, deps);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());

test("off by default on prod: no import, no moves", async () => {
  assert.equal(await P.enabled(), false);
  const r = await post("/api/pools/admin/import", pack(POOLS));
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "E_FEATURE_OFF");
  const m = await post("/api/pools/move", { key: "mv-000001", legs: [["reserve", 5]] });
  assert.equal(m.body.code, "E_NOT_LIVE");
});

test("import: digest, totals and Pepe's supply rows are checked; a mismatch keeps nothing", async () => {
  await P._setMeta("enabled", true);
  const bad = pack(POOLS);
  bad.digest = "0".repeat(64);
  assert.equal((await post("/api/pools/admin/import", bad)).body.code, "E_DIGEST");
  const wrong = pack(POOLS, { totals: { sum: 1 } });
  assert.equal((await post("/api/pools/admin/import", wrong)).body.code, "E_TOTALS");
  const sup = pack(POOLS, { supply: SUPPLY.map((r) => (r.key === "vault:bank" ? { ...r, amount: r.amount + 1 } : r)) });
  assert.equal((await post("/api/pools/admin/import", sup)).body.code, "E_SUPPLY");
  assert.equal(await P.live(), false);
  assert.deepEqual(await P.balances(), {});
});

test("import: every pool lands, the supply total doesn't move, idempotent by key, a second import refused", async () => {
  await runQuery("INSERT INTO supply_snapshot (id, pools) VALUES (1, ?)", [JSON.stringify(SUPPLY)]);
  const before = (await supply()).total;
  const r = await post("/api/pools/admin/import", pack(POOLS));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  const sum = Object.values(POOLS).reduce((t, v) => t + v, 0);
  assert.equal(r.body.total, sum);
  assert.equal(r.body.supply_before, r.body.supply_after);
  assert.equal(r.body.supply_before, before);
  const b = await P.balances();
  for (const [k, v] of Object.entries(POOLS)) assert.equal(b[k], v, k);
  assert.equal(await P.live(), true);
  assert.equal((await supply()).total, before);
  // the same export again: "already"; a different key: refused
  assert.equal((await post("/api/pools/admin/import", pack(POOLS))).body.already, true);
  assert.equal((await post("/api/pools/admin/import", pack(POOLS, {}, "cut-0002"))).body.code, "E_ALREADY");
  // the docs, journals and settings came along
  const x = await E.exportAll();
  assert.equal(x.docs.vault_marks.doc["launch-bank:out"], 1);
  assert.equal(x.fed_journal.length, 1);
  assert.equal(x.fed_journal[0].id, "mint:fedseed-1");
  assert.deepEqual(x.pat_routes.ask, [["reserve", 90], ["room_owner", 10]]);
  assert.equal(x.econ_cfg.fed_floor, 50000000);
  assert.equal(x.incentive_groups.find((g) => g.grp === "welcome").remaining, 70);
  assert.equal(x.econ_cfg_log.length, 1);
});

test("moves: keyed multi-leg, all or nothing; a refused debit is not recorded; the burn reserve only burns", async () => {
  const r = await post("/api/pools/move", { key: "fedgrant-k1:out", legs: [["reserve", -1000], ["incentives", 1000]], flow: "fed grant", why: "test" });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.balances.incentives, 2244);
  const again = await post("/api/pools/move", { key: "fedgrant-k1:out", legs: [["reserve", -1000], ["incentives", 1000]] });
  assert.equal(again.body.dup, true);
  assert.equal(await P.balance("incentives"), 2244);
  const short = await post("/api/pools/move", { key: "over-0001", legs: [["incentives", 1], ["bingo", -5]] });
  assert.equal(short.status, 409);
  assert.equal(short.body.code, "E_INSUFFICIENT");
  assert.equal(await P.balance("incentives"), 2244, "the credit leg rolled back too");
  assert.equal(await P.moveStatus("over-0001"), null);
  assert.equal((await post("/api/pools/move", { key: "over-0001", legs: [["bingo", 1]] })).body.ok, true, "the same key may land later");
  await post("/api/pools/move", { key: "burnfill-1", legs: [["burn", 500]] });
  assert.equal((await post("/api/pools/move", { key: "burnout-1", legs: [["burn", -10]] })).body.code, "E_BURN_ONLY");
  assert.equal((await post("/api/pools/move", { key: "burn:b1", kind: "burn", legs: [["burn", -10]] })).body.ok, true);
  assert.equal((await post("/api/pools/move", { key: "badleg-1", legs: [["jackpot", 5]] })).status, 400);
});

test("/api/pat/charge: wallet debit + pool legs + House + turf inbox in one transaction, replayed by key", async () => {
  const h0 = await house(), r0 = await P.balance("reserve"), s0 = (await supply()).total;
  const body = { key: "rt-abc123", username: "ann", amount: 1000, reason: "command-ask", route: { flow: "ask", room: "R1", payer: "ann_cf" },
                 legs: [["reserve", 700], ["jackpot", 100], ["turf:nightclub", 150], ["room:R1", 50]] };
  const r = await post("/api/pat/charge", body);
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.deepEqual(r.body.site_legs, [0, 1, 3]);
  assert.equal(r.body.inbox.length, 1);
  assert.equal(r.body.inbox[0].key, "rt-rt-abc123-2");
  assert.equal(await bal("u1"), 9000);
  assert.equal(await house(), h0 + 100);
  assert.equal(await P.balance("reserve"), r0 + 700);
  assert.equal(await P.balance("room:R1"), 50);
  assert.equal((await supply()).total, s0, "PAT moved, none made or lost (the turf leg is the turf_inbox row)");
  const again = await post("/api/pat/charge", body);
  assert.equal(again.body.replayed, true);
  assert.equal(await bal("u1"), 9000);
  // the leg sum must be the amount; a short wallet moves nothing
  assert.equal((await post("/api/pat/charge", { ...body, key: "rt-sum0001", legs: [["reserve", 10]] })).status, 400);
  const poor = await post("/api/pat/charge", { ...body, key: "rt-poor001", username: "bob" });
  assert.equal(poor.status, 402);
  assert.equal(await P.moveStatus("charge:rt-poor001"), null);
  // the inbox
  assert.equal((await post("/api/pools/turf-inbox/pending", { older_s: 0 })).body.legs.length, 1);
  assert.equal((await post("/api/pools/turf-inbox/ack", { keys: ["rt-rt-abc123-2"] })).body.acked, 1);
  assert.equal((await post("/api/pools/turf-inbox/pending", { older_s: 0 })).body.legs.length, 0);
});

test("/api/pat/fund: pool -> wallet in one transaction; refused when the pool is short", async () => {
  const r0 = await P.balance("incentives");
  const r = await post("/api/pat/fund", { key: "raffle-x1", pool: "incentives", username: "bob", amount: 200, flow: "raffle", type: "raffle-win" });
  assert.equal(r.body.ok, true);
  assert.equal(await bal("u2"), 200);
  assert.equal(await P.balance("incentives"), r0 - 200);
  assert.equal((await post("/api/pat/fund", { key: "raffle-x1", pool: "incentives", username: "bob", amount: 200 })).body.dup, true);
  assert.equal(await bal("u2"), 200);
  assert.equal((await post("/api/pat/fund", { key: "raffle-x2", pool: "bingo", username: "bob", amount: 999 })).body.code, "E_INSUFFICIENT");
  assert.equal(await bal("u2"), 200);
});

test("the site settles plain Reserve / Fort Knox claims itself (keyed claim:<id>, the key Pepe uses too)", async () => {
  const r0 = await P.balance("reserve"), f0 = await P.balance("fortknox");
  await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES ('c1', 'levelup', 'u1', 'levelup', 25000)");
  await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES ('c2', 'fortknox:boost', 'u1', 'boost', -400)");
  await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES ('c3', 'incentives:welcome', 'u1', 'w', 100)");
  await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES ('c4', 'levelup', 'u1', 'levelup', 999999999999)");
  await P.move({ key: "claim:c1", legs: [["reserve", -25000]], kind: "settle" });     // Pepe got there first: a dup, settled once
  const s = await P.settleClaims();
  assert.equal(s.settled, 2);
  assert.equal(await P.balance("reserve"), r0 - 25000);
  assert.equal(await P.balance("fortknox"), f0 + 400);
  const st = await getQuery("SELECT claimId, settled FROM reserve_claims ORDER BY claimId");
  assert.deepEqual(st.map((x) => x.settled), [1, 1, 0, 0]);
  assert.equal(await require(path.join(repo, "funding")).reserveNow(), await P.balance("reserve"));
});

test("supply rows come from the table once live; rollback hands every pool back under one key; a new import may follow", async () => {
  const rows = (await supply()).rows;
  assert.equal(rows.find((r) => r.key === "vault:reserve").amount, await P.balance("reserve"));
  assert.ok(rows.find((r) => r.key === "turf:stakes"), "non-pool rows stay");
  const all = await P.balances();
  const s0 = (await supply()).total;
  const rb = await post("/api/pools/admin/rollback", { key: "rb-00001", actor: "test" });
  assert.equal(rb.body.ok, true, JSON.stringify(rb.body));
  assert.equal(rb.body.sum, Object.values(all).reduce((t, v) => t + v, 0));
  assert.equal(rb.body.pools.reserve, all.reserve);
  assert.equal(await P.live(), false);
  assert.equal((await P.total()).amount, 0);
  assert.equal((await post("/api/pools/admin/rollback", { key: "rb-00001" })).body.dup, true);
  // Pepe credits them back locally and re-pushes his snapshot: the site is back to counting his rows
  await runQuery("UPDATE supply_snapshot SET pools = ? WHERE id = 1", [JSON.stringify(Object.entries(rb.body.pools).map(([k, v]) => ({ key: k.startsWith("room:") ? k : "vault:" + k, label: k, amount: v }))
    .concat([{ key: "turf:stakes", label: "turf", amount: 777 }, { key: "gangs", label: "gangs", amount: 1000 }]))]);
  const s1 = (await supply()).total;
  assert.equal(s1 + (await P.inboxOpen()).amount, s0);
  const again = pack(rb.body.pools, { supply: null }, "cut-0003");
  const r = await post("/api/pools/admin/import", again);
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(await P.balance("reserve"), all.reserve);
});

test("econstore: docs are rev-checked, settings diff into logs", async () => {
  const p1 = await post("/api/econ/docs/put", { docs: { econ_monetary: { doc: { days: { a: 1 } }, rev: 5 } } });
  assert.equal(p1.body.docs.econ_monetary.ok, true);
  const stale = await post("/api/econ/docs/put", { docs: { econ_monetary: { doc: { days: {} }, rev: 4 } }, nope: { doc: 1, rev: 9 } });
  assert.equal(stale.body.docs.econ_monetary.stale, true);
  assert.deepEqual((await post("/api/econ/docs/get", {})).body.docs.econ_monetary.doc, { days: { a: 1 } });
  const s = await post("/api/econ/settings/put", { pat_routes: { ask: [["reserve", 100]] }, econ_cfg: {}, actor: "boss", via: "web" });
  assert.equal(s.body.routes_changed, 1);
  assert.equal(s.body.cfg_changed, 1);
  const g = await post("/api/econ/settings/get", {});
  assert.deepEqual(g.body.pat_routes, { ask: [["reserve", 100]] });
  assert.deepEqual(g.body.econ_cfg, {});
  const log = await getQuery("SELECT flow, old, new FROM pat_routes_log ORDER BY id DESC LIMIT 1");
  assert.equal(log[0].new, JSON.stringify([["reserve", 100]]));
});

test("polls backend: off until attached; chat + web votes on the site; detach hands the poll back", async () => {
  assert.equal((await post("/api/polls/bot/act", { verb: "create", question: "x", options: ["a", "b"] })).body.code, "off");
  await runQuery("CREATE TABLE IF NOT EXISTS pepe_actions (id INTEGER PRIMARY KEY)").catch(() => {});
  await runQuery("INSERT INTO polls_meta (key, value) VALUES ('enabled', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'");
  const local = { id: "poll_local1", question: "Tea?", options: ["yes", "no"], votes: { 0: ["ann_cf"], 1: [] }, creator: "ann_cf", status: "active", created_at: "2026-10-11 10:00:00" };
  const at = await post("/api/polls/bot/act", { verb: "attach", current: local });
  assert.equal(at.body.ok, true);
  assert.equal(at.body.poll.id, "poll_local1");
  const v = await post("/api/polls/bot/act", { verb: "vote", voter: "bob_cf", option: 2 });
  assert.equal(v.body.ok, true);
  assert.equal(await POLLS.fromForm("u2", "poll.vote", ["poll_local1", "1"]), "🗳️ voted: yes");
  const cur = (await post("/api/polls/bot/act", { verb: "current" })).body.poll;
  assert.deepEqual(cur.rows.map((r) => r.count), [2, 0], "bob's web vote replaced his chat vote");
  const ev = await post("/api/polls/bot/poll", { after: at.body.cursor });
  assert.deepEqual(ev.body.events.map((e) => e.kind + ":" + e.origin), ["voted:camfrog", "voted:web"]);
  assert.equal(await POLLS.fromForm("u2", "poll.end", []), "only the poll's creator or an admin can end it");
  assert.equal(await POLLS.fromForm("u3", "poll.end", []), "🗳️ Poll ended.");
  const sync = await post("/api/polls/sync", { polls: [] });
  assert.equal(sync.status, 409, "a local snapshot can't overwrite site-owned polls");
  const d = await post("/api/polls/bot/act", { verb: "detach" });
  assert.equal(d.body.ok, true);
  assert.equal(await POLLS.fromForm("u2", "poll.vote", ["x", "1"]), null, "detached: forms go back to Pepe");
});
