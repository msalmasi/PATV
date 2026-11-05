// micvad 1.99akk (audiolv.js + bridge.js): Pepe's room loudness rides INSIDE the viewer's own MP3 relay response - framed records
// (?lv=1, the room-audio setting `levels` on) - for the mic bars where the page can't measure the sound (iPhone).
//   * a raw listener (no ?lv=1) and a mic-stage capture (audioTap) get exactly the bytes they always did
//   * ?lv=1 + on: X-Audio-Frames: 1, octet-stream; [type 1 = the MP3][type 2 = {h, a, d}] per post, in order; the prime is cut at
//     the first remembered post that names a frame header (its rec2 says h: 0); nothing remembered -> the first such post is cut
//   * Pepe's lv in any other shape (extra keys, non-hex, h out of range, a NaN): no rec2, the MP3 still goes out
//   * off: ?lv=1 gets plain audio/mpeg; every gate (401 / 403 / 404) answers ?lv=1 exactly as without it; the 18+ re-check ends a
//     framed listener like any other
//   * privacy: a rec2 holds only {h, a, d} - no login, display name, aref or id of anyone (incognito, !bridge hide and an unnamed
//     stream on the mic) - and the levels are in no state the site keeps (noteAudio, the room, the console)
// The MP3 + lv posts are Pepe's own (camfrog-bot ci/fixtures/micvad/posts.json via PEPE_BOT_DIR: real lameenc + pepe_audiolv).
//   TZ=UTC PEPE_BOT_DIR=G:/wt/casino2-bot node --test test/micvad-relay.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "micvad-relay-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
require(path.join(repo, "terms"))._setRequired(false);
const PA = require(path.join(repo, "padaccess"));
const AG = require(path.join(repo, "adultgate"));
const AC = require(path.join(repo, "roomaudiocfg"));
const AL = require(path.join(repo, "audiolv"));
const bridge = require(path.join(repo, "bridge"));

function fixture() {
  const dir = process.env.PEPE_BOT_DIR || path.join(repo, "camfrog-bot");
  const p = path.join(dir, "ci", "fixtures", "micvad", "posts.json");
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
}
const FX = fixture();

const PADS = {
  pub: { id: "pub.Room", slug: "pub-room", level: "public" },
  mem: { id: "mem.Room", slug: "mem-room", level: "members" },
  app: { id: "app.Room", slug: "app-room", level: "approved" },
  adult: { id: "adult.Room", slug: "adult-room", level: "public", adult: true },
  quiet: { id: "quiet.Room", slug: "quiet-room", level: "public", audio: false },
  stale: { id: "stale.Room", slug: "stale-room", level: "public" },
};
const users = new Map();
const U = {};
async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, 5, '2026-01-01 00:00:00', 0)`, [id, name, name, extra.class || "pleb", extra.camfrog || null]);
  const u = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, u);
  return u;
}
// who's on the mic: an incognito holder, a !bridge hide holder, an unnamed stream - none of them may reach a level record
const MIC = [{ id: "veiledcf", login: "veiledcf", display: "Veiled Vera", incognito: true }, { id: "hiddencf", login: "hiddencf", display: "Hidden Hal" }];
const snapOf = (P, extra = {}) => ({ room: { id: P.id, name: P.id }, topic: "", count: 4, relay: true, mic_relay: true, audio: P.audio !== false, audio_on: true,
  members: [{ id: "pepefrog", login: "pepefrog", display: "Pepe", is_self: true }, ...MIC], mic: MIC, ...extra });

let base, server;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bot = (body) => fetch(base + "/api/bridge/audio", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: "bot", ...body }) }).then((r) => r.json());
function open(url, u) {
  return new Promise((resolve, reject) => {
    const req = http.get(base + url, { headers: u ? { "x-test-user": u.userId } : {} }, (res) => {
      const st = { status: res.statusCode, headers: res.headers, chunks: [], ended: false, req, res };
      res.on("data", (c) => st.chunks.push(c));
      res.on("end", () => { st.ended = true; });
      res.on("close", () => { st.ended = true; });
      st.bytes = () => Buffer.concat(st.chunks);
      resolve(st);
    });
    req.on("error", reject);
  });
}
/** framed bytes -> [{type, payload}] (throws on a torn record: the server never leaves one) */
function records(buf) {
  const out = [];
  let o = 0;
  while (o < buf.length) {
    assert.ok(buf.length - o >= 4, "a whole record header");
    const type = buf[o], len = buf.readUIntBE(o + 1, 3);
    assert.ok(buf.length - o - 4 >= len, "a whole record");
    out.push({ type, payload: buf.subarray(o + 4, o + 4 + len) });
    o += 4 + len;
  }
  return out;
}
const lvOf = (r) => JSON.parse(r.payload.toString("utf8"));
const data = (p) => Buffer.from(p.data, "base64");
const relay = async (slug, posts, seq0 = 1) => { for (const [i, p] of posts.entries()) await bot({ room: PADS[slug].id, seq: seq0 + i, data: p.data, lv: p.lv }); };

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, email TEXT)`);
  U.owner = await mkUser("padowner", { camfrog: "ownercf" });
  U.member = await mkUser("plainmember", { camfrog: "membercf" });
  U.admin = await mkUser("siteadmin", { class: "Admin" });
  await rooms.init();
  await PA.init();
  await AG.load();
  for (const P of Object.values(PADS)) {
    await rooms.addRoom(P.id, P.id, "test");
    await rooms.setOwner(P.id, "padowner", "test");
    if (P.level !== "members") await PA.setLevel(U.owner, await rooms.get(P.id), P.level);
    if (P.adult) await rooms.setPage(P.id, { adult: true }, "test");
  }
  await AC.init();
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const id = req.get("x-test-user"); req.user = id ? users.get(id) || null : null; next(); };
  bridge.register(app, { addUser, isBotToken: (t) => t === "bot" });
  AC.register(app, { addUser, isBotToken: (t) => t === "bot" });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await bridge.ingest({ rooms: Object.values(PADS).map((P) => snapOf(P)) });
  bridge._rooms.get(PADS.stale.id).updated = 0;              // not live any more
});
test.after(() => { server.close(); try { server.closeAllConnections(); } catch (e) { /* older node */ } });

test("the shared fixture: Pepe's MP3 + lv posts (PEPE_BOT_DIR)", { skip: !FX && "no camfrog-bot checkout (PEPE_BOT_DIR)" }, () => {
  assert.equal(FX.v, 1);
  assert.ok(FX.posts.length >= 20 && FX.posts.every((p) => p.lv && p.lv.h != null));
});

test("raw listener: exactly the bytes as before; ?lv=1: framed records [MP3][levels] in order, the session starting on a frame header",
  { skip: !FX && "no fixture" }, async () => {
    const posts = FX.posts.slice(0, 6);
    const raw = await open("/p/pub-room/audio");
    const fr = await open("/p/pub-room/audio?lv=1");
    assert.equal(raw.status, 200); assert.equal(raw.headers["content-type"], "audio/mpeg"); assert.equal(raw.headers["x-audio-frames"], undefined);
    assert.equal(fr.status, 200); assert.equal(fr.headers["content-type"], "application/octet-stream"); assert.equal(fr.headers["x-audio-frames"], "1");
    assert.equal(fr.headers["cache-control"], "no-store"); assert.equal(fr.headers["x-accel-buffering"], "no");
    await relay("pub", posts);
    await sleep(120);
    assert.deepEqual(raw.bytes(), Buffer.concat(posts.map(data)), "the raw listener: the MP3 bytes, nothing else");
    const recs = records(fr.bytes());
    assert.deepEqual(recs.map((r) => r.type), posts.flatMap(() => [1, 2]), "one MP3 record and one level record per post");
    // nothing was remembered when it opened: the FIRST post is cut at its header
    assert.deepEqual(recs[0].payload, data(posts[0]).subarray(posts[0].lv.h));
    assert.deepEqual(lvOf(recs[1]), { h: 0, a: posts[0].lv.a, d: posts[0].lv.d });
    for (let i = 1; i < posts.length; i++) {
      assert.deepEqual(recs[2 * i].payload, data(posts[i]));
      const { v, ...wire } = posts[i].lv;
      assert.equal(v, 1);
      assert.deepEqual(lvOf(recs[2 * i + 1]), wire);
    }
    // a listener joining mid-stream: the prime (the last 0.5 s) cut at its first post with a header
    const late = await open("/p/pub-room/audio?lv=1");
    await sleep(80);
    const pr = records(late.bytes());
    assert.ok(pr.length >= 2 && pr[0].type === 1 && pr[1].type === 2);
    assert.equal(lvOf(pr[1]).h, 0, "the prime's level record names the header it was cut at");
    const at = posts.findIndex((p) => data(p).subarray(p.lv.h).equals(pr[0].payload));
    assert.ok(at >= 0, "the prime starts exactly on one remembered post's first header");
    raw.req.destroy(); fr.req.destroy(); late.req.destroy();
    await sleep(30);
  });

test("Pepe's lv in any other shape: no level record, the MP3 still goes out", { skip: !FX && "no fixture" }, async () => {
  const p = FX.posts[10], b = data(p);
  const bad = [{ ...p.lv, who: "veiledcf" }, { ...p.lv, d: "XYZ" }, { ...p.lv, h: b.length }, { ...p.lv, a: "NaN" }, { ...p.lv, a: 1e9 },
    { ...p.lv, v: 2 }, [p.lv], { ...p.lv, h: 1.5 }, { v: 1, d: "12" }, "lv"];
  const fr = await open("/p/pub-room/audio?lv=1");
  await relay("pub", [FX.posts[9]], 100);                     // a good one first: the session starts on its header
  for (const [i, lv] of bad.entries()) await bot({ room: PADS.pub.id, seq: 200 + i, data: p.data, lv });
  await sleep(100);
  const recs = records(fr.bytes());
  const tail = recs.slice(-(bad.length + 2));               // (the prime before them: the room's last 0.5 s)
  assert.deepEqual(tail.map((r) => r.type), [1, 2, ...bad.map(() => 1)], "the MP3 of every bad one, no level record");
  assert.deepEqual(tail[0].payload, data(FX.posts[9]));
  for (let i = 0; i < bad.length; i++) assert.deepEqual(tail[2 + i].payload, b);
  assert.equal(AL.clean({ v: 1, h: 3, a: 12.34, d: "0f" }, 10).a, 12.3, "a rounded to 0.1 ms");
  assert.deepEqual(Object.keys(AL.clean({ v: 1, h: 3, a: 1, d: "0f" }, 10)), ["h", "a", "d"]);
  assert.deepEqual(AL.clean({ v: 1, d: "" }, 10), { d: "" }, "no header in the post: d empty, no h");
  assert.equal(AL.clean({ v: 1, h: 3, d: "0f" }, 10), null, "digits without a");
  fr.req.destroy();
  await sleep(30);
});

test("levels off: ?lv=1 is plain audio/mpeg, framed listeners get no more levels; on again: framed", { skip: !FX && "no fixture" }, async () => {
  const fr = await open("/p/pub-room/audio?lv=1");
  await relay("pub", FX.posts.slice(11, 12), 300);
  let off = null;
  await AC.save(U.admin, { cfg: { levels: "off" } });
  try {
    assert.equal(AC.levelsOn(), false);
    off = await open("/p/pub-room/audio?lv=1");
    assert.equal(off.headers["content-type"], "audio/mpeg"); assert.equal(off.headers["x-audio-frames"], undefined);
    await relay("pub", FX.posts.slice(12, 14), 301);
    await sleep(100);
    const two = Buffer.concat([data(FX.posts[12]), data(FX.posts[13])]);
    assert.deepEqual(off.bytes().subarray(off.bytes().length - two.length), two, "plain MP3");
    assert.deepEqual(records(fr.bytes()).slice(-4).map((r) => r.type), [1, 2, 1, 1], "the open framed listener: MP3 only once it's off");
  } finally { await AC.save(U.admin, { cfg: { levels: "on" } }); }
  const on = await open("/p/pub-room/audio?lv=1");
  assert.equal(on.headers["x-audio-frames"], "1");
  fr.req.destroy(); off.req.destroy(); on.req.destroy();
  await sleep(30);
});

test("a mic-stage capture (audioTap) gets exactly the MP3 it always did", { skip: !FX && "no fixture" }, async () => {
  const got = [];
  const untap = bridge.audioTap(PADS.pub.id, (buf) => got.push(Buffer.from(buf)));
  assert.equal(typeof untap, "function");
  await relay("pub", FX.posts.slice(14, 17), 400);
  untap();
  assert.deepEqual(Buffer.concat(got), Buffer.concat(FX.posts.slice(14, 17).map(data)));
});

test("every gate answers ?lv=1 exactly as without it", async () => {
  const cases = [["mem-room", null, 401], ["app-room", U.member, 403], ["quiet-room", U.member, 404], ["stale-room", U.member, 404],
    ["no-such-room", U.member, 404], ["no-such-room", null, 401]];
  for (const [slug, u, status] of cases) {
    const a = await fetch(base + "/p/" + slug + "/audio", { headers: u ? { "x-test-user": u.userId } : {} });
    const b = await fetch(base + "/p/" + slug + "/audio?lv=1", { headers: u ? { "x-test-user": u.userId } : {} });
    assert.equal(a.status, status, slug); assert.equal(b.status, status, slug + " ?lv=1");
    assert.equal(await b.text(), await a.text(), slug + ": the same words");
    assert.equal(b.headers.get("x-audio-frames"), null);
  }
});

test("the 18+ re-check ends a framed listener like any other", async () => {
  const fr = await open("/p/adult-room/audio?lv=1");
  assert.equal(fr.status, 200, "the gate is off: anyone on a Public pad");
  assert.equal(fr.headers["x-audio-frames"], "1");
  try {
    await AG.setEnabled(true, U.owner, "test");
    for (let i = 0; i < 40 && !fr.ended; i++) await sleep(25);
    assert.equal(fr.ended, true, "the signed-out framed listener is cut off");
    assert.equal((await fetch(base + "/p/adult-room/audio?lv=1")).status, 401);
  } finally {
    fr.req.destroy();
    await AG.setEnabled(false, U.owner, "test");
  }
});

test("privacy: a level record is {h, a, d} only - nobody's name or id - and the levels are kept nowhere", { skip: !FX && "no fixture" }, async () => {
  const logs = [];
  const real = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(real)) console[k] = (...a) => { logs.push(a.map(String).join(" ")); real[k](...a); };
  const posts = FX.posts.slice(17, 23);
  let fr;
  try {
    fr = await open("/p/pub-room/audio?lv=1", U.member);
    await relay("pub", posts, 500);
    await sleep(100);
  } finally { Object.assign(console, real); }
  const recs = records(fr.bytes()).filter((r) => r.type === 2);
  assert.ok(recs.length >= posts.length, "(the prime's too)");
  const names = ["veiledcf", "Veiled", "hiddencf", "Hidden", "pepefrog", "aref", "login", "display", "user", "id"];
  for (const r of recs) {
    const j = lvOf(r);
    assert.ok(Object.keys(j).every((k) => ["h", "a", "d"].includes(k)), JSON.stringify(j));
    for (const n of names) assert.ok(!r.payload.toString("utf8").includes(n), n);
  }
  const digits = posts.map((p) => p.lv.d).filter((d) => d.length >= 3);
  const meta = JSON.stringify(require(path.join(repo, "avsync")).audioMeta(PADS.pub.id));
  assert.deepEqual(Object.keys(JSON.parse(meta)).sort(), ["at", "hm", "lat"], "noteAudio keeps lat / hm only");
  const R = bridge._rooms.get(PADS.pub.id);
  const room = JSON.stringify(R, (k, v) => (v instanceof Set ? [...v] : v instanceof Map ? [...v.entries()] : v));
  assert.ok(!/"lv"/.test(room) && !digits.some((d) => room.includes('"' + d + '"')), "the room's state carries no levels");
  assert.ok(!logs.some((l) => digits.some((d) => l.includes(d)) || /\blv\b/.test(l)), "nothing about levels in the console");
  fr.req.destroy();
  await sleep(30);
});
