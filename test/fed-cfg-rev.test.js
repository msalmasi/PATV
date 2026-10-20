// PO-2 (economy policy -> site plan, T2): once the SITE owns the economy settings, a Fed op ignores Pepe's per-op econ_cfg and
// must carry cfg_rev (the rev he previewed on) - a missing or stale one is HTTP 409 with the current values, checked inside the
// op's own transaction, nothing moves. While Pepe owns the config nothing changes (his per-op econ_cfg still wins - the dual
// read logs it). The plan's test: an op carrying mintcap_total=-1 while the site's cap is 100M is refused or ignored - never
// obeyed. Repayments (which read no config) need no rev.
//   NODE_PATH=G:/PATV/node_modules node --test test/fed-cfg-rev.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fed-cfgrev-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.DB_BACKUP_DIR = path.join(tmp, "backups");
const express = require("express");
const { runQuery, getQuery, tx } = require(path.join(repo, "dbUtils"));
const P = require(path.join(repo, "pools"));
const ES = require(path.join(repo, "econstore"));
const CC = require(path.join(repo, "capital", "core"));
const C = require(path.join(repo, "policy", "core"));
const PC = require(path.join(repo, "policy", "config"));
const F = require(path.join(repo, "fed", "service"));
const FUND = require(path.join(repo, "funding"));
const FX = require("./fixtures/policycfg");
require(path.join(repo, "opsalerts")).alert = async () => ({ admins: 0 });

const M = 1000000;
const T0 = Date.UTC(2026, 9, 20, 15, 0) / 1000;
F._setClock(() => T0 * 1000);
C._setClock(() => T0 * 1000);
PC._setClock(() => T0 * 1000);
const POOLS = { reserve: 60 * M, bank: 3 * M, mm: 1 * M, fortknox: 5 * M, heist: 1 * M, incentives: 4 * M, vaultfloat: 0 };
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
// Pepe's config: the total mint cap is 100M a month
const PUSH = FX.policyPush({ econ_cfg: { fed_floor: 50 * M, mintcap_total: 100 * M, mintcap_loan: -1, fedloan_cap: 10 * M },
                             days_done: ["D2026-10-20"], mo_days_done: ["D2026-10-20"] });      // today's runs are done (no run window)
const PEPE = { v: 1, fed_mints: { "admin-a1-x": { key: "admin-a1-x", ts: T0 - 2 * 86400, amount: 5 * M, policy: "admin", source: "admin", dest: "reserve",
                                                 reason: "an admin mint this month", actor: "pb", state: "done" } },
               fed_grants: {}, fed_loans: {}, fed_loan_repaid: {}, flash_repaid: {}, fed_loan_seq: 0 };

let base, server;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot" }, body)) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
let opn = 0;
const op = (name, args, extra = {}) => post("/api/fed/bot/op", Object.assign({ op: name, op_key: `t-${name}-${++opn}`, args }, extra));
const mints = async () => Number((await getQuery("SELECT COUNT(*) AS n FROM fed_records WHERE kind = 'mint'"))[0].n);

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT, casino_banned INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE supply_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), pools TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES ('seed', 's', NULL, ?)", [20 * M]);
  await runQuery("INSERT INTO supply_snapshot (id, pools) VALUES (1, '[]')");
  await P.init();
  await FUND.init();
  await P._setMeta("enabled", true);
  const payload = JSON.stringify({ v: 1, source: "pepe", pools: POOLS, docs: {}, routes: {}, econ_cfg: {}, econ_cfg_log: [], catalog: {} });
  assert.equal((await P.importFromPepe({ key: "pc-cfgrev-test", payload, digest: sha(payload),
                                         totals: { sum: Object.values(POOLS).reduce((t, v) => t + v, 0), count: Object.keys(POOLS).length, per_pool: POOLS } })).ok, true);
  await CC.init();
  await CC.putDoc("vaults", { v: { house: { total: 10 * M, holders: { protocol: 10 * M }, basis: 8 * M }, bank: { total: 3 * M, holders: { protocol: 3 * M }, basis: 3 * M },
                                   mm: { total: 1 * M, holders: { protocol: 1 * M }, basis: 1 * M } }, auto: { total: 0, holders: {} }, queue: {}, epochs: [], seq: 0, inited: 1, insured: [] });
  await CC.setMeta("live", true);
  CC.forgetLive();
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const deps = { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() };
  P.register(app, deps);
  ES.register(app, deps);
  require(path.join(repo, "policy", "scheduler")).register(app, deps);
  PC.register(app, deps);
  F.register(app, deps);
  require(path.join(repo, "capital", "service")).register(app, deps);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await post("/api/policy/bot/config", { cfg: PUSH })).body.ok, true);
  assert.equal((await post("/api/capital/bot/config", { cfg: FX.capitalPush() })).body.ok, true);
  assert.equal((await post("/api/econ/settings/put", { pat_routes: FX.routes(), catalog: FX.catalog() })).body.ok, true);
  await F.setMeta("enabled", true);
  const x = JSON.stringify(PEPE);
  assert.equal((await post("/api/fed/admin/import", { key: "fc-cfgrev-1", payload: x, digest: sha(x), totals: F.totalsOf(PEPE), actor: "boss" })).body.ok, true);
  assert.equal(await F.live(), true);
});
test.after(() => server && server.close());

test("while Pepe owns the config: his per-op econ_cfg still wins (unchanged); no rev needed", async () => {
  assert.equal((await PC.ownership()).cfg.owner, "pepe");
  const m0 = await mints();
  // mintcap_total -1 (unlimited) in the op beats the 100M cap he pushed: as before PO-2
  const r = await op("mint", { amount: 120 * M, policy: "admin", reason: "a big admin mint (mirror mode)", key: "admin-big-mirror" }, { econ_cfg: { mintcap_total: -1 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(await mints(), m0 + 1);
});

test("site-owned: an op with no cfg_rev or a stale one is 409 with the current values - nothing moves", async () => {
  await tx(async () => { await PC.putOwner("cfg", "site", { by: "test", handoverKey: "h".repeat(64) }); });
  await PC.refresh();
  const snap = await PC.snapshot({ fresh: true });
  const m0 = await mints(), r0 = await P.balance("reserve");
  let r = await op("mint", { amount: 1 * M, policy: "admin", reason: "admin mint with no rev", key: "admin-norev" }, { econ_cfg: { mintcap_total: -1 } });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, "E_CFG_REV");
  assert.equal(r.body.rev, snap.rev);
  assert.equal(r.body.sha, snap.sha);
  assert.equal(r.body.cfg.mintcap_total, 100 * M, "the current values come back");
  r = await op("mint", { amount: 1 * M, policy: "admin", reason: "admin mint with an old rev", key: "admin-oldrev" }, { cfg_rev: snap.rev - 1 });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /preview again/);
  assert.equal(await mints(), m0);
  assert.equal(await P.balance("reserve"), r0, "nothing moved");
  // a refused op isn't recorded under its key: the same key with the right rev passes the gate (and meets the site's cap -
  // 5M + the 120M mirror-mode mint already passed 100M this month)
  r = await op("mint", { amount: 1 * M, policy: "admin", reason: "admin mint with an old rev", key: "admin-oldrev" }, { cfg_rev: snap.rev });
  assert.equal(r.status, 200);
  assert.equal(r.body.code, "E_CAP", JSON.stringify(r.body));
  assert.equal(await mints(), m0);
});

test("site-owned: an override with mintcap_total=-1 is ignored - the site's 100M cap decides", async () => {
  const snap = await PC.snapshot({ fresh: true });
  const m0 = await mints();
  // this month: 5M (Pepe's) + 120M (the mirror-mode mint) + 1M already over 100M -> any capped mint is refused by the site's cap
  const r = await op("mint", { amount: 2 * M, policy: "admin", reason: "admin mint past the cap", key: "admin-pastcap" },
                     { cfg_rev: snap.rev, econ_cfg: { mintcap_total: -1 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false, JSON.stringify(r.body));
  assert.equal(r.body.cap, true, "the monthly cap refused it");
  assert.equal(await mints(), m0);
  const conf = await F.cfgNow({ mintcap_total: -1 });
  assert.equal(conf.cfg.mintcap_total, 100 * M);
});

test("an edit between Pepe's preview and the op: the op's own transaction sees the new rev - 409, then it goes through on the new rev", async () => {
  const snap = await PC.snapshot({ fresh: true });
  const e = await PC.edit({ changes: { mintcap_total: "unlimited" }, via: "chat", actor: "owner_cf_absent", baseRev: snap.rev }).catch((x) => x);
  // (no owner role is checked here - edit() is the store; the route checks the role) - the store takes it
  assert.equal(e.ok, true, JSON.stringify(e));
  let r = await op("mint", { amount: 2 * M, policy: "admin", reason: "admin mint on the old preview", key: "admin-race" }, { cfg_rev: snap.rev });
  assert.equal(r.status, 409);
  r = await op("mint", { amount: 2 * M, policy: "admin", reason: "admin mint on the old preview", key: "admin-race" }, { cfg_rev: e.rev });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
});

test("repayments read no config: they need no rev", async () => {
  const r = await op("loan_repaid", { key: "W2026-10-19-house", amount: 0 });
  assert.notEqual(r.body.code, "E_CFG_REV");
  assert.equal(r.status, 200);
});
