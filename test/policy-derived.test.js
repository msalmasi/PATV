// PO-4 (economy policy -> site plan, "Phase 6"): the derived state and its daily dual read (policy/derived.js gather + derive,
// policy/scheduler.js derivedPass), SHADOW ONLY - it compares Pepe's capital push (targets, fl_room, credit, flows) with the
// site's own derivation and writes one policy_sims row a day ("shadow:derived:D<date>"); it moves no PAT and no decision reads it.
//   * gather: the site's tables (capital records, pools, the bank-lent samples + a site effect, the Fed's journal, the site-owned
//     settings) give hand-checked numbers; a push carrying other targets / fl_room / credit / flows is never read; a config error
//     is a blocking attempt that never throws out of pass()
//   * the dual read: clean after 1 attempt; a stable difference (same list + fingerprint twice) final not clean; state that moved
//     then a clean attempt -> clean, the earlier attempt noted; a flows-only difference whitelisted; no fresh push all day; nothing
//     before 04:30 / the cut-off; the test clock (untagged: nothing; a tag: D...-<tag>); a final row never rewritten; a stale
//     funding sync not compared; (review of PO-4) after an outage across more than one day boundary the older open days close
//     too, a tagged rehearsal row aside; the gather book carries every one of Pepe's loan / market filters
//   * flows is display-only (the WHITELIST's proof): no reader of `.flows` but the cut-off's snapshot, publish's epochs and
//     staking.js clean; two cut-offs whose flows differ write the same PAT rows
//   * PO-4 moves NO PAT: a day of derived + digest passes leaves wallets, pools, the House and the stashes as they were, writes no
//     policy_runs / policy_effects row, no inbox row and no ops alert
//   NODE_PATH=G:/PATV/node_modules node --test test/policy-derived.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "policy-derived-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const DB = require(path.join(repo, "dbUtils"));
const { runQuery, getQuery, tx } = DB;
const P = require(path.join(repo, "pools"));
const ES = require(path.join(repo, "econstore"));
const ST = require(path.join(repo, "stashes"));
const CC = require(path.join(repo, "capital", "core"));
const CS = require(path.join(repo, "capital", "service"));
const V = require(path.join(repo, "capital", "vaults"));
const C = require(path.join(repo, "policy", "core"));
const E = require(path.join(repo, "policy", "engines"));
const D = require(path.join(repo, "policy", "derived"));
const PC = require(path.join(repo, "policy", "config"));
const SCH = require(path.join(repo, "policy", "scheduler"));
const F = require(path.join(repo, "fed", "service"));
const FUND = require(path.join(repo, "funding"));
const CR = require(path.join(repo, "credit"));
const FX = require("./fixtures/policycfg");
const OPS = require(path.join(repo, "opsalerts"));

const alerts = [];
OPS.alert = async (a) => { alerts.push(a); return { admins: 0 }; };
const M = 1000000;
const POOLS = { reserve: 53 * M, bank: 22900000, mm: 9200000, fortknox: 15500000, heist: 1700000, incentives: 9300000, vaultfloat: 50000 };
const HOUSE = 20 * M;
const day = (y, m, d, h = 0, mi = 0, s = 0) => Date.UTC(y, m - 1, d, h, mi, s) / 1000;
const MON = day(2026, 11, 9);                    // Monday 2026-11-09 00:00 UTC
let real = day(2026, 11, 9, 4, 40);              // the real clock (capital pushes are stamped with it)
SCH._setRealClock(() => real);

let base, server;
const bot = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot" }, body)) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const row = async (D0) => (await getQuery("SELECT * FROM policy_sims WHERE key = ?", [`shadow:derived:${D0}`]))[0] || null;
const parse = (s) => JSON.parse(s);

// the site's capital book: a bank-funded loan with 88,000 out, LMSR markets seeded 800,000 from the Market maker
async function seedBook() {
  await CC.save("loan", { id: 1, status: "active", funded_by: "bank", principal: 100000, paid: 12000, owed: 103000, borrower: "loaner_a" });
  await CC.save("loan", { id: 2, status: "active", funded_by: "reserve", principal: 500000, paid: 0, owed: 500000, borrower: "loaner_b" });
  await CC.save("loan", { id: 3, status: "active", funded_by: "bank", principal: 300000, paid: 0, owed: 300000, insured: true, borrower: "loaner_c" });
  await CC.save("loan", { id: 4, status: "repaid", funded_by: "bank", principal: 70000, paid: 70000, owed: 0, borrower: "loaner_d" });
  await CC.save("market", { id: 11, status: "open", model: "lmsr", seed_from: "mm", seed: 765341, b: 1000.0, q: { yes: 10.0, no: 0.0 }, pool: 765341.0, options: ["yes", "no"] });
  await CC.save("market", { id: 12, status: "open", model: "lmsr", seed_from: "mm", seed: 34659, b: 100.0, q: { yes: 0.0, no: 0.0 }, pool: 34659.0, options: ["yes", "no"] });
  await CC.save("market", { id: 13, status: "open", model: "lmsr", seed_from: "reserve", seed: 999999, b: 100.0, q: { yes: 0.0, no: 0.0 }, pool: 999999.0, options: ["yes", "no"] });
  await CC.save("market", { id: 14, status: "resolved", model: "lmsr", seed_from: "mm", seed: 555555, b: 100.0, q: { yes: 0.0, no: 0.0 }, pool: 0.0, options: ["yes", "no"] });
  // review of PO-4: the rest of Pepe's filters - a written-off loan, a paid-out market and an AMM market count for nothing
  await CC.save("loan", { id: 5, status: "active", funded_by: "bank", principal: 200000, paid: 0, owed: 200000, written_off: true, borrower: "loaner_e" });
  await CC.save("market", { id: 15, status: "settling", model: "lmsr", seed_from: "mm", seed: 111111, b: 100.0, q: { yes: 0.0, no: 0.0 }, pool: 111111.0, options: ["yes", "no"], paid_out: true });
  await CC.save("market", { id: 16, status: "open", model: "amm", seed_from: "mm", seed: 222222, pool: 222222.0, options: ["yes", "no"] });
}
async function setCutoff(ts) {
  const d = await V.load();
  d.epochs = [{ ts, price: { bank: 1, house: 1, mm: 1, auto: 1 }, nav: {}, staked: {} }];
  await V.store(d);
}
/** Pepe's capital push as he'd build it NOW (the site's own values, i.e. a Pepe that agrees), stamped `at`, with `over` on top. */
async function pushAt(at, over = {}) {
  const v = D.derive(await D.gather(at));
  const body = FX.capitalPush(Object.assign({ rloan_base: 12000, rloan_per_level: 2500, targets: v.targets, fl_room: v.fl_room,
                                              flash: { bank: true, mm: true, room: v.fl_room }, credit: v.credit, flows: v.flows }, over));
  assert.equal((await CS.putConfig(body)).ok, true);
  const m = await CC.meta("cfg");
  m.at = at;
  await CC.setMeta("cfg", m);
  return v;
}
async function info(nowS, tag) { return SCH.clockInfo(nowS, tag); }
async function passAt(nowS, tag = null) { return SCH.derivedPass(nowS, await info(nowS, tag)); }

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT, casino_banned INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE bonus_winners (bonusId TEXT PRIMARY KEY, type TEXT, userId TEXT, transactionId TEXT, amount INTEGER)");
  await runQuery("CREATE TABLE supply_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), pools TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  for (const [id, name, cf] of [["u1", "ann", "ann_cf"], ["u2", "bob", "bob_cf"]]) {
    await runQuery("INSERT INTO users (userId, username, password, points_balance, camfrogUsername) VALUES (?, ?, 'x', 1000, ?)", [id, name, cf]);
  }
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES ('seed', 's', NULL, ?)", [HOUSE]);
  await runQuery("INSERT INTO supply_snapshot (id, pools) VALUES (1, '[]')");
  await P.init();
  await FUND.init();
  await P._setMeta("enabled", true);
  const payload = JSON.stringify({ v: 1, source: "pepe", pools: POOLS, docs: {}, routes: {}, econ_cfg: {}, econ_cfg_log: [], catalog: {} });
  assert.equal((await P.importFromPepe({ key: "pc-derived-test", payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"),
                                         totals: { sum: Object.values(POOLS).reduce((t, v) => t + v, 0), count: Object.keys(POOLS).length, per_pool: POOLS } })).ok, true);
  await P._setMeta("imported", Object.assign((await P.exportState()).imported, { at: 0 }));
  await ST.init();
  await runQuery("INSERT INTO stash_meta (key, value) VALUES ('enabled', 'true')");
  const sp = JSON.stringify([{ id: "1", owner: "ann_cf", name: "nest", balance: 1000, staked: 0, earned: 0, members: [] },
                             { id: "2", owner: "bob_cf", name: "pot", balance: 0, staked: 0, earned: 0, members: [] }]);
  assert.equal((await ST.importFromPepe({ payload: sp, digest: crypto.createHash("sha256").update(sp, "utf8").digest("hex"), total: 1000, count: 2, seq: 2 })).ok, true);
  await CC.init();
  await CC.putDoc("vaults", {
    v: { house: { total: 10 * M, holders: { protocol: 9.5 * M, s1: 400000.0, s2: 100000.0 }, basis: 8 * M },
         bank: { total: 3 * M, holders: { protocol: 3 * M }, basis: 3 * M }, mm: { total: 1 * M, holders: { protocol: 1 * M }, basis: 1 * M } },
    auto: { total: 0.0, holders: {} }, queue: {}, epochs: [], seq: 0, inited: 1, insured: [] });
  await CC.setMeta("live", true);
  CC.forgetLive();
  await seedBook();
  // the bank-lent samples: Pepe's doc (one inside the 30-day window, one outside) + the site's own effect (1.5M, yesterday)
  await ES.putDocs({ econ_layers: { rev: 1, doc: { fed_mints: {}, fed_loans: {}, fed_loan_repaid: {} } },
                     econ_treasury: { rev: 1, doc: { week: { id: "W2026-11-02", budgets: {}, spent: {} }, bank_lent: [[MON - 10 * 86400, 50000], [MON - 45 * 86400, 9 * M]], days: {} } } });
  await C.init();
  await C.effect("bank_lent:W2026-11-02", { engine: "treasury", period: "W2026-11-02", kind: "bank_lent", data: { ts: MON - 86400, amount: 1500000 } });
  // the Fed's own journal (live): an open loan with 400,000 out, a journaled one (pending, 100,000), a repaid one
  await F.init();
  await F.setMeta("live", true);
  F.forgetLive();
  for (const [key, rec] of [["FL1", { id: "FL1", vault: "house", principal: 600000, outstanding: 400000, state: "open", ts: MON - 5 * 86400 }],
                            ["FL2", { id: "FL2", vault: "bank", principal: 100000, outstanding: 0, state: "pending", ts: MON - 86400 }],
                            ["FL3", { id: "FL3", vault: "mm", principal: 700000, outstanding: 0, state: "repaid", ts: MON - 9 * 86400 }]]) {
    await runQuery("INSERT INTO fed_records (kind, key, rec, state, amount, ts, updated) VALUES ('loan', ?, ?, ?, ?, ?, ?)", [key, JSON.stringify(rec), rec.state, rec.principal, rec.ts, Date.now()]);
  }
  require(path.join(repo, "econ"));
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const deps = { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() };
  ES.register(app, deps);
  SCH.register(app, deps);
  PC.register(app, deps);
  CS.register(app, deps);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  // the economy settings: Pepe's pushes fill policy_cfg (mirror), then the site owns them (H1)
  const sink = Object.assign({}, FX.SINK, { rloan_base: 12000.0, rloan_per_level: 2500.0 });
  assert.equal((await bot("/api/policy/bot/config", { cfg: FX.policyPush({ sink }) })).body.ok, true);
  assert.equal((await bot("/api/capital/bot/config", { cfg: FX.capitalPush({ rloan_base: 12000, rloan_per_level: 2500 }) })).body.ok, true);
  assert.equal((await bot("/api/econ/settings/put", { pat_routes: FX.routes(), catalog: FX.catalog(), econ_cfg: {}, econ_cfg_log: [] })).body.ok, true);
  await tx(async () => { await PC.putOwner("cfg", "site", { by: "test", handoverKey: "t".repeat(64) }); });
  await PC.refresh();
  await C.setMode("treasury", "shadow", { by: "test", armedAt: MON - 7 * 86400 });
});
test.after(() => server && server.close());

test("gather: the site's own tables give the hand-checked derived state (Pepe's push is never read for it)", async () => {
  const at = day(2026, 11, 9, 4, 35);
  const inp = await D.gather(at);
  assert.equal(inp.pools.bank, 22900000);
  assert.equal(inp.bank_nav, 22900000 + 88000, "only the bank-funded, uninsured, not written-off loan counts: 100,000 - 12,000 paid");
  assert.equal(inp.mm_seeds, 765341 + 34659, "the open LMSR markets seeded from mm (not paid out; an AMM market counts for nothing)");
  assert.deepEqual(inp.bank_lent, [[MON - 45 * 86400, 9 * M], [MON - 10 * 86400, 50000], [MON - 86400, 1500000]], "Pepe's samples + the site's effect, by time");
  assert.deepEqual(inp.fed_loans.map((r) => r.id).sort(), ["FL1", "FL2", "FL3"]);
  assert.deepEqual(inp.rloan, { base: 12000, per_level: 2500 });
  assert.equal(inp.tz, "America/New_York");
  const v = D.derive(inp);
  // house: house_target; bank: max(2M, 200% x the 30-day peak 1.5M) = 3M (the 9M sample is 45 days old); mm: max(1M, 800,000 x 1.5)
  assert.deepEqual(v.targets, { bank: 3 * M, house: E.C(inp).int("house_target", 15 * M), mm: 1200000 });
  assert.equal(v.diag.tr_live, true);
  assert.equal(v.diag.bank_peak, 1500000);
  assert.equal(v.fl_room, 10 * M - 400000 - 100000, "fedloan_cap - the open loan's outstanding - the pending one's principal");
  assert.equal(v.flash_room, v.fl_room);
  assert.deepEqual(v.credit, Object.assign({}, D.CREDIT_W, { capacity_base: 12000, capacity_per_level: 2500 }));
  // a push carrying other targets / fl_room / credit / flows changes nothing here
  await CS.putConfig(FX.capitalPush({ rloan_base: 12000, rloan_per_level: 2500, targets: { house: 1, bank: 1, mm: 1 }, fl_room: 7, flash: { bank: true, mm: true, room: 7 },
                                      credit: Object.assign({}, CR.DEFAULT_W, { base: 1, capacity_base: 1 }), flows: { bank: { in: { x: 9 } } } }));
  assert.deepEqual(D.derive(await D.gather(at)), v, "never read from the push");
});

test("the dual read: a matching push gives shadow:derived:D... ok = 1 after 1 attempt; nothing before 04:30 or the day's cut-off", async () => {
  const db = day(2026, 11, 9, 4);
  await setCutoff(db + 6);
  real = db + 1700;
  await pushAt(db + 1650);
  assert.equal(await passAt(db + 1700), null, "before 04:30: nothing");
  assert.equal(await row("D2026-11-09"), null);
  await setCutoff(db - 86400 + 6);                                 // the day's cut-off hasn't run
  real = db + 1900;
  await pushAt(db + 1850);
  assert.equal(await passAt(db + 1900), null, "no cut-off yet: nothing");
  assert.equal(await row("D2026-11-09"), null);
  await setCutoff(db + 6);
  await pushAt(db + 1790);
  assert.equal(await passAt(db + 1900), null, "a push from before the eligibility moment (04:30) isn't used");
  real = db + 2200;
  await pushAt(db + 2150);
  const msg = await passAt(db + 2200);
  assert.match(String(msg), /derived D2026-11-09: clean \(attempt 1\)/);
  const r = await row("D2026-11-09");
  assert.equal(r.ok, 1);
  assert.equal(r.mode, "shadow");
  assert.equal(r.engine, "derived");
  assert.equal(r.boundary_ts, db + 2150);
  const si = parse(r.site_inputs);
  assert.equal(si.attempts.length, 1);
  assert.equal(si.funding, "stale - not compared", "no funding sync in this process");
  assert.deepEqual(parse(r.site_plan).targets, parse(r.pepe_plan).targets);
  assert.ok(!JSON.stringify(si).includes("ann_cf") && !JSON.stringify(si).includes("loaner"), "no person in the record");
  // capital_meta "derived" (display only)
  const note = await CC.meta("derived");
  assert.equal(note.day, "D2026-11-09");
  assert.equal(note.values.targets.bank, 3 * M);
  // a final row is never rewritten, and a new push that day changes nothing
  real = db + 2600;
  await pushAt(db + 2550, { targets: { bank: 1, house: 1, mm: 1 } });
  assert.equal(await passAt(db + 2600), null);
  SCH._resetPassClock();
  assert.equal(await passAt(db + 2600), null, "after a restart too (the row is final)");
  assert.equal((await row("D2026-11-09")).updated, r.updated);
});

test("the dual read: a wrong bank target on 2 pushes with the same fingerprint -> final ok = 0 'stable difference'", async () => {
  const db = day(2026, 11, 10, 4);
  await setCutoff(db + 5);
  real = db + 2000;
  const v = await pushAt(db + 1990, {});
  const wrong = Object.assign({}, v.targets, { bank: v.targets.bank + 1 });
  await pushAt(db + 1995, { targets: wrong });
  await passAt(db + 2000);
  let r = await row("D2026-11-10");
  assert.equal(r.ok, null, "one unclean attempt: retried on the next push");
  assert.deepEqual(parse(r.blocking).plan, [`targets.bank: site ${v.targets.bank} / pepe ${v.targets.bank + 1}`]);
  assert.equal(await passAt(db + 2010), null, "the same push isn't compared twice");
  real = db + 2300;
  await pushAt(db + 2295, { targets: wrong });
  await passAt(db + 2300);
  r = await row("D2026-11-10");
  assert.equal(r.ok, 0);
  const si = parse(r.site_inputs);
  assert.equal(si.final, "stable difference");
  assert.equal(si.attempts.length, 2);
  assert.equal(si.attempts[0].fp, si.attempts[1].fp);
});

test("the dual read: state that moved between push and read, then a clean attempt -> ok = 1, the earlier attempt noted", async () => {
  const db = day(2026, 11, 11, 4);
  await setCutoff(db + 5);
  real = db + 2000;
  await pushAt(db + 1990);
  // the site's book moves after Pepe built his push (a bank-funded loan goes out): his targets are the old ones
  await CC.save("loan", { id: 5, status: "active", funded_by: "bank", principal: 2000000, paid: 0, owed: 2000000, borrower: "loaner_e" });
  await passAt(db + 2000);
  let r = await row("D2026-11-11");
  assert.equal(r.ok, null);
  assert.ok(parse(r.blocking).plan.some((x) => /^targets\.bank: /.test(x)), parse(r.blocking).plan.join(" | "));
  // ...and comes back (the loan is gone again) before Pepe's next push, which both sides now read alike
  await CC.remove("loan", 5);
  real = db + 2300;
  await pushAt(db + 2295);
  await passAt(db + 2300);
  r = await row("D2026-11-11");
  assert.equal(r.ok, 1);
  const si = parse(r.site_inputs);
  assert.equal(si.attempts.length, 2);
  assert.equal(si.attempts[0].note, "state moved between push and read");
  assert.equal(si.attempts[1].note, undefined);
});

test("flows is display-only", async () => {
  // 1. a flows-only difference: whitelisted, the day clean
  const db = day(2026, 11, 12, 4);
  await setCutoff(db + 5);
  real = db + 2000;
  await pushAt(db + 1990, { flows: { jackpot: { in: { heists: 25000 }, out: { "waterfall stakers": 144945 } } } });
  await passAt(db + 2000);
  const r = await row("D2026-11-12");
  assert.equal(r.ok, 1);
  const wl = parse(r.whitelisted).plan;
  assert.ok(wl.length >= 1 && wl.every((x) => /^flows(\.|:)/.test(x)), wl.join(" | "));
  assert.deepEqual(parse(r.blocking).plan, []);
  // 2. the whitelist entry: only the derived dual read's flows, in shadow
  assert.deepEqual(SCH.applyWhitelist(["flows.jackpot: site undefined / pepe {}"], { engine: "derived", kind: "derived", mode: "shadow" }).excused.length, 1);
  assert.deepEqual(SCH.applyWhitelist(["targets.bank: site 1 / pepe 2"], { engine: "derived", kind: "derived", mode: "shadow" }).blocking.length, 1);
  assert.deepEqual(SCH.applyWhitelist(["flows.jackpot: x"], { engine: "treasury", kind: "epoch", mode: "shadow" }).excused.length, 0);
  // 3. the source: no reader of `.flows` but the cut-off's snapshot (capital/vaults.js epoch: snap.flows = c.flows), publish's
  //    epochs (e.flows) and staking.js clean - plus funding.js's own state.flows (the funding sync's routing map, another thing)
  //    and PO-4's shadow compare (policy/scheduler.js)
  const files = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", "test", ".git", "public", "views", "uploads", "data", "discord-bot", "twitchbot", "discordself", "media"].includes(f.name)) continue;
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p); else if (f.name.endsWith(".js")) files.push(p);
    }
  };
  walk(repo);
  const hits = {};
  for (const p of files) {
    const rel = path.relative(repo, p).split(path.sep).join("/");
    const lines = fs.readFileSync(p, "utf8").split("\n");
    lines.forEach((l, i) => { if (/\.flows\b/.test(l) && !/^\s*\/\//.test(l) && !/^\s*\*/.test(l)) (hits[rel] = hits[rel] || []).push(i + 1); });
  }
  assert.deepEqual(Object.keys(hits).sort(), ["capital/vaults.js", "funding.js", "policy/scheduler.js", "staking.js"], JSON.stringify(hits));
  const vsrc = fs.readFileSync(path.join(repo, "capital", "vaults.js"), "utf8").split("\n");
  const vl = hits["capital/vaults.js"].map((n) => vsrc[n - 1].trim());
  assert.equal(vl.length, 2, vl.join(" | "));
  assert.ok(vl[0].startsWith("flows: (c.flows && typeof c.flows === \"object\")") && vl[1].startsWith("epochs: d.epochs.slice(-120)"), vl.join(" | "));
  for (const n of hits["funding.js"]) assert.match(fs.readFileSync(path.join(repo, "funding.js"), "utf8").split("\n")[n - 1], /state\.flows|body\.flows|snap\.flows/);
  for (const n of hits["policy/scheduler.js"]) assert.match(fs.readFileSync(path.join(repo, "policy", "scheduler.js"), "utf8").split("\n")[n - 1], /p\.flows|v\.flows/);
});

test("flows is display-only: two cut-offs whose flows differ write the same pool / stash / ledger / House rows (only epochs[].flows differs)", async () => {
  const MONEY = ["pool_moves", "pool_move_legs", "stash_moves", "transactions", "jackpot_rakes"];
  const TS = new Set(["ts", "timestamp", "created", "updated", "after"]);
  const snapshot = async () => {
    const out = {};
    for (const t of MONEY) {
      out[t] = (await getQuery(`SELECT * FROM ${t}`).catch(() => [])).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !TS.has(k))))
        .map((r) => JSON.stringify(r)).sort();
    }
    const d = await V.load();
    out.doc = JSON.stringify(Object.assign({}, d, { epochs: d.epochs.map((e) => Object.assign({}, e, { flows: null, ts: null })), next_epoch: null,
                                                     queue: Object.fromEntries(Object.entries(d.queue).map(([k, q]) => [k, Object.assign({}, q, { done: null })])) }));
    out.flows = JSON.stringify(d.epochs.map((e) => e.flows));
    return out;
  };
  const T = Math.floor(CC.nowS());
  const run = async (flows) => {
    const m = await CC.meta("cfg");
    m.flows = flows;
    m.at = T;
    await CC.setMeta("cfg", m);
    let got = null;
    const SENTINEL = new Error("roll back");
    await DB.tx(async () => {
      const d = await V.load();
      d.epochs = [{ ts: T - 86400, price: { bank: 1, house: 1, mm: 1, auto: 1 }, nav: {}, staked: {} }];
      d.queue = { q1: { id: "q1", stash: "1", vault: "bank", kind: "deposit", amount: 50000, state: "pending", held: true, ts: T - 3600, by: "ann_cf" } };
      await V.store(d);
      await V.epoch({ nowS: T, key: "test" });
      got = await snapshot();
      throw SENTINEL;
    }).catch((e) => { if (e !== SENTINEL) throw e; });
    return got;
  };
  const a = await run({ bank: { in: { "loan interest": 1234 } } });
  const b = await run({});
  assert.ok(a.pool_moves.length > 0 || a.pool_move_legs.length > 0, "the cut-off moved PAT (the deposit)");
  for (const t of MONEY) assert.deepEqual(a[t], b[t], `${t}: the same rows`);
  assert.equal(a.doc, b.doc, "the book is the same but for epochs[].flows");
  assert.notEqual(a.flows, b.flows, "only the epoch record's flows differ");
});

test("the dual read: no fresh capital push all day -> ok = 0 'no fresh capital push' at the day's end; a stale funding sync isn't compared", async () => {
  const db = day(2026, 11, 13, 4);
  await setCutoff(db + 5);
  real = db + 2000;
  await pushAt(db + 2000 - 3600);                                   // an hour old: not fresh
  await passAt(db + 2000);
  let r = await row("D2026-11-13");
  assert.ok(r && r.ok === null, "the day's row exists, nothing compared");
  assert.equal(parse(r.site_inputs).attempts.length, 0);
  // the next day's first pass closes it
  await passAt(db + 86400 + 60);
  r = await row("D2026-11-13");
  assert.equal(r.ok, 0);
  assert.equal(parse(r.site_inputs).final, "no fresh capital push");
  assert.deepEqual(parse(r.blocking).plan, ["no fresh capital push"]);
  // the funding sync: fresh -> compared (fedloan_room, week_start), else "stale - not compared"
  const db2 = day(2026, 11, 14, 4);
  await setCutoff(db2 + 5);
  real = db2 + 2000;
  const v = await pushAt(db2 + 1990);
  FUND.state.monetary = FX.monetary({ fedloan_room: v.fl_room, week_start: E.weekStart(db2 + 1990, 4) });
  FUND.state.syncedAt = (db2 + 1900) * 1000;
  await passAt(db2 + 2000);
  r = await row("D2026-11-14");
  assert.equal(r.ok, 1, parse(r.blocking).plan.join(" | "));
  assert.equal(parse(r.site_inputs).funding, "compared");
  // a funding sync with another room blocks while fresh
  const db3 = day(2026, 11, 15, 4);
  await setCutoff(db3 + 5);
  real = db3 + 2000;
  await pushAt(db3 + 1990);
  FUND.state.monetary = FX.monetary({ fedloan_room: 1, week_start: E.weekStart(db3 + 1990, 4) });
  FUND.state.syncedAt = (db3 + 1990) * 1000;
  await passAt(db3 + 2000);
  r = await row("D2026-11-15");
  assert.ok(parse(r.blocking).plan.some((x) => /^funding\.fedloan_room: site \d+ \/ pepe 1$/.test(x)), parse(r.blocking).plan.join(" | "));
  FUND.state.syncedAt = 0;
  FUND.state.monetary = null;
});

test("the dual read: a config error (E_CFG_MISSING) is a blocking attempt and never throws out of pass()", async () => {
  const db = day(2026, 11, 16, 4);
  await setCutoff(db + 5);
  real = db + 2000;
  await pushAt(db + 1990);
  // a capital setting (the loan terms gather reads through capital/core cfg) - the engines' own settings stay complete
  const saved = (await getQuery("SELECT * FROM policy_cfg WHERE key = 'rloan_base'"))[0];
  assert.ok(saved);
  await runQuery("DELETE FROM policy_cfg WHERE key = 'rloan_base'");
  PC.forget();
  let out;
  try {
    out = await SCH.pass(db + 2000, { only: ["burn"] });
  } finally {
    const cols = Object.keys(saved);
    await runQuery(`INSERT INTO policy_cfg (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, cols.map((k) => saved[k]));
    PC.forget();
  }
  assert.ok(Array.isArray(out), "pass() answered");
  const r = await row("D2026-11-16");
  assert.equal(r.ok, null, "an error is retried (no fingerprint: never a 'stable difference')");
  const b = parse(r.blocking).plan;
  assert.ok(b.length === 1 && /^gather: E_CFG_MISSING/.test(b[0]), b.join(" | "));
  // ...and the next push (the settings back) is clean
  real = db + 2400;
  await pushAt(db + 2395);
  await passAt(db + 2400);
  assert.equal((await row("D2026-11-16")).ok, 1);
});

test("the test clock: an untagged pass writes nothing; /admin/tick with a tag writes D...-<tag> (no cut-off needed)", async () => {
  process.env.STAGING = "1";
  try {
    const db = day(2026, 11, 17, 4);
    await setCutoff(db - 86400 * 3);                                // the capital cut-off runs on the real clock: none today
    real = day(2026, 11, 4, 22);                                    // the real clock is days behind the test clock
    await C.setTestClock(db + 31 * 60);
    assert.notEqual(C._testOffset(), 0);
    assert.equal(await passAt(db + 31 * 60), null, "untagged with the test clock set: nothing");
    assert.equal(await row("D2026-11-17"), null);
    // tagged: the first tick opens the day (its real moment), a push after it is compared
    const m = await CC.meta("cfg");
    m.at = real - 1000;
    await CC.setMeta("cfg", m);
    assert.equal(await passAt(db + 31 * 60, "p4a"), null);
    const r0 = await row("D2026-11-17-p4a");
    assert.ok(r0 && r0.ok === null);
    real += 300;
    await pushAt(real - 5);
    const msg = await passAt(db + 31 * 60, "p4a");
    assert.match(String(msg), /derived D2026-11-17-p4a: clean/);
    assert.equal((await row("D2026-11-17-p4a")).ok, 1);
  } finally {
    await C.setTestClock(null);
    delete process.env.STAGING;
  }
});

test("PO-4 moves NO PAT: a day of derived + digest passes writes no PAT row, no policy run / effect, no inbox row, no ops alert", async () => {
  const sums = async () => ({
    wallets: (await getQuery("SELECT COALESCE(SUM(points_balance), 0) AS s FROM users"))[0].s,
    pools: JSON.stringify(await getQuery("SELECT pool, balance FROM pool_balances ORDER BY pool").catch(async () => (await P.exportState()).pools || null)),
    house: await CC.houseBalance(),
    stashes: JSON.stringify(await getQuery("SELECT id, balance FROM stashes ORDER BY id")),
    moves: (await getQuery("SELECT COUNT(*) AS n FROM pool_moves"))[0].n,
    stash_moves: (await getQuery("SELECT COUNT(*) AS n FROM stash_moves"))[0].n,
    runs: (await getQuery("SELECT COUNT(*) AS n FROM policy_runs"))[0].n,
    effects: (await getQuery("SELECT COUNT(*) AS n FROM policy_effects"))[0].n,
    inbox: (await getQuery("SELECT COUNT(*) AS n FROM inbox").catch(() => [{ n: 0 }]))[0].n,
  });
  const before = await sums();
  const a0 = alerts.length;
  const db = day(2026, 11, 18, 4);
  await setCutoff(db + 5);
  for (let t = db; t < db + 86400; t += 900) {
    real = t;
    if ((t - db) % 3600 === 0) await pushAt(t - 5);
    await SCH.pass(t);
  }
  assert.equal((await row("D2026-11-18")).ok, 1);
  assert.deepEqual(await sums(), before, "wallets, pools, the House, the stashes, PAT rows, runs, effects, inbox");
  assert.equal(alerts.length, a0, "no ops alert");
});

test("view(): the derived rows (latest + 14 days) and the weekly audits", async () => {
  const v = await SCH.view();
  assert.ok(v.derived && Array.isArray(v.derived.rows) && v.derived.rows.length >= 5);
  assert.equal(v.derived.latest.period, v.derived.rows[0].period);
  assert.ok(Array.isArray(v.epoch_audits));
  assert.ok(v.whitelist.some((w) => w.engine === "derived" && w.field === "flows"));
});

test("review of PO-4: an outage across more than one day boundary - the older open days are closed too (a tagged rehearsal row aside)", async () => {
  SCH._resetPassClock();
  const d1 = day(2026, 11, 25, 4);
  await setCutoff(d1 + 5);
  real = d1 + 2000;
  await pushAt(d1 + 2000 - 3600);                                   // an hour old: the row opens, nothing compared
  await passAt(d1 + 2000);
  assert.equal((await row("D2026-11-25")).ok, null);
  await passAt(d1 + 2000, "x9");                                    // a tagged rehearsal row, left open
  assert.equal((await row("D2026-11-25-x9")).ok, null);
  // the scheduler is down all of 11-26 and 11-27: the first pass of 11-28 closes 11-25 (two boundaries back), not the tagged row
  const d4 = day(2026, 11, 28, 4);
  real = d4 + 60;
  await passAt(d4 + 60);
  const r = await row("D2026-11-25");
  assert.equal(r.ok, 0);
  assert.equal(parse(r.site_inputs).final, "no fresh capital push");
  assert.deepEqual(parse(r.blocking).plan, ["no fresh capital push"]);
  assert.equal((await row("D2026-11-25-x9")).ok, null, "a tagged rehearsal row is left alone");
});
