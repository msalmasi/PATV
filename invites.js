// invites.js — 1.99anv: the sign-up switch ("Sign-ups: open / invite-only") and member invites.
//
// THE SWITCH (admin setting `signups`, default "open" - shipping this changes nothing until the owner closes sign-ups).
// While it says "invite", every path that makes a NEW website account needs a valid invite (gate() + withInvite()):
//   * the sign-up form                    user.controller registerUser        (POST /register)
//   * a first-time single-sign-on account user.controller createSsoAccount    (POST /auth/sso/create: Telegram, Google, Apple;
//                                                                            POST /auth/plex/create: Plex)
//   * a first-time Twitch / Discord sign-in that makes the account (index.js /auth/twitch|discord/callback)
//   * the FIRST website sign-in of an account the Twitch / Discord chat bots made while sign-ups were invite-only
//     (/api/users/twitch|discord/register -> markShadow; the Twitch / Discord callback -> shadowGate): those accounts hold the
//     bots' chat economy (like Pepe's Camfrog accounts) and are made without an invite, but turning one into a website login
//     is a sign-up
//   * claiming a Camfrog auto account (Pepe's !signup link, autoescrow.js) needs a signed-in website account first, so it goes
//     through the sign-up form above
//   * review fix: the FIRST website sign-in of an account Pepe made (users.auto_source, never cleared) through a chat sign-in link
//     (chatsignin.js !signin - chatSignInRefused): '!patv set <name>' renames an auto account so it no longer looks like one, and
//     !signin would then make it a website login with no invite. While invite-only such an account gets reason "signup" (Pepe
//     sends them to !signup, which needs a website account - an invite) until it has signed in on the website once (webSignedIn)
// NOT gated: existing accounts signing in by any method, linking another sign-in method to an account, Pepe's automatic
// Camfrog accounts (/api/users/camfrog/register - auto-account escrow, they are not website sign-ups), the bots' own chat
// accounts (above), staff's house invites (an admin makes a code that counts against nobody), the staging rehearsal seed.
// With sign-ups open a valid invite is still used up and recorded (invited_by), and a bad one is ignored.
//
// THE INVITE. A single-use code - 16 Crockford base32 characters (80 random bits, crypto.randomBytes), shown as
// XXXX-XXXX-XXXX-XXXX - with its link /signup?invite=<code> (sharelinks: pa.tv where the site makes short links). The link
// parks the code in the browser's session, so it survives the Twitch / Discord / Google / Apple / Plex / Telegram round trip;
// the sign-up and "new SSO account" forms also take it typed in. Redemption is ONE conditional UPDATE (pending + unexpired ->
// used) inside the same dbUtils.tx as the account's INSERT: two sign-ups racing for one code can't both get it, and a failed
// INSERT (the username was just taken) gives the invite back. Code look-ups are rate limited per IP (IPv6 by its /64) and per
// session (LOOK_MAX failures per LOOK_WINDOW): each look-up is counted BEFORE the database is asked (authGuard limiter.attempt -
// a parallel burst can't slip past) and given back when the code turned out good, so codes can't be guessed. The new account
// keeps users.invited_by (the inviter's userId) and users.invite_id; the inviter gets an inbox notice.
// An invite whose inviter is site-banned (feed_bans room '') or deleted / archived can't be made and can't be used (review fix:
// no ban evasion through a banned member's links); house invites are staff's and always work.
// Expiry: `expiry_days` (default 14) from creation. The inviter (or an admin) can revoke a pending one. An expired or revoked
// invite goes back to the inviter's allowance.
//
// THE ALLOWANCE (cumulative level tiers, admin setting `tiers`, default level 5 -> 1, level 20 -> +5, level 50 -> unlimited):
//   allowance = the grants of every tier reached (users.level) + bought invites + admin-issued invites
//               - invites created that still count (used, or pending and not expired; house invites never count)
// Review fix - two pools, so a bought / gifted / comped / admin-issued invite ALWAYS adds one, even after a tier change left a
// member "over" their level's share: each invite is stamped (invites.pool) with what it used when it was made -
//   tier   the level tiers' share (used first)        tierLeft  = max(0, tier grants reached - tier invites that count)
//   extra  bought + admin-issued                      extraLeft = max(0, bought + admin - extra invites that count)
//   free   made while the member was unlimited (counts against nothing - losing the unlimited tier leaves no hole)
//   left = tierLeft + extraLeft (Infinity while unlimited). An expired / revoked invite goes back to its own pool.
// A tier change recomputes it on the next read; invites already sent stay valid (left never goes below 0). Unlimited members
// never need to buy one (the shop refuses it), but they still hold at most MAX_PENDING unused invites at once. An admin can take
// back only unused issued invites.
//
// THE SHOP ITEM (shop.js / shopcatalog.js "siteinvite1", delivery "instant", key site-invite): an official PATV store item,
// price in PAT points (prizes.cost, default 2,500,000 - set on this module's admin card, or the item's Edit page). Buying it
// adds 1 to the buyer's bought invites inside the purchase's own transaction (grantInTx); buying it as a 🎁 gift adds it to
// the recipient's. It is a site-virtual item with no cash value. Refused before any charge (buyRefusal) for someone who could
// never use it: unlimited, a chat-only account (Pepe's / a chat bot's, never signed in on the website), a site-banned or
// deleted account. Official store orders have no refund path (shop.orderAction
// refuses official orders, refundService only takes service charges), so an invite that was bought - and maybe used - can
// never be refunded. Its stock is put back after each sale, so it never sells out.
//
// Data
//   invites          id PK, code UNIQUE (normalised), inviter_id, house (1 = an admin's, outside every allowance), status
//                    pending | used | revoked (expired = pending past `expires`), created, expires, used_by, used_at,
//                    revoked_at, revoked_by (the userId who revoked it), note, pool tier | extra | free (the allowance above)
//   invite_grants    id PK, user_id, kind bought | admin, amount (admin may be negative - never below 0 in total), ref UNIQUE
//                    (shop:<order id> | admin:<random>), by_id, at, note
//   invite_settings  k -> JSON: signups, invites_when_open, expiry_days, tiers (+ updated)
//   invite_shadow    user_id PK, source (twitch-bot | discord-bot), created, web_at: a chat bot's account made while sign-ups
//                    were invite-only; web_at = its first website sign-in
//   users.invited_by, users.invite_id
// Merges (accountMerge.js): invites / grants follow the account; users.invited_by of the people someone invited follows them;
// a shadow row stays on the merged-away id.
//
// Admin: /admin/users#invites (capability auth.invites, Admin by default; POSTs are same-origin fetches). Every change is an
// admin_audit row: "signups" (the switch, {from, to}), "invite_settings" ({changes}), "invite_grant", "invite_house",
// "invite_revoke".
//   GET  /api/admin/invites[?q=&status=]              settings, stats, invites, grants, audit
//   POST /api/admin/invites/settings {signups, invites_when_open, expiry_days, tiers, price, reason, expect}
//        the card sends only what the admin changed, with what it loaded as `expect` (409 E_STALE when another admin changed
//        one of those meanwhile - a stale card can't silently undo the switch)
//   POST /api/admin/invites/grant {username, amount, reason}
//   POST /api/admin/invites/house {note, reason}      -> {invite: {id, code, link}}
//   POST /api/admin/invites/:id/revoke {reason}
// Members: /settings/invites (the page), POST /api/invites (create), POST /api/invites/:id/revoke. GET /signup?invite=<code>.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery, tx } = require("./dbUtils");

const CAP = "auth.invites";
const PRIZE_ID = "siteinvite1";
const PRIZE_KEY = "site-invite";
const DEFAULT_PRICE = 2500000;
const PRICE_MAX = 1000000000;
const PRIZE_STOCK = 10000;                     // shop.js STOCK_MAX: put back after every sale (shop.js buyOfficial)
const DAY = 86400000;
const DEFAULT_TIERS = Object.freeze([Object.freeze({ level: 5, grant: 1 }), Object.freeze({ level: 20, grant: 5 }), Object.freeze({ level: 50, unlimited: true })]);
const DEFAULTS = Object.freeze({ signups: "open", invites_when_open: true, expiry_days: 14, tiers: DEFAULT_TIERS });
const MODES = ["open", "invite"];
const EXPIRY_MIN = 1, EXPIRY_MAX = 365;
const TIERS_MAX = 10, LEVEL_MAX = 1000, GRANT_MAX = 1000;
const POOLS = ["tier", "extra", "free"];
const ADMIN_GRANT_MAX = 1000;                 // one admin issue (either way)
const MAX_PENDING = 50;                       // unused invites one member can hold at once (unlimited members too)
const CREATE_PER_HOUR = 30;
const LOOK_MAX = 12;                          // failed invite look-ups per LOOK_WINDOW, per IP and per session
const LOOK_WINDOW = 15 * 60 * 1000;
const SESSION_TTL = DAY;                      // an invite link parked in the session
const RELOAD_MS = 30 * 1000;                  // settings re-read (another process / a CLI tool)
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";   // Crockford base32: no I L O U
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{16}$/;
const AUDIT = { signups: "signups", settings: "invite_settings", grant: "invite_grant", house: "invite_house", revoke: "invite_revoke" };

let clock = () => Date.now();
const now = () => clock();

class Refuse extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.refuse = true; this.code = code || null; }
}

// ── i18n: req.t when the site's middleware ran, else English from the catalog ──
let EN_T = null;
function enT() {
  if (!EN_T) {
    let en = {};
    try { en = require("./locales/en.json"); } catch (e) { en = {}; }
    EN_T = require("./i18n-core")(en, en, "en");
  }
  return EN_T;
}
const tr = (req, key, vars) => (req && typeof req.t === "function" ? req.t(key, vars) : enT()(key, vars));
function tFor(userId) {
  try { const I = require("./i18n"); return I.tFor(I.getPref(userId) || "en"); } catch (e) { return enT(); }
}

// ── settings ──
const S = { signups: DEFAULTS.signups, invites_when_open: DEFAULTS.invites_when_open, expiry_days: DEFAULTS.expiry_days, tiers: DEFAULT_TIERS.map((t) => ({ ...t })) };
let loadedAt = 0;
let ready = null;
let usersReady = null;

function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS invites (
        id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL UNIQUE, inviter_id TEXT NOT NULL, house INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL, expires INTEGER NOT NULL, used_by TEXT, used_at INTEGER,
        revoked_at INTEGER, revoked_by TEXT, note TEXT, pool TEXT NOT NULL DEFAULT 'tier')`);
      // review fix: the allowance's pools (a table made by the first build of 1.99anv has no pool column)
      const ic = (await getQuery("SELECT name FROM pragma_table_info('invites')")).map((c) => c.name);
      if (!ic.includes("pool")) {
        try { await runQuery("ALTER TABLE invites ADD COLUMN pool TEXT NOT NULL DEFAULT 'tier'"); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
      }
      await runQuery("CREATE INDEX IF NOT EXISTS invites_inviter ON invites (inviter_id, status, expires)");
      await runQuery("CREATE INDEX IF NOT EXISTS invites_used_by ON invites (used_by)");
      await runQuery(`CREATE TABLE IF NOT EXISTS invite_grants (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL, ref TEXT NOT NULL UNIQUE,
        by_id TEXT, at INTEGER NOT NULL, note TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS invite_grants_user ON invite_grants (user_id, kind)");
      await runQuery("CREATE TABLE IF NOT EXISTS invite_settings (k TEXT PRIMARY KEY, v TEXT, updated INTEGER)");
      await runQuery("CREATE TABLE IF NOT EXISTS invite_shadow (user_id TEXT PRIMARY KEY, source TEXT, created INTEGER NOT NULL, web_at INTEGER)");
      await load();
    })().catch((e) => { ready = null; console.error("[invites] init:", e.message); throw e; });
  }
  return ready;
}

/** users.invited_by + users.invite_id (once the users table exists). */
function ensureUserCols() {
  if (usersReady) return usersReady;
  usersReady = (async () => {
    const cols = (await getQuery("SELECT name FROM pragma_table_info('users')")).map((c) => c.name);
    if (!cols.length) { usersReady = null; return false; }
    for (const [c, sql] of [["invited_by", "ALTER TABLE users ADD COLUMN invited_by TEXT"], ["invite_id", "ALTER TABLE users ADD COLUMN invite_id INTEGER"]]) {
      if (cols.includes(c)) continue;
      try { await runQuery(sql); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
    }
    return true;
  })().catch((e) => { usersReady = null; console.error("[invites] users columns:", e.message); return false; });
  return usersReady;
}

async function load() {
  const rows = await getQuery("SELECT k, v FROM invite_settings");
  const next = { signups: DEFAULTS.signups, invites_when_open: DEFAULTS.invites_when_open, expiry_days: DEFAULTS.expiry_days, tiers: DEFAULT_TIERS.map((t) => ({ ...t })) };
  for (const r of rows) {
    let v;
    try { v = JSON.parse(r.v); } catch (e) { continue; }
    try {
      if (r.k === "signups") next.signups = checkMode(v);
      else if (r.k === "invites_when_open") next.invites_when_open = v === true;
      else if (r.k === "expiry_days") next.expiry_days = checkExpiry(v);
      else if (r.k === "tiers") next.tiers = checkTiers(v);
    } catch (e) { console.error(`[invites] setting ${r.k} unreadable - default kept:`, e.message); }
  }
  Object.assign(S, next);
  loadedAt = now();
}
/** Settings, re-read from the database at most every RELOAD_MS. */
async function fresh() {
  await init();
  if (now() - loadedAt > RELOAD_MS) await load().catch((e) => console.error("[invites] reload:", e.message));
  return S;
}
/** "open" | "invite" (what this process last read). */
const mode = () => S.signups;
const inviteOnly = () => S.signups === "invite";
const settings = () => ({ signups: S.signups, invites_when_open: S.invites_when_open, expiry_days: S.expiry_days, tiers: S.tiers.map((t) => ({ ...t })) });

function checkMode(v) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  const m = s === "invite-only" || s === "invite_only" || s === "closed" ? "invite" : s;
  if (!MODES.includes(m)) throw new Refuse(400, 'Sign-ups must be "open" or "invite".', "E_MODE");
  return m;
}
function checkExpiry(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < EXPIRY_MIN || n > EXPIRY_MAX) throw new Refuse(400, `Invites expire after ${EXPIRY_MIN}-${EXPIRY_MAX} days.`, "E_EXPIRY");
  return n;
}
/**
 * Validate the level tiers. Takes an array of {level, grant} / {level, unlimited: true}, or text like "5:1, 20:5, 50:unlimited".
 * Levels are whole numbers 0..LEVEL_MAX in strictly ascending order, grants whole numbers 0..GRANT_MAX, at most one
 * "unlimited" tier and only as the last one. -> the normalised array, or throws Refuse(400).
 * Review fix: a level / a count must be a number or a string of digits - a blank field (""), null or true is refused, never
 * read as 0 / 1.
 */
const wholeOf = (v) => (typeof v === "number" ? v : typeof v === "string" && /^\s*\+?\d+\s*$/.test(v) ? Number(v) : NaN);
function checkTiers(raw) {
  let list = raw;
  if (typeof raw === "string") {
    list = raw.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean).map((s) => {
      const m = /^(\d+)\s*[:=]\s*(\+?\d+|unlimited|∞)$/i.exec(s.replace(/^level\s*/i, ""));
      if (!m) throw new Refuse(400, `"${s.slice(0, 30)}" isn't a tier - write it as level:invites, e.g. 5:1 or 50:unlimited.`, "E_TIERS");
      return /^(unlimited|∞)$/i.test(m[2]) ? { level: Number(m[1]), unlimited: true } : { level: Number(m[1]), grant: Number(m[2].replace("+", "")) };
    });
  }
  if (!Array.isArray(list) || !list.length) throw new Refuse(400, "Add at least one tier.", "E_TIERS");
  if (list.length > TIERS_MAX) throw new Refuse(400, `At most ${TIERS_MAX} tiers.`, "E_TIERS");
  const out = [];
  let prev = -1;
  list.forEach((t, i) => {
    if (!t || typeof t !== "object") throw new Refuse(400, `Tier ${i + 1} isn't a tier.`, "E_TIERS");
    const level = wholeOf(t.level);
    if (!Number.isInteger(level) || level < 0 || level > LEVEL_MAX) throw new Refuse(400, `Tier ${i + 1}: the level must be a whole number 0-${LEVEL_MAX}.`, "E_TIERS");
    if (level <= prev) throw new Refuse(400, "Tier levels must go up, each one higher than the one before.", "E_TIERS");
    prev = level;
    const unlimited = t.unlimited === true || t.unlimited === "true" || t.unlimited === 1 || t.grant === "unlimited";
    if (unlimited) {
      if (i !== list.length - 1) throw new Refuse(400, 'Only the last tier can be "unlimited".', "E_TIERS");
      out.push({ level, unlimited: true });
      return;
    }
    const grant = wholeOf(t.grant);
    if (!Number.isInteger(grant) || grant < 0 || grant > GRANT_MAX) throw new Refuse(400, `Tier ${i + 1}: invites must be a whole number 0-${GRANT_MAX}.`, "E_TIERS");
    out.push({ level, grant });
  });
  return out;
}
/** Tiers as text: "5:1, 20:5, 50:unlimited". */
const tiersText = (tiers) => (tiers || []).map((t) => `${t.level}:${t.unlimited ? "unlimited" : t.grant}`).join(", ");

// ── codes ──
function newCode() {
  const b = crypto.randomBytes(10);
  let val = 0, bits = 0, out = "";
  for (const x of b) {
    val = (val << 8) | x; bits += 8;
    while (bits >= 5) { out += ALPHABET[(val >>> (bits - 5)) & 31]; bits -= 5; }
    val &= (1 << bits) - 1;
  }
  return out;
}
/** Whatever was typed / pasted (a code, with dashes or spaces, any case; or a whole invite link) -> the code, or null. */
function normalize(input) {
  let s = String(input == null ? "" : input).trim();
  if (!s || s.length > 300) return null;
  const m = /[?&]invite=([^&#\s]+)/i.exec(s);
  if (m) { try { s = decodeURIComponent(m[1]); } catch (e) { s = m[1]; } }
  s = s.toUpperCase().replace(/[\s-]+/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return CODE_RE.test(s) ? s : null;
}
const formatCode = (code) => String(code || "").replace(/(.{4})(?=.)/g, "$1-");
function linkOf(code) {
  return require("./sharelinks").shareUrl("/signup?invite=" + formatCode(code));
}
/** What a form shows back in its invite field after a refusal: the code (XXXX-XXXX-XXXX-XXXX) when it is one - a pasted link
 *  too - else what was typed, up to normalize()'s own limit (review fix: it was cut at 40, shorter than an invite link). */
function echo(raw) {
  if (typeof raw !== "string") return "";
  const code = normalize(raw);
  return code ? formatCode(code) : raw.trim().slice(0, 300);
}

// ── the allowance ──
/** The tiers a level reaches: {n, unlimited, reached: [{level, grant|unlimited}], next: the next tier or null, unlimitedAt}. */
function tierSum(level, tiers) {
  const L = Math.max(0, Math.floor(Number(level) || 0));
  const T = tiers || S.tiers;
  const reached = [];
  let n = 0, unlimited = false;
  for (const t of T) {
    if (L < t.level) break;
    if (t.unlimited) { unlimited = true; reached.push({ level: t.level, unlimited: true }); break; }
    n += t.grant;
    reached.push({ level: t.level, grant: t.grant });
  }
  const next = unlimited ? null : T.find((t) => L < t.level) || null;
  const ut = T.find((t) => t.unlimited);
  return { n, unlimited, reached, next: next ? { ...next } : null, unlimitedAt: ut ? ut.level : null };
}
/**
 * How many invites this account can still make, and why.
 * -> {level, unlimited, tiers: reached, next, unlimitedAt, fromTiers, bought, admin, total, used (tier + extra invites that
 *    count), tierUsed, extraUsed, pending (every unused, unexpired one - free ones too), tierLeft, extraLeft, left (Infinity when
 *    unlimited)}; null for an unknown account. The pools: see THE ALLOWANCE above.
 */
async function allowance(userId, { at = now() } = {}) {
  await fresh();
  const u = (await getQuery("SELECT level FROM users WHERE userId = ?", [String(userId || "")]))[0];
  if (!u) return null;
  const ts = tierSum(u.level, S.tiers);
  let bought = 0, admin = 0;
  for (const g of await getQuery("SELECT kind, COALESCE(SUM(amount), 0) AS n FROM invite_grants WHERE user_id = ? GROUP BY kind", [String(userId)])) {
    if (g.kind === "bought") bought = Number(g.n) || 0;
    else if (g.kind === "admin") admin = Math.max(0, Number(g.n) || 0);
  }
  const counts = "(status = 'used' OR (status = 'pending' AND expires > ?))";
  const c = (await getQuery(`SELECT COALESCE(SUM(CASE WHEN pool = 'extra' AND ${counts} THEN 1 ELSE 0 END), 0) AS extra_used,
                                    COALESCE(SUM(CASE WHEN pool NOT IN ('extra', 'free') AND ${counts} THEN 1 ELSE 0 END), 0) AS tier_used,
                                    COALESCE(SUM(CASE WHEN status = 'pending' AND expires > ? THEN 1 ELSE 0 END), 0) AS pending
                             FROM invites WHERE inviter_id = ? AND house = 0`, [at, at, at, String(userId)]))[0] || {};
  const tierUsed = Number(c.tier_used) || 0, extraUsed = Number(c.extra_used) || 0, pending = Number(c.pending) || 0;
  const total = ts.n + bought + admin;
  const tierLeft = Math.max(0, ts.n - tierUsed), extraLeft = Math.max(0, bought + admin - extraUsed);
  return { level: Math.max(0, Math.floor(Number(u.level) || 0)), unlimited: ts.unlimited, tiers: ts.reached, next: ts.next, unlimitedAt: ts.unlimitedAt,
           fromTiers: ts.n, bought, admin, total, used: tierUsed + extraUsed, tierUsed, extraUsed, pending, tierLeft, extraLeft,
           left: ts.unlimited ? Infinity : tierLeft + extraLeft };
}
/** The pool a new invite comes out of (the tiers' share first, then bought / issued; unlimited -> free). */
const poolFor = (a) => (a.unlimited ? "free" : a.tierLeft > 0 ? "tier" : "extra");

// ── who can't send (or be sent) invites ──
// (SELECT * of one users row: archived_at / auto_source are added by other modules' migrations, and a test database may lack them)
const userRow = async (id) => (await getQuery("SELECT * FROM users WHERE userId = ?", [String(id || "")]))[0] || null;
/**
 * Review fix: an account whose invites must not work - null (fine) | "banned" (a site ban: feed_bans with room '' that hasn't
 * ended - what telegram.siteBanned checks) | "gone" (no such account, archived, or deleted: accountdelete pseudonymises the row
 * and sets archived_at; account_deletions 'done' too).
 */
async function inviterBlock(userId, { at = now() } = {}) {
  const id = String(userId || "");
  if (!id) return "gone";
  const u = await userRow(id);
  if (!u || u.archived_at) return "gone";
  try { if ((await getQuery("SELECT 1 FROM account_deletions WHERE user_id = ? AND state = 'done' LIMIT 1", [id])).length) return "gone"; }
  catch (e) { /* no deletions table yet */ }
  try { if (await require("./siteban").activeBan(id, at)) return "banned"; }      // 1.99aoi: the one site-ban rule (siteban.js)
  catch (e) { /* a read that fails: as before (no feed_bans table yet) */ }
  return null;
}

/**
 * Has this account ever been signed in to on the website? A sessions row (every sign-in since 1.99wj, kept when it ends), a chat
 * sign-in link used (chat_signin_log 'used'), or a sign-in method on the account (an email with "@", Discord / Twitch, a
 * linked Google / Apple / Plex / Telegram - only a signed-in member can add one).
 */
async function webSignedIn(userId, row = null) {
  const id = String(userId || "");
  try { if ((await getQuery("SELECT 1 FROM sessions WHERE user_id = ? LIMIT 1", [id])).length) return true; } catch (e) { /* no sessions table */ }
  try { if ((await getQuery("SELECT 1 FROM chat_signin_log WHERE user_id = ? AND kind = 'used' LIMIT 1", [id])).length) return true; } catch (e) { /* none */ }
  const AA = require("./autoaccount");
  const u = row || (await userRow(id));
  if (AA.rowFacts(u).signIn) return true;
  return AA.hasLinkedSignIn(id);
}
/**
 * A chat-only account: made by Pepe (users.auto_source - never cleared, so a renamed one too) or by a Twitch / Discord chat bot
 * while sign-ups were invite-only (invite_shadow, not yet signed in), and nobody has signed in to it on the website. It holds chat
 * rewards; it is not a website account (no invites of its own, and turning it into a website login is a sign-up).
 */
async function chatOnly(userId) {
  await init();
  const id = String(userId || "");
  if (!id) return false;
  await require("./autoaccount").ensure();
  const u = await userRow(id);
  if (!u) return false;
  if (u.auto_source) return !(await webSignedIn(id, u));
  const sh = (await getQuery("SELECT 1 FROM invite_shadow WHERE user_id = ? AND web_at IS NULL", [id]))[0];
  if (!sh) return false;
  try { return !(await getQuery("SELECT 1 FROM sessions WHERE user_id = ? LIMIT 1", [id])).length; } catch (e) { return true; }
}
/**
 * chatsignin.js (!signin issue + redeem): while sign-ups are invite-only, a chat sign-in link can't be the FIRST website sign-in
 * of a chat-only account (the '!patv set' rename + '!signin' route to a website login with no invite). -> true = refuse
 * (reason "signup": Pepe sends them to !signup, which needs a website account - an invite).
 */
async function chatSignInRefused(userId) {
  try { await fresh(); } catch (e) { /* the last settings read stands */ }
  if (S.signups !== "invite") return false;
  return chatOnly(userId);
}

/** Can this member make an invite right now? -> null, or {code, message} (what the page / API says). */
function createRefusal(a, req) {
  if (!a) return { code: "E_NO_ACCOUNT", message: tr(req, "invites.err.no_account") };
  if (S.signups === "open" && !S.invites_when_open) return { code: "E_OPEN", message: tr(req, "invites.off_open") };
  if (a.pending >= MAX_PENDING) return { code: "E_TOO_MANY", message: tr(req, "invites.too_many", { n: MAX_PENDING }) };
  if (!a.unlimited && a.left < 1) return { code: "E_NONE_LEFT", message: tr(req, "invites.none_left") };
  return null;
}

// ── create / revoke ──
const newCreateLimit = () => require("./middleware/authGuard").limiter({ max: CREATE_PER_HOUR, windowMs: 3600 * 1000 });
let createLimit = newCreateLimit();
/**
 * Make an invite. me = {userId}. house = an admin's invite outside every allowance (the admin route checks the capability).
 * -> {id, code, display, link, expires, created}. Throws Refuse.
 */
async function create(me, { house = false, note = null, req = null } = {}) {
  await fresh();
  if (!me || !me.userId) throw new Refuse(401, tr(req, "invites.err.sign_in"), "E_SIGN_IN");
  if (!house && createLimit.attempt("u:" + me.userId)) throw new Refuse(429, tr(req, "invites.err.create_rate"), "E_RATE");
  // review fix: a site-banned (or deleted / archived) member makes no invites - each one would be a fresh, unbanned account
  if (!house && (await inviterBlock(me.userId))) throw new Refuse(403, tr(req, "invites.err.banned_maker"), "E_BANNED");
  const row = await tx(async () => {
    let pool = "tier";
    if (!house) {
      const a = await allowance(me.userId);
      const why = createRefusal(a, req);
      if (why) throw new Refuse(409, why.message, why.code);
      pool = poolFor(a);                    // review fix: which share it uses (THE ALLOWANCE above)
    }
    const t = now();
    const expires = t + S.expiry_days * DAY;
    for (let i = 0; i < 5; i++) {
      const code = newCode();
      try {
        const r = await runQuery("INSERT INTO invites (code, inviter_id, house, status, created, expires, note, pool) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)",
                                 [code, String(me.userId), house ? 1 : 0, t, expires, note ? String(note).replace(/[\r\n\t]+/g, " ").slice(0, 200) : null, pool]);
        return { id: r.id || r.lastID, code, created: t, expires };
      } catch (e) {
        if (!/UNIQUE/i.test(String(e && e.message))) throw e;   // 2^80 codes: a collision is a freak - draw again
      }
    }
    throw new Error("invites: no free code");
  });
  return { ...row, display: formatCode(row.code), link: linkOf(row.code) };
}

/** Revoke a pending invite: its inviter, or an admin (admin: true - the route checks the capability). -> the row. Throws Refuse. */
async function revoke(me, id, { admin = false, req = null } = {}) {
  await init();
  const n = parseInt(id, 10);
  if (!(n > 0)) throw new Refuse(404, tr(req, "invites.err.not_found"), "E_NOT_FOUND");
  const row = (await getQuery("SELECT * FROM invites WHERE id = ?", [n]))[0];
  if (!row || (!admin && row.inviter_id !== String(me && me.userId))) throw new Refuse(404, tr(req, "invites.err.not_found"), "E_NOT_FOUND");
  // review fix: a house invite is staff's (the admin card revokes it, with its admin_audit row) - never from the member page
  if (!admin && Number(row.house)) throw new Refuse(409, tr(req, "invites.err.house"), "E_HOUSE");
  const t = now();
  const r = await runQuery("UPDATE invites SET status = 'revoked', revoked_at = ?, revoked_by = ? WHERE id = ? AND status = 'pending'",
                           [t, String(me && me.userId || ""), n]);
  if (!r || !r.changes) throw new Refuse(409, tr(req, "invites.err.not_pending"), "E_NOT_PENDING");
  return { ...row, status: "revoked", revoked_at: t };
}

// ── looking a code up (rate limited) ──
const newLookLimit = () => require("./middleware/authGuard").limiter({ max: LOOK_MAX, windowMs: LOOK_WINDOW });
let lookLimit = newLookLimit();
const ipOf = (req) => { try { return require("./middleware/authGuard").clientIp(req) || "?"; } catch (e) { return "?"; } };
// review fix: an IPv6 address by its /64 (netban.netOf), so one network can't rotate past the limit
const netKey = (ip) => { try { return require("./netban").netOf(ip) || ip; } catch (e) { return ip; } };
const lookKeys = (req) => ["ip:" + netKey(ipOf(req)), ...(req && req.sessionID ? ["s:" + req.sessionID] : [])];
/**
 * Review fix (the parallel-guess bypass, as authGuard's sign-in limiter): count one look-up on every key BEFORE the database is
 * asked. -> {wait (seconds, nothing counted) | 0, keys: the keys counted - lookGood(keys) gives them back for a good code}.
 */
function lookAttempt(req) {
  const counted = [];
  let wait = 0;
  for (const k of lookKeys(req)) {
    const w = lookLimit.attempt(k);
    if (w) wait = Math.max(wait, w); else counted.push(k);
  }
  if (wait) { for (const k of counted) lookLimit.undo(k); return { wait, keys: [] }; }
  return { wait: 0, keys: counted };
}
function lookGood(keys) { for (const k of keys || []) lookLimit.undo(k); }
const slowDown = (req, wait) => tr(req, "invites.err.slow_down", { wait: require("./middleware/authGuard").waitText(wait, req) });

/** The invite row for a normalised code (+ the inviter's username / display name), or null. */
async function byCode(code) {
  await init();
  return (await getQuery(`SELECT i.*, u.username AS inviter_name, u.displayname AS inviter_display FROM invites i
                          LEFT JOIN users u ON u.userId = i.inviter_id WHERE i.code = ?`, [String(code || "")]))[0] || null;
}
/** Why a row can't be used right now: null (usable) | "unknown" | "used" | "revoked" | "expired". */
function unusable(row, at = now()) {
  if (!row) return "unknown";
  if (row.status === "used") return "used";
  if (row.status === "revoked") return "revoked";
  if (row.status !== "pending") return "unknown";
  return Number(row.expires) > at ? null : "expired";
}
/**
 * Check a code someone gave us, rate limited (every look-up is counted against the IP and the session before the database is
 * asked; a good code gives it back, so only failures add up).
 * -> {ok: true, invite} | {ok: false, reason: "rate" | "unknown" | "used" | "revoked" | "expired" | "inviter", error}
 * "inviter" (review fix): the inviter is site-banned, or the account was deleted / archived - a house invite always works.
 */
async function check(req, raw) {
  const lk = lookAttempt(req);
  if (lk.wait) return { ok: false, reason: "rate", error: slowDown(req, lk.wait) };
  const code = normalize(raw);
  const row = code ? await byCode(code) : null;
  let why = unusable(row);
  if (!why && !Number(row.house) && (await inviterBlock(row.inviter_id))) why = "inviter";
  if (why) return { ok: false, reason: why, error: tr(req, "invites.err." + why) };
  lookGood(lk.keys);
  return { ok: true, invite: row, code };
}

// ── the browser's session: an invite link parked for the sign-up / SSO round trip ──
function sessionCode(req) {
  const s = req && req.session && req.session.invite;
  if (!s || !s.code || !(now() - Number(s.at || 0) <= SESSION_TTL)) { if (s && req.session) delete req.session.invite; return null; }
  return s.code;
}
function park(req, code) { if (req && req.session) req.session.invite = { code, at: now() }; }
function unpark(req) { if (req && req.session) delete req.session.invite; }
/** ?invite=<code> on a sign-up / sign-in / SSO start page -> parked in the session (checked when it's used). */
function capture(req) {
  const q = req && req.query && typeof req.query.invite === "string" ? req.query.invite : "";
  if (!q) return { given: false };
  const code = normalize(q);
  if (code) park(req, code);
  return { given: true, code };
}
/** Express middleware for GET pages that start a sign-up (/auth/twitch, /auth/google ...): park ?invite= and carry on. */
function captureMw(req, res, next) { try { capture(req); } catch (e) { /* never blocks */ } next(); }

/** What the sign-up pages show (res.locals.signupInvite): {mode, required, code, valid, from, house, error, whenOpen}. */
async function viewState(req) {
  await fresh();
  const st = { mode: S.signups, required: S.signups === "invite", code: "", valid: false, from: null, house: false, error: null, whenOpen: S.invites_when_open };
  const c = capture(req);
  if (c.given && !c.code) {
    const lk = lookAttempt(req);             // a malformed code is a failed look-up (counted; never given back)
    st.error = lk.wait ? slowDown(req, lk.wait) : tr(req, "invites.err.unknown");
    return st;
  }
  const code = sessionCode(req);
  if (!code) return st;
  const r = await check(req, code);
  if (r.ok) {
    st.code = formatCode(code); st.valid = true; st.house = !!Number(r.invite.house);
    st.from = st.house ? null : (r.invite.inviter_display || r.invite.inviter_name || null);
  } else {
    st.error = r.error;
    if (r.reason !== "rate") unpark(req);
  }
  return st;
}
function viewMw(req, res, next) {
  viewState(req).then((st) => { res.locals.signupInvite = st; next(); }, (e) => {
    console.error("[invites] page state:", e.message);
    res.locals.signupInvite = { mode: S.signups, required: true, code: "", valid: false, from: null, house: false, error: null, whenOpen: S.invites_when_open };
    next();
  });
}

// ── the gate every account-creation path calls ──
/**
 * May this request make a new account, and with which invite? The code: the form's `invite` field, else the one parked in
 * the session. -> {ok: true, required, code|null, invite|null} | {ok: false, required: true, error, reason, field: "invite"}
 * Invite-only: no / a bad / a used / an expired code -> refused (no account). Open: a valid code is used and recorded, a bad one
 * is ignored. opts.required: true forces the invite-only rule (shadowGate).
 */
async function gate(req, { required = null } = {}) {
  try { await fresh(); }
  catch (e) { return { ok: false, required: true, reason: "error", error: tr(req, "invites.err.unavailable"), field: "invite" }; }   // fail closed
  const need = required === null ? S.signups === "invite" : !!required;
  const body = req && req.body && typeof req.body === "object" ? req.body : {};
  const typed = typeof body.invite === "string" && body.invite.trim() ? body.invite : null;
  const raw = typed || sessionCode(req);
  if (!raw) return need ? { ok: false, required: true, reason: "none", error: tr(req, "invites.err.closed"), field: "invite" } : { ok: true, required: false, code: null, invite: null };
  const r = await check(req, raw);
  if (!r.ok) {
    if (!typed && r.reason !== "rate") unpark(req);
    return need ? { ok: false, required: true, reason: r.reason, error: r.error, field: "invite" } : { ok: true, required: false, code: null, invite: null };
  }
  return { ok: true, required: need, code: r.code, invite: r.invite };
}

/**
 * Make the account WITH the invite: claim it (pending + unexpired -> used by userId) and run fn() (the INSERT) in ONE
 * transaction, then stamp users.invited_by / invite_id. A claim that loses a race throws E_INVITE_GONE when the invite was
 * required (nothing is made) - with sign-ups open the account is made without it. g = gate()'s answer. -> fn()'s result.
 */
async function withInvite(req, g, userId, fn) {
  if (!g || !g.code) return fn();
  await ensureUserCols();
  const t = now();
  let claimed = false;
  try {
    const out = await tx(async () => {
      const r = await runQuery("UPDATE invites SET status = 'used', used_by = ?, used_at = ? WHERE code = ? AND status = 'pending' AND expires > ?",
                               [String(userId), t, g.code, t]);
      if (!r || !r.changes) throw new Refuse(409, tr(req, "invites.err.used"), "E_INVITE_GONE");
      const res = await fn();
      await runQuery("UPDATE users SET invited_by = ?, invite_id = ? WHERE userId = ? AND invited_by IS NULL",
                     [g.invite.inviter_id, g.invite.id, String(userId)]);
      claimed = true;
      return res;
    });
    afterUse(req, g, userId);
    return out;
  } catch (e) {
    if (!claimed && e && e.code === "E_INVITE_GONE") {
      unpark(req);
      if (!g.required) return fn();
    }
    throw e;
  }
}
/** After a sign-up used an invite: forget the parked link, tell the inviter (never throws, never waits). */
function afterUse(req, g, userId) {
  if (req && req.session && req.session.invite && req.session.invite.code === g.code) unpark(req);
  (async () => {
    const who = (await getQuery("SELECT username FROM users WHERE userId = ?", [String(userId)]))[0];
    const to = g.invite.inviter_id;
    if (!to || !who) return;
    const t = tFor(to);
    await require("./inbox").addSafe(to, { kind: "system", title: t("invites.notice_title", { name: who.username }), body: t("invites.notice_body", { name: who.username }),
                                          link: "/settings/invites#used", ref: `invite-used:${g.invite.id}` });
  })().catch((e) => console.error("[invites] notice:", e.message));
  console.log(`[invites] invite #${g.invite.id} used by ${userId}`);
}

/** The Twitch / Discord callbacks: a refusal goes to the sign-up page, where the invite field is. */
function refuseOauth(req, res, g) {
  if (req && typeof req.flash === "function") {
    req.flash("error", (g && g.error) || tr(req, "invites.err.closed"));
    req.flash("authForm", JSON.stringify({ field: "invite" }));      // shown under the invite field
  }
  return res.redirect("/register");
}

// ── the chat bots' accounts (Twitch / Discord) ──
/** /api/users/twitch|discord/register: remember an account a bot made while sign-ups are invite-only. Never throws. */
async function markShadow(userId, source) {
  try {
    await fresh();
    if (S.signups !== "invite") return false;
    const r = await runQuery("INSERT OR IGNORE INTO invite_shadow (user_id, source, created) VALUES (?, ?, ?)", [String(userId), String(source || "").slice(0, 20), now()]);
    return !!(r && r.changes);
  } catch (e) { console.error("[invites] shadow mark:", e.message); return false; }
}
/**
 * A Twitch / Discord sign-in found an existing account: if a chat bot made it while sign-ups were invite-only and this is
 * its first website sign-in, it needs an invite now (while sign-ups are still invite-only). -> {ok} | {ok: false, error}
 */
async function shadowGate(req, userId) {
  await init();
  const row = (await getQuery("SELECT user_id FROM invite_shadow WHERE user_id = ? AND web_at IS NULL", [String(userId)]))[0];
  if (!row) return { ok: true };
  await fresh();
  const mark = () => runQuery("UPDATE invite_shadow SET web_at = ? WHERE user_id = ? AND web_at IS NULL", [now(), String(userId)]);
  if (S.signups !== "invite") { await mark(); return { ok: true, activated: true }; }
  const g = await gate(req, { required: true });
  if (!g.ok) return g;
  try {
    await withInvite(req, g, userId, async () => {
      const r = await mark();
      if (!r || !r.changes) throw Object.assign(new Error("already signed in"), { code: "E_ACTIVE" });
    });
  } catch (e) {
    if (e && e.code === "E_ACTIVE") return { ok: true };
    if (e && e.code === "E_INVITE_GONE") return { ok: false, error: e.message };
    throw e;
  }
  return { ok: true, activated: true, invite: g.invite };
}

// ── grants: bought (the shop) and admin-issued ──
/**
 * INSIDE an open transaction (shop.js buyOfficial): add `amount` invites to userId. ref is unique (a retried order can't add
 * twice). kind "bought" | "admin".
 */
async function grantInTx(userId, amount, kind, ref, { byId = null, note = null } = {}) {
  await init();
  if (!["bought", "admin"].includes(kind)) throw new Error("invites: bad grant kind " + kind);
  await runQuery("INSERT INTO invite_grants (user_id, kind, amount, ref, by_id, at, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
                 [String(userId), kind, Math.trunc(Number(amount)) || 0, String(ref).slice(0, 120), byId ? String(byId) : null, now(),
                  note ? String(note).slice(0, 200) : null]);
}
/**
 * The shop's check before charging (buy, 🎁 gift precheck, comp): never sell an invite that can't be used. -> the refusal
 * (English, like the shop's messages - from the catalog) or null.
 *   unlimited members never need one
 *   review fix: a chat-only account (Pepe's Camfrog account, a chat bot's - chatOnly) can't make invites, and its own website
 *   account needs an invite anyway; a site-banned or deleted account can't make them either
 *   a bought invite always adds one (the extra pool - THE ALLOWANCE above); refused if it somehow wouldn't (defensive)
 */
async function buyRefusal(userId, { gift = false, username = "" } = {}) {
  const T = enT();
  const name = username || "They";
  const a = await allowance(userId).catch(() => null);
  if (a && a.unlimited) {
    return gift ? `${username || "They"} already ${username ? "has" : "have"} unlimited invites - they don't need one.`
                : `You have unlimited invites (level ${a.unlimitedAt}) - you never need to buy one.`;
  }
  if (await chatOnly(userId).catch(() => false)) return T(gift ? "invites.buy.no_web_gift" : "invites.buy.no_web", { name });
  if (await inviterBlock(userId).catch(() => null)) return T(gift ? "invites.buy.blocked_gift" : "invites.buy.blocked", { name });
  if (a && a.bought + a.admin + 1 - a.extraUsed < 1) return T(gift ? "invites.buy.no_room_gift" : "invites.buy.no_room", { name });
  return null;
}
/** Admin: issue (or take back, negative - only unused ones) invites to a member. -> {user, amount, admin_total, left (a number,
 *  "unlimited", or null)}. Throws Refuse. */
async function adminGrant(admin, { username, amount, reason }) {
  await init();
  const n = Number(String(amount == null ? "" : amount).trim());
  if (!Number.isInteger(n) || n === 0 || Math.abs(n) > ADMIN_GRANT_MAX) throw new Refuse(400, `Invites must be a whole number from -${ADMIN_GRANT_MAX} to ${ADMIN_GRANT_MAX} (not 0).`, "E_AMOUNT");
  const why = String(reason || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 200);
  if (why.length < 3) throw new Refuse(400, "Give a reason (it goes in the admin log).", "E_REASON");
  const G = require("./gifts");
  let to;
  try { to = await G.recipient(username); } catch (e) { throw new Refuse(e.status || 404, e.message, "E_TARGET"); }
  const out = await tx(async () => {
    const cur = Number(((await getQuery("SELECT COALESCE(SUM(amount), 0) AS n FROM invite_grants WHERE user_id = ? AND kind = 'admin'", [to.userId]))[0] || {}).n) || 0;
    // review fix: take back only what's unused - issued invites they already sent stay sent (the extra pool never goes negative)
    const before = await allowance(to.userId);
    const back = before ? Math.max(0, Math.min(cur, before.extraLeft)) : cur;
    if (n < 0 && -n > back) throw new Refuse(409, `${to.username} has ${back} unused staff-issued invite${back === 1 ? "" : "s"} - you can take back at most that many.`, "E_BELOW_ZERO");
    await grantInTx(to.userId, n, "admin", "admin:" + crypto.randomBytes(9).toString("hex"), { byId: admin.userId, note: why });
    const after = await allowance(to.userId);
    const left = !after ? null : after.unlimited ? "unlimited" : after.left;
    await require("./adminaudit").record(admin, AUDIT.grant, to, { amount: n, admin_total: cur + n, left }, why);
    return { user: to, amount: n, admin_total: cur + n, left };
  });
  if (n > 0) {
    const t = tFor(to.userId);
    require("./inbox").addSafe(to.userId, { kind: "system", title: t("invites.granted_title", { count: n }), body: t("invites.granted_body"),
                                            link: "/settings/invites", ref: `invite-grant:${now()}:${to.userId}` }).catch(() => {});
  }
  return out;
}

// ── the shop item ──
const isPrize = (p) => !!p && String(p.prizeId || p.prize_id || "") === PRIZE_ID && !p.seller_id;
/** The official "Invite" row (created once with the default price; a later price change is the admin's). */
async function ensureShopItem() {
  try { await require("./shop").ready; } catch (e) { /* the shop logs its own schema errors */ }
  const t = now();
  const desc = "One extra invite: a one-time link that lets one new person make a PATV account. It's added to your invites (Settings, Invites) " +
               "the moment you buy it, and it works while sign-ups are invite-only. A site pass for PATV only: it has no cash value and " +
               "can't be exchanged for anything outside PATV.";
  await runQuery(`INSERT OR IGNORE INTO prizes (prizeId, prize, cost, quantity, seller_id, description, category, delivery, image_url, status, sold, created, updated)
                  VALUES (?, ?, ?, ?, NULL, ?, NULL, 'instant', ?, 'active', 0, ?, ?)`,
                 [PRIZE_ID, "PATV Invite", DEFAULT_PRICE, PRIZE_STOCK, desc, `/public/img/shop/${PRIZE_KEY}.svg`, t, t]);
}
async function price() {
  const r = (await getQuery("SELECT cost, status FROM prizes WHERE prizeId = ? AND seller_id IS NULL", [PRIZE_ID]).catch(() => []))[0];
  return r ? { cost: Number(r.cost) || 0, status: r.status || "active" } : null;
}
function checkPrice(v) {
  const n = Number(String(v == null ? "" : v).replace(/[, _]/g, ""));
  if (!Number.isInteger(n) || n < 1 || n > PRICE_MAX) throw new Refuse(400, `The price must be 1-${PRICE_MAX.toLocaleString("en-US")} PAT.`, "E_PRICE");
  return n;
}

// ── admin: settings ──
const boolOf = (v) => v === true || v === "1" || v === "on" || v === "true" || v === 1;
/**
 * Review fix: `expect` = the values the admin's card loaded, for the fields it sends. One that no longer matches what's saved
 * (another admin changed it meanwhile) -> Refuse(409, E_STALE) and nothing is saved - a stale card can't silently reopen
 * sign-ups or undo a tier change.
 */
function staleCheck(expect, cur, curPrice, keys) {
  if (!expect || typeof expect !== "object") return;
  const norm = {
    signups: (v) => { try { return checkMode(v); } catch (e) { return { bad: String(v) }; } },
    invites_when_open: (v) => boolOf(v),
    expiry_days: (v) => Number(v),
    tiers: (v) => { try { return checkTiers(v); } catch (e) { return { bad: true }; } },
    price: (v) => (v === "" || v == null ? null : Number(String(v).replace(/[, _]/g, ""))),
  };
  for (const k of keys) {
    if (!(k in expect) || !norm[k]) continue;
    const have = k === "price" ? curPrice : cur[k];
    if (JSON.stringify(norm[k](expect[k])) !== JSON.stringify(have)) {
      throw new Refuse(409, "Another admin changed these settings since you loaded this card - reload it and try again (nothing was saved).", "E_STALE");
    }
  }
}
/**
 * Save settings (any subset of signups, invites_when_open, expiry_days, tiers, price) - validated first, then written in one
 * dbUtils.tx with their admin_audit rows. admin = {userId, username}. opts.expect: what the admin's card loaded (staleCheck).
 * -> {settings, price, changed: [keys]}. Throws Refuse.
 */
async function setSettings(admin, patch, { reason = null, expect = null } = {}) {
  await fresh();
  const p = patch || {};
  const want = {};
  if ("signups" in p) want.signups = checkMode(p.signups);
  if ("invites_when_open" in p) want.invites_when_open = boolOf(p.invites_when_open);
  if ("expiry_days" in p) want.expiry_days = checkExpiry(p.expiry_days);
  if ("tiers" in p) want.tiers = checkTiers(p.tiers);
  let newPrice = null;
  if ("price" in p && p.price !== "" && p.price != null) newPrice = checkPrice(p.price);
  const why = reason ? String(reason).replace(/[\r\n\t]+/g, " ").trim().slice(0, 200) : null;
  if (expect) {
    await load().catch((e) => console.error("[invites] reload:", e.message));   // compare with what's saved NOW (another process too)
    const pr0 = await price();
    staleCheck(expect, settings(), pr0 ? pr0.cost : null, [...Object.keys(want), ...(newPrice != null ? ["price"] : [])]);
  }
  const cur = settings();
  const changes = {};
  for (const k of Object.keys(want)) {
    const a = JSON.stringify(cur[k]), b = JSON.stringify(want[k]);
    if (a !== b) changes[k] = { from: cur[k], to: want[k] };
  }
  if (newPrice != null && !(await price())) await ensureShopItem();   // (before the transaction: it waits for the shop's schema)
  const pr = await price();
  if (newPrice != null && (!pr || pr.cost !== newPrice)) changes.price = { from: pr ? pr.cost : null, to: newPrice };
  if (!Object.keys(changes).length) return { settings: settings(), price: pr ? pr.cost : null, changed: [] };
  const t = now();
  await tx(async () => {
    for (const k of Object.keys(changes)) {
      if (k === "price") continue;
      await runQuery("INSERT INTO invite_settings (k, v, updated) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated = excluded.updated",
                     [k, JSON.stringify(changes[k].to), t]);
    }
    if (changes.price) {
      await runQuery("UPDATE prizes SET cost = ?, updated = ? WHERE prizeId = ? AND seller_id IS NULL", [changes.price.to, t, PRIZE_ID]);
    }
    const A = require("./adminaudit");
    if (changes.signups) await A.record(admin, AUDIT.signups, null, { from: changes.signups.from, to: changes.signups.to }, why);
    const rest = Object.keys(changes).filter((k) => k !== "signups");
    if (rest.length) await A.record(admin, AUDIT.settings, null, { changes: Object.fromEntries(rest.map((k) => [k, changes[k]])) }, why);
  });
  for (const k of Object.keys(changes)) if (k !== "price") S[k] = changes[k].to;
  loadedAt = now();
  if (changes.signups) console.log(`[invites] sign-ups ${changes.signups.to === "invite" ? "INVITE-ONLY" : "OPEN"} (by ${admin.username || admin.userId})`);
  const np = await price();
  return { settings: settings(), price: np ? np.cost : null, changed: Object.keys(changes) };
}

// ── pages ──
const stateOf = (r, at = now()) => (r.status === "pending" && Number(r.expires) <= at ? "expired" : r.status);
function publicRow(r, at) {
  const st = stateOf(r, at);
  return { id: r.id, state: st, code: st === "pending" ? formatCode(r.code) : null, link: st === "pending" ? linkOf(r.code) : null,
           created: r.created, expires: r.expires, used_at: r.used_at || null, revoked_at: r.revoked_at || null,
           used_by: r.used_name || null, house: !!Number(r.house) };
}
/** The member page: {mode, whenOpen, allowance, canCreate, why, price, expiryDays, pending, used, closed}. */
async function mine(userId, { req = null, at = now() } = {}) {
  const a = await allowance(userId, { at });
  // (review fix: house invites are staff's - they live on the admin card, not on an admin's own page)
  const rows = await getQuery(`SELECT i.*, u.username AS used_name FROM invites i LEFT JOIN users u ON u.userId = i.used_by
                               WHERE i.inviter_id = ? AND i.house = 0 ORDER BY i.id DESC LIMIT 300`, [String(userId)]);
  const list = rows.map((r) => publicRow(r, at));
  const why = a && (await inviterBlock(userId, { at })) ? { code: "E_BANNED", message: tr(req, "invites.err.banned_maker") } : createRefusal(a, req);
  const pr = await price();
  return { mode: S.signups, whenOpen: S.invites_when_open, allowance: a, canCreate: !why, why: why ? why.message : null, whyCode: why ? why.code : null,
           price: pr && pr.status === "active" ? pr.cost : null, prizeId: PRIZE_ID, expiryDays: S.expiry_days,
           pending: list.filter((r) => r.state === "pending"), used: list.filter((r) => r.state === "used"),
           closed: list.filter((r) => r.state === "expired" || r.state === "revoked").slice(0, 50) };
}
/** For the Settings hub: "n left" / "Unlimited" (null when unknown). */
async function hubState(userId) {
  const a = await allowance(userId);
  if (!a) return null;
  return a.unlimited ? { unlimited: true } : { left: a.left };
}

/** The admin card. */
async function adminView({ q = "", status = "", limit = 200 } = {}) {
  await fresh();
  const at = now();
  const where = [], args = [];
  const s = String(status || "");
  if (s === "pending") { where.push("i.status = 'pending' AND i.expires > ?"); args.push(at); }
  else if (s === "expired") { where.push("i.status = 'pending' AND i.expires <= ?"); args.push(at); }
  else if (s === "used" || s === "revoked") { where.push("i.status = ?"); args.push(s); }
  else if (s === "house") where.push("i.house = 1");
  const term = String(q || "").trim().replace(/^@/, "").slice(0, 64);
  if (term) {
    const code = normalize(term);
    where.push("(LOWER(a.username) = LOWER(?) OR LOWER(b.username) = LOWER(?)" + (code ? " OR i.code = ?" : "") + ")");
    args.push(term, term); if (code) args.push(code);
  }
  const rows = await getQuery(`SELECT i.*, a.username AS inviter, b.username AS invitee FROM invites i
                               LEFT JOIN users a ON a.userId = i.inviter_id LEFT JOIN users b ON b.userId = i.used_by
                               ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY i.id DESC LIMIT ?`, [...args, Math.min(500, Math.max(1, limit | 0))]);
  const c = (await getQuery(`SELECT
      COALESCE(SUM(CASE WHEN status = 'pending' AND expires > ? THEN 1 ELSE 0 END), 0) AS pending,
      COALESCE(SUM(CASE WHEN status = 'pending' AND expires <= ? THEN 1 ELSE 0 END), 0) AS expired,
      COALESCE(SUM(CASE WHEN status = 'used' THEN 1 ELSE 0 END), 0) AS used,
      COALESCE(SUM(CASE WHEN status = 'revoked' THEN 1 ELSE 0 END), 0) AS revoked,
      COALESCE(SUM(house), 0) AS house FROM invites`, [at, at]))[0] || {};
  const g = await getQuery("SELECT kind, COALESCE(SUM(amount), 0) AS n FROM invite_grants GROUP BY kind");
  const grants = await getQuery(`SELECT g.id, g.kind, g.amount, g.ref, g.at, g.note, u.username, b.username AS by_name FROM invite_grants g
                                 LEFT JOIN users u ON u.userId = g.user_id LEFT JOIN users b ON b.userId = g.by_id ORDER BY g.id DESC LIMIT 50`);
  const A = require("./adminaudit");
  const audit = [];
  for (const a of Object.values(AUDIT)) for (const r of await A.recent(a, 15).catch(() => [])) audit.push({ action: a, ...r });
  audit.sort((x, y) => y.at - x.at);
  const pr = await price();
  return {
    settings: { ...settings(), tiers_text: tiersText(S.tiers) }, price: pr ? pr.cost : null, prize_status: pr ? pr.status : null, prize_id: PRIZE_ID,
    limits: { expiry_min: EXPIRY_MIN, expiry_max: EXPIRY_MAX, tiers_max: TIERS_MAX, level_max: LEVEL_MAX, grant_max: GRANT_MAX, max_pending: MAX_PENDING, price_max: PRICE_MAX },
    stats: { pending: Number(c.pending) || 0, expired: Number(c.expired) || 0, used: Number(c.used) || 0, revoked: Number(c.revoked) || 0, house: Number(c.house) || 0,
             bought: Number((g.find((x) => x.kind === "bought") || {}).n) || 0, issued: Number((g.find((x) => x.kind === "admin") || {}).n) || 0 },
    invites: rows.map((r) => ({ id: r.id, state: stateOf(r, at), code: formatCode(r.code), link: stateOf(r, at) === "pending" ? linkOf(r.code) : null,
                                inviter: r.inviter || null, invitee: r.invitee || null, house: !!Number(r.house), created: r.created, expires: r.expires,
                                used_at: r.used_at, revoked_at: r.revoked_at, note: r.note || null })),
    grants, audit: audit.slice(0, 40),
  };
}

// ── routes ──
function register(app, { addUser }) {
  init().then(() => ensureUserCols()).then(() => ensureShopItem()).catch((e) => console.error("[invites] setup:", e.message));
  const guard = require("./middleware/authGuard");
  const SP = require("./siteperms");
  const fetchOk = (req) => guard.sameSite(req) && req.get("X-Requested-With") === "fetch";
  const fail = (res, e, what) => {
    if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, code: e.code || null, error: e.message });
    console.error(`[invites] ${what}:`, e && e.message);
    return res.status(500).json({ ok: false, error: "Something went wrong - try again." });
  };

  // the invite link: park the code, then the sign-up page (it shows who invited them)
  app.get("/signup", (req, res) => {
    const c = capture(req);
    const next = guard.safeNext(req.query.next);
    const q = new URLSearchParams();
    if (next) q.set("next", next);
    if (c.given && !c.code) q.set("invite", String(req.query.invite).slice(0, 60));   // a malformed code: the sign-up page says so
    const qs = q.toString();
    res.redirect(302, "/register" + (qs ? "?" + qs : ""));
  });

  // ── members ──
  app.get("/settings/invites", addUser, async (req, res, next) => {
    try {
      if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent("/settings/invites"));
      res.set("Cache-Control", "private, no-store");
      const data = await mine(req.user.userId, { req });
      if (!data.allowance) return res.redirect("/login?next=" + encodeURIComponent("/settings/invites"));
      const made = parseInt(req.query.made, 10) || null;
      res.render("settingsInvites", { user: req.user.username, inv: data, made });
    } catch (e) { next(e); }
  });
  app.post("/api/invites", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: tr(req, "invites.err.sign_in") });
    if (!fetchOk(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    try {
      if (await require("./autoaccount").isAutoAccount(req.user.userId)) throw new Refuse(403, tr(req, "invites.err.no_account"), "E_AUTO");
      res.json({ ok: true, invite: await create(req.user, { req }) });
    } catch (e) { fail(res, e, "create"); }
  });
  app.post("/api/invites/:id/revoke", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: tr(req, "invites.err.sign_in") });
    if (!fetchOk(req)) return res.status(403).json({ ok: false, error: "cross-site request refused" });
    try { await revoke(req.user, req.params.id, { req }); res.json({ ok: true }); } catch (e) { fail(res, e, "revoke"); }
  });

  // ── admins ──
  const admin = async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) { res.status(401).json({ ok: false, error: "Sign in first." }); return null; }
    const row = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]).catch(() => []))[0];
    if (!SP.can(row, CAP)) { res.status(403).json({ ok: false, error: "Admins only." }); return null; }
    if (req.method === "POST" && !fetchOk(req)) { res.status(403).json({ ok: false, error: "cross-site request refused" }); return null; }
    return row;
  };
  app.get("/api/admin/invites", addUser, async (req, res) => {
    const me = await admin(req, res); if (!me) return;
    try { res.json({ ok: true, ...(await adminView({ q: req.query.q, status: req.query.status })) }); } catch (e) { fail(res, e, "admin view"); }
  });
  app.post("/api/admin/invites/settings", addUser, async (req, res) => {
    const me = await admin(req, res); if (!me) return;
    const b = req.body || {};
    const patch = {};
    for (const k of ["signups", "invites_when_open", "expiry_days", "tiers", "price"]) if (k in b) patch[k] = b[k];
    const expect = b.expect && typeof b.expect === "object" && !Array.isArray(b.expect) ? b.expect : null;
    try { res.json({ ok: true, ...(await setSettings(me, patch, { reason: b.reason, expect })) }); } catch (e) { fail(res, e, "settings"); }
  });
  app.post("/api/admin/invites/grant", addUser, async (req, res) => {
    const me = await admin(req, res); if (!me) return;
    const b = req.body || {};
    try { const r = await adminGrant(me, { username: b.username, amount: b.amount, reason: b.reason }); res.json({ ok: true, username: r.user.username, amount: r.amount, admin_total: r.admin_total, left: r.left }); }
    catch (e) { fail(res, e, "grant"); }
  });
  app.post("/api/admin/invites/house", addUser, async (req, res) => {
    const me = await admin(req, res); if (!me) return;
    const b = req.body || {};
    try {
      const why = String(b.reason || b.note || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 200);
      if (why.length < 3) throw new Refuse(400, "Say who it's for (it goes in the admin log).", "E_REASON");
      const inv = await create(me, { house: true, note: why, req });
      await require("./adminaudit").record(me, AUDIT.house, null, { invite_id: inv.id, expires: inv.expires }, why);
      res.json({ ok: true, invite: inv });
    } catch (e) { fail(res, e, "house"); }
  });
  app.post("/api/admin/invites/:id/revoke", addUser, async (req, res) => {
    const me = await admin(req, res); if (!me) return;
    const b = req.body || {};
    try {
      const why = String(b.reason || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 200) || null;
      const row = await revoke(me, req.params.id, { admin: true, req });
      const inviter = (await getQuery("SELECT userId, username FROM users WHERE userId = ?", [row.inviter_id]))[0] || { userId: row.inviter_id, username: null };
      await require("./adminaudit").record(me, AUDIT.revoke, inviter, { invite_id: row.id }, why);
      res.json({ ok: true });
    } catch (e) { fail(res, e, "admin revoke"); }
  });
}

module.exports = {
  init, register, fresh, mode, inviteOnly, settings, checkMode, checkExpiry, checkTiers, tiersText, tierSum, allowance, createRefusal,
  create, revoke, byCode, check, gate, withInvite, refuseOauth, viewState, viewMw, captureMw, capture, sessionCode,
  markShadow, shadowGate, grantInTx, buyRefusal, adminGrant, ensureShopItem, price, setSettings, mine, hubState, adminView,
  newCode, normalize, formatCode, linkOf, echo, isPrize, ensureUserCols,
  inviterBlock, webSignedIn, chatOnly, chatSignInRefused,           // review fixes: bans / deletions, chat-only accounts, !signin
  CAP, PRIZE_ID, PRIZE_KEY, DEFAULT_PRICE, DEFAULTS, MAX_PENDING, LOOK_MAX, AUDIT, POOLS, Refuse,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _reload: () => load(),
  _resetLimits: () => { lookLimit = newLookLimit(); createLimit = newCreateLimit(); },
};
