// 1.99ne: website actions queued for Pepe expire (actionttl.js).
//   * a pending row past its kind's TTL is marked (failed + E_TIMEOUT + expired_at), its user gets a notice
//   * rows inside their TTL, claimed rows and internal kinds aren't touched / noticed
//   * the three claim endpoints sweep first, never hand out an expired row, and send expires_at
//   * TTLs are configurable (action_ttl_config overrides), market orders + bounty actions too, aigen job tidied
//   NODE_PATH=G:/PATV/node_modules node --test test/actionttl.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "actionttl-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
delete process.env.STAGING;
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));

const MIN = 60000;
let base, server, TTL;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const act = async (kind, args, ageMin, status = "pending", extra = {}) => {
  const t = Date.now() - ageMin * MIN;
  const r = await runQuery(`INSERT INTO pepe_actions (user_id, username, camfrog, kind, args, tag, label, status, created, updated, claimed)
                            VALUES ('u1', 'ann', 'ann_cf', ?, ?, ?, ?, ?, ?, ?, ?)`,
                           [kind, JSON.stringify(args), extra.tag || "markets", extra.label || `!${args.join(" ")}`, status, t, t,
                            status === "claimed" ? (extra.claimed || t) : null]);
  return r.id;
};
const row = async (id) => (await getQuery("SELECT * FROM pepe_actions WHERE id = ?", [id]))[0];
const notices = () => getQuery("SELECT kind, title, body, link, ref FROM inbox WHERE user_id = 'u1' ORDER BY id");

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  await runQuery("INSERT INTO users (userId, username, password, camfrogUsername) VALUES ('u1', 'ann', 'x', 'ann_cf')");
  await runQuery(`CREATE TABLE feed_aigen_jobs (id TEXT PRIMARY KEY, status TEXT, finished INTEGER, message TEXT)`);
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  const deps = { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() };
  require(path.join(repo, "actions")).register(app, deps);
  require(path.join(repo, "markets")).register(app, deps);
  require(path.join(repo, "bounties")).register(app, deps);
  TTL = require(path.join(repo, "actionttl"));
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await post("/api/actions/claim", { password: "bot" });          // tables made, nothing pending yet
  await post("/api/markets/orders/claim", { password: "bot" });
  await post("/api/bounties/actions/claim", { password: "bot" });
  await TTL.init();
});
test.after(() => server && server.close());

test("TTLs per kind: market bets 15 min, wagers 30, seat moves 2, unknown kinds the default 60", () => {
  assert.equal(TTL.ttlMs("pepe_actions", { kind: "cmd", args: '["market","buy"]' }), 15 * MIN);
  assert.equal(TTL.ttlMs("pepe_actions", { kind: "cmd", args: ["wager", "@bob"] }), 30 * MIN);
  assert.equal(TTL.ttlMs("pepe_actions", { kind: "table" }), 2 * MIN);
  assert.equal(TTL.ttlMs("pepe_actions", { kind: "something.new" }), 60 * MIN);
  assert.equal(TTL.ttlMs("market_orders", { kind: "resolve" }), 240 * MIN);
  assert.equal(TTL.ttlMs("bounty_actions", { kind: "add" }), 60 * MIN);
  assert.equal(TTL.expiresAt("pepe_actions", { kind: "dj", created: 1000 }), 1000 + 10 * MIN);
});

test("an overdue pending action expires: marked, nothing run, its user is told; fresh / claimed / internal ones aren't", async () => {
  const old = await act("cmd", ["market", "buy", "m3", "yes", "5000"], 20);
  const fresh = await act("cmd", ["wager", "@bob", "10k", "x"], 20);              // 30-min TTL: still fine
  const claimed = await act("cmd", ["market", "buy", "m3", "no", "100"], 90, "claimed", { claimed: Date.now() - 1000 });
  const notify = await act("notify", ["ann_cf", "your order shipped", "shop"], 2000);
  const out = await TTL.sweepTable("pepe_actions");
  assert.deepEqual(out.map((r) => r.id).sort(), [old, notify].sort());
  const r = await row(old);
  assert.equal(r.status, "failed");
  assert.equal(r.code, "E_TIMEOUT");
  assert.ok(r.expired_at > 0);
  assert.match(r.message, /within 15 minutes.*nothing was done and no PAT was taken/);
  assert.equal((await row(fresh)).status, "pending");
  assert.equal((await row(claimed)).status, "claimed", "a claimed row may be running in Pepe - never expired here");
  assert.equal((await row(notify)).status, "failed");
  const n = await notices();
  assert.equal(n.length, 1, "the internal notify copy expires silently");
  assert.equal(n[0].kind, "market");
  assert.equal(n[0].link, "/markets");
  assert.equal(n[0].ref, `actexp:pepe_actions:${old}`);
  assert.equal((await TTL.sweepTable("pepe_actions")).length, 0, "a second sweep changes nothing (and notifies nobody twice)");
});

test("the claim sweeps first: an overdue row is never handed out; the rest carry expires_at", async () => {
  const late = await act("cmd", ["lotto", "quick"], 16);
  const ok = await act("cmd", ["loan", "offer"], 1);
  const c = await post("/api/actions/claim", { password: "bot" });
  const ids = c.body.actions.map((a) => a.id);
  assert.ok(!ids.includes(late));
  assert.ok(ids.includes(ok));
  const a = c.body.actions.find((x) => x.id === ok);
  assert.equal(a.expires_at, a.created + 60 * MIN);
  assert.equal((await row(late)).status, "failed");
});

test("TTLs are configurable (override, then back to the default)", async () => {
  const id = await act("cmd", ["wager", "@bob", "1k", "y"], 12);
  await TTL.set("cmd:wager", 10, "boss");
  assert.equal(TTL.ttlMs("pepe_actions", { kind: "cmd", args: ["wager"] }), 10 * MIN);
  await TTL.sweepTable("pepe_actions");
  assert.equal((await row(id)).status, "failed");
  await assert.rejects(TTL.set("cmd:wager", 0), /minutes/);
  await TTL.set("cmd:wager", null);
  assert.equal(TTL.ttlMs("pepe_actions", { kind: "cmd", args: ["wager"] }), 30 * MIN);
  assert.deepEqual(TTL.view().overrides, {});
});

test("market orders and bounty actions expire too (and aren't claimed late)", async () => {
  const t = Date.now() - 20 * MIN;
  const mo = (await runQuery(`INSERT INTO market_orders (market_id, user_id, username, option, amount, kind, status, created, updated)
                              VALUES (7, 'u1', 'ann', 'yes', 5000, 'buy', 'pending', ?, ?)`, [t, t])).id;
  const mr = (await runQuery(`INSERT INTO market_orders (market_id, user_id, username, option, amount, kind, status, created, updated)
                              VALUES (7, 'u1', 'ann', '', 0, 'resolve', 'pending', ?, ?)`, [t, t])).id;
  const bt = Date.now() - 3 * 3600e3;
  const ba = (await runQuery(`INSERT INTO bounty_actions (bounty_id, user_id, username, kind, amount, status, created, updated)
                              VALUES (4, 'u1', 'ann', 'add', 1000, 'pending', ?, ?)`, [bt, bt])).id;
  const c = await post("/api/markets/orders/claim", { password: "bot" });
  assert.deepEqual(c.body.orders.map((o) => o.id), [mr], "the 15-min bet expired; the 4-hour resolve is still claimable");
  assert.equal(c.body.orders[0].expires_at, t + 240 * MIN);
  const o = (await getQuery("SELECT status, expired_at, message FROM market_orders WHERE id = ?", [mo]))[0];
  assert.equal(o.status, "failed");
  assert.ok(o.expired_at > 0);
  const b = await post("/api/bounties/actions/claim", { password: "bot" });
  assert.deepEqual(b.body.actions, []);
  assert.equal((await getQuery("SELECT status FROM bounty_actions WHERE id = ?", [ba]))[0].status, "failed");
  const n = (await notices()).map((x) => [x.kind, x.link]);
  assert.ok(n.some(([k, l]) => k === "market" && l === "/markets/7"));
  assert.ok(n.some(([k, l]) => k === "bounty" && l === "/bounties/4"));
});

test("an expired aigen action takes its queued generation with it (nothing was charged)", async () => {
  await runQuery("INSERT INTO feed_aigen_jobs (id, status) VALUES ('gabc', 'queued')");
  await act("aigen", ["gabc"], 16, "pending", { tag: "aigen" });
  await TTL.sweepTable("pepe_actions");
  const j = (await getQuery("SELECT status, message FROM feed_aigen_jobs WHERE id = 'gabc'"))[0];
  assert.equal(j.status, "timeout");
  assert.match(j.message, /nothing was charged/);
});
