// Offline tests for 1.99fc: automated image safety checks (imagesafety.js). A STUBBED classifier stands in for Pepe's
// vision (setClassifier), except in the queue round trip, which drives Pepe's real bot API (pull / verdict) over HTTP.
//   * the switch: off -> every hook is a pass-through, nothing is queued, nothing recorded, Pepe's pull gets no work
//   * shadow mode: classifies + records, never blocks or marks, never makes the upload wait
//   * the policy per surface (decide + check): pad look / profile photo, feed (pad allows NSFW or not), story, DM
//   * timeouts: fail-open (allowed + flagged, a late verdict still recorded) / fail-closed (refused)
//   * the wiring: padlook.setImage, feedstore.create, the story + DM hooks
//   * the admin review page: admins only (not Staff, not members, not anonymous), thumbnails access-checked, settings + marks
//   NODE_PATH=G:/PATV/node_modules node --test test/imagesafety.test.js     (temp DB + dirs)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "imagesafety-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.PAD_DIR = path.join(tmp, "pad");
process.env.IMAGESAFETY_DIR = path.join(tmp, "isf");
const express = require("express");
const sharp = require("sharp");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const PL = require(path.join(repo, "padlook"));
const US = require(path.join(repo, "userstories"));
const DM = require(path.join(repo, "dmmedia"));
const ISF = require(path.join(repo, "imagesafety"));
require(path.join(repo, "terms"))._setRequired(false);

const PLANT = "plant_based_chatting";
const HAVE_FFMPEG = (() => { try { require("child_process").execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch (e) { return false; } })();
const users = new Map();
const U = {};
let server, base;
async function mkUser(name, cls = "pleb", camfrog = null) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, 1000, ?, 5, '2026-01-01 00:00:00', 0)`, [id, name, name, cls, camfrog]);
  const u = { userId: id, username: name, class: cls };
  users.set(id, u);
  return u;
}
const png = (w = 64, h = 64, c = { r: 200, g: 60, b: 90 }) => sharp({ create: { width: w, height: h, channels: 3, background: c } }).png().toBuffer();

// the stubbed classifier: what it answers next, and how often it was asked
let ANSWER = { verdict: "allow", scores: {} };
let CALLS = 0;
function stub() { ISF.setClassifier(async () => { CALLS++; return typeof ANSWER === "function" ? ANSWER() : ANSWER; }); }
const EXPLICIT = { verdict: "nsfw", scores: { nudity_explicit: 0.95, sexual: 0.7 }, reason: "explicit nudity" };
const MINOR = { verdict: "refuse", scores: { minor_risk: 0.8, suggestive: 0.7 }, reason: "possible minor, suggestive" };
const GORE = { verdict: "nsfw", scores: { gore: 0.9 }, reason: "graphic injury" };
const SUGGESTIVE_SFW = { verdict: "allow", scores: { suggestive: 0.7 }, reason: "swimwear" };
const SUGGESTIVE_NSFW = { verdict: "nsfw", scores: { suggestive: 0.9 }, reason: "lingerie, sexualised pose" };
const CLEAN = { verdict: "allow", scores: { nudity_explicit: 0.01 }, reason: "a plant" };

async function setCfg(patch) { ISF._reset(); stub(); return ISF.setConfig({ ...ISF.DEFAULTS, ...patch }, "test"); }
async function logRows() { return getQuery("SELECT * FROM image_safety_log ORDER BY id"); }
const until = async (fn, ms = 3000) => { const t = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t > ms) return v; await new Promise((r) => setTimeout(r, 25)); } };

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  U.owner = await mkUser("plantowner", "pleb", "foamy1111");
  U.alice = await mkUser("alice", "pleb", "alicecf");
  U.admin = await mkUser("boss", "Admin", "bossfrog");
  U.staff = await mkUser("helper", "Staff");
  await rooms.init();
  await rooms.setOwner(PLANT, "plantowner", "test");
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0 }, "test");
  await PL.init();
  await ISF.init();
  await require(path.join(repo, "inbox")).ready;      // the admins' alerts land here
  const app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  ISF.register(app, { addUser, isBotToken: (t) => t === "bot", noTimers: true });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { if (server) server.close(); ISF._reset(); PL.setSafetyCheck(null); store.setMediaSafetyCheck(null); US.setSafetyCheck(null); DM.setSafetyCheck(null); });

const H = (u, extra = {}) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch", origin: base }, u ? { "x-test-user": u.userId } : {}, extra);
async function call(method, url, u, body, headers) {
  const r = await fetch(base + url, { method, redirect: "manual", headers: H(u, headers), body: body === undefined ? undefined : JSON.stringify(body) });
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, location: r.headers.get("location"), ct, d: /json/.test(ct) ? await r.json() : null, text: /html/.test(ct) ? await r.text() : null };
}

// ───────────────────────── the switch: off = pass-through ─────────────────────────
test("default: OFF - every setting off, checks pass through, nothing queued or recorded, Pepe's pull gets no work", async () => {
  ISF._reset();
  const C = await ISF.config();
  assert.equal(C.enabled, false);
  assert.equal(C.shadow, false);
  assert.equal(C.fail_mode, "open");
  const names = ISF.settingsView(C);
  assert.equal(names.image_safety_enabled, false);
  assert.equal(names.image_safety_shadow, false);
  assert.equal(names.image_safety_fail_mode, "open");
  // no stub on purpose: the real queue - nothing may reach it
  const buf = await png();
  for (const surface of ISF.SURFACES) {
    const r = await ISF.check({ surface, kind: "image", buf, userId: U.alice.userId, roomId: PLANT });
    assert.deepEqual(r, { ok: true, nsfw: false }, surface);
  }
  assert.equal(await ISF.prefetch({ surface: "feed", kind: "image", file: "/nope" }), false);
  assert.equal(ISF.queueStats().queued, 0, "nothing queued");
  assert.equal((await logRows()).length, 0, "nothing recorded");
  const p = await call("POST", "/api/pepe/imagesafety/pull", null, { password: "bot", wait: 5 });
  assert.equal(p.status, 200);
  assert.equal(p.d.enabled, false);
  assert.deepEqual(p.d.jobs, []);
  assert.equal(p.d.idle, 60);
});

test("a surface toggled off is a pass-through even with the master switch on", async () => {
  await setCfg({ enabled: true, surfaces: { ...ISF.DEFAULTS.surfaces, dm: false } });
  ANSWER = EXPLICIT; CALLS = 0;
  const r = await ISF.check({ surface: "dm", kind: "image", buf: await png(), userId: U.alice.userId });
  assert.deepEqual(r, { ok: true, nsfw: false });
  assert.equal(CALLS, 0);
});

// ───────────────────────── shadow mode ─────────────────────────
test("shadow mode never blocks or marks (even with the master switch on), but records what it would have done", async () => {
  await setCfg({ shadow: true, enabled: true });
  await runQuery("DELETE FROM image_safety_log");
  ANSWER = MINOR; CALLS = 0;
  const r1 = await ISF.check({ surface: "pad_look", kind: "image", buf: await png(), userId: U.owner.userId, roomId: PLANT });
  assert.equal(r1.ok, true);
  assert.equal(r1.nsfw, false);
  ANSWER = EXPLICIT;
  const r2 = await ISF.check({ surface: "feed", kind: "image", buf: await png(80, 80), userId: U.alice.userId, roomId: PLANT });
  assert.equal(r2.ok, true);
  assert.equal(r2.nsfw, false, "never marked in shadow mode");
  const rows = await until(async () => { const x = await logRows(); return x.length >= 2 ? x : null; });
  assert.ok(rows, "both recorded");
  const pad = rows.find((x) => x.surface === "pad_look"), feed = rows.find((x) => x.surface === "feed");
  assert.deepEqual([pad.mode, pad.action, pad.would, pad.flagged], ["shadow", "shadow", "refuse", 1]);
  assert.deepEqual([feed.mode, feed.action, feed.would], ["shadow", "shadow", "nsfw"]);
  // a possible-minor flag still alerts the admins (the alert says nothing was blocked)
  const n = await until(async () => (await getQuery("SELECT * FROM inbox WHERE user_id = ? AND ref LIKE 'imagesafety:%'", [U.admin.userId]))[0]);
  assert.ok(n, "admin alerted");
  assert.match(n.body, /shadow mode: nothing was blocked/);
  // and the thumbnail of the possible-minor check is stored (blurred) for admins
  assert.ok(pad.thumb && fs.existsSync(ISF.thumbPath(pad.thumb)));
});

test("shadow mode doesn't make the upload wait for Pepe", async () => {
  await setCfg({ shadow: true, timeout_secs: 30 });
  ISF.setClassifier(() => new Promise(() => {}));     // Pepe never answers
  const t = Date.now();
  const r = await ISF.check({ surface: "story", kind: "image", buf: await png(), userId: U.alice.userId, roomId: PLANT });
  assert.equal(r.ok, true);
  assert.ok(Date.now() - t < 2000, "returned at once");
});

// ───────────────────────── the policy ─────────────────────────
test("decide(): the default policy per surface", () => {
  const v = (raw) => ISF.cleanVerdict(raw);
  const D = (s, raw, o) => { const d = ISF.decide(s, v(raw), o); return [d.action, d.flagged]; };
  for (const s of ["pad_look", "profile_photo"]) {
    assert.deepEqual(D(s, EXPLICIT), ["refuse", false], s + " explicit");
    assert.deepEqual(D(s, { verdict: "allow", scores: { sexual: 0.8 } }), ["refuse", false], s + " sexual");
    assert.deepEqual(D(s, GORE), ["refuse", false], s + " gore");
    assert.deepEqual(D(s, MINOR), ["refuse", true], s + " minor");
    assert.deepEqual(D(s, SUGGESTIVE_SFW), ["allow", false], s + " suggestive, not NSFW-level");
    assert.deepEqual(D(s, SUGGESTIVE_NSFW), ["refuse", false], s + " suggestive at NSFW level");
    assert.deepEqual(D(s, CLEAN), ["allow", false], s + " clean");
    assert.deepEqual(D(s, { verdict: "allow", scores: { hate_symbols: 0.9 } }), ["allow", true], s + " hate symbols -> flag");
  }
  for (const s of ["feed", "story"]) {
    assert.deepEqual(D(s, EXPLICIT, { padAllowsNsfw: true }), ["nsfw", false], s + " explicit, NSFW pad");
    assert.deepEqual(D(s, EXPLICIT, { padAllowsNsfw: false }), ["refuse", false], s + " explicit, SFW pad");
    assert.deepEqual(D(s, MINOR, { padAllowsNsfw: true }), ["refuse", true], s + " minor");
    assert.deepEqual(D(s, GORE, { padAllowsNsfw: false }), ["nsfw", false], s + " gore -> NSFW (even in a SFW pad)");
    assert.deepEqual(D(s, SUGGESTIVE_SFW), ["allow", false], s + " suggestive");
    assert.deepEqual(D(s, CLEAN), ["allow", false], s + " clean");
  }
  assert.deepEqual(D("dm", EXPLICIT), ["nsfw", false], "dm explicit -> NSFW");
  assert.deepEqual(D("dm", MINOR), ["refuse", true], "dm minor");
  // below the threshold doesn't count; thresholds are per category
  assert.deepEqual(D("feed", { verdict: "allow", scores: { nudity_explicit: 0.3 } }), ["allow", false]);
  assert.deepEqual(D("feed", { verdict: "allow", scores: { minor_risk: 0.45 } }), ["refuse", true], "minor_risk counts from 0.4");
  // a custom policy
  const policy = ISF.cleanConfig({ policy: { media: { gore: "refuse" } } }).policy;
  assert.equal(ISF.decide("feed", v(GORE), { policy }).action, "refuse");
  assert.equal(policy.media.minor_risk, "refuse_flag", "the rest keeps the defaults");
});

test("cleanVerdict / cleanConfig reject junk", () => {
  assert.equal(ISF.cleanVerdict(null), null);
  assert.equal(ISF.cleanVerdict({}), null);
  const v = ISF.cleanVerdict({ verdict: "WAT", scores: { nudity_explicit: 7, gore: -1 }, reason: "<b>x</b>\n y" });
  assert.equal(v.scores.nudity_explicit, 1);
  assert.equal(v.scores.gore, 0);
  assert.equal(v.verdict, "nsfw", "an unknown verdict follows the categories");
  assert.doesNotMatch(v.reason, /[<>\n]/);
  const c = ISF.cleanConfig({ image_safety_enabled: "on", image_safety_fail_mode: "sideways", image_safety_policy: { profile: { gore: "explode" } } });
  assert.equal(c.enabled, true);
  assert.equal(c.fail_mode, "open");
  assert.equal(c.policy.profile.gore, "refuse");
});

test("check(): enforcement per surface with a stubbed classifier, every decision recorded", async () => {
  await setCfg({ enabled: true });
  await runQuery("DELETE FROM image_safety_log");
  const buf = await png(70, 70);
  ANSWER = EXPLICIT;
  let r = await ISF.check({ surface: "pad_look", kind: "image", buf, roomId: PLANT, userId: U.owner.userId });
  assert.equal(r.ok, false);
  assert.match(r.reason, /safe for work/);
  r = await ISF.check({ surface: "profile_photo", kind: "image", buf, userId: U.alice.userId });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Profile photos/);
  r = await ISF.check({ surface: "feed", kind: "image", buf, roomId: PLANT, userId: U.alice.userId, padAllowsNsfw: true });
  assert.deepEqual([r.ok, r.nsfw], [true, true]);
  r = await ISF.check({ surface: "feed", kind: "image", buf, roomId: PLANT, userId: U.alice.userId, padAllowsNsfw: false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /doesn't allow NSFW/);
  r = await ISF.check({ surface: "dm", kind: "image", buf, userId: U.alice.userId });
  assert.deepEqual([r.ok, r.nsfw], [true, true]);
  ANSWER = GORE;
  r = await ISF.check({ surface: "story", kind: "image", buf, roomId: PLANT, userId: U.alice.userId });
  assert.deepEqual([r.ok, r.nsfw], [true, true]);
  ANSWER = MINOR;
  r = await ISF.check({ surface: "story", kind: "image", buf, roomId: PLANT, userId: U.alice.userId });
  assert.equal(r.ok, false);
  assert.equal(r.flagged, true);
  assert.match(r.reason, /under 18/);
  ANSWER = CLEAN;
  r = await ISF.check({ surface: "pad_look", kind: "image", buf, roomId: PLANT, userId: U.owner.userId });
  assert.deepEqual([r.ok, r.nsfw], [true, false]);
  const rows = await logRows();
  assert.deepEqual(rows.map((x) => x.action), ["refuse", "refuse", "nsfw", "refuse", "nsfw", "nsfw", "refuse", "allow"]);
  assert.ok(rows.every((x) => x.mode === "enforce"));
  // DM pictures are private: a thumbnail only when the check acted
  const dm = rows.find((x) => x.surface === "dm");
  assert.ok(dm.thumb, "the NSFW-marked DM picture has a thumbnail");
  await ISF.check({ surface: "dm", kind: "image", buf: await png(71, 71), userId: U.alice.userId });
  const clean = (await logRows()).pop();
  assert.deepEqual([clean.surface, clean.action, clean.thumb], ["dm", "allow", null], "an allowed DM picture keeps no thumbnail");
});

test("videos: a few sampled frames go to the classifier (or the poster when ffmpeg can't read it)", async () => {
  await setCfg({ enabled: true, video_frames: 3 });
  const poster = path.join(tmp, "poster.webp");
  fs.writeFileSync(poster, await sharp(await png(90, 60)).webp().toBuffer());
  let seen = null;
  ISF.setClassifier(async ({ frames, kind }) => { seen = { n: frames.length, kind, jpeg: frames.every((f) => f[0] === 0xff && f[1] === 0xd8) }; return CLEAN; });
  const r = await ISF.check({ surface: "feed", kind: "video", file: path.join(tmp, "missing.mp4"), poster, secs: 12, roomId: PLANT, userId: U.alice.userId });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, { n: 1, kind: "video", jpeg: true });
  // animated pictures: the first and the middle frame
  const frames = await ISF.framesFor({ kind: "image", buf: await sharp(await png(40, 40), { animated: false }).gif().toBuffer() });
  assert.ok(frames.length >= 1);
});

test("videos through ffmpeg: video_frames frames sampled across the clip", { skip: !HAVE_FFMPEG && "no ffmpeg" }, async () => {
  await setCfg({ enabled: true, video_frames: 3 });
  const mp4 = path.join(tmp, "clip.mp4");
  require("child_process").execFileSync("ffmpeg", ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=3",
    "-pix_fmt", "yuv420p", "-y", mp4]);
  let n = 0;
  ISF.setClassifier(async ({ frames }) => { n = frames.length; return CLEAN; });
  const r = await ISF.check({ surface: "story", kind: "video", file: mp4, secs: 3, roomId: PLANT, userId: U.alice.userId });
  assert.equal(r.ok, true);
  assert.equal(n, 3);
});

// ───────────────────────── timeouts + fail mode ─────────────────────────
test("timeout, fail OPEN (default): allowed, recorded as unchecked + flagged; a late verdict is still recorded", async () => {
  await setCfg({ enabled: true, timeout_secs: 0.3, fail_mode: "open" });
  await runQuery("DELETE FROM image_safety_log");
  ISF.setClassifier(null);           // the real queue: the job outlives the wait, so a late verdict can land
  const t = Date.now();
  const r = await ISF.check({ surface: "feed", kind: "image", buf: await png(33, 33), roomId: PLANT, userId: U.alice.userId, padAllowsNsfw: false });
  assert.ok(Date.now() - t < 2500);
  assert.equal(r.ok, true);
  assert.equal(r.mode, "failopen");
  let row = (await logRows()).pop();
  assert.deepEqual([row.action, row.flagged, row.late], ["failopen", 1, 0]);
  // Pepe answers late (the job is still queued): the row gets the classification and what it would have done
  const jobs = await ISF.pull(0);
  assert.equal(jobs.length, 1);
  assert.ok(await ISF.result({ id: jobs[0].id, verdict: EXPLICIT, model: "glm-test", cost: 0.0001 }));
  row = await until(async () => { const x = (await getQuery("SELECT * FROM image_safety_log WHERE id = ?", [row.id]))[0]; return x.late ? x : null; });
  assert.ok(row, "late verdict recorded");
  assert.deepEqual([row.verdict, row.would, row.flagged, row.model], ["nsfw", "refuse", 1, "glm-test"]);
});

test("timeout, fail CLOSED: refused with a try-again message, recorded", async () => {
  await setCfg({ enabled: true, timeout_secs: 0.3, fail_mode: "closed" });
  ISF.setClassifier(() => new Promise(() => {}));
  const r = await ISF.check({ surface: "pad_look", kind: "image", buf: await png(34, 34), roomId: PLANT, userId: U.owner.userId });
  assert.equal(r.ok, false);
  assert.match(r.reason, /couldn't be safety-checked/);
  assert.equal((await logRows()).pop().action, "failclosed");
  // Pepe answering with an error fails at once (no waiting for the timeout)
  await setCfg({ enabled: true, timeout_secs: 30, fail_mode: "closed" });
  ISF.setClassifier(null);
  const pending = ISF.check({ surface: "pad_look", kind: "image", buf: await png(35, 35), roomId: PLANT, userId: U.owner.userId });
  const jobs = await until(async () => { const j = await ISF.pull(0); return j.length ? j : null; });
  assert.ok(await ISF.result({ id: jobs[0].id, error: "model gave nothing" }));
  const r2 = await pending;
  assert.equal(r2.ok, false);
});

// ───────────────────────── Pepe's queue over HTTP ─────────────────────────
test("Pepe's bot API: pull (long-poll) -> frames -> verdict -> the waiting upload gets its answer; bot token required", async () => {
  await setCfg({ enabled: true, timeout_secs: 10 });
  ISF.setClassifier(null);
  assert.equal((await call("POST", "/api/pepe/imagesafety/pull", null, { password: "nope" })).status, 403);
  assert.equal((await call("POST", "/api/pepe/imagesafety/verdict", null, { password: "nope", id: "x" })).status, 403);
  // a long-poll that's waiting when the upload arrives
  const poll = call("POST", "/api/pepe/imagesafety/pull", null, { password: "bot", wait: 5 });
  await new Promise((r) => setTimeout(r, 100));
  const pending = ISF.check({ surface: "feed", kind: "image", buf: await png(50, 40), roomId: PLANT, userId: U.alice.userId, padAllowsNsfw: true });
  const p = await poll;
  assert.equal(p.status, 200);
  assert.equal(p.d.enabled, true);
  assert.equal(p.d.jobs.length, 1);
  const job = p.d.jobs[0];
  assert.equal(job.surface, "feed");
  assert.equal(job.kind, "image");
  const jpeg = Buffer.from(job.frames[0], "base64");
  assert.deepEqual([jpeg[0], jpeg[1]], [0xff, 0xd8], "a JPEG frame");
  assert.ok(p.d.categories.includes("minor_risk"));
  // a claimed job isn't handed out twice
  assert.deepEqual((await call("POST", "/api/pepe/imagesafety/pull", null, { password: "bot", wait: 0 })).d.jobs, []);
  const v = await call("POST", "/api/pepe/imagesafety/verdict", null, { password: "bot", id: job.id, verdict: EXPLICIT, model: "glm-5.3-flash", cost: 0.0002 });
  assert.equal(v.status, 200);
  assert.equal(v.d.waiting, true);
  const r = await pending;
  assert.deepEqual([r.ok, r.nsfw], [true, true]);
  const row = (await logRows()).pop();
  assert.deepEqual([row.model, row.action], ["glm-5.3-flash", "nsfw"]);
  // the same picture again: classified once (the cache), no new job
  const again = await ISF.check({ surface: "feed", kind: "image", buf: await png(50, 40), roomId: PLANT, userId: U.alice.userId, padAllowsNsfw: true });
  assert.deepEqual([again.ok, again.nsfw], [true, true]);
  assert.equal(ISF.queueStats().queued, 0);
});

// ───────────────────────── the wiring ─────────────────────────
test("install(): pad avatars / banners, feed posts, stories and DM pictures go through the module", async () => {
  const hooks = {};
  const origUS = US.setSafetyCheck, origDM = DM.setSafetyCheck;
  US.setSafetyCheck = (fn) => { hooks.story = fn; };
  DM.setSafetyCheck = (fn) => { hooks.dm = fn; };
  try { ISF.install(); } finally { US.setSafetyCheck = origUS; DM.setSafetyCheck = origDM; }
  await setCfg({ enabled: true });
  // pad look (padlook.setImage -> the hook): explicit refused, clean stored
  ANSWER = EXPLICIT;
  await assert.rejects(PL.setImage(PLANT, "avatar", await png(300, 300, { r: 1, g: 2, b: 3 }), { userId: U.owner.userId, actor: "plantowner" }),
    (e) => e.status === 422 && /safe for work/.test(e.message));
  assert.equal(PL.look(PLANT).avatar, null, "nothing stored");
  ANSWER = CLEAN;
  await PL.setImage(PLANT, "avatar", await png(300, 300, { r: 9, g: 9, b: 9 }), { userId: U.owner.userId, actor: "plantowner" });
  assert.ok(PL.look(PLANT).avatar, "a clean avatar is stored");
  // feed posts (feedstore.create): explicit in a pad that allows NSFW -> posted, marked NSFW; a pad that says no -> refused
  const fm = require(path.join(repo, "feedmedia"));
  const mkAtt = async (id) => {
    const file = id.slice(0, 32).padEnd(32, "0").replace(/[^a-f0-9]/g, "a") + ".webp";
    const p = fm.filePath(file);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, await sharp(await png(64 + id.length, 64)).webp().toBuffer());
    await runQuery(`INSERT INTO feed_attachments (id, owner_id, kind, ct, file, w, h, bytes, state, created, size_declared, received)
                    VALUES (?, ?, 'image', 'image/webp', ?, 64, 64, 10, 'ready', ?, 10, 10)`, [id, U.alice.userId, file, Date.now()]);
    return id;
  };
  ANSWER = EXPLICIT;
  const a1 = await mkAtt("a".repeat(24));
  const post = await store.create(U.alice.userId, { body: "beach day", attachments: [a1], community: PLANT });
  assert.equal((await getQuery("SELECT nsfw FROM feed_posts WHERE id = ?", [post.id]))[0].nsfw, 1, "auto-marked NSFW");
  await store.roomMod(U.owner, PLANT, "settings", { settings: { allow_nsfw: false } });
  assert.equal((await store.roomSettings(PLANT)).allow_nsfw, false);
  const a2 = await mkAtt("b".repeat(24));
  await assert.rejects(store.create(U.alice.userId, { body: "again", attachments: [a2], community: PLANT }), (e) => e.status === 422 && /NSFW/.test(e.message));
  assert.equal((await getQuery("SELECT post_id FROM feed_attachments WHERE id = ?", [a2]))[0].post_id, null, "the file isn't used");
  ANSWER = MINOR;
  const a3 = await mkAtt("c".repeat(24));
  await assert.rejects(store.create(U.alice.userId, { body: "x", attachments: [a3], community: PLANT }), (e) => e.status === 422 && /under 18/.test(e.message));
  // AI generations are left to aigen's own post-check
  CALLS = 0;
  const a4 = await mkAtt("d".repeat(24));
  await runQuery("UPDATE feed_attachments SET ai_generated = 1 WHERE id = ?", [a4]);
  await store.roomMod(U.owner, PLANT, "settings", { settings: { allow_nsfw: true } });
  await store.create(U.alice.userId, { body: "ai", attachments: [a4], community: PLANT });
  assert.equal(CALLS, 0, "AI picture not re-checked");
  // stories + DMs: the installed hooks
  const pic = path.join(tmp, "story.webp");
  fs.writeFileSync(pic, await sharp(await png(55, 77)).webp().toBuffer());
  ANSWER = EXPLICIT;
  assert.deepEqual(await hooks.story({ file: pic, kind: "image", roomId: PLANT, userId: U.alice.userId }), { ok: true, nsfw: true });
  ANSWER = MINOR;
  assert.equal((await hooks.story({ file: pic, kind: "image", roomId: PLANT, userId: U.alice.userId })).ok, false);
  ANSWER = EXPLICIT;
  const pic2 = path.join(tmp, "dm.webp");
  fs.writeFileSync(pic2, await sharp(await png(56, 78)).webp().toBuffer());
  assert.deepEqual(await hooks.dm({ file: pic2, userId: U.alice.userId, ref: "dm:x" }), { ok: true, nsfw: true });
  // switched off again: every hook is a pass-through and nothing is queued
  await setCfg({ enabled: false, shadow: false });
  ISF.setClassifier(null);
  ANSWER = MINOR;
  assert.deepEqual(await hooks.story({ file: pic, kind: "image", roomId: PLANT, userId: U.alice.userId }), { ok: true, nsfw: false });
  const a5 = await mkAtt("e".repeat(24));
  await store.create(U.alice.userId, { body: "off", attachments: [a5], community: PLANT });
  assert.equal(ISF.queueStats().queued, 0, "nothing queued while off");
});

// ───────────────────────── the admin review page ─────────────────────────
test("review page: admins only (not Staff, members or anonymous); thumbnails access-checked; settings + marks admin-only", async () => {
  await setCfg({ enabled: true });
  ANSWER = EXPLICIT;
  await ISF.check({ surface: "pad_look", kind: "image", buf: await png(61, 61), roomId: PLANT, userId: U.owner.userId });
  const row = (await logRows()).pop();
  assert.ok(row.thumb);
  // the page
  let r = await call("GET", "/admin/imagesafety", null);
  assert.deepEqual([r.status, r.location], [302, "/login"]);
  for (const who of [U.alice, U.staff]) {
    r = await call("GET", "/admin/imagesafety", who);
    assert.equal(r.status, 403, who.username);
    assert.doesNotMatch(r.text || "", /isf-row/);
  }
  r = await call("GET", "/admin/imagesafety", U.admin);
  assert.equal(r.status, 200);
  assert.match(r.text, /Image safety/);
  assert.match(r.text, /image_safety_enabled/);
  assert.match(r.text, new RegExp(`data-id="${row.id}"`));
  assert.match(r.text, new RegExp(`/admin/imagesafety/thumb/${row.id}`));
  assert.match(r.text, /aria-current="page"/, "in the admin shell");
  // the thumbnail
  for (const who of [null, U.alice, U.staff]) {
    const t = await fetch(base + "/admin/imagesafety/thumb/" + row.id, { headers: who ? { "x-test-user": who.userId } : {} });
    assert.equal(t.status, 404, "thumb hidden from " + (who ? who.username : "anon"));
  }
  const t = await fetch(base + "/admin/imagesafety/thumb/" + row.id, { headers: { "x-test-user": U.admin.userId } });
  assert.equal(t.status, 200);
  assert.equal(t.headers.get("content-type"), "image/webp");
  assert.match(t.headers.get("cache-control"), /no-store/);
  assert.equal(t.headers.get("x-content-type-options"), "nosniff");
  assert.equal(t.headers.get("cross-origin-resource-policy"), "same-origin");
  // settings + review marks
  for (const who of [null, U.alice, U.staff]) {
    assert.equal((await call("POST", "/api/admin/imagesafety/settings", who, { settings: { image_safety_enabled: false } })).status, 403);
    assert.equal((await call("POST", "/api/admin/imagesafety/review/" + row.id, who, { mark: "fp" })).status, 403);
    assert.equal((await call("GET", "/api/admin/imagesafety/recent", who)).status, 403);
  }
  assert.equal((await call("POST", "/api/admin/imagesafety/settings", U.admin, { settings: { image_safety_shadow: true } }, { "x-requested-with": "nope" })).status, 403, "fetch header required");
  r = await call("POST", "/api/admin/imagesafety/settings", U.admin, { settings: { image_safety_shadow: true, image_safety_fail_mode: "closed" } });
  assert.equal(r.status, 200);
  assert.deepEqual([r.d.settings.image_safety_shadow, r.d.settings.image_safety_fail_mode, r.d.settings.image_safety_enabled], [true, "closed", true]);
  r = await call("POST", "/api/admin/imagesafety/review/" + row.id, U.admin, { mark: "fp", note: "it's a plant" });
  assert.equal(r.status, 200);
  assert.deepEqual([r.d.row.review, r.d.row.reviewedBy], ["fp", "boss"]);
  assert.equal((await call("POST", "/api/admin/imagesafety/review/" + row.id, U.admin, { mark: "bogus" })).status, 400);
  r = await call("GET", "/api/admin/imagesafety/recent?f=flagged", U.admin);
  assert.equal(r.status, 200);
  // retention: old checks and their thumbnails go
  await runQuery("UPDATE image_safety_log SET at = ? WHERE id = ?", [Date.now() - 400 * 86400e3, row.id]);
  const p = ISF.thumbPath(row.thumb);
  assert.ok(await ISF.sweep() >= 1);
  assert.equal(fs.existsSync(p), false);
  await setCfg({ enabled: false, shadow: false });
});

test("the pad settings page has the Allow NSFW switch; the admin nav links the page", () => {
  const rd = (p) => fs.readFileSync(path.join(repo, p), "utf8").replace(/\r\n/g, "\n");
  assert.match(rd("views/padSettings.ejs"), /name="allow_nsfw"/);
  assert.match(rd("public/js/feed-roommod.js"), /allow_nsfw/);
  assert.match(rd("views/partials/admin-nav.ejs"), /\/admin\/imagesafety/);
  // the profile photo upload (multer + S3, not run here) calls the check before anything is uploaded
  const uc = rd("user.controller.js");
  assert.match(uc, /require\('\.\/imagesafety'\)\.check\(\{ surface: 'profile_photo'/);
  assert.ok(uc.indexOf("surface: 'profile_photo'") < uc.indexOf("s3.upload("), "checked before the S3 upload");
  assert.equal(store.ROOM_DEFAULTS.allow_nsfw, true, "pads allow NSFW by default (as before)");
});
