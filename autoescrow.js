// autoescrow.js — free rewards earned by a Camfrog AUTO account wait in escrow for six months
// (docs/auto-account-escrow.md, the user's idea of 2026-10-12).
//
// While the switch is on, a FREE reward (the kinds list: achievements, level-ups, activity rewards, raffles, top mic...)
// paid to an account autoaccount.isAutoAccount() calls an auto account is held here instead of landing in its wallet.
// The paying pool is debited exactly as before - only the destination changes, so supply is exact:
//   hold    pool -> auto_escrow           (credit(): the reward's own transaction id is the entry's key)
//   claim   auto_escrow -> the wallet     (release(): once the account is no longer an auto account - merged into a real
//                                          account by !verify / Connections, or given a sign-in method in place)
//   expire  auto_escrow -> the PAT Routing row "auto_escrow_expired" (default the Federal Reserve), six calendar months
//                                          (UTC) after each entry was earned
// Game winnings, tips, refunds and staff grants are never held (their kinds aren't on the list): an auto account that
// plays with its own PAT keeps what it wins. Balances from before the switch are never touched. The switch only controls
// NEW holds: off, every held entry is still claimable and still expires.
//
//   auto_escrow          id, key UNIQUE, user_id, login, amount (> 0), kind, source, earned_at, expires_at (ms),
//                        state held | claimed | expired, done_at, done_key, claimed_by, dest
//   auto_escrow_claims   id PK (= the wallet transaction id "aec-<userId>-<last entry id>"), user_id, amount, entries, via, at
//   auto_escrow_notices  user_id PK, last_at, last_entry - when Pepe last PM'd the person and up to which entry
//   auto_escrow_meta     key PK, value (JSON): enabled, enabled_by, kinds
//
// Bot routes (bot token): POST /api/autoescrow/notice-logins {password} -> the logins Pepe should PM when he sees them;
//                         POST /api/autoescrow/notified {password, login} -> he did.
// Admin: GET /api/admin/autoescrow, POST /api/admin/autoescrow/settings {enabled?, kinds?, note} (audit-logged).
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)
const AA = require("./autoaccount");

const FLOW = "auto_escrow_expired";             // the PAT Routing row for expired entries
const WINDOW_MONTHS = 6;
const NOTICE_GAP_MS = 7 * 86400000;             // Pepe reminds an account at most once a week (the user, 2026-10-12)...
const TICK_MS = 10 * 60000;                     // ...and the release sweep + expiry run every 10 minutes
const BATCH = 500;
const CLAIM_TYPE = "Claimed: PAT earned in chat";
// The free rewards (site payout flows + Pepe's /api/bonus/chatwinner types). Admin-editable (meta "kinds").
// The user's decision (2026-10-12): ONLY achievements and level-ups to start with (the site's achievement payouts, its level-up
// rewards + milestones, Pepe's level-up bonus). Raffles, top mic, activity rewards, !beg... stay spendable until an admin adds them.
const DEFAULT_KINDS = Object.freeze(["achievements", "levelup", "level-up-bonus"]);
// ACTIVITY (the user, 2026-10-12): any of it resets the expiry of ALL the account's held entries to WINDOW_MONTHS after it.
//   * spending its own PAT - every debit of the wallet (ledger.post < 0): a spin, a bet, a game stake, a tip sent, a purchase, a
//     paid command (touchSoon from ledger.js)
//   * chat / mic - Pepe reports a held login that spoke or took the mic (POST /api/autoescrow/seen), and these credits, which
//     only go to someone active: activity rewards, top mic, !beg, trivia / pictionary wins, the moan bonus
//   * earning a held reward (a level-up or an achievement comes from being there)
// Debounced: at most one reset per account per UTC day (ACTIVITY_DEBOUNCE_MS). Being in a room's user list is NOT activity.
const ACTIVITY_KINDS = Object.freeze(["activity-reward", "mic-hourly", "beg", "camfrog-trivia", "pictionary-win", "moan-bonus"]);
const CLAIM_TTL_MS = 30 * 60000;                // a claim link works for 30 minutes, once
const CLAIM_PER_HOUR = 5;                       // claim links per login per hour
const KIND_RE = /^[A-Za-z0-9_:.\-]{1,40}$/;

let ready = null;
let inited = false;                              // init() finished (touchSoon never starts it: see there)
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS auto_escrow (
        id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, login TEXT, amount INTEGER NOT NULL CHECK (amount > 0),
        kind TEXT, source TEXT, earned_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'held',
        done_at INTEGER, done_key TEXT, claimed_by TEXT, dest TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS auto_escrow_user ON auto_escrow (user_id, state)");
      await runQuery("CREATE INDEX IF NOT EXISTS auto_escrow_due ON auto_escrow (state, expires_at)");
      await runQuery(`CREATE TABLE IF NOT EXISTS auto_escrow_claims (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, amount INTEGER NOT NULL, entries INTEGER NOT NULL, via TEXT, at INTEGER NOT NULL)`);
      await runQuery("CREATE TABLE IF NOT EXISTS auto_escrow_notices (user_id TEXT PRIMARY KEY, last_at INTEGER, last_entry INTEGER)");
      await runQuery("CREATE TABLE IF NOT EXISTS auto_escrow_meta (key TEXT PRIMARY KEY, value TEXT)");
      // the one-click claim links Pepe PMs (!signup): only the SHA-256 of the token is kept; one use, CLAIM_TTL_MS
      await runQuery(`CREATE TABLE IF NOT EXISTS auto_escrow_claimlinks (
        token_hash TEXT PRIMARY KEY, login TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, used_at INTEGER, used_by TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS auto_escrow_claimlinks_login ON auto_escrow_claimlinks (login, created)");
      await AA.ensure();
      inited = true;
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch (e) { return d; } };
async function meta(key, dflt = null) {
  await init();
  const r = (await getQuery("SELECT value FROM auto_escrow_meta WHERE key = ?", [key]))[0];
  return r ? J(r.value, dflt) : dflt;
}
async function setMeta(key, value) {
  await init();
  await runQuery("INSERT INTO auto_escrow_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, JSON.stringify(value)]);
}
const enabled = async () => (await meta("enabled", false)) === true;
async function kinds() {
  const k = await meta("kinds", null);
  return new Set(Array.isArray(k) ? k : DEFAULT_KINDS);
}

/** ms + n calendar months, UTC; the day is clamped to the target month's last day (31 Aug + 6 -> 28/29 Feb). */
function addMonthsUTC(ms, n) {
  const d = new Date(ms);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(day, last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}
const expiryOf = (earnedMs) => addMonthsUTC(earnedMs, WINDOW_MONTHS);

// ── the hold ──
/**
 * ledger.post() for a reward, with the escrow in front of it. A positive `amount` of a held KIND (opts.kind: the payout
 * flow or Pepe's credit type) for an auto account, while the switch is on, becomes an auto_escrow entry keyed by
 * opts.transactionId (a retry is held once); anything else goes to ledger.post unchanged.
 * -> ledger.post's answer, or {ok:true, userId, transactionId, escrowed:true, entryId, expires_at}.
 */
async function credit(userId, amount, type, opts = {}) {
  const ledger = require("./ledger");
  const amt = Math.trunc(Number(amount));
  if (!(amt > 0) || !opts.kind) return ledger.post(userId, amount, type, opts);
  await init();
  if (ACTIVITY_KINDS.includes(String(opts.kind))) touchSoon(userId, "credit:" + opts.kind);
  if (!(await enabled()) || !(await kinds()).has(String(opts.kind))) return ledger.post(userId, amount, type, opts);
  let target = userId ? String(userId) : null;
  if (opts.resolveMerged && target && !(await ledger.userExists(target))) target = await ledger.resolveUserId(target);
  if (!target || !(await AA.isAutoAccount(target))) return ledger.post(userId, amount, type, opts);
  const key = String(opts.transactionId || require("uuid").v4());
  const now = Number(opts.now) || Date.now();
  const hold = async () => {
    const u = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [target]))[0];
    if (!u) return { ok: false, code: ledger.E_TARGET_NOT_FOUND, userId: target };
    const exp = expiryOf(now);
    // earning is activity: every entry still inside its window moves to the same date (never backwards)
    await runQuery("UPDATE auto_escrow SET expires_at = ? WHERE user_id = ? AND state = 'held' AND expires_at > ? AND expires_at < ?", [exp, target, now, exp]);
    await runQuery(`INSERT INTO auto_escrow (key, user_id, login, amount, kind, source, earned_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(key) DO NOTHING`,
                   [key, target, u.camfrogUsername ? String(u.camfrogUsername).toLowerCase().trim().slice(0, 64) : null, amt,
                    String(opts.kind).slice(0, 40), String(type || opts.kind).slice(0, 80), now, exp]);
    const row = (await getQuery("SELECT id, expires_at FROM auto_escrow WHERE key = ?", [key]))[0];
    return { ok: true, userId: target, transactionId: key, escrowed: true, entryId: row.id, expires_at: row.expires_at };
  };
  const out = await tx(hold);
  if (out.ok) console.log(`[autoescrow] held ${amt} (${opts.kind}) for auto account ${target} until ${new Date(out.expires_at).toISOString().slice(0, 10)}`);
  return out;
}

/** What is waiting for this account: {amount, entries, next_expiry, last_expiry}. Entries past their date don't count. */
async function waiting(userId, { now = Date.now() } = {}) {
  await init();
  const r = (await getQuery(`SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS t, MIN(expires_at) AS nx, MAX(expires_at) AS lx FROM auto_escrow
                             WHERE user_id = ? AND state = 'held' AND expires_at > ?`, [String(userId || ""), now]))[0] || {};
  return { amount: Number(r.t) || 0, entries: Number(r.n) || 0, next_expiry: r.nx || null, last_expiry: r.lx || null };
}

// ── the claim ──
/**
 * Release everything held for `userId` once it is no longer an auto account: one wallet row (deterministic id, so a
 * second release of the same entries is impossible), the entries -> claimed, a claims row, then an inbox notice.
 * -> {released: n, amount, claimId} | {released: 0, reason}
 */
async function release(userId, { via = "sweep", now = Date.now() } = {}) {
  await init();
  const id = String(userId || "");
  if (!id) return { released: 0, reason: "no account" };
  if (await AA.isAutoAccount(id)) return { released: 0, reason: "still an auto account" };
  const ledger = require("./ledger");
  const out = await tx(async () => {
    const rows = await getQuery("SELECT id, amount FROM auto_escrow WHERE user_id = ? AND state = 'held' AND expires_at > ? ORDER BY id", [id, now]);
    if (!rows.length) return { released: 0, reason: "nothing waiting" };
    if (!(await ledger.userExists(id))) return { released: 0, reason: "no account" };
    const last = rows[rows.length - 1].id;
    const amount = rows.reduce((s, r) => s + Number(r.amount), 0);
    const claimId = `aec-${id}-${last}`.slice(0, 120);
    const u = await runQuery(`UPDATE auto_escrow SET state = 'claimed', done_at = ?, done_key = ?, claimed_by = ?
                              WHERE user_id = ? AND state = 'held' AND expires_at > ? AND id <= ?`, [now, claimId, id, id, now, last]);
    if (!u || u.changes !== rows.length) throw new Error(`autoescrow: ${rows.length} entries to claim, ${u && u.changes} changed`);
    const posted = await ledger.post(id, amount, CLAIM_TYPE, { transactionId: claimId, note: `${rows.length} reward(s) earned in chat`, source: "autoescrow" });
    if (!posted.ok) throw new Error(`autoescrow: claim credit refused (${posted.code})`);
    await runQuery("INSERT INTO auto_escrow_claims (id, user_id, amount, entries, via, at) VALUES (?, ?, ?, ?, ?, ?)",
                   [claimId, id, amount, rows.length, String(via).slice(0, 40), now]);
    return { released: rows.length, amount, claimId };
  });
  if (out.released) {
    console.log(`[autoescrow] released ${out.amount} (${out.released} entries) to ${id} (${via})`);
    const fmt = Number(out.amount).toLocaleString("en-US");
    await require("./inbox").addSafe(id, { kind: "system", title: `You had PAT ${fmt} waiting from chat`,
      body: `PAT ${fmt} you earned in Camfrog chat (${out.released} reward${out.released === 1 ? "" : "s"}) was waiting for you to claim it. It's in your wallet now.`,
      link: "/wallet", ref: `autoescrow:${out.claimId}` });
  }
  return out;
}
async function releaseSafe(userId, via) {
  try { return await release(userId, { via }); } catch (e) { console.error("[autoescrow] release:", e.message); return { released: 0, error: e.message }; }
}

/** Every account with held entries: follow merged-away ids (account_merges), release the ones that aren't auto any more. */
async function sweep({ now = Date.now() } = {}) {
  await init();
  const ledger = require("./ledger");
  let released = 0, moved = 0;
  const ids = (await getQuery("SELECT DISTINCT user_id FROM auto_escrow WHERE state = 'held' AND expires_at > ?", [now])).map((r) => r.user_id);
  for (const id of ids) {
    try {
      let who = id;
      if (!(await ledger.userExists(id))) {
        const to = await ledger.resolveUserId(id);
        if (!to) continue;                                  // gone for good: the entries expire on their own date
        const m = await runQuery("UPDATE auto_escrow SET user_id = ? WHERE user_id = ? AND state = 'held'", [to, id]);
        moved += (m && m.changes) || 0;
        who = to;
      }
      if (await AA.isAutoAccount(who)) continue;
      const r = await release(who, { via: "sweep", now });
      released += r.released || 0;
    } catch (e) { console.error(`[autoescrow] sweep ${id}:`, e.message); }
  }
  return { accounts: ids.length, released, moved };
}

// ── the expiry ──
/** The routing row's shares: the admin's override, else Pepe's catalog default, else the Fed 100%. */
async function shares() {
  try {
    const st = await require("./econstore").getSettings();
    if (st && st.pat_routes && Array.isArray(st.pat_routes[FLOW])) return st.pat_routes[FLOW];
  } catch (e) { /* no econ store yet */ }
  try {
    const row = (await getQuery("SELECT data FROM econ_catalog WHERE id = 1"))[0];
    const d = J(row && row.data, null);
    const def = d && d.routes && d.routes[FLOW] && d.routes[FLOW].default;
    if (Array.isArray(def) && def.length) return def;
  } catch (e) { /* no catalog yet */ }
  return [["incentives", 100]];                 // the user (2026-10-12): unclaimed PAT refills the incentive budget it mostly came from
}
/** amount by shares -> [[dest, amount]], the rest to the Fed. A destination that isn't a pool or the House -> the Fed. */
function split(sh, amount) {
  const P = require("./pools");
  const out = new Map();
  let used = 0;
  for (const s of sh || []) {
    let d = String((s || [])[0] || ""), p = Number((s || [])[1]);
    if (!d || !(p > 0)) continue;
    if (d === "house") d = "jackpot";
    if (d === "lotto" || d === "burn") d = "reserve";             // never a lotto service's pot; burning is the burn engine's
    if (d !== "jackpot" && !(P.isPool ? P.isPool(d) : /^[a-z][a-z0-9_]{0,31}$/.test(d))) d = "reserve";
    const a = Math.floor(amount * Math.min(p, 100) / 100);
    if (a > 0 && used + a <= amount) { out.set(d, (out.get(d) || 0) + a); used += a; }
  }
  if (amount - used > 0) out.set("reserve", (out.get("reserve") || 0) + amount - used);
  return [...out.entries()];
}

/** Every held entry past its date -> the routing row, in keyed batches. Idempotent; independent of when it runs. */
async function expire({ now = Date.now() } = {}) {
  await init();
  const P = require("./pools");
  let total = 0, entries = 0;
  for (let round = 0; round < 20; round++) {
    const rows = await getQuery("SELECT id, amount FROM auto_escrow WHERE state = 'held' AND expires_at <= ? ORDER BY id LIMIT ?", [now, BATCH]);
    if (!rows.length) break;
    const sh = await shares();
    const live = await P.live().catch(() => false);
    const r = await tx(async () => {
      // the batch as it stands inside the transaction (a claim may have taken some since the look above)
      const ids = rows.map((x) => x.id);
      const inTx = await getQuery(`SELECT id, amount FROM auto_escrow WHERE state = 'held' AND expires_at <= ? AND id IN (${ids.map(() => "?").join(",")})`, [now, ...ids]);
      if (!inTx.length) return { n: 0, amount: 0 };
      const key = `aex-${inTx[0].id}-${inTx[inTx.length - 1].id}`;
      const amount = inTx.reduce((s, x) => s + Number(x.amount), 0);
      const legs = split(sh, amount);
      const dest = legs.map(([d, a]) => `${d}:${a}`).join(",").slice(0, 200);
      const u = await runQuery(`UPDATE auto_escrow SET state = 'expired', done_at = ?, done_key = ?, dest = ?
                                WHERE state = 'held' AND expires_at <= ? AND id IN (${inTx.map(() => "?").join(",")})`, [now, key, dest, now, ...inTx.map((x) => x.id)]);
      if (!u || u.changes !== inTx.length) throw new Error(`autoescrow: expiry batch ${key} changed ${u && u.changes} of ${inTx.length}`);
      const poolLegs = [];
      for (const [d, a] of legs) {
        if (d === "jackpot") {
          await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)", [`${key}:house`, `autoescrow:${FLOW}`, null, a]);
        } else if (live) {
          poolLegs.push({ pool: d, amount: a });
        } else {
          // the pools still live in Pepe: a negative website claim, credited to the Reserve by his funding tick
          await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES (?, ?, ?, ?, ?)",
                         [`${key}:${d}`, FLOW, null, "unclaimed chat-account escrow", -a]);
        }
      }
      if (poolLegs.length && !(await P._inTx.seen(key))) {
        const a = await P._inTx.applyLegs(key, poolLegs, { kind: "move", flow: FLOW, why: "unclaimed chat-account escrow (6 months)", via: "site" });
        await P._inTx.recordMove(key, { kind: "move", flow: FLOW, why: "unclaimed chat-account escrow (6 months)", via: "site", legs: poolLegs,
                                        net: a.net, ts: a.ts, result: { ok: true, key, balances: a.after } });
        await P._inTx.bumpRev();
      }
      return { n: inTx.length, amount, key, legs };
    });
    if (!r.n) break;
    entries += r.n; total += r.amount;
    console.log(`[autoescrow] expired ${r.n} entries / ${r.amount} PAT -> ${r.legs.map(([d, a]) => `${d} ${a}`).join(", ")} (${r.key})`);
    if (rows.length < BATCH) break;
  }
  return { entries, amount: total };
}

let ticking = null;
/** The release sweep, then the expiry. One at a time; never throws. */
function tick(opts = {}) {
  if (ticking) return ticking;
  ticking = (async () => {
    const out = {};
    try { out.sweep = await sweep(opts); } catch (e) { console.error("[autoescrow] sweep:", e.message); }
    try { out.expire = await expire(opts); } catch (e) { console.error("[autoescrow] expire:", e.message); }
    return out;
  })().finally(() => { ticking = null; });
  return ticking;
}

// ── supply: the held total is its own row ──
async function heldTotal() {
  await init();
  const r = (await getQuery("SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS a, COALESCE(SUM(amount), 0) AS t FROM auto_escrow WHERE state = 'held'"))[0] || {};
  return { amount: Number(r.t) || 0, entries: Number(r.n) || 0, accounts: Number(r.a) || 0 };
}
async function supplyRows(rows) {
  const keep = (rows || []).filter((p) => String(p.key || "") !== "auto_escrow");
  const t = await heldTotal();
  if (t.amount > 0) keep.push({ key: "auto_escrow", label: "⏳ Earned in chat, waiting to be claimed (6 months)", amount: t.amount });
  return keep;
}

// ── activity: the window is "WINDOW_MONTHS after the account's last activity" ──
const touched = new Map();                      // userId -> the UTC day it was last reset (the debounce)
const ACTIVITY_DEBOUNCE_MS = 86400000;
/**
 * Activity by this account: every held entry still inside its window now expires WINDOW_MONTHS after `now` (never earlier than
 * it already did; an entry past its date stays past it). At most once per account per UTC day. -> entries moved.
 */
async function touch(userId, { now = Date.now(), why = null, force = false } = {}) {
  const id = String(userId || "");
  if (!id) return 0;
  const day = Math.floor(now / ACTIVITY_DEBOUNCE_MS);
  if (!force && touched.get(id) === day) return 0;
  touched.set(id, day);
  if (touched.size > 50000) touched.clear();
  await init();
  const exp = expiryOf(now);
  const r = await runQuery("UPDATE auto_escrow SET expires_at = ? WHERE user_id = ? AND state = 'held' AND expires_at > ? AND expires_at < ?", [exp, id, now, exp]);
  const n = (r && r.changes) || 0;
  if (n) console.log(`[autoescrow] activity (${why || "?"}) by ${id}: ${n} held reward(s) now expire ${new Date(exp).toISOString().slice(0, 10)}`);
  return n;
}
/** touch() later, never throws, never inside the caller's transaction (ledger.js calls it on every debit). */
function touchSoon(userId, why) {
  const id = String(userId || "");
  if (!id) return;
  if (touched.get(id) === Math.floor(Date.now() / ACTIVITY_DEBOUNCE_MS)) return;      // the cheap path: already today
  // never the one to start init(): its table writes would queue behind (and then inside) whatever transaction is open - the
  // site's boot (register) initialises it; until then there is nothing held to move anyway
  if (!inited) return;
  setImmediate(() => { touch(id, { why }).catch((e) => console.error("[autoescrow] activity:", e.message)); });
}
/** Pepe saw this login speak or take the mic. -> {ok, moved} */
async function seen(login, { now = Date.now() } = {}) {
  await init();
  const u = (await getQuery("SELECT userId FROM users WHERE lower(trim(camfrogUsername)) = ? LIMIT 1", [String(login || "").toLowerCase().trim()]))[0];
  if (!u) return { ok: false, moved: 0 };
  return { ok: true, moved: await touch(u.userId, { now, why: "chat" }) };
}
/** Every login with something held (Pepe reports chat / mic activity only for these). */
async function heldLogins({ now = Date.now(), limit = 5000 } = {}) {
  await init();
  return (await getQuery(`SELECT DISTINCT lower(trim(u.camfrogUsername)) AS l FROM auto_escrow e JOIN users u ON u.userId = e.user_id
                          WHERE e.state = 'held' AND e.expires_at > ? AND u.camfrogUsername IS NOT NULL AND trim(u.camfrogUsername) != '' LIMIT ?`,
                         [now, limit])).map((r) => r.l);
}

// ── Pepe's PMs ──
/** Auto accounts with something held and no reminder in the last NOTICE_GAP_MS (a week). `fresh` = held since the last one. */
async function noticeLogins({ now = Date.now(), limit = 500 } = {}) {
  await init();
  const rows = await getQuery(`
    SELECT e.user_id, u.camfrogUsername AS login, SUM(e.amount) AS waiting, MIN(e.expires_at) AS next_expiry, MAX(e.id) AS last_entry,
           SUM(CASE WHEN e.id > COALESCE(n.last_entry, 0) THEN e.amount ELSE 0 END) AS fresh
    FROM auto_escrow e JOIN users u ON u.userId = e.user_id LEFT JOIN auto_escrow_notices n ON n.user_id = e.user_id
    WHERE e.state = 'held' AND e.expires_at > ? AND u.camfrogUsername IS NOT NULL AND trim(u.camfrogUsername) != ''
      AND (n.last_at IS NULL OR n.last_at <= ?)
    GROUP BY e.user_id HAVING waiting > 0 ORDER BY MAX(e.earned_at) DESC LIMIT ?`, [now, now - NOTICE_GAP_MS, limit]);
  const out = [];
  for (const r of rows) {
    if (!(await AA.isAutoAccount(r.user_id))) continue;     // claimed in place: the sweep releases it, no PM
    out.push({ login: String(r.login).toLowerCase().trim(), waiting: Number(r.waiting) || 0, fresh: Number(r.fresh) || 0,
               next_expiry: r.next_expiry, upto: r.last_entry });
  }
  return out;
}
/** Pepe PM'd this login: remember when, and up to which entry (`upto`, else everything held now). */
async function notified(login, { now = Date.now(), upto = null } = {}) {
  await init();
  const u = (await getQuery("SELECT userId FROM users WHERE lower(trim(camfrogUsername)) = ? LIMIT 1", [String(login || "").toLowerCase().trim()]))[0];
  if (!u) return false;
  const last = Number(upto) || Number(((await getQuery("SELECT MAX(id) AS m FROM auto_escrow WHERE user_id = ?", [u.userId]))[0] || {}).m) || 0;
  await runQuery(`INSERT INTO auto_escrow_notices (user_id, last_at, last_entry) VALUES (?, ?, ?)
                  ON CONFLICT(user_id) DO UPDATE SET last_at = excluded.last_at, last_entry = MAX(COALESCE(auto_escrow_notices.last_entry, 0), excluded.last_entry)`,
                 [u.userId, now, last]);
  return true;
}

// ── the one-click claim link (!signup / !claim in chat) ──
// Pepe knows who typed the command (the Camfrog chat author), exactly as !verify trusts him; the token he PMs to that login is
// the proof. On the website the token lets a SIGNED-IN account take that login (user.controller.completeCamfrogLink - the same
// merge !verify runs: the auto account's wallet, XP, badges and escrow move, then the escrow is released). One use, 30 minutes,
// hashed at rest, at most CLAIM_PER_HOUR per login; never for a login a REAL account already holds (that one uses !verify).
const sha = (t) => require("crypto").createHash("sha256").update(String(t)).digest("hex");
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
function siteBase() {
  return String(process.env.PUBLIC_BASE_URL || process.env.SITE_URL || (process.env.STAGING ? "https://staging.publicaccess.tv" : "https://publicaccess.tv")).replace(/\/+$/, "");
}
/** Who holds this login now: {state: "none" | "auto" | "linked", user} */
async function loginState(login) {
  const l = String(login || "").toLowerCase().trim();
  const u = (await getQuery("SELECT userId, username, points_balance FROM users WHERE lower(trim(camfrogUsername)) = ? LIMIT 1", [l]))[0];
  if (!u) return { state: "none", user: null };
  return { state: (await AA.isAutoAccount(u.userId)) ? "auto" : "linked", user: u };
}
/** Pepe: a claim link for the login that typed !signup. -> {ok, state, url?, waiting, wallet, username?, error?} */
async function claimLink(login, { now = Date.now() } = {}) {
  await init();
  const l = String(login || "").toLowerCase().trim();
  if (!l || l.length > 64) return { ok: false, error: "bad login" };
  const st = await loginState(l);
  if (st.state === "linked") return { ok: true, state: "linked", username: st.user.username };
  const recent = (await getQuery("SELECT COUNT(*) AS n FROM auto_escrow_claimlinks WHERE login = ? AND created > ?", [l, now - 3600000]))[0].n;
  if (recent >= CLAIM_PER_HOUR) return { ok: false, state: st.state, error: "too many links - try again in an hour" };
  const token = require("crypto").randomBytes(24).toString("base64url");
  await tx(async () => {
    // a new link replaces the login's older unused ones
    await runQuery("UPDATE auto_escrow_claimlinks SET expires = ? WHERE login = ? AND used_at IS NULL AND expires > ?", [now, l, now]);
    await runQuery("INSERT INTO auto_escrow_claimlinks (token_hash, login, created, expires) VALUES (?, ?, ?, ?)", [sha(token), l, now, now + CLAIM_TTL_MS]);
  });
  const w = st.user ? await waiting(st.user.userId, { now }) : { amount: 0 };
  return { ok: true, state: st.state, url: `${siteBase()}/claim/${token}`, waiting: w.amount,
           wallet: st.user ? Math.floor(Number(st.user.points_balance) || 0) : 0, minutes: CLAIM_TTL_MS / 60000 };
}
/** The claim page: what the token is for (null = unknown / used / expired). */
async function claimInfo(token, { now = Date.now() } = {}) {
  if (!TOKEN_RE.test(String(token || ""))) return null;
  await init();
  const r = (await getQuery("SELECT login, expires, used_at FROM auto_escrow_claimlinks WHERE token_hash = ?", [sha(token)]))[0];
  if (!r || r.used_at || r.expires <= now) return null;
  const st = await loginState(r.login);
  const w = st.user && st.state === "auto" ? await waiting(st.user.userId, { now }) : { amount: 0, next_expiry: null };
  return { login: r.login, state: st.state, linkedTo: st.state === "linked" ? st.user.username : null, waiting: w.amount,
           wallet: st.user && st.state === "auto" ? Math.floor(Number(st.user.points_balance) || 0) : 0, next_expiry: w.next_expiry || null,
           expires: r.expires };
}
/**
 * A signed-in account takes the token's login. The token is spent atomically FIRST (a second use finds it used), then the
 * login is linked with !verify's merge. -> {ok, login, merged, addedBalance, released} | {ok:false, error}
 */
async function redeemClaim(token, me, { now = Date.now(), link = null } = {}) {
  const AGAIN = "This link has expired or was already used. Type !signup in chat for a new one.";
  if (!TOKEN_RE.test(String(token || ""))) return { ok: false, error: AGAIN };
  if (!me || !me.userId) return { ok: false, error: "Sign in first." };
  await init();
  if (await AA.isAutoAccount(me.userId)) return { ok: false, error: "Sign in to your own PATV account first." };
  const h = sha(token);
  const r = (await getQuery("SELECT login, expires, used_at FROM auto_escrow_claimlinks WHERE token_hash = ?", [h]))[0];
  if (!r || r.used_at || r.expires <= now) return { ok: false, error: AGAIN };
  const st = await loginState(r.login);
  if (st.state === "linked" && st.user.userId !== me.userId) {
    return { ok: false, error: `${r.login} is already linked to another PATV account. To move it, use Edit profile → Connections and !verify.` };
  }
  const spent = await runQuery("UPDATE auto_escrow_claimlinks SET used_at = ?, used_by = ? WHERE token_hash = ? AND used_at IS NULL AND expires > ?", [now, String(me.userId), h, now]);
  if (!spent || spent.changes !== 1) return { ok: false, error: AGAIN };
  const doLink = link || ((uid, l) => require("./user.controller").completeCamfrogLink(uid, l));
  const held = st.user && st.state === "auto" ? (await waiting(st.user.userId, { now })).amount : 0;   // what the merge brings
  let res;
  try { res = await doLink(String(me.userId), r.login); }
  catch (e) {
    await runQuery("UPDATE auto_escrow_claimlinks SET used_at = NULL, used_by = NULL WHERE token_hash = ? AND used_by = ?", [h, String(me.userId)]).catch(() => {});
    throw e;                                       // the link still works for a retry
  }
  const rel = await releaseSafe(me.userId, "claim link");          // afterMerge already did it when there was a merge: a no-op then
  const released = Math.max(held, rel.amount || 0);
  console.log(`[autoescrow] claim link: ${r.login} -> ${me.username || me.userId} (merged ${!!(res && res.merged)}, released ${released})`);
  return { ok: true, login: r.login, merged: !!(res && res.merged), addedBalance: (res && res.addedBalance) || 0, released };
}

// ── admin ──
async function adminView({ now = Date.now() } = {}) {
  await init();
  const held = await heldTotal();
  const soon = (await getQuery(`SELECT COUNT(*) AS n, COUNT(DISTINCT user_id) AS a, COALESCE(SUM(amount), 0) AS t FROM auto_escrow
                                WHERE state = 'held' AND expires_at <= ?`, [now + 30 * 86400000]))[0] || {};
  const top = await getQuery(`SELECT e.user_id, u.username, u.camfrogUsername AS login, SUM(e.amount) AS amount, COUNT(*) AS entries, MIN(e.expires_at) AS next_expiry
                              FROM auto_escrow e LEFT JOIN users u ON u.userId = e.user_id WHERE e.state = 'held'
                              GROUP BY e.user_id ORDER BY amount DESC LIMIT 15`);
  const byKind = await getQuery("SELECT kind, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS t FROM auto_escrow WHERE state = 'held' GROUP BY kind ORDER BY t DESC");
  const months = await getQuery(`SELECT strftime('%Y-%m', done_at / 1000, 'unixepoch') AS month, state, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS t
                                 FROM auto_escrow WHERE state IN ('claimed', 'expired') GROUP BY month, state ORDER BY month DESC LIMIT 24`);
  const earned = await getQuery(`SELECT strftime('%Y-%m', earned_at / 1000, 'unixepoch') AS month, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS t
                                 FROM auto_escrow GROUP BY month ORDER BY month DESC LIMIT 12`);
  const claims = await getQuery(`SELECT c.id, c.user_id, u.username, c.amount, c.entries, c.via, c.at FROM auto_escrow_claims c
                                 LEFT JOIN users u ON u.userId = c.user_id ORDER BY c.at DESC LIMIT 15`);
  const autos = (await getQuery(`SELECT COUNT(*) AS n FROM users WHERE auto_source IS NOT NULL`).catch(() => [{ n: null }]))[0] || {};
  return { enabled: await enabled(), enabled_by: await meta("enabled_by", null), kinds: [...(await kinds())], default_kinds: DEFAULT_KINDS,
           window_months: WINDOW_MONTHS, notice_gap_days: NOTICE_GAP_MS / 86400000, flow: FLOW, routing: await shares(),
           held, expiring_30d: { amount: Number(soon.t) || 0, entries: Number(soon.n) || 0, accounts: Number(soon.a) || 0 },
           top, by_kind: byKind, history: months, earned, claims, auto_accounts: autos.n };
}
/** {enabled?, kinds?} from an admin (audit-logged). -> the new {enabled, kinds}. */
async function setSettings(b, me) {
  await init();
  const before = { enabled: await enabled(), kinds: [...(await kinds())] };
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") throw Object.assign(new Error("enabled must be true or false"), { status: 400 });
    await setMeta("enabled", b.enabled);
    await setMeta("enabled_by", { by: me.username, at: Date.now(), on: b.enabled });
  }
  if (b.kinds !== undefined) {
    const list = (Array.isArray(b.kinds) ? b.kinds : String(b.kinds || "").split(/[\s,]+/)).map((k) => String(k).trim()).filter(Boolean);
    const bad = list.filter((k) => !KIND_RE.test(k));
    if (bad.length || list.length > 60) throw Object.assign(new Error(`bad kind(s): ${bad.join(", ").slice(0, 100) || "too many"}`), { status: 400 });
    await setMeta("kinds", [...new Set(list)]);
  }
  const after = { enabled: await enabled(), kinds: [...(await kinds())] };
  try { await require("./adminaudit").record({ userId: String(me.userId), username: me.username }, "autoescrow.settings", null, { from: before, to: after }, b.note || null); }
  catch (e) { console.error("[autoescrow] audit:", e.message); }
  console.log(`[autoescrow] settings by ${me.username}: ${JSON.stringify(after)}`);
  return after;
}

function register(app, { isBotToken, addUser }) {
  init().catch((e) => console.error("[autoescrow] init:", e.message));
  app.post("/api/autoescrow/notice-logins", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json({ ok: true, on: await enabled(), months: WINDOW_MONTHS, logins: await noticeLogins(), held: await heldLogins() }); }
    catch (e) { console.error("[autoescrow] notice-logins:", e.message); res.status(500).json({ ok: false, error: "failed" }); }
  });
  app.post("/api/autoescrow/notified", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json({ ok: true, marked: await notified(b.login, { upto: b.upto }) }); }
    catch (e) { console.error("[autoescrow] notified:", e.message); res.status(500).json({ ok: false, error: "failed" }); }
  });
  app.post("/api/autoescrow/seen", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await seen(b.login)); } catch (e) { console.error("[autoescrow] seen:", e.message); res.status(500).json({ ok: false, error: "failed" }); }
  });
  app.post("/api/autoescrow/claim-link", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json(await claimLink(b.login)); } catch (e) { console.error("[autoescrow] claim-link:", e.message); res.status(500).json({ ok: false, error: "failed" }); }
  });
  // the landing page Pepe's !signup link opens: "You have PAT X waiting" + create an account / sign in / link it
  const noLeak = (res) => { res.set("Referrer-Policy", "same-origin"); res.set("X-Robots-Tag", "noindex"); res.set("Cache-Control", "no-store"); };
  const viewer = async (req) => (req.user && req.user.userId ? (await getQuery("SELECT userId, username FROM users WHERE userId = ?", [req.user.userId]))[0] || null : null);
  app.get("/claim/:token", addUser, async (req, res) => {
    noLeak(res);
    try {
      const info = await claimInfo(req.params.token);
      const me = await viewer(req);
      res.status(info ? 200 : 410).render("claim", { user: me ? me.username : null, info, here: "/claim/" + req.params.token,
                                                     done: null, error: null, months: WINDOW_MONTHS });
    } catch (e) { console.error("[autoescrow] claim page:", e.message); res.status(500).send("Something went wrong - try again."); }
  });
  app.post("/claim/:token", addUser, async (req, res) => {
    noLeak(res);
    // strict same-origin: the form must come from this site (a request with neither Origin nor Referer is refused too)
    const src = req.get("origin") || req.get("referer");
    let same = false;
    try { same = !!src && new URL(src).host === req.get("host"); } catch (e) { same = false; }
    if (!same) return res.status(403).send("Cross-site request refused");
    const me = await viewer(req);
    if (!me) return res.redirect(302, "/login?next=" + encodeURIComponent("/claim/" + req.params.token));
    try {
      const info = await claimInfo(req.params.token);
      const r = await redeemClaim(req.params.token, me);
      res.status(r.ok ? 200 : 409).render("claim", { user: me.username, info, here: "/claim/" + req.params.token, done: r.ok ? r : null,
                                                     error: r.ok ? null : r.error, months: WINDOW_MONTHS });
    } catch (e) { console.error("[autoescrow] claim:", e.message); res.status(500).send("Something went wrong - try again, or type !signup for a new link."); }
  });
  const admin = async (req, res) => {
    if (!req.user || !req.user.userId) { res.status(401).json({ ok: false, error: "Sign in first." }); return null; }
    const row = (await getQuery("SELECT class, username, userId FROM users WHERE userId = ?", [req.user.userId]).catch(() => []))[0];
    if (!SP.can(row, "econ.backend_cutover")) { res.status(403).json({ ok: false, error: "Admins only." }); return null; }
    return row;
  };
  app.get("/api/admin/autoescrow", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!(await admin(req, res))) return;
    try { res.json(Object.assign({ ok: true }, await adminView())); } catch (e) { console.error("[autoescrow] view:", e); res.status(500).json({ ok: false, error: "failed" }); }
  });
  app.post("/api/admin/autoescrow/settings", addUser, async (req, res) => {
    const me = await admin(req, res);
    if (!me) return;
    if (req.get("X-Requested-With") !== "fetch" || !require("./middleware/authGuard").sameSite(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    try { res.json(Object.assign({ ok: true }, await setSettings(req.body || {}, me))); }
    catch (e) { res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : "failed" }); }
  });
  const iv = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  if (iv.unref) iv.unref();
  const first = setTimeout(() => { tick().catch(() => {}); }, 60000);
  if (first.unref) first.unref();
}

module.exports = { touch, touchSoon, seen, heldLogins, claimLink, claimInfo, redeemClaim, loginState, ACTIVITY_KINDS,
                   init, register, credit, waiting, release, releaseSafe, sweep, expire, tick, supplyRows, heldTotal, noticeLogins, notified,
                   adminView, setSettings, enabled, kinds, addMonthsUTC, expiryOf, split, shares, FLOW, WINDOW_MONTHS, DEFAULT_KINDS, CLAIM_TYPE };
