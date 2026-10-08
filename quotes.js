// quotes.js — chat quotes (1.99fp): a moment of a Camfrog room's conversation clipped into a quote post on its pad,
// bash.org style. Lines are chat lines and 🎙 mic transcripts, from one or more speakers.
//
// Where the lines come from: ONLY the bridge's own copy of the room (bridge.js R.feed - what the pad's Live tab
// shows). So nothing the bridge doesn't already show publicly can be quoted: never PMs (the bridge drops them),
// never a line of anyone who was !incognito / !bridge hide when they said it (Pepe never sends those), and anyone
// who is private NOW shows as "someone" too: Pepe sends one-way hashes of the private logins with every sync
// (hidden_h: sha256("pepe-hidden:<login>"), 20 hex - setHidden), checked when a quote is made AND when one is shown
// (a quote whose speaker went private since is anonymised for good the first time it's rendered).
//
// Making one
//   web   the Live tab's "✂️ Clip chat" (public/js/chat-clip.js): pick lines (tap, shift-click, long-press), preview,
//         optional title, "also on my profile" -> POST /api/rooms/:slug/quote {cs: [feed cursor ids], title, profile}.
//         The ids are looked up in the bridge feed here (never text from the browser); at most MAX_LINES lines spanning
//         at most SPAN_MAX feed items. Credited to the signed-in account; the pad's posting rules apply (feedstore).
//   chat  !quote last 5 · !quote @user 3 · !quote from <words> to <words> (pepe_quote.py) -> POST /api/bridge/quote
//         (bot token) {room, camfrog, spec, before, title}: the lines are picked here from the same feed, only lines
//         before the command; credited to the requester's linked PATV account, else to Pepe.
//   Both: rate-limited per account / login (GAP, BURST per WINDOW) on top of the feed's own post limits.
//
// The post: an ordinary feed post (votes, comments, crossposts, reports) whose body is the quote as plain text (search,
// labels) plus a feed_quotes row {post_id, room_id, lines: [{k, login|null, name, text, ts}], logins}. decorate()
// adds `quote` and the card shows it as a quote (feed-post-content.ejs); Hop shows it as a card; /p/<pad>/quotes lists
// a pad's quotes (top / new + "Quote of the day": the best-voted quote of the last 24 h, else of the week).
// The body can't be edited (feedstore.edit), only the title.
//
// Consent: anyone quoted (their linked Camfrog login is one of the speakers) gets "Remove me": their lines in THAT
// quote become "someone", their name is blanked inside the other lines too, and the body is rewritten. The quote's
// author is told. A room's !clip switch doesn't apply: a quote is text, the same text the pad already shows.
"use strict";
const crypto = require("crypto");
const express = require("express");
const { runQuery, getQuery } = require("./dbUtils");

const MAX_LINES = 20, SPAN_MAX = 40, LINE_MAX = 400, TITLE_MAX = 140, PHRASE_MAX = 60;
const GAP = 20 * 1000, BURST = 5, WINDOW = 30 * 60 * 1000;
const POST_RE = /^[A-Za-z0-9]{8,16}$/;
const LOGIN_RE = /^[\w.\-]{1,40}$/;
let NOW = () => Date.now();
function _setClock(fn) { NOW = fn; }

class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }

// ── who is private right now (Pepe's hidden_h) ──
let HIDDEN = new Set();
const hiddenHash = (login) => crypto.createHash("sha256").update("pepe-hidden:" + String(login || "").trim().toLowerCase()).digest("hex").slice(0, 20);
function setHidden(list) {
  if (!Array.isArray(list)) return;
  HIDDEN = new Set(list.filter((x) => typeof x === "string" && /^[0-9a-f]{20}$/.test(x)).slice(0, 5000));
}
const isHidden = (login) => !!login && HIDDEN.has(hiddenHash(login));

// ── rate limits (memory) ──
const hits = new Map();
function limited(key, now = NOW()) {
  const q = (hits.get(key) || []).filter((t) => now - t < WINDOW);
  if (q.length && now - q[q.length - 1] < GAP) return `Slow down — one quote every ${Math.round(GAP / 1000)}s.`;
  if (q.length >= BURST) return `Slow down — ${BURST} quotes per ${Math.round(WINDOW / 60000)} min.`;
  q.push(now);
  hits.set(key, q);
  if (hits.size > 5000) hits.delete(hits.keys().next().value);
  return null;
}

// ── picking lines out of the bridge feed ──
const isLine = (it) => !!it && (it.k === "msg" || it.k === "tx") && !!it.u && !it.u.anon && !!it.u.login && typeof it.text === "string" && !!it.text.trim();
const isCmd = (it) => it.k === "msg" && /^\s*[!/]/.test(it.text);
// Pepe's own announcements of quotes / clips / captures aren't conversation
const isPepeNoise = (it) => !!it.u.self && /^\s*(💬 quoted|🔊 |📹 |📸 |🎬 )/u.test(it.text);
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();
const nameMatches = (it, who) => {
  const w = low(who).replace(/^@/, "");
  return !!w && (low(it.u.login) === w || low(it.u.display) === w || low(it.u.cf) === w);
};

/**
 * Pick the lines of a quote from a bridge feed (oldest first). spec:
 *   {cs: [cursor ids]}                    the website's selection (exactly these lines, any of them a command)
 *   {mode: "last", n}                     the last n lines before `before`
 *   {mode: "user", login|user, n}         that user's last n lines with the lines around them
 *   {mode: "range", from, to}             from the line containing `from` to the (latest) line containing `to`
 * -> {items} or {error}
 */
function pick(feed, spec, before = null) {
  const F = Array.isArray(feed) ? feed : [];
  if (spec && Array.isArray(spec.cs)) {
    const want = [...new Set(spec.cs.map(Number).filter((c) => Number.isInteger(c) && c > 0))];
    if (!want.length) return { error: "Pick the lines to quote." };
    if (want.length > MAX_LINES) return { error: `A quote is at most ${MAX_LINES} lines.` };
    const idx = want.map((c) => F.findIndex((it) => it && it.c === c));
    if (idx.some((i) => i < 0)) return { error: "Some of those lines aren't in the room's feed any more — pick again." };
    const items = idx.map((i) => F[i]);
    if (items.some((it) => !isLine(it))) return { error: "Only chat and 🎙 mic lines can be quoted." };
    const span = Math.max(...idx) - Math.min(...idx) + 1;
    if (span > SPAN_MAX) return { error: "Those lines are too far apart — pick lines close together." };
    return { items: idx.map((i, k) => [i, items[k]]).sort((a, b) => a[0] - b[0]).map((x) => x[1]) };
  }
  const cut = Number(before) > 0 ? Number(before) : Infinity;
  const cand = F.filter((it) => isLine(it) && it.ts <= cut && !isCmd(it) && !isPepeNoise(it));
  const mode = spec && spec.mode;
  const n = Math.max(1, Math.min(MAX_LINES, Math.floor(Number(spec && spec.n)) || 0));
  if (mode === "last") {
    if (!cand.length) return { error: "Nothing's been said here lately." };
    return { items: cand.slice(-n) };
  }
  if (mode === "user") {
    const who = spec.login || spec.user;
    const theirs = cand.map((it, i) => [i, it]).filter((x) => nameMatches(x[1], who) || (spec.user && nameMatches(x[1], spec.user)));
    if (!theirs.length) return { error: `No recent lines from ${String(spec.user || who).slice(0, 40)} on the pad.` };
    const mine = theirs.slice(-n);
    const a = Math.max(0, mine[0][0] - 1), b = Math.min(cand.length - 1, mine[mine.length - 1][0] + 1);
    if (b - a + 1 <= MAX_LINES) return { items: cand.slice(a, b + 1) };
    return { items: mine.map((x) => x[1]) };
  }
  if (mode === "range") {
    const A = low(spec.from).slice(0, PHRASE_MAX), B = low(spec.to).slice(0, PHRASE_MAX);
    if (A.length < 2 || B.length < 2) return { error: "Give a couple of words for each end." };
    let j = -1;
    for (let k = cand.length - 1; k >= 0; k--) if (low(cand[k].text).includes(B)) { j = k; break; }
    if (j < 0) return { error: `No recent line says “${String(spec.to).slice(0, 40)}”.` };
    let i = -1;
    for (let k = j; k >= Math.max(0, j - SPAN_MAX); k--) if (low(cand[k].text).includes(A)) { i = k; break; }
    if (i < 0) return { error: `No line before that says “${String(spec.from).slice(0, 40)}”.` };
    if (j - i + 1 > MAX_LINES) return { error: `That's more than ${MAX_LINES} lines — narrow it down.` };
    return { items: cand.slice(i, j + 1) };
  }
  return { error: "Pick the lines to quote." };
}

// ── building the stored lines (names as the bridge shows them; private people as "someone") ──
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function redactor(names) {
  const list = [...new Set(names.map((n) => String(n || "").trim()).filter((n) => n.length >= 3))].sort((a, b) => b.length - a.length).slice(0, 200);
  if (!list.length) return (s) => s;
  const rx = new RegExp("(^|[^\\w])@?(?:" + list.map(esc).join("|") + ")(?![\\w])", "gi");
  return (s) => String(s).replace(rx, (m, pre) => pre + "someone");
}
async function namesFor(items) {
  try {
    const B = require("./bridge");
    const L = await B.resolveNames(items.map((it) => it.u));
    return (u) => B.withPatv(u, L);
  } catch (e) { return (u) => u; }
}
/** feed items -> stored lines [{k, login, name, text, ts}] (+ the names to blank for anyone private). */
async function buildLines(items) {
  const view = await namesFor(items);
  const hiddenNames = [];
  const lines = items.map((it) => {
    const u = view(it.u) || it.u;
    const login = low(it.u.login);
    const hidden = isHidden(login);
    if (hidden) hiddenNames.push(login, it.u.display, u.display, u.cf);
    return { k: it.k === "tx" ? "tx" : "msg", login: hidden ? null : login, name: hidden ? "someone" : String(u.display || it.u.display || login).slice(0, 40),
             text: String(it.text).slice(0, LINE_MAX), ts: Number(it.ts) || 0, ...(it.u.self ? { pepe: true } : {}) };
  });
  const red = redactor(hiddenNames);
  for (const l of lines) l.text = red(l.text);
  return lines;
}
const bodyOf = (lines) => lines.map((l) => `<${l.name}> ${l.k === "tx" ? "🎙 " : ""}${l.text}`).join("\n").slice(0, 5000);
const loginsOf = (lines) => [...new Set(lines.map((l) => l.login).filter(Boolean))];

// ── storage ──
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await require("./feedstore").init();          // creates feed_quotes too (list() filters on it)
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
async function rowOf(postId) {
  await init();
  return (await getQuery("SELECT * FROM feed_quotes WHERE post_id = ?", [String(postId)]))[0] || null;
}
function parse(s, d) { try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } }

/**
 * Make the quote post. -> {post: {id, url}, lines: n, profile: crosspost result | null}
 * authorId: the account credited; roomId: the pad (registry id = the Camfrog room id); deps.viaPepe: Pepe's own account
 */
async function create({ authorId, roomId, items, title = "", profile = false, source = "web", viaPepe = false }) {
  await init();
  const S = require("./feedstore");
  if (!items || !items.length) throw new Refuse(400, "Pick the lines to quote.");
  const lines = await buildLines(items);
  const made = await S.create(authorId, { title: S.cleanLine(title, TITLE_MAX), body: bodyOf(lines), community: roomId, announce: [] },
                              viaPepe ? { roomGen: true } : {});
  try {
    await runQuery(`INSERT INTO feed_quotes (post_id, room_id, source, lines, logins, removed, created_by, created) VALUES (?, ?, ?, ?, ?, '[]', ?, ?)`,
                   [made.id, roomId, source, JSON.stringify(lines), " " + loginsOf(lines).join(" ") + " ", authorId, NOW()]);
  } catch (e) {
    await runQuery("UPDATE feed_posts SET deleted_at = ?, deleted_by = 'system', delete_reason = 'quote failed' WHERE id = ?", [NOW(), made.id]).catch(() => {});
    throw e;
  }
  let prof = null;
  if (profile && !viaPepe) {
    try { prof = await S.crosspostMany(authorId, made.id, { pads: ["profile"] }); } catch (e) { prof = { error: e.message }; }
  }
  console.log(`[quotes] ${made.id} in ${roomId} by ${authorId} (${source}): ${lines.length} lines, ${loginsOf(lines).length} speakers`);
  return { post: { id: made.id, url: made.url }, lines: lines.length, profile: prof };
}

/** Blank `logins` out of a quote: their lines become "someone", their names inside the other lines too. -> changed? */
async function anonymise(row, logins, { names = [] } = {}) {
  const set = new Set(logins.map(low).filter(Boolean));
  if (!row || !set.size) return false;
  const lines = parse(row.lines, []);
  const blank = [...names];
  let changed = false;
  for (const l of lines) {
    if (l.login && set.has(low(l.login))) { blank.push(l.login, l.name); l.login = null; l.name = "someone"; changed = true; }
  }
  for (const s of set) blank.push(s);
  const red = redactor(blank);
  for (const l of lines) { const t = red(l.text); if (t !== l.text) { l.text = t; changed = true; } }
  if (!changed) return false;
  const removed = parse(row.removed, []).concat([...set].map(hiddenHash));
  await runQuery("UPDATE feed_quotes SET lines = ?, logins = ?, removed = ? WHERE post_id = ?",
                 [JSON.stringify(lines), " " + loginsOf(lines).join(" ") + " ", JSON.stringify([...new Set(removed)]), row.post_id]);
  await runQuery("UPDATE feed_posts SET body = ? WHERE id = ?", [bodyOf(lines), row.post_id]);
  row.lines = JSON.stringify(lines);
  return true;
}

async function linkedLogin(viewer) {
  if (!viewer || !viewer.userId) return null;
  if (viewer.camfrogUsername !== undefined) return low(viewer.camfrogUsername) || null;
  const r = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [viewer.userId]))[0];
  return r && r.camfrogUsername ? low(r.camfrogUsername) : null;
}

/** "Remove me": the viewer's linked login is one of the speakers -> anonymised in this quote. Idempotent. */
async function removeMe(user, postId) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  if (!POST_RE.test(String(postId || ""))) throw new Refuse(404, "No such quote.");
  const row = await rowOf(postId);
  if (!row) throw new Refuse(404, "No such quote.");
  const me = await linkedLogin(user);
  const removedBefore = parse(row.removed, []);
  if (me && removedBefore.includes(hiddenHash(me))) return { removed: true, again: true };
  if (!me || !String(row.logins || "").includes(" " + me + " ")) throw new Refuse(403, "Only people quoted in it can remove themselves.");
  const u = (await getQuery("SELECT username, displayname FROM users WHERE userId = ?", [user.userId]))[0] || {};
  await anonymise(row, [me], { names: [u.displayname, u.username] });
  try {
    if (row.created_by && row.created_by !== user.userId) {
      const S = require("./feedstore");
      await S.notify(row.created_by, { kind: "feed", title: "Someone in your quote removed themselves", body: "One of the people quoted asked to be shown as “someone” — their lines stay, without their name.",
                                       link: await S.postPath(row.post_id).catch(() => "/feed"), ref: "quote-rm:" + row.post_id });
    }
  } catch (e) { /* the notice is a courtesy */ }
  console.log(`[quotes] ${row.post_id}: a speaker removed themselves`);
  return { removed: true, again: false };
}

/** decorate(): post id -> {lines: [{name, text, mic, pepe, ts, me}], speakers, canRemoveMe, removedMe, first, source}. */
async function forPosts(ids, viewer) {
  const out = new Map();
  if (!ids || !ids.length) return out;
  const rows = await getQuery(`SELECT * FROM feed_quotes WHERE post_id IN (${ids.map(() => "?").join(",")})`, ids);
  if (!rows.length) return out;
  const me = await linkedLogin(viewer);
  for (const r of rows) {
    // anyone private since the quote was made: anonymised for good, now
    const lines0 = parse(r.lines, []);
    const gone = loginsOf(lines0).filter(isHidden);
    if (gone.length) { try { await anonymise(r, gone); } catch (e) { /* shown anonymised below anyway */ } }
    const lines = parse(r.lines, []).map((l) => (l.login && isHidden(l.login) ? { ...l, login: null, name: "someone" } : l));
    const removed = parse(r.removed, []);
    out.set(r.post_id, {
      lines: lines.map((l) => ({ name: l.name, text: l.text, mic: l.k === "tx", pepe: !!l.pepe, ts: l.ts, me: !!me && l.login === me })),
      speakers: new Set(lines.map((l) => l.login || "someone:" + l.name)).size,
      canRemoveMe: !!me && lines.some((l) => l.login === me),
      removedMe: !!me && removed.includes(hiddenHash(me)),
      first: lines[0] ? lines[0].text : "", firstName: lines[0] ? lines[0].name : "", source: r.source,
    });
  }
  return out;
}

/** The pad's quote of the day: its best-voted quote (score >= 2) of the last 24 h, else of the last 7 days. */
async function quoteOfDay(roomId, viewer) {
  const S = require("./feedstore");
  for (const top of ["day", "week"]) {
    const L = await S.list({ room: roomId, quotes: true, sort: "top", top, viewer, limit: 1, pins: false });
    const p = (L.posts || [])[0];
    if (p && p.score >= 2 && p.quote) return { post: p, window: top };
  }
  return null;
}

function register(app, { addUser, isBotToken, bySlug }) {
  const json = express.json({ limit: "16kb" });
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message });
    console.error("[quotes]", e);
    res.status(500).json({ ok: false, error: "Something went wrong — nothing was posted." });
  };
  const jsonOnly = (req, res) => {
    if (!req.is("application/json") || req.get("X-Requested-With") !== "fetch") { res.status(400).json({ ok: false, error: "Bad request." }); return false; }
    return true;
  };

  // web: the Live tab's ✂️ Clip chat
  app.post("/api/rooms/:slug/quote", addUser, json, async (req, res) => {
    if (!jsonOnly(req, res)) return;
    try {
      if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in to quote." });
      const B = require("./bridge");
      await (B.load ? B.load() : null);
      const R = bySlug(req.params.slug);
      if (!R) return res.status(404).json({ ok: false, error: "That Camfrog room isn't on PATV right now." });
      const b = req.body || {};
      const got = pick(R.feed, { cs: Array.isArray(b.cs) ? b.cs.slice(0, MAX_LINES + 1) : [] });
      if (got.error) return res.status(400).json({ ok: false, error: got.error });
      const lim = limited("web|" + req.user.userId);
      if (lim) return res.status(429).json({ ok: false, error: lim });
      const r = await create({ authorId: req.user.userId, roomId: R.id, items: got.items, title: b.title, profile: b.profile === true, source: "web" });
      res.json({ ok: true, ...r });
    } catch (e) { fail(res, e); }
  });

  // chat: Pepe's !quote
  app.post("/api/bridge/quote", express.json({ limit: "8kb" }), async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    try {
      const B = require("./bridge");
      await (B.load ? B.load() : null);
      const R = B._rooms.get(String(b.room || ""));
      if (!R) return res.status(404).json({ ok: false, error: "this room isn't on its pad right now (bridge it with !bridge on)" });
      const cf = low(b.camfrog);
      const lim = limited("chat|" + R.id + "|" + (cf || "someone"));
      if (lim) return res.status(429).json({ ok: false, error: lim.replace(/^Slow down — /, "slow down: ") });
      const s = b.spec && typeof b.spec === "object" ? b.spec : {};
      const spec = { mode: String(s.mode || ""), n: Number(s.n) || 0, login: LOGIN_RE.test(low(s.login)) ? low(s.login) : "",
                     user: String(s.user || "").slice(0, 40), from: String(s.from || "").slice(0, PHRASE_MAX), to: String(s.to || "").slice(0, PHRASE_MAX) };
      if (spec.mode === "user" && (isHidden(spec.login) || isHidden(spec.user))) return res.status(400).json({ ok: false, error: "they're private" });
      const got = pick(R.feed, spec, Number(b.before) || null);
      if (got.error) return res.status(400).json({ ok: false, error: got.error });
      // credited to the requester's linked PATV account (never an archived one), else to Pepe
      let author = null;
      if (cf && LOGIN_RE.test(cf) && !isHidden(cf)) {
        const C = (await getQuery("PRAGMA table_info(users)")).some((c) => c.name === "archived_at");
        author = (await getQuery(`SELECT userId FROM users WHERE lower(camfrogUsername) = ? ${C ? "AND archived_at IS NULL" : ""}
                                  ORDER BY CASE WHEN username LIKE 'CF%' THEN 1 ELSE 0 END LIMIT 1`, [cf]))[0] || null;
      }
      const S = require("./feedstore");
      const r = await create({ authorId: author ? author.userId : S.PEPE_ID, roomId: R.id, items: got.items, title: b.title, source: "chat", viaPepe: !author });
      res.json({ ok: true, url: r.post.url, id: r.post.id, lines: r.lines });
    } catch (e) {
      if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message });
      console.error("[quotes] bridge:", e);
      res.status(500).json({ ok: false, error: "the website hit an error" });
    }
  });

  app.post("/api/feed/posts/:id/quote-remove-me", addUser, json, async (req, res) => {
    if (!jsonOnly(req, res)) return;
    try { res.json({ ok: true, ...(await removeMe(req.user, req.params.id)) }); } catch (e) { fail(res, e); }
  });

  // a pad's quotes: /p/<pad>/quotes (top of the week by default, or new) + the quote of the day
  app.get("/p/:slug/quotes", addUser, async (req, res, next) => {
    try {
      const S = require("./feedstore");
      const P = require("./pads");
      const R = (await require("./rooms").bySlug(String(req.params.slug || "").toLowerCase())) || (await require("./roomsweb").resolveRoom(String(req.params.slug || "")).catch(() => null));
      if (!R || (R.profile && R.profile.username)) return next();
      const viewer = req.user && req.user.userId ? await S.account(req.user.userId) : null;
      const q = req.query || {};
      const sort = q.sort === "new" ? "new" : "top";
      const top = S.cleanWindow(q.t, "week");
      const page = Math.max(1, Math.min(200, parseInt(q.p, 10) || 1));
      const L = await S.list({ room: R.id, quotes: true, sort, top, page, viewer, pins: false, sfw: !viewer });
      const qotd = page === 1 ? await quoteOfDay(R.id, viewer).catch(() => null) : null;
      const modRooms = new Set();
      try { if (viewer && (await require("./rooms").canManage(viewer, R.id))) modRooms.add(R.id); } catch (e) { /* none */ }
      res.set("Cache-Control", "private, no-store");
      res.render("quotes", { user: viewer ? viewer.username : null, viewer, pad: { id: R.id, title: R.title, slug: P.padSlug(R), href: P.padHref(R) },
        posts: L.posts, more: L.more, page, sort, top, qotd, fx: require("./feedweb").fx, embeds: require("./stageembed"), host: req.hostname || "publicaccess.tv", modRooms });
    } catch (e) { next(e); }
  });
}

module.exports = { register, pick, buildLines, bodyOf, create, removeMe, anonymise, forPosts, quoteOfDay, setHidden, isHidden, hiddenHash, limited,
  MAX_LINES, SPAN_MAX, Refuse, _setClock, _hits: hits };
