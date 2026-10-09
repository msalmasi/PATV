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
