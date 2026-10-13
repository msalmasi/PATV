// accountdelete.js — "Delete my account" (Settings → Account → Delete account), 1.99wj. The policy: docs/account-deletion.md.
//
// The flow:
//   1. GET /settings/account/delete       what deletion does, what still has to be closed first (blockers()), the form
//   2. POST /api/account/delete           {password?, confirm}: re-authentication (the password, or a FRESH sign-in - any method,
//                                         the chat link included - within sessions.FRESH_MS) + the username typed exactly. Refused
//                                         for admins / staff / moderators (another admin schedules it: POST /api/admin/users/:id/delete)
//                                         and while anything blocks. Schedules the deletion GRACE_MS (14 days) ahead, signs every
//                                         device out (sessions.revokeAll) and files a notice.
//   3. the grace: signing in again - any method - cancels it (sessions.signIn -> cancelOnSignIn) with a notice
//   4. the job (tick(), every 10 minutes): a due request runs execute(): blockers again (anything new -> 'held', retried; a
//                                         sign-in still cancels), the automatic settlements, then ONE transaction: the remaining
//                                         balance routed by the PAT Routing row "account_deleted" (default: the Fed), the profile
//                                         pseudonymised, personal rows deleted, posts / comments / DMs handled, the Camfrog login
//                                         released, Pepe asked to forget the login (website action "privacy.forget").
//
// PAT never vanishes: the wallet debit ("account-deleted") and its legs (pools when the site owns them, the House as jackpot rakes,
// else a negative Reserve claim Pepe's funding tick credits) are one transaction, keyed (account_deletion_routes, key
// acctdel-<userId>-<n>); a deleted account that is credited later (a late refund) is swept the same way by the tick.
//
//   account_deletions        id, user_id, state scheduled|held|cancelled|done, requested_at, execute_at, requested_by, reauth,
//                            reason, cancelled_at, cancel_via, held_reason, held_at, done_at, pseudonym, report (JSON counts)
//   account_deletion_routes  key PK, user_id, amount, legs (JSON), txid, at
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery, tx } = require("./dbUtils");

const DAY = 86400000;
const GRACE_MS = 14 * DAY;
const TICK_MS = 10 * 60000;
const FLOW = "account_deleted";              // the PAT Routing row
const FORGET_KIND = "privacy.forget";         // Pepe's website action (pepe_webact): forget this Camfrog login
const FORGET_TRIES = 10;
const FORGET_RETRY_MS = 6 * 3600000;

let clock = () => Date.now();
const now = () => clock();
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();

class Refuse extends Error {
  constructor(status, message, code, extra) { super(message); this.status = status; this.code = code || null; Object.assign(this, extra || {}); }
}

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS account_deletions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, state TEXT NOT NULL, requested_at INTEGER NOT NULL, execute_at INTEGER NOT NULL,
        requested_by TEXT, reauth TEXT, reason TEXT, cancelled_at INTEGER, cancel_via TEXT, held_reason TEXT, held_at INTEGER, done_at INTEGER,
        pseudonym TEXT, report TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS account_deletions_user ON account_deletions (user_id, state)");
      await runQuery("CREATE INDEX IF NOT EXISTS account_deletions_due ON account_deletions (state, execute_at)");
      await runQuery(`CREATE TABLE IF NOT EXISTS account_deletion_routes (
        key TEXT PRIMARY KEY, user_id TEXT NOT NULL, amount INTEGER NOT NULL, legs TEXT, txid TEXT, at INTEGER NOT NULL)`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const tableExists = async (t) => (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t])).length > 0;
const colsCache = new Map();
async function cols(t) {
  if (!colsCache.has(t)) colsCache.set(t, (await getQuery(`SELECT name FROM pragma_table_info('${String(t).replace(/'/g, "")}')`)).map((r) => r.name));
  return colsCache.get(t);
}
async function has(t, ...cs) { const c = await cols(t); return c.length > 0 && cs.every((x) => c.includes(x)); }
async function q(t, columns, sql, params) { return (await has(t, ...columns)) ? getQuery(sql, params) : []; }
async function run(t, columns, sql, params) {
  if (!(await has(t, ...columns))) return 0;
  const r = await runQuery(sql, params);
  return (r && r.changes) || 0;
}

/** Pending (scheduled / held) request of an account, or null. */
async function pendingOf(userId) {
  await init();
  return (await getQuery("SELECT * FROM account_deletions WHERE user_id = ? AND state IN ('scheduled','held') ORDER BY id DESC LIMIT 1", [String(userId)]))[0] || null;
}
async function isDeleted(userId) {
  await init();
  return (await getQuery("SELECT 1 FROM account_deletions WHERE user_id = ? AND state = 'done' LIMIT 1", [String(userId)])).length > 0;
}

// ── what has to happen first ──
// holdsFor reasons (staleaccounts.js) -> {label, href} for the "close these first" list. Auto-settled ones are not listed here.
const HOLD = {
  "loan": ["A loan (as lender or borrower) - repay it or wait until it's settled", "/wallet"],
  "loan request": ["An open loan request - cancel it", "/wallet"],
  "escrow hold": ["PAT held in escrow for a game, bet or challenge - finish or cancel it", "/wallet"],
  "escrow payout": ["An escrow payout still on its way to you - wait for it", "/wallet"],
  "gang member": ["You're in a gang - leave it first (!gang leave in chat)", "/gangs"],
  "market position": ["A position in an open market - sell it or wait for the result", "/markets"],
  "market creator/judge": ["A market you created or judge - resolve or cancel it", "/markets"],
  "market order": ["A market order still open - wait for it or cancel it", "/markets"],
  "bounty": ["An open bounty - finish or cancel it", "/bounties"],
  "wager": ["An open wager - settle or cancel it", "/wagers"],
  "lotto ticket": ["A lotto ticket in a draw that hasn't paid out yet", "/lotto"],
  "room owner": ["You own a pad - transfer it to someone or delete it", "/pads/mine"],
  "stage slot": ["A stage slot that isn't settled yet", "/stage"],
  "open shop order": ["An open shop order (as buyer or seller) - complete or cancel it", "/shop/orders"],
  "shop listing": ["An active shop listing - take it down", "/shop/orders"],
  "cosmetic listing": ["A cosmetic for sale - take the listing down", "/cosmetics"],
  "stash": ["A stash with other members or staked PAT - withdraw your PAT and close it", "/wallet"],
};
const SETTLED_HOLDS = new Set(["pending welcome bonus", "pending Camfrog link"]);

/** Admins / staff / moderators can't delete themselves (chatsignin.elevated: a class other than a member, or a staff role). */
async function elevated(user) { return require("./chatsignin").elevated(user); }

/** The sole-owned, unstaked stashes of a login while the site owns stashes (these are auto-settled). -> {auto:[], block:bool} */
async function stashPlan(login) {
  const out = { auto: [], block: false, live: false };
  if (!login || !(await tableExists("stashes"))) return out;
  try { out.live = !!(await require("./stashes").live()); } catch (e) { out.live = false; }
  const owned = await getQuery("SELECT id, balance, staked FROM stashes WHERE owner = ? AND closed IS NULL", [login]);
  const member = (await tableExists("stash_members")) ? await getQuery(`SELECT s.id FROM stash_members m JOIN stashes s ON s.id = m.stash_id
                                                                         WHERE m.login = ? AND s.closed IS NULL AND s.owner != ?`, [login, login]) : [];
  if (member.length) out.block = true;                       // a member of someone else's stash: leave it
  for (const s of owned) {
    const others = (await tableExists("stash_members")) ? (await getQuery("SELECT COUNT(*) AS n FROM stash_members WHERE stash_id = ? AND login != ?", [s.id, login]))[0].n : 0;
    if (!out.live || others > 0 || Number(s.staked) > 0) { if (Number(s.balance) > 0 || Number(s.staked) > 0 || others > 0) out.block = true; continue; }
    out.auto.push(s);
  }
  return out;
}

/**
 * What stops a deletion, and what will be settled automatically. -> {block: [{code, label, href}], settle: [{code, label}]}
 * Blocks: anything owed TO other people or still in flight (loans, escrow, bets, markets, wagers, bounties, lotto, orders,
 * listings, stage bookings, a card subscription, active subscribers, a cloned voice), pads you own, a negative balance.
 * Settled: renewals stop, pending links / welcome bonus go, sole-owned stashes are emptied into the routing.
 */
async function blockers(userId, { now: t = now() } = {}) {
  const uid = String(userId);
  const block = [], settle = [];
  const B = (code, label, href) => { if (!block.some((x) => x.code === code)) block.push({ code, label, href: href || null }); };
  const S = (code, label) => { if (!settle.some((x) => x.code === code)) settle.push({ code, label }); };
  const u = (await getQuery("SELECT userId, username, class, camfrogUsername, points_balance FROM users WHERE userId = ?", [uid]))[0];
  if (!u) return { block: [{ code: "gone", label: "No such account" }], settle };
  const login = low(u.camfrogUsername) || null;
  if (Number(u.points_balance) < 0) B("negative", "Your balance is below zero - it has to be back at 0 or more", "/wallet");
  // pads you own (a profile pad is part of the account, not a pad)
  for (const r of await q("rooms_registry", ["owner_user_id"], "SELECT room_id, slug, title FROM rooms_registry WHERE owner_user_id = ? AND room_id NOT LIKE 'user:%'", [uid])) {
    B("pad:" + r.room_id, `Your pad “${r.title || r.slug || r.room_id}” - transfer it to someone or delete it`, "/p/" + encodeURIComponent(r.slug || r.room_id) + "/settings");
  }
  // the shared "in flight" check (the same one merges and the stale cleanup use)
  let holds = [];
  try { holds = await require("./staleaccounts").holdsFor(uid, { now: t }); } catch (e) { holds = ["(couldn't check everything - try again)"]; }
  const sp = await stashPlan(login);
  for (const h of holds) {
    if (SETTLED_HOLDS.has(h)) { S(h === "pending welcome bonus" ? "welcome" : "cflink", h === "pending welcome bonus" ? "Your pending welcome bonus is cancelled" : "A pending Camfrog link is cancelled"); continue; }
    if (h === "stash" && !sp.block) continue;                // only stashes the routing can take on its own
    if (h === "room owner") continue;                         // listed per pad above
    const m = HOLD[h] || [h, null];
    B("hold:" + h, m[0], m[1]);
  }
  if (sp.block) B("hold:stash", HOLD.stash[0], HOLD.stash[1]);
  if (sp.auto.some((s) => Number(s.balance) > 0)) S("stash", "The PAT in your stashes goes with your balance (to the PAT Routing destination)");
  // site-native things in flight
  if ((await q("escrow_holds", ["user_id", "state"], "SELECT 1 FROM escrow_holds WHERE user_id = ? AND state = 'held' LIMIT 1", [uid])).length) B("hold:escrow hold", HOLD["escrow hold"][0], "/wallet");
  if ((await q("lotto_tickets", ["userId", "draw"], `SELECT 1 FROM lotto_tickets t JOIN lotto_draws d ON d.draw = t.draw WHERE t.userId = ? AND d.state IN ('selling','closed','drawn') LIMIT 1`, [uid]).catch(() => [])).length) B("hold:lotto ticket", HOLD["lotto ticket"][0], "/lotto");
  if ((await q("heist_market_listings", ["seller_id", "status"], "SELECT 1 FROM heist_market_listings WHERE (seller_id = ? OR buyer_id = ? OR holder_id = ?) AND status IN ('open','listed','pending','sold_pending','held') LIMIT 1", [uid, uid, uid])).length) B("heist", "A heist market listing that's still open - cancel it", "/gtf/market");
  if ((await q("stage_queue", ["userId", "status"], "SELECT 1 FROM stage_queue WHERE userId = ? AND status IN ('queued','waiting','pending','scheduled') LIMIT 1", [uid])).length) B("stagequeue", "A stage booking in the queue - cancel it", "/stage");
  if ((await q("media_bookings", ["user_id", "state"], "SELECT 1 FROM media_bookings WHERE user_id = ? AND state IN ('booked','pending','scheduled','queued','playing') LIMIT 1", [uid])).length) B("mediabooking", "A 📼 Plex booking that hasn't played yet - cancel it", "/plex");
  if ((await q("banner_bookings", ["user_id", "status"], "SELECT 1 FROM banner_bookings WHERE user_id = ? AND status IN ('pending','approved','live','scheduled') LIMIT 1", [uid])).length) B("banner", "A homepage banner booking that hasn't run yet - cancel it", "/banner");
  if ((await q("creator_subs", ["creator_id", "status"], "SELECT 1 FROM creator_subs WHERE creator_id = ? AND status IN ('active','grace') LIMIT 1", [uid])).length) B("creator", "People subscribe to you as a creator - pause your creator page so their subscriptions end", "/creator");
  if ((await q("premium_subs", ["stripe_sub", "status"], "SELECT 1 FROM premium_subs WHERE (target = ? OR renewer_id = ? OR stripe_user = ?) AND stripe_sub IS NOT NULL AND status IN ('active','grace') LIMIT 1", [uid, uid, uid])).length) B("card", "A card subscription (real money) - cancel it first so you aren't charged again", "/subscriptions");
  if ((await q("voices", ["owner_user_id", "status"], "SELECT 1 FROM voices WHERE owner_user_id = ? AND status NOT IN ('removed','revoked') LIMIT 1", [uid])).length) B("voice", "Your cloned voice is in the voice store - revoke it first", "/voices/mine");
  if ((await q("gang_members", ["userId"], "SELECT 1 FROM gang_members WHERE userId = ? LIMIT 1", [uid])).length) B("hold:gang member", HOLD["gang member"][0], "/gangs");
  // settled automatically
  if ((await q("creator_subs", ["fan_id", "status"], "SELECT 1 FROM creator_subs WHERE fan_id = ? AND status IN ('active','grace') LIMIT 1", [uid])).length) S("fansubs", "Your creator subscriptions stop renewing");
  if ((await q("shop_subs", ["user_id", "status"], "SELECT 1 FROM shop_subs WHERE user_id = ? AND status IN ('active','grace') LIMIT 1", [uid])).length) S("shopsubs", "Your store subscriptions stop renewing");
  if ((await q("premium_subs", ["renewer_id"], "SELECT 1 FROM premium_subs WHERE renewer_id = ? AND stripe_sub IS NULL LIMIT 1", [uid])).length) S("premium", "Prime Time / Season Pass renewals you pay for stop");
  if (Math.floor(Number(u.points_balance) || 0) > 0) S("balance", "Your balance goes to the PAT Routing destination (by default the Federal Reserve)");
  return { block, settle };
}

// ── the request ──
async function verifyPassword(userId, password) {
  if (typeof password !== "string" || !password) return false;
  const r = (await getQuery("SELECT password FROM users WHERE userId = ?", [String(userId)]))[0];
  if (!r || !r.password) return false;
  try { return await require("bcrypt").compare(password, r.password); } catch (e) { return false; }
}

/**
 * The member's own request. -> {ok, execute_at}. Throws Refuse (status, message, code) - E_ELEVATED, E_BLOCKED (with .block),
 * E_REAUTH, E_CONFIRM, E_PENDING.
 */
async function request(req, { password, confirm } = {}) {
  await init();
  const uid = String(req.user.userId);
  const u = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [uid]))[0];
  if (!u) throw new Refuse(404, "No such account.", "E_GONE");
  if (await elevated(u)) throw new Refuse(403, "Admin, staff and moderator accounts can't delete themselves. Ask another admin to do it.", "E_ELEVATED");
  if (await pendingOf(uid)) throw new Refuse(409, "Your account is already scheduled for deletion.", "E_PENDING");
  if (String(confirm == null ? "" : confirm).trim() !== u.username) throw new Refuse(400, "Type your username exactly to confirm.", "E_CONFIRM");
  let reauth = null;
  if (password) { if (await verifyPassword(uid, password)) reauth = "password"; else throw new Refuse(403, "That password isn't right.", "E_REAUTH"); }
  else if (await require("./sessions").isFresh(req)) reauth = "fresh-sign-in";
  if (!reauth) throw new Refuse(403, "Confirm it's you: enter your password, or sign out and sign back in (any way you like - Google, Plex, Telegram, Twitch, Discord or a !signin chat link) and delete within 10 minutes.", "E_REAUTH");
  const b = await blockers(uid);
  if (b.block.length) throw new Refuse(409, "Some things have to be closed first.", "E_BLOCKED", { block: b.block });
  return schedule(u, { by: "self", reauth });
}

async function schedule(u, { by = "self", reauth = null, reason = null } = {}) {
  const t = now();
  const at = t + GRACE_MS;
  await runQuery(`INSERT INTO account_deletions (user_id, state, requested_at, execute_at, requested_by, reauth, reason) VALUES (?, 'scheduled', ?, ?, ?, ?, ?)`,
                 [String(u.userId), t, at, String(by).slice(0, 80), reauth, reason ? String(reason).slice(0, 200) : null]);
  await require("./sessions").revokeAll(u.userId, { why: "account deletion requested" });
  await require("./inbox").addSafe(u.userId, { kind: "system", title: "Your account is scheduled for deletion",
    body: `Your PATV account will be deleted on ${new Date(at).toISOString().slice(0, 10)}. Every device was signed out. Changed your mind? Just sign in again before then - that cancels it.`,
    link: "/settings/account#delete", ref: `acctdel:req:${t}` });
  console.log(`[acctdel] ${u.username} scheduled for ${new Date(at).toISOString()} (by ${by})`);
  return { ok: true, execute_at: at };
}

/** A sign-in during the grace period cancels the deletion (sessions.signIn). */
async function cancelOnSignIn(userId, method) {
  await init();
  const p = await pendingOf(userId);
  if (!p) return false;
  const r = await runQuery("UPDATE account_deletions SET state = 'cancelled', cancelled_at = ?, cancel_via = ? WHERE id = ? AND state IN ('scheduled','held')",
                           [now(), "sign-in:" + String(method || "?").slice(0, 20), p.id]);
  if (!r || !r.changes) return false;
  await require("./inbox").addSafe(userId, { kind: "system", title: "Account deletion cancelled",
    body: "You signed in, so your account will NOT be deleted. If you still want it gone, ask again in Settings → Account.", link: "/settings/account#delete",
    ref: `acctdel:cancel:${p.id}` });
  console.log(`[acctdel] ${userId} cancelled by a sign-in (${method})`);
  return true;
}

// ── the routing (PAT is points: it never vanishes from supply) ──
async function shares() {
  try {
    const st = await require("./econstore").getSettings();
    if (st && st.pat_routes && Array.isArray(st.pat_routes[FLOW])) return st.pat_routes[FLOW];
  } catch (e) { /* no econ store */ }
  try {
    const row = (await getQuery("SELECT data FROM econ_catalog WHERE id = 1"))[0];
    const d = row && row.data ? JSON.parse(row.data) : null;
    const def = d && d.routes && d.routes[FLOW] && d.routes[FLOW].default;
    if (Array.isArray(def) && def.length) return def;
  } catch (e) { /* no catalog */ }
  return [["reserve", 100]];                    // the Federal Reserve, like the stale-account cleanup
}

/** INSIDE a transaction: move the account's whole-PAT balance out by the routing row, keyed. -> {amount, legs, key} | null */
async function routeBalanceInTx(userId, key) {
  const done = (await getQuery("SELECT amount, legs FROM account_deletion_routes WHERE key = ?", [key]))[0];
  if (done) return { amount: Number(done.amount), legs: JSON.parse(done.legs || "[]"), key, dup: true };
  const u = (await getQuery("SELECT points_balance FROM users WHERE userId = ?", [String(userId)]))[0];
  const amount = Math.floor(Number(u && u.points_balance) || 0);   // sub-1 dust stays on the row (still counted in supply)
  if (!(amount > 0)) return null;
  const ledger = require("./ledger");
  const d = await ledger.post(userId, -amount, "account-deleted", { requireCover: true, note: `routed: ${FLOW}`, source: "accountdelete" });
  if (!d.ok) throw new Error(`account-deleted debit refused: ${d.code}`);
  const sh = await shares();
  const legs = require("./autoescrow").split(sh, amount);
  let P = null, live = false;
  try { P = require("./pools"); live = !!(await P.live()); } catch (e) { live = false; }
  const poolLegs = [];
  for (const [dest, a] of legs) {
    if (dest === "jackpot") {
      await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES (?, ?, ?, ?)", [`${key}:house`, `acctdel:${FLOW}`, null, a]);
    } else if (live) {
      poolLegs.push({ pool: dest, amount: a });
    } else {
      // the pools still live in Pepe: a negative website claim his funding tick credits to the Reserve
      await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES (?, ?, ?, ?, ?)", [`${key}:${dest}`, FLOW, null, "deleted account's balance", -a]);
    }
  }
  if (poolLegs.length && !(await P._inTx.seen(key))) {
    const a = await P._inTx.applyLegs(key, poolLegs, { kind: "move", flow: FLOW, why: "a deleted account's balance", via: "site" });
    await P._inTx.recordMove(key, { kind: "move", flow: FLOW, why: "a deleted account's balance", via: "site", legs: poolLegs, net: a.net, ts: a.ts,
                                    result: { ok: true, key, balances: a.after } });
    await P._inTx.bumpRev();
  }
  await runQuery("INSERT INTO account_deletion_routes (key, user_id, amount, legs, txid, at) VALUES (?, ?, ?, ?, ?, ?)",
                 [key, String(userId), amount, JSON.stringify(legs), d.transactionId, now()]);
  return { amount, legs, key, txid: d.transactionId };
}

// ── the job ──
// Columns holding a username / Camfrog login as TEXT, pseudonymised by value in records that are kept (the ledger, logs).
// (users.username itself, and tables whose rows are deleted, are handled separately.)
const NAME_COLUMNS = [
  "account_merge_log.from_username", "account_merge_log.to_username", "admin_audit.target_name", "admin_audit.admin_name", "content_audit_views.admin_name",
  "auto_escrow.login", "auto_escrow_claimlinks.login", "banner_bookings.username", "bounty_actions.username", "bounty_actions.camfrog",
  "bridge_cmd_log.username", "bridge_cmd_log.camfrog", "casino_rep_queue.camfrog", "cosmetic_avatar_seeds.camfrog", "econ_participation.login",
  "escrow_holds.login", "escrow_holds.username", "feed_aigen_jobs.username", "feed_aigen_jobs.camfrog", "feed_bans.username", "feed_bans.by",
  "feed_restricted.login", "feed_voices.by_login", "gtf_ops.login", "heist_market_listings.seller_login", "heist_market_listings.buyer_login",
  "heist_market_listings.holder_login", "heist_market_ops.login", "heist_sheets.camfrog", "likeness_ledger.subject_login", "likeness_ledger.payer_login",
  "login_changes.old_login", "login_changes.new_login", "lotto_last_tickets.name", "lotto_purchases.name", "lotto_tickets.name", "market_orders.username",
  "market_orders.camfrog", "media.by_user", "media.subject_login", "media_bookings.username", "media_controls.username", "media_invites.username",
  "media_issues.username", "media_plays.username", "media_queues.username", "media_requests.username", "pad_cosmetic_items.buyer_name",
  "pat_route_intents.username", "pepe_actions.username", "pepe_control_audit.username", "pepe_control_cmds.username", "plex_members.username",
  "premium_ledger.payer_name", "room_flow_ledger.payer_name", "sb_clips.subject_login", "sb_plays.login", "stage_bans.username", "stage_captures.username",
  "stage_queue.username", "stage_room_bans.username", "stage_slots.username", "stash_moves.login", "story_posts.subject_login", "story_posts.subject_name",
  "story_saves.by_name", "translation_suggestions.username", "voice_consents.login", "voice_consents.typed_login", "voice_owned_logins.login",
  "voices.owner_login", "ach_events.login", "ach_metrics.login", "ach_progress.login", "stale_notice.login", "stale_notice.username",
  "inbox_pending.camfrog", "gang_rep_events.member_key", "gang_members.member_key",
];
const DISPLAY_COLUMNS = [["stage_slots", "displayname", "userId"], ["stage_queue", "displayname", "userId"]];

// Rows that are personal and go entirely: [table, column, value kind (uid | login | profile)]
const DELETE_ROWS = [
  ["sessions", "user_id", "uid"], ["session_cutoffs", "user_id", "uid"], ["sso_links", "user_id", "uid"],
  ["telegram_links", "user_id", "uid"], ["telegram_codes", "user_id", "uid"], ["telegram_prefs", "user_id", "uid"], ["telegram_outbox", "user_id", "uid"],
  ["crypto_wallets", "user_id", "uid"], ["crypto_link_nonces", "user_id", "uid"], ["chat_signin_tokens", "user_id", "uid"], ["chat_signin_prefs", "user_id", "uid"],
  ["chat_signin_log", "user_id", "uid"], ["incognito_log", "user_id", "uid"], ["incognito_state", "login", "login"],
  ["inbox", "user_id", "uid"], ["inbox_prefs", "user_id", "uid"], ["inbox_pending", "camfrog", "login"],
  ["dm_prefs", "user_id", "uid"], ["dm_alerts", "user_id", "uid"], ["dm_blocks", "blocker_id", "uid"], ["dm_blocks", "blocked_id", "uid"], ["pepe_dm_jobs", "user_id", "uid"],
  ["mention_prefs", "user_id", "uid"], ["mention_words", "user_id", "uid"], ["follow_prefs", "user_id", "uid"], ["golive_prefs", "user_id", "uid"],
  ["follows", "follower", "uid"], ["user_language", "userId", "uid"], ["user_timezone", "userId", "uid"], ["profile_layout", "user_id", "uid"],
  ["user_badge_showcase", "user_id", "uid"], ["story_prefs", "user_id", "uid"], ["story_hides", "user_id", "uid"], ["story_saves", "user_id", "uid"],
  ["story_seen", "user_id", "uid"], ["feed_seen", "user_id", "uid"], ["feed_view", "user_id", "uid"], ["store_alerts", "user_id", "uid"],
  ["shop_prefs", "user_id", "uid"], ["support_prefs", "user_id", "uid"], ["tipjar_seen", "userId", "uid"], ["likeness_prefs", "user_id", "uid"],
  ["media_user_links", "user_id", "uid"], ["username_history", "userId", "uid"], ["displayname_log", "userId", "uid"], ["welcome_activity", "userId", "uid"],
  ["stale_notice", "userId", "uid"], ["pending_camfrog_links", "userId", "uid"], ["auto_escrow_notices", "user_id", "uid"],
  ["user_cosmetics", "user_id", "uid"], ["user_cosmetic_equips", "user_id", "uid"], ["user_sticker_packs", "user_id", "uid"], ["sb_owned", "user_id", "uid"],
  ["voice_owned", "user_id", "uid"], ["user_badges", "userId", "uid"], ["achievement_feed", "userId", "uid"], ["ach_marks", "userId", "uid"],
  ["casino_ach_counts", "userId", "uid"], ["casino_ach_base", "userId", "uid"], ["user_roles", "userId", "uid"], ["pad_members", "user_id", "uid"],
  ["pad_user_flairs", "user_id", "uid"], ["feed_room_members", "user_id", "uid"], ["launchpad_visits", "user_id", "uid"], ["premium_plus_waitlist", "user_id", "uid"],
  ["camfrog_userstats", "login", "login"], ["golive_log", "user_id", "uid"],
  ["help_misses", "user_id", "uid"], ["age_attest", "user_id", "uid"], ["plex_watch_stats", "user_id", "uid"],
];

/** Settlements that run before the main transaction (each one idempotent). */
async function settle(uid, login, report) {
  const t = now();
  report.settled = report.settled || {};
  const bump = (k, n) => { if (n) report.settled[k] = (report.settled[k] || 0) + n; };
  bump("creator_subs_stopped", await run("creator_subs", ["fan_id", "cancel_at_end"], "UPDATE creator_subs SET cancel_at_end = 1, renew = 0, updated = ? WHERE fan_id = ? AND status = 'active'", [t, uid]).catch(() => 0));
  bump("creator_subs_ended", await run("creator_subs", ["fan_id"], "UPDATE creator_subs SET status = 'ended', cancel_at_end = 1, ended_at = ?, updated = ? WHERE fan_id = ? AND status = 'grace'", [t, t, uid]).catch(() => 0));
  bump("shop_subs_stopped", await run("shop_subs", ["user_id", "cancel_at_end"], "UPDATE shop_subs SET cancel_at_end = 1, updated = ? WHERE user_id = ? AND status = 'active'", [t, uid]));
  bump("shop_subs_ended", await run("shop_subs", ["user_id"], "UPDATE shop_subs SET status = 'ended', cancel_at_end = 1, ended_at = ?, updated = ? WHERE user_id = ? AND status = 'grace'", [t, t, uid]));
  bump("premium_renewals_stopped", await run("premium_subs", ["renewer_id"], "UPDATE premium_subs SET renewer_id = NULL, updated = ? WHERE renewer_id = ? AND stripe_sub IS NULL", [t, uid]));
  bump("welcome_cancelled", await run("welcome_bonus", ["userId", "state"], "UPDATE welcome_bonus SET state = 'expired', decided = ?, reason = 'account deleted' WHERE userId = ? AND state = 'pending'", [t, uid]));
  bump("pending_actions_cancelled", await run("pepe_actions", ["user_id", "status"], `UPDATE pepe_actions SET status = 'failed', message = 'account deleted', updated = ? WHERE user_id = ? AND status = 'pending' AND kind != ?`, [t, uid, FORGET_KIND]));
  bump("creator_plans_closed", await run("creator_plans", ["creator_id", "active"], "UPDATE creator_plans SET active = 0 WHERE creator_id = ?", [uid]));
  // sole-owned stashes (site-owned, unstaked, nobody else in them): into the wallet first, so the routing takes it
  const sp = await stashPlan(login);
  for (const s of sp.auto) {
    if (Number(s.balance) > 0) {
      const S = require("./stashes");
      const r = await S.withdraw({ key: `acctdel-${uid}-stash-${s.id}`, login, stashId: s.id, amount: "all", userId: uid, via: "account-deleted" });
      if (!r || r.ok === false) throw new Error(`stash ${s.id} withdrawal refused: ${(r && (r.code || r.error)) || "?"}`);
      bump("stash_pat", Number(s.balance));
    }
    await runQuery("UPDATE stashes SET closed = ?, updated = ? WHERE id = ? AND closed IS NULL AND balance = 0", [t / 1000, t, s.id]).catch(() => {});
  }
}

/** Run a due deletion. -> {ok, state, report} */
async function execute(userId, { force = false } = {}) {
  await init();
  colsCache.clear();
  const uid = String(userId);
  const reqRow = await pendingOf(uid);
  if (!reqRow) return { ok: false, state: "none" };
  if (!force && Number(reqRow.execute_at) > now()) return { ok: false, state: "waiting" };
  const u0 = (await getQuery("SELECT * FROM users WHERE userId = ?", [uid]))[0];
  if (!u0) { await runQuery("UPDATE account_deletions SET state = 'done', done_at = ? WHERE id = ?", [now(), reqRow.id]); return { ok: true, state: "gone" }; }
  const b = await blockers(uid);
  if (b.block.length) {
    const why = b.block.map((x) => x.label).join("; ").slice(0, 500);
    const first = reqRow.state !== "held";
    await runQuery("UPDATE account_deletions SET state = 'held', held_reason = ?, held_at = ? WHERE id = ?", [why, now(), reqRow.id]);
    if (first) {
      await require("./inbox").addSafe(uid, { kind: "system", title: "Your account deletion is on hold",
        body: `We couldn't delete your account yet: ${why}. Sign in to close these (signing in cancels the deletion; ask again afterwards).`,
        link: "/settings/account#delete", ref: `acctdel:held:${reqRow.id}` });
    }
    return { ok: false, state: "held", block: b.block };
  }
  const login = low(u0.camfrogUsername) || null;
  const pseudo = "deleted-" + crypto.createHash("sha256").update("acctdel:" + uid).digest("hex").slice(0, 10);
  const report = { pseudonym: pseudo };
  await settle(uid, login, report);
  const randomHash = await require("bcrypt").hash(crypto.randomBytes(24).toString("hex"), 10);
  const t = now();
  // the clip files (outside the transaction: files, then the rows are flagged inside)
  const mediaRows = await q("media", ["by_user_id", "subject_login"], "SELECT id, file FROM media WHERE (by_user_id = ? OR lower(subject_login) = ?) AND COALESCE(deleted,0) = 0", [uid, login || "\u0000"]);
  try {
    const M = require("./media");
    const path = require("path"), fs = require("fs");
    for (const m of mediaRows) { if (m.file) { try { fs.unlinkSync(path.join(M.DIR, m.file)); } catch (e) { /* gone */ } } try { M.removePoster(m.id); } catch (e) { /* none */ } }
  } catch (e) { /* no media module */ }
  await tx(async () => {
    // 1. the balance -> the routing row (keyed)
    report.route = await routeBalanceInTx(uid, `acctdel-${uid}-0`);
    // 2. posts / comments: anonymised where someone replied, deleted otherwise
    const n = (k, v) => { if (v) report[k] = (report[k] || 0) + v; };
    if (await has("feed_posts", "author_id")) {
      const replied = (await has("feed_comments", "post_id"))
        ? "EXISTS (SELECT 1 FROM feed_comments c WHERE c.post_id = feed_posts.id AND c.author_id != ? AND c.deleted_at IS NULL)" : "0";
      n("posts_anonymised", (await getQuery(`SELECT COUNT(*) AS n FROM feed_posts WHERE author_id = ? AND deleted_at IS NULL AND ${replied}`, replied === "0" ? [uid] : [uid, uid]))[0].n);
      n("posts_deleted", await run("feed_posts", ["author_id"], `UPDATE feed_posts SET deleted_at = ?, deleted_by = ?, delete_reason = 'account deleted', title = '', body = '', link_url = NULL, link_json = NULL
                                                                 WHERE author_id = ? AND deleted_at IS NULL AND NOT ${replied}`, replied === "0" ? [t, uid, uid] : [t, uid, uid, uid]));
    }
    if (await has("feed_comments", "author_id")) {
      const replied = "EXISTS (SELECT 1 FROM feed_comments r WHERE r.parent_id = feed_comments.id AND r.author_id != ? AND r.deleted_at IS NULL)";
      n("comments_anonymised", (await getQuery(`SELECT COUNT(*) AS n FROM feed_comments WHERE author_id = ? AND deleted_at IS NULL AND ${replied}`, [uid, uid]))[0].n);
      n("comments_deleted", await run("feed_comments", ["author_id"], `UPDATE feed_comments SET deleted_at = ?, deleted_by = ?, body = '' WHERE author_id = ? AND deleted_at IS NULL AND NOT ${replied}`, [t, uid, uid, uid]));
    }
    n("stories_removed", await run("story_posts", ["author_id", "removed_at"], "UPDATE story_posts SET removed_at = ?, removed_reason = 'account deleted' WHERE (author_id = ? OR subject_user_id = ? OR posted_by = ?) AND removed_at IS NULL", [t, uid, uid, uid]));
    // 3. DMs: the messages they sent are deleted (the other side sees "deleted"); they leave every conversation
    n("messages_deleted", await run("messages", ["sender_id"], "UPDATE messages SET body = '', deleted_at = COALESCE(deleted_at, ?), deleted_by = COALESCE(deleted_by, ?) WHERE sender_id = ?", [t, uid, uid]));
    n("conversations_left", await run("conversation_members", ["user_id", "left_at"], "UPDATE conversation_members SET left_at = COALESCE(left_at, ?), hidden = 1 WHERE user_id = ?", [t, uid]));
    // (their DM pictures go with the deleted messages: dmmedia.sweep purges the files after its grace period)
    // 4. clips they made / of them
    n("clips_removed", await run("media", ["by_user_id", "deleted"], "UPDATE media SET deleted = 1 WHERE by_user_id = ? OR (? IS NOT NULL AND lower(subject_login) = ?)", [uid, login, login]));
    // 5. personal rows
    for (const [table, col, kind] of DELETE_ROWS) {
      const v = kind === "login" ? login : uid;
      if (!v) continue;
      n("deleted:" + table, await run(table, [col], `DELETE FROM "${table}" WHERE "${col}" = ?`, [v]));
    }
    n("deleted:follows(target)", await run("follows", ["target_id", "target_kind"], "DELETE FROM follows WHERE (target_kind = 'user' AND target_id = ?) OR (target_kind = 'room' AND target_id = ?)", [uid, "user:" + uid]));
    n("plex_unlinked", await run("plex_members", ["user_id"], "UPDATE plex_members SET user_id = NULL WHERE user_id = ?", [uid]));
    n("creator_profile", await run("creators", ["user_id", "bio"], "UPDATE creators SET bio = NULL, updated = ? WHERE user_id = ?", [t, uid]));
    // 6. names in kept records -> the pseudonym
    const names = [low(u0.username), login].filter(Boolean);
    for (const k of NAME_COLUMNS) {
      const [table, col] = k.split(".");
      if (!names.length || !(await has(table, col))) continue;
      n("pseudonymised", await run(table, [col], `UPDATE "${table}" SET "${col}" = ? WHERE lower(trim("${col}")) IN (${names.map(() => "?").join(",")})`, [pseudo, ...names]));
    }
    for (const [table, col, idCol] of DISPLAY_COLUMNS) n("pseudonymised", await run(table, [col, idCol], `UPDATE "${table}" SET "${col}" = 'Deleted user' WHERE "${idCol}" = ?`, [uid]));
    // 7. Pepe forgets the Camfrog login (website action; queued while the row still knows the login)
    if (login && (await tableExists("pepe_actions"))) {
      await runQuery(`INSERT OR IGNORE INTO pepe_actions (user_id, username, camfrog, site_admin, kind, args, tag, label, status, created, updated, idem)
                      VALUES (?, ?, ?, 0, ?, '[]', 'privacy', 'account deleted', 'pending', ?, ?, ?)`, [uid, pseudo, login, FORGET_KIND, t, t, `acctdel-forget-${uid}-1`]);
      report.pepe_forget = "queued";
    }
    // 8. the users row: a pseudonymous tombstone (the ledger's rows still point at it; nobody can sign in to it)
    const set = { username: pseudo, displayname: "Deleted user", email: null, password: randomHash, avatar: "/public/img/avatar.png", class: "pleb",
                  discordId: null, discordUsername: null, twitchId: null, twitchDisplayname: null, twitchLogin: null, camfrogUsername: null,
                  streamId: null, streamKey: null, emailVerificationToken: null, tokenExpires: null, isEmailVerified: 0, resetPasswordToken: null,
                  resetPasswordExpires: null, archived_at: t, password_set: 0, displayname_auto: 0 };
    const uc = await cols("users");
    const keys = Object.keys(set).filter((k) => uc.includes(k));
    await runQuery(`UPDATE users SET ${keys.map((k) => `"${k}" = ?`).join(", ")} WHERE userId = ?`, [...keys.map((k) => set[k]), uid]);
    // 9. the archive marker (staleaccounts.restore never revives a DELETED account)
    if (await tableExists("account_archive")) {
      await runQuery(`INSERT INTO account_archive (userId, run_id, tier, reason, archived_at, balance, reclaimed, purged_at, snapshot)
                      VALUES (?, ?, 'DELETED', 'deleted by its owner', ?, 0, 0, NULL, ?)
                      ON CONFLICT(userId) DO UPDATE SET tier = 'DELETED', reason = excluded.reason, archived_at = excluded.archived_at, snapshot = excluded.snapshot,
                        restored_at = NULL, restored_via = NULL`, [uid, `acctdel-${reqRow.id}`, t, JSON.stringify({ pseudonym: pseudo })]);
    }
    await runQuery("UPDATE account_deletions SET state = 'done', done_at = ?, pseudonym = ?, report = ?, held_reason = NULL WHERE id = ?",
                   [t, pseudo, JSON.stringify(report).slice(0, 20000), reqRow.id]);
  });
  try { await require("./accountexport").removeAll(uid); } catch (e) { /* none */ }
  try { require("./sessions")._clearCache(); } catch (e) { /* none */ }
  console.log(`[acctdel] ${uid} deleted -> ${pseudo}${report.route ? ` (${report.route.amount} PAT -> ${report.route.legs.map(([d, a]) => `${d} ${a}`).join(", ")})` : ""}`);
  return { ok: true, state: "done", report };
}

/** A deleted account credited later (a late refund, a payout already in flight): route it the same way. */
async function sweepTombstones() {
  await init();
  const rows = await getQuery(`SELECT d.user_id FROM account_deletions d JOIN users u ON u.userId = d.user_id WHERE d.state = 'done' AND u.points_balance >= 1`);
  let n = 0;
  for (const r of rows) {
    const k = (await getQuery("SELECT COUNT(*) AS n FROM account_deletion_routes WHERE user_id = ?", [r.user_id]))[0].n;
    try { const x = await tx(() => routeBalanceInTx(r.user_id, `acctdel-${r.user_id}-${k}`)); if (x) n += x.amount; }
    catch (e) { console.error("[acctdel] sweep:", r.user_id, e.message); }
  }
  return n;
}

/** Pepe's forget action expired or failed (he was down): ask again, up to FORGET_TRIES; once done, the login leaves the row. */
async function retryForget() {
  if (!(await tableExists("pepe_actions"))) return 0;
  let n = 0;
  for (const d of await getQuery("SELECT user_id FROM account_deletions WHERE state = 'done'")) {
    const acts = await getQuery("SELECT id, camfrog, status, idem, updated FROM pepe_actions WHERE user_id = ? AND kind = ? ORDER BY id", [d.user_id, FORGET_KIND]);
    if (!acts.length || acts.some((a) => ["pending", "claimed", "done", "ok"].includes(a.status))) {
      // done: the login doesn't need to stay on the row any more
      for (const a of acts) if (a.camfrog && ["done", "ok"].includes(a.status)) await runQuery("UPDATE pepe_actions SET camfrog = NULL WHERE id = ?", [a.id]);
      continue;
    }
    const last = acts[acts.length - 1];
    if (acts.length >= FORGET_TRIES || !last.camfrog) continue;
    if (now() - Number(last.updated || 0) < FORGET_RETRY_MS) continue;            // spaced out: Pepe may be restarting
    const t = now();
    await runQuery(`INSERT OR IGNORE INTO pepe_actions (user_id, username, camfrog, site_admin, kind, args, tag, label, status, created, updated, idem)
                    SELECT user_id, username, camfrog, 0, kind, '[]', 'privacy', 'account deleted', 'pending', ?, ?, ? FROM pepe_actions WHERE id = ?`,
                   [t, t, `acctdel-forget-${d.user_id}-${acts.length + 1}`, last.id]);
    await runQuery("UPDATE pepe_actions SET camfrog = NULL WHERE id = ?", [last.id]);
    n++;
  }
  return n;
}

let ticking = null;
async function tick() {
  if (ticking) return ticking;
  ticking = (async () => {
    await init();
    const due = await getQuery("SELECT user_id FROM account_deletions WHERE state IN ('scheduled','held') AND execute_at <= ? ORDER BY execute_at LIMIT 20", [now()]);
    for (const d of due) { try { await execute(d.user_id); } catch (e) { console.error(`[acctdel] execute ${d.user_id}:`, e.message); } }
    try { await sweepTombstones(); } catch (e) { console.error("[acctdel] sweep:", e.message); }
    try { await retryForget(); } catch (e) { console.error("[acctdel] forget retry:", e.message); }
  })().finally(() => { ticking = null; });
  return ticking;
}

// ── routes ──
let timer = null;
function register(app, { addUser }) {
  init().catch((e) => console.error("[acctdel] init:", e.message));
  if (!timer) {
    timer = setInterval(() => tick().catch((e) => console.error("[acctdel] tick:", e.message)), TICK_MS);
    if (timer.unref) timer.unref();
  }
  const sameOrigin = (req) => { const s = req.get("origin") || req.get("referer"); try { return !!s && new URL(s).host === req.get("host"); } catch (e) { return false; } };
  const fail = (res, e) => {
    if (e instanceof Refuse) return res.status(e.status).json({ ok: false, error: e.message, code: e.code, block: e.block || undefined });
    console.error("[acctdel]", e.message);
    return res.status(500).json({ ok: false, error: "Something went wrong." });
  };

  app.get("/settings/account/delete", addUser, async (req, res, next) => {
    try {
      if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent("/settings/account/delete"));
      res.set("Cache-Control", "private, no-store");
      const u = (await getQuery("SELECT userId, username, class, password_set FROM users WHERE userId = ?", [req.user.userId]).catch(() =>
        getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId])))[0];
      if (!u) return res.redirect("/login");
      const b = await blockers(u.userId);
      res.render("accountDelete", { user: u.username, username: u.username, block: b.block, settle: b.settle, elevated: await elevated(u),
        hasPassword: u.password_set === undefined || u.password_set === null || Number(u.password_set) !== 0,
        fresh: await require("./sessions").isFresh(req), graceDays: GRACE_MS / DAY, pending: await pendingOf(u.userId) });
    } catch (e) { next(e); }
  });
  app.get("/api/account/delete", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false });
    try { res.json(Object.assign({ ok: true, fresh: await require("./sessions").isFresh(req) }, await blockers(req.user.userId))); } catch (e) { fail(res, e); }
  });
  app.post("/api/account/delete", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    if (req.get("X-Requested-With") !== "fetch" || !sameOrigin(req)) return res.status(403).json({ ok: false, error: "cross-site" });
    try {
      const b = req.body || {};
      const r = await request(req, { password: typeof b.password === "string" ? b.password : "", confirm: b.confirm });
      require("./middleware/loginCookie").clearLogin(res);
      res.json(r);
    } catch (e) { fail(res, e); }
  });
  // admins: schedule another member's deletion (the way for admin / staff / moderator accounts), list, cancel
  const admin = async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) { res.status(401).json({ ok: false, error: "Sign in first." }); return null; }
    const row = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]).catch(() => []))[0];
    if (!row || row.class !== "Admin") { res.status(403).json({ ok: false, error: "Admins only." }); return null; }
    if (req.method === "POST" && (req.get("X-Requested-With") !== "fetch" || !sameOrigin(req))) { res.status(403).json({ ok: false, error: "cross-site" }); return null; }
    return row;
  };
  app.get("/api/admin/account-deletions", addUser, async (req, res) => {
    if (!(await admin(req, res))) return;
    try {
      await init();
      res.json({ ok: true, rows: await getQuery(`SELECT d.id, d.user_id, u.username, d.state, d.requested_at, d.execute_at, d.requested_by, d.reauth, d.held_reason,
                                                  d.cancelled_at, d.cancel_via, d.done_at, d.pseudonym FROM account_deletions d LEFT JOIN users u ON u.userId = d.user_id
                                                  ORDER BY d.id DESC LIMIT 200`) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/users/:id/delete", addUser, async (req, res) => {
    const me = await admin(req, res); if (!me) return;
    try {
      const target = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [String(req.params.id)]))[0];
      if (!target) throw new Refuse(404, "No such account.");
      if (target.userId === me.userId) throw new Refuse(403, "Another admin has to do this for your own account.", "E_SELF");
      if (String((req.body || {}).confirm || "").trim() !== target.username) throw new Refuse(400, "Type the member's username exactly to confirm.", "E_CONFIRM");
      if (await pendingOf(target.userId)) throw new Refuse(409, "Already scheduled.", "E_PENDING");
      const b = await blockers(target.userId);
      if (b.block.length) throw new Refuse(409, "Some things have to be closed first.", "E_BLOCKED", { block: b.block });
      const r = await schedule(target, { by: "admin:" + me.userId, reauth: "admin", reason: (req.body || {}).reason });
      try { await require("./adminaudit").record(me, "account.delete", target, { execute_at: r.execute_at }, (req.body || {}).reason); } catch (e) { /* best effort */ }
      res.json(r);
    } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/account-deletions/:id/cancel", addUser, async (req, res) => {
    const me = await admin(req, res); if (!me) return;
    try {
      await init();
      const r = await runQuery("UPDATE account_deletions SET state = 'cancelled', cancelled_at = ?, cancel_via = ? WHERE id = ? AND state IN ('scheduled','held')",
                               [now(), "admin:" + me.userId, Number(req.params.id) || 0]);
      res.json({ ok: !!(r && r.changes) });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { init, register, blockers, request, schedule, cancelOnSignIn, execute, tick, sweepTombstones, retryForget, routeBalanceInTx, shares,
                   pendingOf, isDeleted, elevated, Refuse, FLOW, FORGET_KIND, GRACE_MS, NAME_COLUMNS, DELETE_ROWS,
                   _setClock: (f) => { clock = f || (() => Date.now()); } };
