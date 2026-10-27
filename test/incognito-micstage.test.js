// 1.99afl - the incognito / mic-stage spec's site quick wins, end to end on a temp DB:
//   * B.1  an incognito person's mic grab / drop (Pepe sends it anonymised with no hash) is shown as "someone grabbed / dropped
//          the mic" - only when the same sync carried BOTH kinded hash lists (a Train 3 Pepe with his hide list loaded, who never
//          sends a !bridge hide person's events); joins / leaves and unstamped ones stay left out; the scrollback agrees;
//   * B.4a the 2026-10-27 replay (Players__Lounge, Pepe console 223824-223909): Frankie's turn shows on its own, so his late
//          transcript is no longer the only trace of him inside bxdude180's turn;
//   * S6   the whitelisted projection (the rollback floor): a field nobody listed - a later build's veiled identity, hidden
//          words, a server-only hash, the k3 stamp - never reaches /live, the history, the homepage panel or a roster;
//   * S5   the default picture (Pepe's face) is never a speaker's avatar: the page draws the letter bubble.
//   node --test test/incognito-micstage.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "incog-micstage-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
require(path.join(repo, "terms"))._setRequired(false);
const bridge = require(path.join(repo, "bridge"));
const CL = require(path.join(repo, "chatlog"));
const CV = require(path.join(repo, "chatlogview"));
const CH = require(path.join(repo, "chatloghist"));

const D = 864e5;
const hash = (login) => crypto.createHash("sha256").update("pepe-hidden:" + String(login).trim().toLowerCase()).digest("hex").slice(0, 20);
const ROOM = { id: "Players__Lounge", name: "Players Lounge" }, SLUG = "players-lounge";
const BX = { id: "bxdude180", login: "bxdude180", display: "BXDUDE180" };
const ALICE = { id: "alicecf", login: "alicecf", display: "Alice Ash" };
const FRANKIE_H = hash("frankiefettuccine");
const ANON = () => ({ id: "anon-" + crypto.randomBytes(4).toString("hex"), display: "someone", anonymous: true });
const users = new Map();
const U = {};
let base, server, seq = 0;
const ev = (type, data, ts) => ({ op: "event", id: "afl-" + (++seq), ts: new Date(ts).toISOString(), type, scope: { platform: "camfrog", room: ROOM }, data });
const snap = () => ({ room: ROOM, members: [ALICE, BX], mic: [], count: 2, transcripts: true });
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const KINDED = { bridge_hidden_h: [], incog_hidden_h: [FRANKIE_H] };

function call(method, url, user) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const headers = Object.assign({ "x-requested-with": "fetch" }, user ? { "x-test-user": user.userId } : {});
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { s += c; });
      res.on("end", () => { let d = null; try { d = JSON.parse(s); } catch (e) { d = null; } resolve({ status: res.statusCode, d, text: s }); });
    });
    req.on("error", reject);
    req.end();
  });
}
const live = (user) => call("GET", `/api/rooms/${SLUG}/live`, user);
const hist = (user, q = "limit=100") => call("GET", `/api/rooms/${SLUG}/history?${q}`, user);
async function mkUser(name, cls = "pleb", camfrog = null, avatar = null) {
  const uid = "id-" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, avatar)
                  VALUES (?, ?, ?, 'x', ?, 100000, ?, 5, '2026-01-01 00:00:00', ?)`, [uid, name, name, cls, camfrog, avatar]);
  const u = { userId: uid, username: name, class: cls };
  users.set(uid, u);
  return u;
}
/** A line as the page reads it: kind, who ("someone" / login), and the words or the hold. */
const say = (it) => (it.k === "mic" ? "mic:" : it.k === "unmic" ? "unmic:" : it.k === "tx" ? "tx:" : it.k + ":") +
  (it.u && it.u.anon ? "someone" : it.u ? it.u.login : "-") + (it.k === "tx" ? ":" + it.text : it.k === "unmic" && it.ms ? ":" + it.ms : "");

let T0 = 0;
const setup = (async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await require(path.join(repo, "inbox")).ready;
  U.own = await mkUser("own", "pleb", "owncf");
  U.mem = await mkUser("mem", "pleb", "memcf");
  U.bx = await mkUser("bxpatv", "pleb", "bxdude180", "/public/img/avatar.png");        // the default picture (Pepe's face)
  U.alice = await mkUser("alice", "pleb", "alicecf", "https://cdn.example.test/a.png");  // a real photo
  await rooms.init();
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  bridge.register(app, { addUser, isBotToken: (t) => t === "bot" });
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  await new Promise((r) => { server = app.listen(0, r); });
  server.unref();
  base = "http://127.0.0.1:" + server.address().port;
  // the archive on (the notice 8 days ago); scrollback on
  CL._setClock(() => Date.now() - 8 * D);
  await CL.setSwitch("notice", true, "test");
  CL._setClock(() => Date.now());
  for (const s of ["archive", "history"]) await CL.setSwitch(s, true, "test");
  T0 = Date.now();
  await rooms.setOwner(ROOM.id, "own", "test");
  // an older batch (no kinded lists - an older Pepe, or one whose hide list didn't load): its anonymous mic lines stay left out
  await bridge.ingest({ rooms: [snap()], hidden_h: [FRANKIE_H], events: [
    ev("mic.grab", { user: ANON() }, T0 - 10 * 60e3),
    ev("mic.release", { user: ANON(), held_ms: 5000 }, T0 - 10 * 60e3 + 5000),
  ] });
  // ... one with only the incognito list (the bridge-hide list null: lost) - left out too
  await bridge.ingest({ rooms: [snap()], hidden_h: [FRANKIE_H], bridge_hidden_h: null, incog_hidden_h: [FRANKIE_H], events: [
    ev("mic.grab", { user: ANON() }, T0 - 8 * 60e3),
  ] });
  // the 10-27 replay (Pepe console 223824-223909): Frankie (incognito) holds 29.9 s, BXDUDE180 grabs, Frankie's transcript lands
  // after speech-to-text, BX releases after 22.1 s, BX's own transcript - one sync per console moment, every one kinded
  const t = T0 - 5 * 60e3;
  const batches = [
    [ev("mic.grab", { user: ANON() }, t)],                                                                      // 223824
    [ev("mic.release", { user: ANON(), held_ms: 29900 }, t + 29900)],                                           // 223858
    [ev("mic.grab", { user: BX }, t + 30500)],                                                                  // 223869
    [ev("x.pepe.transcript", { id: "tx-00000000000000f1", user: ANON(), text: "Hercules is the funniest", source: "mic",
                                anon: { kind: "incognito", h: FRANKIE_H } }, t + 33000)],                       // 223872
    [ev("mic.release", { user: BX, held_ms: 22100 }, t + 52600)],                                               // 223895
    [ev("x.pepe.transcript", { id: "tx-00000000000000b1", user: BX, text: "bx says hi", source: "mic" }, t + 60000)],   // 223909
    [ev("member.join", { user: ANON() }, t + 61000)],                                                           // a stand-in join: out
  ];
  for (const events of batches) await bridge.ingest({ rooms: [snap()], hidden_h: [FRANKIE_H], ...KINDED, events });
  await settle();
  await CV.init();
  await CV.refreshNames();
  CV._clearCaches();
})();
const ready = async () => { await setup; CH._reset(); CV._clearCaches(); };

test("B.1: a hashless anonymous mic grab / drop is stamped k3 only in a sync carrying BOTH kinded lists - kept in bridge_feed and the archive, never on a page", async () => {
  await ready();
  const R = bridge._rooms.get(ROOM.id);
  const anonMic = R.feed.filter((it) => (it.k === "mic" || it.k === "unmic") && it.u && it.u.anon);
  assert.equal(anonMic.length, 5, "all five anonymous mic events are in the live feed (the projection decides)");
  assert.deepEqual(anonMic.map((it) => it.k3 || 0), [0, 0, 0, 1, 1], "only the kinded syncs' are stamped");
  assert.ok(!R.feed.some((it) => it.k === "mic" && !it.u.anon && it.k3), "a named mic line is never stamped");
  const rows = await getQuery("SELECT k, who, d FROM chat_log WHERE k IN ('mic', 'unmic') AND who IS NULL ORDER BY c");
  assert.deepEqual(rows.map((r) => JSON.parse(r.d).k3 || 0), [0, 0, 0, 1, 1], "the archive keeps the stamp in d");
  const bf = await getQuery("SELECT data FROM bridge_feed WHERE data LIKE '%\"k3\":1%'");
  assert.equal(bf.length, 2, "and so does bridge_feed (a restart keeps it)");
  // the projection
  const stamped = anonMic.filter((it) => it.k3 === 1);
  for (const it of stamped) assert.equal(CV.privacyOf(it), "anon");
  for (const it of anonMic.filter((x) => !x.k3)) assert.equal(CV.privacyOf(it), "out", "unstamped: left out (fails closed)");
  assert.equal(CV.privacyOf({ k: "join", ts: Date.now(), u: { anon: true, display: "someone" }, k3: 1 }), "out", "a join is never shown, stamped or not");
  assert.equal(CV.privacyOf({ k: "leave", ts: Date.now(), u: { anon: true, display: "someone" }, k3: 1 }), "out");
  assert.equal(CV.privacyOf({ k: "mic", ts: Date.now(), u: { anon: true, display: "someone" }, k3: true }), "out", "only the exact stamp");
});

test("B.4 (a): the 10-27 replay - 'someone grabbed / dropped the mic' around Frankie's turn; his transcript has its own anonymous grab before it", async () => {
  await ready();
  for (const viewer of [U.mem, U.own]) {
    const r = await live(viewer);
    assert.equal(r.status, 200, r.text.slice(0, 200));
    const lines = r.d.feed.map(say);
    const replay = lines.slice(lines.indexOf("mic:someone"));
    assert.deepEqual(replay, ["mic:someone", "unmic:someone:29900", "mic:bxdude180", "tx:someone:Hercules is the funniest", "unmic:bxdude180:22100",
                              "tx:bxdude180:bx says hi"], "for " + viewer.username);
    assert.equal(lines.filter((l) => l.startsWith("mic:someone") || l.startsWith("unmic:someone")).length, 2, "the unstamped ones stay out");
    assert.ok(!r.d.feed.some((it) => it.k === "join" && it.u && it.u.anon), "a stand-in join stays out");
    // every anonymous transcript has an anonymous grab before it (it no longer reads as bxdude180's)
    lines.forEach((l, i) => { if (l.startsWith("tx:someone")) assert.ok(lines.slice(0, i).includes("mic:someone"), "an anonymous grab before " + l); });
    const json = JSON.stringify(r.d.feed);
    for (const leak of ["k3", "\"ah\"", "ahs", FRANKIE_H, "frankie"]) assert.ok(!json.includes(leak), leak + " reached the page");
  }
  // the homepage panel says the same, and nothing more
  const home = JSON.stringify(await bridge.liveFor(SLUG, U.mem));
  assert.ok(home.includes("29900"));
  for (const leak of ["k3", FRANKIE_H]) assert.ok(!home.includes(leak), leak);
});

test("B.1 scrollback: the stamped anonymous mic lines are 'someone' rows; the unstamped and the stand-in join stay out (SQL reads them, the projection decides)", async () => {
  await ready();
  const h = await hist(U.mem);
  assert.equal(h.status, 200, h.text.slice(0, 200));
  const lines = h.d.items.map(say);
  assert.equal(lines.filter((l) => /^(un)?mic:someone/.test(l)).length, 2, JSON.stringify(lines));
  assert.ok(lines.includes("unmic:someone:29900"));
  assert.ok(!h.d.items.some((it) => it.k === "join" && it.u && it.u.anon));
  assert.ok(!/k3|"ah"|ahs/.test(JSON.stringify(h.d.items)), "nothing server-only in the history answer");
});

test("S6: dress and roster are WHITELISTS - an unknown field (a later build's identity, hidden words, a hash, a stamp) never reaches any page", async () => {
  await ready();
  const V = CV.closedView ? Object.assign(CV.closedView(), { role: "member" }) : { role: "member" };
  const now = Date.now();
  const extra = { vz: { login: "frankiefettuccine", display: "Frankie" }, vw: "hidden words", _vz: "x", foo: 1, k3: 1, aud: "p", priv: { kind: "hidden" }, rm_by: "mod:1" };
  const items = [
    Object.assign({ c: 1, ts: now, k: "msg", u: { login: "alicecf", display: "Alice", on_cam: true, proven: true, vz: "x", web: true }, text: "hi" }, extra),
    Object.assign({ c: 2, ts: now, k: "tx", u: { login: "alicecf", display: "Alice" }, text: "mic words", id: "tx-0000000000000001" }, extra),
    Object.assign({ c: 3, ts: now, k: "unmic", u: { login: "alicecf", display: "Alice" }, ms: 3000 }, extra),
    Object.assign({ c: 4, ts: now, k: "live", who: "Bob", pad: "Pad", what: "a show", link: "/p/pad", np: 1 }, extra),
    Object.assign({ c: 5, ts: now, k: "note", w: "open", o: 7, sc: "both" }, extra),
    Object.assign({ c: 6, ts: now, k: "topic", text: "the topic" }, extra),
    Object.assign({ c: 7, ts: now, k: "mic", u: { anon: true, display: "someone", vz: "frankiefettuccine" } }, extra),
    Object.assign({ c: 8, ts: now, k: "chal", u: { login: "alicecf", display: "Alice" }, text: "an unknown kind's words" }, extra),
  ];
  const out = CV.dress(items, { view: V });
  assert.deepEqual(Object.keys(out[0]).sort(), ["c", "k", "text", "ts", "u"]);
  assert.deepEqual(out[0].u, { login: "alicecf", display: "Alice", web: true }, "a user ref is whitelisted too (no on_cam / proven / vz)");
  assert.deepEqual(Object.keys(out[1]).sort(), ["c", "id", "k", "text", "ts", "u"]);
  assert.deepEqual(Object.keys(out[2]).sort(), ["c", "k", "ms", "ts", "u"]);
  assert.deepEqual(Object.keys(out[3]).sort(), ["c", "k", "link", "np", "pad", "ts", "what", "who"]);
  assert.deepEqual(Object.keys(out[4]).sort(), ["c", "k", "o", "sc", "ts", "w"]);
  assert.deepEqual(Object.keys(out[5]).sort(), ["c", "k", "text", "ts"]);
  assert.deepEqual(out[6].u, { anon: true, display: "someone" });
  assert.deepEqual(Object.keys(out[7]).sort(), ["c", "k", "ts", "u"], "a kind this build doesn't know shows nothing but its frame");
  const all = JSON.stringify(out);
  for (const leak of ["vz", "vw", "hidden words", "frankiefettuccine", "foo", "k3", "aud", "priv", "rm_by", "proven", "on_cam"]) assert.ok(!all.includes(leak), leak);
  // rosters
  const ro = CV.roster([{ login: "alicecf", display: "Alice", on_cam: true, on_mic: true, src: "list", proven: true, since: 5, vz: "x", foo: 1 },
                        { anon: true, display: "someone", vz: "frankiefettuccine" }, null, "junk"]);
  assert.deepEqual(ro, [{ login: "alicecf", display: "Alice", on_cam: true, on_mic: true, src: "list" }, { anon: true, display: "someone" }]);
  // end to end: an item a LATER build stored with a veiled identity (a rollback) - /live and the homepage panel never carry it
  const R = bridge._rooms.get(ROOM.id);
  R.feed.push(Object.assign({ c: 999999990, ts: now, k: "msg", u: { login: "alicecf", display: "Alice" }, text: "rollback line" }, extra));
  R.mic = [{ login: "alicecf", display: "Alice", proven: true, since: now - 5000, vz: "frankiefettuccine" }];
  try {
    const r = await live(U.mem);
    assert.equal(r.status, 200);
    assert.ok(r.d.feed.some((it) => it.text === "rollback line"));
    for (const leak of ["vz", "vw", "hidden words", "frankiefettuccine", "\"foo\"", "k3", "\"priv\""]) assert.ok(!r.text.includes(leak), leak + " reached /live");
    const home = JSON.stringify(await bridge.liveFor(SLUG, U.mem));
    for (const leak of ["vz", "hidden words", "frankiefettuccine"]) assert.ok(!home.includes(leak), leak + " reached the homepage panel");
  } finally {
    R.feed = R.feed.filter((it) => it.c !== 999999990);
    R.mic = [];
  }
});

test("S5: the default picture is never a speaker's avatar (the letter bubble instead); a real photo is kept", async () => {
  await ready();
  const r = await live(U.mem);
  assert.equal(r.status, 200);
  const bx = r.d.feed.find((it) => it.k === "tx" && it.u && it.u.login === "bxdude180");
  assert.ok(bx && bx.u.patv, "bxdude180 is linked (bxpatv)");
  assert.equal(bx.u.patv.avatar, null, "Pepe's face (the default) is 'no photo'");
  const C = new Map([[bridge.nameKey("alicecf"), { acc: { username: "alice", display: "Alice", avatar: "https://cdn.example.test/a.png" } }],
                     [bridge.nameKey("bxdude180"), { acc: { username: "bxpatv", display: "BX", avatar: "avatar.png" } }],
                     [bridge.nameKey("x1"), { acc: { username: "x1", display: "X", avatar: "//evil.example/a.png" } }]]);
  assert.equal(bridge.withPatv({ login: "alicecf", display: "Alice" }, C).patv.avatar, "https://cdn.example.test/a.png");
  assert.equal(bridge.withPatv({ login: "bxdude180", display: "BX" }, C).patv.avatar, null, "the old relative default too");
  assert.equal(bridge.withPatv({ login: "x1", display: "X" }, C).patv.avatar, null, "never another site's protocol-relative URL");
});
