// Review of PO-2 (economy policy -> site plan, "Phase 6"): the policy config store's guards.
//   * committed reads: a snapshot / Pepe's pull outside a transaction is read in one of its own on the chain - never an open
//     edit's rows, never a rev its rollback takes back (settledMoveStatus' rule); "unchanged" needs the rev AND the sha
//   * no auto-fallback: while the site owns the config (or its owner isn't known) an unreadable store fails the readers
//     (E_CFG_UNREADABLE: the cut-off / engines defer) - never Pepe's push, never the pre-H1 routing table, never "pepe" guessed;
//     while Pepe owns it, his push stays the source (as before); funding's monetary block keeps the site's last block
//   * the run window waits for the site's capital cut-off (it reads the staking keys) - also when the engines' flags are off,
//     and an overdue cut-off freezes them at any hour
//   * the dual read's evidence survives a failed flush; only the mirror's own log rows are pruned
//   * the engines' rollback waits for the budget's (reverse order)
//   * tools/policy-backend.js preflight: the H1 evidence gates FAIL without evidence (no comparison / no checked mirror day)
//   NODE_PATH=G:/PATV/node_modules node --test test/policy-config-review.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "policy-config-review-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery, tx } = require(path.join(repo, "dbUtils"));
const SR = require(path.join(repo, "staffroles"));
const C = require(path.join(repo, "policy", "core"));
const PC = require(path.join(repo, "policy", "config"));
const SRC = require(path.join(repo, "policy", "source"));
const SCH = require(path.join(repo, "policy", "scheduler"));
const CC = require(path.join(repo, "capital", "core"));
const ES = require(path.join(repo, "econstore"));
const FUND = require(path.join(repo, "funding"));
const FED = require(path.join(repo, "fed", "service"));
const FX = require("./fixtures/policycfg");
const OPS = require(path.join(repo, "opsalerts"));

const alerts = [];
OPS.alert = async (a) => { alerts.push(a); return { admins: 0 }; };
const M = FX.M;
let clockMs = Date.UTC(2026, 9, 20, 15, 0);                     // Tuesday 2026-10-20 15:00 UTC
PC._setClock(() => clockMs);
C._setClock(() => clockMs);

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await SR.init();
  await runQuery("INSERT INTO pepe_roles (login, role, ts) VALUES ('owner_cf', 'owner', 1)");
  await FUND.init();
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const deps = { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() };
  ES.register(app, deps);
  SCH.register(app, deps);
  PC.register(app, deps);
  require(path.join(repo, "capital", "service")).register(app, deps);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await bot("/api/policy/bot/config", { cfg: FX.policyPush() })).body.ok, true);
  assert.equal((await bot("/api/capital/bot/config", { cfg: FX.capitalPush() })).body.ok, true);
  assert.equal((await bot("/api/econ/settings/put", { pat_routes: FX.routes(), catalog: FX.catalog(), econ_cfg: {}, econ_cfg_log: [] })).body.ok, true);
  FUND.sync({ monetary: FX.monetary() });
  const snap = await PC.snapshot({ fresh: true });
  assert.deepEqual(require(path.join(repo, "policy", "cfgspec")).KEYS.filter((k) => !(k in snap.cfg)), []);
});
test.after(() => server && server.close());

const bot = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot" }, body)) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
async function owner(o) {
  await tx(async () => { await PC.putOwner("cfg", o, { by: "test", handoverKey: o === "site" ? "t".repeat(64) : undefined }); });
  await PC.refresh();
}
/** policy_cfg made unreadable (a read error that isn't "no such table": a view whose read raises) - and back. */
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

test("committed reads: a pull or a snapshot during an open transaction answers committed rows - never a rev its rollback takes back", async () => {
  await owner("site");
  const snap0 = await PC.snapshot({ fresh: true });
  let release;
  const gate = new Promise((r) => { release = r; });
  let opened;
  const inside = new Promise((r) => { opened = r; });
  // an open transaction writes rev N+1 (donation 123) ... and rolls back
  const t = tx(async () => {
    const snap = await PC.load();
    await PC.writeChanges([["donation_rate", snap.cfg.donation_rate, 123]], { by: "x", via: "mirror", snap });
    opened();
    await gate;
    throw new Error("rolled back");
  }).catch((e) => e.message);
  await inside;
  PC.forget();
  const pull = PC.botCfg();                                      // Pepe's GET /api/policy/bot/cfg - queued behind it
  const read = PC.snapshot({ fresh: true });                     // any reader outside a transaction
  let settled = false;
  pull.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, 40));
  release();                                                     // (released before asserting: a failure never hangs the file)
  const waited = !settled;
  assert.equal(await t, "rolled back");
  assert.equal(waited, true, "the pull waited for the open transaction (it never reads its rows)");
  const p = await pull, s = await read;
  assert.equal(p.rev, snap0.rev, "the committed rev");
  assert.equal(p.sha, snap0.sha);
  assert.equal(p.cfg.donation_rate, snap0.cfg.donation_rate);
  assert.equal(s.rev, snap0.rev);
  assert.equal(s.cfg.donation_rate, snap0.cfg.donation_rate);
  assert.equal(PC.cached().cfg.donation_rate, snap0.cfg.donation_rate, "funding's sync reader never caches the dirty rows");
  // the next real write takes that rev number with other values: Pepe, at (rev N, sha N), gets the whole new config
  const e = await PC.edit({ changes: { donation_rate: 456 }, via: "chat", actor: "owner_cf", baseRev: snap0.rev });
  assert.equal(e.rev, snap0.rev + 1);
  const q = await PC.botCfg(String(snap0.rev), snap0.sha);
  assert.equal(q.unchanged, undefined);
  assert.equal(q.rev, e.rev);
  assert.equal(q.cfg.donation_rate, 456);
  const u = await PC.botCfg(String(e.rev), e.sha);
  assert.equal(u.unchanged, true);
  assert.equal((await PC.botCfg(String(e.rev), snap0.sha)).unchanged, undefined, "the rev with a stale sha is not 'unchanged'");
});

test("no auto-fallback: site-owned + an unreadable store -> every reader defers (E_CFG_UNREADABLE) and the owners are alerted; Pepe's values are never used", async () => {
  alerts.length = 0;
  PC._resetMemory();
  await PC.refresh();
  const m0 = JSON.parse(JSON.stringify(FUND.state.monetary));
  assert.ok(m0 && m0.cfg_rev !== undefined, "the site's block (tagged with its rev)");
  await breakStore();
  try {
    await assert.rejects(CC.cfg({ consumer: "capital.cutoff" }), (e) => e.code === "E_CFG_UNREADABLE");
    await assert.rejects(SRC.read(), (e) => e.code === "E_CFG_UNREADABLE");
    await assert.rejects(SRC.owner(), "the owner is never guessed as Pepe's");
    await assert.rejects(FED.cfgNow({ fed_floor: 1 }), (e) => e.code === "E_CFG_UNREADABLE", "a Fed op never runs on Pepe's per-op values");
    await assert.rejects(ES.getSettings(), (e) => e.code === "E_CFG_UNREADABLE", "never the frozen pre-H1 routing table");
    const r = await bot("/api/econ/settings/put", { pat_routes: { raffle: [["reserve", 100]] } });
    assert.equal(r.status, 500, "Pepe's routing push fails (he sends it again) - it never lands in the table on a guessed owner");
    assert.equal((await getQuery("SELECT shares FROM pat_routes WHERE flow = 'raffle'"))[0].shares, JSON.stringify(FX.routes().raffle));
    // funding's monetary block keeps the site's last block - never Pepe's
    FUND.sync({ monetary: FX.monetary({ house_hard_floor: 1 * M, donation: { rate: 7, bonus_pct: 1 } }) });
    assert.equal(FUND.state.monetary.house_hard_floor, 5 * M);
    assert.equal(FUND.state.monetary.donation.rate, m0.donation.rate);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(alerts.some((a) => /unreadable/.test(a.title)), JSON.stringify(alerts.map((a) => a.title)));
  } finally { await fixStore(); }
  assert.equal((await CC.cfg({ consumer: "capital.cutoff" })).cfg_rev, (await PC.snapshot()).rev, "readable again: the store's values");
});

test("no auto-fallback: a missing monetary key keeps the site's last block; an unknown owner (a restart) never takes Pepe's block for the site's", async () => {
  FUND.sync({ monetary: FX.monetary() });
  const siteBlock = JSON.parse(JSON.stringify(FUND.state.monetary));
  assert.equal(siteBlock.donation.rate, 456, "the site's donation rate (an edit above)");
  await runQuery("DELETE FROM policy_cfg WHERE key = 'fed_floor'");
  await PC.refresh();
  FUND.sync({ monetary: FX.monetary({ donation: { rate: 9, bonus_pct: 1 }, band: { fed: 60 * M, floor: 1, ceiling: 2 } }) });
  assert.equal(FUND.state.monetary.donation.rate, 456, "not Pepe's 9");
  assert.equal(FUND.state.monetary.band.floor, siteBlock.band.floor);
  await PC.applyMigrations([{ id: "review-fed-floor", seeds: { fed_floor: 25 * M } }]);
  await PC.refresh();
  // a restart: nothing known yet - the block funding restored (the site's) stands, then the owner is read and the block re-applied
  PC._resetMemory();
  FUND.sync({ monetary: FX.monetary({ donation: { rate: 9, bonus_pct: 1 } }) });
  assert.equal(FUND.state.monetary.donation.rate, 456, "the restored site block, not Pepe's");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(FUND.state.monetary.donation.rate, 456);
  assert.equal(FUND.state.monetary.cfg_rev, (await PC.snapshot()).rev, "re-applied from the store once the owner was read");
  // an unexpected error in the overlay keeps the block in use - never Pepe's in its place
  const real = PC.monetaryFor;
  PC.monetaryFor = () => { throw new Error("boom"); };
  try { FUND.sync({ monetary: FX.monetary({ donation: { rate: 9, bonus_pct: 1 } }) }); } finally { PC.monetaryFor = real; }
  assert.equal(FUND.state.monetary.donation.rate, 456);
});

test("while Pepe owns the config an unreadable store changes nothing for the readers: his push stays their source (as before PO-2)", async () => {
  await owner("pepe");
  await breakStore();
  try {
    const c = await CC.cfg({ consumer: "capital.cutoff" });
    assert.equal(c.ceil_apr, 0, "his push");
    assert.equal(c.cfg_rev, undefined);
    assert.equal((await SRC.read()).from, "push");
    assert.equal(await SRC.owner(), "pepe", "the owner as last read");
    assert.equal((await FED.cfgNow({ fed_floor: 7 * M })).cfg.fed_floor, 7 * M, "the Fed: his per-op value wins, as before");
    assert.deepEqual((await ES.getSettings()).pat_routes, FX.routes());
    // a restart while it's unreadable: the owner isn't known - the readers defer rather than guess
    PC._resetMemory();
    await assert.rejects(CC.cfg({ consumer: "capital.cutoff" }), (e) => e.code === "E_CFG_UNREADABLE");
  } finally { await fixStore(); }
  await PC.refresh();
});

test("the run window waits for the site's capital cut-off (the staking keys feed it) - flags off too; an overdue cut-off freezes them at any hour", async () => {
  await owner("site");
  await CC.setMeta("live", true);
  CC.forgetLive();
  const day = Date.UTC(2026, 9, 21) / 1000;                     // Wednesday
  const boundary = day + 4 * 3600;
  await CC.putDoc("vaults", { v: {}, auto: { total: 0, holders: {} }, queue: {}, epochs: [], seq: 0, inited: 1, insured: [], next_epoch: boundary });
  // Pepe's daily + monetary runs are done; the site's cut-off hasn't run: frozen
  assert.equal((await bot("/api/policy/bot/config", { cfg: FX.policyPush({ days_done: ["D2026-10-21"], mo_days_done: ["D2026-10-21"] }) })).body.ok, true);
  clockMs = (boundary + 30) * 1000;                              // 04:00:30
  let w = await PC.runWindow(boundary + 30);
  assert.deepEqual(w.waiting, ["capital:cutoff 2026-10-21"]);
  const snap = await PC.snapshot({ fresh: true });
  await assert.rejects(PC.edit({ changes: { vault_ceil_apr: "20%" }, via: "chat", actor: "owner_cf", baseRev: snap.rev }),
                       (e) => e.status === 423 && e.code === "run_window" && e.extra.window.waiting.includes("capital:cutoff 2026-10-21"));
  // the engines' flags off: no treasury / monetary run expected - the cut-off still is
  await owner("site");
  const s2 = await PC.snapshot({ fresh: true });
  await PC.edit({ changes: { tr_live: "off", layers: "off" }, via: "chat", actor: "owner_cf", baseRev: s2.rev }).catch((e) => e);
  w = await PC.runWindow(boundary + 30);
  assert.deepEqual(w.waiting, ["capital:cutoff 2026-10-21"], "flags off: the window still waits for the cut-off");
  // the cut-off ran (next_epoch past the boundary): open for edits
  await CC.putDoc("vaults", { v: {}, auto: { total: 0, holders: {} }, queue: {}, epochs: [], seq: 0, inited: 1, insured: [], next_epoch: boundary + 86400 });
  w = await PC.runWindow(boundary + 30);
  assert.equal(w.open, false, JSON.stringify(w));
  const s3 = await PC.snapshot({ fresh: true });
  const e = await PC.edit({ changes: { vault_ceil_apr: "20%" }, via: "chat", actor: "owner_cf", baseRev: s3.rev });
  assert.equal(e.ok, true);
  // overdue: yesterday's cut-off never ran - at 02:00 (before the 03:40 window) the staking keys are frozen anyway
  await CC.putDoc("vaults", { v: {}, auto: { total: 0, holders: {} }, queue: {}, epochs: [], seq: 0, inited: 1, insured: [], next_epoch: boundary });
  w = await PC.runWindow(boundary + 86400 - 2 * 3600);
  assert.equal(w.open, true);
  assert.deepEqual(w.waiting, ["capital:cutoff 2026-10-21"]);
  // ...and on time, before 03:40, nothing waits
  await CC.putDoc("vaults", { v: {}, auto: { total: 0, holders: {} }, queue: {}, epochs: [], seq: 0, inited: 1, insured: [], next_epoch: boundary + 86400 });
  w = await PC.runWindow(boundary + 86400 - 2 * 3600);
  assert.equal(w.open, false);
  await CC.setMeta("live", false);
  CC.forgetLive();
  clockMs = Date.UTC(2026, 9, 20, 15, 0);
});

test("the dual read's evidence survives a failed flush (kept for the next one); the change log prunes only the mirror's rows", async () => {
  PC._resetMemory();
  await PC.refresh();
  await runQuery("DELETE FROM policy_cfg_dualcheck");
  PC.noteDual("capital.cutoff", [{ field: "ceil_apr", push: 0.25, site: 0 }]);
  PC.noteDual("capital.cutoff", []);
  await runQuery("ALTER TABLE policy_cfg_dualcheck RENAME TO policy_cfg_dualcheck_x");
  try {
    assert.equal(await PC.flushDual(), 0, "the write failed");
    assert.deepEqual(PC._dualPending(), { rows: 1, checks: 1 }, "kept for the next flush");
    PC.noteDual("capital.cutoff", []);                           // a comparison meanwhile merges in
  } finally { await runQuery("ALTER TABLE policy_cfg_dualcheck_x RENAME TO policy_cfg_dualcheck"); }
  assert.ok((await PC.flushDual()) > 0);
  assert.deepEqual(PC._dualPending(), { rows: 0, checks: 0 });
  const c = (await getQuery("SELECT checks, diffs FROM policy_cfg_dualcheck WHERE consumer = 'capital.cutoff'"))[0];
  assert.deepEqual([c.checks, c.diffs], [3, 1], "every comparison counted once");
  assert.ok((await getQuery("SELECT n FROM policy_cfg_dualread WHERE consumer = 'capital.cutoff' AND key = 'ceil_apr' AND push = '0.25'")).length);
  // the log: only the mirror's own rows are pruned (an owner's edit, an import, a migration are kept)
  await owner("pepe");
  PC._setLogKeep(2);
  try {
    const people = (await getQuery("SELECT COUNT(*) AS n FROM policy_cfg_log WHERE via <> 'mirror'"))[0].n;
    assert.ok(people >= 3, "edits / migration rows above");
    for (const rate of [510000, 520000, 530000, 540000]) await bot("/api/policy/bot/config", { cfg: FX.policyPush({ econ_cfg: { donation_rate: rate } }) });
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM policy_cfg_log WHERE via = 'mirror'"))[0].n, 2, "the keep count");
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM policy_cfg_log WHERE via <> 'mirror'"))[0].n, people, "no person's row pruned");
  } finally { PC._setLogKeep(); }
});

test("the engines' rollback waits for the budget's (reverse order: H2b before H2a)", async () => {
  await C.setMode("treasury", "live", { by: "test" });
  await tx(async () => { await PC.putOwner("budget", "site", { by: "test" }); });
  try {
    const r = await SCH.rollback({ key: "rb-" + "a".repeat(20), engines: ["treasury"], actor: "owner_cf" });
    assert.equal(r.ok, false);
    assert.equal(r.code, "order");
    assert.equal((await C.engines()).treasury.mode, "live", "nothing rolled back");
  } finally {
    await tx(async () => { await PC.putOwner("budget", "pepe", { by: "test" }); });
    await C.setMode("treasury", "shadow", { by: "test" });
  }
});

test("preflight (tools/policy-backend.js): the H1 evidence gates FAIL without evidence - every day's mirror check and every daily reader's comparison", async () => {
  await CC.setMeta("live", true);
  await C.setMode("treasury", "shadow", { by: "test" });
  const run = (...a) => spawnSync(process.execPath, [path.join(repo, "tools", "policy-backend.js"), "preflight", ...a], { cwd: tmp, encoding: "utf8", env: process.env });
  const lines = (x) => x.stdout.split("\n").filter((l) => /mirror diff|dual read/.test(l));
  const day = (n) => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10);
  await runQuery("DELETE FROM policy_cfg_dualcheck");
  await runQuery("DELETE FROM policy_cfg_dualread");
  await C.setMeta("cfg_mirror_days", {});
  // nothing recorded: no PASS
  let x = run();
  let l = lines(x);
  assert.ok(l.some((s) => /^FAIL {2}mirror diff empty every day .*not checked/.test(s)), l.join("\n"));
  assert.ok(l.some((s) => /^FAIL {2}dual read recorded every day .*no comparison recorded/.test(s)), l.join("\n"));
  assert.equal(x.status, 1);
  // a complete window: every day checked and empty, every daily reader compared, no difference
  const clean = { missing: 0, unknown: 0, invalid: 0, whole: 0, disagree: 0 };
  const days = {};
  for (let n = 1; n <= 4; n++) days[day(n)] = { pushes: 288, changes: 0, checked_at: 1, max: clean, last: clean };
  await C.setMeta("cfg_mirror_days", days);
  for (let n = 1; n <= 4; n++) {
    for (const c of ["capital.cutoff", "policy.source", "funding.monetary"]) {
      if (n === 2 && c === "capital.cutoff") continue;              // one cut-off left no comparison (a restart lost its buffer)
      await runQuery("INSERT INTO policy_cfg_dualcheck (day, consumer, checks, diffs, first_ts, last_ts) VALUES (?, ?, 5, 0, 1, 1)", [day(n), c]);
    }
  }
  l = lines(run());
  assert.ok(l.some((s) => /^PASS {2}mirror diff empty every day/.test(s)), l.join("\n"));
  assert.ok(l.some((s) => new RegExp(`^FAIL {2}dual read recorded every day .*no comparison recorded: ${day(2)} capital\\.cutoff`).test(s)), l.join("\n"));
  await runQuery("INSERT INTO policy_cfg_dualcheck (day, consumer, checks, diffs, first_ts, last_ts) VALUES (?, 'capital.cutoff', 1, 0, 1, 1)", [day(2)]);
  l = lines(run());
  assert.ok(l.some((s) => /^PASS {2}dual read recorded every day .*capital\.cutoff, policy\.source, funding\.monetary/.test(s)), l.join("\n"));
  assert.ok(l.some((s) => /^PASS {2}dual read clean/.test(s)), l.join("\n"));
  // a difference (today too) fails; so does a day the mirror diff wasn't empty
  await runQuery("INSERT INTO policy_cfg_dualcheck (day, consumer, checks, diffs, first_ts, last_ts) VALUES (?, 'fed.cfgNow', 2, 1, 1, 1)", [day(0)]);
  days[day(3)].max = Object.assign({}, clean, { missing: 4 });
  await C.setMeta("cfg_mirror_days", days);
  l = lines(run());
  assert.ok(l.some((s) => /^FAIL {2}dual read clean .*fed\.cfgNow: 1/.test(s)), l.join("\n"));
  assert.ok(l.some((s) => /^FAIL {2}mirror diff empty every day .*"missing":4/.test(s)), l.join("\n"));
  // --since widens the window to the gate's first day (H1: --since=2026-10-30)
  l = lines(run(`--since=${day(6)}`));
  assert.ok(l.some((s) => new RegExp(`^FAIL {2}mirror diff empty every day ${day(6)}\\.\\.${day(1)}.*not checked: ${day(6)}, ${day(5)}`).test(s)), l.join("\n"));
  await CC.setMeta("live", false);
});

test("review of the owner answers (CF20 / CF21 / CF22): the H1 check compares the import with EVERY reader's push - capital, PAT Routing, the funding block - not only policy.source", async () => {
  let snap = await PC.snapshot({ fresh: true });
  // funding's last sync as the earlier tests left it -> the store's values (a clean start: the store equals every push)
  const fundOk = () => FX.monetary({ donation: { rate: snap.cfg.donation_rate, bonus_pct: snap.cfg.donation_bonus_pct } });
  FUND.sync({ monetary: fundOk() });
  snap = await PC.snapshot({ fresh: true });
  const keysOf = async (cfg) => (await PC.pushCheck(cfg)).keys;
  assert.deepEqual(await keysOf(snap.cfg), [], "the store equals every push");
  try {
    // the cut-off reads Pepe's CAPITAL push today: his capital ceil_apr 0.25 against an import of 0 (his policy push still says 0)
    assert.equal((await bot("/api/capital/bot/config", { cfg: FX.capitalPush({ ceil_apr: 0.25 }) })).body.ok, true);
    const c = await PC.pushCheck(snap.cfg);
    assert.ok(c.keys.includes("vault_ceil_apr"), JSON.stringify(c.keys));
    assert.ok(c.diffs.some((d) => d.consumer === "capital" && d.field === "ceil_apr"), JSON.stringify(c.diffs));
  } finally { assert.equal((await bot("/api/capital/bot/config", { cfg: FX.capitalPush() })).body.ok, true); }
  assert.deepEqual(await keysOf(snap.cfg), []);
  // econstore's routing table (what the PAT moves read until H1) differs from the import's PAT Routing
  const cfg2 = Object.assign({}, snap.cfg, { pat_routes: Object.assign({}, snap.cfg.pat_routes, { raffle: [["reserve", 100]] }) });
  const r = await PC.pushCheck(cfg2);
  assert.deepEqual(r.keys, ["pat_routes"]);
  assert.ok(r.diffs.some((d) => d.consumer === "econstore.routes"));
  // funding's last live sync (the monetary block the Fed / donations read): the donation rate differs
  try {
    FUND.sync({ monetary: FX.monetary({ donation: { rate: 400000, bonus_pct: 20.0 } }) });
    const f = await PC.pushCheck(snap.cfg);
    assert.ok(f.keys.includes("donation_rate"), JSON.stringify(f.keys));
    assert.ok(f.diffs.some((d) => d.consumer === "funding.monetary" && d.field === "donation.rate"), JSON.stringify(f.diffs));
  } finally { FUND.sync({ monetary: fundOk() }); }
  assert.deepEqual(await keysOf(snap.cfg), []);
});

test("review of the owner answers (CF31): the mirror never takes an older copy of a push than one it already took", async () => {
  await owner("pepe");
  const s0 = await PC.snapshot({ fresh: true });
  const ff = s0.cfg.fed_floor;
  const r = await PC.mirror("policy", FX.policyPush({ econ_cfg: { fed_floor: ff + 1 } }), { at: Date.UTC(2026, 0, 1) });   // stamped long before
  assert.deepEqual([r.mirrored, r.changed, r.stale], [false, 0, true]);
  const s1 = await PC.snapshot({ fresh: true });
  assert.equal(s1.rev, s0.rev, "no new rev");
  assert.equal(s1.cfg.fed_floor, ff, "the newer copy's value stands");
});
