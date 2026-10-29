// Offline A/V sync server contract: dark rollout, audited settings, exact-chunk metadata and viewer-private cam timing.
"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const repo = path.resolve(__dirname, ".."), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "avsync-test-"));
process.chdir(tmp); process.env.SECRET_KEY = "test-secret"; delete process.env.STAGING;
const express = require("express"), db = require(path.join(repo, "dbUtils"));
const AV = require(path.join(repo, "avsync")), LC = require(path.join(repo, "livecam"));
const PA = require(path.join(repo, "padaccess")), B = require(path.join(repo, "bridge")), AC = require(path.join(repo, "roomaudiocfg"));
const W = require(path.join(repo, "webrtc")); W.enabled = () => true;
let time = Date.now(), base, server, cam, otherCam;
const writes = [];
AV._setClock(() => time); LC._setClock(() => time);
const ADMIN = { userId: "adm", username: "admin-example", class: "Admin" };
const ROOM = "Example.Alpha", OTHER = "Example.Beta", LOCKED = "Example.Locked";
function room(id, name) { return { room: { id, name }, topic: "", members: [{ login: "frog-example", display: "Example frog", on_cam: true }], count: 1, audio: true, audio_on: true, livecams: true, cams: true }; }
async function request(method, route, body, user = "v1", extra = {}) {
  const response = await fetch(base + route, { method, headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}), ...extra }, body: body == null ? undefined : JSON.stringify(body) });
  return { status: response.status, headers: response.headers, data: await response.json().catch(() => null) };
}
const post = (route, body, user, headers) => request("POST", route, body, user, headers);
const bot = (route, body) => post(route, { password: "bot-test", ...body }, null);
const get = (route, user) => request("GET", route, null, user);
const adminSave = (cfg) => post("/api/admin/pepe/avsync", { cfg }, "adm", { "X-Requested-With": "fetch" });
const publicPath = (paths) => "/api/rooms/alpha/avsync" + (paths ? "?p=" + encodeURIComponent(paths) : "");

test.before(async () => {
  await db.runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
    class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT)`);
  await db.runQuery("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  for (const id of ["adm", "v1", "v2", "limit"]) await db.runQuery("INSERT OR IGNORE INTO users (userId, username, password, class, camfrogUsername) VALUES (?, ?, 'x', ?, ?)", [id, id, id === "adm" ? "Admin" : "pleb", id + "-frog"]);
  await require(path.join(repo, "mainstage")).init(); await PA.init(); await AV.init(); await AC.init(); await LC.init();
  await LC.save(ADMIN, { cfg: { enabled: true, viewers_free: 4 } });
  const app = express(); app.use(express.json()); app.set("views", path.join(repo, "views")); app.set("view engine", "ejs");
  app.use((req, res, next) => { const id = req.get("x-test-user"); req.user = id ? { userId: id, username: id, class: id === "adm" ? "Admin" : "pleb" } : null; next(); });
  app.use((req, res, next) => {
    if (req.path === "/p/alpha/audio") {
      const write = res.write;
      res.write = function (chunk) { writes.push({ chunk: Buffer.from(chunk), meta: AV.audioMeta(ROOM) }); return write.apply(this, arguments); };
    }
    next();
  });
  const deps = { addUser: (req, res, next) => next(), isBotToken: (value) => value === "bot-test" };
  B.register(app, deps); AC.register(app, deps); AV.register(app, deps);
  server = app.listen(0); base = "http://127.0.0.1:" + server.address().port;
  await bot("/api/bridge/sync", { events: [], rooms: [room(ROOM, "Alpha"), room(OTHER, "Beta"), room(LOCKED, "Locked")] });
  await db.runQuery("INSERT INTO pad_access (room_id, level) VALUES (?, 'approved')", [LOCKED]); await PA.load();
  await bot("/api/bridge/livecam", { cap: true });
  const ticket = await post("/api/rooms/alpha/livecam", { login: "frog-example" }, "v1", { "X-Requested-With": "fetch" });
  assert.equal(ticket.data.ok, true, JSON.stringify(ticket)); cam = new URL(ticket.data.whep).pathname.split("/").pop();
  const other = await post("/api/rooms/beta/livecam", { login: "frog-example" }, "v1", { "X-Requested-With": "fetch" });
  assert.equal(other.data.ok, true, JSON.stringify(other)); otherCam = new URL(other.data.whep).pathname.split("/").pop();
  await bot("/api/bridge/livecam", { cap: true, live: [
    { room: ROOM, login: "frog-example", state: "live", source: "passthrough", hold_ms: 170.7, exact: true },
    { room: OTHER, login: "frog-example", state: "live", source: "reencode", hold_ms: 75, exact: true }
  ] });
});
test.after(() => { server.close(); });

test("dark defaults, all settings ranges and strict booleans; persisted settings reload", async () => {
  assert.equal(AV.current().v, 0); assert.equal(AV.DEFAULTS.mode, "off");
  assert.deepEqual([AV.DEFAULTS.engine_chromium, AV.DEFAULTS.engine_firefox, AV.DEFAULTS.engine_safari, AV.DEFAULTS.mods_instant], [true, false, false, false]);
  assert.deepEqual([AV.DEFAULTS.fallback_rtc_ms, AV.DEFAULTS.fallback_mp3_ms, AV.DEFAULTS.cap_ms, AV.DEFAULTS.cap_ind_ms, AV.DEFAULTS.period_s], [500, 1500, 3000, 3000, 2]);
  for (const [key, field] of Object.entries(AV.FIELDS)) {
    if (field.min == null) continue;
    assert.ok(AV.normalize({ [key]: field.min - 1 }).errors[key]);
    assert.ok(AV.normalize({ [key]: field.max + 1 }).errors[key]);
    assert.equal(AV.normalize({ [key]: field.min }).cfg[key], field.min);
    assert.equal(AV.normalize({ [key]: field.max }).cfg[key], field.max);
  }
  assert.ok(AV.normalize({ mode: "all" }).errors.mode); assert.ok(AV.normalize({ apply_video: "yes" }).errors.apply_video);
  assert.ok(AV.normalize({ cap_ms: true }).errors.cap_ms);
  assert.equal(AV.normalize({ cap_ms: 9000 }, { lenient: true }).cfg.cap_ms, 4000);
  assert.equal(AV.normalize({ apply_video: "false" }).cfg.apply_video, false);
  assert.equal(AV.normalize({ k_pt_ms: "-25" }).cfg.k_pt_ms, -25);
});

test("admin capability + same-site fetch, every save versioned and audited, invalid values atomic", async () => {
  assert.equal((await get("/api/admin/pepe/avsync", null)).status, 401);
  assert.equal((await get("/api/admin/pepe/avsync", "v1")).status, 403);
  assert.equal((await post("/api/admin/pepe/avsync", { cfg: { mode: "everyone" } }, "adm")).status, 403);
  assert.equal((await post("/api/admin/pepe/avsync", { cfg: { mode: "everyone" } }, "adm", { "X-Requested-With": "fetch", origin: "https://foreign.invalid" })).status, 403);
  const first = await adminSave({ mode: "admins", k_pt_ms: -100 }); assert.equal(first.status, 200); assert.equal(first.data.v, 1);
  const second = await adminSave({ mode: "admins" }); assert.equal(second.data.v, 2, "every accepted save gets an audit and version");
  const invalid = await adminSave({ cap_ms: 4001, apply_video: false }); assert.equal(invalid.status, 400); assert.equal(AV.current().v, 2); assert.equal(AV.current().cfg.apply_video, true);
  const audit = await db.getQuery("SELECT * FROM admin_audit WHERE action = 'avsync_cfg' ORDER BY id");
  assert.equal(audit.length, 2); assert.equal(JSON.parse(audit[0].detail).changed.mode[1], "admins");
  assert.equal(audit[0].admin_id, "adm");
  const prior = AV.current(); AV._reset(); await AV.init(); assert.deepEqual(AV.current(), prior, "versioned database row survives process cache reset");
  const page = await fetch(base + "/admin/pepe/audio", { headers: { "x-test-user": "adm" } });
  const html = await page.text(); assert.equal(page.status, 200); assert.match(html, /id="av-sync"/); assert.match(html, /admin-avsync\.js\?v=1/);
});

test("public route requires sign-in/full pad access; mode does not grant access; no identifiers or unheld cams", async () => {
  assert.equal((await get(publicPath(), null)).status, 401);
  assert.equal((await get("/api/rooms/locked/avsync", "v1")).status, 403);
  assert.equal((await get("/api/rooms/not-there/avsync", "v1")).status, 404);
  const viewer = await get(publicPath(cam + "," + otherCam + ",room-ffffffffffffffff"), "v1");
  assert.equal(viewer.data.on, false); assert.equal(viewer.data.dbg, false); assert.equal(viewer.headers.get("cache-control"), "no-store");
  assert.deepEqual(viewer.data.cams, { [cam]: { src: "passthrough", hold_ms: 171 } });
  assert.equal((await get(publicPath(cam), "adm")).data.on, true);
  assert.deepEqual((await get(publicPath(cam), "v2")).data.cams, {});
  const text = JSON.stringify(viewer.data); for (const privateValue of [ROOM, OTHER, "frog-example", "Example frog", "v1", "login", "room_id", "username"]) assert.ok(!text.includes(privateValue), privateValue);
  await adminSave({ mode: "everyone" }); assert.equal((await get(publicPath(), "v1")).data.on, true);
  await adminSave({ mode: "off" }); assert.equal((await get(publicPath(), "adm")).data.on, false);
  assert.equal((await get(publicPath(Array(13).fill(cam).join(",")), "v1")).status, 400);
});

test("slot holds reject other viewers, wrong pads, expired beats, removed holds and ended sessions", () => {
  const session = LC.camForPath(cam), viewer = session.viewers.get("v1"), beat = viewer.beat;
  assert.deepEqual(LC.holdOf(cam, "v1"), { src: "passthrough", hold_ms: 171 });
  assert.equal(LC.holdOf(cam, "v1", OTHER), null); assert.equal(LC.holdOf(cam, "v2"), null);
  viewer.beat = time - LC.BEAT_MS - 1; assert.equal(LC.holdOf(cam, "v1"), null); viewer.beat = beat;
  session.stageViewers.set("v2", { beat: time }); assert.equal(LC.holdOf(cam, "v2"), null);
  session.holds.add("test-stage"); assert.deepEqual(LC.holdOf(cam, "v2"), LC.relayHold(cam));
  session.stageViewers.get("v2").beat -= LC.BEAT_MS + 1; assert.equal(LC.holdOf(cam, "v2"), null);
  session.stageViewers.delete("v2"); session.holds.delete("test-stage");
  session.ended = time; assert.equal(LC.holdOf(cam, "v1"), null); assert.equal(LC.relayHold(cam), null); session.ended = 0;
});

test("audio posts keep a synchronous exact-chunk metadata snapshot; old posts never claim hm=0", async () => {
  const before = time, chunk = Buffer.from("mock MP3 chunk");
  const sent = { room: ROOM, seq: 1, data: chunk.toString("base64"), lat: { mix_ms: 710.4, helper_ms: 740, rtc_ms: 1480, mp3_ms: 980, login: "must disappear" }, hm: 1 };
  const controller = new AbortController();
  try {
    const stream = await fetch(base + "/p/alpha/audio", { signal: controller.signal, headers: { "x-test-user": "v1" } });
    assert.equal(stream.status, 200);
    assert.equal((await bot("/api/bridge/audio", sent)).status, 200);
    const expected = { lat: { mix_ms: 710, helper_ms: 740, rtc_ms: 1480, mp3_ms: 980 }, hm: 1, at: before };
    assert.deepEqual(AV.audioMeta(ROOM), expected);
    assert.deepEqual(writes, [{ chunk, meta: expected }], "the synchronous reader sees this chunk's metadata inside the listener write");
  } finally { controller.abort(); }
  const copy = AV.audioMeta(ROOM); copy.lat.mix_ms = 0; copy.hm = 0; assert.equal(AV.audioMeta(ROOM).hm, 1); assert.equal(AV.audioMeta(ROOM).lat.mix_ms, 710);
  await bot("/api/bridge/audio", { room: ROOM, seq: 2, data: "" }); assert.equal(AV.audioMeta(ROOM).hm, null); assert.equal(AV.audioMeta(ROOM).lat.rtc_ms, null);
  AV.noteAudio(ROOM, { lat: { mix_ms: -5, helper_ms: 500000, rtc_ms: true, mp3_ms: "55", extra: 999 }, hm: "0" });
  assert.deepEqual(AV.audioMeta(ROOM).lat, { mix_ms: 0, helper_ms: 30000, rtc_ms: null, mp3_ms: null }); assert.equal(AV.audioMeta(ROOM).hm, null);
  assert.equal(AV.audioMeta("missing"), null);
  assert.deepEqual(AC.cleanState({ rooms: { [ROOM]: { lat: sent.lat } } }).rooms[ROOM].lat, { mix_ms: 710, helper_ms: 740, rtc_ms: 1480, mp3_ms: 980 });
});

test("per-room two-second cache never caches viewer holds or rollout permission; age still advances", async () => {
  time += 2100; AV.noteAudio(ROOM, { lat: { rtc_ms: 1200 }, hm: 0 });
  const a = await get(publicPath(cam), "v1"); assert.equal(a.data.audio.rtc_ms, 1200); assert.equal(a.data.audio.age_s, 0);
  time += 500; AV.noteAudio(ROOM, { lat: { rtc_ms: 1500 }, hm: 1 });
  const b = await get(publicPath(cam), "v2"); assert.equal(b.data.audio.rtc_ms, 1200); assert.equal(b.data.audio.age_s, 0.5); assert.deepEqual(b.data.cams, {});
  await adminSave({ mode: "everyone" }); assert.equal((await get(publicPath(), "v1")).data.on, true, "mode is not cached");
  time += 1600; const c = await get(publicPath(), "v1"); assert.equal(c.data.audio.rtc_ms, 1500); assert.equal(c.data.audio.age_s, 1.6);
});

test("server offset has no browser/viewer terms, uses relay source calibration, rejects unknown/stale/wrong-room inputs", async () => {
  await adminSave({ k_pt_ms: -80, k_re_ms: 50 });
  AV.noteAudio(ROOM, { lat: { rtc_ms: 1500, mp3_ms: 900 }, hm: 0 }); AV.noteAudio(OTHER, { lat: { rtc_ms: 1200, mp3_ms: 800 }, hm: 0 });
  assert.equal(AV.serverOffsetMs(ROOM, cam, "rtc"), 1249); assert.equal(AV.serverOffsetMs(ROOM, cam, "mp3"), 649);
  assert.equal(AV.serverOffsetMs(OTHER, otherCam, "rtc"), 1175);
  assert.equal(AV.serverOffsetMs(ROOM, otherCam, "rtc"), null); assert.equal(AV.serverOffsetMs(ROOM, cam, "hls"), null);
  const slot = LC.camForPath(cam).viewers.get("v1"); slot.beat = time - LC.BEAT_MS - 1;
  assert.equal(LC.holdOf(cam, "v1"), null); assert.equal(AV.serverOffsetMs(ROOM, cam, "rtc"), 1249, "server clip calculation has no viewer dependency"); slot.beat = time;
  time += 30001; assert.equal(AV.serverOffsetMs(ROOM, cam, "rtc"), null);
});

test("admin diagnostics expose cleaned parts; public request rate is bounded", async () => {
  const admin = await get("/api/admin/pepe/avsync", "adm"); assert.equal(admin.status, 200);
  assert.ok(admin.data.rooms.some((row) => row.room === ROOM && Object.keys(row.lat).length === 4));
  assert.ok(admin.data.relays.some((row) => row.path === cam && row.hold_ms === 171));
  let last; for (let i = 0; i < 31; i++) last = await get(publicPath(), "limit");
  assert.equal(last.status, 429); assert.ok(Number(last.headers.get("retry-after")) > 0);
});

test("relay reports clamp finite numeric holds and keep absent/invalid holds unknown", async () => {
  for (const [raw, expected] of [[-1, 0], [1.5, 2], [10001, 10000], ["100", null], [true, null], [null, null], [undefined, null]]) {
    await bot("/api/bridge/livecam", { cap: true, live: [{ room: ROOM, login: "frog-example", state: "live", source: "passthrough", hold_ms: raw, exact: true }] });
    assert.deepEqual(LC.relayHold(cam), { src: "passthrough", hold_ms: expected });
  }
});

test("queued partial saves preserve both changes; reset restores dark defaults and is audited", async () => {
  const before = AV.current().v;
  const saved = await Promise.all([AV.save(ADMIN, { cfg: { k_pt_ms: 125 } }), AV.save(ADMIN, { cfg: { cap_ms: 2000 } })]);
  assert.deepEqual(saved.map((r) => r.v), [before + 1, before + 2]);
  assert.equal(AV.current().cfg.k_pt_ms, 125); assert.equal(AV.current().cfg.cap_ms, 2000);
  const reset = await post("/api/admin/pepe/avsync", { reset: true, reason: "test reset" }, "adm", { "X-Requested-With": "fetch" });
  assert.equal(reset.status, 200); assert.equal(reset.data.v, before + 3); assert.deepEqual(reset.data.cfg, AV.DEFAULTS);
  assert.equal(reset.data.view.audit[0].detail.action, "reset"); assert.equal(reset.data.view.audit[0].reason, "test reset");
});
