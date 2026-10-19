// feedmentions.js — @username mentions and #hashtags in feed posts AND comments (1.99kk).
//
// ONE code path for both (feedweb.linkify -> padText calls inlineRefs; feedstore.create / edit / comment / editComment
// call notify), so a post body and a comment behave the same:
//
// RENDERING (inlineRefs, on already-escaped html; only text outside tags and outside existing <a> links is touched):
//   @name   -> <a class="user-ref mention" href="/u/<Name>">@name</a> for a KNOWN account (pads.knownUserSync - the same
//              cached username set as u/<name> links); an unknown name stays plain text
//   #tag    -> <a class="tag-ref" href="/feed?tag=<tag>">#tag</a> (the tag page / search, the same as a post's own tag
//              chips; feedtags.normTag). Needs a letter (so "#1" stays text); "&#39;" entities can't match (the "&").
//   Emails (bob@x.com) never match: the "@" must not follow a letter / digit.
//
// NOTICES (notify): the 🔔 "mention" kind (inbox.js) - the same kind and the same preferences as room mention alerts
// (mentions.feedAllowed: the "@mentions in posts and comments" switch, default on; the mute; quiet hours) - and, 1.99acd,
// a content-free browser notification where the member turned those on (webpush.js). Nobody is told when:
//   * it's yourself, an archived account, or Pepe
//   * either of you blocked the other (messages.js dm_blocks - the same blocks as DMs)
//   * they couldn't see the post (feedstore.postSeenBy: an Approved pad they're outside of), or it's deleted / hidden /
//     waiting for a pad's approval in every pad it was posted to
//   * they're already being told about this comment (the post's author / the person replied to get their own notice)
//   * an edit: only names that weren't in the text before count, and the notice ref (fmention:<kind>:<id>:<user>)
//     makes a second notice for the same post / comment impossible
//   * rate limits (in memory): MAX_NAMES names per text; one author can notify the same person PAIR_HOUR times an hour
//     and AUTHOR_HOUR notices an hour in all; a person gets at most RECIPIENT_HOUR feed mentions an hour
//
// HASHTAGS AND THE TAG PAGES: a #tag in a post or comment LINKS to the tag page; it is not added to the post's tags.
// A post's tags (feedtags.js) are curated metadata - at most 5, set by the author, removable by the pad's mods (and a
// removed tag stays removed). Letting a comment's #tag put the post on a tag page would let anyone re-attach a tag a mod
// took off and spam any post onto any tag, so comment hashtags are linked, not indexed.
//
// Autocomplete: GET /api/mentions/suggest?q=<prefix> (signed in, same-site fetch, SUGGEST_PER_MIN a minute) ->
// [{username, display}] (live accounts, username or display name starting with q); public/js/mention-complete.js.
"use strict";
const { getQuery } = require("./dbUtils");

const MAX_NAMES = 10;
const PAIR_HOUR = 5, AUTHOR_HOUR = 40, RECIPIENT_HOUR = 30;
const SUGGEST_MAX = 8, SUGGEST_PER_MIN = 60;
let NOW = () => Date.now();

// a username: letters, digits, dot, dash, underscore; starts and ends with a letter / digit (pads.USER_REF_RE).
// 1.99ui: up to usernamerules.USERNAME_MAX (48) characters - it was 40, which hid long legacy names from @mentions.
const UR = require("./usernamerules");
const NAME = UR.NAME_SRC;
const NAME_FULL_RE = new RegExp("^" + NAME + "$");
const MENTION_RE = new RegExp("(^|[^A-Za-z0-9_.@/+\\-])@(" + NAME + ")(?![A-Za-z0-9_@\\-])", "g");
const TAG_RE = /(^|[^\p{L}\p{N}_&#/\-])#([\p{L}\p{N}_](?:[\p{L}\p{N}_-]{0,38}[\p{L}\p{N}_])?)(?![\p{L}\p{N}_-])/gu;
const HAS_LETTER = /\p{L}/u;

/** The distinct @names in raw text (lowercase), at most MAX_NAMES. */
function names(text) {
  const out = [];
  const s = String(text == null ? "" : text);
  MENTION_RE.lastIndex = 0;
  let m;
  while ((m = MENTION_RE.exec(s))) {
    const n = m[2].toLowerCase();
    if (!out.includes(n)) out.push(n);
    if (out.length >= MAX_NAMES) break;
  }
  return out;
}
/** The distinct #tags in raw text, normalised like post tags (feedtags.normTag). */
function hashtags(text) {
  const T = require("./feedtags");
  const out = [];
  const s = String(text == null ? "" : text);
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(s))) {
    if (!HAS_LETTER.test(m[2])) continue;
    const t = T.normTag(m[2]);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

// ── rendering ──
const knownDefault = (n) => { try { return require("./pads").knownUserSync(n); } catch (e) { return null; } };
/** @mentions + #hashtags in one piece of ESCAPED text with no tags in it. */
function refsInText(s, known) {
  const T = require("./feedtags");
  let out = s.replace(TAG_RE, (m, pre, raw) => {
    if (!HAS_LETTER.test(raw)) return m;
    const tag = T.normTag(raw);
    if (!tag) return m;
    return `${pre}<a class="tag-ref" href="/feed?tag=${encodeURIComponent(tag)}">#${raw}</a>`;
  });
  out = out.replace(MENTION_RE, (m, pre, name) => {
    const real = known(name);
    if (!real) return m;
    return `${pre}<a class="user-ref mention" href="/u/${encodeURIComponent(real)}">@${name}</a>`;
  });
  return out;
}
/**
 * Link @mentions and #hashtags in already-escaped html. Text inside tags and inside existing links (URLs, p/ and u/
 * refs) is left alone. `known(name)` -> the account's exact username or null (injectable for tests).
 */
function inlineRefs(html, known = knownDefault) {
  const s = String(html == null ? "" : html);
  if (s.indexOf("@") < 0 && s.indexOf("#") < 0) return s;
  const parts = s.split(/(<[^>]*>)/);
  let inA = 0, out = "";
  for (const p of parts) {
    if (!p) continue;
    if (p[0] === "<") {
      if (/^<a[\s>]/i.test(p)) inA++;
      else if (/^<\/a\s*>/i.test(p)) inA = Math.max(0, inA - 1);
      out += p;
    } else out += inA ? p : refsInText(p, known);
  }
  return out;
}

// ── rate limits ──
const hits = new Map();    // key -> [ms]
function under(key, max, t) {
  const a = (hits.get(key) || []).filter((x) => t - x < 3600e3);
  hits.set(key, a);
  return a.length < max;
}
function take(key, t) { const a = hits.get(key) || []; a.push(t); hits.set(key, a); if (hits.size > 50000) hits.clear(); }

async function blockedEither(a, b) {
  try {
    return (await getQuery("SELECT 1 FROM dm_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1", [a, b, b, a])).length > 0;
  } catch (e) { return false; }          // no DM tables (a bare test DB): no blocks
}
async function accounts(list) {
  if (!list.length) return [];
  const cols = new Set((await getQuery("PRAGMA table_info(users)")).map((c) => c.name));
  const arch = cols.has("archived_at") ? "archived_at" : "NULL AS archived_at";
  return getQuery(`SELECT userId, username, displayname, class, ${arch} FROM users WHERE LOWER(username) IN (${list.map(() => "?").join(",")})`, list);
}

const snip = (s, n) => { const x = String(s || "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n - 1).trimEnd() + "…" : x; };
const stickerText = (s) => { try { return require("./stickers").fallbackText(s); } catch (e) { return String(s == null ? "" : s); } };

/**
 * Tell the people newly @mentioned in a post or comment. opts: {author: {userId, username, displayname},
 * kind: "post" | "comment", id (post / comment id), postId, text, prevText (an edit: names already there don't count),
 * skip: [userIds already told about this], link}. -> [usernames notified]. Never throws.
 */
async function notify(opts = {}) {
  try {
    const store = require("./feedstore");
    const author = opts.author || {};
    if (!author.userId) return [];
    const before = new Set(names(opts.prevText));
    const fresh = names(opts.text).filter((n) => !before.has(n));
    if (!fresh.length) return [];
    const p = (await getQuery("SELECT * FROM feed_posts WHERE id = ?", [String(opts.postId || "")]))[0];
    if (!p || p.deleted_at || p.hidden_at) return [];
    // a post waiting for a pad's approval everywhere it was posted isn't out yet
    const placed = await getQuery("SELECT pending, removed_at, hidden_at FROM feed_post_rooms WHERE post_id = ?", [p.id]);
    if (placed.length && !placed.some((r) => !r.removed_at && !r.pending && !r.hidden_at)) return [];
    if (opts.kind === "comment") {
      const c = (await getQuery("SELECT deleted_at, hidden_at FROM feed_comments WHERE id = ?", [String(opts.id || "")]))[0];
      if (!c || c.deleted_at || c.hidden_at) return [];
    }
    const skip = new Set([author.userId, ...(opts.skip || [])]);
    const who = snip(author.displayname || author.username || "someone", 40);
    const mentions = require("./mentions");
    const inbox = require("./inbox");
    const t = NOW();
    const out = [];
    for (const a of await accounts(fresh)) {
      if (skip.has(a.userId) || a.archived_at || store.isPepe(a)) continue;
      skip.add(a.userId);
      if (await blockedEither(author.userId, a.userId)) continue;
      if (!(await store.postSeenBy(a, p))) continue;
      if (!(await mentions.feedAllowed(a.userId, t))) continue;
      if (!under("a|" + author.userId, AUTHOR_HOUR, t) || !under("p|" + author.userId + "|" + a.userId, PAIR_HOUR, t) || !under("r|" + a.userId, RECIPIENT_HOUR, t)) continue;
      const where = opts.kind === "comment" ? "a comment" : "a post";
      const ref = `fmention:${opts.kind === "comment" ? "c" : "p"}:${opts.id}:${a.userId}`;
      const stored = await inbox.addSafe(a.userId, {
        // stkfix B2: a sticker reads "[sticker: Happy Pepe]" in the notice (and its Telegram alert), never the raw token
        kind: "mention", title: `💬 ${who} mentioned you in ${where}`, body: snip(stickerText(opts.text), 300), link: opts.link || "/feed", ref,
      });
      if (!stored) continue;
      // 1.99acd: the browser notification (webpush.js) - "You were mentioned in a post / comment", never the text or the author
      try {
        require("./webpush").onMention(a.userId, { kind: "mention", roomId: null, ctx: opts.kind === "comment" ? "comment" : "post", url: opts.link || "/feed", srcKey: ref });
      } catch (e) { /* never fails the notice */ }
      take("a|" + author.userId, t); take("p|" + author.userId + "|" + a.userId, t); take("r|" + a.userId, t);
      out.push(a.username);
    }
    return out;
  } catch (e) {
    console.error("[feedmentions] notify:", e.message);
    return [];
  }
}

// ── autocomplete ──
const likeEsc = (s) => s.replace(/[\\%_]/g, (c) => "\\" + c);
async function suggest(q, viewer = null) {
  const s = String(q == null ? "" : q).trim().replace(/^@/, "").slice(0, UR.USERNAME_MAX);
  if (!s || !/^[\p{L}\p{N}._ -]+$/u.test(s)) return [];
  const cols = new Set((await getQuery("PRAGMA table_info(users)")).map((c) => c.name));
  const live = cols.has("archived_at") ? "archived_at IS NULL AND " : "";
  const pre = likeEsc(s.toLowerCase()) + "%";
  const rows = await getQuery(`SELECT username, displayname FROM users WHERE ${live}username IS NOT NULL
                               AND (LOWER(username) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(displayname, '')) LIKE ? ESCAPE '\\')
                               ORDER BY CASE WHEN LOWER(username) LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, LENGTH(username), username LIMIT ?`,
                              [pre, pre, pre, SUGGEST_MAX + 1]);
  const me = viewer && viewer.username ? String(viewer.username).toLowerCase() : null;
  return rows.filter((r) => NAME_FULL_RE.test(r.username) && String(r.username).toLowerCase() !== me && String(r.username).toLowerCase() !== "pepe")
    .slice(0, SUGGEST_MAX)
    .map((r) => ({ username: r.username, display: r.displayname && r.displayname !== r.username ? snip(r.displayname, 40) : null }));
}

function register(app, { addUser }) {
  const guard = require("./middleware/authGuard");
  const calls = new Map();
  app.get("/api/mentions/suggest", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!guard.sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    const t = NOW();
    const a = (calls.get(req.user.userId) || []).filter((x) => t - x < 60e3);
    if (a.length >= SUGGEST_PER_MIN) return res.status(429).json({ ok: false, error: "Slow down." });
    a.push(t); calls.set(req.user.userId, a);
    if (calls.size > 20000) calls.clear();
    try { res.json({ ok: true, people: await suggest(req.query.q, req.user) }); } catch (e) {
      console.error("[feedmentions] suggest:", e.message);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });
}

module.exports = { names, hashtags, inlineRefs, notify, suggest, register, MENTION_RE, TAG_RE, MAX_NAMES, PAIR_HOUR, AUTHOR_HOUR, RECIPIENT_HOUR,
                   _setClock: (fn) => { NOW = fn || (() => Date.now()); }, _reset: () => hits.clear() };
