// H2a rehearsal setup, exact inverse, retry/crash safety and staging path guard.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "policy-rehearsal-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "rehearsal-test";
process.env.PATV_ENV = "staging"; process.env.STAGING = "1";
const D = require("../dbUtils"), P = require("../pools"), C = require("../policy/core"), E = require("../policy/engines");
const R = require("../tools/policy-rehearse");
const at = Date.parse("2026-11-09T05:10:00Z") / 1000;
const cfg = Object.assign({}, E.DEFAULTS, { fed_floor: 50000000, fed_ceiling: 150000000, incentive_guarantee_target: 25000000,
  issuance_to_guarantee: false, fed_ceiling_action: "incentives", mintcap_total: -1 });
const options = (leg, tag = leg.slice(0, 8)) => ({ leg, tag, at });
test.before(async () => {
  await D.runQuery("CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT, points_balance INTEGER DEFAULT 0)");
  await D.runQuery("CREATE TABLE jackpot_rakes (amount INTEGER)");
  await D.runQuery("CREATE TABLE econ_participation (room_id TEXT, day TEXT, login TEXT, lines INTEGER, mic_min REAL, active_min REAL, cmds INTEGER)");
  await P.init(); await C.init();
  await P._setMeta("enabled", true);
  const pools = { reserve: 100000000, incentives: 30000000, fortknox: 10000000, bank: 70000000, mm: 70000000, burn: 0, heist: 3000000 };
  const payload = JSON.stringify({ v: 1, source: "pepe", pools, docs: {}, routes: {}, econ_cfg: {}, econ_cfg_log: [], catalog: {} });
  const r = await P.importFromPepe({ key: "pc-rehearsal-test", payload, digest: crypto.createHash("sha256").update(payload).digest("hex"),
    totals: { sum: Object.values(pools).reduce((a, b) => a + b, 0), count: Object.keys(pools).length, per_pool: pools } });
  assert.equal(r.ok, true);
  await C.putCfg({ econ_cfg: cfg, consts: E.CONSTS, flags: { layers: true, tr_live: true, ap_on: false },
    journal: [], days_done: [], burn_cfg: { mode: "accrual", accrual_every_min: 5 }, burn_inflight: 0 });
});
test.after(async () => { await new Promise((resolve) => D.db.close(resolve)); });
test("guard refuses wrong environment, absent DB and production-shaped paths before loading SQLite", () => {
  const db = path.join(tmp, "myapp.db");
  assert.equal(R.guard(db), fs.realpathSync(db));
  assert.throws(() => R.guard(db, { PATV_ENV: "production", STAGING: "1" }), /staging/);
  assert.throws(() => R.guard(db, { PATV_ENV: "staging", STAGING: "0" }), /STAGING/);
  assert.throws(() => R.guard(path.join(tmp, "absent.db")), /existing/);
  const prod = path.join(tmp, "production"); fs.mkdirSync(prod); fs.writeFileSync(path.join(prod, "myapp.db"), "");
  assert.throws(() => R.guard(path.join(prod, "myapp.db")), /disposable/);
  assert.throws(() => R.valid(options("floor", "bad-tag")), /tag/);
});
for (const leg of ["floor", "guarantee", "ceiling", "burn", "overflow"]) {
  test(leg + ": forced state, conserved keyed setup, exact undo and idempotent retries", async () => {
    const before = await P.balances(), total = await P.total();
    const o = options(leg), r = await R.setup(o);
    assert.equal(r.result.ok, true);
    assert.deepEqual(await P.total(), total);
    assert.equal(R.reached(leg, r.preview), true);
    if (leg === "burn") assert.equal(r.after.burn, before.burn + 250000);
    const again = await R.setup(o); assert.equal(again.dup, true);
    assert.deepEqual(await P.balances(), r.after);
    assert.equal((await R.undo(o)).ok, true);
    assert.deepEqual(await P.balances(), before);
    assert.equal((await R.undo(o)).dup, true);
    const moves = await D.getQuery("SELECT net FROM pool_moves WHERE key LIKE ?", [r.key + "%"]);
    assert.ok(moves.every((m) => m.net === 0));
  });
}
test("failed validation rolls back setup and its key; retry does not leave a partial move", async () => {
  await C.putCfg({ econ_cfg: Object.assign({}, cfg, { fed_floor_mint_daily: 0 }), consts: E.CONSTS, flags: { layers: true, tr_live: true } });
  const before = await P.balances();
  await assert.rejects(R.setup(options("floor", "fail")), /prevents/);
  assert.deepEqual(await P.balances(), before);
  assert.equal(await P.moveStatus("rehearse:fail:floor"), null);
  assert.equal(await C.meta("rehearse:fail:floor"), null);
  await C.putCfg({ econ_cfg: cfg, consts: E.CONSTS, flags: { layers: true, tr_live: true } });
  assert.equal((await R.setup(options("floor", "fail"))).result.ok, true);
  await R.undo(options("floor", "fail"));
});
test("undo refuses intervening pool activity; tag cannot be rebound", async () => {
  const o = options("floor", "drift"); await R.setup(o);
  await assert.rejects(R.setup(Object.assign({}, o, { at: at + 86400 })), /another clock/);
  await P.move({ key: "test-intervening", legs: [["bank", -1], ["mm", 1]], terminal: true });
  await assert.rejects(R.undo(o), /balances changed/);
  await P.move({ key: "test-intervening-undo", legs: [["mm", -1], ["bank", 1]], terminal: true });
  await R.undo(o);
});
test("interruption between transfer and receipt rolls back both; restart retry is safe", async () => {
  const before = await P.balances(), save = C.setMeta;
  C.setMeta = async (key, value) => { if (key === "rehearse:crash:floor") throw new Error("injected interruption"); return save(key, value); };
  try { await assert.rejects(R.setup(options("floor", "crash")), /injected interruption/); }
  finally { C.setMeta = save; }
  assert.deepEqual(await P.balances(), before);
  assert.equal(await P.moveStatus("rehearse:crash:floor"), null);
  assert.equal((await R.setup(options("floor", "crash"))).result.ok, true);
  await R.undo(options("floor", "crash"));
});
test("insufficient system PAT refuses without taking wallets or writing partial setup", async () => {
  const before = await P.balances();
  assert.throws(() => R.transfers(before, { fortknox: 9000000000000 }), /insufficient system/);
  assert.deepEqual(await P.balances(), before);
});
test("actual scheduler dry tick retains modes and clock, tagged evidence, no PAT movement", async () => {
  const o = Object.assign(options("floor", "tick"), { at: at + 86400 }); await R.setup(o);
  await C.setMode("monetary", "dry", { by: "test", armedAt: at - 86400 });
  const before = await P.balances(), clock = await C.meta("test_clock");
  const result = await R.tick(o);
  assert.ok(result.ran.some((s) => /dry monetary/.test(s)));
  assert.ok(result.evidence.comparisons.some((r) => r.period.endsWith("-tick") && JSON.parse(r.site_plan).floor_mint > 0));
  assert.deepEqual(await P.balances(), before);
  assert.equal((await C.engines()).monetary.mode, "dry");
  assert.deepEqual(await C.meta("test_clock"), clock || { offset_ms: 0, at: null });
  assert.deepEqual((await R.tick(o)).ran, []);
  await R.undo(o);
});
test("live scheduler burn evidence includes hashed move; retry burns once and undo refuses", async () => {
  await require("../escrow/ledger").init();
  await C.putCfg({ econ_cfg: cfg, consts: E.CONSTS, flags: { layers: true, tr_live: true },
    burn_cfg: { mode: "accrual", accrual_every_min: 5 }, burn_inflight: 0 });
  const o = Object.assign(options("burn", "liveburn"), { at: at + 86400 });
  await R.setup(o);
  await C.setMode("burn", "live", { by: "test", armedAt: at - 86400 });
  const total = (await P.total()).amount;
  const r = await R.tick(o);
  assert.ok(r.ran.some((s) => /^burn A/.test(s)));
  assert.equal((await P.total()).amount, total - 250000);
  assert.ok(r.evidence.moves.some((m) => m.kind === "burn" && m.net === -250000));
  assert.equal(r.evidence.runs.filter((x) => x.engine === "burn" && x.state === "done").length, 1);
  const count = r.evidence.moves.length;
  const again = await R.tick(o);
  assert.equal(again.evidence.moves.length, count);
  assert.equal((await P.total()).amount, total - 250000);
  await assert.rejects(R.undo(o), /balances changed/);
});
for (const leg of ["floor", "ceiling", "guarantee"]) {
  test("live scheduler " + leg + ": actual leg once, recorded plan and expected supply delta", async () => {
    const tag = "live" + leg.slice(0, 4), clock = leg === "guarantee" ? at : at + 86400;
    await C.putCfg({ econ_cfg: cfg, consts: E.CONSTS, flags: { layers: true, tr_live: true },
      journal: leg === "guarantee" ? [{ eid: "W2026-11-09-" + tag, state: "done", incentives_after: 0 }] : [] });
    const o = { leg, tag, at: clock }, s = await R.setup(o);
    await C.setMode("monetary", "live", { by: "test", armedAt: at - 86400 });
    const total = (await P.total()).amount;
    const r = await R.tick(o);
    const run = r.evidence.runs.find((x) => x.engine === "monetary" && x.state === "done");
    assert.ok(run, JSON.stringify(r));
    assert.equal(R.reached(leg, JSON.parse(run.plan)), true);
    assert.equal((await P.total()).amount, total + s.preview.floor_mint);
    const count = r.evidence.moves.length;
    const again = await R.tick(o);
    assert.equal(again.evidence.moves.length, count);
    assert.equal((await P.total()).amount, total + s.preview.floor_mint);
    await assert.rejects(R.undo(o), /balances changed/);
  });
}
