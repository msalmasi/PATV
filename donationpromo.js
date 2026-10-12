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

const DAY = 86400000;
const MAX_DAYS = 7;
const HARD_CEILING_X = 50;
const MAX_CAP_USD = 1000;                    // = stripebilling DONATE_MAX_USD
const BONUS_BASES = Object.freeze({
  normal: "only on the PAT credited at the normal rate (promo dollars add no bonus)",
  equivalent: "on what the donation would have credited at the normal rate (the incentive budget gets the same as without a promo)",
  all: "on every PAT credited, promo portion included (the old formula: bonus = pat x %)",
});
const DEFAULTS = Object.freeze({ ceiling_x: 10, bonus_base: "normal", tz: "America/New_York" });
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
      await runQuery("CREATE TABLE IF NOT EXISTS donation_promo_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated INTEGER, actor TEXT)");
      for (const r of await getQuery("SELECT key, value FROM donation_promo_settings")) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULTS, r.key)) continue;
        try { S[r.key] = JSON.parse(r.value); } catch (e) { /* keep the default */ }
      }
      await refresh();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

class Refuse extends Error { constructor(status, message) { super(message); this.status = status; this.refuse = true; } }
const refuse = (m, s = 400) => new Refuse(s, m);
const normalTerms = () => { try { return require("./funding").donationTerms(); } catch (e) { return { rate: 500000, bonus_pct: 20 }; } };

// ── the cache (sync readers: the homepage banner) ──
let CACHE = [];
async function refresh() {
  CACHE = await getQuery("SELECT * FROM donation_promos WHERE cancelled = 0 AND ends > ? ORDER BY starts", [clock() - 60000]);
  return CACHE;
}
let timer = null;
function startTimer() { if (!timer) { timer = setInterval(() => refresh().catch(() => {}), 60000); if (timer.unref) timer.unref(); } }

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
    const plain = { ...split({ cents, normalRate: T.rate, bonusPct: T.bonus_pct }), promo: null };
    const at = Number(paidAt);
    const id = identity(userId, donorKey);
    if (!ref || !Number.isFinite(at) || !id) return plain;
    const p = await promoAt(at);
    if (!p) return plain;
    const rate = effectiveRate(p, T.rate);
    if (!rate) return plain;
    const u = await usage(p.id, id);
    const s = split({ cents, normalRate: T.rate, bonusPct: T.bonus_pct, usedCents: u.usedCents, usedBudget: u.usedBudget,
                      promo: { rate, capCents: p.cap_cents, budgetPat: p.budget_pat, bonusBase: p.bonus_base } });
    await runQuery(`INSERT INTO donation_promo_credits (ref, promo_id, user_id, donor_key, via, paid_at, credited, usd_cents, promo_cents, normal_cents,
                    promo_rate, normal_rate, promo_pat, normal_pat, bonus, bonus_pct) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [String(ref), p.id, id.col === "user_id" ? id.v : null, id.col === "donor_key" ? id.v : null, via, at, clock(), s.usd_cents, s.promo_cents,
       s.normal_cents, rate, T.rate, s.promo_pat, s.normal_pat, s.bonus, T.bonus_pct]);
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
  const p = await promoAt(now);
  const rate = p ? effectiveRate(p, T.rate) : 0;
  if (!p || !rate) return { ...split({ cents, normalRate: T.rate, bonusPct: T.bonus_pct }), promo: null };
  const u = await usage(p.id, identity(userId));
  const s = split({ cents, normalRate: T.rate, bonusPct: T.bonus_pct, usedCents: u.usedCents, usedBudget: u.usedBudget,
                    promo: { rate, capCents: p.cap_cents, budgetPat: p.budget_pat, bonusBase: p.bonus_base } });
  return { ...s, promo: { id: p.id, label: p.label || null } };
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
const validTz = (z) => { try { new Intl.DateTimeFormat("en-US", { timeZone: String(z) }); return true; } catch (e) { return false; } };

// ── admin ──
const int = (v) => { if (v === null || v === undefined || v === "" || typeof v === "boolean") return null; const n = Number(v); return Number.isFinite(n) ? Math.floor(n) : NaN; };
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
function windowOf(b, now) {
  let starts = b.starts == null || b.starts === "" ? now : int(b.starts);
  let ends = int(b.ends);
  if (b.today) { starts = now; ends = nextMidnight(now); }
  if (!Number.isFinite(starts)) throw refuse("Bad start time.");
  if (!Number.isFinite(ends)) throw refuse("An end time is required.");
  return { starts, ends };
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
      if (b.starts !== undefined && b.starts !== "") next.starts = int(b.starts);
      if (b.today) { next.starts = now; next.ends = nextMidnight(now); }
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
      await runQuery("UPDATE donation_promos SET ends = ?, ended_at = ?, ended_by = ?, updated = ? WHERE id = ?", [now, now, admin.username || admin.userId, now, p.id]);
      await audit(admin, "end", { id: p.id, was_ends: p.ends });
    }
    return (await getQuery("SELECT * FROM donation_promos WHERE id = ?", [p.id]))[0];
  });
  await refresh();
  return row;
}
const SETTING_CLEAN = {
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
      COALESCE(SUM(bonus),0) AS bonus, COALESCE(SUM(promo_pat - (promo_cents * normal_rate) / 100),0) AS extra
      FROM donation_promo_credits WHERE promo_id = ?`, [id]))[0];
  return { donations: r.n, donors: r.donors, usd_cents: r.usd, promo_cents: r.promo_usd, promo_pat: r.promo_pat, normal_pat: r.normal_pat, bonus: r.bonus,
           extra_pat: Math.max(0, Math.floor(r.extra)) };
}
function statusOf(p, now) {
  if (p.cancelled) return "cancelled";
  if (p.ends <= now) return "ended";
  if (p.starts > now) return p.enabled ? "scheduled" : "draft";
  return p.enabled ? "live" : "paused";
}
/** The admin card: settings, the normal terms, every promo (newest first) with its numbers. */
async function adminState() {
  await init();
  const now = clock();
  const T = normalTerms();
  const rows = await getQuery("SELECT * FROM donation_promos ORDER BY starts DESC LIMIT 50");
  const promos = [];
  for (const p of rows) {
    promos.push({ ...p, status: statusOf(p, now), cap_usd: p.cap_cents / 100, effective_rate: effectiveRate(p, T.rate), stats: await stats(p.id),
                  locked: p.starts <= now || (await hasCredits(p.id)) });
  }
  let log = [];
  try { log = await require("./adminaudit").recent("donation_promo", 30); } catch (e) { log = []; }
  return { now, settings: { ...S }, normal: T, limits: { hard_ceiling_x: HARD_CEILING_X, max_days: MAX_DAYS, max_cap_usd: MAX_CAP_USD },
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
      if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message });
      console.error("[donpromo]", e && e.message);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  }];
  // public: the live promo (+ your allowance), and ?usd=N -> what that would credit you right now
  app.get("/api/donate/promo", ...json(async (req) => {
    const uid = req.user && req.user.userId ? req.user.userId : null;
    const out = { promo: await live(uid) };
    if (req.query.usd !== undefined) out.quote = await quote(uid, req.query.usd);
    return out;
  }));
  app.get("/api/admin/donpromo", ...json(async () => adminState(), { admin: true }));
  app.post("/api/admin/donpromo/create", ...json(async (req, b) => ({ promo: await create(req.user, b) }), { admin: true }));
  app.post("/api/admin/donpromo/settings", ...json(async (req, b) => setSettings(req.user, b), { admin: true }));
  app.post("/api/admin/donpromo/:id/edit", ...json(async (req, b) => ({ promo: await edit(req.user, req.params.id, b) }), { admin: true }));
  app.post("/api/admin/donpromo/:id/end", ...json(async (req) => ({ promo: await end(req.user, req.params.id) }), { admin: true }));
}

module.exports = {
  init, register, creditTerms, metaOf, noteOf, receiptLine, split, effectiveRate, live, liveCached, quote, create, edit, end, setSettings, adminState,
  promoByDay, nextMidnight, donorKeyOf, refresh, Refuse, BONUS_BASES, DEFAULTS, MAX_DAYS, HARD_CEILING_X, MAX_CAP_USD,
  settings: () => ({ ...S }),
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
};
