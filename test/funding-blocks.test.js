// PO-2 (economy policy -> site plan, T15): the funding sync's `monetary` block and the policy config store.
//   * mirror mode (Pepe owns the config): his block is used as he sends it; the store compares it (the dual read, consumer
//     funding.monetary) and mirrors its config fields as their lowest-priority source
//   * once the SITE owns the config (H1): the block's CONFIG fields (the flash switches, the House hard floor, the donation terms,
//     the staff-grant cap, the band's floor / ceiling) are the site's and Pepe's are ignored (logged); its derived fields (the Fed
//     loan room, the budget week, the Fed's balance - PO-4) stay his; the site's layers flag off = no block; an edit on the site
//     reaches the block at once; the House flash cover and the donation terms follow the site's values
//   NODE_PATH=G:/PATV/node_modules node --test test/funding-blocks.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "funding-blocks-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery, tx } = require(path.join(repo, "dbUtils"));
const PC = require(path.join(repo, "policy", "config"));
const C = require(path.join(repo, "policy", "core"));
const FUND = require(path.join(repo, "funding"));
const FX = require("./fixtures/policycfg");
require(path.join(repo, "opsalerts")).alert = async () => ({ admins: 0 });

const M = FX.M;
const T0 = Date.UTC(2026, 9, 20, 15, 0);
PC._setClock(() => T0);
C._setClock(() => T0);
let base, server;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot" }, body)) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const logs = [];
const origLog = console.log;

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT, class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0,
                  camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await FUND.init();
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const deps = { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() };
  require(path.join(repo, "econstore")).register(app, deps);
  require(path.join(repo, "policy", "scheduler")).register(app, deps);
  PC.register(app, deps);
  require(path.join(repo, "capital", "service")).register(app, deps);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await post("/api/policy/bot/config", { cfg: FX.policyPush({ days_done: ["D2026-10-20"], mo_days_done: ["D2026-10-20"] }) })).body.ok, true);
  assert.equal((await post("/api/capital/bot/config", { cfg: FX.capitalPush() })).body.ok, true);
  assert.equal((await post("/api/econ/settings/put", { pat_routes: FX.routes(), catalog: FX.catalog() })).body.ok, true);
  await PC.refresh();
  console.log = (...a) => { logs.push(a.join(" ")); origLog(...a); };
});
test.after(() => { console.log = origLog; if (server) server.close(); });

test("mirror mode: Pepe's monetary block is used as sent; a difference from the store is logged (funding.monetary)", async () => {
  PC._resetMemory();
  await PC.refresh();
  const m = FX.monetary({ house_hard_floor: 4 * M, donation: { rate: 600000, bonus_pct: 20 } });
  FUND.sync({ monetary: m });
  assert.deepEqual(FUND.state.monetary, FUND.cleanMonetary(m), "his block, untouched");
  assert.deepEqual(FUND.donationTerms(), { rate: 600000, bonus_pct: 20 });
  await PC.flushDual();
  const rows = await getQuery("SELECT key, push, site FROM policy_cfg_dualread WHERE consumer = 'funding.monetary' ORDER BY key");
  assert.deepEqual(rows, [{ key: "donation.rate", push: "600000", site: "500000" }, { key: "house_hard_floor", push: String(4 * M), site: String(5 * M) }]);
  // in step: a check, no difference
  FUND.sync({ monetary: FX.monetary() });
  await PC.flushDual();
  const c = (await getQuery("SELECT checks, diffs FROM policy_cfg_dualcheck WHERE consumer = 'funding.monetary'"))[0];
  assert.deepEqual([c.checks, c.diffs], [2, 2]);
  // his layers off (no block) while the store's layers are on: a difference too
  FUND.sync({});
  assert.equal(FUND.state.monetary, null);
  await PC.flushDual();
  assert.ok((await getQuery("SELECT 1 FROM policy_cfg_dualread WHERE consumer = 'funding.monetary' AND key = 'monetary'")).length);
});

test("site-owned: the block's config fields are the site's, Pepe's are ignored (logged); his derived fields stay", async () => {
  await tx(async () => { await PC.putOwner("cfg", "site", { by: "test", handoverKey: "k".repeat(64) }); });
  await PC.refresh();
  logs.length = 0;
  const pepe = { flash: { house: false, bank: false, mm: true }, fedloan_room: 7 * M, house_hard_floor: 1 * M, donation: { rate: 1, bonus_pct: 99 },
                 grant_weekly_cap: 5, week_start: 1761523200, band: { fed: 61 * M, floor: 1, ceiling: 2 } };
  FUND.sync({ monetary: pepe, flows: { wheel_shortfall: "jackpot" } });          // the House backs the casino (v2)
  const m = FUND.state.monetary;
  assert.deepEqual(m.flash, { house: true, bank: true, mm: true });
  assert.equal(m.house_hard_floor, 5 * M);
  assert.deepEqual(m.donation, { rate: 500000, bonus_pct: 20 });
  assert.equal(m.grant_weekly_cap, -1);
  assert.deepEqual(m.band, { fed: 61 * M, floor: 25 * M, ceiling: 150 * M });
  assert.equal(m.fedloan_room, 7 * M, "derived: the Fed loan room stays Pepe's (PO-4)");
  assert.equal(m.week_start, 1761523200, "derived: the budget week stays Pepe's");
  assert.ok(logs.some((l) => /\[funding\] ignored pepe .*flash\.house false.*house_hard_floor 1000000/.test(l)), logs.join("\n"));
  // the money paths read the site's values: the donation terms, the House flash cover's floor
  assert.deepEqual(FUND.donationTerms(), { rate: 500000, bonus_pct: 20 });
  const plan = await FUND.houseFlashPlan(1 * M, 5.5 * M);
  assert.equal(plan.need, true, "the House would go below the site's 5M floor (Pepe said 1M)");
  // no block from Pepe while the site's layers are on: built from the site's config, derived fields at their neutral values
  FUND.sync({});
  assert.deepEqual(FUND.state.monetary.flash, { house: true, bank: true, mm: true });
  assert.equal(FUND.state.monetary.fedloan_room, 0);
  assert.equal(FUND.state.monetary.house_hard_floor, 5 * M);
});

test("site-owned: an edit reaches the block at once; the site's layers off means no block, whatever Pepe sends", async () => {
  FUND.sync({ monetary: FX.monetary() });
  let snap = await PC.snapshot({ fresh: true });
  const r = await PC.edit({ changes: { donation_rate: "750k", flash_house: "off" }, via: "chat", actor: "owner_cf", baseRev: snap.rev });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(FUND.state.monetary.donation.rate, 750000, "no Pepe sync needed");
  assert.equal(FUND.state.monetary.flash.house, false);
  assert.deepEqual(FUND.donationTerms(), { rate: 750000, bonus_pct: 20 });
  snap = await PC.snapshot({ fresh: true });
  await PC.edit({ changes: { layers: "off" }, via: "chat", actor: "owner_cf", baseRev: snap.rev });
  assert.equal(FUND.state.monetary, null);
  FUND.sync({ monetary: FX.monetary() });
  assert.equal(FUND.state.monetary, null, "Pepe's block is ignored while the site's layers are off");
  // the persisted state holds the site's view (a restart restores it)
  await FUND._persisted();
  const saved = JSON.parse((await getQuery("SELECT value FROM funding_state WHERE key = 'last_sync'"))[0].value);
  assert.equal(saved.monetary, null);
});
