// Offline tests for AI-generated pictures / videos on feed posts (1.99di, aigen.js; Pepe's half is camfrog-bot
// pepe_aigen.py + aigen_test.py): the prices the composer shows (Pepe's pushed room / global prices = what he
// charges), who may generate (linked name or level >= 2, bans), the job lifecycle through the website action
// (queued -> Pepe starts it -> chunks -> result), the normal upload pipeline (re-encoded, metadata dropped,
// quotas), the ai_generated flag + badge + prompt toggle on the post, Pepe's NSFW verdict forcing the post NSFW,
// refusals / failures (nothing stored, the refund state shown), discard (queued: nothing charged; done: not
// refunded), the per-user concurrency limit, timeouts (queued / running, a late result refused) and inbox notices.
//   node --test test/aigen.test.js      (needs the repo's node_modules, ffmpeg + ffprobe on PATH; temp DB + dirs)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aigen-test-"));
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
const AG = require(path.join(repo, "aigen"));
require(path.join(repo, "terms"))._setRequired(false);

const ROOM = "plant_based_chatting", LOUNGE = "patv:lounge";
const BOT = "bot";
let base, server, T0 = 0;
const U = {};
const users = new Map();
AG._setClock(() => Date.now() + T0);

async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, ?, ?, ?, ?, 0)`,
                 [id, name, name, extra.class || "pleb", 0, extra.camfrog || null, extra.level || 0, "2026-01-01 00:00:00"]);
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
  U.lvl = await mkUser("leveled", { level: 3 });          // unlinked, level 3: may generate (pays from PATV)
  U.newbie = await mkUser("newbie");                       // unlinked, level 0: may not
  U.banned = await mkUser("banned", { camfrog: "bannedcf" });
  U.owner = await mkUser("plantowner", { camfrog: "foamy1111" });
  await rooms.init();
  await rooms.setOwner(ROOM, "plantowner", "test");
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, uploads_per_hour: 1000, post_gap_secs: 0, comment_gap_secs: 0 }, "test");
  await runQuery("INSERT INTO feed_bans (user_id, room_id, reason, by, at) VALUES (?, '', 'spam', 'test', ?)", [U.banned.userId, Date.now()]);
  const app = express();
  // like index.js: the chunk route brings its own (bigger) JSON parser
  app.use((req, res, next) => (req.path === "/api/feed/aigen/chunk" ? next() : express.json()(req, res, next)));
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  require(path.join(repo, "pads")).register(app);
  web.register(app, { addUser, isBotToken: (t) => t === BOT });
  AG.register(app, { addUser, isBotToken: (t) => t === BOT, noTimers: true, audit: async () => {} });
  require(path.join(repo, "bridge")).register(app, { addUser, isBotToken: (t) => t === BOT });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });
test.beforeEach(async () => { store._gaps.clear(); await clearJobs().catch(() => {}); });

const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {});
async function call(method, url, u, body) {
  const r = await fetch(base + url, { method, headers: H(u), body: body === undefined ? undefined : JSON.stringify(body) });
  let d = null;
  try { d = await r.json(); } catch (e) { d = null; }
  return { status: r.status, d };
}
const post = (url, u, body) => call("POST", url, u, body);
const get = (url, u) => call("GET", url, u);
const pepe = (url, body) => call("POST", url, null, Object.assign({ password: BOT }, body));

/** Pepe's side of one job: start, chunks (base64, 384 KB each), result. */
async function deliver(id, buf, extra = {}) {
  const s = await pepe("/api/feed/aigen/start", { id, user: extra.user });
  if (s.status !== 200) return { start: s };
  await pepe("/api/feed/aigen/progress", { id, state: "generating", cost: extra.cost != null ? extra.cost : 40000 });
  for (let off = 0; off < buf.length; off += 384 * 1024) {
    const c = await pepe("/api/feed/aigen/chunk", { id, offset: off, data: buf.subarray(off, off + 384 * 1024).toString("base64") });
    if (c.status !== 200) return { start: s, chunk: c };
  }
  const r = await pepe("/api/feed/aigen/result", Object.assign({ id, ok: true, size: buf.length, mime: extra.mime || "image/png", model: "img-model",
                                                                nsfw: !!extra.nsfw, cost: extra.cost != null ? extra.cost : 40000 }, extra.result || {}));
  return { start: s, result: r };
}
async function jobRow(id) { return (await getQuery("SELECT * FROM feed_aigen_jobs WHERE id = ?", [id]))[0]; }
async function clearJobs() {
  await runQuery("UPDATE feed_aigen_jobs SET status = 'discarded' WHERE status IN ('queued','running')");
  await runQuery("UPDATE pepe_actions SET status = 'done' WHERE status IN ('pending','claimed')");   // (no Pepe claims them here)
}
async function bigPng() {
  // ~1 MB of noise with EXIF + a GPS-ish comment: must come out as a metadata-free webp
  const w = 700, h = 500, raw = require("crypto").randomBytes(w * h * 3);   // noise: doesn't compress
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).withMetadata({ exif: { IFD0: { Copyright: "SECRETMARK", Artist: "GPS 51.5,-0.1" } } }).png().toBuffer();
}

// ───────────────────────────── prices ─────────────────────────────
test("prices: Pepe's pushed room price for a Camfrog pad, the global one for site-only pads and profiles; the composer shows the same", async () => {
  let r = await get("/api/feed/aigen?pad=" + ROOM, U.alice);
  assert.deepEqual(r.d.prices, { image: 25000, video: 50000 }, "before Pepe pushes: his defaults");
  AG._setRoomCmds((rid) => (rid === ROOM ? { "!imagine": 30000, "!video": 70000 } : {}));
  r = await get("/api/feed/aigen?pad=" + ROOM, U.alice);
  assert.deepEqual(r.d.prices, { image: 30000, video: 70000 }, "then the room's relay command menu");
  assert.equal((await post("/api/feed/aigen/prices", null, { global: { imagine: 1 } })).status, 403, "the price push needs the bot token");
  const p = await pepe("/api/feed/aigen/prices", { global: { imagine: 25000, video: 100000 }, rooms: { [ROOM]: { imagine: 40000, video: 150000 }, "bad<room>": { imagine: 1 } } });
  assert.equal(p.status, 200);
  assert.equal(p.d.rooms, 1, "a junk room name is dropped");
  r = await get("/api/feed/aigen?pad=" + ROOM, U.alice);
  assert.deepEqual(r.d.prices, { image: 40000, video: 150000 }, "a Camfrog pad: its room's price (= what Pepe charges there)");
  r = await get("/api/feed/aigen?pad=" + rooms.getCached(ROOM).slug, U.alice);
  assert.deepEqual(r.d.prices, { image: 40000, video: 150000 }, "by slug too");
  r = await get("/api/feed/aigen?pad=" + LOUNGE, U.alice);
  assert.deepEqual(r.d.prices, { image: 25000, video: 100000 }, "a site-only pad: the global price");
  r = await get("/api/feed/aigen?pad=u/alice", U.alice);
  assert.deepEqual(r.d.prices, { image: 25000, video: 100000 }, "a profile: the global price");
  AG._setRoomCmds(() => ({}));
  const html = await (await fetch(base + "/p/" + rooms.getCached(ROOM).slug, { headers: { "x-test-user": U.alice.userId } })).text();
  const m = /data-aigen="([^"]+)"/.exec(html);
  assert.ok(m, "the composer has the Generate panel");
  const cfg = JSON.parse(m[1].replace(/&#34;/g, '"').replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  assert.deepEqual(cfg.prices[ROOM], { image: 40000, video: 150000 });
  assert.deepEqual(cfg.prices[LOUNGE], { image: 25000, video: 100000 });
  assert.match(html, /data-tool="gen"/, "the ✨ Generate tool button");
  assert.match(html, /discard is <b>not<\/b> refunded/, "the charging rule is said before anyone clicks");
});

// ───────────────────────────── who may ─────────────────────────────
test("who may: linked name or level >= 2; banned / new unlinked accounts refused; bad input refused", async () => {
  const mk = (u, body) => post("/api/feed/aigen", u, Object.assign({ kind: "image", prompt: "a frog in a top hat", pad: LOUNGE }, body));
  let r = await mk(U.newbie);
  assert.equal(r.status, 403);
  assert.match(r.d.error, /linked Camfrog name.*or level 2/);
  r = await mk(U.banned);
  assert.equal(r.status, 403, "a feed ban");
  assert.equal((await mk(U.alice, { kind: "music" })).status, 400);
  assert.equal((await mk(U.alice, { prompt: "a" })).status, 400);
  assert.equal((await mk(U.alice, { prompt: "x".repeat(601) })).status, 400);
  assert.equal((await mk(U.alice, { pad: "no-such-pad" })).status, 400);
  assert.equal((await mk(null)).status, 401);
  const x = await call("POST", "/api/feed/aigen", null, {});
  assert.equal(x.status, 401);
  const csrf = await fetch(base + "/api/feed/aigen", { method: "POST", headers: { "content-type": "application/json", "x-test-user": U.alice.userId }, body: "{}" });
  assert.equal(csrf.status, 403, "no X-Requested-With: refused");
  r = await mk(U.lvl);
  assert.equal(r.status, 200, "an unlinked level-3 account may generate");
  const act = (await getQuery("SELECT * FROM pepe_actions WHERE kind = 'aigen' AND user_id = ?", [U.lvl.userId]))[0];
  assert.ok(act && act.camfrog === null && JSON.parse(act.args)[0] === r.d.job.id, "queued for Pepe with no Camfrog name (he charges the PATV account)");
  await clearJobs();
});

// ───────────────────────────── a picture, end to end ─────────────────────────────
test("image: queued -> Pepe starts it -> chunks -> re-encoded attachment flagged ai_generated -> preview -> attached to a post with the badge + prompt", async () => {
  const c = await post("/api/feed/aigen", U.alice, { kind: "image", prompt: "a frog DJ in a neon nightclub", pad: ROOM, price: 40000, back: "/p/plant/#feed" });
  assert.equal(c.status, 200, JSON.stringify(c.d));
  const id = c.d.job.id;
  assert.equal(c.d.job.status, "queued");
  assert.equal(c.d.job.price, 40000);
  const act = (await getQuery("SELECT * FROM pepe_actions WHERE kind = 'aigen' AND args = ?", [JSON.stringify([id])]))[0];
  assert.ok(act && act.camfrog === "alicecf" && act.username === "alice", "a website action as alice's Camfrog name");
  assert.equal((await post("/api/feed/aigen/start", null, { id })).status, 403, "start needs the bot token");
  assert.equal((await pepe("/api/feed/aigen/start", { id, user: "bob" })).status, 403, "and the right user");
  const png = await bigPng();
  assert.ok(png.length > 600 * 1024, "multi-chunk test file");
  const d = await deliver(id, png, { user: "alice" });
  assert.equal(d.start.status, 200);
  assert.deepEqual({ kind: d.start.d.job.kind, prompt: d.start.d.job.prompt, room: d.start.d.job.room, price: d.start.d.job.price },
                   { kind: "image", prompt: "a frog DJ in a neon nightclub", room: ROOM, price: 40000 }, "Pepe gets the prompt, the Camfrog room and the shown price");
  assert.equal((await pepe("/api/feed/aigen/start", { id })).status, 410, "a second start is refused (runs once)");
  assert.equal(d.result.status, 200, JSON.stringify(d.result.d));
  const j = await jobRow(id);
  assert.equal(j.status, "done");
  assert.equal(j.cost, 40000);
  const a = (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [j.attachment_id]))[0];
  assert.equal(a.state, "ready");
  assert.equal(a.ai_generated, 1);
  assert.equal(a.ai_prompt, "a frog DJ in a neon nightclub");
  assert.equal(a.ai_model, "img-model");
  assert.equal(a.owner_id, U.alice.userId);
  assert.equal(a.post_id, null);
  assert.equal(a.ct, "image/webp", "re-encoded like any upload");
  const out = fs.readFileSync(require(path.join(repo, "feedmedia")).filePath(a.file));
  assert.ok(!out.includes(Buffer.from("SECRETMARK")) && !out.includes(Buffer.from("GPS 51.5")), "metadata dropped");
  assert.equal((await sharp(out).metadata()).exif, undefined);
  // the composer's preview
  const v = await get("/api/feed/aigen/" + id, U.alice);
  assert.equal(v.d.job.status, "done");
  assert.ok(v.d.job.attachment && v.d.job.attachment.url.startsWith("/media/f/") && !v.d.job.attachment.posted);
  assert.equal((await get("/api/feed/aigen/" + id, U.bob)).status, 404, "only its owner sees a job");
  assert.equal((await fetch(base + v.d.job.attachment.url, { headers: { "x-test-user": U.alice.userId } })).status, 200, "the owner can load the preview");
  assert.equal((await fetch(base + v.d.job.attachment.url, { headers: { "x-test-user": U.bob.userId } })).status, 404, "nobody else (not posted yet)");
  assert.ok((await get("/api/feed/aigen", U.alice)).d.jobs.some((x) => x.id === id), "listed for the composer (a reload / another page)");
  // attach it to a post (an ordinary attachment from here on)
  const p = await post("/api/feed/posts", U.alice, { title: "drop", body: "made it", attachments: [a.id], community: ROOM });
  assert.equal(p.status, 200, JSON.stringify(p.d));
  const row = await store.get(p.d.id, U.bob);
  assert.equal(row.images.length, 1);
  assert.deepEqual(row.images[0].ai, { prompt: "a frog DJ in a neon nightclub", hidden: false });
  assert.equal(row.ai.length, 1);
  assert.equal(row.nsfw, false);
  assert.ok(!(await get("/api/feed/aigen", U.alice)).d.jobs.some((x) => x.id === id), "posted: no longer offered in the composer");
  let html = await (await fetch(base + "/feed/p/" + p.d.id, { headers: { "x-test-user": U.bob.userId } })).text();
  assert.match(html, /class="fp-ai-badge">✨ AI-generated</, "the badge on the picture");
  assert.match(html, /<details class="fp-ai-p"><summary>✨ AI-generated · prompt<\/summary><p>a frog DJ in a neon nightclub<\/p>/, "the prompt under a toggle");
  assert.doesNotMatch(html, /data-act="ai-prompt"/, "only the author gets the show/hide button");
  // the author hides the prompt
  assert.equal((await post(`/api/feed/attachments/${a.id}/ai-prompt`, U.bob, { show: false })).status, 404, "not bob's file");
  assert.equal((await post(`/api/feed/attachments/${a.id}/ai-prompt`, U.alice, { show: false })).status, 200);
  html = await (await fetch(base + "/feed/p/" + p.d.id, { headers: { "x-test-user": U.bob.userId } })).text();
  assert.doesNotMatch(html, /neon nightclub/, "hidden from others");
  assert.match(html, /✨ AI-generated · prompt not shown/, "the badge stays");
  assert.equal((await store.get(p.d.id, U.bob)).images[0].ai.prompt, null, "not even in the data");
  html = await (await fetch(base + "/feed/p/" + p.d.id, { headers: { "x-test-user": U.alice.userId } })).text();
  assert.match(html, /prompt \(hidden from others\)/, "the author still sees it");
  assert.match(html, /data-act="ai-prompt"[^>]*data-show="1"/, "with a Show button");
});

// ───────────────────────────── NSFW, failures, refusals ─────────────────────────────
test("Pepe's NSFW verdict makes the post NSFW whatever the author ticked", async () => {
  const c = await post("/api/feed/aigen", U.bob, { kind: "image", prompt: "a frog at the beach", pad: LOUNGE });
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#3a6" } }).png().toBuffer();
  const d = await deliver(c.d.job.id, png, { nsfw: true, user: "bob" });
  assert.equal(d.result.status, 200);
  const j = await jobRow(c.d.job.id);
  assert.equal(j.nsfw, 1);
  assert.equal((await get("/api/feed/aigen/" + j.id, U.bob)).d.job.nsfw, true, "the preview says so");
  const p = await post("/api/feed/posts", U.bob, { body: "beach", attachments: [j.attachment_id], nsfw: false, community: LOUNGE });
  assert.equal(p.status, 200);
  assert.equal((await store.get(p.d.id, null)).nsfw, true, "post forced NSFW");
});

test("a refused or failed generation stores nothing, shows the refund state, and files an inbox notice if the composer isn't open", async () => {
  const c = await post("/api/feed/aigen", U.bob, { kind: "image", prompt: "something forbidden", pad: LOUNGE, back: "/feed" });
  const id = c.d.job.id;
  await pepe("/api/feed/aigen/start", { id });
  const r = await pepe("/api/feed/aigen/result", { id, ok: false, refused: true, refunded: false, error: "that prompt contains restricted content - nothing was charged" });
  assert.equal(r.status, 200);
  const j = await jobRow(id);
  assert.equal(j.status, "failed");
  assert.equal(j.attachment_id, null);
  const v = (await get("/api/feed/aigen/" + id, U.bob)).d.job;
  assert.equal(v.status, "failed");
  assert.match(v.message, /nothing was charged/);
  const n = await getQuery("SELECT * FROM inbox WHERE user_id = ? AND ref = ?", [U.bob.userId, "aigen-" + id]);
  assert.equal(n.length, 1, "notice filed (nobody was polling)");
  assert.match(n[0].title, /couldn't be made/);
  assert.equal(n[0].link, "/feed");
  // a generation that failed after the charge: refunded
  const c2 = await post("/api/feed/aigen", U.bob, { kind: "image", prompt: "a frog astronaut", pad: LOUNGE });
  await pepe("/api/feed/aigen/start", { id: c2.d.job.id });
  await get("/api/feed/aigen/" + c2.d.job.id, U.bob);                      // the composer is open (polling)
  await pepe("/api/feed/aigen/result", { id: c2.d.job.id, ok: false, refunded: true, cost: 25000, error: "the generator is busy (rate limited)" });
  const v2 = (await get("/api/feed/aigen/" + c2.d.job.id, U.bob)).d.job;
  assert.equal(v2.refunded, true);
  assert.equal((await getQuery("SELECT * FROM inbox WHERE ref = ?", ["aigen-" + c2.d.job.id])).length, 0, "no notice while the composer watches");
});

test("the site can't keep it (quota, a broken file, a wrong type): refused so Pepe refunds", async () => {
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#36a" } }).png().toBuffer();
  // the wrong kind of file at the first chunk
  let c = await post("/api/feed/aigen", U.bob, { kind: "image", prompt: "a frog", pad: LOUNGE });
  await pepe("/api/feed/aigen/start", { id: c.d.job.id });
  let k = await pepe("/api/feed/aigen/chunk", { id: c.d.job.id, offset: 0, data: Buffer.from("<html><script>alert(1)</script></html>").toString("base64") });
  assert.equal(k.status, 415);
  k = await pepe("/api/feed/aigen/chunk", { id: c.d.job.id, offset: 5, data: png.toString("base64") });
  assert.equal(k.status, 409, "out of order");
  // a size that doesn't match what arrived
  k = await pepe("/api/feed/aigen/chunk", { id: c.d.job.id, offset: 0, data: png.toString("base64") });
  assert.equal(k.status, 200);
  let r = await pepe("/api/feed/aigen/result", { id: c.d.job.id, ok: true, size: png.length + 10 });
  assert.equal(r.status, 409);
  assert.equal((await jobRow(c.d.job.id)).status, "failed");
  // over the user's quota
  await store.setConfig({ user_quota_mb: 10 }, "test");
  await runQuery(`INSERT INTO feed_attachments (id, owner_id, kind, state, created, bytes, received) VALUES ('fillerfiller00', ?, 'video', 'ready', ?, ?, 0)`,
                 [U.bob.userId, Date.now(), 10 * 1024 * 1024 - 1000]);
  c = await post("/api/feed/aigen", U.bob, { kind: "image", prompt: "a frog", pad: LOUNGE });
  assert.equal(c.status, 413, "refused up front when the space is already gone");
  await runQuery("UPDATE feed_attachments SET bytes = ? WHERE id = 'fillerfiller00'", [10 * 1024 * 1024 - 4 * 1024 * 1024]);
  c = await post("/api/feed/aigen", U.bob, { kind: "image", prompt: "a frog", pad: LOUNGE });
  assert.equal(c.status, 200);
  await runQuery("UPDATE feed_attachments SET bytes = ? WHERE id = 'fillerfiller00'", [10 * 1024 * 1024 - 100]);   // filled meanwhile
  const d = await deliver(c.d.job.id, png, { user: "bob" });
  assert.equal(d.result.status, 413, "over quota at the end: refused -> Pepe refunds");
  assert.equal((await jobRow(c.d.job.id)).status, "failed");
  await runQuery("DELETE FROM feed_attachments WHERE id = 'fillerfiller00'");
  await store.setConfig({ user_quota_mb: 500 }, "test");
});

// ───────────────────────────── discard, limits, timeouts ─────────────────────────────
test("discard: a queued job is cancelled (Pepe won't start it - nothing charged); a finished one loses its file (not refunded); running can't", async () => {
  let c = await post("/api/feed/aigen", U.alice, { kind: "image", prompt: "a frog knight", pad: LOUNGE });
  let r = await post(`/api/feed/aigen/${c.d.job.id}/discard`, U.alice, {});
  assert.deepEqual(r.d, { ok: true, charged: false });
  assert.equal((await pepe("/api/feed/aigen/start", { id: c.d.job.id })).status, 410);
  c = await post("/api/feed/aigen", U.alice, { kind: "image", prompt: "a frog wizard", pad: LOUNGE });
  await pepe("/api/feed/aigen/start", { id: c.d.job.id });
  assert.equal((await post(`/api/feed/aigen/${c.d.job.id}/discard`, U.alice, {})).status, 409, "not while it's generating");
  const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: "#a63" } }).png().toBuffer();
  await pepe("/api/feed/aigen/chunk", { id: c.d.job.id, offset: 0, data: png.toString("base64") });
  await pepe("/api/feed/aigen/result", { id: c.d.job.id, ok: true, size: png.length, cost: 25000 });
  const j = await jobRow(c.d.job.id);
  assert.equal((await post(`/api/feed/aigen/${c.d.job.id}/discard`, U.bob, {})).status, 404, "not bob's");
  r = await post(`/api/feed/aigen/${c.d.job.id}/discard`, U.alice, {});
  assert.deepEqual(r.d, { ok: true, charged: true }, "charged (it was made) - the composer warned before");
  assert.equal((await getQuery("SELECT state FROM feed_attachments WHERE id = ?", [j.attachment_id]))[0].state, "deleted");
  assert.ok(!(await get("/api/feed/aigen", U.alice)).d.jobs.some((x) => x.id === c.d.job.id));
});

test("limits: two jobs at a time per account, one of them a video; the shown price must not be below the real one", async () => {
  await clearJobs();
  const mk = (kind, extra = {}) => post("/api/feed/aigen", U.alice, Object.assign({ kind, prompt: "a frog " + kind, pad: LOUNGE }, extra));
  assert.equal((await mk("video")).status, 200);
  assert.equal((await mk("video")).status, 429, "one video at a time");
  assert.equal((await mk("image")).status, 200);
  const third = await mk("image");
  assert.equal(third.status, 429);
  assert.match(third.d.error, /2 generations going/);
  await clearJobs();
  const cheap = await mk("image", { price: 100 });
  assert.equal(cheap.status, 409, "the composer showed an old, lower price");
  assert.match(cheap.d.error, /price changed to 25,000 PAT/);
  await clearJobs();
});

test("timeouts: queued too long (nothing charged), running too long (a late result is refused, Pepe refunds) + notices", async () => {
  await clearJobs();
  const q = await post("/api/feed/aigen", U.bob, { kind: "image", prompt: "a frog chef", pad: LOUNGE });
  const v = await post("/api/feed/aigen", U.bob, { kind: "video", prompt: "a frog surfing", pad: LOUNGE });
  await pepe("/api/feed/aigen/start", { id: v.d.job.id });
  T0 += 6 * 60e3;
  assert.equal(await AG.sweep(), 0, "6 min: a video may still be generating, the queued one may still be picked up");
  T0 += 10 * 60e3;
  assert.equal(await AG.sweep(), 2);
  const jq = await jobRow(q.d.job.id), jv = await jobRow(v.d.job.id);
  assert.equal(jq.status, "timeout");
  assert.match(jq.message, /nothing was charged/);
  assert.equal(jv.status, "timeout");
  assert.match(jv.message, /refunded automatically/);
  assert.equal((await pepe("/api/feed/aigen/start", { id: q.d.job.id })).status, 410, "Pepe can't start an expired job");
  const late = await pepe("/api/feed/aigen/result", { id: v.d.job.id, ok: true, size: 10 });
  assert.equal(late.status, 410, "a late result is refused (Pepe refunds)");
  const r2 = await pepe("/api/feed/aigen/result", { id: v.d.job.id, ok: false, refunded: true, error: "x" });
  assert.equal(r2.status, 200);
  assert.equal((await jobRow(v.d.job.id)).refunded, 1, "the refund is recorded on the timed-out job");
  const n = await getQuery("SELECT * FROM inbox WHERE user_id = ? AND ref IN (?, ?)", [U.bob.userId, "aigen-" + q.d.job.id, "aigen-" + v.d.job.id]);
  assert.equal(n.length, 2);
  T0 = 0;
});

// ───────────────────────────── a video ─────────────────────────────
test("video: the mp4 is re-encoded (H.264, metadata dropped) with a poster; the composer's preview + inbox notice when done", async () => {
  await clearJobs();
  const src = path.join(tmp, "veo.mp4");
  execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=24", "-f", "lavfi", "-i", "sine=frequency=330",
    "-t", "3", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-metadata", "title=SECRETMARK", "-metadata", "location=+51.5-000.1/", src], { stdio: "ignore" });
  const buf = fs.readFileSync(src);
  const c = await post("/api/feed/aigen", U.alice, { kind: "video", prompt: "a frog surfing a huge wave", pad: ROOM, back: "/p/x" });
  assert.equal(c.status, 200);
  assert.equal(c.d.job.eta, "~30–90 s");
  const d = await deliver(c.d.job.id, buf, { mime: "video/mp4", cost: 150000, user: "alice" });
  assert.equal(d.result.status, 200, JSON.stringify(d.result.d));
  const j = await jobRow(c.d.job.id);
  const a = (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [j.attachment_id]))[0];
  assert.equal(a.kind, "video");
  assert.equal(a.ct, "video/mp4");
  assert.ok(a.poster, "a poster frame");
  assert.ok(a.secs > 2 && a.secs < 4);
  const out = fs.readFileSync(require(path.join(repo, "feedmedia")).filePath(a.file));
  assert.ok(!out.includes(Buffer.from("SECRETMARK")), "metadata dropped");
  const v = (await get("/api/feed/aigen/" + j.id, U.alice)).d.job;
  assert.ok(v.attachment.poster && v.attachment.file.endsWith(".mp4"));
  assert.equal(v.cost, 150000);
  const n = await getQuery("SELECT * FROM inbox WHERE user_id = ? AND ref = ?", [U.alice.userId, "aigen-" + j.id]);
  assert.equal(n.length, 1, "nobody was polling during the generation: a notice");
  assert.match(n[0].title, /AI video is ready/);
  assert.equal(n[0].link, "/p/x");
  const p = await post("/api/feed/posts", U.alice, { body: "surf", attachments: [a.id], community: ROOM });
  assert.equal(p.status, 200);
  const html = await (await fetch(base + "/feed/p/" + p.d.id, { headers: { "x-test-user": U.bob.userId } })).text();
  assert.match(html, /<div class="fp-video ai"><video[^>]+><\/video><span class="fp-ai-badge">✨ AI-generated<\/span>/, "the badge on the video");
});
