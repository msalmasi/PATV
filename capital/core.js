// capital/core.js — Phase 3 of the backend migration ("the capital cluster"): the shared store of the three engines that
// move together - the LMSR prediction markets + the Market maker vault (capital/markets.js), the Federal Reserve's loans to
// players + the Bank vault (capital/reserve.js) and the staking capital vaults (capital/vaults.js). docs/capital-cutover-
// runbook.md says why it is ONE cutover: the Bank's value includes the loans still out and the Market maker's includes the
// markets it seeded, so the share prices can only be computed where all three live.
//
//   capital_records   (kind, id) PK: kind "market" (an LMSR market, Pepe's markets.json shape + _ord), "loan" (a Reserve
//                     loan, Pepe's loans.json shape), "request" (an LR request); status, deadline (s), data (JSON)
//   capital_docs      key PK: "vaults" (the share book: Pepe's vaults.json keys the site owns), "credit" (the closed-loan
//                     history of pruned Reserve loans, per account)
//   capital_ops       key PK (the caller's idempotency key) -> the first answer. A refused op (Refuse) is NOT recorded, so a
//                     retry with the same key may still succeed later (the pools' rule).
//   capital_meta      enabled / live / imported / rev / cfg (Pepe's constants) / rollbacks / seq:*
// PAT: market pots are pools rows "market:<id>" (pools.js keeps them out of every pool view, like the gang treasuries);
// the Bank / Market maker / vaultfloat / Reserve cash are the Phase 1 pools; the House is SUM(jackpot_rakes). Every move
// is ONE transaction (dbUtils.tx: the record, the wallet rows, the pool legs and the op row together, or nothing).
// Events for Pepe's announcements go on the escrow event stream (escrow_events, game "capital"; he polls it with
// games:["capital"]).
"use strict";
const { runQuery, getQuery } = require("../dbUtils");

const KEY_RE = /^[A-Za-z0-9_.:@\-]{6,160}$/;
const KINDS = ["market", "loan", "request"];

class Refuse extends Error {
  constructor(status, message, code, extra) { super(message); this.status = status; this.code = code || null; this.extra = extra || null; }
}
const isRefuse = (e) => e instanceof Refuse || !!(e && e.status && e.code && typeof e.message === "string" && e.name !== "TypeError");
const now = () => Date.now();
const nowS = () => Date.now() / 1000;
const str = (v, n) => (v === undefined || v === null || v === "" ? null : String(v).slice(0, n));
const J = (v) => JSON.stringify(v === undefined ? null : v);
const parse = (s, d) => { if (s == null) return d; try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } };
const low = (s) => String(s || "").trim().replace(/^@+/, "").toLowerCase();
const fmt = (n) => Math.trunc(Number(n || 0)).toLocaleString("en-US");
const P = () => require("../pools");
const L = () => require("../escrow/ledger");
const tx = (fn) => require("../dbUtils").tx(fn);

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await P().init();
      await runQuery(`CREATE TABLE IF NOT EXISTS capital_records (
        kind TEXT NOT NULL, id INTEGER NOT NULL, status TEXT, deadline INTEGER, data TEXT NOT NULL, updated INTEGER, PRIMARY KEY (kind, id))`);
      await runQuery("CREATE INDEX IF NOT EXISTS capital_records_status ON capital_records (kind, status)");
      await runQuery("CREATE TABLE IF NOT EXISTS capital_docs (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER)");
      await runQuery("CREATE TABLE IF NOT EXISTS capital_ops (key TEXT PRIMARY KEY, op TEXT NOT NULL, ref TEXT, ts INTEGER NOT NULL, via TEXT, result TEXT)");
      await runQuery("CREATE INDEX IF NOT EXISTS capital_ops_ts ON capital_ops (ts)");
      await runQuery("CREATE TABLE IF NOT EXISTS capital_meta (key TEXT PRIMARY KEY, value TEXT)");
      await L().init();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function meta(key) {
  await init();
  const r = (await getQuery("SELECT value FROM capital_meta WHERE key = ?", [key]))[0];
  return r ? parse(r.value, null) : null;
}
const setMeta = async (key, v) => {
  await init();
  return runQuery("INSERT INTO capital_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, J(v)]);
};

/** May Pepe hand the capital cluster over? Default: on on staging (STAGING env), off on prod until an admin turns it on. */
async function enabled() {
  const v = await meta("enabled");
  if (v === true || v === false) return v;
  return !!process.env.STAGING;
}
let liveCache = { at: 0, v: false };
/** The site owns the markets, the Reserve loans and the vaults (an import ran and wasn't rolled back). Cached 2 s. */
async function live() {
  if (now() - liveCache.at < 2000) return liveCache.v;
  const v = !!(await meta("live"));
  liveCache = { at: now(), v };
  return v;
}
const forgetLive = () => { liveCache = { at: 0, v: false }; };
async function rev() { return (await meta("rev")) || 0; }
async function bumpRev() { const r = (await rev()) + 1; await setMeta("rev", r); return r; }
async function requireLive() {
  if (!(await live())) throw new Refuse(409, "The markets, Reserve loans and vaults still live in Pepe.", "E_NOT_LIVE");
}
function checkKey(k) {
  if (!KEY_RE.test(String(k || ""))) throw new Refuse(400, "Bad request (key).", "E_BAD_KEY");
  return String(k);
}

// ── Pepe's constants (he pushes them at the cutover, at every start and every few minutes: /api/capital/bot/config) ──
const DEFAULT_CFG = {
  // markets (pepe_market / pepe_amm)
  min_trade: 500, settle_grace: 7 * 86400, max_secs: 30 * 86400, max_open: 5,
  // Reserve loans (pepe_loan)
  loan_min: 1000, rloan_enabled: 1, rloan_rate_week: 0.03, rloan_base: 10000, rloan_per_level: 2000, rloan_max_auto: 250000,
  rloan_max_days: 30, rloan_book_share: 0.25, rloan_max_open: 1, penalty_pct: 2, penalty_cap_pct: 50, collect_every: 600,
  loan_max_borrowed: 5,
  // vaults (pepe_vaults)
  vaults_enabled: 1, ceil_apr: 0.25, floor_apr: 0.0, topup: 0, topup_max_day: 25000, staker_max: 0.5, house_min_cash: 5000000,
  auto_bank_min: 0.40, auto_house_max: 0.35, auto_mm_max: 0.25, bank_default_days: 30, bank_insurance_cap: 50000000,
  min_move: 1000, epoch_hour: 4, dividend: 1, apr_min_cover: 0.9,
  // staking fix plan P1.2 (2026-10-19): the protocol cushion under the APR ceiling - OFF until the owner turns on Pepe's
  // vault_ceil_cushion (pushed as ceil_cushion); the window is the last ceil_cushion_days of skims
  ceil_cushion: 0, ceil_cushion_days: 8,
  // P2.2: Auto deposits (and the Auto rebalance) under the staker limit - OFF until Pepe's vault_auto_staker_cap is turned on
  auto_staker_cap: 0,
  // policy state Pepe still owns (Phase 4): read at each use, refused / deferred when it's stale
  layers: false, tr_live: false, targets: null, flash: { bank: false, mm: false, room: 0 }, fl_room: 0, flows: null,
  credit: null,
};
async function cfg() {
  const c = (await meta("cfg")) || {};
  const out = Object.assign({}, DEFAULT_CFG, c);
  out.flash = Object.assign({}, DEFAULT_CFG.flash, c.flash || {});
  return out;
}
/** Seconds since Pepe last pushed his policy state (targets, layers, flash room). */
async function cfgAge() {
  const c = (await meta("cfg")) || {};
  return c.at ? nowS() - Number(c.at) : Infinity;
}

// ── records ──
async function load(kind, id) {
  const r = (await getQuery("SELECT data FROM capital_records WHERE kind = ? AND id = ?", [kind, Math.trunc(Number(id) || 0)]))[0];
  return r ? parse(r.data, null) : null;
}
async function list(kind, statuses) {
  const rows = statuses && statuses.length
    ? await getQuery(`SELECT data FROM capital_records WHERE kind = ? AND status IN (${statuses.map(() => "?").join(",")}) ORDER BY id`, [kind, ...statuses])
    : await getQuery("SELECT data FROM capital_records WHERE kind = ? ORDER BY id", [kind]);
  return rows.map((r) => parse(r.data, null)).filter(Boolean);
}
async function save(kind, rec, deadline = null) {
  await runQuery(`INSERT INTO capital_records (kind, id, status, deadline, data, updated) VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(kind, id) DO UPDATE SET status = excluded.status, deadline = excluded.deadline, data = excluded.data, updated = excluded.updated`,
                 [kind, Math.trunc(rec.id), String(rec.status || ""), deadline == null ? null : Math.trunc(deadline), J(rec), now()]);
}
async function remove(kind, id) {
  await runQuery("DELETE FROM capital_records WHERE kind = ? AND id = ?", [kind, Math.trunc(Number(id) || 0)]);
}
async function doc(key, dflt) {
  const r = (await getQuery("SELECT data FROM capital_docs WHERE key = ?", [key]))[0];
  return r ? parse(r.data, dflt) : dflt;
}
async function putDoc(key, v) {
  await runQuery("INSERT INTO capital_docs (key, data, updated) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, updated = excluded.updated",
                 [key, J(v), now()]);
}

// ids: the M numbering is shared with the site's betting pools (escrow game "pools"), the L numbering with the P2P loans
// (escrow game "loans") - the next id is above both, and both sequences move to it
async function nextId(which) {
  const pair = { market: "pools", loan: "loans" }[which];
  let n = Number((await meta(`seq:${which}`)) || 0);
  if (pair) n = Math.max(n, Number((await L().meta(`seq:${pair}`)) || 0));
  n += 1;
  await setMeta(`seq:${which}`, n);
  if (pair) await L().setMeta(`seq:${pair}`, n);
  return n;
}

// ── the op journal ──
async function seen(key) {
  const r = (await getQuery("SELECT result FROM capital_ops WHERE key = ?", [key]))[0];
  return r ? Object.assign(parse(r.result, { ok: true }), { dup: true }) : null;
}
async function record(key, op, ref, via, result) {
  await runQuery("INSERT INTO capital_ops (key, op, ref, ts, via, result) VALUES (?, ?, ?, ?, ?, ?)",
                 [key, String(op).slice(0, 30), str(ref, 60), now(), str(via, 20), J(result)]);
}
async function opStatus(key) {
  await init();
  if (!KEY_RE.test(String(key || ""))) return null;
  const r = (await getQuery("SELECT result FROM capital_ops WHERE key = ?", [String(key)]))[0];
  return r ? parse(r.result, { ok: true }) : null;
}

// ── PAT legs (inside an open transaction) ──
/** Pool legs [{pool, amount}] all-or-nothing through pools.js; the move recorded under mk. A House leg ("jackpot") is a
 *  jackpot_rakes row. -> {after} */
async function legs(mk, list, { kind = "capital", flow = null, why = null, via = "capital" } = {}) {
  const pl = [], house = [];
  for (const l of list) {
    const a = Math.trunc(Number(l.amount) || 0);
    if (!a) continue;
    if (l.pool === "jackpot" || l.pool === "house") house.push(a); else pl.push({ pool: String(l.pool), amount: a });
  }
  for (let i = 0; i < house.length; i++) {
    if (house[i] < 0) {
      const h = await houseBalance();
      if (h < -house[i]) throw new Refuse(409, `the House holds ${fmt(h)} - can't take ${fmt(-house[i])}`, "E_INSUFFICIENT", { pool: "jackpot", balance: h });
    }
    await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)",
                   [`cap-${mk}-${i}`.slice(0, 190), `capital:${String(flow || why || "move").slice(0, 60)}`, null, house[i]]);
  }
  if (!pl.length) return { after: {} };
  const a = await P()._applyLegs(mk, pl, { kind, flow, why, via });
  await P()._recordMove(mk, { kind, flow, why, via, legs: pl, net: a.net, ts: a.ts, result: { ok: true, key: mk, balances: a.after } });
  await P()._bumpRev();
  return a;
}
async function houseBalance() {
  return Number((await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM jackpot_rakes"))[0].t) || 0;
}
async function poolBalance(k) {
  if (k === "jackpot" || k === "house") return houseBalance();
  return P().balance(k);
}
/** A wallet move in the open transaction: debit with requireCover (-> Refuse E_INSUFFICIENT_PAT) or credit (follows a merge). */
async function wallet(userId, amount, type, { counterparty = null, source = "capital" } = {}) {
  const ledger = require("../ledger");
  const a = Math.trunc(Number(amount));
  if (!a) return { ok: true, transactionId: null };
  const r = await ledger.post(userId, a, String(type).slice(0, 40),
                              a < 0 ? { requireCover: true, counterparty: counterparty || undefined, source }
                                    : { resolveMerged: true, counterparty: counterparty || undefined, source });
  if (!r.ok) {
    if (r.code === ledger.E_INSUFFICIENT) throw new Refuse(402, "insufficient PAT", "E_INSUFFICIENT_PAT");
    throw new Refuse(404, "Couldn't find the PAT account.", "E_TARGET_NOT_FOUND");
  }
  return r;
}

// ── accounts ──
/** The PATV account for a Camfrog login / username / userId (a userId follows merges; a login is the account linked to it
 *  NOW - 1.99tj: never through the login history). -> {userId, username, camfrogUsername, casino_banned, level, created_at} | null */
const ACCT = "userId, username, camfrogUsername, casino_banned, level, created_at, class";
async function account({ userId, username, login } = {}) {
  if (userId || username) {
    const r = await require("../usernames").resolveRecord({ userId, username }, { cols: ACCT });
    if (r.ok) return r.user;
  }
  if (login) {
    const a = (await getQuery(`SELECT ${ACCT} FROM users WHERE LOWER(camfrogUsername) = LOWER(?) ORDER BY points_balance DESC LIMIT 1`, [String(login)]))[0];
    if (a) return a;
    const b = (await getQuery(`SELECT ${ACCT} FROM users WHERE LOWER(username) = LOWER(?)`, [String(login)]))[0];
    if (b) return b;
  }
  return null;
}
const same = (a, b) => !!a && !!b && low(a) === low(b);

// ── events (Pepe's announcements) ──
async function emit(kind, room, data) {
  await L().emitInTx("capital", kind, room || null, data || {});
}
const wake = () => { try { L().wake(); } catch (e) { /* no poll waiting */ } };

module.exports = { init, meta, setMeta, enabled, live, forgetLive, rev, bumpRev, requireLive, checkKey, cfg, cfgAge, DEFAULT_CFG,
                   load, list, save, remove, doc, putDoc, nextId, seen, record, opStatus, legs, wallet, houseBalance, poolBalance,
                   account, same, emit, wake, tx, Refuse, isRefuse, now, nowS, str, J, parse, low, fmt, KINDS, KEY_RE };
