// Offline tests for 1.99df: profile posting (Reddit's u/ model) - a member's profile is a pad of its own
// (rooms.js platform "profile", id user:<userId>, slug u-<username>).
//   - only the owner posts there ("u/<me>" / "profile" in the composer; not other members, not staff, not by pad id)
//   - profile pads stay out of the Pads list, the pickers' pad list, Pepe's owner sync and pad follows
//   - privacy: the layout hiding "posts" = the profile feed isn't loaded for visitors
//   - All / Following: in All by default, the per-post "Also show in All" off keeps it out of All (and Hot) but not
//     out of Following, the profile or the post page; the author can switch it later
//   - crossposts both ways: a profile post into a pad, a pad post to your own profile ("share to profile"); nobody
//     crossposts into someone else's profile
//   - the owner's moderation scope: delete comments / lock / block commenters on their profile - nothing elsewhere
//   - u/<username> autolinks (known names), /u/<name> and /p/u-<name> redirect to the profile
//   - Pepe answers mentions on profile posts (the scope rides on the sync), and the owner's "Pepe can reply on my
//     profile" switch turns that off; the automod is off for profiles until the admins switch it on for all
//   - the profile feed partial renders for the owner (composer, "Your profile" picked, settings) and for visitors
//   NODE_PATH=G:/PATV/node_modules node --test test/profile-posts.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "profileposts-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");

const express = require("express");
const ejs = require("ejs");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const web = require(path.join(repo, "feedweb"));
const follows = require(path.join(repo, "follows"));
const pads = require(path.join(repo, "pads"));
const PF = require(path.join(repo, "pepefeed"));
const AM = require(path.join(repo, "feedautomod"));
const layout = require(path.join(repo, "profilelayout"));
require(path.join(repo, "terms"))._setRequired(false);

const ROOM = "plant_based_chatting", OTHER = "Side.Room";
let base, server, U = {};
const users = new Map();

async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, ?, ?, 0)`,
                 [id, name, extra.display || name, extra.class || "pleb", extra.camfrog || null, extra.level || 0, "2026-01-01 00:00:00"]);
  const u = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, u);
  return u;
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery(`CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ct TEXT NOT NULL, file TEXT NOT NULL, bytes INTEGER, secs REAL, subject TEXT,
                  by_user TEXT, room TEXT, created INTEGER, expires INTEGER, deleted INTEGER DEFAULT 0)`);
  U.owner = await mkUser("plantowner", { camfrog: "foamy1111" });
  U.admin = await mkUser("boss", { class: "Admin", camfrog: "bossfrog" });
  U.alice = await mkUser("alice", { camfrog: "alicecf" });
  U.bob = await mkUser("bob", { camfrog: "bobcf" });
  U.carol = await mkUser("carol", { camfrog: "carolcf" });
  await rooms.init();
  await rooms.addRoom(OTHER, "Side Room", "test");
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0, comments_per_hour: 1000 }, "test");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  pads.register(app);
  web.register(app, { addUser, isBotToken: (t) => t === "bot" });
  follows.register(app, { addUser });
  PF.register(app, { addUser, isBotToken: (t) => t === "bot" });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });
test.beforeEach(() => { store._gaps.clear(); });

const H = (u, extra = {}) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {}, extra);
async function call(method, url, u, body, extra) {
  const r = await fetch(base + url, { method, headers: H(u, extra), body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, text, location: r.headers.get("location") };
}
const post = (url, u, body) => call("POST", url, u, body);
async function mkPost(u, body) {
  const r = await post("/api/feed/posts", u, body);
  assert.equal(r.status, 200, JSON.stringify(r.d));
  return r.d.id;
}
const ids = (L) => L.posts.map((p) => p.id);
const viewer = (u) => store.account(u.userId);
const alicePad = () => rooms.profileId(U.alice.userId);

// ───────────────────────────── posting ─────────────────────────────
test("only the owner can post to a profile; the pad is made on the first post and is a profile pad", async () => {
  assert.equal(await rooms.profileOf(U.alice.userId), null, "no profile pad before the first profile post");
  const id = await mkPost(U.alice, { title: "hello from my profile", community: "u/alice" });
  const P = await rooms.profileOf(U.alice.userId);
  assert.ok(P, "made on first use");
  assert.equal(P.id, "user:u_alice");
  assert.equal(P.platform, "profile");
  assert.equal(P.slug, "u-alice");
  assert.deepEqual(P.profile, { userId: U.alice.userId, username: "alice" });
  assert.equal(P.owner.userId, U.alice.userId);
  const p = await store.get(id, await viewer(U.alice));
  assert.equal(p.rooms.length, 1);
  assert.equal(p.rooms[0].id, P.id);
  assert.equal(p.rooms[0].profile, "alice");
  assert.equal(p.rooms[0].label, "u/alice");
  assert.equal(p.onProfile, true);
  assert.equal(p.inAll, true, "Also show in All defaults on");
  // "profile" works too (the poster's own)
  await mkPost(U.alice, { body: "second", community: "profile" });
  // nobody else: by name, by pad id, by slug - and not staff either
  for (const k of ["u/alice", P.id, "u-alice", "p/u-alice"]) {
    const r = await post("/api/feed/posts", U.bob, { body: "intruder", community: k });
    assert.equal(r.status, 403, k + " " + JSON.stringify(r.d));
    assert.match(r.d.error, /Only alice can post on their profile/);
  }
  const ra = await post("/api/feed/posts", U.admin, { body: "staff too", community: "u/alice" });
  assert.equal(ra.status, 403, "not even an admin posts on someone's profile");
  // and a profile for someone who never posted to theirs isn't made by others' attempts
  const rc = await post("/api/feed/posts", U.bob, { body: "x", community: "u/carol" });
  assert.equal(rc.status, 403);
  assert.equal(await rooms.profileOf(U.carol.userId), null);
});

test("profile pads stay out of the Pads list, the pad pickers, Pepe's owner sync and pad follows", async () => {
  await mkPost(U.alice, { body: "on my profile", community: "u/alice" });
  assert.ok(!(await rooms.list()).some((r) => r.platform === "profile"), "rooms.list()");
  assert.ok(!(await rooms.ownersForPepe()).some((r) => r.id.startsWith("user:")), "ownersForPepe()");
  assert.ok(!(await rooms.ownedBy(U.alice.userId)).length, "ownedBy() - alice owns no pad");
  assert.ok(!(await store.communities(await viewer(U.bob))).some((c) => c.id.startsWith("user:")), "communities()");
  // the composer: "Your profile" first, for its owner only
  const cA = await web.composerFor(await viewer(U.alice), null);
  assert.equal(cA.rooms[0].id, "u/alice");
  assert.equal(cA.rooms[0].profile, true);
  assert.equal(cA.rooms.filter((r) => r.profile).length, 1);
  const cB = await web.composerFor(await viewer(U.bob), null);
  assert.equal(cB.rooms[0].id, "u/bob", "bob sees HIS profile, never alice's");
  assert.ok(!cB.rooms.some((r) => r.id === "u/alice" || r.id === alicePad()));
  // on the profile page the composer has it picked
  assert.equal((await web.composerFor(await viewer(U.alice), "profile")).room, "u/alice");
  // the crosspost dialog's list: "Your profile" first
  const r = await call("GET", "/api/feed/communities", U.bob);
  assert.equal(r.d.communities[0].id, "u/bob");
  assert.equal(r.d.communities[0].label, "u/bob");
  assert.ok(!r.d.communities.some((c) => c.id === alicePad()));
  // following a profile pad as a pad: no (follow the person)
  const f = await post("/api/follow", U.bob, { kind: "room", id: alicePad() });
  assert.equal(f.status, 404);
});

// ───────────────────────────── privacy ─────────────────────────────
test("privacy: when the layout hides Posts, visitors get no profile feed (nothing loaded)", async () => {
  await mkPost(U.alice, { body: "private-ish", community: "u/alice" });
  const hidden = { order: layout.SECTION_IDS, hidden: ["posts"] };
  const asVisitor = layout.view(hidden, { owner: false, admin: false });
  assert.equal(asVisitor.show("posts"), false);
  const S = await web.profileSocial({ userId: U.alice.userId, username: "alice" }, U.bob, { show: asVisitor.show("posts") });
  assert.equal(S.posts.length, 0);
  assert.equal(S.composer, null);
  const S2 = await web.profileSocial({ userId: U.alice.userId, username: "alice" }, U.bob, { show: false, query: { pview: "profile" } });
  assert.equal(S2.posts.length, 0, "the Profile view too");
  // the owner still sees it (greyed out on the page) with the composer
  const asOwner = layout.view(hidden, { owner: true });
  assert.equal(asOwner.show("posts"), true);
  const So = await web.profileSocial({ userId: U.alice.userId, username: "alice" }, U.alice, { show: asOwner.show("posts"), query: { pview: "profile" } });
  assert.ok(So.posts.length > 0);
  assert.ok(So.composer);
  assert.equal(So.composer.room, "u/alice");
  assert.ok(So.settings, "the owner's profile settings");
  // a public Posts section: visitors see the feed, no composer, no settings
  const Sv = await web.profileSocial({ userId: U.alice.userId, username: "alice" }, U.bob, { show: true, query: { pview: "profile" } });
  assert.ok(Sv.posts.length > 0);
  assert.ok(Sv.posts.every((p) => p.onProfile));
  assert.equal(Sv.composer, null);
  assert.equal(Sv.settings, null);
});

// ───────────────────────────── All / Following ─────────────────────────────
test("All / Following: shown in All by default; 'Also show in All' off keeps it out of All only; the author can flip it", async () => {
  await follows.follow(U.carol, "user", U.alice.userId, true);
  const inAll = await mkPost(U.alice, { title: "everyone sees this", community: "u/alice" });
  const notAll = await mkPost(U.alice, { title: "followers only", community: "u/alice", inAll: false });
  const all = ids(await store.list({ sort: "new", viewer: await viewer(U.bob), limit: 100 }));
  assert.ok(all.includes(inAll), "a profile post is in All by default");
  assert.ok(!all.includes(notAll), "opted out of All");
  assert.ok(!(await store.hot(null, 20)).some((h) => h.id === notAll), "nor the homepage's Hot");
  const fol = ids(await store.list({ following: U.carol.userId, sort: "new", viewer: await viewer(U.carol), limit: 100 }));
  assert.ok(fol.includes(inAll) && fol.includes(notAll), "followers get both in Following");
  assert.ok(!ids(await store.list({ following: U.bob.userId, sort: "new", viewer: await viewer(U.bob), limit: 100 })).includes(notAll), "non-followers' Following: no");
  assert.ok(ids(await store.list({ author: U.alice.userId, sort: "new", viewer: await viewer(U.bob), limit: 100 })).includes(notAll), "on her profile");
  const pg = await call("GET", "/feed/p/" + notAll, U.bob);
  assert.equal(pg.status, 200, "the post page works");
  // flip it (author only)
  assert.equal((await post(`/api/feed/posts/${notAll}/edit`, U.bob, { inAll: true })).status, 403);
  assert.equal((await post(`/api/feed/posts/${notAll}/edit`, U.alice, { inAll: true })).status, 200);
  const p = await store.getRow(notAll);
  assert.equal(p.in_all, 1);
  assert.equal(p.edited, null, "toggling All isn't an edit of the text");
  assert.ok(ids(await store.list({ sort: "new", viewer: await viewer(U.bob), limit: 100 })).includes(notAll));
  // the toggle means nothing for a pad post
  const padPost = await mkPost(U.alice, { body: "pad post", community: OTHER, inAll: false });
  assert.equal((await store.getRow(padPost)).in_all, 1, "only profile posts can leave All");
  // followers who asked for notices hear "posted on their profile"
  await follows.setPrefs(U.carol, { notify: true });
  const made = await store.create(U.alice.userId, { body: "ping", community: "u/alice" }, { awaitNotices: true });
  const n = await getQuery("SELECT title FROM inbox WHERE user_id = ? AND ref = ?", [U.carol.userId, "follow-post:" + made.id]);
  assert.equal(n.length, 1, "the follower's notice");
  assert.match(n[0].title, /alice posted on their profile/);
  await follows.setPrefs(U.carol, { notify: false });
});

// ───────────────────────────── crossposts ─────────────────────────────
const OTHER_SLUG = "side-room";
test("crossposts both ways: a profile post into a pad; a pad post to your own profile; never into someone else's", async () => {
  const prof = await mkPost(U.alice, { title: "profile original", community: "u/alice" });
  const x1 = await post(`/api/feed/posts/${prof}/crosspost`, U.alice, { pads: [OTHER] });
  assert.equal(x1.status, 200, JSON.stringify(x1.d));
  assert.equal(x1.d.created, 1);
  const xp = await store.get(x1.d.results[0].id, await viewer(U.bob));
  assert.equal(xp.rooms[0].id, OTHER);
  assert.equal(xp.xpost.from.profile, "alice", "Crossposted from u/alice");
  assert.equal(xp.xpost.from.label, "u/alice");
  // someone else shares alice's profile post into a pad: fine (it's public)
  const x2 = await post(`/api/feed/posts/${prof}/crosspost`, U.bob, { pads: [ROOM] });
  assert.equal(x2.d.created, 1, JSON.stringify(x2.d));
  // a pad post -> bob's own profile ("share to profile")
  const padPost = await mkPost(U.carol, { title: "a pad post", community: OTHER });
  const x3 = await post(`/api/feed/posts/${padPost}/crosspost`, U.bob, { pads: ["u/bob"] });
  assert.equal(x3.status, 200, JSON.stringify(x3.d));
  assert.equal(x3.d.created, 1, JSON.stringify(x3.d));
  assert.equal(x3.d.results[0].pad.label, "u/bob");
  const shared = await store.get(x3.d.results[0].id, await viewer(U.bob));
  assert.equal(shared.rooms[0].id, rooms.profileId(U.bob.userId));
  assert.equal(shared.rooms[0].profile, "bob");
  // the original's author is told "crossposted your post to their profile"
  // again -> "already crossposted"
  const again = await post(`/api/feed/posts/${padPost}/crosspost`, U.bob, { pads: ["profile"] });
  assert.equal(again.d.refused, 1);
  assert.match(again.d.results[0].error, /already been crossposted to your profile/);
  // into alice's profile: refused (by name and by pad id)
  const x4 = await post(`/api/feed/posts/${padPost}/crosspost`, U.bob, { pads: ["u/alice", alicePad()] });
  assert.equal(x4.d.created, 0);
  assert.equal(x4.d.refused, 2);
  for (const r of x4.d.results) assert.match(r.error, /Only alice can post on their profile/);
  // the dialog marks where it already is
  const list = await call("GET", "/api/feed/communities?post=" + padPost, U.bob);
  assert.equal(list.d.communities[0].here, true, "already on bob's profile");
});

// ───────────────────────────── moderation ─────────────────────────────
test("owner moderation: delete comments, lock, block commenters on their profile - and nothing anywhere else", async () => {
  const prof = await mkPost(U.alice, { title: "my thoughts", community: "u/alice" });
  const c1 = (await post(`/api/feed/posts/${prof}/comments`, U.bob, { body: "rude" })).d.id;
  assert.ok(c1);
  // others can comment and vote as normal
  assert.equal((await post(`/api/feed/posts/${prof}/vote`, U.carol, { dir: 1 })).status, 200);
  // delete a comment on her profile post
  assert.equal((await post(`/api/feed/comments/${c1}/delete`, U.alice, { reason: "nope" })).status, 200);
  // lock comments (her profile pad only)
  const slug = (await rooms.profileOf(U.alice.userId)).slug;
  assert.equal((await post(`/api/rooms/${slug}/feed/mod`, U.alice, { op: "lock", post: prof })).status, 200);
  assert.equal((await post(`/api/feed/posts/${prof}/comments`, U.carol, { body: "locked?" })).status, 403);
  assert.equal((await post(`/api/rooms/${slug}/feed/mod`, U.alice, { op: "unlock", post: prof })).status, 200);
  // block bob from commenting on her profile
  assert.equal((await post("/api/feed/ban", U.alice, { user: "bob", room: slug, days: 0 })).status, 200);
  const blocked = await post(`/api/feed/posts/${prof}/comments`, U.bob, { body: "let me in" });
  assert.equal(blocked.status, 403);
  assert.match(blocked.d.error, /alice has blocked you from commenting on their profile/);
  assert.equal((await post(`/api/feed/posts/${prof}/comments`, U.carol, { body: "fine" })).status, 200, "others still comment");
  assert.equal((await post(`/api/feed/posts/${prof}/vote`, U.bob, { dir: 1 })).status, 200, "a block is about commenting only");
  // bob still comments everywhere else - even on alice's pad posts
  const padPost = await mkPost(U.alice, { body: "in a pad", community: OTHER });
  assert.equal((await post(`/api/feed/posts/${padPost}/comments`, U.bob, { body: "hi in the pad" })).status, 200);
  // ... and she can't touch anything outside her profile
  const other = await mkPost(U.carol, { body: "carol's pad post", community: OTHER });
  const cc = (await post(`/api/feed/posts/${other}/comments`, U.bob, { body: "bob on carol's" })).d.id;
  assert.equal((await post(`/api/feed/comments/${cc}/delete`, U.alice, {})).status, 403, "a comment in a pad");
  const padComment = (await post(`/api/feed/posts/${padPost}/comments`, U.carol, { body: "carol on alice's pad post" })).d.id;
  assert.equal((await post(`/api/feed/comments/${padComment}/delete`, U.alice, {})).status, 403, "her own post in a pad isn't her profile");
  assert.equal((await post(`/api/rooms/${OTHER_SLUG}/feed/mod`, U.alice, { op: "lock", post: other })).status, 403);
  assert.equal((await post(`/api/rooms/${slug}/feed/mod`, U.alice, { op: "lock", post: other })).status, 404, "a post that isn't on her profile");
  assert.equal((await post("/api/feed/ban", U.alice, { user: "bob", room: OTHER_SLUG })).status, 403);
  assert.equal((await post("/api/feed/ban", U.alice, { user: "bob" })).status, 403, "no feed-wide bans");
  const bobSlug = (await rooms.ensureProfile(U.bob.userId)).slug;
  assert.equal((await post("/api/feed/ban", U.alice, { user: "carol", room: bobSlug })).status, 403, "not someone else's profile");
  assert.equal((await post("/api/feed/ban", U.alice, { user: "alice", room: slug })).status, 400, "not herself");
  // a crosspost of her profile post into a pad: that pad's owner's, not hers
  const x = await post(`/api/feed/posts/${prof}/crosspost`, U.alice, { pads: [ROOM] });
  const xc = (await post(`/api/feed/posts/${x.d.results[0].id}/comments`, U.carol, { body: "on the crosspost" })).d.id;
  assert.equal((await post(`/api/feed/comments/${xc}/delete`, U.alice, {})).status, 403);
  // admins can do everything there
  const c2 = (await post(`/api/feed/posts/${prof}/comments`, U.carol, { body: "admin will remove" })).d.id;
  assert.equal((await post(`/api/feed/comments/${c2}/delete`, U.admin, {})).status, 200);
  assert.equal((await post(`/api/rooms/${slug}/feed/mod`, U.admin, { op: "lock", post: prof })).status, 200);
  // unblock
  assert.equal((await post("/api/feed/unban", U.alice, { userId: U.bob.userId, room: slug })).status, 200);
  await post(`/api/rooms/${slug}/feed/mod`, U.admin, { op: "unlock", post: prof });
  assert.equal((await post(`/api/feed/posts/${prof}/comments`, U.bob, { body: "back" })).status, 200);
  // reports on profile posts go to the admins' queue
  assert.equal((await post(`/api/feed/posts/${prof}/report`, U.carol, { reason: "spam" })).status, 200);
  assert.ok((await store.reports()).some((g) => g.post.id === prof));
});

// ───────────────────────────── links ─────────────────────────────
test("u/<username> autolinks (known names only), /u/<name> and /p/u-<name> go to the profile", async () => {
  const known = (n) => ({ alice: "alice", "bob.smith": "bob.smith" }[n.toLowerCase()] || null);
  assert.equal(pads.userRefs("hi u/alice!", known), 'hi <a class="user-ref" href="/u/alice/profile">u/alice</a>!');
  assert.equal(pads.userRefs("ask u/Alice", known), 'ask <a class="user-ref" href="/u/alice/profile">u/Alice</a>', "case-insensitive, links the real name");
  assert.equal(pads.userRefs("u/bob.smith.", known), '<a class="user-ref" href="/u/bob.smith/profile">u/bob.smith</a>.');
  assert.equal(pads.userRefs("u/nobody here", known), "u/nobody here", "unknown names aren't links");
  assert.equal(pads.userRefs("see /u/alice/profile and menu/alice", known), "see /u/alice/profile and menu/alice", "not inside paths or words");
  // through the feed's text renderer (escaped first, URLs left alone, p/ links too)
  pads._setNames(new Map([["alice", "alice"]]));
  const html = web.linkify("thanks u/alice <b> https://x.test/u/alice");
  assert.match(html, /thanks <a class="user-ref" href="\/u\/alice\/profile">u\/alice<\/a> &lt;b&gt;/);
  assert.match(html, /<a href="https:\/\/x.test\/u\/alice" rel=/);
  assert.equal((html.match(/user-ref/g) || []).length, 1, "the URL isn't touched");
  pads._setNames(null);
  // redirects
  const r1 = await call("GET", "/u/alice", null);
  assert.equal(r1.status, 301);
  assert.equal(r1.location, "/u/alice/profile");
  await rooms.ensureProfile(U.alice.userId);
  const r2 = await call("GET", "/p/u-alice", null);
  assert.equal(r2.status, 301);
  assert.equal(r2.location, "/u/alice/profile#posts");
  const r3 = await call("GET", "/p/u-alice/settings", U.alice);
  assert.equal(r3.status, 301, "no pad settings hub for a profile");
  assert.equal(pads.padHref(await rooms.profileOf(U.alice.userId)), "/u/alice/profile");
  assert.equal(pads.padLabel(await rooms.profileOf(U.alice.userId)), "u/alice");
});

// ───────────────────────────── Pepe + automod ─────────────────────────────
test("Pepe answers mentions on profile posts (the scope rides on the sync); 'Pepe can reply on my profile' off stops it", async () => {
  await PF.ensureAccount();
  const prof = await mkPost(U.alice, { title: "question for the frog", community: "u/alice" });
  const cid = (await post(`/api/feed/posts/${prof}/comments`, U.bob, { body: "@pepe what do you think?" })).d.id;
  const s1 = await call("POST", "/api/pepe/feed/sync", null, {}, { "x-bot-token": "bot" });
  assert.equal(s1.status, 200, s1.text);
  const m = s1.d.mentions.find((x) => x.target === "c:" + cid);
  assert.ok(m, "the mention on a profile post is offered: " + JSON.stringify(s1.d.mentions.map((x) => x.target)));
  assert.equal(m.scope, alicePad());
  assert.ok(s1.d.scopes[alicePad()], "the profile scope rides along so the bot finds its settings");
  assert.equal(s1.d.scopes[alicePad()].auto, false, "never auto activity on a profile");
  assert.equal(s1.d.scopes[alicePad()].title, "u/alice's profile");
  assert.equal(m.post.pad.title, "u/alice's profile");
  // he replies there like anywhere
  const rep = await call("POST", "/api/pepe/feed/comment", null, { target: m.target, post: prof, parent: m.parent, body: "ribbit", scope: m.scope, why: "mention" }, { "x-bot-token": "bot" });
  assert.equal(rep.status, 200, rep.text);
  // the owner's switch (default on) -> off: the next mention isn't offered
  const S = await web.profileSocial({ userId: U.alice.userId, username: "alice" }, U.alice, { show: true });
  assert.equal(S.settings.pepe, true, "on by default");
  const off = await post("/api/profile/settings", U.alice, { pepe: false });
  assert.equal(off.status, 200, off.text);
  assert.equal(off.d.pepe, false);
  const cid2 = (await post(`/api/feed/posts/${prof}/comments`, U.carol, { body: "hey pepe, you there?" })).d.id;
  const s2 = await call("POST", "/api/pepe/feed/sync", null, {}, { "x-bot-token": "bot" });
  assert.ok(!s2.d.mentions.some((x) => x.target === "c:" + cid2), "mentions off on her profile");
  assert.equal((await post("/api/profile/settings", U.alice, { pepe: true })).d.pepe, true);
  // only the owner sets it (it's always the caller's own profile)
  const bobSet = await post("/api/profile/settings", U.bob, { pepe: false });
  assert.equal(bobSet.status, 200);
  assert.equal((await PF.scopeSettings(alicePad())).respond, true, "bob changed HIS profile, not alice's");
});

test("automod: off for profiles by default; one admin switch turns it on for every profile", async () => {
  await rooms.ensureProfile(U.alice.userId);
  assert.equal((await AM.settings(alicePad())).on, false);
  assert.equal((await AM.globalCaps()).profiles, false);
  await assert.rejects(AM.setScope(U.alice, alicePad(), { on: true }), /site-wide automod switch for profiles/);
  await assert.rejects(AM.setGlobal(U.alice, { profiles: true }), /Admins only/);
  const before = await AM.work();
  void before;
  await AM.setGlobal(U.admin, { profiles: true });
  const S = await AM.settings(alicePad());
  assert.equal(S.on, true);
  assert.ok(S.on_since > 0, "nothing older than the switch is judged");
  const prof = await mkPost(U.alice, { title: "judge my comments", community: "u/alice" });
  const cid = (await post(`/api/feed/posts/${prof}/comments`, U.bob, { body: "a comment to check" })).d.id;
  const w = await AM.work();
  assert.ok(w.items.some((i) => i.target === "c:" + cid), "others' comments on profile posts are checked");
  assert.ok(!w.items.some((i) => i.target === "p:" + prof), "never the owner's own posts");
  await AM.setGlobal(U.admin, { profiles: false });
  assert.equal((await AM.settings(alicePad())).on, false);
});

// ───────────────────────────── renders ─────────────────────────────
test("the profile feed partial renders for the owner (composer, Your profile picked, settings) and visitors", async () => {
  await mkPost(U.alice, { title: "rendered post", body: "talk to u/bob about p/side-room", community: "u/alice" });
  const file = path.join(repo, "views", "partials", "profile-posts.ejs");
  const render = async (reqUser) => {
    const social = await web.profileSocial({ userId: U.alice.userId, username: "alice" }, reqUser, { show: true, query: {} });   // All posts: cards carry the u/ label
    return ejs.renderFile(file, { social, usernameProfile: "alice", displayname: "Alice", isMe: !!reqUser && reqUser.userId === U.alice.userId, padBadge: pads.padBadge });
  };
  const own = await render(U.alice);
  assert.match(own, /id="fcForm"/, "the composer");
  assert.match(own, /value="u\/alice"[^>]*checked/, "Your profile picked");
  assert.match(own, /Also show in All/);
  assert.match(own, /Profile feed settings/);
  assert.match(own, /Pepe can reply on my profile/);
  assert.match(own, /fp-room fp-user/, "the card's u/ label");
  const vis = await render(U.bob);
  assert.doesNotMatch(vis, /id="fcForm"/);
  assert.doesNotMatch(vis, /Profile feed settings/);
  assert.match(vis, /rendered post/);
  const anon = await render(null);
  assert.match(anon, /rendered post/);
});
