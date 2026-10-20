// stagefix site (V1-2 of the dynamic-stages design, §14.2 + D-9 / D-17 / DF-45): the holes that were live in the manual 🎬 cam
// slots (mainstage source 'cam', livecam stageConsent / stageHold / stageWatch) and the 📺 on-air picks (onair.js), at route
// level wherever there is a route. Each block names the hole it closes; every one of them passes the old code's checks:
//   * who may SEE that a cam is on a Stage: signed out never (Public pads included), Approved pads only inside, 18+ pads only
//     past the gate - /api/stage, /api/rooms/<slug>/stage (+ featured, schedule), /api/home/nowplaying, the /p guide rows;
//   * who may WATCH it (POST /api/stage/slots/<id>/cam, the beat, the MediaMTX hook): the cam's own access mode (everyone /
//     members / followers / request + the owner's "always" list), blocks both ways (cam_blocks, dm_blocks), the room's
//     live-cam block (bridgeblocks), a tighter mode or a new block ending a picture that is already playing, no 👻 bypass;
//   * who may PUT someone up (POST /api/rooms/<slug>/stage/cam): not over a block either way between the person on cam and
//     the actor or the pad's owner - staff included -, re-checked every tick; the owner's candidate list says "unavailable";
//   * "Take me off this Stage" (POST /api/stage/leave, GET /api/privacy/stage, Pepe's "!stage off me"): at once, 1 h, repeats
//     double up to 24 h, nobody (owner or staff) can put them back meanwhile, the race with a put in flight, merge / delete /
//     export;
//   * Pepe's public stream: never a cam slot, never an 18+ pad, a cam's mode counts (followers / request never; members only
//     by an OK given after the mode was last set), no pick over a block with the admin; Twitch never relays a cam slot.
//   * fix round (the review): a block counts when the person on cam IS the actor / pad owner; the Take me off doubling stays
//     at 24 h; cam slots never auto-featured or on the homepage; one neutral end reason; viewer-filtered counts; no achievement
//     farming; the ask switch keeps an on-air OK; "limited" cams; Pepe's capability / proven flags; the admin's list.
//   * final round (the verifier): D-17 (a) / DF-45 (stagepin.js - the never / off levels, the pin ask, the per-pad yes, the
//     10-minute "Keep going / Take me off" check, Pepe's !stage ok / no); stage bans of the person's linked account; D-9 (a)'s
//     per-pad session OK; Take me off doubles the last LENGTH; an on-air cam target saved without actor_ids.
//   NODE_PATH=G:/PATV/node_modules node --test test/stagefix.test.js      (temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stagefix-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
fs.mkdirSync(process.env.FEED_DIR, { recursive: true });
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
require(path.join(repo, "terms"))._setRequired(false);
const rooms = require(path.join(repo, "rooms"));
const PA = require(path.join(repo, "padaccess"));
const AG = require(path.join(repo, "adultgate"));
const bridge = require(path.join(repo, "bridge"));
const LC = require(path.join(repo, "livecam"));
const W = require(path.join(repo, "webrtc"));
const stage = require(path.join(repo, "mainstage"));
const SL = require(path.join(repo, "stageleave"));
const CA = require(path.join(repo, "camaccess"));
const CV = require(path.join(repo, "camviewers"));
const OA = require(path.join(repo, "onair"));
const restream = require(path.join(repo, "restream"));
const web = require(path.join(repo, "roomsweb"));
const home = require(path.join(repo, "home"));
let PIN = null;                                     // (final round; absent on older builds - their tests then fail at the assertion)
try { PIN = require(path.join(repo, "stagepin")); } catch (e) { PIN = null; }
const OAC = require(path.join(repo, "onairconsent"));

W.enabled = () => true;
let T = Date.now();
for (const m of [LC, stage, SL, OA, CA, PIN, OAC]) if (m) m._setClock(() => T);
LC._setKick(() => {});
rooms.notify = async () => true;                    // no inbox / PM queue here

// ── the pads: every one has the same people in its live Camfrog room ──
const PADS = {
  mem: { id: "Mem.Room", title: "Mem Pad" },                                 // Members (the default level)
  pub: { id: "Pub.Room", title: "Pub Pad", level: "public" },
  appr: { id: "Appr.Room", title: "Appr Pad", level: "approved" },
  adult: { id: "Adult.Room", title: "Adult Pad", adult: true },
};
const ON_CAM = [["alicecf", "Alice W"], ["bobcf", "Bob B"], ["carolcf", "Carol C"], ["dancf", "Dan D"], ["erincf", "Erin E"]];
function fresh() {
  for (const P of Object.values(PADS)) {
    const R = bridge._rooms.get(P.id);
    Object.assign(R, { updated: Date.now(), cams: true, livecams: true,
      members: [{ login: "pepefrog", display: "Pepe", on_cam: true, self: true }].concat(ON_CAM.map(([login, display]) => ({ login, display, on_cam: true }))) });
  }
}
const slug = (k) => rooms.getCached(PADS[k].id).slug;

// ── the people ──
const U = {};
const users = new Map();
async function mkUser(key, name, { cls = "pleb", camfrog = null } = {}) {
  const id = "u_" + key;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, 5, '2026-01-01 00:00:00')`, [id, name, name, cls, camfrog]);
  U[key] = { userId: id, username: name, class: cls };
  users.set(id, U[key]);
  return U[key];
}

let base, server, app;
const H = (u, extra) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {}, extra || {});
async function call(method, url, u, body) {
  const r = await fetch(base + url, { method, headers: H(u), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, text };
}
const get = (url, u) => call("GET", url, u);
const post = (url, u, body) => call("POST", url, u, body || {});
const bot = () => LC.forBot({ cap: true });

/** The pad's owner (or `by`) puts `login`'s cam on the pad's Stage; it goes live (relay up + a tick). -> slot id */
async function putUp(k, login, by = U.owner) {
  const r = await post("/api/rooms/" + slug(k) + "/stage/cam", by, { login });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  await goLive(k, login);
  return r.d.slot.id;
}
async function goLive(k, login) {
  LC.noteSync([{ name: LC.pathFor(PADS[k].id, login), ready: true, readers: [] }], T);
  await stage.tick();
  stage.clearCache();
}
const watch = (id, u, beat) => post("/api/stage/slots/" + encodeURIComponent(id) + "/cam", u, beat ? { beat: true } : {});
const slotRow = async (id) => (await getQuery("SELECT * FROM stage_slots WHERE id = ?", [id]))[0];
const stageOf = async (k, u) => (await get("/api/stage?room=" + encodeURIComponent(slug(k)), u)).d;
const camIn = (list) => (list || []).filter((s) => s && s.cam);
async function dmBlock(a, b) { await runQuery("INSERT OR IGNORE INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)", [a.userId, b.userId, T]); }
async function dmUnblock(a, b) { await runQuery("DELETE FROM dm_blocks WHERE blocker_id = ? AND blocked_id = ?", [a.userId, b.userId]); }
const ticketOf = (whep) => { const u = new URL(whep); return { path: u.pathname.split("/").pop(), pt: u.searchParams.get("pt") }; };
const hook = (whep) => { const k = ticketOf(whep); return LC.auth({ path: k.path, query: "pt=" + encodeURIComponent(k.pt) }, "read", "webrtc"); };

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0,
                  email TEXT, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE IF NOT EXISTS dm_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (blocker_id, blocked_id))");
  await require(path.join(repo, "inbox")).ready;
  await mkUser("owner", "padowner", { camfrog: "ownercf" });
  await mkUser("staff", "helper", { cls: "Admin" });
  await mkUser("vmem", "verified1", { camfrog: "vmemcf" });        // a verified member (a linked Camfrog name)
  await mkUser("plain", "plainuser");                              // signed in, not verified
  await mkUser("alice", "alice", { camfrog: "alicecf" });          // the people on cam with a PATV account
  await mkUser("carol", "carol", { camfrog: "carolcf" });
  await mkUser("dan", "dan", { camfrog: "dancf" });
  await mkUser("erin", "erin", { camfrog: "erincf" });
  await mkUser("fan", "fan", { camfrog: "fancf" });                // follows carol
  await mkUser("grown", "grownup", { camfrog: "growncf" });        // confirmed 18+
  await mkUser("appmem", "appmember", { camfrog: "appmemcf" });    // inside the Approved pad
  await mkUser("boss", "boss", { cls: "Admin", camfrog: "bossfrog" });
  await rooms.init();
  await PA.init();
  await AG.load();
  await runQuery("UPDATE users SET age_confirmed_at = ?, age_confirmed_v = '2026-10-19' WHERE userId = ?", [Date.UTC(2026, 9, 1), U.grown.userId]);
  for (const [k, P] of Object.entries(PADS)) {
    await bridge.ingest({ rooms: [{ room: { id: P.id, name: P.id }, members: [{ id: "a", login: "alicecf", display: "Alice W" }], count: 6, cams: true, relay: true }], events: [] });
    await rooms.addRoom(P.id, P.title, "test");
    await rooms.setOwner(P.id, "padowner", "test");
    if (P.level) await PA.setLevel(U.owner, await rooms.get(P.id), P.level);
    if (P.adult) await rooms.setPage(P.id, { adult: true }, "test");
    await rooms.setStage(P.id, { slot_count: 4 }, "test", { maxSlots: 4, maxPrice: 1000, maxMinutes: 360 });
    assert.ok(rooms.getCached(P.id), k);
  }
  await runQuery("INSERT INTO pad_members (room_id, user_id, status) VALUES (?, ?, 'approved')", [PADS.appr.id, U.appmem.userId]);
  await PA.load();
  await AG.load();
  await require(path.join(repo, "follows")).follow(U.fan, "user", "carol");
  await stage.init();
  await stage.setConfig({ max_concurrent: 50 }, "test");
  await LC.init();
  await LC.save({ class: "Admin", userId: U.boss.userId, username: "boss" }, { cfg: { enabled: true, max_live: 24 } });
  await CA.init();
  await CV.init();
  await SL.init();
  await OA.init();
  fresh();
  app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const id = req.get("x-test-user"); req.user = id ? users.get(id) || null : null; next(); };
  const isBotToken = (t) => t === "bot";
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; req.flash = () => []; next(); });
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  require(path.join(repo, "incognito")).register(app, { addUser, isBotToken });   // /settings/privacy (the 🎬 card)
  PA.register(app, { addUser });
  AG.register(app, { addUser });
  stage.register(app, { addUser, isBotToken, noTimers: true });
  web.register(app, { addUser, isBotToken });
  bridge.register(app, { addUser, isBotToken });         // + livecam, camviewers, stageleave, ghost...
  home.register(app, { addUser, xpForNextLevel: () => 100 });
  OA.register(app, { addUser, isBotToken, noTimers: true });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { if (server) server.close(); });
test.beforeEach(async () => { fresh(); await bot(); });
test.afterEach(async () => {
  await OA.clear("test", "test");
  for (const s of await stage.openSlots()) await stage.end(s.id, "test_cleanup", "test");
  T += 2 * 60 * 1000; LC.sweep(T); T += 2 * 60 * 1000; LC.sweep(T);
  stage.clearCache();
});

// ── who may SEE that a cam is on a Stage ──
test("cam slots are listed only to signed-in viewers who may see the live room: never signed out (Public pads too), every list", async () => {
  const id = await putUp("mem", "alicecf");
  await stage.featureByOwner(id, "test");
  const pid = await putUp("pub", "bobcf");
  stage.clearCache();
  // /api/stage (the pad page's poll, the homepage's front stage)
  assert.deepEqual(camIn((await stageOf("mem", null)).slots), [], "signed out: no cam slot on a Members pad");
  assert.deepEqual(camIn((await stageOf("pub", null)).slots), [], "signed out: no cam slot on a Public pad either");
  assert.doesNotMatch(JSON.stringify(await stageOf("mem", null)), /Alice W|alicecf/);
  const seen = camIn((await stageOf("mem", U.plain)).slots);
  assert.deepEqual(seen.map((s) => [s.id, s.display]), [[id, "Alice W"]], "any signed-in viewer of a Members pad sees it's there");
  assert.deepEqual(camIn((await stageOf("pub", U.vmem)).slots).map((s) => s.id), [pid]);
  // /api/rooms/<slug>/stage: the slots, the featured line and the schedule
  const anon = (await get("/api/rooms/" + slug("mem") + "/stage", null)).d;
  assert.equal(anon.featured, null, "a featured cam slot isn't named to a signed-out visitor");
  assert.deepEqual(camIn(anon.slots), []);
  assert.doesNotMatch(JSON.stringify(anon.schedule), /Alice W/);
  const mem = (await get("/api/rooms/" + slug("mem") + "/stage", U.plain)).d;
  assert.equal(mem.featured && mem.featured.id, id);
  assert.match(JSON.stringify(mem.schedule), /Alice W/);
  // the homepage's Top Pads "now playing"
  const npAnon = (await get("/api/home/nowplaying?ids=" + encodeURIComponent(PADS.mem.id), null)).d;
  assert.doesNotMatch(JSON.stringify(npAnon), /Alice W/, JSON.stringify(npAnon));
  const npMem = (await get("/api/home/nowplaying?ids=" + encodeURIComponent(PADS.mem.id), U.plain)).d;
  assert.match(JSON.stringify(npMem), /Alice W/);
  // the /p guide's cards
  const gAnon = await web.guideRows(false, null);
  assert.doesNotMatch(JSON.stringify(gAnon), /Alice W|Bob B/);
  const gMem = await web.guideRows(true, U.plain);
  assert.match(JSON.stringify(gMem), /Alice W/);
});

test("an Approved pad's cam slot: only inside; an 18+ pad's: only past the gate (not even a nameless entry)", async () => {
  const aid = await putUp("appr", "alicecf");
  const xid = await putUp("adult", "bobcf");
  await AG.setEnabled(true, U.boss, "test");
  try {
    stage.clearCache();
    assert.equal((await get("/api/stage?room=" + slug("appr"), U.vmem)).status, 403, "outside an Approved pad: no stage at all");
    assert.deepEqual(camIn((await stageOf("appr", U.appmem)).slots).map((s) => s.id), [aid]);
    assert.deepEqual(camIn((await stageOf("appr", U.staff)).slots).map((s) => s.id), [aid], "site staff are inside");
    // 18+: signed out and unconfirmed get no entry (the old code listed it with the name blanked); confirmed / owner / staff do
    assert.deepEqual(camIn((await stageOf("adult", null)).slots), []);
    assert.deepEqual(camIn((await stageOf("adult", U.plain)).slots), []);
    assert.deepEqual(camIn((await stageOf("adult", U.grown)).slots).map((s) => [s.id, s.display]), [[xid, "Bob B"]]);
    assert.deepEqual(camIn((await stageOf("adult", U.owner)).slots).map((s) => s.id), [xid]);
    assert.equal((await watch(xid, U.plain)).d.code, "pad_access", "nor its picture");
    assert.ok((await watch(xid, U.grown)).d.whep, "a confirmed member watches (Bob's cam: members mode, grown is verified)");
  } finally { await AG.setEnabled(false, U.boss, "test"); }
});

// ── who may WATCH it ──
test("each cam mode decides who gets the picture on a Stage - no Ask to watch there, the owner's always list counts", async () => {
  const id = await putUp("mem", "carolcf");
  assert.equal((await watch(id, null)).status, 401, "signed out");
  // members (the default: carol never chose): verified members only
  assert.ok((await watch(id, U.vmem)).d.whep, "members: a verified member");
  const no = await watch(id, U.plain);
  assert.equal(no.status, 403);
  assert.equal(no.d.code, "unavailable", "members: an unverified member gets the neutral card (the old code gave a ticket)");
  assert.equal(no.d.can_ask, undefined, "no Ask to watch on a Stage");
  // everyone
  await CA.setMode("carolcf", "everyone", { t: T });
  assert.ok((await watch(id, U.plain)).d.whep, "everyone: any signed-in member");
  // followers
  await CA.setMode("carolcf", "followers", { t: T });
  assert.equal((await watch(id, U.vmem)).d.code, "unavailable", "followers: a verified non-follower is refused");
  assert.ok((await watch(id, U.fan)).d.whep, "followers: a follower");
  // request: nobody but the always list (and their own cam)
  await CA.setMode("carolcf", "request", { t: T });
  assert.equal((await watch(id, U.fan)).d.code, "unavailable", "request: even a follower");
  assert.ok((await watch(id, U.carol)).d.whep, "their own cam");
  const a = await CA.allow("carolcf", { userId: U.vmem.userId, username: "verified1" });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.ok((await watch(id, U.vmem)).d.whep, "request: someone on the owner's always list");
  await CA.setMode("carolcf", "members", { t: T });
});

test("a tighter mode or a new block ends a picture that is already playing (the beat AND the MediaMTX hook)", async () => {
  const id = await putUp("mem", "dancf");
  await CA.setMode("dancf", "everyone", { t: T });
  const w = await watch(id, U.plain);
  assert.ok(w.d.whep);
  assert.equal(await hook(w.d.whep), 200);
  await CA.setMode("dancf", "members", { t: T });              // plain isn't verified
  const beat = await watch(id, U.plain, true);
  assert.equal(beat.d.ok, false);
  assert.equal(beat.d.code, "unavailable", "the beat says so");
  assert.equal(await hook(w.d.whep), 403, "and MediaMTX lets nobody read on that ticket");
  // a verified viewer, then the room's live-cam block on them
  const v = await watch(id, U.vmem);
  assert.equal(await hook(v.d.whep), 200);
  const BB = require(path.join(repo, "bridgeblocks"));
  await BB.block({ roomId: PADS.mem.id, target: { userId: U.vmem.userId, username: "verified1" }, feature: "livecams", by: { userId: U.owner.userId, name: "padowner", via: "web" } });
  assert.equal((await watch(id, U.vmem, true)).d.code, "unavailable", "the room's live-cam block (the old code never asked)");
  assert.equal(await hook(v.d.whep), 403);
  await BB.unblock({ roomId: PADS.mem.id, target: { userId: U.vmem.userId }, feature: "livecams", by: { userId: U.owner.userId } });
  assert.ok((await watch(id, U.vmem)).d.whep, "lifted: back");
});

test("blocks both ways between the viewer and the person on cam: the cam's block, and a DM block either way", async () => {
  const id = await putUp("mem", "alicecf");
  assert.ok((await watch(id, U.vmem)).d.whep);
  await dmBlock(U.vmem, U.alice);                                 // the viewer blocked her
  assert.equal((await watch(id, U.vmem)).d.code, "unavailable", "a viewer who blocked the person on cam doesn't get her picture");
  await dmUnblock(U.vmem, U.alice);
  await dmBlock(U.alice, U.vmem);                                 // she blocked the viewer (in DMs)
  assert.equal((await watch(id, U.vmem)).d.code, "unavailable");
  await dmUnblock(U.alice, U.vmem);
  assert.ok((await watch(id, U.vmem)).d.whep);
  await CV.block("alicecf", "verified1");                         // her cam's own block list
  assert.equal((await watch(id, U.vmem)).d.code, "unavailable");
  await CV.unblock("alicecf", "verified1");
  assert.ok((await watch(id, U.vmem)).d.whep);
});

test("👻 ghost mode never gets past a Stage tile: a block ends a ghost's Stage picture too", async () => {
  const G = require(path.join(repo, "ghost"));
  await G.init();
  assert.equal((await G.set(U.staff.userId, true)).ok, true);
  await CA.setMode("erincf", "everyone", { t: T });               // (staff get no cam-mode bypass on a Stage either - DF-43)
  try {
    const id = await putUp("mem", "erincf");
    const w = await watch(id, U.staff);
    assert.ok(w.d.whep);
    assert.equal(await hook(w.d.whep), 200);
    await CV.block("erincf", "helper");
    assert.equal(await hook(w.d.whep), 403, "the old code let a ghost's Stage ticket through after a block");
    assert.equal((await watch(id, U.staff)).d.code, "unavailable");
    await CV.unblock("erincf", "helper");
  } finally { await G.set(U.staff.userId, false); await CA.setMode("erincf", "members", { t: T }); }
});

// ── who may PUT someone up ──
test("putting someone up: refused over a block either way with the actor or the pad's owner - staff too; re-checked every tick", async () => {
  const put = (by, login = "alicecf") => post("/api/rooms/" + slug("mem") + "/stage/cam", by, { login });
  try {
    // she blocked the pad's owner (DMs): neither the owner nor staff can put her on that pad's Stage
    await dmBlock(U.alice, U.owner);
    const r = await put(U.owner);
    assert.equal(r.status, 403);
    assert.deepEqual([r.d.code, r.d.error], ["unavailable", "That cam isn't available right now."], "never the reason");
    assert.equal((await put(U.staff)).d.code, "unavailable", "staff pins follow the subject's rules (it's the owner's Stage)");
    const c = (await get("/api/rooms/" + slug("mem") + "/stage/cams", U.owner)).d;
    assert.equal(c.cams.find((x) => x.login === "alicecf").blocked, "unavailable", "the owner's list says only 'unavailable'");
    await dmUnblock(U.alice, U.owner);
    // the owner blocked her
    await dmBlock(U.owner, U.alice);
    assert.equal((await put(U.owner)).d.code, "unavailable");
    await dmUnblock(U.owner, U.alice);
    // her cam's block list has the actor (staff) - the owner may, staff may not
    await CV.block("alicecf", "helper");
    assert.equal((await put(U.staff)).d.code, "unavailable");
    const id = await putUp("mem", "alicecf", U.owner);
    // a block made while she's up ends the slot on the next tick
    await dmBlock(U.alice, U.owner);
    await stage.tick();
    const row = await slotRow(id);
    assert.equal(row.status, "ended");
    assert.equal(row.end_reason, "cam_unavailable");
  } finally {
    await dmUnblock(U.alice, U.owner);
    await dmUnblock(U.owner, U.alice);
    await CV.unblock("alicecf", "helper");
  }
});

test("the person's own changes end the slot on the next tick: private activity, the live-video opt-out", async () => {
  const id = await putUp("mem", "dancf");
  const ST = require(path.join(repo, "stories"));
  const was = ST.privateLogins;
  ST.privateLogins = async (ls) => new Set((ls || []).filter((l) => l === "dancf"));
  try {
    await stage.tick();
    const row = await slotRow(id);
    assert.equal(row.status, "ended");
    assert.equal(row.end_reason, "cam_unavailable", "re-checked in camBeat (the old code only checked it when it went up); the neutral reason (fix round)");
  } finally { ST.privateLogins = was; }
});

// ── "Take me off this Stage" ──
test("Take me off this Stage: at once, 1 h, nobody can put them back, repeats double up to 24 h", async () => {
  const id = await putUp("mem", "alicecf");
  // the person sees mine: true on their own cam (the page's button); nobody else does
  assert.equal(camIn((await stageOf("mem", U.alice)).slots)[0].mine, true);
  assert.equal(camIn((await stageOf("mem", U.vmem)).slots)[0].mine, undefined);
  // the privacy card
  const card = (await get("/api/privacy/stage", U.alice)).d;
  assert.deepEqual(card.on.map((x) => [x.slot, x.pad]), [[id, PADS.mem.id]]);
  // the route's rules
  assert.equal((await post("/api/stage/leave", null, { slot: id })).status, 401);
  assert.equal((await post("/api/stage/leave", U.plain, { slot: id })).status, 409, "no linked Camfrog name");
  assert.equal((await post("/api/stage/leave", U.vmem, { slot: id })).status, 404, "someone else's cam");
  const bad = await fetch(base + "/api/stage/leave", { method: "POST", headers: { "content-type": "application/json", "x-test-user": U.alice.userId }, body: JSON.stringify({ slot: id }) });
  assert.equal(bad.status, 403, "same-site fetch only");
  const t0 = T;
  const r = await post("/api/stage/leave", U.alice, { slot: id });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.until, t0 + 3600 * 1000, "1 hour");
  assert.equal(r.d.ended, 1);
  const row = await slotRow(id);
  assert.equal(row.status, "ended");
  assert.equal(row.end_reason, "cam_unavailable", "the neutral reason - whoever put her up can't tell a take-off from a block (fix round)");
  assert.equal(LC.stageState(id, T).state, "none", "the stage let go of the cam");
  // nobody can put her back on that pad meanwhile - not the owner, not staff; another pad still can
  assert.equal((await post("/api/rooms/" + slug("mem") + "/stage/cam", U.owner, { login: "alicecf" })).d.code, "unavailable");
  assert.equal((await post("/api/rooms/" + slug("mem") + "/stage/cam", U.staff, { login: "alicecf" })).d.code, "unavailable");
  const c = (await get("/api/rooms/" + slug("mem") + "/stage/cams", U.owner)).d;
  assert.equal(c.cams.find((x) => x.login === "alicecf").blocked, "unavailable");
  const other = await post("/api/rooms/" + slug("pub") + "/stage/cam", U.owner, { login: "alicecf" });
  assert.equal(other.status, 200, "only that pad");
  const off = (await get("/api/privacy/stage", U.alice)).d;
  assert.deepEqual(off.off.map((x) => [x.pad, x.until]), [[PADS.mem.id, t0 + 3600 * 1000]]);
  // an hour later: allowed again
  T = t0 + 3600 * 1000 + 1000;
  fresh(); await bot();
  const back = await putUp("mem", "alicecf");
  // again within a day: 2 h; asking for longer: up to 24 h, never more
  const r2 = await post("/api/stage/leave", U.alice, { slot: back });
  assert.equal(r2.d.until - T, 2 * 3600 * 1000, "a repeat doubles it");
  const r3 = await post("/api/stage/leave", U.alice, { room: slug("mem"), hours: 99 });
  assert.equal(r3.d.until - T, 24 * 3600 * 1000, "at most 24 h");
  assert.equal(SL.lengthFor(9, null), 24 * 3600 * 1000);
});

test("!stage off me from Camfrog (Pepe's route): anyone, even without a PATV account; only with Pepe's token", async () => {
  const id = await putUp("mem", "bobcf");
  const no = await post("/api/rooms/stage/act", null, { password: "nope", room: PADS.mem.id, by: "bobcf", verb: "off", arg: "me", proven: true });
  assert.equal(no.status, 403);
  // fix round: only for a login Pepe has proven typed it (never a display name someone set to bob's login)
  const unproven = await post("/api/rooms/stage/act", null, { password: "bot", room: PADS.mem.id, by: "bobcf", verb: "off", arg: "me" });
  assert.deepEqual([unproven.d.ok, unproven.d.code], [false, "unproven"]);
  assert.equal((await slotRow(id)).status, "active", "nothing happened");
  assert.equal(SL.excludedUntil(PADS.mem.id, "bobcf", T), 0);
  const r = await post("/api/rooms/stage/act", null, { password: "bot", room: PADS.mem.id, by: "bobcf", verb: "off", arg: "me", proven: true });
  assert.equal(r.d.ok, true, JSON.stringify(r.d));
  assert.match(r.d.message, /^you're off .+'s stage on PATV - it can't put your cam back for 1 hour$/);
  assert.equal((await slotRow(id)).status, "ended");
  assert.equal((await post("/api/rooms/" + slug("mem") + "/stage/cam", U.owner, { login: "bobcf" })).d.code, "unavailable");
  // the rest of !stage stays the owner's
  const other = await post("/api/rooms/stage/act", null, { password: "bot", room: PADS.mem.id, by: "bobcf", verb: "cut", arg: "all" });
  assert.equal(other.d.ok, false);
});

test("a take-off that lands while a put is in flight wins (the put's write re-checks it)", async () => {
  // the exclusion is on disk but not in this process's memory yet: stageHold's memory check passes, the write refuses
  await runQuery("INSERT INTO stage_leave (room_id, login, user_id, until, n, first_at, last_at, via) VALUES (?, 'carolcf', ?, ?, 1, ?, ?, 'web')",
                 [PADS.mem.id, U.carol.userId, T + 3600 * 1000, T, T]);
  assert.equal(SL.excludedUntil(PADS.mem.id, "carolcf", T), 0, "not in memory");
  const r = await post("/api/rooms/" + slug("mem") + "/stage/cam", U.owner, { login: "carolcf" });
  assert.equal(r.status, 403);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM stage_slots WHERE cam_login = 'carolcf' AND status != 'ended'"))[0].n, 0);
  await runQuery("DELETE FROM stage_leave WHERE login = 'carolcf'");
});

test("stage_leave: merged with the account, in its export, deleted with it", async () => {
  const AM = require(path.join(repo, "accountMerge"));
  assert.ok(AM.classify("stage_leave", "user_id"), "classified for merges");
  const AD = require(path.join(repo, "accountdelete"));
  assert.ok(AD.DELETE_ROWS.some(([t, c]) => t === "stage_leave" && c === "user_id"));
  assert.ok(AD.DELETE_ROWS.some(([t, c]) => t === "stage_leave" && c === "login"));
  await SL.leave({ roomId: PADS.pub.id, login: "erincf", userId: U.erin.userId, via: "web" });
  const EX = require(path.join(repo, "accountexport"));
  const out = await EX.collect(U.erin.userId);
  assert.equal(out.chat.stage_leave.length, 1);
  assert.equal(out.chat.stage_leave[0].room_id, PADS.pub.id);
});

// ── Pepe's public stream (and Twitch) ──
const ADMIN = () => ({ userId: U.boss.userId, username: "boss" });
async function onAir() { await OA.saveConfig({ enabled: true, cam_optin: true }, "test"); }

test("on-air: a cam slot never goes on Pepe's stream as a slot (it skipped the cam's opt-in), nor to Twitch", async () => {
  await onAir();
  const id = await putUp("mem", "erincf");
  await assert.rejects(OA.setSlot(id, "t", { admin: ADMIN() }), (e) => e.code === "cam_slot");
  assert.equal(await OA.slotWhyNot(await stage.getSlot(id), { padOk: true }), "cam_slot", "the tick's re-check too");
  const r = await OA.botCommand({ action: "set", query: id.slice(0, 8), by: "bossfrog", admin: true });
  assert.equal(r.ok, false, "!onair <slot> from Camfrog too");
  assert.ok(restream.slotBlock(await stage.getSlot(id)), "Twitch never relays a cam slot");
  assert.equal(OA.view().target, null);
});

test("on-air: nothing from an 18+ pad - slots or cams, whatever the gate switch says", async () => {
  await onAir();
  assert.equal(AG.enabled(), false, "the switch is off");
  assert.equal(await OA.slotWhyNot({ status: "active", source: "stream", room_id: PADS.adult.id, userId: U.owner.userId }, { padOk: true, needLive: false }), "adult");
  await OA.setOptin("bobcf", true, { ts: T + 10 });
  await assert.rejects(OA.setCam(PADS.adult.id, "bobcf", "t", { admin: ADMIN() }), (e) => e.code === "adult");
  await OA.setCam(PADS.mem.id, "bobcf", "t", { admin: ADMIN() });
  assert.equal(OA.view().target.login, "bobcf", "the same cam in a SFW pad's room is fine");
});

test("on-air: followers / request cams never go on Pepe's stream, opt-in or not (D-9)", async () => {
  await onAir();
  await OA.setOptin("carolcf", true, { ts: T + 10 });
  try {
    await CA.setMode("carolcf", "followers", { t: T + 20 });
    await assert.rejects(OA.setCam(PADS.mem.id, "carolcf", "t", { admin: ADMIN() }), (e) => e.code === "cam_mode");
    await OA.setOptin("carolcf", true, { ts: T + 30 });
    await CA.setMode("carolcf", "request", { t: T + 40 });
    await OA.setOptin("carolcf", true, { ts: T + 50 });
    await assert.rejects(OA.setCam(PADS.mem.id, "carolcf", "t", { admin: ADMIN(), ask: true }), (e) => e.code === "cam_mode");
  } finally { await CA.setMode("carolcf", "members", { t: T + 60 }); }
});

test("on-air: a members cam counts only an OK given after its mode was last set; tightening it takes the cam off (D-9)", async () => {
  await onAir();
  await OA.setOptin("dancf", true, { ts: T + 10 });
  await CA.setMode("dancf", "everyone", { t: T + 15 });
  await CA.setMode("dancf", "members", { t: T + 20 });          // changed after the opt-in: the opt-in no longer counts
  await assert.rejects(OA.setCam(PADS.mem.id, "dancf", "t", { admin: ADMIN() }), (e) => e.code === "no_optin");
  const card = (await OA.adminView(U.boss)).cams.find((c) => c.room === PADS.mem.id && c.login === "dancf");
  assert.equal(card.ask, true, "the admin card says it has to ask");
  await OA.saveConfig({ cam_optin: false }, "test");
  await assert.rejects(OA.setCam(PADS.mem.id, "dancf", "t", { admin: ADMIN() }), (e) => e.code === "no_optin", "'no opt-in needed' covers only everyone cams");
  await OA.saveConfig({ cam_optin: true }, "test");
  await OA.setOptin("dancf", true, { ts: T + 30 });
  await OA.setCam(PADS.mem.id, "dancf", "t", { admin: ADMIN() });
  assert.equal(OA.view().target.login, "dancf");
  await CA.setMode("dancf", "request", { t: T + 40 });
  await OA.check();
  assert.equal(OA.view().target, null, "a tighter mode takes it off at the next check");
  await CA.setMode("dancf", "members", { t: T + 50 });
});

test("on-air: no pick over a block either way between the cam's owner and the admin (web or Camfrog); a new one takes it off", async () => {
  await onAir();
  await OA.setOptin("erincf", true, { ts: T + 10 });
  try {
    await dmBlock(U.erin, U.boss);
    await assert.rejects(OA.setCam(PADS.mem.id, "erincf", "t", { admin: ADMIN() }), (e) => e.code === "unavailable");
    const r = await OA.botCommand({ action: "cam", room: PADS.mem.id, query: "erincf", by: "bossfrog", admin: true });
    assert.deepEqual([r.ok, r.msg], [false, "That cam isn't available right now."], "!onair cam from the admin's linked Camfrog name");
    await dmUnblock(U.erin, U.boss);
    await OA.setCam(PADS.mem.id, "erincf", "t", { admin: ADMIN() });
    assert.equal(OA.view().target.login, "erincf");
    await CV.block("erincf", "boss");
    await OA.check();
    assert.equal(OA.view().target, null);
  } finally { await dmUnblock(U.erin, U.boss); await CV.unblock("erincf", "boss"); }
});

test("Settings → Privacy shows the 🎬 card: the lists for a linked Camfrog name, the link-first note otherwise", async () => {
  const mine = await get("/settings/privacy", U.alice);
  assert.equal(mine.status, 200);
  assert.match(mine.text, /id="stage"[^]*Your cam on pads(&#39;|')? Stages[^]*id="pvSl"[^]*id="pvSlOn"[^]*id="pvSlOff"/);
  assert.match(mine.text, /privacy-stage\.js\?v=2/);
  const unlinked = await get("/settings/privacy", U.plain);
  assert.equal(unlinked.status, 200);
  const card = unlinked.text.slice(unlinked.text.indexOf('id="stage"'));
  assert.doesNotMatch(card.slice(0, card.indexOf("</section>")), /id="pvSl"/);
  assert.match(card.slice(0, card.indexOf("</section>")), /Link your Camfrog name first/);
});

test("client: the Stage's Take me off button, the privacy card, the strings", () => {
  const sr = fs.readFileSync(path.join(repo, "public", "js", "stage-room.js"), "utf8");
  assert.match(sr, /x\.cam && x\.mine === true/);
  assert.match(sr, /'\/api\/stage\/leave'/);
  assert.match(sr, /'X-Requested-With': 'fetch'/);
  const ps = fs.readFileSync(path.join(repo, "public", "js", "privacy-stage.js"), "utf8");
  assert.match(ps, /\/api\/privacy\/stage/);
  assert.doesNotMatch(ps, /innerHTML/, "all text via textContent");
  const view = fs.readFileSync(path.join(repo, "views", "privacy-settings.ejs"), "utf8");
  assert.match(view, /id="pvSl"/);
  assert.match(view, /privacy-stage\.js/);
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  for (const k of ["sl.h2", "sl.what", "sl.what_off", "sl.on_h", "sl.off_h", "sl.chat", "js.stage.room.leave", "js.sl.take_off"]) assert.ok(en[k], k);
});

// ── fix round (the review's findings): each test below fails on 627e1157 ──
function addOnCam(k, login, display) {
  const R = bridge._rooms.get(PADS[k].id);
  R.members = R.members.concat([{ login, display, on_cam: true }]);
}
const putRaw = (k, by, login) => post("/api/rooms/" + slug(k) + "/stage/cam", by, { login });

test("fix: a block counts both ways even when the person on cam IS the actor or the pad's owner; blocks between others don't", async () => {
  addOnCam("mem", "ownercf", "Owner O");
  addOnCam("mem", "bossfrog", "Boss B");
  await runQuery("DELETE FROM stage_leave WHERE login = 'alicecf'"); await SL.load(T);    // the take-off tests above kept her off
  try {
    // the pad's owner (on cam) blocked staff: staff can't put the owner's cam on the owner's Stage
    await dmBlock(U.owner, U.staff);
    const r1 = await putRaw("mem", U.staff, "ownercf");
    assert.deepEqual([r1.status, r1.d.code], [403, "unavailable"], "the old code skipped a row between the actor and the pad's owner");
    await dmUnblock(U.owner, U.staff);
    // staff putting up THEIR OWN cam on a pad whose owner blocked them
    await dmBlock(U.owner, U.boss);
    const r2 = await putRaw("mem", U.boss, "bossfrog");
    assert.deepEqual([r2.status, r2.d.code], [403, "unavailable"]);
    await dmUnblock(U.owner, U.boss);
    // ...and the other way: staff (on cam) blocked the pad's owner
    await dmBlock(U.boss, U.owner);
    assert.equal((await putRaw("mem", U.boss, "bossfrog")).d.code, "unavailable");
    await dmUnblock(U.boss, U.owner);
    // a block between the actor and the pad's owner when neither is on cam is about someone else: staff may put Alice up
    await dmBlock(U.owner, U.staff);
    assert.equal((await putRaw("mem", U.staff, "alicecf")).status, 200);
    await dmUnblock(U.owner, U.staff);
    // the owner's own unrelated blocks don't stop their own cam
    await dmBlock(U.owner, U.plain);
    assert.equal((await putRaw("mem", U.owner, "ownercf")).status, 200);
    await dmUnblock(U.owner, U.plain);
    for (const s of await stage.openSlots()) await stage.end(s.id, "test_cleanup", "test");
    // made while it's up: staff put the owner's cam up, then the owner blocks staff - the next tick ends it
    const r3 = await putRaw("mem", U.staff, "ownercf");
    assert.equal(r3.status, 200, JSON.stringify(r3.d));
    await goLive("mem", "ownercf");
    await dmBlock(U.owner, U.staff);
    await stage.tick();
    const row = await slotRow(r3.d.slot.id);
    assert.deepEqual([row.status, row.end_reason], ["ended", "cam_unavailable"]);
    // the candidate list (as staff) says "unavailable" for the owner's own cam too
    const c = (await get("/api/rooms/" + slug("mem") + "/stage/cams", U.staff)).d;
    assert.equal(c.cams.find((x) => x.login === "ownercf").blocked, "unavailable");
  } finally {
    await dmUnblock(U.owner, U.staff); await dmUnblock(U.owner, U.boss); await dmUnblock(U.boss, U.owner); await dmUnblock(U.owner, U.plain);
  }
});

test("fix: Take me off - repeats count from the END of the last exclusion, so the doubling stays at 24 h instead of starting over", async () => {
  const HR = 3600 * 1000;
  let t = T + 30 * 24 * HR;
  const seq = [];
  for (let i = 0; i < 8; i++) {
    const r = await SL.leave({ roomId: PADS.appr.id, login: "erincf", via: "web" }, t);
    seq.push(Math.round((r.until - t) / HR));
    t = r.until + 60 * 1000;                 // the pad puts them back a minute after it ends; they take themselves off again
  }
  assert.deepEqual(seq, [1, 2, 4, 8, 16, 24, 24, 24], "the old code went 1, 2, 4, 8, 16, 24, 1, 2");
  // a day after the last one ENDED, it starts over
  t += 24 * HR + 1000;
  const r = await SL.leave({ roomId: PADS.appr.id, login: "erincf", via: "web" }, t);
  assert.equal(r.until - t, HR);
  await runQuery("DELETE FROM stage_leave WHERE login = 'erincf'");
  await SL.load(T);
});

test("fix: a cam slot is never auto-featured, and never on the homepage's front stage (an owner's feature stays on the pad page)", async () => {
  await rooms.setFront(PADS.mem.id, "test");
  try {
    const id = await putUp("mem", "dancf");
    const row = await slotRow(id);
    assert.deepEqual([row.featured, row.feature_by], [0, null], "the old code auto-featured it (the pad's default view)");
    // one auto-featured before the rule (or by a race) is dropped at the next look
    await runQuery("UPDATE stage_slots SET featured = 1, feature_by = 'auto' WHERE id = ?", [id]);
    await stage.autoFeature(PADS.mem.id);
    assert.equal((await slotRow(id)).featured, 0);
    // the owner features it by hand: the pad page shows it featured to members who may see it...
    await stage.featureByOwner(id, "test");
    stage.clearCache();
    assert.equal((await get("/api/rooms/" + slug("mem") + "/stage", U.vmem)).d.featured.id, id);
    assert.equal(camIn((await stageOf("mem", U.vmem)).slots)[0].featured, true);
    // ...but the homepage's front stage (no ?room=) never carries it - not even for a signed-in member
    const d = (await get("/api/stage", U.vmem)).d;
    assert.equal(d.front && d.front.id, PADS.mem.id);
    assert.deepEqual(camIn(d.slots), [], "the old code made it the homepage's default view");
    // the homepage's first render (home.js): what it hands home.ejs (the view itself needs the whole site's tables)
    const was = app.response.render;
    app.response.render = function (view, data) { return view === "home" ? this.json({ slots: data.slots, front: data.frontInfo }) : was.apply(this, arguments); };
    try {
      const home = (await get("/", U.vmem)).d;
      assert.equal(home.front && home.front.id, PADS.mem.id);
      assert.deepEqual(camIn(home.slots), [], "nor in the homepage's first render");
    } finally { app.response.render = was; }
  } finally { await rooms.setFront("auto", "test"); }
});

test("fix: private activity, Take me off and a block all end a cam slot with the one neutral 'cam_unavailable' - the actor can't tell", async () => {
  const ST = require(path.join(repo, "stories"));
  const was = ST.privateLogins;
  const reasons = {};
  await runQuery("DELETE FROM stage_leave WHERE login IN ('dancf', 'bobcf', 'erincf')"); await SL.load(T);   // earlier take-offs
  // private activity
  let id = await putUp("mem", "dancf");
  ST.privateLogins = async (ls) => new Set((ls || []).filter((l) => l === "dancf"));
  try {
    const c = (await get("/api/rooms/" + slug("mem") + "/stage/cams", U.owner)).d;
    assert.equal(c.cams.find((x) => x.login === "dancf").blocked, "unavailable", "the list says unavailable, not 'opted_out' (old)");
    await stage.tick();
    reasons.private = (await slotRow(id)).end_reason;
    assert.equal((await putRaw("mem", U.owner, "dancf")).d.code, "unavailable", "the refusal too (old: opted_out)");
  } finally { ST.privateLogins = was; }
  // Take me off (Camfrog, via Pepe - linked or not)
  id = await putUp("mem", "bobcf");
  assert.equal((await post("/api/rooms/stage/act", null, { password: "bot", room: PADS.mem.id, by: "bobcf", verb: "off", arg: "me", proven: true })).d.ok, true);
  const tk = await slotRow(id);
  reasons.takeoff = tk.end_reason;
  assert.equal(tk.ended_by, "system", "not 'self'");
  // a block
  id = await putUp("mem", "erincf");
  await dmBlock(U.erin, U.owner);
  try { await stage.tick(); reasons.block = (await slotRow(id)).end_reason; } finally { await dmUnblock(U.erin, U.owner); }
  assert.deepEqual(reasons, { private: "cam_unavailable", takeoff: "cam_unavailable", block: "cam_unavailable" },
    "the old code said cam_private / cam_left_stage / cam_unavailable - the last only ever meant a block");
  // what the actor sees on /stage
  const me = (await get("/api/stage/me", U.owner)).d;
  assert.equal(me.slot.end_reason, "cam_unavailable");
  await runQuery("DELETE FROM stage_leave WHERE login = 'bobcf'"); await SL.load(T);
});

test("fix: a viewer who may not see a cam slot doesn't count it either (open / free, the pad page's slots line)", async () => {
  const id = await putUp("pub", "alicecf");
  stage.clearCache();
  const anon = (await get("/api/rooms/" + slug("pub") + "/stage", null)).d;
  assert.deepEqual([anon.open, anon.free, camIn(anon.slots).length], [0, 4, 0], "the old code said open 1, free 3 with nothing listed");
  const mem = (await get("/api/rooms/" + slug("pub") + "/stage", U.vmem)).d;
  assert.deepEqual([mem.open, mem.free], [1, 3]);
  const page = await get("/p/" + slug("pub"), null);
  assert.equal(page.status, 200);
  const m = /id="rmSlotsTxt">([^<]*)</.exec(page.text);
  assert.ok(m && m[1].startsWith("🎬 0/4"), m && m[1]);
  assert.ok(!page.text.includes(id), "no trace of the slot");
  // and the stage list never carries the cam's Camfrog login (mine: true is worked out server side)
  assert.doesNotMatch(JSON.stringify(await stageOf("pub", U.vmem)), /alicecf|cam_login/);
  assert.equal(camIn((await stageOf("pub", U.alice)).slots)[0].mine, true);
});

test("fix: putting someone else's cam up isn't YOUR stream (the On Air / Regular Programming achievements)", async () => {
  const A = require(path.join(repo, "achievements"));
  const before = (await A.featureMetrics(U.owner.userId)).streams;
  await putUp("mem", "bobcf");
  assert.equal((await A.featureMetrics(U.owner.userId)).streams, before, "the old code counted it");
});

test("fix: the 'others can ask' switch or the same mode saved again doesn't void a members cam's on-air OK; a real change does (D-9)", async () => {
  await onAir();
  await CA.setMode("alicecf", "everyone", { t: T - 2000 });
  await CA.setMode("alicecf", "members", { t: T - 1000 });       // chose members before opting in
  await OA.setOptin("alicecf", true, { ts: T + 10 });
  await OA.setCam(PADS.mem.id, "alicecf", "t", { admin: ADMIN() });
  assert.equal(OA.view().target.login, "alicecf");
  await CA.setMode("alicecf", "members", { ask: false, t: T + 20 });   // the privacy card's ask switch posts the same mode
  assert.equal(CA.modeSince("alicecf"), T - 1000);
  await OA.check();
  assert.equal(OA.view().target && OA.view().target.login, "alicecf", "the old code took her off Pepe's stream here");
  await CA.setMode("alicecf", "members", { ask: true, t: T + 30 });
  await OA.check();
  assert.equal(OA.view().target && OA.view().target.login, "alicecf");
  // a real change after the OK (members -> everyone -> members) is the more recent choice
  await CA.setMode("alicecf", "everyone", { t: T + 40 });
  await CA.setMode("alicecf", "members", { t: T + 50 });
  assert.equal(CA.modeSince("alicecf"), T + 50);
  await OA.check();
  assert.equal(OA.view().target, null);
  // the column survives a restart (init reads mode_at)
  CA._reset(); await CA.init();
  assert.equal(CA.modeSince("alicecf"), T + 50);
  await OA.setOptin("alicecf", false, { ts: T + 60 });
});

test("fix: the owner's list and the put say when a cam shows only to some viewers (followers / request)", async () => {
  await CA.setMode("carolcf", "followers", { t: T });
  try {
    const c = (await get("/api/rooms/" + slug("mem") + "/stage/cams", U.owner)).d;
    assert.equal(c.cams.find((x) => x.login === "carolcf").limited, true);
    assert.equal(c.cams.find((x) => x.login === "alicecf").limited, false, "a members cam isn't");
    const r = await putRaw("mem", U.owner, "carolcf");
    assert.deepEqual([r.status, r.d.limited], [200, true]);
    const a = await putRaw("mem", U.owner, "alicecf");
    assert.equal(a.d.limited, undefined);
  } finally { await CA.setMode("carolcf", "members", { t: T + 1 }); }
});

test("fix: an unlinked cam owner's PM names !stage off me only once Pepe says he forwards it; the privacy card likewise", async () => {
  const ACT = require(path.join(repo, "actions"));
  const was = ACT.queue;
  const sent = [];
  ACT.queue = async (uid, x) => { sent.push(x.args[1]); return { ok: true }; };
  const until = async (n) => { for (let i = 0; i < 100 && sent.length < n; i++) await new Promise((r) => setTimeout(r, 10)); };
  try {
    await putUp("mem", "bobcf");                                 // bob has no PATV account: Pepe PMs him
    await until(1);
    assert.match(sent[0], /say !livecam off to take it down/);
    assert.doesNotMatch(sent[0], /!stage off me/, "the old code told him to use a command Pepe answers 'owners only' to");
    const p0 = (await get("/settings/privacy", U.alice)).text;
    assert.match(p0, /!livecam off keeps your cam off the website everywhere/);
    assert.doesNotMatch(p0, /!stage off me/);
    for (const s of await stage.openSlots()) await stage.end(s.id, "test_cleanup", "test");
    await LC.forBot({ cap: true, stage_off_me: true });        // a Pepe that forwards it
    await putUp("mem", "bobcf");
    await until(2);
    assert.match(sent[1], /Say !stage off me in that room/);
    assert.match((await get("/settings/privacy", U.alice)).text, /!stage off me in that pad/);
  } finally { ACT.queue = was; await bot(); }
});

test("fix: on Pepe's stream private activity and a block with the admin are the same 'unavailable' - the admin's list says it up front", async () => {
  await onAir();
  await OA.setOptin("erincf", true, { ts: T + 10 });
  const ST = require(path.join(repo, "stories"));
  const was = ST.privateLogins;
  const card = async () => (await OA.adminView(U.boss)).cams.find((c) => c.room === PADS.mem.id && c.login === "erincf");
  try {
    assert.equal((await card()).why, null);
    ST.privateLogins = async (ls) => new Set((ls || []).filter((l) => l === "erincf"));
    await assert.rejects(OA.setCam(PADS.mem.id, "erincf", "t", { admin: ADMIN() }), (e) => e.code === "unavailable", "old: 'private'");
    assert.equal((await card()).why, "unavailable");
    ST.privateLogins = was;
    await dmBlock(U.erin, U.boss);
    assert.equal((await card()).why, "unavailable", "the old list showed it as available, then the pick said 'unavailable' - only a block did that");
  } finally { ST.privateLogins = was; await dmUnblock(U.erin, U.boss); await OA.setOptin("erincf", false, { ts: T + 20 }); }
});

test("fix: client - the owner's list words 'unavailable' and 'limited', /stage words cam end reasons, the cache-busters moved", () => {
  const rm = fs.readFileSync(path.join(repo, "public", "js", "room-manage.js"), "utf8");
  assert.match(rm, /x\.blocked === 'opted_out' \? '<span class="muted">switched live video off<\/span>'/);
  assert.match(rm, /unavailable right now/);
  assert.match(rm, /only some viewers will see it/);
  assert.match(fs.readFileSync(path.join(repo, "views", "padSettings.ejs"), "utf8"), /room-manage\.js\?v=5/);
  const sb = fs.readFileSync(path.join(repo, "public", "js", "stage-book.js"), "utf8");
  assert.match(sb, /function reasonOf\(r\)/);
  assert.match(sb, /why: reasonOf\(last\.end_reason\)/);
  assert.match(fs.readFileSync(path.join(repo, "views", "stageBook.ejs"), "utf8"), /stage-book\.js\?v=12/);
  for (const v of ["home.ejs", "room.ejs"]) assert.match(fs.readFileSync(path.join(repo, "views", v), "utf8"), /stage-room\.js\?v=14/, v);   // train2: + micfollow's 12
  assert.match(fs.readFileSync(path.join(repo, "views", "stageAdmin.ejs"), "utf8"), /only cams shown to everyone are excused/);
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  for (const k of ["js.stage.r_cam", "js.stage.r_cam_left_cam", "js.stage.r_cam_opted_out", "sl.chat_livecam"]) assert.ok(en[k], k);
});

// ── final round (the verifier's findings): each test below fails on c01fad0c ──
const MIN = 60 * 1000;
const CHECK_ANSWER = 2 * MIN;
async function pinReset() {
  for (const t of ["stage_level", "stage_pad_prefs", "stage_asks"]) await runQuery(`DELETE FROM ${t}`).catch(() => {});
  if (PIN) await PIN.load();
  await runQuery("DELETE FROM stage_leave"); await SL.load(T);
}
const level = (u, lv) => post("/api/privacy/stage/level", u, { level: lv });
const card = async (u) => (await get("/api/privacy/stage", u)).d;
const asksOf = async (login) => getQuery("SELECT * FROM stage_asks WHERE login = ? ORDER BY created", [login]).catch(() => []);
const openCam = async (k, login) => (await stage.openSlots(PADS[k].id)).filter((s) => s.source === "cam" && s.cam_login === login);
/** The slot has been live `mins` minutes (its went_live moved back) - a tick then sees it. */
const liveFor = (id, mins) => runQuery("UPDATE stage_slots SET went_live = ? WHERE id = ?", [T - mins * MIN, id]);
/** Time passes: the relay is still up and Pepe still polls; one tick. */
async function later(ms, k, login) {
  T += ms;
  fresh(); await bot();
  if (k) LC.noteSync([{ name: LC.pathFor(PADS[k].id, login), ready: true, readers: [] }], T);
  await stage.tick();
  stage.clearCache();
}

test("final: a stage ban of the person's linked account (site-wide or this pad's) refuses the pin, says 'unavailable', ends one already up", async () => {
  await pinReset();
  try {
    await runQuery("INSERT INTO stage_bans (userId, username, reason, by, at) VALUES (?, 'dan', 'test', 'test', ?)", [U.dan.userId, T]);
    const r = await putRaw("mem", U.owner, "dancf");
    assert.deepEqual([r.status, r.d.code], [403, "unavailable"], "the old code put a stage-banned person's cam up (200)");
    assert.equal((await putRaw("mem", U.staff, "dancf")).d.code, "unavailable", "staff too");
    const c = (await get("/api/rooms/" + slug("mem") + "/stage/cams", U.owner)).d;
    assert.equal(c.cams.find((x) => x.login === "dancf").blocked, "unavailable");
    await runQuery("DELETE FROM stage_bans WHERE userId = ?", [U.dan.userId]);
    // this pad's stage ban: only this pad
    await runQuery("INSERT INTO stage_room_bans (room_id, userId, username, reason, by, at) VALUES (?, ?, 'dan', 'test', 'test', ?)", [PADS.mem.id, U.dan.userId, T]);
    assert.equal((await putRaw("mem", U.owner, "dancf")).d.code, "unavailable");
    assert.equal((await putRaw("pub", U.owner, "dancf")).status, 200, "another pad still may");
    await runQuery("DELETE FROM stage_room_bans WHERE userId = ?", [U.dan.userId]);
    for (const s of await stage.openSlots()) await stage.end(s.id, "test_cleanup", "test");
    // banned while it's up: the next tick ends it, neutrally
    const id = await putUp("mem", "dancf");
    await runQuery("INSERT INTO stage_bans (userId, username, reason, by, at) VALUES (?, 'dan', 'test', 'test', ?)", [U.dan.userId, T]);
    await stage.tick();
    const row = await slotRow(id);
    assert.deepEqual([row.status, row.end_reason, row.ended_by], ["ended", "cam_unavailable", "system"]);
  } finally {
    await runQuery("DELETE FROM stage_bans WHERE userId = ?", [U.dan.userId]);
    await runQuery("DELETE FROM stage_room_bans WHERE userId = ?", [U.dan.userId]);
  }
});

test("final: level 'never' - no pad's Stage (owner or staff), 'unavailable' in the list, a pin already up ends at once; ▶ Live unaffected", async () => {
  await pinReset();
  const id = await putUp("mem", "carolcf");
  try {
    assert.equal((await level(U.plain, "never")).status, 409, "a linked Camfrog name only");
    assert.equal((await level(U.carol, "sometimes")).status, 400);
    const r = await level(U.carol, "never");
    assert.equal(r.status, 200, "the old code had no such setting (404) - " + r.text);
    assert.deepEqual([r.d.level, r.d.ended], ["never", 1]);
    const row = await slotRow(id);
    assert.deepEqual([row.status, row.end_reason], ["ended", "cam_unavailable"], "the pin up now ends at once, neutrally");
    assert.deepEqual([(await putRaw("mem", U.owner, "carolcf")).d.code, (await putRaw("pub", U.staff, "carolcf")).d.code], ["unavailable", "unavailable"]);
    const c = (await get("/api/rooms/" + slug("mem") + "/stage/cams", U.owner)).d;
    assert.equal(c.cams.find((x) => x.login === "carolcf").blocked, "unavailable", "never the reason");
    assert.equal((await card(U.carol)).level, "never");
    const live = await post("/api/rooms/" + slug("mem") + "/livecam", U.vmem, { login: "carolcf" });
    assert.ok(live.d && live.d.whep, "the ▶ Live button still works for a verified member: " + live.text);
  } finally { await level(U.carol, "on"); }
  assert.equal((await card(U.carol)).level, "on");
  assert.equal((await putRaw("mem", U.owner, "carolcf")).status, 200, "back on: pads may again");
});

test("final: level 'off' - a pin becomes an ask; Allow puts it up (as the asker) and is kept per pad; No keeps that pad away 6 h", async () => {
  await pinReset();
  try {
    assert.equal((await level(U.erin, "off")).status, 200);
    const r = await putRaw("mem", U.owner, "erincf");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.d.asked, true, "the old code put her up at once");
    assert.equal((await openCam("mem", "erincf")).length, 0, "nothing goes up before her yes");
    const c = (await get("/api/rooms/" + slug("mem") + "/stage/cams", U.owner)).d;
    const me = c.cams.find((x) => x.login === "erincf");
    assert.deepEqual([me.blocked, me.ask, me.waiting], [null, true, true], "the owner sees it's waiting for her OK");
    const again = await putRaw("mem", U.staff, "erincf");
    assert.deepEqual([again.status, again.d.code], [409, "waiting"], "one ask at a time - staff too (DF-43)");
    // her card lists the ask; nobody else may answer it
    const ask = (await card(U.erin)).asks;
    assert.deepEqual(ask.map((a) => [a.kind, a.pad]), [["pin", PADS.mem.id]]);
    assert.equal((await post("/api/stage/ask/" + ask[0].id, U.vmem, { answer: "yes" })).status, 404, "someone else's ask is 'no such ask'");
    assert.equal((await post("/api/stage/ask/" + ask[0].id, U.erin, { answer: "keep" })).status, 400, "a pin ask is Allow or No");
    const yes = await post("/api/stage/ask/" + ask[0].id, U.erin, { answer: "yes" });
    assert.deepEqual([yes.status, yes.d.put], [200, true], yes.text);
    const up = await openCam("mem", "erincf");
    assert.deepEqual(up.map((s) => s.userId), [U.owner.userId], "it went up, as the owner who asked");
    assert.deepEqual((await card(U.erin)).yes.map((p) => p.pad), [PADS.mem.id], "her yes for that pad");
    await stage.end(up[0].id, "test_cleanup", "test");
    assert.ok((await putRaw("mem", U.owner, "erincf")).d.slot, "that pad pins her in one tap now");
    // removing that yes (level off) ends the pin there at once
    const rm = await post("/api/privacy/stage/pad", U.erin, { room: PADS.mem.id, yes: false });
    assert.deepEqual([rm.status, rm.d.removed, rm.d.ended], [200, true, 1]);
    assert.equal((await openCam("mem", "erincf")).length, 0);
    // another pad: No -> refused ("unavailable") for 6 h, then it may ask again
    const r2 = await putRaw("pub", U.owner, "erincf");
    assert.equal(r2.d.asked, true);
    const no = await post("/api/stage/ask/" + r2.d.ask.id, U.erin, { answer: "no" });
    assert.deepEqual([no.status, no.d.status], [200, "no"]);
    assert.equal((await putRaw("pub", U.owner, "erincf")).d.code, "unavailable");
    assert.equal((await get("/api/rooms/" + slug("pub") + "/stage/cams", U.owner)).d.cams.find((x) => x.login === "erincf").blocked, "unavailable");
    T += 6 * 3600 * 1000 + 1000; fresh(); await bot();
    const r3 = await putRaw("pub", U.owner, "erincf");
    assert.equal(r3.d.asked, true, "6 h later it may ask again");
    // an ask nobody answered in time
    T += 11 * MIN; fresh(); await bot();
    const late = await post("/api/stage/ask/" + r3.d.ask.id, U.erin, { answer: "yes" });
    assert.deepEqual([late.status, late.d.code], [409, "expired"]);
    assert.equal((await openCam("pub", "erincf")).length, 0);
  } finally { await level(U.erin, "on"); }
});

test("final: the 10-minute check - asked after 10 live minutes without a yes for the pad; Keep going holds; no answer in 2 min ends it", async () => {
  await pinReset();
  // alice: asked at 10 min, keeps going
  const a = await putUp("mem", "alicecf");
  await liveFor(a, 9); await stage.tick();
  assert.equal(((await card(U.alice)).asks || []).length, 0, "not before 10 minutes");
  await liveFor(a, 10.1); await stage.tick(); await stage.tick();
  const asks = (await card(U.alice)).asks || [];
  assert.deepEqual(asks.map((x) => [x.kind, x.pad]), [["check", PADS.mem.id]], "the old code never asked (DF-45)");
  assert.equal((await post("/api/stage/ask/" + asks[0].id, U.alice, { answer: "yes" })).status, 400, "Keep going or Take me off");
  assert.equal((await post("/api/stage/ask/" + asks[0].id, U.alice, { answer: "keep" })).status, 200);
  await later(3 * MIN, "mem", "alicecf");
  assert.equal((await slotRow(a)).status, "active", "Keep going holds for that slot");
  assert.equal((await asksOf("alicecf")).length, 1, "and isn't asked again");
  // dan: no answer within 2 minutes -> off, with the neutral end reason
  const d = await putUp("mem", "dancf");
  await liveFor(d, 11); await stage.tick();
  assert.equal((await asksOf("dancf")).length, 1);
  await later(CHECK_ANSWER + 1000, "mem", "dancf");
  const row = await slotRow(d);
  assert.deepEqual([row.status, row.end_reason, row.ended_by], ["ended", "cam_unavailable", "system"], "the same reason as a take-off or a block");
  assert.equal((await asksOf("dancf"))[0].status, "expired");
  // carol: Take me off -> the usual exclusion
  const c = await putUp("mem", "carolcf");
  await liveFor(c, 11); await stage.tick();
  const ca = (await card(U.carol)).asks[0];
  const off = await post("/api/stage/ask/" + ca.id, U.carol, { answer: "off" });
  assert.equal(off.status, 200);
  assert.equal(off.d.until, T + 3600 * 1000);
  assert.equal((await slotRow(c)).end_reason, "cam_unavailable");
  assert.equal((await putRaw("mem", U.owner, "carolcf")).d.code, "unavailable", "that pad can't put her back for an hour");
  // erin: "keep going, don't ask again on this pad" = her yes for that pad - its next pin isn't checked
  const e = await putUp("pub", "erincf");
  await liveFor(e, 11); await stage.tick();
  const ea = (await card(U.erin)).asks[0];
  assert.equal((await post("/api/stage/ask/" + ea.id, U.erin, { answer: "keep_always" })).status, 200);
  assert.deepEqual((await card(U.erin)).yes.map((p) => p.pad), [PADS.pub.id]);
  await stage.end(e, "test_cleanup", "test");
  const e2 = await putUp("pub", "erincf");
  await liveFor(e2, 30); await stage.tick();
  assert.equal((await asksOf("erincf")).length, 1, "no new ask on a pad she said yes to");
  assert.equal((await slotRow(e2)).status, "active");
});

test("final: an unlinked cam is asked only once Pepe forwards !stage ok; !stage ok keeps going, !stage no takes them off; proven only", async () => {
  await pinReset();
  const ACT = require(path.join(repo, "actions"));
  const was = ACT.queue;
  const sent = [];
  ACT.queue = async (uid, x) => { sent.push([uid, x.args[0], x.args[1]]); return { ok: true }; };
  try {
    const b = await putUp("mem", "bobcf");                                   // bob has no PATV account
    await liveFor(b, 11); await stage.tick();
    assert.equal((await asksOf("bobcf")).length, 0, "no way to answer yet: no ask (and it isn't ended for that)");
    assert.equal((await slotRow(b)).status, "active");
    await LC.forBot({ cap: true, stage_ok: true });                         // a Pepe that forwards !stage ok / no
    sent.length = 0;
    await stage.tick();
    assert.equal((await asksOf("bobcf")).length, 1, "asked now");
    for (let i = 0; i < 50 && !sent.some((x) => x[1] === "bobcf"); i++) await new Promise((r) => setTimeout(r, 10));
    const pm = sent.find((x) => x[1] === "bobcf");
    assert.ok(pm && /!stage ok/.test(pm[2]) && pm[0] === U.owner.userId, "a PM via Pepe, queued as whoever put him up: " + JSON.stringify(sent));
    const act = (body) => post("/api/rooms/stage/act", null, Object.assign({ password: "bot", by: "bobcf", arg: "" }, body));
    assert.equal((await act({ room: PADS.mem.id, verb: "ok" })).d.code, "unproven", "a display name never answers for someone");
    const ok = await act({ room: PADS.mem.id, verb: "ok", proven: true });
    assert.deepEqual([ok.d.ok, ok.d.message], [true, `OK - you stay on ${rooms.getCached(PADS.mem.id).title}'s stage`], ok.text);
    await LC.forBot({ cap: true, stage_ok: true });
    LC.noteSync([{ name: LC.pathFor(PADS.mem.id, "bobcf"), ready: true, readers: [] }], T);
    await stage.tick();
    assert.equal((await slotRow(b)).status, "active");
    // on another pad, answered "no" in a PM to Pepe (no room): off, and kept off
    const p = await putUp("pub", "bobcf");
    await LC.forBot({ cap: true, stage_ok: true });
    await liveFor(p, 11); await stage.tick();
    const no = await act({ verb: "no", proven: true });
    assert.equal(no.d.ok, true, no.text);
    assert.equal(no.d.message, `you're off ${rooms.getCached(PADS.pub.id).title}'s stage on PATV - it can't put your cam back for 1 hour`);
    assert.equal((await slotRow(p)).end_reason, "cam_unavailable");
    assert.ok(SL.excludedUntil(PADS.pub.id, "bobcf", T) > T);
    assert.deepEqual((await act({ verb: "ok", proven: true })).d.ok, false, "nothing else is asking him");
  } finally { ACT.queue = was; await bot(); }
});

test("final: D-9 (a) - a 'this session' on-air OK covers picks from its own pad's room only", async () => {
  await onAir();
  await OA.setOptin("carolcf", false, { ts: T });
  await OA.setCam(PADS.mem.id, "carolcf", "t", { admin: ADMIN(), ask: true });
  const a = (await OAC.camAsks()).filter((x) => x.login === "carolcf").pop();
  assert.ok(a, "her OK is asked for");
  await OAC.decide(a.id, "session", { userId: U.carol.userId });
  assert.equal(OA.view().target && OA.view().target.login, "carolcf");
  await OA.clear("test", "test");
  await OA.setCam(PADS.mem.id, "carolcf", "t", { admin: ADMIN() });
  assert.equal(OA.view().target.room, PADS.mem.id, "a pick from the same pad's room within 6 h needs no new ask");
  await OA.clear("test", "test");
  await assert.rejects(OA.setCam(PADS.pub.id, "carolcf", "t", { admin: ADMIN() }), (e) => e.code === "no_optin",
    "the old code put her on air from another pad's room on that OK");
});

test("final: Take me off doubles the LAST length - after asking for 24 h, a re-pin right after it ends gets 24 h again", async () => {
  const HR = 3600 * 1000;
  let t = T + 60 * 24 * HR;
  const r1 = await SL.leave({ roomId: PADS.appr.id, login: "dancf", via: "chat", hours: 24 }, t);
  assert.equal(r1.until - t, 24 * HR);
  t = r1.until + MIN;                                    // the pad puts him straight back; he types "!stage off me" (no hours)
  const r2 = await SL.leave({ roomId: PADS.appr.id, login: "dancf", via: "chat" }, t);
  assert.equal(r2.until - t, 24 * HR, "the old code gave 2 h (it doubled by count)");
  t = r2.until + 24 * HR + 1000;                         // a day after it ended: a new run
  assert.equal((await SL.leave({ roomId: PADS.appr.id, login: "dancf", via: "web" }, t)).until - t, HR);
  assert.equal(SL.lengthFor(2, null, 3 * HR), 6 * HR);
  await runQuery("DELETE FROM stage_leave WHERE login = 'dancf'"); await SL.load(T);
});

test("final: an on-air cam target saved before actor_ids existed still comes off over a block with whoever picked it", async () => {
  await onAir();
  await OA.setOptin("erincf", true, { ts: T + 10 });
  try {
    await OA.setCam(PADS.mem.id, "erincf", "web:boss", { admin: ADMIN() });
    assert.equal(OA.view().target.login, "erincf");
    // as an older build saved it: no actor_ids; then the site restarts
    const row = (await getQuery("SELECT target FROM onair_state WHERE id = 1"))[0];
    const tg = JSON.parse(row.target);
    delete tg.actor_ids;
    await runQuery("UPDATE onair_state SET target = ? WHERE id = 1", [JSON.stringify(tg)]);
    OA._reset(); await OA.init();
    assert.equal(OA.view().target && OA.view().target.login, "erincf");
    await dmBlock(U.erin, U.boss);
    await OA.check();
    assert.equal(OA.view().target, null, "the old code skipped the block check until the cam was picked again");
  } finally { await dmUnblock(U.erin, U.boss); await OA.setOptin("erincf", false, { ts: T + 20 }); }
});

test("final: the new tables are merged with the account, in its export, deleted with it", async () => {
  await pinReset();
  const AM = require(path.join(repo, "accountMerge"));
  for (const [t, c] of [["stage_level", "user_id"], ["stage_pad_prefs", "user_id"], ["stage_asks", "user_id"], ["stage_asks", "actor_id"]]) assert.ok(AM.classify(t, c), t + "." + c);
  const AD = require(path.join(repo, "accountdelete"));
  for (const t of ["stage_level", "stage_pad_prefs", "stage_asks"]) {
    assert.ok(AD.DELETE_ROWS.some(([x, c]) => x === t && c === "login"), t);
    assert.ok(AD.DELETE_ROWS.some(([x, c]) => x === t && c === "user_id"), t);
  }
  assert.equal((await level(U.erin, "off")).status, 200);
  try {
    const r = await putRaw("mem", U.owner, "erincf");
    assert.equal(r.d.asked, true);
    const EX = require(path.join(repo, "accountexport"));
    const out = await EX.collect(U.erin.userId);
    assert.equal(out.chat.stage_level[0].level, "off");
    assert.equal(out.chat.stage_asks.length, 1);
    assert.equal(out.chat.stage_asks[0].actor_id, undefined, "who asked stays theirs");
  } finally { await level(U.erin, "on"); }
});

test("final: client - the level, the asks and the per-pad yes on the card; Ask to put on stage; the cache-busters moved", () => {
  const ps = fs.readFileSync(path.join(repo, "public", "js", "privacy-stage.js"), "utf8");
  for (const s of ["/api/privacy/stage/level", "/api/stage/ask/", "/api/privacy/stage/pad", "keep_always"]) assert.ok(ps.includes(s), s);
  assert.doesNotMatch(ps, /innerHTML/, "all text via textContent");
  const view = fs.readFileSync(path.join(repo, "views", "privacy-settings.ejs"), "utf8");
  for (const id of ["pvSlLevel", "pvSlAskList", "pvSlYes"]) assert.match(view, new RegExp('id="' + id + '"'));
  assert.match(view, /privacy-stage\.js\?v=2/);
  const rm = fs.readFileSync(path.join(repo, "public", "js", "room-manage.js"), "utf8");
  assert.match(rm, /Ask to put on stage/);
  assert.match(rm, /waiting for their OK/);
  assert.match(rm, /j\.asked/);
  const pl = fs.readFileSync(path.join(repo, "public", "js", "pad-livecam.js"), "utf8");
  assert.match(pl, /d\.asked/);
  assert.match(fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8"), /pad-livecam\.js\?v=5/);
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  for (const k of ["sl.level", "sl.level_on", "sl.level_off", "sl.level_never", "sl.what_check", "sl.asks_h", "sl.yes_h", "sl.chat_ok",
                   "js.sl.keep", "js.sl.keep_always", "js.sl.allow", "js.pad.strip.stage_asked"]) assert.ok(en[k], k);
});
