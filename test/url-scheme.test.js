// Offline tests for 1.99dv: one URL scheme across the site (Reddit-like: p/ = pad, u/ = user).
//   - a post's canonical address: /p/<pad>/posts/<id>/<title-slug> (its first live pad) or /u/<username>/posts/<id>/<slug>
//     (a profile post); the id alone resolves - a wrong / missing slug, a wrong pad or username, and the old /feed/p/<id>
//     301 there with the query string kept; a post the viewer can't see 404s on every address (no redirect, no leak)
//   - crossposts are their own posts in their own pad; a post taken out of its first pad moves to the next one
//   - media: /media/f/<file> serves a post's files, the old /feed/f/<file> 301s there
//   - profiles: /u/<username> (+ /posts, /overview, /analytics, /edit); /u/<username>/profile[?tab=][/edit] and
//     /p/u-<username> 301 in one hop
//   - the redirect table: every old form -> its new canonical form, query kept (the #anchor is the browser's: it keeps it
//     through a 301, and profile-tabs.js turns #posts / #overview / #analytics into that tab's path)
//   - title slugs
//   NODE_PATH=G:/PATV/node_modules node --test test/url-scheme.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "url-scheme-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const web = require(path.join(repo, "feedweb"));
const pads = require(path.join(repo, "pads"));
const media = require(path.join(repo, "feedmedia"));
require(path.join(repo, "terms"))._setRequired(false);

const ROOM_B = "plant_based_chatting", ROOM_C = "Side.Room", LOUNGE = rooms.LOUNGE_ID;
let base, server, U = {};
const users = new Map();

async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, 5, '2026-01-01 00:00:00', 0)`, [id, name, name, extra.class || "pleb", name + "cf"]);
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
  U.owner = await mkUser("plantowner");
  U.admin = await mkUser("boss", { class: "Admin" });
  U.alice = await mkUser("alice");
  U.bob = await mkUser("bob");
  await rooms.init();
  await rooms.setOwner(ROOM_B, "plantowner", "test");
  await rooms.addRoom(ROOM_C, "Side Room", "test");
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0, comments_per_hour: 1000 }, "test");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  pads.register(app);
  web.register(app, { addUser, isBotToken: (x) => x === "bot" });
  require(path.join(repo, "bridge")).register(app, { addUser, isBotToken: (x) => x === "bot" });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });
test.beforeEach(() => { store._gaps.clear(); });

const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {});
async function call(method, url, u, body) {
  const r = await fetch(base + url, { method, headers: H(u), body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, text, location: r.headers.get("location") };
}
const get = (url, u) => call("GET", url, u);
const mkPost = async (u, body) => { const r = await call("POST", "/api/feed/posts", u, body); assert.equal(r.status, 200, JSON.stringify(r.d)); return r.d; };
const slug = (id) => rooms.getCached(id).slug;

// ───────────────────────────── slugs ─────────────────────────────
test("title slugs: ascii, lower case, '-' between words, ~60 characters cut at a word; fallbacks", () => {
  assert.equal(pads.titleSlug("Hello, World!"), "hello-world");
  assert.equal(pads.titleSlug("  Héllo  Wörld — it’s Drama & more?! "), "hello-world-its-drama-and-more");
  assert.equal(pads.titleSlug("🐸🐸🐸"), "", "nothing ascii left: no slug");
  assert.equal(pads.titleSlug(""), "");
  assert.equal(pads.titleSlug(null), "");
  const long = pads.titleSlug("the quick brown fox jumps over the lazy dog and keeps on running far away");
  assert.ok(long.length <= 60 && !long.endsWith("-") && "the-quick-brown-fox-jumps-over-the-lazy-dog-and-keeps-on-running".startsWith(long), long);
  assert.equal(pads.titleSlug("x".repeat(80)).length, 60, "one long word: cut at 60");
  assert.equal(pads.postSlug({ title: "", link: { title: "A Link Title" }, body: "b" }), "a-link-title", "no title: the link's");
  assert.equal(pads.postSlug({ title: "", body: "one two three four five six seven eight nine ten eleven" }), "one-two-three-four-five-six-seven-eight-nine-ten", "else the body's first words");
  assert.equal(pads.postSlug({ title: "", body: "" }), "");
});

test("postHref: the first live pad, else the first; a profile pad -> /u/<name>; no placement -> the author's profile", () => {
  const P = (roomsAll, extra = {}) => pads.postHref({ id: "AbCdEf123456", title: "Hi There", roomsAll, author: { username: "alice" }, ...extra });
  assert.equal(P([{ id: "a", slug: "drama-central" }]), "/p/drama-central/posts/AbCdEf123456/hi-there");
  assert.equal(P([{ id: "a", slug: "gone", removed: true }, { id: "b", slug: "pics" }]), "/p/pics/posts/AbCdEf123456/hi-there");
  assert.equal(P([{ id: "a", slug: "wait", pending: true }, { id: "b", slug: "pics", hidden: true }]), "/p/wait/posts/AbCdEf123456/hi-there", "none live: the first");
  assert.equal(P([{ id: "u", slug: "u-alice", profile: "alice" }]), "/u/alice/posts/AbCdEf123456/hi-there");
  assert.equal(P([]), "/u/alice/posts/AbCdEf123456/hi-there");
  assert.equal(P([{ id: "a", slug: "pics" }], { title: "" , body: "" }), "/p/pics/posts/AbCdEf123456", "no slug: the id alone");
});

// ───────────────────────────── post addresses ─────────────────────────────
test("posts: the canonical address is 200; any other pad / slug / username and the old /feed/p/<id> 301 there, query kept", async () => {
  const p = await mkPost(U.alice, { title: "Monstera Update!", body: "new leaf", community: ROOM_B });
  const canon = `/p/plant-based-chatting/posts/${p.id}/monstera-update`;
  assert.equal(p.url, canon, "the create API answers with the canonical address");
  const ok = await get(canon, U.bob);
  assert.equal(ok.status, 200);
  assert.ok(ok.text.includes(`<meta property="og:url" content="http://test${canon}">`), "og:url is the canonical address");
  for (const [from, to] of [
    [`/feed/p/${p.id}`, canon],
    [`/feed/p/${p.id}?csort=new`, canon + "?csort=new"],
    [`/p/plant-based-chatting/posts/${p.id}`, canon],
    [`/p/plant-based-chatting/posts/${p.id}/`, canon],
    [`/p/plant-based-chatting/posts/${p.id}/old-title?csort=top`, canon + "?csort=top"],
    [`/p/Plant-Based-Chatting/posts/${p.id}/monstera-update`, canon],
    [`/p/side-room/posts/${p.id}/monstera-update`, canon],
    [`/p/no-such-pad/posts/${p.id}`, canon],
    [`/p/patv-lounge/posts/${p.id}/x`, canon],
    [`/u/alice/posts/${p.id}/monstera-update`, canon],
    [`/u/bob/posts/${p.id}`, canon],
  ]) {
    const r = await get(from, U.bob);
    assert.equal(r.status, 301, from);
    assert.equal(r.location, to, from);
  }
  // nothing that isn't a post id goes there
  assert.equal((await get("/p/plant-based-chatting/posts/x", U.bob)).status, 404);
  assert.equal((await get("/feed/p/NoSuchPost99", U.bob)).status, 404);
  assert.equal((await get("/p/plant-based-chatting/posts/NoSuchPost99/x", U.bob)).status, 404);
});

test("posts: a post the viewer can't see 404s on every address - no redirect, so its pad and title never leak", async () => {
  const p = await mkPost(U.alice, { title: "Secret Plans", body: "x", community: ROOM_B });
  await runQuery("UPDATE feed_posts SET hidden_at = ? WHERE id = ?", [Date.now(), p.id]);
  for (const url of [`/feed/p/${p.id}`, `/p/plant-based-chatting/posts/${p.id}`, `/p/plant-based-chatting/posts/${p.id}/secret-plans`]) {
    const r = await get(url, U.bob);
    assert.equal(r.status, 404, url);
    assert.equal(r.location, null, url);
    assert.ok(!r.text.includes("secret-plans"), url);
  }
  const staff = await get(`/feed/p/${p.id}`, U.admin);
  assert.equal(staff.status, 301, "staff still get there");
  assert.equal(staff.location, `/p/plant-based-chatting/posts/${p.id}/secret-plans`);
});

test("posts: a crosspost lives in its own pad; a post taken out of its first pad moves to the next (old address 301s)", async () => {
  const o = await mkPost(U.alice, { title: "Look at my fern", body: "fern", community: ROOM_B });
  const x = await call("POST", `/api/feed/posts/${o.id}/crosspost`, U.bob, { community: slug(ROOM_C), title: "Fern from p/plant-based-chatting" });
  assert.equal(x.status, 200, x.text);
  const xc = `/p/side-room/posts/${x.d.id}/fern-from-p-plant-based-chatting`;
  assert.equal(x.d.url, xc);
  assert.equal((await get(`/p/plant-based-chatting/posts/${x.d.id}`, U.bob)).location, xc, "the original's pad isn't the crosspost's");
  // the original's page links its crosspost by the crosspost's own address, and the crosspost's page the original's
  const op = await get(`/p/plant-based-chatting/posts/${o.id}/look-at-my-fern`, U.bob);
  assert.ok(op.text.includes(`href="${xc}"`), "Crossposted to: the crosspost's address");
  const xp = await get(xc, U.bob);
  assert.ok(xp.text.includes(`href="/p/plant-based-chatting/posts/${o.id}/look-at-my-fern"`), "the embedded original links its address");
  // a second placement (legacy data / migration): the first live one is the address
  await runQuery("INSERT INTO feed_post_rooms (post_id, room_id, created, pending) VALUES (?, ?, ?, 0)", [o.id, LOUNGE, Date.now() + 1000]);
  assert.equal(await store.postPath(o.id), `/p/plant-based-chatting/posts/${o.id}/look-at-my-fern`);
  await runQuery("UPDATE feed_post_rooms SET removed_at = ? WHERE post_id = ? AND room_id = ?", [Date.now(), o.id, ROOM_B]);
  const moved = `/p/camfrog-lounge/posts/${o.id}/look-at-my-fern`;
  assert.equal(await store.postPath(o.id), moved);
  assert.equal((await get(`/p/plant-based-chatting/posts/${o.id}/look-at-my-fern`, U.bob)).location, moved);
  assert.equal((await get(moved, U.bob)).status, 200);
});

test("posts: a profile post's address is /u/<username>/posts/<id>/<slug>; /p/u-<name>/posts/... and /feed/p/ 301 there", async () => {
  const p = await mkPost(U.alice, { title: "Hello from my profile", community: "u/alice" });
  const canon = `/u/alice/posts/${p.id}/hello-from-my-profile`;
  assert.equal(p.url, canon);
  assert.equal((await get(canon, U.bob)).status, 200);
  const P = await rooms.profileOf(U.alice.userId);
  for (const from of [`/feed/p/${p.id}`, `/p/${P.slug}/posts/${p.id}`, `/p/${P.slug}/posts/${p.id}/hello-from-my-profile`, `/u/alice/posts/${p.id}`, `/u/ALICE/posts/${p.id}/hello-from-my-profile`]) {
    const r = await get(from, U.bob);
    assert.equal(r.status, 301, from);
    assert.equal(r.location, canon, from);
  }
});

// ───────────────────────────── the redirect table ─────────────────────────────
test("redirect table (1.99dv): every old form -> its new canonical form in one hop, query kept", async () => {
  const p = await mkPost(U.alice, { title: "Table Post", community: ROOM_B });
  await rooms.ensureProfile(U.alice.userId);
  const P = await rooms.profileOf(U.alice.userId);
  const file = "0123456789abcdef0123456789abcdef.webp";
  const cases = [
    // posts
    [`/feed/p/${p.id}`, `/p/plant-based-chatting/posts/${p.id}/table-post`],
    [`/feed/p/${p.id}?csort=new&x=1`, `/p/plant-based-chatting/posts/${p.id}/table-post?csort=new&x=1`],
    // media
    [`/feed/f/${file}`, `/media/f/${file}`],
    [`/feed/f/${file}?v=3`, `/media/f/${file}?v=3`],
    // profiles
    ["/u/alice/profile", "/u/alice"],
    ["/u/alice/profile?preview=visitor", "/u/alice?preview=visitor"],
    ["/u/alice/profile?tab=overview", "/u/alice/overview"],
    ["/u/alice/profile?tab=analytics&preview=visitor", "/u/alice/analytics?preview=visitor"],
    ["/u/alice/profile?tab=posts", "/u/alice/posts"],
    ["/u/alice/profile?tab=bogus", "/u/alice"],
    ["/u/alice/profile?psort=top&pt=week", "/u/alice/posts?psort=top&pt=week"],
    ["/u/alice/profile?pview=profile", "/u/alice/posts?pview=profile"],
    ["/u/alice/profile?pp=2", "/u/alice/posts?pp=2"],
    ["/u/alice/profile/edit", "/u/alice/edit"],
    ["/u/alice/profile/edit?x=1", "/u/alice/edit?x=1"],
    // profile pads (/p/u-<name>) -> the posts tab, from every old pad address
    [`/p/${P.slug}`, "/u/alice/posts"],
    [`/p/${P.slug}?sort=top`, "/u/alice/posts?sort=top"],
    [`/p/${P.slug}/settings`, "/u/alice/posts"],
    [`/rooms/${P.slug}`, "/u/alice/posts"],
    [`/feed/c/${P.slug}`, "/u/alice/posts"],
    [`/rooms/${P.slug}/analytics`, "/u/alice/posts"],
    // the older pad aliases: straight to the current address
    ["/rooms/plant-based-chatting?fsort=top", "/p/plant-based-chatting?fsort=top"],
    ["/feed/c/plant-based-chatting?sort=new", "/p/plant-based-chatting?sort=new"],
    ["/rooms/patv-lounge", "/p/camfrog-lounge"],
    ["/feed/c/patv-lounge", "/p/camfrog-lounge"],
    ["/p/patv-lounge/analytics?days=7", "/p/camfrog-lounge/analytics?days=7"],
    ["/rooms", "/p"],
    ["/pads", "/p"],
    ["/feed?room=plant-based-chatting&sort=top", "/p/plant-based-chatting?sort=top"],
    ["/feed?tab=following", "/feed/following"],
  ];
  for (const [from, to] of cases) {
    const r = await get(from, U.bob);
    assert.equal(r.status, 301, from);
    assert.equal(r.location, to, from);
  }
  // every target is a page (or the file), not another redirect
  for (const to of [`/p/plant-based-chatting/posts/${p.id}/table-post`, "/p/plant-based-chatting", "/p/camfrog-lounge", "/feed", "/feed/following"]) {
    assert.equal((await get(to, U.bob)).status, 200, to);
  }
});

test("media: /media/f/<file> serves a post's file with its rules; /feed/f/<file> 301s there", async () => {
  const name = "fedcba9876543210fedcba9876543210.webp";
  fs.mkdirSync(path.dirname(media.filePath(name)), { recursive: true });
  fs.writeFileSync(media.filePath(name), Buffer.from("RIFF0000WEBPVP8 "));
  const p = await mkPost(U.alice, { title: "pic", community: ROOM_B });
  await runQuery(`INSERT INTO feed_attachments (id, post_id, owner_id, kind, ct, file, thumb, w, h, state, created) VALUES ('att_ms1', ?, ?, 'image', 'image/webp', ?, NULL, 10, 10, 'ready', ?)`,
                 [p.id, U.alice.userId, name, Date.now()]);
  const r = await get("/media/f/" + name, null);
  assert.equal(r.status, 200);
  const old = await get("/feed/f/" + name, null);
  assert.equal(old.status, 301);
  assert.equal(old.location, "/media/f/" + name);
  const followed = await fetch(base + "/feed/f/" + name);
  assert.equal(followed.status, 200, "an <img> / OG crawler following the redirect gets the file");
  assert.equal(followed.headers.get("content-type"), "image/webp");
  assert.equal((await get("/media/f/not-a-file.html", null)).status, 404);
  // the post's page uses the new address
  const page = await get(p.url, U.bob);
  assert.ok(!page.text.includes("/feed/f/") && !page.text.includes("/feed/p/"), "no old addresses on a post page");
});

test("links: u/<name> -> /u/<name>; pad pages, post cards and the profile template use the new addresses", async () => {
  assert.equal(pads.userRefs("hi u/alice", () => "alice"), 'hi <a class="user-ref" href="/u/alice">u/alice</a>');
  assert.equal(pads.profileHref("a b", "posts"), "/u/a%20b/posts");
  const p = await mkPost(U.alice, { title: "Card Link", community: ROOM_B });
  const padPage = await get("/p/plant-based-chatting", U.bob);
  assert.equal(padPage.status, 200);
  assert.ok(padPage.text.includes(`href="/p/plant-based-chatting/posts/${p.id}/card-link"`), "the card's title / time / comments link the canonical address");
  assert.ok(padPage.text.includes('href="/u/alice"'), "the author links the profile");
  assert.ok(!/\/feed\/p\/|\/u\/[^"\/]+\/profile["#?]/.test(padPage.text), "no old post / profile addresses on the pad page");
  // an old #posts / #overview / #analytics anchor opens that tab and moves the address to its path (the server never
  // sees the #anchor); the tabs link /u/<name>/<tab>
  const js = fs.readFileSync(path.join(repo, "public/js/profile-tabs.js"), "utf8");
  assert.ok(js.includes('activate(h, { url: named.getAttribute("href") })'), "the anchor -> tab path hop");
  const tpl = fs.readFileSync(path.join(repo, "views/profile.ejs"), "utf8");
  assert.ok(tpl.includes("const tabHref = (t) => base + (t ? '/' + t : '')") && !/\/profile(?![-a-z])/.test(tpl), "tab links are paths");
  assert.ok(fs.readFileSync(path.join(repo, "views/partials/profile-posts.ejs"), "utf8").includes("'/posts'"), "the profile feed's own links are /u/<name>/posts");
});
