// The H2a rehearsal kit (tools/policy-rehearse.js; runbook section 15) on a temp database: the guard (prod-shaped env / path,
// before SQLite loads), every forced state reached with a keyed zero-net setup between system pools only, the exact undo, retries,
// a crash mid-setup, the refusals, and the whole H2a sequence through the REAL scheduler (policy/scheduler.js): the shadow round
// (Pepe's boundary handshake + report - ok=1), the cutover, every leg live once (the floor mint, the floor cap binding, the
// guarantee, the ceiling, the Fort Knox overflow with a Fed loan, the burn), pause / resume, rollback, re-cutover.
//   NODE_PATH=G:/PATV/node_modules node --test test/policy-rehearse.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
const { spawnSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "policy-rehearsal-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "rehearsal-test";
process.env.PATV_ENV = "staging"; process.env.STAGING = "1";
const D = require(path.join(repo, "dbUtils"));
const P = require(path.join(repo, "pools"));
const C = require(path.join(repo, "policy", "core"));
const E = require(path.join(repo, "policy", "engines"));
const G = require(path.join(repo, "policy", "gather"));
const SCH = require(path.join(repo, "policy", "scheduler"));
const F = require(path.join(repo, "fed", "service"));
const CC = require(path.join(repo, "capital", "core"));
const S = require(path.join(repo, "stashes"));
const R = require(path.join(repo, "tools", "policy-rehearse"));
const TOOL = path.join(repo, "tools", "policy-rehearse.js");

const M = 1000000;
const T = (s) => Date.parse(s) / 1000;
const MON = T("2026-11-23T05:10:00Z");                 // a Monday (the epoch's day)
const TUE = T("2026-11-24T05:10:00Z");                 // November: the floor cap has 500,000 left (29.5M of 30M minted)
const DEC = T("2026-12-01T05:10:00Z");                 // a Tuesday in December: the floor cap's whole 30M
const REAL = Date.parse("2026-11-25T12:00:00Z");       // the tool's "real" clock (the 03:30-04:30 window, the real-time Fort Knox cap)
R._setRealNow(() => REAL);
// the Bank / Market-maker cash at the capital book's NAV (a far bigger cash would be swept by the epoch's waterfall)
const POOLS = { reserve: 60 * M, incentives: 120 * M, fortknox: 10 * M, heist: 3 * M, bank: 3 * M, mm: 1 * M, burn: 0, "room:r1": 5 * M, likeness: 1 * M };
const CFG = Object.assign({}, E.DEFAULTS, { fed_floor: 50 * M, fed_ceiling: 150 * M, incentive_guarantee_target: 25 * M, issuance_to_guarantee: false,
                                            fed_ceiling_action: "incentives", mintcap_floor: 30 * M, mintcap_total: -1 });
const PUSH = { econ_cfg: CFG, consts: E.CONSTS, flags: { layers: true, tr_live: true, ap_on: false }, tz: "America/New_York", skip: [],
               journal: [{ eid: "W2026-11-16", boundary: T("2026-11-16T04:00:00Z"), state: "done", incentives_after: 30 * M }],
               days_done: ["D2026-11-16", "D2026-11-17"], mo_days_done: ["D2026-11-16", "D2026-11-17"],
               burn_cfg: { mode: "accrual", accrual_every_min: 5 }, burn_inflight: 0 };
const opt = (leg, tag, at) => ({ leg, tag, at });
const sum = (q) => D.getQuery(q).then((r) => Number(Object.values(r[0])[0]) || 0);
const wallets = () => sum("SELECT COALESCE(SUM(points_balance), 0) FROM users");
const house = () => sum("SELECT COALESCE(SUM(amount), 0) FROM jackpot_rakes");
const pushCfg = (over = {}) => C.putCfg(Object.assign({}, PUSH, over));
/** The PAT the setup / undo must never touch: wallets, the House, the room vault, the escrow pool, the stashes. */
async function untouchable() {
  return { wallets: await wallets(), house: await house(), room: await P.balance("room:r1"), likeness: await P.balance("likeness"),
           stashes: (await S.total()).amount };
}

test.before(async () => {
  await D.runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                    points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT, casino_banned INTEGER DEFAULT 0)`);
  await D.runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await D.runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await D.runQuery("CREATE TABLE bonus_winners (bonusId TEXT PRIMARY KEY, type TEXT, userId TEXT, transactionId TEXT, amount INTEGER)");
  await D.runQuery("CREATE TABLE supply_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), pools TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await D.runQuery("CREATE TABLE econ_participation (room_id TEXT, day TEXT, login TEXT, lines INTEGER, mic_min REAL, active_min REAL, cmds INTEGER)");
  for (const [id, name, cf, pts] of [["u1", "fern", "fern_cf", 7000], ["u2", "gale", "gale_cf", 3000], ["ua", "owl", "owl_cf", 0]]) {
    await D.runQuery("INSERT INTO users (userId, username, password, points_balance, camfrogUsername, class) VALUES (?, ?, 'x', ?, ?, 'pleb')", [id, name, pts, cf]);
  }
  await D.runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES ('seed', 's', NULL, ?)", [20 * M]);
  await D.runQuery("INSERT INTO supply_snapshot (id, pools) VALUES (1, '[]')");
  await P.init();
  await require(path.join(repo, "funding")).init();
  await P._setMeta("enabled", true);
  const payload = JSON.stringify({ v: 1, source: "pepe", pools: POOLS, docs: {}, routes: {}, econ_cfg: {}, econ_cfg_log: [], catalog: {} });
  const r = await P.importFromPepe({ key: "pc-rehearsal-test", payload, digest: crypto.createHash("sha256").update(payload).digest("hex"),
                                     totals: { sum: Object.values(POOLS).reduce((a, b) => a + b, 0), count: Object.keys(POOLS).length, per_pool: POOLS } });
  assert.equal(r.ok, true, JSON.stringify(r));
  await S.init();
  await D.runQuery("INSERT INTO stash_meta (key, value) VALUES ('enabled', 'true')");
  const sp = JSON.stringify([{ id: "1", owner: "fern_cf", name: "nest", balance: 1000, staked: 0, earned: 0, members: [] },
                             { id: "2", owner: "gale_cf", name: "pot", balance: 0, staked: 0, earned: 0, members: [] }]);
  assert.equal((await S.importFromPepe({ payload: sp, digest: crypto.createHash("sha256").update(sp, "utf8").digest("hex"), total: 1000, count: 2, seq: 2 })).ok, true);
  await CC.init();
  await CC.putDoc("vaults", {
    v: { house: { total: 10 * M, holders: { protocol: 9.5 * M, s1: 400000.0, auto: 100000.0 }, basis: 8 * M },
         bank: { total: 3 * M, holders: { protocol: 3 * M }, basis: 2.5 * M },
         mm: { total: 1 * M, holders: { protocol: 1 * M }, basis: 1 * M } },
    auto: { total: 100000.0, holders: { s2: 100000.0 } }, queue: {}, epochs: [], seq: 0, inited: 1, insured: [] });
  await CC.setMeta("live", true);
  CC.forgetLive();
  // the Fed's books on the site (P4-1, as prod): November's floor mints 29.5M of the 30M cap, an open Fort Knox loan
  await F.init();
  await F.setMeta("live", true);
  F.forgetLive();
  const nov = [["floor-D2026-11-02", 5 * M, "2026-11-02T04:00:10Z"], ["floor-D2026-11-03", 5 * M, "2026-11-03T04:00:10Z"], ["floor-D2026-11-04", 5 * M, "2026-11-04T04:00:10Z"],
               ["floor-D2026-11-05", 5 * M, "2026-11-05T04:00:10Z"], ["floor-D2026-11-06", 5 * M, "2026-11-06T04:00:10Z"], ["floor-D2026-11-09", 4.5 * M, "2026-11-09T04:00:10Z"]];
  for (const [key, amount, ts] of nov) {
    const rec = { key, amount, policy: "floor", source: "floor", state: "done", dest: "reserve", ts: T(ts), done: T(ts), via: "pepe" };
    await D.runQuery("INSERT INTO fed_records (kind, key, rec, state, amount, source, month, ts, updated) VALUES ('mint', ?, ?, 'done', ?, 'floor', '2026-11', ?, ?)",
                     [key, JSON.stringify(rec), amount, T(ts), Date.now()]);
  }
  const loan = { id: "FL9", vault: "fortknox", principal: 400000, outstanding: 400000, state: "open", ts: T("2026-11-10T12:00:00Z") };
  await D.runQuery("INSERT INTO fed_records (kind, key, rec, state, amount, source, month, ts, updated) VALUES ('loan', 'FL9', ?, 'open', 400000, NULL, '2026-11', ?, ?)",
                   [JSON.stringify(loan), loan.ts, Date.now()]);
  await require(path.join(repo, "escrow", "ledger")).init();
  await C.init();
  await pushCfg();
});
test.after(async () => { await new Promise((resolve) => D.db.close(resolve)); });

// ── the guard ──
test("guard: PATV_ENV=staging + STAGING=1, an existing myapp.db, never prod's path, a prod-shaped folder or a link of prod's file", () => {
  const db = path.join(tmp, "myapp.db");
  const env = { PATV_ENV: "staging", STAGING: "1" };
  assert.equal(R.guard(db, env), fs.realpathSync(db));
  assert.throws(() => R.guard(db, { STAGING: "1" }), /PATV_ENV=staging/);
  assert.throws(() => R.guard(db, { PATV_ENV: "production", STAGING: "1" }), /PATV_ENV=staging/);
  assert.throws(() => R.guard(db, { PATV_ENV: "staging" }), /STAGING=1/);
  assert.throws(() => R.guard(db, { PATV_ENV: "staging", STAGING: "0" }), /STAGING=1/);
  assert.throws(() => R.guard(undefined, env), /--db/);
  assert.throws(() => R.guard(path.join(tmp, "absent", "myapp.db"), env), /is not there/);
  assert.throws(() => R.guard(tmp, env), /not a file/);
  const other = path.join(tmp, "other.db"); fs.writeFileSync(other, "");
  assert.throws(() => R.guard(other, env), /named myapp\.db/);
  for (const dir of ["PATV", "patv", "PATV-backups", "production", "prod", "prod-copy", "live", "Live_1"]) {
    const d = path.join(tmp, "shape", dir); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "myapp.db"), "");
    assert.throws(() => R.guard(path.join(d, "myapp.db"), env), /prod-shaped|prod's/, dir);
  }
  for (const dir of ["PATV-staging", "policy-rehearsal-1118", "prodigal", "lively"]) {
    const d = path.join(tmp, "ok", dir); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "myapp.db"), "");
    assert.equal(R.guard(path.join(d, "myapp.db"), env), fs.realpathSync(path.join(d, "myapp.db")), dir);
  }
  // prod's trees (here a stand-in folder): its database, its backups folder, anything under it
  const fakeProd = path.join(tmp, "home", "PATVX"); fs.mkdirSync(path.join(fakeProd, "backups"), { recursive: true });
  fs.writeFileSync(path.join(fakeProd, "myapp.db"), "prod"); fs.writeFileSync(path.join(fakeProd, "backups", "myapp.db"), "");
  const o = { prodDb: path.join(fakeProd, "myapp.db"), prodTrees: [fakeProd] };
  assert.throws(() => R.guard(path.join(fakeProd, "myapp.db"), env, o), /prod's/);
  assert.throws(() => R.guard(path.join(fakeProd, "backups", "myapp.db"), env, o), /prod's/);
  // a hard link of prod's file elsewhere is prod's file
  const hl = path.join(tmp, "hardlink"); fs.mkdirSync(hl);
  fs.linkSync(path.join(fakeProd, "myapp.db"), path.join(hl, "myapp.db"));
  assert.throws(() => R.guard(path.join(hl, "myapp.db"), env, { prodDb: path.join(fakeProd, "myapp.db"), prodTrees: [] }), /same inode/);
  // a symlink is judged by where it points
  const sl = path.join(tmp, "symlink"); fs.mkdirSync(sl);
  let linked = true;
  try { fs.symlinkSync(path.join(fakeProd, "myapp.db"), path.join(sl, "myapp.db")); } catch (e) { linked = false; }   // Windows without the privilege
  if (linked) assert.throws(() => R.guard(path.join(sl, "myapp.db"), env, o), /prod's/);
  // the real prod paths
  assert.throws(() => R.guard("/home/PATV/myapp.db", env), /is not there|prod/);
});
test("valid: the tag (a letter first, 3-8), the leg, an explicit --at, the margin", () => {
  for (const tag of ["ab", "1abc", "Abc", "abc-d", "abcdefghi", "", undefined]) assert.throws(() => R.valid({ leg: "floor", tag, at: TUE }), /--tag/, String(tag));
  assert.doesNotThrow(() => R.valid({ leg: "floor", tag: "h2af1", at: TUE }));
  assert.throws(() => R.valid({ leg: "everything", tag: "abc", at: TUE }), /--leg/);
  assert.throws(() => R.valid({ leg: "floor", tag: "abc", at: NaN }), /--at/);
  assert.throws(() => R.valid({ leg: "floor", tag: "abc", at: TUE, margin: 0 }), /--margin/);
  assert.throws(() => R.parseArgs(["setup", "--at=2026-11-24 05:10"]), /explicit UTC/);
  assert.throws(() => R.parseArgs(["setup", "--sql=drop"]), /unknown option/);
  assert.equal(R.parseArgs(["tick", "--at=2026-11-24T05:10:00Z", "--after-run"]).o.at, TUE);
});
test("the CLI refuses before SQLite loads: no database is created by a refusal", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-rehearsal-cli-"));
  const run = (args, env) => spawnSync(process.execPath, [TOOL, ...args], { cwd: dir, env: Object.assign({ PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, env), encoding: "utf8", timeout: 60000 });
  const a = run(["status", "--db=" + path.join(dir, "myapp.db")], { STAGING: "1" });
  assert.equal(a.status, 2, a.stderr); assert.match(a.stderr, /REFUSED: PATV_ENV=staging/);
  const b = run(["setup", "--db=" + path.join(dir, "myapp.db"), "--leg=floor", "--tag=abc", "--at=2026-11-24T05:10:00Z"], { PATV_ENV: "staging", STAGING: "1" });
  assert.equal(b.status, 2, b.stderr); assert.match(b.stderr, /is not there/);
  assert.deepEqual(fs.readdirSync(dir), [], "nothing created");
});

// ── setup / undo, leg by leg ──
const CASES = [
  ["floor", DEC, (r) => assert.deepEqual(r.legs, [["reserve", -(10 * M + R.MARGIN_DEFAULT)], ["incentives", 10 * M + R.MARGIN_DEFAULT]])],
  ["floorcap", TUE, (r) => { assert.equal(r.preview.floor_room, 500000); assert.equal(r.preview.floor_mint, 500000); assert.ok(r.preview.floor_need > 500000); }],
  ["ceiling", TUE, (r) => { assert.equal(r.after.reserve, 150 * M + R.MARGIN_DEFAULT); assert.equal(r.preview.excess, R.MARGIN_DEFAULT); assert.deepEqual(r.vault_cash, []); }],
  ["overflow", T("2026-11-26T05:10:00Z"), (r) => { assert.equal(r.after.fortknox, 15 * M + R.MARGIN_DEFAULT); }],
  ["burn", TUE, (r) => assert.equal(r.after.burn, R.BURN_AMOUNT)],
  ["guarantee", MON, (r) => { assert.equal(r.after.incentives, 0); assert.equal(r.preview.guarantee_want, 25 * M); }],
];
for (const [leg, at, check] of CASES) {
  test(`${leg}: the forced state reached by ONE keyed zero-net move between system pools, idempotent, exact undo`, async () => {
    const tag = "su" + leg.slice(0, 6);
    const before = await P.balances(), total = (await P.total()).amount, safe = await untouchable();
    const r = await R.setup(opt(leg, tag, at));
    assert.equal(r.result.ok, true);
    assert.ok(r.legs.length > 0);
    assert.ok(r.legs.every(([p]) => R.SOURCES.includes(p) || p === "burn"), JSON.stringify(r.legs));
    assert.equal(r.legs.reduce((t, [, n]) => t + n, 0), 0);
    check(r);
    assert.equal((await P.total()).amount, total, "supply unchanged");
    assert.deepEqual(await untouchable(), safe, "no wallet, House, room vault, escrow pool or stash touched");
    const mv = await D.getQuery("SELECT key, kind, flow, via, net FROM pool_moves WHERE key = ?", [r.key]);
    assert.deepEqual(mv, [{ key: `rehearse:${tag}:${leg}`, kind: "move", flow: "policy_rehearsal", via: "staging", net: 0 }]);
    const again = await R.setup(opt(leg, tag, at));
    assert.equal(again.dup, true);
    assert.deepEqual(await P.balances(), Object.assign({}, before, ...r.legs.map(([p]) => ({ [p]: r.after[p] }))));
    await assert.rejects(R.setup(opt(leg, tag, at + 86400)), /already bound/);
    const u = await R.undo(opt(leg, tag, at));
    assert.equal(u.exact, true);
    assert.deepEqual(await P.balances(), before, "every balance back to the PAT");
    assert.deepEqual(await untouchable(), safe);
    assert.equal((await R.undo(opt(leg, tag, at))).dup, true);
    const um = (await D.getQuery("SELECT kind, net FROM pool_moves WHERE key = ?", [r.key + ":undo"]))[0];
    assert.deepEqual(um, { kind: leg === "burn" ? "rollback" : "move", net: 0 });
    // a tag holds one exercise: after the undo it isn't reused
    await assert.rejects(R.setup(opt(leg === "floor" ? "ceiling" : "floor", tag, leg === "floor" ? TUE : DEC)), /one leg per tag/);
  });
}
test("the Bank / Market-maker cash is taken last, only when the other system pools can't cover it, and the receipt says so", async () => {
  await pushCfg({ econ_cfg: Object.assign({}, CFG, { fed_ceiling: 194 * M }) });       // 134.01M more: incentives, Fort Knox, the Casino vault, then the Bank
  try {
    const before = await P.balances();
    const r = await R.setup(opt("ceiling", "vcash", TUE));
    assert.deepEqual(r.legs, [["incentives", -120 * M], ["fortknox", -10 * M], ["heist", -3 * M], ["bank", -(1 * M + R.MARGIN_DEFAULT)], ["reserve", 134 * M + R.MARGIN_DEFAULT]]);
    assert.deepEqual(r.vault_cash, [["bank", -(1 * M + R.MARGIN_DEFAULT)]]);
    assert.ok((await R.status({ at: TUE, leg: "ceiling" })).summary.some((l) => /already there/.test(l)));
    assert.equal((await R.undo(opt("ceiling", "vcash", TUE))).exact, true);
    assert.deepEqual(await P.balances(), before);
  } finally { await pushCfg(); }
});
test("a state that is already there moves nothing - the receipt still records it", async () => {
  await pushCfg({ econ_cfg: Object.assign({}, CFG, { fed_floor: 70 * M }) });          // the Fed (60M) is under a 70M floor
  try {
    const r = await R.setup(opt("floor", "already", DEC));
    assert.deepEqual(r.legs, []);
    assert.equal(r.preview.floor_mint, 5 * M);
    assert.deepEqual(r.before, r.after);
    assert.equal((await D.getQuery("SELECT COUNT(*) AS n FROM pool_moves WHERE key LIKE 'rehearse:already:%'"))[0].n, 0);
    assert.equal((await R.undo(opt("floor", "already", DEC))).exact, true);
  } finally { await pushCfg(); }
});

// ── refusals ──
test("refusals: the wrong day, before the release hour, a cap that can't bind, no cap room, policy off, not enough system PAT", async () => {
  const before = await P.balances();
  await assert.rejects(R.setup(opt("floor", "rfa", MON)), /isn't a Monday|a Monday adds/);
  await assert.rejects(R.setup(opt("guarantee", "rfb", TUE)), /must be a Monday/);
  await assert.rejects(R.setup(opt("ceiling", "rfc", T("2026-11-24T04:40:00Z"))), /an hour past/);
  await assert.rejects(R.setup(opt("floorcap", "rfd", DEC)), /can't bind/);
  await pushCfg({ econ_cfg: Object.assign({}, CFG, { mintcap_floor: 29.5 * M }) });   // November's room: 0
  try {
    await assert.rejects(R.setup(opt("floor", "rfe", TUE)), /that is the floorcap leg/);
    const r = await R.setup(opt("floorcap", "zero", TUE));                               // the cap binds at 0
    assert.equal(r.preview.floor_mint, 0);
    await R.undo(opt("floorcap", "zero", TUE));
  } finally { await pushCfg(); }
  await pushCfg({ burn_cfg: { mode: "batch", accrual_every_min: 5 } });
  try { await assert.rejects(R.setup(opt("burn", "rfg", TUE)), /accrual/); } finally { await pushCfg(); }
  await pushCfg({ econ_cfg: Object.assign({}, CFG, { incentive_guarantee: false }) });
  try { await assert.rejects(R.setup(opt("guarantee", "rfh", MON)), /incentive_guarantee is off/); } finally { await pushCfg(); }
  await pushCfg({ econ_cfg: Object.assign({}, CFG, { fed_ceiling: 900 * M }) });
  try { await assert.rejects(R.setup(opt("ceiling", "rfi", TUE)), /not enough PAT in the system pools/); } finally { await pushCfg(); }
  await pushCfg({ econ_cfg: Object.assign({}, CFG, { fed_floor_mint_daily: 0 }) });
  try { await assert.rejects(R.setup(opt("floor", "rfj", DEC)), /fed_floor_mint_daily is 0/); } finally { await pushCfg(); }
  assert.deepEqual(await P.balances(), before, "nothing moved");
  assert.equal((await D.getQuery("SELECT COUNT(*) AS n FROM pool_moves WHERE key LIKE 'rehearse:rf%'"))[0].n, 0);
  assert.equal((await D.getQuery("SELECT COUNT(*) AS n FROM policy_meta WHERE key LIKE 'rehearse:rf%'"))[0].n, 0);
  // a tag whose periods exist already (an earlier rehearsal's) is refused
  await D.runQuery("INSERT INTO policy_sims (key, mode, engine, period, created, updated) VALUES ('shadow:monetary:D2026-11-24-usedtag', 'shadow', 'monetary', 'D2026-11-24-usedtag', 1, 1)");
  await assert.rejects(R.setup(opt("ceiling", "usedtag", TUE)), /already has periods/);
});
test("no write between 03:30 and 04:30 UTC (the real 04:00 runs)", async () => {
  R._setRealNow(() => Date.parse("2026-11-25T04:00:00Z"));
  try {
    await assert.rejects(R.setup(opt("ceiling", "win", TUE)), /03:30 and 04:30/);
    await assert.rejects(R.undo(opt("ceiling", "win", TUE)), /03:30 and 04:30/);
    await assert.rejects(R.tick(opt("ceiling", "win", TUE)), /03:30 and 04:30/);
    assert.ok((await R.status({ at: TUE })).summary.length > 0, "status is read only");
  } finally { R._setRealNow(() => REAL); }
  assert.equal(R.inWindow(Date.parse("2026-11-25T03:29:59Z")), false);
  assert.equal(R.inWindow(Date.parse("2026-11-25T03:30:00Z")), true);
  assert.equal(R.inWindow(Date.parse("2026-11-25T04:30:00Z")), false);
});

// ── crash / retry ──
test("a crash between the pool move and its receipt rolls both back; the retry runs once", async () => {
  const before = await P.balances(), save = C.setMeta;
  C.setMeta = async (key, value) => { if (key === "rehearse:crash:ceiling") throw new Error("injected interruption"); return save(key, value); };
  try { await assert.rejects(R.setup(opt("ceiling", "crash", TUE)), /injected interruption/); } finally { C.setMeta = save; }
  assert.deepEqual(await P.balances(), before);
  assert.equal(await P.moveStatus("rehearse:crash:ceiling"), null);
  assert.equal(await C.meta("rehearse:crash:ceiling"), null);
  assert.equal((await R.setup(opt("ceiling", "crash", TUE))).result.ok, true);
  assert.equal((await D.getQuery("SELECT COUNT(*) AS n FROM pool_moves WHERE key = 'rehearse:crash:ceiling'"))[0].n, 1);
  // the undo crashes after its move: rolled back, the receipt still active; the retry restores once
  C.setMeta = async (key, value) => { if (key === "rehearse:crash:ceiling" && value.undone) throw new Error("injected interruption"); return save(key, value); };
  try { await assert.rejects(R.undo(opt("ceiling", "crash", TUE)), /injected interruption/); } finally { C.setMeta = save; }
  assert.equal(await P.moveStatus("rehearse:crash:ceiling:undo"), null);
  assert.equal((await R.undo(opt("ceiling", "crash", TUE))).exact, true);
  assert.deepEqual(await P.balances(), before);
});
test("undo: refuses when the system pools moved (restore the copy); --after-run reverses only the setup's legs; never after a burn", async () => {
  const before = await P.balances();
  const o = opt("overflow", "drift", T("2026-11-26T05:10:00Z"));
  const r = await R.setup(o);
  await P.move({ key: "test-intervening-charge", legs: [["reserve", -10000], ["fortknox", 10000]], terminal: true });   // a !say-like charge lands
  await assert.rejects(R.undo(o), /moved since the setup.*fortknox/);
  const u = await R.undo(Object.assign({ afterRun: true }, o));
  assert.equal(u.exact, false);
  assert.deepEqual(u.left, { reserve: -10000, fortknox: 10000 }, "what is left is exactly the other move");
  assert.ok(u.explain.some((x) => x.key === "test-intervening-charge"));
  assert.deepEqual((await D.getQuery("SELECT legs FROM pool_moves WHERE key = ?", [r.key + ":undo"]))[0].legs, JSON.stringify(r.legs.map(([p, n]) => [p, -n]).sort((a, z) => a[1] - z[1])));
  await P.move({ key: "test-intervening-back", legs: [["fortknox", -10000], ["reserve", 10000]], terminal: true });
  assert.deepEqual(await P.balances(), before);
  // the burn: once the accrual burned the setup, giving it back would pay out of the burn reserve
  const b = opt("burn", "burnt", TUE);
  await R.setup(b);
  await P.move({ key: "burn:test-burnt", legs: [["burn", -R.BURN_AMOUNT]], kind: "burn", terminal: true });
  await assert.rejects(R.undo(Object.assign({ afterRun: true }, b)), /burn reserve moved/);
  assert.equal(await P.moveStatus("rehearse:burnt:burn:undo"), null);
  // (the copy is now 250,000 PAT lighter: the burn is final, as on staging)
});

// ── the scheduler ──
const pepe = async (engine, period, at, guarantee = false) => {
  // staging Pepe's run, as the site sees it: the boundary handshake BEFORE his legs, then his report (his inputs; here the site's own
  // at the same moment - the Python vectors prove the port, so his plan = SCH.planOf on them)
  const b = await SCH.boundary({ engine, period, now: at, guarantee });
  assert.equal(b.ok, true, JSON.stringify(b));
  const kind = SCH.kindOf(engine, period);
  const inputs = kind === "epoch" ? await G.epoch(at, period) : kind === "daily" ? await G.daily(at, period) : await G.monetary(at, period, guarantee);
  return SCH.report({ engine, period, inputs, plan: SCH.planOf(engine, inputs), cfg: { rev: 7, sha: "x", src: "site" } });
};
test("a tick in dry mode: the real scheduler at the tag, the site's plan recorded, no PAT, no test clock written, clocks restored", async () => {
  await C.setMode("monetary", "dry", { by: "test", armedAt: T("2026-11-01T00:00:00Z") });
  try {
    const o = opt("ceiling", "dryrun", TUE);
    await R.setup(o);
    const b0 = await P.balances();
    const r = await R.tick(o);
    assert.deepEqual(r.ran, ["dry monetary D2026-11-24-dryrun"]);
    assert.equal(r.modes.monetary, "dry");
    assert.ok(r.rows_written.policy_sims.some((x) => x.key === "dry:monetary:D2026-11-24-dryrun"));
    const sim = (await D.getQuery("SELECT site_plan FROM policy_sims WHERE key = 'dry:monetary:D2026-11-24-dryrun'"))[0];
    assert.equal(JSON.parse(sim.site_plan).excess, R.MARGIN_DEFAULT);
    assert.deepEqual(await P.balances(), b0);
    assert.equal(r.supply.delta, 0);
    assert.equal(await C.meta("test_clock"), null, "no test clock in the database");
    assert.ok(Math.abs(C.nowS() - Date.now() / 1000) < 5 && Math.abs(F.nowS() - Date.now() / 1000) < 5, "both clocks restored");
    assert.equal((await C.engines()).monetary.mode, "dry");
    assert.deepEqual((await R.tick(o)).ran, [], "recorded once");
    await R.undo(o);
  } finally { await C.setMode("monetary", "off", { by: "test" }); }
});

test("the H2a sequence: shadow (Pepe's handshake + report) -> cutover -> every leg live once -> pause / resume -> rollback -> re-cutover", async () => {
  const armed = T("2026-11-01T00:00:00Z");
  for (const e of C.ENGINES) await C.setMode(e, "shadow", { by: "test", armedAt: armed });
  // ── 1. the shadow round: Pepe runs each forced leg at its tag, the site compares against its boundary snapshot ──
  const shadow = [["floorcap", "sfc", TUE, [["monetary", "D2026-11-24-sfc"]]], ["ceiling", "sce", TUE, [["monetary", "D2026-11-24-sce"]]],
                  ["overflow", "sov", T("2026-11-26T05:10:00Z"), [["treasury", "D2026-11-26-sov"]]],
                  ["floor", "sfl", DEC, [["monetary", "D2026-12-01-sfl"]]],
                  ["guarantee", "sgu", MON, [["treasury", "W2026-11-23-sgu"], ["treasury", "D2026-11-23-sgu"], ["monetary", "D2026-11-23-sgu", true]]]];
  for (const [leg, tag, at, runs] of shadow) {
    const o = opt(leg, tag, at);
    await R.setup(o);
    for (const [engine, period, g] of runs) {
      const rep = await pepe(engine, period, at, !!g);
      assert.equal(rep.clean, true, `${leg} ${engine} ${period}: ${JSON.stringify(rep)}`);
    }
    const ins = await R.inspect(o);
    assert.ok(ins.verdict.some((l) => l.startsWith(`PASS shadow ${leg}:`)), ins.verdict.join("\n"));
    assert.ok(!ins.verdict.some((l) => /^FAIL/.test(l)), ins.verdict.join("\n"));
    assert.ok(ins.summary.some((l) => /pepe /.test(l)), "the site's plan printed next to Pepe's");
    assert.equal((await R.undo(o)).exact, true, "the simulated Pepe moved nothing: exact undo");
  }
  // a shadow comparison that isn't clean reads FAIL (Pepe planned on another Fort Knox)
  const o2 = opt("overflow", "sbad", T("2026-11-26T05:10:00Z"));
  await R.setup(o2);
  await SCH.boundary({ engine: "treasury", period: "D2026-11-26-sbad", now: o2.at });
  const inp = await G.daily(o2.at, "D2026-11-26-sbad");
  inp.pools.fortknox += 10000;
  await SCH.report({ engine: "treasury", period: "D2026-11-26-sbad", inputs: inp, plan: SCH.planOf("treasury", inp) });
  assert.ok((await R.inspect(o2)).verdict.some((l) => /^FAIL shadow overflow: .*NOT clean: .*fortknox/.test(l)));
  await R.undo(o2);

  // ── 2. the cutover (Pepe's handshake): nothing moves, his periods are handed ──
  const snap = await R.snapshot();
  const handover = { treasury: { armed_at: armed, done: [{ period: "W2026-11-16", boundary: T("2026-11-16T04:00:00Z"), incentives_after: 30 * M }, { period: "D2026-11-16" }, { period: "D2026-11-17" }] },
                     monetary: { armed_at: armed, done: [{ period: "D2026-11-16" }, { period: "D2026-11-17" }] }, burn: { armed_at: armed, done: [] } };
  const cut = await SCH.cutover({ key: "pc-h2areh-1", engines: C.ENGINES, actor: "owl", handover });
  assert.equal(cut.ok, true, JSON.stringify(cut));
  const snapFile = path.join(tmp, "before-cutover.json");
  fs.writeFileSync(snapFile, JSON.stringify(snap));
  // live activity between the snapshot and the check (staging after a real cutover): a charge, and - the engines being live now -
  // the site's own burn accrual burning what reached the burn reserve. Neither is the hand-over's: INFO, and the supply reconciles
  const A0 = require(path.join(repo, "policy", "apply"));
  assert.equal((await P.move({ key: "charge:rt-test-cutcheck", legs: [["reserve", -10000], ["fortknox", 10000]], terminal: true })).ok, true);
  assert.equal((await P.move({ key: "test-cutcheck-to-burn", legs: [["reserve", -5000], ["burn", 5000]], terminal: true })).ok, true);
  assert.equal((await A0.runBurn("A999999990", Date.now() / 1000)).amount, 5000);
  const cc = await R.cutcheck({ before: snapFile });
  assert.deepEqual(cc.summary.filter((l) => l.startsWith("FAIL")), [], cc.summary.join("\n"));
  assert.ok(cc.summary.some((l) => /^INFO since the snapshot: the site's live burn accrual burned 5,000 PAT/.test(l)), cc.summary.join("\n"));
  assert.ok(cc.summary.some((l) => /^INFO since the snapshot, other live activity: .*charges 1/.test(l)), cc.summary.join("\n"));
  assert.ok(cc.summary.some((l) => /^PASS supply reconciled: .*burned 5,000 since the snapshot$/.test(l)), cc.summary.join("\n"));
  // a leg of a period Pepe handed (the site moving D2026-11-17 again) is the hand-over's: FAIL
  await P.move({ key: "mo-D2026-11-17-guarantee:in", legs: [["reserve", -1], ["incentives", 1]], via: "policy", terminal: true });
  const bad = await R.cutcheck({ before: snapFile });
  assert.ok(bad.summary.some((l) => /^FAIL the cutover wrote no PAT row: .*mo-D2026-11-17-guarantee:in: a leg of D2026-11-17, a period Pepe handed/.test(l)), bad.summary.join("\n"));
  await P.move({ key: "test-cutcheck-back", legs: [["incentives", -1], ["reserve", 1]], terminal: true });

  // ── 3. every leg live, once, through the real scheduler at its tag ──
  const live = async (leg, tag, at, more = () => {}, { executed = true, margin } = {}) => {
    const o = Object.assign(opt(leg, tag, at), margin ? { margin } : {});
    await R.setup(o);
    const safe = await untouchable();
    const r = await R.tick(o);
    assert.ok(r.ran.length, `${leg}: ${r.summary.join("\n")}`);
    assert.ok(r.verdict.some((l) => l.startsWith(`PASS live ${leg}:`) || (leg === "burn" && l.startsWith("PASS burn:"))), r.verdict.join("\n"));
    assert.ok(!r.verdict.some((l) => /^FAIL/.test(l)), r.verdict.join("\n"));
    assert.equal(r.supply.note, "reconciled", JSON.stringify(r.supply));
    await more(r, safe);
    const again = await R.tick(o);
    assert.deepEqual(again.ran, [], `${leg}: a retry runs nothing`);
    assert.equal(again.rows_written.pool_moves, undefined, `${leg}: a retry moves nothing`);
    if (executed) await assert.rejects(R.undo(o), /moved since the setup|burn reserve/, "an executed leg is never reversed by a plain undo");
    else assert.equal((await R.undo(o)).exact, true, "nothing moved: the receipt closes exactly");
    return r;
  };
  await live("floor", "lfl", DEC, async (r) => {
    assert.equal(r.supply.delta, R.MARGIN_DEFAULT, "the supply rose by the mint");
    const rec = (await D.getQuery("SELECT month, amount, state FROM fed_records WHERE kind = 'mint' AND key = 'floor-D2026-12-01-lfl'"))[0];
    assert.deepEqual(rec, { month: "2026-12", amount: R.MARGIN_DEFAULT, state: "done" }, "journaled in the test clock's month (fed clock aligned)");
  });
  await live("floorcap", "lfc", TUE, async (r) => {
    assert.equal(r.supply.delta, 500000, "only the room left");
    assert.ok((await D.getQuery("SELECT 1 FROM policy_effects WHERE key = 'cap_hit:floor-2026-11'")).length, "the cap notice");
  });
  // the cap now has 0 left: the next day mints nothing, the cap still binds
  await live("floorcap", "lfz", T("2026-11-25T05:10:00Z"), async (r) => { assert.equal(r.supply.delta, 0); }, { executed: false });
  await assert.rejects(R.setup(opt("floor", "lfn", T("2026-11-27T05:10:00Z"))), /that is the floorcap leg/);
  await live("guarantee", "lgu", MON, async (r, safe) => {
    assert.ok(r.ran.includes("treasury W2026-11-23-lgu") && r.ran.includes("treasury D2026-11-23-lgu") && r.ran.includes("monetary D2026-11-23-lgu"), r.ran.join(", "));
    assert.ok(r.ran.indexOf("treasury W2026-11-23-lgu") < r.ran.indexOf("monetary D2026-11-23-lgu"), "the epoch first");
    const run = (await D.getQuery("SELECT result FROM policy_runs WHERE key = 'monetary:D2026-11-23-lgu'"))[0];
    assert.ok(JSON.parse(run.result).guarantee_paid > 0);
    void safe;
  });
  await live("ceiling", "lce", TUE, async (r) => {
    assert.equal(r.supply.delta, 0);
    const mv = await D.getQuery("SELECT key, net, legs FROM pool_moves WHERE key LIKE 'mo-D2026-11-24-lce-ceiling:%' ORDER BY key");
    assert.deepEqual(mv.map((x) => [x.key, JSON.parse(x.legs)]), [["mo-D2026-11-24-lce-ceiling:in", [["incentives", R.MARGIN_DEFAULT]]], ["mo-D2026-11-24-lce-ceiling:out", [["reserve", -R.MARGIN_DEFAULT]]]]);
  });
  await live("overflow", "lov", T("2026-11-26T05:10:00Z"), async (r) => {
    const legs = (await D.getQuery("SELECT key FROM pool_moves WHERE key LIKE 'tr-D2026-11-26-lov-fkover%' ORDER BY key")).map((x) => x.key);
    assert.deepEqual(legs, ["tr-D2026-11-26-lov-fkover-loan:in", "tr-D2026-11-26-lov-fkover-loan:out", "tr-D2026-11-26-lov-fkover:in", "tr-D2026-11-26-lov-fkover:out"], "the Fed loan first");
    const loan = JSON.parse((await D.getQuery("SELECT rec FROM fed_records WHERE kind = 'loan' AND key = 'FL9'"))[0].rec);
    assert.equal(loan.state, "repaid");
  }, { margin: 1000000 });
  await live("burn", "lbu", TUE, async (r) => {
    assert.equal(r.supply.delta, -R.BURN_AMOUNT, "the supply fell by the burned PAT");
    assert.ok((await D.getQuery("SELECT 1 FROM pat_burns WHERE amount = ?", [R.BURN_AMOUNT])).length);
  });
  // the staging site's own accrual may burn first (its real slot): the verdict still reads the burn since the setup
  const ob = opt("burn", "lbx", TUE);
  await R.setup(ob);
  const A = require(path.join(repo, "policy", "apply"));
  assert.ok((await A.runBurn("A999999999", Date.now() / 1000)).amount >= R.BURN_AMOUNT);
  const rb = await R.tick(ob);
  assert.deepEqual(rb.ran, []);
  assert.ok(rb.verdict.some((l) => /^PASS burn: .*by the accrual on its real slot/.test(l)), rb.verdict.join("\n"));

  // ── 4. pause (the owner's kill switch, Pepe not needed): a tagged tick runs nothing; resume: it runs ──
  const who = { by: "owl (cli)", auditId: "cli:owl", via: "cli", note: "H2a rehearsal" };
  await SCH.setPause(C.ENGINES, true, who);
  const op = opt("ceiling", "lpa", T("2026-11-27T05:10:00Z"));
  await R.setup(op);
  const b0 = await P.balances();
  const pz = await R.tick(op);
  assert.deepEqual(pz.ran, []);
  assert.ok(pz.summary[1].includes("paused"), pz.summary[1]);
  assert.deepEqual(await P.balances(), b0, "nothing moved while paused");
  assert.equal((await D.getQuery("SELECT COUNT(*) AS n FROM policy_runs WHERE period LIKE '%-lpa'"))[0].n, 0, "a tagged tick records nothing while paused");
  await SCH.setPause(C.ENGINES, false, who);
  const rz = await R.tick(op);
  assert.deepEqual(rz.ran, ["monetary D2026-11-27-lpa"]);
  assert.ok(rz.verdict.some((l) => l.startsWith("PASS live ceiling:")), rz.verdict.join("\n"));

  // ── 5. rollback: back to shadow, the site's periods answered to Pepe ──
  const rb2 = await SCH.rollback({ key: "pr-h2areh-1", engines: C.ENGINES, actor: "owl" });
  assert.equal(rb2.ok, true, JSON.stringify(rb2));
  assert.deepEqual(Object.values(await C.engines()).map((e) => e.mode), ["shadow", "shadow", "shadow"]);
  for (const p of ["D2026-12-01-lfl", "D2026-11-24-lfc", "D2026-11-23-lgu", "D2026-11-24-lce", "D2026-11-27-lpa"]) assert.ok(rb2.ran.monetary.some((x) => x.period === p), p);
  for (const p of ["W2026-11-23-lgu", "D2026-11-23-lgu", "D2026-11-26-lov"]) assert.ok(rb2.ran.treasury.some((x) => x.period === p), p);
  assert.ok(rb2.effects.length > 0, "the effects Pepe applies on the way back");
  // shadow again: a fresh tag compares clean
  const os1 = opt("ceiling", "sre", T("2026-11-27T05:10:00Z"));
  await R.setup(os1);
  assert.equal((await pepe("monetary", "D2026-11-27-sre", os1.at)).clean, true);
  assert.ok((await R.inspect(os1)).verdict.some((l) => l.startsWith("PASS shadow ceiling:")));
  await R.undo(os1);

  // ── 6. re-cutover: a fresh tag runs live once ──
  const again = Object.fromEntries(C.ENGINES.map((e) => [e, { armed_at: armed, done: [] }]));
  assert.equal((await SCH.cutover({ key: "pc-h2areh-2", engines: C.ENGINES, actor: "owl", handover: again })).ok, true);
  await live("ceiling", "lrc", T("2026-12-02T05:10:00Z"));
  await live("floor", "lrf", T("2026-12-03T05:10:00Z"));
  // finally: back to shadow (as the runbook leaves staging)
  assert.equal((await SCH.rollback({ key: "pr-h2areh-2", engines: C.ENGINES, actor: "owl" })).ok, true);
});

test("overflow: Fort Knox is put over the REAL clock's cap too - staging Pepe's inject `daily` plans at the real time, not --at", async () => {
  // staging Pepe's _p4_inject runs `daily` as self._tr_daily("rehearsal", did): the period id from --at, the plan (and its boundary
  // handshake) at the real time. A scaled Fort Knox cap (heist_cap_mode pct: 60% of the week's guarantee target) differs between
  // weeks: here the real clock's week (11-23) has a 10M issuance mint in the week before it (issuance_to_guarantee), --at's week
  // (11-30) none - the real cap is the higher one
  const at = T("2026-12-02T05:10:00Z"), did = "D2026-12-02-fkreal", realS = REAL / 1000;
  const iss = { key: "iss-test-fkreal", amount: 10 * M, policy: "issuance", source: "issuance", state: "done", dest: "reserve", ts: T("2026-11-20T12:00:00Z") };
  await D.runQuery("INSERT INTO fed_records (kind, key, rec, state, amount, source, month, ts, updated) VALUES ('mint', ?, ?, 'done', ?, 'issuance', '2026-11', ?, ?)",
                   [iss.key, JSON.stringify(iss), iss.amount, iss.ts, Date.now()]);
  await pushCfg({ econ_cfg: Object.assign({}, CFG, { issuance_to_guarantee: true }) });
  try {
    for (const e of ["treasury"]) assert.equal((await C.engines())[e].mode, "shadow");
    const capOf = async (nowS) => { const inp = await G.daily(nowS, did); return E.heistCap(inp, E.C(inp), "fortknox", nowS); };
    const capAt = await capOf(at), capReal = await capOf(realS);
    assert.equal(capAt, 15 * M);
    assert.equal(capReal, 21 * M, "the real week's target is 35M: its Fort Knox cap is the higher one");
    const o = opt("overflow", "fkreal", at);
    const r = await R.setup(o);
    assert.equal(r.after.fortknox, capReal + R.MARGIN_DEFAULT, "over both caps: the real clock's");
    // Pepe as the real bot runs it: the handshake and his gather at the REAL time, the period id from --at
    const b = await SCH.boundary({ engine: "treasury", period: did, now: realS });
    assert.equal(b.ok, true, JSON.stringify(b));
    const inputs = await G.daily(realS, did);
    const rep = await SCH.report({ engine: "treasury", period: did, inputs, plan: SCH.planOf("treasury", inputs), cfg: { rev: 7, sha: "x", src: "site" } });
    assert.equal(rep.clean, true, JSON.stringify(rep));
    assert.ok(SCH.planOf("treasury", inputs).overflow > 0, "Pepe's real-clock plan reaches the overflow");
    const ins = await R.inspect(o);
    assert.ok(ins.verdict.some((l) => l.startsWith("PASS shadow overflow:")), ins.verdict.join("\n"));
    assert.equal((await R.undo(o)).exact, true);
  } finally {
    await pushCfg();
    await D.runQuery("DELETE FROM fed_records WHERE key = 'iss-test-fkreal'");
  }
});

test("notices: the copy's Telegram reach - status WARNs, guarantee / overflow setups refuse unless --allow-notices, a tick queues no alert", async () => {
  const TG = require(path.join(repo, "telegram"));
  const inbox = require(path.join(repo, "inbox"));
  await TG.init();
  const outbox = () => D.getQuery("SELECT kind, ref FROM telegram_outbox WHERE user_id = 'u1' ORDER BY id");
  const settle = () => new Promise((r) => setTimeout(r, 400));          // telegram.onNotice is fire-and-forget
  assert.deepEqual(await R.noticeRisk(), { links: 0, unsent: 0 });
  assert.ok(!(await R.status({ at: MON })).summary.some((l) => /Telegram/.test(l)));
  // a member linked on prod (the refresh keeps telegram_links) who wants staking alerts
  await D.runQuery("INSERT INTO telegram_links (user_id, tg_id, handle, linked_at) VALUES ('u1', '700001', 'fernt', ?)", [Date.now()]);
  await D.runQuery("INSERT INTO telegram_prefs (user_id, kind, on_) VALUES ('u1', 'staking', 1)");
  try {
    // the link works: a notice filed outside the tool becomes an alert (what the staging site / staging Pepe's runs would queue)
    assert.equal(await inbox.add("u1", { kind: "staking", title: "Staking payout: +1 PAT", ref: "wf:test-tg-outside:s1" }), true);
    for (let i = 0; i < 30 && !(await outbox()).length; i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual((await outbox()).map((x) => x.ref), ["n:wf:test-tg-outside:s1"]);
    assert.deepEqual(await R.noticeRisk(), { links: 1, unsent: 1 });
    const st = await R.status({ at: MON });
    assert.ok(st.summary.some((l) => /^WARN this copy holds 1 Telegram link\(s\), 1 unsent Telegram alert\(s\)/.test(l)), st.summary.join("\n"));
    // guarantee / overflow (a tagged epoch: staking notices) refuse - nothing moved; the other legs don't notify
    const b0 = await P.balances();
    await assert.rejects(R.setup(opt("guarantee", "tgref", MON)), /Telegram link\(s\).*--allow-notices - nothing moved/);
    await assert.rejects(R.setup(opt("overflow", "tgreo", T("2026-11-26T05:10:00Z"))), /Telegram/);
    assert.deepEqual(await P.balances(), b0);
    assert.equal(await C.meta("rehearse:tgref:guarantee"), null);
    const o = Object.assign(opt("guarantee", "tgok", MON), { allowNotices: true });
    await R.setup(o);
    assert.equal(R.parseArgs(["setup", "--allow-notices"]).o.allowNotices, true);
    // the tool's own tick files the notice but queues no alert (here: a notice filed during the pass)
    const save = SCH.pass;
    SCH.pass = async (...a) => { await inbox.add("u1", { kind: "staking", title: "Staking payout: +2 PAT", ref: "wf:test-tg-tick:s1" }); return save(...a); };
    try { await R.tick(o); } finally { SCH.pass = save; }
    await settle();
    assert.equal((await D.getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = 'u1' AND ref = 'wf:test-tg-tick:s1'"))[0].n, 1, "the inbox notice is filed");
    assert.deepEqual((await outbox()).map((x) => x.ref), ["n:wf:test-tg-outside:s1"], "no alert queued by the tick");
    assert.equal(typeof TG.onNotice, "function");
    assert.notEqual(TG.onNotice.toString(), "() => {}", "telegram restored after the tick");
    await R.undo(o);
  } finally {
    await D.runQuery("DELETE FROM telegram_links WHERE user_id = 'u1'");
    await D.runQuery("DELETE FROM telegram_prefs WHERE user_id = 'u1'");
    await D.runQuery("DELETE FROM telegram_outbox WHERE user_id = 'u1'");
  }
  assert.deepEqual(await R.noticeRisk(), { links: 0, unsent: 0 });
});

test("status lists the setups still open (WARN; FAIL from 02:30 to 04:30 UTC, exit 3) - a burn setup only until it is burned", async () => {
  const o = opt("ceiling", "openx", T("2026-11-27T05:10:00Z"));
  await R.setup(o);
  try {
    const s = await R.status({});
    const line = s.summary.find((l) => l.startsWith("open setup rehearse:openx:ceiling "));
    assert.ok(line, s.summary.join("\n"));
    assert.match(line, /moved .*reserve \+/);
    assert.match(line, /undo --leg=ceiling --tag=openx --at=2026-11-27T05:10:00Z$/);
    assert.ok(s.summary.some((l) => /^WARN \d+ open setup\(s\): the real 04:00 UTC run acts on a forced state/.test(l)));
    assert.ok(!s.summary.some((l) => l.startsWith("FAIL")));
    assert.ok(s.open_setups.some((x) => x.key === "rehearse:openx:ceiling" && x.ran === false));
    R._setRealNow(() => Date.parse("2026-11-25T02:45:00Z"));
    try {
      const n = await R.status({});
      assert.ok(n.summary.some((l) => /^FAIL \d+ open setup\(s\): .*less than an hour and a half away/.test(l)), n.summary.join("\n"));
    } finally { R._setRealNow(() => REAL); }
    assert.equal(R.nearRun(Date.parse("2026-11-25T02:29:59Z")), false);
    assert.equal(R.nearRun(Date.parse("2026-11-25T02:30:00Z")), true);
    assert.equal(R.nearRun(Date.parse("2026-11-25T04:30:00Z")), false);
  } finally { await R.undo(o); }
  assert.ok(!(await R.status({})).summary.some((l) => l.startsWith("open setup rehearse:openx:")), "closed by the undo");
  // a burn setup whose PAT was burned is not open (the burn is final; its undo is refused)
  assert.ok(!(await R.openSetups()).some((x) => x.key === "rehearse:burnt:burn"), "the earlier test's burnt setup was burned");
  const ob = opt("burn", "openb", TUE);
  await R.setup(ob);
  assert.ok((await R.openSetups()).some((x) => x.key === "rehearse:openb:burn"));
  const A = require(path.join(repo, "policy", "apply"));
  await C.setMode("burn", "live", { by: "test" });
  try { assert.ok((await A.runBurn("A999999980", Date.now() / 1000)).amount >= R.BURN_AMOUNT); } finally { await C.setMode("burn", "shadow", { by: "test" }); }
  assert.ok(!(await R.openSetups()).some((x) => x.key === "rehearse:openb:burn"), "burned: no longer open");
});

test("status (read only): every leg's setup and plan at a clock, nothing written", async () => {
  const n0 = (await D.getQuery("SELECT COUNT(*) AS n FROM pool_moves"))[0].n;
  const s = await R.status({ at: TUE });
  assert.ok(s.summary.some((l) => /^leg floorcap +reachable/.test(l)), s.summary.join("\n"));
  assert.ok(s.summary.some((l) => /^leg guarantee +refused at .*must be a Monday/.test(l)));
  assert.ok(s.summary.some((l) => /^leg floor +(refused|reachable)/.test(l)));
  assert.ok(s.legs.ceiling.legs.length > 0);
  assert.equal((await D.getQuery("SELECT COUNT(*) AS n FROM pool_moves"))[0].n, n0);
  assert.equal(await C.meta("rehearse:status:floor"), null);
});

test("the CLI end to end in its own process (no SECRET_KEY): status, setup, inspect, undo on this database", async (t) => {
  if (R.inWindow(Date.now())) return t.skip("the real clock is in the 03:30-04:30 UTC window: the CLI refuses writes then");
  const db = path.join(tmp, "myapp.db");
  const run = (args) => spawnSync(process.execPath, [TOOL, ...args, "--db=" + db], { cwd: os.tmpdir(), encoding: "utf8", timeout: 120000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PATV_ENV: "staging", STAGING: "1", NODE_PATH: process.env.NODE_PATH || "" } });
  const st = run(["status", "--at=2026-12-08T05:10:00Z"]);
  // (this database keeps the executed legs' setups open: from 02:30 UTC status FAILs on them - exit 3)
  assert.ok(st.status === 0 || (st.status === 3 && R.nearRun(Date.now()) && /^FAIL \d+ open setup/m.test(st.stdout)), st.stderr + st.stdout);
  assert.match(st.stdout, /^open setup rehearse:/m);
  assert.match(st.stdout, /^leg ceiling +reachable/m);
  const before = await P.balances();
  const su = run(["setup", "--leg=ceiling", "--tag=clia", "--at=2026-12-08T05:10:00Z", "--json"]);
  assert.equal(su.status, 0, su.stderr + su.stdout);
  assert.equal(JSON.parse(su.stdout).result.ok, true);
  const ins = run(["inspect", "--tag=clia"]);
  assert.equal(ins.status, 0, ins.stderr);
  assert.match(ins.stdout, /move rehearse:clia:ceiling \(move, policy_rehearsal\) net 0/);
  const un = run(["undo", "--leg=ceiling", "--tag=clia", "--at=2026-12-08T05:10:00Z"]);
  assert.equal(un.status, 0, un.stderr + un.stdout);
  assert.deepEqual(await P.balances(), before);
  const bad = run(["tick", "--leg=ceiling", "--tag=clia", "--at=2026-12-08T05:10:00Z"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /REFUSED: .*was undone/);
});
