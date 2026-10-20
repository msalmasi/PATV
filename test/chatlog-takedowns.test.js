// CL6 chatlogmod.js: takedowns and audit for the pad chat archive (the chat-history spec §2.6, §3.5 "Line actions", §3.15
// "Takedowns").
//   * the line menu: what /live offers each viewer (history.acts) and which lines are their own;
//   * ⚑ report: reasons, never your own line, one per reporter, the owner + the admins told (copyright / minor: admins only), 20 an
//     hour, the feed's bad-faith pause; a "minor" report hides the line at once (left out of /live, R.feed, bridge_feed and the
//     index; `removed` on the next poll) and the queue's Dismiss shows it again;
//   * one not_found for everything a member can't see (another room's line, a removed one, below the floor, none) - the owner
//     gets the reason; a permission refusal comes before any lookup (never an existence oracle);
//   * 🗑 remove my line (linked login or the u: key), 🙈 hide / ↩ unhide (owner, mods, staff; the 30-day window; who may undo
//     whose), the nightly pass blanking hidden lines after 30 days (a legal hold keeps them);
//   * ⛔ staff purge reaching every copy: chat_log + the index + counters, bridge_feed + R.feed, the quote that copied it, the
//     🔔 mention notice, Pepe's removed list in the owner sync; a hold refuses it;
//   * the per-login tool (look / export / hide_all / hold / purge_all), room holds, the owner's earlier era (owner_grant), the
//     staff read audit (chatlog_views) and the report queue's logged Read;
//   * the query plans of the two new queries use the small chat_log_rm index.
// CL6 fix-up (review 2): holds cover a held person's incognito (h:) lines; open reports keep their line's text; nothing admin-only
// reaches the owner (room_events, sealed muted rows, no staff names); the feed's full report limits (gap, new accounts, per day,
// pad bans / blocks); bridge_feed and the copies (mention notices, Telegram alerts, quotes, mic clip posts) go with a takedown;
// Pepe's removed_who; reasons never tell a hidden person's line or another pad's; scrollback rules for line actions; the limiter;
// the queue picks lines first; reportRead anonymises; staff undo of hide_all; the merge re-keys rm_by.
//   NODE_PATH=G:/PATV/node_modules node --test test/chatlog-takedowns.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-takedowns-test-"));
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
const { runQuery, getQuery, tx } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
require(path.join(repo, "terms"))._setRequired(false);
const bridge = require(path.join(repo, "bridge"));
const CL = require(path.join(repo, "chatlog"));
const CV = require(path.join(repo, "chatlogview"));
const CLM = require(path.join(repo, "chatlogmod"));
const PC = require(path.join(repo, "padchat"));

const DAY = 864e5;
let offset = 0;
CL._setClock(() => Date.now() + offset);

const ROOM = { id: "Td.Room", name: "Td Room" };
const OTHER = { id: "Td.Other", name: "Td Other" };
const SLUG = "td-room", OSLUG = "td-other";
const ALICE = { id: "alicecf", login: "alicecf", display: "Alice" };
const BOB = { id: "bobcf", login: "bobcf", display: "Bob" };
const CAROL = { id: "carolcf", login: "carolcf", display: "Carol" };
const PEPE = { id: "pepefrog", login: "pepefrog", display: "PepeFrog", is_self: true };
const users = new Map();
const U = {};
let base, server, seq = 0;
const ev = (room, type, data, ts) => ({ op: "event", id: "td-" + (++seq), ts: new Date(ts || Date.now()).toISOString(), type, scope: { platform: "camfrog", room }, data });
const snap = (room) => ({ room, members: [ALICE, BOB, CAROL], mic: [], count: 3, transcripts: true, mod: { modcf: { actions: ["kick", "ban"] } } });

function call(method, url, user, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const u = new URL(base + url);
    const headers = Object.assign({ "x-requested-with": "fetch" }, data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {},
                                  user ? { "x-test-user": user.userId } : {});
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
const post = (url, user, body) => call("POST", url, user, body === undefined ? {} : body);
const act = (c, what, user, body, slug = SLUG) => post(`/api/rooms/${slug}/chatlog/${c}/${what}`, user, body);
const live = (user, q = "") => get(`/api/rooms/${SLUG}/live${q}`, user);
const texts = (r) => (r.d.feed || []).filter((it) => it.k === "msg" || it.k === "tx").map((it) => it.text);
async function mkUser(name, cls = "pleb", camfrog = null, id = null, created = "2026-01-01 00:00:00") {
  const uid = id || "id-" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at)
                  VALUES (?, ?, ?, 'x', ?, 100000, ?, 5, ?)`, [uid, name, name, cls, camfrog, created]);
  const u = { userId: uid, username: name, class: cls };
  users.set(uid, u);
  return u;
}
const row = async (c) => (await getQuery("SELECT * FROM chat_log WHERE c = ?", [c]))[0];
const cOf = async (text) => { const r = (await getQuery("SELECT c FROM chat_log WHERE text = ?", [text]))[0]; assert.ok(r, "archived: " + text); return Number(r.c); };
const ftsHas = async (word) => (await getQuery("SELECT rowid FROM chat_log_fts WHERE chat_log_fts MATCH ?", ['"' + word + '"'])).length > 0;
const inFeed = (c) => bridge._rooms.get(ROOM.id).feed.some((it) => Number(it.c) === Number(c));
const inBridgeFeed = async (c) => (await getQuery("SELECT 1 FROM bridge_feed WHERE c = ?", [c])).length > 0;
/** One new line in the room, archived; -> its c. */
async function say(text, user = ALICE, agoMs = 0, room = ROOM) {
  await bridge.ingest({ rooms: [snap(room)], events: [ev(room, "message", { user, text }, Date.now() - agoMs)] });
  return cOf(text);
}
async function sayWeb(text, acctId) {
  await bridge.ingest({ rooms: [snap(ROOM)], events: [ev(ROOM, "message", { user: PEPE, text: "🌐 x (PATV web): " + text, web: { user: { login: "u:" + acctId, display: "Webby" }, text } })] });
  return cOf(text);
}
async function sayTx(text, id, user = ALICE) {
  await bridge.ingest({ rooms: [snap(ROOM)], events: [ev(ROOM, "x.pepe.transcript", { id, user, text })] });
  return cOf(text);
}
const inbox = async (userId, like) => getQuery("SELECT * FROM inbox WHERE user_id = ? AND (title LIKE ? OR body LIKE ?)", [userId, like, like]);
// CL6 fix-up: the reports' 3 s gap is the feed's own (feedstore.burst) - cleared where a test sends several on purpose
const gap0 = () => require(path.join(repo, "feedstore"))._gaps.clear();
// an incognito person's line as Pepe sends it (anonymised, with their hidden-set hash) -> archived as who "h:<hash>"
let anonSeq = 0;
async function sayIncog(text, login = "inccf", k = "msg") {
  const u = { id: "anon-" + (++anonSeq), display: "someone", anonymous: true };
  const data = k === "tx" ? { id: "tx-" + String(9000 + anonSeq).padStart(16, "0"), user: u, text, anon: { kind: "incognito", h: CL.hash(login) } }
                          : { user: u, text, anon: { kind: "incognito", h: CL.hash(login) } };
  await bridge.ingest({ rooms: [snap(ROOM)], events: [ev(ROOM, k === "tx" ? "x.pepe.transcript" : "message", data)] });
  return cOf(text);
}
const events = async (what) => getQuery("SELECT what, actor, detail FROM room_events WHERE room_id = ? AND what LIKE ? ORDER BY ts", [ROOM.id, what]);

const setup = (async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await require(path.join(repo, "media")).ready;
  await require(path.join(repo, "inbox")).ready;
  await require(path.join(repo, "telegram")).init();                    // CL6 fix-up: mention alerts queued for Telegram
  require(path.join(repo, "actions"));
  U.own = await mkUser("own", "pleb", "owncf");
  U.own2 = await mkUser("own2", "pleb", "own2cf");
  U.mem = await mkUser("mem", "pleb", "memcf");
  U.mem2 = await mkUser("mem2", "pleb", "mem2cf");
  U.mem3 = await mkUser("mem3", "pleb", "mem3cf");
  U.alice = await mkUser("alice", "pleb", "alicecf");
  U.webby = await mkUser("webby", "pleb", null, "id-webby");
  U.mod = await mkUser("modu", "pleb", "modcf");
  U.staff = await mkUser("helper", "Staff");
  U.staff2 = await mkUser("helper2", "Staff");
  U.admin = await mkUser("boss", "Admin", "bosscf");
  // CL6 fix-up: an incognito member, a brand-new account, one banned from this pad's feed
  U.inc = await mkUser("inc", "pleb", "inccf");
  U.fresh = await mkUser("fresh", "pleb", null, null, new Date().toISOString().replace("T", " ").slice(0, 19));
  U.banned = await mkUser("banned", "pleb", "bannedcf");
  await rooms.init();
  const store = require(path.join(repo, "feedstore"));
  await store.init();
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
  // the archive on (the notice 8 days ago)
  offset = -8 * DAY;
  await CL.setSwitch("notice", true, "test");
  offset = 0;
  await CL.setSwitch("archive", true, "test");
  const T = Date.now();
  await bridge.ingest({ rooms: [snap(ROOM)], events: [
    ev(ROOM, "message", { user: ALICE, text: "echo two hours ago" }, T - 2 * 3600e3),
    ev(ROOM, "message", { user: ALICE, text: "alpha line one" }, T - 50 * 60e3),
    ev(ROOM, "message", { user: BOB, text: "bravo words here" }, T - 30 * 60e3),
  ] });
  await bridge.ingest({ rooms: [snap(OTHER)], events: [ev(OTHER, "message", { user: ALICE, text: "golf other room" }, T - 60e3)] });
  await rooms.setOwner(ROOM.id, "own", "test");
  await rooms.setOwner(OTHER.id, "own", "test");
  await CV.init();
  await CLM.init();
  PC._reset();
})();
// (no test.after / beforeEach: Node 16's runner lacks them - the server is unref'd, each test resets what it uses)
const ready = async () => { await setup; offset = 0; PC._reset(); CLM._reset(); CV._clearCaches(); gap0(); };

test("the line menu: /live offers report to members, hide to the owner / the room's mods / staff, purge to staff; own lines flagged; nothing while the archive is off", async () => {
  await ready();
  let r = await live(U.mem);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.d.history.acts, { report: 1, hide: 0, purge: 0 });
  assert.ok(!r.d.feed.some((it) => it.own), "nothing of mem's");
  assert.deepEqual((await live(U.own)).d.history.acts, { report: 1, hide: 1, purge: 0 });
  assert.deepEqual((await live(U.mod)).d.history.acts, { report: 1, hide: 1, purge: 0 }, "kick in Pepe's live caps");
  assert.deepEqual((await live(U.staff)).d.history.acts, { report: 1, hide: 1, purge: 1 }, "chatlog.read_all (Staff)");
  r = await live(U.alice);
  assert.deepEqual(r.d.feed.filter((it) => it.own).map((it) => it.text), ["echo two hours ago", "alpha line one"], "alice's own lines");
  const cw = await sayWeb("delta typed on the web", "id-webby");
  r = await live(U.webby);
  assert.deepEqual(r.d.feed.filter((it) => it.own).map((it) => it.c), [cw], "a web line is its account's own");
  // the archive off: no menu (takedowns act on archived lines)
  await CL.setSwitch("archive", false, "test");
  try { assert.equal((await live(U.mem)).d.history.acts, undefined); } finally { await CL.setSwitch("archive", true, "test"); }
});

test("⚑ report: reasons, never your own line, one per reporter, the owner + the admins told (copyright: admins only), 20 an hour, the bad-faith pause", async () => {
  await ready();
  const c = await cOf("alpha line one");
  let r = await act(c, "report", U.mem, { reason: "nonsense" });
  assert.equal(r.status, 400); assert.equal(r.d.code, "bad_reason");
  r = await act(c, "report", U.alice, { reason: "harassment" });
  assert.equal(r.status, 400); assert.equal(r.d.code, "own", "your own line: remove it instead");
  r = await act(c, "report", null, { reason: "harassment" });
  assert.equal(r.status, 401);
  r = await act(c, "report", U.mem, { reason: "harassment", note: "  calls people names \u0007 " });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.d.ok, r.d.urgent, r.d.hidden, r.d.admins_only], [true, false, false, false]);
  assert.match(String(r.headers["cache-control"]), /no-store/);
  assert.match(String(r.headers["x-robots-tag"]), /noindex/);
  const rep = (await getQuery("SELECT * FROM chatlog_reports WHERE c = ?", [c]))[0];
  assert.deepEqual([rep.reporter, rep.reason, rep.note, rep.state], [U.mem.userId, "harassment", "calls people names", "open"]);
  assert.equal((await row(c)).rm_at, null, "a report alone hides nothing");
  assert.equal((await act(c, "report", U.mem, { reason: "info" })).d.already, true, "one open report per reporter and line");
  // the admins (inbox) and the pad's owner (with the line's link; no text, no reporter)
  const adm = await inbox(U.admin.userId, "A pad chat line was reported%");
  assert.equal(adm.length, 1);
  assert.equal(adm[0].link, "/feed/admin#chatlines");
  const own = await getQuery("SELECT * FROM inbox WHERE user_id = ? AND kind = 'room'", [U.own.userId]);
  assert.equal(own.length, 1);
  assert.equal(own[0].link, `/p/${SLUG}?tab=live&line=${c}`);
  assert.doesNotMatch(String(own[0].title) + String(own[0].body), /alpha|mem\b/, "neither the line's words nor the reporter");
  assert.ok((await getQuery("SELECT 1 FROM room_events WHERE room_id = ? AND what = 'chat.report' AND detail LIKE ?", [ROOM.id, `#${c} harassment%`])).length);
  // copyright is the site's: the owner isn't told
  const c2 = await say("hotel copyright words");
  r = await act(c2, "report", U.mem2, { reason: "copyright" });
  assert.equal(r.d.admins_only, true);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = ? AND kind = 'room'", [U.own.userId]))[0].n, 1, "no owner notice");
  // 20 an hour
  for (let i = 0; i < 20; i++) await runQuery("INSERT INTO chatlog_reports (c, rk, reporter, reason, state, created) VALUES (?, 1, ?, 'info', 'dismissed', ?)", [900000 + i, U.mem3.userId, Date.now()]);
  r = await act(c2, "report", U.mem3, { reason: "info" });
  assert.equal(r.status, 429); assert.equal(r.d.code, "rate");
  await runQuery("DELETE FROM chatlog_reports WHERE reporter = ?", [U.mem3.userId]);
  // the feed's bad-faith pause: 3 reports dismissed as bad faith in 30 days -> only an urgent one goes through, and hides nothing
  for (let i = 0; i < 3; i++) await runQuery("INSERT INTO chatlog_reports (c, rk, reporter, reason, state, created, decided_at) VALUES (?, 1, ?, 'info', 'false', ?, ?)", [910000 + i, U.mem3.userId, Date.now() - 2 * 3600e3, Date.now() - 2 * 3600e3]);
  gap0();
  r = await act(c2, "report", U.mem3, { reason: "harassment" });
  assert.equal(r.status, 403); assert.equal(r.d.code, "paused");
  gap0();
  r = await act(c2, "report", U.mem3, { reason: "minor" });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.d.urgent, r.d.hidden], [true, false], "a paused reporter's urgent report reaches the admins but hides nothing");
  assert.equal((await row(c2)).rm_at, null);
  assert.ok((await inbox(U.admin.userId, "URGENT%")).length >= 1);
  await runQuery("DELETE FROM chatlog_reports WHERE reporter = ? AND state = 'false'", [U.mem3.userId]);     // (mem3 reports again later)
});

test("a minor report hides the line at once - left out of /live, R.feed, bridge_feed and the index, `removed` on the next poll; the queue's Dismiss shows it again", async () => {
  await ready();
  const c = await say("india kilo lima minor");
  const page = await live(U.mem);
  assert.ok(texts(page).includes("india kilo lima minor"));
  assert.ok(inFeed(c) && (await inBridgeFeed(c)) && (await ftsHas("kilo")));
  const idx0 = Number((await getQuery("SELECT idx_rows FROM chatlog_rooms WHERE room_id = ?", [ROOM.id]))[0].idx_rows);
  const r = await act(c, "report", U.mem2, { reason: "minor" });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.d.urgent, r.d.hidden], [true, true]);
  const x = await row(c);
  assert.equal(x.rm_by, "report:minor");
  assert.ok(x.rm_at > 0);
  assert.equal(x.text, "india kilo lima minor", "kept for review (30 days)");
  assert.equal(inFeed(c), false, "out of R.feed");
  assert.equal(await inBridgeFeed(c), false, "out of bridge_feed");
  assert.equal(await ftsHas("kilo"), false, "out of the search index");
  assert.equal(Number((await getQuery("SELECT idx_rows FROM chatlog_rooms WHERE room_id = ?", [ROOM.id]))[0].idx_rows), idx0 - 1);
  const next = await live(U.mem, `?after=${page.d.cursor}&jc=${encodeURIComponent(page.d.jc)}`);
  assert.ok((next.d.removed || []).includes(c), "open pages drop it within one poll");
  assert.ok(!texts(await live(U.mem)).includes("india kilo lima minor"));
  assert.ok((await inbox(U.admin.userId, "URGENT%")).length >= 1, "every admin, every time");
  // the queue: a member can't see it; staff read the line (logged) and dismiss -> shown again
  assert.equal((await get("/api/admin/chatlog/reports", U.mem)).status, 403);
  const q = await get("/api/admin/chatlog/reports", U.staff);
  assert.equal(q.status, 200, q.text);
  const g = q.d.lines.find((l) => l.c === c);
  assert.ok(g && g.urgent && g.state === "hidden_report");
  assert.ok(!JSON.stringify(q.d).includes("india"), "the queue never carries the text");
  const fa = await get("/feed/admin", U.staff);
  assert.equal(fa.status, 200, fa.text.slice(0, 300));
  assert.ok(fa.text.includes(`data-cl="${c}"`), "the queue on /feed/admin");
  assert.ok(fa.text.includes("hidden (minor report)"));
  assert.ok(!fa.text.includes("india kilo"), "the line's text only on Read");
  const rd = await post(`/api/admin/chatlog/reports/${c}`, U.staff, { action: "read" });
  assert.equal(rd.d.line.text, "india kilo lima minor");
  assert.ok((await getQuery("SELECT 1 FROM chatlog_views WHERE user_id = ? AND why = ?", [U.staff.userId, "report queue #" + c])).length, "the read is logged");
  const dm = await post(`/api/admin/chatlog/reports/${c}`, U.staff, { action: "dismiss" });
  assert.equal(dm.status, 200, dm.text);
  assert.equal(dm.d.state, "dismissed");
  assert.equal((await row(c)).rm_at, null, "shown again");
  assert.ok(inFeed(c) && (await inBridgeFeed(c)) && (await ftsHas("kilo")), "back in the live feed and the index");
  assert.ok((await inbox(U.mem2.userId, "Update on your report")).length, "the reporter is told");
});

test("one not_found for everything a member can't see; the owner gets the reason; a permission refusal comes before any lookup", async () => {
  await ready();
  const other = await cOf("golf other room");
  let r = await act(other, "report", U.mem, { reason: "info" });
  assert.deepEqual([r.status, r.d.code, r.d.why], [404, "not_found", undefined]);
  // CL6 fix-up: another pad's cursor is "no line" to the owner (exempt) - only staff get that reason
  r = await act(other, "report", U.own, { reason: "info" });
  assert.deepEqual([r.status, r.d.code, r.d.why], [404, "not_found", "no_line"], "the owner (exempt) never learns another pad's cursor");
  r = await act(other, "report", U.staff, { reason: "info" });
  assert.deepEqual([r.status, r.d.code, r.d.why], [404, "not_found", "other_room"], "staff get the reason");
  r = await act(99999999, "report", U.mem, { reason: "info" });
  assert.deepEqual([r.status, r.d.code], [404, "not_found"]);
  // below the member's floor (a 15-minute window), and a removed line
  await post(`/api/rooms/${SLUG}/chat-settings`, U.own, { window_s: 900 });
  CV._clearCaches();
  const old = await cOf("echo two hours ago");
  r = await act(old, "report", U.mem, { reason: "info" });
  assert.deepEqual([r.status, r.d.code, r.d.why], [404, "not_found", undefined]);
  await post(`/api/rooms/${SLUG}/chat-settings`, U.own, { window_s: null });
  CV._clearCaches();
  const gone = await say("mike removed by author");
  assert.equal((await act(gone, "remove", U.alice)).status, 200);
  r = await act(gone, "report", U.mem, { reason: "info" });
  assert.deepEqual([r.status, r.d.code], [404, "not_found"]);
  // hide: a member is refused the same way for a real line and for no line at all
  const a = await act(await cOf("alpha line one"), "hide", U.mem, { why: "spam" });
  const b = await act(88888888, "hide", U.mem, { why: "spam" });
  assert.deepEqual([a.status, a.d.code, a.d.error], [b.status, b.d.code, b.d.error]);
  assert.equal(a.status, 403);
  // writes are same-origin JSON only
  const raw = await new Promise((resolve) => {
    const u = new URL(base + `/api/rooms/${SLUG}/chatlog/1/report`);
    const req = http.request({ method: "POST", hostname: u.hostname, port: u.port, path: u.pathname, headers: { "content-type": "application/json", "x-test-user": U.mem.userId } },
                             (res) => { res.resume(); resolve(res.statusCode); });
    req.end("{}");
  });
  assert.equal(raw, 403);
});

test("🗑 remove my line: its author only (linked login or the account's u: key), left out at once; nobody else can undo it", async () => {
  await ready();
  const c = await say("november own words");
  let r = await act(c, "remove", U.mem);
  assert.deepEqual([r.status, r.d.code], [404, "not_found"], "not the author");
  r = await act(c, "remove", U.alice);
  assert.equal(r.status, 200, r.text);
  const x = await row(c);
  assert.deepEqual([x.rm_by, x.purged, x.text], ["self", null, "november own words"]);
  assert.equal(inFeed(c), false);
  assert.equal((await act(c, "remove", U.alice)).d.already, true);
  r = await act(c, "unhide", U.own);
  assert.equal(r.status, 403, "a self-removal stays removed");
  const w = await sayWeb("oscar web words", "id-webby");
  r = await act(w, "remove", U.webby);
  assert.equal(r.status, 200, r.text);
  assert.equal((await row(w)).rm_by, "self");
});

test("🙈 hide / ↩ unhide: the owner, the room's mods and staff, with a reason; within 30 days, the owner / staff or the mod who hid it", async () => {
  await ready();
  const c = await say("papa quebec romeo");
  let r = await act(c, "hide", U.mod, {});
  assert.deepEqual([r.status, r.d.code], [400, "why"]);
  r = await act(c, "hide", U.mod, { why: "spam spam" });
  assert.equal(r.status, 200, r.text);
  let x = await row(c);
  assert.deepEqual([x.rm_by, x.rm_why], ["mod:" + U.mod.userId, "spam spam"]);
  assert.equal(inFeed(c), false, "it leaves the live feed");
  assert.equal(await ftsHas("quebec"), false);
  assert.ok((await getQuery("SELECT 1 FROM room_events WHERE room_id = ? AND what = 'chat.hide' AND detail = ?", [ROOM.id, `#${c}: spam spam`])).length);
  // the owner and staff see it muted (with its text and who hid it); everyone else doesn't
  const V = await CV.view(ROOM.id, U.own);
  const p = await CV.project([CV.itemOf(await row(c))], { view: V, jc: null });
  assert.equal(p.items.length, 1);
  assert.deepEqual(p.items[0].removed, { at: Number(x.rm_at), by: "mod", why: "spam spam", who: "modu" });
  assert.equal(p.items[0].text, "papa quebec romeo");
  assert.equal(p.items[0].u.login, "alicecf");
  const pm = await CV.project([CV.itemOf(await row(c))], { view: await CV.view(ROOM.id, U.mem), jc: null });
  assert.deepEqual([pm.items.length, pm.left.removed], [0, 1]);
  // the mod who hid it can show it again
  r = await act(c, "unhide", U.mod);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.restored, true);
  assert.equal((await row(c)).rm_at, null);
  assert.ok(inFeed(c) && (await ftsHas("quebec")), "back in the live feed and the index");
  // the owner hides: the mod can't undo the owner's hide; staff can
  assert.equal((await act(c, "hide", U.own, { why: "off topic" })).status, 200);
  assert.equal((await act(c, "unhide", U.mod)).status, 403);
  assert.equal((await act(c, "unhide", U.staff)).status, 200);
  // after 30 days it's too late (and the nightly pass blanks it) - the hide is backdated (moving the clock would move the pad's
  // expiry watermark for good)
  assert.equal((await act(c, "hide", U.own, { why: "again" })).status, 200);
  await runQuery("UPDATE chat_log SET rm_at = rm_at - ? WHERE c = ?", [31 * DAY, c]);
  r = await act(c, "unhide", U.own);
  assert.deepEqual([r.status, r.d.code], [409, "too_late"]);
});

test("the nightly pass: hidden / removed lines lose their text after 30 days - a legal hold keeps them; the audit keeps 2 years", async () => {
  await ready();
  const c1 = await say("sierra tango hidden");
  const c2 = await say("uniform victor held", CAROL);
  assert.equal((await act(c1, "hide", U.own, { why: "rude" })).status, 200);
  assert.equal((await act(c2, "hide", U.own, { why: "rude" })).status, 200);
  // a hold on carol's login
  const h = await post("/api/admin/chatlog/who", U.staff, { key: "carolcf", action: "hold", why: "a legal order #1" });
  assert.equal(h.status, 200, h.text);
  assert.ok(CLM.isHeld(0, "carolcf"));
  await runQuery("INSERT INTO chatlog_views (user_id, kind, at) VALUES ('ancient', 'history', ?)", [Date.now() - 800 * DAY]);
  let n = await CLM.nightly({ t: Date.now() + 10 * DAY });
  assert.equal((await row(c1)).purged, null, "not before 30 days");
  n = await CLM.nightly({ t: Date.now() + 31 * DAY });
  assert.ok(n.purged >= 1);
  assert.ok(n.skipped_held >= 1);
  const x = await row(c1);
  assert.deepEqual([x.purged, x.text, x.rm_by], [1, null, "mod:" + U.own.userId]);
  assert.ok(String(x.who).startsWith("h:") && !String(x.who).includes("alice"), "the login is gone too");
  assert.deepEqual(JSON.parse(x.d).u, {});
  assert.equal((await row(c2)).text, "uniform victor held", "the hold keeps it");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chatlog_views WHERE user_id = 'ancient'"))[0].n, 0);
  assert.equal((await post("/api/admin/chatlog/who", U.staff, { key: "carolcf", action: "unhold", why: "order lifted" })).status, 200);
  await CLM.nightly({ t: Date.now() + 31 * DAY });
  assert.equal((await row(c2)).purged, 1);
});

test("⛔ staff purge reaches every copy: chat_log + index + counters, bridge_feed + R.feed, the quote that copied it, the mention notice, Pepe's removed list; a hold refuses it", async () => {
  await ready();
  const c = await say("whiskey xray yankee purge");
  const keep = await say("zulu stays in the quote");
  const T = Date.now();
  // two quotes of the room: one with both lines (by cursor), one old-style (no cursor) with only the purged line
  const items = bridge._rooms.get(ROOM.id).feed.filter((it) => it.c === c || it.c === keep);
  const lines = await require(path.join(repo, "quotes")).buildLines(items);
  assert.deepEqual(lines.map((l) => l.c), [c, keep], "a quote's lines carry their cursor");
  await runQuery("INSERT INTO feed_posts (id, author_id, title, body, created) VALUES ('q1post', ?, 'q', 'x', ?), ('q2post', ?, 'q', 'x', ?)", [U.mem.userId, T, U.mem.userId, T]);
  await runQuery("INSERT INTO feed_quotes (post_id, room_id, source, lines, logins, removed, created_by, created) VALUES (?, ?, 'web', ?, ' alicecf ', '[]', ?, ?)",
                 ["q1post", ROOM.id, JSON.stringify(lines), U.mem.userId, T]);
  const old = [{ k: "msg", login: "alicecf", name: "Alice", text: "whiskey xray yankee purge", ts: lines[0].ts }];
  await runQuery("INSERT INTO feed_quotes (post_id, room_id, source, lines, logins, removed, created_by, created) VALUES (?, ?, 'web', ?, ' alicecf ', '[]', ?, ?)",
                 ["q2post", ROOM.id, JSON.stringify(old), U.mem.userId, T]);
  // a mention notice that copied the line
  await require(path.join(repo, "inbox")).addSafe(U.mem.userId, { kind: "mention", title: "💬 Alice mentioned you in Td Room", body: "Alice: whiskey xray yankee purge",
                                                                    link: `/p/${SLUG}?line=${c}`, ref: `mention:${ROOM.id}:${c}` });
  // CL6 fix-up: ...and its Telegram alerts (telegram.onNotice: ref "n:" + the notice's) - one still queued, one already sent
  await runQuery(`INSERT INTO telegram_outbox (user_id, kind, text, ref, due_at, created, sent_at) VALUES (?, 'mention', 'Alice: whiskey xray yankee purge', ?, ?, ?, NULL),
                  (?, 'mention', 'Alice: whiskey xray yankee purge', ?, ?, ?, ?)`, [U.mem.userId, `n:mention:${ROOM.id}:${c}`, T, T, U.mem2.userId, `n:mention:${ROOM.id}:${c}`, T, T, T]);
  // members, owners and mods can't purge (before any lookup)
  for (const u of [U.mem, U.own, U.mod]) assert.equal((await act(c, "purge", u, {})).status, 403);
  // a room hold refuses it
  const rk = Number((await getQuery("SELECT rk FROM chatlog_rooms WHERE room_id = ?", [ROOM.id]))[0].rk);
  let r = await post(`/api/admin/chatlog/room/${SLUG}/hold`, U.staff, { why: "a court order" });
  assert.equal(r.status, 200, r.text);
  assert.ok((await getQuery("SELECT 1 FROM chatlog_holds WHERE key = ?", ["room:" + rk])).length);
  r = await act(c, "purge", U.staff, { why: "doxxing" });
  assert.deepEqual([r.status, r.d.code], [409, "held"]);
  assert.equal((await post(`/api/admin/chatlog/room/${rk}/unhold`, U.staff, { why: "order lifted" })).status, 200);
  const before = (await getQuery("SELECT idx_rows, bytes FROM chatlog_rooms WHERE rk = ?", [rk]))[0];
  r = await act(c, "purge", U.staff, { why: "doxxing" });
  assert.equal(r.status, 200, r.text);
  const x = await row(c);
  assert.deepEqual([x.purged, x.text, x.rm_by, x.rm_why], [1, null, "staff:" + U.staff.userId, "doxxing"]);
  assert.ok(String(x.who).startsWith("h:"));
  assert.equal(await ftsHas("xray"), false);
  const after = (await getQuery("SELECT idx_rows, bytes FROM chatlog_rooms WHERE rk = ?", [rk]))[0];
  assert.equal(Number(after.idx_rows), Number(before.idx_rows) - 1);
  assert.ok(Number(after.bytes) < Number(before.bytes));
  assert.equal(inFeed(c), false);
  assert.equal(await inBridgeFeed(c), false);
  const q1 = JSON.parse((await getQuery("SELECT lines FROM feed_quotes WHERE post_id = 'q1post'"))[0].lines);
  assert.deepEqual(q1.map((l) => l.text), ["zulu stays in the quote"], "the purged line left the quote");
  assert.equal((await getQuery("SELECT body FROM feed_posts WHERE id = 'q1post'"))[0].body, `<${lines[1].name}> zulu stays in the quote`);
  const q2 = (await getQuery("SELECT deleted_at, body FROM feed_posts WHERE id = 'q2post'"))[0];
  assert.ok(q2.deleted_at, "a quote left with no line is removed");
  const n = (await getQuery("SELECT title, body FROM inbox WHERE ref = ?", [`mention:${ROOM.id}:${c}`]))[0];
  assert.equal(n.body, null);
  assert.doesNotMatch(n.title, /Alice/);
  const tg = await getQuery("SELECT user_id, text, sent_at, error FROM telegram_outbox WHERE ref = ? ORDER BY user_id", [`n:mention:${ROOM.id}:${c}`]);
  assert.equal(tg.length, 2);
  for (const x of tg) assert.equal(x.text, "", "no words left in a Telegram alert, sent or not");
  const unsent = tg.find((x) => x.user_id === U.mem.userId);
  assert.ok(unsent.sent_at > 0 && /removed/.test(unsent.error), "the queued alert is dropped, never sent");
  // CL6 fix-up: the pad's owner reads room_events - "PATV staff", no staff note; the note is in the staff audit
  assert.ok((await getQuery("SELECT 1 FROM room_events WHERE room_id = ? AND what = 'chat.purge' AND actor = 'PATV staff' AND detail = ?", [ROOM.id, `#${c}`])).length);
  assert.ok(!(await getQuery("SELECT 1 FROM room_events WHERE room_id = ? AND detail LIKE '%doxxing%'", [ROOM.id])).length, "never the note");
  assert.ok((await getQuery("SELECT 1 FROM chatlog_views WHERE user_id = ? AND kind = 'takedown' AND why = ?", [U.staff.userId, `purge #${c}: doxxing`])).length);
  assert.ok(!(await getQuery("SELECT 1 FROM room_events WHERE room_id = ? AND what = 'chat.hold'", [ROOM.id])).length, "a legal hold is never a room event");
  // Pepe's !log: the owner sync's removed list - [unix seconds, the login's hidden-set hash]
  const sync = await CL.forOwnerSync([{ id: ROOM.id }]);
  assert.ok(sync[0].chatlog.removed.some(([s, h]) => s === Math.floor(Number(x.ts) / 1000) && h === CL.hash("alicecf")), JSON.stringify(sync[0].chatlog.removed));
  assert.ok(sync[0].chatlog.removed.length <= CLM.REMOVED_MAX);
  // the owner sees "Removed" (no text, no name); a member nothing
  const p = await CV.project([CV.itemOf(x)], { view: await CV.view(ROOM.id, U.own), jc: null });
  assert.deepEqual([p.items[0].removed, p.items[0].text, p.items[0].u], [{ purged: true }, undefined, { anon: true, display: "someone" }]);
  assert.equal((await act(c, "purge", U.staff, {})).d.already, true);
});

test("the per-login tool (staff): look, export, hide_all, hold / purge_all; audited; members and the cap-less can't", async () => {
  await ready();
  const b1 = await say("alfa bravo one", BOB), b2 = await say("alfa bravo two", BOB);
  assert.equal((await post("/api/admin/chatlog/who", U.mem, { key: "bobcf", action: "look", why: "curious me" })).status, 403);
  // CL6 fix-up: a look tells where and when someone spoke - it needs its reason too
  assert.equal((await post("/api/admin/chatlog/who", U.staff, { key: "bobcf", action: "look" })).d.code, "why");
  let r = await post("/api/admin/chatlog/who", U.staff, { key: "bobcf", action: "look", why: "privacy@ request #42" });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.d.keys, ["bobcf"]);
  assert.ok(r.d.summary.lines >= 3);
  assert.equal(r.d.summary.rooms[0].room_id, ROOM.id);
  // the login never goes in an address: the /who/:key forms answer use_body (staff) - never a lookup
  r = await get("/api/admin/chatlog/who/bobcf", U.staff);
  assert.deepEqual([r.status, r.d.code], [400, "use_body"]);
  assert.equal((await get("/api/admin/chatlog/who/bobcf", U.mem)).status, 403);
  assert.deepEqual([(await post("/api/admin/chatlog/who/bobcf", U.staff, { action: "look", why: "x y z" })).d.code], ["use_body"]);
  assert.equal((await post("/api/admin/chatlog/who", U.staff, { key: "bobcf", action: "export" })).d.code, "why", "an action needs the reason");
  r = await post("/api/admin/chatlog/who", U.staff, { key: "bobcf", action: "export", why: "privacy@ request #42" });
  assert.ok(r.d.export.lines.some((l) => l.text === "alfa bravo one"));
  assert.equal(r.d.export.format, "patv-chatlog-login/1");
  assert.ok(!JSON.stringify(r.d.export).includes(U.mem.userId), "no account ids");
  const aud = await getQuery("SELECT * FROM chatlog_views WHERE user_id = ? AND kind = 'login_tool' ORDER BY id DESC LIMIT 1", [U.staff.userId]);
  assert.deepEqual([aud[0].who, aud[0].why], ["bobcf", "export: privacy@ request #42"]);
  // an account: its web lines (u:<id>) and its linked login
  r = await post("/api/admin/chatlog/who", U.staff, { key: "@alice", action: "look", why: "privacy@ request #43" });
  assert.deepEqual(r.d.keys.sort(), ["alicecf", "u:id-alice"]);
  // hide_all: sticky (src staff), left out of /live at once
  r = await post("/api/admin/chatlog/who", U.staff, { key: "bobcf", action: "hide_all", why: "privacy@ request #42" });
  assert.equal(r.status, 200, r.text);
  assert.equal(CL.isHiddenKey("bobcf"), true);
  assert.equal((await getQuery("SELECT src FROM chatlog_hidden WHERE h = ?", [CL.hash("bobcf")]))[0].src, "staff");
  assert.ok(!texts(await live(U.mem)).some((t) => /alfa bravo|bravo words/.test(t)));
  await CL.noteSync({ events: [{ op: "event", type: "privacy.shown", data: { h: CL.hash("bobcf"), scope: "bridge" } }] });
  assert.equal(CL.isHiddenKey("bobcf"), true, "Pepe can't un-hide a staff hide");
  // CL6 fix-up: the owner sync tells Pepe (removed_who: every line, any time) - and staff can undo their own hide_all
  let sync = await CL.forOwnerSync([{ id: ROOM.id }]);
  assert.ok(sync[0].chatlog.removed_who.some(([h, until]) => h === CL.hash("bobcf") && until === null), JSON.stringify(sync[0].chatlog.removed_who));
  r = await post("/api/admin/chatlog/who", U.staff, { key: "bobcf", action: "unhide_all", why: "hid the wrong login" });
  assert.equal(r.status, 200, r.text);
  assert.equal(CL.isHiddenKey("bobcf"), false, "only the staff reason was there");
  assert.ok(texts(await live(U.mem)).includes("alfa bravo one"), "back in the live tail");
  sync = await CL.forOwnerSync([{ id: ROOM.id }]);
  assert.ok(!sync[0].chatlog.removed_who.some(([h]) => h === CL.hash("bobcf")));
  // ...but never another reason: forget-me (src forget) stays when staff undo their own hide
  await CL.hideNow(["bobcf"], "forget");
  await post("/api/admin/chatlog/who", U.staff, { key: "bobcf", action: "hide_all", why: "privacy@ request #42" });
  r = await post("/api/admin/chatlog/who", U.staff, { key: "bobcf", action: "unhide_all", why: "test" });
  assert.deepEqual([r.d.still_hidden, CL.isHiddenKey("bobcf")], [true, true]);
  assert.deepEqual(CL.hiddenReasons(CL.hash("bobcf")), ["forget"]);
  // hold / purge_all
  assert.equal((await post("/api/admin/chatlog/who", U.staff, { key: "bobcf", action: "hold", why: "legal order #9" })).status, 200);
  r = await post("/api/admin/chatlog/who", U.staff, { key: "bobcf", action: "purge_all", why: "court said so" });
  assert.deepEqual([r.status, r.d.code], [409, "held"]);
  assert.equal((await post("/api/admin/chatlog/who", U.staff, { key: "bobcf", action: "unhold", why: "lifted" })).status, 200);
  r = await post("/api/admin/chatlog/who", U.staff, { key: "bobcf", action: "purge_all", why: "court said so" });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.d.purged >= 3);
  for (const c of [b1, b2]) { const x = await row(c); assert.deepEqual([x.purged, x.text], [1, null]); }
  assert.equal(r.d.summary.lines, 0, "nothing left under the login");
  // the takedowns card
  const card = await get("/api/admin/chatlog/takedowns", U.staff);
  assert.equal(card.status, 200, card.text);
  // (Train 3 review fix-up: "Delete every line" forgot the login - every audit row that named it names its pseudonym now)
  assert.ok(card.d.views.some((v) => v.kind === "login_tool" && /^deleted-[0-9a-f]{10}$/.test(v.who || "")));
  assert.ok(!card.d.views.some((v) => /\bbobcf\b/.test(v.who || "")), "no audit row names the forgotten login");
  assert.equal((await get("/api/admin/chatlog/takedowns", U.mem)).status, 403);
});

test("staff reads past a pad's public window are audited; the owner's earlier era (owner_grant) is staff's to open, audited", async () => {
  await ready();
  await post(`/api/rooms/${SLUG}/chat-settings`, U.own, { window_s: 900 });
  CV._clearCaches();
  await runQuery("DELETE FROM chatlog_views WHERE kind = 'history'");
  const r = await live(U.staff);
  assert.ok(texts(r).includes("echo two hours ago"), "staff (chatlog.read_all) read back to retention");
  assert.ok((await getQuery("SELECT 1 FROM chatlog_views WHERE user_id = ? AND kind = 'history'", [U.staff.userId])).length, "logged");
  assert.ok(!texts(await live(U.mem)).includes("echo two hours ago"));
  // a new owner doesn't read the earlier era - until staff open it for them
  await rooms.setOwner(ROOM.id, "own2", "test");
  CV._clearCaches();
  await CV.reconcileNow(ROOM.id);
  assert.ok(!texts(await live(U.own2)).includes("echo two hours ago"));
  let g = await post(`/api/admin/chatlog/room/${SLUG}/grant`, U.own2, { why: "a request" });
  assert.equal(g.status, 403, "not the owner's to open");
  g = await post(`/api/admin/chatlog/room/${SLUG}/grant`, U.staff, { why: "the new owner asked; checked" });
  assert.equal(g.status, 200, g.text);
  CV._clearCaches();
  assert.ok(texts(await live(U.own2)).includes("echo two hours ago"));
  assert.ok((await getQuery("SELECT 1 FROM chatlog_views WHERE user_id = ? AND kind = 'grant'", [U.staff.userId])).length);
  assert.ok((await getQuery("SELECT 1 FROM room_events WHERE room_id = ? AND what = 'chat.grant'", [ROOM.id])).length);
  assert.equal((await post(`/api/admin/chatlog/room/${SLUG}/ungrant`, U.staff, { why: "taken back" })).status, 200);
  CV._clearCaches();
  assert.ok(!texts(await live(U.own2)).includes("echo two hours ago"));
  await rooms.setOwner(ROOM.id, "own", "test");
  await post(`/api/rooms/${SLUG}/chat-settings`, U.own, { window_s: null });
  CV._clearCaches();
});

test("a 🎙 line: removable by its speaker; the merge moves a login hold; the new queries use the small chat_log_rm index", async () => {
  await ready();
  const t = await sayTx("hotel mic transcript words", "tx-00000000000000d1");
  assert.equal((await act(t, "remove", U.alice)).status, 200);
  assert.equal((await row(t)).rm_by, "self");
  // account merge: a hold on the loser's web lines follows them
  await runQuery("INSERT INTO chatlog_holds (key, by_user, why, at) VALUES ('who:u:id-loser', ?, 'order', 1)", [U.staff.userId]);
  await tx(() => CL.mergeAccounts("id-loser", "id-winner"));
  assert.deepEqual((await getQuery("SELECT key FROM chatlog_holds WHERE key LIKE 'who:u:id-%'")).map((r) => r.key), ["who:u:id-winner"]);
  assert.ok(CLM.isHeld(0, "u:id-winner"));
  const plan = async (sql, p) => (await getQuery("EXPLAIN QUERY PLAN " + sql, p)).map((r) => r.detail).join(" | ");
  const rk = Number((await getQuery("SELECT rk FROM chatlog_rooms WHERE room_id = ?", [ROOM.id]))[0].rk);
  const removed = await plan("SELECT ts, who FROM chat_log WHERE rk = ? AND rm_at IS NOT NULL AND k IN ('msg','tx') AND who IS NOT NULL ORDER BY rm_at DESC LIMIT 500", [rk]);
  assert.match(removed, /chat_log_rm/, removed);
  // CL6 fix-up: the nightly pass walks chat_log_rm_due (taken-down rows whose text is still there: purged rows leave it) in index
  // order - no sort, no scan, however many purged rows chat_log_rm keeps
  const nightly = await plan(CLM.DUE_SQL, [0, Date.now(), 0, 0, 1000]);
  assert.match(nightly, /chat_log_rm_due/, nightly);
  assert.doesNotMatch(nightly, /SCAN (l|chat_log)\b(?! USING)/, nightly);
  assert.doesNotMatch(nightly, /TEMP B-TREE/, nightly);
  // the merge: the lines the loser hid as a mod stay theirs (they can still show them again)
  const mc = await say("mod hid this before a merge");
  await runQuery("UPDATE chat_log SET rm_at = ?, rm_by = 'mod:id-loser2', rm_why = 'x' WHERE c = ?", [Date.now(), mc]);
  const mr = await tx(() => CL.mergeAccounts("id-loser2", "id-winner2"));
  assert.equal((await row(mc)).rm_by, "mod:id-winner2");
  assert.equal(mr.rm_by, 1);
});

// ── CL6 fix-up (review 2) ──
const banHere = (user) => runQuery("INSERT OR IGNORE INTO feed_bans (user_id, room_id, username, reason, by, at, until) VALUES (?, ?, ?, 'x', 'own', ?, NULL)",
                                   [user.userId, ROOM.id, user.username, Date.now()]);

test("a legal hold on a login covers what they said while incognito (who h:<hash>): the nightly pass, a staff purge, the queue's purge; their anonymised lines on Pepe's removed list, theirs to remove, in the export and purge_all", async () => {
  await ready();
  const c1 = await sayIncog("india incognito words one");
  const c2 = await sayIncog("india incognito words two");
  assert.equal((await row(c1)).who, "h:" + CL.hash("inccf"), "archived anonymised, under the login's hash");
  assert.equal((await act(c1, "hide", U.own, { why: "rude words" })).status, 200);
  const h = await post("/api/admin/chatlog/who", U.staff, { key: "inccf", action: "hold", why: "legal order #7" });
  assert.equal(h.status, 200, h.text);
  assert.ok(CLM.isHeld(0, "h:" + CL.hash("inccf")), "the hold reaches the anonymised lines");
  assert.ok(!CLM.isHeld(0, "h:" + CL.hash("nobodyheld")));
  // the nightly 30-day pass keeps the hidden one
  const n = await CLM.nightly({ t: Date.now() + 31 * DAY });
  assert.ok(n.skipped_held >= 1);
  assert.equal((await row(c1)).text, "india incognito words one");
  // a staff purge and the queue's purge are refused
  let r = await act(c2, "purge", U.staff, { why: "x" });
  assert.deepEqual([r.status, r.d.code], [409, "held"]);
  assert.equal((await act(c2, "report", U.mem, { reason: "harassment" })).status, 200, "an anonymised line can be reported");
  r = await post(`/api/admin/chatlog/reports/${c2}`, U.staff, { action: "purge" });
  assert.deepEqual([r.status, r.d.code], [409, "held"]);
  // CL7's retention purge holds them the same way (its keepers carry the h: form)
  const K = await require(path.join(repo, "chatlogpurge")).keepers();
  assert.ok(K.who.has("h:" + CL.hash("inccf")));
  // Pepe's removed list names the hidden anonymised line by the login's hash (what his log matches)
  const ts1 = Math.floor(Number((await row(c1)).ts) / 1000);
  assert.ok((await CLM.removedFor(ROOM.id)).some(([s, hh]) => hh === CL.hash("inccf") && s === ts1));
  // their own anonymised line: theirs to remove (no one else's); the export lists both, "someone"
  assert.equal((await act(c2, "remove", U.mem)).status, 404);
  assert.equal((await act(c2, "remove", U.inc)).status, 200);
  r = await post("/api/admin/chatlog/who", U.staff, { key: "@inc", action: "export", why: "their own request #3" });
  const texts2 = r.d.export.lines.map((l) => l.text);
  assert.ok(texts2.includes("india incognito words one") && texts2.includes("india incognito words two"));
  assert.ok(r.d.export.lines.every((l) => l.shown_as === "someone" || l.shown_as === null));
  // the hold released: purge_all reaches the anonymised lines too
  assert.equal((await post("/api/admin/chatlog/who", U.staff, { key: "inccf", action: "unhold", why: "lifted" })).status, 200);
  r = await post("/api/admin/chatlog/who", U.staff, { key: "inccf", action: "purge_all", why: "their request #3" });
  assert.equal(r.status, 200, r.text);
  for (const c of [c1, c2]) assert.deepEqual([(await row(c)).purged, (await row(c)).text], [1, null]);
  assert.equal(r.d.summary.lines, 0);
});

test("the nightly pass keeps a line whose report is still open - a 'minor' report's evidence stays until the admins decide", async () => {
  await ready();
  const c = await say("juliet evidence for a minor report", CAROL);
  const r = await act(c, "report", U.mem, { reason: "minor" });
  assert.deepEqual([r.status, r.d.hidden], [200, true]);
  let n = await CLM.nightly({ t: Date.now() + 31 * DAY });
  assert.ok(n.skipped_reported >= 1, JSON.stringify(n));
  assert.equal((await row(c)).text, "juliet evidence for a minor report", "kept");
  const rd = await post(`/api/admin/chatlog/reports/${c}`, U.staff, { action: "read" });
  assert.equal(rd.d.line.text, "juliet evidence for a minor report");
  // decided: its 30 days run from the hide, and the next pass blanks it
  assert.equal((await post(`/api/admin/chatlog/reports/${c}`, U.staff, { action: "hide", why: "confirmed" })).status, 200);
  n = await CLM.nightly({ t: Date.now() + 31 * DAY });
  assert.equal((await row(c)).purged, 1);
  // decided reports are pruned after 2 years; an open one never
  await runQuery("INSERT INTO chatlog_reports (c, rk, reporter, reason, state, created, decided_at) VALUES (950001, 1, 'old', 'info', 'dismissed', 1, 1), (950002, 1, 'old', 'info', 'open', 1, NULL)");
  n = await CLM.nightly();
  assert.ok(n.reports >= 1);
  assert.deepEqual((await getQuery("SELECT c FROM chatlog_reports WHERE c IN (950001, 950002)")).map((x) => Number(x.c)), [950002]);
  await runQuery("DELETE FROM chatlog_reports WHERE c = 950002");
});

test("the feed's report rules in full: 3 s between two reports, a brand-new account 5 an hour, 60 a day (feed + chat reports count); a pad feed ban hides nothing; the queue picks lines first", async () => {
  await ready();
  const lines = [];
  for (let i = 0; i < 8; i++) lines.push(await say("kilo victim line " + i));
  let r = await act(lines[0], "report", U.fresh, { reason: "harassment" });
  assert.equal(r.status, 200, r.text);
  r = await act(lines[1], "report", U.fresh, { reason: "harassment" });
  assert.deepEqual([r.status, r.d.code], [429, "rate"], "the 3 s gap (shared with the feed's reports)");
  assert.ok(r.d.retry >= 1);
  // a brand-new account: 5 an hour in all - its "minor" reports too, so it can't auto-hide a room's lines in a minute
  let hid = 0, refused = 0;
  for (let i = 1; i < 8; i++) {
    gap0();
    const x = await act(lines[i], "report", U.fresh, { reason: "minor" });
    if (x.status === 200 && x.d.hidden) hid++;
    else { assert.deepEqual([x.status, x.d.code], [429, "rate"]); refused++; }
  }
  assert.deepEqual([hid, refused], [4, 3], "1 harassment + 4 minor = 5 an hour");
  // 60 a day
  for (let i = 0; i < 60; i++) await runQuery("INSERT INTO chatlog_reports (c, rk, reporter, reason, state, created) VALUES (?, 1, ?, 'info', 'dismissed', ?)", [920000 + i, U.mem2.userId, Date.now() - 2 * 3600e3]);
  gap0();
  r = await act(lines[0], "report", U.mem2, { reason: "info" });
  assert.deepEqual([r.status, r.d.code], [429, "rate_day"]);
  await runQuery("DELETE FROM chatlog_reports WHERE c >= 920000 AND c < 920060");
  // the feed's own reports count toward the hour
  for (let i = 0; i < 20; i++) await runQuery("INSERT INTO feed_reports (post_id, reporter_id, reason, created) VALUES (?, ?, 'spam', ?)", ["fp" + i, U.mem3.userId, Date.now()]);
  gap0();
  r = await act(lines[0], "report", U.mem3, { reason: "info" });
  assert.deepEqual([r.status, r.d.code], [429, "rate"]);
  await runQuery("DELETE FROM feed_reports WHERE reporter_id = ?", [U.mem3.userId]);
  // banned from THIS pad's feed: only an urgent report goes through, and it hides nothing
  await banHere(U.banned);
  CV._clearCaches();
  gap0();
  r = await act(lines[0], "report", U.banned, { reason: "harassment" });
  assert.deepEqual([r.status, r.d.code], [403, "paused"]);
  gap0();
  r = await act(lines[0], "report", U.banned, { reason: "minor" });
  assert.deepEqual([r.status, r.d.urgent, r.d.hidden], [200, true, false], "reaches the admins, hides nothing");
  assert.equal((await row(lines[0])).rm_at, null);
  // the queue picks LINES first (urgent first): a flood of newer reports never pushes an urgent line out; a line's reports are capped
  const T = Date.now();
  for (let i = 0; i < 350; i++) await runQuery("INSERT INTO chatlog_reports (c, rk, reporter, reason, state, created) VALUES (?, 1, ?, 'info', 'open', ?)", [930000 + i, "flood" + i, T]);
  for (let i = 0; i < 60; i++) await runQuery("INSERT INTO chatlog_reports (c, rk, reporter, reason, state, created) VALUES (940000, 1, ?, 'info', 'open', ?)", ["many" + i, T + 1000]);
  const q = await CLM.reportQueue();
  assert.equal(q.length, CLM.QUEUE_LINES);
  assert.ok(q.some((g) => g.c === lines[1] && g.urgent), "an older urgent line stays in the queue");
  assert.ok(q.findIndex((g) => g.urgent) === 0);
  const big = q.find((g) => g.c === 940000);
  assert.deepEqual([big.reports.length, big.more], [CLM.QUEUE_PER_LINE, 60 - CLM.QUEUE_PER_LINE]);
  await runQuery("DELETE FROM chatlog_reports WHERE c >= 930000 AND c <= 940000");
});

test("nothing admin-only reaches the pad's owner: room_events (no minor / copyright report, no hold, no staff note or name), sealed muted rows for a self-removal and a 'minor' report's hide", async () => {
  await ready();
  await runQuery("DELETE FROM room_events WHERE room_id = ? AND what LIKE 'chat.%'", [ROOM.id]);
  const cm = await say("lima minor report words");
  assert.equal((await act(cm, "report", U.mem, { reason: "minor" })).d.hidden, true);
  const cc = await say("mike copyright words");
  assert.equal((await act(cc, "report", U.mem2, { reason: "copyright" })).status, 200);
  const ch = await say("november harassment words");
  assert.equal((await act(ch, "report", U.mem3, { reason: "harassment" })).status, 200);
  assert.equal((await post(`/api/admin/chatlog/room/${SLUG}/hold`, U.staff, { why: "subpoena re owner's account, case 22-1" })).status, 200);
  assert.equal((await post(`/api/admin/chatlog/room/${SLUG}/unhold`, U.staff, { why: "lifted, case 22-1" })).status, 200);
  assert.equal((await post(`/api/admin/chatlog/room/${SLUG}/grant`, U.staff, { why: "secret staff reason 77" })).status, 200);
  assert.equal((await post(`/api/admin/chatlog/room/${SLUG}/ungrant`, U.staff, { why: "secret staff reason 78" })).status, 200);
  const cs = await say("oscar staff hides this");
  assert.equal((await act(cs, "hide", U.staff, { why: "spam wave" })).status, 200);
  const cq = await say("papa queue hides this");
  gap0();
  assert.equal((await act(cq, "report", U.mem, { reason: "info" })).status, 200);
  assert.equal((await post(`/api/admin/chatlog/reports/${cq}`, U.staff, { action: "hide", why: "doxx of a minor, ncmec #5" })).status, 200);
  assert.equal((await post(`/api/admin/chatlog/reports/${cm}`, U.staff, { action: "dismiss", why: "not a minor, checked" })).status, 200);
  // what the owner's pad settings page lists (padsettings.js: room_events not 'feed-%')
  const ev = await getQuery("SELECT what, actor, detail FROM room_events WHERE room_id = ? AND what NOT LIKE 'feed-%' AND what LIKE 'chat.%'", [ROOM.id]);
  const all = JSON.stringify(ev);
  assert.doesNotMatch(all, /minor|copyright|subpoena|22-1|secret staff|ncmec|doxx|checked|helper|dismissed|hidden\)/, all);
  assert.ok(ev.some((e) => e.what === "chat.report" && e.detail === `#${ch} harassment`), all);
  assert.ok(!ev.some((e) => e.what === "chat.hold"));
  assert.ok(ev.some((e) => e.what === "chat.hide" && e.actor === "PATV staff" && e.detail === `#${cs}: spam wave`));
  assert.ok(ev.some((e) => e.what === "chat.hide" && e.actor === "PATV staff" && e.detail === `#${cq}: after a report`));
  assert.ok(ev.some((e) => e.what === "chat.unhide" && e.actor === "PATV staff" && e.detail === `#${cm}`));
  assert.ok(ev.some((e) => e.what === "chat.grant" && e.actor === "PATV staff" && e.detail === "owner may read the earlier era"));
  // the staff notes and who it was are in the staff audit
  assert.ok((await getQuery("SELECT 1 FROM chatlog_views WHERE user_id = ? AND kind = 'takedown' AND why LIKE ?", [U.staff.userId, `queue hide #${cq}: doxx%`])).length);
  assert.ok((await getQuery("SELECT 1 FROM chatlog_views WHERE user_id = ? AND kind = 'takedown' AND why = ?", [U.staff.userId, `hide #${cs}: spam wave`])).length);
  assert.ok((await getQuery("SELECT 1 FROM chatlog_views WHERE user_id = ? AND kind = 'login_tool' AND why LIKE 'room hold: subpoena%'", [U.staff.userId])).length);
  // the owner's muted rows: a self-removal and a "minor" report's hide are sealed (no words, no speaker, no reason); a staff hide is
  // "PATV staff" (never a name); staff see everything
  const cm2 = await say("quebec minor report words");
  gap0();
  assert.equal((await act(cm2, "report", U.mem2, { reason: "minor" })).d.hidden, true);
  const ca = await say("romeo alice removes this");
  assert.equal((await act(ca, "remove", U.alice)).status, 200);
  const items = [];
  for (const c of [cm2, ca, cs]) items.push(CV.itemOf(await row(c)));
  const po = (await CV.project(items, { view: await CV.view(ROOM.id, U.own), jc: null })).items;
  const ps = (await CV.project(items, { view: await CV.view(ROOM.id, U.staff2), jc: null })).items;
  assert.deepEqual([po[0].removed.by, po[0].removed.sealed, po[0].removed.why, po[0].text, po[0].u], ["staff", true, undefined, undefined, { anon: true, display: "someone" }]);
  assert.doesNotMatch(JSON.stringify(po[0]), /quebec|report|alicecf|Alice/);
  assert.deepEqual([po[1].removed.by, po[1].removed.sealed, po[1].text], ["self", true, undefined]);
  assert.doesNotMatch(JSON.stringify(po[1]), /romeo|alicecf/);
  assert.deepEqual([po[2].removed.by, po[2].removed.who, po[2].removed.why, po[2].text], ["staff", undefined, "spam wave", "oscar staff hides this"]);
  assert.deepEqual([ps[0].removed.by, ps[0].text], ["report", "quebec minor report words"]);
  assert.deepEqual([ps[1].removed.by, ps[1].text], ["self", "romeo alice removes this"]);
  assert.equal(ps[2].removed.who, "helper", "staff see which staff member hid it");
  // the owner's menu never offers to show a staff / report hide again (it would be refused)
  assert.equal((await act(cm2, "unhide", U.own)).status, 403);
});

test("a hide commits its bridge_feed delete with it: a crash after the commit can't bring the line back at a start; a start drops one left behind", async () => {
  await ready();
  const c = await say("sierra hidden then crash");
  assert.ok(await inBridgeFeed(c));
  const orig = bridge.takeDown;
  bridge.takeDown = async () => { throw new Error("simulated crash after the commit"); };
  try { assert.equal((await act(c, "hide", U.own, { why: "rude" })).status, 200); } finally { bridge.takeDown = orig; }
  assert.ok((await row(c)).rm_at > 0);
  assert.equal(await inBridgeFeed(c), false, "gone with the hide's own transaction");
  // a row left behind any other way (an older build): the start (bridge.load) drops it from R.feed and bridge_feed
  const c2 = await say("tango left behind");
  await runQuery("UPDATE chat_log SET rm_at = ?, rm_by = 'mod:x' WHERE c = ?", [Date.now(), c2]);
  assert.ok(inFeed(c2) && (await inBridgeFeed(c2)));
  assert.ok((await bridge._dropTakenDown()) >= 1);
  assert.equal(inFeed(c2), false);
  assert.equal(await inBridgeFeed(c2), false);
});

test("the reasons never tell a !bridge hide person's line or another pad's: one no_line - never 'already shown' or 'not yours' - for the owner and mods; staff get the reason", async () => {
  await ready();
  const c = await say("uniform said then hidden", { id: "unicf", login: "unicf", display: "Uni" });
  await CL.hideNow(["unicf"], "pepe", "bridge");
  let r = await act(c, "hide", U.mod, { why: "probe" });
  assert.deepEqual([r.status, r.d.code, r.d.why], [404, "not_found", "no_line"]);
  r = await act(c, "report", U.own, { reason: "info" });
  assert.deepEqual([r.status, r.d.why], [404, "no_line"]);
  r = await act(c, "unhide", U.mod);
  assert.deepEqual([r.status, r.d.why], [404, "no_line"], "never {already: true}");
  r = await act(c, "unhide", U.own);
  assert.deepEqual([r.status, r.d.why], [404, "no_line"]);
  r = await act(c, "remove", U.own);
  assert.deepEqual([r.status, r.d.why], [404, "no_line"], "never 'not yours'");
  const none = await act(99999999, "hide", U.mod, { why: "probe" });
  assert.deepEqual([none.status, none.d.code, none.d.why], [404, "not_found", "no_line"], "the same answer as no line at all");
  r = await act(c, "hide", U.staff, { why: "probe" });
  assert.deepEqual([r.status, r.d.why], [404, "privacy"], "staff get the reason");
});

test("line actions beyond the live tail need scrollback (can.history + the history switch): without it the archive can't be probed", async () => {
  await ready();
  const c = await say("victor archived only");
  const B = bridge._rooms.get(ROOM.id);
  const keep = B.feed.slice();
  B.feed = B.feed.filter((it) => Number(it.c) !== c);          // scrolled out of the live tail (still archived)
  try {
    let r = await act(c, "report", U.mem, { reason: "harassment" });
    assert.deepEqual([r.status, r.d.code], [404, "not_found"]);
    r = await act(c, "hide", U.own, { why: "probe" });
    assert.deepEqual([r.status, r.d.code, r.d.why], [404, "not_found", "floor"], "the owner too, while scrollback is off");
    await CL.setSwitch("history", true, "test");
    try {
      CV._clearCaches();
      r = await act(c, "report", U.mem, { reason: "harassment" });
      assert.equal(r.status, 200, r.text);
      // banned from the pad's feed (or bridge-blocked, or 18+ unconfirmed): no scrollback - refused again
      await banHere(U.banned);
      CV._clearCaches();
      r = await act(c, "report", U.banned, { reason: "harassment" });
      assert.deepEqual([r.status, r.d.code], [404, "not_found"]);
    } finally { await CL.setSwitch("history", false, "test"); CV._clearCaches(); }
  } finally { B.feed = keep; }
});

test("Pepe's !log: a purge_all of more lines than the removed list holds reaches him through removed_who; forget-me's hide too", async () => {
  await ready();
  const T = Date.now(), MANY = { id: "manycf", login: "manycf", display: "Many" };
  const evs = [];
  for (let i = 0; i < 620; i++) evs.push(ev(ROOM, "message", { user: MANY, text: "many line " + i }, T - (700 - i) * 1000));
  for (let i = 0; i < evs.length; i += 100) await bridge.ingest({ rooms: [snap(ROOM)], events: evs.slice(i, i + 100) });
  assert.equal(Number((await getQuery("SELECT COUNT(*) AS n FROM chat_log WHERE who = 'manycf'"))[0].n), 620);
  const r = await post("/api/admin/chatlog/who", U.staff, { key: "manycf", action: "purge_all", why: "privacy@ #9" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.purged, 620);
  const sync = await CL.forOwnerSync([{ id: ROOM.id }]);
  assert.ok(sync[0].chatlog.removed.length <= CLM.REMOVED_MAX, "the per-line list stays the spec's 500");
  const who = sync[0].chatlog.removed_who.find(([h]) => h === CL.hash("manycf"));
  assert.ok(who && who[1] >= Math.floor(T / 1000) - 1, "every line of theirs up to the purge: " + JSON.stringify(who));
  // forget-me with "also hide my past public chat lines" (src forget): every line, any time
  await CL.hideNow(["u:id-webby"], "forget");
  const s2 = await CL.forOwnerSync([{ id: ROOM.id }]);
  assert.ok(s2[0].chatlog.removed_who.some(([h, u]) => h === CL.hash("u:id-webby") && u === null));
  // Pepe's own hides (incognito / !bridge hide) aren't the site's to tell him
  assert.ok(!s2[0].chatlog.removed_who.some(([h]) => h === CL.hash("unicf")));
});

test("the per-account limit: ACT_PER_MIN hides a minute, then 429 rate with the seconds to wait (nothing changed)", async () => {
  await ready();
  const cs = [];
  for (let i = 0; i <= CLM.ACT_PER_MIN; i++) cs.push(await say("whiskey limit line " + i));
  for (let i = 0; i < CLM.ACT_PER_MIN; i++) assert.equal((await act(cs[i], "hide", U.own, { why: "spam" })).status, 200);
  const r = await act(cs[CLM.ACT_PER_MIN], "hide", U.own, { why: "spam" });
  assert.deepEqual([r.status, r.d.code], [429, "rate"]);
  assert.ok(r.d.retry >= 1 && r.d.retry <= 60, String(r.d.retry));
  assert.equal((await row(cs[CLM.ACT_PER_MIN])).rm_at, null, "nothing changed");
  CLM._reset();
});

test("a hide reaches the copies people were sent (mention notices, Telegram alerts); a quote leaves the line out while it's down; a purged 🎙 line takes its mic clip post down and keeps no 🎙 id", async () => {
  await ready();
  const c = await say("xray hide copies line");
  const keep = await say("yankee stays quoted");
  const T = Date.now();
  const Q = require(path.join(repo, "quotes"));
  const lines = await Q.buildLines(bridge._rooms.get(ROOM.id).feed.filter((it) => it.c === c || it.c === keep));
  await runQuery("INSERT INTO feed_posts (id, author_id, title, body, created) VALUES ('q3post', ?, 'q', 'x', ?)", [U.mem.userId, T]);
  await runQuery("INSERT INTO feed_quotes (post_id, room_id, source, lines, logins, removed, created_by, created) VALUES (?, ?, 'web', ?, ' alicecf ', '[]', ?, ?)",
                 ["q3post", ROOM.id, JSON.stringify(lines), U.mem.userId, T]);
  await require(path.join(repo, "inbox")).addSafe(U.mem2.userId, { kind: "mention", title: "💬 Alice mentioned you", body: "Alice: xray hide copies line", link: "/p/x",
                                                                     ref: `mention:${ROOM.id}:${c}` });
  await runQuery("INSERT INTO telegram_outbox (user_id, kind, text, ref, due_at, created) VALUES (?, 'mention', 'Alice: xray hide copies line', ?, ?, ?)",
                 [U.mem3.userId, `n:mention:${ROOM.id}:${c}`, T, T]);
  let q = (await Q.forPosts(["q3post"], null)).get("q3post");
  assert.deepEqual(q.lines.map((l) => l.text), ["xray hide copies line", "yankee stays quoted"]);
  assert.equal((await act(c, "hide", U.own, { why: "rude" })).status, 200);
  q = (await Q.forPosts(["q3post"], null)).get("q3post");
  assert.deepEqual([q.lines.map((l) => l.text), q.left_out], [["yankee stays quoted"], 1]);
  assert.doesNotMatch(q.body, /xray/);
  assert.doesNotMatch((await getQuery("SELECT body FROM feed_posts WHERE id = 'q3post'"))[0].body, /xray/, "the post's text too (search, previews)");
  const n = (await getQuery("SELECT title, body FROM inbox WHERE user_id = ? AND ref = ?", [U.mem2.userId, `mention:${ROOM.id}:${c}`]))[0];
  assert.equal(n.body, null);
  assert.doesNotMatch(n.title, /Alice/);
  const tg = (await getQuery("SELECT text, sent_at, error FROM telegram_outbox WHERE ref = ?", [`n:mention:${ROOM.id}:${c}`]))[0];
  assert.deepEqual([tg.text, tg.sent_at > 0, /removed/.test(tg.error)], ["", true, true], "the queued alert never goes out");
  // shown again: back in the quote (its body too)
  assert.equal((await act(c, "unhide", U.own)).status, 200);
  q = (await Q.forPosts(["q3post"], null)).get("q3post");
  assert.equal(q.lines.length, 2);
  assert.match((await getQuery("SELECT body FROM feed_posts WHERE id = 'q3post'"))[0].body, /xray/);
  // a 🎙 line's 🔊 mic clip post (its transcript is the caption) comes down with a purge of that line; another clip stays
  const t = await sayTx("zulu alpha mic words for a clip", "tx-00000000000000e1");
  const tr = await row(t);
  const at = Number(tr.ts) + 60e3;
  await runQuery("INSERT INTO feed_posts (id, author_id, title, body, created) VALUES ('clippost1', ?, ?, '', ?), ('clippost2', ?, ?, '', ?)",
                 [U.mem.userId, "🎙 Alice: “zulu alpha mic words for a clip”", at, U.mem.userId, "🎙 Bob: “something else entirely here”", at]);
  await runQuery("INSERT INTO feed_voices (post_id, room_id, media_id, logins, by_login, created) VALUES ('clippost1', ?, 'm-none', ' alicecf ', 'memcf', ?), ('clippost2', ?, 'm-none2', ' bobcf ', 'memcf', ?)",
                 [ROOM.id, at, ROOM.id, at]);
  assert.equal((await act(t, "purge", U.staff, { why: "clip test" })).status, 200);
  const p1 = (await getQuery("SELECT deleted_at, title, body FROM feed_posts WHERE id = 'clippost1'"))[0];
  assert.ok(p1.deleted_at > 0);
  assert.deepEqual([p1.title, p1.body], ["", ""]);
  assert.ok((await getQuery("SELECT removed_at FROM feed_voices WHERE post_id = 'clippost1'"))[0].removed_at > 0);
  assert.equal((await getQuery("SELECT deleted_at FROM feed_posts WHERE id = 'clippost2'"))[0].deleted_at, null, "someone else's clip stays");
  assert.equal((await row(t)).tx, null, "the 🎙 id (a hash of the login and the words) goes with the words");
});

test("the queue's Read names the speaker as every other read path does: someone incognito now is 'someone', with no login", async () => {
  await ready();
  const c = await say("alpha said before going incognito", { id: "laterinc", login: "laterinc", display: "Later Inc" });
  assert.equal((await act(c, "report", U.mem, { reason: "harassment" })).status, 200);
  let rd = await post(`/api/admin/chatlog/reports/${c}`, U.staff, { action: "read" });
  assert.deepEqual([rd.d.line.name, rd.d.line.login], ["Later Inc", "laterinc"]);
  await CL.hideNow(["laterinc"], "pepe", "incognito");
  rd = await post(`/api/admin/chatlog/reports/${c}`, U.staff, { action: "read" });
  assert.deepEqual([rd.d.line.name, rd.d.line.login, rd.d.line.anon, rd.d.line.text], ["someone", null, true, "alpha said before going incognito"]);
  const aud = (await getQuery("SELECT who FROM chatlog_views WHERE user_id = ? AND why = ? ORDER BY id DESC LIMIT 1", [U.staff.userId, "report queue #" + c]))[0];
  assert.equal(aud.who, null, "the audit row doesn't name them either");
});
