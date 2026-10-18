// premium.js — PATV's two paid tiers (1.99iv): 📺 PRIME TIME (a PAD tier) and 🎟️ SEASON PASS (a personal tier),
// "akin to Discord's server boosts and Nitro". Paid in PAT (this file) or - later, switched off and hidden today -
// with real money through Stripe (stripebilling.js maps a Stripe subscription onto the same rows).
//
// TIERS (prices are settings, premium_config; the first prices are an experiment)
//   prime_time   a pad's tier          10,000,000 PAT / 30 days   target = the pad's room id
//   season_pass  one account's tier    2,000,000 PAT / 30 days   target = the user's id
//   prime_plus   a pad's tier         50,000,000 PAT / 30 days   target = the pad's room id (1.99qp: 💎 PRIME TIME PLUS)
//
// 1.99qp 💎 PRIME TIME PLUS = everything in Prime Time (isPrime() is true for a Plus pad) plus:
//   * the CAMFROG ROOM (1.99qy, the user's model): Prime Time Plus is what lets a pad be connected to a Camfrog room at all
//     and what makes Pepe JOIN that room and stay. Without it: no new Camfrog connect, no Pepe in the room, no live room
//     on the pad page. Pepe can be in at most 5 Camfrog rooms, so at most ptplus_max_rooms (5) pads have Plus at once
//     (comps included - Pepe's own room is a lifetime comp). The cap is checked inside the charge / comp transaction
//     (BEGIN IMMEDIATE, so two buyers can't both take the last spot); renewals and extensions of a pad that has Plus
//     always go through. Sold out -> a waitlist (premium_plus_waitlist): everyone on it gets a notice when a spot frees.
//     Enforcement (connect refused, Pepe leaving non-Plus pads' rooms, the live view hidden) runs while premium_config
//     plus_bridge_gate is on; the cap always applies to sales. House pads never gate. Pepe gets the list through his
//     owner sync (padconnect.plusRoomsForPepe) and joins / leaves himself (bot pepe_plusrooms.py, 5 rooms max).
//     When a Plus period is about to end (3 days before its end, grace included) the pad's owner is told Pepe leaves then.
//   * unlimited retention for the pad's chat logs AND recordings (Pepe's pepe_retention reads prime_plus per room from
//     /api/rooms/owners);
//   * a bigger room soundboard: padPerks().soundboardSlots = sb_slots_plus (Prime Time sb_slots_prime, none sb_slots_free);
//   * the 💎 Prime Time Plus sticker pack for the pad's owner (stickers.js perk), Plus pad cosmetics (padcosmetics.json
//     perk prime_plus), the automatic Plus badge, the owner's 💎 Plus flair and twice the flair slots (padflair.js).
//   UPGRADE from Prime Time: buying Plus for a pad with paid Prime Time time left converts that time - its remaining
//   days x (prime_price / plus_price) are added to the Plus period, Prime Time's paid date moves to now and its renewer
//   is dropped (no PAT moves; ledger rows kind 'upgrade-out' / 'upgrade-in'). Stripe-paid and comped Prime Time time
//   are left alone. Buying plain Prime Time for a pad that has Plus is refused (Plus includes it).
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
//   1.99ma: TIMED comps (comps.js, /admin/comps): comp_until = the date a comp ends (NULL = no end date). Free, no
//   routing, never auto-renewed; the daily job ends them (comp-end ledger row + a notice), and until then every gate
//   (hasPass / isPrime / userPerks / padPerks) sees an active tier. Paying during a timed comp starts after it.
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
//   banner       [fortknox 100]          - 1.99kk: homepage banner ads (banner.js): site-wide, no room resolved -> Fort Knox.
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
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

const DAY = 24 * 3600 * 1000;
const MAX_AHEAD_DAYS = 400;
const REF_RE = /^[A-Za-z0-9_-]{8,64}$/;
const TIERS = Object.freeze({
  prime_time: Object.freeze({ id: "prime_time", kind: "pad", name: "Prime Time", emoji: "📺", priceKey: "prime_price", flow: "prime_time" }),
  season_pass: Object.freeze({ id: "season_pass", kind: "user", name: "Season Pass", emoji: "🎟️", priceKey: "season_price", flow: "season_pass" }),
  prime_plus: Object.freeze({ id: "prime_plus", kind: "pad", name: "Prime Time Plus", emoji: "💎", priceKey: "plus_price", flow: "prime_plus" }),   // 1.99qp
});
const ROUTE_DESTS = Object.freeze(["fortknox", "reserve", "room"]);
const ROUTE_FLOWS = Object.freeze({
  prime_time: { label: "📺 Prime Time (pad tier)", room: true },
  season_pass: { label: "🎟️ Season Pass (personal tier)", room: false },
  prime_plus: { label: "💎 Prime Time Plus (pad tier)", room: true },        // 1.99qp: same split as Prime Time
  stickers: { label: "🧸 Sticker packs", room: false },
  banner: { label: "📣 Homepage banner ads", room: false },        // 1.99kk: banner.js (no room resolved -> Fort Knox)
  creators: { label: "⭐ PATV Creators - the 20% platform cut (at release)", room: true },   // 1.99pv: creators.js (room share minus the pad owner's royalty)
  quotes: { label: "💬 Chat quotes (after the quoted people's likeness cut)", room: true },         // 1.99qw: quotes.js
  soundboard_pack: { label: "🔊 Soundboard packs + the season board (after any voice owners' cut)", room: false },   // 1.99qw: soundboards.js
  soundboard_legend: { label: "🔊 Legendary soundboard clips (after any voice owner's cut)", room: false },          // 1.99qw
  voice_unlock: { label: "🗣️ Voice unlocks bought on the website (after the voice owner's cut)", room: false },     // 1.99qw: voicestore.js
});
const DEFAULTS = Object.freeze({
  sales: true,                     // PAT purchases on (off: buying is refused, renewals still run)
  prime_price: 10000000,           // PAT per period (experimental)
  season_price: 2000000,
  plus_price: 50000000,            // 1.99qp: 💎 Prime Time Plus
  plus_bridge_gate: false,         // 1.99qp/qy: Prime Time Plus decides Camfrog rooms (connect, Pepe in the room, the live view)
  ptplus_max_rooms: 5,             // 1.99qy: Plus pads at once, site-wide (Pepe can be in 5 Camfrog rooms)
  plus_gate_platforms: ["camfrog"],  // 1.99rd: connections that need Plus while the gate is on (camfrog | twitch | discord | irc)
  sb_slots_free: 0,                // 1.99qp: room soundboard slots per pad tier (the soundboard reads padPerks().soundboardSlots)
  sb_slots_prime: 8,
  sb_slots_plus: 24,
  period_days: 30,
  grace_days: 3,
  comp_admins: true,               // site admins' accounts + pads get both tiers free
  prime_extra_slots: 2,            // stage slots a Prime Time pad may add on top of the site cap
  prime_extra_badges: 2,           // pad badges on top of the normal 3
  sp_upload_mult: 2,               // Season Pass: feed upload size / daily / quota multiplier
  sp_sticker_packs: 1,             // Season Pass: free sticker packs per period
  sticker_price: 250000,           // PAT per sticker pack (stickers.js; a pack's own price wins)
  routes: { prime_time: [["fortknox", 50], ["room", 50]], prime_plus: [["fortknox", 50], ["room", 50]], season_pass: [["fortknox", 100]], stickers: [["fortknox", 100]], banner: [["fortknox", 100]],
            creators: [["fortknox", 50], ["room", 50]], quotes: [["fortknox", 50], ["room", 50]],
            soundboard_pack: [["fortknox", 100]], soundboard_legend: [["fortknox", 100]], voice_unlock: [["fortknox", 100]] },
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
    plus_price: int(c.plus_price, 1000, 1e12, DEFAULTS.plus_price),
    plus_bridge_gate: on(c.plus_bridge_gate, DEFAULTS.plus_bridge_gate),
    ptplus_max_rooms: int(c.ptplus_max_rooms, 0, 50, DEFAULTS.ptplus_max_rooms),
    plus_gate_platforms: Array.isArray(c.plus_gate_platforms)
      ? [...new Set(c.plus_gate_platforms.map(String).filter((x) => ["camfrog", "twitch", "discord", "irc"].includes(x)))]
      : DEFAULTS.plus_gate_platforms.slice(),
    sb_slots_free: int(c.sb_slots_free, 0, 200, DEFAULTS.sb_slots_free),
    sb_slots_prime: int(c.sb_slots_prime, 0, 200, DEFAULTS.sb_slots_prime),
    sb_slots_plus: int(c.sb_slots_plus, 0, 200, DEFAULTS.sb_slots_plus),
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
      try { await runQuery("ALTER TABLE premium_subs ADD COLUMN comp_until INTEGER"); }      // 1.99ma: timed comps
      catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
      await runQuery(`CREATE TABLE IF NOT EXISTS premium_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT NOT NULL, sub_id INTEGER NOT NULL, tier TEXT NOT NULL, target TEXT NOT NULL,
        kind TEXT NOT NULL, payer_id TEXT, payer_name TEXT, amount INTEGER NOT NULL DEFAULT 0, days REAL NOT NULL DEFAULT 0,
        period_from INTEGER, period_to INTEGER, routing TEXT, via TEXT, created INTEGER NOT NULL)`);
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS premium_ledger_ref ON premium_ledger (ref)");
      try { await runQuery("ALTER TABLE premium_ledger ADD COLUMN anon INTEGER NOT NULL DEFAULT 0"); }   // 1.99mt: 🕶 anonymous gift / chip-in
      catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
      await runQuery("CREATE INDEX IF NOT EXISTS premium_ledger_sub ON premium_ledger (sub_id, created)");
      await runQuery("CREATE TABLE IF NOT EXISTS premium_jobs (day TEXT PRIMARY KEY, started INTEGER NOT NULL, finished INTEGER, result TEXT)");
      // 1.99qy: the Plus waitlist (sold out -> notify me) + the "Pepe leaves on <date>" notice marker
      await runQuery("CREATE TABLE IF NOT EXISTS premium_plus_waitlist (user_id TEXT PRIMARY KEY, created INTEGER NOT NULL)");
      try { await runQuery("ALTER TABLE premium_subs ADD COLUMN leave_noticed INTEGER"); }
      catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
      // 1.99th: a Plus spot held for an open card checkout (stripebilling.js) - counted by the cap until it expires
      await runQuery(`CREATE TABLE IF NOT EXISTS premium_plus_holds (id TEXT PRIMARY KEY, target TEXT NOT NULL, user_id TEXT, session TEXT,
        created INTEGER NOT NULL, expires INTEGER NOT NULL)`);
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
  if (c.pepe_retention) RETENTION = cleanRetention(c.pepe_retention);
  return CONFIG;
}

// ── 1.99tc: Pepe's retention windows (camfrog-bot pepe_retention.py is what enforces them) ──
// Pepe reports his live windows with every owner sync (POST /api/rooms/owners `retention`); the perk lists
// (premiumperks.js) read them from here so /premium never promises a window Pepe doesn't keep. null = no time limit.
// Until the first report: his defaults (the user's numbers, 2026-10-11).
const RETENTION_DEFAULTS = Object.freeze({ chat_days: 30, chat_prime: null, rec_days: 30, rec_prime: 365, pm_days: 30, pm_pass: null,
                                           chat_plus: null, rec_plus: null });
function cleanRetention(raw) {
  const out = { ...RETENTION_DEFAULTS };
  if (!raw || typeof raw !== "object") return out;
  for (const k of Object.keys(RETENTION_DEFAULTS)) {
    if (!(k in raw)) continue;
    const v = raw[k];
    if (v === null) out[k] = null;
    else if (Number.isInteger(v) && v >= 1 && v <= 36500) out[k] = v;
  }
  return out;
}
let RETENTION = { ...RETENTION_DEFAULTS };
const retention = () => ({ ...RETENTION });
/** Pepe's report -> RETENTION (stored only when it changed). */
async function noteRetention(raw) {
  if (!raw || typeof raw !== "object") return false;
  const next = cleanRetention(raw);
  if (JSON.stringify(next) === JSON.stringify(RETENTION)) return false;
  RETENTION = next;
  try {
    await init();
    await runQuery("INSERT INTO premium_config (key, value) VALUES ('pepe_retention', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(next)]);
  } catch (e) { console.error("[premium] retention:", e.message); }
  return true;
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
let HOLDS = [];                  // 1.99th: [{target, expires}] Plus spots held for open card checkouts
let cacheAt = 0;
async function loadCache() {
  const m = new Map();
  for (const r of await getQuery("SELECT * FROM premium_subs")) m.set(r.tier + ":" + r.target, r);
  HOLDS = await getQuery("SELECT target, expires FROM premium_plus_holds").catch(() => []);
  CACHE = m; cacheAt = now();
}
function maybeRefresh() {
  // 1.99qp: the config too, so a change from the shell (tools/ptplus-comps.js --gate on) reaches the site within a minute
  if (ready && now() - cacheAt > 60000) { cacheAt = now(); loadCache().then(loadConfig).catch((e) => console.error("[premium] cache:", e.message)); }
}
/** The date a subscription's perks end (Infinity = comped), grace included while a renewal is still possible. */
const compUntil = (sub) => (sub && sub.comped ? Number(sub.comp_until) || 0 : 0);    // 1.99ma: 0 = no end date
function endsAt(sub, t = now()) {
  if (!sub) return 0;
  if (sub.comped && !compUntil(sub)) return Infinity;
  const paid = Math.max(Number(sub.paid_through) || 0, Number(sub.stripe_through) || 0);
  const renewing = !!(sub.renewer_id || sub.stripe_sub);
  const base = renewing ? paid + CONFIG.grace_days * DAY : paid;
  return sub.comped ? Math.max(compUntil(sub), base) : base;
}
// ── 1.99tk: card subscriptions start where the time already paid (PAT) or comped ends ──
// Stripe's trial_end must be at least 48 hours ahead: shorter cover pushes the first charge to now + CARD_MIN_DEFER_MS
// (up to two days free - never a charge for time already paid).
const CARD_MIN_DEFER_MS = 49 * 3600 * 1000;
/** The end of the time a subscription row already has WITHOUT the card: PAT paid_through, or a timed comp (Infinity for a
 *  comp with no end). 0 = nothing ahead. */
function coveredUntil(sub, t = now()) {
  if (!sub) return 0;
  if (sub.comped && !compUntil(sub)) return Infinity;
  const c = Math.max(Number(sub.paid_through) || 0, compUntil(sub));
  return c > t ? c : 0;
}
/** When a card subscription opened now would first charge: null = straight away; else {covered, first} (ms). */
function cardStart(covered, t = now()) {
  if (!(covered > t) || covered === Infinity) return null;
  return { covered, first: Math.max(covered, t + CARD_MIN_DEFER_MS) };
}
/** 'comped' | 'active' | 'grace' | 'lapsed' | 'none' */
function statusOf(sub, t = now()) {
  if (!sub) return "none";
  if (sub.comped && (!compUntil(sub) || t < compUntil(sub))) return "comped";
  const paid = Math.max(Number(sub.paid_through) || 0, Number(sub.stripe_through) || 0);
  if (t < paid) return "active";
  if (t < endsAt(sub, t)) return "grace";
  return paid > 0 ? "lapsed" : "none";
}
function subSync(tier, target) { maybeRefresh(); return CACHE.get(tier + ":" + String(target || "")) || null; }
const activeSync = (tier, target, t = now()) => { const s = subSync(tier, target); return !!s && t < endsAt(s, t); };
/** 1.99qp: does this pad have 💎 Prime Time Plus right now? (sync, cached) */
const isPrimePlus = (roomId, t) => activeSync("prime_plus", roomId, t);
/** pad.primeTime: does this pad have Prime Time right now? (sync, cached) - 1.99qp: Prime Time Plus includes it */
const isPrime = (roomId, t) => activeSync("prime_time", roomId, t) || isPrimePlus(roomId, t);
/** 1.99qp: the pad's tier right now: "prime_plus" | "prime_time" | null */
const padTier = (roomId, t) => (isPrimePlus(roomId, t) ? "prime_plus" : activeSync("prime_time", roomId, t) ? "prime_time" : null);
/** 1.99qp: does this account own a pad with Prime Time Plus right now? (the Plus sticker pack) */
function plusOwner(userId, t = now()) {
  if (!userId) return false;
  maybeRefresh();
  let rooms;
  try { rooms = require("./rooms").listCached(); } catch (e) { return false; }
  for (const R of rooms || []) if (R.owner && R.owner.userId === userId && isPrimePlus(R.id, t)) return true;
  return false;
}
// ── 1.99qy: the Plus cap ──
/** Plus pads right now from the cache (pages): {used, max, left, soldOut, held}. 1.99th: spots held for an open card
 *  checkout count too (held), except one held for `forTarget` (the viewer's own pad). */
function plusSpots(t = now(), forTarget = null) {
  maybeRefresh();
  let used = 0;
  const on = new Set();
  for (const [k, s] of CACHE) if (k.startsWith("prime_plus:") && t < endsAt(s, t)) { used++; on.add(String(s.target)); }
  const heldT = new Set();
  for (const h of HOLDS) if (Number(h.expires) > t && !on.has(String(h.target)) && String(h.target) !== String(forTarget || "")) heldT.add(String(h.target));
  const max = CONFIG.ptplus_max_rooms;
  const taken = used + heldT.size;
  return { used, held: heldT.size, max, left: Math.max(0, max - taken), soldOut: taken >= max };
}
/** 1.99th: Plus pads paying / comped right now, `target` left out (inside a transaction: the database, not the cache). */
async function plusUsed(target, t = now()) {
  const on = new Set();
  for (const s of await getQuery("SELECT * FROM premium_subs WHERE tier = 'prime_plus' AND target <> ?", [String(target || "")])) if (t < endsAt(s, t)) on.add(String(s.target));
  return on;
}
/** Inside the caller's transaction: refuse NEW Plus time on `target` when every spot is taken (its own Plus renews). */
async function plusCapCheck(target, t = now()) {
  const mine = await subRow("prime_plus", target);
  if (mine && t < endsAt(mine, t)) return;                          // already a Plus pad: extending never needs a spot
  const on = await plusUsed(target, t);
  // 1.99th: + the spots held for other pads' open card checkouts (stripebilling.js), so two buyers can't both take the last one
  const held = new Set();
  for (const h of await getQuery("SELECT target FROM premium_plus_holds WHERE expires > ? AND target <> ?", [t, String(target)])) if (!on.has(String(h.target))) held.add(String(h.target));
  if (on.size + held.size >= CONFIG.ptplus_max_rooms) {
    const e = new Refuse(409, `💎 Prime Time Plus is sold out - all ${CONFIG.ptplus_max_rooms} spots are taken (Pepe can only be in ${CONFIG.ptplus_max_rooms} Camfrog rooms). Join the waitlist on /premium and we'll tell you when one frees up.`);
    e.soldOut = true;
    throw e;
  }
}
/** 1.99qy: the Plus waitlist - on: join, off: leave. -> {on} */
async function plusWaitlist(user, on) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  if (on) await runQuery("INSERT OR IGNORE INTO premium_plus_waitlist (user_id, created) VALUES (?, ?)", [user.userId, now()]);
  else await runQuery("DELETE FROM premium_plus_waitlist WHERE user_id = ?", [user.userId]);
  return { on: !!on };
}
/** A spot is free: tell everyone on the waitlist (once - the list empties). -> how many were told */
async function plusWaitlistNotify(t = now()) {
  await init();
  await loadCache();
  if (plusSpots(t).soldOut) return 0;
  const rows = await getQuery("SELECT user_id FROM premium_plus_waitlist");
  for (const r of rows) {
    const tr = tFor(r.user_id);
    await notify(r.user_id, "room", `plus-spot-${r.user_id}-${dayKey(t)}`, tr("premium.pp.notice.spot_title"), tr("premium.pp.notice.spot_body"), "/premium#plus");
  }
  if (rows.length) await runQuery("DELETE FROM premium_plus_waitlist");
  return rows.length;
}
/** 3 days before a Plus pad's time runs out (grace included): tell its owner Pepe leaves the room then. Once per end date. */
async function plusLeaveNotices(t = now()) {
  await init();
  let n = 0;
  for (const s of await getQuery("SELECT * FROM premium_subs WHERE tier = 'prime_plus'")) {
    const end = endsAt(s, t);
    if (!(end > t) || end === Infinity || end - t > 3 * DAY || Number(s.leave_noticed) === end) continue;
    await runQuery("UPDATE premium_subs SET leave_noticed = ? WHERE id = ?", [end, s.id]);
    const R = await require("./rooms").get(s.target);
    const who = R && R.owner ? R.owner.userId : null;
    if (!who) continue;
    const tr = tFor(who);
    await notify(who, "room", `plus-leave-${s.id}-${end}`, tr("premium.pp.notice.leave_title", { pad: `p/${R.slug || R.id}` }),
      tr("premium.pp.notice.leave_body", { date: new Date(end).toISOString().slice(0, 10) }), `/premium?pad=${encodeURIComponent(R.slug || R.id)}#plus`);
    n++;
  }
  return n;
}

/** 1.99qp: may this pad show its Camfrog room live on the site? Always while the gate is off; house pads always. */
function bridgeAllowed(roomId, t) {
  if (!CONFIG.plus_bridge_gate) return true;
  try { const R = require("./rooms").getCached(roomId); if (R && R.house) return true; } catch (e) { /* no registry: decide by the tier */ }
  return isPrimePlus(roomId, t);
}
/** Does this account have a Season Pass right now? (sync, cached) */
const hasPass = (userId, t) => activeSync("season_pass", userId, t);
/** 1.99nw: the Camfrog logins (lowercase) of every account with a Season Pass right now - Pepe keeps their PM logs
 *  without a time limit (his chat-log retention, camfrog-bot pepe_retention.py). */
async function passCamfrogs(t = now()) {
  maybeRefresh();
  const ids = [];
  for (const [k, s] of CACHE) if (k.startsWith("season_pass:") && t < endsAt(s, t)) ids.push(String(s.target));
  if (!ids.length) return [];
  const out = new Set();
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    const rows = await getQuery(`SELECT camfrogUsername FROM users WHERE userId IN (${part.map(() => "?").join(",")})`, part);
    for (const r of rows) if (r.camfrogUsername) out.add(String(r.camfrogUsername).toLowerCase());
  }
  return [...out].sort();
}
/** The perks a pad / an account gets right now (other modules ask this, never the tables). */
function padPerks(roomId) {
  const on = isPrime(roomId), plus = isPrimePlus(roomId);
  return { primeTime: on, primePlus: plus, tier: plus ? "prime_plus" : on ? "prime_time" : null,
           extraSlots: on ? CONFIG.prime_extra_slots : 0, extraBadges: on ? CONFIG.prime_extra_badges : 0, lowLatency: on,
           // 1.99qp: 💎 Plus - the Camfrog bridge, unlimited chat-log / recording retention, the bigger soundboard
           bridge: bridgeAllowed(roomId), retention: plus ? "unlimited" : on ? "prime" : "standard",
           soundboardSlots: plus ? CONFIG.sb_slots_plus : on ? CONFIG.sb_slots_prime : CONFIG.sb_slots_free };
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
// 1.99od: what someone TYPED for a pad. Accepts the slug, p/slug, /p/slug, a full link (…/p/slug, …/premium?pad=x),
// the Camfrog room id (any case) and the pad's title (case / underscore / punctuation-insensitive: "players lounge",
// "Players__lounge" and "players-lounge" are one key). A miss comes back with a short "did you mean" list. Before this
// an unknown pad on /premium just re-rendered the empty form (the admin's "nothing happens").
const padKey = (s) => String(s || "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const padCompact = (s) => padKey(s).replace(/-/g, "");
function padInput(raw) {
  let s = String(raw == null ? "" : raw).trim().slice(0, 300);
  if (!s) return "";
  // a link: https://publicaccess.tv/p/x, publicaccess.tv/p/x, /p/x/stage, /premium?pad=x
  const looksUrl = /^https?:\/\//i.test(s) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(s) || /^\/[^/]/.test(s) || /[?&](pad|room)=/i.test(s);
  if (looksUrl) {
    try {
      const u = new URL(/^https?:\/\//i.test(s) || s.startsWith("/") ? s : "https://" + s, "https://publicaccess.tv");
      const q = u.searchParams.get("pad") || u.searchParams.get("room");
      if (q) s = q;
      else {
        const seg = u.pathname.split("/").filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch (e) { return x; } });
        const i = seg.findIndex((x) => x.toLowerCase() === "p");
        s = i >= 0 && seg[i + 1] ? seg[i + 1] : (seg[seg.length - 1] || "");
      }
    } catch (e) { /* not a link after all */ }
  }
  return s.trim().replace(/^p\//i, "").replace(/^[@#]/, "").trim().slice(0, 120);
}
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
/** How close `q` is to a pad (0 = same, 1 = nothing alike), over its slug, title and room id. */
function padScore(q, R) {
  const c = padCompact(q);
  if (!c) return 1;
  let best = 1;
  for (const f of [R.slug, R.title, R.id]) {
    const x = padCompact(f);
    if (!x) continue;
    let s = editDistance(c, x) / Math.max(c.length, x.length);
    if (c.length >= 3 && x.length >= 3 && (x.includes(c) || c.includes(x))) s = Math.min(s, 0.25);
    best = Math.min(best, s);
  }
  return best;
}
const padBrief = (R) => ({ id: R.id, slug: R.slug || R.id, title: R.title || R.slug || R.id });
function padSuggest(q, list, n = 5) {
  return list.map((R) => ({ R, s: padScore(q, R) })).filter((x) => x.s <= 0.45)
    .sort((a, b) => a.s - b.s || String(a.R.title).localeCompare(String(b.R.title))).slice(0, n).map(({ R }) => padBrief(R));
}
/**
 * The pad someone typed -> { pad, query, suggestions }. viewer: undefined = internal (no filter); a user or null
 * (signed out): title / fuzzy matches and suggestions only ever name pads they may see (padaccess.canSee).
 */
async function padLookup(raw, viewer) {
  const rooms = require("./rooms");
  await rooms.init();
  const q = padInput(raw);
  if (!q) return { pad: null, query: "", suggestions: [] };
  const ok = (R) => (R && !R.profile ? R : null);
  let R = ok(await rooms.bySlug(q.toLowerCase())) || ok(await rooms.get(q));
  if (!R) { try { R = ok(await require("./roomsweb").resolveRoom(q)); } catch (e) { R = null; } }
  if (R) return { pad: R, query: q, suggestions: [] };
  let all = await rooms.list();
  if (viewer !== undefined) {
    try { const A = require("./padaccess"); await A.init(); all = A.visibleRows(viewer, all); } catch (e) { /* no access module: list as is */ }
  }
  const lo = q.toLowerCase(), k = padKey(q), c = padCompact(q);
  let hits = all.filter((p) => String(p.id).toLowerCase() === lo);
  if (!hits.length && c.length >= 2) hits = all.filter((p) => padKey(p.title) === k || padCompact(p.title) === c || padCompact(p.id) === c || padCompact(p.slug) === c);
  if (hits.length === 1) return { pad: hits[0], query: q, suggestions: [] };
  return { pad: null, query: q, suggestions: hits.length > 1 ? hits.slice(0, 5).map(padBrief) : padSuggest(q, all) };
}
/** The plain-text "No pad called x. Did you mean …?" line (API errors; the page builds its own from en.json). */
function padMissText(L) {
  const name = (x) => (x.title && padKey(x.title) !== padKey(x.slug) ? `${x.title} (p/${x.slug})` : `p/${x.slug}`);
  if (!L.query) return "Which pad? Type its address (p/name), its link, its Camfrog room name or its title.";
  const s = L.suggestions || [];
  return `No pad called ${L.query}.` + (s.length ? ` Did you mean ${s.slice(0, 3).map(name).join(", ")}?`
    : " Try its address (p/name), its link, its Camfrog room name or its title.");
}
/** padLookup, or a Refuse (404; 400 when empty) carrying {pad_query, suggestions} - errBody passes them on. */
async function padOrRefuse(raw, viewer) {
  const L = await padLookup(raw, viewer);
  if (L.pad) return L.pad;
  const e = new Refuse(L.query ? 404 : 400, padMissText(L));
  e.pad_query = L.query;
  e.suggestions = L.suggestions;
  throw e;
}
async function padTarget(slugOrId) {
  return (await padLookup(slugOrId)).pad;
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
 * renew (true: become the renewer), via, anon (1.99mt: a gift / chip-in for someone else, sent anonymously - the
 * recipient's notice and the pad's backers list say "Someone"; the ledger + gift log keep the payer for admins)}.
 * Idempotent per (user, ref).
 * -> {dup, tier, target, amount, days, paid_through, routing, gift}
 */
async function buy(user, opts = {}) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const T = TIERS[String(opts.tier || "")];
  if (!T) throw new Refuse(400, "Pick Prime Time, Prime Time Plus or Season Pass.");
  if (!CONFIG.sales) throw new Refuse(423, `${T.name} isn't on sale right now.`);
  const rawRef = String(opts.ref || "");
  if (!REF_RE.test(rawRef)) throw new Refuse(400, "Bad request (ref).");
  const ref = `prem:${user.userId}:${rawRef}`;
  const price = priceOf(T.id);
  const P = CONFIG.period_days;
  // what's being paid for
  let target, label, ownerSelf = false, roomId = null, recipient = null, R = null;
  if (T.kind === "pad") {
    R = await padOrRefuse(opts.pad, user);
    target = R.id; roomId = R.id; label = `p/${R.slug || R.id}`;
    ownerSelf = !!(R.owner && R.owner.userId === user.userId);
    if (R.owner && R.owner.userId) recipient = R.owner.userId;
    // 1.99qp: Plus includes Prime Time - paying for both would be wasted PAT
    if (T.id === "prime_time" && isPrimePlus(R.id)) throw new Refuse(409, `${label} has 💎 Prime Time Plus, which includes Prime Time - extend that instead.`);
  } else {
    const who = opts.user ? await userTarget(opts.user) : { userId: user.userId, username: user.username };
    if (!who) throw new Refuse(404, "No such account.");
    target = who.userId; label = `u/${who.username}`; ownerSelf = who.userId === user.userId;
    if (!ownerSelf) recipient = who.userId;
    if (!ownerSelf) await require("./gifts").guard(user, who);    // 1.99ma: blocks + the gift rate limit, before any charge
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
    if (T.id === "prime_plus") await plusCapCheck(target, t);          // 1.99qy: the 5-room cap, race-safe (BEGIN IMMEDIATE)
    const sub = await ensureSub(T.id, target, t);
    if (sub.comped && !compUntil(sub)) throw new Refuse(409, `${label} already has ${T.name} for free.`);
    // 1.99tk: a card subscription pays for this - PAT on top would pay for the same days twice. Cancelling the card
    // (Manage card subscription) keeps its paid time; PAT then adds time after it.
    if (sub.stripe_sub) throw new Refuse(409, `${label}'s ${T.name} is paid by card - nothing to add in PAT while that runs. To switch to PAT, cancel the card subscription (Manage card subscription on /premium): its paid time stays, then PAT time adds on after it.`);
    if (T.id === "prime_plus") {
      const ptc = await subRow("prime_time", target);
      if (ptc && ptc.stripe_sub) throw new Refuse(409, `${label} pays for Prime Time by card - upgrade that card subscription to Plus on /premium, or cancel it first.`);
    }
    // 1.99qp: Prime Time -> Plus upgrade: the pad's paid Prime Time time left becomes Plus time (price-weighted)
    const up = T.id === "prime_plus" ? await upgradeCredit(target, t) : null;
    const from = Math.max(t, Number(sub.paid_through) || 0, Number(sub.stripe_through) || 0, compUntil(sub));
    const to = Math.round(from + days * DAY + (up ? up.plusMs : 0));
    if (to - t > MAX_AHEAD_DAYS * DAY) throw new Refuse(409, `${label} is paid up far enough ahead already (at most ${MAX_AHEAD_DAYS} days).`);
    const u = (await getQuery("SELECT username FROM users WHERE userId = ?", [user.userId]))[0];
    if (!u) throw new Refuse(404, "Couldn't find your account.");
    const kind = opts.amount != null && opts.months == null ? "contribute" : ownerSelf ? "buy" : "gift";
    const anon = !ownerSelf && require("./gifts").anonFlag(opts.anon);
    const L = require("./ledger");
    const res = await L.post(user.userId, -amount, `${T.emoji} ${T.name} ${kind === "contribute" ? "contribution" : kind}: ${label}`.slice(0, 120),
                             { requireCover: true, transactionId: txRef(ref), source: "premium" });
    if (!res.ok) throw new Refuse(402, `That's ${fmt(amount)} PAT - you don't have enough.`);
    const routing = await bookRoute(T.flow, amount, { roomId, ownerSelf: T.kind === "pad" ? ownerSelf : true, payerId: user.userId, label: `${T.name} ${label}` });
    await runQuery(`INSERT INTO premium_ledger (ref, sub_id, tier, target, kind, payer_id, payer_name, amount, days, period_from, period_to, routing, via, created, anon)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                   [ref, sub.id, T.id, target, kind, user.userId, u.username, amount, days, from, to, JSON.stringify(routing), via, t, anon ? 1 : 0]);
    const renewer = opts.renew === true && (!sub.renewer_id || sub.renewer_id === user.userId || ownerSelf) && (T.kind === "pad" || ownerSelf)
      ? user.userId : sub.renewer_id;
    await runQuery("UPDATE premium_subs SET paid_through = ?, renewer_id = ?, status = 'active', notified = NULL, updated = ? WHERE id = ?",
                   [to, renewer || null, t, sub.id]);
    if (up) {
      await runQuery("UPDATE premium_subs SET paid_through = ?, renewer_id = NULL, status = 'lapsed', notified = ?, updated = ? WHERE id = ?",
                     [t, "lapsed:" + t, t, up.sub.id]);     // notified = the lapse key: no "Prime Time ended" notice for an upgrade
      const d = Math.round(up.leftMs / DAY * 100) / 100, dPlus = Math.round(up.plusMs / DAY * 100) / 100;
      await runQuery(`INSERT INTO premium_ledger (ref, sub_id, tier, target, kind, payer_id, payer_name, amount, days, period_from, period_to, via, created)
                      VALUES (?, ?, 'prime_time', ?, 'upgrade-out', ?, ?, 0, ?, ?, ?, ?, ?)`, [ref + ":up-out", up.sub.id, target, user.userId, u.username, -d, t, up.sub.paid_through, via, t]);
      await runQuery(`INSERT INTO premium_ledger (ref, sub_id, tier, target, kind, payer_id, payer_name, amount, days, period_from, period_to, via, created)
                      VALUES (?, ?, 'prime_plus', ?, 'upgrade-in', ?, ?, 0, ?, ?, ?, ?, ?)`, [ref + ":up-in", sub.id, target, user.userId, u.username, dPlus, t, to, via, t]);
    }
    return { dup: false, username: u.username, kind, routing, to, from, subId: sub.id, anon, upgrade: up ? { pt_days: up.leftMs / DAY, plus_days: up.plusMs / DAY } : null };
  });
  await loadCache();
  if (!out.dup) await afterChange(T.id, target);
  if (out.dup) {
    const r = out.row;
    return { dup: true, tier: T.id, target, amount: r.amount, days: r.days, paid_through: r.period_to, routing: JSON.parse(r.routing || "[]"), gift: r.kind === "gift" };
  }
  // 1.99mt: the pad's event log is read by its owner/mods - an anonymous payer stays anonymous there (premium_ledger keeps them)
  await audit(roomId, "premium-" + out.kind, out.anon ? "anonymous" : out.username, `${T.id} ${label} ${amount} PAT ${days.toFixed(2)}d -> ${new Date(out.to).toISOString().slice(0, 10)}`);
  if (roomId) telemetry(ref, roomId, out.anon ? "" : out.username, ownerSelf, amount, via, t);
  // 1.99mt: every gift goes in the gift log (gifts.js: the admins' audit + the 🎁 achievements), anonymous or not
  if (out.kind === "gift") {
    await require("./gifts").record({ kind: T.id, giverId: user.userId, recipientId: recipient && recipient !== user.userId ? recipient : null,
                                      target: T.kind === "pad" ? target : null, item: `${T.emoji} ${T.name}`, ref: `prem:${ref}`, anon: out.anon });
  }
  if (recipient && recipient !== user.userId && T.kind === "user") {
    // 1.99ma: the shared 🎁 gift notice (gifts.js), in the recipient's language; 1.99mt: from = null when anonymous
    const G = require("./gifts");
    const tr = G.tFor(recipient);
    await G.notifyGift(recipient, { item: `${T.emoji} ${T.name}`, from: out.anon ? null : out.username, link: "/premium", ref: `prem-${out.subId}-${ref}`,
      extra: tr("gifts.notice.premium_until", { date: new Date(out.to).toISOString().slice(0, 10) }) });
  } else if (recipient && recipient !== user.userId) {
    const who = out.anon ? require("./gifts").tFor(recipient)("gifts.anon.someone") : out.username;
    await notify(recipient, T.kind === "pad" ? "room" : "cosmetics", `prem-${out.subId}-${ref}`,
      `${T.emoji} ${who} ${out.kind === "contribute" ? "chipped in" : "paid"} for ${T.name} on ${label}`,
      `${who} added ${days >= 1 ? Math.floor(days) + " day" + (Math.floor(days) === 1 ? "" : "s") : "time"} of ${T.name} - paid through ${new Date(out.to).toISOString().slice(0, 10)}.`,
      T.kind === "pad" && R ? `/premium?pad=${encodeURIComponent(R.slug || R.id)}` : "/premium");
  }
  if (out.upgrade) await audit(roomId, "premium-upgrade", out.anon ? "anonymous" : out.username, `prime_time ${out.upgrade.pt_days.toFixed(2)}d -> prime_plus ${out.upgrade.plus_days.toFixed(2)}d`);
  return { dup: false, tier: T.id, target, amount, days, paid_through: out.to, routing: out.routing, gift: out.kind === "gift", kind: out.kind, upgrade: out.upgrade || null };
}
/** 1.99qp: the Prime Time -> Plus conversion for a pad (inside buy's transaction): paid PAT time left only (not Stripe,
 *  not a comp). -> {sub, leftMs, plusMs} | null */
async function upgradeCredit(roomId, t = now()) {
  const pt = await subRow("prime_time", roomId);
  if (!pt) return null;
  const paid = Number(pt.paid_through) || 0;
  if (!(paid > t) || Number(pt.stripe_through) > t) return null;     // nothing left, or Stripe pays for it (cancel that first)
  const leftMs = paid - t;
  const plusMs = Math.floor(leftMs * CONFIG.prime_price / CONFIG.plus_price);
  return plusMs > 0 ? { sub: pt, leftMs, plusMs } : null;
}
/** 1.99tk: how long a pad's 💎 Plus is already covered without a card: its own PAT / comp time, or (none of that) its
 *  paid PAT Prime Time converted at the upgrade rate (upgradeCredit; the card checkout ends that Prime Time when it's paid). */
async function plusCardCover(roomId, t = now()) {
  const own = coveredUntil(await subRow("prime_plus", roomId), t);
  if (own) return own;
  const up = await upgradeCredit(roomId, t);
  return up ? t + up.plusMs : 0;
}
/** 1.99qp: what an upgrade would convert right now (the page's preview). -> {pt_days, plus_days} | null */
async function upgradePreview(roomId, t = now()) {
  const u = await upgradeCredit(roomId, t);
  return u ? { pt_days: Math.round(u.leftMs / DAY * 10) / 10, plus_days: Math.round(u.plusMs / DAY * 10) / 10 } : null;
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
  if (!T) throw new Refuse(400, "Pick Prime Time, Prime Time Plus or Season Pass.");
  let target, owner = false, manage = false;
  if (T.kind === "pad") {
    const R = await padOrRefuse(opts.pad, user);
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
/**
 * Comp (on) or un-comp a tier for a target. by = who; auto = the admin auto-comp.
 * 1.99ma opts.until: a TIMED comp ending then (ms); omitted = no end date. A timed comp on a target with a timed comp
 * moves its end (extend); a no-end comp over a timed one makes it no-end (opts.replace, the admin's explicit choice); a
 * timed comp over a no-end one is refused (revoke it first). -> {changed, until}
 */
async function setComp(tier, target, on, by, note, opts = {}) {
  await init();
  if (!TIERS[tier]) throw new Refuse(400, "Unknown tier.");
  const t = now();
  const sub = await ensureSub(tier, target, t);
  const until = opts.until ? Math.round(Number(opts.until)) : 0;
  if (on && tier === "prime_plus") await tx(() => plusCapCheck(target, t));     // 1.99qy: comps take a spot too
  if (on) {
    if (until && !(until > t)) throw new Refuse(400, "A comp has to end in the future.");
    if (sub.comped && !compUntil(sub)) {
      if (until) throw new Refuse(409, `That already has ${TIERS[tier].name} comped with no end date - revoke it first to make it timed.`);
      return { changed: false, until: null };
    }
    const days = until ? Math.round((until - Math.max(t, compUntil(sub))) / DAY * 100) / 100 : 0;
    await runQuery("UPDATE premium_subs SET comped = 1, comp_by = ?, comp_note = ?, comp_until = ?, status = 'comped', notified = NULL, updated = ? WHERE id = ?",
                   [String(by || "?").slice(0, 60), note ? String(note).slice(0, 200) : null, until || null, t, sub.id]);
    await runQuery(`INSERT OR IGNORE INTO premium_ledger (ref, sub_id, tier, target, kind, payer_name, amount, days, period_from, period_to, created)
                    VALUES (?, ?, ?, ?, 'comp', ?, 0, ?, ?, ?, ?)`,
                   [`comp:${sub.id}:${t}`, sub.id, tier, target, String(by || "?").slice(0, 60), Math.max(0, days), t, until || null, t]);
  } else {
    if (!sub.comped) return { changed: false };
    await runQuery("UPDATE premium_subs SET comped = 0, comp_by = NULL, comp_note = NULL, comp_until = NULL, status = 'none', updated = ? WHERE id = ?", [t, sub.id]);
    await runQuery(`INSERT OR IGNORE INTO premium_ledger (ref, sub_id, tier, target, kind, payer_name, amount, days, created)
                    VALUES (?, ?, ?, ?, 'uncomp', ?, 0, 0, ?)`, [`uncomp:${sub.id}:${t}`, sub.id, tier, target, String(by || "?").slice(0, 60), t]);
  }
  await loadCache();
  await afterChange(tier, target);
  // 1.99tk: comped time counts as paid - a running card subscription isn't charged until the comp ends
  let card = null;
  if (sub.stripe_sub) {
    try { card = await require("./stripebilling").compCard(sub, on, on ? until || 0 : 0); } catch (e) { card = { ok: false, error: e.message }; console.error("[premium] comp card:", e.message); }
  }
  return { changed: true, until: on ? until || null : null, card };
}
const AUTO = "auto:admin";
function tFor(userId) {
  try { const I = require("./i18n"); return I.tFor(I.getPref(userId) || "en"); } catch (e) {
    let en = {};
    try { en = require("./locales/en.json"); } catch (e2) { en = {}; }
    return (k, v) => String(en[k] || k).replace(/\{!?(\w+)\}/g, (m, x) => (v && v[x] != null ? String(v[x]) : m));
  }
}
/** 1.99ma: timed comps whose end passed -> back to whatever was paid (or lapsed), a ledger row + a notice. Idempotent. */
async function expireComps(t = now()) {
  await init();
  let n = 0;
  for (const s of await getQuery("SELECT * FROM premium_subs WHERE comped = 1 AND comp_until IS NOT NULL AND comp_until > 0 AND comp_until <= ?", [t])) {
    const r = await runQuery(`UPDATE premium_subs SET comped = 0, comp_by = NULL, comp_note = NULL, comp_until = NULL, status = 'none', updated = ?
                              WHERE id = ? AND comped = 1 AND comp_until = ?`, [t, s.id, s.comp_until]);
    if (!r.changes) continue;
    n++;
    await runQuery(`INSERT OR IGNORE INTO premium_ledger (ref, sub_id, tier, target, kind, payer_name, amount, days, created)
                    VALUES (?, ?, ?, ?, 'comp-end', 'job', 0, 0, ?)`, [`comp-end:${s.id}:${s.comp_until}`, s.id, s.tier, s.target, t]);
    const T = TIERS[s.tier];
    if (!T) continue;
    let who = T.kind === "user" ? s.target : null, label = "";
    if (T.kind === "pad") {
      const R = await require("./rooms").get(s.target);
      who = R && R.owner ? R.owner.userId : null; label = R ? ` (p/${R.slug || R.id})` : "";
    }
    if (who) {
      const tr = tFor(who);
      await notify(who, T.kind === "pad" ? "room" : "cosmetics", `prem-compend-${s.id}-${s.comp_until}`,
        tr("comps.notice.premium_ended_title", { tier: `${T.emoji} ${T.name}${label}` }), tr("comps.notice.premium_ended_body", { tier: T.name }), "/premium");
    }
    await audit(T.kind === "pad" ? s.target : null, "premium-comp-end", "job", `${s.tier} ${s.target}`);
  }
  if (n) { await loadCache(); await afterChange("lapse", null); }
  return n;
}
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
    if (s.stripe_sub || Number(s.stripe_through) > t) continue;       // Stripe is paying this one (1.99tk: while linked, never PAT too)
    if (t >= Number(s.paid_through) + CONFIG.grace_days * DAY) continue;   // past grace: the lapse below
    const T = TIERS[s.tier];
    if (!T) continue;
    const price = priceOf(T.id);
    const ref = `renew:${s.id}:${s.paid_through}`;
    let label = T.kind === "pad" ? `p/${s.target}` : "your Season Pass";
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
    const compsEnded = await expireComps(t);
    const r = await renewDue(t);
    const leaveNotices = await plusLeaveNotices(t).catch((e) => { console.error("[premium] plus leave notices:", e.message); return 0; });
    const waitlisted = await plusWaitlistNotify(t).catch((e) => { console.error("[premium] plus waitlist:", e.message); return 0; });
    const result = { day, comps, comps_ended: compsEnded, ...r, plus_leave_notices: leaveNotices, plus_waitlist_told: waitlisted };
    await runQuery("UPDATE premium_jobs SET finished = ?, result = ? WHERE day = ?", [now(), JSON.stringify(result), day]);
    if (r.renewed || r.failed || r.lapsed || comps.added || comps.removed || compsEnded) console.log("[premium] daily:", JSON.stringify(result));
    return result;
  })().finally(() => { ticking = null; });
  return ticking;
}
function startJob() {
  // an hourly look; the job itself runs once per UTC day (and its every step is idempotent)
  // 1.99ma: timed comps end within the hour (gates already stop at comp_until; this files the end + the notice)
  // 1.99qy: hourly too - the "Pepe leaves on <date>" notice and the waitlist shouldn't wait a day
  const run = () => tick().then(() => expireComps()).then(() => plusLeaveNotices()).then(() => plusWaitlistNotify())
    .catch((e) => console.error("[premium] daily job:", e.message));
  setTimeout(run, 60 * 1000).unref();
  setInterval(run, 3600 * 1000).unref();
}

// ── reads for pages ──
function subView(tier, sub, t = now()) {
  const st = statusOf(sub, t);
  return { tier, status: st, active: st === "active" || st === "grace" || st === "comped", comped: st === "comped", comp_until: st === "comped" ? compUntil(sub) || null : null,
           paid_through: sub ? Math.max(Number(sub.paid_through) || 0, Number(sub.stripe_through) || 0) : 0,
           ends: sub && !sub.comped ? endsAt(sub, t) : null, renewing: !!(sub && (sub.renewer_id || sub.stripe_sub)),
           stripe: !!(sub && sub.stripe_sub),
           // 1.99tk: a card subscription opened now: the PAT / comp time it waits for and its first charge (null = now)
           card_start: sub && !sub.stripe_sub ? cardStart(coveredUntil(sub, t), t) : null };
}
// 1.99mt: anonymous payments are one "🕶 Someone" row per payer with no name (the page never gets who)
async function contributors(subId, limit = 8) {
  const rows = await getQuery(`SELECT CASE WHEN COALESCE(anon, 0) = 1 THEN NULL ELSE payer_name END AS name, COALESCE(anon, 0) AS anon,
                                      SUM(amount) AS amount, MAX(created) AS last FROM premium_ledger
                               WHERE sub_id = ? AND amount > 0 AND payer_name IS NOT NULL GROUP BY payer_id, COALESCE(anon, 0) ORDER BY amount DESC LIMIT ?`, [subId, limit]);
  return rows.map((r) => ({ name: r.anon ? null : r.name, anon: !!r.anon, amount: r.amount, last: r.last }));
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
  let pad = null, padMiss = null;
  if (padSlug) {
    const L = await padLookup(padSlug, signed ? viewer : null);   // 1.99od: slug, p/slug, a link, the room id or the title
    const R = L.pad;
    if (!R) padMiss = { query: L.query, suggestions: L.suggestions, text: padMissText(L) };
    if (R) {
      const s = await subRow("prime_time", R.id);
      const owner = !!(signed && R.owner && R.owner.userId === viewer.userId);
      pad = { id: R.id, slug: R.slug || R.id, title: R.title, owner: R.owner ? (R.owner.display || R.owner.username) : null, mine: owner,
              ...subView("prime_time", s, t), renewer_me: !!(s && signed && s.renewer_id === viewer.userId),
              contributors: s ? (await contributors(s.id)).map((c) => ({ name: c.name, anon: c.anon, amount: c.amount })) : [] };
      // 1.99qp: 💎 Prime Time Plus on the same pad (+ what an upgrade would convert)
      const sp = await subRow("prime_plus", R.id);
      pad.plus = { ...subView("prime_plus", sp, t), renewer_me: !!(sp && signed && sp.renewer_id === viewer.userId),
                   contributors: sp ? (await contributors(sp.id)).map((c) => ({ name: c.name, anon: c.anon, amount: c.amount })) : [],
                   upgrade: await upgradePreview(R.id, t) };
      // 1.99tk: a Plus card subscription also waits for the pad's PAT Prime Time, converted like a PAT upgrade
      if (!(sp && sp.stripe_sub)) pad.plus.card_start = cardStart(await plusCardCover(R.id, t), t);
      pad.house = !!R.house;
    }
  }
  const C = CONFIG;
  return {
    sales: C.sales, period_days: C.period_days, grace_days: C.grace_days,
    prices: { prime_time: C.prime_price, prime_plus: C.plus_price, season_pass: C.season_price, sticker_pack: C.sticker_price },
    day_price: { prime_time: Math.ceil(C.prime_price / C.period_days), prime_plus: Math.ceil(C.plus_price / C.period_days) },
    plus_spots: plusSpots(t, pad ? pad.id : null),   // 1.99qy: {used, max, left, soldOut}; 1.99th: + held (open card checkouts)
    plus_waitlisted: signed ? !!(await getQuery("SELECT 1 FROM premium_plus_waitlist WHERE user_id = ?", [viewer.userId]))[0] : false,
    perks: { prime_extra_slots: C.prime_extra_slots, prime_extra_badges: C.prime_extra_badges, sp_upload_mult: C.sp_upload_mult, sp_sticker_packs: C.sp_sticker_packs,
             sb_slots_free: C.sb_slots_free, sb_slots_prime: C.sb_slots_prime, sb_slots_plus: C.sb_slots_plus, plus_bridge_gate: C.plus_bridge_gate },
    routes: routesView(),
    stripe: (() => { try { return require("./stripebilling").publicState(); } catch (e) { return { enabled: false }; } })(),
    viewer: { signed, balance, pass, username: signed ? viewer.username : null },
    pad,
    pad_missing: padMiss,          // 1.99od: {query, suggestions, text} when ?pad= named no pad (was: silently nothing)
  };
}
const DEST_LABEL = { fortknox: "🪙 Fort Knox", reserve: "🏛️ Federal Reserve", room: "💰 the pad vault" };
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
    const body = { ok: false, error: e.message, code, hint: ERR[code][1] };
    if (Array.isArray(e.suggestions)) { body.pad_query = e.pad_query || ""; body.suggestions = e.suggestions; }   // 1.99od: an unknown pad
    if (e.soldOut) body.sold_out = true;                                                                        // 1.99qy: Plus is full
    return { status: e.status || 400, body };
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
    // 1.99tc: THE perk table (premiumperks.js) for views/partials/tier-perks.ejs - /premium, /subscriptions, pad settings, owner panel
    const PK = require("./premiumperks");
    app.locals.perkTable = () => PK.table();
    app.locals.perkText = PK.text;
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
      const S = await state(req.user, req.query.pad ? String(req.query.pad).slice(0, 300) : null);
      let stickers = null;
      try { stickers = await require("./stickers").pageData(req.user); } catch (e) { stickers = null; }
      res.render("premium", { S, stickers, user: req.user ? req.user.username : null, title: "Prime Time & Season Pass" });
    } catch (e) { console.error("[premium] page:", e); res.status(500).send("Something went wrong."); }
  });
  app.get("/api/premium/state", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, ...(await state(req.user, req.query.pad ? String(req.query.pad).slice(0, 300) : null)) }); } catch (e) { fail(res, e); }
  });
  // 1.99od: "which pad is this?" for the pickers (/premium, /admin/comps): the pad, or the near misses this viewer may see
  app.get("/api/premium/padfind", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const L = await padLookup(String(req.query.q || "").slice(0, 300), req.user && req.user.userId ? req.user : null);
      res.json({ ok: true, query: L.query, pad: L.pad ? padBrief(L.pad) : null, suggestions: L.suggestions, text: L.pad ? "" : padMissText(L) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/premium/buy", addUser, write, async (req, res) => {
    try {
      const b = req.body || {};
      const r = await buy(req.user, { tier: b.tier, pad: b.pad, user: b.user, months: b.months, amount: b.amount, ref: b.ref, renew: b.renew === true, via: "web", anon: b.anon === true });
      res.json({ ok: true, ...r, state: await state(req.user, TIERS[b.tier] && TIERS[b.tier].kind === "pad" ? b.pad : null) });
    } catch (e) { fail(res, e); }
  });
  // 1.99qy: 💎 Plus sold out -> "tell me when a spot frees up"
  app.post("/api/premium/plus/waitlist", addUser, write, async (req, res) => {
    try { res.json({ ok: true, ...(await plusWaitlist(req.user, (req.body || {}).on !== false)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/premium/renew", addUser, write, async (req, res) => {
    try {
      const b = req.body || {};
      const r = await setRenew(req.user, { tier: b.tier, pad: b.pad, on: b.on });
      res.json({ ok: true, ...r, state: await state(req.user, TIERS[b.tier] && TIERS[b.tier].kind === "pad" ? b.pad : null) });
    } catch (e) { fail(res, e); }
  });
  // 1.99ack: premium admin (comp a tier, the config, a forced renewal tick) = premium.admin (siteperms.js, locked: Admins - was Staff)
  const staffOnly = (req) => { if (!SP.can(req.user, "premium.admin")) throw new Refuse(403, "Admins only."); };
  async function adminView() {
    const subs = await getQuery("SELECT tier, target, comped, comp_by, comp_until, paid_through, stripe_through, renewer_id IS NOT NULL AS renewing, status FROM premium_subs ORDER BY tier, target");
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
        if (T.kind === "pad") target = (await padOrRefuse(b.comp.pad, req.user)).id;
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
  init, register, buy, afterChange, setRenew, setComp, compAdmins, expireComps, compUntil, AUTO, renewDue, tick, state, config, setConfig, loadCache,
  plusSpots, plusUsed, plusCapCheck, coveredUntil, cardStart, plusCardCover, CARD_MIN_DEFER_MS, plusWaitlist, plusWaitlistNotify, plusLeaveNotices,
  retention, noteRetention, cleanRetention, RETENTION_DEFAULTS,         // 1.99tc: Pepe's retention windows (the perk lists)
  isPrime, isPrimePlus, padTier, plusOwner, bridgeAllowed, upgradeCredit, upgradePreview, hasPass, passCamfrogs, padPerks, userPerks, statusOf, endsAt, subSync, subRow, splitRoute, bookRoute, cleanRoutes, cleanConfig, priceOf, errBody,
  padTarget, padLookup, padOrRefuse, padInput, padMissText, userTarget, ensureSub, txRef, Refuse, TIERS, DEFAULTS, DAY, ROUTE_FLOWS, routesView,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
};
