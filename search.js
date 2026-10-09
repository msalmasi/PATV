// search.js — site search: people, posts and pads (1.99is). /search (the page, tabs All / People / Posts / Pads),
// /api/search (the same as JSON), and the navbar's search box (views/layout.ejs).
//
// Index: SQLite FTS5 when this build has it (it does - node sqlite3 bundles SQLite with FTS5):
//   search_posts  fts5(post_id UNINDEXED, title, body, extra)   unicode61 (diacritics folded); extra = the link card's
//                 title + domain. Kept in sync by triggers on feed_posts (insert / update of title, body, link_json /
//                 delete); every post row is indexed, crossposts too (their own title) - visibility is decided at
//                 query time, never by the index.
// A rebuild job re-fills it when its row count drifts from feed_posts (at start, then every REBUILD_MS) - so a missed
// trigger, a restore or a hand edit heals by itself. Before the triggers are made, a self-test writes and removes a row;
// if FTS5 isn't there, NO trigger is made and posts fall back to LIKE over feed_posts, so a missing feature can never
// break posting. (The tokenizer is unicode61, which the VPS's own sqlite3 CLI (3.31) also has - a hand edit of
// feed_posts from the CLI still works.)
// People are a LIKE scan over users (username, display name, linked Camfrog name - substring, case-insensitive): the
// users table is written by several processes and tools, and substring matching on names needs FTS5's trigram
// tokenizer, which the VPS's sqlite3 CLI (3.31) lacks - a trigger needing it would break any hand edit of users. At
// ~1-2k accounts the scan costs well under a millisecond; revisit (trigram + triggers) if it grows past ~100k.
//
// Visibility - the same rules as the feed, applied to every result:
//   posts   feedstore.list's All scope (by id): deleted never; report-hidden only for staff; a post shows only through a
//           live placement (not removed / pending / owner-hidden, author not banned there) in a pad the viewer can see
//           (Approved pads they're outside of never count - padaccess.blockedFor); a profile post its owner kept out
//           of All stays out; signed-out visitors never get NSFW posts; signed-in members get them blurred (the
//           feed's "always show" choice, localStorage patvFeedNsfw, lifts the blur).
//   people  archived accounts never; a linked Camfrog name is matched / shown only for people whose profile doesn't hide
//           their room activity (stories.privateLogins - the same rule as captures; Pepe never sends !incognito /
//           !bridge hide people by name anyway). Usernames and display names are public on every profile already.
//   pads    feedstore.communities (profile pads never; Approved pads only for the people inside them).
// Rate limited per account (or IP when signed out): LIMIT searches a minute.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const KINDS = Object.freeze(["all", "people", "posts", "pads"]);
const SORTS = Object.freeze(["relevance", "new", "top"]);
const Q_MAX = 100, TERMS_MAX = 8, CANDIDATES = 400, PEOPLE_MAX = 100, PAGE = 20, PREVIEW = { people: 6, pads: 6, posts: 8 };
const LIMIT = 30, REBUILD_MS = 6 * 3600e3;
let NOW = () => Date.now();

const state = { posts: false, json: false, ready: null, lastCheck: 0 };
const isStaff = (u) => !!u && (u.class === "Admin" || u.class === "Staff");

// ── the index ──
async function userCols() { return new Set((await getQuery("PRAGMA table_info(users)").catch(() => [])).map((c) => c.name)); }
async function tableExists(name) { return (await getQuery("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?", [name])).length > 0; }
const linkExpr = (row) => (state.json
  ? `CASE WHEN json_valid(${row}.link_json) THEN COALESCE(json_extract(${row}.link_json, '$.title'), '') || ' ' || COALESCE(json_extract(${row}.link_json, '$.domain'), '') ELSE '' END`
  : "''");

async function setupPosts() {
  try {
    await runQuery("CREATE VIRTUAL TABLE IF NOT EXISTS search_posts USING fts5(post_id UNINDEXED, title, body, extra, tokenize = 'unicode61 remove_diacritics 2')");
    // self-test before any trigger depends on it
    await runQuery("INSERT INTO search_posts (post_id, title, body, extra) VALUES ('__selftest__', 'x', 'y', 'z')");
    await getQuery("SELECT post_id FROM search_posts WHERE search_posts MATCH '\"y\"*' LIMIT 1");
    await runQuery("DELETE FROM search_posts WHERE post_id = '__selftest__'");
  } catch (e) {
    console.error("[search] FTS5 for posts unavailable - LIKE fallback:", e.message);
    for (const t of ["search_posts_ai", "search_posts_au", "search_posts_ad"]) await runQuery(`DROP TRIGGER IF EXISTS ${t}`).catch(() => {});
    state.posts = false;
    return;
  }
  const ins = (row) => `INSERT INTO search_posts (post_id, title, body, extra) VALUES (${row}.id, COALESCE(${row}.title, ''), COALESCE(${row}.body, ''), ${linkExpr(row)});`;
  // re-made every start (DROP + CREATE) so a JSON1 change or a fix to the expression always takes
  await runQuery("DROP TRIGGER IF EXISTS search_posts_ai");
  await runQuery("DROP TRIGGER IF EXISTS search_posts_au");
  await runQuery("DROP TRIGGER IF EXISTS search_posts_ad");
  await runQuery(`CREATE TRIGGER search_posts_ai AFTER INSERT ON feed_posts BEGIN ${ins("NEW")} END`);
  await runQuery(`CREATE TRIGGER search_posts_au AFTER UPDATE OF title, body, link_json ON feed_posts BEGIN
                    DELETE FROM search_posts WHERE post_id = OLD.id; ${ins("NEW")} END`);
  await runQuery("CREATE TRIGGER search_posts_ad AFTER DELETE ON feed_posts BEGIN DELETE FROM search_posts WHERE post_id = OLD.id; END");
  state.posts = true;
}
/** Re-fill the posts index when its row count drifted from feed_posts (or `force`). -> {posts: rows written | null = untouched} */
async function rebuild({ force = false } = {}) {
  const out = { posts: null };
  if (state.posts && (await tableExists("feed_posts"))) {
    const a = (await getQuery("SELECT COUNT(*) AS n FROM feed_posts"))[0].n, b = (await getQuery("SELECT COUNT(*) AS n FROM search_posts"))[0].n;
    if (force || a !== b) {
      await runQuery("DELETE FROM search_posts");
      await runQuery(`INSERT INTO search_posts (post_id, title, body, extra) SELECT p.id, COALESCE(p.title, ''), COALESCE(p.body, ''), ${linkExpr("p")} FROM feed_posts p`);
      out.posts = a;
    }
  }
  state.lastCheck = NOW();
  if (out.posts !== null) console.log(`[search] index rebuilt: ${out.posts} posts`);
  return out;
}
function init() {
  if (!state.ready) {
    state.ready = (async () => {
      await require("./feedstore").init();          // feed_posts exists (and its columns) before the triggers
      try { await getQuery("SELECT json_valid('{}') AS ok"); state.json = true; } catch (e) { state.json = false; }
      await setupPosts();
      await rebuild();
    })().catch((e) => { console.error("[search] init:", e.message); state.ready = null; throw e; });
  }
  return state.ready;
}
async function maybeRebuild() {
  if (NOW() - state.lastCheck > REBUILD_MS) { state.lastCheck = NOW(); rebuild().catch((e) => console.error("[search] rebuild:", e.message)); }
}

// ── the query ──
const CTRL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;
/** What was typed -> {q (cleaned, shown back), terms (word pieces), tag (a "#tag" search) } */
function parse(raw) {
  const q = String(raw == null ? "" : raw).normalize("NFKC").replace(CTRL, " ").replace(/\s+/g, " ").trim().slice(0, Q_MAX);
  const terms = [...new Set((q.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []))].slice(0, TERMS_MAX);
  const m = /^#(\S+)$/.exec(q);
  const tag = m ? require("./feedtags").normTag(m[1]) : null;
  return { q, terms, tag };
}
const ftsQuery = (terms) => terms.map((t) => '"' + t.replace(/"/g, '""') + '"*').join(" ");
const likeTerm = (t) => "%" + String(t).replace(/[%_\\]/g, "") + "%";

/** Post ids matching `terms`, best first, with a highlighted snippet per id. -> {ids: [...], snip: Map(id -> {title, body})} */
async function postHits(terms) {
  const snip = new Map();
  if (!terms.length) return { ids: [], snip };
  if (state.posts) {
    const rows = await getQuery(`SELECT post_id, bm25(search_posts, 0.0, 6.0, 1.0, 2.0) AS r,
                                   snippet(search_posts, 1, char(1), char(2), '…', 12) AS st, snippet(search_posts, 2, char(1), char(2), '…', 16) AS sb
                                 FROM search_posts WHERE search_posts MATCH ? ORDER BY r LIMIT ?`, [ftsQuery(terms), CANDIDATES]);
    for (const r of rows) snip.set(r.post_id, { title: r.st || "", body: r.sb || "" });
    return { ids: rows.map((r) => r.post_id), snip };
  }
  // fallback: every term somewhere in the title, body or link
  const where = terms.map(() => "(p.title LIKE ? OR p.body LIKE ? OR p.link_json LIKE ?)").join(" AND ");
  const args = terms.flatMap((t) => [likeTerm(t), likeTerm(t), likeTerm(t)]);
  const rows = await getQuery(`SELECT p.id FROM feed_posts p WHERE p.deleted_at IS NULL AND ${where} ORDER BY p.created DESC LIMIT ?`, [...args, CANDIDATES]);
  return { ids: rows.map((r) => r.id), snip };
}

/** People: archived never; a Camfrog-name match only for people who don't hide their room activity. */
async function people(p, viewer, limit = PEOPLE_MAX) {
  if (!p.terms.length && !p.q) return [];
  const needle = p.q.replace(/^@/, "").replace(/^u\//i, "").trim();
  if (!needle || needle.length > 64) return [];
  const C = await userCols();
  const live = C.has("archived_at") ? "u.archived_at IS NULL" : "1 = 1";
  const pat = likeTerm(needle);
  const cols = ["u.username"].concat(C.has("displayname") ? ["u.displayname"] : [], C.has("camfrogUsername") ? ["u.camfrogUsername"] : []);
  const rows = await getQuery(`SELECT u.userId, u.username, ${C.has("displayname") ? "u.displayname" : "NULL AS displayname"}, ${C.has("camfrogUsername") ? "u.camfrogUsername" : "NULL AS camfrogUsername"},
                                 ${C.has("level") ? "u.level" : "0 AS level"}, ${C.has("avatar") ? "u.avatar" : "NULL AS avatar"}
                               FROM users u WHERE (${cols.map((c) => `${c} LIKE ?`).join(" OR ")}) AND ${live} LIMIT 400`, cols.map(() => pat));
  const n = needle.toLowerCase();
  const has = (s) => String(s || "").toLowerCase().includes(n);
  // a Camfrog-only match needs that person's room activity to be public (stories.privateLogins)
  const cfOnly = rows.filter((r) => !has(r.username) && !has(r.displayname) && has(r.camfrogUsername)).map((r) => r.camfrogUsername);
  const shownCf = rows.filter((r) => r.camfrogUsername).map((r) => r.camfrogUsername);
  let priv = new Set();
  try { priv = await require("./stories").privateLogins([...new Set(cfOnly.concat(shownCf))]); } catch (e) { priv = new Set(cfOnly.map((x) => String(x).toLowerCase())); }
  const isPriv = (r) => !!r.camfrogUsername && priv.has(String(r.camfrogUsername).toLowerCase());
  const auto = (r) => /^CF[a-z0-9]{8}$/.test(String(r.username));
  const rank = (r) => {
    const u = String(r.username || "").toLowerCase(), d = String(r.displayname || "").toLowerCase();
    if (u === n || d === n) return 0;
    if (u.startsWith(n) || d.startsWith(n)) return 1;
    if (has(u) || has(d)) return 2;
    return 3;                                         // their Camfrog name
  };
  const kept = rows.filter((r) => rank(r) < 3 || !isPriv(r))
    .sort((a, b) => rank(a) - rank(b) || auto(a) - auto(b) || (Number(b.level) || 0) - (Number(a.level) || 0) || String(a.username).localeCompare(String(b.username)))
    .slice(0, limit);
  const UL = require("./userlook");
  const look = await UL.looks({ ids: kept.map((r) => r.userId) });
  const PEPE = require("./feedstore").PEPE_ID;
  return kept.map((r) => {
    const L = look.get(String(r.userId)) || {};
    const bot = r.userId === PEPE;
    return { userId: r.userId, username: r.username, display: r.displayname || r.username, level: Number(r.level) || 0, bot,
             avatar: bot ? null : L.avatar || null, nameCss: bot ? "" : L.nameCss || "",
             camfrog: r.camfrogUsername && !isPriv(r) ? r.camfrogUsername : null, href: "/u/" + encodeURIComponent(r.username) };
  });
}

/** Pads the viewer can see whose title / address / description holds every term. */
async function pads(p, viewer) {
  if (!p.terms.length) return [];
  const list = await require("./feedstore").communities(viewer);
  const n = p.terms.join(" ");
  const score = (c) => {
    const t = String(c.title || "").toLowerCase(), s = String(c.slug || "").toLowerCase();
    if (t === n || s === n) return 0;
    if (t.startsWith(p.terms[0]) || s.startsWith(p.terms[0])) return 1;
    return 2;
  };
  return list.filter((c) => {
    const hay = (String(c.title || "") + " " + String(c.slug || "") + " " + String(c.description || "")).toLowerCase();
    return p.terms.every((t) => hay.includes(t));
  }).sort((a, b) => score(a) - score(b) || b.followers - a.followers || b.posts - a.posts)
    .map((c) => ({ id: c.id, slug: c.slug, title: c.title, description: c.description || "", followers: c.followers, posts: c.posts, community: c.community,
                   house: c.house, platform: c.platform, href: require("./pads").padHref(c) }));
}

/**
 * Posts the viewer may see. sort: relevance (the index's rank) | new | top. A "#tag" query lists that tag's posts.
 * -> {posts (decorated, with .snip), total (visible matches, up to CANDIDATES), more, page}
 */
async function posts(p, viewer, { sort = "relevance", page = 1, limit = PAGE } = {}) {
  const store = require("./feedstore");
  const signed = !!(viewer && viewer.userId);
  const base = { viewer: signed ? viewer : null, sfw: !signed, pins: false };
  page = Math.max(1, Math.min(20, Math.floor(Number(page)) || 1));
  if (p.tag) {
    const L = await store.list({ ...base, tag: p.tag, sort: sort === "top" ? "top" : "new", top: "all", page, limit });
    const n = await store.list({ ...base, tag: p.tag, sort: "new", idsOnly: true, limit: CANDIDATES });
    return { posts: L.posts, total: n.ids.length, more: L.more, page };
  }
  const H = await postHits(p.terms);
  if (!H.ids.length) return { posts: [], total: 0, more: false, page };
  const order = sort === "new" ? "new" : sort === "top" ? "top" : "new";
  const vis = await store.list({ ...base, ids: H.ids, idsOnly: true, sort: order, top: "all", limit: CANDIDATES });
  let ids = vis.ids;
  if (sort === "relevance") { const rank = new Map(H.ids.map((id, i) => [id, i])); ids = ids.slice().sort((a, b) => rank.get(a) - rank.get(b)); }
  const pageIds = ids.slice((page - 1) * limit, page * limit);
  const L = pageIds.length ? await store.list({ ...base, ids: pageIds, sort: "new", top: "all", limit: pageIds.length }) : { posts: [] };
  const byId = new Map(L.posts.map((x) => [x.id, x]));
  const out = pageIds.map((id) => byId.get(id)).filter(Boolean);
  for (const x of out) x.snip = H.snip.get(x.id) || null;
  return { posts: out, total: ids.length, more: ids.length > page * limit, page };
}

/** Everything for one search. kind: all | people | posts | pads */
async function run(raw, viewer, { kind = "all", sort = "relevance", page = 1 } = {}) {
  await init();
  maybeRebuild();
  const p = parse(raw);
  const k = KINDS.includes(kind) ? kind : "all";
  const s = SORTS.includes(sort) ? sort : "relevance";
  const out = { q: p.q, tag: p.tag, kind: k, sort: s, page: 1, people: [], posts: [], pads: [], counts: { people: 0, posts: 0, pads: 0 }, more: false };
  if (!p.q || (!p.terms.length && !p.tag)) return out;
  const wantPeople = !p.tag && (k === "all" || k === "people");
  const wantPads = !p.tag && (k === "all" || k === "pads");
  const [P, D, T] = await Promise.all([
    wantPeople ? people(p, viewer) : [],
    wantPads ? pads(p, viewer) : [],
    k === "all" || k === "posts" ? posts(p, viewer, { sort: s, page: k === "posts" ? page : 1, limit: k === "posts" ? PAGE : PREVIEW.posts }) : { posts: [], total: 0, more: false, page: 1 },
  ]);
  out.counts = { people: P.length, pads: D.length, posts: T.total };
  out.people = k === "all" ? P.slice(0, PREVIEW.people) : P;
  out.pads = k === "all" ? D.slice(0, PREVIEW.pads) : D;
  out.posts = T.posts;
  out.page = T.page;
  out.more = k === "posts" ? T.more : false;
  return out;
}

// ── rendering helpers ──
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);
/** An FTS snippet (markers \u0001 / \u0002 around the hits) -> escaped HTML with <mark>s. */
function snippetHtml(s) {
  const parts = String(s || "").split(/([\u0001\u0002])/);
  let open = false, out = "";
  for (const x of parts) {
    if (x === "\u0001") { if (!open) { out += "<mark>"; open = true; } }
    else if (x === "\u0002") { if (open) { out += "</mark>"; open = false; } }
    else out += esc(x);
  }
  return open ? out + "</mark>" : out;
}
/** Highlight the query's terms in plain text (people / pads) - escaped. */
function highlight(text, terms) {
  const s = String(text == null ? "" : text);
  if (!terms || !terms.length) return esc(s);
  const low = s.toLowerCase();
  const marks = new Array(s.length).fill(false);
  for (const t of terms) {
    if (!t) continue;
    let i = low.indexOf(t);
    while (i >= 0) { for (let j = i; j < i + t.length && j < s.length; j++) marks[j] = true; i = low.indexOf(t, i + t.length); }
  }
  let out = "", on = false;
  for (let i = 0; i < s.length; i++) {
    if (marks[i] && !on) { out += "<mark>"; on = true; }
    if (!marks[i] && on) { out += "</mark>"; on = false; }
    out += esc(s[i]);
  }
  return on ? out + "</mark>" : out;
}
function searchUrl({ q, kind = "all", sort = "relevance", page = 1 } = {}) {
  const qs = new URLSearchParams();
  if (q) qs.set("q", q);
  if (kind && kind !== "all") qs.set("type", kind);
  if (sort && sort !== "relevance") qs.set("sort", sort);
  if (page > 1) qs.set("p", String(page));
  const s = qs.toString();
  return "/search" + (s ? "?" + s : "");
}

// ── routes ──
function register(app, { addUser }) {
  init().catch(() => {});
  const guard = require("./middleware/authGuard");
  const lim = guard.limiter({ max: LIMIT, windowMs: 60e3 });
  state.lim = lim;                                   // tests reset it
  const keyOf = (req) => (req.user && req.user.userId ? "u:" + req.user.userId : "ip:" + guard.clientIp(req));
  const viewerOf = async (req) => (req.user && req.user.userId ? require("./feedstore").account(req.user.userId) : null);
  const params = (req) => {
    const q = req.query || {};
    const one = (v) => (Array.isArray(v) ? v[0] : v);
    return { raw: String(one(q.q) || "").slice(0, 400), kind: String(one(q.type) || "all"), sort: String(one(q.sort) || "relevance"),
             page: Math.max(1, Math.min(20, parseInt(one(q.p), 10) || 1)) };
  };
  const tooFast = (req) => {
    const k = keyOf(req);
    const wait = lim.blocked(k);
    if (wait) return wait;
    lim.hit(k);
    return 0;
  };

  app.get("/search", addUser, async (req, res) => {
    res.set({ "X-Robots-Tag": "noindex", "Cache-Control": "private, no-store" });
    try {
      const a = params(req);
      const viewer = await viewerOf(req);
      const fx = require("./feedweb").fx;
      let R = null, wait = 0;
      const p = parse(a.raw);
      if (p.q) { wait = tooFast(req); if (!wait) R = await run(a.raw, viewer, a); }
      const popular = !p.q ? await require("./feedtags").popular(null, { viewer, limit: 12 }).catch(() => []) : [];
      res.status(wait ? 429 : 200).render("search", {
        user: viewer ? viewer.username : null, viewer, fx, R, q: p.q, kind: KINDS.includes(a.kind) ? a.kind : "all", sort: SORTS.includes(a.sort) ? a.sort : "relevance",
        wait, popular, url: searchUrl, snippetHtml, highlight, terms: p.terms, signed: !!viewer, thumbOf: require("./feedstore").thumbOf,
        title: p.q ? `${p.q} — Search` : "Search",
      });
    } catch (e) {
      console.error("[search] page:", e);
      res.status(500).send("Something went wrong.");
    }
  });

  // the same as JSON (no NSFW post text for anyone signed out - they never get NSFW posts at all)
  app.get("/api/search", addUser, async (req, res) => {
    res.set({ "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" });
    try {
      const a = params(req);
      const wait = tooFast(req);
      if (wait) return res.status(429).json({ ok: false, error: `Slow down - try again in ${wait}s.`, retryAfter: wait });
      const viewer = await viewerOf(req);
      const R = await run(a.raw, viewer, a);
      const PL = require("./postlabel");
      res.json({ ok: true, q: R.q, tag: R.tag, type: R.kind, sort: R.sort, page: R.page, more: R.more, counts: R.counts,
        people: R.people.map((u) => ({ username: u.username, display: u.display, avatar: u.avatar, camfrog: u.camfrog, href: u.href, bot: u.bot })),
        pads: R.pads.map((d) => ({ slug: d.slug, title: d.title, description: d.description, followers: d.followers, posts: d.posts, href: d.href })),
        posts: R.posts.map((x) => ({ id: x.id, url: x.url, title: PL.labelOf(x).text, nsfw: !!x.nsfw, created: x.created, score: x.score, comments: x.comments,
                                     pad: x.rooms[0] ? x.rooms[0].label : null, author: x.author ? { username: x.author.username, display: x.author.display } : null })) });
    } catch (e) {
      console.error("[search] api:", e);
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });
  const t = setInterval(() => maybeRebuild(), 30 * 60e3);
  if (t.unref) t.unref();
}

module.exports = { init, register, run, parse, people, pads, posts, rebuild, snippetHtml, highlight, searchUrl, ftsQuery, KINDS, SORTS, LIMIT,
                   state, _setClock: (fn) => { NOW = fn || (() => Date.now()); } };
