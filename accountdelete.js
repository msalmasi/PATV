// accountdelete.js — "Delete my account" (Settings → Account → Delete account), 1.99wj. The policy: docs/account-deletion.md.
//
// The flow:
//   1. GET /settings/account/delete       what deletion does, what still has to be closed first (blockers()), the form
//   2. POST /api/account/delete           {password?, confirm, hide_lines?, remove_public?}: re-authentication (the password, or a FRESH sign-in - any method,
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
//                                         CL6: with hide_lines ("Also hide my past public chat lines", unticked by default) the
//                                         login and the account key join the pad chat archive's sticky hidden set (src delete).
//                                         S1 V4: with remove_public ("Also remove my public messages", unticked; offered only
//                                         while the chat hub's `erasure` switch is on, and at most once a day) the hub's
//                                         privacy/account-deleted row carries remove_public: true (the hub hard-deletes the
//                                         account's public lines there) and, once the deletion has committed, the account's web
//                                         lines in the pad chat archive are purged too (chatlogmod.removeAccountLines), the same
//                                         exceptions kept (a legal hold, an open report): ADR 0007 OQ-20, one checkbox for both.
//                                         Mic retention (owner answers 2026-10-27): with delete_recordings ("Also delete my mic
//                                         recordings", unticked; offered only while the mic-recordings policy switch is on and
//                                         Pepe runs the release that does it - micrec.js) Pepe is asked to delete the recordings of
//                                         every Camfrog login the account had, made before it stopped being the account's (website
//                                         action "privacy.recdelete" [before], micrec.recWindowsOf; re-asked until he takes it).
//
// PAT never vanishes: the wallet debit ("account-deleted") and its legs (pools when the site owns them, the House as jackpot rakes,
// else a negative Reserve claim Pepe's funding tick credits) are one transaction, keyed (account_deletion_routes, key
// acctdel-<userId>-<n>); a deleted account that is credited later (a late refund) is swept the same way by the tick.
//
//   account_deletions        id, user_id, state scheduled|held|cancelled|done, requested_at, execute_at, requested_by, reauth,
//                            reason, cancelled_at, cancel_via, held_reason, held_at, done_at, pseudonym, report (JSON counts),
//                            hide_lines (CL6), remove_public (S1 V4: the choice), public_done_at (S1 V4: when the archive's
//                            part of it ran; NULL with remove_public = 1 on a done row -> the tick runs it again),
//                            public_login (S1 V4 fix-up: the released Camfrog login, ONLY between the deletion's commit and
//                            the archive's part - its web lines are under it; NULLed when that part has run; review 2: read
//                            only on a row written before public_windows), public_windows (S1 V4 review 2: JSON
//                            [{login, from, to}] - each Camfrog login linked to the account and the span it was the account's,
//                            loginWindowsOf; the same lifetime: NULLed when the archive's part has run),
//                            delete_recordings (mic retention: the choice), rec_windows (JSON [{login, from, to}] for Pepe's
//                            retries - NULLed once he ran every login, or given up), rec_done_at, rec_gave_up_at (not run in 30 days),
//                            rec_skipped (review: JSON [{login, from, to}] NOT asked - another account held the login before; admins
//                            only, NULLed when handled or 30 days after the deletion), rec_skipped_done_at, rec_skipped_alert
//                            (review 2: the stage the admins were told - 1 appeared, 2 reminded, 3 lapsed), rec_skipped_lapsed_at,
//                            rec_late_at + rec_late_note (review 3: Pepe's follow-up came after the scrub - micrec.scrubLateAcks),
//                            rec_partial_note + rec_partial_at (review 4: his latest answer was a partial run - not done yet),
//                            rec_wait_alert (review 4: the admins were told it isn't confirmed - 1 a week before the give-up, 2 at it)
//   account_deletion_routes  key PK, user_id, amount, legs (JSON), txid, at
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery, tx } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

const DAY = 86400000;
const GRACE_MS = 14 * DAY;
const TICK_MS = 10 * 60000;
const FLOW = "account_deleted";              // the PAT Routing row
const FORGET_KIND = "privacy.forget";         // Pepe's website action (pepe_webact): forget this Camfrog login
const ACCT_FORGET_ARGS = '["account"]';       // 1.99aft: the same action for an account with no chat login (its "u:<id>" key)
const FORGET_TRIES = 10;
const FORGET_RETRY_MS = 6 * 3600000;
const REMOVE_EVERY_MS = DAY;                  // S1 V4: "Also remove my public messages" at most once a day (CA §9.4)

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
      // CL6 (decision 14): the member ticked "Also hide my past public chat lines"
      const c = (await getQuery("SELECT name FROM pragma_table_info('account_deletions')")).map((r) => r.name);
      if (!c.includes("hide_lines")) await runQuery("ALTER TABLE account_deletions ADD COLUMN hide_lines INTEGER");
      // S1 V4: the member ticked "Also remove my public messages"; when the pad chat archive's part of it ran
      if (!c.includes("remove_public")) await runQuery("ALTER TABLE account_deletions ADD COLUMN remove_public INTEGER");
      if (!c.includes("public_done_at")) await runQuery("ALTER TABLE account_deletions ADD COLUMN public_done_at INTEGER");
      if (!c.includes("public_login")) await runQuery("ALTER TABLE account_deletions ADD COLUMN public_login TEXT");
      // S1 V4 review 2: the spans each Camfrog login was the account's (JSON [{login, from, to}]), kept like public_login was
      if (!c.includes("public_windows")) await runQuery("ALTER TABLE account_deletions ADD COLUMN public_windows TEXT");
      // mic retention: "Also delete my mic recordings" - the choice, the spans for Pepe's retries, when he confirmed / gave up
      if (!c.includes("delete_recordings")) await runQuery("ALTER TABLE account_deletions ADD COLUMN delete_recordings INTEGER");
      if (!c.includes("rec_windows")) await runQuery("ALTER TABLE account_deletions ADD COLUMN rec_windows TEXT");
      if (!c.includes("rec_done_at")) await runQuery("ALTER TABLE account_deletions ADD COLUMN rec_done_at INTEGER");
      if (!c.includes("rec_gave_up_at")) await runQuery("ALTER TABLE account_deletions ADD COLUMN rec_gave_up_at INTEGER");
      // review: the spans NOT asked of Pepe (another account held the login before) - admins act on them by hand; bounded (micrec)
      if (!c.includes("rec_skipped")) await runQuery("ALTER TABLE account_deletions ADD COLUMN rec_skipped TEXT");
      if (!c.includes("rec_skipped_done_at")) await runQuery("ALTER TABLE account_deletions ADD COLUMN rec_skipped_done_at INTEGER");
      // review 2: the admins were told about the skipped spans (1 when they appeared, 2 reminded, 3 lapsed); when they lapsed unhandled
      if (!c.includes("rec_skipped_alert")) await runQuery("ALTER TABLE account_deletions ADD COLUMN rec_skipped_alert INTEGER");
      if (!c.includes("rec_skipped_lapsed_at")) await runQuery("ALTER TABLE account_deletions ADD COLUMN rec_skipped_lapsed_at INTEGER");
      // review 3: Pepe's follow-up came after the scrub (done or given up): when, and his rewritten answer (counts, no login)
      if (!c.includes("rec_late_at")) await runQuery("ALTER TABLE account_deletions ADD COLUMN rec_late_at INTEGER");
      if (!c.includes("rec_late_note")) await runQuery("ALTER TABLE account_deletions ADD COLUMN rec_late_note TEXT");
      // review 4: Pepe's latest answer was partial (storage unreadable / some not deleted yet: the words, no login) and since when;
      // the admins were told it isn't confirmed (1 a week before the give-up, 2 at the give-up - before the logins go)
      if (!c.includes("rec_partial_note")) await runQuery("ALTER TABLE account_deletions ADD COLUMN rec_partial_note TEXT");
      if (!c.includes("rec_partial_at")) await runQuery("ALTER TABLE account_deletions ADD COLUMN rec_partial_at INTEGER");
      if (!c.includes("rec_wait_alert")) await runQuery("ALTER TABLE account_deletions ADD COLUMN rec_wait_alert INTEGER");
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

/** The sole-owned, unstaked stashes of an account while the site owns stashes (these are auto-settled). 1.99wy: stashes
 *  are held by "u:<userId>" (stashes.js); a row its linked login still holds (not re-keyed yet) counts too.
 *  -> {auto:[], block:bool} */
async function stashPlan(login, uid = null) {
  const out = { auto: [], block: false, live: false };
  const keys = [...new Set([uid ? `u:${uid}` : null, login ? low(login) : null].filter(Boolean))];
  if (!keys.length || !(await tableExists("stashes"))) return out;
  try { out.live = !!(await require("./stashes").live()); } catch (e) { out.live = false; }
  const IN = `(${keys.map(() => "?").join(",")})`;
  const owned = await getQuery(`SELECT id, balance, staked FROM stashes WHERE lower(owner) IN ${IN} AND closed IS NULL`, keys.map(low));
  const member = (await tableExists("stash_members")) ? await getQuery(`SELECT s.id FROM stash_members m JOIN stashes s ON s.id = m.stash_id
                                                                         WHERE lower(m.login) IN ${IN} AND s.closed IS NULL AND lower(s.owner) NOT IN ${IN}`,
                                                                        keys.map(low).concat(keys.map(low))) : [];
  if (member.length) out.block = true;                       // a member of someone else's stash: leave it
  for (const s of owned) {
    const others = (await tableExists("stash_members")) ? (await getQuery(`SELECT COUNT(*) AS n FROM stash_members WHERE stash_id = ? AND lower(login) NOT IN ${IN}`, [s.id].concat(keys.map(low))))[0].n : 0;
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
  const sp = await stashPlan(login, uid);
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

// ── S1 V4: "Also remove my public messages" (ADR 0007 D16 / OQ-20; CHAT-ARCHITECTURE §9.4) ──
/** The choice is offered (the page's checkbox, its copy, the privacy page's paragraph) only while the chat hub's `erasure`
 *  switch is on (huboutbox; off by default - nothing a member sees changes before S1's turn-on, Q7). */
function removeOffered() {
  try { return require("./huboutbox").on("erasure"); } catch (e) { return false; }
}
/** At most once a day: when this account may ask again (ms), or null when it may now. Every request that carried the choice
 *  counts - a cancelled one too (a sign-in cancels; asking again the same day doesn't get a second removal). */
async function removeWaitUntil(userId) {
  await init();
  const r = (await getQuery("SELECT MAX(requested_at) AS at FROM account_deletions WHERE user_id = ? AND remove_public = 1", [String(userId)]))[0];
  const next = r && r.at != null ? Number(r.at) + REMOVE_EVERY_MS : 0;
  return next > now() ? next : null;
}
/** Mic retention: "Also delete my mic recordings" is offered only while the mic-recordings policy switch is on (micrec.js: the
 *  privacy policy says what recordings are kept) AND Pepe runs the release that deletes them (micrec.pepeCan: bot 1.99afq). */
function recordingsOffered() {
  try { const M = require("./micrec"); return M.policyOn() && M.pepeCan(); } catch (e) { return false; }
}
/** Has the account ever had a Camfrog login (now, or in its login history)? (The checkbox is shown only then.) */
async function hadLogin(userId, login) {
  if (login) return true;
  if ((await q("username_history", ["userId", "kind"], "SELECT 1 FROM username_history WHERE userId = ? AND kind = 'camfrog' LIMIT 1", [String(userId)])).length) return true;
  return (await q("login_changes", ["userId", "old_login"], "SELECT 1 FROM login_changes WHERE userId = ? AND old_login IS NOT NULL LIMIT 1", [String(userId)])).length > 0;
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dayText = (t) => { const d = new Date(t); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
/** views/privacy.ejs (terms.js): null while the choice isn't offered; else {on_at, on_day, export} - when the `erasure` switch
 *  was FIRST turned on (its hubseam_settings row's first_on - review 2: the date the paragraph about chat and deletion was
 *  published; turning the switch off and on again, a break-glass, doesn't re-date it; `updated` for a row from before first_on),
 *  and whether the `export` switch puts the hub's part in "Download my data" too. Never throws. */
async function privacyCopy() {
  if (!removeOffered()) return null;
  let exp = false;
  try { exp = require("./huboutbox").on("export"); } catch (e) { exp = false; }
  try {
    const r = (await getQuery("SELECT COALESCE(first_on, updated) AS at FROM hubseam_settings WHERE key = 'erasure' AND value = 'true'"))[0];
    const at = r && Number(r.at) > 0 ? Number(r.at) : null;
    return { on_at: at, on_day: at ? dayText(at) : null, export: exp };
  } catch (e) { return { on_at: null, on_day: null, export: exp }; }
}

/**
 * The member's own request. -> {ok, execute_at}. Throws Refuse (status, message, code) - E_ELEVATED, E_BLOCKED (with .block),
 * E_REAUTH, E_CONFIRM, E_PENDING; S1 V4: E_REMOVE_OFF (removePublic while the choice isn't offered), E_REMOVE_DAILY (with
 * .retry_at: a request with it in the last 24 hours).
 */
async function request(req, { password, confirm, hideLines = false, removePublic = false, deleteRecordings = false } = {}) {
  await init();
  const uid = String(req.user.userId);
  const u = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [uid]))[0];
  if (!u) throw new Refuse(404, "No such account.", "E_GONE");
  if (await elevated(u)) throw new Refuse(403, "Admin, staff and moderator accounts can't delete themselves. Ask another admin to do it.", "E_ELEVATED");
  if (await pendingOf(uid)) throw new Refuse(409, "Your account is already scheduled for deletion.", "E_PENDING");
  if (String(confirm == null ? "" : confirm).trim() !== u.username) throw new Refuse(400, "Type your username exactly to confirm.", "E_CONFIRM");
  if (removePublic) {
    if (!removeOffered()) throw new Refuse(409, "Removing your public messages isn't offered right now - reload the page.", "E_REMOVE_OFF");
    const wait = await removeWaitUntil(uid);
    if (wait) throw dailyRefusal(wait);
  }
  // mic retention: only while it's offered (the page shows the checkbox then)
  if (deleteRecordings && !recordingsOffered()) throw new Refuse(409, "Deleting your mic recordings isn't offered right now - reload the page.", "E_REC_OFF");
  let reauth = null;
  if (password) { if (await verifyPassword(uid, password)) reauth = "password"; else throw new Refuse(403, "That password isn't right.", "E_REAUTH"); }
  else if (await require("./sessions").isFresh(req)) reauth = "fresh-sign-in";
  if (!reauth) throw new Refuse(403, "Confirm it's you: enter your password, or sign out and sign back in (any way you like - Google, Apple, Plex, Telegram, Twitch, Discord or a !signin chat link) and delete within 10 minutes.", "E_REAUTH");
  const b = await blockers(uid);
  if (b.block.length) throw new Refuse(409, "Some things have to be closed first.", "E_BLOCKED", { block: b.block });
  return schedule(u, { by: "self", reauth, hideLines, removePublic, deleteRecordings });
}

const dailyRefusal = (wait) => new Refuse(429, "You can ask to remove your public messages once a day. Untick it, or try again after " +
  new Date(wait).toISOString().slice(0, 16).replace("T", " ") + " UTC.", "E_REMOVE_DAILY", { retry_at: wait });

async function schedule(u, { by = "self", reauth = null, reason = null, hideLines = false, removePublic = false, deleteRecordings = false } = {}) {
  await init();
  const t = now();
  const at = t + GRACE_MS;
  // S1 V4 fix-up (review): the pending and once-a-day checks again INSIDE the insert's transaction (dbUtils.tx runs one at a
  // time), so two requests at once can't both be scheduled, nor both carry "Also remove my public messages"
  await tx(async () => {
    if (await pendingOf(u.userId)) throw new Refuse(409, "Your account is already scheduled for deletion.", "E_PENDING");
    if (removePublic) {
      const wait = await removeWaitUntil(u.userId);
      if (wait) throw dailyRefusal(wait);
    }
    await runQuery(`INSERT INTO account_deletions (user_id, state, requested_at, execute_at, requested_by, reauth, reason, hide_lines, remove_public, delete_recordings)
                    VALUES (?, 'scheduled', ?, ?, ?, ?, ?, ?, ?, ?)`,
                   [String(u.userId), t, at, String(by).slice(0, 80), reauth, reason ? String(reason).slice(0, 200) : null, hideLines ? 1 : null, removePublic ? 1 : null,
                    deleteRecordings ? 1 : null]);
  });
  // review: the irreversible choice is said back (the answer the page shows, and the notice) - with how many Camfrog names it
  // reaches now and how many the team handles by hand (another PATV account held them before: Pepe can't tell whose is whose)
  let recordings = null;
  if (deleteRecordings) {
    recordings = { logins: 0, by_hand: 0 };
    try {
      const MR = require("./micrec");
      const lg = low(((await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [String(u.userId)]))[0] || {}).camfrogUsername) || null;
      const w = await MR.recWindowsOf(String(u.userId), lg, t);
      recordings = { logins: w.length, by_hand: w.length - MR.askable(w).length };
    } catch (e) { /* the counts are a courtesy */ }
  }
  await require("./sessions").revokeAll(u.userId, { why: "account deletion requested" });
  await require("./inbox").addSafe(u.userId, { kind: "system", title: "Your account is scheduled for deletion",
    body: `Your PATV account will be deleted on ${new Date(at).toISOString().slice(0, 10)}. Every device was signed out.` +
          (recordings ? " Your mic recordings will be deleted with it (you ticked Also delete my mic recordings)." : "") +
          " Changed your mind? Just sign in again before then - that cancels it.",
    link: "/settings/account#delete", ref: `acctdel:req:${t}` });
  console.log(`[acctdel] ${u.username} scheduled for ${new Date(at).toISOString()} (by ${by})`);
  return { ok: true, execute_at: at, ...(recordings ? { delete_recordings: true, recordings } : {}) };
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
/** The override, else Pepe's catalog default, else the Federal Reserve 100% (like the stale-account cleanup). Throws
 *  E_CFG_UNREADABLE / E_CFG_MISSING while the site owns the economy settings and can't read them: the deletion's transaction
 *  rolls back and is retried, never routed by a default (econstore.routeShares). */
async function shares() {
  return require("./econstore").routeShares(FLOW, [["reserve", 100]]);
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
  "adult_gate_cfg.by",                 // adultgate site: who last flipped the 18+ pad gate (the /pads/admin card shows it)
  // (CL13 fix-up: NOT dm_relays.from_login / to_login - they hold Camfrog logins only, never a PATV username, and matching
  //  them by username rewrote ANOTHER person's login whenever it equalled the deleted username. The person's own Camfrog
  //  logins - the current one and earlier ones - are replaced there by messages.cfLoginForget, step 6.)
];
const DISPLAY_COLUMNS = [["stage_slots", "displayname", "userId"], ["stage_queue", "displayname", "userId"]];

// Rows that are personal and go entirely: [table, column, value kind (uid | login | profile)]
const DELETE_ROWS = [
  ["sessions", "user_id", "uid"], ["session_cutoffs", "user_id", "uid"], ["sso_links", "user_id", "uid"],
  ["telegram_links", "user_id", "uid"], ["telegram_codes", "user_id", "uid"], ["telegram_prefs", "user_id", "uid"], ["telegram_outbox", "user_id", "uid"],
  ["crypto_wallets", "user_id", "uid"], ["crypto_link_nonces", "user_id", "uid"], ["chat_signin_tokens", "user_id", "uid"], ["chat_signin_prefs", "user_id", "uid"],
  ["chat_signin_log", "user_id", "uid"], ["incognito_log", "user_id", "uid"], ["incognito_state", "login", "login"],
  // wave 3 (design §N.4): 🧠 Pepe's memory switch - the audit and the linked login's state (the account key's row: below; Pepe's
  // side goes with his privacy.forget action)
  ["memory_optout_log", "user_id", "uid"], ["memory_optout_state", "login", "login"],
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
  ["activity_days", "userId", "uid"],
  ["casino_ach_counts", "userId", "uid"], ["casino_ach_base", "userId", "uid"], ["user_roles", "userId", "uid"], ["pad_members", "user_id", "uid"],
  ["pad_user_flairs", "user_id", "uid"], ["feed_room_members", "user_id", "uid"], ["launchpad_visits", "user_id", "uid"], ["premium_plus_waitlist", "user_id", "uid"],
  ["camfrog_userstats", "login", "login"], ["golive_log", "user_id", "uid"],
  ["help_misses", "user_id", "uid"], ["age_attest", "user_id", "uid"], ["plex_watch_stats", "user_id", "uid"],
  ["webpush_subs", "user_id", "uid"], ["webpush_outbox", "user_id", "uid"],   // 1.99acd: browser notifications (webpush.js)
  // storyreact site (storyreact.js): their story votes and the story references of the replies they sent (those messages are
  // blanked in step 3); story_tips are kept like post_tips (ledger evidence, no names in them)
  ["story_votes", "user_id", "uid"], ["dm_story_refs", "sender_id", "uid"],
  ["stage_leave", "user_id", "uid"], ["stage_leave", "login", "login"],      // stagefix site: "Take me off this Stage" (stageleave.js)
  ["stage_level", "user_id", "uid"], ["stage_level", "login", "login"],      // stagefix final round: the person's say over pins (stagepin.js)
  ["stage_pad_prefs", "user_id", "uid"], ["stage_pad_prefs", "login", "login"],
  ["stage_asks", "user_id", "uid"], ["stage_asks", "login", "login"], ["stage_asks", "actor_id", "uid"],
  // micfollow: the 🎙 mic stage - appearances, pads keeping them off it, the pads' notices, reports on them and by them
  // (their "no" to the mic stage itself is kept as an unlinked suppression record - see execute(), like livecam_optout)
  ["micfollow_spans", "login", "login"], ["micfollow_excl", "login", "login"], ["micfollow_excl", "user_id", "uid"],
  ["micfollow_notices", "login", "login"], ["micfollow_reports", "login", "login"], ["micfollow_reports", "reporter_id", "uid"],
  ["micfollow_courtesy", "login", "login"],                       // 1.99afn (FU-1): the one courtesy notice they had (account deletion only)
  ["seethrough_toggle", "user_id", "uid"],                        // 1.99afn: their "Show real names" switches (the audit log rows stay)
  // mfix: 📌 pins of their cam on a pad's mic stage, and the pins they made (micfollow's pin check ends a pin whose row is gone)
  ["micfollow_pins", "login", "login"], ["micfollow_pins", "by_id", "uid"],
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
  const sp = await stashPlan(login, uid);
  for (const s of sp.auto) {
    if (Number(s.balance) > 0) {
      const S = require("./stashes");
      const r = await S.withdraw({ key: `acctdel-${uid}-stash-${s.id}`, login: login || `u:${uid}`, stashId: s.id, amount: "all", userId: uid, via: "account-deleted" });
      if (!r || r.ok === false) throw new Error(`stash ${s.id} withdrawal refused: ${(r && (r.code || r.error)) || "?"}`);
      bump("stash_pat", Number(s.balance));
    }
    await runQuery("UPDATE stashes SET closed = ?, updated = ? WHERE id = ? AND closed IS NULL AND balance = 0", [t / 1000, t, s.id]).catch(() => {});
  }
}

/**
 * CL13 fix-up: the Camfrog logins that Pepe's `!msg` records (dm_relays, admins' "📨 Sent in Camfrog to <login>" logs) may
 * name for this account - its current login, and the earlier ones in its login history (username_history kind 'camfrog',
 * login_changes) that no other account has linked since (then the name is that account's now, and is left alone).
 * Read inside the job's transaction BEFORE step 5 deletes the history. -> [login, ...] (lower case)
 */
async function cfLoginsOf(uid, login) {
  const out = new Set(login ? [low(login)] : []);
  const past = [];
  // mic retention review 2: an account merged INTO this one is the same holder (micrec.holderIds) - its login history is this one's
  // (a merge moves username_history; login_changes keeps the merged-away id)
  const ids = await sameHolder(uid), qs = ids.map(() => "?").join(",");
  for (const r of await q("username_history", ["userId", "old_username", "new_username", "kind"],
                          `SELECT old_username AS a, new_username AS b FROM username_history WHERE userId IN (${qs}) AND kind = 'camfrog'`, ids)) past.push(r.a, r.b);
  for (const r of await q("login_changes", ["userId", "old_login", "new_login"], `SELECT old_login AS a, new_login AS b FROM login_changes WHERE userId IN (${qs})`, ids)) past.push(r.a, r.b);
  for (const l of past.map(low)) {
    if (!l || out.has(l)) continue;
    if (!(await getQuery(`SELECT 1 FROM users WHERE lower(camfrogUsername) = ? AND userId NOT IN (${qs}) LIMIT 1`, [l, ...ids]))[0]) out.add(l);
  }
  return [...out];
}
/** mic retention review 2: the ids that ARE this account - itself and the accounts merged into it (micrec.holderIds). -> [id, ...] */
async function sameHolder(uid) {
  try { return [...(await require("./micrec").holderIds(uid))]; } catch (e) { return [String(uid)]; }
}

/**
 * S1 V4 review 2: the spans in which each Camfrog login was THIS account's - "Also remove my public messages" reaches the web lines
 * it sent under them (the bridge archives a linked member's web line under the login; it is the line of whoever held the login
 * when it was sent). From the login history, read inside the job's transaction BEFORE step 5 deletes username_history and step 6
 * pseudonymises login_changes:
 *   - its login now: up to `upto` (the deletion - the login is released and may be someone else's afterwards);
 *   - every login it let go - an unlink, a relink, another account's !verify (its own login_changes old_login since 1.99tl, its
 *     username_history kind 'camfrog' rows since 1.99tg, 12 October 2026): up to that change;
 *   - each span starts after the latest earlier record about that login, whoever's (its own link of it or earlier release,
 *     another account's link, release or trace: the login wasn't this account's before then) - or at 0 with none (linked before
 *     the history began: every earlier web line under it counts as its own, as CL6's Remove my line does).
 * The backfill's 'seen' rows (the account was seen with a login it no longer has, release time unknown) end nothing - such a
 * login was let go before the history began and isn't reached; another account's 'seen' row still bounds a start. Spans may
 * overlap (two records of one change: removeAccountLines ORs them). -> [{login, from, to}] (ms, from exclusive, to inclusive)
 * Mic retention review 2: an account merged INTO this one is the same holder (micrec.holderIds) - the logins it let go are this
 * account's too (a merge moves username_history; login_changes keeps the merged-away id), and its 'seen' traces are its own.
 */
async function loginWindowsOf(uid, login, upto) {
  const ends = new Map();                                   // login -> [end, ...]
  const end = (l, at) => { l = low(l); at = Math.floor(Number(at)); if (!l || !(at > 0)) return; if (!ends.has(l)) ends.set(l, []); ends.get(l).push(at); };
  if (login) end(login, upto);
  const lc = await has("login_changes", "userId", "old_login", "new_login", "at");
  const uh = await has("username_history", "userId", "old_username", "new_username", "kind", "at", "via");
  const ids = await sameHolder(uid), qs = ids.map(() => "?").join(",");
  if (lc) for (const r of await getQuery(`SELECT old_login, at FROM login_changes WHERE userId IN (${qs}) AND old_login IS NOT NULL`, ids)) end(r.old_login, r.at);
  if (uh) for (const r of await getQuery(`SELECT old_username, at FROM username_history WHERE userId IN (${qs}) AND kind = 'camfrog' AND via <> 'seen'`, ids)) end(r.old_username, r.at);
  const out = [];
  for (const [l, list] of ends) {
    const marks = [];                                       // every record about the login, whoever's (but this account's traces)
    if (lc) for (const r of await getQuery("SELECT at FROM login_changes WHERE lower(old_login) = ? OR lower(new_login) = ?", [l, l])) marks.push(Number(r.at) || 0);
    if (uh) {
      for (const r of await getQuery(`SELECT at FROM username_history WHERE kind = 'camfrog' AND (lower(old_username) = ? OR lower(new_username) = ?)
                                      AND NOT (userId IN (${qs}) AND via = 'seen')`, [l, l, ...ids])) marks.push(Number(r.at) || 0);
    }
    for (const to of [...new Set(list)]) {
      const from = marks.reduce((m, at) => (at < to && at > m ? at : m), 0);
      out.push({ login: l, from, to });
    }
  }
  return out;
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
  // Sign in with Apple: the link's Apple token joins applesso's revocation queue INSIDE the transaction that deletes the link (a
  // restart can't lose it) and is sent to Apple right after it (applesso.flushQueued; the queue retries what fails)
  const appleSso = (await getQuery("SELECT name FROM pragma_table_info('sso_links')")).some((c) => c.name === "refresh_token_enc") ? require("./applesso") : null;
  if (appleSso) await appleSso.init();
  let appleKeys = [];
  let pubWindows = null;                     // S1 V4 review 2: loginWindowsOf, read in the transaction below (step 3)
  let recWindows = null;                     // mic retention: micrec.recWindowsOf, read in the transaction below (step 3)
  let recSkipped = null;                     // review: the spans not asked of Pepe (another account held the login before)
  await require("./micrec").init();          // review: the login markers' key, before the transaction
  try {
    const M = require("./media");
    const path = require("path"), fs = require("fs");
    for (const m of mediaRows) { if (m.file) { try { fs.unlinkSync(path.join(M.DIR, m.file)); } catch (e) { /* gone */ } } try { M.removePoster(m.id); } catch (e) { /* none */ } }
  } catch (e) { /* no media module */ }
  // CL6 (decision 14): "Also hide my past public chat lines" - the login (while the row still knows it) and the account key join
  // the pad chat archive's sticky hidden set for good (src delete). Never inside the transaction below (the hidden set serialises
  // its own writes); a deletion that has to be retried leaves them hidden, which is what the member asked for.
  if (Number(reqRow.hide_lines) === 1) {
    await require("./chatlog").hideNow(["u:" + uid.toLowerCase(), login].filter(Boolean), "delete");
    report.chat_lines_hidden = true;
  }
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
    //    (CL11: a `!msg` copy's relay row - its key and Camfrog logins - goes with the message)
    n("dm_relays_deleted", await run("dm_relays", ["message_id"], "DELETE FROM dm_relays WHERE message_id IN (SELECT id FROM messages WHERE sender_id = ?)", [uid]));
    n("messages_deleted", await run("messages", ["sender_id"], "UPDATE messages SET body = '', deleted_at = COALESCE(deleted_at, ?), deleted_by = COALESCE(deleted_by, ?) WHERE sender_id = ?", [t, uid, uid]));
    n("conversations_left", await run("conversation_members", ["user_id", "left_at"], "UPDATE conversation_members SET left_at = COALESCE(left_at, ?), hidden = 1 WHERE user_id = ?", [t, uid]));
    // storyreact site: other people's replies to their stories keep the message, but the card about them becomes
    // "Story no longer available" (their media is deleted in step 4 anyway) and the name snapshot goes
    n("story_refs_unlinked", await run("dm_story_refs", ["author_id"], "UPDATE dm_story_refs SET author_id = NULL, author_name = NULL WHERE author_id = ?", [uid]));
    //    CL13: their own "📨 Sent in Camfrog to <login>" threads go entirely (only they were in them; the key names a Camfrog login)
    const cfIds = (await q("conversations", ["kind", "dm_key"], `SELECT c.id FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id
                                                                 WHERE c.kind = 'cfpm' AND m.user_id = ?`, [uid])).map((r) => r.id);
    for (let i = 0; i < cfIds.length; i += 200) {
      const part = cfIds.slice(i, i + 200), qs = part.map(() => "?").join(",");
      n("camfrog_threads_messages", await run("messages", ["conversation_id"], `DELETE FROM messages WHERE conversation_id IN (${qs})`, part));
      await run("conversation_members", ["conversation_id"], `DELETE FROM conversation_members WHERE conversation_id IN (${qs})`, part);
      n("camfrog_threads_deleted", await run("conversations", ["id"], `DELETE FROM conversations WHERE id IN (${qs})`, part));
    }
    //    CL13 fix-up: every Camfrog login of theirs that other people's `!msg` records may name (read before step 5)
    const cfLogins = await cfLoginsOf(uid, login);
    //    S1 V4 review 2: with "Also remove my public messages", each Camfrog login's span as theirs (read before step 5 too)
    if (Number(reqRow.remove_public) === 1) pubWindows = await loginWindowsOf(uid, login, t);
    //    mic retention: with "Also delete my mic recordings", each Camfrog login's recordings span (read before step 5 too)
    if (Number(reqRow.delete_recordings) === 1) recWindows = await require("./micrec").recWindowsOf(uid, login, t);
    //    review: a keyed marker per Camfrog login the account had (no name - micrec.noteLoginsGone), before step 6 pseudonymises
    //    the login history - a later holder of that name never downloads what Pepe keeps of this account (micrec.earlierHolder).
    //    Review 2: NOT behind the mic-recordings switch, on purpose - they protect Download my data's Pepe part, which is offered
    //    with the switch off too; views/privacy.ejs discloses them (section 10, section 9) without the switch (ops plan 7.3 / 8.5).
    //    The logins of accounts merged into this one are its own (loginWindowsOf / cfLoginsOf).
    {
      const gone = new Map();
      for (const w of await loginWindowsOf(uid, login, t)) gone.set(w.login, Math.max(gone.get(w.login) || 0, Number(w.to) || t));
      for (const l of cfLogins) if (!gone.has(l)) gone.set(l, t);
      n("login_markers", await require("./micrec").noteLoginsGone([...gone].map(([l, at]) => ({ login: l, at }))));
    }
    // (their DM pictures go with the deleted messages: dmmedia.sweep purges the files after its grace period)
    // 4. clips they made / of them
    n("clips_removed", await run("media", ["by_user_id", "deleted"], "UPDATE media SET deleted = 1 WHERE by_user_id = ? OR (? IS NOT NULL AND lower(subject_login) = ?)", [uid, login, login]));
    // 5. personal rows (Apple's tokens to the revocation queue first, in this transaction)
    if (appleSso) {
      const appleLinks = await getQuery("SELECT subject, refresh_token_enc FROM sso_links WHERE provider = 'apple' AND user_id = ?", [uid]);
      appleKeys = await appleSso.queueRows(appleLinks, "account deleted");
    }
    for (const [table, col, kind] of DELETE_ROWS) {
      const v = kind === "login" ? login : uid;
      if (!v) continue;
      n("deleted:" + table, await run(table, [col], `DELETE FROM "${table}" WHERE "${col}" = ?`, [v]));
    }
    n("deleted:follows(target)", await run("follows", ["target_id", "target_kind"], "DELETE FROM follows WHERE (target_kind = 'user' AND target_id = ?) OR (target_kind = 'room' AND target_id = ?)", [uid, "user:" + uid]));
    // micfollow: the mic-stage switch - "on" (the default) is just deleted; "off" stays as a suppression record no longer tied
    // to the account, so their cam is still never put on a pad's mic stage by itself (deleting it would undo their "no")
    //    wave 3: 🧠 Pepe's memory switch of the account key "u:<userId>" (an account without a chat login)
    n("deleted:memory_optout_state(acct)", await run("memory_optout_state", ["login"], "DELETE FROM memory_optout_state WHERE login = ?", ["u:" + String(uid).toLowerCase()]));
    if (login) {
      n("deleted:micfollow_optout", await run("micfollow_optout", ["login", "off"], "DELETE FROM micfollow_optout WHERE login = ? AND off = 0", [login]));
      n("micfollow_optout_unlinked", await run("micfollow_optout", ["login", "user_id"], "UPDATE micfollow_optout SET user_id = NULL WHERE login = ?", [login]));
    }
    // CL2: the pad chat archive (chatlog.js) - their own web lines ("u:<id>") keep no name (a "former member" when shown), their
    // chat-log downloads log goes, their reports and settings changes no longer name them. CL6 fix-up: a staff read audit they
    // wrote stays (2 years, like content_audit_views: the users row is a tombstone); one that names them as its subject gets the
    // pseudonym
    for (const [k, v] of Object.entries(await require("./chatlog").deleteAccount(uid, { login, pseudo }))) n("chatlog:" + k, v);
    // CL3 fix-up: ...and the pad owner the chat watermarks last saw (chatlog_rooms.owner_id / inputs.owner) isn't their id any more
    n("chatlog:owner_ref", await require("./chatlogview").forgetOwner(uid));
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
    //    CL13: other people's Camfrog threads named after their login ("📨 Sent in Camfrog to <login>") are re-keyed to the
    //    pseudonym, and so are the copies' records naming it. Fix-up: for every login of theirs (current + earlier), and ONLY
    //    by login - dm_relays is no longer matched by PATV username (NAME_COLUMNS)
    if (cfLogins.length && ((await has("conversations", "kind", "dm_key")) || (await has("dm_relays", "to_login")))) {
      const M = require("./messages");
      for (const l of cfLogins) {
        const f = await M.cfLoginForget(l, pseudo);
        n("pseudonymised", f.relays); n("camfrog_threads_renamed", f.threads);
      }
    }
    // 7. Pepe forgets the Camfrog login (website action; queued while the row still knows the login)
    //    1.99aft (review): an account WITHOUT a chat login gets the action too (no login on it, args ACCT_FORGET_ARGS): Pepe keeps
    //    its account key "u:<userId>" (what it says in pads from the website) on his memory switch's list - he clears it for the
    //    action's user_id (pepe_incognito._incog_forget_web; an older Pepe answers "nothing to forget")
    if (await tableExists("pepe_actions")) {
      await runQuery(`INSERT OR IGNORE INTO pepe_actions (user_id, username, camfrog, site_admin, kind, args, tag, label, status, created, updated, idem)
                      VALUES (?, ?, ?, 0, ?, ?, 'privacy', 'account deleted', 'pending', ?, ?, ?)`,
                     [uid, pseudo, login || null, FORGET_KIND, login ? "[]" : ACCT_FORGET_ARGS, t, t, `acctdel-forget-${uid}-1`]);
      report.pepe_forget = "queued";
    }
    //    mic retention: "Also delete my mic recordings" - one "privacy.recdelete" action per login (the end of its span in the args;
    //    the login stays on the action and in rec_windows until Pepe takes it - micrec.retryRecDeletes re-asks; counts only in the
    //    report). A login another account held before is never asked about (Pepe would delete that holder's recordings too): skipped
    if (recWindows) {
      const MR = require("./micrec");
      const all = recWindows;
      recWindows = MR.askable(all);
      report.recordings = { logins: all.length, queued: await MR.queueRecDeletes(uid, pseudo, recWindows, t), skipped: all.length - recWindows.length };
      // review: the skipped spans are kept (admins only, bounded - micrec.retryRecDeletes / skippedHandled) so someone can act on them
      recSkipped = all.filter((w) => !recWindows.includes(w)).map((w) => ({ login: w.login, from: w.from, to: w.to }));
      if (report.recordings.skipped) console.error(`[acctdel] ${pseudo}: ${report.recordings.skipped} Camfrog login(s) another account held before - their recordings were NOT asked to be deleted (by hand: /admin/bridge#micrec)`);
    }
    // 8. the users row: a pseudonymous tombstone (the ledger's rows still point at it; nobody can sign in to it)
    const set = { username: pseudo, displayname: "Deleted user", email: null, password: randomHash, avatar: "/public/img/avatar.png", class: "pleb",
                  discordId: null, discordUsername: null, twitchId: null, twitchDisplayname: null, twitchLogin: null, camfrogUsername: null,
                  streamId: null, streamKey: null, emailVerificationToken: null, tokenExpires: null, isEmailVerified: 0, resetPasswordToken: null,
                  resetPasswordExpires: null, archived_at: t, password_set: 0, displayname_auto: 0,
                  age_confirmed_at: null, age_confirmed_v: null,         // adultgate site: the age confirmation goes with the person
                  text_style: null };                                    // S1 Q5b: the chat text style (textstyle.js) too
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
    // 10. 1.99acm: the chat hub's erasure (huboutbox topic privacy/account-deleted, switch hubseam.erasure - the R-12 privacy
    //     seam): committed with the deletion or not at all; the hub pseudonymises the account's chat lines as a "former member"
    //     under this pseudonym, revokes its chat credentials and journals the erasure. S1 V4: remove_public is the member's
    //     "Also remove my public messages" (seam plan D-23): the hub then hard-deletes their public lines' text instead, the
    //     held ones (an open report) once their hold ends.
    //     The payload names the account only - never the released chat login, nor a hash of it (an unkeyed hash of a short
    //     public username is reversible, and the hub's deletion journal is write-once; identity-scoped erasure is S2's).
    //     (S1 V4 fix-up: with the choice, the account's Camfrog logins wait on the row until the archive's part below has run: a
    //     linked member's web lines are archived under them. Review 2: every login it had linked, each with the span it was the
    //     account's - public_windows (loginWindowsOf). NULLed by removePublicNow.)
    const rp = Number(reqRow.remove_public) === 1;
    await runQuery(`UPDATE account_deletions SET state = 'done', done_at = ?, pseudonym = ?, report = ?, held_reason = NULL, public_login = NULL,
                    public_windows = ?, rec_windows = ?, rec_done_at = ?, rec_skipped = ? WHERE id = ?`,
                   [t, pseudo, JSON.stringify(report).slice(0, 20000), rp && pubWindows && pubWindows.length ? JSON.stringify(pubWindows) : null,
                    recWindows && recWindows.length ? JSON.stringify(recWindows) : null,
                    recWindows && !recWindows.length ? t : null,                    // (no login Pepe can be asked about: done - report.recordings says why)
                    recSkipped && recSkipped.length ? JSON.stringify(recSkipped) : null,
                    reqRow.id]);
    await require("./huboutbox").emit("privacy/account-deleted", "acct:" + uid,
      hubRow({ id: reqRow.id, user_id: uid, pseudonym: pseudo, done_at: t, remove_public: reqRow.remove_public }), { dedupe: "acctdel:" + reqRow.id });
  });
  // 11. S1 V4: "Also remove my public messages" - the pad chat archive's part (ADR 0007 OQ-20: the same choice hard-deletes the
  //     account's web lines there, with the hub's exceptions; a linked member's web lines are under its logins, each inside the
  //     span it was theirs - review 2: loginWindowsOf, read above; the login released now is someone else's to link from here on).
  //     After the commit, so nothing is purged for a deletion that rolls back (or that a sign-in then cancels); public_done_at
  //     records it, and the tick runs it again until it has (a restart between the commit and here, a failure, an archive that
  //     can't be reached - review 2: that throws, it never counts as done).
  if (Number(reqRow.remove_public) === 1) {
    try { report.public_removed = await removePublicNow(uid, reqRow.id, { windows: pubWindows || [] }); }
    catch (e) { console.error("[acctdel] remove public lines:", e.message); }
  }
  try { await require("./accountexport").removeAll(uid); } catch (e) { /* none */ }
  try { require("./sessions")._clearCache(); } catch (e) { /* none */ }
  // adultgate site: the 18+ gate forgets the account (and, when it was them, the switch card's "last changed by" reloads pseudonymised)
  try {
    const AG = require("./adultgate");
    AG.drop(uid);
    if (AG.isReady()) await AG.load().catch(() => {});
  } catch (e) { /* no gate */ }
  // Apple: the deleted account's authorization ends at Apple too (queued above; a failed call is retried by applesso's queue)
  if (appleKeys.length) {
    try { report.apple_revoked = await appleSso.flushQueued(appleKeys); }
    catch (e) { console.error("[acctdel] apple revoke:", e.message); }
  }
  console.log(`[acctdel] ${uid} deleted -> ${pseudo}${report.route ? ` (${report.route.amount} PAT -> ${report.route.legs.map(([d, a]) => `${d} ${a}`).join(", ")})` : ""}`);
  return { ok: true, state: "done", report };
}

/** 1.99acm: a done account_deletions row -> the chat hub's privacy/account-deleted payload (the feed row and the snapshot's).
 *  acct is the hub's account_id (the ticket's sub), v1_user the raw id, request the deletion's id (the hub's origin ref). */
function hubRow(r) {
  return { acct: require("./huboutbox").accountOf(r.user_id), v1_user: String(r.user_id), pseudonym: r.pseudonym || null,
           remove_public: Number(r.remove_public) === 1,           // S1 V4: the member's choice (the row's remove_public)
           request: Number(r.id), at: Number(r.done_at) || null };
}

/** S1 V4: the pad chat archive's part of "Also remove my public messages" for a done deletion (chatlogmod.removeAccountLines:
 *  the account's web lines purged - with `windows` (review 2: loginWindowsOf), its web lines under each Camfrog login inside the
 *  span it was the account's too; `login` + `upto` for a row from before review 2 -, a legal hold's or a report's taken down until
 *  they end), then public_done_at and the counts on the request's report, and the row forgets the logins. Review 2: one run per
 *  request at a time (the step after the commit and the tick's retry share it), none once public_done_at is set (its counts
 *  answer), and the first run to finish writes the counts (the UPDATE's public_done_at IS NULL). Throws when the archive can't
 *  be reached (public_done_at stays NULL: retried). -> {lines, held} */
const removing = new Map();                  // request id -> the run in progress
function removePublicNow(userId, reqId, opts = {}) {
  const id = Number(reqId);
  if (removing.has(id)) return removing.get(id);
  const run = (async () => {
    const d = (await getQuery("SELECT public_done_at, report FROM account_deletions WHERE id = ?", [id]))[0];
    if (d && d.public_done_at != null) {
      let rep = {};
      try { rep = JSON.parse(d.report || "{}") || {}; } catch (e) { rep = {}; }
      return rep.public_removed || { lines: 0, held: 0 };
    }
    const { windows = null, login = null, upto = null } = opts;
    const r = await require("./chatlogmod").removeAccountLines(String(userId), Array.isArray(windows) ? { windows } : { login, upto });
    const counts = { lines: r.purged, held: r.held + r.reported };
    const row = (await getQuery("SELECT report FROM account_deletions WHERE id = ?", [id]))[0];
    let rep = {};
    try { rep = JSON.parse((row && row.report) || "{}") || {}; } catch (e) { rep = {}; }
    rep.public_removed = counts;
    await runQuery("UPDATE account_deletions SET public_done_at = ?, report = ?, public_login = NULL, public_windows = NULL WHERE id = ? AND public_done_at IS NULL",
                   [now(), JSON.stringify(rep).slice(0, 20000), id]);
    return counts;
  })().finally(() => { removing.delete(id); });
  removing.set(id, run);
  return run;
}
/** S1 V4: a DONE deletion whose archive part didn't run (a restart between its commit and the purge, a failure, review 2: an
 *  archive that couldn't be reached): run it now, with the logins and spans the row kept for it. Never a scheduled, held or
 *  cancelled request (a sign-in in the grace undoes those). An unreachable archive stops the round (one log line, not one per
 *  request); the next tick tries again. */
async function retryRemovePublic() {
  await init();
  let n = 0;
  for (const d of await getQuery(`SELECT id, user_id, public_login, public_windows, done_at FROM account_deletions
                                  WHERE state = 'done' AND remove_public = 1 AND public_done_at IS NULL ORDER BY id LIMIT 20`)) {
    let windows = null;
    try { windows = d.public_windows ? JSON.parse(d.public_windows) : null; } catch (e) { windows = null; }
    const opts = Array.isArray(windows) ? { windows } : { login: d.public_login || null, upto: Number(d.done_at) || null };   // (a pre-review-2 row)
    try { await removePublicNow(d.user_id, d.id, opts); n++; }
    catch (e) {
      console.error("[acctdel] remove public lines (retry):", e.message);
      if (e && e.code === "archive_db") break;
    }
  }
  return n;
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
    const acts = await getQuery("SELECT id, camfrog, args, status, idem, updated FROM pepe_actions WHERE user_id = ? AND kind = ? ORDER BY id", [d.user_id, FORGET_KIND]);
    if (!acts.length || acts.some((a) => ["pending", "claimed", "done", "ok"].includes(a.status))) {
      // done: the login doesn't need to stay on the row any more
      for (const a of acts) if (a.camfrog && ["done", "ok"].includes(a.status)) await runQuery("UPDATE pepe_actions SET camfrog = NULL WHERE id = ?", [a.id]);
      continue;
    }
    const last = acts[acts.length - 1];
    const acctOnly = !last.camfrog && String(last.args || "") === ACCT_FORGET_ARGS;      // 1.99aft: the account key's action
    if (acts.length >= FORGET_TRIES || (!last.camfrog && !acctOnly)) continue;
    if (now() - Number(last.updated || 0) < FORGET_RETRY_MS) continue;            // spaced out: Pepe may be restarting
    const t = now();
    await runQuery(`INSERT OR IGNORE INTO pepe_actions (user_id, username, camfrog, site_admin, kind, args, tag, label, status, created, updated, idem)
                    SELECT user_id, username, camfrog, 0, kind, ?, 'privacy', 'account deleted', 'pending', ?, ?, ? FROM pepe_actions WHERE id = ?`,
                   [acctOnly ? ACCT_FORGET_ARGS : "[]", t, t, `acctdel-forget-${d.user_id}-${acts.length + 1}`, last.id]);
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
    try { await retryRemovePublic(); } catch (e) { console.error("[acctdel] remove public retry:", e.message); }
    try { await require("./micrec").retryRecDeletes(); } catch (e) { console.error("[acctdel] recordings retry:", e.message); }
    // review 4: the Mic recordings text is on but Pepe's report no longer matches it -> the admins are told (micrec.drift)
    try { await require("./micrec").drift(); } catch (e) { console.error("[acctdel] recordings drift:", e.message); }
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
    if (e instanceof Refuse) return res.status(e.status).json({ ok: false, error: e.message, code: e.code, block: e.block || undefined, retry_at: e.retry_at || undefined });
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
      // S1 V4: "Also remove my public messages" only while the hub's erasure switch is on; wait = asked in the last 24 hours
      const removePublic = removeOffered() ? { wait: await removeWaitUntil(u.userId) } : null;
      // mic retention: "Also delete my mic recordings" - while offered, and only to an account that has (had) a Camfrog login
      const lg = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [u.userId]).catch(() => []))[0];
      const recordings = recordingsOffered() && (await hadLogin(u.userId, low(lg && lg.camfrogUsername) || null));
      res.render("accountDelete", { user: u.username, username: u.username, block: b.block, settle: b.settle, elevated: await elevated(u),
        hasPassword: u.password_set === undefined || u.password_set === null || Number(u.password_set) !== 0,
        fresh: await require("./sessions").isFresh(req), graceDays: GRACE_MS / DAY, pending: await pendingOf(u.userId), removePublic, recordings });
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
      const r = await request(req, { password: typeof b.password === "string" ? b.password : "", confirm: b.confirm, hideLines: b.hide_lines === true,
                                     removePublic: b.remove_public === true, deleteRecordings: b.delete_recordings === true });
      require("./middleware/loginCookie").clearLogin(res);
      res.json(r);
    } catch (e) { fail(res, e); }
  });
  // admins: schedule another member's deletion (the way for admin / staff / moderator accounts), list, cancel
  const admin = async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) { res.status(401).json({ ok: false, error: "Sign in first." }); return null; }
    const row = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]).catch(() => []))[0];
    if (!SP.can(row, "accounts.delete_other")) { res.status(403).json({ ok: false, error: "Admins only." }); return null; }
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
      if (String((req.body || {}).reason || "").trim().length < 3) throw new Refuse(400, "Give a reason.", "E_REASON");   // 1.99wl
      if (await pendingOf(target.userId)) throw new Refuse(409, "Already scheduled.", "E_PENDING");
      const b = await blockers(target.userId);
      if (b.block.length) throw new Refuse(409, "Some things have to be closed first.", "E_BLOCKED", { block: b.block });
      const r = await schedule(target, { by: "admin:" + me.userId, reauth: "admin", reason: (req.body || {}).reason });
      await require("./adminaudit").record(me, "account.delete", target, { execute_at: r.execute_at }, (req.body || {}).reason);
      res.json(r);
    } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/account-deletions/:id/cancel", addUser, async (req, res) => {
    const me = await admin(req, res); if (!me) return;
    try {
      await init();
      // 1.99wl: a reason + the member's username typed as the confirmation; audited
      const d = (await getQuery(`SELECT d.id, d.user_id, u.username FROM account_deletions d LEFT JOIN users u ON u.userId = d.user_id
                                 WHERE d.id = ? AND d.state IN ('scheduled','held')`, [Number(req.params.id) || 0]))[0];
      if (!d) throw new Refuse(404, "No pending deletion with that id.");
      const b = req.body || {};
      if (String(b.confirm || "").trim() !== d.username) throw new Refuse(400, "Type the member's username exactly to confirm.", "E_CONFIRM");
      if (String(b.reason || "").trim().length < 3) throw new Refuse(400, "Give a reason.", "E_REASON");
      const r = await runQuery("UPDATE account_deletions SET state = 'cancelled', cancelled_at = ?, cancel_via = ? WHERE id = ? AND state IN ('scheduled','held')",
                               [now(), "admin:" + me.userId, d.id]);
      if (r && r.changes) await require("./adminaudit").record(me, "account.delete_cancel", { userId: d.user_id, username: d.username }, { id: d.id }, String(b.reason).slice(0, 200));
      res.json({ ok: !!(r && r.changes) });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { hubRow, init, register, blockers, request, schedule, cancelOnSignIn, execute, tick, sweepTombstones, retryForget, routeBalanceInTx, shares,
                   pendingOf, isDeleted, elevated, Refuse, FLOW, FORGET_KIND, GRACE_MS, NAME_COLUMNS, DELETE_ROWS,
                   removeOffered, removeWaitUntil, privacyCopy, retryRemovePublic, REMOVE_EVERY_MS,      // S1 V4
                   loginWindowsOf,                                                                        // S1 V4 review 2
                   recordingsOffered, hadLogin,                                                           // mic retention
                   verifyPassword,                                                                        // review: the export's step-up
                   _setClock: (f) => { clock = f || (() => Date.now()); } };
