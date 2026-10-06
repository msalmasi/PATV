// messages.js — direct messages between users (1.99cp): /messages, a Discord/IRC-style chat.
//
// Schema (shaped for v2: a conversation has members; a 1:1 DM is a conversation of kind 'dm' with a
// unique dm_key, so group chats can be added later as kind 'group' without a migration):
//   conversations         id (random hex), kind 'dm', dm_key ("<userId>|<userId>", sorted; NULL for groups),
//                         title (groups), created_by, created_at, last_msg_id, last_msg_at
//   conversation_members  conversation_id, user_id, role, joined_at, last_read_id (unread = later messages
//                         from others), cleared_id ("clear history": nothing up to it is shown to this member),
//                         hidden (deleted from MY list; a new message brings it back), left_at
//   messages              id (autoincrement = order), conversation_id, sender_id, body (NULL once deleted),
//                         kind 'text', created_at, edited_at, deleted_at, deleted_by ('author' | 'admin:<name>')
//   dm_blocks             blocker_id, blocked_id: no messages either way
//   dm_prefs              user_id, who ('everyone' | 'following' | 'nobody'), alert_preview (1 = quote the
//                         message in the Camfrog alert). The Camfrog alert on/off is the inbox's per-category
//                         PM preference (inbox_prefs, kind 'dm', default ON) so both settings pages agree.
//   dm_alerts             user_id, conversation_id, pending (messages since the last alert), first_at,
//                         last_msg_id, last_alert_at: Pepe's Camfrog alert batching (claimAlerts)
//   dm_reports            a reported message (+ a snapshot of its text, so deleting it doesn't destroy the
//                         evidence), reporter, reason, outcome. ADMIN-ONLY queue (/feed/admin#dms), never pad owners.
//
// Rules (who may send what to whom: refusal()):
//   * blocks stop messages both ways; archived accounts, Pepe's account and people banned from the whole
//     feed can't be messaged / can't send
//   * consent: once the other person has written in the conversation, you may always reply (blocks aside)
//   * the recipient's "Who can message me": everyone (default) | people I follow | nobody
//   * new accounts (level < 2 and no linked Camfrog / Discord / Twitch) may only message people who follow
//     them or who wrote to them first (anti-spam)
//   * rate limits (per minute / hour, new conversations per day - lower for new accounts)
// Privacy: DMs are NOT end-to-end encrypted (the page and /privacy say so). Admins can read a message only
// when it's been reported, through the report (GET /api/messages/admin/report/:id), and every read is logged
// in content_audit_views. Every sent message gets an admin-only content_audit record, like posts.
//
// Live updates: the site's SSE endpoint /events with type=dm (the stream is always the signed-in user's own;
// the identifier in the URL is ignored), plus a fallback poll in the page.
//
// Camfrog alerts: a message to someone with a linked Camfrog login queues a dm_alerts row. Pepe claims due
// ones (POST /api/messages/alerts/claim, bot token) and PMs them through his presence-aware notice system
// (kind "dm"). One alert per conversation per ALERT_GAP_MS ("3 new messages from X"), only after
// ALERT_GRACE_MS (reading it on the site in the meantime cancels it), never with the text when the recipient
// chose "alert without preview" (or the sender is !incognito - Pepe checks that and uses text_plain).
"use strict";
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { runQuery, getQuery } = require("./dbUtils");

let NOW = () => Date.now();
function _setClock(fn) { NOW = fn; }

class Refuse extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.refuse = true; if (code) this.code = code; } }

const LIMITS = {
  max_len: 2000,                 // characters per message
  page: 40,                      // messages per history page
  gap_ms: 350,                   // minimum gap between two sends (double Enter)
  per_min: 20, per_hour: 300,    // messages per sender
  new_per_min: 8, new_per_hour: 60,
  convos_per_day: 30,            // NEW conversations (first message to someone) per day
  new_convos_per_day: 5,         // ... for new accounts
  reports_per_hour: 20, new_reports_per_hour: 5, reports_per_day: 60,
  level_ok: 2,                   // "new account" = below this level AND nothing linked
  list_max: 200,                 // conversations in the list
};
const ALERT_GAP_MS = 10 * 60e3;   // at most one Camfrog alert per conversation per 10 minutes
const ALERT_GRACE_MS = 60e3;      // wait this long first: reading it on the site cancels the alert
const ALERT_MAX_AGE_MS = 24 * 3600e3;   // pending alerts older than this are dropped (they're in /messages)
const PREVIEW_CHARS = 60;
const WHO = Object.freeze(["everyone", "following", "nobody"]);
const PEPE_ID = "pepe-bot";
const isStaff = (u) => !!u && (u.class === "Admin" || u.class === "Staff");
const isAdmin = (u) => !!u && u.class === "Admin";

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'dm', dm_key TEXT, title TEXT, created_by TEXT, created_at INTEGER NOT NULL,
        last_msg_id INTEGER NOT NULL DEFAULT 0, last_msg_at INTEGER)`);
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS conversations_dm_key ON conversations (dm_key) WHERE dm_key IS NOT NULL");
      await runQuery("CREATE INDEX IF NOT EXISTS conversations_creator ON conversations (created_by, created_at)");
      await runQuery(`CREATE TABLE IF NOT EXISTS conversation_members (
        conversation_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member', joined_at INTEGER NOT NULL,
        last_read_id INTEGER NOT NULL DEFAULT 0, cleared_id INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, left_at INTEGER,
        PRIMARY KEY (conversation_id, user_id))`);
      await runQuery("CREATE INDEX IF NOT EXISTS conversation_members_user ON conversation_members (user_id)");
      await runQuery(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL, body TEXT, kind TEXT NOT NULL DEFAULT 'text',
        created_at INTEGER NOT NULL, edited_at INTEGER, deleted_at INTEGER, deleted_by TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS messages_conv ON messages (conversation_id, id)");
      await runQuery("CREATE INDEX IF NOT EXISTS messages_sender ON messages (sender_id, created_at)");
      await runQuery(`CREATE TABLE IF NOT EXISTS dm_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY (blocker_id, blocked_id))`);
      await runQuery("CREATE INDEX IF NOT EXISTS dm_blocks_blocked ON dm_blocks (blocked_id)");
      await runQuery(`CREATE TABLE IF NOT EXISTS dm_prefs (user_id TEXT PRIMARY KEY, who TEXT NOT NULL DEFAULT 'everyone',
        alert_preview INTEGER NOT NULL DEFAULT 1, updated INTEGER)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS dm_alerts (user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, pending INTEGER NOT NULL DEFAULT 0,
        first_at INTEGER, last_msg_id INTEGER, last_alert_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, conversation_id))`);
      await runQuery("CREATE INDEX IF NOT EXISTS dm_alerts_due ON dm_alerts (pending, first_at)");
      await runQuery(`CREATE TABLE IF NOT EXISTS dm_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL,
        reporter_id TEXT NOT NULL, reason TEXT, note TEXT, body TEXT, msg_at INTEGER, created INTEGER NOT NULL,
        resolved_at INTEGER, resolved_by TEXT, action TEXT, notified_at INTEGER)`);
      await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS dm_reports_once ON dm_reports (message_id, reporter_id)");
      await runQuery("CREATE INDEX IF NOT EXISTS dm_reports_open ON dm_reports (resolved_at, created)");
      await runQuery("CREATE INDEX IF NOT EXISTS dm_reports_reporter ON dm_reports (reporter_id, created)");
    })().catch((e) => { console.error("[dm] init:", e.message); ready = null; throw e; });
  }
  return ready;
}

// ── small helpers ──
const gaps = new Map();
function burst(key, ms) {
  const t = NOW(), last = gaps.get(key) || 0;
  if (t - last < ms) return Math.max(1, Math.ceil((ms - (t - last)) / 1000));
  gaps.set(key, t);
  if (gaps.size > 5000) for (const [k, v] of gaps) if (t - v > 600e3) gaps.delete(k);
  return 0;
}
/** A message body: control characters out (newlines and tabs kept), at most 3 blank lines in a row, trimmed. */
function cleanBody(s) {
  return String(s == null ? "" : s).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g, "")
    .replace(/\n{4,}/g, "\n\n\n").trim();
}
const cleanLine = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, n);
const newId = () => crypto.randomBytes(8).toString("hex");
const ID_RE = /^[a-f0-9]{16}$/;

let USER_COLS = null;
async function userCols() {
  if (!USER_COLS) USER_COLS = new Set((await getQuery("PRAGMA table_info(users)")).map((c) => c.name));
  return USER_COLS;
}
async function account(userId) {
  const C = await userCols();
  const pick = (c) => (C.has(c) ? c : `NULL AS ${c}`);
  return (await getQuery(`SELECT userId, username, class, ${pick("displayname")}, ${pick("camfrogUsername")}, ${pick("level")}, ${pick("created_at")},
                          ${pick("archived_at")}, ${pick("discordId")}, ${pick("twitchId")} FROM users WHERE userId = ?`, [String(userId || "")]))[0] || null;
}
async function byUsername(name) {
  const n = String(name || "").trim().replace(/^@/, "").slice(0, 64);
  if (!n) return null;
  const rows = await getQuery("SELECT userId FROM users WHERE LOWER(username) = LOWER(?) LIMIT 2", [n]);
  return rows.length === 1 ? account(rows[0].userId) : null;
}
const display = (u) => (u ? u.displayname || u.username : "[gone]");
/** level < 2 and nothing linked (Camfrog, Discord, Twitch). Staff never count as new. */
function isNewAccount(u) {
  if (!u || isStaff(u)) return false;
  if (u.camfrogUsername || u.discordId || u.twitchId) return false;
  return (Number(u.level) || 0) < LIMITS.level_ok;
}
async function follows(followerId, targetUserId) {
  try {
    return !!(await getQuery("SELECT 1 FROM follows WHERE follower = ? AND target_kind = 'user' AND target_id = ?", [followerId, targetUserId]))[0];
  } catch (e) { return false; }            // no follows table yet
}
async function feedBanned(userId) {
  try {
    return !!(await getQuery("SELECT 1 FROM feed_bans WHERE user_id = ? AND room_id = '' AND (until IS NULL OR until > ?)", [userId, NOW()]))[0];
  } catch (e) { return false; }
}
async function blocked(a, b) {
  return getQuery("SELECT blocker_id FROM dm_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)", [a, b, b, a]);
}

// ── prefs ──
async function prefs(userId) {
  await init();
  const r = (await getQuery("SELECT who, alert_preview FROM dm_prefs WHERE user_id = ?", [userId]))[0];
  let pm = true;
  try { pm = await require("./inbox").pmAllowed(userId, "dm"); } catch (e) { pm = true; }
  return { who: r && WHO.includes(r.who) ? r.who : "everyone", preview: r ? !!r.alert_preview : true, alerts: pm };
}
async function setPrefs(userId, { who, preview, alerts } = {}) {
  await init();
  const cur = await prefs(userId);
  const w = WHO.includes(who) ? who : cur.who;
  const p = preview === undefined ? cur.preview : !!preview;
  await runQuery(`INSERT INTO dm_prefs (user_id, who, alert_preview, updated) VALUES (?, ?, ?, ?)
                  ON CONFLICT(user_id) DO UPDATE SET who = excluded.who, alert_preview = excluded.alert_preview, updated = excluded.updated`,
                 [userId, w, p ? 1 : 0, NOW()]);
  if (alerts !== undefined) {
    const inbox = require("./inbox");
    await inbox.ready;
    await runQuery(`INSERT INTO inbox_prefs (user_id, kind, pm_off) VALUES (?, 'dm', ?)
                    ON CONFLICT(user_id, kind) DO UPDATE SET pm_off = excluded.pm_off`, [userId, alerts ? 0 : 1]);
    if (!alerts) await runQuery("UPDATE dm_alerts SET pending = 0, first_at = NULL WHERE user_id = ?", [userId]);
  }
  return prefs(userId);
}

// ── conversations ──
async function membership(conversationId, userId) {
  return (await getQuery("SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL", [String(conversationId || ""), userId]))[0] || null;
}
async function conversationRow(id) {
  return (await getQuery("SELECT * FROM conversations WHERE id = ?", [String(id || "")]))[0] || null;
}
async function otherMembers(conversationId, userId) {
  return getQuery("SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?", [conversationId, userId]);
}
async function dmBetween(a, b) {
  const key = [a, b].sort().join("|");
  return (await getQuery("SELECT * FROM conversations WHERE dm_key = ?", [key]))[0] || null;
}
/** Has `userId` written in this conversation (any time, deleted or not)? = consent to replies. */
async function hasWritten(conversationId, userId) {
  if (!conversationId) return false;
  return !!(await getQuery("SELECT 1 FROM messages WHERE conversation_id = ? AND sender_id = ? LIMIT 1", [conversationId, userId]))[0];
}

/**
 * Why `sender` can't message `recipient` right now (a Refuse), or null. conv: their conversation, if any.
 * Order: account states, blocks, then consent (they wrote to you) before the recipient's setting and the
 * new-account rule.
 */
async function refusal(sender, recipient, conv = null) {
  if (!sender) return new Refuse(401, "Sign in first.");
  if (!recipient || recipient.archived_at) return new Refuse(404, "No such person.", "gone");
  if (recipient.userId === sender.userId) return new Refuse(400, "You can't message yourself.", "self");
  if (recipient.userId === PEPE_ID) return new Refuse(400, "Pepe doesn't read DMs here - talk to him in a Camfrog room or mention him on the feed.", "bot");
  if (sender.archived_at) return new Refuse(403, "This account is archived.", "archived");
  if (await feedBanned(sender.userId)) return new Refuse(403, "You can't send messages right now.", "banned");
  const b = await blocked(sender.userId, recipient.userId);
  if (b.some((x) => x.blocker_id === sender.userId)) return new Refuse(403, `You've blocked ${display(recipient)}. Unblock them to send a message.`, "you_blocked");
  if (b.length) return new Refuse(403, `You can't message ${display(recipient)}.`, "blocked");
  if (conv && await hasWritten(conv.id, recipient.userId)) return null;            // they wrote to you: replies are always fine
  const P = await prefs(recipient.userId);
  if (P.who === "nobody") return new Refuse(403, `${display(recipient)} isn't taking new messages.`, "closed");
  if (P.who === "following" && !(await follows(recipient.userId, sender.userId))) {
    return new Refuse(403, `${display(recipient)} only takes messages from people they follow.`, "following");
  }
  if (isNewAccount(sender) && !(await follows(recipient.userId, sender.userId))) {
    return new Refuse(403, `New accounts can only message people who follow them or who messaged them first. Link your Camfrog name (type !verify in a room with Pepe) or reach level ${LIMITS.level_ok} to message anyone.`, "new");
  }
  return null;
}

async function rateRefusal(sender, isNewConversation) {
  const wait = burst("send|" + sender.userId, LIMITS.gap_ms);
  if (wait) return new Refuse(429, "Slow down a little.", "rate");
  if (isStaff(sender)) return null;
  const t = NOW();
  const n = async (ms) => (await getQuery("SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND created_at > ?", [sender.userId, t - ms]))[0].n;
  const fresh = isNewAccount(sender);
  if ((await n(60e3)) >= (fresh ? LIMITS.new_per_min : LIMITS.per_min)) return new Refuse(429, "You're sending messages very fast - wait a minute.", "rate");
  if ((await n(3600e3)) >= (fresh ? LIMITS.new_per_hour : LIMITS.per_hour)) return new Refuse(429, "You've sent a lot of messages this hour - try again later.", "rate");
  if (isNewConversation) {
    const c = (await getQuery("SELECT COUNT(*) AS n FROM conversations WHERE created_by = ? AND created_at > ?", [sender.userId, t - 86400e3]))[0].n;
    const cap = fresh ? LIMITS.new_convos_per_day : LIMITS.convos_per_day;
    if (c >= cap) return new Refuse(429, `You can start ${cap} new conversations a day${fresh ? " while your account is new" : ""} - try again tomorrow.`, "rate");
  }
  return null;
}

// ── rendering a message (server-side, escaped; the page puts `html` in with innerHTML and nothing else) ──
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"'`]/g, (c) => ESC[c]);
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]{2,2000}/gi;
const padText = (t) => { try { return require("./pads").padRefs(esc(t)); } catch (e) { return esc(t); } };
/** Escape, link bare http(s) URLs (nofollow ugc, new tab) and known p/<slug> pads, keep line breaks. */
function render(text) {
  const s = String(text == null ? "" : text);
  let out = "", last = 0, m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(s))) {
    let url = m[0];
    const trail = url.match(/[).,;:!?\]}]+$/);
    if (trail) url = url.slice(0, -trail[0].length);
    out += padText(s.slice(last, m.index));
    let ok = false;
    try { const u = new URL(url); ok = u.protocol === "http:" || u.protocol === "https:"; } catch (e) { ok = false; }
    out += ok ? `<a href="${esc(url)}" rel="nofollow noopener noreferrer ugc" target="_blank">${esc(url.length > 80 ? url.slice(0, 77) + "…" : url)}</a>` : esc(url);
    last = m.index + url.length;
    URL_RE.lastIndex = last;
  }
  return (out + padText(s.slice(last))).replace(/\n/g, "<br>");
}
const snippet = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t; };

const people = new Map();      // userId -> {username, display} (small cache for shaping; refreshed every 5 min)
async function who(userId) {
  const c = people.get(userId);
  if (c && NOW() - c.at < 300e3) return c.v;
  const u = await account(userId);
  const v = u ? { username: u.username, display: display(u) } : { username: null, display: "[gone]" };
  people.set(userId, { v, at: NOW() });
  if (people.size > 5000) people.clear();
  return v;
}
async function shape(m) {
  const from = await who(m.sender_id);
  const deleted = !!m.deleted_at;
  return { id: m.id, c: m.conversation_id, from: from.username, fromDisplay: from.display, at: m.created_at,
           deleted, byAdmin: deleted && String(m.deleted_by || "").startsWith("admin:"), html: deleted ? "" : render(m.body), text: deleted ? "" : m.body };
}

// ── live updates (SSE) ──
const streams = new Map();      // userId -> Set(res)
const STREAM_MAX = 8;           // per user (tabs)
function emit(userId, ev) {
  const set = streams.get(userId);
  if (!set) return 0;
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of set) { try { res.write(line); } catch (e) { /* closed */ } }
  return set.size;
}
let pinger = null;
function startPinger() {
  if (pinger) return;
  pinger = setInterval(() => {
    for (const set of streams.values()) for (const res of set) { try { res.write(": ping\n\n"); } catch (e) { /* closed */ } }
  }, 25e3);
  pinger.unref();
}
function cookieUser(req) {
  const token = req.cookies && req.cookies.jwt;
  if (!token || !process.env.SECRET_KEY) return null;
  try { const d = jwt.verify(token, process.env.SECRET_KEY); return d && d.userId ? d.userId : null; } catch (e) { return null; }
}
/** GET /events?type=dm - the signed-in user's own message stream (index.js hands these over). */
function sse(req, res) {
  const userId = (req.user && req.user.userId) || cookieUser(req);
  if (!userId) return res.status(401).end();
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-store");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write("retry: 5000\n\n");
  let set = streams.get(userId);
  if (!set) streams.set(userId, (set = new Set()));
  if (set.size >= STREAM_MAX) { const oldest = set.values().next().value; set.delete(oldest); try { oldest.end(); } catch (e) { /* gone */ } }
  set.add(res);
  startPinger();
  res.write(`data: ${JSON.stringify({ t: "hello" })}\n\n`);
  req.on("close", () => {
    set.delete(res);
    if (!set.size) streams.delete(userId);
  });
}

// ── sending ──
/**
 * Send a message. input: {to: username} (start or continue a DM) or {conversation: id}, body.
 * ctx: contentaudit.fromRequest(req). -> {message, conversation, created}
 */
async function send(user, { to, conversation, body } = {}, ctx = null) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const me = await account(user.userId);
  if (!me) throw new Refuse(401, "Sign in first.");
  const text = cleanBody(body);
  if (!text) throw new Refuse(400, "Type a message first.", "empty");
  if (text.length > LIMITS.max_len) throw new Refuse(400, `Messages can be up to ${LIMITS.max_len} characters.`, "long");
  let conv = null, other = null;
  if (conversation) {
    if (!(await membership(conversation, me.userId))) throw new Refuse(404, "No such conversation.");
    conv = await conversationRow(conversation);
    const o = (await otherMembers(conv.id, me.userId))[0];
    other = o ? await account(o.user_id) : null;
  } else {
    other = await byUsername(to);
    if (!other) throw new Refuse(404, "No such person.", "gone");
    conv = await dmBetween(me.userId, other.userId);
  }
  const no = await refusal(me, other, conv);
  if (no) throw no;
  const rate = await rateRefusal(me, !conv);
  if (rate) throw rate;
  const t = NOW();
  let created = false;
  if (!conv) {
    const id = newId();
    const key = [me.userId, other.userId].sort().join("|");
    const r = await runQuery("INSERT OR IGNORE INTO conversations (id, kind, dm_key, created_by, created_at) VALUES (?, 'dm', ?, ?, ?)", [id, key, me.userId, t]);
    conv = await dmBetween(me.userId, other.userId);
    created = !!(r && r.changes);
    for (const uid of [me.userId, other.userId]) {
      await runQuery("INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)", [conv.id, uid, t]);
    }
  }
  // a member who "deleted" the conversation gets it back (as of now); a member who left rejoins
  await runQuery("UPDATE conversation_members SET left_at = NULL WHERE conversation_id = ? AND user_id = ? AND left_at IS NOT NULL", [conv.id, other.userId]);
  const ins = await runQuery("INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)", [conv.id, me.userId, text, t]);
  const mid = ins.id || ins.lastID || (await getQuery("SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?", [conv.id]))[0].id;
  await runQuery("UPDATE conversations SET last_msg_id = ?, last_msg_at = ? WHERE id = ?", [mid, t, conv.id]);
  await runQuery("UPDATE conversation_members SET hidden = 0 WHERE conversation_id = ?", [conv.id]);
  await runQuery("UPDATE conversation_members SET last_read_id = ? WHERE conversation_id = ? AND user_id = ?", [mid, conv.id, me.userId]);
  // abuse metadata, admin-only (never fails the send)
  if (ctx) { try { await require("./contentaudit").record(ctx, { kind: "message", id: mid, postId: conv.id, user: me }); } catch (e) { /* logged there */ } }
  // Pepe's Camfrog alert (batched per conversation; claimAlerts decides if / when)
  if (other.camfrogUsername) {
    await runQuery(`INSERT INTO dm_alerts (user_id, conversation_id, pending, first_at, last_msg_id) VALUES (?, ?, 1, ?, ?)
                    ON CONFLICT(user_id, conversation_id) DO UPDATE SET pending = pending + 1, first_at = COALESCE(first_at, excluded.first_at),
                    last_msg_id = excluded.last_msg_id`, [other.userId, conv.id, t, mid]);
  }
  const msg = await shape({ id: mid, conversation_id: conv.id, sender_id: me.userId, body: text, created_at: t });
  const head = { id: conv.id, with: { username: other.username, display: display(other) } };
  emit(other.userId, { t: "msg", c: conv.id, m: msg, conv: { id: conv.id, with: { username: me.username, display: display(me) } } });
  emit(me.userId, { t: "msg", c: conv.id, m: msg, conv: head });
  return { message: msg, conversation: head, created };
}

// ── reading ──
async function unreadTotal(userId) {
  if (!userId) return 0;
  await init();
  const r = await getQuery(`SELECT COUNT(*) AS n FROM conversation_members cm JOIN messages m ON m.conversation_id = cm.conversation_id
                            WHERE cm.user_id = ? AND cm.left_at IS NULL AND m.id > MAX(cm.last_read_id, cm.cleared_id)
                            AND m.sender_id != ? AND m.deleted_at IS NULL`, [userId, userId]);
  return r[0] ? r[0].n : 0;
}

/** The conversation list: newest activity first, with the other person, last message and unread count. */
async function list(userId) {
  await init();
  const rows = await getQuery(`SELECT c.id, c.kind, c.last_msg_id, c.last_msg_at, c.created_at, cm.last_read_id, cm.cleared_id
                               FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
                               WHERE cm.user_id = ? AND cm.left_at IS NULL AND cm.hidden = 0 AND c.last_msg_id > cm.cleared_id
                               ORDER BY c.last_msg_at DESC LIMIT ?`, [userId, LIMITS.list_max]);
  const blocks = new Set((await getQuery("SELECT blocked_id FROM dm_blocks WHERE blocker_id = ?", [userId])).map((r) => r.blocked_id));
  const out = [];
  for (const r of rows) {
    const o = (await otherMembers(r.id, userId))[0];
    const ou = o ? await who(o.user_id) : { username: null, display: "[gone]" };
    const last = (await getQuery("SELECT * FROM messages WHERE id = ?", [r.last_msg_id]))[0];
    const unread = (await getQuery(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND id > ? AND sender_id != ? AND deleted_at IS NULL`,
                                   [r.id, Math.max(r.last_read_id, r.cleared_id), userId]))[0].n;
    out.push({
      id: r.id, kind: r.kind, with: ou, blocked: !!(o && blocks.has(o.user_id)), at: r.last_msg_at || r.created_at, lastId: r.last_msg_id, unread,
      last: last ? { mine: last.sender_id === userId, text: last.deleted_at ? "" : snippet(last.body, 90), deleted: !!last.deleted_at } : null,
    });
  }
  return out;
}

/** One conversation's messages for a member. before / after: message ids (exclusive). -> {messages, more} */
async function history(user, conversationId, { before = null, after = null, limit = LIMITS.page } = {}) {
  await init();
  const m = await membership(conversationId, user.userId);
  if (!m) throw new Refuse(404, "No such conversation.");
  const n = Math.min(Math.max(1, parseInt(limit, 10) || LIMITS.page), 100);
  const floor = m.cleared_id || 0;
  let rows;
  if (after != null) {
    rows = await getQuery("SELECT * FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id ASC LIMIT ?", [conversationId, Math.max(floor, parseInt(after, 10) || 0), n + 1]);
    const more = rows.length > n;
    return { messages: await Promise.all(rows.slice(0, n).map(shape)), more };
  }
  const b = before != null ? parseInt(before, 10) || 0 : Number.MAX_SAFE_INTEGER;
  rows = await getQuery("SELECT * FROM messages WHERE conversation_id = ? AND id > ? AND id < ? ORDER BY id DESC LIMIT ?", [conversationId, floor, b, n + 1]);
  const more = rows.length > n;
  return { messages: await Promise.all(rows.slice(0, n).reverse().map(shape)), more };
}

/** The header of one conversation for a member: who it's with, block state, whether you can write. */
async function header(user, conversationId) {
  await init();
  const m = await membership(conversationId, user.userId);
  if (!m) throw new Refuse(404, "No such conversation.");
  const conv = await conversationRow(conversationId);
  const o = (await otherMembers(conversationId, user.userId))[0];
  const other = o ? await account(o.user_id) : null;
  const me = await account(user.userId);
  const no = other ? await refusal(me, other, conv) : new Refuse(404, "This account is gone.");
  const b = other ? await blocked(user.userId, other.userId) : [];
  return { id: conv.id, kind: conv.kind, with: other ? { username: other.username, display: display(other) } : { username: null, display: "[gone]" },
           youBlocked: b.some((x) => x.blocker_id === user.userId), canSend: !no, refusal: no ? no.message : null, refusalCode: no ? no.code || null : null };
}

/** Before a first message: may I message this person? -> {user, conversation (existing id or null), canSend, refusal} */
async function check(user, username) {
  await init();
  const me = await account(user.userId);
  const other = await byUsername(username);
  if (!other || other.archived_at) throw new Refuse(404, "No such person.");
  const conv = await dmBetween(me.userId, other.userId);
  const mine = conv ? await membership(conv.id, me.userId) : null;
  const no = await refusal(me, other, conv);
  return { user: { username: other.username, display: display(other) }, conversation: conv && mine ? conv.id : null, canSend: !no,
           refusal: no ? no.message : null, refusalCode: no ? no.code || null : null };
}

/** Mark read up to `upTo` (default: everything). Also cancels a pending Camfrog alert for it. -> unread total */
async function markRead(user, conversationId, upTo = null) {
  await init();
  const m = await membership(conversationId, user.userId);
  if (!m) throw new Refuse(404, "No such conversation.");
  const conv = await conversationRow(conversationId);
  const to = Math.min(conv.last_msg_id, upTo == null ? conv.last_msg_id : Math.max(0, parseInt(upTo, 10) || 0));
  if (to > m.last_read_id) await runQuery("UPDATE conversation_members SET last_read_id = ? WHERE conversation_id = ? AND user_id = ?", [to, conversationId, user.userId]);
  // read on the site = no Camfrog alert for what they've seen
  const a = (await getQuery("SELECT last_msg_id FROM dm_alerts WHERE user_id = ? AND conversation_id = ?", [user.userId, conversationId]))[0];
  if (a && to >= (a.last_msg_id || 0)) await runQuery("UPDATE dm_alerts SET pending = 0, first_at = NULL WHERE user_id = ? AND conversation_id = ?", [user.userId, conversationId]);
  const unread = await unreadTotal(user.userId);
  emit(user.userId, { t: "read", c: conversationId, upTo: to, unread });
  return unread;
}

/** Delete one of your own messages (for everyone: "message deleted"). */
async function deleteMessage(user, messageId) {
  await init();
  const m = (await getQuery("SELECT * FROM messages WHERE id = ?", [parseInt(messageId, 10) || 0]))[0];
  if (!m || !(await membership(m.conversation_id, user.userId))) throw new Refuse(404, "No such message.");
  if (m.sender_id !== user.userId) throw new Refuse(403, "You can only delete your own messages.");
  if (!m.deleted_at) {
    await runQuery("UPDATE messages SET body = NULL, deleted_at = ?, deleted_by = 'author' WHERE id = ?", [NOW(), m.id]);
    for (const r of await getQuery("SELECT user_id FROM conversation_members WHERE conversation_id = ?", [m.conversation_id])) {
      emit(r.user_id, { t: "del", c: m.conversation_id, id: m.id });
    }
  }
  return true;
}

/** Clear history (for you only): nothing up to now is shown to you again. hide: also take it off your list. */
async function clear(user, conversationId, { hide = false } = {}) {
  await init();
  const m = await membership(conversationId, user.userId);
  if (!m) throw new Refuse(404, "No such conversation.");
  const conv = await conversationRow(conversationId);
  await runQuery(`UPDATE conversation_members SET cleared_id = ?, last_read_id = MAX(last_read_id, ?)${hide ? ", hidden = 1" : ""}
                  WHERE conversation_id = ? AND user_id = ?`, [conv.last_msg_id, conv.last_msg_id, conversationId, user.userId]);
  await runQuery("UPDATE dm_alerts SET pending = 0, first_at = NULL WHERE user_id = ? AND conversation_id = ?", [user.userId, conversationId]);
  emit(user.userId, { t: hide ? "gone" : "cleared", c: conversationId, unread: await unreadTotal(user.userId) });
  return true;
}

// ── blocks ──
async function setBlock(user, username, on = true) {
  await init();
  const other = await byUsername(username);
  if (!other) throw new Refuse(404, "No such person.");
  if (other.userId === user.userId) throw new Refuse(400, "You can't block yourself.");
  if (burst("block|" + user.userId, 500)) throw new Refuse(429, "Easy there.");
  if (on) {
    await runQuery("INSERT OR IGNORE INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)", [user.userId, other.userId, NOW()]);
    // no alerts from them that were already queued
    const conv = await dmBetween(user.userId, other.userId);
    if (conv) await runQuery("UPDATE dm_alerts SET pending = 0, first_at = NULL WHERE user_id = ? AND conversation_id = ?", [user.userId, conv.id]);
  } else {
    await runQuery("DELETE FROM dm_blocks WHERE blocker_id = ? AND blocked_id = ?", [user.userId, other.userId]);
  }
  return { blocked: !!on, user: { username: other.username, display: display(other) } };
}
async function blockList(userId) {
  await init();
  const rows = await getQuery("SELECT blocked_id, created_at FROM dm_blocks WHERE blocker_id = ? ORDER BY created_at DESC LIMIT 500", [userId]);
  const out = [];
  for (const r of rows) out.push({ ...(await who(r.blocked_id)), at: r.created_at });
  return out.filter((x) => x.username);
}

// ── reports (admin-only queue) ──
async function admins() { return getQuery("SELECT userId FROM users WHERE class = 'Admin'"); }
async function notify(userId, n) { try { await require("./inbox").addSafe(userId, n); } catch (e) { /* never blocks */ } }
function reasons() {
  const store = require("./feedstore");
  return { REASONS: store.REASONS, menu: store.reportMenu(true), URGENT: store.URGENT };
}

async function report(user, messageId, { reason, note } = {}) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in to report.");
  const m = (await getQuery("SELECT * FROM messages WHERE id = ?", [parseInt(messageId, 10) || 0]))[0];
  if (!m || !(await membership(m.conversation_id, user.userId))) throw new Refuse(404, "No such message.");
  if (m.sender_id === user.userId) throw new Refuse(400, "You can't report your own message.");
  if (m.deleted_at) throw new Refuse(400, "That message was deleted.");
  const { REASONS, URGENT } = reasons();
  const why = Object.prototype.hasOwnProperty.call(REASONS, reason) ? reason : "other";
  const wait = burst("dmreport|" + user.userId, 3000);
  if (wait) throw new Refuse(429, `Slow down - try again in ${wait}s.`);
  const me = await account(user.userId);
  if (!isStaff(me)) {
    const t = NOW();
    const n = async (ms) => (await getQuery("SELECT COUNT(*) AS n FROM dm_reports WHERE reporter_id = ? AND created > ?", [user.userId, t - ms]))[0].n;
    const perHour = isNewAccount(me) ? LIMITS.new_reports_per_hour : LIMITS.reports_per_hour;
    if (!URGENT.includes(why) && (await n(3600e3)) >= perHour) throw new Refuse(429, "You've sent a lot of reports this hour - try again later.");
    if ((await n(86400e3)) >= LIMITS.reports_per_day) throw new Refuse(429, "You've hit today's report limit.");
  }
  const r = await runQuery(`INSERT OR IGNORE INTO dm_reports (message_id, conversation_id, sender_id, reporter_id, reason, note, body, msg_at, created)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                           [m.id, m.conversation_id, m.sender_id, user.userId, why, cleanLine(note, 300) || null, m.body, m.created_at, NOW()]);
  if (!r.changes) return { ok: true, already: true };
  const rid = r.id || r.lastID || "?";
  const urgent = URGENT.includes(why);
  for (const a of await admins()) {
    await notify(a.userId, urgent
      ? { kind: "admin", title: "URGENT: a direct message was reported as sexual content involving a minor", body: "Review it on the feed admin page (Reported messages) now. Follow the CSAM procedure.",
          link: "/feed/admin#dms", ref: "dm-urgent:" + rid }
      : { kind: "admin", title: "A direct message was reported", body: `${REASONS[why] || why}. Review it on the feed admin page (Reported messages).`, link: "/feed/admin#dms", ref: "dm-rep:" + rid });
  }
  if (urgent) console.error(`[dm] URGENT report #${rid} (${why})`);
  return { ok: true, urgent };
}

/** The admin queue: open reports, one row per message, NO message text (that's behind reportDetail). */
async function reportQueue() {
  await init();
  const { REASONS, URGENT } = reasons();
  const rows = await getQuery(`SELECT r.*, u.username AS reporter, s.username AS sender FROM dm_reports r LEFT JOIN users u ON u.userId = r.reporter_id
                               LEFT JOIN users s ON s.userId = r.sender_id WHERE r.resolved_at IS NULL ORDER BY r.id DESC LIMIT 300`);
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.message_id)) by.set(r.message_id, { messageId: r.message_id, sender: r.sender || "[gone]", senderId: r.sender_id, msgAt: r.msg_at, reports: [], urgent: false });
    const g = by.get(r.message_id);
    g.reports.push({ id: r.id, reporter: r.reporter || "?", reason: r.reason, label: REASONS[r.reason] || r.reason, note: r.note, created: r.created, urgent: URGENT.includes(r.reason) });
    g.urgent = g.urgent || URGENT.includes(r.reason);
  }
  return [...by.values()].sort((a, b) => (b.urgent - a.urgent) || (b.reports[0].created - a.reports[0].created));
}

/**
 * An admin reads ONE reported message (and its safety record). Only a message with a report can be read
 * this way; the view is logged in content_audit_views before anything is returned (contentaudit.details).
 */
async function reportDetail(viewer, messageId, { reason = null } = {}) {
  if (!isAdmin(viewer)) throw new Refuse(403, "Admins only.");
  await init();
  const id = parseInt(messageId, 10) || 0;
  const reps = await getQuery("SELECT * FROM dm_reports WHERE message_id = ? ORDER BY id", [id]);
  if (!reps.length) throw new Refuse(404, "Only reported messages can be opened.");
  const details = await require("./contentaudit").details(viewer, { message: id }, { reason: reason || "dm report" });
  const m = (await getQuery("SELECT * FROM messages WHERE id = ?", [id]))[0] || null;
  const from = await who(reps[0].sender_id);
  return {
    message: { id, from: from.username, fromDisplay: from.display, at: reps[0].msg_at, conversation: reps[0].conversation_id,
               text: m && !m.deleted_at ? m.body : reps[0].body, deleted: !m || !!m.deleted_at, deletedBy: m ? m.deleted_by : null },
    details,
  };
}

/** Admin outcome: dismiss | false (bad faith) | remove (delete the message) | ban (remove + feed-wide ban = no DMs either). */
async function reportAction(viewer, { message, action, tell = true, days = 0, reason = "" } = {}) {
  if (!isAdmin(viewer)) throw new Refuse(403, "Admins only.");
  if (!["dismiss", "false", "remove", "ban"].includes(action)) throw new Refuse(400, "Unknown action.");
  await init();
  const id = parseInt(message, 10) || 0;
  const open = await getQuery("SELECT * FROM dm_reports WHERE message_id = ? AND resolved_at IS NULL", [id]);
  if (!open.length) throw new Refuse(404, "No open reports on that message.");
  const m = (await getQuery("SELECT * FROM messages WHERE id = ?", [id]))[0];
  if ((action === "remove" || action === "ban") && m && !m.deleted_at) {
    await runQuery("UPDATE messages SET body = NULL, deleted_at = ?, deleted_by = ? WHERE id = ?", [NOW(), "admin:" + viewer.username, id]);
    for (const r of await getQuery("SELECT user_id FROM conversation_members WHERE conversation_id = ?", [m.conversation_id])) emit(r.user_id, { t: "del", c: m.conversation_id, id });
  }
  if (action === "ban") {
    const s = await account(open[0].sender_id);
    if (s) await require("./feedstore").ban(viewer, s.username, { room: "", reason: cleanLine(reason, 200) || "reported direct message", days });
  }
  const act = { dismiss: "dismissed", false: "false", remove: "removed", ban: "banned" }[action];
  await runQuery(`UPDATE dm_reports SET resolved_at = ?, resolved_by = ?, action = ? WHERE id IN (${open.map(() => "?").join(",")})`,
                 [NOW(), viewer.username, act, ...open.map((r) => r.id)]);
  let notified = 0;
  if (tell) {
    const { REASONS } = reasons();
    const told = new Set();
    for (const r of open) {
      if (told.has(r.reporter_id)) continue;
      told.add(r.reporter_id);
      await notify(r.reporter_id, { kind: "feed", title: "Update on your report",
        body: action === "remove" || action === "ban" ? `We removed the message you reported (${REASONS[r.reason] || r.reason}). Thanks for helping keep PATV safe.`
                                                      : `We reviewed the message you reported (${REASONS[r.reason] || r.reason}) and it doesn't break the Terms. You can always block someone from your messages.`,
        link: "/messages", ref: "dm-repout:" + r.id });
    }
    notified = told.size;
    await runQuery(`UPDATE dm_reports SET notified_at = ? WHERE id IN (${open.map(() => "?").join(",")})`, [NOW(), ...open.map((r) => r.id)]);
  }
  return { ok: true, resolved: open.length, notified };
}

// ── Pepe's Camfrog alerts ──
function siteHost() {
  const base = process.env.SITE_URL || (process.env.STAGING ? "https://staging.publicaccess.tv" : "https://publicaccess.tv");
  return base.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}
/**
 * Due alerts for Pepe, claimed (each one is handed out once). -> [{id, login, from_login, count, text, text_plain}]
 * text quotes the latest message unless the recipient turned previews off; text_plain never does - Pepe uses
 * it when the sender is !incognito. Rows that can't be alerted (no Camfrog link, alerts off, blocked, left,
 * everything deleted, too old) are dropped without an alert.
 */
async function claimAlerts({ limit = 50 } = {}) {
  await init();
  const t = NOW();
  const rows = await getQuery(`SELECT * FROM dm_alerts WHERE pending > 0 AND first_at IS NOT NULL AND first_at <= ? AND last_alert_at <= ?
                               ORDER BY first_at LIMIT ?`, [t - ALERT_GRACE_MS, t - ALERT_GAP_MS, Math.min(200, limit)]);
  const out = [];
  const inbox = require("./inbox");
  const site = siteHost();
  for (const a of rows) {
    const claim = await runQuery(`UPDATE dm_alerts SET pending = 0, first_at = NULL, last_alert_at = ? WHERE user_id = ? AND conversation_id = ? AND pending = ? AND last_alert_at = ?`,
                                 [t, a.user_id, a.conversation_id, a.pending, a.last_alert_at]);
    if (!claim.changes) continue;                               // someone else (or a new message) got there first
    // not alertable after all: the pending count is dropped, but the 10-minute gap isn't used up
    const undo = () => runQuery("UPDATE dm_alerts SET last_alert_at = ? WHERE user_id = ? AND conversation_id = ?", [a.last_alert_at, a.user_id, a.conversation_id]);
    if (t - a.first_at > ALERT_MAX_AGE_MS) { await undo(); continue; }
    const rcpt = await account(a.user_id);
    const mem = await membership(a.conversation_id, a.user_id);
    if (!rcpt || !rcpt.camfrogUsername || rcpt.archived_at || !mem || !(await inbox.pmAllowed(a.user_id, "dm"))) { await undo(); continue; }
    // what they haven't read yet (from the others, not deleted)
    const unread = await getQuery(`SELECT * FROM messages WHERE conversation_id = ? AND id > ? AND sender_id != ? AND deleted_at IS NULL ORDER BY id`,
                                  [a.conversation_id, Math.max(mem.last_read_id, mem.cleared_id), a.user_id]);
    if (!unread.length) { await undo(); continue; }
    const last = unread[unread.length - 1];
    const sender = await account(last.sender_id);
    if (!sender || (await blocked(a.user_id, last.sender_id)).length) { await undo(); continue; }
    const n = unread.length;
    const P = await prefs(a.user_id);
    const head = n === 1 ? `💬 New message from ${display(sender)}` : `💬 ${n} new messages from ${display(sender)}`;
    const where = ` on ${site}/messages`;
    const quote = snippet(last.body, PREVIEW_CHARS).replace(/"/g, "'");
    const plain = head + where;
    out.push({ id: `${a.conversation_id}:${last.id}`, login: String(rcpt.camfrogUsername).toLowerCase(), user: rcpt.username,
               from: sender.username, from_login: sender.camfrogUsername ? String(sender.camfrogUsername).toLowerCase() : null, count: n,
               text: P.preview ? `${plain}: "${quote}"` : plain, text_plain: plain, preview: P.preview });
  }
  return out;
}

// ── nav count middleware (the 💬 next to the 🔔) ──
function navCount(req, res, next) {
  if (req.method !== "GET" || /^\/(api|public|og|uploads|events)\b|^\/healthz/.test(req.path)) return next();
  const uid = cookieUser(req);
  if (!uid) return next();
  unreadTotal(uid).then((n) => { res.locals.dmUnread = n; }, () => {}).then(() => next());
}

// ── routes ──
function register(app, { isBotToken, addUser }) {
  init().catch(() => {});
  const audit = require("./contentaudit");
  const sameSite = (req) => {
    const host = req.get("host"), src = req.get("origin") || req.get("referer");
    if (!src || !host) return true;
    try { return new URL(src).host === host; } catch (e) { return false; }
  };
  // every JSON call: same site + X-Requested-With: fetch + signed in (writes: JSON bodies only)
  const guard = (write) => (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (write && !req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    next();
  };
  const fail = (res, e) => {
    const st = e && e.status && e.status < 500 ? e.status : 500;
    if (st === 500) console.error("[dm]", e && e.message);
    res.status(st).json({ ok: false, error: st === 500 ? "Something went wrong." : e.message, code: (e && e.code) || undefined });
  };
  const viewer = async (req) => (req.user && req.user.userId ? account(req.user.userId) : null);

  const page = async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));
    try {
      const me = await account(req.user.userId);
      if (!me) return res.redirect("/login");
      const convs = await list(me.userId);
      const open = req.params.id && ID_RE.test(req.params.id) && (await membership(req.params.id, me.userId)) ? req.params.id : null;
      const to = !open && req.query.to ? String(req.query.to).slice(0, 64) : null;
      const unread = await unreadTotal(me.userId);
      res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
      res.render("messages", {
        title: unread ? `Messages (${unread})` : "Messages", user: me.username, dmUnread: unread,
        boot: { me: { username: me.username, display: display(me), camfrog: !!me.camfrogUsername, isNew: isNewAccount(me) },
                conversations: convs, open, to, prefs: await prefs(me.userId), blocks: await blockList(me.userId), maxLen: LIMITS.max_len,
                reasons: reasons().menu, levelOk: LIMITS.level_ok },
      });
    } catch (e) {
      console.error("[dm] page:", e && e.message);
      res.status(500).send("Couldn't load your messages.");
    }
  };
  app.get("/messages", addUser, page);
  app.get("/messages/c/:id", addUser, page);
  app.get("/messages/new", addUser, (req, res) => res.redirect("/messages" + (req.query.to ? "?to=" + encodeURIComponent(String(req.query.to).slice(0, 64)) : "")));

  app.get("/api/messages/conversations", addUser, guard(false), async (req, res) => {
    try { res.json({ ok: true, conversations: await list(req.user.userId), unread: await unreadTotal(req.user.userId) }); } catch (e) { fail(res, e); }
  });
  app.get("/api/messages/check", addUser, guard(false), async (req, res) => {
    try { res.json({ ok: true, ...(await check(req.user, String(req.query.to || ""))) }); } catch (e) { fail(res, e); }
  });
  app.get("/api/messages/c/:id", addUser, guard(false), async (req, res) => {
    try {
      const q = req.query || {};
      const h = await history(req.user, req.params.id, { before: q.before, after: q.after, limit: q.limit });
      res.json({ ok: true, ...h, conversation: q.head ? await header(req.user, req.params.id) : undefined });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/messages/send", addUser, guard(true), async (req, res) => {
    try {
      const b = req.body || {};
      const r = await send(req.user, { to: b.to ? String(b.to) : null, conversation: b.conversation ? String(b.conversation) : null, body: b.body }, audit.fromRequest(req));
      res.json({ ok: true, ...r });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/messages/c/:id/read", addUser, guard(true), async (req, res) => {
    try { res.json({ ok: true, unread: await markRead(req.user, req.params.id, (req.body || {}).upTo) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/messages/c/:id/clear", addUser, guard(true), async (req, res) => {
    try { await clear(req.user, req.params.id, { hide: !!(req.body || {}).hide }); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.post("/api/messages/m/:id/delete", addUser, guard(true), async (req, res) => {
    try { await deleteMessage(req.user, req.params.id); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  app.post("/api/messages/m/:id/report", addUser, guard(true), async (req, res) => {
    try { const b = req.body || {}; res.json(await report(req.user, req.params.id, { reason: b.reason, note: b.note })); } catch (e) { fail(res, e); }
  });
  app.post("/api/messages/block", addUser, guard(true), async (req, res) => {
    try { const b = req.body || {}; res.json({ ok: true, ...(await setBlock(req.user, String(b.username || ""), b.on !== false)) }); } catch (e) { fail(res, e); }
  });
  app.get("/api/messages/prefs", addUser, guard(false), async (req, res) => {
    try { res.json({ ok: true, prefs: await prefs(req.user.userId), blocks: await blockList(req.user.userId) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/messages/prefs", addUser, guard(true), async (req, res) => {
    try {
      const b = req.body || {};
      res.json({ ok: true, prefs: await setPrefs(req.user.userId, { who: b.who, preview: b.preview === undefined ? undefined : !!b.preview,
                                                                   alerts: b.alerts === undefined ? undefined : !!b.alerts }) });
    } catch (e) { fail(res, e); }
  });

  // admin: one reported message (logged) and the outcome
  app.get("/api/messages/admin/report/:id", addUser, guard(false), async (req, res) => {
    res.set("X-Robots-Tag", "noindex");
    try { res.json({ ok: true, ...(await reportDetail(await viewer(req), req.params.id, { reason: req.query.why })) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/messages/admin/report-action", addUser, guard(true), async (req, res) => {
    try {
      const b = req.body || {};
      res.json(await reportAction(await viewer(req), { message: b.message, action: String(b.action || ""), tell: b.notify !== false, days: Number(b.days) || 0, reason: b.reason }));
    } catch (e) { fail(res, e); }
  });

  // Pepe: due Camfrog alerts (bot token)
  app.post("/api/messages/alerts/claim", async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json({ ok: true, alerts: await claimAlerts({ limit: Number(b.limit) || 50 }) }); } catch (e) { fail(res, e); }
  });
}

module.exports = { init, register, sse, navCount, send, list, history, header, check, markRead, deleteMessage, clear, setBlock, blockList,
                   prefs, setPrefs, refusal, report, reportQueue, reportDetail, reportAction, claimAlerts, unreadTotal, render, isNewAccount,
                   emit, Refuse, LIMITS, WHO, ALERT_GAP_MS, ALERT_GRACE_MS, _setClock, _gaps: gaps, _streams: streams };
