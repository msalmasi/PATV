// Offline tests for 1.99dq: poster frames for clips (and waveform cards for room audio) - made at upload,
// backfilled idempotently, served by GET /media/:id/poster with the capture's own rules, used by the
// story strip with the camcorder icon as the fallback.   node --test test/media-posters.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "media-posters-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
process.env.FEED_NO_NICE = "1";
const express = require("express");
const ejs = require("ejs");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const media = require(path.join(repo, "media"));
const stories = require(path.join(repo, "stories"));

let HAVE_FFMPEG = true;
try { execFileSync(process.env.FFMPEG_PATH || "ffmpeg", ["-version"], { stdio: "ignore" }); } catch (e) { HAVE_FFMPEG = false; }

// a 3 s 160x120 test-pattern clip and a 2 s tone, made once with ffmpeg
const CLIP = path.join(tmp, "src.mp4"), AUD = path.join(tmp, "src.m4a");
if (HAVE_FFMPEG) {
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x120:rate=10:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", CLIP]);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=2", "-c:a", "aac", "-y", AUD]);
}
const isWebpBuf = (b) => b.slice(0, 4).toString() === "RIFF" && b.slice(8, 12).toString() === "WEBP";
const isWebp = (p) => isWebpBuf(fs.readFileSync(p));

let base, server;
const TOKEN = "bot-token";
const post = async (url, body) => {
  const r = await fetch(base + url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + TOKEN }, body: JSON.stringify(body) });
  return { status: r.status, d: await r.json() };
};
const row = async (id) => (await getQuery("SELECT * FROM media WHERE id = ?", [id]))[0];
const upload = (id, kind, ct, file, extra = {}) => post("/api/media", { id, kind, ct, image: fs.readFileSync(file).toString("base64"), subject: "bob", by: "alice", room: "pad1", secs: 3, ...extra });
// a row + file straight into the store (a capture from before posters existed)
async function legacy(id, kind, src, { expires = Date.now() + 3600e3, nsfw = 0 } = {}) {
  const ext = kind === "clip" ? ".mp4" : kind === "audio" ? ".m4a" : ".jpg";
  fs.copyFileSync(src, path.join(media.DIR, id + ext));
  await runQuery(`INSERT OR REPLACE INTO media (id, kind, ct, file, bytes, secs, subject, by_user, room, created, expires, deleted, anon, nsfw)
                  VALUES (?, ?, ?, ?, 1, 3, 'bob', 'alice', 'pad1', ?, ?, 0, 0, ?)`,
    [id, kind, kind === "clip" ? "video/mp4" : kind === "audio" ? "audio/mp4" : "image/jpeg", id + ext, Date.now(), expires, nsfw]);
  return row(id);
}

test.before(async () => {
  await media.ready;
  // rooms.js (stories' pad lookup) reads the users table
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0)`);
  const app = express();
  app.use((req, res, next) => (req.path === "/api/media" ? next() : express.json()(req, res, next)));
  media.register(app, { isBotToken: (t) => t === TOKEN, addUser: (req, res, next) => next(), noTimers: true });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());

test("upload: a clip gets a webp poster frame (<= 360 px wide), audio a waveform card, a photo none", { skip: !HAVE_FFMPEG && "no ffmpeg" }, async () => {
  assert.equal((await upload("bb000001", "clip", "video/mp4", CLIP)).status, 200);
  assert.equal((await upload("bb000002", "audio", "audio/mp4", AUD)).status, 200);
  const jpg = path.join(tmp, "x.jpg"); fs.writeFileSync(jpg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  assert.equal((await upload("bb000003", "photo", "image/jpeg", jpg)).status, 200);
  // the job was queued by the upload: makePoster returns the same pending promise (or true once it's done)
  assert.equal(await media.makePoster(await row("bb000001")), true);
  assert.equal(await media.makePoster(await row("bb000002")), true);
  assert.equal(await media.makePoster(await row("bb000003")), false);
  for (const id of ["bb000001", "bb000002"]) {
    const p = media.posterFile(id);
    assert.ok(fs.existsSync(p), id + " poster");
    assert.ok(isWebp(p));
    const meta = await require("sharp")(fs.readFileSync(p)).metadata();   // (a buffer: sharp keeps files open on Windows)
    assert.ok(meta.width <= 360 && meta.width > 0);
  }
  assert.equal(media.hasPoster(await row("bb000003")), false);
  // the poster isn't a media file (fileExists never matches it), and no temp files are left behind
  assert.equal(media.fileExists({ file: "bb000001_p.webp" }), false);
  assert.deepEqual(fs.readdirSync(media.DIR).filter((f) => /\.(png|part\.webp)$/.test(f)), []);
});

test("poster route: webp + nosniff + private cache; 404 none / unknown, 410 expired, 404 deleted", { skip: !HAVE_FFMPEG && "no ffmpeg" }, async () => {
  let r = await fetch(base + "/media/bb000001/poster");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/webp");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.headers.get("cache-control"), /^private, max-age=\d+$/);
  assert.equal(r.headers.get("x-robots-tag"), "noindex");
  assert.ok(isWebpBuf(Buffer.from(await r.arrayBuffer())));                        // (and the file is closed again - Windows)
  assert.equal((await fetch(base + "/media/bb000003/poster")).status, 404);          // a photo: no poster
  assert.equal((await fetch(base + "/media/ffffffff/poster")).status, 404);          // unknown
  assert.equal((await fetch(base + "/media/..%2F..%2Fx/poster")).status, 404);      // junk id
  // expired: 410, and the expiry sweep takes the poster with the file
  await legacy("bb000010", "clip", CLIP, { expires: Date.now() + 3600e3 });
  assert.equal(await media.makePoster(await row("bb000010")), true);
  await runQuery("UPDATE media SET expires = ? WHERE id = ?", [Date.now() - 1, "bb000010"]);
  r = await fetch(base + "/media/bb000010/poster");
  assert.equal(r.status, 410);
  assert.equal(fs.existsSync(media.posterFile("bb000010")), false);
  // deleted by Pepe: 404, poster gone too
  assert.equal((await post("/api/media/delete", { id: "bb000001" })).status, 200);
  assert.equal((await fetch(base + "/media/bb000001/poster")).status, 404);
  assert.equal(fs.existsSync(media.posterFile("bb000001")), false);
});

test("backfill: makes the missing posters once, then does nothing (idempotent); skips expired / missing files", { skip: !HAVE_FFMPEG && "no ffmpeg" }, async () => {
  await legacy("cc000001", "clip", CLIP);
  await legacy("cc000002", "audio", AUD);
  await legacy("cc000003", "clip", CLIP, { expires: Date.now() - 1000 });          // expired: not touched
  await legacy("cc000004", "clip", CLIP);
  fs.unlinkSync(path.join(media.DIR, "cc000004.mp4"));                              // file gone: skipped
  const a = await media.backfillPosters();
  assert.ok(a.made >= 2, JSON.stringify(a));
  assert.equal(a.failed, 0);
  for (const id of ["cc000001", "cc000002"]) assert.ok(media.hasPoster(await row(id)));
  assert.equal(fs.existsSync(media.posterFile("cc000003")), false);
  assert.equal(fs.existsSync(media.posterFile("cc000004")), false);
  const mt = fs.statSync(media.posterFile("cc000001")).mtimeMs;
  const b = await media.backfillPosters();
  assert.equal(b.made, 0);
  assert.equal(b.failed, 0);
  assert.equal(b.had, a.had + a.made);
  assert.equal(fs.statSync(media.posterFile("cc000001")).mtimeMs, mt);           // not rewritten
});

test("a failing ffmpeg leaves no poster (fallback), isn't retried by the backfill, and the route 404s", async () => {
  const real = path.join(tmp, "junk.mp4"); fs.writeFileSync(real, "not a video at all");
  let calls = 0;
  media._setPosterImpl(async () => { calls++; throw new Error("boom"); });
  try {
    await legacy("dd000001", "clip", real);
    assert.equal(await media.makePoster(await row("dd000001")), false);
    assert.equal(media.hasPoster(await row("dd000001")), false);
    const n = calls;
    await media.backfillPosters();
    assert.equal(calls, n);                                                         // remembered as failed
    const r = await fetch(base + "/media/dd000001/poster");
    assert.equal(r.status, 404);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(calls, n);
    // the stories shape: no poster -> null, so the strip keeps the camcorder icon
    const [c] = await stories.clean([await row("dd000001")]);
    assert.equal(c.poster, null);
  } finally {
    await runQuery("UPDATE media SET deleted = 1 WHERE id = 'dd000001'");
    media._setPosterImpl(null);
  }
});

test("stories + strip: clips with a poster show it with ▶ and the duration; without one, the icon; NSFW never shows a picture", async () => {
  // fake poster files (the strip only needs them to exist)
  const webp = Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 ", "binary");
  for (const id of ["ee000001", "ee000003"]) {
    fs.writeFileSync(path.join(media.DIR, id + ".mp4"), "x");
    await runQuery(`INSERT OR REPLACE INTO media (id, kind, ct, file, bytes, secs, subject, by_user, room, created, expires, deleted, anon, nsfw)
                    VALUES (?, 'clip', 'video/mp4', ?, 1, 41.6, 'bob', 'alice', 'padx', ?, ?, 0, 0, ?)`, [id, id + ".mp4", Date.now(), Date.now() + 3600e3, id === "ee000003" ? 1 : 0]);
    fs.writeFileSync(media.posterFile(id), webp);
  }
  fs.writeFileSync(path.join(media.DIR, "ee000002.mp4"), "x");
  await runQuery(`INSERT OR REPLACE INTO media (id, kind, ct, file, bytes, secs, subject, by_user, room, created, expires, deleted, anon, nsfw)
                  VALUES ('ee000002', 'clip', 'video/mp4', 'ee000002.mp4', 1, 40, 'carol', 'alice', 'padx', ?, ?, 0, 0, 0)`, [Date.now() - 1000, Date.now() + 3600e3]);
  const caps = await stories.captures("padx", 10);
  const by = Object.fromEntries(caps.map((c) => [c.id, c]));
  assert.equal(by.ee000001.poster, "/media/ee000001/poster");
  assert.equal(by.ee000002.poster, null);
  // the room's story cover: no photo, so the newest non-NSFW clip poster
  const [R] = (await stories.forViewer({ userId: "u1" }, { room: "padx" })).filter((x) => x.id === "padx");
  assert.equal(R.cover, "/media/ee000001/poster");
  assert.equal(R.items.find((i) => i.id === "ee000001").poster, "/media/ee000001/poster");

  const html = await ejs.renderFile(path.join(repo, "views", "partials", "story-strip.ejs"), { story: { caps, rooms: [], room: "padx", signed: true }, heading: "Fresh captures", next: "/" });
  const tile = (id) => { const m = html.match(new RegExp(`<a role="listitem"[^>]*data-story-item="${id}"[\\s\\S]*?</a>`)); assert.ok(m, id); return m[0]; };
  assert.match(tile("ee000001"), /class="ss-t k-clip has-p"/);
  assert.match(tile("ee000001"), /<img class="pst" src="\/media\/ee000001\/poster"/);
  assert.match(tile("ee000001"), /<span class="dur"[^>]*>▶ 0:42<\/span>/);
  assert.doesNotMatch(tile("ee000002"), /<img/);                                    // fallback: the camcorder icon
  assert.match(tile("ee000002"), /📹/);
  assert.match(tile("ee000002"), /▶ 0:40/);
  assert.doesNotMatch(tile("ee000003"), /<img/);                                    // NSFW: no picture on the strip
  assert.match(tile("ee000003"), /🔞/);
});
