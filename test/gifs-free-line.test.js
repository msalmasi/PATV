"use strict";
// 1.99aot gifs: a free-mode GIF end to end on the real bridge - the live view's page data (browser key, the pad's rating, the notice
// flag), a send with the browser's details, Pepe's echo marked and archived WITH its details (bridge_feed + chat_log.d), every viewer's
// line drawn from them without a single KLIPY request, ⚑ Report on a GIF line, the moderator's 🚫 Remove this GIF everywhere (one
// transaction: the line hidden + the GIF blocked; its other lines "gone"; never sendable again), a purge taking the details with the
// words, and the pad page sending no CSP that could block KLIPY.
//   NODE_PATH=G:/PATV/node_modules node --test test/gifs-free-line.test.js
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), http = require("http");
const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gifs-free-line-test-"));
process.chdir(tmp);
delete process.env.STAGING; delete process.env.CHATLOG_DB; delete process.env.KLIPY_API_KEY;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
process.env.MICCLIP_DIR = path.join(tmp, "micclip");
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
process.env.KLIPY_PUBLIC_KEY = "fixtureBrowserKey_0123456789";
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
require(path.join(repo, "terms"))._setRequired(false);
const bridge = require(path.join(repo, "bridge"));
const relay = require(path.join(repo, "bridge-relay"));
const CL = require(path.join(repo, "chatlog"));
const CV = require(path.join(repo, "chatlogview"));
const CLM = require(path.join(repo, "chatlogmod"));
const PC = require(path.join(repo, "padchat"));
const G = require(path.join(repo, "gifs"));
const P = require(path.join(repo, "paddock"));
const AG = require(path.join(repo, "adultgate"));

const DAY = 864e5;
let offset = 0;
CL._setClock(() => Date.now() + offset);
const ROOM = { id: "Gf.Room", name: "Gf Room" };
const SLUG = "gf-room";
const ALICE = { id: "alicecf", login: "alicecf", display: "Alice" };
const BOB = { id: "bobcf", login: "bobcf", display: "Bob" };
const PEPE = { id: "pepefrog", login: "pepefrog", display: "PepeFrog", is_self: true };
const GIF = "wave-hello-1", OTHER_GIF = "other-gif-2";
// each GIF its own KLIPY CDN directory (/ii/<32 hex>/<2 hex>/<2 hex>/ - its media key); `hash` = another GIF's picture
const hashOf = (id) => require("crypto").createHash("md5").update(id).digest("hex");
const srcOf = (id) => "https://static1.klipy.com/ii/" + hashOf(id) + "/14/af/AbCd1234.webp";
const details = (id = GIF, hash = null) => ({ src: hash ? "https://static1.klipy.com/ii/" + hash + "/14/af/AbCd1234.webp" : srcOf(id), w: 220, h: 124, title: "Wave hello", page: "https://klipy.com/gifs/" + id });
const users = new Map(), U = {};
let base, server, seq = 0, klipy = [];
const realFetch = global.fetch;
const ev = (type, data, ts) => ({ op: "event", id: "gf-" + (++seq), ts: new Date(ts || Date.now()).toISOString(), type, scope: { platform: "camfrog", room: ROOM }, data });
const snap = () => ({ room: ROOM, members: [ALICE, BOB], mic: [], count: 3, transcripts: true, relay: true, mod: { modcf: { actions: ["kick", "ban"] } } });

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
const act = (c, what, user, body) => post(`/api/rooms/${SLUG}/chatlog/${c}/${what}`, user, body);
const live = (user) => get(`/api/rooms/${SLUG}/live`, user);
async function mkUser(name, cls = "pleb", camfrog = null) {
  const uid = "id-" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at)
                  VALUES (?, ?, ?, 'x', ?, 100000, ?, 5, '2026-01-01 00:00:00')`, [uid, name, name, cls, camfrog]);
  const u = { userId: uid, username: name, class: cls };
  users.set(uid, u);
  return u;
}
/** A GIF pick from alice's browser (the details the free picker posts), then Pepe's echo of that job -> the archived line's c. */
async function sendGif(id = GIF, cid = "gfcid" + (++seq), hash = null) {
  const s = await post(`/api/rooms/${SLUG}/say`, U.alice, { text: "[gif:" + id + "]", cid, gif: details(id, hash) });
  assert.equal(s.status, 200, JSON.stringify(s.d));
  relay.takeJobs(new Set([ROOM.id]), "pull");
  await bridge.ingest({ rooms: [snap()], acks: [], events: [ev("message", { user: PEPE, text: "🌐 Alice (web): 🎞️ Wave hello https://klipy.com/gifs/" + id, self: true,
                                                                          web: { user: ALICE, text: "[gif:" + id + "]", job: s.d.id } })] });
  const rows = await getQuery("SELECT c FROM chat_log WHERE text = ? ORDER BY c DESC LIMIT 1", ["[gif:" + id + "]"]);
  assert.ok(rows.length, "archived");
  return Number(rows[0].c);
}
const lineOf = (d, c) => (d.feed || []).find((it) => Number(it.c) === Number(c));

const setup = (async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await require(path.join(repo, "media")).ready;
  await require(path.join(repo, "inbox")).ready;
  require(path.join(repo, "actions"));
  U.own = await mkUser("own", "pleb", "owncf");
  U.alice = await mkUser("alice", "pleb", "alicecf");
  U.mem = await mkUser("mem", "pleb", "memcf");
  U.mod = await mkUser("modu", "pleb", "modcf");
  U.staff = await mkUser("helper", "Staff");
  await rooms.init();
  await require(path.join(repo, "feedstore")).init();
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
  G.register(app, { addUser });
  await new Promise((r) => { server = app.listen(0, r); });
  server.unref();
  base = "http://127.0.0.1:" + server.address().port;
  offset = -8 * DAY;
  await CL.setSwitch("notice", true, "test");
  offset = 0;
  await CL.setSwitch("archive", true, "test");
  await bridge.ingest({ rooms: [snap()], events: [ev("message", { user: BOB, text: "plain words before" }, Date.now() - 60e3)] });
  bridge._pepeName("pepefrog");
  await rooms.setOwner(ROOM.id, "own", "test");
  await CV.init(); await CLM.init(); await G.init();
  await P.init(); await P.save({ userId: "cfg", username: "fixture-admin", class: "Admin" }, { cfg: { mode: "everyone", gifs: "free" } });
  PC._reset();
  // every server request is watched: none may go to KLIPY
  global.fetch = (url, init) => { if (/klipy/i.test(String(url))) { klipy.push(String(url)); return Promise.reject(new Error("no KLIPY request expected")); } return realFetch(url, init); };
})();
const ready = async () => { await setup; offset = 0; PC._reset(); CLM._reset(); CV._clearCaches(); require(path.join(repo, "feedstore"))._gaps.clear(); G._reset(); };

test("the live view gives an eligible member the browser key, the pad's rating and the notice flag - nothing to the signed out", async () => {
  await ready();
  const r = await live(U.alice);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.room.gifPicker, true);
  assert.deepEqual(r.d.room.gifFree, { k: process.env.KLIPY_PUBLIC_KEY, r: "high", n: false, b: [] });
  const old = AG.isAdultPad;
  try { AG.isAdultPad = (id) => id === ROOM.id; assert.equal((await live(U.alice)).d.room.gifFree.r, "low", "an 18+ pad: PG-13 at most"); }
  finally { AG.isAdultPad = old; }
  const out = await live(null);
  assert.doesNotMatch(out.text, new RegExp(process.env.KLIPY_PUBLIC_KEY), "signed out: no picker, no key");
  if (out.d && out.d.room) { assert.equal(out.d.room.gifPicker, false); assert.equal(out.d.room.gifFree, undefined); }
  await P.save({ userId: "cfg", username: "fixture-admin", class: "Admin" }, { cfg: { gifs: "off" } });
  try { const off = await live(U.alice); assert.equal(off.d.room.gifPicker, false); assert.equal(off.d.room.gifFree, undefined); }
  finally { await P.save({ userId: "cfg", username: "fixture-admin", class: "Admin" }, { cfg: { gifs: "free" } }); }
  assert.deepEqual(klipy, []);
});

test("a free-mode GIF: marked, archived WITH its details (URLs and sizes, the rating), drawn for every viewer from them - no KLIPY request", async () => {
  await ready();
  const c = await sendGif();
  const row = (await getQuery("SELECT d, text FROM chat_log WHERE c = ?", [c]))[0];
  const d = JSON.parse(row.d);
  assert.equal(d.md, "gif");
  assert.deepEqual(d.gf, { src: details().src, w: 220, h: 124, title: "Wave hello", r: "high" }, "the rating stored on the line");
  const feedRow = (await getQuery("SELECT data FROM bridge_feed WHERE c = ?", [c]))[0];
  assert.ok(feedRow && /"gf":\{"src":"https:\/\/static1\.klipy\.com/.test(feedRow.data), "the live feed keeps them across a restart");
  for (const viewer of [U.mem, U.alice, U.own]) {
    const it = lineOf((await live(viewer)).d, c);
    assert.ok(it, "the line reaches " + viewer.username);
    assert.equal(it.md, "gif");
    assert.deepEqual(it.gif, { src: details().src, w: 220, h: 124, title: "Wave hello" });
    assert.equal(it.gf, undefined, "the stored details never go out as such (no rating on the page)");
  }
  // the scrollback / history read path draws it the same way
  const proj = await CV.project([CV.itemOf((await getQuery("SELECT * FROM chat_log WHERE c = ?", [c]))[0])], { view: await CV.view(ROOM.id, U.mem) });
  assert.deepEqual((proj.items || proj)[0].gif, { src: details().src, w: 220, h: 124, title: "Wave hello" });
  assert.deepEqual(klipy, [], "the server never asked KLIPY");
});

test("⚑ Report works on a GIF line as on any line", async () => {
  await ready();
  const c = await sendGif(GIF, "gfreport01");
  const r = await act(c, "report", U.mem, { reason: "sexual", note: "fixture" });
  assert.equal(r.status, 200, r.text); assert.equal(r.d.ok, true);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM chatlog_reports WHERE c = ?", [c]))[0].n, 1);
});

test("🚫 Remove this GIF everywhere: the room's mods / owner / staff only, GIF lines only; one transaction hides the line and blocks the GIF site-wide", async () => {
  await ready();
  const c1 = await sendGif(GIF, "gfblock001"), c2 = await sendGif(GIF, "gfblock002"), keep = await sendGif(OTHER_GIF, "gfblock003");
  const plain = Number((await getQuery("SELECT c FROM chat_log WHERE text = 'plain words before'"))[0].c);
  const m = await act(c1, "gifblock", U.mem, {});
  assert.equal(m.status, 403, m.text); assert.equal(m.d.code, "forbidden", "a member can only report");
  assert.equal((await act(plain, "gifblock", U.mod, {})).d.code, "not_gif");
  assert.equal(G.isBlocked(GIF), false, "nothing blocked by a refused try");
  // review: the same picture already posted under ANOTHER slug (a hand-made client) - a removal must take it too
  const alias = await sendGif("made-up-slug-1000", "gfblock010", hashOf(GIF));
  const ok = await act(c1, "gifblock", U.mod, { why: "not for this pad" });
  assert.equal(ok.status, 200, ok.text); assert.deepEqual(ok.d, { ok: true, blocked: true });
  const r1 = (await getQuery("SELECT rm_at, rm_by, rm_why FROM chat_log WHERE c = ?", [c1]))[0];
  assert.ok(r1.rm_at); assert.equal(r1.rm_by, "mod:" + U.mod.userId); assert.equal(r1.rm_why, "not for this pad", "the reason stays on the hidden line");
  // review: the block row - the slug and the picture's media key; no line number, no reason (privacy)
  const b = await getQuery("SELECT * FROM gif_blocks");
  assert.equal(b.length, 1); assert.deepEqual({ ...b[0], at: 0 }, { id: GIF, at: 0, room: ROOM.id, kind: "mod", slug: GIF, mk: hashOf(GIF) + "/14/af" });
  const d = (await live(U.mem)).d;
  assert.equal(lineOf(d, c1), undefined, "the line is gone");
  assert.deepEqual(lineOf(d, c2).gif, { gone: 1 }, "the same GIF's other lines: GIF no longer available");
  assert.deepEqual(lineOf(d, alias).gif, { gone: 1 }, "review: its picture under another slug too");
  // open pad pages draw those other lines again (the redo ring), never the removed one
  const redo = (bridge._rooms.get(ROOM.id).redo || []).map((x) => x.c);
  assert.ok(redo.includes(c2), "the other line is redrawn on open pages"); assert.ok(redo.includes(alias), "review: and the alias line");
  assert.ok(!redo.includes(c1)); assert.ok(!redo.includes(keep));
  assert.equal(lineOf(d, keep).gif.src, details(OTHER_GIF).src, "other GIFs untouched");
  const again = await post(`/api/rooms/${SLUG}/say`, U.alice, { text: "[gif:" + GIF + "]", cid: "gfblock004", gif: details() });
  assert.equal(again.status, 403); assert.equal(again.d.code, "gif_removed", "never sendable again");
  // review: the same picture under a fresh slug - refused; and the free picker's page data names it (it leaves it out of KLIPY's answers)
  const fresh = await post(`/api/rooms/${SLUG}/say`, U.alice, { text: "[gif:made-up-slug-1001]", cid: "gfblock005", gif: details("made-up-slug-1001", hashOf(GIF)) });
  assert.equal(fresh.d.code, "gif_removed");
  assert.deepEqual((await live(U.alice)).d.room.gifFree.b, [GIF, hashOf(GIF) + "/14/af"]);
  // the owner (no reason: "GIF removed") and an already-hidden line still block
  const own = await act(keep, "gifblock", U.own, {});
  assert.equal(own.status, 200, own.text);
  assert.equal((await getQuery("SELECT rm_why FROM chat_log WHERE c = ?", [keep]))[0].rm_why, "GIF removed");
  assert.equal((await getQuery("SELECT kind FROM gif_blocks WHERE id = ?", [OTHER_GIF]))[0].kind, "owner");
  assert.ok((await getQuery("SELECT 1 FROM room_events WHERE room_id = ? AND what = 'chat.hide' AND detail LIKE '%GIF removed everywhere%'", [ROOM.id])).length);
  assert.deepEqual(klipy, []);
});

test("review: a pad's owner / mods remove at most BLOCK_DAY_MAX GIFs everywhere a day (each is site-wide); staff have no cap", async () => {
  await ready();
  const c = await sendGif("quota-gif-1", "gfquota01"), c2 = await sendGif("quota-gif-2", "gfquota02");
  for (let i = 0; i < G.BLOCK_DAY_MAX; i++) G.noteBlockUse(U.mod.userId, false);
  const r = await act(c, "gifblock", U.mod, {});
  assert.equal(r.status, 429, r.text); assert.equal(r.d.code, "gif_quota");
  assert.equal(G.isBlocked("quota-gif-1"), false, "nothing blocked");
  assert.equal((await getQuery("SELECT rm_at FROM chat_log WHERE c = ?", [c]))[0].rm_at, null, "nor hidden");
  for (let i = 0; i < G.BLOCK_DAY_MAX + 1; i++) G.noteBlockUse(U.staff.userId, true);
  assert.equal((await act(c2, "gifblock", U.staff, {})).status, 200, "staff: no cap");
});

test("review: a free line's stored rating against the pad's NOW - sent on an 18+ pad (low), then the pad made general: GIF no longer available", async () => {
  await ready();
  await rooms.setPage(ROOM.id, { adult: true }, "test");
  let c;
  try {
    assert.equal((await live(U.alice)).d.room.gifFree.r, "low");
    c = await sendGif("adult-era-gif", "gfadult01");
    assert.equal(JSON.parse((await getQuery("SELECT d FROM chat_log WHERE c = ?", [c]))[0].d).gf.r, "low");
  } finally { await rooms.setPage(ROOM.id, { adult: false }, "test"); }
  CV._clearCaches();
  const it = lineOf((await live(U.mem)).d, c);
  assert.ok(it, "the line is still there");
  assert.deepEqual(it.gif, { gone: 1 }, "its PG-13 picture isn't shown on a general pad");
  const proj = await CV.project([CV.itemOf((await getQuery("SELECT * FROM chat_log WHERE c = ?", [c]))[0])], { view: await CV.view(ROOM.id, U.mem) });
  assert.deepEqual((proj.items || proj)[0].gif, { gone: 1 }, "scrollback too");
  assert.deepEqual(klipy, []);
});

test("a staff purge takes the GIF's details with the words", async () => {
  await ready();
  const c = await sendGif("purge-gif-3", "gfpurge01");
  assert.ok(JSON.parse((await getQuery("SELECT d FROM chat_log WHERE c = ?", [c]))[0].d).gf);
  const r = await act(c, "purge", U.staff, { why: "fixture" });
  assert.equal(r.status, 200, r.text);
  const d = JSON.parse((await getQuery("SELECT d FROM chat_log WHERE c = ?", [c]))[0].d);
  assert.equal(d.gf, undefined); assert.equal(d.md, undefined);
});

test("the pad page (Room Dock on) loads the picker and sends no Content-Security-Policy that could block KLIPY", async () => {
  await ready();
  const r = await get("/p/" + SLUG, U.alice);
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.ok(r.text.includes('<script src="/public/js/pad-picker.js?v=5"></script>'), "the Dock's picker");
  const csp = r.headers["content-security-policy"];
  if (csp) for (const src of [...G.CSP_SOURCES.connect, ...G.CSP_SOURCES.img]) assert.ok(csp.includes(src), "a CSP would have to allow " + src);
  else assert.equal(csp, undefined, "no page CSP on this site (nothing to allow)");
  // the browser key rides in the page's live data for an eligible member only (it is meant for browsers); never for the signed out
  assert.match(r.text, new RegExp(process.env.KLIPY_PUBLIC_KEY));
  const out = await get("/p/" + SLUG, null);
  assert.equal(out.status, 200); assert.doesNotMatch(out.text, new RegExp(process.env.KLIPY_PUBLIC_KEY));
  assert.equal(out.headers["content-security-policy"], undefined);
});
