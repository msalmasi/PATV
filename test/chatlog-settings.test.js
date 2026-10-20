// CL3 padchat.js + the live paths: a pad's 💬 Chat settings and what they do on today's pages.
//   * the routes: owner + staff only, the defaults (downloads off on Approved pads), validation, same-origin writes, the
//     site admin's lock, the limits (20 a minute per account and pad, staff exempt), "open earlier" request / cancel;
//   * a change writes room_events, posts a 📜 note line in the pad's chat, moves the watermarks, and reaches Pepe (the owner
//     sync's `chatlog` block); the tab renders; the owner panel has one summary row linking to it; the WEB_CAPS entry;
//   * the done-when on /live: Off = a fresh load shows nothing earlier while new lines still stream in (signed join cursor) and
//     after=0 returns nothing earlier; 15 minutes hides older lines from a member but not from the owner or the room's mod;
//   * quotes and mic clips only from lines inside the quoter's view (one answer for every failure).
//   NODE_PATH=G:/PATV/node_modules node --test test/chatlog-settings.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-settings-test-"));
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
const PC = require(path.join(repo, "padchat"));
const PA = require(path.join(repo, "padaccess"));
const PO = require(path.join(repo, "padowner"));
const quotes = require(path.join(repo, "quotes"));
const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));

const ROOM = { id: "Set.Room", name: "Set Room" };
const SLUG = "set-room";
const ALICE = { id: "alicecf", login: "alicecf", display: "Alice" };
const users = new Map();
const U = {};
let base, server, seq = 0;
const ev = (type, data, ts) => ({ op: "event", id: "st-" + (++seq), ts: new Date(ts || Date.now()).toISOString(), type, scope: { platform: "camfrog", room: ROOM }, data });
const snapRoom = () => ({ room: ROOM, members: [ALICE], mic: [], count: 1, transcripts: true, mod: { modcf: { actions: ["kick"] } } });

function call(method, url, user, body, extra = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const u = new URL(base + url);
    const headers = Object.assign({}, extra.noXrw ? {} : { "x-requested-with": "fetch" }, data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {},
                                  user ? { "x-test-user": user.userId } : {}, extra.headers || {});
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
const post = (url, user, body, extra) => call("POST", url, user, body, extra);
const del = (url, user) => call("DELETE", url, user);
async function mkUser(name, cls = "pleb", camfrog = null) {
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at)
                  VALUES (?, ?, ?, 'x', ?, 100000, ?, 5, '2026-01-01 00:00:00')`, ["id-" + name, name, name, cls, camfrog]);
  const u = { userId: "id-" + name, username: name, class: cls };
  users.set(u.userId, u);
  return u;
}
const settle = () => new Promise((r) => setTimeout(r, 60));
const live = (user, q = "") => get(`/api/rooms/${SLUG}/live${q}`, user);
const texts = (r) => (r.d.feed || []).filter((it) => it.k === "msg" || it.k === "tx").map((it) => it.text);

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
  U.mod = await mkUser("modu", "pleb", "modcf");
  U.staff = await mkUser("helper", "Staff");
  U.admin = await mkUser("boss", "Admin", "bosscf");
  await rooms.init();
  await PO.init();
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
  require(path.join(repo, "padsettings")).register(app, { addUser });
  await new Promise((r) => { server = app.listen(0, r); });
  server.unref();
  base = "http://127.0.0.1:" + server.address().port;
  const T = Date.now();
  await bridge.ingest({ rooms: [snapRoom()], events: [
    ev("message", { user: ALICE, text: "two hours ago" }, T - 2 * 3600e3),
    ev("x.pepe.transcript", { id: "tx-00000000000000b1", user: ALICE, text: "mic two hours ago" }, T - 2 * 3600e3 + 1000),
    ev("message", { user: ALICE, text: "five minutes ago" }, T - 5 * 60e3),
  ] });
  await rooms.setOwner(ROOM.id, "own", "test");
  await CV.init();
  PC._reset();
})();
// (no test.after / beforeEach: Node 16's runner lacks them - the server is unref'd, each test resets the limits itself)
const ready = async () => { await setup; PC._reset(); CV._clearCaches(); quotes._hits.clear(); };

test("GET / POST chat-settings: owner and staff only; the defaults; validation; same-origin writes", async () => {
  await ready();
  assert.equal((await get(`/api/rooms/${SLUG}/chat-settings`, null)).status, 401);
  assert.equal((await get(`/api/rooms/${SLUG}/chat-settings`, U.mem)).status, 403);
  const r = await get(`/api/rooms/${SLUG}/chat-settings`, U.own);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers["cache-control"], "no-store");
  assert.match(String(r.headers["x-robots-tag"]), /noindex/);
  assert.equal(r.d.window_s, null, "everything the tier keeps");
  assert.equal(r.d.search, true);
  assert.equal(r.d.downloads, true, "on for a Members pad");
  assert.equal(r.d.mods_all, false);
  assert.equal(r.d.locked, false);
  assert.deepEqual(r.d.effective, { chat_s: 30 * 86400, tx_s: 30 * 86400 });
  assert.equal(r.d.tier, "standard");
  assert.deepEqual(r.d.retention, { chat_days: 30, rec_days: 30 });
  assert.equal(r.d.open, null);
  assert.equal((await get(`/api/rooms/${SLUG}/chat-settings`, U.staff)).status, 200, "site staff manage any pad");
  const S = `/api/rooms/${SLUG}/chat-settings`;
  for (const bad of [{ window_s: 59 }, { window_s: 315360001 }, { window_s: "3600" }, { window_s: 1.5 }, { window_s: -1 }, { search: "yes" }, { mods_all: null },
                     { downloads: "on" }, {}, { nonsense: 1 }]) {
    const x = await post(S, U.own, bad);
    assert.equal(x.status, 400, JSON.stringify(bad) + " -> " + x.text);
  }
  assert.equal((await post(S, U.own, { window_s: 3600 }, { noXrw: true })).status, 403, "X-Requested-With: fetch");
  assert.equal((await post(S, U.own, { window_s: 3600 }, { headers: { origin: "https://evil.example" } })).status, 403, "same origin");
  assert.equal((await post(S, U.mem, { window_s: 3600 })).status, 403);
  for (const ok of [{ window_s: 60 }, { window_s: 315360000 }, { window_s: 0 }, { window_s: null }, { downloads: null }]) {
    const x = await post(S, U.own, ok);
    assert.equal(x.status, 200, JSON.stringify(ok) + " -> " + x.text);
  }
  assert.equal(PC.WINDOW_MIN, 60);
  assert.equal(PC.WINDOW_MAX, 315360000);
});

test("a change: room_events, a 📜 note line in the pad's chat, the watermarks, the owner sync's chatlog block", async () => {
  await ready();
  const S = `/api/rooms/${SLUG}/chat-settings`;
  const r = await post(S, U.own, { window_s: 86400, search: false, mods_all: true, downloads: false });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.window_s, 86400);
  assert.equal(r.d.search, false);
  assert.equal(r.d.mods_all, true);
  assert.equal(r.d.downloads, false);
  const evs = await getQuery("SELECT what, actor, detail FROM room_events WHERE room_id = ? AND what LIKE 'chat.%' ORDER BY ts", [ROOM.id]);
  const whats = evs.map((e) => e.what);
  for (const w of ["chat.history", "chat.search", "chat.downloads", "chat.mods"]) assert.ok(whats.includes(w), w);
  assert.ok(evs.every((e) => e.actor === "own"), "with the actor");
  const R = bridge._rooms.get(ROOM.id);
  const notes = R.feed.filter((it) => it.k === "note");
  assert.ok(notes.some((n) => n.w === "window" && n.s === 86400), "📜 Chat history on this pad: last 24 hours");
  assert.ok(notes.some((n) => n.w === "search" && n.s === 0), "📜 Search is now off on this pad");
  const row = (await getQuery("SELECT data FROM bridge_feed WHERE room_id = ? AND data LIKE '%\"note\"%' ORDER BY c DESC LIMIT 1", [ROOM.id]))[0];
  assert.ok(row, "the note is a feed item like any line (bridge_feed; the archive when it's on)");
  const sync = await CL.forOwnerSync([{ id: ROOM.id }]);
  assert.equal(sync[0].chatlog.window_s, 86400, "Pepe reads the effective window");
  assert.equal(sync[0].chatlog.search, false);
  assert.ok(sync[0].chatlog.changed_at > 0);
  // put it back for the next tests
  await post(S, U.own, { window_s: null, search: true, mods_all: false, downloads: null });
  const back = (await get(S, U.own)).d;
  assert.equal(back.downloads_set, null, "back to the default");
});

test("downloads: on by default for Public and Members pads, off for Approved ones (the per-pad switch overrides)", async () => {
  await ready();
  const R0 = await rooms.get(ROOM.id);
  await PA.setLevel(U.own, R0, "approved");
  let r = await get(`/api/rooms/${SLUG}/chat-settings`, U.own);
  assert.equal(r.d.downloads, false);
  assert.equal(r.d.downloads_default, false);
  await post(`/api/rooms/${SLUG}/chat-settings`, U.own, { downloads: true });
  r = await get(`/api/rooms/${SLUG}/chat-settings`, U.own);
  assert.equal(r.d.downloads, true);
  await post(`/api/rooms/${SLUG}/chat-settings`, U.own, { downloads: null });
  await PA.setLevel(U.own, R0, "members");
});

test("the lock: a site admin locks a pad's chat settings from /admin/bridge; the owner can't change them, the admin can", async () => {
  await ready();
  assert.equal((await post("/api/admin/chatlog/lock", U.own, { room: ROOM.id, locked: true })).status, 403, "site admins only");
  assert.equal((await post("/api/admin/chatlog/lock", U.staff, { room: ROOM.id, locked: true })).status, 403, "chatlog.admin = admins");
  let r = await post("/api/admin/chatlog/lock", U.admin, { room: SLUG, locked: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.locked, true);
  r = await post(`/api/rooms/${SLUG}/chat-settings`, U.own, { window_s: 3600 });
  assert.equal(r.status, 423);
  assert.equal(r.d.code, "locked");
  assert.equal((await get(`/api/rooms/${SLUG}/chat-settings`, U.own)).d.locked, true);
  r = await post(`/api/rooms/${SLUG}/chat-settings`, U.admin, { window_s: 3600 });
  assert.equal(r.status, 200, "the admin changes past the lock");
  await post(`/api/rooms/${SLUG}/chat-settings`, U.admin, { window_s: null });
  const card = await get("/api/admin/chatlog", U.admin);
  assert.equal(card.status, 200);
  const p = card.d.pads.find((x) => x.room_id === ROOM.id);
  assert.ok(p && p.locked, "the admin card lists the pad, locked");
  assert.ok(card.d.redact && typeof card.d.redact.collisions === "number");
  r = await post("/api/admin/chatlog/lock", U.admin, { room: ROOM.id, locked: false });
  assert.equal(r.d.locked, false);
  const evs = await getQuery("SELECT detail FROM room_events WHERE room_id = ? AND what = 'chat.lock' ORDER BY ts", [ROOM.id]);
  assert.deepEqual(evs.map((e) => e.detail), ["locked", "unlocked"]);
});

test("limits: 20 changes a minute per account and pad (staff exempt)", async () => {
  await ready();
  const S = `/api/rooms/${SLUG}/chat-settings`;
  let last = null;
  for (let i = 0; i < 21; i++) last = await post(S, U.own, { window_s: i % 2 ? 3600 : 7200 });
  assert.equal(last.status, 429);
  assert.equal(last.d.code, "rate");
  const s = await post(S, U.staff, { window_s: null });
  assert.equal(s.status, 200, "staff are exempt");
  PC._reset();
});

test("'Also open earlier history' routes: a bad scope -> 400; owners only; scheduled + announced; a second -> 409; DELETE cancels", async () => {
  await ready();
  const S = `/api/rooms/${SLUG}/chat-settings`;
  await post(S, U.own, { window_s: null });
  CV._clearCaches();
  // close something: Off, then everything again (nothing closed at all -> 409 "nothing": chatlog-floors.test.js)
  await post(S, U.own, { window_s: 0 });
  await post(S, U.own, { window_s: null });
  const st = (await get(S, U.own)).d;
  assert.equal(st.closed.window, true);
  assert.equal((await post(S + "/open-earlier", U.own, { scope: "nope" })).status, 400);
  assert.equal((await post(S + "/open-earlier", U.mem, { scope: "window" })).status, 403);
  const r = await post(S + "/open-earlier", U.own, { scope: "window" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.open.scope, "window");
  assert.equal((await post(S + "/open-earlier", U.own, { scope: "window" })).status, 409);
  const R = bridge._rooms.get(ROOM.id);
  assert.ok(R.feed.some((it) => it.k === "note" && it.w === "open"), "📜 announced in the pad");
  const d = await del(S + "/open-earlier", U.own);
  assert.equal(d.status, 200, d.text);
  assert.equal(d.d.open, null);
  assert.equal((await del(S + "/open-earlier", U.own)).status, 404);
  const evs = await getQuery("SELECT detail FROM room_events WHERE room_id = ? AND what = 'chat.open_earlier' ORDER BY ts", [ROOM.id]);
  assert.ok(evs.length >= 2 && /^requested \(window\)/.test(evs[0].detail) && evs[evs.length - 1].detail === "cancelled");
});

test("the 💬 Chat tab renders for the owner; the owner panel has one summary row linking to it; WEB_CAPS names the route", async () => {
  await ready();
  const r = await get(`/p/${SLUG}/settings?tab=chat`, U.own);
  assert.equal(r.status, 200, r.text.slice(0, 300));
  for (const want of ['id="chat"', 'id="padChatSet"', 'id="pcsWin"', 'data-pcs="search"', 'data-pcs="downloads"', 'data-pcs="mods_all"', 'id="pcsState"',
                      "/public/js/pad-chat-settings.js", 'href="#chat"', en["pad.settings.chat.window_label"]]) {
    assert.ok(r.text.includes(want), want);
  }
  assert.ok(/<option value="all" selected>/.test(r.text), "Everything your tier keeps is selected");
  const o = await get(`/p/${SLUG}/owner`, U.own);
  assert.equal(o.status, 200, o.text.slice(0, 300));
  assert.ok(o.text.includes('id="chat"') && o.text.includes(`/p/${SLUG}/settings?tab=chat#chat`), "one summary row that links to the tab");
  const cap = PO.WEB_CAPS.find((c) => c.id === "web_chat_history");
  assert.deepEqual(cap, { id: "web_chat_history", area: "room", route: "POST /api/rooms/:slug/chat-settings", where: "/p/{slug}/settings?tab=chat" });
  assert.ok(en["owner.cap.web_chat_history.title"] && en["owner.cap.web_chat_history.howto"]);
});

test("the done-when on /live: Off = nothing earlier on a fresh load, new lines still stream in; 15 min hides older lines from a member only", async () => {
  await ready();
  const S = `/api/rooms/${SLUG}/chat-settings`;
  await post(S, U.own, { window_s: 0 });
  await settle();
  let r = await live(U.mem);
  assert.equal(r.status, 200);
  assert.deepEqual(texts(r), [], "a fresh load shows no earlier lines");
  assert.ok(r.d.jc, "the page's signed join cursor");
  assert.equal(r.d.history.window_s, 0);
  assert.equal(r.d.history.chat_s, 0);
  const at = r.d.cursor, jc = r.d.jc;
  await bridge.ingest({ rooms: [snapRoom()], events: [ev("message", { user: ALICE, text: "said just now" })] });
  r = await live(U.mem, `?after=${at}&jc=${encodeURIComponent(jc)}`);
  assert.deepEqual(texts(r), ["said just now"], "new lines still stream in");
  r = await live(U.mem, "?after=0");
  assert.deepEqual(texts(r), [], "after=0 returns nothing earlier");
  // 15 minutes: a member loses the 2-hour-old lines; the owner and the room's mod keep them
  await post(S, U.own, { window_s: 900 });
  CV._clearCaches();
  r = await live(U.mem);
  assert.ok(!texts(r).includes("two hours ago") && !texts(r).includes("mic two hours ago"));
  r = await live(U.own);
  assert.ok(texts(r).includes("two hours ago"), "the owner reads past the window");
  r = await live(U.mod);
  assert.ok(texts(r).includes("two hours ago"), "the room's Camfrog mod (kick in Pepe's caps) reads 7 days past it");
  assert.equal(r.d.history.role, "mod");
  // Everything again: the member doesn't get them back (forward-only) until an "open earlier" takes effect
  await post(S, U.own, { window_s: null });
  CV._clearCaches();
  r = await live(U.mem);
  assert.ok(!texts(r).includes("two hours ago"), "forward-only");
  assert.ok(r.d.history && r.d.history.chat_s === 30 * 86400, "the chip reads the effective window");
});

test("quotes and mic clips only from lines inside the quoter's PUBLIC view - one answer for every failure (another room, a missing line, below the floor, an Approved pad)", async () => {
  await ready();
  const S = `/api/rooms/${SLUG}/chat-settings`;
  await post(S, U.own, { window_s: 900 });
  CV._clearCaches();
  const R = bridge._rooms.get(ROOM.id);
  const cOf = (t) => R.feed.find((it) => it.text === t).c;
  const NQ = ["not_quotable", "Those lines can't be quoted."];
  const quote = (who, cs) => { quotes._hits.clear(); return post(`/api/rooms/${SLUG}/quote`, who, { cs }); };
  let q = await quote(U.mem, [cOf("two hours ago")]);
  assert.equal(q.status, 403, q.text);
  assert.deepEqual([q.d.code, q.d.error], NQ);
  // CL3 fix-up: a quote is a PUBLIC post - the owner reads the line (past the window) but can't republish it
  q = await quote(U.own, [cOf("two hours ago")]);
  assert.deepEqual([q.status, q.d.code, q.d.error], [403, ...NQ], "the owner quotes inside the public window only");
  // the same answer for a line that doesn't exist and for one from another room (never "isn't in the feed")
  const OTHER = { id: "Other.Set.Room", name: "Other Set Room" };
  await bridge.ingest({ rooms: [{ room: OTHER, members: [ALICE], mic: [], count: 1 }],
    events: [{ op: "event", id: "st-o-" + (++seq), ts: new Date().toISOString(), type: "message", scope: { platform: "camfrog", room: OTHER }, data: { user: ALICE, text: "elsewhere" } }] });
  const otherC = bridge._rooms.get(OTHER.id).feed.find((it) => it.text === "elsewhere").c;
  for (const cs of [[999999999], [otherC]]) {
    q = await quote(U.mem, cs);
    assert.deepEqual([q.status, q.d.code, q.d.error], [403, ...NQ], "one answer: " + cs);
  }
  // a line inside the window: quotable; a selection's shape (empty / too many) still says what's wrong
  await bridge.ingest({ rooms: [snapRoom()], events: [ev("message", { user: ALICE, text: "quote me" })] });
  q = await quote(U.mem, [cOf("quote me")]);
  assert.equal(q.status, 200, q.text);
  q = await quote(U.mem, []);
  assert.equal(q.status, 400);
  // the mic clip: a 🎙 line below the floor and one that doesn't exist get the same answer
  for (const tx of ["tx-00000000000000b1", "tx-00000000000000ff"]) {
    const c = await post(`/api/rooms/${SLUG}/micclip`, U.mem, { tx });
    assert.deepEqual([c.status, c.d.code, c.d.error], [403, "not_quotable", "That mic line can't be clipped."], c.text);
  }
  // an Approved pad the member isn't approved on: the same answer for a line they could quote a moment ago, and for a missing one
  await PA.setLevel(U.own, { id: ROOM.id }, "approved");
  try {
    for (const cs of [[cOf("quote me")], [999999999]]) {
      q = await quote(U.mem, cs);
      assert.deepEqual([q.status, q.d.code, q.d.error], [403, ...NQ], "an Approved pad they can't read: " + cs);
    }
  } finally { await PA.setLevel(U.own, { id: ROOM.id }, "members"); }
  await post(S, U.own, { window_s: null });
});
