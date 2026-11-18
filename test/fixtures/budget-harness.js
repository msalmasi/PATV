// Helper for the incentive-week tests (not a test itself): a temp site with live pools, the capital book, the Fed's books, Pepe's config push
// and the routing catalog. boot(repo) takes the repo directory so the same scenario can run against another checkout.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const M = 1000000;
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);                  // Wednesday 2026-11-18 12:00 UTC: day 3 of week W2026-11-16
const WEEK = "W2026-11-16";
const WEEK_START = Date.UTC(2026, 10, 16, 4, 0, 0);
const POOLS = { reserve: 40 * M, bank: 3 * M, mm: 1 * M, fortknox: 5 * M, heist: 1 * M, incentives: 4 * M, stakers: 0 };
const HOUSE = 20 * M;
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

function setProcess(tag) {
  process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`)));
  delete process.env.STAGING;
  process.env.SECRET_KEY = "test-secret";
}
const CFG_OVER = { fed_floor: 10 * M, fed_ceiling: 150 * M, issuance_to_guarantee: false, incentive_guarantee_target: 0, activity_rewards: true, heist_cap_mode: "fixed",
                   budget_welcome: 1500000, budget_levelup: -1, budget_achievements: -1, budget_misc: 350000, budget_royalties: 300000, budget_roomgames: 3500000, budget_turf: 500000,
                   budget_season: 3000000, budget_launchpad: 1000000, budget_activity: 700000, pace_roomgames: 7, pace_turf: 7, pace_activity: 7, flash_house: true,
                   room_vault_cap: 50 * M, fedloan_cap: 10 * M, mintcap_loan: -1, mintcap_floor: 30 * M, mintcap_total: 100 * M };
const FLOWS = ["beg", "pictionary", "raffle", "mic_hourly", "store_heist", "turf_income", "turf_season"];

async function boot(repo, { clock = T0, fed = true } = {}) {
  const R = (...p) => require(path.join(repo, ...p));
  const db = R("dbUtils");
  const { runQuery } = db;
  const P = R("pools"), ES = R("econstore"), CC = R("capital", "core"), C = R("policy", "core"), E = R("policy", "engines"), PC = R("policy", "config"), FUND = R("funding"), F = R("fed", "service");
  R("opsalerts").alert = async () => ({ admins: 0 });
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT, casino_banned INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE bonus_winners (bonusId TEXT PRIMARY KEY, type TEXT, userId TEXT, transactionId TEXT, amount INTEGER)");
  await runQuery("CREATE TABLE supply_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), pools TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("INSERT INTO supply_snapshot (id, pools) VALUES (1, '[]')");
  for (const [id, name, cf] of [["u1", "ann", "ann_cf"], ["u2", "bob", "bob_cf"], ["u3", "carl", "carl_cf"]]) {
    await runQuery("INSERT INTO users (userId, username, password, points_balance, camfrogUsername) VALUES (?, ?, 'x', 1000, ?)", [id, name, cf]);
  }
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES ('seed', 's', NULL, ?)", [HOUSE]);
  let now = clock;
  const setNow = (ms) => { now = ms; };
  C._setClock(() => now);
  PC._setClock(() => now);
  F._setClock(() => now);
  await P.init();
  await FUND.init();
  await P._setMeta("enabled", true);
  const payload = JSON.stringify({ v: 1, source: "pepe", pools: POOLS, docs: {}, routes: {}, econ_cfg: {}, econ_cfg_log: [], catalog: {} });
  await P.importFromPepe({ key: "pc-budget-test", payload, digest: sha(payload),
                           totals: { sum: Object.values(POOLS).reduce((t, v) => t + v, 0), count: Object.keys(POOLS).length, per_pool: POOLS } });
  await P._setMeta("imported", Object.assign((await P.exportState()).imported, { at: 0 }));
  await CC.init();
  await CC.putDoc("vaults", { v: { house: { total: 10 * M, holders: { protocol: 10 * M }, basis: 8 * M }, bank: { total: 3 * M, holders: { protocol: 3 * M }, basis: 2.5 * M },
                                  mm: { total: 1 * M, holders: { protocol: 1 * M }, basis: 1 * M } },
                              auto: { total: 0, holders: {} }, queue: {}, epochs: [], seq: 0, inited: 1, insured: [] });
  await CC.setMeta("live", true);
  CC.forgetLive();
  await R("stashes").init();
  await ES.init();
  await C.init();
  await PC.init();
  const cfg = Object.assign({}, E.DEFAULTS, CFG_OVER);
  await C.putCfg({ econ_cfg: cfg, consts: Object.assign({}, E.CONSTS, { HOUSE_MIN_CASH: 5 * M }), flags: { layers: true, tr_live: true, ap_on: false }, tz: "America/New_York", skip: [],
                   journal: [], days_done: [], mo_days_done: [], burn_cfg: { mode: "accrual", accrual_every_min: 5 }, burn_inflight: 0 });
  const routes = Object.fromEntries(FLOWS.map((f) => [f, { group: "x", label: f, default: [["incentives", 100]], payout: true }]));
  await runQuery("INSERT INTO econ_catalog (id, data, updated) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data", [JSON.stringify({ routes }), now]);
  if (fed) {
    await F.init();
    await F.setMeta("enabled", true);
    const x = { v: 1, fed_mints: {}, fed_grants: {}, fed_loans: {}, fed_loan_repaid: {}, flash_repaid: {}, fed_loan_seq: 0 };
    const text = JSON.stringify(x);
    await F.importFromPepe({ key: "fc-budget-test", payload: text, digest: sha(text), totals: F.totalsOf(Object.assign({ fed_loan_seq: 0 }, x)) });
    F.forgetLive();
  }
  const owner = async (o, paused = 0) => {
    await db.tx(async () => {
      await PC.putOwner("budget", o, { by: "test" });
      await runQuery("UPDATE policy_ownership SET paused = ? WHERE feature = 'budget'", [paused]);
    });
    PC.forget();
    await PC.snapshot({ fresh: true });
  };
  return { R, db, runQuery, getQuery: db.getQuery, tx: db.tx, P, ES, CC, C, E, PC, FUND, F, owner, setNow, now: () => now, cfg };
}
/** A plain body for POST /spend. */
const spendBody = (over = {}) => Object.assign({ key: "beg:u1:aaaaaa", flow: "beg", amount: 2000, dest: { kind: "user", userId: "u1", type: "beg", counterparty: null }, room: "room-1", why: "!beg", actor: "ann_cf", keep: 0, at: T0 / 1000 }, over);
/** The funding sync Pepe sends. */
function syncBody(over = {}) {
  const g = { new_account: "welcome", levelup: "levelup", achievements: "achievements", connect_bonus: "misc", redeem_codes: "misc", platform_rewards: "misc", room_owner: "royalties", launchpad_welcome: "launchpad" };
  const flows = {};
  for (const f of ["new_account", "levelup", "achievements", "connect_bonus", "redeem_codes", "platform_rewards", "room_owner"]) flows[f] = "incentives";
  flows.wheel_shortfall = "jackpot";
  return Object.assign({ reserve: 40 * M, fortknox: 5 * M, flows, incentives: { balance: 4 * M, week: WEEK, treasury: true, groups: g,
    remaining: { welcome: 1500000, levelup: 4 * M, achievements: 4 * M, misc: 350000, royalties: 300000, roomgames: 1500000, turf: 200000, season: 3 * M, launchpad: 1 * M, activity: 300000 },
    budgets: { welcome: 1500000, levelup: -1, achievements: -1, misc: 350000, royalties: 300000, roomgames: 3500000, turf: 500000, season: 3 * M, launchpad: 1 * M, activity: 700000 },
    spent: {}, uncapped: ["achievements", "levelup"], share: null, release_per_day: null },
    monetary: { flash: { house: true, bank: true, mm: true }, fedloan_room: 3 * M, house_hard_floor: 5 * M, donation: { rate: 500000, bonus_pct: 20 }, grant_weekly_cap: -1, week_start: WEEK_START / 1000, band: null } }, over);
}
/** Every row a points-moving code path can write, in a form that doesn't depend on uuids or the wall clock. */
async function pointTables(db) {
  const q = async (sql) => db.getQuery(sql).catch(() => []);
  const canon = (rows) => rows.map((r) => JSON.stringify(r)).sort();
  const strip = (s) => String(s == null ? "" : s).replace(/"backup":"[^"]*"/g, '"backup":""').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>").replace(/"(ts|at|created|updated|done|paid_at|opened|repaid|pools_before|pools_after)":[0-9.]+/g, '"$1":0');
  return {
    pools: await q("SELECT key, balance FROM pools ORDER BY key"),
    moves: canon((await q("SELECT key, kind, flow, why, via, net, legs, result FROM pool_moves")).map((r) => Object.assign(r, { key: strip(r.key), result: strip(r.result) }))),
    legs: canon((await q("SELECT move_key, i, pool, amount, after FROM pool_move_legs")).map((r) => Object.assign(r, { move_key: strip(r.move_key) }))),
    users: await q("SELECT userId, points_balance FROM users ORDER BY userId"),
    tx: canon((await q("SELECT userId, type, points, counterparty FROM transactions"))),
    bonus: canon(await q("SELECT type, userId, amount FROM bonus_winners")),
    credit: canon(await q("SELECT ref, endpoint, userId, type, amount, source, outcome FROM bot_credit_log")),
    claims: canon((await q("SELECT flow, userId, type, amount, settled, COALESCE(queued,0) AS queued FROM reserve_claims"))),
    house: canon((await q("SELECT spinId, userId, amount FROM jackpot_rakes")).map((r) => Object.assign(r, { spinId: strip(r.spinId) }))),
    fed: canon((await q("SELECT kind, key, state, amount, source, month FROM fed_records"))),
    fedops: canon((await q("SELECT op_key, op FROM fed_ops"))),
    effects: canon((await q("SELECT key, engine, period, kind, data FROM policy_effects")).map((r) => Object.assign(r, { data: strip(r.data) }))),
    runs: canon((await q("SELECT key, engine, period, state, plan, result, error FROM policy_runs")).map((r) => Object.assign(r, { plan: strip(r.plan), result: strip(r.result) }))),
    groups: canon(await q("SELECT grp, week, budget, spent, remaining FROM incentive_groups")),
  };
}
module.exports = { boot, setProcess, spendBody, syncBody, pointTables, M, T0, WEEK, WEEK_START, POOLS, HOUSE, CFG_OVER, sha };
