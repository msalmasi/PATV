// siteban.js — banfix (owner report 2026-11-16: "Site bans don't seem to block users from the site ... if I schedule a banned
// account for deletion, they can keep signing back in to prevent deletion"): ONE rule for "this account is locked out of PATV",
// read by every place that lets an account in or acts for it.
//
//   the rule     a SITE BAN = a feed_bans row with room_id '' (the whole site) whose `until` is NULL (for good) or in the future -
//                what staff make with the person menu's / profile's "Site ban…", /feed/admin and the report actions (feedstore.ban,
//                scope 'site'), and what padbans.linked / an account merge can write too. The same predicate telegram.siteBanned and
//                invites.inviterBlock read (they call activeBan now). A pad's ban (room_id = the pad) is not a site ban. A temporary
//                ban ends on its own: every read compares `until` with the clock (cached locks too), and the feed sweep deletes
//                the expired rows later - no manual step.
//   lockOf       the lock an account is under right now, or null: {kind:'ban', until, reason, at} (and, only while
//                ADMIN_DELETION_LOCKS is on, {kind:'deletion', execute_at} for a pending ADMIN-scheduled deletion). One primary-key
//                lookup of feed_bans (the users row only for a hit: the exemption), cached CACHE_MS per account; feedstore.ban /
//                unban, padbans.linked and the merge call forget() so a change in this process is immediate, one made by another
//                process (a CLI tool) lands within 5 s. sessions.signIn and the chat link's redemption read it fresh.
//   who's exempt (decision D1) the Admin class and the owner (siteperms-core classRank >= EXEMPT_MIN_RANK = 3) are never locked out
//                by a site ban, so a stray or hostile ban can't lock the people who lift bans out of the site. Banning yourself or
//                your alt was already impossible (staffrank.assert), and only the owner can ban an Admin at all - so the case is a
//                ban made before the rank rule, or an Admin banned by the owner: demote them first (staffroles), then the ban
//                bites. Staff and Assistants CAN be locked out (only a higher rank can ban them).
//   where it bites
//     sign-in    sessions.signIn refuses a locked account before anything is issued (no session row, no cookie, no "signing in
//                cancels the deletion"): every method goes through it - password, sign-up, Google, Apple, Telegram, Plex, Twitch,
//                Discord, the !signin chat link, !signup claim links. user.controller.finishLogin and the Twitch / Discord
//                callbacks also ask first (assertSignIn) so nothing runs before the refusal (an archived account isn't brought
//                back, a provider id isn't linked). The error is {status 403, code 'banned', until}: callers show its message
//                (isRefusal - a network ban's 'network' refusal the same way).
//     sessions   sessions.gate: a valid login cookie of a locked account is a signed-out request from its NEXT request on (the
//                cookie is cleared, req.cookies.jwt removed - every page, API and write below sees no login: bounties, the feed,
//                DMs, stories, comments, the casino, markets, uploads, the chat ticket, the nav counts), and its sessions are ended
//                (revokeAll why 'ban', at most once per REVOKE_EVERY_MS per account in this process). req.siteLock carries the
//                lock, so the page that request opens can say why (flashMiddleware). hlsauth's sessions.userIdOfToken: null.
//     bots       the paths that act for an account WITHOUT a session refuse a locked one: Pepe's escrow games (escrow/games.act -
//                bounties, wagers, pools, loans; the wind-down verbs in WIND_DOWN stay allowed, Pepe's own verbs too), every
//                escrow stake (escrow/ledger.holdInTx: E_SITE_BANNED - a loan repayment, HOLD_OK_REASONS, still goes through),
//                the casino / lotto / stash / raffle / creator bot routers, Pepe's and Discord's tips (tips.transferPat), the
//                chat shop (shop.purchasePrize), the chat wheel spin, the queued web actions Pepe claims (actions.js,
//                bounties.js - failed at ban time and skipped at claim), a chat sign-in link (chatsignin.issue). Telegram's
//                bridge already treats a site-banned account as tier 'none' (telegram.tierOf).
//                banfix review: + the capital cluster (capital/service.act - CAPITAL_OK), the gangs (/api/gangs/bot/op - GANG_OK),
//                Pepe's generic charges (/api/wager/charge, /api/pat/charge - a fine / clawback passes: SYSTEM_CHARGE_RE), !boost;
//                and the BACKSTOP: ledger.post refuses a requireCover debit of a locked account unless opts.system (E_SITE_BANNED)
//     starting   banfix review: startLock = the ban, else a pending deletion PATV staff scheduled (whatever D3 says) - what the
//                bot paths, every escrow stake (E_DELETION_PENDING) and the "who may be named as judge / opponent" checks of a
//                new wager / pool / capital market ask, so nothing new holds a staff deletion off (partyText never says why)
//   not here     a refund, a payout, a settlement or the deletion job - credits and system moves never ask (an expiring bounty
//                still refunds a banned poster; an admin-scheduled deletion of a banned account runs at its time).
// Constants at the top are the knobs (D1..D4 in the banfix notes); docs/sessions.md "Site bans".
"use strict";
const { getQuery } = require("./dbUtils");
const core = require("./siteperms-core");

const EXEMPT_MIN_RANK = 3;                  // D1: Admin class (3) and the owner (an Admin-class account, rank 4) are never locked out
const ADMIN_DELETION_LOCKS = false;         // D3: true = a pending ADMIN-scheduled deletion also locks the account out until it runs
const SHOW_REASON = true;                   // D4: the ban's reason is part of the message (the ban sheet says "Reason (they see it)")
const CACHE_MS = 5000;                      // the same 5 s as sessions.js: a change by another process lands within this
const CACHE_MAX = 20000;
const REVOKE_EVERY_MS = 30000;              // the gate's revokeAll for a locked account, at most this often per account (one process)
// D2: what a banned account may still do through Pepe - wind down what it already has open (never start or add to anything).
// banfix review: + a judge's / a poster's call on what OTHER people hold - settle a wager or pool it judges (a judge never holds a
// position in it: wagers.create / pools.bet refuse that), resolve or reject the claims on its own bounty (the hunters are paid
// out of the pot that is there; nothing is added) - so the people who aren't banned get the payout they won, not a refund.
const WIND_DOWN = Object.freeze({
  bounties: Object.freeze(["cancel", "void", "resolve", "reject"]),
  wagers: Object.freeze(["decline", "cancel", "settle"]),
  pools: Object.freeze(["cancel", "settle"]),
  loans: Object.freeze(["decline", "cancel", "repay", "forgive"]),
});
const HOLD_OK_REASONS = Object.freeze(new Set(["loan-repayment"]));   // escrow holds that pay what is owed (a repayment, the due-date collection)
// the casino bot verbs a banned account may still send: reads and getting OUT (leave a table, cash out, fold, stand)
const CASINO_OK = Object.freeze(new Set(["", "help", "rules", "how", "fair", "info", "show", "table", "status", "list", "top", "standings", "me",
  "limits", "last", "bets", "cards", "hand", "hole", "leave", "quit", "cashout", "fold", "stand", "stay", "sitout", "unregister", "unadvertise",
  "unadvert"]));
const STASH_OK = Object.freeze(new Set(["withdraw", "close"]));
// banfix review (bot paths): the capital cluster's and the gangs' verbs a banned account may still send through Pepe - getting out
// (sell a position, cancel its own market, a judge's call on positions others hold, repay, unstake; leave / defect / take its
// allowance out of the treasury / hand the gang over / disband it). Pepe's own verbs (actor.pepe / the 'pepe' ops) never ask.
const CAPITAL_OK = Object.freeze({
  markets: Object.freeze(["sell", "cancel", "settle"]),
  reserve: Object.freeze(["repay"]),
  vaults: Object.freeze(["unstake"]),
});
const GANG_OK = Object.freeze(new Set(["decline", "leave", "defect", "withdraw", "boss", "disband"]));
const GANG_PEPE_OPS = Object.freeze(new Set(["spend", "move", "patch"]));
// Pepe's generic charges (/api/wager/charge, /api/pat/charge) that are NOT the account acting: a moderator's fine, a market
// re-settle's clawback, Room Wars' rehearsal return - they still go through for a banned account
const SYSTEM_CHARGE_RE = /^(modfine|rw-rehearsal-return)$|clawback/i;

let clock = () => Date.now();
const now = () => clock();
const EN = require("./locales/en.json");
let enT = null;
const english = () => (enT || (enT = require("./i18n-core")(EN, EN, "en")));

// ── the rule ──
/** The live site ban on an account (no exemption here): {until, reason, at, by} | null. A database without feed_bans: null. */
async function activeBan(userId, t = now()) {
  const id = String(userId == null ? "" : userId);
  if (!id) return null;
  try {
    // (SELECT *: an older / test feed_bans may lack reason / at / by - the rule needs only user_id, room_id, until)
    const r = (await getQuery("SELECT * FROM feed_bans WHERE user_id = ? AND room_id = '' AND (until IS NULL OR until > ?) LIMIT 1", [id, t]))[0];
    return r ? { until: r.until == null ? null : Number(r.until), reason: r.reason || null, at: r.at == null ? null : Number(r.at), by: r.by || null } : null;
  } catch (e) {
    if (/no such table/i.test(String(e && e.message))) return null;
    throw e;
  }
}

const cache = new Map();                     // userId -> {lock, at}
function stillOn(lock, t = now()) {
  if (!lock) return null;
  if (lock.kind === "ban" && lock.until != null && lock.until <= t) return null;          // a temporary ban that just ended
  return lock;
}
/** An admin-scheduled deletion that is still pending (only read while ADMIN_DELETION_LOCKS is on). */
async function adminDeletion(id) {
  try {
    const r = (await getQuery(`SELECT execute_at FROM account_deletions WHERE user_id = ? AND state IN ('scheduled','held') AND requested_by LIKE 'admin:%'
                               ORDER BY id DESC LIMIT 1`, [id]))[0];
    return r ? { kind: "deletion", execute_at: Number(r.execute_at) || null } : null;
  } catch (e) {
    if (/no such table/i.test(String(e && e.message))) return null;
    throw e;
  }
}
async function readLock(id, t) {
  // the ban first (one primary-key lookup - most accounts have none), the account row (its class: the exemption) only for a hit.
  // (SELECT *: test / older databases may lack columns; a users row is read at most once per CACHE_MS per locked account)
  const ban = await activeBan(id, t);
  const lock = ban ? { kind: "ban", until: ban.until, reason: ban.reason, at: ban.at }
    : ADMIN_DELETION_LOCKS ? await adminDeletion(id) : null;
  if (!lock) return null;
  const u = (await getQuery("SELECT * FROM users WHERE userId = ?", [id]))[0];
  if (!u) return null;                                        // no such account: the other checks (a deleted / merged account) answer
  if (core.classRank(u) >= EXEMPT_MIN_RANK) return null;      // D1: an Admin / the owner
  return lock;
}

/** The lock this account is under now ({kind:'ban'|'deletion', ...}) or null. Throws on a database error (callers decide). */
async function lockOf(userId, { fresh = false } = {}) {
  const id = String(userId == null ? "" : userId);
  if (!id) return null;
  const t = now();
  if (!fresh) {
    const c = cache.get(id);
    if (c && t - c.at < CACHE_MS) return stillOn(c.lock, t);
  }
  const lock = await readLock(id, t);
  cache.set(id, { lock, at: t });
  if (cache.size > CACHE_MAX) for (const k of [...cache.keys()].slice(0, cache.size - CACHE_MAX / 2)) cache.delete(k);
  return stillOn(lock, t);
}
/** A ban / unban / merge / deletion scheduled or cancelled in this process: the next read is fresh. No id = everyone. */
function forget(userId) {
  if (userId == null) { cache.clear(); delCache.clear(); return; }
  cache.delete(String(userId));
  delCache.delete(String(userId));
}

// ── banfix review (finding 2): what may START something ──
const delCache = new Map();                  // userId -> {lock, at}
/** A pending ADMIN-scheduled deletion of this account, whatever D3 says (cached CACHE_MS): {kind:'deletion', execute_at} | null. */
async function deletionLock(userId) {
  const id = String(userId == null ? "" : userId);
  if (!id) return null;
  const t = now();
  const c = delCache.get(id);
  if (c && t - c.at < CACHE_MS) return c.lock;
  const lock = await adminDeletion(id);
  delCache.set(id, { lock, at: t });
  if (delCache.size > CACHE_MAX) for (const k of [...delCache.keys()].slice(0, delCache.size - CACHE_MAX / 2)) delCache.delete(k);
  return lock;
}
/** What stops this account STARTING anything - a new escrow stake, a game, a market, a gang, a paid Pepe command - or being
 *  named as someone's judge / opponent: its site ban (lockOf), else a pending deletion PATV staff scheduled (nobody - the member
 *  while they can still sign in, or a friend naming them - can put new things in the way of that deletion; winding down what is
 *  already open still works). -> lock | null. Throws on a database error (callers decide). */
async function startLock(userId) {
  return (await lockOf(userId)) || (await deletionLock(userId));
}
/** Is this Pepe charge reason one that isn't the account acting (a fine, a clawback - SYSTEM_CHARGE_RE)? */
const systemCharge = (reason) => SYSTEM_CHARGE_RE.test(String(reason || ""));
/** Is this capital verb one a banned account may still send (CAPITAL_OK)? */
const capitalOk = (engine, verb) => (CAPITAL_OK[engine] || []).includes(String(verb || "").toLowerCase());

// ── the words ──
const whenText = (ms) => new Date(Number(ms)).toISOString().slice(0, 16).replace("T", " ") + " UTC";
/** The message for a lock, in the viewer's language (t = req.t; English without one). Plain text (callers escape it). */
function message(lock, t) {
  const tr = typeof t === "function" ? t : english();
  if (!lock) return "";
  if (lock.kind === "deletion") return tr("siteban.deletion", { when: lock.execute_at ? whenText(lock.execute_at) : "" });
  let s = lock.until != null ? tr("siteban.banned_until", { when: whenText(lock.until) }) : tr("siteban.banned");
  if (SHOW_REASON && lock.reason) s += " " + tr("siteban.reason", { reason: String(lock.reason).slice(0, 200) });
  return s;
}
const tOf = (req) => (req && typeof req.t === "function" ? req.t : null);
/** The sign-in refusal: an Error the sign-in callers show as itself (isRefusal). */
function signInError(lock, req) {
  const e = new Error(message(lock, tOf(req)));
  e.status = 403;
  e.code = "banned";
  e.kind = lock.kind;
  e.until = lock.kind === "ban" ? lock.until : lock.execute_at || null;
  e.refuse = true;
  return e;
}
/** Before a sign-in does anything (finishLogin, the Twitch / Discord callbacks): throws signInError for a locked account. */
async function assertSignIn(user, req) {
  const lock = user && user.userId ? await lockOf(user.userId) : null;
  if (lock) throw signInError(lock, req);
}
/** A sign-in refusal to show as itself: this lock, or a network ban (netban.js via sessions.signIn). */
const isRefusal = (e) => !!e && (e.code === "banned" || e.code === "network");
/** What a bot route answers for a locked account (every family's field: escrow `error`, casino `reply`, polls `msg`). */
function botRefusal(lock) {
  const text = botText(lock);
  return { ok: false, code: lock && lock.kind === "deletion" ? "deleting" : "banned", error: text, reply: text, msg: text, message: text,
           until: lock && lock.kind === "ban" ? lock.until : null };
}
/** The bot paths' one line (English: Pepe shows it in chat). A pending staff deletion has its own words. */
const botText = (lock) => english()(lock && lock.kind === "deletion" ? "siteban.bot_deletion" : "siteban.bot");
/** The refusal when someone names this account as a judge / opponent - never says why (a ban or a deletion is not theirs to know). */
const partyText = (name) => english()("siteban.party", { name: String(name || "").replace(/^@+/, "").slice(0, 60) || "?" });
/** Is this escrow game verb one a banned account may still use (wind down what it has open)? */
const windDownOk = (game, verb) => (WIND_DOWN[game] || []).includes(String(verb || "").toLowerCase());

// ── the queued web actions Pepe would run for the account (actions.js pepe_actions, bounties.js bounty_actions) ──
const QUEUED_FAIL = EN["siteban.queued_failed"];            // stored on the row (the account's own action list shows it)
/** SQL for the pepe_actions a locked account's queue keeps: Pepe's privacy jobs (privacy.forget / privacy.recdelete of a
 *  deletion, privacy.incognito) are the account's protection, never its action - they always run. */
const KEEP_KINDS_SQL = "kind LIKE 'privacy.%'";
/** A site ban was made (feedstore.ban, padbans.linked): fail the account's pending / claimed web actions in one transaction.
 *  -> {actions, bounties} rows failed. */
async function dropQueued(userId) {
  const id = String(userId == null ? "" : userId);
  if (!id) return { actions: 0, bounties: 0 };
  const { runQuery, tx } = require("./dbUtils");
  const t = now();
  const has = async (name) => (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [name])).length > 0;
  const [pa, ba] = [await has("pepe_actions"), await has("bounty_actions")];
  if (!pa && !ba) return { actions: 0, bounties: 0 };
  return tx(async () => {
    const a = pa ? await runQuery(`UPDATE pepe_actions SET status = 'failed', message = ?, updated = ? WHERE user_id = ? AND status IN ('pending','claimed')
                                   AND NOT (${KEEP_KINDS_SQL})`, [QUEUED_FAIL, t, id]) : null;
    const b = ba ? await runQuery("UPDATE bounty_actions SET status = 'failed', message = ?, updated = ? WHERE user_id = ? AND status IN ('pending','claimed')",
                                  [QUEUED_FAIL, t, id]) : null;
    return { actions: (a && a.changes) || 0, bounties: (b && b.changes) || 0 };
  });
}
/** At claim time (actions.js, bounties.js): which of these queued rows belong to a locked account (and aren't kept kinds)? -> Set of row ids */
async function lockedRows(rows, { keepKind = (k) => /^privacy\./.test(String(k || "")) } = {}) {
  const out = new Set();
  const seen = new Map();
  for (const r of rows || []) {
    if (!r || !r.user_id || keepKind(r.kind)) continue;
    const u = String(r.user_id);
    if (!seen.has(u)) {
      let l = null;
      try { l = await lockOf(u); } catch (e) { l = null; }          // a failed read hands it out as before (fail open, like the gate)
      seen.set(u, !!l);
    }
    if (seen.get(u)) out.add(r.id);
  }
  return out;
}

/** Middleware (index.js, after i18n): the HTML page a just-refused login opens says why (the login form shows it). */
function flashMiddleware(req, res, next) {
  try {
    const dest = req.get && req.get("sec-fetch-dest");         // page navigations only (a script's fetch never takes the flash)
    if (req.siteLock && req.method === "GET" && typeof req.flash === "function" && (!dest || dest === "document")
        && req.accepts(["html", "json"]) === "html" && !/^\/api\//.test(req.path || "")) {
      req.flash("error", message(req.siteLock, tOf(req)));
    }
  } catch (e) { /* the page still renders signed out */ }
  next();
}

module.exports = { activeBan, lockOf, forget, message, signInError, assertSignIn, isRefusal, botRefusal, botText, windDownOk, flashMiddleware, whenText,
                   dropQueued, lockedRows, QUEUED_FAIL,
                   deletionLock, startLock, systemCharge, capitalOk, partyText,                          // banfix review
                   EXEMPT_MIN_RANK, ADMIN_DELETION_LOCKS, SHOW_REASON, CACHE_MS, REVOKE_EVERY_MS, WIND_DOWN, HOLD_OK_REASONS, CASINO_OK, STASH_OK,
                   CAPITAL_OK, GANG_OK, GANG_PEPE_OPS, SYSTEM_CHARGE_RE,
                   _setClock: (f) => { clock = f || (() => Date.now()); }, _clear: () => { cache.clear(); delCache.clear(); } };
