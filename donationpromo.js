// donationpromo.js — 1.99tq: time-limited DONATION PROMOS ("500k PAT per $1, up to $100, today only").
//
// The normal donation rate lives in Pepe (pepe_econcfg donation_rate / donation_bonus_pct, synced to the site as
// funding.donationTerms()). A promo is the SITE's: it only changes how many PAT a donation credits on the site, so Pepe
// needs nothing new (he journals the claim's `amount` + `bonus` as before) and Stripe needs nothing new (the charge is the
// same; only the PAT credit changes).
//
// ONE function decides every donation credit: creditTerms(). The Stripe webhook (stripebilling.js) and the stablecoin
// settle (cryptopay.js) both call it inside the transaction that credits the donor, so the two rails can't disagree.
// Without a live promo it returns exactly the old formula: pat = floor(cents * rate / 100), bonus = floor(pat * pct / 100).
//
// A promo (donation_promos):
//   mode "rate" (promo PAT per $1) or "mult" (a multiplier on the normal rate at credit time)
//   cap_cents     per-donor USD at the promo rate inside the window; dollars above it earn the normal rate, a donation that
//                 straddles the cap is split pro rata (the cents that fit get the promo rate, the rest the normal rate)
//   budget_pat    optional: the most PAT credited at the promo rate across all donors; then the normal rate again (a
//                 donation straddling the budget is split the same way)
//   bonus_base    what the incentive-budget bonus % is taken on (see BONUS_BASES); default from the settings
//   starts / ends required, ends - starts <= 7 days; "today only" = ends at the next midnight in the settings' time zone
//   enabled       off = the promo doesn't apply (a draft / a pause)
// Which promo a donation belongs to is decided by WHEN it was paid, not when it is credited: Stripe = the Checkout
// Session's creation (what the donor saw when they clicked; a session opened during a promo expires in 31 minutes), crypto =
// when the watcher first saw the transfer. So a webhook retried, or a transfer credited after its wallet is linked, gets the
// terms of its own moment.
//
// Per-donor usage + idempotency: donation_promo_credits, one row per credited donation that fell inside a promo window,
// keyed by the donation's credit id (Stripe "don-<event>", crypto "cdon-<hash>"), written in the SAME transaction as the
// credit (dbUtils.tx; nested = a savepoint). A retried credit finds its row and gets the same split back - the cap and the
// budget are never counted twice; a rolled-back credit rolls its row back too.
// Donor identity for the cap: the PATV account (user_id; an account merge moves the rows, so a merged account shares ONE
// cap - accountMerge.js RULES). Both rails credit only accounts today (a card donation needs a sign-in; a crypto transfer
// from an unlinked wallet waits, unclaimed, until a member links it). For a future account-less donation the caller passes
// donorKey (a hashed Stripe customer / email / wallet - never the raw value); with neither, the normal rate applies (a
// donor we can't count can't be capped).
//
// Safety (server-side): the promo rate is > the normal rate and <= ceiling_x x the normal rate (setting, default 10, hard
// max 50; re-checked at credit time against the normal rate THEN, so Pepe lowering his rate can't push a promo past the
// ceiling); an end time is required (<= 7 days after the start); promos never overlap; once a promo has started (or has any
// credits) its rate / multiplier / cap / bonus base / start are locked - only the label, the end (not into the past), the
// budget (not below what's used) and the switch change - so an edit never re-prices a donation already credited (those
// rows are frozen anyway). Every change is in the admin audit log (action "donation_promo").
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery, tx, inTx } = require("./dbUtils");
const BUDGET = require("./public/js/donpromo-budget");   // 1.99vi: the budget arithmetic + wording, shared with the admin form

const DAY = 86400000;
const MAX_DAYS = 7;
const HARD_CEILING_X = 50;
const MAX_CAP_USD = 1000;                    // = stripebilling DONATE_MAX_USD
const BONUS_BASES = Object.freeze({
  normal: "only on the PAT credited at the normal rate (promo dollars add no bonus)",
  equivalent: "on what the donation would have credited at the normal rate (the incentive budget gets the same as without a promo)",
  all: "on every PAT credited, promo portion included (the old formula: bonus = pat x %)",
});
const DEFAULTS = Object.freeze({ ceiling_x: 10, bonus_base: "normal", tz: "America/New_York",
  daily_limit_usd: 0,                        // 1.99ts: per-member daily donation limit in USD (0 = none); a per-member override wins
  // 1.99uh: the GLOBAL daily cap on PAT minted by donations (base + promo + the incentive bonus), per economy day:
  // global_mode "off" | "fixed" (global_pat PAT) | "pct" (global_pct % of the total supply frozen at the day's start);
  // global_usd (optional, 0 = none) caps the day's donated dollars too - whichever is hit first applies
  global_mode: "off", global_pat: 0, global_pct: 0, global_usd: 0 });
const S = { ...DEFAULTS };

let clock = () => Date.now();
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS donation_promos (id TEXT PRIMARY KEY, label TEXT, mode TEXT NOT NULL, rate INTEGER, mult REAL,
        cap_cents INTEGER NOT NULL, budget_pat INTEGER, bonus_base TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
        starts INTEGER NOT NULL, ends INTEGER NOT NULL, ceiling_x REAL NOT NULL, normal_rate INTEGER, created INTEGER, created_by TEXT,
        updated INTEGER, updated_by TEXT, ended_at INTEGER, ended_by TEXT, cancelled INTEGER NOT NULL DEFAULT 0)`);
      await runQuery("CREATE INDEX IF NOT EXISTS donation_promos_window ON donation_promos (starts, ends)");
      await runQuery(`CREATE TABLE IF NOT EXISTS donation_promo_credits (ref TEXT PRIMARY KEY, promo_id TEXT NOT NULL, user_id TEXT, donor_key TEXT,
        via TEXT, paid_at INTEGER, credited INTEGER, usd_cents INTEGER NOT NULL, promo_cents INTEGER NOT NULL, normal_cents INTEGER NOT NULL,
        promo_rate INTEGER, normal_rate INTEGER, promo_pat INTEGER NOT NULL, normal_pat INTEGER NOT NULL, bonus INTEGER NOT NULL, bonus_pct REAL)`);
      await runQuery("CREATE INDEX IF NOT EXISTS donation_promo_credits_user ON donation_promo_credits (promo_id, user_id)");
      await runQuery("CREATE INDEX IF NOT EXISTS donation_promo_credits_key ON donation_promo_credits (promo_id, donor_key)");
      // 1.99vi: the cents of a donation that would have earned the promo rate (inside the donor's cap) but got the normal rate
      // because the promo's budget had run out (> 0 = a budget fallback; the admin card counts them)
      const cc = (await getQuery("SELECT name FROM pragma_table_info('donation_promo_credits')")).map((r) => r.name);
      if (!cc.includes("budget_short_cents")) await runQuery("ALTER TABLE donation_promo_credits ADD COLUMN budget_short_cents INTEGER NOT NULL DEFAULT 0");
      await runQuery("CREATE TABLE IF NOT EXISTS donation_promo_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER, actor TEXT)");
      // 1.99ts: the daily donation limit - every donation's USD by account and by when it was paid (card: also the OPEN
      // checkouts, so two tabs can't double up), and per-member overrides
      await runQuery(`CREATE TABLE IF NOT EXISTS donation_usd_log (ref TEXT PRIMARY KEY, user_id TEXT NOT NULL, via TEXT NOT NULL, paid_at INTEGER NOT NULL,
        usd_cents INTEGER NOT NULL, status TEXT NOT NULL, expires INTEGER, session TEXT, over_limit INTEGER NOT NULL DEFAULT 0, limit_cents INTEGER, created INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS donation_usd_log_user ON donation_usd_log (user_id, paid_at)");
      await runQuery("CREATE INDEX IF NOT EXISTS donation_usd_log_session ON donation_usd_log (session)");
      await runQuery("CREATE TABLE IF NOT EXISTS donation_limit_overrides (user_id TEXT PRIMARY KEY, limit_usd INTEGER NOT NULL, updated INTEGER, actor TEXT, note TEXT)");
      // 1.99uh: the global daily cap - each row's minted PAT (pat + bonus) + whether it went over the global cap; the supply
      // frozen per economy day (the % mode's base)
      const lc = (await getQuery("SELECT name FROM pragma_table_info('donation_usd_log')")).map((r) => r.name);
      if (!lc.includes("pat")) await runQuery("ALTER TABLE donation_usd_log ADD COLUMN pat INTEGER");
      if (!lc.includes("over_global")) await runQuery("ALTER TABLE donation_usd_log ADD COLUMN over_global INTEGER NOT NULL DEFAULT 0");
      await runQuery("CREATE TABLE IF NOT EXISTS donation_global_day (day TEXT PRIMARY KEY, supply INTEGER, frozen_at INTEGER)");
      // rows credited before 1.99uh: their minted PAT from the mint claim (amount + meta.bonus)
      try {
        await runQuery(`UPDATE donation_usd_log SET pat = (SELECT c.amount + COALESCE(json_extract(c.meta, '$.bonus'), 0) FROM reserve_claims c WHERE c.claimId = donation_usd_log.ref)
                        WHERE pat IS NULL AND status = 'credited' AND EXISTS (SELECT 1 FROM reserve_claims c WHERE c.claimId = donation_usd_log.ref)`);
      } catch (e) { /* no reserve_claims yet */ }
      for (const r of await getQuery("SELECT key, value FROM donation_promo_settings")) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULTS, r.key)) continue;
        try { S[r.key] = JSON.parse(r.value); } catch (e) { /* keep the default */ }
      }
      await refresh();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

class Refuse extends Error { constructor(status, message, code = null, detail = null) { super(message); this.status = status; this.refuse = true; this.code = code; this.detail = detail; } }
const refuse = (m, s = 400, code = null, detail = null) => new Refuse(s, m, code, detail);
const normalTerms = () => { try { return require("./funding").donationTerms(); } catch (e) { return { rate: 500000, bonus_pct: 20 }; } };

// ── the cache (sync readers: the homepage banner) ──
let CACHE = [];
async function refresh() {
  CACHE = await getQuery("SELECT * FROM donation_promos WHERE cancelled = 0 AND ends > ? ORDER BY starts", [clock() - 60000]);
  return CACHE;
}
let timer = null;
function startTimer() {
  if (timer) return;
  // 1.99uh: also freezes the day's supply within a minute of midnight (the % global cap's base)
  timer = setInterval(() => { refresh().catch(() => {}); if (S.global_mode === "pct") ensureFrozen(clock()).catch(() => {}); }, 60000);
  if (timer.unref) timer.unref();
}

// ── the arithmetic (pure) ──
/** The promo's PAT per $1 against `normal` right now; 0 = not better than the normal rate (no promo portion). */
function effectiveRate(p, normal) {
  if (!p || !(normal > 0)) return 0;
  let r = p.mode === "mult" ? Math.floor(normal * Number(p.mult || 0)) : Math.floor(Number(p.rate) || 0);
  const ceil = Math.min(Number(p.ceiling_x) || DEFAULTS.ceiling_x, HARD_CEILING_X);
  r = Math.min(r, Math.floor(normal * ceil));
  return r > normal ? r : 0;
}
/**
 * Split one donation. cents, normalRate, bonusPct; promo = {rate (effective), capCents, budgetPat (null = none), bonusBase}
 * or null; usedCents = the donor's promo cents so far; usedBudget = promo PAT credited so far (all donors).
 */
function split({ cents, normalRate, bonusPct, promo = null, usedCents = 0, usedBudget = 0 }) {
  cents = Math.max(0, Math.floor(Number(cents) || 0));
  let promoCents = 0;
  if (promo && promo.rate > normalRate) {
    const capLeft = Math.max(0, Math.floor(promo.capCents) - Math.floor(usedCents));
    const budLeft = promo.budgetPat == null ? Infinity : Math.floor(Math.max(0, promo.budgetPat - usedBudget) * 100 / promo.rate);
    promoCents = Math.max(0, Math.min(cents, capLeft, budLeft));
  }
  const normalCents = cents - promoCents;
  const promoPat = promoCents ? Math.floor((promoCents * promo.rate) / 100) : 0;
  const normalPat = Math.floor((normalCents * normalRate) / 100);
  const pat = promoPat + normalPat;
  const base = !promo ? "all" : promo.bonusBase || "normal";
  const on = base === "all" ? pat : base === "equivalent" ? Math.floor((cents * normalRate) / 100) : normalPat;
  const bonus = Math.floor((on * bonusPct) / 100);
  return { usd_cents: cents, pat, bonus, rate: normalRate, bonus_pct: bonusPct,
           promo_cents: promoCents, normal_cents: normalCents, promo_pat: promoPat, normal_pat: normalPat, promo_rate: promo ? promo.rate : 0 };
}

// ── reading promos ──
async function promoAt(at) {
  return (await getQuery("SELECT * FROM donation_promos WHERE cancelled = 0 AND enabled = 1 AND starts <= ? AND ends > ? ORDER BY starts LIMIT 1", [at, at]))[0] || null;
}
function identity(userId, donorKey) {
  if (userId) return { col: "user_id", v: String(userId) };
  if (donorKey) return { col: "donor_key", v: String(donorKey).slice(0, 80) };
  return null;
}
async function usage(promoId, id) {
  const d = id ? (await getQuery(`SELECT COALESCE(SUM(promo_cents),0) AS c FROM donation_promo_credits WHERE promo_id = ? AND ${id.col} = ?`, [promoId, id.v]))[0] : null;
  const b = (await getQuery("SELECT COALESCE(SUM(promo_pat),0) AS p FROM donation_promo_credits WHERE promo_id = ?", [promoId]))[0];
  return { usedCents: d ? Number(d.c) || 0 : 0, usedBudget: Number(b.p) || 0 };
}
/** A hashed donor key for an account-less donation (never the raw value): kind = "stripe-customer" | "email" | "wallet". */
function donorKeyOf(kind, value) {
  const v = String(value || "").trim().toLowerCase();
  return v ? kind + ":" + crypto.createHash("sha256").update(v).digest("hex").slice(0, 32) : null;
}
const fromRow = (r, promo) => ({ usd_cents: r.usd_cents, pat: r.promo_pat + r.normal_pat, bonus: r.bonus, rate: r.normal_rate, bonus_pct: r.bonus_pct,
  promo_cents: r.promo_cents, normal_cents: r.normal_cents, promo_pat: r.promo_pat, normal_pat: r.normal_pat, promo_rate: r.promo_rate,
  promo: { id: r.promo_id, label: promo ? promo.label : null }, replay: true });

/** The split a donation would get (read-only): {s, p (the promo row or null), rate, id}. creditTerms() writes what this says. */
async function computeTerms({ userId = null, donorKey = null, cents, paidAt }) {
  const T = normalTerms();
  const plain = { s: { ...split({ cents, normalRate: T.rate, bonusPct: T.bonus_pct }), promo: null }, p: null };
  const at = Number(paidAt);
  const id = identity(userId, donorKey);
  if (!Number.isFinite(at) || !id) return plain;
  const p = await promoAt(at);
  if (!p) return plain;
  const rate = effectiveRate(p, T.rate);
  if (!rate) return plain;
  const u = await usage(p.id, id);
  const s = split({ cents, normalRate: T.rate, bonusPct: T.bonus_pct, usedCents: u.usedCents, usedBudget: u.usedBudget,
                    promo: { rate, capCents: p.cap_cents, budgetPat: p.budget_pat, bonusBase: p.bonus_base } });
  // 1.99vi: what the donor's cap still allowed at the promo rate but the budget didn't (= a budget fallback)
  const capFits = Math.min(s.usd_cents, Math.max(0, Math.floor(p.cap_cents) - Math.floor(u.usedCents)));
  const budgetShort = p.budget_pat == null ? 0 : Math.max(0, capFits - s.promo_cents);
  return { s: { ...s, promo: { id: p.id, label: p.label || null } }, p, rate, id, budgetShort };
}
/** 1.99uh: what a donation would credit (PAT + the incentive bonus = what it mints), without writing anything. */
async function previewTerms(args) { await init(); return (await computeTerms(args)).s; }
/**
 * THE donation credit. Call it inside the transaction that credits the donor (it wraps itself in one otherwise).
 * {ref (the credit's id, e.g. the claim id), userId, donorKey?, cents, paidAt (ms), via ("card" | "crypto")}
 * -> {usd_cents, pat, bonus, rate, bonus_pct, promo_cents, normal_cents, promo_pat, normal_pat, promo_rate, promo: {id, label} | null}
 */
async function creditTerms({ ref, userId = null, donorKey = null, cents, paidAt, via = null }) {
  await init();
  const run = async () => {
    const T = normalTerms();
    const old = ref ? (await getQuery("SELECT * FROM donation_promo_credits WHERE ref = ?", [String(ref)]))[0] : null;
    if (old) return fromRow(old, (await getQuery("SELECT label FROM donation_promos WHERE id = ?", [old.promo_id]))[0]);
    if (!ref) return { ...split({ cents, normalRate: T.rate, bonusPct: T.bonus_pct }), promo: null };
    const C = await computeTerms({ userId, donorKey, cents, paidAt });
    if (!C.p) return C.s;
    const { s, p, rate, id, budgetShort } = C;
    const at = Number(paidAt);
    await runQuery(`INSERT INTO donation_promo_credits (ref, promo_id, user_id, donor_key, via, paid_at, credited, usd_cents, promo_cents, normal_cents,
                    promo_rate, normal_rate, promo_pat, normal_pat, bonus, bonus_pct, budget_short_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [String(ref), p.id, id.col === "user_id" ? id.v : null, id.col === "donor_key" ? id.v : null, via, at, clock(), s.usd_cents, s.promo_cents,
       s.normal_cents, rate, T.rate, s.promo_pat, s.normal_pat, s.bonus, T.bonus_pct, budgetShort || 0]);
    if (budgetShort > 0) console.warn(`[donpromo] budget fallback: ${ref} (${via || "?"}) - $${(budgetShort / 100).toFixed(2)} got the normal rate because ` +
                                      `${p.id}'s budget (${Number(p.budget_pat).toLocaleString("en-US")} PAT) ran out`);
    return { ...s, promo: { id: p.id, label: p.label || null } };
  };
  return inTx() ? run() : tx(run);
}
/** The extra reserve_claims meta for a credit: {} without a promo (the old meta stays byte-for-byte the same). */
function metaOf(s) {
  if (!s || !s.promo) return {};
  return { promo: { id: s.promo.id, usd_cents: s.promo_cents, pat: s.promo_pat, rate: s.promo_rate },
           normal: { usd_cents: s.normal_cents, pat: s.normal_pat } };
}
/** A one-line English note for the donor's PAT history (transactions.note), or undefined without a promo portion. */
function noteOf(s) {
  if (!s || !s.promo || !s.promo_cents) return undefined;
  const f = (n) => Number(n).toLocaleString("en-US");
  return `Promo${s.promo.label ? " (" + s.promo.label + ")" : ""}: ${f(s.promo_pat)} PAT for $${(s.promo_cents / 100).toFixed(2)} at ${f(s.promo_rate)}/$1` +
         (s.normal_cents ? ` + ${f(s.normal_pat)} PAT for $${(s.normal_cents / 100).toFixed(2)} at the normal ${f(s.rate)}/$1` : "");
}

/** The receipt's promo sentence (" " + text) for the donor's inbox notice, in their language; "" without a promo portion. */
function receiptLine(t, s) {
  if (!s || !s.promo || !s.promo_cents) return "";
  const f = (n) => (t && t.num ? t.num(n) : Number(n).toLocaleString("en-US"));
  const usd = (c) => (c / 100).toFixed(2);
  return " " + (s.normal_cents
    ? t("donate.notice_promo_split", { promo_usd: usd(s.promo_cents), promo_pat: f(s.promo_pat), promo_rate: f(s.promo_rate),
                                        normal_usd: usd(s.normal_cents), normal_pat: f(s.normal_pat), normal_rate: f(s.rate) })
    : t("donate.notice_promo_all", { promo_usd: usd(s.promo_cents), promo_pat: f(s.promo_pat), promo_rate: f(s.promo_rate) }));
}

// ── public (what a donor sees BEFORE paying) ──
function publicOf(p, normal, now) {
  const rate = effectiveRate(p, normal.rate);
  if (!rate) return null;
  return { id: p.id, label: p.label || null, rate, normal_rate: normal.rate, mult: Math.round((rate / normal.rate) * 100) / 100,
           cap_usd: p.cap_cents / 100, starts: p.starts, ends: p.ends, left_ms: Math.max(0, p.ends - now), bonus_base: p.bonus_base,
           bonus_pct: normal.bonus_pct, budget: p.budget_pat != null };
}
/** The live promo for display (+ the viewer's allowance when signed in), or null. */
async function live(userId = null, now = clock()) {
  await init();
  const p = await promoAt(now);
  if (!p) return null;
  const out = publicOf(p, normalTerms(), now);
  if (!out) return null;
  const u = await usage(p.id, identity(userId));
  out.allowance_cents = Math.max(0, p.cap_cents - u.usedCents);
  out.used_cents = u.usedCents;
  out.signed_in = !!userId;
  if (p.budget_pat != null) {
    out.budget_left_pat = Math.max(0, p.budget_pat - u.usedBudget);
    out.budget_left_cents = Math.floor((out.budget_left_pat * 100) / out.rate);
    out.budget_pct_left = Math.round((out.budget_left_pat / Math.max(1, p.budget_pat)) * 100);
  }
  return out;
}
/** Sync: the live promo from the cache (no allowance) - the homepage banner. */
function liveCached(now = clock()) {
  const p = CACHE.find((x) => !x.cancelled && x.enabled && x.starts <= now && x.ends > now);
  return p ? publicOf(p, normalTerms(), now) : null;
}
/** What `usd` would credit the viewer right now (read-only; the same split the credit uses). */
async function quote(userId, usd, now = clock()) {
  await init();
  const cents = Math.round(Number(usd) * 100);
  if (!Number.isFinite(cents) || cents <= 0 || cents > MAX_CAP_USD * 100 * 10) throw refuse("Pick an amount in dollars.");
  const T = normalTerms();
  const D = await daily(userId, now);      // 1.99ts: the daily limit (null = none)
  const lim = D ? { left_cents: D.left_cents, over: cents > D.left_cents } : null;
  const p = await promoAt(now);
  const rate = p ? effectiveRate(p, T.rate) : 0;
  let s;
  if (!p || !rate) s = { ...split({ cents, normalRate: T.rate, bonusPct: T.bonus_pct }), promo: null };
  else {
    const u = await usage(p.id, identity(userId));
    s = { ...split({ cents, normalRate: T.rate, bonusPct: T.bonus_pct, usedCents: u.usedCents, usedBudget: u.usedBudget,
                     promo: { rate, capCents: p.cap_cents, budgetPat: p.budget_pat, bonusBase: p.bonus_base } }), promo: { id: p.id, label: p.label || null } };
  }
  // 1.99uh: the global pool - does this amount fit, and the most whole dollars that do (never the cap itself)
  let global = { on: false };
  if (globalOn()) {
    await ensureFrozen(now);
    const fits = (await globalCheck(cents, mintOf(s), now, now)).fits;
    global = { on: true, fits, max_usd: fits ? null : await globalMaxUsd(userId, Math.ceil(cents / 100) - 1, now) };
  }
  return { ...s, limit: lim, global };
}

// ── time ──
function wall(ms, tz) {
  const o = {};
  for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
                                                      minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms))) o[x.type] = x.value;
  return o;
}
const offsetMs = (ms, tz) => { const o = wall(ms, tz); return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second) - Math.floor(ms / 1000) * 1000; };
/** The next local midnight in tz after `ms` ("today only"). */
function nextMidnight(ms, tz = S.tz) {
  const o = wall(ms, tz);
  const g = Date.UTC(+o.year, +o.month - 1, +o.day + 1);
  let t = g - offsetMs(g, tz);
  t = g - offsetMs(t, tz);
  return t;
}
/** 1.99ts: the economy day (tz) around `ms`: {start, end} - midnight to midnight, New York by default. */
function dayWindow(ms, tz = S.tz) {
  const end = nextMidnight(ms, tz);
  const o = wall(ms, tz);
  const g = Date.UTC(+o.year, +o.month - 1, +o.day);
  let t = g - offsetMs(g, tz);
  t = g - offsetMs(t, tz);
  return { start: t, end };
}
const validTz = (z) => { try { new Intl.DateTimeFormat("en-US", { timeZone: String(z) }); return true; } catch (e) { return false; } };

// ── 1.99ts: the daily donation limit ──
// A member may donate at most `limit` USD per economy day (S.tz, midnight to midnight; by when the donation was PAID - card:
// the checkout's creation; crypto: first seen). The limit = their override (donation_limit_overrides; 0 = no limit for
// them) or the default (daily_limit_usd; 0 = none). It caps the TOTAL USD; a promo's per-donor cap only decides how much of
// it earns the promo rate - both apply. Used today = credited donations + OPEN card checkouts (not expired, not paid yet).
//   card:   donate() reserves the amount before Stripe (reserveCheckout, refused over the limit - we never take money we
//           won't credit); the webhook credits it ALWAYS (the money is taken) and flags a race that went over (over_limit).
//   crypto: an over-limit transfer is HELD for review (cryptopay hold_reason "daily_limit"): an admin credits it (the terms
//           of the moment it was seen, promo included) or marks it refunded off-site.
async function limitFor(userId) {
  if (!userId) return 0;
  const o = (await getQuery("SELECT limit_usd FROM donation_limit_overrides WHERE user_id = ?", [String(userId)]))[0];
  const usd = o ? Number(o.limit_usd) : Number(S.daily_limit_usd) || 0;
  return usd > 0 ? Math.floor(usd * 100) : 0;
}
async function dayUsed(userId, at, now, exceptRefs = []) {
  const W = dayWindow(at);
  const ex = exceptRefs.filter(Boolean);
  const r = (await getQuery(`SELECT COALESCE(SUM(usd_cents),0) AS c FROM donation_usd_log WHERE user_id = ? AND paid_at >= ? AND paid_at < ?
      AND (status = 'credited' OR (status = 'open' AND expires > ?))${ex.length ? ` AND ref NOT IN (${ex.map(() => "?").join(",")})` : ""}`,
    [String(userId), W.start, W.end, now, ...ex]))[0];
  return { used: Number(r.c) || 0, window: W };
}
/** The member's limit today: null (no limit) or {limit_cents, used_cents, left_cents, resets_at, tz, override}. */
async function daily(userId, now = clock()) {
  await init();
  if (!userId) return null;
  const limit = await limitFor(userId);
  if (!limit) return null;
  const u = await dayUsed(userId, now, now);
  const o = (await getQuery("SELECT 1 FROM donation_limit_overrides WHERE user_id = ?", [String(userId)]))[0];
  return { limit_cents: limit, used_cents: u.used, left_cents: Math.max(0, limit - u.used), resets_at: u.window.end, tz: S.tz, override: !!o };
}
/** Would `cents` paid at `at` take the member over that day's limit? (crypto) -> {over, limit_cents, used_cents} */
async function limitCheck(userId, cents, at, now = clock()) {
  await init();
  const limit = await limitFor(userId);
  if (!limit) return { over: false, limit_cents: 0, used_cents: 0 };
  const u = await dayUsed(userId, at, now);
  return { over: u.used + Math.floor(cents) > limit, limit_cents: limit, used_cents: u.used };
}
const usdTxt = (c) => "$" + (c / 100).toFixed(c % 100 ? 2 : 0);
const tzName = () => String(S.tz).replace(/_/g, " ");
// ── 1.99uh: the GLOBAL daily cap (all donors together, per economy day) ──
// Caps the PAT donations MINT a day (the donor's PAT, base + promo, + the incentive bonus) - a fixed number, or a % of the
// total supply FROZEN at the day's start (donation_global_day: the first look of the day - the minute timer, or the first
// donation - stores it; it never drifts that day) - and optionally the day's donated dollars; whichever is hit first.
// Used = credited + open card checkouts (their minted PAT as quoted when they opened). Card: refused / offered the amount
// that fits BEFORE Stripe; a webhook race over it is credited (paid), flagged (over_global) and counted. Crypto: held for
// review (hold_reason global_daily_limit), like the per-member limit.
let supplyFn = async () => (await require("./supply").patSupply()).total;
const dayKey = (ms) => { const o = wall(ms, S.tz); return `${o.year}-${o.month}-${o.day}`; };
const tzLabel = () => (S.tz === "America/New_York" ? "New York" : tzName());
const globalOn = () => (S.global_mode === "fixed" && S.global_pat > 0) || (S.global_mode === "pct" && S.global_pct > 0) || S.global_usd > 0;
/** The supply frozen for the day of `at` (frozen now if it isn't yet). Call it OUTSIDE a transaction (it reads the whole supply). */
async function ensureFrozen(at) {
  await init();
  const day = dayKey(at);
  const r = (await getQuery("SELECT supply FROM donation_global_day WHERE day = ?", [day]))[0];
  if (r) return Number(r.supply);
  let total = null;
  try { total = Math.floor(Number(await supplyFn())); } catch (e) { console.error("[donglobal] couldn't read the supply:", e.message); return null; }
  if (!Number.isFinite(total) || total <= 0) return null;
  await runQuery("INSERT OR IGNORE INTO donation_global_day (day, supply, frozen_at) VALUES (?, ?, ?)", [day, total, clock()]);
  return Number((await getQuery("SELECT supply FROM donation_global_day WHERE day = ?", [day]))[0].supply);
}
/** The day's caps: {pat: PAT or null, cents: USD cents or null, supply (frozen, % mode)} - null caps = none. */
async function globalCaps(at) {
  let pat = null, supply = null;
  if (S.global_mode === "fixed" && S.global_pat > 0) pat = Math.floor(S.global_pat);
  if (S.global_mode === "pct" && S.global_pct > 0) {
    const r = (await getQuery("SELECT supply FROM donation_global_day WHERE day = ?", [dayKey(at)]))[0];
    supply = r ? Number(r.supply) : null;
    // not frozen yet (callers freeze it before their transaction; this is the fallback) - the % cap needs its base
    if (supply == null && !inTx()) supply = await ensureFrozen(at);
    if (supply != null) pat = Math.floor((supply * S.global_pct) / 100);
  }
  return { pat, cents: S.global_usd > 0 ? Math.floor(S.global_usd) * 100 : null, supply };
}
async function globalUsed(at, now, exceptRefs = []) {
  const W = dayWindow(at);
  const ex = exceptRefs.filter(Boolean);
  const r = (await getQuery(`SELECT COALESCE(SUM(pat),0) AS p, COALESCE(SUM(usd_cents),0) AS c FROM donation_usd_log WHERE paid_at >= ? AND paid_at < ?
      AND (status = 'credited' OR (status = 'open' AND expires > ?))${ex.length ? ` AND ref NOT IN (${ex.map(() => "?").join(",")})` : ""}`,
    [W.start, W.end, now, ...ex]))[0];
  return { pat: Number(r.p) || 0, cents: Number(r.c) || 0, window: W };
}
/** Does a donation (cents, minting `mint` PAT) fit the day's global caps? -> {on, fits, caps, used} */
async function globalCheck(cents, mint, at, now = clock(), exceptRefs = []) {
  if (!globalOn()) return { on: false, fits: true };
  const caps = await globalCaps(at);
  const used = await globalUsed(at, now, exceptRefs);
  const fits = (caps.pat == null || used.pat + mint <= caps.pat) && (caps.cents == null || used.cents + cents <= caps.cents);
  return { on: true, fits, caps, used };
}
const mintOf = (s) => (s ? s.pat + s.bonus : 0);
/** The most whole dollars (<= maxUsd) the member can donate right now within the global caps (binary search: minting grows with dollars). */
async function globalMaxUsd(userId, maxUsd, now) {
  let lo = 0, hi = Math.max(0, Math.floor(maxUsd));
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const s = (await computeTerms({ userId, cents: mid * 100, paidAt: now })).s;
    if ((await globalCheck(mid * 100, mintOf(s), now, now)).fits) lo = mid; else hi = mid - 1;
  }
  return lo;
}
/** Public: {on, full, pct_left, resets_at} - never the cap itself. With userId + usd: the whole dollars that fit (max_usd). */
async function globalPublic(now = clock()) {
  await init();
  if (!globalOn()) return { on: false };
  await ensureFrozen(now);
  const caps = await globalCaps(now);
  const used = await globalUsed(now, now);
  const fr = [];
  if (caps.pat != null) fr.push(caps.pat > 0 ? Math.max(0, 1 - used.pat / caps.pat) : 0);
  if (caps.cents != null) fr.push(caps.cents > 0 ? Math.max(0, 1 - used.cents / caps.cents) : 0);
  const left = fr.length ? Math.min(...fr) : 1;
  // full = not even $1 at the normal rate fits
  const one = split({ cents: 100, normalRate: normalTerms().rate, bonusPct: normalTerms().bonus_pct });
  const full = !(await globalCheck(100, mintOf(one), now, now)).fits;
  return { on: true, full, pct_left: Math.floor(left * 100), resets_at: dayWindow(now).end, tz: S.tz };
}
/** Admin: today's global numbers. */
async function globalAdmin(now = clock()) {
  await init();
  if (!globalOn()) return { on: false, mode: S.global_mode };
  await ensureFrozen(now);
  const caps = await globalCaps(now);
  const used = await globalUsed(now, now);
  const n = (await getQuery("SELECT COUNT(*) AS n FROM donation_usd_log WHERE over_global = 1 AND status = 'credited'"))[0].n;
  let held = 0;
  try { held = (await getQuery("SELECT COUNT(*) AS n FROM crypto_payments WHERE status = 'held' AND hold_reason = 'global_daily_limit'"))[0].n; } catch (e) { held = 0; }
  return { on: true, mode: S.global_mode, day: dayKey(now), supply: caps.supply, cap_pat: caps.pat, cap_cents: caps.cents, used_pat: used.pat, used_cents: used.cents,
           left_pat: caps.pat == null ? null : Math.max(0, caps.pat - used.pat), left_cents: caps.cents == null ? null : Math.max(0, caps.cents - used.cents),
           resets_at: used.window.end, flagged_count: n, crypto_held: held };
}
/** Before a transaction that may credit / reserve: tables ready + the day's supply frozen (the % mode). */
async function prepare(at = clock()) { await init(); await auditReady(); if (S.global_mode === "pct" && S.global_pct > 0) await ensureFrozen(at); }

/** Card: hold `cents` of today's allowances (the member's + the global pool) BEFORE opening a checkout; refused over either,
 *  with the amount that fits. -> {ref, limited} */
async function reserveCheckout(userId, cents, now = clock()) {
  await prepare(now);
  return tx(async () => {
    const limit = await limitFor(userId);
    const gOn = globalOn();
    if (!limit && !gOn) return { ref: null, limited: false };
    let userLeft = Infinity;
    if (limit) {
      const u = await dayUsed(userId, now, now);
      userLeft = Math.max(0, limit - u.used);
      if (cents > userLeft) {
        const whole = Math.floor(userLeft / 100);
        throw refuse(whole >= 1
          ? `Today's donation limit: you can donate ${usdTxt(whole * 100)} more today (the day resets at midnight ${tzName()} time).`
          : `You have reached today's donation limit (${usdTxt(limit)}). It resets at midnight ${tzName()} time.`, 409);
      }
    }
    const s = (await computeTerms({ userId, cents, paidAt: now })).s;
    if (gOn && !(await globalCheck(cents, mintOf(s), now, now)).fits) {
      const max = await globalMaxUsd(userId, Math.min(Math.floor(cents / 100) - 1, Math.floor(userLeft / 100)), now);
      throw Object.assign(refuse(max >= 1
        ? `Today's donation pool only has room for ${usdTxt(max * 100)} more - you can donate up to ${usdTxt(max * 100)} now.`
        : `Donations are full for today; they reopen at midnight ${tzLabel()} time.`, 409), { fits_usd: max });
    }
    const ref = "hold:" + crypto.randomBytes(8).toString("hex");
    await runQuery("INSERT INTO donation_usd_log (ref, user_id, via, paid_at, usd_cents, pat, status, expires, limit_cents, created) VALUES (?, ?, 'card', ?, ?, ?, 'open', ?, ?, ?)",
      [ref, String(userId), now, cents, mintOf(s), now + 5 * 60000, limit || null, now]);
    return { ref, limited: true };
  });
}
/** Card: the checkout opened - its hold now lasts as long as the session can be paid. */
async function attachSession(ref, sessionId, expiresMs) {
  if (!ref) return;
  await runQuery("UPDATE donation_usd_log SET session = ?, expires = ? WHERE ref = ? AND status = 'open'", [String(sessionId), expiresMs, ref]);
}
/** Card: the checkout couldn't open - the hold goes. */
async function releaseHold(ref) { if (ref) await runQuery("UPDATE donation_usd_log SET status = 'released' WHERE ref = ? AND status = 'open'", [ref]); }
/** Card: Stripe says the checkout expired unpaid - its hold goes (it would lapse at `expires` anyway). */
async function expireSession(sessionId) {
  return runQuery("UPDATE donation_usd_log SET status = 'expired' WHERE session = ? AND status = 'open'", [String(sessionId)]);
}
/**
 * A credited donation counts toward its day (call it inside the credit's transaction; idempotent per ref). Card: its open
 * hold (by session) becomes the credited row. Over the limit anyway (a race / an admin-approved hold) -> over_limit = 1.
 * -> {over, limit_cents, used_cents}
 */
async function recordCredit({ ref, sessionId = null, userId, via, paidAt, cents, mint = null, now = clock() }) {
  const run = async () => {
    const had = (await getQuery("SELECT * FROM donation_usd_log WHERE ref = ? AND status = 'credited'", [String(ref)]))[0];
    if (had) return { over: !!had.over_limit, over_global: !!had.over_global, limit_cents: had.limit_cents || 0, used_cents: null };
    const hold = sessionId ? (await getQuery("SELECT ref FROM donation_usd_log WHERE session = ?", [String(sessionId)]))[0] : null;
    const limit = await limitFor(userId);
    const u = await dayUsed(userId, paidAt, now, [hold && hold.ref, ref]);
    const over = !!limit && u.used + cents > limit;
    // 1.99uh: the global pool - over it anyway (a race / an approved hold): credited, flagged, counted
    const G = mint == null ? { fits: true } : await globalCheck(cents, mint, paidAt, now, [hold && hold.ref, ref]);
    const overG = !G.fits;
    if (hold) {
      await runQuery("UPDATE donation_usd_log SET ref = ?, status = 'credited', usd_cents = ?, pat = ?, paid_at = ?, user_id = ?, over_limit = ?, over_global = ?, limit_cents = ? WHERE ref = ?",
        [String(ref), cents, mint, paidAt, String(userId), over ? 1 : 0, overG ? 1 : 0, limit || null, hold.ref]);
    } else {
      await runQuery(`INSERT INTO donation_usd_log (ref, user_id, via, paid_at, usd_cents, pat, status, session, over_limit, over_global, limit_cents, created)
                      VALUES (?, ?, ?, ?, ?, ?, 'credited', ?, ?, ?, ?, ?)`, [String(ref), String(userId), via, paidAt, cents, mint, sessionId, over ? 1 : 0, overG ? 1 : 0, limit || null, now]);
    }
    if (over) console.warn(`[donlimit] ${via} donation ${ref} took ${userId} over the day's limit (${usdTxt(u.used)} + ${usdTxt(cents)} > ${usdTxt(limit)}) - credited, flagged`);
    if (overG) console.warn(`[donglobal] ${via} donation ${ref} (${mint} PAT minted) went over today's global donation cap - credited (paid), flagged`);
    return { over, over_global: overG, limit_cents: limit, used_cents: u.used };
  };
  return inTx() ? run() : tx(run);
}
/** Admin: one member's override. limit "" / null -> removed (the default applies); 0 -> no limit for them; N -> $N a day. */
async function setOverride(admin, userId, limit, note) {
  await init();
  await auditReady();
  if (!userId) throw refuse("No such member.", 404);
  let v = null;
  if (!(limit === null || limit === undefined || limit === "")) {
    v = int(limit);
    if (!Number.isFinite(v) || v < 0 || v > 1000000) throw refuse("The limit is a whole number of dollars (0 = no limit for this member), or empty for the default.");
  }
  await tx(async () => {
    const before = (await getQuery("SELECT limit_usd FROM donation_limit_overrides WHERE user_id = ?", [String(userId)]))[0] || null;
    if (v === null) await runQuery("DELETE FROM donation_limit_overrides WHERE user_id = ?", [String(userId)]);
    else await runQuery(`INSERT INTO donation_limit_overrides (user_id, limit_usd, updated, actor, note) VALUES (?, ?, ?, ?, ?)
                         ON CONFLICT(user_id) DO UPDATE SET limit_usd = excluded.limit_usd, updated = excluded.updated, actor = excluded.actor, note = excluded.note`,
      [String(userId), v, clock(), admin.username || admin.userId, note ? String(note).slice(0, 200) : null]);
    await require("./adminaudit").record({ userId: admin.userId, username: admin.username }, "donation_limit", { userId: String(userId), username: null },
      { what: "override", before: before ? before.limit_usd : null, after: v }, note || null);
  });
  return { user_id: String(userId), limit_usd: v, default_usd: S.daily_limit_usd };
}
async function overrideOf(userId) {
  await init();
  return (await getQuery("SELECT * FROM donation_limit_overrides WHERE user_id = ?", [String(userId)]))[0] || null;
}
/** Admin card: the limit's state, the overrides, and the over-limit credits (races / approved holds). */
async function limitState() {
  await init();
  const flagged = await getQuery(`SELECT l.ref, l.user_id, u.username, l.via, l.paid_at, l.usd_cents, l.limit_cents FROM donation_usd_log l
      LEFT JOIN users u ON u.userId = l.user_id WHERE l.over_limit = 1 AND l.status = 'credited' ORDER BY l.paid_at DESC LIMIT 50`).catch(() => []);
  const n = (await getQuery("SELECT COUNT(*) AS n FROM donation_usd_log WHERE over_limit = 1 AND status = 'credited'"))[0].n;
  const overrides = await getQuery(`SELECT o.user_id, u.username, o.limit_usd, o.updated, o.actor, o.note FROM donation_limit_overrides o
      LEFT JOIN users u ON u.userId = o.user_id ORDER BY o.updated DESC LIMIT 100`).catch(() => []);
  let held = 0;
  try { held = (await getQuery("SELECT COUNT(*) AS n FROM crypto_payments WHERE status = 'held' AND hold_reason = 'daily_limit'"))[0].n; } catch (e) { held = 0; }
  let log = [];
  try { log = await require("./adminaudit").recent("donation_limit", 20); } catch (e) { log = []; }
  return { default_usd: S.daily_limit_usd, tz: S.tz, flagged, flagged_count: n, overrides, crypto_held: held, log };
}

// ── admin ──
const int =(v) => { if (v === null || v === undefined || v === "" || typeof v === "boolean") return null; const n = Number(v); return Number.isFinite(n) ? Math.floor(n) : NaN; };
const cleanLabel = (s) => String(s == null ? "" : s).replace(/[\u0000-\u001f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
const hasCredits = async (id) => !!(await getQuery("SELECT 1 FROM donation_promo_credits WHERE promo_id = ? LIMIT 1", [id]))[0];
async function overlapping(starts, ends, exceptId) {
  return (await getQuery("SELECT id FROM donation_promos WHERE cancelled = 0 AND id != ? AND starts < ? AND ends > ? LIMIT 1", [exceptId || "", ends, starts]))[0] || null;
}
/** Validate the pricing fields -> {mode, rate, mult, cap_cents, bonus_base, ceiling_x, normal_rate} */
function pricing(b, normal) {
  const mode = b.mode === "mult" ? "mult" : b.mode === "rate" ? "rate" : null;
  if (!mode) throw refuse("Pick a promo rate (PAT per $1) or a multiplier.");
  const ceil = Math.min(Number(S.ceiling_x) || DEFAULTS.ceiling_x, HARD_CEILING_X);
  let rate = null, mult = null;
  if (mode === "rate") {
    rate = int(b.rate);
    if (!Number.isFinite(rate) || rate <= normal) throw refuse(`The promo rate must be more than the normal rate (${normal.toLocaleString("en-US")} PAT per $1).`);
    if (rate > Math.floor(normal * ceil)) throw refuse(`The promo rate can be at most ${ceil}x the normal rate (${Math.floor(normal * ceil).toLocaleString("en-US")} PAT per $1).`);
  } else {
    mult = Math.round(Number(b.mult) * 100) / 100;
    if (!Number.isFinite(mult) || mult <= 1) throw refuse("The multiplier must be more than 1.");
    if (mult > ceil) throw refuse(`The multiplier can be at most ${ceil}x.`);
  }
  const capUsd = int(b.cap_usd);
  if (!Number.isFinite(capUsd) || capUsd < 1 || capUsd > MAX_CAP_USD) throw refuse(`The per-donor cap is a whole number of dollars from 1 to ${MAX_CAP_USD}.`);
  const bonus_base = b.bonus_base == null || b.bonus_base === "" ? S.bonus_base : String(b.bonus_base);
  if (!BONUS_BASES[bonus_base]) throw refuse("Unknown bonus base.");
  return { mode, rate, mult, cap_cents: capUsd * 100, bonus_base, ceiling_x: ceil, normal_rate: normal };
}
function budgetOf(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = int(v);
  if (!Number.isFinite(n) || n < 1 || n > 1e12) throw refuse("The budget is a whole number of PAT (or empty for none).");
  return n;
}
const yes = (v) => v === true || v === 1 || v === "1" || v === "on" || v === "true";
/**
 * 1.99vi: a budget smaller than ONE donor's full promo allowance (cap x promo rate) is almost always a typo (1000 meant as
 * $1,000 = 1,000 PAT). Refused (409, code "budget_small", detail = DPBudget.check) unless b.confirm_budget.
 */
function guardBudget(budgetPat, capCents, rate, b) {
  const w = BUDGET.check(budgetPat, capCents, rate);
  if (!w || yes(b.confirm_budget)) return;
  throw refuse(`This budget runs out after $${BUDGET.usd(w.budget_cents)} of promo donations - less than one donor's full promo allowance ` +
               `($${BUDGET.usd(w.cap_cents)} = ${BUDGET.fmt(w.allowance_pat)} PAT). The budget is in PAT, not dollars. Did you mean ${BUDGET.fmt(w.suggest_pat)} PAT? ` +
               `Confirm to keep it.`, 409, "budget_small", w);
}
function windowOf(b, now) {
  let starts = b.starts == null || b.starts === "" ? now : int(b.starts);
  let ends = int(b.ends);
  if (b.today) { starts = now; ends = nextMidnight(now); }
  if (!Number.isFinite(starts)) throw refuse("Bad start time.");
  if (!Number.isFinite(ends)) throw refuse("An end time is required.");
  // whole seconds: Stripe's times are seconds, so a checkout opened in the same second a promo starts "now" is inside it
  return { starts: Math.floor(starts / 1000) * 1000, ends };
}
function checkWindow(starts, ends, now, { isNew }) {
  if (isNew && starts < now - 5 * 60000) throw refuse("A promo can't start in the past.");
  if (ends <= starts) throw refuse("The end must be after the start.");
  if (ends <= now) throw refuse("The end must be in the future.");
  if (ends - starts > MAX_DAYS * DAY) throw refuse(`A promo runs at most ${MAX_DAYS} days.`);
}
const auditReady = async () => { try { await require("./adminaudit").init(); } catch (e) { /* record() reports it */ } };   // before a tx (never a memoized init inside one)
async function audit(admin, what, detail) {
  try { await require("./adminaudit").record({ userId: admin.userId, username: admin.username }, "donation_promo", null, { what, ...detail }); }
  catch (e) { console.error("[donpromo] audit:", e.message); throw refuse("Couldn't write the audit log - nothing changed.", 500); }
}
const nextId = async () => {
  const r = (await getQuery("SELECT COUNT(*) AS n FROM donation_promos"))[0];
  return "DP" + (Number(r.n) + 1) + "-" + crypto.randomBytes(2).toString("hex");
};

/** Create a promo. b = {label, mode, rate | mult, cap_usd, budget, bonus_base, enabled, starts, ends, today} */
async function create(admin, b = {}) {
  await init();
  await auditReady();
  const now = clock();
  const T = normalTerms();
  const P = pricing(b, T.rate);
  const W = windowOf(b, now);
  checkWindow(W.starts, W.ends, now, { isNew: true });
  const budget = budgetOf(b.budget);
  guardBudget(budget, P.cap_cents, effectiveRate(P, T.rate), b);
  const label = cleanLabel(b.label);
  const enabled = b.enabled === undefined ? 1 : (b.enabled === true || b.enabled === 1 || b.enabled === "1" || b.enabled === "on") ? 1 : 0;
  const row = await tx(async () => {
    const o = await overlapping(W.starts, W.ends, null);
    if (o) throw refuse(`It overlaps promo ${o.id} - end or move that one first.`, 409);
    const id = await nextId();
    await runQuery(`INSERT INTO donation_promos (id, label, mode, rate, mult, cap_cents, budget_pat, bonus_base, enabled, starts, ends, ceiling_x, normal_rate,
                    created, created_by, updated, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, label || null, P.mode, P.rate, P.mult, P.cap_cents, budget, P.bonus_base, enabled, W.starts, W.ends, P.ceiling_x, P.normal_rate,
       now, admin.username || admin.userId, now, admin.username || admin.userId]);
    const r = (await getQuery("SELECT * FROM donation_promos WHERE id = ?", [id]))[0];
    await audit(admin, "create", { id, promo: r });
    return r;
  });
  await refresh();
  console.log(`[donpromo] ${row.id} created by ${admin.username}: ${P.mode === "rate" ? P.rate + " PAT/$1" : "x" + P.mult}, cap $${P.cap_cents / 100}, ` +
              `${new Date(W.starts).toISOString()} .. ${new Date(W.ends).toISOString()}`);
  return row;
}
const LOCKED = ["mode", "rate", "mult", "cap_usd", "bonus_base", "starts"];
/** Edit. Before it starts (and with no credits): anything. After: label, ends, budget, enabled only. */
async function edit(admin, id, b = {}) {
  await init();
  await auditReady();
  const now = clock();
  const row = await tx(async () => {
    const p = (await getQuery("SELECT * FROM donation_promos WHERE id = ?", [String(id)]))[0];
    if (!p || p.cancelled) throw refuse("No such promo.", 404);
    if (p.ends <= now) throw refuse("That promo is over - it can't be changed.", 409);
    const started = p.starts <= now || (await hasCredits(p.id));
    const next = { ...p };
    if (started) {
      const tried = LOCKED.filter((k) => b[k] !== undefined && b[k] !== null && b[k] !== "" && String(b[k]) !== String(k === "cap_usd" ? p.cap_cents / 100 : p[k]));
      if (tried.length || b.today) throw refuse(`The promo has started: ${tried.join(", ") || "the window"} can't change (donations were priced with it). You can change the label, the end, the budget and the switch.`, 409);
    } else {
      const P = pricing({ mode: b.mode ?? p.mode, rate: b.rate ?? p.rate, mult: b.mult ?? p.mult, cap_usd: b.cap_usd ?? p.cap_cents / 100,
                          bonus_base: b.bonus_base ?? p.bonus_base }, normalTerms().rate);
      Object.assign(next, P);
      if (b.starts !== undefined && b.starts !== "") next.starts = Math.floor(int(b.starts) / 1000) * 1000;
      if (b.today) { next.starts = Math.floor(now / 1000) * 1000; next.ends = nextMidnight(now); }
    }
    if (b.ends !== undefined && b.ends !== "" && !b.today) next.ends = int(b.ends);
    if (b.label !== undefined) next.label = cleanLabel(b.label) || null;
    if (b.budget !== undefined) {
      next.budget_pat = budgetOf(b.budget);
      if (next.budget_pat != null) {
        const used = (await usage(p.id, null)).usedBudget;
        if (next.budget_pat < used) throw refuse(`${used.toLocaleString("en-US")} PAT were already credited at the promo rate - the budget can't go below that.`);
      }
    }
    if (next.budget_pat != null && (String(next.budget_pat) !== String(p.budget_pat) || next.cap_cents !== p.cap_cents || next.rate !== p.rate || next.mult !== p.mult)) {
      guardBudget(next.budget_pat, next.cap_cents, effectiveRate(next, normalTerms().rate), b);
    }
    if (b.enabled !== undefined) next.enabled = (b.enabled === true || b.enabled === 1 || b.enabled === "1" || b.enabled === "on") ? 1 : 0;
    if (!Number.isFinite(next.starts) || !Number.isFinite(next.ends)) throw refuse("Bad times.");
    checkWindow(next.starts, next.ends, now, { isNew: !started && next.starts !== p.starts });
    const o = await overlapping(next.starts, next.ends, p.id);
    if (o) throw refuse(`It would overlap promo ${o.id}.`, 409);
    await runQuery(`UPDATE donation_promos SET label = ?, mode = ?, rate = ?, mult = ?, cap_cents = ?, budget_pat = ?, bonus_base = ?, enabled = ?, starts = ?,
                    ends = ?, ceiling_x = ?, normal_rate = ?, updated = ?, updated_by = ? WHERE id = ?`,
      [next.label, next.mode, next.rate, next.mult, next.cap_cents, next.budget_pat, next.bonus_base, next.enabled, next.starts, next.ends,
       next.ceiling_x, next.normal_rate, now, admin.username || admin.userId, p.id]);
    const changed = {};
    for (const k of ["label", "mode", "rate", "mult", "cap_cents", "budget_pat", "bonus_base", "enabled", "starts", "ends"]) if (String(p[k]) !== String(next[k])) changed[k] = [p[k], next[k]];
    await audit(admin, "edit", { id: p.id, changed });
    return (await getQuery("SELECT * FROM donation_promos WHERE id = ?", [p.id]))[0];
  });
  await refresh();
  return row;
}
/** End now (a live promo) or cancel (one that hasn't started and has no credits). */
async function end(admin, id) {
  await init();
  await auditReady();
  const now = clock();
  const row = await tx(async () => {
    const p = (await getQuery("SELECT * FROM donation_promos WHERE id = ?", [String(id)]))[0];
    if (!p || p.cancelled) throw refuse("No such promo.", 404);
    if (p.ends <= now) throw refuse("It's already over.", 409);
    if (p.starts > now && !(await hasCredits(p.id))) {
      await runQuery("UPDATE donation_promos SET cancelled = 1, ended_at = ?, ended_by = ?, updated = ? WHERE id = ?", [now, admin.username || admin.userId, now, p.id]);
      await audit(admin, "cancel", { id: p.id });
    } else {
      // whole seconds, like the start: a promo started right after this one ends in the same second doesn't overlap it
      const at = Math.max(p.starts, Math.floor(now / 1000) * 1000);
      await runQuery("UPDATE donation_promos SET ends = ?, ended_at = ?, ended_by = ?, updated = ? WHERE id = ?", [at, now, admin.username || admin.userId, now, p.id]);
      await audit(admin, "end", { id: p.id, was_ends: p.ends });
    }
    return (await getQuery("SELECT * FROM donation_promos WHERE id = ?", [p.id]))[0];
  });
  await refresh();
  return row;
}
const SETTING_CLEAN = {
  daily_limit_usd: (v) => { const n = Math.floor(Number(v)); if (!Number.isFinite(n) || n < 0 || n > 1000000) throw refuse("The daily limit is a whole number of dollars (0 = no limit)."); return n; },
  // 1.99uh: the global daily donation cap
  global_mode: (v) => { if (!["off", "fixed", "pct"].includes(String(v))) throw refuse("The global cap is off, a fixed PAT amount, or a % of supply."); return String(v); },
  global_pat: (v) => { const n = Math.floor(Number(v)); if (!Number.isFinite(n) || n < 0 || n > 1e13) throw refuse("The global cap is a whole number of PAT (0 = none)."); return n; },
  global_pct: (v) => { const n = Math.round(Number(v) * 10000) / 10000; if (!Number.isFinite(n) || n < 0 || n > 100) throw refuse("The global cap is 0 to 100 % of the supply."); return n; },
  global_usd: (v) => { const n = Math.floor(Number(v)); if (!Number.isFinite(n) || n < 0 || n > 10000000) throw refuse("The global USD cap is a whole number of dollars (0 = none)."); return n; },
  ceiling_x: (v) => { const n = Math.round(Number(v) * 100) / 100; if (!Number.isFinite(n) || n < 1 || n > HARD_CEILING_X) throw refuse(`The ceiling is 1 to ${HARD_CEILING_X} times the normal rate.`); return n; },
  bonus_base: (v) => { if (!BONUS_BASES[v]) throw refuse("Unknown bonus base."); return String(v); },
  tz: (v) => { if (!validTz(v)) throw refuse("Unknown time zone."); return String(v); },
};
async function setSettings(admin, b = {}) {
  await init();
  await auditReady();
  const changed = {};
  for (const [k, fn] of Object.entries(SETTING_CLEAN)) {
    if (b[k] === undefined || b[k] === "") continue;
    const v = fn(b[k]);
    if (JSON.stringify(v) === JSON.stringify(S[k])) continue;
    changed[k] = [S[k], v];
  }
  if (!Object.keys(changed).length) return { changed: {}, settings: { ...S } };
  await tx(async () => {
    for (const [k, [, v]] of Object.entries(changed)) {
      await runQuery("INSERT INTO donation_promo_settings (key, value, updated, actor) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated = excluded.updated, actor = excluded.actor",
        [k, JSON.stringify(v), clock(), admin.username || admin.userId]);
    }
    await audit(admin, "settings", { changed });
  });
  for (const [k, [, v]] of Object.entries(changed)) S[k] = v;
  return { changed, settings: { ...S } };
}
async function stats(id) {
  const r = (await getQuery(`SELECT COUNT(*) AS n, COUNT(DISTINCT COALESCE(user_id, donor_key)) AS donors, COALESCE(SUM(usd_cents),0) AS usd,
      COALESCE(SUM(promo_cents),0) AS promo_usd, COALESCE(SUM(promo_pat),0) AS promo_pat, COALESCE(SUM(normal_pat),0) AS normal_pat,
      COALESCE(SUM(bonus),0) AS bonus, COALESCE(SUM(promo_pat - (promo_cents * normal_rate) / 100),0) AS extra,
      COALESCE(SUM(CASE WHEN budget_short_cents > 0 THEN 1 ELSE 0 END),0) AS fallbacks, COALESCE(SUM(budget_short_cents),0) AS short
      FROM donation_promo_credits WHERE promo_id = ?`, [id]))[0];
  return { donations: r.n, donors: r.donors, usd_cents: r.usd, promo_cents: r.promo_usd, promo_pat: r.promo_pat, normal_pat: r.normal_pat, bonus: r.bonus,
           extra_pat: Math.max(0, Math.floor(r.extra)), budget_fallbacks: Number(r.fallbacks) || 0, budget_short_cents: Number(r.short) || 0 };
}
function statusOf(p, now) {
  if (p.cancelled) return "cancelled";
  if (p.ends <= now) return "ended";
  if (p.starts > now) return p.enabled ? "scheduled" : "draft";
  return p.enabled ? "live" : "paused";
}
/**
 * 1.99vi: the promo card's budget line: used / total in PAT and (at the promo rate) in dollars, whether it has run out while
 * the promo is still running, and whether it is smaller than one donor's allowance. null = no budget.
 */
function budgetState(p, st, rate, status) {
  if (p.budget_pat == null) return null;
  const r = rate || Number(p.rate) || 0;
  const used = Number(st.promo_pat) || 0, left = Math.max(0, p.budget_pat - used);
  const exhausted = r > 0 ? BUDGET.centsOf(left, r) < 1 : left <= 0;
  return { pat: p.budget_pat, used_pat: used, left_pat: left, cents: BUDGET.centsOf(p.budget_pat, r), used_cents: Number(st.promo_cents) || 0,
           exhausted, exhausted_live: exhausted && (status === "live" || status === "paused"), small: !!BUDGET.check(p.budget_pat, p.cap_cents, r),
           allowance_pat: BUDGET.allowance(p.cap_cents, r) };
}
/** The admin card: settings, the normal terms, every promo (newest first) with its numbers. */
async function adminState() {
  await init();
  const now = clock();
  const T = normalTerms();
  const rows = await getQuery("SELECT * FROM donation_promos ORDER BY starts DESC LIMIT 50");
  const promos = [];
  for (const p of rows) {
    const st = await stats(p.id), status = statusOf(p, now), rate = effectiveRate(p, T.rate);
    promos.push({ ...p, status, cap_usd: p.cap_cents / 100, effective_rate: rate, stats: st,
                  locked: p.starts <= now || (await hasCredits(p.id)), budget: budgetState(p, st, rate, status) });
  }
  let log = [];
  try { log = await require("./adminaudit").recent("donation_promo", 30); } catch (e) { log = []; }
  return { now, settings: { ...S }, normal: T, limit: await limitState(), global: await globalAdmin(now), limits: { hard_ceiling_x: HARD_CEILING_X, max_days: MAX_DAYS, max_cap_usd: MAX_CAP_USD },
           bonus_bases: BONUS_BASES, today_ends: nextMidnight(now), promos, log };
}
/** 1.99tq: promo PAT per UTC day (the supply history's "of which promo" line). */
async function promoByDay(sinceMs) {
  await init();
  const rows = await getQuery(`SELECT date(credited / 1000, 'unixepoch') AS day, SUM(promo_pat) AS pat, SUM(promo_pat - (promo_cents * normal_rate) / 100) AS extra
                               FROM donation_promo_credits WHERE credited >= ? GROUP BY day`, [sinceMs]);
  const out = {};
  for (const r of rows) out[r.day] = { pat: Number(r.pat) || 0, extra: Math.max(0, Math.floor(Number(r.extra) || 0)) };
  return out;
}

// ── routes ──
function register(app, { addUser, noTimers } = {}) {
  const guard = require("./middleware/authGuard");
  init().then(() => { if (!noTimers) startTimer(); }).catch((e) => console.error("[donpromo] setup:", e.message));
  const isAdmin = (u) => !!u && u.class === "Admin";
  const json = (fn, { admin = false, signed = admin } = {}) => [addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (req.method === "POST" && !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    if (signed && (!req.user || !req.user.userId)) return res.status(401).json({ ok: false, error: "Sign in first." });
    if (admin && !isAdmin(req.user)) return res.status(403).json({ ok: false, error: "Admins only." });
    try { res.json({ ok: true, ...(await fn(req, req.body || {})) }); } catch (e) {
      if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message, ...(e.code ? { code: e.code, detail: e.detail } : {}) });
      console.error("[donpromo]", e && e.message);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  }];
  // public: the live promo (+ your allowance), and ?usd=N -> what that would credit you right now
  app.get("/api/donate/promo", ...json(async (req) => {
    const uid = req.user && req.user.userId ? req.user.userId : null;
    const out = { promo: await live(uid), daily: await daily(uid), global: await globalPublic() };
    if (req.query.usd !== undefined) out.quote = await quote(uid, req.query.usd);
    return out;
  }));
  app.get("/api/admin/donpromo", ...json(async () => adminState(), { admin: true }));
  // 1.99ts: one member's daily donation limit override (the admin Users & Accounts page)
  const userByName = async (name) => (await getQuery("SELECT userId, username FROM users WHERE lower(username) = lower(?)", [String(name || "").trim()]))[0] || null;
  app.get("/api/admin/donlimit/user", ...json(async (req) => {
    const u = await userByName(req.query.username);
    if (!u) throw refuse("No such member.", 404);
    return { user: u, override: await overrideOf(u.userId), today: await daily(u.userId), default_usd: S.daily_limit_usd, tz: S.tz };
  }, { admin: true }));
  app.post("/api/admin/donlimit/user", ...json(async (req, b) => {
    const u = await userByName(b.username);
    if (!u) throw refuse("No such member.", 404);
    return { ...(await setOverride(req.user, u.userId, b.limit_usd, b.note)), username: u.username, today: await daily(u.userId) };
  }, { admin: true }));
  app.post("/api/admin/donpromo/create", ...json(async (req, b) => ({ promo: await create(req.user, b) }), { admin: true }));
  app.post("/api/admin/donpromo/settings", ...json(async (req, b) => setSettings(req.user, b), { admin: true }));
  app.post("/api/admin/donpromo/:id/edit", ...json(async (req, b) => ({ promo: await edit(req.user, req.params.id, b) }), { admin: true }));
  app.post("/api/admin/donpromo/:id/end", ...json(async (req) => ({ promo: await end(req.user, req.params.id) }), { admin: true }));
}

module.exports = {
  init, register, creditTerms, metaOf, noteOf, receiptLine, split, effectiveRate, live, liveCached, quote, create, edit, end, setSettings, adminState,
  promoByDay, nextMidnight, dayWindow, daily, limitCheck, reserveCheckout, attachSession, releaseHold, expireSession, recordCredit,
  setOverride, overrideOf, limitState, donorKeyOf, budgetState,
  // 1.99uh
  previewTerms, ensureFrozen, globalCaps, globalCheck, globalPublic, globalAdmin, globalMaxUsd, prepare, dayKey, mintOf,
  _setSupply: (fn) => { supplyFn = fn || (async () => (await require("./supply").patSupply()).total); }, refresh, Refuse, BONUS_BASES, DEFAULTS, MAX_DAYS, HARD_CEILING_X, MAX_CAP_USD,
  settings: () => ({ ...S }),
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
};
