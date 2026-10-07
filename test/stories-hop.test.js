// Offline tests for 1.99eq: keeping story captures (storykeep.js - 📌 Post to pad, 🔖 Save, "Remove me", the
// consent rules, removal cascades) and Hop (hop.js - the media-only feed filter, cursor paging, the /hop pages and
// where the feeds surface it).
//   NODE_PATH=<repo>/node_modules node --test test/stories-hop.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stories-hop-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });
const express = require("express");
const sharp = require("sharp");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const fmedia = require(path.join(repo, "feedmedia"));
const web = require(path.join(repo, "feedweb"));
require(path.join(repo, "terms"))._setRequired(false);
const stories = require(path.join(repo, "stories"));
const keep = require(path.join(repo, "storykeep"));
const hop = require(path.join(repo, "hop"));
const layout = require(path.join(repo, "profilelayout"));
const media = require(path.join(repo, "media"));

const ROOM = "plant_based_chatting", SLUG = "plant-based-chatting", LOUNGE = "patv:lounge";
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
const page = async (url, u) => { const r = await fetch(base + url, { headers: u ? { "x-test-user": u.userId } : {}, redirect: "manual" }); return { status: r.status, html: await r.text(), r }; };

let seq = 0;
async function capture(opts = {}) {
  const { room = ROOM, subject = "subjcf", by = "capcf", kind = "photo", anon = 0, nsfw = 0, ageMin = 5, hours = 24, source = null, byId = null } = opts;
  const id = "c0ffee" + String(++seq).padStart(6, "0");
  const t = Date.now() - ageMin * 60e3;
  const ext = kind === "photo" ? "jpg" : kind === "clip" ? "mp4" : "m4a";
  await runQuery(`INSERT INTO media (id, kind, ct, file, bytes, secs, subject, by_user, room, created, expires, deleted, anon, source, nsfw, by_user_id)
                  VALUES (?, ?, ?, ?, 10, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
                 [id, kind, kind === "photo" ? "image/jpeg" : kind === "clip" ? "video/mp4" : "audio/mp4", id + "." + ext, kind === "photo" ? 0 : 7,
                  subject, by, room, t, t + hours * 3600e3, anon, source, nsfw, byId]);
  fs.writeFileSync(path.join(process.env.MEDIA_DIR, id + "." + ext), kind === "photo" ? jpg : Buffer.from("fake-mp4-bytes"));
  return id;
}
const feedFile = (name) => fmedia.filePath(name);
async function expire(id) {
  // the 24 h are over and the purge ran: the row is deleted and its file is gone
  const r = (await getQuery("SELECT * FROM media WHERE id = ?", [id]))[0];
  await runQuery("UPDATE media SET expires = ?, deleted = 1 WHERE id = ?", [Date.now() - 1000, id]);
  try { fs.unlinkSync(path.join(process.env.MEDIA_DIR, r.file)); } catch (e) { /* gone */ }
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await media.ready;
  await require(path.join(repo, "inbox")).ready;
  jpg = await sharp({ create: { width: 16, height: 12, channels: 3, background: "#0a0" } }).jpeg().toBuffer();
  U.owner = await mkUser("plantowner", { camfrog: "foamy1111" });
  U.admin = await mkUser("boss", { class: "Admin", camfrog: "bossfrog" });
  U.cap = await mkUser("capper", { camfrog: "capcf", display: "Cap Per" });
  U.subj = await mkUser("subby", { camfrog: "subjcf", display: "Sub By" });
  U.stranger = await mkUser("stranger", { camfrog: "strangercf" });
  U.mod = await mkUser("moddy", { camfrog: "modcf" });
  U.shy = await mkUser("shy", { camfrog: "shycf" });
  U.saver = await mkUser("saver", { camfrog: "savercf" });
  U.alice = await mkUser("alice", { camfrog: "alicecf" });
  await rooms.init();
  await rooms.setOwner(ROOM, "plantowner", "test");
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0 }, "test");
  await keep.init();
  // pad mods are Camfrog mod powers Pepe reports for the room (padmod.capsFor) - faked here
  keep._setModCheck((acct, roomId) => !!acct && acct.camfrogUsername === "modcf" && roomId === ROOM);
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
  hop.register(app, { addUser });
  media.register(app, { addUser, isBotToken: (t) => t === "bot", noTimers: true });
  require(path.join(repo, "bridge")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });
test.beforeEach(() => { store._gaps.clear(); });

// ───────────────────────────── 📌 Post to pad ─────────────────────────────
test("post to pad: capturer / pad owner / pad mod / admin may; a stranger may not; credited to the capturer, NSFW + provenance carried", async () => {
  const c1 = await capture({ nsfw: 1 });
  let r = await post(`/api/stories/${c1}/post`, U.stranger, { caption: "mine now" });
  assert.equal(r.status, 403, "a stranger can't post someone's capture");
  assert.equal((await post(`/api/stories/${c1}/post`, null)).status, 401);
  const noXrw = await fetch(base + `/api/stories/${c1}/post`, { method: "POST", headers: { "x-test-user": U.cap.userId, "content-type": "application/json" }, body: "{}" });
  assert.equal(noXrw.status, 403, "no X-Requested-With: refused");
  r = await post(`/api/stories/${c1}/post`, U.cap, { caption: "Look at this <b>leaf</b>" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.again, false);
  assert.match(r.d.post.url, new RegExp("^/p/" + SLUG + "/posts/"));
  const P = await store.get(r.d.post.id, U.subj);
  assert.equal(P.author.userId, U.cap.userId, "credited to the capturer");
  assert.equal(P.title, "Look at this <b>leaf</b>");
  assert.equal(P.nsfw, true, "NSFW carried over");
  assert.equal(P.images.length, 1);
  assert.ok(P.capture && P.capture.room.title === "Houseplants" && P.capture.subject.username === "subby", "provenance + the subject's profile");
  assert.equal(P.capture.canRemoveMe, true, "the subject sees Remove me");
  assert.equal((await store.get(r.d.post.id, U.stranger)).capture.canRemoveMe, false);
  // the copy is the post's own file, not the 24 h capture
  assert.ok(fs.existsSync(feedFile(P.images[0].file)));
  // idempotent: again (and a second click) -> the same post
  const again = await post(`/api/stories/${c1}/post`, U.cap, {});
  assert.equal(again.status, 200); assert.equal(again.d.again, true); assert.equal(again.d.post.id, r.d.post.id);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_posts WHERE capture_id = ?", [c1]))[0].n, 1);
  // the subject was told (with the way out)
  const n = await getQuery("SELECT * FROM inbox WHERE user_id = ? AND ref = ?", [U.subj.userId, "story-post:" + r.d.post.id]);
  assert.equal(n.length, 1);
  // it outlives the capture: the 24 h file goes, the post's picture is still served
  await expire(c1);
  const f = await fetch(base + "/media/f/" + P.images[0].file, { headers: { "x-test-user": U.alice.userId } });
  assert.equal(f.status, 200);
  assert.equal(f.headers.get("content-type"), "image/webp");

  // the pad owner, a pad mod and an admin may post someone else's capture - still credited to the capturer
  for (const who of [U.owner, U.mod, U.admin]) {
    const c = await capture({ kind: "photo" });
    const x = await post(`/api/stories/${c}/post`, who, {});
    assert.equal(x.status, 200, who.username + ": " + JSON.stringify(x.d));
    const Px = await store.get(x.d.post.id, null);
    assert.equal(Px.author.userId, U.cap.userId, who.username + " posts it credited to the capturer");
    assert.match(Px.title, /^Snap of subjcf in Houseplants$/);
  }
  // the mod check is per pad: no powers elsewhere
  const other = await capture({ room: "PepeFrog.Room" });
  assert.equal((await post(`/api/stories/${other}/post`, U.mod, {})).status, 403);
  // stage captures: the capturer is by_user_id
  const st = await capture({ source: "stage", by: "Cap Per", byId: U.cap.userId, subject: "Some Stream", kind: "photo" });
  assert.equal((await post(`/api/stories/${st}/post`, U.stranger, {})).status, 403);
  assert.equal((await post(`/api/stories/${st}/post`, U.cap, {})).status, 200);
  // a clip: copied as an mp4 video attachment (its own file in the feed directory)
  const clip = await capture({ kind: "clip" });
  const cp = await post(`/api/stories/${clip}/post`, U.cap, {});
  assert.equal(cp.status, 200);
  const V = (await store.get(cp.d.post.id, null)).video[0];
  assert.ok(V && /^[a-f0-9]{32}\.mp4$/.test(V.file) && fs.existsSync(feedFile(V.file)));
  assert.equal(fs.readFileSync(feedFile(V.file), "utf8"), "fake-mp4-bytes");
});

test("post to pad / save: private subjects (incognito, bridge hide, hidden analytics), anonymous capturers, removed and expired captures are refused", async () => {
  const anon = await capture({ subject: "", anon: 1 });
  let r = await post(`/api/stories/${anon}/post`, U.cap, {});
  assert.equal(r.status, 403); assert.match(r.d.error, /private/);
  assert.equal((await post(`/api/stories/${anon}/save`, U.saver)).status, 403);
  await layout.save(U.shy.userId, { hidden: ["analytics"] });
  const shy = await capture({ subject: "shycf" });
  assert.equal((await post(`/api/stories/${shy}/post`, U.admin, {})).status, 403, "not even an admin");
  assert.equal((await post(`/api/stories/${shy}/save`, U.saver)).status, 403);
  const someone = await capture({ by: "someone" });
  assert.equal((await post(`/api/stories/${someone}/post`, U.admin, {})).status, 403);
  const gone = await capture();
  await runQuery("UPDATE media SET deleted = 1 WHERE id = ?", [gone]);
  assert.equal((await post(`/api/stories/${gone}/post`, U.cap, {})).status, 410);
  assert.equal((await post(`/api/stories/${gone}/save`, U.saver)).status, 410);
  const old = await capture({ ageMin: 60, hours: 0.5 });
  assert.equal((await post(`/api/stories/${old}/post`, U.cap, {})).status, 410);
  assert.equal((await post(`/api/stories/nothex!/post`, U.cap, {})).status, 404);
  // the viewer's flags say the same (the buttons don't show)
  const live = await capture();
  const S = await stories.forViewer(U.cap, { room: ROOM });
  const items = S.find((x) => x.id === ROOM).items;
  const f = (id) => items.find((c) => c.id === id);
  assert.deepEqual(f(live).can, { post: true, save: true });
  assert.deepEqual(f(anon).can, { post: false, save: false });
  assert.equal(f(shy).can.post, false);
  const S2 = await stories.forViewer(U.stranger, { room: ROOM });
  assert.deepEqual(S2.find((x) => x.id === ROOM).items.find((c) => c.id === live).can, { post: false, save: true }, "anyone signed in may save; only some may post");
});

test("Remove me: only the subject (by account or linked Camfrog login), one click soft-deletes, the poster is told, idempotent, no re-post", async () => {
  const c = await capture();
  const made = (await post(`/api/stories/${c}/post`, U.owner, { caption: "plant party" })).d.post;
  assert.equal((await post(`/api/stories/posts/${made.id}/remove-me`, U.stranger)).status, 403);
  assert.equal((await post(`/api/stories/posts/${made.id}/remove-me`, U.cap)).status, 403, "not the capturer either");
  // the post page shows the subject the button
  const pg = await page(made.url, U.subj);
  assert.equal(pg.status, 200);
  assert.match(pg.html, /class="fp-cap"[^]*Captured from[^]*u\/subby/);
  assert.match(pg.html, /data-act="remove-me"/);
  assert.ok(!(await page(made.url, U.alice)).html.includes('data-act="remove-me"'), "nobody else sees it");
  const r = await post(`/api/stories/posts/${made.id}/remove-me`, U.subj);
  assert.equal(r.status, 200); assert.equal(r.d.again, false);
  const row = await store.getRow(made.id);
  assert.ok(row.deleted_at); assert.equal(row.deleted_by, "subject");
  assert.equal((await page(made.url, U.alice)).status, 404, "gone for everyone");
  const told = await getQuery("SELECT user_id FROM inbox WHERE ref = ?", ["story-rm:" + made.id]);
  assert.deepEqual(told.map((x) => x.user_id).sort(), [U.cap.userId, U.owner.userId].sort(), "the poster and the credited capturer");
  const again = await post(`/api/stories/posts/${made.id}/remove-me`, U.subj);
  assert.equal(again.status, 200); assert.equal(again.d.again, true);
  const re = await post(`/api/stories/${c}/post`, U.cap, {});
  assert.equal(re.status, 409, "a capture its subject removed can't be posted again");
  // matched by the linked Camfrog login when the subject linked AFTER it was posted
  const c2 = await capture({ subject: "latecomer" });
  const p2 = (await post(`/api/stories/${c2}/post`, U.cap, {})).d.post;
  const late = await mkUser("late", { camfrog: "latecomer" });
  assert.equal((await store.get(p2.id, late)).capture.canRemoveMe, true);
  assert.equal((await post(`/api/stories/posts/${p2.id}/remove-me`, late)).status, 200);
});

// ───────────────────────────── 🔖 Save ─────────────────────────────
test("save / unsave: private to the saver, idempotent, the copy outlives the capture, unsave drops it", async () => {
  const c = await capture({ kind: "photo" });
  let r = await post(`/api/stories/${c}/save`, U.saver);
  assert.equal(r.status, 200); assert.equal(r.d.again, false);
  r = await post(`/api/stories/${c}/save`, U.saver);
  assert.equal(r.d.again, true, "saving twice is a no-op");
  let list = (await call("GET", "/api/stories/saved", U.saver)).d.items;
  assert.equal(list.length, 1); assert.equal(list[0].id, c); assert.equal(list[0].kind, "photo"); assert.equal(list[0].room.title, "Houseplants");
  assert.equal((await call("GET", "/api/stories/saved", null)).status, 401);
  assert.equal((await call("GET", "/api/stories/saved", U.alice)).d.items.length, 0, "only ever your own");
  const file = list[0].src;
  assert.match(file, /^\/media\/s\/[a-f0-9]{32}\.webp$/);
  assert.equal((await fetch(base + file, { headers: { "x-test-user": U.saver.userId } })).status, 200);
  assert.equal((await fetch(base + file, { headers: { "x-test-user": U.alice.userId } })).status, 404, "nobody else gets the file");
  assert.equal((await fetch(base + file)).status, 404);
  // the page: the owner's, nobody else's
  const pg = await page("/u/saver/saved", U.saver);
  assert.equal(pg.status, 200); assert.ok(pg.html.includes('data-svd-open="' + c + '"')); assert.match(pg.html, /hop\.js\?v=\d+/);
  assert.equal((await page("/u/saver/saved", U.alice)).status, 404);
  assert.equal((await page("/u/saver/saved", null)).status, 302);
  // the profile shows its owner the Saved tab
  // (rendered by index.js's profile route; the partial check is the template itself)
  assert.match(fs.readFileSync(path.join(repo, "views/profile.ejs"), "utf8"), /if \(isMe\) \{ %><a class="pf-tab" href="<%= base %>\/saved"/);
  // after the story's 24 h: still there, still served
  await expire(c);
  list = (await call("GET", "/api/stories/saved", U.saver)).d.items;
  assert.equal(list.length, 1, "saved after expiry");
  assert.equal((await fetch(base + file, { headers: { "x-test-user": U.saver.userId } })).status, 200);
  // unsave: gone, the copy is deleted with the last save; again is fine
  r = await post(`/api/stories/${c}/unsave`, U.saver);
  assert.equal(r.status, 200); assert.equal(r.d.again, false);
  assert.equal((await call("GET", "/api/stories/saved", U.saver)).d.items.length, 0);
  assert.equal((await fetch(base + file, { headers: { "x-test-user": U.saver.userId } })).status, 404);
  assert.ok(!fs.existsSync(feedFile(file.split("/").pop())), "the file is deleted");
  assert.equal((await post(`/api/stories/${c}/unsave`, U.saver)).d.again, true);
  // the viewer's saved flag
  const c2 = await capture();
  await post(`/api/stories/${c2}/save`, U.saver);
  const S = await stories.forViewer(U.saver, { room: ROOM });
  assert.equal(S.find((x) => x.id === ROOM).items.find((i) => i.id === c2).saved, true);
});

test("a capture taken down before it expires (or later made private) takes every Saved copy - and its post - with it", async () => {
  const c = await capture();
  await post(`/api/stories/${c}/save`, U.saver);
  await post(`/api/stories/${c}/save`, U.alice);
  const made = (await post(`/api/stories/${c}/post`, U.cap, {})).d.post;
  const k = (await getQuery("SELECT * FROM story_keeps WHERE capture_id = ?", [c]))[0];
  assert.ok(fs.existsSync(feedFile(k.file)));
  // Pepe's admin !snap delete, before the 24 h are up
  const d = await fetch(base + "/api/media/delete", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer bot" }, body: JSON.stringify({ id: c }) });
  assert.equal(d.status, 200);
  const has = async (u, id) => (await call("GET", "/api/stories/saved", u)).d.items.some((x) => x.id === id);
  assert.equal(await has(U.saver, c), false);
  assert.equal(await has(U.alice, c), false);
  assert.ok(!fs.existsSync(feedFile(k.file)), "the kept copy is deleted");
  assert.ok((await store.getRow(made.id)).deleted_at, "the post made from it is hidden too");
  // Pepe marks a capture private afterwards (the subject went !incognito)
  const c2 = await capture();
  await post(`/api/stories/${c2}/save`, U.saver);
  const a = await fetch(base + "/api/media/anon", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer bot" },
                                                     body: JSON.stringify({ items: [{ id: c2, subject: true }] }) });
  assert.equal(a.status, 200);
  assert.equal(await has(U.saver, c2), false);
  // expiry is NOT a takedown: saved copies stay
  const c3 = await capture();
  await post(`/api/stories/${c3}/save`, U.saver);
  await runQuery("UPDATE media SET expires = ? WHERE id = ?", [Date.now() - 1000, c3]);
  await fetch(base + "/api/media/delete", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer bot" }, body: JSON.stringify({ id: c3 }) });
  assert.equal(await has(U.saver, c3), true);
  // a stage capture deleted by its capturer: saves go, the capturer's own post stays
  const st = await capture({ source: "stage", by: "Cap Per", byId: U.cap.userId, subject: "Stream" });
  await post(`/api/stories/${st}/save`, U.alice);
  const sp = (await post(`/api/stories/${st}/post`, U.cap, {})).d.post;
  const res = await keep.onCaptureRemoved(st, { reason: "removed", byCapturer: true });
  assert.equal(res.saves, 1); assert.equal(res.post, false);
  assert.ok(!(await store.getRow(sp.id)).deleted_at);
});

// ───────────────────────────── Hop ─────────────────────────────
let hopPosts = [];
async function mediaPost(author, title, { kind = "image", nsfw = false, community = LOUNGE } = {}) {
  const att = require("crypto").randomBytes(12).toString("hex");
  const f = require("crypto").randomBytes(16).toString("hex");
  await runQuery(`INSERT INTO feed_attachments (id, owner_id, kind, ct, file, thumb, poster, w, h, bytes, state, created, size_declared, received)
                  VALUES (?, ?, ?, ?, ?, ?, ?, 10, 10, 10, 'ready', ?, 10, 10)`,
                 [att, author.userId, kind, kind === "image" ? "image/webp" : "video/mp4", f + (kind === "image" ? ".webp" : ".mp4"),
                  kind === "image" ? f + "_t.webp" : null, kind === "video" ? f + "_p.webp" : null, Date.now()]);
  return store.create(author.userId, { title, attachments: [att], nsfw, community });
}

test("Hop data: the media-only filter, cursor paging (no repeats, everything once), ?post= starts there, NSFW never for visitors", async () => {
  await store.create(U.alice.userId, { title: "just words", community: LOUNGE });
  hopPosts = [];
  for (let i = 0; i < 11; i++) hopPosts.push(await mediaPost(U.alice, "hop pic " + i, { kind: i % 3 === 0 ? "video" : "image" }));
  const nsfw = await mediaPost(U.alice, "hop nsfw", { nsfw: true });
  const L = await store.list({ sort: "new", media: true, viewer: U.alice, limit: 100 });
  assert.ok(L.posts.every((p) => p.images.length || p.video.length || (p.xpost && p.xpost.post)), "media only");
  assert.ok(!L.posts.some((p) => p.title === "just words"));
  // page through /api/hop with the cursor
  const seen = [];
  let cur = null, guard = 0;
  do {
    const r = await call("GET", "/api/hop?scope=all&sort=new" + (cur ? "&cursor=" + encodeURIComponent(cur) : ""), U.alice);
    assert.equal(r.status, 200);
    for (const it of r.d.items) { seen.push(it.id); assert.ok(it.media.length >= 1); assert.ok(it.url && it.author && it.pad); }
    cur = r.d.next;
  } while (cur && ++guard < 20);
  assert.equal(new Set(seen).size, seen.length, "no repeats");
  for (const p of hopPosts.concat([nsfw])) assert.ok(seen.includes(p.id), "every media post once");
  const first = (await call("GET", "/api/hop?scope=all&sort=new", U.alice)).d;
  assert.equal(first.items.length, hop.PAGE);
  assert.equal(first.items[0].id, nsfw.id); assert.equal(first.items[0].nsfw, true);
  const vid = first.items.find((x) => x.media[0].kind === "video");
  assert.ok(vid && /^\/media\/f\/[a-f0-9]{32}\.mp4$/.test(vid.media[0].src) && /_p\.webp$/.test(vid.media[0].poster));
  // ?post= : starts at that post, then goes on in the feed's order
  const mid = hopPosts[4];
  const at = (await call("GET", "/api/hop?scope=all&sort=new&post=" + mid.id, U.alice)).d;
  assert.equal(at.items[0].id, mid.id);
  assert.equal(at.items[1].id, hopPosts[3].id, "then the next one down the New feed");
  // signed out: no NSFW at all
  const out = (await call("GET", "/api/hop?scope=all&sort=new", null)).d;
  assert.ok(!out.items.some((x) => x.nsfw));
  assert.ok(!(await call("GET", "/api/hop?scope=all&sort=new&post=" + nsfw.id, null)).d.items.some((x) => x.id === nsfw.id));
  // scopes: a pad, a member; Following needs a sign-in; unknown ones 404
  const padPost = await mediaPost(U.owner, "plant pic", { community: ROOM });
  const pad = (await call("GET", "/api/hop?scope=p/" + SLUG + "&sort=new", U.alice)).d;
  assert.deepEqual(pad.items.map((x) => x.id).includes(padPost.id), true);
  assert.ok(pad.items.every((x) => x.pad.label === "p/" + SLUG));
  const mem = (await call("GET", "/api/hop?scope=u/plantowner&sort=new", U.alice)).d;
  assert.ok(mem.items.length >= 1 && mem.items.every((x) => x.author.username === "plantowner"));
  assert.equal((await call("GET", "/api/hop?scope=following", null)).status, 401);
  assert.equal((await call("GET", "/api/hop?scope=p/no-such-pad", null)).status, 404);
  assert.equal((await call("GET", "/api/hop?scope=u/nobody-here", null)).status, 404);
  // a deleted post drops out
  await store.remove(U.alice, hopPosts[0].id);
  assert.ok(!(await call("GET", "/api/hop?scope=all&sort=new&post=" + hopPosts[0].id, U.alice)).d.items.some((x) => x.id === hopPosts[0].id));
  // cursors are opaque and clamped
  assert.equal(hop.decCursor(hop.encCursor(16)), 16);
  assert.equal(hop.decCursor("garbage"), 0);
  assert.equal(hop.decCursor(hop.encCursor(1e9)), 5000);
});

test("Hop pages and where the feeds surface it: /hop, /p/<pad>/hop, /u/<user>/hop, /feed/following/hop; the sort bar button; tap-to-Hop media", async () => {
  let r = await page("/hop", U.alice);
  assert.equal(r.status, 200);
  assert.match(r.html, /id="hopInit"/); assert.match(r.html, /hop\.js\?v=\d+" data-hop-name="Hop"/);
  const init = JSON.parse(r.html.split('id="hopInit">')[1].split("</script>")[0]);
  assert.equal(init.scope, "all"); assert.equal(init.base, "/hop"); assert.equal(init.back, "/feed"); assert.ok(init.items.length > 0);
  r = await page("/hop?post=" + hopPosts[5].id + "&sort=new", U.alice);
  assert.equal(JSON.parse(r.html.split('id="hopInit">')[1].split("</script>")[0]).items[0].id, hopPosts[5].id, "a shared link opens that post");
  r = await page("/p/" + SLUG + "/hop", U.alice);
  assert.equal(r.status, 200);
  const pi = JSON.parse(r.html.split('id="hopInit">')[1].split("</script>")[0]);
  assert.equal(pi.base, "/p/" + SLUG + "/hop"); assert.equal(pi.back, "/p/" + SLUG);
  r = await page("/u/plantowner/hop", null);
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.html.split('id="hopInit">')[1].split("</script>")[0]).back, "/u/plantowner/posts");
  assert.equal((await page("/u/nobody-here/hop", null)).status, 404);
  assert.equal((await page("/p/no-such-pad/hop", null)).status, 404);
  r = await page("/feed/following/hop", null);
  assert.equal(r.status, 302); assert.match(r.r.headers.get("location"), /^\/login\?next=/);
  assert.equal((await page("/feed/following/hop", U.alice)).status, 200);
  // the inline JSON can't close its script tag
  await mediaPost(U.alice, "</script><script>alert(1)</script>");
  const x = await page("/hop?sort=new", U.alice);
  assert.ok(!x.html.split('id="hopInit">')[1].split("</script>")[0].includes("<"));
  // the feeds: the "▶ Hop" button by the sort bar, scoped to that feed; feed media carry data-hop
  const feed = (await page("/feed?sort=new", U.alice)).html;
  assert.match(feed, /class="fs-hop" href="\/hop\?sort=new" data-hop-scope="all" data-hop-sort="new"/);
  assert.match(feed, /data-hop>/, "pictures open Hop");
  assert.match(feed, /class="fp-video fp-vhop[^"]*" href="[^"]+" data-hop/, "videos are tap-to-Hop posters in feeds");
  assert.match(feed, /hop\.js\?v=\d+/);
  const fol = (await page("/feed/following", U.alice)).html;
  assert.match(fol, /data-hop-scope="following"/);
  const by = (await page("/feed?by=plantowner", U.alice)).html;
  assert.match(by, /data-hop-scope="u\/plantowner"/);
  const padPage = (await page("/p/" + SLUG, U.alice)).html;
  assert.match(padPage, new RegExp('data-hop-scope="p/' + SLUG + '"'));
  const prof = await web.profileSocial({ userId: U.owner.userId, username: "plantowner" }, U.alice);
  const ejs = require("ejs");
  const pp = await ejs.renderFile(path.join(repo, "views/partials/profile-posts.ejs"), { social: prof, usernameProfile: "plantowner", displayname: "plantowner", isMe: false });
  assert.match(pp, /data-hop-scope="u\/plantowner"/);
  // the post page keeps the full-size link and the inline player (no Hop interception there)
  const one = await store.get(hopPosts[3].id, U.alice);
  const det = (await page(one.url, U.alice)).html;
  assert.ok(!/data-hop[ >]/.test(det.split('class="fp ')[1] || ""), "no data-hop on the post page");
  assert.match(det, /<video src="\/media\/f\/[a-f0-9]{32}\.mp4" controls/);
  // the name lives in one constant
  assert.equal(hop.HOP.name, "Hop");
  assert.equal(web.fx.HOP, hop.HOP);
});
