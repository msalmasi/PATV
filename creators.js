// creators.js — ⭐ PATV Creators (1.99pv): creator subscriptions in PAT, locked posts (subscriber-only + pay-per-view),
// earnings held on the escrow ledger for 7 days, and the 18+ "R-rated" community flag. P0 + P1 of the design
// (pat-paywalls-design.md; user decisions D1-D14 of 2026-10-11).
//
// WHAT IT IS
//   * A creator is an account that passed the eligibility checks (D6: account >= 30 days, level >= 5, a linked identity,
//     a verified email, no feed strike in 60 days), accepted the Creator Terms (/creators/terms, versioned) and set 1-3
//     tiers (D8: 10k-5M PAT per 30 days). Staff can pause or ban a creator.
//   * Fans subscribe to a tier (30 days, auto-renew by default, 3-day grace, then lapse; cancel any time and the paid
//     period runs out - the premium.js / subscriptions.js lifecycle). Upgrading pays the prorated difference now.
//   * Locked posts: feed_posts.lock_kind 'sub' (tier >= lock_tier sees it) or 'ppv' (a one-time unlock, 1k-2M PAT; lock_tier
//     = "free for this tier and up", optional). Locked posts always have a title; everyone else gets the title, the
//     creator's teaser text, SERVER-SIDE blurred teasers (feed_attachments kind 'teaser' - the original file is never sent to
//     a non-payer: decorate strips it and /media/f refuses it) and the media counts.
//   * Moderators always see locked content: site Admins / Staff, and the owner of the pad the post lives in.
//
// HARD RULES (in code AND in the database - triggers)
//   * A locked post can never be NSFW: lock_kind != NULL => nsfw = 0 AND nsfw_admin != 1 AND no pad NSFW mark. Marking a
//     locked post NSFW (admin / pad owner) TAKES IT DOWN instead and refunds every unreleased purchase of it.
//   * Locked media goes through imagesafety.checkLocked: ALWAYS enforcing, fail-CLOSED; suggestive passes only in an 18+
//     community, explicit nudity / sexual content never does. While locked_enforce is off, only text posts can be locked.
//   * The EXPLICIT tier is hard-disabled: EXPLICIT_TIER_ENABLED is a constant (not a setting); a rating 'explicit' is
//     refused here and by a database trigger. The data-model hooks for it exist (creators.id_verification /
//     id_verified_at, creator_performers) and stay empty. /admin/creators/explicit tracks the legal / vendor gates.
//
// 18+ "R-RATED" COMMUNITIES (D1, modified)
//   A creator may mark their profile (creators.rating = 'r18') or a pad they own (creator_pads.r18) as 18+: suggestive /
//   NSFW-ish content WITHOUT explicit nudity or sexual acts. It needs the creator's attestation (18+, everyone depicted is
//   18+ and consented, R-rated not explicit, the rules). Viewers need to be signed in and to have confirmed they're 18+
//   once (age_attest); everyone else sees a blurred "18+" card for every post living in that community, and its files 404.
//
// MONEY (D2, D5, D8, D9) - every purchase is ONE transaction on the shared connection (mainstage's chain):
//   the fan's debit -> an escrow hold (escrow/ledger.js holdInTx; kinds CRS = a subscription period, CRP = a pay-per-view
//   unlock - SERVICE_KINDS, never Pepe's) + a creator_ledger row (UNIQUE ref = the idempotency key) + the sub / unlock row.
//   Purchases need the escrow ledger LIVE on this site (Phase 2): on prod it isn't yet, so buying is refused (423) until the
//   escrow cutover. Holds made earlier can always be released or refunded.
//   RELEASE (hourly job): 7 days (hold_days) after the purchase, unless frozen by a dispute or the creator is paused /
//   banned: settleInTx pays the creator's 80% to their wallet, keyed "crel:<ledger id>"; the 20% cut is booked in the same
//   transaction as reserve claims Pepe credits: premium's routing row "creators" (default Fort Knox 50 / room vault 50 of
//   the cut = FK 10 + vault 10 of the price); a profile, the creator's own pad or the fan's own pad: all Fort Knox (2026-10-12:
//   with profile vaults on, the creator's OWN profile: the whole cut into that profile's vault); a
//   third-party Camfrog pad: royalty_pct of the room share (D3: 5 of the 10) accrues to the pad owner (royalties.js) and
//   sits in the Reserve until the weekly release. Released creator earnings are capped at release_cap_week per creator per
//   week (Monday 00:00 UTC); the rest stays held, nothing is lost.
//   REFUNDS: a creator deleting a PPV post, staff removing it, an explicit takedown, a creator ban, an admin dispute decision
//   -> refundInTx of every UNRELEASED hold concerned (keyed "cref:<ledger id>"). Released earnings are never clawed back
//   from the creator unless an admin's clawback finds the buyer and the creator linked (D9); otherwise the platform absorbs.
//   Tips (D2 / D4) are the existing tip move - no cut.
//
//   creators           user_id PK, status active|paused|banned|pending, rating sfw|r18, r18_attest (JSON), bio, terms_version,
//                      terms_at, created, updated, note (staff), id_verification / id_verified_at (explicit-tier hooks, unused)
//   creator_plans      (creator_id, tier 1..3) name, price, perks (JSON: ppv_discount 0..50, dm), active
//   creator_subs       one row per subscription (fan_id, creator_id, tier, price, status active|grace|lapsed|ended, paid_through,
//                      cancel_at_end, renew, grace_until, comp, next_tier, room_id (the pad it was bought in), notified ...)
//   creator_unlocks    (fan_id, post_id) a PPV unlock: price, ledger_id, state active|refunded
//   creator_ledger     every money move (ref UNIQUE): kind sub|renew|upgrade|ppv, fan, creator, sub/post, room_id, amount,
//                      creator_share, cut, hold_id, state held|released|refunded|clawed, release_at, frozen, linked
//   creator_disputes   a fan's "report a problem" inside the hold window (freezes that hold until an admin decides)
//   creator_pads       (room_id) r18, allow_creators (the owner lets other creators post locked posts there)
//   age_attest         (user_id) a viewer's "I'm 18 or older" (version, at)
//   explicit_readiness the explicit-tier checklist (gate -> status / owner / evidence); informational, it can't enable anything
//   creator_performers P3 hook (performer ID + consent records per post) - created, never written while the tier is disabled
//   creator_kv         config
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

const NAME = "PATV Creators";
// ── the explicit tier: HARD-DISABLED. Not a setting. Turning it on needs a code change after every gate in
//    /admin/creators/explicit is done (legal sign-off, an adult-capable processor, ID / age vendors, 2257, CSAM hashing ...).
const EXPLICIT_TIER_ENABLED = false;
const RATINGS = Object.freeze(["sfw", "r18"]);               // what can be chosen today
const ALL_RATINGS = Object.freeze(["sfw", "r18", "explicit"]);   // the data model's full range ("explicit": refused)
const CREATOR_TERMS_VERSION = "2026-10-11";
const AGE_VERSION = "2026-10-11";
const R18_ATTEST_KEYS = Object.freeze(["adult", "depicted_adults", "not_explicit", "rules"]);
const KIND_SUB = "CRS", KIND_PPV = "CRP";
const DAY = 24 * 3600 * 1000;
const WEEK = 7 * DAY;
const MAX_TIERS = 3;

let clock = () => Date.now();
const now = () => clock();
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");

class Refuse extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.refuse = true; this.code = code || null; }
}

// ── config ──
const DEFAULTS = Object.freeze({
  enabled: !!process.env.STAGING,      // the feature switch: on on staging, OFF on prod until an admin switches it on
  apply_open: true,                    // new applications accepted
  review_applications: false,          // true: an application waits for staff approval
  creator_pct: 80,                     // D2: the creator's share; the rest is the platform cut
  hold_days: 7,                        // D5
  period_days: 30,
  grace_days: 3,
  sub_min: 10000, sub_max: 5000000,    // D8
  ppv_min: 1000, ppv_max: 2000000,
  release_cap_week: 20000000,          // D8: released creator earnings per creator per week
  royalty_pct: 50,                     // D3: of the room share, to a third-party pad's owner (5 of the 10)
  fan_max_subs: 50, fan_daily_max: 10000000, pair_daily_max: 5000000,
  ppv_per_day: 10,
  elig_age_days: 30, elig_level: 5, elig_strike_days: 60, elig_identity: true, elig_email: true,   // D6
  require_safety_for_media: true,      // locked pictures / videos only while imagesafety's locked_enforce is on
  confirm_over: 1000000,               // purchases over this: the modal asks to type the amount (account-takeover brake)
  pepe_commands: true,                 // D13: !subscribe / !subs / !creator answer
  dispute_days: 7,                     // a fan can report a problem this long after paying (the hold window)
});
const INT_LIMITS = {
  creator_pct: [50, 95], hold_days: [3, 30], period_days: [7, 90], grace_days: [0, 14], sub_min: [1000, 1e9], sub_max: [1000, 1e10],
  ppv_min: [100, 1e9], ppv_max: [100, 1e10], release_cap_week: [0, 1e12], royalty_pct: [0, 100], fan_max_subs: [1, 1000],
  fan_daily_max: [0, 1e12], pair_daily_max: [0, 1e12], ppv_per_day: [1, 1000], elig_age_days: [0, 3650], elig_level: [0, 1000],
  elig_strike_days: [0, 365], confirm_over: [0, 1e12], dispute_days: [1, 30],
};
let CONFIG = { ...DEFAULTS };
function cleanConfig(c) {
  const out = {};
  for (const [k, d] of Object.entries(DEFAULTS)) {
    const v = c[k];
    if (typeof d === "boolean") out[k] = v === undefined || v === null || v === "" ? d : (v === true || v === 1 || v === "1" || v === "on" || v === "true");
    else {
      const [lo, hi] = INT_LIMITS[k] || [0, 1e12];
      const n = Math.floor(Number(v));
      out[k] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
    }
  }
  if (out.sub_max < out.sub_min) out.sub_max = out.sub_min;
  if (out.ppv_max < out.ppv_min) out.ppv_max = out.ppv_min;
  return out;
}
const config = () => ({ ...CONFIG });

// ── storage ──
let ready = null;
async function addCol(table, col, def) {
  const have = (await getQuery(`PRAGMA table_info(${table})`)).some((c) => c.name === col);
  if (!have) await runQuery(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS creator_kv (k TEXT PRIMARY KEY, v TEXT)");
      await runQuery(`CREATE TABLE IF NOT EXISTS creators (user_id TEXT PRIMARY KEY, status TEXT NOT NULL, rating TEXT NOT NULL DEFAULT 'sfw',
        r18_attest TEXT, bio TEXT, terms_version TEXT, terms_at INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL, note TEXT,
        paused_reason TEXT, paused_by TEXT, id_verification TEXT, id_verified_at INTEGER)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS creator_plans (creator_id TEXT NOT NULL, tier INTEGER NOT NULL, name TEXT NOT NULL, price INTEGER NOT NULL,
        perks TEXT, active INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (creator_id, tier))`);
      await runQuery(`CREATE TABLE IF NOT EXISTS creator_subs (id INTEGER PRIMARY KEY AUTOINCREMENT, fan_id TEXT NOT NULL, creator_id TEXT NOT NULL,
        tier INTEGER NOT NULL, price INTEGER NOT NULL, status TEXT NOT NULL, paid_through INTEGER NOT NULL, cancel_at_end INTEGER NOT NULL DEFAULT 0,
        renew INTEGER NOT NULL DEFAULT 1, grace_until INTEGER, comp INTEGER NOT NULL DEFAULT 0, next_tier INTEGER, room_id TEXT, renewals INTEGER NOT NULL DEFAULT 0,
        notified TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL, ended_at INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS creator_subs_fan ON creator_subs (fan_id, status)");
      await runQuery("CREATE INDEX IF NOT EXISTS creator_subs_creator ON creator_subs (creator_id, status)");
      await runQuery("CREATE INDEX IF NOT EXISTS creator_subs_due ON creator_subs (status, paid_through)");
      await runQuery(`CREATE TABLE IF NOT EXISTS creator_unlocks (fan_id TEXT NOT NULL, post_id TEXT NOT NULL, creator_id TEXT NOT NULL, price INTEGER NOT NULL,
        ledger_id INTEGER, state TEXT NOT NULL DEFAULT 'active', created INTEGER NOT NULL, PRIMARY KEY (fan_id, post_id))`);
      await runQuery("CREATE INDEX IF NOT EXISTS creator_unlocks_post ON creator_unlocks (post_id, state)");
      await runQuery(`CREATE TABLE IF NOT EXISTS creator_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
        fan_id TEXT NOT NULL, creator_id TEXT NOT NULL, sub_id INTEGER, post_id TEXT, room_id TEXT, amount INTEGER NOT NULL, creator_share INTEGER NOT NULL,
        cut INTEGER NOT NULL, hold_id TEXT, escrow_ref TEXT, state TEXT NOT NULL, release_at INTEGER NOT NULL, released_at INTEGER, refunded_at INTEGER,
        frozen INTEGER NOT NULL DEFAULT 0, linked INTEGER NOT NULL DEFAULT 0, period_from INTEGER, period_to INTEGER, note TEXT, created INTEGER NOT NULL,
        CHECK (amount > 0))`);
      await runQuery("CREATE INDEX IF NOT EXISTS creator_ledger_due ON creator_ledger (state, release_at)");
      await runQuery("CREATE INDEX IF NOT EXISTS creator_ledger_creator ON creator_ledger (creator_id, created)");
      await runQuery("CREATE INDEX IF NOT EXISTS creator_ledger_fan ON creator_ledger (fan_id, created)");
      await runQuery("CREATE INDEX IF NOT EXISTS creator_ledger_post ON creator_ledger (post_id)");
      await runQuery(`CREATE TABLE IF NOT EXISTS creator_disputes (id INTEGER PRIMARY KEY AUTOINCREMENT, ledger_id INTEGER NOT NULL, fan_id TEXT NOT NULL,
        creator_id TEXT NOT NULL, reason TEXT NOT NULL, note TEXT, status TEXT NOT NULL DEFAULT 'open', created INTEGER NOT NULL, resolved_at INTEGER,
        resolved_by TEXT, resolution TEXT)`);
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS creator_disputes_once ON creator_disputes (ledger_id, fan_id)");
      await runQuery(`CREATE TABLE IF NOT EXISTS creator_pads (room_id TEXT PRIMARY KEY, r18 INTEGER NOT NULL DEFAULT 0, allow_creators INTEGER NOT NULL DEFAULT 0,
        r18_attest TEXT, set_by TEXT, updated INTEGER)`);
      await runQuery("CREATE TABLE IF NOT EXISTS age_attest (user_id TEXT PRIMARY KEY, version TEXT NOT NULL, at INTEGER NOT NULL)");
      await runQuery(`CREATE TABLE IF NOT EXISTS explicit_readiness (gate TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'todo', owner TEXT, evidence TEXT,
        updated_by TEXT, updated INTEGER)`);
      // P3 hook: the per-post performer records the explicit tier would need (ID + consent references, never the documents)
      await runQuery(`CREATE TABLE IF NOT EXISTS creator_performers (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT NOT NULL, creator_id TEXT NOT NULL,
        performer_ref TEXT NOT NULL, id_check_ref TEXT, consent_ref TEXT, created INTEGER NOT NULL)`);
      // the explicit tier is refused by the database too (a dropped trigger is all a future P3 needs - no table rewrite)
      await runQuery(`CREATE TRIGGER IF NOT EXISTS creators_no_explicit_i BEFORE INSERT ON creators WHEN NEW.rating NOT IN ('sfw','r18')
        BEGIN SELECT RAISE(ABORT, 'E_EXPLICIT_DISABLED: the explicit tier is disabled'); END`);
      await runQuery(`CREATE TRIGGER IF NOT EXISTS creators_no_explicit_u BEFORE UPDATE OF rating ON creators WHEN NEW.rating NOT IN ('sfw','r18')
        BEGIN SELECT RAISE(ABORT, 'E_EXPLICIT_DISABLED: the explicit tier is disabled'); END`);
      // the locked-post columns + the hard rule "a locked post is never NSFW" (feed_posts may not exist in a bare test DB)
      const fp = (await getQuery("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feed_posts'")).length;
      if (fp) await lockSchema();
      const c = {};
      for (const r of await getQuery("SELECT k, v FROM creator_kv")) { try { c[r.k] = JSON.parse(r.v); } catch (e) { /* default */ } }
      CONFIG = cleanConfig(c);
      await loadCaches();
    })().catch((e) => { ready = null; console.error("[creators] init:", e.message); throw e; });
  }
  return ready;
}
let lockSchemaDone = false;
async function lockSchema() {
  if (lockSchemaDone) return;
  await addCol("feed_posts", "lock_kind", "TEXT");
  await addCol("feed_posts", "lock_tier", "INTEGER");
  await addCol("feed_posts", "lock_price", "INTEGER");
  await addCol("feed_posts", "lock_teaser", "TEXT");
  await addCol("feed_posts", "lock_rating", "TEXT");
  await addCol("feed_attachments", "teaser_of", "TEXT");
  await runQuery("CREATE INDEX IF NOT EXISTS feed_posts_lock ON feed_posts (author_id, lock_kind)");
  const no = "SELECT RAISE(ABORT, 'E_LOCKED_NSFW: a locked post can never be NSFW')";
  await runQuery(`CREATE TRIGGER IF NOT EXISTS feed_locked_not_nsfw_i BEFORE INSERT ON feed_posts
    WHEN NEW.lock_kind IS NOT NULL AND (NEW.nsfw = 1 OR NEW.nsfw_admin = 1) BEGIN ${no}; END`);
  await runQuery(`CREATE TRIGGER IF NOT EXISTS feed_locked_not_nsfw_u BEFORE UPDATE OF nsfw, nsfw_admin, lock_kind ON feed_posts
    WHEN NEW.lock_kind IS NOT NULL AND (NEW.nsfw = 1 OR NEW.nsfw_admin = 1) BEGIN ${no}; END`);
  await runQuery(`CREATE TRIGGER IF NOT EXISTS feed_locked_room_not_nsfw BEFORE UPDATE OF nsfw ON feed_post_rooms
    WHEN NEW.nsfw = 1 AND EXISTS (SELECT 1 FROM feed_posts WHERE id = NEW.post_id AND lock_kind IS NOT NULL) BEGIN ${no}; END`);
  lockSchemaDone = true;
}
async function setConfig(patch, actor) {
  await init();
  const next = cleanConfig({ ...CONFIG, ...(patch || {}) });
  for (const k of Object.keys(DEFAULTS)) {
    await runQuery("INSERT INTO creator_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [k, JSON.stringify(next[k])]);
  }
  const was = CONFIG;
  CONFIG = next;
  const flips = Object.keys(DEFAULTS).filter((k) => was[k] !== next[k]).map((k) => `${k} ${was[k]} -> ${next[k]}`);
  console.log(`[creators] config by ${actor || "?"}: ${flips.join(", ") || "no change"}`);
  return config();
}

// ── caches (decorate runs on every feed page: the creator set and the 18+ communities are in memory) ──
const ACTIVE = new Map();       // user_id -> {status, rating}
const BY_NAME = new Map();      // 1.99qp: lowercased username -> user_id (the nav's "Creator dashboard" link)
const R18 = new Set();          // room ids that are 18+ (profiles of r18 creators + flagged pads)
const ALLOW = new Set();        // pads whose owner lets other creators post locked posts
async function loadCaches() {
  ACTIVE.clear(); R18.clear(); ALLOW.clear(); BY_NAME.clear();
  for (const r of await getQuery("SELECT c.user_id, c.status, c.rating, u.username FROM creators c LEFT JOIN users u ON u.userId = c.user_id")) {
    ACTIVE.set(r.user_id, { status: r.status, rating: r.rating });
    if (r.username) BY_NAME.set(String(r.username).toLowerCase(), r.user_id);
    if (r.status === "active" && r.rating === "r18") R18.add("user:" + r.user_id);
  }
  for (const r of await getQuery("SELECT room_id, r18, allow_creators FROM creator_pads")) {
    if (r.r18) R18.add(r.room_id);
    if (r.allow_creators) ALLOW.add(r.room_id);
  }
}
const isActiveCreator = (userId) => { const c = ACTIVE.get(String(userId || "")); return !!(c && c.status === "active"); };
const isCreatorBadge = (userId) => { const c = ACTIVE.get(String(userId || "")); return !!(c && (c.status === "active" || c.status === "paused")); };
const isR18Room = (roomId) => !!roomId && R18.has(String(roomId));
/** 1.99qp: the links to PATV Creators (nav menus, profiles, /subscriptions, /premium) - {on: the feature switch, creator:
 *  this username has a creator account (active or paused) -> "Creator dashboard", else "Become a creator"}. Sync. */
function navFor(username) {
  const on = !!CONFIG.enabled;
  const id = username ? BY_NAME.get(String(username).toLowerCase()) : null;
  return { on, creator: on && !!id && isCreatorBadge(id) };
}

// ── helpers ──
const tx = (fn) => require("./mainstage")._tx(fn);
const ESC = () => require("./escrow/ledger");
// 1.99ack: capabilities (siteperms.js) - creators.admin (the staff queue / disputes / ledger), creators.pad_flags_any (any pad's
// creator flags), feed.see_hidden (locked / 18+ posts), creators.config_explicit (the explicit tier's gates)
const can = (u, k) => SP.can(u, k);
const cleanLine = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const KEY_RE = /^[A-Za-z0-9_.:\-]{8,80}$/;
async function userRow(userId) { return (await getQuery("SELECT * FROM users WHERE userId = ?", [String(userId || "")]))[0] || null; }
async function userByName(name) {
  const n = String(name == null ? "" : name).trim().replace(/^@/, "").replace(/^u\//i, "").slice(0, 64);
  if (!n) return null;
  return (await getQuery("SELECT * FROM users WHERE LOWER(username) = LOWER(?)", [n]))[0] || null;
}
async function creatorRow(userId) { await init(); return (await getQuery("SELECT * FROM creators WHERE user_id = ?", [String(userId || "")]))[0] || null; }
async function plansOf(creatorId, { all = false } = {}) {
  await init();
  return (await getQuery(`SELECT * FROM creator_plans WHERE creator_id = ? ${all ? "" : "AND active = 1"} ORDER BY tier`, [String(creatorId)]))
    .map((p) => ({ tier: p.tier, name: p.name, price: Number(p.price), active: !!p.active, perks: parseJson(p.perks) || {} }));
}
function parseJson(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }
const createdMsOf = (u) => {
  const v = u && u.created_at;
  if (!v) return null;
  if (typeof v === "number") return v;
  const t = Date.parse(String(v).includes("T") ? String(v) : String(v).replace(" ", "T") + "Z");
  return Number.isFinite(t) ? t : null;
};
async function notify(userId, n) {
  try { await require("./inbox").addSafe(userId, { kind: "creator", link: "/creator", ...n }); } catch (e) { /* never blocks */ }
}
// the creators queue's notices go to the site Admins (a recipient list, not a capability - 1.99ack: was named staffIds)
async function adminIds() { return (await getQuery("SELECT userId FROM users WHERE class = 'Admin'").catch(() => [])).map((r) => r.userId); }
async function notifyStaff(n) { for (const id of await adminIds()) await notify(id, { kind: "admin", link: "/admin/creators", ...n }); }
async function escrowLive() { try { return await ESC().live(); } catch (e) { return false; } }
/** Monday 00:00 UTC of the week holding `t`. */
function weekStart(t = now()) {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * DAY;
}

// ── eligibility (D6) ──
/** -> {ok, checks: [{key, ok, have, need}]} */
async function eligibility(userId) {
  await init();
  const u = await userRow(userId);
  const C = CONFIG;
  const checks = [];
  if (!u) return { ok: false, checks: [{ key: "account", ok: false }] };
  const t = now();
  const cm = createdMsOf(u);
  const ageDays = cm ? Math.floor((t - cm) / DAY) : 0;
  checks.push({ key: "age", ok: ageDays >= C.elig_age_days, have: ageDays, need: C.elig_age_days });
  const lvl = Number(u.level) || 0;
  checks.push({ key: "level", ok: lvl >= C.elig_level, have: lvl, need: C.elig_level });
  if (C.elig_identity) {
    let linked = !!(u.camfrogUsername || u.discordId || u.twitchId);
    if (!linked) linked = (await getQuery("SELECT 1 AS x FROM sso_links WHERE user_id = ? LIMIT 1", [u.userId]).catch(() => [])).length > 0;
    if (!linked) linked = (await getQuery("SELECT 1 AS x FROM telegram_links WHERE user_id = ? LIMIT 1", [u.userId]).catch(() => [])).length > 0;
    checks.push({ key: "identity", ok: linked });
  }
  if (C.elig_email) {
    let ver = Number(u.isEmailVerified) === 1;
    if (!ver) ver = (await getQuery("SELECT 1 AS x FROM sso_links WHERE user_id = ? AND email IS NOT NULL LIMIT 1", [u.userId]).catch(() => [])).length > 0;
    checks.push({ key: "email", ok: ver });
  }
  const since = t - C.elig_strike_days * DAY;
  const bans = await getQuery("SELECT 1 AS x FROM feed_bans WHERE user_id = ? AND (at >= ? OR until IS NULL OR until > ?) LIMIT 1", [u.userId, since, t]).catch(() => []);
  const removed = await getQuery(`SELECT 1 AS x FROM feed_reports r JOIN feed_posts p ON p.id = r.post_id WHERE p.author_id = ? AND r.action IN ('removed', 'banned')
                                  AND r.resolved_at >= ? LIMIT 1`, [u.userId, since]).catch(() => []);
  checks.push({ key: "strikes", ok: !bans.length && !removed.length, need: C.elig_strike_days });
  return { ok: checks.every((c) => c.ok), checks };
}

// ── becoming a creator ──
/** The 18+ attestation a creator gives (every box ticked) -> the stored JSON, or a refusal. */
function r18Attestation(a) {
  const x = a && typeof a === "object" ? a : {};
  for (const k of R18_ATTEST_KEYS) if (!(x[k] === true || x[k] === "1" || x[k] === "on" || x[k] === 1)) {
    throw new Refuse(400, "An 18+ profile or pad needs every box of the 18+ attestation ticked.", "E_ATTEST");
  }
  return { v: CREATOR_TERMS_VERSION, at: now(), keys: R18_ATTEST_KEYS.slice() };
}
function assertRating(r) {
  const v = String(r || "sfw");
  if (v === "explicit" || !ALL_RATINGS.includes(v)) {
    throw new Refuse(403, "Explicit adult content isn't available on PATV Creators. Profiles and pads can be safe for work, or 18+ (R-rated, never explicit).", "E_EXPLICIT_DISABLED");
  }
  if (!EXPLICIT_TIER_ENABLED && !RATINGS.includes(v)) throw new Refuse(403, "That rating isn't available.", "E_EXPLICIT_DISABLED");
  return v;
}
function cleanPlans(list) {
  const C = CONFIG;
  const arr = (Array.isArray(list) ? list : []).filter((p) => p && (p.name || p.price)).slice(0, MAX_TIERS + 1);
  if (!arr.length) throw new Refuse(400, "Set at least one tier (a name and a price).", "E_PLANS");
  if (arr.length > MAX_TIERS) throw new Refuse(400, `At most ${MAX_TIERS} tiers.`, "E_PLANS");
  const out = arr.map((p, i) => {
    const name = cleanLine(p.name, 40);
    const price = require("./public/js/patamount").parse(p.price);
    if (!name) throw new Refuse(400, `Tier ${i + 1} needs a name.`, "E_PLANS");
    if (!Number.isSafeInteger(price) || price < C.sub_min || price > C.sub_max) {
      throw new Refuse(400, `Tier ${i + 1}: the price must be between ${fmt(C.sub_min)} and ${fmt(C.sub_max)} PAT per ${C.period_days} days.`, "E_PRICE");
    }
    const disc = Math.floor(Number(p.ppv_discount));
    return { tier: i + 1, name, price, perks: { ppv_discount: Number.isFinite(disc) ? Math.min(50, Math.max(0, disc)) : 0 } };
  });
  for (let i = 1; i < out.length; i++) if (out[i].price < out[i - 1].price) throw new Refuse(400, "Each tier must cost at least as much as the one before it.", "E_PRICE");
  return out;
}
/**
 * Apply / update: {terms: true, rating, attest, plans: [{name, price, ppv_discount}], bio}. Eligibility first (staff can
 * approve anyone by hand on /admin/creators). -> {ok, status}
 */
async function apply(user, input = {}) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  if (!CONFIG.enabled) throw new Refuse(423, `${NAME} isn't open yet.`, "E_FEATURE_OFF");
  const have = await creatorRow(user.userId);
  if (have && have.status === "banned") throw new Refuse(403, "This account can't be a creator.", "E_BANNED");
  if (!have && !CONFIG.apply_open) throw new Refuse(423, "Applications are closed right now.", "E_FEATURE_OFF");
  if (!(input.terms === true || input.terms === "1" || input.terms === "on")) throw new Refuse(400, "Accept the Creator Terms first.", "E_TERMS");
  const rating = assertRating(input.rating);
  const attest = rating === "r18" ? r18Attestation(input.attest) : null;
  const plans = cleanPlans(input.plans);
  if (!have || have.status === "pending") {
    const el = await eligibility(user.userId);
    if (!el.ok && !(have && have.status === "pending")) throw new Refuse(403, "This account doesn't meet the creator requirements yet.", "E_NOT_ELIGIBLE");
  }
  const t = now();
  const status = have ? (have.status === "pending" ? "pending" : have.status) : (CONFIG.review_applications ? "pending" : "active");
  if (have) {
    await runQuery(`UPDATE creators SET rating = ?, r18_attest = COALESCE(?, r18_attest), bio = ?, terms_version = ?, terms_at = ?, updated = ? WHERE user_id = ?`,
                   [rating, attest ? JSON.stringify(attest) : null, cleanLine(input.bio, 300) || null, CREATOR_TERMS_VERSION, t, t, user.userId]);
  } else {
    await runQuery(`INSERT INTO creators (user_id, status, rating, r18_attest, bio, terms_version, terms_at, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                   [user.userId, status, rating, attest ? JSON.stringify(attest) : null, cleanLine(input.bio, 300) || null, CREATOR_TERMS_VERSION, t, t, t]);
  }
  await savePlans(user.userId, plans);
  await loadCaches();
  if (attest) { try { require("./adultgate").note(user.userId); } catch (e) { /* adultgate site: its "adult" box counts for the 18+ pad gate */ } }
  if (!have) {
    console.log(`[creators] ${user.username} ${status === "pending" ? "applied" : "became a creator"} (${rating}, ${plans.length} tier(s))`);
    if (status === "pending") await notifyStaff({ title: `⭐ ${user.username} applied to ${NAME}`, body: "Review the application.", ref: "cr-apply:" + user.userId });
    try { await require("./rooms").ensureProfile(user.userId); } catch (e) { /* the profile pad is made on first use anyway */ }
  }
  return { ok: true, status, rating };
}
/** Tiers: existing subs keep their price until renewal; a removed tier stops renewing (those subs lapse at the end). */
async function savePlans(creatorId, plans) {
  const t = now();
  for (const p of plans) {
    await runQuery(`INSERT INTO creator_plans (creator_id, tier, name, price, perks, active, created, updated) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
                    ON CONFLICT(creator_id, tier) DO UPDATE SET name = excluded.name, price = excluded.price, perks = excluded.perks, active = 1, updated = excluded.updated`,
                   [creatorId, p.tier, p.name, p.price, JSON.stringify(p.perks || {}), t, t]);
  }
  await runQuery("UPDATE creator_plans SET active = 0, updated = ? WHERE creator_id = ? AND tier > ?", [t, creatorId, plans.length]);
}

/** A pad's creator flags (its owner): {r18, allow_creators, attest}. r18 needs an active creator + the attestation. */
async function setPadFlags(user, roomId, { r18, allow_creators, attest } = {}) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const rooms = require("./rooms");
  const R = (await rooms.get(String(roomId || ""))) || (await rooms.bySlug(String(roomId || "")));
  if (!R) throw new Refuse(404, "No such pad.");
  if (rooms.isProfile(R.id)) throw new Refuse(400, "Your profile's rating is set on the creator application.");
  if (!(R.owner && R.owner.userId === user.userId) && !can(user, "creators.pad_flags_any")) throw new Refuse(403, "Only the pad's owner can do that.");
  const cur = (await getQuery("SELECT * FROM creator_pads WHERE room_id = ?", [R.id]))[0] || { r18: 0, allow_creators: 0 };
  let a = null;
  const wantR18 = r18 === undefined ? !!cur.r18 : !!(r18 === true || r18 === "1" || r18 === 1 || r18 === "on");
  if (wantR18 && !cur.r18) {
    if (!isActiveCreator(user.userId) && !can(user, "creators.pad_flags_any")) throw new Refuse(403, "Only an active creator can mark a pad 18+.", "E_NOT_CREATOR");
    a = r18Attestation(attest);
    // an 18+ pad can't allow NSFW posts (R-rated, never explicit): switch the pad's NSFW allowance off
    try { await setPadAllowNsfwOff(R.id); } catch (e) { /* best effort */ }
  }
  const wantAllow = allow_creators === undefined ? !!cur.allow_creators : !!(allow_creators === true || allow_creators === "1" || allow_creators === 1 || allow_creators === "on");
  await runQuery(`INSERT INTO creator_pads (room_id, r18, allow_creators, r18_attest, set_by, updated) VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(room_id) DO UPDATE SET r18 = excluded.r18, allow_creators = excluded.allow_creators,
                  r18_attest = COALESCE(excluded.r18_attest, creator_pads.r18_attest), set_by = excluded.set_by, updated = excluded.updated`,
                 [R.id, wantR18 ? 1 : 0, wantAllow ? 1 : 0, a ? JSON.stringify(a) : null, user.username, now()]);
  await loadCaches();
  // adultgate site: the pad owner's own 18+ attestation (its "adult" box) counts for the 18+ pad gate (adultgate.load reads it)
  if (a && R.owner && R.owner.userId === user.userId) { try { require("./adultgate").note(user.userId); } catch (e) { /* no gate */ } }
  return { ok: true, r18: wantR18, allow_creators: wantAllow };
}
async function setPadAllowNsfwOff(roomId) {
  const store = require("./feedstore");
  const S = await store.roomSettings(roomId);
  if (S.allow_nsfw === false) return;
  const key = "room:" + roomId;
  const raw = await store.kvGet(key).catch(() => null);
  const obj = parseJson(raw) || {};
  obj.allow_nsfw = false;
  await store.kvSet(key, JSON.stringify(obj));
}

// ── staff ──
async function staffSet(actor, userId, { status, note, rating } = {}) {
  await init();
  if (!can(actor, "creators.admin")) throw new Refuse(403, "Staff only.");
  const c = await creatorRow(userId);
  const u = await userRow(userId);
  if (!u) throw new Refuse(404, "No such account.");
  const t = now();
  if (!c) {
    if (status !== "active") throw new Refuse(404, "Not a creator.");
    await runQuery("INSERT INTO creators (user_id, status, rating, created, updated, note) VALUES (?, 'active', 'sfw', ?, ?, ?)", [userId, t, t, cleanLine(note, 300) || "approved by staff"]);
  } else {
    if (status && !["active", "paused", "banned", "pending"].includes(status)) throw new Refuse(400, "Bad status.");
    if (rating !== undefined) assertRating(rating);
    await runQuery("UPDATE creators SET status = COALESCE(?, status), rating = COALESCE(?, rating), note = COALESCE(?, note), paused_reason = ?, paused_by = ?, updated = ? WHERE user_id = ?",
                   [status || null, rating || null, note != null ? cleanLine(note, 300) : null, status === "paused" || status === "banned" ? cleanLine(note, 300) || status : null,
                    status === "paused" || status === "banned" ? actor.username : null, t, userId]);
  }
  await loadCaches();
  let refunded = 0;
  if (status === "banned") {
    // a ban: every unreleased hold goes back to its fan, no more renewals
    for (const l of await getQuery("SELECT id FROM creator_ledger WHERE creator_id = ? AND state = 'held'", [userId])) {
      if (await refundLedger(l.id, "creator banned", actor.username).catch((e) => { console.error("[creators] ban refund:", e.message); return false; })) refunded++;
    }
    await runQuery("UPDATE creator_subs SET status = 'ended', ended_at = ?, updated = ? WHERE creator_id = ? AND status IN ('active','grace')", [t, t, userId]);
  }
  if (status === "paused" || status === "banned") await notify(userId, { title: `⭐ Your ${NAME} account was ${status}`, body: cleanLine(note, 300) || "Contact the staff for details.", ref: `cr-status:${userId}:${t}` });
  if (status === "active" && c && c.status === "pending") await notify(userId, { title: `⭐ Welcome to ${NAME}`, body: "Your application was approved - your creator dashboard is ready.", ref: `cr-ok:${userId}` });
  try { await require("./adminaudit").record(actor, "creator:" + (status || "edit"), { userId: u.userId, username: u.username }, { rating: rating || null }, cleanLine(note, 200) || null); } catch (e) { /* optional */ }
  return { ok: true, refunded };
}

// ── locks (the feed's create / decorate / media hooks) ──
/** Where may `u` post a locked post? Their own profile, a pad they own, a pad whose owner allows creators. */
function lockRoomOk(u, roomId) {
  const rooms = require("./rooms");
  if (!roomId) return false;
  if (rooms.isProfile(roomId)) return roomId === rooms.profileId(u.userId);
  const R = rooms.getCached(roomId);
  if (R && R.owner && R.owner.userId === u.userId) return true;
  return ALLOW.has(roomId);
}
/**
 * feedstore.create calls this BEFORE anything is charged, for input.lock = {kind: sub|ppv, tier, price, teaser}.
 * -> the lock to apply after the insert. Refuses: not a creator, NSFW asked for, no title, a bad tier / price, media
 * while the locked image check is off, too many PPV posts today.
 */
async function prepareLock(u, input, { roomId, title, atts = [], link = null, aiNsfw = false } = {}) {
  await init();
  const L = input && input.lock && typeof input.lock === "object" ? input.lock : null;
  if (!L || !L.kind || L.kind === "none") return null;
  if (!CONFIG.enabled) throw new Refuse(423, `${NAME} isn't open yet.`, "E_FEATURE_OFF");
  if (!isActiveCreator(u.userId)) throw new Refuse(403, `Only an active creator can lock a post - apply at /creators.`, "E_NOT_CREATOR");
  const kind = L.kind === "sub" ? "sub" : L.kind === "ppv" ? "ppv" : null;
  if (!kind) throw new Refuse(400, "Bad lock.", "E_LOCK");
  if (input.nsfw === true || input.nsfw === 1 || input.nsfw === "1" || input.nsfw === "on" || aiNsfw) {
    throw new Refuse(400, "A locked post can't be NSFW. Locked content must be safe for work (or R-rated on an 18+ profile or pad, never explicit).", "E_LOCKED_NSFW");
  }
  if (!title) throw new Refuse(400, "A locked post needs a title (it's what everyone sees).", "E_LOCK_TITLE");
  if (!lockRoomOk(u, roomId)) throw new Refuse(403, "Locked posts go on your profile or in a pad you own (or one whose owner allows creators).", "E_LOCK_PAD");
  const plans = await plansOf(u.userId);
  let tier = Math.floor(Number(L.tier)) || 0;
  let price = null;
  if (kind === "sub") {
    if (!plans.length) throw new Refuse(400, "Set up your tiers first.", "E_PLANS");
    if (!tier) tier = plans[0].tier;
    if (!plans.some((p) => p.tier === tier)) throw new Refuse(400, "Pick one of your tiers.", "E_LOCK");
  } else {
    price = require("./public/js/patamount").parse(L.price);
    if (!Number.isSafeInteger(price) || price < CONFIG.ppv_min || price > CONFIG.ppv_max) {
      throw new Refuse(400, `A pay-per-view price is between ${fmt(CONFIG.ppv_min)} and ${fmt(CONFIG.ppv_max)} PAT.`, "E_PRICE");
    }
    if (tier && !plans.some((p) => p.tier === tier)) tier = 0;
    const today = (await getQuery("SELECT COUNT(*) AS n FROM feed_posts WHERE author_id = ? AND lock_kind = 'ppv' AND created > ?", [u.userId, now() - DAY]))[0].n;
    if (today >= CONFIG.ppv_per_day) throw new Refuse(429, `At most ${CONFIG.ppv_per_day} pay-per-view posts a day.`, "E_RATE");
  }
  const media = atts.filter((a) => a.kind === "image" || a.kind === "video");
  if (media.length && CONFIG.require_safety_for_media && !(await require("./imagesafety").lockedEnforcing())) {
    throw new Refuse(423, "Locked pictures and videos aren't available yet (the image safety check for locked posts isn't switched on) - lock a text post instead.", "E_SAFETY_OFF");
  }
  void link;
  return { kind, tier: tier || null, price, teaser: cleanLine(L.teaser, 280) || null, rating: isR18Room(roomId) ? "r18" : "sfw", roomId };
}
/** The locked-media check for every picture / video of the post (imagesafety.checkLocked: enforcing, fail-closed). */
async function lockedMediaCheck({ atts, roomId, userId, lock }) {
  const IS = require("./imagesafety");
  const fm = require("./feedmedia");
  const todo = (atts || []).filter((a) => a.kind === "image" || a.kind === "video");
  if (!todo.length) return { ok: true };
  const rs = await Promise.all(todo.map((a) => IS.checkLocked({ kind: a.kind, file: fm.filePath(a.file), poster: a.poster ? fm.filePath(a.poster) : null, secs: a.secs,
                                                                userId, roomId, ref: "lock:" + a.id, r18: lock && lock.rating === "r18" })));
  const bad = rs.find((r) => !r.ok);
  return bad ? { ok: false, reason: bad.reason } : { ok: true };
}
/** After the insert: the lock columns + the blurred teasers (never a copy a non-payer could un-blur). */
async function attachLock(postId, lock, atts = []) {
  await init();
  await lockSchema();
  await runQuery("UPDATE feed_posts SET lock_kind = ?, lock_tier = ?, lock_price = ?, lock_teaser = ?, lock_rating = ?, nsfw = 0, nsfw_admin = NULL WHERE id = ?",
                 [lock.kind, lock.tier, lock.price, lock.teaser, lock.rating, postId]);
  const owner = (await getQuery("SELECT author_id FROM feed_posts WHERE id = ?", [postId]))[0];
  let n = 0;
  for (const a of atts) {
    if (a.kind !== "image" && a.kind !== "video") continue;
    const src = a.kind === "image" ? a.file : a.poster;
    if (!src) continue;
    const name = await makeTeaser(src).catch((e) => { console.error("[creators] teaser:", e.message); return null; });
    if (!name) continue;
    await runQuery(`INSERT INTO feed_attachments (id, post_id, owner_id, kind, ct, file, thumb, w, h, bytes, sort, state, created, size_declared, received, teaser_of)
                    VALUES (?, ?, ?, 'teaser', 'image/webp', ?, ?, ?, ?, ?, ?, 'ready', ?, 0, 0, ?)`,
                   [crypto.randomBytes(8).toString("hex"), postId, owner ? owner.author_id : "", name.file, name.file, name.w, name.h, name.bytes, 100 + n++, now(), a.id]);
  }
  return { teasers: n };
}
/** A heavy server-side blur: downscale to 24 px, back up to 480 px, blur again, low-quality webp. -> {file, w, h, bytes} */
async function makeTeaser(srcName) {
  const fm = require("./feedmedia");
  const p = fm.filePath(srcName);
  if (!p) return null;
  const sharp = require("sharp");
  const tiny = await sharp(p, { limitInputPixels: 60e6, pages: 1 }).rotate().resize({ width: 24, height: 24, fit: "inside" }).blur(2).png().toBuffer();
  const base = crypto.randomBytes(16).toString("hex");
  const sub = require("path").join(fm.dir(), base.slice(0, 2));
  require("fs").mkdirSync(sub, { recursive: true });
  const name = base + "_t.webp";
  const info = await sharp(tiny).resize({ width: 480, height: 480, fit: "inside", kernel: "cubic" }).blur(18).modulate({ brightness: 0.8 })
    .webp({ quality: 40 }).toFile(require("path").join(sub, name));
  return { file: name, w: info.width, h: info.height, bytes: info.size };
}

// ── who may see what ──
async function attested(userId) {
  if (!userId) return false;
  await init();
  return (await getQuery("SELECT 1 AS x FROM age_attest WHERE user_id = ?", [String(userId)])).length > 0;
}
async function attestAge(user, yes) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  if (!(yes === true || yes === "1" || yes === "on")) throw new Refuse(400, "Tick the box to confirm you're 18 or older.");
  await runQuery("INSERT INTO age_attest (user_id, version, at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET version = excluded.version, at = excluded.at",
                 [user.userId, AGE_VERSION, now()]);
  try { require("./adultgate").note(user.userId); } catch (e) { /* adultgate site: the 18+ pad gate counts it at once */ }
  return { ok: true };
}
/** The live subscriptions of a fan: Map(creator_id -> tier). Grace counts; comps count. */
async function liveTiers(fanId, creatorIds = null) {
  if (!fanId) return new Map();
  const t = now();
  const ids = creatorIds ? [...new Set(creatorIds.map(String))] : null;
  const rows = await getQuery(`SELECT creator_id, tier, status, paid_through, grace_until FROM creator_subs WHERE fan_id = ? AND status IN ('active','grace')
                               ${ids ? `AND creator_id IN (${ids.map(() => "?").join(",") || "''"})` : ""}`, ids ? [fanId, ...ids] : [fanId]);
  const m = new Map();
  for (const r of rows) {
    const until = r.status === "grace" ? Number(r.grace_until) || Number(r.paid_through) : Number(r.paid_through);
    if (until <= t) continue;
    m.set(r.creator_id, Math.max(m.get(r.creator_id) || 0, Number(r.tier)));
  }
  return m;
}
/**
 * For decorated posts (feedstore.decorate's last step): gate locked posts and 18+ communities for this viewer. Mutates and
 * returns `outs`. A gated post keeps its title (locked) or loses it (18+), and loses body / files / link; out.creator says why.
 */
async function applyLocks(outs, rows, viewer) {
  if (!outs || !outs.length) return outs;
  await init();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const vid = viewer && viewer.userId ? viewer.userId : null;
  const staff = can(viewer, "feed.see_hidden");
  const lockedIds = outs.filter((o) => { const r = byId.get(o.id); return r && r.lock_kind; }).map((o) => o.id);
  const r18Of = (o) => { const r = byId.get(o.id); return !!(r && (r.lock_rating === "r18" || isR18Room(r.home_pad) || (o.roomsAll || []).some((x) => !x.removed && isR18Room(x.id)))); };
  const anyR18 = outs.some(r18Of);
  for (const o of outs) if (o.author && isCreatorBadge(o.author.userId)) o.author.creator = true;
  if (!lockedIds.length && !anyR18) return outs;
  const age = anyR18 && vid ? await attested(vid) : false;
  const tiers = lockedIds.length && vid ? await liveTiers(vid, outs.filter((o) => lockedIds.includes(o.id)).map((o) => o.author.userId)) : new Map();
  const unlocked = new Set(lockedIds.length && vid ? (await getQuery(`SELECT post_id FROM creator_unlocks WHERE fan_id = ? AND state = 'active' AND post_id IN (${lockedIds.map(() => "?").join(",")})`,
                                                                    [vid, ...lockedIds])).map((r) => r.post_id) : []);
  const teasers = new Map();
  if (lockedIds.length) {
    for (const a of await getQuery(`SELECT post_id, file, w, h FROM feed_attachments WHERE post_id IN (${lockedIds.map(() => "?").join(",")}) AND kind = 'teaser' AND state = 'ready' ORDER BY sort`, lockedIds)) {
      if (!teasers.has(a.post_id)) teasers.set(a.post_id, []);
      teasers.get(a.post_id).push({ file: a.file, w: a.w, h: a.h });
    }
  }
  const rooms = require("./rooms");
  const planCache = new Map();
  for (const o of outs) {
    const r = byId.get(o.id);
    if (!r) continue;
    const author = o.author && o.author.userId;
    const mine = !!(vid && vid === author);
    const homeOwner = (() => { const R = r.home_pad ? rooms.getCached(r.home_pad) : null; return !!(vid && R && R.owner && R.owner.userId === vid && !rooms.isProfile(R.id)); })();
    const r18 = r18Of(o);
    const counts = { images: o.images.length, video: o.video.length, audio: o.audio.length, secs: Math.round(o.video.concat(o.audio).reduce((s, v) => s + (Number(v.secs) || 0), 0)) };
    if (r.lock_kind) {
      if (!planCache.has(author)) planCache.set(author, await plansOf(author));
      const plans = planCache.get(author);
      const plan = r.lock_tier ? plans.find((p) => p.tier === Number(r.lock_tier)) : null;
      let via = null;
      if (staff) via = "staff";
      else if (mine) via = "author";
      else if (homeOwner) via = "moderator";
      else if (r.lock_kind === "sub" && (tiers.get(author) || 0) >= (Number(r.lock_tier) || 1)) via = "sub";
      else if (r.lock_kind === "ppv" && unlocked.has(r.id)) via = "ppv";
      else if (r.lock_kind === "ppv" && r.lock_tier && (tiers.get(author) || 0) >= Number(r.lock_tier)) via = "sub";
      const myTier = tiers.get(author) || 0;
      const disc = r.lock_kind === "ppv" && myTier ? ((plans.find((p) => p.tier === myTier) || {}).perks || {}).ppv_discount || 0 : 0;
      o.creator = { kind: r.lock_kind, tier: r.lock_tier || null, tierName: plan ? plan.name : null, price: r.lock_price || null,
                    yourPrice: r.lock_price ? Math.max(CONFIG.ppv_min, Math.floor(r.lock_price * (100 - disc) / 100)) : null, discount: disc,
                    teaser: r.lock_teaser || "", rating: r.lock_rating || (r18 ? "r18" : "sfw"), counts, via, gated: !via, r18,
                    creator: o.author ? o.author.username : null, teasers: [] };
      if (!via) {
        o.creator.teasers = (teasers.get(o.id) || []).slice(0, 4);
        o.body = ""; o.images = []; o.video = []; o.audio = []; o.link = null; o.ai = []; o.quote = null; o.voice = null;
      }
    }
    if (r18 && !staff && !mine && !age) {
      o.creator = Object.assign(o.creator || { counts }, { r18: true, r18Gate: true, gated: true, teasers: [] });
      o.title = ""; o.body = ""; o.images = []; o.video = []; o.audio = []; o.link = null; o.ai = []; o.quote = null; o.voice = null; o.capture = null;
      if (o.xpost) o.xpost = Object.assign({}, o.xpost, { post: null });
    } else if (r18) {
      o.creator = Object.assign(o.creator || { counts, gated: false }, { r18: true });
    }
  }
  return outs;
}
/**
 * /media/f/<file>: may this viewer have this file? a = the attachment row joined with its post (author_id ...).
 * -> {allow, private}. Teasers: anyone who passes the 18+ gate. Locked originals: entitled viewers only.
 */
async function mediaGate(viewer, a) {
  if (!a || !a.post_id) return { allow: true, private: false };
  await init();
  const p = (await getQuery("SELECT id, author_id, home_pad, lock_kind, lock_tier, lock_rating FROM feed_posts WHERE id = ?", [a.post_id]).catch(() => []))[0];
  if (!p) return { allow: true, private: false };
  const vid = viewer && viewer.userId;
  const staff = can(viewer, "feed.see_hidden");
  let r18 = p.lock_rating === "r18" || isR18Room(p.home_pad);
  if (!r18) r18 = (await getQuery("SELECT room_id FROM feed_post_rooms WHERE post_id = ? AND removed_at IS NULL", [p.id])).some((x) => isR18Room(x.room_id));
  if (!p.lock_kind && !r18) return { allow: true, private: false };
  if (staff || (vid && vid === p.author_id)) return { allow: true, private: true };
  if (r18 && !(await attested(vid))) return { allow: false, private: true };
  if (!p.lock_kind || a.kind === "teaser") return { allow: true, private: true };
  const R = p.home_pad ? require("./rooms").getCached(p.home_pad) : null;
  if (vid && R && R.owner && R.owner.userId === vid && !require("./rooms").isProfile(R.id)) return { allow: true, private: true };
  if (!vid) return { allow: false, private: true };
  const tier = (await liveTiers(vid, [p.author_id])).get(p.author_id) || 0;
  if (p.lock_kind === "sub" && tier >= (Number(p.lock_tier) || 1)) return { allow: true, private: true };
  if (p.lock_kind === "ppv") {
    if (p.lock_tier && tier >= Number(p.lock_tier)) return { allow: true, private: true };
    if ((await getQuery("SELECT 1 AS x FROM creator_unlocks WHERE fan_id = ? AND post_id = ? AND state = 'active'", [vid, p.id])).length) return { allow: true, private: true };
  }
  return { allow: false, private: true };
}

// ── money ──
/** Linked accounts (welcome_bonus.dup_of either way): a purchase between them is allowed but neutralised (no rank). */
async function linked(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const r = await getQuery("SELECT 1 AS x FROM welcome_bonus WHERE (userId = ? AND dup_of = ?) OR (userId = ? AND dup_of = ?) LIMIT 1", [a, b, b, a]).catch(() => []);
  return r.length > 0;
}
async function capCheck(fanId, creatorId, amount, kind) {
  const C = CONFIG;
  const since = now() - DAY;
  const day = Number((await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM creator_ledger WHERE fan_id = ? AND created > ? AND state != 'refunded'", [fanId, since]))[0].t) || 0;
  if (C.fan_daily_max && day + amount > C.fan_daily_max) throw new Refuse(429, `That's over your daily ${NAME} limit (${fmt(C.fan_daily_max)} PAT a day).`, "E_CAP");
  if (kind === "ppv" && C.pair_daily_max) {
    const pair = Number((await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM creator_ledger WHERE fan_id = ? AND creator_id = ? AND kind = 'ppv' AND created > ? AND state != 'refunded'",
                                        [fanId, creatorId, since]))[0].t) || 0;
    if (pair + amount > C.pair_daily_max) throw new Refuse(429, `That's over the daily limit for one creator (${fmt(C.pair_daily_max)} PAT a day).`, "E_CAP");
  }
}
async function needLive() {
  if (!(await escrowLive())) throw new Refuse(423, `Purchases on ${NAME} open once the PAT escrow is live on this site.`, "E_ESCROW_NOT_LIVE");
}
/** In the open transaction: the fan's PAT into a new escrow hold + its creator_ledger row. -> ledger row id */
async function chargeInTx({ ref, kind, fan, creator, amount, subId = null, postId = null, roomId = null, periodFrom = null, periodTo = null, note = null }) {
  const esc = ESC();
  const account = await esc.accountFor({ userId: fan.userId });
  const eref = `${kind === "ppv" ? KIND_PPV : KIND_SUB}-${crypto.randomBytes(5).toString("hex")}`;
  const h = await esc.holdInTx({ key: "cr:" + ref, hid: null, account, amount, ref: eref, reason: kind === "ppv" ? "creator unlock" : "creator subscription",
                                 cp: creator.username, via: "site" });
  const share = Math.floor(amount * CONFIG.creator_pct / 100);
  const t = now();
  const ins = await runQuery(`INSERT INTO creator_ledger (ref, kind, fan_id, creator_id, sub_id, post_id, room_id, amount, creator_share, cut, hold_id, escrow_ref, state, release_at,
                              linked, period_from, period_to, note, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?, ?, ?, ?, ?)`,
                             [ref, kind, fan.userId, creator.userId, subId, postId, roomId, amount, share, amount - share, h.hid, eref, t + CONFIG.hold_days * DAY,
                              (await linked(fan.userId, creator.userId)) ? 1 : 0, periodFrom, periodTo, note, t]);
  return ins.id;
}
const balanceOf = async (userId) => Number(((await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [userId]))[0] || {}).b) || 0;
async function priorResult(ref) {
  const r = (await getQuery("SELECT * FROM creator_ledger WHERE ref = ?", [ref]))[0];
  return r || null;
}
function checkKey(k) {
  const s = String(k || "");
  if (!KEY_RE.test(s)) throw new Refuse(400, "Bad request (key).", "E_BAD_KEY");
  return s;
}
/** The price check the buyer saw (the modal's / Pepe's quote): a changed price refuses instead of charging something else. */
function checkExpect(expect, price) {
  if (expect === undefined || expect === null || expect === "") return;
  if (Math.floor(Number(expect)) !== price) throw new Refuse(409, `The price changed to ${fmt(price)} PAT - check it and try again.`, "E_PRICE_CHANGED");
}

/** A tier's price for a fan -> {creator, plan, ...} or a refusal (also used for quotes). */
async function offer(fanUser, creatorName, tierIn) {
  await init();
  if (!CONFIG.enabled) throw new Refuse(423, `${NAME} isn't open yet.`, "E_FEATURE_OFF");
  const cu = typeof creatorName === "object" && creatorName && creatorName.userId ? creatorName : await userByName(creatorName);
  if (!cu || !isActiveCreator(cu.userId)) throw new Refuse(404, "That account isn't an active creator.", "E_NOT_CREATOR");
  const plans = await plansOf(cu.userId);
  if (!plans.length) throw new Refuse(404, "That creator hasn't set up tiers yet.", "E_PLANS");
  const tier = Math.floor(Number(tierIn)) || plans[0].tier;
  const plan = plans.find((p) => p.tier === tier);
  if (!plan) throw new Refuse(400, `Pick a tier: ${plans.map((p) => `${p.tier} (${p.name})`).join(", ")}.`, "E_TIER");
  const c = await creatorRow(cu.userId);
  return { creator: { userId: cu.userId, username: cu.username, rating: c.rating }, plan, plans, period_days: CONFIG.period_days };
}
/**
 * Subscribe: {creator, tier, renew, pad, expect, key, gift?}. ONE transaction: hold + ledger + sub row. Idempotent by key.
 * -> {ok, sub_id, paid_through, price, balance, dup?}
 */
async function subscribe(fanUser, input = {}) {
  await init();
  if (!fanUser || !fanUser.userId) throw new Refuse(401, "Sign in first.");
  const key = checkKey(input.key);
  const ref = `sub:${fanUser.userId}:${key}`;
  const prev = await priorResult(ref);
  if (prev) return { ok: true, dup: true, sub_id: prev.sub_id, price: prev.amount, paid_through: prev.period_to, balance: await balanceOf(fanUser.userId) };
  const o = await offer(fanUser, input.creator, input.tier);
  if (o.creator.userId === fanUser.userId) throw new Refuse(400, "You can't subscribe to yourself.", "E_SELF");
  if (o.creator.rating === "r18" && !(await attested(fanUser.userId))) throw new Refuse(403, "This is 18+ content - confirm you're 18 or older first.", "E_AGE");
  checkExpect(input.expect, o.plan.price);
  await needLive();
  const fan = await userRow(fanUser.userId);
  const roomId = input.pad ? await padRoomFor(input.pad) : null;
  const renew = !(input.renew === false || input.renew === "0" || input.renew === 0);
  const out = await tx(async () => {
    if (await priorResult(ref)) return { dup: true };
    const live = (await getQuery("SELECT * FROM creator_subs WHERE fan_id = ? AND creator_id = ? AND status IN ('active','grace')", [fan.userId, o.creator.userId]))[0];
    if (live) throw new Refuse(409, `You already subscribe to ${o.creator.username} (tier ${live.tier}). Change tier from your subscriptions.`, "E_ALREADY");
    const n = (await getQuery("SELECT COUNT(*) AS n FROM creator_subs WHERE fan_id = ? AND status IN ('active','grace')", [fan.userId]))[0].n;
    if (n >= CONFIG.fan_max_subs) throw new Refuse(429, `At most ${CONFIG.fan_max_subs} creator subscriptions at a time.`, "E_CAP");
    await capCheck(fan.userId, o.creator.userId, o.plan.price, "sub");
    const t = now();
    const until = t + CONFIG.period_days * DAY;
    const ins = await runQuery(`INSERT INTO creator_subs (fan_id, creator_id, tier, price, status, paid_through, renew, room_id, created, updated)
                                VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`, [fan.userId, o.creator.userId, o.plan.tier, o.plan.price, until, renew ? 1 : 0, roomId, t, t]);
    await chargeInTx({ ref, kind: "sub", fan, creator: o.creator, amount: o.plan.price, subId: ins.id, roomId, periodFrom: t, periodTo: until });
    return { sub_id: ins.id, paid_through: until };
  }).catch((e) => { throw mapEscrow(e); });
  if (out.dup) return subscribe(fanUser, input);
  await notify(o.creator.userId, { title: `⭐ ${fan.username} subscribed (${o.plan.name})`, body: `${fmt(o.plan.price)} PAT, held ${CONFIG.hold_days} days then released to you.`, ref: `cr-newsub:${out.sub_id}` });
  console.log(`[creators] ${fan.username} subscribed to ${o.creator.username} tier ${o.plan.tier} (${o.plan.price} PAT, sub #${out.sub_id})`);
  return { ok: true, sub_id: out.sub_id, price: o.plan.price, tier: o.plan.tier, tierName: o.plan.name, paid_through: out.paid_through, renew, balance: await balanceOf(fan.userId) };
}
function mapEscrow(e) {
  if (e && e.code === "E_INSUFFICIENT_PAT") return new Refuse(402, "You don't have enough PAT for that.", "E_INSUFFICIENT_PAT");
  return e;
}
async function padRoomFor(pad) {
  const rooms = require("./rooms");
  const s = String(pad || "").slice(0, 128);
  const R = (await rooms.get(s).catch(() => null)) || (await rooms.bySlug(s).catch(() => null));
  return R && !rooms.isProfile(R.id) ? R.id : null;
}
/** Pay-per-view unlock: {post, expect, key}. -> {ok, price, balance} */
async function unlock(fanUser, input = {}) {
  await init();
  if (!fanUser || !fanUser.userId) throw new Refuse(401, "Sign in first.");
  if (!CONFIG.enabled) throw new Refuse(423, `${NAME} isn't open yet.`, "E_FEATURE_OFF");
  const key = checkKey(input.key);
  const ref = `ppv:${fanUser.userId}:${key}`;
  if (await priorResult(ref)) return { ok: true, dup: true, balance: await balanceOf(fanUser.userId) };
  const p = (await getQuery("SELECT * FROM feed_posts WHERE id = ?", [String(input.post || "")]))[0];
  if (!p || p.deleted_at || p.hidden_at || p.lock_kind !== "ppv") throw new Refuse(404, "No such locked post.", "E_NOT_FOUND");
  if (p.author_id === fanUser.userId) throw new Refuse(400, "It's your own post.", "E_SELF");
  if (!isActiveCreator(p.author_id)) throw new Refuse(409, "That creator isn't selling right now.", "E_PAUSED");
  const r18 = p.lock_rating === "r18" || isR18Room(p.home_pad);
  if (r18 && !(await attested(fanUser.userId))) throw new Refuse(403, "This is 18+ content - confirm you're 18 or older first.", "E_AGE");
  if (!(await require("./feedstore").postSeenBy(fanUser, p))) throw new Refuse(404, "No such locked post.", "E_NOT_FOUND");
  const creator = await userRow(p.author_id);
  const tier = (await liveTiers(fanUser.userId, [p.author_id])).get(p.author_id) || 0;
  if (p.lock_tier && tier >= Number(p.lock_tier)) return { ok: true, free: true, balance: await balanceOf(fanUser.userId) };
  const plans = await plansOf(p.author_id);
  const disc = tier ? ((plans.find((x) => x.tier === tier) || {}).perks || {}).ppv_discount || 0 : 0;
  const price = Math.max(CONFIG.ppv_min, Math.floor(Number(p.lock_price) * (100 - disc) / 100));
  checkExpect(input.expect, price);
  await needLive();
  const fan = await userRow(fanUser.userId);
  const roomId = p.home_pad && !require("./rooms").isProfile(p.home_pad) ? p.home_pad : null;
  const out = await tx(async () => {
    if (await priorResult(ref)) return { dup: true };
    const had = (await getQuery("SELECT state FROM creator_unlocks WHERE fan_id = ? AND post_id = ?", [fan.userId, p.id]))[0];
    if (had && had.state === "active") throw new Refuse(409, "You already unlocked this post.", "E_ALREADY");
    await capCheck(fan.userId, p.author_id, price, "ppv");
    const lid = await chargeInTx({ ref, kind: "ppv", fan, creator: { userId: creator.userId, username: creator.username }, amount: price, postId: p.id, roomId });
    await runQuery(`INSERT INTO creator_unlocks (fan_id, post_id, creator_id, price, ledger_id, state, created) VALUES (?, ?, ?, ?, ?, 'active', ?)
                    ON CONFLICT(fan_id, post_id) DO UPDATE SET price = excluded.price, ledger_id = excluded.ledger_id, state = 'active', created = excluded.created`,
                   [fan.userId, p.id, creator.userId, price, lid, now()]);
    return { lid };
  }).catch((e) => { throw mapEscrow(e); });
  if (!out.dup) {
    await notify(creator.userId, { title: `⭐ ${fan.username} unlocked "${cleanLine(p.title, 60)}"`, body: `${fmt(price)} PAT, held ${CONFIG.hold_days} days then released to you.`, ref: `cr-ppv:${out.lid}` });
    console.log(`[creators] ${fan.username} unlocked post ${p.id} of ${creator.username} (${price} PAT)`);
  }
  return { ok: true, price, balance: await balanceOf(fan.userId) };
}
/** Quote for the purchase modal / Pepe: {creator, tier} or {post}. */
async function quote(fanUser, input = {}) {
  await init();
  const bal = fanUser && fanUser.userId ? await balanceOf(fanUser.userId) : null;
  const age = fanUser && fanUser.userId ? await attested(fanUser.userId) : false;
  const live = await escrowLive();
  if (input.post) {
    const p = (await getQuery("SELECT * FROM feed_posts WHERE id = ?", [String(input.post)]))[0];
    if (!p || p.deleted_at || !p.lock_kind) throw new Refuse(404, "No such locked post.");
    const cu = await userRow(p.author_id);
    const tier = fanUser && fanUser.userId ? (await liveTiers(fanUser.userId, [p.author_id])).get(p.author_id) || 0 : 0;
    const plans = await plansOf(p.author_id);
    const disc = tier ? ((plans.find((x) => x.tier === tier) || {}).perks || {}).ppv_discount || 0 : 0;
    const price = p.lock_kind === "ppv" ? Math.max(CONFIG.ppv_min, Math.floor(Number(p.lock_price) * (100 - disc) / 100)) : null;
    return { ok: true, kind: p.lock_kind, post: p.id, title: p.title, creator: cu ? cu.username : null, price, discount: disc, plans, tier: p.lock_tier,
             yourTier: tier, balance: bal, r18: p.lock_rating === "r18" || isR18Room(p.home_pad), attested: age, live, confirmOver: CONFIG.confirm_over,
             holdDays: CONFIG.hold_days, periodDays: CONFIG.period_days };
  }
  const o = await offer(fanUser, input.creator, input.tier);
  const cur = fanUser && fanUser.userId ? (await getQuery("SELECT id, tier, status, paid_through FROM creator_subs WHERE fan_id = ? AND creator_id = ? AND status IN ('active','grace')",
                                                           [fanUser.userId, o.creator.userId]))[0] || null : null;
  return { ok: true, kind: "sub", creator: o.creator.username, plan: o.plan, plans: o.plans, price: o.plan.price, balance: bal, r18: o.creator.rating === "r18", attested: age,
           live, current: cur, confirmOver: CONFIG.confirm_over, renewsOn: now() + CONFIG.period_days * DAY, holdDays: CONFIG.hold_days, periodDays: CONFIG.period_days };
}

// ── subscription lifecycle ──
async function mustOwnSub(user, id) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const s = (await getQuery("SELECT * FROM creator_subs WHERE id = ?", [Number(id) || 0]))[0];
  if (!s || s.fan_id !== user.userId) throw new Refuse(404, "No such subscription.");
  return s;
}
async function cancel(user, id) {
  const s = await mustOwnSub(user, id);
  const t = now();
  if (s.status === "grace") {
    await runQuery("UPDATE creator_subs SET status = 'ended', cancel_at_end = 1, ended_at = ?, updated = ? WHERE id = ? AND status = 'grace'", [t, t, s.id]);
    return { ok: true, ends: t };
  }
  if (s.status !== "active") throw new Refuse(409, "It isn't running.");
  await runQuery("UPDATE creator_subs SET cancel_at_end = 1, updated = ? WHERE id = ?", [t, s.id]);
  return { ok: true, ends: Number(s.paid_through) };
}
async function resume(user, id) {
  const s = await mustOwnSub(user, id);
  if (s.status !== "active" || !s.cancel_at_end || Number(s.paid_through) <= now()) throw new Refuse(409, "It can't be resumed - subscribe again instead.");
  await runQuery("UPDATE creator_subs SET cancel_at_end = 0, updated = ? WHERE id = ?", [now(), s.id]);
  return { ok: true };
}
async function setRenew(user, id, on) {
  const s = await mustOwnSub(user, id);
  if (s.comp) throw new Refuse(409, "A complimentary month doesn't renew.");
  await runQuery("UPDATE creator_subs SET renew = ?, updated = ? WHERE id = ?", [on ? 1 : 0, now(), s.id]);
  return { ok: true, renew: !!on };
}
async function payNow(user, id) {
  const s = await mustOwnSub(user, id);
  if (s.status !== "grace") throw new Refuse(409, "Nothing to pay right now.");
  const r = await renewOne(s, now(), { force: true });
  if (r !== "renewed") throw new Refuse(402, "Your balance still doesn't cover it.", "E_INSUFFICIENT_PAT");
  return { ok: true };
}
/**
 * Change tier. Up: pay the prorated difference now (its own hold), the new tier applies at once. Down: from the next
 * renewal (next_tier). {tier, expect, key}
 */
async function changeTier(user, id, input = {}) {
  const s = await mustOwnSub(user, id);
  if (s.status !== "active") throw new Refuse(409, "Change tier while the subscription is active.");
  const tier = Math.floor(Number(input.tier));
  const plans = await plansOf(s.creator_id);
  const plan = plans.find((p) => p.tier === tier);
  if (!plan) throw new Refuse(400, "No such tier.");
  if (tier === s.tier) throw new Refuse(409, "That's your tier already.");
  if (tier < s.tier || s.comp) {
    await runQuery("UPDATE creator_subs SET next_tier = ?, updated = ? WHERE id = ?", [tier, now(), s.id]);
    return { ok: true, from: "renewal", tier };
  }
  const key = checkKey(input.key);
  const ref = `up:${user.userId}:${key}`;
  if (await priorResult(ref)) return { ok: true, dup: true };
  const t = now();
  const left = Math.max(0, Number(s.paid_through) - t);
  const diff = Math.max(1, Math.ceil((plan.price - Number(s.price)) * left / (CONFIG.period_days * DAY)));
  checkExpect(input.expect, diff);
  await needLive();
  const fan = await userRow(user.userId);
  const cu = await userRow(s.creator_id);
  await tx(async () => {
    if (await priorResult(ref)) return;
    await capCheck(fan.userId, cu.userId, diff, "sub");
    const u = await runQuery("UPDATE creator_subs SET tier = ?, price = ?, next_tier = NULL, updated = ? WHERE id = ? AND status = 'active' AND tier = ?", [tier, plan.price, t, s.id, s.tier]);
    if (!u.changes) throw new Refuse(409, "The subscription changed - reload and try again.");
    await chargeInTx({ ref, kind: "upgrade", fan, creator: { userId: cu.userId, username: cu.username }, amount: diff, subId: s.id, roomId: s.room_id,
                       periodFrom: t, periodTo: Number(s.paid_through), note: `tier ${s.tier} -> ${tier}` });
  }).catch((e) => { throw mapEscrow(e); });
  return { ok: true, tier, charged: diff, balance: await balanceOf(fan.userId) };
}
/** One due subscription. -> renewed | grace | lapsed | ended | dup | skip */
async function renewOne(s, t = now(), { force = false } = {}) {
  if (!s || !["active", "grace"].includes(s.status)) return "skip";
  if (!force && Number(s.paid_through) > t) return "skip";
  const end = async (status, title, body) => {
    const c = await runQuery(`UPDATE creator_subs SET status = ?, ended_at = ?, updated = ? WHERE id = ? AND status IN ('active','grace')`, [status, t, t, s.id]);
    if (c.changes && title) await notify(s.fan_id, { title, body, link: "/subscriptions#creators", ref: `cr-${status}:${s.id}:${s.paid_through}` });
    return status;
  };
  const cu = await userRow(s.creator_id);
  if (s.cancel_at_end || s.comp || !s.renew) return end("ended", `⭐ Your subscription to ${cu ? cu.username : "a creator"} ended`, "Its paid time is over. Subscribe again any time.");
  if (!isActiveCreator(s.creator_id) || !cu) return end("ended", "⭐ A creator subscription ended", "The creator isn't active any more, so it stopped renewing. Nothing more was charged.");
  const plans = await plansOf(s.creator_id);
  const tier = s.next_tier && plans.some((p) => p.tier === Number(s.next_tier)) ? Number(s.next_tier) : Number(s.tier);
  const plan = plans.find((p) => p.tier === tier);
  if (!plan) return end("lapsed", `⭐ Your subscription to ${cu.username} ended`, "That tier isn't offered any more, so it stopped renewing. Nothing more was charged.");
  if (!(await escrowLive())) return "skip";
  const fan = await userRow(s.fan_id);
  if (!fan) return end("ended", null, null);
  const ref = `renew:${s.id}:${s.paid_through}`;
  if (await priorResult(ref)) return "dup";
  const next = Number(s.paid_through) + CONFIG.period_days * DAY;
  const graceEnd = Number(s.paid_through) + CONFIG.grace_days * DAY;
  try {
    const done = await tx(async () => {
      if (await priorResult(ref)) return false;
      const u = await runQuery(`UPDATE creator_subs SET status = 'active', paid_through = ?, grace_until = NULL, tier = ?, price = ?, next_tier = NULL, renewals = renewals + 1,
                                notified = NULL, updated = ? WHERE id = ? AND paid_through = ? AND status IN ('active','grace') AND cancel_at_end = 0`,
                               [next, tier, plan.price, t, s.id, s.paid_through]);
      if (!u.changes) return false;
      await capCheck(fan.userId, cu.userId, plan.price, "sub");
      await chargeInTx({ ref, kind: "renew", fan, creator: { userId: cu.userId, username: cu.username }, amount: plan.price, subId: s.id, roomId: s.room_id,
                         periodFrom: Number(s.paid_through), periodTo: next });
      return true;
    });
    if (!done) return "dup";
  } catch (e) {
    const err = mapEscrow(e);
    if (!(err && (err.code === "E_INSUFFICIENT_PAT" || err.code === "E_CAP"))) { console.error(`[creators] renew #${s.id}:`, e.message); return "skip"; }
    if (t >= graceEnd) return end("lapsed", `⭐ Your subscription to ${cu.username} ended`, `The renewal (${fmt(plan.price)} PAT) couldn't be paid within the ${CONFIG.grace_days}-day grace. Subscribe again any time.`);
    const k = "grace:" + s.paid_through;
    if (s.notified !== k) {
      await runQuery("UPDATE creator_subs SET status = 'grace', grace_until = ?, notified = ?, updated = ? WHERE id = ?", [graceEnd, k, t, s.id]);
      await notify(s.fan_id, { title: `⭐ Your subscription to ${cu.username} couldn't renew`, link: "/subscriptions#creators",
                               body: `It costs ${fmt(plan.price)} PAT. You keep access until ${new Date(graceEnd).toISOString().slice(0, 10)} - top up and it renews by itself.`, ref: `cr-grace:${s.id}:${s.paid_through}` });
    }
    return "grace";
  }
  await notify(cu.userId, { title: `⭐ ${fan.username} renewed (${plan.name})`, body: `${fmt(plan.price)} PAT, held ${CONFIG.hold_days} days then released to you.`, ref: `cr-renew:${s.id}:${s.paid_through}` });
  return "renewed";
}
let renewing = null;
function renewDue(t = now()) {
  if (renewing) return renewing;
  renewing = (async () => {
    await init();
    const out = { renewed: 0, grace: 0, lapsed: 0, ended: 0 };
    for (const s of await getQuery("SELECT * FROM creator_subs WHERE status IN ('active','grace') AND paid_through <= ? ORDER BY paid_through LIMIT 500", [t])) {
      const r = await renewOne(s, t).catch((e) => { console.error(`[creators] renew #${s.id}:`, e.message); return "skip"; });
      if (out[r] != null) out[r]++;
    }
    // renewal reminders, 3 days ahead (once per period)
    for (const s of await getQuery(`SELECT s.*, u.username AS cname FROM creator_subs s LEFT JOIN users u ON u.userId = s.creator_id
                                    WHERE s.status = 'active' AND s.cancel_at_end = 0 AND s.renew = 1 AND s.comp = 0 AND s.paid_through > ? AND s.paid_through <= ? LIMIT 500`,
                                   [t, t + 3 * DAY])) {
      await notify(s.fan_id, { title: `⭐ Your subscription to ${s.cname || "a creator"} renews soon`, link: "/subscriptions#creators",
                               body: `${fmt(s.price)} PAT on ${new Date(Number(s.paid_through)).toISOString().slice(0, 10)}. Cancel any time before then.`, ref: `cr-soon:${s.id}:${s.paid_through}` });
    }
    if (out.renewed || out.grace || out.lapsed || out.ended) console.log("[creators] renewals:", JSON.stringify(out));
    return out;
  })().finally(() => { renewing = null; });
  return renewing;
}

// ── release (D5, D8) ──
/** In the open transaction: the 20% cut as reserve claims (premium's "creators" routing row + the D3 royalty). */
async function routeCutInTx(cut, { roomId, creatorId, fanId, ref, base }) {
  if (!(cut > 0)) return [];
  const { v4: uuidv4 } = require("uuid");
  const funding = require("./funding");
  const P = require("./premium");
  const rooms = require("./rooms");
  const routes = (P.config().routes || {}).creators || [["fortknox", 50], ["room", 50]];
  const parts = P.splitRoute(routes, cut);
  // 2026-10-12 (the user): a creator's OWN PROFILE has a vault once profile vaults are on - the whole platform cut of a
  // purchase made there goes into it (it pays out through the profile recipe) instead of Fort Knox. Never the fan's own
  // profile, never the creator buying from themselves or their alt (the fan's dup_of / shared device -> Fort Knox).
  if (roomId && rooms.isProfile(roomId) && roomId === rooms.profileId(creatorId) && fanId && fanId !== creatorId && funding.roomVaultsLive()
      && (await require("./boosts").vaultEligible(roomId).catch(() => false))) {
    const alt = (await require("./engagement").altPairs([fanId, creatorId]).catch(() => new Set())).has(fanId + "|" + creatorId);
    if (!alt) {
      await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES (?, ?, ?, ?, ?)",
                     [uuidv4(), `room:creators:${roomId}`, fanId, "creators cut: profile vault", -cut]);
      return [{ flow: `room:creators:${roomId}`, dest: "room", amount: cut }];
    }
  }
  const R = roomId && !rooms.isProfile(roomId) ? rooms.getCached(roomId) : null;
  const ownerId = R && R.owner && R.owner_kind === "user" ? R.owner.userId : (R && R.owner ? R.owner.userId : null);
  const self = !R || !ownerId || ownerId === creatorId || ownerId === fanId;
  const vaultOk = !!R && !self && funding.roomVaultsLive() && (await require("./boosts").vaultEligible(R.id).catch(() => false));
  let fk = 0, room = 0, reserve = 0;
  for (const p of parts) {
    if (p.dest === "room") room += p.amount;
    else if (p.dest === "fortknox") fk += p.amount;
    else reserve += p.amount;
  }
  let royalty = 0;
  // E-4: after the royalty cutover the whole room half is room-vault income (the owner is paid by the recipe)
  const royFrozen = (() => { try { return !!require("./royalties").frozen(); } catch (e) { return false; } })();
  if (room > 0 && R && !self && ownerId && CONFIG.royalty_pct > 0 && !royFrozen) royalty = Math.floor(room * CONFIG.royalty_pct / 100);
  room -= royalty;
  if (!vaultOk) { fk += room; room = 0; }
  const fkFlow = funding.fortknoxLive() ? "fortknox:creators" : "creators";
  const legs = [];
  if (fk > 0) legs.push({ flow: fkFlow, dest: "fortknox", amount: fk });
  if (room > 0) legs.push({ flow: `room:creators:${R.id}`, dest: "room", amount: room });
  if (reserve + royalty > 0) legs.push({ flow: "creators", dest: "reserve", amount: reserve + royalty });
  for (const l of legs) {
    await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES (?, ?, ?, ?, ?)",
                   [uuidv4(), l.flow, fanId || null, `creators cut: ${l.dest}`.slice(0, 120), -l.amount]);
  }
  if (royalty > 0) {
    const got = await require("./royalties").accrue({ room_id: R.id, source: "spend", category: "creators", amount: royalty, base, payer: fanId, ref: "creators:" + ref,
                                                      detail: "PATV Creators royalty" }).catch(() => 0);
    legs.push({ royalty: got });
  }
  return legs;
}
async function releaseOne(row, t = now()) {
  const res = await tx(async () => {
    const r = (await getQuery("SELECT * FROM creator_ledger WHERE id = ? AND state = 'held' AND frozen = 0", [row.id]))[0];
    if (!r) return null;
    const fan = await userRow(r.fan_id);
    const legs = [];
    await ESC().settleInTx({ key: "crel:" + r.id, hids: [r.hold_id], ref: r.escrow_ref,
                             payouts: [{ userId: r.creator_id, amount: r.creator_share, reason: "creator earnings", cp: fan ? fan.username : undefined }], fees: [] });
    legs.push(...(await routeCutInTx(r.cut, { roomId: r.room_id, creatorId: r.creator_id, fanId: r.fan_id, ref: String(r.id), base: r.amount })));
    const u = await runQuery("UPDATE creator_ledger SET state = 'released', released_at = ? WHERE id = ? AND state = 'held'", [t, r.id]);
    if (!u.changes) throw new Refuse(409, "changed under us");
    return { id: r.id, creator: r.creator_id, share: r.creator_share, legs };
  });
  return res;
}
let releasing = null;
/** Every hold past its hold window (not frozen, creator active, under the weekly cap). -> {released, held_back, amount} */
function releaseDue(t = now()) {
  if (releasing) return releasing;
  releasing = (async () => {
    await init();
    const out = { released: 0, capped: 0, paused: 0, amount: 0 };
    const rows = await getQuery("SELECT * FROM creator_ledger WHERE state = 'held' AND frozen = 0 AND release_at <= ? ORDER BY release_at, id LIMIT 1000", [t]);
    const wk = weekStart(t);
    const weekSum = new Map();
    const paidTo = new Map();
    for (const r of rows) {
      const c = ACTIVE.get(r.creator_id);
      if (!c || c.status !== "active") { out.paused++; continue; }
      if (!weekSum.has(r.creator_id)) {
        weekSum.set(r.creator_id, Number((await getQuery("SELECT COALESCE(SUM(creator_share),0) AS s FROM creator_ledger WHERE creator_id = ? AND state = 'released' AND released_at >= ?",
                                                          [r.creator_id, wk]))[0].s) || 0);
      }
      if (CONFIG.release_cap_week && weekSum.get(r.creator_id) + r.creator_share > CONFIG.release_cap_week) {
        if (!paidTo.has("cap:" + r.creator_id)) {
          paidTo.set("cap:" + r.creator_id, 1);
          await notify(r.creator_id, { title: "⭐ Weekly release cap reached", body: `${fmt(CONFIG.release_cap_week)} PAT a week is released to you; the rest stays held and is released next week. Nothing is lost.`,
                                       ref: `cr-cap:${r.creator_id}:${wk}` });
        }
        out.capped++; continue;
      }
      try {
        const done = await releaseOne(r, t);
        if (done) {
          out.released++; out.amount += done.share;
          weekSum.set(r.creator_id, weekSum.get(r.creator_id) + done.share);
          paidTo.set(r.creator_id, (paidTo.get(r.creator_id) || 0) + done.share);
        }
      } catch (e) { console.error(`[creators] release #${r.id}:`, e.message); }
    }
    for (const [cid, amt] of paidTo) {
      if (cid.startsWith("cap:")) continue;
      await notify(cid, { title: `⭐ ${fmt(amt)} PAT of creator earnings released`, body: "It's in your wallet now.", ref: `cr-rel:${cid}:${Math.floor(t / 3600000)}` });
      try { require("./achievements").poke(cid); } catch (e) { /* optional */ }
    }
    if (out.released || out.capped) console.log("[creators] release:", JSON.stringify(out));
    return out;
  })().finally(() => { releasing = null; });
  return releasing;
}

// ── refunds, disputes, clawbacks ──
/** Refund one UNRELEASED ledger row (the whole amount goes back to the fan). -> true | false (not held any more) */
async function refundLedger(id, why, actor) {
  await init();
  const done = await tx(async () => {
    const r = (await getQuery("SELECT * FROM creator_ledger WHERE id = ? AND state = 'held'", [Number(id) || 0]))[0];
    if (!r) return null;
    await ESC().refundInTx({ key: "cref:" + r.id, hid: r.hold_id, reason: "creator refund" });
    const t = now();
    await runQuery("UPDATE creator_ledger SET state = 'refunded', refunded_at = ?, note = ? WHERE id = ? AND state = 'held'", [t, cleanLine(`${why || "refund"} (${actor || "system"})`, 200), r.id]);
    if (r.kind === "ppv" && r.post_id) await runQuery("UPDATE creator_unlocks SET state = 'refunded' WHERE fan_id = ? AND post_id = ? AND ledger_id = ?", [r.fan_id, r.post_id, r.id]);
    if ((r.kind === "sub" || r.kind === "renew") && r.sub_id) {
      // the period it paid for is gone: the subscription ends now (no more renewals)
      await runQuery("UPDATE creator_subs SET status = 'ended', ended_at = ?, updated = ? WHERE id = ? AND status IN ('active','grace') AND paid_through = ?", [t, t, r.sub_id, r.period_to]);
    }
    await runQuery("UPDATE creator_disputes SET status = 'refunded', resolved_at = ?, resolved_by = ?, resolution = COALESCE(resolution, ?) WHERE ledger_id = ? AND status = 'open'",
                   [t, actor || "system", cleanLine(why, 200), r.id]);
    return r;
  });
  if (!done) return false;
  const cu = await userRow(done.creator_id);
  await notify(done.fan_id, { title: `⭐ Refund: ${fmt(done.amount)} PAT`, body: `Your ${done.kind === "ppv" ? "unlock" : "subscription payment"}${cu ? " to " + cu.username : ""} was refunded (${cleanLine(why, 120) || "refund"}).`,
                              link: "/subscriptions#creators", ref: `cr-refund:${done.id}` });
  console.log(`[creators] refunded ledger #${done.id} (${done.amount} PAT to ${done.fan_id}): ${why}`);
  return true;
}
/** Refund every unreleased purchase of a post (PPV unlocks). */
async function refundPost(postId, why, actor) {
  await init();
  let n = 0;
  for (const r of await getQuery("SELECT id FROM creator_ledger WHERE post_id = ? AND state = 'held'", [String(postId)])) {
    if (await refundLedger(r.id, why, actor).catch((e) => { console.error("[creators] refundPost:", e.message); return false; })) n++;
  }
  return n;
}
/** feedstore.remove's hook: a locked post was deleted (by its author or staff) -> refund its unreleased unlocks. */
async function onPostRemoved(postId, { byAuthor = false, actor = null } = {}) {
  try {
    await init();
    const p = (await getQuery("SELECT lock_kind FROM feed_posts WHERE id = ?", [String(postId)]))[0];
    if (!p || !p.lock_kind) return 0;
    return await refundPost(postId, byAuthor ? "the creator deleted the post" : "the post was removed by the staff", actor || (byAuthor ? "author" : "staff"));
  } catch (e) { console.error("[creators] onPostRemoved:", e.message); return 0; }
}
/**
 * Someone with moderation rights marked a LOCKED post NSFW / explicit (feedstore.adminSet / roomMod): the hard rule says
 * locked content can't be explicit, so the post is taken down and every unreleased purchase refunded. -> {takedown: true}
 */
async function takedownExplicit(actor, postId, where = "admin") {
  await init();
  const p = (await getQuery("SELECT * FROM feed_posts WHERE id = ?", [String(postId)]))[0];
  if (!p || !p.lock_kind) return null;
  const t = now();
  await runQuery("UPDATE feed_posts SET deleted_at = COALESCE(deleted_at, ?), deleted_by = COALESCE(deleted_by, ?), delete_reason = COALESCE(delete_reason, ?) WHERE id = ?",
                 [t, `${where}:${actor ? actor.username : "?"}`, "Locked content marked explicit (Creator Terms)", p.id]);
  await runQuery("DELETE FROM feed_mentions WHERE post_id = ? AND sent_at IS NULL", [p.id]).catch(() => {});
  const n = await refundPost(p.id, "locked content marked explicit", actor ? actor.username : where);
  await notify(p.author_id, { title: "⭐ A locked post was taken down", body: `"${cleanLine(p.title, 80)}" was marked explicit. Locked content must be safe for work (or R-rated on an 18+ profile or pad, never explicit). Buyers were refunded.`,
                              ref: "cr-explicit:" + p.id });
  await notifyStaff({ title: `⭐ Locked post marked explicit (${where})`, body: `"${cleanLine(p.title, 80)}" by ${p.author_id} - taken down, ${n} purchase(s) refunded. Review the creator.`, ref: "cr-explicit-staff:" + p.id });
  console.log(`[creators] locked post ${p.id} marked explicit by ${actor ? actor.username : where}: taken down, ${n} refund(s)`);
  return { takedown: true, refunded: n };
}
/** A fan reports a problem with a purchase inside the hold window: the hold is frozen until an admin decides. */
async function dispute(user, { ledger, reason, note } = {}) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const r = (await getQuery("SELECT * FROM creator_ledger WHERE id = ? AND fan_id = ?", [Number(ledger) || 0, user.userId]))[0];
  if (!r) throw new Refuse(404, "No such purchase.");
  if (r.state !== "held" || now() - Number(r.created) > CONFIG.dispute_days * DAY) throw new Refuse(409, "Problems can be reported while the payment is still held (the first days after paying).");
  const why = ["not_as_described", "empty", "harassment", "other"].includes(reason) ? reason : "other";
  const ins = await runQuery("INSERT OR IGNORE INTO creator_disputes (ledger_id, fan_id, creator_id, reason, note, created) VALUES (?, ?, ?, ?, ?, ?)",
                             [r.id, user.userId, r.creator_id, why, cleanLine(note, 500) || null, now()]);
  if (!ins.changes) return { ok: true, already: true };
  await runQuery("UPDATE creator_ledger SET frozen = 1 WHERE id = ?", [r.id]);
  await notify(r.creator_id, { title: "⭐ A buyer reported a problem", body: "That payment stays held until the staff look at it.", ref: `cr-disp-c:${ins.id}` });
  await notifyStaff({ title: "⭐ New creator dispute", body: `Ledger #${r.id}: ${why}.`, ref: `cr-disp:${ins.id}` });
  return { ok: true, id: ins.id };
}
/** Staff decision: refund (the whole hold back to the fan) or deny (unfreeze; it releases on schedule). */
async function resolveDispute(actor, id, { action, note } = {}) {
  await init();
  if (!can(actor, "creators.admin")) throw new Refuse(403, "Staff only.");
  const d = (await getQuery("SELECT * FROM creator_disputes WHERE id = ?", [Number(id) || 0]))[0];
  if (!d) throw new Refuse(404, "No such dispute.");
  if (d.status !== "open") throw new Refuse(409, "Already decided.");
  if (action === "refund") {
    await runQuery("UPDATE creator_ledger SET frozen = 0 WHERE id = ?", [d.ledger_id]);
    const ok = await refundLedger(d.ledger_id, cleanLine(note, 200) || "dispute upheld", actor.username);
    if (!ok) throw new Refuse(409, "That payment isn't held any more.");
  } else if (action === "deny") {
    await runQuery("UPDATE creator_disputes SET status = 'denied', resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ?", [now(), actor.username, cleanLine(note, 200) || null, d.id]);
    await runQuery("UPDATE creator_ledger SET frozen = 0 WHERE id = ? AND state = 'held'", [d.ledger_id]);
    await notify(d.fan_id, { title: "⭐ Your report about a purchase was reviewed", body: cleanLine(note, 200) || "The staff didn't find a reason to refund it.", ref: `cr-disp-deny:${d.id}` });
  } else throw new Refuse(400, "refund or deny");
  return { ok: true };
}
/**
 * D9: a reversed payment (a disputed donation) means PAT the fan spent here may have to come back. Held: refunded to the
 * fan's wallet (the staff then remove it with the usual tools). Released: clawed from the creator only when the two accounts
 * are linked; otherwise the platform absorbs it (recorded, nothing moves).
 */
async function clawback(actor, ledgerId, note) {
  await init();
  if (!can(actor, "creators.admin")) throw new Refuse(403, "Staff only.");
  const r = (await getQuery("SELECT * FROM creator_ledger WHERE id = ?", [Number(ledgerId) || 0]))[0];
  if (!r) throw new Refuse(404, "No such ledger row.");
  if (r.state === "held") { await runQuery("UPDATE creator_ledger SET frozen = 0 WHERE id = ?", [r.id]); await refundLedger(r.id, "clawback: " + (cleanLine(note, 120) || "reversed payment"), actor.username); return { ok: true, result: "refunded" }; }
  if (r.state !== "released") throw new Refuse(409, `It's ${r.state}.`);
  const isLinked = r.linked || (await linked(r.fan_id, r.creator_id));
  let taken = 0;
  if (isLinked) {
    const bal = await balanceOf(r.creator_id);
    taken = Math.min(bal, r.creator_share);
    if (taken > 0) {
      const L = require("./ledger");
      const d = await L.post(r.creator_id, -taken, "creator clawback", { requireCover: true, source: "creators", note: cleanLine(note, 80) || null });
      if (!d.ok) taken = 0;
    }
  }
  await runQuery("UPDATE creator_ledger SET state = 'clawed', note = ? WHERE id = ?", [cleanLine(`clawback by ${actor.username}: ${isLinked ? `${taken} taken from the linked creator` : "absorbed by the platform"} ${note || ""}`, 200), r.id]);
  return { ok: true, result: isLinked ? "clawed" : "absorbed", taken };
}

// ── the creator's tools ──
async function comp(creatorUser, { fan, tier } = {}) {
  await init();
  if (!isActiveCreator(creatorUser && creatorUser.userId)) throw new Refuse(403, "Creators only.");
  const fu = await userByName(fan);
  if (!fu) throw new Refuse(404, "No such account.");
  if (fu.userId === creatorUser.userId) throw new Refuse(400, "That's you.");
  const plans = await plansOf(creatorUser.userId);
  const plan = plans.find((p) => p.tier === (Math.floor(Number(tier)) || (plans[0] || {}).tier));
  if (!plan) throw new Refuse(400, "Pick one of your tiers.");
  const live = (await getQuery("SELECT * FROM creator_subs WHERE fan_id = ? AND creator_id = ? AND status IN ('active','grace')", [fu.userId, creatorUser.userId]))[0];
  if (live) throw new Refuse(409, `${fu.username} already subscribes.`);
  const t = now();
  const ins = await runQuery(`INSERT INTO creator_subs (fan_id, creator_id, tier, price, status, paid_through, renew, comp, created, updated) VALUES (?, ?, ?, 0, 'active', ?, 0, 1, ?, ?)`,
                             [fu.userId, creatorUser.userId, plan.tier, t + CONFIG.period_days * DAY, t, t]);
  await notify(fu.userId, { title: `⭐ ${creatorUser.username} gave you a month of ${plan.name}`, body: "Enjoy - it doesn't renew.", link: "/creators/" + encodeURIComponent(creatorUser.username), ref: `cr-comp:${ins.id}` });
  return { ok: true, sub_id: ins.id };
}
/** Remove a subscriber: the current period's unreleased payment is refunded and the subscription ends now. */
async function removeSub(creatorUser, subId) {
  await init();
  const s = (await getQuery("SELECT * FROM creator_subs WHERE id = ?", [Number(subId) || 0]))[0];
  if (!s || !creatorUser || s.creator_id !== creatorUser.userId) throw new Refuse(404, "No such subscriber.");
  let refunded = 0;
  for (const r of await getQuery("SELECT id FROM creator_ledger WHERE sub_id = ? AND state = 'held'", [s.id])) if (await refundLedger(r.id, "removed by the creator", creatorUser.username)) refunded++;
  const t = now();
  await runQuery("UPDATE creator_subs SET status = 'ended', ended_at = ?, updated = ? WHERE id = ? AND status IN ('active','grace')", [t, t, s.id]);
  return { ok: true, refunded };
}
/** An inbox notice to every live subscriber at or above `tier` (one a day). */
async function broadcast(creatorUser, { tier, title, body } = {}) {
  await init();
  if (!isActiveCreator(creatorUser && creatorUser.userId)) throw new Refuse(403, "Creators only.");
  const ti = cleanLine(title, 80), bo = cleanLine(body, 400);
  if (!ti) throw new Refuse(400, "Give it a title.");
  const day = Math.floor(now() / DAY);
  const k = `bcast:${creatorUser.userId}`;
  const last = (await getQuery("SELECT v FROM creator_kv WHERE k = ?", [k]))[0];
  if (last && Number(last.v) === day) throw new Refuse(429, "One message to subscribers a day.");
  await runQuery("INSERT INTO creator_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [k, String(day)]);
  const min = Math.max(1, Math.floor(Number(tier)) || 1);
  const fans = await getQuery("SELECT DISTINCT fan_id FROM creator_subs WHERE creator_id = ? AND status IN ('active','grace') AND tier >= ?", [creatorUser.userId, min]);
  for (const f of fans) await notify(f.fan_id, { title: `⭐ ${creatorUser.username}: ${ti}`, body: bo, link: "/creators/" + encodeURIComponent(creatorUser.username), ref: `cr-bc:${creatorUser.userId}:${day}` });
  return { ok: true, sent: fans.length };
}

// ── pages' data ──
async function publicView(username, viewer) {
  await init();
  const u = await userByName(username);
  if (!u) return null;
  const c = await creatorRow(u.userId);
  if (!c || !["active", "paused"].includes(c.status)) return null;
  const plans = await plansOf(u.userId);
  const subs = Number((await getQuery("SELECT COUNT(DISTINCT fan_id) AS n FROM creator_subs WHERE creator_id = ? AND status IN ('active','grace')", [u.userId]))[0].n) || 0;
  const posts = await getQuery("SELECT lock_kind, COUNT(*) AS n FROM feed_posts WHERE author_id = ? AND lock_kind IS NOT NULL AND deleted_at IS NULL GROUP BY lock_kind", [u.userId]).catch(() => []);
  const mine = viewer && viewer.userId ? (await getQuery("SELECT * FROM creator_subs WHERE fan_id = ? AND creator_id = ? AND status IN ('active','grace')", [viewer.userId, u.userId]))[0] || null : null;
  let avatarUrl = null;
  try { avatarUrl = require("./userlook").avatarOf(u.avatar) || null; } catch (e) { avatarUrl = null; }
  return { user: { userId: u.userId, username: u.username, displayname: u.displayname || u.username, avatarUrl }, status: c.status, rating: c.rating, bio: c.bio || "",
           plans, subscribers: subs, locked: Object.fromEntries(posts.map((p) => [p.lock_kind, p.n])), mine, periodDays: CONFIG.period_days };
}
async function fanSubs(userId) {
  await init();
  const rows = await getQuery(`SELECT s.*, u.username AS cname FROM creator_subs s LEFT JOIN users u ON u.userId = s.creator_id WHERE s.fan_id = ?
                               ORDER BY CASE WHEN s.status IN ('active','grace') THEN 0 ELSE 1 END, s.id DESC LIMIT 60`, [userId]);
  const out = [];
  for (const s of rows) {
    const all = await plansOf(s.creator_id, { all: true });
    const plan = all.find((p) => p.tier === s.tier);
    out.push({ plans: all.filter((p) => p.active).map((p) => ({ tier: p.tier, name: p.name, price: p.price })), id: s.id, creator: s.cname || "?", tier: s.tier, tierName: plan ? plan.name : `Tier ${s.tier}`, price: Number(s.price), status: s.status, renew: !!s.renew && !s.comp,
               cancel_at_end: !!s.cancel_at_end, comp: !!s.comp, paid_through: Number(s.paid_through), grace_until: s.grace_until ? Number(s.grace_until) : null,
               next_tier: s.next_tier || null, created: Number(s.created), ended_at: s.ended_at ? Number(s.ended_at) : null });
  }
  const buys = await getQuery(`SELECT l.id, l.kind, l.amount, l.state, l.created, l.release_at, l.frozen, l.post_id, u.username AS cname, p.title
                               FROM creator_ledger l LEFT JOIN users u ON u.userId = l.creator_id LEFT JOIN feed_posts p ON p.id = l.post_id
                               WHERE l.fan_id = ? ORDER BY l.id DESC LIMIT 30`, [userId]);
  const disputeUntil = CONFIG.dispute_days * DAY;
  return { subs: out, purchases: buys.map((b) => ({ ...b, canReport: b.state === "held" && !b.frozen && now() - Number(b.created) <= disputeUntil })), grace_days: CONFIG.grace_days };
}
async function dashboard(userId) {
  await init();
  const t = now();
  const c = await creatorRow(userId);
  if (!c) return null;
  const sum = async (sql, args) => Number(((await getQuery(sql, args))[0] || {}).s) || 0;
  const held = await sum("SELECT COALESCE(SUM(creator_share),0) AS s FROM creator_ledger WHERE creator_id = ? AND state = 'held'", [userId]);
  const frozen = await sum("SELECT COALESCE(SUM(creator_share),0) AS s FROM creator_ledger WHERE creator_id = ? AND state = 'held' AND frozen = 1", [userId]);
  const wk = weekStart(t);
  const releasedWeek = await sum("SELECT COALESCE(SUM(creator_share),0) AS s FROM creator_ledger WHERE creator_id = ? AND state = 'released' AND released_at >= ?", [userId, wk]);
  const released30 = await sum("SELECT COALESCE(SUM(creator_share),0) AS s FROM creator_ledger WHERE creator_id = ? AND state = 'released' AND released_at >= ?", [userId, t - 30 * DAY]);
  const releasedAll = await sum("SELECT COALESCE(SUM(creator_share),0) AS s FROM creator_ledger WHERE creator_id = ? AND state = 'released'", [userId]);
  const next = (await getQuery("SELECT MIN(release_at) AS t FROM creator_ledger WHERE creator_id = ? AND state = 'held' AND frozen = 0", [userId]))[0].t;
  // the next 7 days of releases (per day) and the last 30 days of earnings (per day, gross creator share by purchase day)
  const upcoming = [];
  for (let i = 0; i < 8; i++) {
    const a = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate()) + i * DAY;
    upcoming.push({ day: a, amount: await sum("SELECT COALESCE(SUM(creator_share),0) AS s FROM creator_ledger WHERE creator_id = ? AND state = 'held' AND frozen = 0 AND release_at >= ? AND release_at < ?", [userId, i ? a : 0, a + DAY]) });
  }
  const daily = await getQuery(`SELECT CAST((created / 86400000) AS INTEGER) AS d, SUM(creator_share) AS s, COUNT(*) AS n FROM creator_ledger
                                WHERE creator_id = ? AND created >= ? AND state != 'refunded' GROUP BY d ORDER BY d`, [userId, t - 30 * DAY]);
  const byTier = await getQuery(`SELECT tier, COUNT(*) AS n, SUM(CASE WHEN comp = 1 THEN 1 ELSE 0 END) AS comps FROM creator_subs WHERE creator_id = ? AND status IN ('active','grace') GROUP BY tier ORDER BY tier`, [userId]);
  const churn = Number((await getQuery("SELECT COUNT(*) AS n FROM creator_subs WHERE creator_id = ? AND status IN ('ended','lapsed') AND ended_at >= ?", [userId, t - 30 * DAY]))[0].n) || 0;
  const subs = await getQuery(`SELECT s.id, s.tier, s.status, s.comp, s.created, s.paid_through, s.renew, s.cancel_at_end, u.username,
                               (SELECT COALESCE(SUM(amount),0) FROM creator_ledger l WHERE l.sub_id = s.id AND l.state != 'refunded') AS spent
                               FROM creator_subs s LEFT JOIN users u ON u.userId = s.fan_id WHERE s.creator_id = ? AND s.status IN ('active','grace') ORDER BY s.created DESC LIMIT 200`, [userId]);
  const ppv = await getQuery(`SELECT p.id, p.title, p.lock_price, p.created, p.deleted_at, COUNT(l.id) AS sales, COALESCE(SUM(CASE WHEN l.state != 'refunded' THEN l.creator_share END),0) AS earned
                              FROM feed_posts p LEFT JOIN creator_ledger l ON l.post_id = p.id AND l.kind = 'ppv' WHERE p.author_id = ? AND p.lock_kind = 'ppv'
                              GROUP BY p.id ORDER BY p.created DESC LIMIT 50`, [userId]).catch(() => []);
  const tips = await sum(`SELECT COALESCE(SUM(points),0) AS s FROM transactions WHERE userId = ? AND type = 'tip received' AND timestamp >= datetime('now', '-30 days')`, [userId]).catch(() => 0);
  const disputes = await getQuery("SELECT d.*, l.amount, l.kind FROM creator_disputes d JOIN creator_ledger l ON l.id = d.ledger_id WHERE d.creator_id = ? ORDER BY d.id DESC LIMIT 20", [userId]);
  const pads = await getQuery("SELECT room_id, r18, allow_creators FROM creator_pads").catch(() => []);
  const owned = (await require("./rooms").ownedBy(userId).catch(() => [])) || [];
  return { creator: c, plans: await plansOf(userId, { all: true }), held, frozen, releasedWeek, released30, releasedAll, next: next ? Number(next) : null, upcoming,
           daily: daily.map((d) => ({ day: Number(d.d) * DAY, amount: Number(d.s) || 0, n: d.n })), byTier, churn, subs, ppv, tips, disputes,
           cap: CONFIG.release_cap_week, holdDays: CONFIG.hold_days, creatorPct: CONFIG.creator_pct,
           pads: owned.filter((r) => !require("./rooms").isProfile(r.id)).map((r) => { const f = pads.find((x) => x.room_id === r.id) || {}; return { id: r.id, slug: r.slug, title: r.title, r18: !!f.r18, allow_creators: !!f.allow_creators }; }),
           lockedMedia: await require("./imagesafety").lockedEnforcing(), escrowLive: await escrowLive() };
}
async function ledgerCsv(userId) {
  const rows = await getQuery(`SELECT l.id, l.created, l.kind, u.username AS fan, l.amount, l.creator_share, l.cut, l.state, l.release_at, l.released_at, l.refunded_at, l.post_id
                               FROM creator_ledger l LEFT JOIN users u ON u.userId = l.fan_id WHERE l.creator_id = ? ORDER BY l.id`, [userId]);
  const esc = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const iso = (v) => (v ? new Date(Number(v)).toISOString() : "");
  const lines = ["id,created,kind,fan,amount,your_share,platform_cut,state,release_at,released_at,refunded_at,post"];
  for (const r of rows) lines.push([r.id, iso(r.created), r.kind, r.fan, r.amount, r.creator_share, r.cut, r.state, iso(r.release_at), iso(r.released_at), iso(r.refunded_at), r.post_id].map(esc).join(","));
  return lines.join("\n") + "\n";
}
/** The composer's creator options (null = not a creator / the feature is off). */
async function composerInfo(viewer) {
  if (!viewer || !viewer.userId) return null;
  await init();
  if (!CONFIG.enabled || !isActiveCreator(viewer.userId)) return null;
  const rooms = require("./rooms");
  const owned = ((await rooms.ownedBy(viewer.userId).catch(() => [])) || []).map((r) => r.id);
  return { plans: await plansOf(viewer.userId), ppv: { min: CONFIG.ppv_min, max: CONFIG.ppv_max }, media: await require("./imagesafety").lockedEnforcing(),
           pads: ["u/" + viewer.username, ...owned, ...ALLOW], rating: (ACTIVE.get(viewer.userId) || {}).rating || "sfw" };
}
async function adminView() {
  await init();
  const apps = await getQuery("SELECT c.*, u.username FROM creators c LEFT JOIN users u ON u.userId = c.user_id ORDER BY CASE c.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, c.updated DESC LIMIT 300");
  const disputes = await getQuery(`SELECT d.*, l.amount, l.kind, l.state AS lstate, f.username AS fan, c.username AS creator FROM creator_disputes d JOIN creator_ledger l ON l.id = d.ledger_id
                                   LEFT JOIN users f ON f.userId = d.fan_id LEFT JOIN users c ON c.userId = d.creator_id ORDER BY d.status = 'open' DESC, d.id DESC LIMIT 100`);
  const ledger = await getQuery(`SELECT l.*, f.username AS fan, c.username AS creator FROM creator_ledger l LEFT JOIN users f ON f.userId = l.fan_id
                                 LEFT JOIN users c ON c.userId = l.creator_id ORDER BY l.id DESC LIMIT 100`);
  const tot = (await getQuery(`SELECT COALESCE(SUM(CASE WHEN state = 'held' THEN amount END),0) AS held, COALESCE(SUM(CASE WHEN state = 'released' THEN creator_share END),0) AS released,
                                COALESCE(SUM(CASE WHEN state = 'released' THEN cut END),0) AS cut, COALESCE(SUM(CASE WHEN state = 'refunded' THEN amount END),0) AS refunded FROM creator_ledger`))[0];
  for (const a of apps) a.elig = a.status === "pending" ? await eligibility(a.user_id) : null;
  return { config: config(), defaults: DEFAULTS, apps, disputes, ledger, totals: tot, escrowLive: await escrowLive(), lockedMedia: await require("./imagesafety").lockedEnforcing() };
}

// ── the explicit tier's readiness checklist (informational: nothing here can enable the tier) ──
const EXPLICIT_GATES = Object.freeze([
  { key: "legal", label: "Counsel signs off in writing on adult paid content with a dollar-funded, prize-redeemable PAT", ref: "§3.4 (a)" },
  { key: "processor", label: "An adult-capable payment setup (CCBill / Segpay / Verotel) or no dollar on-ramp at all", ref: "§3.4 (b), §3.1" },
  { key: "creator_idv", label: "Creator ID + liveness / age verification vendor under contract and integrated (re-verify on payout changes)", ref: "§3.2" },
  { key: "performer_records", label: "Co-performer consent + ID records per post (creator_performers), checked before publishing", ref: "§3.2" },
  { key: "usc2257", label: "18 U.S.C. §2257 record-keeping + custodian of records + site statement, or counsel's written opinion it's not needed", ref: "§3.2, §3.4 (c)" },
  { key: "buyer_av", label: "Buyer / viewer age assurance where the law requires it (US state AV laws, UK Online Safety Act) + geofencing", ref: "§3.2, §3.4 (d)" },
  { key: "csam_hash", label: "Hash-matching CSAM detection (PhotoDNA / Thorn Safer) on every upload incl. locked + DM media, before any classifier", ref: "§3.2, §3.4 (e)" },
  { key: "ncmec", label: "NCMEC CyberTipline ESP registration, reporting runbook, 1-year evidence preservation (REPORT Act)", ref: "§3.2, §3.4 (e)" },
  { key: "safety_enforcing", label: "Image safety enforcing + fail-closed on EVERY surface incl. DMs", ref: "§3.4 (f)" },
  { key: "human_review", label: "Pre-publication human / vendor review queue for explicit paid content", ref: "§3.2, §3.4 (f)" },
  { key: "takedown", label: "TAKE IT DOWN 48-hour NCII removal process live and staffed (built in P0: /takedown)", ref: "§3.3 (6)" },
  { key: "terms", label: "Terms §7 / §10 + Creator Terms + Privacy Policy (ID data, retention) updated and accepted", ref: "§3.4 (g)" },
  { key: "dmca", label: "DMCA agent registration updated; repeat-infringer + leak takedown process", ref: "§3.2" },
  { key: "fosta", label: "FOSTA-SESTA controls: no solicitation / escorting rules, paid-DM monitoring", ref: "§3.2" },
]);
const GATE_STATUS = Object.freeze(["todo", "in_progress", "done", "blocked"]);
async function readiness() {
  await init();
  const rows = new Map((await getQuery("SELECT * FROM explicit_readiness")).map((r) => [r.gate, r]));
  return { enabled: EXPLICIT_TIER_ENABLED, gates: EXPLICIT_GATES.map((g) => ({ ...g, ...(rows.get(g.key) || { status: "todo" }) })) };
}
async function setGate(actor, gate, { status, owner, evidence } = {}) {
  await init();
  if (!can(actor, "creators.config_explicit")) throw new Refuse(403, "Admins only.");
  if (!EXPLICIT_GATES.some((g) => g.key === gate)) throw new Refuse(404, "No such gate.");
  if (!GATE_STATUS.includes(status)) throw new Refuse(400, "Bad status.");
  await runQuery(`INSERT INTO explicit_readiness (gate, status, owner, evidence, updated_by, updated) VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(gate) DO UPDATE SET status = excluded.status, owner = excluded.owner, evidence = excluded.evidence, updated_by = excluded.updated_by, updated = excluded.updated`,
                 [gate, status, cleanLine(owner, 80) || null, cleanLine(evidence, 500) || null, actor.username, now()]);
  return { ok: true, enabled: EXPLICIT_TIER_ENABLED };
}

// ── Pepe (D13): a thin client - quotes, subscribe (after his own "!yes" confirm), the fan's subs, a creator's card ──
async function botAccount(b) {
  const esc = ESC();
  const a = await esc.accountFor({ username: b.username, login: b.camfrog });
  return a ? { userId: a.userId, username: a.username, class: null } : null;
}
async function botAct(b = {}) {
  await init();
  const site = process.env.SITE_URL || (process.env.STAGING ? "https://staging.publicaccess.tv" : "https://publicaccess.tv");
  if (!CONFIG.enabled || !CONFIG.pepe_commands) return { ok: false, code: "off", error: `${NAME} isn't open yet.` };
  const verb = String(b.verb || "");
  if (verb === "creator") {
    const v = await publicView(b.creator, null);
    if (!v) return { ok: false, code: "not_creator", error: "That account isn't a creator." };
    return { ok: true, creator: v.user.username, rating: v.rating, status: v.status, plans: v.plans, subscribers: v.subscribers, link: `${site}/creators/${encodeURIComponent(v.user.username)}` };
  }
  const me = await botAccount(b);
  if (!me) return { ok: false, code: "no_account", error: "No PAT account." };
  if (verb === "subs") {
    const f = await fanSubs(me.userId);
    return { ok: true, subs: f.subs.filter((s) => ["active", "grace"].includes(s.status)).map((s) => ({ creator: s.creator, tier: s.tier, tierName: s.tierName, price: s.price,
                                                                                                         status: s.status, renew: s.renew && !s.cancel_at_end, paid_through: s.paid_through })),
             link: `${site}/subscriptions#creators` };
  }
  if (verb === "quote" || verb === "subscribe") {
    try {
      const q = await quote(me, { creator: b.creator, tier: b.tier });
      if (q.r18 && !q.attested) return { ok: false, code: "age", error: "18+ content: confirm you're 18 or older on the website first.", link: `${site}/creators/${encodeURIComponent(q.creator)}` };
      if (q.current) return { ok: false, code: "already", error: `You already subscribe (tier ${q.current.tier}).`, link: `${site}/subscriptions#creators` };
      if (verb === "quote") return { ok: true, creator: q.creator, tier: q.plan.tier, tierName: q.plan.name, price: q.price, balance: q.balance, periodDays: q.periodDays, live: q.live };
      const r = await subscribe(me, { creator: b.creator, tier: b.tier, expect: b.expect, key: "pepe-" + String(b.idem || "").slice(0, 60), renew: true });
      return { ok: true, creator: q.creator, tier: r.tier, tierName: r.tierName, price: r.price, paid_through: r.paid_through, balance: r.balance, dup: !!r.dup,
               link: `${site}/creators/${encodeURIComponent(q.creator)}` };
    } catch (e) {
      if (e && e.refuse) return { ok: false, code: e.code || "refused", error: e.message };
      throw e;
    }
  }
  return { ok: false, code: "bad_verb", error: "unknown verb" };
}

// ── the job ──
let timer = null;
function start() {
  if (timer) return;
  const run = async () => {
    try { await renewDue(); } catch (e) { console.error("[creators] renew job:", e.message); }
    try { await releaseDue(); } catch (e) { console.error("[creators] release job:", e.message); }
  };
  setTimeout(run, 120 * 1000).unref();
  timer = setInterval(run, 60 * 60 * 1000);
  timer.unref();
}

module.exports = {
  NAME, EXPLICIT_TIER_ENABLED, RATINGS, ALL_RATINGS, CREATOR_TERMS_VERSION, AGE_VERSION, R18_ATTEST_KEYS, KIND_SUB, KIND_PPV, DEFAULTS, EXPLICIT_GATES, GATE_STATUS,
  init, config, setConfig, cleanConfig, eligibility, apply, savePlans, cleanPlans, setPadFlags, staffSet, creatorRow, plansOf, assertRating,
  prepareLock, lockedMediaCheck, attachLock, makeTeaser, applyLocks, mediaGate, attested, attestAge, liveTiers, isActiveCreator, isCreatorBadge, isR18Room, navFor,
  offer, quote, subscribe, unlock, cancel, resume, setRenew, payNow, changeTier, renewOne, renewDue, releaseOne, releaseDue, routeCutInTx, weekStart,
  refundLedger, refundPost, onPostRemoved, takedownExplicit, dispute, resolveDispute, clawback, comp, removeSub, broadcast, linked,
  publicView, fanSubs, dashboard, ledgerCsv, composerInfo, adminView, readiness, setGate, botAct, start, loadCaches, lockSchema, Refuse,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
};
