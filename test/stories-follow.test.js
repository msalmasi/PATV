// Offline tests for 1.99bz: stories (stories.js - Pepe's captures as IG-style stories, seen state,
// privacy, missing files), following (follows.js - rooms + people, the Following feed, notices),
// per-post room announcements, HEIC/HEIF uploads (feedmedia.js -> heif-convert), the /feed page
// (no Clips & snaps tab, the story strip, the Following tab, the composer) and the profile Posts panel.
//   node --test test/stories-follow.test.js   (repo node_modules; the HEIC conversion test needs
//   libheif's heif-convert + heif-info on PATH and is skipped without them)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stories-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });
const express = require("express");
const sharp = require("sharp");
const ejs = require("ejs");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const fmedia = require(path.join(repo, "feedmedia"));
const web = require(path.join(repo, "feedweb"));
require(path.join(repo, "terms"))._setRequired(false);   // 1.99cc: the Terms gate has its own tests (tos-reports.test.js)
const follows = require(path.join(repo, "follows"));
const stories = require(path.join(repo, "stories"));
const layout = require(path.join(repo, "profilelayout"));

const ROOM_A = "PepeFrog.Room", ROOM_B = "plant_based_chatting";
let base, server, U = {};
const users = new Map();
async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, 5, '2026-01-01 00:00:00', 0)`, [id, name, extra.display || name, extra.class || "pleb", extra.camfrog || null]);
  const u = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, u);
  return u;
}
const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {});
// 1.99ci: every post lives in exactly one community - tests post to the Camfrog Lounge unless they pick one
// (community / rooms set), or send noCommunity: true to test the refusal.
const LOUNGE = "patv:lounge";
const withCommunity = (url, body) => (url === "/api/feed/posts" && body && typeof body === "object" && body.community === undefined && !body.rooms && !body.noCommunity
  ? { ...body, community: LOUNGE } : body);
async function call(method, url, u, body, headers) {
  body = withCommunity(url, body);
  const r = await fetch(base + url, { method, headers: headers || H(u), body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  let d = null;
  try { d = await r.clone().json(); } catch (e) { d = null; }
  return { status: r.status, d, r };
}
const post = (url, u, body, headers) => call("POST", url, u, body, headers);
const page = async (url, u) => (await fetch(base + url, { headers: u ? { "x-test-user": u.userId } : {} })).text();

let jpg;
async function capture(id, room, { subject = "froggy", by = "pepefan", ageMin = 5, kind = "photo", file = true, anon = 0, hours = 24 } = {}) {
  const t = Date.now() - ageMin * 60e3;
  const ext = kind === "photo" ? "jpg" : kind === "clip" ? "mp4" : "m4a";
  await runQuery(`INSERT INTO media (id, kind, ct, file, bytes, secs, subject, by_user, room, created, expires, deleted, anon)
                  VALUES (?, ?, ?, ?, 10, ?, ?, ?, ?, ?, ?, 0, ?)`,
                 [id, kind, kind === "photo" ? "image/jpeg" : "video/mp4", id + "." + ext, kind === "photo" ? 0 : 7, subject, by, room, t, t + hours * 3600e3, anon]);
  if (file) fs.writeFileSync(path.join(process.env.MEDIA_DIR, id + "." + ext), jpg);
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await require(path.join(repo, "media")).ready;
  await require(path.join(repo, "inbox")).ready;
  jpg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#0a0" } }).jpeg().toBuffer();
  U.owner = await mkUser("plantowner", { camfrog: "foamy1111" });
  U.admin = await mkUser("boss", { class: "Admin", camfrog: "bossfrog" });
  U.alice = await mkUser("alice", { camfrog: "alicecf", display: "Alice <b>" });
  U.bob = await mkUser("bob", { camfrog: "bobcf" });
  U.carol = await mkUser("carol", { camfrog: "carolcf" });
  U.dave = await mkUser("dave", { camfrog: "davecf" });
  U.shy = await mkUser("shy", { camfrog: "shycf" });
  await rooms.init();
  await rooms.setOwner(ROOM_B, "plantowner", "test");
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0 }, "test");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  require(path.join(repo, "pads")).register(app);                 // 1.99ck: old addresses 301 to /p/...
  web.register(app, { addUser, isBotToken: (t) => t === "bot" });
  require(path.join(repo, "bridge")).register(app, { addUser, isBotToken: (t) => t === "bot" });   // the pad page
  follows.register(app, { addUser });
  stories.register(app, { addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });
test.beforeEach(() => { store._gaps.clear(); follows._gaps.clear(); });

// ───────────────────────────── following ─────────────────────────────
test("follow: rooms and people, by id/slug/username; not yourself, not nothing; signed-in same-site JSON only", async () => {
  let r = await post("/api/follow", U.bob, { kind: "room", id: "plant-based-chatting" });
  assert.equal(r.status, 200); assert.equal(r.d.following, true); assert.equal(r.d.followers, 1);
  r = await post("/api/follow", U.bob, { kind: "user", id: "alice" });
  assert.equal(r.status, 200); assert.equal(r.d.followers, 1);
  assert.equal(await follows.isFollowing(U.bob.userId, "room", ROOM_B), true, "stored by room id, whatever the page sent");
  assert.equal(await follows.isFollowing(U.bob.userId, "user", U.alice.userId), true, "stored by userId");
  assert.equal((await post("/api/follow", U.bob, { kind: "user", id: "bob" })).status, 400, "not yourself");
  assert.equal((await post("/api/follow", U.bob, { kind: "user", id: "nobody-here" })).status, 404);
  assert.equal((await post("/api/follow", U.bob, { kind: "room", id: "no-such-room" })).status, 404);
  assert.equal((await post("/api/follow", U.bob, { kind: "tag", id: "x" })).status, 404);
  assert.equal((await post("/api/follow", null, { kind: "user", id: "alice" })).status, 401);
  assert.equal((await post("/api/follow", U.bob, { kind: "user", id: "alice" }, { "content-type": "application/json", "x-test-user": U.bob.userId })).status, 403, "needs X-Requested-With");
  assert.equal((await post("/api/follow", U.bob, { kind: "user", id: "alice" }, { ...H(U.bob), origin: "https://evil.example" })).status, 403, "cross-site refused");
  // idempotent follow, then unfollow
  follows._gaps.clear();
  r = await post("/api/follow", U.bob, { kind: "user", id: "alice", on: true });
  assert.equal(r.d.followers, 1);
  follows._gaps.clear();
  r = await post("/api/follow", U.carol, { kind: "user", id: "alice" });
  assert.equal(r.d.followers, 2);
  follows._gaps.clear();
  r = await post("/api/follow", U.carol, { kind: "user", id: "alice", on: false });
  assert.equal(r.d.following, false); assert.equal(r.d.followers, 1);
  assert.deepEqual(await follows.counts("user", U.bob.userId), { followers: 0, following: 2 });
});

test("follow lists are only ever the user's own; counts are public", async () => {
  await follows.follow(U.alice, "user", U.bob.userId, true);
  const mine = await call("GET", "/api/follow/mine", U.bob);
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.d.rooms.map((x) => x.id), [ROOM_B]);
  assert.deepEqual(mine.d.people.map((x) => x.username), ["alice"]);
  assert.deepEqual(mine.d.followers.map((x) => x.username), ["alice"]);
  assert.equal(mine.d.prefs.notify, false, "notices default off");
  assert.equal((await call("GET", "/api/follow/mine", null)).status, 401);
  // there's no route that takes someone else's id
  assert.equal((await call("GET", "/api/follow/mine?user=u_alice", U.carol)).d.people.length, 0, "carol gets carol's lists, not alice's");
  // the profile shows counts only
  const s = await web.profileSocial({ userId: U.alice.userId, username: "alice" }, U.carol);
  assert.deepEqual(s.counts, { followers: 1, following: 1 });
  assert.equal(s.following, false); assert.equal(s.self, false);
  const html = await ejs.renderFile(path.join(repo, "views/partials/profile-follow.ejs"), { social: s, usernameProfile: "alice", previewing: false });
  assert.match(html, /data-follow-kind="user" data-follow-id="alice"/);
  assert.ok(!html.includes("bob"), "no follower names on someone else's profile");
});

test("the Following feed: followed people + followed rooms, one row per post, owner removals respected, same sorts", async () => {
  // bob follows alice (person) and the plant room
  const a1 = (await post("/api/feed/posts", U.alice, { title: "alice main feed post" })).d.id;
  const a2 = (await post("/api/feed/posts", U.alice, { title: "alice in plant", rooms: [ROOM_B], global: false })).d.id;
  const d1 = (await post("/api/feed/posts", U.dave, { title: "dave in plant", rooms: [ROOM_B], global: false })).d.id;
  const d2 = (await post("/api/feed/posts", U.dave, { title: "dave elsewhere" })).d.id;
  const d3 = (await post("/api/feed/posts", U.dave, { title: "dave in plant then removed", rooms: [ROOM_B] })).d.id;
  await store.removeFromRoom(U.owner, d3, ROOM_B);
  const L = await store.list({ following: U.bob.userId, sort: "new", viewer: U.bob, limit: 50 });
  const ids = L.posts.map((p) => p.id);
  assert.ok(ids.includes(a1) && ids.includes(a2) && ids.includes(d1));
  assert.ok(!ids.includes(d2), "not followed, not in a followed room");
  assert.ok(!ids.includes(d3), "taken out of the followed room by its owner");
  assert.equal(ids.filter((x) => x === a2).length, 1, "a followed person's post in a followed room shows once");
  for (const sort of ["hot", "top", "new"]) assert.ok((await store.list({ following: U.bob.userId, sort, viewer: U.bob })).posts.length >= 3, sort);
  // author chips know who you follow
  assert.equal(L.posts.find((p) => p.id === a1).followingAuthor, true);
  assert.equal(L.posts.find((p) => p.id === d1).followingAuthor, false);
  // the page
  const html = await page("/feed?tab=following", U.bob);
  assert.ok(html.includes("alice main feed post") && html.includes("dave in plant") && !html.includes("dave elsewhere"));
  assert.ok(html.includes("only you see these lists") && html.includes("data-follow-notify"));
  assert.match(html, /aria-current="page">⭐ Following/);
  const out = await page("/feed?tab=following", null);
  assert.ok(out.includes("Sign in") && !out.includes("alice main feed post"));
  // a feed card's author chip has the Follow button (not on your own posts)
  const main = await page("/feed?sort=new", U.bob);
  assert.match(main, /data-follow-kind="user" data-follow-id="dave" aria-pressed="false"/);
  assert.match(main, /data-follow-kind="user" data-follow-id="alice" aria-pressed="true"/);
  const own = await page("/feed?sort=new", U.alice);
  assert.ok(!own.includes('data-follow-id="alice"'), "no Follow button on your own posts");
});

test("new-post notices: off by default; on = one inbox notice per post per follower, never the author", async () => {
  await follows.follow(U.carol, "user", U.dave.userId, true);
  await follows.follow(U.carol, "room", ROOM_B, true);
  const p1 = await store.create(U.dave.userId, { title: "quiet", rooms: [ROOM_B] }, { awaitNotices: true });
  assert.equal((await getQuery("SELECT * FROM inbox WHERE user_id = ? AND ref = ?", [U.carol.userId, "follow-post:" + p1.id])).length, 0, "default off");
  const r = await post("/api/follow/prefs", U.carol, { notify: true });
  assert.equal(r.d.notify, true);
  const p2 = await store.create(U.dave.userId, { title: "loud <x>", rooms: [ROOM_B] }, { awaitNotices: true });
  const n = await getQuery("SELECT * FROM inbox WHERE user_id = ? AND ref = ?", [U.carol.userId, "follow-post:" + p2.id]);
  assert.equal(n.length, 1, "followed person AND room: still one notice");
  assert.equal(n[0].kind, "follow");
  assert.equal(n[0].link, "/feed/p/" + p2.id);
  assert.match(n[0].title, /dave posted in p\/plant-based-chatting/);
  await follows.setPrefs(U.dave, { notify: true });
  await follows.follow(U.dave, "room", ROOM_B, true);
  const p3 = await store.create(U.dave.userId, { title: "mine", rooms: [ROOM_B] }, { awaitNotices: true });
  assert.equal((await getQuery("SELECT * FROM inbox WHERE user_id = ? AND ref = ?", [U.dave.userId, "follow-post:" + p3.id])).length, 0, "never the author");
  const nsfw = await store.create(U.dave.userId, { title: "spicy title", nsfw: true, community: LOUNGE }, { awaitNotices: true });
  const nn = await getQuery("SELECT * FROM inbox WHERE user_id = ? AND ref = ?", [U.carol.userId, "follow-post:" + nsfw.id]);
  assert.equal(nn.length, 1); assert.ok(!/spicy/.test(nn[0].title + nn[0].body), "an NSFW post's text isn't in the notice");
});

// ───────────────────────────── room announcements ─────────────────────────────
// the composer's announce block for one pad (1.99cu: one per pad, shown for the picked one)
const annBlock = (html, id) => {
  const i = html.indexOf(`data-ann-for="${id}"`);
  if (i < 0) return null;
  const rest = html.slice(i + 10);
  const end = Math.min(...[rest.indexOf("data-ann-for="), rest.indexOf("</div>")].filter((x) => x >= 0));
  return rest.slice(0, end);
};
test("room announcements: 1.99cu ON by default for Camfrog pads; the owner's explicit off is the gate; the author's tick decides", async () => {
  const pend = async (pid) => (await getQuery("SELECT * FROM feed_mentions WHERE post_id = ?", [pid])).length;
  assert.equal(await store.mentionOn(ROOM_B), true, "default ON (never set)");
  assert.equal(await store.mentionOn(ROOM_A), true, "house Camfrog pad: default ON too");
  assert.equal(await store.mentionOn(LOUNGE), false, "a site pad has no Camfrog room");
  let p = await store.create(U.alice.userId, { title: "default on", rooms: [ROOM_B], announce: [ROOM_B] });
  assert.equal(await pend(p.id), 1, "announced with no owner action");
  p = await store.create(U.alice.userId, { title: "unticked", rooms: [ROOM_B], announce: [] });
  assert.equal(await pend(p.id), 0, "author unticked it");
  p = await store.create(U.alice.userId, { title: "ticked", community: ROOM_B, announce: [ROOM_B, ROOM_A] });
  const m = await getQuery("SELECT room_id FROM feed_mentions WHERE post_id = ?", [p.id]);
  assert.deepEqual(m.map((x) => x.room_id), [ROOM_B], "only the post's community (1.99ci: one per post)");
  p = await store.create(U.alice.userId, { title: "site pad", community: LOUNGE, announce: [LOUNGE] });
  assert.equal(await pend(p.id), 0, "no Camfrog room: never");
  p = await store.create(U.alice.userId, { title: "old page", rooms: [ROOM_B] });
  assert.equal(await pend(p.id), 1, "no announce list (an older page): announced as before");
  // the owner's explicit OFF is the gate
  await store.setMention(U.owner, ROOM_B, false);
  p = await store.create(U.alice.userId, { title: "switch off", rooms: [ROOM_B], announce: [ROOM_B] });
  assert.equal(await pend(p.id), 0, "owner switch off: never, whatever the author ticked");
  await store.setMention(U.owner, ROOM_B, true);
});

test("room announcements: the composer always shows the box - enabled + ticked, or greyed out with the reason", async () => {
  await store.setMention(U.owner, ROOM_B, true);
  let html = await page("/feed", U.alice);
  let b = annBlock(html, ROOM_B);
  assert.ok(b, "Camfrog pad with announcements on");
  assert.match(b, /name="announce" value="plant_based_chatting" checked>/);
  assert.ok(!/disabled/.test(b));
  b = annBlock(html, LOUNGE);
  assert.ok(b, "a site pad still shows the box");
  assert.match(b, /name="announce" value="patv:lounge" disabled>/);
  assert.match(b, /Site pad, no Camfrog room/);
  assert.match(html, /accept="[^"]*image\/heic[^"]*\.heic/);
  // off for this pad: greyed out; only owners/admins get the "turn on in Moderate" link
  await store.setMention(U.owner, ROOM_B, false);
  b = annBlock(await page("/feed", U.alice), ROOM_B);
  assert.match(b, /disabled>/); assert.match(b, /Announcements are off for this pad/);
  assert.ok(!/turn on in Pad settings/.test(b), "not for a regular member");
  b = annBlock(await page("/feed", U.owner), ROOM_B);
  assert.match(b, /Announcements are off for this pad/); assert.match(b, /href="\/p\/[^"]+\/settings#announce">turn on in Pad settings/);   // 1.99dc: the hub
  b = annBlock(await page("/feed", U.admin), ROOM_B);
  assert.match(b, /turn on in Pad settings/, "admins too");
  await store.setMention(U.owner, ROOM_B, true);
  // Pepe isn't in the room: greyed out, and the server won't queue it either
  store._setPepeIn((id) => (id === ROOM_B ? false : null));
  try {
    b = annBlock(await page("/feed", U.alice), ROOM_B);
    assert.match(b, /disabled>/); assert.match(b, /Pepe isn&#39;t in this room right now/);
    assert.deepEqual(await store.announceState(ROOM_B, U.alice), { ok: false, code: "away", why: "Pepe isn't in this room right now", manage: false });
    const p = await store.create(U.alice.userId, { title: "pepe away", rooms: [ROOM_B], announce: [ROOM_B] });
    assert.equal((await getQuery("SELECT * FROM feed_mentions WHERE post_id = ?", [p.id])).length, 0);
  } finally { store._setPepeIn(null); }
  assert.equal((await store.announceState(ROOM_B, U.alice)).ok, true);
  // the pad page preselects it: the picked pad's block is visible (not .hide)
  html = await page("/p/" + rooms.getCached(ROOM_B).slug, U.alice);
  assert.match(html, /class="fc-ann-w" data-ann-for="plant_based_chatting"/);
  // the communities API (crosspost dialog) carries the same state
  const c = await (await fetch(base + "/api/feed/communities", { headers: { "x-test-user": U.alice.userId } })).json();
  assert.equal(c.communities.find((x) => x.id === ROOM_B).ann.ok, true);
  assert.equal(c.communities.find((x) => x.id === LOUNGE).ann.code, "site");
});

test("room announcements: 1.99cu migration - old default rows go ON, explicit offs (log shows on) stay OFF, runs once", async () => {
  const R1 = "Mig.Ann.One", R2 = "Mig.Ann.Two", R3 = "Mig.Ann.Three";
  await store.kvSet("mention:" + R1, "0");                          // never switched on: the old default
  await store.kvSet("mention:" + R2, "0");                          // switched on, then off
  await store.kvSet("mention:" + R3, "1");                          // on
  await runQuery("INSERT INTO room_events (room_id, ts, what, actor, detail) VALUES (?, ?, 'feed-mention', 'plantowner', 'on')", [R2, Date.now() - 5000]);
  await runQuery("INSERT INTO room_events (room_id, ts, what, actor, detail) VALUES (?, ?, 'feed-mention', 'plantowner', 'off')", [R2, Date.now() - 4000]);
  await store.kvSet("mention_v1", "");
  const r = await store.migrateMentionDefault();
  assert.ok(r.on.includes(R1)); assert.ok(r.kept.includes(R2)); assert.ok(r.marked.includes(R3));
  assert.equal(await store.mentionOn(R1), true);
  assert.equal(await store.mentionOn(R2), false);
  assert.equal(await store.mentionOn(R3), true);
  assert.equal(await store.migrateMentionDefault(), null, "runs once");
});

test("room announcements: 1.99cu each line links the post itself; several posts link each, or the newest + the pad", async () => {
  await store.setConfig({ mention_gap_min: 10 }, "test");
  await store.setMention(U.owner, ROOM_B, true);
  await runQuery("UPDATE feed_mentions SET sent_at = 1 WHERE sent_at IS NULL");
  await runQuery("DELETE FROM feed_kv WHERE key = ?", ["mention_at:" + ROOM_B]);
  const site = "https://publicaccess.tv";
  const a = await store.create(U.alice.userId, { title: "one", rooms: [ROOM_B], announce: [ROOM_B] });
  let m = await store.takeMentions(site);
  assert.equal(m.length, 1);
  assert.ok(m[0].text.endsWith(`${site}/feed/p/${a.id}`), m[0].text);
  // two posts fit: both links
  await runQuery("DELETE FROM feed_kv WHERE key = ?", ["mention_at:" + ROOM_B]);
  const b = await store.create(U.alice.userId, { title: "two", rooms: [ROOM_B], announce: [ROOM_B] });
  const c = await store.create(U.bob.userId, { title: "three", rooms: [ROOM_B], announce: [ROOM_B] });
  m = await store.takeMentions(site);
  assert.equal(m.length, 1);
  assert.ok(m[0].text.startsWith("📌 2 new posts on p/"), m[0].text);
  assert.ok(m[0].text.includes(`${site}/feed/p/${b.id}`) && m[0].text.includes(`${site}/feed/p/${c.id}`), m[0].text);
  // too many to fit one line: the newest post + the pad page
  await runQuery("DELETE FROM feed_kv WHERE key = ?", ["mention_at:" + ROOM_B]);
  const ids = [];
  for (let i = 0; i < 9; i++) ids.push((await store.create(U.alice.userId, { title: "bulk " + i, rooms: [ROOM_B], announce: [ROOM_B] })).id);
  m = await store.takeMentions(site);
  assert.equal(m.length, 1);
  assert.ok(m[0].text.length <= 300, m[0].text.length);
  assert.ok(m[0].text.includes(`newest: ${site}/feed/p/${ids[8]}`), m[0].text);
  assert.ok(m[0].text.includes(`all: ${site}/p/`), m[0].text);
});

test("room announcements: crossposts announce in the target pad unless the author unticked it; greyed pads never", async () => {
  await store.setMention(U.owner, ROOM_B, true);
  const orig = await store.create(U.alice.userId, { title: "xp me", community: LOUNGE });
  const pend = async (pid) => (await getQuery("SELECT * FROM feed_mentions WHERE post_id = ?", [pid])).length;
  let r = await post(`/api/feed/posts/${orig.id}/crosspost`, U.bob, { pads: [ROOM_B], announce: [] });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(await pend(r.d.results[0].id), 0, "unticked in the dialog");
  const orig2 = await store.create(U.alice.userId, { title: "xp me too", community: LOUNGE });
  r = await post(`/api/feed/posts/${orig2.id}/crosspost`, U.bob, { pads: [ROOM_B], announce: [ROOM_B] });
  assert.equal(await pend(r.d.results[0].id), 1, "ticked");
  const orig3 = await store.create(U.alice.userId, { title: "old dialog", community: LOUNGE });
  r = await post(`/api/feed/posts/${orig3.id}/crosspost`, U.bob, { pads: [ROOM_B] });
  assert.equal(await pend(r.d.results[0].id), 1, "no announce list (older page): announced as before");
});

// ───────────────────────────── stories ─────────────────────────────
test("stories: a room's last 24 h of captures, oldest first; old, deleted and file-less captures left out", async () => {
  await capture("aa000001", ROOM_A, { ageMin: 30 });
  await capture("aa000002", ROOM_A, { ageMin: 10, kind: "clip" });
  await capture("aa000003", ROOM_A, { ageMin: 25 * 60, hours: 72 });          // still live but older than 24 h
  await capture("aa000004", ROOM_A, { ageMin: 5, file: false });             // the row outlived its file
  await capture("aa000005", ROOM_A, { ageMin: 3 });
  await runQuery("UPDATE media SET deleted = 1 WHERE id = 'aa000005'");
  await capture("bb000001", ROOM_B, { ageMin: 2, kind: "audio" });
  const S = await stories.forViewer(U.bob);
  const A = S.find((r) => r.id === ROOM_A), B = S.find((r) => r.id === ROOM_B);
  assert.deepEqual(A.items.map((c) => c.id), ["aa000001", "aa000002"]);
  assert.equal(A.count, 2); assert.equal(A.cover, "/media/aa000001/raw");
  assert.equal(A.items[1].kind, "clip"); assert.equal(A.items[1].src, "/media/aa000002/raw");
  assert.equal(B.items[0].kind, "audio"); assert.equal(B.cover, null);
  assert.equal(S[0].id, ROOM_B, "newest first (both unseen)");
  assert.equal(A.href, "/p/pepefrog-room");
  // the room feed strip uses the same source
  const caps = await web.captures(ROOM_A, 24);
  assert.deepEqual(caps.map((c) => c.id), ["aa000002", "aa000001"]);
});

test("stories privacy: signed-out = rooms + counts only, the API refuses; anonymous and private subjects are 'someone'", async () => {
  const out = await stories.forViewer(null);
  assert.ok(out.length >= 2);
  for (const r of out) { assert.equal(r.items, undefined); assert.equal(r.cover, null); }
  assert.equal((await call("GET", "/api/stories", null)).status, 401);
  const ok = await call("GET", "/api/stories", U.bob);
  assert.equal(ok.status, 200); assert.ok(ok.d.rooms.length >= 2);
  // Pepe flagged the subject private
  await capture("cc000001", ROOM_A, { subject: "", anon: 1, ageMin: 1 });
  // a linked account that hides its Analytics
  await layout.save(U.shy.userId, { hidden: ["analytics"] });
  await capture("cc000002", ROOM_A, { subject: "ShyCF", by: "shycf", ageMin: 1 });
  const A = (await stories.forViewer(U.bob)).find((r) => r.id === ROOM_A);
  const c1 = A.items.find((c) => c.id === "cc000001"), c2 = A.items.find((c) => c.id === "cc000002");
  assert.equal(c1.subject, null);
  assert.equal(c2.subject, null, "hidden analytics: not named"); assert.equal(c2.by, null);
  assert.equal(A.items.find((c) => c.id === "aa000001").subject, "froggy");
  // the homepage / feed strip never puts pictures in a visitor's page
  const html = await ejs.renderFile(path.join(repo, "views/partials/story-strip.ejs"), { story: { rooms: out, caps: [], signed: false }, heading: "Stories", next: "/" });
  assert.ok(!html.includes("/media/") && !html.includes("ss-data") && html.includes('data-signed=""'));
  const inHtml = await ejs.renderFile(path.join(repo, "views/partials/story-strip.ejs"), { story: { rooms: await stories.forViewer(U.bob), caps: [], signed: true }, heading: "Stories", next: "/" });
  assert.ok(inHtml.includes("ss-data") && inHtml.includes("/media/aa000001/raw"));
  assert.ok(!/<\/script>[^]*ss-data/.test(inHtml.split('class="ss-data">')[1].split("</script>")[0]), "inline JSON can't close its script tag");
});

test("stories seen state: per user per room, only forwards, never ahead of now; rings flip; the API is same-site JSON", async () => {
  let S = await stories.forViewer(U.carol);
  const A = S.find((r) => r.id === ROOM_A);
  assert.equal(A.unseen, true);
  const r = await post("/api/stories/seen", U.carol, { room: ROOM_A, upto: A.latest });
  assert.equal(r.status, 200); assert.equal(r.d.upto, A.latest);
  assert.equal((await post("/api/stories/seen", U.carol, { room: ROOM_A, upto: 5 })).d.upto, A.latest, "never backwards");
  const ahead = await post("/api/stories/seen", U.carol, { room: ROOM_A, upto: Date.now() + 86400e3 });
  assert.ok(ahead.d.upto <= Date.now(), "clamped to now");
  S = await stories.forViewer(U.carol);
  assert.equal(S.find((x) => x.id === ROOM_A).unseen, false);
  assert.equal(S[S.length - 1].id, ROOM_A, "seen rooms go after unseen ones");
  assert.equal((await stories.forViewer(U.bob)).find((x) => x.id === ROOM_A).unseen, true, "bob's ring is his own");
  assert.equal((await post("/api/stories/seen", U.carol, { room: "<bad room>", upto: 1 })).status, 400);
  assert.equal((await post("/api/stories/seen", null, { room: ROOM_A, upto: 1 })).status, 401);
  assert.equal((await post("/api/stories/seen", U.carol, { room: ROOM_A, upto: 1 }, { "content-type": "application/json", "x-test-user": U.carol.userId })).status, 403);
  // a newer capture turns the ring back on
  await capture("dd000001", ROOM_A, { ageMin: 0 });
  assert.equal((await stories.forViewer(U.carol)).find((x) => x.id === ROOM_A).unseen, true);
});

test("/feed: no Clips & snaps tab (old links redirect), the story strip on top; room filter = that room's thumbnails", async () => {
  let r = await call("GET", "/feed?tab=captures&room=pepefrog-room&kind=clip", U.bob);
  assert.equal(r.status, 301); assert.equal(r.r.headers.get("location"), "/p/pepefrog-room", "1.99ck: a pad is its own page");
  r = await call("GET", "/feed?tab=clips", U.bob);
  assert.equal(r.r.headers.get("location"), "/feed");
  const html = await page("/feed", U.bob);
  assert.ok(!/Clips &amp; snaps/.test(html) && !html.includes("tab=captures"));
  assert.match(html, /class="ss-c[^"]*" data-story-room="PepeFrog.Room"/);
  assert.ok(html.includes('id="fdTop"') && html.includes('id="fdList"') && html.includes("data-swap"));
  const room = await page("/p/pepefrog-room", U.bob);
  assert.match(room, /class="ss-t k-photo" href="\/media\/aa000001" data-story-room="PepeFrog.Room" data-story-item="aa000001"/);
  assert.ok(!room.includes("aa000004"), "the file-less capture isn't in the strip");
  // room page section: strip + follow button + follower count
  const F = await web.roomFeed(ROOM_A, U.bob, {});
  const part = await ejs.renderFile(path.join(repo, "views/partials/room-feed.ejs"), { feed: F, fx: web.fx, embeds: require(path.join(repo, "stageembed")), host: "test",
                                                                                  room: { name: "Pepe's Pad", slug: "pepefrog-room" } });
  assert.match(part, /data-story-item="aa000001"/);
  assert.match(room, /data-follow-kind="room" data-follow-id="PepeFrog.Room"/, "1.99ck: Follow this pad sits in the pad header");
  assert.match(part, /feed-composer\.js/);
  const Fout = await web.roomFeed(ROOM_A, null, {});
  const partOut = await ejs.renderFile(path.join(repo, "views/partials/room-feed.ejs"), { feed: Fout, fx: web.fx, embeds: require(path.join(repo, "stageembed")), host: "test",
                                                                                     room: { name: "Pepe's Pad", slug: "pepefrog-room" } });
  assert.ok(!partOut.includes("/media/aa000001") && partOut.includes('data-story-room="PepeFrog.Room"'), "visitors: the circle, no pictures");
  const roomOut = await page("/p/pepefrog-room", null);
  assert.match(roomOut, /class="fw-btn" href="\/login\?next=%2Fp%2Fpepefrog-room"/, "visitors' Follow button is a sign-in link");
});

// ───────────────────────────── profile Posts panel ─────────────────────────────
test("profile Posts panel: a layout section (public/hidden), the latest posts, NSFW pictures never shown, escaped", async () => {
  assert.ok(layout.SECTION_IDS.includes("posts"));
  const L = layout.sanitize({ order: ["badges"], hidden: [] });
  assert.ok(L.order.includes("posts"), "older saved layouts get the new section");
  const hid = layout.view({ order: L.order, hidden: ["posts"], priv: [] }, {});
  assert.equal(hid.show("posts"), false, "hidden from visitors");
  assert.equal(layout.view({ order: L.order, hidden: ["posts"], priv: [] }, { owner: true }).show("posts"), true, "the owner still sees it (greyed)");
  const none = await web.profileSocial({ userId: U.alice.userId, username: "alice" }, null, { show: false });
  assert.equal(none.posts.length, 0, "hidden: the posts aren't even loaded");
  // an NSFW picture post
  const im = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#f0f" } }).png().toBuffer();
  const out = await fmedia.processImage(await (async () => { const f = path.join(tmp, "p.png"); fs.writeFileSync(f, im); return f; })(), "png");
  const att = "a".repeat(24);
  await runQuery(`INSERT INTO feed_attachments (id, owner_id, kind, ct, file, thumb, w, h, bytes, state, created, size_declared, received)
                  VALUES (?, ?, 'image', 'image/webp', ?, ?, 32, 32, 10, 'ready', ?, 10, 10)`, [att, U.alice.userId, out.file, out.thumb, Date.now()]);
  await store.create(U.alice.userId, { title: "nsfw pic <script>", attachments: [att], nsfw: true, community: LOUNGE });
  const s = await web.profileSocial({ userId: U.alice.userId, username: "alice" }, null);
  assert.ok(s.posts.length >= 1 && s.posts.length <= 10);   // 1.99df: the profile feed pages 10 at a time
  const html = await ejs.renderFile(path.join(repo, "views/partials/profile-posts.ejs"), { social: s, usernameProfile: "alice", displayname: "Alice", isMe: false });
  assert.ok(html.includes("/feed?by=alice"));
  assert.ok(!html.includes(out.thumb) && !html.includes(out.file), "no NSFW picture");
  assert.ok(html.includes("nsfw pic &lt;script&gt;") && !html.includes("<script>"), "escaped");
  // a report-hidden post isn't listed for visitors
  const hidden = await store.create(U.alice.userId, { title: "hidden by reports", community: LOUNGE });
  await store.adminSet(U.admin, hidden.id, { hidden: true });
  assert.ok(!(await web.profileSocial({ userId: U.alice.userId, username: "alice" }, U.bob)).posts.some((p) => p.id === hidden.id));
});

// ───────────────────────────── HEIC ─────────────────────────────
test("HEIC/HEIF: brands by magic bytes (AVIF still AVIF); a missing decoder is a clear refusal", async () => {
  const ftyp = (major, compat) => { const b = Buffer.alloc(16 + compat.length * 4 + 8); b.writeUInt32BE(16 + compat.length * 4, 0); b.write("ftyp", 4, "latin1"); b.write(major, 8, "latin1"); compat.forEach((c, i) => b.write(c, 16 + i * 4, "latin1")); return b; };
  for (const br of ["heic", "heix", "hevc", "heim", "heis", "hevx"]) assert.equal(fmedia.sniff(ftyp(br, ["mif1", "heic"])).fmt, "heic", br);
  assert.equal(fmedia.sniff(ftyp("mif1", ["mif1", "heic", "miaf"])).fmt, "heic", "mif1 + heic");
  assert.equal(fmedia.sniff(ftyp("msf1", ["msf1", "hevc"])).fmt, "heic");
  assert.equal(fmedia.sniff(ftyp("mif1", ["mif1", "avif", "miaf"])).fmt, "avif", "mif1 + avif is AVIF");
  assert.equal(fmedia.sniff(ftyp("avif", ["mif1"])).fmt, "avif");
  assert.equal(fmedia.sniff(fs.readFileSync(path.join(__dirname, "fixtures/sample-small.heic"))).fmt, "heic", "a real iPhone-style HEIC");
  const saved = process.env["HEIF-INFO_PATH"];
  process.env["HEIF-INFO_PATH"] = path.join(tmp, "no-such-heif-info");
  process.env.FEED_NO_PRLIMIT = "1"; process.env.FEED_NO_NICE = "1";
  try {
    await assert.rejects(fmedia.processImage(path.join(__dirname, "fixtures/sample-small.heic"), "heic"), (e) => e.refuse && /HEIC|export it as JPEG/.test(e.message));
  } finally { if (saved === undefined) delete process.env["HEIF-INFO_PATH"]; else process.env["HEIF-INFO_PATH"] = saved; delete process.env.FEED_NO_PRLIMIT; delete process.env.FEED_NO_NICE; }
  assert.equal(fs.readdirSync(path.join(fmedia.dir(), "tmp")).filter((f) => f.startsWith("heic-")).length, 0, "temp dir cleaned up");
});

let heifOk = false;
try { execFileSync("heif-convert", [], { stdio: "ignore" }); heifOk = true; } catch (e) { heifOk = !!(e && e.status !== undefined && e.code !== "ENOENT"); }
test("HEIC upload: a real HEIC goes through the chunked pipeline, comes out a webp with no EXIF/GPS", { skip: heifOk ? false : "heif-convert not installed" }, async () => {
  const buf = fs.readFileSync(path.join(__dirname, "fixtures/sample-small.heic"));
  assert.ok(buf.includes(Buffer.from("Exif")), "the sample carries EXIF (with GPS)");
  const o = await post("/api/feed/uploads", U.alice, { kind: "image", size: buf.length });
  assert.equal(o.status, 200, JSON.stringify(o.d));
  const put = await fetch(`${base}/api/feed/uploads/${o.d.id}?offset=0`, { method: "PUT", body: buf,
    headers: { "content-type": "application/octet-stream", "x-requested-with": "fetch", "x-test-user": U.alice.userId } });
  assert.equal(put.status, 200);
  assert.equal((await post(`/api/feed/uploads/${o.d.id}/finish`, U.alice, {})).status, 200);
  let s;
  for (let i = 0; i < 200; i++) { s = await call("GET", `/api/feed/uploads/${o.d.id}`, U.alice); if (s.d.state !== "processing") break; await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(s.d.state, "ready", s.d.error);
  const a = (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [o.d.id]))[0];
  assert.equal(a.ct, "image/webp"); assert.equal(a.w, 320); assert.equal(a.h, 240);
  const outBuf = fs.readFileSync(fmedia.filePath(a.file));
  const meta = await sharp(outBuf).metadata();
  assert.equal(meta.format, "webp"); assert.equal(meta.exif, undefined); assert.equal(meta.xmp, undefined);
  assert.ok(!outBuf.includes(Buffer.from("Exif")) && !outBuf.includes(Buffer.from("GPS")));
  const px = await sharp(outBuf).extract({ left: 4, top: 4, width: 1, height: 1 }).raw().toBuffer();
  assert.ok(px[0] > 200 && px[1] < 60 && px[2] < 60, "the red marker is still top-left (orientation kept)");
});
