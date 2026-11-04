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
  // in the pad's strip, credited to the uploader, viewer-annotated (uploader can delete, nobody can post it; 1.99fn: a
  // picture story can be saved)
  const caps = await stories.captures(ROOM, 50, { windowMs: stories.WINDOW_MS });
  const c = caps.find((x) => x.id === m.id);
  assert.ok(c && c.source === "user" && c.by === "Post Er" && c.subject === null);
  const fv = await stories.forViewer(U.poster);
  const pad = fv.find((x) => x.id === ROOM);
  const it = pad.items.find((x) => x.id === m.id);
  assert.equal(it.can.del, true); assert.equal(it.can.post, false); assert.equal(it.can.save, true); assert.equal(it.mine, true);
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
  // a member's own story can't be 📌 posted by anyone (1.99fn: a snap / clip story CAN be 🔖 saved - feed-gallery.test.js)
  const r = await post("/api/stories/mine", U.shy, { attachment: await upload(U.shy), pad: ROOM }).catch(() => null);
  if (r && r.status === 200) {
    assert.equal((await post(`/api/stories/${r.d.story.id}/save`, U.stranger)).status, 200);
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
    assert.equal(r.status, 403, `!clip ${v}`); assert.match(r.d.error, /Clips are switched off in .+ \(a mod can type !clip on there\)/); assert.equal(r.d.code, "E_FEATURE_OFF");
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
  assert.match((await camclip.clipInfo({ id: ROOM }, U.poster.userId, "subjcf")).off, /Clips are switched off in .+ \(a mod can type !clip on there\)/, "!clip off: greyed with the reason (tooltip)");
  csw = null;
  assert.match((await camclip.clipInfo({ id: ROOM }, U.poster.userId, "subjcf")).off, /Clips are switched off in .+ \(a mod can type !clip on there\)/, "unknown !clip = off");
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

// 1.99fb: admins still clip from the website while !clip is off (like chat !clip); Pepe makes the final call
test("cam clips with !clip off: site admins + Pepe room mods get through with a hint, members are refused", async () => {
  const padmod = require(path.join(repo, "padmod"));
  const queued = [];
  let csw = false;
  const R_MOD = { mod: padmod.cleanModCaps({ modcf: { actions: ["kick", "ban"], roles: ["admin"] } }) };
  camclip._setDeps({ snapSwitch: () => true, clipSwitch: () => csw, privateLogins: async () => new Set(),
                     modCaps: (R, login) => padmod.capsFor(R_MOD, login),
                     queueAction: async (uid, a) => { queued.push({ uid, a }); return 4343; } });
  const url = `/api/rooms/${SLUG}/camclip`;
  const fresh = () => { relay._hits.clear(); camclip._clips.clear(); };
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(200)]);
  const linked = new Map([[U.admin.userId, "bossfrog"], [U.mod.userId, "modcf"]]);
  for (const v of [false, null]) {
    csw = v;
    // a member: refused with E_FEATURE_OFF, the button greyed with the reason
    fresh();
    let r = await post(url, U.stranger, { login: "subjcf", secs: 10 });
    assert.equal(r.status, 403, `member, !clip ${v}`); assert.equal(r.d.code, "E_FEATURE_OFF");
    let info = await camclip.clipInfo({ id: ROOM }, U.stranger.userId, "subjcf");
    assert.match(info.off, /Clips are switched off in .+ \(a mod can type !clip on there\)/, `member greyed (!clip ${v})`); assert.equal(info.hint, undefined);
    // a site admin, and a viewer Pepe gave room-mod caps: enabled + the admin hint, the request reaches Pepe
    for (const who of [U.admin, U.mod]) {
      fresh();
      info = await camclip.clipInfo({ id: ROOM }, who.userId, "subjcf");
      assert.equal(info.off, null, `${who.username} not greyed (!clip ${v})`);
      assert.equal(info.hint, camclip.ADMIN_HINT); assert.match(info.hint, /off for members \(!clip\).*as an admin/);
      r = await post(url, who, { login: "subjcf", secs: 10 });
      assert.equal(r.status, 200, `${who.username} (!clip ${v}): ${JSON.stringify(r.d)}`);
      const j = relay.takeJobs(new Set([ROOM])).find((x) => x.id === r.d.id);
      assert.ok(j && j.kind === "camclip" && j.camfrog === linked.get(who.userId), "handed to Pepe as their linked login");
      // the save goes on to Pepe too (he re-checks)
      await post("/api/bridge/camclip", null, { password: "bot", id: r.d.id, state: "ok", data: mp4.toString("base64"), save: "on", viewer_ok: true, cost: 0 });
      const s = await post(`${url}/${r.d.id}/save`, who);
      assert.equal(s.status, 200, `${who.username} save (!clip ${v}): ${JSON.stringify(s.d)}`);
    }
  }
  assert.equal(queued.length, 4);
  // !clip on: nobody gets the hint
  csw = true;
  assert.equal((await camclip.clipInfo({ id: ROOM }, U.admin.userId, "subjcf")).hint, undefined);
  assert.equal((await camclip.clipInfo({ id: ROOM }, U.stranger.userId, "subjcf")).off, null);
  // clipAdmin: the Admin class, or Pepe's mod caps on the linked login
  assert.equal(camclip.clipAdmin({}, { class: "Admin" }), true);
  assert.equal(camclip.clipAdmin({}, { class: "pleb", camfrogUsername: "ModCF" }), true);
  assert.equal(camclip.clipAdmin({}, { class: "pleb", camfrogUsername: "strangercf" }), false);
  assert.equal(camclip.clipAdmin({}, { class: "pleb" }), false);
  assert.equal(camclip.clipAdmin({}, null), false);
  fresh();
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

// Story Studio's real chunked-upload routes; all pictures are generated for this test.
async function studioChunk(id, u, bytes) {
  const r = await fetch(base + "/api/feed/uploads/" + id + "?offset=0", {
    method: "PUT", headers: { ...H(u), "content-type": "application/octet-stream" }, body: bytes
  });
  return { status: r.status, d: await r.json() };
}
async function studioUpload(bytes, u, purpose = "story_ovl", extra = {}) {
  const started = await post("/api/feed/uploads", u, { kind: "image", size: bytes.length, purpose, ...extra });
  assert.equal(started.status, 200, JSON.stringify(started.d));
  const chunked = await studioChunk(started.d.id, u, bytes);
  assert.equal(chunked.status, 200, JSON.stringify(chunked.d));
  return started.d.id;
}
async function studioFinished(id, u) {
  const r = await post("/api/feed/uploads/" + id + "/finish", u);
  assert.equal(r.status, 200, JSON.stringify(r.d));
  for (let n = 0; n < 400; n++) {
    const row = (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [id]))[0];
    if (row.state !== "processing") return row;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Studio upload did not finish");
}

test("Studio uploads are dark; config persists and the admin checkbox exists", async () => {
  const saved = { ...store.config() };
  const u = await mkUser("studioglassfern", { camfrog: "cfstudioglassfern" });
  try {
    assert.equal(store.DEFAULTS.story_studio, false);
    await store.setConfig({ story_studio: false }, "test");
    const edit = { v: 1, pad: "profile", fit: "fit", text: [], stickers: [] };
    let r = await post("/api/feed/uploads", u, { kind: "image", size: 100, purpose: "story", edit });
    assert.equal(r.status, 423); assert.equal(r.d.error, "Story Studio isn't switched on.");
    r = await post("/api/feed/uploads", u, { kind: "image", size: 100, purpose: "story_ovl" });
    assert.equal(r.status, 423);
    r = await post("/api/feed/uploads", u, { kind: "image", size: 100, edit });
    assert.equal(r.status, 400, "an edit cannot silently become a normal post upload");
    await store.setConfig({ story_studio: true }, "test");
    assert.equal(JSON.parse((await getQuery("SELECT value FROM feed_kv WHERE key = 'config'"))[0].value).story_studio, true);
    assert.match(fs.readFileSync(path.join(repo, "views/feedAdmin.ejs"), "utf8"), /name="story_studio"/);
  } finally { await store.setConfig(saved, "test"); }
});

test("Studio overlays require PNG on the first chunk, image kind and the overlay size cap", async () => {
  const saved = { ...store.config() };
  const u = await mkUser("studioamberlattice", { camfrog: "cfstudioamberlattice" });
  try {
    await store.setConfig({ story_studio: true }, "test");
    let r = await post("/api/feed/uploads", u, { kind: "video", size: 100, purpose: "story_ovl" });
    assert.equal(r.status, 400);
    r = await post("/api/feed/uploads", u, { kind: "image", size: 2 * 1024 * 1024 + 1, purpose: "story_ovl" });
    assert.equal(r.status, 413);
    for (const bytes of [jpg, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), Buffer.from("<!doctype html><html>not an overlay</html>")]) {
      r = await post("/api/feed/uploads", u, { kind: "image", size: bytes.length, purpose: "story_ovl" });
      assert.equal(r.status, 200);
      const chunk = await studioChunk(r.d.id, u, bytes);
      assert.equal(chunk.status, 415); assert.equal(chunk.d.error, "The overlay must be a PNG picture.");
      const row = (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [r.d.id]))[0];
      assert.equal(row.received, 0); assert.equal(row.state, "failed");
      assert.equal(fs.existsSync(fmedia.tmpPath(row.id)), false);
    }
  } finally { await store.setConfig(saved, "test"); }
});

test("Studio overlays retain alpha, are private, never prefetch, and cannot become post attachments", async () => {
  const saved = { ...store.config() }, safety = require(path.join(repo, "imagesafety"));
  const originalPrefetch = safety.prefetch, seen = [];
  const u = await mkUser("studiomossprism", { camfrog: "cfstudiomossprism" });
  try {
    await store.setConfig({ story_studio: true }, "test");
    safety.prefetch = async value => { seen.push(value); };
    const png = await sharp({ create: { width: 1080, height: 1920, channels: 4, background: { r: 220, g: 30, b: 90, alpha: 0.25 } } }).png().toBuffer();
    const id = await studioUpload(png, u), row = await studioFinished(id, u);
    assert.equal(row.state, "ready", row.error); assert.equal(row.w, 1080); assert.equal(row.h, 1920);
    const file = fmedia.filePath(row.file), info = await sharp(file).metadata();
    assert.equal(info.format, "webp"); assert.equal(info.hasAlpha, true);
    assert.equal(info.exif, undefined); assert.equal(info.xmp, undefined); assert.equal(info.icc, undefined);
    const pixel = await sharp(file).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    assert.ok(pixel[3] >= 62 && pixel[3] <= 66, "transparent overlay alpha is retained");
    assert.equal(seen.length, 0);
    assert.equal((await get("/media/f/" + row.file, null)).status, 404);
    assert.equal((await get("/media/f/" + row.file, U.stranger)).status, 404);
    assert.equal((await get("/media/f/" + row.file, u)).status, 200);
    await assert.rejects(() => store.create(u.userId, { body: "A generated story layer", rooms: [ROOM], attachments: [id] }), /One of those files isn't yours or is already posted/);
  } finally { safety.prefetch = originalPrefetch; await store.setConfig(saved, "test"); }
});

test("Studio rejects the wrong overlay dimensions and removes the generated files", async () => {
  const saved = { ...store.config() }, original = fmedia.processImage, generated = [];
  const u = await mkUser("studiopebblearc", { camfrog: "cfstudiopebblearc" });
  try {
    await store.setConfig({ story_studio: true }, "test");
    fmedia.processImage = async (...args) => { const out = await original(...args); generated.push(out); return out; };
    const png = await sharp({ create: { width: 1080, height: 1919, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 0 } } }).png().toBuffer();
    const id = await studioUpload(png, u), row = await studioFinished(id, u);
    assert.equal(row.state, "failed"); assert.equal(row.error, "The overlay must be 1080 × 1920.");
    assert.equal(fs.existsSync(fmedia.tmpPath(id)), false);
    assert.ok(generated.length);
    for (const out of generated) for (const name of [out.file, out.thumb, out.poster].filter(Boolean)) assert.equal(fs.existsSync(fmedia.filePath(name)), false);
  } finally { fmedia.processImage = original; await store.setConfig(saved, "test"); }
});

test("Studio overlay uploads do not consume hourly or daily allowance but still occupy open-upload slots", async () => {
  const saved = { ...store.config() };
  const u = await mkUser("studiolilacmesh", { camfrog: "cfstudiolilacmesh" });
  try {
    await store.setConfig({ story_studio: true, uploads_per_hour: 1, upload_mb_per_day: 10 }, "test");
    for (let n = 0; n < 6; n++) {
      const id = await upload(u, { purpose: "story_ovl" });
      await runQuery("UPDATE feed_attachments SET size_declared = ? WHERE id = ?", [2 * 1024 * 1024, id]);
    }
    let r = await post("/api/feed/uploads", u, { kind: "image", size: 100 });
    assert.equal(r.status, 200, JSON.stringify(r.d));
    await post("/api/feed/uploads/" + r.d.id + "/discard", u);
    r = await post("/api/feed/uploads", u, { kind: "image", size: 100 });
    assert.equal(r.status, 429); assert.match(r.d.error, /this hour/);
    const ids = [];
    for (let n = 0; n < 4; n++) {
      r = await post("/api/feed/uploads", u, { kind: "image", size: 100, purpose: "story_ovl" });
      assert.equal(r.status, 200, JSON.stringify(r.d)); ids.push(r.d.id);
    }
    r = await post("/api/feed/uploads", u, { kind: "image", size: 100, purpose: "story_ovl" });
    assert.equal(r.status, 429); assert.match(r.d.error, /Finish the uploads/);
    for (const id of ids) await post("/api/feed/uploads/" + id + "/discard", u);
  } finally { await store.setConfig(saved, "test"); }
});

test("Studio records normalized edits and uses the source video cap without a Season Pass multiplier", async () => {
  const saved = { ...store.config() };
  const u = await mkUser("studioquartzpetal", { camfrog: "cfstudioquartzpetal" });
  try {
    await store.setConfig({ story_studio: true, max_video_mb: 100 }, "test");
    const edit = { v: 1, pad: "profile", fit: "fit", trim: { start: 5, end: 35 }, text: [], stickers: [] };
    let r = await post("/api/feed/uploads", u, { kind: "video", size: 61 * 1024 * 1024, purpose: "story", edit });
    assert.equal(r.status, 200, JSON.stringify(r.d));
    const id = r.d.id, row = (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [id]))[0];
    assert.equal(row.purpose, "story"); assert.deepEqual(JSON.parse(row.edit), require(path.join(repo, "storycompose")).cleanEdit(edit, { kind: "video" }));
    await post("/api/feed/uploads/" + id + "/discard", u);
    r = await post("/api/feed/uploads", u, { kind: "video", size: 101 * 1024 * 1024, purpose: "story", edit });
    assert.equal(r.status, 413);
    await store.setConfig({ max_video_mb: 80 }, "test");
    r = await post("/api/feed/uploads", u, { kind: "video", size: 81 * 1024 * 1024, purpose: "story", edit });
    assert.equal(r.status, 413, "the feed cap is still authoritative");
  } finally { await store.setConfig(saved, "test"); }
});

test("discard during processing removes returned files, preserves deleted state and skips safety prefetch", async () => {
  const saved = { ...store.config() }, safety = require(path.join(repo, "imagesafety"));
  const image = fmedia.processImage, prefetch = safety.prefetch, compose = require(path.join(repo, "storycompose")), processEdit = compose.process;
  const u = await mkUser("studiomarblemist", { camfrog: "cfstudiomarblemist" });
  try {
    await store.setConfig({ story_studio: true }, "test");
    let prefetches = 0; safety.prefetch = async () => { prefetches++; };
    for (const edited of [false, true]) {
      let entered, release, output;
      const started = new Promise(resolve => { entered = resolve; }), waiting = new Promise(resolve => { release = resolve; });
      const delayed = async tmpPath => {
        output = await image(tmpPath, "jpeg"); entered(); await waiting; return output;
      };
      if (edited) compose.process = delayed; else fmedia.processImage = delayed;
      const extra = edited ? { edit: { v: 1, pad: "profile", fit: "fit", text: [], stickers: [] } } : {};
      const id = await studioUpload(jpg, u, edited ? "story" : null, extra);
      const r = await post("/api/feed/uploads/" + id + "/finish", u); assert.equal(r.status, 200);
      await started;
      assert.equal((await post("/api/feed/uploads/" + id + "/discard", u)).status, 200);
      release();
      for (let n = 0; n < 100 && fs.existsSync(fmedia.filePath(output.file)); n++) await new Promise(resolve => setTimeout(resolve, 10));
      const row = (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [id]))[0];
      assert.equal(row.state, "deleted"); assert.equal(prefetches, 0); assert.equal(fs.existsSync(fmedia.tmpPath(id)), false);
      for (const name of [output.file, output.thumb, output.poster].filter(Boolean)) assert.equal(fs.existsSync(fmedia.filePath(name)), false);
      fmedia.processImage = image; compose.process = processEdit;
    }
  } finally { fmedia.processImage = image; compose.process = processEdit; safety.prefetch = prefetch; await store.setConfig(saved, "test"); }
});

test("discard removes files when processing finishes after its initial read but before deletion", { timeout: 10000 }, async () => {
  const saved = { ...store.config() }, safety = require(path.join(repo, "imagesafety"));
  const { db } = require(path.join(repo, "dbUtils")), all = db.all;
  const image = fmedia.processImage, prefetch = safety.prefetch, compose = require(path.join(repo, "storycompose")), processEdit = compose.process;
  const u = await mkUser("studiobirchlanding", { camfrog: "cfstudiobirchlanding" });
  let release;
  try {
    await store.setConfig({ story_studio: true }, "test");
    for (const edited of [false, true]) {
      let entered, completed, output, snapshot;
      const started = new Promise(resolve => { entered = resolve; });
      const waiting = new Promise(resolve => { release = resolve; });
      const ready = new Promise(resolve => { completed = resolve; });
      safety.prefetch = async () => { completed(); };
      const delayed = async tmpPath => { output = await image(tmpPath, "jpeg"); entered(); await waiting; return output; };
      if (edited) compose.process = delayed; else fmedia.processImage = delayed;
      const extra = edited ? { edit: { v: 1, pad: "profile", fit: "fit", text: [], stickers: [] } } : {};
      const id = await studioUpload(jpg, u, edited ? "story" : null, extra);
      assert.equal((await post("/api/feed/uploads/" + id + "/finish", u)).status, 200);
      await started;
      assert.equal((await post("/api/feed/uploads/" + id + "/discard", U.stranger)).status, 404);
      // Hold the discard's stale SELECT result until the real processor has written ready and kept its files.
      let armed = true;
      db.all = function (sql, params, callback) {
        if (armed && sql === "SELECT * FROM feed_attachments WHERE id = ?" && params[0] === id) {
          armed = false;
          return all.call(this, sql, params, (error, rows) => {
            if (error) return callback(error, rows);
            snapshot = rows[0]; release();
            ready.then(() => callback(null, rows));
          });
        }
        return all.call(this, sql, params, callback);
      };
      assert.equal((await post("/api/feed/uploads/" + id + "/discard", u)).status, 200);
      db.all = all;
      assert.equal(snapshot.state, "processing"); assert.equal(snapshot.file, null);
      const row = (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [id]))[0];
      assert.equal(row.state, "deleted"); assert.equal(fs.existsSync(fmedia.tmpPath(id)), false);
      for (const name of [output.file, output.thumb, output.poster].filter(Boolean)) assert.equal(fs.existsSync(fmedia.filePath(name)), false);
      fmedia.processImage = image; compose.process = processEdit;
    }
  } finally {
    db.all = all; if (release) release();
    fmedia.processImage = image; compose.process = processEdit; safety.prefetch = prefetch;
    await store.setConfig(saved, "test");
  }
});

// Story Studio's posting gate, accessible metadata and removable PATV account mentions.
function studioEdit(pad = "profile", text = [], stickers = []) { return { v: 1, pad, fit: "fit", text, stickers }; }

test("account merges keep removed story mentions removed on either side and move distinct stories", { timeout: 30000 }, async () => {
  // Exercise the real merge with its full schema in an isolated child, without changing this API harness's users.
  const mergeDir = fs.mkdtempSync(path.join(tmp, "studio-mentions-merge-"));
  const child = await require("util").promisify(require("child_process").execFile)(process.execPath, ["-e", `
    const path = require("path"), assert = require("node:assert/strict"), repo = process.argv[1];
    const sqlite3 = require(path.join(repo, "node_modules/sqlite3"));
    const { scanSource, schemaSql } = require(path.join(repo, "test/fixtures/schemascan"));
    (async () => {
      const schema = new sqlite3.Database("myapp.db");
      const exec = sql => new Promise((resolve, reject) => schema.exec(sql, error => error ? reject(error) : resolve()));
      await exec(schemaSql());
      for (const [, table] of scanSource(repo)) for (const sql of table.creates) await exec(sql).catch(() => {});
      await new Promise((resolve, reject) => schema.close(error => error ? reject(error) : resolve()));
      const { runQuery, getQuery, tx } = require(path.join(repo, "dbUtils"));
      const AM = require(path.join(repo, "accountMerge"));
      const from = "studio-merge-old", to = "studio-merge-new", third = "studio-merge-other";
      for (const id of [from, to, third]) await runQuery("INSERT INTO users (userId, username, password) VALUES (?, ?, 'x')", [id, id]);
      const input = [
        ["a-from-removed", from, 100, 300], ["a-from-removed", to, 200, null],
        ["b-to-removed", from, 400, null], ["b-to-removed", to, 150, 450],
        ["c-both-removed", from, 170, 500], ["c-both-removed", to, 160, 480],
        ["d-both-visible", from, 210, null], ["d-both-visible", to, 220, null],
        ["e-distinct-visible", from, 230, null], ["f-distinct-removed", from, 240, 600],
        ["g-target-only", to, 250, null], ["a-from-removed", third, 260, null]
      ];
      for (const [story, user, created, removed] of input) await runQuery(
        "INSERT INTO story_mentions (story_id, user_id, x, y, created, removed_at) VALUES (?, ?, 0.4, 0.6, ?, ?)",
        [story, user, created, removed]);
      const result = await tx(() => AM.moveUserRows(from, to));
      assert.deepEqual(result.unclassified, []);
      assert.equal(result.folded["story_mentions.user_id"], 4);
      assert.equal(result.moved["story_mentions.user_id"], 2);
      assert.deepEqual(await getQuery("SELECT story_id, created, removed_at FROM story_mentions WHERE user_id=? ORDER BY story_id", [to]), [
        { story_id: "a-from-removed", created: 100, removed_at: 300 },
        { story_id: "b-to-removed", created: 150, removed_at: 450 },
        { story_id: "c-both-removed", created: 160, removed_at: 500 },
        { story_id: "d-both-visible", created: 210, removed_at: null },
        { story_id: "e-distinct-visible", created: 230, removed_at: null },
        { story_id: "f-distinct-removed", created: 240, removed_at: 600 },
        { story_id: "g-target-only", created: 250, removed_at: null }
      ]);
      assert.deepEqual(await getQuery("SELECT * FROM story_mentions WHERE user_id=?", [from]), []);
      assert.deepEqual(await getQuery("SELECT created, removed_at FROM story_mentions WHERE user_id=?", [third]), [{ created: 260, removed_at: null }]);
      console.log("Story mention collisions and distinct moves verified.");
      process.exit(0);
    })().catch(error => { console.error(error); process.exit(1); });
  `, repo], { cwd: mergeDir, timeout: 25000, windowsHide: true, maxBuffer: 1024 * 1024 });
  assert.match(child.stdout, /Story mention collisions and distinct moves verified\./);
});
async function editedUpload(u, edit) {
  const id = await upload(u);
  await runQuery("UPDATE feed_attachments SET edit=? WHERE id=?", [JSON.stringify(edit), id]);
  return id;
}

test("Studio off keeps the old targets and post answers, ignoring mentions", async () => {
  const saved = { ...store.config() }, u = await mkUser("orchardcanvas", { display: "Orchard Canvas" });
  try {
    await store.setConfig({ story_studio: false }, "test");
    const answer = await US.targets(u);
    assert.deepEqual(Object.keys(answer).sort(), ["caps", "pads", "refusal"]);
    assert.deepEqual(answer.caps, { secs: 30, imageMb: 10, videoMb: 60, perDay: 20 });
    assert.deepEqual(answer.pads[0], { id: "u/orchardcanvas", title: "Your profile", label: "u/orchardcanvas", profile: true });
    for (const p of answer.pads) { assert.equal(p.look, undefined); assert.equal(p.href, undefined); }
    const result = await US.create(u, { attachment: await upload(u), pad: "profile", mentions: [{ username: "missing_account" }] });
    assert.deepEqual(Object.keys(result).sort(), ["expires", "href", "id", "room"]);
    assert.deepEqual(await getQuery("SELECT * FROM story_mentions WHERE story_id=?", [result.id]), []);
    const items = [{ id: result.id, source: "user", alt: "stale", mentions: [{ u: "stale" }] }];
    await US.annotateStudio(u, items);
    assert.equal(items[0].alt, undefined); assert.equal(items[0].mentions, undefined);
  } finally { await store.setConfig(saved, "test"); }
});

test("Studio targets add the real pad look and caps without changing eligible destinations", async () => {
  const saved = { ...store.config() }, u = await mkUser("coppercanvas", { display: "Copper Canvas" });
  const PL = require(path.join(repo, "padlook")); await PL.init();
  const rid = "studio_copper_pad";
  await rooms.addRoom(rid, "Copper Garden", "test"); await rooms.setOwner(rid, u.username, "test");
  await PL.setStyle(rid, { accent: "#75bdda" }, "test");
  await PL.setImage(rid, "avatar", jpg, { userId: u.userId, actor: "test" });
  await runQuery("UPDATE users SET avatar='/uploads/copper.webp' WHERE userId=?", [u.userId]);
  try {
    await store.setConfig({ story_studio: false }, "test");
    const off = await US.targets(u, { include: rid });
    await store.setConfig({ story_studio: true }, "test");
    const on = await US.targets(u, { include: rid });
    assert.deepEqual(on.pads.map(p => p.id), off.pads.map(p => p.id));
    const L = PL.look(rid), p = on.pads.find(p => p.id === rid);
    assert.deepEqual(p.look, { avatar: L.avatar, accent: L.accent, ink: L.ink });
    assert.equal(p.href, require(path.join(repo, "pads")).padHref(await rooms.get(rid)));
    assert.deepEqual(on.pads[0].look, { avatar: "/uploads/copper.webp", accent: null, ink: null });
    assert.equal(on.as, "Copper Canvas");
    for (const [k, v] of Object.entries({ srcSecs: 180, srcVideoMb: 100, overlayMb: 2, textsMax: 3, textLen: 120, stickersMax: 10, mentionsMax: 5, studio: true })) assert.equal(on.caps[k], v, k);
    const plain = on.pads.find(p => p.id === ROOM); if (plain) assert.equal(plain.look, null);
  } finally { await store.setConfig(saved, "test"); }
});

test("Studio preflight and create share pad rules and read-only rate checks", async () => {
  const saved = { ...store.config() }, u = await mkUser("mistcanvas");
  try {
    await store.setConfig({ story_studio: true }, "test");
    for (const mode of ["approval", "approved", "ban", "other-profile"]) {
      const pad = mode === "other-profile" ? "u/subby" : ROOM;
      if (mode === "approval") await store.kvSet("room:" + ROOM, JSON.stringify({ approval: true }));
      if (mode === "approved") await store.kvSet("room:" + ROOM, JSON.stringify({ who: "approved" }));
      if (mode === "ban") await store.ban(U.admin, u.username, { room: ROOM, reason: "fixture" });
      const a = await upload(u), captureError = async fn => { try { await fn(); return null; } catch (e) { return { status: e.status, message: e.message }; } };
      const pre = await captureError(() => US.preflight(u, studioEdit(pad)));
      const final = await captureError(() => US.create(u, { attachment: a, pad }));
      assert.ok(pre, mode); assert.deepEqual(final, pre, mode);
      assert.equal((await getQuery("SELECT state FROM feed_attachments WHERE id=?", [a]))[0].state, "ready");
      await store.kvSet("room:" + ROOM, JSON.stringify({}));
      if (mode === "ban") await store.unban(U.admin, u.userId, ROOM);
    }
    await US.preflight(u, studioEdit()); await US.preflight(u, studioEdit());
    await US.create(u, { attachment: await upload(u), pad: "profile" });
    await assert.rejects(US.preflight(u, studioEdit()), e => e.status === 429 && /Slow down/.test(e.message));
  } finally { await store.kvSet("room:" + ROOM, JSON.stringify({})); await store.setConfig(saved, "test"); }
});

test("Studio final-pad words and sticker ownership recheck before claim; filter flags make no report", async () => {
  const saved = { ...store.config() }, u = await mkUser("ripplecanvas"), filter = require(path.join(repo, "feedfilter"));
  const oldCheck = filter.check, seen = []; let action = "allow";
  filter.check = async (account, ids, opts) => { seen.push({ ids, opts }); return { action, message: "Filter refusal." }; };
  try {
    await store.setConfig({ story_studio: true }, "test");
    const edit = studioEdit("profile", ["One more little scene"]), id = await editedUpload(u, edit);
    await US.preflight(u, edit);
    for (const value of ["block", "hide"]) {
      action = value;
      await assert.rejects(US.create(u, { attachment: id, pad: ROOM }), e => e.status === 422 && (value !== "hide" || (!/is hidden/i.test(e.message) && /change them/.test(e.message))));
      assert.equal((await getQuery("SELECT state FROM feed_attachments WHERE id=?", [id]))[0].state, "ready");
      assert.deepEqual(seen.at(-1).ids, [ROOM]); assert.equal(seen.at(-1).opts.dup, false);
    }
    action = "flag";
    const before = (await getQuery("SELECT COUNT(*) n FROM feed_reports"))[0].n;
    const result = await US.create(u, { attachment: id, pad: ROOM });
    assert.equal((await getQuery("SELECT COUNT(*) n FROM feed_reports"))[0].n, before);
    assert.equal(result.item.alt, "One more little scene");
    const owned = require(path.join(repo, "stickers"));
    const pack = owned.catalog().find(p => p.price > 0 && p.stickers.length);
    assert.ok(pack);
    const other = await mkUser("starlitcanvas"), paidEdit = studioEdit("profile", [], [{ pack: pack.id, sticker: pack.stickers[0].id }]);
    await assert.rejects(US.preflight(other, paidEdit), /sticker pack|Prime|Pass/i);
    const aid = await editedUpload(other, paidEdit);
    await assert.rejects(US.create(other, { attachment: aid, pad: "profile" }), /sticker pack|Prime|Pass/i);
    assert.equal((await getQuery("SELECT state FROM feed_attachments WHERE id=?", [aid]))[0].state, "ready");
  } finally { filter.check = oldCheck; await store.setConfig(saved, "test"); }
});

test("Studio duplicate text is counted once per upload, not again at posting", async () => {
  const saved = { ...store.config() }, filter = require(path.join(repo, "feedfilter")), u = await mkUser("plumcanvas");
  try {
    await store.setConfig({ story_studio: true }, "test");
    await filter.setGlobal(U.admin, { enabled: true });
    await filter.setScope(U.owner, ROOM, "on", true);
    await filter.setScope(U.owner, ROOM, "act_spam", "block"); filter._reset();
    const edit = studioEdit(ROOM, ["A small evening in the garden"]);
    for (let i = 0; i < 2; i++) {
      US._setClock(() => Date.now() + i * 11000);
      await US.preflight(u, edit);
      await US.create(u, { attachment: await editedUpload(u, edit), pad: ROOM });
    }
    await assert.rejects(US.preflight(await store.account(u.userId), edit), e => e.status === 429 || e.status === 422);
  } finally { await filter.setScope(U.owner, ROOM, "on", false); filter._reset(); await store.setConfig(saved, "test"); }
});

test("Studio mentions validate before claim, collapse duplicates, and support removable live chips", async () => {
  const saved = { ...store.config() }, author = await mkUser("cedarcanvas"), target = await mkUser("birchreader", { display: "Birch Reader" });
  const outsider = await mkUser("cloudreader"), archived = await mkUser("oldpetalreader");
  const cols = (await getQuery("PRAGMA table_info(users)")).map(c => c.name);
  if (!cols.includes("archived_at")) await runQuery("ALTER TABLE users ADD COLUMN archived_at INTEGER");
  await runQuery("UPDATE users SET archived_at=1 WHERE userId=?", [archived.userId]);
  await runQuery("INSERT OR IGNORE INTO users (userId,username,password,class,level) VALUES ('pepe-bot','studiohelper','x','pleb',5)");
  const PA = require(path.join(repo, "padaccess")), R = await rooms.get(ROOM); await PA.setLevel(U.owner, R, "public");
  try {
    await store.setConfig({ story_studio: true }, "test");
    const aid = await editedUpload(author, studioEdit(ROOM, ["Garden after rain"]));
    for (const username of ["unknownpetalreader", archived.username, author.username, "studiohelper"]) {
      const r = await post("/api/stories/mine", author, { attachment: aid, pad: ROOM, mentions: [{ username, x: 0.5, y: 0.5 }] });
      assert.equal(r.status, 400, username); assert.ok(r.d.error.includes("@" + username));
      assert.equal((await getQuery("SELECT state FROM feed_attachments WHERE id=?", [aid]))[0].state, "ready");
    }
    const tooMany = Array.from({ length: 6 }, (_, i) => ({ username: "reader" + i, x: 0.5, y: 0.5 }));
    assert.equal((await post("/api/stories/mine", author, { attachment: aid, pad: ROOM, mentions: tooMany })).status, 400);
    const result = await US.create(author, { attachment: aid, pad: ROOM, mentions: [{ username: target.username, x: -1, y: 2 }, { username: target.username.toUpperCase(), x: 0.5, y: 0.5 }] });
    assert.equal(result.scope, ROOM); assert.equal(result.item.alt, "Garden after rain");
    assert.deepEqual(result.circle, (await stories.forViewer(author, { room: ROOM }))[0]);
    assert.deepEqual(result.item.mentions, [{ u: target.username, d: "Birch Reader", x: 0.05, y: 0.95, mine: false }]);
    const mine = (await stories.forViewer(target, { room: ROOM }))[0].items.find(i => i.id === result.id);
    assert.equal(mine.mentions[0].mine, true);
    const anon = (await stories.forViewer(null, { room: ROOM }))[0].items.find(i => i.id === result.id);
    assert.equal(anon.alt, "Garden after rain"); assert.equal(anon.mentions, undefined);
    assert.equal((await post("/api/stories/" + result.id + "/unmention", outsider)).status, 404);
    let removed = await post("/api/stories/" + result.id + "/unmention", target);
    assert.equal(removed.status, 200); assert.equal(removed.d.removed, true);
    removed = await post("/api/stories/" + result.id + "/unmention", target); assert.equal(removed.status, 200); assert.equal(removed.d.removed, false);
    await US.annotateStudio(target, [mine]); assert.deepEqual(mine.mentions, []);
    const profile = await US.create(outsider, { attachment: await upload(outsider), pad: "profile", mentions: [{ username: target.username, x: 0.5, y: 0.5 }] });
    assert.equal(profile.scope, "user:" + outsider.userId); assert.deepEqual(profile.circle, await US.personStory(outsider, outsider.userId));
    await runQuery("UPDATE users SET archived_at=1 WHERE userId=?", [target.userId]);
    assert.deepEqual((await US.personStory(outsider, outsider.userId)).items[0].mentions, []);
    await runQuery("UPDATE media SET deleted=1 WHERE id=?", [result.id]);
    await US.annotateStudio(target, [mine]); assert.equal(mine.alt, undefined); assert.equal(mine.mentions, undefined);
    await US.sweep(); assert.deepEqual(await getQuery("SELECT * FROM story_text WHERE story_id=?", [result.id]), []);
    assert.deepEqual(await getQuery("SELECT * FROM story_mentions WHERE story_id=?", [result.id]), []);
  } finally { await PA.setLevel(U.owner, R, "members"); await store.setConfig(saved, "test"); }
});
