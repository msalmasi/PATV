// wave 2 WP-2 (incognito / mic-stage spec A.4-A.6, B.2, C.2, D, E.1-E.6, J-7, J-8; I.3): the website side of the privacy wire v2
// beyond the shared contract (test/privwire-contract.test.js):
//   * storage: bridge_veil rows live and die with their feed rows (the ring trim, a takedown, dropRoom), bridge_rooms_veil with the
//     room; chat_log_veil is written beside its archive row and dies with it (retention delete) and on purge (J-17: no other cap);
//     the FTS index never holds a hidden speaker's words or a veiled login; a restart re-attaches identities from the side tables
//   * the invariant: every veiled entry in R.members / R.mic / R.feed is anon (the readers that stage or open cams skip it)
//   * the projection matrix: a signed-out viewer, a member, staff, the pad's owner and an admin get the SAME dressed lines for
//     veiled people (owner / admin + rv flags only), the speaker their own words (self: 1); nothing of who in any of them
//   * C.2 (no frog name within 15 minutes of a named sighting) and J-8 (a new name after 1 h+ away)
//   * the G rule: a named line said after G whose speaker then goes !bridge hide is masked ("someone" + a bar); before G - or
//     forget-me - it stays out
//   * see-through (E.1, J-18): an admin's reveal (one log row, chat_line), the owner in their era, refusals (a member, staff, the
//     owner of another pad, an owner whose era nothing dates - owner_grant never counts), the toggle (one row per on, closed by
//     off, batch fetches counted on it), plain viewing logs nothing
//   * forget-me: the person's veil rows go everywhere and their veiled live lines leave
//   * J-7: anyone may clip an incognito frog-name 🎙 line - the job carries the frog name, the page never the login; hidden: refused
//   node --test test/veil-site.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "veil-site-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
process.env.ALIAS_SECRET = "cd".repeat(32);
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
require(path.join(repo, "terms"))._setRequired(false);
const bridge = require(path.join(repo, "bridge"));
const relay = require(path.join(repo, "bridge-relay"));
const CL = require(path.join(repo, "chatlog"));
const CV = require(path.join(repo, "chatlogview"));
const PW = require(path.join(repo, "privwire"));
const FN = require(path.join(repo, "frognames"));
const ST = require(path.join(repo, "seethrough"));

const D = 864e5;
const hash = (login) => crypto.createHash("sha256").update("pepe-hidden:" + String(login).trim().toLowerCase()).digest("hex").slice(0, 20);
const ROOM = { id: "Veil.Room", name: "Veil Room" }, SLUG = "veil-room";
const OTHER = { id: "Other.Room", name: "Other Room" };
const ALIAS_RE = /^(?:[A-Z][A-Za-z-]{1,15} [A-Z][A-Za-z]{1,15}|Mystery Frog \d{1,4})$/;
const users = new Map();
const U = {};
let base, server, seq = 0;
const ev = (type, data, ts = Date.now(), room = ROOM) => ({ op: "event", id: "vs-" + (++seq), ts: new Date(ts).toISOString(), type, scope: { platform: "camfrog", room }, data });
const real = (login, display) => ({ id: login.toLowerCase(), login, display: display || login });
const priv = (kind, login, extra = {}) => Object.assign({ kind, h: hash(login), at: Date.now() / 1000 }, extra);
const sync = (events, extra = {}) => bridge.ingest(Object.assign({ events, rooms: [], bridge_hidden_h: [], incog_hidden_h: [] }, extra), { v2: true });
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

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
      res.on("end", () => { let d = null; try { d = JSON.parse(s); } catch (e) { d = null; } resolve({ status: res.statusCode, d, text: s, headers: res.headers }); });
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
const live = (user, slug = SLUG) => call("GET", `/api/rooms/${slug}/live`, { user });
// what never reaches a page: the veiled people, their hashes, the hidden words
const VEILED = ["frankiefettuccine", "Frankie Fett", "hankhidden", "Hank Hide"];
const WORDS = ["the secret hidden sentence about pizza", "only hank knows this"];
const leaks = (json) => [...VEILED, ...WORDS, ...VEILED.map(hash), "\"_vz\"", "\"vz\"", "\"vw\"", "\"priv\"", "\"ah\"", "\"ahs\""].filter((x) => json.includes(x));

const setup = (async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await require(path.join(repo, "inbox")).ready;
  U.own = await mkUser("own", "pleb", "owncf");
  U.own2 = await mkUser("own2", "pleb", "own2cf");
  U.mem = await mkUser("mem", "pleb", "memcf");
  U.staff = await mkUser("helper", "Staff");
  U.adm = await mkUser("adm", "Admin", "admcf");
  U.frankie = await mkUser("frankie", "pleb", "frankiefettuccine");     // the incognito speaker's own account (self view)
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
  // the archive on (the notice 8 days ago) and scrollback on; the switch on (G now)
  CL._setClock(() => Date.now() - 8 * D);
  await CL.setSwitch("notice", true, "test");
  CL._setClock(() => Date.now());
  for (const s of ["archive", "history"]) await CL.setSwitch(s, true, "test");
  await PW.init();
  await PW.setOn(true, { userId: U.adm.userId, username: "adm" });
  await rooms.setOwner(ROOM.id, "own", "test");
  await rooms.setOwner(OTHER.id, "own2", "test").catch(() => {});
  // a roster with a veiled member and holder, and a few lines
  await sync([], { rooms: [{ room: ROOM, members: [real("alicecf", "Alice"), Object.assign(real("frankiefettuccine", "Frankie Fett"), { priv: priv("incognito", "frankiefettuccine"), src: "list", on_mic: true }),
                                                  Object.assign(real("hankhidden", "Hank Hide"), { priv: priv("hidden", "hankhidden"), src: "list" })],
                              mic: [Object.assign(real("frankiefettuccine", "Frankie Fett"), { priv: priv("incognito", "frankiefettuccine"), proven: true, since: Date.now() / 1000 })],
                              count: 4, transcripts: true }] });
  await sync([
    ev("message", { user: real("alicecf", "Alice"), text: "hello pond" }),
    ev("message", { user: real("frankiefettuccine", "Frankie Fett"), text: "pizza time", priv: priv("incognito", "frankiefettuccine") }),
    ev("message", { user: real("hankhidden", "Hank Hide"), priv: priv("hidden", "hankhidden", { words: WORDS[0] }) }),
    ev("x.pepe.transcript", { id: "tx-00000000000000a1", user: real("frankiefettuccine", "Frankie Fett"), text: "said on the mic by a frog", source: "mic",
                              said_at: Date.now() / 1000 - 5, priv: priv("incognito", "frankiefettuccine") }),
    ev("x.pepe.transcript", { id: "tx-00000000000000b1", user: real("hankhidden", "Hank Hide"), source: "mic", said_at: Date.now() / 1000 - 4,
                              priv: priv("hidden", "hankhidden", { words: WORDS[1] }) }),
  ]);
  await settle();
  await CV.init();
  CV._clearCaches();
})();

test("storage: identities only in the side tables; bridge_veil dies with its feed row (takedown, the ring trim, dropRoom); a restart re-attaches", async () => {
  await setup;
  const R = bridge._rooms.get(ROOM.id);
  const veiled = R.feed.filter((it) => it.u && it.u.veil);
  assert.equal(veiled.length, 4, "4 veiled lines");
  for (const it of veiled) {
    assert.equal(it.u.anon, true, "invariant: anon");
    assert.ok(it._vz && it._vz.login, "the identity hangs on it, non-enumerable");
    assert.ok(!Object.keys(it).includes("_vz") && !JSON.stringify(it).includes("_vz"), "never serialised");
  }
  for (const e of [...R.members, ...R.mic]) if (e.veil) { assert.equal(e.anon, true); assert.ok(!("on_cam" in e)); assert.ok(!e.login); }
  const bf = (await getQuery("SELECT data FROM bridge_feed WHERE room_id = ?", [ROOM.id])).map((r) => r.data).join("\n");
  assert.deepEqual(leaks(bf.replace(/"ahs?":(\[[^\]]*\]|"[0-9a-f]{20}")/g, "")), [], "bridge_feed JSON");
  const bv = await getQuery("SELECT c, vz, vw FROM bridge_veil WHERE room_id = ?", [ROOM.id]);
  assert.equal(bv.length, 4);
  assert.ok(bv.some((r) => r.vw === WORDS[0]), "the hidden words live here only");
  const rv = await getQuery("SELECT data FROM bridge_rooms_veil WHERE id = ?", [ROOM.id]);
  assert.equal(rv.length, 1, "the roster's identities");
  // a takedown deletes the feed row -> its veil row (trigger). (Review fix A-tests-ux-08: the takedown itself, awaited - it takes
  // the line out of R.feed and bridge_feed, and the trigger takes its identity row)
  const one = veiled[0].c;
  assert.equal(await bridge.takeDown(ROOM.id, [one]), 1, "the takedown took the live line");
  assert.ok(!R.feed.some((it) => it.c === one), "gone from the live feed");
  assert.equal((await getQuery("SELECT 1 FROM bridge_feed WHERE c = ?", [one])).length, 0, "and from bridge_feed");
  assert.equal((await getQuery("SELECT 1 FROM bridge_veil WHERE c = ?", [one])).length, 0, "the veil row went with its feed row");
  // the ring trim: a feed row deleted below the live window takes its veil row too
  const two = veiled[1].c;
  await runQuery("DELETE FROM bridge_feed WHERE room_id = ? AND c <= ?", [ROOM.id, two]);
  assert.equal((await getQuery("SELECT 1 FROM bridge_veil WHERE c = ?", [two])).length, 0, "the ring trim drops the veil row");
  // the archive: chat_log_veil beside each veiled row; the FTS index never holds hidden words or veiled logins
  const cv = await getQuery("SELECT c, login, kind, words FROM chat_log_veil ORDER BY c");
  assert.equal(cv.length, 4, "chat_log_veil rows");
  assert.ok(cv.every((r) => ["frankiefettuccine", "hankhidden"].includes(r.login)));
  const hid = await getQuery("SELECT c, text, who FROM chat_log WHERE c IN (" + cv.filter((r) => r.kind === "hidden").map((r) => r.c).join(",") + ")");
  assert.ok(hid.every((r) => r.text === null && /^h:[0-9a-f]{20}$/.test(r.who)), "a hidden line's archive text is NULL, who h:<hash>");
  const fts = JSON.stringify(await getQuery("SELECT rowid, text FROM chat_log_fts"));
  for (const x of [...WORDS, "frankiefettuccine", "hankhidden", "Frankie Fett"]) assert.ok(!fts.includes(x), "FTS: " + x);
  // retention / purge: the veil row follows its chat_log row (J-17: no separate cap)
  const [a, b] = cv;
  await runQuery("UPDATE chat_log SET purged = 1, text = NULL WHERE c = ?", [a.c]);
  assert.equal((await getQuery("SELECT 1 FROM chat_log_veil WHERE c = ?", [a.c])).length, 0, "purge drops it");
  await runQuery("DELETE FROM chat_log WHERE c = ?", [b.c]);
  assert.equal((await getQuery("SELECT 1 FROM chat_log_veil WHERE c = ?", [b.c])).length, 0, "a retention delete drops it");
});

test("storage: dropRoom takes the room's veil rows; a restart re-attaches identities from the side tables (never from the JSON)", async () => {
  await setup;
  const V = require(path.join(repo, "veil"));
  await sync([ev("message", { user: real("hankhidden", "Hank Hide"), priv: priv("hidden", "hankhidden", { words: "other room words" }) }, Date.now(), OTHER)],
             { rooms: [{ room: OTHER, members: [Object.assign(real("hankhidden", "Hank Hide"), { priv: priv("hidden", "hankhidden") })], mic: [], count: 1 }] });
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM bridge_veil WHERE room_id = ?", [OTHER.id]))[0].n, 1);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM bridge_rooms_veil WHERE id = ?", [OTHER.id]))[0].n, 1);
  // a restart: the rows as a fresh process reads them - page-safe JSON + the side tables
  const fresh = { id: ROOM.id, feed: (await getQuery("SELECT c, data FROM bridge_feed WHERE room_id = ? ORDER BY c", [ROOM.id])).map((r) => Object.assign(JSON.parse(r.data), { c: r.c })) };
  assert.ok(!fresh.feed.some((it) => it._vz), "nothing in the JSON");
  const n = await V.attachFeedVeil(fresh);
  assert.ok(n >= 1 && fresh.feed.filter((it) => it.u && it.u.veil).every((it) => it._vz && it._vz.login), "re-attached from bridge_veil");
  const snap = JSON.parse((await getQuery("SELECT snap FROM bridge_rooms WHERE id = ?", [ROOM.id]))[0].snap);
  const roomVeil = (await getQuery("SELECT data FROM bridge_rooms_veil WHERE id = ?", [ROOM.id]))[0].data;
  assert.ok(V.attachRoomVeil(snap, roomVeil) >= 2 && snap.members.filter((e) => e.veil).every((e) => e._vz), "the roster too");
  // dropRoom (Pepe closed the room)
  await bridge.ingest({ events: [], rooms: [], closed: [OTHER.id] }, { v2: true });
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM bridge_veil WHERE room_id = ?", [OTHER.id]))[0].n, 0, "bridge_veil rows went with the feed rows");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM bridge_rooms_veil WHERE id = ?", [OTHER.id]))[0].n, 0, "bridge_rooms_veil went with the room");
});

test("the projection: every role gets the same veiled lines (owner / admin + rv flags), the speaker their own words; nothing of who", async () => {
  await setup;
  // fresh lines for this test (the storage test took some down)
  await sync([
    ev("message", { user: real("frankiefettuccine", "Frankie Fett"), text: "second frog line", priv: priv("incognito", "frankiefettuccine") }),
    ev("message", { user: real("hankhidden", "Hank Hide"), priv: priv("hidden", "hankhidden", { words: WORDS[0] }) }),
  ]);
  CV._clearCaches();
  const strip = (feed) => feed.filter((o) => o.u && o.u.veil).map((o) => { const x = JSON.parse(JSON.stringify(o)); delete x.rv; delete x.own; return x; });
  const views = {};
  for (const [k, u] of Object.entries({ anon: null, mem: U.mem, staff: U.staff, own: U.own, adm: U.adm })) {
    const r = await live(u);
    if (k === "anon") { assert.equal(r.status, 401, "a Members pad: signed out sees nothing"); assert.deepEqual(leaks(r.text), []); continue; }
    assert.equal(r.status, 200, k + ": " + r.text.slice(0, 200));
    assert.deepEqual(leaks(r.text), [], k + " sees nothing of who: " + leaks(r.text).join(", "));
    views[k] = r.d;
  }
  const mem = strip(views.mem.feed);
  assert.ok(mem.length >= 2);
  assert.deepEqual(strip(views.staff.feed), mem, "staff = members (no see-through, J-2)");
  assert.deepEqual(strip(views.own.feed), mem, "the owner before a reveal = members");
  assert.deepEqual(strip(views.adm.feed), mem, "an admin before a reveal = members");
  assert.ok(!views.mem.feed.some((o) => o.rv) && !views.staff.feed.some((o) => o.rv), "no rv for members / staff");
  assert.ok(views.adm.feed.some((o) => o.rv === 1), "rv for an admin");
  const h = mem.find((o) => o.mask);
  assert.ok(h && !("text" in h) && h.u.veil === "hidden" && ALIAS_RE.test(h.u.alias), "hidden: a frog name + a bar, no words");
  const f = mem.find((o) => o.k === "msg" && o.text === "second frog line");
  assert.ok(f && f.u.veil === "incognito" && ALIAS_RE.test(f.u.alias), "incognito: a frog name + the words");
  // the speaker themself (their linked login): self: 1 on their own lines
  const self = await live(U.frankie);
  const mine = self.d.feed.filter((o) => o.self === 1);
  assert.ok(mine.length >= 1 && mine.every((o) => o.u.alias === f.u.alias), "self view on their own frog-name lines");
  assert.ok(!self.d.feed.some((o) => o.self === 1 && o.mask), "hank's bar is never 'self' for frankie");
  // the homepage panel: the member view, never a reveal flag
  const home = JSON.stringify(await bridge.liveFor(SLUG, U.adm));
  assert.deepEqual(leaks(home), []);
  assert.ok(!home.includes("\"rv\""), "never a reveal flag on the homepage panel");
});

test("C.2: no frog name within 15 minutes of a named sighting; J-8: a new name after 1 h+ away", async () => {
  await setup;
  const t0 = Date.now();
  // quinn is seen NAMED, then switches incognito right away: "someone" (no name next to the named line)
  await sync([ev("message", { user: real("quinnquiet", "Quinn"), text: "named first" }, t0)]);
  await sync([ev("message", { user: real("quinnquiet", "Quinn"), text: "now incognito", priv: priv("incognito", "quinnquiet") }, t0 + 1000)]);
  const R = bridge._rooms.get(ROOM.id);
  const q1 = R.feed.find((it) => it.text === "now incognito");
  assert.ok(q1 && q1.u.veil === "incognito" && !q1.u.alias, "right after a named sighting: no frog name");
  // their session ends after 1 h+ away; the next appearance (no named sighting in the last 15 min) gets a name
  await FN.left(ROOM.id, "quinnquiet", t0 + 2000);
  FN._setClock(() => t0 + 2 * 3600e3);
  try {
    await FN.sweep(t0 + 2 * 3600e3);
    await sync([ev("message", { user: real("quinnquiet", "Quinn"), text: "back later", priv: priv("incognito", "quinnquiet") }, t0 + 2 * 3600e3)]);
  } finally { FN._setClock(null); }
  const q2 = R.feed.find((it) => it.text === "back later");
  assert.ok(q2 && ALIAS_RE.test(q2.u.alias || ""), "a fresh appearance: a frog name");
  assert.notEqual(q2.u.alias, (R.feed.find((it) => it.u && it.u.veil && it._vz && it._vz.login === "frankiefettuccine") || { u: {} }).u.alias, "not frankie's");
});

test("1.99?? (owner 2026-11-03, cyberbaby2): seen named, then incognito in the room - 'someone' at +5 and +14 minutes, a frog name at +16; the earlier lines stay 'someone'", async () => {
  await setup;
  const t0 = Date.now(), M = 60e3;
  await sync([ev("message", { user: real("cyberbaby2", "cyberbaby2"), text: "cb named line" }, t0)]);
  const say = (text, at) => sync([ev("message", { user: real("cyberbaby2", "cyberbaby2"), text, priv: priv("incognito", "cyberbaby2") }, at)]);
  await say("cb at five", t0 + 5 * M);
  await say("cb at fourteen", t0 + 14 * M);
  await say("cb at sixteen", t0 + 16 * M);
  await say("cb at twenty", t0 + 20 * M);
  const R = bridge._rooms.get(ROOM.id);
  const line = (text) => R.feed.find((it) => it.text === text);
  for (const text of ["cb at five", "cb at fourteen"]) {
    const it = line(text);
    assert.ok(it && it.u.veil === "incognito" && !it.u.alias && !it.u.id, text + ": someone");
  }
  const s16 = line("cb at sixteen"), s20 = line("cb at twenty");
  assert.ok(s16 && ALIAS_RE.test(s16.u.alias || "") && s16.u.id, "+16 min: a frog name (and its session id)");
  assert.equal(s20.u.alias, s16.u.alias, "kept from then on");
  CV._clearCaches();
  const r = await live(U.mem);
  assert.equal(r.status, 200);
  const page = (text) => r.d.feed.find((o) => o.text === text);
  assert.ok(!JSON.stringify(["cb at five", "cb at fourteen", "cb at sixteen"].map(page)).includes("cyberbaby2"), "never the login on a veiled line");
  assert.ok(!page("cb at five").u.alias && !page("cb at fourteen").u.alias, "the lines said as 'someone' stay 'someone' on the page");
  assert.equal(page("cb at sixteen").u.alias, s16.u.alias);
});

test("B.2: a hold that began named releases as 'someone'; an unproven holder is 'someone'", async () => {
  await setup;
  const hold = "hd-0000aaaa0000";
  await sync([ev("mic.grab", { user: real("alicecf", "Alice"), hold })]);
  await sync([ev("mic.release", { user: Object.assign(real("alicecf", "Alice"), { proven: true }), held_ms: 9000, hold, began_named: true,
                                   priv: priv("incognito", "alicecf") })]);
  await sync([ev("mic.grab", { user: Object.assign(real("frankiefettuccine", "Frankie Fett"), { proven: false }), hold: "hd-0000bbbb0000",
                                priv: priv("incognito", "frankiefettuccine") })]);
  const lv = await live(U.mem);
  const rel = lv.d.feed.filter((o) => o.k === "unmic" && o.u.anon).pop();
  assert.ok(rel && !rel.u.alias && !rel.hold, "a began-named release: 'someone', no hold (it would pair with the named grab)");
  const unp = lv.d.feed.filter((o) => o.k === "mic" && o.u.anon).pop();
  assert.ok(unp && !unp.u.alias, "an unproven holder: 'someone'");
});

test("the G rule: a named line said after G of someone who then goes !bridge hide is masked; before G or after forget-me it is out", async () => {
  await setup;
  const g = PW.gAt();
  assert.ok(g > 0);
  await sync([ev("message", { user: real("rosiered", "Rosie"), text: "rosie before hiding" }, Date.now())]);
  const R = bridge._rooms.get(ROOM.id);
  const it = R.feed.find((x) => x.text === "rosie before hiding");
  const old = Object.assign({}, it, { ts: g - 60e3 });              // the same line, said before G
  assert.equal(CV.privacyOf(it), null, "named");
  // Pepe says rosie typed !bridge hide (privacy.hidden scope bridge)
  await bridge.ingest({ events: [{ op: "event", id: "vs-ph-1", ts: new Date().toISOString(), type: "privacy.hidden", scope: { platform: "camfrog" },
                                   data: { h: hash("rosiered"), scope: "bridge" } }], rooms: [], bridge_hidden_h: [hash("rosiered")], incog_hidden_h: [] });
  await settle(80);
  assert.equal(CV.privacyOf(it), "mask", "after G: masked");
  assert.equal(CV.privacyOf(old), "out", "before G: left out (old rules)");
  const lv = await live(U.mem);
  const o = lv.d.feed.find((x) => x.c === it.c);
  assert.ok(o && o.mask && !("text" in o) && o.u.anon && !o.u.alias, "'someone' with a bar, no frog name (A.1)");
  await CL.hideNow(["rosiered"], "forget");
  await settle(40);
  assert.equal(CV.privacyOf(it), "out", "forget-me: out");
});

test("see-through: an admin's reveal (one log row), the owner in their era, refusals; the toggle; viewing logs nothing", async () => {
  await setup;
  await sync([ev("message", { user: real("hankhidden", "Hank Hide"), priv: priv("hidden", "hankhidden", { words: "reveal me please" }) })]);
  const R = bridge._rooms.get(ROOM.id);
  const it = R.feed.filter((x) => x.u && x.u.veil === "hidden").pop();
  const before = (await getQuery("SELECT COUNT(*) AS n FROM seethrough_log"))[0].n;
  await live(U.adm); await live(U.own);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM seethrough_log"))[0].n, before, "viewing writes nothing");
  const r = await call("POST", "/api/chatlog/reveal", { user: U.adm, body: { room: SLUG, c: [it.c], reason: "report #7" } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.d.items.map((o) => [o.login, o.words]), [["hankhidden", "reveal me please"]]);
  const row = (await getQuery("SELECT * FROM seethrough_log ORDER BY id DESC LIMIT 1"))[0];
  assert.equal(row.scope, "chat_line");
  assert.equal(row.role, "admin");
  assert.equal(row.reason, "report #7");
  assert.deepEqual(JSON.parse(row.logins), ["hankhidden"]);
  // (review fix A-tests-ux-08: the headers asserted, not a vacuous `|| true`)
  assert.match(String(r.headers["cache-control"] || ""), /private/, "Cache-Control: private");
  assert.match(String(r.headers["cache-control"] || ""), /no-store/, "Cache-Control: no-store");
  assert.equal(r.headers["referrer-policy"], "no-referrer");
  // refusals
  assert.equal((await call("POST", "/api/chatlog/reveal", { user: U.mem, body: { room: SLUG, c: [it.c] } })).status, 403, "a member");
  assert.equal((await call("POST", "/api/chatlog/reveal", { user: U.staff, body: { room: SLUG, c: [it.c] } })).status, 403, "staff (J-2)");
  assert.equal((await call("POST", "/api/chatlog/reveal", { user: U.own2, body: { room: SLUG, c: [it.c] } })).status, 403, "the owner of another pad");
  assert.equal((await call("POST", "/api/chatlog/reveal", { user: U.adm, body: { room: SLUG, c: [it.c] }, headers: { "x-requested-with": "" } })).status, 403, "fetch only");
  // the owner, in their era (the 'owner' event dates it; owner_grant is never read)
  const ro = await call("POST", "/api/chatlog/reveal", { user: U.own, body: { room: SLUG, c: [it.c] } });
  assert.equal(ro.status, 200, ro.text);
  assert.equal(ro.d.items.length, 1, "the owner reveals a line said in their era");
  const era = await ST.ownerEra(ROOM.id, U.own.userId);
  const oldOne = await ST.revealChat({ user: U.own, role: { role: "owner", since: era }, roomId: ROOM.id, cs: [it.c], lookup: async () => ({ ts: era - 1000, vz: { login: "x", kind: "incognito" } }) });
  assert.equal(oldOne.items.length, 0, "a line said before the owner's era: refused");
  // owner_grant alone never makes an owner: an era nothing dates fails closed
  await runQuery("UPDATE chatlog_rooms SET owner_grant = 1, owner_since = 0 WHERE room_id = ?", [ROOM.id]);
  await runQuery("DELETE FROM room_events WHERE room_id = ? AND what = 'owner'", [ROOM.id]);
  assert.equal(await ST.ownerEra(ROOM.id, U.own.userId), 0, "owner_since 0 + no 'owner' event + owner_grant -> no era");
  assert.equal(await ST.chatRole(U.own, ROOM.id), null);
  // the toggle: one row when it goes on (chat_toggle), closed when off; batch fetches counted on it
  const on = await call("POST", "/api/chatlog/seethrough", { user: U.adm, body: { room: SLUG, on: true, reason: "sweep" } });
  assert.equal(on.status, 200, on.text);
  const tg = (await getQuery("SELECT * FROM seethrough_log WHERE scope = 'chat_toggle' ORDER BY id DESC LIMIT 1"))[0];
  assert.ok(tg && tg.ended == null);
  const fetched = await call("POST", "/api/chatlog/reveal", { user: U.adm, body: { room: SLUG, c: [it.c], toggle: true } });
  assert.equal(fetched.status, 200);
  assert.equal((await getQuery("SELECT n FROM seethrough_log WHERE id = ?", [tg.id]))[0].n, 1, "the batch counted on the toggle's row");
  await call("POST", "/api/chatlog/seethrough", { user: U.adm, body: { room: SLUG, on: false } });
  assert.ok((await getQuery("SELECT ended FROM seethrough_log WHERE id = ?", [tg.id]))[0].ended > 0, "closed");
  assert.equal((await call("POST", "/api/chatlog/reveal", { user: U.adm, body: { room: SLUG, c: [it.c], toggle: true } })).status, 409, "off: no batch fetch");
});

test("J-7: an incognito frog-name 🎙 line can be clipped by anyone under its frog name - never a login on the page; a hidden one can't", async () => {
  await setup;
  // the clipper needs a linked login and the room's !clip on
  const deps = require(path.join(repo, "micclip"))._deps || null;
  void deps;
  const R = bridge._rooms.get(ROOM.id);
  R.clipOn = true;
  const fr = R.feed.find((x) => x.k === "tx" && x.u && x.u.veil === "incognito" && x.u.alias);
  const hk = R.feed.find((x) => x.k === "tx" && x.u && x.u.veil === "hidden");
  assert.ok(fr && hk);
  const lv = await live(U.mem);
  const shown = lv.d.feed.find((o) => o.c === fr.c);
  assert.equal(shown.id, fr.id, "the incognito 🎙 line keeps its (salted) id for 🔊 Clip");
  assert.ok(!("id" in lv.d.feed.find((o) => o.c === hk.c)), "a hidden one has none");
  const ask = (tx) => call("POST", `/api/rooms/${SLUG}/micclip`, { user: U.mem, body: { tx } });
  const rh = await ask(hk.id || "tx-00000000000000b1");
  assert.equal(rh.status, 403, "hidden: refused");
  const r = await ask(fr.id);
  assert.equal(r.status, 200, r.text);
  const job = relay._jobs.get(r.d.id);
  assert.ok(job && job.alias === fr.u.alias && job.target === "frankiefettuccine", "the job: the frog name + the target (bot side only)");
  const v = await call("GET", `/api/rooms/${SLUG}/micclip/${r.d.id}`, { user: U.mem });
  assert.equal(v.status, 200);
  assert.equal(v.d.login, null, "the page never gets the login");
  assert.equal(v.d.alias, fr.u.alias);
  assert.deepEqual(leaks(v.text), []);
  const taken = relay.takeJobs(new Set([ROOM.id]));
  const mc = taken.find((j) => j.id === r.d.id);
  assert.ok(mc && mc.alias === fr.u.alias && mc.veil === "incognito", "Pepe's job says alias + veil incognito");
});

test("forget-me: the person's veil rows go everywhere, their veiled live lines leave, their sessions end", async () => {
  await setup;
  const R = bridge._rooms.get(ROOM.id);
  assert.ok(R.feed.some((x) => x._vz && x._vz.login === "frankiefettuccine"));
  const r = await require(path.join(repo, "pepeforget")).fromBot("frankiefettuccine");
  assert.equal(r.ok, true);
  assert.ok(!R.feed.some((x) => x._vz && x._vz.login === "frankiefettuccine"), "their veiled live lines left the feed");
  const rows = await getQuery("SELECT vz FROM bridge_veil");
  assert.ok(!rows.some((x) => JSON.parse(x.vz).login === "frankiefettuccine"), "bridge_veil");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chat_log_veil WHERE login = 'frankiefettuccine'"))[0].n, 0, "chat_log_veil");
  const rv = (await getQuery("SELECT data FROM bridge_rooms_veil WHERE id = ?", [ROOM.id]))[0];
  assert.ok(!rv || !rv.data.includes("frankiefettuccine"), "bridge_rooms_veil");
  assert.ok(!(R.members || []).some((e) => e._vz && e._vz.login === "frankiefettuccine"), "the roster");
  assert.equal(FN.current(ROOM.id, "frankiefettuccine"), null, "their frog-name session ended");
});

test("the switch off: v2 refused again (409) - lines stored since G keep their frog names and bars", async () => {
  await setup;
  await PW.setOn(false, { userId: U.adm.userId, username: "adm" });
  const r = await call("POST", "/api/bridge/sync/v2", { body: { password: "bot", events: [], rooms: [] } });
  assert.equal(r.status, 409);
  const lv = await live(U.mem);
  assert.ok(lv.d.feed.some((o) => o.u && o.u.veil === "hidden" && o.mask), "stored bars stay bars");
  assert.deepEqual(leaks(lv.text), []);
  await PW.setOn(true, { userId: U.adm.userId, username: "adm" });
});
