// contentaudit.js — abuse metadata on feed posts and comments (1.99cc) and direct messages (1.99cp). ADMIN-ONLY.
//
// What: when a post or comment is created or edited, one row in content_audit with
//   ip          the client IP (guard.clientAddr: behind nginx on this box, Cloudflare's CF-Connecting-IP,
//               else the last X-Forwarded-For hop; otherwise the socket) - RAW, nulled after RAW_DAYS (90)
//   ua          the User-Agent (<= 300 chars) - nulled after RAW_DAYS
//   ip_hash     HMAC-SHA256(per-database salt, network) - IPv4 as is, IPv6 by its /64 - kept with the
//               row (HASH_DAYS, 365) so repeat abuse can still be matched after the raw IP is gone
//   lang        Accept-Language (<= 100 chars), country (Cloudflare's CF-IPCountry, 2 letters, no
//               lookups of our own), via (cf | xff | direct: how trustworthy the IP is)
//   acct_age_s  the account's age at the time, linked (JSON {camfrog, discord, twitch} booleans)
//   session_hash HMAC of the browser's device cookie (patv_dev, welcome.js) - the same browser
//               across logins, never the cookie itself
// Rows are deleted entirely after HASH_DAYS. sweep() runs daily (feedweb registers it).
//
// Who sees it: site Admins only (class "Admin" - not Staff, not room owners, never the public), through
// details() -> GET /api/feed/admin/details, and EVERY such view is written to content_audit_views.
// Room owners get ownerInfo(): the account's age and which identities are linked - no network data.
// Nothing here is ever put in a page, a public API, a log line or an error message: callers log
// only e.message of DB errors, and record() swallows its own failures (posting never fails on it).
"use strict";
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");
const guard = require("./middleware/authGuard");

const RAW_DAYS = 90, HASH_DAYS = 365, SAME_IP_DAYS = 90, VIEW_LOG_DAYS = 730;
const DAY = 86400e3;
let NOW = () => Date.now();
function _setClock(fn) { NOW = fn; }

let ready = null, salt = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS content_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, target_id TEXT NOT NULL, post_id TEXT, user_id TEXT NOT NULL,
        event TEXT NOT NULL, at INTEGER NOT NULL, ip TEXT, ua TEXT, ip_hash TEXT, via TEXT, lang TEXT, country TEXT,
        acct_age_s INTEGER, linked TEXT, session_hash TEXT, raw_purged_at INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS content_audit_target ON content_audit (kind, target_id)");
      await runQuery("CREATE INDEX IF NOT EXISTS content_audit_user ON content_audit (user_id, at)");
      await runQuery("CREATE INDEX IF NOT EXISTS content_audit_ip ON content_audit (ip_hash, at)");
      await runQuery("CREATE INDEX IF NOT EXISTS content_audit_sess ON content_audit (session_hash, at)");
      await runQuery("CREATE INDEX IF NOT EXISTS content_audit_at ON content_audit (at)");
      await runQuery(`CREATE TABLE IF NOT EXISTS content_audit_views (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, admin_id TEXT NOT NULL, admin_name TEXT,
        target_kind TEXT NOT NULL, target_id TEXT NOT NULL, subject_id TEXT, reason TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS content_audit_views_at ON content_audit_views (at)");
      await runQuery("CREATE TABLE IF NOT EXISTS content_audit_meta (k TEXT PRIMARY KEY, v TEXT)");
      // 1.99cg: bot = 1 for Pepe's own posts / comments (pepefeed.js) - written by his server, no network data
      if (!(await getQuery("PRAGMA table_info(content_audit)")).some((c) => c.name === "bot")) await runQuery("ALTER TABLE content_audit ADD COLUMN bot INTEGER NOT NULL DEFAULT 0");
      const s = (await getQuery("SELECT v FROM content_audit_meta WHERE k = 'salt'"))[0];
      if (s && s.v) salt = s.v;
      else {
        await runQuery("INSERT OR IGNORE INTO content_audit_meta (k, v) VALUES ('salt', ?)", [crypto.randomBytes(32).toString("hex")]);
        salt = (await getQuery("SELECT v FROM content_audit_meta WHERE k = 'salt'"))[0].v;
      }
    })().catch((e) => { console.error("[audit] init:", e.message); ready = null; throw e; });
  }
  return ready;
}

const hmac = (kind, v) => crypto.createHmac("sha256", salt || "unsalted").update(kind + ":" + v).digest("hex").slice(0, 32);
/** IPv4 as is; IPv6 by its /64 (one household / phone). null for loopback / unknown. */
function netOf(ip) {
  let s = String(ip || "").trim().toLowerCase();
  if (!s || s === "?") return null;
  if (s.startsWith("::ffff:")) s = s.slice(7);
  if (s.includes(":")) return s.split(":").slice(0, 4).join(":") + "::/64";
  return s;
}
const CTRL = /[\u0000-\u001f\u007f]/g;
const clip = (s, n) => (s == null ? null : String(s).replace(CTRL, " ").trim().slice(0, n) || null);

function createdMs(u) {
  if (!u || !u.created_at) return 0;
  const raw = String(u.created_at);
  const t = Date.parse(raw.replace(" ", "T") + (/Z|[+-]\d\d:?\d\d$/.test(raw) ? "" : "Z"));
  return Number.isFinite(t) ? t : 0;
}
const linkedOf = (u) => ({ camfrog: !!(u && u.camfrogUsername), discord: !!(u && u.discordId), twitch: !!(u && u.twitchId) });

/** What the request says about the client (NOT stored as is - record() does the hashing). */
function fromRequest(req) {
  const get = (h) => { try { return req.get(h) || null; } catch (e) { return null; } };
  // 1.99cf: proxy headers (incl. CF-IPCountry) count only when the request came through nginx on this box
  const { ip, via } = guard.clientAddr(req);
  const cc = via === "direct" ? "" : String(get("cf-ipcountry") || "").trim().toUpperCase();
  const dev = req.cookies && typeof req.cookies.patv_dev === "string" && /^[a-f0-9]{32}$/.test(req.cookies.patv_dev) ? req.cookies.patv_dev : null;
  return {
    ip: ip && ip !== "?" ? clip(ip, 64) : null, via, ua: clip(get("user-agent"), 300), lang: clip(get("accept-language"), 100),
    country: /^([A-Z]{2}|T1)$/.test(cc) ? cc : null, device: dev,
  };
}

/**
 * Record one create / edit. ctx: fromRequest(req). who: an account row (feedstore.account).
 * Never throws; never logs the values.
 */
async function record(ctx, { kind, id, postId = null, event = "create", user } = {}) {
  try {
    if (!ctx || !user || !user.userId || !id) return false;
    await init();
    const t = NOW();
    const net = netOf(ctx.ip);
    const born = createdMs(user);
    await runQuery(`INSERT INTO content_audit (kind, target_id, post_id, user_id, event, at, ip, ua, ip_hash, via, lang, country, acct_age_s, linked, session_hash, bot)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                   [kind === "comment" || kind === "message" ? kind : "post", String(id), postId ? String(postId) : null, user.userId, event === "edit" ? "edit" : "create", t,
                    ctx.ip || null, ctx.ua || null, net ? hmac("ip", net) : null, ctx.via || null, ctx.lang || null, ctx.country || null,
                    born ? Math.max(0, Math.floor((t - born) / 1000)) : null, JSON.stringify(linkedOf(user)), ctx.device ? hmac("dev", ctx.device) : null, ctx.bot ? 1 : 0]);
    return true;
  } catch (e) {
    console.error("[audit] record failed:", e.message);
    return false;
  }
}

/** Daily retention: raw IP + user agent nulled after RAW_DAYS; whole rows after HASH_DAYS; the view log after VIEW_LOG_DAYS. */
async function sweep(now = NOW()) {
  await init();
  const a = await runQuery("UPDATE content_audit SET ip = NULL, ua = NULL, raw_purged_at = ? WHERE at < ? AND (ip IS NOT NULL OR ua IS NOT NULL)", [now, now - RAW_DAYS * DAY]);
  const b = await runQuery("DELETE FROM content_audit WHERE at < ?", [now - HASH_DAYS * DAY]);
  const c = await runQuery("DELETE FROM content_audit_views WHERE at < ?", [now - VIEW_LOG_DAYS * DAY]);
  return { rawNulled: a.changes || 0, deleted: b.changes || 0, viewsDeleted: c.changes || 0 };
}

const isAdmin = (u) => !!u && u.class === "Admin";
const ageDays = (s) => (s == null ? null : Math.floor(Number(s) / 86400));

/** Room owners: the account's age and linked identities - nothing about the network. */
async function ownerInfo(userId) {
  const C = new Set((await getQuery("PRAGMA table_info(users)")).map((c) => c.name));
  const col = (c) => (C.has(c) ? c : `NULL AS ${c}`);
  const u = (await getQuery(`SELECT userId, ${col("created_at")}, ${col("camfrogUsername")}, ${col("discordId")}, ${col("twitchId")} FROM users WHERE userId = ?`, [String(userId || "")]))[0];
  if (!u) return null;
  const born = createdMs(u);
  return { ageDays: born ? Math.max(0, Math.floor((NOW() - born) / DAY)) : null, linked: linkedOf(u) };
}

/**
 * The admin details panel. target: {post} | {comment} | {user} (a userId). viewer: the admin.
 * Writes the view to content_audit_views FIRST (no log, no data). -> {subject, records, sameIp, sameDevice, history}
 */
async function details(viewer, target, { reason = null } = {}) {
  if (!isAdmin(viewer)) { const e = new Error("Admins only."); e.status = 403; throw e; }
  await init();
  let kind, tid, subjectId = null, postId = null;
  if (target.post) {
    kind = "post"; tid = String(target.post);
    const p = (await getQuery("SELECT author_id FROM feed_posts WHERE id = ?", [tid]))[0];
    if (!p) { const e = new Error("No such post."); e.status = 404; throw e; }
    subjectId = p.author_id; postId = tid;
  } else if (target.comment) {
    kind = "comment"; tid = String(target.comment);
    const c = (await getQuery("SELECT author_id, post_id FROM feed_comments WHERE id = ?", [tid]))[0];
    if (!c) { const e = new Error("No such comment."); e.status = 404; throw e; }
    subjectId = c.author_id; postId = c.post_id;
  } else if (target.message) {
    // 1.99cp: a direct message - ONLY one that has been reported (messages.js reportDetail); post = its conversation
    kind = "message"; tid = String(parseInt(target.message, 10) || 0);
    const r = (await getQuery("SELECT sender_id, conversation_id FROM dm_reports WHERE message_id = ? LIMIT 1", [tid]).catch(() => []))[0];
    if (!r) { const e = new Error("Only reported messages can be opened."); e.status = 404; throw e; }
    subjectId = r.sender_id; postId = r.conversation_id;
  } else if (target.user) {
    kind = "user"; tid = String(target.user);
    const u = (await getQuery("SELECT userId FROM users WHERE userId = ?", [tid]))[0];
    if (!u) { const e = new Error("No such user."); e.status = 404; throw e; }
    subjectId = tid;
  } else { const e = new Error("Pick a post, comment or user."); e.status = 400; throw e; }
  await runQuery("INSERT INTO content_audit_views (at, admin_id, admin_name, target_kind, target_id, subject_id, reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
                 [NOW(), viewer.userId, viewer.username || null, kind, tid, subjectId, clip(reason, 200)]);
  const t = NOW();
  // the records: this item's create + edits, or (a user) their latest 20
  const rows = kind === "user"
    ? await getQuery("SELECT * FROM content_audit WHERE user_id = ? ORDER BY at DESC LIMIT 20", [subjectId])
    : await getQuery("SELECT * FROM content_audit WHERE kind = ? AND target_id = ? ORDER BY at", [kind, tid]);
  const records = rows.map((r) => ({
    kind: r.kind, target: r.target_id, post: r.post_id, event: r.event, at: r.at,
    ip: r.ip, ua: r.ua, rawPurged: !!r.raw_purged_at || (r.ip == null && t - r.at > RAW_DAYS * DAY), via: r.via, lang: r.lang, country: r.country,
    acctAgeDays: ageDays(r.acct_age_s), linked: (() => { try { return JSON.parse(r.linked || "{}"); } catch (e) { return {}; } })(),
    ipKey: r.ip_hash ? r.ip_hash.slice(0, 8) : null, deviceKey: r.session_hash ? r.session_hash.slice(0, 8) : null, bot: !!r.bot,
  }));
  // other accounts on the same network / browser in the last SAME_IP_DAYS (counts + usernames)
  const hashes = [...new Set(rows.map((r) => r.ip_hash).filter(Boolean))].slice(0, 50);
  const devs = [...new Set(rows.map((r) => r.session_hash).filter(Boolean))].slice(0, 50);
  const others = async (col, list) => {
    if (!list.length) return [];
    return getQuery(`SELECT a.user_id, u.username, COUNT(*) AS n, MAX(a.at) AS last FROM content_audit a LEFT JOIN users u ON u.userId = a.user_id
                     WHERE a.${col} IN (${list.map(() => "?").join(",")}) AND a.at > ? AND a.user_id != ?
                     GROUP BY a.user_id ORDER BY n DESC LIMIT 50`, [...list, t - SAME_IP_DAYS * DAY, subjectId]);
  };
  const shape = (xs) => xs.map((x) => ({ userId: x.user_id, username: x.username || "[gone]", count: x.n, last: x.last }));
  return {
    subject: await subjectOf(subjectId), target: { kind, id: tid, post: postId },
    records, sameIp: shape(await others("ip_hash", hashes)), sameDevice: shape(await others("session_hash", devs)),
    history: await historyOf(subjectId), windowDays: SAME_IP_DAYS, rawDays: RAW_DAYS,
  };
}

async function subjectOf(userId) {
  const C = new Set((await getQuery("PRAGMA table_info(users)")).map((c) => c.name));
  const col = (c) => (C.has(c) ? c : `NULL AS ${c}`);
  const u = (await getQuery(`SELECT userId, username, ${col("displayname")}, class, ${col("level")}, ${col("created_at")}, ${col("camfrogUsername")},
                             ${col("discordId")}, ${col("twitchId")}, ${col("archived_at")}, ${col("casino_banned")} FROM users WHERE userId = ?`, [userId]))[0];
  if (!u) return { userId, username: "[gone]" };
  const born = createdMs(u);
  return { userId: u.userId, username: u.username, display: u.displayname || u.username, class: u.class, level: u.level || 0,
           created: born || null, ageDays: born ? Math.floor((NOW() - born) / DAY) : null, linked: linkedOf(u),
           camfrog: u.camfrogUsername || null, archived: !!u.archived_at, restricted: !!u.casino_banned };
}

/** The user's recent posts / comments and report record (admin panel). */
async function historyOf(userId) {
  const q = async (sql, a) => { try { return await getQuery(sql, a); } catch (e) { return []; } };
  const posts = await q(`SELECT id, title, body, created, deleted_at, deleted_by, hidden_at FROM feed_posts WHERE author_id = ? ORDER BY created DESC LIMIT 10`, [userId]);
  const comments = await q(`SELECT id, post_id, body, created, deleted_at, deleted_by FROM feed_comments WHERE author_id = ? ORDER BY created DESC LIMIT 10`, [userId]);
  const n = async (sql, a) => ((await q(sql, a))[0] || {}).n || 0;
  const against = await q(`SELECT r.reason, COUNT(*) AS n FROM feed_reports r LEFT JOIN feed_posts p ON p.id = r.post_id LEFT JOIN feed_comments c ON c.id = r.comment_id
                           WHERE (r.comment_id IS NULL AND p.author_id = ?1) OR (r.comment_id IS NOT NULL AND c.author_id = ?1) GROUP BY r.reason`, [userId]);
  const userAgainst = await q("SELECT reason, COUNT(*) AS n FROM user_reports WHERE target_id = ? GROUP BY reason", [userId]);
  return {
    posts: posts.map((p) => ({ id: p.id, text: String(p.title || p.body || "").slice(0, 100), created: p.created, deleted: !!p.deleted_at,
                              byAdmin: !!(p.deleted_by && String(p.deleted_by).startsWith("admin:")), hidden: !!p.hidden_at })),
    comments: comments.map((c) => ({ id: c.id, post: c.post_id, text: String(c.body || "").slice(0, 100), created: c.created, deleted: !!c.deleted_at,
                                     byMod: !!(c.deleted_by && c.deleted_by !== "author") })),
    totals: {
      posts: await n("SELECT COUNT(*) AS n FROM feed_posts WHERE author_id = ?", [userId]),
      postsRemoved: await n("SELECT COUNT(*) AS n FROM feed_posts WHERE author_id = ? AND deleted_by LIKE 'admin:%'", [userId]),
      comments: await n("SELECT COUNT(*) AS n FROM feed_comments WHERE author_id = ?", [userId]),
      commentsRemoved: await n("SELECT COUNT(*) AS n FROM feed_comments WHERE author_id = ? AND deleted_at IS NOT NULL AND deleted_by != 'author'", [userId]),
      reportsFiled: (await n("SELECT COUNT(*) AS n FROM feed_reports WHERE reporter_id = ?", [userId])) + (await n("SELECT COUNT(*) AS n FROM user_reports WHERE reporter_id = ?", [userId])),
      reportsFalse: (await n("SELECT COUNT(*) AS n FROM feed_reports WHERE reporter_id = ? AND action = 'false'", [userId])) + (await n("SELECT COUNT(*) AS n FROM user_reports WHERE reporter_id = ? AND action = 'false'", [userId])),
    },
    reportsAgainst: against.map((r) => ({ reason: r.reason, n: r.n })).concat(userAgainst.map((r) => ({ reason: "user:" + r.reason, n: r.n }))),
    bans: await q("SELECT room_id, reason, by, at, until FROM feed_bans WHERE user_id = ?", [userId]),
  };
}

/** The view log for /feed/admin (who looked at whose details, when). */
async function viewLog(limit = 50) {
  await init();
  return getQuery(`SELECT v.*, u.username AS subject FROM content_audit_views v LEFT JOIN users u ON u.userId = v.subject_id ORDER BY v.id DESC LIMIT ?`, [limit]);
}

let timer = null;
/** Daily retention job (feedweb.register starts it; unref'd). */
function start() {
  if (timer) return;
  const run = () => sweep().then((r) => { if (r.rawNulled || r.deleted || r.viewsDeleted) console.log(`[audit] retention: ${JSON.stringify(r)}`); })
    .catch((e) => console.error("[audit] retention:", e.message));
  setTimeout(run, 2 * 60e3).unref();
  timer = setInterval(run, DAY);
  timer.unref();
}

module.exports = { init, record, fromRequest, sweep, details, ownerInfo, viewLog, start, isAdmin, netOf, RAW_DAYS, HASH_DAYS, SAME_IP_DAYS, _setClock };
