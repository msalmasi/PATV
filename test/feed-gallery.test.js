// Offline tests for 1.99fn: the feeds' Gallery view (feedgallery.js - the grid API, the List / Gallery toggle markup on
// every feed, the per-scope view choice), 🔖 Save on members' own snap / clip stories (storykeep.js + userstories.js)
// and the story viewer's pad scoping (a profile story must never show inside a pad's story viewer - stories.js).
//   NODE_PATH=<repo>/node_modules node --test test/feed-gallery.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "feed-gallery-test-"));
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
require(path.join(repo, "terms"))._setRequired(false);
const stories = require(path.join(repo, "stories"));
const keep = require(path.join(repo, "storykeep"));
const US = require(path.join(repo, "userstories"));
const hop = require(path.join(repo, "hop"));
const FG = require(path.join(repo, "feedgallery"));
const media = require(path.join(repo, "media"));

const ROOM = "plant_based_chatting", SLUG = "plant-based-chatting", LOUNGE = "patv:lounge";
const DRAMA = "drama_central";
let base, server, U = {}, jpg;
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
async function call(method, url, u, body) {
  const r = await fetch(base + url, { method, headers: H(u), body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  let d = null;
  try { d = await r.clone().json(); } catch (e) { d = null; }
  return { status: r.status, d, r };
}
const post = (url, u, body) => call("POST", url, u, body || {});
const get = (url, u) => call("GET", url, u);
const page = async (url, u) => { const r = await fetch(base + url, { headers: u ? { "x-test-user": u.userId } : {}, redirect: "manual" }); return { status: r.status, html: await r.text(), r }; };

let seq = 0;
/** A capture row (Pepe's cam capture unless source is given) with its file on disk. */
async function capture({ room = ROOM, subject = "subjcf", by = "capcf", kind = "photo", ageMin = 5, source = null, byId = null } = {}) {
  const id = "beef" + String(++seq).padStart(8, "0");
  const t = Date.now() - ageMin * 60e3;
  const ext = kind === "photo" ? "jpg" : kind === "clip" ? "mp4" : "m4a";
  await runQuery(`INSERT INTO media (id, kind, ct, file, bytes, secs, subject, by_user, room, created, expires, deleted, anon, source, nsfw, by_user_id)
                  VALUES (?, ?, ?, ?, 10, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, ?)`,
                 [id, kind, kind === "photo" ? "image/jpeg" : kind === "clip" ? "video/mp4" : "audio/mp4", id + "." + ext, kind === "photo" ? 0 : 7,
                  subject, by, room, t, t + 24 * 3600e3, source, byId]);
  fs.writeFileSync(path.join(process.env.MEDIA_DIR, id + "." + ext), kind === "photo" ? jpg : Buffer.from("fake-mp4-bytes"));
  return id;
}
/** A finished story upload owned by `u` (what /api/feed/uploads leaves behind). */
let aseq = 0;
async function upload(u, { kind = "image", secs = 0 } = {}) {
  const id = (++aseq).toString(16).padStart(24, "b");
  const b = crypto.randomBytes(16).toString("hex");
  const file = b + (kind === "image" ? ".webp" : ".mp4");
  const sub = path.join(fmedia.dir(), b.slice(0, 2));
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, file), kind === "image" ? await sharp(jpg).webp().toBuffer() : Buffer.from("fake-mp4"));
  let poster = null;
  if (kind === "video") { poster = b + "_p.webp"; fs.writeFileSync(path.join(sub, poster), await sharp(jpg).webp().toBuffer()); }
  await runQuery(`INSERT INTO feed_attachments (id, owner_id, kind, ct, file, thumb, poster, w, h, secs, bytes, state, created, size_declared, received, purpose)
                  VALUES (?, ?, ?, ?, ?, NULL, ?, 16, 12, ?, 100, 'ready', ?, 100, 100, 'story')`,
                 [id, u.userId, kind, kind === "image" ? "image/webp" : "video/mp4", file, poster, secs, Date.now()]);
  return id;
}
let clock = Date.now();
async function story(u, pad, opts = {}) {
  clock += 20e3; US._setClock(() => clock);                // past the per-member gap
  const r = await post("/api/stories/mine", u, { attachment: await upload(u, opts), pad });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  US._setClock(() => Date.now());
  return r.d.story.id;
}
/** A feed post with `n` ready attachments (images, or one video), optionally AI / NSFW. */
async function mediaPost(author, title, { kind = "image", n = 1, nsfw = false, community = LOUNGE, ai = false } = {}) {
  const atts = [];
  for (let i = 0; i < n; i++) {
    const att = crypto.randomBytes(12).toString("hex");
    const f = crypto.randomBytes(16).toString("hex");
    await runQuery(`INSERT INTO feed_attachments (id, owner_id, kind, ct, file, thumb, poster, w, h, bytes, state, created, size_declared, received, ai_generated)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 10, 10, 10, 'ready', ?, 10, 10, ?)`,
                   [att, author.userId, kind, kind === "image" ? "image/webp" : "video/mp4", f + (kind === "image" ? ".webp" : ".mp4"),
                    kind === "image" ? f + "_t.webp" : null, kind === "video" ? f + "_p.webp" : null, Date.now(), ai ? 1 : 0]);
    atts.push(att);
  }
  return store.create(author.userId, { title, attachments: atts, nsfw, community });
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery(`CREATE TABLE IF NOT EXISTS pepe_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, username TEXT, camfrog TEXT, site_admin INTEGER,
                  kind TEXT, args TEXT, tag TEXT, label TEXT, status TEXT, message TEXT, created INTEGER, updated INTEGER, idem TEXT)`);
  await media.ready;
  await require(path.join(repo, "inbox")).ready;
  jpg = await sharp({ create: { width: 16, height: 12, channels: 3, background: "#0a0" } }).jpeg().toBuffer();
  U.owner = await mkUser("plantowner", { camfrog: "foamy1111" });
  U.admin = await mkUser("boss", { class: "Admin", camfrog: "bossfrog" });
  U.alice = await mkUser("alice", { camfrog: "alicecf", display: "Alice A" });
  U.bob = await mkUser("bob", { camfrog: "bobcf" });
  U.saver = await mkUser("saver", { camfrog: "savercf" });
  U.drama = await mkUser("dramaowner", { camfrog: "dramacf" });
  await rooms.init();
  await rooms.setOwner(ROOM, "plantowner", "test");
  await rooms.setOwner(DRAMA, "dramaowner", "test");
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0 }, "test");
  await keep.init();
  await US.init();
  await FG.init();
  keep._setModCheck(() => false);
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  require(path.join(repo, "pads")).register(app);
  web.register(app, { addUser, isBotToken: (t) => t === "bot" });
  stories.register(app, { addUser });
  keep.register(app, { addUser });
  US.register(app, { addUser });
  hop.register(app, { addUser });
  FG.register(app, { addUser });
  media.register(app, { addUser, isBotToken: (t) => t === "bot", noTimers: true });
  require(path.join(repo, "bridge")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });
test.beforeEach(() => { store._gaps.clear(); });

// ───────────────────────────── 1. Gallery ─────────────────────────────
let G = {};
test("gallery API: media posts only (Hop's filter), tile shape, the text-post count, cursor paging, NSFW never for visitors, scopes", async () => {
  for (let i = 0; i < 4; i++) await store.create(U.alice.userId, { title: "words only " + i, community: LOUNGE });
  G.pics = [];
  for (let i = 0; i < 30; i++) G.pics.push(await mediaPost(U.alice, "pic " + i));
  G.multi = await mediaPost(U.alice, "three pics", { n: 3 });
  G.vid = await mediaPost(U.alice, "a video", { kind: "video" });
  G.ai = await mediaPost(U.alice, "an ai pic", { ai: true });
  G.nsfw = await mediaPost(U.alice, "spicy", { nsfw: true });
  // a captured clip posted to its pad (storykeep): a video tile with the clip icon
  const cid = await capture({ kind: "clip", by: "foamy1111" });
  const pr = await keep.postToPad(U.owner, cid, {});
  G.clipPost = pr.post.id;

  let r = await get("/api/feed/gallery?scope=all&sort=new", U.alice);
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.tiles.length, FG.PAGE);
  assert.equal(FG.PAGE % 3, 0, "whole rows of three");
  assert.ok(!r.d.tiles.some((x) => /words only/.test(x.title)), "text posts aren't tiles");
  assert.deepEqual(r.d.text, { n: 4, more: false }, "the text posts it left out");
  const byId = new Map(r.d.tiles.map((x) => [x.id, x]));
  assert.equal(r.d.tiles[0].id, G.clipPost, "newest first");
  assert.equal(byId.get(G.nsfw.id).nsfw, true, "members get NSFW tiles (blurred client-side)");
  const clip = byId.get(G.clipPost);
  assert.ok(clip && clip.video && clip.clip, "a captured clip");
  const vid = byId.get(G.vid.id);
  assert.ok(vid.video && !vid.clip && /^\/media\/f\/[a-f0-9]{32}_p\.webp$/.test(vid.thumb), "a video's tile is its poster frame");
  const m = byId.get(G.multi.id);
  assert.equal(m.multi, 3); assert.equal(m.video, false);
  assert.match(m.thumb, /^\/media\/f\/[a-f0-9]{32}_t\.webp$/, "a picture's tile is its thumbnail");
  assert.equal(byId.get(G.ai.id).ai, true);
  assert.equal(m.hop, "/hop?post=" + G.multi.id + "&sort=new", "a tap goes to Hop at the post, same sort");
  assert.ok(Number.isFinite(m.score) && Number.isFinite(m.comments));
  // paging: every media post exactly once, then no cursor; text only on the first page
  const seen = r.d.tiles.map((x) => x.id);
  let cur = r.d.next, guard = 0;
  while (cur && guard++ < 10) {
    const p = await get("/api/feed/gallery?scope=all&sort=new&cursor=" + encodeURIComponent(cur), U.alice);
    assert.equal(p.d.text, null);
    seen.push(...p.d.tiles.map((x) => x.id));
    cur = p.d.next;
  }
  assert.equal(new Set(seen).size, seen.length, "no repeats");
  for (const p of G.pics.concat([G.multi, G.vid, G.ai, G.nsfw])) assert.ok(seen.includes(p.id), "every media post once");
  // the grid and Hop page the same list
  const hopIds = [];
  cur = null; guard = 0;
  do {
    const h = await get("/api/hop?scope=all&sort=new" + (cur ? "&cursor=" + encodeURIComponent(cur) : ""), U.alice);
    hopIds.push(...h.d.items.map((x) => x.id)); cur = h.d.next;
  } while (cur && guard++ < 20);
  assert.deepEqual([...seen].sort(), [...hopIds].sort(), "gallery = Hop's media-only list");
  // visitors: never NSFW
  r = await get("/api/feed/gallery?scope=all&sort=new", null);
  assert.equal(r.status, 200);
  assert.ok(!r.d.tiles.some((x) => x.nsfw || x.id === G.nsfw.id));
  // scopes
  r = await get("/api/feed/gallery?scope=p/" + SLUG + "&sort=new", U.alice);
  assert.equal(r.status, 200); assert.deepEqual(r.d.tiles.map((x) => x.id), [G.clipPost]);
  r = await get("/api/feed/gallery?scope=u/alice&sort=new", U.alice);
  assert.ok(r.d.tiles.length > 0 && r.d.text.n === 4);
  const prof = await mediaPost(U.bob, "on my profile", { community: (await rooms.ensureProfile(U.bob.userId)).id });
  await mediaPost(U.bob, "in the lounge");
  r = await get("/api/feed/gallery?scope=u/bob/profile&sort=new", U.alice);
  assert.equal(r.status, 200, JSON.stringify(r.d)); assert.deepEqual(r.d.tiles.map((x) => x.id), [prof.id], "Profile only: just their profile pad");
  r = await get("/api/feed/gallery?scope=u/bob&sort=new", U.alice);
  assert.equal(r.d.tiles.length, 2);
  assert.equal((await get("/api/feed/gallery?scope=following", null)).status, 401);
  assert.equal((await get("/api/feed/gallery?scope=following", U.alice)).status, 200);
  assert.equal((await get("/api/feed/gallery?scope=p/no-such-pad", null)).status, 404);
  assert.equal((await get("/api/feed/gallery?scope=u/nobody", null)).status, 404);
  assert.equal((await get("/api/feed/gallery?scope=../etc", null)).status, 404);
});

test("gallery markup: the ☰ / ▦ toggle on /feed, /feed/following, a pad's Feed tab and a profile's Posts; ?view= deep links; tiles", async () => {
  // signed out, no choice: List, the server leaves it to the browser (data-fv-src empty), no tiles rendered
  let h = (await page("/feed?sort=new", null)).html;
  assert.match(h, /<nav class="fs"[^>]*data-view="list"/);
  assert.match(h, /class="fv" role="group" aria-label="View" data-fv-scope="all" data-fv-src=""/);
  assert.match(h, /data-fv="list" aria-pressed="true"/); assert.match(h, /data-fv="gallery" aria-pressed="false"/);
  assert.match(h, /href="\/feed\?sort=new&amp;view=gallery"/, "no-JS: the toggle is a link");
  assert.match(h, /feed-gallery\.js\?v=\d+/); assert.match(h, /feed-gallery\.css\?v=\d+/);
  assert.ok(!/<li class="fg-t/.test(h));
  // ?view=gallery: the grid comes rendered (first page), the text-post line, the bar says gallery
  h = (await page("/feed?sort=new&view=gallery", U.alice)).html;
  assert.match(h, /<nav class="fs"[^>]*data-view="gallery"/);
  assert.match(h, /data-fv-scope="all" data-fv-src="query"/);
  assert.match(h, /class="fg" data-fg data-fg-scope="all" data-fg-hop="all" data-fg-sort="new" data-fg-t="" data-fg-next="[^"]+" data-fg-loaded="1"/);
  assert.equal((h.match(/<li class="fg-t/g) || []).length, FG.PAGE);
  assert.match(h, new RegExp('<li class="fg-t nsfw" data-id="' + G.nsfw.id + '"'), "NSFW tile flagged for the blur");
  assert.match(h, new RegExp('href="/hop\\?post=' + G.multi.id + '&amp;sort=new" data-fg-post="' + G.multi.id + '"'));
  assert.match(h, /<span data-fg-textn>4 text posts<\/span> hidden in gallery/);
  assert.match(h, /data-fv="list"><span data-fg-textn>/, "the text line switches back to List");
  assert.match(h, /class="fd-list"/, "the list is still there (hidden by CSS)");
  // the pad's Feed tab (pad page), Following and a profile's Posts
  h = (await page("/p/" + SLUG + "?view=gallery", U.alice)).html;
  assert.match(h, new RegExp('data-fv-scope="p/' + SLUG + '" data-fv-src="query"'));
  assert.match(h, new RegExp('<li class="fg-t" data-id="' + G.clipPost + '"[\\s\\S]{0,400}?class="fg-ic" aria-hidden="true">📹'));
  h = (await page("/p/" + SLUG, U.alice)).html;
  assert.match(h, /href="\?view=gallery#feed"/, "the pad's toggle keeps the #feed anchor");
  h = (await page("/feed/following", U.alice)).html;
  assert.match(h, /data-fv-scope="following"/);
  const prof = await web.profileSocial({ userId: U.bob.userId, username: "bob" }, U.alice, { query: { view: "gallery", pview: "profile" } });
  const pp = await ejs.renderFile(path.join(repo, "views/partials/profile-posts.ejs"), { social: prof, usernameProfile: "bob", displayname: "bob", isMe: false });
  assert.match(pp, /data-fv-scope="u\/bob\/profile" data-fv-src="query"/);
  assert.match(pp, /data-fg-hop="u\/bob"/);
  assert.equal((pp.match(/<li class="fg-t/g) || []).length, 1);
  const pp2 = await ejs.renderFile(path.join(repo, "views/partials/profile-posts.ejs"),
    { social: await web.profileSocial({ userId: U.bob.userId, username: "bob" }, U.alice), usernameProfile: "bob", displayname: "bob", isMe: false });
  assert.match(pp2, /data-fv-scope="u\/bob" data-fv-src=""/);
  assert.match(pp2, /href="\/u\/bob\/posts\?view=gallery"/);
  // the grid shows on phones three across too (one rule, no breakpoint changes the column count)
  const css = fs.readFileSync(path.join(repo, "public/css/feed-gallery.css"), "utf8");
  assert.match(css, /\.fg-grid \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.equal((css.match(/grid-template-columns/g) || []).length, 1);
  assert.match(css, /\.fs\[data-view="gallery"\] ~ \.fd-list/);
});

test("the view choice per scope: per account (GET / POST /api/feed/view), ?view= wins, signed out falls to the browser", async () => {
  assert.equal((await post("/api/feed/view", null, { scope: "all", view: "gallery" })).status, 401);
  assert.equal((await post("/api/feed/view", U.saver, { scope: "nope!", view: "gallery" })).status, 400);
  assert.equal((await post("/api/feed/view", U.saver, { scope: "all", view: "grid" })).status, 400);
  const bad = await fetch(base + "/api/feed/view", { method: "POST", headers: { "content-type": "application/json", "x-test-user": U.saver.userId }, body: "{}" });
  assert.equal(bad.status, 403, "fetch-only");
  let r = await post("/api/feed/view", U.saver, { scope: "all", view: "gallery" });
  assert.equal(r.status, 200); assert.equal(r.d.view, "gallery");
  assert.equal((await get("/api/feed/view?scope=all", U.saver)).d.view, "gallery");
  assert.equal((await get("/api/feed/view?scope=following", U.saver)).d.view, null, "per scope");
  let h = (await page("/feed?sort=new", U.saver)).html;
  assert.match(h, /<nav class="fs"[^>]*data-view="gallery"/); assert.match(h, /data-fv-src="account"/);
  assert.match(h, /<li class="fg-t/);
  h = (await page("/feed?sort=new&view=list", U.saver)).html;
  assert.match(h, /data-view="list"/); assert.match(h, /data-fv-src="query"/, "a link's ?view= wins");
  await post("/api/feed/view", U.saver, { scope: "p/" + SLUG, view: "gallery" });
  h = (await page("/p/" + SLUG, U.saver)).html;
  assert.match(h, new RegExp('data-fv-scope="p/' + SLUG + '" data-fv-src="account"'));
  assert.equal(await FG.getView(U.alice.userId, "all"), null, "nobody else's");
  // the client: localStorage per scope, the URL follows, the account is told
  const js = fs.readFileSync(path.join(repo, "public/js/feed-gallery.js"), "utf8");
  assert.match(js, /patvFeedView/); assert.match(js, /\/api\/feed\/view/); assert.match(js, /searchParams\.set\('view', 'gallery'\)/);
  assert.match(js, /window\.patvHop\.open\(/, "a tile opens Hop");
  assert.match(js, /patvFeedNsfw/, "the feed's NSFW rule");
  assert.match(js, /IntersectionObserver/);
});

// ───────────────────────────── 2. saving members' stories ─────────────────────────────
test("🔖 Save on members' own stories: snaps (photo) and clips (clip) - anyone signed in; never 📌 posted; the same private Saved collection", async () => {
  assert.deepEqual([...keep.SAVE_USER_KINDS].sort(), ["clip", "photo"]);
  const pic = await story(U.alice, ROOM);                      // a picture story in a pad
  const vid = await story(U.alice, "profile", { kind: "video", secs: 8 });   // a video story on her profile
  // the viewer flags: save yes, post no (even for the pad's owner / staff)
  const fv = await stories.forViewer(U.saver, { room: ROOM });
  const it = fv[0].items.find((x) => x.id === pic);
  assert.equal(it.can.save, true); assert.equal(it.can.post, false);
  const own = await stories.forViewer(U.owner, { room: ROOM });
  assert.equal(own[0].items.find((x) => x.id === pic).can.post, false, "the pad's owner can't post a member's story");
  const ps = await US.personStory(U.saver, U.alice.userId);
  assert.equal(ps.items.find((x) => x.id === vid).can.save, true, "a clip story in a person story");
  // save / post
  let r = await post(`/api/stories/${pic}/save`, U.saver);
  assert.equal(r.status, 200, JSON.stringify(r.d)); assert.equal(r.d.again, false);
  assert.equal((await post(`/api/stories/${pic}/save`, U.saver)).d.again, true, "idempotent");
  assert.equal((await post(`/api/stories/${vid}/save`, U.saver)).status, 200);
  assert.equal((await post(`/api/stories/${vid}/save`, U.bob)).status, 200);
  for (const who of [U.owner, U.admin, U.alice]) {
    r = await post(`/api/stories/${pic}/post`, who);
    assert.equal(r.status, 403, who.username); assert.match(r.d.error, /own story/);
  }
  // the collection: private, labelled as the member's story, a copy that outlives the 24 h
  const saved = await keep.savedFor(U.saver);
  const sp = saved.find((x) => x.id === pic), sv = saved.find((x) => x.id === vid);
  assert.ok(sp && sv);
  assert.equal(sp.source, "user"); assert.equal(sp.by, "Alice A"); assert.equal(sp.mediaKind, "image"); assert.match(sp.src, /^\/media\/s\//);
  assert.equal(sv.mediaKind, "video");
  const pg = await page("/u/saver/saved", U.saver);
  assert.match(pg.html, /Alice A&#39;s story in /);
  assert.equal((await page("/u/saver/saved", U.bob)).status, 404, "nobody else's");
  assert.equal((await fetch(base + sp.src, { headers: { "x-test-user": U.bob.userId } })).status, 404);
  assert.equal((await fetch(base + sp.src, { headers: { "x-test-user": U.saver.userId } })).status, 200);
  // expiry keeps the copy (the persistence rule)
  await runQuery("UPDATE media SET expires = ?, deleted = 1 WHERE id = ?", [Date.now() - 1000, vid]);
  assert.ok((await keep.savedFor(U.saver)).some((x) => x.id === vid), "outlives its 24 h");
  // other kinds of a member's own row stay unsaveable (rule: source "user" AND kind photo|clip)
  const aud = await capture({ kind: "audio", source: "user", byId: U.alice.userId });
  r = await post(`/api/stories/${aud}/save`, U.saver);
  assert.equal(r.status, 403); assert.match(r.d.error, /own story/);
  G.pic = pic;
});

test("respecting the uploader: deleting the story (or a pad owner / staff removing it) drops every saved copy", async () => {
  const keepRow = async (id) => (await getQuery("SELECT * FROM story_keeps WHERE capture_id = ?", [id]))[0];
  // the uploader deletes
  assert.ok((await keep.savedFor(U.saver)).some((x) => x.id === G.pic));
  const file = (await keepRow(G.pic)).file;
  assert.equal((await post(`/api/stories/${G.pic}/delete`, U.alice)).status, 200);
  assert.ok(!(await keep.savedFor(U.saver)).some((x) => x.id === G.pic), "gone from the collection");
  assert.ok((await keepRow(G.pic)).purged_at, "the copy is purged");
  assert.equal(fs.existsSync(fmedia.filePath(file)), false, "and its file");
  // moderation: the pad's owner and staff
  for (const mod of [U.owner, U.admin]) {
    const s = await story(U.bob, ROOM);
    assert.equal((await post(`/api/stories/${s}/save`, U.saver)).status, 200);
    assert.equal((await post(`/api/stories/${s}/delete`, mod)).status, 200, mod.username);
    assert.ok(!(await keep.savedFor(U.saver)).some((x) => x.id === s), "removed by " + mod.username);
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_saves WHERE capture_id = ?", [s]))[0].n, 0);
  }
  // a stranger can't delete it (and so can't take anyone's saved copy)
  const s2 = await story(U.bob, ROOM);
  await post(`/api/stories/${s2}/save`, U.saver);
  assert.equal((await post(`/api/stories/${s2}/delete`, U.saver)).status, 403);
  assert.ok((await keep.savedFor(U.saver)).some((x) => x.id === s2));
});

// ───────────────────────────── 3. the pad viewer's scope (the bug) ─────────────────────────────
test("regression: a PROFILE story never shows in a pad's story viewer - /api/stories?room= is that pad only; the strip opens it", async () => {
  await runQuery("UPDATE media SET deleted = 1");             // a clean 24 h
  const padCap = await capture({ room: DRAMA, subject: "dramacf" });
  const padStory = await story(U.bob, DRAMA);                 // a member's story posted TO the pad
  const stage = await capture({ room: DRAMA, source: "stage", subject: "Streamer" });
  const profStory = await story(U.alice, "profile");          // Alice's PROFILE story (room user:u_alice)
  const otherPad = await capture({ room: ROOM, subject: "subjcf" });
  const ids = (list) => list.flatMap((r) => r.items.map((x) => x.id));
  // the pad's own list: exactly its captures, its stage captures and the stories posted to it
  let fv = await stories.forViewer(U.saver, { room: DRAMA });
  assert.equal(fv.length, 1); assert.equal(fv[0].id, DRAMA);
  assert.deepEqual(ids(fv).sort(), [padCap, padStory, stage].sort());
  // the API the viewer uses from the pad's strip
  let r = await get("/api/stories?room=" + DRAMA, U.saver);
  assert.equal(r.status, 200);
  assert.deepEqual(r.d.rooms.map((x) => x.id), [DRAMA], "no other pad, no person story to run on into");
  assert.ok(!ids(r.d.rooms).includes(profStory), "the profile story isn't in the pad's viewer");
  assert.ok(!ids(r.d.rooms).includes(otherPad));
  assert.ok(!r.d.rooms.some((x) => x.person));
  // the pad page's strip is scoped (the viewer loads ?room=<pad>), and the client honours it
  const pg = (await page("/p/" + (rooms.getCached(DRAMA) || {}).slug, U.saver)).html;
  assert.match(pg, new RegExp('<section class="ss"[^>]*data-scope="' + DRAMA + '"'));
  assert.ok(!pg.includes('data-story-item="' + profStory + '"'), "not in the strip either");
  const js = fs.readFileSync(path.join(repo, "public/js/stories.js"), "utf8");
  assert.match(js, /'\/api\/stories' \+ \(scope \? '\?room=' \+ encodeURIComponent\(scope\) : ''\)/);
  assert.match(js, /strip\.getAttribute\('data-scope'\)/);
  // the reverse: the person ring has her profile story, not a story she posted to a pad
  const padByAlice = await story(U.alice, DRAMA);
  const ps = await US.personStory(U.saver, U.alice.userId);
  assert.deepEqual(ps.items.map((x) => x.id), [profStory]);
  r = await get("/api/stories?room=user:" + U.alice.userId, U.saver);
  assert.deepEqual(r.d.rooms.map((x) => x.id), ["user:" + U.alice.userId]);
  assert.deepEqual(ids(r.d.rooms), [profStory], "a profile id is the person story alone");
  fv = await stories.forViewer(U.saver, { room: DRAMA });
  assert.ok(ids(fv).includes(padByAlice), "her pad story is the pad's");
  // the homepage / /feed strip (no room): pad circles never carry profile stories; the person circle does
  const home = await stories.forViewer(U.saver);
  const padC = home.find((x) => x.id === DRAMA), person = home.find((x) => x.id === "user:" + U.alice.userId);
  assert.ok(padC && person && person.person);
  assert.ok(!padC.items.some((x) => x.id === profStory));
  assert.ok(!home.some((x) => !x.person && x.items.some((i) => i.id === profStory)));
  // bad input
  assert.equal((await get("/api/stories?room=" + encodeURIComponent("bad room!"), U.saver)).status, 400);
  assert.equal((await get("/api/stories?room=" + DRAMA, null)).status, 401);
});
