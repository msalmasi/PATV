// Offline tests for 1.99dr (aigen.js + bridge-relay.js; Pepe's half is camfrog-bot pepe_aigen._aigen_cam_refusal +
// aigen_test.py section 12b): a CAM SNAPSHOT from the pad's Camfrog room as the Generate panel's reference picture.
//   * the panel's "📷 From a cam in this room" lists only people on cam - never incognito / bridge-hidden ones (they
//     reach the site anonymised), never Pepe, never anyone when the room's cam snapshots are off or the pad has no room
//   * the bridge popover's frame -> "✨ Use in Generate": only a frame this account was shown, only fresh, only in its
//     own room; claimed into a private memory slot (never on disk / in the DB)
//   * pricing parity: the !imagine / !video price + the -cam surcharge, exactly like an uploaded reference
//   * the frame flows into the job: /start hands it to Pepe ONCE with ref_cam {room, login}; a cancelled job drops it
//   node --test test/aigen-camref.test.js      (needs the repo's node_modules; temp DB + dirs)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aigen-camref-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
process.env.FEED_NO_NICE = "1";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const web = require(path.join(repo, "feedweb"));
const AG = require(path.join(repo, "aigen"));
const relay = require(path.join(repo, "bridge-relay"));
require(path.join(repo, "terms"))._setRequired(false);

const ROOM = "plant_based_chatting", LOUNGE = "patv:lounge";
const BOT = "bot";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 7)]);
// the bridge's view of the room (what Pepe synced): hidden / incognito people arrive anonymised (bridge.js cleanUser)
const R = { id: ROOM, slug: "plant-based-chatting", cams: true, members: [
  { login: "PepeFrog", display: "PepeFrog", self: true, on_cam: true },
  { login: "tha_hussler", display: "Tha Hussler", on_cam: true },
  { login: "datdude315", display: "$htickie", on_cam: true },
  { login: "lurker1", display: "Lurky", on_cam: false },
  { anon: true, display: "someone", on_cam: true },
] };
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
  U.owner = await mkUser("plantowner", { camfrog: "foamy1111" });
  await rooms.init();
  await rooms.setOwner(ROOM, "plantowner", "test");
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, uploads_per_hour: 1000, post_gap_secs: 0, comment_gap_secs: 0 }, "test");
  await new Promise((r) => setTimeout(r, 100));               // actions.js creates pepe_actions on load
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  relay.register(app, { isBotToken: (t) => t === BOT, addUser, bySlug: (s) => (s === R.slug ? R : null), isLive: () => true });
  require(path.join(repo, "pads")).register(app);
  web.register(app, { addUser, isBotToken: (t) => t === BOT });
  AG.register(app, { addUser, isBotToken: (t) => t === BOT, noTimers: true, audit: async () => {} });
  require(path.join(repo, "bridge")).register(app, { addUser, isBotToken: (t) => t === BOT });     // the pad page (its relay routes are shadowed by ours)
  AG._setBridge((roomId) => (roomId === R.id ? R : null));
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await pepe("/api/feed/aigen/prices", { global: { imagine: 25000, video: 100000, camsurcharge: 10000 },
                                         rooms: { [ROOM]: { imagine: 40000, video: 150000, camsurcharge: 12000 } } });
});
test.after(() => { server.close(); });
test.beforeEach(async () => { store._gaps.clear(); relay._hits.clear(); });

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
async function clearJobs() {
  await runQuery("UPDATE feed_aigen_jobs SET status = 'discarded' WHERE status IN ('queued','running')");
  await runQuery("UPDATE pepe_actions SET status = 'done' WHERE status IN ('pending','claimed')").catch(() => {});
}
/** A viewer asks for a snapshot through the bridge and Pepe answers it (as pepe_relay._relay_snap does). */
async function snapshot(u, login) {
  const r = await post("/api/rooms/" + R.slug + "/snap", u, { login });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  if (r.d.id) {
    const job = relay.takeJobs(new Set([R.id])).find((j) => j.kind === "snap" && j.target === login);
    await pepe("/api/bridge/snap", { id: job.id, room: R.id, target: login, ok: true, status: "ok", data: JPEG.toString("base64") });
  }
  return (await get("/api/rooms/" + R.slug + "/snap/" + login, u)).d;
}

test("the cam list: on cam only, never incognito / hidden (anonymised), never Pepe; switches and pad kinds", async () => {
  assert.equal((await get("/api/feed/aigen/cams?pad=" + ROOM, null)).status, 401, "signed in only");
  const r = await get("/api/feed/aigen/cams?pad=" + ROOM, U.alice);
  assert.equal(r.status, 200);
  assert.deepEqual(r.d.cams.map((c) => c.login).sort(), ["datdude315", "tha_hussler"], JSON.stringify(r.d.cams));
  assert.ok(!JSON.stringify(r.d).includes("someone"), "an anonymised (incognito / bridge-hidden) person is never listed");
  assert.ok(!r.d.cams.some((c) => c.login === "lurker1"), "lurkers (off cam) aren't listed");
  assert.ok(!r.d.cams.some((c) => /pepe/i.test(c.login)), "Pepe's own cam isn't listed");
  assert.equal(r.d.slug, R.slug, "the slug the panel asks Pepe through");
  assert.equal(r.d.cams.find((c) => c.login === "tha_hussler").display, "Tha Hussler", "display names with spaces");
  R.cams = false;
  const off = await get("/api/feed/aigen/cams?pad=" + ROOM, U.alice);
  assert.deepEqual(off.d.cams, [], "the room's !bridge cams switched off -> nobody");
  assert.match(off.d.why, /aren't switched on/);
  R.cams = true;
  const lounge = await get("/api/feed/aigen/cams?pad=" + encodeURIComponent(LOUNGE), U.alice);
  assert.deepEqual(lounge.d.cams, [], "a site-only pad has no cams");
  assert.match(lounge.d.why, /Camfrog pad/);
});

test("Use in Generate: a fresh frame this account was shown, in its own room, of someone not opted out", async () => {
  await clearJobs();
  const s = await snapshot(U.alice, "tha_hussler");
  assert.equal(s.state, "ok");
  assert.ok(s.gen && s.gen.sid, "the popover gets a Use-in-Generate handle");
  assert.equal((await post("/api/feed/aigen/camref", U.bob, { pad: ROOM, sid: s.gen.sid })).status, 403, "never shown to bob");
  assert.equal((await post("/api/feed/aigen/camref", U.alice, { pad: LOUNGE, sid: s.gen.sid })).status, 400, "not a Camfrog pad");
  assert.equal((await post("/api/feed/aigen/camref", U.alice, { pad: ROOM, sid: "fnope" })).status, 410, "unknown frame");
  // went incognito since the snapshot: the roster now shows them anonymised -> can't be used
  const m = R.members.find((x) => x.login === "tha_hussler");
  const saved = Object.assign({}, m);
  for (const k of Object.keys(m)) delete m[k];
  Object.assign(m, { anon: true, display: "someone", on_cam: true });
  assert.equal((await post("/api/feed/aigen/camref", U.alice, { pad: ROOM, sid: s.gen.sid })).status, 403, "incognito since -> refused");
  for (const k of Object.keys(m)) delete m[k];
  Object.assign(m, saved);
  const c = await post("/api/feed/aigen/camref", U.alice, { pad: ROOM, sid: s.gen.sid });
  assert.equal(c.status, 200, JSON.stringify(c.d));
  assert.equal(c.d.display, "Tha Hussler");
  assert.equal(c.d.room, ROOM);
  assert.ok(AG._camRefs.get(c.d.id).img.equals(JPEG), "the frame is held in memory under the claim");
  // an expired snapshot can't be claimed
  const snapRec = relay._snaps.get(R.id + "|tha_hussler");
  snapRec.ts -= relay.SNAP_TTL + 1;
  assert.equal((await post("/api/feed/aigen/camref", U.alice, { pad: ROOM, sid: s.gen.sid })).status, 410, "expired snapshot");
  relay._snaps.delete(R.id + "|tha_hussler");
});

test("pricing parity and the reference flowing into the job (once, with whose cam it is)", async () => {
  await clearJobs();
  const s = await snapshot(U.alice, "datdude315");
  const c = (await post("/api/feed/aigen/camref", U.alice, { pad: ROOM, sid: s.gen.sid })).d;
  const mk = (body) => post("/api/feed/aigen", U.alice, Object.assign({ kind: "image", prompt: "as a pilot in a plane", pad: ROOM }, body));
  assert.equal((await mk({ camref: c.id, price: 40000 })).status, 409, "a price without the -cam surcharge is refused");
  assert.equal((await post("/api/feed/aigen", U.bob, { kind: "image", prompt: "as a pilot", pad: ROOM, camref: c.id })).status, 410,
    "someone else's claim can't be used");
  const r = await mk({ camref: c.id, price: 52000 });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.job.price, 52000, "!imagine 40,000 + the room's camsurcharge 12,000 - same as chat -cam and an uploaded reference");
  assert.equal(r.d.job.ref, true);
  assert.equal(r.d.job.refCam, "$htickie");
  const row = (await getQuery("SELECT * FROM feed_aigen_jobs WHERE id = ?", [r.d.job.id]))[0];
  assert.equal(row.ref_att, null, "no attachment is made of the snapshot");
  assert.deepEqual(JSON.parse(row.ref_cam), { room: ROOM, login: "datdude315", display: "$htickie" });
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM feed_attachments"))[0].n, 0, "nothing stored as a feed file");
  const a = (await getQuery("SELECT * FROM pepe_actions WHERE kind = 'aigen' ORDER BY id DESC LIMIT 1"))[0];
  assert.equal(JSON.parse(a.args)[0], r.d.job.id, "queued for Pepe like any generation");
  const st = await pepe("/api/feed/aigen/start", { id: r.d.job.id, user: "alice" });
  assert.equal(st.status, 200);
  assert.equal(st.d.job.has_ref, true);
  assert.deepEqual(st.d.job.ref_cam, { room: ROOM, login: "datdude315" }, "Pepe learns whose cam it is (to re-check their opt-out)");
  assert.ok(Buffer.from(st.d.job.ref.data, "base64").equals(JPEG), "the snapshot reaches Pepe as the reference");
  assert.ok(!AG._camJobFrames.has(r.d.job.id), "handed over once - the job's copy is gone after /start");
  await clearJobs();
  // video: the !video price + surcharge
  const v = await post("/api/feed/aigen", U.alice, { kind: "video", prompt: "they wave", pad: ROOM, camref: c.id });
  assert.equal(v.d.job.price, 162000);
  // a cancelled job drops its frame
  assert.ok(AG._camJobFrames.has(v.d.job.id));
  assert.equal((await post("/api/feed/aigen/" + v.d.job.id + "/discard", U.alice, {})).status, 200);
  assert.ok(!AG._camJobFrames.has(v.d.job.id), "cancelled: the frame is dropped");
  await clearJobs();
  // a cam reference and an upload at once: one only
  assert.equal((await mk({ camref: c.id, ref: "a".repeat(24) })).status, 400);
  // the claim belongs to its pad's room
  assert.equal((await post("/api/feed/aigen", U.alice, { kind: "image", prompt: "x y z", pad: LOUNGE, camref: c.id })).status, 400);
  // a claim expires
  AG._camRefs.get(c.id).ts -= AG.CAMREF_TTL + 1;
  assert.equal((await mk({ camref: c.id })).status, 410);
  await clearJobs();
});

test("the composer and the pad page: the cam option, Use in Generate, the right-to-use note, cache-busters", async () => {
  const html = await (await fetch(base + "/p/" + rooms.getCached(ROOM).slug, { headers: { "x-test-user": U.alice.userId } })).text();
  assert.match(html, /id="fcGenRefCam"[^>]*>📷 From a cam in this room/, "the panel's cam option");
  assert.match(html, /id="fcGenRefCams"/);
  assert.match(html, /never be made nude or sexual, and minors are always refused/);
  const m = /data-aigen="([^"]+)"/.exec(html);
  const cfg = JSON.parse(m[1].replace(/&#34;/g, '"').replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  assert.ok(cfg.camPads.includes(ROOM) && !cfg.camPads.includes(LOUNGE), "the cam option only for Camfrog pads");
  assert.match(html, /feed-composer\.js\?v=11/, "composer cache-buster bumped");
  assert.match(html, /feed\.css\?v=13/, "feed.css cache-buster bumped");
  const room = fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8");
  assert.match(room, /✨ Use in Generate/, "the popover's action");
  assert.match(room, /patv:gen-cam/, "handed to the composer on the page");
  const js = fs.readFileSync(path.join(repo, "public", "js", "feed-composer.js"), "utf8");
  assert.match(js, /camref: ref && ref\.cam \? ref\.id : null/, "the composer sends the claim, never image bytes");
});
