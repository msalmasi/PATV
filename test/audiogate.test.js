// audiogate (bridge.js audioRecheck + roomrtc.recheck + padaccess.hearNow): a pad's room audio follows its audience rule for the
// listeners ALREADY connected, not only at connect time. /p/:slug/audio (raw MP3 and the framed ?lv=1 levels) and the ⚡ WebRTC
// sessions (roomrtc tickets / the MediaMTX hook) answer to padaccess.full for who the listener is NOW + the pad's 💎 bridge perk:
//   * a change ends them at once: a Public pad made Members / Approved, a member removed, a level reload (re-key / merge)
//   * the periodic pass (AUDIO_RECHECK_MS) ends them after a sign-out / sign-out everywhere, an account gone or demoted, the
//     bridge perk lost - the sign-in they connected with (sessions.js) rides with the listener / ticket, in memory only
//   * never cut: who still passes, a pad open to everyone (no lookups), a lookup that fails (kept, asked again); another pad's
//     listeners are never touched by this pad's change; a WebRTC session the hook never saw is ended on a change, never on a tick
//   * a mic-stage capture's tap ends once with its viewer's access
//   TZ=UTC PEPE_BOT_DIR=G:/wt/casino2-bot node --test test/audiogate.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audiogate-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.WHIP_AUTH_PEER;
delete process.env.ROOM_RTC_KEY_VERSION;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
require(path.join(repo, "terms"))._setRequired(false);
const PA = require(path.join(repo, "padaccess"));
const AG = require(path.join(repo, "adultgate"));
const AC = require(path.join(repo, "roomaudiocfg"));
const SE = require(path.join(repo, "sessions"));
const S = require(path.join(repo, "mainstage"));
const W = require(path.join(repo, "webrtc"));
const RR = require(path.join(repo, "roomrtc"));
const LC = require(path.join(repo, "livecam"));
const premium = require(path.join(repo, "premium"));
const bridge = require(path.join(repo, "bridge"));
const { refreshLogin } = require(path.join(repo, "middleware", "loginCookie"));

const FX = (() => {
  const p = path.join(process.env.PEPE_BOT_DIR || path.join(repo, "camfrog-bot"), "ci", "fixtures", "micvad", "posts.json");
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
})();

const PADS = {
  pub: { id: "agPub.Room", slug: "agpub-room", level: "public" },
  mem: { id: "agMem.Room", slug: "agmem-room", level: "members" },
  app: { id: "agApp.Room", slug: "agapp-room", level: "approved" },
  other: { id: "agOther.Room", slug: "agother-room", level: "members" },
};
const users = new Map();
const U = {};
async function mkUser(name, cls = "pleb") {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, 0, 5, '2026-01-01 00:00:00', 0)`, [id, name, name, cls]);
  const u = { userId: id, username: name, class: cls };
  users.set(id, u);
  return u;
}
const snapOf = (P) => ({ room: { id: P.id, name: P.id }, topic: "", count: 3, relay: true, mic_relay: true, audio: true, audio_on: true,
  members: [{ id: "pepefrog", login: "pepefrog", display: "Pepe", is_self: true }], mic: [] });

let base, server, seq = 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bot = (body) => fetch(base + "/api/bridge/audio", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: "bot", ...body }) }).then((r) => r.json());
const chunk = (P, i = 0) => (FX ? bot({ room: P.id, seq: seq++, data: FX.posts[i % FX.posts.length].data, lv: FX.posts[i % FX.posts.length].lv })
  : bot({ room: P.id, seq: seq++, data: Buffer.from("mp3-" + i).toString("base64") }));
/** who: a test user (x-test-user), {cookie} (a real sign-in through sessions.gate), or null (signed out) */
function open(url, who) {
  const headers = !who ? {} : who.cookie ? { cookie: "jwt=" + who.cookie } : { "x-test-user": who.userId };
  return new Promise((resolve, reject) => {
    const req = http.get(base + url, { headers }, (res) => {
      const st = { status: res.statusCode, headers: res.headers, chunks: [], ended: false, req };
      res.on("data", (c) => st.chunks.push(c));
      res.on("end", () => { st.ended = true; });
      res.on("close", () => { st.ended = true; });
      st.bytes = () => Buffer.concat(st.chunks);
      resolve(st);
    });
    req.on("error", reject);
  });
}
const post = (p, body, who) => fetch(base + p, { method: "POST", headers: Object.assign({ "content-type": "application/json" },
  !who ? {} : who.cookie ? { cookie: "jwt=" + who.cookie } : { "x-test-user": who.userId }), body: JSON.stringify(body || {}) })
  .then(async (r) => ({ status: r.status, d: await r.json().catch(() => null) }));
const until = async (fn, ms = 1500) => { for (let t = 0; t < ms && !fn(); t += 20) await sleep(20); return fn(); };
const close = (...ss) => { for (const s of ss) { try { s && s.req.destroy(); } catch (e) { /* closed */ } } };
const R = (P) => rooms.get(P.id);
const setLevel = async (P, lv) => PA.setLevel(U.owner, await R(P), lv);
/** a real sign-in: a sessions row + the cookie's JWT carrying its sid */
async function signIn(u) {
  const s = await SE.create(null, u.userId, "password");
  return { id: s.id, cookie: jwt.sign({ userId: u.userId, username: u.username, class: u.class, sid: s.sid }, process.env.SECRET_KEY, { expiresIn: "90d" }) };
}
const sid = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const kicked = [];

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, email TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  U.owner = await mkUser("agowner");
  U.m1 = await mkUser("agmember1");
  U.m2 = await mkUser("agmember2");
  U.plain = await mkUser("agplain");
  U.staff = await mkUser("agstaff", "Admin");
  U.alice = await mkUser("agalice");
  U.gone = await mkUser("aggone");
  await rooms.init(); await PA.init(); await AG.load(); await S.init(); await SE.init();
  for (const P of Object.values(PADS)) {
    await rooms.addRoom(P.id, P.id, "test");
    await rooms.setOwner(P.id, U.owner.username, "test");
    if (P.level !== "members") await setLevel(P, P.level);
  }
  for (const u of [U.m1, U.m2]) await runQuery("INSERT INTO pad_members (room_id, user_id, status) VALUES (?, ?, 'approved')", [PADS.app.id, u.userId]);
  await PA.load();
  await AC.init();
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(SE.gate);                                   // req.loginSession, as index.js mounts it
  const addUser = async (req, res, next) => {
    const id = req.get("x-test-user");
    req.user = id ? users.get(id) || null : null;
    const tok = !id && req.cookies && req.cookies.jwt;
    if (tok) { try { req.user = await refreshLogin(res, jwt.verify(tok, process.env.SECRET_KEY), getQuery); } catch (e) { req.user = null; } }
    next();
  };
  bridge.register(app, { addUser, isBotToken: (t) => t === "bot" });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await bridge.ingest({ rooms: Object.values(PADS).map(snapOf) });
  LC._setKick((id) => kicked.push(id));
});
test.after(() => { LC._setKick(() => {}); server.close(); try { server.closeAllConnections(); } catch (e) { /* older node */ } });
test.beforeEach(async () => {
  kicked.length = 0;
  RR._reset();
  for (const P of Object.values(PADS)) if (PA.levelOf(P.id) !== P.level) await setLevel(P, P.level);
});

test("the periodic pass runs every 10-30 s", () => {
  assert.ok(bridge.AUDIO_RECHECK_MS >= 10e3 && bridge.AUDIO_RECHECK_MS <= 30e3, String(bridge.AUDIO_RECHECK_MS));
  assert.equal(typeof bridge.audioRecheck, "function");
});

test("MP3 raw + framed: Public -> Members ends the signed-out listeners at once (no more audio, no more levels); a signed-in one keeps listening", async () => {
  const P = PADS.pub;
  await chunk(P, 2);
  const raw = await open("/p/" + P.slug + "/audio", null), fr = await open("/p/" + P.slug + "/audio?lv=1", null), mine = await open("/p/" + P.slug + "/audio", U.plain);
  try {
    assert.deepEqual([raw.status, fr.status, mine.status], [200, 200, 200]);
    await chunk(P, 3); await sleep(50);
    const before = [raw.bytes().length, fr.bytes().length, mine.bytes().length];
    await setLevel(P, "members");
    assert.equal((await open("/p/" + P.slug + "/audio", null)).status, 401, "a new signed-out request is refused");
    for (let i = 4; i < 9; i++) await chunk(P, i);
    await sleep(80);
    assert.equal(await until(() => raw.ended && fr.ended), true, "both signed-out streams ended");
    assert.equal(raw.bytes().length - before[0], 0, "no MP3 after the change");
    assert.equal(fr.bytes().length - before[1], 0, "no framed records (MP3 or levels) after the change");
    assert.equal(mine.ended, false, "the signed-in listener still passes");
    assert.ok(mine.bytes().length > before[2], "...and keeps receiving");
  } finally { close(raw, fr, mine); }
});

test("MP3 Approved: removing a member ends their stream at once; the other member, the owner and staff keep theirs", async () => {
  const P = PADS.app;
  const s1 = await open("/p/" + P.slug + "/audio", U.m1), s2 = await open("/p/" + P.slug + "/audio", U.m2);
  const so = await open("/p/" + P.slug + "/audio", U.owner), ss = await open("/p/" + P.slug + "/audio", U.staff);
  try {
    assert.deepEqual([s1.status, s2.status, so.status, ss.status], [200, 200, 200, 200]);
    await PA.remove(U.owner, await R(P), U.m1.userId);
    assert.equal(await until(() => s1.ended), true, "the removed member's stream ended");
    await chunk(P); await sleep(50);
    assert.deepEqual([s2.ended, so.ended, ss.ended], [false, false, false]);
    assert.equal((await open("/p/" + P.slug + "/audio", U.m1)).status, 403);
  } finally {
    close(s1, s2, so, ss);
    await runQuery("UPDATE pad_members SET status = 'approved' WHERE room_id = ? AND user_id = ?", [P.id, U.m1.userId]);
    await PA.load();
  }
});

test("MP3 Members -> Approved: a signed-in non-member's stream ends, the owner's stays", async () => {
  const P = PADS.mem;
  const sp = await open("/p/" + P.slug + "/audio", U.plain), so = await open("/p/" + P.slug + "/audio", U.owner);
  try {
    await setLevel(P, "approved");
    assert.equal(await until(() => sp.ended), true);
    await sleep(50);
    assert.equal(so.ended, false);
  } finally { close(sp, so); }
});

test("sign-out: the stream opened with a sign-in ends on the next pass once it's revoked - on a Members pad; a Public pad keeps playing", async () => {
  const s = await signIn(U.alice);
  const mem = await open("/p/" + PADS.mem.slug + "/audio", { cookie: s.cookie }), pub = await open("/p/" + PADS.pub.slug + "/audio", { cookie: s.cookie });
  try {
    assert.deepEqual([mem.status, pub.status], [200, 200]);
    assert.equal(await bridge.audioRecheck("tick").pending, 0, "a live sign-in passes");
    assert.equal(mem.ended, false);
    await SE.revoke(U.alice.userId, s.id);
    assert.equal((await open("/p/" + PADS.mem.slug + "/audio", { cookie: s.cookie })).status, 401, "the cookie is signed out now");
    assert.ok((await bridge.audioRecheck("tick").pending) >= 1);
    assert.equal(await until(() => mem.ended), true, "the Members pad's stream ended");
    await sleep(50);
    assert.equal(pub.ended, false, "signed out may still hear a Public pad");
  } finally { close(mem, pub); }
});

test("account gone / demoted: the next pass ends the stream (class read again, not the one it connected with)", async () => {
  const sg = await open("/p/" + PADS.mem.slug + "/audio", U.gone);
  const ss = await open("/p/" + PADS.app.slug + "/audio", U.staff);       // staff: inside every Approved pad
  try {
    assert.deepEqual([sg.status, ss.status], [200, 200]);
    PA._setClock(() => Date.now() + 120e3);              // past the 60 s class cache
    await runQuery("DELETE FROM users WHERE userId = ?", [U.gone.userId]);
    await runQuery("UPDATE users SET class = 'pleb' WHERE userId = ?", [U.staff.userId]);
    await bridge.audioRecheck("tick").pending;
    assert.equal(await until(() => sg.ended && ss.ended), true);
  } finally {
    close(sg, ss);
    PA._setClock(null);
    await runQuery("UPDATE users SET class = 'Admin' WHERE userId = ?", [U.staff.userId]);
  }
});

test("a lookup that fails keeps the listener (no answer is not a no) and says so", async () => {
  const s = await signIn(U.alice);
  const st = await open("/p/" + PADS.mem.slug + "/audio", { cookie: s.cookie });
  const orig = SE.isLive, errs = [], oe = console.error;
  SE.isLive = async () => { throw new Error("SQLITE_BUSY"); };
  console.error = (...a) => errs.push(a.join(" "));
  try {
    assert.equal(st.status, 200);
    assert.equal(await bridge.audioRecheck("tick").pending, 0);
    await sleep(50);
    assert.equal(st.ended, false);
    assert.ok(errs.some((e) => /audiogate \(tick\): 1 listener check\(s\) failed - kept/.test(e)), errs.join("\n"));
  } finally { SE.isLive = orig; console.error = oe; close(st); }
});

test("the 💎 bridge perk lost: every listener of that pad ends (Public, signed in too); other pads untouched", async () => {
  const a = await open("/p/" + PADS.pub.slug + "/audio", null), b = await open("/p/" + PADS.pub.slug + "/audio", U.plain);
  const c = await open("/p/" + PADS.other.slug + "/audio", U.plain);
  const orig = premium.bridgeAllowed;
  premium.bridgeAllowed = (id) => id !== PADS.pub.id;
  try {
    await bridge.audioRecheck("tick").pending;
    assert.equal(await until(() => a.ended && b.ended), true);
    await sleep(50);
    assert.equal(c.ended, false);
  } finally { premium.bridgeAllowed = orig; close(a, b, c); }
});

test("a level reload (re-key / merge: padaccess.load) re-checks at once", async () => {
  const P = PADS.pub;
  const st = await open("/p/" + P.slug + "/audio", null);
  try {
    assert.equal(st.status, 200);
    await runQuery("UPDATE pad_access SET level = 'members' WHERE room_id = ?", [P.id]);
    await PA.load();
    assert.equal(await until(() => st.ended), true);
  } finally { close(st); }
});

test("a pad open to everyone is never asked about (no lookups), and one pad's change never touches another pad's listeners", async () => {
  const P = PADS.pub;
  const a = await open("/p/" + P.slug + "/audio", null), o = await open("/p/" + PADS.other.slug + "/audio", U.plain);
  // ⚡ on the other (Members) pad: a session the hook never saw (a site restart) - a change elsewhere must leave it alone
  RR._state.set(PADS.other.id, { wantUntil: 0, readers: 1, ready: true, seenAt: Date.now(), readerIds: [sid(90)] });
  const orig = PA.hearNow;
  let asked = 0;
  PA.hearNow = async (...x) => { asked++; return orig(...x); };
  try {
    assert.equal(await bridge.audioRecheck("tick").pending, 0);
    assert.equal(await RR.recheck("tick"), 0);
    assert.equal(asked, 1, "only the Members pad's signed-in listener was asked about");
    await setLevel(P, "approved");
    assert.equal(await until(() => a.ended), true);
    await sleep(50);
    assert.equal(o.ended, false);
    assert.deepEqual(kicked, [], "the other pad's unknown WebRTC session stays");
    await RR.recheck("change", PADS.other.id);
    assert.deepEqual(kicked, [sid(90)], "a change on ITS pad ends it (it can ask for a new ticket)");
  } finally { PA.hearNow = orig; close(a, o); }
});

test("mic-stage capture tap: ends once when its viewer's access goes; another viewer's tap carries on", async () => {
  const P = PADS.app;
  let e1 = 0, e2 = 0;
  const got2 = [];
  const f1 = () => {}; f1.end = () => { e1++; };
  const f2 = (buf) => got2.push(buf); f2.end = () => { e2++; };
  const u1 = bridge.audioTap(P.id, f1, U.m1), u2 = bridge.audioTap(P.id, f2, U.m2);
  try {
    assert.ok(u1 && u2);
    await PA.remove(U.owner, await R(P), U.m1.userId);
    assert.equal(e1, 1);
    await bridge.audioRecheck("tick").pending;
    assert.equal(e1, 1, "once");
    await chunk(P);
    assert.equal(e2, 0);
    assert.ok(got2.length >= 1);
  } finally {
    if (u1) u1(); if (u2) u2();
    await runQuery("UPDATE pad_members SET status = 'approved' WHERE room_id = ? AND user_id = ?", [P.id, U.m1.userId]);
    await PA.load();
  }
});

// ── ⚡ WebRTC ──
const hook = (P, b) => W.whipAuth(Object.assign({ path: RR.pathFor(P.id), ip: "9.9.9.9", action: "read", protocol: "webrtc" }, b));
async function rtcOn() {
  W._resetLimits();
  await S.setConfig({ webrtc_enabled: true, room_rtc: "all", room_rtc_cap: 25 }, "test");
  for (const P of Object.values(PADS)) await bot({ room: P.id, seq: seq++, data: "", rtc_cap: true });
}

test("⚡ tightening a pad kicks the signed-out session at once and a removed member's; who still passes keeps theirs", async () => {
  await rtcOn();
  const now = Date.now();
  RR._state.set(PADS.pub.id, { wantUntil: 0, readers: 2, ready: true, seenAt: now, readerIds: [sid(1), sid(2)] });
  RR._readers.set(sid(1), { uid: null, roomId: PADS.pub.id, at: now });
  RR._readers.set(sid(2), { uid: U.plain.userId, roomId: PADS.pub.id, at: now });
  RR._readers.set(sid(3), { uid: U.m1.userId, roomId: PADS.app.id, at: now });     // just let in - MediaMTX hasn't listed it yet
  RR._readers.set(sid(4), { uid: U.m2.userId, roomId: PADS.app.id, at: now });
  try {
    await setLevel(PADS.pub, "members");
    assert.equal(await until(() => kicked.length >= 1), true);
    await sleep(50);
    assert.deepEqual(kicked, [sid(1)]);
    kicked.length = 0;
    await PA.remove(U.owner, await R(PADS.app), U.m1.userId);
    assert.equal(await until(() => kicked.length >= 1), true);
    await sleep(50);
    assert.deepEqual(kicked, [sid(3)], "a session the hook saw counts before MediaMTX lists it");
    kicked.length = 0;
    assert.equal(await RR.recheck("tick"), 0, "the tick keeps everyone who still passes");
  } finally {
    await runQuery("UPDATE pad_members SET status = 'approved' WHERE room_id = ? AND user_id = ?", [PADS.app.id, U.m1.userId]);
    await PA.load();
  }
});

test("⚡ the ticket remembers the sign-in it was asked under (memory only): signed out, the hook refuses it and the tick kicks the session", async () => {
  await rtcOn();
  const s = await signIn(U.alice);
  const r = await post("/api/rooms/" + PADS.mem.slug + "/audio/rtc", {}, { cookie: s.cookie });
  assert.equal(r.status, 200); assert.equal(r.d.ok, true, JSON.stringify(r.d));
  const pt = new URL(r.d.whep).searchParams.get("pt");
  assert.ok(!pt.includes(s.id) && !r.d.whep.includes(s.id), "the sign-in never rides in the URL");
  assert.equal(RR.ticketSession(pt, U.alice.userId), s.id);
  assert.equal(RR.ticketSession(pt, U.plain.userId), null, "only for its own account");
  assert.equal(await hook(PADS.mem, { query: "pt=" + encodeURIComponent(pt), id: sid(20) }), 200);
  assert.equal(RR._readers.get(sid(20)).ls, s.id);
  RR._state.set(PADS.mem.id, { wantUntil: 0, readers: 1, ready: true, seenAt: Date.now(), readerIds: [sid(20)] });
  assert.equal(await RR.recheck("tick"), 0);
  await SE.revoke(U.alice.userId, s.id);
  assert.equal(await hook(PADS.mem, { query: "pt=" + encodeURIComponent(pt), id: sid(21) }), 403, "a ticket from before the sign-out opens nothing");
  assert.equal(await RR.recheck("tick"), 1);
  assert.deepEqual(kicked, [sid(20)]);
  // the same ticket on a Public pad: a signed-out listener may hear it there
  const p2 = await post("/api/rooms/" + PADS.pub.slug + "/audio/rtc", {}, U.plain);
  assert.equal(p2.d.ok, true);
  assert.equal(RR.ticketSession(new URL(p2.d.whep).searchParams.get("pt"), U.plain.userId), null, "no sign-in seen (a test user): account only");
});

test("⚡ the bridge perk lost kicks every session of that pad; a pad open to everyone asks nothing", async () => {
  await rtcOn();
  const now = Date.now();
  RR._state.set(PADS.pub.id, { wantUntil: 0, readers: 2, ready: true, seenAt: now, readerIds: [sid(30), sid(31)] });
  RR._readers.set(sid(30), { uid: null, roomId: PADS.pub.id, at: now });
  RR._readers.set(sid(31), { uid: U.staff.userId, roomId: PADS.pub.id, at: now });
  const orig = premium.bridgeAllowed, oh = PA.hearNow;
  let asked = 0;
  PA.hearNow = async (...x) => { asked++; return oh(...x); };
  try {
    assert.equal(await RR.recheck("change"), 0);
    assert.equal(asked, 0, "Public: nothing looked up");
    premium.bridgeAllowed = (id) => id !== PADS.pub.id;
    assert.equal(await RR.recheck("tick"), 2);
    assert.deepEqual(kicked.slice().sort(), [sid(30), sid(31)]);
  } finally { premium.bridgeAllowed = orig; PA.hearNow = oh; }
});

test("hearNow: open pads answer without lookups; a sign-in that's gone counts as signed out; a database error throws", async () => {
  assert.equal(await PA.hearNow(null, PADS.pub.id), true);
  assert.equal(await PA.hearNow(null, PADS.mem.id), false);
  assert.equal(await PA.hearNow(U.plain.userId, PADS.mem.id), true);
  assert.equal(await PA.hearNow(U.plain.userId, PADS.app.id), false);
  assert.equal(await PA.hearNow(U.m2.userId, PADS.app.id), true);
  const s = await signIn(U.alice);
  assert.equal(await PA.hearNow(U.alice.userId, PADS.mem.id, { session: s.id }), true);
  assert.equal(await PA.hearNow(U.plain.userId, PADS.mem.id, { session: s.id }), false, "someone else's sign-in");
  await SE.revoke(U.alice.userId, s.id);
  assert.equal(await PA.hearNow(U.alice.userId, PADS.mem.id, { session: s.id }), false);
  assert.equal(await PA.hearNow(U.alice.userId, PADS.pub.id, { session: s.id }), true, "Public");
  const orig = SE.isLive;
  SE.isLive = async () => { throw new Error("SQLITE_BUSY"); };
  try { await assert.rejects(PA.hearNow(U.alice.userId, PADS.mem.id, { session: "x" }), /SQLITE_BUSY/); }
  finally { SE.isLive = orig; }
});
