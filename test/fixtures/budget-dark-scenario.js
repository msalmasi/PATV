// Helper for test/policy-budget-dark.test.js (not a test itself): one fixed stretch of economy with Pepe owning the incentive week - the engines'
// Monday, day and burn runs, website grants paid / queued / undone, a staff grant, a House flash claim, the pools' claim sweep, a gang tick, Pepe's
// syncs and doc pushes - then every table those paths write, in a form free of uuids and clocks.
//   node budget-dark-scenario.js <repo> <out.json> [stub]    stub = run with the budget module replaced by a do-nothing one
"use strict";
const fs = require("fs");
const path = require("path");
const H = require("./budget-harness");

const [, , repo, out, mode] = process.argv;
H.setProcess("budget-dark");
console.log = () => {}; console.warn = () => {};
const { M } = H;
const MON = Date.UTC(2026, 10, 16, 4, 5);
const did = (t) => "D" + new Date(t - 4 * 3600e3).toISOString().slice(0, 10);

(async () => {
  if (mode === "stub") {                                 // the code path as if the module weren't there
    const file = require.resolve(path.join(repo, "policy", "budget.js"));
    require.cache[file] = { id: file, filename: file, loaded: true, exports: { isSite: async () => false, ownerRow: async () => ({ owner: "pepe", paused: 0 }), noteSync() {}, shadowPass: async () => null,
                                                                               sweepLegacyClaims: async () => ({ settled: 0 }), init: async () => {} } };
  }
  const X = await H.boot(repo, { clock: MON });
  const { R, runQuery, C, ES, FUND, P } = X;
  const A = R("policy", "apply"), G = R("policy", "gather"), SCH = R("policy", "scheduler");
  await runQuery("CREATE TABLE IF NOT EXISTS incentive_groups_dummy (x)").catch(() => {});
  R("econ");
  await runQuery(`CREATE TABLE IF NOT EXISTS econ_participation (room_id TEXT NOT NULL, day TEXT NOT NULL, login TEXT NOT NULL, lines INTEGER DEFAULT 0,
                  mic_min REAL DEFAULT 0, cmds INTEGER DEFAULT 0, active_min INTEGER DEFAULT 0, updated INTEGER, PRIMARY KEY (room_id, day, login))`);
  for (const e of C.ENGINES) await C.setMode(e, "live", { by: "t", armedAt: 0 });
  await ES.putDocs({ econ_layers: { rev: 1, doc: { fed_mints: {}, fed_loans: {}, fed_loan_repaid: {} } },
                     econ_treasury: { rev: 1, doc: { week: { id: H.WEEK, budgets: {}, spent: { activity: 0, roomgames: 500 } }, bank_lent: [], days: {}, settled: {} } } });
  // the Monday runs
  const nowS = MON / 1000;
  const r = {};
  r.epoch = await A.runTreasuryEpoch(H.WEEK, nowS);
  r.daily = await A.runTreasuryDaily(did(MON), nowS);
  const day = G.localDay(nowS);
  for (const [login, lines] of [["ann_cf", 40], ["bob_cf", 15]]) await runQuery("INSERT INTO econ_participation (room_id, day, login, lines, mic_min) VALUES ('r1', ?, ?, ?, 0)", [day, login, lines]);
  r.monetary = await A.runMonetary(did(MON), nowS, true);
  await P._inTx.seen("x");
  await X.tx(() => P._inTx.applyLegs("seed-burn", [{ pool: "burn", amount: 5000 }], { kind: "move" }));
  r.burn = await A.runBurn("S2026-11-16T04:05", nowS);
  // website grants against Pepe's last sync
  X.setNow(H.T0);
  FUND.sync(H.syncBody());
  r.pay = await FUND.fundPayoutEx("u1", 25000, "levelup", "level up");
  r.payq = await FUND.fundPayoutEx("u2", 2 * M, "new_account", "welcome");
  const t = await FUND.takeFundsRef("redeem_codes", 5000, "u1", "code");
  await t.undo();
  const kept = await FUND.takeFundsRef("connect_bonus", 7000, "u3", "connect");
  r.staff = await FUND.takeIncentivesRef("staff_grant", 9000, "u1", "staff");
  r.flash = await FUND.houseFlashCover("wheel", 19 * M, "u1", "wheel prize", "spin:1");
  r.fundable = [await FUND.fundable("levelup"), await FUND.fundable("new_account"), await FUND.fundable("platform_rewards")];
  r.claims = (await FUND.claims()).map((c) => [c.flow, c.amount]).sort();
  // Pepe settles what he settles; the site sweeps its own; a later sync frees the queue
  const ids = (await FUND.claims()).filter((c) => String(c.flow).startsWith("incentives:levelup")).map((c) => c.claimId);
  r.settled = await FUND.settle(ids);
  await P.settleClaims();
  FUND.sync(H.syncBody({ incentives: Object.assign(H.syncBody().incentives, { remaining: Object.assign({}, H.syncBody().incentives.remaining, { welcome: 3 * M }), balance: 9 * M }) }));
  await FUND._persisted();
  await FUND.drainQueue();
  r.queue = (await FUND.queueSummary()).groups;
  // a gang tick with an incentive leg
  const GG = R("gangs");
  await GG.init();
  await GG._setMeta("enabled", true);
  const crypto = require("crypto");
  const payload = JSON.stringify({ v: 1, source: "pepe", gangs: { aa11bb22: { name: "One", tag: "ONE", boss: "ann_cf", officers: [], members: ["ann_cf"], treasury: 100, rep: 1, created: "2026-07-04", wars: {} } },
                                   members: { ann_cf: "aa11bb22" }, users: { ann_cf: { userId: "u1" } }, disbanded: {}, supply_gangs: 100, casino_rep_done: [], cfg: {} });
  await GG.importFromPepe({ key: "gc-dark-1", payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"), totals: { gangs: 1, members: 1, treasury: 100, rep: 1 } }).catch((e) => { r.gang_import = e.message; });
  r.tick = await GG.move({ key: "turf-tick:2026-11-18:aa11bb22", gid: "aa11bb22", legs: [["incentives", -1000], ["gang", 1000]], why: "daily turf tick", flow: "turf_tick" }, "pepe").then((m) => m.ok).catch((e) => e.code);
  // the scheduler's pass after the day's runs
  X.setNow(H.T0 + 7 * 3600e3);
  await SCH.pass((H.T0 + 7 * 3600e3) / 1000);
  r.kept = !!kept.ok;
  const clean = JSON.parse(JSON.stringify(r, (k, v) => (["claimId", "conserved"].includes(k) ? undefined : typeof v === "function" ? undefined : v)).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
                                                                                                                  .replace(/"(ts|done|at|created|updated|opened|pools_before|pools_after)":[0-9.]+/g, '"$1":0'));
  fs.writeFileSync(out, JSON.stringify({ results: clean, tables: await H.pointTables(X.db) }));
  process.exit(0);
})().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
