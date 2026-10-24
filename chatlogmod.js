// chatlogmod.js — CL6: takedowns and audit for the pad chat archive (the chat-history spec §2.6 "Takedowns", §3.5 "Line
// actions", §3.10). What can happen to an archived line (chat_log):
//
//   ⚑ reported   POST /api/rooms/:slug/chatlog/:c/report {reason: info|harassment|sexual|minor|copyright, note <= 500, jc?}
//                any signed-in viewer who can see the line (the live tail's signed join cursor counts). To the admin queue
//                (/feed/admin#chatlines) and to the pad's owner - except minor / copyright, which go to the site's admins
//                only. A "minor" report hides the line at once (rm_by report:minor); a reporter whose reports are paused (the
//                feed rule: bad-faith reports) or who is banned from the whole feed still reaches the admins, but hides nothing.
//   removed      POST .../remove                its author: their linked Camfrog login, or their account's own web lines (u:<id>)
//   hidden       POST .../hide {why <= 200}     the pad's owner, site staff, the room's Camfrog mods (kick or more in Pepe's caps)
//   shown again  POST .../unhide                within 30 days: the owner / staff - or the mod who hid it. A self-removal stays;
//                                               a "minor" hide is the admins' call (the queue's Dismiss)
//   purged       POST .../purge {why?}          staff holding chatlog.read_all: text and author wiped at once, everywhere
//
// A hidden or removed line is left out for every viewer (chatlogview.filter); staff see it muted with its text for 30 days (the
// appeal copy), the pad's owner too for a moderator's or staff's hide (CL6 fix-up: never a line its author removed, nor one a
// "minor" report hid - the owner sees "Removed by its author" / "Hidden by PATV staff", no words, no speaker), then the nightly
// pass blanks it (purged = 1) - unless a legal hold covers it or a report on it is still open (CL6 fix-up: the evidence stays
// until the admins decide). It leaves the live feed at once - bridge_feed inside the hide's own transaction (CL6 fix-up: a crash
// after the commit can't bring it back at the next start; bridge.load drops taken-down lines too), R.feed after the commit - and
// open pages drop the node (the `removed` ring on /live). CL6 fix-up: every takedown also reaches the COPIES in that transaction:
// the 🔔 mention notices about the line (inbox ref mention:<room>:<c>: words and name gone) and their Telegram alerts
// (telegram_outbox ref n:mention:<room>:<c>: an unsent one is dropped, a sent one's text blanked); a quote post leaves a
// taken-down line out while it is down (quotes.forPosts - it comes back if the line is shown again).
// A purge reaches every copy, in one transaction: chat_log (text NULL, d.u blanked, the 🎙 id gone - it's a hash of the login and
// the words -, who -> "h:<hash>": the login is replaced by the one-way hash Pepe's removed list needs; the FTS entry by trigger),
// bridge_feed (+ R.feed after the commit), the quotes that copied the line (quotes.dropLines: for good), the 🔊 mic clip posts made
// of a 🎙 line (its transcript is their caption: taken down), the mention notices and alerts, and Pepe's !log / !search (the owner
// sync's `chatlog.removed` [[unix seconds, login hash]] - every taken-down line, newest 500 per room; and `removed_who` for people
// taken down as a whole: removedWho). Not wiped: free pages of the database file and the search index's merged segments until
// SQLite reuses / merges them (the nightly pass asks FTS5 to merge), Pepe's VM log files until his own retention, backups until
// they expire (the privacy page says so).
//
// Staff (chatlog.read_all - privacy-locked, Staff and up; /admin/bridge "Chat takedowns" + /feed/admin "Reported chat lines"):
//   the report queue (the line's text only on "Read", and every read is logged), the per-login tool (look / hide_all /
//   purge_all / export / hold / unhold for a Camfrog login or an account - privacy@ requests from people without an account,
//   minors found, deceased users, legal orders), legal holds per room or per login (they pause the 30-day text removal, CL7's
//   retention purge and staff purges), and "let this owner read before they became the owner" (chatlog_rooms.owner_grant).
//   Every staff read, login-tool action and staff line action is a chatlog_views row (kept 2 years, like DM read audits; kinds
//   history / login_tool / grant / takedown) - with the staff member's own note. The pad's owner reads room_events (the pad
//   settings page), so a room_events row carries only what the owner may know (CL6 fix-up): chat.report for the reasons the owner
//   is told anyway (never minor / copyright), chat.hide / chat.unhide / chat.purge / chat.grant with staff as "PATV staff" and no
//   staff note; legal holds never. Nothing here logs a line's text - not the console, not the audits.
//
// Contracts for the later slices: actsFor(view, viewer) (what the line menu offers), removedFor(roomId) (the owner sync's list),
// isHeld(rk, who) / heldRooms() / heldWho() (CL7's purge skips them), rmNames(items) -> Map(rm_by -> username) for
// chatlogview.dress({rmNames}) (CL8's muted rows say who hid a line). S1 V4: removeAccountLines(userId, {windows}) - account
// deletion's "Also remove my public messages" in this archive (the account's web lines purged - its u:<id> lines and its web lines
// under each Camfrog login while that login was linked to it (review 2: earlier logins too, never another holder's) -, the held
// ones taken down as the author's and kept in chatlog_erase_wait until their holds end: a legal hold, or a report within ADR 0007
// D10's bounds; the nightly pass's eraseWaitPass deletes their words then; review 2: decided inside the writing transaction, and
// an unreachable archive throws so the deletion retries).
"use strict";
const { runQuery, getQuery, tx } = require("./dbUtils");
const SP = require("./siteperms");
const CL = require("./chatlog");

// ── owner decisions (spec §6 decision 12) and limits (§3.11): each one constant ──
const KEEP_RM_MS = 30 * 864e5;            // a hidden / removed line's text stays this long (owner + staff appeal copy), then it's blanked
const UNHIDE_MS = KEEP_RM_MS;             // unhide works inside the same 30 days
const VIEWS_KEEP_MS = 730 * 864e5;        // chatlog_views (staff reads + login-tool actions): 2 years, like DM read audits
const REPORTS_PER_HOUR = 20;              // per account (the feed's bad-faith pause applies on top)
// CL6 fix-up: the rest of the feed's report rules (feedstore DEFAULTS, read live from its config when it's up): a brand-new account
// 5 an hour, 60 a day, 3 s between two reports (one gap shared with the feed's own reports); counted over feed + user + chat reports
const NEW_REPORTS_PER_HOUR = 5, REPORTS_PER_DAY = 60, REPORT_GAP_MS = 3000;
const REPORTS_KEEP_MS = 730 * 864e5;      // a decided chat line report is kept 2 years (the bad-faith pause reads the last 30 days)
const QUEUE_LINES = 300;                  // the report queue lists this many LINES (urgent first, then the newest report)
const QUEUE_PER_LINE = 50;                //   with up to this many reports each
const REMOVED_WHO_MAX = 5000;             // removedWho: people taken down as a whole (owner sync), newest first
const ACT_PER_MIN = 30;                   // hide / unhide / remove / purge per account a minute
const STAFF_ACTOR = "PATV staff";         // how a staff member shows in the pad's room_events and the owner's muted rows
const READ_ALL = "chatlog.read_all";      // staff: full history (audited), purge, the queue and the per-login tool
const MANAGE_ANY = "pads.manage_any";     // site staff who manage any pad may hide lines like its owner
const REASONS = Object.freeze(["info", "harassment", "sexual", "minor", "copyright"]);
const ADMIN_ONLY = Object.freeze(["minor", "copyright"]);   // never to the pad's owner (legal / safety calls are the site's)
const URGENT = Object.freeze(["minor"]);                    // hides at once; every admin is told, every time
const LABELS = Object.freeze({ info: "Personal info / doxxing", harassment: "Harassment", sexual: "Sexual content", minor: "Involves a minor",
                               copyright: "Copyright" });
const NOTE_MAX = 500, WHY_MAX = 200;
const REMOVED_MAX = 500;                  // the owner sync's removed list, per room
const BATCH = 1000;                       // purge_all / the nightly pass: rows per transaction
const EXPORT_MAX = 50000;
// (CL7: the nightly pass is scheduled by chatlogpurge.js - it calls nightly() below first)
const LOGIN_RE = /^[\w.\-]{1,40}$/;
const INDEXABLE_KINDS = ["msg", "tx", "topic"];

const now = () => CL.now();
const lower = (s) => String(s == null ? "" : s).trim().toLowerCase();
const byteLen = (s) => (s == null ? 0 : Buffer.byteLength(String(s), "utf8"));
const yieldNow = () => new Promise((r) => setImmediate(r));
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g;
const clean = (v, n) => Array.from(String(v == null ? "" : v).replace(CTRL, "").replace(/\s+/g, " ").trim()).slice(0, n).join("");
const indexable = (r) => r.text != null && INDEXABLE_KINDS.includes(r.k) && r.rm_at == null && r.purged == null;

class Refuse extends Error {
  constructor(status, message, code, extra) { super(message); this.status = status; this.code = code || null; this.refuse = true; Object.assign(this, extra || {}); }
}
/** The one answer for a line a viewer can't see (another room's, removed, below the floor, nonexistent); the pad's owner, staff
 *  and the room's mods get the reason. CL6 fix-up: never one that tells more than "no such line" - a !bridge hide person's line
 *  (privacy) or another pad's cursor (other_room) is "no_line" to everyone but staff (who hold the per-login tool anyway). */
const SEALED_WHY = new Set(["privacy", "other_room"]);
const notFound = (V, why) => {
  const w = V && V.exempt && why ? (SEALED_WHY.has(why) && V.role !== "staff" ? "no_line" : why) : null;
  return new Refuse(404, "That line isn't available.", "not_found", w ? { why: w } : null);
};

// ── setup + the legal holds (chatlog_holds: "room:<rk>" | "who:<login or u:id>") ──
// whoH: "h:<hash>" of each held key - the lines that person said while incognito, which Pepe sent anonymised (who "h:<hash>": the
// owner's decision-9 change), are theirs too (CL6 fix-up: a hold on a login covers them)
let HOLDS = { rooms: new Set(), who: new Set(), whoH: new Set() };
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await CL.init();
      await loadHolds();
      // CL6 fix-up: the copies a takedown reaches are found by their ref (inbox_ref / telegram_outbox_ref lead with user_id)
      for (const [t, sql] of [["inbox", "CREATE INDEX IF NOT EXISTS inbox_mention_ref ON inbox (ref) WHERE kind = 'mention'"],
                              ["telegram_outbox", "CREATE INDEX IF NOT EXISTS telegram_outbox_mention_ref ON telegram_outbox (ref) WHERE kind = 'mention'"]]) {
        if (await tableThere(t)) await runQuery(sql).catch((e) => console.error("[chatlogmod] index:", e.message));
      }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
/** (CL6 fix-up: the new sets are built first and swapped in - a check never sees them half-loaded) */
async function loadHolds() {
  const next = { rooms: new Set(), who: new Set(), whoH: new Set() };
  for (const r of await getQuery("SELECT key FROM chatlog_holds")) {
    const k = String(r.key || "");
    if (k.startsWith("room:")) next.rooms.add(Number(k.slice(5)));
    else if (k.startsWith("who:")) { const w = lower(k.slice(4)); next.who.add(w); next.whoH.add("h:" + CL.hash(w)); }
  }
  HOLDS = next;
}
const heldRoom = (rk) => HOLDS.rooms.has(Number(rk));
/** A held person's line: their login / u:<id> - or "h:<hash>" of one of them (said while incognito; a purged row has that shape
 *  too, but it has nothing left to keep). */
const heldWhoKey = (who) => { if (!who) return false; const w = lower(who); return HOLDS.who.has(w) || HOLDS.whoH.has(w); };
/** A legal hold covers this line (its room, or who said it - under their login or anonymised): no 30-day text removal, no
 *  retention purge (CL7), no staff purge. */
const isHeld = (rk, who) => heldRoom(rk) || heldWhoKey(who);
const heldRooms = () => new Set(HOLDS.rooms);
const heldWho = () => new Set(HOLDS.who);

const tableThere = async (t) => (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t]).catch(() => [])).length > 0;
async function rkOf(roomId) {
  const r = (await getQuery("SELECT rk FROM chatlog_rooms WHERE room_id = ?", [String(roomId || "")]))[0];
  return r ? Number(r.rk) : null;
}
async function account(user) {
  if (!user || !user.userId) return null;
  const r = (await getQuery("SELECT * FROM users WHERE userId = ?", [String(user.userId)]))[0];
  if (!r) return null;
  return { userId: String(r.userId), username: r.username, class: r.class, camfrogUsername: r.camfrogUsername || null, archived_at: r.archived_at || null };
}
/** An account's chat keys: its account key u:<id> (web lines) and its linked Camfrog login. */
function keysOf(me) {
  const out = ["u:" + lower(me.userId)];
  const l = lower(me.camfrogUsername);
  if (l && LOGIN_RE.test(l)) out.push(l);
  return out;
}
async function audit(userId, { rk = null, who = null, kind, from = null, to = null, why = null } = {}) {
  try {
    await runQuery("INSERT INTO chatlog_views (user_id, rk, who, kind, from_ts, to_ts, why, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                   [String(userId), rk, who ? String(who).slice(0, 200) : null, kind, from == null ? null : Math.floor(from), to == null ? null : Math.floor(to),
                    why ? String(why).slice(0, 200) : null, now()]);
  } catch (e) { console.error("[chatlogmod] audit:", e.message); }
}
async function roomEvent(roomId, what, actor, detail) {
  try { await require("./rooms").event(roomId, what, actor || null, detail); } catch (e) { /* audit is best effort */ }
}
async function notify(userId, n) {
  try { return await require("./inbox").addSafe(userId, n); } catch (e) { return false; }
}
// CL6 fix-up: the member-facing notices (the pad owner's, the reporters') in the recipient's language (locales/*.json chatlog.n.*;
// the admins' stay English, like the feed's)
function langOf(userId) { try { return require("./i18n").getPref(userId) || "en"; } catch (e) { return "en"; } }
function tFor(userId) {
  try { return require("./i18n").tFor(langOf(userId)); } catch (e) {
    let en = {};
    try { en = require("./locales/en.json"); } catch (e2) { en = {}; }
    return (k, v) => String(en[k] || k).replace(/\{!?(\w+)\}/g, (m, x) => (v && v[x] != null ? String(v[x]) : m));
  }
}
/** The reason's words for a member (reason keys chatlog.n.r.<reason>). */
const reasonFor = (t, why) => t("chatlog.n.r." + why);
/** A staff line action, audited with the staff member's own note (the pad's room_events never carry it). */
const staffAudit = (me, row, what, note) => audit(me.userId, { rk: row.rk, kind: "takedown", why: `${what} #${Number(row.c)}${note ? ": " + note : ""}` });
const admins = () => getQuery("SELECT userId FROM users WHERE class = 'Admin'").catch(() => []);
function padOf(roomId) {
  let R = null;
  try { R = require("./rooms").getCached(roomId); } catch (e) { R = null; }
  return { title: (R && R.title) || roomId, slug: R && R.slug ? R.slug : null, ownerId: R && R.owner && R.owner.userId ? String(R.owner.userId) : null };
}
const lineLink = (roomId, c) => { const p = padOf(roomId); return p.slug ? `/p/${encodeURIComponent(p.slug)}?tab=live&line=${Number(c)}` : "/p"; };

// ── the per-account limits (hide / unhide / remove / purge) ──
const HITS = new Map();
/** -> null, or a Refuse 429 (code rate, retry = seconds) once ACT_PER_MIN actions fell in the last minute. */
function limited(userId) {
  const t = Date.now();
  const hits = (HITS.get(userId) || []).filter((x) => t - x < 60e3);
  if (hits.length >= ACT_PER_MIN) {
    const s = Math.max(1, Math.ceil((60e3 - (t - hits[0])) / 1000));
    return new Refuse(429, `Slow down - try again in ${s} s.`, "rate", { retry: s });
  }
  hits.push(t);
  HITS.set(userId, hits);
  if (HITS.size > 5000) HITS.clear();
  return null;
}

// ── who may do what on a pad's chat ──
/** What the line menu offers this viewer on this pad (the live view's history.acts): null = nothing (signed out, or the archive is
 *  off - takedowns act on archived lines only). report: any signed-in viewer; hide: the owner, the room's mods, site staff;
 *  purge: staff holding chatlog.read_all. */
function actsFor(V, viewer) {
  if (!viewer || !viewer.userId || !V || !CL.on("archive")) return null;
  const staff = V.role === "staff";
  const hide = staff || V.role === "owner" || V.role === "mod" || SP.can(viewer, MANAGE_ANY);
  return { report: 1, hide: hide ? 1 : 0, purge: staff ? 1 : 0 };
}
const mayHide = (V, me) => V.role === "owner" || V.role === "staff" || V.role === "mod" || SP.can(me, MANAGE_ANY);
const mustHide = (V, me) => { if (!mayHide(V, me)) throw new Refuse(403, "Only this pad's owner, its room's mods and PATV staff can hide or show lines.", "forbidden"); };

/** CL6 fix-up: may this viewer act on this line at all? Beyond the live tail only with scrollback - V.can.history (signed in, not
 *  blocked here or banned from the pad's feed, 18+ confirmed on an 18+ pad, the bridge perk) and the chatlog.history switch on.
 *  Without it: a line the live tail holds now (R.feed) - or, opts.range (a line already taken down: it left R.feed), one inside
 *  the live tail's span. Never an answer about an archived line the viewer can't read (200 vs 404 would say it exists). */
function reachable(V, roomId, c, { range = false } = {}) {
  if (V && V.can && V.can.history && CL.on("history")) return true;
  let feed = [];
  try { const B = require("./bridge")._rooms.get(String(roomId)); feed = B && Array.isArray(B.feed) ? B.feed : []; } catch (e) { feed = []; }
  if (feed.some((it) => it && Number(it.c) === Number(c))) return true;
  return !!range && feed.length > 0 && Number(c) >= Number(feed[0].c);
}
/** The pad, the actor's view of it and the line (it must be this room's). opts.see: the actor must see the line now (the jc grace
 *  counts) - else one not_found. opts.reach (default = see): the line must be reachable() for this viewer. -> {me, R, V, row, item} */
async function lineCtx(user, slug, c, { jc = null, see = true, must = null, reach = see, range = false } = {}) {
  const me = await account(user);
  if (!me) throw new Refuse(401, "Sign in first.", "signin");
  if (me.archived_at) throw new Refuse(403, "This account is archived.", "archived");
  await init();
  const R = await require("./roomsweb").resolveRoom(String(slug || "")).catch(() => null);
  if (!R || !R.id) throw notFound(null);
  const CV = require("./chatlogview");
  const PA = require("./padaccess");
  await PA.init();
  const V = await CV.view(R.id, me);
  if (!PA.full(me, R.id)) throw notFound(V, "access");
  let gated = false;
  try { gated = !require("./premium").bridgeAllowed(R.id); } catch (e) { gated = false; }
  if (gated && V.role !== "owner" && V.role !== "staff") throw notFound(V, "bridge");
  if (must) must(V, me);                    // a permission refusal comes BEFORE the line is looked up (never an existence oracle)
  const n = Math.floor(Number(c));
  if (!(n > 0) || n > 1e15) throw notFound(V, "no_line");
  const row = (await getQuery("SELECT l.*, r.room_id FROM chat_log l JOIN chatlog_rooms r ON r.rk = l.rk WHERE l.c = ?", [n]))[0];
  if (!row) throw notFound(V, "no_line");
  if (row.room_id !== R.id) throw notFound(V, "other_room");
  if (reach && !reachable(V, R.id, n, { range })) throw notFound(V, "floor");
  const item = CV.itemOf(row);
  if (see) {
    const w = hiddenWhy(V, R.id, row, jc, { reach: false });
    if (w) throw notFound(V, w);
  }
  return { me, R, V, row, item };
}
/** Why this viewer can't see the row (null = they can): out of reach (reachable), below their floors / outside its access level
 *  (floor), a person the hidden set leaves out (privacy), taken down (removed). opts.cleared: as if it weren't taken down (hide /
 *  unhide ask about the line itself); opts.range: reachable()'s. The jc grace counts (CL3 fix-up: bound to the viewer). */
function hiddenWhy(V, roomId, row, jc, { cleared = false, range = false, reach = true } = {}) {
  if (reach && !reachable(V, roomId, row.c, { range })) return "floor";
  const CV = require("./chatlogview");
  const J = jc ? CV.checkJc(String(jc).slice(0, 80), roomId, V.now, V.viewer) : { ok: false };
  const r0 = cleared ? Object.assign({}, row, { rm_at: null, rm_by: null, rm_why: null, purged: null }) : row;
  const f = CV.filter([CV.itemOf(r0)], { view: V, jc: J.ok ? J.c : null, now: V.now });
  if (f.items.length) return null;
  return f.left.privacy ? "privacy" : f.left.removed ? "removed" : "floor";
}
/** Is `me` the line's author (their linked login, or their account's u:<id>)? The owner's decision-9 change: also a line they said
 *  while incognito that Pepe sent anonymised (who "h:<hash>" of one of their keys) - never a purged one (no author left). */
function isAuthor(me, row) {
  const w = lower(row.who);
  if (!w) return false;
  if (w.startsWith("h:")) return !row.purged && keysOf(me).some((k) => "h:" + CL.hash(k) === w);
  return keysOf(me).includes(w);
}

// ── the writes ──
/** Which tables hold copies of a line (asked BEFORE a transaction: sqlite_master reads never run inside one here). */
async function copyTables() {
  const [feed, inbox, tg, quotes, voices, posts, media] = await Promise.all(["bridge_feed", "inbox", "telegram_outbox", "feed_quotes", "feed_voices",
                                                                            "feed_posts", "media"].map(tableThere));
  return { feed, inbox, tg, quotes, voices: voices && posts, media };
}
const MENTION_GONE = "💬 A chat line that mentioned you was removed";
/**
 * Inside the takedown's transaction (CL6 fix-up): the live copy and the copies people were sent go WITH it - bridge_feed (a crash
 * after the commit can't bring the line back at the next start), the 🔔 mention notices about it (no words, no name) and their
 * Telegram alerts (telegram.onNotice: ref "n:mention:<room>:<c>" - an unsent one is dropped, a sent one keeps no text).
 */
async function copiesInTx(roomId, cs, have, t) {
  for (let i = 0; i < cs.length; i += 400) {
    const part = cs.slice(i, i + 400), q = part.map(() => "?").join(",");
    if (have.feed) await runQuery(`DELETE FROM bridge_feed WHERE c IN (${q})`, part);
    const refs = part.map((c) => `mention:${roomId}:${c}`);
    if (have.inbox) await runQuery(`UPDATE inbox SET title = ?, body = NULL WHERE kind = 'mention' AND ref IN (${q})`, [MENTION_GONE, ...refs]);
    if (have.tg) {
      await runQuery(`UPDATE telegram_outbox SET text = '', error = CASE WHEN sent_at IS NULL THEN 'its chat line was removed' ELSE error END,
                      sent_at = COALESCE(sent_at, ?) WHERE kind = 'mention' AND ref IN (${q})`, [t, ...refs.map((r) => "n:" + r)]);
    }
  }
}
/** Inside a transaction: hide / remove one row (left out for everyone; the FTS entry goes by trigger) and its copies (copiesInTx;
 *  `have` = copyTables()). -> changed? */
async function setRm(row, by, why, t, have) {
  const r = await runQuery("UPDATE chat_log SET rm_at = ?, rm_by = ?, rm_why = ? WHERE c = ? AND rm_at IS NULL AND purged IS NULL", [t, by, why || null, row.c]);
  const n = (r && r.changes) || 0;
  if (n && indexable(row)) await runQuery("UPDATE chatlog_rooms SET idx_rows = MAX(0, idx_rows - 1) WHERE rk = ?", [row.rk]);
  if (n && have) await copiesInTx(row.room_id, [Number(row.c)], have, t);
  return n > 0;
}
/** The live copy goes too (R.feed, open pages drop it; bridge_feed unless db = false: the takedown's transaction did it). Never
 *  throws. */
async function liveDrop(roomId, cs, db = true) {
  try { await require("./bridge").takeDown(roomId, cs, { db }); } catch (e) { console.error("[chatlogmod] live drop:", e.message); }
  // CL8 fix-up: the room's privacy digest moves - open scrollback / offline 📜 cards re-check the lines they hold (an archived line
  // is past the live `removed` ring's reach, and an offline card has no live poll at all)
  try { require("./chatlogview").noteGone(roomId); } catch (e) { /* the next page load shows it */ }
}
/** An un-hidden line goes back into the live feed when it's still inside its last 200 items. Never throws. */
async function liveRestore(roomId, row) {
  try {
    const it = require("./chatlogview").itemOf(Object.assign({}, row, { rm_at: null, rm_by: null, rm_why: null, purged: null }));
    await require("./bridge").restoreLine(roomId, it);
  } catch (e) { console.error("[chatlogmod] live restore:", e.message); }
  try { require("./chatlogview").noteGone(roomId); } catch (e) { /* CL8 fix-up: the owner's / staff's muted row turns back */ }
}

/**
 * Purge rows (staff, the per-login tool, the nightly 30-day pass): text NULL, d.u blanked, who -> "h:<hash>" (the login is gone,
 * Pepe's removed list keeps matching), purged = 1, rm_at kept or set now. ONE transaction: chat_log, the room counters,
 * bridge_feed, the quotes that copied the lines, the 🔔 mention notices about them. Then the live feed (memory).
 * rows: chat_log rows (+ room_id). -> {purged, rooms: Map(roomId -> [c])}
 */
async function purgeRows(rows, by, why, t = now()) {
  const todo = (rows || []).filter((r) => r && r.purged == null);
  const out = { purged: 0, rooms: new Map(), clips: 0 };
  if (!todo.length) return out;
  const have = await copyTables();
  await tx(() => purgeInTx(todo, by, why, t, have, out));
  for (const [roomId, cs] of out.rooms) await liveDrop(roomId, cs, false);
  return out;
}
/** purgeRows' writes, inside the caller's transaction (S1 V4 review 2: removeAccountLines / eraseWaitPass decide and purge in ONE
 *  transaction). `have` = copyTables(), asked before it. Adds to out {purged, rooms, clips}; the caller drops the live copies
 *  (liveDrop(roomId, cs, false) per out.rooms) after the commit. */
async function purgeInTx(todo, by, why, t, have, out) {
  const per = new Map();                  // rk -> {roomId, cs, idx, bytes, lines, mics}
  for (const r of todo) {
    let d;
    try { d = JSON.parse(r.d); } catch (e) { d = {}; }
    if (!d || typeof d !== "object") d = {};
    if (d.u) d.u = {};
    const nd = JSON.stringify(d);
    const who = r.who && !String(r.who).startsWith("h:") ? "h:" + CL.hash(r.who) : r.who || null;
    // (CL6 fix-up: the 🎙 id goes too - it is a hash of the login and the words, testable against a guess)
    const u = await runQuery(`UPDATE chat_log SET text = NULL, d = ?, who = ?, tx = NULL, purged = 1, rm_at = COALESCE(rm_at, ?), rm_by = COALESCE(rm_by, ?),
                              rm_why = COALESCE(rm_why, ?) WHERE c = ? AND purged IS NULL`, [nd, who, t, by, why || null, r.c]);
    if (!u || !u.changes) continue;
    let a = per.get(r.rk);
    if (!a) { a = { roomId: r.room_id, cs: [], idx: 0, bytes: 0, lines: [], mics: [] }; per.set(r.rk, a); }
    a.cs.push(Number(r.c));
    if (indexable(r)) a.idx++;
    a.bytes += byteLen(r.text) + byteLen(r.tx) + Math.max(0, byteLen(r.d) - byteLen(nd)) + Math.max(0, byteLen(r.who) - byteLen(who));
    if (r.text != null && (r.k === "msg" || r.k === "tx")) a.lines.push({ c: Number(r.c), ts: Number(r.ts), login: r.who, text: r.text });
    if (r.text != null && r.k === "tx" && r.who && !String(r.who).startsWith("h:")) a.mics.push({ ts: Number(r.ts), login: lower(r.who), text: r.text });
    out.purged++;
  }
  for (const [rk, a] of per) {
    await runQuery("UPDATE chatlog_rooms SET idx_rows = MAX(0, idx_rows - ?), bytes = MAX(0, bytes - ?) WHERE rk = ?", [a.idx, a.bytes, rk]);
    // bridge_feed, the 🔔 mention notices that quoted the line (mentions.js ref mention:<room>:<c>: no text, no name left) and
    // their Telegram alerts
    await copiesInTx(a.roomId, a.cs, have, t);
    if (have.quotes && a.lines.length) await require("./quotes").dropLines(a.roomId, a.lines, t);
    if (have.voices && a.mics.length) out.clips += await dropClipPosts(a.roomId, a.mics, t, have);
    out.rooms.set(a.roomId, (out.rooms.get(a.roomId) || []).concat(a.cs));
  }
  return out;
}

// S1 V4 fix-up (ADR 0007 D10 / OQ-21; CHAT-ARCHITECTURE §9.4 "Report holds"; the hub's rooms._report_hold_until): a report holds
// a line that "Also remove my public messages" met until 30 days after the report's decision - or 90 days after it was filed while
// nobody has decided it (a decision after those 90 days doesn't bring the hold back; the report itself stays open)
const REPORT_HOLD_DECIDED_MS = 30 * 864e5;
const REPORT_HOLD_UNDECIDED_MS = 90 * 864e5;
/** When a chatlog_reports row stops holding its line's words (ms). */
function reportHoldUntil(r) {
  const filed = Number(r.created) || 0;
  const decided = r.state !== "open" && r.decided_at != null ? Number(r.decided_at) : null;
  return decided != null && decided <= filed + REPORT_HOLD_UNDECIDED_MS ? decided + REPORT_HOLD_DECIDED_MS : filed + REPORT_HOLD_UNDECIDED_MS;
}
/** The reports of these lines -> Map(c -> [{state, created, decided_at}]). */
async function reportsOf(cs) {
  const out = new Map();
  if (!cs.length) return out;
  for (const r of await getQuery(`SELECT c, state, created, decided_at FROM chatlog_reports WHERE c IN (${cs.map(() => "?").join(",")})`, cs)) {
    const c = Number(r.c);
    if (!out.has(c)) out.set(c, []);
    out.get(c).push(r);
  }
  return out;
}
/** Does a report (filed by `upto`, when given) still hold the line at time t? */
const reportHeld = (list, t, upto = null) => (list || []).some((r) => (upto == null || Number(r.created) <= upto) && reportHoldUntil(r) > t);

/**
 * S1 V4 (ADR 0007 OQ-20; CHAT-ARCHITECTURE §9.4): account deletion's "Also remove my public messages" (accountdelete.js, after
 * the deletion committed). The account's own web lines are purged now (as the author: text, name and every copy, at once): its
 * key "u:<id>" and the lines it said while incognito, archived as "h:<hash of that key>"; and - review fix - the lines it sent
 * from the website under a Camfrog login linked to it (the bridge archives a linked member's web line under the login, d.u.web).
 * Review 2: `windows` [{login, from, to}] (ms, from exclusive, to inclusive) are the spans each login was the account's - its
 * login at the deletion up to the deletion, and the logins it had linked EARLIER, each up to when it let it go (unlink, relink,
 * another account's !verify): accountdelete.loginWindowsOf, from the login history. A web line under a login belongs to whoever
 * held the login when it was sent, so another account's web lines under the same login - before or after the member held it -
 * stay. (`login` + `upto`: a row from before review 2 - that login, up to `upto`.) A window without its end is left out: never
 * "up to now", the login may be someone else's by then.
 * Not reached: those logins' Camfrog lines (the login's, not the account's - "Also hide my past public chat lines" leaves them
 * out), a linked member's lines said while incognito ("h:<hash of the login>": the bridge keeps no web mark on an anonymised line,
 * so they can't be told from the login's Camfrog lines; they name nobody), and a login the history has no record of the account
 * holding (unlinked before PATV kept one: 12 October 2026).
 * The hub's exceptions: a line a legal hold covers (isHeld: its room or its speaker) or a report holds (ADR 0007 D10's bounds:
 * until 30 days after its decision, 90 days while undecided - reportHoldUntil; v1 has no bounty evidence on chat lines) is taken
 * down now instead (rm_by "self", as Remove my line: out of every view, its copies with it) - review fix: also when it was down
 * already (a moderator's or staff hide, a "minor" report's), so neither an un-hide nor a dismissed report can bring it back - and
 * waits in chatlog_erase_wait until the nightly pass (eraseWaitPass) deletes its words, once no hold and no report filed before
 * now holds it. Review 2: each batch is read, decided and written in ONE transaction - the holds reloaded, the rows and their
 * reports read inside it - so a moderator's hide / un-hide, a new legal hold or a new report can't land between the decision and
 * the write (they wait for it, and see its result).
 * Review 2: the archive must be reachable - a CHATLOG_DB that didn't open (chatlog.archiveError) or missing archive tables THROW
 * (code archive_db): the deletion's public_done_at stays NULL and its tick tries again once the archive is back (never "nothing
 * to remove", which would record it done and forget the logins).
 * Pepe's !log / !search skip every line of the account key up to now (removed_who, as "Delete every line"; the logins' own lines
 * aren't the account's to hide from him - each purged one is in his per-line removed list). Logs counts only.
 * -> {purged, held, reported}
 */
const ERASE_BATCH = 200;                  // removeAccountLines / eraseWaitPass: lines decided and written per transaction (kept short)
const WINDOWS_MAX = 64;                   // login spans one deletion reaches (a login history is a handful of rows)
/** [{login, from, to}] (or the pre-review-2 {login, upto}) -> the valid spans: a Camfrog login, an end after the start. */
function loginWindows(windows, login, upto) {
  const src = Array.isArray(windows) ? windows : login ? [{ login, from: 0, to: upto }] : [];
  const out = [];
  for (const w of src.slice(0, WINDOWS_MAX)) {
    const l = lower(w && w.login);
    const a = Math.max(0, Math.floor(Number(w && w.from) || 0)), b = Math.floor(Number(w && w.to));
    if (!l || !LOGIN_RE.test(l) || !(b > a)) continue;
    out.push({ login: l, from: a, to: b });
  }
  return out;
}
const archiveDown = (why) => Object.assign(new Error(why), { code: "archive_db" });
async function removeAccountLines(userId, { t = now(), login = null, upto = null, windows = null } = {}) {
  await init();
  if (CL.archiveError()) throw archiveDown("the pad chat archive can't be reached (CHATLOG_DB) - the removal waits for it");
  // (pragma_table_info searches every schema: chat_log may live in the ATTACHed chatlog.db - decision 25 - which sqlite_master
  //  of main doesn't list)
  const there = async (t) => (await getQuery("SELECT 1 FROM pragma_table_info(?) LIMIT 1", [t]).catch(() => [])).length > 0;
  if (!(await there("chat_log")) || !(await there("chatlog_rooms"))) throw archiveDown("the pad chat archive's tables are missing - the removal waits for them");
  const out = { purged: 0, held: 0, reported: 0 };
  const key = "u:" + lower(userId);
  const keys = [key, "h:" + CL.hash(key)];
  const wins = loginWindows(windows, login, upto);
  const logins = [...new Set(wins.map((w) => w.login))];
  // the account key's lines, any time; each login's web lines inside its span (one IN over chat_log_who, like the per-login tool)
  const where = wins.length
    ? `l.who IN (${[...keys, ...logins].map(() => "?").join(", ")}) AND (l.who IN (?, ?) OR (json_extract(l.d, '$.u.web') = 1 AND (${
        wins.map(() => "(l.who = ? AND l.ts > ? AND l.ts <= ?)").join(" OR ")})))`
    : "l.who IN (?, ?)";
  const params = wins.length ? [...keys, ...logins, ...keys, ...wins.flatMap((w) => [w.login, w.from, w.to])] : keys;
  const reports = await there("chatlog_reports");
  const have = await copyTables();
  let last = 0;
  for (;;) {
    const down = new Map();                                    // roomId -> [c] taken down now
    const gone = { purged: 0, rooms: new Map(), clips: 0 };
    let n = 0;
    await tx(async () => {
      await loadHolds();                                       // the holds as committed now (a hold's write waits for this one)
      const rows = await getQuery(`SELECT l.*, r.room_id FROM chat_log l JOIN chatlog_rooms r ON r.rk = l.rk WHERE ${where} AND l.purged IS NULL AND l.c > ?
                                   ORDER BY l.c LIMIT ?`, [...params, last, ERASE_BATCH]);
      n = rows.length;
      if (!n) return;
      last = Number(rows[n - 1].c);
      const reps = reports ? await reportsOf(rows.map((r) => Number(r.c))) : new Map();
      const go = [];
      for (const r of rows) {
        if (isHeld(r.rk, r.who)) out.held++;
        else if (reportHeld(reps.get(Number(r.c)), t)) out.reported++;
        else { go.push(r); continue; }
        if (r.rm_at == null) {
          if (await setRm(r, "self", null, t, have)) { if (!down.has(r.room_id)) down.set(r.room_id, []); down.get(r.room_id).push(Number(r.c)); }
        } else if (r.rm_by !== "self") {
          // already down (a moderator's / staff hide, a "minor" report's): the author's removal now - unhide refuses a "self"
          // line and reportDecide lifts only "report:minor", so the member's choice can't be undone (its copies went with the
          // first takedown)
          await runQuery("UPDATE chat_log SET rm_by = 'self', rm_why = NULL WHERE c = ? AND rm_at IS NOT NULL AND purged IS NULL", [r.c]);
        }
        await runQuery("INSERT INTO chatlog_erase_wait (c, at) VALUES (?, ?) ON CONFLICT(c) DO NOTHING", [r.c, t]);
      }
      await purgeInTx(go, "self", null, t, have, gone);
    });
    if (!n) break;
    out.purged += gone.purged;
    for (const [roomId, list] of down) await liveDrop(roomId, list, false);
    for (const [roomId, cs] of gone.rooms) await liveDrop(roomId, cs, false);
    if (n < ERASE_BATCH) break;
    await yieldNow();
  }
  if (out.purged || out.held || out.reported) {
    await noteRmWho([key], t);
    console.log(`[chatlogmod] account deletion: ${out.purged} web line(s) removed, ${out.held} under a legal hold and ${out.reported} held by a report taken down until they end`);
  }
  return out;
}

/**
 * S1 V4 fix-up: the nightly pass's part for the lines "Also remove my public messages" met under a hold (chatlog_erase_wait):
 * their words are deleted (purged, still as their author) once no legal hold covers them and no report filed before the removal
 * holds them (reportHoldUntil - a report nobody decided stops holding 90 days after it was filed: it stays open, its line's words
 * gone). A line already purged (staff, the retention purge) or gone just leaves the list. Review 2: decided and written in one
 * transaction per batch (the holds reloaded, the rows and reports read inside it), like removeAccountLines. -> {purged, waiting}
 */
async function eraseWaitPass(t = now()) {
  const out = { purged: 0, waiting: 0 };
  const have = await copyTables();
  let last = 0;
  for (;;) {
    const gone = { purged: 0, rooms: new Map(), clips: 0 };
    let n = 0;
    await tx(async () => {
      await loadHolds();
      const ws = await getQuery("SELECT c, at FROM chatlog_erase_wait WHERE c > ? ORDER BY c LIMIT ?", [last, ERASE_BATCH]);
      n = ws.length;
      if (!n) return;
      last = Number(ws[n - 1].c);
      const cs = ws.map((w) => Number(w.c)), q = cs.map(() => "?").join(",");
      const lines = new Map((await getQuery(`SELECT l.*, r.room_id FROM chat_log l JOIN chatlog_rooms r ON r.rk = l.rk WHERE l.c IN (${q})`, cs))
        .map((r) => [Number(r.c), r]));
      const reps = await reportsOf(cs);
      const go = [], done = [];
      for (const w of ws) {
        const c = Number(w.c), r = lines.get(c);
        if (!r || r.purged) { done.push(c); continue; }
        if (isHeld(r.rk, r.who) || reportHeld(reps.get(c), t, Number(w.at))) { out.waiting++; continue; }
        go.push(r);
        done.push(c);
      }
      await purgeInTx(go, "self", null, t, have, gone);
      if (done.length) await runQuery(`DELETE FROM chatlog_erase_wait WHERE c IN (${done.map(() => "?").join(",")})`, done);
    });
    if (!n) break;
    out.purged += gone.purged;
    for (const [roomId, cs] of gone.rooms) await liveDrop(roomId, cs, false);
    if (n < ERASE_BATCH) break;
    await yieldNow();
  }
  return out;
}
const CLIP_AFTER_MS = 24 * 3600e3;          // a 🔊 clip of a 🎙 line is posted within this long after it (Pepe keeps mic-ups 15 min)
const CLIP_MATCH = 30;                      // the transcript's first characters a clip post's caption must hold
/**
 * Inside the purge's transaction (CL6 fix-up): 🔊 mic clip posts (micclip.js) made of a purged 🎙 line - their caption IS its
 * transcript (title "🎙 <speaker>: “<words>”", body the rest) - come down with it (the post: deleted, its title and body blanked;
 * feed_voices: removed; the audio capture: deleted). A clip post holds no line cursor, so it is found by its pad, its speaker
 * (feed_voices.logins), its time (from the line to CLIP_AFTER_MS later) and the transcript's first CLIP_MATCH characters in its
 * caption. -> posts taken down
 */
async function dropClipPosts(roomId, mics, t, have) {
  let n = 0;
  for (const m of mics) {
    const words = String(m.text || "").replace(/\s+/g, " ").trim();
    const head = Array.from(words).slice(0, CLIP_MATCH).join("");
    if (Array.from(head).length < 8) continue;                    // too short to tell one clip from another
    const rows = await getQuery(`SELECT v.post_id, v.media_id FROM feed_voices v JOIN feed_posts p ON p.id = v.post_id
                                 WHERE v.room_id = ? AND v.created >= ? AND v.created <= ? AND (' ' || trim(v.logins) || ' ') LIKE ? ESCAPE '\\'
                                 AND (instr(COALESCE(p.title, ''), ?) > 0 OR instr(COALESCE(p.body, ''), ?) > 0)`,
                                [String(roomId), m.ts - 60e3, m.ts + CLIP_AFTER_MS, "% " + m.login.replace(/[\\%_]/g, (x) => "\\" + x) + " %", head, head]);
    for (const r of rows) {
      const p = await runQuery(`UPDATE feed_posts SET deleted_at = COALESCE(deleted_at, ?), deleted_by = COALESCE(deleted_by, 'system'),
                                delete_reason = COALESCE(delete_reason, 'its mic line was removed'), title = '', body = '' WHERE id = ?`, [t, r.post_id]);
      await runQuery("UPDATE feed_voices SET removed_at = COALESCE(removed_at, ?), removed_by = COALESCE(removed_by, 'system') WHERE post_id = ?", [t, r.post_id]);
      if (r.media_id && have && have.media) await runQuery("UPDATE media SET deleted = 1 WHERE id = ?", [r.media_id]);
      if (p && p.changes) n++;
    }
  }
  if (n) console.log(`[chatlogmod] ${n} mic clip post(s) in ${roomId} came down with a purged 🎙 line`);
  return n;
}

// ── the line actions ──
/** The feed's reporting rules (feedstore.reportGate), for chat lines too (CL6 fix-up: all of them): 3 s between two reports (the
 *  gap the feed's own reports share), 20 an hour - a brand-new account 5 (an urgent report always gets 1) -, 60 a day, counted over
 *  feed + user + chat line reports; paused after bad-faith reports (dismissed as bad faith in 30 days >= false_reports_pause) or
 *  banned / blocked (the whole feed, THIS pad's feed, or a whole-bridge block here: V.blocked) -> only an urgent report goes
 *  through, and it hides nothing. -> {trusted} */
async function reportGate(me, reason, V) {
  let S = null;
  try { S = require("./feedstore"); } catch (e) { S = null; }
  const g = S && S.burst ? S.burst("report|" + me.userId, REPORT_GAP_MS) : 0;
  if (g) throw new Refuse(429, `Slow down - try again in ${g} s.`, "rate", { retry: g });
  if (SP.can(me, "feed.limits_exempt")) return { trusted: true };
  const t = now(), urgent = URGENT.includes(reason);
  let C = {};
  try { C = (S && S.config()) || {}; } catch (e) { C = {}; }
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  const TABLES = [["feed_reports", "reporter_id", "action = 'false'", "created"], ["user_reports", "reporter_id", "action = 'false'", "created"],
                  ["chatlog_reports", "reporter", "state = 'false'", "COALESCE(decided_at, created)"]];
  const have = [];
  for (const x of TABLES) if (await tableThere(x[0])) have.push(x);
  const count = async (since, bad) => {
    let n = 0;
    for (const [table, col, cond, at] of have) {
      n += Number((await getQuery(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ? AND ${bad ? cond + " AND " + at : "created"} > ?`, [me.userId, since]))[0].n) || 0;
    }
    return n;
  };
  const paused = (await count(t - 30 * 864e5, true)) >= num(C.false_reports_pause, 3);
  const banned = !!(V && V.blocked) || ((await tableThere("feed_bans")) &&
    (await getQuery("SELECT 1 FROM feed_bans WHERE user_id = ? AND room_id = '' AND (until IS NULL OR until > ?) LIMIT 1", [me.userId, Date.now()])).length > 0);
  if ((paused || banned) && !urgent) {
    throw new Refuse(403, paused ? "Your reports are paused for a while - several recent ones were found to be made in bad faith." : "You can't report right now.", "paused");
  }
  let fresh = false;
  try { fresh = !!(S && S.isNewAccount(await S.account(me.userId))); } catch (e) { fresh = true; }      // (unknown: the stricter rule)
  const perHour = Math.max(urgent ? 1 : 0, fresh ? num(C.new_account_reports_per_hour, NEW_REPORTS_PER_HOUR) : num(C.reports_per_hour, REPORTS_PER_HOUR));
  if ((await count(t - 3600e3)) >= perHour) throw new Refuse(429, "You've sent a lot of reports this hour - try again later.", "rate");
  if ((await count(t - 864e5)) >= num(C.reports_per_day, REPORTS_PER_DAY)) throw new Refuse(429, "You've hit today's report limit.", "rate_day");
  return { trusted: !(paused || banned) };
}

/** ⚑ Report a line. -> {ok, already?, urgent?, hidden?, admins_only} */
async function report(user, slug, c, { reason, note, jc } = {}) {
  const why = REASONS.includes(reason) ? reason : null;
  if (!why) throw new Refuse(400, "Pick a reason.", "bad_reason");
  const { me, R, V, row } = await lineCtx(user, slug, c, { jc });
  if (isAuthor(me, row)) throw new Refuse(400, "That's your own line - you can remove it instead.", "own");
  // (one open report per reporter and line: asked before the limits, so a repeat never spends them)
  if ((await getQuery("SELECT 1 FROM chatlog_reports WHERE c = ? AND reporter = ? AND state = 'open' LIMIT 1", [row.c, me.userId])).length) {
    return { ok: true, already: true, admins_only: ADMIN_ONLY.includes(why) };
  }
  const { trusted } = await reportGate(me, why, V);
  const t = now(), urgent = URGENT.includes(why), adminOnly = ADMIN_ONLY.includes(why);
  let already = false, id = null, first = false, hid = false;
  const have = await copyTables();
  await tx(async () => {
    if ((await getQuery("SELECT 1 FROM chatlog_reports WHERE c = ? AND reporter = ? AND state = 'open' LIMIT 1", [row.c, me.userId])).length) { already = true; return; }
    first = !(await getQuery("SELECT 1 FROM chatlog_reports WHERE c = ? AND state = 'open' LIMIT 1", [row.c])).length;
    const r = await runQuery("INSERT INTO chatlog_reports (c, rk, reporter, reason, note, state, created) VALUES (?, ?, ?, ?, ?, 'open', ?)",
                             [row.c, row.rk, me.userId, why, clean(note, NOTE_MAX) || null, t]);
    id = r && (r.id || r.lastID);
    if (urgent && trusted) hid = await setRm(row, "report:minor", null, t, have);
  });
  if (already) return { ok: true, already: true, admins_only: adminOnly };
  if (hid) await liveDrop(R.id, [row.c], false);
  const pad = padOf(R.id);
  if (urgent) {
    console.error(`[chatlogmod] URGENT chat line report #${id} in ${R.id} - ${hid ? "hidden pending review" : "reporter paused, not hidden"}`);
    for (const a of await admins()) {
      await notify(a.userId, { kind: "admin", title: "URGENT: a pad chat line was reported as involving a minor",
                               body: `On ${pad.title}. ${hid ? "It's hidden from everyone but the pad's owner and staff until you review it." : "The reporter's reports are paused, so it was NOT hidden - review it now."}`,
                               link: "/feed/admin#chatlines", ref: "chatrep-urgent:" + id });
    }
  } else if (first) {
    for (const a of await admins()) {
      await notify(a.userId, { kind: "admin", title: "A pad chat line was reported", body: `${LABELS[why]} - on ${pad.title}.`,
                               link: "/feed/admin#chatlines", ref: `chatrep-adm:${row.c}:${id}` });
    }
  }
  // the pad's owner (never for the legal / safety reasons): once per line - the link opens the line, where ⋯ › Hide is
  if (first && !adminOnly && pad.ownerId && pad.ownerId !== me.userId) {
    const tt = tFor(pad.ownerId);
    await notify(pad.ownerId, { kind: "room", title: tt("chatlog.n.own_title", { pad: pad.title }),
                                body: tt("chatlog.n.own_body", { reason: reasonFor(tt, why) }), link: lineLink(R.id, row.c),
                                ref: `chatrep-own:${row.c}` });
  }
  // (the owner reads room_events: only the reasons they're told anyway - CL6 fix-up: never minor / copyright, never "hidden")
  if (!adminOnly) await roomEvent(R.id, "chat.report", null, `#${row.c} ${why}`);
  return { ok: true, urgent, hidden: hid, admins_only: adminOnly };
}

/** 🗑 Remove my line (its author). Works whatever the pad's window (it's their own line); purged after 30 days. -> {ok, already?} */
async function removeMine(user, slug, c, { jc } = {}) {
  const { me, R, V, row } = await lineCtx(user, slug, c, { jc, see: false });
  // (not theirs: a line they can't see answers like no line - CL6 fix-up: never "not yours" about a !bridge hide person's line)
  if (!isAuthor(me, row)) throw notFound(V, hiddenWhy(V, R.id, row, jc) || "not_author");
  if (row.purged || row.rm_at != null) return { ok: true, already: true };
  const lim = limited(me.userId);
  if (lim) throw lim;
  let done = false;
  const have = await copyTables();
  await tx(async () => { done = await setRm(row, "self", null, now(), have); });
  if (done) {
    await liveDrop(R.id, [row.c], false);
    await roomEvent(R.id, "chat.hide", "author", `#${row.c} removed by its author`);
  }
  return { ok: true };
}

/** 🙈 Hide a line (owner, staff, the room's mods), with a reason. -> {ok, already?} */
async function hide(user, slug, c, { why, jc } = {}) {
  const me0 = await account(user);
  if (!me0) throw new Refuse(401, "Sign in first.", "signin");
  const text = clean(why, WHY_MAX);
  if (text.length < 2) throw new Refuse(400, "Say why (the pad's owner and staff see it).", "why");
  const { me, R, V, row } = await lineCtx(user, slug, c, { jc, see: false, must: mustHide });
  // CL6 fix-up: the actor must see the line (as if it weren't taken down) BEFORE anything about its state is answered
  const w = hiddenWhy(V, R.id, row, jc, { cleared: true, range: row.rm_at != null || !!row.purged });
  if (w) throw notFound(V, w);
  if (row.purged || row.rm_at != null) {
    if (V.role === "owner" || V.role === "staff") return { ok: true, already: true };
    throw notFound(V, "removed");
  }
  const lim = limited(me.userId);
  if (lim) throw lim;
  const staff = V.role === "staff";
  const by = (staff ? "staff:" : "mod:") + me.userId;
  let done = false;
  const have = await copyTables();
  await tx(async () => { done = await setRm(row, by, text, now(), have); });
  if (done) {
    await liveDrop(R.id, [row.c], false);
    // (the reason is the one the hider gave for the owner to read; staff show as "PATV staff" - who it was is in the audit)
    await roomEvent(R.id, "chat.hide", staff ? STAFF_ACTOR : me.username || me.userId, `#${row.c}: ${text}`);
    if (staff) await staffAudit(me, row, "hide", text);
  }
  return { ok: true };
}

/** ↩ Show a hidden line again: within 30 days - the owner / staff for a mod's hide, or the mod who hid it; staff for a staff or a
 *  "minor" report's hide; never a self-removal or a purged line. -> {ok, restored} */
async function unhide(user, slug, c) {
  const { me, R, V, row } = await lineCtx(user, slug, c, { see: false, must: mustHide });
  // CL6 fix-up: asked FIRST - the actor must be able to see the line (hidden lines aside): their floors, its access level, the
  // hidden set, scrollback / the live tail's span. A line nobody may see answers like no line, never "already shown".
  const w = hiddenWhy(V, R.id, row, null, { cleared: true, range: true });
  if (w) throw notFound(V, w);
  if (row.purged) throw notFound(V, "purged");
  if (row.rm_at == null) return { ok: true, already: true };
  const by = String(row.rm_by || "");
  const staff = V.role === "staff";
  const ok = by === "self" ? false
    : by.startsWith("mod:") ? (V.role === "owner" || staff || SP.can(me, MANAGE_ANY) || (mayHide(V, me) && by === "mod:" + me.userId))
    : staff;
  if (!ok) {
    throw new Refuse(403, by === "self" ? "Its author removed it - only they could say it again." : "Only PATV staff can show this line again.", "forbidden");
  }
  if (now() - Number(row.rm_at) > UNHIDE_MS) throw new Refuse(409, "It was hidden more than 30 days ago - its text is gone.", "too_late");
  const lim = limited(me.userId);
  if (lim) throw lim;
  let done = false;
  await tx(async () => {
    // (S1 V4 review 2: only the takedown that was checked above - a line that became its author's removal meanwhile, "Also remove
    //  my public messages" relabelling a moderator's hide to "self", stays down)
    const r = await runQuery("UPDATE chat_log SET rm_at = NULL, rm_by = NULL, rm_why = NULL WHERE c = ? AND rm_at IS NOT NULL AND rm_by IS ? AND purged IS NULL",
                             [row.c, row.rm_by == null ? null : String(row.rm_by)]);
    done = !!(r && r.changes);
    if (done && row.text != null && INDEXABLE_KINDS.includes(row.k)) await runQuery("UPDATE chatlog_rooms SET idx_rows = idx_rows + 1 WHERE rk = ?", [row.rk]);
  });
  if (done) {
    await liveRestore(R.id, row);
    await roomEvent(R.id, "chat.unhide", staff ? STAFF_ACTOR : me.username || me.userId, `#${row.c}`);
    if (staff) await staffAudit(me, row, "unhide", "");
  }
  return { ok: true, restored: done };
}

/** ⛔ Purge a line (staff with chatlog.read_all): wiped at once, everywhere. A legal hold refuses it. -> {ok, already?} */
async function purge(user, slug, c, { why } = {}) {
  const me0 = await account(user);
  if (!me0) throw new Refuse(401, "Sign in first.", "signin");
  if (!SP.can(me0, READ_ALL)) throw new Refuse(403, "PATV staff only.", "forbidden");
  const { me, R, row } = await lineCtx(user, slug, c, { see: false });
  if (row.purged) return { ok: true, already: true };
  if (isHeld(row.rk, row.who)) throw new Refuse(409, "A legal hold covers this line - release the hold first (/admin/bridge).", "held");
  const lim = limited(me.userId);
  if (lim) throw lim;
  const note = clean(why, WHY_MAX);
  await purgeRows([row], "staff:" + me.userId, note);
  // (CL6 fix-up: the pad's owner reads room_events - the staff note goes to the audit only)
  await roomEvent(R.id, "chat.purge", STAFF_ACTOR, `#${row.c}`);
  await staffAudit(me, row, "purge", note);
  return { ok: true };
}

// ── the owner sync (Pepe CL4): his !log / !search skip what the site took down ──
/** [[unix seconds, login hash], ...] - the room's newest REMOVED_MAX taken-down chat / mic lines (hidden, removed or purged).
 *  login hash = sha256("pepe-hidden:" + login)[:20], the hidden-set hash Pepe already uses (a web line: its u:<id> key). */
async function removedFor(roomId) { return (await removedRead(roomId)).list; }
/** removedFor + whether the list was read in full (Train 3 review: the owner sync's `removed_ok` - only then may Pepe let a shorter
 *  list replace the one he kept, so a moderator's un-hide comes back to !log; a failed read answers [] with ok false, which he only
 *  ever merges). An anonymised line (who "h:<hash>") names EVERY hash its speaker could be (d.ahs - Pepe's data.anon.hs), each its
 *  own entry: Pepe matches a line by the hash of the login HE has for it, which may be any of them. -> {list, ok} */
async function removedRead(roomId) {
  try {
    await init();
    const rk = await rkOf(roomId);
    if (!rk) return { list: [], ok: true };
    const rows = await getQuery(`SELECT ts, who, d FROM chat_log WHERE rk = ? AND rm_at IS NOT NULL AND k IN ('msg','tx') AND who IS NOT NULL
                                 ORDER BY rm_at DESC LIMIT ?`, [rk, REMOVED_MAX]);
    const list = [];
    for (const r of rows) {
      const sec = Math.floor(Number(r.ts) / 1000), w = String(r.who);
      if (!w.startsWith("h:")) { list.push([sec, CL.hash(r.who)]); continue; }
      const h = w.slice(2);
      list.push([sec, h]);
      let d = null;
      try { d = JSON.parse(r.d); } catch (e) { d = null; }
      const more = d && Array.isArray(d.ahs) ? d.ahs : [];
      for (const x of new Set(more)) if (typeof x === "string" && /^[0-9a-f]{20}$/.test(x) && x !== h) list.push([sec, x]);
    }
    return { list, ok: true };
  } catch (e) { console.error("[chatlogmod] removed list:", e.message); return { list: [], ok: false }; }
}
const PROTECTED_REASONS = Object.freeze(["forget", "delete", "staff"]);
async function metaJson(key) {
  try { const r = (await getQuery("SELECT value FROM chatlog_meta WHERE key = ?", [key]))[0]; return r ? JSON.parse(r.value) : null; } catch (e) { return null; }
}
/** staff "Delete every line": remember the people (their login hashes) and when, for removedWho. */
async function noteRmWho(keys, t) {
  const cur = (await metaJson("rm_who")) || {};
  for (const k of keys) cur[CL.hash(k)] = Math.floor(t);
  const keep = Object.entries(cur).filter(([h, at]) => /^[0-9a-f]{20}$/.test(h) && Number(at) > 0).sort((a, b) => b[1] - a[1]).slice(0, REMOVED_WHO_MAX);
  await runQuery("INSERT INTO chatlog_meta (key, value) VALUES ('rm_who', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                 [JSON.stringify(Object.fromEntries(keep))]);
}
/**
 * CL6 fix-up: the PEOPLE the site took down as a whole, for the owner sync's `removed_who` (Pepe's !log / !search: the per-line
 * `removed` list holds a room's newest REMOVED_MAX lines only, and never knew of site-only hides): [[login hash, until (unix s) |
 * null], ...] - the sticky set's forget / delete / staff reasons (forget-me / account deletion with "also hide my past public chat
 * lines", staff "Hide every line"): null = every line, any time; a staff "Delete every line": the lines up to then. At most
 * REMOVED_WHO_MAX (the every-line entries first, then the newest). Never throws.
 */
async function removedWho() {
  try {
    await init();
    const out = new Map();
    for (const h of CL.hiddenHashes()) if (CL.hiddenReasons(h).some((k) => PROTECTED_REASONS.includes(k))) out.set(h, null);
    const m = (await metaJson("rm_who")) || {};
    const timed = Object.entries(m).filter(([h, at]) => /^[0-9a-f]{20}$/.test(h) && Number(at) > 0 && !out.has(h)).sort((a, b) => b[1] - a[1]);
    for (const [h, at] of timed) out.set(h, Math.floor(Number(at) / 1000));
    return [...out].slice(0, REMOVED_WHO_MAX);
  } catch (e) { console.error("[chatlogmod] removed people:", e.message); return []; }
}

/** CL8: who hid each line, for the owner's / staff's muted rows (chatlogview.dress ctx.rmNames). items: raw feed items with rm_by.
 *  -> Map(rm_by -> username) for mod: / staff: actors */
async function rmNames(items) {
  const ids = new Map();
  for (const it of items || []) {
    const m = /^(?:mod|staff):(.+)$/.exec(String((it && it.rm_by) || ""));
    if (m) ids.set(it.rm_by, m[1]);
  }
  const out = new Map();
  const uniq = [...new Set(ids.values())];
  for (let i = 0; i < uniq.length; i += 400) {
    const part = uniq.slice(i, i + 400);
    const rows = await getQuery(`SELECT userId, username FROM users WHERE userId IN (${part.map(() => "?").join(",")})`, part).catch(() => []);
    const name = new Map(rows.map((r) => [String(r.userId), r.username]));
    for (const [by, id] of ids) if (name.has(id)) out.set(by, name.get(id));
  }
  return out;
}

// ── the report queue (staff with chatlog.read_all; /feed/admin "Reported chat lines") ──
/** Open reports grouped per line, urgent first, then the newest report - CL6 fix-up: the LINES are picked first (QUEUE_LINES of
 *  them, each with up to QUEUE_PER_LINE reports: `more` counts the rest), so a flood of reports on some lines never pushes an older
 *  urgent one out. No line text here (it's read on demand, and logged). */
async function reportQueue() {
  await init();
  const lines = await getQuery(`SELECT c, MAX(CASE WHEN reason IN (${URGENT.map(() => "?").join(",")}) THEN 1 ELSE 0 END) AS urgent, MAX(created) AS last
                                FROM chatlog_reports WHERE state = 'open' GROUP BY c ORDER BY urgent DESC, last DESC LIMIT ?`, [...URGENT, QUEUE_LINES]);
  if (!lines.length) return [];
  const cs = lines.map((r) => Number(r.c));
  const rows = await getQuery(`SELECT r.*, u.username AS reporter_name, l.k, l.ts, l.who, l.rm_at, l.rm_by, l.purged, cr.room_id
                               FROM chatlog_reports r LEFT JOIN users u ON u.userId = r.reporter LEFT JOIN chat_log l ON l.c = r.c
                               LEFT JOIN chatlog_rooms cr ON cr.rk = r.rk WHERE r.state = 'open' AND r.c IN (${cs.map(() => "?").join(",")}) ORDER BY r.id DESC`, cs);
  const by = new Map();
  for (const r of rows) {
    let g = by.get(Number(r.c));
    if (!g) {
      const pad = padOf(r.room_id);
      g = { c: Number(r.c), room_id: r.room_id || null, pad: pad.title, slug: pad.slug, k: r.k || null, ts: r.ts == null ? null : Number(r.ts),
            state: r.k == null ? "gone" : r.purged ? "purged" : r.rm_at != null ? (String(r.rm_by || "").startsWith("report:") ? "hidden_report" : String(r.rm_by) === "self" ? "removed_self" : "hidden") : "shown",
            held: r.rk != null && isHeld(r.rk, r.who), reports: [], more: 0, urgent: false, adminOnly: false };
      by.set(Number(r.c), g);
    }
    const urgent = URGENT.includes(r.reason);
    g.urgent = g.urgent || urgent;
    g.adminOnly = g.adminOnly || ADMIN_ONLY.includes(r.reason);
    if (g.reports.length >= QUEUE_PER_LINE) { g.more++; continue; }
    g.reports.push({ id: Number(r.id), reason: r.reason, label: LABELS[r.reason] || r.reason, note: r.note || "", reporter: r.reporter_name || "[gone]", created: Number(r.created),
                     urgent, adminOnly: ADMIN_ONLY.includes(r.reason) });
  }
  return cs.map((c) => by.get(c)).filter(Boolean);
}
async function mustStaff(user) {
  const me = await account(user);
  if (!me) throw new Refuse(401, "Sign in first.", "signin");
  if (!SP.can(me, READ_ALL)) throw new Refuse(403, "PATV staff only.", "forbidden");
  await init();
  return me;
}
async function rowByC(c) {
  const n = Math.floor(Number(c));
  if (!(n > 0)) return null;
  return (await getQuery("SELECT l.*, r.room_id FROM chat_log l JOIN chatlog_rooms r ON r.rk = l.rk WHERE l.c = ?", [n]))[0] || null;
}
/** "Read the reported line": its text and who said it - every read is a chatlog_views row. CL6 fix-up: who said it as every other
 *  read path shows it - someone the hidden set hides NOW (incognito, or left out) is "someone", no name, no login (their words are
 *  what the admins decide on). */
async function reportRead(user, c) {
  const me = await mustStaff(user);
  const row = await rowByC(c);
  if (!row) throw new Refuse(404, "That line isn't in the archive any more.", "not_found");
  if (!(await getQuery("SELECT 1 FROM chatlog_reports WHERE c = ? LIMIT 1", [row.c])).length) throw new Refuse(404, "Nobody reported that line.", "not_found");
  let p = null;
  try { const CV = require("./chatlogview"); p = row.purged ? null : CV.privacyOf(CV.itemOf(row)); } catch (e) { p = "out"; }
  const anon = p === "anon" || p === "out" || String(row.who || "").startsWith("h:");
  await audit(me.userId, { rk: row.rk, who: row.who && !anon ? row.who : null, kind: "history", from: row.ts, to: row.ts, why: "report queue #" + row.c });
  let d = {};
  try { d = JSON.parse(row.d) || {}; } catch (e) { d = {}; }
  const u = d.u || {};
  return { c: Number(row.c), k: row.k, ts: Number(row.ts), text: row.purged ? null : row.text, purged: !!row.purged,
           name: row.purged ? null : anon ? "someone" : (u.display || row.who || null), anon: !row.purged && anon,
           login: row.purged || anon || !row.who || String(row.who).startsWith("u:") ? null : row.who,
           removed: row.rm_at != null ? { at: Number(row.rm_at), by: String(row.rm_by || "").replace(/:.*/, ""), why: row.rm_why || "" } : null };
}
const QUEUE_ACTIONS = Object.freeze(["dismiss", "false", "hide", "purge"]);
const AFTER_REPORT = "after a report";      // a queue hide's reason as the pad's owner reads it (the staff note goes to the audit)
/** The admins' outcome on a line's open reports: dismiss | false (bad faith: counts against the reporters) | hide | purge.
 *  A "minor" report's hide is lifted by dismiss / false. tell (default on): each reporter gets an inbox notice of the outcome. */
async function reportDecide(user, c, { action, tell = true, why = "" } = {}) {
  const me = await mustStaff(user);
  if (!QUEUE_ACTIONS.includes(action)) throw new Refuse(400, "Unknown action.", "bad_action");
  const row = await rowByC(c);
  const open = await getQuery("SELECT * FROM chatlog_reports WHERE c = ? AND state = 'open'", [Math.floor(Number(c)) || 0]);
  if (!open.length) throw new Refuse(404, "No open reports on that line.", "not_found");
  const note = clean(why, WHY_MAX);
  const t = now();
  let state = action === "dismiss" ? "dismissed" : action === "false" ? "false" : "actioned";
  if (row && (action === "dismiss" || action === "false") && row.rm_by === "report:minor" && !row.purged) {
    let lifted = false;
    await tx(async () => {
      const r = await runQuery("UPDATE chat_log SET rm_at = NULL, rm_by = NULL, rm_why = NULL WHERE c = ? AND rm_by = 'report:minor' AND purged IS NULL", [row.c]);
      lifted = !!(r && r.changes);
      if (lifted && row.text != null && INDEXABLE_KINDS.includes(row.k)) await runQuery("UPDATE chatlog_rooms SET idx_rows = idx_rows + 1 WHERE rk = ?", [row.rk]);
    });
    // (CL6 fix-up: no "(report dismissed)" in the owner's room_events - it would say a report hid it, i.e. why)
    if (lifted) { await liveRestore(row.room_id, row); await roomEvent(row.room_id, "chat.unhide", STAFF_ACTOR, `#${row.c}`); }
  }
  if (row && action === "hide" && row.rm_at == null && !row.purged) {
    let done = false;
    const have = await copyTables();
    await tx(async () => { done = await setRm(row, "staff:" + me.userId, AFTER_REPORT, t, have); });
    if (done) { await liveDrop(row.room_id, [row.c], false); await roomEvent(row.room_id, "chat.hide", STAFF_ACTOR, `#${row.c}: ${AFTER_REPORT}`); }
  }
  if (row && action === "purge" && !row.purged) {
    if (isHeld(row.rk, row.who)) throw new Refuse(409, "A legal hold covers this line - release the hold first.", "held");
    await purgeRows([row], "staff:" + me.userId, note || AFTER_REPORT, t);
    await roomEvent(row.room_id, "chat.purge", STAFF_ACTOR, `#${row.c}`);
  }
  await runQuery(`UPDATE chatlog_reports SET state = ?, decided_by = ?, decided_at = ? WHERE id IN (${open.map(() => "?").join(",")})`,
                 [state, me.userId, t, ...open.map((r) => r.id)]);
  if (row) await staffAudit(me, row, "queue " + action, note);
  let told = 0;
  if (tell) {
    const seen = new Set();
    for (const r of open) {
      if (!r.reporter || seen.has(r.reporter)) continue;
      seen.add(r.reporter);
      const removed = action === "hide" || action === "purge";
      const tt = tFor(r.reporter);
      await notify(r.reporter, { kind: "feed", title: tt("chatlog.n.out_title"),
        body: tt(removed ? "chatlog.n.out_removed" : "chatlog.n.out_kept", { reason: reasonFor(tt, r.reason) }),
        link: "/terms", ref: "chatrep-out:" + r.id });
      told++;
    }
  }
  console.log(`[chatlogmod] reports on line ${Number(c)}: ${state} by ${me.username || me.userId} (${open.length})`);
  return { ok: true, resolved: open.length, notified: told, state };
}

// ── the per-login tool (staff) ──
/** "bob" (a Camfrog login), "u:<id>" (an account's web lines + its linked login), "@username" (a PATV account: both keys).
 *  -> {keys, account: {userId, username} | null, label} */
async function resolveKeys(input) {
  const s = String(input == null ? "" : input).trim();
  const acct = async (where, v) => (await getQuery(`SELECT userId, username, camfrogUsername FROM users WHERE ${where} LIMIT 2`, [v]).catch(() => []));
  let keys = [], a = null;
  if (/^u:[A-Za-z0-9_-]{1,64}$/i.test(s)) {
    const rows = await acct("lower(userId) = lower(?)", s.slice(2));
    a = rows.length === 1 ? rows[0] : null;
    keys = ["u:" + lower(s.slice(2))];
    if (a && a.camfrogUsername && LOGIN_RE.test(lower(a.camfrogUsername))) keys.push(lower(a.camfrogUsername));
  } else if (/^@[\w.\-]{1,64}$/.test(s)) {
    const rows = await acct("lower(username) = lower(?)", s.slice(1));
    if (rows.length !== 1) throw new Refuse(404, "No such PATV account.", "no_account");
    a = rows[0];
    keys = ["u:" + lower(a.userId)];
    if (a.camfrogUsername && LOGIN_RE.test(lower(a.camfrogUsername))) keys.push(lower(a.camfrogUsername));
  } else if (LOGIN_RE.test(s)) {
    keys = [lower(s)];
    const rows = await acct("lower(camfrogUsername) = lower(?)", s);
    a = rows.length === 1 ? rows[0] : null;
  } else throw new Refuse(400, "Give a Camfrog login, u:<account id> or @username.", "bad_key");
  return { keys: [...new Set(keys)], account: a ? { userId: String(a.userId), username: a.username } : null, label: s };
}
// (CL6 fix-up: unhide_all = undo a staff "Hide every line" - only the staff reason goes; Pepe's, forget-me's and deletion's stay)
const WHO_ACTIONS = Object.freeze(["look", "hide_all", "unhide_all", "purge_all", "export", "hold", "unhold"]);
/** The owner's decision-9 change: a person's keys in the archive - their chat keys and the "h:<hash>" of each (the lines they said
 *  while incognito, which Pepe sent anonymised; a purged line's who has that shape too, so the counts below skip purged rows). */
const lineKeys = (keys) => [...keys, ...keys.map((k) => "h:" + CL.hash(k))];
async function whoSummary(keys) {
  const q = keys.map(() => "?").join(",");
  const lk = lineKeys(keys), lq = lk.map(() => "?").join(",");
  const per = await getQuery(`SELECT r.room_id, COUNT(*) AS n, SUM(CASE WHEN l.rm_at IS NOT NULL THEN 1 ELSE 0 END) AS rm, MIN(l.ts) AS first, MAX(l.ts) AS last
                              FROM chat_log l JOIN chatlog_rooms r ON r.rk = l.rk WHERE l.who IN (${lq}) AND (l.purged IS NULL OR l.who NOT LIKE 'h:%')
                              GROUP BY l.rk ORDER BY n DESC LIMIT 200`, lk);
  let relays = null;
  if (await tableThere("dm_relays")) {
    const cols = (await getQuery("SELECT name FROM pragma_table_info('dm_relays')")).map((r) => r.name);
    if (cols.includes("to_login")) relays = Number((await getQuery(`SELECT COUNT(*) AS n FROM dm_relays WHERE lower(to_login) IN (${q})`, keys))[0].n) || 0;
  }
  return {
    lines: per.reduce((n, r) => n + (Number(r.n) || 0), 0),
    rooms: per.map((r) => ({ room_id: r.room_id, title: padOf(r.room_id).title, n: Number(r.n) || 0, removed: Number(r.rm) || 0, first: Number(r.first) || null, last: Number(r.last) || null })),
    hidden: keys.some((k) => CL.isHiddenKey(k)), tx_hidden: keys.some((k) => CL.isTxHiddenKey(k)),
    held: keys.filter((k) => heldWhoKey(k)), relays_to: relays, camfrog: await camfrogSummary(keys),
  };
}
// Train 3 review - the CL13 merge item (commits 3a1e7ffa / c0b6bc26: "the CL6 per-login staff tool should call cfLoginSummary /
// cfLoginForget once the branches meet"): the per-login tool also covers the person's Camfrog login in Pepe's !msg copy records
// (dm_relays to / from) and in the admins' "📨 Sent in Camfrog to <login>" logs (conversations.kind 'cfpm') - so a privacy@ request
// from someone without an account needs no separate tools/cflogin.js run. Counts only, never a message's text or sender.
const cfLogins = (keys) => keys.filter((k) => !/^u:/i.test(k) && LOGIN_RE.test(k));
/** {copies_to, copies_from, threads} summed over the keys' Camfrog logins (messages.cfLoginSummary), or null when it can't be read. */
async function camfrogSummary(keys) {
  try {
    const M = require("./messages");
    const out = { copies_to: 0, copies_from: 0, threads: 0 };
    for (const l of cfLogins(keys)) {
      const s = await M.cfLoginSummary(l);
      if (s) { out.copies_to += Number(s.copies_to) || 0; out.copies_from += Number(s.copies_from) || 0; out.threads += Number(s.threads) || 0; }
    }
    return out;
  } catch (e) { console.error("[chatlogmod] camfrog copies:", e.message); return null; }
}
/** Train 3 review fix-up: the staff audit rows that name a forgotten Camfrog login as their SUBJECT (chatlog_views.who, a
 *  space-separated key list) name its pseudonym instead - one transaction. -> rows changed (0 when the audit can't be read). */
async function renameAuditSubject(login, pseudo) {
  const k = lower(login);
  if (!k || !pseudo) return 0;
  try {
    const like = "% " + k.replace(/[\\%_]/g, (m) => "\\" + m) + " %";
    return await tx(async () => {
      let n = 0;
      for (const r of await getQuery("SELECT id, who FROM chatlog_views WHERE ' ' || lower(who) || ' ' LIKE ? ESCAPE '\\'", [like])) {
        const next = String(r.who).split(/\s+/).map((x) => (x.toLowerCase() === k ? pseudo : x)).join(" ");
        if (next === r.who) continue;
        await runQuery("UPDATE chatlog_views SET who = ? WHERE id = ?", [next, r.id]);
        n++;
      }
      return n;
    });
  } catch (e) { console.error("[chatlogmod] audit subject rename:", e.message); return 0; }
}
/** The per-login tool. -> {ok, keys, account, summary, ...result} (export: + export {lines, relays}). Every action - a look too
 *  (CL6 fix-up: it tells where and when someone spoke) - needs the reason, and is audited. */
async function whoAction(user, input, { action = "look", why = "" } = {}) {
  const me = await mustStaff(user);
  if (!WHO_ACTIONS.includes(action)) throw new Refuse(400, "Unknown action.", "bad_action");
  const note = clean(why, WHY_MAX);
  if (note.length < 3) throw new Refuse(400, "Give the reason (the request, the order, the case) - it's audited.", "why");
  const { keys, account: acct, label } = await resolveKeys(input);
  // Train 3 review fix-up: "Delete every line" forgets the Camfrog login (its lines keep only a hash, its !msg copy records get a
  // pseudonym) - so its own audit row names each Camfrog login by that PSEUDONYM, never the login (tools/cflogin.js: the audit
  // "must not keep the very name a forget removes"; a row naming the login a few ms before the pseudonym's would link the two).
  // A refused one (a legal hold) forgets nothing and is audited by the keys, as every other action is.
  const forgetting = action === "purge_all" && !keys.some((k) => heldWhoKey(k));
  const pseudoOf = new Map(forgetting ? cfLogins(keys).map((l) => [l, "deleted-" + require("crypto").randomBytes(5).toString("hex")]) : []);
  await audit(me.userId, { who: keys.map((k) => pseudoOf.get(k) || k).join(" "), kind: "login_tool", why: `${action}${note ? ": " + note : ""}` });
  const out = { ok: true, keys, account: acct, label };
  const t = now();
  if (action === "hide_all") {
    await CL.hideNow(keys, "staff");
    out.hidden = true;
  } else if (action === "unhide_all") {
    const r = await CL.unhideStaff(keys);
    out.unhidden = Number(r && r.removed) || 0;
    out.still_hidden = keys.some((k) => CL.isHiddenKey(k));             // another reason (Pepe's, forget-me, deletion) still hides them
  } else if (action === "purge_all") {
    if (keys.some((k) => heldWhoKey(k))) throw new Refuse(409, "A legal hold covers this login - release it first.", "held");
    let last = 0, purged = 0, skipped = 0;
    const lk = lineKeys(keys), q = lk.map(() => "?").join(",");
    for (;;) {
      const rows = await getQuery(`SELECT l.*, r.room_id FROM chat_log l JOIN chatlog_rooms r ON r.rk = l.rk WHERE l.who IN (${q}) AND l.purged IS NULL AND l.c > ?
                                   ORDER BY l.c LIMIT ?`, [...lk, last, BATCH]);
      if (!rows.length) break;
      last = Number(rows[rows.length - 1].c);
      const go = rows.filter((r) => !heldRoom(r.rk));
      skipped += rows.length - go.length;
      purged += (await purgeRows(go, "staff:" + me.userId, note, t)).purged;
      await yieldNow();
    }
    out.purged = purged; out.skipped_held = skipped;
    // (CL6 fix-up: Pepe's !log / !search skip every line of theirs up to now - the per-line removed list keeps only a room's newest)
    await noteRmWho(keys, t);
    // Train 3 review (the CL13 merge item): the Camfrog login leaves Pepe's !msg copy records and the admins' Camfrog logs too -
    // messages.cfLoginForget: a random pseudonym ("deleted-<10 hex>") in dm_relays and the logs' keys (the copies' text stays: it is
    // the admin's own record), each login its own transaction. Audited by the PSEUDONYM and the counts, never the login (the
    // tools/cflogin.js rule) - fix-up: the action's own audit row above names it by the same pseudonym, and the earlier per-login
    // audit rows naming it as their subject (a look, an export, a hold) get the pseudonym too (chatlog.deleteAccount's rule)
    const cf = { relays: 0, threads: 0 };
    let renamed = 0;
    for (const l of cfLogins(keys)) {
      const pseudo = pseudoOf.get(l) || "deleted-" + require("crypto").randomBytes(5).toString("hex");
      const r = await require("./messages").cfLoginForget(l, pseudo);
      const n = { relays: Number(r && r.relays) || 0, threads: Number(r && r.threads) || 0 };
      cf.relays += n.relays; cf.threads += n.threads;
      if (n.relays || n.threads) await audit(me.userId, { who: pseudo, kind: "login_tool", why: `purge_all: !msg copies -> pseudonym (${n.relays} copy record(s), ${n.threads} Camfrog log(s))` });
      renamed += await renameAuditSubject(l, pseudo);
    }
    out.camfrog_forgot = cf;
    if (renamed) out.audit_renamed = renamed;
    console.log(`[chatlogmod] login tool: purge_all by ${me.username || me.userId} - ${purged} line(s), ${skipped} under a room hold`);
  } else if (action === "export") {
    const q = keys.map(() => "?").join(",");
    const lk = lineKeys(keys), lq = lk.map(() => "?").join(",");
    const rows = await getQuery(`SELECT l.c, l.ts, l.k, l.text, l.d, l.rm_at, r.room_id FROM chat_log l JOIN chatlog_rooms r ON r.rk = l.rk
                                 WHERE l.who IN (${lq}) AND l.purged IS NULL ORDER BY l.c LIMIT ?`, [...lk, EXPORT_MAX]);
    const KIND = { msg: "chat", tx: "mic", join: "join", leave: "leave", mic: "mic_grab", unmic: "mic_drop" };
    let relays = [];
    if (await tableThere("dm_relays")) {
      const cols = (await getQuery("SELECT name FROM pragma_table_info('dm_relays')")).map((r) => r.name);
      if (cols.includes("to_login")) {
        const pick = ["from_login", "to_login", "cf_room", "cf_sent_at", "created"].filter((c) => cols.includes(c));
        relays = await getQuery(`SELECT ${pick.join(", ")} FROM dm_relays WHERE lower(to_login) IN (${q}) ORDER BY 1 LIMIT 5000`, keys);
      }
    }
    out.export = {
      format: "patv-chatlog-login/1", keys, generated_at: new Date(t).toISOString(), by: me.username || null, truncated: rows.length >= EXPORT_MAX,
      lines: rows.map((r) => {
        let d = {};
        try { d = JSON.parse(r.d) || {}; } catch (e) { d = {}; }
        return { room: r.room_id, ts: new Date(Number(r.ts)).toISOString(), kind: KIND[r.k] || r.k, text: r.text == null ? null : r.text,
                 shown_as: d.u && d.u.display ? String(d.u.display) : null, removed: r.rm_at != null };
      }),
      relays_to: relays,
      // Train 3 review (the CL13 merge item): the counts of the login's !msg copy records and the admins' Camfrog logs named after it
      camfrog: await camfrogSummary(keys),
    };
  } else if (action === "hold" || action === "unhold") {
    for (const k of keys) {
      if (action === "hold") await runQuery("INSERT INTO chatlog_holds (key, by_user, why, at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING", ["who:" + k, me.userId, note, t]);
      else await runQuery("DELETE FROM chatlog_holds WHERE key = ?", ["who:" + k]);
    }
    await loadHolds();
  }
  out.summary = await whoSummary(keys);
  return out;
}

// ── room holds and the owner's earlier era (staff) ──
/** A room by its rk, room id or pad address -> {rk, room_id} (only rooms the archive knows). */
async function roomRef(ref) {
  const s = String(ref == null ? "" : ref).trim();
  if (/^\d{1,12}$/.test(s)) {
    const r = (await getQuery("SELECT rk, room_id FROM chatlog_rooms WHERE rk = ?", [Number(s)]))[0];
    if (r) return { rk: Number(r.rk), room_id: r.room_id };
  }
  let id = s;
  const byId = (await getQuery("SELECT rk, room_id FROM chatlog_rooms WHERE room_id = ?", [id]))[0];
  if (byId) return { rk: Number(byId.rk), room_id: byId.room_id };
  const R = await require("./roomsweb").resolveRoom(s.replace(/^.*\/p\//, "").replace(/[/?#].*$/, "")).catch(() => null);
  if (R && R.id) {
    id = R.id;
    const r = (await getQuery("SELECT rk, room_id FROM chatlog_rooms WHERE room_id = ?", [id]))[0];
    if (r) return { rk: Number(r.rk), room_id: r.room_id };
  }
  throw new Refuse(404, "That pad has no archived chat.", "not_found");
}
/** A legal hold on a room's archive (pauses the 30-day text removal, CL7's purge and staff purges there). -> {ok, held} */
async function roomHold(user, ref, { on = true, why = "" } = {}) {
  const me = await mustStaff(user);
  const note = clean(why, WHY_MAX);
  if (note.length < 3) throw new Refuse(400, "Give the reason (the request, the order, the case) - it's audited.", "why");
  const r = await roomRef(ref);
  if (on) await runQuery("INSERT INTO chatlog_holds (key, by_user, why, at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET why = excluded.why",
                         ["room:" + r.rk, me.userId, note, now()]);
  else await runQuery("DELETE FROM chatlog_holds WHERE key = ?", ["room:" + r.rk]);
  await loadHolds();
  // (CL6 fix-up: never a room_events row - the pad's owner reads those, and a hold and its reason are the site's legal business)
  await audit(me.userId, { rk: r.rk, kind: "login_tool", why: `${on ? "room hold" : "room unhold"}: ${note}` });
  return { ok: true, held: !!on, room_id: r.room_id };
}
/** Let the pad's owner read the archive from before they became its owner (or take it back). Audited (kind grant). */
async function ownerGrant(user, ref, { on = true, why = "" } = {}) {
  const me = await mustStaff(user);
  const note = clean(why, WHY_MAX);
  if (note.length < 3) throw new Refuse(400, "Give the reason - it's audited.", "why");
  const r = await roomRef(ref);
  const done = await require("./chatlogview").setOwnerGrant(r.room_id, !!on);
  // (the owner may know their access changed; the staff note stays in the audit - CL6 fix-up)
  await roomEvent(r.room_id, "chat.grant", STAFF_ACTOR, on ? "owner may read the earlier era" : "earlier era closed to the owner");
  await audit(me.userId, { rk: r.rk, kind: "grant", why: `${on ? "grant" : "revoke"}: ${note}` });
  return { ok: true, granted: !!on, changed: !!done, room_id: r.room_id };
}

/** The "Chat takedowns" card: holds, the queue's size, the newest audit rows. */
async function adminView(user) {
  await mustStaff(user);
  const holds = await getQuery(`SELECT h.key, h.why, h.at, u.username AS by_name, r.room_id FROM chatlog_holds h LEFT JOIN users u ON u.userId = h.by_user
                                LEFT JOIN chatlog_rooms r ON h.key = 'room:' || r.rk ORDER BY h.at DESC LIMIT 200`);
  const open = await getQuery("SELECT reason, COUNT(DISTINCT c) AS n FROM chatlog_reports WHERE state = 'open' GROUP BY reason");
  const views = await getQuery(`SELECT v.at, v.kind, v.who, v.why, v.from_ts, v.to_ts, u.username, r.room_id FROM chatlog_views v LEFT JOIN users u ON u.userId = v.user_id
                                LEFT JOIN chatlog_rooms r ON r.rk = v.rk ORDER BY v.id DESC LIMIT 50`);
  return {
    ok: true,
    holds: holds.map((h) => ({ key: h.key, kind: String(h.key).startsWith("room:") ? "room" : "who", room_id: h.room_id || null,
                               title: h.room_id ? padOf(h.room_id).title : null, who: String(h.key).startsWith("who:") ? String(h.key).slice(4) : null,
                               why: h.why, at: Number(h.at), by: h.by_name || null })),
    reports: { open: open.reduce((n, r) => n + (Number(r.n) || 0), 0), urgent: open.filter((r) => URGENT.includes(r.reason)).reduce((n, r) => n + (Number(r.n) || 0), 0) },
    views: views.map((v) => ({ at: Number(v.at), kind: v.kind, who: v.who || null, why: v.why || null, by: v.username || null, room_id: v.room_id || null,
                               from: v.from_ts == null ? null : Number(v.from_ts), to: v.to_ts == null ? null : Number(v.to_ts) })),
    keep_days: Math.round(KEEP_RM_MS / 864e5),
  };
}

// ── the nightly pass: hidden / removed lines' text goes after 30 days (holds and open reports skip), the audit's own retention ──
/** CL6 fix-up: one batch of taken-down rows whose text is still there, rm_at before the cutoff, in (rm_at, c) order after the last
 *  one - a keyset walk of the partial index chat_log_rm_due (purged rows leave it: it never grows with the archive), no sort, no
 *  scan. params: lastRm, cut, lastRm, lastC, limit */
const DUE_SQL = `SELECT l.* FROM chat_log AS l INDEXED BY chat_log_rm_due
                 WHERE l.rm_at IS NOT NULL AND l.purged IS NULL AND l.rm_at >= ? AND l.rm_at < ? AND (l.rm_at > ? OR l.c > ?) ORDER BY l.rm_at, l.c LIMIT ?`;
let nightlyBusy = false;
async function nightly({ t = now() } = {}) {
  await init();
  if (nightlyBusy) return { busy: true };
  nightlyBusy = true;
  const out = { purged: 0, skipped_held: 0, skipped_reported: 0, views: 0, reports: 0, erased: 0, erase_waiting: 0 };
  try {
    const cut = t - KEEP_RM_MS;
    let lastRm = 0, lastC = 0;
    const roomOf = new Map();
    for (;;) {
      const rows = await getQuery(DUE_SQL, [lastRm, cut, lastRm, lastC, BATCH]);
      if (!rows.length) break;
      const tail = rows[rows.length - 1];
      lastRm = Number(tail.rm_at); lastC = Number(tail.c);
      // a line with an OPEN report keeps its text until the admins decide (the evidence - a "minor" report's above all), like a hold
      const cs = rows.map((r) => Number(r.c));
      const open = new Set((await getQuery(`SELECT DISTINCT c FROM chatlog_reports WHERE state = 'open' AND c IN (${cs.map(() => "?").join(",")})`, cs)).map((r) => Number(r.c)));
      // S1 V4 fix-up: a line "Also remove my public messages" met under a hold is eraseWaitPass's (D10's bounds, below)
      const waits = new Set((await getQuery(`SELECT c FROM chatlog_erase_wait WHERE c IN (${cs.map(() => "?").join(",")})`, cs)).map((r) => Number(r.c)));
      const need = [...new Set(rows.map((r) => Number(r.rk)).filter((rk) => !roomOf.has(rk)))];
      if (need.length) for (const r of await getQuery(`SELECT rk, room_id FROM chatlog_rooms WHERE rk IN (${need.map(() => "?").join(",")})`, need)) roomOf.set(Number(r.rk), r.room_id);
      const go = [];
      for (const r of rows) {
        if (isHeld(r.rk, r.who)) out.skipped_held++;
        else if (open.has(Number(r.c))) out.skipped_reported++;
        else if (waits.has(Number(r.c))) continue;
        else if (roomOf.has(Number(r.rk))) go.push(Object.assign(r, { room_id: roomOf.get(Number(r.rk)) }));
      }
      out.purged += (await purgeRows(go, "system", null, t)).purged;
      if (rows.length < BATCH) break;
      await yieldNow();
    }
    // S1 V4 fix-up: account deletions' "Also remove my public messages" - the held lines whose holds have ended
    const ew = await eraseWaitPass(t);
    out.erased = ew.purged;
    out.erase_waiting = ew.waiting;
    const v = await runQuery("DELETE FROM chatlog_views WHERE at < ?", [t - VIEWS_KEEP_MS]);
    out.views = (v && v.changes) || 0;
    // decided reports are kept REPORTS_KEEP_MS (an open one stays open)
    const rp = await runQuery("DELETE FROM chatlog_reports WHERE state <> 'open' AND COALESCE(decided_at, created) < ?", [t - REPORTS_KEEP_MS]);
    out.reports = (rp && rp.changes) || 0;
    // the words a purge took out of the search index leave its segments when FTS5 merges them: a bounded merge step each night
    if (out.purged || out.erased) {
      try { await tx(() => runQuery("INSERT INTO chat_log_fts (chat_log_fts, rank) VALUES ('merge', 500)")); } catch (e) { /* no index (search's fallback) */ }
    }
    await runQuery("INSERT INTO chatlog_meta (key, value) VALUES ('takedown_pass_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(t)]);
    if (out.purged || out.skipped_held || out.skipped_reported) {
      console.log(`[chatlogmod] nightly: ${out.purged} hidden line(s) blanked after 30 days, ${out.skipped_held} under a legal hold, ${out.skipped_reported} with an open report`);
    }
    if (out.erased || out.erase_waiting) {
      console.log(`[chatlogmod] nightly: ${out.erased} line(s) of deleted accounts erased once their holds ended, ${out.erase_waiting} still held`);
    }
    return out;
  } finally { nightlyBusy = false; }
}
/** CL7: the archive's ONE nightly pass is chatlogpurge.js's - it runs nightly() first ("rows hidden or removed more than 30
 *  days ago are NULLed in the same pass, whatever the mode"), then the retention purge (takedown_pass_at still records it). */
function start() {
  require("./chatlogpurge").start();
}

// ── the routes ──
function register(app, { addUser }) {
  const express = require("express");
  const guard = require("./middleware/authGuard");
  const json = express.json({ limit: "4kb" });
  init().catch((e) => console.error("[chatlogmod] init:", e.message));
  start();
  const head = (res) => res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive" });
  const fail = (res, e) => {
    // (code: the page shows its own words for it - js.pad.chat.err.<code>; error: the English fallback; retry: seconds, for rate)
    if (e && e.refuse) {
      return res.status(e.status || 400).json({ ok: false, error: e.message, code: e.code || undefined, ...(e.why ? { why: e.why } : {}),
                                                ...(e.retry ? { retry: e.retry } : {}) });
    }
    console.error("[chatlogmod]", e && e.message);
    res.status(500).json({ ok: false, error: "Something went wrong - nothing was changed." });
  };
  // writes: JSON from this site's own pages only (the accountexport pattern)
  const sameOrigin = (req, res) => {
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) { res.status(403).json({ ok: false, error: "Security check failed - reload the page." }); return false; }
    return true;
  };
  const line = (path, fn) => app.post(`/api/rooms/:slug/chatlog/:c/${path}`, addUser, json, async (req, res) => {
    head(res);
    if (!sameOrigin(req, res)) return;
    try { res.json(await fn(req.user, req.params.slug, req.params.c, req.body || {})); } catch (e) { fail(res, e); }
  });
  line("report", (u, s, c, b) => report(u, s, c, { reason: b.reason, note: b.note, jc: typeof b.jc === "string" ? b.jc : null }));
  line("remove", (u, s, c, b) => removeMine(u, s, c, { jc: typeof b.jc === "string" ? b.jc : null }));
  line("hide", (u, s, c, b) => hide(u, s, c, { why: b.why, jc: typeof b.jc === "string" ? b.jc : null }));
  line("unhide", (u, s, c) => unhide(u, s, c));
  line("purge", (u, s, c, b) => purge(u, s, c, { why: b.why }));

  // staff (chatlog.read_all)
  app.get("/api/admin/chatlog/takedowns", addUser, async (req, res) => {
    head(res);
    try { res.json(await adminView(req.user)); } catch (e) { fail(res, e); }
  });
  app.get("/api/admin/chatlog/reports", addUser, async (req, res) => {
    head(res);
    try { await mustStaff(req.user); res.json({ ok: true, lines: await reportQueue() }); } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/chatlog/reports/:c", addUser, json, async (req, res) => {
    head(res);
    if (!sameOrigin(req, res)) return;
    const b = req.body || {};
    try {
      if (b.action === "read") return res.json({ ok: true, line: await reportRead(req.user, req.params.c) });
      res.json(await reportDecide(req.user, req.params.c, { action: String(b.action || ""), tell: b.tell !== false, why: b.why }));
    } catch (e) { fail(res, e); }
  });
  // the per-login tool: the key in the body (POST /api/admin/chatlog/who) keeps names out of URL logs. CL6 fix-up: the spec's
  // /who/:key forms put a login in the address (access logs, browser history) and a look now needs its reason - they answer
  // 400 use_body (staff only: anyone else gets the usual 401 / 403), never a lookup
  const who = async (req, res, key, body) => {
    head(res);
    try { res.json(await whoAction(req.user, key, { action: String(body.action || "look"), why: body.why })); } catch (e) { fail(res, e); }
  };
  const byPath = async (req, res) => {
    head(res);
    try { await mustStaff(req.user); } catch (e) { return fail(res, e); }
    res.status(400).json({ ok: false, code: "use_body", error: "Send the login in the body: POST /api/admin/chatlog/who {key, action, why}." });
  };
  app.post("/api/admin/chatlog/who", addUser, json, async (req, res) => { if (!sameOrigin(req, res)) return; await who(req, res, (req.body || {}).key, req.body || {}); });
  app.get("/api/admin/chatlog/who/:key", addUser, byPath);
  app.post("/api/admin/chatlog/who/:key", addUser, byPath);
  const roomOp = (path, fn) => app.post(`/api/admin/chatlog/room/:rk/${path}`, addUser, json, async (req, res) => {
    head(res);
    if (!sameOrigin(req, res)) return;
    try { res.json(await fn(req.user, req.params.rk, req.body || {})); } catch (e) { fail(res, e); }
  });
  roomOp("hold", (u, rk, b) => roomHold(u, rk, { on: true, why: b.why }));
  roomOp("unhold", (u, rk, b) => roomHold(u, rk, { on: false, why: b.why }));
  roomOp("grant", (u, rk, b) => ownerGrant(u, rk, { on: true, why: b.why }));
  roomOp("ungrant", (u, rk, b) => ownerGrant(u, rk, { on: false, why: b.why }));
}

module.exports = {
  init, register, start, actsFor, report, removeMine, hide, unhide, purge, purgeRows, removeAccountLines, removedFor, removedRead, removedWho, rmNames, reportQueue, reportRead, reportDecide,
  resolveKeys, whoAction, roomHold, ownerGrant, adminView, nightly, isHeld, heldRooms, heldWho, loadHolds, Refuse, reachable,
  KEEP_RM_MS, UNHIDE_MS, VIEWS_KEEP_MS, REPORTS_PER_HOUR, ACT_PER_MIN, READ_ALL, REASONS, ADMIN_ONLY, URGENT, LABELS, REMOVED_MAX, BATCH, EXPORT_MAX,
  NOTE_MAX, WHY_MAX, QUEUE_ACTIONS, WHO_ACTIONS, DUE_SQL, STAFF_ACTOR,
  // CL6 fix-up: the rest of the feed's report rules, the queue's shape, the people list's cap
  NEW_REPORTS_PER_HOUR, REPORTS_PER_DAY, REPORT_GAP_MS, REPORTS_KEEP_MS, QUEUE_LINES, QUEUE_PER_LINE, REMOVED_WHO_MAX, CLIP_AFTER_MS,
  // S1 V4 fix-up: "Also remove my public messages" - D10's report bounds and the nightly's part for the lines held then
  eraseWaitPass, reportHoldUntil, REPORT_HOLD_DECIDED_MS, REPORT_HOLD_UNDECIDED_MS,
  _reset: () => HITS.clear(),
};
