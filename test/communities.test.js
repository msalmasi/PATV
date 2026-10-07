// Offline tests for 1.99ci: communities only + crossposts + the community bar + "Hot on PATV".
//   - the All query (was "Everywhere"): room-only posts show; per-room removals / owner hides / pending / bans;
//     one row per post; NSFW; report-hidden
//   - the communities_v1 migration: main-feed-only posts move to the Camfrog Lounge, counted, run once
//   - creating a post needs exactly one community; the composer's picker honours who-can-post
//   - crossposts: the target's rules (who can post, approval, bans, rate limits), duplicates, a crosspost of a
//     crosspost, separate votes / comments, "crossposted to N", "original removed", the target owner's removal,
//     files referenced (never copied)
//   - 1.99ct multi-pad crossposts: one per pad, per-pad rules with partial success, the cap, duplicates, rate
//     limits per crosspost, price per crosspost, one combined notice, the old single-pad API
//   - the URL scheme (/feed, /feed/following, /feed/c/<slug>) and the old ?room= / ?tab= redirects
//   - the homepage mini feed: hot order, NSFW never shown to signed-out visitors
//   NODE_PATH=G:/PATV/node_modules node --test test/communities.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "communities-test-"));
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
const follows = require(path.join(repo, "follows"));
require(path.join(repo, "terms"))._setRequired(false);

const ROOM_A = "PepeFrog.Room", ROOM_B = "plant_based_chatting", ROOM_C = "Side.Room", LOUNGE = rooms.LOUNGE_ID;
let base, server, U = {};
const users = new Map();
const LEGACY = {};

async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, ?, ?, ?, ?, 0)`,
                 [id, name, extra.display || name, extra.class || "pleb", extra.balance || 0, extra.camfrog || null, extra.level || 0, extra.created || "2026-01-01 00:00:00"]);
  const u = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, u);
  return u;
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery(`CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ct TEXT NOT NULL, file TEXT NOT NULL, bytes INTEGER, secs REAL, subject TEXT,
                  by_user TEXT, room TEXT, created INTEGER, expires INTEGER, deleted INTEGER DEFAULT 0)`);
  U.ownerB = await mkUser("plantowner", { camfrog: "foamy1111" });
  U.ownerC = await mkUser("sideowner", { camfrog: "sidecf" });
  U.admin = await mkUser("boss", { class: "Admin", camfrog: "bossfrog" });
  U.alice = await mkUser("alice", { camfrog: "alicecf", balance: 1000 });
  U.bob = await mkUser("bob", { camfrog: "bobcf" });
  U.carol = await mkUser("carol", { camfrog: "carolcf" });
  U.lvl = await mkUser("leveled", { level: 3 });            // unlinked
  // a pre-1.99ci feed (the 1.99bw tables): main-feed flags and room placements, before the migration runs
  await runQuery(`CREATE TABLE feed_posts (
        id TEXT PRIMARY KEY, author_id TEXT NOT NULL, title TEXT, body TEXT, link_url TEXT, link_json TEXT,
        nsfw INTEGER NOT NULL DEFAULT 0, nsfw_admin INTEGER, global INTEGER NOT NULL DEFAULT 1,
        score INTEGER NOT NULL DEFAULT 0, comments INTEGER NOT NULL DEFAULT 0, cost INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL, edited INTEGER, deleted_at INTEGER, deleted_by TEXT, delete_reason TEXT, hidden_at INTEGER, purged_at INTEGER)`);
  await runQuery(`CREATE TABLE feed_post_rooms (post_id TEXT NOT NULL, room_id TEXT NOT NULL, created INTEGER, removed_at INTEGER, removed_by TEXT,
        PRIMARY KEY (post_id, room_id))`);
  const t = Date.now() - 3600e3;
  const legacy = [
    ["legacyMain01", 1, null, null, false],              // main feed only                         -> Lounge
    ["legacyGone02", 1, ROOM_B, t, false],               // main feed + removed from its room      -> Lounge
    ["legacyBoth03", 1, ROOM_B, null, false],            // main feed + live in a room             -> stays
    ["legacyRoom04", 0, ROOM_B, null, false],            // room only                              -> stays
    ["legacyDead05", 1, null, null, true],               // main feed only, deleted                -> Lounge (counted as deleted)
  ];
  for (const [id, g, room, removed, dead] of legacy) {
    await runQuery("INSERT INTO feed_posts (id, author_id, body, global, created, deleted_at) VALUES (?, 'u_alice', ?, ?, ?, ?)", [id, "legacy " + id, g, t, dead ? t : null]);
    if (room) await runQuery("INSERT INTO feed_post_rooms (post_id, room_id, created, removed_at) VALUES (?, ?, ?, ?)", [id, room, t, removed]);
    LEGACY[id] = id;
  }
  await rooms.init();
  await rooms.setOwner(ROOM_B, "plantowner", "test");
  await rooms.addRoom(ROOM_C, "Side Room", "test");
  await rooms.setOwner(ROOM_C, "sideowner", "test");
  await store.init();                                   // runs communities_v1
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0, comments_per_hour: 1000 }, "test");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  require(path.join(repo, "pads")).register(app);                 // 1.99ck: the old addresses 301 to /p/...
  web.register(app, { addUser, isBotToken: (x) => x === "bot" });
  require(path.join(repo, "padsettings")).register(app, { addUser });   // 1.99dc: the pad settings hub (/mod + /manage redirect there)
  require(path.join(repo, "bridge")).register(app, { addUser, isBotToken: (x) => x === "bot" });   // the pad page /p/<slug>
  follows.register && follows.register(app, { addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });
test.beforeEach(() => { store._gaps.clear(); store._votes.clear(); });

const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {});
async function call(method, url, u, body) {
  const r = await fetch(base + url, { method, headers: H(u), body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, text, location: r.headers.get("location") };
}
const post = (url, u, body) => call("POST", url, u, body);
// 1.99dv: a post's page - the old /feed/p/<id> 301s to its canonical /p/<pad>/posts/<id>/<slug> (or /u/<name>/posts/...)
async function postPage(id, u) {
  const r = await call("GET", "/feed/p/" + id, u);
  if (r.status !== 301) return r;
  assert.match(r.location, new RegExp("^/(p|u)/[^/]+/posts/" + id + "(/[a-z0-9-]+)?$"), "the old post address 301s to the canonical one");
  return call("GET", r.location, u);
}

const page = (url, u) => call("GET", url, u);
const mkPost = async (u, body) => { const r = await post("/api/feed/posts", u, body); assert.equal(r.status, 200, JSON.stringify(r.d)); return r.d.id; };
const xpost = (u, id, body) => post(`/api/feed/posts/${id}/crosspost`, u, body);
const mod = (u, slug, body) => post(`/api/rooms/${slug}/feed/mod`, u, body);
const allIds = async (viewer, extra = {}) => (await store.list({ sort: "new", viewer, limit: 200, ...extra })).posts.map((p) => p.id);
const slug = (id) => rooms.getCached(id).slug;

// ───────────────────────────── migration ─────────────────────────────
test("communities_v1: main-feed-only posts move to the Camfrog Lounge (counted), others stay; runs once, idempotent", async () => {
  const R = await rooms.get(LOUNGE);
  assert.ok(R && R.house && R.community, "the Lounge is a house-run, site-only community");
  assert.equal(R.slug, "camfrog-lounge");
  const done = JSON.parse(await store.kvGet("communities_v1"));
  assert.deepEqual([done.moved, done.live, done.deleted, done.room], [3, 2, 1, LOUNGE]);
  const inLounge = async (id) => !!(await getQuery("SELECT 1 FROM feed_post_rooms WHERE post_id = ? AND room_id = ? AND removed_at IS NULL", [id, LOUNGE]))[0];
  assert.ok(await inLounge("legacyMain01") && await inLounge("legacyGone02") && await inLounge("legacyDead05"));
  assert.ok(!(await inLounge("legacyBoth03")) && !(await inLounge("legacyRoom04")), "already live in a room: left alone");
  assert.equal((await store.communitiesPlan()).posts.length, 0, "nothing left to move");
  // run again: the stored result, nothing doubled
  const again = await store.migrateCommunities();
  assert.equal(again.moved, 3);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM feed_post_rooms WHERE room_id = ?", [LOUNGE]))[0].n, 3);
  // an owner's later removal from the Lounge sticks, even if the migration runs again
  await store.removeFromRoom(U.admin, "legacyMain01", LOUNGE);
  await store.migrateCommunities();
  assert.ok(!(await inLounge("legacyMain01")));
  await store.restoreToRoom(U.admin, "legacyMain01", LOUNGE);
  // the old main-feed flag no longer decides anything; links keep working
  assert.equal((await postPage("legacyRoom04", U.bob)).status, 200);
  assert.equal((await postPage("legacyMain01", null)).status, 200);
});

// ───────────────────────────── the All query ─────────────────────────────
test("All: every community's posts (room-only ones too), once each; per-room removals / hides / pending / bans; NSFW; hidden", async () => {
  const ids = await allIds(U.bob);
  assert.ok(ids.includes("legacyRoom04"), "THE BUG: a post made only to a room shows on All");
  assert.ok(ids.includes("legacyBoth03") && ids.includes("legacyMain01") && ids.includes("legacyGone02"));
  assert.ok(!ids.includes("legacyDead05"), "deleted never");
  // a post in two communities (pre-1.99ci) appears once; removed from one it still shows; removed from both it's gone
  const two = await mkPost(U.alice, { body: "two rooms", community: ROOM_B });
  await runQuery("INSERT INTO feed_post_rooms (post_id, room_id, created, pending) VALUES (?, ?, ?, 0)", [two, ROOM_C, Date.now()]);
  assert.equal((await allIds(U.bob)).filter((x) => x === two).length, 1, "deduped");
  assert.equal((await mod(U.ownerB, slug(ROOM_B), { op: "remove", post: two })).status, 200);
  assert.ok((await allIds(U.bob)).includes(two), "still visible in C");
  assert.equal((await mod(U.ownerC, slug(ROOM_C), { op: "hide", post: two })).status, 200);
  assert.ok(!(await allIds(U.bob)).includes(two), "removed in B + hidden in C = visible nowhere");
  assert.ok((await allIds(U.admin)).includes(two), "staff still see it (it isn't removed from C)");
  await mod(U.ownerC, slug(ROOM_C), { op: "unhide", post: two });
  assert.ok((await allIds(U.bob)).includes(two));
  // pending approval: not on All until approved
  await mod(U.ownerC, slug(ROOM_C), { op: "settings", settings: { approval: true } });
  const pend = await mkPost(U.carol, { body: "waiting", community: ROOM_C });
  assert.ok(!(await allIds(U.bob)).includes(pend) && !(await allIds(null)).includes(pend));
  await mod(U.ownerC, slug(ROOM_C), { op: "approve", post: pend });
  assert.ok((await allIds(U.bob)).includes(pend));
  await mod(U.ownerC, slug(ROOM_C), { op: "settings", settings: { approval: false } });
  // bans: an author banned from the room drops out of it (and of All) while the ban lasts; a whole-feed ban everywhere
  const bp = await mkPost(U.carol, { body: "carol in C", community: ROOM_C });
  assert.equal((await post("/api/feed/ban", U.ownerC, { user: "carol", room: slug(ROOM_C), days: 1 })).status, 200);
  assert.ok(!(await allIds(U.bob)).includes(bp), "room ban: gone from All");
  assert.ok(!(await store.list({ room: ROOM_C, viewer: U.bob, limit: 100 })).posts.some((p) => p.id === bp), "and from the room");
  assert.ok((await store.list({ room: ROOM_C, viewer: U.ownerC, limit: 100 })).posts.some((p) => p.id === bp), "the owner still sees it");
  await post("/api/feed/unban", U.ownerC, { userId: U.carol.userId, room: slug(ROOM_C) });
  assert.ok((await allIds(U.bob)).includes(bp));
  await store.ban(U.admin, "carol", { room: "", days: 1 });
  assert.ok(!(await allIds(U.bob)).includes(bp), "whole-feed ban");
  await store.unban(U.admin, U.carol.userId, "");
  // report-hidden: staff only
  const hid = await mkPost(U.bob, { body: "reported away", community: ROOM_B });
  await store.adminSet(U.admin, hid, { hidden: true });
  assert.ok(!(await allIds(U.carol)).includes(hid) && (await allIds(U.admin)).includes(hid));
  // NSFW: a room owner's mark applies on All; sfw (signed-out homepage) leaves every kind of NSFW out
  const spicy = await mkPost(U.bob, { body: "spicy", community: ROOM_B, nsfw: true });
  const marked = await mkPost(U.bob, { body: "marked by the owner", community: ROOM_B });
  await mod(U.ownerB, slug(ROOM_B), { op: "nsfw", post: marked });
  const L = (await store.list({ sort: "new", viewer: U.carol, limit: 200 })).posts;
  assert.equal(L.find((p) => p.id === marked).nsfw, true);
  const sfw = await allIds(null, { sfw: true });
  assert.ok(!sfw.includes(spicy) && !sfw.includes(marked) && sfw.includes(two));
});

// ───────────────────────────── creating: communities only ─────────────────────────────
test("posting: exactly one community, by id or slug; the composer's picker = the communities you may post in", async () => {
  let r = await post("/api/feed/posts", U.alice, { body: "nowhere" });
  assert.equal(r.status, 400);
  assert.match(r.d.error, /Choose a pad/);
  r = await post("/api/feed/posts", U.alice, { body: "main", global: true });
  assert.equal(r.status, 400, "no main feed");
  r = await post("/api/feed/posts", U.alice, { body: "two", rooms: [ROOM_B, ROOM_C] });
  assert.equal(r.status, 400);
  assert.match(r.d.error, /Crosspost/);
  const id = await mkPost(U.alice, { body: "by slug", community: "c/" + slug(ROOM_C) });
  assert.deepEqual((await store.get(id)).rooms.map((x) => x.id), [ROOM_C]);
  // who-can-post: B takes linked accounts only -> not in leveled's picker, nor postable through the API
  await mod(U.ownerB, slug(ROOM_B), { op: "settings", settings: { who: "linked" } });
  const C = await web.composerFor(await store.account(U.lvl.userId), null);
  assert.ok(!C.rooms.some((x) => x.id === ROOM_B) && C.rooms.some((x) => x.id === ROOM_C) && C.rooms.some((x) => x.id === LOUNGE));
  assert.equal((await post("/api/feed/posts", U.lvl, { body: "x", community: ROOM_B })).status, 403);
  const html = (await page("/feed", U.lvl)).text;
  assert.ok(html.includes('name="community"') && !html.includes('name="global"') && !html.includes("Main feed"));
  assert.ok(html.includes("Choose a pad") && !html.includes(`value="${ROOM_B}"`));
  // posting by "p/<slug>" works too (1.99ck)
  const byP = await mkPost(U.alice, { body: "by p/ ref", community: "p/" + slug(ROOM_C) });
  assert.deepEqual((await store.get(byP)).rooms.map((x) => x.id), [ROOM_C]);
  // on a pad page the pad is preselected; one you can't post in says why
  const onC = (await page("/p/" + slug(ROOM_C), U.alice)).text;
  assert.match(onC, new RegExp(`value="${ROOM_C.replace(".", "\\.")}"[^>]*checked`));
  const onB = (await page("/p/" + slug(ROOM_B), U.lvl)).text;
  assert.match(onB, /✋ Houseplants takes posts from linked Camfrog accounts.*You can still pick another pad/);
  const F = await web.roomFeed(ROOM_C, U.alice, {});
  assert.equal(F.composer.room, ROOM_C);
  await mod(U.ownerB, slug(ROOM_B), { op: "settings", settings: { who: "everyone" } });
});

// ───────────────────────────── crossposts ─────────────────────────────
test("crosspost: a new post in the target linking the original; files referenced; votes + comments separate; counts", async () => {
  // the original: alice in B, with a picture
  const file = "ab".repeat(16) + ".webp", thumb = "ab".repeat(16) + "_t.webp";
  await runQuery(`INSERT INTO feed_attachments (id, owner_id, kind, ct, file, thumb, w, h, bytes, state, created, size_declared, received)
                  VALUES (?, ?, 'image', 'image/webp', ?, ?, 10, 10, 10, 'ready', ?, 10, 10)`, ["c".repeat(24), U.alice.userId, file, thumb, Date.now()]);
  const orig = await mkPost(U.alice, { title: "Look at my fern", body: "it grew", community: ROOM_B, attachments: ["c".repeat(24)] });
  const attBefore = (await getQuery("SELECT COUNT(*) AS n FROM feed_attachments"))[0].n;
  const r = await xpost(U.bob, orig, { community: slug(ROOM_C), title: "" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const x = r.d.id;
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM feed_attachments"))[0].n, attBefore, "no file copied");
  const row = (await getQuery("SELECT * FROM feed_posts WHERE id = ?", [x]))[0];
  assert.deepEqual([row.crosspost_of, row.author_id, row.title, row.body, row.global], [orig, U.bob.userId, "Look at my fern", null, 0]);
  // decorated: embeds the original; the original lists its crossposts
  const X = await store.get(x, U.carol);
  assert.equal(X.xpost.id, orig);
  assert.equal(X.xpost.from.slug, slug(ROOM_B));
  assert.equal(X.xpost.author.username, "alice");
  assert.equal(X.xpost.post.images[0].file, file);
  assert.deepEqual(X.rooms.map((q) => q.id), [ROOM_C]);
  const O = await store.get(orig, U.carol);
  assert.equal(O.xcount, 1);
  assert.equal(O.crossposts[0].slug, slug(ROOM_C));
  // the crosspost is its own post: votes and comments don't touch the original
  store._gaps.clear();
  assert.equal((await post(`/api/feed/posts/${x}/vote`, U.carol, { dir: 1 })).status, 200);
  assert.equal((await post(`/api/feed/posts/${x}/comments`, U.carol, { body: "nice x-post" })).status, 200);
  const [ro, rx] = [await store.getRow(orig), await store.getRow(x)];
  assert.deepEqual([ro.score, ro.comments, rx.score, rx.comments], [1, 0, 2, 1]);
  // the original's author is told
  assert.equal((await getQuery("SELECT * FROM inbox WHERE user_id = ? AND ref = ?", [U.alice.userId, "feed-xp:" + x])).length, 1);
  // pages: the crosspost card + "crossposted to"
  const px = (await postPage(x, U.carol)).text;
  assert.match(px, /Crossposted from <span class="pad-plat pp-camfrog sm" title="A Camfrog Pad[^"]*">🐸<\/span> <a href="\/p\/plant-based-chatting">p\/plant-based-chatting<\/a> by <a href="\/u\/alice">u\/alice<\/a>/);
  assert.ok(px.includes(`/media/f/${file}`) && px.includes('class="fp-xbox"'));
  assert.ok(px.includes('data-act="crosspost"'), "the post page has a Crosspost button");
  const po = (await postPage(orig, U.carol)).text;
  assert.match(po, /Crossposted to 1 pad:/);
  const all = (await page("/feed?sort=new", U.carol)).text;
  assert.ok(all.includes('data-act="crosspost"') && all.includes("Crossposted from"));
  // a crosspost of a crosspost points at the original; the same community twice / where it already is: refused
  const again = await xpost(U.carol, x, { community: LOUNGE, title: "fern again" });
  assert.equal(again.status, 200);
  assert.equal((await store.getRow(again.d.id)).crosspost_of, orig);
  assert.equal((await xpost(U.carol, orig, { community: ROOM_C })).status, 409, "already crossposted there");
  assert.equal((await xpost(U.carol, orig, { community: ROOM_B })).status, 409, "the original is already there");
  assert.equal((await xpost(U.carol, orig, {})).status, 400);
  assert.equal((await xpost(null, orig, { community: ROOM_A })).status, 401);
  assert.equal((await store.get(orig, U.carol)).xcount, 2);
  // the dialog's list marks where it already is
  const cl = await call("GET", `/api/feed/communities?post=${x}`, U.carol);
  const here = Object.fromEntries(cl.d.communities.map((c) => [c.id, c.here]));
  assert.deepEqual([here[ROOM_B], here[ROOM_C], here[LOUNGE], here[ROOM_A]], [true, true, true, false]);
});

test("crosspost rules: the target's who-can-post, approval queue, bans and rate limits; moderation both ways", async () => {
  const orig = await mkPost(U.alice, { title: "rules test", body: "x", community: ROOM_B });
  // who can post: C takes approved posters only
  await mod(U.ownerC, slug(ROOM_C), { op: "settings", settings: { who: "approved" } });
  let r = await xpost(U.bob, orig, { community: ROOM_C });
  assert.equal(r.status, 403);
  assert.match(r.d.error, /approved posters/);
  await mod(U.ownerC, slug(ROOM_C), { op: "settings", settings: { who: "everyone", approval: true } });
  // approval queue: pending in C, not on All, the owner approves
  r = await xpost(U.bob, orig, { community: ROOM_C });
  assert.equal(r.status, 200);
  assert.equal(r.d.pending, true);
  const x = r.d.id;
  assert.ok(!(await allIds(U.carol)).includes(x));
  assert.deepEqual((await store.roomPending(ROOM_C, U.ownerC)).map((p) => p.id), [x]);
  await mod(U.ownerC, slug(ROOM_C), { op: "approve", post: x });
  assert.ok((await allIds(U.carol)).includes(x));
  await mod(U.ownerC, slug(ROOM_C), { op: "settings", settings: { approval: false } });
  // banned from the target: refused; restricted by Pepe there: refused
  await post("/api/feed/ban", U.ownerC, { user: "carol", room: slug(ROOM_C), days: 1 });
  r = await xpost(U.carol, orig, { community: ROOM_A });
  assert.equal(r.status, 200, "another community is fine");
  const orig2 = await mkPost(U.alice, { title: "second", body: "y", community: ROOM_B });
  r = await xpost(U.carol, orig2, { community: ROOM_C });
  assert.equal(r.status, 403);
  await post("/api/feed/unban", U.ownerC, { userId: U.carol.userId, room: slug(ROOM_C) });
  // rate limits: the account's post limits count crossposts
  await store.setConfig({ post_gap_secs: 3600 }, "test");
  store._gaps.clear();
  assert.equal((await xpost(U.lvl, orig2, { community: ROOM_C })).status, 200);
  r = await xpost(U.lvl, orig2, { community: LOUNGE });
  assert.equal(r.status, 429);
  await store.setConfig({ post_gap_secs: 0 }, "test");
  // the target's owner can take the crosspost out of their room; the original's owner can't touch it
  assert.equal((await mod(U.ownerB, slug(ROOM_C), { op: "remove", post: x })).status, 403);
  assert.equal((await post(`/api/feed/posts/${x}/remove-room`, U.ownerB, { room: ROOM_C })).status, 403);
  assert.equal((await mod(U.ownerC, slug(ROOM_C), { op: "remove", post: x })).status, 200);
  assert.ok(!(await allIds(U.carol)).includes(x));
  assert.ok((await allIds(U.carol)).includes(orig), "the original is untouched");
  // removing the original marks its crossposts "original removed"
  const y = (await xpost(U.carol, orig2, { community: LOUNGE })).d.id;
  assert.equal((await post(`/api/feed/posts/${orig2}/delete`, U.alice, {})).status, 200);
  const Y = await store.get(y, U.bob);
  assert.equal(Y.xpost.removed, true);
  assert.equal(Y.xpost.post, null, "no content for members");
  assert.ok((await store.get(y, U.admin)).xpost.post, "staff still see it");
  const py = (await postPage(y, U.bob)).text;
  assert.ok(py.includes("The original post was removed.") && !py.includes('class="fp-xtitle"'), "the crosspost keeps its own title, the embed is gone");
  assert.equal((await xpost(U.bob, y, { community: ROOM_C })).status, 404, "nothing left to crosspost");
  // an owner taking the original out of all its communities counts as removed too
  const orig3 = await mkPost(U.alice, { title: "third", body: "z", community: ROOM_B });
  const z = (await xpost(U.bob, orig3, { community: LOUNGE })).d.id;
  await mod(U.ownerB, slug(ROOM_B), { op: "remove", post: orig3 });
  assert.equal((await store.get(z, U.carol)).xpost.removed, true);
  // NSFW originals make NSFW crossposts (and the homepage leaves them out for visitors)
  const hot = await mkPost(U.alice, { title: "nsfw original", body: "!", community: ROOM_B, nsfw: true });
  const hx = (await xpost(U.bob, hot, { community: LOUNGE })).d.id;
  assert.equal((await store.get(hx, U.carol)).nsfw, true);
  assert.ok(!(await allIds(null, { sfw: true })).includes(hx));
});

// ───────────────────────────── URLs ─────────────────────────────
test("URL scheme (1.99ck pads): /feed (All), /feed/following, /p/<slug>; old ?room= / ?tab= / /feed/c/ links redirect; the pad bar", async () => {
  let r = await page("/feed?room=" + slug(ROOM_B) + "&sort=new&p=2", U.bob);
  assert.equal(r.status, 301);
  assert.equal(r.location, "/p/plant-based-chatting?sort=new&p=2");
  r = await page("/feed?room=" + encodeURIComponent(ROOM_B), U.bob);
  assert.equal(r.location, "/p/plant-based-chatting", "a room id works too");
  r = await page("/feed?tab=following&sort=top&t=day", U.bob);
  assert.equal(r.location, "/feed/following?sort=top&t=day");
  r = await page("/feed?tab=captures&room=" + slug(ROOM_A), U.bob);
  assert.equal(r.location, "/p/pepefrog-room");
  r = await page("/feed/c/plant-based-chatting?sort=new&p=2", U.bob);
  assert.equal(r.status, 301);
  assert.equal(r.location, "/p/plant-based-chatting?sort=new&p=2", "the old pad feed address keeps its query");
  r = await page("/feed/c/" + encodeURIComponent(ROOM_B), U.bob);
  assert.equal(r.location, "/p/" + encodeURIComponent(ROOM_B));
  r = await page(r.location + "?sort=top", U.bob);
  assert.equal(r.status, 301);
  assert.equal(r.location, "/p/plant-based-chatting?sort=top", "a room id ends on the pad's slug");
  assert.equal((await page("/p/no-such-room", U.bob)).status, 404);
  // All: the bar says Pad: All; no "Everywhere"
  const all = (await page("/feed", U.bob)).text;
  assert.ok(!all.includes("Everywhere"));
  assert.match(all, /<span class="cb-k">Pad<\/span>[\s\S]*?<b>All<\/b>/);
  assert.match(all, /class="cb-chip on" href="\/feed" aria-current="page">🌐 All/);
  assert.ok(all.includes('href="/feed/following"') && all.includes('href="/p/camfrog-lounge"') && all.includes('href="/p/plant-based-chatting"'));
  assert.match(all, /p\/plant-based-chatting · \d+ followers? · \d+ posts?/);
  assert.ok(!/communit/i.test(all.replace(/name="community"|data-comm[\w-]*|fc-comm[\w-]*|\/api\/feed\/communities/g, "")), "no 'community' copy left on /feed");
  // a pad page: its header (name, p/<slug>, description, follow, owner) and that pad's feed, sorted by ?sort=
  await rooms.setPage(ROOM_B, { description: "Plants <b>and</b> chat" }, "test");
  const pb = (await page("/p/plant-based-chatting?sort=new", U.bob)).text;
  assert.match(pb, /<h1 id="rmTitle">Houseplants/);
  assert.ok(pb.includes('<div class="padref">p/plant-based-chatting</div>'));
  assert.ok(pb.includes("Plants &lt;b&gt;and&lt;/b&gt; chat"));
  assert.match(pb, /title="Follow this pad" class="fw-btn[^"]*" data-follow-kind="room" data-follow-id="plant_based_chatting"/);
  assert.match(pb, /👑 Pad owner: /);
  assert.match(pb, /<span class="hd-fc"[^>]*><b data-follower-count-kind="room"[^>]*>\d+<\/b> followers?<\/span>/, "1.99ef: the follower count is plain text by Follow, not a chip");
  assert.ok(pb.includes("📡 Camfrog room") && pb.includes("legacyRoom04"));
  assert.ok(pb.includes("🐸 Camfrog Pad"), "1.99x: a Camfrog-backed pad wears the Camfrog badge");
  assert.ok(pb.includes('href="/p">Pads</a>'));
  // the Camfrog Lounge (1.99x; a SITE pad): no Camfrog room - no live / Camfrog sections
  const lounge = (await page("/p/camfrog-lounge", U.bob)).text;
  assert.ok(lounge.includes("Camfrog Lounge") && lounge.includes("🌐 Site Pad") && !lounge.includes("Site-only pad"));
  // 1.99x: the Pads list - every card wears its platform badge; ?platform= filters (All / Camfrog / Site)
  const padsAll = (await page("/p", U.bob)).text;
  assert.ok(padsAll.includes('aria-label="Filter pads by platform"') && padsAll.includes('href="/p?platform=site"') && padsAll.includes('href="/p?platform=camfrog"'));
  assert.ok(padsAll.includes("Camfrog Lounge") && padsAll.includes("Houseplants") && padsAll.includes("🌐 Site Pad") && padsAll.includes("🐸 Camfrog Pad"));
  const padsSite = (await page("/p?platform=site", U.bob)).text;
  assert.ok(padsSite.includes("Camfrog Lounge") && !padsSite.includes(">Houseplants<"), "site filter: only site pads");
  const padsCf = (await page("/p?platform=camfrog", U.bob)).text;
  assert.ok(padsCf.includes(">Houseplants<") && !padsCf.includes(">Camfrog Lounge<"), "camfrog filter: only Camfrog pads");
  assert.ok(!lounge.includes("Camfrog room —") && !lounge.includes("isn't bridging") && !lounge.includes('id="rmFeed"'));
  // sort links on /feed keep the view; a pad in the bar opens its pad page; Following has its own path
  assert.ok(all.includes('href="/feed?sort=top&amp;t=week"'));
  const fol = (await page("/feed/following", U.bob)).text;
  assert.match(fol, /class="cb-chip on" href="\/feed\/following" aria-current="page">⭐ Following/);
  assert.equal(web.fx.feedUrl("all", { sort: "hot", p: 1 }), "/feed");
  assert.equal(web.fx.feedUrl("x y", { sort: "new", p: 3 }), "/p/x%20y?sort=new&p=3");
  // the pad page's feed section: p/<slug> heading, a link back to All, moderation at /p/<slug>/mod
  const F = await web.roomFeed(ROOM_B, U.bob, {});
  const part = await ejs.renderFile(path.join(repo, "views/partials/room-feed.ejs"), { feed: F, fx: web.fx, embeds: require(path.join(repo, "stageembed")), host: "test",
                                                                                  room: { name: "Houseplants", slug: "plant-based-chatting" } });
  assert.ok(part.includes("📝 p/plant-based-chatting feed") && part.includes('href="/feed">All pads'));
});

test("redirects (1.99ck): every old room / community address 301s to its /p/ address with the query kept", async () => {
  const cases = [
    ["/rooms", "/p"],
    ["/rooms?x=1", "/p?x=1"],
    ["/pads", "/p"],
    ["/rooms/admin", "/pads/admin"],
    ["/rooms/plant-based-chatting", "/p/plant-based-chatting"],
    ["/rooms/plant-based-chatting?fsort=top&ft=day#feed", "/p/plant-based-chatting?fsort=top&ft=day"],
    // 1.99dc: /manage and /mod are the settings hub now - straight there, the right tab picked, the query kept
    ["/rooms/plant-based-chatting/manage", "/p/plant-based-chatting/settings?tab=stage"],
    ["/rooms/plant-based-chatting/manage?tab=royalties", "/p/plant-based-chatting/settings?tab=stage"],
    ["/rooms/plant-based-chatting/feed/mod", "/p/plant-based-chatting/settings?tab=moderation"],
    ["/rooms/plant-based-chatting/feed/mod?x=y", "/p/plant-based-chatting/settings?x=y&tab=moderation"],
    ["/p/plant-based-chatting/manage", "/p/plant-based-chatting/settings?tab=stage"],
    ["/p/plant-based-chatting/mod", "/p/plant-based-chatting/settings?tab=moderation"],
    ["/rooms/plant-based-chatting/analytics?days=7", "/p/plant-based-chatting/analytics?days=7"],
    ["/rooms/plant-based-chatting/audio?t=123", "/p/plant-based-chatting/audio?t=123"],
    ["/feed/c/plant-based-chatting", "/p/plant-based-chatting"],
    ["/feed/c/plant-based-chatting?sort=top&t=month&p=3", "/p/plant-based-chatting?sort=top&t=month&p=3"],
    ["/feed?room=plant-based-chatting&sort=top&t=day", "/p/plant-based-chatting?sort=top&t=day"],
  ];
  for (const [from, to] of cases) {
    const r = await page(from, U.bob);
    assert.equal(r.status, 301, from);
    assert.equal(r.location, to, from);
  }
  // signed out too, and the old post permalink /feed/p/<id> is NOT a pad address (1.99dv: it 301s to the post's address)
  assert.equal((await page("/rooms/patv-lounge", null)).location, "/p/camfrog-lounge", "1.99x: a retired slug goes straight to the current one");
  const id = await mkPost(U.alice, { body: "permalink", community: LOUNGE });
  assert.equal((await postPage(id, U.bob)).status, 200);
});

test("p/<slug> autolinks (1.99ck): known pads in post and comment text link to /p/<slug>; unknown ones, URLs and words stay text", async () => {
  const pads = require(path.join(repo, "pads"));
  const known = (s) => (["houseplants", "drama-central"].includes(s) ? { slug: s } : null);
  assert.equal(pads.padRefs("see p/houseplants!", known), 'see <a class="pad-ref" href="/p/houseplants">p/houseplants</a>!');
  assert.equal(pads.padRefs("p/drama-central and p/nope", known), '<a class="pad-ref" href="/p/drama-central">p/drama-central</a> and p/nope');
  assert.equal(pads.padRefs("(P/Houseplants)", known), '(<a class="pad-ref" href="/p/houseplants">p/houseplants</a>)');
  assert.equal(pads.padRefs("x.com/p/houseplants or ap/houseplants or p/houseplants/x", known), "x.com/p/houseplants or ap/houseplants or p/houseplants/x");
  // through the real renderer: escaping first, URLs untouched, the registry decides what's a pad
  const out = web.fx.body('hi p/plant-based-chatting & <b>p/patv-lounge</b> https://e.x/p/patv-lounge p/not-a-pad');
  assert.ok(out.includes('<a class="pad-ref" href="/p/plant-based-chatting">p/plant-based-chatting</a> &amp; &lt;b&gt;<a class="pad-ref" href="/p/camfrog-lounge">p/patv-lounge</a>&lt;/b&gt;'), out);
  assert.ok(out.includes('<a href="https://e.x/p/patv-lounge" rel="nofollow noopener noreferrer ugc" target="_blank">https://e.x/p/patv-lounge</a>'), out);
  assert.ok(out.endsWith(" p/not-a-pad"), out);
  // on a page: a post body and a comment body
  const id = await mkPost(U.alice, { body: "cross-pad shoutout to p/plant-based-chatting", community: LOUNGE });
  assert.equal((await post(`/api/feed/posts/${id}/comments`, U.bob, { body: "agreed, p/patv-lounge rules" })).status, 200);
  const html = (await postPage(id, U.bob)).text;
  assert.ok(html.includes('shoutout to <a class="pad-ref" href="/p/plant-based-chatting">p/plant-based-chatting</a>'));
  assert.ok(html.includes('agreed, <a class="pad-ref" href="/p/camfrog-lounge">p/patv-lounge</a> rules'));
});

// ───────────────────────────── homepage mini feed ─────────────────────────────
test("Hot on PATV: the top 5 hot posts across All; signed-out visitors never see NSFW; the card renders at any size", async () => {
  // fresh, well-voted posts lead the hot ranking
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(await mkPost(U.alice, { title: "hot " + i, body: "b", community: i % 2 ? ROOM_B : LOUNGE, nsfw: i === 5 }));
  for (const id of ids) for (const u of [U.bob, U.carol, U.ownerB, U.ownerC]) { store._gaps.clear(); await post(`/api/feed/posts/${id}/vote`, u, { dir: 1 }); }
  const out = await web.hotMini(null);
  assert.equal(out.posts.length, 5);
  assert.ok(!out.posts.some((p) => p.nsfw || p.id === ids[5]), "signed out: no NSFW (the newest, hottest one is NSFW)");
  for (const p of out.posts) assert.ok(p.url.startsWith("/p/") && p.url.includes("/posts/" + p.id) && p.community && typeof p.score === "number" && typeof p.comments === "number");
  const signed = await web.hotMini(U.bob);
  assert.ok(signed.posts.some((p) => p.id === ids[5] && p.nsfw && p.thumb === null), "members see it flagged, never its picture");
  const html = await ejs.renderFile(path.join(repo, "views/partials/home-hot.ejs"), { hot: out, fx: web.fx });
  assert.ok(html.includes("🔥 Hot on PATV") && html.includes('href="/feed">View all'));
  assert.equal((html.match(/class="hh-it"/g) || []).length, 5);
  assert.match(html, /p\/camfrog-lounge|p\/plant-based-chatting/);
  assert.match(html, /class="pad-plat pp-(site|camfrog) sm"/, "1.99x: each hot post shows its pad's platform badge");
  assert.ok(!html.includes("hot 5") && html.includes("hot 4"));
  const empty = await ejs.renderFile(path.join(repo, "views/partials/home-hot.ejs"), { hot: { posts: [], signed: false }, fx: web.fx });
  assert.match(empty, /Nothing posted yet/);
});

// ───────────────────────────── 1.99ct: crosspost to several pads at once ─────────────────────────────
const X1 = "Xp.One", X2 = "Xp.Two", X3 = "Xp.Three", X4 = "Xp.Four", X5 = "Xp.Five";
async function xpPads() {
  for (const [id, t] of [[X1, "Xp One"], [X2, "Xp Two"], [X3, "Xp Three"], [X4, "Xp Four"], [X5, "Xp Five"]]) {
    if (!rooms.getCached(id)) await rooms.addRoom(id, t, "test");
  }
}
const xrows = async (orig) => getQuery(`SELECT p.id, p.author_id, p.title, pr.room_id, pr.pending FROM feed_posts p JOIN feed_post_rooms pr ON pr.post_id = p.id
                                        WHERE p.crosspost_of = ? ORDER BY p.created, p.id`, [orig]);
const xnotices = async (u) => getQuery("SELECT * FROM inbox WHERE user_id = ? AND ref LIKE 'feed-xp:%' ORDER BY id", [u.userId]);

test("multi-pad crosspost: one crosspost per pad (own votes + comments), the new title on all, ONE combined notice", async () => {
  await xpPads();
  const orig = await mkPost(U.alice, { title: "Multi original", body: "m", community: ROOM_B });
  const before = (await xnotices(U.alice)).length;
  const r = await xpost(U.bob, orig, { pads: [slug(ROOM_C), LOUNGE, "p/" + slug(X1)], title: "Look at this" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.deepEqual([r.d.created, r.d.pending, r.d.refused], [3, 0, 0]);
  assert.deepEqual(r.d.results.map((x) => [x.pad.id, x.status]), [[ROOM_C, "created"], [LOUNGE, "created"], [X1, "created"]]);
  for (const x of r.d.results) assert.equal(x.url, await store.postPath(x.id));
  const rows = await xrows(orig);
  assert.deepEqual(rows.map((x) => x.room_id).sort(), [ROOM_C, LOUNGE, X1].sort());
  assert.equal(new Set(rows.map((x) => x.id)).size, 3, "three separate posts");
  assert.ok(rows.every((x) => x.author_id === U.bob.userId && x.title === "Look at this" && !x.pending));
  // Reddit's model: each crosspost has its own votes and comments
  const [a, b] = r.d.results.map((x) => x.id);
  assert.equal((await post(`/api/feed/posts/${a}/vote`, U.carol, { dir: 1 })).status, 200);
  assert.equal((await post(`/api/feed/posts/${a}/comments`, U.carol, { body: "nice" })).status, 200);
  const A = await store.get(a, U.carol), B = await store.get(b, U.carol);
  assert.deepEqual([A.score, A.comments, B.score, B.comments], [2, 1, 1, 0]);
  assert.equal((await store.get(orig, U.carol)).xcount, 3);
  // one notice for the whole action, naming every pad
  const N = (await xnotices(U.alice)).slice(before);
  assert.equal(N.length, 1, "one combined notice, not one per pad");
  assert.equal(N[0].title, `bob crossposted your post to p/${slug(ROOM_C)}, p/camfrog-lounge, p/${slug(X1)}`);
  // the dialog's list knows the cap and where it now is
  const cl = await call("GET", `/api/feed/communities?post=${orig}`, U.carol);
  assert.equal(cl.d.crosspostMax, 5);
  const here = Object.fromEntries(cl.d.communities.map((c) => [c.id, c.here]));
  assert.deepEqual([here[ROOM_B], here[ROOM_C], here[LOUNGE], here[X1], here[X2]], [true, true, true, true, false]);
  // the dialog script: checkboxes, the summary, the results
  const js = fs.readFileSync(path.join(repo, "public/js/feed-crosspost.js"), "utf8");
  assert.ok(js.includes("r.type = 'checkbox'") && js.includes("' selected'") && js.includes("pads: on.map"));
  assert.ok(fs.readFileSync(path.join(repo, "views/partials/feed-js.ejs"), "utf8").includes("feed-crosspost.js?v=7"), "cache-buster bumped");
});

test("multi-pad crosspost: each pad's rules on their own (approval, who-can-post, bans, Pepe) - partial success; duplicates refused", async () => {
  await xpPads();
  const orig = await mkPost(U.alice, { title: "Rules per pad", body: "r", community: ROOM_B });
  await mod(U.ownerC, slug(ROOM_C), { op: "settings", settings: { approval: true } });
  await mod(U.admin, slug(X2), { op: "settings", settings: { who: "approved" } });
  await post("/api/feed/ban", U.admin, { user: "bob", room: slug(X3), days: 1 });
  await runQuery("INSERT OR REPLACE INTO feed_restricted (login, room_id, reason, until) VALUES (?, ?, ?, NULL)", ["bobcf", X4, "you were kicked here"]);
  const before = (await xnotices(U.alice)).length;
  let r = await xpost(U.bob, orig, { pads: [ROOM_C, X2, X3, X4, LOUNGE] });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const by = Object.fromEntries(r.d.results.map((x) => [x.pad.id, x]));
  assert.equal(by[ROOM_C].status, "pending", "C's approval queue");
  assert.equal(by[X2].status, "refused");
  assert.match(by[X2].error, /approved posters/);
  assert.equal(by[X3].status, "refused");
  assert.match(by[X3].error, /can't post in Xp Three/);
  assert.equal(by[X4].status, "refused");
  assert.match(by[X4].error, /Pepe says: you were kicked here/);
  assert.equal(by[LOUNGE].status, "created");
  assert.deepEqual([r.d.created, r.d.pending, r.d.refused], [1, 1, 3]);
  assert.deepEqual((await xrows(orig)).map((x) => [x.room_id, x.pending]).sort(), [[LOUNGE, 0], [ROOM_C, 1]].sort());
  assert.ok((await store.roomPending(ROOM_C, U.ownerC)).some((p) => p.id === by[ROOM_C].id));
  const N = (await xnotices(U.alice)).slice(before);
  assert.equal(N.length, 1);
  assert.match(N[0].title, new RegExp(`to p/${slug(ROOM_C)}, p/camfrog-lounge$`), "the notice names only the pads it went to");
  // duplicates: where the original is, where it's already crossposted (by anyone, pending too), and the same pad twice in one list
  r = await xpost(U.carol, orig, { pads: [ROOM_B, LOUNGE, ROOM_C, X1, "p/" + slug(X1)] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.d.results.map((x) => [x.pad.id, x.status]), [[ROOM_B, "refused"], [LOUNGE, "refused"], [ROOM_C, "refused"], [X1, "created"]]);
  assert.match(r.d.results[0].error, /already in/);
  assert.match(r.d.results[1].error, /already been crossposted/);
  assert.equal((await xrows(orig)).filter((x) => x.room_id === X1).length, 1, "X1 named twice -> one crosspost");
  // an unknown pad is a per-pad refusal; nothing creatable -> no notice
  const mid = (await xnotices(U.alice)).length;
  r = await xpost(U.carol, orig, { pads: ["p/no-such-pad", X1] });
  assert.deepEqual(r.d.results.map((x) => x.status), ["refused", "refused"]);
  assert.equal(r.d.results[0].pad, null);
  assert.equal((await xnotices(U.alice)).length, mid, "nothing made, no notice");
  // the author crossposting their own post: no notice to themselves
  r = await xpost(U.alice, orig, { pads: [X5] });
  assert.equal(r.d.created, 1);
  assert.equal((await xnotices(U.alice)).length, mid);
  // tidy up
  await mod(U.ownerC, slug(ROOM_C), { op: "settings", settings: { approval: false } });
  await mod(U.admin, slug(X2), { op: "settings", settings: { who: "everyone" } });
  await post("/api/feed/unban", U.admin, { userId: U.bob.userId, room: slug(X3) });
  await runQuery("DELETE FROM feed_restricted WHERE login = 'bobcf'");
});

test("multi-pad crosspost: the per-action cap (admin-tunable) - over it, nothing is made", async () => {
  await xpPads();
  const orig = await mkPost(U.alice, { title: "Cap", body: "c", community: ROOM_B });
  let r = await xpost(U.bob, orig, { pads: [ROOM_C, LOUNGE, X1, X2, X3, X4] });
  assert.equal(r.status, 400);
  assert.match(r.d.error, /at most 5 pads at a time/);
  assert.equal((await xrows(orig)).length, 0, "all or nothing on the cap");
  await store.setConfig({ crosspost_max_pads: 2 }, "test");
  assert.equal((await call("GET", `/api/feed/communities?post=${orig}`, U.bob)).d.crosspostMax, 2);
  r = await xpost(U.bob, orig, { pads: [ROOM_C, LOUNGE, X1] });
  assert.equal(r.status, 400);
  assert.match(r.d.error, /at most 2 pads/);
  assert.equal((await xpost(U.bob, orig, { pads: [ROOM_C, LOUNGE] })).d.created, 2);
  await store.setConfig({ crosspost_max_pads: 999 }, "test");
  assert.equal(store.config().crosspost_max_pads, 25, "clamped to 1-25");
  await store.setConfig({ crosspost_max_pads: 5 }, "test");
  assert.equal((await xpost(U.bob, orig, { pads: [] })).status, 400);
  assert.equal((await xpost(null, orig, { pads: [X1] })).status, 401);
  // the admin page has the field
  const html = (await page("/feed/admin", U.admin)).text;
  assert.ok(html.includes('name="crosspost_max_pads"'));
});

test("multi-pad crosspost: every crosspost counts against the post rate limits; a burst of 5 fits or is refused as a whole", async () => {
  await xpPads();
  const dave = await mkUser("dave", { camfrog: "davecf" });
  const orig = await mkPost(U.alice, { title: "Rate", body: "r", community: ROOM_B });
  await store.setConfig({ posts_per_hour: 3 }, "test");
  await mkPost(dave, { body: "my own", community: LOUNGE });                  // 1 of 3 used
  let r = await xpost(dave, orig, { pads: [ROOM_C, LOUNGE, X1] });
  assert.equal(r.status, 429);
  assert.match(r.d.error, /you can post 2 more times right now - pick at most 2 pads/);
  assert.equal((await xrows(orig)).length, 0, "refused as a whole");
  r = await xpost(dave, orig, { pads: [ROOM_C, LOUNGE] });
  assert.equal(r.d.created, 2);
  r = await xpost(dave, orig, { pads: [X1] });
  assert.equal(r.status, 429);
  assert.match(r.d.error, /posted a lot this hour/);
  // the burst gap applies once per action: 5 pads in one go is fine, a second action right after is not
  await store.setConfig({ posts_per_hour: 1000, post_gap_secs: 3600 }, "test");
  const orig2 = await mkPost(U.alice, { title: "Burst", body: "b", community: ROOM_B });
  r = await xpost(U.carol, orig2, { pads: [ROOM_C, LOUNGE, X1, X2, X3] });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.created, 5);
  r = await xpost(U.carol, orig2, { pads: [X4] });
  assert.equal(r.status, 429);
  assert.match(r.d.error, /Slow down/);
  await store.setConfig({ post_gap_secs: 0 }, "test");
});

test("multi-pad crosspost: price_post is charged once per crosspost created (refused pads cost nothing)", async () => {
  await xpPads();
  const erin = await mkUser("erin", { camfrog: "erincf", balance: 25 });
  const orig = await mkPost(U.alice, { title: "Priced", body: "p", community: ROOM_B });
  await store.setConfig({ price_post: 10 }, "test");
  const r = await xpost(erin, orig, { pads: [ROOM_B, ROOM_C, LOUNGE, X1] });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.deepEqual(r.d.results.map((x) => x.status), ["refused", "created", "created", "refused"]);
  assert.match(r.d.results[0].error, /already in/);
  assert.match(r.d.results[3].error, /costs 10 PAT - you don't have enough/);
  const bal = (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [erin.userId]))[0].b;
  assert.equal(bal, 5, "two crossposts x 10 PAT");
  const tx = await getQuery("SELECT type, points FROM transactions WHERE userId = ? ORDER BY type", [erin.userId]);
  assert.deepEqual(tx.map((t) => t.points), [-10, -10]);
  assert.ok(tx.every((t) => t.type.startsWith("feed crosspost ")));
  assert.equal((await xrows(orig)).filter((x) => x.room_id === X1).length, 0, "the unpaid one wasn't made");
  await store.setConfig({ price_post: 0 }, "test");
});

test("multi-pad crosspost: the old single-pad API still works the old way", async () => {
  await xpPads();
  const orig = await mkPost(U.alice, { title: "Old API", body: "o", community: ROOM_B });
  const before = (await xnotices(U.alice)).length;
  let r = await xpost(U.bob, orig, { community: slug(X1), title: "single" });
  assert.equal(r.status, 200);
  assert.ok(r.d.id && r.d.url === "/p/" + slug(X1) + "/posts/" + r.d.id + "/single" && r.d.pending === false && r.d.community && !("results" in r.d));
  assert.equal(r.d.community.id, X1);
  assert.equal((await store.getRow(r.d.id)).title, "single");
  assert.equal((await xnotices(U.alice)).length, before + 1);
  r = await xpost(U.carol, orig, { community: X1 });
  assert.equal(r.status, 409, "refusals are still HTTP errors");
  assert.match(r.d.error, /already been crossposted to Xp One/);
  assert.equal((await xpost(U.carol, orig, {})).status, 400);
  assert.equal((await xpost(U.carol, orig, { community: "p/no-such-pad" })).status, 400);
  // {communities: [...]} is an alias of {pads: [...]}
  r = await xpost(U.carol, orig, { communities: [X2] });
  assert.equal(r.status, 200);
  assert.equal(r.d.created, 1);
});
