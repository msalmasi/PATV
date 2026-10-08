// Offline tests for 1.99ez: members' own stories (userstories.js - upload limits, the safety hook, the pad's posting
// rules and bans, 24 h expiry, delete rights), "captures of me" in a member's profile story (the setting, privacy
// exclusions, hide) and the cam clip request API (camclip.js + the bridge job hand-off).
//   NODE_PATH=<repo>/node_modules node --test test/user-stories.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "user-stories-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
process.env.CAMCLIP_DIR = path.join(tmp, "camclips");
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
const camclip = require(path.join(repo, "camclip"));
const relay = require(path.join(repo, "bridge-relay"));
const layout = require(path.join(repo, "profilelayout"));
const media = require(path.join(repo, "media"));

const ROOM = "plant_based_chatting", SLUG = "plant-based-chatting";
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

let seq = 0;
/** A capture row (Pepe's cam capture unless source is given) with its file on disk. */
async function capture(opts = {}) {
  const { room = ROOM, subject = "Sub By", subjectLogin = "subjcf", by = "capcf", kind = "photo", anon = 0, ageMin = 5, hours = 24, source = null, slot = null } = opts;
  const id = "cafe" + String(++seq).padStart(8, "0");
  const t = Date.now() - ageMin * 60e3;
  const ext = kind === "photo" ? "jpg" : "mp4";
  await runQuery(`INSERT INTO media (id, kind, ct, file, bytes, secs, subject, by_user, room, created, expires, deleted, anon, source, subject_login, slot_id)
                  VALUES (?, ?, ?, ?, 10, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
                 [id, kind, kind === "photo" ? "image/jpeg" : "video/mp4", id + "." + ext, kind === "photo" ? 0 : 7, subject, by, room, t, t + hours * 3600e3,
                  anon, source, subjectLogin, slot]);
  fs.writeFileSync(path.join(process.env.MEDIA_DIR, id + "." + ext), kind === "photo" ? jpg : Buffer.from("fake-mp4-bytes"));
  return id;
}
/** A finished story upload (what /api/feed/uploads + processing leave behind), owned by `u`. */
let aseq = 0;
async function upload(u, { kind = "image", secs = 0, purpose = "story", state = "ready" } = {}) {
  const id = (++aseq).toString(16).padStart(24, "a");
  const base_ = require("crypto").randomBytes(16).toString("hex");
  const file = base_ + (kind === "image" ? ".webp" : ".mp4");
  const sub = path.join(fmedia.dir(), base_.slice(0, 2));
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, file), kind === "image" ? await sharp(jpg).webp().toBuffer() : Buffer.from("fake-mp4"));
  let poster = null;
  if (kind === "video") { poster = base_ + "_p.webp"; fs.writeFileSync(path.join(sub, poster), await sharp(jpg).webp().toBuffer()); }
  await runQuery(`INSERT INTO feed_attachments (id, owner_id, kind, ct, file, thumb, poster, w, h, secs, bytes, state, created, size_declared, received, purpose)
                  VALUES (?, ?, ?, ?, ?, NULL, ?, 16, 12, ?, 100, ?, ?, 100, 100, ?)`,
                 [id, u.userId, kind, kind === "image" ? "image/webp" : "video/mp4", file, poster, secs, state, Date.now(), purpose]);
  return id;
}
const gapsReset = () => { for (const k of Object.keys(U)) { /* noop */ } };

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
  U.subj = await mkUser("subby", { camfrog: "subjcf", display: "Sub By" });
  U.poster = await mkUser("poster", { camfrog: "postercf", display: "Post Er" });
  U.stranger = await mkUser("stranger", { camfrog: "strangercf" });
  U.mod = await mkUser("moddy", { camfrog: "modcf" });
  U.shy = await mkUser("shy", { camfrog: "shycf" });
  U.unlinked = await mkUser("nolink");
  U.streamer = await mkUser("streamer", { camfrog: "streamcf" });
  U.follower = await mkUser("follower", { camfrog: "followcf" });
  await rooms.init();
  await rooms.setOwner(ROOM, "plantowner", "test");
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0 }, "test");
  await keep.init();
  await US.init();
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
  US.register(app, { addUser });
  media.register(app, { addUser, isBotToken: (t) => t === "bot", noTimers: true });
  // the cam clip API against a fake bridged room
  const live = { id: ROOM, slug: SLUG, cams: true, members: [
    { login: "subjcf", on_cam: true }, { login: "shycf", on_cam: true }, { login: "offcam", on_cam: false },
    { login: "hiddencf", on_cam: true, anon: true }, { login: "pepebeta", on_cam: true, self: true }] };
  camclip.register(app, { addUser, isBotToken: (t) => t === "bot", bySlug: (s) => (s === SLUG ? live : null), isLive: () => true });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });
test.beforeEach(() => { store._gaps.clear(); US._setClock(() => Date.now()); stories._setClock(() => Date.now()); void gapsReset; });

// ───────────────────────────── 1. your own story ─────────────────────────────
test("story upload limits: audio refused, size caps smaller than posts, the 30 s cap at processing", async () => {
  let r = await post("/api/feed/uploads", U.poster, { kind: "audio", size: 1000, purpose: "story" });
  assert.equal(r.status, 400, "no audio stories");
  r = await post("/api/feed/uploads", U.poster, { kind: "video", size: 61 * 1024 * 1024, purpose: "story" });
  assert.equal(r.status, 413, "story video cap (60 MB) - a post may be 100 MB");
  r = await post("/api/feed/uploads", U.poster, { kind: "image", size: 11 * 1024 * 1024, purpose: "story" });
  assert.equal(r.status, 413);
  r = await post("/api/feed/uploads", U.poster, { kind: "video", size: 61 * 1024 * 1024 });
  assert.equal(r.status, 200, "the same file as a post upload is fine");
  r = await post("/api/feed/uploads", U.poster, { kind: "image", size: 2000, purpose: "story" });
  assert.equal(r.status, 200);
  const a = (await getQuery("SELECT purpose FROM feed_attachments WHERE id = ?", [r.d.id]))[0];
  assert.equal(a.purpose, "story", "the upload is marked as a story upload");
  // the processing cap: a story upload is converted with max_video_secs = 30
  assert.equal(US.STORY_MAX_SECS, 30);
  const src = fs.readFileSync(path.join(repo, "feedweb.js"), "utf8");
  assert.match(src, /a\.purpose === "story"[\s\S]{0,200}max_video_secs: Math\.min\(C\.max_video_secs, require\("\.\/userstories"\)\.STORY_MAX_SECS\)/);
});

test("create: a picture to a pad and a video to my profile; credited to me; 24 h; a video over 30 s or a post upload is refused", async () => {
  const img = await upload(U.poster);
  let r = await post("/api/stories/mine", U.poster, { attachment: img, pad: ROOM });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const m = (await getQuery("SELECT * FROM media WHERE id = ?", [r.d.story.id]))[0];
  assert.equal(m.source, "user"); assert.equal(m.by_user_id, U.poster.userId); assert.equal(m.by_user, "Post Er"); assert.equal(m.room, ROOM);
  assert.equal(m.kind, "photo"); assert.equal(m.ct, "image/webp");
  assert.ok(Math.abs(m.expires - m.created - 24 * 3600e3) < 1000, "24 hours");
  assert.ok(fs.existsSync(path.join(process.env.MEDIA_DIR, m.file)), "moved into the captures directory");
  const att = (await getQuery("SELECT state FROM feed_attachments WHERE id = ?", [img]))[0];
  assert.equal(att.state, "deleted", "the upload is consumed");
  r = await post("/api/stories/mine", U.poster, { attachment: img, pad: ROOM });
  assert.equal(r.status, 409, "an upload makes one story");
  // in the pad's strip, credited to the uploader, viewer-annotated (uploader can delete, nobody can post / save it)
  const caps = await stories.captures(ROOM, 50, { windowMs: stories.WINDOW_MS });
  const c = caps.find((x) => x.id === m.id);
  assert.ok(c && c.source === "user" && c.by === "Post Er" && c.subject === null);
  const fv = await stories.forViewer(U.poster);
  const pad = fv.find((x) => x.id === ROOM);
  const it = pad.items.find((x) => x.id === m.id);
  assert.equal(it.can.del, true); assert.equal(it.can.post, false); assert.equal(it.can.save, false); assert.equal(it.mine, true);
  const fvS = await stories.forViewer(U.stranger);
  assert.equal(fvS.find((x) => x.id === ROOM).items.find((x) => x.id === m.id).can.del, false);
  // video to my profile (30 s ok, 45 s refused)
  US._setClock(() => Date.now() + 11e3);
  const long = await upload(U.poster, { kind: "video", secs: 45 });
  r = await post("/api/stories/mine", U.poster, { attachment: long, pad: "profile" });
  assert.equal(r.status, 400); assert.match(r.d.error, /30 s/);
  const vid = await upload(U.poster, { kind: "video", secs: 29.6 });
  r = await post("/api/stories/mine", U.poster, { attachment: vid, pad: "u/poster", nsfw: true });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const v = (await getQuery("SELECT * FROM media WHERE id = ?", [r.d.story.id]))[0];
  assert.equal(v.room, "user:" + U.poster.userId); assert.equal(v.kind, "clip"); assert.equal(v.nsfw, 1);
  assert.ok(media.hasPoster(v), "the poster frame came along");
  const notStory = await upload(U.poster, { purpose: null });
  US._setClock(() => Date.now() + 22e3);
  r = await post("/api/stories/mine", U.poster, { attachment: notStory, pad: ROOM });
  assert.equal(r.status, 400, "a post upload can't be a story");
  // someone else's upload
  const theirs = await upload(U.stranger);
  r = await post("/api/stories/mine", U.poster, { attachment: theirs, pad: ROOM });
  assert.equal(r.status, 404);
});

test("the safety hook: a refusal stops it, an NSFW verdict marks it NSFW", async () => {
  US._setClock(() => Date.now() + 60e3);
  US.setSafetyCheck(async () => ({ ok: false, reason: "Nope." }));
  const a = await upload(U.stranger);
  let r = await post("/api/stories/mine", U.stranger, { attachment: a, pad: ROOM });
  assert.equal(r.status, 422); assert.equal(r.d.error, "Nope.");
  assert.equal((await getQuery("SELECT state FROM feed_attachments WHERE id = ?", [a]))[0].state, "ready", "nothing was used up");
  US.setSafetyCheck(async ({ kind, file }) => { assert.equal(kind, "image"); assert.ok(fs.existsSync(file)); return { ok: true, nsfw: true }; });
  r = await post("/api/stories/mine", U.stranger, { attachment: a, pad: ROOM });
  assert.equal(r.status, 200);
  assert.equal((await getQuery("SELECT nsfw FROM media WHERE id = ?", [r.d.story.id]))[0].nsfw, 1);
  US.setSafetyCheck(null);
});

test("pad posting rules: feed ban, approved posters, approval queue, someone else's profile; rate limits", async () => {
  US._setClock(() => Date.now() + 120e3);
  await store.ban(U.admin, "shy", { room: ROOM, reason: "test" });
  let r = await post("/api/stories/mine", U.shy, { attachment: await upload(U.shy), pad: ROOM });
  assert.equal(r.status, 403, "banned from the pad");
  r = await post("/api/stories/mine", U.shy, { attachment: await upload(U.shy), pad: "profile" });
  assert.equal(r.status, 200, "their own profile is still theirs");
  await store.unban(U.admin, U.shy.userId, ROOM);
  await store.kvSet("room:" + ROOM, JSON.stringify({ who: "approved" }));
  r = await post("/api/stories/mine", U.follower, { attachment: await upload(U.follower), pad: ROOM });
  assert.equal(r.status, 403, "approved posters only");
  await store.kvSet("room:" + ROOM, JSON.stringify({ who: "everyone", approval: true }));
  r = await post("/api/stories/mine", U.follower, { attachment: await upload(U.follower), pad: ROOM });
  assert.equal(r.status, 403); assert.match(r.d.error, /approves posts first/);
  r = await post("/api/stories/mine", U.owner, { attachment: await upload(U.owner), pad: ROOM });
  assert.equal(r.status, 200, "the pad's owner may");
  // targets(): the approval pad isn't offered to a member, "Your profile" first
  const t = await get("/api/stories/targets", U.follower);
  assert.equal(t.d.pads[0].id, "u/follower");
  assert.ok(!t.d.pads.some((p) => p.id === ROOM));
  await store.kvSet("room:" + ROOM, JSON.stringify({}));
  r = await post("/api/stories/mine", U.follower, { attachment: await upload(U.follower), pad: "u/subby" });
  assert.equal(r.status, 403, "not someone else's profile");
  // the gap between stories
  US._setClock(() => Date.now() + 200e3);
  r = await post("/api/stories/mine", U.follower, { attachment: await upload(U.follower), pad: ROOM });
  assert.equal(r.status, 200);
  r = await post("/api/stories/mine", U.follower, { attachment: await upload(U.follower), pad: ROOM });
  assert.equal(r.status, 429);
  assert.equal((await post("/api/stories/mine", null, {})).status, 401);
  // signed-out targets
  assert.equal((await get("/api/stories/targets", null)).status, 401);
});

test("24 h expiry: a story leaves the strips, the person story and its page once it's over", async () => {
  US._setClock(() => Date.now() + 300e3);
  const a = await upload(U.streamer);
  const r = await post("/api/stories/mine", U.streamer, { attachment: a, pad: "profile" });
  assert.equal(r.status, 200);
  let st = await US.personStory(U.follower, U.streamer.userId);
  assert.ok(st && st.items.some((x) => x.id === r.d.story.id), "in their person story");
  const later = Date.now() + 25 * 3600e3;
  US._setClock(() => later); stories._setClock(() => later);
  st = await US.personStory(U.follower, U.streamer.userId);
  assert.ok(!st || !st.items.some((x) => x.id === r.d.story.id), "gone after 24 h");
  const fv = await stories.forViewer(U.follower);
  assert.ok(!fv.some((x) => (x.items || []).some((i) => i.id === r.d.story.id)));
});

test("delete: the uploader, the pad owner, a pad mod and staff may; a stranger may not", async () => {
  US._setClock(() => Date.now() + 400e3);
  const ids = [];
  for (const who of [U.poster, U.subj, U.follower, U.stranger]) {
    US._setClock(() => Date.now() + 400e3 + ids.length * 20e3);
    const r = await post("/api/stories/mine", who, { attachment: await upload(who), pad: ROOM });
    assert.equal(r.status, 200, JSON.stringify(r.d));
    ids.push(r.d.story.id);
  }
  assert.equal((await post(`/api/stories/${ids[0]}/delete`, U.stranger)).status, 403);
  assert.equal((await post(`/api/stories/${ids[0]}/delete`, U.poster)).status, 200, "the uploader");
  assert.equal((await post(`/api/stories/${ids[1]}/delete`, U.owner)).status, 200, "the pad's owner");
  assert.equal((await post(`/api/stories/${ids[2]}/delete`, U.mod)).status, 200, "a pad mod");
  assert.equal((await post(`/api/stories/${ids[3]}/delete`, U.admin)).status, 200, "staff");
  for (const id of ids) assert.equal((await getQuery("SELECT deleted FROM media WHERE id = ?", [id]))[0].deleted, 1);
  // a member's own story can't be 📌 posted or 🔖 saved by anyone else
  const r = await post("/api/stories/mine", U.shy, { attachment: await upload(U.shy), pad: ROOM }).catch(() => null);
  if (r && r.status === 200) {
    assert.equal((await post(`/api/stories/${r.d.story.id}/save`, U.stranger)).status, 403);
    assert.equal((await post(`/api/stories/${r.d.story.id}/post`, U.owner)).status, 403);
  }
});

// ───────────────────────────── 2. captures of me ─────────────────────────────
test("captures of me: cam captures by subject_login (and old rows by name) + stage captures of my slot, the setting, hide", async () => {
  const c1 = await capture({ subjectLogin: "subjcf" });
  const c2 = await capture({ subject: "subjcf", subjectLogin: null, kind: "clip" });       // an older row: no subject_login
  const other = await capture({ subject: "Someone", subjectLogin: "strangercf" });
  // a stage capture of a slot subby streamed
  await require(path.join(repo, "mainstage")).getSlot("x");
  await runQuery("INSERT INTO stage_slots (id, userId, username, status, created, max_minutes, price_per_min, held, stream) VALUES ('slot1', ?, 'subby', 'ended', ?, 30, 0, 0, 'slot1')",
                 [U.subj.userId, Date.now()]);
  const st1 = await capture({ source: "stage", slot: "slot1", subject: "Sub By", subjectLogin: null });
  let st = await US.personStory(U.follower, U.subj.userId);
  const ids = st.items.map((x) => x.id);
  assert.ok(ids.includes(c1) && ids.includes(c2) && ids.includes(st1), "cam (login + old name match) and stage captures");
  assert.ok(!ids.includes(other));
  assert.equal(st.id, "user:" + U.subj.userId); assert.equal(st.href, "/u/subby"); assert.equal(st.person, true);
  assert.ok(st.items.find((x) => x.id === c1).where.title, "says which pad it's from");
  assert.ok(!st.items.find((x) => x.id === c1).hideable, "only the subject may hide");
  // the subject sees Hide; hiding takes it out of their story, NOT out of the pad's
  const mine = await US.personStory(U.subj, U.subj.userId);
  assert.equal(mine.items.find((x) => x.id === c1).hideable, true);
  assert.equal((await post(`/api/stories/${c1}/hide`, U.stranger)).status, 403, "only the person in it");
  assert.equal((await post(`/api/stories/${c1}/hide`, U.subj)).status, 200);
  st = await US.personStory(U.follower, U.subj.userId);
  assert.ok(!st.items.some((x) => x.id === c1), "hidden from their story");
  assert.ok((await stories.captures(ROOM, 100)).some((x) => x.id === c1), "still in the pad's story");
  assert.equal((await getQuery("SELECT deleted FROM media WHERE id = ?", [c1]))[0].deleted, 0, "not deleted");
  // the setting off: no captures (their own uploads would still show)
  assert.equal((await post("/api/stories/prefs", U.subj, { capturesOfMe: false })).status, 200);
  assert.equal((await US.prefs(U.subj.userId)).capturesOfMe, false);
  st = await US.personStory(U.follower, U.subj.userId);
  assert.equal(st, null, "nothing left: the setting is off");
  US._setClock(() => Date.now() + 900e3);
  const r = await post("/api/stories/mine", U.subj, { attachment: await upload(U.subj), pad: "profile" });
  st = await US.personStory(U.follower, U.subj.userId);
  assert.deepEqual(st.items.map((x) => x.id), [r.d.story.id], "only their own upload");
  await post("/api/stories/prefs", U.subj, { capturesOfMe: true });
  st = await US.personStory(U.follower, U.subj.userId);
  assert.ok(st.items.some((x) => x.id === c2), "back on");
});

test("captures of me: privacy - anon (incognito / bridge-hidden) captures and members who keep activity private never show", async () => {
  const anon = await capture({ subject: "", subjectLogin: "shycf", anon: 1 });
  const ok = await capture({ subject: "shy", subjectLogin: "shycf" });
  let st = await US.personStory(U.follower, U.shy.userId);
  assert.ok(st && st.items.some((x) => x.id === ok));
  assert.ok(!st.items.some((x) => x.id === anon), "an anon capture never");
  await layout.save(U.shy.userId, { hidden: ["analytics"] });
  st = await US.personStory(U.follower, U.shy.userId);
  assert.ok(!st || !st.items.some((x) => x.id === ok), "private account: no captures in their story");
  await layout.save(U.shy.userId, { hidden: [] });
});

test("person story rings: profile page, Following (people I follow first), homepage strip for profile uploaders", async () => {
  const fol = require(path.join(repo, "follows"));
  await fol.follow(U.follower, "user", U.subj.userId, true);
  const fv = await stories.forViewer(U.follower, { people: [U.subj.userId] });
  assert.equal(fv[0].id, "user:" + U.subj.userId, "a followed person leads the Following strip");
  const home = await stories.forViewer(U.follower);
  assert.ok(home.some((x) => x.id === "user:" + U.subj.userId), "a member with a profile upload gets a circle");
  assert.ok(!home.some((x) => x.id === "user:" + U.follower.userId), "nothing for an empty story");
  // signed out: the circle without items
  const out = await stories.forViewer(null);
  const p = out.find((x) => x.id === "user:" + U.subj.userId);
  assert.ok(p && !p.items && p.cover === null);
  // the person story API
  const r = await get("/api/stories/person/subby", U.follower);
  assert.equal(r.status, 200); assert.equal(r.d.rooms[0].id, "user:" + U.subj.userId);
  assert.equal((await get("/api/stories/person/subby", null)).status, 401);
  // seen state is shared with the circle id
  const latest = r.d.rooms[0].latest;
  stories._setClock(() => Date.now() + 1000e3);           // the uploads above ran on a clock ahead of real time
  const s = await post("/api/stories/seen", U.follower, { room: "user:" + U.subj.userId, upto: latest });
  assert.equal(s.status, 200);
  assert.equal((await US.personStory(U.follower, U.subj.userId)).unseen, false);
  // the strip partial renders the "＋ Your story" circle and person circles
  const ejs = require("ejs");
  const html = await ejs.renderFile(path.join(repo, "views/partials/story-strip.ejs"), { story: { rooms: [r.d.rooms[0]], caps: [], room: null, signed: true, compose: true, pad: "profile" }, heading: "x", next: "/" });
  assert.match(html, /data-story-compose data-pad="profile"/);
  assert.match(html, /story-compose\.js\?v=1/);
  assert.match(html, /data-story-room="user:u_subby"/);
  const html2 = await ejs.renderFile(path.join(repo, "views/partials/story-strip.ejs"), { story: { rooms: [], caps: [], room: null, signed: false, compose: true }, heading: "x", next: "/" });
  assert.doesNotMatch(html2, /data-story-compose/, "signed out: no compose circle");
});

// ───────────────────────────── 3. cam clips ─────────────────────────────
test("cam clip request API: rules, one clip per cam, the bridge job, preview, save, Pepe's fetch", async () => {
  const queued = [];
  let sw = true, csw = true;
  const priv = new Set(["shycf"]);
  camclip._setDeps({ snapSwitch: () => sw, clipSwitch: () => csw, privateLogins: async (l) => new Set(l.filter((x) => priv.has(x))),
                     queueAction: async (uid, a) => { queued.push({ uid, a }); return 4242; } });
  await runQuery("INSERT INTO pepe_actions (id, user_id, kind, status, message) VALUES (4242, ?, 'camclip.save', 'pending', '')", [U.poster.userId]);
  const url = `/api/rooms/${SLUG}/camclip`;
  assert.equal((await post(url, null, { login: "subjcf" })).status, 401);
  assert.equal((await post(url, U.unlinked, { login: "subjcf" })).status, 403, "a linked Camfrog name is needed");
  assert.equal((await post(url, U.poster, { login: "offcam" })).status, 400, "not on cam");
  assert.equal((await post(url, U.poster, { login: "hiddencf" })).status, 400, "bridge-hidden: not even listed as clippable");
  assert.equal((await post(url, U.poster, { login: "pepebeta" })).status, 400, "not Pepe's own cam");
  assert.equal((await post(url, U.poster, { login: "shycf" })).status, 403, "private accounts can't be clipped");
  sw = false;
  let r = await post(url, U.poster, { login: "subjcf" });
  assert.equal(r.status, 403); assert.match(r.d.error, /!snap on/);
  sw = true;
  // 1.99fa: the room's !clip switch - off or unknown refuses the request (E_FEATURE_OFF)
  for (const v of [false, null]) {
    csw = v;
    r = await post(url, U.poster, { login: "subjcf" });
    assert.equal(r.status, 403, `!clip ${v}`); assert.match(r.d.error, /\(!clip\)/); assert.equal(r.d.code, "E_FEATURE_OFF");
  }
  csw = true;
  const noXrw = await fetch(base + url, { method: "POST", headers: { "x-test-user": U.poster.userId, "content-type": "application/json" }, body: JSON.stringify({ login: "subjcf" }) });
  assert.equal(noXrw.status, 400);
  r = await post(url, U.poster, { login: "subjcf", secs: 30 });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const id = r.d.id;
  assert.equal(r.d.secs, 30);
  r = await post(url, U.stranger, { login: "subjcf", secs: 10 });
  assert.equal(r.status, 409, "one clip per cam at a time");
  // the job reaches Pepe once (no re-offer), with the target and the length
  let jobs = relay.takeJobs(new Set([ROOM]));
  const j = jobs.find((x) => x.id === id);
  assert.ok(j); assert.equal(j.kind, "camclip"); assert.equal(j.target, "subjcf"); assert.equal(j.secs, 30); assert.equal(j.camfrog, "postercf");
  relay._jobs.get(id).claimed = Date.now() - 10 * 60e3;
  jobs = relay.takeJobs(new Set([ROOM]));
  assert.ok(!jobs.some((x) => x.id === id), "never offered twice");
  // progress, then the preview (bot token only)
  assert.equal((await post("/api/bridge/camclip", null, { id, state: "recording" })).status, 403);
  assert.equal((await post("/api/bridge/camclip", null, { password: "bot", id, state: "recording" })).status, 200);
  assert.equal((await get(`${url}/${id}`, U.poster)).d.state, "recording");
  assert.equal((await get(`${url}/${id}`, U.stranger)).status, 404, "only the requester sees it");
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(200)]);
  r = await post("/api/bridge/camclip", null, { password: "bot", id, state: "ok", data: mp4.toString("base64"), poster: jpg.toString("base64"), secs: 30,
                                                save: "on", viewer_ok: true, cost: 50000 });
  assert.equal(r.status, 200);
  r = await get(`${url}/${id}`, U.poster);
  assert.equal(r.d.state, "ready"); assert.deepEqual(r.d.save, { cost: 50000, id: null }); assert.ok(r.d.video && r.d.poster);
  const v = await fetch(base + r.d.video, { headers: { "x-test-user": U.poster.userId, range: "bytes=0-9" } });
  assert.equal(v.status, 206, "Range-aware preview (phones)");
  assert.equal((await fetch(base + r.d.video, { headers: { "x-test-user": U.stranger.userId } })).status, 404);
  // Pepe can't fetch it before it's being saved
  assert.equal((await post("/api/bridge/camclipdata", null, { password: "bot", id, user: "poster" })).status, 404);
  csw = false;
  r = await post(`${url}/${id}/save`, U.poster);
  assert.equal(r.status, 403, "!clip off: no save either"); assert.equal(r.d.code, "E_FEATURE_OFF"); assert.equal(queued.length, 0);
  csw = true;
  r = await post(`${url}/${id}/save`, U.poster);
  assert.equal(r.status, 200); assert.equal(r.d.id, 4242);
  assert.equal(queued[0].a.kind, "camclip.save"); assert.deepEqual(queued[0].a.args, [ROOM, "subjcf", id]);
  r = await post(`${url}/${id}/save`, U.poster);
  assert.equal(r.d.again, true, "one save per clip"); assert.equal(queued.length, 1);
  assert.equal((await post("/api/bridge/camclipdata", null, { password: "bot", id, user: "stranger" })).status, 404, "checked against the account");
  r = await post("/api/bridge/camclipdata", null, { password: "bot", id, user: "poster" });
  assert.equal(r.status, 200); assert.equal(Buffer.from(r.d.data, "base64").length, mp4.length); assert.equal(r.d.target, "subjcf");
  // the cam is free again; a non-MP4 upload fails the clip
  r = await post(url, U.stranger, { login: "subjcf", secs: 10 });
  assert.equal(r.status, 200);
  await post("/api/bridge/camclip", null, { password: "bot", id: r.d.id, state: "ok", data: Buffer.from("<html>").toString("base64") });
  assert.equal((await get(`${url}/${r.d.id}`, U.stranger)).d.state, "failed");
  // a "no" save rule (opted out) -> no Save
  relay._hits.clear();
  r = await post(url, U.follower, { login: "subjcf", secs: 20 });
  assert.equal(r.status, 200);
  await post("/api/bridge/camclip", null, { password: "bot", id: r.d.id, state: "ok", data: mp4.toString("base64"), save: "no", viewer_ok: false });
  const c = await get(`${url}/${r.d.id}`, U.follower);
  assert.equal(c.d.save, null);
  assert.equal((await post(`${url}/${r.d.id}/save`, U.follower)).status, 403);
  assert.equal((await post(`${url}/${r.d.id}/discard`, U.follower)).status, 200);
  assert.equal((await get(`${url}/${r.d.id}`, U.follower)).status, 404);
  // clipInfo for the popover
  const info = await camclip.clipInfo({ id: ROOM }, U.unlinked.userId, "subjcf");
  assert.match(info.off, /Link your Camfrog name/); assert.deepEqual(info.secs, [10, 20, 30]); assert.equal(info.def, 20);
  assert.equal((await camclip.clipInfo({ id: ROOM }, U.poster.userId, "subjcf")).off, null, "both switches on: not greyed");
  csw = false;
  assert.match((await camclip.clipInfo({ id: ROOM }, U.poster.userId, "subjcf")).off, /\(!clip\)/, "!clip off: greyed with the reason (tooltip)");
  csw = null;
  assert.match((await camclip.clipInfo({ id: ROOM }, U.poster.userId, "subjcf")).off, /\(!clip\)/, "unknown !clip = off");
  csw = true;
  // Pepe's refusal code rides along to the requester's view
  relay._hits.clear();
  r = await post(url, U.follower, { login: "subjcf", secs: 10 });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  await post("/api/bridge/camclip", null, { password: "bot", id: r.d.id, state: "failed", status: "Clips are switched off in this room (!clip)", code: "E_FEATURE_OFF" });
  const fc = await get(`${url}/${r.d.id}`, U.follower);
  assert.equal(fc.d.state, "failed"); assert.equal(fc.d.code, "E_FEATURE_OFF");
  sw = null;
  assert.match((await camclip.clipInfo({ id: ROOM }, U.poster.userId, "subjcf")).off, /!snap on/, "unknown switch = off");
});

test("media upload stores the subject's login (never for an anon subject)", async () => {
  let r = await post("/api/media", null, { password: "bot", id: "abcdef0123456789", kind: "photo", ct: "image/jpeg", image: jpg.toString("base64"),
                                           subject: "Sub By", subject_login: "SubjCF", by: "x", room: ROOM });
  assert.equal(r.status, 200);
  assert.equal((await getQuery("SELECT subject_login FROM media WHERE id = 'abcdef0123456789'"))[0].subject_login, "subjcf");
  r = await post("/api/media", null, { password: "bot", id: "abcdef0123456780", kind: "photo", ct: "image/jpeg", image: jpg.toString("base64"),
                                       subject: "x", subject_login: "subjcf", anon: true, by: "x", room: ROOM });
  assert.equal((await getQuery("SELECT subject_login FROM media WHERE id = 'abcdef0123456780'"))[0].subject_login, null);
});
