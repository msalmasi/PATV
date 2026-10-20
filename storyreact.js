// storyreact.js — ▲▼ votes, 💸 tips and ↩ replies on stories (storyreact site, owner request 2026-10-19: "upvote / downvote /
// tip stories, like feed posts, and reply to them - sends a DM, like replying to an IG story").
//
// RULES
//   * One visibility rule for every surface (visibleTo / storyFor): the story is live (not deleted, its file on disk, inside
//     min(created + stories.WINDOW_MS, expires) - a stage capture can outlive its story on /media), it's a pad story or a
//     member's own profile upload, the viewer may see the pad (padaccess.canSee - Approved first - then the 18+ gate), and
//     (feed config story_block_hide, ON by default) nobody in it is blocked either way: an upload's uploader, a cam capture's
//     subject (any account linked to subject_login, or their cam_blocks on the viewer), a stage capture's streamer. The
//     strips (stories.forViewer, userstories.people, feedweb's pad thumbnails), the viewer API, the three actions, the DM
//     card, its thumbnail and "open" all use it. Every failure is the same 404 "This story isn't available any more."
//     The block rule applies to every capture whose person the server knows (subject_login / the slot), incognito ones
//     included - but an anon capture never stores a login (media.js blanks it on purpose), so there is nobody to check and it
//     shows like any anonymous content. A block lookup that fails FAILS CLOSED: strips keep only the viewer's own uploads,
//     one story / an action / a card is refused (never "no blocks").
//   * The AUTHOR (authorOf) gets tips and replies and is who the self / block rules use. An upload: the uploader. A cam
//     capture: the person on cam - the REAL PATV account linked to subject_login (messages.linkedAccount's rule: never an
//     auto "CF…" account). A stage capture: the slot's streamer, own-stream slots only (mainstage featuredMark's rule). Never
//     the capturer (they stay credited as "by"). Nobody (votes only) for: Pepe, archived accounts, anon subjects, unlinked /
//     auto-only logins, library / cam slots, Pepe's broadcast, a private subject (userstories.isPrivate, fails closed), a
//     capture the subject hid from their story, a capture of someone who turned "Show captures of me in my story" off
//     (story_prefs.captures_of_me: their captures aren't tied to their profile, so nothing is routed to it either), and a
//     capture whose subject turned "Let people vote, tip and reply on snaps and clips of me" off (story_prefs.capture_reacts -
//     that also turns VOTES off on it). The author must be able to see the story too (pad access + 18+, POLICY.authorReach) or
//     tips and replies are off. Resolution is internal: no client ever gets an author id, username, login or the reason there
//     is no author - and the name / role only ride along when THIS viewer can actually tip or reply (otherwise "no 💸" would
//     tell apart "nobody to route to" from "the person on cam isn't approved / 18+-confirmed for this pad").
//   * Votes: the feed's model (feedstore voter / cleanDir / downCounts / burst / voteRate / noteVote - one per account,
//     change / undo, the SHARED per-account budget with posts + comments, w = 0 downvotes below level 2 unverified). In their
//     own table, so they pay no activity PAT, earn no achievements and never touch feed rankings. A vote cast while the voter
//     is blocked either way with the person in the story (or cam-blocked by them - possible only with story_block_hide off) is
//     stored with w = 0: theirs to see, never counted. That is decided when the vote is cast and NEVER re-decided by a later
//     block / unblock: counts that moved with blocks would let the author block-and-watch their way to a voter list. Counts
//     are a plain SUM of w = 1 rows, like the feed's stored counts. Nobody is ever shown who voted. No notices.
//   * Tips: tips.transferPat - the one tip path (full amount, "tip sent" / "tip received" ledger rows, the "tip" notice, the
//     tip achievements, streaks) - then a story_tips tag row (unique by the request ref; the tag never undoes the tip). Not in
//     a dbUtils.tx (transferPat's ledger.post self-wraps). Every refusal happens before any PAT moves. PAT is points. A tip
//     to someone on cam / on stage (who never posted the story) is capped per sender and person a day
//     (story_capture_tips_per_person_per_day), and its NOTE follows the DM rules (messages.refusal: who can message them,
//     the new-account rule, consent) - the tip can always go without one.
//   * Replies: an ordinary DM (messages.send) - every DM rule, refusal text, rate limit and alert unchanged; the body is
//     exactly the reply text. The story reference is a dm_story_refs row written in the same dbUtils.tx as the message, never
//     in the body. Each reader's card is built when it's shown (cardsFor) and re-checks visibility for THAT reader: one
//     neutral "Story no longer available" for every reason. The card's picture only comes from GET
//     /messages/story/:messageId/thumb (members of the conversation, checked per request) - never a /media URL or the id.
//
// DATA (init)
//   story_votes    story_id + user_id PK, value (+1 / -1), w (1 = counts), created, updated. Purged 7 days after the story
//                  leaves (sweep).
//   story_tips     one row per story tip: story_id, sender_id, recipient_id, amount, note, role (uploader | subject |
//                  streamer), room_id, story_kind, story_source, sent_tx, recv_tx, ref (UNIQUE), created. Kept (ledger evidence).
//   dm_story_refs  message_id PK -> story_id, conversation_id, sender_id, author_id, role, the story's kind / source / pad /
//                  pad title / author name / created (a snapshot for the admin report view only), quick (an emoji quick
//                  reaction), opened (this reply started the conversation), created. Goes with the message (dropRef) -
//                  except a deleted reply that OPENED a conversation with someone on cam / stage: it leaves a stub
//                  (story_id '', no names, no pad) that D-12 still counts, swept after a day.
//   story_prefs.capture_reacts (userstories.js) - the opt-out above, default 1.
//
// REUSE: storyFor(viewer, id) -> {row, item} | null; authorOf(row, ctx, item); annotate(viewer, items) (the per-item `react`
// the viewer paints); cardsFor(viewer, refs). Routes: register(app, {addUser, idemBegin}).
"use strict";
const fs = require("fs");
const path = require("path");
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");
const rooms = require("./rooms");
const M = () => require("./media");      // lazy: messages.js reads refs without loading the captures module

// ── owner decisions (spec §1): each one flips here ──
const POLICY = Object.freeze({
  captureAuthor: "subject",        // D-1: "subject" (the person on cam / the own-stream streamer) | "none" (captures are vote-only)
  captureReactsDefault: 1,         // D-2: "Let people vote, tip and reply on snaps and clips of me" starts ON
  countsPublic: true,              // D-4: the score shows to everyone who can see the story (false: the author only)
  autoSelfUp: false,               // D-5: no automatic +1 on your own upload
  captureDownvotes: true,          // D-7: ▼ on captures of people (the opt-out covers anyone who minds)
  tipTally: true,                  // D-8: "💸 N tips · X PAT" shows to viewers, like posts
  authorReach: true,               // D-13: tip / reply only when the author can see the story too
  authorVoterList: false,          // D-15: no voter list for anyone (not built)
  voteKeepMs: 7 * 86400e3,         // D-17: votes are purged this long after the story leaves
});
const QUICK = Object.freeze(["😂", "😮", "😍", "😢", "👏", "🔥", "🎉", "💯"]);   // D-11
const CID_RE = /^[a-f0-9]{8,32}$/i;
const LOGIN_RE = /^[\w.\-]{1,40}$/;
const GONE = "This story isn't available any more.";
const NOTE_REF = "storytip:";
let NOW = () => Date.now();
function _setClock(fn) { NOW = fn || (() => Date.now()); }

class Refuse extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.refuse = true; if (code) this.code = code; } }

const store = () => require("./feedstore");
const stories = () => require("./stories");
const PA = () => require("./padaccess");
const cfg = () => store().config();
const WINDOW = () => stories().WINDOW_MS;
const lc = (s) => String(s == null ? "" : s).trim().toLowerCase();
const qs = (n) => new Array(n).fill("?").join(",");

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await M().ready;
      await runQuery(`CREATE TABLE IF NOT EXISTS story_votes (
        story_id TEXT NOT NULL, user_id TEXT NOT NULL, value INTEGER NOT NULL, w INTEGER NOT NULL DEFAULT 1,
        created INTEGER NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (story_id, user_id))`);
      await runQuery("CREATE INDEX IF NOT EXISTS story_votes_user ON story_votes (user_id, updated)");
      await runQuery(`CREATE TABLE IF NOT EXISTS story_tips (
        id INTEGER PRIMARY KEY AUTOINCREMENT, story_id TEXT NOT NULL, sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
        amount INTEGER NOT NULL, note TEXT, role TEXT NOT NULL, room_id TEXT, story_kind TEXT, story_source TEXT,
        sent_tx TEXT, recv_tx TEXT, ref TEXT, created INTEGER NOT NULL)`);
      await runQuery("CREATE INDEX IF NOT EXISTS story_tips_story ON story_tips (story_id)");
      await runQuery("CREATE INDEX IF NOT EXISTS story_tips_sender ON story_tips (sender_id, created)");
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS story_tips_ref ON story_tips (ref)");
      await runQuery(`CREATE TABLE IF NOT EXISTS dm_story_refs (
        message_id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL, story_id TEXT NOT NULL,
        sender_id TEXT NOT NULL, author_id TEXT, role TEXT,
        story_kind TEXT, story_source TEXT, room_id TEXT, room_title TEXT, author_name TEXT, story_created INTEGER,
        quick INTEGER NOT NULL DEFAULT 0, opened INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL)`);
      await runQuery("CREATE INDEX IF NOT EXISTS dm_story_refs_sender ON dm_story_refs (sender_id, created)");
      await runQuery("CREATE INDEX IF NOT EXISTS dm_story_refs_author ON dm_story_refs (author_id)");
      await runQuery("CREATE INDEX IF NOT EXISTS dm_story_refs_story ON dm_story_refs (story_id)");
      await require("./userstories").init();       // story_prefs.capture_reacts
    })().catch((e) => { console.error("[storyreact] init:", e.message); ready = null; throw e; });
  }
  return ready;
}

// ── small reads ──
let UCOLS = null;
async function userCols() {
  if (!UCOLS) UCOLS = new Set((await getQuery("PRAGMA table_info(users)")).map((c) => c.name));
  return UCOLS;
}
async function userSel(alias = "") {
  const C = await userCols();
  const p = alias ? alias + "." : "";
  const pick = (c) => (C.has(c) ? p + c : `NULL AS ${c}`);
  return `${p}userId, ${p}username, ${p}class, ${pick("displayname")}, ${pick("camfrogUsername")}, ${pick("archived_at")}, ${pick("level")}`;
}
const TABLES = new Map();          // table -> exists (cached once true)
/** Does the table exist (a fresh DB may not have dm_blocks / cam_blocks yet)? A failing lookup THROWS - never "no table",
 *  which would read as "no blocks". */
async function hasTable(t) {
  if (TABLES.get(t)) return true;
  const ok = !!(await getQuery("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", [t]))[0];
  if (ok) TABLES.set(t, true);
  return ok;
}
const kindOf = (r) => (r.kind === "clip" || r.kind === "audio" ? r.kind : "photo");
const sourceOf = (r) => (r.source === "stage" ? "stage" : r.source === "user" ? "user" : "cam");
const isCapture = (r) => r.source !== "user";
/** The story's own end: it leaves the story at min(created + 24 h, expires) (a stage capture's page can outlive it). */
const endOf = (r) => Math.min((Number(r.created) || 0) + WINDOW(), Number(r.expires) || 0);
function live(row, t = NOW()) {
  return !!row && !Number(row.deleted) && M().fileExists(row) && t < endOf(row);
}
const exemptFeed = (u) => SP.can(u, "feed.limits_exempt");
const exemptDm = (u) => SP.can(u, "dm.limits_exempt");

/** A per-request context: caches for the lookups below (one query per kind per request). */
function mkCtx() {
  return { t: NOW(), acct: new Map(), linked: new Map(), priv: new Map(), prefs: new Map(), hides: null, hideIds: new Set(),
           slots: new Map(), blocks: new Map(), camv: null };
}

async function loadAccounts(ctx, ids) {
  const need = [...new Set(ids.filter((x) => x && !ctx.acct.has(String(x))).map(String))];
  if (!need.length) return;
  for (let i = 0; i < need.length; i += 400) {
    const part = need.slice(i, i + 400);
    const rows = await getQuery(`SELECT ${await userSel()} FROM users WHERE userId IN (${qs(part.length)})`, part);
    for (const r of rows) ctx.acct.set(String(r.userId), r);
    for (const id of part) if (!ctx.acct.has(id)) ctx.acct.set(id, null);
  }
}
/** login -> {real: account | null, ids: [every account linked to it]} - messages.linkedAccount's rule, batched. */
async function loadLinked(ctx, logins) {
  const need = [...new Set(logins.map(lc).filter((l) => LOGIN_RE.test(l) && !ctx.linked.has(l)))];
  if (!need.length) return;
  const AUTO = require("./autoaccount").AUTO_LOGIN;
  for (let i = 0; i < need.length; i += 400) {
    const part = need.slice(i, i + 400);
    const rows = await getQuery(`SELECT ${await userSel()}, lower(camfrogUsername) AS lg FROM users WHERE lower(camfrogUsername) IN (${qs(part.length)})`, part);   // throws: fail closed
    const by = new Map();
    for (const r of rows) { if (!by.has(r.lg)) by.set(r.lg, []); by.get(r.lg).push(r); }
    for (const l of part) {
      const list = (by.get(l) || []).sort((a, b) => Number(AUTO.test(a.username)) - Number(AUTO.test(b.username)));
      let real = null;
      for (const r of list) {
        ctx.acct.set(String(r.userId), r);
        if (!real && !r.archived_at && !AUTO.test(r.username)) real = r;
      }
      ctx.linked.set(l, { real, ids: list.map((r) => String(r.userId)) });
    }
  }
}
async function loadSlots(ctx, ids) {
  const need = [...new Set(ids.filter((x) => x && !ctx.slots.has(String(x))).map(String))];
  if (!need.length) return;
  // no stage yet: no slots; a failing read throws (the block rule fails closed)
  const rows = (await hasTable("stage_slots")) ? await getQuery(`SELECT * FROM stage_slots WHERE id IN (${qs(need.length)})`, need) : [];
  for (const r of rows) ctx.slots.set(String(r.id), r);
  for (const id of need) if (!ctx.slots.has(id)) ctx.slots.set(id, null);
}
/** user id -> {reacts: capture_reacts, mine: captures_of_me} (no row: the defaults - both on). */
async function loadPrefs(ctx, ids) {
  const need = [...new Set(ids.filter((x) => x && !ctx.prefs.has(String(x))).map(String))];
  if (!need.length) return;
  const rows = await getQuery(`SELECT user_id, capture_reacts, captures_of_me FROM story_prefs WHERE user_id IN (${qs(need.length)})`, need);
  for (const r of rows) {
    ctx.prefs.set(String(r.user_id), { reacts: r.capture_reacts == null ? !!POLICY.captureReactsDefault : !!Number(r.capture_reacts),
                                       mine: r.captures_of_me == null ? true : !!Number(r.captures_of_me) });
  }
  for (const id of need) if (!ctx.prefs.has(id)) ctx.prefs.set(id, { reacts: !!POLICY.captureReactsDefault, mine: true });
}
async function loadHides(ctx, captureIds) {
  const need = [...new Set(captureIds.filter((x) => x && !ctx.hideIds.has(String(x))).map(String))];
  if (!ctx.hides) ctx.hides = new Set();
  if (!need.length) return;
  const rows = await getQuery(`SELECT user_id, capture_id FROM story_hides WHERE capture_id IN (${qs(need.length)})`, need);   // throws: fail closed
  for (const r of rows) ctx.hides.add(String(r.user_id) + "|" + String(r.capture_id));
  for (const id of need) ctx.hideIds.add(id);
}
async function isPrivate(ctx, userId) {
  const k = String(userId);
  if (!ctx.priv.has(k)) ctx.priv.set(k, await require("./userstories").isPrivate(k));   // fails closed
  return ctx.priv.get(k);
}
/** Everyone blocked EITHER way with `userId` (messages.cardBlocks; a fresh DB without dm_blocks: nobody). A failing lookup
 *  THROWS - callers fail closed. */
async function blockedWith(userId) {
  const k = String(userId || "");
  if (!k || !(await hasTable("dm_blocks"))) return new Set();
  return require("./messages").cardBlocks(k);
}
async function blocksOf(ctx, userId) {
  const k = String(userId || "");
  if (!k) return new Set();
  if (!ctx.blocks.has(k)) ctx.blocks.set(k, await blockedWith(k));
  return ctx.blocks.get(k);
}
/** camviewers (cam_blocks, mirrored in memory) - loaded once per process. Its init failing THROWS (fail closed); only a
 *  build without the module at all has no cam blocks. */
async function camv(ctx) {
  if (ctx && ctx.camv) return ctx.camv;
  let CV = null;
  try { CV = require("./camviewers"); } catch (e) { CV = null; }
  if (CV) await CV.init();
  if (ctx) ctx.camv = CV;
  return CV;
}
async function camBlocked(ctx, login, userId) {
  if (!login || !userId) return false;
  const CV = await camv(ctx);
  return !!CV && CV.blocked(login, userId);
}

/** Batch everything authorOf / hiddenIds need for these rows. */
async function prepare(ctx, rows) {
  const ups = [], slotIds = [], logins = [], caps = [];
  for (const r of rows) {
    if (!r) continue;
    if (r.source === "user") { if (r.by_user_id) ups.push(r.by_user_id); continue; }
    caps.push(r.id);
    if (r.source === "stage") { if (r.slot_id) slotIds.push(r.slot_id); continue; }
    if (!Number(r.anon) && r.subject_login) logins.push(r.subject_login);
  }
  await loadSlots(ctx, slotIds);
  await loadLinked(ctx, logins);
  const streamers = slotIds.map((s) => ctx.slots.get(String(s))).filter((s) => s && s.userId).map((s) => String(s.userId));
  await loadAccounts(ctx, ups.concat(streamers));
  const subjects = logins.map((l) => (ctx.linked.get(lc(l)) || {}).real).filter(Boolean).map((a) => String(a.userId));
  await loadPrefs(ctx, streamers.concat(subjects));
  await loadHides(ctx, caps);
}

// ── who it's from: the author ──
const ownStream = (s) => !!s && !!s.userId && (s.mode || "stream") === "stream" && s.source !== "library" && s.source !== "cam";
/**
 * The story's author for tips, replies and the self / block rules:
 *   {userId, username, name, role, votes, reach, acctId, login} - or {userId: null, role: null, votes, acctId, login, why}.
 * acctId: the PERSON behind it even when they aren't the author (private, hidden, opted out) - counts leave out the votes of
 * people blocked with them; login: the cam subject's login (their cam_blocks). why / acctId / login are internal: never sent.
 */
async function authorOf(row, ctx = mkCtx(), item = null) {
  await prepare(ctx, [row]);
  const none = (why, extra) => Object.assign({ userId: null, username: null, name: null, role: null, votes: true, reach: false, acctId: null, login: null, why }, extra || {});
  if (!row) return none("gone");
  let acct = null, role = null, name = null, login = null;
  if (row.source === "user") {
    acct = row.by_user_id ? ctx.acct.get(String(row.by_user_id)) || null : null;
    role = "uploader";
    name = item ? item.by : String(row.by_user || "").trim().slice(0, 60) || null;
  } else if (row.source === "stage") {
    const s = row.slot_id ? ctx.slots.get(String(row.slot_id)) : null;
    if (!ownStream(s)) return none("stage");                 // Pepe's broadcast, library / cam slots, a missing slot
    acct = ctx.acct.get(String(s.userId)) || null;
    role = "streamer";
    name = String(s.displayname || s.username || "").trim().slice(0, 60) || null;
  } else {
    if (Number(row.anon) || !row.subject_login) return none("anon");
    login = lc(row.subject_login);
    const L = ctx.linked.get(login);
    acct = L ? L.real : null;                                // a real account first; auto-only / none -> nobody
    role = "subject";
    name = item ? item.subject : String(row.subject || "").trim().slice(0, 60) || null;
    if (!acct) return none("unlinked", { login });
  }
  if (!acct) return none("gone", { login });
  const uid = String(acct.userId);
  const base = { acctId: uid, login };
  if (store().isPepe(uid) || acct.archived_at) return none("pepe_or_archived", base);
  if (isCapture(row)) {
    if (POLICY.captureAuthor !== "subject") return none("policy", base);
    if (!ctx.prefs.has(uid)) await loadPrefs(ctx, [uid]);
    const P = ctx.prefs.get(uid);
    if (!P.reacts) return none("opted_out", Object.assign({}, base, { votes: false }));   // D-2: votes off too
    // "Show captures of me in my story" off: their captures aren't tied to their profile - nothing is routed to it either
    if (!P.mine) return none("not_mine", base);
    if (await isPrivate(ctx, uid)) return none("private", base);
    if (!ctx.hides) await loadHides(ctx, [row.id]);
    if (ctx.hides.has(uid + "|" + row.id)) return none("hidden", base);
  }
  let reach = true;
  if (POLICY.authorReach && row.room) {
    await PA().init();
    reach = PA().canSee(acct, row.room) && PA().adultGate(acct, row.room) === "ok";
  }
  return { userId: uid, username: acct.username, name, role, votes: true, reach, acctId: uid, login };
}

// ── what a viewer may see ──
const blockHide = () => cfg().story_block_hide !== false;
/**
 * Ids of `rows` whose person is blocked either way with `viewer` (uploader / cam subject / streamer; cam_blocks) - D-3 hides
 * them, and a vote cast on one never counts. Every capture whose person is known counts, incognito ones included (a real
 * anon capture has no subject_login - media.js never stores one - so there is nobody to check). Lookups that fail throw.
 */
async function hiddenIds(viewer, rows, ctx = mkCtx()) {
  const out = new Set();
  if (!viewer || !viewer.userId || !rows.length) return out;
  const me = String(viewer.userId);
  const B = await blocksOf(ctx, me);
  const cams = rows.filter((r) => r && isCapture(r) && r.source !== "stage" && r.subject_login);
  const stages = rows.filter((r) => r && r.source === "stage" && r.slot_id);
  if (B.size) {
    await loadLinked(ctx, cams.map((r) => r.subject_login));
    await loadSlots(ctx, stages.map((r) => r.slot_id));
  }
  const CV = cams.length ? await camv(ctx) : null;
  for (const r of rows) {
    if (!r) continue;
    if (r.source === "user") {
      if (r.by_user_id && String(r.by_user_id) !== me && B.has(String(r.by_user_id))) out.add(r.id);
    } else if (r.source === "stage") {
      const s = B.size && r.slot_id ? ctx.slots.get(String(r.slot_id)) : null;
      if (s && s.userId && String(s.userId) !== me && B.has(String(s.userId))) out.add(r.id);
    } else if (r.subject_login) {
      const l = lc(r.subject_login);
      const L = B.size ? ctx.linked.get(l) : null;
      if ((L && L.ids.some((id) => id !== me && B.has(id))) || (CV && CV.blocked(l, me))) out.add(r.id);
    }
  }
  return out;
}
/** Story items (stories.clean shape, carrying their raw row) minus the ones blocks hide from `viewer` (D-3). When the block
 *  lookup fails it FAILS CLOSED: only the viewer's own uploads stay (a transient DB error never shows a blocked person). */
async function hideBlocked(viewer, items, ctx = mkCtx()) {
  if (!viewer || !viewer.userId || !Array.isArray(items) || !items.length || !blockHide()) return items;
  try {
    const hid = await hiddenIds(viewer, items.map((it) => it && it._row).filter(Boolean), ctx);
    return hid.size ? items.filter((it) => !hid.has(it.id)) : items;
  } catch (e) {
    console.error("[storyreact] hideBlocked (failing closed):", e.message);
    const me = String(viewer.userId);
    return items.filter((it) => it && it._row && it._row.source === "user" && String(it._row.by_user_id || "") === me);
  }
}
/** Placement: on a profile pad (user:<uid>) only that member's own uploads are stories; any other room is a pad. */
function placed(row) {
  const room = String((row && row.room) || "");
  return !rooms.isProfile(room) || (row.source === "user" && room === rooms.PROFILE_PREFIX + String(row.by_user_id || ""));
}
/** May `viewer` (signed in) see story row `row` right now? The ONE rule (spec §3). Signed out: a live Public-pad story. */
async function visibleTo(viewer, row, ctx = mkCtx()) {
  if (!row || !live(row, ctx.t) || !placed(row)) return false;
  const room = String(row.room || "");
  await PA().init();
  if (!viewer || !viewer.userId) return !!room && !rooms.isProfile(room) && PA().isPublic(room) && PA().adultGate(null, room) === "ok";
  if (!PA().canSee(viewer, room) || PA().adultGate(viewer, room) !== "ok") return false;
  if (blockHide() && (await hiddenIds(viewer, [row], ctx)).has(row.id)) return false;
  return true;
}
/** One story for a signed-in viewer: {row, item} (item = the stories.clean shape) or null - the same answer for every reason. */
async function storyFor(viewer, id, ctx = mkCtx()) {
  const sid = String(id || "");
  if (!viewer || !viewer.userId || !CID_RE.test(sid)) return null;
  await init();
  const row = (await getQuery("SELECT * FROM media WHERE id = ?", [sid]))[0];
  if (!row || !(await visibleTo(viewer, row, ctx))) return null;
  const item = (await stories().clean([row]))[0];
  return item ? { row, item } : null;
}

// ── counts ──
/** story ids -> Map id -> {ups, downs}: the w = 1 votes, as stored. Never re-filtered by blocks at read time - a count that
 *  moved when the author blocks / unblocks someone would tell them exactly who voted (a vote cast while blocked is stored
 *  with w = 0 instead, see vote()). One grouped query per 400 stories. */
async function voteCounts(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400).map(String);
    const rows = await getQuery(`SELECT story_id AS id, SUM(value = 1) AS ups, SUM(value = -1) AS downs FROM story_votes
                                 WHERE w = 1 AND story_id IN (${qs(part.length)}) GROUP BY story_id`, part);
    for (const r of rows) out.set(r.id, { ups: Number(r.ups) || 0, downs: Number(r.downs) || 0 });
  }
  return out;
}
async function myVotes(userId, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    for (const r of await getQuery(`SELECT story_id, value FROM story_votes WHERE user_id = ? AND story_id IN (${qs(part.length)})`, [String(userId), ...part])) {
      out.set(r.story_id, r.value > 0 ? 1 : -1);
    }
  }
  return out;
}
/** Map story id -> {n, total} (stories with no tips are left out). */
async function tipTallies(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    for (const r of await getQuery(`SELECT story_id, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM story_tips
                                    WHERE story_id IN (${qs(part.length)}) GROUP BY story_id`, part)) {
      out.set(r.story_id, { n: Number(r.n) || 0, total: Number(r.total) || 0 });
    }
  }
  return out;
}
async function countsOne(row) {
  const c = (await voteCounts([row.id])).get(row.id) || { ups: 0, downs: 0 };
  return { score: c.ups - c.downs, ups: c.ups, downs: c.downs };
}

/**
 * The per-item `react` the story viewer paints (mutates + returns items; items carry their raw row as `_row`). Signed out
 * (a Public pad's story): the counts only, signin: true. Never an author id, username, login or why there is no author.
 */
async function annotate(viewer, items) {
  const list = (items || []).filter((it) => it && it._row);
  if (!list.length) return items;
  try {
    await init();
    const C = cfg();
    const ctx = mkCtx();
    const signed = !!(viewer && viewer.userId);
    await prepare(ctx, list.map((it) => it._row));
    const A = new Map();
    for (const it of list) A.set(it.id, await authorOf(it._row, ctx, it));
    const ids = list.map((it) => it.id);
    const votesOn = C.story_votes !== false;
    const counts = votesOn ? await voteCounts(ids) : new Map();
    const mine = signed && votesOn ? await myVotes(viewer.userId, ids) : new Map();
    const tipsOn = C.story_tips !== false;
    const tally = tipsOn && POLICY.tipTally ? await tipTallies(ids) : new Map();
    const me = signed ? String(viewer.userId) : null;
    const B = signed ? await blocksOf(ctx, me) : new Set();
    const pepe = signed && store().isPepe(viewer);
    for (const it of list) {
      const a = A.get(it.id);
      const self = signed && !!a.acctId && a.acctId === me;
      const v = votesOn && a.votes !== false;
      const c = counts.get(it.id) || { ups: 0, downs: 0 };
      const show = v && (POLICY.countsPublic || self);
      const blockedPair = signed && !!a.userId && (B.has(a.userId) || (a.login ? await camBlocked(ctx, a.login, me) : false));
      const act = signed && !pepe && !!a.userId && (a.reach || !POLICY.authorReach) && !self && !blockedPair;
      const tip = tipsOn && act, reply = C.story_replies !== false && act;
      // the name / role only when this viewer can tip or reply: otherwise "a name but no 💸" would tell apart "nobody to route
      // to" from "the person on cam can't open this pad" (not approved, not 18+-confirmed) or "has a linked account"
      const named = tip || reply;
      it.react = {
        votes: v,
        score: show ? c.ups - c.downs : 0, ups: show ? c.ups : 0, downs: show ? c.downs : 0,
        tips: tally.get(it.id) || null,
        can: { vote: v && signed && !pepe, down: v && signed && !pepe && !self && (POLICY.captureDownvotes || it._row.source === "user"),
               tip, reply, quick: reply && C.story_quick_reacts !== false },
        to: named ? a.name || null : null,
        role: named ? a.role : null,
        signin: !signed,
      };
      if (signed) it.react.my = v ? mine.get(it.id) || 0 : 0;
    }
  } catch (e) { console.error("[storyreact] annotate:", e.message); }
  return items;
}
/** The signed-out Public-pad strip: read-only counts. */
async function counts(items) { return annotate(null, items); }

// ── ▲▼ votes ──
async function vote(user, id, dir) {
  await init();
  if (cfg().story_votes === false) throw new Refuse(403, "Story votes are off right now.");
  if (!user || !user.userId) throw new Refuse(401, "Sign in to vote.");
  const ctx = mkCtx();
  const s = await storyFor(user, id, ctx);
  if (!s) throw new Refuse(404, GONE);
  const S = store();
  const u = await S.voter(user);                                    // signed in, not Pepe, not archived, no global feed ban
  const a = await authorOf(s.row, ctx, s.item);
  if (a.votes === false) throw new Refuse(403, "Votes are off for this story.");
  const d = S.cleanDir(dir);
  const cur = (await getQuery("SELECT value, w FROM story_votes WHERE story_id = ? AND user_id = ?", [s.row.id, u.userId]))[0];
  const now = cur ? (cur.value > 0 ? 1 : -1) : 0;
  const want = d === null ? (now === 1 ? 0 : 1) : d;
  const self = !!a.acctId && a.acctId === String(u.userId);
  if (want === -1 && self) throw new Refuse(403, "You can't downvote your own story.");
  if (want === -1 && !POLICY.captureDownvotes && isCapture(s.row)) throw new Refuse(403, "Downvotes are off for this story.");
  if (want === now) return Object.assign({ vote: now, counted: !cur || cur.w === 1, changed: false }, await countsOne(s.row));
  if (S.burst("svote|" + u.userId + "|" + s.row.id, 300)) throw new Refuse(429, "Easy there.");
  const rate = S.voteRate(u);                                       // the SAME per-account budget as posts + comments
  if (rate) throw new Refuse(429, rate);
  // blocked either way with the person in it (only reachable with story_block_hide off): kept for the voter, never counted -
  // decided NOW, never re-decided by a later block / unblock (counts that move with blocks would name the voters)
  const blk = (await hiddenIds(u, [s.row], ctx)).has(s.row.id);
  const w = blk || (want === -1 && !S.downCounts(u)) ? 0 : 1;
  const t = NOW();
  if (want === 0) await runQuery("DELETE FROM story_votes WHERE story_id = ? AND user_id = ?", [s.row.id, u.userId]);
  else {
    await runQuery(`INSERT INTO story_votes (story_id, user_id, value, w, created, updated) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(story_id, user_id) DO UPDATE SET value = excluded.value, w = excluded.w, updated = excluded.updated`,
                   [s.row.id, u.userId, want, w, t, t]);
  }
  S.noteVote(u);
  return Object.assign({ vote: want, counted: want === 0 || w === 1, changed: true }, await countsOne(s.row));
}
/** D-5 alternative (POLICY.autoSelfUp): a member's own upload starts with their +1. Off by default; never fails the upload. */
async function selfUp(userId, storyId) {
  if (!POLICY.autoSelfUp || !userId || !storyId) return;
  try {
    await init();
    const t = NOW();
    await runQuery("INSERT OR IGNORE INTO story_votes (story_id, user_id, value, w, created, updated) VALUES (?, ?, 1, 1, ?, ?)", [storyId, userId, t, t]);
  } catch (e) { /* never fails the upload */ }
}

// ── 💸 tips ──
const WHAT = {
  uploader: () => "your story",
  subject: (k) => (k === "clip" ? "a clip of you" : k === "audio" ? "a recording of you" : "a snap of you"),
  streamer: (k) => (k === "clip" ? "a clip of your stream" : "a snap of your stream"),
};
/** The tip notice (kind "tip" through transferPat): never names a /media address. */
function tipNotice(sender, a, s, n, note, key) {
  const R = s.row.room ? rooms.getCached(s.row.room) : null;
  const profile = rooms.isProfile(s.row.room);
  const title = `${sender.username} tipped ${(WHAT[a.role] || WHAT.uploader)(s.item.kind)} PAT ${n.toLocaleString("en-US")}`;
  const padTitle = R && !profile ? R.title || null : null;
  const body = note ? `"${note}"` : a.role === "uploader" ? (padTitle ? `On your story in ${padTitle}` : "On your story") : padTitle ? `In ${padTitle}` : "";
  const link = profile ? "/u/" + encodeURIComponent(a.username) : R ? require("./pads").padHref(R) : "/feed";
  return { title, body, link, ref: key ? NOTE_REF + key : null };
}
/**
 * Tip a story's author. `key` = "<username>:<client key>" (the route claimed it in idempotency_keys). Every refusal is
 * before any PAT moves. -> {ok, amount, balance, tips: {n, total}}
 */
async function tip({ sender, id, amount, note, key = null } = {}) {
  await init();
  const C = cfg();
  if (C.story_tips === false) throw new Refuse(403, "Story tips are off right now.");
  if (!sender || !sender.userId || !sender.username) throw new Refuse(401, "Sign in first.");
  const S = store();
  if (S.isPepe(sender)) throw new Refuse(403, "Pepe doesn't tip.");
  const u = await S.account(sender.userId);
  if (!u) throw new Refuse(401, "Sign in first.");
  if (u.archived_at) throw new Refuse(403, "This account is archived.");
  let banned = false;
  try { banned = !!(await getQuery("SELECT 1 FROM feed_bans WHERE user_id = ? AND room_id = '' AND (until IS NULL OR until > ?)", [u.userId, NOW()]))[0]; } catch (e) { banned = false; }
  if (banned) throw new Refuse(403, "You can't send tips right now.");
  const n = require("./public/js/patamount").parse(amount);
  if (!Number.isFinite(n)) throw new Refuse(400, "Use a number like 2500, 25k or 1.5m.");
  if (n < 1) throw new Refuse(400, "Tip at least 1 PAT.");
  const tips = require("./tips");
  const clean = tips.cleanTipNote(note);
  const ctx = mkCtx();
  const s = await storyFor(sender, id, ctx);
  if (!s) throw new Refuse(404, GONE);
  const a = await authorOf(s.row, ctx, s.item);
  if (!a.userId || (POLICY.authorReach && !a.reach)) throw new Refuse(400, "This story can't be tipped.");
  if (a.userId === String(u.userId)) throw new Refuse(400, "You can't tip your own story.");
  const shown = a.name || "someone";
  const DM = require("./messages");
  // blocks either way + the cam owner's cam block; a failing lookup throws (500, nothing moved) - never "not blocked"
  const blocked = (await hasTable("dm_blocks")) && (await DM.blocked(u.userId, a.userId)).length > 0;
  if (blocked || (a.login && (await camBlocked(ctx, a.login, u.userId)))) throw new Refuse(403, `You can't tip ${shown}.`);
  const capture = a.role === "subject" || a.role === "streamer";
  // someone on cam / on stage never posted the story: a NOTE to them is user text in their inbox (and their Telegram), so it
  // follows the DM rules - who can message them, consent, the new-account rule. The tip itself can go without one.
  if (capture && clean) {
    await DM.init();
    const me = await DM.account(u.userId), them = await DM.account(a.userId);
    const no = me && them ? await DM.refusal(me, them, await DM.dmBetween(me.userId, them.userId), { name: shown }) : true;
    if (no) throw new Refuse(403, `You can't add a note for ${shown} - send the tip without one.`, "note");
  }
  // D-9: a gap + an hourly cap (staff exempt from the cap)
  if (S.burst("stip|" + u.userId, 1500)) throw new Refuse(429, "Easy there - one tip at a time.");
  const cap = Number(C.story_tips_per_hour) || 0;
  if (cap > 0 && !exemptFeed(u)) {
    const k = (await getQuery("SELECT COUNT(*) AS n FROM story_tips WHERE sender_id = ? AND created > ?", [u.userId, NOW() - 3600e3]))[0].n;
    if (k >= cap) throw new Refuse(429, "You've sent a lot of story tips this hour - try again later.");
  }
  // ...and per person on cam / on stage: one sender can't bury them in tip notices (staff exempt)
  const pair = Number(C.story_capture_tips_per_person_per_day) || 0;
  if (capture && pair > 0 && !exemptFeed(u)) {
    const k = (await getQuery("SELECT COUNT(*) AS n FROM story_tips WHERE sender_id = ? AND recipient_id = ? AND created > ?",
                              [u.userId, a.userId, NOW() - 86400e3]))[0].n;
    if (k >= pair) throw new Refuse(429, `You've tipped ${shown} a lot today - try again tomorrow.`);
  }
  const r = await tips.transferPat(u.username, a.username, n, clean, { notice: tipNotice(u, a, s, n, clean, key) });
  if (!r.ok) throw new Refuse(r.status, r.msg);
  // the tag: never undoes the tip if it fails (the PAT moved; the row is the story's tally)
  try {
    await runQuery(`INSERT OR IGNORE INTO story_tips (story_id, sender_id, recipient_id, amount, note, role, room_id, story_kind, story_source, sent_tx, recv_tx, ref, created)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                   [s.row.id, r.senderId || u.userId, r.recipientId || a.userId, r.amount, clean, a.role, s.row.room || null, s.item.kind, s.item.source,
                    r.sentTx || null, r.recvTx || null, key, NOW()]);
  } catch (e) { console.error("[storyreact] tip tag:", e.message); }
  return { ok: true, amount: r.amount, balance: r.balance, tips: (await tipTallies([s.row.id])).get(s.row.id) || { n: 0, total: 0 } };
}

// ── ↩ replies ──
/**
 * Everything a reply needs, and why it can't be sent (no: a Refuse with the DM's status / text / code) - the sheet's
 * preflight and the send share it. -> {s, a, me, them, conv, no}
 */
async function replyPlan(user, id) {
  await init();
  const C = cfg();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const ctx = mkCtx();
  const s = await storyFor(user, id, ctx);
  if (!s) throw new Refuse(404, GONE);
  if (C.story_replies === false) return { s, no: new Refuse(403, "Story replies are off right now.", "off") };
  const a = await authorOf(s.row, ctx, s.item);
  const DM = require("./messages");
  await DM.init();
  if (!a.userId || (POLICY.authorReach && !a.reach) || a.userId === DM.PEPE_ID) return { s, a, no: new Refuse(403, "You can't reply to this story.", "story") };
  if (a.userId === String(user.userId)) return { s, a, no: new Refuse(400, "You can't reply to your own story.", "self") };
  const me = await DM.account(user.userId);
  const them = await DM.account(a.userId);
  if (!me) throw new Refuse(401, "Sign in first.");
  if (!them) return { s, a, no: new Refuse(403, "You can't reply to this story.", "story") };
  const name = a.name || "someone";
  const conv = await DM.dmBetween(me.userId, them.userId);
  // the DM decision itself (blocks either way, who-can-message, consent, the new-account rule...), in the DM's words
  const no = await DM.refusal(me, them, conv, { name });
  if (no) return { s, a, me, them, conv, no };
  // the person on cam blocked this account from their cam: as neutral as a DM block
  if (a.login && (await camBlocked(ctx, a.login, me.userId))) return { s, a, me, them, conv, no: new Refuse(403, `You can't message ${name}.`, "blocked") };
  // D-12: replies that START a conversation with someone on cam / on stage
  const cap = Number(C.story_capture_new_convos_per_day) || 0;
  if (!conv && (a.role === "subject" || a.role === "streamer") && cap > 0 && !exemptDm(me)) {
    const k = (await getQuery(`SELECT COUNT(*) AS n FROM dm_story_refs WHERE sender_id = ? AND opened = 1 AND role IN ('subject', 'streamer') AND created > ?`,
                              [me.userId, NOW() - 86400e3]))[0].n;
    const what = cap === 1 ? "1 conversation" : `${cap} conversations`;
    if (k >= cap) return { s, a, me, them, conv, no: new Refuse(429, `You can start ${what} a day by replying to snaps and clips - try again tomorrow.`, "rate") };
  }
  return { s, a, me, them, conv, no: null };
}
/** The sheet's preflight: {canSend, refusal, code} - never the author's username or id. */
async function replyCheck(user, id) {
  const p = await replyPlan(user, id);
  return { canSend: !p.no, refusal: p.no ? p.no.message : null, code: p.no ? p.no.code || null : null };
}
/** Send a reply: an ordinary DM to the author + its story reference. -> {conversation (id), created} */
async function reply(user, id, { body, quick } = {}, auditCtx = null) {
  const p = await replyPlan(user, id);
  if (p.no) throw p.no;
  let text = body;
  const q = quick === true || quick === 1 || quick === "1";
  if (q) {
    if (cfg().story_quick_reacts === false) throw new Refuse(403, "Quick reactions are off right now.");
    text = String(body == null ? "" : body).trim();
    if (!QUICK.includes(text)) throw new Refuse(400, "Pick one of the quick reactions.");
  }
  const { s, a } = p;
  const R = s.row.room ? rooms.getCached(s.row.room) : null;
  const ref = { storyId: s.row.id, authorId: a.userId, role: a.role, kind: s.item.kind, source: s.item.source, roomId: s.row.room || null,
                roomTitle: R ? R.title || null : null, authorName: a.name || null, storyCreated: Number(s.row.created) || null, quick: q };
  const r = await require("./messages").send(user, { to: p.them.username, body: text }, auditCtx, { storyRef: ref, refusalName: a.name || "someone" });
  return { conversation: r.conversation.id, created: !!r.created };
}
/** messages.send's half: the reference row, written in the SAME dbUtils.tx as the message (messages.js). -> the row */
async function insertRef(messageId, conversationId, senderId, ref, { opened = false, t = NOW() } = {}) {
  await init();
  const row = { message_id: messageId, conversation_id: conversationId, story_id: String(ref.storyId), sender_id: String(senderId),
                author_id: ref.authorId ? String(ref.authorId) : null, role: ref.role || null, story_kind: ref.kind || null, story_source: ref.source || null,
                room_id: ref.roomId || null, room_title: ref.roomTitle ? String(ref.roomTitle).slice(0, 120) : null,
                author_name: ref.authorName ? String(ref.authorName).slice(0, 60) : null, story_created: ref.storyCreated || null,
                quick: ref.quick ? 1 : 0, opened: opened ? 1 : 0, created: t };
  const cols = Object.keys(row);
  await runQuery(`INSERT INTO dm_story_refs (${cols.join(", ")}) VALUES (${qs(cols.length)})`, cols.map((c) => row[c]));
  return row;
}
/** The reference rows of these messages (Map message id -> row). No table yet: none. */
async function refsFor(messageIds) {
  const out = new Map();
  const ids = [...new Set((messageIds || []).map((x) => parseInt(x, 10)).filter((x) => x > 0))];
  if (!ids.length || !(await hasTable("dm_story_refs"))) return out;
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    // (a deleted reply's D-12 stub - story_id '' - is no reference)
    for (const r of await getQuery(`SELECT * FROM dm_story_refs WHERE message_id IN (${qs(part.length)}) AND story_id != ''`, part)) out.set(Number(r.message_id), r);
  }
  return out;
}
/**
 * The sender deleted a story reply (messages.deleteMessage): its reference goes - unless the message was reported (the
 * admin's context). A reply that OPENED a conversation with someone on cam / on stage leaves a stub instead (story_id '',
 * no names, no pad - nothing about the story) so the D-12 cap still counts it: deleting replies never gives the day's
 * cold conversations back. Stubs are swept a day later.
 */
async function dropRef(messageId) {
  const mid = parseInt(messageId, 10);
  if (!(mid > 0) || !(await hasTable("dm_story_refs"))) return;
  const kept = "NOT EXISTS (SELECT 1 FROM dm_reports r WHERE r.message_id = ?)";
  await runQuery(`UPDATE dm_story_refs SET story_id = '', author_id = NULL, author_name = NULL, room_id = NULL, room_title = NULL, story_kind = NULL,
                  story_source = NULL, story_created = NULL, quick = 0
                  WHERE message_id = ? AND opened = 1 AND role IN ('subject', 'streamer') AND ${kept}`, [mid, mid]);
  await runQuery(`DELETE FROM dm_story_refs WHERE message_id = ? AND story_id != '' AND ${kept}`, [mid, mid]);
}
/**
 * Each reader's card for these references (Map message id -> card), built NOW for THIS viewer (an account row: userId +
 * class): {gone: true} when the story isn't visible to them for ANY reason (nothing else in it), else
 * {gone: false, mine, role, kind, source, quick, name, pad: {title} | null, thumb, nsfw, left}. Never a media id or URL.
 */
async function cardsFor(viewer, refs, ctx = mkCtx()) {
  const out = new Map();
  const list = (refs || []).filter(Boolean);
  if (!list.length) return out;
  const ids = [...new Set(list.map((r) => String(r.story_id)))];
  const rows = [];
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    rows.push(...(await getQuery(`SELECT * FROM media WHERE id IN (${qs(part.length)})`, part)));
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  await prepare(ctx, rows);
  const items = new Map((await stories().clean(rows.filter((r) => live(r, ctx.t)))).map((it) => [it.id, it]));
  const gone = () => ({ gone: true });
  for (const ref of list) {
    const row = byId.get(String(ref.story_id));
    const item = row ? items.get(row.id) : null;
    if (!row || !item || !ref.author_id || !viewer || !viewer.userId || !(await visibleTo(viewer, row, ctx))) { out.set(Number(ref.message_id), gone()); continue; }
    const a = await authorOf(row, ctx, item);
    const name = ref.role === "uploader" ? item.by || null
      : ref.role === "subject" ? item.subject || null
      : ref.role === "streamer" ? (a.userId && a.role === "streamer" ? a.name : null) || item.subject || null : null;
    const R = row.room ? rooms.getCached(row.room) : null;
    const pad = row.room && !rooms.isProfile(row.room) ? { title: R ? R.title || String(row.room) : String(row.room) } : null;
    const pic = item.kind === "photo" || M().hasPoster(row);
    out.set(Number(ref.message_id), { gone: false, mine: String(viewer.userId) === String(ref.sender_id), role: ref.role || null, kind: item.kind, source: item.source,
                                      quick: !!Number(ref.quick), name, pad, thumb: pic ? `/messages/story/${Number(ref.message_id)}/thumb` : null,
                                      nsfw: !!item.nsfw, left: Math.max(0, endOf(row) - ctx.t) });
  }
  return out;
}
/** A message's reference + its story row when `userId` is a CURRENT member who may see that message (the DM picture rule:
 *  not left, after their clear-history point, not deleted). null otherwise. */
async function memberRef(userId, messageId) {
  const mid = parseInt(messageId, 10);
  if (!userId || !(mid > 0) || !(await hasTable("dm_story_refs"))) return null;
  const ok = (await getQuery(`SELECT m.id FROM messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
                              WHERE m.id = ? AND m.deleted_at IS NULL AND cm.user_id = ? AND cm.left_at IS NULL AND m.id > cm.cleared_id`,
                             [mid, String(userId)]).catch(() => []))[0];
  if (!ok) return null;
  const ref = (await getQuery("SELECT * FROM dm_story_refs WHERE message_id = ?", [mid]))[0];
  return ref && ref.author_id ? ref : null;
}
/** "Open the story" from a DM card: {room, item} when the reader may see it now, else null. */
async function openFromMessage(viewer, messageId) {
  if (!viewer || !viewer.userId) return null;
  const ref = await memberRef(viewer.userId, messageId);
  if (!ref) return null;
  const s = await storyFor(viewer, ref.story_id);
  return s ? { room: s.row.room, item: s.row.id } : null;
}
/** The card's picture for a reader: {file, ct} (a photo, or a clip's / audio's poster) or null. */
async function thumbFor(viewer, messageId) {
  if (!viewer || !viewer.userId) return null;
  const ref = await memberRef(viewer.userId, messageId);
  if (!ref) return null;
  const s = await storyFor(viewer, ref.story_id);
  if (!s) return null;
  if (s.item.kind === "photo") return { file: path.join(M().DIR, s.row.file), ct: s.row.ct || "image/jpeg" };
  if (M().hasPoster(s.row)) return { file: M().posterFile(s.row.id), ct: "image/webp" };
  return null;
}

// ── retention ──
/** Votes on stories that left more than POLICY.voteKeepMs ago (or are gone) go; deleted replies' D-12 stubs go after a day.
 *  Tips stay; refs go with their message. (The vote / tip gaps and the vote budget are feedstore's in-memory maps, which
 *  prune themselves by size - storyreact keeps none of its own.) */
async function sweep() {
  await init();
  const cut = NOW() - (WINDOW() + POLICY.voteKeepMs);
  const r = await runQuery(`DELETE FROM story_votes WHERE NOT EXISTS (SELECT 1 FROM media m WHERE m.id = story_votes.story_id AND m.deleted = 0 AND m.created > ?)`, [cut]);
  const st = await runQuery("DELETE FROM dm_story_refs WHERE story_id = '' AND created < ?", [NOW() - 86400e3]);
  return { votes: r.changes || 0, stubs: st.changes || 0 };
}

// ── routes ──
function register(app, { addUser, idemBegin, noTimers = false } = {}) {
  init().catch(() => {});
  const guard = require("./middleware/authGuard");
  const api = (write) => (req, res, next) => {
    res.set("Cache-Control", "private, no-store");
    res.set("X-Robots-Tag", "noindex");
    if (!guard.sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (write && !req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    next();
  };
  const fail = (res, e, what = "Something went wrong.") => {
    const st = e && e.refuse && e.status && e.status < 600 ? e.status : 500;
    if (st === 500) console.error("[storyreact]", e);
    res.status(st).json({ ok: false, error: st === 500 ? what : e.message, code: (e && e.code) || undefined });
  };
  const sid = (req) => String(req.params.id || "").slice(0, 40);
  const bad = (res) => res.status(404).json({ ok: false, error: GONE });

  app.post("/api/stories/:id/vote", addUser, api(true), async (req, res) => {
    if (!CID_RE.test(sid(req))) return bad(res);
    try {
      const v = await vote(req.user, sid(req), (req.body || {}).dir);
      res.json({ ok: true, vote: v.vote, counted: v.counted, score: v.score, ups: v.ups, downs: v.downs });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/stories/:id/tip", addUser, api(true), async (req, res) => {
    if (!CID_RE.test(sid(req))) return bad(res);
    const u = req.user;
    if (!u.username) return res.status(401).json({ ok: false, error: "Sign in first." });
    req.body = req.body || {};
    // one key per confirmed attempt, namespaced by sender (one user's key can never replay another user's answer)
    const raw = req.body.idempotency_key || req.get("Idempotency-Key");
    const key = raw ? `${u.username}:${String(raw).slice(0, 64)}` : null;
    req.body.idempotency_key = key ? "storytip:" + key : undefined;
    const idem = idemBegin ? await idemBegin(req, res, "storytip") : { replay: false, done: () => {}, fail: () => {} };
    if (idem.replay) return;
    try {
      const out = await tip({ sender: u, id: sid(req), amount: req.body.amount, note: req.body.note, key });
      idem.done(200, out);
      res.json(out);
    } catch (e) {
      idem.fail();
      fail(res, e, "The tip didn't go through - nothing was sent.");
    }
  });
  app.get("/api/stories/:id/reply", addUser, api(false), async (req, res) => {
    if (!CID_RE.test(sid(req))) return bad(res);
    try { res.json({ ok: true, ...(await replyCheck(req.user, sid(req))) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stories/:id/reply", addUser, api(true), async (req, res) => {
    if (!CID_RE.test(sid(req))) return bad(res);
    try {
      const b = req.body || {};
      const r = await reply(req.user, sid(req), { body: b.body, quick: b.quick }, require("./contentaudit").fromRequest(req));
      res.json({ ok: true, conversation: r.conversation, created: r.created });
    } catch (e) { fail(res, e, "Your reply didn't send - try again."); }
  });
  // "open the story" from a DM card: the reader must still see it (the media id reaches them only now, as /api/stories would)
  app.get("/api/messages/m/:id/story", addUser, api(false), async (req, res) => {
    try {
      const o = /^\d{1,15}$/.test(String(req.params.id || "")) ? await openFromMessage(req.user, req.params.id) : null;
      if (!o) return res.status(404).json({ ok: false, gone: true });
      res.json({ ok: true, room: o.room, item: o.item });
    } catch (e) { fail(res, e); }
  });
  // the card's picture: members of the conversation who may see the story right now - checked on every request
  app.get("/messages/story/:id/thumb", addUser, async (req, res) => {
    const nope = () => { res.set({ "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex", "X-Content-Type-Options": "nosniff" }); res.status(404).end(); };
    try {
      if (!req.user || !req.user.userId || !/^\d{1,15}$/.test(String(req.params.id || ""))) return nope();
      const f = await thumbFor(req.user, req.params.id);
      if (!f || !f.file || !fs.existsSync(f.file)) return nope();
      const H = Object.assign({}, require("./dmmedia").PRIVATE_HEADERS, { "Content-Type": f.ct, "Cross-Origin-Resource-Policy": "same-origin",
                                                                            "X-Robots-Tag": "noindex, noarchive" });
      res.set(H);
      res.sendFile(f.file, { etag: false, lastModified: false, cacheControl: false, headers: H }, (err) => { if (err && !res.headersSent) nope(); });
    } catch (e) {
      console.error("[storyreact] thumb:", e && e.message);
      if (!res.headersSent) nope();
    }
  });
  if (!noTimers) {
    const run = () => sweep().then((r) => { if (r.votes || r.stubs) console.log(`[storyreact] sweep: ${r.votes} old vote(s), ${r.stubs} reply stub(s) dropped`); }).catch((e) => console.error("[storyreact] sweep:", e.message));
    setTimeout(run, 120e3).unref();
    setInterval(run, 6 * 3600e3).unref();
  }
}

module.exports = {
  init, register, POLICY, QUICK, GONE, Refuse, placed, visibleTo, storyFor, hideBlocked, hiddenIds, blockedWith, authorOf, annotate, counts, vote, selfUp, tip,
  replyCheck, reply, insertRef, refsFor, dropRef, cardsFor, openFromMessage, thumbFor, sweep, live, mkCtx, _setClock,
};
