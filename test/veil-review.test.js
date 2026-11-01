// wave 2 WP-2 review fixes (track A): each test below fails without its fix.
//   A-privacy-8   a snapshot entry whose priv block doesn't parse is dropped, never shown named
//   A-compat-2    a veil identity whose login isn't one of the priv block's hashes is refused (event and snapshot)
//   A-privacy-1 / A-compat-1   C.2 counts EVERY named roster sighting (not only new ones); the batch's named lines count before its
//                 snapshot; a holder whose hold began named gets no frog name in the mic list either (began_named)
//   A-privacy-6   veiled roster entries never sit in their join slot
//   A-compat-5    the away clock starts for people a restart forgot (seedSeen) and when a room is dropped (leftRoom)
//   A-compat-10   a timed-out batch and its retry can't interleave cursor order
//   A-privacy-4 / A-compat-8 / A-tests-ux-02   the reveal endpoint's archive path refuses taken-down and left-out lines
//   A-privacy-2 / A-tests-ux-01   search never matches (or returns ranges for) a masked line; quotes never pick one
//   A-privacy-7   a v2 hidden line beyond the live tail stays in scrollback as a bar
//   A-privacy-10 / A-tests-ux-06  the report queue gives staff no login for a masked line
//   A-privacy-9   the per-login tool's summary after a non-look action doesn't reach veiled rows unlogged
//   A-privacy-3   a frog-name clip's queued action carries no speaker login (the clipper's export returns it)
//   A-compat-4    after a switch-off, a named line of someone who then goes !bridge hide is left out, not masked
//   A-privacy-5   incognito -> hidden with named lines on the page ends the frog name
//   node --test test/veil-review.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "veil-review-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
process.env.ALIAS_SECRET = "ef".repeat(32);
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
require(path.join(repo, "terms"))._setRequired(false);
const bridge = require(path.join(repo, "bridge"));
const CL = require(path.join(repo, "chatlog"));
const CV = require(path.join(repo, "chatlogview"));
const PW = require(path.join(repo, "privwire"));
const FN = require(path.join(repo, "frognames"));
const ST = require(path.join(repo, "seethrough"));
const V = require(path.join(repo, "veil"));

const hash = (login) => crypto.createHash("sha256").update("pepe-hidden:" + String(login).trim().toLowerCase()).digest("hex").slice(0, 20);
const ROOM = { id: "Review.Room", name: "Review Room" }, SLUG = "review-room";
const users = new Map();
const U = {};
let base, server, seq = 0;
const ev = (type, data, ts = Date.now(), room = ROOM) => ({ op: "event", id: "vr-" + (++seq), ts: new Date(ts).toISOString(), type, scope: { platform: "camfrog", room }, data });
const real = (login, display) => ({ id: login.toLowerCase(), login, display: display || login });
const priv = (kind, login, extra = {}) => Object.assign({ kind, h: hash(login), at: Date.now() / 1000 }, extra);
const veiled = (login, kind = "incognito", extra = {}) => Object.assign(real(login), { priv: priv(kind, login) }, extra);
const sync = (events, extra = {}) => bridge.ingest(Object.assign({ events, rooms: [], bridge_hidden_h: [], incog_hidden_h: [] }, extra), { v2: true });
const snap = (members, mic = [], room = ROOM) => ({ room, members, mic, count: members.length, transcripts: true });
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));
const clean = (u) => (u && u.login ? { login: u.login, display: u.display || u.login } : null);
const hidden = (login) => bridge.ingest({ events: [{ op: "event", id: "vr-ph-" + (++seq), ts: new Date().toISOString(), type: "privacy.hidden", scope: { platform: "camfrog" },
                                                     data: { h: hash(login), scope: "bridge" } }], rooms: [], bridge_hidden_h: [hash(login)], incog_hidden_h: [] });

function call(method, url, { user = null, body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const data = body == null ? null : JSON.stringify(body);
    const h = Object.assign({ "x-requested-with": "fetch", origin: base, host: u.host }, user ? { "x-test-user": user.userId } : {},
                            data != null ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}, headers);
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: h }, (res) => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { s += c; });
      res.on("end", () => { let d = null; try { d = JSON.parse(s); } catch (e) { d = null; } resolve({ status: res.statusCode, d, text: s }); });
    });
    req.on("error", reject);
    if (data != null) req.write(data);
    req.end();
  });
}
async function mkUser(name, cls = "pleb", camfrog = null) {
  const uid = "id-" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, 5, '2026-01-01 00:00:00')`, [uid, name, name, cls, camfrog]);
  const u = { userId: uid, username: name, class: cls };
  users.set(uid, u);
  return u;
}

const setup = (async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await require(path.join(repo, "inbox")).ready;
  U.own = await mkUser("own", "pleb", "owncf");
  U.mem = await mkUser("mem", "pleb", "memcf");
  U.staff = await mkUser("helper", "Staff");
  U.adm = await mkUser("adm", "Admin", "admcf");
  await rooms.init();
  const app = express();
  app.use((req, res, next) => (req.path === "/api/bridge/sync" || req.path === "/api/bridge/sync/v2" ? next() : express.json()(req, res, next)));
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  bridge.register(app, { addUser, isBotToken: (t) => t === "bot" });
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  PW.register(app, { addUser, noTimers: true });
  ST.register(app, { addUser, noTimers: true });
  await new Promise((r) => { server = app.listen(0, r); });
  server.unref();
  base = "http://127.0.0.1:" + server.address().port;
  CL._setClock(() => Date.now() - 8 * 864e5);
  await CL.setSwitch("notice", true, "test");
  CL._setClock(() => Date.now());
  for (const s of ["archive", "history", "search"]) await CL.setSwitch(s, true, "test");
  await PW.init();
  await PW.setOn(true, { userId: U.adm.userId, username: "adm" });
  await rooms.setOwner(ROOM.id, "own", "test");
  await sync([], { rooms: [snap([real("alicecf", "Alice")])] });
  await sync([ev("message", { user: real("alicecf", "Alice"), text: "hello review pond" })]);
  await settle();
  await CV.init();
  CV._clearCaches();
})();
const R = () => bridge._rooms.get(ROOM.id);

test("A-privacy-8: a snapshot entry with a priv block that doesn't parse is dropped - never named with its real login", async () => {
  await setup;
  const many = Array.from({ length: 40 }, (_, i) => hash("share" + i));
  await sync([], { rooms: [snap([real("alicecf", "Alice"), Object.assign(real("oscarovr", "Oscar"), { priv: { kind: "incognito", h: hash("oscarovr"), hs: many } }),
                                 Object.assign(real("ophelia9", "Ophelia"), { priv: { kind: "nonsense", h: hash("ophelia9") } })],
                                [Object.assign(real("oscarovr", "Oscar"), { priv: { kind: "incognito", h: "nothex" }, proven: true, since: Date.now() / 1000 })])] });
  const all = JSON.stringify([...R().members, ...R().mic]);
  assert.ok(!all.includes("oscarovr") && !all.includes("ophelia9"), "no real login: " + all);
  assert.ok(!R().members.some((e) => e && e.on_cam != null && !e.anon && /oscar|ophelia/i.test(e.display || "")), "never named");
  const lv = await call("GET", `/api/rooms/${SLUG}/live`, { user: U.mem });
  assert.equal(lv.status, 200);
  assert.ok(!lv.text.includes("oscarovr") && !lv.text.includes("Ophelia"), "the live JSON");
});

test("A-compat-2: a veil identity whose login isn't one of the priv block's hashes is refused (event and snapshot)", async () => {
  await setup;
  const before = R().feed.length;
  // Pepe resolved the display name "Bob" to alice2cf, but the incognito key that matched was bob2cf's
  await sync([ev("message", { user: real("alice2cf", "Bob"), text: "whose line is this", priv: priv("incognito", "bob2cf") })],
             { rooms: [snap([real("alicecf", "Alice"), Object.assign(real("alice2cf", "Bob"), { priv: priv("incognito", "bob2cf") })])] });
  assert.equal(R().feed.length, before, "the event isn't stored with the wrong identity");
  assert.ok(!R().members.some((e) => e && e._vz && e._vz.login === "alice2cf"), "nor the roster entry");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM bridge_veil WHERE vz LIKE '%alice2cf%'"))[0].n, 0);
  // the same with the right owner of the hash (h, or one of hs) is fine
  await sync([ev("message", { user: real("bob2cf", "Bob"), text: "my own line", priv: priv("incognito", "bob2cf") }),
              ev("message", { user: real("carl2cf", "Carl"), text: "hs line", priv: priv("incognito", "carlname", { hs: [hash("carl2cf")] }) })]);
  assert.ok(R().feed.some((it) => it._vz && it._vz.login === "bob2cf"));
  assert.ok(R().feed.some((it) => it._vz && it._vz.login === "carl2cf"), "a login among hs counts");
});

test("A-privacy-1 / A-compat-1: 40 named snapshots 30 s apart, then veiled - no frog name (every named roster entry is a sighting)", async () => {
  await setup;
  const room = { id: "C2.Room" };
  const t0 = Date.now() - 25 * 60e3;
  for (let i = 0; i < 40; i++) {
    room.members = await V.snapshotEntries(room, [real("frankc2", "Frankie")], clean);
    room.mic = [];
    await V.nameSnapshot(room, t0 + i * 30e3);
  }
  room.members = await V.snapshotEntries(room, [veiled("frankc2")], clean);
  await V.nameSnapshot(room, t0 + 40 * 30e3);
  const e = room.members[0];
  assert.ok(e && e.anon && e.veil === "incognito", "veiled now");
  assert.equal(e.alias, undefined, "no frog name in the slot their name had: " + e.alias);
  assert.equal(e.id, undefined);
});

test("A-compat-1: a batch's named line counts before its snapshot opens a session; a holder whose hold began named gets no frog name", async () => {
  await setup;
  await sync([ev("message", { user: real("norabatch", "Nora"), text: "named in the backlog" })],
             { rooms: [snap([real("alicecf", "Alice"), veiled("norabatch")])] });
  const n = R().members.find((e) => e._vz && e._vz.login === "norabatch");
  assert.ok(n && n.anon, "veiled in the roster");
  assert.equal(n.alias, undefined, "no frog name: the same batch said their name");
  // began_named: the mic list's entry stays "someone" (the people list may have a name for them)
  await sync([], { rooms: [snap([real("alicecf", "Alice"), veiled("milobn")], [veiled("milobn", "incognito", { proven: true, since: Date.now() / 1000 - 30, began_named: true })])] });
  const m = R().members.find((e) => e._vz && e._vz.login === "milobn");
  const h = R().mic.find((e) => e._vz && e._vz.login === "milobn");
  assert.ok(m && m.alias, "the roster entry has its frog name");
  assert.ok(h && h.anon && h.alias === undefined, "the mic entry of a hold begun named: no frog name");
  // a named grab with a hold id: a veiled 🎙 line of the same hold is "someone" with no hold id
  const hold = "hd-0000cccc0000";
  await sync([ev("mic.grab", { user: Object.assign(real("pennyhold", "Penny"), { proven: true }), hold })]);
  await sync([ev("x.pepe.transcript", { id: "tx-00000000000000c1", user: real("pennyhold", "Penny"), text: "said while veiled mid-hold", source: "mic",
                                        said_at: Date.now() / 1000 - 2, hold, priv: priv("incognito", "pennyhold") })]);
  const lv = await call("GET", `/api/rooms/${SLUG}/live`, { user: U.mem });
  const tx = lv.d.feed.find((o) => o.text === "said while veiled mid-hold");
  assert.ok(tx && tx.u.anon && !tx.u.alias && !tx.hold, "no frog name and no hold id beside the named grab's: " + JSON.stringify(tx));
});

test("A-privacy-6: a veiled roster entry never sits in its join slot (named first, veiled after, by frog name)", async () => {
  await setup;
  await sync([], { rooms: [snap([real("alicecf", "Alice"), veiled("vicslot"), real("bertslot", "Bert"), real("cathslot", "Cath")])] });
  const ms = R().members;
  const i = ms.findIndex((e) => e._vz && e._vz.login === "vicslot");
  assert.ok(i >= 0);
  assert.notEqual(i, 1, "not at its since position");
  assert.ok(ms.slice(0, i).every((e) => !e.anon), "every named entry first");
  const lv = await call("GET", `/api/rooms/${SLUG}/live`, { user: U.mem });
  const names = lv.d.members.map((e) => (e.anon ? "*" : e.login));
  assert.deepEqual(names.slice(0, 3), ["alicecf", "bertslot", "cathslot"], JSON.stringify(names));
});

test("A-compat-5: the away clock starts for a veiled person a restart forgot (seedSeen) and for everyone in a dropped room", async () => {
  await setup;
  const room = { id: "Seed.Room" };
  const t = Date.now();
  room.members = await V.snapshotEntries(room, [veiled("samseed")], clean);
  room.mic = [];
  await V.nameSnapshot(room, t);
  const s = FN.current(room.id, "samseed");
  assert.ok(s && s.session, "a session");
  // a restart: the room comes back from its side tables, the in-memory "seen" set is empty
  const fresh = { id: room.id, members: room.members, mic: [] };
  assert.equal(V.seedSeen(fresh), 1, "seeded from the restored roster");
  fresh.members = [];
  await V.nameSnapshot(fresh, t + 1000);
  await settle();
  assert.ok(Number((await getQuery("SELECT left_at FROM incog_alias WHERE id = ?", [s.session]))[0].left_at) > 0, "their away clock started");
  // dropRoom: Pepe closed the room
  const OTHER = { id: "Drop.Room", name: "Drop Room" };
  await sync([], { rooms: [snap([veiled("dinadrop")], [], OTHER)] });
  const d = FN.current(OTHER.id, "dinadrop");
  assert.ok(d && d.session);
  await bridge.ingest({ events: [], rooms: [], closed: [OTHER.id] }, { v2: true });
  await settle();
  assert.ok(Number((await getQuery("SELECT left_at FROM incog_alias WHERE id = ?", [d.session]))[0].left_at) > 0, "dropRoom started it");
});

test("A-compat-10: a batch and its retry (sent while the first waits on frog names) keep the batch's cursor order", async () => {
  await setup;
  const orig = V.nameItem;
  V.nameItem = async (Rm, it) => { await settle(120); return orig(Rm, it); };
  try {
    const batch = [ev("message", { user: real("alicecf", "Alice"), text: "order one" }),
                   ev("message", { user: real("quinnord", "Quinn"), text: "order two", priv: priv("incognito", "quinnord") }),
                   ev("message", { user: real("alicecf", "Alice"), text: "order three" }),
                   ev("message", { user: real("alicecf", "Alice"), text: "order four" })];
    const p1 = sync(batch);
    await settle(20);
    const p2 = sync(batch);                              // Pepe's retry: the same ids
    await Promise.all([p1, p2]);
  } finally { V.nameItem = orig; }
  const got = R().feed.filter((it) => /^order /.test(it.text || "")).sort((a, b) => a.c - b.c).map((it) => it.text);
  assert.deepEqual(got, ["order one", "order two", "order three", "order four"]);
});

test("A-privacy-4: the reveal's archive path refuses a line its author removed and a line of someone staff hid", async () => {
  await setup;
  await sync([ev("message", { user: real("hankrev", "Hank"), priv: priv("hidden", "hankrev", { words: "words hank deleted" }) }),
              ev("message", { user: real("ivyrev", "Ivy"), priv: priv("hidden", "ivyrev", { words: "words staff hid" }) })]);
  await settle();
  const a = R().feed.find((it) => it._vz && it._vz.login === "hankrev");
  const b = R().feed.find((it) => it._vz && it._vz.login === "ivyrev");
  assert.ok(a && b);
  // both lines leave the live ring (a takedown; an old line beyond the ring) - only the archive can answer now
  await runQuery("UPDATE chat_log SET rm_at = ?, rm_by = 'self', rm_why = NULL WHERE c = ?", [Date.now(), a.c]);
  await bridge.takeDown(ROOM.id, [a.c]);
  R().feed.splice(R().feed.indexOf(b), 1);
  const ok = await call("POST", "/api/chatlog/reveal", { user: U.adm, body: { room: SLUG, c: [b.c] } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.d.items.map((o) => o.login), ["ivyrev"], "an archived line is revealable");
  await CL.hideNow(["ivyrev"], "staff");
  await settle();
  for (const [u, c] of [[U.adm, a.c], [U.own, a.c], [U.adm, b.c], [U.own, b.c]]) {
    const r = await call("POST", "/api/chatlog/reveal", { user: u, body: { room: SLUG, c: [c] } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.d.items, [], `refused for ${u.username} / ${c}: ` + r.text);
    assert.ok(!r.text.includes("words hank deleted") && !r.text.includes("words staff hid"));
  }
});

test("A-privacy-2 / A-privacy-10 / A-tests-ux-01: a masked line is never a search hit, never quoted; staff get no login for it", async () => {
  await setup;
  await sync([ev("message", { user: real("rosiezz", "Rosie"), text: "meet at the zebrapizza place" })]);
  await settle();
  const it = R().feed.find((x) => x.text === "meet at the zebrapizza place");
  const CS = require(path.join(repo, "chatlogsearch"));
  CS._reset();
  const pre = await CS.search(U.own, SLUG, { q: "zebrapizza" });
  assert.ok(pre.hits.some((h) => h.item.c === it.c), "found while named");
  await hidden("rosiezz");
  await settle(80);
  CV._clearCaches();
  assert.equal(CV.privacyOf(it), "mask");
  for (const u of [U.own, U.mem]) {
    CS._reset();
    const r = await CS.search(u, SLUG, { q: "zebrapizza" }).catch((e) => ({ hits: [], err: e.code }));
    assert.ok(!r.hits.some((h) => h.item.c === it.c), "no hit for " + u.username + ": " + JSON.stringify(r.hits));
    assert.ok(!JSON.stringify(r).includes("zebrapizza"));
  }
  const Q = require(path.join(repo, "quotes"));
  assert.ok(!Q.shownFeed(R().feed).includes(it), "Pepe's !quote never picks it");
  assert.ok(Q.pick(R().feed, { cs: [it.c] }).error, "nor a website selection");
  // the report queue: staff see "someone", no login, needs an admin
  await runQuery("INSERT INTO chatlog_reports (c, rk, reporter, reason, note, state, created) SELECT c, rk, ?, 'spam', '', 'open', ? FROM chat_log WHERE c = ?",
                 [U.mem.userId, Date.now(), it.c]);
  const CM = require(path.join(repo, "chatlogmod"));
  const L = await CM.reportRead(U.staff, it.c);
  assert.equal(L.login, null, "no login for a masked line");
  assert.equal(L.text, null);
  assert.equal(L.needs_admin, true);
  assert.ok(/^\/p\//.test(L.link || ""), "a link to the line for an admin");
  const au = (await getQuery("SELECT who FROM chatlog_views ORDER BY id DESC LIMIT 1"))[0];
  assert.ok(!au || au.who !== "rosiezz", "nor in the audit row");
});

test("A-privacy-7: a v2 hidden line of someone left out only for !bridge hide stays in scrollback as a bar", async () => {
  await setup;
  await sync([ev("message", { user: real("hanklong", "Hank"), priv: priv("hidden", "hanklong", { words: "a long ago hidden line" }) })], { bridge_hidden_h: [hash("hanklong")] });
  await hidden("hanklong");
  await settle(80);
  const it = R().feed.find((x) => x._vz && x._vz.login === "hanklong");
  assert.ok(it);
  const CH = require(path.join(repo, "chatloghist"));
  CH._reset();
  assert.ok(!CH.hiddenLogins("history").out.includes("h:" + hash("hanklong")), "read by scrollback (masked by the projection)");
  assert.ok(CH.hiddenLogins("search").out.includes("h:" + hash("hanklong")), "skipped by search");
  const pg = await CH.page(U.own, SLUG, { limit: 200 });
  const row = (pg.items || []).find((o) => o.c === it.c);
  assert.ok(row && row.mask && !("text" in row), "a bar in scrollback: " + JSON.stringify(row));
  assert.ok(!JSON.stringify(pg).includes("a long ago hidden line"));
});

test("A-privacy-9: the per-login tool's summary after hold reaches no veiled row (no see-through row written)", async () => {
  await setup;
  await sync([ev("message", { user: real("ginaveil", "Gina"), text: "gina frog words", priv: priv("incognito", "ginaveil") })]);
  await settle();
  const CM = require(path.join(repo, "chatlogmod"));
  const n0 = (await getQuery("SELECT COUNT(*) AS n FROM seethrough_log"))[0].n;
  const r = await CM.whoAction(U.adm, "ginaveil", { action: "hold", why: "case 77" });
  assert.equal(r.summary.lines, 0, "no named rows");
  assert.equal(r.summary.rooms.length, 0, "no per-room counts of veiled rows");
  assert.ok(r.summary.veiled >= 1, "a count only");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM seethrough_log"))[0].n, n0);
  await CM.whoAction(U.adm, "ginaveil", { action: "unhold", why: "case 77 done" });
  // a look does reach them - logged
  const look = await CM.whoAction(U.adm, "ginaveil", { action: "look", why: "case 78" });
  assert.ok(look.summary.lines >= 1);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM seethrough_log WHERE scope = 'chat_tool'"))[0].n, 1);
});

test("A-privacy-3: a frog-name clip's queued action carries no speaker login (it is the clipper's row)", async () => {
  await setup;
  const MC = require(path.join(repo, "micclip"));
  const got = [];
  MC._setDeps({ queueAction: async (uid, a) => { got.push({ uid, a }); return 4242; }, clipSwitch: () => true });
  await runQuery("UPDATE users SET camfrogUsername = 'memcf' WHERE userId = ?", [U.mem.userId]);
  const id = "w" + crypto.randomBytes(8).toString("hex");
  MC._clips.set(id, { id, userId: U.mem.userId, username: "mem", roomId: ROOM.id, login: "frankclip", alias: "Soggy Bullfrog", state: "ready", done: Date.now(),
                      ts: Date.now(), secs: 8, text: "a turn", viewerOk: true, cost: 0 });
  const r = await call("POST", `/api/rooms/${SLUG}/micclip/${id}/save`, { user: U.mem, body: { start: 0, end: 8000 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(got.length, 1);
  assert.ok(!JSON.stringify(got[0].a).includes("frankclip"), "no login in the action: " + JSON.stringify(got[0].a));
  assert.equal(got[0].a.args[2], id, "the clip id names it (Pepe takes the target from micclipdata)");
  // the bot's micclipdata still says who, bot to site only
  const d = await call("POST", "/api/bridge/micclipdata", { body: { password: "bot", id, user: "mem" } });
  assert.equal(d.status, 404, "no preview file in this test - but never through a user's row");
});

test("A-compat-4: a named line said after the switch went OFF stays left out when its speaker goes !bridge hide (only on-time lines are masked)", async () => {
  await setup;
  await PW.setOn(false, { userId: U.adm.userId, username: "adm" });
  try {
    await sync([], {});
    await bridge.ingest({ events: [ev("message", { user: real("walteroff", "Walter"), text: "said while the switch was off" })], rooms: [], bridge_hidden_h: [], incog_hidden_h: [] });
    const it = R().feed.find((x) => x.text === "said while the switch was off");
    assert.ok(it && it.ts >= PW.gAt());
    await hidden("walteroff");
    await settle(80);
    assert.equal(CV.privacyOf(it), "out", "Pepe's v1 promise: left out");
    assert.equal(PW.wasOnAt(it.ts), false);
    assert.equal(PW.wasOnAt(PW.gAt() + 1), true, "the on period before is remembered");
  } finally { await PW.setOn(true, { userId: U.adm.userId, username: "adm" }); }
});

test("A-privacy-5: incognito -> hidden with named lines on the page ends the frog name (C.2: the next sighting is 'someone')", async () => {
  await setup;
  const t0 = Date.now() + 1000;
  assert.ok(t0 > PW.gAt());
  // xena chats named (after G), then goes incognito 20 min later (a frog name: no named sighting in 15 min), then !bridge hide
  await sync([ev("message", { user: real("xenaswap", "Xena"), text: "xena named line" }, t0)]);
  await sync([ev("message", { user: real("xenaswap", "Xena"), text: "xena frog line", priv: priv("incognito", "xenaswap") }, t0 + 20 * 60e3)]);
  const f = R().feed.find((x) => x.text === "xena frog line");
  assert.ok(f && f.u.alias, "a frog name while incognito");
  await bridge.ingest({ events: [{ op: "event", id: "vr-pi-" + (++seq), ts: new Date().toISOString(), type: "privacy.hidden", scope: { platform: "camfrog" },
                                   data: { h: hash("xenaswap"), scope: "incognito" } }], rooms: [], bridge_hidden_h: [], incog_hidden_h: [hash("xenaswap")] });
  await settle(80);
  assert.ok(FN.current(ROOM.id, "xenaswap") && FN.current(ROOM.id, "xenaswap").alias, "still the frog name while only incognito");
  await hidden("xenaswap");
  await settle(80);
  assert.equal(FN.current(ROOM.id, "xenaswap"), null, "the frog name's session ended with the switch to hidden");
  await sync([ev("message", { user: real("xenaswap", "Xena"), priv: priv("hidden", "xenaswap", { words: "xena hidden words" }) })]);
  const h = R().feed.filter((x) => x._vz && x._vz.login === "xenaswap" && x.u.veil === "hidden").pop();
  assert.ok(h && !h.u.alias, "the next sighting: 'someone' (a bar), not the old frog name");
});

test("A-tests-ux-08: two incognito speakers alternating keep two names and ids; an astral-emoji hidden line's bar counts code points", async () => {
  await setup;
  await sync([ev("message", { user: real("ottoalt", "Otto"), text: "otto one", priv: priv("incognito", "ottoalt") }),
              ev("message", { user: real("pippaalt", "Pippa"), text: "pippa one", priv: priv("incognito", "pippaalt") }),
              ev("message", { user: real("ottoalt", "Otto"), text: "otto two", priv: priv("incognito", "ottoalt") }),
              ev("message", { user: real("pippaalt", "Pippa"), text: "pippa two", priv: priv("incognito", "pippaalt") }),
              ev("message", { user: real("emmaemoji", "Emma"), priv: priv("hidden", "emmaemoji", { words: "🐸".repeat(24) }) })]);
  const lv = await call("GET", `/api/rooms/${SLUG}/live`, { user: U.mem });
  const by = (t) => lv.d.feed.find((o) => o.text === t);
  const [o1, p1, o2, p2] = ["otto one", "pippa one", "otto two", "pippa two"].map(by);
  assert.ok(o1.u.alias && p1.u.alias && o1.u.alias !== p1.u.alias, "two names");
  assert.equal(o1.u.alias, o2.u.alias); assert.equal(o1.u.id, o2.u.id);
  assert.equal(p1.u.alias, p2.u.alias); assert.equal(p1.u.id, p2.u.id);
  assert.notEqual(o1.u.id, p1.u.id, "two opaque ids");
  assert.notEqual(o1.u.alias.split(" ")[0], p1.u.alias.split(" ")[0], "no shared word (C.4)");
  for (const x of ["ottoalt", "pippaalt", "Otto", "Pippa", "emmaemoji", "🐸🐸"]) assert.ok(!lv.text.includes(x), "nothing of who: " + x);
  const e = lv.d.feed.filter((o) => o.u && o.u.veil === "hidden" && o.mask).pop();
  assert.equal(e.mask, "s", "24 astral emoji = 24 code points = a short bar (UTF-16 would say 48: medium)");
});
