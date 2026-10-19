// 1.99is: site search (search.js) - people, posts, pads.
//   - the FTS5 posts index: kept in sync by triggers (create / edit / delete), healed by the rebuild job, LIKE fallback
//   - visibility: deleted / report-hidden / removed / pending posts, Approved pads (outsiders, signed out), NSFW (never
//     signed out; tagged + blurred signed in), profile posts kept out of All; archived people; a private member's
//     Camfrog name; Approved pads in the pad results; profile pads never
//   - "#tag" searches, relevance / new / top, snippets highlighted and escaped, the JSON API, the rate limit
//   - the page: tabs, avatars + name colours, the navbar's search box (and the navbar fit rules untouched)
//   NODE_PATH=G:/PATV/node_modules node --test test/search.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "search-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
const express = require("express");
const ejs = require("ejs");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const web = require(path.join(repo, "feedweb"));
const S = require(path.join(repo, "search"));
const PA = require(path.join(repo, "padaccess"));
require(path.join(repo, "terms"))._setRequired(false);

const ROOM_B = "plant_based_chatting", ROOM_S = "Secret.Room";
let base, server;
const U = {};
const users = new Map();
const P = {};

async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned, archived_at, avatar)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, ?, '2026-01-01 00:00:00', 0, ?, ?)`,
                 [id, name, extra.display || name, extra.class || "pleb", extra.camfrog === undefined ? name + "cf" : extra.camfrog, extra.level || 5, extra.archived || null, extra.avatar || null]);
  const u = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, u);
  return u;
}
const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {});
async function get(url, u) {
  const r = await fetch(base + url, { headers: H(u), redirect: "manual" });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, text };
}
const resetLimits = () => { if (S.state.lim) for (const k of ["ip:127.0.0.1", "ip:::1", "ip:::ffff:127.0.0.1", ...[...users.keys()].map((id) => "u:" + id)]) S.state.lim.reset(k); };
const titles = (R) => R.posts.map((p) => p.title).sort();

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery(`CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ct TEXT NOT NULL, file TEXT NOT NULL, bytes INTEGER, secs REAL, subject TEXT,
                  by_user TEXT, room TEXT, created INTEGER, expires INTEGER, deleted INTEGER DEFAULT 0)`);
  U.owner = await mkUser("plantowner", { display: "Plant Owner" });
  U.alice = await mkUser("alice", { display: "Alice Greenleaf", avatar: "https://example.com/a.png" });
  U.bob = await mkUser("bob", { display: "Bobby Tables", camfrog: "frogbob" });
  U.priv = await mkUser("quietone", { display: "Quiet One", camfrog: "secretfrogger" });
  U.gone = await mkUser("gonegreen", { display: "Gone Greenleaf", archived: Date.now() });
  U.admin = await mkUser("siteadmin", { class: "Admin" });
  await rooms.init();
  await rooms.setOwner(ROOM_B, "plantowner", "test");
  await rooms.setPage(ROOM_B, { description: "Cuttings, propagation and plant puns" }, "test").catch(() => {});
  await rooms.addRoom(ROOM_S, "Secret Garden", "test");
  await rooms.setOwner(ROOM_S, "plantowner", "test");
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0, comments_per_hour: 1000, report_hide_threshold: 1 }, "test");
  await PA.init();
  await PA.setLevel(U.owner, await rooms.get(ROOM_S), "approved");
  await S.init();
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; res.locals.ogPath = req.originalUrl.split("?")[0]; next(); });
  require(path.join(repo, "pads")).register(app);
  PA.register(app, { addUser });
  web.register(app, { addUser, isBotToken: (x) => x === "bot" });
  S.register(app, { addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  // the corpus
  const mk = async (who, room, title, extra = {}) => (P[title] = await store.create(who.userId, { community: room, title, body: extra.body || "", nsfw: !!extra.nsfw, tags: extra.tags, inAll: extra.inAll }));
  await mk(U.alice, ROOM_B, "Monstera propagation guide", { body: "Cut below the node and keep it in water.", tags: "propagation" });
  await mk(U.bob, ROOM_B, "Cactus care basics", { body: "Water rarely. Monstera people overwater." });
  await mk(U.bob, "patv:lounge", "Spicy monstera pics", { body: "very spicy", nsfw: true });
  await mk(U.owner, ROOM_S, "Secret monstera cutting swap", { body: "members only" });
  await mk(U.alice, ROOM_B, "Deleted monstera post");
  await store.remove(U.alice, P["Deleted monstera post"].id, "oops");
  await mk(U.alice, ROOM_B, "Reported monstera spam");
  await store.report(U.bob, { post: P["Reported monstera spam"].id, reason: "spam" });
  await mk(U.bob, ROOM_B, "Removed monstera rant");
  await store.removeFromRoom(U.owner, P["Removed monstera rant"].id, ROOM_B);
  await mk(U.alice, "u/alice", "Monstera diary on my profile only", { inAll: false });
  await mk(U.alice, "u/alice", "Monstera diary also in all");
  await mk(U.bob, ROOM_B, "Html <b>monstera</b> & \"quotes\"", { body: "<script>alert(1)</script> monstera" });
});
test.after(() => { server.close(); });
test.beforeEach(() => { store._gaps.clear(); resetLimits(); });

test("FTS5 is on, and the triggers keep the posts index in sync (create / edit / delete); the rebuild heals drift", async () => {
  assert.equal(S.state.posts, true, "this sqlite3 build has FTS5");
  const n = async () => (await getQuery("SELECT COUNT(*) AS n FROM search_posts"))[0].n;
  const total = (await getQuery("SELECT COUNT(*) AS n FROM feed_posts"))[0].n;
  assert.equal(await n(), total);
  const x = await store.create(U.alice.userId, { community: ROOM_B, title: "Zanzibar fern", body: "unusual word" });
  assert.equal(await n(), total + 1);
  let R = await S.run("zanzib", U.alice);
  assert.deepEqual(R.posts.map((p) => p.id), [x.id], "prefix match");
  await store.edit(U.alice, x.id, { title: "Quokka fern" });
  assert.equal((await S.run("zanzibar", U.alice)).posts.length, 0, "the old title is gone from the index");
  assert.equal((await S.run("quokka", U.alice)).posts.length, 1);
  await runQuery("DELETE FROM feed_posts WHERE id = ?", [x.id]);
  assert.equal(await n(), total, "a deleted row leaves the index");
  // drift (a restore, a hand edit): the rebuild re-fills it
  await runQuery("DELETE FROM search_posts");
  assert.deepEqual(await S.rebuild(), { posts: total });
  assert.equal(await n(), total);
  assert.deepEqual(await S.rebuild(), { posts: null }, "nothing to do when the counts agree");
  // link cards are searchable through their title / domain
  await runQuery("UPDATE feed_posts SET link_json = ? WHERE id = ?", [JSON.stringify({ url: "https://plants.example/x", domain: "plants.example", title: "Philodendron atlas" }), P["Cactus care basics"].id]);
  assert.deepEqual((await S.run("philodendron", U.alice)).posts.map((p) => p.id), [P["Cactus care basics"].id]);
  await runQuery("UPDATE feed_posts SET link_json = 'not json' WHERE id = ?", [P["Cactus care basics"].id]);   // never breaks the write
  await runQuery("UPDATE feed_posts SET link_json = NULL WHERE id = ?", [P["Cactus care basics"].id]);
});

test("posts: only what the viewer may see - deleted, report-hidden, removed, Approved pads, NSFW, kept out of All", async () => {
  const anon = titles(await S.run("monstera", null, { kind: "posts" }));
  assert.deepEqual(anon, ["Cactus care basics", "Html <b>monstera</b> & \"quotes\"", "Monstera diary also in all", "Monstera propagation guide"].sort());
  const alice = titles(await S.run("monstera", U.alice, { kind: "posts" }));
  assert.ok(alice.includes("Spicy monstera pics"), "signed in: NSFW is listed (blurred)");
  assert.ok(!alice.includes("Secret monstera cutting swap"), "an Approved pad she's outside of");
  assert.ok(!alice.includes("Deleted monstera post"));
  assert.ok(!alice.includes("Reported monstera spam"), "hidden by reports");
  assert.ok(!alice.includes("Removed monstera rant"), "taken out of its only pad");
  assert.ok(!alice.includes("Monstera diary on my profile only"), "kept out of All");
  const owner = titles(await S.run("monstera", U.owner, { kind: "posts" }));
  assert.ok(owner.includes("Secret monstera cutting swap"), "the pad's owner is inside");
  const admin = titles(await S.run("monstera", U.admin, { kind: "posts" }));
  assert.ok(admin.includes("Reported monstera spam"), "staff see report-hidden posts");
  assert.ok(!admin.includes("Deleted monstera post"), "deleted never");
  // relevance: the title hit first; new = newest first; top = score
  const rel = await S.run("propagation", U.alice, { kind: "posts" });
  assert.equal(rel.posts[0].title, "Monstera propagation guide");
  const nw = await S.run("monstera", U.alice, { kind: "posts", sort: "new" });
  const created = nw.posts.map((p) => p.created);
  assert.deepEqual(created, created.slice().sort((a, b) => b - a));
});

test("#tag searches list that tag's posts; pads and people skip it", async () => {
  const R = await S.run("#Propagation", null);
  assert.equal(R.tag, "propagation");
  assert.deepEqual(R.posts.map((p) => p.title), ["Monstera propagation guide"]);
  assert.equal(R.people.length, 0);
  assert.equal(R.pads.length, 0);
});

test("people: username, display name, substring, Camfrog name (unless their room activity is private); archived never", async () => {
  let R = await S.run("greenleaf", null, { kind: "people" });
  assert.deepEqual(R.people.map((u) => u.username), ["alice"], "archived accounts never");
  assert.equal(R.people[0].display, "Alice Greenleaf");
  assert.equal(R.people[0].avatar, "https://example.com/a.png");
  R = await S.run("bob", null, { kind: "people" });
  assert.equal(R.people[0].username, "bob", "exact username first");
  R = await S.run("frogbob", null, { kind: "people" });
  assert.deepEqual(R.people.map((u) => u.username), ["bob"], "by Camfrog name");
  assert.equal(R.people[0].camfrog, "frogbob");
  R = await S.run("secretfrog", null, { kind: "people" });
  assert.deepEqual(R.people.map((u) => u.username), ["quietone"], "public by default");
  // quietone hides his room activity: his Camfrog name is no longer matched nor shown
  const pl = require(path.join(repo, "profilelayout"));
  await pl.save(U.priv.userId, { order: [], hidden: ["analytics"], priv: [] });
  R = await S.run("secretfrog", null, { kind: "people" });
  assert.equal(R.people.length, 0);
  R = await S.run("quiet", null, { kind: "people" });
  assert.deepEqual(R.people.map((u) => u.username), ["quietone"], "still findable by name");
  assert.equal(R.people[0].camfrog, null, "...without the Camfrog name");
  R = await S.run("%", null, { kind: "people" });
  assert.equal(R.people.length, 0, "LIKE wildcards are just characters gone");
});

test("pads: by title, address and description; Approved pads only for insiders; profile pads never", async () => {
  let R = await S.run("propagation puns", null, { kind: "pads" });
  assert.deepEqual(R.pads.map((d) => d.id), [ROOM_B]);
  R = await S.run("secret garden", U.alice, { kind: "pads" });
  assert.equal(R.pads.length, 0);
  R = await S.run("secret garden", U.owner, { kind: "pads" });
  assert.deepEqual(R.pads.map((d) => d.id), [ROOM_S]);
  R = await S.run("alice", U.alice, { kind: "pads" });
  assert.ok(!R.pads.some((d) => /^user:/.test(d.id)), "profile pads never");
});

test("the page: tabs, results with avatars + name styles, highlighted + escaped snippets, NSFW blurred for members", async () => {
  let r = await get("/search");
  assert.equal(r.status, 200);
  // feed.css's .sr is screen-reader-only (1px, clipped) - the page must never carry it
  assert.match(r.text, /<main class="ds-page mid flow fd srch">/);
  assert.doesNotMatch(r.text, /class="(?:[^"]* )?sr(?: [^"]*)?"/);
  assert.doesNotMatch(fs.readFileSync(path.join(repo, "public", "css", "search.css"), "utf8"), /^\.sr[ ,{]/m);
  assert.match(r.text, /<input type="search" name="q" value="" maxlength="100"/);
  assert.match(r.text, /Popular tags/);
  r = await get("/search?q=monstera");
  assert.equal(r.status, 200);
  assert.match(r.text, /class="sr-tab on" href="\/search\?q=monstera" aria-current="page">All/);
  assert.match(r.text, /href="\/search\?q=monstera&amp;type=posts">Posts <span class="sr-n">\d+<\/span>/);
  assert.match(r.text, /<mark>Monstera<\/mark> propagation guide/);
  assert.doesNotMatch(r.text, /<script>alert\(1\)<\/script>/, "post text is escaped");
  assert.match(r.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt; <mark>monstera<\/mark>/);
  assert.match(r.text, /Html &lt;b&gt;<mark>monstera<\/mark>&lt;\/b&gt; &amp; &quot;quotes&quot;/);
  assert.doesNotMatch(r.text, /Spicy monstera/, "no NSFW signed out");
  assert.equal(r.text.includes("X-Robots") , false);
  r = await get("/search?q=monstera&type=posts", U.alice);
  assert.match(r.text, /class="sr-post is-nsfw"/);
  assert.match(r.text, /NSFW — tap to show/);
  r = await get("/search?q=greenleaf&type=people");
  assert.match(r.text, /<span class="av av-ph sr-av"[^>]*>A<img src="https:\/\/example.com\/a.png"/, "the profile photo");
  assert.match(r.text, /<mark>Greenleaf<\/mark>/);
  r = await get("/search?q=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E");
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.text, /<img src=x onerror/);
  assert.match(r.text, /value="&lt;img src=x onerror=alert\(1\)&gt;"/);
  r = await fetch(base + "/search?q=x");
  assert.equal(r.headers.get("x-robots-tag"), "noindex");
  assert.match(r.headers.get("cache-control"), /no-store/);
});

test("the JSON API, and the rate limit (per account / IP)", async () => {
  let r = await get("/api/search?q=monstera", U.alice);
  assert.equal(r.status, 200);
  assert.ok(r.d.posts.length > 0);
  assert.ok(r.d.posts.every((p) => p.url && p.title));
  assert.ok(!r.d.posts.some((p) => /Secret/.test(p.title)));
  for (let i = 0; i < S.LIMIT; i++) assert.equal((await get("/api/search?q=x" + i, U.bob)).status, 200, "within the limit: " + i);
  r = await get("/api/search?q=again", U.bob);
  assert.equal(r.status, 429);
  r = await get("/search?q=again", U.bob);
  assert.equal(r.status, 429);
  assert.match(r.text, /You're searching very fast/);
  r = await get("/search", U.bob);
  assert.equal(r.status, 200, "an empty search page isn't counted");
  r = await get("/api/search?q=monstera", U.alice);
  assert.equal(r.status, 200, "another account isn't affected");
});

test("LIKE fallback when FTS5 is missing", async () => {
  S.state.posts = false;
  try {
    const R = await S.run("propagation guide", U.alice, { kind: "posts" });
    assert.deepEqual(R.posts.map((p) => p.title), ["Monstera propagation guide"]);
  } finally { S.state.posts = true; }
});

test("the navbar: a search box (wide), a button (medium), the menus' search form - and the fit rules are untouched", async () => {
  const html = await ejs.renderFile(path.join(repo, "views", "layout.ejs"), { title: "T", ogPath: "/", user: "someuser" });
  const nav = /<nav class="navbar">[\s\S]*?<\/nav>/.exec(html)[0];
  assert.match(nav, /<form class="nav-search" action="\/search" method="get" role="search">/);
  assert.match(nav, /<a href="\/search" class="nav-sbtn"/);
  assert.equal((nav.match(/class="nav-psearch"/g) || []).length, 2, "More and ☰");
  const src = fs.readFileSync(path.join(repo, "views", "layout.ejs"), "utf8");
  assert.match(src, /@media \(min-width: 1280px\) \{ \.nav-search \{ display: inline-flex; \} \}/);
  assert.match(src, /\.nav-search \{ display: none;/);
  assert.match(src, /\.nav-psearch input \{[^}]*font: 16px/, "16px: no iOS zoom on focus");
});

// 1.99ade: /search?q=<any text> unfurled as "<text> — Search" on our own domain, with a page card of it (and once page cards
// are signed, a signed one): the preview is fixed now; the tab title still says what was searched
test("the search page's link preview never carries the query", async () => {
  const q = "Your PATV account is locked verify now";
  const r = await get("/search?q=" + encodeURIComponent(q));
  assert.equal(r.status, 200);
  const tags = (r.text.match(/<meta (property|name)="(og|twitter):[^"]+" content="[^"]*"|<meta name="description" content="[^"]*"/g) || []).join("\n");
  assert.ok(tags.includes('property="og:title" content="Search · Public Access TV"'), tags);
  assert.ok(!/locked|verify/i.test(tags), "the query is in no preview tag");
  assert.match(tags, /og:image" content="http:\/\/test\/og\/page\.png\?t=Search&amp;e=\d+&amp;s=[A-Za-z0-9_-]{32}"/);
  assert.match(tags, /og:url" content="http:\/\/test\/search"/);
  assert.match(r.text, /<title>Your PATV account is locked verify now — Search<\/title>/, "the tab title is unchanged");
});

// 1.99ade (sweep): an 18+ post's canonical address carried its title (or its first words) in the slug - for crawlers and
// visitors who only get the blurred 18+ card, in og:url and the 301s. Their address has no slug now; members who see it
// (staff here) keep the full one; the public post's address is unchanged.
test("an 18+ post: no title slug in the address a gated visitor gets (301s, og:url); any slug on the right id is left alone", async () => {
  await require(path.join(repo, "creators")).init();
  const p = await store.create(U.bob.userId, { community: ROOM_B, title: "Hot private title words", body: "18+ only" });
  await runQuery("UPDATE feed_posts SET lock_rating = 'r18' WHERE id = ?", [p.id]);
  const full = (await store.get(p.id, U.admin)).url;
  assert.match(full, /\/posts\/[A-Za-z0-9]+\/hot-private-title-words$/, "staff: the full address");
  const gated = (await store.get(p.id, null)).url;
  assert.equal(gated, full.replace(/\/hot-private-title-words$/, ""), "a signed-out visitor: no slug");
  assert.equal(await store.postPath(p.id), gated, "internal links (mentions, notices) use the safe one too");
  const short = await get("/feed/p/" + p.id);
  assert.equal(short.status, 301);
  assert.ok(!/hot-private/.test(String(short.text)) && (await fetch(base + "/feed/p/" + p.id, { redirect: "manual" })).headers.get("location") === gated);
  for (const url of [full, gated]) {
    const r = await get(url);
    assert.equal(r.status, 200, url + " answers the crawler without a redirect");
    // (the sign-in / language links echo the address the visitor came in on - their own; nothing else may carry it)
    const page = r.text.split("next=" + encodeURIComponent(url)).join("next=");
    assert.ok(!/hot-private-title-words|Hot private title words/i.test(page), "the title is nowhere on the gated page: " + url);
    assert.match(r.text, new RegExp(`<meta property="og:url" content="http://test${gated.replace(/\//g, "\\/")}">`));
  }
  const staff = await fetch(base + gated, { headers: { "x-test-user": U.admin.userId }, redirect: "manual" });
  assert.equal(staff.status, 301);
  assert.equal(staff.headers.get("location"), full, "who sees the post gets its full address");
  // a public post is unchanged: its slug, and a wrong slug 301s to it
  const pub = P["Monstera propagation guide"];
  const pu = (await store.get(pub.id, null)).url;
  assert.match(pu, /\/monstera-propagation-guide$/);
  const wrong = await fetch(base + pu.replace(/monstera-propagation-guide$/, "nope"), { redirect: "manual" });
  assert.equal(wrong.status, 301);
  assert.equal(wrong.headers.get("location"), pu);
});

// 1.99ade (sweep): the index holds every post's title + body + link, so a word from a creator-locked post's paid body, or from an
// 18+ post, listed that post (and counted it) for viewers who can't read that text - a yes/no oracle for it
test("search: no matches on text the viewer can't read - a locked post's paid body (title still found), an 18+ post for the unconfirmed", async () => {
  const CR = require(path.join(repo, "creators"));
  await CR.init();
  const lk = await store.create(U.bob.userId, { community: ROOM_B, title: "Greenhouse members diary", body: "the paid part says xylophonia" });
  await runQuery("UPDATE feed_posts SET lock_kind = 'sub', lock_tier = 1 WHERE id = ?", [lk.id]);
  const r18 = await store.create(U.bob.userId, { community: ROOM_B, title: "Steamy quasarine pics", body: "18+ body zephyrion" });
  await runQuery("UPDATE feed_posts SET lock_rating = 'r18' WHERE id = ?", [r18.id]);
  const ids = (R) => R.posts.map((p) => p.id);
  const run = async (q, who) => { resetLimits(); return S.run(q, who, { kind: "posts" }); };
  for (const who of [null, U.alice]) {
    const w = who ? "a member" : "a visitor";
    let R = await run("xylophonia", who);
    assert.deepEqual(ids(R), [], w + ": the paid body never matches");
    assert.equal(R.counts.posts, 0, w + ": nor counts");
    R = await run("greenhouse diary", who);
    assert.deepEqual(ids(R), [lk.id], w + ": a locked post is still found by its (public) title");
    assert.equal(R.posts[0].snip.body, "", "without a body snippet");
    R = await run("greenhouse xylophonia", who);
    assert.deepEqual(ids(R), [], w + ": a title word plus a paid-body word: no");
    for (const q of ["zephyrion", "quasarine"]) assert.deepEqual(ids(await run(q, who)), [], `${w}: an 18+ post (age not confirmed) never matches: ${q}`);
  }
  // whoever may read them: as before
  for (const who of [U.bob, U.admin]) {
    assert.deepEqual(ids(await run("xylophonia", who)), [lk.id], who.username);
    assert.deepEqual(ids(await run("zephyrion", who)), [r18.id], who.username);
  }
  await CR.attestAge(U.alice, true);
  assert.deepEqual(ids(await run("quasarine", U.alice)), [r18.id], "18+ confirmed: the 18+ post by its title");
  assert.deepEqual(ids(await run("zephyrion", U.alice)), [r18.id], "and by its body");
  assert.deepEqual(ids(await run("xylophonia", U.alice)), [], "the lock still applies to them");
  // the LIKE fallback applies the same rule
  S.state.posts = false;
  try {
    assert.deepEqual(ids(await run("xylophonia", null)), []);
    assert.deepEqual(ids(await run("greenhouse diary", null)), [lk.id]);
  } finally { S.state.posts = true; }
});

// 1.99ade (sweep): a post linking a market / pool / poll / bounty / raffle here stored a frozen copy of that page's preview (its
// question and odds) and showed it to every viewer, also after the pad went members-only. 1.99ade: the frozen preview is
// shown, searched and handed to Pepe only while a SIGNED-OUT visitor may see the item - a public one keeps it, as before
test("first-party links: liveRef matches every address the site routes to the item", () => {
  const EC = require(path.join(repo, "embedcards"));
  for (const [u, ref] of [["https://publicaccess.tv/markets/5", "M5"], ["https://www.publicaccess.tv/bounties/BT7/", "BT7"],
                          ["https://staging.publicaccess.tv/polls/poll_ab12", "P:poll_ab12"], ["https://publicaccess.tv/raffles/r3", "R3"],
                          // the spellings Express / parseInt route to the same page (the review's bypasses)
                          ["https://publicaccess.tv/markets/5abc", "M5"], ["https://publicaccess.tv/markets/%35", "M5"], ["https://publicaccess.tv/markets/m05", "M5"],
                          ["https://publicaccess.tv./markets/5", "M5"], ["http://publicaccess.tv:443/markets/5", "M5"], ["https://PUBLICACCESS.TV/MARKETS/5/", "M5"],
                          ["https://user:pw@publicaccess.tv/markets/5", "M5"], ["https://publicaccess.tv/bounties/bt%37x", "BT7"],
                          ["https://publicaccess.tv/x/../markets/5", "M5"], ["https://publicaccess.tv/raffles/%23r3", "R3"], ["https://publicaccess.tv/polls/poll%5Fab", "P:poll_ab"]]) {
    assert.equal(EC.liveRef(u), ref, u);
  }
  for (const u of ["https://publicaccess.tv/u/bob", "https://publicaccess.tv/p/plant", "https://example.com/markets/5", "https://publicaccess.tv.evil.example/markets/5",
                   "https://publicaccess.tv/markets/5/bet", "https://publicaccess.tv/markets/0", "https://publicaccess.tv/markets/abc", "https://publicaccess.tv/polls/a%20b",
                   "https://publicaccess.tv/markets/%E0%A4%A", "ftp://publicaccess.tv/markets/5", "nope"]) {
    assert.equal(EC.liveRef(u), null, u);
  }
});

test("first-party links: a frozen preview shows, is searched and reaches Pepe only while a signed-out visitor may see the item; public ones unchanged", async () => {
  const EC = require(path.join(repo, "embedcards"));
  const markets = require(path.join(repo, "markets"));
  const pepefeed = require(path.join(repo, "pepefeed"));
  const s0 = Math.floor(Date.now() / 1000);
  const mkt = (id, extra) => markets.storeRow(markets.cleanMarket({ id, model: "lmsr", options: ["Yes", "No"], b: 1000, q: { Yes: 0, No: 0 }, volume: 10,
    status: "open", creator: "x", judge: "y", created: s0 - 60, closes: s0 + 3600, room: "", positions: {}, trades: [], history: [], ...extra }));
  await mkt(41, { question: "Quokkas outnumber wombats?" });                              // public
  await mkt(42, { question: "Zanzibarian secret question?", pad: ROOM_S });               // an Approved pad's
  assert.deepEqual([...(await EC.anonMissing(["M41", "M42", "M43"]))].sort(), ["M42", "M43"], "members-only and missing: the same answer");
  const frozen = (url, id, q) => JSON.stringify({ url, domain: "publicaccess.tv", title: `M${id}: ${q}`, description: "Yes 50% · No 50% — volume 10 PAT.", site: "Public Access TV", embed: null });
  const post = async (title, link) => {
    const p = await store.create(U.alice.userId, { community: ROOM_B, title, body: "" });
    await runQuery("UPDATE feed_posts SET link_json = ? WHERE id = ?", [link, p.id]);
    return p.id;
  };
  const pub = await post("Odds talk", frozen("https://publicaccess.tv/markets/41", 41, "Quokkas outnumber wombats?"));
  const hid = await post("Look at this one", frozen("https://PublicAccess.TV.:443/Markets/%34%32abc/", 42, "Zanzibarian secret question?"));   // a variant
  const gone = await post("Old bet", frozen("https://publicaccess.tv/markets/43", 43, "Vanished question?"));
  // shown: the public one as before; the others only their address - for everyone (the address never depends on who asks)
  const P1 = await store.get(pub, null);
  assert.equal(P1.link.title, "M41: Quokkas outnumber wombats?");
  assert.match(P1.link.description, /volume 10 PAT/);
  for (const who of [null, U.owner, U.alice]) {
    for (const id of [hid, gone]) {
      const p = await store.get(id, who);
      assert.equal(p.link.title, "", `${id} as ${who ? who.username : "a visitor"}`);
      assert.equal(p.link.description, "");
      assert.equal(p.link.thumbFile, null);
    }
  }
  const page = await get((await store.get(hid, null)).url);
  assert.equal(page.status, 200);
  assert.ok(!page.text.includes("Zanzibarian"), "nowhere on the post page");
  // searched: the public preview's text still finds its post; a hidden one's frozen text finds nothing (no yes/no oracle)
  const ids = async (q, who) => { resetLimits(); return (await S.run(q, who, { kind: "posts" })).posts.map((p) => p.id); };
  for (const like of [false, true]) {
    S.state.posts = !like;
    try {
      assert.deepEqual(await ids("quokkas", null), [pub], "a public market's preview text, as before" + (like ? " (LIKE)" : ""));
      for (const who of [null, U.owner]) assert.deepEqual(await ids("zanzibarian", who), [], "the members-only market's question" + (like ? " (LIKE)" : ""));
      assert.deepEqual(await ids("vanished", null), [], "a missing market's");
      assert.deepEqual(await ids("look this one", null), [hid], "the post itself is still found by its own words");
    } finally { S.state.posts = true; }
  }
  // Pepe's feed context
  const row = async (id) => (await getQuery("SELECT * FROM feed_posts WHERE id = ?", [id]))[0];
  assert.equal((await pepefeed.postView(await row(hid))).link.title, "");
  assert.equal((await pepefeed.postView(await row(hid))).link.description, "");
  assert.equal((await pepefeed.postView(await row(pub))).link.title, "M41: Quokkas outnumber wombats?");
  // a third-party link's preview is untouched
  const other = await post("Elsewhere", JSON.stringify({ url: "https://example.com/a", domain: "example.com", title: "Example article", description: "About plants", site: "Example", embed: null }));
  assert.equal((await store.get(other, null)).link.title, "Example article");
});

test("first-party links: the composer fetches as before, and a link that lands on one of our hidden items (a redirect) is caught by where it landed", async () => {
  const lp = require(path.join(repo, "linkpreview"));
  const real = lp.preview;
  const seen = [];
  lp.preview = async (url) => {
    seen.push(url);
    const to = url === "https://short.example/hid" ? "https://publicaccess.tv/markets/42" : "https://publicaccess.tv/markets/41";
    return { url: to, domain: "publicaccess.tv", title: to.endsWith("42") ? "M42: Zanzibarian secret question?" : "M41: Quokkas outnumber wombats?",
             description: "odds", site: "Public Access TV", embed: null, image: null };
  };
  try {
    const mk = async (link) => {
      const r = await fetch(base + "/api/feed/posts", { method: "POST", headers: H(U.alice), body: JSON.stringify({ community: ROOM_B, title: "Linked " + link.length, link }) });
      const d = await r.json();
      assert.equal(r.status, 200, JSON.stringify(d));
      return store.get(d.id, null);
    };
    const pub = await mk("https://publicaccess.tv/markets/41");
    assert.equal(pub.link.title, "M41: Quokkas outnumber wombats?", "our public market: its preview, as before (fetched signed out)");
    const hid = await mk("https://short.example/hid");
    assert.equal(hid.link.url, "https://publicaccess.tv/markets/42", "stored at where it landed");
    assert.equal(hid.link.title, "", "a members-only market reached through a redirect: just the address");
    assert.deepEqual(seen, ["https://publicaccess.tv/markets/41", "https://short.example/hid"]);
  } finally { lp.preview = real; }
});

test("a post's link preview image is its own card route, looked up on every draw (no signed address that outlives the post)", async () => {
  const og = require(path.join(repo, "og"));
  const app = express();
  og.register(app);
  const srv = app.listen(0);
  const at = "http://127.0.0.1:" + srv.address().port;
  const png = async (p) => { const r = await fetch(at + p); return { status: r.status, cc: r.headers.get("cache-control"), buf: Buffer.from(await r.arrayBuffer()) }; };
  try {
    const pubP = P["Monstera propagation guide"];
    const page = await get((await store.get(pubP.id, null)).url);
    const m = page.text.match(/<meta property="og:image" content="http:\/\/test(\/og\/post\/[^"?]+\.png\?v=[A-Za-z0-9_-]{8})">/);
    assert.ok(m, "the post page points at /og/post/<id>.png");
    const card = await png(m[1].replace(/&amp;/g, "&"));
    assert.equal(card.status, 200);
    assert.equal(card.cc, "public, max-age=300");
    const plainCard = await png("/og/post/no_such_post.png");
    assert.equal(plainCard.status, 200);
    assert.ok(!card.buf.equals(plainCard.buf), "the title is drawn");
    // members-only (an Approved pad), hidden, deleted, 18+ or missing: the plain "PATV feed" card - the same bytes as a missing id
    og._clearCache();
    const plain2 = (await png("/og/post/no_such_post.png")).buf;
    for (const t of ["Secret monstera cutting swap", "Deleted monstera post"]) {
      assert.ok((await png("/og/post/" + P[t].id + ".png")).buf.equals(plain2), t);
    }
    // the post deleted after its address went around: the card stops drawing its title (no TTL to wait out)
    const p = await store.create(U.bob.userId, { community: ROOM_B, title: "Your PATV account is locked", body: "x" });
    og._clearCache();
    assert.ok(!(await png("/og/post/" + p.id + ".png")).buf.equals(plain2));
    await store.remove(U.bob, p.id, "phishing");
    og._clearCache();
    assert.ok((await png("/og/post/" + p.id + ".png")).buf.equals(plain2), "deleted: the plain card");
  } finally { srv.close(); }
});

test("the feed's ?tag= page: a fixed link preview (the tag is in the tab title, never in og tags)", async () => {
  const r = await get("/feed?tag=propagation");
  assert.equal(r.status, 200);
  const tags = (r.text.match(/<meta (property|name)="(og|twitter):[^"]+" content="[^"]*"/g) || []).join("\n");
  assert.ok(tags.includes('property="og:title" content="Tagged posts · Public Access TV"'), tags);
  assert.ok(!/propagation/i.test(tags), "the tag is in no preview tag");
  assert.match(tags, /og:image" content="http:\/\/test\/og\/page\.png\?t=Tagged%20posts&amp;e=\d+&amp;s=[A-Za-z0-9_-]{32}"/);
  assert.match(r.text, /<title>#propagation — /, "the tab title is unchanged");
});
