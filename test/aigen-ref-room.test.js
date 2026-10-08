// Offline tests for 1.99dn (aigen.js; Pepe's half is camfrog-bot pepe_aigen.py + aigen_test.py):
//   * the Generate panel's REFERENCE PICTURE: one of the account's own ready pictures (an upload / a draft picture),
//     priced + Pepe's -cam surcharge (pushed with the prices), handed to Pepe by /start as a metadata-free JPEG, the
//     composer's upload / "from this draft" controls and the "right to use" note
//   * ROOM GENERATIONS -> the room's pad feed: /api/feed/aigen/room (bot) decides (pad switch, the member's opt-out,
//     bans, Pepe's refusals, post limits, Camfrog pads only), the author (linked account / Pepe "made by ... in the
//     room" / incognito "someone" / Pepe's own), then the same /chunk + /result make the post: free, ai_generated,
//     NSFW when flagged, never announced in the room, never in the composer, no inbox notice
//   node --test test/aigen-ref-room.test.js      (needs the repo's node_modules; temp DB + dirs)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aigen-refroom-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
process.env.FEED_NO_NICE = "1";
const express = require("express");
const sharp = require("sharp");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const web = require(path.join(repo, "feedweb"));
const media = require(path.join(repo, "feedmedia"));
const AG = require(path.join(repo, "aigen"));
require(path.join(repo, "terms"))._setRequired(false);

const ROOM = "plant_based_chatting", LOUNGE = "patv:lounge";
const BOT = "bot";
let base, server;
const U = {};
const users = new Map();

async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, ?, ?, ?, ?, 0)`,
                 [id, name, name, extra.class || "pleb", 1000, extra.camfrog || null, extra.level || 0, "2026-01-01 00:00:00"]);
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
  U.alice = await mkUser("alice", { camfrog: "alicecf" });
  U.bob = await mkUser("bob", { camfrog: "bobcf" });
  U.banned = await mkUser("banned", { camfrog: "bannedcf" });
  U.owner = await mkUser("plantowner", { camfrog: "foamy1111" });
  await rooms.init();
  await rooms.setOwner(ROOM, "plantowner", "test");
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, uploads_per_hour: 1000, post_gap_secs: 0, comment_gap_secs: 0, price_post: 500, price_image: 500 }, "test");
  await runQuery("INSERT INTO feed_bans (user_id, room_id, reason, by, at) VALUES (?, '', 'spam', 'test', ?)", [U.banned.userId, Date.now()]);
  const app = express();
  app.use((req, res, next) => (req.path === "/api/feed/aigen/chunk" ? next() : express.json()(req, res, next)));
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  require(path.join(repo, "pads")).register(app);
  web.register(app, { addUser, isBotToken: (t) => t === BOT });
  AG.register(app, { addUser, isBotToken: (t) => t === BOT, noTimers: true, audit: async () => {} });
  require(path.join(repo, "bridge")).register(app, { addUser, isBotToken: (t) => t === BOT });
  require(path.join(repo, "padsettings")).register(app, { addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await pepe("/api/feed/aigen/prices", { global: { imagine: 25000, video: 100000, camsurcharge: 10000 },
                                         rooms: { [ROOM]: { imagine: 40000, video: 150000, camsurcharge: 12000 } } });
});
test.after(() => { server.close(); });
test.beforeEach(async () => { store._gaps.clear(); });

const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {});
async function call(method, url, u, body) {
  const r = await fetch(base + url, { method, headers: H(u), body: body === undefined ? undefined : JSON.stringify(body) });
  let d = null;
  try { d = await r.json(); } catch (e) { d = null; }
  return { status: r.status, d };
}
const post = (url, u, body) => call("POST", url, u, body);
const get = (url, u) => call("GET", url, u);
function pepe(url, body) { return call("POST", url, null, Object.assign({ password: BOT }, body)); }
async function jobRow(id) { return (await getQuery("SELECT * FROM feed_aigen_jobs WHERE id = ?", [id]))[0]; }
async function clearJobs() {
  await runQuery("UPDATE feed_aigen_jobs SET status = 'discarded' WHERE status IN ('queued','running')");
  await runQuery("UPDATE pepe_actions SET status = 'done' WHERE status IN ('pending','claimed')").catch(() => {});
}
async function smallPng(color = "#3a6") { return sharp({ create: { width: 64, height: 48, channels: 3, background: color } }).png().toBuffer(); }
/** A ready picture attachment of `u` (as the upload pipeline leaves it), with EXIF that must never reach Pepe. */
async function picture(u, kind = "image") {
  const src = path.join(tmp, "ref-" + Math.random().toString(36).slice(2) + ".jpg");
  fs.writeFileSync(src, await sharp({ create: { width: 2400, height: 1600, channels: 3, background: "#c84" } })
    .withMetadata({ exif: { IFD0: { Copyright: "SECRETMARK" } } }).jpeg().toBuffer());
  const out = await media.processImage(src, "jpeg");
  const id = require("crypto").randomBytes(12).toString("hex");
  await runQuery(`INSERT INTO feed_attachments (id, owner_id, kind, ct, file, thumb, w, h, bytes, state, created, size_declared, received)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`, [id, u.userId, kind, out.ct, out.file, out.thumb, out.w, out.h, out.bytes, Date.now(), out.bytes, out.bytes]);
  return id;
}
/** Pepe's side of a room post: /room, then (if ok) chunks + result. */
async function roomGen(body, extra = {}) {
  const s = await pepe("/api/feed/aigen/room", Object.assign({ room: ROOM, kind: "image", prompt: "a frog DJ in a neon club", title: "a frog DJ in a neon club",
                                                             model: "img-model" }, body));
  if (s.status !== 200 || !s.d.ok) return { start: s };
  const buf = extra.buf || await smallPng();
  const c = await pepe("/api/feed/aigen/chunk", { id: s.d.id, offset: 0, data: buf.toString("base64") });
  assert.equal(c.status, 200, JSON.stringify(c.d));
  const r = await pepe("/api/feed/aigen/result", { id: s.d.id, ok: true, size: buf.length, mime: "image/png", model: "img-model", nsfw: !!extra.nsfw, cost: 0 });
  return { start: s, result: r, id: s.d.id };
}

// ───────────────────────────── the reference picture ─────────────────────────────
test("reference picture: own ready picture only, priced + the room's -cam surcharge, handed to Pepe as a metadata-free JPEG", async () => {
  await clearJobs();
  let r = await get("/api/feed/aigen?pad=" + ROOM, U.alice);
  assert.equal(r.d.refPrice, 12000, "the room's camsurcharge (Pepe's push)");
  assert.equal((await get("/api/feed/aigen?pad=" + LOUNGE, U.alice)).d.refPrice, 10000, "a site-only pad: the global one");
  const mine = await picture(U.alice), bobs = await picture(U.bob);
  const mk = (body) => post("/api/feed/aigen", U.alice, Object.assign({ kind: "image", prompt: "make this a pirate", pad: ROOM }, body));
  assert.equal((await mk({ ref: bobs })).status, 400, "someone else's picture can't be a reference");
  assert.equal((await mk({ ref: "nope" })).status, 400, "junk id");
  assert.equal((await mk({ ref: mine, price: 40000 })).status, 409, "a composer price without the surcharge is refused");
  r = await mk({ ref: mine, price: 52000 });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.job.price, 52000, "!imagine 40,000 + surcharge 12,000");
  assert.equal(r.d.job.ref, true);
  const s = await pepe("/api/feed/aigen/start", { id: r.d.job.id, user: "alice" });
  assert.equal(s.status, 200);
  assert.equal(s.d.job.has_ref, true);
  assert.equal(s.d.job.ref.mime, "image/jpeg");
  const jpg = Buffer.from(s.d.job.ref.data, "base64");
  const meta = await sharp(jpg).metadata();
  assert.equal(meta.format, "jpeg");
  assert.ok(meta.width <= AG.REF_MAX_PX && meta.height <= AG.REF_MAX_PX, `resized to fit ${AG.REF_MAX_PX}px: ${meta.width}x${meta.height}`);
  assert.equal(meta.exif, undefined, "no metadata reaches Pepe");
  assert.ok(!jpg.includes(Buffer.from("SECRETMARK")));
  await clearJobs();
  // a reference deleted before Pepe starts the job: has_ref without data (Pepe refuses, nothing charged)
  const gone = await picture(U.alice);
  const g = await mk({ ref: gone });
  await runQuery("UPDATE feed_attachments SET state = 'deleted' WHERE id = ?", [gone]);
  const s2 = await pepe("/api/feed/aigen/start", { id: g.d.job.id });
  assert.equal(s2.d.job.has_ref, true);
  assert.equal(s2.d.job.ref, undefined);
  await clearJobs();
  // video + a reference: the !video price + surcharge
  const v = await post("/api/feed/aigen", U.alice, { kind: "video", prompt: "animate this", pad: ROOM, ref: mine });
  assert.equal(v.d.job.price, 162000);
  await clearJobs();
  // no reference: as before
  assert.equal((await mk({})).d.job.price, 40000);
  await clearJobs();
});

test("the composer: reference upload + 'from this draft' + the right-to-use note, priced per pad", async () => {
  const html = await (await fetch(base + "/p/" + rooms.getCached(ROOM).slug, { headers: { "x-test-user": U.alice.userId } })).text();
  assert.match(html, /id="fcGenRefFile"/, "an upload control (the normal upload pipeline)");
  assert.match(html, /id="fcGenRefDraft"[^>]*>🖼 From this draft/, "use a picture from this draft");
  assert.match(html, /Only use photos you have the right to use/);
  assert.match(html, /never be made nude or sexual, and minors are always refused/);
  const m = /data-aigen="([^"]+)"/.exec(html);
  const cfg = JSON.parse(m[1].replace(/&#34;/g, '"').replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  assert.equal(cfg.refPrices[ROOM], 12000);
  assert.equal(cfg.refPrices[LOUNGE], 10000);
  assert.equal(cfg.refGlobal, 10000);
  assert.match(html, /feed-composer\.js\?v=13/, "cache-buster bumped");
  assert.doesNotMatch(html, /Text prompts only/, "the old text-only line is gone");
});

// ───────────────────────────── room generations -> the pad feed ─────────────────────────────
test("room post as the linked account: free, ai_generated, not announced, not in the composer, no notice", async () => {
  assert.equal((await post("/api/feed/aigen/room", null, { room: ROOM, kind: "image", prompt: "x" })).status, 403, "bot token only");
  const bal0 = (await getQuery("SELECT points_balance FROM users WHERE userId = ?", [U.alice.userId]))[0].points_balance;
  const g = await roomGen({ login: "AliceCF", display: "Alice ✿" });
  assert.equal(g.start.d.ok, true, JSON.stringify(g.start.d));
  assert.equal(g.result.status, 200, JSON.stringify(g.result.d));
  assert.ok(g.result.d.post, "a post was made");
  const p = await store.get(g.result.d.post, U.bob);
  assert.equal(p.author.userId, U.alice.userId, "as alice (her linked Camfrog login)");
  assert.equal(p.title, "a frog DJ in a neon club", "the title is the prompt");
  assert.match(p.body, /Made with !imagine in the Camfrog room/);
  assert.equal(p.images.length, 1);
  assert.equal(p.images[0].ai.prompt, "a frog DJ in a neon club", "✨ AI-generated with its prompt");
  assert.equal(p.nsfw, false);
  assert.ok(p.roomsAll.some((r) => r.id === ROOM), "in the room's pad");
  const bal1 = (await getQuery("SELECT points_balance FROM users WHERE userId = ?", [U.alice.userId]))[0].points_balance;
  assert.equal(bal1, bal0, "free (the feed charges 500 + 500 normally - it was paid in chat)");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM feed_mentions WHERE post_id = ?", [p.id]))[0].n, 0, "never announced in the room");
  assert.ok(!(await get("/api/feed/aigen", U.alice)).d.jobs.some((j) => j.id === g.id), "not offered in alice's composer");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE ref = ?", ["aigen-" + g.id]).catch(() => [{ n: 0 }]))[0].n, 0, "no inbox notice");
  const j = await jobRow(g.id);
  assert.equal(j.status, "done");
  assert.equal(j.post_id, p.id);
  // NSFW from Pepe's check / the generator
  const n = await roomGen({ login: "alicecf", display: "Alice" }, { nsfw: true });
  assert.equal((await store.get(n.result.d.post, null)).nsfw, true, "flagged -> the post is NSFW");
});

test("room post as Pepe: unlinked login (made by <display>), incognito (someone), Pepe's own chatty picture", async () => {
  const pepeId = store.PEPE_ID;
  let g = await roomGen({ login: "strangercf", display: "Stranger 🐸" });
  let p = await store.get(g.result.d.post, U.bob);
  assert.equal(p.author.userId, pepeId, "an unlinked member: Pepe posts it");
  assert.match(p.body, /Made with !imagine by Stranger 🐸 in the Camfrog room/);
  g = await roomGen({ login: "alicecf", display: "Alice", incognito: true });
  p = await store.get(g.result.d.post, U.bob);
  assert.equal(p.author.userId, pepeId, "incognito: Pepe, even though alice is linked");
  assert.match(p.body, /by someone in the Camfrog room/);
  assert.doesNotMatch(p.body, /Alice/);
  g = await roomGen({ login: null, pepe: true, display: "Pepe", kind: "image", prompt: "Pepe surfing", title: "Pepe surfing" });
  p = await store.get(g.result.d.post, U.bob);
  assert.equal(p.author.userId, pepeId);
  assert.match(p.body, /Pepe made this with !imagine/);
  assert.equal(p.title, "Pepe surfing");
});

test("room posts skipped: pad switch off, the member's opt-out, bans, Pepe's refusals, post limits, non-Camfrog pads", async () => {
  const slug = rooms.getCached(ROOM).slug;
  // the pad owner's switch (Pad settings -> Feed), default on
  assert.equal(await AG.roomGenOn(ROOM), true, "on by default");
  assert.equal((await post(`/api/rooms/${slug}/feed/aigen-room`, U.alice, { on: false })).status, 403, "only the pad's owner");
  assert.equal((await post(`/api/rooms/${slug}/feed/aigen-room`, U.owner, { on: false })).d.on, false);
  let g = await roomGen({ login: "alicecf", display: "Alice" });
  assert.equal(g.start.d.ok, false);
  assert.match(g.start.d.skip, /off for this pad/);
  assert.equal((await post(`/api/rooms/${slug}/feed/aigen-room`, U.owner, { on: true })).d.on, true);
  // the member's opt-out (Profile feed settings)
  const o = await post("/api/profile/settings", U.alice, { roomgenOff: true });
  assert.equal(o.status, 200, JSON.stringify(o.d));
  assert.equal(o.d.roomgenOff, true);
  g = await roomGen({ login: "alicecf", display: "Alice" });
  assert.match(g.start.d.skip, /opted out/);
  g = await roomGen({ login: "alicecf", display: "Alice", incognito: true });
  assert.match(g.start.d.skip, /opted out/, "incognito still honours the opt-out (Pepe won't post it for her either)");
  assert.equal((await post("/api/profile/settings", U.alice, { roomgenOff: false })).d.roomgenOff, false);
  // feed-banned member: not even via Pepe
  g = await roomGen({ login: "bannedcf", display: "B" });
  assert.equal(g.start.d.ok, false);
  g = await roomGen({ login: "bannedcf", display: "B", incognito: true });
  assert.equal(g.start.d.ok, false, "a ban isn't dodged by incognito");
  // Pepe's own refusals for a login (unlinked too)
  await runQuery("INSERT INTO feed_restricted (login, room_id, reason, until) VALUES ('mutedcf', '', 'red-listed', NULL)");
  g = await roomGen({ login: "mutedcf", display: "M" });
  assert.match(g.start.d.skip, /refusals/);
  // the feed's post limits for the linked author
  await store.setConfig({ posts_per_hour: 1 }, "test");
  g = await roomGen({ login: "alicecf", display: "Alice" });
  assert.equal(g.start.d.ok, false, "over the hourly post limit: skipped");
  await store.setConfig({ posts_per_hour: 1000 }, "test");
  // only Camfrog pads
  g = await roomGen({ room: LOUNGE, login: "alicecf", display: "Alice" });
  assert.match(g.start.d.skip, /no pad/);
  g = await roomGen({ room: "no_such_room_xyz", login: "alicecf", display: "Alice" });
  assert.equal(g.start.d.ok, false);
  // nothing above made a job
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM feed_aigen_jobs WHERE origin = 'room' AND status = 'running'"))[0].n, 0);
});

test("a room post the check refused / that failed: the job fails quietly, nothing is posted", async () => {
  const s = await pepe("/api/feed/aigen/room", { room: ROOM, kind: "image", prompt: "x y z", login: "alicecf", display: "Alice" });
  assert.equal(s.d.ok, true);
  const r = await pepe("/api/feed/aigen/result", { id: s.d.id, ok: false, error: "refused by the result check" });
  assert.equal(r.status, 200);
  const j = await jobRow(s.d.id);
  assert.equal(j.status, "failed");
  assert.equal(j.post_id, null);
});

test("Pad settings -> Feed shows the switch (Camfrog pads); the profile settings show the opt-out", async () => {
  const slug = rooms.getCached(ROOM).slug;
  const r = await fetch(base + `/p/${slug}/settings?tab=feed`, { headers: { "x-test-user": U.owner.userId } });
  const html = await r.text();
  assert.equal(r.status, 200, html.slice(0, 300));
  assert.match(html, /<input type="checkbox" id="rmAigenRoom" checked>/, "on by default");
  assert.match(html, /Post room generations to the feed/);
  assert.match(html, /feed-roommod\.js\?v=4/);
  const pp = fs.readFileSync(path.join(repo, "views", "partials", "profile-posts.ejs"), "utf8");
  assert.match(pp, /data-pp-roomgen/);
  assert.match(pp, /Don't post my room generations/);
  assert.match(pp, /profile-feed\.js\?v=2/);
});
