// wave 2 WP-2 (incognito / mic-stage spec I.3; A.6 "Downloads", "Public game boards, room analytics", "Homepage room panel"; B.3;
// D.4; E.1 refusals; E.4; J-9): the leak tests track A left open (A-tests-ux-08 "partly done" and the I.3 done-when items it marked
// not met) - each through the REAL routes, the privacy wire v2 ON, veiled people in the room (frankie incognito, his own PATV account
// linked; hank !bridge hide = "hidden", known to the site ONLY through the wire - no account, no named line ever):
//   * downloads (TXT, JSONL, HTML): frog names, "[hidden]" / {masked, mask}, no login, hash, display name or hidden word - a member,
//     staff, the pad's owner and an admin (before any Reveal: the SAME lines), the incognito speaker's own account (no self view in a
//     file); signed out: no file (401 / back to the pad)
//   * /p/<slug>/analytics with veiled people - Pepe's anonymous board rows AND his room notes naming the hidden person (Pepe's notes
//     scrubber covers incognito people only): no identity for anyone, signed out on a Public pad included
//   * a signed-out visitor of a Public pad: the pad page, /live, the history JSON (401), search (401) - no identity
//   * B.3: history pages and downloads keep CURSOR order (only the live tail anchors a 🎙 line after its hold's drop - the gap is
//     noted, not asserted); what they show of an anchored line leaks nothing and carries what a page needs to anchor it (hold, at)
//   * FTS: the index itself (MATCH) holds no veiled login, display-name word or hidden word; a line with an astral emoji right
//     before a name Pepe redacted keeps "someone" whole (camfrog-bot's contract replays Pepe's REAL redactor: privwire-contract)
//   * the spec's cam form (A.3: a v2 cam.open / cam.close WITH a real UserRef + priv - Pepe keeps today's form, see
//     tools/gen_privwire_contract.py "cams") and a veiled snapshot entry claiming on_cam: nothing stored, never a cam icon
//   * the homepage / embeds Reveal refusal on its own: the homepage panel never carries a reveal flag (admin, owner) and draws no
//     Reveal; a cross-site call (an embed or a page elsewhere, a link) to the reveal / toggle endpoints is refused and logs nothing
//   node --test test/veil-leaks.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "veil-leaks-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
delete process.env.PUBLIC_BASE_URL;
delete process.env.SITE_URL;
process.env.SECRET_KEY = "test-secret";
process.env.ALIAS_SECRET = "ef".repeat(32);
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
const PW = require(path.join(repo, "privwire"));
const X = require(path.join(repo, "chatlogexport"));

const D = 864e5;
const hash = (login) => crypto.createHash("sha256").update("pepe-hidden:" + String(login).trim().toLowerCase()).digest("hex").slice(0, 20);
const ROOM = { id: "Leak.Room", name: "Leak Room" }, SLUG = "leak-room";
const ALIAS_RE = /^(?:[A-Z][A-Za-z-]{1,15} [A-Z][A-Za-z]{1,15}|Mystery Frog \d{1,4})$/;
const users = new Map();
const U = {};
let base, server, seq = 0;
const real = (login, display, extra = {}) => Object.assign({ id: login.toLowerCase(), login, display: display || login }, extra);
const ALICE = real("alicecf", "Alice");
const FR = "frankiefettuccine", HK = "hankhidden";
const priv = (kind, login, extra = {}) => Object.assign({ kind, h: hash(login), at: Date.now() / 1000 }, extra);
// the hidden words: tokens nothing else in the room says (so an index hit can only be a leak)
const WORDS = ["zanzibarquokka secret sentence", "only hank knows xylophonic", "marmaladewhale on the mic"];
const TOKENS = ["zanzibarquokka", "xylophonic", "marmaladewhale", FR, HK, "Frankie", "Fett", "Hank", "Hide"];
// what never reaches a page or a file: the veiled people, their hashes, the hidden words, the wire's / side tables' fields
const NEEDLES = [FR, "Frankie Fett", HK, "Hank Hide", ...WORDS, hash(FR), hash(HK), "\"_vz\"", "\"vz\"", "\"vw\"", "\"priv\"", "\"ah\"", "\"ahs\""];
const leaks = (s) => NEEDLES.filter((x) => String(s).toLowerCase().includes(x.toLowerCase()));
// Pepe on v2: every batch carries his kinded hidden-set lists (frankie incognito, hank !bridge hide)
const KINDED = () => ({ bridge_hidden_h: [hash(HK)], incog_hidden_h: [hash(FR)] });
const ev = (type, data, ts = Date.now()) => ({ op: "event", id: "vl-" + (++seq), ts: new Date(ts).toISOString(), type, scope: { platform: "camfrog", room: ROOM }, data });
const sync = (events, extra = {}) => bridge.ingest(Object.assign({ events, rooms: [] }, KINDED(), extra), { v2: true });
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

function call(method, url, { user = null, body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const data = body == null ? null : JSON.stringify(body);
    const h = Object.assign({ "x-requested-with": "fetch", origin: base, host: u.host }, user ? { "x-test-user": user.userId } : {},
                            data != null ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}, headers);
    for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: h }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => { const s = Buffer.concat(parts).toString("utf8"); let d = null; try { d = JSON.parse(s); } catch (e) { d = null; } resolve({ status: res.statusCode, d, text: s, headers: res.headers }); });
    });
    req.on("error", reject);
    if (data != null) req.write(data);
    req.end();
  });
}
async function mkUser(name, cls = "pleb", camfrog = null) {
  const uid = "id-" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at)
                  VALUES (?, ?, ?, 'x', ?, 100000, ?, 5, '2026-01-01 00:00:00')`, [uid, name, name, cls, camfrog]);
  const u = { userId: uid, username: name, class: cls };
  users.set(uid, u);
  return u;
}
const live = (user) => call("GET", `/api/rooms/${SLUG}/live`, { user });
const rmInit = (html) => { const m = /<script id="rmInit" type="application\/json">([\s\S]*?)<\/script>/.exec(html); return m ? JSON.parse(m[1].replace(/\\u003c/g, "<")) : null; };

const H1 = "hd-0000c0ffee01", H2 = "hd-0000c0ffee02";
const T = {};                                   // the fixture's times (ms)
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
  U.staff = await mkUser("helper", "Staff");
  U.adm = await mkUser("adm", "Admin", "admcf");
  U.frankie = await mkUser("frankie", "pleb", FR);          // the incognito speaker's own account (hank has none)
  await rooms.init();
  await require(path.join(repo, "feedstore")).init();
  await require(path.join(repo, "pepefeed")).ensureAccount().catch(() => {});
  await settle(150);
  const app = express();
  app.use((req, res, next) => (req.path === "/api/bridge/sync" || req.path === "/api/bridge/sync/v2" || req.path === "/api/roomstats/sync" ? next() : express.json()(req, res, next)));
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  const isBotToken = (t) => t === "bot";
  require(path.join(repo, "roomstats")).register(app, { isBotToken, addUser });     // (index.js: before bridge)
  require(path.join(repo, "pads")).register(app);
  require(path.join(repo, "feedweb")).register(app, { addUser, isBotToken });
  bridge.register(app, { addUser, isBotToken });
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken });
  PW.register(app, { addUser, noTimers: true });
  require(path.join(repo, "seethrough")).register(app, { addUser, noTimers: true });
  await new Promise((r) => { server = app.listen(0, r); });
  server.unref();
  base = "http://127.0.0.1:" + server.address().port;
  // the archive on (its notice 8 days ago), scrollback and downloads on; the privacy wire v2 on (G now)
  CL._setClock(() => Date.now() - 8 * D);
  await CL.setSwitch("notice", true, "test");
  CL._setClock(() => Date.now());
  for (const s of ["archive", "history", "search", "downloads"]) await CL.setSwitch(s, true, "test");
  await PW.init();
  await PW.setOn(true, { userId: U.adm.userId, username: "adm" });
  await rooms.setOwner(ROOM.id, "own", "test");
  // the room exists (an empty roster), then the pad goes PUBLIC before anything is said (a line keeps the access level it was said at)
  await sync([], { rooms: [{ room: ROOM, members: [ALICE], mic: [], count: 1, transcripts: true }] });
  await require(path.join(repo, "padaccess")).setLevel(U.own, { id: ROOM.id }, "public");
  await CV.reconcileNow(ROOM.id).catch(() => {});
  const t0 = T.t0 = Date.now() - 20 * 60e3;
  const roster = [Object.assign({}, ALICE, { on_cam: true }),
                  real(FR, "Frankie Fett", { priv: priv("incognito", FR), src: "list" }),
                  real(HK, "Hank Hide", { priv: priv("hidden", HK), src: "list" })];
  // Pepe's privacy events for the two (as he sends them when someone goes private) + the roster + their joins and lines
  await sync([
    { op: "event", id: "vl-ph-1", ts: new Date(t0 - 60e3).toISOString(), type: "privacy.hidden", data: { h: hash(FR), scope: "incognito" } },
    { op: "event", id: "vl-ph-2", ts: new Date(t0 - 60e3).toISOString(), type: "privacy.hidden", data: { h: hash(HK), scope: "bridge" } },
    ev("member.join", { user: real(FR, "Frankie Fett"), priv: priv("incognito", FR) }, t0),
    ev("member.join", { user: real(HK, "Hank Hide"), priv: priv("hidden", HK) }, t0 + 1000),
    ev("message", { user: ALICE, text: "hello pond" }, t0 + 2000),
    // Pepe's redactor ran on "😀frankiefettuccine and 😀Hank Hide, hi": an astral emoji right before each redacted name
    ev("message", { user: ALICE, text: "\u{1F600}someone and \u{1F600}someone, hi" }, t0 + 3000),
    ev("message", { user: real(FR, "Frankie Fett"), text: "pizza time", priv: priv("incognito", FR) }, t0 + 4000),
    ev("message", { user: real(HK, "Hank Hide"), priv: priv("hidden", HK, { words: WORDS[0] }) }, t0 + 5000),
  ], { rooms: [{ room: ROOM, members: roster, mic: [], count: 3, transcripts: true }] });
  // B.3: frankie's hold, a line said during it, the release, a line after it - THEN his 🎙 line arrives (speech-to-text is slow),
  // naming the hold; the live tail puts it right after the drop, history / downloads keep cursor order
  T.grab = t0 + 10000;
  const frP = real(FR, "Frankie Fett", { proven: true, since: T.grab / 1000 });
  await sync([ev("mic.grab", { user: frP, hold: H1, priv: priv("incognito", FR) }, T.grab)],
             { rooms: [{ room: ROOM, members: roster, mic: [Object.assign({}, frP, { priv: priv("incognito", FR) })], count: 3, transcripts: true }] });
  await sync([ev("message", { user: ALICE, text: "said while the frog holds the mic" }, T.grab + 2000)]);
  await sync([ev("mic.release", { user: frP, hold: H1, held_ms: 9000, priv: priv("incognito", FR) }, T.grab + 9000)],
             { rooms: [{ room: ROOM, members: roster, mic: [], count: 3, transcripts: true }] });
  await sync([ev("message", { user: ALICE, text: "after the turn" }, T.grab + 10000)]);
  await sync([ev("x.pepe.transcript", { id: "tx-00000000000000f1", user: real(FR, "Frankie Fett"), text: "hercules is the funniest", source: "mic",
                                         hold: H1, said_at: T.grab / 1000 + 1, priv: priv("incognito", FR) }, T.grab + 14000)]);
  // hank's hold (proven) and his hidden 🎙 line
  const hkP = real(HK, "Hank Hide", { proven: true, since: (T.grab + 20000) / 1000 });
  await sync([ev("mic.grab", { user: hkP, hold: H2, priv: priv("hidden", HK) }, T.grab + 20000),
              ev("mic.release", { user: hkP, hold: H2, held_ms: 5000, priv: priv("hidden", HK) }, T.grab + 25000),
              ev("x.pepe.transcript", { id: "tx-00000000000000f2", user: real(HK, "Hank Hide"), source: "mic", hold: H2, said_at: (T.grab + 21000) / 1000,
                                        priv: priv("hidden", HK, { words: WORDS[2] }) }, T.grab + 27000),
              ev("message", { user: real(HK, "Hank Hide"), priv: priv("hidden", HK, { words: WORDS[1] }) }, T.grab + 28000)]);
  await settle();
  await CV.init();
  await require(path.join(repo, "chatlogmod")).init();
  await CV.refreshNames();
  CV._clearCaches();
})();
const ready = async () => { await setup; X._reset(); X._setLimits({ perMin: 1000 }); CV._clearCaches(); };
/** The frog names the member view shows: {fr, hk} (each one session for the whole fixture). */
async function aliases() {
  const lv = await live(U.mem);
  const fr = lv.d.feed.find((o) => o.k === "msg" && o.text === "pizza time");
  const hk = lv.d.feed.find((o) => o.k === "msg" && o.mask && o.u && o.u.veil === "hidden");
  assert.ok(fr && ALIAS_RE.test(fr.u.alias || ""), "frankie's frog name");
  assert.ok(hk && ALIAS_RE.test(hk.u.alias || ""), "hank's frog name");
  return { fr: fr.u.alias, hk: hk.u.alias };
}

test("downloads: TXT / JSONL / HTML - frog names, [hidden], masked JSONL; nothing of who for a member, staff, the owner, an admin (before any Reveal) or the speaker; signed out: no file", async () => {
  await ready();
  const A = await aliases();
  const files = {};
  for (const [k, u] of [["mem", U.mem], ["staff", U.staff], ["own", U.own], ["adm", U.adm], ["self", U.frankie]]) {
    for (const fmt of ["txt", "jsonl", "html"]) {
      const r = await call("POST", `/api/rooms/${SLUG}/chatlog/export`, { user: u, body: { fmt, range: "24h", sys: true } });
      assert.equal(r.status, 200, `${k} ${fmt}: ${r.text.slice(0, 200)}`);
      const f = await call("GET", r.d.url, { user: u });
      assert.equal(f.status, 200, `${k} ${fmt}: ${f.text.slice(0, 200)}`);
      assert.deepEqual(leaks(f.text), [], `${k}'s ${fmt} names nobody veiled: ${leaks(f.text).join(", ")}`);
      files[k + "." + fmt] = f.text;
    }
  }
  // the member's TXT: frog names (joins too - owner J-4), "[hidden]" for hank's chat AND 🎙 line, frankie's words kept
  const txt = files["mem.txt"];
  assert.match(txt, new RegExp(`^\\[\\d\\d:\\d\\d\\] ${A.fr}: pizza time$`, "m"), "an incognito line under the frog name, its words kept");
  assert.match(txt, new RegExp(`^\\[\\d\\d:\\d\\d\\] ${A.hk}: \\[hidden\\]$`, "m"), "a hidden line: the frog name + [hidden]");
  assert.match(txt, new RegExp(`^\\[\\d\\d:\\d\\d\\] 🎙 ${A.fr}: “hercules is the funniest”$`, "m"), "an incognito 🎙 line");
  assert.match(txt, new RegExp(`^\\[\\d\\d:\\d\\d\\] 🎙 ${A.hk}: “\\[hidden\\]”$`, "m"), "a hidden 🎙 line: [hidden]");
  assert.match(txt, new RegExp(`^\\[\\d\\d:\\d\\d\\] → ${A.fr} joined$`, "m"), "J-4: a veiled join under the frog name");
  assert.equal((txt.match(/\[hidden\]/g) || []).length, 3, "all three of hank's lines (two typed, one 🎙), never his words");
  assert.match(txt, /^\[\d\d:\d\d\] Alice: \u{1F600}someone and \u{1F600}someone, hi$/mu, "a redacted name after an astral emoji stays 'someone', whole");
  // the JSONL: the frog name as the author (someone: true, no login), {masked, mask} and no text for hank's lines
  const J = files["mem.jsonl"].trim().split("\n").map((l) => JSON.parse(l));
  const veiled = J.slice(1).filter((o) => o.author && o.author.someone && (o.author.name === A.fr || o.author.name === A.hk));
  assert.ok(veiled.length >= 6, "the veiled lines are in the file: " + veiled.length);
  for (const o of veiled) assert.deepEqual(Object.assign({}, o.author, { name: "-" }), { name: "-", patv: null, camfrog: null, web: false, pepe: false, bot: false, someone: true });
  const masked = J.filter((o) => o.masked);
  assert.equal(masked.length, 3, "hank's three lines are masked");
  for (const o of masked) { assert.ok(/^[sml]$/.test(o.mask), "a bucket"); assert.ok(!("text" in o), "never a text"); assert.equal(o.author.name, A.hk); }
  for (const o of J.slice(1)) for (const key of Object.keys(o).concat(o.author ? Object.keys(o.author) : [])) assert.ok(!/^(ah|ahs|hold|id|vz|vw|priv|login|h)$/i.test(key), "no internal key: " + key);
  // the HTML: the frog name in italics with its tag, the bar (never the words), no Reveal, no self view, no anchor attributes
  const html = files["mem.html"];
  assert.ok(html.includes(`<i>${A.fr}</i>`) && html.includes(`<i>${A.hk}</i>`), "frog names in italics");
  assert.equal((html.match(/class="redact redact-[sml]"/g) || []).length, 3, "three bars");
  // J-9 / E.4: a file is the member view for EVERY role - the owner's and an admin's (before any Reveal) and the speaker's own
  const items = (k) => files[k + ".txt"].split("\n").filter((l) => /^\[\d\d:\d\d\] /.test(l));
  const jitems = (k) => files[k + ".jsonl"].trim().split("\n").slice(1);
  for (const k of ["staff", "own", "adm", "self"]) {
    assert.deepEqual(items(k), items("mem"), `${k}'s TXT lines = the member's`);
    assert.deepEqual(jitems(k), jitems("mem"), `${k}'s JSONL items = the member's`);
    const h = files[k + ".html"];
    for (const bad of ["veil-reveal", "data-reveal", "veil-self", "only you can see this", "data-hold", "data-c=", "you, as "]) assert.ok(!h.includes(bad), `${k}'s HTML: no ${bad}`);
  }
  // signed out (a Public pad): no file - the POST says sign in, a link goes back to the pad
  const so = await call("POST", `/api/rooms/${SLUG}/chatlog/export`, { body: { fmt: "txt", range: "24h" } });
  assert.equal(so.status, 401);
  assert.deepEqual(leaks(so.text), []);
  const sl = await call("GET", `/p/${SLUG}/chatlog/dl/${"b".repeat(32)}`);
  assert.equal(sl.status, 303);
  assert.match(String(sl.headers.location), /cldl=signin/);
});

test("/p/<slug>/analytics with veiled people: Pepe's anonymous rows and his notes naming the hidden person - nothing of who for anyone, signed out on the Public pad too", async () => {
  await ready();
  const days = {};
  for (let i = 0; i < 5; i++) days[new Date(Date.now() - i * D).toISOString().slice(0, 10)] = { m: 10, s: 60, k: 1, u: 3, c: 1, n: 0 };
  const nums = (s) => ({ m30: s, s30: s * 10, d30: 9, m90: s * 3, s90: s * 30, d90: 30 });
  // as Pepe sends it on v2: frankie and hank are private on his side -> anonymous rows at their real rank (K.5); his room notes
  // name hank by login and display name (Pepe's notes scrubber covers incognito people, not !bridge hide - pepe_roomintel)
  const row = {
    room: ROOM.id, name: ROOM.name, first: 1780000000, last: Math.floor(Date.now() / 1000), days, how: [], hows: [], size: {}, peak: "", uniq: { d30: 5, d90: 9 },
    regulars: [{ login: "alicecf", display: "Alice", ...nums(90), last: 1790000000 }, { anon: true, h: hash(HK), ...nums(80) }, { anon: true, h: hash(FR), ...nums(70) }],
    mic_top: [{ anon: true, h: hash(FR), s90: 9000, d90: 40 }, { anon: true, h: hash(HK), s90: 100, d90: 2 }],
    cmds: { top: [], cats: {} }, games: { days: {} }, mod: { total: {}, days: {} },
    knowledge: { summary: "Hank Hide runs the jokes here, and hankhidden starts every argument.", topics: [{ t: "Hank Hide's pizza", w: 3 }], jokes: ["@hankhidden's mic"],
                 events: [], rules: [], vibe: "chill" },
    changes: ["new regulars: hankhidden"], history: [{ at: Math.floor(Date.now() / 1000) - 3600, topics: ["Hank Hide again"] }],
  };
  const s = await call("POST", "/api/roomstats/sync", { body: { password: "bot", tz: "UTC", days: 90, rooms: [row] } });
  assert.equal(s.status, 200, s.text);
  let frogs = null;
  for (const [k, u] of [["signed out", null], ["mem", U.mem], ["staff", U.staff], ["own", U.own], ["adm", U.adm]]) {
    const r = await call("GET", `/p/${SLUG}/analytics`, { user: u });
    assert.equal(r.status, 200, k + ": " + r.text.slice(0, 200));
    assert.match(r.text, /run the jokes|runs the jokes/, k + ": the room notes are on the page (not left out wholesale)");
    assert.deepEqual(leaks(r.text), [], `${k}: the analytics page names nobody veiled: ${leaks(r.text).join(", ")}`);
    const f = [...r.text.matchAll(/<span class="anon">([^<]+)<\/span><span class="ptag">private<\/span>/g)].map((m) => m[1]);
    assert.equal(f.length, 4, k + ": the four private rows under frog names: " + f.join(", "));
    if (frogs) assert.deepEqual(f, frogs, k + ": the same names for everyone");
    frogs = f;
  }
  assert.match((await call("GET", `/p/${SLUG}/analytics`, { user: U.mem })).text, /someone runs the jokes here, and someone starts every argument/,
               "the notes say 'someone' where they named the hidden person");
});

test("a signed-out visitor of a Public pad: the pad page, /live, the history JSON and search carry no identity", async () => {
  await ready();
  const A = await aliases();
  const page = await call("GET", `/p/${SLUG}`);
  assert.equal(page.status, 200, page.text.slice(0, 200));
  assert.deepEqual(leaks(page.text), [], "the pad page: " + leaks(page.text).join(", "));
  const init = rmInit(page.text);
  assert.ok(init && Array.isArray(init.feed), "the page carries its live tail");
  assert.ok(init.feed.some((o) => o.u && o.u.alias === A.fr) && init.feed.some((o) => o.mask && o.u.alias === A.hk), "...with the frog names and the bar (not vacuous)");
  const lv = await live(null);
  assert.equal(lv.status, 200, "a Public pad's live tail is open signed out");
  assert.deepEqual(leaks(lv.text), [], "/live: " + leaks(lv.text).join(", "));
  assert.ok(lv.d.feed.some((o) => o.u && o.u.alias === A.fr), "frog names in /live");
  assert.ok(!lv.d.feed.some((o) => o.rv || o.self), "no reveal / self flags");
  const vm = lv.d.members.filter((m) => m.veil);
  assert.equal(vm.length, 2, "both veiled people listed");
  for (const m of vm) { assert.equal(m.anon, true); assert.ok(!("on_cam" in m) && !m.login); }
  assert.ok(lv.d.members.some((m) => m.on_cam === true && !m.veil), "a named member's cam icon still rides (the check reads on_cam)");
  for (const [what, r] of [["history", await call("GET", `/api/rooms/${SLUG}/history`)], ["history/state", await call("GET", `/api/rooms/${SLUG}/history/state`)],
                           ["history/check", await call("POST", `/api/rooms/${SLUG}/history/check`, { body: { cs: [1, 2, 3] } })],
                           ["search", await call("POST", `/api/rooms/${SLUG}/search`, { body: { q: "pizza" } })]]) {
    assert.equal(r.status, 401, what + ": signed out");
    assert.deepEqual(leaks(r.text), [], what);
  }
});

test("B.3: history and downloads keep cursor order (the gap, noted); what they show of an anchored 🎙 line leaks nothing and carries its hold + said time", async (t) => {
  await ready();
  const A = await aliases();
  // the live tail: the 🎙 line names the hold its grab / drop carry (room.ejs puts it right after the drop)
  const lv = await live(U.mem);
  const tx = lv.d.feed.find((o) => o.k === "tx" && o.text === "hercules is the funniest");
  const rel = lv.d.feed.find((o) => o.k === "unmic" && o.u && o.u.alias === A.fr);
  assert.ok(tx && rel && tx.hold === H1 && rel.hold === H1, "live: the same hold on the drop and the 🎙 line");
  // history (a member): the same line, frog name, words, hold and said time - nothing of who
  const h = await call("GET", `/api/rooms/${SLUG}/history`, { user: U.mem });
  assert.equal(h.status, 200, h.text.slice(0, 200));
  assert.deepEqual(leaks(h.text), [], "/history: " + leaks(h.text).join(", "));
  const htx = h.d.items.find((o) => o.k === "tx" && o.text === "hercules is the funniest");
  assert.ok(htx && htx.u.alias === A.fr && htx.u.anon === true, "history: the frog name");
  assert.equal(htx.hold, H1, "history: the hold rides (a page can anchor it)");
  assert.ok(Math.abs(Number(htx.at) - (T.grab + 1000)) < 2000, "history: the said time");
  const hk = h.d.items.filter((o) => o.mask && (o.k === "msg" || o.k === "tx"));
  assert.ok(hk.length === 3 && hk.every((o) => !("text" in o) && o.u.alias === A.hk), "history: hank's lines are bars");
  // the order: cursor order on the server (spec B.3 "the same placement is computed server-side for history pages ... downloads use
  // the anchored order" is NOT built - track A's "left for later"); recorded, not asserted, so a later server-side anchoring passes
  const ks = h.d.items.map((o) => (o.k === "tx" && o.hold === H1 ? "TX" : o.k === "unmic" && o.hold === H1 ? "DROP" : o.text === "after the turn" ? "AFTER" : null)).filter(Boolean);
  t.diagnostic("history order around frankie's turn: " + ks.join(" > ") + (ks.join(",") === "DROP,AFTER,TX" ? " (cursor order - B.3 server anchoring not built)" : ""));
  // the download: the same lines, frog names, no hold / anchor attributes (data: false), nothing of who
  const r = await call("POST", `/api/rooms/${SLUG}/chatlog/export`, { user: U.mem, body: { fmt: "html", range: "24h", sys: true } });
  const f = await call("GET", r.d.url, { user: U.mem });
  assert.equal(f.status, 200);
  assert.deepEqual(leaks(f.text), []);
  assert.ok(!f.text.includes(H1) && !f.text.includes(H2), "no hold id in a file");
  // 1.99?? dockclean (owner point 33x): "said HH:MM" only when it isn't the line's own time at its head (this turn was said in the same
  // minute it was posted, give or take a minute boundary) - either way the file carries no other trace of the turn
  const said = /class="said">said (\d\d:\d\d)</.exec(f.text), head = /<time class="when"[^>]*>(\d\d:\d\d)<\/time>[\s\S]{0,400}?hercules is the funniest/.exec(f.text);
  assert.ok(!said || !head || said[1] !== head[1], "a said time that repeats the head's time is left out");
});

test("FTS: the index holds no veiled login, display-name word or hidden word (MATCH); the astral-emoji line keeps 'someone' whole", async () => {
  await ready();
  const hits = async (tok) => (await getQuery("SELECT rowid FROM chat_log_fts WHERE chat_log_fts MATCH ?", ['"' + tok + '"'])).map((r) => r.rowid);
  assert.ok((await hits("pizza")).length >= 1, "the index works: frankie's incognito words are searchable (who, not what)");
  for (const tok of TOKENS) assert.deepEqual(await hits(tok), [], "never indexed: " + tok);
  const emoji = (await getQuery("SELECT c, text FROM chat_log WHERE text LIKE ?", ["%and %someone, hi"]))[0];
  assert.ok(emoji, "the astral-emoji line is archived");
  assert.equal(emoji.text, "\u{1F600}someone and \u{1F600}someone, hi", "stored whole: no fragment of a name, no broken surrogate");
  assert.ok((await hits("someone")).includes(emoji.c), "its 'someone' is a whole token in the index");
  // the hidden lines: text NULL (never indexed), the words only in the side table
  const cv = await getQuery("SELECT c, kind, words FROM chat_log_veil WHERE kind = 'hidden' AND words IS NOT NULL AND words <> '' ORDER BY c");
  assert.deepEqual(cv.map((r) => r.words).sort(), WORDS.slice().sort(), "hank's words live in chat_log_veil only");
  const rows = await getQuery(`SELECT text FROM chat_log WHERE c IN (${cv.map((r) => r.c).join(",")})`);
  assert.ok(rows.every((r) => r.text === null), "their chat_log text is NULL");
});

test("the spec's cam form: a v2 cam.open / cam.close WITH a real UserRef + priv, and a veiled snapshot entry claiming on_cam - nothing stored, never a cam icon", async () => {
  await ready();
  const R = bridge._rooms.get(ROOM.id);
  const n0 = R.feed.length;
  const bf0 = (await getQuery("SELECT COUNT(*) AS n FROM bridge_feed"))[0].n, bv0 = (await getQuery("SELECT COUNT(*) AS n FROM bridge_veil"))[0].n;
  await sync([ev("cam.open", { user: real(FR, "Frankie Fett"), priv: priv("incognito", FR) }),
              ev("cam.close", { user: real(HK, "Hank Hide"), reason: "stopped", priv: priv("hidden", HK) })],
             { rooms: [{ room: ROOM, members: [Object.assign({}, ALICE, { on_cam: true }), real(FR, "Frankie Fett", { priv: priv("incognito", FR), src: "list", on_cam: true }),
                                               real(HK, "Hank Hide", { priv: priv("hidden", HK), src: "list", on_cam: false })], mic: [], count: 3, transcripts: true }] });
  await settle();
  assert.equal(R.feed.length, n0, "no feed item for a cam event");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM bridge_feed"))[0].n, bf0, "nothing stored");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM bridge_veil"))[0].n, bv0, "no identity row");
  for (const e of R.members) if (e.veil) assert.ok(!("on_cam" in e), "a veiled roster entry never keeps on_cam");
  assert.ok((await getQuery("SELECT snap FROM bridge_rooms WHERE id = ?", [ROOM.id]))[0].snap.indexOf(FR) < 0, "the stored snapshot names nobody veiled");
  for (const u of [U.mem, U.adm, null]) {
    const lv = await live(u);
    assert.deepEqual(leaks(lv.text), []);
    assert.ok(lv.d.members.filter((m) => m.veil).every((m) => !("on_cam" in m)), "no cam icon for a veiled person");
    assert.ok(lv.d.members.some((m) => !m.veil && m.on_cam === true), "a named member's cam still shows");
  }
});

test("the homepage / embeds Reveal refusal on its own: the homepage panel never carries a reveal flag or draws Reveal; a cross-site call is refused and logs nothing", async () => {
  await ready();
  // the pad page's /live does give the owner and an admin their flags (so their absence below means something)
  assert.ok((await live(U.adm)).d.feed.some((o) => o.rv === 1), "the pad page: rv for an admin");
  // the homepage panel's first load (home.js -> bridge.liveFor, nonExempt): the member view for everyone - no rv, no self
  const homeMem = await bridge.liveFor(SLUG, U.mem);
  const strip = (v) => JSON.stringify(v.feed.map((o) => Object.assign({}, o, { own: undefined })));
  for (const [k, u] of [["adm", U.adm], ["own", U.own], ["self", U.frankie], ["signed out", null]]) {
    const v = await bridge.liveFor(SLUG, u);
    const s = JSON.stringify(v);
    assert.ok(!/"rv":/.test(s) && !/"self":1/.test(s), k + ": no reveal / self flag on the homepage panel");
    assert.deepEqual(leaks(s), [], k);
    assert.equal(strip(v), strip(homeMem), k + ": the homepage shows them the member's lines");
  }
  // the homepage widget draws no Reveal and never calls the reveal endpoints (its later polls may carry rv: it ignores them)
  const home = fs.readFileSync(path.join(repo, "views", "home.ejs"), "utf8");
  for (const bad of ["veil-reveal", "data-reveal", "/api/chatlog/reveal", "/api/chatlog/seethrough", "pad-reveal.js", ".rv"]) assert.ok(!home.includes(bad), "home.ejs: " + bad);
  const shared = fs.readFileSync(path.join(repo, "public", "js", "room-bridge.js"), "utf8");
  assert.ok(!shared.includes("/api/chatlog/reveal") && !shared.includes("/api/chatlog/seethrough"), "the shared room widget script (homepage too) never reveals");
  // an embed or a page on another site (or a link): refused before anything is looked up, and nothing is logged
  const R = bridge._rooms.get(ROOM.id);
  const hk = R.feed.find((x) => x.u && x.u.veil === "hidden" && x.k === "msg");
  const rows0 = (await getQuery("SELECT COUNT(*) AS n FROM seethrough_log"))[0].n;
  const evil = "https://evil.example";
  const tries = [
    ["a foreign Origin", "/api/chatlog/reveal", { room: SLUG, c: [hk.c] }, { origin: evil }],
    ["a foreign Referer, no Origin", "/api/chatlog/reveal", { room: SLUG, c: [hk.c] }, { origin: null, referer: evil + "/embed.html" }],
    ["no Origin or Referer (a plain form post)", "/api/chatlog/reveal", { room: SLUG, c: [hk.c] }, { origin: null }],
    ["not the site's fetch", "/api/chatlog/reveal", { room: SLUG, c: [hk.c] }, { "x-requested-with": null }],
    ["a tile, from a foreign Origin", "/api/chatlog/reveal", { room: SLUG, tile: "v-AAAAAAAAAAAA" }, { origin: evil }],
    ["the toggle ON, from a foreign Origin", "/api/chatlog/seethrough", { room: SLUG, on: true }, { origin: evil }],
  ];
  for (const [what, url, body, headers] of tries) {
    for (const u of [U.adm, U.own]) {
      const r = await call("POST", url, { user: u, body, headers });
      assert.equal(r.status, 403, `${what} (${u.username}): ${r.status} ${r.text.slice(0, 120)}`);
      assert.deepEqual(leaks(r.text), [], what);
    }
  }
  assert.equal((await call("GET", `/api/chatlog/reveal?room=${SLUG}&c=${hk.c}`, { user: U.adm })).status, 404, "never by a GET (a link)");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM seethrough_log"))[0].n, rows0, "no refused call wrote a log row");
  // the control: the same reveal from the pad page (same origin, the site's fetch) works - and logs its one row
  const ok = await call("POST", "/api/chatlog/reveal", { user: U.adm, body: { room: SLUG, c: [hk.c] } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM seethrough_log"))[0].n, rows0 + 1);
});
