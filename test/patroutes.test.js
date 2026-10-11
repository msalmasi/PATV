// 1.99ne: a paid command's charge and its routing are one entry group (patroutes.js).
//   * the wallet debit and the route intent commit together, under the charge's idempotency key
//   * a failure writing the intent rolls the debit back (never a debit with no intent)
//   * insufficient balance writes neither
//   * the intents Pepe hasn't acked come back to him (oldest first, only after the grace period), ack marks them once
//   NODE_PATH=G:/PATV/node_modules node --test test/patroutes.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "patroutes-test-"));
process.chdir(tmp);
delete process.env.STAGING;
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const PR = require(path.join(repo, "patroutes"));

const bal = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;
const txs = async (id) => getQuery("SELECT type, points FROM transactions WHERE userId = ? ORDER BY rowid", [id]);
const ROUTE = { flow: "ask", room: "DRAMA_CENTRAL", payer: "ann_cf" };

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("INSERT INTO users (userId, username, password, points_balance) VALUES ('u1', 'ann', 'x', 10000)");
  const app = express();
  app.use(express.json());
  PR.register(app, { isBotToken: (t) => t === "bot" });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

test("cleanRoute: only a real flow makes a routed charge", () => {
  assert.equal(PR.cleanRoute(null), null);
  assert.equal(PR.cleanRoute({}), null);
  assert.equal(PR.cleanRoute({ flow: "a b" }), null);
  assert.deepEqual(PR.cleanRoute({ flow: "heist_gear", room: "", payer: "x", item_sink: "crate" }),
                   { flow: "heist_gear", room: null, payer: "x", item_sink: "crate" });
  assert.equal(PR.validKey("cmd-1234567890abcdef"), true);
  assert.equal(PR.validKey("short"), false);
});

test("the debit and its route intent commit together under the charge's key", async () => {
  const r = await PR.charge({ key: "cmd-aaaaaaaaaaaa", userId: "u1", username: "ann", amount: 1000, reason: "command-ask", route: ROUTE });
  assert.equal(r.ok, true);
  assert.equal(await bal("u1"), 9000);
  assert.deepEqual(await txs("u1"), [{ type: "command-ask", points: -1000 }]);
  const i = await getQuery("SELECT key, amount, flow, room, payer, txid, routed_at FROM pat_route_intents");
  assert.equal(i.length, 1);
  assert.equal(i[0].key, "cmd-aaaaaaaaaaaa");
  assert.equal(i[0].amount, 1000);
  assert.equal(i[0].flow, "ask");
  assert.equal(i[0].room, "DRAMA_CENTRAL");
  assert.equal(i[0].txid, r.transactionId, "the intent names the debit it belongs to");
  assert.equal(i[0].routed_at, null);
});

test("an intent that can't be written rolls the debit back (no debit without its routing)", async () => {
  const before = await bal("u1");
  await assert.rejects(PR.charge({ key: "cmd-aaaaaaaaaaaa", userId: "u1", username: "ann", amount: 500, reason: "command-ask", route: ROUTE }));
  assert.equal(await bal("u1"), before, "balance untouched");
  assert.equal((await txs("u1")).length, 1, "no second transaction row");
});

test("insufficient balance: neither the debit nor an intent", async () => {
  const r = await PR.charge({ key: "cmd-bbbbbbbbbbbb", userId: "u1", username: "ann", amount: 999999, reason: "command-ask", route: ROUTE });
  assert.equal(r.ok, false);
  assert.equal(r.code, "E_INSUFFICIENT");
  assert.equal((await getQuery("SELECT 1 FROM pat_route_intents WHERE key = 'cmd-bbbbbbbbbbbb'")).length, 0);
});

test("pending hands back un-acked intents after the grace period, oldest first; ack marks once", async () => {
  await PR.charge({ key: "cmd-cccccccccccc", userId: "u1", username: "ann", amount: 300, reason: "command-say", route: { flow: "say" } });
  assert.equal((await post("/api/pat/route-intents/pending", { password: "nope" })).status, 403);
  let p = await post("/api/pat/route-intents/pending", { password: "bot" });
  assert.equal(p.body.intents.length, 0, "fresh intents belong to the live path (default grace 120 s)");
  p = await post("/api/pat/route-intents/pending", { password: "bot", older_s: 0 });
  assert.deepEqual(p.body.intents.map((x) => x.key), ["cmd-aaaaaaaaaaaa", "cmd-cccccccccccc"]);
  assert.equal(p.body.intents[1].flow, "say");
  const a = await post("/api/pat/route-intents/ack", { password: "bot", keys: ["cmd-aaaaaaaaaaaa", "cmd-aaaaaaaaaaaa", "bad key!"] });
  assert.equal(a.body.acked, 1);
  p = await post("/api/pat/route-intents/pending", { password: "bot", older_s: 0 });
  assert.deepEqual(p.body.intents.map((x) => x.key), ["cmd-cccccccccccc"]);
  assert.deepEqual(await PR.unrouted(), { count: 1, amount: 300, oldest: (await getQuery("SELECT created FROM pat_route_intents WHERE key = 'cmd-cccccccccccc'"))[0].created });
});

test("index.js: /api/wager/charge uses the routed charge only with a route AND a valid idempotency key", () => {
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  const i = src.indexOf('app.post("/api/wager/charge"');
  const body = src.slice(i, src.indexOf("app.post(\"/api/wager/payout\"", i));
  assert.match(body, /patroutes\.cleanRoute\(req\.body\.route\)/);
  assert.match(body, /if \(route && patroutes\.validKey\(rkey\)\)/);
  assert.match(body, /route_key: rkey/);
});
