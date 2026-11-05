// audiogate (bridge.js audioRecheck + roomrtc.recheck + padaccess.hearNow): a pad's room audio follows its audience rule for the
// listeners ALREADY connected, not only at connect time. /p/:slug/audio (raw MP3 and the framed ?lv=1 levels) and the ⚡ WebRTC
// sessions (roomrtc tickets / the MediaMTX hook) answer to padaccess.full for who the listener is NOW + the pad's 💎 bridge perk:
//   * a change that can stop someone ends them at once: a Public pad made Members / Approved, a member removed, a level reload
//     (re-key / merge) that did either; an approval, a looser level or the same level again touches nobody (review R1)
//   * the periodic pass (AUDIO_RECHECK_MS) ends them after a sign-out / sign-out everywhere, an account gone or demoted, the
//     bridge perk lost - the sign-in they connected with (sessions.js) rides with the listener / ticket, in memory only
//   * never cut: who still passes (a "no" from the class cache is read again - review R2), a pad open to everyone (no lookups),
//     a lookup that fails (kept, asked again); another pad's listeners are never touched by this pad's change
//   * a WebRTC session the hook never saw (opened before a site restart) on a pad not open to everyone is ended on a change, and
//     on the tick once the hook's ids are confirmed (or it was there before the first pass) - review F1; a kick that didn't land
//     is tried again while MediaMTX lists it (F2); the hook asks the bridge perk too (F3)
//   * a mic-stage capture's tap ends once with its viewer's access; a 🔊 mic-clip preview answers to the same rule (F4)
//   * audiogate2 (listenban.js, owner 2026-11-05 "Yes"): a pad ban (and a site-wide one), a whole-bridge !bridge block (this pad or
//     every pad) and a network ban (its switch on) stop someone hearing the pad too - refused at connect and cut while listening, on
//     every path (MP3 raw + ?lv=1, ⚡ ticket / hook / sessions, the mic-stage tap + capture gate, the mic-clip preview); a one-feature
//     block and an incognito ban cut nothing; staff / exempt accounts pass a network ban; lifting lets them straight back in
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
async function mkUser(name, cls = "pleb", id = "u_" + name) {
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
  U.promo = await mkUser("agpromo");                  // (review) promoted while listening
  U.asker = await mkUser("agasker");                  // (review) asks to join the Approved pad
  U.carol = await mkUser("agcarol");
  U.dave = await mkUser("agdave");
  // audiogate2: ids as real accounts have them ("u:<id>" refs - padbans / targets.js - need [A-Za-z0-9-])
  for (const n of ["eve", "frank", "gina", "hank", "ivy", "lin", "lin2", "kim", "max"]) U[n] = await mkUser("ag" + n, "pleb", "ag2-" + n + "-0001");
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

// ── the live room's long-poll (the page's chat lines, the Dock and its pop-out): a page waiting when the pad tightens ──
let evSeq = 0;
const line = (P, text) => ({ op: "event", id: "ag-" + (++evSeq), ts: new Date().toISOString(), type: "message",
  scope: { platform: "camfrog", room: { id: P.id, name: P.id } }, data: { user: { id: "bobcf", login: "bobcf", display: "Bob" }, text } });
const getJson = (p, who) => fetch(base + p, { headers: !who ? {} : { "x-test-user": who.userId } })
  .then(async (r) => { const text = await r.text(); let d = null; try { d = JSON.parse(text); } catch (e) { /* not JSON */ } return { status: r.status, d, text }; });

test("long-poll: a page waiting on a pad made Members answers under the new level - refused, without the line that woke it", async () => {
  const P = PADS.pub;
  const first = await getJson("/api/rooms/" + P.slug + "/live", null);
  assert.equal(first.status, 200);
  const waiting = getJson(`/api/rooms/${P.slug}/live?wait=1&after=${first.d.cursor}&v=${first.d.ver}`, null);
  await sleep(50);
  await setLevel(P, "members");
  await bridge.ingest({ events: [line(P, "after-the-change-secret")], rooms: [snapOf(P)] });
  const lp = await waiting;
  assert.equal(lp.status, 401);
  assert.ok(!lp.text.includes("after-the-change-secret"));
});

test("long-poll: a removed member's waiting page gets no new line", async () => {
  const P = PADS.app;
  const first = await getJson("/api/rooms/" + P.slug + "/live", U.m1);
  assert.equal(first.status, 200);
  const waiting = getJson(`/api/rooms/${P.slug}/live?wait=1&after=${first.d.cursor}&v=${first.d.ver}`, U.m1);
  await sleep(50);
  try {
    await PA.remove(U.owner, await R(P), U.m1.userId);
    await bridge.ingest({ events: [line(P, "members-only-secret")], rooms: [snapOf(P)] });
    const lp = await waiting;
    assert.equal(lp.status, 403);
    assert.ok(!lp.text.includes("members-only-secret"));
    // who still passes gets it
    const ok = await getJson("/api/rooms/" + P.slug + "/live", U.m2);
    assert.equal(ok.status, 200);
    assert.ok(ok.text.includes("members-only-secret"));
  } finally {
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

// ── review fixes (access F1-F4, regression R1-R3) ──
/** what MediaMTX's path list says (webrtc.sync -> noteSync, every 5 s): {pad: [session ids]} - ONE listing for every pad */
const listAll = (by) => RR.noteSync(Object.entries(by).map(([k, ids]) => ({ name: RR.pathFor(PADS[k].id), ready: true,
  readers: ids.map((id) => ({ type: "webRTCSession", id })) })));
/** a ticket + the hook letting session `n` in, as the real flow does (-> the ticket) */
async function listen(P, who, n) {
  const r = await post("/api/rooms/" + P.slug + "/audio/rtc", {}, who);
  assert.equal(r.status, 200, JSON.stringify(r.d)); assert.equal(r.d.ok, true, JSON.stringify(r.d));
  const pt = new URL(r.d.whep).searchParams.get("pt");
  assert.equal(await hook(P, { query: "pt=" + encodeURIComponent(pt), id: sid(n) }), 200);
  return pt;
}

test("⚡ F1: after a site restart (MediaMTX kept the sessions, the site has no record) the first pass ends the ones on a pad not open to everyone (signed out everywhere / banned stops hearing it), a Public pad's stay; the rejoined sessions are recorded and kept", async () => {
  await rtcOn();
  const s = await signIn(U.carol);
  await listen(PADS.mem, { cookie: s.cookie }, 100);
  await listen(PADS.mem, U.dave, 101);
  await listen(PADS.pub, null, 102);
  listAll({ mem: [sid(100), sid(101)], pub: [sid(102)] });
  RR._reset();                                                // the deploy: everything the site remembered is gone
  listAll({ mem: [sid(100), sid(101)], pub: [sid(102)] });    // ...MediaMTX still lists the sessions
  await SE.revokeAll(U.carol.userId, { why: "ban" });         // a site ban / sign out everywhere
  assert.equal(await RR.recheck("tick"), 2);
  assert.deepEqual(kicked.slice().sort(), [sid(100), sid(101)], "both Members-pad sessions: the site can't vouch for them");
  // the players rejoin with new tickets: the hook records them, the next pass keeps who passes
  kicked.length = 0;
  const s2 = await signIn(U.carol);
  await listen(PADS.mem, { cookie: s2.cookie }, 103);
  listAll({ mem: [sid(103)], pub: [sid(102)] });
  assert.equal(await RR.recheck("tick"), 0);
  assert.deepEqual(kicked, []);
});

test("⚡ F1: once a recorded session shows up in MediaMTX's list, every unrecorded one on a pad not open to everyone is ended on the tick; before that (MediaMTX might not send ids) only the ones listed before the first pass, once", async () => {
  await rtcOn();
  assert.equal(await RR.recheck("tick"), 0, "a pass before MediaMTX's first listing (nothing known yet) ...");
  // no id match yet: the sessions listed before the first pass (opened before this start) are swept once ...
  listAll({ mem: [sid(110)] });
  assert.equal(await RR.recheck("tick"), 1);
  assert.deepEqual(kicked, [sid(110)]);
  kicked.length = 0;
  // ... a later one the hook never recorded is left to a change (a MediaMTX that doesn't send ids would be kicked every 15 s)
  listAll({ mem: [sid(111)] });
  assert.equal(await RR.recheck("tick"), 0);
  assert.deepEqual(kicked, []);
  // the hook's ids are confirmed (a recorded session listed): unrecorded ones are ended from now on
  await listen(PADS.mem, U.plain, 112);
  listAll({ mem: [sid(111), sid(112)] });
  assert.equal(await RR.recheck("tick"), 1);
  assert.deepEqual(kicked, [sid(111)], "the recorded, still-passing session stays");
});

test("⚡ F1: a signed-in ticket handed out before this start counts as signed out at the hook (its sign-in is forgotten): a Members pad refuses it, a Public pad plays", async () => {
  await rtcOn();
  const s = await signIn(U.carol);
  const r = await post("/api/rooms/" + PADS.mem.slug + "/audio/rtc", {}, { cookie: s.cookie });
  const p = await post("/api/rooms/" + PADS.pub.slug + "/audio/rtc", {}, { cookie: s.cookie });
  assert.equal(r.d.ok, true); assert.equal(p.d.ok, true);
  const ptm = new URL(r.d.whep).searchParams.get("pt"), ptp = new URL(p.d.whep).searchParams.get("pt");
  RR._reset(); RR._setBoot(Date.now() + 1000);                // a restart after the tickets were handed out
  assert.equal(await hook(PADS.mem, { query: "pt=" + encodeURIComponent(ptm), id: sid(120) }), 403);
  assert.equal(await hook(PADS.pub, { query: "pt=" + encodeURIComponent(ptp), id: sid(121) }), 200);
  assert.equal(RR._readers.get(sid(121)).uid, null, "recorded as signed out");
  // a ticket handed out since (no sign-in seen: a test user) still opens a session
  RR._setBoot(Date.now() - 1000);
  const t = await post("/api/rooms/" + PADS.mem.slug + "/audio/rtc", {}, U.plain);
  assert.equal(await hook(PADS.mem, { query: "pt=" + encodeURIComponent(new URL(t.d.whep).searchParams.get("pt")), id: sid(122) }), 200);
});

test("⚡ F2: a kick that didn't land is tried again while MediaMTX still lists the session (not counted twice, not before a new listing); forgotten once it's gone", async () => {
  await rtcOn();
  const s = await signIn(U.carol);
  await listen(PADS.mem, { cookie: s.cookie }, 130);
  listAll({ mem: [sid(130)] });
  await SE.revoke(U.carol.userId, s.id, "signed out");
  assert.equal(await RR.recheck("tick"), 1);
  assert.deepEqual(kicked, [sid(130)]);
  kicked.length = 0;
  assert.equal(await RR.recheck("tick"), 0);
  assert.deepEqual(kicked, [], "no listing since the kick: nothing to retry yet (no double count)");
  listAll({ mem: [sid(130)] });                               // the next sync: still reading - the kick was lost
  assert.equal(await RR.recheck("tick"), 0, "a retry is not a new end");
  assert.deepEqual(kicked, [sid(130)], "kicked again");
  kicked.length = 0;
  listAll({ mem: [] });                                       // gone
  assert.equal(RR._kicked.has(sid(130)), false);
  assert.equal(await RR.recheck("tick"), 0);
  assert.deepEqual(kicked, []);
});

test("⚡ F3: the MediaMTX hook asks the 💎 bridge perk too - a cached ticket opens nothing once it's gone", async () => {
  await rtcOn();
  const r = await post("/api/rooms/" + PADS.pub.slug + "/audio/rtc", {}, null);
  assert.equal(r.d.ok, true, JSON.stringify(r.d));
  const pt = new URL(r.d.whep).searchParams.get("pt");
  const orig = premium.bridgeAllowed;
  premium.bridgeAllowed = (id) => id !== PADS.pub.id;
  try { assert.equal(await hook(PADS.pub, { query: "pt=" + encodeURIComponent(pt), id: sid(140) }), 403); }
  finally { premium.bridgeAllowed = orig; }
  assert.equal(await hook(PADS.pub, { query: "pt=" + encodeURIComponent(pt), id: sid(141) }), 200, "(with the perk it plays)");
});

test("R1: changes that can't stop anyone (an approval, Approved -> Members, the same level again, a reload that changes nothing) cut no MP3 listener and kick no ⚡ session - a tightening still does", async () => {
  await rtcOn();
  listAll({ app: [sid(150)], mem: [sid(151)] });              // sessions the site can't vouch for (from before a restart)
  const seen = [];
  PA.onChange((id, info) => seen.push([id, info && info.tighter]));
  const a = await open("/p/" + PADS.app.slug + "/audio", U.m1), m = await open("/p/" + PADS.mem.slug + "/audio", U.plain);
  await runQuery("INSERT INTO pad_members (room_id, user_id, status, requested_at) VALUES (?, ?, 'pending', ?) ON CONFLICT(room_id, user_id) DO UPDATE SET status = 'pending'",
                 [PADS.app.id, U.asker.userId, Date.now()]);
  await PA.load();
  try {
    seen.length = 0;
    await PA.decide(U.owner, await R(PADS.app), U.asker.userId, true);
    await setLevel(PADS.mem, "members");
    await PA.load();
    await setLevel(PADS.app, "members");
    await sleep(80);
    assert.deepEqual(kicked, []);
    assert.deepEqual([a.ended, m.ended], [false, false]);
    assert.deepEqual(seen, [[PADS.app.id, false], [PADS.mem.id, false], [PADS.app.id, false]], "a reload that changes nothing says nothing");
    await setLevel(PADS.mem, "approved");                     // tighter
    assert.equal(await until(() => m.ended && kicked.includes(sid(151))), true);
    assert.deepEqual(seen.at(-1), [PADS.mem.id, true]);
  } finally {
    close(a, m);
    await runQuery("DELETE FROM pad_members WHERE room_id = ? AND user_id = ?", [PADS.app.id, U.asker.userId]);
    await PA.load();
  }
});

test("R1: a reload (re-key / merge) that takes a member off an Approved pad ends their stream at once, and says which pad", async () => {
  const P = PADS.app;
  const seen = [];
  PA.onChange((id, info) => seen.push([id, info && info.tighter]));
  const s1 = await open("/p/" + P.slug + "/audio", U.m1), s2 = await open("/p/" + P.slug + "/audio", U.m2);
  try {
    assert.deepEqual([s1.status, s2.status], [200, 200]);
    seen.length = 0;
    await runQuery("UPDATE pad_members SET status = 'removed' WHERE room_id = ? AND user_id = ?", [P.id, U.m1.userId]);
    await PA.load();
    assert.equal(await until(() => s1.ended), true);
    await sleep(50);
    assert.equal(s2.ended, false);
    assert.deepEqual(seen, [[P.id, true]]);
  } finally {
    close(s1, s2);
    await runQuery("UPDATE pad_members SET status = 'approved' WHERE room_id = ? AND user_id = ?", [P.id, U.m1.userId]);
    await PA.load();
  }
});

test("R2: a listener promoted a moment ago (the class cache still says the old class) who passes at connect is not cut by the next pass - MP3 or ⚡", async () => {
  await rtcOn();
  const s = await signIn(U.promo);
  const mem = await open("/p/" + PADS.mem.slug + "/audio", { cookie: s.cookie });
  let app = null;
  try {
    assert.equal(mem.status, 200);
    assert.equal(await bridge.audioRecheck("tick").pending, 0);       // the class cache says pleb for a minute
    await runQuery("UPDATE users SET class = 'Admin' WHERE userId = ?", [U.promo.userId]);
    app = await open("/p/" + PADS.app.slug + "/audio", { cookie: s.cookie });
    assert.equal(app.status, 200, "connect passes (the class read fresh)");
    assert.equal(await bridge.audioRecheck("tick").pending, 0);
    await sleep(50);
    assert.equal(app.ended, false);
    await listen(PADS.app, { cookie: s.cookie }, 160);              // the hook lets the ⚡ session in
    listAll({ app: [sid(160)] });
    assert.equal(await RR.recheck("tick"), 0);
    assert.deepEqual(kicked, []);
    // a demotion is still caught (the cache expired)
    await runQuery("UPDATE users SET class = 'pleb' WHERE userId = ?", [U.promo.userId]);
    PA._setClock(() => Date.now() + 120e3);
    await bridge.audioRecheck("tick").pending;
    assert.equal(await until(() => app.ended), true);
    assert.equal(await RR.recheck("tick"), 1);
  } finally {
    PA._setClock(null);
    close(mem, app);
    await runQuery("UPDATE users SET class = 'pleb' WHERE userId = ?", [U.promo.userId]);
  }
});

test("R3: the periodic pass itself - started by register, every AUDIO_RECHECK_MS, the MP3 pass then the ⚡ pass, one at a time", async () => {
  const { mock } = require("node:test");
  assert.equal(bridge._audioRecheckOn(), true, "register started it");
  await rtcOn();
  const s = await signIn(U.carol);
  const st = await open("/p/" + PADS.mem.slug + "/audio", { cookie: s.cookie });
  await listen(PADS.mem, { cookie: s.cookie }, 170);
  listAll({ mem: [sid(170)] });
  bridge._audioRecheckStop();
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    bridge._audioRecheckStart();
    await SE.revoke(U.carol.userId, s.id, "signed out");
    mock.timers.tick(bridge.AUDIO_RECHECK_MS - 1);
    await sleep(60);
    assert.equal(st.ended, false, "not before the interval");
    mock.timers.tick(1);
    assert.equal(await until(() => st.ended && kicked.includes(sid(170))), true, "both passes ran");
    // one at a time: a pass while one runs does nothing
    const two = await Promise.all([bridge._audioTick(), bridge._audioTick()]);
    assert.deepEqual(two, [true, false]);
  } finally {
    bridge._audioRecheckStop();
    mock.timers.reset();
    bridge._audioRecheckStart();
    close(st);
  }
});

test("F4: a 🔊 mic-clip preview of a pad plays (and shows its words) only while you may still hear the pad - removed from the Approved pad, it's refused; discarding still works", async () => {
  const MC = require(path.join(repo, "micclip"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-mc-")); MC._setDir(dir);
  const id = "w0123456789abcdef";
  fs.writeFileSync(MC.fileOf(id), Buffer.from("fake-m4a-of-a-members-only-mic-turn"));
  MC._clips.set(id, { id, roomId: PADS.app.id, slug: PADS.app.slug, userId: U.m1.userId, username: U.m1.username, login: "bobcf", tx: "t1",
                      state: "ready", status: "ok", done: Date.now(), ts: Date.now(), secs: 3, text: "the words", viewerOk: true, cost: 0, save: null });
  const base2 = "/api/rooms/" + PADS.app.slug + "/micclip/" + id;
  const get = (p) => fetch(base + p, { headers: { "x-test-user": U.m1.userId } }).then(async (r) => ({ status: r.status, text: await r.text() }));
  const jpost = (p) => fetch(base + p, { method: "POST", headers: { "x-test-user": U.m1.userId, "content-type": "application/json", "x-requested-with": "fetch" }, body: "{}" })
    .then(async (r) => ({ status: r.status, d: await r.json().catch(() => null) }));
  try {
    assert.equal((await get(base2 + "/audio")).status, 200, "(a member: their own preview plays)");
    assert.ok((await get(base2)).text.includes("the words"));
    await PA.remove(U.owner, await R(PADS.app), U.m1.userId);
    const au = await get(base2 + "/audio"), vw = await get(base2);
    assert.equal(au.status, 403);
    assert.equal(vw.status, 403);
    assert.ok(!vw.text.includes("the words"));
    const sv = await jpost(base2 + "/save");
    assert.equal(sv.status, 403);
    assert.equal(sv.d && sv.d.code, "no_access", JSON.stringify(sv.d));
    assert.equal((await jpost(base2 + "/discard")).status, 200, "they can still throw it away");
  } finally {
    MC._clips.delete(id);
    await runQuery("UPDATE pad_members SET status = 'approved' WHERE room_id = ? AND user_id = ?", [PADS.app.id, U.m1.userId]);
    await PA.load();
  }
});

// ── audiogate2: a pad ban, a !bridge block and a network ban stop LISTENING too (listenban.js) ──
const FS = require(path.join(repo, "feedstore"));
const BB = require(path.join(repo, "bridgeblocks"));
const PB = require(path.join(repo, "padbans"));
const NB = require(path.join(repo, "netban"));
const LB = require(path.join(repo, "listenban"));
let bansUp = null;
const bansReady = () => (bansUp = bansUp || (async () => {
  await FS.init(); await BB.init(); await PB.init(); await NB.init();
  await require(path.join(repo, "incognito")).init();
  await LB.refresh();
})());
/** everything any test banned, gone (the stores' own rows), the switch off, the pads-with-bans list read again */
async function clearBans() {
  for (const t of ["feed_bans", "bridge_blocks", "pad_login_bans", "veil_bans", "net_ban_exempt", "net_bans", "incognito_state"]) {
    try { await runQuery("DELETE FROM " + t); } catch (e) { /* not there */ }
  }
  NB._setOn(false); await NB.reload(); PB._reset(); LB._setClock(null);
  await LB.refresh();
}
const H2 = (who, ip) => Object.assign({}, !who ? {} : who.cookie ? { cookie: "jwt=" + who.cookie } : { "x-test-user": who.userId }, ip ? { "cf-connecting-ip": ip } : {});
/** like open(), from a network (the trusted proxy's CF-Connecting-IP - the test server's peer is loopback) */
function openNet(url, who, ip) {
  return new Promise((resolve, reject) => {
    const req = http.get(base + url, { headers: H2(who, ip) }, (res) => {
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
/** a refused connect: status + its whole body */
const refusedText = (url, who, ip) => fetch(base + url, { headers: H2(who, ip) }).then(async (r) => ({ status: r.status, text: await r.text() }));
const ticketAs = (P, who, ip) => fetch(base + "/api/rooms/" + P.slug + "/audio/rtc", { method: "POST", headers: Object.assign({ "content-type": "application/json" }, H2(who, ip)), body: "{}" })
  .then(async (r) => ({ status: r.status, d: await r.json().catch(() => null) }));
/** a ⚡ ticket (from `ip`) + the hook letting session `n` in (-> the ticket) */
async function listenNet(P, who, n, ip) {
  const r = await ticketAs(P, who, ip);
  assert.equal(r.status, 200, JSON.stringify(r.d)); assert.equal(r.d.ok, true, JSON.stringify(r.d));
  const pt = new URL(r.d.whep).searchParams.get("pt");
  assert.equal(await hook(P, { query: "pt=" + encodeURIComponent(pt), id: sid(n) }), 200);
  return pt;
}
/** a mic-stage capture's tap for viewer u (-> {untap, ends, got}) */
function tapFor(P, u, net = null) {
  const s = { ends: 0, got: [] };
  const fn = (buf) => s.got.push(buf); fn.end = () => { s.ends++; };
  s.untap = bridge.audioTap(P.id, fn, u, { net });
  return s;
}
const padBan = (u, P, scope = "pad", by = U.owner) => { PB._reset(); return PB.ban(by, { id: P.id }, null, { ref: { k: "user", v: u.username }, scope, dur: "1d", reason: "test" }); };
const padUnban = (u, P, scope = "pad", by = U.owner) => { PB._reset(); return PB.unban(by, { id: P.id }, null, { ref: { k: "user", v: u.username }, scope }); };
const block = (u, roomId, feature = "all") => BB.block({ roomId, target: { userId: u.userId, username: u.username }, feature, by: { userId: U.owner.userId, name: "agowner", via: "web" } });
const unblock = (u, roomId, feature = "all") => BB.unblock({ roomId, target: { userId: u.userId, username: u.username }, feature, by: { name: "agowner", via: "web" } });
const NET_A = "198.51.100.7", NET_B = "198.51.100.8", NET_C = "203.0.113.9";

test("audiogate2: a pad ban ends that person's room audio on THAT pad at once - MP3 raw + ?lv=1, the ⚡ session, a mic-stage tap - a Public pad too; refused at connect; nobody else touched; lifted, they're straight back in", async () => {
  await bansReady(); await rtcOn();
  const P = PADS.pub;
  try {
    const raw = await open("/p/" + P.slug + "/audio", U.eve), fr = await open("/p/" + P.slug + "/audio?lv=1", U.eve);
    const elsewhere = await open("/p/" + PADS.other.slug + "/audio", U.eve);
    const fk = await open("/p/" + P.slug + "/audio", U.frank), anon = await open("/p/" + P.slug + "/audio", null);
    const pt = await listenNet(P, U.eve, 200);
    await listenNet(P, U.frank, 201);
    const tE = tapFor(P, U.eve), tF = tapFor(P, U.frank);
    assert.deepEqual([raw.status, fr.status, elsewhere.status, fk.status, anon.status], [200, 200, 200, 200, 200]);
    assert.equal(LB.mayApply(P.id), false, "(nobody banned yet: the Public pad is skipped)");
    await padBan(U.eve, P);
    assert.equal(await until(() => raw.ended && fr.ended && tE.ends === 1 && kicked.includes(sid(200))), true, "MP3, levels, tap and ⚡ all ended");
    await chunk(P, 1); await sleep(60);
    assert.deepEqual([fk.ended, anon.ended, elsewhere.ended, tF.ends], [false, false, false, 0], "everyone else - and her other pad - keeps listening");
    assert.deepEqual(kicked, [sid(200)]);
    assert.ok(tF.got.length >= 1);
    // refused at connect, on every path
    const r1 = await refusedText("/p/" + P.slug + "/audio", U.eve), r2 = await refusedText("/p/" + P.slug + "/audio?lv=1", U.eve);
    assert.deepEqual([r1.status, r2.status], [403, 403]);
    assert.equal(r1.text, LB.REFUSAL); assert.equal(r2.text, LB.REFUSAL);
    const tk = await ticketAs(P, U.eve);
    assert.equal(tk.status, 403); assert.deepEqual(tk.d, { ok: false, fallback: "denied" });
    assert.equal(await hook(P, { query: "pt=" + encodeURIComponent(pt), id: sid(202) }), 403, "a ticket she got before the ban opens nothing");
    // the periodic pass doesn't touch anyone else either
    kicked.length = 0;
    await bridge._audioTick();
    await sleep(40);
    assert.deepEqual([fk.ended, anon.ended, elsewhere.ended], [false, false, false]);
    assert.deepEqual(kicked, []);
    // lifted: straight back in (MP3 + ⚡), nothing stuck
    await padUnban(U.eve, P);
    const back = await open("/p/" + P.slug + "/audio", U.eve);
    assert.equal(back.status, 200);
    assert.equal((await ticketAs(P, U.eve)).d.ok, true);
    close(raw, fr, elsewhere, fk, anon, back);
    if (tE.untap) tE.untap(); if (tF.untap) tF.untap();
  } finally { await clearBans(); }
});

test("audiogate2: a !bridge block - 'all' in this pad cuts this pad's audio, in every pad ('') every pad's (MP3 + ⚡); a one-feature block (chat) cuts nothing; unblocked, back in", async () => {
  await bansReady(); await rtcOn();
  try {
    const pub = await open("/p/" + PADS.pub.slug + "/audio", U.gina), mem = await open("/p/" + PADS.mem.slug + "/audio", U.gina);
    const oth = await open("/p/" + PADS.other.slug + "/audio", U.gina);
    await listenNet(PADS.mem, U.gina, 210);
    await block(U.gina, PADS.pub.id, "chat");
    await sleep(60);
    await bridge._audioTick();
    await sleep(40);
    assert.deepEqual([pub.ended, mem.ended, oth.ended], [false, false, false], "a chat-only block is about chat");
    assert.deepEqual(kicked, []);
    const ok1 = await open("/p/" + PADS.pub.slug + "/audio", U.gina);
    assert.equal(ok1.status, 200);
    await block(U.gina, PADS.pub.id);                         // 'all' in this pad
    assert.equal(await until(() => pub.ended && ok1.ended), true);
    await sleep(50);
    assert.deepEqual([mem.ended, oth.ended], [false, false], "the other pads keep playing");
    assert.deepEqual(kicked, []);
    await block(U.gina, "");                                  // an admin's block in every pad
    assert.equal(await until(() => mem.ended && oth.ended && kicked.includes(sid(210))), true);
    for (const P of [PADS.pub, PADS.mem, PADS.other]) assert.equal((await refusedText("/p/" + P.slug + "/audio", U.gina)).status, 403);
    assert.equal((await ticketAs(PADS.mem, U.gina)).status, 403);
    await unblock(U.gina, ""); await unblock(U.gina, PADS.pub.id);
    for (const P of [PADS.pub, PADS.mem, PADS.other]) { const s = await open("/p/" + P.slug + "/audio", U.gina); assert.equal(s.status, 200); close(s); }
    close(pub, mem, oth, ok1);
  } finally { await clearBans(); }
});

test("audiogate2: the older pad-ban form (feed_bans only) and a staff site-wide ban (every pad) cut too; an incognito ban - even while they're incognito, which bridgeblocks.active counts - never does", async () => {
  await bansReady();
  try {
    const fm = await open("/p/" + PADS.mem.slug + "/audio", U.frank), fp = await open("/p/" + PADS.pub.slug + "/audio", U.frank);
    const hp = await open("/p/" + PADS.pub.slug + "/audio", U.hank), hm = await open("/p/" + PADS.mem.slug + "/audio", U.hank);
    await runQuery("UPDATE users SET camfrogUsername = 'ivycf' WHERE userId = ?", [U.ivy.userId]);
    const ip = await open("/p/" + PADS.pub.slug + "/audio", U.ivy);
    // /api/feed/ban's form: feed_bans only, no bridge block
    await FS.ban(U.owner, "@" + U.frank.username, { room: PADS.mem.id });
    assert.equal(await until(() => fm.ended), true);
    await sleep(40);
    assert.equal(fp.ended, false, "only that pad");
    // a site-wide ban (staff)
    await padBan(U.hank, PADS.pub, "site", U.staff);
    assert.equal(await until(() => hp.ended && hm.ended), true, "every pad, a Public one too");
    // an incognito ban while incognito: the bridge refuses her frog-name posts - listening is untouched
    await runQuery(`INSERT INTO veil_bans (room_id, scope, user_id, login, label, until, reason, by_id, by_name, created) VALUES (?, 'bridge', ?, 'ivycf', 'Soggy Bullfrog', NULL, NULL, ?, 'agowner', ?)`,
                   [PADS.pub.id, U.ivy.userId, U.owner.userId, Date.now()]);
    await runQuery(`INSERT INTO incognito_state (login, "on", updated) VALUES ('ivycf', 1, ?)`, [Date.now()]);
    PB._reset();
    const a = await BB.active(PADS.pub.id, U.ivy.userId);
    assert.ok(a && a.incog === true, "(the trap: bridgeblocks.active returns the incognito ban)");
    assert.equal(await LB.refusal({ roomId: PADS.pub.id, userId: U.ivy.userId }), null);
    LB.changed(PADS.pub.id);
    await bridge._audioTick();
    await sleep(60);
    assert.equal(ip.ended, false, "an incognito ban never cuts listening (it would show who the frog is)");
    const ip2 = await open("/p/" + PADS.pub.slug + "/audio", U.ivy);
    assert.equal(ip2.status, 200);
    close(fm, fp, hp, hm, ip, ip2);
  } finally {
    await runQuery("UPDATE users SET camfrogUsername = NULL WHERE userId = ?", [U.ivy.userId]);
    await clearBans();
  }
});

test("audiogate2: a Camfrog-login ban (made before the login had an account) - an account linked without an event (a merge, a Pepe-made account) is cut on the next 15 s pass and refused at connect; one linked through padbans.linked is cut at once", async () => {
  await bansReady();
  try {
    await PB.ban(U.owner, { id: PADS.mem.id }, null, { ref: { k: "login", v: "lincf" }, scope: "pad", dur: "1d", reason: "x" });
    assert.ok(await PB.loginActive(PADS.mem.id, "lincf"));
    const s = await open("/p/" + PADS.mem.slug + "/audio", U.lin);
    await sleep(40);
    assert.equal(s.ended, false, "not linked yet: not them");
    await runQuery("UPDATE users SET camfrogUsername = 'lincf' WHERE userId = ?", [U.lin.userId]);   // linked with no event
    PB._reset();
    await sleep(40);
    assert.equal(s.ended, false);
    await bridge._audioTick();                                  // the backstop
    assert.equal(await until(() => s.ended), true);
    assert.equal((await refusedText("/p/" + PADS.mem.slug + "/audio", U.lin)).status, 403);
    // padbans.linked: the login ban becomes the account's named bans - at once
    PB._reset();
    await PB.ban(U.owner, { id: PADS.mem.id }, null, { ref: { k: "login", v: "lin2cf" }, scope: "pad", dur: "1d", reason: "x" });
    const s2 = await open("/p/" + PADS.mem.slug + "/audio", U.lin2);
    await runQuery("UPDATE users SET camfrogUsername = 'lin2cf' WHERE userId = ?", [U.lin2.userId]);
    await PB.linked(U.lin2.userId, "lin2cf");
    assert.equal(await until(() => s2.ended), true);
    close(s, s2);
  } finally {
    await runQuery("UPDATE users SET camfrogUsername = NULL WHERE userId IN (?, ?)", [U.lin.userId, U.lin2.userId]);
    await clearBans();
  }
});

test("audiogate2: a network ban (switch on) - a signed-out Public-pad listener from that network is cut at once (MP3 + ⚡ + a capture's tap) and refused; other networks, staff and an exempt account keep listening; pad scope = that pad; switched off nothing applies, switched on it cuts; lifted, back in", async () => {
  await bansReady(); await rtcOn();
  const P = PADS.pub;
  try {
    const anonA = await openNet("/p/" + P.slug + "/audio", null, NET_A), anonB = await openNet("/p/" + P.slug + "/audio", null, NET_B);
    const staffA = await openNet("/p/" + P.slug + "/audio", U.staff, NET_A), daveA = await openNet("/p/" + PADS.other.slug + "/audio", U.dave, NET_A);
    const ptA = await listenNet(P, null, 220, NET_A);
    await listenNet(P, null, 221, NET_B);
    const tap = tapFor(P, U.kim, { ip: NET_A, hash: NB.netHash(NET_A) });
    // the switch off: a ban can't even be made, and nothing applies
    await assert.rejects(NB.banTyped(U.staff, { ip: NET_A, days: 1 }), (e) => e.status === 409);
    await NB.setOn(U.staff, true);
    await sleep(40);
    assert.deepEqual([anonA.ended, anonB.ended, staffA.ended, daveA.ended, tap.ends], [false, false, false, false, 0], "no bans yet: nobody cut by switching on");
    // a pad-scope ban on network A, in this pad
    const b1 = await NB.banTyped(U.staff, { ip: NET_A, scope: "pad", roomId: P.id, days: 1 });
    assert.equal(await until(() => anonA.ended && tap.ends === 1 && kicked.includes(sid(220))), true, "network A in this pad: MP3, the capture's tap, ⚡");
    await sleep(50);
    assert.deepEqual([anonB.ended, staffA.ended, daveA.ended], [false, false, false], "network B, staff, another pad");
    assert.deepEqual(kicked, [sid(220)]);
    const r = await refusedText("/p/" + P.slug + "/audio", null, NET_A);
    assert.equal(r.status, 403); assert.equal(r.text, LB.REFUSAL);
    assert.deepEqual((await ticketAs(P, null, NET_A)).d, { ok: false, fallback: "denied" });
    assert.equal(await hook(P, { query: "pt=" + encodeURIComponent(ptA), id: sid(222) }), 403);
    const third = await openNet("/p/" + P.slug + "/audio", null, NET_C);
    assert.equal(third.status, 200, "a third network");
    // an exempt account on the banned network passes (a shared household)
    assert.equal((await refusedText("/p/" + P.slug + "/audio", U.carol, NET_A)).status, 403);
    await NB.exempt(U.staff, U.carol.userId, [b1.id], "household");
    const carolA = await openNet("/p/" + P.slug + "/audio", U.carol, NET_A);
    assert.equal(carolA.status, 200);
    // signed out on a Members pad: the access rule's answer first, never the ban's
    const sm = await refusedText("/p/" + PADS.mem.slug + "/audio", null, NET_A);
    assert.equal(sm.status, 401); assert.equal(sm.text, "Sign in to listen.");
    // a site-wide one: every pad - not staff; the exempt account is exempt from THAT ban only (b1), not this one
    const b2 = await NB.banTyped(U.staff, { ip: NET_A, scope: "site", days: 1 });
    assert.equal(await until(() => daveA.ended && carolA.ended), true);
    await sleep(40);
    assert.deepEqual([staffA.ended, anonB.ended, third.ended], [false, false, false]);
    // switched off: nothing applies (connect) - switched on again: the one listening from A is cut at once
    await NB.setOn(U.staff, false);
    const again = await openNet("/p/" + P.slug + "/audio", null, NET_A);
    assert.equal(again.status, 200);
    await NB.setOn(U.staff, true);
    assert.equal(await until(() => again.ended), true);
    // lifted: back in
    await NB.lift(U.staff, [b1.id, b2.id]);
    const back = await openNet("/p/" + P.slug + "/audio", null, NET_A);
    assert.equal(back.status, 200);
    assert.equal((await ticketAs(P, null, NET_A)).d.ok, true);
    close(anonA, anonB, staffA, daveA, carolA, again, back, third);
    if (tap.untap) tap.untap();
  } finally { await clearBans(); }
});

test("audiogate2: ⚡ after a restart - a ticket whose network the site forgot is asked with the address MediaMTX saw (refuse only); an unrecorded session on a Public pad stays on the tick and is ended when a ban is made there", async () => {
  await bansReady(); await rtcOn();
  const P = PADS.pub;
  try {
    await NB.setOn(U.staff, true);
    const r = await ticketAs(P, null, NET_A);
    const pt = new URL(r.d.whep).searchParams.get("pt");
    assert.equal(RR.ticketNet(pt).hash, NB.netHash(NET_A), "(remembered with the ticket, in memory)");
    await NB.banTyped(U.staff, { ip: NET_A, scope: "pad", roomId: P.id, days: 1 });
    RR._reset();                                              // the restart: the ticket's network is forgotten
    assert.equal(RR.ticketNet(pt), null);
    assert.equal(await hook(P, { query: "pt=" + encodeURIComponent(pt), id: sid(230), ip: NET_A }), 403, "MediaMTX saw the banned network");
    assert.equal(await hook(P, { query: "pt=" + encodeURIComponent(pt), id: sid(231), ip: NET_B }), 200, "...another one: plays (only ever used to refuse)");
    await NB.setOn(U.staff, false);
    // an unrecorded session (from before the restart) on the Public pad
    RR._reset();
    listAll({ pub: [sid(232)] });
    await LB.refresh();
    assert.equal(await RR.recheck("tick"), 0);
    await listenNet(P, U.max, 233);                           // a recorded one, not banned
    listAll({ pub: [sid(232), sid(233)] });
    assert.equal(await RR.recheck("tick"), 0, "the tick never ends an open pad's unrecorded session (nobody knows whose)");
    assert.deepEqual(kicked, []);
    await padBan(U.eve, P);                                   // a ban made there: the unrecorded one ends (its player rejoins, asked)
    assert.equal(await until(() => kicked.includes(sid(232))), true);
    await sleep(40);
    assert.deepEqual(kicked, [sid(232)], "the recorded, unbanned session stays");
  } finally { await clearBans(); }
});

test("audiogate2: a ban check that fails keeps whoever is listening and lets a new listener in (no answer is not a no), and says so - the log lines carry counts, never who", async () => {
  await bansReady(); await rtcOn();
  const P = PADS.mem;
  const logs = [], ol = console.log, oe = console.error, orig = LB.refusal;
  let s = null, n = null;
  try {
    s = await open("/p/" + P.slug + "/audio", U.eve);
    console.log = (...a) => logs.push(a.join(" ")); console.error = (...a) => logs.push(a.join(" "));
    LB.refusal = async () => { throw new Error("SQLITE_BUSY"); };
    await padBan(U.frank, P);                                 // (a ban on someone else: the pad may now have bans)
    await bridge.audioRecheck("tick").pending;
    await sleep(40);
    assert.equal(s.ended, false);
    assert.ok(logs.some((l) => /audiogate \(tick\): 1 listener check\(s\) failed - kept/.test(l)), logs.join("\n"));
    n = await open("/p/" + P.slug + "/audio", U.eve);
    assert.equal(n.status, 200, "connect: let in");
    assert.ok(logs.some((l) => /audiogate2: 1 ban check failed at connect - let in/.test(l)));
    LB.refusal = orig;
    // a real cut: counts only
    logs.length = 0;
    await padBan(U.eve, P);
    assert.equal(await until(() => s.ended && n.ended), true);
    await sleep(40);
    const all = logs.join("\n");
    assert.ok(/ended 2 room audio listener\(s\) \(banned\)/.test(all), all);
    for (const who of [U.eve.userId, U.eve.username, U.frank.userId, U.frank.username]) assert.ok(!all.includes(who), "no " + who + " in: " + all);
  } finally { LB.refusal = orig; console.log = ol; console.error = oe; close(s, n); await clearBans(); }
});

test("audiogate2: the refusal says the same for all three bans (no reason, no end, no moderator); ⚡ answers exactly as any other denial", async () => {
  await bansReady();
  try {
    await padBan(U.eve, PADS.mem);
    await block(U.gina, PADS.mem.id);
    await NB.setOn(U.staff, true);
    await NB.banTyped(U.staff, { ip: NET_A, scope: "pad", roomId: PADS.mem.id, days: 1 });
    const a = await refusedText("/p/" + PADS.mem.slug + "/audio", U.eve), b = await refusedText("/p/" + PADS.mem.slug + "/audio", U.gina);
    const c = await refusedText("/p/" + PADS.mem.slug + "/audio", U.max, NET_A);
    assert.deepEqual([a, b, c], [{ status: 403, text: LB.REFUSAL }, { status: 403, text: LB.REFUSAL }, { status: 403, text: LB.REFUSAL }]);
    assert.doesNotMatch(LB.REFUSAL, /test|until|UTC|mod|ban|network/i);
    await rtcOn();
    const denied = await ticketAs(PADS.app, U.plain);              // not a member of the Approved pad: the ordinary denial
    const banned = await ticketAs(PADS.mem, U.eve);
    assert.deepEqual([banned.status, banned.d], [denied.status, denied.d]);
  } finally { await clearBans(); }
});

test("audiogate2: who isn't banned is never cut - several bans on other people in every pad, their events and the 15 s pass leave every other listener (signed in, signed out, staff, ⚡, a tap) playing", async () => {
  await bansReady(); await rtcOn();
  const keep = [];
  let tap = null;
  try {
    for (const P of [PADS.pub, PADS.mem, PADS.other]) {
      keep.push(await open("/p/" + P.slug + "/audio", U.max), await open("/p/" + P.slug + "/audio", U.staff), await open("/p/" + P.slug + "/audio?lv=1", U.kim));
      if (P === PADS.pub) keep.push(await open("/p/" + P.slug + "/audio", null), await openNet("/p/" + P.slug + "/audio", null, NET_B));
    }
    keep.push(await open("/p/" + PADS.app.slug + "/audio", U.m2));
    await listenNet(PADS.pub, null, 240, NET_B); await listenNet(PADS.mem, U.max, 241); await listenNet(PADS.app, U.m2, 242);
    tap = tapFor(PADS.mem, U.kim);
    assert.ok(keep.every((s) => s.status === 200));
    await padBan(U.eve, PADS.pub); await padBan(U.eve, PADS.mem); await block(U.gina, ""); await padBan(U.hank, PADS.pub, "site", U.staff);
    await FS.ban(U.owner, "@" + U.frank.username, { room: PADS.app.id });
    await NB.setOn(U.staff, true);
    await NB.banTyped(U.staff, { ip: NET_A, scope: "site", days: 1 });
    await sleep(80);
    await bridge._audioTick();
    await RR.recheck("ban", null);
    await sleep(60);
    assert.deepEqual(keep.map((s) => s.ended), keep.map(() => false));
    assert.deepEqual(kicked, []);
    assert.equal(tap.ends, 0);
  } finally { close(...keep); if (tap && tap.untap) tap.untap(); await clearBans(); }
});

test("audiogate2: a ban that runs out lets them back in - nothing about it is remembered", async () => {
  await bansReady();
  try {
    await padBan(U.eve, PADS.mem);                             // 1 day
    assert.equal((await refusedText("/p/" + PADS.mem.slug + "/audio", U.eve)).status, 403);
    LB._setClock(() => Date.now() + 2 * 86400e3);
    const s = await open("/p/" + PADS.mem.slug + "/audio", U.eve);
    assert.equal(s.status, 200);
    await LB.refresh();
    assert.equal(LB.mayApply(PADS.mem.id), false, "(and the pad is skipped again)");
    close(s);
  } finally { await clearBans(); }
});

test("audiogate2: a 🔊 mic-clip preview - a pad ban or a network ban refuses its view, audio and Post with the access loss's answer (no_access); Discard still works; lifted, it plays", async () => {
  await bansReady();
  const MC = require(path.join(repo, "micclip"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ag2-mc-")); MC._setDir(dir);
  const id = "w00112233445566ff";
  fs.writeFileSync(MC.fileOf(id), Buffer.from("fake-m4a-of-a-pad-mic-turn"));
  MC._clips.set(id, { id, roomId: PADS.mem.id, slug: PADS.mem.slug, userId: U.eve.userId, username: U.eve.username, login: "bobcf", tx: "t2",
                      state: "ready", status: "ok", done: Date.now(), ts: Date.now(), secs: 3, text: "the words", viewerOk: true, cost: 0, save: null });
  const base2 = "/api/rooms/" + PADS.mem.slug + "/micclip/" + id;
  const get = (p, ip) => fetch(base + p, { headers: H2(U.eve, ip) }).then(async (r) => ({ status: r.status, text: await r.text() }));
  const jpost = (p, body = {}, ip) => fetch(base + p, { method: "POST", headers: Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, H2(U.eve, ip)), body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, d: await r.json().catch(() => null) }));
  try {
    assert.equal((await get(base2 + "/audio")).status, 200);
    await padBan(U.eve, PADS.mem);
    const au = await get(base2 + "/audio"), vw = await get(base2), sv = await jpost(base2 + "/save");
    assert.deepEqual([au.status, vw.status, sv.status], [403, 403, 403]);
    assert.ok(!vw.text.includes("the words"));
    assert.equal(JSON.parse(au.text).code, "no_access");
    assert.equal(sv.d.code, "no_access");
    await padUnban(U.eve, PADS.mem);
    assert.equal((await get(base2 + "/audio")).status, 200, "lifted: it plays");
    // a network ban too
    await NB.setOn(U.staff, true);
    await NB.banTyped(U.staff, { ip: NET_A, scope: "pad", roomId: PADS.mem.id, days: 1 });
    assert.equal((await get(base2 + "/audio", NET_A)).status, 403);
    assert.equal((await get(base2 + "/audio", NET_B)).status, 200);
    assert.equal((await jpost(base2 + "/discard", {}, NET_A)).status, 200, "they can still throw it away");
  } finally { MC._clips.delete(id); await clearBans(); }
});

test("audiogate2: a mic-stage capture - the gate refuses a CLIP (the room audio) under a pad ban or a network ban with the access loss's \"denied\", never a snap (pictures only); the preview's recheck too; staff pass a network ban; lifted, it passes", async () => {
  await bansReady();
  const M = require(path.join(repo, "stagemiccap"));
  const room = { id: PADS.mem.id };
  M.configure({ config: () => ({ stagecap_mic: true }), killed: () => null, roomOff: () => null, eligibility: () => null, bridgeOk: () => true,
    liveShown: () => true, full: async () => true, block: async () => null, clipSwitch: () => true,
    account: async () => U.eve, resolveRoom: async () => room, people: async () => [], cards: async () => [], veiledPeople: async () => [] });
  const netA = { ip: NET_A, hash: NB.netHash(NET_A) };
  const cap = { id: "c0", user_id: U.eve.userId, room_id: room.id, kind: "clip" };
  try {
    await M.gate(room, U.eve, "clip", "pad");
    assert.equal(await M.recheck(cap), null);
    await padBan(U.eve, PADS.mem);
    await assert.rejects(M.gate(room, U.eve, "clip", "pad"), (e) => e.refuse === true && e.message === M._test.MSG.denied);
    await M.gate(room, U.eve, "snap", "pad");                 // a snap has no audio
    assert.equal(await M.recheck(cap), M._test.MSG.revoked, "the preview's check (as an access loss)");
    await padUnban(U.eve, PADS.mem);
    await M.gate(room, U.eve, "clip", "pad");
    await NB.setOn(U.staff, true);
    await NB.banTyped(U.staff, { ip: NET_A, scope: "pad", roomId: PADS.mem.id, days: 1 });
    await assert.rejects(M.gate(room, U.eve, "clip", "pad", { net: netA }), (e) => e.message === M._test.MSG.denied);
    await M.gate(room, U.eve, "clip", "pad", { net: { ip: NET_B, hash: NB.netHash(NET_B) } });
    assert.equal(await M.recheck(cap, { net: netA }), M._test.MSG.revoked);
    await M.gate(room, U.staff, "clip", "pad", { net: netA });    // staff pass a network ban
  } finally { M.configure(M._test.defaults); await clearBans(); }
});
