// CL3 chatlogview.js: the read-time projection (spec §3.3) on today's live paths, and the golden leak test on /live.
//   * hidden people (the sticky set) are LEFT OUT for every viewer - chat, mic and presence lines - never "someone";
//     !transcripts off leaves out only their 🎙 lines; a newly hidden person's lines leave open pages (`removed`);
//   * their names inside other people's lines become "someone" (login + display names, >= 3 characters, an optional @, word
//     bounds, longest first) - a common word is never redacted (the stop-list); the hidden-names job keeps chatlog_hidden_names
//     to the people hidden NOW (derived from the live feeds and the archive);
//   * private-activity accounts are "someone" in presence lines only; a web member whose account is gone is "former member";
//   * removed / purged lines (CL6) per viewer; rosters; the homepage panel;
//   * the golden leak test: a hidden person's login and display names appear nowhere in a /live answer (text, attributes, keys).
//   NODE_PATH=G:/PATV/node_modules node --test test/chatlog-project.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-project-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const bridge = require(path.join(repo, "bridge"));
const CL = require(path.join(repo, "chatlog"));
const CV = require(path.join(repo, "chatlogview"));
const rooms = require(path.join(repo, "rooms"));
const UL = require(path.join(repo, "userlinks"));

const hash = (login) => crypto.createHash("sha256").update("pepe-hidden:" + String(login).toLowerCase()).digest("hex").slice(0, 20);
const ROOM = { id: "Proj.Room", name: "Proj Room" };
const SLUG = "proj-room";
const SHY = { id: "shycf", login: "shycf", display: "Shy Violet" };          // goes hidden
const LOVE = { id: "lovecf", login: "lovecf", display: "love" };             // goes hidden; display name is a common word
const BOB = { id: "bobcf", login: "bobcf", display: "Bob B" };
const PRIV = { id: "privcf", login: "privcf", display: "Private P" };       // linked, keeps activity private
const MIC = { id: "miccf", login: "miccf", display: "Mic M" };             // !transcripts off
let seq = 0;
const ev = (type, data, ts) => ({ op: "event", id: "pj-" + (++seq), ts: new Date(ts || Date.now()).toISOString(), type, scope: { platform: "camfrog", room: ROOM }, data });
const users = new Map();
let base, server;

function call(method, url, user, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const u = new URL(base + url);
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: Object.assign({ "x-requested-with": "fetch" }, data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {},
                             user ? { "x-test-user": user.userId } : {}) }, (res) => {
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
async function mkUser(name, cls = "pleb", camfrog = null) {
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, 'x', ?, ?)", ["id-" + name, name, name, cls, camfrog]);
  const u = { userId: "id-" + name, username: name, class: cls };
  users.set(u.userId, u);
  return u;
}
const U = {};
const settle = () => new Promise((r) => setTimeout(r, 60));
const feedTexts = (out) => out.feed.map((it) => it.text || (it.k + ":" + (it.u ? (it.u.anon ? "someone" : it.u.former ? "former" : it.u.login) : "")));

const setup = (async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER)`);
  UL._setQuery(null);
  U.mem = await mkUser("mem");
  U.own = await mkUser("own", "pleb", "owncf");
  U.priv = await mkUser("privacc", "pleb", "privcf");
  U.web = await mkUser("webby");
  await bridge.load();
  await CL.init();
  await rooms.init();
  await CV.init();
  // the private-activity account hides its profile's Analytics (the stories.privateLogins rule)
  const PL = require(path.join(repo, "profilelayout"));
  await PL.save(U.priv.userId, { order: [], hidden: ["analytics"], priv: [], pub: [] });
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  // CL3 fix-up: the pad page itself (/p/:slug) is part of the leak test
  await require(path.join(repo, "feedstore")).init();
  await require(path.join(repo, "pepefeed")).ensureAccount().catch(() => {});
  require(path.join(repo, "pads")).register(app);
  require(path.join(repo, "feedweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  bridge.register(app, { addUser, isBotToken: (t) => t === "bot" });
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  await new Promise((r) => { server = app.listen(0, r); });
  server.unref();
  base = "http://127.0.0.1:" + server.address().port;
  const T = Date.now() - 5 * 60e3;
  await bridge.ingest({ rooms: [{ room: ROOM, topic: "ask Shy Violet about it", members: [SHY, LOVE, BOB, PRIV, MIC], mic: [SHY], count: 5, transcripts: true }],
    events: [
      ev("member.join", { user: SHY }, T),
      ev("message", { user: SHY, text: "shy secret words" }, T + 1000),
      ev("x.pepe.transcript", { id: "tx-0000000000000001", user: SHY, text: "shy said on the mic" }, T + 2000),
      ev("message", { user: LOVE, text: "lovely unique marker" }, T + 3000),
      ev("message", { user: BOB, text: "hey @shycf and Shy Violet, I love it - Shyness stays" }, T + 4000),
      ev("member.join", { user: PRIV }, T + 5000),
      ev("message", { user: PRIV, text: "private person talks" }, T + 6000),
      ev("x.pepe.transcript", { id: "tx-0000000000000002", user: MIC, text: "mic person transcript" }, T + 7000),
      ev("message", { user: MIC, text: "mic person chat" }, T + 8000),
      ev("message", { user: { id: "Pepe", login: "PepeFrog", display: "Pepe", is_self: true }, text: "🌐 x (PATV web): ...", self: true,
                      web: { user: { login: "u:gone-account-1", display: "Gone Webber" }, text: "a web line from a deleted account" } }, T + 9000),
      ev("message", { user: { id: "Pepe", login: "PepeFrog", display: "Pepe", is_self: true }, text: "🌐 y (PATV web): ...", self: true,
                      web: { user: { login: "u:" + U.web.userId, display: "Webby" }, text: "a web line from a live account" } }, T + 9500),
    ] });
  await rooms.setOwner(ROOM.id, "own", "test");
})();
// (no test.after: Node 16's runner lacks it - the server is unref'd)

test("before anyone is hidden: everything shows (the baseline)", async () => {
  await setup;
  const R = bridge._rooms.get(ROOM.id);
  const out = await bridge.liveView(R, 0, U.mem.userId, null, "mem", true, { viewer: U.mem });
  const t = feedTexts(out);
  for (const want of ["shy secret words", "shy said on the mic", "lovely unique marker", "private person talks", "mic person transcript"]) assert.ok(t.includes(want), want);
});

test("hidden people are left out for every viewer (chat, mic, presence) and their names become 'someone' in other lines", async () => {
  await setup;
  const R = bridge._rooms.get(ROOM.id);
  const first = await bridge.liveView(R, 0, U.mem.userId, null, "mem", true, { viewer: U.mem });
  // (Pepe CL1: a !bridge hide is an event AND a list entry - CL2 fix-up: the event says which kind, so !bridge show un-hides it)
  const hid = (l) => ({ op: "event", id: "pj-hd-" + (++seq), ts: new Date().toISOString(), type: "privacy.hidden", data: { h: hash(l), scope: "bridge" } });
  await bridge.ingest({ events: [hid("shycf"), hid("lovecf")], rooms: [], hidden_h: [hash("shycf"), hash("lovecf")] });
  await settle();
  await CV.scheduleNames();
  for (const viewer of [U.mem, U.own]) {
    const out = await bridge.liveView(R, 0, viewer.userId, null, viewer.username, true, { viewer });
    const t = feedTexts(out);
    assert.ok(!t.some((x) => /shy secret|shy said|lovely unique/.test(x)), "left out - for the owner too");
    assert.ok(!t.includes("join:shycf"), "presence too");
    assert.ok(!out.feed.some((it) => it.u && /shycf|lovecf/i.test(JSON.stringify(it.u))), "never shown as someone with a login");
    const bob = out.feed.find((it) => it.u && it.u.login === "bobcf");
    assert.equal(bob.text, "hey someone and someone, I love it - Shyness stays", "@login and the display name redacted; 'love' (a common word) is not");
    assert.equal(out.room.topic, "ask someone about it", "the topic too");
    // (Train 3 review fix-up: a !bridge hide person - left out - isn't listed at all, not even as "someone"; incognito is "someone")
    assert.deepEqual(out.mic, [], "rosters: the left-out mic holder isn't listed");
    assert.ok(!out.members.some((u) => u && /shycf|lovecf/.test(u.login || "")));
  }
  // an open page holding their lines is told to drop them (cursor numbers only)
  const poll = await bridge.liveView(R, first.cursor, U.mem.userId, null, "mem", false, { viewer: U.mem, jc: first.jc });
  const shyCs = R.feed.filter((it) => it.u && it.u.login === "shycf").map((it) => it.c);
  assert.ok(shyCs.length >= 3);
  for (const c of shyCs) assert.ok((poll.removed || []).includes(c), "removed: " + c);
  // the hidden-names job: only people hidden NOW; derived from what the feeds showed
  const row = (await getQuery("SELECT * FROM chatlog_hidden_names WHERE h = ?", [hash("shycf")]))[0];
  assert.ok(row, "a names row for a hidden person");
  assert.deepEqual(JSON.parse(row.names), ["Shy Violet"]);
  assert.equal(CV.adminInfo().collisions, 1, "'love' collided with the stop-list and is never redacted");
});

test("!transcripts off leaves out only their 🎙 lines; private activity -> 'someone' in presence lines only; former member", async () => {
  await setup;
  await bridge.ingest({ events: [{ op: "event", id: "pj-tx-" + (++seq), ts: new Date().toISOString(), type: "privacy.hidden", data: { h: hash("miccf"), scope: "tx" } }], rooms: [] });
  await settle();
  const R = bridge._rooms.get(ROOM.id);
  bridge._nameCache.clear();
  const out = await bridge.liveView(R, 0, U.mem.userId, null, "mem", true, { viewer: U.mem });
  const t = feedTexts(out);
  assert.ok(!t.includes("mic person transcript"), "their mic transcript is left out");
  assert.ok(t.includes("mic person chat"), "their chat stays");
  const join = out.feed.find((it) => it.k === "join" && it.u && (it.u.anon || it.u.login === "privcf"));
  assert.ok(join && join.u.anon, "a private-activity account's join shows as someone");
  const said = out.feed.find((it) => it.text === "private person talks");
  assert.equal(said.u.login, "privcf", "their chat line keeps their name");
  const gone = out.feed.find((it) => it.text === "a web line from a deleted account");
  assert.deepEqual(gone.u, { former: true }, "a web member with no live account: former member, no name, no link, no id");
  const live = out.feed.find((it) => it.text === "a web line from a live account");
  assert.equal(live.u.patv.username, "webby", "a live web member resolves as before");
});

test("removed and purged lines (CL6): left out for members; the owner sees a muted 'removed' row (text until purged)", async () => {
  await setup;
  const t = Date.now();
  const rows = [
    { c: 900001, rk: 1, ts: t, k: "msg", who: "bobcf", text: "hidden by a mod", rt: "r1", aud: "m", d: JSON.stringify({ u: { display: "Bob B" } }), rm_at: t, rm_by: "mod:id-own", rm_why: "spam" },
    { c: 900002, rk: 1, ts: t, k: "msg", who: "bobcf", text: null, rt: "r1", aud: "m", d: JSON.stringify({ u: { display: "" } }), rm_at: t - 31 * 864e5, purged: 1 },
    { c: 900003, rk: 1, ts: t, k: "msg", who: "bobcf", text: "fine", rt: "r1", aud: "m", d: JSON.stringify({ u: { display: "Bob B" } }) },
  ].map(CV.itemOf);
  const Vm = await CV.view(ROOM.id, U.mem), Vo = await CV.view(ROOM.id, U.own);
  assert.deepEqual(CV.filter(rows, { view: Vm }).items.map((x) => x.c), [900003]);
  const f = CV.filter(rows, { view: Vm });
  assert.deepEqual(f.left, { privacy: 0, removed: 2 });
  const o = CV.dress(CV.filter(rows, { view: Vo }).items, {});
  assert.equal(o.length, 3);
  assert.deepEqual(o[0].removed, { at: t, by: "mod", why: "spam" });
  assert.equal(o[0].text, "hidden by a mod", "the owner reads it (the appeal copy) until it's purged");
  assert.deepEqual(o[1].removed, { purged: true });
  assert.equal(o[1].text, undefined);
  assert.ok(o.every((x) => x.aud === undefined && x.rm_by === undefined), "internal fields never leave");
});

test("the golden leak test: a hidden person's login and display names appear nowhere in /live (text, attributes, keys)", async () => {
  await setup;
  await settle();
  for (const viewer of [U.mem, U.own]) {
    const r = await get(`/api/rooms/${SLUG}/live`, viewer);
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.equal(r.headers["cache-control"], "no-store");
    assert.match(String(r.headers["x-robots-tag"]), /noindex/);
    const s = r.text;
    for (const leak of ["shycf", "Shy Violet", "lovecf", "lovely unique marker", "shy secret words", "shy said on the mic", "mic person transcript", "Gone Webber", "gone-account-1"]) {
      const at = s.indexOf(leak);
      assert.ok(at < 0, `${leak} leaked to ${viewer.username}: ...${s.slice(Math.max(0, at - 160), at + 60)}...`);
    }
    assert.ok(/I love it/.test(s), "the stop-listed common word stays in other people's lines");
    assert.ok(r.d.history && r.d.jc, "the answer carries the history block and the page's join cursor");
  }
  // CL3 fix-up: the pad page's own HTML (the server-rendered topic in #rmTopic, #rmInit) - signed in, and signed out
  for (const viewer of [U.mem, U.own, null]) {
    const p = await get(`/p/${SLUG}`, viewer);
    assert.equal(p.status, 200, p.text.slice(0, 200));
    for (const leak of ["shycf", "Shy Violet", "lovecf", "lovely unique marker", "shy secret words"]) {
      const at = p.text.indexOf(leak);
      assert.ok(at < 0, `${leak} leaked into the pad page for ${viewer ? viewer.username : "a signed-out viewer"}: ...${p.text.slice(Math.max(0, at - 160), at + 60)}...`);
    }
  }
  assert.match((await get(`/p/${SLUG}`, U.mem)).text, /id="rmTopic"[^>]*>ask someone about it</, "the topic, redacted");
  // the homepage panel: the same projection (never exempt)
  const home = await bridge.liveFor(SLUG, U.own);
  const s = JSON.stringify(home);
  assert.ok(!/shycf|Shy Violet|lovecf/.test(s));
  assert.equal(home.history.role, "member", "the homepage panel never uses the owner's floors");
  // the room list's mic names
  const sum = await bridge.summary(true);
  assert.ok(!JSON.stringify(sum).includes("Shy Violet"));
});

test("un-hiding (Pepe's privacy.shown) brings their lines back and drops their names row", async () => {
  await setup;
  await bridge.ingest({ events: [{ op: "event", id: "pj-sh-" + (++seq), ts: new Date().toISOString(), type: "privacy.shown", data: { h: hash("shycf"), scope: "bridge" } }], rooms: [], hidden_h: [hash("lovecf")] });
  await settle();
  await CV.scheduleNames();
  const R = bridge._rooms.get(ROOM.id);
  const out = await bridge.liveView(R, 0, U.mem.userId, null, "mem", true, { viewer: U.mem });
  assert.ok(feedTexts(out).includes("shy secret words"));
  assert.ok(!feedTexts(out).includes("lovely unique marker"), "the other one stays hidden");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chatlog_hidden_names WHERE h = ?", [hash("shycf")]))[0].n, 0);
  assert.equal(out.room.topic, "ask Shy Violet about it");
});

test("CL3 fix-up: Pepe's anonymised stand-ins ({anonymous}) are LEFT OUT of every viewer's view - never '→ someone joined'", async () => {
  await setup;
  const ANON = { id: "anon-1a2b3c4d", display: "someone", anonymous: true };
  await bridge.ingest({ rooms: [], events: [ev("member.join", { user: ANON }), ev("mic.grab", { user: ANON }), ev("mic.release", { user: ANON, held_ms: 5000 })] });
  const R = bridge._rooms.get(ROOM.id);
  const cs = R.feed.filter((it) => it.u && it.u.anon).map((it) => it.c);
  assert.equal(cs.length, 3, "the bridge keeps them (Pepe sent them)");
  for (const viewer of [U.mem, U.own]) {
    const out = await bridge.liveView(R, 0, viewer.userId, null, viewer.username, true, { viewer });
    for (const c of cs) assert.ok(!out.feed.some((it) => it.c === c), "left out for " + viewer.username + ": " + c);
  }
  const V = await CV.view(ROOM.id, U.own);
  const f = CV.filter(R.feed.filter((it) => cs.includes(it.c)), { view: V, jc: null });
  assert.deepEqual([f.items.length, f.left.privacy], [0, 3], "counted as left out for privacy");
});

test("CL3 fix-up: the private-activity flag fails closed while it is being computed (a concurrent poll sees 'private')", async () => {
  await setup;
  const realPF = CV.privateFlags;
  let release = null;
  CV.privateFlags = () => new Promise((r) => { release = () => r({ logins: new Set(), ids: new Set() }); });
  bridge._nameCache.clear();
  try {
    const p = bridge.resolveNames([{ login: "privcf" }]);
    for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(release, "the lookup reached the private-activity step");
    const key = [...bridge._nameCache.keys()].find((k) => /privcf/.test(k));
    const e = bridge._nameCache.get(key);
    assert.ok(e && e.acc, "the account is resolved");
    assert.equal(e.priv, true, "private until known");
    const join = { c: 1, k: "join", ts: Date.now(), aud: "m", u: { login: "privcf", display: "Private P" } };
    const shown = CV.dress([join], { lookup: () => e });
    assert.deepEqual(shown[0].u, { anon: true, display: "someone" }, "a concurrent answer shows their join as someone");
    release();
    await p;
  } finally { CV.privateFlags = realPF; bridge._nameCache.clear(); }
});

test("CL3 fix-up: the hidden-names job learns logins and display names from the rosters and, after a restart, from what the feed kept", async () => {
  await setup;
  const R = bridge._rooms.get(ROOM.id);
  // someone only in the room's roster (never spoke) whom bob names; and the restart: the login map starts empty
  const GHOST = { id: "ghostcf", login: "ghostcf", display: "Ghost Gamma" };
  await bridge.ingest({ rooms: [{ room: ROOM, topic: "ask Shy Violet about it", members: [SHY, LOVE, BOB, PRIV, MIC, GHOST], mic: [], count: 6, transcripts: true }],
                        events: [ev("message", { user: BOB, text: "where is Ghost Gamma tonight" })] });
  CV._who.clear(); CV._disp.clear();
  bridge._noteWhoAll(R);                         // what bridge.load() does with the feed and the roster snapshot it reloads
  assert.equal(CV._who.get(hash("ghostcf")), "ghostcf", "a roster login");
  assert.ok(CV._who.get(hash("bobcf")), "a feed login");
  const hid = { op: "event", id: "pj-gh-" + (++seq), ts: new Date().toISOString(), type: "privacy.hidden", data: { h: hash("ghostcf"), scope: "bridge" } };
  await bridge.ingest({ events: [hid], rooms: [] });
  for (let i = 0; i < 50 && !CL.isHiddenKey("ghostcf"); i++) await settle();
  await CV.scheduleNames();
  const row = (await getQuery("SELECT * FROM chatlog_hidden_names WHERE h = ?", [hash("ghostcf")]))[0];
  assert.ok(row, "a names row, from the roster");
  assert.deepEqual(JSON.parse(row.names), ["Ghost Gamma"]);
  const out = await bridge.liveView(R, 0, U.mem.userId, null, "mem", true, { viewer: U.mem });
  assert.ok(out.feed.some((it) => it.text === "where is someone tonight"), "their name is redacted in bob's line");
  await bridge.ingest({ events: [{ op: "event", id: "pj-gs-" + (++seq), ts: new Date().toISOString(), type: "privacy.shown", data: { h: hash("ghostcf"), scope: "bridge" } }], rooms: [] });
  await settle();
  await CV.scheduleNames();
});

test("CL3 fix-up: the trie regex redacts exactly what the flat alternation did (random names and lines)", async () => {
  await setup;
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const AL = ["a", "b", "c", "d", "e", "ë", "ß", "z", "-", " ", ".", "_", "1", "é", "ñ", "o", "ö"];
  const word = (min, max) => { let s = ""; const n = min + rnd(max - min + 1); for (let i = 0; i < n; i++) s += AL[rnd(AL.length)]; return s.trim(); };
  const names = [];
  for (let i = 0; i < 300; i++) { const w = word(3, 9); if (Array.from(w).length >= 3) names.push(w); if (i % 3 === 0 && names.length) names.push(names[rnd(names.length)] + AL[rnd(AL.length)]); }
  const terms = [...new Set(names.map((s) => s.toLowerCase()).filter((s) => Array.from(s).length >= 3 && !CV.STOP.has(s)))];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const flat = new RegExp("(?<![\\p{L}\\p{N}_])@?(?:" + terms.slice().sort((a, b) => b.length - a.length).map(esc).join("|") + ")(?![\\p{L}\\p{N}_])", "giu");
  const trie = new RegExp("(?<![\\p{L}\\p{N}_])@?(?:" + CV.trieSource(terms) + ")(?![\\p{L}\\p{N}_])", "giu");
  for (let i = 0; i < 3000; i++) {
    const parts = [];
    for (let k = 0; k < 6; k++) parts.push(rnd(3) ? word(1, 8) : (rnd(2) ? "@" : "") + names[rnd(names.length)].toUpperCase().slice(0, 12));
    const line = parts.join(rnd(2) ? " " : ",");
    assert.equal(line.replace(trie, "someone"), line.replace(flat, "someone"), line);
  }
});

test("redaction rules: >= 3 characters, @, word bounds, longest first, unicode letters, case-insensitive", async () => {
  await setup;
  const h = "e".repeat(20);
  const realHidden = CL.isHiddenHash;
  CL.isHiddenHash = (x) => x === h || realHidden(x);
  CV._names.set(h, { login: "annmarie", names: ["Ann-Marie", "Ann", "Zoë", "Jo"], updated: Date.now() });
  CV._bumpNames();
  try {
    assert.equal(CV.redact("Ann-Marie and @Ann said hi to ZOË; Annabel, Jo and annmarie2 stay, ANNMARIE goes"),
                 "someone and someone said hi to someone; Annabel, Jo and annmarie2 stay, someone goes");
  } finally { CL.isHiddenHash = realHidden; CV._names.delete(h); CV._bumpNames(); }
  assert.equal(CV.redact("Ann-Marie"), "Ann-Marie", "un-hidden: recompiled without them");
});
