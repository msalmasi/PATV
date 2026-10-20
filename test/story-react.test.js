// Offline tests for the storyreact site (storyreact.js): ▲▼ votes, 💸 tips and ↩ replies (a DM) on stories - the one
// visibility rule (storyFor / visibleTo) and its parity with the strips, hiding blocked people's stories (D-3), who the author
// of each kind of story is (D-1 / D-2 / D-13), the feed's vote model in its own table, the one tip path, replies as ordinary
// DMs (refusal parity, the story reference written with the message, per-reader cards, the member-checked thumbnail and
// "open" routes), alerts, merge / delete / export coverage and the vote sweep.
//   NODE_PATH=G:/PATV/node_modules node --test test/story-react.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "story-react-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
process.env.DM_DIR = path.join(tmp, "dmfiles");
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });
const express = require("express");
const sharp = require("sharp");
const { runQuery, getQuery, tx, inTx } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
require(path.join(repo, "terms"))._setRequired(false);
const media = require(path.join(repo, "media"));
const stories = require(path.join(repo, "stories"));
const US = require(path.join(repo, "userstories"));
const keep = require(path.join(repo, "storykeep"));
const SR = require(path.join(repo, "storyreact"));
const dm = require(path.join(repo, "messages"));
const PA = require(path.join(repo, "padaccess"));
const AG = require(path.join(repo, "adultgate"));
const CV = require(path.join(repo, "camviewers"));
const web = require(path.join(repo, "feedweb"));
const tips = require(path.join(repo, "tips"));
const inbox = require(path.join(repo, "inbox"));
const follows = require(path.join(repo, "follows"));
const layout = require(path.join(repo, "profilelayout"));
const telegram = require(path.join(repo, "telegram"));
const webpush = require(path.join(repo, "webpush"));
const achievements = require(path.join(repo, "achievements"));

const MEM = "mem.pad", APP = "app.pad", PUB = "pub.pad", ADL = "adl.pad";
const PROF = (uid) => "user:" + uid;
let base, server, jpg, webp;
const U = {};
const R = {};                       // story ids
const BY_PAD = { [MEM]: [], [APP]: [], [PUB]: [], [ADL]: [] };
let T = Date.now();
dm._setClock(() => T);
const tick = (ms = 120e3) => { T += ms; };
const tgCalls = [], pushCalls = [];

async function mkUser(name, o = {}) {
  const id = "u_" + name.toLowerCase();
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, ?, ?, ?, '2026-01-01 00:00:00', 0)`,
                 [id, name, o.display || name, o.class || "pleb", o.bal || 0, o.camfrog || null, o.level == null ? 5 : o.level]);
  return (U[name.toLowerCase()] = { userId: id, username: name, class: o.class || "pleb" });
}
const V = (u) => ({ userId: u.userId, username: u.username, class: u.class });

let seq = 0;
/** A story row with its file (and a poster when asked). */
async function row(o = {}) {
  const { room = MEM, kind = "photo", source = null, by = "someone", byId = null, subject = "", login = null, anon = 0, slot = null, stream = null,
          ageMin = 5, hours = 24, nsfw = 0, deleted = 0, file = true, poster = false, created = null, expires = null } = o;
  const id = (0x5a000000 + (++seq)).toString(16);
  const ext = kind === "photo" ? (source ? "webp" : "jpg") : kind === "clip" ? "mp4" : "m4a";
  const ct = kind === "photo" ? (source ? "image/webp" : "image/jpeg") : kind === "clip" ? "video/mp4" : "audio/mp4";
  const t = created || Date.now() - ageMin * 60e3;
  await runQuery(`INSERT INTO media (id, kind, ct, file, bytes, secs, subject, by_user, room, created, expires, deleted, anon, source, nsfw, by_user_id, slot_id, subject_login, stream)
                  VALUES (?, ?, ?, ?, 10, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                 [id, kind, ct, id + "." + ext, kind === "photo" ? 0 : 5, subject, by, room, t, expires || t + hours * 3600e3, deleted, anon, source, nsfw, byId, slot, login, stream]);
  if (file) fs.writeFileSync(path.join(process.env.MEDIA_DIR, id + "." + ext), ext === "webp" ? webp : jpg);
  if (poster) fs.writeFileSync(media.posterFile(id), webp);
  if (BY_PAD[room]) BY_PAD[room].push(id);
  return id;
}

// the same claim / replay / release rules as index.js idemBegin (copied from test/post-tips.test.js)
async function idemBegin(req, res, endpoint) {
  const key = req.body && req.body.idempotency_key ? String(req.body.idempotency_key).slice(0, 120) : null;
  if (!key) return { replay: false, done: () => {}, fail: () => {} };
  await runQuery(`CREATE TABLE IF NOT EXISTS idempotency_keys (key TEXT PRIMARY KEY, endpoint TEXT NOT NULL, status INTEGER, body TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  const claimed = await runQuery("INSERT OR IGNORE INTO idempotency_keys (key, endpoint) VALUES (?, ?)", [key, endpoint]);
  if (!claimed || claimed.changes === 0) {
    const prev = await getQuery("SELECT status, body FROM idempotency_keys WHERE key = ?", [key]);
    if (prev.length && prev[0].status) res.status(prev[0].status).json(Object.assign(JSON.parse(prev[0].body || "{}"), { replayed: true }));
    else res.status(409).json({ ok: false, error: "in_progress" });
    return { replay: true };
  }
  return { replay: false, done: (s, b) => runQuery("UPDATE idempotency_keys SET status = ?, body = ? WHERE key = ?", [s, JSON.stringify(b || {}), key]),
           fail: () => runQuery("DELETE FROM idempotency_keys WHERE key = ? AND status IS NULL", [key]) };
}

const H = (u, extra) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {}, extra || {});
async function call(method, url, u, body, headers) {
  const r = await fetch(base + url, { method, headers: headers || H(u), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, text, headers: r.headers };
}
const voteS = (u, id, dir) => call("POST", `/api/stories/${id}/vote`, u, { dir });
const tipS = (u, id, body) => call("POST", `/api/stories/${id}/tip`, u, body);
const replyS = async (u, id, body) => { tick(); return call("POST", `/api/stories/${id}/reply`, u, body); };
const preS = (u, id) => call("GET", `/api/stories/${id}/reply`, u);
const dmSend = async (u, to, body) => { tick(); return call("POST", "/api/messages/send", u, { to: to.username, body }); };
const block = (a, b, on = true) => { dm._gaps.clear(); return dm.setBlock(V(a), b.username, on); };
const setCfg = (p) => store.setConfig(p, "test");
const ledgerCount = async () => (await getQuery("SELECT COUNT(*) AS n FROM transactions"))[0].n;
const refOf = async (mid) => (await getQuery("SELECT * FROM dm_story_refs WHERE message_id = ?", [mid]))[0] || null;
const lastMsg = async (sender) => (await getQuery("SELECT * FROM messages WHERE sender_id = ? ORDER BY id DESC LIMIT 1", [sender.userId]))[0];
async function historyOf(u, convId) { return (await dm.history(V(u), convId)).messages; }
async function cardOf(u, mid) {
  const m = (await getQuery("SELECT conversation_id FROM messages WHERE id = ?", [mid]))[0];
  const h = await historyOf(u, m.conversation_id);
  return (h.find((x) => x.id === mid) || {}).story;
}
const itemsOf = async (u, room) => { const l = await stories.forViewer(u ? V(u) : null, { room }); return l[0] ? l[0].items || [] : []; };
const itemOf = async (u, room, id) => (await itemsOf(u, room)).find((x) => x.id === id) || null;
async function setAdult(on) { await AG.setEnabled(on, { userId: U.boss.userId, username: "boss" }, "test"); }

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0,
                  archived_at INTEGER, email TEXT)`);
  await runQuery(`CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, counterparty TEXT,
                  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await media.ready;
  await inbox.ready;
  jpg = await sharp({ create: { width: 16, height: 12, channels: 3, background: "#0a0" } }).jpeg().toBuffer();
  webp = await sharp({ create: { width: 16, height: 12, channels: 3, background: "#00a" } }).webp().toBuffer();
  await mkUser("padowner", { camfrog: "ownercf" });
  await mkUser("alice", { camfrog: "alicecf", display: "Alice A" });
  await mkUser("bob", { camfrog: "bobcf", display: "Bob B", bal: 100000 });
  await mkUser("carol", { camfrog: "carolcf", display: "Carolyn" });          // the story shows her as "Carol C" (her Camfrog name)
  await mkUser("dave", { level: 0, bal: 50000 });                             // level 0, nothing linked: a new account
  await mkUser("eve", { camfrog: "evecf", bal: 100000 });
  await mkUser("frank", { camfrog: "frankcf", bal: 100000 });
  await mkUser("streamer", { camfrog: "streamcf", display: "Streamy" });
  await mkUser("privy", { camfrog: "privcf" });
  await mkUser("shy", { camfrog: "shycf" });
  await mkUser("hider", { camfrog: "hidecf" });
  await mkUser("twin", { camfrog: "twocf" });
  await mkUser("CF12345678", { camfrog: "twocf" });                           // twin's login also has an auto account
  await mkUser("CF87654321", { camfrog: "autocf" });                          // a login linked to an auto account only
  await mkUser("staffy", { camfrog: "staffcf", class: "Staff" });
  await mkUser("boss", { camfrog: "bosscf", class: "Admin" });
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername, level) VALUES ('pepe-bot', 'Pepe', 'Pepe', 'x', 'Bot', 'pepefrog', 5)");
  U.pepe = { userId: "pepe-bot", username: "Pepe", class: "Bot" };
  await rooms.init();
  await store.init();
  await setCfg({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0 });
  await follows.init();
  await keep.init();
  await US.init();
  await SR.init();
  await dm.init();
  await PA.init();
  await CV.init();
  await require(path.join(repo, "mainstage")).getSlot("x");                  // the stage tables
  for (const [id, title] of [[MEM, "Members Pond"], [APP, "Secret Pond"], [PUB, "Open Pond"], [ADL, "Night Pond"]]) {
    await rooms.addRoom(id, title, "test");
    await rooms.setOwner(id, "padowner", "test");
  }
  await PA.setLevel(V(U.padowner), await rooms.get(APP), "approved");
  await PA.setLevel(V(U.padowner), await rooms.get(PUB), "public");
  await rooms.setPage(ADL, { adult: true }, "test");
  for (const u of [U.alice, U.bob]) {
    await PA.request(V(u), await rooms.get(APP), "hi");
    await PA.decide(V(U.padowner), await rooms.get(APP), u.userId, true);
  }
  const ts = Date.now();
  await runQuery(`INSERT INTO stage_slots (id, userId, username, displayname, status, created, max_minutes, price_per_min, held, stream, mode, source)
                  VALUES ('slotown', 'u_streamer', 'streamer', 'Streamy', 'ended', ?, 30, 0, 0, 'slotown', 'stream', NULL),
                         ('slotlib', 'u_streamer', 'streamer', 'Streamy', 'ended', ?, 30, 0, 0, 'slotlib', 'stream', 'library')`, [ts, ts]);
  // the stories
  const up = (room) => row({ room, source: "user", by: "Alice A", byId: U.alice.userId });
  R.UP_MEM = await up(MEM); R.UP_PROF = await up(PROF(U.alice.userId)); R.UP_APP = await up(APP); R.UP_PUB = await up(PUB); R.UP_ADL = await up(ADL);
  R.UP_BOB = await row({ room: MEM, source: "user", by: "Bob B", byId: U.bob.userId });
  R.CAM_C = await row({ subject: "Carol C", login: "carolcf", by: "bobcf" });
  R.CAM_C_CLIP = await row({ kind: "clip", subject: "Carol C", login: "carolcf", poster: true });
  R.CAM_C_AUDIO = await row({ kind: "audio", subject: "Carol C", login: "carolcf" });
  R.CAM_C_APP = await row({ room: APP, subject: "Carol C", login: "carolcf" });
  R.CAM_ANON = await row({ anon: 1 });
  R.CAM_PRIV = await row({ subject: "Privy", login: "privcf" });
  R.CAM_SHY = await row({ subject: "Shy", login: "shycf" });
  R.CAM_HID = await row({ subject: "Hider", login: "hidecf" });
  R.CAM_AUTO = await row({ subject: "Auto", login: "autocf" });
  R.CAM_TWIN = await row({ subject: "Twin", login: "twocf" });
  R.CAM_PEPE = await row({ subject: "Pepe", login: "pepefrog" });
  R.STG_OWN = await row({ source: "stage", subject: "Streamy", slot: "slotown", stream: "slot:slotown" });
  R.STG_CLIP = await row({ source: "stage", kind: "clip", subject: "Streamy", slot: "slotown", stream: "slot:slotown" });
  R.STG_LIB = await row({ source: "stage", subject: "Movie", slot: "slotlib", stream: "slot:slotlib" });
  R.STG_PEPE = await row({ source: "stage", subject: "Pepe", stream: "pepe" });
  R.G_EXP = await row({ created: Date.now() - 60 * 60e3, expires: Date.now() - 60e3 });
  R.G_OLD = await row({ source: "stage", subject: "Streamy", slot: "slotown", created: Date.now() - 25 * 3600e3, expires: Date.now() + 700 * 3600e3 });
  R.G_DEL = await row({ deleted: 1 });
  R.G_NOFILE = await row({ file: false });
  R.G_PROFCAP = await row({ room: PROF(U.alice.userId), subject: "Alice A", login: "alicecf" });   // not an upload: never a story
  await layout.save(U.privy.userId, { hidden: ["analytics"] });
  await US.setPrefs(V(U.shy), { captureReacts: false });
  await runQuery("INSERT INTO story_hides (user_id, capture_id, created) VALUES (?, ?, 1)", [U.hider.userId, R.CAM_HID]);
  // alerts: recorded, never sent
  telegram.onDm = (uid, o) => { tgCalls.push({ uid, o }); };
  webpush.onDm = (uid, o) => { pushCalls.push({ uid, o }); };
  const app = express();
  app.use(express.json());
  const addUser = async (req, res, next) => {
    const id = req.get("x-test-user");
    req.user = id ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [id]))[0] || null : null;
    next();
  };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  stories.register(app, { addUser });
  US.register(app, { addUser });
  SR.register(app, { addUser, idemBegin, noTimers: true });
  dm.register(app, { isBotToken: (t) => t === "bot", addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });
test.beforeEach(() => { store._gaps.clear(); store._votes.clear(); dm._gaps.clear(); tick(); });

// ───────────────────────────── 0. the decisions ─────────────────────────────
test("the owner decisions are pinned (POLICY + the feed config defaults) and the config keys clamp", async () => {
  assert.deepEqual({ ...SR.POLICY }, { captureAuthor: "subject", captureReactsDefault: 1, countsPublic: true, autoSelfUp: false, captureDownvotes: true,
                                      tipTally: true, authorReach: true, authorVoterList: false, voteKeepMs: 7 * 86400e3 });
  assert.deepEqual([...SR.QUICK], ["😂", "😮", "😍", "😢", "👏", "🔥", "🎉", "💯"]);
  const D = store.DEFAULTS;
  assert.deepEqual([D.story_votes, D.story_tips, D.story_replies, D.story_quick_reacts, D.story_block_hide], [true, true, true, true, true]);
  assert.equal(D.story_tips_per_hour, 30);
  assert.equal(D.story_capture_new_convos_per_day, 10);
  assert.equal(D.story_capture_tips_per_person_per_day, 10);
  await setCfg({ story_votes: false, story_tips_per_hour: 99999, story_capture_new_convos_per_day: -5 });
  assert.equal(store.config().story_votes, false);
  assert.equal(store.config().story_tips_per_hour, 1000);
  assert.equal(store.config().story_capture_new_convos_per_day, 0);
  assert.equal(store.config().enabled, true, "the other switches keep their value");
  await setCfg({ story_votes: true, story_tips_per_hour: 30, story_capture_new_convos_per_day: 10 });
  assert.equal(store.config().story_votes, true);
});

// ───────────────────────────── 1. one visibility rule ─────────────────────────────
test("storyFor: the same null - and the same 404 text - for every reason", async () => {
  for (const id of [R.G_EXP, R.G_OLD, R.G_DEL, R.G_NOFILE, R.G_PROFCAP, "deadbeef00"]) {
    assert.equal(await SR.storyFor(V(U.bob), id), null, id);
  }
  assert.ok(await SR.storyFor(V(U.bob), R.UP_MEM), "a live upload is a story");
  assert.ok(await SR.storyFor(V(U.alice), R.UP_PROF), "a profile upload is a story");
  assert.equal(await SR.storyFor(V(U.eve), R.UP_APP), null, "an Approved pad's outsider");
  assert.ok(await SR.storyFor(V(U.bob), R.UP_APP), "...but not for a member inside");
  await setAdult(true);
  try {
    assert.equal(await SR.storyFor(V(U.bob), R.UP_ADL), null, "18+: an unconfirmed member");
    assert.ok(await SR.storyFor(V(U.padowner), R.UP_ADL), "18+: the pad's owner is exempt");
    const texts = new Set();
    for (const [u, id] of [[U.bob, R.G_EXP], [U.bob, R.G_OLD], [U.bob, R.G_DEL], [U.bob, R.G_NOFILE], [U.bob, R.G_PROFCAP], [U.bob, "deadbeef00"],
                           [U.eve, R.UP_APP], [U.bob, R.UP_ADL], [U.bob, "not-hex!"]]) {
      const r = await voteS(u, id, 1);
      assert.equal(r.status, 404, id);
      texts.add(r.d.error);
    }
    assert.deepEqual([...texts], ["This story isn't available any more."]);
  } finally { await setAdult(false); }
});

async function parity(label) {
  const viewers = [U.alice, U.bob, U.carol, U.dave, U.eve, U.frank, U.staffy, U.padowner];
  for (const v of viewers) {
    for (const pad of Object.keys(BY_PAD)) {
      const shown = new Set((await itemsOf(v, pad)).map((x) => x.id));
      for (const id of BY_PAD[pad]) {
        assert.equal(!!(await SR.storyFor(V(v), id)), shown.has(id), `${label}: ${v.username} x ${id} in ${pad}`);
      }
    }
    // person stories: the profile upload, and every item of a person's story is a story for the viewer
    for (const who of [U.alice, U.carol, U.streamer]) {
      const items = await itemsOf(v, PROF(who.userId));
      if (who === U.alice) assert.equal(!!(await SR.storyFor(V(v), R.UP_PROF)), items.some((x) => x.id === R.UP_PROF), `${label}: ${v.username} x alice's profile upload`);
      for (const it of items) assert.ok(await SR.storyFor(V(v), it.id), `${label}: ${v.username} sees ${it.id} in ${who.username}'s story`);
    }
  }
}
test("parity: storyFor(viewer, id) is truthy exactly when the item is in the viewer's strip (pads + person stories), blocks and 18+ included", async () => {
  await parity("base");
  await block(U.bob, U.alice);
  await block(U.frank, U.carol);
  await block(U.carol, U.streamer);
  await CV.block("carolcf", "eve");
  try {
    await parity("blocks");
    await setAdult(true);
    try { await parity("18+"); } finally { await setAdult(false); }
  } finally {
    await block(U.bob, U.alice, false); await block(U.frank, U.carol, false); await block(U.carol, U.streamer, false); await CV.unblock("carolcf", "eve");
  }
});

test("D-3: stories by / of someone blocked either way are gone from the strip, the viewer, the person circle and the pad thumbnails", async () => {
  const has = (list, id) => list.some((x) => x.id === id);
  const strip = async (u) => (await stories.forViewer(V(u), {})).flatMap((r) => r.items || []);
  assert.ok(has(await strip(U.bob), R.UP_MEM) && has(await strip(U.alice), R.UP_BOB));
  await block(U.bob, U.alice);
  try {
    for (const [viewer, gone] of [[U.bob, R.UP_MEM], [U.alice, R.UP_BOB]]) {          // either way
      assert.ok(!has(await strip(viewer), gone), viewer.username + ": strip");
      assert.ok(!has(await itemsOf(viewer, MEM), gone), viewer.username + ": the pad's viewer");
      assert.ok(!has(await web.captures(MEM, 24, V(viewer)), gone), viewer.username + ": the pad's thumbnails");
    }
    assert.deepEqual(await US.people(V(U.bob), [U.alice.userId]), [], "alice's person circle is gone for bob");
    assert.ok(has(await itemsOf(U.alice, MEM), R.UP_MEM), "the viewer's own uploads always stay");
    assert.ok(has(await web.captures(MEM, 24, null), R.UP_MEM), "no viewer: no filter");
    await setCfg({ story_block_hide: false });
    assert.ok(has(await itemsOf(U.bob, MEM), R.UP_MEM) && has(await strip(U.bob), R.UP_MEM), "switch off: they all show");
    assert.equal((await US.people(V(U.bob), [U.alice.userId])).length, 1);
  } finally { await setCfg({ story_block_hide: true }); await block(U.bob, U.alice, false); }
  // a cam capture of a blocked subject; a cam owner who cam-blocked the viewer; a stage capture of a blocked streamer
  await block(U.frank, U.carol);
  await CV.block("carolcf", "eve");
  await block(U.streamer, U.frank);
  try {
    for (const id of [R.CAM_C, R.CAM_C_CLIP]) assert.ok(!has(await itemsOf(U.frank, MEM), id) && !has(await itemsOf(U.eve, MEM), id), id);
    assert.ok(has(await itemsOf(U.bob, MEM), R.CAM_C), "nobody else's view changes");
    assert.ok(!has(await itemsOf(U.frank, MEM), R.STG_OWN), "the blocked streamer's stage capture");
    assert.deepEqual(await US.people(V(U.frank), [U.carol.userId]), [], "carol's circle for frank");
    assert.ok(!has(await web.captures(MEM, 24, V(U.eve)), R.CAM_C), "cam-blocked: the thumbnails too");
  } finally { await block(U.frank, U.carol, false); await CV.unblock("carolcf", "eve"); await block(U.streamer, U.frank, false); }
});

test("D-3 and incognito captures: a real anon capture stores no login (nobody to check: it shows to everyone); a capture that names its person follows the block rule, anon or not", async () => {
  const plain = await row({ anon: 1 });                                     // what media.js stores for !incognito: no subject, no login
  const named = await row({ anon: 1, login: "carolcf" });                   // a login on an anon row (never written today) still counts
  await CV.block("carolcf", "eve");
  await block(U.carol, U.frank);
  try {
    for (const v of [U.eve, U.frank]) {
      assert.ok(await SR.storyFor(V(v), plain), v.username + ": nobody to check");
      assert.equal(await SR.storyFor(V(v), named), null, v.username + ": the person in it blocked them");
      assert.ok(!(await itemsOf(v, MEM)).some((x) => x.id === named), v.username + ": the strip agrees");
    }
    assert.ok(await SR.storyFor(V(U.bob), named), "everyone else still sees it");
  } finally { await CV.unblock("carolcf", "eve"); await block(U.carol, U.frank, false); }
});

// ───────────────────────────── 2. who the author is ─────────────────────────────
test("authorOf: uploader / the person on cam (real account) / the own-stream streamer - nobody for anon, private, hidden, opted out, unlinked, auto, Pepe, library", async () => {
  const A = async (id) => SR.authorOf((await getQuery("SELECT * FROM media WHERE id = ?", [id]))[0], SR.mkCtx());
  let a = await A(R.UP_MEM);
  assert.deepEqual([a.userId, a.role, a.name, a.reach], [U.alice.userId, "uploader", "Alice A", true]);
  a = await A(R.CAM_C);
  assert.deepEqual([a.userId, a.role, a.name], [U.carol.userId, "subject", "Carol C"]);
  a = await A(R.CAM_TWIN);
  assert.equal(a.userId, U.twin.userId, "the REAL linked account, never the auto CF one");
  a = await A(R.STG_OWN);
  assert.deepEqual([a.userId, a.role, a.name], [U.streamer.userId, "streamer", "Streamy"]);
  for (const id of [R.CAM_AUTO, R.CAM_ANON, R.CAM_PRIV, R.CAM_HID, R.STG_LIB, R.STG_PEPE, R.CAM_PEPE]) {
    a = await A(id);
    assert.equal(a.userId, null, id);
    assert.equal(a.votes, true, id + ": votes stay");
  }
  a = await A(R.CAM_SHY);
  assert.equal(a.userId, null);
  assert.equal(a.votes, false, "opted out: votes off too");
  // archived uploader -> nobody
  await runQuery("UPDATE users SET archived_at = 1 WHERE userId = ?", [U.alice.userId]);
  try { assert.equal((await A(R.UP_MEM)).userId, null); } finally { await runQuery("UPDATE users SET archived_at = NULL WHERE userId = ?", [U.alice.userId]); }
  // a profile layout that can't be read: private (fails closed)
  const get = layout.get;
  layout.get = async () => { throw new Error("db down"); };
  try { assert.equal((await A(R.CAM_C)).userId, null); } finally { layout.get = get; }
  // the author can't see the story (carol is outside the Approved pad): no tip, no reply; votes stay
  a = await A(R.CAM_C_APP);
  assert.equal(a.userId, U.carol.userId);
  assert.equal(a.reach, false);
  const it = await itemOf(U.bob, APP, R.CAM_C_APP);
  assert.deepEqual([it.react.votes, it.react.can.tip, it.react.can.reply], [true, false, false]);
  // ...and nothing tells bob that's WHY: no name / role, exactly like a capture with nobody behind it (an anon one)
  const anon = (await itemOf(U.bob, MEM, R.CAM_ANON)).react;
  assert.deepEqual([it.react.to, it.react.role], [null, null]);
  assert.deepEqual({ to: it.react.to, role: it.react.role, can: it.react.can }, { to: anon.to, role: anon.role, can: anon.can });
  assert.equal((await tipS(U.bob, R.CAM_C_APP, { amount: 5 })).d.error, "This story can't be tipped.");
  assert.equal((await preS(U.bob, R.CAM_C_APP)).d.refusal, "You can't reply to this story.");
  // "Show captures of me in my story" off: their captures aren't tied to their profile, so nothing is routed to it (votes stay)
  await US.setPrefs(V(U.carol), { capturesOfMe: false });
  await US.setPrefs(V(U.streamer), { capturesOfMe: false });
  try {
    for (const id of [R.CAM_C, R.STG_OWN]) {
      a = await A(id);
      assert.deepEqual([a.userId, a.votes], [null, true], id);
      const ci = (await itemOf(U.bob, MEM, id)).react;
      assert.deepEqual([ci.votes, ci.can.tip, ci.can.reply, ci.to, ci.role], [true, false, false, null, null], id);
      assert.equal((await tipS(U.bob, id, { amount: 5 })).d.error, "This story can't be tipped.", id);
      assert.equal((await replyS(U.bob, id, { body: "hi" })).d.error, "You can't reply to this story.", id);
    }
  } finally { await US.setPrefs(V(U.carol), { capturesOfMe: true }); await US.setPrefs(V(U.streamer), { capturesOfMe: true }); }
  assert.equal((await A(R.CAM_C)).userId, U.carol.userId, "back on");
});

test("react: what each story offers, and nothing about who is behind it leaves the server", async () => {
  const items = await itemsOf(U.bob, MEM);
  const by = new Map(items.map((x) => [x.id, x]));
  const c = by.get(R.CAM_C).react;
  assert.deepEqual({ votes: c.votes, to: c.to, role: c.role, can: c.can, signin: c.signin, my: c.my },
                   { votes: true, to: "Carol C", role: "subject", can: { vote: true, down: true, tip: true, reply: true, quick: true }, signin: false, my: 0 });
  assert.deepEqual([by.get(R.CAM_ANON).react.to, by.get(R.CAM_ANON).react.can.tip, by.get(R.CAM_ANON).react.can.reply], [null, false, false]);
  assert.equal(by.get(R.CAM_SHY).react.votes, false);
  assert.equal(by.get(R.STG_OWN).react.role, "streamer");
  const json = JSON.stringify(items);
  for (const leak of ["u_carol", "carolcf", "u_streamer", "subject_login", "by_user_id", "acctId", "_row", "\"why\"", "\"login\"", "u_alice"]) {
    assert.ok(!json.includes(leak), "no " + leak + " in the viewer payload");
  }
  const mine = (await itemOf(U.alice, MEM, R.UP_MEM)).react;
  assert.deepEqual([mine.can.vote, mine.can.down, mine.can.tip, mine.can.reply], [true, false, false, false], "your own story: ▲ only");
  assert.deepEqual([mine.to, mine.role], [null, null]);
  // signed out, a Public pad: read-only counts (no name / role: signed-out visitors and crawlers learn nothing about who's behind it)
  const pub = (await itemsOf(null, PUB)).find((x) => x.id === R.UP_PUB);
  assert.ok(pub && pub.react, "the Public pad's story carries its counts");
  assert.equal(pub.react.signin, true);
  assert.equal(pub.react.my, undefined);
  assert.deepEqual(pub.react.can, { vote: false, down: false, tip: false, reply: false, quick: false });
  assert.deepEqual([pub.react.to, pub.react.role], [null, null]);
  // the API (the same items)
  const r = await call("GET", "/api/stories?room=" + MEM, U.bob);
  assert.ok(!r.text.includes("carolcf") && !r.text.includes("u_carol"));
  // switches off: no votes, no tips, no replies
  await setCfg({ story_votes: false, story_tips: false, story_replies: false });
  try {
    const off = (await itemOf(U.bob, MEM, R.CAM_C)).react;
    assert.deepEqual([off.votes, off.can.tip, off.can.reply, off.tips], [false, false, false, null]);
    assert.equal((await voteS(U.bob, R.CAM_C, 1)).status, 403);
    assert.equal((await tipS(U.bob, R.CAM_C, { amount: 5 })).status, 403);
    assert.equal((await preS(U.bob, R.CAM_C)).d.canSend, false);
    assert.equal((await replyS(U.bob, R.CAM_C, { body: "hi" })).status, 403);
  } finally { await setCfg({ story_votes: true, story_tips: true, story_replies: true }); }
});

// ───────────────────────────── 3. votes ─────────────────────────────
test("votes: up / down / undo / toggle, idempotent; your own story: ▲ yes, ▼ no; Pepe, archived and feed-banned accounts refused", async () => {
  const S = R.UP_PUB;
  let r = await voteS(U.bob, S, 1);
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.deepEqual([r.d.vote, r.d.score, r.d.ups, r.d.downs, r.d.counted], [1, 1, 1, 0, true]);
  store._gaps.clear();
  r = await voteS(U.bob, S, 1);
  assert.deepEqual([r.d.vote, r.d.score], [1, 1], "the same vote again: nothing changes");
  store._gaps.clear();
  r = await voteS(U.bob, S, -1);
  assert.deepEqual([r.d.vote, r.d.score, r.d.ups, r.d.downs], [-1, -1, 0, 1]);
  store._gaps.clear();
  r = await voteS(U.bob, S, 0);
  assert.deepEqual([r.d.vote, r.d.score], [0, 0]);
  store._gaps.clear();
  r = await voteS(U.bob, S, null);
  assert.equal(r.d.vote, 1, "no dir: toggles the upvote on");
  store._gaps.clear();
  r = await voteS(U.bob, S, null);
  assert.equal(r.d.vote, 0, "...and off");
  r = await voteS(U.alice, S, -1);
  assert.deepEqual([r.status, r.d.error], [403, "You can't downvote your own story."]);
  r = await voteS(U.alice, S, 1);
  assert.equal(r.d.vote, 1, "upvoting your own story is fine");
  assert.equal((await voteS(U.pepe, S, 1)).d.error, "Pepe doesn't vote.");
  await runQuery("UPDATE users SET archived_at = 1 WHERE userId = ?", [U.eve.userId]);
  try { assert.equal((await voteS(U.eve, S, 1)).status, 403); } finally { await runQuery("UPDATE users SET archived_at = NULL WHERE userId = ?", [U.eve.userId]); }
  await runQuery("INSERT INTO feed_bans (user_id, room_id, until, reason, by, username) VALUES (?, '', NULL, 'test', 'boss', 'eve')", [U.eve.userId]).catch(async () => {
    await runQuery("INSERT INTO feed_bans (user_id, room_id, until) VALUES (?, '', NULL)", [U.eve.userId]);
  });
  try { assert.equal((await voteS(U.eve, S, 1)).d.error, "You can't vote on the feed right now."); }
  finally { await runQuery("DELETE FROM feed_bans WHERE user_id = ?", [U.eve.userId]); }
  assert.equal((await voteS(U.bob, R.CAM_SHY, 1)).d.error, "Votes are off for this story.", "the subject opted out");
  assert.equal((await voteS(null, S, 1)).status, 401);
});

test("votes: a new account's ▼ is stored (theirs to see) but not counted; the feed's shared budget + burst; blocks never move the counts", async () => {
  const S = R.CAM_C;
  let r = await voteS(U.dave, S, -1);
  assert.deepEqual([r.status, r.d.vote, r.d.counted, r.d.score], [200, -1, false, 0]);
  assert.equal((await itemOf(U.dave, MEM, S)).react.my, -1, "highlighted for them");
  assert.equal((await itemOf(U.bob, MEM, S)).react.score, 0, "not counted for anyone");
  // the SAME per-account budget as posts + comments (in memory)
  store._votes.set(U.eve.userId, new Array(30).fill(Date.now()));
  r = await voteS(U.eve, S, 1);
  assert.deepEqual([r.status, r.d.error], [429, "You're voting very fast - take a breather."]);
  store._votes.clear(); store._gaps.clear();
  // the burst: two changes on one story within 300 ms
  await SR.vote(V(U.eve), S, 1);
  await assert.rejects(SR.vote(V(U.eve), S, 0), (e) => e.status === 429);
  store._gaps.clear();
  // eve's +1 counts - and a block made AFTER the vote never moves the counts (either way, or the cam owner's cam block):
  // counts that dropped on block and came back on unblock would let the author block-and-watch their way to a voter list
  const seen = async () => { const r = (await itemOf(U.bob, MEM, S)).react; return [r.ups, r.downs, r.score]; };
  const at = await seen();
  assert.equal(at[0], 1);
  for (const [label, on, off] of [["carol blocks eve", () => block(U.carol, U.eve), () => block(U.carol, U.eve, false)],
                                   ["eve blocks carol", () => block(U.eve, U.carol), () => block(U.eve, U.carol, false)],
                                   ["carol's cam block", () => CV.block("carolcf", "eve"), () => CV.unblock("carolcf", "eve")]]) {
    await on();
    try { assert.deepEqual(await seen(), at, label + ": blocked"); } finally { await off(); }
    assert.deepEqual(await seen(), at, label + ": unblocked");
  }
  // the author's own view and the API's answer never move either (nothing for the author to diff)
  const mine = async () => { const r = (await itemOf(U.carol, MEM, S)).react; return [r.ups, r.downs]; };
  const a0 = await mine();
  await block(U.carol, U.dave);
  try { assert.deepEqual(await mine(), a0, "the author blocking a down-voter"); } finally { await block(U.carol, U.dave, false); }
  assert.deepEqual(await mine(), a0);
  // a vote cast WHILE blocked (only possible with story_block_hide off) is theirs to see, never counted - frozen when cast:
  // unblocking doesn't make it count (the counts would jump); voting again after the unblock does
  await setCfg({ story_block_hide: false });
  try {
    await block(U.carol, U.frank);
    store._gaps.clear();
    r = await voteS(U.frank, S, 1);
    assert.deepEqual([r.status, r.d.vote, r.d.counted, r.d.ups], [200, 1, false, at[0]]);
    assert.equal((await itemOf(U.frank, MEM, S)).react.my, 1, "highlighted for them");
    await block(U.carol, U.frank, false);
    assert.deepEqual(await seen(), at, "unblocked: still not counted");
    store._gaps.clear(); await voteS(U.frank, S, 0);
    store._gaps.clear(); r = await voteS(U.frank, S, 1);
    assert.deepEqual([r.d.counted, r.d.ups], [true, at[0] + 1], "a vote cast after the unblock counts");
    store._gaps.clear(); await voteS(U.frank, S, 0);
    await CV.block("carolcf", "frank");
    store._gaps.clear(); r = await voteS(U.frank, S, 1);
    assert.equal(r.d.counted, false, "cam-blocked by the person on cam: not counted");
    await CV.unblock("carolcf", "frank");
    store._gaps.clear(); await voteS(U.frank, S, 0);
  } finally { await setCfg({ story_block_hide: true }); await block(U.carol, U.frank, false); await CV.unblock("carolcf", "frank"); }
});

test("votes never touch the feed: no feed_votes rows, no achievement pokes", async () => {
  const poke = achievements.poke;
  let pokes = 0;
  achievements.poke = () => { pokes++; };
  try {
    store._gaps.clear();
    assert.equal((await voteS(U.eve, R.UP_MEM, 1)).status, 200);
    store._gaps.clear();
    assert.equal((await voteS(U.frank, R.UP_MEM, 1)).status, 200);
  } finally { achievements.poke = poke; }
  assert.equal(pokes, 0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM feed_votes"))[0].n, 0);
  assert.ok((await getQuery("SELECT COUNT(*) AS n FROM story_votes WHERE story_id = ?", [R.UP_MEM]))[0].n >= 2);
});

// ───────────────────────────── 4. tips ─────────────────────────────
test("a story tip is a normal tip: full amount, two ledger rows, the story_tips tag, replay-safe, the notice links the pad (never /media)", async () => {
  const before = await ledgerCount();
  const r = await tipS(U.bob, R.UP_MEM, { amount: "2,500", note: "  nice   one ", idempotency_key: "k1" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.deepEqual([r.d.amount, r.d.balance, r.d.tips.n, r.d.tips.total], [2500, 97500, 1, 2500]);
  const rows = await getQuery("SELECT userId, type, points FROM transactions ORDER BY rowid DESC LIMIT 2");
  assert.deepEqual(rows.map((x) => [x.userId, x.type, x.points]).sort(), [[U.alice.userId, "tip received", 2500], [U.bob.userId, "tip sent", -2500]].sort());
  const tag = (await getQuery("SELECT * FROM story_tips WHERE ref = ?", ["bob:k1"]))[0];
  assert.deepEqual([tag.story_id, tag.sender_id, tag.recipient_id, tag.amount, tag.note, tag.role, tag.room_id, tag.story_kind, tag.story_source],
                   [R.UP_MEM, U.bob.userId, U.alice.userId, 2500, "nice one", "uploader", MEM, "photo", "user"]);
  const replay = await tipS(U.bob, R.UP_MEM, { amount: "2,500", note: "nice one", idempotency_key: "k1" });
  assert.equal(replay.d.replayed, true);
  assert.equal(await ledgerCount(), before + 2, "one transfer");
  const n = (await getQuery("SELECT * FROM inbox WHERE user_id = ? AND ref = ?", [U.alice.userId, "storytip:bob:k1"]))[0];
  assert.deepEqual([n.kind, n.title, n.body], ["tip", "bob tipped your story PAT 2,500", "\"nice one\""]);
  assert.equal(n.link, require(path.join(repo, "pads")).padHref(rooms.getCached(MEM)));
  assert.ok(!/\/media\//.test(n.link));
  // the tally on the story, for everyone who can see it
  assert.deepEqual((await itemOf(U.eve, MEM, R.UP_MEM)).react.tips, { n: 1, total: 2500 });
  // a profile story -> /u/<them>; a snap / clip / recording of you; a stage snap / clip of your stream
  store._gaps.clear();
  await tipS(U.bob, R.UP_PROF, { amount: 10, idempotency_key: "k2" });
  const np = (await getQuery("SELECT * FROM inbox WHERE ref = ?", ["storytip:bob:k2"]))[0];
  assert.deepEqual([np.link, np.body], ["/u/alice", "On your story"]);
  const cases = [[R.CAM_C, U.carol, "a snap of you"], [R.CAM_C_CLIP, U.carol, "a clip of you"], [R.CAM_C_AUDIO, U.carol, "a recording of you"],
                 [R.STG_OWN, U.streamer, "a snap of your stream"], [R.STG_CLIP, U.streamer, "a clip of your stream"]];
  let k = 3;
  for (const [id, who, what] of cases) {
    store._gaps.clear();
    const key = "k" + (k++);
    const t = await tipS(U.bob, id, { amount: 100, idempotency_key: key });
    assert.equal(t.status, 200, id + " " + JSON.stringify(t.d));
    const m = (await getQuery("SELECT * FROM inbox WHERE ref = ?", ["storytip:bob:" + key]))[0];
    assert.equal(m.user_id, who.userId, "the person in it / the streamer gets it - never the capturer");
    assert.equal(m.title, `bob tipped ${what} PAT 100`);
    assert.equal(m.body, "In Members Pond");
    assert.ok(!/\/media\//.test(m.link));
  }
});

test("tip refusals happen before any PAT moves; the transfer never runs inside a transaction; the D-9 cap", async () => {
  const before = await ledgerCount();
  const refuse = async (u, id, status, error, tag) => {
    store._gaps.clear();
    const r = await tipS(u, id, { amount: 10 });
    assert.equal(r.status, status, tag + " " + JSON.stringify(r.d));
    if (error) assert.equal(r.d.error, error, tag);
  };
  await refuse(U.alice, R.UP_MEM, 400, "You can't tip your own story.", "self");
  for (const id of [R.CAM_ANON, R.CAM_PRIV, R.CAM_SHY, R.CAM_HID, R.CAM_AUTO, R.STG_PEPE, R.STG_LIB, R.CAM_PEPE, R.CAM_C_APP]) {
    await refuse(U.bob, id, 400, "This story can't be tipped.", id);
  }
  await refuse(U.eve, R.UP_APP, 404, "This story isn't available any more.", "not visible");
  await refuse(U.bob, R.G_EXP, 404, "This story isn't available any more.", "expired");
  store._gaps.clear();
  assert.equal((await tipS(U.bob, R.UP_MEM, { amount: "lots" })).d.error, "Use a number like 2500, 25k or 1.5m.");
  assert.equal((await tipS(U.bob, R.UP_MEM, { amount: "0.5" })).d.error, "Tip at least 1 PAT.");
  // blocks either way + the cam owner's cam block (with D-3 on the story is hidden: 404; off: a neutral refusal naming the story's name)
  await block(U.carol, U.bob);
  try { await refuse(U.bob, R.CAM_C, 404, null, "D-3 hides it"); } finally { await block(U.carol, U.bob, false); }
  await setCfg({ story_block_hide: false });
  try {
    for (const [a, b] of [[U.carol, U.bob], [U.bob, U.carol]]) {
      await block(a, b);
      try { await refuse(U.bob, R.CAM_C, 403, "You can't tip Carol C.", a.username + " blocked"); } finally { await block(a, b, false); }
    }
    await CV.block("carolcf", "bob");
    try { await refuse(U.bob, R.CAM_C, 403, "You can't tip Carol C.", "cam block"); } finally { await CV.unblock("carolcf", "bob"); }
  } finally { await setCfg({ story_block_hide: true }); }
  assert.equal(await ledgerCount(), before, "nothing moved");
  // not inside a dbUtils.tx (transferPat's ledger rows self-wrap; side effects must not inherit a transaction)
  const orig = tips.transferPat;
  let inside = null;
  tips.transferPat = async (...a) => { inside = inTx(); return orig(...a); };
  try { store._gaps.clear(); assert.equal((await tipS(U.eve, R.UP_MEM, { amount: 5 })).status, 200); } finally { tips.transferPat = orig; }
  assert.equal(inside, false);
  // D-9: a per-sender hourly cap (staff exempt)
  await setCfg({ story_tips_per_hour: 1 });
  try {
    store._gaps.clear();
    const r = await tipS(U.eve, R.UP_MEM, { amount: 5 });
    assert.deepEqual([r.status, r.d.error], [429, "You've sent a lot of story tips this hour - try again later."]);
    await runQuery("UPDATE users SET points_balance = 1000 WHERE userId = ?", [U.staffy.userId]);
    store._gaps.clear(); assert.equal((await tipS(U.staffy, R.UP_MEM, { amount: 1 })).status, 200);
    store._gaps.clear(); assert.equal((await tipS(U.staffy, R.UP_MEM, { amount: 1 })).status, 200, "staff: no cap");
  } finally { await setCfg({ story_tips_per_hour: 30 }); }
  // the 1.5 s gap
  store._gaps.clear();
  assert.equal((await tipS(U.frank, R.UP_MEM, { amount: 1 })).status, 200);
  assert.equal((await tipS(U.frank, R.UP_MEM, { amount: 1 })).status, 429);
});

test("a tip NOTE to someone on cam / on stage follows the DM rules (the tip can go without it); a per-person daily cap", async () => {
  const before = await ledgerCount();
  const tip = async (u, id, body) => { store._gaps.clear(); return tipS(u, id, Object.assign({ amount: 1 }, body)); };
  await dm.setPrefs(U.carol.userId, { who: "nobody" });
  try {
    let r = await tip(U.frank, R.CAM_C, { note: "I know where you live" });
    assert.deepEqual([r.status, r.d.code, r.d.error], [403, "note", "You can't add a note for Carol C - send the tip without one."]);
    r = await tip(U.dave, R.CAM_C, { note: "hi" });
    assert.equal(r.d.code, "note", "the new-account rule too");
    assert.equal(await ledgerCount(), before, "refused before any PAT moved");
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = ? AND body LIKE '%where you live%'", [U.carol.userId]))[0].n, 0);
    r = await tip(U.frank, R.CAM_C, {});
    assert.equal(r.status, 200, "without a note the tip goes: " + JSON.stringify(r.d));
    await dm.setPrefs(U.streamer.userId, { who: "nobody" });
    try { assert.equal((await tip(U.frank, R.STG_OWN, { note: "hey" })).d.code, "note", "a streamer's stage capture too"); }
    finally { await dm.setPrefs(U.streamer.userId, { who: "everyone" }); }
    // an uploader posted the story themselves: notes stay like post tips (no DM rule)
    await dm.setPrefs(U.alice.userId, { who: "nobody" });
    try { assert.equal((await tip(U.frank, R.UP_MEM, { note: "great story" })).status, 200); }
    finally { await dm.setPrefs(U.alice.userId, { who: "everyone" }); }
  } finally { await dm.setPrefs(U.carol.userId, { who: "everyone" }); }
  // who = everyone again: the note goes
  assert.equal((await tip(U.frank, R.CAM_C_CLIP, { note: "nice clip" })).status, 200);
  // the per-person daily cap (captures only; staff exempt; another person isn't affected)
  await setCfg({ story_capture_tips_per_person_per_day: 2 });
  try {
    const r = await tip(U.frank, R.CAM_C_AUDIO, {});
    assert.deepEqual([r.status, r.d.error], [429, "You've tipped Carol C a lot today - try again tomorrow."]);
    assert.equal((await tip(U.frank, R.STG_OWN, {})).status, 200, "someone else on cam / stage");
    assert.equal((await tip(U.frank, R.UP_MEM, {})).status, 200, "uploads aren't capped per person");
    await runQuery("UPDATE users SET points_balance = 1000 WHERE userId = ?", [U.staffy.userId]);
    for (let i = 0; i < 3; i++) assert.equal((await tip(U.staffy, R.CAM_C, {})).status, 200, "staff: no cap");
  } finally { await setCfg({ story_capture_tips_per_person_per_day: 10 }); }
});

test("blocks fail CLOSED: a block lookup that errors hides the stories (own uploads stay) and refuses every action", async () => {
  const orig = dm.cardBlocks, origB = dm.blocked;
  const strip = async (u) => (await stories.forViewer(V(u), {})).flatMap((r) => r.items || []);
  assert.ok((await strip(U.bob)).some((x) => x.id === R.UP_MEM));
  dm.cardBlocks = async () => { throw new Error("SQLITE_BUSY: database is locked"); };
  const before = await ledgerCount();
  try {
    const items = await strip(U.bob);
    assert.ok(items.length > 0 && items.every((x) => x.source === "user" && x.by === "Bob B"), "only bob's own uploads: " + items.map((x) => x.id));
    assert.ok(!(await itemsOf(U.bob, MEM)).some((x) => x.id === R.UP_MEM), "the pad's viewer");
    const th = await web.captures(MEM, 24, V(U.bob));
    assert.ok(th.length > 0 && th.every((x) => x.source === "user" && x.by === "Bob B"), "the pad's thumbnails");
    assert.deepEqual(await US.people(V(U.bob), [U.alice.userId, U.carol.userId]), [], "person circles");
    store._gaps.clear();
    assert.notEqual((await voteS(U.bob, R.UP_MEM, -1)).status, 200, "no vote");
    store._gaps.clear();
    assert.notEqual((await tipS(U.bob, R.UP_MEM, { amount: 5 })).status, 200, "no tip");
    assert.notEqual((await replyS(U.bob, R.UP_MEM, { body: "x" })).status, 200, "no reply");
    assert.equal(await ledgerCount(), before, "nothing moved");
  } finally { dm.cardBlocks = orig; }
  // the tip's own two-way check (messages.blocked) erroring
  dm.blocked = async () => { throw new Error("SQLITE_BUSY"); };
  try {
    store._gaps.clear();
    assert.equal((await tipS(U.frank, R.UP_MEM, { amount: 5, note: "you can't block me" })).status, 500);
    assert.equal(await ledgerCount(), before, "nothing moved");
  } finally { dm.blocked = origB; }
  assert.ok((await strip(U.bob)).some((x) => x.id === R.UP_MEM), "back once the lookup works");
});

// ───────────────────────────── 5. replies ─────────────────────────────
function sseTap(u) {
  const lines = [];
  dm._streams.set(u.userId, new Set([{ write: (s) => { lines.push(s); } }]));
  return lines;
}
test("a reply is an ordinary DM with the reply text as its body + one story reference; nothing in any payload points at the media", async () => {
  const tapA = sseTap(U.alice), tapB = sseTap(U.bob);
  const r = await replyS(U.bob, R.UP_MEM, { body: "nice!" });
  dm._streams.delete(U.alice.userId); dm._streams.delete(U.bob.userId);
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.created, true);
  const m = await lastMsg(U.bob);
  assert.equal(m.body, "nice!");
  assert.equal(r.d.conversation, m.conversation_id);
  const ref = await refOf(m.id);
  assert.deepEqual([ref.story_id, ref.sender_id, ref.author_id, ref.role, ref.opened, ref.quick, ref.room_id, ref.room_title, ref.author_name],
                   [R.UP_MEM, U.bob.userId, U.alice.userId, "uploader", 1, 0, MEM, "Members Pond", "Alice A"]);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM dm_story_refs WHERE message_id = ?", [m.id]))[0].n, 1);
  // each reader's card
  const ha = await historyOf(U.alice, m.conversation_id), hb = await historyOf(U.bob, m.conversation_id);
  const ca = ha.find((x) => x.id === m.id).story, cb = hb.find((x) => x.id === m.id).story;
  assert.deepEqual({ ...ca, left: ca.left > 0 }, { gone: false, mine: false, role: "uploader", kind: "photo", source: "user", quick: false, name: "Alice A",
                                                   pad: { title: "Members Pond" }, thumb: `/messages/story/${m.id}/thumb`, nsfw: false, left: true });
  assert.equal(cb.mine, true);
  // the live events carry the card built for each reader
  const evA = tapA.map((l) => JSON.parse(l.replace(/^data: /, ""))).find((e) => e.t === "msg");
  const evB = tapB.map((l) => JSON.parse(l.replace(/^data: /, ""))).find((e) => e.t === "msg");
  assert.equal(evA.m.story.mine, false); assert.equal(evB.m.story.mine, true);
  const list = await dm.list(U.alice.userId);
  for (const [what, v] of [["send result", r.d], ["alice's history", ha], ["bob's history", hb], ["SSE", tapA.concat(tapB)], ["the list", list]]) {
    const s = JSON.stringify(v);
    assert.ok(!s.includes(R.UP_MEM), what + ": no media id");
    assert.ok(!s.includes("/media/"), what + ": no /media URL");
    assert.ok(!s.includes(".webp") && !s.includes(".jpg"), what + ": no file name");
  }
  assert.equal(list.find((c) => c.id === m.conversation_id).last.text, "nice!", "the preview is the reply text");
  assert.equal((await preS(U.bob, R.UP_MEM)).d.canSend, true);
});

test("replies: quick reactions (allowed emoji only), never yourself, never Pepe, and the preflight never names the account", async () => {
  let r = await replyS(U.bob, R.UP_MEM, { body: "🔥", quick: true });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const m = await lastMsg(U.bob);
  assert.equal(m.body, "🔥");
  assert.equal((await refOf(m.id)).quick, 1);
  r = await replyS(U.bob, R.UP_MEM, { body: "hello", quick: true });
  assert.deepEqual([r.status, r.d.error], [400, "Pick one of the quick reactions."]);
  r = await replyS(U.alice, R.UP_MEM, { body: "me" });
  assert.deepEqual([r.status, r.d.error, r.d.code], [400, "You can't reply to your own story.", "self"]);
  for (const id of [R.CAM_PEPE, R.STG_PEPE, R.CAM_ANON, R.CAM_PRIV]) {
    r = await replyS(U.bob, id, { body: "hi" });
    assert.deepEqual([r.status, r.d.error], [403, "You can't reply to this story."], id);
  }
  const p = await preS(U.bob, R.CAM_C);
  assert.deepEqual(Object.keys(p.d).sort(), ["canSend", "code", "ok", "refusal"]);
  assert.ok(!p.text.includes("u_carol") && !p.text.includes("carol\""));
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pepe_dm_jobs"))[0].n, 0, "never a paid answer from Pepe");
});

test("refusal parity: a story reply is refused exactly like the DM (status, code, text with the story's name)", async () => {
  // carol is "Carolyn" on PATV and "Carol C" in the story; frank has no conversation with her
  const same = async (sender, label, fix) => {
    const a = await replyS(sender, R.CAM_C, { body: "hey" });
    if (fix) await fix();
    const b = await dmSend(sender, U.carol, "hey");
    assert.notEqual(a.status, 200, label + ": refused");
    assert.equal(a.status, b.status, label + ": status");
    assert.equal(a.d.code, b.d.code, label + ": code");
    assert.equal(a.d.error, String(b.d.error).split("Carolyn").join("Carol C"), label + ": text");
    const p = await preS(sender, R.CAM_C);
    if (b.d.code !== "rate") assert.deepEqual([p.d.canSend, p.d.refusal, p.d.code], [false, a.d.error, a.d.code], label + ": the preflight says the same");
  };
  await dm.setPrefs(U.carol.userId, { who: "nobody" });
  await same(U.frank, "who = nobody");
  await dm.setPrefs(U.carol.userId, { who: "following" });
  await same(U.frank, "who = following");
  await dm.setPrefs(U.carol.userId, { who: "everyone" });
  await same(U.dave, "the new-account rule");
  await setCfg({ story_block_hide: false });
  try {
    await block(U.carol, U.frank); await same(U.frank, "blocked by them"); await block(U.carol, U.frank, false);
    await block(U.frank, U.carol); await same(U.frank, "blocked by you"); await block(U.frank, U.carol, false);
  } finally { await setCfg({ story_block_hide: true }); }
  await runQuery("UPDATE users SET archived_at = 1 WHERE userId = ?", [U.frank.userId]);
  try { await same(U.frank, "archived sender"); } finally { await runQuery("UPDATE users SET archived_at = NULL WHERE userId = ?", [U.frank.userId]); }
  await runQuery("INSERT INTO feed_bans (user_id, room_id, until) VALUES (?, '', NULL)", [U.frank.userId]);
  try { await same(U.frank, "global feed ban"); } finally { await runQuery("DELETE FROM feed_bans WHERE user_id = ?", [U.frank.userId]); }
  // new conversations a day (the DM's cap)
  const cap = dm.LIMITS.convos_per_day;
  dm.LIMITS.convos_per_day = 0;
  try { await same(U.frank, "new conversations a day"); } finally { dm.LIMITS.convos_per_day = cap; }
  // the send gap (no clock tick between the two)
  tick();
  assert.equal((await call("POST", "/api/messages/send", U.frank, { to: "eve", body: "x" })).status, 200);
  const a = await call("POST", `/api/stories/${R.CAM_C}/reply`, U.frank, { body: "hey" });
  dm._gaps.clear();
  assert.equal((await call("POST", "/api/messages/send", U.frank, { to: "eve", body: "y" })).status, 200);
  const b = await call("POST", "/api/messages/send", U.frank, { to: "carol", body: "hey" });
  assert.deepEqual([a.status, a.d.code, a.d.error], [b.status, b.d.code, b.d.error], "the rate refusal");
  assert.equal(a.status, 429);
});

test("D-12: replies that START conversations with people on cam are capped per day (existing conversations don't count)", async () => {
  await setCfg({ story_capture_new_convos_per_day: 1 });
  try {
    const n0 = (await getQuery("SELECT COUNT(*) AS n FROM dm_story_refs WHERE sender_id = ? AND opened = 1", [U.eve.userId]))[0].n;
    assert.equal(n0, 0);
    assert.equal((await replyS(U.eve, R.CAM_C, { body: "hi carol" })).status, 200);
    const first = await lastMsg(U.eve);
    const r = await replyS(U.eve, R.CAM_TWIN, { body: "hi twin" });
    assert.deepEqual([r.status, r.d.code, r.d.error], [429, "rate", "You can start 1 conversation a day by replying to snaps and clips - try again tomorrow."]);
    assert.equal((await replyS(U.eve, R.CAM_C_CLIP, { body: "again" })).status, 200, "an existing conversation");
    assert.equal((await replyS(U.eve, R.UP_MEM, { body: "to alice" })).status, 200, "uploads aren't capped");
    // deleting the reply that opened the conversation doesn't give the day's slot back (its alerts already went out): a
    // story-less stub stays for the cap, and goes a day later
    await dm.deleteMessage(V(U.eve), first.id);
    const stub = await refOf(first.id);
    assert.deepEqual([stub.story_id, stub.author_id, stub.author_name, stub.room_id, stub.room_title, stub.story_kind, stub.opened, stub.role],
                     ["", null, null, null, null, null, 1, "subject"], "nothing about the story is kept");
    assert.equal((await replyS(U.eve, R.CAM_TWIN, { body: "hi twin" })).status, 429, "still capped");
    assert.equal(await cardOf(U.eve, first.id), undefined, "no card for the deleted reply");
    // the opposite: a reply that didn't open anything leaves no stub
    const second = await lastMsg(U.eve);
    await dm.deleteMessage(V(U.eve), second.id);
    assert.equal(await refOf(second.id), null);
    // the stub is swept after a day
    SR._setClock(() => Math.max(T, Date.now()) + 86400e3 + 60e3);          // (the messages' clock runs ahead in this file)
    try { assert.ok((await SR.sweep()).stubs >= 1); } finally { SR._setClock(null); }
    assert.equal(await refOf(first.id), null);
  } finally { await setCfg({ story_capture_new_convos_per_day: 10 }); }
});

test("the reference is written in the same transaction as the message: a failing ref leaves no message (and no new, empty conversation)", async () => {
  const before = (await getQuery("SELECT COUNT(*) AS n FROM messages"))[0].n;
  await mkUser("gina", { camfrog: "ginacf" });
  const orig = SR.insertRef;
  SR.insertRef = async () => { throw new Error("boom"); };
  let r, r2;
  try {
    r = await replyS(U.frank, R.UP_MEM, { body: "lost" });
    r2 = await replyS(U.gina, R.UP_MEM, { body: "first words" });          // gina has no conversation with alice yet
  } finally { SR.insertRef = orig; }
  assert.equal(r.status, 500);
  assert.equal(r2.status, 500);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM messages"))[0].n, before);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM messages WHERE body IN ('lost', 'first words')"))[0].n, 0);
  assert.equal(await dm.dmBetween(U.gina.userId, U.alice.userId), null, "the conversation it would have opened isn't left behind");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM conversation_members WHERE user_id = ?", [U.gina.userId]))[0].n, 0);
  // and with the ref working, the same reply opens it
  tick();
  assert.equal((await replyS(U.gina, R.UP_MEM, { body: "first words" })).d.created, true);
});

// ───────────────────────────── 6. the card ─────────────────────────────
test("the card re-checks for each reader: one identical {gone:true} for expired / deleted / access lost / 18+ / a later block", async () => {
  const send = async (u, id, body) => { const r = await replyS(u, id, { body }); assert.equal(r.status, 200, JSON.stringify(r.d)); return (await lastMsg(u)).id; };
  const gone = (c) => assert.equal(JSON.stringify(c), "{\"gone\":true}");
  // Approved pad: bob loses access -> his card is gone, alice's stays
  const m1 = await send(U.bob, R.UP_APP, "inside");
  assert.equal((await cardOf(U.bob, m1)).gone, false);
  await PA.remove(V(U.padowner), await rooms.get(APP), U.bob.userId);
  try {
    gone(await cardOf(U.bob, m1));
    assert.equal((await cardOf(U.alice, m1)).gone, false);
  } finally { await PA.decide(V(U.padowner), await rooms.get(APP), U.bob.userId, true); }
  assert.equal((await cardOf(U.bob, m1)).gone, false);
  // 18+: switched on, both members unconfirmed
  const m2 = await send(U.bob, R.UP_ADL, "late");
  await setAdult(true);
  try { gone(await cardOf(U.bob, m2)); gone(await cardOf(U.alice, m2)); } finally { await setAdult(false); }
  // the author blocks the sender afterwards: gone for the sender (D-3), collapsed (no card) for the author
  const m3 = await send(U.frank, R.UP_MEM, "hey alice");
  await block(U.alice, U.frank);
  try {
    gone(await cardOf(U.frank, m3));
    assert.equal(await cardOf(U.alice, m3), null, "a blocked sender's message has no card");
  } finally { await block(U.alice, U.frank, false); }
  // expired, deleted
  const e1 = await row({ source: "user", by: "Alice A", byId: U.alice.userId });
  const e2 = await row({ source: "user", by: "Alice A", byId: U.alice.userId });
  const m4 = await send(U.bob, e1, "soon gone");
  const m5 = await send(U.bob, e2, "deleted soon");
  await runQuery("UPDATE media SET expires = ? WHERE id = ?", [Date.now() - 1000, e1]);
  await runQuery("UPDATE media SET deleted = 1 WHERE id = ?", [e2]);
  for (const [u, mid] of [[U.bob, m4], [U.alice, m4], [U.bob, m5], [U.alice, m5]]) gone(await cardOf(u, mid));
  // the author's account deleted later (author_id cleared)
  await runQuery("UPDATE dm_story_refs SET author_id = NULL WHERE message_id = ?", [m1]);
  gone(await cardOf(U.bob, m1));
});

test("deleting a reply drops its reference (kept when reported - the admin sees the story's context, never its media)", async () => {
  await replyS(U.bob, R.UP_MEM, { body: "oops" });
  const a = await lastMsg(U.bob);
  await dm.deleteMessage(V(U.bob), a.id);
  assert.equal(await refOf(a.id), null);
  assert.equal(await cardOf(U.bob, a.id), undefined, "no card on a deleted message");
  await replyS(U.bob, R.CAM_C, { body: "rude words" });
  const b = await lastMsg(U.bob);
  await dm.report(V(U.carol), b.id, { reason: "harassment" });
  await dm.deleteMessage(V(U.bob), b.id);
  assert.ok(await refOf(b.id), "reported: kept");
  assert.equal(await cardOf(U.carol, b.id), null);
  const d = await dm.reportDetail(V(U.boss), b.id);
  assert.deepEqual({ ...d.context.story, created: !!d.context.story.created },
                   { kind: "photo", source: "cam", padTitle: "Members Pond", author: "Carol C", created: true });
  assert.ok(!JSON.stringify(d).includes(R.CAM_C) && !JSON.stringify(d).includes("/media/"));
});

// ───────────────────────────── 7. the thumbnail + "open" routes ─────────────────────────────
test("thumb / open: members of the conversation who may see the story now; everything else is the same bare 404", async () => {
  await replyS(U.bob, R.UP_MEM, { body: "thumb test" });
  const m = await lastMsg(U.bob);
  const thumb = (u) => call("GET", `/messages/story/${m.id}/thumb`, null, undefined, u ? { "x-test-user": u.userId } : {});
  let r = await thumb(U.alice);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("cache-control"), /private/); assert.match(r.headers.get("cache-control"), /no-store/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.match(r.headers.get("content-security-policy"), /sandbox/);
  assert.match(r.headers.get("x-robots-tag"), /noindex/);
  assert.equal(r.headers.get("content-type"), "image/webp");
  const o = await call("GET", `/api/messages/m/${m.id}/story`, U.alice);
  assert.deepEqual(o.d, { ok: true, room: MEM, item: R.UP_MEM });
  // a clip's card shows its poster
  await replyS(U.bob, R.CAM_C_CLIP, { body: "clip" });
  const mc = await lastMsg(U.bob);
  const rc = await call("GET", `/messages/story/${mc.id}/thumb`, null, undefined, { "x-test-user": U.carol.userId });
  assert.deepEqual([rc.status, rc.headers.get("content-type")], [200, "image/webp"]);
  const nope = async (label, u) => {
    const x = await thumb(u);
    assert.deepEqual([x.status, x.text], [404, ""], label);
    const y = await call("GET", `/api/messages/m/${m.id}/story`, u);
    assert.ok(y.status === 404 || y.status === 401, label + " (open)");
    if (y.status === 404) assert.deepEqual(y.d, { ok: false, gone: true });
  };
  await nope("not a member", U.eve);
  await nope("signed out", null);
  await runQuery("UPDATE conversation_members SET left_at = 1 WHERE conversation_id = ? AND user_id = ?", [m.conversation_id, U.alice.userId]);
  try { await nope("left", U.alice); } finally { await runQuery("UPDATE conversation_members SET left_at = NULL WHERE conversation_id = ? AND user_id = ?", [m.conversation_id, U.alice.userId]); }
  const cm = (await getQuery("SELECT cleared_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?", [m.conversation_id, U.alice.userId]))[0].cleared_id;
  await runQuery("UPDATE conversation_members SET cleared_id = ? WHERE conversation_id = ? AND user_id = ?", [m.id, m.conversation_id, U.alice.userId]);
  try { await nope("cleared", U.alice); } finally { await runQuery("UPDATE conversation_members SET cleared_id = ? WHERE conversation_id = ? AND user_id = ?", [cm, m.conversation_id, U.alice.userId]); }
  assert.equal((await thumb(U.alice)).status, 200);
  const exp = (await getQuery("SELECT expires FROM media WHERE id = ?", [R.UP_MEM]))[0].expires;
  await runQuery("UPDATE media SET expires = ? WHERE id = ?", [Date.now() - 1, R.UP_MEM]);
  try { await nope("story expired", U.alice); } finally { await runQuery("UPDATE media SET expires = ? WHERE id = ?", [exp, R.UP_MEM]); }
  await dm.deleteMessage(V(U.bob), m.id);
  await nope("message deleted", U.alice);
  assert.equal((await call("GET", "/messages/story/abc/thumb", U.alice)).status, 404);
});

// ───────────────────────────── 8. alerts ─────────────────────────────
test("alerts: the DM's own (Camfrog queue, Telegram with the reply text only, content-free push); muted = none; a tip's notice is kind 'tip'", async () => {
  tgCalls.length = 0; pushCalls.length = 0;
  const conv0 = await dm.dmBetween(U.frank.userId, U.carol.userId);
  const pend = async (c) => ((await getQuery("SELECT pending FROM dm_alerts WHERE user_id = ? AND conversation_id = ?", [U.carol.userId, c]))[0] || { pending: 0 }).pending;
  const p0 = conv0 ? await pend(conv0.id) : 0;
  const r = await replyS(U.frank, R.CAM_C, { body: "hey carol" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(await pend(r.d.conversation), p0 + 1, "Pepe's Camfrog alert is queued (carol is linked)");
  const tg = tgCalls.find((c) => c.uid === U.carol.userId);
  assert.equal(tg.o.text, "hey carol");
  assert.ok(!JSON.stringify(tg).includes("/media/") && !JSON.stringify(tg).includes("Members Pond") && !JSON.stringify(tg).includes(R.CAM_C));
  assert.deepEqual(Object.keys(pushCalls.find((c) => c.uid === U.carol.userId).o).sort(), ["conversationId", "messageId"]);
  // Pepe claims it after the grace: the DM's own alert, quoting the reply text only
  tick(11 * 60e3);
  const mineOnly = (list) => list.filter((a) => a.login === "carolcf" && String(a.id).startsWith(r.d.conversation + ":"));
  const claimed = mineOnly(await dm.claimAlerts({ limit: 200 }));
  assert.equal(claimed.length, 1);
  assert.match(claimed[0].text, /hey carol/);
  assert.ok(!/\/media\/|Members Pond|snap|story/i.test(claimed[0].text), "the alert never names the story, pad or media");
  // muted: no alert at all - Camfrog, Telegram (send() hands a 1:1's real mute over now) or push
  await dm.setMute(V(U.carol), r.d.conversation, true);
  tgCalls.length = 0; pushCalls.length = 0;
  assert.equal((await replyS(U.frank, R.CAM_C_CLIP, { body: "again" })).status, 200);
  tick(11 * 60e3);
  assert.equal(mineOnly(await dm.claimAlerts({ limit: 200 })).length, 0, "muted: no Camfrog alert");
  assert.equal(tgCalls.filter((c) => c.uid === U.carol.userId).length, 0, "muted: no Telegram alert");
  assert.equal(pushCalls.filter((c) => c.uid === U.carol.userId).length, 0, "muted: no push");
  await dm.setMute(V(U.carol), r.d.conversation, false);
  assert.equal((await replyS(U.frank, R.CAM_C_AUDIO, { body: "unmuted" })).status, 200);
  assert.equal(tgCalls.filter((c) => c.uid === U.carol.userId).length, 1, "unmuted: Telegram again");
  const n = (await getQuery("SELECT kind FROM inbox WHERE ref LIKE 'storytip:%' LIMIT 1"))[0];
  assert.equal(n.kind, "tip");
});

// ───────────────────────────── 9. the profile setting ─────────────────────────────
test("the subject's opt-out (capture_reacts): partial prefs update, the whole bar goes on captures of them, old votes hidden then back", async () => {
  store._gaps.clear();
  assert.equal((await voteS(U.bob, R.CAM_C_AUDIO, 1)).status, 200);
  const r = await call("POST", "/api/stories/prefs", U.carol, { captureReacts: false });
  assert.deepEqual(r.d.prefs, { capturesOfMe: true, captureReacts: false }, "the other setting keeps its value");
  const it = (await itemOf(U.eve, MEM, R.CAM_C_AUDIO)).react;
  assert.deepEqual([it.votes, it.ups, it.can.tip, it.can.reply], [false, 0, false, false]);
  assert.equal((await voteS(U.eve, R.CAM_C_AUDIO, 1)).d.error, "Votes are off for this story.");
  await call("POST", "/api/stories/prefs", U.carol, { captureReacts: true });
  assert.equal((await itemOf(U.eve, MEM, R.CAM_C_AUDIO)).react.ups, 1, "the old vote is back");
  assert.deepEqual(await US.prefs(U.carol.userId), { capturesOfMe: true, captureReacts: true });
  // an uploader can't opt out of their own uploads
  await call("POST", "/api/stories/prefs", U.alice, { captureReacts: false });
  try { assert.equal((await itemOf(U.bob, MEM, R.UP_MEM)).react.votes, true); } finally { await call("POST", "/api/stories/prefs", U.alice, { captureReacts: true }); }
});

// ───────────────────────────── 10. lifecycle ─────────────────────────────
test("merge: story votes fold (one per story), tips / refs move, capture_reacts OFF wins", async () => {
  await mkUser("oldx", { camfrog: "oldxcf" }); await mkUser("newx", { camfrog: "newxcf" });
  const t = Date.now();
  await runQuery("INSERT INTO story_votes (story_id, user_id, value, w, created, updated) VALUES (?, 'u_oldx', 1, 1, ?, ?), (?, 'u_newx', -1, 1, ?, ?), (?, 'u_oldx', 1, 1, ?, ?)",
                 [R.UP_PUB, t, t, R.UP_PUB, t, t, R.CAM_C, t, t]);
  await runQuery("INSERT INTO story_prefs (user_id, captures_of_me, capture_reacts, updated) VALUES ('u_oldx', 1, 0, 1), ('u_newx', 1, 1, 1)");
  await runQuery(`INSERT INTO story_tips (story_id, sender_id, recipient_id, amount, role, created) VALUES (?, 'u_oldx', 'u_alice', 5, 'uploader', 1), (?, 'u_bob', 'u_oldx', 5, 'subject', 1)`, [R.UP_MEM, R.CAM_C]);
  await runQuery(`INSERT INTO dm_story_refs (message_id, conversation_id, story_id, sender_id, author_id, role, author_name, created) VALUES (900001, 'cx', ?, 'u_oldx', 'u_newx', 'uploader', 'Old X', 1),
                  (900002, 'cx', ?, 'u_bob', 'u_oldx', 'subject', 'Old X', 1)`, [R.UP_MEM, R.CAM_C]);
  const AM = require(path.join(repo, "accountMerge"));
  const out = await tx(() => AM.moveUserRows("u_oldx", "u_newx"));
  assert.deepEqual(out.unclassified, []);
  assert.deepEqual((await getQuery("SELECT user_id, value FROM story_votes WHERE story_id = ? AND user_id IN ('u_oldx', 'u_newx')", [R.UP_PUB])).map((x) => [x.user_id, x.value]),
                   [["u_newx", -1]], "the duplicate folds into the target's");
  assert.equal((await getQuery("SELECT user_id FROM story_votes WHERE story_id = ? AND user_id = 'u_newx'", [R.CAM_C])).length, 1);
  assert.equal((await getQuery("SELECT capture_reacts FROM story_prefs WHERE user_id = 'u_newx'"))[0].capture_reacts, 0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_tips WHERE sender_id = 'u_newx' OR recipient_id = 'u_newx'"))[0].n, 2);
  assert.deepEqual((await getQuery("SELECT sender_id, author_id FROM dm_story_refs WHERE message_id IN (900001, 900002) ORDER BY message_id")).map((x) => [x.sender_id, x.author_id]),
                   [["u_newx", "u_newx"], ["u_bob", "u_newx"]]);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_votes WHERE user_id = 'u_oldx'"))[0].n, 0);
});

// (the deletion job itself runs on a full schema: test/story-react-lifecycle.test.js)
test("export lists the story sections (received tips without sender / note, story replies as metadata); delete covers the new rows", async () => {
  const D = require(path.join(repo, "accountdelete"));
  assert.ok(D.DELETE_ROWS.some(([t, c]) => t === "story_votes" && c === "user_id"));
  assert.ok(D.DELETE_ROWS.some(([t, c]) => t === "dm_story_refs" && c === "sender_id"));
  await mkUser("goner", { camfrog: "gonercf" });
  const t = Date.now();
  await runQuery("INSERT INTO story_votes (story_id, user_id, value, w, created, updated) VALUES (?, 'u_goner', 1, 1, ?, ?)", [R.UP_MEM, t, t]);
  await runQuery("INSERT INTO story_tips (story_id, sender_id, recipient_id, amount, role, note, ref, created) VALUES (?, 'u_goner', 'u_alice', 7, 'uploader', 'hi', 'g1', 1), (?, 'u_bob', 'u_goner', 9, 'uploader', 'yo', 'g2', 1)", [R.UP_MEM, R.UP_MEM]);
  await runQuery(`INSERT INTO dm_story_refs (message_id, conversation_id, story_id, sender_id, author_id, role, author_name, room_title, created) VALUES
                  (900011, 'cg', ?, 'u_goner', 'u_alice', 'uploader', 'Alice A', 'Members Pond', 1), (900012, 'cg', ?, 'u_bob', 'u_goner', 'uploader', 'Goner', 'Members Pond', 1)`, [R.UP_MEM, R.UP_MEM]);
  await runQuery("INSERT INTO story_prefs (user_id, captures_of_me, capture_reacts, updated) VALUES ('u_goner', 1, 0, 1)");
  // export first (the account still exists)
  const X = require(path.join(repo, "accountexport"));
  await X.init();
  const d = await X.collect("u_goner");
  assert.equal(d.stories.votes.length, 1);
  assert.equal(d.stories.tips_sent.length, 1);
  assert.equal(d.stories.tips_received.length, 1);
  assert.ok(!("sender_id" in d.stories.tips_received[0]) && !("note" in d.stories.tips_received[0]), "received tips: no sender, no note");
  assert.equal(d.stories.settings[0].capture_reacts, 0);
  assert.equal(d.messages.story_replies.length, 1);
  for (const k of ["story_id", "author_id", "author_name"]) assert.ok(!(k in d.messages.story_replies[0]), "story replies: no " + k);
  assert.ok(!JSON.stringify(d).includes("Goner\""), "no name snapshot about anyone in their export");
});

test("sweep: votes on stories gone for over a week are dropped; live ones stay", async () => {
  const old = await row({ source: "user", by: "Alice A", byId: U.alice.userId, created: Date.now() - 9 * 86400e3, expires: Date.now() - 8 * 86400e3 });
  const t = Date.now();
  await runQuery("INSERT INTO story_votes (story_id, user_id, value, w, created, updated) VALUES (?, 'u_bob', 1, 1, ?, ?), ('ffffffff01', 'u_bob', 1, 1, ?, ?)", [old, t, t, t, t]);
  const live = (await getQuery("SELECT COUNT(*) AS n FROM story_votes WHERE story_id = ?", [R.UP_MEM]))[0].n;
  const r = await SR.sweep();
  assert.ok(r.votes >= 2);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_votes WHERE story_id IN (?, 'ffffffff01')", [old]))[0].n, 0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM story_votes WHERE story_id = ?", [R.UP_MEM]))[0].n, live);
});
