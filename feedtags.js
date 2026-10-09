// feedtags.js — content tags on feed posts (1.99iq).
//
// A post carries up to MAX_TAGS tags. A tag is normalised before it is stored or matched: a leading "#" goes,
// it is lowercased (NFKC first), spaces / underscores become "-", anything that isn't a letter, a digit or "-"
// is dropped, and it must end up TAG_MIN..TAG_MAX characters long. "#Plant Care" -> "plant-care".
//
//   feed_post_tags  post_id + tag PK, created, removed_at / removed_by / removed_room (a pad mod took it off)
//
// Who changes them:
//   * the author, when posting (the composer's tag box) and in the post's Edit form (setTags replaces the set)
//   * a pad's owner / mods (rooms.canManage) and site staff: "remove this tag" on a post placed in their pad. The row
//     stays, marked removed, so the author can't simply put it back with an edit; the pad's audit log records it
//     (room_events feed-tag-remove).
// A crosspost starts with its original's tags (its own rows, so each pad moderates its own copy).
//
// Reading: tagsFor(ids) (decorate), filterSql(tag) (feedstore.list's ?tag= filter: /feed?tag=, /p/<pad>?tag=),
// popular(roomId) (the pad page's "Popular tags", the composer's suggestions). Popular counts only what the viewer
// could see anyway: live posts in live placements, never an Approved pad they're outside of.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const MAX_TAGS = 5, TAG_MIN = 2, TAG_MAX = 24;
let NOW = () => Date.now();

class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }
const isStaff = (u) => !!u && (u.class === "Admin" || u.class === "Staff");

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS feed_post_tags (post_id TEXT NOT NULL, tag TEXT NOT NULL, created INTEGER,
                      removed_at INTEGER, removed_by TEXT, removed_room TEXT, PRIMARY KEY (post_id, tag))`);
      await runQuery("CREATE INDEX IF NOT EXISTS feed_post_tags_tag ON feed_post_tags (tag, post_id)");
    })().catch((e) => { console.error("[tags] init:", e.message); ready = null; throw e; });
  }
  return ready;
}

/** One tag, normalised, or null when nothing usable is left. */
function normTag(raw) {
  let s = String(raw == null ? "" : raw).normalize("NFKC").trim().replace(/^#+/, "").toLowerCase();
  s = s.replace(/[\s_]+/g, "-").replace(/[^\p{L}\p{N}-]+/gu, "").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
  const n = Array.from(s).length;
  if (n < TAG_MIN) return null;
  if (n > TAG_MAX) s = Array.from(s).slice(0, TAG_MAX).join("").replace(/-+$/, "");
  return Array.from(s).length >= TAG_MIN ? s : null;
}
/**
 * The tags a composer / edit form sent: an array, or one string ("plants, music #diy"). -> unique normalised tags.
 * More than MAX_TAGS usable ones is refused (the box says how many fit); unusable bits are dropped.
 */
function parseTags(input) {
  if (input === undefined || input === null || input === "") return [];
  // a plain space-separated string ("plants music") is several tags; with commas / "#" a phrase stays one ("plant care, diy")
  let pieces;
  if (Array.isArray(input)) pieces = input.slice(0, 50).map(String);
  else { const s = String(input).slice(0, 600); pieces = /[,#\n]/.test(s) ? s.split(/[,#\n]+/) : s.split(/\s+/); }
  const out = [];
  for (const p of pieces) {
    const t = normTag(p);
    if (t && !out.includes(t)) out.push(t);
  }
  if (out.length > MAX_TAGS) throw new Refuse(400, `Up to ${MAX_TAGS} tags per post.`);
  return out;
}

/** The author's set: replaces their live tags; a tag a mod removed stays removed (it isn't re-added). */
async function setTags(postId, tags) {
  await init();
  const want = [...new Set((tags || []).map(normTag).filter(Boolean))].slice(0, MAX_TAGS);
  const have = await getQuery("SELECT tag, removed_at FROM feed_post_tags WHERE post_id = ?", [postId]);
  const t = NOW();
  for (const h of have) if (!h.removed_at && !want.includes(h.tag)) await runQuery("DELETE FROM feed_post_tags WHERE post_id = ? AND tag = ?", [postId, h.tag]);
  for (const w of want) if (!have.some((h) => h.tag === w)) await runQuery("INSERT OR IGNORE INTO feed_post_tags (post_id, tag, created) VALUES (?, ?, ?)", [postId, w, t]);
  return liveTags(postId);
}
async function liveTags(postId) {
  return (await getQuery("SELECT tag FROM feed_post_tags WHERE post_id = ? AND removed_at IS NULL ORDER BY created, rowid", [postId])).map((r) => r.tag);
}
/** A crosspost starts with its original's live tags. */
async function copyTags(fromId, toId) {
  await init();
  const t = NOW();
  for (const tag of await liveTags(fromId)) await runQuery("INSERT OR IGNORE INTO feed_post_tags (post_id, tag, created) VALUES (?, ?, ?)", [toId, tag, t]);
}
/** ids -> Map(post id -> [tag]) (live tags only, in the order they were added). One query. */
async function tagsFor(ids) {
  const want = [...new Set((ids || []).filter(Boolean).map(String))];
  const out = new Map();
  if (!want.length) return out;
  await init();
  const rows = await getQuery(`SELECT post_id, tag FROM feed_post_tags WHERE removed_at IS NULL AND post_id IN (${want.map(() => "?").join(",")}) ORDER BY created, rowid`, want);
  for (const r of rows) {
    if (!out.has(r.post_id)) out.set(r.post_id, []);
    out.get(r.post_id).push(r.tag);
  }
  return out;
}
/** SQL over `feed_posts p` for feedstore.list: the post has this live tag. */
function filterSql(tag) {
  return { sql: "EXISTS (SELECT 1 FROM feed_post_tags ftg WHERE ftg.post_id = p.id AND ftg.tag = ? AND ftg.removed_at IS NULL)", args: [tag] };
}

/**
 * The most-used tags (live posts, last `days` days): in pad `roomId` (its live placements), or across every pad the
 * viewer can see (roomId null). -> [{tag, n}]
 */
async function popular(roomId = null, { viewer = null, days = 90, limit = 10 } = {}) {
  await init();
  const store = require("./feedstore");
  const since = NOW() - days * 86400e3;
  if (roomId) {
    const blocked = await store.blockedFor(viewer);
    if (blocked.includes(String(roomId))) return [];
    return getQuery(`SELECT ftg.tag, COUNT(DISTINCT p.id) AS n FROM feed_post_tags ftg
                     JOIN feed_posts p ON p.id = ftg.post_id AND p.deleted_at IS NULL AND p.hidden_at IS NULL
                     JOIN feed_post_rooms pr ON pr.post_id = p.id AND pr.room_id = ? AND pr.removed_at IS NULL AND pr.pending = 0 AND pr.hidden_at IS NULL
                     WHERE ftg.removed_at IS NULL AND p.created > ? GROUP BY ftg.tag ORDER BY n DESC, MAX(p.created) DESC LIMIT ?`, [String(roomId), since, limit]);
  }
  const v = store.visibleSql(NOW(), await store.blockedFor(viewer));
  return getQuery(`SELECT ftg.tag, COUNT(DISTINCT p.id) AS n FROM feed_post_tags ftg
                   JOIN feed_posts p ON p.id = ftg.post_id AND p.deleted_at IS NULL AND p.hidden_at IS NULL AND p.in_all != 0
                   WHERE ftg.removed_at IS NULL AND p.created > ? AND ${v.sql} GROUP BY ftg.tag ORDER BY n DESC, MAX(p.created) DESC LIMIT ?`, [since, ...v.args, limit]);
}
/** Popular tags for several pads at once (the composer's suggestions): Map(room id -> [tag]). */
async function popularMany(roomIds, opts = {}) {
  const out = new Map();
  for (const id of roomIds || []) out.set(id, (await popular(id, { ...opts, limit: opts.limit || 8 }).catch(() => [])).map((r) => r.tag));
  return out;
}

/**
 * A pad mod (owner / site staff) takes a tag off a post placed in their pad. `roomId` (optional) names the pad they're
 * acting for; without it the first live placement they manage is used. -> {tags: [...the post's live tags]}
 */
async function removeTag(user, postId, tagRaw, roomId = null) {
  await init();
  const rooms = require("./rooms");
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const tag = normTag(tagRaw);
  const p = (await getQuery("SELECT id, author_id, deleted_at FROM feed_posts WHERE id = ?", [String(postId || "")]))[0];
  if (!p || p.deleted_at) throw new Refuse(404, "No such post.");
  const row = tag ? (await getQuery("SELECT * FROM feed_post_tags WHERE post_id = ? AND tag = ?", [p.id, tag]))[0] : null;
  if (!row || row.removed_at) throw new Refuse(404, "That post doesn't have that tag.");
  const placed = (await getQuery("SELECT room_id FROM feed_post_rooms WHERE post_id = ? AND removed_at IS NULL", [p.id])).map((r) => r.room_id);
  let acting = null;
  for (const rid of roomId ? placed.filter((r) => r === String(roomId)) : placed) {
    if (await rooms.canManage(user, rid)) { acting = rid; break; }
  }
  if (!acting && !isStaff(user)) throw new Refuse(403, "Only the mods of a pad this post is in can remove its tags.");
  const who = user.username || user.userId;
  await runQuery("UPDATE feed_post_tags SET removed_at = ?, removed_by = ?, removed_room = ? WHERE post_id = ? AND tag = ?", [NOW(), who, acting || "", p.id, tag]);
  if (acting) await rooms.event(acting, "feed-tag-remove", who, `#${tag} from post ${p.id}`).catch(() => {});
  return { tags: await liveTags(p.id) };
}

function register(app, { addUser }) {
  init().catch(() => {});
  const sameSite = (req) => {
    const host = req.get("host"), src = req.get("origin") || req.get("referer");
    if (!src || !host) return true;
    try { return new URL(src).host === host; } catch (e) { return false; }
  };
  const fail = (res, e) => {
    const st = e && e.status && e.status < 500 ? e.status : 500;
    if (st === 500) console.error("[tags]", e);
    res.status(st).json({ ok: false, error: st === 500 ? "Something went wrong." : e.message });
  };
  // a pad mod removes a tag from a post: {tag, room?}
  app.post("/api/feed/posts/:id/tags/remove", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      const u = await require("./feedstore").account(req.user.userId);
      const b = req.body || {};
      let roomId = null;
      if (b.room) { const R = await require("./feedstore").communityOf(String(b.room)); roomId = R ? R.id : String(b.room); }
      res.json({ ok: true, ...(await removeTag(u, req.params.id, b.tag, roomId)) });
    } catch (e) { fail(res, e); }
  });
  // popular tags: ?pad=<slug> (that pad) or everything the viewer can see
  app.get("/api/feed/tags", addUser, async (req, res) => {
    res.set("Cache-Control", "private, max-age=60");
    try {
      const store = require("./feedstore");
      const viewer = req.user && req.user.userId ? await store.account(req.user.userId) : null;
      let roomId = null;
      if (req.query.pad) {
        const R = await store.communityOf(String(req.query.pad).slice(0, 128));
        if (!R) return res.status(404).json({ ok: false, error: "No such pad." });
        roomId = R.id;
      }
      res.json({ ok: true, tags: await popular(roomId, { viewer, limit: 15 }) });
    } catch (e) { fail(res, e); }
  });
}

module.exports = { init, normTag, parseTags, setTags, copyTags, liveTags, tagsFor, filterSql, popular, popularMany, removeTag, register, Refuse,
                   MAX_TAGS, TAG_MIN, TAG_MAX, _setClock: (fn) => { NOW = fn || (() => Date.now()); } };
