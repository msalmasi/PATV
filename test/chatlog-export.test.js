// CL10: downloads of a pad's chat log (chatlogexport.js; the chat-history spec §2.4, §3.5 "Downloads", §3.8, §3.11, decision 8) -
// with the owner's change to decision 9 (2026-10-19): an INCOGNITO person's lines are in the file as "someone" (no name, login,
// picture, looks or 🎙 id - in the HTML, the TXT and the JSONL), a !bridge hide person's lines are LEFT OUT (counted "left out:
// privacy"), and both kinds' names are "someone" inside other people's lines.
//   * golden files (test/fixtures/chatlog/golden-18oct.{html,txt,jsonl}, en + UTC): one member's download of a day and a half of a pad,
//     byte for byte through the real routes ("PATV chat log v1" - frozen); the HTML's shared stylesheet (fileCss) is checked apart;
//     the same files with pages of 2 rows (streaming changes nothing); the golden leak test (no login, display name, PATV name, hash,
//     picture or 🎙 id of the incognito or the hidden person - text, attributes, JSONL keys);
//   * the HTML: CSP, no scripts, no external requests (links only to the profile / pad), pictures embedded once (data:) only for
//     people it names, only from the public root (".." / symlinks out / too big / not an image refused);
//   * who: signed out, a new unlinked account, a pad's downloads switch (Approved pads off by default), the chatlog.downloads switch;
//     what: the downloader's own view (a member's 24 h window vs the owner), presence off by default and 24 h for members, a mod's
//     public floors; a staff file below the public floor is audited;
//   * limits: 2 a minute, 10 a day (in the database: across a restart; every link asked for counts, a file cut off after its header
//     counts, one that failed before anything was sent doesn't), one streaming per account, `streaming` -> `failed` at boot; the
//     single-use 2-minute link of the same account; the 31-day and 50,000-line cuts with the footer; the per-export resolver leaves
//     the live chat's cache alone; Settings › Account's list and the admin card (metadata only).
//   * CL10 fix-up (the review): the estimate is exactly the file's lines (never a count of archived rows: hidden, taken-down, old
//     presence) and ranges are whole minutes; chatlog.history off stops downloads; one privacy state per file (pass 1 made again,
//     pass 2 fails); a deadline and a stall limit; the staff audit written before the file; the 31-day cut, zone and language kept
//     with the row; a refused link goes back to the pad (?cldl=); a made-up token computes no view; link fetches are limited; the
//     gates through the export routes (18+, blocks, feed bans, the 💎 gate); a web-only speaker, a deleted web account and a
//     common-word hidden name in a file.
//   NODE_PATH=G:/PATV/node_modules node --test test/chatlog-export.test.js
//   CHATLOG_GOLDEN_WRITE=1 ... rewrites the golden files (review the diff: they are the format's contract)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chatlog-export-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
delete process.env.PUBLIC_BASE_URL;
delete process.env.SITE_URL;
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
const X = require(path.join(repo, "chatlogexport"));
const CORE = require(path.join(repo, "public", "js", "chatlog-core.js"));

const D = 864e5;
const GOLD = path.join(__dirname, "fixtures", "chatlog");
const WRITE = process.env.CHATLOG_GOLDEN_WRITE === "1";
const T_SETUP = Date.UTC(2026, 9, 14, 0, 0, 0);          // the archive's start (the clock while the room is set up)
const T_NOW = Date.UTC(2026, 9, 19, 14, 2, 0);           // "now" for every download: Monday 19 October 2026, 14:02 UTC
const at = (d, h, m, s = 0) => Date.UTC(2026, 9, d, h, m, s);
const hash = (login) => crypto.createHash("sha256").update("pepe-hidden:" + String(login).trim().toLowerCase()).digest("hex").slice(0, 20);
const ROOM = { id: "Golden.Room", name: "Golden Room" }, SLUG = "golden-room";
const APPR = { id: "Appr.Room", name: "Appr Room" }, ASLUG = "appr-room";
// CL10 fix-up (test gaps 3 and 4): a second room - a web-only speaker (u:<id>, resolved by id), a web line from a deleted account
// ("former member") and a !bridge hide person whose display name is a common word (the stop-list). Ingested AFTER the golden room's
// lines, so the golden files' cursors (JSONL "c") don't move.
const WEB = { id: "Web.Room", name: "Web Room" }, WSLUG = "web-room";
const PEPE = { id: "pepebot", login: "pepebot", display: "Pepe", is_self: true };
const ALICE = { id: "alicecf", login: "alicecf", display: "Alice CF" };       // linked: shown as her PATV name, "Alice Ash"
const BOB = { id: "bobcf", login: "bobcf", display: "Bob Birch" };            // not linked: his Camfrog name, login as the tooltip
const MAE = { id: "maecf", login: "maecf", display: "Mae CF" };               // linked, with a picture on the site: embedded
const INC = { id: "inccf", login: "inccf", display: "Ina Cognito" };          // goes INCOGNITO: "someone"; her picture never in a file
const BRI = { id: "bricf", login: "bricf", display: "Bri Hidden" };           // types !bridge hide: left out
const HAP = { id: "happycf", login: "happycf", display: "happy" };            // Web.Room: types !bridge hide; "happy" is a stop-list word
const INC_H = hash("inccf"), BRI_H = hash("bricf"), HAP_H = hash("happycf");
const ANON = () => ({ id: "anon-" + crypto.randomBytes(4).toString("hex"), display: "someone", anonymous: true });
// two tiny, different, valid PNGs (1x1) - Mae's and the incognito person's pictures, under the test's own public root
const PNG = (rgb) => {
  const crc = (b) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    let x = 0xffffffff; for (const v of b) x = t[(x ^ v) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  const raw = Buffer.from([0, rgb[0], rgb[1], rgb[2]]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", require("zlib").deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
};
const PUB = path.join(tmp, "pubroot");
fs.mkdirSync(path.join(PUB, "img"), { recursive: true });
fs.writeFileSync(path.join(PUB, "img", "mae.png"), PNG([46, 139, 87]));
fs.writeFileSync(path.join(PUB, "img", "inc.png"), PNG([200, 30, 30]));
fs.writeFileSync(path.join(PUB, "img", "big.png"), Buffer.concat([PNG([1, 2, 3]), Buffer.alloc(70 * 1024)]));
fs.writeFileSync(path.join(PUB, "img", "pic.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
fs.writeFileSync(path.join(tmp, "secret.png"), PNG([9, 9, 9]));
let symOk = true;
try { fs.symlinkSync(path.join(tmp, "secret.png"), path.join(PUB, "img", "link.png")); } catch (e) { symOk = false; }
const INC_B64 = fs.readFileSync(path.join(PUB, "img", "inc.png")).toString("base64");

const users = new Map();
const U = {};
let base, server, seq = 0;
const ev = (room, type, data, ts) => ({ op: "event", id: "dl-" + (++seq), ts: new Date(ts).toISOString(), type, scope: { platform: "camfrog", room }, data });
const pev = (type, login, scope, ts) => ({ op: "event", id: "dl-p-" + (++seq), ts: new Date(ts).toISOString(), type, data: { h: hash(login), scope } });
const snap = (room, members) => ({ room, members: members || [ALICE, BOB, MAE, INC, BRI], mic: [], count: 5, transcripts: true, clip: true });
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function call(method, url, user, body, extra = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const u = new URL(base + url);
    const headers = Object.assign({ "x-requested-with": "fetch" }, data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {},
                                  user ? { "x-test-user": user.userId } : {}, extra);
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => { const s = Buffer.concat(parts).toString("utf8"); let d = null; try { d = JSON.parse(s); } catch (e) { d = null; } resolve({ status: res.statusCode, d, text: s, headers: res.headers }); });
      res.on("aborted", () => reject(new Error("aborted")));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const ask = (user, body, slug = SLUG, extra) => call("POST", `/api/rooms/${slug}/chatlog/export`, user, body, extra);
/** A refused link: a 303 back to the pad with ?cldl=<code> -> the code (CL10 fix-up). */
function backCode(f, slug = SLUG) {
  assert.equal(f.status, 303, "a refusal is a redirect back to the pad: " + f.status + " " + String(f.text).slice(0, 200));
  const m = /^\/p\/([a-z0-9-]+)\?cldl=([a-z_]+)$/.exec(String(f.headers.location || ""));
  assert.ok(m, "Location: " + f.headers.location);
  assert.equal(m[1], slug);
  return m[2];
}
/** GET a link and keep whatever arrives; onData(chunk) per chunk. -> {status, text, cut (the connection was cut before the end)} */
function fetchRaw(user, url, onData) {
  return new Promise((resolve) => {
    const u = new URL(base + url);
    const parts = [];
    let res0 = null, done = false;
    const fin = (cut) => { if (done) return; done = true; resolve({ status: res0 && res0.statusCode, text: Buffer.concat(parts).toString("utf8"), cut }); };
    const req = http.request({ method: "GET", hostname: u.hostname, port: u.port, path: u.pathname, headers: { "x-test-user": user.userId } }, (res) => {
      res0 = res;
      res.on("data", (c) => { parts.push(c); if (onData) onData(c); });
      res.on("end", () => fin(false));
      res.on("aborted", () => fin(true));
      res.on("error", () => fin(true));
      res.on("close", () => fin(!res.complete));
    });
    req.on("error", () => fin(true));
    req.end();
  });
}
const PAGE_SQL = /^SELECT \* FROM chat_log WHERE rk = \? AND c >= \?/;
/** Run fn(sql) before every archive read (chatlogdb's read connection, stubbed; the read then goes to the shared one). -> undo */
function onReads(fn) {
  const DB = require(path.join(repo, "chatlogdb"));
  const orig = DB.read;
  DB.read = async (sql) => { await fn(String(sql)); throw Object.assign(new Error("unavailable"), { code: "unavailable" }); };
  return () => { DB.read = orig; };
}
/** Pepe's privacy.shown for a login (the hide undone). */
async function shown(login, scope) {
  await bridge.ingest({ events: [{ op: "event", id: "dl-sh-" + (++seq), ts: new Date(T_NOW + 3600e3).toISOString(), type: "privacy.shown", data: { h: CL.hash(login), scope } }], rooms: [] });
  await settle();
  await CV.refreshNames();
  CV._clearCaches();
}
const fetchFile = (user, url) => call("GET", url, user);
/** POST then GET: -> {r (the POST answer), f (the file answer)} */
async function download(user, body, slug = SLUG, extra) {
  const r = await ask(user, body, slug, extra);
  assert.equal(r.status, 200, "export refused: " + r.text);
  const f = await fetchFile(user, r.d.url);
  return { r, f };
}
async function mkUser(name, o = {}) {
  const uid = "id-" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, avatar, created_at)
                  VALUES (?, ?, ?, 'x', ?, 100000, ?, ?, ?, '2026-01-01 00:00:00')`,
                 [uid, name, o.display || name, o.cls || "pleb", o.camfrog || null, o.level == null ? 5 : o.level, o.avatar || null]);
  const u = { userId: uid, username: name, class: o.cls || "pleb" };
  users.set(uid, u);
  return u;
}
/** Set every clock the downloads read (the archive's / the views' and the export's own). */
function clocks(t) { CL._setClock(() => t); X._setClock(() => t); CV._clearCaches(); }
/** Run fn with Date.now() at t (the site's own notices - 🎥, 📜 - take their time from it). */
async function at_(t, fn) { const real = Date.now; Date.now = () => t; try { return await fn(); } finally { Date.now = real; } }
/** The HTML file with the shared stylesheet (fileCss: chatlog.css + the flair chip, tokens written in) as a marker - the golden file
 *  holds everything else; the stylesheet has its own checks. */
function normHtml(s) {
  const css = X.fileCss();
  assert.ok(s.includes(css), "the HTML carries the shared stylesheet");
  return s.replace(css, "/* fileCss(): public/css/chatlog.css + the flair chip, ds tokens written in */");
}
function golden(name, got) {
  const f = path.join(GOLD, name);
  if (WRITE) { fs.writeFileSync(f, got); return; }
  const want = fs.readFileSync(f, "utf8");
  if (got !== want) {
    const a = got.split("\n"), b = want.split("\n");
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    assert.fail(`${name} differs from the golden file at line ${i + 1}:\n  got:  ${a[i]}\n  want: ${b[i]}`);
  }
}
/** Nothing in s names INC or BRI, nor says BRI's words - the golden leak rule (visible text, attributes, JSONL keys). */
function noLeak(s, where) {
  for (const leak of ["inccf", "Ina Cognito", "Ina PATV", "incuser", INC_H, INC_B64, "tx-00000000000000c1", "tx-00000000000000c2",
                      "bricf", "Bri Hidden", "briuser", BRI_H, "bri secret words", "the hidden spam line"]) {
    const i = s.indexOf(leak);
    assert.ok(i < 0, `${leak} leaked (${where}): ...${s.slice(Math.max(0, i - 120), i + 40)}...`);
  }
}

const setup = (async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await require(path.join(repo, "media")).ready;
  await require(path.join(repo, "inbox")).ready;
  require(path.join(repo, "actions"));
  U.own = await mkUser("own", { camfrog: "owncf" });
  U.mem = await mkUser("mem", { camfrog: "memcf" });
  U.mem2 = await mkUser("mem2");                                   // level 5, nothing linked: established by level
  U.newb = await mkUser("newb", { level: 1 });                     // level 1, nothing linked: not established
  U.lim = await mkUser("lim");
  U.staff = await mkUser("helper", { cls: "Staff" });
  U.alice = await mkUser("alice", { camfrog: "alicecf", display: "Alice Ash" });
  U.mae = await mkUser("mae", { camfrog: "maecf", display: "Mae Moss", avatar: "/public/img/mae.png" });
  U.inc = await mkUser("incuser", { camfrog: "inccf", display: "Ina PATV", avatar: "/public/img/inc.png" });
  U.bri = await mkUser("briuser", { camfrog: "bricf", display: "Bri PATV", avatar: "/public/img/mae.png" });
  await rooms.init();
  await settle(150);
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; if (req.get("x-test-tz")) req.tz = req.get("x-test-tz"); next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  require(path.join(repo, "pads")).register(app);
  bridge.register(app, { addUser, isBotToken: (t) => t === "bot" });
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  await new Promise((r) => { server = app.listen(0, r); });
  server.unref();
  base = "http://127.0.0.1:" + server.address().port;
  X._setRoots([["/public/", PUB]]);
  // the archive on (the notice 8 days before), downloads on; the room set up at T_SETUP
  CL._setClock(() => T_SETUP - 8 * D);
  await CL.setSwitch("notice", true, "test");
  clocks(T_SETUP);
  for (const s of ["archive", "history", "downloads"]) await CL.setSwitch(s, true, "test");
  await rooms.setOwner(ROOM.id, "own", "test");
  await CV.reconcileNow(ROOM.id);
  // 15 October: an older line and join (outside the golden range; the window test reads them)
  await bridge.ingest({ rooms: [snap(ROOM)], events: [
    ev(ROOM, "member.join", { user: ALICE }, at(15, 11, 59)),
    ev(ROOM, "message", { user: ALICE, text: "an older line from alice" }, at(15, 12, 0)),
  ] });
  // 18 October: everything a file shows, named; INC and BRI aren't hidden yet
  await bridge.ingest({ rooms: [snap(ROOM)], events: [
    ev(ROOM, "member.join", { user: ALICE }, at(18, 20, 59)),
    ev(ROOM, "member.join", { user: BRI }, at(18, 21, 0)),
    ev(ROOM, "room.update", { changes: { topic: "movie night at 9" } }, at(18, 21, 1)),
    ev(ROOM, "message", { user: PEPE, text: "welcome to the room" }, at(18, 21, 2)),
    ev(ROOM, "message", { user: ALICE, text: "hello room" }, at(18, 21, 4, 11)),
    ev(ROOM, "message", { user: PEPE, text: "🌐 Mae (web): typed on the website", web: { user: MAE, text: "typed on the website" } }, at(18, 21, 4, 30)),
    ev(ROOM, "x.pepe.transcript", { id: "tx-00000000000000b1", user: BOB, text: "said on the mic" }, at(18, 21, 5)),
    ev(ROOM, "message", { user: INC, text: "ina named words" }, at(18, 21, 6)),
    ev(ROOM, "message", { user: BRI, text: "bri secret words" }, at(18, 21, 6, 30)),
    ev(ROOM, "message", { user: BOB, text: "hey Ina Cognito and @bricf, nice <b>bold</b> & so on" }, at(18, 21, 7)),
    ev(ROOM, "message", { user: ALICE, text: "the hidden spam line" }, at(18, 21, 7, 30)),
    ev(ROOM, "mic.grab", { user: BOB }, at(18, 21, 8)),
    ev(ROOM, "mic.release", { user: BOB, held_ms: 180000 }, at(18, 21, 11)),
    ev(ROOM, "x.pepe.transcript", { id: "tx-00000000000000c1", user: INC, text: "ina mic words" }, at(18, 21, 12)),
  ] });
  // INC goes incognito, BRI types !bridge hide; Pepe sends INC's next line anonymised
  await bridge.ingest({ rooms: [snap(ROOM, [ALICE, BOB, MAE])], events: [
    pev("privacy.hidden", "inccf", "incognito", at(18, 22, 0)),
    pev("privacy.hidden", "bricf", "bridge", at(18, 22, 0, 30)),
    ev(ROOM, "message", { user: ANON(), text: "ina anonymous words", anon: { kind: "incognito", h: INC_H } }, at(18, 22, 1)),
    ev(ROOM, "x.pepe.transcript", { id: "tx-00000000000000c2", user: ANON(), text: "ina anonymous mic", source: "mic", anon: { kind: "incognito", h: INC_H } }, at(18, 22, 1, 30)),
    ev(ROOM, "member.leave", { user: ALICE }, at(18, 22, 2)),
  ] });
  // the site's own lines: 🎥 a stream went live, 📜 a settings note
  await at_(at(18, 22, 3), () => bridge.liveNotice(ROOM.id, { who: "own", pad: "Golden Room", what: "Movie night", link: "/p/golden-room" }));
  await at_(at(18, 22, 4), () => bridge.noteItem(ROOM.id, { w: "search", s: 0 }));
  // 19 October, after midnight
  await bridge.ingest({ rooms: [snap(ROOM, [ALICE, BOB, MAE])], events: [ev(ROOM, "message", { user: ALICE, text: "after midnight" }, at(19, 0, 30))] });
  // Web.Room, 16 October (after every golden line, so the golden cursors stay): a web-only member, a deleted web account, and HAP
  await rooms.setOwner(WEB.id, "own", "test");
  await CV.reconcileNow(WEB.id);
  await bridge.ingest({ rooms: [snap(WEB, [BOB, HAP])], events: [
    ev(WEB, "member.join", { user: HAP }, at(16, 12, 0)),
    ev(WEB, "message", { user: HAP, text: "happy unique words" }, at(16, 12, 1)),
    ev(WEB, "message", { user: BOB, text: "I am happy today, hey @happycf" }, at(16, 12, 2)),
    ev(WEB, "message", { user: PEPE, text: "🌐 Webby (web): a web line from a live account", web: { user: { login: "u:" + U.mem2.userId, display: "Webby" }, text: "a web line from a live account" } }, at(16, 12, 3)),
    ev(WEB, "message", { user: PEPE, text: "🌐 Gone (web): a web line from a deleted account", web: { user: { login: "u:gone-account-1", display: "Gone Webber" }, text: "a web line from a deleted account" } }, at(16, 12, 4)),
  ] });
  await bridge.ingest({ rooms: [snap(WEB, [BOB])], events: [pev("privacy.hidden", "happycf", "bridge", at(16, 13, 0))] });
  await settle();
  // a moderator hid one line
  await runQuery("UPDATE chat_log SET rm_at = ?, rm_by = 'mod:id-own', rm_why = 'spam' WHERE text = 'the hidden spam line'", [at(18, 21, 30)]);
  await CV.init();
  await require(path.join(repo, "chatlogmod")).init();
  await CV.refreshNames();
  clocks(T_NOW);
  CV._clearCaches();
})();
// (no test.after / beforeEach: Node 16's runner lacks them - the server is unref'd, each test resets what it uses)
// (the per-minute limit is lifted outside its own test: every download here happens at the same fixed minute)
const ready = async () => { await setup; X._reset(); X._setLimits({ perMin: 1000 }); X._setRoots([["/public/", PUB]]); clocks(T_NOW); await runQuery("DELETE FROM chatlog_exports"); };
const DAY_BODY = { range: "custom", from: "2026-10-18", to: "2026-10-19", sys: true };

test("golden: a member's download of 18-19 October in HTML, TXT and JSONL (incognito as 'someone', !bridge hide left out)", async () => {
  await ready();
  const out = {};
  for (const fmt of ["txt", "jsonl", "html"]) {
    const { r, f } = await download(U.mem, Object.assign({ fmt }, DAY_BODY));
    assert.equal(r.d.tz, "UTC");
    assert.equal(r.d.from, at(18, 0, 0));
    assert.equal(r.d.to, T_NOW, "a range ending in the future ends now");
    assert.equal(f.status, 200, f.text);
    assert.equal(f.headers["content-type"], X.FMTS[fmt].type);
    assert.equal(f.headers["content-disposition"], `attachment; filename="patv-golden-room-chat-20261018-20261019.${fmt}"`);
    assert.equal(f.headers["cache-control"], "private, no-store");
    assert.equal(f.headers["x-accel-buffering"], "no");
    assert.match(f.headers["x-robots-tag"], /noindex/);
    assert.match(f.headers["content-security-policy"], /default-src 'none'.*sandbox/);
    // CL10 fix-up (test gap 5): the estimate is exactly what the file holds (the old one counted every archived row: 22)
    assert.deepEqual(r.d.estimate, { lines: 17, more: false }, "the estimate is the file's 17 lines");
    out[fmt] = f.text;
  }
  golden("golden-18oct.txt", out.txt);
  golden("golden-18oct.jsonl", out.jsonl);
  golden("golden-18oct.html", normHtml(out.html));
  for (const fmt of ["txt", "jsonl", "html"]) noLeak(out[fmt], fmt);
  // what the golden files show, said here too (so a rewritten golden can't quietly drop it)
  assert.match(out.txt, /^\[21:06\] someone: ina named words$/m, "an incognito person's line said BEFORE they went incognito: 'someone'");
  assert.match(out.txt, /^\[21:12\] 🎙 someone: “ina mic words”$/m);
  assert.match(out.txt, /^\[22:01\] someone: ina anonymous words$/m, "Pepe's anonymised line: 'someone'");
  assert.match(out.txt, /^\[21:07\] Bob Birch: hey someone and @?someone, nice <b>bold<\/b> & so on$/m, "both kinds' names redacted in others' lines");
  assert.match(out.txt, /^— 17 lines · 1 left out \(removed by moderators\) · 2 left out \(privacy\) · PATV chat log v1$/m,
               "!bridge hide: the line and the join left out, counted; the hidden line counted as removed");
  const J = out.jsonl.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(J[0].format, "patv-chatlog/1");
  assert.deepEqual(J[0].left_out, { removed: 1, privacy: 2 });
  assert.equal(J[0].items, J.length - 1);
  const anon = J.filter((o) => o.author && o.author.someone);
  assert.equal(anon.length, 4, "the four incognito lines (two said under their name, two Pepe sent anonymised)");
  for (const o of anon) assert.deepEqual(o.author, { name: "someone", patv: null, camfrog: null, web: false, pepe: false, bot: false, someone: true });
  for (const o of J.slice(1)) for (const k of Object.keys(o).concat(o.author ? Object.keys(o.author) : [])) assert.ok(!/user_?id|uid|ah|hash/i.test(k), "no internal keys: " + k);
  assert.ok(!/u:id-|"id-/.test(out.jsonl), "no account ids");
  // the HTML: the incognito lines are the letter bubble "?" + "someone", never a link, a picture or a style
  const html = out.html;
  assert.equal((html.match(/<span class="who">someone<\/span>/g) || []).length, 4);
  assert.equal((html.match(/class="av anon"/g) || []).length, 4);
});

test("the HTML file: self-contained (CSP, no scripts, no requests), the pad chat's markup and stylesheet, pictures embedded once", async () => {
  await ready();
  const { f } = await download(U.mem, Object.assign({ fmt: "html" }, DAY_BODY));
  const s = f.text;
  assert.match(s, /^<!doctype html>\n<html lang="en" dir="ltr">/);
  assert.ok(s.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`));
  assert.ok(s.includes('<meta name="robots" content="noindex">'));
  assert.doesNotMatch(s, /<script|<iframe|<object|<embed|<link\b|@import|javascript:/i, "no scripts, frames or loaded resources");
  assert.doesNotMatch(s, /\son[a-z]+=/i, "no event handlers");
  assert.doesNotMatch(s, /var\(--ds-/, "every ds token written in");
  // every address in the file: the pad, profiles and the 🎥 link on publicaccess.tv, or an embedded data: picture
  const refs = [...s.matchAll(/(?:href|src)="([^"]*)"|url\("?([^")]*)"?\)/g)].map((m) => m[1] || m[2]);
  assert.ok(refs.length >= 4);
  for (const r of refs) assert.match(r, /^(https:\/\/publicaccess\.tv\/(p|u)\/[a-z0-9-]+|data:image\/png;base64,[A-Za-z0-9+/=]+)$/, "no other request: " + r);
  for (const m of s.matchAll(/<a [^>]*>/g)) assert.match(m[0], /rel="nofollow noopener"/);
  // Mae's picture: embedded ONCE (a rule of the file's stylesheet), on both her lines' .av by name - no <img>
  const mae = fs.readFileSync(path.join(PUB, "img", "mae.png")).toString("base64");
  assert.equal(s.split(mae).length - 1, 1, "embedded once");
  assert.match(s, /\.chatlog \.av\.av-1 \{ background: center \/ cover no-repeat url\("data:image\/png;base64,/);
  assert.ok(s.includes('<span class="av av-1" aria-hidden="true"></span>'));
  assert.doesNotMatch(s, /<img/);
  // the live markup and classes
  for (const c of ['class="line pepe"', 'class="line tx"', 'class="sys topic"', 'class="sys live"', 'class="sys note"', 'class="web-mark"', '<h2 class="daydiv">Sunday 18 October 2026</h2>',
                   '<h2 class="daydiv">Monday 19 October 2026</h2>', '<main class="dl-log" role="log"', '<time class="when" datetime="2026-10-18T21:04:11.000Z"']) assert.ok(s.includes(c), c);
  assert.ok(s.includes('title="bobcf"'), "an unlinked speaker's login as the tooltip (the live chat's rule)");
  assert.ok(s.includes('href="https://publicaccess.tv/u/alice"'), "a linked speaker's profile, absolute");
  assert.ok(!s.includes("data-c=") && !s.includes("data-name=") && !s.includes("data-text="), "no data-* (the live page's ✂️ hooks)");
  // the shared stylesheet: the pad chat's own rules, the print variant, the flair chip
  const css = X.fileCss();
  for (const r of [".chatlog .line {", ".chatlog .line.tx {", ".chatlog .sys.topic {", ".chatlog .av.anon {", ".chatlog .ufl {", "@media print", ".chatlog .daydiv {"]) assert.ok(css.includes(r), r);
  assert.doesNotMatch(css, /var\(--ds-/);
});

test("pictures: only from the public root, real images, <= 64 KB, never through '..' or a link out; an incognito person's never", async () => {
  await ready();
  assert.equal(X.avatarFile("/public/img/mae.png"), fs.realpathSync(path.join(PUB, "img", "mae.png")));
  for (const bad of ["/public/../secret.png", "/public/img/../../secret.png", "/uploads/x.png", "https://cdn.example/x.png", "/public//img/mae.png?x", "//evil/x.png", "/public/img/nope.png"]) {
    assert.equal(X.avatarFile(bad), null, bad);
  }
  if (symOk) assert.equal(X.avatarFile("/public/img/link.png"), null, "a symlink out of the root");
  const e = await X.embedAvatars(["/public/img/mae.png", "/public/img/mae.png", "/public/img/big.png", "/public/img/pic.svg", "/public/../secret.png"]);
  assert.deepEqual([...e.map.keys()], ["/public/img/mae.png"], "once; too big, an SVG and '..' refused");
  // the incognito person HAS a site picture - and none of their lines names them, so it is never looked up nor embedded
  const { f } = await download(U.mem, Object.assign({ fmt: "html" }, DAY_BODY));
  assert.ok(!f.text.includes(INC_B64));
  // nor bri's (left out) - bri's PATV picture is Mae's file: still embedded once, for Mae
  assert.equal(f.text.split(fs.readFileSync(path.join(PUB, "img", "mae.png")).toString("base64")).length - 1, 1);
});

test("same files in pages of 2 rows (the stream changes nothing); the per-export resolver leaves the live chat's name cache alone", async () => {
  await ready();
  const before = [...bridge._nameCache.keys()].sort();
  X._setLimits({ pageRows: 2 });
  const got = {};
  for (const fmt of ["txt", "jsonl", "html"]) got[fmt] = (await download(U.mem, Object.assign({ fmt }, DAY_BODY))).f.text;
  golden("golden-18oct.txt", got.txt);
  golden("golden-18oct.jsonl", got.jsonl);
  golden("golden-18oct.html", normHtml(got.html));
  assert.deepEqual([...bridge._nameCache.keys()].sort(), before, "no name entered or left the live cache");
});

test("TXT: one line per item whatever a name or a title holds; the header grammar; another zone's day and offset", async () => {
  await ready();
  const { f } = await download(U.mem, { range: "custom", from: "2026-10-18", to: "2026-10-18", fmt: "txt", sys: false }, SLUG, { "x-test-tz": "America/New_York" });
  const lines = f.text.split("\n");
  assert.equal(lines[0], "PATV chat log · Golden.Room · publicaccess.tv/p/golden-room", "the pad title (the registry's, as the pad page shows it)");
  assert.equal(lines[1], "Camfrog room: Golden Room");
  assert.equal(lines[2], "2026-10-18 00:00 → 2026-10-19 00:00 · America/New_York (UTC−04:00)");
  assert.match(lines[3], /^Downloaded 2026-10-19 10:02 by @mem · \d+ lines$/);
  assert.equal(lines[4], "A copy: later removals and privacy changes aren't applied to it.");
  assert.equal(lines[5], "🎙 lines are automatic transcripts and may contain mistakes.");
  assert.equal(lines[7], "── Sunday 18 October 2026 ──");
  assert.ok(lines.includes("[17:04] Alice Ash: hello room"), "times in the downloader's zone");
  assert.ok(!f.text.includes("joined") && !f.text.includes("grabbed the mic"), "presence off unless asked");
  assert.ok(lines.includes("[20:30] Alice Ash: after midnight"), "the range is the zone's own day: 00:30 UTC on the 19th is 20:30 on the 18th in New York");
  // the writer on its own: a title with a line break never forges a line
  const W = X.writer("txt", { title: "Pad\n[21:00] Forged: hi", slug: "p", room: "R\r\nx", adult: true, from: at(18, 0, 0), to: at(19, 0, 0), zone: "UTC", lang: "en",
                              generated: T_NOW, by: "me\nyou", origin: "https://publicaccess.tv" }, X.fileCtx({}));
  const head = W.head({ lines: 0, removed: 0, privacy: 0 });
  assert.equal(head.split("\n")[0], "PATV chat log · Pad [21:00] Forged: hi · publicaccess.tv/p/p · 18+");
  assert.equal(head.split("\n")[1], "Camfrog room: R x");
  assert.ok(!/\n\[21:00\]/.test(head));
});

test("who: signed out, a new unlinked account, the pad's switch (Approved pads off until the owner turns it on), the site switch", async () => {
  await ready();
  let r = await ask(null, { fmt: "txt" });
  assert.equal(r.status, 401);
  assert.equal(r.d.code, "signin");
  r = await fetchFile(null, "/p/" + SLUG + "/chatlog/dl/" + "a".repeat(32));
  assert.equal(backCode(r), "signin", "signed out: back to the pad, which says to sign in");
  r = await ask(U.newb, { fmt: "txt" });
  assert.equal(r.status, 403);
  assert.equal(r.d.code, "established", "level 1 and nothing linked");
  r = await ask(U.mem2, { fmt: "txt" });
  assert.equal(r.status, 200, "level 2+ is established without a link: " + r.text);
  r = await call("POST", `/api/rooms/${SLUG}/chatlog/export`, U.mem, { fmt: "txt" }, { "x-requested-with": "" });
  assert.equal(r.status, 403, "same-origin only");
  // an Approved pad: downloads off by default - even for its approved members - until the owner turns them on
  clocks(T_SETUP);
  await rooms.setOwner(APPR.id, "own", "test");
  await bridge.ingest({ rooms: [snap(APPR)], events: [ev(APPR, "message", { user: ALICE, text: "said on the approved pad" }, at(18, 12, 0))] });
  const PA = require(path.join(repo, "padaccess"));
  await PA.setLevel(U.own, await rooms.get(APPR.id), "approved");
  await runQuery("INSERT INTO pad_members (room_id, user_id, status, requested_at, decided_at) VALUES (?, ?, 'approved', ?, ?)", [APPR.id, U.mem.userId, T_SETUP, T_SETUP]);
  await PA.load();
  clocks(T_NOW);
  r = await ask(U.mem, { fmt: "txt", range: "7d" }, ASLUG);
  assert.equal(r.status, 403);
  assert.equal(r.d.code, "off_pad");
  assert.ok(!CV.historyBlock(await CV.view(APPR.id, null)).dl_signin, "no Sign in to download on a pad that doesn't allow them");
  r = await ask(U.mem2, { fmt: "txt", range: "7d" }, ASLUG);
  assert.equal(r.status, 404, "not a member: the pad isn't there for them");
  const L = await call("GET", `/api/rooms/${ASLUG}/live`, U.mem);
  assert.ok(L.d && L.d.history, "the live answer carries the history block"); assert.equal(L.d.history.dl, false, "no ⋯ › Download for the member");
  const o = await ask(U.own, { fmt: "txt", range: "7d" }, ASLUG);
  assert.equal(o.status, 200, "the owner always can: " + o.text);
  const s = await call("POST", `/api/rooms/${ASLUG}/chat-settings`, U.own, { downloads: true });
  assert.equal(s.status, 200, s.text);
  CV._clearCaches();
  r = await ask(U.mem, { fmt: "txt", range: "7d" }, ASLUG);
  assert.equal(r.status, 200, "allowed once the owner turns downloads on: " + r.text);
  // the site switch off: nothing answers
  await CL.setSwitch("downloads", false, "test");
  try {
    r = await ask(U.mem, { fmt: "txt" });
    assert.equal(r.status, 404);
    assert.equal(r.d.code, "off");
    const L2 = await call("GET", `/api/rooms/${SLUG}/live`, U.mem);
    assert.ok(L2.d && L2.d.history); assert.equal(L2.d.history.dl, false);
  } finally { await CL.setSwitch("downloads", true, "test"); }
  // CL10 fix-up: chatlog.history off stops downloads too (a file is an archive read beyond the live tail) - the POST, a link issued
  // before, the ⋯ menu, "Sign in to download" and the account list
  const pending = await ask(U.mem, { fmt: "txt", range: "24h" });
  assert.equal(pending.status, 200);
  await CL.setSwitch("history", false, "test");
  try {
    r = await ask(U.mem, { fmt: "txt" });
    assert.equal(r.status, 404);
    assert.equal(r.d.code, "off");
    assert.equal(backCode(await fetchFile(U.mem, pending.d.url)), "off", "a link issued while history was on");
    const L4 = await call("GET", `/api/rooms/${SLUG}/live`, U.mem);
    assert.equal(L4.d.history.dl, false, "no ⋯ › Download");
    assert.ok(!CV.historyBlock(await CV.view(ROOM.id, null)).dl_signin, "no Sign in to download");
    assert.equal((await call("GET", "/api/account/chatlog-downloads", U.mem)).d.on, false);
  } finally { await CL.setSwitch("history", true, "test"); }
  const L3 = await call("GET", `/api/rooms/${SLUG}/live`, U.mem);
  assert.ok(L3.d && L3.d.history);
  assert.equal(L3.d.history.dl, true);
  assert.equal(L3.d.history.dl_full, false, "a member's file stays inside the public window");
  const L5 = await call("GET", `/api/rooms/${SLUG}/live`, U.own);
  assert.equal(L5.d.history.dl_full, true, "the owner's reaches back");
  // signed out (a Public pad's live tail): no file, "Sign in to download" - only while the pad allows them and the switch is on
  const B0 = CV.historyBlock(await CV.view(ROOM.id, null));
  assert.equal(B0.dl, false);
  assert.equal(B0.dl_signin, true, "signed out: Sign in to download");
  await CL.setSwitch("downloads", false, "test");
  try { assert.ok(!CV.historyBlock(await CV.view(ROOM.id, null)).dl_signin, "nothing while downloads are off"); }
  finally { await CL.setSwitch("downloads", true, "test"); }
});

test("the link: single use, the same account only, 2 minutes; a bad or unknown token is one answer", async () => {
  await ready();
  let r = await ask(U.mem, { fmt: "txt", range: "24h" });
  assert.equal(r.status, 200);
  assert.match(r.d.url, /^\/p\/golden-room\/chatlog\/dl\/[0-9a-f]{32}$/);
  const tok = r.d.url.split("/").pop();
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chatlog_exports WHERE id = ?", [tok]))[0].n, 0, "the token itself is never stored");
  let f = await fetchFile(U.mem2, r.d.url);
  assert.equal(backCode(f), "gone", "another account");
  f = await fetchFile(U.mem, r.d.url);
  assert.equal(f.status, 200);
  f = await fetchFile(U.mem, r.d.url);
  assert.equal(backCode(f), "gone", "used");
  r = await ask(U.mem, { fmt: "txt", range: "24h" });
  X._setClock(() => T_NOW + 121e3);
  f = await fetchFile(U.mem, r.d.url);
  assert.equal(backCode(f), "gone", "expired");
  X._setClock(() => T_NOW);
  f = await fetchFile(U.mem, "/p/" + SLUG + "/chatlog/dl/nope");
  assert.equal(backCode(f), "gone");
  // CL10 fix-up: a made-up (well-formed) token is refused before any view is computed - one keyed read
  const realView = CV.view;
  let views = 0;
  CV.view = async (...a) => { views++; return realView(...a); };
  try { f = await fetchFile(U.mem, "/p/" + SLUG + "/chatlog/dl/" + "0".repeat(32)); } finally { CV.view = realView; }
  assert.equal(backCode(f), "gone");
  assert.equal(views, 0, "no view for a made-up token");
  // ...and link fetches are limited per account (a refused one counts)
  X._setLimits({ getPerMin: 2 });
  for (let i = 0; i < 2; i++) assert.equal(backCode(await fetchFile(U.mem2, "/p/" + SLUG + "/chatlog/dl/" + "1".repeat(32))), "gone");
  assert.equal(backCode(await fetchFile(U.mem2, "/p/" + SLUG + "/chatlog/dl/" + "1".repeat(32))), "rate");
  r = await ask(U.mem, { fmt: "exe" });
  assert.equal(r.d.code, "bad_fmt");
  r = await ask(U.mem, { fmt: "txt", range: "custom", from: "2026-10-19", to: "2026-10-18" });
  assert.equal(r.d.code, "bad_range");
});

test("limits: 2 a minute, 10 a day in the database (a restart forgets nothing); every link asked for counts, a file cut off after its header counts, one that failed before anything was sent doesn't; one stream", async () => {
  await ready();
  X._setLimits({ perMin: X.PER_MIN });
  let t = T_NOW;
  const tick = (ms) => { t += ms; X._setClock(() => t); };
  for (let i = 0; i < 2; i++) assert.equal((await ask(U.lim, { fmt: "txt", range: "24h" })).status, 200);
  let r = await ask(U.lim, { fmt: "txt", range: "24h" });
  assert.equal(r.status, 429);
  assert.equal(r.d.code, "rate");
  // CL10 fix-up (the review: 30 POSTs in 15 minutes were all accepted - a link that was never fetched stopped counting after 2
  // minutes): the two links above expire unused and STILL count (COUNT_UNUSED - each POST ran a pass over the range for its estimate)
  tick(5 * 60e3);
  for (let i = 0; i < 8; i++) {
    tick(31e3);
    const { f } = await download(U.lim, { fmt: "txt", range: "24h" });
    assert.equal(f.status, 200);
  }
  tick(31e3);
  r = await ask(U.lim, { fmt: "txt", range: "24h" });
  assert.equal(r.status, 429);
  assert.equal(r.d.code, "limit_day", "the 11th link of the day (two of them never fetched)");
  await X._boot();                                                     // a restart: the count is in the database
  r = await ask(U.lim, { fmt: "txt", range: "24h" });
  assert.equal(r.d.code, "limit_day", "still refused after a restart");
  // a file that failed before anything was sent (items NULL) doesn't count
  await runQuery("UPDATE chatlog_exports SET state = 'failed', items = NULL WHERE rowid IN (SELECT rowid FROM chatlog_exports WHERE user_id = ? AND state = 'done' LIMIT 2)", [U.lim.userId]);
  tick(31e3);
  assert.equal((await ask(U.lim, { fmt: "txt", range: "24h" })).status, 200, "two failed before anything was sent: room for one more");
  // ...nor one the downloader cut off before its header (items NULL); one cut off after it (items 0: the header's counts reached them) does
  await runQuery("UPDATE chatlog_exports SET state = 'aborted', items = NULL WHERE rowid = (SELECT MAX(rowid) FROM chatlog_exports WHERE user_id = ? AND state = 'issued')", [U.lim.userId]);
  tick(31e3);
  assert.equal((await ask(U.lim, { fmt: "txt", range: "24h" })).status, 200, "cut off before the header: not counted");
  await runQuery("UPDATE chatlog_exports SET state = 'aborted', items = 0 WHERE rowid = (SELECT MAX(rowid) FROM chatlog_exports WHERE user_id = ? AND state = 'issued')", [U.lim.userId]);
  tick(31e3);
  assert.equal((await ask(U.lim, { fmt: "txt", range: "24h" })).status, 200);
  tick(31e3);
  r = await ask(U.lim, { fmt: "txt", range: "24h" });
  assert.equal(r.d.code, "limit_day", "cut off after its header (no line yet): counted");
  // the rule itself
  const c = (state, items, created = t) => X.counts({ state, items, created }, t);
  assert.ok(c("issued", null, t - 10 * 60e3), "an unused, expired link (COUNT_UNUSED)");
  assert.ok(c("done", 5) && c("streaming", null));
  assert.ok(!c("failed", null) && !c("aborted", null), "nothing reached them");
  assert.ok(c("failed", 0) && c("aborted", 0) && c("aborted", 12), "the header did (COUNT_CUT)");
  // one stream per account, three across the site; `streaming` rows become `failed` at boot (a deploy mid-download)
  await runQuery("DELETE FROM chatlog_exports");
  await runQuery("INSERT INTO chatlog_exports (id, user_id, rk, fmt, sys, role, state, created) VALUES ('s1', ?, 1, 'txt', 0, 'member', 'streaming', ?)", [U.mem.userId, t]);
  r = await ask(U.mem, { fmt: "txt", range: "24h" });
  assert.equal(r.status, 429);
  assert.equal(r.d.code, "busy_me", "your other download");
  await runQuery("INSERT INTO chatlog_exports (id, user_id, rk, fmt, sys, role, state, created) VALUES ('s2', 'x2', 1, 'txt', 0, 'member', 'streaming', ?), ('s3', 'x3', 1, 'txt', 0, 'member', 'streaming', ?)", [t, t]);
  r = await ask(U.mem2, { fmt: "txt", range: "24h" });
  assert.equal(r.d.code, "busy", "three streaming across the site");
  await X._boot();
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chatlog_exports WHERE state = 'streaming'"))[0].n, 0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chatlog_exports WHERE state = 'failed'"))[0].n, 3);
  r = await ask(U.mem, { fmt: "txt", range: "24h" });
  assert.equal(r.status, 200, "free again");
});

test("cuts: 31 days per file and N lines per file - the footer (and the JSONL header) say where the next file starts", async () => {
  await ready();
  const rg = X.rangeOf({ range: "custom", from: "2026-08-01", to: "2026-10-19" }, "UTC", T_NOW);
  assert.equal(rg.to - rg.from, 31 * D);
  assert.deepEqual(rg.cut, { days: 31, next: rg.to });
  let r = await ask(U.own, { fmt: "txt", range: "custom", from: "2026-09-01", to: "2026-10-19" });
  assert.equal(r.status, 200);
  assert.ok(r.d.cut && r.d.cut.days === 31);
  // CL10 fix-up: the cut, the zone and the language live with the row - a restart between the POST and the GET keeps them
  const row = (await getQuery("SELECT tz, lang, cut_next FROM chatlog_exports WHERE user_id = ? AND state = 'issued'", [U.own.userId]))[0];
  assert.deepEqual([row.tz, row.lang, Number(row.cut_next)], ["UTC", "en", r.d.cut.next]);
  await X._boot();
  let f = await fetchFile(U.own, r.d.url);
  assert.match(f.text, /^— Cut at 31 days — the next file starts at 2026-10-02 00:00\.$/m);
  X._setLimits({ linesMax: 3 });
  const { f: t } = await download(U.mem, Object.assign({ fmt: "txt" }, DAY_BODY));
  const body = t.text.split("\n").filter((l) => /^\[\d\d:\d\d\]/.test(l));
  assert.deepEqual(body, ["[20:59] → Alice Ash joined", "[21:01] 📌 topic: movie night at 9", "[21:02] Pepe: welcome to the room"]);
  // what was left out BEFORE the cut is counted (the hidden person's join at 21:00), nothing after it
  assert.match(t.text, /^— 3 lines · 1 left out \(privacy\) · PATV chat log v1$/m);
  assert.match(t.text, /^— Cut at 3 lines — the next file starts at 2026-10-18 21:04\.$/m);
  assert.match(t.text.split("\n")[3], / · 3 lines$/);
  const { f: j } = await download(U.mem, Object.assign({ fmt: "jsonl" }, DAY_BODY));
  const head = JSON.parse(j.text.split("\n")[0]);
  assert.equal(head.truncated, true);
  assert.equal(head.items, 3);
  assert.deepEqual(head.left_out, { removed: 0, privacy: 1 });
  assert.equal(head.continue_from, "2026-10-18T21:04:11+00:00");
  assert.equal(j.text.trim().split("\n").length, 4);
  // CL10 fix-up: a cut inside a day is continued with a date AND a time (the dialog's Custom; whole minutes - from 21:04, so the
  // next file starts with the line the last one stopped before, and a line or two of that minute may be in both)
  const { r: nr, f: n } = await download(U.mem, { range: "custom", from: "2026-10-18T21:04", to: "2026-10-19", fmt: "txt", sys: true });
  assert.equal(nr.d.from, at(18, 21, 4));
  assert.deepEqual(n.text.split("\n").filter((l) => /^\[\d\d:\d\d\]/.test(l)).slice(0, 2), ["[21:04] Alice Ash: hello room", "[21:04] Mae Moss 🌐: typed on the website"]);
  // a To with a time ends at that minute; times are checked
  r = await ask(U.mem, { range: "custom", from: "2026-10-18T21:00", to: "2026-10-18T21:05", fmt: "txt" });
  assert.deepEqual([r.d.from, r.d.to], [at(18, 21, 0), at(18, 21, 5)]);
  for (const bad of ["2026-10-18T24:00", "2026-10-18T21:60", "2026-13-01T10:00"]) assert.equal((await ask(U.mem, { range: "custom", from: bad, to: "2026-10-19", fmt: "txt" })).d.code, "bad_range", bad);
});

test("presence: off unless asked; for a member only the last 24 hours, for the owner further back", async () => {
  await ready();
  const week = { range: "custom", from: "2026-10-15", to: "2026-10-19", fmt: "txt" };
  const m = (await download(U.mem, Object.assign({ sys: true }, week))).f.text;
  assert.ok(m.includes("→ Alice Ash joined") && !m.includes("[11:59] → Alice Ash joined"), "a member: the 18th's join, not the 15th's");
  assert.ok(m.includes("an older line from alice"), "chat lines of the 15th are in a member's view (window: everything)");
  const o = (await download(U.own, Object.assign({ sys: true }, week))).f.text;
  assert.ok(o.includes("[11:59] → Alice Ash joined"), "the owner: older presence too");
  const n = (await download(U.own, Object.assign({ sys: false }, week))).f.text;
  assert.ok(!n.includes("joined"));
  // CL10 fix-up - the review's probes: (1) a 1-minute range holding only a join older than 24 hours - a member's estimate said 1 (it
  // counted archived rows), now it and the file both say 0; the owner's both say 1
  const probe = { range: "custom", from: "2026-10-15T11:59:00Z", to: "2026-10-15T12:00:00Z", fmt: "txt", sys: true };
  let p = await download(U.mem, probe);
  assert.deepEqual(p.r.d.estimate, { lines: 0, more: false });
  assert.match(p.f.text, /^— 0 lines · PATV chat log v1$/m, "nothing left out either");
  p = await download(U.own, probe);
  assert.deepEqual(p.r.d.estimate, { lines: 1, more: false });
  assert.match(p.f.text, /^\[11:59\] → Alice Ash joined$/m);
  // (2) a range to the second is whole minutes, and the estimate counts what the file shows - moving `to` across the !bridge hide
  // person's line (21:06:30) moves nothing
  const a = await ask(U.mem, { range: "custom", from: "2026-10-18T21:06:00Z", to: "2026-10-18T21:06:29Z", fmt: "txt" });
  const b = await ask(U.mem, { range: "custom", from: "2026-10-18T21:06:00Z", to: "2026-10-18T21:06:31Z", fmt: "txt" });
  assert.deepEqual([a.d.from, a.d.to], [at(18, 21, 6), at(18, 21, 7)]);
  assert.deepEqual([b.d.from, b.d.to], [a.d.from, a.d.to]);
  assert.deepEqual(a.d.estimate, { lines: 1, more: false }, "the incognito person's line ('someone') - never the left-out one");
  assert.deepEqual(b.d.estimate, a.d.estimate);
  // (3) the 24 h presets start on a whole minute too
  const d = await ask(U.mem, { range: "24h", fmt: "txt" });
  assert.equal(d.d.from % 60e3, 0);
  assert.equal(d.d.to, T_NOW);
});

test("a Camfrog mod's file takes the PUBLIC floors (a demoted mod keeps the file); the owner's and staff's their full view", () => {
  const V = { role: "mod", inside: true, now: T_NOW, aud_m: 0, pub: { chat: T_NOW - D, tx: T_NOW - D, presence: T_NOW - D }, floor: { chat: T_NOW - 8 * D, tx: T_NOW - 8 * D, presence: T_NOW - 8 * D } };
  assert.deepEqual(X.floorsOf(V), { chat: T_NOW - D, tx: T_NOW - D, presence: T_NOW - D, full: false });
  assert.equal(X.floorsOf(Object.assign({}, V, { inside: false, aud_m: T_NOW - 3600e3 })).chat, T_NOW - 3600e3, "outside an Approved era: from aud_m");
  assert.equal(X.floorsOf(Object.assign({}, V, { pub: { chat: T_NOW - 30 * D, tx: T_NOW - 30 * D } })).presence, T_NOW - D, "presence: 24 h");
  const O = Object.assign({}, V, { role: "owner" });
  assert.deepEqual(X.floorsOf(O), { chat: T_NOW - 8 * D, tx: T_NOW - 8 * D, presence: T_NOW - 8 * D, full: true });
});

test("Settings › Account lists your own downloads (metadata only); the admin card lists everyone's - never a token or content", async () => {
  await ready();
  await download(U.mem, Object.assign({ fmt: "txt" }, DAY_BODY));
  await ask(U.mem2, { fmt: "html", range: "24h" });                    // issued, never fetched: not listed
  let r = await call("GET", "/api/account/chatlog-downloads", U.mem);
  assert.equal(r.status, 200);
  assert.equal(r.d.on, true);
  assert.equal(r.d.downloads.length, 1);
  const x = r.d.downloads[0];
  assert.deepEqual(Object.keys(x).sort(), ["bytes", "created", "fmt", "from", "items", "pad", "state", "sys", "to"]);
  assert.equal(x.state, "done");
  assert.equal(x.items, 17);
  assert.deepEqual(x.pad, { title: "Golden.Room", slug: SLUG });
  assert.equal((await call("GET", "/api/account/chatlog-downloads", U.mem2)).d.downloads.length, 0);
  assert.equal((await call("GET", "/api/account/chatlog-downloads", null)).status, 401);
  const A = await X.adminRows();
  assert.equal(A.rows.length, 1);
  assert.equal(A.rows[0].who, "mem");
  assert.equal(A.rows[0].role, "member");
  assert.ok(!JSON.stringify(A).includes("id-mem"), "no account ids");
  const view = await CL.adminView();
  assert.ok(view.downloads && view.downloads.rows.length === 1, "on /admin/bridge's chat archive card");
});

test("staff: presence below its own 24 h public floor is audited (the chat around it isn't below its floor); the audit is written BEFORE the file - one that can't be written fails it", async () => {
  await ready();
  await runQuery("DELETE FROM chatlog_views");
  const day = { range: "custom", from: "2026-10-15", to: "2026-10-15", fmt: "txt", sys: true };
  try {
    const st = (await download(U.staff, day)).f.text;
    assert.ok(st.includes("[11:59] → Alice Ash joined") && st.includes("[12:00] Alice Ash: an older line from alice"));
    await settle();
    const v = await getQuery("SELECT from_ts, to_ts FROM chatlog_views WHERE kind = 'download' AND user_id = ?", [U.staff.userId]);
    assert.equal(v.length, 1, "audited (test gap 2: the chat / 🎙 floor alone would audit nothing here)");
    assert.deepEqual([Number(v[0].from_ts), Number(v[0].to_ts)], [at(15, 11, 59), at(15, 11, 59)], "just the join");
    // the audit row can't be written: no file - back to the pad, nothing of the chat, not counted (it would come after, were the
    // audit written at the end)
    await runQuery("DELETE FROM chatlog_views");
    CV._clearCaches();
    const real = CV.auditRead;
    CV.auditRead = async (...a) => { if (a[5] && a[5].strict) throw Object.assign(new Error("audit"), { code: "audit" }); return real(...a); };
    let f;
    try { f = await fetchFile(U.staff, (await ask(U.staff, day)).d.url); } finally { CV.auditRead = real; }
    assert.equal(backCode(f), "failed");
    assert.ok(!f.text.includes("Alice"));
    const row = (await getQuery("SELECT state, items FROM chatlog_exports WHERE user_id = ? ORDER BY created DESC, rowid DESC LIMIT 1", [U.staff.userId]))[0];
    assert.deepEqual([row.state, row.items], ["failed", null]);
  } finally { await runQuery("DELETE FROM chatlog_views"); CV._clearCaches(); }
});

test("staff: a file reaching below the public floor is audited like a read; the owner's isn't", async () => {
  await ready();
  // a 24 h window from now on (narrower: at once) - the 15th's line is below the public floor now
  const s = await call("POST", `/api/rooms/${SLUG}/chat-settings`, U.own, { window_s: 86400 });
  assert.equal(s.status, 200, s.text);
  CV._clearCaches();
  const week = { range: "custom", from: "2026-10-15", to: "2026-10-19", fmt: "txt", sys: false };
  const m = (await download(U.mem, week)).f.text;
  assert.ok(!m.includes("an older line from alice"), "a member: only inside the window (the 15th is days back)");
  assert.ok(m.includes("hello room") && m.includes("after midnight"), "the last 24 hours");
  assert.match(m, /^Your view of this pad starts later than this range, so its earliest lines aren't in this file\.$/m, "said - never when");
  const o = (await download(U.own, week)).f.text;
  assert.ok(o.includes("an older line from alice") && o.includes("hello room"), "the owner reads past the window");
  assert.ok(!o.includes("the hidden spam line") && !/Hidden by/.test(o), "a taken-down line is in no file - the owner's 30-day appeal copy stays on the site");
  assert.match(o, / · 1 left out \(removed by moderators\)/);
  noLeak(o, "the owner's file");
  assert.ok(!/starts later than this range/.test(o));
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chatlog_views WHERE kind = 'download'"))[0].n, 0);
  const st = (await download(U.staff, week)).f.text;
  assert.ok(st.includes("an older line from alice"));
  await settle();
  const v = await getQuery("SELECT user_id, kind, from_ts, to_ts FROM chatlog_views WHERE kind = 'download'");
  assert.equal(v.length, 1, "one audit row");
  assert.equal(v[0].user_id, U.staff.userId);
  assert.equal(Number(v[0].from_ts), at(15, 12, 0));
});

test("a name lookup that fails fails the FILE (never a line under a name the projection couldn't check); the link isn't spent on it", async () => {
  await ready();
  const UL = require(path.join(repo, "userlinks"));
  const orig = UL.lookup;
  UL.lookup = async () => { throw new Error("database is locked"); };
  let r, f;
  try {
    r = await ask(U.mem, Object.assign({ fmt: "txt" }, DAY_BODY));
    assert.equal(r.status, 200);
    f = await fetchFile(U.mem, r.d.url);
  } finally { UL.lookup = orig; }
  assert.equal(backCode(f), "failed", "back to the pad: 'Couldn't make the file'");
  assert.ok(!f.headers["content-disposition"], "never an attachment");
  assert.ok(!f.text.includes("hello room") && !f.text.includes("Bob Birch"), "nothing of the chat");
  const row = (await getQuery("SELECT state, items FROM chatlog_exports WHERE user_id = ?", [U.mem.userId]))[0];
  assert.equal(row.state, "failed");
  assert.equal(row.items, null, "nothing was sent - it doesn't count toward the day");
});


test("who, through the export routes (test gap 1): an 18+ pad without the age confirmation, a whole-bridge block, a feed ban, the 💎 gate (the owner and staff keep it) - the POST and a link asked for before", async () => {
  await ready();
  // 18+: only an age-confirmed member; a link asked for before the pad became 18+ is refused too
  const early = await ask(U.mem, { fmt: "txt", range: "24h" });
  assert.equal(early.status, 200);
  await runQuery("UPDATE rooms_registry SET adult = 1 WHERE room_id = ?", [ROOM.id]);
  await rooms.loadCache();
  CV._setAttested((uid) => uid === U.mem2.userId);
  CV._clearCaches();
  try {
    let r = await ask(U.mem, { fmt: "txt", range: "24h" });
    assert.equal(r.status, 403);
    assert.equal(r.d.code, "no_history");
    assert.equal(backCode(await fetchFile(U.mem, early.d.url)), "no_history");
    const { f } = await download(U.mem2, { fmt: "txt", range: "24h" });
    assert.match(f.text.split("\n")[0], / · 18\+$/, "the file says 18+");
  } finally {
    await runQuery("UPDATE rooms_registry SET adult = 0 WHERE room_id = ?", [ROOM.id]);
    await rooms.loadCache();
    CV._setAttested(null);
    CV._clearCaches();
  }
  // a whole-bridge block
  await require(path.join(repo, "bridgeblocks")).init();
  await runQuery("INSERT INTO bridge_blocks (room_id, user_id, feature, username, reason, created, until, updated) VALUES (?, ?, 'all', 'mem2', '', ?, NULL, ?)",
                 [ROOM.id, U.mem2.userId, Date.now(), Date.now()]).catch(async () => {
    await runQuery("INSERT INTO bridge_blocks (room_id, user_id, feature, username, reason, created, until) VALUES (?, ?, 'all', 'mem2', '', ?, NULL)", [ROOM.id, U.mem2.userId, Date.now()]);
  });
  CV._clearCaches();
  try {
    const r = await ask(U.mem2, { fmt: "txt", range: "24h" });
    assert.equal(r.status, 403, "blocked from the whole bridge");
    assert.equal(r.d.code, "no_history");
  } finally { await runQuery("DELETE FROM bridge_blocks WHERE user_id = ?", [U.mem2.userId]); CV._clearCaches(); }
  // a ban from the pad's feed
  await runQuery("CREATE TABLE IF NOT EXISTS feed_bans (user_id TEXT, room_id TEXT, username TEXT, reason TEXT, by TEXT, at INTEGER, until INTEGER)");
  await runQuery("INSERT INTO feed_bans (user_id, room_id, at, until) VALUES (?, ?, ?, NULL)", [U.mem2.userId, ROOM.id, Date.now()]);
  CV._clearCaches();
  try {
    const r = await ask(U.mem2, { fmt: "txt", range: "24h" });
    assert.equal(r.status, 403, "banned from the pad's feed");
    assert.equal(r.d.code, "no_history");
  } finally { await runQuery("DELETE FROM feed_bans WHERE user_id = ?", [U.mem2.userId]); CV._clearCaches(); }
  assert.equal((await ask(U.mem2, { fmt: "txt", range: "24h" })).status, 200, "unblocked: allowed again");
  // the 💎 gate (decision 24): members lose downloads with history; the owner and staff keep them
  const P = require(path.join(repo, "premium"));
  const real = P.bridgeAllowed;
  P.bridgeAllowed = (id) => (String(id) === ROOM.id ? false : real(id));
  CV._clearCaches();
  try {
    const r = await ask(U.mem, { fmt: "txt", range: "24h" });
    assert.equal(r.status, 403);
    assert.equal(r.d.code, "no_history");
    assert.equal((await download(U.own, { fmt: "txt", range: "24h" })).f.status, 200, "the owner");
    assert.equal((await download(U.staff, { fmt: "txt", range: "24h" })).f.status, 200, "staff");
  } finally { P.bridgeAllowed = real; CV._clearCaches(); }
});

test("a web-only speaker (resolved by account id), a deleted web account ('former member'), a !bridge hide person with a common-word name (the stop-list): every format, a member and the owner (test gaps 3 and 4)", async () => {
  await ready();
  const day = { range: "custom", from: "2026-10-16", to: "2026-10-16", sys: true };
  for (const who of [U.mem, U.own]) {
    const out = {};
    for (const fmt of ["txt", "jsonl", "html"]) {
      const { f } = await download(who, Object.assign({ fmt }, day), WSLUG);
      assert.equal(f.status, 200, f.text.slice(0, 200));
      out[fmt] = f.text;
      // the golden leak rule for HAP: login, hash, words - and no line, link, title or JSONL author is theirs
      for (const leak of ["happycf", HAP_H, "happy unique words", "Gone Webber", "u:id-", "id-mem2"]) {
        const i = f.text.indexOf(leak);
        assert.ok(i < 0, `${leak} leaked (${who.username}, ${fmt}): ...${f.text.slice(Math.max(0, i - 80), i + 30)}...`);
      }
    }
    const J = out.jsonl.trim().split("\n").map((l) => JSON.parse(l));
    const web = J.find((o) => o.text === "a web line from a live account");
    assert.ok(web, "the web-only line is in the file");
    assert.equal(web.author.patv, "mem2", "resolved by its account id (namesInto: UL.resolve({ids}))");
    assert.equal(web.author.web, true);
    assert.equal(web.author.camfrog, null, "never a u:<id> key");
    const gone = J.find((o) => o.text === "a web line from a deleted account");
    assert.deepEqual(gone.author, { name: "former member", patv: null, camfrog: null, web: false, pepe: false, bot: false, someone: false });
    assert.ok(out.txt.includes("former member: a web line from a deleted account"));
    assert.ok(!J.some((o) => o.author && /happy/i.test(String(o.author.name))), "no line is theirs");
    const bob = J.find((o) => o.text && o.text.startsWith("I am happy today"));
    assert.ok(bob, "the stop-listed common word stays in other people's lines");
    assert.ok(/@?someone$/.test(bob.text), "...their login doesn't: " + bob.text);
    assert.ok(!/(title|alt|href)="[^"]*happy/i.test(out.html) && !/>happy</i.test(out.html), "nothing names them in an attribute or a name");
    // left out for privacy: their line - and their join for the owner (a member's presence is only the last 24 h: not even counted)
    assert.deepEqual(J[0].left_out, { removed: 0, privacy: who === U.own ? 2 : 1 });
  }
});

test("one privacy state per file: someone going incognito while it is counted makes pass 1 again - their line 'someone', their picture not embedded (not even as an unused rule), the header's count the footer's", async () => {
  await ready();
  X._setLimits({ pageRows: 2 });
  const r = await ask(U.mem, Object.assign({ fmt: "html" }, DAY_BODY));
  let pages = 0, fired = false;
  const undo = onReads(async (sql) => {
    if (!PAGE_SQL.test(sql)) return;
    // mid pass 1, AFTER Mae's line (21:04:30, the third page of 2 rows) was counted by name and her picture collected
    if (++pages === 6 && !fired) { fired = true; await CL.hideNow(["maecf"], "pepe", "incognito"); }
  });
  let f;
  try { f = await fetchFile(U.mem, r.d.url); } finally { undo(); }
  try {
    assert.ok(fired);
    assert.equal(f.status, 200);
    const s = f.text;
    const mae = fs.readFileSync(path.join(PUB, "img", "mae.png")).toString("base64");
    assert.ok(!s.includes(mae) && !/\.av-1 \{/.test(s), "Mae's picture isn't in the file's stylesheet");
    assert.ok(!s.includes("Mae Moss") && !s.includes("maecf") && !s.includes('href="https://publicaccess.tv/u/mae"'));
    assert.equal((s.match(/<span class="who">someone<\/span>/g) || []).length, 5, "the incognito four, and Mae's line");
    const head = /Downloaded [^<]* · (\d+) lines/.exec(s), foot = /<footer class="dl-foot"><p>(\d+) lines/.exec(s);
    assert.ok(head && foot, "the header's and the footer's counts");
    assert.equal(head[1], foot[1]);
    assert.equal(Number(head[1]), 17);
  } finally { await shown("maecf", "incognito"); }
  assert.equal(CL.hiddenKind(CL.hash("maecf")), null, "Mae is shown again");
});

test("one privacy state per file: a change after the header was sent fails the file - the connection is cut, nothing is written after it, and it counts", async () => {
  await ready();
  X._setLimits({ pageRows: 2 });
  // how many pages one pass reads (the GET reads them twice)
  let pages = 0;
  const dry = await ask(U.mem, Object.assign({ fmt: "txt" }, DAY_BODY));
  let undo = onReads(async (sql) => { if (PAGE_SQL.test(sql)) pages++; });
  try { assert.equal((await fetchFile(U.mem, dry.d.url)).status, 200); } finally { undo(); }
  const n = pages / 2;
  assert.ok(Number.isInteger(n) && n >= 4, "pages per pass: " + n);
  // now a takedown in this room (the same version as a hidden-set change) while pass 2 reads its second page
  pages = 0;
  const r = await ask(U.mem, Object.assign({ fmt: "txt" }, DAY_BODY));
  undo = onReads(async (sql) => { if (PAGE_SQL.test(sql) && ++pages === n + 2) CV.noteGone(ROOM.id); });
  let f;
  try { f = await fetchRaw(U.mem, r.d.url); } finally { undo(); }
  assert.equal(f.status, 200);
  assert.ok(f.cut, "the connection was cut - the browser marks the download failed");
  assert.match(f.text, /^\[20:59\] → Alice Ash joined$/m, "the page written before the change");
  assert.ok(!f.text.includes("after midnight") && !/PATV chat log v1$/m.test(f.text), "nothing after it, no footer");
  await settle();
  const row = (await getQuery("SELECT state, items FROM chatlog_exports WHERE id = ?", [X.idOf(r.d.url.split("/").pop())]))[0];
  assert.equal(row.state, "failed");
  assert.ok(row.items != null, "the header reached them: it counts toward the day");
});

test("a deadline: a download running past STREAM_MAX_MS is cut (failed, its slot free, counted once its header went out); a socket that takes nothing for DRAIN_MAX_MS stalls the file", async () => {
  await ready();
  assert.equal(X.STREAM_MAX_MS, 10 * 60e3);
  assert.equal(X.DRAIN_MAX_MS, 30e3);
  X._setLimits({ pageRows: 2 });
  const r = await ask(U.mem, Object.assign({ fmt: "txt" }, DAY_BODY));
  let late = false;
  const undo = onReads(async (sql) => { if (PAGE_SQL.test(sql)) await settle(5); });
  let f;
  try {
    f = await fetchRaw(U.mem, r.d.url, () => { if (!late) { late = true; X._setClock(() => T_NOW + X.STREAM_MAX_MS + 1000); } });
  } finally { undo(); X._setClock(() => T_NOW); }
  assert.ok(late, "the header arrived");
  assert.ok(f.cut, "cut");
  assert.ok(!/PATV chat log v1$/m.test(f.text), "no footer");
  await settle();
  const row = (await getQuery("SELECT state, items FROM chatlog_exports WHERE id = ?", [X.idOf(r.d.url.split("/").pop())]))[0];
  assert.equal(row.state, "failed");
  assert.ok(row.items != null, "counted: the header went out");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chatlog_exports WHERE state = 'streaming'"))[0].n, 0, "the slot is free");
  // sink(): a socket that takes nothing for drainMs -> onStall, and nothing more is written
  const EE = require("events");
  const dead = new EE();
  dead.write = () => false;
  let stalls = 0, gone = false;
  const w = X.sink(dead, { drainMs: 30, onStall: () => { stalls++; gone = true; }, gone: () => gone });
  await w("abc");
  assert.equal(stalls, 1);
  await w("def");
  assert.equal(w.bytes(), 3, "nothing after the stall");
  // ...one that drains in time doesn't stall
  const slow = new EE();
  slow.write = () => false;
  let s2 = 0;
  const w2 = X.sink(slow, { drainMs: 1000, onStall: () => { s2++; }, gone: () => false });
  const p = w2("x");
  setTimeout(() => slow.emit("drain"), 10);
  await p;
  assert.equal(s2, 0);
  assert.equal(slow.listenerCount("drain") + slow.listenerCount("close"), 0, "its listeners are gone");
});

test("Node 16 and old browsers: chatlogexport.js has no Node 20-only API; pad-download.js is plain ES5", () => {
  const src = fs.readFileSync(path.join(repo, "chatlogexport.js"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  for (const re of [/\.findLast(Index)?\(/, /\.toSorted\(/, /\.toReversed\(/, /\bstructuredClone\(/, /\bzlib\.crc32\b/, /\bObject\.hasOwn\(/, /\.at\(-?\d/, /(^|[^.\w])fetch\(/m]) {
    assert.doesNotMatch(src, re, re);
  }
  for (const re of [/\biif\s*\(/i, /\bunixepoch\s*\(/i, /\bRETURNING\b/, /->>/]) assert.doesNotMatch(src, re, re);
  const ui = fs.readFileSync(path.join(repo, "public", "js", "pad-download.js"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(ui, /=>|\b(let|const|class)\s|`|\.\.\.[a-z]/i, "ES5");
  new Function(ui);                                                       // parses
  // every string the dialog shows is in en.json with the same English default
  const EN = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  for (const m of ui.matchAll(/_t\('([^']+)',\s*'((?:[^'\\]|\\.)*)'/g)) assert.equal(EN[m[1]], m[2].replace(/\\'/g, "'"), m[1]);
});
