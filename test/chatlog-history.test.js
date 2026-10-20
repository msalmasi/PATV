// CL8 chatloghist.js: infinite scrollback - the history API (the chat-history spec §2.2, §3.5 "History", §3.15 "History" and the
// leak test on /history).
//   * dark: chatlog.history off answers 404 off; signed out 401; another pad's / an unknown address 404;
//   * newest page, then before= back to the archive's start: no overlap, no gap, newest c last; more_before / more_after; the
//     floor reason (start for the owner; window for a member under 24 h); presence older than 24 h left out for members (with a
//     window and without one);
//   * after= / around= / at= edges (a line 1,000 back opens around it; at= a day -> its first line; past the newest -> the newest);
//   * one not_found for every line a member can't see (another room's, a removed one, a hidden person's, below the floor, none) -
//     the owner and the room's mods get a reason, never one that tells a hidden person's line or another room's from no line;
//   * the golden leak test: a hidden person's login and display names appear nowhere in /history, for any viewer (JSON keys and
//     values, and the lines as chatlog-core renders them: text and attributes) - CL8 fix-up: also their presence and 🎙 lines, a
//     !transcripts off person's 🎙 lines, a common-word display name (the stop-list), /history/check and /history/state;
//   * removed lines: never to members; the owner's muted row says who hid it;
//   * limits: 60 a minute and 20,000 items a day for viewers without full history (smaller here) - a page never takes more than
//     the day has left, refusals count, a plain mod is limited, the owner / staff / a mods_all mod aren't; staff reads below the
//     public floor (presence's 24 h too) audited in one row per 10 minutes that covers every span read;
//   * the scan budget: a hidden person's long run is left out in SQL; a run it still can't see hands out a SEALED position;
//   * the gates: an Approved pad's non-member, a whole-bridge block, a feed ban, the 💎 gate - on /history and the offline card;
//   * the floor reasons window, earlier, off, retention, start;
//   * open pages: the privacy digest (pv) moves on a hide and a takedown; /history/check drops and re-dresses what a page holds;
//   * the pad page: the live chat's scrollback hooks + the signed-out prompt; the offline 📜 Chat history card (not under "Off").
//   NODE_PATH=G:/PATV/node_modules node --test test/chatlog-history.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-history-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
process.env.MICCLIP_DIR = path.join(tmp, "micclip");
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
require(path.join(repo, "terms"))._setRequired(false);
const bridge = require(path.join(repo, "bridge"));
const CL = require(path.join(repo, "chatlog"));
const CV = require(path.join(repo, "chatlogview"));
const CH = require(path.join(repo, "chatloghist"));
const PC = require(path.join(repo, "padchat"));
const CORE = require(path.join(repo, "public", "js", "chatlog-core.js"));

const H = 3600e3, D = 864e5;
const ROOM = { id: "Hist.Room", name: "Hist Room" }, SLUG = "hist-room";       // 1,100+ lines over 60 hours
const WIN = { id: "Win.Room", name: "Win Room" }, WSLUG = "win-room";         // a 24 h window
const OTHER = { id: "Hist.Other", name: "Hist Other" };
const RUN = { id: "Run.Room", name: "Run Room" }, RSLUG = "run-room";         // a long run of a hidden person's lines
const OFF = { id: "Off.Room", name: "Off Room" }, OFSLUG = "off-room";        // its Camfrog room goes offline
const LEAK = { id: "Leak.Room", name: "Leak Room" }, LSLUG = "leak-room";     // CL8 fix-up: the extended leak test
const GATE = { id: "Gate.Room", name: "Gate Room" }, GSLUG = "gate-room";     // CL8 fix-up: Approved, blocks, bans, the 💎 gate
const RSN = { id: "Rsn.Room", name: "Reason Room" }, RNSLUG = "reason-room";  // CL8 fix-up: the floor reasons
const ALICE = { id: "alicecf", login: "alicecf", display: "Alice" };
const BOB = { id: "bobcf", login: "bobcf", display: "Bob" };
const CAROL = { id: "carolcf", login: "carolcf", display: "Carol" };
const SHY = { id: "shycf", login: "shycf", display: "Shy Violet" };           // goes hidden
const DAN = { id: "dancf", login: "dancf", display: "Dan Quiet" };            // goes hidden (an archived line, long out of the live tail)
const LOVE = { id: "lovecf", login: "lovecf", display: "Love" };              // goes hidden; a common-word display name (the stop-list)
const TEX = { id: "texcf", login: "texcf", display: "Tex Mic" };              // !transcripts off
const users = new Map();
const U = {};
let base, server, seq = 0;
const ev = (room, type, data, ts) => ({ op: "event", id: "hi-" + (++seq), ts: new Date(ts).toISOString(), type, scope: { platform: "camfrog", room }, data });
const snap = (room) => ({ room, members: [ALICE, BOB, CAROL], mic: [], count: 3, transcripts: true, mod: { modcf: { actions: ["kick", "ban"] } } });

function call(method, url, user, body, extra = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const u = new URL(base + url);
    const headers = Object.assign({ "x-requested-with": "fetch" }, data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {},
                                  user ? { "x-test-user": user.userId } : {}, extra);
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { s += c; });
      res.on("end", () => { let d = null; try { d = JSON.parse(s); } catch (e) { d = null; } resolve({ status: res.statusCode, d, text: s, headers: res.headers }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const get = (url, user) => call("GET", url, user);
const hist = (user, q = "", slug = SLUG) => get(`/api/rooms/${slug}/history${q ? "?" + q : ""}`, user);
const state = (user, slug = SLUG) => get(`/api/rooms/${slug}/history/state`, user);
const check = (user, cs, slug = SLUG) => call("POST", `/api/rooms/${slug}/history/check`, user, { cs });
async function mkUser(name, cls = "pleb", camfrog = null) {
  const uid = "id-" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at)
                  VALUES (?, ?, ?, 'x', ?, 100000, ?, 5, '2026-01-01 00:00:00')`, [uid, name, name, cls, camfrog]);
  const u = { userId: uid, username: name, class: cls };
  users.set(uid, u);
  return u;
}
const cOf = async (text) => { const r = (await getQuery("SELECT c FROM chat_log WHERE text = ?", [text]))[0]; assert.ok(r, "archived: " + text); return Number(r.c); };
const rkOf = async (room) => Number((await getQuery("SELECT rk FROM chatlog_rooms WHERE room_id = ?", [room.id]))[0].rk);
/** Every page from the newest back to the floor. -> {items (ascending), pages, last (the last answer)} */
async function walkBack(user, slug = SLUG, q = "") {
  let r = await hist(user, q, slug);
  assert.equal(r.status, 200, r.text.slice(0, 300));
  const pages = [r.d];
  let items = r.d.items.slice();
  for (let i = 0; i < 60 && r.d.more_before; i++) {
    const pos = r.d.next_before || r.d.items[0].c;
    r = await hist(user, "before=" + encodeURIComponent(pos) + (q ? "&" + q : ""), slug);
    assert.equal(r.status, 200, r.text.slice(0, 300));
    pages.push(r.d);
    items = r.d.items.concat(items);
  }
  return { items, pages, last: r.d };
}
const ascending = (items) => items.every((it, i) => i === 0 || Number(it.c) > Number(items[i - 1].c));
/** Pepe un-hides one person (one event a sync: a batch that weakens several at once is held for an operator). */
async function shown(login, scope) {
  await bridge.ingest({ events: [{ op: "event", id: "hi-sh-" + (++seq), ts: new Date().toISOString(), type: "privacy.shown", data: { h: CL.hash(login), scope } }], rooms: [] });
  await new Promise((r) => setTimeout(r, 60));
  await CV.refreshNames();
  CV._clearCaches();
}
const WHYS = new Set(["floor", "removed", "no_line"]);
const PRESENCE = ["join", "leave", "mic", "unmic"];

let T0 = 0;
const setup = (async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await require(path.join(repo, "media")).ready;
  await require(path.join(repo, "inbox")).ready;
  require(path.join(repo, "actions"));
  U.own = await mkUser("own", "pleb", "owncf");
  U.mem = await mkUser("mem", "pleb", "memcf");
  U.mem2 = await mkUser("mem2", "pleb", "mem2cf");
  U.mem3 = await mkUser("mem3", "pleb", "mem3cf");
  U.alice = await mkUser("alice", "pleb", "alicecf");
  U.mod = await mkUser("modu", "pleb", "modcf");
  U.staff = await mkUser("helper", "Staff");
  await rooms.init();
  await require(path.join(repo, "feedstore")).init();
  await require(path.join(repo, "pepefeed")).ensureAccount().catch(() => {});
  await new Promise((r) => setTimeout(r, 150));
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  require(path.join(repo, "pads")).register(app);
  require(path.join(repo, "feedweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  bridge.register(app, { addUser, isBotToken: (t) => t === "bot" });
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  await new Promise((r) => { server = app.listen(0, r); });
  server.unref();
  base = "http://127.0.0.1:" + server.address().port;
  // the archive on (the notice 8 days ago); scrollback on
  const realNow = CL.now;
  CL._setClock(() => Date.now() - 8 * D);
  await CL.setSwitch("notice", true, "test");
  CL._setClock(() => Date.now());
  await CL.setSwitch("archive", true, "test");
  await CL.setSwitch("history", true, "test");
  void realNow;
  T0 = Date.now();
  // CL3 fix-up: the pads have their owner while their chat is archived (an owner assigned AFTER the lines were said starts a new
  // owner era - owner_since - and reads the earlier lines only as far as the public window, unless staff grant it)
  for (const r of [ROOM, WIN, OTHER, RUN, OFF, LEAK, GATE, RSN]) await rooms.setOwner(r.id, "own", "test");
  // Hist.Room: 1,100 lines over the last 60 hours (alice / bob), plus presence, a transcript and hidden people's lines
  const evs = [];
  for (let i = 0; i < 1100; i++) {
    const ts = T0 - 60 * H + Math.floor(i * (59 * H) / 1100);
    evs.push(ev(ROOM, "message", { user: i % 2 ? BOB : ALICE, text: `filler ${i}` }, ts));
    if (i === 50) {                                                                                // CL8 fix-up: long out of the live tail
      evs.push(ev(ROOM, "message", { user: DAN, text: "dan early words" }, ts + 1));
      evs.push(ev(ROOM, "message", { user: BOB, text: "say hi to Dan Quiet" }, ts + 2));
    }
    if (i === 300) evs.push(ev(ROOM, "member.join", { user: CAROL }, ts + 1));                   // ~44 h ago
    if (i === 700) evs.push(ev(ROOM, "x.pepe.transcript", { id: "tx-00000000000000a7", user: ALICE, text: "alice on the mic" }, ts + 1));
    if (i === 900) evs.push(ev(ROOM, "message", { user: SHY, text: "shy secret words" }, ts + 1));
    if (i === 901) evs.push(ev(ROOM, "message", { user: BOB, text: "hey Shy Violet and @shycf, look" }, ts + 1));
    if (i === 1050) evs.push(ev(ROOM, "member.join", { user: BOB }, ts + 1));                     // ~2 h ago
  }
  for (let i = 0; i < evs.length; i += 450) await bridge.ingest({ rooms: [snap(ROOM)], events: evs.slice(i, i + 450) });
  await bridge.ingest({ rooms: [snap(OTHER)], events: [ev(OTHER, "message", { user: ALICE, text: "golf other room" }, T0 - H)] });
  // Win.Room: lines from 40 h ago to now, then a 24 h window
  const wev = [];
  for (let i = 0; i < 80; i++) wev.push(ev(WIN, "message", { user: ALICE, text: `win ${i}` }, T0 - 40 * H + i * 30 * 60e3));
  wev.push(ev(WIN, "member.join", { user: CAROL }, T0 - 30 * H));
  wev.push(ev(WIN, "member.join", { user: BOB }, T0 - 2 * H));
  wev.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  await bridge.ingest({ rooms: [snap(WIN)], events: wev });
  // Run.Room: 20 old lines, 140 by the person who goes hidden, 20 new ones
  const rev = [];
  for (let i = 0; i < 180; i++) {
    const who = i >= 20 && i < 160 ? SHY : ALICE;
    rev.push(ev(RUN, "message", { user: who, text: (who === SHY ? "run shy " : "run ok ") + i }, T0 - 10 * H + i * 60e3));
  }
  await bridge.ingest({ rooms: [snap(RUN)], events: rev });
  // Off.Room: a few lines, then Pepe leaves the room
  await bridge.ingest({ rooms: [snap(OFF)], events: [ev(OFF, "message", { user: ALICE, text: "said before the room closed" }, T0 - H),
                                                     ev(OFF, "message", { user: BOB, text: "the last line in the off room" }, T0 - 30 * 60e3)] });
  // CL8 fix-up - Leak.Room: hidden people's chat, presence and 🎙 lines inside 24 h; a common-word display name; !transcripts off
  const lev = [];
  for (let i = 0; i < 30; i++) lev.push(ev(LEAK, "message", { user: i % 2 ? BOB : ALICE, text: `leak filler ${i}` }, T0 - 5 * H + i * 6 * 60e3));
  lev.push(ev(LEAK, "member.join", { user: SHY }, T0 - 3 * H));
  lev.push(ev(LEAK, "mic.grab", { user: SHY }, T0 - 3 * H + 1000));
  lev.push(ev(LEAK, "x.pepe.transcript", { id: "tx-00000000000000b1", user: SHY, text: "shy mic words" }, T0 - 3 * H + 2000));
  lev.push(ev(LEAK, "mic.release", { user: SHY, held_ms: 5000 }, T0 - 3 * H + 3000));
  lev.push(ev(LEAK, "message", { user: SHY, text: "shy secret words two" }, T0 - 3 * H + 4000));
  lev.push(ev(LEAK, "message", { user: BOB, text: "hey Shy Violet" }, T0 - 3 * H + 5000));
  lev.push(ev(LEAK, "member.join", { user: LOVE }, T0 - 2 * H));
  lev.push(ev(LEAK, "message", { user: LOVE, text: "love own words" }, T0 - 2 * H + 1000));
  lev.push(ev(LEAK, "message", { user: BOB, text: "I love this song" }, T0 - 2 * H + 2000));
  lev.push(ev(LEAK, "message", { user: ALICE, text: "hi lovecf and Love" }, T0 - 2 * H + 3000));
  lev.push(ev(LEAK, "message", { user: TEX, text: "tex chat words" }, T0 - 90 * 60e3));
  lev.push(ev(LEAK, "x.pepe.transcript", { id: "tx-00000000000000b2", user: TEX, text: "tex transcript words" }, T0 - 90 * 60e3 + 1000));
  lev.push(ev(LEAK, "message", { user: BOB, text: "hey Tex Mic" }, T0 - 90 * 60e3 + 2000));
  lev.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  await bridge.ingest({ rooms: [snap(LEAK)], events: lev });
  // Gate.Room: a few recent lines; Reason.Room: two lines past the standard tier's 30 days and five recent ones
  await bridge.ingest({ rooms: [snap(GATE)], events: Array.from({ length: 10 }, (_, i) => ev(GATE, "message", { user: ALICE, text: `gate ${i}` }, T0 - H + i * 60e3)) });
  await bridge.ingest({ rooms: [snap(RSN)], events: [ev(RSN, "message", { user: ALICE, text: "reason ancient 1" }, T0 - 40 * D),
                                                     ev(RSN, "message", { user: BOB, text: "reason ancient 2" }, T0 - 40 * D + 60e3),
                                                     ...Array.from({ length: 5 }, (_, i) => ev(RSN, "message", { user: ALICE, text: `reason recent ${i}` }, T0 - 3 * H + i * 60e3))] });
  await CV.init();
  await require(path.join(repo, "chatlogmod")).init();
  PC._reset();
  CV._clearCaches();
  await PC.save(U.own, { id: WIN.id }, { window_s: 86400 });
})();
// (no test.after / beforeEach: Node 16's runner lacks them - the server is unref'd, each test resets what it uses)
const ready = async () => { await setup; CH._reset(); PC._reset(); CV._clearCaches(); };

test("dark and gated: chatlog.history off = 404 off; signed out 401; an unknown pad 404; no-store + noindex", async () => {
  await ready();
  await CL.setSwitch("history", false, "test");
  try {
    const r = await hist(U.mem);
    assert.equal(r.status, 404);
    assert.equal(r.d.code, "off");
    assert.equal((await state(U.mem)).status, 404, "/history/state too");
    assert.equal((await check(U.mem, [1])).status, 404, "/history/check too");
  } finally { await CL.setSwitch("history", true, "test"); }
  let r = await hist(null);
  assert.equal(r.status, 401);
  assert.equal(r.d.code, "signin");
  assert.equal(r.headers["cache-control"], "no-store");
  assert.match(String(r.headers["x-robots-tag"]), /noindex/);
  assert.equal((await state(null)).status, 401);
  assert.equal((await check(null, [1])).status, 401);
  r = await hist(U.mem, "", "no-such-pad");
  assert.equal(r.status, 404);
  assert.equal(r.d.code, "not_found");
  // a pad with no Camfrog room has no chat archive (and the API never makes it a chatlog_rooms row)
  const site = (await getQuery("SELECT room_id, slug FROM rooms_registry WHERE platform IS NOT NULL AND platform <> 'camfrog' AND slug IS NOT NULL LIMIT 1"))[0];
  assert.ok(site, "a site pad exists (the Lounge)");
  r = await hist(U.mem, "", site.slug);
  assert.equal(r.status, 404, r.text.slice(0, 200));
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chatlog_rooms WHERE room_id = ?", [site.room_id]))[0].n, 0);
  r = await hist(U.mem);
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(r.headers["cache-control"], "no-store");
  assert.match(String(r.headers["x-robots-tag"]), /noindex, nofollow, noarchive/);
  // 18+ without the age confirmation: no history (the live tail is CL3's)
  await runQuery("UPDATE rooms_registry SET adult = 1 WHERE room_id = ?", [ROOM.id]);
  await rooms.loadCache();
  CV._setAttested(() => false);
  CV._clearCaches();
  try {
    r = await hist(U.mem);
    assert.equal(r.status, 403);
    assert.equal(r.d.code, "no_history");
    const s = await state(U.mem);
    assert.equal(s.status, 200);
    assert.equal(s.d.history.scroll, false, "the offline card's poll learns it may not read back here");
    const k = await check(U.mem, [await cOf("filler 5")]);
    assert.deepEqual(k.d.gone, [await cOf("filler 5")], "a page that lost history drops what it held");
  } finally {
    await runQuery("UPDATE rooms_registry SET adult = 0 WHERE room_id = ?", [ROOM.id]);
    await rooms.loadCache();
    CV._setAttested(null);
  }
  // bad requests
  for (const q of ["before=1&after=2", "before=abc", "before=p1.b.12.AAAAAAAAAAAAAAAAAAAAAA", "after=h1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "at=yesterday"]) {
    r = await hist(U.mem, q);
    assert.equal(r.status, 400, q + ": " + r.text.slice(0, 200));
  }
});

test("newest page, then before= back to the archive's start: no overlap, no gap; the flags; the owner's floor is the start", async () => {
  await ready();
  const first = await hist(U.own);
  assert.equal(first.status, 200, first.text.slice(0, 300));
  const d = first.d;
  assert.equal(d.items.length, 50);
  assert.ok(ascending(d.items), "oldest first in a page");
  assert.equal(d.more_before, true);
  assert.equal(d.more_after, false, "the newest page");
  assert.ok(Number(d.cursor) >= Number(d.items[d.items.length - 1].c), "cursor: the newest c");
  assert.deepEqual(d.acts, { report: 1, hide: 1, purge: 0 }, "the line menu for the owner");
  const al = d.items.find((it) => it.u && it.u.login === "alicecf");
  assert.equal(al.u.patv.username, "alice", "dressed like /live: today's PATV name");
  assert.equal(al.own, undefined);
  const w = await walkBack(U.own);
  assert.ok(ascending(w.items), "no overlap, in order");
  const rk = await rkOf(ROOM);
  const all = (await getQuery("SELECT c FROM chat_log WHERE rk = ? ORDER BY c", [rk])).map((r) => Number(r.c));
  assert.deepEqual(w.items.map((it) => Number(it.c)), all, "every archived line, no gap (nobody is hidden yet)");
  assert.equal(w.last.more_before, false);
  assert.equal(w.last.floor.reason, "start", "the owner reads to the archive's start");
  assert.ok(w.items.some((it) => it.k === "join" && it.u && it.u.login === "carolcf"), "the owner keeps presence older than 24 h");
  assert.ok(w.items.some((it) => it.k === "tx" && it.text === "alice on the mic"));
  // the line's author: own
  const mine = (await hist(U.alice)).d.items.filter((it) => it.own);
  assert.ok(mine.length > 10 && mine.every((it) => it.u.login === "alicecf"), "alice's own lines are flagged for the line menu");
});

test("a member under a 24 h window stops at the window (reason window); presence older than 24 h is left out - with a window and without one; the owner and a mod read further", async () => {
  await ready();
  const m = await walkBack(U.mem, WSLUG);
  assert.ok(m.items.length > 0);
  assert.ok(m.items.every((it) => Number(it.ts) >= T0 - 24 * H - 60e3), "nothing older than the window");
  assert.equal(m.last.more_before, false);
  assert.equal(m.last.floor.reason, "window", "Earlier messages aren't shown on this pad.");
  assert.ok(!m.items.some((it) => it.k === "join" && it.u && it.u.login === "carolcf"), "a 30 h old join is left out for a member");
  assert.ok(m.items.some((it) => it.k === "join" && it.u && it.u.login === "bobcf"), "a 2 h old join shows");
  const o = await walkBack(U.own, WSLUG);
  assert.equal(o.items.filter((it) => it.k === "msg").length, 80, "the owner reads past the window");
  assert.equal(o.last.floor.reason, "start");
  assert.ok(o.items.some((it) => it.k === "join" && it.u && it.u.login === "carolcf"));
  const md = await walkBack(U.mod, WSLUG);
  assert.equal(md.items.filter((it) => it.k === "msg").length, 80, "a mod: 7 days past the window");
  assert.ok(!md.items.some((it) => it.k === "join" && it.u && it.u.login === "carolcf"), "...presence 24 h");
  // sys=0: no presence at all
  const ns = await hist(U.own, "sys=0", WSLUG);
  assert.ok(!ns.d.items.some((it) => PRESENCE.includes(it.k)));
  // CL8 fix-up (review P1): a pad with NO window - the member reads every chat line back to the start, but presence only 24 h
  const nw = await walkBack(U.mem);
  assert.equal(nw.last.floor.reason, "start");
  assert.ok(nw.items.some((it) => it.text === "filler 0"), "every chat line");
  assert.ok(!nw.items.some((it) => PRESENCE.includes(it.k) && Number(it.ts) < Date.now() - 24 * H), "no presence line older than 24 h");
  assert.ok(nw.items.some((it) => it.k === "join" && it.u && it.u.login === "bobcf"), "the 2 h old join shows");
  const ow = await walkBack(U.own);
  assert.ok(ow.items.some((it) => it.k === "join" && it.u && it.u.login === "carolcf"), "the owner has full history: the 44 h old join");
});

test("after= / around= / at=: edges, the flags, the target - a line 1,000 back opens around it", async () => {
  await ready();
  const c500 = await cOf("filler 500");
  let r = await hist(U.mem, "after=" + c500 + "&limit=10");
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(r.d.items.length, 10);
  assert.ok(r.d.items.every((it) => Number(it.c) > c500) && ascending(r.d.items));
  assert.equal(r.d.items[0].text, "filler 501");
  assert.deepEqual([r.d.more_before, r.d.more_after], [true, true]);
  const newest = (await hist(U.mem)).d.items.slice(-1)[0].c;
  r = await hist(U.mem, "after=" + newest);
  assert.deepEqual([r.d.items.length, r.d.more_before, r.d.more_after], [0, true, false]);
  // around a line 1,000 lines back (a 🔔 mention link): the line, half before, half after
  const c100 = await cOf("filler 100");
  r = await hist(U.mem, "around=" + c100 + "&limit=9");
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(r.d.target, c100);
  assert.deepEqual(r.d.items.map((it) => it.text), ["filler 96", "filler 97", "filler 98", "filler 99", "filler 100", "filler 101", "filler 102", "filler 103", "filler 104"]);
  assert.deepEqual([r.d.more_before, r.d.more_after], [true, true]);
  // the very first line: nothing before
  const c0 = await cOf("filler 0");
  r = await hist(U.mem, "around=" + c0 + "&limit=4");
  assert.deepEqual(r.d.items.map((it) => it.text), ["filler 0", "filler 1", "filler 2"]);
  assert.equal(r.d.more_before, false);
  assert.equal(r.d.floor.reason, "start");
  // at= a time: the first line at or after it; past the newest line: around the newest
  const t300 = Number((await getQuery("SELECT ts FROM chat_log WHERE text = 'filler 300'"))[0].ts);
  r = await hist(U.mem, "at=" + t300 + "&limit=5");
  assert.equal(r.d.target, await cOf("filler 300"));
  assert.ok(r.d.items.some((it) => it.text === "filler 300"));
  r = await hist(U.mem, "at=" + encodeURIComponent(new Date(t300).toISOString()) + "&limit=5");
  assert.equal(r.d.target, await cOf("filler 300"), "ISO-8601 too");
  r = await hist(U.mem, "at=" + (Date.now() + D) + "&limit=3");
  assert.equal(r.d.target, newest, "after the newest line: around it");
  assert.equal(r.d.more_after, false);
  // at= before a member's window: the first line they may see
  const wFirst = (await walkBack(U.mem, WSLUG)).items[0];
  r = await hist(U.mem, "at=" + (T0 - 39 * H) + "&limit=3", WSLUG);
  assert.equal(r.d.target, wFirst.c, "clamped to the viewer's floor");
  // limit bounds
  assert.equal((await hist(U.mem, "limit=500")).d.items.length, 100);
  assert.equal((await hist(U.mem, "limit=0")).d.items.length, 1);
});

test("one not_found for every line a member can't see; the owner and mods get a reason - never one that tells a hidden person's line or another room's from no line", async () => {
  await ready();
  const golf = await cOf("golf other room");
  const below = (await getQuery("SELECT c FROM chat_log WHERE text = 'win 0'"))[0].c;
  const ancient = await cOf("reason ancient 1");                       // past the standard tier's 30 days: below everyone's floor
  const rmC = await cOf("filler 1000");
  const danC = await cOf("dan early words");
  await hist(U.mod);                                                    // the mod's caps arrive (padmod.noteViewer)
  CV._clearCaches();
  await runQuery("UPDATE chat_log SET rm_at = ?, rm_by = ?, rm_why = ? WHERE c = ?", [Date.now(), "mod:" + U.own.userId, "spam", rmC]);
  await CL.hideNow(["dancf"], "pepe", "bridge");
  CV._clearCaches();
  try {
    const want = { ok: false, error: "That line isn't available.", code: "not_found" };
    const cases = [[SLUG, golf], [WSLUG, below], [SLUG, rmC], [SLUG, 987654321], [SLUG, "abc"], [SLUG, danC], [RNSLUG, ancient]];
    for (const [slug, c] of cases) {
      const r = await hist(U.mem, "around=" + c, slug);
      assert.equal(r.status, 404, slug + " " + c);
      assert.deepEqual(r.d, want, "one answer for every case: " + c);
    }
    const why = async (user, c, slug = SLUG) => { const r = await hist(user, "around=" + c, slug); assert.equal(r.status, 404, `${user.username} ${c}: ${r.text.slice(0, 120)}`); return r.d.why; };
    // CL8 fix-up (review P4): another room's line, a hidden person's line and none at all answer alike - no_line
    for (const viewer of [U.own, U.mod, U.staff]) {
      assert.equal(await why(viewer, golf), "no_line", viewer.username + ": another room's line is no line");
      assert.equal(await why(viewer, danC), "no_line", viewer.username + ": a hidden person's line is no line (never 'privacy')");
      assert.equal(await why(viewer, 987654321), "no_line");
      assert.equal(await why(viewer, ancient, RNSLUG), "floor", viewer.username + ": below the floor");
    }
    assert.equal(await why(U.mod, rmC), "removed", "a mod: a removed line");
    // a mod stepping through the cursors around a hidden line learns nothing but this room's lines and the gaps every pad has
    const steps = [];
    for (let c = danC - 2; c <= danC + 3; c++) { const r = await hist(U.mod, "around=" + c + "&limit=1"); steps.push(r.status === 200 ? "ok" : r.d.why); }
    assert.ok(steps.every((s) => s === "ok" || WHYS.has(s)), JSON.stringify(steps));
    assert.ok(!steps.includes("privacy") && !steps.includes("other_room"));
    // the owner sees the removed line as a muted row, with who hid it
    const r = await hist(U.own, "around=" + rmC + "&limit=3");
    assert.equal(r.status, 200, r.text.slice(0, 200));
    const it = r.d.items.find((x) => Number(x.c) === rmC);
    assert.deepEqual(it.removed, { at: it.removed.at, by: "mod", why: "spam", who: "own" });
    assert.equal(it.text, "filler 1000", "the appeal copy (30 days)");
    // members never get it
    const page = await hist(U.mem, "around=" + (rmC - 1) + "&limit=5");
    assert.ok(!page.d.items.some((x) => Number(x.c) === rmC));
    assert.ok(!page.text.includes("filler 1000"));
  } finally {
    await runQuery("UPDATE chat_log SET rm_at = NULL, rm_by = NULL, rm_why = NULL WHERE c = ?", [rmC]);
    await shown("dancf", "bridge");
  }
});

test("the golden leak test: a hidden person's login and display names appear nowhere in /history (JSON, rendered text and attributes)", async () => {
  await ready();
  const shyC = await cOf("shy secret words");
  // the owner's decision-9 change: INCOGNITO (a website ON: incognito only) - their line stays, as "someone": no name, look or login
  await CL.hideNow(["shycf"], "web");
  await CV.refreshNames();
  CV._clearCaches();
  const names = ["shycf", "Shy Violet"];
  for (const viewer of [U.mem, U.own, U.mod, U.staff]) {
    const w = await walkBack(viewer);
    const json = JSON.stringify(w.pages);
    for (const leak of names) {
      const at = json.indexOf(leak);
      assert.ok(at < 0, `${leak} leaked to ${viewer.username}: ...${json.slice(Math.max(0, at - 120), at + 40)}...`);
    }
    const html = w.items.map((it) => String(CORE.renderItem(it, { t: null, lang: "en" }, CORE.htmlH) || "")).join("\n");
    for (const leak of names) assert.ok(!html.toLowerCase().includes(leak.toLowerCase()), `${leak} in the rendered lines for ${viewer.username}`);
    assert.ok(w.items.some((it) => it.text === "hey someone and someone, look"), "redacted in other people's lines");
    const line = w.items.find((it) => Number(it.c) === shyC);
    assert.ok(line, "incognito: their line is shown, for " + viewer.username);
    assert.equal(line.text, "shy secret words", "...with their words");
    assert.deepEqual(line.u, { anon: true, display: "someone" }, "...as someone: no login, display, avatar, looks or flair");
    // around their line: it opens like any line
    const r = await hist(viewer, "around=" + shyC + "&limit=3");
    assert.equal(r.status, 200);
    assert.deepEqual(r.d.items.find((it) => Number(it.c) === shyC).u, { anon: true, display: "someone" });
    for (const leak of names) assert.ok(!r.text.includes(leak), leak + " around their line");
  }
  // ...and !bridge hide on top: LEFT OUT, never "someone"
  await CL.hideNow(["shycf"], "pepe", "bridge");
  await CV.refreshNames();
  CV._clearCaches();
  for (const viewer of [U.mem, U.own, U.mod, U.staff]) {
    const w = await walkBack(viewer);
    const json = JSON.stringify(w.pages);
    for (const leak of [...names, "shy secret words"]) assert.ok(json.indexOf(leak) < 0, `${leak} leaked to ${viewer.username}`);
    assert.ok(!w.items.some((it) => Number(it.c) === shyC), "left out, never 'someone'");
    // around their line: one not_found (exempt viewers: no_line - CL8 fix-up, never "privacy")
    const r = await hist(viewer, "around=" + shyC);
    assert.equal(r.status, 404);
    if (viewer === U.mem) assert.equal(r.d.why, undefined);
    else assert.equal(r.d.why, "no_line");
  }
  // !bridge show: incognito still - "someone" again; un-hidden by Pepe: back by name (and the page around it works)
  await shown("shycf", "bridge");
  const anon = await hist(U.mem, "around=" + shyC + "&limit=3");
  assert.equal(anon.status, 200);
  assert.deepEqual(anon.d.items.find((it) => Number(it.c) === shyC).u, { anon: true, display: "someone" });
  await shown("shycf", "incognito");
  const back = await hist(U.mem, "around=" + shyC + "&limit=3");
  assert.equal(back.status, 200);
  assert.ok(back.d.items.some((it) => it.text === "shy secret words" && it.u && it.u.login === "shycf"));
});

test("the golden leak test, extended (§3.15): a hidden person's presence and 🎙 lines, !transcripts off, a common-word display name - in /history, /history/check, /history/state and /live", async () => {
  await ready();
  const shyCs = (await getQuery("SELECT c FROM chat_log WHERE who = 'shycf' AND rk = ?", [await rkOf(LEAK)])).map((r) => Number(r.c));
  const loveCs = (await getQuery("SELECT c FROM chat_log WHERE who = 'lovecf'")).map((r) => Number(r.c));
  const texTx = await cOf("tex transcript words"), texMsg = await cOf("tex chat words");
  assert.equal(shyCs.length, 5, "join, mic, 🎙, unmic, chat");
  assert.equal(loveCs.length, 2, "join, chat");
  await CL.hideNow(["shycf"], "pepe", "bridge");
  await CL.hideNow(["lovecf"], "pepe", "bridge");
  await CL.hideNow(["texcf"], "pepe", "tx");
  await CV.refreshNames();
  CV._clearCaches();
  try {
    assert.ok(CH.hiddenLogins().out.includes("shycf") && CH.hiddenLogins().out.includes("lovecf"), "left out in SQL too");
    assert.ok(CH.hiddenLogins().tx.includes("texcf") && !CH.hiddenLogins().out.includes("texcf"), "!transcripts off: only their 🎙 lines");
    const leaks = ["shycf", "Shy Violet", "shy secret words two", "shy mic words", "lovecf", "love own words", "tex transcript words"];
    const noLeak = (s, who, where) => { for (const l of leaks) { const at = s.indexOf(l); assert.ok(at < 0, `${l} leaked to ${who} (${where}): ...${s.slice(Math.max(0, at - 100), at + 40)}...`); } };
    for (const viewer of [U.mem, U.own, U.mod, U.staff]) {
      const w = await walkBack(viewer, LSLUG);
      noLeak(JSON.stringify(w.pages), viewer.username, "/history JSON");
      const html = w.items.map((it) => String(CORE.renderItem(it, { t: null, lang: "en" }, CORE.htmlH) || "")).join("\n");
      noLeak(html, viewer.username, "rendered text and attributes");
      assert.ok(!w.items.some((it) => shyCs.includes(Number(it.c)) || loveCs.includes(Number(it.c))), "their presence, 🎙 and chat lines: left out");
      assert.ok(!w.items.some((it) => it.u && it.u.display === "Love"), "no line is theirs");
      assert.ok(!/data-name="Love"/i.test(html) && !/title="Love/i.test(html), "nothing names them in an attribute");
      assert.ok(w.items.some((it) => it.text === "hey someone"), "a hidden name redacted in others' lines");
      assert.ok(w.items.some((it) => it.text === "hi someone and Love"), "the login redacted; the stop-listed common word stays");
      assert.ok(w.items.some((it) => it.text === "I love this song"), "the stop-list: a common word is never redacted");
      assert.ok(!w.items.some((it) => Number(it.c) === texTx), "!transcripts off: their 🎙 line is left out");
      assert.ok(w.items.some((it) => Number(it.c) === texMsg && it.u.login === "texcf"), "...their chat lines stay");
      assert.ok(w.items.some((it) => it.text === "hey Tex Mic"), "...and their name isn't redacted");
      // what a page holding those lines learns when it checks them again: they're gone - and nothing else about them
      const k = await check(viewer, [...shyCs, ...loveCs, texTx, texMsg], LSLUG);
      assert.equal(k.status, 200, k.text.slice(0, 200));
      assert.deepEqual(k.d.gone.slice().sort((a, b) => a - b), [...shyCs, ...loveCs, texTx].sort((a, b) => a - b));
      noLeak(k.text, viewer.username, "/history/check");
      noLeak((await state(viewer, LSLUG)).text, viewer.username, "/history/state");
      noLeak((await get(`/api/rooms/${LSLUG}/live`, viewer)).text, viewer.username, "/live");
      for (const c of [...shyCs, ...loveCs, texTx]) {
        const r = await hist(viewer, "around=" + c, LSLUG);
        assert.equal(r.status, 404);
        assert.ok(r.d.why === undefined || r.d.why === "no_line", viewer.username + " " + r.d.why);
      }
    }
  } finally {
    await shown("shycf", "bridge");
    await shown("lovecf", "bridge");
    await shown("texcf", "tx");
  }
  assert.equal((await hist(U.mem, "around=" + texTx, LSLUG)).status, 200, "!transcripts on: back");
});

test("limits: a page never takes more than the day has left; refusals count; a plain mod is limited - the owner, staff and a mods_all mod aren't", async () => {
  await ready();
  assert.equal(CH.PER_MIN, 60);
  assert.equal(CH.DAY_ITEMS, 20000);
  assert.equal(CH.PAGE, 50);
  CH._setLimits({ dayItems: 120 });
  for (let i = 0; i < 2; i++) assert.equal((await hist(U.mem2)).status, 200, "page " + i);
  let r = await hist(U.mem2);
  assert.equal(r.status, 200);
  assert.equal(r.d.items.length, 20, "the day's last 20 - never a full page past the cap (review P8)");
  r = await hist(U.mem2);
  assert.equal(r.status, 429);
  assert.equal(r.d.code, "daily");
  assert.equal(CH._day(U.mem2.userId), 120, "exactly the cap");
  for (let i = 0; i < 5; i++) assert.equal((await hist(U.own)).status, 200, "the owner has full history: no cap");
  // a refused request gives its reservation back; one that served fewer lines than asked gives the rest back
  CH._reset();
  CH._setLimits({ dayItems: 120 });
  assert.equal((await hist(U.mem2, "around=987654321")).status, 404);
  assert.equal(CH._day(U.mem2.userId), 0);
  assert.equal((await hist(U.mem2, "after=" + (await cOf("filler 1098")) + "&limit=100")).d.items.length, 1);
  assert.equal(CH._day(U.mem2.userId), 1);
  // refusals count as requests: 403s (an 18+ pad without the age confirmation) run out the minute's 60 too
  CH._reset();
  CH._setLimits({ perMin: 2 });
  await runQuery("UPDATE rooms_registry SET adult = 1 WHERE room_id = ?", [ROOM.id]);
  await rooms.loadCache();
  CV._setAttested(() => false);
  CV._clearCaches();
  try {
    assert.equal((await hist(U.mem3)).status, 403);
    assert.equal((await hist(U.mem3)).status, 403);
    r = await hist(U.mem3);
    assert.equal(r.status, 429, "the third in a minute");
    assert.equal(r.d.code, "rate");
  } finally {
    await runQuery("UPDATE rooms_registry SET adult = 0 WHERE room_id = ?", [ROOM.id]);
    await rooms.loadCache();
    CV._setAttested(null);
  }
  CH._reset();
  CH._setLimits({ perMin: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await hist(U.mem)).status, 200);
  r = await hist(U.mem);
  assert.equal(r.status, 429);
  assert.equal(r.d.code, "rate");
  assert.ok(Number(r.headers["retry-after"]) >= 1);
  // CL8 fix-up (review P4): a plain mod reads 7 days past the window - not full history: limited like a member
  await hist(U.mod, "", GSLUG);                                        // the mod's caps arrive
  CH._reset();
  CV._clearCaches();
  CH._setLimits({ perMin: 2 });
  assert.equal((await hist(U.mod, "", GSLUG)).status, 200);
  assert.equal((await hist(U.mod, "", GSLUG)).status, 200);
  assert.equal((await hist(U.mod, "around=987654321", GSLUG)).status, 429, "a mod's deep-link probes are limited too");
  // ... while "Room mods can read all history" gives them full history: no limit
  await PC.save(U.own, { id: GATE.id }, { mods_all: true });
  CH._reset();
  CV._clearCaches();
  CH._setLimits({ perMin: 2 });
  try {
    for (let i = 0; i < 4; i++) assert.equal((await hist(U.mod, "", GSLUG)).status, 200, "mods_all: no limit");
    for (let i = 0; i < 4; i++) assert.equal((await hist(U.staff, "", GSLUG)).status, 200, "staff: no limit");
  } finally { await PC.save(U.own, { id: GATE.id }, { mods_all: false }); CH._reset(); }
  // /history/state and /history/check have a bucket of their own: reading back fast never starves an open page's re-check
  assert.equal(CH.AUX_PER_MIN, 20);
  CH._setLimits({ perMin: 1, auxPerMin: 2 });
  try {
    assert.equal((await hist(U.mem3)).status, 200);
    assert.equal((await hist(U.mem3)).status, 429);
    assert.equal((await check(U.mem3, [await cOf("filler 5")])).status, 200, "the re-check still runs");
    assert.equal((await state(U.mem3)).status, 200);
    assert.equal((await check(U.mem3, [1])).status, 429, "...limited on its own (20 a minute; 2 here)");
  } finally { CH._reset(); }
});

test("staff reads below the public floor are audited (chatlog_views, kind history): one row per 10 minutes covering every span read; presence older than 24 h too", async () => {
  await ready();
  await runQuery("DELETE FROM chatlog_views WHERE user_id = ?", [U.staff.userId]);
  const w = await walkBack(U.staff, WSLUG);
  assert.equal(w.items.filter((it) => it.k === "msg").length, 80, "chatlog.read_all: back to retention");
  await new Promise((r) => setTimeout(r, 80));
  const rows = await getQuery("SELECT * FROM chatlog_views WHERE user_id = ? AND kind = 'history'", [U.staff.userId]);
  assert.equal(rows.length, 1, "one coalesced row");
  assert.equal(Number(rows[0].rk), await rkOf(WIN));
  // CL8 fix-up (review): the row covers every page read in its 10 minutes - back to the oldest line, not just the first page's
  const win0 = Number((await getQuery("SELECT ts FROM chat_log WHERE text = 'win 0'"))[0].ts);
  assert.equal(Number(rows[0].from_ts), win0, "widened to the oldest line read");
  const pub = Date.now() - 24 * H;
  const newestBelow = Math.max(...w.items.filter((it) => Number(it.ts) < pub).map((it) => Number(it.ts)));
  assert.equal(Number(rows[0].to_ts), newestBelow, "...and the newest one below the public floor");
  // inside the window: nothing more to log
  await hist(U.staff, "", WSLUG);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chatlog_views WHERE user_id = ?", [U.staff.userId]))[0].n, 1);
  // a member's reads are never audited
  await walkBack(U.mem, WSLUG);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chatlog_views WHERE user_id = ?", [U.mem.userId]))[0].n, 0);
  // CL8 fix-up (review P6): a pad with no window - staff reading a join older than 24 h is a read below the public floor too
  await runQuery("DELETE FROM chatlog_views WHERE user_id = ?", [U.staff.userId]);
  CV._caches.audit.clear();
  const nw = await walkBack(U.staff);
  const old = nw.items.filter((it) => PRESENCE.includes(it.k) && Number(it.ts) < Date.now() - 24 * H);
  assert.ok(old.length >= 1, "staff read the 44 h old join");
  await new Promise((r) => setTimeout(r, 80));
  const pr = await getQuery("SELECT * FROM chatlog_views WHERE user_id = ? AND kind = 'history' AND rk = ?", [U.staff.userId, await rkOf(ROOM)]);
  assert.equal(pr.length, 1, "audited");
  assert.equal(Number(pr[0].from_ts), Math.min(...old.map((it) => Number(it.ts))));
});

test("the scan budget: a hidden person's long run is left out in SQL (no empty page that still says more); a run the SQL can't see hands out a SEALED position", async () => {
  await ready();
  // (the owner's decision-9 change: LEFT OUT = !bridge hide; an incognito person's run would be shown, as "someone")
  await CL.hideNow(["shycf"], "pepe", "bridge");
  CV._clearCaches();
  CH._setLimits({ scanMax: 40 });
  const want = Array.from({ length: 20 }, (_, i) => "run ok " + i).concat(Array.from({ length: 20 }, (_, i) => "run ok " + (160 + i)));
  const shyCs = (await getQuery("SELECT c FROM chat_log WHERE who = 'shycf'")).map((r) => Number(r.c));
  try {
    assert.ok(CH.hiddenLogins().out.includes("shycf"), "the who map knows their login: the SQL skips their rows");
    let w = await walkBack(U.mem, RSLUG);
    assert.deepEqual(w.items.map((it) => it.text), want);
    assert.ok(!w.pages.some((p) => p.next_before), "nothing ran out of its budget");
    assert.ok(w.pages.every((p) => p.items.length > 0 || !p.more_before), "no empty page that still says more (review P9)");
    // a run the SQL can't see (a login the who map doesn't know): the projection drops it and the budget runs out
    const h = CL.hash("shycf"), saved = CV._who.get(h);
    CV._who.delete(h);
    CH._reset();
    CH._setLimits({ scanMax: 40 });
    try {
      assert.ok(!CH.hiddenLogins().out.includes("shycf"));
      w = await walkBack(U.mem, RSLUG);
      assert.deepEqual(w.items.map((it) => it.text), want, "nothing dropped");
      assert.ok(!JSON.stringify(w.pages).includes("run shy"));
      const toks = w.pages.map((p) => p.next_before).filter(Boolean);
      assert.ok(toks.length, "a page ran out of its scan budget and handed out a position");
      for (const tok of toks) {
        assert.match(tok, /^h1\.[A-Za-z0-9_-]{82}$/, "sealed, one length");
        // review P2: the position sits on a dropped (hidden) row - and the token doesn't say so
        const c = CH.openPos(tok, RUN.id, U.mem.userId, "b");
        assert.ok(shyCs.includes(c), "it does point into the hidden run");
        const bytes = Buffer.from(tok.slice(3), "base64url").toString("latin1");
        assert.ok(!bytes.includes(String(c)) && !tok.includes(String(c)), "...but never names it");
      }
      const tok = toks[0];
      // only this room, this viewer, this direction, within the hour; never forged
      const forged = tok.slice(0, -2) + (tok.slice(-2) === "AA" ? "BB" : "AA");
      for (const [user, q, slug] of [[U.mem, "before=" + forged, RSLUG], [U.mem, "after=" + tok, RSLUG], [U.mem, "before=" + tok, SLUG], [U.mem2, "before=" + tok, RSLUG],
                                     [U.mem, "before=p1.b." + shyCs[0] + ".AAAAAAAAAAAAAAAAAAAAAA", RSLUG]]) {
        const r = await hist(user, q, slug);
        assert.equal(r.status, 400, user.username + " " + q.slice(0, 40));
        assert.equal(r.d.code, "bad_cursor");
      }
      assert.throws(() => CH.openPos(tok, RUN.id, U.mem.userId, "b", Date.now() + 2 * H), (e) => e.code === "bad_cursor", "expired after an hour");
      assert.equal(CH.openPos(CH.sealPos(RUN.id, "u1", 77, "b"), RUN.id, "u1", "b"), 77);
      assert.equal(CH.sealPos(RUN.id, "u1", 1, "a").length, CH.sealPos(RUN.id, "u1", 999999999999, "a").length, "the length says nothing about the cursor");
      assert.notEqual(CH.sealPos(RUN.id, "u1", 77, "b"), CH.sealPos(RUN.id, "u1", 77, "b"), "a fresh IV every time");
    } finally { CV._who.set(h, saved); CH._reset(); }
    // a plain before= (spec §3.5) - even a hidden line's own c - is only a bound: the page shows nothing the viewer may not see
    const r = await hist(U.mem, "before=" + shyCs[70], RSLUG);
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes("run shy") && !r.text.includes("shycf"));
    assert.deepEqual(r.d.items.map((it) => it.text), want.slice(0, 20));
  } finally { CH._reset(); await shown("shycf", "bridge"); await shown("shycf", "incognito"); }
});

test("the gates on /history and the offline card: an Approved pad's non-member, a whole-bridge block, a feed ban, the 💎 gate (the owner and staff keep it)", async () => {
  await ready();
  const PA = require(path.join(repo, "padaccess"));
  // the 💎 gate (decision 24): members lose history; the owner and staff keep it - and the pad page's 📜 card under the upsell
  const P = require(path.join(repo, "premium"));
  const real = P.bridgeAllowed;
  P.bridgeAllowed = (id) => (String(id) === GATE.id ? false : real(id));
  CV._clearCaches();
  try {
    assert.equal((await hist(U.mem, "", GSLUG)).status, 403);
    assert.equal((await hist(U.own, "", GSLUG)).status, 200);
    assert.equal((await hist(U.staff, "", GSLUG)).status, 200);
    const page = async (user) => (await get("/p/" + GSLUG, user)).text;
    assert.ok(!(await page(U.mem)).includes('id="rmHistCard"'), "a member: no card");
    assert.ok((await page(U.own)).includes('id="rmHistCard"'), "the owner: the card under the 💎 upsell (test gap 2)");
    assert.ok((await page(U.staff)).includes('id="rmHistCard"'), "staff too");
  } finally { P.bridgeAllowed = real; CV._clearCaches(); }
  // Pepe leaves the room: blocked / banned viewers get neither /history nor the offline card
  await bridge.ingest({ rooms: [], events: [], closed: [GATE.id] });
  assert.ok((await get("/p/" + GSLUG, U.mem2)).text.includes('id="rmHistCard"'), "before the block: the card");
  await require(path.join(repo, "bridgeblocks")).init();
  await runQuery("INSERT INTO bridge_blocks (room_id, user_id, feature, username, reason, created, until, updated) VALUES (?, ?, 'all', 'mem2', '', ?, NULL, ?)",
                 [GATE.id, U.mem2.userId, Date.now(), Date.now()]).catch(async () => {
    await runQuery("INSERT INTO bridge_blocks (room_id, user_id, feature, username, reason, created, until) VALUES (?, ?, 'all', 'mem2', '', ?, NULL)", [GATE.id, U.mem2.userId, Date.now()]);
  });
  CV._clearCaches();
  try {
    const r = await hist(U.mem2, "", GSLUG);
    assert.equal(r.status, 403, "blocked from the whole bridge");
    assert.equal(r.d.code, "no_history");
    assert.ok(!(await get("/p/" + GSLUG, U.mem2)).text.includes('id="rmHistCard"'), "no card");
    assert.equal((await state(U.mem2, GSLUG)).d.history.scroll, false, "an open card learns it at its next poll");
  } finally { await runQuery("DELETE FROM bridge_blocks WHERE user_id = ?", [U.mem2.userId]); CV._clearCaches(); }
  await runQuery("CREATE TABLE IF NOT EXISTS feed_bans (user_id TEXT, room_id TEXT, username TEXT, reason TEXT, by TEXT, at INTEGER, until INTEGER)");
  await runQuery("INSERT INTO feed_bans (user_id, room_id, at, until) VALUES (?, ?, ?, NULL)", [U.mem2.userId, GATE.id, Date.now()]);
  CV._clearCaches();
  try {
    assert.equal((await hist(U.mem2, "", GSLUG)).status, 403, "banned from the pad's feed");
    assert.ok(!(await get("/p/" + GSLUG, U.mem2)).text.includes('id="rmHistCard"'), "no card");
  } finally { await runQuery("DELETE FROM feed_bans WHERE user_id = ?", [U.mem2.userId]); CV._clearCaches(); }
  assert.ok((await get("/p/" + GSLUG, U.mem2)).text.includes('id="rmHistCard"'), "unblocked: the card again");
  // an Approved pad: a non-member gets the one not_found and no card (review P10 / test gap 1) - last: opening it up again
  // keeps the earlier lines from people who aren't approved members (aud_m, forward only)
  await PA.setLevel(U.own, { id: GATE.id }, "approved");
  CV._clearCaches();
  try {
    const r = await hist(U.mem, "", GSLUG);
    assert.equal(r.status, 404);
    assert.equal(r.d.code, "not_found");
    assert.equal((await state(U.mem, GSLUG)).status, 404);
    assert.equal((await check(U.mem, [await cOf("gate 1")], GSLUG)).status, 404);
    assert.ok(!(await get("/p/" + GSLUG, U.mem)).text.includes('id="rmHistCard"'), "no card");
    assert.equal((await hist(U.own, "", GSLUG)).status, 200);
  } finally { await PA.setLevel(U.own, { id: GATE.id }, "members"); CV._clearCaches(); }
  const after = await walkBack(U.mem, GSLUG);
  assert.ok(!after.items.some((it) => /^gate \d$/.test(it.text || "")), "Approved -> Members: the earlier lines stay out for a non-member");
  assert.ok(!(await get("/p/" + GSLUG, U.mem)).text.includes('id="rmHistCard"'), "...so nothing to show: no card");
});

test("the floor reasons: retention (the tier's 30 days), earlier (a widened window - forward only), off; start when nothing is older", async () => {
  await ready();
  // retention: the standard tier keeps chat 30 days - the 40-day-old lines are past it, for everyone
  for (const viewer of [U.mem, U.own, U.staff]) {
    const w = await walkBack(viewer, RNSLUG);
    assert.equal(w.last.floor.reason, "retention", viewer.username);
    assert.ok(!w.items.some((it) => /ancient/.test(it.text || "")), viewer.username);
    assert.ok(w.items.some((it) => it.text === "reason recent 0"));
  }
  // earlier: 1 hour, then Everything - the lines that had left public view stay out (forward only)
  await PC.save(U.own, { id: RSN.id }, { window_s: 3600 });
  await CV.view(RSN.id, U.mem);
  await PC.save(U.own, { id: RSN.id }, { window_s: null });
  CV._clearCaches();
  let w = await walkBack(U.mem, RNSLUG);
  assert.equal(w.last.floor.reason, "earlier", "Earlier messages aren't shown on this pad.");
  assert.ok(!w.items.some((it) => /reason recent/.test(it.text || "")), "said 3 h ago, under a 1 h window: still out");
  // off
  await PC.save(U.own, { id: RSN.id }, { window_s: 0 });
  CV._clearCaches();
  const r = await hist(U.mem, "", RNSLUG);
  assert.equal(r.status, 200);
  assert.equal(r.d.floor.reason, "off");
  assert.ok(!r.d.items.some((it) => /reason/.test(it.text || "")));
  // the owner of a pad under "Off" still reads back; nothing older than the archive's first line: start
  w = await walkBack(U.own, WSLUG);
  assert.equal(w.last.floor.reason, "start");
});

test("open pages: the privacy digest moves on a hide and a takedown; /history/check drops what's gone and re-dresses what changed", async () => {
  await ready();
  const danC = await cOf("dan early words"), sayC = await cOf("say hi to Dan Quiet"), f40 = await cOf("filler 40");
  const pv0 = (await state(U.mem)).d.history.pv;
  assert.match(pv0, /^[A-Za-z0-9_-]{12}$/, "an opaque digest");
  const live0 = (await get(`/api/rooms/${SLUG}/live`, U.mem)).d;
  assert.equal(live0.history.pv, pv0, "the live answer carries the same digest");
  // nothing changed: nothing to do
  let k = await check(U.mem, [danC, sayC, f40]);
  assert.equal(k.status, 200, k.text.slice(0, 200));
  assert.deepEqual([k.d.gone, k.d.redo], [[], []]);
  // dan becomes hidden: his archived line is long out of the live tail (review P5) - the digest moves, the check drops it
  await CL.hideNow(["dancf"], "pepe", "bridge");
  await CV.refreshNames();
  CV._clearCaches();
  try {
    const pv1 = (await state(U.mem)).d.history.pv;
    assert.notEqual(pv1, pv0, "a hide moves every pad's digest");
    assert.equal((await get(`/api/rooms/${SLUG}/live?after=1`, U.mem)).d.history.pv, pv1);
    k = await check(U.mem, [danC, sayC, f40, 987654321, await cOf("golf other room")]);
    assert.deepEqual(k.d.gone.slice().sort((a, b) => a - b), [danC, 987654321, await cOf("golf other room")].sort((a, b) => a - b),
                     "dan's line goes; an unknown or another room's c is 'gone' too (nothing told apart)");
    assert.deepEqual(k.d.redo.map((it) => [Number(it.c), it.text]), [[sayC, "say hi to someone"]], "a name redacted since: drawn again");
    assert.ok(!k.text.includes("dancf") && !k.text.includes("Dan Quiet") && !k.text.includes("dan early words"));
    assert.equal(k.d.history.pv, pv1);
    // redone lines count toward the day's items; past what's left they go (never shown un-redacted)
    CH._setLimits({ dayItems: 1 });
    await hist(U.mem2, "limit=1");
    k = await check(U.mem2, [sayC, f40]);
    assert.deepEqual([k.d.gone, k.d.redo], [[sayC], []]);
    CH._reset();
  } finally { await shown("dancf", "bridge"); }
  // a takedown of an archived line: that pad's digest moves; members drop it, the owner gets the muted row
  const pv2 = (await state(U.mem)).d.history.pv;
  const otherPv = (await state(U.mem, WSLUG)).d.history.pv;
  const hid = await call("POST", `/api/rooms/${SLUG}/chatlog/${f40}/hide`, U.own, { why: "spam" });
  assert.equal(hid.status, 200, hid.text.slice(0, 200));
  try {
    const pv3 = (await state(U.mem)).d.history.pv;
    assert.notEqual(pv3, pv2, "the pad's digest moved");
    assert.equal((await state(U.mem, WSLUG)).d.history.pv, otherPv, "another pad's didn't");
    assert.deepEqual((await check(U.mem, [f40, sayC])).d.gone, [f40]);
    const o = await check(U.own, [f40, sayC]);
    assert.deepEqual(o.d.gone, []);
    assert.equal(Number(o.d.redo[0].c), f40);
    assert.equal(o.d.redo[0].removed.by, "mod", "the owner's muted row");
  } finally { await call("POST", `/api/rooms/${SLUG}/chatlog/${f40}/unhide`, U.own, {}); }
  // the rules of the route: at most 3,000 lines, same-origin only
  assert.equal((await check(U.mem, Array.from({ length: 3001 }, (_, i) => i + 1))).status, 400);
  assert.equal((await check(U.mem, "nope")).status, 400);
  const x = await call("POST", `/api/rooms/${SLUG}/history/check`, U.mem, { cs: [f40] }, { "x-requested-with": "" });
  assert.equal(x.status, 403, "same-origin only");
});

test("the pad page: the live chat's scrollback hooks and the signed-out prompt; the offline 📜 Chat history card (not under 'Off')", async () => {
  await ready();
  let r = await get("/p/" + SLUG, U.mem);
  assert.equal(r.status, 200);
  for (const id of ['id="rmScroll"', 'id="rmHistTop"', 'id="rmOlder"', 'id="rmHistBot"', 'id="rmFeed" class="feed-log"', 'id="rmHistJump"']) assert.ok(r.text.includes(id), id);
  assert.match(r.text, /<script src="\/public\/js\/pad-history\.js\?v=\d+"><\/script>/);
  const init = JSON.parse(/<script id="rmInit" type="application\/json">([\s\S]*?)<\/script>/.exec(r.text)[1].replace(/\\u003c/g, "<"));
  assert.equal(init.history.scroll, true);
  assert.equal(init.history.signin, undefined);
  assert.match(String(init.history.pv), /^[A-Za-z0-9_-]{12}$/, "the privacy digest (CL8 fix-up)");
  // a Public pad, signed out: the live tail + "Sign in to scroll back"
  await require(path.join(repo, "padaccess")).setLevel(U.own, { id: ROOM.id }, "public");
  try {
    r = await get("/p/" + SLUG, null);
    const anon = JSON.parse(/<script id="rmInit" type="application\/json">([\s\S]*?)<\/script>/.exec(r.text)[1].replace(/\\u003c/g, "<"));
    assert.equal(anon.history.scroll, false);
    assert.equal(anon.history.signin, true);
    assert.equal((await hist(null)).status, 401, "still no signed-out history");
  } finally { await require(path.join(repo, "padaccess")).setLevel(U.own, { id: ROOM.id }, "members"); }
  // Pepe leaves Off.Room: the page keeps a read-only 📜 Chat history card
  await bridge.ingest({ rooms: [], events: [], closed: [OFF.id] });
  assert.ok(!bridge._rooms.has(OFF.id));
  r = await get("/p/" + OFSLUG, U.mem);
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('id="rmHistCard"'), "the offline card");
  assert.ok(!r.text.includes('id="rmFeed"'), "no live chat");
  const card = JSON.parse(/<script id="rmHistInit" type="application\/json">([\s\S]*?)<\/script>/.exec(r.text)[1].replace(/\\u003c/g, "<"));
  assert.equal(card.history.scroll, true);
  assert.ok(card.history.pv && card.history.v, "the digests the card polls (/history/state)");
  assert.match(r.text, /\/history\/state/, "...it polls them");
  const h = await hist(U.mem, "", OFSLUG);
  assert.equal(h.status, 200, "history works while the room is offline");
  assert.deepEqual(h.d.items.filter((it) => it.k === "msg").map((it) => it.text), ["said before the room closed", "the last line in the off room"]);
  assert.ok(!(await get("/p/" + OFSLUG, null)).text.includes('id="rmHistCard"'), "not signed out");
  await CL.setSwitch("history", false, "test");
  try { assert.ok(!(await get("/p/" + OFSLUG, U.mem)).text.includes('id="rmHistCard"'), "not while chatlog.history is off"); }
  finally { await CL.setSwitch("history", true, "test"); }
  // CL8 fix-up (review P7): under "Off" a member can see nothing earlier - no card; the owner still reads back
  await PC.save(U.own, { id: OFF.id }, { window_s: 0 });
  CV._clearCaches();
  try {
    assert.ok(!(await get("/p/" + OFSLUG, U.mem)).text.includes('id="rmHistCard"'), "a member under Off: no card");
    assert.ok((await get("/p/" + OFSLUG, U.own)).text.includes('id="rmHistCard"'), "the owner: the card");
  } finally { PC._reset(); await PC.save(U.own, { id: OFF.id }, { window_s: null }); }
});

test("the page query keeps its planned shape: chat_log_room with both c bounds, the floors and the hidden lists in a CASE, no scan", async () => {
  await ready();
  const rk = await rkOf(ROOM);
  const out = ["a1", "b2", "c3"], tx = ["t1"];
  for (const o of [{ dir: "before" }, { dir: "after" }, { dir: "before", sys: false, approved: false }, { dir: "after", keepRemoved: true },
                   { dir: "before", nOut: 3, nTx: 1 }, { dir: "after", nOut: 0, nTx: 1 }, { dir: "before", nOut: 3 }]) {
    const sql = CH.pageSql(o);
    assert.match(sql, /c >= \? AND c < \?/);
    assert.match(sql, /CASE WHEN k = 'tx' THEN c >= \? WHEN k IN \('join','leave','mic','unmic'\) THEN c >= \? ELSE c >= \? END/);
    assert.match(sql, /CASE WHEN who IS NULL THEN k NOT IN \('join','leave','mic','unmic'\)/, "Pepe's anonymised presence stand-ins");
    assert.doesNotMatch(sql, /\bOR\b/, "never an OR the planner could split into rowid ranges");
    const nOut = o.nOut || 0, nTx = o.nTx || 0;
    const hp = [...(nOut + nTx ? [...out.slice(0, nOut), ...tx.slice(0, nTx)] : []), ...out.slice(0, nOut)];
    assert.equal((sql.match(/\?/g) || []).length, 7 + hp.length, "every placeholder has its value");
    const plan = (await getQuery("EXPLAIN QUERY PLAN " + sql, [rk, 1, 1e15, 1, 1, 1, ...hp, 51])).map((r) => r.detail).join(" | ");
    assert.match(plan, /SEARCH chat_log USING INDEX chat_log_room \(rk=\? AND c>\? AND c<\?\)/, plan);
    assert.doesNotMatch(plan, /TEMP B-TREE/, "served in index order: " + plan);
  }
});

test("the browser side (CL8 fix-up): the 3,000-node cap holds while reading back, Back to live away from the bottom, the re-check on a privacy change, ds-note / ds-skel", () => {
  const src = fs.readFileSync(path.join(repo, "public", "js", "pad-history.js"), "utf8");
  // the cap: once the older lines are gone, the live log's oldest go too (attached) - the page never holds more than 3,000 nodes
  assert.match(src, /if \(mode === 'attached' && log\) while \(gone < n && log\.firstChild\)/);
  assert.match(src, /cap: function \(\) \{ if \(mode === 'attached' && total\(\) > CAP\) \{ dropTop\(total\(\) - CAP\);/);
  // Back to live away from the bottom, new lines or not
  assert.match(src, /if \(mode === 'attached' && !count\) \{[\s\S]{0,200}if \(atEnd\(\)\)[\s\S]{0,200}js\.pad\.chat\.back_live_0/);
  assert.match(src, /if \(mode === 'attached' && !count\) label\(\);/, "refreshed as the reader scrolls");
  // the re-check
  assert.match(src, /post\(api \+ '\/check', \{ cs: cs \}\)/);
  assert.match(src, /recheck: recheck,/);
  // the design system (spec §3.14): the end marker is a .ds-note, loading .ds-skel (+ the words for screen readers)
  assert.match(src, /el\('div', 'ds-note hist-end'\)/);
  assert.match(src, /el\('span', 'ds-skel'\)/);
  assert.match(src, /el\('span', 'ds-sr-only', text\)/);
  const room = fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8");
  // a check that keeps failing (offline, slow down) is tried again 3 times, then scrollback's lines go (fail closed)
  assert.match(src, /var RETRY_MS = \[5000, 20000, 60000\];/);
  assert.match(src, /return checked\(\{ gone: cs\.slice\(\), redo: \[\], failed: true \}\);/);
  assert.match(room, /else if \(hist && d\.history\.pv && d\.history\.pv !== hist\.pv\) safe\('recheck', recheckAll\);/);
  const wired = /extra: hitCs, onChecked: function \(r\) \{ if \(padSearch\) padSearch\.drop\(r\.gone\.concat\(r\.redo\)\); \} \}\)/;
  assert.match(room, wired, "the 🔍 results are re-checked with scrollback's lines");
  const card = fs.readFileSync(path.join(repo, "views", "partials", "pad-chat-history.ejs"), "utf8");
  assert.match(card, wired);
  assert.match(card, /'\/history\/state'/);
  assert.match(card, /setInterval\(poll, 60000\);/);
  assert.match(card, /h\.pv !== old\.pv\) padHist\.recheck\(\);/);
  const css = fs.readFileSync(path.join(repo, "public", "css", "chatlog.css"), "utf8");
  assert.match(css, /\.chatlog \.hist-end\.ds-note \{/);
  assert.match(css, /\[dir="rtl"\] \.chatlog \.sys\.hl \{ box-shadow: inset -3px 0 0 var\(--ds-chat-hl-bar\); \}/, "RTL: the bar by the start edge");
});
