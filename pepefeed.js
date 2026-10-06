// pepefeed.js — Pepe on the feed (1.99cg): he answers when he's mentioned and, where it's switched on,
// takes part on his own (comments on fresh posts, an occasional post of his own), always inside limits.
//
// Who he is here: ONE site account, userId feedstore.PEPE_ID ("pepe-bot"), display name "Pepe", class "Bot",
// an unusable password (nobody can sign in as him). Created on first use (ensureAccount). His posts and
// comments go through feedstore.create / feedstore.comment like everyone's (same visibility, reports,
// deletes), are marked with a "🤖 Pepe" badge and his avatar (authors() -> author.bot), never carry the
// author's automatic upvote, and he never votes - so nothing of his counts in the rankings; users' votes
// rank his posts like anyone's.
//
// Settings, per scope ('' = "All": the site-wide settings admins set, else a room id; feed_kv "pepe:scope:<id>").
// 1.99ci (communities only): there's no main feed. Every post lives in a community, so Pepe always acts in a room
// scope; a house-run community (Pepe's rooms, the PATV Lounge) with no settings of its own follows the All
// settings. His own posts with scope '' go to the PATV Lounge (rooms.LOUNGE_ID). Owners' rooms stay opt-in.
//   respond         answer mentions ("@pepe", "pepe" as a word, a reply to his post / comment). Default ON for
//                   All and the house communities (Pepe's rooms, the Lounge), OFF elsewhere until the owner turns it on
//   auto            take part on his own. Default OFF
//   posts_per_day   his own posts in this scope per 24 h (auto)
//   comments_per_day his comments in this scope per 24 h (mentions + auto)
//   max_depth       his comments within ONE conversation (a top-level comment + its replies) - stops trolls
//   gap_min         minutes between two auto actions in this scope (mention replies use the global reply_gap_secs)
//   quiet_start / quiet_end   hours (America/New_York, 0-23, -1 = none) with no auto activity (mentions still answered)
//   vision          let him look at a post's pictures (an extra model call per picture)
//   admin_lock      an admin froze these settings: the room owner sees them but can't change them
// Global caps (feed_kv "pepe:global", admins only) override every scope: enabled (master switch), posts_per_day,
// comments_per_day (all scopes together), llm_budget_usd (what Pepe reports spending on feed calls per 24 h),
// reply_gap_secs, writes_per_min.
// "Per day" is a rolling 24 hours everywhere. Every limit is enforced HERE (server side) on each write, and Pepe
// checks the same numbers before he spends anything on the model.
//
// Never: NSFW posts (author flag, admin flag, or a room's NSFW mark), hidden / pending / locked / deleted posts,
// posts or comments with open reports, posts muted for him ("Mute Pepe in this thread": the post's author, its
// rooms' owners, staff), authors who are feed-banned (whole feed or that room) or restricted by Pepe, his own
// content. Mentions come before auto activity.
//
// Bot API (bot token: X-Bot-Token header or the body's "password"; he can only act as himself - no field picks
// an author):  POST /api/pepe/feed/sync   settings + usage + work (mentions, candidate threads, room snaps)
//              POST /api/pepe/feed/comment {target, post, parent, body, scope, why, cost}
//              POST /api/pepe/feed/post    {scope, title, body, kind, cost}
//              POST /api/pepe/feed/skip    {target, why, cost}
// Every action (and every refusal / skip / mute / settings change) is one row in pepe_feed_log, shown with links
// on /feed/admin. Posts and comments also get the usual content_audit row, marked bot = 1.
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");
const store = require("./feedstore");
const rooms = require("./rooms");
const audit = require("./contentaudit");

const PEPE_ID = store.PEPE_ID;
const DAY = 86400e3;
let NOW = () => Date.now();
function _setClock(fn) { NOW = fn; }

const SCOPE_DEFAULTS = Object.freeze({ auto: false, posts_per_day: 1, comments_per_day: 10, max_depth: 3, gap_min: 30,
                                       quiet_start: -1, quiet_end: -1, vision: false, admin_lock: false });
const SCOPE_LIMITS = { posts_per_day: [0, 20], comments_per_day: [0, 200], max_depth: [1, 20], gap_min: [0, 1440], quiet_start: [-1, 23], quiet_end: [-1, 23] };
const GLOBAL_DEFAULTS = Object.freeze({ enabled: true, posts_per_day: 6, comments_per_day: 40, llm_budget_usd: 0.5, reply_gap_secs: 20, writes_per_min: 6 });
const GLOBAL_LIMITS = { posts_per_day: [0, 100], comments_per_day: [0, 1000], llm_budget_usd: [0, 100], reply_gap_secs: [0, 3600], writes_per_min: [1, 60] };
const KINDS = Object.freeze(["recap", "question", "dj", "news", "snaps"]);
const TZ = "America/New_York";
const MENTION_WINDOW = 2 * DAY, AUTO_WINDOW = DAY;

class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }

// ── setup ──
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await store.init();
      await runQuery(`CREATE TABLE IF NOT EXISTS pepe_feed_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL, why TEXT,
        scope TEXT NOT NULL DEFAULT '', post_id TEXT, comment_id TEXT, target TEXT, kind TEXT, cost REAL NOT NULL DEFAULT 0, note TEXT, by TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS pepe_feed_log_at ON pepe_feed_log (at)");
      await runQuery("CREATE INDEX IF NOT EXISTS pepe_feed_log_scope ON pepe_feed_log (scope, at)");
      await runQuery("CREATE TABLE IF NOT EXISTS pepe_feed_seen (target TEXT PRIMARY KEY, at INTEGER NOT NULL, outcome TEXT, offers INTEGER NOT NULL DEFAULT 0)");
      await runQuery("CREATE TABLE IF NOT EXISTS pepe_feed_mutes (post_id TEXT PRIMARY KEY, by TEXT, at INTEGER)");
    })().catch((e) => { console.error("[pepefeed] init:", e.message); ready = null; throw e; });
  }
  return ready;
}

/** Pepe's site account (created once). -> {userId, username, display} */
let ACCOUNT = null;
async function ensureAccount() {
  await init();
  if (ACCOUNT) return ACCOUNT;
  let row = (await getQuery("SELECT userId, username, displayname FROM users WHERE userId = ?", [PEPE_ID]))[0];
  if (!row) {
    let name = null;
    for (const n of ["Pepe", "PepeFrog", "PepeBot", "PepeBot_" + crypto.randomBytes(3).toString("hex")]) {
      if (!(await getQuery("SELECT 1 FROM users WHERE LOWER(username) = LOWER(?) LIMIT 1", [n]))[0]) { name = n; break; }
    }
    let pw = "!" + crypto.randomBytes(32).toString("hex");          // never a valid hash: nobody signs in as Pepe
    try { pw = await require("bcrypt").hash(crypto.randomBytes(32).toString("hex"), 10); } catch (e) { /* the "!" one */ }
    await runQuery("INSERT OR IGNORE INTO users (userId, username, displayname, password, class) VALUES (?, ?, ?, ?, 'Bot')", [PEPE_ID, name, "Pepe", pw]);
    console.log(`[pepefeed] created Pepe's site account (${name})`);
    row = (await getQuery("SELECT userId, username, displayname FROM users WHERE userId = ?", [PEPE_ID]))[0];
  }
  ACCOUNT = { userId: row.userId, username: row.username, display: row.displayname || "Pepe" };
  return ACCOUNT;
}

// ── settings ──
const bool = (v) => v === true || v === 1 || v === "1" || v === "on" || v === "true";
function clampInt(v, [lo, hi], d) {
  if (v == null || v === "") return d;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
}
function cleanScope(c) {
  const o = { ...SCOPE_DEFAULTS };
  c = c || {};
  for (const k of Object.keys(SCOPE_LIMITS)) o[k] = clampInt(c[k], SCOPE_LIMITS[k], SCOPE_DEFAULTS[k]);
  for (const k of ["auto", "vision", "admin_lock"]) if (c[k] != null) o[k] = bool(c[k]);
  if (c.respond != null) o.respond = bool(c.respond);      // unset = the scope's default (respondDefault)
  return o;
}
function cleanGlobal(c) {
  const o = { ...GLOBAL_DEFAULTS };
  c = c || {};
  for (const k of ["posts_per_day", "comments_per_day", "reply_gap_secs", "writes_per_min"]) o[k] = clampInt(c[k], GLOBAL_LIMITS[k], GLOBAL_DEFAULTS[k]);
  if (c.llm_budget_usd != null && c.llm_budget_usd !== "") {
    const n = Number(c.llm_budget_usd);
    if (Number.isFinite(n)) o.llm_budget_usd = Math.round(Math.min(100, Math.max(0, n)) * 100) / 100;
  }
  if (c.enabled != null) o.enabled = bool(c.enabled);
  return o;
}
/** Mentions are answered by default under All and in the house communities. */
function respondDefault(scope) {
  if (!scope) return true;
  const R = rooms.getCached(scope);
  return !!(R && R.house);
}
async function readJson(key) {
  try { return JSON.parse((await store.kvGet(key)) || "null"); } catch (e) { return null; }
}
async function scopeSettings(scope) {
  await init();
  const own = await readJson("pepe:scope:" + (scope || ""));
  // 1.99ci: a house community without settings of its own follows All (the admins' site-wide settings)
  if (scope && own == null) {
    const R = rooms.getCached(scope);
    if (R && R.house) return { ...(await scopeSettings("")), inherited: true };
  }
  const s = cleanScope(own);
  if (s.respond == null) s.respond = respondDefault(scope);
  return s;
}
async function globalCaps() { await init(); return cleanGlobal(await readJson("pepe:global")); }

const isAdmin = (u) => !!u && u.class === "Admin";
/**
 * Change one scope's settings. All (''): site Admins. A room: its owner (unless an admin locked it) or an
 * Admin; only an Admin can set admin_lock. -> the new settings
 */
async function setScope(user, scope, patch) {
  await init();
  scope = String(scope || "");
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const admin = isAdmin(user);
  if (!scope) { if (!admin) throw new Refuse(403, "Only site admins set Pepe's settings for All."); }
  else {
    if (!(await rooms.get(scope))) throw new Refuse(404, "No such pad.");
    if (!admin && !(await rooms.canManage(user, scope))) throw new Refuse(403, "Only this pad's owner can do that.");
  }
  const cur = cleanScope(await readJson("pepe:scope:" + scope));
  if (cur.admin_lock && !admin) throw new Refuse(403, "A site admin has locked Pepe's settings for this pad.");
  const p = { ...(patch || {}) };
  if (!admin) delete p.admin_lock;
  const next = cleanScope({ ...cur, ...p });
  await store.kvSet("pepe:scope:" + scope, JSON.stringify(next));
  await log({ action: "settings", scope, by: user.username, note: JSON.stringify(next).slice(0, 400) });
  if (scope) await rooms.event(scope, "feed-pepe", user.username, JSON.stringify(next)).catch(() => {});
  return scopeSettings(scope);
}
async function setGlobal(user, patch) {
  if (!isAdmin(user)) throw new Refuse(403, "Admins only.");
  await init();
  const next = cleanGlobal({ ...(await globalCaps()), ...(patch || {}) });
  await store.kvSet("pepe:global", JSON.stringify(next));
  await log({ action: "settings", scope: "*", by: user.username, note: JSON.stringify(next).slice(0, 400) });
  return next;
}

// ── the log ──
async function log({ action, why = null, scope = "", post = null, comment = null, target = null, kind = null, cost = 0, note = null, by = null }) {
  await init();
  const c = Number(cost);
  await runQuery(`INSERT INTO pepe_feed_log (at, action, why, scope, post_id, comment_id, target, kind, cost, note, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                 [NOW(), action, why, scope || "", post, comment, target, kind, Number.isFinite(c) && c > 0 ? Math.min(c, 10) : 0,
                  note == null ? null : String(note).slice(0, 400), by]);
}
async function markSeen(target, outcome) {
  if (!target) return;
  await runQuery(`INSERT INTO pepe_feed_seen (target, at, outcome, offers) VALUES (?, ?, ?, 0)
                  ON CONFLICT(target) DO UPDATE SET at = excluded.at, outcome = excluded.outcome`, [String(target).slice(0, 40), NOW(), outcome]);
}
async function seenMap(targets) {
  if (!targets.length) return new Map();
  const rows = await getQuery(`SELECT * FROM pepe_feed_seen WHERE target IN (${targets.map(() => "?").join(",")})`, targets);
  return new Map(rows.map((r) => [r.target, r]));
}

/** Rolling-24 h usage: {posts, comments, cost, byScope: {scope: {posts, comments, last, lastAuto}}} */
async function usage(t = NOW()) {
  await init();
  const rows = await getQuery(`SELECT scope, action, why, COUNT(*) AS n, MAX(at) AS last FROM pepe_feed_log WHERE at > ? AND action IN ('post','comment')
                               GROUP BY scope, action, why`, [t - DAY]);
  const cost = (await getQuery("SELECT COALESCE(SUM(cost), 0) AS c FROM pepe_feed_log WHERE at > ?", [t - DAY]))[0].c;
  const out = { posts: 0, comments: 0, cost: Math.round(cost * 1e6) / 1e6, byScope: {} };
  const lastAny = (await getQuery("SELECT MAX(at) AS last FROM pepe_feed_log WHERE action IN ('post','comment')"))[0].last || 0;
  out.last = lastAny;
  for (const r of rows) {
    const s = out.byScope[r.scope] || (out.byScope[r.scope] = { posts: 0, comments: 0, last: 0, lastAuto: 0 });
    if (r.action === "post") { s.posts += r.n; out.posts += r.n; } else { s.comments += r.n; out.comments += r.n; }
    s.last = Math.max(s.last, r.last || 0);
    if (r.why === "auto") s.lastAuto = Math.max(s.lastAuto, r.last || 0);
  }
  return out;
}
const scopeUse = (U, scope) => U.byScope[scope || ""] || { posts: 0, comments: 0, last: 0, lastAuto: 0 };

/** The hour (0-23) in Pepe's timezone. */
function localHour(t = NOW()) {
  try { return Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", hourCycle: "h23" }).format(new Date(t))) % 24; }
  catch (e) { return new Date(t).getUTCHours(); }
}
/** Inside the scope's quiet hours? (start == end or either -1 = none; wraps past midnight) */
function quietNow(S, t = NOW()) {
  const a = S.quiet_start, b = S.quiet_end;
  if (a == null || b == null || a < 0 || b < 0 || a === b) return false;
  const h = localHour(t);
  return a < b ? h >= a && h < b : h >= a || h < b;
}

/**
 * Every limit for one write. what: "post" | "comment"; why: "mention" | "auto". -> null (ok) or the reason.
 * S: the scope's settings, G: global caps, U: usage(), depth: Pepe's comments in the conversation so far.
 */
function gate(what, why, S, G, U, { scope = "", depth = 0, cost = 0, t = NOW() } = {}) {
  if (!G.enabled) return "Pepe is switched off on the feed";
  const su = scopeUse(U, scope);
  // the model call for this write has already happened (cost): refuse only once the day's spend was used up BEFORE it
  if (U.cost >= G.llm_budget_usd) return "today's feed LLM budget is spent";
  void cost;
  if (what === "post") {
    if (why !== "auto" || !S.auto) return "auto posting is off here";
    if (U.posts >= G.posts_per_day) return "the global post cap for today is reached";
    if (su.posts >= S.posts_per_day) return "this scope's post limit for today is reached";
  } else {
    if (why === "auto" ? !S.auto : !S.respond) return why === "auto" ? "auto comments are off here" : "mention replies are off here";
    if (U.comments >= G.comments_per_day) return "the global comment cap for today is reached";
    if (su.comments >= S.comments_per_day) return "this scope's comment limit for today is reached";
    if (depth >= S.max_depth) return "the back-and-forth limit for this thread is reached";
  }
  if (why === "auto") {
    if (quietNow(S, t)) return "quiet hours";
    if (su.last && t - su.last < S.gap_min * 60e3) return "too soon after his last action here";
  } else if (U.last && t - U.last < G.reply_gap_secs * 1000) {
    return "too soon after his last action";
  }
  return null;
}

// ── who / what he may answer ──
const MENTION_RE = /(^|[^\w@])@?pepe(?![\w])/i;
/** "@pepe", "pepe" as a word, or "@<his username>". */
function mentions(text, username = null) {
  const s = String(text || "");
  if (MENTION_RE.test(s)) return true;
  if (username) {
    const esc = String(username).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp("(^|[^\\w])@" + esc + "(?![\\w])", "i").test(s)) return true;
  }
  return false;
}

async function isMuted(postId) {
  await init();
  return !!(await getQuery("SELECT 1 FROM pepe_feed_mutes WHERE post_id = ?", [String(postId || "")]))[0];
}
/** "Mute Pepe in this thread": the post's author, its rooms' owners, staff. */
async function setMute(user, postId, on) {
  await init();
  const r = await store.getRow(postId);
  if (!r || r.deleted_at) throw new Refuse(404, "No such post.");
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  let ok = user.userId === r.author_id || store.isStaff(user);
  if (!ok) for (const x of await getQuery("SELECT room_id FROM feed_post_rooms WHERE post_id = ? AND removed_at IS NULL", [r.id])) {
    if (await rooms.canManage(user, x.room_id)) { ok = true; break; }
  }
  if (!ok) throw new Refuse(403, "Only the post's author, its pads' owners and admins can do that.");
  if (on) await runQuery("INSERT OR REPLACE INTO pepe_feed_mutes (post_id, by, at) VALUES (?, ?, ?)", [r.id, user.username, NOW()]);
  else await runQuery("DELETE FROM pepe_feed_mutes WHERE post_id = ?", [r.id]);
  await log({ action: on ? "mute" : "unmute", post: r.id, by: user.username });
  return !!on;
}

async function banned(userId, scope) {
  const t = NOW();
  return !!(await getQuery("SELECT 1 FROM feed_bans WHERE user_id = ? AND (room_id = '' OR room_id = ?) AND (until IS NULL OR until > ?) LIMIT 1", [userId, scope || "", t]))[0];
}
async function restricted(login, scope) {
  if (!login) return false;
  return !!(await getQuery("SELECT 1 FROM feed_restricted WHERE login = ? AND (room_id = '' OR room_id = ?) AND (until IS NULL OR until > ?) LIMIT 1",
                           [String(login).toLowerCase(), scope || "", NOW()]))[0];
}
/** null when Pepe may answer this author in this scope. */
async function authorRefusal(userId, scope) {
  if (!userId || userId === PEPE_ID) return "his own";
  const a = await store.account(userId);
  if (!a) return "account gone";
  if (a.archived_at) return "archived account";
  if (a.casino_banned) return "restricted account";
  if (await banned(userId, scope)) return "author is feed-banned";
  if (await restricted(a.camfrogUsername, scope)) return "author is restricted by Pepe";
  return null;
}

/**
 * Where a post lives, as scopes Pepe could act in: room placements that are live (not removed / pending /
 * hidden) - 1.99ci: every post lives in a community, there's no main-feed scope any more. null when the post is off-limits everywhere (deleted, hidden, NSFW anywhere,
 * locked, muted, reported).
 */
async function postScopes(p) {
  if (!p || p.deleted_at || p.hidden_at || p.locked_at || p.author_id === PEPE_ID) return null;
  if (store.effNsfw(p)) return null;
  const pl = await getQuery("SELECT * FROM feed_post_rooms WHERE post_id = ?", [p.id]);
  if (pl.some((x) => x.nsfw === 1)) return null;                                        // a room owner's NSFW mark
  if (await isMuted(p.id)) return null;
  if ((await getQuery("SELECT 1 FROM feed_reports WHERE post_id = ? AND comment_id IS NULL AND resolved_at IS NULL LIMIT 1", [p.id]))[0]) return null;
  // 1.99ci: a house community (Pepe's rooms, the PATV Lounge) with no settings of its own is the All scope ('')
  const out = [];
  for (const x of pl.filter((y) => !y.removed_at && !y.pending && !y.hidden_at)) {
    const R = rooms.getCached(x.room_id);
    const sc = R && R.house && (await readJson("pepe:scope:" + x.room_id)) == null ? "" : x.room_id;
    if (!out.includes(sc)) out.push(sc);
  }
  return out.length ? out : null;
}

const SITE = () => process.env.SITE_URL || (process.env.STAGING ? "https://staging.publicaccess.tv" : "https://publicaccess.tv");
/** The post as Pepe reads it (no NSFW ever gets here). */
async function postView(p) {
  const A = await store.account(p.author_id);
  const att = await getQuery("SELECT kind, file, thumb, w, h FROM feed_attachments WHERE post_id = ? AND state = 'ready' ORDER BY sort", [p.id]);
  let link = null;
  try { link = p.link_json ? JSON.parse(p.link_json) : null; } catch (e) { link = null; }
  return {
    id: p.id, url: SITE() + "/feed/p/" + p.id, title: p.title || "", body: String(p.body || "").slice(0, 2000), created: p.created,
    author: who(A, p.author_id),
    link: link && link.url ? { url: link.url, domain: link.domain || "", title: link.title || "", description: link.description || "", site: link.site || "" } : null,
    images: att.filter((a) => a.kind === "image").slice(0, 4).map((a) => ({ url: SITE() + "/feed/f/" + (a.thumb || a.file), w: a.w, h: a.h })),
    media: { audio: att.filter((a) => a.kind === "audio").length, video: att.filter((a) => a.kind === "video").length },
    comments: p.comments || 0, score: p.score || 0,
  };
}
function who(A, userId) {
  if (userId === PEPE_ID) return { display: "Pepe", login: null, pepe: true };
  if (!A) return { display: "[deleted account]", login: null, pepe: false };
  return { display: A.displayname || A.username, username: A.username, login: A.camfrogUsername ? String(A.camfrogUsername).toLowerCase() : null, pepe: false };
}
/** The conversation around a comment (its top-level comment + replies, oldest first, live ones). */
async function conversation(postId, top) {
  const rows = await getQuery(`SELECT * FROM feed_comments WHERE post_id = ? AND (id = ? OR parent_id = ?) AND deleted_at IS NULL AND hidden_at IS NULL ORDER BY created`, [postId, top, top]);
  const out = [];
  for (const c of rows.slice(-14)) out.push({ id: c.id, author: who(await store.account(c.author_id), c.author_id), body: String(c.body).slice(0, 800), created: c.created });
  return out;
}
async function depthOf(postId, top) {
  if (!top) return 0;
  return (await getQuery("SELECT COUNT(*) AS n FROM feed_comments WHERE post_id = ? AND (id = ? OR parent_id = ?) AND author_id = ?", [postId, top, top, PEPE_ID]))[0].n;
}

/**
 * New mentions in scopes where he answers them: [{target, why: "mention", scope, post, parent, reply_to, thread, depth, max_depth}].
 * Off-limits ones are marked seen (with why) so they're never offered again.
 */
async function findMentions(acct, t = NOW()) {
  const out = [];
  const since = t - MENTION_WINDOW;
  // comments: a word mention, a reply to Pepe's comment, or a top-level comment on Pepe's post
  // prev_author: who wrote the comment just before this one in its conversation (replies are one level deep, so
  // answering Pepe's reply inside someone else's thread is a reply to the thread's top - this catches it)
  const cs = await getQuery(`SELECT c.*, par.author_id AS par_author, p.author_id AS post_author,
                             (SELECT x.author_id FROM feed_comments x WHERE x.post_id = c.post_id AND (x.id = COALESCE(c.parent_id, c.id) OR x.parent_id = COALESCE(c.parent_id, c.id))
                                AND x.created < c.created AND x.deleted_at IS NULL ORDER BY x.created DESC LIMIT 1) AS prev_author
                             FROM feed_comments c
                             JOIN feed_posts p ON p.id = c.post_id LEFT JOIN feed_comments par ON par.id = c.parent_id
                             WHERE c.created > ? AND c.author_id != ? AND c.deleted_at IS NULL AND c.hidden_at IS NULL ORDER BY c.created LIMIT 400`, [since, PEPE_ID]);
  const ps = await getQuery("SELECT * FROM feed_posts WHERE created > ? AND author_id != ? AND deleted_at IS NULL ORDER BY created LIMIT 200", [since, PEPE_ID]);
  const cand = [];
  for (const c of cs) {
    const hit = mentions(c.body, acct.username) || c.par_author === PEPE_ID || (!c.parent_id && c.post_author === PEPE_ID)
      || (c.parent_id && c.prev_author === PEPE_ID);
    if (!hit) continue;
    // a reply to Pepe that comes AFTER a later Pepe reply in the same conversation is still a mention (he answers
    // the newest), but anything he already answered is in pepe_feed_seen
    cand.push({ target: "c:" + c.id, c });
  }
  for (const p of ps) if (mentions((p.title || "") + "\n" + (p.body || ""), acct.username)) cand.push({ target: "p:" + p.id, p });
  const seen = await seenMap(cand.map((x) => x.target));
  for (const x of cand) {
    if (seen.has(x.target)) continue;
    const p = x.p || await store.getRow(x.c.post_id);
    const scopes = await postScopes(p);
    const skip = async (why) => { await markSeen(x.target, "skip:" + why); };
    if (!scopes) { await skip("post off-limits"); continue; }
    let scope = null;
    for (const s of scopes) if ((await scopeSettings(s)).respond) { scope = s; break; }
    if (scope === null) { await skip("mentions off"); continue; }
    if (x.c && (await getQuery("SELECT 1 FROM feed_reports WHERE comment_id = ? AND resolved_at IS NULL LIMIT 1", [x.c.id]))[0]) { await skip("comment reported"); continue; }
    const ar = await authorRefusal(x.c ? x.c.author_id : p.author_id, scope);
    if (ar) { await skip(ar); continue; }
    const S = await scopeSettings(scope);
    const top = x.c ? (x.c.parent_id || x.c.id) : null;
    const depth = await depthOf(p.id, top);
    if (depth >= S.max_depth) { await skip("depth"); await log({ action: "refused", why: "mention", scope, post: p.id, comment: x.c ? x.c.id : null, target: x.target, note: "back-and-forth limit reached" }); continue; }
    const post = await postView(p);
    out.push({
      target: x.target, why: "mention", scope, post, parent: top, depth, max_depth: S.max_depth, vision: S.vision,
      reply_to: x.c ? { id: x.c.id, body: String(x.c.body).slice(0, 800), author: who(await store.account(x.c.author_id), x.c.author_id) } : null,
      thread: x.c ? await conversation(p.id, top) : [],
      created: x.c ? x.c.created : p.created,
    });
    if (out.length >= 10) break;
  }
  return out;
}

/** Fresh posts he could comment on by himself (auto scopes), best first, ones he hasn't touched. */
async function findThreads(autoScopes, t = NOW()) {
  if (!autoScopes.length) return [];
  const rows = await getQuery(`SELECT p.* FROM feed_posts p WHERE p.created > ? AND p.author_id != ? AND p.deleted_at IS NULL AND p.hidden_at IS NULL
                               AND NOT EXISTS (SELECT 1 FROM feed_comments c WHERE c.post_id = p.id AND c.author_id = ?)
                               ORDER BY p.hot DESC, p.created DESC LIMIT 60`, [t - AUTO_WINDOW, PEPE_ID, PEPE_ID]);
  const seen = await seenMap(rows.map((p) => "a:" + p.id));
  const out = [];
  for (const p of rows) {
    if (seen.has("a:" + p.id)) continue;                          // he commented, passed, or was refused
    const scopes = await postScopes(p);
    if (!scopes) continue;
    const scope = scopes.find((s) => autoScopes.includes(s));
    if (scope === undefined) continue;
    if (await authorRefusal(p.author_id, scope)) continue;
    const S = await scopeSettings(scope);
    const top = await getQuery(`SELECT * FROM feed_comments WHERE post_id = ? AND parent_id IS NULL AND deleted_at IS NULL AND hidden_at IS NULL ORDER BY score DESC, created LIMIT 6`, [p.id]);
    const thread = [];
    for (const c of top) thread.push({ id: c.id, author: who(await store.account(c.author_id), c.author_id), body: String(c.body).slice(0, 500), created: c.created });
    out.push({ target: "a:" + p.id, why: "auto", scope, post: await postView(p), parent: null, depth: 0, max_depth: S.max_depth, vision: S.vision, thread, created: p.created });
    if (out.length >= 5) break;
  }
  return out;
}

/** Every scope with something switched on (+ All always), with its settings and usage. */
async function scopesState(U) {
  const ids = [""];
  for (const r of await rooms.list()) ids.push(r.id);
  const out = {};
  for (const id of ids) {
    const S = await scopeSettings(id);
    if (id && !S.respond && !S.auto) continue;
    const R = id ? rooms.getCached(id) : null;
    out[id] = { ...S, title: id ? (R ? R.title : id) : "All (site-wide)", slug: R ? R.slug : null, house: !!(R && R.house),
                url: SITE() + (R ? "/p/" + encodeURIComponent(R.slug) : "/feed"),
                quiet: quietNow(S), used: scopeUse(U, id) };
  }
  return out;
}

/** The bot's sync. body: {} -> {account, global, used, scopes, mentions, threads, snaps, lastKinds} */
async function sync(body = {}) {
  await init();
  const acct = await ensureAccount();
  const G = await globalCaps();
  const U = await usage();
  const scopes = await scopesState(U);
  const res = { ok: true, account: acct, global: G, used: { posts: U.posts, comments: U.comments, cost: U.cost, last: U.last }, scopes,
                mentions: [], threads: [], snaps: {}, lastKinds: {}, now: NOW() };
  if (!G.enabled) return res;
  res.mentions = await findMentions(acct);
  const autoScopes = Object.keys(scopes).filter((k) => scopes[k].auto);
  res.threads = await findThreads(autoScopes);
  // his last post of each kind per scope (a week back), so he spaces recaps / questions / news
  for (const r of await getQuery("SELECT scope, kind, MAX(at) AS at FROM pepe_feed_log WHERE action = 'post' AND at > ? GROUP BY scope, kind", [NOW() - 7 * DAY])) {
    (res.lastKinds[r.scope] = res.lastKinds[r.scope] || {})[r.kind || "other"] = r.at;
  }
  // the day's captures per auto room (stories.js: opted-out subjects are already null)
  for (const id of autoScopes) {
    if (!id) continue;
    try {
      const caps = await require("./stories").captures(id, 12, { windowMs: DAY });
      if (caps.length) res.snaps[id] = caps.map((c) => ({ kind: c.kind, subject: c.subject || null, at: c.created, page: SITE() + c.page }));
    } catch (e) { /* none */ }
  }
  void body;
  return res;
}

// ── writes ──
const writeLog = [];
function writeRate(G) {
  const t = NOW();
  while (writeLog.length && t - writeLog[0] > 60e3) writeLog.shift();
  if (writeLog.length >= G.writes_per_min) return true;
  writeLog.push(t);
  return false;
}
// his content_audit rows: marked bot, no network data (the request comes from Pepe's own server, not a person)
const auditCtx = () => ({ via: "bot", bot: true });

/** Pepe comments. {target, post, parent, body, scope, why: mention|auto, cost} -> {ok, id, url} */
async function comment(b, req = null) {
  await init();
  const acct = await ensureAccount();
  const G = await globalCaps();
  const why = b.why === "auto" ? "auto" : "mention";
  const postId = String(b.post || "");
  const p = await store.getRow(postId);
  if (!p) throw new Refuse(404, "No such post.");
  const scope = String(b.scope || "");
  const scopes = await postScopes(p);
  const refuse = async (st, msg) => {
    await log({ action: "refused", why, scope, post: postId, target: b.target || null, cost: b.cost, note: msg });
    if (b.target) await markSeen(b.target, "refused:" + msg);
    throw new Refuse(st, msg);
  };
  if (!scopes || !scopes.includes(scope)) await refuse(409, "That post is off-limits for Pepe here.");
  let parent = null;
  if (b.parent) {
    parent = (await getQuery("SELECT * FROM feed_comments WHERE id = ? AND post_id = ?", [String(b.parent), postId]))[0];
    if (!parent || parent.deleted_at || parent.hidden_at) await refuse(404, "That comment is gone.");
    if (parent.parent_id) parent = (await getQuery("SELECT * FROM feed_comments WHERE id = ?", [parent.parent_id]))[0] || parent;
    if ((await getQuery("SELECT 1 FROM feed_reports WHERE comment_id = ? AND resolved_at IS NULL LIMIT 1", [parent.id]))[0]) await refuse(409, "That comment is reported.");
    if (parent.author_id !== PEPE_ID && (await authorRefusal(parent.author_id, scope))) await refuse(409, await authorRefusal(parent.author_id, scope));
  }
  // the comment he's answering (a reply inside the conversation) must be answerable too
  if (b.target && /^c:/.test(b.target)) {
    const tc = (await getQuery("SELECT * FROM feed_comments WHERE id = ?", [String(b.target).slice(2)]))[0];
    if (!tc || tc.deleted_at || tc.hidden_at) await refuse(404, "That comment is gone.");
    const ar = await authorRefusal(tc.author_id, scope);
    if (ar) await refuse(409, ar);
  } else if (await authorRefusal(p.author_id, scope)) await refuse(409, await authorRefusal(p.author_id, scope));
  const S = await scopeSettings(scope);
  const U = await usage();
  const depth = await depthOf(postId, parent ? parent.id : null);
  const no = gate("comment", why, S, G, U, { scope, depth: parent ? depth : 0, cost: b.cost });
  if (no) await refuse(429, no);
  if (writeRate(G)) await refuse(429, "too many writes this minute");
  const text = String(b.body || "").trim();
  if (!text) await refuse(400, "Empty comment.");
  const r = await store.comment({ userId: acct.userId }, postId, { body: text.slice(0, 1500), parent: parent ? parent.id : null });
  await audit.record(auditCtx(), { kind: "comment", id: r.id, postId, event: "create", user: await store.account(acct.userId) });
  await log({ action: "comment", why, scope, post: postId, comment: r.id, target: b.target || null, cost: b.cost, note: b.model || null });
  if (b.target) await markSeen(b.target, "answered");
  return { ok: true, id: r.id, url: "/feed/p/" + postId + "#c-" + r.id };
}

/** Pepe posts on his own. {scope, title, body, kind, cost} -> {ok, id, url} */
async function post(b, req = null) {
  await init();
  const acct = await ensureAccount();
  const G = await globalCaps();
  const scope = String(b.scope || "");
  const kind = KINDS.includes(b.kind) ? b.kind : "other";
  const refuse = async (st, msg) => { await log({ action: "refused", why: "auto", scope, kind, cost: b.cost, note: msg }); throw new Refuse(st, msg); };
  if (scope && !(await rooms.get(scope))) await refuse(404, "No such pad.");
  // 1.99ci: a post needs a community - his All-scope posts go to the PATV Lounge
  const S = await scopeSettings(scope);
  const no = gate("post", "auto", S, G, await usage(), { scope, cost: b.cost });
  if (no) await refuse(429, no);
  if (writeRate(G)) await refuse(429, "too many writes this minute");
  const title = String(b.title || "").trim(), text = String(b.body || "").trim();
  if (!title && !text) await refuse(400, "Empty post.");
  const p = await store.create(acct.userId, { title: title.slice(0, store.TITLE_MAX), body: text.slice(0, 3000), community: scope || rooms.LOUNGE_ID,
                                              nsfw: false, announce: [] }, {});
  await audit.record(auditCtx(), { kind: "post", id: p.id, postId: p.id, event: "create", user: await store.account(acct.userId) });
  await log({ action: "post", why: "auto", scope, post: p.id, kind, cost: b.cost, note: b.model || null });
  return { ok: true, id: p.id, url: "/feed/p/" + p.id };
}

/** He looked and passed (the model said skip, his own guards said no). The target is never offered again. */
async function skip(b) {
  await init();
  const target = String(b.target || "").slice(0, 40);
  if (!/^[cpa]:[A-Za-z0-9]{6,16}$/.test(target)) throw new Refuse(400, "Bad target.");
  await markSeen(target, "skip:" + String(b.why || "").slice(0, 60));
  const id = target.slice(2);
  await log({ action: "skip", why: String(b.why || "").slice(0, 60) || null, scope: String(b.scope || ""), target,
              post: target[0] === "c" ? ((await getQuery("SELECT post_id FROM feed_comments WHERE id = ?", [id]))[0] || {}).post_id || null : id,
              comment: target[0] === "c" ? id : null, cost: b.cost });
  return { ok: true };
}

/** One scope for its settings card: settings + 24 h usage + quiet now + the global caps. */
async function scopeView(scope) {
  const S = await scopeSettings(scope);
  const U = await usage();
  return { ...S, used: scopeUse(U, scope), quiet: quietNow(S), global: await globalCaps() };
}

// ── admin view ──
async function adminView() {
  await init();
  const acct = await ensureAccount();
  const U = await usage();
  const rows = await getQuery("SELECT * FROM pepe_feed_log ORDER BY id DESC LIMIT 150");
  const titles = new Map();
  const ids = [...new Set(rows.map((r) => r.post_id).filter(Boolean))];
  if (ids.length) for (const p of await getQuery(`SELECT id, title, body, deleted_at FROM feed_posts WHERE id IN (${ids.map(() => "?").join(",")})`, ids)) {
    titles.set(p.id, { t: (p.title || p.body || "").replace(/\s+/g, " ").slice(0, 70), deleted: !!p.deleted_at });
  }
  const cids = [...new Set(rows.map((r) => r.comment_id).filter(Boolean))];
  const cdel = new Set();
  if (cids.length) for (const c of await getQuery(`SELECT id FROM feed_comments WHERE deleted_at IS NOT NULL AND id IN (${cids.map(() => "?").join(",")})`, cids)) cdel.add(c.id);
  const scopeTitle = (s) => (s === "*" ? "global" : !s ? "All" : (rooms.getCached(s) || {}).title || s);
  return {
    account: acct, global: await globalCaps(), main: await scopeSettings(""), used: U,
    rooms: Object.entries(await scopesState(U)).filter(([k]) => k).map(([id, s]) => ({ id, ...s })),
    log: rows.map((r) => ({ ...r, scopeTitle: scopeTitle(r.scope), postTitle: r.post_id ? (titles.get(r.post_id) || {}).t || "" : "",
                            postDeleted: r.post_id ? !!(titles.get(r.post_id) || {}).deleted : false, commentDeleted: r.comment_id ? cdel.has(r.comment_id) : false,
                            href: r.post_id ? "/feed/p/" + r.post_id + (r.comment_id ? "#c-" + r.comment_id : "") : null })),
  };
}

// ── routes ──
function register(app, { addUser, isBotToken }) {
  const bot = (req, res, next) => {
    const tok = req.get("x-bot-token") || (req.body && typeof req.body.password === "string" ? req.body.password : "");
    if (!isBotToken(tok)) return res.status(403).json({ ok: false, error: "unauthorized" });
    next();
  };
  const fail = (res, e) => {
    const st = e && e.status && e.status < 500 ? e.status : 500;
    if (st === 500) console.error("[pepefeed]", e);
    res.status(st).json({ ok: false, error: st === 500 ? "Something went wrong." : e.message });
  };
  const json = require("express").json({ limit: "64kb" });
  app.post("/api/pepe/feed/sync", json, bot, async (req, res) => { try { res.json(await sync(req.body || {})); } catch (e) { fail(res, e); } });
  app.post("/api/pepe/feed/comment", json, bot, async (req, res) => { try { res.json(await comment(req.body || {}, req)); } catch (e) { fail(res, e); } });
  app.post("/api/pepe/feed/post", json, bot, async (req, res) => { try { res.json(await post(req.body || {}, req)); } catch (e) { fail(res, e); } });
  app.post("/api/pepe/feed/skip", json, bot, async (req, res) => { try { res.json(await skip(req.body || {})); } catch (e) { fail(res, e); } });

  // people (signed in, same-site JSON fetch - feedweb's rules)
  const sameSite = (req) => {
    const host = req.get("host"), src = req.get("origin") || req.get("referer");
    if (!src || !host) return true;
    try { return new URL(src).host === host; } catch (e) { return false; }
  };
  const guard = (req, res, next) => {
    if (!sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    next();
  };
  const viewer = async (req) => store.account(req.user.userId);
  app.post("/api/rooms/:slug/feed/pepe", addUser, guard, async (req, res) => {
    try {
      const R = (await rooms.get(String(req.params.slug))) || (await require("./roomsweb").resolveRoom(String(req.params.slug)));
      if (!R) return res.status(404).json({ ok: false, error: "No such pad." });
      res.json({ ok: true, settings: await setScope(await viewer(req), R.id, (req.body || {}).settings) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/feed/admin/pepe", addUser, guard, async (req, res) => {
    try {
      const v = await viewer(req), b = req.body || {};
      if (!isAdmin(v)) return res.status(403).json({ ok: false, error: "Admins only." });
      const out = { ok: true };
      if (b.global) out.global = await setGlobal(v, b.global);
      if (b.main) out.main = await setScope(v, "", b.main);
      res.json(out);
    } catch (e) { fail(res, e); }
  });
  app.post("/api/feed/posts/:id/pepe-mute", addUser, guard, async (req, res) => {
    try { res.json({ ok: true, muted: await setMute(await viewer(req), String(req.params.id), !!(req.body || {}).on) }); } catch (e) { fail(res, e); }
  });
}

module.exports = {
  init, register, ensureAccount, scopeView, sync, comment, post, skip, setScope, setGlobal, scopeSettings, globalCaps, usage, gate, mentions, quietNow, localHour,
  isMuted, setMute, adminView, postScopes, findMentions, findThreads, cleanScope, cleanGlobal, respondDefault,
  SCOPE_DEFAULTS, GLOBAL_DEFAULTS, SCOPE_LIMITS, GLOBAL_LIMITS, KINDS, PEPE_ID, Refuse, _setClock, _writes: writeLog,
  _reset: () => { ACCOUNT = null; },
};
