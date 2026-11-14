// Story originals (site 1.99anv, storyorig.js): each story upload's ORIGINAL file is kept 48 hours for quality checks instead of
// being deleted after processing - in a private folder, deleted at once when the upload is discarded, the story is deleted (its
// owner, moderation, Pepe's admin delete) or the account goes (test/account-delete.test.js), swept past 48 h (on boot + hourly);
// the capture source (the story camera or a chosen file, a clip's recorder type and timeslice) goes with the story; site Admins
// see both on the story's page and can download the original (logged). Real chunked-upload routes, real image processing.
//   NODE_PATH=<repo>/node_modules TZ=UTC node --test test/story-originals.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "story-originals-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.STORYORIG_DIR;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
process.env.FEED_NO_NICE = "1";
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
const US = require(path.join(repo, "userstories"));
const media = require(path.join(repo, "media"));
const SO = require(path.join(repo, "storyorig"));

const ORIG = path.join(tmp, "storyorig");      // next to FEED_DIR (storyorig.candidateDir)
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
const H = (u, extra) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {}, extra || {});
async function call(method, url, u, body) {
  const r = await fetch(base + url, { method, headers: H(u), body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  let d = null;
  try { d = await r.clone().json(); } catch (e) { d = null; }
  return { status: r.status, d, r };
}
const post = (url, u, body) => call("POST", url, u, body || {});
const get = (url, u) => call("GET", url, u);
let clockAt = Date.now();
const tick = (ms) => { clockAt += ms; };

/** A story upload through the real routes (open, one chunk, finish, processed). -> {id, row} */
async function storyUpload(u, bytes, extra = {}) {
  const started = await post("/api/feed/uploads", u, { kind: "image", size: bytes.length, purpose: "story", ...extra });
  assert.equal(started.status, 200, JSON.stringify(started.d));
  const id = started.d.id;
  const put = await fetch(base + "/api/feed/uploads/" + id + "?offset=0", { method: "PUT", headers: H(u, { "content-type": "application/octet-stream" }), body: bytes });
  assert.equal(put.status, 200, await put.text());
  const fin = await post("/api/feed/uploads/" + id + "/finish", u);
  assert.equal(fin.status, 200, JSON.stringify(fin.d));
  for (let n = 0; n < 500; n++) {
    const row = (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [id]))[0];
    if (row.state !== "processing") { assert.equal(row.state, "ready", row.error || ""); return { id, row }; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("the upload never finished");
}
/** Post upload `id` as a story to the member's profile (each one a minute later: the posting gap). -> story id */
async function postStory(u, id) {
  tick(60e3);
  const r = await post("/api/stories/mine", u, { attachment: id, pad: "profile" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  return r.d.story.id;
}
const origRow = async (id) => (await getQuery("SELECT * FROM story_originals WHERE id = ?", [id]))[0] || null;
const origFile = (id) => path.join(ORIG, id + ".orig");

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await media.ready;
  await require(path.join(repo, "inbox")).ready;
  // a real (tiny) JPEG with an EXIF block: the original keeps it, the story's re-encoded file doesn't
  jpg = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#0a0" } }).withMetadata({ exif: { IFD0: { Copyright: "storyorig-test-exif" } } }).jpeg().toBuffer();
  U.poster = await mkUser("orposter", { camfrog: "orpostercf", display: "Or Poster" });
  U.other = await mkUser("orother", { camfrog: "orothercf" });
  U.admin = await mkUser("orboss", { class: "Admin", camfrog: "orbosscf" });
  U.staff = await mkUser("orstaff", { class: "Staff", camfrog: "orstaffcf" });
  await rooms.init();
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0, uploads_per_hour: 1000 }, "test");
  await keep.init();
  await US.init();
  US._setClock(() => clockAt); SO._setClock(() => clockAt);
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
  US.register(app, { addUser, noTimers: true });
  media.register(app, { addUser, isBotToken: (t) => t === "bot", noTimers: true });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });
test.beforeEach(() => { store._gaps.clear(); });

test("an upload's original is kept (moved, byte for byte, out of the feed's tmp), linked to its story; the capture source goes with the story", async () => {
  const { id, row } = await storyUpload(U.poster, jpg, { capture: { source: "file", picker: "gallery", mime: "image/jpeg", timeslice: 1000, junk: "x" } });
  assert.deepEqual(JSON.parse(row.capture), { source: "file", picker: "gallery" }, "a chosen file: no recorder fields, nothing unknown");
  const o = await origRow(id);
  assert.ok(o, "the row"); assert.equal(o.owner_id, U.poster.userId); assert.equal(o.story_id, null); assert.equal(o.kind, "image"); assert.equal(o.fmt, "jpeg");
  assert.equal(o.bytes, jpg.length); assert.equal(o.expires - o.kept_at, 48 * 3600e3, "48 hours");
  assert.ok(fs.readFileSync(origFile(id)).equals(jpg), "the file as it was sent (its EXIF too)");
  assert.ok(!fs.existsSync(fmedia.tmpPath(id)), "nothing left in tmp");
  assert.ok(!fs.existsSync(path.join(fmedia.dir(), "storyorig")), "never inside the feed's folder");
  const story = await postStory(U.poster, id);
  assert.equal((await origRow(id)).story_id, story, "linked to the story");
  const m = (await getQuery("SELECT * FROM media WHERE id = ?", [story]))[0];
  assert.deepEqual(JSON.parse(m.capture), { source: "file", picker: "gallery" }, "the capture source is on the story");
  const served = fs.readFileSync(path.join(process.env.MEDIA_DIR, m.file));
  assert.ok(!served.includes(Buffer.from("storyorig-test-exif")), "the story itself is the re-encoded file, its metadata dropped");
});

test("the capture source: the story camera's clip with its recorder type and timeslice; anything that doesn't fit is dropped, never refused", async () => {
  const open = async (kind, capture) => {
    const r = await post("/api/feed/uploads", U.other, { kind, size: 5000, purpose: "story", capture });
    assert.equal(r.status, 200, JSON.stringify(r.d));
    const row = (await getQuery("SELECT capture FROM feed_attachments WHERE id = ?", [r.d.id]))[0];
    await post("/api/feed/uploads/" + r.d.id + "/discard", U.other);
    return row.capture ? JSON.parse(row.capture) : null;
  };
  assert.deepEqual(await open("video", { source: "camera", mime: "video/mp4", timeslice: 0 }), { source: "camera", mime: "video/mp4", timeslice: 0 });
  assert.deepEqual(await open("video", { source: "camera", mime: "video/webm;codecs=vp8,opus", timeslice: 1000 }), { source: "camera", mime: "video/webm;codecs=vp8,opus", timeslice: 1000 });
  assert.deepEqual(await open("image", { source: "camera", mime: "image/jpeg", timeslice: 0 }), { source: "camera" }, "a camera photo has no recorder");
  assert.deepEqual(await open("video", { source: "camera", mime: "<script>", timeslice: -5 }), { source: "camera" });
  assert.deepEqual(await open("video", { source: "file", picker: "camera" }), { source: "file", picker: "camera" });
  assert.equal(await open("image", { source: "telepathy" }), null);
  assert.equal(await open("image", "camera"), null);
  assert.equal(await open("image", undefined), null, "an older page says nothing");
  // a post upload (not a story) keeps nothing of it
  const p = await post("/api/feed/uploads", U.other, { kind: "image", size: 5000, capture: { source: "file" } });
  assert.equal(p.status, 200);
  assert.equal((await getQuery("SELECT capture FROM feed_attachments WHERE id = ?", [p.d.id]))[0].capture, null);
  await post("/api/feed/uploads/" + p.d.id + "/discard", U.other);
  // the unit: kinds and limits
  assert.deepEqual(SO.cleanCapture({ source: "camera", mime: "video/mp4", timeslice: 60001 }, "video"), { source: "camera", mime: "video/mp4" });
  assert.deepEqual(SO.cleanCapture({ source: "camera", timeslice: "1000" }, "video"), { source: "camera", timeslice: 1000 });
  assert.deepEqual(SO.cleanCapture({ source: "file", picker: "camera", mime: "video/mp4" }, "video"), { source: "file", picker: "camera" });
  assert.equal(SO.cleanCapture([], "video"), null);
  assert.match(SO.describe({ source: "camera", mime: "video/mp4", timeslice: 0 }, "clip"), /story camera.*video\/mp4.*one piece \(no timeslice\)/);
  assert.match(SO.describe({ source: "camera", mime: "video/webm", timeslice: 1000 }, "clip"), /1 s chunks \(timeslice 1000 ms\)/);
  assert.match(SO.describe({ source: "camera" }, "photo"), /a photo/);
  assert.match(SO.describe({ source: "file", picker: "camera" }, "photo"), /phone's own camera/);
  assert.match(SO.describe(null, "photo"), /not recorded/);
});

test("Admins see how it was made and download the original (logged, an attachment, never inline); nobody else sees or gets it", async () => {
  const { id } = await storyUpload(U.poster, jpg, { capture: { source: "file", picker: "camera" } });
  const story = await postStory(U.poster, id);
  // the story's page
  let r = await get("/media/" + story, U.admin);
  assert.equal(r.status, 200);
  let html = await r.r.text();
  assert.match(html, /Admin · how it was made:<\/b> a file from the phone&#39;s own camera/);
  assert.match(html, new RegExp(`href="/admin/story-originals/${story}"[^>]*download>Download the original</a> \\(logged\\)`));
  assert.match(html, /kept until /);
  assert.equal(r.r.headers.get("cache-control"), "private, no-store");
  for (const u of [U.poster, U.other, U.staff, null]) {
    r = await get("/media/" + story, u);
    assert.equal(r.status, 200);
    assert.doesNotMatch(await r.r.text(), /how it was made|story-originals/, "only Admins: " + (u ? u.username : "signed out"));
  }
  // the download
  for (const u of [U.poster, U.other, U.staff, null]) assert.equal((await get("/admin/story-originals/" + story, u)).status, 404, "404 for " + (u ? u.username : "signed out"));
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'story_original_download'").catch(() => [{ n: 0 }]))[0].n, 0, "nothing logged for a refusal");
  r = await get("/admin/story-originals/" + story, U.admin);
  assert.equal(r.status, 200);
  assert.equal(r.r.headers.get("content-type"), "application/octet-stream");
  assert.equal(r.r.headers.get("content-disposition"), `attachment; filename="story-${story}-original.jpg"`);
  assert.equal(r.r.headers.get("cache-control"), "private, no-store");
  assert.equal(r.r.headers.get("x-content-type-options"), "nosniff");
  assert.match(r.r.headers.get("content-security-policy"), /sandbox/);
  assert.ok(Buffer.from(await r.r.arrayBuffer()).equals(jpg), "the original's bytes");
  const audit = await getQuery("SELECT * FROM admin_audit WHERE action = 'story_original_download'");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].admin_id, U.admin.userId); assert.equal(audit[0].target_id, U.poster.userId); assert.equal(audit[0].target_name, "orposter");
  assert.deepEqual(JSON.parse(audit[0].detail), { story, upload: id, bytes: jpg.length, fmt: "jpeg" });
  assert.equal((await get("/admin/story-originals/nothex", U.admin)).status, 404);
  // past its 48 hours it's gone for the admin too (the sweep would delete it)
  tick(49 * 3600e3);
  assert.equal((await get("/admin/story-originals/" + story, U.admin)).status, 404);
  r = await get("/media/" + story, U.admin);
  if (r.status === 200) assert.match(await r.r.text(), /Original upload: not kept/);
});

test("deleting the story (its owner, staff, Pepe's admin delete) deletes its original at once; a discarded upload's too", async () => {
  // the owner
  let up = await storyUpload(U.poster, jpg);
  let story = await postStory(U.poster, up.id);
  assert.ok(fs.existsSync(origFile(up.id)));
  assert.equal((await post(`/api/stories/${story}/delete`, U.other)).status, 403);
  assert.ok(await origRow(up.id), "a refused delete keeps it");
  assert.equal((await post(`/api/stories/${story}/delete`, U.poster)).status, 200);
  assert.equal(await origRow(up.id), null); assert.ok(!fs.existsSync(origFile(up.id)), "the file went at once");
  // staff (moderation)
  up = await storyUpload(U.poster, jpg);
  story = await postStory(U.poster, up.id);
  assert.equal((await post(`/api/stories/${story}/delete`, U.staff)).status, 200);
  assert.equal(await origRow(up.id), null); assert.ok(!fs.existsSync(origFile(up.id)));
  // Pepe's admin !snap delete
  up = await storyUpload(U.poster, jpg);
  story = await postStory(U.poster, up.id);
  assert.equal((await post("/api/media/delete", null, { password: "bot", id: story })).status, 200);
  assert.equal(await origRow(up.id), null); assert.ok(!fs.existsSync(origFile(up.id)));
  // an upload discarded before it was posted
  up = await storyUpload(U.poster, jpg);
  assert.ok(fs.existsSync(origFile(up.id)));
  assert.equal((await post("/api/feed/uploads/" + up.id + "/discard", U.poster)).status, 200);
  assert.equal(await origRow(up.id), null); assert.ok(!fs.existsSync(origFile(up.id)));
  // a story that only EXPIRES (24 h) keeps its original to the 48 h
  up = await storyUpload(U.poster, jpg);
  story = await postStory(U.poster, up.id);
  tick(25 * 3600e3);
  await SO.sweep();
  assert.ok(await origRow(up.id), "still kept at 25 h"); assert.ok(fs.existsSync(origFile(up.id)));
  await SO.forgetStory(story);
});

test("the sweep: past 48 h the file and the row go; a row with no file and a file with no row (after its grace) go; nothing else is touched", async () => {
  const a = await storyUpload(U.other, jpg);
  const b = await storyUpload(U.other, jpg);
  assert.deepEqual(await SO.sweep(), { expired: 0, unposted: 0, flagged: 0, missing: 0, strays: 0 }, "fresh: nothing (b, a ready upload not posted yet, stays)");
  // an upload that never became a story: once the feed's sweep has purged it (unattached for 6 h) its original goes too
  const c = await storyUpload(U.other, jpg);
  await runQuery("UPDATE feed_attachments SET state = 'purged' WHERE id = ?", [c.id]);
  assert.equal((await SO.sweep()).unposted, 1);
  assert.equal(await origRow(c.id), null); assert.ok(!fs.existsSync(origFile(c.id)));
  // a file nobody recorded (a restart between the move and its row), a row whose file is gone, a file that isn't ours
  const stray = "f".repeat(24);
  fs.writeFileSync(origFile(stray), "stray");
  fs.writeFileSync(path.join(ORIG, "README.txt"), "not ours");
  fs.unlinkSync(origFile(b.id));
  let r = await SO.sweep();
  assert.equal(r.expired, 0); assert.equal(r.missing, 0, "a missing file waits its grace too"); assert.ok(fs.existsSync(origFile(stray)), "a new stray waits its grace");
  tick(SO.GRACE_MS + 60e3);
  // (a stray's age is its file's own time: make it look old)
  const old = new Date(Date.now() - SO.GRACE_MS - 60e3); fs.utimesSync(origFile(stray), old, old);
  r = await SO.sweep(clockAt);
  assert.equal(r.missing, 1); assert.equal(r.strays, 1);
  assert.equal(await origRow(b.id), null); assert.ok(!fs.existsSync(origFile(stray)));
  assert.ok(await origRow(a.id), "a still has its 48 h"); assert.ok(fs.existsSync(origFile(a.id)));
  // 47 h: kept; past 48 h: gone (its row's expiry; a file older than that by its own wall-clock time goes too)
  tick(47 * 3600e3 - SO.GRACE_MS - 60e3);
  r = await SO.sweep();
  assert.equal(r.expired, 0); assert.ok(fs.existsSync(origFile(a.id)));
  tick(2 * 3600e3);
  r = await SO.sweep();
  assert.equal(r.expired, 1); assert.equal(await origRow(a.id), null); assert.ok(!fs.existsSync(origFile(a.id)));
  assert.ok(fs.existsSync(path.join(ORIG, "README.txt")), "a file that isn't an original is left alone");
  fs.unlinkSync(path.join(ORIG, "README.txt"));
});

test("the switch story_keep_originals: off = no new originals (the upload goes as before); the admin page has it; changes are audited", async () => {
  assert.equal(store.DEFAULTS.story_keep_originals, true, "on by default (the owner, 2026-11-14)");
  assert.match(fs.readFileSync(path.join(repo, "views/feedAdmin.ejs"), "utf8"), /name="story_keep_originals"/);
  const r0 = await post("/api/feed/admin/config", U.admin, { story_keep_originals: false });
  assert.equal(r0.status, 200, JSON.stringify(r0.d));
  assert.equal(SO.on(), false);
  const audit = (await getQuery("SELECT * FROM admin_audit WHERE action = 'feed_config' ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual(JSON.parse(audit.detail), { story_keep_originals: { from: true, to: false } });
  assert.equal(audit.admin_id, U.admin.userId);
  assert.equal((await post("/api/feed/admin/config", U.staff, { story_keep_originals: true })).status, 403, "feed settings are Admins'");
  try {
    const { id } = await storyUpload(U.other, jpg);
    assert.equal(await origRow(id), null); assert.ok(!fs.existsSync(origFile(id)));
    assert.ok(!fs.existsSync(fmedia.tmpPath(id)), "deleted after processing, as before 1.99anv");
  } finally {
    await post("/api/feed/admin/config", U.admin, { story_keep_originals: true });
  }
  assert.equal(SO.on(), true);
  // the privacy page: its section 9 row and its dated change note while originals are kept (terms.js "story-originals")
  const T = require(path.join(repo, "terms")), ejs = require("ejs"), fn = path.join(repo, "views", "privacy.ejs");
  assert.ok(T.TEXT_DATES.includes("story-originals"));
  assert.equal(SO.privacyOn(), true, "the switch is on");
  const L0 = { user: null, title: "Privacy Policy", VERSION: T.VERSION, UPDATED: T.PRIVACY_UPDATED, enforced: false, chatlog: null, hubErasure: null,
               micrec: null, memory: null, privwire: null, evidence: null, ogBase: "http://test" };
  const shown = await ejs.renderFile(fn, { ...L0, storyOrig: true, policyDates: { "story-originals": { at: 1, day: "14 November 2026" } } });
  assert.match(shown, /<tr id="story-originals"><td>Original story uploads \(the file as it came from your device, before PATV re-encodes it for your story\)<\/td><td>48 hours for quality checks, then deleted\./);
  assert.match(shown, /<li><b>14 November 2026:<\/b> added <a href="#story-originals">original story uploads<\/a> to section 9/);
  const hidden = await ejs.renderFile(fn, { ...L0, policyDates: { "story-originals": { at: 1, day: "14 November 2026" } } });
  assert.doesNotMatch(hidden, /story-originals|Original story uploads/, "switched off with none kept: the page as before");
});

test("an account's originals all go with forgetOwner (the account deletion's step); merges move them", async () => {
  const a = await storyUpload(U.other, jpg), b = await storyUpload(U.other, jpg);
  await postStory(U.other, b.id);
  const mine = await storyUpload(U.poster, jpg);
  assert.equal(await SO.forgetOwner(U.other.userId), 2);
  for (const x of [a, b]) { assert.equal(await origRow(x.id), null); assert.ok(!fs.existsSync(origFile(x.id))); }
  assert.ok(await origRow(mine.id), "someone else's stays");
  assert.match(fs.readFileSync(path.join(repo, "accountdelete.js"), "utf8"), /require\("\.\/storyorig"\)\.forgetOwner\(uid\)/);
  assert.equal(require(path.join(repo, "accountMerge")).classify("story_originals", "owner_id").move, true);
  await SO.forgetUpload(mine.id);
});

// ── 1.99anv review fixes ──
test("review: a file the safety check REFUSES keeps no original (gone at once); one it couldn't check keeps it for the retry", async () => {
  try {
    // refused (imagesafety's enforce decision - a possible minor among them)
    US.setSafetyCheck(async () => ({ ok: false, reason: "That picture can't be posted here.", refused: true }));
    let up = await storyUpload(U.poster, jpg);
    assert.ok(fs.existsSync(origFile(up.id)), "kept while it waits to be posted");
    tick(60e3);
    let r = await post("/api/stories/mine", U.poster, { attachment: up.id, pad: "profile" });
    assert.equal(r.status, 422, JSON.stringify(r.d));
    assert.equal(await origRow(up.id), null, "the row went with the refusal"); assert.ok(!fs.existsSync(origFile(up.id)), "and the file");
    // the check couldn't run (fail-closed, or it threw): the member may retry, so the original stays (the unposted sweep takes it otherwise)
    US.setSafetyCheck(async () => ({ ok: false, reason: "The picture couldn't be safety-checked right now - try again in a minute." }));
    up = await storyUpload(U.poster, jpg);
    tick(60e3);
    r = await post("/api/stories/mine", U.poster, { attachment: up.id, pad: "profile" });
    assert.equal(r.status, 422);
    assert.ok(await origRow(up.id)); assert.ok(fs.existsSync(origFile(up.id)));
    US.setSafetyCheck(async () => { throw new Error("vision down"); });
    tick(60e3);
    r = await post("/api/stories/mine", U.poster, { attachment: up.id, pad: "profile" });
    assert.equal(r.status, 422);
    assert.ok(await origRow(up.id), "a check that threw isn't a refusal either");
    US.setSafetyCheck(null);
    const story = await postStory(U.poster, up.id);
    assert.equal((await origRow(up.id)).story_id, story, "the retry posts it, original and all");
    await SO.forgetStory(story);
  } finally { US.setSafetyCheck(null); }
  // the story surface's wrapper says which answers are refusals: the policy's own (mode enforce) - not fail-closed
  assert.match(fs.readFileSync(path.join(repo, "imagesafety.js"), "utf8"),
               /return r\.ok \? \{ ok: true, nsfw: !!r\.nsfw \} : \{ ok: false, reason: r\.reason, refused: r\.mode === "enforce" \};/);
});

test("review: a possible minor flagged around an uploader's story - its original is never kept or offered (admin box, download, sweep)", async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS image_safety_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, surface TEXT NOT NULL, kind TEXT,
                  user_id TEXT, room_id TEXT, ref TEXT, hash TEXT, mode TEXT NOT NULL, action TEXT NOT NULL, flagged INTEGER NOT NULL DEFAULT 0, verdict TEXT,
                  categories TEXT)`);
  const flag = (u, extra = {}) => runQuery("INSERT INTO image_safety_log (at, surface, user_id, ref, mode, action, flagged, verdict, categories) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
    [extra.at != null ? extra.at : clockAt, extra.surface || "story", u.userId, "story:x", extra.mode || "late", "failopen", "refuse", JSON.stringify(extra.cats || ["minor_risk"])]);
  try {
    // posted, then flagged late: the admin box says so, offers no link, and the original is deleted then and there
    let up = await storyUpload(U.poster, jpg);
    let story = await postStory(U.poster, up.id);
    assert.match(await (await get("/media/" + story, U.admin)).r.text(), /Download the original/, "before the flag");
    await flag(U.poster);
    assert.equal(await SO.minorFlagged(await origRow(up.id)), true);
    let html = await (await get("/media/" + story, U.admin)).r.text();
    assert.match(html, /Original upload: deleted - the image safety check flagged a possible minor around this story/);
    assert.doesNotMatch(html, /Download the original|story-originals/);
    assert.equal(await origRow(up.id), null); assert.ok(!fs.existsSync(origFile(up.id)));
    await runQuery("DELETE FROM image_safety_log");
    // the download itself refuses (and deletes) - nothing logged as downloaded
    up = await storyUpload(U.poster, jpg);
    story = await postStory(U.poster, up.id);
    await flag(U.poster, { mode: "shadow" });
    const before = (await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'story_original_download'"))[0].n;
    assert.equal((await get("/admin/story-originals/" + story, U.admin)).status, 404);
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'story_original_download'"))[0].n, before);
    assert.equal(await origRow(up.id), null); assert.ok(!fs.existsSync(origFile(up.id)));
    await runQuery("DELETE FROM image_safety_log");
    // the sweep: flagged ones go; another uploader's flag, another category, another surface or a check from long before don't count
    const mine = await storyUpload(U.poster, jpg), theirs = await storyUpload(U.other, jpg);
    await flag(U.other, { cats: ["sexual"] });
    await flag(U.poster, { surface: "feed" });
    await flag(U.poster, { at: clockAt - 3600e3 });
    let r = await SO.sweep();
    assert.equal(r.flagged, 0, JSON.stringify(r));
    assert.ok(await origRow(mine.id)); assert.ok(await origRow(theirs.id));
    await flag(U.poster);
    r = await SO.sweep();
    assert.equal(r.flagged, 1);
    assert.equal(await origRow(mine.id), null); assert.ok(!fs.existsSync(origFile(mine.id)));
    assert.ok(await origRow(theirs.id), "someone else's stays");
    await SO.forgetUpload(theirs.id);
  } finally { await runQuery("DELETE FROM image_safety_log"); }
});

test("review: originals kept in the fallback folder (Linux without root) are still found after a restart - deletes, the admin box, the sweep", async () => {
  const def = path.join(tmp, "def-missing"), fb = path.join(tmp, "fallback-orig");
  SO._setPaths({ candidate: def, fallback: fb, pinned: false });
  try {
    SO._setDir(fb);                                        // pickDir() fell back (it does on Linux when /var/lib/patv can't be made)
    let up = await storyUpload(U.poster, jpg);
    assert.ok(fs.existsSync(path.join(fb, up.id + ".orig")), "kept in the fallback");
    let story = await postStory(U.poster, up.id);
    SO._resetDir();                                        // a restart: nothing in memory says where it went
    assert.ok(!fs.existsSync(def));
    assert.deepEqual(SO.dirs(), [fb]);
    assert.equal(SO.findFile(up.id), path.join(fb, up.id + ".orig"));
    assert.match(await (await get("/media/" + story, U.admin)).r.text(), /Download the original/, "the admin box finds it");
    assert.equal((await get("/admin/story-originals/" + story, U.admin)).status, 200, "and the download");
    assert.equal((await post(`/api/stories/${story}/delete`, U.poster)).status, 200);
    assert.equal(await origRow(up.id), null); assert.ok(!fs.existsSync(path.join(fb, up.id + ".orig")), "deleted at once, from the fallback");
    // the sweep looks there too (past 48 h)
    SO._setDir(fb);
    up = await storyUpload(U.poster, jpg);
    SO._resetDir();
    tick(SO.KEEP_MS + 60e3);
    const r = await SO.sweep();
    assert.ok(r.expired >= 1, JSON.stringify(r));
    assert.equal(await origRow(up.id), null); assert.ok(!fs.existsSync(path.join(fb, up.id + ".orig")), "swept from the fallback");
    // STORYORIG_DIR / FEED_DIR pin the folder: then the fallback is never looked at
    SO._setPaths({ candidate: def, fallback: fb, pinned: true });
    assert.deepEqual(SO.dirs(), []);
  } finally { SO._setPaths(null); SO._resetDir(); }
  assert.ok(SO.dirs().includes(ORIG) || !fs.existsSync(ORIG), "back to the test's own folder");
});
