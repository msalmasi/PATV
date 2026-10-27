// 1.99afl - the incognito / mic-stage spec's site quick wins, end to end on a temp DB:
//   * B.1  an incognito person's mic grab / drop (Pepe sends it anonymised with no hash) is shown as "someone grabbed / dropped
//          the mic" - only when the same sync carried BOTH kinded hash lists (a Train 3 Pepe with his hide list loaded, who never
//          sends a !bridge hide person's events); joins / leaves and unstamped ones stay left out; the scrollback agrees;
//          review: a drop only when its hold's grab was stamped (Pepe's per-hold ref) - a hold begun named whose holder went
//          !bridge hide mid-hold stays out; a mic event with the holder's hash (data.anon) leaves once that hash is left out;
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
  const FR = ANON();                       // Pepe's ONE random ref for Frankie's whole hold (pepe_bridge._br_hold_user)
  const batches = [
    [ev("mic.grab", { user: FR }, t)],                                                                          // 223824
    [ev("mic.release", { user: FR, held_ms: 29900 }, t + 29900)],                                               // 223858
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

// review fixes (1.99afl): B.1 stamps per HOLD (Pepe's per-hold ref); a mic event with the holder's incognito hash is an `ah` line
const liveOf = (slug, user) => call("GET", `/api/rooms/${slug}/live`, user);
const histOf = (slug, user, q = "limit=100") => call("GET", `/api/rooms/${slug}/history?${q}`, user);
const evIn = (room, type, data, ts) => Object.assign(ev(type, data, ts), { scope: { platform: "camfrog", room } });

test("review (HIGH): a hold begun NAMED whose holder types !bridge hide mid-hold - Pepe's anonymised release (a fresh ref) pairs with no stamped grab: left out, never 'someone dropped the mic' in place of their vanished grab", async () => {
  await ready();
  const ROOM2 = { id: "Orphan_Room", name: "Orphan Room" }, X = { id: "xuser", login: "xuser", display: "X User" };
  const snap2 = () => ({ room: ROOM2, members: [ALICE, X], mic: [], count: 2, transcripts: true });
  await rooms.setOwner(ROOM2.id, "own", "test");
  const t = Date.now() - 60e3;
  await bridge.ingest({ rooms: [snap2()], hidden_h: [FRANKIE_H], ...KINDED, events: [evIn(ROOM2, "mic.grab", { user: X }, t)] });
  let r = await liveOf("orphan-room", U.mem);
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.deepEqual(r.d.feed.map(say).filter((l) => /^(un)?mic:/.test(l)), ["mic:xuser"], "the named grab is up");
  // X types !bridge hide (private-args: the command never reaches the pad); Pepe's next sync carries the hide list + the privacy
  // event + the release, anonymised under a FRESH ref (_br_hold_anon: the holder is "out" NOW; the hold began named)
  await bridge.ingest({ rooms: [snap2()], hidden_h: [FRANKIE_H, hash("xuser")], bridge_hidden_h: [hash("xuser")], incog_hidden_h: [FRANKIE_H], events: [
    { op: "event", id: "afl-priv-x", ts: new Date(t + 30e3).toISOString(), type: "privacy.hidden", data: { h: hash("xuser"), scope: "bridge" } },
    evIn(ROOM2, "mic.release", { user: ANON(), held_ms: 30000 }, t + 30e3),
  ] });
  await settle(100);
  CV._clearCaches(); CH._reset();
  const R2 = bridge._rooms.get(ROOM2.id);
  const rel = R2.feed.find((it) => it.k === "unmic");
  assert.ok(rel && rel.u.anon && rel.ar, "the release came in anonymised, its ref kept server-side");
  assert.equal(rel.k3, undefined, "not stamped: its ref was never a stamped grab's");
  assert.equal(CV.privacyOf(rel), "out");
  assert.equal(CV.privacyOf(R2.feed.find((it) => it.k === "mic")), "out", "the named grab leaves (!bridge hide = left out everywhere)");
  r = await liveOf("orphan-room", U.mem);
  assert.equal(r.status, 200);
  assert.deepEqual(r.d.feed.map(say).filter((l) => /^(un)?mic:/.test(l)), [], "no grab, and no 'someone dropped the mic' in its place");
  const h = await histOf("orphan-room", U.mem);
  assert.equal(h.status, 200, h.text.slice(0, 200));
  assert.ok(!h.d.items.some((it) => it.k === "mic" || it.k === "unmic"), "scrollback agrees");
  // a stamped grab pairs with ITS release only; one released after a restart pairs again once the live feed is replayed
  const A = ANON(), B = ANON();
  await bridge.ingest({ rooms: [snap2()], hidden_h: [FRANKIE_H], ...KINDED, events: [evIn(ROOM2, "mic.grab", { user: A }, t + 40e3), evIn(ROOM2, "mic.grab", { user: B }, t + 41e3)] });
  bridge._k3Refs.delete(ROOM2.id);                                              // a restart ...
  bridge._k3Replay(R2);                                                         // ... rebuilds the open stamped holds from bridge_feed
  await bridge.ingest({ rooms: [snap2()], hidden_h: [FRANKIE_H], ...KINDED, events: [
    evIn(ROOM2, "mic.release", { user: A, held_ms: 5000 }, t + 45e3),
    evIn(ROOM2, "mic.release", { user: A, held_ms: 5000 }, t + 46e3),           // (the same ref again: its hold already ended)
    evIn(ROOM2, "mic.release", { user: { id: "anon-zzzz", display: "someone", anonymous: true }, held_ms: 5000 }, t + 47e3),   // no valid ref
  ] });
  const rels = R2.feed.filter((it) => it.k === "unmic").slice(-3);
  assert.deepEqual(rels.map((it) => it.k3 || 0), [1, 0, 0], "A's release pairs with A's grab - once; a bad / missing ref never does");
  assert.ok(bridge._k3Refs.get(ROOM2.id).has(B.id) && !bridge._k3Refs.get(ROOM2.id).has(A.id), "B's hold is still open");
  // a release in a sync WITHOUT the kinded lists is never stamped, even for a stamped grab
  await bridge.ingest({ rooms: [snap2()], hidden_h: [FRANKIE_H], events: [evIn(ROOM2, "mic.release", { user: B, held_ms: 9000 }, t + 50e3)] });
  assert.equal(R2.feed.filter((it) => it.k === "unmic").pop().k3, undefined);
  // a hold begun while incognito (stamped grab) whose holder types !bridge hide mid-hold: Pepe still releases it under its own ref -
  // in the very sync that leaves them out, it isn't shown ("someone dropped" appearing as their lines leave would tie them)
  const C = ANON(), Y = "yuser";
  await bridge.ingest({ rooms: [snap2()], hidden_h: [FRANKIE_H, hash(Y)], bridge_hidden_h: [], incog_hidden_h: [FRANKIE_H, hash(Y)],
                        events: [evIn(ROOM2, "mic.grab", { user: C }, t + 51e3)] });
  await bridge.ingest({ rooms: [snap2()], hidden_h: [FRANKIE_H, hash(Y)], bridge_hidden_h: [hash(Y)], incog_hidden_h: [FRANKIE_H], events: [
    { op: "event", id: "afl-priv-y", ts: new Date(t + 55e3).toISOString(), type: "privacy.hidden", data: { h: hash(Y), scope: "bridge" } },
    evIn(ROOM2, "mic.release", { user: C, held_ms: 4000 }, t + 55e3)] });
  const relC = R2.feed.filter((it) => it.k === "unmic").pop();
  assert.equal(relC.ar, C.id);
  assert.equal(relC.k3, undefined, "not stamped in the sync that leaves someone out");
  assert.ok(!bridge._k3Refs.get(ROOM2.id).has(C.id), "the hold is over either way");
  r = await liveOf("orphan-room", U.mem);
  const json = JSON.stringify(r.d.feed);
  for (const leak of ["\"ar\"", A.id, B.id, "k3"]) assert.ok(!json.includes(leak), leak + " reached the page");
});

test("review: a mic grab / drop Pepe sends WITH the holder's incognito hash (data.anon) is 'someone grabbed the mic' - and leaves the live tail and scrollback once that hash is left out (!bridge hide, forget-me)", async () => {
  await ready();
  const ROOM3 = { id: "Hash_Room", name: "Hash Room" }, GINA_H = hash("ginacf"), G = ANON();
  const snap3 = () => ({ room: ROOM3, members: [ALICE], mic: [], count: 2, transcripts: true });
  await rooms.setOwner(ROOM3.id, "own", "test");
  const t = Date.now() - 60e3;
  const anon = { kind: "incognito", h: GINA_H };
  await bridge.ingest({ rooms: [snap3()], hidden_h: [FRANKIE_H, GINA_H], bridge_hidden_h: [], incog_hidden_h: [FRANKIE_H, GINA_H], events: [
    evIn(ROOM3, "mic.grab", { user: G, anon }, t),
    evIn(ROOM3, "mic.release", { user: G, held_ms: 12000, anon }, t + 12e3),
    evIn(ROOM3, "member.join", { user: ANON(), anon }, t + 13e3),               // a join stays out, hash or not
  ] });
  await settle(100);
  CV._clearCaches(); CH._reset();
  const R3 = bridge._rooms.get(ROOM3.id);
  const mics = R3.feed.filter((it) => it.k === "mic" || it.k === "unmic");
  assert.deepEqual(mics.map((it) => [it.ah, it.k3]), [[GINA_H, undefined], [GINA_H, undefined]], "an `ah` line, never stamped");
  for (const it of mics) assert.equal(CV.privacyOf(it), "anon");
  let r = await liveOf("hash-room", U.mem);
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.deepEqual(r.d.feed.map(say).filter((l) => /^(un)?mic:|^join:/.test(l)), ["mic:someone", "unmic:someone:12000"]);
  for (const leak of [GINA_H, "\"ah\"", "\"ar\"", G.id]) assert.ok(!r.text.includes(leak), leak + " reached the page");
  const rows = await getQuery("SELECT k, who FROM chat_log WHERE who = ? ORDER BY c", ["h:" + GINA_H]);
  assert.deepEqual(rows.map((x) => x.k), ["mic", "unmic"], "archived under the hash (forget-me / the left-out rule reach them)");
  let h = await histOf("hash-room", U.mem);
  assert.deepEqual(h.d.items.map(say).filter((l) => /^(un)?mic:/.test(l)), ["mic:someone", "unmic:someone:12000"]);
  // Gina types !bridge hide: her "someone" mic lines leave too - nothing of hers stays up
  await bridge.ingest({ rooms: [snap3()], hidden_h: [FRANKIE_H, GINA_H], bridge_hidden_h: [GINA_H], incog_hidden_h: [FRANKIE_H], events: [
    { op: "event", id: "afl-priv-g", ts: new Date().toISOString(), type: "privacy.hidden", data: { h: GINA_H, scope: "bridge" } }] });
  await settle(100);
  CV._clearCaches(); CH._reset();
  for (const it of mics) assert.equal(CV.privacyOf(it), "out");
  r = await liveOf("hash-room", U.mem);
  assert.deepEqual(r.d.feed.map(say).filter((l) => /^(un)?mic:/.test(l)), [], "left out of the live tail");
  h = await histOf("hash-room", U.mem);
  assert.deepEqual(h.d.items.map(say).filter((l) => /^(un)?mic:/.test(l)), [], "and of scrollback");
  // more hashes than the line may carry: not kept (fails closed)
  const many = Array.from({ length: 40 }, (_, i) => hash("p" + i));
  const n0 = R3.feed.filter((it) => it.k === "mic").length;
  await bridge.ingest({ rooms: [snap3()], hidden_h: [FRANKIE_H], ...KINDED, events: [evIn(ROOM3, "mic.grab", { user: ANON(), anon: { kind: "incognito", h: FRANKIE_H, hs: many } }, t + 20e3)] });
  assert.equal(R3.feed.filter((it) => it.k === "mic").length, n0, "a grab with too many hashes isn't kept");
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
