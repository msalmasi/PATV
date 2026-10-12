// pools.js — 1.99ns Phase 1 of the backend migration: every protocol pool lives on the site; Pepe is a client.
//
// Until now every protocol pool lived in ONE bot file (Pepe's turf_data.json "vaults"): the Federal Reserve, Fort Knox,
// the incentive budget, the Casino vault ("heist"), the Bank and Market-maker cash, the stakers pool, vaultfloat, the
// bingo pot, the burn reserve and every room vault ("room:<room id>"). The site only saw what Pepe synced. After the
// cutover the site owns them (docs/backend-migration-audit.md §5.3, docs/pools-cutover-runbook.md):
//
//   pools            key (PK: "reserve", "fortknox", "room:<id>", ...), label, balance (CHECK >= 0), updated (ms)
//   pool_moves       key PRIMARY KEY (the caller's idempotency key), kind, flow, why, via, ts, net, legs (JSON), result (JSON)
//                    ONE row per move; a move has 1..n legs and is applied all-or-nothing in one database transaction.
//                    A key seen before answers its first result (dup) and moves nothing again. A refused move (a pool that
//                    can't cover a debit) is NOT recorded, so a later retry with the same key may still succeed.
//   pool_move_legs   (move_key, i) the legs again, one row each (pool, amount, balance after) - per-pool history
//   pools_meta       enabled / imported / live / rev / rollbacks
//   turf_inbox       (interim, until E-4) a routed charge's legs that go to Pepe-only places (turf businesses, a
//                    room_owner royalty note, the lotto pot while it is Pepe's): written in the SAME transaction as the
//                    wallet debit, applied by Pepe exactly once under the leg's key and acked (applied_at)
//
// The House is NOT a pool here: it stays SUM(jackpot_rakes) (a charge's House leg is a jackpot_rakes row in the same
// transaction). The lotto pot is the lotto service's while that is live (lotto/service.js) - never imported here then.
//
// Bot routes (bot token, POST - the staging router falls back to Pepe's sandbox):
//   /api/pools/state      {since_rev?}                          -> {ok, enabled, live, rev, pools: {key: balance}}
//   /api/pools/move       {key, legs: [[pool, amount], ...], flow, why, kind?}  one keyed multi-leg move
//   /api/pools/move-status {key}                                -> the recorded result, or null
//   /api/pat/charge       {key, username, amount, reason, counterparty?, route: {flow, room, payer, item_sink}, legs}
//                         the wallet debit + every pool leg (+ the House leg) + turf_inbox rows, ONE transaction
//   /api/pat/fund         {key, pool, username|userId, amount, flow, type}   pool -> wallet, one transaction
//   /api/pools/turf-inbox/pending {older_s, limit}, /ack {keys}
//   /api/pools/admin/import {key, payload, digest, totals}       the cutover (idempotent; rolls itself back on a mismatch)
//   /api/pools/admin/export {}                                   balances + sha256 + totals (read only)
//   /api/pools/admin/rollback {key}                              every pool -> 0 in one keyed move, live off; the answer
//                                                                is what Pepe credits back locally (the reverse import)
// While pools are live the site also settles plain Reserve / Fort Knox website claims itself (settleClaims: the same
// pool, the same amount, keyed "claim:<claimId>" - the key Pepe's _funding_tick uses too, so either may settle it once).
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");

const KEY_RE = /^[A-Za-z0-9_.:@\-]{6,160}$/;
// 2026-10-12: + profile pad vaults (room:user:<userId>, pepe_padtopup's profile vaults)
const POOL_RE = /^(?:[a-z][a-z0-9_]{0,31}|room:(?:user:)?[A-Za-z0-9_.\-]{1,80})$/;
const NOT_POOLS = new Set(["jackpot", "casino", "house"]);        // the House is jackpot_rakes; "casino" was merged into it
const MAX_LEGS = 24;
const INBOX_KEEP_MS = 30 * 86400000;

// Pepe's own names for the supply page (his _supply_pools labels) - used when a pool row has no label yet
const LABELS = {
  reserve: "🏛️ Federal Reserve", bingo: "🔢 Bingo pot", stakers: "📈 Staking rewards pool", fortknox: "🪙 Fort Knox (what bank heists rob)",
  incentives: "🎁 Incentive budget", heist: "🎰 Casino vault (what casino heists rob)", bank: "🏦 Bank vault (cash)",
  mm: "📈 Market-maker vault (free PAT)", lotto: "🎟️ Lotto jackpot pot", vaultfloat: "⏳ Staking requests waiting for the cut-off",
  burn: "🔥 Burn reserve (out of circulation, waiting to be burned)",
  likeness: "🪞 Likeness cuts held for their subjects (24 h)",          // 1.99rv: likeness.js escrow
};

class Refuse extends Error {
  constructor(status, message, code, extra) { super(message); this.status = status; this.code = code || null; this.extra = extra || null; }
}
const now = () => Date.now();
const str = (v, n) => (v === undefined || v === null || v === "" ? null : String(v).slice(0, n));

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS pools (
        key TEXT PRIMARY KEY, label TEXT, balance INTEGER NOT NULL DEFAULT 0, updated INTEGER, CHECK (balance >= 0))`);
      await runQuery(`CREATE TABLE IF NOT EXISTS pool_moves (
        key TEXT PRIMARY KEY, kind TEXT NOT NULL, flow TEXT, why TEXT, via TEXT, ts INTEGER NOT NULL, net INTEGER NOT NULL DEFAULT 0,
        legs TEXT NOT NULL, result TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS pool_moves_ts ON pool_moves (ts)");
      await runQuery(`CREATE TABLE IF NOT EXISTS pool_move_legs (
        move_key TEXT NOT NULL, i INTEGER NOT NULL, pool TEXT NOT NULL, amount INTEGER NOT NULL, after INTEGER, ts INTEGER NOT NULL,
        PRIMARY KEY (move_key, i))`);
      await runQuery("CREATE INDEX IF NOT EXISTS pool_move_legs_pool ON pool_move_legs (pool, ts)");
      await runQuery("CREATE TABLE IF NOT EXISTS pools_meta (key TEXT PRIMARY KEY, value TEXT)");
      await runQuery(`CREATE TABLE IF NOT EXISTS turf_inbox (
        key TEXT PRIMARY KEY, route_key TEXT NOT NULL, i INTEGER NOT NULL, flow TEXT, dest TEXT NOT NULL, amount INTEGER NOT NULL,
        item_sink TEXT, room TEXT, payer TEXT, base INTEGER, created INTEGER NOT NULL, applied_at INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS turf_inbox_open ON turf_inbox (applied_at, created)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function meta(key) {
  await init();
  const r = (await getQuery("SELECT value FROM pools_meta WHERE key = ?", [key]))[0];
  if (!r) return null;
  try { return JSON.parse(r.value); } catch (e) { return null; }
}
const setMeta = (key, v) => runQuery(`INSERT INTO pools_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                                      [key, JSON.stringify(v)]);

/** May Pepe hand his pools over? Default: on on staging (STAGING env), off on prod until an admin turns it on. */
async function enabled() {
  const v = await meta("enabled");
  if (v === true || v === false) return v;
  return !!process.env.STAGING;
}
let liveCache = { at: 0, v: false };
/** The site owns the pools (an import ran and wasn't rolled back). Cached 2 s (funding.js asks on every payout). */
async function live() {
  if (now() - liveCache.at < 2000) return liveCache.v;
  const v = !!(await meta("live"));
  liveCache = { at: now(), v };
  return v;
}
const forgetLive = () => { liveCache = { at: 0, v: false }; };
async function rev() { return (await meta("rev")) || 0; }
async function bumpRev() {
  const r = (await rev()) + 1;
  await setMeta("rev", r);
  return r;
}

// one money transaction at a time on the shared connection (mainstage's chain, like stashes / boosts)
const tx = (fn) => require("./mainstage")._tx(fn);

const validKey = (k) => KEY_RE.test(String(k || ""));
function checkKey(k) {
  if (!validKey(k)) throw new Refuse(400, "Bad request (key).", "E_BAD_KEY");
  return String(k);
}
const isPool = (p) => POOL_RE.test(String(p || "")) && !NOT_POOLS.has(String(p));

/** Is `p` one of the site's pools right now? (the lotto pot is the lotto service's while that holds rows) */
async function lottoIsService() {
  try { return !!(await require("./lotto/service").potHasRows()); } catch (e) { return false; }
}

// ── reads ──
async function balances() {
  await init();
  const out = {};
  // G1 (gangs.js): gang treasuries are rows here too ("gang:<gid>"), but they are not protocol pools - never in the pool
  // views, digests, exports or rollbacks; gangs.js owns them
  for (const r of await getQuery("SELECT key, balance FROM pools WHERE key NOT LIKE 'gang:%' ORDER BY key")) out[r.key] = Number(r.balance) || 0;
  return out;
}
async function balance(key) {
  await init();
  const r = (await getQuery("SELECT balance FROM pools WHERE key = ?", [String(key)]))[0];
  return r ? Number(r.balance) || 0 : 0;
}
async function total() {
  await init();
  const r = (await getQuery("SELECT COALESCE(SUM(balance),0) AS t, COUNT(*) AS n FROM pools WHERE key NOT LIKE 'gang:%'"))[0];
  return { amount: Number(r.t) || 0, count: Number(r.n) || 0 };
}
/** sha256 of the canonical balances (sorted keys, zero pools left out) - what the cutover / rollback compare. */
function digestOf(pools) {
  const keys = Object.keys(pools || {}).filter((k) => Number(pools[k])).sort();
  return crypto.createHash("sha256").update(JSON.stringify(keys.map((k) => [k, Math.trunc(Number(pools[k]))])), "utf8").digest("hex");
}

// ── moves ──
function cleanLegs(raw) {
  const list = Array.isArray(raw) ? raw : [];
  if (!list.length || list.length > MAX_LEGS) throw new Refuse(400, "Bad request (legs).", "E_BAD_LEGS");
  return list.map((l) => {
    const pool = Array.isArray(l) ? l[0] : l && l.pool;
    const amount = Array.isArray(l) ? l[1] : l && l.amount;
    const a = Number(amount);
    if (!isPool(pool) || !Number.isSafeInteger(a) || a === 0) throw new Refuse(400, `Bad leg ${JSON.stringify(l).slice(0, 80)}.`, "E_BAD_LEGS");
    return { pool: String(pool), amount: a };
  });
}

/** In the open transaction: the first answer recorded under `key` (+ dup:true), or null. */
async function seen(key) {
  const r = (await getQuery("SELECT result FROM pool_moves WHERE key = ?", [key]))[0];
  if (!r) return null;
  try { return Object.assign(JSON.parse(r.result || "{}"), { dup: true }); } catch (e) { return { ok: true, dup: true }; }
}

/**
 * In the open transaction: apply `legs` in order (a debit only if the pool covers it - else a Refuse that rolls the whole
 * move back) and record the move. -> {after: {pool: balance}, net}. The burn reserve can only lose PAT by a "burn" move.
 */
async function applyLegs(moveKey, legs, { kind = "move", flow = null, why = null, via = null } = {}) {
  const t = now();
  const after = {};
  let net = 0;
  for (let i = 0; i < legs.length; i++) {
    const { pool, amount } = legs[i];
    if (amount < 0) {
      if (pool === "burn" && kind !== "burn" && kind !== "rollback") throw new Refuse(409, "Nothing pays out of the burn reserve.", "E_BURN_ONLY");
      const u = await runQuery("UPDATE pools SET balance = balance + ?, updated = ? WHERE key = ? AND balance >= ?", [amount, t, pool, -amount]);
      if (!u || u.changes !== 1) {
        const have = await balance(pool);
        throw new Refuse(409, `${pool} holds ${have} - can't take ${-amount}.`, "E_INSUFFICIENT", { pool, balance: have });
      }
    } else {
      await runQuery(`INSERT INTO pools (key, label, balance, updated) VALUES (?, ?, ?, ?)
                      ON CONFLICT(key) DO UPDATE SET balance = balance + excluded.balance, updated = excluded.updated`,
                     [pool, LABELS[pool] || null, amount, t]);
    }
    after[pool] = await balance(pool);
    net += amount;
    await runQuery("INSERT INTO pool_move_legs (move_key, i, pool, amount, after, ts) VALUES (?, ?, ?, ?, ?, ?)", [moveKey, i, pool, amount, after[pool], t]);
  }
  return { after, net, ts: t };
}
async function recordMove(moveKey, { kind, flow, why, via, legs, net, ts, result }) {
  await runQuery(`INSERT INTO pool_moves (key, kind, flow, why, via, ts, net, legs, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                 [moveKey, String(kind).slice(0, 20), str(flow, 64), str(why, 120), str(via, 40), ts || now(), Math.trunc(net || 0),
                  JSON.stringify((legs || []).map((l) => [l.pool, l.amount])), JSON.stringify(result)]);
}
async function requireLive() {
  if (!(await live())) throw new Refuse(409, "The pools still live in Pepe.", "E_NOT_LIVE");
}

/** One keyed move (1..n legs, all or nothing). -> {ok, key, balances} | dup | throws Refuse (E_INSUFFICIENT: not recorded). */
async function move({ key, legs, flow, why, kind = "move", via = "pepe" }) {
  await requireLive();
  key = checkKey(key);
  const ls = cleanLegs(legs);
  const k = ["move", "burn", "settle", "grant", "admin", "rollback", "cutover"].includes(kind) ? kind : "move";
  if (ls.some((l) => l.pool === "lotto") && (await lottoIsService())) throw new Refuse(409, "The lotto pot is the lotto service's.", "E_LOTTO_POT");
  return tx(async () => {
    const dup = await seen(key);
    if (dup) return dup;
    const a = await applyLegs(key, ls, { kind: k, flow, why, via });
    const out = { ok: true, key, balances: a.after };
    await recordMove(key, { kind: k, flow, why, via, legs: ls, net: a.net, ts: a.ts, result: out });
    await bumpRev();
    return out;
  });
}

async function moveStatus(key) {
  await init();
  if (!validKey(key)) return null;
  const r = (await getQuery("SELECT result FROM pool_moves WHERE key = ?", [String(key)]))[0];
  if (!r) return null;
  try { return JSON.parse(r.result || "{}"); } catch (e) { return { ok: true }; }
}

// ── /api/pat/charge: the wallet debit and its routing, in ONE transaction ──
// 1.99tc: an old (renamed / merged) username resolves through the username history (usernames.js), never a guess
const userByName = async (username) => (await getQuery("SELECT userId, username FROM users WHERE username = ?", [String(username || "")]))[0]
  || (username ? await require("./usernames").findUser(username, { cols: "userId, username" }) : null);

/**
 * Pepe priced the command and split it by his PAT Routing table (`legs` = [[dest, amount], ...], summing to `amount`).
 * Here, in one transaction: the wallet debit (only if the balance covers it) + every pool leg + the House leg (a
 * jackpot_rakes row) + one turf_inbox row per leg that goes somewhere only Pepe can reach. Keyed: the same key again
 * answers the first result with replayed:true and moves nothing. -> {ok, route_key, transactionId, site_legs, inbox, balances}
 */
async function charge({ key, username, amount, reason, counterparty, route, legs }) {
  await requireLive();
  key = checkKey(key);
  const amt = Math.floor(Number(amount));
  if (!(amt > 0)) throw new Refuse(400, "Bad amount.", "E_BAD_AMOUNT");
  const r = route && typeof route === "object" ? route : {};
  const flow = str(r.flow, 64);
  if (!flow || !/^[A-Za-z0-9_:.-]+$/.test(flow)) throw new Refuse(400, "Bad request (route.flow).");
  const split = (Array.isArray(legs) ? legs : []).map((l) => [String(Array.isArray(l) ? l[0] : (l && l.dest) || ""), Number(Array.isArray(l) ? l[1] : l && l.amount)]);
  if (!split.length || split.length > MAX_LEGS || split.some(([d, a]) => !d || d.length > 120 || !Number.isSafeInteger(a) || a <= 0)) {
    throw new Refuse(400, "Bad request (legs).", "E_BAD_LEGS");
  }
  if (split.reduce((t, [, a]) => t + a, 0) !== amt) throw new Refuse(400, "The legs don't add up to the amount.", "E_BAD_LEGS");
  const u = await userByName(username);
  if (!u) throw new Refuse(404, "Couldn't find a PAT account.", "E_TARGET_NOT_FOUND");
  const lottoSvc = await lottoIsService();
  const ledger = require("./ledger");
  return tx(async () => {
    const mk = "charge:" + key;
    const dup = await seen(mk);
    if (dup) return Object.assign(dup, { replayed: true });
    const d = await ledger.post(u.userId, -amt, String(reason || "command").slice(0, 40),
                                { requireCover: true, counterparty: counterparty || undefined, source: "pat/charge" });
    if (!d.ok) {
      throw new Refuse(d.code === ledger.E_INSUFFICIENT ? 402 : 404, d.code === ledger.E_INSUFFICIENT ? "insufficient PAT" : "no account",
                       d.code === ledger.E_INSUFFICIENT ? "E_INSUFFICIENT_PAT" : "E_TARGET_NOT_FOUND");
    }
    const poolLegs = [], siteLegs = [], inbox = [];
    const t = now();
    for (let i = 0; i < split.length; i++) {
      const [dest, a] = split[i];
      if (dest === "jackpot" || dest === "casino") {
        await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)",
                       [`rt-${key}-${i}`, `bot:route:${flow}`.slice(0, 80), u.userId, a]);
        siteLegs.push(i);
      } else if (isPool(dest) && !(dest === "lotto" && lottoSvc)) {
        poolLegs.push({ pool: dest, amount: a, i });
        siteLegs.push(i);
      } else {
        const ik = `rt-${key}-${i}`;
        await runQuery(`INSERT INTO turf_inbox (key, route_key, i, flow, dest, amount, item_sink, room, payer, base, created)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                       [ik, key, i, flow, dest, a, str(r.item_sink, 64), str(r.room, 120), str(r.payer, 80), amt, t]);
        inbox.push({ i, key: ik, dest, amount: a });
      }
    }
    const a = poolLegs.length ? await applyLegs(mk, poolLegs, { kind: "charge", flow, why: reason, via: "pepe" }) : { after: {}, net: 0, ts: t };
    const out = { ok: true, route_key: key, transactionId: d.transactionId, site_legs: siteLegs, inbox, balances: a.after };
    await recordMove(mk, { kind: "charge", flow, why: String(reason || "").slice(0, 40), via: "pepe", legs: poolLegs, net: a.net, ts: a.ts, result: out });
    await bumpRev();
    return out;
  });
}

// ── /api/pat/fund: a reward paid out of a pool, in ONE transaction ──
async function fund({ key, pool, userId, username, amount, flow, type, counterparty }) {
  await requireLive();
  key = checkKey(key);
  const amt = Math.floor(Number(amount));
  if (!(amt > 0)) throw new Refuse(400, "Bad amount.", "E_BAD_AMOUNT");
  if (!isPool(pool) || pool === "burn") throw new Refuse(400, "Bad pool.", "E_BAD_LEGS");
  let uid = userId ? String(userId) : null;
  if (!uid && username) uid = ((await userByName(username)) || {}).userId || null;
  if (!uid) throw new Refuse(404, "Couldn't find a PAT account.", "E_TARGET_NOT_FOUND");
  const ledger = require("./ledger");
  return tx(async () => {
    const mk = "fund:" + key;
    const dup = await seen(mk);
    if (dup) return dup;
    const legs = [{ pool: String(pool), amount: -amt }];
    const a = await applyLegs(mk, legs, { kind: "fund", flow, why: type, via: "pepe" });
    const c = await ledger.post(uid, amt, String(type || flow || "reward").slice(0, 40),
                                { resolveMerged: true, counterparty: counterparty || undefined, source: `pool:${pool}` });
    if (!c.ok) throw new Refuse(404, "Couldn't find the account to pay.", "E_TARGET_NOT_FOUND");      // rolls the pool debit back
    const out = { ok: true, key, transactionId: c.transactionId, userId: c.userId, balances: a.after };
    await recordMove(mk, { kind: "fund", flow, why: type, via: "pepe", legs, net: a.net, ts: a.ts, result: out });
    await bumpRev();
    return out;
  });
}

// ── the turf inbox (interim, until E-4) ──
async function inboxPending({ olderMs = 120000, limit = 100 } = {}) {
  await init();
  const lim = Math.max(1, Math.min(500, Math.floor(Number(limit)) || 100));
  return getQuery(`SELECT key, route_key, i, flow, dest, amount, item_sink, room, payer, base, created FROM turf_inbox
                   WHERE applied_at IS NULL AND created <= ? ORDER BY created, rowid LIMIT ?`, [now() - Math.max(0, Number(olderMs) || 0), lim]);
}
async function inboxAck(keys) {
  await init();
  let n = 0;
  const t = now();
  for (const k of (Array.isArray(keys) ? keys : []).slice(0, 500)) {
    if (!validKey(k)) continue;
    const r = await runQuery("UPDATE turf_inbox SET applied_at = ? WHERE key = ? AND applied_at IS NULL", [t, String(k)]);
    n += (r && r.changes) || 0;
  }
  if (Math.random() < 0.05) runQuery("DELETE FROM turf_inbox WHERE applied_at IS NOT NULL AND applied_at < ?", [t - INBOX_KEEP_MS]).catch(() => {});
  return n;
}
async function inboxOpen() {
  await init();
  const r = (await getQuery("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS t, MIN(created) AS oldest FROM turf_inbox WHERE applied_at IS NULL"))[0];
  return { count: Number(r.n) || 0, amount: Number(r.t) || 0, oldest: r.oldest || null };
}

// ── supply: the pool rows (patSupply in index.js) ──
/** Replace Pepe's snapshot rows for the pools with the live table. -> the new row list. */
async function supplyRows(snapshotRows) {
  if (!(await live())) return snapshotRows;
  const bals = await balances();
  const mine = new Set(Object.keys(bals).filter((k) => !k.startsWith("room:")).map((k) => "vault:" + k));
  const keep = (snapshotRows || []).filter((p) => {
    const k = String(p.key || "");
    return !mine.has(k) && !k.startsWith("room:");
  });
  const labels = {};
  for (const r of await getQuery("SELECT key, label FROM pools")) labels[r.key] = r.label;
  for (const [k, v] of Object.entries(bals)) {
    if (!(v > 0)) continue;
    if (k.startsWith("room:")) keep.push({ key: k.slice(0, 80), label: labels[k] || `🏠 Pad vault: ${k.slice(5)}`, amount: v });
    else keep.push({ key: "vault:" + k, label: labels[k] || LABELS[k] || `🏦 ${k} vault`, amount: v });
  }
  const ib = await inboxOpen().catch(() => ({ amount: 0 }));
  if (ib.amount > 0) keep.push({ key: "turf_inbox", label: "⏳ Charged, waiting for Pepe's turf businesses", amount: ib.amount });
  return keep;
}

// ── the cutover: import (idempotent, verifies itself, rolls back on any mismatch) ──
const backupDb = (tag) => require("./dbbackup").backupDb(tag);   // the online backup API, verified - never a file copy
let supplyFn = null;                                            // index.js patSupply (register())

function parsePayload(text) {
  let p;
  try { p = JSON.parse(text); } catch (e) { throw new Refuse(400, "payload is not JSON"); }
  if (!p || typeof p !== "object" || !p.pools || typeof p.pools !== "object") throw new Refuse(400, "payload has no pools");
  const pools = {};
  for (const [k, v] of Object.entries(p.pools)) {
    const n = Number(v);
    if (!isPool(k) || !Number.isSafeInteger(n) || n < 0) throw new Refuse(400, `bad pool ${String(k).slice(0, 60)}=${String(v).slice(0, 20)}`);
    pools[k] = n;
  }
  return { p, pools };
}

/**
 * Pepe's export -> the tables, once. body: {key, payload (JSON text), digest (sha256 of payload), totals: {sum, count,
 * per_pool, supply_pools}}. Checks: switch on, digest, totals, no pool holding PAT here, the lotto pot not double-owned.
 * Then a verified DB backup, and ONE transaction: Pepe's fresh supply rows as the snapshot, the supply total read, the pools
 * written + the econ docs / routes / settings (econstore.importInTx), every pool and the sum re-read and compared, the
 * supply total read again and compared (it must not move by one PAT), live on. Any mismatch throws -> ROLLBACK -> ok:false.
 */
async function importFromPepe(body) {
  await init();
  if (!(await enabled())) throw new Refuse(409, "the pools backend is switched off on this site", "E_FEATURE_OFF");
  const key = checkKey(body && body.key);
  const payload = String((body && body.payload) || "");
  const digest = crypto.createHash("sha256").update(payload, "utf8").digest("hex");
  if (!payload || digest !== String(body.digest || "")) throw new Refuse(400, "digest mismatch", "E_DIGEST");
  const done = await meta("imported");
  if (done && done.key === key) {
    if (done.digest === digest) return Object.assign({ ok: true, already: true }, done.answer || {});
    throw new Refuse(409, "this cutover key was already used with a different export", "E_ALREADY");
  }
  if (await live()) throw new Refuse(409, "the site already owns the pools (another import)", "E_ALREADY");
  const { p, pools } = parsePayload(payload);
  const keys = Object.keys(pools);
  const sum = keys.reduce((t, k) => t + pools[k], 0);
  const tt = (body && body.totals) || {};
  if (sum !== Math.floor(Number(tt.sum)) || keys.length !== Math.floor(Number(tt.count))) {
    throw new Refuse(400, `totals don't match: ${sum} PAT in ${keys.length} pools vs ${tt.sum} / ${tt.count}`, "E_TOTALS");
  }
  for (const k of keys) {
    if (Math.floor(Number((tt.per_pool || {})[k])) !== pools[k]) throw new Refuse(400, `pool ${k}: ${pools[k]} vs ${(tt.per_pool || {})[k]}`, "E_TOTALS");
  }
  if (pools.lotto && (await lottoIsService())) throw new Refuse(409, "the lotto pot already lives in the lotto service - export it as 0", "E_LOTTO_POT");
  const held = (await getQuery("SELECT key, balance FROM pools WHERE balance != 0 AND key NOT LIKE 'gang:%'"));
  if (held.length) throw new Refuse(409, `the pools table already holds PAT (${held.map((r) => r.key + "=" + r.balance).join(", ").slice(0, 200)})`, "E_NOT_EMPTY");
  const supplyPools = Array.isArray(p.supply) ? p.supply : null;
  if (supplyPools) {
    const pr = supplyPools.filter((r) => /^vault:/.test(String(r.key)) && isPool(String(r.key).slice(6)) || /^room:/.test(String(r.key)))
      .reduce((t, r) => t + Math.max(0, Math.floor(Number(r.amount) || 0)), 0);
    // room:*other is Pepe's "the rest of the room vaults" row - room vaults count either way
    if (pr !== sum - (pools.lotto && supplyPools.every((r) => r.key !== "vault:lotto") ? pools.lotto : 0)) {
      throw new Refuse(400, `Pepe's supply rows hold ${pr} in pools, the export ${sum}`, "E_SUPPLY");
    }
  }
  const backup = await backupDb("pre-pools-import");
  let answer;
  try {
    answer = await tx(async () => {
      if (await meta("live")) throw new Refuse(409, "already imported", "E_ALREADY");      // lost a race with its twin
      let before = null;
      if (supplyPools && supplyFn) {
        const clean = supplyPools.slice(0, 150).map((r) => ({ key: String(r.key || "").slice(0, 80), label: String(r.label || "").slice(0, 80),
                                                              amount: Math.max(0, Math.floor(Number(r.amount) || 0)) }));
        await runQuery("INSERT INTO supply_snapshot (id, pools, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP) " +
                       "ON CONFLICT(id) DO UPDATE SET pools = excluded.pools, updated_at = CURRENT_TIMESTAMP", [JSON.stringify(clean)]);
        before = (await supplyFn()).total;
      }
      const t = now();
      const legs = [];
      for (const k of keys.sort()) {
        const lbl = (p.labels && typeof p.labels[k] === "string" ? p.labels[k] : LABELS[k]) || null;
        await runQuery(`INSERT INTO pools (key, label, balance, updated) VALUES (?, ?, ?, ?)
                        ON CONFLICT(key) DO UPDATE SET label = COALESCE(excluded.label, pools.label), balance = excluded.balance, updated = excluded.updated`,
                       [k, lbl ? lbl.slice(0, 80) : null, pools[k], t]);
        if (pools[k]) legs.push({ pool: k, amount: pools[k] });
      }
      const mk = "import:" + key;
      if (legs.length) {
        for (let i = 0; i < legs.length; i++) {
          await runQuery("INSERT INTO pool_move_legs (move_key, i, pool, amount, after, ts) VALUES (?, ?, ?, ?, ?, ?)", [mk, i, legs[i].pool, legs[i].amount, legs[i].amount, t]);
        }
      }
      // verify every pool and the sum, as written
      const got = await balances();
      for (const k of keys) if (got[k] !== pools[k]) throw new Refuse(500, `pool ${k} reads ${got[k]} after the import, not ${pools[k]}`, "E_VERIFY");
      const gs = Object.values(got).reduce((t2, v) => t2 + v, 0);
      if (gs !== sum) throw new Refuse(500, `the pools sum to ${gs} after the import, not ${sum}`, "E_VERIFY");
      const docs = await require("./econstore").importInTx(p, { key });
      await setMeta("live", true);
      forgetLive();
      let after = null;
      if (before !== null) {
        after = (await supplyFn()).total;
        if (after !== before) throw new Refuse(500, `the supply total moved: ${before} before, ${after} after`, "E_SUPPLY");
      }
      const out = { total: sum, count: keys.length, per_pool: got, digest: digestOf(got), supply_before: before, supply_after: after, docs, backup };
      await recordMove(mk, { kind: "import", flow: "cutover", why: "pools moved from Pepe", via: "pepe", legs, net: sum, ts: t, result: Object.assign({ ok: true }, out) });
      await setMeta("imported", { key, digest, at: t, answer: out, actor: str(body.actor, 40) });
      await bumpRev();
      return out;
    });
  } catch (e) {
    forgetLive();
    if (e instanceof Refuse) { e.message += " - rolled back, nothing kept"; throw e; }
    throw e;
  }
  console.log(`[pools] imported ${keys.length} pool(s) holding ${sum} PAT from Pepe (key ${key}, backup ${backup})`);
  return Object.assign({ ok: true }, answer);
}

/** Read-only: balances, sha256, totals (the runbook's before / after). */
async function exportState() {
  const b = await balances();
  const keys = Object.keys(b);
  return { ok: true, live: await live(), enabled: await enabled(), rev: await rev(), pools: b, sum: keys.reduce((t, k) => t + b[k], 0),
           count: keys.length, digest: digestOf(b), imported: await meta("imported"), inbox: await inboxOpen() };
}

/**
 * Rollback (the reverse import): every pool -> 0 in ONE keyed move, live off, in one transaction. The answer - the
 * balances it took - is what Pepe credits back to his local pools (journaled under the same key). Idempotent by key.
 */
async function rollbackToPepe({ key, actor }) {
  await init();
  key = checkKey(key);
  const mk = "rollback:" + key;
  const prev = await moveStatus(mk);
  if (prev) return Object.assign({}, prev, { dup: true });
  if (!(await live())) throw new Refuse(409, "the pools aren't live here", "E_NOT_LIVE");
  // G1: gang treasury moves book their Fort Knox / Reserve legs here - the gangs go back to Pepe first
  if (await require("./gangs").live().catch(() => false)) throw new Refuse(409, "the gangs live on the site - roll them back first (docs/gangs-cutover-runbook.md)", "E_GANGS_LIVE");
  const backup = await backupDb("pre-pools-rollback");
  const out = await tx(async () => {
    const dup = await seen(mk);
    if (dup) return dup;
    const b = await balances();
    const legs = Object.keys(b).filter((k) => b[k] > 0).sort().map((k) => ({ pool: k, amount: -b[k] }));
    const a = legs.length ? await applyLegs(mk, legs, { kind: "rollback", flow: "rollback", why: "pools back to Pepe", via: "pepe" }) : { after: {}, net: 0, ts: now() };
    const rest = await total();
    if (rest.amount !== 0) throw new Refuse(500, `the pools still hold ${rest.amount} after the rollback`, "E_VERIFY");
    const pools = {};
    for (const k of Object.keys(b)) if (b[k] > 0) pools[k] = b[k];
    const sum = Object.values(pools).reduce((t, v) => t + v, 0);
    const res = { ok: true, key, pools, sum, count: Object.keys(pools).length, digest: digestOf(pools), backup };
    await recordMove(mk, { kind: "rollback", flow: "rollback", why: "pools back to Pepe", via: str(actor, 40) || "pepe", legs, net: a.net, ts: a.ts, result: res });
    await setMeta("live", false);
    const rb = (await meta("rollbacks")) || [];
    rb.push({ key, at: now(), sum, actor: str(actor, 40) });
    await setMeta("rollbacks", rb.slice(-20));
    const imp = await meta("imported");
    if (imp) await setMeta("imported", Object.assign({}, imp, { rolled_back: { key, at: now() } }));
    await bumpRev();
    return res;
  });
  forgetLive();
  console.log(`[pools] ROLLBACK ${key}: ${out.sum} PAT in ${out.count} pool(s) handed back to Pepe (backup ${backup})`);
  return out;
}

// ── website claims the site can settle itself (plain Reserve / Fort Knox), while the pools are live ──
let settling = null;
let shortLogged = new Set();
async function settleClaims() {
  if (settling) return settling;
  settling = (async () => {
    if (!(await live())) return { settled: 0 };
    // the first 2 minutes after an import belong to the cutover's own verification (Pepe compares the site's pools with
    // what left him, under his closed gate) - no site-side moves in that window
    const imp = await meta("imported");
    if (imp && !imp.rolled_back && now() - Number(imp.at || 0) < 120000) return { settled: 0, waiting: true };
    const funding = require("./funding");
    await funding.init();
    const rows = await getQuery(`SELECT claimId, flow, amount FROM reserve_claims WHERE settled = 0 AND COALESCE(queued,0) = 0
                                 AND flow NOT LIKE 'incentives:%' AND flow NOT LIKE 'room:%' AND flow NOT LIKE 'flash:%' AND flow NOT LIKE 'mint:%'
                                 ORDER BY created, rowid LIMIT 200`);
    let n = 0;
    for (const c of rows) {
      const amt = Math.trunc(Number(c.amount) || 0);
      // 1.99qw / 1.99rv: "lkhold:<flow>" (a website likeness cut in) and "lkpay:*" (released to its subject / returned to its
      // leg) move the "likeness" escrow pool - never the Reserve or the incentive budget
      const pool = String(c.flow).startsWith("fortknox:") ? "fortknox"
        : /^lk(hold|pay):/.test(String(c.flow)) ? "likeness" : "reserve";
      const key = "claim:" + c.claimId;
      try {
        await tx(async () => {
          const dup = await seen(key);
          if (!dup && amt !== 0) {
            const legs = [{ pool, amount: -amt }];
            const a = await applyLegs(key, legs, { kind: "settle", flow: c.flow, why: "website claim", via: "site" });
            await recordMove(key, { kind: "settle", flow: c.flow, why: "website claim", via: "site", legs, net: a.net, ts: a.ts,
                                    result: { ok: true, key, balances: a.after } });
            await bumpRev();
          }
          await runQuery("UPDATE reserve_claims SET settled = 1 WHERE claimId = ? AND settled = 0", [c.claimId]);
        });
        n++;
      } catch (e) {
        if (e instanceof Refuse && e.code === "E_INSUFFICIENT") {
          if (!shortLogged.has(c.claimId)) {
            shortLogged.add(c.claimId);
            console.log(`[pools] website claim ${c.claimId} (${c.flow} ${amt}) is more than ${pool} holds - left unsettled until it can cover it`);
          }
          continue;
        }
        console.error(`[pools] settling claim ${c.claimId}:`, e.message);
      }
    }
    if (shortLogged.size > 5000) shortLogged = new Set();
    if (n) console.log(`[pools] settled ${n} website claim(s) on the site`);
    return { settled: n };
  })().finally(() => { settling = null; });
  return settling;
}

// ── the admin view ──
async function adminView() {
  await init();
  const st = await exportState();
  const moves = await getQuery("SELECT key, kind, flow, why, via, ts, net, legs FROM pool_moves ORDER BY ts DESC, rowid DESC LIMIT 60");
  const labels = {};
  for (const r of await getQuery("SELECT key, label, updated FROM pools")) labels[r.key] = { label: r.label, updated: r.updated };
  return Object.assign(st, { labels, moves: moves.map((m) => Object.assign(m, { legs: (() => { try { return JSON.parse(m.legs); } catch (e) { return []; } })() })),
                             rollbacks: (await meta("rollbacks")) || [] });
}

// ── routes ──
function register(app, { isBotToken, addUser, patSupply }) {
  if (patSupply) supplyFn = patSupply;
  init().catch((e) => console.error("[pools] init:", e.message));
  const bot = (fn) => async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await fn(b)); } catch (e) {
      if (e instanceof Refuse) return res.status(e.status).json(Object.assign({ ok: false, error: e.message, code: e.code }, e.extra || {}));
      console.error("[pools] bot:", e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  };
  app.post("/api/pools/state", bot(async (b) => {
    const r = await rev();
    if (b.since_rev !== undefined && Number(b.since_rev) === r) return { ok: true, live: await live(), enabled: await enabled(), rev: r, same: true };
    return { ok: true, live: await live(), enabled: await enabled(), rev: r, pools: await balances(), inbox: await inboxOpen() };
  }));
  app.post("/api/pools/move", bot((b) => move({ key: b.key, legs: b.legs, flow: b.flow, why: b.why, kind: b.kind, via: "pepe" })));
  app.post("/api/pools/move-status", bot(async (b) => ({ ok: true, result: await moveStatus(b.key) })));
  app.post("/api/pat/charge", bot((b) => charge({ key: b.key, username: b.username, amount: b.amount, reason: b.reason,
                                                   counterparty: b.counterparty, route: b.route, legs: b.legs })));
  app.post("/api/pat/fund", bot((b) => fund({ key: b.key, pool: b.pool, userId: b.userId, username: b.username, amount: b.amount,
                                               flow: b.flow, type: b.type, counterparty: b.counterparty })));
  app.post("/api/pools/turf-inbox/pending", bot(async (b) => ({ ok: true, legs: await inboxPending({ olderMs: Number(b.older_s) >= 0 ? Number(b.older_s) * 1000 : 120000, limit: b.limit }) })));
  app.post("/api/pools/turf-inbox/ack", bot(async (b) => ({ ok: true, acked: await inboxAck(b.keys) })));
  // 1.99sy: the cutover export (pools + journals) is far bigger than the global 100 KB JSON limit (index.js skips this path)
  app.post("/api/pools/admin/import", require("express").json({ limit: "32mb" }), bot((b) => importFromPepe(b)));
  app.post("/api/pools/admin/export", bot(() => exportState()));
  app.post("/api/pools/admin/rollback", bot((b) => rollbackToPepe({ key: b.key, actor: b.actor })));

  // admins: switch the backend on/off before the import, and read the pools
  const admin = async (req, res) => {
    if (!req.user || !req.user.userId) { res.status(401).json({ ok: false, error: "Sign in first." }); return null; }
    const row = (await getQuery("SELECT class, username FROM users WHERE userId = ?", [req.user.userId]).catch(() => []))[0];
    if (!row || row.class !== "Admin") { res.status(403).json({ ok: false, error: "Admins only." }); return null; }
    return row;
  };
  app.get("/api/admin/pools", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!(await admin(req, res))) return;
    try { res.json(await adminView()); } catch (e) { console.error("[pools] admin view:", e); res.status(500).json({ ok: false, error: "failed" }); }
  });
  app.post("/api/admin/pools-backend", addUser, async (req, res) => {
    const me = await admin(req, res);
    if (!me) return;
    if (req.get("X-Requested-With") !== "fetch" || !require("./middleware/authGuard").sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    if (await live()) return res.status(409).json({ ok: false, error: "The site owns the pools now - roll back from Pepe (docs/pools-cutover-runbook.md)." });
    await setMeta("enabled", !!(req.body || {}).on);
    console.log(`[pools] backend switch ${(req.body || {}).on ? "ON" : "OFF"} by ${me.username}`);
    res.json({ ok: true, enabled: await enabled() });
  });
  // the site settles plain Reserve / Fort Knox claims itself while the pools are live
  const iv = setInterval(() => settleClaims().catch((e) => console.error("[pools] settle:", e.message)), 15000);
  if (iv.unref) iv.unref();
}

module.exports = { init, register, enabled, live, rev, balances, balance, total, move, moveStatus, charge, fund, inboxPending, inboxAck,
                   inboxOpen, supplyRows, importFromPepe, exportState, rollbackToPepe, settleClaims, adminView, digestOf, isPool,
                   Refuse, LABELS, _setSupplyFn: (f) => { supplyFn = f; }, _forgetLive: forgetLive, _setMeta: setMeta,
                   // G1 (gangs.js books treasury legs in its own transactions with the same primitives)
                   _tx: tx, _seen: seen, _applyLegs: applyLegs, _recordMove: recordMove, _bumpRev: bumpRev, _lottoIsService: lottoIsService,
                   _validKey: validKey,
                   // 1.99ou: for escrow/ledger.js - a settle's fee legs / a grant's pool debit inside ITS open transaction
                   _inTx: { applyLegs, recordMove, seen, bumpRev } };
