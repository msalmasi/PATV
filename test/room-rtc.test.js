// 1.99il: low-latency room audio over WebRTC (roomrtc.js + the bridge / webrtc hooks): the setting, path names, the
// publish lifecycle Pepe is told about (want / grace / rtc_beat), listener gating + the TURN cap, which way the player
// falls back, and the MediaMTX auth hook for room paths (Pepe's bearer, viewer tickets, padaccess levels).
//   NODE_PATH=G:/PATV/node_modules node --test test/room-rtc.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "room-rtc-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.WHIP_AUTH_PEER;
delete process.env.ROOM_RTC_KEY_VERSION;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "mainstage"));
const W = require(path.join(repo, "webrtc"));
const RR = require(path.join(repo, "roomrtc"));
const PA = require(path.join(repo, "padaccess"));
const rooms = require(path.join(repo, "rooms"));
const bridge = require(path.join(repo, "bridge"));

const ALPHA = "Alpha.Room", BETA = "Beta.Room";
let base, server;
const post = (p, body, user) => fetch(base + p, { method: "POST", headers: Object.assign({ "content-type": "application/json" }, user ? { "x-test-user": user } : {}),
  body: JSON.stringify(body || {}) }).then(async (r) => ({ status: r.status, d: await r.json().catch(() => null) }));
const bot = (p, body) => post(p, Object.assign({ password: "bot-token" }, body)).then((r) => r.d);
const room = (id, name, a) => Object.assign({ room: { id, name }, topic: "", members: [{ login: "bob", display: "Bob" }], count: 2, audio: true, audio_on: true }, a);
const sync = () => bot("/api/bridge/sync", { events: [], rooms: [room(ALPHA, "Alpha"), room(BETA, "Beta")] });
const beat = (id, extra = {}) => bot("/api/bridge/audio", Object.assign({ room: id, seq: 1, data: "", rtc_cap: true }, extra));
const cfg = (patch) => S.setConfig(patch, "test");
let offset = 0;
RR._setClock(() => Date.now() + offset);

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  for (const [id, cls] of [["u1", "pleb"], ["u2", "pleb"], ["adm", "Admin"]]) {
    await runQuery("INSERT OR IGNORE INTO users (userId, username, displayname, password, class) VALUES (?, ?, ?, 'x', ?)", [id, id, id, cls]);
  }
  await S.init();
  await PA.init();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u, username: u, class: u === "adm" ? "Admin" : "pleb" } : null; next(); });
  bridge.register(app, { isBotToken: (t) => t === "bot-token", addUser: (req, res, next) => next() });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await sync();
});
test.after(() => { server.close(); });
test.beforeEach(async () => {
  offset = 0;
  RR._reset();
  W._resetLimits();
  await cfg({ webrtc_enabled: true, room_rtc: "all", room_rtc_cap: 25 });
  await sync();
});

test("settings: room_rtc off by default, only off / prime / all; the cap is clamped", async () => {
  assert.equal(S.DEFAULTS.room_rtc, "off");
  assert.equal(S.DEFAULTS.room_rtc_cap, 25);
  await cfg({ room_rtc: "everyone", room_rtc_cap: 9999 });
  assert.equal(S.config().room_rtc, "off", "an unknown mode is off");
  assert.equal(S.config().room_rtc_cap, 500);
  await cfg({ room_rtc: "prime", room_rtc_cap: -3 });
  assert.equal(S.config().room_rtc, "prime");
  assert.equal(S.config().room_rtc_cap, 0);
});

test("paths: an HMAC of the room id per site prefix; only this site's paths map back to a room", () => {
  const a = RR.pathFor(ALPHA), b = RR.pathFor(BETA);
  assert.match(a, /^room-[0-9a-f]{16}$/);
  assert.notEqual(a, b);
  assert.equal(RR.pathFor(ALPHA), a, "stable");
  assert.ok(!a.includes("Alpha"), "no room name in the URL");
  assert.equal(RR.roomForPath(a).id, ALPHA);
  assert.equal(RR.roomForPath("stgr-" + a.slice(5)), null, "the staging prefix is the other site's");
  assert.equal(RR.roomForPath("room-0000000000000000"), null);
  assert.ok(RR.PATH_RE.test("stgr-0123456789abcdef"));
  assert.ok(!W.PATH_RE.test(a) && !W.PATH_RE.test("stgr-0123456789abcdef"), "never a stage slot path");
});

test("lifecycle: no rtc until someone asks; a ticket makes Pepe publish; it stops GRACE after the last listener", async () => {
  let r = await beat(ALPHA);
  assert.equal(r.rtc, null, "nobody asked");
  assert.equal(r.rtc_beat, 1, "an eligible room heartbeats every second");
  const t = await post("/api/rooms/alpha/audio/rtc", {}, "u1");
  assert.equal(t.status, 200);
  assert.equal(t.d.ok, true);
  assert.match(t.d.whep, /^https:\/\/stream\.publicaccess\.tv\/whep\/room-[0-9a-f]{16}\?pt=ra1\./);
  r = await beat(ALPHA);
  assert.ok(r.rtc, "now he's told to publish");
  assert.equal(r.rtc.path, RR.pathFor(ALPHA));
  assert.equal(r.rtc.url, "https://stream.publicaccess.tv/whip/" + RR.pathFor(ALPHA));
  assert.match(r.rtc.token, /^ra[A-Za-z0-9_-]{40}$/);
  assert.equal(r.rtc.ready, false);
  assert.equal((await beat(BETA)).rtc, null, "only the room that was asked for");
  // MediaMTX lists a reader: it keeps the room wanted past the ticket's grace
  offset = RR.GRACE_MS - 1000;
  RR.noteSync([{ name: RR.pathFor(ALPHA), ready: true, readers: [{ type: "webRTCSession", id: "x" }] }]);
  offset = RR.GRACE_MS + 5000;
  r = await beat(ALPHA);
  assert.ok(r.rtc && r.rtc.ready, "still wanted (a reader), and the path is up");
  // the reader is gone (last seen at GRACE - 1 s): still published for the grace after that, then rtc: null
  RR.noteSync([{ name: RR.pathFor(ALPHA), ready: true, readers: [] }]);
  offset = 2 * RR.GRACE_MS - 2000;
  assert.ok((await beat(ALPHA)).rtc, "inside the grace");
  offset = 2 * RR.GRACE_MS;
  assert.equal((await beat(ALPHA)).rtc, null, "after the grace: stop");
});

test("gating: an older Pepe (no rtc_cap), audio off, the setting off, the WebRTC servers off -> the MP3 relay", async () => {
  // a fresh room that never said rtc_cap
  await bot("/api/bridge/sync", { events: [], rooms: [room("Gamma.Room", "Gamma")] });
  let t = await post("/api/rooms/gamma/audio/rtc", {}, "u1");
  assert.deepEqual([t.d.ok, t.d.fallback], [false, "not-eligible"]);
  assert.equal((await bot("/api/bridge/audio", { room: "Gamma.Room", seq: 1, data: "" })).rtc, null);
  await beat("Gamma.Room");
  t = await post("/api/rooms/gamma/audio/rtc", {}, "u1");
  assert.equal(t.d.ok, true, "once Pepe says he can publish");
  // the live view's hint follows the same rule
  const live = await fetch(base + "/api/rooms/gamma/live", { headers: { "x-test-user": "u1" } }).then((x) => x.json());
  assert.equal(live.room.rtc, true);
  await cfg({ room_rtc: "off" });
  assert.deepEqual((await post("/api/rooms/alpha/audio/rtc", {}, "u1")).d, { ok: false, fallback: "off" });
  const off = await fetch(base + "/api/rooms/gamma/live", { headers: { "x-test-user": "u1" } }).then((x) => x.json());
  assert.equal(off.room.rtc, false);
  await cfg({ room_rtc: "all", webrtc_enabled: false });
  assert.deepEqual((await post("/api/rooms/alpha/audio/rtc", {}, "u1")).d, { ok: false, fallback: "off" });
  await cfg({ webrtc_enabled: true });
  await bot("/api/bridge/sync", { events: [], rooms: [room(ALPHA, "Alpha", { audio: false })] });
  const na = await post("/api/rooms/alpha/audio/rtc", {}, "u1");
  assert.equal(na.status, 404);
  assert.equal(na.d.fallback, "no-audio");
});

test("prime mode: Prime Time pads (pad.primeTime) and comped house pads only", async () => {
  await cfg({ room_rtc: "prime" });
  await beat(ALPHA); await beat(BETA);
  const orig = rooms.getCached;
  try {
    rooms.getCached = (id) => (id === ALPHA ? { id, primeTime: true } : id === BETA ? { id, house: false } : null);
    assert.equal((await post("/api/rooms/alpha/audio/rtc", {}, "u1")).d.ok, true);
    assert.equal((await post("/api/rooms/beta/audio/rtc", {}, "u1")).d.fallback, "not-eligible");
    rooms.getCached = (id) => ({ id, primeTime: { active: false } });
    assert.equal(RR.isPrime(ALPHA), false, "a lapsed tier");
    rooms.getCached = (id) => ({ id, house: true });
    assert.equal(RR.isPrime(BETA), true, "the house pad is comped");
  } finally { rooms.getCached = orig; }
});

test("TURN cap: readers + fresh tickets count; over the cap the ticket says busy", async () => {
  await cfg({ room_rtc_cap: 2 });
  await beat(ALPHA);
  assert.equal((await post("/api/rooms/alpha/audio/rtc", {}, "u1")).d.ok, true);
  assert.equal((await post("/api/rooms/alpha/audio/rtc", {}, "u2")).d.ok, true);
  assert.equal(RR.active(), 2);
  assert.deepEqual((await post("/api/rooms/alpha/audio/rtc", {}, "adm")).d, { ok: false, fallback: "busy" });
  // the tickets age out of "pending"; MediaMTX shows one of them actually connected
  offset = RR.PENDING_MS + 1000;
  RR.noteSync([{ name: RR.pathFor(ALPHA), ready: true, readers: [{ type: "webRTCSession", id: "a" }, { type: "hlsMuxer" }] }]);
  assert.equal(RR.active(), 1, "only WebRTC readers count");
  await beat(ALPHA);
  assert.equal((await post("/api/rooms/alpha/audio/rtc", {}, "adm")).d.ok, true);
  await cfg({ room_rtc_cap: 0 });
  assert.equal((await post("/api/rooms/alpha/audio/rtc", {}, "u1")).d.fallback, "busy", "cap 0 = nobody");
});

test("auth hook: Pepe's bearer publishes; a viewer's ticket reads over WebRTC only; padaccess levels apply", async () => {
  await beat(ALPHA);
  const p = RR.pathFor(ALPHA);
  const hook = (b) => W.whipAuth(Object.assign({ path: p, ip: "9.9.9.9" }, b));
  assert.equal(await hook({ action: "publish", protocol: "webrtc", token: RR.pubKey(p) }), 200);
  assert.equal(await hook({ action: "publish", protocol: "webrtc", token: RR.pubKey(RR.pathFor(BETA)) }), 403, "another room's bearer");
  assert.equal(await hook({ action: "publish", protocol: "webrtc" }), 401);
  assert.equal(await hook({ action: "publish", protocol: "rtsp", token: RR.pubKey(p) }), 403);
  const tk = RR.readTicket("u1", p);
  assert.equal(await hook({ action: "read", protocol: "webrtc", query: "pt=" + encodeURIComponent(tk) }), 200);
  assert.equal(await hook({ action: "read", protocol: "hls", query: "pt=" + encodeURIComponent(tk) }), 403, "no HLS of room audio");
  assert.equal(await hook({ action: "read", protocol: "webrtc" }), 401, "no ticket");
  assert.equal(await hook({ action: "read", protocol: "webrtc", query: "pt=" + encodeURIComponent(RR.readTicket("u1", RR.pathFor(BETA))) }), 401, "another room's ticket");
  assert.equal(await hook({ action: "read", protocol: "webrtc", query: "pt=" + encodeURIComponent(tk.slice(0, -2) + "xx") }), 401, "a forged ticket");
  offset = RR.TICKET_MS + 1000;
  await beat(ALPHA);
  assert.equal(await hook({ action: "read", protocol: "webrtc", query: "pt=" + encodeURIComponent(tk) }), 401, "expired");
  offset = 0;
  // the levels: a signed-out ticket on a Members pad is refused; on a Public pad it works
  const anon = RR.readTicket(null, p);
  assert.equal(await hook({ action: "read", protocol: "webrtc", query: "pt=" + encodeURIComponent(anon) }), 403);
  await runQuery("INSERT INTO pad_access (room_id, level) VALUES (?, 'public') ON CONFLICT(room_id) DO UPDATE SET level = 'public'", [ALPHA]);
  await PA.load();
  assert.equal(await hook({ action: "read", protocol: "webrtc", query: "pt=" + encodeURIComponent(anon) }), 200, "Public pad: anyone");
  // Approved: only the people inside (an approved member, staff); and it's re-checked at read time
  await runQuery("UPDATE pad_access SET level = 'approved' WHERE room_id = ?", [ALPHA]);
  await runQuery("INSERT OR REPLACE INTO pad_members (room_id, user_id, status) VALUES (?, 'u2', 'approved')", [ALPHA]);
  await PA.load();
  try {
    assert.equal(await hook({ action: "read", protocol: "webrtc", query: "pt=" + encodeURIComponent(RR.readTicket("u1", p)) }), 403, "outside");
    assert.equal(await hook({ action: "read", protocol: "webrtc", query: "pt=" + encodeURIComponent(RR.readTicket("u2", p)) }), 200, "an approved member");
    assert.equal(await hook({ action: "read", protocol: "webrtc", query: "pt=" + encodeURIComponent(RR.readTicket("adm", p)) }), 200, "an admin");
    // ...and the ticket endpoint refuses outsiders before handing anything out (the /api/rooms gate is padaccess.register's;
    // here the route's own check)
    assert.equal((await post("/api/rooms/alpha/audio/rtc", {}, "u1")).status, 403);
    assert.equal((await post("/api/rooms/alpha/audio/rtc", {})).status, 401);
    assert.equal((await post("/api/rooms/alpha/audio/rtc", {}, "u2")).d.ok, true);
  } finally {
    await runQuery("DELETE FROM pad_access WHERE room_id = ?", [ALPHA]);
    await runQuery("DELETE FROM pad_members WHERE room_id = ?", [ALPHA]);
    await PA.load();
  }
  // setting off -> every room path is refused
  await cfg({ room_rtc: "off" });
  assert.equal(await hook({ action: "publish", protocol: "webrtc", token: RR.pubKey(p) }), 403);
  // the other site's prefix: forwarded when there's a peer, refused without one; unknown paths refused
  await cfg({ room_rtc: "all" });
  assert.equal(await W.whipAuth({ action: "publish", protocol: "webrtc", path: "stgr-" + p.slice(5), token: "x" }), 403);
  assert.equal(await W.whipAuth({ action: "read", protocol: "webrtc", path: "room-0000000000000000" }), 403);
  // rotating the bearer
  process.env.ROOM_RTC_KEY_VERSION = "off";
  try { assert.equal(await hook({ action: "publish", protocol: "webrtc", token: "ra" + "x".repeat(40) }), 403); assert.equal((await beat(ALPHA)).rtc, null); }
  finally { delete process.env.ROOM_RTC_KEY_VERSION; }
});

test("a hook read keeps the room wanted, and the MediaMTX sync feeds the reader counts", async () => {
  await beat(ALPHA);
  const p = RR.pathFor(ALPHA);
  assert.equal((await beat(ALPHA)).rtc, null);
  assert.equal(await W.whipAuth({ action: "read", protocol: "webrtc", path: p, query: "pt=" + encodeURIComponent(RR.readTicket("u1", p)) }), 200);
  assert.ok((await beat(ALPHA)).rtc, "a WHEP attempt (e.g. a reconnect) asks for it too");
  RR._reset();
  W._setApi(async (method, url) => {
    assert.equal(method, "GET");
    assert.match(url, /\/v3\/paths\/list/);
    return { items: [{ name: p, ready: true, readers: [{ type: "webRTCSession", id: "a" }, { type: "webRTCSession", id: "b" }] },
                     { name: "pepe", ready: true }] };
  });
  try {
    await W.sync();
    assert.equal(RR.active(), 2);
    const r = await beat(ALPHA);
    assert.ok(r.rtc && r.rtc.ready, "readers on MediaMTX = wanted, and the path is up");
  } finally { W._setApi(null); }
});
