// follows.js — following rooms and people (1.99bz). The "Following" tab on /feed, the follow buttons
// (room feed header, profiles, post author chips), follower counts, and the optional inbox notice
// when someone you follow posts.
//
//   follows        follower (userId), target_kind 'user' | 'room', target_id (userId | rooms_registry
//                  room_id), created_at (ms). PRIMARY KEY (follower, target_kind, target_id).
//                  Shaped for v2 (§10 social graph): one edge table for every followable kind, so v2
//                  can add 'tag' / 'show' targets without a migration.
//   follow_prefs   user_id, notify_posts (0/1, default 0 = off): an inbox notice when someone you
//                  follow posts, or someone posts in a room you follow
//
// Privacy: follower / following COUNTS are public (profiles, rooms). The LISTS (who you follow, who
// follows you) are shown only to the user themselves - never to visitors, room owners or the people
// followed. Routes: POST /api/follow {kind, id, on}, POST /api/follow/prefs {notify}. Same-site JSON
// with X-Requested-With: fetch, like the rest of the feed.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const rooms = require("./rooms");

const KINDS = new Set(["user", "room"]);
const MAX_FOLLOWS = 2000;              // per account (a scraper-ish follow-everything is pointless anyway)
const NOTIFY_MAX = 500;                // notices one post may send
let NOW = () => Date.now();
function _setClock(fn) { NOW = fn; }

class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS follows (
        follower TEXT NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (follower, target_kind, target_id))`);
      await runQuery("CREATE INDEX IF NOT EXISTS follows_target ON follows (target_kind, target_id)");
      await runQuery("CREATE TABLE IF NOT EXISTS follow_prefs (user_id TEXT PRIMARY KEY, notify_posts INTEGER NOT NULL DEFAULT 0, updated INTEGER)");
    })().catch((e) => { console.error("[follows] init:", e.message); ready = null; throw e; });
  }
  return ready;
}

// burst guard per follower (toggling follow on and off quickly)
const gaps = new Map();
function burst(key, ms) {
  const t = NOW(), last = gaps.get(key) || 0;
  if (t - last < ms) return true;
  gaps.set(key, t);
  if (gaps.size > 5000) for (const [k, v] of gaps) if (t - v > 600e3) gaps.delete(k);
  return false;
}

/** The target as {kind, id, label, href} or null when it doesn't exist. `id` for rooms: room id or slug. */
async function resolve(kind, id) {
  const raw = String(id || "").slice(0, 128);
  if (!KINDS.has(kind) || !raw) return null;
  if (kind === "room") {
    const R = (await rooms.get(raw)) || (await rooms.bySlug(raw.replace(/^p\//i, "")));
    // 1.99df: a profile pad isn't followable as a pad - follow the person (their profile posts are theirs)
    if (R && R.profile) return null;
    return R ? { kind, id: R.id, label: R.title, href: require("./pads").padHref(R) } : null;
  }
  const C = new Set((await getQuery("PRAGMA table_info(users)")).map((c) => c.name));
  const u = (await getQuery(`SELECT userId, username, ${C.has("displayname") ? "displayname" : "NULL AS displayname"},
                             ${C.has("archived_at") ? "archived_at" : "NULL AS archived_at"} FROM users WHERE userId = ? OR username = ?
                             ORDER BY (userId = ?) DESC LIMIT 1`, [raw, raw, raw]))[0];   // pages use the username (no internal ids in HTML)
  if (!u || u.archived_at) return null;
  return { kind, id: u.userId, label: u.displayname || u.username, username: u.username, href: "/u/" + encodeURIComponent(u.username) };
}

async function follow(user, kind, id, on = true) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in to follow.");
  const T = await resolve(kind, id);
  if (!T) throw new Refuse(404, kind === "room" ? "No such pad." : "No such person.");
  if (kind === "user" && T.id === user.userId) throw new Refuse(400, "You can't follow yourself.");
  if (burst("f|" + user.userId + "|" + kind + "|" + T.id, 700)) throw new Refuse(429, "Easy there.");
  if (on) {
    const n = (await getQuery("SELECT COUNT(*) AS n FROM follows WHERE follower = ?", [user.userId]))[0].n;
    if (n >= MAX_FOLLOWS) throw new Refuse(429, `You can follow up to ${MAX_FOLLOWS} pads and people.`);
    await runQuery("INSERT OR IGNORE INTO follows (follower, target_kind, target_id, created_at) VALUES (?, ?, ?, ?)", [user.userId, kind, T.id, NOW()]);
  } else {
    await runQuery("DELETE FROM follows WHERE follower = ? AND target_kind = ? AND target_id = ?", [user.userId, kind, T.id]);
  }
  return { following: !!on, followers: await followers(kind, T.id) };
}

async function isFollowing(userId, kind, id) {
  if (!userId) return false;
  await init();
  return !!(await getQuery("SELECT 1 FROM follows WHERE follower = ? AND target_kind = ? AND target_id = ?", [userId, kind, String(id)])).length;
}
/** Of these target ids, the ones `userId` follows (a Set). */
async function followedAmong(userId, kind, ids) {
  const want = [...new Set((ids || []).filter(Boolean).map(String))];
  if (!userId || !want.length) return new Set();
  await init();
  const rows = await getQuery(`SELECT target_id FROM follows WHERE follower = ? AND target_kind = ? AND target_id IN (${want.map(() => "?").join(",")})`,
                              [userId, kind, ...want]);
  return new Set(rows.map((r) => r.target_id));
}
async function followers(kind, id) {
  await init();
  return (await getQuery("SELECT COUNT(*) AS n FROM follows WHERE target_kind = ? AND target_id = ?", [kind, String(id)]))[0].n;
}
async function followingCount(userId) {
  await init();
  return (await getQuery("SELECT COUNT(*) AS n FROM follows WHERE follower = ?", [String(userId)]))[0].n;
}
/** Public counts for a profile / room chip. */
async function counts(kind, id) {
  return { followers: await followers(kind, id), following: kind === "user" ? await followingCount(id) : 0 };
}

/**
 * The lists - for the user THEMSELVES only (the route checks). -> {rooms: [...], people: [...], followers: [...]}
 * Archived accounts and rooms that left the registry are skipped (the edge stays; it comes back if they do).
 */
async function lists(userId) {
  await init();
  const mine = await getQuery("SELECT target_kind, target_id, created_at FROM follows WHERE follower = ? ORDER BY created_at DESC LIMIT ?", [userId, MAX_FOLLOWS]);
  const out = { rooms: [], people: [], followers: [] };
  for (const f of mine) {
    const T = await resolve(f.target_kind, f.target_id);
    if (T) (f.target_kind === "room" ? out.rooms : out.people).push({ ...T, since: f.created_at });
  }
  const fs = await getQuery("SELECT follower, created_at FROM follows WHERE target_kind = 'user' AND target_id = ? ORDER BY created_at DESC LIMIT 500", [userId]);
  for (const f of fs) {
    const T = await resolve("user", f.follower);
    if (T) out.followers.push({ ...T, since: f.created_at });
  }
  return out;
}

async function prefs(userId) {
  await init();
  const r = (await getQuery("SELECT notify_posts FROM follow_prefs WHERE user_id = ?", [String(userId)]))[0];
  return { notify: !!(r && r.notify_posts) };
}
async function setPrefs(user, { notify }) {
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  await init();
  await runQuery(`INSERT INTO follow_prefs (user_id, notify_posts, updated) VALUES (?, ?, ?)
                  ON CONFLICT(user_id) DO UPDATE SET notify_posts = excluded.notify_posts, updated = excluded.updated`, [user.userId, notify ? 1 : 0, NOW()]);
  return { notify: !!notify };
}

/**
 * SQL for "posts this user follows": by a followed author, or in a followed room (and not taken out
 * of it by the room's owner). `p` = feed_posts alias. -> {sql, args}
 */
function feedFilter(userId) {
  return {
    sql: `(p.author_id IN (SELECT target_id FROM follows WHERE follower = ? AND target_kind = 'user')
           OR EXISTS (SELECT 1 FROM feed_post_rooms fr WHERE fr.post_id = p.id AND fr.removed_at IS NULL AND fr.pending = 0 AND fr.hidden_at IS NULL
                      AND fr.room_id IN (SELECT target_id FROM follows WHERE follower = ? AND target_kind = 'room')))`,
    args: [userId, userId],
  };
}

/**
 * A new post: an inbox notice to followers who switched notices on (default off). One per follower
 * per post (the author's followers and the post's rooms' followers, deduped), never to the author,
 * at most NOTIFY_MAX. Runs after the post is stored; failures are logged, never thrown.
 */
async function notifyNewPost(post, authorName) {
  try {
    await init();
    const roomIds = (post.rooms || []).map((r) => r.id);
    const rows = await getQuery(`SELECT DISTINCT f.follower FROM follows f JOIN follow_prefs fp ON fp.user_id = f.follower AND fp.notify_posts = 1
                                 WHERE f.follower != ? AND ((f.target_kind = 'user' AND f.target_id = ?)
                                   ${roomIds.length ? `OR (f.target_kind = 'room' AND f.target_id IN (${roomIds.map(() => "?").join(",")}))` : ""})
                                 LIMIT ?`, [post.author.userId, post.author.userId, ...roomIds, NOTIFY_MAX]);
    if (!rows.length) return 0;
    const inbox = require("./inbox");
    const what = post.nsfw ? "an NSFW post" : require("./postlabel").postLabel({ ...post, author: post.author || { display: authorName } }).slice(0, 80);
    // 1.99df: a profile post reads "X posted on their profile"
    const where = (post.rooms || []).some((r) => r.profile) ? " on their profile"
      : (post.rooms || []).length ? " in " + post.rooms.map((r) => (r.slug ? "p/" + r.slug : r.title)).slice(0, 2).join(", ") : "";
    let n = 0;
    for (const r of rows) {
      const ok = await inbox.addSafe(r.follower, { kind: "follow", title: `${authorName} posted${where}`, body: post.nsfw ? what : `"${what}"`,
                                                   link: post.url || "/feed/p/" + post.id, ref: "follow-post:" + post.id });
      if (ok) n++;
    }
    return n;
  } catch (e) { console.error("[follows] notify:", e.message); return 0; }
}

function register(app, { addUser }) {
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
  const fail = (res, e) => {
    const st = e && e.status && e.status < 500 ? e.status : 500;
    if (st === 500) console.error("[follows]", e);
    res.status(st).json({ ok: false, error: st === 500 ? "Something went wrong." : e.message });
  };
  app.post("/api/follow", addUser, guard, async (req, res) => {
    try {
      const b = req.body || {};
      res.json({ ok: true, ...(await follow(req.user, String(b.kind || ""), String(b.id || ""), b.on === undefined ? true : !!b.on)) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/follow/prefs", addUser, guard, async (req, res) => {
    try { res.json({ ok: true, ...(await setPrefs(req.user, { notify: !!(req.body || {}).notify })) }); } catch (e) { fail(res, e); }
  });
  // your own lists (never anyone else's)
  app.get("/api/follow/mine", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try { res.json({ ok: true, ...(await lists(req.user.userId)), prefs: await prefs(req.user.userId) }); } catch (e) { fail(res, e); }
  });
}

module.exports = { init, follow, isFollowing, followedAmong, followers, followingCount, counts, lists, prefs, setPrefs, feedFilter,
                   notifyNewPost, register, resolve, Refuse, MAX_FOLLOWS, _setClock, _gaps: gaps };
