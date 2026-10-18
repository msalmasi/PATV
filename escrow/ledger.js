// escrow/ledger.js — 1.99ou Phase 2 of the backend migration: ONE escrow service on the site (docs/backend-migration-audit.md
// §5.8 / §6 Phase 2, docs/escrow-cutover-runbook.md).
//
// Until now every escrowed stake lived in Pepe's escrow.json (pepe_escrow.py): wager stakes, parimutuel pool bets, bounty
// pots, P2P loan principal and repayments, donations, mic-challenge head-to-head stakes, bingo cards, duel / brawl stakes,
// lotto buys, DJ shout-outs, cosmetics listings, room-vault deposits. The PAT had left the wallet (/api/wager/charge) and was
// owed back later (/api/wager/payout); the only record of WHO it was owed to was a JSON file on Pepe's VM, and nothing could
// be refunded or paid while he was down. Now the site holds them:
//
//   escrow_holds   id (PK: Pepe's "h<n>" ids carried over, the site's own engines use "s<n>"), key (UNIQUE: the hold's
//                  idempotency key), ref ("W12", "BT3", "M7", "L4", "B2", "X9", "DN5", ...), kind (the ref's letters),
//                  login (the Camfrog name it was taken from, as given), username / user_id (the PATV account charged),
//                  amount (> 0), reason, cp (counterparty, for the PAT history), state held | refunded | spent,
//                  created / done_at (ms), done_key (the move that ended it), txid (the wallet row), via (pepe | site | import)
//   escrow_moves   key PRIMARY KEY (the caller's idempotency key): op hold | refund | settle | grant | import | rollback,
//                  ref, ts, result (JSON: the first answer - a retry with the same key gets it back with dup:true)
//   escrow_meta    enabled (the ledger switch) / enabled:<game> (each site engine) / live / imported / seq / rev / rollbacks
//
// Every money move is ONE database transaction on the shared connection (mainstage's chain): the wallet row (ledger.post: a
// hold only if the wallet covers it), the hold row(s), the pool / House legs of a settle's fees (pools.js applyLegs, the same
// pool_moves journal Phase 1 writes) and the move row. A refused move (not enough PAT, a hold that isn't held any more) is NOT
// recorded, so a retry with the same key may still succeed later. Amounts and destinations are exactly Pepe's: he still decides
// every split (the PAT Routing table's fee legs), the site books it.
//
// The House is jackpot_rakes (a fee leg "jackpot" is a jackpot_rakes row in the same transaction). Fee legs to a pool need the
// pools on the site (pools.live()): the escrow cutover refuses until Phase 1 is live, so a fee can never land in a pool Pepe
// still owns. A settle may pay out LESS than it holds - the rest is "kept" (a stash deposit, a cosmetic, a shout-out: PAT that
// leaves escrow into something Pepe tracks) and recorded on the move.
//
// Supply: the held total is one row ("escrow:holds", from this table) while the escrow is live; Pepe's own rows then carry only
// his payout queue ("escrow"). The import checks the supply total doesn't move by one PAT in the same transaction.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("../dbUtils");
const SP = require("../siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

const KEY_RE = /^[A-Za-z0-9_.:@\-]{6,160}$/;
const HID_RE = /^[A-Za-z0-9_.:\-]{1,40}$/;
const REF_RE = /^[A-Za-z0-9_.:\-]{1,60}$/;
const MAX_LEGS = 60;
const GAMES = ["wagers", "bounties", "pools", "loans"];
// Holds a site SERVICE owns outright (PATV Creators, creators.js): never Pepe's - not in his mirror, never handed back by a
// rollback, never counted by the cutover's emptiness / verify checks, and his keyed calls can't move them.
//   CRS creator subscription period, CRP pay-per-view unlock (CRT ticket, CRM paid message request: reserved for P2)
//   1.99xk 🎫 PAT Raffles (raffles.js): RFT ticket purchase, RFP a creator's PAT prize, RFI a creator's Prize Shop item price
const SERVICE_KINDS = Object.freeze(["CRS", "CRP", "CRT", "CRM", "RFT", "RFP", "RFI"]);
const PEPE_SQL = `kind NOT IN (${SERVICE_KINDS.map((k) => `'${k}'`).join(",")})`;
const isServiceKind = (k) => SERVICE_KINDS.includes(String(k || ""));

class Refuse extends Error {
  constructor(status, message, code, extra) { super(message); this.status = status; this.code = code || null; this.extra = extra || null; }
}
/** A refusal from here or from pools.js (its own Refuse class): duck-typed, so either answers its status + code. */
const isRefuse = (e) => e instanceof Refuse || !!(e && e.status && e.code && typeof e.message === "string" && e.name !== "TypeError");
const now = () => Date.now();
const str = (v, n) => (v === undefined || v === null || v === "" ? null : String(v).slice(0, n));
const kindOf = (ref) => ((/^[A-Za-z]+/.exec(String(ref || "")) || [""])[0].toUpperCase() || "?").slice(0, 8);

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS escrow_holds (
        id TEXT PRIMARY KEY, key TEXT UNIQUE, ref TEXT, kind TEXT, login TEXT, username TEXT, user_id TEXT NOT NULL,
        amount INTEGER NOT NULL, reason TEXT, cp TEXT, state TEXT NOT NULL DEFAULT 'held', created INTEGER NOT NULL,
        done_at INTEGER, done_key TEXT, txid TEXT, via TEXT, CHECK (amount > 0))`);
      await runQuery("CREATE INDEX IF NOT EXISTS escrow_holds_state ON escrow_holds (state, ref)");
      await runQuery("CREATE INDEX IF NOT EXISTS escrow_holds_ref ON escrow_holds (ref)");
      await runQuery(`CREATE TABLE IF NOT EXISTS escrow_moves (
        key TEXT PRIMARY KEY, op TEXT NOT NULL, ref TEXT, ts INTEGER NOT NULL, amount INTEGER NOT NULL DEFAULT 0, via TEXT, result TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS escrow_moves_ts ON escrow_moves (ts)");
      await runQuery("CREATE TABLE IF NOT EXISTS escrow_meta (key TEXT PRIMARY KEY, value TEXT)");
      await runQuery(`CREATE TABLE IF NOT EXISTS escrow_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, game TEXT NOT NULL, kind TEXT NOT NULL, room TEXT, data TEXT, ts INTEGER NOT NULL)`);
      await runQuery("CREATE INDEX IF NOT EXISTS escrow_events_ts ON escrow_events (ts)");
      await runQuery(`CREATE TABLE IF NOT EXISTS escrow_games (
        game TEXT NOT NULL, id INTEGER NOT NULL, status TEXT, deadline INTEGER, data TEXT NOT NULL, updated INTEGER,
        PRIMARY KEY (game, id))`);
      await runQuery("CREATE INDEX IF NOT EXISTS escrow_games_status ON escrow_games (game, status)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function meta(key) {
  await init();
  const r = (await getQuery("SELECT value FROM escrow_meta WHERE key = ?", [key]))[0];
  if (!r) return null;
  try { return JSON.parse(r.value); } catch (e) { return null; }
}
// 1.99st: waits for init() like meta() - it only worked without because init's statements used to slip into whatever
// transaction was open on the shared connection; outside writes now wait for it (dbUtils write gate)
const setMeta = async (key, v) => {
  await init();
  return runQuery(`INSERT INTO escrow_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                  [key, JSON.stringify(v)]);
};

/** May Pepe hand the escrow (or one game: `game`) over? Default: on on staging (STAGING env), off on prod until an admin says so. */
async function enabled(game) {
  const v = await meta(game ? `enabled:${game}` : "enabled");
  if (v === true || v === false) return v;
  return !!process.env.STAGING;
}
let liveCache = { at: 0, v: false };
/** The site owns the escrow ledger (an import ran and wasn't rolled back). Cached 2 s. */
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

// one money transaction at a time on the shared connection (mainstage's chain, like pools / stashes / boosts)
const tx = (fn) => require("../mainstage")._tx(fn);
const validKey = (k) => KEY_RE.test(String(k || ""));
function checkKey(k) {
  if (!validKey(k)) throw new Refuse(400, "Bad request (key).", "E_BAD_KEY");
  return String(k);
}
async function requireLive() {
  if (!(await live())) throw new Refuse(409, "The escrow still lives in Pepe.", "E_NOT_LIVE");
}

// ── reads ──
const shapeHold = (h) => ({ id: h.id, ref: h.ref, kind: h.kind, nick: h.login, user: h.username, user_id: h.user_id, amount: Number(h.amount),
                            reason: h.reason, cp: h.cp, state: h.state, ts: Math.floor(Number(h.created) / 1000), done_ts: h.done_at ? Math.floor(h.done_at / 1000) : null,
                            via: h.via });
/** Pepe's held holds (his mirror, the export, the rollback) - never a site service's (SERVICE_KINDS). */
async function holdsHeld() {
  await init();
  return (await getQuery(`SELECT * FROM escrow_holds WHERE state = 'held' AND ${PEPE_SQL} ORDER BY created, id`)).map(shapeHold);
}
async function holdsByIds(ids) {
  await init();
  const list = (Array.isArray(ids) ? ids : []).map(String).filter((h) => HID_RE.test(h)).slice(0, 500);
  if (!list.length) return [];
  return (await getQuery(`SELECT * FROM escrow_holds WHERE id IN (${list.map(() => "?").join(",")})`, list)).map(shapeHold);
}
/** The held total: every hold (scope "all", the supply row), Pepe's only ("pepe": the cutover's checks) or the site services' ("service"). */
async function heldTotal(scope = "all") {
  await init();
  const w = scope === "pepe" ? ` AND ${PEPE_SQL}` : scope === "service" ? ` AND NOT (${PEPE_SQL})` : "";
  const r = (await getQuery(`SELECT COALESCE(SUM(amount),0) AS t, COUNT(*) AS n FROM escrow_holds WHERE state = 'held'${w}`))[0];
  return { amount: Number(r.t) || 0, count: Number(r.n) || 0 };
}
async function totalsByKind() {
  await init();
  const out = {};
  for (const r of await getQuery("SELECT kind, COALESCE(SUM(amount),0) AS t, COUNT(*) AS n FROM escrow_holds WHERE state = 'held' GROUP BY kind")) {
    out[r.kind] = { amount: Number(r.t) || 0, count: Number(r.n) || 0 };
  }
  return out;
}
/** sha256 of the canonical held holds (id, ref, user, amount), sorted by id - what the cutover / rollback compare. */
function digestOf(holds) {
  const rows = (holds || []).map((h) => [String(h.id), String(h.ref || ""), String(h.user || h.username || "").toLowerCase(), Math.trunc(Number(h.amount))])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return crypto.createHash("sha256").update(JSON.stringify(rows), "utf8").digest("hex");
}

// ── accounts ──
/**
 * The PATV account a record names. 1.99tc: userId first (followed through merges), then the username - an old name is
 * resolved through username_history / the merge log when exactly one live account had it (usernames.js), then the
 * Camfrog login. -> the users row or null. accountResolve() says why not (E_AMBIGUOUS vs not found).
 */
const ACCT_COLS = "userId, username, camfrogUsername, casino_banned";
async function accountResolve({ userId, username, login }, opts = {}) {
  const r = await require("../usernames").resolveRecord({ userId, username }, Object.assign({ cols: ACCT_COLS }, opts));
  if (r.ok || r.code === "E_AMBIGUOUS" || !login) return r;
  const a = (await getQuery(`SELECT ${ACCT_COLS} FROM users WHERE LOWER(camfrogUsername) = LOWER(?)
                             ORDER BY points_balance DESC LIMIT 1`, [String(login)]))[0];
  if (a) return { ok: true, user: a, via: "login" };
  const b = (await getQuery(`SELECT ${ACCT_COLS} FROM users WHERE LOWER(username) = LOWER(?)`, [String(login)]))[0];
  if (b) return { ok: true, user: b, via: "login" };
  return r;
}
async function accountFor(q, opts = {}) {
  const r = await accountResolve(q || {}, opts);
  return r.ok ? r.user : null;
}
async function cpName(cp) {
  if (!cp) return undefined;
  return String(cp).slice(0, 60);
}

// ── the in-transaction primitives (the site's own game engines call these inside THEIR transaction) ──
/** In the open transaction: the first answer recorded under `key` (+ dup:true), or null. */
async function seen(key) {
  const r = (await getQuery("SELECT result FROM escrow_moves WHERE key = ?", [key]))[0];
  if (!r) return null;
  try { return Object.assign(JSON.parse(r.result || "{}"), { dup: true }); } catch (e) { return { ok: true, dup: true }; }
}
async function record(key, { op, ref, amount, via, result }) {
  await runQuery("INSERT INTO escrow_moves (key, op, ref, ts, amount, via, result) VALUES (?, ?, ?, ?, ?, ?, ?)",
                 [key, op, str(ref, 60), now(), Math.trunc(Number(amount) || 0), str(via, 40), JSON.stringify(result)]);
}
async function nextSiteId() {
  const n = ((await meta("seq")) || 0) + 1;
  await setMeta("seq", n);
  return `s${n}`;
}

/**
 * In the open transaction: take `amount` from the account into a new hold. -> {ok, hid, txid} | throws Refuse
 * (E_INSUFFICIENT_PAT / E_TARGET_NOT_FOUND / E_CASINO_BANNED / E_DUP_HOLD). `hid` null = the site's own id.
 */
async function holdInTx({ key, hid, account, login, amount, ref, reason, cp, via = "site", casino = false }) {
  const amt = Math.floor(Number(amount));
  if (!(amt > 0) || !Number.isSafeInteger(amt)) throw new Refuse(400, "Bad amount.", "E_BAD_AMOUNT");
  if (!REF_RE.test(String(ref || ""))) throw new Refuse(400, "Bad request (ref).", "E_BAD_REF");
  if (!account) throw new Refuse(404, "Couldn't find a PAT account.", "E_TARGET_NOT_FOUND");
  if (casino && account.casino_banned) throw new Refuse(403, "Banned from the casino.", "E_CASINO_BANNED");
  const id = hid ? String(hid) : await nextSiteId();
  if (!HID_RE.test(id)) throw new Refuse(400, "Bad request (hold id).", "E_BAD_HID");
  const clash = (await getQuery("SELECT id, key FROM escrow_holds WHERE id = ?", [id]))[0];
  if (clash) throw new Refuse(409, `hold ${id} already exists`, "E_DUP_HOLD");
  const ledger = require("../ledger");
  const d = await ledger.post(account.userId, -amt, String(reason || "escrow").slice(0, 40),
                              { requireCover: true, counterparty: await cpName(cp), source: `escrow:${kindOf(ref)}` });
  if (!d.ok) {
    if (d.code === ledger.E_INSUFFICIENT) throw new Refuse(402, "insufficient PAT", "E_INSUFFICIENT_PAT");
    throw new Refuse(404, "Couldn't find a PAT account.", "E_TARGET_NOT_FOUND");
  }
  await runQuery(`INSERT INTO escrow_holds (id, key, ref, kind, login, username, user_id, amount, reason, cp, state, created, txid, via)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?, ?)`,
                 [id, key, String(ref), kindOf(ref), str(login || account.camfrogUsername || account.username, 60), account.username, account.userId, amt,
                  str(reason, 40), str(cp, 60), now(), d.transactionId, str(via, 20)]);
  return { ok: true, hid: id, txid: d.transactionId, user: account.username, user_id: account.userId };
}

async function loadHeld(ids) {
  const out = [];
  for (const id of ids) {
    const h = (await getQuery("SELECT * FROM escrow_holds WHERE id = ?", [String(id)]))[0];
    if (!h) throw new Refuse(404, `no hold ${id}`, "E_NO_HOLD", { hold: String(id) });
    if (h.state !== "held") throw new Refuse(409, `hold ${id} is ${h.state}`, "E_NOT_HELD", { hold: String(id), state: h.state });
    out.push(h);
  }
  return out;
}

/** In the open transaction: give a held stake back to whoever put it up. -> {ok, hid, amount, txid}. */
async function refundInTx({ key, hid, reason }) {
  const [h] = await loadHeld([hid]);
  const ledger = require("../ledger");
  const c = await ledger.post(h.user_id, Number(h.amount), String(reason || "escrow-refund").slice(0, 40),
                              { resolveMerged: true, counterparty: h.cp || undefined, source: `escrow:${h.kind}` });
  if (!c.ok) throw new Refuse(404, "Couldn't find the account to refund.", "E_TARGET_NOT_FOUND");
  const u = await runQuery("UPDATE escrow_holds SET state = 'refunded', done_at = ?, done_key = ? WHERE id = ? AND state = 'held'", [now(), key, h.id]);
  if (!u || u.changes !== 1) throw new Refuse(409, `hold ${h.id} changed under us`, "E_NOT_HELD");
  return { ok: true, hid: h.id, amount: Number(h.amount), user: h.username, nick: h.login, txid: c.transactionId };
}

/**
 * In the open transaction: spend held stakes. payouts [{user|userId|nick, amount, reason, cp}] go to wallets; fees
 * [[dest, amount], ...] go to the House ("jackpot") or a site pool (pools must be live); what isn't paid out is "kept".
 * Refuses (and changes nothing - the caller's transaction rolls back) if any hold isn't held or it pays out more than it holds.
 */
async function settleInTx({ key, hids, payouts, fees, ref, max }) {
  // `max`: a site engine that spends many holds at once (a parimutuel pool: one hold per bet, every winner paid) raises the
  // cap for its own in-transaction call (at most 2000); Pepe's keyed calls keep MAX_LEGS
  const lim = Math.min(2000, Math.max(MAX_LEGS, Math.floor(Number(max) || 0)));
  const ids = [...new Set((Array.isArray(hids) ? hids : []).map(String))];
  if (!ids.length || ids.length > lim) throw new Refuse(400, "Bad request (holds).", "E_BAD_HOLDS");
  const hs = await loadHeld(ids);
  const total = hs.reduce((t, h) => t + Number(h.amount), 0);
  const pay = (Array.isArray(payouts) ? payouts : []).map((p) => ({
    user: str(p && (p.user || p.username), 80), userId: str(p && p.userId, 80), nick: str(p && p.nick, 60),
    amount: Math.floor(Number(p && p.amount)), reason: str(p && p.reason, 40) || "escrow", cp: str(p && p.cp, 60),
  })).filter((p) => p.amount > 0);
  const fee = (Array.isArray(fees) ? fees : []).map((l) => ({ dest: String(Array.isArray(l) ? l[0] : l && l.dest || ""), amount: Math.floor(Number(Array.isArray(l) ? l[1] : l && l.amount)) }))
    .filter((l) => l.amount > 0);
  if (pay.length + fee.length > lim) throw new Refuse(400, "Bad request (legs).", "E_BAD_LEGS");
  if (pay.some((p) => !Number.isSafeInteger(p.amount)) || fee.some((l) => !Number.isSafeInteger(l.amount) || !l.dest || l.dest.length > 120)) {
    throw new Refuse(400, "Bad request (legs).", "E_BAD_LEGS");
  }
  const out = pay.reduce((t, p) => t + p.amount, 0) + fee.reduce((t, l) => t + l.amount, 0);
  if (out > total) throw new Refuse(409, `paying ${out} from ${total} held`, "E_OVERPAY", { held: total, out });
  const t = now();
  for (const h of hs) {
    const u = await runQuery("UPDATE escrow_holds SET state = 'spent', done_at = ?, done_key = ? WHERE id = ? AND state = 'held'", [t, key, h.id]);
    if (!u || u.changes !== 1) throw new Refuse(409, `hold ${h.id} changed under us`, "E_NOT_HELD");
  }
  const ledger = require("../ledger");
  const known = {};
  for (const h of hs) known[String(h.login || "").toLowerCase()] = { userId: h.user_id };
  const paid = [];
  for (const p of pay) {
    let uid = p.userId || p.user_id;
    if (!uid && p.user) uid = ((await accountFor({ username: p.user })) || {}).userId;
    if (!uid && p.nick) uid = (known[p.nick.toLowerCase()] || {}).userId || ((await accountFor({ login: p.nick })) || {}).userId;
    if (!uid) throw new Refuse(404, `Couldn't find the account to pay (${p.user || p.nick}).`, "E_TARGET_NOT_FOUND", { payee: p.user || p.nick });
    const c = await ledger.post(uid, p.amount, p.reason, { resolveMerged: true, counterparty: p.cp || undefined, source: `escrow:${kindOf(ref || hs[0].ref)}` });
    if (!c.ok) throw new Refuse(404, `Couldn't find the account to pay (${p.user || p.nick}).`, "E_TARGET_NOT_FOUND", { payee: p.user || p.nick });
    paid.push({ user_id: c.userId, nick: p.nick, user: p.user, amount: p.amount, reason: p.reason, txid: c.transactionId });
  }
  const P = require("../pools");
  const poolLegs = [];
  for (let i = 0; i < fee.length; i++) {
    const { dest, amount } = fee[i];
    if (dest === "jackpot" || dest === "casino" || dest === "house") {
      await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)",
                     [`esc-${key}-${i}`.slice(0, 190), `escrow:${String(ref || hs[0].ref || "").slice(0, 60)}`, null, amount]);
    } else if (dest === "lotto" && (await lottoOwnsPot())) {
      // the lotto pot is the lotto service's (lotto/service.js) - a !donate lotto lands there, as Pepe's _lotto_pot_adjust did
      const LS = require("../lotto/service");
      const D = await LS._inTx.sellingDraw();
      await LS._inTx.potMove(`bot:esc-${key}-${i}`.slice(0, 110), D ? D.draw : null, amount, `escrow ${String(ref || "").slice(0, 40)}`);
    } else if (P.isPool(dest)) {
      poolLegs.push({ pool: dest, amount });
    } else {
      throw new Refuse(400, `bad fee destination ${dest.slice(0, 60)}`, "E_BAD_LEGS");
    }
  }
  if (poolLegs.length) {
    if (!(await P.live())) throw new Refuse(409, "the pools still live in Pepe - a fee can't land in one here", "E_POOLS_NOT_LIVE");
    const mk = "escrow-fee:" + key;
    const a = await P._inTx.applyLegs(mk, poolLegs, { kind: "move", flow: `escrow:${kindOf(ref || hs[0].ref)}`, why: "escrow fees", via: "escrow" });
    await P._inTx.recordMove(mk, { kind: "move", flow: `escrow:${kindOf(ref || hs[0].ref)}`, why: "escrow fees", via: "escrow", legs: poolLegs,
                                   net: a.net, ts: a.ts, result: { ok: true, key: mk, balances: a.after } });
    await P._inTx.bumpRev();
  }
  return { ok: true, held: total, paid, fees: fee.map((l) => [l.dest, l.amount]), kept: total - out, holds: ids };
}

async function lottoOwnsPot() {
  try { return !!(await require("../lotto/service").potHasRows()); } catch (e) { return false; }
}

/** In the open transaction: pay wallets out of a pool or the House (a bingo rollover, a jackpot). */
async function grantInTx({ key, pool, payouts, ref }) {
  const pay = (Array.isArray(payouts) ? payouts : []).map((p) => ({
    user: str(p && (p.user || p.username), 80), userId: str(p && p.userId, 80), nick: str(p && p.nick, 60),
    amount: Math.floor(Number(p && p.amount)), reason: str(p && p.reason, 40) || "grant", cp: str(p && p.cp, 60),
  })).filter((p) => p.amount > 0);
  if (!pay.length || pay.length > 2000 || pay.some((p) => !Number.isSafeInteger(p.amount))) throw new Refuse(400, "Bad request (payouts).", "E_BAD_LEGS");
  const total = pay.reduce((t, p) => t + p.amount, 0);
  const P = require("../pools");
  const src = String(pool || "");
  if (src === "burn") throw new Refuse(409, "Nothing pays out of the burn reserve.", "E_BURN_ONLY");
  if (src === "jackpot" || src === "house") {
    const h = Number((await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM jackpot_rakes"))[0].t) || 0;
    if (h < total) throw new Refuse(409, `the House holds ${h} - can't pay ${total}`, "E_INSUFFICIENT", { pool: "jackpot", balance: h });
    await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)",
                   [`escg-${key}`.slice(0, 190), `escrow-grant:${String(ref || "").slice(0, 60)}`, null, -total]);
  } else if (src === "lotto" && (await lottoOwnsPot())) {
    throw new Refuse(409, "the lotto pot pays only through the lotto service", "E_LOTTO_POT");
  } else if (P.isPool(src)) {
    if (!(await P.live())) throw new Refuse(409, "the pools still live in Pepe", "E_POOLS_NOT_LIVE");
    const mk = "escrow-grant:" + key;
    const a = await P._inTx.applyLegs(mk, [{ pool: src, amount: -total }], { kind: "grant", flow: `escrow:${kindOf(ref)}`, why: "escrow grant", via: "escrow" });
    await P._inTx.recordMove(mk, { kind: "grant", flow: `escrow:${kindOf(ref)}`, why: "escrow grant", via: "escrow", legs: [{ pool: src, amount: -total }],
                                   net: a.net, ts: a.ts, result: { ok: true, key: mk, balances: a.after } });
    await P._inTx.bumpRev();
  } else {
    throw new Refuse(400, "Bad pool.", "E_BAD_LEGS");
  }
  const ledger = require("../ledger");
  const paid = [];
  for (const p of pay) {
    let uid = p.userId;
    if (!uid && p.user) uid = ((await accountFor({ username: p.user })) || {}).userId;
    if (!uid && p.nick) uid = ((await accountFor({ login: p.nick })) || {}).userId;
    if (!uid) throw new Refuse(404, `Couldn't find the account to pay (${p.user || p.nick}).`, "E_TARGET_NOT_FOUND", { payee: p.user || p.nick });
    const c = await ledger.post(uid, p.amount, p.reason, { resolveMerged: true, counterparty: p.cp || undefined, source: `escrow:${src}` });
    if (!c.ok) throw new Refuse(404, `Couldn't find the account to pay (${p.user || p.nick}).`, "E_TARGET_NOT_FOUND", { payee: p.user || p.nick });
    paid.push({ user_id: c.userId, nick: p.nick, user: p.user, amount: p.amount, reason: p.reason, txid: c.transactionId });
  }
  return { ok: true, pool: src, total, paid };
}

// ── the keyed bot calls (one transaction each; a key seen before answers its first result) ──
function keyed(op, fn) {
  return async (body) => {
    await requireLive();
    const key = checkKey(body && body.key);
    return tx(async () => {
      const dup = await seen(key);
      if (dup) return dup;
      const res = await fn(body, key);
      const out = Object.assign({ ok: true, key, op }, res);
      await record(key, { op, ref: res.ref || (body && body.ref), amount: res.amount || res.held || res.total || 0, via: body.via || "pepe", result: out });
      await bumpRev();
      return out;
    });
  };
}

const hold = keyed("hold", async (b, key) => {
  const account = await accountFor({ userId: b.userId, username: b.username, login: b.login || b.nick });
  const r = await holdInTx({ key, hid: b.hid, account, login: b.login || b.nick, amount: b.amount, ref: b.ref, reason: b.reason, cp: b.cp,
                             via: "pepe", casino: !!b.casino });
  return { hid: r.hid, txid: r.txid, user: r.user, amount: Math.floor(Number(b.amount)), ref: String(b.ref) };
});
// A stake a site game engine took (via "site") belongs to that engine while its game is live here: Pepe's ledger calls can't
// refund or spend it (his local restart scans see it in his mirror). After that game's rollback it is his to move.
const GAME_OF = { W: "wagers", BT: "bounties", M: "pools", L: "loans" };
async function guardSiteHolds(ids) {
  for (const id of ids) {
    const h = (await getQuery("SELECT ref, kind, via FROM escrow_holds WHERE id = ?", [String(id)]))[0];
    if (h && isServiceKind(h.kind)) throw new Refuse(409, `hold ${id} (${h.ref}) belongs to a site service`, "E_SITE_HOLD", { hold: String(id), game: "creators" });
    const game = h && GAME_OF[h.kind];
    if (h && h.via === "site" && game && (await meta(`live:${game}`))) {
      throw new Refuse(409, `hold ${id} (${h.ref}) belongs to the site's ${game} engine`, "E_SITE_HOLD", { hold: String(id), game });
    }
  }
}
const refund = keyed("refund", async (b, key) => {
  await guardSiteHolds([b.hid]);
  const r = await refundInTx({ key, hid: b.hid, reason: b.reason });
  return Object.assign(r, { ref: b.ref });
});
const settle = keyed("settle", async (b, key) => {
  await guardSiteHolds(Array.isArray(b.hids) ? b.hids : []);
  const r = await settleInTx({ key, hids: b.hids, payouts: b.payouts, fees: b.fees, ref: b.ref });
  return Object.assign(r, { ref: b.ref });
});
const grant = keyed("grant", async (b, key) => {
  const r = await grantInTx({ key, pool: b.pool, payouts: b.payouts, ref: b.ref });
  return Object.assign(r, { ref: b.ref, amount: r.total });
});

/** The recorded answers for these keys (a lost answer is looked up here; null = never happened). */
async function status(keys) {
  await init();
  const out = {};
  for (const k of (Array.isArray(keys) ? keys : []).slice(0, 200)) {
    if (!validKey(k)) continue;
    const r = (await getQuery("SELECT result FROM escrow_moves WHERE key = ?", [String(k)]))[0];
    let v = null;
    if (r) { try { v = JSON.parse(r.result || "{}"); } catch (e) { v = { ok: true }; } }
    out[k] = v;
  }
  return out;
}

// ── supply: the held total is one row while the escrow is live ──
async function supplyRows(rows) {
  if (!(await live())) {
    // not live: Pepe's rows carry his escrow; the site services' holds (left held after a rollback) are only here
    const sv = await heldTotal("service").catch(() => ({ amount: 0 }));
    if (!(sv.amount > 0)) return rows;
    return (rows || []).filter((p) => String(p.key || "") !== "escrow:service").concat([{ key: "escrow:service", label: "🔒 Escrow holds (PATV Creators, raffles)", amount: sv.amount }]);
  }
  const keep = (rows || []).filter((p) => String(p.key || "") !== "escrow:holds");
  const t = await heldTotal();
  if (t.amount > 0) keep.push({ key: "escrow:holds", label: "🔒 Escrow holds (games in progress)", amount: t.amount });
  return keep;
}

// ── the cutover: import (idempotent, verifies itself, rolls back on any mismatch) ──
const backupDb = (tag) => require("../dbbackup").backupDb(tag);
let supplyFn = null;

function parseExport(text) {
  let p;
  try { p = JSON.parse(text); } catch (e) { throw new Refuse(400, "payload is not JSON"); }
  if (!p || typeof p !== "object" || !Array.isArray(p.holds)) throw new Refuse(400, "payload has no holds");
  const seenIds = new Set();
  const holds = p.holds.map((h) => {
    const id = String(h && h.id || "");
    const amount = Number(h && h.amount);
    if (!HID_RE.test(id) || seenIds.has(id)) throw new Refuse(400, `bad / repeated hold id ${id.slice(0, 40)}`);
    seenIds.add(id);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Refuse(400, `hold ${id}: bad amount ${String(h.amount).slice(0, 20)}`);
    if (!REF_RE.test(String(h.ref || ""))) throw new Refuse(400, `hold ${id}: bad ref`);
    const uid = h.user_id ? String(h.user_id).slice(0, 64) : null;      // 1.99tc: Pepe sends the stable userId when he has it
    if (!h.user && !uid) throw new Refuse(400, `hold ${id}: no PATV account`);
    return { id, ref: String(h.ref), user: String(h.user || "").slice(0, 80), user_id: uid, nick: str(h.nick, 60), amount, reason: str(h.reason, 40), cp: str(h.cp, 60),
             ts: Number(h.ts) || null };
  });
  return { p, holds };
}

/**
 * Pepe's export -> escrow_holds, once. body: {key, payload (JSON text: {holds: [...], seq, supply}), digest (sha256 of payload),
 * totals: {sum, count, per_kind}}. Checks: switch on, the pools live here (fee legs), digest, totals, every account exists, no
 * hold already held here. Then a verified DB backup and ONE transaction: Pepe's fresh supply rows as the snapshot, the supply
 * total read, the holds written, sums re-read and compared, live on, the supply total read again (must not move by one PAT).
 */
async function importFromPepe(body) {
  await init();
  if (!(await enabled())) throw new Refuse(409, "the escrow backend is switched off on this site", "E_FEATURE_OFF");
  const key = checkKey(body && body.key);
  const payload = String((body && body.payload) || "");
  const digest = crypto.createHash("sha256").update(payload, "utf8").digest("hex");
  if (!payload || digest !== String(body.digest || "")) throw new Refuse(400, "digest mismatch", "E_DIGEST");
  const done = await meta("imported");
  if (done && done.key === key && !done.rolled_back) {
    if (done.digest === digest) return Object.assign({ ok: true, already: true }, done.answer || {});
    throw new Refuse(409, "this cutover key was already used with a different export", "E_ALREADY");
  }
  if (await live()) throw new Refuse(409, "the site already owns the escrow (another import)", "E_ALREADY");
  if (!(await require("../pools").live())) throw new Refuse(409, "the pools still live in Pepe - cut the pools over first (Phase 1)", "E_POOLS_NOT_LIVE");
  const { p, holds } = parseExport(payload);
  const sum = holds.reduce((t, h) => t + h.amount, 0);
  const tt = (body && body.totals) || {};
  if (sum !== Math.floor(Number(tt.sum)) || holds.length !== Math.floor(Number(tt.count))) {
    throw new Refuse(400, `totals don't match: ${sum} PAT in ${holds.length} holds vs ${tt.sum} / ${tt.count}`, "E_TOTALS");
  }
  const perKind = {};
  for (const h of holds) perKind[kindOf(h.ref)] = (perKind[kindOf(h.ref)] || 0) + h.amount;
  for (const [k, v] of Object.entries(tt.per_kind || {})) {
    if (Math.floor(Number(v)) !== (perKind[k] || 0)) throw new Refuse(400, `kind ${k}: ${perKind[k] || 0} vs ${v}`, "E_TOTALS");
  }
  for (const k of Object.keys(perKind)) if (Math.floor(Number((tt.per_kind || {})[k])) !== perKind[k]) throw new Refuse(400, `kind ${k}: ${perKind[k]} vs ${(tt.per_kind || {})[k]}`, "E_TOTALS");
  // 1.99tc: every hold's account - by userId when Pepe sent one, else the username, an OLD username resolved through the
  // username history / merge log when exactly one live account had it; an ambiguous name is refused, never guessed
  const missing = [], ambiguous = [], renamed = [];
  const accounts = {};
  const akey = (h) => `${h.user_id || ""}|${h.user.toLowerCase()}`;
  for (const h of holds) {
    if (accounts[akey(h)] !== undefined) continue;
    const r = await accountResolve({ userId: h.user_id, username: h.user }, { strict: true, at: h.ts ? Math.floor(h.ts * 1000) : null });
    accounts[akey(h)] = r.ok ? r.user : null;
    if (r.ok && h.user && r.user.username !== h.user) renamed.push(`${h.user} -> ${r.user.username}`);
    if (!r.ok && r.code === "E_AMBIGUOUS") ambiguous.push(r.error);
    else if (!r.ok) missing.push(h.user || h.user_id);
  }
  if (ambiguous.length) throw new Refuse(409, `ambiguous PATV account: ${ambiguous.slice(0, 5).join("; ")}`, "E_AMBIGUOUS", { ambiguous: ambiguous.slice(0, 50) });
  if (missing.length) throw new Refuse(409, `no PATV account for ${missing.slice(0, 10).join(", ")}`, "E_TARGET_NOT_FOUND", { missing: missing.slice(0, 50) });
  if (renamed.length) console.log(`[escrow] import: ${renamed.length} hold account(s) found under an old name: ${renamed.slice(0, 20).join(", ")}`);
  const held = await heldTotal("pepe");
  if (held.count) throw new Refuse(409, `the escrow table already holds ${held.amount} in ${held.count} hold(s)`, "E_NOT_EMPTY");
  const clash = holds.length ? await getQuery(`SELECT id FROM escrow_holds WHERE id IN (${holds.map(() => "?").join(",")})`, holds.map((h) => h.id)) : [];
  const supplyRowsIn = Array.isArray(p.supply) ? p.supply : null;
  if (supplyRowsIn) {
    const row = supplyRowsIn.find((r) => String(r.key) === "escrow:holds");
    const amt = row ? Math.floor(Number(row.amount) || 0) : 0;
    if (amt !== sum) throw new Refuse(400, `Pepe's supply row escrow:holds says ${amt}, the export ${sum}`, "E_SUPPLY");
  }
  const backup = await backupDb("pre-escrow-import");
  let answer;
  try {
    answer = await tx(async () => {
      if (await meta("live")) throw new Refuse(409, "already imported", "E_ALREADY");
      let before = null;
      if (supplyRowsIn && supplyFn) {
        const clean = supplyRowsIn.slice(0, 150).map((r) => ({ key: String(r.key || "").slice(0, 80), label: String(r.label || "").slice(0, 80),
                                                                amount: Math.max(0, Math.floor(Number(r.amount) || 0)) }));
        await runQuery("INSERT INTO supply_snapshot (id, pools, updated_at) VALUES (1, ?, CURRENT_TIMESTAMP) " +
                       "ON CONFLICT(id) DO UPDATE SET pools = excluded.pools, updated_at = CURRENT_TIMESTAMP", [JSON.stringify(clean)]);
        before = (await supplyFn()).total;
      }
      // ids used before (a hold that ended here before a rollback) are re-used by the returning stake: move the old row aside
      for (const c of clash) await runQuery("UPDATE escrow_holds SET id = id || '~' || ?, key = NULL WHERE id = ?", [String(now()), c.id]);
      const t = now();
      for (const h of holds) {
        const a = accounts[akey(h)];
        await runQuery(`INSERT INTO escrow_holds (id, key, ref, kind, login, username, user_id, amount, reason, cp, state, created, via)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, 'import')`,
                       [h.id, `import:${key}:${h.id}`, h.ref, kindOf(h.ref), h.nick || a.camfrogUsername || a.username, a.username, a.userId, h.amount,
                        h.reason, h.cp, h.ts ? Math.floor(h.ts * 1000) : t]);
      }
      const got = await heldTotal("pepe");
      if (got.amount !== sum || got.count !== holds.length) throw new Refuse(500, `the escrow holds ${got.amount} in ${got.count} after the import, not ${sum} in ${holds.length}`, "E_VERIFY");
      const kinds = await totalsByKind();
      for (const [k, v] of Object.entries(perKind)) if ((kinds[k] || {}).amount !== v) throw new Refuse(500, `kind ${k} reads ${(kinds[k] || {}).amount} after the import, not ${v}`, "E_VERIFY");
      const seq = Math.max(0, Math.floor(Number(p.seq) || 0));
      await setMeta("pepe_seq", seq);
      await setMeta("live", true);
      forgetLive();
      let after = null;
      if (before !== null) {
        after = (await supplyFn()).total;
        if (after !== before) throw new Refuse(500, `the supply total moved: ${before} before, ${after} after`, "E_SUPPLY");
      }
      const out = { total: sum, count: holds.length, per_kind: perKind, digest: digestOf(holds.map((h) => ({ id: h.id, ref: h.ref, user: h.user, amount: h.amount }))),
                    supply_before: before, supply_after: after, backup };
      await record("import:" + key, { op: "import", ref: "cutover", amount: sum, via: str(body.actor, 40) || "pepe", result: Object.assign({ ok: true }, out) });
      await setMeta("imported", { key, digest, at: t, answer: out, actor: str(body.actor, 40) });
      await bumpRev();
      return out;
    });
  } catch (e) {
    forgetLive();
    if (e instanceof Refuse) { e.message += " - rolled back, nothing kept"; throw e; }
    throw e;
  }
  console.log(`[escrow] imported ${holds.length} hold(s) holding ${sum} PAT from Pepe (key ${key}, backup ${backup})`);
  return Object.assign({ ok: true }, answer);
}

/** Read-only: every held hold, sha256, totals (the runbook's before / after). */
async function exportState() {
  const hs = await holdsHeld();
  const t = await heldTotal("pepe");
  return { ok: true, live: await live(), enabled: await enabled(), games: await gamesState(), rev: await rev(), holds: hs, sum: t.amount, count: t.count,
           per_kind: Object.fromEntries(Object.entries(await totalsByKind()).map(([k, v]) => [k, v.amount])),
           digest: digestOf(hs), imported: await meta("imported") };
}

/**
 * Rollback (the reverse import): every held hold that no site engine owns goes back to Pepe in ONE keyed step - state
 * "returned", live off. Refused while a site game engine is live (roll those back first: their records + holds come home
 * with them). The answer is what Pepe writes back into escrow.json (journaled under the same key).
 */
async function rollbackToPepe({ key, actor }) {
  await init();
  key = checkKey(key);
  const mk = "rollback:" + key;
  const prev = (await status([mk]))[mk];
  if (prev) return Object.assign({}, prev, { dup: true });
  if (!(await live())) throw new Refuse(409, "the escrow isn't live here", "E_NOT_LIVE");
  const g = await gamesState();
  const busy = GAMES.filter((x) => g[x] && g[x].live);
  if (busy.length) throw new Refuse(409, `site games still live: ${busy.join(", ")} - roll those back first`, "E_GAMES_LIVE", { games: busy });
  const backup = await backupDb("pre-escrow-rollback");
  const out = await tx(async () => {
    const dup = await seen(mk);
    if (dup) return dup;
    const hs = await holdsHeld();
    const t = now();
    await runQuery(`UPDATE escrow_holds SET state = 'returned', done_at = ?, done_key = ? WHERE state = 'held' AND ${PEPE_SQL}`, [t, mk]);
    const rest = await heldTotal("pepe");
    if (rest.count) throw new Refuse(500, `the escrow still holds ${rest.amount} after the rollback`, "E_VERIFY");
    const sum = hs.reduce((a, h) => a + h.amount, 0);
    const res = { ok: true, key, holds: hs, sum, count: hs.length, digest: digestOf(hs), seq: (await meta("seq")) || 0, backup };
    await record(mk, { op: "rollback", ref: "rollback", amount: sum, via: str(actor, 40) || "pepe", result: res });
    await setMeta("live", false);
    const rb = (await meta("rollbacks")) || [];
    rb.push({ key, at: t, sum, count: hs.length, actor: str(actor, 40) });
    await setMeta("rollbacks", rb.slice(-20));
    const imp = await meta("imported");
    if (imp) await setMeta("imported", Object.assign({}, imp, { rolled_back: { key, at: t } }));
    await bumpRev();
    return res;
  });
  forgetLive();
  console.log(`[escrow] ROLLBACK ${key}: ${out.sum} PAT in ${out.count} hold(s) handed back to Pepe (backup ${backup})`);
  return out;
}

// ── the site game engines' switches (escrow/games.js owns the engines; this is just their state) ──
async function gamesState() {
  const out = {};
  for (const gm of GAMES) out[gm] = { enabled: await enabled(gm), live: !!(await meta(`live:${gm}`)) };
  return out;
}

// ── events for Pepe (announcements of what the site engines did) ──
async function emitInTx(game, kind, room, data) {
  await runQuery("INSERT INTO escrow_events (game, kind, room, data, ts) VALUES (?, ?, ?, ?, ?)",
                 [String(game), String(kind).slice(0, 40), str(room, 80), JSON.stringify(data || {}), now()]);
}
const waiters = new Set();
function wake() { for (const w of [...waiters]) w(); }
async function events(after, waitMs, games) {
  await init();
  if (Number(after) < 0) {                       // a client starting fresh: from now on (never the last 48 h replayed)
    const top0 = (await getQuery("SELECT COALESCE(MAX(id),0) AS m FROM escrow_events"))[0].m;
    return { events: [], cursor: top0 };
  }
  const a = Math.max(0, Math.floor(Number(after) || 0));
  const want = Array.isArray(games) && games.length ? games.map(String) : null;
  const q = async () => (await getQuery("SELECT id, game, kind, room, data, ts FROM escrow_events WHERE id > ? ORDER BY id LIMIT 200", [a]))
    .filter((e) => !want || want.includes(e.game))
    .map((e) => ({ id: e.id, game: e.game, kind: e.kind, room: e.room, ts: e.ts, data: (() => { try { return JSON.parse(e.data || "{}"); } catch (x) { return {}; } })() }));
  let rows = await q();
  if (!rows.length && waitMs > 0) {
    await new Promise((res) => {
      const done = () => { waiters.delete(done); clearTimeout(t); res(); };
      const t = setTimeout(done, Math.min(8000, waitMs));
      waiters.add(done);
    });
    rows = await q();
  }
  const top = (await getQuery("SELECT COALESCE(MAX(id),0) AS m FROM escrow_events"))[0].m;
  if (Math.random() < 0.02) runQuery("DELETE FROM escrow_events WHERE ts < ?", [now() - 48 * 3600000]).catch(() => {});
  return { events: rows, cursor: rows.length ? rows[rows.length - 1].id : (a > top ? top : a) };
}

// ── the admin view ──
async function adminView() {
  await init();
  const st = await exportState();
  const moves = await getQuery("SELECT key, op, ref, ts, amount, via FROM escrow_moves ORDER BY ts DESC, rowid DESC LIMIT 60");
  return Object.assign(st, { moves, rollbacks: (await meta("rollbacks")) || [], holds: st.holds.slice(0, 200) });
}

// ── routes ──
function register(app, { isBotToken, addUser, patSupply }) {
  if (patSupply) supplyFn = patSupply;
  init().catch((e) => console.error("[escrow] init:", e.message));
  const bot = (fn) => async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await fn(b)); } catch (e) {
      if (isRefuse(e)) return res.status(e.status).json(Object.assign({ ok: false, error: e.message, code: e.code }, e.extra || {}));
      console.error(`[escrow] ${req.path}:`, e);
      res.status(500).json({ ok: false, error: "server_error" });
    }
  };
  app.post("/api/escrow/bot/state", bot(async (b) => {
    const r = await rev();
    const base = { ok: true, live: await live(), enabled: await enabled(), games: await gamesState(), rev: r };
    if (b.since_rev !== undefined && Number(b.since_rev) === r) return Object.assign(base, { same: true });
    return Object.assign(base, { holds: base.live ? await holdsHeld() : [], held: await heldTotal("pepe") });
  }));
  app.post("/api/escrow/bot/hold", bot((b) => hold(b)));
  app.post("/api/escrow/bot/refund", bot((b) => refund(b)));
  app.post("/api/escrow/bot/settle", bot((b) => settle(b)));
  app.post("/api/escrow/bot/grant", bot((b) => grant(b)));
  app.post("/api/escrow/bot/status", bot(async (b) => ({ ok: true, results: await status(b.keys), holds: await holdsByIds(b.hids) })));
  // 1.99sy: the escrow export (escrow.json is ~1 MB on prod) is bigger than the global 100 KB JSON limit (index.js skips this path)
  app.post("/api/escrow/admin/import", require("express").json({ limit: "32mb" }), bot((b) => importFromPepe(b)));
  app.post("/api/escrow/admin/export", bot(() => exportState()));
  app.post("/api/escrow/admin/rollback", bot((b) => rollbackToPepe({ key: b.key, actor: b.actor })));

  const admin = async (req, res) => {
    if (!req.user || !req.user.userId) { res.status(401).json({ ok: false, error: "Sign in first." }); return null; }
    const row = (await getQuery("SELECT class, username FROM users WHERE userId = ?", [req.user.userId]).catch(() => []))[0];
    if (!SP.can(row, "econ.backend_cutover")) { res.status(403).json({ ok: false, error: "Admins only." }); return null; }
    return row;
  };
  app.get("/api/admin/escrow", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!(await admin(req, res))) return;
    try { res.json(await adminView()); } catch (e) { console.error("[escrow] admin view:", e); res.status(500).json({ ok: false, error: "failed" }); }
  });
  // the site switches: the ledger (before its import) or one game engine
  app.post("/api/admin/escrow-backend", addUser, async (req, res) => {
    const me = await admin(req, res);
    if (!me) return;
    if (req.get("X-Requested-With") !== "fetch" || !require("../middleware/authGuard").sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    const b = req.body || {};
    const game = b.game ? String(b.game) : null;
    if (game && !GAMES.includes(game)) return res.status(400).json({ ok: false, error: "unknown game" });
    if (game ? await meta(`live:${game}`) : await live()) {
      return res.status(409).json({ ok: false, error: "The site owns it now - roll back from Pepe (docs/escrow-cutover-runbook.md)." });
    }
    await setMeta(game ? `enabled:${game}` : "enabled", !!b.on);
    console.log(`[escrow] backend switch ${game || "ledger"} ${b.on ? "ON" : "OFF"} by ${me.username}`);
    res.json({ ok: true, enabled: await enabled(game || undefined), games: await gamesState() });
  });
}

module.exports = { init, register, enabled, live, rev, bumpRev, meta, setMeta, tx, seen, record, holdInTx, refundInTx, settleInTx, grantInTx,
                   hold, refund, settle, grant, status, holdsHeld, holdsByIds, heldTotal, totalsByKind, digestOf, supplyRows, importFromPepe,
                   exportState, rollbackToPepe, gamesState, SERVICE_KINDS, isServiceKind, emitInTx, wake, events, adminView, accountFor, accountResolve, kindOf, Refuse, isRefuse, GAMES,
                   _setSupplyFn: (f) => { supplyFn = f; }, _forgetLive: forgetLive };
