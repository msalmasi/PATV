// premium.js — PATV's two paid tiers (1.99iv): 📺 PRIME TIME (a PAD tier) and 🎟️ SEASON PASS (a personal tier),
// "akin to Discord's server boosts and Nitro". Paid in PAT (this file) or - later, switched off and hidden today -
// with real money through Stripe (stripebilling.js maps a Stripe subscription onto the same rows).
//
// TIERS (prices are settings, premium_config; the first prices are an experiment)
//   prime_time   a pad's tier          10,000,000 PAT / 30 days   target = the pad's room id
//   season_pass  one account's tier    2,000,000 PAT / 30 days   target = the user's id
//
// WHO PAYS
//   * anyone signed in can BUY whole periods for a pad (its owner, a member, a fan) or for themselves / another
//     account (a GIFT: the receiver gets an inbox notice) - {months: 1..12};
//   * anyone can CONTRIBUTE part of a period to a pad: {amount} buys amount / price * 30 days of Prime Time (at
//     least one day's worth). Contributions stack: every payment extends the paid-through date, so a pad's
//     regulars can keep it on air together;
//   * AUTO-RENEW: one account per subscription can be its renewer (the pad's owner, or whoever paid; for a Season
//     Pass the holder). The DAILY JOB (tick) charges the renewer one period when it's due.
//   Prepaying is capped at MAX_AHEAD_DAYS ahead.
//
// LIFECYCLE   active (paid through a date) -> due: the daily job charges the renewer (idempotent per period)
//             -> can't pay / no renewer: GRACE for grace_days (perks stay on while a renewal is still possible: a
//                renewer is set or a Stripe subscription is running; without one the perks end on the paid date)
//             -> LAPSED: perks off. Nothing is deleted - equipped Prime Time / Season Pass cosmetics just stop
//                rendering and come back when the tier does. The renewer is dropped at the lapse (nobody gets
//                charged weeks later by surprise) and the holder / pad owner gets an inbox notice.
//   COMPED: a site admin's own account and pads have both tiers for free (comp_admins, re-checked by every daily
//   run: an account that stops being an admin loses its automatic comps; comps made by hand stay).
//
// WHERE THE PAT GOES - a routing-table row per flow (premium_config routes, admin-editable like Pepe's PAT Routing
// table; whatever a row doesn't route goes to the Federal Reserve, and nothing is ever burned):
//   prime_time   [fortknox 50, room 50]   - the pad-spend rule every other pad flow follows (boosts, pad cosmetics):
//                half to Fort Knox, half to THE PAD'S ROOM VAULT ("room:prime_time:<room>" claim, Pepe's E-3 vault).
//                The pad's OWNER paying for their own pad: the room share goes to Fort Knox too (self-spend never
//                feeds your own vault, ECONOMY-V2 7.1). No vault (room vaults not live, or not a Camfrog pad): the
//                room share goes to Fort Knox - there's no new escrow.
//   season_pass  [fortknox 100]          - a personal purchase: economy v2 sends purchase spending to Fort Knox.
//   stickers     [fortknox 100]          - same (stickers.js).
//   A "fortknox" share is a negative reserve_claims row: "fortknox:<flow>" while Fort Knox is live in Pepe
//   (funding.fortknoxLive()), else "<flow>" (his Federal Reserve as Fort Knox's stand-in, as boosts do); "reserve"
//   is "<flow>". Pepe's funding tick credits every claim once (frida-bot _funding_tick).
//
// CRASH SAFETY: a charge is ONE SQLite transaction (boosts.tx): the debit (ledger.postOrThrow, the transaction id is
// derived from the ref), the routing claims, the premium_ledger row (UNIQUE ref) and the subscription's new date
// commit together or not at all. Renewals use the ref "renew:<sub>:<paid_through>": a second run of the daily job
// (or two processes) finds the row and charges nothing.
//
// Routes (JSON, same-site):
//   GET  /premium                         the page (both tiers, perks, prices, your status; ?pad=<slug> focuses a pad)
//   GET  /api/premium/state[?pad=<slug>]  config + the viewer's Season Pass + the pad's Prime Time
//   POST /api/premium/buy                 {tier, pad | user, months | amount, ref, renew}
//   POST /api/premium/renew               {tier, pad | user, on}      become / stop being the renewer
//   GET|POST /api/premium/admin           staff: config (prices, grace, routes, perks), comps, totals; {comp:{tier, pad|user, on}}
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");

const DAY = 24 * 3600 * 1000;
const MAX_AHEAD_DAYS = 400;
const REF_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TIERS = Object.freeze({
  prime_time: Object.freeze({ id: "prime_time", kind: "pad", name: "Prime Time", emoji: "📺", priceKey: "prime_price", flow: "prime_time" }),
  season_pass: Object.freeze({ id: "season_pass", kind: "user", name: "Season Pass", emoji: "🎟️", priceKey: "season_price", flow: "season_pass" }),
});
const ROUTE_DESTS = Object.freeze(["fortknox", "reserve", "room"]);
const ROUTE_FLOWS = Object.freeze({
  prime_time: { label: "📺 Prime Time (pad tier)", room: true },
  season_pass: { label: "🎟️ Season Pass (personal tier)", room: false },
  stickers: { label: "🧸 Sticker packs", room: false },
});
const DEFAULTS = Object.freeze({
  sales: true,                     // PAT purchases on (off: buying is refused, renewals still run)
  prime_price: 10000000,           // PAT per period (experimental)
  season_price: 2000000,
  period_days: 30,
  grace_days: 3,
  comp_admins: true,               // site admins' accounts + pads get both tiers free
  prime_extra_slots: 2,            // stage slots a Prime Time pad may add on top of the site cap
  prime_extra_badges: 2,           // pad badges on top of the normal 3
  sp_upload_mult: 2,               // Season Pass: feed upload size / daily / quota multiplier
  sp_sticker_packs: 1,             // Season Pass: free sticker packs per period
  sticker_price: 250000,           // PAT per sticker pack (stickers.js; a pack's own price wins)
  routes: { prime_time: [["fortknox", 50], ["room", 50]], season_pass: [["fortknox", 100]], stickers: [["fortknox", 100]] },
});

let clock = () => Date.now();
const now = () => clock();
const fmt = (n) => Number(n).toLocaleString("en-US");

class Refuse extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.refuse = true; this.code = code || codeFor(status); }
}
function codeFor(st) {
  return { 400: "E_BAD_ARGS", 401: "E_NO_PERMISSION", 402: "E_INSUFFICIENT_PAT", 403: "E_NO_PERMISSION", 404: "E_TARGET_NOT_FOUND",
           409: "E_ALREADY", 423: "E_FEATURE_OFF", 429: "E_RATE_LIMITED" }[st] || "E_REFUSED";
}

// ── config ──
function cleanRoutes(raw) {
  const out = {};
  for (const flow of Object.keys(ROUTE_FLOWS)) {
    const shares = raw && Array.isArray(raw[flow]) ? raw[flow] : null;
    let ok = !!shares, total = 0;
    const clean = [];
    for (const sh of (shares || []).slice(0, 3)) {
      const dest = Array.isArray(sh) ? String(sh[0]) : "";
      const pct = Array.isArray(sh) ? Math.round(Number(sh[1]) * 100) / 100 : NaN;
      if (!ROUTE_DESTS.includes(dest) || !(pct >= 0 && pct <= 100) || (dest === "room" && !ROUTE_FLOWS[flow].room)) { ok = false; break; }
      if (pct > 0) { clean.push([dest, pct]); total += pct; }
    }
    out[flow] = ok && total <= 100.0001 ? clean : DEFAULTS.routes[flow].map((s) => s.slice());
  }
  return out;
}
function cleanConfig(c) {
  const int = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  const on = (v, d) => (v === undefined || v === null || v === "" ? d : v === true || v === "true" || v === 1 || v === "1" || v === "on");
  return {
    sales: on(c.sales, DEFAULTS.sales),
    prime_price: int(c.prime_price, 1000, 1e12, DEFAULTS.prime_price),
    season_price: int(c.season_price, 1000, 1e12, DEFAULTS.season_price),
    period_days: int(c.period_days, 1, 365, DEFAULTS.period_days),
    grace_days: int(c.grace_days, 0, 30, DEFAULTS.grace_days),
    comp_admins: on(c.comp_admins, DEFAULTS.comp_admins),
    prime_extra_slots: int(c.prime_extra_slots, 0, 8, DEFAULTS.prime_extra_slots),
    prime_extra_badges: int(c.prime_extra_badges, 0, 5, DEFAULTS.prime_extra_badges),
    sp_upload_mult: int(c.sp_upload_mult, 1, 10, DEFAULTS.sp_upload_mult),
    sp_sticker_packs: int(c.sp_sticker_packs, 0, 20, DEFAULTS.sp_sticker_packs),
    sticker_price: int(c.sticker_price, 1, 1e12, DEFAULTS.sticker_price),
    routes: cleanRoutes(c.routes),
  };
}
let CONFIG = cleanConfig({});
const config = () => JSON.parse(JSON.stringify(CONFIG));
const priceOf = (tier) => CONFIG[TIERS[tier].priceKey];

// ── tables ──
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await require("./boosts").init();            // reserve_claims (+ room_flow_ledger)
      await runQuery("CREATE TABLE IF NOT EXISTS premium_config (key TEXT PRIMARY KEY, value TEXT)");
      await runQuery(`CREATE TABLE IF NOT EXISTS premium_subs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, tier TEXT NOT NULL, target TEXT NOT NULL,
        paid_through INTEGER NOT NULL DEFAULT 0, renewer_id TEXT, comped INTEGER NOT NULL DEFAULT 0, comp_by TEXT, comp_note TEXT,
        stripe_sub TEXT, stripe_customer TEXT, stripe_through INTEGER NOT NULL DEFAULT 0, stripe_user TEXT,
        status TEXT NOT NULL DEFAULT 'none', notified TEXT, started INTEGER NOT NULL, updated INTEGER NOT NULL)`);
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS premium_subs_target ON premium_subs (tier, target)");
      await runQuery("CREATE INDEX IF NOT EXISTS premium_subs_stripe ON premium_subs (stripe_sub)");
      await runQuery(`CREATE TABLE IF NOT EXISTS premium_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT NOT NULL, sub_id INTEGER NOT NULL, tier TEXT NOT NULL, target TEXT NOT NULL,
        kind TEXT NOT NULL, payer_id TEXT, payer_name TEXT, amount INTEGER NOT NULL DEFAULT 0, days REAL NOT NULL DEFAULT 0,
        period_from INTEGER, period_to INTEGER, routing TEXT, via TEXT, created INTEGER NOT NULL)`);
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS premium_ledger_ref ON premium_ledger (ref)");
      await runQuery("CREATE INDEX IF NOT EXISTS premium_ledger_sub ON premium_ledger (sub_id, created)");
      await runQuery("CREATE TABLE IF NOT EXISTS premium_jobs (day TEXT PRIMARY KEY, started INTEGER NOT NULL, finished INTEGER, result TEXT)");
      await loadConfig();
      await loadCache();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
async function loadConfig() {
  const c = {};
  for (const r of await getQuery("SELECT key, value FROM premium_config")) { try { c[r.key] = JSON.parse(r.value); } catch (e) { /* skip */ } }
  CONFIG = cleanConfig(c);
  return CONFIG;
}
async function setConfig(patch, actor) {
  await init();
  const next = cleanConfig({ ...CONFIG, ...(patch || {}), routes: patch && patch.routes ? { ...CONFIG.routes, ...patch.routes } : CONFIG.routes });
  for (const k of Object.keys(DEFAULTS)) {
    await runQuery("INSERT INTO premium_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [k, JSON.stringify(next[k])]);
  }
  CONFIG = next;
  await audit(null, "premium-config", actor, JSON.stringify(next));
  return config();
}
async function audit(roomId, what, actor, detail) {
  try { await require("./rooms").event(roomId, what, actor || "?", String(detail || "").slice(0, 500)); } catch (e) { /* audit only */ }
}

// ── entitlements (a sync cache for views / other modules; every write reloads it) ──
let CACHE = new Map();           // "tier:target" -> sub row
let cacheAt = 0;
async function loadCache() {
  const m = new Map();
  for (const r of await getQuery("SELECT * FROM premium_subs")) m.set(r.tier + ":" + r.target, r);
  CACHE = m; cacheAt = now();
}
function maybeRefresh() {
  if (ready && now() - cacheAt > 60000) { cacheAt = now(); loadCache().catch((e) => console.error("[premium] cache:", e.message)); }
}
/** The date a subscription's perks end (Infinity = comped), grace included while a renewal is still possible. */
function endsAt(sub, t = now()) {
  if (!sub) return 0;
  if (sub.comped) return Infinity;
  const paid = Math.max(Number(sub.paid_through) || 0, Number(sub.stripe_through) || 0);
  const renewing = !!(sub.renewer_id || sub.stripe_sub);
  return renewing ? paid + CONFIG.grace_days * DAY : paid;
}
/** 'comped' | 'active' | 'grace' | 'lapsed' | 'none' */
function statusOf(sub, t = now()) {
  if (!sub) return "none";
  if (sub.comped) return "comped";
  const paid = Math.max(Number(sub.paid_through) || 0, Number(sub.stripe_through) || 0);
  if (t < paid) return "active";
  if (t < endsAt(sub, t)) return "grace";
  return paid > 0 ? "lapsed" : "none";
}
function subSync(tier, target) { maybeRefresh(); return CACHE.get(tier + ":" + String(target || "")) || null; }
const activeSync = (tier, target, t = now()) => { const s = subSync(tier, target); return !!s && t < endsAt(s, t); };
/** pad.primeTime: does this pad have Prime Time right now? (sync, cached) */
const isPrime = (roomId, t) => activeSync("prime_time", roomId, t);
/** Does this account have a Season Pass right now? (sync, cached) */
const hasPass = (userId, t) => activeSync("season_pass", userId, t);
/** The perks a pad / an account gets right now (other modules ask this, never the tables). */
function padPerks(roomId) {
  const on = isPrime(roomId);
  return { primeTime: on, extraSlots: on ? CONFIG.prime_extra_slots : 0, extraBadges: on ? CONFIG.prime_extra_badges : 0, lowLatency: on };
}
function userPerks(userId) {
  const on = hasPass(userId);
  return { seasonPass: on, uploadMult: on ? CONFIG.sp_upload_mult : 1, stickerPacks: on ? CONFIG.sp_sticker_packs : 0 };
}

/** After a subscription changed: a live Season Pass gets its perk items in the inventory; name styles re-render. */
async function afterChange(tier, target) {
  try {
    const C = require("./cosmetics");
    if (tier === "season_pass" && hasPass(target)) await C.grantSeasonPerks(target);
    else if (C.invalidateNames) C.invalidateNames();
  } catch (e) { console.error("[premium] perks:", e.message); }
}

// ── routing (pure split + booking inside the caller's transaction) ──
/** shares [[dest, pct]] x amount -> [{dest, amount}]; the remainder (rounding included) goes to the Reserve. */
function splitRoute(shares, amount) {
  const a = Math.max(0, Math.floor(Number(amount) || 0));
  const out = [];
  let used = 0;
  for (const [dest, pct] of shares || []) {
    const part = Math.floor(a * Number(pct) / 100);
    if (part > 0) { out.push({ dest, amount: part }); used += part; }
  }
  const rest = a - used;
  if (rest > 0) {
    const r = out.find((x) => x.dest === "reserve");
    if (r) r.amount += rest; else out.push({ dest: "reserve", amount: rest });
  }
  return out;
}
/**
 * Book `amount` PAT the site just collected for `flow` (its routing row), INSIDE the open transaction.
 * opts: {roomId, ownerSelf, payerId, label}. -> [{dest, amount, claim_flow}]
 */
async function bookRoute(flow, amount, opts = {}) {
  const { v4: uuidv4 } = require("uuid");
  const funding = require("./funding");
  const parts = splitRoute(CONFIG.routes[flow] || [["fortknox", 100]], amount);
  // the room share: only a pad that can have a vault, never the owner's own spend, only while vaults are live
  let roomOk = false;
  if (parts.some((p) => p.dest === "room") && opts.roomId && !opts.ownerSelf && funding.roomVaultsLive()) {
    roomOk = await require("./boosts").vaultEligible(opts.roomId);
  }
  const fk = funding.fortknoxLive();
  const merged = new Map();
  for (const p of parts) {
    let flowName;
    if (p.dest === "room" && roomOk) flowName = `room:${flow}:${opts.roomId}`;
    else if (p.dest === "room" || p.dest === "fortknox") flowName = fk ? "fortknox:" + flow : flow;
    else flowName = flow;                                                        // reserve
    const dest = flowName.startsWith("room:") ? "room" : flowName.startsWith("fortknox:") ? "fortknox" : (p.dest === "reserve" ? "reserve" : "fortknox_standin");
    const k = flowName;
    const cur = merged.get(k) || { dest, amount: 0, claim_flow: flowName };
    cur.amount += p.amount;
    merged.set(k, cur);
  }
  const out = [...merged.values()];
  for (const p of out) {
    await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES (?, ?, ?, ?, ?)",
                   [uuidv4(), p.claim_flow, opts.payerId || null, `${opts.label || flow}: ${p.dest}`.slice(0, 120), -p.amount]);
  }
  return out;
}

// ── targets ──
async function padTarget(slugOrId) {
  const rooms = require("./rooms");
  await rooms.init();
  const s = String(slugOrId || "").trim().replace(/^p\//i, "");
  if (!s) return null;
  let R = await rooms.bySlug(s);
  if (!R) R = await rooms.get(s);
  if (!R || R.profile) return null;
  return R;
}
async function userTarget(name) {
  const s = String(name || "").trim().replace(/^@/, "").replace(/^u\//i, "");
  if (!s) return null;
  return (await getQuery("SELECT userId, username, displayname, class FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1", [s]))[0] || null;
}
async function subRow(tier, target) {
  return (await getQuery("SELECT * FROM premium_subs WHERE tier = ? AND target = ?", [tier, target]))[0] || null;
}
async function ensureSub(tier, target, t) {
  await runQuery("INSERT OR IGNORE INTO premium_subs (tier, target, started, updated) VALUES (?, ?, ?, ?)", [tier, target, t, t]);
  return subRow(tier, target);
}
function txRef(ref) { return "prem-" + crypto.createHash("sha256").update(ref).digest("hex").slice(0, 32); }
const tx = (fn) => require("./boosts").tx(fn);

/**
 * Pay for a tier. user = {userId, username}; opts = {tier, pad (slug/id) | user (username), months | amount, ref,
 * renew (true: become the renewer), via}. Idempotent per (user, ref).
 * -> {dup, tier, target, amount, days, paid_through, routing, gift}
 */
async function buy(user, opts = {}) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const T = TIERS[String(opts.tier || "")];
  if (!T) throw new Refuse(400, "Pick Prime Time or Season Pass.");
  if (!CONFIG.sales) throw new Refuse(423, `${T.name} isn't on sale right now.`);
  const rawRef = String(opts.ref || "");
  if (!REF_RE.test(rawRef)) throw new Refuse(400, "Bad request (ref).");
  const ref = `prem:${user.userId}:${rawRef}`;
  const price = priceOf(T.id);
  const P = CONFIG.period_days;
  // what's being paid for
  let target, label, ownerSelf = false, roomId = null, recipient = null, R = null;
  if (T.kind === "pad") {
    R = await padTarget(opts.pad);
    if (!R) throw new Refuse(404, "No such pad.");
    target = R.id; roomId = R.id; label = `p/${R.slug || R.id}`;
    ownerSelf = !!(R.owner && R.owner.userId === user.userId);
    if (R.owner && R.owner.userId) recipient = R.owner.userId;
  } else {
    const who = opts.user ? await userTarget(opts.user) : { userId: user.userId, username: user.username };
    if (!who) throw new Refuse(404, "No such account.");
    target = who.userId; label = `u/${who.username}`; ownerSelf = who.userId === user.userId;
    if (!ownerSelf) recipient = who.userId;
  }
  let amount, days;
  if (opts.amount != null && opts.months == null) {
    if (T.kind !== "pad") throw new Refuse(400, "A Season Pass is bought by the month.");
    amount = Math.floor(Number(opts.amount));
    const minAmt = Math.ceil(price / P);
    if (!Number.isFinite(amount) || amount < minAmt) throw new Refuse(400, `Chip in at least ${fmt(minAmt)} PAT (one day of ${T.name}).`);
    if (amount > price * 12) throw new Refuse(400, `At most ${fmt(price * 12)} PAT at a time.`);
    days = amount * P / price;
  } else {
    const months = Math.floor(Number(opts.months == null ? 1 : opts.months));
    if (!Number.isFinite(months) || months < 1 || months > 12) throw new Refuse(400, "Between 1 and 12 periods.");
    amount = price * months; days = P * months;
  }
  const t = now();
  const via = opts.via === "chat" ? "chat" : "web";
  const out = await tx(async () => {
    const had = (await getQuery("SELECT * FROM premium_ledger WHERE ref = ?", [ref]))[0];
    if (had) return { dup: true, row: had };
    const sub = await ensureSub(T.id, target, t);
    if (sub.comped) throw new Refuse(409, `${label} already has ${T.name} for free.`);
    const from = Math.max(t, Number(sub.paid_through) || 0, Number(sub.stripe_through) || 0);
    const to = Math.round(from + days * DAY);
    if (to - t > MAX_AHEAD_DAYS * DAY) throw new Refuse(409, `${label} is paid up far enough ahead already (at most ${MAX_AHEAD_DAYS} days).`);
    const u = (await getQuery("SELECT username FROM users WHERE userId = ?", [user.userId]))[0];
    if (!u) throw new Refuse(404, "Couldn't find your account.");
    const kind = opts.amount != null && opts.months == null ? "contribute" : ownerSelf ? "buy" : "gift";
    const L = require("./ledger");
    const res = await L.post(user.userId, -amount, `${T.emoji} ${T.name} ${kind === "contribute" ? "contribution" : kind}: ${label}`.slice(0, 120),
                             { requireCover: true, transactionId: txRef(ref), source: "premium" });
    if (!res.ok) throw new Refuse(402, `That's ${fmt(amount)} PAT - you don't have enough.`);
    const routing = await bookRoute(T.flow, amount, { roomId, ownerSelf: T.kind === "pad" ? ownerSelf : true, payerId: user.userId, label: `${T.name} ${label}` });
    await runQuery(`INSERT INTO premium_ledger (ref, sub_id, tier, target, kind, payer_id, payer_name, amount, days, period_from, period_to, routing, via, created)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                   [ref, sub.id, T.id, target, kind, user.userId, u.username, amount, days, from, to, JSON.stringify(routing), via, t]);
    const renewer = opts.renew === true && (!sub.renewer_id || sub.renewer_id === user.userId || ownerSelf) && (T.kind === "pad" || ownerSelf)
      ? user.userId : sub.renewer_id;
    await runQuery("UPDATE premium_subs SET paid_through = ?, renewer_id = ?, status = 'active', notified = NULL, updated = ? WHERE id = ?",
                   [to, renewer || null, t, sub.id]);
    return { dup: false, username: u.username, kind, routing, to, from, subId: sub.id };
  });
  await loadCache();
  if (!out.dup) await afterChange(T.id, target);
  if (out.dup) {
    const r = out.row;
    return { dup: true, tier: T.id, target, amount: r.amount, days: r.days, paid_through: r.period_to, routing: JSON.parse(r.routing || "[]"), gift: r.kind === "gift" };
  }
  await audit(roomId, "premium-" + out.kind, out.username, `${T.id} ${label} ${amount} PAT ${days.toFixed(2)}d -> ${new Date(out.to).toISOString().slice(0, 10)}`);
  if (roomId) telemetry(ref, roomId, out.username, ownerSelf, amount, via, t);
  if (recipient && recipient !== user.userId) {
    await notify(recipient, T.kind === "pad" ? "room" : "cosmetics", `prem-${out.subId}-${ref}`,
      `${T.emoji} ${out.username} ${out.kind === "contribute" ? "chipped in" : "paid"} for ${T.name} on ${label}`,
      `${out.username} added ${days >= 1 ? Math.floor(days) + " day" + (Math.floor(days) === 1 ? "" : "s") : "time"} of ${T.name} - paid through ${new Date(out.to).toISOString().slice(0, 10)}.`,
      T.kind === "pad" && R ? `/premium?pad=${encodeURIComponent(R.slug || R.id)}` : "/premium");
  }
  return { dup: false, tier: T.id, target, amount, days, paid_through: out.to, routing: out.routing, gift: out.kind === "gift", kind: out.kind };
}
function telemetry(ref, roomId, login, ownerSelf, amount, via, t) {
  try {
    require("./econ").ingestCharges([{ ref: String(ref).replace(/[^A-Za-z0-9_-]/g, "_").slice(-64), ts: t, room: roomId, flow: "prime_time", kind: "room",
      payer: login || "", payer_kind: ownerSelf ? "owner" : "other", amount, via }]).catch(() => {});
  } catch (e) { /* telemetry only */ }
}
async function notify(userId, kind, ref, title, body, link) {
  try { await require("./inbox").addSafe(userId, { kind, ref, title, body, link }); } catch (e) { /* never blocks */ }
}

/** Become (on) / stop being (off) a subscription's renewer. */
async function setRenew(user, opts = {}) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const T = TIERS[String(opts.tier || "")];
  if (!T) throw new Refuse(400, "Pick Prime Time or Season Pass.");
  let target, owner = false, manage = false;
  if (T.kind === "pad") {
    const R = await padTarget(opts.pad);
    if (!R) throw new Refuse(404, "No such pad.");
    target = R.id; owner = !!(R.owner && R.owner.userId === user.userId);
    manage = owner || (await require("./rooms").canManage(user, R.id));
  } else { target = user.userId; owner = manage = true; }
  const on = opts.on !== false && opts.on !== "false" && opts.on !== 0;
  const sub = await subRow(T.id, target);
  if (!sub) throw new Refuse(404, `Nothing to renew - get ${T.name} first.`);
  if (on) {
    if (sub.renewer_id && sub.renewer_id !== user.userId && !owner) throw new Refuse(409, "Someone else already renews this one.");
    await runQuery("UPDATE premium_subs SET renewer_id = ?, updated = ? WHERE id = ?", [user.userId, now(), sub.id]);
  } else {
    if (sub.renewer_id !== user.userId && !manage) throw new Refuse(403, "Only the renewer or the pad's owner can switch that off.");
    await runQuery("UPDATE premium_subs SET renewer_id = NULL, updated = ? WHERE id = ?", [now(), sub.id]);
  }
  await loadCache();
  return { on, renewer: on ? user.username : null };
}

// ── comps ──
/** Comp (on) or un-comp a tier for a target. by = who; auto = the admin auto-comp. */
async function setComp(tier, target, on, by, note) {
  await init();
  if (!TIERS[tier]) throw new Refuse(400, "Unknown tier.");
  const t = now();
  const sub = await ensureSub(tier, target, t);
  if (on) {
    if (sub.comped) return { changed: false };
    await runQuery("UPDATE premium_subs SET comped = 1, comp_by = ?, comp_note = ?, status = 'comped', updated = ? WHERE id = ?",
                   [String(by || "?").slice(0, 60), note ? String(note).slice(0, 200) : null, t, sub.id]);
    await runQuery(`INSERT OR IGNORE INTO premium_ledger (ref, sub_id, tier, target, kind, payer_name, amount, days, created)
                    VALUES (?, ?, ?, ?, 'comp', ?, 0, 0, ?)`, [`comp:${sub.id}:${t}`, sub.id, tier, target, String(by || "?").slice(0, 60), t]);
  } else {
    if (!sub.comped) return { changed: false };
    await runQuery("UPDATE premium_subs SET comped = 0, comp_by = NULL, comp_note = NULL, status = 'none', updated = ? WHERE id = ?", [t, sub.id]);
    await runQuery(`INSERT OR IGNORE INTO premium_ledger (ref, sub_id, tier, target, kind, payer_name, amount, days, created)
                    VALUES (?, ?, ?, ?, 'uncomp', ?, 0, 0, ?)`, [`uncomp:${sub.id}:${t}`, sub.id, tier, target, String(by || "?").slice(0, 60), t]);
  }
  await loadCache();
  await afterChange(tier, target);
  return { changed: true };
}
const AUTO = "auto:admin";
/** Site admins (users.class 'Admin'): their account gets a Season Pass, their pads Prime Time. Idempotent. */
async function compAdmins() {
  await init();
  const want = new Set();
  if (CONFIG.comp_admins) {
    const admins = await getQuery("SELECT userId FROM users WHERE class = 'Admin'");
    const rooms = require("./rooms");
    await rooms.init();
    const all = rooms.listCached();
    for (const a of admins) {
      want.add("season_pass:" + a.userId);
      for (const R of all) if (R.owner && R.owner.userId === a.userId) want.add("prime_time:" + R.id);
    }
  }
  let added = 0, removed = 0;
  for (const k of want) {
    const [tier, target] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
    const r = await setComp(tier, target, true, AUTO, "site admin");
    if (r.changed) added++;
  }
  for (const r of await getQuery("SELECT tier, target FROM premium_subs WHERE comped = 1 AND comp_by = ?", [AUTO])) {
    if (!want.has(r.tier + ":" + r.target)) { await setComp(r.tier, r.target, false, AUTO); removed++; }
  }
  return { added, removed, total: want.size };
}

// ── the daily job ──
const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
/** Charge every due renewal once; move expired subscriptions to lapsed (with a notice). */
async function renewDue(t = now()) {
  await init();
  const res = { renewed: 0, failed: 0, lapsed: 0 };
  const P = CONFIG.period_days;
  const subs = await getQuery("SELECT * FROM premium_subs WHERE comped = 0 AND renewer_id IS NOT NULL AND paid_through > 0 AND paid_through <= ?", [t]);
  for (const s of subs) {
    if (Number(s.stripe_through) > t) continue;                       // Stripe is paying this one
    if (t >= Number(s.paid_through) + CONFIG.grace_days * DAY) continue;   // past grace: the lapse below
    const T = TIERS[s.tier];
    if (!T) continue;
    const price = priceOf(T.id);
    const ref = `renew:${s.id}:${s.paid_through}`;
    let label = s.tier === "prime_time" ? `p/${s.target}` : "your Season Pass";
    let roomId = null, ownerSelf = true;
    if (T.kind === "pad") {
      const R = await require("./rooms").get(s.target);
      if (R) { label = `p/${R.slug || R.id}`; roomId = R.id; ownerSelf = !!(R.owner && R.owner.userId === s.renewer_id); }
    }
    try {
      const done = await tx(async () => {
        if ((await getQuery("SELECT 1 FROM premium_ledger WHERE ref = ?", [ref]))[0]) return "dup";
        const cur = (await getQuery("SELECT * FROM premium_subs WHERE id = ?", [s.id]))[0];
        if (!cur || cur.paid_through !== s.paid_through || cur.renewer_id !== s.renewer_id) return "moved";   // paid / changed meanwhile
        const u = (await getQuery("SELECT username FROM users WHERE userId = ?", [s.renewer_id]))[0];
        if (!u) return "nopay";
        const L = require("./ledger");
        const r = await L.post(s.renewer_id, -price, `${T.emoji} ${T.name} renewal: ${label}`.slice(0, 120), { requireCover: true, transactionId: txRef(ref), source: "premium" });
        if (!r.ok) return "nopay";
        const routing = await bookRoute(T.flow, price, { roomId, ownerSelf: T.kind === "pad" ? ownerSelf : true, payerId: s.renewer_id, label: `${T.name} ${label} renewal` });
        const to = Number(s.paid_through) + P * DAY;
        await runQuery(`INSERT INTO premium_ledger (ref, sub_id, tier, target, kind, payer_id, payer_name, amount, days, period_from, period_to, routing, via, created)
                        VALUES (?, ?, ?, ?, 'renew', ?, ?, ?, ?, ?, ?, ?, 'job', ?)`,
                       [ref, s.id, s.tier, s.target, s.renewer_id, u.username, price, P, s.paid_through, to, JSON.stringify(routing), t]);
        await runQuery("UPDATE premium_subs SET paid_through = ?, status = 'active', notified = NULL, updated = ? WHERE id = ?", [to, t, s.id]);
        return "ok";
      });
      if (done === "ok") { res.renewed++; if (roomId) telemetry(ref, roomId, "", ownerSelf, price, "web", t); }
      else if (done === "nopay") {
        res.failed++;
        const key = "grace:" + s.paid_through;
        if (s.notified !== key) {
          await runQuery("UPDATE premium_subs SET status = 'grace', notified = ?, updated = ? WHERE id = ?", [key, t, s.id]);
          await notify(s.renewer_id, T.kind === "pad" ? "room" : "cosmetics", `prem-grace-${s.id}-${s.paid_through}`,
            `${T.emoji} ${T.name} renewal for ${label} couldn't be paid`,
            `It costs ${fmt(price)} PAT. The perks stay on for ${CONFIG.grace_days} more day(s) - top up and the next daily run renews it, or anyone can chip in on /premium.`,
            "/premium");
        }
      }
    } catch (e) { console.error(`[premium] renew ${s.id}:`, e.message); }
  }
  // lapses: paid (or Stripe) time is over and the grace is used up
  for (const s of await getQuery("SELECT * FROM premium_subs WHERE comped = 0 AND (paid_through > 0 OR stripe_through > 0)")) {
    if (t < endsAt(s, t)) continue;
    const key = "lapsed:" + Math.max(Number(s.paid_through) || 0, Number(s.stripe_through) || 0);
    if (s.notified === key) continue;
    const T = TIERS[s.tier];
    await runQuery("UPDATE premium_subs SET status = 'lapsed', renewer_id = NULL, notified = ?, updated = ? WHERE id = ?", [key, t, s.id]);
    res.lapsed++;
    let who = T.kind === "user" ? s.target : null, label = "your Season Pass";
    if (T.kind === "pad") {
      const R = await require("./rooms").get(s.target);
      who = R && R.owner ? R.owner.userId : null; label = R ? `p/${R.slug || R.id}` : s.target;
    }
    if (who) {
      await notify(who, T.kind === "pad" ? "room" : "cosmetics", `prem-lapse-${s.id}-${key}`, `${T.emoji} ${T.name} ended for ${label}`,
        `The perks are off. Nothing is lost: equipped ${T.name} cosmetics come back the moment it's renewed.`, "/premium");
    }
    await audit(T.kind === "pad" ? s.target : null, "premium-lapse", "job", `${s.tier} ${s.target}`);
  }
  await loadCache();
  if (res.lapsed) await afterChange("lapse", null);
  return res;
}
/** Once per UTC day (premium_jobs row): comps, renewals, lapses. force = run again today. */
let ticking = null;
async function tick({ force = false, t = now() } = {}) {
  if (ticking) return ticking;
  ticking = (async () => {
    await init();
    const day = dayKey(t);
    if (!force) {
      const ins = await runQuery("INSERT OR IGNORE INTO premium_jobs (day, started) VALUES (?, ?)", [day, t]);
      if (!ins.changes) return { skipped: true, day };
    } else {
      await runQuery("INSERT INTO premium_jobs (day, started) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET started = excluded.started", [day, t]);
    }
    const comps = await compAdmins();
    const r = await renewDue(t);
    const result = { day, comps, ...r };
    await runQuery("UPDATE premium_jobs SET finished = ?, result = ? WHERE day = ?", [now(), JSON.stringify(result), day]);
    if (r.renewed || r.failed || r.lapsed || comps.added || comps.removed) console.log("[premium] daily:", JSON.stringify(result));
    return result;
  })().finally(() => { ticking = null; });
  return ticking;
}
function startJob() {
  // an hourly look; the job itself runs once per UTC day (and its every step is idempotent)
  const run = () => tick().catch((e) => console.error("[premium] daily job:", e.message));
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, 3600 * 1000).unref();
}

// ── reads for pages ──
function subView(tier, sub, t = now()) {
  const st = statusOf(sub, t);
  return { tier, status: st, active: st === "active" || st === "grace" || st === "comped", comped: !!(sub && sub.comped),
           paid_through: sub ? Math.max(Number(sub.paid_through) || 0, Number(sub.stripe_through) || 0) : 0,
           ends: sub && !sub.comped ? endsAt(sub, t) : null, renewing: !!(sub && (sub.renewer_id || sub.stripe_sub)),
           stripe: !!(sub && sub.stripe_sub) };
}
async function contributors(subId, limit = 8) {
  return getQuery(`SELECT payer_name AS name, SUM(amount) AS amount, MAX(created) AS last FROM premium_ledger
                   WHERE sub_id = ? AND amount > 0 AND payer_name IS NOT NULL GROUP BY payer_id ORDER BY amount DESC LIMIT ?`, [subId, limit]);
}
async function state(viewer, padSlug) {
  await init();
  const t = now();
  const signed = !!(viewer && viewer.userId);
  let balance = null, pass = null, renewerMe = false;
  if (signed) {
    const b = (await getQuery("SELECT points_balance FROM users WHERE userId = ?", [viewer.userId]))[0];
    balance = b ? b.points_balance : 0;
    const s = await subRow("season_pass", viewer.userId);
    pass = subView("season_pass", s, t);
    renewerMe = !!(s && s.renewer_id === viewer.userId);
    pass.renewer_me = renewerMe;
  }
  let pad = null;
  if (padSlug) {
    const R = await padTarget(padSlug);
    if (R) {
      const s = await subRow("prime_time", R.id);
      const owner = !!(signed && R.owner && R.owner.userId === viewer.userId);
      pad = { id: R.id, slug: R.slug || R.id, title: R.title, owner: R.owner ? (R.owner.display || R.owner.username) : null, mine: owner,
              ...subView("prime_time", s, t), renewer_me: !!(s && signed && s.renewer_id === viewer.userId),
              contributors: s ? (await contributors(s.id)).map((c) => ({ name: c.name, amount: c.amount })) : [] };
    }
  }
  const C = CONFIG;
  return {
    sales: C.sales, period_days: C.period_days, grace_days: C.grace_days,
    prices: { prime_time: C.prime_price, season_pass: C.season_price, sticker_pack: C.sticker_price },
    day_price: { prime_time: Math.ceil(C.prime_price / C.period_days) },
    perks: { prime_extra_slots: C.prime_extra_slots, prime_extra_badges: C.prime_extra_badges, sp_upload_mult: C.sp_upload_mult, sp_sticker_packs: C.sp_sticker_packs },
    routes: routesView(),
    stripe: (() => { try { return require("./stripebilling").publicState(); } catch (e) { return { enabled: false }; } })(),
    viewer: { signed, balance, pass, username: signed ? viewer.username : null },
    pad,
  };
}
const DEST_LABEL = { fortknox: "🪙 Fort Knox", reserve: "🏛️ Federal Reserve", room: "🏦 the pad's room vault" };
function routesView() {
  const out = {};
  for (const [flow, meta] of Object.entries(ROUTE_FLOWS)) {
    const shares = CONFIG.routes[flow];
    const used = shares.reduce((a, s) => a + Number(s[1]), 0);
    out[flow] = { label: meta.label, shares: shares.map(([d, p]) => ({ dest: d, pct: p, label: DEST_LABEL[d] })),
                  rest: Math.max(0, Math.round((100 - used) * 100) / 100) };
  }
  return out;
}

// ── routes ──
function errBody(e) {
  const ERR = require("./weberrors").ERRORS;
  if (e && e.refuse) {
    const code = e.code && ERR[e.code] ? e.code : "E_REFUSED";
    return { status: e.status || 400, body: { ok: false, error: e.message, code, hint: ERR[code][1] } };
  }
  const incident = crypto.randomBytes(4).toString("hex");
  console.error(`[premium] incident ${incident}:`, e);
  return { status: 500, body: { ok: false, error: "Something went wrong - nothing was charged.", code: "E_INTERNAL", hint: ERR.E_INTERNAL[1], incident } };
}
function register(app, { addUser }) {
  init().then(() => startJob()).catch((e) => console.error("[premium] init:", e.message));
  if (app.locals) {
    app.locals.isPrimeTime = isPrime;
    app.locals.hasSeasonPass = hasPass;
    app.locals.premiumPadPerks = padPerks;
  }
  const guard = require("./middleware/authGuard");
  const fail = (res, e) => { const x = errBody(e); res.status(x.status).json(x.body); };
  const write = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const ERR = require("./weberrors").ERRORS;
    if (!guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page.", code: "E_NO_PERMISSION", hint: ERR.E_NO_PERMISSION[1] });
    if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only.", code: "E_BAD_ARGS", hint: ERR.E_BAD_ARGS[1] });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first.", code: "E_NO_PERMISSION", hint: ERR.E_NO_PERMISSION[1] });
    next();
  };
  app.get("/premium", addUser, async (req, res) => {
    try {
      const S = await state(req.user, req.query.pad ? String(req.query.pad).slice(0, 80) : null);
      let stickers = null;
      try { stickers = await require("./stickers").pageData(req.user); } catch (e) { stickers = null; }
      res.render("premium", { S, stickers, user: req.user ? req.user.username : null, title: "Prime Time & Season Pass" });
    } catch (e) { console.error("[premium] page:", e); res.status(500).send("Something went wrong."); }
  });
  app.get("/api/premium/state", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, ...(await state(req.user, req.query.pad ? String(req.query.pad).slice(0, 80) : null)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/premium/buy", addUser, write, async (req, res) => {
    try {
      const b = req.body || {};
      const r = await buy(req.user, { tier: b.tier, pad: b.pad, user: b.user, months: b.months, amount: b.amount, ref: b.ref, renew: b.renew === true, via: "web" });
      res.json({ ok: true, ...r, state: await state(req.user, b.tier === "prime_time" ? b.pad : null) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/premium/renew", addUser, write, async (req, res) => {
    try {
      const b = req.body || {};
      const r = await setRenew(req.user, { tier: b.tier, pad: b.pad, on: b.on });
      res.json({ ok: true, ...r, state: await state(req.user, b.tier === "prime_time" ? b.pad : null) });
    } catch (e) { fail(res, e); }
  });
  const staffOnly = (req) => { if (!require("./rooms").isStaff(req.user)) throw new Refuse(403, "Admins only."); };
  async function adminView() {
    const subs = await getQuery("SELECT tier, target, comped, comp_by, paid_through, stripe_through, renewer_id IS NOT NULL AS renewing, status FROM premium_subs ORDER BY tier, target");
    const totals = await getQuery("SELECT tier, kind, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS amount FROM premium_ledger GROUP BY tier, kind");
    const jobs = await getQuery("SELECT day, started, finished, result FROM premium_jobs ORDER BY day DESC LIMIT 7");
    return { config: config(), defaults: DEFAULTS, routes: routesView(), subs: subs.map((s) => ({ ...s, status: statusOf(s) })), totals, jobs };
  }
  app.get("/api/premium/admin", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { staffOnly(req); await init(); res.json({ ok: true, ...(await adminView()) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/premium/admin", addUser, write, async (req, res) => {
    try {
      staffOnly(req);
      const b = req.body || {};
      if (b.comp) {
        const T = TIERS[String(b.comp.tier || "")];
        if (!T) throw new Refuse(400, "Unknown tier.");
        let target;
        if (T.kind === "pad") { const R = await padTarget(b.comp.pad); if (!R) throw new Refuse(404, "No such pad."); target = R.id; }
        else { const u = await userTarget(b.comp.user); if (!u) throw new Refuse(404, "No such account."); target = u.userId; }
        await setComp(T.id, target, b.comp.on !== false, req.user.username, b.comp.note);
      }
      if (b.config) await setConfig(b.config, req.user.username);
      if (b.run === true) await tick({ force: true });
      res.json({ ok: true, ...(await adminView()) });
    } catch (e) { fail(res, e); }
  });
}

module.exports = {
  init, register, buy, afterChange, setRenew, setComp, compAdmins, renewDue, tick, state, config, setConfig, loadCache,
  isPrime, hasPass, padPerks, userPerks, statusOf, endsAt, subSync, subRow, splitRoute, bookRoute, cleanRoutes, cleanConfig, priceOf, errBody,
  padTarget, userTarget, ensureSub, txRef, Refuse, TIERS, DEFAULTS, DAY, ROUTE_FLOWS, routesView,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
};
