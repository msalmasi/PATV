// feedstore.js — feed posts, rooms as hubs, votes, comments, reports, feed bans (1.99bv).
//
// Data model (shaped after v2 §10 "Social feed": posts, attachments, votes, comments, rooms as hubs)
//   feed_posts         id (12 chars, random), author_id, title, body (plain text, <= 5000), link_url,
//                      link_json ({url, domain, title, description, site, embed: {p,t,id}|null, thumb}),
//                      nsfw (author flag), nsfw_admin (admin override: null = author's flag, 0/1 = forced),
//                      global (on the main feed), score (cached upvotes), comments (cached count),
//                      cost (PAT paid), created, edited, deleted_at, deleted_by, delete_reason,
//                      hidden_at (auto-hidden by reports, pending review), purged_at
//                      (1.99ci) crosspost_of: the ORIGINAL post's id when this row is a crosspost (no body/files of
//                      its own - it embeds the original; its votes and comments are its own). `global` is no
//                      longer read or written as 1: every post lives in a community (feed_post_rooms); the column
//                      stays so old rows / links keep working, and the communities_v1 migration gave the old
//                      main-feed-only posts a home in the Camfrog Lounge (rooms.LOUNGE_ID).
//                      (1.99ep) home_pad: the pad (rooms_registry id; a profile pad for a profile post) the post was
//                      created in - fixed at creation, never changes, the base of its canonical URL (pads.postHref).
//                      A crosspost is its own row with its own home_pad. Old rows: backfilled from their first placement.
//   feed_post_rooms    post_id, room_id (rooms_registry id), removed_at / removed_by (a room owner
//                      can take a post out of THEIR room without deleting it elsewhere)
//   feed_attachments   id, post_id (NULL until posted), owner_id, kind image|audio|video|preview,
//                      ct, file, thumb, poster, w, h, secs, bytes, sort, state uploading|processing|
//                      ready|failed|deleted|purged, error, created, size_declared, received, sniff
//                      (1.99di) ai_generated, ai_prompt, ai_model, ai_nsfw, ai_hide_prompt, ai_job: a file Pepe generated
//                      (aigen.js) - badge + prompt toggle on the post; ai_nsfw makes the post NSFW
//                      (1.99bx) ups / downs (cached COUNTED votes), score = ups - downs, hot (Reddit hot rank,
//                      indexed), controversy (Reddit's magnitude ** balance) - all rewritten by recountPost
//   feed_votes         post_id, user_id, value +1 / -1 (no row = no vote), w (1 = counts, 0 = a downvote from
//                      an account that can't downvote yet), created, updated - one row per user
//   feed_comment_votes comment_id, post_id, user_id, value, w, created, updated (comments: ups/downs/score)
//   feed_comments      id, post_id, parent_id (one level of replies), author_id, body, created,
//                      edited, deleted_at, deleted_by
//   feed_reports       id, post_id, comment_id, reporter_id, reason, note, created, resolved_at,
//                      resolved_by, action
//   feed_bans          user_id, room_id ('' = the whole feed), reason, by, at, until (NULL = forever)
//   feed_restricted    Camfrog logins Pepe currently refuses (the bridge relay's rules: ignored,
//                      red-list suspended, kicked/banned recently - per room) synced with the owner map
//   feed_mentions      queued "new post on the room feed" lines for Pepe (per-room switch, throttled)
//   feed_kv            config (JSON) and per-room settings
//
// 1.99df: profile posting (Reddit's u/). A member's profile is a pad of its own (rooms.js: platform "profile", id
// user:<userId>, slug u-<username>, made on first use by rooms.ensureProfile) - so votes, comments, crossposts (both
// ways), bans, locks, reports, Padiquette and Pepe's scopes are the pad code unchanged. What's special:
//   - only the profile's owner may post / crosspost there (roomPostRefusal - not even staff);
//   - the composer / crosspost dialog name it "u/<username>" (or "profile"), resolved for the poster here;
//   - feed_posts.in_all: the owner's per-post "Also show in All" (default on); off keeps it out of All (and the
//     homepage's Hot), never out of Following, the profile or the post page;
//   - the owner moderates their profile pad like any pad owner (rooms.canManage): remove comments on posts there,
//     lock comments, ban people from commenting on the profile - nothing anywhere else.
"use strict";
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { runQuery, getQuery } = require("./dbUtils");
const rooms = require("./rooms");
const terms = require("./terms");

// 1.99ci: a post is created in exactly ONE community (Reddit-style); crossposting shares it into others
const TITLE_MAX = 140, BODY_MAX = 5000, COMMENT_MAX = 2000, MAX_IMAGES = 4, MAX_ATTACH = 6, MAX_ROOMS = 1;
const PAGE = 20;
const MAX_PINS = 3;
const DEFAULTS = Object.freeze({
  enabled: true,
  max_image_mb: 10, max_audio_mb: 25, max_video_mb: 100,
  max_audio_secs: 600, max_video_secs: 180,
  user_quota_mb: 500, global_quota_gb: 20, min_free_gb: 8,
  media_min_level: 2,                 // upload media: a linked Camfrog name OR at least this level
  require_link_to_post: false,        // text/link posts: any signed-in account unless this is on
  terms_enforced: false,              // 1.99cf: ask people to accept the Terms (terms.js); can't go on while [[placeholders]] remain
  new_account_hours: 24, new_account_posts_per_day: 3,
  posts_per_hour: 10, posts_per_day: 40, comments_per_hour: 60, uploads_per_hour: 20, upload_mb_per_day: 400,
  report_hide_threshold: 3,           // distinct reporters (accounts older than new_account_hours) -> hidden pending review
  deleted_purge_days: 7,
  price_post: 0, price_link: 0, price_image: 0, price_audio: 0, price_video: 0,   // PAT; 0 = free
  mention_gap_min: 15,                // Pepe's room mentions: at most one line per room per this many minutes
  post_gap_secs: 20, comment_gap_secs: 4,   // minimum time between two posts / two comments by one account
  // voting + ranking (1.99bx)
  hot_decay_secs: 45000,              // Hot: seconds of age that cost one order of magnitude of score (Reddit: 45000 = 12.5 h)
  downvote_min_level: 2,              // a downvote counts from a linked Camfrog name OR at least this level (anti-brigade)
  votes_per_min: 30, votes_per_hour: 300,   // vote changes per account (posts + comments together)
  // reports (1.99cc): per reporter, posts + comments + users together; bad-faith reports pause reporting
  reports_per_hour: 20, reports_per_day: 60, new_account_reports_per_hour: 5, false_reports_pause: 3,
  crosspost_max_pads: 5,              // 1.99ct: pads one Crosspost action may target (each one counts as a post)
});
const INT_KEYS = Object.keys(DEFAULTS).filter((k) => typeof DEFAULTS[k] === "number");
const LIMITS = { max_image_mb: [1, 50], max_audio_mb: [1, 200], max_video_mb: [1, 500], max_audio_secs: [10, 3600], max_video_secs: [5, 1800],
  user_quota_mb: [10, 100000], global_quota_gb: [1, 1000], min_free_gb: [1, 500], media_min_level: [0, 100], new_account_hours: [0, 720],
  new_account_posts_per_day: [0, 100], posts_per_hour: [1, 1000], posts_per_day: [1, 5000], comments_per_hour: [1, 5000],
  uploads_per_hour: [1, 1000], upload_mb_per_day: [10, 100000], report_hide_threshold: [1, 100], deleted_purge_days: [0, 365],
  price_post: [0, 1e9], price_link: [0, 1e9], price_image: [0, 1e9], price_audio: [0, 1e9], price_video: [0, 1e9], mention_gap_min: [1, 1440],
  post_gap_secs: [0, 3600], comment_gap_secs: [0, 600],
  hot_decay_secs: [3600, 1000000], downvote_min_level: [0, 100], votes_per_min: [1, 1000], votes_per_hour: [1, 20000],
  reports_per_hour: [1, 1000], reports_per_day: [1, 10000], new_account_reports_per_hour: [0, 1000], false_reports_pause: [1, 100],
  crosspost_max_pads: [1, 25] };

let NOW = () => Date.now();
function _setClock(fn) { NOW = fn; }

class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }

let ready = null;
let CONFIG = { ...DEFAULTS };
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS feed_posts (
        id TEXT PRIMARY KEY, author_id TEXT NOT NULL, title TEXT, body TEXT, link_url TEXT, link_json TEXT,
        nsfw INTEGER NOT NULL DEFAULT 0, nsfw_admin INTEGER, global INTEGER NOT NULL DEFAULT 1,
        score INTEGER NOT NULL DEFAULT 0, comments INTEGER NOT NULL DEFAULT 0, cost INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL, edited INTEGER, deleted_at INTEGER, deleted_by TEXT, delete_reason TEXT,
        hidden_at INTEGER, purged_at INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS feed_posts_created ON feed_posts (created)");
      await runQuery("CREATE INDEX IF NOT EXISTS feed_posts_author ON feed_posts (author_id, created)");
      await runQuery(`CREATE TABLE IF NOT EXISTS feed_post_rooms (
        post_id TEXT NOT NULL, room_id TEXT NOT NULL, created INTEGER, removed_at INTEGER, removed_by TEXT,
        PRIMARY KEY (post_id, room_id))`);
      await runQuery("CREATE INDEX IF NOT EXISTS feed_post_rooms_room ON feed_post_rooms (room_id, created)");
      await runQuery(`CREATE TABLE IF NOT EXISTS feed_attachments (
        id TEXT PRIMARY KEY, post_id TEXT, owner_id TEXT NOT NULL, kind TEXT, ct TEXT, file TEXT, thumb TEXT, poster TEXT,
        w INTEGER, h INTEGER, secs REAL, bytes INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL, error TEXT, created INTEGER NOT NULL, size_declared INTEGER, received INTEGER NOT NULL DEFAULT 0, sniff TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS feed_att_post ON feed_attachments (post_id)");
      await runQuery("CREATE INDEX IF NOT EXISTS feed_att_owner ON feed_attachments (owner_id, created)");
      await runQuery("CREATE INDEX IF NOT EXISTS feed_att_file ON feed_attachments (file)");
      await runQuery("CREATE INDEX IF NOT EXISTS feed_att_thumb ON feed_attachments (thumb)");
      await runQuery("CREATE INDEX IF NOT EXISTS feed_att_poster ON feed_attachments (poster)");
      await runQuery(`CREATE TABLE IF NOT EXISTS feed_votes (
        post_id TEXT NOT NULL, user_id TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 1, created INTEGER, PRIMARY KEY (post_id, user_id))`);
      await runQuery(`CREATE TABLE IF NOT EXISTS feed_comments (
        id TEXT PRIMARY KEY, post_id TEXT NOT NULL, parent_id TEXT, author_id TEXT NOT NULL, body TEXT NOT NULL,
        created INTEGER NOT NULL, edited INTEGER, deleted_at INTEGER, deleted_by TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS feed_comments_post ON feed_comments (post_id, created)");
      await runQuery("CREATE INDEX IF NOT EXISTS feed_comments_author ON feed_comments (author_id, created)");
      await runQuery(`CREATE TABLE IF NOT EXISTS feed_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT NOT NULL, comment_id TEXT, reporter_id TEXT NOT NULL, reason TEXT,
        note TEXT, created INTEGER NOT NULL, resolved_at INTEGER, resolved_by TEXT, action TEXT)`);
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS feed_reports_once ON feed_reports (post_id, COALESCE(comment_id, ''), reporter_id)");
      await runQuery(`CREATE TABLE IF NOT EXISTS feed_bans (
        user_id TEXT NOT NULL, room_id TEXT NOT NULL DEFAULT '', username TEXT, reason TEXT, by TEXT, at INTEGER, until INTEGER,
        PRIMARY KEY (user_id, room_id))`);
      await runQuery(`CREATE TABLE IF NOT EXISTS feed_restricted (
        login TEXT NOT NULL, room_id TEXT NOT NULL DEFAULT '', reason TEXT, until INTEGER, PRIMARY KEY (login, room_id))`);
      await runQuery(`CREATE TABLE IF NOT EXISTS feed_mentions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, post_id TEXT NOT NULL, created INTEGER NOT NULL, sent_at INTEGER)`);
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS feed_mentions_once ON feed_mentions (room_id, post_id)");
      await runQuery("CREATE TABLE IF NOT EXISTS feed_kv (key TEXT PRIMARY KEY, value TEXT)");
      await loadConfig();
      await migrateVotes();
      await migrateSafety();
      await migrateCommunities();
      await migrateMentionDefault();
      // 1.99df: profile posts - the owner's per-post "Also show in All" (1 = yes, the default; only profile posts set 0)
      await addCol("feed_posts", "in_all", "INTEGER NOT NULL DEFAULT 1");
      // 1.99di: AI-generated files (aigen.js: Pepe's !imagine / !video from the composer) - the flag, the prompt (shown
      // under a "prompt" toggle unless the author hides it), the model, and Pepe's NSFW verdict (a post using it is NSFW)
      await addCol("feed_attachments", "ai_generated", "INTEGER NOT NULL DEFAULT 0");
      await addCol("feed_attachments", "ai_prompt", "TEXT");
      await addCol("feed_attachments", "ai_model", "TEXT");
      await addCol("feed_attachments", "ai_nsfw", "INTEGER NOT NULL DEFAULT 0");
      await addCol("feed_attachments", "ai_hide_prompt", "INTEGER NOT NULL DEFAULT 0");
      await addCol("feed_attachments", "ai_job", "TEXT");
      await migrateHomePad();
    })().catch((e) => { console.error("[feed] init:", e.message); ready = null; throw e; });
  }
  return ready;
}

// ── 1.99bx: up/down votes, cached counts, hot / controversy columns ──
async function addCol(table, col, def) {
  const have = (await getQuery(`PRAGMA table_info(${table})`)).some((c) => c.name === col);
  if (!have) await runQuery(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
async function migrateVotes() {
  await addCol("feed_posts", "ups", "INTEGER NOT NULL DEFAULT 0");
  await addCol("feed_posts", "downs", "INTEGER NOT NULL DEFAULT 0");
  await addCol("feed_posts", "hot", "REAL NOT NULL DEFAULT 0");
  await addCol("feed_posts", "controversy", "REAL NOT NULL DEFAULT 0");
  await addCol("feed_votes", "w", "INTEGER NOT NULL DEFAULT 1");
  await addCol("feed_votes", "updated", "INTEGER");
  await addCol("feed_comments", "ups", "INTEGER NOT NULL DEFAULT 0");
  await addCol("feed_comments", "downs", "INTEGER NOT NULL DEFAULT 0");
  await addCol("feed_comments", "score", "INTEGER NOT NULL DEFAULT 0");
  await runQuery(`CREATE TABLE IF NOT EXISTS feed_comment_votes (
    comment_id TEXT NOT NULL, post_id TEXT NOT NULL, user_id TEXT NOT NULL, value INTEGER NOT NULL, w INTEGER NOT NULL DEFAULT 1,
    created INTEGER, updated INTEGER, PRIMARY KEY (comment_id, user_id))`);
  await runQuery("CREATE INDEX IF NOT EXISTS feed_cvotes_post ON feed_comment_votes (post_id, user_id)");
  await runQuery("CREATE INDEX IF NOT EXISTS feed_votes_user ON feed_votes (user_id, updated)");
  await runQuery("CREATE INDEX IF NOT EXISTS feed_votes_recent ON feed_votes (post_id, updated)");
  // room moderation (1.99bx): pins, room-only NSFW / hide, the approval queue, comment locks, approved posters
  await addCol("feed_post_rooms", "pinned_at", "INTEGER");
  await addCol("feed_post_rooms", "pinned_by", "TEXT");
  await addCol("feed_post_rooms", "nsfw", "INTEGER");
  await addCol("feed_post_rooms", "hidden_at", "INTEGER");
  await addCol("feed_post_rooms", "hidden_by", "TEXT");
  await addCol("feed_post_rooms", "pending", "INTEGER NOT NULL DEFAULT 0");
  await addCol("feed_post_rooms", "approved_by", "TEXT");
  await addCol("feed_posts", "locked_at", "INTEGER");
  await addCol("feed_posts", "locked_by", "TEXT");
  await runQuery(`CREATE TABLE IF NOT EXISTS feed_room_members (room_id TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT, by TEXT, at INTEGER,
    PRIMARY KEY (room_id, user_id))`);
  await runQuery(`CREATE TABLE IF NOT EXISTS feed_room_report_done (room_id TEXT NOT NULL, post_id TEXT NOT NULL, comment_id TEXT NOT NULL DEFAULT '',
    at INTEGER NOT NULL, by TEXT, action TEXT, PRIMARY KEY (room_id, post_id, comment_id))`);
  await runQuery("CREATE INDEX IF NOT EXISTS feed_posts_hot ON feed_posts (hot)");
  await runQuery("CREATE INDEX IF NOT EXISTS feed_posts_score ON feed_posts (score, created)");
  await runQuery("CREATE INDEX IF NOT EXISTS feed_posts_contro ON feed_posts (controversy, created)");
  if ((await kvGet("votes_v2")) !== "1") {
    // 1.99bw stored upvotes only (value 1): normalise to +1 / -1, then backfill ups, downs, score, hot
    await runQuery("UPDATE feed_votes SET value = CASE WHEN value > 0 THEN 1 ELSE -1 END WHERE value != 0");
    await runQuery("DELETE FROM feed_votes WHERE value = 0");
    await runQuery("UPDATE feed_votes SET updated = COALESCE(created, 0) WHERE updated IS NULL");
    const ids = await getQuery("SELECT id FROM feed_posts");
    for (const r of ids) await recountPost(r.id);
    await kvSet("votes_v2", "1");
    await kvSet("hot_decay", String(CONFIG.hot_decay_secs));
    console.log(`[feed] votes v2 migration: ${ids.length} posts backfilled`);
  } else if ((await kvGet("hot_decay")) !== String(CONFIG.hot_decay_secs)) {
    await rehotAll();
  }
}

// ── 1.99cc: reports v2 (user reports, comments hidden by an urgent report, outcome notices) ──
async function migrateSafety() {
  await addCol("feed_comments", "hidden_at", "INTEGER");
  await addCol("feed_reports", "notified_at", "INTEGER");
  await runQuery(`CREATE TABLE IF NOT EXISTS user_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT, target_id TEXT NOT NULL, reporter_id TEXT NOT NULL, reason TEXT, note TEXT, created INTEGER NOT NULL,
    resolved_at INTEGER, resolved_by TEXT, action TEXT, notified_at INTEGER)`);
  await runQuery("CREATE INDEX IF NOT EXISTS user_reports_open ON user_reports (resolved_at, created)");
  await runQuery("CREATE INDEX IF NOT EXISTS user_reports_reporter ON user_reports (reporter_id, created)");
  await runQuery("CREATE INDEX IF NOT EXISTS feed_reports_reporter ON feed_reports (reporter_id, created)");
}

// ── 1.99ep: a post's fixed home pad (v2 decision 2026-10-07: a post belongs to exactly one pad or user) ──
/** feed_posts.home_pad + the backfill for older posts: their FIRST placement (by creation), whatever its state
 *  now. Idempotent (only rows still NULL; a post with no placement at all stays NULL = its author's profile). */
async function migrateHomePad() {
  await addCol("feed_posts", "home_pad", "TEXT");
  const r = await runQuery(`UPDATE feed_posts SET home_pad = (SELECT pr.room_id FROM feed_post_rooms pr WHERE pr.post_id = feed_posts.id
                            ORDER BY pr.created, pr.rowid LIMIT 1)
                            WHERE home_pad IS NULL AND EXISTS (SELECT 1 FROM feed_post_rooms pr WHERE pr.post_id = feed_posts.id)`);
  if (r && r.changes) console.log(`[feed] home_pad: ${r.changes} post(s) given their fixed home pad`);
}

// ── 1.99ci: communities only + crossposts ──
/**
 * What the communities_v1 migration moves: posts flagged main-feed (global = 1) that are visible in NO
 * community (no placement that isn't removed / pending / hidden) - they were only reachable through the
 * main feed. -> {posts: [{id, deleted}], live, deleted}
 */
async function communitiesPlan() {
  const rows = await getQuery(`SELECT p.id, p.deleted_at FROM feed_posts p WHERE p.global = 1 AND p.crosspost_of IS NULL
    AND NOT EXISTS (SELECT 1 FROM feed_post_rooms pr WHERE pr.post_id = p.id AND pr.removed_at IS NULL AND pr.pending = 0 AND pr.hidden_at IS NULL)`);
  return { posts: rows.map((r) => ({ id: r.id, deleted: !!r.deleted_at })), live: rows.filter((r) => !r.deleted_at).length, deleted: rows.filter((r) => r.deleted_at).length };
}
/**
 * Give every main-feed-only post a home in the Camfrog Lounge. Runs once (feed_kv communities_v1 holds the
 * result), and each insert is OR IGNORE, so a re-run (or a crash half way) never duplicates or re-adds a
 * post an owner has since taken out of the Lounge. -> {moved, live, deleted, at} or the stored result
 */
async function migrateCommunities() {
  await addCol("feed_posts", "crosspost_of", "TEXT");
  await runQuery("CREATE INDEX IF NOT EXISTS feed_posts_xpost ON feed_posts (crosspost_of)");
  const done = await kvGet("communities_v1");
  if (done) { try { return JSON.parse(done); } catch (e) { return { moved: 0 }; } }
  await rooms.init();
  const lounge = await rooms.get(rooms.LOUNGE_ID);
  if (!lounge) { console.error("[feed] communities_v1: no Lounge in the room registry - not migrated"); return null; }
  const plan = await communitiesPlan();
  for (const p of plan.posts) {
    await runQuery(`INSERT OR IGNORE INTO feed_post_rooms (post_id, room_id, created, pending)
                    SELECT id, ?, created, 0 FROM feed_posts WHERE id = ?`, [lounge.id, p.id]);
  }
  const out = { moved: plan.posts.length, live: plan.live, deleted: plan.deleted, room: lounge.id, at: NOW() };
  await kvSet("communities_v1", JSON.stringify(out));
  console.log(`[feed] communities_v1: ${out.moved} main-feed-only post(s) moved to ${lounge.id} (${out.live} live, ${out.deleted} deleted)`);
  return out;
}

/**
 * SQL (over `feed_posts p`): the post is visible in at least one of its communities - a placement that
 * isn't removed, pending approval or hidden by the room's owner, in a room the author isn't feed-banned
 * from (nor from the whole feed) right now. -> {sql, args}
 */
function visibleSql(now = NOW()) {
  return {
    sql: `EXISTS (SELECT 1 FROM feed_post_rooms fv WHERE fv.post_id = p.id AND fv.removed_at IS NULL AND fv.pending = 0 AND fv.hidden_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM feed_bans fb WHERE fb.user_id = p.author_id AND (fb.room_id = '' OR fb.room_id = fv.room_id) AND (fb.until IS NULL OR fb.until > ?)))`,
    args: [now],
  };
}

// Reddit's ranking maths (r2/lib/db/_sorts.pyx), seconds since its epoch
const HOT_EPOCH = 1134028003;
/** Hot: log10(max(|score|, 1)) * sign(score) + (created - epoch) / decay, rounded to 7 places. */
function hotRank(score, createdMs, decay = CONFIG.hot_decay_secs) {
  const s = Number(score) || 0;
  const order = Math.log10(Math.max(Math.abs(s), 1));
  const sign = s > 0 ? 1 : s < 0 ? -1 : 0;
  return Math.round((sign * order + (createdMs / 1000 - HOT_EPOCH) / decay) * 1e7) / 1e7;
}
/** Controversial: (ups + downs) ** (smaller / larger); 0 unless there are both ups and downs. */
function controversy(ups, downs) {
  if (!(ups > 0) || !(downs > 0)) return 0;
  const balance = ups > downs ? downs / ups : ups / downs;
  return Math.pow(ups + downs, balance);
}
/** Best (comments): the Wilson score interval's lower bound at 80% confidence (Reddit's "confidence"). */
function wilson(ups, downs, z = 1.281551565545) {
  const n = ups + downs;
  if (!n) return 0;
  const p = ups / n;
  const left = p + (z * z) / (2 * n);
  const right = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (left - right) / (1 + (z * z) / n);
}

/**
 * Re-derive a post's cached counts from feed_votes in ONE statement (atomic in SQLite, so concurrent
 * votes can't leave ups/downs/score out of step), then hot + controversy - written only if ups/downs
 * are still the ones they were computed from (a racing recount writes the newer ones).
 */
async function recountPost(id) {
  await runQuery(`UPDATE feed_posts SET
      ups = (SELECT COUNT(*) FROM feed_votes WHERE post_id = ?1 AND value = 1 AND w = 1),
      downs = (SELECT COUNT(*) FROM feed_votes WHERE post_id = ?1 AND value = -1 AND w = 1),
      score = (SELECT COALESCE(SUM(value), 0) FROM feed_votes WHERE post_id = ?1 AND w = 1)
    WHERE id = ?1`, [id]);
  for (let i = 0; i < 5; i++) {
    const r = (await getQuery("SELECT ups, downs, score, created FROM feed_posts WHERE id = ?", [id]))[0];
    if (!r) return null;
    const w = await runQuery("UPDATE feed_posts SET hot = ?, controversy = ? WHERE id = ? AND ups = ? AND downs = ?",
                             [hotRank(r.score, r.created), controversy(r.ups, r.downs), id, r.ups, r.downs]);
    if (w.changes) return r;
  }
  return (await getQuery("SELECT ups, downs, score, created FROM feed_posts WHERE id = ?", [id]))[0] || null;
}
async function recountComment(id) {
  await runQuery(`UPDATE feed_comments SET
      ups = (SELECT COUNT(*) FROM feed_comment_votes WHERE comment_id = ?1 AND value = 1 AND w = 1),
      downs = (SELECT COUNT(*) FROM feed_comment_votes WHERE comment_id = ?1 AND value = -1 AND w = 1),
      score = (SELECT COALESCE(SUM(value), 0) FROM feed_comment_votes WHERE comment_id = ?1 AND w = 1)
    WHERE id = ?1`, [id]);
  return (await getQuery("SELECT ups, downs, score FROM feed_comments WHERE id = ?", [id]))[0] || null;
}
/** Every post's hot rank again (the admin changed hot_decay_secs). */
async function rehotAll() {
  const rows = await getQuery("SELECT id, score, created FROM feed_posts");
  for (const r of rows) await runQuery("UPDATE feed_posts SET hot = ? WHERE id = ?", [hotRank(r.score, r.created), r.id]);
  await kvSet("hot_decay", String(CONFIG.hot_decay_secs));
  return rows.length;
}

// ── config ──
async function kvGet(key) { const r = (await getQuery("SELECT value FROM feed_kv WHERE key = ?", [key]))[0]; return r ? r.value : null; }
async function kvSet(key, v) { await runQuery("INSERT INTO feed_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(v)]); }
function cleanConfig(c) {
  const out = { ...DEFAULTS };
  for (const k of INT_KEYS) {
    if (c && c[k] != null && c[k] !== "") {
      const n = Math.floor(Number(c[k]));
      if (Number.isFinite(n)) out[k] = Math.min(LIMITS[k][1], Math.max(LIMITS[k][0], n));
    }
  }
  const bool = (v, d) => (v == null ? d : v === true || v === 1 || v === "1" || v === "on" || v === "true");
  out.enabled = bool(c && c.enabled, DEFAULTS.enabled);
  out.require_link_to_post = bool(c && c.require_link_to_post, DEFAULTS.require_link_to_post);
  out.terms_enforced = bool(c && c.terms_enforced, DEFAULTS.terms_enforced);
  return out;
}
async function loadConfig() {
  let c = {};
  try { c = JSON.parse((await kvGet("config")) || "{}"); } catch (e) { c = {}; }
  CONFIG = cleanConfig(c);
  terms.setEnforced(CONFIG.terms_enforced);
  return CONFIG;
}
async function setConfig(patch, actor) {
  await init();
  const merged = cleanConfig({ ...CONFIG, ...(patch || {}) });
  // 1.99cf: never make people accept an unfinished template
  if (merged.terms_enforced && !CONFIG.terms_enforced) {
    const ph = terms.placeholders();
    if (ph.length) {
      const names = [...new Set(ph.map((p) => p.text))];
      throw new Refuse(409, `The Terms can't be required yet: ${ph.length} [[placeholder]]${ph.length === 1 ? "" : "s"} left in /terms and /privacy (${names.slice(0, 5).join("; ")}${names.length > 5 ? "; …" : ""}). Fill them in first.`);
    }
  }
  await kvSet("config", JSON.stringify(merged));
  terms.setEnforced(merged.terms_enforced);
  const decayChanged = merged.hot_decay_secs !== CONFIG.hot_decay_secs;
  CONFIG = merged;
  if (decayChanged) await rehotAll();
  console.log(`[feed] config set by ${actor || "?"}: ${JSON.stringify(merged)}`);
  return CONFIG;
}
const config = () => CONFIG;

// ── helpers ──
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/g;
const cleanLine = (s, n) => String(s == null ? "" : s).replace(CTRL, "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, n);
const cleanText = (s, n) => String(s == null ? "" : s).replace(/\r\n?/g, "\n").replace(CTRL, "").replace(/\n{4,}/g, "\n\n\n").trim().slice(0, n);
const newId = (n = 12) => crypto.randomBytes(16).toString("base64url").replace(/[-_]/g, "").slice(0, n).padEnd(n, "x");
const isStaff = (u) => !!u && (u.class === "Admin" || u.class === "Staff");
// 1.99cg: Pepe's own site account (pepefeed.js creates it). His posts / comments go through the same create /
// comment code as everyone's, but the per-user rate limits are replaced by his own caps (pepefeed.js, server side)
// and he never gets the author's automatic upvote (his votes count for nothing in the rankings).
const PEPE_ID = "pepe-bot";
const isPepe = (u) => !!u && (u.userId === PEPE_ID || u === PEPE_ID);
/** A pad (registered room) by id, slug, "p/<slug>" (or the older "c/<slug>"), or null. */
async function communityOf(x) {
  const k = String(x == null ? "" : x).trim().slice(0, 128);
  if (!k) return null;
  const s = k.replace(/^[cp]\//i, "");
  return (await rooms.get(k)) || (await rooms.bySlug(s)) || (await require("./roomsweb").resolveRoom(s).catch(() => null)) || null;
}
/** 1.99ck: the slug a pad's links and p/<slug> labels use (pads.js). */
const padSlugOf = (R, roomId) => (R ? require("./pads").padSlug(R) : rooms.slugify(roomId));
/** 1.99df: the profile owner's username when R is a profile pad, else null. */
const profileName = (R) => (R && R.profile ? R.profile.username || "?" : null);
/** 1.99df: how a pad is written: "p/<slug>", or "u/<username>" for a profile pad. */
const padLabelOf = (R, roomId) => (R && R.profile ? "u/" + (R.profile.username || "?") : "p/" + padSlugOf(R, roomId));
/**
 * 1.99df: a picker / API key that names a profile ("profile", "u/<name>", "@me") -> the POSTER's own profile pad
 * (made on first use). undefined when the key isn't a profile key (the caller goes on with communityOf). Someone
 * else's profile throws: only its owner posts there.
 */
async function profileKey(u, key) {
  const k = String(key == null ? "" : key).trim();
  const m = /^(?:profile|@me|u\/(.{1,64}))$/i.exec(k);
  if (!m) return undefined;
  const name = m[1] ? m[1].trim() : null;
  if (u && (!name || String(u.username).toLowerCase() === name.toLowerCase())) {
    const R = await rooms.ensureProfile(u.userId);
    if (!R) throw new Refuse(403, "Your account can't have a profile feed.");
    return R;
  }
  throw new Refuse(403, name ? `Only ${name} can post on their profile.` : "Sign in to post on your profile.");
}
/** An explicit "no" (false / 0 / "0" / "off" / "false"); anything else, including missing, is not. */
const offFlag = (v) => v === false || v === 0 || v === "0" || v === "off" || v === "false";
const ID_RE = /^[A-Za-z0-9]{8,16}$/;

let UCOLS = null;
async function userCols() {
  if (!UCOLS) UCOLS = new Set((await getQuery("PRAGMA table_info(users)")).map((c) => c.name));
  return UCOLS;
}
async function account(userId) {
  const C = await userCols();
  const pick = (c) => (C.has(c) ? c : `NULL AS ${c}`);
  return (await getQuery(`SELECT userId, username, class, ${pick("displayname")}, ${pick("camfrogUsername")}, ${pick("level")}, ${pick("created_at")},
                          ${pick("casino_banned")}, ${pick("archived_at")}, ${pick("points_balance")}, ${pick("discordId")}, ${pick("twitchId")}
                          FROM users WHERE userId = ?`, [userId]))[0] || null;
}
function createdMs(u) {
  if (!u || !u.created_at) return 0;
  const t = Date.parse(String(u.created_at).replace(" ", "T") + (/Z|[+-]\d\d:?\d\d$/.test(String(u.created_at)) ? "" : "Z"));
  return Number.isFinite(t) ? t : 0;
}
function isNewAccount(u, C = CONFIG) {
  if (!u) return true;
  if (u.camfrogUsername || u.discordId || u.twitchId) return false;      // a linked identity isn't "new"
  const t = createdMs(u);
  return !t || NOW() - t < C.new_account_hours * 3600 * 1000;
}

// ── who may post (the relay's refusal rules + the feed's own) ──
/** null when `u` may post (in `roomIds`; [] = anywhere: only the account-wide rules), else {status, message}. */
async function postRefusal(u, roomIds = [], { media = false } = {}) {
  await init();
  const C = CONFIG;
  if (!u) return { status: 401, message: "Sign in to post." };
  if (!C.enabled && !isStaff(u)) return { status: 403, message: "Posting is switched off right now." };
  if (u.archived_at) return { status: 403, message: "This account is archived." };
  if (u.casino_banned) return { status: 403, message: "Your account is restricted." };       // = the relay's "restricted"
  const t = NOW();
  const bans = await getQuery("SELECT room_id, reason, until FROM feed_bans WHERE user_id = ? AND (until IS NULL OR until > ?)", [u.userId, t]);
  const globalBan = bans.find((b) => b.room_id === "");
  if (globalBan) return { status: 403, message: "You can't post on the feed" + (globalBan.until ? ` until ${new Date(globalBan.until).toUTCString()}` : "") + "." };
  for (const rid of roomIds) {
    if (rid && bans.find((b) => b.room_id === rid)) {
      const R = rooms.getCached(rid);
      // 1.99df: a profile ban = blocked from commenting on that member's profile posts
      if (R && R.profile) return { status: 403, message: `${R.profile.username || "This member"} has blocked you from commenting on their profile.` };
      return { status: 403, message: `You can't post in ${R ? R.title : rid}.` };
    }
  }
  // Pepe's own refusals for this Camfrog login (same rules as the bridge relay: pepe_relay._relay_refusal)
  if (u.camfrogUsername) {
    const login = String(u.camfrogUsername).toLowerCase();
    const rs = await getQuery("SELECT room_id, reason FROM feed_restricted WHERE login = ? AND (until IS NULL OR until > ?)", [login, t]);
    const g = rs.find((r) => r.room_id === "");
    if (g) return { status: 403, message: `Pepe says: ${g.reason || "you can't post right now"}.` };
    for (const rid of roomIds) {
      const r = rid && rs.find((x) => x.room_id === rid);
      if (r) return { status: 403, message: `Pepe says: ${r.reason || "you were moderated in this room recently"}.` };
    }
  }
  if (C.require_link_to_post && !u.camfrogUsername && !isStaff(u) && !isPepe(u)) {
    return { status: 403, message: "Link your Camfrog name first: type !verify in a Camfrog room with Pepe." };
  }
  if (media && !isStaff(u) && !isPepe(u) && !u.camfrogUsername && (Number(u.level) || 0) < C.media_min_level) {
    return { status: 403, message: `Uploading pictures, audio and video needs a linked Camfrog name (type !verify in a Camfrog room with Pepe) or level ${C.media_min_level}.` };
  }
  return null;
}

// fixed-window counters from the DB (survive restarts) + a short in-memory burst gap
const gaps = new Map();
function burst(key, ms) {
  if (!(ms > 0)) return 0;
  const t = NOW(), last = gaps.get(key) || 0;
  if (t - last < ms) return Math.ceil((ms - (t - last)) / 1000);
  gaps.set(key, t);
  if (gaps.size > 5000) for (const [k, v] of gaps) if (t - v > 3600e3) gaps.delete(k);
  return 0;
}
/** 1.99ct: how many more posts `u` may make right now under the count limits -> {left, why} (`why`: the
 *  binding limit's message, for when it's 0). Staff and Pepe: Infinity. The burst gap isn't counted here. */
async function postBudget(u) {
  const C = CONFIG, t = NOW();
  if (isStaff(u) || isPepe(u)) return { left: Infinity, why: null };   // Pepe: pepefeed.js's caps instead
  const n = async (ms) => (await getQuery("SELECT COUNT(*) AS n FROM feed_posts WHERE author_id = ? AND created > ?", [u.userId, t - ms]))[0].n;
  const day = await n(86400e3), hour = await n(3600e3);
  const caps = [];
  if (isNewAccount(u)) {
    caps.push([C.new_account_posts_per_day - day,
      `New accounts can post ${C.new_account_posts_per_day} time${C.new_account_posts_per_day === 1 ? "" : "s"} a day - link your Camfrog name (!verify) to lift that.`]);
  }
  caps.push([C.posts_per_hour - hour, "You've posted a lot this hour - try again later."]);
  caps.push([C.posts_per_day - day, "You've hit today's post limit."]);
  let best = caps[0];
  for (const c of caps) if (Math.max(0, c[0]) < Math.max(0, best[0])) best = c;
  return { left: Math.max(0, best[0]), why: best[1] };
}
async function postRate(u) {
  if (isStaff(u) || isPepe(u)) return null;
  const b = await postBudget(u);
  if (b.left <= 0) return b.why;
  const g = burst("post|" + u.userId, CONFIG.post_gap_secs * 1000);
  if (g) return `Slow down - try again in ${g}s.`;
  return null;
}

// ── storage accounting ──
async function usedBytes(userId) {
  const live = "state IN ('uploading','processing','ready')";
  if (userId) return (await getQuery(`SELECT COALESCE(SUM(CASE WHEN state = 'uploading' OR state = 'processing' THEN MAX(bytes, received) ELSE bytes END), 0) AS b
                                     FROM feed_attachments WHERE owner_id = ? AND ${live}`, [userId]))[0].b;
  return (await getQuery(`SELECT COALESCE(SUM(CASE WHEN state = 'uploading' OR state = 'processing' THEN MAX(bytes, received) ELSE bytes END), 0) AS b
                          FROM feed_attachments WHERE ${live}`))[0].b;
}

// ── reading ──
async function authors(ids) {
  const want = [...new Set(ids.filter(Boolean))];
  if (!want.length) return new Map();
  const C = await userCols();
  // 1.99ex: + the profile photo and the equipped name style (userlook.js) - still ONE users query per page
  const rows = await getQuery(`SELECT userId, username, ${C.has("displayname") ? "displayname" : "NULL AS displayname"}, class, ${C.has("avatar") ? "avatar" : "NULL AS avatar"}
                               FROM users WHERE userId IN (${want.map(() => "?").join(",")})`, want);
  const UL = require("./userlook");
  const css = await UL.nameStyles(rows.filter((r) => r.userId !== PEPE_ID).map((r) => r.username));
  const m = new Map();
  for (const r of rows) {
    const bot = r.userId === PEPE_ID;
    m.set(r.userId, { userId: r.userId, username: r.username, display: r.displayname || r.username, staff: r.class === "Admin" || r.class === "Staff",
                      bot, avatar: bot ? null : UL.avatarOf(r.avatar), nameCss: bot ? "" : css[r.username] || "" });
  }
  return m;
}

function parseJson(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }
const effNsfw = (p) => (p.nsfw_admin === 0 || p.nsfw_admin === 1 ? !!p.nsfw_admin : !!p.nsfw);

/**
 * Decorate post rows: author, rooms, attachments, my vote, flags; (1.99ci) a crosspost's embedded original
 * (xpost: {id, removed, post|null, from: {slug, title}|null, author}) and every post's live crossposts
 * (crossposts: [{id, slug, title}], xcount).
 */
async function decorate(rows, viewer, { ctxRoom = null, detail = false, _inner = false } = {}) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const q = ids.map(() => "?").join(",");
  // crossposts: the originals they embed (decorated once, without their own crossposts), and live crossposts of these posts
  const origIds = [...new Set(rows.map((r) => r.crosspost_of).filter(Boolean))];
  const [ORIG, XP] = _inner ? [[], []] : await Promise.all([
    origIds.length ? getQuery(`SELECT * FROM feed_posts WHERE id IN (${origIds.map(() => "?").join(",")})`, origIds) : [],
    getQuery(`SELECT x.id, x.crosspost_of, x.title, x.body, pr.room_id FROM feed_posts x JOIN feed_post_rooms pr ON pr.post_id = x.id
              WHERE x.crosspost_of IN (${q}) AND x.deleted_at IS NULL AND x.hidden_at IS NULL AND pr.removed_at IS NULL AND pr.pending = 0 AND pr.hidden_at IS NULL`, ids),
  ]);
  const origs = new Map((ORIG.length ? await decorate(ORIG, viewer, { detail, _inner: true }) : []).map((o) => [o.id, o]));
  const staffV = isStaff(viewer);
  const [A, PR, AT, MV, FW] = await Promise.all([
    authors(rows.map((r) => r.author_id)),
    getQuery(`SELECT post_id, room_id, removed_at, pinned_at, nsfw, hidden_at, pending FROM feed_post_rooms WHERE post_id IN (${q}) ORDER BY created, rowid`, ids),
    getQuery(`SELECT * FROM feed_attachments WHERE post_id IN (${q}) AND state = 'ready' ORDER BY sort, created`, ids),
    viewer && viewer.userId ? getQuery(`SELECT post_id, value, w FROM feed_votes WHERE user_id = ? AND post_id IN (${q})`, [viewer.userId, ...ids]) : [],
    // 1.99bz: which of these authors the viewer follows (the author chip's Follow button)
    viewer && viewer.userId ? require("./follows").followedAmong(viewer.userId, "user", rows.map((r) => r.author_id)) : new Set(),
  ]);
  const staff = isStaff(viewer);
  // 1.99eq: posts made from a story capture (storykeep.js): "📸 Captured from <room>", the subject's profile, "Remove me"
  let CAP = new Map();
  if (!_inner) { try { CAP = await require("./storykeep").forPosts(ids, viewer); } catch (e) { CAP = new Map(); } }
  return rows.map((r) => {
    const roomsOf = PR.filter((x) => x.post_id === r.id).map((x) => {
      const R = rooms.getCached(x.room_id);
      return { id: x.room_id, slug: padSlugOf(R, x.room_id), title: R ? R.title : x.room_id, removed: !!x.removed_at, owner: R && R.owner ? R.owner.userId : null,
               pinned: !!x.pinned_at, nsfw: x.nsfw === 1, hidden: !!x.hidden_at, pending: !!x.pending,
               profile: profileName(R), label: padLabelOf(R, x.room_id) };     // 1.99df: a profile pad shows as u/<username>
    });
    const ctx = ctxRoom ? roomsOf.find((x) => x.id === ctxRoom) : null;
    // a room owner's NSFW mark applies in their room's view; in the aggregate views (All, Following, profiles, the
    // post page, the homepage) any live community's mark does (1.99ci - before, the main feed ignored them)
    let nsfw = effNsfw(r) || (ctxRoom ? !!(ctx && ctx.nsfw) : roomsOf.some((x) => x.nsfw && !x.removed));
    // 1.99ci: a crosspost shows its original - gone for everyone (but staff) once the original is deleted, hidden,
    // or visible in none of its communities any more ("original removed")
    let xpost = null;
    if (r.crosspost_of) {
      const o = origs.get(r.crosspost_of) || null;
      const oVisible = !!o && o.roomsAll.some((x) => !x.removed && !x.pending && !x.hidden);
      const removed = !o || o.deleted || o.hidden || !oVisible;
      const from = o ? (o.roomsAll.find((x) => !x.removed && !x.pending && !x.hidden) || o.roomsAll[0] || null) : null;
      xpost = { id: r.crosspost_of, removed, post: removed && !staffV ? null : o,
                from: from ? { id: from.id, slug: from.slug, title: from.title, profile: from.profile || null, label: from.label } : null, author: o ? o.author : null };
      if (o && o.nsfw) nsfw = true;
    }
    const xps = XP.filter((x) => x.crosspost_of === r.id);
    const crossposts = [...new Map(xps.map((x) => {
      const R = rooms.getCached(x.room_id);
      const c = { id: x.id, room: x.room_id, slug: padSlugOf(R, x.room_id), title: R ? R.title : x.room_id, profile: profileName(R), label: padLabelOf(R, x.room_id) };
      // 1.99dv: the crosspost's own address (its pad + its title)
      c.url = require("./pads").postHref({ id: x.id, title: x.title, body: x.body, roomsAll: [{ id: x.room_id, slug: c.slug, profile: c.profile }] });
      return [x.room_id, c];
    })).values()];
    const mineRow = !!(viewer && viewer.userId === r.author_id);
    // 1.99di: an AI-generated file carries {prompt (null when the author hid it - they and staff still see it), hidden}
    const att = AT.filter((a) => a.post_id === r.id).map((a) => ({ id: a.id, kind: a.kind, ct: a.ct, file: a.file, thumb: a.thumb, poster: a.poster,
                                                                 w: a.w, h: a.h, secs: a.secs,
                                                                 ai: a.ai_generated ? { prompt: a.ai_hide_prompt && !mineRow && !staff ? null : (a.ai_prompt || null),
                                                                                        hidden: !!a.ai_hide_prompt } : null }));
    const link = parseJson(r.link_json);
    const mv = MV.find((v) => v.post_id === r.id);
    const out = {
      id: r.id, title: r.title || "", body: r.body || "", created: r.created, edited: r.edited, score: r.score, comments: r.comments,
      ups: r.ups || 0, downs: r.downs || 0, myVote: mv ? (mv.value > 0 ? 1 : -1) : 0,
      nsfw, nsfwAuthor: !!r.nsfw, nsfwRoom: !!(ctx && ctx.nsfw), pinned: !!(ctx && ctx.pinned), roomHidden: !!(ctx && ctx.hidden), pending: !!(ctx && ctx.pending),
      locked: !!r.locked_at, lockedBy: r.locked_by || null, nsfwAdmin: r.nsfw_admin, global: !!r.global, cost: r.cost,
      // 1.99df: on a profile (its owner's), and whether it also shows in All
      onProfile: roomsOf.some((x) => x.profile && !x.removed), inAll: r.in_all !== 0,
      deleted: !!r.deleted_at, hidden: !!r.hidden_at, deleteReason: r.delete_reason || null,
      author: A.get(r.author_id) || { userId: r.author_id, username: "[gone]", display: "[deleted account]" },
      followingAuthor: FW.has(r.author_id),
      mine: !!(viewer && viewer.userId === r.author_id),
      voted: !!(mv && mv.value > 0),
      rooms: roomsOf.filter((x) => (!x.removed && !x.pending && !x.hidden) || staff),
      roomsAll: roomsOf, homePad: r.home_pad || null,      // 1.99ep: the fixed home pad (canonical URL)
      images: att.filter((a) => a.kind === "image"), audio: att.filter((a) => a.kind === "audio"), video: att.filter((a) => a.kind === "video"),
      link: link && link.url ? { ...link, thumbFile: (att.find((a) => a.kind === "preview") || {}).thumb || null } : null,
      xpost, crossposts, xcount: crossposts.length,
      ai: att.filter((a) => a.ai && a.kind !== "preview"),       // 1.99di: the post's AI-generated files (badge + prompt toggle)
      capture: CAP.get(r.id) || null,                            // 1.99eq: made from a story capture (storykeep.forPosts)
    };
    out.url = require("./pads").postHref(out);     // 1.99dv: /p/<pad>/posts/<id>/<slug> or /u/<username>/posts/<id>/<slug>
    return out;
  });
}

/** A post's thumbnail file (its first picture, a video poster or the link preview; a crosspost: the original's). */
function thumbOf(p) {
  const q = p.xpost ? p.xpost.post : p;
  if (!q) return null;
  const im = q.images && q.images[0];
  if (im) return im.thumb || im.file;
  const v = q.video && q.video[0];
  if (v && v.poster) return v.poster;
  return q.link && q.link.thumbFile ? q.link.thumbFile : null;
}

/** A post row's hot rank (as stored in feed_posts.hot). */
const hotScore = (p) => hotRank(p.score, p.created);

// ── sorting (reusable: /feed, the room feeds, Following, profiles) ──
const SORTS = Object.freeze(["hot", "new", "top", "controversial", "rising"]);
const WINDOWS = Object.freeze({ hour: 3600e3, day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3, year: 365 * 86400e3, all: 0 });
const TIMED = new Set(["top", "controversial"]);       // the sorts that take a time filter
const RISING_VOTES_MS = 6 * 3600e3, RISING_MAX_AGE_MS = 48 * 3600e3;
const cleanSort = (s, d = "hot") => (SORTS.includes(s) ? s : d);
const cleanWindow = (t, d = "week") => (Object.prototype.hasOwnProperty.call(WINDOWS, t) ? t : d);

/**
 * SQL for a sort over `feed_posts p`: {where: [...], args: [...], order, select (extra columns)}.
 *   hot           p.hot (precomputed Reddit hot rank)
 *   new           newest first
 *   top           score, within the time window `t` (hour|day|week|month|year|all)
 *   controversial Reddit's controversy (precomputed), within `t`
 *   rising        posts under 48 h old by the net counted votes OTHER people gave them in the last 6 h
 */
function rankSpec(sort, t = "all", now = NOW()) {
  const s = cleanSort(sort);
  const where = [], args = [];
  let select = "", order;
  const win = WINDOWS[cleanWindow(t, "all")];
  if (TIMED.has(s) && win) { where.push("p.created > ?"); args.push(now - win); }
  if (s === "hot") order = "p.hot DESC, p.created DESC";
  else if (s === "new") order = "p.created DESC";
  else if (s === "top") order = "p.score DESC, p.ups DESC, p.created DESC";
  else if (s === "controversial") order = "p.controversy DESC, (p.ups + p.downs) DESC, p.created DESC";
  else {
    const vel = "(SELECT COALESCE(SUM(v.value), 0) FROM feed_votes v WHERE v.post_id = p.id AND v.w = 1 AND v.user_id != p.author_id AND v.updated > ?)";
    select = `, ${vel} AS velocity`;
    args.unshift(now - RISING_VOTES_MS);            // the select's placeholder comes first
    where.push("p.created > ?", `${vel} > 0`); args.push(now - RISING_MAX_AGE_MS, now - RISING_VOTES_MS);
    order = "velocity DESC, p.hot DESC";
  }
  return { sort: s, where, args, order, select };
}

/**
 * A page of posts. scope: {room: room id} (one community) | {author: userId} | {authors: [userIds]} |
 * {following: userId} | All (no scope). sort: hot|new|top|controversial|rising; top: the time window for
 * top/controversial. `sfw`: leave NSFW posts out entirely (the homepage for signed-out visitors).
 *   All (1.99ci): every post visible in at least one community (visibleSql: a placement that isn't removed,
 *     pending or owner-hidden, by an author not banned there) - one row per post however many communities
 *     it's in. Staff see every post with a placement that isn't removed. (Until 1.99ci this read
 *     `p.global = 1`, so posts made only to rooms never showed under "Everywhere".)
 *   A community: its placements; pending / owner-hidden ones only for the room's owner, admins and the author.
 * Deleted posts never show; report-hidden ones only to staff.
 */
async function list({ room = null, author = null, following = null, authors: authorIds = null, sort = "new", page = 1, top = "all", viewer = null, limit = PAGE, pins: pinsOn = true, sfw = false,
                      media = false, offset = null, idsOnly = false } = {}) {
  await init();
  const staff = isStaff(viewer);
  const roomMod = room ? await rooms.canManage(viewer, room) : false;
  const t = NOW();
  const R = rankSpec(sort, top, t);
  const scope = ["p.deleted_at IS NULL"], sargs = [];
  if (!staff) scope.push("p.hidden_at IS NULL");
  let from = "feed_posts p";
  const jargs = [];
  const visible = () => {
    if (staff) scope.push("EXISTS (SELECT 1 FROM feed_post_rooms fv WHERE fv.post_id = p.id AND fv.removed_at IS NULL)");
    else { const v = visibleSql(t); scope.push(v.sql); sargs.push(...v.args); }
  };
  if (following) {
    // 1.99bz: posts by people `following` follows + posts in rooms they follow (one row per post);
    // 1.99ci: only posts visible in some community (as on All)
    await require("./follows").init();
    const f = require("./follows").feedFilter(following);
    scope.push(f.sql); sargs.push(...f.args);
    visible();
  } else if (room) {
    from += " JOIN feed_post_rooms pr ON pr.post_id = p.id AND pr.room_id = ?";
    jargs.push(room);
    if (!staff) scope.push("pr.removed_at IS NULL");
    // pending approval / hidden in the room: only its owner (and admins) see them, plus the author their own
    if (!roomMod) {
      if (viewer && viewer.userId) { scope.push("((pr.pending = 0 AND pr.hidden_at IS NULL) OR p.author_id = ?)"); sargs.push(viewer.userId); }
      else scope.push("pr.pending = 0 AND pr.hidden_at IS NULL");
      // 1.99ci: an author banned from this room (or the whole feed) drops out of it while the ban lasts
      scope.push("NOT EXISTS (SELECT 1 FROM feed_bans fb WHERE fb.user_id = p.author_id AND (fb.room_id = '' OR fb.room_id = pr.room_id) AND (fb.until IS NULL OR fb.until > ?))");
      sargs.push(t);
    }
  } else if (author) {
    scope.push("p.author_id = ?"); sargs.push(author);
  } else if (Array.isArray(authorIds)) {
    const ids = authorIds.map(String).slice(0, 2000);
    if (!ids.length) return { posts: [], more: false, page: 1, sort: R.sort };
    scope.push(`p.author_id IN (${ids.map(() => "?").join(",")})`); sargs.push(...ids);
    visible();
  } else {
    visible();                          // All
    scope.push("p.in_all != 0");        // 1.99df: a profile post its owner kept out of All
  }
  if (sfw) {
    // no NSFW anywhere: the author's / an admin's flag, any live community's mark, or (a crosspost) the original's
    const flag = (a) => `(CASE WHEN ${a}.nsfw_admin IN (0, 1) THEN ${a}.nsfw_admin ELSE ${a}.nsfw END) = 0`;
    scope.push(flag("p"));
    scope.push("NOT EXISTS (SELECT 1 FROM feed_post_rooms fn WHERE fn.post_id = p.id AND fn.nsfw = 1 AND fn.removed_at IS NULL)");
    scope.push(`(p.crosspost_of IS NULL OR EXISTS (SELECT 1 FROM feed_posts o WHERE o.id = p.crosspost_of AND ${flag("o")}
                 AND NOT EXISTS (SELECT 1 FROM feed_post_rooms fo WHERE fo.post_id = o.id AND fo.nsfw = 1 AND fo.removed_at IS NULL)))`);
  }
  // 1.99eq: Hop (hop.js) - media posts only: a ready picture or video on the post, or (a crosspost) on its original
  if (media) scope.push(MEDIA_SQL);
  page = Math.max(1, Math.min(200, Math.floor(Number(page)) || 1));
  // placeholders in text order: select (rising) -> join -> scope -> sort filters
  const selArgs = R.select ? [R.args[0]] : [], sortArgs = R.select ? R.args.slice(1) : R.args;
  // a room's pinned posts (at most MAX_PINS) head page 1 of every sort and are left out of the ranking
  let pinned = [];
  // 1.99eq: an explicit offset (Hop's cursor) replaces the page; pins stay in the ranking there (no "page 1")
  const off = offset !== null && offset !== undefined ? Math.max(0, Math.min(5000, Math.floor(Number(offset)) || 0)) : null;
  if (off !== null) pinsOn = false;
  if (room && pinsOn) {
    if (page === 1) pinned = await getQuery(`SELECT p.* FROM ${from} WHERE ${scope.join(" AND ")} AND pr.pinned_at IS NOT NULL ORDER BY pr.pinned_at DESC LIMIT ${MAX_PINS}`, [...jargs, ...sargs]);
    scope.push("pr.pinned_at IS NULL");
  }
  const rows = await getQuery(`SELECT p.*${R.select} FROM ${from} WHERE ${scope.concat(R.where).join(" AND ")} ORDER BY ${R.order} LIMIT ? OFFSET ?`,
                              [...selArgs, ...jargs, ...sargs, ...sortArgs, limit + 1, off !== null ? off : (page - 1) * limit]);
  const more = rows.length > limit;
  if (idsOnly) return { ids: rows.slice(0, limit).map((r) => r.id), more, page, sort: R.sort };
  return { posts: await decorate(pinned.concat(rows.slice(0, limit)), viewer, { ctxRoom: room }), more, page, sort: R.sort };
}

// 1.99eq: "this post shows a picture or a video" (its own files, or a crosspost's original's)
const MEDIA_SQL = `EXISTS (SELECT 1 FROM feed_attachments fa WHERE fa.post_id = COALESCE(p.crosspost_of, p.id) AND fa.state = 'ready' AND fa.kind IN ('image', 'video'))`;

async function getRow(id) {
  if (!ID_RE.test(String(id || ""))) return null;
  await init();
  return (await getQuery("SELECT * FROM feed_posts WHERE id = ?", [id]))[0] || null;
}
async function get(id, viewer, opts = {}) {
  const r = await getRow(id);
  if (!r) return null;
  return (await decorate([r], viewer, opts))[0];
}
/** 1.99dv: a post's canonical path (pads.postHref) from its id; `hash` ("#c-<id>", "#comments") is appended. null: no such post. */
async function postPath(id, hash = "") {
  const p = await get(id, null, { _inner: true });
  return p ? p.url + (hash || "") : null;
}
/** 1.99dv: many posts' canonical paths at once (admin lists, Pepe's mention lines). -> Map id -> path (missing ids left out). */
async function postLinks(ids) {
  const list = [...new Set((ids || []).map(String).filter((x) => ID_RE.test(x)))];
  const out = new Map();
  if (!list.length) return out;
  await init();
  const rows = await getQuery(`SELECT * FROM feed_posts WHERE id IN (${list.map(() => "?").join(",")})`, list);
  for (const p of await decorate(rows, null, { _inner: true })) out.set(p.id, p.url);
  return out;
}
/** postPath, never null (a gone post's link is the old short form, which 404s like the post would). */
async function postLink(id, hash = "") {
  try { return (await postPath(id, hash)) || "/feed/p/" + encodeURIComponent(String(id || "")) + (hash || ""); }
  catch (e) { return "/feed/p/" + encodeURIComponent(String(id || "")) + (hash || ""); }
}

// ── permissions on a post ──
async function canModerate(user, post) {
  if (!user || !user.userId) return { admin: false, rooms: [] };
  if (isStaff(user)) return { admin: true, rooms: post.roomsAll.map((r) => r.id) };
  const mine = [];
  for (const r of post.roomsAll) if (await rooms.canManage(user, r.id)) mine.push(r.id);
  return { admin: false, rooms: mine };
}

// ── writing ──
async function chargeFor(u, cost, label) {
  if (cost <= 0) return;
  const paid = await runQuery("UPDATE users SET points_balance = points_balance - ? WHERE userId = ? AND points_balance >= ?", [cost, u.userId, cost]);
  if (!paid.changes) throw new Refuse(402, `This post costs ${cost.toLocaleString("en-US")} PAT - you don't have enough.`);
  await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)", [uuidv4(), u.userId, label, -cost]);
  // the fee goes to the Federal Reserve: a NEGATIVE reserve_claims row Pepe's funding tick credits (as the stage does)
  try {
    await runQuery(`CREATE TABLE IF NOT EXISTS reserve_claims (claimId TEXT PRIMARY KEY, flow TEXT NOT NULL, userId TEXT, type TEXT, amount INTEGER NOT NULL,
                    created DATETIME DEFAULT CURRENT_TIMESTAMP, settled INTEGER DEFAULT 0)`);
    await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES (?, ?, ?, ?, ?)", [uuidv4(), "feed_post", u.userId, label, -cost]);
  } catch (e) { console.error("[feed] reserve claim:", e.message); }
}
async function refund(u, cost, label) {
  if (cost <= 0) return;
  await runQuery("UPDATE users SET points_balance = points_balance + ? WHERE userId = ?", [cost, u.userId]);
  await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)", [uuidv4(), u.userId, label, cost]);
  await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES (?, ?, ?, ?, ?)", [uuidv4(), "feed_post", u.userId, label, cost]).catch(() => {});
}
function priceOf(C, { images, audio, video, link }) {
  return C.price_post + (link ? C.price_link : 0) + images * C.price_image + audio * C.price_audio + video * C.price_video;
}

/**
 * Create a post. input: {title, body, link (url string), attachments: [ids], rooms: [room ids], global, nsfw}
 * deps.preview(url) -> link preview ({url, domain, title, description, site, embed, thumb: attachment row|null})
 * 1.99dn: deps.free - no post price (aigen.js: a Camfrog room's !imagine / !video posted to its pad, already paid in
 * chat); deps.roomGen - that post, made by Pepe on a room member's behalf: the pad's who-can-post rules are about
 * people, so they don't stop Pepe there (the pad's own "post room generations" switch does)
 */
// 1.99fc: the media safety hook (imagesafety.install sets it). fn({atts, roomId, userId}) -> {ok:true, nsfw?} | {ok:false, reason}
let MEDIA_SAFETY = async () => ({ ok: true });
function setMediaSafetyCheck(fn) { MEDIA_SAFETY = typeof fn === "function" ? fn : async () => ({ ok: true }); }

async function create(userId, input, deps = {}) {
  await init();
  const C = CONFIG;
  const u = await account(userId);
  if (!u) throw new Refuse(401, "Sign in to post.");
  const title = cleanLine(input.title, TITLE_MAX);
  const body = cleanText(input.body, BODY_MAX);
  const linkIn = String(input.link || "").trim();
  const attIds = [...new Set((Array.isArray(input.attachments) ? input.attachments : []).map(String))].slice(0, MAX_ATTACH + 1);
  if (attIds.length > MAX_ATTACH) throw new Refuse(400, `At most ${MAX_ATTACH} files per post.`);
  // 1.99ci: exactly one community (a registered room): `community` (id or slug), or the 1.99bv `rooms` list
  // with one entry. There's no main feed any more - `global` is ignored. Crossposting shares it elsewhere.
  const roomIds = [];
  const picked = input.community != null && input.community !== "" ? [input.community] : (Array.isArray(input.rooms) ? input.rooms : []);
  for (const r of picked.slice(0, 6)) {
    let R = await profileKey(u, r);                                   // 1.99df: "u/<me>" / "profile" = my profile pad
    if (R === undefined) R = await communityOf(r);
    if (!R) throw new Refuse(400, "That pad isn't on PATV.");
    if (!roomIds.includes(R.id)) roomIds.push(R.id);
  }
  if (roomIds.length > MAX_ROOMS) throw new Refuse(400, "Post to one pad - then use Crosspost to share it in another.");
  if (!roomIds.length) throw new Refuse(400, "Choose a pad to post in.");
  if (!title && !body && !linkIn && !attIds.length) throw new Refuse(400, "Write something, add a link or attach a file.");
  const refusal = await postRefusal(u, roomIds, { media: attIds.length > 0 });
  if (refusal) throw new Refuse(refusal.status, refusal.message);
  // 1.99eq: deps.onBehalf - a story capture posted to its pad (storykeep.js) by the pad's owner / a mod / an admin and
  // credited to the person who took it: the pad's who-can-post rules, its approval queue and the rate limits are the
  // ACTOR's business (storykeep checks the actor), not the credited author's. The account-wide refusals above still apply.
  const rate = deps.onBehalf ? null : await postRate(u);
  if (rate) throw new Refuse(429, rate);
  const pendingIn = new Set();
  for (const rid of roomIds) {
    const why = (deps.roomGen && isPepe(u)) || deps.onBehalf ? null : await roomPostRefusal(u, rid);
    if (why) throw new Refuse(why.status, why.message);
    if (!deps.onBehalf && (await roomSettings(rid)).approval && !(await rooms.canManage(u, rid))) pendingIn.add(rid);
  }
  // attachments: mine, ready, not on a post yet
  let atts = [];
  if (attIds.length) {
    atts = await getQuery(`SELECT * FROM feed_attachments WHERE id IN (${attIds.map(() => "?").join(",")})`, attIds);
    if (atts.length !== attIds.length || atts.some((a) => a.owner_id !== u.userId || a.post_id || a.kind === "preview")) {
      throw new Refuse(400, "One of those files isn't yours or is already posted.");
    }
    if (atts.some((a) => a.state !== "ready")) throw new Refuse(409, "A file is still processing - wait for it to finish.");
    atts.sort((a, b) => attIds.indexOf(a.id) - attIds.indexOf(b.id));
  }
  const counts = { images: atts.filter((a) => a.kind === "image").length, audio: atts.filter((a) => a.kind === "audio").length,
                   video: atts.filter((a) => a.kind === "video").length };
  if (counts.images > MAX_IMAGES) throw new Refuse(400, `At most ${MAX_IMAGES} pictures per post.`);
  if (counts.audio > 1 || counts.video > 1) throw new Refuse(400, "One audio file and one video per post.");
  // link preview: fetched HERE (never trusted from the browser)
  let link = null, previewAtt = null;
  if (linkIn) {
    const pv = deps.preview ? await deps.preview(linkIn, u.userId) : null;
    if (!pv) throw new Refuse(400, "That link couldn't be checked.");
    link = { url: pv.url, domain: pv.domain, title: cleanLine(pv.title, 200), description: cleanLine(pv.description, 300), site: cleanLine(pv.site, 80),
             embed: pv.embed || null };
    previewAtt = pv.thumb || null;
  }
  const cost = deps.free ? 0 : priceOf(C, { ...counts, link: !!link });
  // 1.99fc: the image safety check (imagesafety.js; a pass-through while it's switched off). Pepe's own posts and
  // posts made on someone's behalf (room generations, story keeps) aren't uploads by that person - not checked.
  let safetyNsfw = false;
  if (atts.length && !deps.roomGen && !deps.onBehalf && !isPepe(u)) {
    let sv;
    try { sv = await MEDIA_SAFETY({ atts, roomId: roomIds[0], userId: u.userId }); }
    catch (e) { sv = { ok: false, reason: "The safety check couldn't run - try again in a minute." }; }
    if (!sv || sv.ok !== true) throw new Refuse(422, (sv && sv.reason) || "That file can't be posted here.");
    safetyNsfw = sv.nsfw === true;
  }
  // 1.99di: a file Pepe's result check called NSFW makes the post NSFW whatever the author ticked
  const aiNsfw = atts.some((a) => a.ai_nsfw) || safetyNsfw;
  const id = newId();
  const label = `feed post ${id}`;
  // 1.99df: "Also show in All" - only a profile post can opt out (default: shown)
  const inAll = roomIds.some((rid) => rooms.isProfile(rid)) && offFlag(input.inAll) ? 0 : 1;
  await chargeFor(u, cost, label);
  try {
    const t = NOW();
    await runQuery(`INSERT INTO feed_posts (id, author_id, title, body, link_url, link_json, nsfw, global, cost, created, in_all, home_pad)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                   [id, u.userId, title || null, body || null, link ? link.url : null, link ? JSON.stringify(link) : null,
                    aiNsfw || input.nsfw === true || input.nsfw === 1 || input.nsfw === "1" || input.nsfw === "on" ? 1 : 0, 0, cost, t, inAll,
                    roomIds[0] || null]);      // 1.99ep: its fixed home pad (one pad per post since 1.99ci)
    let i = 0;
    for (const a of atts) {
      const r = await runQuery("UPDATE feed_attachments SET post_id = ?, sort = ? WHERE id = ? AND owner_id = ? AND post_id IS NULL AND state = 'ready'", [id, i++, a.id, u.userId]);
      if (!r.changes) throw new Refuse(409, "A file was used twice.");
    }
    if (previewAtt) await runQuery("UPDATE feed_attachments SET post_id = ?, sort = 99 WHERE id = ? AND post_id IS NULL AND owner_id = ?", [id, previewAtt.id, u.userId]);
    // 1.99bz: Pepe announces the post in a room when the room's OWNER has announcements on (the gate)
    // AND the author left "announce in <room>" ticked. No announce list (older pages) = every such room.
    const announce = Array.isArray(input.announce) ? new Set(input.announce.map(String)) : null;
    const wants = (rid) => !announce || announce.has(rid) || [...announce].some((x) => (rooms.getCached(rid) || {}).slug === x);
    for (const rid of roomIds) {
      await runQuery("INSERT OR IGNORE INTO feed_post_rooms (post_id, room_id, created, pending) VALUES (?, ?, ?, ?)", [id, rid, t, pendingIn.has(rid) ? (wants(rid) ? 1 : 2) : 0]);
      if (!pendingIn.has(rid) && wants(rid)) await queueMention(rid, id);
    }
    // the author's own upvote (Reddit-style; they can take it back, never turn it into a downvote) - never Pepe's
    if (!isPepe(u)) await runQuery("INSERT OR IGNORE INTO feed_votes (post_id, user_id, value, w, created, updated) VALUES (?, ?, 1, 1, ?, ?)", [id, u.userId, t, t]);
    await recountPost(id);
  } catch (e) {
    await runQuery("DELETE FROM feed_votes WHERE post_id = ?", [id]).catch(() => {});
    await runQuery("UPDATE feed_attachments SET post_id = NULL WHERE post_id = ?", [id]).catch(() => {});
    await runQuery("DELETE FROM feed_post_rooms WHERE post_id = ?", [id]).catch(() => {});
    await runQuery("DELETE FROM feed_posts WHERE id = ?", [id]).catch(() => {});
    await refund(u, cost, `${label} refund (not posted)`).catch(() => {});
    throw e;
  }
  console.log(`[feed] post ${id} by ${u.username} community=${roomIds.join(",")} files=${atts.length} link=${link ? link.domain : "-"} cost=${cost}`);
  const made = await get(id, u);
  // 1.99bz: followers who asked for it get an inbox notice (default off); never blocks the post
  if (made) {
    const pending = require("./follows").notifyNewPost(made, u.displayname || u.username);
    if (deps.awaitNotices) await pending;
  }
  return made;
}

// ── crossposts (1.99ci, Reddit's model; 1.99ct: several pads per action) ──
// A crosspost is its own feed_posts row (crosspost_of = the original) placed in ONE other pad: its own
// title, votes, comments, pins and moderation; it embeds the original's content (files are referenced, never
// copied). A crosspost of a crosspost points at the original. The target pad's rules all apply (who
// can post, its approval queue, bans, Pepe's refusals, the per-day limit) plus the account's post rate
// limits and price_post. The original's author gets an inbox notice. Once the original is deleted, hidden or
// taken out of all its pads, every crosspost shows "original removed" (decorate).
// 1.99ct: one action may target up to crosspost_max_pads pads; one crosspost row per pad, each pad checked on
// its own (partial success), price_post charged per crosspost created, every crosspost counts against the
// post rate limits (a selection bigger than what's left is refused as a whole, saying how many are left), and
// the original's author gets ONE combined notice ("crossposted your post to p/a, p/b").
async function crosspostOriginal(u, origId) {
  let o = await getRow(origId);
  if (o && o.crosspost_of) o = await getRow(o.crosspost_of);
  if (!o || o.deleted_at || (o.hidden_at && !isStaff(u))) throw new Refuse(404, "No such post.");
  const v = visibleSql(NOW());
  const shown = (await getQuery(`SELECT 1 FROM feed_posts p WHERE p.id = ? AND ${v.sql}`, [o.id, ...v.args]))[0];
  if (!shown && !isStaff(u)) throw new Refuse(409, "That post isn't visible in any pad, so it can't be crossposted.");
  return o;
}
/** null when `u` may crosspost `o` into pad R, else {status, message} (the rate limits are checked per action). */
async function crosspostRefusal(u, o, R) {
  const name = R.profile ? "your profile" : R.title;                  // 1.99df
  const here = (await getQuery("SELECT 1 FROM feed_post_rooms WHERE post_id = ? AND room_id = ? AND removed_at IS NULL", [o.id, R.id]))[0];
  if (here) return { status: 409, message: `That post is already in ${name}.` };
  const dup = (await getQuery(`SELECT x.id FROM feed_posts x JOIN feed_post_rooms pr ON pr.post_id = x.id AND pr.room_id = ? AND pr.removed_at IS NULL
                               WHERE x.crosspost_of = ? AND x.deleted_at IS NULL LIMIT 1`, [R.id, o.id]))[0];
  if (dup) return { status: 409, message: `It's already been crossposted to ${name}.` };
  return (await postRefusal(u, [R.id])) || (await roomPostRefusal(u, R.id));
}
/** One crosspost row in pad R (charged; rolled back + refunded on failure). -> {id, pending} */
async function crosspostOne(u, o, R, title, announce = true) {
  const pending = (await roomSettings(R.id)).approval && !(await rooms.canManage(u, R.id));
  const cost = CONFIG.price_post;
  const id = newId();
  const label = `feed crosspost ${id}`;
  await chargeFor(u, cost, label);
  try {
    const t = NOW();
    // nsfw: the original's effective flag at the time (the embed also follows the original live, see decorate)
    await runQuery("INSERT INTO feed_posts (id, author_id, title, nsfw, global, cost, created, crosspost_of, home_pad) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)",
                   [id, u.userId, title, effNsfw(o) ? 1 : 0, cost, t, o.id, R.id]);       // 1.99ep: a crosspost's home is its own pad
    await runQuery("INSERT INTO feed_post_rooms (post_id, room_id, created, pending) VALUES (?, ?, ?, ?)", [id, R.id, t, pending ? (announce ? 1 : 2) : 0]);
    if (!pending && announce) await queueMention(R.id, id);
    await runQuery("INSERT OR IGNORE INTO feed_votes (post_id, user_id, value, w, created, updated) VALUES (?, ?, 1, 1, ?, ?)", [id, u.userId, t, t]);
    await recountPost(id);
  } catch (e) {
    await runQuery("DELETE FROM feed_votes WHERE post_id = ?", [id]).catch(() => {});
    await runQuery("DELETE FROM feed_post_rooms WHERE post_id = ?", [id]).catch(() => {});
    await runQuery("DELETE FROM feed_posts WHERE id = ?", [id]).catch(() => {});
    await refund(u, cost, `${label} refund (not posted)`).catch(() => {});
    throw e;
  }
  console.log(`[feed] crosspost ${id} of ${o.id} by ${u.username} to ${R.id}${pending ? " (pending approval)" : ""}`);
  return { id, pending };
}
/**
 * 1.99ct: crosspost `origId` into several pads. input: {pads: [id|slug|p/slug, ...], title?}.
 * Whole-action refusals throw (sign in, no such post, no pads, over the cap, the account can't post at all,
 * the rate limits); per-pad refusals come back in the results.
 * -> {original, title, results: [{community, pad: {id, slug, title}|null, status: created|pending|refused,
 *     id?, url?, error?, code?}], created, pending, refused}
 */
async function crosspostMany(userId, origId, input = {}) {
  await init();
  const u = await account(userId);
  if (!u) throw new Refuse(401, "Sign in to crosspost.");
  const o = await crosspostOriginal(u, origId);
  const list = input.pads !== undefined ? input.pads : input.communities;
  const raw = Array.isArray(list) ? list : list != null ? [list] : [];
  const asked = [...new Set(raw.map((x) => String(x == null ? "" : x).trim().slice(0, 128)).filter(Boolean))];
  if (!asked.length) throw new Refuse(400, "Choose a pad to crosspost to.");
  const cap = CONFIG.crosspost_max_pads;
  if (asked.length > cap) throw new Refuse(400, `You can crosspost to at most ${cap} pad${cap === 1 ? "" : "s"} at a time.`);
  const acct = await postRefusal(u, []);
  if (acct) throw new Refuse(acct.status, acct.message);
  const results = [], go = [], seen = new Set();
  for (const k of asked) {
    // 1.99df: "u/<me>" / "profile" = share to my profile (Reddit's "share to profile"); someone else's profile is refused
    let R;
    try { R = await profileKey(u, k); } catch (e) { results.push({ community: k, pad: null, status: "refused", code: e.status || 403, error: e.message }); continue; }
    if (R === undefined) R = await communityOf(k);
    if (!R) { results.push({ community: k, pad: null, status: "refused", code: 400, error: `No such pad: ${k}.` }); continue; }
    if (seen.has(R.id)) continue;                                        // the same pad named twice (id + slug)
    seen.add(R.id);
    const res = { community: k, pad: { id: R.id, slug: padSlugOf(R, R.id), title: R.profile ? "Your profile" : R.title, label: padLabelOf(R, R.id), profile: profileName(R) } };
    const why = await crosspostRefusal(u, o, R);
    if (why) Object.assign(res, { status: "refused", code: why.status, error: why.message });
    else go.push([res, R]);
    results.push(res);
  }
  if (go.length && !isStaff(u) && !isPepe(u)) {
    // every crosspost is a post: the whole selection must fit what's left of the limits, or none is made
    const b = await postBudget(u);
    if (b.left <= 0) throw new Refuse(429, b.why);
    if (b.left < go.length) {
      throw new Refuse(429, `Each crosspost counts as a post, and you can post ${b.left} more time${b.left === 1 ? "" : "s"} right now - pick at most ${b.left} pad${b.left === 1 ? "" : "s"}.`);
    }
    const g = burst("post|" + u.userId, CONFIG.post_gap_secs * 1000);
    if (g) throw new Refuse(429, `Slow down - try again in ${g}s.`);
  }
  // 1.99cu: announce = the pads (ids/slugs) where the author left "Pepe announces it" ticked; none sent = every pad
  const ann = Array.isArray(input.announce) ? new Set(input.announce.map(String)) : null;
  const wantsAnnounce = (R) => !ann || ann.has(R.id) || ann.has(R.slug || "") || ann.has(padSlugOf(R, R.id));
  const olink = parseJson(o.link_json);
  const title = cleanLine(input.title, TITLE_MAX) || o.title || cleanLine(o.body, 100) || (olink && cleanLine(olink.title, 100)) || "Crosspost";
  for (const [res, R] of go) {
    try {
      const made = await crosspostOne(u, o, R, title, wantsAnnounce(R));
      Object.assign(res, { status: made.pending ? "pending" : "created", id: made.id, url: await postLink(made.id) });
    } catch (e) {
      if (!e.refuse) console.error(`[feed] crosspost ${o.id} -> ${R.id}:`, e);
      Object.assign(res, { status: "refused", code: e.refuse ? e.status : 500, error: e.refuse ? e.message : "Something went wrong - it wasn't posted." });
    }
  }
  const made = results.filter((r) => r.status === "created" || r.status === "pending");
  if (made.length && o.author_id !== u.userId) {
    const where = made.map((r) => (r.pad.profile ? "their profile" : r.pad.label || "p/" + r.pad.slug)).join(", ");
    await notify(o.author_id, { title: `${u.displayname || u.username} crossposted your post to ${where}`,
                                body: `"${(o.title || o.body || "your post").replace(/\s+/g, " ").slice(0, 80)}"`, link: made[0].url, ref: "feed-xp:" + made[0].id });
  }
  return { original: o.id, title, results, created: results.filter((r) => r.status === "created").length,
           pending: results.filter((r) => r.status === "pending").length, refused: results.filter((r) => r.status === "refused").length };
}
/** The 1.99ci single-pad crosspost ({community, title?}): refusals throw; -> the new post + pendingApproval. */
async function crosspost(userId, origId, input = {}) {
  const r = await crosspostMany(userId, origId, { pads: [input.community], title: input.title, announce: input.announce });
  const x = r.results[0];
  if (!x || x.status === "refused") throw new Refuse(x ? x.code : 400, x ? x.error : "Choose a pad to crosspost to.");
  return { ...(await get(x.id, await account(userId))), pendingApproval: x.status === "pending" };
}

/**
 * The community list (the /feed community bar, the composer's and the crosspost dialog's pickers): every
 * registered room with its follower and visible-post counts, and for `viewer` whether they may post there
 * (the account rules + the owner's who-can-post settings). -> [{id, slug, title, description, house,
 * community, followers, posts, canPost, refusal}], the Lounge first, then by followers and posts.
 */
async function communities(viewer = null) {
  await init();
  const list = await rooms.list();
  if (!list.length) return [];
  await require("./follows").init();
  const [F, P] = await Promise.all([
    getQuery("SELECT target_id, COUNT(*) AS n FROM follows WHERE target_kind = 'room' GROUP BY target_id"),
    getQuery(`SELECT pr.room_id, COUNT(DISTINCT p.id) AS n FROM feed_post_rooms pr JOIN feed_posts p ON p.id = pr.post_id
              WHERE p.deleted_at IS NULL AND p.hidden_at IS NULL AND pr.removed_at IS NULL AND pr.pending = 0 AND pr.hidden_at IS NULL
              GROUP BY pr.room_id`),
  ]);
  const fm = new Map(F.map((r) => [r.target_id, r.n])), pm = new Map(P.map((r) => [r.room_id, r.n]));
  const u = viewer && viewer.userId ? await account(viewer.userId) : null;
  const base = u ? await postRefusal(u, []) : { message: "Sign in to post." };
  const out = [];
  for (const R of list) {
    let refusal = base ? base.message : null;
    if (!refusal) {
      const r1 = (await postRefusal(u, [R.id])) || (await roomPostRefusal(u, R.id));
      refusal = r1 ? r1.message : null;
    }
    out.push({ id: R.id, slug: padSlugOf(R, R.id), title: R.title, description: R.description || "", house: !!R.house, community: !!R.community, platform: R.platform || rooms.platformOf(R.id),
               followers: fm.get(R.id) || 0, posts: pm.get(R.id) || 0, canPost: !refusal, refusal });
  }
  return out.sort((a, b) => (b.id === rooms.LOUNGE_ID) - (a.id === rooms.LOUNGE_ID) || b.followers - a.followers || b.posts - a.posts || a.title.localeCompare(b.title));
}

/** The homepage's "Hot on PATV": the top `limit` hot posts across All. Signed-out visitors never get NSFW ones. */
async function hot(viewer = null, limit = 5) {
  const signed = !!(viewer && viewer.userId);
  const L = await list({ sort: "hot", viewer: signed ? viewer : null, limit: Math.min(20, Math.max(1, limit)), sfw: !signed, pins: false });
  return L.posts.map((p) => {
    const R = p.rooms[0] || null;
    const q = p.xpost && p.xpost.post ? p.xpost.post : p;
    const lab = require("./postlabel").labelOf(p);      // 1.99ex: never a "no title" placeholder
    return { id: p.id, url: p.url, title: lab.text, titleFallback: lab.fallback,
             community: R ? { slug: R.slug, title: R.title, platform: R.id ? rooms.platformOf(R.id) : undefined, label: R.label, profile: R.profile || null } : null, score: p.score, comments: p.comments, nsfw: p.nsfw,
             thumb: p.nsfw ? null : thumbOf(p), crosspost: !!p.xpost, created: p.created,
             kind: q.video && q.video.length ? "video" : q.images && q.images.length ? "image" : q.audio && q.audio.length ? "audio" : q.link ? "link" : "text" };
  });
}

/** Author edit: title, body, nsfw. (Files, link and rooms stay - delete and repost to change those.) */
async function edit(user, id, patch) {
  const r = await getRow(id);
  if (!r || r.deleted_at) throw new Refuse(404, "No such post.");
  if (!user || user.userId !== r.author_id) throw new Refuse(403, "Only the author can edit a post.");
  const title = patch.title != null ? cleanLine(patch.title, TITLE_MAX) : r.title;
  const body = patch.body != null ? cleanText(patch.body, BODY_MAX) : r.body;
  const nsfw = patch.nsfw != null ? (patch.nsfw === true || patch.nsfw === 1 || patch.nsfw === "1" || patch.nsfw === "on" ? 1 : 0) : r.nsfw;
  if (!title && !body && !r.link_url && !r.crosspost_of && !(await getQuery("SELECT 1 FROM feed_attachments WHERE post_id = ? AND kind != 'preview' AND state = 'ready' LIMIT 1", [id])).length) {
    throw new Refuse(400, "A post can't be empty.");
  }
  // 1.99df: a profile post's "Also show in All" (the owner turns it off / on again any time; not an edit of the text)
  if (patch.inAll !== undefined && patch.inAll !== null) {
    const onProfile = (await getQuery("SELECT room_id FROM feed_post_rooms WHERE post_id = ?", [id])).some((x) => rooms.isProfile(x.room_id));
    if (onProfile) await runQuery("UPDATE feed_posts SET in_all = ? WHERE id = ?", [offFlag(patch.inAll) ? 0 : 1, id]);
  }
  const onlyInAll = patch.title == null && patch.body == null && patch.nsfw == null;
  if (!onlyInAll) await runQuery("UPDATE feed_posts SET title = ?, body = ?, nsfw = ?, edited = ? WHERE id = ?", [title || null, body || null, nsfw, NOW(), id]);
  return get(id, user);
}

/** Delete (author or site staff). Files are purged later (deleted_purge_days). */
async function remove(user, id, reason) {
  const r = await getRow(id);
  if (!r || r.deleted_at) throw new Refuse(404, "No such post.");
  const own = user && user.userId === r.author_id;
  if (!own && !isStaff(user)) throw new Refuse(403, "Only the author or an admin can delete a post.");
  await runQuery("UPDATE feed_posts SET deleted_at = ?, deleted_by = ?, delete_reason = ? WHERE id = ? AND deleted_at IS NULL",
                 [NOW(), own ? "author" : "admin:" + user.username, own ? null : cleanLine(reason, 200) || "removed by an admin", id]);
  await runQuery("UPDATE feed_reports SET resolved_at = ?, resolved_by = ?, action = 'deleted' WHERE post_id = ? AND resolved_at IS NULL", [NOW(), user.username, id]);
  await runQuery("DELETE FROM feed_mentions WHERE post_id = ? AND sent_at IS NULL", [id]);
  if (!own) {
    await notify(r.author_id, { title: "Your post was removed", body: `"${(r.title || r.body || "").slice(0, 80)}" was removed by an admin${reason ? ": " + cleanLine(reason, 200) : "."}`,
                          link: "/feed", ref: "feed-rm:" + id });
  }
  console.log(`[feed] post ${id} deleted by ${own ? "author" : user.username}`);
  return true;
}

/** A room owner (or staff) takes a post out of one room. */
async function removeFromRoom(user, id, roomId) {
  const p = await get(id, user);
  if (!p) throw new Refuse(404, "No such post.");
  if (!p.roomsAll.find((r) => r.id === roomId)) throw new Refuse(404, "That post isn't in that pad.");
  if (!(await rooms.canManage(user, roomId))) throw new Refuse(403, "Only this pad's owner can do that.");
  await runQuery("UPDATE feed_post_rooms SET removed_at = ?, removed_by = ? WHERE post_id = ? AND room_id = ? AND removed_at IS NULL",
                 [NOW(), user.username, id, roomId]);
  await runQuery("DELETE FROM feed_mentions WHERE post_id = ? AND room_id = ? AND sent_at IS NULL", [id, roomId]);
  await rooms.event(roomId, "feed-remove", user.username, id);
  return true;
}
async function restoreToRoom(user, id, roomId) {
  if (!(await rooms.canManage(user, roomId))) throw new Refuse(403, "Only this pad's owner can do that.");
  await runQuery("UPDATE feed_post_rooms SET removed_at = NULL, removed_by = NULL WHERE post_id = ? AND room_id = ?", [id, roomId]);
  await rooms.event(roomId, "feed-restore", user.username, id);
  return true;
}

/** Admin: force the NSFW flag (1/0) or give it back to the author (null). Also un-hides / hides. */
async function adminSet(user, id, { nsfw, hidden, locked } = {}) {
  if (!isStaff(user)) throw new Refuse(403, "Admins only.");
  const r = await getRow(id);
  if (!r) throw new Refuse(404, "No such post.");
  if (nsfw !== undefined) await runQuery("UPDATE feed_posts SET nsfw_admin = ? WHERE id = ?", [nsfw === null ? null : (nsfw ? 1 : 0), id]);
  if (locked !== undefined) await runQuery("UPDATE feed_posts SET locked_at = ?, locked_by = ? WHERE id = ?", [locked ? NOW() : null, locked ? user.username : null, id]);
  if (hidden !== undefined) {
    await runQuery("UPDATE feed_posts SET hidden_at = ? WHERE id = ?", [hidden ? NOW() : null, id]);
    if (!hidden) await runQuery("UPDATE feed_reports SET resolved_at = ?, resolved_by = ?, action = 'kept' WHERE post_id = ? AND resolved_at IS NULL", [NOW(), user.username, id]);
  }
  return get(id, user);
}

// ── votes ──
// Rules (1.99bx):
//  - one vote per account per post / comment: +1, -1 or none; `dir` is the state you want (idempotent),
//    so up -> down -> none is three requests and a repeated click can't double count
//  - your own post / comment starts with your +1 (you can take it back) and you can't downvote it
//  - a downvote from an account without a linked Camfrog name and below downvote_min_level is stored
//    (you see it highlighted) but doesn't count (w = 0) - anti-brigade; staff always count
//  - spam: votes_per_min / votes_per_hour vote CHANGES per account (posts + comments), a 300 ms gap per item
/** Normalise a requested vote: 1 | -1 | 0, or null for "toggle the upvote" (the 1.99bw API). */
function cleanDir(dir, on) {
  if (dir !== undefined && dir !== null && dir !== "") {
    const n = Number(dir);
    return n > 0 ? 1 : n < 0 ? -1 : 0;
  }
  if (on !== undefined) return on ? 1 : 0;
  return null;
}
const downCounts = (u, C = CONFIG) => !!u && (isStaff(u) || !!u.camfrogUsername || (Number(u.level) || 0) >= C.downvote_min_level);
const voteLog = new Map();      // userId -> [timestamps] of recent vote changes (in memory; resets on restart)
function voteRate(u) {
  if (isStaff(u)) return null;
  const t = NOW(), C = CONFIG;
  const arr = (voteLog.get(u.userId) || []).filter((x) => t - x < 3600e3);
  voteLog.set(u.userId, arr);
  if (arr.filter((x) => t - x < 60e3).length >= C.votes_per_min) return "You're voting very fast - take a breather.";
  if (arr.length >= C.votes_per_hour) return "You've voted a lot this hour - try again later.";
  return null;
}
function noteVote(u) {
  const arr = voteLog.get(u.userId) || [];
  arr.push(NOW());
  voteLog.set(u.userId, arr);
  if (voteLog.size > 20000) for (const [k, v] of voteLog) if (!v.length || NOW() - v[v.length - 1] > 3600e3) voteLog.delete(k);
}
async function voter(user) {
  if (!user || !user.userId) throw new Refuse(401, "Sign in to vote.");
  if (isPepe(user)) throw new Refuse(403, "Pepe doesn't vote.");
  const u = await account(user.userId);
  if (!u) throw new Refuse(401, "Sign in to vote.");
  if (u.archived_at) throw new Refuse(403, "This account is archived.");
  const ban = (await getQuery("SELECT 1 FROM feed_bans WHERE user_id = ? AND room_id = '' AND (until IS NULL OR until > ?)", [u.userId, NOW()]))[0];
  if (ban) throw new Refuse(403, "You can't vote on the feed right now.");
  return u;
}
/**
 * Shared vote write. table feed_votes | feed_comment_votes. -> {vote, counted, changed}
 */
async function applyVote(u, { table, key, id, authorId, postId }, dir, what) {
  const cur = (await getQuery(`SELECT value, w FROM ${table} WHERE ${key} = ? AND user_id = ?`, [id, u.userId]))[0];
  const now = cur ? (cur.value > 0 ? 1 : -1) : 0;
  let want = dir === null ? (now === 1 ? 0 : 1) : dir;
  if (want === -1 && u.userId === authorId) throw new Refuse(403, `You can't downvote your own ${what}.`);
  if (want === now) return { vote: now, counted: !cur || cur.w === 1, changed: false };
  const g = burst("vote|" + u.userId + "|" + id, 300);
  if (g) throw new Refuse(429, "Easy there.");
  const rate = voteRate(u);
  if (rate) throw new Refuse(429, rate);
  const w = want === -1 && !downCounts(u) ? 0 : 1;
  const t = NOW();
  if (want === 0) await runQuery(`DELETE FROM ${table} WHERE ${key} = ? AND user_id = ?`, [id, u.userId]);
  else if (table === "feed_votes") {
    await runQuery(`INSERT INTO feed_votes (post_id, user_id, value, w, created, updated) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(post_id, user_id) DO UPDATE SET value = excluded.value, w = excluded.w, updated = excluded.updated`, [id, u.userId, want, w, t, t]);
  } else {
    await runQuery(`INSERT INTO feed_comment_votes (comment_id, post_id, user_id, value, w, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(comment_id, user_id) DO UPDATE SET value = excluded.value, w = excluded.w, updated = excluded.updated`, [id, postId, u.userId, want, w, t, t]);
  }
  noteVote(u);
  return { vote: want, counted: want === 0 || w === 1, changed: true };
}

/** Vote on a post. dir: 1 | -1 | 0 (or undefined + on: the 1.99bw toggle). -> {vote, voted, score, ups, downs, counted} */
async function vote(user, id, dir, on) {
  const r = await getRow(id);
  if (!r || r.deleted_at || r.hidden_at) throw new Refuse(404, "No such post.");
  const u = await voter(user);
  const v = await applyVote(u, { table: "feed_votes", key: "post_id", id, authorId: r.author_id }, cleanDir(dir, on), "post");
  const c = v.changed ? await recountPost(id) : r;
  return { vote: v.vote, voted: v.vote === 1, counted: v.counted, score: c.score, ups: c.ups, downs: c.downs };
}

/** Vote on a comment (same rules). -> {vote, score, ups, downs, counted} */
async function voteComment(user, cid, dir) {
  const c = (await getQuery("SELECT * FROM feed_comments WHERE id = ?", [String(cid || "")]))[0];
  if (!c || c.deleted_at || c.hidden_at) throw new Refuse(404, "No such comment.");
  const p = await getRow(c.post_id);
  if (!p || p.deleted_at || p.hidden_at) throw new Refuse(404, "No such post.");
  const u = await voter(user);
  const v = await applyVote(u, { table: "feed_comment_votes", key: "comment_id", id: c.id, authorId: c.author_id, postId: c.post_id }, cleanDir(dir), "comment");
  const n = v.changed ? await recountComment(c.id) : c;
  return { vote: v.vote, counted: v.counted, score: n.score, ups: n.ups, downs: n.downs };
}

// ── comments (one level of replies) ──
const CSORTS = Object.freeze(["best", "top", "new", "controversial"]);
const cleanCSort = (s) => (CSORTS.includes(s) ? s : "best");
/** Comparator for a comment sort (best = Wilson lower bound, then older first). */
function commentOrder(sort) {
  const s = cleanCSort(sort);
  if (s === "new") return (a, b) => b.created - a.created;
  if (s === "top") return (a, b) => b.score - a.score || b.ups - a.ups || a.created - b.created;
  if (s === "controversial") return (a, b) => controversy(b.ups, b.downs) - controversy(a.ups, a.downs) || (b.ups + b.downs) - (a.ups + a.downs) || b.created - a.created;
  return (a, b) => wilson(b.ups, b.downs) - wilson(a.ups, a.downs) || b.score - a.score || a.created - b.created;
}

/** A post's comments, threaded one level, each level sorted by `sort` (best|top|new|controversial). */
async function comments(postId, viewer, sort = "best") {
  await init();
  const rows = await getQuery("SELECT * FROM feed_comments WHERE post_id = ? ORDER BY created", [postId]);
  const A = await authors(rows.map((r) => r.author_id));
  const mine = viewer && viewer.userId
    ? new Map((await getQuery("SELECT comment_id, value FROM feed_comment_votes WHERE post_id = ? AND user_id = ?", [postId, viewer.userId])).map((v) => [v.comment_id, v.value > 0 ? 1 : -1]))
    : new Map();
  // 1.99cc: a comment hidden by an urgent report is gone for everyone but staff (it shows to them, tagged)
  const staff = isStaff(viewer);
  const gone = (c) => !!c.deleted_at || (!!c.hidden_at && !staff);
  const all = rows.map((c) => ({ id: c.id, parent: c.parent_id, body: gone(c) ? "" : c.body, deleted: gone(c), hidden: !!c.hidden_at && staff, created: c.created, edited: c.edited,
    author: gone(c) ? null : A.get(c.author_id) || { username: "[gone]", display: "[deleted account]" },
    ups: c.ups || 0, downs: c.downs || 0, score: c.score || 0, myVote: mine.get(c.id) || 0,
    mine: !!(viewer && viewer.userId === c.author_id && !gone(c)), replies: [] }));
  const top = [], byId = new Map(all.map((c) => [c.id, c]));
  for (const c of all) {
    if (c.parent && byId.has(c.parent)) byId.get(c.parent).replies.push(c);
    else top.push(c);
  }
  const cmp = commentOrder(sort);
  // a deleted comment with no replies just goes away
  return top.filter((c) => !c.deleted || c.replies.some((r) => !r.deleted)).sort(cmp)
    // 1.99cg: a conversation Pepe is part of reads in time order (his answers make no sense shuffled; his replies
    // also start at 0 with no self-vote, so "best" would sink every one of them under the line it answers)
    .map((c) => {
      const kids = c.replies.filter((r) => !r.deleted);
      const withPepe = c.author && c.author.bot || kids.some((r) => r.author && r.author.bot);
      return { ...c, replies: kids.sort(withPepe ? (a, b) => a.created - b.created : cmp) };
    });
}

async function comment(user, postId, { body, parent } = {}) {
  const p = await getRow(postId);
  if (!p || p.deleted_at || p.hidden_at) throw new Refuse(404, "No such post.");
  const u = await account(user && user.userId);
  if (!u) throw new Refuse(401, "Sign in to comment.");
  if (p.locked_at && !(await canLock(u, p.id))) throw new Refuse(403, "Comments on this post are locked.");
  const roomIds = (await getQuery("SELECT room_id FROM feed_post_rooms WHERE post_id = ? AND removed_at IS NULL", [postId])).map((r) => r.room_id);
  const refusal = await postRefusal(u, roomIds);
  if (refusal) throw new Refuse(refusal.status, refusal.message.replace("to post", "to comment"));
  const text = cleanText(body, COMMENT_MAX);
  if (!text) throw new Refuse(400, "Write something first.");
  if (!isStaff(u) && !isPepe(u)) {
    const n = (await getQuery("SELECT COUNT(*) AS n FROM feed_comments WHERE author_id = ? AND created > ?", [u.userId, NOW() - 3600e3]))[0].n;
    if (n >= CONFIG.comments_per_hour) throw new Refuse(429, "You've commented a lot this hour - try again later.");
    if (isNewAccount(u) && n >= 10) throw new Refuse(429, "New accounts can comment 10 times an hour - link your Camfrog name (!verify) to lift that.");
    const g = burst("comment|" + u.userId, CONFIG.comment_gap_secs * 1000);
    if (g) throw new Refuse(429, `Slow down - try again in ${g}s.`);
  }
  let par = null;
  if (parent) {
    par = (await getQuery("SELECT * FROM feed_comments WHERE id = ? AND post_id = ?", [String(parent), postId]))[0];
    if (!par || par.deleted_at || par.hidden_at) throw new Refuse(404, "That comment is gone.");
    if (par.parent_id) par = (await getQuery("SELECT * FROM feed_comments WHERE id = ?", [par.parent_id]))[0] || par;   // replies stay one level deep
  }
  const id = newId(10);
  const t = NOW();
  await runQuery("INSERT INTO feed_comments (id, post_id, parent_id, author_id, body, created) VALUES (?, ?, ?, ?, ?, ?)",
                 [id, postId, par ? par.id : null, u.userId, text, t]);
  if (!isPepe(u)) await runQuery("INSERT OR IGNORE INTO feed_comment_votes (comment_id, post_id, user_id, value, w, created, updated) VALUES (?, ?, ?, 1, 1, ?, ?)", [id, postId, u.userId, t, t]);
  await recountComment(id);
  await recount(postId);
  // notices: the post's author, and the person replied to (never yourself, never twice)
  const who = u.displayname || u.username;
  const what = (p.title || p.body || "your post").replace(/\s+/g, " ").slice(0, 60);
  const link = await postLink(postId, "#c-" + id);
  const told = new Set([u.userId]);
  if (par && !told.has(par.author_id)) {
    told.add(par.author_id);
    await notify(par.author_id, { title: `${who} replied to your comment`, body: `On "${what}": ${text.slice(0, 200)}`, link, ref: "feed-c:" + id + ":p" });
  }
  if (!told.has(p.author_id)) {
    await notify(p.author_id, { title: `${who} commented on your post`, body: `"${what}": ${text.slice(0, 200)}`, link, ref: "feed-c:" + id });
  }
  return { id };
}
async function recount(postId) {
  const n = (await getQuery("SELECT COUNT(*) AS n FROM feed_comments WHERE post_id = ? AND deleted_at IS NULL", [postId]))[0].n;
  await runQuery("UPDATE feed_posts SET comments = ? WHERE id = ?", [n, postId]);
}
async function editComment(user, id, body) {
  const c = (await getQuery("SELECT * FROM feed_comments WHERE id = ?", [String(id)]))[0];
  if (!c || c.deleted_at || c.hidden_at) throw new Refuse(404, "No such comment.");
  if (!user || user.userId !== c.author_id) throw new Refuse(403, "Only the author can edit a comment.");
  const text = cleanText(body, COMMENT_MAX);
  if (!text) throw new Refuse(400, "A comment can't be empty.");
  await runQuery("UPDATE feed_comments SET body = ?, edited = ? WHERE id = ?", [text, NOW(), c.id]);
  return true;
}
/** Author, site staff, or the owner of a room the post is in. */
async function removeComment(user, id, reason) {
  const c = (await getQuery("SELECT * FROM feed_comments WHERE id = ?", [String(id)]))[0];
  if (!c || c.deleted_at) throw new Refuse(404, "No such comment.");
  let ok = user && (user.userId === c.author_id || isStaff(user));
  if (!ok && user) {
    for (const r of await getQuery("SELECT room_id FROM feed_post_rooms WHERE post_id = ?", [c.post_id])) {
      if (await rooms.canManage(user, r.room_id)) { ok = true; break; }
    }
  }
  if (!ok) throw new Refuse(403, "You can't delete that comment.");
  const own = user.userId === c.author_id;
  await runQuery("UPDATE feed_comments SET deleted_at = ?, deleted_by = ? WHERE id = ?", [NOW(), own ? "author" : user.username, c.id]);
  await runQuery("UPDATE feed_reports SET resolved_at = ?, resolved_by = ?, action = 'deleted' WHERE comment_id = ? AND resolved_at IS NULL", [NOW(), user.username, c.id]);
  await recount(c.post_id);
  if (!own) {
    const why = cleanLine(reason, 200);
    await notify(c.author_id, { title: "Your comment was removed", body: `"${cleanLine(c.body, 80)}" was removed by a moderator${why ? ": " + why : "."}`,
                                link: await postLink(c.post_id), ref: "feed-crm:" + c.id });
    if (!isStaff(user)) {
      for (const r of await getQuery("SELECT room_id FROM feed_post_rooms WHERE post_id = ?", [c.post_id])) {
        if (await rooms.canManage(user, r.room_id)) await rooms.event(r.room_id, "feed-comment-remove", user.username, `${c.id} on ${c.post_id}${why ? ": " + why : ""}`);
      }
    }
  }
  return true;
}

// ── reports (1.99cc: reasons v2, the report modal, rate limits, the urgent path, user reports, outcomes) ──
// OFFERED is the modal's menu, in order. ADMIN_ONLY reasons never reach a room owner's queue (legal /
// safety calls are the site's). URGENT: ONE report hides the post / comment at once (unless the reporter
// is paused or banned - then it still pings) and every admin gets an urgent inbox notice, every time.
const REASONS = {
  spam: "Spam", harassment: "Harassment or bullying", hate: "Hate", csam: "Sexual content involving a minor",
  ncii: "Non-consensual intimate imagery", violence: "Violence or threats", impersonation: "Impersonation",
  copyright: "Copyright infringement", personal: "Personal info / doxxing", nsfw: "Unmarked NSFW", other: "Something else",
  abuse: "Harassment or hate", illegal: "Illegal content",          // 1.99bw keys: still accepted, labelled
  automod: "Breaks the pad's rules (Pepe automod)",                // 1.99dc: Pepe's automod flags on a pad rule (never in the menu)
};
const HINTS = {
  spam: "Ads, scams, repeated junk or fake engagement.",
  harassment: "Targeting, insulting or ganging up on someone.",
  hate: "Attacks on people for who they are (race, religion, gender, sexuality, disability...).",
  csam: "Any sexual content involving someone under 18. It's hidden at once and goes straight to the site admins.",
  ncii: "Intimate pictures or video of someone shared without their consent. Admins only.",
  violence: "Threats, incitement or glorifying violence against someone.",
  impersonation: "Pretending to be another person, a pad or PATV staff.",
  copyright: "Your work posted without permission. Admins only - see the Terms for a full notice.",
  personal: "Someone's address, phone, real name, workplace or other private info.",
  nsfw: "Adult content that isn't marked NSFW.",
  other: "Something else that breaks the Terms - tell us in the note.",
};
const OFFERED = Object.freeze(["spam", "harassment", "hate", "csam", "ncii", "violence", "impersonation", "copyright", "personal", "nsfw", "other"]);
const USER_OFFERED = Object.freeze(["spam", "harassment", "hate", "csam", "violence", "impersonation", "personal", "other"]);
const ADMIN_ONLY = Object.freeze(["csam", "ncii", "copyright", "illegal"]);
const URGENT = Object.freeze(["csam"]);
/** The modal's menu: [{key, label, hint, adminOnly, urgent}] (posts + comments, or users). */
const reportMenu = (forUser = false) => (forUser ? USER_OFFERED : OFFERED).map((k) => ({ key: k, label: REASONS[k], hint: HINTS[k] || "",
  adminOnly: ADMIN_ONLY.includes(k), urgent: URGENT.includes(k) }));
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Who may report, how often. -> {u, trusted}. trusted = false: the reporter is paused (false_reports_pause
 * bad-faith reports in 30 days) or feed-banned - only an urgent report still goes through, and it doesn't hide.
 */
async function reportGate(user, reason) {
  if (!user || !user.userId) throw new Refuse(401, "Sign in to report.");
  const u = await account(user.userId);
  if (!u) throw new Refuse(401, "Sign in to report.");
  if (u.archived_at) throw new Refuse(403, "This account is archived.");
  const g = burst("report|" + u.userId, 3000);
  if (g) throw new Refuse(429, `Slow down - try again in ${g}s.`);
  if (isStaff(u)) return { u, trusted: true };
  const t = NOW(), C = CONFIG;
  const urgent = URGENT.includes(reason);
  const cnt = async (since, extra = "") => (await getQuery(`SELECT (SELECT COUNT(*) FROM feed_reports WHERE reporter_id = ?1 AND created > ?2 ${extra})
                                                           + (SELECT COUNT(*) FROM user_reports WHERE reporter_id = ?1 AND created > ?2 ${extra}) AS n`, [u.userId, since]))[0].n;
  const paused = (await cnt(t - 30 * 86400e3, "AND action = 'false'")) >= C.false_reports_pause;
  const banned = !!(await getQuery("SELECT 1 FROM feed_bans WHERE user_id = ? AND room_id = '' AND (until IS NULL OR until > ?)", [u.userId, t]))[0];
  if ((paused || banned) && !urgent) {
    throw new Refuse(403, paused ? "Your reports are paused for a while - several recent ones were found to be made in bad faith." : "You can't report on the feed right now.");
  }
  const perHour = Math.max(urgent ? 1 : 0, isNewAccount(u) ? C.new_account_reports_per_hour : C.reports_per_hour);
  if ((await cnt(t - 3600e3)) >= perHour) throw new Refuse(429, "You've sent a lot of reports this hour - try again later.");
  if ((await cnt(t - 86400e3)) >= C.reports_per_day) throw new Refuse(429, "You've hit today's report limit.");
  return { u, trusted: !(paused || banned) };
}

async function admins() { return getQuery("SELECT userId FROM users WHERE class = 'Admin'"); }
/** The urgent path: an inbox notice to EVERY admin for EVERY such report (ref = the report id). */
async function urgentNotice(what, reportId, hidden) {
  for (const a of await admins()) {
    await notify(a.userId, { kind: "admin", title: `URGENT: ${what} reported as sexual content involving a minor`,
                            body: `${hidden ? "It's hidden from everyone but admins until you review it." : "The reporter's reports are paused, so it was NOT hidden - review it now."} Review it on the feed admin page. Don't download or share it; follow the CSAM procedure.`,
                            link: "/feed/admin#urgent", ref: "feed-urgent:" + reportId });
  }
}

/** Report a post or a comment (1.99bw API; reasons v2). -> {ok, already?, urgent?} */
async function report(user, { post, comment: cid, reason, note } = {}) {
  if (!user || !user.userId) throw new Refuse(401, "Sign in to report.");
  const p = await getRow(post);
  if (!p || p.deleted_at) throw new Refuse(404, "No such post.");
  let c = null;
  if (cid) {
    c = (await getQuery("SELECT id, author_id, deleted_at, hidden_at FROM feed_comments WHERE id = ? AND post_id = ?", [String(cid), p.id]))[0];
    if (!c || c.deleted_at) throw new Refuse(404, "No such comment.");
  }
  if (user.userId === (c ? c.author_id : p.author_id)) throw new Refuse(400, `You can't report your own ${c ? "comment" : "post"}.`);
  const why = has(REASONS, reason) ? reason : "other";
  const { trusted } = await reportGate(user, why);
  const r = await runQuery("INSERT OR IGNORE INTO feed_reports (post_id, comment_id, reporter_id, reason, note, created) VALUES (?, ?, ?, ?, ?, ?)",
                           [p.id, c ? c.id : null, user.userId, why, cleanLine(note, 300) || null, NOW()]);
  if (!r.changes) return { ok: true, already: true };
  if (URGENT.includes(why)) {
    if (trusted) {
      if (c) await runQuery("UPDATE feed_comments SET hidden_at = ? WHERE id = ? AND hidden_at IS NULL", [NOW(), c.id]);
      else await runQuery("UPDATE feed_posts SET hidden_at = ? WHERE id = ? AND hidden_at IS NULL", [NOW(), p.id]);
      await runQuery("DELETE FROM feed_mentions WHERE post_id = ? AND sent_at IS NULL", [p.id]);
    }
    console.error(`[feed] URGENT report #${r.id || "?"} (${why}) on ${c ? "comment " + c.id + " of " : ""}post ${p.id}${trusted ? " - hidden pending review" : " - reporter paused, not hidden"}`);
    await urgentNotice(c ? "A comment" : "A post", r.id || `${p.id}:${c ? c.id : ""}:${user.userId}`, trusted);
    return { ok: true, urgent: true };
  }
  // enough distinct, established reporters -> hidden until an admin looks
  if (!c && !p.hidden_at) {
    const reps = await getQuery("SELECT reporter_id FROM feed_reports WHERE post_id = ? AND comment_id IS NULL AND resolved_at IS NULL", [p.id]);
    let n = 0;
    for (const x of reps) if (!isNewAccount(await account(x.reporter_id))) n++;
    if (n >= CONFIG.report_hide_threshold) {
      await runQuery("UPDATE feed_posts SET hidden_at = ? WHERE id = ? AND hidden_at IS NULL", [NOW(), p.id]);
      console.log(`[feed] post ${p.id} hidden pending review (${n} reports)`);
    }
  }
  // tell the admins once per post
  const open = (await getQuery("SELECT COUNT(*) AS n FROM feed_reports WHERE post_id = ? AND resolved_at IS NULL", [p.id]))[0].n;
  if (open === 1) {
    for (const a of await admins()) {
      await notify(a.userId, { kind: "admin", title: `A feed ${c ? "comment" : "post"} was reported`, body: `${REASONS[why]}: "${(p.title || p.body || "").slice(0, 80)}"`, link: "/feed/admin", ref: "feed-rep:" + p.id + ":" + p.created });
    }
  }
  return { ok: true };
}

/** Report an account (profile "Report user"). -> {ok, already?, urgent?} */
async function reportUser(user, { username, reason, note } = {}) {
  if (!user || !user.userId) throw new Refuse(401, "Sign in to report.");
  await init();
  const target = (await getQuery("SELECT userId, username FROM users WHERE LOWER(username) = LOWER(?) LIMIT 2", [String(username || "").trim().slice(0, 64)]));
  if (target.length !== 1) throw new Refuse(404, "No such user.");
  const T = target[0];
  if (T.userId === user.userId) throw new Refuse(400, "You can't report yourself.");
  const why = has(REASONS, reason) ? reason : "other";
  await reportGate(user, why);
  const dup = (await getQuery("SELECT id FROM user_reports WHERE target_id = ? AND reporter_id = ? AND resolved_at IS NULL", [T.userId, user.userId]))[0];
  if (dup) return { ok: true, already: true };
  const r = await runQuery("INSERT INTO user_reports (target_id, reporter_id, reason, note, created) VALUES (?, ?, ?, ?, ?)",
                           [T.userId, user.userId, why, cleanLine(note, 300) || null, NOW()]);
  if (URGENT.includes(why)) {
    console.error(`[feed] URGENT user report #${r.id} (${why})`);
    for (const a of await admins()) {
      await notify(a.userId, { kind: "admin", title: "URGENT: an account was reported for sexual content involving a minor",
                              body: `Account: ${T.username}. Review it on the feed admin page now.`, link: "/feed/admin#users", ref: "user-urgent:" + r.id });
    }
    return { ok: true, urgent: true };
  }
  const open = (await getQuery("SELECT COUNT(*) AS n FROM user_reports WHERE target_id = ? AND resolved_at IS NULL", [T.userId]))[0].n;
  if (open === 1) {
    for (const a of await admins()) {
      await notify(a.userId, { kind: "admin", title: "An account was reported", body: `${REASONS[why]}: ${T.username}`, link: "/feed/admin#users", ref: "user-rep:" + T.userId + ":" + r.id });
    }
  }
  return { ok: true };
}

/** The admin queue: open reports grouped per post, urgent groups first. Shape (1.99bw): [{post, reports, urgent}] */
async function reports({ open = true } = {}) {
  await init();
  const rows = await getQuery(`SELECT r.*, u.username AS reporter FROM feed_reports r LEFT JOIN users u ON u.userId = r.reporter_id
                               ${open ? "WHERE r.resolved_at IS NULL" : ""} ORDER BY r.id DESC LIMIT 300`);
  const byPost = new Map();
  for (const r of rows) {
    if (!byPost.has(r.post_id)) byPost.set(r.post_id, []);
    byPost.get(r.post_id).push(r);
  }
  const posts = await decorate(await getQuery(`SELECT * FROM feed_posts WHERE id IN (${[...byPost.keys()].map(() => "?").join(",") || "''"})`, [...byPost.keys()]), { class: "Admin", userId: "_" });
  const cmts = rows.filter((r) => r.comment_id).map((r) => r.comment_id);
  const C = cmts.length ? await getQuery(`SELECT c.id, c.body, c.deleted_at, c.hidden_at, c.author_id, u.username FROM feed_comments c LEFT JOIN users u ON u.userId = c.author_id
                                          WHERE c.id IN (${cmts.map(() => "?").join(",")})`, cmts) : [];
  return posts.map((p) => {
    const reps = byPost.get(p.id).map((r) => ({ ...r, label: REASONS[r.reason] || r.reason, urgent: URGENT.includes(r.reason), adminOnly: ADMIN_ONLY.includes(r.reason),
                                                comment: r.comment_id ? C.find((c) => c.id === r.comment_id) || null : null }));
    // per target (the post itself, each reported comment): the admin acts on one target at a time
    const targets = new Map();
    for (const r of reps) {
      const k = r.comment_id || "";
      if (!targets.has(k)) targets.set(k, { comment: r.comment, commentId: r.comment_id || null, reports: [], urgent: false });
      const g = targets.get(k);
      g.reports.push(r);
      g.urgent = g.urgent || r.urgent;
    }
    return { post: p, reports: reps, urgent: reps.some((r) => r.urgent), targets: [...targets.values()].sort((a, b) => (b.urgent - a.urgent) || ((a.commentId ? 1 : 0) - (b.commentId ? 1 : 0))) };
  }).sort((a, b) => (b.urgent - a.urgent));
}
async function resolveReports(user, postId, action) {
  if (!isStaff(user)) throw new Refuse(403, "Admins only.");
  await runQuery("UPDATE feed_reports SET resolved_at = ?, resolved_by = ?, action = ? WHERE post_id = ? AND resolved_at IS NULL", [NOW(), user.username, cleanLine(action, 20) || "dismissed", postId]);
  return true;
}

const ACTIONS = Object.freeze(["dismiss", "false", "remove", "ban"]);
/** Tell each reporter once what happened (never who / why beyond the outcome). */
async function tellReporters(rows, what, outcome) {
  const told = new Set();
  for (const r of rows) {
    if (told.has(r.reporter_id)) continue;
    told.add(r.reporter_id);
    const label = REASONS[r.reason] || r.reason;
    const body = outcome === "removed"
      ? `We removed the ${what} you reported (${label}). Thanks for helping keep PATV safe.`
      : `We reviewed the ${what} you reported (${label}) and it doesn't break the Terms, so it stays up. Thanks for flagging it.`;
    await notify(r.reporter_id, { kind: "feed", title: "Update on your report", body, link: "/terms", ref: "feed-repout:" + (r.table || "p") + r.id });
  }
}

/**
 * Admin outcome on the open reports about one post (comment null) or one comment.
 * action: dismiss | false (dismiss as bad faith: counts against the reporters) | remove | ban (remove + feed ban).
 * tell (default true): each reporter gets an inbox notice of the outcome. -> {ok, resolved, notified}
 */
async function reportAction(user, { post, comment = null, action, tell = true, days = 0, reason = "" } = {}) {
  if (!isStaff(user)) throw new Refuse(403, "Admins only.");
  if (!ACTIONS.includes(action)) throw new Refuse(400, "Unknown action.");
  const p = await getRow(post);
  if (!p) throw new Refuse(404, "No such post.");
  let c = null;
  if (comment) {
    c = (await getQuery("SELECT * FROM feed_comments WHERE id = ? AND post_id = ?", [String(comment), p.id]))[0];
    if (!c) throw new Refuse(404, "No such comment.");
  }
  const open = await getQuery(`SELECT * FROM feed_reports WHERE post_id = ? AND ${c ? "comment_id = ?" : "comment_id IS NULL"} AND resolved_at IS NULL`, c ? [p.id, c.id] : [p.id]);
  const why = cleanLine(reason, 200);
  if (action === "dismiss" || action === "false") {
    if (c && c.hidden_at) await runQuery("UPDATE feed_comments SET hidden_at = NULL WHERE id = ?", [c.id]);
    if (!c && p.hidden_at) await runQuery("UPDATE feed_posts SET hidden_at = NULL WHERE id = ?", [p.id]);
  } else {
    if (c) { if (!c.deleted_at) await removeComment(user, c.id, why || "removed after a report"); }
    else if (!p.deleted_at) await remove(user, p.id, why || "removed after a report");
    if (action === "ban") {
      const A = (await getQuery("SELECT username FROM users WHERE userId = ?", [c ? c.author_id : p.author_id]))[0];
      if (A) await ban(user, A.username, { room: "", reason: why || "reported content", days });
    }
  }
  const act = action === "dismiss" ? "dismissed" : action === "false" ? "false" : action === "ban" ? "banned" : "removed";
  if (open.length) {
    await runQuery(`UPDATE feed_reports SET resolved_at = ?, resolved_by = ?, action = ? WHERE id IN (${open.map(() => "?").join(",")})`,
                   [NOW(), user.username, act, ...open.map((r) => r.id)]);
  }
  let notified = 0;
  if (tell && open.length) {
    await tellReporters(open, c ? "comment" : "post", action === "remove" || action === "ban" ? "removed" : "kept");
    await runQuery(`UPDATE feed_reports SET notified_at = ? WHERE id IN (${open.map(() => "?").join(",")})`, [NOW(), ...open.map((r) => r.id)]);
    notified = new Set(open.map((r) => r.reporter_id)).size;
  }
  console.log(`[feed] reports on ${c ? "comment " + c.id + " of " : ""}post ${p.id}: ${act} by ${user.username} (${open.length} report${open.length === 1 ? "" : "s"})`);
  return { ok: true, resolved: open.length, notified };
}

/** Open account reports, grouped per account. */
async function userReports() {
  await init();
  const rows = await getQuery(`SELECT r.*, u.username AS reporter, t.username AS target FROM user_reports r LEFT JOIN users u ON u.userId = r.reporter_id
                               LEFT JOIN users t ON t.userId = r.target_id WHERE r.resolved_at IS NULL ORDER BY r.id DESC LIMIT 300`);
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.target_id)) by.set(r.target_id, { userId: r.target_id, username: r.target || "[gone]", reports: [], urgent: false });
    const g = by.get(r.target_id);
    g.reports.push({ ...r, label: REASONS[r.reason] || r.reason, urgent: URGENT.includes(r.reason) });
    g.urgent = g.urgent || URGENT.includes(r.reason);
  }
  return [...by.values()].sort((a, b) => (b.urgent - a.urgent) || b.reports.length - a.reports.length);
}
/** Admin outcome on an account's open reports. action: dismiss | false | ban. */
async function userReportAction(user, { userId, action, tell = true, days = 0, reason = "" } = {}) {
  if (!isStaff(user)) throw new Refuse(403, "Admins only.");
  if (!["dismiss", "false", "ban"].includes(action)) throw new Refuse(400, "Unknown action.");
  const T = (await getQuery("SELECT userId, username FROM users WHERE userId = ?", [String(userId || "")]))[0];
  if (!T) throw new Refuse(404, "No such user.");
  const open = await getQuery("SELECT * FROM user_reports WHERE target_id = ? AND resolved_at IS NULL", [T.userId]);
  if (action === "ban") await ban(user, T.username, { room: "", reason: cleanLine(reason, 200) || "reported account", days });
  const act = action === "dismiss" ? "dismissed" : action === "false" ? "false" : "banned";
  if (open.length) await runQuery(`UPDATE user_reports SET resolved_at = ?, resolved_by = ?, action = ? WHERE id IN (${open.map(() => "?").join(",")})`, [NOW(), user.username, act, ...open.map((r) => r.id)]);
  if (tell && open.length) {
    const told = new Set();
    for (const r of open) {
      if (told.has(r.reporter_id)) continue;
      told.add(r.reporter_id);
      await notify(r.reporter_id, { kind: "feed", title: "Update on your report",
        body: action === "ban" ? `We took action on the account you reported (${REASONS[r.reason] || r.reason}). Thanks for helping keep PATV safe.`
                               : `We reviewed the account you reported (${REASONS[r.reason] || r.reason}) and didn't find a breach of the Terms. Thanks for flagging it.`,
        link: "/terms", ref: "user-repout:" + r.id });
    }
    await runQuery(`UPDATE user_reports SET notified_at = ? WHERE id IN (${open.map(() => "?").join(",")})`, [NOW(), ...open.map((r) => r.id)]);
  }
  return { ok: true, resolved: open.length };
}

// ── feed bans (site staff: whole feed or a room; room owners: their room) ──
async function ban(user, target, { room = "", reason = "", days = 0 } = {}) {
  const roomId = String(room || "");
  if (roomId ? !(await rooms.canManage(user, roomId)) : !isStaff(user)) throw new Refuse(403, roomId ? "Only this pad's owner can do that." : "Admins only.");
  const u = await rooms.findUser(target);
  if (!u) throw new Refuse(404, `No single PATV account named "${String(target).slice(0, 40)}".`);
  if (roomId && rooms.isProfile(roomId) && u.userId === roomId.slice(rooms.PROFILE_PREFIX.length)) throw new Refuse(400, "That's you.");   // 1.99df
  const until = Number(days) > 0 ? NOW() + Math.min(3650, Number(days)) * 86400e3 : null;
  await runQuery("INSERT OR REPLACE INTO feed_bans (user_id, room_id, username, reason, by, at, until) VALUES (?, ?, ?, ?, ?, ?, ?)",
                 [u.userId, roomId, u.username, cleanLine(reason, 200) || null, user.username, NOW(), until]);
  if (roomId) await rooms.event(roomId, "feed-ban", user.username, `${u.username}${until ? " until " + new Date(until).toISOString() : ""}`);
  return { userId: u.userId, username: u.username, until };
}
async function unban(user, userId, room = "") {
  const roomId = String(room || "");
  if (roomId ? !(await rooms.canManage(user, roomId)) : !isStaff(user)) throw new Refuse(403, "Not allowed.");
  await runQuery("DELETE FROM feed_bans WHERE user_id = ? AND room_id = ?", [String(userId), roomId]);
  return true;
}
async function bans(room = null) {
  await init();
  if (room === null) return getQuery("SELECT * FROM feed_bans ORDER BY at DESC LIMIT 500");
  return getQuery("SELECT * FROM feed_bans WHERE room_id = ? ORDER BY at DESC", [String(room)]);
}

// ── Pepe: his refusals (synced) and the room mention queue ──
/** Replace the restricted list with Pepe's current one: [{login, room, reason, until (ms)}]. */
async function setRestricted(list) {
  await init();
  if (!Array.isArray(list)) return 0;
  const rows = [];
  for (const x of list.slice(0, 5000)) {
    const login = String((x && x.login) || "").trim().toLowerCase();
    if (!/^[\w.\-]{1,40}$/.test(login)) continue;
    const until = Number(x.until) > 0 ? Math.floor(Number(x.until)) : null;
    rows.push([login, String(x.room || "").slice(0, 128), cleanLine(x.reason, 80) || null, until]);
  }
  await runQuery("DELETE FROM feed_restricted");
  for (const r of rows) await runQuery("INSERT OR REPLACE INTO feed_restricted (login, room_id, reason, until) VALUES (?, ?, ?, ?)", r);
  return rows.length;
}

// 1.99cu: room announcements are ON by default for every pad with a Camfrog room (site/Twitch/Discord pads have
// none, so never). Same explicit-vs-default trick as 1.99cq's vision: a stored "mention:<room>" value only counts
// once "mention_set:<room>" marks it as an owner's explicit choice; unmarked values (the old default-off era)
// follow the new default. migrateMentionDefault() marks the old explicit choices once.
async function mentionOn(roomId) {
  await init();
  const id = String(roomId || "");
  if (!id || rooms.platformOf(id) !== "camfrog") return false;
  if ((await kvGet("mention_set:" + id)) === "1") return (await kvGet("mention:" + id)) === "1";
  return true;
}
async function setMention(user, roomId, on) {
  if (!(await rooms.canManage(user, roomId))) throw new Refuse(403, "Only this pad's owner can do that.");
  await init();
  await kvSet("mention:" + roomId, on ? "1" : "0");
  await kvSet("mention_set:" + roomId, "1");
  await rooms.event(roomId, "feed-mention", user.username, on ? "on" : "off");
  return !!on;
}
/**
 * 1.99cu, once (feed_kv mention_v1): announcements went default OFF -> ON. A stored "1" is an owner's explicit ON
 * (marked). A stored "0" is an explicit OFF only if the pad's event log shows announcements switched on at some
 * point (an owner turned them on, then off again) - those stay OFF; the rest follow the new default (ON).
 * -> {on: [pads now on by default], kept: [explicit offs kept], marked: [explicit ons]} | null when already done
 */
async function migrateMentionDefault() {
  if ((await kvGet("mention_v1")) === "1") return null;
  const out = { on: [], kept: [], marked: [] };
  const rows = await getQuery("SELECT key, value FROM feed_kv WHERE key LIKE 'mention:%'");
  for (const r of rows) {
    const id = r.key.slice("mention:".length);
    if (!id || (await kvGet("mention_set:" + id)) === "1") continue;
    if (r.value === "1") { await kvSet("mention_set:" + id, "1"); out.marked.push(id); continue; }
    let was = null;
    try { was = (await getQuery("SELECT 1 FROM room_events WHERE room_id = ? AND what = 'feed-mention' AND detail = 'on' LIMIT 1", [id]))[0]; }
    catch (e) { was = null; }                                            // no room_events table (minimal test DBs)
    if (was) { await kvSet("mention_set:" + id, "1"); out.kept.push(id); }
    else out.on.push(id);
  }
  await kvSet("mention_v1", "1");
  if (rows.length) console.log(`[feed] mention default ON: ${out.on.length} pad(s) switched on, ${out.kept.length} explicit off kept, ${out.marked.length} explicit on`);
  return out;
}
/** Pepe's presence in a room (bridge.pepeIn: true / false / null = unknown). Tests swap it with _setPepeIn. */
const pepeInBridge = (roomId) => { try { return require("./bridge").pepeIn(roomId); } catch (e) { return null; } };
let pepeInFn = pepeInBridge;
function _setPepeIn(fn) { pepeInFn = fn || pepeInBridge; }
const PLAT_NAME = { site: "Site", twitch: "Twitch", discord: "Discord" };
/**
 * 1.99cu: can Pepe announce a new post in this pad's Camfrog room right now? Drives the composer's and the
 * crosspost dialog's "Pepe announces it" checkbox (enabled + ticked, or greyed out with the reason) and the
 * server-side gate (queueMention). -> {ok, code: on|off|site|away, why, manage: this viewer may switch it on}
 */
async function announceState(roomId, viewer = null) {
  const id = String(roomId || "");
  const plat = rooms.platformOf(id);
  if (plat === "profile") return { ok: false, code: "site", why: "A profile has no Camfrog room", manage: false };     // 1.99df
  if (plat !== "camfrog") return { ok: false, code: "site", why: `${PLAT_NAME[plat] || "Site"} pad, no Camfrog room`, manage: false };
  if (!(await mentionOn(id))) {
    const manage = !!viewer && (isStaff(viewer) || !!(await rooms.canManage(viewer, id).catch(() => false)));
    return { ok: false, code: "off", why: "Announcements are off for this pad", manage };
  }
  if (pepeInFn(id) === false) return { ok: false, code: "away", why: "Pepe isn't in this room right now", manage: false };
  return { ok: true, code: "on", why: null, manage: false };
}
const MENTION_LINE_MAX = 300;                                          // 1.99cu: one Camfrog chat line, comfortably
async function queueMention(roomId, postId) {
  if (!(await mentionOn(roomId))) return;
  if (pepeInFn(roomId) === false) return;                              // 1.99cu: the box was greyed out (Pepe isn't there)
  await runQuery("INSERT OR IGNORE INTO feed_mentions (room_id, post_id, created) VALUES (?, ?, ?)", [roomId, postId, NOW()]);
}
/**
 * What Pepe should say now: at most one line per room per mention_gap_min, several new posts folded
 * into one line. Handed out once (marked sent). -> [{room, text, author_login|null, post}]
 */
async function takeMentions(site) {
  await init();
  const t = NOW(), gap = CONFIG.mention_gap_min * 60e3;
  const pend = await getQuery(`SELECT m.id, m.room_id, m.post_id, p.title, p.body, p.author_id, p.nsfw, p.nsfw_admin, p.deleted_at, p.hidden_at
                               FROM feed_mentions m JOIN feed_posts p ON p.id = m.post_id WHERE m.sent_at IS NULL ORDER BY m.id LIMIT 200`);
  const byRoom = new Map();
  for (const m of pend) { if (!byRoom.has(m.room_id)) byRoom.set(m.room_id, []); byRoom.get(m.room_id).push(m); }
  const out = [];
  for (const [roomId, ms] of byRoom) {
    if (!(await mentionOn(roomId))) { await runQuery(`UPDATE feed_mentions SET sent_at = ? WHERE room_id = ? AND sent_at IS NULL`, [t, roomId]); continue; }
    const last = Number(await kvGet("mention_at:" + roomId)) || 0;
    if (t - last < gap) continue;
    const live = ms.filter((m) => !m.deleted_at && !m.hidden_at);
    await runQuery(`UPDATE feed_mentions SET sent_at = ? WHERE id IN (${ms.map(() => "?").join(",")})`, [t, ...ms.map((m) => m.id)]);
    if (!live.length) continue;
    await kvSet("mention_at:" + roomId, t);
    const R = rooms.getCached(roomId);
    const slug = padSlugOf(R, roomId);
    const first = live[0];
    const A = await account(first.author_id);
    const name = A ? (A.displayname || A.username) : "someone";
    const nsfw = effNsfw(first);
    const what = nsfw ? "(NSFW)" : cleanLine(first.title || first.body || "", 70);
    // 1.99cu: every line links the post itself (1.99dv: its canonical address, <site>/p/<pad>/posts/<id>/<slug>); several
    // posts folded into one line link each post when they fit in MENTION_LINE_MAX, else the newest post + the pad page
    const urls = await postLinks(live.map((m) => m.post_id));
    const postUrl = (m) => site + (urls.get(m.post_id) || "/feed/p/" + m.post_id);
    let text;
    if (live.length === 1) text = `📌 New post on p/${slug} by ${"{author}"}: ${what ? what + " — " : ""}${postUrl(first)}`;
    else {
      text = `📌 ${live.length} new posts on p/${slug}: ${live.map(postUrl).join(" · ")}`;
      if (text.length > MENTION_LINE_MAX) {
        text = `📌 ${live.length} new posts on p/${slug} — newest: ${postUrl(live[live.length - 1])} · all: ${site}${require("./pads").padHref(R || slug)}#feed`;
      }
    }
    out.push({ room: roomId, text, author: name, author_login: A && A.camfrogUsername ? String(A.camfrogUsername).toLowerCase() : null, post: first.post_id, count: live.length });
  }
  return out;
}

// ── notices (inbox only: comments don't ping Camfrog) ──
async function notify(userId, n) {
  try { return await require("./inbox").addSafe(userId, { kind: n.kind || "feed", title: n.title, body: n.body, link: n.link, ref: n.ref }); }
  catch (e) { console.error("[feed] notify:", e.message); return false; }
}

// ── cleanup ──
/** Purge files of posts deleted more than deleted_purge_days ago, unattached uploads, stale sessions. */
async function sweep(media) {
  await init();
  const t = NOW();
  const purgeBefore = t - CONFIG.deleted_purge_days * 86400e3;
  const dead = await getQuery(`SELECT a.* FROM feed_attachments a JOIN feed_posts p ON p.id = a.post_id
                               WHERE p.deleted_at IS NOT NULL AND p.deleted_at <= ? AND a.state = 'ready'`, [purgeBefore]);
  const orphans = await getQuery("SELECT * FROM feed_attachments WHERE post_id IS NULL AND state IN ('ready','failed','uploading','processing') AND created <= ?",
                                 [t - media.ORPHAN_TTL]);
  for (const a of dead.concat(orphans)) {
    media.removeFiles([a.file, a.thumb, a.poster].filter(Boolean));
    try { require("fs").unlinkSync(media.tmpPath(a.id)); } catch (e) { /* none */ }
    await runQuery("UPDATE feed_attachments SET state = 'purged' WHERE id = ?", [a.id]);
  }
  if (dead.length) await runQuery("UPDATE feed_posts SET purged_at = ? WHERE deleted_at IS NOT NULL AND deleted_at <= ? AND purged_at IS NULL", [t, purgeBefore]);
  await runQuery("DELETE FROM feed_mentions WHERE sent_at IS NOT NULL AND sent_at < ?", [t - 7 * 86400e3]);
  await runQuery("DELETE FROM feed_bans WHERE until IS NOT NULL AND until < ?", [t]);
  const tmp = media.sweepTmp(t);
  return { purged: dead.length, orphans: orphans.length, tmp };
}

// ── room moderation (1.99bx): owners (rooms.canManage = the room's owner, or site staff) on THEIR room ──
// Room-scoped (only the room in question changes): pin (max 3), room NSFW mark, hide in the room pending
// review, approve / reject a pending post, remove / restore, the room's report queue, bans, settings and
// approved posters. Post-wide (comments are shared by every place a post shows): lock comments - an owner
// only when every community the post lives in is theirs; removing a comment on a post
// in their room (as in 1.99bw), with an optional reason in the author's inbox. Every action -> room_events.
const WHO = Object.freeze(["everyone", "linked", "followers", "approved"]);
// 1.99fc allow_nsfw: may NSFW-tagged media be posted here (default yes, as before). Only the image safety check reads it
// today: with the check on, explicit media is refused in a pad that says no (and marked NSFW where it says yes).
const ROOM_DEFAULTS = Object.freeze({ who: "everyone", approval: false, per_day: 0, allow_nsfw: true });
function cleanRoomSettings(c) {
  const o = { ...ROOM_DEFAULTS };
  if (c && WHO.includes(c.who)) o.who = c.who;
  if (c && c.approval != null) o.approval = c.approval === true || c.approval === 1 || c.approval === "1" || c.approval === "on" || c.approval === "true";
  if (c && c.per_day != null && c.per_day !== "") { const n = Math.floor(Number(c.per_day)); if (Number.isFinite(n)) o.per_day = Math.min(1000, Math.max(0, n)); }
  if (c && c.allow_nsfw != null) o.allow_nsfw = !(c.allow_nsfw === false || c.allow_nsfw === 0 || c.allow_nsfw === "0" || c.allow_nsfw === "off" || c.allow_nsfw === "false");
  return o;
}
async function roomSettings(roomId) {
  await init();
  let c = {};
  try { c = JSON.parse((await kvGet("room:" + roomId)) || "{}"); } catch (e) { c = {}; }
  return cleanRoomSettings(c);
}
/** The Following feature (another module) can tell us who follows a room; until then "followers" = approved posters. */
let followerCheck = null;
function setFollowerCheck(fn) { followerCheck = typeof fn === "function" ? fn : null; }
async function isRoomMember(userId, roomId) {
  return !!(await getQuery("SELECT 1 FROM feed_room_members WHERE room_id = ? AND user_id = ?", [roomId, userId]))[0];
}
/** null when `u` may post in `roomId` under the room's own rules (owner + staff always may). */
async function roomPostRefusal(u, roomId) {
  // 1.99df: a profile pad takes posts from its owner only - not other members, not staff, not Pepe
  if (rooms.isProfile(roomId)) {
    const R = rooms.getCached(roomId);
    const owner = R && R.owner ? R.owner.userId : String(roomId).slice(rooms.PROFILE_PREFIX.length);
    if (u && u.userId === owner) return null;
    return { status: 403, message: `Only ${R && R.profile && R.profile.username ? R.profile.username : "its owner"} can post on their profile.` };
  }
  if (!u || await rooms.canManage(u, roomId)) return null;
  const S = await roomSettings(roomId);
  const R = rooms.getCached(roomId);
  const name = R ? R.title : roomId;
  if (S.who === "linked" && !u.camfrogUsername) return { status: 403, message: `${name} takes posts from linked Camfrog accounts - type !verify in a Camfrog room with Pepe.` };
  if (S.who === "followers") {
    const ok = followerCheck ? await followerCheck(u.userId, roomId) : false;
    if (!ok && !(await isRoomMember(u.userId, roomId))) return { status: 403, message: `Only ${name}'s followers can post there.` };
  }
  if (S.who === "approved" && !(await isRoomMember(u.userId, roomId))) return { status: 403, message: `Only approved posters can post in ${name} - ask the pad owner.` };
  if (S.per_day > 0) {
    const n = (await getQuery(`SELECT COUNT(*) AS n FROM feed_post_rooms pr JOIN feed_posts p ON p.id = pr.post_id
                                WHERE pr.room_id = ? AND p.author_id = ? AND p.created > ?`, [roomId, u.userId, NOW() - 86400e3]))[0].n;
    if (n >= S.per_day) return { status: 429, message: `${name} allows ${S.per_day} post${S.per_day === 1 ? "" : "s"} a day per person.` };
  }
  return null;
}
/** Lock / unlock: staff anywhere; a room owner only if every community the post shows in is one they manage. */
async function canLock(user, postId) {
  if (!user || !user.userId) return false;
  if (isStaff(user)) return true;
  const p = await getRow(postId);
  if (!p) return false;
  const placed = await getQuery("SELECT room_id FROM feed_post_rooms WHERE post_id = ? AND removed_at IS NULL", [postId]);
  if (!placed.length) return false;
  for (const r of placed) if (!(await rooms.canManage(user, r.room_id))) return false;
  return true;
}
async function placement(postId, roomId) {
  return (await getQuery("SELECT * FROM feed_post_rooms WHERE post_id = ? AND room_id = ?", [String(postId || ""), String(roomId || "")]))[0] || null;
}
/**
 * One owner action on their room's feed. op: pin|unpin|nsfw|unnsfw|hide|unhide|approve|reject|remove|restore|
 * lock|unlock|dismiss|settings|member-add|member-remove. -> {ok, ...}
 */
async function roomMod(user, roomId, op, a = {}) {
  await init();
  roomId = String(roomId || "");
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  if (!(await rooms.canManage(user, roomId))) throw new Refuse(403, "Only this pad's owner can do that.");
  const t = NOW(), who = user.username;
  const needPlace = async () => {
    const pl = await placement(a.post, roomId);
    if (!pl) throw new Refuse(404, "That post isn't in this pad.");
    return pl;
  };
  const log = (what, detail) => rooms.event(roomId, "feed-" + what, who, detail);
  switch (op) {
    case "pin": {
      await needPlace();
      const n = (await getQuery("SELECT COUNT(*) AS n FROM feed_post_rooms WHERE room_id = ? AND pinned_at IS NOT NULL AND post_id != ? AND removed_at IS NULL", [roomId, a.post]))[0].n;
      if (n >= MAX_PINS) throw new Refuse(409, `You can pin ${MAX_PINS} posts - unpin one first.`);
      await runQuery("UPDATE feed_post_rooms SET pinned_at = ?, pinned_by = ? WHERE post_id = ? AND room_id = ?", [t, who, a.post, roomId]);
      await log("pin", a.post); return { ok: true };
    }
    case "unpin":
      await needPlace();
      await runQuery("UPDATE feed_post_rooms SET pinned_at = NULL, pinned_by = NULL WHERE post_id = ? AND room_id = ?", [a.post, roomId]);
      await log("unpin", a.post); return { ok: true };
    case "nsfw": case "unnsfw":
      await needPlace();
      await runQuery("UPDATE feed_post_rooms SET nsfw = ? WHERE post_id = ? AND room_id = ?", [op === "nsfw" ? 1 : null, a.post, roomId]);
      await log(op, a.post); return { ok: true };
    case "hide": case "unhide":
      await needPlace();
      await runQuery("UPDATE feed_post_rooms SET hidden_at = ?, hidden_by = ? WHERE post_id = ? AND room_id = ?", [op === "hide" ? t : null, op === "hide" ? who : null, a.post, roomId]);
      if (op === "hide") await markDone(roomId, a.post, "", "hidden", who);
      await log(op, a.post); return { ok: true };
    case "approve": {
      const pl = await needPlace();
      if (!pl.pending) return { ok: true, already: true };
      await runQuery("UPDATE feed_post_rooms SET pending = 0, approved_by = ? WHERE post_id = ? AND room_id = ?", [who, a.post, roomId]);
      if (pl.pending === 1) await queueMention(roomId, a.post);
      const p = await getRow(a.post);
      if (p) await notify(p.author_id, { title: "Your post was approved", body: `It's live in ${(rooms.getCached(roomId) || {}).title || roomId}.`, link: await postLink(p.id), ref: "feed-ok:" + p.id + ":" + roomId });
      await log("approve", a.post); return { ok: true };
    }
    case "reject": {
      await needPlace();
      await runQuery("UPDATE feed_post_rooms SET pending = 0, removed_at = ?, removed_by = ? WHERE post_id = ? AND room_id = ?", [t, "rejected:" + who, a.post, roomId]);
      const p = await getRow(a.post);
      const why = cleanLine(a.reason, 200);
      if (p) await notify(p.author_id, { title: "Your post wasn't approved", body: `${(rooms.getCached(roomId) || {}).title || roomId} didn't take it${why ? ": " + why : "."}`, link: await postLink(p.id), ref: "feed-no:" + p.id + ":" + roomId });
      await log("reject", a.post + (why ? ": " + why : "")); return { ok: true };
    }
    case "remove": { await removeFromRoom(user, a.post, roomId); await markDone(roomId, a.post, "", "removed", who); return { ok: true }; }
    case "restore": { await restoreToRoom(user, a.post, roomId); return { ok: true }; }
    case "lock": case "unlock": {
      await needPlace();
      if (!(await canLock(user, a.post))) throw new Refuse(403, "This post is in other pads too - only an admin can lock it.");
      await runQuery("UPDATE feed_posts SET locked_at = ?, locked_by = ? WHERE id = ?", [op === "lock" ? t : null, op === "lock" ? who : null, a.post]);
      await log(op, a.post); return { ok: true };
    }
    case "dismiss":
      await needPlace();
      await markDone(roomId, a.post, a.comment ? String(a.comment) : "", "dismissed", who);
      await log("dismiss", a.post + (a.comment ? " comment " + a.comment : "")); return { ok: true };
    case "settings": {
      const S = cleanRoomSettings({ ...(await roomSettings(roomId)), ...(a.settings || {}) });
      await kvSet("room:" + roomId, JSON.stringify(S));
      await log("settings", JSON.stringify(S)); return { ok: true, settings: S };
    }
    case "member-add": {
      const u = await rooms.findUser(a.user);
      if (!u) throw new Refuse(404, `No single PATV account named "${cleanLine(a.user, 40)}".`);
      await runQuery("INSERT OR REPLACE INTO feed_room_members (room_id, user_id, username, by, at) VALUES (?, ?, ?, ?, ?)", [roomId, u.userId, u.username, who, t]);
      await log("member-add", u.username); return { ok: true, user: { userId: u.userId, username: u.username } };
    }
    case "member-remove":
      await runQuery("DELETE FROM feed_room_members WHERE room_id = ? AND user_id = ?", [roomId, String(a.userId || "")]);
      await log("member-remove", String(a.userId || "")); return { ok: true };
    default: throw new Refuse(400, "Unknown action.");
  }
}
async function markDone(roomId, postId, commentId, action, by) {
  await runQuery(`INSERT INTO feed_room_report_done (room_id, post_id, comment_id, at, by, action) VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(room_id, post_id, comment_id) DO UPDATE SET at = excluded.at, by = excluded.by, action = excluded.action`,
                 [roomId, postId, commentId || "", NOW(), by, action]);
}
/**
 * The room's report queue: open reports (newer than the room's own dismiss / action) on posts placed in the
 * room, grouped per post and per comment. Admin resolutions close them too. -> [{post, comment, reasons: {label: n}, count, notes, last}]
 */
async function roomReports(roomId) {
  await init();
  const rows = await getQuery(`SELECT r.*, d.at AS done_at FROM feed_reports r
      JOIN feed_post_rooms pr ON pr.post_id = r.post_id AND pr.room_id = ? AND pr.removed_at IS NULL
      JOIN feed_posts p ON p.id = r.post_id AND p.deleted_at IS NULL
      LEFT JOIN feed_room_report_done d ON d.room_id = pr.room_id AND d.post_id = r.post_id AND d.comment_id = COALESCE(r.comment_id, '')
      WHERE r.resolved_at IS NULL AND (d.at IS NULL OR r.created > d.at)
        AND r.reason NOT IN (${ADMIN_ONLY.map(() => "?").join(",")})
        AND NOT EXISTS (SELECT 1 FROM feed_reports x WHERE x.post_id = r.post_id AND x.resolved_at IS NULL AND x.reason IN (${URGENT.map(() => "?").join(",")}))
      ORDER BY r.created DESC LIMIT 500`, [roomId, ...ADMIN_ONLY, ...URGENT]);
  const groups = new Map();
  for (const r of rows) {
    const k = r.post_id + "|" + (r.comment_id || "");
    if (!groups.has(k)) groups.set(k, { postId: r.post_id, commentId: r.comment_id || null, reasons: {}, count: 0, notes: [], last: 0 });
    const g = groups.get(k);
    const label = REASONS[r.reason] || r.reason;
    g.reasons[label] = (g.reasons[label] || 0) + 1;
    g.count++;
    if (r.note && g.notes.length < 5) g.notes.push(r.note);
    g.last = Math.max(g.last, r.created);
  }
  const list = [...groups.values()];
  const posts = new Map((await decorate(await getQuery(`SELECT * FROM feed_posts WHERE id IN (${list.map(() => "?").join(",") || "''"})`, list.map((g) => g.postId)),
                                        { class: "Admin", userId: "_" }, { ctxRoom: roomId })).map((p) => [p.id, p]));
  const cids = list.filter((g) => g.commentId).map((g) => g.commentId);
  const C = cids.length ? await getQuery(`SELECT c.id, c.body, c.deleted_at, c.hidden_at, c.author_id, u.username FROM feed_comments c LEFT JOIN users u ON u.userId = c.author_id WHERE c.id IN (${cids.map(() => "?").join(",")})`, cids) : [];
  const out = list.filter((g) => posts.has(g.postId)).map((g) => ({ ...g, post: posts.get(g.postId), comment: g.commentId ? C.find((c) => c.id === g.commentId) || null : null }))
    .filter((g) => !g.comment || (!g.comment.deleted_at && !g.comment.hidden_at)).sort((a, b) => b.count - a.count || b.last - a.last);
  // 1.99cc: owners see the author's account age + which identities are linked - never network data (contentaudit.ownerInfo)
  const audit = require("./contentaudit");
  const info = new Map();
  for (const g of out) {
    const uid = g.comment ? g.comment.author_id : g.post.author.userId;
    if (!info.has(uid)) info.set(uid, await audit.ownerInfo(uid).catch(() => null));
    g.authorInfo = info.get(uid);
  }
  return out;
}
/** Posts waiting for approval in a room (oldest first). */
async function roomPending(roomId, viewer) {
  const rows = await getQuery(`SELECT p.* FROM feed_posts p JOIN feed_post_rooms pr ON pr.post_id = p.id AND pr.room_id = ?
                               WHERE pr.pending > 0 AND pr.removed_at IS NULL AND p.deleted_at IS NULL ORDER BY p.created LIMIT 100`, [roomId]);
  return decorate(rows, viewer, { ctxRoom: roomId });
}
async function roomMembers(roomId) {
  await init();
  return getQuery("SELECT * FROM feed_room_members WHERE room_id = ? ORDER BY at DESC", [roomId]);
}
/** The room's feed audit trail (room_events rows starting feed-). */
async function roomAudit(roomId, limit = 100) {
  await init();
  return getQuery("SELECT * FROM room_events WHERE room_id = ? AND what LIKE 'feed-%' ORDER BY ts DESC LIMIT ?", [roomId, limit]);
}

module.exports = {
  postPath, postLink, postLinks,
  roomMod, roomSettings, roomPostRefusal, setMediaSafetyCheck, roomReports, roomPending, roomMembers, roomAudit, canLock, setFollowerCheck, WHO, ROOM_DEFAULTS, MAX_PINS,
  init, config, setConfig, loadConfig, DEFAULTS, LIMITS, Refuse, postRefusal, postRate, postBudget, account, isNewAccount, usedBytes,
  list, get, getRow, decorate, canModerate, create, edit, remove, crosspost, crosspostMany, communities, hot, thumbOf, visibleSql, communityOf,
  communitiesPlan, migrateCommunities, kvGet, removeFromRoom, restoreToRoom, adminSet, vote, voteComment,
  hotRank, controversy, wilson, rankSpec, MEDIA_SQL, recountPost, recountComment, rehotAll, SORTS, WINDOWS, TIMED, CSORTS, cleanSort, cleanWindow, cleanCSort,
  downCounts, HOT_EPOCH, _votes: voteLog,
  comments, comment, editComment, removeComment, report, reports, resolveReports, REASONS, ban, unban, bans,
  reportUser, userReports, userReportAction, reportAction, reportMenu, OFFERED, USER_OFFERED, ADMIN_ONLY, URGENT, ACTIONS, HINTS,
  notify, urgentNotice, cleanLine,
  setRestricted, mentionOn, setMention, migrateMentionDefault, announceState, _setPepeIn, takeMentions, sweep, hotScore, priceOf, isStaff, burst, _setClock, _gaps: gaps, PEPE_ID, isPepe, effNsfw, kvGet, kvSet,
  TITLE_MAX, BODY_MAX, COMMENT_MAX, MAX_IMAGES, MAX_ATTACH, MAX_ROOMS,
};
