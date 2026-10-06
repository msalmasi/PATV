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
//   feed_votes         post_id, user_id, value (+1 today; v2 allows -1), created - one row per user
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
});
const INT_KEYS = Object.keys(DEFAULTS).filter((k) => typeof DEFAULTS[k] === "number");
const LIMITS = { max_image_mb: [1, 50], max_audio_mb: [1, 200], max_video_mb: [1, 500], max_audio_secs: [10, 3600], max_video_secs: [5, 1800],
  user_quota_mb: [10, 100000], global_quota_gb: [1, 1000], min_free_gb: [1, 500], media_min_level: [0, 100], new_account_hours: [0, 720],
  new_account_posts_per_day: [0, 100], posts_per_hour: [1, 1000], posts_per_day: [1, 5000], comments_per_hour: [1, 5000],
  uploads_per_hour: [1, 1000], upload_mb_per_day: [10, 100000], report_hide_threshold: [1, 100], deleted_purge_days: [0, 365],
  price_post: [0, 1e9], price_link: [0, 1e9], price_image: [0, 1e9], price_audio: [0, 1e9], price_video: [0, 1e9], mention_gap_min: [1, 1440],
  post_gap_secs: [0, 3600], comment_gap_secs: [0, 600] };

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
    })().catch((e) => { console.error("[feed] init:", e.message); ready = null; throw e; });
  }
  return ready;
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
  CONFIG = merged;
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
async function decorate(rows, viewer) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const q = ids.map(() => "?").join(",");
  const [A, PR, AT, MV, FW] = await Promise.all([
    authors(rows.map((r) => r.author_id)),
    getQuery(`SELECT post_id, room_id, removed_at FROM feed_post_rooms WHERE post_id IN (${q})`, ids),
    getQuery(`SELECT * FROM feed_attachments WHERE post_id IN (${q}) AND state = 'ready' ORDER BY sort, created`, ids),
    viewer && viewer.userId ? getQuery(`SELECT post_id, value FROM feed_votes WHERE user_id = ? AND post_id IN (${q})`, [viewer.userId, ...ids]) : [],
    // 1.99bz: which of these authors the viewer follows (the author chip's Follow button)
    viewer && viewer.userId ? require("./follows").followedAmong(viewer.userId, "user", rows.map((r) => r.author_id)) : new Set(),
  ]);
  const staff = isStaff(viewer);
  return rows.map((r) => {
    const roomsOf = PR.filter((x) => x.post_id === r.id).map((x) => {
      const R = rooms.getCached(x.room_id);
      return { id: x.room_id, slug: R ? R.slug : rooms.slugify(x.room_id), title: R ? R.title : x.room_id, removed: !!x.removed_at, owner: R && R.owner ? R.owner.userId : null };
    });
    const att = AT.filter((a) => a.post_id === r.id).map((a) => ({ id: a.id, kind: a.kind, ct: a.ct, file: a.file, thumb: a.thumb, poster: a.poster,
                                                                 w: a.w, h: a.h, secs: a.secs }));
    const link = parseJson(r.link_json);
    return {
      id: r.id, title: r.title || "", body: r.body || "", created: r.created, edited: r.edited, score: r.score, comments: r.comments,
      nsfw: effNsfw(r), nsfwAuthor: !!r.nsfw, nsfwAdmin: r.nsfw_admin, global: !!r.global, cost: r.cost,
      deleted: !!r.deleted_at, hidden: !!r.hidden_at, deleteReason: r.delete_reason || null,
      author: A.get(r.author_id) || { userId: r.author_id, username: "[gone]", display: "[deleted account]" },
      followingAuthor: FW.has(r.author_id),
      mine: !!(viewer && viewer.userId === r.author_id),
      voted: !!MV.find((v) => v.post_id === r.id && v.value > 0),
      rooms: roomsOf.filter((x) => !x.removed || staff),
      roomsAll: roomsOf,
      images: att.filter((a) => a.kind === "image"), audio: att.filter((a) => a.kind === "audio"), video: att.filter((a) => a.kind === "video"),
      link: link && link.url ? { ...link, thumbFile: (att.find((a) => a.kind === "preview") || {}).thumb || null } : null,
    };
  });
}

function hotScore(p, t = NOW()) {
  const ageH = Math.max(0, (t - p.created) / 3600e3);
  return (Math.max(0, p.score) + 0.5 * Math.max(0, p.comments) + 1) / Math.pow(ageH + 2, 1.5);
}

/**
 * A page of posts. scope: {room: room id} | {global: true} | {author: userId}. sort new|top|hot.
 * Visible = not deleted, not hidden (staff see hidden ones), and in a room: not removed from it.
 */
async function list({ room = null, author = null, following = null, sort = "new", page = 1, top = "all", viewer = null, limit = PAGE } = {}) {
  await init();
  const staff = isStaff(viewer);
  const where = ["p.deleted_at IS NULL"], args = [];
  if (!staff) where.push("p.hidden_at IS NULL");
  let from = "feed_posts p";
  if (following) {
    // 1.99bz: posts by people `following` follows + posts in rooms they follow (one row per post)
    await require("./follows").init();
    const f = require("./follows").feedFilter(following);
    where.push(f.sql); args.push(...f.args);
  } else if (room) {
    from += " JOIN feed_post_rooms pr ON pr.post_id = p.id AND pr.room_id = ?";
    args.push(room);
    if (!staff) where.push("pr.removed_at IS NULL");
  } else if (author) {
    where.push("p.author_id = ?"); args.push(author);
  } else {
    where.push("p.global = 1");
  }
  const t = NOW();
  const win = { day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3 }[top];
  if (sort === "top" && win) { where.push("p.created > ?"); args.push(t - win); }
  page = Math.max(1, Math.min(200, Math.floor(Number(page)) || 1));
  let rows;
  if (sort === "hot") {
    // rank the last 14 days in JS (no pow() in every SQLite build), then page
    const cand = await getQuery(`SELECT p.* FROM ${from} WHERE ${where.join(" AND ")} AND p.created > ? ORDER BY p.created DESC LIMIT 1000`, [...args, t - 14 * 86400e3]);
    cand.sort((a, b) => hotScore(b, t) - hotScore(a, t) || b.created - a.created);
    let ranked = cand;
    if (cand.length < page * limit) {
      const older = await getQuery(`SELECT p.* FROM ${from} WHERE ${where.join(" AND ")} AND p.created <= ? ORDER BY p.created DESC LIMIT ?`,
                                   [...args, t - 14 * 86400e3, page * limit - cand.length + 1]);
      ranked = cand.concat(older);
    }
    rows = ranked.slice((page - 1) * limit, page * limit + 1);
  } else {
    const order = sort === "top" ? "p.score DESC, p.comments DESC, p.created DESC" : "p.created DESC";
    rows = await getQuery(`SELECT p.* FROM ${from} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`, [...args, limit + 1, (page - 1) * limit]);
  }
  const more = rows.length > limit;
  return { posts: await decorate(rows.slice(0, limit), viewer), more, page };
}

async function getRow(id) {
  if (!ID_RE.test(String(id || ""))) return null;
  await init();
  return (await getQuery("SELECT * FROM feed_posts WHERE id = ?", [id]))[0] || null;
}
async function get(id, viewer) {
  const r = await getRow(id);
  if (!r) return null;
  return (await decorate([r], viewer))[0];
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
    for (const rid of roomIds) {
      await runQuery("INSERT OR IGNORE INTO feed_post_rooms (post_id, room_id, created) VALUES (?, ?, ?)", [id, rid, t]);
      if (!announce || announce.has(rid) || [...announce].some((x) => (rooms.getCached(rid) || {}).slug === x)) await queueMention(rid, id);
    }
  } catch (e) {
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
  return true;
}

/** Admin: force the NSFW flag (1/0) or give it back to the author (null). Also un-hides / hides. */
async function adminSet(user, id, { nsfw, hidden } = {}) {
  if (!isStaff(user)) throw new Refuse(403, "Admins only.");
  const r = await getRow(id);
  if (!r) throw new Refuse(404, "No such post.");
  if (nsfw !== undefined) await runQuery("UPDATE feed_posts SET nsfw_admin = ? WHERE id = ?", [nsfw === null ? null : (nsfw ? 1 : 0), id]);
  if (hidden !== undefined) {
    await runQuery("UPDATE feed_posts SET hidden_at = ? WHERE id = ?", [hidden ? NOW() : null, id]);
    if (!hidden) await runQuery("UPDATE feed_reports SET resolved_at = ?, resolved_by = ?, action = 'kept' WHERE post_id = ? AND resolved_at IS NULL", [NOW(), user.username, id]);
  }
  return get(id, user);
}

// ── votes ──
async function vote(user, id, on) {
  const r = await getRow(id);
  if (!r || r.deleted_at || r.hidden_at) throw new Refuse(404, "No such post.");
  if (!user || !user.userId) throw new Refuse(401, "Sign in to vote.");
  const g = burst("vote|" + user.userId + "|" + id, 400);
  if (g) throw new Refuse(429, "Easy there.");
  const want = on === undefined ? !(await getQuery("SELECT 1 FROM feed_votes WHERE post_id = ? AND user_id = ?", [id, user.userId])).length : !!on;
  if (want) await runQuery("INSERT OR IGNORE INTO feed_votes (post_id, user_id, value, created) VALUES (?, ?, 1, ?)", [id, user.userId, NOW()]);
  else await runQuery("DELETE FROM feed_votes WHERE post_id = ? AND user_id = ?", [id, user.userId]);
  const s = (await getQuery("SELECT COALESCE(SUM(value), 0) AS s FROM feed_votes WHERE post_id = ?", [id]))[0].s;
  await runQuery("UPDATE feed_posts SET score = ? WHERE id = ?", [s, id]);
  return { voted: want, score: s };
}

// ── comments (one level of replies) ──
async function comments(postId, viewer) {
  await init();
  const rows = await getQuery("SELECT * FROM feed_comments WHERE post_id = ? ORDER BY created", [postId]);
  const A = await authors(rows.map((r) => r.author_id));
  const all = rows.map((c) => ({ id: c.id, parent: c.parent_id, body: c.deleted_at ? "" : c.body, deleted: !!c.deleted_at, created: c.created, edited: c.edited,
    author: c.deleted_at ? null : A.get(c.author_id) || { username: "[gone]", display: "[deleted account]" },
    mine: !!(viewer && viewer.userId === c.author_id && !c.deleted_at), replies: [] }));
  const top = [], byId = new Map(all.map((c) => [c.id, c]));
  for (const c of all) {
    if (c.parent && byId.has(c.parent)) byId.get(c.parent).replies.push(c);
    else top.push(c);
  }
  // a deleted comment with no replies just goes away
  return top.filter((c) => !c.deleted || c.replies.some((r) => !r.deleted)).map((c) => ({ ...c, replies: c.replies.filter((r) => !r.deleted) }));
}

async function comment(user, postId, { body, parent } = {}) {
  const p = await getRow(postId);
  if (!p || p.deleted_at || p.hidden_at) throw new Refuse(404, "No such post.");
  const u = await account(user && user.userId);
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
  await runQuery("INSERT INTO feed_comments (id, post_id, parent_id, author_id, body, created) VALUES (?, ?, ?, ?, ?, ?)",
                 [id, postId, par ? par.id : null, u.userId, text, NOW()]);
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
async function removeComment(user, id) {
  const c = (await getQuery("SELECT * FROM feed_comments WHERE id = ?", [String(id)]))[0];
  if (!c || c.deleted_at) throw new Refuse(404, "No such comment.");
  let ok = user && (user.userId === c.author_id || isStaff(user));
  if (!ok && user) {
    for (const r of await getQuery("SELECT room_id FROM feed_post_rooms WHERE post_id = ?", [c.post_id])) {
      if (await rooms.canManage(user, r.room_id)) { ok = true; break; }
    }
  }
  if (!ok) throw new Refuse(403, "You can't delete that comment.");
  await runQuery("UPDATE feed_comments SET deleted_at = ?, deleted_by = ? WHERE id = ?", [NOW(), user.userId === c.author_id ? "author" : user.username, c.id]);
  await runQuery("UPDATE feed_reports SET resolved_at = ?, resolved_by = ?, action = 'deleted' WHERE comment_id = ? AND resolved_at IS NULL", [NOW(), user.username, c.id]);
  await recount(c.post_id);
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

module.exports = {
  init, config, setConfig, loadConfig, DEFAULTS, LIMITS, Refuse, postRefusal, postRate, account, isNewAccount, usedBytes,
  list, get, getRow, decorate, canModerate, create, edit, remove, removeFromRoom, restoreToRoom, adminSet, vote,
  comments, comment, editComment, removeComment, report, reports, resolveReports, REASONS, ban, unban, bans,
  setRestricted, mentionOn, setMention, takeMentions, sweep, hotScore, priceOf, isStaff, burst, _setClock, _gaps: gaps,
  TITLE_MAX, BODY_MAX, COMMENT_MAX, MAX_IMAGES, MAX_ATTACH, MAX_ROOMS,
};
