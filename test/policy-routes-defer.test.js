// Review of the owner answers 2026-10-20 (site-money lens, medium): "missing -> defer + alert, never a default" for every PAT
// Routing reader. Once the site owns the economy settings (H1), econstore.getSettings() throws E_CFG_UNREADABLE /
// E_CFG_MISSING when the store can't be used - and the readers that route PAT by a flow's row (heist market fee, raffle fee,
// auto-account expiry, account deletion, the gang withdrawal cut, the pad fine display, the staking bonus cap) must let it
// through, so the move is refused / deferred (its transaction rolls back) - never routed by the catalog's or the code's default.
// While Pepe owns the settings nothing changes: his table (or the catalog default) as before.
//   NODE_PATH=G:/PATV/node_modules node --test test/policy-routes-defer.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "policy-routes-defer-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery, tx } = require(path.join(repo, "dbUtils"));
const SR = require(path.join(repo, "staffroles"));
const C = require(path.join(repo, "policy", "core"));
const PC = require(path.join(repo, "policy", "config"));
const SCH = require(path.join(repo, "policy", "scheduler"));
const ES = require(path.join(repo, "econstore"));
const FUND = require(path.join(repo, "funding"));
const HM = require(path.join(repo, "heistmarket"));
const RF = require(path.join(repo, "raffles"));
const AE = require(path.join(repo, "autoescrow"));
const AD = require(path.join(repo, "accountdelete"));
const GG = require(path.join(repo, "gangs"));
const PF = require(path.join(repo, "padfines"));
const V = require(path.join(repo, "capital", "vaults"));
const FX = require("./fixtures/policycfg");
const OPS = require(path.join(repo, "opsalerts"));

const alerts = [];
OPS.alert = async (a) => { alerts.push(a); return { admins: 0 }; };
let clockMs = Date.UTC(2026, 9, 20, 15, 0);
PC._setClock(() => clockMs);
C._setClock(() => clockMs);

// the overrides Pepe pushes (mirrored into the store): every reader's flow has one, so "the override" and "a default" differ
const ROUTES = Object.assign({}, FX.routes(), {
  heist_market_fee: [["incentives", 100]], raffle_fee: [["fortknox", 100]], auto_escrow_expired: [["fortknox", 100]],
  account_deleted: [["fortknox", 100]], gang_withdraw_cut: [["stakers", 100]], fine_pad: [["fortknox", 100]],
});

let base, server;
const bot = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot" }, body)) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT, note TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("INSERT INTO users (userId, username, points_balance) VALUES ('gone', 'goner', 5000)");
  await SR.init();
  await FUND.init();
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const deps = { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() };
  ES.register(app, deps);
  SCH.register(app, deps);
  PC.register(app, deps);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await bot("/api/policy/bot/config", { cfg: FX.policyPush() })).body.ok, true);
  assert.equal((await bot("/api/econ/settings/put", { pat_routes: ROUTES, catalog: FX.catalog(), econ_cfg: {}, econ_cfg_log: [] })).body.ok, true);
  await PC.snapshot({ fresh: true });
  await AD.init();
});
test.after(() => server && server.close());

async function owner(o) {
  await tx(async () => { await PC.putOwner("cfg", o, { by: "test", handoverKey: o === "site" ? "t".repeat(64) : undefined }); });
  await PC.refresh();
}
async function breakStore() {
  await runQuery("ALTER TABLE policy_cfg RENAME TO policy_cfg_real");
  await runQuery("CREATE VIEW policy_cfg AS SELECT json('not json') AS key, '1' AS value, 1 AS rev, 0 AS updated, '' AS by, '' AS via, '' AS src");
  PC.forget();
}
async function fixStore() {
  await runQuery("DROP VIEW policy_cfg");
  await runQuery("ALTER TABLE policy_cfg_real RENAME TO policy_cfg");
  PC.forget();
}
const isCode = (code) => (e) => e && e.code === code;
const bal = async (id) => Number((await getQuery("SELECT points_balance FROM users WHERE userId = ?", [id]))[0].points_balance);

/** Every reader's answer (or the error code it throws). */
async function readAll() {
  const out = {};
  const one = async (k, fn) => { try { out[k] = await fn(); } catch (e) { out[k] = "THROWS " + (e && e.code); } };
  await one("heist_market_fee", () => HM.feeShares());
  await one("raffle_fee", () => RF.feeShares());
  await one("raffle_legs", () => RF.feeLegs(1000));
  await one("auto_escrow_expired", () => AE.shares());
  await one("account_deleted", () => AD.shares());
  await one("gang_withdraw_cut", () => GG.cutLegs(100, { cut_shares: [["fortknox", 100]] }));
  await one("fine_pad", () => PF.fineRoute());
  await one("bonus_cap", () => V.bonusCap({}));
  return out;
}

test("Pepe owns the settings (mirror mode): the readers use his table as before - the override, else the catalog default", async () => {
  await owner("pepe");
  const r = await readAll();
  assert.deepEqual(r.heist_market_fee, [["incentives", 100]]);
  assert.deepEqual(r.raffle_fee, [["fortknox", 100]]);
  assert.deepEqual(r.auto_escrow_expired, [["fortknox", 100]]);
  assert.deepEqual(r.account_deleted, [["fortknox", 100]]);
  assert.deepEqual(r.gang_withdraw_cut, [["stakers", 100]]);
  assert.deepEqual(r.fine_pad, { shares: [["fortknox", 100]], override: true });
  // a flow without a row: the catalog's default, else the flow's documented default (that is the table's meaning, not a fallback)
  assert.deepEqual(await ES.routeShares("raffle", [["jackpot", 100]]), [["incentives", 100]], "an override");
  assert.deepEqual(await ES.routeShares("wheel", [["reserve", 100]]), [["jackpot", 100]], "no row: the catalog default");
  assert.deepEqual(await ES.routeShares("no_such_flow", [["reserve", 100]]), [["reserve", 100]], "no row, no catalog entry: the flow's default");
  // the store unreadable while Pepe owns it: his table still answers (the owner as last read is his)
  await breakStore();
  try {
    assert.deepEqual(await HM.feeShares(), [["incentives", 100]]);
    assert.deepEqual(await AD.shares(), [["fortknox", 100]]);
  } finally { await fixStore(); }
});

test("the site owns the settings: the readers route by the store's PAT Routing - and DEFER when it can't be read (never a default)", async () => {
  await owner("site");
  try {
    // readable: the store's copy (the mirrored overrides)
    const ok = await readAll();
    assert.deepEqual(ok.heist_market_fee, [["incentives", 100]]);
    assert.deepEqual(ok.fine_pad, { shares: [["fortknox", 100]], override: true });
    assert.deepEqual(ok.gang_withdraw_cut, [["stakers", 100]]);
    // unreadable: every money reader throws E_CFG_UNREADABLE (the move defers) - before this fix they routed by
    // [[fortknox]] / [[jackpot]] / [[incentives]] / [[reserve]] / Pepe's cut_shares / "no cap"
    alerts.length = 0;
    await breakStore();
    let r;
    try { r = await readAll(); } finally { await fixStore(); }
    for (const k of ["heist_market_fee", "raffle_fee", "raffle_legs", "auto_escrow_expired", "account_deleted", "gang_withdraw_cut", "bonus_cap"]) {
      assert.equal(r[k], "THROWS E_CFG_UNREADABLE", `${k}: ${JSON.stringify(r[k])}`);
    }
    // the pad fine card says it can't tell - never the default shown as the route
    assert.deepEqual(r.fine_pad, { shares: null, override: false, unavailable: true });
    assert.ok(alerts.some((a) => /Economy settings unreadable - PAT Routing deferred/.test(a.title)), "the owners are alerted");
  } finally { await owner("pepe"); }
});

test("site-owned + unreadable: a deleted account's balance is NOT routed - the debit rolls back with the transaction", async () => {
  await owner("site");
  try {
    await breakStore();
    try {
      await assert.rejects(tx(() => AD.routeBalanceInTx("gone", "acctdel-gone-0")), isCode("E_CFG_UNREADABLE"));
    } finally { await fixStore(); }
    assert.equal(await bal("gone"), 5000, "the balance is still on the account (the deletion is retried)");
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM account_deletion_routes"))[0].n, 0);
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM jackpot_rakes"))[0].n, 0);
    // readable again: it routes by the store's row
    const x = await tx(() => AD.routeBalanceInTx("gone", "acctdel-gone-0"));
    assert.deepEqual(x.legs, [["fortknox", 5000]]);
    assert.equal(await bal("gone"), 0);
  } finally { await owner("pepe"); }
});

test("site-owned + PAT Routing missing from the store: E_CFG_MISSING, never a default", async () => {
  await owner("site");
  const row = (await getQuery("SELECT * FROM policy_cfg WHERE key = 'pat_routes'"))[0];
  assert.ok(row, "the mirror stored PAT Routing");
  await runQuery("DELETE FROM policy_cfg WHERE key = 'pat_routes'");
  PC.forget();
  try {
    const r = await readAll();
    for (const k of ["heist_market_fee", "raffle_fee", "auto_escrow_expired", "account_deleted", "gang_withdraw_cut"]) {
      assert.equal(r[k], "THROWS E_CFG_MISSING", `${k}: ${JSON.stringify(r[k])}`);
    }
    assert.equal(r.fine_pad.unavailable, true);
  } finally {
    await runQuery("INSERT INTO policy_cfg (key, value, rev, updated, by, via, src) VALUES (?, ?, ?, ?, ?, ?, ?)",
                   [row.key, row.value, row.rev, row.updated, row.by, row.via, row.src]);
    PC.forget();
    await owner("pepe");
  }
});

test("another read failure (the econ tables): a default only while Pepe owns the settings - E_CFG_UNREADABLE once the site does", async () => {
  await runQuery("ALTER TABLE pat_routes RENAME TO pat_routes_real");
  try {
    await owner("pepe");
    assert.deepEqual(await ES.routeShares("wheel", [["reserve", 100]]), [["jackpot", 100]], "Pepe's: the catalog default, as before");
    assert.deepEqual(await HM.feeShares(), [["fortknox", 100]]);
    await owner("site");
    await assert.rejects(HM.feeShares(), isCode("E_CFG_UNREADABLE"));
    await assert.rejects(ES.routeShares("wheel", [["reserve", 100]]), isCode("E_CFG_UNREADABLE"));
  } finally {
    await runQuery("ALTER TABLE pat_routes_real RENAME TO pat_routes");
    await owner("pepe");
  }
});
