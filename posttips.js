// posttips.js — 💸 tips on feed posts (1.99pv): tip the author of any feed post from the post itself (the feed, the post
// page, pad feeds, profile posts). A post tip IS a normal tip - the same money path, tagged with the post.
//
// HOW IT WORKS
//   * Money: tips.transferPat (the one tip path: /u/<name>/tip, the pad tip modal, the chatbot route). The sender's
//     "tip sent" row and the author's "tip received" row, full amount, no cut, no new fee; amounts are typed like
//     everywhere else (public/js/patamount.js: 2,500 / 2.5k / 1m) and must be >= 1 PAT, at most the balance.
//   * Tag: one post_tips row per tip (post id, sender, recipient, amount, note, both transactions ids, the request
//     ref). The ledger rows themselves are untouched, so /history, the tip jar and every tip achievement
//     (cf_tip_first / cf_tip_people_10 / cf_tip_fans_* in achsocial.js, tips_sent_pat / tips_recv_pat in
//     achievements.js) count a post tip exactly like any other tip - nothing is counted twice.
//   * Retry-safe: the client sends one idempotency key per confirmed attempt; the server stores the answer under
//     "posttip:<sender>:<key>" (index.js idemBegin, the same table the tip route uses) and the post_tips row is unique
//     by that ref, so a double click / network retry can't tip (or tag) twice.
//   * Who can tip: signed in; not your own post; not Pepe's posts; not a deleted / hidden post or one the viewer can't
//     see (feedstore.postSeenBy - Approved pads); not when either of you blocked the other (dm_blocks, the same rule as
//     🎁 gifts). The tip path's own refusals (balance, missing account) come back unchanged.
//   * Notice: the author's inbox (kind "tip", so the Telegram "tip" alert follows) - "<x> tipped your post PAT n",
//     the note (or the post's title), linking the post. Nothing is said in Camfrog rooms (no `room` on a post tip).
//   * Display: decorate() puts `tips: {n, total}` on every post (one grouped query per page); the card shows
//     "💸 N tips · X PAT" to EVERYONE once a post has a tip (social proof, like the score), and a 💸 Tip button to
//     signed-in viewers who can tip it. The sheet is public/js/post-tip.js (+ public/css/posttips.css).
//
// REUSE (e.g. PATV Creators' locked-post / creator tips): call tip() with your own `kind` (stored on the row) and
// `notice` text; read totals with forPosts(ids) or forPost(id, {kind}). Pass `check` to add your own refusal
// (throw a Refuse) before any PAT moves.
//
//   tip({ sender: {userId, username}, postId, amount, note, key, kind = "post", notice, check }) ->
//       {ok, amount, balance, tips: {n, total}, replay?}  | throws Refuse {status, message}
//   forPosts(ids) -> Map postId -> {n, total}      forPost(id) -> {n, total}
//   register(app, { addUser, idemBegin })          POST /api/feed/posts/:id/tip  {amount, note, idempotency_key}
"use strict";
const { runQuery, getQuery } = require("./dbUtils");
const tips = require("./tips");
const amountOf = require("./public/js/patamount").parse;

class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }

let readyP = null;
function ready() {
  if (!readyP) readyP = (async () => {
    await runQuery(`CREATE TABLE IF NOT EXISTS post_tips (
      id INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT NOT NULL, sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
      amount INTEGER NOT NULL, note TEXT, kind TEXT NOT NULL DEFAULT 'post', sent_tx TEXT, recv_tx TEXT, ref TEXT, created INTEGER NOT NULL)`);
    await runQuery("CREATE INDEX IF NOT EXISTS post_tips_post ON post_tips (post_id)");
    await runQuery("CREATE INDEX IF NOT EXISTS post_tips_sender ON post_tips (sender_id, created)");
    await runQuery("CREATE UNIQUE INDEX IF NOT EXISTS post_tips_ref ON post_tips (ref)");
  })().catch((e) => { readyP = null; throw e; });
  return readyP;
}

/** Tip totals for many posts at once: Map id -> {n, total} (posts with no tips are left out). */
async function forPosts(ids, { kind = null, notKind = null } = {}) {
  const list = [...new Set((ids || []).map(String))].filter(Boolean);
  const out = new Map();
  if (!list.length) return out;
  await ready();
  // 2026-10-12: notKind - the card's 💸 tips tally leaves the boost upvotes out (they have their own "boosted" total)
  const rows = await getQuery(`SELECT post_id, COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM post_tips
                               WHERE post_id IN (${list.map(() => "?").join(",")})${kind ? " AND kind = ?" : ""}${notKind ? " AND kind != ?" : ""} GROUP BY post_id`,
                              [...list, ...(kind ? [kind] : []), ...(notKind ? [notKind] : [])]);
  for (const r of rows) out.set(r.post_id, { n: r.n, total: r.total });
  return out;
}
async function forPost(id, opts) { return (await forPosts([id], opts)).get(String(id)) || { n: 0, total: 0 }; }

const short = (s, n) => { const a = Array.from(String(s || "").replace(/\s+/g, " ").trim()); return a.length > n ? a.slice(0, n - 1).join("") + "…" : a.join(""); };

/** The post a tip is for, or a Refuse: it exists, is live, the sender can see it and may tip its author. */
async function target(sender, postId) {
  const store = require("./feedstore");
  const r = await store.getRow(postId);
  if (!r || r.purged_at) throw new Refuse(404, "No such post.");
  if (r.deleted_at || r.hidden_at) throw new Refuse(409, "This post can't be tipped.");
  if (!(await store.postSeenBy(sender, r))) throw new Refuse(404, "No such post.");
  if (store.isPepe(r.author_id)) throw new Refuse(400, "Pepe's posts can't be tipped.");
  if (r.author_id === sender.userId) throw new Refuse(400, "You can't tip your own post.");
  const a = (await getQuery("SELECT userId, username FROM users WHERE userId = ?", [r.author_id]))[0];
  if (!a) throw new Refuse(404, "The author's account is gone.");
  let blocked = [];
  try {
    blocked = await getQuery("SELECT 1 FROM dm_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1",
                             [a.userId, sender.userId, sender.userId, a.userId]);
  } catch (e) { blocked = []; }             // no dm_blocks table yet: nobody blocked anybody
  if (blocked.length) throw new Refuse(403, `You can't tip ${a.username}.`);
  return { post: r, author: a };
}

/**
 * Tip a post's author. `key` = the client's per-attempt key (the route has already claimed it in idempotency_keys;
 * here it makes the post_tips row unique). Throws a Refuse before any PAT moves when the tip isn't allowed.
 */
async function tip({ sender, postId, amount, note, key = null, kind = "post", notice = null, check = null } = {}) {
  if (!sender || !sender.userId || !sender.username) throw new Refuse(401, "Sign in first.");
  const n = amountOf(amount);
  if (!Number.isFinite(n)) throw new Refuse(400, "Use a number like 2500, 25k or 1.5m.");
  if (n < 1) throw new Refuse(400, "Tip at least 1 PAT.");
  await ready();
  const { post, author } = await target(sender, postId);
  if (typeof check === "function") await check({ sender, post, author, amount: n });
  const clean = tips.cleanTipNote(note);
  const path = (await require("./feedstore").postPath(post.id)) || "/feed";
  const label = post.title ? short(post.title, 60) : null;
  const N = notice || {
    title: `${sender.username} tipped your post PAT ${n.toLocaleString("en-US")}`,
    body: clean ? `"${clean}"` : (label ? `On "${label}"` : ""),
  };
  const r = await tips.transferPat(sender.username, author.username, n, clean, {
    notice: { title: N.title, body: N.body, link: N.link || path, ref: key ? "posttip:" + key : null },
  });
  if (!r.ok) throw new Refuse(r.status, r.msg);
  // the tag: never undoes the tip if it fails (the money moved; the row is the post's tally)
  try {
    await runQuery(`INSERT OR IGNORE INTO post_tips (post_id, sender_id, recipient_id, amount, note, kind, sent_tx, recv_tx, ref, created)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                   [post.id, r.senderId || sender.userId, r.recipientId || author.userId, r.amount, clean, String(kind || "post").slice(0, 24),
                    r.sentTx || null, r.recvTx || null, key, Date.now()]);
  } catch (e) { console.error("[posttips] tag:", e.message); }
  return { ok: true, amount: r.amount, balance: r.balance, tips: await forPost(post.id, { notKind: "boost" }) };
}

function register(app, { addUser, idemBegin }) {
  const sameSite = (req) => {
    const host = req.get("host"), src = req.get("origin") || req.get("referer");
    if (!src || !host) return true;
    try { return new URL(src).host === host; } catch (e) { return false; }
  };
  app.post("/api/feed/posts/:id/tip", addUser, async (req, res) => {
    if (!sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    const u = req.user;
    if (!u || !u.userId || !u.username) return res.status(401).json({ ok: false, error: "Sign in first." });
    req.body = req.body || {};
    // one key per confirmed attempt, namespaced by sender (one user's key can never replay another user's answer)
    const raw = req.body.idempotency_key || req.get("Idempotency-Key");
    const key = raw ? `${u.username}:${String(raw).slice(0, 64)}` : null;
    req.body.idempotency_key = key ? "posttip:" + key : undefined;
    const idem = idemBegin ? await idemBegin(req, res, "posttip") : { replay: false, done: () => {}, fail: () => {} };
    if (idem.replay) return;
    try {
      const out = await tip({ sender: u, postId: String(req.params.id || "").slice(0, 32), amount: req.body.amount, note: req.body.note, key });
      idem.done(200, out);
      res.json(out);
    } catch (e) {
      idem.fail();
      const st = e && e.refuse && e.status ? e.status : 500;
      if (st === 500) console.error("[posttips]", e);
      res.status(st).json({ ok: false, error: st === 500 ? "The tip didn't go through - nothing was sent." : e.message });
    }
  });
}

module.exports = { ready, tip, forPosts, forPost, register, Refuse };
