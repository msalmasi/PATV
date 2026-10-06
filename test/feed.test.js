// Offline tests for the feed (1.99bv): feedstore.js (posts, rooms, votes, comments, reports, bans, Pepe
// restrictions + mentions, prices), feedmedia.js (magic bytes, re-encoding, metadata stripping, caps),
// feedweb.js (chunked uploads, file headers, permissions, rendering) and linkpreview.js (SSRF guards).
//   node --test test/feed.test.js      (needs the repo's node_modules, ffmpeg + ffprobe on PATH; temp DB + dir)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "feed-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
const express = require("express");
const sharp = require("sharp");
const ejs = require("ejs");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const media = require(path.join(repo, "feedmedia"));
const lp = require(path.join(repo, "linkpreview"));
const web = require(path.join(repo, "feedweb"));

const ROOM_A = "PepeFrog.Room", ROOM_B = "plant_based_chatting";
let base, server, U = {};
const users = new Map();

async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, ?, ?, ?, ?, 0)`,
                 [id, name, extra.display || name, extra.class || "pleb", extra.balance || 0, extra.camfrog || null, extra.level || 0,
                  extra.created || "2026-01-01 00:00:00"]);
  const u = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, u);
  return u;
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery(`CREATE TABLE media (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ct TEXT NOT NULL, file TEXT NOT NULL, bytes INTEGER, secs REAL, subject TEXT,
                  by_user TEXT, room TEXT, created INTEGER, expires INTEGER, deleted INTEGER DEFAULT 0)`);
  U.owner = await mkUser("plantowner", { camfrog: "foamy1111" });
  U.admin = await mkUser("boss", { class: "Admin", camfrog: "bossfrog" });
  U.alice = await mkUser("alice", { camfrog: "alicecf", balance: 5000 });
  U.bob = await mkUser("bob", { camfrog: "bobcf" });
  U.newbie = await mkUser("newbie", { created: new Date().toISOString().replace("T", " ").slice(0, 19) });   // unlinked, level 0, brand new
  U.lvl = await mkUser("leveled", { level: 3 });
  U.carol = await mkUser("carol", { camfrog: "carolcf" });
  await rooms.init();
  await rooms.setOwner(ROOM_B, "plantowner", "test");
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, uploads_per_hour: 1000, post_gap_secs: 0, comment_gap_secs: 0 }, "test");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  web.register(app, { addUser, isBotToken: (t) => t === "bot" });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });
test.beforeEach(() => { store._gaps.clear(); });

const H = (u, extra = {}) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {}, extra);
async function call(method, url, u, body, headers) {
  const r = await fetch(base + url, { method, headers: headers || H(u), body: body === undefined ? undefined : JSON.stringify(body) });
  let d = null;
  try { d = await r.json(); } catch (e) { d = null; }
  return { status: r.status, d };
}
const post = (url, u, body, headers) => call("POST", url, u, body, headers);

/** The browser's chunked upload: open, PUT chunks, finish, poll. -> {status, state, error, id} */
async function upload(u, kind, buf, { chunk = 200 * 1024, declare } = {}) {
  const o = await post("/api/feed/uploads", u, { kind, size: declare != null ? declare : buf.length });
  if (o.status !== 200) return { status: o.status, error: o.d && o.d.error };
  const id = o.d.id;
  for (let off = 0; off < buf.length; off += chunk) {
    const r = await fetch(`${base}/api/feed/uploads/${id}?offset=${off}`, { method: "PUT", body: buf.subarray(off, off + chunk),
      headers: { "content-type": "application/octet-stream", "x-requested-with": "fetch", "x-test-user": u.userId } });
    if (r.status !== 200) return { status: r.status, error: (await r.json()).error, id };
  }
  const f = await post(`/api/feed/uploads/${id}/finish`, u, {});
  if (f.status !== 200) return { status: f.status, error: f.d.error, id };
  for (let i = 0; i < 300; i++) {
    const s = await call("GET", `/api/feed/uploads/${id}`, u);
    if (s.d.state === "ready" || s.d.state === "failed") return { status: 200, state: s.d.state, error: s.d.error, id, att: s.d.attachment };
    await new Promise((r) => setTimeout(r, 100));
  }
  return { status: 0, state: "timeout", id };
}

function ff(args) { execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-y", ...args], { stdio: "ignore" }); }

// ───────────────────────────── magic bytes ─────────────────────────────
test("sniff: real types by magic bytes; HTML/SVG/XML/PDF/ZIP/EXE/playlists refused whatever they claim to be", async () => {
  const jpg = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#f00" } }).jpeg().toBuffer();
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#0f0" } }).png().toBuffer();
  const webp = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#00f" } }).webp().toBuffer();
  assert.equal(media.sniff(jpg).kind, "image");
  assert.equal(media.sniff(png).fmt, "png");
  assert.equal(media.sniff(webp).fmt, "webp");
  assert.equal(media.sniff(Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1")).fmt, "gif");
  assert.equal(media.sniff(Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00\x00\x00", "latin1")).fmt, "mp3");
  assert.equal(media.sniff(Buffer.from("\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00", "latin1")).kind, "av");
  assert.equal(media.sniff(Buffer.from("\x00\x00\x00\x18ftypM4A \x00\x00\x00\x00", "latin1")).kind, "audio");
  assert.equal(media.sniff(Buffer.from("\x1a\x45\xdf\xa3\x00\x00\x00\x00\x00\x00\x00\x00", "binary")).fmt, "webm");
  for (const bad of [
    "<!DOCTYPE html><html><script>alert(1)</script>",
    "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>",
    "   \n\t<html><body>hi</body></html>",
    "﻿<svg><script>alert(1)</script></svg>",
    "<?xml version='1.0'?><svg/>",
    "%PDF-1.7 ......",
    "PK\x03\x04 zip zip zip",
    "MZ\x90\x00 exe exe exe",
    "\x7fELF elf elf elf",
    "#EXTM3U\n#EXTINF:1,\nhttp://169.254.169.254/latest/meta-data",
    "just some text, nothing else",
  ]) {
    const r = media.sniff(Buffer.from(bad, "latin1"));
    assert.ok(r.bad, "refused: " + JSON.stringify(bad.slice(0, 20)));
  }
  assert.ok(media.sniff(Buffer.from("\x00\x00\x00\x18ftypheic\x00\x00\x00\x00", "latin1")).bad, "HEIC is refused with a hint");
});

// ───────────────────────────── re-encoding ─────────────────────────────
test("images are re-encoded to webp with EXIF/GPS/XMP stripped and orientation applied", async () => {
  const MARK = "SECRET-GPS-MARKER-4711";
  const src = await sharp({ create: { width: 64, height: 32, channels: 3, background: "#123456" } })
    .jpeg().withExif({ IFD0: { Artist: MARK, Copyright: MARK }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "40/1 44/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "73/1 59/1 0/1" } })
    .withMetadata({ orientation: 6 }).toBuffer();
  const before = await sharp(src).metadata();
  assert.ok(before.exif && before.exif.toString("latin1").includes(MARK), "fixture really carries EXIF");
  const f = path.join(tmp, "exif.jpg");
  fs.writeFileSync(f, src);
  const out = await media.processImage(f, "jpeg");
  assert.equal(out.ct, "image/webp");
  const full = fs.readFileSync(media.filePath(out.file));
  const meta = await sharp(full).metadata();
  assert.equal(meta.format, "webp");
  assert.equal(meta.exif, undefined, "no EXIF");
  assert.equal(meta.xmp, undefined, "no XMP");
  assert.equal(meta.icc, undefined, "no ICC");
  assert.ok(!full.toString("latin1").includes(MARK), "the marker is gone from the bytes");
  assert.deepEqual([meta.width, meta.height], [32, 64], "orientation 6 baked in (rotated)");
  assert.ok(fs.existsSync(media.filePath(out.thumb)));
});

test("a GIF/HTML polyglot comes out as a plain webp - the HTML part is never served", async () => {
  const gif = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } }).gif().toBuffer();
  const poly = Buffer.concat([gif, Buffer.from("<html><script>alert(document.cookie)</script></html>")]);
  const f = path.join(tmp, "poly.gif");
  fs.writeFileSync(f, poly);
  const out = await media.processImage(f, "gif");
  const bytes = fs.readFileSync(media.filePath(out.file));
  assert.equal(bytes.subarray(8, 12).toString(), "WEBP");
  assert.ok(!bytes.toString("latin1").includes("<script"));
});

// ───────────────────────────── uploads over HTTP ─────────────────────────────
test("upload: a real picture goes through the chunked pipeline and becomes a webp", async () => {
  const img = await sharp({ create: { width: 900, height: 600, channels: 3, background: "#468" } }).jpeg({ quality: 95 }).toBuffer();
  const r = await upload(U.alice, "image", img, { chunk: 1000 });
  assert.equal(r.state, "ready", r.error);
  assert.ok(/^\/feed\/f\/[a-f0-9]{32}_t\.webp$/.test(r.att.url));
  // before it's posted only the uploader (or staff) can fetch it
  assert.equal((await fetch(base + r.att.file, { headers: { "x-test-user": U.alice.userId } })).status, 200);
  assert.equal((await fetch(base + r.att.file, { headers: { "x-test-user": U.bob.userId } })).status, 404);
  assert.equal((await fetch(base + r.att.file)).status, 404);
});

test("upload: disguised HTML / SVG refused on the first chunk, whatever kind is declared", async () => {
  for (const [kind, body] of [["image", "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"],
                              ["image", "<!doctype html><title>x</title><script>alert(1)</script>" + "x".repeat(100)],
                              ["video", "<html>" + "a".repeat(5000)], ["audio", "#EXTM3U\nhttp://10.0.0.1/x.ts\n"]]) {
    const r = await upload(U.alice, kind, Buffer.from(body));
    assert.equal(r.status, 415, kind + ": " + body.slice(0, 20));
    const row = (await getQuery("SELECT state FROM feed_attachments WHERE id = ?", [r.id]))[0];
    assert.equal(row.state, "failed");
  }
});

test("upload: a picture declared as video (or the other way round) is refused", async () => {
  const img = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#468" } }).png().toBuffer();
  assert.equal((await upload(U.alice, "video", img)).status, 415);
});

test("upload: size caps on open, and a file bigger than it said is cut off", async () => {
  const C = store.config();
  const big = await post("/api/feed/uploads", U.alice, { kind: "image", size: C.max_image_mb * 1024 * 1024 + 1 });
  assert.equal(big.status, 413);
  assert.match(big.d.error, /up to 10 MB/);
  assert.equal((await post("/api/feed/uploads", U.alice, { kind: "video", size: 101 * 1024 * 1024 })).status, 413);
  assert.equal((await post("/api/feed/uploads", U.alice, { kind: "audio", size: 26 * 1024 * 1024 })).status, 413);
  const img = await sharp({ create: { width: 50, height: 50, channels: 3, background: "#468" } }).png().toBuffer();
  const r = await upload(U.alice, "image", Buffer.concat([img, Buffer.alloc(5000)]), { declare: img.length, chunk: img.length });
  assert.equal(r.status, 413);
  // admin-settable: lower the image cap
  await store.setConfig({ max_image_mb: 1 }, "test");
  assert.equal((await post("/api/feed/uploads", U.alice, { kind: "image", size: 2 * 1024 * 1024 })).status, 413);
  await store.setConfig({ max_image_mb: 10 }, "test");
});

test("upload: video -> H.264 mp4 + poster, metadata dropped; duration cap enforced", async () => {
  const src = path.join(tmp, "v.mov");
  ff(["-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=15", "-f", "lavfi", "-i", "sine=duration=2",
      "-metadata", "title=SECRETVIDMARK", "-metadata", "location=+40.7000-074.0000/", "-c:v", "libx264", "-pix_fmt", "yuv444p", "-c:a", "aac", "-shortest", "-f", "mov", src]);
  const r = await upload(U.alice, "video", fs.readFileSync(src));
  assert.equal(r.state, "ready", r.error);
  const row = (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [r.id]))[0];
  assert.equal(row.ct, "video/mp4");
  assert.ok(row.poster);
  const out = media.filePath(row.file);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,pix_fmt:format_tags", "-of", "json", out]).toString());
  assert.equal(probe.streams.find((s) => s.codec_name === "h264").pix_fmt, "yuv420p");
  assert.ok(!fs.readFileSync(out).toString("latin1").includes("SECRETVIDMARK"), "title metadata gone");
  assert.ok(!JSON.stringify(probe.format && probe.format.tags || {}).includes("40.7"), "location tag gone");
  // too long
  await store.setConfig({ max_video_secs: 5 }, "test");
  const long = path.join(tmp, "long.mp4");
  ff(["-f", "lavfi", "-i", "testsrc=duration=9:size=160x120:rate=10", "-c:v", "libx264", "-pix_fmt", "yuv420p", long]);
  const r2 = await upload(U.alice, "video", fs.readFileSync(long));
  assert.equal(r2.state, "failed");
  assert.match(r2.error, /up to 5 s/);
  await store.setConfig({ max_video_secs: 180 }, "test");
});

test("upload: audio -> m4a, tags dropped", async () => {
  const src = path.join(tmp, "a.mp3");
  ff(["-f", "lavfi", "-i", "sine=duration=2", "-metadata", "artist=SECRETAUDMARK", "-c:a", "libmp3lame", src]);
  const r = await upload(U.alice, "audio", fs.readFileSync(src));
  assert.equal(r.state, "ready", r.error);
  const row = (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [r.id]))[0];
  assert.equal(row.ct, "audio/mp4");
  assert.ok(!fs.readFileSync(media.filePath(row.file)).toString("latin1").includes("SECRETAUDMARK"));
});

test("upload: unlinked low-level accounts can't upload media; a linked name or level >= 2 can", async () => {
  const img = await sharp({ create: { width: 10, height: 10, channels: 3, background: "#468" } }).png().toBuffer();
  const r = await post("/api/feed/uploads", U.newbie, { kind: "image", size: img.length });
  assert.equal(r.status, 403);
  assert.match(r.d.error, /linked Camfrog name/);
  assert.equal((await upload(U.lvl, "image", img)).state, "ready");
});

test("upload: per-user quota and the global quota", async () => {
  await store.setConfig({ user_quota_mb: 10 }, "test");
  const used = await store.usedBytes(U.carol.userId);
  assert.equal(used, 0);
  const r = await post("/api/feed/uploads", U.carol, { kind: "video", size: 11 * 1024 * 1024 });
  assert.equal(r.status, 413);
  assert.match(r.d.error, /10 MB of space/);
  await store.setConfig({ user_quota_mb: 500, global_quota_gb: 1 }, "test");
  await runQuery(`INSERT INTO feed_attachments (id, owner_id, kind, state, created, bytes) VALUES ('bigfake', 'u_x', 'video', 'ready', ?, ?)`, [Date.now(), 1024 ** 3]);
  assert.equal((await post("/api/feed/uploads", U.carol, { kind: "image", size: 1000 })).status, 507);
  await runQuery("DELETE FROM feed_attachments WHERE id = 'bigfake'");
  await store.setConfig({ global_quota_gb: 20 }, "test");
});

test("requests without X-Requested-With or from another site are refused", async () => {
  assert.equal((await post("/api/feed/posts", U.alice, { body: "hi" }, { "content-type": "application/json", "x-test-user": U.alice.userId })).status, 403);
  assert.equal((await post("/api/feed/posts", U.alice, { body: "hi" }, H(U.alice, { origin: "https://evil.example" }))).status, 403);
  assert.equal((await post("/api/feed/posts", null, { body: "hi" })).status, 401);
});

// ───────────────────────────── posts, rooms, permissions ─────────────────────────────
let P1, P2, P3;
test("posting: text to the main feed and rooms; room filter; room-only posts stay off the main feed", async () => {
  const a = await post("/api/feed/posts", U.alice, { title: "Hello frogs", body: "first!", rooms: [ROOM_A], global: true });
  assert.equal(a.status, 200, a.d && a.d.error);
  P1 = a.d.id;
  const b = await post("/api/feed/posts", U.bob, { body: "plant room only", rooms: [ROOM_B], global: false });
  assert.equal(b.status, 200, b.d && b.d.error);
  P2 = b.d.id;
  const c = await post("/api/feed/posts", U.alice, { body: "main feed only" });
  P3 = c.d.id;
  const main = (await store.list({})).posts.map((p) => p.id);
  assert.ok(main.includes(P1) && main.includes(P3) && !main.includes(P2));
  const ra = (await store.list({ room: ROOM_A })).posts.map((p) => p.id);
  assert.deepEqual(ra, [P1]);
  const rb = (await store.list({ room: ROOM_B })).posts.map((p) => p.id);
  assert.deepEqual(rb, [P2]);
  // nowhere to post / nothing to post / unknown room
  assert.equal((await post("/api/feed/posts", U.alice, { body: "x", global: false })).status, 400);
  assert.equal((await post("/api/feed/posts", U.alice, {})).status, 400);
  assert.equal((await post("/api/feed/posts", U.alice, { body: "x", rooms: ["Nope.Room"] })).status, 400);
});

test("posting with files: only my own, ready, unposted uploads; at most 4 pictures", async () => {
  const img = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#468" } }).png().toBuffer();
  const mine = await upload(U.alice, "image", img);
  const theirs = await upload(U.bob, "image", img);
  assert.equal((await post("/api/feed/posts", U.alice, { body: "pic", attachments: [theirs.id] })).status, 400);
  const ok = await post("/api/feed/posts", U.alice, { body: "pic", attachments: [mine.id], rooms: [ROOM_A] });
  assert.equal(ok.status, 200, ok.d && ok.d.error);
  assert.equal((await post("/api/feed/posts", U.alice, { body: "again", attachments: [mine.id] })).status, 400, "a file can't be posted twice");
  const p = await store.get(ok.d.id, U.alice);
  assert.equal(p.images.length, 1);
  // now public: anyone can fetch it, with safe headers
  const r = await fetch(base + "/feed/f/" + p.images[0].file);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/webp");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.headers.get("content-disposition"), /^inline; filename="patv-[a-f0-9]+\.webp"$/);
  assert.match(r.headers.get("content-security-policy"), /sandbox/);
  // bad names never touch the disk
  assert.equal((await fetch(base + "/feed/f/..%2f..%2fmyapp.db")).status, 404);
  assert.equal((await fetch(base + "/feed/f/" + "a".repeat(32) + ".html")).status, 404);
});

test("permissions: the room owner removes a post from THEIR room only; author edit/delete; admin delete", async () => {
  // owner of ROOM_B can't touch ROOM_A
  assert.equal((await post(`/api/feed/posts/${P1}/remove-room`, U.owner, { room: ROOM_A })).status, 403);
  // a cross-posted post: the owner removes it from their room, it stays on the main feed / other room
  const x = await post("/api/feed/posts", U.carol, { body: "both rooms", rooms: [ROOM_A, ROOM_B] });
  assert.equal((await post(`/api/feed/posts/${x.d.id}/remove-room`, U.owner, { room: ROOM_B })).status, 200);
  assert.ok(!(await store.list({ room: ROOM_B })).posts.some((p) => p.id === x.d.id));
  assert.ok((await store.list({ room: ROOM_A })).posts.some((p) => p.id === x.d.id));
  assert.ok((await store.list({})).posts.some((p) => p.id === x.d.id));
  // edit: author only
  assert.equal((await post(`/api/feed/posts/${P1}/edit`, U.bob, { body: "hacked" })).status, 403);
  assert.equal((await post(`/api/feed/posts/${P1}/edit`, U.alice, { body: "first! (edited)" })).status, 200);
  assert.equal((await store.get(P1)).body, "first! (edited)");
  // delete: not someone else's (even a room owner's), yes the author's / an admin's
  assert.equal((await post(`/api/feed/posts/${P2}/delete`, U.owner, {})).status, 403);
  assert.equal((await post(`/api/feed/posts/${P3}/delete`, U.admin, { reason: "test" })).status, 200);
  assert.ok(!(await store.list({})).posts.some((p) => p.id === P3));
  const notice = await getQuery("SELECT * FROM inbox WHERE user_id = ? AND ref = ?", [U.alice.userId, "feed-rm:" + P3]);
  assert.equal(notice.length, 1, "the author is told an admin removed it");
});

test("banned / suspended / restricted users can't post or comment", async () => {
  // a site feed ban (admin, whole feed)
  assert.equal((await post("/api/feed/ban", U.bob, { user: "carol" })).status, 403, "only staff ban from the whole feed");
  assert.equal((await post("/api/feed/ban", U.admin, { user: "carol", days: 1 })).status, 200);
  let r = await post("/api/feed/posts", U.carol, { body: "am I banned?" });
  assert.equal(r.status, 403);
  assert.equal((await post(`/api/feed/posts/${P1}/comments`, U.carol, { body: "hi" })).status, 403);
  await post("/api/feed/unban", U.admin, { userId: U.carol.userId });
  assert.equal((await post("/api/feed/posts", U.carol, { body: "free again" })).status, 200);
  // a room ban by that room's owner
  assert.equal((await post("/api/feed/ban", U.owner, { user: "carol", room: "plant-based-chatting" })).status, 200);
  assert.equal((await post("/api/feed/posts", U.carol, { body: "plants", rooms: [ROOM_B] })).status, 403);
  assert.equal((await post("/api/feed/posts", U.carol, { body: "frogs", rooms: [ROOM_A] })).status, 200);
  // casino-banned = "restricted" (the relay's rule)
  await runQuery("UPDATE users SET casino_banned = 1 WHERE userId = ?", [U.bob.userId]);
  r = await post("/api/feed/posts", U.bob, { body: "x" });
  assert.equal(r.status, 403);
  assert.match(r.d.error, /restricted/);
  await runQuery("UPDATE users SET casino_banned = 0 WHERE userId = ?", [U.bob.userId]);
  // Pepe's refusals, synced with the owner map: suspended (everywhere) / kicked in one room
  await web.botSync({ restricted: [{ login: "bobcf", room: "", reason: "you're suspended right now", until: Date.now() + 60000 },
                                   { login: "alicecf", room: ROOM_B, reason: "you were moderated in this room recently", until: Date.now() + 60000 }] });
  r = await post("/api/feed/posts", U.bob, { body: "x" });
  assert.equal(r.status, 403);
  assert.match(r.d.error, /suspended/);
  assert.equal((await post("/api/feed/posts", U.alice, { body: "x", rooms: [ROOM_B], global: false })).status, 403);
  assert.equal((await post("/api/feed/posts", U.alice, { body: "x", rooms: [ROOM_A] })).status, 200);
  await web.botSync({ restricted: [] });
  assert.equal((await post("/api/feed/posts", U.bob, { body: "back" })).status, 200);
});

test("new accounts: a few posts a day, no uploads; the gap between posts", async () => {
  await store.setConfig({ new_account_posts_per_day: 2 }, "test");
  assert.equal((await post("/api/feed/posts", U.newbie, { body: "1" })).status, 200);
  store._gaps.clear();
  assert.equal((await post("/api/feed/posts", U.newbie, { body: "2" })).status, 200);
  store._gaps.clear();
  const r = await post("/api/feed/posts", U.newbie, { body: "3" });
  assert.equal(r.status, 429);
  assert.match(r.d.error, /New accounts/);
  await store.setConfig({ post_gap_secs: 30 }, "test");
  assert.equal((await post("/api/feed/posts", U.lvl, { body: "a" })).status, 200);
  const g = await post("/api/feed/posts", U.lvl, { body: "b" });
  assert.equal(g.status, 429);
  assert.match(g.d.error, /Slow down/);
  await store.setConfig({ post_gap_secs: 0 }, "test");
});

test("votes: one per user, toggles, score cached", async () => {
  let r = await post(`/api/feed/posts/${P1}/vote`, U.bob, {});
  assert.deepEqual(r.d, { ok: true, voted: true, score: 1 });
  store._gaps.clear();
  await post(`/api/feed/posts/${P1}/vote`, U.carol, {});
  store._gaps.clear();
  r = await post(`/api/feed/posts/${P1}/vote`, U.bob, { on: true });      // a second "up" from the same user counts once
  assert.equal(r.d.score, 2);
  store._gaps.clear();
  r = await post(`/api/feed/posts/${P1}/vote`, U.bob, {});                // toggle off
  assert.deepEqual([r.d.voted, r.d.score], [false, 1]);
  const rows = await getQuery("SELECT COUNT(*) AS n FROM feed_votes WHERE post_id = ?", [P1]);
  assert.equal(rows[0].n, 1);
  assert.equal((await post(`/api/feed/posts/${P1}/vote`, null, {})).status, 401);
});

test("sorting: new / top / hot", async () => {
  const t0 = Date.now();
  const mk = async (body, ageH, score) => {
    const r = await post("/api/feed/posts", U.admin, { body });
    await runQuery("UPDATE feed_posts SET created = ?, score = ? WHERE id = ?", [t0 - ageH * 3600e3, score, r.d.id]);
    return r.d.id;
  };
  const old = await mk("old but loved", 72, 50), fresh = await mk("fresh", 0.1, 2), mid = await mk("mid", 5, 10);
  const ids = (s) => store.list({ sort: s, limit: 50, top: "all" }).then((L) => L.posts.map((p) => p.id).filter((x) => [old, fresh, mid].includes(x)));
  assert.deepEqual(await ids("new"), [fresh, mid, old]);
  assert.deepEqual(await ids("top"), [old, mid, fresh]);
  const hot = await ids("hot");
  assert.equal(hot[0], fresh, "hot favours new posts with some votes");
  assert.ok(store.hotScore({ score: 50, comments: 0, created: t0 - 72 * 3600e3 }, t0) < store.hotScore({ score: 2, comments: 0, created: t0 - 360e3 }, t0));
});

test("comments: one level of replies, inbox notices to the author and the person replied to", async () => {
  const c1 = await post(`/api/feed/posts/${P1}/comments`, U.bob, { body: "nice <b>post</b>" });
  assert.equal(c1.status, 200);
  let n = await getQuery("SELECT * FROM inbox WHERE user_id = ? AND ref = ?", [U.alice.userId, "feed-c:" + c1.d.id]);
  assert.equal(n.length, 1);
  assert.equal(n[0].kind, "feed");
  assert.match(n[0].link, new RegExp(`^/feed/p/${P1}#c-`));
  store._gaps.clear();
  const c2 = await post(`/api/feed/posts/${P1}/comments`, U.carol, { body: "agreed", parent: c1.d.id });
  assert.equal((await getQuery("SELECT * FROM inbox WHERE user_id = ? AND ref = ?", [U.bob.userId, "feed-c:" + c2.d.id + ":p"])).length, 1, "bob is told about the reply");
  assert.equal((await getQuery("SELECT * FROM inbox WHERE user_id = ? AND ref = ?", [U.alice.userId, "feed-c:" + c2.d.id])).length, 1, "the post author too");
  store._gaps.clear();
  // a reply to a reply hangs off the top comment (one level)
  const c3 = await post(`/api/feed/posts/${P1}/comments`, U.alice, { body: "thanks", parent: c2.d.id });
  const C = await store.comments(P1);
  const top = C.find((c) => c.id === c1.d.id);
  assert.deepEqual(top.replies.map((r) => r.id), [c2.d.id, c3.d.id]);
  assert.equal((await getQuery("SELECT * FROM inbox WHERE ref = ?", ["feed-c:" + c3.d.id])).length, 0, "no notice to yourself as the author");
  assert.equal((await store.get(P1)).comments, 3);
  // delete: author yes, a random user no; the room owner of a room the post is in yes
  assert.equal((await post(`/api/feed/comments/${c2.d.id}/delete`, U.bob, {})).status, 403);
  assert.equal((await post(`/api/feed/comments/${c2.d.id}/delete`, U.carol, {})).status, 200);
  assert.equal((await store.get(P1)).comments, 2);
  store._gaps.clear();
  const onB = await post(`/api/feed/posts/${P2}/comments`, U.bob, { body: "spam" });
  assert.equal(onB.status, 200);
  assert.equal((await post(`/api/feed/comments/${onB.d.id}/delete`, U.owner, {})).status, 200);
});

test("reports: once per user; enough established reporters hide the post pending review; admins get one notice", async () => {
  const x = await post("/api/feed/posts", U.carol, { body: "reportable" });
  await store.setConfig({ report_hide_threshold: 2 }, "test");
  assert.equal((await post(`/api/feed/posts/${x.d.id}/report`, U.alice, { reason: "spam" })).status, 200);
  store._gaps.clear();
  assert.equal((await post(`/api/feed/posts/${x.d.id}/report`, U.alice, { reason: "spam" })).d.already, true);
  store._gaps.clear();
  await post(`/api/feed/posts/${x.d.id}/report`, U.newbie, { reason: "abuse" });          // new accounts don't count toward hiding
  assert.ok(!(await store.getRow(x.d.id)).hidden_at);
  store._gaps.clear();
  await post(`/api/feed/posts/${x.d.id}/report`, U.bob, { reason: "abuse" });
  assert.ok((await store.getRow(x.d.id)).hidden_at, "hidden after 2 established reporters");
  assert.ok(!(await store.list({})).posts.some((p) => p.id === x.d.id));
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = ? AND ref LIKE ?", [U.admin.userId, "feed-rep:" + x.d.id + "%"]))[0].n, 1);
  const R = await store.reports();
  assert.ok(R.some((r) => r.post.id === x.d.id && r.reports.length === 3));
  // the admin keeps it: visible again, reports resolved
  await post(`/api/feed/posts/${x.d.id}/admin`, U.admin, { hidden: false });
  assert.ok(!(await store.getRow(x.d.id)).hidden_at);
  assert.ok(!(await store.reports()).some((r) => r.post.id === x.d.id));
  await store.setConfig({ report_hide_threshold: 3 }, "test");
});

test("NSFW: author flag, admin override; files need a signed-in viewer", async () => {
  const img = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#a33" } }).png().toBuffer();
  const up = await upload(U.alice, "image", img);
  const x = await post("/api/feed/posts", U.alice, { body: "spicy", attachments: [up.id], nsfw: true });
  const p = await store.get(x.d.id);
  assert.equal(p.nsfw, true);
  assert.equal((await fetch(base + "/feed/f/" + p.images[0].file)).status, 403, "signed out: refused");
  assert.equal((await fetch(base + "/feed/f/" + p.images[0].file, { headers: { "x-test-user": U.bob.userId } })).status, 200);
  await post(`/api/feed/posts/${x.d.id}/admin`, U.admin, { nsfw: false });
  assert.equal((await store.get(x.d.id)).nsfw, false, "admin override wins over the author flag");
  assert.equal((await post(`/api/feed/posts/${x.d.id}/admin`, U.bob, { nsfw: true })).status, 403);
  // a deleted post's files are gone for everyone but staff
  await post(`/api/feed/posts/${x.d.id}/delete`, U.alice, {});
  assert.equal((await fetch(base + "/feed/f/" + p.images[0].file, { headers: { "x-test-user": U.bob.userId } })).status, 404);
  assert.equal((await fetch(base + "/feed/f/" + p.images[0].file, { headers: { "x-test-user": U.admin.userId } })).status, 200);
});

test("cleanup: deleted posts' files purged after the grace period; orphan uploads purged", async () => {
  const img = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#3a3" } }).png().toBuffer();
  const a = await upload(U.alice, "image", img);
  const b = await upload(U.alice, "image", img);
  const x = await post("/api/feed/posts", U.alice, { body: "to delete", attachments: [a.id] });
  await post(`/api/feed/posts/${x.d.id}/delete`, U.alice, {});
  const fa = (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [a.id]))[0];
  const fb = (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [b.id]))[0];
  assert.ok(fs.existsSync(media.filePath(fa.file)));
  store._setClock(() => Date.now() + 8 * 86400e3);
  const r = await store.sweep(media);
  store._setClock(() => Date.now());
  assert.ok(r.purged >= 1 && r.orphans >= 1);
  assert.ok(!fs.existsSync(media.filePath(fa.file)) && !fs.existsSync(media.filePath(fa.thumb)));
  assert.ok(!fs.existsSync(media.filePath(fb.file)), "never-posted upload swept");
});

test("prices: free by default; an admin price is charged, goes to the Reserve, and is refused without funds", async () => {
  const before = (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [U.alice.userId]))[0].b;
  await post("/api/feed/posts", U.alice, { body: "free" });
  assert.equal((await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [U.alice.userId]))[0].b, before);
  await store.setConfig({ price_post: 100, price_link: 50 }, "test");
  store._gaps.clear();
  const r = await post("/api/feed/posts", U.alice, { body: "paid" });
  assert.equal(r.status, 200);
  assert.equal((await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [U.alice.userId]))[0].b, before - 100);
  const claim = await getQuery("SELECT amount FROM reserve_claims WHERE flow = 'feed_post' AND type = ?", ["feed post " + r.d.id]);
  assert.deepEqual(claim.map((c) => c.amount), [-100]);
  store._gaps.clear();
  const broke = await post("/api/feed/posts", U.bob, { body: "no money" });
  assert.equal(broke.status, 402);
  await store.setConfig({ price_post: 0, price_link: 0 }, "test");
});

test("Pepe mentions: off by default; the owner's switch; one line per room per gap; incognito handled by Pepe", async () => {
  await store.setConfig({ mention_gap_min: 10 }, "test");
  store._gaps.clear();
  await post("/api/feed/posts", U.carol, { body: "quiet", rooms: [ROOM_A] });
  assert.equal(((await web.botSync({ feed_mentions: true })).feed_mentions || []).length, 0, "off by default");
  assert.equal((await post("/api/rooms/plant-based-chatting/feed/mention", U.bob, { on: true })).status, 403);
  assert.equal((await post("/api/rooms/plant-based-chatting/feed/mention", U.owner, { on: true })).status, 200);
  store._gaps.clear();
  const a = await post("/api/feed/posts", U.bob, { title: "Monstera update", body: "new leaf", rooms: [ROOM_B] });
  store._gaps.clear();
  await post("/api/feed/posts", U.alice, { body: "another", rooms: [ROOM_B] });
  assert.equal(((await web.botSync({})).feed_mentions), undefined, "only bots that say they handle them get them");
  const m = (await web.botSync({ feed_mentions: true })).feed_mentions;
  assert.equal(m.length, 1);
  assert.equal(m[0].room, ROOM_B);
  assert.match(m[0].text, /2 new posts on the room feed/);
  assert.equal(m[0].author_login, "bobcf");
  assert.equal((await web.botSync({ feed_mentions: true })).feed_mentions.length, 0, "handed out once");
  store._gaps.clear();
  await post("/api/feed/posts", U.bob, { body: "third", rooms: [ROOM_B] });
  assert.equal((await web.botSync({ feed_mentions: true })).feed_mentions.length, 0, "throttled");
  store._setClock(() => Date.now() + 11 * 60e3);
  const m2 = (await web.botSync({ feed_mentions: true })).feed_mentions;
  store._setClock(() => Date.now());
  assert.equal(m2.length, 1);
  assert.match(m2[0].text, /^📌 New post on the room feed by \{author\}: third — http/);
  void a;
});

// ───────────────────────────── rendering ─────────────────────────────
test("rendering: every user string is escaped; links get rel=nofollow noopener ugc; javascript: never linked", async () => {
  const x = await post("/api/feed/posts", U.alice, { title: "<img src=x onerror=alert(1)>", body: "hi <script>alert(1)</script> see https://example.com/a?b=<c> and javascript:alert(1)" });
  const html = await (await fetch(base + "/feed/p/" + x.d.id)).text();
  assert.ok(!html.includes("<script>alert(1)"));
  assert.ok(!html.includes("<img src=x onerror"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.match(html, /<a href="https:\/\/example\.com\/a\?b=" rel="nofollow noopener noreferrer ugc" target="_blank">/);
  assert.ok(!/href="javascript:/i.test(html));
  assert.equal(web.linkify('x "https://a.b/c" y'), 'x &quot;<a href="https://a.b/c" rel="nofollow noopener noreferrer ugc" target="_blank">https://a.b/c</a>&quot; y');
});

test("pages render: /feed, room filter, captures tab, the room section, post detail at any sort", async () => {
  await runQuery("INSERT INTO media (id, kind, ct, file, room, subject, created, expires) VALUES ('abcd1234', 'photo', 'image/jpeg', 'x.jpg', ?, 'froggy', ?, ?)",
                 [ROOM_A, Date.now(), Date.now() + 3600e3]);
  for (const q of ["", "?sort=new", "?sort=top&t=all", "?room=pepefrog-room", "?room=PepeFrog.Room&sort=hot", "?tab=captures", "?by=alice"]) {
    const r = await fetch(base + "/feed" + q, { headers: { "x-test-user": U.bob.userId } });
    assert.equal(r.status, 200, q);
  }
  const html = await (await fetch(base + "/feed?room=pepefrog-room", { headers: { "x-test-user": U.bob.userId } })).text();
  assert.ok(html.includes("Fresh from"), "the room's captures strip");
  assert.ok(html.includes("Hello frogs"));
  assert.ok(!html.includes("plant room only"), "another room's post isn't in this room's filter");
  // signed out: posts yes, captures no
  const out = await (await fetch(base + "/feed?room=pepefrog-room")).text();
  assert.ok(out.includes("Hello frogs") && !out.includes("Fresh from"));
  // the room page section (rendered the way bridge.js does)
  const F = await web.roomFeed(ROOM_A, U.bob, {});
  const part = await ejs.renderFile(path.join(repo, "views/partials/room-feed.ejs"), { feed: F, fx: web.fx, embeds: require(path.join(repo, "stageembed")), host: "test",
                                                                                  room: { name: "Pepe's Pad", slug: "pepefrog-room" } });
  assert.ok(part.includes('id="feed"') && part.includes("Hello frogs") && part.includes("fcForm"));
});
