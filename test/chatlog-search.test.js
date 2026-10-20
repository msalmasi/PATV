// CL9 chatlogsearch.js: search the pad chat (the chat-history spec §2.3, §3.5 "Search", §3.6, §3.15 "Search" and the leak test on
// search).
//   * dark and gated: chatlog.search off = 404 off; signed out 401; a cross-site POST 403; an unknown / site pad 404; 18+ without the
//     age confirmation 403; no-store + noindex;
//   * the query: exact words, the LAST word prefix-matched from 3 letters, "phrases", accents folded, at least one word of 2 letters
//     (too_short - From never searches alone), at most 8 words; the FTS self-test on, then the LIKE fallback with FTS5 off (partial)
//     and CJK queries on the LIKE path;
//   * newest first, `limit` at a time, More results with an opaque signed cursor (forged / another viewer's / another room's refused);
//   * Chat / Mic / Both, Hide Pepe, Before, From (a username, an exact login; unknown / hidden / private / blocking all answer alike);
//   * what's never found: a hidden person's lines and name (the golden leak test: JSON and the rendered results), a hit whose only
//     match was a redacted name, private-activity authors, the author who DM-blocked the viewer, removed and purged lines, lines
//     below the member's window, lines said while search was off (for members - the owner finds them);
//   * search off: 403 search_off for members, the owner / staff / mods still search (history.find);
//   * the budget: too_broad 422, busy 429; the index repairing = partial; limits 20 a minute / 300 a day; a staff search below the
//     public floor audited; nothing logs a query;
//   * the highlights (prefix-aware, accents) and the renderer's <mark>s; the pad page's 🔍 hooks; the query plans.
//   * CL9 fix-up: `more` only when another VISIBLE hit exists (hidden lines below a visible one, a "someone" guessed by name, a hidden
//     person's word - no oracle), the budget's own "more"; the cursor bound to the query; a failed name lookup fails closed and the
//     viewer's own lines stay findable; From runs one statement whoever it names (hidden / unknown / private / blocking: the stand-in
//     key) and a PATV username wins over a Camfrog login; a redacted name as an exact word finds nothing at once; the last-word
//     prefix's own budget and the exact fallback (`exact`, remembered); every statement on chatlogdb's search connection (never the
//     shared one: 503 busy) and its real interrupt; chatlog.search needs chatlog.history; refused requests count toward the minute;
//     the ⚑ Report wiring on results and pad-history's re-settle.
//   NODE_PATH=G:/PATV/node_modules node --test test/chatlog-search.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-search-test-"));
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
const CS = require(path.join(repo, "chatlogsearch"));
const PC = require(path.join(repo, "padchat"));
const CORE = require(path.join(repo, "public", "js", "chatlog-core.js"));

const H = 3600e3, D = 864e5;
const ROOM = { id: "Srch.Room", name: "Srch Room" }, SLUG = "srch-room";
const WIN = { id: "Srchwin.Room", name: "Srchwin Room" }, WSLUG = "srchwin-room";     // a 24 h window
const OFFR = { id: "Srchoff.Room", name: "Srchoff Room" }, OSLUG = "srchoff-room";    // search off, then on again
const OTHER = { id: "Srchother.Room", name: "Srchother Room" }, XSLUG = "srchother-room";
const RUN = { id: "Srchrun.Room", name: "Srchrun Room" }, RSLUG = "srchrun-room";      // a long run of a hidden person's lines
const ALICE = { id: "alicecf", login: "alicecf", display: "Alice" };
const BOB = { id: "bobcf", login: "bobcf", display: "Bob" };
const CAROL = { id: "carolcf", login: "carolcf", display: "Carol" };
const SHY = { id: "shycf", login: "shycf", display: "Shy Violet" };            // goes hidden
const PRIV = { id: "privcf", login: "privcf", display: "Priv" };               // a private-activity account
const BLOCK = { id: "blockcf", login: "blockcf", display: "Blocky" };          // DM-blocks the member
const PEPE = { id: "pepebot", login: "pepebot", display: "Pepe", is_self: true };
const users = new Map();
const U = {};
let base, server, seq = 0, T0 = 0;
const ev = (room, type, data, ts) => ({ op: "event", id: "se-" + (++seq), ts: new Date(ts).toISOString(), type, scope: { platform: "camfrog", room }, data });
const msg = (room, user, text, ts) => ev(room, "message", { user, text }, ts);
const snap = (room) => ({ room, members: [ALICE, BOB, CAROL], mic: [], count: 3, transcripts: true, mod: { modcf: { actions: ["kick", "ban"] } } });

function call(method, url, user, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const u = new URL(base + url);
    const h = Object.assign({ "x-requested-with": "fetch" }, data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {},
                            user ? { "x-test-user": user.userId } : {}, headers);
    for (const k of Object.keys(h)) if (h[k] == null) delete h[k];
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: h }, (res) => {
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
const find = (user, body, slug = SLUG, headers) => call("POST", `/api/rooms/${slug}/search`, user, body, headers);
const texts = (r) => (r.d && r.d.hits ? r.d.hits.map((h) => h.item.text) : []);
async function mkUser(name, cls = "pleb", camfrog = null) {
  const uid = "id-" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at)
                  VALUES (?, ?, ?, 'x', ?, 100000, ?, 5, '2026-01-01 00:00:00')`, [uid, name, name, cls, camfrog]);
  const u = { userId: uid, username: name, class: cls };
  users.set(uid, u);
  return u;
}
const cOf = async (text) => { const r = (await getQuery("SELECT c FROM chat_log WHERE text = ?", [text]))[0]; assert.ok(r, "archived: " + text); return Number(r.c); };
const hash = (k) => require("crypto").createHash("sha256").update("pepe-hidden:" + k).digest("hex").slice(0, 20);

const setup = (async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE IF NOT EXISTS dm_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (blocker_id, blocked_id))");
  await require(path.join(repo, "media")).ready;
  await require(path.join(repo, "inbox")).ready;
  require(path.join(repo, "actions"));
  U.own = await mkUser("own", "pleb", "owncf");
  U.mem = await mkUser("mem", "pleb", "memcf");
  U.mem2 = await mkUser("mem2", "pleb", "mem2cf");
  U.alice = await mkUser("alice", "pleb", "alicecf");
  U.mod = await mkUser("modu", "pleb", "modcf");
  U.staff = await mkUser("helper", "Staff");
  U.priv = await mkUser("privacc", "pleb", "privcf");
  U.block = await mkUser("blocker", "pleb", "blockcf");
  U.lim = await mkUser("limits", "pleb");
  await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)", [U.block.userId, U.mem.userId, 1]);
  await require(path.join(repo, "profilelayout")).save(U.priv.userId, { order: [], hidden: ["analytics"], priv: [], pub: [] });
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
  CL._setClock(() => Date.now() - 8 * D);
  await CL.setSwitch("notice", true, "test");
  CL._setClock(() => Date.now());
  await CL.setSwitch("archive", true, "test");
  await CL.setSwitch("history", true, "test");
  await CL.setSwitch("search", true, "test");
  T0 = Date.now();
  const evs = [
    msg(ROOM, ALICE, "ancient movie line", T0 - 40 * H),
    msg(ROOM, BOB, "the movies were great", T0 - 6 * H),
    msg(ROOM, ALICE, "Café au lait please", T0 - 5 * H),
    msg(ROOM, BOB, "an exact phrase here", T0 - 5 * H + 1000),
    msg(ROOM, BOB, "phrase an exact order", T0 - 5 * H + 2000),
    msg(ROOM, CAROL, "日本語のテキストです", T0 - 5 * H + 3000),
    msg(ROOM, SHY, "shy secret movie words", T0 - 4 * H),
    msg(ROOM, BOB, "hey Shy Violet look at this", T0 - 4 * H + 1000),
    msg(ROOM, PRIV, "private movie opinions", T0 - 4 * H + 2000),
    msg(ROOM, BLOCK, "blocker movie line", T0 - 4 * H + 3000),
    msg(ROOM, PEPE, "movie reminder from pepe", T0 - 3 * H),
    ev(ROOM, "x.pepe.transcript", { id: "tx-00000000000000c9", user: ALICE, text: "movie talk on the mic" }, T0 - 3 * H + 1000),
    ev(ROOM, "room.update", { changes: { topic: "movie night at nine" } }, T0 - 3 * H + 2000),
    msg(ROOM, ALICE, "removed movie line", T0 - 3 * H + 3000),
    msg(ROOM, ALICE, "a movie the owner hid", T0 - 3 * H + 4000),
    msg(ROOM, ALICE, "movie night tonight", T0 - 2 * H),
  ];
  for (let i = 0; i < 30; i++) evs.push(msg(ROOM, i % 2 ? BOB : ALICE, `pager line ${i}`, T0 - H + i * 1000));
  // CL3 fix-up: the pads have their owner while their chat is archived (an owner assigned AFTER the lines were said starts a new
  // owner era - owner_since - and reads the earlier lines only as far as the public window, unless staff grant it)
  for (const r of [ROOM, WIN, OTHER, OFFR, RUN]) await rooms.setOwner(r.id, "own", "test");
  await bridge.ingest({ rooms: [snap(ROOM)], events: evs });
  await bridge.ingest({ rooms: [snap(OTHER)], events: [msg(OTHER, ALICE, "other room movie", T0 - H)] });
  await bridge.ingest({ rooms: [snap(WIN)], events: [msg(WIN, ALICE, "window old movie", T0 - 30 * H), msg(WIN, ALICE, "window new movie", T0 - 2 * H)] });
  await bridge.ingest({ rooms: [snap(OFFR)], events: [msg(OFFR, ALICE, "said with search on", T0 - 3 * H)] });
  // Srchrun.Room: 5 old lines, 250 by the person who goes hidden, 5 new ones - more than one fetch (ROWS = 200) of candidates
  const run = [];
  for (let i = 0; i < 260; i++) {
    const ok = i < 5 || i >= 255;
    run.push(msg(RUN, ok ? ALICE : SHY, (ok ? "flood ok " : "flood shy ") + i, T0 - 5 * H + i * 1000));
  }
  for (let i = 0; i < run.length; i += 200) await bridge.ingest({ rooms: [snap(RUN)], events: run.slice(i, i + 200) });
  await bridge.ingest({ rooms: [snap(ROOM)], events: [msg(ROOM, ALICE, "purged movie line", T0 - 3 * H + 5000),
                                                     msg(ROOM, ALICE, "approved era movie line", T0 - 3 * H + 6000)] });
  await CV.init();
  await require(path.join(repo, "chatlogmod")).init();
  PC._reset();
  CV._clearCaches();
  await PC.save(U.own, { id: WIN.id }, { window_s: 86400 });
  // a line removed by its author (rm_at) and one purged
  await runQuery("UPDATE chat_log SET rm_at = ?, rm_by = 'self' WHERE text = 'removed movie line'", [Date.now()]);
  await runQuery("UPDATE chat_log SET rm_at = ?, rm_by = ?, rm_why = 'spam' WHERE text = 'a movie the owner hid'", [Date.now(), "mod:" + U.own.userId]);
  PURGED_C = await cOf("purged movie line");
  await runQuery("UPDATE chat_log SET purged = 1, text = NULL WHERE c = ?", [PURGED_C]);
  // a line said while the pad was Approved (its own aud): only for the people inside it, never widened
  await runQuery("UPDATE chat_log SET aud = 'a' WHERE text = 'approved era movie line'");
})();
let PURGED_C = 0;
// (no test.after / beforeEach: Node 16's runner lacks them - the server is unref'd, each test resets what it uses)
const ready = async () => { await setup; CS._reset(); PC._reset(); CV._clearCaches(); };

test("dark and gated: chatlog.search off = 404 off; signed out 401; cross-site 403; unknown / site pads 404; 18+ needs the age confirmation", async () => {
  await ready();
  await CL.setSwitch("search", false, "test");
  try {
    const r = await find(U.mem, { q: "movie" });
    assert.equal(r.status, 404);
    assert.equal(r.d.code, "off");
  } finally { await CL.setSwitch("search", true, "test"); }
  let r = await find(null, { q: "movie" });
  assert.equal(r.status, 401);
  assert.equal(r.d.code, "signin");
  assert.equal(r.headers["cache-control"], "no-store");
  assert.match(String(r.headers["x-robots-tag"]), /noindex, nofollow, noarchive/);
  r = await find(U.mem, { q: "movie" }, SLUG, { "x-requested-with": null });
  assert.equal(r.status, 403, "same-origin only");
  r = await find(U.mem, { q: "movie" }, SLUG, { origin: "https://evil.example" });
  assert.equal(r.status, 403, "a foreign origin");
  assert.equal((await call("GET", `/api/rooms/${SLUG}/search?q=movie`, U.mem)).status, 404, "no GET: queries stay out of URL logs");
  r = await find(U.mem, { q: "movie" }, "no-such-pad");
  assert.equal(r.status, 404);
  const site = (await getQuery("SELECT slug FROM rooms_registry WHERE platform IS NOT NULL AND platform <> 'camfrog' AND slug IS NOT NULL LIMIT 1"))[0];
  assert.ok(site, "a site pad exists");
  assert.equal((await find(U.mem, { q: "movie" }, site.slug)).status, 404);
  await runQuery("UPDATE rooms_registry SET adult = 1 WHERE room_id = ?", [ROOM.id]);
  await rooms.loadCache();
  CV._setAttested(() => false);
  CV._clearCaches();
  try {
    r = await find(U.mem, { q: "movie" });
    assert.equal(r.status, 403);
    assert.equal(r.d.code, "no_history");
  } finally {
    await runQuery("UPDATE rooms_registry SET adult = 0 WHERE room_id = ?", [ROOM.id]);
    await rooms.loadCache();
    CV._setAttested(null);
  }
  r = await find(U.mem, { q: "movie" });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.equal(r.headers["cache-control"], "no-store");
  assert.ok(r.d.hits.length > 0);
  assert.deepEqual(Object.keys(r.d.hits[0]).sort(), ["hl", "item"]);
});

test("the query: exact words, the last word prefix-matched from 3 letters, phrases, accents; too_short; at most 8 words", async () => {
  await ready();
  assert.equal(CL.ftsState().on, true, "the FTS5 self-test passed (chatlog.js): the index and its triggers are there");
  assert.equal((await find(U.mem, { q: "movie" })).d.partial, undefined, "not partial on the index path");
  // "movi" (last word, 4 letters) finds movie / movies; exact "movi" in front of another word finds nothing
  let r = await find(U.mem, { q: "movi", limit: 50 });
  assert.ok(texts(r).includes("the movies were great") && texts(r).includes("movie night tonight"), texts(r).join(" | "));
  r = await find(U.mem, { q: "movi night", limit: 50 });
  assert.deepEqual(texts(r), [], "only the LAST word is a prefix");
  r = await find(U.mem, { q: "movie nig", limit: 50 });
  assert.deepEqual(texts(r), ["movie night tonight", "movie night at nine"], "the last word: a prefix (the topic too), newest first");
  r = await find(U.mem, { q: "movie ni", limit: 50 });
  assert.deepEqual(texts(r), [], "under 3 letters the last word is exact");
  r = await find(U.mem, { q: "movie", limit: 50 });
  assert.ok(texts(r).includes("the movies were great"), "a 3+ letter single word is the last word too");
  r = await find(U.mem, { q: '"movie"', limit: 50 });
  assert.ok(!texts(r).includes("the movies were great"), "a quoted word is exact");
  // phrases stay phrases
  r = await find(U.mem, { q: '"an exact phrase"' });
  assert.deepEqual(texts(r), ["an exact phrase here"]);
  r = await find(U.mem, { q: "an exact phrase" });
  assert.deepEqual(texts(r).sort(), ["an exact phrase here", "phrase an exact order"], "bare words: anywhere");
  // accents folded both ways; the highlight covers the word as written
  r = await find(U.mem, { q: "cafe" });
  assert.deepEqual(texts(r), ["Café au lait please"]);
  assert.deepEqual(r.d.hits[0].hl, [[0, 4]]);
  r = await find(U.mem, { q: "CAFÉ LAIT" });
  assert.deepEqual(texts(r), ["Café au lait please"]);
  // too short: no word of 2 letters; From never searches on its own
  for (const q of ["", "a", "a b", "   ", "!!", "@"]) {
    r = await find(U.mem, { q });
    assert.equal(r.status, 400, JSON.stringify(q));
    assert.equal(r.d.code, "too_short");
  }
  r = await find(U.mem, { q: "", from: "alice" });
  assert.equal(r.status, 400, "From alone is refused");
  assert.equal(r.d.code, "too_short");
  // parse: at most 8 words, 100 characters, NFKC, controls stripped
  const P = CS.parse("one two three four five six seven eight nine ten");
  assert.equal(P.terms.length, 8);
  assert.equal(CS.parse("x".repeat(300)).q.length, 100);
  assert.deepEqual(CS.parse("ｍｏｖｉｅ\u0007night").terms.map((t) => t.words.join(" ")), ["movie", "night"]);
  assert.equal(CS.ftsMatch(CS.parse('don\'t "a b" stop mov'), 7), 'rt : "r7" AND text : ("don" "t" "a b" "stop" "mov"*)');
  assert.equal(CS.ftsMatch(CS.parse('"exact"')), 'text : ("exact")');
});

test("newest first, limit at a time, More results with an opaque signed cursor - no gap, no overlap; forged / foreign cursors refused", async () => {
  await ready();
  CS._setLimits({ perMin: 1000 });                     // (more than 20 requests here - refused ones count too)
  const all = [];
  let r = await find(U.mem, { q: "pager line", limit: 7 });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  let pages = 0;
  const toks = [];
  for (;;) {
    pages++;
    all.push(...r.d.hits.map((h) => Number(h.item.c)));
    if (!r.d.more) break;
    assert.match(r.d.cursor, /^s2\.[A-Za-z0-9_-]+$/);
    toks.push(r.d.cursor);
    r = await find(U.mem, { q: "pager line", limit: 7, cursor: r.d.cursor });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.ok(pages < 20);
  }
  assert.equal(all.length, 30, "every pager line once");
  assert.deepEqual(all, all.slice().sort((a, b) => b - a), "newest first");
  assert.equal(new Set(all).size, 30, "no overlap");
  assert.equal(r.d.cursor, null);
  assert.equal(pages, 5, "30 lines, 7 a page: the 5th page holds the last 2 and says no more (never an empty page after `more`)");
  // the cursor names no line: sealed (a fresh IV each time) - the same position never reads the same; every one the same length
  const one = (await find(U.mem, { q: "pager line", limit: 7 })).d.cursor, two = (await find(U.mem, { q: "pager line", limit: 7 })).d.cursor;
  assert.notEqual(one, two, "opaque: never the same text twice");
  assert.equal(new Set(toks.map((x) => x.length)).size, 1, "fixed width");
  // forged, another viewer's, another room's, garbage, the old format -> bad_cursor
  const forged = toks[0].slice(0, -3) + (toks[0].slice(-3) === "AAA" ? "BBB" : "AAA");
  for (const [u, c, slug] of [[U.mem, forged, SLUG], [U.mem2, toks[0], SLUG], [U.mem, toks[0], XSLUG], [U.mem, "p1.b.12.AAAAAAAAAAAAAAAAAAAAAA", SLUG], [U.mem, "12", SLUG],
                              [U.mem, "s1." + toks[0].slice(3), SLUG]]) {
    const x = await find(u, { q: "pager line", limit: 7, cursor: c }, slug);
    assert.equal(x.status, 400, c.slice(0, 20));
    assert.equal(x.d.code, "bad_cursor");
  }
  // CL9 fix-up: bound to the QUERY - another word, kind, From, Hide Pepe or Before refuses it; another page size doesn't
  for (const other of [{ q: "pager" }, { q: "pager line", kind: "chat" }, { q: "pager line", from: "alice" }, { q: "pager line", hide_pepe: true },
                       { q: "pager line", before: Date.now() }]) {
    const x = await find(U.mem, Object.assign({ limit: 7, cursor: toks[0] }, other));
    assert.equal(x.status, 400, JSON.stringify(other));
    assert.equal(x.d.code, "bad_cursor");
  }
  assert.equal((await find(U.mem, { q: "  PAGER   line ", limit: 3, cursor: toks[0] })).status, 200, "the same query, written differently");
  // sealPos / openPos round trip (the plan and the exact flag ride along); an old one expires; another viewer's / query's refused
  const t = Date.now(), qk = CS.queryKey(CS.parse("x y"), "all", "", false, null);
  assert.deepEqual(CS.openPos(CS.sealPos("R", "u1", qk, { scan: 1234, plan: "w", exact: true }, t), "R", "u1", qk, t), { scan: 1234, plan: "w", exact: true });
  assert.throws(() => CS.openPos(CS.sealPos("R", "u1", qk, { scan: 1234 }, t - 2 * 3600e3), "R", "u1", qk, t), (e) => e.code === "bad_cursor");
  assert.throws(() => CS.openPos(CS.sealPos("R", "u1", qk, { scan: 1234 }, t), "R", "u2", qk, t), (e) => e.code === "bad_cursor");
  assert.throws(() => CS.openPos(CS.sealPos("R", "u1", qk, { scan: 1234 }, t), "R", "u1", CS.queryKey(CS.parse("x z"), "all", "", false, null), t),
                (e) => e.code === "bad_cursor");
  assert.equal(CS.sealPos("R", "u1", qk, { scan: 1 }, t).length, CS.sealPos("R", "u1", qk, { scan: 999999999999 }, t).length, "fixed width");
  // limit bounds: 1..50, 20 by default
  assert.equal(CS.PAGE, 20);
  assert.equal((await find(U.mem, { q: "pager line" })).d.hits.length, 20);
  assert.equal((await find(U.mem, { q: "pager line", limit: 500 })).d.hits.length, 30);
  assert.equal((await find(U.mem, { q: "pager line", limit: 0 })).d.hits.length, 1);
});

test("Chat / Mic / Both, Hide Pepe, Before, the topic", async () => {
  await ready();
  let r = await find(U.mem, { q: "movie", kind: "mic", limit: 50 });
  assert.deepEqual(texts(r), ["movie talk on the mic"]);
  assert.equal(r.d.hits[0].item.k, "tx");
  r = await find(U.mem, { q: "movie", kind: "chat", limit: 50 });
  assert.ok(!texts(r).includes("movie talk on the mic"));
  assert.ok(texts(r).includes("movie night at nine"), "the topic is a chat-class line");
  r = await find(U.mem, { q: "movie", limit: 50 });
  assert.ok(texts(r).includes("movie talk on the mic") && texts(r).includes("movie reminder from pepe"));
  r = await find(U.mem, { q: "movie", limit: 50, hide_pepe: true });
  assert.ok(!texts(r).includes("movie reminder from pepe"), "Hide Pepe");
  assert.ok(texts(r).includes("movie night tonight"));
  r = await find(U.mem, { q: "movie", limit: 50, before: T0 - 2.5 * H });
  assert.ok(!texts(r).includes("movie night tonight"), "Before: nothing from then on");
  assert.ok(texts(r).includes("movie talk on the mic"));
  r = await find(U.mem, { q: "movie", before: new Date(T0 - 2.5 * H).toISOString(), limit: 50 });
  assert.ok(!texts(r).includes("movie night tonight"), "ISO-8601 too");
  assert.equal((await find(U.mem, { q: "movie", before: "yesterday" })).status, 400);
});

test("From: a PATV username or an exact Camfrog login narrows; unknown, hidden, private and blocking people all answer {hits: [], more: false}", async () => {
  await ready();
  let r = await find(U.mem, { q: "movie", from: "alice", limit: 50 });
  assert.ok(r.d.hits.length >= 2 && r.d.hits.every((h) => h.item.u.login === "alicecf"), texts(r).join(" | "));
  r = await find(U.mem, { q: "movie", from: "@BobCF", limit: 50 });
  assert.deepEqual(texts(r), ["the movies were great"], "an exact Camfrog login (case and @ ignored)");
  r = await find(U.mem, { q: "movie", from: "bob", limit: 50 });
  assert.deepEqual(r.d.hits, [], "not a display name");
  const want = { hits: [], more: false };
  for (const who of ["nobody-here", "carolcf", "privcf", "privacc", "blockcf", "blocker"]) {          // unknown, no hit, private, blocking
    r = await find(U.mem, { q: "movie", from: who });
    assert.equal(r.status, 200);
    assert.deepEqual({ hits: r.d.hits, more: r.d.more }, want, who);
    assert.equal(r.d.cursor, null);
  }
  // the blocker is found by someone they didn't block
  r = await find(U.mem2, { q: "movie", from: "blockcf" });
  assert.deepEqual(texts(r), ["blocker movie line"]);
  await CL.hideNow(["shycf"], "web");
  try {
    r = await find(U.own, { q: "movie", from: "shycf" });
    assert.deepEqual({ hits: r.d.hits, more: r.d.more }, want, "hidden: the same answer, even for the owner");
  } finally {
    await bridge.ingest({ events: [{ op: "event", id: "se-sh-" + (++seq), ts: new Date().toISOString(), type: "privacy.shown", data: { h: hash("shycf"), scope: "incognito" } }], rooms: [] });
    await new Promise((x) => setTimeout(x, 60));
  }
});

test("never found: private-activity authors, the author who DM-blocked the viewer, removed and purged lines, another room's lines", async () => {
  await ready();
  let r = await find(U.mem, { q: "movie", limit: 50 });
  const t = texts(r);
  assert.ok(!t.includes("private movie opinions"), "private activity: not searchable");
  assert.ok(!t.includes("blocker movie line"), "they DM-blocked this viewer");
  assert.ok(!t.includes("removed movie line") && !t.includes("a movie the owner hid"), "removed lines leave the index");
  assert.ok(!t.includes("other room movie"));
  assert.ok(t.includes("ancient movie line"), "40 hours back: inside the pad's default window (everything the tier keeps)");
  assert.ok(!t.includes("approved era movie line"), "an Approved-era line: not for someone outside the pad's approved members");
  assert.ok(texts(await find(U.own, { q: "approved era" })).includes("approved era movie line"), "the owner is inside");
  r = await find(U.mem2, { q: "movie", limit: 50 });
  assert.ok(texts(r).includes("blocker movie line"), "another viewer finds the blocker");
  assert.ok(!texts(r).includes("private movie opinions"));
  r = await find(U.own, { q: "movie", limit: 50 });
  assert.ok(!texts(r).includes("a movie the owner hid"), "the owner's muted rows are scrollback's, never search hits");
  assert.ok(!t.includes("purged movie line") && !r.text.includes("purged movie"), "a purged line is gone");
  // the index lost the removed and the purged line (the triggers)
  const c = await cOf("removed movie line");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chat_log_fts_docsize WHERE id IN (?, ?)", [c, PURGED_C]))[0].n, 0);
  // even a drifted index (an entry left behind) never brings one back: the SQL leaves out removed / purged rows itself
  await runQuery("INSERT INTO chat_log_fts (rowid, text, rt) SELECT c, 'removed movie line', rt FROM chat_log WHERE c = ?", [c]);
  try {
    r = await find(U.own, { q: "removed movie", limit: 50 });
    assert.deepEqual(r.d.hits, [], "a stale index entry finds nothing");
  } finally { await runQuery("INSERT INTO chat_log_fts (chat_log_fts, rowid, text, rt) SELECT 'delete', c, 'removed movie line', rt FROM chat_log WHERE c = ?", [c]); }
  // the private account shows in scrollback (only search leaves it out)
  const h = await call("GET", `/api/rooms/${SLUG}/history?limit=100`, U.mem);
  assert.ok(h.d.items.some((it) => it.text === "private movie opinions"));
});

test("the golden leak test: a hidden person's lines and names never come back from search (JSON, rendered results); a hit whose only match was their name is dropped", async () => {
  await ready();
  let r = await find(U.mem, { q: "violet" });
  assert.deepEqual(texts(r), ["hey Shy Violet look at this"], "before the hide");
  // the owner's decision-9 change, INCOGNITO (a website ON: incognito only): their words are found - as "someone", never by name
  CS._setLimits({ perMin: 1000, perDay: 100000 });           // (both kinds, four viewers: more searches than a minute allows)
  await CL.hideNow(["shycf"], "web");
  await CV.refreshNames();
  CV._clearCaches();
  const names = ["shycf", "Shy Violet"];
  const shyLine = (res) => res.d.hits.find((h) => h.item.text === "shy secret movie words");
  try {
    for (const viewer of [U.mem, U.own, U.mod, U.staff]) {
      for (const q of ["movie", "shy", "secret words", "violet", "look", "Shy Violet", "shycf"]) {
        r = await find(viewer, { q, limit: 50 });
        assert.equal(r.status, 200, q + ": " + r.text.slice(0, 200));
        for (const leak of names) assert.ok(!r.text.includes(leak), `${leak} leaked to ${viewer.username} for "${q}"`);
        const html = r.d.hits.map((h) => String(CORE.renderItem(h.item, { lang: "en", hl: h.hl }, CORE.htmlH))).join("\n");
        for (const leak of names) assert.ok(!html.toLowerCase().includes(leak.toLowerCase()), `${leak} in the rendered results for ${viewer.username}`);
      }
      r = await find(viewer, { q: "secret words" });
      const hit = shyLine(r);
      assert.ok(hit, "their words, found without attribution - for " + viewer.username);
      assert.deepEqual(hit.item.u, { anon: true, display: "someone" }, "as someone: no login, name, avatar, looks or flair");
      r = await find(viewer, { q: "violet" });
      assert.deepEqual(r.d.hits, [], "a hit whose only match was a redacted name is dropped");
      r = await find(viewer, { q: "look" });
      assert.deepEqual(texts(r), ["hey someone look at this"], "the line itself, redacted");
      r = await find(viewer, { q: "secret", from: "shycf" });
      assert.deepEqual({ hits: r.d.hits, more: r.d.more }, { hits: [], more: false }, "never From them");
    }
  } finally {
    await bridge.ingest({ events: [{ op: "event", id: "se-sh-" + (++seq), ts: new Date().toISOString(), type: "privacy.shown", data: { h: hash("shycf"), scope: "incognito" } }], rooms: [] });
    await new Promise((x) => setTimeout(x, 60));
    await CV.refreshNames();
  }
  // !bridge hide: their lines are LEFT OUT of search entirely (words included)
  await CL.hideNow(["shycf"], "pepe", "bridge");
  await CV.refreshNames();
  CV._clearCaches();
  try {
    const leaks = [...names, "shy secret movie words"];
    for (const viewer of [U.mem, U.own, U.mod, U.staff]) {
      for (const q of ["movie", "shy", "secret words", "violet", "look", "Shy Violet", "shycf"]) {
        r = await find(viewer, { q, limit: 50 });
        assert.equal(r.status, 200, q + ": " + r.text.slice(0, 200));
        for (const leak of leaks) assert.ok(!r.text.includes(leak), `${leak} leaked to ${viewer.username} for "${q}"`);
      }
      r = await find(viewer, { q: "look" });
      assert.deepEqual(texts(r), ["hey someone look at this"], "others' lines still found, the name redacted");
    }
  } finally {
    await bridge.ingest({ events: [{ op: "event", id: "se-sh-" + (++seq), ts: new Date().toISOString(), type: "privacy.shown", data: { h: hash("shycf"), scope: "bridge" } }], rooms: [] });
    await new Promise((x) => setTimeout(x, 60));
    await CV.refreshNames();
  }
  r = await find(U.mem, { q: "secret" });
  CS._setLimits({ perMin: CS.PER_MIN, perDay: CS.PER_DAY });
  assert.deepEqual(texts(r), ["shy secret movie words"], "un-hidden by Pepe: found again");
  assert.equal(r.d.hits[0].item.u.login, "shycf", "by name again");
});

test("a long run of a hidden person's lines: left out in SQL, walked past (several fetches) when it isn't; the budget's own More results; nothing leaks", async () => {
  await ready();
  assert.equal(CS.ROWS, 200);
  const ALL = ["flood ok 259", "flood ok 258", "flood ok 257", "flood ok 256", "flood ok 255", "flood ok 4", "flood ok 3", "flood ok 2", "flood ok 1", "flood ok 0"];
  await CL.hideNow(["shycf"], "pepe", "bridge");             // (the owner's decision-9 change: left out = !bridge hide)
  const pages = [];
  try {
    // CL9 fix-up: the hidden person's lines are out of the SQL (chatloghist.hiddenLogins) - never candidates: one page, no "more"
    let r = await find(U.mem, { q: "flood" }, RSLUG);
    pages.push(r.text);
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.deepEqual(texts(r), ALL);
    assert.equal(r.d.more, false);
    CS._setLimits({ fetchMax: 1 });
    r = await find(U.mem, { q: "flood" }, RSLUG);
    assert.deepEqual({ hits: texts(r), more: r.d.more }, { hits: ALL, more: false }, "one fetch is enough: the hidden run is never read");
    CS._setLimits({ fetchMax: CS.FETCH_MAX });
    // left to the JS checks only (a login the who map hasn't seen): the request walks past the run itself - 260 candidates, two
    // fetches - and still answers exactly
    CS._setHiddenSql(false);
    r = await find(U.mem, { q: "flood" }, RSLUG);
    pages.push(r.text);
    assert.deepEqual(texts(r), ALL);
    assert.equal(r.d.more, false, "no visible hit below the last one: no `more`, whatever was dropped");
    // a request whose budget runs out first (one fetch): what it found, `more` at its scan position, then the rest
    CS._setLimits({ fetchMax: 1 });
    r = await find(U.mem, { q: "flood" }, RSLUG);
    pages.push(r.text);
    assert.deepEqual(texts(r), ALL.slice(0, 5));
    assert.equal(r.d.more, true, "the budget ran out before the rows did");
    r = await find(U.mem, { q: "flood", cursor: r.d.cursor }, RSLUG);
    pages.push(r.text);
    assert.deepEqual(texts(r), ALL.slice(5));
    assert.equal(r.d.more, false);
    CS._setLimits({ fetchMax: CS.FETCH_MAX });
    // the same on the LIKE plan (FTS5 off)
    const fts = CL._fts.on;
    CL._fts.on = false;
    try {
      for (const sqlOut of [true, false]) {
        CS._setHiddenSql(sqlOut);
        r = await find(U.mem, { q: "flood" }, RSLUG);
        pages.push(r.text);
        const got = texts(r);
        while (r.d.more) { r = await find(U.mem, { q: "flood", cursor: r.d.cursor }, RSLUG); pages.push(r.text); got.push(...texts(r)); }
        assert.deepEqual(got, ALL, "LIKE, hidden people in SQL: " + sqlOut);
      }
    } finally { CL._fts.on = fts; }
    for (const p of pages) assert.ok(!p.includes("flood shy") && !p.includes("shycf") && !p.includes("Shy Violet"));
  } finally {
    CS._setHiddenSql(true);
    CS._setLimits({ fetchMax: CS.FETCH_MAX });
    await bridge.ingest({ events: [{ op: "event", id: "se-sh-" + (++seq), ts: new Date().toISOString(), type: "privacy.shown", data: { h: hash("shycf"), scope: "bridge" } }], rooms: [] });
    await new Promise((x) => setTimeout(x, 60));
  }
});

test("!transcripts off: the person's 🎙 lines can't be found (their chat lines can)", async () => {
  await ready();
  await CL.hideNow(["alicecf"], "web", "tx");
  try {
    let r = await find(U.mem, { q: "movie talk" });
    assert.deepEqual(r.d.hits, []);
    r = await find(U.mem, { q: "movie", from: "alicecf", kind: "mic" });
    assert.deepEqual({ hits: r.d.hits, more: r.d.more }, { hits: [], more: false });
    r = await find(U.mem, { q: "movie night tonight" });
    assert.deepEqual(texts(r), ["movie night tonight"]);
  } finally {
    await bridge.ingest({ events: [{ op: "event", id: "se-tx-" + (++seq), ts: new Date().toISOString(), type: "privacy.shown", data: { h: hash("alicecf"), scope: "tx" } }], rooms: [] });
    await new Promise((x) => setTimeout(x, 60));
  }
  assert.deepEqual(texts(await find(U.mem, { q: "movie talk" })), ["movie talk on the mic"]);
});

test("floors: a member under a 24 h window doesn't find older lines; the owner, a mod and staff do (staff audited)", async () => {
  await ready();
  let r = await find(U.mem, { q: "window movie", limit: 50 }, WSLUG);
  assert.deepEqual(texts(r), ["window new movie"]);
  r = await find(U.own, { q: "window movie", limit: 50 }, WSLUG);
  assert.deepEqual(texts(r), ["window new movie", "window old movie"]);
  r = await find(U.mod, { q: "window movie", limit: 50 }, WSLUG);
  assert.deepEqual(texts(r), ["window new movie", "window old movie"], "a mod: 7 days past the window");
  await runQuery("DELETE FROM chatlog_views WHERE user_id = ?", [U.staff.userId]);
  r = await find(U.staff, { q: "window movie", limit: 50 }, WSLUG);
  assert.deepEqual(texts(r), ["window new movie", "window old movie"]);
  await new Promise((x) => setTimeout(x, 50));
  const rows = await getQuery("SELECT * FROM chatlog_views WHERE user_id = ? AND kind = 'search'", [U.staff.userId]);
  assert.equal(rows.length, 1, "a staff search below the public floor is audited");
  await find(U.staff, { q: "window movie" }, WSLUG);
  await new Promise((x) => setTimeout(x, 30));
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chatlog_views WHERE user_id = ? AND kind = 'search'", [U.staff.userId]))[0].n, 1, "coalesced");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chatlog_views WHERE user_id = ?", [U.mem.userId]))[0].n, 0, "a member's searches never are");
});

test("search off: members 403 search_off, the owner / a mod / staff still search (history.find); lines said while it was off stay out for members", async () => {
  await ready();
  await PC.save(U.own, { id: OFFR.id }, { search: false });
  CV._clearCaches();
  let r = await find(U.mem, { q: "said" }, OSLUG);
  assert.equal(r.status, 403);
  assert.equal(r.d.code, "search_off");
  r = await find(U.own, { q: "said" }, OSLUG);
  assert.equal(r.status, 200);
  assert.deepEqual(texts(r), ["said with search on"]);
  assert.equal((await find(U.mod, { q: "said" }, OSLUG)).status, 200, "the room's mod");
  // the live answer: the 🔍 for the owner (with the mods-only note: search false), none for the member
  const lv = async (u) => (await call("GET", `/api/rooms/${OSLUG}/live`, u)).d.history;
  let hm = await lv(U.mem), ho = await lv(U.own);
  assert.equal(hm.find, false);
  assert.equal(ho.find, true);
  assert.equal(ho.search, false, "-> Only you and this pad's mods can search here.");
  // said while search was off, then search back on: members can't find it, the owner can
  await bridge.ingest({ rooms: [snap(OFFR)], events: [msg(OFFR, ALICE, "said while search was off", Date.now() - 1000)] });
  await new Promise((x) => setTimeout(x, 20));
  await PC.save(U.own, { id: OFFR.id }, { search: true });
  CV._clearCaches();
  r = await find(U.mem, { q: "said", limit: 50 }, OSLUG);
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.deepEqual(texts(r), [], "forward-only: nothing said before search came back on");
  r = await find(U.own, { q: "said", limit: 50 }, OSLUG);
  assert.deepEqual(texts(r), ["said while search was off", "said with search on"]);
  hm = await lv(U.mem);
  assert.equal(hm.find, true);
  // chatlog.search off: nobody gets the 🔍
  await CL.setSwitch("search", false, "test");
  try { assert.equal((await lv(U.own)).find, false); } finally { await CL.setSwitch("search", true, "test"); }
});

test("the LIKE fallback: FTS5 off (partial), and CJK queries; the same rules", async () => {
  await ready();
  let r = await find(U.mem, { q: "日本語" });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.deepEqual(texts(r), ["日本語のテキストです"], "a CJK run isn't a word to the tokenizer: the LIKE path");
  assert.equal(r.d.partial, true);
  assert.deepEqual(r.d.hits[0].hl, [[0, 3]]);
  const fts = CL._fts.on;
  CL._fts.on = false;
  try {
    r = await find(U.mem, { q: "movie nig", limit: 50 });
    assert.equal(r.d.partial, true);
    assert.deepEqual(texts(r), ["movie night tonight", "movie night at nine"], "the same words as the index: the last one a prefix");
    r = await find(U.mem, { q: "movi night", limit: 50 });
    assert.deepEqual(texts(r), [], "LIKE finds substrings; the re-match keeps the index's rule (only the last word is a prefix)");
    r = await find(U.mem, { q: "movie", limit: 50 });
    const t = texts(r);
    assert.ok(t.includes("the movies were great") && t.includes("movie talk on the mic"));
    for (const x of ["private movie opinions", "blocker movie line", "removed movie line", "a movie the owner hid", "other room movie"]) assert.ok(!t.includes(x), x);
    r = await find(U.mem, { q: "pager line", limit: 7 });
    let n = r.d.hits.length;
    while (r.d.more) { r = await find(U.mem, { q: "pager line", limit: 7, cursor: r.d.cursor }); n += r.d.hits.length; }
    assert.equal(n, 30, "paging works on the LIKE path too");
    r = await find(U.mem, { q: "window", limit: 50 }, WSLUG);
    assert.deepEqual(texts(r), ["window new movie"], "the floors too");
  } finally { CL._fts.on = fts; }
  // the index repairing: partial
  CL._fts.partial = true;
  try { assert.equal((await find(U.mem, { q: "movie" })).d.partial, true); } finally { CL._fts.partial = false; }
  assert.equal((await find(U.mem, { q: "movie" })).d.partial, undefined);
});

test("the budget: too_broad 422 and busy 429 from the search connection; limits 20 a minute / 300 a day; nothing logs a query", async () => {
  await ready();
  CS._setRunner(async () => { throw Object.assign(new Error("interrupted"), { code: "too_broad" }); });
  let r = await find(U.mem, { q: "movie" });
  assert.equal(r.status, 422);
  assert.equal(r.d.code, "too_broad");
  CS._setRunner(async () => { throw Object.assign(new Error("busy"), { code: "busy" }); });
  r = await find(U.mem, { q: "movie" });
  assert.equal(r.status, 429);
  assert.equal(r.d.code, "busy");
  // an unexpected error: logged by code only, never the query
  const said = [];
  const oe = console.error, ol = console.log, ow = console.warn;
  console.error = (...a) => said.push(a.join(" ")); console.log = (...a) => said.push(a.join(" ")); console.warn = (...a) => said.push(a.join(" "));
  try {
    CS._setRunner(async (sql, params) => { throw Object.assign(new Error("fts5: syntax error near " + params[0]), { code: "SQLITE_ERROR" }); });
    r = await find(U.mem, { q: "zebracorn secretword" });
    assert.equal(r.status, 500);
    CS._setRunner(null);
    r = await find(U.mem, { q: "zebracorn secretword", from: "alice" });
    assert.equal(r.status, 200);
  } finally { console.error = oe; console.log = ol; console.warn = ow; CS._setRunner(null); }
  assert.ok(!said.join("\n").includes("zebracorn") && !said.join("\n").includes("secretword"), said.join("\n"));
  // the real connection's budget: 400 ms, a queue of 4 (chatlogdb.js; its own test interrupts a slow statement)
  assert.equal(require(path.join(repo, "chatlogdb")).SEARCH_BUDGET_MS, 400);
  assert.equal(require(path.join(repo, "chatlogdb")).SEARCH_QUEUE, 4);
  // limits
  assert.equal(CS.PER_MIN, 20);
  assert.equal(CS.PER_DAY, 300);
  CS._setLimits({ perMin: 3 });
  for (let i = 0; i < 3; i++) assert.equal((await find(U.lim, { q: "movie" })).status, 200);
  r = await find(U.lim, { q: "movie" });
  assert.equal(r.status, 429);
  assert.equal(r.d.code, "rate");
  assert.ok(Number(r.headers["retry-after"]) >= 1);
  CS._reset();
  CS._setLimits({ perDay: 2 });
  for (let i = 0; i < 2; i++) assert.equal((await find(U.mem2, { q: "movie" })).status, 200);
  r = await find(U.mem2, { q: "movie" });
  assert.equal(r.status, 429);
  assert.equal(r.d.code, "daily");
  assert.equal((await find(U.mem2, { q: "x" })).d.code, "too_short", "a refused query isn't counted (and still answers)");
  CS._reset();
});

test("the highlights: prefix-aware, accents folded, phrases, merged; the renderer's <mark>s (chat, 🎙, topic) - and no change without hl", () => {
  const P = CS.parse("movie nig");
  assert.deepEqual(CS.matchRanges("Movie NIGHT, movie nights", P), [[0, 5], [6, 11], [13, 18], [19, 25]]);
  assert.equal(CS.matchRanges("movies night", CS.parse("movie nig")), null, "a non-last word is exact");
  assert.deepEqual(CS.matchRanges("Ça va? ça VA", CS.parse("ca va")), [[0, 2], [3, 5], [7, 9], [10, 12]]);
  assert.deepEqual(CS.matchRanges("say an exact phrase now", CS.parse('"an exact phrase"')), [[4, 19]]);
  assert.equal(CS.matchRanges("phrase an exact", CS.parse('"an exact phrase"')), null);
  assert.equal(CS.matchRanges("hey someone look", CS.parse("violet")), null);
  assert.deepEqual(CS.matchRanges("日本語のテキスト", CS.parse("テキスト")), [[4, 8]]);
  // the renderer: <mark>s inside the line's text only (never the name, never attributes)
  const it = { k: "msg", c: 5, ts: Date.UTC(2026, 9, 18, 21, 4), text: "movie night", u: { login: "bob", display: "movie bob" } };
  const plain = String(CORE.renderItem(it, { offset: 0 }, CORE.htmlH));
  assert.ok(!plain.includes("<mark>"));
  const hl = String(CORE.renderItem(it, { offset: 0, hl: [[0, 5], [6, 11]] }, CORE.htmlH));
  assert.equal(hl.replace(/<\/?mark>/g, ""), plain, "the same line, with marks");
  assert.match(hl, /<mark>movie<\/mark> <mark>night<\/mark><time/);
  assert.match(hl, /data-text="movie night"/);
  const tx = String(CORE.renderItem(Object.assign({}, it, { k: "tx" }), { offset: 0, hl: [[6, 11]] }, CORE.htmlH));
  assert.match(tx, /\u201cmovie <mark>night<\/mark>\u201d<time/);
  const tp = String(CORE.renderItem({ k: "topic", c: 6, ts: it.ts, text: "movie night at nine" }, { offset: 0, hl: [[0, 5]] }, CORE.htmlH));
  assert.equal(tp, '<div class="sys topic">📌 topic: <mark>movie</mark> night at nine · 21:04</div>');
  // bad ranges are ignored, out-of-range ones clipped
  assert.equal(String(CORE.renderItem(it, { offset: 0, hl: [["x", 2], [9, 3]] }, CORE.htmlH)), plain);
  assert.match(String(CORE.renderItem(it, { offset: 0, hl: [[6, 99]] }, CORE.htmlH)), /movie <mark>night<\/mark><time/);
});

test("the pad page: the 🔍 button and pad-search.js; history.find for a signed-in member only; plain ES5 in the browser module", async () => {
  await ready();
  let r = await call("GET", "/p/" + SLUG, U.mem);
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('id="rmSearchBtn"'), "the 🔍 in the chat heading");
  assert.match(r.text, /<script src="\/public\/js\/pad-search\.js\?v=\d+"><\/script>/);
  assert.match(r.text, /PATVPadSearch\.init\(/);
  const init = JSON.parse(/<script id="rmInit" type="application\/json">([\s\S]*?)<\/script>/.exec(r.text)[1].replace(/\\u003c/g, "<"));
  assert.equal(init.history.find, true);
  await require(path.join(repo, "padaccess")).setLevel(U.own, { id: ROOM.id }, "public");
  try {
    r = await call("GET", "/p/" + SLUG, null);
    const anon = JSON.parse(/<script id="rmInit" type="application\/json">([\s\S]*?)<\/script>/.exec(r.text)[1].replace(/\\u003c/g, "<"));
    assert.equal(anon.history.find, false, "no signed-out search");
  } finally { await require(path.join(repo, "padaccess")).setLevel(U.own, { id: ROOM.id }, "members"); }
  const src = fs.readFileSync(path.join(repo, "public", "js", "pad-search.js"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  for (const re of [/\.findLast(Index)?\(/, /\.toSorted\(/, /\bstructuredClone\(/, /\bObject\.hasOwn\(/, /\.at\(-?\d/, /\.replaceAll\(/,
    /=>/, /\blet\s/, /\bconst\s/, /`/, /\.\.\.\w/, /\bclass\s+\w/, /\?\./, /\?\?/]) assert.doesNotMatch(src, re, "pad-search.js: " + re);
  assert.doesNotMatch(src, /console\.(log|info|warn|error)\(/, "nothing logs a query or a line");
  assert.match(src, /'X-Requested-With': 'fetch'/, "same-origin POST");
  assert.match(src, /method: 'POST'/);
});

test("the queries keep their planned shape on this database: the FTS index drives, chat_log by its primary key, no temp sort", async () => {
  await ready();
  const rk = Number((await getQuery("SELECT rk FROM chatlog_rooms WHERE room_id = ?", [ROOM.id]))[0].rk);
  const plans = [];
  for (const o of [{}, { approved: false }, { kinds: CS.KINDS.mic, from: 2 }, { nOut: 3, nTx: 1 }, { nTx: 2 }]) {
    const sql = CS.ftsSql(o);
    const kinds = o.kinds || CS.KINDS.all;
    const params = [CS.ftsMatch(CS.parse("movie"), rk), 0, 1e15, rk, ...kinds, 0, 0, ...(o.from ? ["a", "b"] : []),
                    ...CS.outParams(["x1", "x2", "x3"].slice(0, o.nOut || 0), ["t1", "t2"].slice(0, o.nTx || 0)), CS.ROWS];
    assert.equal((sql.match(/\?/g) || []).length, params.length, "one parameter per placeholder: " + JSON.stringify(o));
    const plan = (await getQuery("EXPLAIN QUERY PLAN " + sql, params)).map((x) => x.detail);
    plans.push(plan);
    assert.match(plan[0], /^SCAN f VIRTUAL TABLE INDEX/, plan.join(" | "));
    assert.ok(plan.some((d) => /SEARCH l USING INTEGER PRIMARY KEY/.test(d)), plan.join(" | "));
    assert.ok(!plan.some((d) => /TEMP B-TREE/.test(d)), "newest first from the index: " + plan.join(" | "));
    assert.doesNotMatch(sql, /\bOR\b/);
  }
  const like = (await getQuery("EXPLAIN QUERY PLAN " + CS.likeSql({}, 1), [rk, 0, 1e15, ...CS.KINDS.all, 0, 0, CS.LIKE_ROWS, "%x%", CS.ROWS])).map((x) => x.detail);
  assert.match(like.join(" | "), /chat_log_room \(rk=\? AND c>\? AND c<\?\)/, like.join(" | "));
  assert.ok(!like.some((d) => /TEMP B-TREE/.test(d)), like.join(" | "));
  const likeOut = CS.likeSql({ nOut: 2, nTx: 1 }, 2);
  const lp = [rk, 0, 1e15, ...CS.KINDS.all, 0, 0, ...CS.outParams(["x1", "x2"], ["t1"]), CS.LIKE_ROWS, "%x%", "%y%", CS.ROWS];
  assert.equal((likeOut.match(/\?/g) || []).length, lp.length);
  assert.match((await getQuery("EXPLAIN QUERY PLAN " + likeOut, lp)).map((x) => x.detail).join(" | "), /chat_log_room \(rk=\? AND c>\? AND c<\?\)/);
  // CL9 fix-up: From = one key's lines on chat_log_who, both c bounds, in index order
  const who = CS.whoSql({ approved: false });
  const wp = ["alicecf", 0, 1e15, rk, ...CS.KINDS.all, 0, 0, CS.WHO_ROWS];
  assert.equal((who.match(/\?/g) || []).length, wp.length);
  const wplan = (await getQuery("EXPLAIN QUERY PLAN " + who, wp)).map((x) => x.detail);
  assert.match(wplan.join(" | "), /chat_log_who \(who=\? AND c>\? AND c<\?\)/, wplan.join(" | "));
  assert.ok(!wplan.some((d) => /TEMP B-TREE/.test(d)), wplan.join(" | "));
});

// ── CL9 fix-up ──
const P0 = { id: "Srchzero.Room", name: "Srchzero Room" }, P0S = "srchzero-room";   // one visible line (the control)
const P1 = { id: "Srchone.Room", name: "Srchone Room" }, P1S = "srchone-room";      // hidden lines below a visible one
const P2 = { id: "Srchtwo.Room", name: "Srchtwo Room" }, P2S = "srchtwo-room";      // a hidden person's flood between visible ticks
const MEM = { id: "memcf", login: "memcf", display: "Mem" };                        // the member's own Camfrog login
const ROB = { id: "robcf", login: "robcf", display: "Rob" };                        // linked to the PATV user named "bobcf"
const extra = (async () => {
  await setup;
  for (const r of [P0, P1, P2]) await rooms.setOwner(r.id, "own", "test");
  await bridge.ingest({ rooms: [snap(P0)], events: [msg(P0, ALICE, "zebra visible", T0 - H)] });
  await bridge.ingest({ rooms: [snap(P1)], events: [msg(P1, SHY, "zebra hidden one", T0 - 3 * H), msg(P1, SHY, "zebra hidden two", T0 - 2 * H),
                                                    msg(P1, ALICE, "zebra visible", T0 - H)] });
  const evs = [];
  for (let i = 0; i < 300; i++) {
    evs.push(msg(P2, SHY, "flood shy " + i, T0 - 5 * H + i * 2000));
    if (i % 10 === 0) evs.push(msg(P2, ALICE, "tick " + i, T0 - 5 * H + i * 2000 + 500));
  }
  for (let i = 0; i < evs.length; i += 150) await bridge.ingest({ rooms: [snap(P2)], events: evs.slice(i, i + 150) });
  await new Promise((x) => setTimeout(x, 30));
})();
const xready = async () => { await extra; await ready(); };
const unhide = async (login, scope = "incognito") => {
  await bridge.ingest({ events: [{ op: "event", id: "se-uh-" + (++seq), ts: new Date().toISOString(), type: "privacy.shown", data: { h: hash(login), scope } }], rooms: [] });
  await new Promise((x) => setTimeout(x, 60));
};
const RO = require(path.join(repo, "chatlogdb"));

test("CL9 fix-up: `more` never tells of left-out lines - hidden lines below a visible hit, a 'someone' guessed by name, a hidden person's word", async () => {
  await xready();
  // (the owner's decision-9 change: LEFT OUT = !bridge hide - an incognito person's words are found, as "someone")
  await CL.hideNow(["shycf"], "pepe", "bridge");
  await CV.refreshNames();
  CV._clearCaches();
  try {
    // (a) hidden lines under the only visible hit: the same answer as a room that never had them - on every plan, and with the
    // hidden people left to the JS checks only
    for (const sqlOut of [true, false]) {
      CS._setHiddenSql(sqlOut);
      for (const fts of [true, false]) {
        const was = CL._fts.on;
        CL._fts.on = fts;
        try {
          const a0 = await find(U.mem, { q: "zebra", limit: 1 }, P0S);
          const a1 = await find(U.mem, { q: "zebra", limit: 1 }, P1S);
          assert.deepEqual({ hits: texts(a1), more: a1.d.more, cursor: a1.d.cursor }, { hits: ["zebra visible"], more: false, cursor: null }, `sql ${sqlOut}, fts ${fts}`);
          assert.deepEqual({ hits: texts(a1), more: a1.d.more }, { hits: texts(a0), more: a0.d.more });
          const f = await find(U.mem, { q: "zebra", limit: 1, from: "alicecf" }, P1S);
          assert.deepEqual({ hits: texts(f), more: f.d.more }, { hits: ["zebra visible"], more: false }, "From too");
        } finally { CL._fts.on = was; }
      }
    }
    CS._setHiddenSql(true);
    // (b) the history shows "hey someone look at this"; posting a guess at the name and searching it tells nothing about that line,
    // (c) nor does searching a word the hidden person said
    await bridge.ingest({ rooms: [snap(ROOM)], events: [msg(ROOM, MEM, "hey look this violet", Date.now() - 3000), msg(ROOM, MEM, "hey look this carol", Date.now() - 2000),
                                                        msg(ROOM, MEM, "my secret", Date.now() - 1000)] });
    await new Promise((x) => setTimeout(x, 30));
    const h = await call("GET", `/api/rooms/${SLUG}/history?limit=100`, U.mem);
    assert.ok(h.d.items.some((it) => it.text === "hey someone look at this"), "redacted in the history");
    for (const sqlOut of [true, false]) {
      CS._setHiddenSql(sqlOut);
      const v = await find(U.mem, { q: "hey look this violet", limit: 1 });
      const c = await find(U.mem, { q: "hey look this carol", limit: 1 });
      assert.deepEqual({ hits: texts(v), more: v.d.more }, { hits: ["hey look this violet"], more: false }, "the redacted line is no `more`");
      assert.deepEqual({ hits: texts(c), more: c.d.more }, { hits: ["hey look this carol"], more: false });
      const s = await find(U.mem, { q: "secret", limit: 1 });
      assert.deepEqual({ hits: texts(s), more: s.d.more }, { hits: ["my secret"], more: false }, "as if they never said it");
    }
  } finally { CS._setHiddenSql(true); await unhide("shycf", "bridge"); await CV.refreshNames(); }
});

test("CL9 fix-up: a position can't be replayed with another query to place a hidden line", async () => {
  await xready();
  await CL.hideNow(["shycf"], "pepe", "bridge");             // (left out: !bridge hide)
  try {
    CS._setLimits({ fetchMax: 1 });
    let a = await find(U.mem, { q: "flood", limit: 50 }, P2S);
    assert.deepEqual({ hits: texts(a), more: a.d.more, cursor: a.d.cursor }, { hits: [], more: false, cursor: null }, "the hidden flood: never a candidate");
    // the worst case - the hidden lines left to the JS checks and a one-fetch budget, so the scan stops inside the hidden run: the
    // position it hands out works only for the same query
    CS._setHiddenSql(false);
    CS._setLimits({ fetchMax: 1 });
    a = await find(U.mem, { q: "flood", limit: 50 }, P2S);
    assert.equal(a.status, 200);
    assert.deepEqual(texts(a), []);
    assert.match(String(a.d.cursor), /^s2\./);
    const b = await find(U.mem, { q: "tick", limit: 1, cursor: a.d.cursor }, P2S);
    assert.equal(b.status, 400);
    assert.equal(b.d.code, "bad_cursor");
    assert.equal((await find(U.mem, { q: "flood", limit: 50, cursor: a.d.cursor }, P2S)).status, 200, "the same query goes on");
  } finally { CS._reset(); await unhide("shycf", "bridge"); }
});

test("CL9 fix-up: a failed name lookup fails closed (private stays private); the viewer's own lines are always theirs to find", async () => {
  await xready();
  let r = await find(U.priv, { q: "private movie" });
  assert.deepEqual(texts(r), ["private movie opinions"], "a private-activity account finds its own lines");
  r = await find(U.mem, { q: "private movie" });
  assert.deepEqual(texts(r), [], "nobody else does");
  const UL = require(path.join(repo, "userlinks"));
  const lookup = UL.lookup, resolve = UL.resolve;
  UL.lookup = async () => { throw new Error("db down"); };
  UL.resolve = async () => { throw new Error("db down"); };
  bridge._nameCache.clear();
  const oe = console.error;
  console.error = () => {};
  try {
    r = await find(U.mem2, { q: "movie", limit: 50 });
    assert.equal(r.status, 200);
    assert.ok(!texts(r).includes("private movie opinions"), "an author whose lookup failed counts as private");
    r = await find(U.alice, { q: "movie night tonight" });
    assert.deepEqual(texts(r), ["movie night tonight"], "the viewer's own line, lookup or not");
  } finally { UL.lookup = lookup; UL.resolve = resolve; console.error = oe; bridge._nameCache.clear(); }
  assert.deepEqual(texts(await find(U.mem2, { q: "blocker movie" })), ["blocker movie line"], "back to normal");
});

test("CL9 fix-up: From runs ONE statement on the speaker's own lines whoever it names - hidden, unknown, private, blocking, no-hit alike; a PATV username wins", async () => {
  await xready();
  const seen = [];
  CS._setRunner(async (sql, params, opts) => { seen.push({ sql, params: params.slice() }); return RO.search(sql, params, opts); });
  await CL.hideNow(["shycf"], "web");
  try {
    const want = { hits: [], more: false, cursor: null };
    for (const [who, key] of [["shycf", CS.SENTINEL], ["nobody-here", "nobody-here"], ["privcf", CS.SENTINEL], ["privacc", CS.SENTINEL], ["blockcf", CS.SENTINEL],
                              ["blocker", CS.SENTINEL], ["carolcf", "carolcf"], ["Some One!", CS.SENTINEL], ["@ShyCF", CS.SENTINEL]]) {
      seen.length = 0;
      const r = await find(U.mem, { q: "movie", from: who });
      assert.equal(r.status, 200, who);
      assert.deepEqual({ hits: r.d.hits, more: r.d.more, cursor: r.d.cursor }, want, who);
      assert.equal(seen.length, 1, who + ": one statement");
      assert.match(seen[0].sql, /INDEXED BY chat_log_who WHERE who = \?/, who + ": the speaker's own lines, never the index walk");
      assert.equal(seen[0].params[0], key, who);
      for (const p of seen[0].params) assert.ok(!["shycf", "privcf", "blockcf", "u:id-privacc", "u:id-blocker"].includes(String(p).toLowerCase()), `${who}: ${p} reached the SQL`);
    }
    // a PATV username wins over someone else's Camfrog login: "bobcf" is the PATV user linked to robcf, not the login bobcf
    await mkUser("bobcf", "pleb", "robcf");
    await bridge.ingest({ rooms: [snap(ROOM)], events: [msg(ROOM, ROB, "rob talks movie", Date.now() - 500)] });
    await new Promise((x) => setTimeout(x, 30));
    seen.length = 0;
    const r = await find(U.mem, { q: "movie", from: "bobcf", limit: 50 });
    assert.deepEqual(texts(r), ["rob talks movie"], "not the movies bobcf (the login) talked about");
    assert.deepEqual(seen.map((s) => s.params[0]).sort(), ["robcf", "u:id-bobcf"], "the account's u: key and its linked login");
    // a speaker whose lines run past the budget: the index with their keys as a filter (the same answer)
    CS._setRunner(async (sql, params, opts) => {
      if (/INDEXED BY chat_log_who/.test(sql)) throw Object.assign(new Error("interrupted"), { code: "too_broad" });
      return RO.search(sql, params, opts);
    });
    const f = await find(U.mem, { q: "movie", from: "alice", limit: 50 });
    assert.equal(f.status, 200, f.text.slice(0, 200));
    assert.ok(f.d.hits.length >= 2 && f.d.hits.every((x) => x.item.u.login === "alicecf"), texts(f).join(" | "));
  } finally { CS._reset(); await unhide("shycf"); }
});

test("CL9 fix-up: an exact word or phrase that is a redacted name finds nothing at once", async () => {
  await xready();
  await CL.hideNow(["shycf"], "web");
  await CV.refreshNames();
  CV._clearCaches();
  const seen = [];
  CS._setRunner(async (sql, params, opts) => { seen.push(sql); return RO.search(sql, params, opts); });
  try {
    for (const q of ['"shy violet"', '"shycf"', 'look "Shy Violet"']) {
      seen.length = 0;
      const r = await find(U.mem, { q });
      assert.deepEqual({ hits: r.d.hits, more: r.d.more }, { hits: [], more: false }, q);
      assert.equal(seen.length, 0, q + ": no statement");
    }
    seen.length = 0;
    await find(U.mem, { q: '"shy"' });
    assert.ok(seen.length >= 1, "a word that isn't a whole hidden name is searched as usual");
  } finally { CS._reset(); await unhide("shycf"); await CV.refreshNames(); }
});

test("CL9 fix-up: a last-word prefix too common for its budget falls back to the whole word - remembered, kept by More results, and said", async () => {
  await xready();
  assert.equal(CS.PREFIX_FALLBACK, true);
  const seen = [];
  CS._setRunner(async (sql, params, opts) => {
    const m = /chat_log_fts MATCH/.test(sql) ? String(params[0]) : "";
    seen.push({ m, budget: opts ? opts.budgetMs : undefined });
    if (/"\*/.test(m)) throw Object.assign(new Error("interrupted"), { code: "too_broad" });
    return RO.search(sql, params, opts);
  });
  try {
    let r = await find(U.mem, { q: "movie", limit: 50 });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.equal(r.d.exact, "movie", "the answer says which word was matched whole");
    assert.ok(texts(r).includes("movie night tonight") && !texts(r).includes("the movies were great"), texts(r).join(" | "));
    assert.equal(seen[0].budget, CS.PREFIX_BUDGET_MS, "the prefix statement's own budget");
    assert.match(seen[0].m, /"movie"\*/);
    assert.match(seen[1].m, /"movie"\)$/);
    assert.equal(seen[1].budget, undefined, "the whole word: the normal budget");
    assert.deepEqual(r.d.hits.find((x) => x.item.text === "movie night tonight").hl, [[0, 5]], "whole-word highlights");
    // remembered: no prefix attempt for it or a shorter prefix of it; a longer word is tried first
    for (const q of ["movie", "movi", "mov"]) {
      seen.length = 0;
      r = await find(U.mem, { q });
      assert.equal(r.d.exact, q);
      assert.ok(seen.length && seen.every((s) => !/"\*/.test(s.m)), q + ": " + seen.map((s) => s.m).join(" ; "));
    }
    seen.length = 0;
    r = await find(U.mem, { q: "movies" });
    assert.match(seen[0].m, /"movies"\*/);
    assert.deepEqual(texts(r), ["the movies were great"]);
    // More results keep matching it whole (the position carries it)
    seen.length = 0;
    r = await find(U.mem, { q: "line pager", limit: 7 });
    const got = texts(r);
    while (r.d.more) { r = await find(U.mem, { q: "line pager", limit: 7, cursor: r.d.cursor }); got.push(...texts(r)); assert.equal(r.d.exact, "pager"); }
    assert.equal(got.length, 30);
    assert.equal(seen.filter((s) => /"\*/.test(s.m)).length, 1, "one prefix attempt in all");
    // a prefix that fits its budget is a prefix as before (no `exact`)
    CS._reset();
    r = await find(U.mem, { q: "movi", limit: 50 });
    assert.equal(r.d.exact, undefined);
    assert.ok(texts(r).includes("the movies were great"));
  } finally { CS._reset(); }
});

test("CL9 fix-up: every statement runs on chatlogdb's search connection - never the shared one (503 busy) - and its real interrupt answers too_broad", async () => {
  await xready();
  const orig = RO.search;
  let n = 0;
  RO.search = (sql, params, opts) => { n++; return orig(sql, params, opts); };
  const oe = console.error;
  try {
    assert.equal((await find(U.mem, { q: "movie" })).status, 200);
    assert.ok(n >= 1, "the search connection ran it");
    n = 0;
    assert.equal((await find(U.mem, { q: "movie", from: "alice" })).status, 200);
    assert.ok(n >= 1, "From too");
    console.error = () => {};
    RO.search = async () => { throw Object.assign(new Error("no database file"), { code: "unavailable" }); };
    for (const body of [{ q: "movie" }, { q: "movie", from: "alice" }, { q: "日本語" }]) {
      const x = await find(U.mem, body);
      assert.equal(x.status, 503, JSON.stringify(body));
      assert.equal(x.d.code, "busy");
    }
    console.error = oe;
    // a statement past its budget on the search connection itself: interrupted there, "Too broad"
    const SLOW = "WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r WHERE x < 500000000) SELECT COUNT(*) AS n FROM r";
    RO.search = () => orig(SLOW, [], { budgetMs: 50 });
    const t0 = Date.now();
    const x = await find(U.mem, { q: '"movie"' });
    assert.equal(x.status, 422);
    assert.equal(x.d.code, "too_broad");
    assert.ok(Date.now() - t0 < 5000, "stopped early");
  } finally { RO.search = orig; console.error = oe; }
  assert.equal((await find(U.mem, { q: "movie" })).status, 200, "the connection is usable again");
});

test("CL9 fix-up: chatlog.search answers only while chatlog.history is on, and isn't turned on before it", async () => {
  await xready();
  await CL.setSwitch("history", false, "test");
  try {
    const r = await find(U.mem, { q: "movie" });
    assert.equal(r.status, 404);
    assert.equal(r.d.code, "off");
    assert.equal((await call("GET", `/api/rooms/${SLUG}/live`, U.own)).d.history.find, false, "no 🔍 while scrollback is off");
    await CL.setSwitch("search", false, "test");
    await assert.rejects(CL.setSwitch("search", true, "test"), (e) => e.code === "history_off" && e.status === 409);
  } finally { await CL.setSwitch("history", true, "test"); await CL.setSwitch("search", true, "test"); }
  assert.equal((await find(U.mem, { q: "movie" })).status, 200);
  assert.equal((await call("GET", `/api/rooms/${SLUG}/live`, U.own)).d.history.find, true);
});

test("CL9 fix-up: refused requests count toward the minute's limit (probing pads and views is limited too)", async () => {
  await xready();
  CS._setLimits({ perMin: 3 });
  try {
    assert.equal((await find(U.lim, { q: "movie" }, "no-such-pad")).status, 404);
    assert.equal((await find(U.lim, { q: "x" })).status, 400);
    assert.equal((await find(U.lim, { q: "movie", cursor: "s2.garbage" })).status, 400);
    const r = await find(U.lim, { q: "movie" });
    assert.equal(r.status, 429);
    assert.equal(r.d.code, "rate");
  } finally { CS._reset(); }
});

test("CL9 fix-up: results carry the ⋯ line menu (chat-lines watches the results box on the live pad and the offline card); reveal() settles again", () => {
  const room = fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8");
  assert.match(room, /var searchHits = el\('div', 'srch-hits'\);\s*var chatLines = window\.PATVChatLines \? PATVChatLines\.init\(\{[^}]*more: \[olderEl, searchHits\]/);
  assert.match(room, /PATVPadSearch\.init\(\{[\s\S]{0,300}results: searchHits/);
  const card = fs.readFileSync(path.join(repo, "views", "partials", "pad-chat-history.ejs"), "utf8");
  assert.match(card, /PATVChatLines\.init\(\{[^}]*more: \[searchHits\]/);
  assert.match(card, /PATVPadSearch\.init\(\{[\s\S]{0,300}results: searchHits/);
  assert.match(fs.readFileSync(path.join(repo, "public", "js", "chat-lines.js"), "utf8"), /var boxes = \[feed\]\.concat\(o\.more \|\| \[\]\)/);
  const rev = /function reveal\(\) \{[\s\S]*?\r?\n {4}\}\r?\n/.exec(fs.readFileSync(path.join(repo, "public", "js", "pad-history.js"), "utf8"));
  assert.ok(rev, "pad-history.js reveal()");
  assert.match(rev[0], /Promise\.resolve\(\)\.then\(put\)/, "settles again after the microtask");
  assert.match(rev[0], /requestAnimationFrame\(put\)/, "and after the next frame");
  const ps = fs.readFileSync(path.join(repo, "public", "js", "pad-search.js"), "utf8");
  assert.match(ps, /paintExact\(d\.exact \|\| null\)/, "the exact note");
  assert.match(ps, /autoN < AUTO_MAX/, "an empty page with more goes on by itself");
  // a topic line in the results keeps its height: the card's 2-line-clamped topic HEADER rule (overflow hidden) matched it, and the
  // full results box (a scrolling flex column) shrank it to its padding
  const css = fs.readFileSync(path.join(repo, "public", "css", "chatlog.css"), "utf8");
  assert.match(css, /\.chatlog \.sys\.topic \{ display: block; overflow: visible; -webkit-line-clamp: none;/);
  assert.match(css, /\.chatlog \.srch-hits > \* \{ flex-shrink: 0; \}/);
  assert.match(room, /\.rm \.rm-chat \.topic \{[^}]*overflow: hidden/, "(the header rule it overrides - same specificity, chatlog.css is linked after it)");
  assert.ok(room.indexOf("</style>") < room.indexOf("/public/css/chatlog.css"));
});
