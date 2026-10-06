// feedstore.js — feed posts, rooms as hubs, votes, comments, reports, feed bans (1.99bv).
//
// Data model (shaped after v2 §10 "Social feed": posts, attachments, votes, comments, rooms as hubs)
//   feed_posts         id (12 chars, random), author_id, title, body (plain text, <= 5000), link_url,
//                      link_json ({url, domain, title, description, site, embed: {p,t,id}|null, thumb}),
//                      nsfw (author flag), nsfw_admin (admin override: null = author's flag, 0/1 = forced),
//                      global (on the main feed), score (cached upvotes), comments (cached count),
//                      cost (PAT paid), created, edited, deleted_at, deleted_by, delete_reason,
//                      hidden_at (auto-hidden by reports, pending review), purged_at
//   feed_post_rooms    post_id, room_id (rooms_registry id), removed_at / removed_by (a room owner
//                      can take a post out of THEIR room without deleting it elsewhere)
//   feed_attachments   id, post_id (NULL until posted), owner_id, kind image|audio|video|preview,
//                      ct, file, thumb, poster, w, h, secs, bytes, sort, state uploading|processing|
//                      ready|failed|deleted|purged, error, created, size_declared, received, sniff
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
"use strict";
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { runQuery, getQuery } = require("./dbUtils");
const rooms = require("./rooms");

const TITLE_MAX = 140, BODY_MAX = 5000, COMMENT_MAX = 2000, MAX_IMAGES = 4, MAX_ATTACH = 6, MAX_ROOMS = 5;
const PAGE = 20;
const MAX_PINS = 3;
const DEFAULTS = Object.freeze({
  enabled: true,
  max_image_mb: 10, max_audio_mb: 25, max_video_mb: 100,
  max_audio_secs: 600, max_video_secs: 180,
  user_quota_mb: 500, global_quota_gb: 20, min_free_gb: 8,
  media_min_level: 2,                 // upload media: a linked Camfrog name OR at least this level
  require_link_to_post: false,        // text/link posts: any signed-in account unless this is on
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
});
const INT_KEYS = Object.keys(DEFAULTS).filter((k) => typeof DEFAULTS[k] === "number");
const LIMITS = { max_image_mb: [1, 50], max_audio_mb: [1, 200], max_video_mb: [1, 500], max_audio_secs: [10, 3600], max_video_secs: [5, 1800],
  user_quota_mb: [10, 100000], global_quota_gb: [1, 1000], min_free_gb: [1, 500], media_min_level: [0, 100], new_account_hours: [0, 720],
  new_account_posts_per_day: [0, 100], posts_per_hour: [1, 1000], posts_per_day: [1, 5000], comments_per_hour: [1, 5000],
  uploads_per_hour: [1, 1000], upload_mb_per_day: [10, 100000], report_hide_threshold: [1, 100], deleted_purge_days: [0, 365],
  price_post: [0, 1e9], price_link: [0, 1e9], price_image: [0, 1e9], price_audio: [0, 1e9], price_video: [0, 1e9], mention_gap_min: [1, 1440],
  post_gap_secs: [0, 3600], comment_gap_secs: [0, 600],
  hot_decay_secs: [3600, 1000000], downvote_min_level: [0, 100], votes_per_min: [1, 1000], votes_per_hour: [1, 20000] };

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
  return out;
}
async function loadConfig() {
  let c = {};
  try { c = JSON.parse((await kvGet("config")) || "{}"); } catch (e) { c = {}; }
  CONFIG = cleanConfig(c);
  return CONFIG;
}
async function setConfig(patch, actor) {
  await init();
  const merged = cleanConfig({ ...CONFIG, ...(patch || {}) });
  await kvSet("config", JSON.stringify(merged));
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
/** null when `u` may post (in `roomIds`, '' = the main feed), else {status, message}. */
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
  if (C.require_link_to_post && !u.camfrogUsername && !isStaff(u)) {
    return { status: 403, message: "Link your Camfrog name first: type !verify in a room with Pepe." };
  }
  if (media && !isStaff(u) && !u.camfrogUsername && (Number(u.level) || 0) < C.media_min_level) {
    return { status: 403, message: `Uploading pictures, audio and video needs a linked Camfrog name (type !verify in a room with Pepe) or level ${C.media_min_level}.` };
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
async function postRate(u) {
  const C = CONFIG, t = NOW();
  if (isStaff(u)) return null;
  const n = async (ms) => (await getQuery("SELECT COUNT(*) AS n FROM feed_posts WHERE author_id = ? AND created > ?", [u.userId, t - ms]))[0].n;
  if (isNewAccount(u) && (await n(86400e3)) >= C.new_account_posts_per_day) {
    return `New accounts can post ${C.new_account_posts_per_day} time${C.new_account_posts_per_day === 1 ? "" : "s"} a day - link your Camfrog name (!verify) to lift that.`;
  }
  if ((await n(3600e3)) >= C.posts_per_hour) return "You've posted a lot this hour - try again later.";
  if ((await n(86400e3)) >= C.posts_per_day) return "You've hit today's post limit.";
  const g = burst("post|" + u.userId, C.post_gap_secs * 1000);
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
  const rows = await getQuery(`SELECT userId, username, ${C.has("displayname") ? "displayname" : "NULL AS displayname"}, class
                               FROM users WHERE userId IN (${want.map(() => "?").join(",")})`, want);
  const m = new Map();
  for (const r of rows) m.set(r.userId, { userId: r.userId, username: r.username, display: r.displayname || r.username, staff: r.class === "Admin" || r.class === "Staff" });
  return m;
}

function parseJson(s) { try { return s ? JSON.parse(s) : null; } catch (e) { return null; } }
const effNsfw = (p) => (p.nsfw_admin === 0 || p.nsfw_admin === 1 ? !!p.nsfw_admin : !!p.nsfw);

/** Decorate post rows: author, rooms, attachments, my vote, flags. */
async function decorate(rows, viewer, { ctxRoom = null, detail = false } = {}) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const q = ids.map(() => "?").join(",");
  const [A, PR, AT, MV, FW] = await Promise.all([
    authors(rows.map((r) => r.author_id)),
    getQuery(`SELECT post_id, room_id, removed_at, pinned_at, nsfw, hidden_at, pending FROM feed_post_rooms WHERE post_id IN (${q})`, ids),
    getQuery(`SELECT * FROM feed_attachments WHERE post_id IN (${q}) AND state = 'ready' ORDER BY sort, created`, ids),
    viewer && viewer.userId ? getQuery(`SELECT post_id, value, w FROM feed_votes WHERE user_id = ? AND post_id IN (${q})`, [viewer.userId, ...ids]) : [],
    // 1.99bz: which of these authors the viewer follows (the author chip's Follow button)
    viewer && viewer.userId ? require("./follows").followedAmong(viewer.userId, "user", rows.map((r) => r.author_id)) : new Set(),
  ]);
  const staff = isStaff(viewer);
  return rows.map((r) => {
    const roomsOf = PR.filter((x) => x.post_id === r.id).map((x) => {
      const R = rooms.getCached(x.room_id);
      return { id: x.room_id, slug: R ? R.slug : rooms.slugify(x.room_id), title: R ? R.title : x.room_id, removed: !!x.removed_at, owner: R && R.owner ? R.owner.userId : null,
               pinned: !!x.pinned_at, nsfw: x.nsfw === 1, hidden: !!x.hidden_at, pending: !!x.pending };
    });
    const ctx = ctxRoom ? roomsOf.find((x) => x.id === ctxRoom) : null;
    // a room owner's NSFW mark applies in their room's view and on the post page - never on the main feed / other rooms
    const nsfw = effNsfw(r) || (ctxRoom ? !!(ctx && ctx.nsfw) : (detail && roomsOf.some((x) => x.nsfw && !x.removed)));
    const att = AT.filter((a) => a.post_id === r.id).map((a) => ({ id: a.id, kind: a.kind, ct: a.ct, file: a.file, thumb: a.thumb, poster: a.poster,
                                                                 w: a.w, h: a.h, secs: a.secs }));
    const link = parseJson(r.link_json);
    const mv = MV.find((v) => v.post_id === r.id);
    return {
      id: r.id, title: r.title || "", body: r.body || "", created: r.created, edited: r.edited, score: r.score, comments: r.comments,
      ups: r.ups || 0, downs: r.downs || 0, myVote: mv ? (mv.value > 0 ? 1 : -1) : 0,
      nsfw, nsfwAuthor: !!r.nsfw, nsfwRoom: !!(ctx && ctx.nsfw), pinned: !!(ctx && ctx.pinned), roomHidden: !!(ctx && ctx.hidden), pending: !!(ctx && ctx.pending),
      locked: !!r.locked_at, lockedBy: r.locked_by || null, nsfwAdmin: r.nsfw_admin, global: !!r.global, cost: r.cost,
      deleted: !!r.deleted_at, hidden: !!r.hidden_at, deleteReason: r.delete_reason || null,
      author: A.get(r.author_id) || { userId: r.author_id, username: "[gone]", display: "[deleted account]" },
      followingAuthor: FW.has(r.author_id),
      mine: !!(viewer && viewer.userId === r.author_id),
      voted: !!(mv && mv.value > 0),
      rooms: roomsOf.filter((x) => (!x.removed && !x.pending && !x.hidden) || staff),
      roomsAll: roomsOf,
      images: att.filter((a) => a.kind === "image"), audio: att.filter((a) => a.kind === "audio"), video: att.filter((a) => a.kind === "video"),
      link: link && link.url ? { ...link, thumbFile: (att.find((a) => a.kind === "preview") || {}).thumb || null } : null,
    };
  });
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
 * A page of posts. scope: {room: room id} | {author: userId} | {authors: [userIds]} (Following) | the main
 * feed. sort: hot|new|top|controversial|rising; top: the time window for top/controversial.
 * Visible = not deleted, not hidden (staff see hidden ones), and in a room: not removed from it.
 */
async function list({ room = null, author = null, following = null, authors: authorIds = null, sort = "new", page = 1, top = "all", viewer = null, limit = PAGE, pins: pinsOn = true } = {}) {
  await init();
  const staff = isStaff(viewer);
  const roomMod = room ? await rooms.canManage(viewer, room) : false;
  const R = rankSpec(sort, top, NOW());
  const scope = ["p.deleted_at IS NULL"], sargs = [];
  if (!staff) scope.push("p.hidden_at IS NULL");
  let from = "feed_posts p";
  const jargs = [];
  if (following) {
    // 1.99bz: posts by people `following` follows + posts in rooms they follow (one row per post)
    await require("./follows").init();
    const f = require("./follows").feedFilter(following);
    scope.push(f.sql); sargs.push(...f.args);
  } else if (room) {
    from += " JOIN feed_post_rooms pr ON pr.post_id = p.id AND pr.room_id = ?";
    jargs.push(room);
    if (!staff) scope.push("pr.removed_at IS NULL");
    // pending approval / hidden in the room: only its owner (and admins) see them, plus the author their own
    if (!roomMod) {
      if (viewer && viewer.userId) { scope.push("((pr.pending = 0 AND pr.hidden_at IS NULL) OR p.author_id = ?)"); sargs.push(viewer.userId); }
      else scope.push("pr.pending = 0 AND pr.hidden_at IS NULL");
    }
  } else if (author) {
    scope.push("p.author_id = ?"); sargs.push(author);
  } else if (Array.isArray(authorIds)) {
    const ids = authorIds.map(String).slice(0, 2000);
    if (!ids.length) return { posts: [], more: false, page: 1, sort: R.sort };
    scope.push(`p.author_id IN (${ids.map(() => "?").join(",")})`); sargs.push(...ids);
  } else {
    scope.push("p.global = 1");
  }
  page = Math.max(1, Math.min(200, Math.floor(Number(page)) || 1));
  // placeholders in text order: select (rising) -> join -> scope -> sort filters
  const selArgs = R.select ? [R.args[0]] : [], sortArgs = R.select ? R.args.slice(1) : R.args;
  // a room's pinned posts (at most MAX_PINS) head page 1 of every sort and are left out of the ranking
  let pinned = [];
  if (room && pinsOn) {
    if (page === 1) pinned = await getQuery(`SELECT p.* FROM ${from} WHERE ${scope.join(" AND ")} AND pr.pinned_at IS NOT NULL ORDER BY pr.pinned_at DESC LIMIT ${MAX_PINS}`, [...jargs, ...sargs]);
    scope.push("pr.pinned_at IS NULL");
  }
  const rows = await getQuery(`SELECT p.*${R.select} FROM ${from} WHERE ${scope.concat(R.where).join(" AND ")} ORDER BY ${R.order} LIMIT ? OFFSET ?`,
                              [...selArgs, ...jargs, ...sargs, ...sortArgs, limit + 1, (page - 1) * limit]);
  const more = rows.length > limit;
  return { posts: await decorate(pinned.concat(rows.slice(0, limit)), viewer, { ctxRoom: room }), more, page, sort: R.sort };
}

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
 */
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
  // rooms: registered rooms only
  const roomIds = [];
  for (const r of (Array.isArray(input.rooms) ? input.rooms : []).slice(0, MAX_ROOMS + 1)) {
    const R = await rooms.get(String(r)) || await rooms.bySlug(String(r));
    if (!R) throw new Refuse(400, "One of those rooms isn't on PATV.");
    if (!roomIds.includes(R.id)) roomIds.push(R.id);
  }
  if (roomIds.length > MAX_ROOMS) throw new Refuse(400, `Post to at most ${MAX_ROOMS} rooms at once.`);
  const global = input.global === undefined ? true : !!(input.global === true || input.global === 1 || input.global === "1" || input.global === "on");
  if (!global && !roomIds.length) throw new Refuse(400, "Pick where it goes: the main feed and/or a room.");
  if (!title && !body && !linkIn && !attIds.length) throw new Refuse(400, "Write something, add a link or attach a file.");
  const refusal = await postRefusal(u, global ? ["", ...roomIds] : roomIds, { media: attIds.length > 0 });
  if (refusal) throw new Refuse(refusal.status, refusal.message);
  const rate = await postRate(u);
  if (rate) throw new Refuse(429, rate);
  const pendingIn = new Set();
  for (const rid of roomIds) {
    const why = await roomPostRefusal(u, rid);
    if (why) throw new Refuse(why.status, why.message);
    if ((await roomSettings(rid)).approval && !(await rooms.canManage(u, rid))) pendingIn.add(rid);
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
  const cost = priceOf(C, { ...counts, link: !!link });
  const id = newId();
  const label = `feed post ${id}`;
  await chargeFor(u, cost, label);
  try {
    const t = NOW();
    await runQuery(`INSERT INTO feed_posts (id, author_id, title, body, link_url, link_json, nsfw, global, cost, created)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                   [id, u.userId, title || null, body || null, link ? link.url : null, link ? JSON.stringify(link) : null,
                    input.nsfw === true || input.nsfw === 1 || input.nsfw === "1" || input.nsfw === "on" ? 1 : 0, global ? 1 : 0, cost, t]);
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
    // the author's own upvote (Reddit-style; they can take it back, never turn it into a downvote)
    await runQuery("INSERT OR IGNORE INTO feed_votes (post_id, user_id, value, w, created, updated) VALUES (?, ?, 1, 1, ?, ?)", [id, u.userId, t, t]);
    await recountPost(id);
  } catch (e) {
    await runQuery("DELETE FROM feed_votes WHERE post_id = ?", [id]).catch(() => {});
    await runQuery("UPDATE feed_attachments SET post_id = NULL WHERE post_id = ?", [id]).catch(() => {});
    await runQuery("DELETE FROM feed_post_rooms WHERE post_id = ?", [id]).catch(() => {});
    await runQuery("DELETE FROM feed_posts WHERE id = ?", [id]).catch(() => {});
    await refund(u, cost, `${label} refund (not posted)`).catch(() => {});
    throw e;
  }
  console.log(`[feed] post ${id} by ${u.username} rooms=${roomIds.join(",") || "-"} global=${global ? 1 : 0} files=${atts.length} link=${link ? link.domain : "-"} cost=${cost}`);
  const made = await get(id, u);
  // 1.99bz: followers who asked for it get an inbox notice (default off); never blocks the post
  if (made) {
    const pending = require("./follows").notifyNewPost(made, u.displayname || u.username);
    if (deps.awaitNotices) await pending;
  }
  return made;
}

/** Author edit: title, body, nsfw. (Files, link and rooms stay - delete and repost to change those.) */
async function edit(user, id, patch) {
  const r = await getRow(id);
  if (!r || r.deleted_at) throw new Refuse(404, "No such post.");
  if (!user || user.userId !== r.author_id) throw new Refuse(403, "Only the author can edit a post.");
  const title = patch.title != null ? cleanLine(patch.title, TITLE_MAX) : r.title;
  const body = patch.body != null ? cleanText(patch.body, BODY_MAX) : r.body;
  const nsfw = patch.nsfw != null ? (patch.nsfw === true || patch.nsfw === 1 || patch.nsfw === "1" || patch.nsfw === "on" ? 1 : 0) : r.nsfw;
  if (!title && !body && !r.link_url && !(await getQuery("SELECT 1 FROM feed_attachments WHERE post_id = ? AND kind != 'preview' AND state = 'ready' LIMIT 1", [id])).length) {
    throw new Refuse(400, "A post can't be empty.");
  }
  await runQuery("UPDATE feed_posts SET title = ?, body = ?, nsfw = ?, edited = ? WHERE id = ?", [title || null, body || null, nsfw, NOW(), id]);
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
  if (!p.roomsAll.find((r) => r.id === roomId)) throw new Refuse(404, "That post isn't in that room.");
  if (!(await rooms.canManage(user, roomId))) throw new Refuse(403, "Only this room's owner can do that.");
  await runQuery("UPDATE feed_post_rooms SET removed_at = ?, removed_by = ? WHERE post_id = ? AND room_id = ? AND removed_at IS NULL",
                 [NOW(), user.username, id, roomId]);
  await runQuery("DELETE FROM feed_mentions WHERE post_id = ? AND room_id = ? AND sent_at IS NULL", [id, roomId]);
  await rooms.event(roomId, "feed-remove", user.username, id);
  return true;
}
async function restoreToRoom(user, id, roomId) {
  if (!(await rooms.canManage(user, roomId))) throw new Refuse(403, "Only this room's owner can do that.");
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
  if (!c || c.deleted_at) throw new Refuse(404, "No such comment.");
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
  const all = rows.map((c) => ({ id: c.id, parent: c.parent_id, body: c.deleted_at ? "" : c.body, deleted: !!c.deleted_at, created: c.created, edited: c.edited,
    author: c.deleted_at ? null : A.get(c.author_id) || { username: "[gone]", display: "[deleted account]" },
    ups: c.ups || 0, downs: c.downs || 0, score: c.score || 0, myVote: mine.get(c.id) || 0,
    mine: !!(viewer && viewer.userId === c.author_id && !c.deleted_at), replies: [] }));
  const top = [], byId = new Map(all.map((c) => [c.id, c]));
  for (const c of all) {
    if (c.parent && byId.has(c.parent)) byId.get(c.parent).replies.push(c);
    else top.push(c);
  }
  const cmp = commentOrder(sort);
  // a deleted comment with no replies just goes away
  return top.filter((c) => !c.deleted || c.replies.some((r) => !r.deleted)).sort(cmp)
    .map((c) => ({ ...c, replies: c.replies.filter((r) => !r.deleted).sort(cmp) }));
}

async function comment(user, postId, { body, parent } = {}) {
  const p = await getRow(postId);
  if (!p || p.deleted_at || p.hidden_at) throw new Refuse(404, "No such post.");
  const u = await account(user && user.userId);
  if (p.locked_at && !(await canLock(u, p.id))) throw new Refuse(403, "Comments on this post are locked.");
  const roomIds = (await getQuery("SELECT room_id FROM feed_post_rooms WHERE post_id = ? AND removed_at IS NULL", [postId])).map((r) => r.room_id);
  const refusal = await postRefusal(u, roomIds);
  if (refusal) throw new Refuse(refusal.status, refusal.message.replace("to post", "to comment"));
  const text = cleanText(body, COMMENT_MAX);
  if (!text) throw new Refuse(400, "Write something first.");
  if (!isStaff(u)) {
    const n = (await getQuery("SELECT COUNT(*) AS n FROM feed_comments WHERE author_id = ? AND created > ?", [u.userId, NOW() - 3600e3]))[0].n;
    if (n >= CONFIG.comments_per_hour) throw new Refuse(429, "You've commented a lot this hour - try again later.");
    if (isNewAccount(u) && n >= 10) throw new Refuse(429, "New accounts can comment 10 times an hour - link your Camfrog name (!verify) to lift that.");
    const g = burst("comment|" + u.userId, CONFIG.comment_gap_secs * 1000);
    if (g) throw new Refuse(429, `Slow down - try again in ${g}s.`);
  }
  let par = null;
  if (parent) {
    par = (await getQuery("SELECT * FROM feed_comments WHERE id = ? AND post_id = ?", [String(parent), postId]))[0];
    if (!par || par.deleted_at) throw new Refuse(404, "That comment is gone.");
    if (par.parent_id) par = (await getQuery("SELECT * FROM feed_comments WHERE id = ?", [par.parent_id]))[0] || par;   // replies stay one level deep
  }
  const id = newId(10);
  const t = NOW();
  await runQuery("INSERT INTO feed_comments (id, post_id, parent_id, author_id, body, created) VALUES (?, ?, ?, ?, ?, ?)",
                 [id, postId, par ? par.id : null, u.userId, text, t]);
  await runQuery("INSERT OR IGNORE INTO feed_comment_votes (comment_id, post_id, user_id, value, w, created, updated) VALUES (?, ?, ?, 1, 1, ?, ?)", [id, postId, u.userId, t, t]);
  await recountComment(id);
  await recount(postId);
  // notices: the post's author, and the person replied to (never yourself, never twice)
  const who = u.displayname || u.username;
  const what = (p.title || p.body || "your post").replace(/\s+/g, " ").slice(0, 60);
  const link = `/feed/p/${postId}#c-${id}`;
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
  if (!c || c.deleted_at) throw new Refuse(404, "No such comment.");
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
                                link: `/feed/p/${c.post_id}`, ref: "feed-crm:" + c.id });
    if (!isStaff(user)) {
      for (const r of await getQuery("SELECT room_id FROM feed_post_rooms WHERE post_id = ?", [c.post_id])) {
        if (await rooms.canManage(user, r.room_id)) await rooms.event(r.room_id, "feed-comment-remove", user.username, `${c.id} on ${c.post_id}${why ? ": " + why : ""}`);
      }
    }
  }
  return true;
}

// ── reports ──
const REASONS = { spam: "Spam", abuse: "Harassment or hate", nsfw: "Unmarked NSFW", illegal: "Illegal content", personal: "Personal info / doxxing", other: "Something else" };
async function report(user, { post, comment: cid, reason, note } = {}) {
  if (!user || !user.userId) throw new Refuse(401, "Sign in to report.");
  const p = await getRow(post);
  if (!p || p.deleted_at) throw new Refuse(404, "No such post.");
  if (cid && !(await getQuery("SELECT 1 FROM feed_comments WHERE id = ? AND post_id = ?", [String(cid), p.id])).length) throw new Refuse(404, "No such comment.");
  const why = Object.prototype.hasOwnProperty.call(REASONS, reason) ? reason : "other";
  const g = burst("report|" + user.userId, 3000);
  if (g) throw new Refuse(429, `Slow down - try again in ${g}s.`);
  const r = await runQuery("INSERT OR IGNORE INTO feed_reports (post_id, comment_id, reporter_id, reason, note, created) VALUES (?, ?, ?, ?, ?, ?)",
                           [p.id, cid ? String(cid) : null, user.userId, why, cleanLine(note, 300) || null, NOW()]);
  if (!r.changes) return { ok: true, already: true };
  // enough distinct, established reporters -> hidden until an admin looks
  if (!cid && !p.hidden_at) {
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
    for (const a of await getQuery("SELECT userId FROM users WHERE class = 'Admin'")) {
      await notify(a.userId, { kind: "admin", title: "A feed post was reported", body: `${REASONS[why]}: "${(p.title || p.body || "").slice(0, 80)}"`, link: "/feed/admin", ref: "feed-rep:" + p.id + ":" + p.created });
    }
  }
  return { ok: true };
}
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
  const C = cmts.length ? await getQuery(`SELECT c.id, c.body, c.deleted_at, u.username FROM feed_comments c LEFT JOIN users u ON u.userId = c.author_id WHERE c.id IN (${cmts.map(() => "?").join(",")})`, cmts) : [];
  return posts.map((p) => ({ post: p, reports: byPost.get(p.id).map((r) => ({ ...r, label: REASONS[r.reason] || r.reason, comment: r.comment_id ? C.find((c) => c.id === r.comment_id) || null : null })) }));
}
async function resolveReports(user, postId, action) {
  if (!isStaff(user)) throw new Refuse(403, "Admins only.");
  await runQuery("UPDATE feed_reports SET resolved_at = ?, resolved_by = ?, action = ? WHERE post_id = ? AND resolved_at IS NULL", [NOW(), user.username, cleanLine(action, 20) || "dismissed", postId]);
  return true;
}

// ── feed bans (site staff: whole feed or a room; room owners: their room) ──
async function ban(user, target, { room = "", reason = "", days = 0 } = {}) {
  const roomId = String(room || "");
  if (roomId ? !(await rooms.canManage(user, roomId)) : !isStaff(user)) throw new Refuse(403, roomId ? "Only this room's owner can do that." : "Admins only.");
  const u = await rooms.findUser(target);
  if (!u) throw new Refuse(404, `No single PATV account named "${String(target).slice(0, 40)}".`);
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

async function mentionOn(roomId) { await init(); return (await kvGet("mention:" + roomId)) === "1"; }
async function setMention(user, roomId, on) {
  if (!(await rooms.canManage(user, roomId))) throw new Refuse(403, "Only this room's owner can do that.");
  await init();
  await kvSet("mention:" + roomId, on ? "1" : "0");
  await rooms.event(roomId, "feed-mention", user.username, on ? "on" : "off");
  return !!on;
}
async function queueMention(roomId, postId) {
  if (!(await mentionOn(roomId))) return;
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
    const slug = R ? R.slug : rooms.slugify(roomId);
    const first = live[0];
    const A = await account(first.author_id);
    const name = A ? (A.displayname || A.username) : "someone";
    const nsfw = effNsfw(first);
    const what = nsfw ? "(NSFW)" : cleanLine(first.title || first.body || "", 70);
    const text = live.length === 1
      ? `📌 New post on the room feed by ${"{author}"}: ${what ? what + " — " : ""}${site}/feed/p/${first.post_id}`
      : `📌 ${live.length} new posts on the room feed — ${site}/rooms/${encodeURIComponent(slug)}#feed`;
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
// only when the post lives in rooms they manage and NOT on the main feed; removing a comment on a post
// in their room (as in 1.99bw), with an optional reason in the author's inbox. Every action -> room_events.
const WHO = Object.freeze(["everyone", "linked", "followers", "approved"]);
const ROOM_DEFAULTS = Object.freeze({ who: "everyone", approval: false, per_day: 0 });
function cleanRoomSettings(c) {
  const o = { ...ROOM_DEFAULTS };
  if (c && WHO.includes(c.who)) o.who = c.who;
  if (c && c.approval != null) o.approval = c.approval === true || c.approval === 1 || c.approval === "1" || c.approval === "on" || c.approval === "true";
  if (c && c.per_day != null && c.per_day !== "") { const n = Math.floor(Number(c.per_day)); if (Number.isFinite(n)) o.per_day = Math.min(1000, Math.max(0, n)); }
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
  if (!u || await rooms.canManage(u, roomId)) return null;
  const S = await roomSettings(roomId);
  const R = rooms.getCached(roomId);
  const name = R ? R.title : roomId;
  if (S.who === "linked" && !u.camfrogUsername) return { status: 403, message: `${name} takes posts from linked Camfrog accounts - type !verify in a room with Pepe.` };
  if (S.who === "followers") {
    const ok = followerCheck ? await followerCheck(u.userId, roomId) : false;
    if (!ok && !(await isRoomMember(u.userId, roomId))) return { status: 403, message: `Only ${name}'s followers can post there.` };
  }
  if (S.who === "approved" && !(await isRoomMember(u.userId, roomId))) return { status: 403, message: `Only approved posters can post in ${name} - ask the room owner.` };
  if (S.per_day > 0) {
    const n = (await getQuery(`SELECT COUNT(*) AS n FROM feed_post_rooms pr JOIN feed_posts p ON p.id = pr.post_id
                                WHERE pr.room_id = ? AND p.author_id = ? AND p.created > ?`, [roomId, u.userId, NOW() - 86400e3]))[0].n;
    if (n >= S.per_day) return { status: 429, message: `${name} allows ${S.per_day} post${S.per_day === 1 ? "" : "s"} a day per person.` };
  }
  return null;
}
/** Lock / unlock: staff anywhere; a room owner only if every place the post shows is a room they manage. */
async function canLock(user, postId) {
  if (!user || !user.userId) return false;
  if (isStaff(user)) return true;
  const p = await getRow(postId);
  if (!p || p.global) return false;
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
  if (!(await rooms.canManage(user, roomId))) throw new Refuse(403, "Only this room's owner can do that.");
  const t = NOW(), who = user.username;
  const needPlace = async () => {
    const pl = await placement(a.post, roomId);
    if (!pl) throw new Refuse(404, "That post isn't in this room.");
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
      if (p) await notify(p.author_id, { title: "Your post was approved", body: `It's live in ${(rooms.getCached(roomId) || {}).title || roomId}.`, link: `/feed/p/${p.id}`, ref: "feed-ok:" + p.id + ":" + roomId });
      await log("approve", a.post); return { ok: true };
    }
    case "reject": {
      await needPlace();
      await runQuery("UPDATE feed_post_rooms SET pending = 0, removed_at = ?, removed_by = ? WHERE post_id = ? AND room_id = ?", [t, "rejected:" + who, a.post, roomId]);
      const p = await getRow(a.post);
      const why = cleanLine(a.reason, 200);
      if (p) await notify(p.author_id, { title: "Your post wasn't approved", body: `${(rooms.getCached(roomId) || {}).title || roomId} didn't take it${why ? ": " + why : "."}`, link: `/feed/p/${p.id}`, ref: "feed-no:" + p.id + ":" + roomId });
      await log("reject", a.post + (why ? ": " + why : "")); return { ok: true };
    }
    case "remove": { await removeFromRoom(user, a.post, roomId); await markDone(roomId, a.post, "", "removed", who); return { ok: true }; }
    case "restore": { await restoreToRoom(user, a.post, roomId); return { ok: true }; }
    case "lock": case "unlock": {
      await needPlace();
      if (!(await canLock(user, a.post))) throw new Refuse(403, "This post is on the main feed or in other rooms too - only an admin can lock it.");
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
      WHERE r.resolved_at IS NULL AND (d.at IS NULL OR r.created > d.at) ORDER BY r.created DESC LIMIT 500`, [roomId]);
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
  const C = cids.length ? await getQuery(`SELECT c.id, c.body, c.deleted_at, u.username FROM feed_comments c LEFT JOIN users u ON u.userId = c.author_id WHERE c.id IN (${cids.map(() => "?").join(",")})`, cids) : [];
  return list.filter((g) => posts.has(g.postId)).map((g) => ({ ...g, post: posts.get(g.postId), comment: g.commentId ? C.find((c) => c.id === g.commentId) || null : null }))
    .filter((g) => !g.comment || !g.comment.deleted_at).sort((a, b) => b.count - a.count || b.last - a.last);
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
  roomMod, roomSettings, roomPostRefusal, roomReports, roomPending, roomMembers, roomAudit, canLock, setFollowerCheck, WHO, ROOM_DEFAULTS, MAX_PINS,
  init, config, setConfig, loadConfig, DEFAULTS, LIMITS, Refuse, postRefusal, postRate, account, isNewAccount, usedBytes,
  list, get, getRow, decorate, canModerate, create, edit, remove, removeFromRoom, restoreToRoom, adminSet, vote, voteComment,
  hotRank, controversy, wilson, rankSpec, recountPost, recountComment, rehotAll, SORTS, WINDOWS, TIMED, CSORTS, cleanSort, cleanWindow, cleanCSort,
  downCounts, HOT_EPOCH, _votes: voteLog,
  comments, comment, editComment, removeComment, report, reports, resolveReports, REASONS, ban, unban, bans,
  setRestricted, mentionOn, setMention, takeMentions, sweep, hotScore, priceOf, isStaff, burst, _setClock, _gaps: gaps,
  TITLE_MAX, BODY_MAX, COMMENT_MAX, MAX_IMAGES, MAX_ATTACH, MAX_ROOMS,
};
