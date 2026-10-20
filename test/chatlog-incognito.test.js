// The chat-history owner change of 2026-10-19 (spec "Owner changes after the build started" 2 + 3; decision 9 changed): incognito
// hides WHO, not WHAT. An INCOGNITO person's lines are shown ANONYMISED as "someone" (no login, display name, avatar, looks or 🎙 id)
// in the live tail, scrollback, quotes / clips and search - search never matches or returns their name, their words are found only
// without attribution (never From them) - while a !bridge hide person's lines stay LEFT OUT everywhere. The sticky hidden set tells
// the two kinds apart (chatlog.js reasons -> hubhidden's kinds) and takes Pepe's kinded lists (bridge_hidden_h / incog_hidden_h).
// Every surface, both kinds:
//   * the hidden set: kinded lists, resolving an older Pepe's unknown kind (one / many - held as "resolve"), "legacy" holds, a lost
//     kind list resolves nothing, hubRows (the merge map onto hubhidden's rows), !bridge show on an unknown leaves "someone";
//   * Pepe's anonymised lines (data.anon {kind: "incognito", h}): kept as "someone" (the hash server-only, archived as who "h:<hash>"),
//     any other anonymised line dropped; a named line of someone who goes incognito is "someone" at read time;
//   * the live tail: the golden leak test (no login, display name, hash or 🎙 id), presence left out, `removed` + `redo` on open
//     pages when a speaker's kind moves, the viewer's own anonymised lines keep 🗑 Remove my line;
//   * scrollback, deep links and /history/check; search (words found as "someone", names never, never From them); quotes (web and
//     Pepe's !quote) and a 🔊 mic clip; @mention alerts and their notice text; Remove my line, the per-login staff tool, the account
//     export and an account merge on the anonymised rows.
//   NODE_PATH=G:/PATV/node_modules node --test test/chatlog-incognito.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-incognito-test-"));
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
const CS = require(path.join(repo, "chatlogsearch"));
const quotes = require(path.join(repo, "quotes"));
const store = require(path.join(repo, "feedstore"));
const M = require(path.join(repo, "mentions"));
const CORE = require(path.join(repo, "public", "js", "chatlog-core.js"));

const H = 3600e3, D = 864e5;
const hash = (login) => crypto.createHash("sha256").update("pepe-hidden:" + String(login).trim().toLowerCase()).digest("hex").slice(0, 20);
const ROOM = { id: "Inc.Room", name: "Inc Room" }, SLUG = "inc-room";
const ALICE = { id: "alicecf", login: "alicecf", display: "Alice Ash" };
const BOB = { id: "bobcf", login: "bobcf", display: "Bob Birch" };
const INC = { id: "inccf", login: "inccf", display: "Ina Cognito" };        // goes incognito (the account U.inc is linked to it)
const BRI = { id: "bricf", login: "bricf", display: "Bri Hidden" };         // types !bridge hide
const ANON = () => ({ id: "anon-" + crypto.randomBytes(4).toString("hex"), display: "someone", anonymous: true });
const INC_H = hash("inccf");
const users = new Map();
const U = {};
let base, server, seq = 0;
const ev = (type, data, ts) => ({ op: "event", id: "inc-" + (++seq), ts: new Date(ts || Date.now()).toISOString(), type, scope: { platform: "camfrog", room: ROOM }, data });
const pev = (type, login, scope, ts) => ({ op: "event", id: "inc-p-" + (++seq), ts: new Date(ts || Date.now()).toISOString(), type, data: { h: hash(login), scope } });
const snap = (extra = {}) => Object.assign({ room: ROOM, members: [ALICE, BOB, BRI], mic: [], count: 3, transcripts: true, clip: true }, extra);
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

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
const hist = (user, q = "") => get(`/api/rooms/${SLUG}/history${q ? "?" + q : ""}`, user);
const find = (user, body) => call("POST", `/api/rooms/${SLUG}/search`, user, body);
const live = (user, q = "") => get(`/api/rooms/${SLUG}/live${q ? "?" + q : ""}`, user);
async function mkUser(name, cls = "pleb", camfrog = null) {
  const uid = "id-" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at)
                  VALUES (?, ?, ?, 'x', ?, 100000, ?, 5, '2026-01-01 00:00:00')`, [uid, name, name, cls, camfrog]);
  const u = { userId: uid, username: name, class: cls };
  users.set(uid, u);
  return u;
}
const cOf = async (text) => { const r = (await getQuery("SELECT c FROM chat_log WHERE text = ?", [text]))[0]; assert.ok(r, "archived: " + text); return Number(r.c); };
/** Pepe's word on one person (one event a sync: two un-hides at once in a small set are held for an operator). */
async function pepe(type, login, scope) {
  await bridge.ingest({ events: [pev(type, login, scope)], rooms: [] });
  await settle();
  await CV.refreshNames();
  CV._clearCaches();
}
const SOMEONE = { anon: true, display: "someone" };
/** Nothing in s names INC (login, display name, their hash) - the golden leak rule for an incognito person. */
function noName(s, where) {
  for (const leak of ["inccf", "Ina Cognito", INC_H]) {
    const at = s.indexOf(leak);
    assert.ok(at < 0, `${leak} leaked (${where}): ...${s.slice(Math.max(0, at - 120), at + 40)}...`);
  }
}

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
  U.inc = await mkUser("incuser", "pleb", "inccf");      // (its PATV name is redacted in quotes too: never a word of the test lines)
  U.alice = await mkUser("alice", "pleb", "alicecf");
  U.staff = await mkUser("helper", "Staff");
  await rooms.init();
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0 }, "test");
  await require(path.join(repo, "pepefeed")).ensureAccount().catch(() => {});
  await settle(150);
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
  // the archive on (the notice 8 days ago); scrollback and search on
  CL._setClock(() => Date.now() - 8 * D);
  await CL.setSwitch("notice", true, "test");
  CL._setClock(() => Date.now());
  for (const s of ["archive", "history", "search"]) await CL.setSwitch(s, true, "test");
  T0 = Date.now();
  await rooms.setOwner(ROOM.id, "own", "test");
  // named lines first (INC isn't incognito yet), then INC goes incognito (Pepe's event) and Pepe sends INC's NEW lines anonymised
  await bridge.ingest({ rooms: [snap({ members: [ALICE, BOB, BRI, INC] })], events: [
    ev("member.join", { user: INC }, T0 - 50 * 60e3),
    ev("message", { user: INC, text: "ina named words" }, T0 - 49 * 60e3),
    ev("x.pepe.transcript", { id: "tx-00000000000000c1", user: INC, text: "ina mic words" }, T0 - 48 * 60e3),
    ev("message", { user: BOB, text: "hello Ina Cognito and @inccf, nice" }, T0 - 47 * 60e3),
    ev("message", { user: BRI, text: "bri secret words" }, T0 - 46 * 60e3),
    ev("message", { user: ALICE, text: "alice plain words" }, T0 - 45 * 60e3),
  ] });
  await bridge.ingest({ rooms: [snap()], events: [
    pev("privacy.hidden", "inccf", "incognito", T0 - 44 * 60e3),
    ev("message", { user: ANON(), text: "ina anonymous words", anon: { kind: "incognito", h: INC_H } }, T0 - 43 * 60e3),
    ev("x.pepe.transcript", { id: "tx-00000000000000c2", user: ANON(), text: "ina anonymous mic", source: "mic", anon: { kind: "incognito", h: INC_H } }, T0 - 42 * 60e3),
    ev("message", { user: ANON(), text: "an older pepe's anonymous line" }, T0 - 41 * 60e3),                              // no data.anon: dropped
    ev("message", { user: ANON(), text: "a bridge-hidden anonymous line", anon: { kind: "bridge", h: hash("bricf") } }, T0 - 40 * 60e3),   // dropped
    ev("message", { user: ANON(), text: "a bad hash line", anon: { kind: "incognito", h: "nope" } }, T0 - 39 * 60e3),     // dropped
    ev("member.join", { user: ANON() }, T0 - 38 * 60e3),                                                                 // a stand-in: left out
    ev("message", { user: BOB, text: "hey alicecf, did Ina Cognito leave" }, T0 - 37 * 60e3),
  ] });
  await settle();
  await CV.init();
  await require(path.join(repo, "chatlogmod")).init();
  await CV.refreshNames();
  CV._clearCaches();
})();
// (no test.after / beforeEach: Node 16's runner lacks them - the server is unref'd, each test resets what it uses)
const ready = async () => { await setup; CH._reset(); CS._reset(); CV._clearCaches(); };

test("ingest: Pepe's anonymised incognito lines are kept as 'someone' (their hash server-only, archived as h:<hash>); any other anonymised line is dropped", async () => {
  await ready();
  const R = bridge._rooms.get(ROOM.id);
  const a = R.feed.find((it) => it.text === "ina anonymous words");
  assert.ok(a, "in the live feed");
  assert.deepEqual(a.u, SOMEONE, "no login, no display");
  assert.equal(a.ah, INC_H, "the hash rides server-side");
  const tx = R.feed.find((it) => it.text === "ina anonymous mic");
  assert.ok(tx && tx.k === "tx" && tx.ah === INC_H);
  for (const t of ["an older pepe's anonymous line", "a bridge-hidden anonymous line", "a bad hash line"]) {
    assert.ok(!R.feed.some((it) => it.text === t), "dropped: " + t);
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chat_log WHERE text = ?", [t]))[0].n, 0, "never archived: " + t);
  }
  const row = (await getQuery("SELECT who, d FROM chat_log WHERE text = 'ina anonymous words'"))[0];
  assert.equal(row.who, "h:" + INC_H, "the archive keys it by the hash - never a login");
  assert.ok(!/ah|inccf/.test(row.d), "d carries no hash, no login: " + row.d);
  assert.deepEqual(JSON.parse(row.d).u, SOMEONE);
  // the bridge_feed copy (what a restart reloads) keeps the hash for the projection
  const bf = (await getQuery("SELECT data FROM bridge_feed WHERE data LIKE '%ina anonymous words%'"))[0];
  assert.equal(JSON.parse(bf.data).ah, INC_H);
  assert.deepEqual(CL.kindsOf(INC_H), ["incognito"]);
  assert.equal(CL.hiddenKind(INC_H), "anon");
  assert.equal(CL.isLeftOutHash(INC_H), false);
});

test("the live tail (golden leak test): an incognito person's lines are 'someone' with their words - no login, name, hash, looks or 🎙 id; presence left out", async () => {
  await ready();
  for (const viewer of [U.mem, U.own, U.staff, null]) {
    const r = await live(viewer);
    if (!viewer) { assert.equal(r.status, 401); continue; }
    assert.equal(r.status, 200, r.text.slice(0, 200));
    noName(r.text, "/live for " + viewer.username);
    for (const t of ["ina named words", "ina mic words", "ina anonymous words", "ina anonymous mic"]) {
      const it = r.d.feed.find((x) => x.text === t);
      assert.ok(it, t + " is shown to " + viewer.username);
      assert.deepEqual(it.u, SOMEONE, t + ": someone - no login, display, patv look, avatar or flair");
      assert.equal(it.id, undefined, t + ": no 🎙 id (a hash of the login and the words)");
      assert.equal(it.ah, undefined);
      assert.equal(it.own, undefined, "not their own line");
    }
    assert.ok(!r.d.feed.some((x) => x.k === "join" && (!x.u || x.u.anon)), "an incognito person's join / a stand-in: left out, never '→ someone joined'");
    assert.ok(r.d.feed.some((x) => x.text === "hello someone and someone, nice"), "their names redacted in others' lines");
    assert.ok(r.d.feed.some((x) => x.text === "bri secret words" && x.u.login === "bricf"), "not hidden: named");
    const html = r.d.feed.map((it) => String(CORE.renderItem(it, { t: null, lang: "en" }, CORE.htmlH) || "")).join("\n");
    noName(html, "rendered /live for " + viewer.username);
  }
  // the pad page itself (#rmInit, the server-rendered chat)
  const p = await get(`/p/${SLUG}`, U.mem);
  assert.equal(p.status, 200);
  noName(p.text, "the pad page");
  // the homepage panel (never exempt)
  noName(JSON.stringify(await bridge.liveFor(SLUG, U.own)), "the homepage panel");
});

test("the viewer's OWN anonymised lines keep 🗑 Remove my line (by the hash, never on the wire); Remove my line works on an anonymised archived line", async () => {
  await ready();
  const r = await live(U.inc);
  assert.equal(r.status, 200);
  noName(JSON.stringify(r.d.feed), "/live's lines for the incognito person themselves (their own `me` block names them, to them)");
  for (const t of ["ina named words", "ina anonymous words"]) assert.equal(r.d.feed.find((x) => x.text === t).own, 1, t + ": theirs");
  assert.equal(r.d.feed.find((x) => x.text === "alice plain words").own, undefined);
  const h = await hist(U.inc, "limit=50");
  assert.equal(h.status, 200, h.text.slice(0, 200));
  assert.equal(h.d.items.find((x) => x.text === "ina anonymous words").own, 1, "scrollback too");
  noName(JSON.stringify(h.d.items), "/history's lines for the incognito person");
  // someone else can't remove it; they can (the anonymised row: who h:<hash of their login>)
  const c = await cOf("ina anonymous mic");
  const no = await call("POST", `/api/rooms/${SLUG}/chatlog/${c}/remove`, U.mem, {});
  assert.equal(no.status, 404, "one answer for not the author");
  const ok = await call("POST", `/api/rooms/${SLUG}/chatlog/${c}/remove`, U.inc, {});
  assert.equal(ok.status, 200, ok.text.slice(0, 200));
  assert.equal((await getQuery("SELECT rm_by FROM chat_log WHERE c = ?", [c]))[0].rm_by, "self");
  assert.ok(!bridge._rooms.get(ROOM.id).feed.some((x) => Number(x.c) === c), "out of the live feed");
});

test("scrollback: 'someone' rows (named and anonymised), deep links open them; /history/check draws a line again when its speaker's kind moved", async () => {
  await ready();
  for (const viewer of [U.mem, U.own, U.staff]) {
    const h = await hist(viewer, "limit=100");
    assert.equal(h.status, 200, h.text.slice(0, 200));
    noName(h.text, "/history for " + viewer.username);
    for (const t of ["ina named words", "ina mic words", "ina anonymous words"]) {
      const it = h.d.items.find((x) => x.text === t);
      assert.ok(it, t + " in scrollback for " + viewer.username);
      assert.deepEqual(it.u, SOMEONE);
      assert.equal(it.id, undefined);
    }
    assert.ok(!h.d.items.some((x) => x.k === "join" && x.u && x.u.anon), "presence: left out");
    const a = await hist(viewer, "around=" + (await cOf("ina anonymous words")) + "&limit=3");
    assert.equal(a.status, 200, "a deep link to an anonymised line opens it");
    noName(a.text, "around");
  }
  // alice goes incognito: a page holding her lines re-checks (the digest moved) - they are drawn again as "someone"; INC's line Pepe
  // sent anonymised is not (review 2: its look didn't change)
  const aliceC = await cOf("alice plain words");
  const incCs = [await cOf("ina anonymous words")];
  await pepe("privacy.hidden", "alicecf", "incognito");
  const k = await call("POST", `/api/rooms/${SLUG}/history/check`, U.mem, { cs: [aliceC, ...incCs] });
  assert.equal(k.status, 200, k.text.slice(0, 200));
  assert.deepEqual(k.d.gone, []);
  assert.deepEqual(k.d.redo.map((it) => [Number(it.c), it.u]), [[aliceC, SOMEONE]], "re-dressed as someone - only hers");
  assert.ok(!k.text.includes("alicecf") && !k.text.includes("Alice Ash"));
  // ...and !bridge hide on top: gone
  await pepe("privacy.hidden", "alicecf", "bridge");
  const g = await call("POST", `/api/rooms/${SLUG}/history/check`, U.mem, { cs: [aliceC] });
  assert.deepEqual([g.d.gone, g.d.redo], [[aliceC], []]);
  await pepe("privacy.shown", "alicecf", "bridge");
  await pepe("privacy.shown", "alicecf", "incognito");
  const back = await call("POST", `/api/rooms/${SLUG}/history/check`, U.mem, { cs: [aliceC] });
  assert.deepEqual(back.d.gone, []);
});

test("open pages: only a line whose LOOK moves is in `removed` / `redo` (named -> someone, back by name; left out -> someone waits for a load); !bridge hide only in `removed`; each entry reaches a page once", async () => {
  await ready();
  const first = await live(U.mem);
  const at = first.d.cursor, jc = encodeURIComponent(first.d.jc);
  assert.ok(first.d.rs > 0, "a fresh view hands the page its ring sequence");
  let rs = first.d.rs;
  const bobCs = bridge._rooms.get(ROOM.id).feed.filter((it) => it.u && it.u.login === "bobcf").map((it) => Number(it.c));
  assert.ok(bobCs.length >= 2);
  const mine = (list) => (list || []).filter((c) => bobCs.includes(Number(c && c.c != null ? c.c : c)));
  try {
    await pepe("privacy.hidden", "bobcf", "incognito");
    let r = await live(U.mem, `after=${at}&jc=${jc}&rs=${rs}`);
    assert.equal(r.status, 200, r.text.slice(0, 200));
    for (const c of bobCs) {
      assert.ok((r.d.removed || []).includes(c), "removed: " + c + " (an older page just drops it)");
      const it = (r.d.redo || []).find((x) => Number(x.c) === c);
      assert.ok(it, "redo: " + c);
      assert.deepEqual(it.u, SOMEONE, "drawn again as someone");
    }
    assert.ok(!r.text.includes("bobcf") && !r.text.includes("Bob Birch"), "the answer never names them");
    assert.ok(r.d.rs > rs, "the answer's ring sequence moved on");
    // review 2: once - the same page asking again with the sequence it got is sent neither ring again (no re-dressing per poll)
    const again = await live(U.mem, `after=${at}&jc=${jc}&rs=${r.d.rs}`);
    assert.deepEqual([again.d.removed, again.d.redo], [undefined, undefined], "each entry reaches a page once");
    // ...a page that sends none (an older page, the homepage panel), or a sequence this process never handed out, still gets the
    // last hour's `removed` - and `redo` only when it sends a sequence (a page that draws them)
    for (const q of [`after=${at}&jc=${jc}`, `after=${at}&jc=${jc}&rs=${r.d.rs + 1e9}`]) {
      const old = await live(U.mem, q);
      assert.deepEqual(mine(old.d.removed).sort(), bobCs.slice().sort(), q);
      assert.equal(mine((old.d.redo || []).map((x) => Number(x.c))).length, /rs=/.test(q) ? bobCs.length : 0, q);
    }
    rs = r.d.rs;
    // !bridge hide: left out - in `removed`, never redone
    await pepe("privacy.hidden", "bobcf", "bridge");
    r = await live(U.mem, `after=${at}&jc=${jc}&rs=${rs}`);
    for (const c of bobCs) assert.ok((r.d.removed || []).includes(c));
    assert.ok(!(r.d.redo || []).some((x) => bobCs.includes(Number(x.c))), "a left-out line is never drawn again");
    assert.ok(!r.text.includes("bobcf") && !r.text.includes("Bob Birch"));
    // one entry per line in a ring, whatever moved before (review 2: removed was [1,2,3,1,2,3] after a move and back)
    const all = await live(U.mem, `after=${at}&jc=${jc}`);
    assert.equal(new Set(all.d.removed).size, all.d.removed.length, "no duplicate entries: " + JSON.stringify(all.d.removed));
    assert.ok(!(all.d.redo || []).some((x) => bobCs.includes(Number(x.c))), "a line that left is never drawn again from an older entry");
    rs = r.d.rs;
    // !bridge show (still incognito): left out -> "someone" is NOT drawn on open pages (the "someone" lines turning up together
    // would be one person's, at the moment they typed it) - they come with the next load
    await pepe("privacy.shown", "bobcf", "bridge");
    r = await live(U.mem, `after=${at}&jc=${jc}&rs=${rs}`);
    assert.deepEqual([mine((r.d.redo || []).map((x) => Number(x.c))), mine(r.d.removed)], [[], []]);
    const fresh = await live(U.mem);
    assert.deepEqual(fresh.d.feed.filter((x) => bobCs.includes(Number(x.c))).map((x) => x.u), bobCs.map(() => SOMEONE), "a load shows them as someone");
    rs = r.d.rs;
    // !incognito off: by name again
    await pepe("privacy.shown", "bobcf", "incognito");
    r = await live(U.mem, `after=${at}&jc=${jc}&rs=${rs}`);
    const back = (r.d.redo || []).filter((x) => bobCs.includes(Number(x.c)));
    assert.deepEqual(back.map((x) => Number(x.c)).sort(), bobCs.slice().sort());
    assert.ok(back.every((x) => x.u.login === "bobcf"), "back by name");
  } finally {
    if (CL.hiddenKind(hash("bobcf")) != null) { await pepe("privacy.shown", "bobcf", "bridge"); await pepe("privacy.shown", "bobcf", "incognito"); }
  }
  // the page's own code: `redo` after `removed` (scrollback keeps those lines and redraws them in place, 🔍 results drop them), and
  // it sends back the ring sequence it got
  const ejs = fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8");
  assert.match(ejs, /if \(d\.removed\) safe\('removed', function \(\) \{ dropRemoved\(d\.removed, d\.redo\); \}\);\r?\n\s*if \(d\.redo\) safe\('redo', function \(\) \{ redoLines\(d\.redo\); \}\);/, "redo after removed");
  assert.match(ejs, /function redoLines\(items\)[\s\S]{0,200}padHist\.redraw\(list\)/, "scrollback draws them again");
  assert.match(ejs, /\(lp\.rs != null \? '&rs=' \+ lp\.rs : ''\)/);
  assert.match(ejs, /if \(d\.rs != null\) lp\.rs = d\.rs;/);
  const ph = fs.readFileSync(path.join(repo, "public", "js", "pad-history.js"), "utf8");
  assert.match(ph, /redraw: function \(items\)/);
});

test("!bridge hide: LEFT OUT everywhere - live, scrollback, deep links (one not_found), search, quotes - for every viewer, the owner and staff included", async () => {
  await ready();
  const briC = await cOf("bri secret words");
  await pepe("privacy.hidden", "bricf", "bridge");
  try {
    for (const viewer of [U.mem, U.own, U.staff]) {
      const l = await live(viewer);
      assert.ok(!l.text.includes("bri secret words") && !l.text.includes("bricf") && !l.text.includes("Bri Hidden"), "live: " + viewer.username);
      const h = await hist(viewer, "limit=100");
      assert.ok(!h.text.includes("bri secret words") && !h.text.includes("bricf"), "history: " + viewer.username);
      const a = await hist(viewer, "around=" + briC);
      assert.equal(a.status, 404, "one not_found for " + viewer.username);
      const s = await find(viewer, { q: "secret" });
      assert.equal(s.status, 200, s.text.slice(0, 200));
      assert.ok(!s.text.includes("bri secret words"), "search: " + viewer.username);
    }
    const q = await call("POST", `/api/rooms/${SLUG}/quote`, U.mem, { cs: [briC] });
    assert.equal(q.status, 403);
    assert.equal(q.d.code, "not_quotable");
  } finally { await pepe("privacy.shown", "bricf", "bridge"); }
  // an incognito person who ALSO types !bridge hide: their lines - named and anonymised - are left out too
  await pepe("privacy.hidden", "inccf", "bridge");
  try {
    assert.equal(CL.isLeftOutHash(INC_H), true);
    assert.deepEqual(CL.kindsOf(INC_H), ["bridge", "incognito"]);
    const l = await live(U.mem);
    for (const t of ["ina named words", "ina anonymous words"]) assert.ok(!l.text.includes(t), "live: " + t);
    const h = await hist(U.own, "limit=100");
    for (const t of ["ina named words", "ina anonymous words"]) assert.ok(!h.text.includes(t), "history (the owner): " + t);
    assert.equal((await hist(U.own, "around=" + (await cOf("ina anonymous words")))).status, 404);
    assert.ok(CH.hiddenLogins().out.includes("h:" + INC_H), "their anonymised rows are left out in SQL too");
    const s = await find(U.mem, { q: "anonymous words" });
    assert.deepEqual(s.d.hits, []);
  } finally { await pepe("privacy.shown", "inccf", "bridge"); }
  assert.equal(CL.hiddenKind(INC_H), "anon", "!bridge show: incognito again - someone");
});

test("search: an incognito person's words are found without attribution; their name never matches; never From them", async () => {
  await ready();
  CS._setLimits({ perMin: 1000, perDay: 100000 });
  try {
    for (const viewer of [U.mem, U.own, U.staff]) {
      let r = await find(viewer, { q: "anonymous words" });
      assert.equal(r.status, 200, r.text.slice(0, 200));
      assert.deepEqual(r.d.hits.map((h) => [h.item.text, h.item.u]), [["ina anonymous words", SOMEONE]], "found, as someone");
      noName(r.text, "search for " + viewer.username);
      r = await find(viewer, { q: "named words" });
      assert.deepEqual(r.d.hits.map((h) => [h.item.text, h.item.u]), [["ina named words", SOMEONE]], "a line said before they hid: someone too");
      for (const q of ["Ina Cognito", "inccf", "cognito", "\"Ina Cognito\""]) {
        r = await find(viewer, { q });
        assert.equal(r.status, 200, q);
        assert.deepEqual(r.d.hits, [], q + ": their name never matches");
        noName(r.text, q);
      }
      r = await find(viewer, { q: "nice" });
      assert.deepEqual(r.d.hits.map((h) => h.item.text), ["hello someone and someone, nice"], "a line naming them: found by its other words, redacted");
      for (const from of ["inccf", "ina", "@inccf", "someone"]) {
        r = await find(viewer, { q: "words", from });
        assert.deepEqual({ hits: r.d.hits, more: r.d.more }, { hits: [], more: false }, "never From them: " + from);
      }
    }
  } finally { CS._setLimits({ perMin: CS.PER_MIN, perDay: CS.PER_DAY }); }
});

test("quotes: an incognito person's lines are quoted as 'someone' (the stored line keeps only the hash); later left out once they !bridge hide", async () => {
  await ready();
  const anonC = await cOf("ina anonymous words"), namedC = await cOf("ina named words"), aliceC = await cOf("alice plain words");
  const q = await call("POST", `/api/rooms/${SLUG}/quote`, U.mem, { cs: [namedC, anonC, aliceC] });
  assert.equal(q.status, 200, q.text.slice(0, 300));
  assert.deepEqual([q.d.lines, q.d.left_out], [3, 0]);
  const row = (await getQuery("SELECT * FROM feed_quotes WHERE post_id = ?", [q.d.post.id]))[0];
  const lines = JSON.parse(row.lines);
  const byText = (t) => lines.find((l) => l.text === t);
  for (const t of ["ina named words", "ina anonymous words"]) assert.deepEqual([byText(t).login, byText(t).name, byText(t).h], [null, "someone", INC_H], t);
  assert.equal(byText("alice plain words").login, "alicecf");
  assert.equal(byText("alice plain words").h, undefined);
  const stored = row.lines + row.logins + (await store.getRow(q.d.post.id)).body;
  assert.ok(!stored.includes("inccf") && !stored.includes("Ina Cognito"), "the stored quote names nobody (its lines keep the one-way hash, server-side)");
  let p = await store.get(q.d.post.id, U.mem);
  noName(JSON.stringify(p), "the quote post a viewer gets (no login, name or hash)");
  assert.deepEqual(p.quote.lines.filter((l) => /^ina /.test(l.text)).map((l) => [l.name, l.text]), [["someone", "ina named words"], ["someone", "ina anonymous words"]]);
  // Pepe's own !quote picks them too, as someone
  quotes._hits.clear();
  const pq = await call("POST", "/api/bridge/quote", null, { password: "bot", room: ROOM.id, camfrog: "memcf", spec: { mode: "range", from: "ina anonymous", to: "ina anonymous" } });
  assert.equal(pq.status, 200, pq.text.slice(0, 300));
  const prow = (await getQuery("SELECT * FROM feed_quotes WHERE post_id = ?", [pq.d.id]))[0];
  assert.deepEqual(JSON.parse(prow.lines).map((l) => [l.name, l.text, l.h]), [["someone", "ina anonymous words", INC_H]]);
  // a user-mode !quote of them is refused (it would attribute)
  quotes._hits.clear();
  assert.equal((await call("POST", "/api/bridge/quote", null, { password: "bot", room: ROOM.id, camfrog: "memcf", spec: { mode: "user", login: "inccf", n: 2 } })).status, 400);
  // they also type !bridge hide: their lines leave the card and the post's text; !bridge show: back, as someone
  await pepe("privacy.hidden", "inccf", "bridge");
  try {
    p = await store.get(q.d.post.id, U.mem);
    assert.deepEqual([p.quote.lines.map((l) => l.text), p.quote.left_out], [["alice plain words"], 2]);
    assert.ok(!/ina /.test(p.body) && !/ina /.test((await store.getRow(q.d.post.id)).body), "their words are out of the stored text too");
    quotes._hits.clear();
    const no = await call("POST", `/api/rooms/${SLUG}/quote`, U.mem, { cs: [anonC] });
    assert.equal(no.status, 403, "left out: not quotable");
  } finally { await pepe("privacy.shown", "inccf", "bridge"); }
  p = await store.get(q.d.post.id, U.mem);
  assert.deepEqual([p.quote.lines.length, p.quote.left_out], [3, 0]);
  assert.match((await store.getRow(q.d.post.id)).body, /<someone> ina anonymous words/);
});

test("a 🔊 mic clip of an incognito speaker is refused (a voice says who it is) - one answer, like any line outside the clipper's view", async () => {
  await ready();
  await bridge.ingest({ rooms: [snap()], events: [] });           // the room is live
  const r = await call("POST", `/api/rooms/${SLUG}/micclip`, U.mem, { tx: "tx-00000000000000c1" });
  assert.equal(r.status, 403, r.text.slice(0, 200));
  assert.equal(r.d.code, "not_quotable");
  noName(r.text, "the clip refusal");
});

test("@mention alerts: an incognito speaker's line alerts nobody; hidden names are redacted in a notice and never match an alert word", async () => {
  await ready();
  await M.init();
  await M.save(U.alice.userId, { enabled: true, names: true, words: [] });
  await M.save(U.mem.userId, { enabled: true, names: false, words: [{ phrase: "cognito", room: "" }, { phrase: "nice", room: "" }] });
  M._sent.clear();
  const R = bridge._rooms.get(ROOM.id);
  const mk = (u, text, extra = {}) => ({ roomId: ROOM.id, slug: SLUG, name: ROOM.name, it: Object.assign({ k: "msg", ts: Date.now(), c: 900000 + (++seq), u, text }, extra) });
  M.onLines([mk(SOMEONE, "hey alicecf look at this nice thing", { ah: INC_H })]);           // Pepe's anonymised line
  M.onLines([mk({ login: "inccf", display: "Ina Cognito" }, "alicecf you there? nice")]);     // a named line of theirs (hidden now)
  await M._idle();
  const none = await getQuery("SELECT * FROM inbox WHERE kind = 'mention' AND user_id IN (?, ?)", [U.alice.userId, U.mem.userId]);
  assert.equal(none.length, 0, "an incognito speaker never turns up as a mention");
  M._sent.clear();
  M.onLines([mk({ login: "bobcf", display: "Bob Birch" }, "alicecf did Ina Cognito leave, nice")]);
  await M._idle();
  const al = await getQuery("SELECT * FROM inbox WHERE kind = 'mention' AND user_id = ?", [U.alice.userId]);
  assert.equal(al.length, 1, "alice's own name still alerts her");
  assert.equal(al[0].body, "Bob Birch: alicecf did someone leave, nice", "the hidden name is redacted in the notice");
  const mm = await getQuery("SELECT * FROM inbox WHERE kind = 'mention' AND user_id = ?", [U.mem.userId]);
  assert.deepEqual(mm.map((n) => n.title), ["💬 Bob Birch said “nice” in Inc Room"], "'cognito' (part of a hidden name) never matches; 'nice' does");
  void R;
});

test("the per-login staff tool and the account export reach the lines they said while incognito; a merge re-keys an account's anonymised web lines", async () => {
  await ready();
  const look = await call("POST", "/api/admin/chatlog/who", U.staff, { key: "inccf", action: "look", why: "privacy request #1" });   // CL6 fix-up: a look needs its reason
  assert.equal(look.status, 200, look.text.slice(0, 200));
  const lines = look.d.summary.lines;
  assert.ok(lines >= 4, "named and anonymised rows: " + lines);
  const ex = await call("POST", "/api/admin/chatlog/who", U.staff, { key: "inccf", action: "export", why: "privacy request #1" });
  assert.equal(ex.status, 200, ex.text.slice(0, 200));
  const texts = ex.d.export.lines.map((l) => l.text);
  for (const t of ["ina named words", "ina anonymous words"]) assert.ok(texts.includes(t), "export: " + t);
  const own = await CL.exportLines(U.inc.userId, "inccf");
  const a = own.find((l) => l.text === "ina anonymous words");
  assert.ok(a, "their own data export has the line they said while incognito");
  assert.equal(a.shown_as, "someone");
  assert.ok(own.some((l) => l.text === "ina named words"));
  // a merge: the loser's anonymised web lines (who h:<hash of u:<id>>) follow to the survivor
  const from = "acct-from-1", to = "acct-to-1";
  await runQuery("INSERT INTO chat_log (c, rk, ts, k, who, text, rt, aud, d) SELECT 99000001, rk, ?, 'msg', ?, 'a web line said incognito', rt, 'm', '{\"u\":{\"anon\":true,\"display\":\"someone\"}}' FROM chat_log LIMIT 1",
                 [Date.now(), "h:" + hash("u:" + from)]);
  const m = await CL.mergeAccounts(from, to);
  assert.ok(m.who >= 1);
  assert.equal((await getQuery("SELECT who FROM chat_log WHERE c = 99000001"))[0].who, "h:" + hash("u:" + to));
  await runQuery("DELETE FROM chat_log WHERE c = 99000001");
});

test("the hidden set's two kinds: Pepe's kinded lists add their kind; an older Pepe's unknown kind is resolved (one, or many held as 'resolve'); 'legacy' holds; hubRows", async () => {
  await ready();
  const hx = (s) => hash("kind-" + s);
  const sync = async (body) => { await bridge.ingest(Object.assign({ events: [], rooms: [] }, body)); await settle(30); };
  // an older Pepe's mixed list: kind unknown -> left out (fail closed)
  await sync({ hidden_h: [hx("x"), hx("y"), hx("w"), hx("v")] });
  for (const k of ["x", "y", "w", "v"]) assert.deepEqual([CL.kindsOf(hx(k)), CL.isLeftOutHash(hx(k))], [["unknown"], true], k);
  // a kinded Pepe with a lost !bridge hide file (bridge_hidden_h null): nothing resolved, nothing held
  await sync({ hidden_h: [hx("x"), hx("y")], incog_hidden_h: [hx("x")], bridge_hidden_h: null });
  assert.deepEqual(CL.kindsOf(hx("x")), ["incognito", "unknown"], "incognito added; unknown kept");
  assert.equal(CL.isLeftOutHash(hx("x")), true, "still left out");
  // both lists, whole: x (incognito only) and y (bridge) are resolved; w and v (in neither, nor the mixed list) are held as legacy
  await sync({ hidden_h: [hx("x"), hx("y")], incog_hidden_h: [hx("x")], bridge_hidden_h: [hx("y")] });
  assert.deepEqual([CL.kindsOf(hx("x")), CL.hiddenKind(hx("x"))], [["incognito"], "anon"], "x: shown as someone now");
  assert.deepEqual([CL.kindsOf(hx("y")), CL.hiddenKind(hx("y"))], [["bridge"], "out"]);
  let held = (await CL.adminView()).held;
  const legacy = held.filter((h) => h.kind === "legacy");
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].n, 2, "w and v, in one batch");
  assert.equal(CL.isLeftOutHash(hx("w")), true, "held: still left out");
  // the next sync doesn't hold them again
  await sync({ hidden_h: [hx("x"), hx("y")], incog_hidden_h: [hx("x")], bridge_hidden_h: [hx("y")] });
  assert.equal((await CL.adminView()).held.filter((h) => h.kind === "legacy").length, 1);
  // rejected: they stay left out (not held again in this run); approved instead: un-hidden
  await CL.decideHeld(legacy[0].id, false, "test");
  await sync({ hidden_h: [hx("x"), hx("y")], incog_hidden_h: [hx("x")], bridge_hidden_h: [hx("y")] });
  assert.equal((await CL.adminView()).held.filter((h) => h.kind === "legacy").length, 0, "rejected: not held again in this run");
  assert.equal(CL.isLeftOutHash(hx("w")), true);
  // many at once (6 unknowns Pepe now reports as incognito only): held as "resolve" - left out until an operator approves
  const many = ["m1", "m2", "m3", "m4", "m5", "m6"].map(hx);
  await sync({ hidden_h: many });
  await sync({ hidden_h: many, incog_hidden_h: many, bridge_hidden_h: [] });
  held = (await CL.adminView()).held.filter((h) => h.kind === "resolve");
  assert.equal(held.length, 1);
  assert.equal(held[0].n, 6);
  assert.ok(many.every((h) => CL.isLeftOutHash(h)), "held: still left out");
  await sync({ hidden_h: many, incog_hidden_h: many, bridge_hidden_h: [] });
  assert.equal((await CL.adminView()).held.filter((h) => h.kind === "resolve").length, 1, "never held twice");
  const res = await CL.decideHeld(held[0].id, true, "test");
  assert.equal(res.removed, 0, "nobody un-hidden");
  assert.ok(many.every((h) => CL.hiddenKind(h) === "anon"), "approved: shown as someone");
  // !bridge show on an unknown (Pepe CL1's privacy.shown {bridge}): only the incognito half stays -> someone
  await sync({ hidden_h: [hx("u")] });
  await bridge.ingest({ events: [{ op: "event", id: "inc-k-" + (++seq), ts: new Date().toISOString(), type: "privacy.shown", data: { h: hx("u"), scope: "bridge" } }], rooms: [] });
  await settle(30);
  assert.deepEqual([CL.kindsOf(hx("u")), CL.hiddenKind(hx("u"))], [["incognito"], "anon"]);
  // the merge map onto hubhidden's rows (h, kind, since, src) - one set at the merge
  await CL.hideNow(["kind-web"], "web");
  await CL.hideNow(["kind-gone"], "forget");
  const rows = CL.hubRows();
  const of = (h) => rows.filter((r) => r.h === h).map((r) => [r.kind, r.src]).sort();
  assert.deepEqual(of(hx("x")), [["incognito", "pepe"]]);
  assert.deepEqual(of(hx("y")), [["bridge", "pepe"]]);
  assert.deepEqual(of(hx("w")), [["unknown", "pepe"]]);
  assert.deepEqual(of(hash("kind-web")), [["incognito", "web"]]);
  assert.deepEqual(of(hash("kind-gone")), [["protected", "forget"]]);
  assert.equal(CL.isLeftOutHash(hash("kind-gone")), true, "forget-me: left out for good");
  assert.ok(rows.every((r) => /^[0-9a-f]{20}$/.test(r.h) && Number.isFinite(r.since)));
  // the held kinds read on /admin/bridge
  const page = fs.readFileSync(path.join(repo, "views", "admin", "bridge.ejs"), "utf8");
  assert.match(page, /resolve: 'incognito only \(shown as "someone"\)'/);
  assert.match(page, /legacy: 'no longer listed \(un-hide\)'/);
});

// ── review 2 of the owner change (fix-ups) ──
const check = (user, cs) => call("POST", `/api/rooms/${SLUG}/history/check`, user, { cs });

test("review 2 (HIGH): an incognito person's anonymised lines never ride a redraw - `!incognito off` and on again move only their NAMED lines (live `removed` / `redo`, /history/check)", async () => {
  await ready();
  // (their anonymised 🎙 line was removed by them in the test above - the chat one stands for both)
  const anonC = await cOf("ina anonymous words");
  const namedC = await cOf("ina named words"), micC = await cOf("ina mic words"), aliceC = await cOf("alice plain words");
  const anon = [anonC], cs = [anonC, namedC, micC, aliceC];
  const inRings = (d, c) => (d.removed || []).includes(c) || (d.redo || []).some((x) => Number(x.c) === c);
  assert.equal(CL.hiddenKind(INC_H), "anon");
  const first = await live(U.mem);
  const at = first.d.cursor, jc = encodeURIComponent(first.d.jc);
  let rs = first.d.rs;
  try {
    // !incognito off: their named lines come back by name; the anonymised ones stay "someone" - in no ring, for no page
    await pepe("privacy.shown", "inccf", "incognito");
    let r = await live(U.mem, `after=${at}&jc=${jc}&rs=${rs}`);
    assert.deepEqual((r.d.redo || []).filter((x) => cs.includes(Number(x.c))).map((x) => [Number(x.c), x.u.login]).sort(),
                     [[namedC, "inccf"], [micC, "inccf"]].sort(), "only their named lines are drawn again (by name)");
    for (const c of anon) assert.ok(!inRings(r.d, c), "anonymised line " + c + " rides no ring");
    const hour = await live(U.mem, `after=${at}&jc=${jc}`);             // any page, the whole hour
    for (const c of anon) assert.ok(!inRings(hour.d, c), "...not in the hour's rings either: " + c);
    rs = r.d.rs;
    let k = await check(U.mem, cs);
    assert.equal(k.status, 200, k.text.slice(0, 200));
    assert.deepEqual([k.d.gone, k.d.redo], [[], []], "un-hidden: the check draws nothing again (a page keeps 'someone' until it loads)");
    // !incognito on again: the named lines go to "someone" (removed + redo); the anonymised ones still nowhere
    await pepe("privacy.hidden", "inccf", "incognito");
    r = await live(U.mem, `after=${at}&jc=${jc}&rs=${rs}`);
    assert.deepEqual((r.d.removed || []).filter((c) => cs.includes(c)).sort(), [namedC, micC].sort());
    assert.deepEqual((r.d.redo || []).filter((x) => cs.includes(Number(x.c))).map((x) => [Number(x.c), x.u]).sort((a, b) => a[0] - b[0]),
                     [[namedC, SOMEONE], [micC, SOMEONE]].sort((a, b) => a[0] - b[0]));
    for (const c of anon) assert.ok(!inRings(r.d, c), "anonymised line " + c + " rides no ring");
    noName(r.text, "the live answer after !incognito on");
    const all = await live(U.mem, `after=${at}&jc=${jc}`);
    assert.equal(new Set(all.d.removed).size, all.d.removed.length, "one entry per line after off / on");
    // the check: only the lines a page may still show by name - never the anonymised ones, whatever c's it is asked about
    k = await check(U.mem, cs);
    assert.deepEqual(k.d.redo.map((x) => Number(x.c)).sort(), [namedC, micC].sort());
    assert.ok(k.d.redo.every((x) => x.u && x.u.anon && x.u.display === "someone"));
    noName(k.text, "the check after !incognito on");
    k = await check(U.mem, anon);
    assert.deepEqual([k.d.gone, k.d.redo], [[], []], "asked only about the anonymised lines: nothing to tell");
    k = await check(U.alice, cs);
    assert.ok(!k.d.redo.some((x) => anon.includes(Number(x.c))), "any viewer");
  } finally {
    if (CL.hiddenKind(INC_H) !== "anon") await pepe("privacy.hidden", "inccf", "incognito");
  }
});

test("review 2 (MEDIUM-HIGH): search's identity filters skip 'someone' lines - a DM-blocked viewer finds an incognito blocker's words exactly as anyone does", async () => {
  await ready();
  CS._setLimits({ perMin: 1000, perDay: 100000 });
  await runQuery("CREATE TABLE IF NOT EXISTS dm_blocks (blocker_id TEXT, blocked_id TEXT, created_at INTEGER)");
  await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, 1)", [U.inc.userId, U.mem.userId]);
  const hits = async (user, q) => { const r = await find(user, { q }); assert.equal(r.status, 200, r.text.slice(0, 200)); return r.d.hits.map((h) => [h.item.text, h.item.u]); };
  try {
    const b = await CS.blockersOf(U.mem.userId);
    assert.ok(b.has("inccf") && ![...b].some((k) => k.startsWith("h:")), "no h: keys: " + JSON.stringify([...b]));
    for (const q of ["anonymous words", "named words"]) {
      const blocked = await hits(U.mem, q), other = await hits(U.alice, q);
      assert.equal(blocked.length, 1, q);
      assert.deepEqual(blocked, other, "the blocked viewer finds exactly what anyone finds: " + q);
      assert.deepEqual(blocked[0][1], SOMEONE);
    }
    // shown again: their NAMED lines are theirs again - out of the blocked viewer's search; the anonymised one stays everyone's
    await pepe("privacy.shown", "inccf", "incognito");
    assert.deepEqual(await hits(U.mem, "named words"), [], "a blocker's named line: not for the blocked viewer");
    assert.equal((await hits(U.alice, "named words")).length, 1);
    assert.deepEqual(await hits(U.mem, "anonymous words"), await hits(U.alice, "anonymous words"));
  } finally {
    await runQuery("DELETE FROM dm_blocks");
    if (CL.hiddenKind(INC_H) !== "anon") await pepe("privacy.hidden", "inccf", "incognito");
    CS._setLimits({ perMin: CS.PER_MIN, perDay: CS.PER_DAY });
  }
  // the private-activity check alike: a "someone" line is searched like everyone's; a NAMED line of a private account isn't
  const B = bridge;
  const L = new Map([[B.nameKey("inccf"), { acc: { userId: U.inc.userId }, priv: true }], [B.nameKey("alicecf"), { acc: { userId: U.alice.userId }, priv: true }]]);
  const named = { c: 1, k: "msg", ts: Date.now(), u: { login: "inccf", display: "Ina Cognito" }, text: "x" };
  const anonRow = { c: 2, k: "msg", ts: Date.now(), u: { anon: true, display: "someone" }, ah: INC_H, text: "x" };
  const alice = { c: 3, k: "msg", ts: Date.now(), u: { login: "alicecf", display: "Alice Ash" }, text: "x" };
  const blk = new Set(["inccf", "alicecf"]);
  assert.equal(CS.searchable(named, L, B, blk, new Set()), true, "incognito now: 'someone' - no identity filter");
  assert.equal(CS.searchable(anonRow, L, B, blk, new Set()), true);
  assert.equal(CS.searchable(alice, L, B, new Set(), new Set()), false, "a named line of a private account: not searchable");
  assert.equal(CS.searchable(alice, new Map([[B.nameKey("alicecf"), { acc: null }]]), B, blk, new Set()), false, "a named line of a blocker: not for the blocked viewer");
});

test("review 2 (MEDIUM): `!likeness clips off` holds for an incognito speaker - their 'someone' lines (named before, or Pepe's anonymised) aren't quoted, and the refusal names nobody", async () => {
  await ready();
  const L = require(path.join(repo, "likeness"));
  await L.init();
  const namedC = await cOf("ina named words"), anonC = await cOf("ina anonymous words"), aliceC = await cOf("alice plain words");
  await L.setPrefs(U.inc.userId, { clips: false });
  try {
    for (const cs of [[namedC, aliceC], [anonC, aliceC], [namedC, anonC]]) {
      quotes._hits.clear();
      const before = (await getQuery("SELECT points_balance FROM users WHERE userId = ?", [U.mem.userId]))[0].points_balance;
      const q = await call("POST", `/api/rooms/${SLUG}/quote`, U.mem, { cs });
      assert.equal(q.status, 403, q.text.slice(0, 200));
      assert.match(q.d.error, /^Someone in those lines has opted out of being quoted - nothing was charged\.$/);
      noName(q.text, "the refusal");
      assert.equal((await getQuery("SELECT points_balance FROM users WHERE userId = ?", [U.mem.userId]))[0].points_balance, before, "nothing charged");
    }
    // Pepe's !quote alike
    quotes._hits.clear();
    const pq = await call("POST", "/api/bridge/quote", null, { password: "bot", room: ROOM.id, camfrog: "memcf", spec: { mode: "range", from: "ina anonymous", to: "ina anonymous" } });
    assert.equal(pq.status, 403, pq.text.slice(0, 200));
    noName(pq.text, "Pepe's refusal");
    // the rest of the room is quotable as before
    quotes._hits.clear();
    assert.equal((await call("POST", `/api/rooms/${SLUG}/quote`, U.mem, { cs: [aliceC] })).status, 200);
  } finally { await L.setPrefs(U.inc.userId, { clips: true }); }
  quotes._hits.clear();
  assert.equal((await call("POST", `/api/rooms/${SLUG}/quote`, U.mem, { cs: [anonC] })).status, 200, "opted back in: quotable as someone");
});

test("review 2 (LOW): a quote's title never names an incognito speaker - redacted when made, and whenever it's shown (an edit, someone who hides later)", async () => {
  await ready();
  const anonC = await cOf("ina anonymous words"), aliceC = await cOf("alice plain words");
  quotes._hits.clear();
  const q = await call("POST", `/api/rooms/${SLUG}/quote`, U.mem, { cs: [anonC], title: "Ina Cognito said this, @inccf!" });
  assert.equal(q.status, 200, q.text.slice(0, 300));
  const row = await store.getRow(q.d.post.id);
  assert.equal(row.title, "someone said this, someone!", "stored redacted");
  noName(q.text, "the answer (its post address too)");
  await runQuery("UPDATE feed_posts SET title = ? WHERE id = ?", ["by Ina Cognito", q.d.post.id]);       // an edit naming them later
  let p = await store.get(q.d.post.id, U.mem);
  assert.equal(p.title, "by someone", "shown redacted");
  noName(JSON.stringify(p), "the quote post as a viewer gets it");
  // a quote titled with alice's name; she goes incognito afterwards
  quotes._hits.clear();
  const q2 = await call("POST", `/api/rooms/${SLUG}/quote`, U.mem, { cs: [aliceC], title: "Alice Ash classic" });
  assert.equal(q2.status, 200, q2.text.slice(0, 300));
  assert.equal((await store.getRow(q2.d.post.id)).title, "Alice Ash classic", "nobody hidden: as typed");
  await pepe("privacy.hidden", "alicecf", "incognito");
  try {
    p = await store.get(q2.d.post.id, U.mem);
    assert.equal(p.title, "someone classic");
    assert.ok(!JSON.stringify(p).includes("Alice Ash") && !JSON.stringify(p).includes("alicecf"));
    assert.equal((await store.getRow(q2.d.post.id)).title, "someone classic", "anonymised for good with her lines");
  } finally { await pepe("privacy.shown", "alicecf", "incognito"); }
});

test("review 2 (LOW): a named line Pepe relays after a website Incognito ON (he hasn't confirmed) is kept anonymised for good - `!incognito off` never names it", async () => {
  await ready();
  const AH = hash("alicecf");
  await bridge.ingest({ rooms: [snap()], events: [ev("message", { user: ALICE, text: "alice before web on" }, Date.now() - 1000)] });
  await settle();
  await CL.hideNow(["alicecf"], "web");                        // the website's switch: the site knows at once
  try {
    assert.equal(CL.hiddenKind(AH), "anon");
    assert.ok(CL.siteAnonSince(AH) > 0);
    // Pepe hasn't heard yet: he relays her next lines by name
    await bridge.ingest({ rooms: [snap()], events: [ev("message", { user: ALICE, text: "alice after web on" }),
                                                     ev("x.pepe.transcript", { id: "tx-00000000000000d1", user: ALICE, text: "alice mic after web on" })] });
    await settle();
    for (const t of ["alice after web on", "alice mic after web on"]) {
      const row = (await getQuery("SELECT who, d FROM chat_log WHERE text = ?", [t]))[0];
      assert.equal(row.who, "h:" + AH, "archived anonymised: " + t);
      assert.ok(!row.d.includes("alicecf") && !row.d.includes("Alice Ash"), t);
      const it = bridge._rooms.get(ROOM.id).feed.find((x) => x.text === t);
      assert.deepEqual([it.u, it.ah], [{ anon: true, display: "someone" }, AH], t);
    }
    assert.equal((await getQuery("SELECT who FROM chat_log WHERE text = ?", ["alice before web on"]))[0].who, "alicecf", "said before: hers");
  } finally { await pepe("privacy.shown", "alicecf", "incognito"); }
  assert.equal(CL.hiddenKind(AH), null);
  const h = await hist(U.mem, "limit=200");
  assert.deepEqual(h.d.items.find((x) => x.text === "alice after web on").u, SOMEONE, "un-hidden: still someone");
  assert.ok(!h.d.items.find((x) => x.text === "alice before web on").u.anon, "the line from before: by name again");
  const l = await live(U.mem);
  assert.deepEqual(l.d.feed.find((x) => x.text === "alice mic after web on").u, SOMEONE);
  // a batch that un-hides her first: her lines after that are hers (Pepe knows better)
  await CL.hideNow(["alicecf"], "web");
  await bridge.ingest({ rooms: [snap()], events: [pev("privacy.shown", "alicecf", "incognito"), ev("message", { user: ALICE, text: "alice after her own off" })] });
  await settle();
  assert.equal((await getQuery("SELECT who FROM chat_log WHERE text = ?", ["alice after her own off"]))[0].who, "alicecf");
  assert.equal(CL.hiddenKind(AH), null);
});

test("review 2 (LOW): an operator's 'keep left out' on a legacy / resolve batch lasts across a restart - not held again on every deploy", async () => {
  await ready();
  const hx = (s) => hash("kind-" + s);
  const sync = async (body) => { await bridge.ingest(Object.assign({ events: [], rooms: [] }, body)); await settle(30); };
  // (the hidden-set test above rejected the legacy batch of w and v)
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chatlog_hidden_held WHERE kind = 'legacy' AND state = 'rejected'"))[0].n, 1);
  const heldHs = async () => (await getQuery("SELECT hs FROM chatlog_hidden_held WHERE kind = 'legacy' AND state = 'pending'"))
    .flatMap((r) => JSON.parse(r.hs).map((x) => (typeof x === "string" ? x : x.h)));
  await CL._restartHidden();                                     // a restart: the set loaded fresh
  await sync({ hidden_h: [hx("x"), hx("y")], incog_hidden_h: [hx("x")], bridge_hidden_h: [hx("y")] });
  const again = await heldHs();
  assert.ok(!again.includes(hx("w")) && !again.includes(hx("v")), "rejected before the restart: not held again");
  assert.equal(CL.isLeftOutHash(hx("w")), true, "kept left out");
  // ...while one never decided is held once per run as before (the restart forgets that, as it did)
  await runQuery("UPDATE chatlog_hidden_held SET state = 'rejected' WHERE kind = 'legacy' AND state = 'pending'");
  assert.match(fs.readFileSync(path.join(repo, "views", "admin", "bridge.ejs"), "utf8"), /keep \? 'Keep left out' : 'Reject'/);
});

test("review 2 (LOW): Settings › Privacy says what incognito does now with NEW keys (other languages show this English until translated, never the old promise); a web-only identity isn't told to type !bridge hide", async () => {
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  for (const k of ["inc.what_web_someone", "inc.what_web_someone_acct", "inc.what_media_someone"]) assert.ok(en[k], k);
  assert.match(en["inc.what_web_someone"], /hides who you are, not what you say/);
  assert.match(en["inc.what_web_someone"], /!bridge hide/);
  assert.ok(!/!bridge hide/.test(en["inc.what_web_someone_acct"]) && /Remove my line/.test(en["inc.what_web_someone_acct"]));
  const v = fs.readFileSync(path.join(repo, "views", "privacy-settings.ejs"), "utf8");
  assert.match(v, /t\(st\.account \? 'inc\.what_web_someone_acct' : 'inc\.what_web_someone'\)/);
  assert.match(v, /t\('inc\.what_media_someone'\)/);
  assert.ok(!/t\('inc\.what_web'\)|t\('inc\.what_media'\)/.test(v), "the old keys (and their stale translations) are no longer shown");
  const de = JSON.parse(fs.readFileSync(path.join(repo, "locales", "de.json"), "utf8"));
  const core = require(path.join(repo, "i18n-core"));
  const t = core(de, en, "de");
  assert.ok(!/nicht angezeigt/.test(t("inc.what_web_someone")), "never the old German promise");
});
