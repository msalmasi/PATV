// 1.99iq: content tags on feed posts (feedtags.js).
//   - normalising + parsing (the composer's free text), the per-post cap
//   - posting / editing with tags, a crosspost starting with its original's tags
//   - ?tag= filtering: /feed (All), a pad page's Feed, store.list; the tag bar + popular tags; shareable links
//   - a pad mod removes a tag (the author can't put it back), a stranger can't, the audit log records it
//   - popular tags never count posts in an Approved pad the viewer is outside of
//   NODE_PATH=G:/PATV/node_modules node --test test/feed-tags.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "feed-tags-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const web = require(path.join(repo, "feedweb"));
const TG = require(path.join(repo, "feedtags"));
const PA = require(path.join(repo, "padaccess"));
require(path.join(repo, "terms"))._setRequired(false);

const ROOM_B = "plant_based_chatting", ROOM_S = "Secret.Room";
let base, server;
const U = {};
const users = new Map();

async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, 5, '2026-01-01 00:00:00', 0)`, [id, name, name, extra.class || "pleb", name + "cf"]);
  const u = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, u);
  return u;
}
const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {});
async function call(method, url, u, body) {
  const r = await fetch(base + url, { method, headers: H(u), body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, text };
}
const get = (url, u) => call("GET", url, u);
const post = (url, u, body) => call("POST", url, u, body);

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery(`CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ct TEXT NOT NULL, file TEXT NOT NULL, bytes INTEGER, secs REAL, subject TEXT,
                  by_user TEXT, room TEXT, created INTEGER, expires INTEGER, deleted INTEGER DEFAULT 0)`);
  U.owner = await mkUser("plantowner");
  U.alice = await mkUser("alice");
  U.bob = await mkUser("bob");
  U.admin = await mkUser("siteadmin", { class: "Admin" });
  await rooms.init();
  await rooms.setOwner(ROOM_B, "plantowner", "test");
  await rooms.addRoom(ROOM_S, "Secret", "test");
  await rooms.setOwner(ROOM_S, "plantowner", "test");
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0, comments_per_hour: 1000 }, "test");
  await PA.init();
  await PA.setLevel(U.owner, await rooms.get(ROOM_S), "approved");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; res.locals.ogPath = req.originalUrl.split("?")[0]; next(); });
  require(path.join(repo, "pads")).register(app);
  PA.register(app, { addUser });
  web.register(app, { addUser, isBotToken: (x) => x === "bot" });
  TG.register(app, { addUser });
  require(path.join(repo, "bridge")).register(app, { addUser, isBotToken: (x) => x === "bot" });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });
test.beforeEach(() => { store._gaps.clear(); });

test("normTag / parseTags: lowercase, # and spaces, unicode letters, length limits, the per-post cap", () => {
  assert.equal(TG.normTag("#Plant Care"), "plant-care");
  assert.equal(TG.normTag("  ##DIY__tips "), "diy-tips");
  assert.equal(TG.normTag("Café"), "café");
  assert.equal(TG.normTag("<script>"), "script");
  assert.equal(TG.normTag("a"), null, "too short");
  assert.equal(TG.normTag("!!"), null);
  assert.equal(TG.normTag("x".repeat(60)).length, TG.TAG_MAX, "cut to the max");
  assert.deepEqual(TG.parseTags("plants music"), ["plants", "music"]);
  assert.deepEqual(TG.parseTags("plant care, DIY, #diy"), ["plant-care", "diy"], "commas keep phrases; duplicates go");
  assert.deepEqual(TG.parseTags(["#A1", "a1", "b2"]), ["a1", "b2"]);
  assert.deepEqual(TG.parseTags(""), []);
  assert.deepEqual(TG.parseTags(undefined), []);
  assert.throws(() => TG.parseTags("a1 b2 c3 d4 e5 f6"), /Up to 5 tags/);
});

let P1, P2, P3;
test("posting with tags stores them normalised; decorate shows them; too many is refused before anything is made", async () => {
  P1 = await store.create(U.alice.userId, { community: ROOM_B, title: "Monstera help", body: "leaves going yellow", tags: "Plant Care, monstera" });
  assert.deepEqual(P1.tags, ["plant-care", "monstera"]);
  P2 = await store.create(U.bob.userId, { community: ROOM_B, title: "My cactus", tags: ["cactus", "plant care"] });
  P3 = await store.create(U.bob.userId, { community: "patv:lounge", title: "Lounge chat about plants", tags: "plant-care" });
  const before = (await getQuery("SELECT COUNT(*) AS n FROM feed_posts"))[0].n;
  await assert.rejects(store.create(U.alice.userId, { community: ROOM_B, title: "x", tags: "a1 b2 c3 d4 e5 f6" }), /Up to 5 tags/);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM feed_posts"))[0].n, before, "nothing made");
  // over HTTP too (the composer sends a string)
  const r = await post("/api/feed/posts", U.alice, { community: ROOM_B, title: "via http", tags: "#Http-Test" });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual((await store.get(r.d.id, null)).tags, ["http-test"]);
});

test("store.list({tag}) filters every scope; an unknown tag is empty", async () => {
  const ids = (L) => L.posts.map((p) => p.id).sort();
  assert.deepEqual(ids(await store.list({ tag: "plant-care", viewer: U.alice })), [P1.id, P2.id, P3.id].sort());
  assert.deepEqual(ids(await store.list({ room: ROOM_B, tag: "plant-care", viewer: U.alice })), [P1.id, P2.id].sort());
  assert.deepEqual(ids(await store.list({ room: ROOM_B, tag: "cactus" })), [P2.id]);
  assert.deepEqual(ids(await store.list({ author: U.bob.userId, tag: "plant-care" })), [P2.id, P3.id].sort());
  assert.deepEqual(ids(await store.list({ tag: "nope" })), []);
});

test("/feed?tag= and the pad page ?tag= show only tagged posts, with the tag bar and shareable links", async () => {
  let r = await get("/feed?tag=Plant%20Care");
  assert.equal(r.status, 200);
  assert.match(r.text, /Tagged <b class="ftag on">#plant-care<\/b>/);
  assert.ok(r.text.includes("Monstera help") && r.text.includes("My cactus") && r.text.includes("Lounge chat about plants"));
  assert.ok(!r.text.includes("via http"), "untagged-for-this posts left out");
  assert.match(r.text, /<title>#plant-care — All — feed<\/title>/);
  // the sort links keep the tag
  assert.match(r.text, /href="\/feed\?sort=new&amp;tag=plant-care"/);
  // tag chips on a post in All go to /feed?tag=
  assert.match(r.text, /class="ftag" href="\/feed\?tag=monstera"/);
  // without a filter: popular tags on All
  r = await get("/feed");
  assert.match(r.text, /Popular tags/);
  assert.match(r.text, /href="\/feed\?tag=plant-care"[^>]*>#plant-care</);
  // the pad page: only this pad's tagged posts; chips stay in the pad
  const slug = rooms.getCached(ROOM_B).slug;
  r = await get("/p/" + slug + "?tag=cactus", U.alice);
  assert.equal(r.status, 200);
  assert.ok(r.text.includes("My cactus"));
  assert.ok(!r.text.includes("Monstera help"));
  assert.ok(r.text.includes('href="/p/' + slug + "?tag=monstera#feed") === false, "Monstera isn't on this page");
  assert.ok(r.text.includes('class="ftag" href="/p/' + slug + '?tag=cactus#feed"'), "a pad feed's chips filter that pad");
  r = await get("/p/" + slug, U.alice);
  assert.match(r.text, /Popular tags/);
  assert.ok(r.text.includes("?tag=plant-care#feed"));
});

test("editing replaces the tags; the composer and the edit form carry a tag box", async () => {
  let r = await post("/api/feed/posts/" + P1.id + "/edit", U.alice, { tags: "monstera, yellow leaves" });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual((await store.get(P1.id, null)).tags, ["monstera", "yellow-leaves"]);
  r = await post("/api/feed/posts/" + P1.id + "/edit", U.alice, { tags: "a1 b2 c3 d4 e5 f6" });
  assert.equal(r.status, 400);
  r = await post("/api/feed/posts/" + P1.id + "/edit", U.bob, { tags: "hijack" });
  assert.equal(r.status, 403, "only the author edits");
  const page = await get("/feed", U.alice);
  assert.match(page.text, /<input name="tags" maxlength="200" placeholder="Tags \(optional\)/);
  assert.match(page.text, /data-tag-suggest="/);
  assert.match(page.text, /feed-tags\.js\?v=1/);
  assert.match(page.text, /<input name="tags" maxlength="200" value="monstera, yellow-leaves"/, "the author's edit form");
});

test("a pad mod removes a tag (audit-logged, the author can't re-add it); strangers can't; staff can anywhere", async () => {
  let r = await post("/api/feed/posts/" + P2.id + "/tags/remove", U.alice, { tag: "cactus" });
  assert.equal(r.status, 403, "not a mod of p/" + ROOM_B);
  r = await post("/api/feed/posts/" + P2.id + "/tags/remove", U.owner, { tag: "#Cactus", room: rooms.getCached(ROOM_B).slug });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.d.tags, ["plant-care"]);
  const ev = await getQuery("SELECT * FROM room_events WHERE room_id = ? AND what = 'feed-tag-remove'", [ROOM_B]);
  assert.equal(ev.length, 1);
  assert.match(ev[0].detail, /#cactus from post/);
  // gone from the filter; the author's edit can't bring it back
  assert.equal((await store.list({ room: ROOM_B, tag: "cactus" })).posts.length, 0);
  await store.edit(U.bob, P2.id, { tags: "cactus, plant-care, succulents" });
  assert.deepEqual((await store.get(P2.id, null)).tags, ["plant-care", "succulents"]);
  r = await post("/api/feed/posts/" + P2.id + "/tags/remove", U.owner, { tag: "cactus" });
  assert.equal(r.status, 404, "already removed");
  // the owner of p/houseplants isn't a mod of the Lounge; staff are
  r = await post("/api/feed/posts/" + P3.id + "/tags/remove", U.owner, { tag: "plant-care" });
  assert.equal(r.status, 403);
  r = await post("/api/feed/posts/" + P3.id + "/tags/remove", U.admin, { tag: "plant-care" });
  assert.equal(r.status, 200);
  // the ✕ shows for mods only
  const slug = rooms.getCached(ROOM_B).slug;
  assert.match((await get("/p/" + slug, U.owner)).text, /class="ftag-x" data-tagrm="succulents"/);
  assert.doesNotMatch((await get("/p/" + slug, U.alice)).text, /data-tagrm=/);
  // no cross-site / non-fetch writes
  const x = await fetch(base + "/api/feed/posts/" + P2.id + "/tags/remove", { method: "POST", headers: { "content-type": "application/json", "x-test-user": U.owner.userId }, body: "{}" });
  assert.equal(x.status, 403);
});

test("a crosspost starts with its original's tags (its own copy)", async () => {
  const r = await store.crosspostMany(U.bob.userId, P2.id, { pads: ["patv:lounge"] });
  const id = r.results[0].id;
  assert.ok(id, JSON.stringify(r));
  assert.deepEqual((await store.get(id, null)).tags, ["plant-care", "succulents"]);
  assert.ok((await store.list({ room: "patv:lounge", tag: "succulents" })).posts.some((p) => p.id === id));
});

test("popular tags: per pad and across pads, never from an Approved pad the viewer is outside of", async () => {
  await store.create(U.owner.userId, { community: ROOM_S, title: "secret one", tags: "hush-hush" });
  await store.create(U.owner.userId, { community: ROOM_S, title: "secret two", tags: "hush-hush" });
  const names = (L) => L.map((x) => x.tag);
  assert.ok(!names(await TG.popular(null, { viewer: U.alice })).includes("hush-hush"));
  assert.ok(!names(await TG.popular(null, { viewer: null })).includes("hush-hush"));
  assert.ok(names(await TG.popular(null, { viewer: U.owner })).includes("hush-hush"));
  assert.deepEqual(await TG.popular(ROOM_S, { viewer: U.alice }), []);
  assert.deepEqual(names(await TG.popular(ROOM_S, { viewer: U.owner })), ["hush-hush"]);
  const r = await get("/api/feed/tags?pad=" + rooms.getCached(ROOM_B).slug);
  assert.equal(r.status, 200);
  assert.ok(names(r.d.tags).includes("plant-care"));
  // the tag filter on All never leaks the Approved pad's posts
  assert.equal((await store.list({ tag: "hush-hush", viewer: U.alice })).posts.length, 0);
  assert.equal((await store.list({ tag: "hush-hush", viewer: U.owner })).posts.length, 2);
});
