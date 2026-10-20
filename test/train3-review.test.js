// Train 3 review (site side): the findings fixed on the merged train2-site.
//   * data.anon.hs (the CL1 review-2 bot): every incognito hash an anonymised line's speaker could be is kept with the line (`ahs`,
//     server-only - archived in d, never on a page) and the line is LEFT OUT once ANY of them is (!bridge hide under a display
//     name) - in the live tail (and the open page's `removed` ring), the archive's rows, quotes, and the owner sync's removed list;
//     a line naming more than 32 such hashes isn't shown at all (fails closed);
//   * one reader rule for the chat itself: the pad chat's readers take the STRICTER of the two sticky stores (chatlog.js's and
//     hubhidden.js's) - someone only hubhidden holds is "someone" (incognito) or left out (an older Pepe's unknown kind) in /live;
//   * the owner sync block: wm_chat / wm_tx (the room's own watermarks, reconciled), removed_ok, changed_at moved by the PAD's
//     changes only (never a global switch flip), and chatlog_known: true on POST /api/rooms/owners;
//   * the CL13 merge item: the per-login staff tool counts the login's !msg copy records / admins' Camfrog logs (look, export) and
//     "Delete every line" re-keys them to a pseudonym (messages.cfLoginForget), audited by the pseudonym;
//   * decision 15: the retention purge deletes nothing (why "not_started") until chatlog.archive was first switched on.
// Train 3 review fix-ups: "Delete every line" audits the forgotten login by its pseudonym only (its own row and the earlier rows
// naming it); a refused one (a hold) by the login; a left-out (!bridge hide) person is not in the rosters at all (incognito:
// "someone"). (chatlog-attach / chatlog-hidden / chatlog-archive / refresh-staging-keep hold the other fix-ups' tests.)
//   NODE_PATH=G:/PATV/node_modules node --test test/train3-review.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "train3-review-test-"));
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
const CLM = require(path.join(repo, "chatlogmod"));
const CLP = require(path.join(repo, "chatlogpurge"));
const HH = require(path.join(repo, "hubhidden"));
const quotes = require(path.join(repo, "quotes"));
const store = require(path.join(repo, "feedstore"));

const DAY = 864e5;
let offset = 0;
CL._setClock(() => Date.now() + offset);
const hash = (k) => crypto.createHash("sha256").update("pepe-hidden:" + String(k).trim().toLowerCase()).digest("hex").slice(0, 20);
const ROOM = { id: "T3.Room", name: "T3 Room" }, SLUG = "t3-room";
const ALICE = { id: "alicecf", login: "alicecf", display: "Alice Ash" };
const DAN = { id: "dancf", login: "dancf", display: "Dandelion" };
const ANON = () => ({ id: "anon-" + crypto.randomBytes(4).toString("hex"), display: "someone", anonymous: true });
const users = new Map();
const U = {};
let base, server, seq = 0, preMode = null;
const ev = (type, data, ts) => ({ op: "event", id: "t3-" + (++seq), ts: new Date(ts || Date.now()).toISOString(), type, scope: { platform: "camfrog", room: ROOM }, data });
const pev = (type, key, scope, ts) => ({ op: "event", id: "t3-p-" + (++seq), ts: new Date(ts || Date.now()).toISOString(), type, data: { h: hash(key), scope } });
const snap = (extra = {}) => Object.assign({ room: ROOM, members: [ALICE, DAN], mic: [], count: 2, transcripts: true, clip: true }, extra);
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

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
      res.on("end", () => { let d = null; try { d = JSON.parse(s); } catch (e) { d = null; } resolve({ status: res.statusCode, d, text: s }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const live = (user, q = "") => call("GET", `/api/rooms/${SLUG}/live${q}`, user);
const post = (url, user, body) => call("POST", url, user, body === undefined ? {} : body);
async function mkUser(name, cls = "pleb", camfrog = null) {
  const uid = "id-" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at)
                  VALUES (?, ?, ?, 'x', ?, 100000, ?, 5, '2026-01-01 00:00:00')`, [uid, name, name, cls, camfrog]);
  const u = { userId: uid, username: name, class: cls };
  users.set(uid, u);
  return u;
}
const row = async (text) => (await getQuery("SELECT * FROM chat_log WHERE text = ?", [text]))[0];
async function refresh() { await settle(); await CV.refreshNames(); CV._clearCaches(); }

const setup = (async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await require(path.join(repo, "media")).ready;
  await require(path.join(repo, "inbox")).ready;
  require(path.join(repo, "actions"));
  U.mem = await mkUser("mem", "pleb", "memcf");
  U.staff = await mkUser("helper", "Staff");
  U.bob = await mkUser("bob", "pleb", "bobcf");
  await rooms.init();
  await store.init();
  await require(path.join(repo, "messages")).init();
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
  await CL.init();
  // decision 15 (Train 3 review): before the archive was ever switched on, the purge only counts
  preMode = await CLP.modeNow();
  offset = -8 * DAY;
  await CL.setSwitch("notice", true, "test");
  offset = 0;
  await CL.setSwitch("archive", true, "test");
  await HH.whenBooted();
  await bridge.ingest({ rooms: [snap()], events: [ev("message", { user: ALICE, text: "alice opens the room" }, Date.now() - 40 * 60e3)] });
  await rooms.setOwner(ROOM.id, "own", "test").catch(() => {});
  await CV.init();
  await CLM.init();
})();

test("data.anon.hs: every hash the speaker could be stays with the line (server-only); the line is left out once ANY is left out", async () => {
  await setup;
  const T = Date.now();
  // carol is incognito under her login and under the display name a room line used ("caz") - Pepe's _br_anon_payload: h + hs
  await bridge.ingest({ rooms: [snap()], events: [pev("privacy.hidden", "carolcf", "incognito", T - 20 * 60e3), pev("privacy.hidden", "caz", "incognito", T - 20 * 60e3)],
                        hidden_h: [hash("carolcf"), hash("caz")], bridge_hidden_h: [], incog_hidden_h: [hash("carolcf"), hash("caz")], tx_hidden_h: [] });
  await bridge.ingest({ rooms: [snap()], events: [ev("message", { message_id: "m1", user: ANON(), text: "carol anon words",
                                                              anon: { kind: "incognito", h: hash("carolcf"), hs: [hash("carolcf"), hash("caz"), "nothex", hash("caz")] } }, T - 10 * 60e3)] });
  await refresh();
  // the live tail: "someone", and neither hash anywhere in the answer
  let L = await live(U.mem);
  assert.equal(L.status, 200, L.text.slice(0, 300));
  const it = L.d.feed.find((x) => x.text === "carol anon words");
  assert.ok(it && it.u.anon && it.u.display === "someone", JSON.stringify(it));
  for (const leak of [hash("carolcf"), hash("caz"), "ahs", "carolcf"]) assert.ok(!L.text.includes(leak), leak + " leaked into /live");
  // the feed item and the archive row keep the other hash (cleaned: valid, deduped, never h itself) - server-only
  const fi = bridge._rooms.get(ROOM.id).feed.find((x) => x.text === "carol anon words");
  assert.deepEqual([fi.ah, fi.ahs], [hash("carolcf"), [hash("caz")]]);
  const r = await row("carol anon words");
  assert.equal(r.who, "h:" + hash("carolcf"));
  assert.deepEqual(JSON.parse(r.d).ahs, [hash("caz")]);
  const item = CV.itemOf(r);
  assert.deepEqual(item.ahs, [hash("caz")]);
  assert.deepEqual(CV.speakerHashes(item), [hash("carolcf"), hash("caz")]);
  const dressed = CV.dress([item], { view: null });
  assert.ok(!("ahs" in dressed[0]) && !("ah" in dressed[0]), "dress drops both");
  // a quote of it keeps them too (server-only: the card shows name / text only)
  const lines = await quotes.buildLines([fi]);
  assert.deepEqual([lines[0].name, lines[0].h, lines[0].hs], ["someone", hash("carolcf"), [hash("caz")]]);
  assert.equal(quotes.lineLeftOut(lines[0]), false);
  const c = Number(fi.c);
  // then a room line shown as "Caz" types !bridge hide: Pepe hides the name it showed -> privacy.hidden {bridge, h(caz)}
  await bridge.ingest({ rooms: [snap()], events: [pev("privacy.hidden", "caz", "bridge", T - 60e3)],
                        hidden_h: [hash("carolcf"), hash("caz")], bridge_hidden_h: [hash("caz")], incog_hidden_h: [hash("carolcf"), hash("caz")], tx_hidden_h: [] });
  await refresh();
  assert.equal(CL.hiddenKind(hash("caz")), "out");
  assert.equal(CL.hiddenKind(hash("carolcf")), "anon", "the login itself is still only incognito");
  L = await live(U.mem);
  assert.ok(!L.d.feed.some((x) => x.text === "carol anon words"), "!bridge hide under the display name = LEFT OUT (data.anon.hs)");
  assert.equal(CV.privacyOf(CV.itemOf(await row("carol anon words"))), "out", "the archive's row too (history, search, downloads)");
  assert.ok((bridge._rooms.get(ROOM.id).removed || []).some((x) => x.c === c), "open pages drop it (the `removed` ring)");
  assert.equal(quotes.lineLeftOut(lines[0]), true, "a quote that copied it leaves it out");
  // a taken-down copy of the line tells Pepe every hash it may be his under (the owner sync's removed list)
  await runQuery("UPDATE chat_log SET rm_at = ?, rm_by = 'mod:x' WHERE c = ?", [Date.now(), c]);
  const rm = await CLM.removedRead(ROOM.id);
  assert.equal(rm.ok, true);
  const sec = Math.floor(Number(r.ts) / 1000);
  assert.ok(rm.list.some(([s, h]) => s === sec && h === hash("carolcf")) && rm.list.some(([s, h]) => s === sec && h === hash("caz")), JSON.stringify(rm.list));
  await runQuery("UPDATE chat_log SET rm_at = NULL, rm_by = NULL WHERE c = ?", [c]);
});

test("data.anon.hs: a line naming more than 32 other hashes isn't shown (fails closed); one without hs works as before", async () => {
  await setup;
  const many = Array.from({ length: 40 }, (_, i) => hash("ns" + i));
  await bridge.ingest({ rooms: [snap()], events: [
    ev("message", { user: ANON(), text: "too many namesakes", anon: { kind: "incognito", h: hash("carolcf"), hs: [hash("carolcf"), ...many] } }),
    ev("message", { user: ANON(), text: "plain anon line", anon: { kind: "incognito", h: hash("carolcf") } }),
  ] });
  const feed = bridge._rooms.get(ROOM.id).feed;
  assert.ok(!feed.some((x) => x.text === "too many namesakes"));
  const p = feed.find((x) => x.text === "plain anon line");
  assert.ok(p && p.ah === hash("carolcf") && !("ahs" in p));
});

test("one reader rule for the chat itself: someone only hubhidden holds is 'someone' (incognito) or left out (unknown kind) in /live", async () => {
  await setup;
  await bridge.ingest({ rooms: [snap()], events: [ev("message", { user: DAN, text: "dan says hello there" })] });
  await refresh();
  let L = await live(U.mem);
  assert.ok(L.d.feed.some((x) => x.text === "dan says hello there" && x.u.login === "dancf"), "named while nobody hides him");
  // the website's Incognito ON reached hubhidden only (the archive's set never heard of him: the first deploy's gap)
  await HH.hideNow(["dancf"], "web");
  await refresh();
  assert.equal(CL.hiddenKind(hash("dancf")), null, "chatlog's set doesn't hold him");
  assert.equal(quotes.isHidden("dancf"), true, "tips / mentions / the mic stage already treat him as private");
  assert.equal(CV.kindNow(hash("dancf")), "anon");
  L = await live(U.mem);
  const it = L.d.feed.find((x) => x.text === "dan says hello there");
  assert.ok(it && it.u.anon && it.u.display === "someone", JSON.stringify(it));
  assert.ok(!L.text.includes("dancf") && !L.text.includes("Dandelion"), "no login / display name anywhere (roster included)");
  // an older Pepe's mixed list puts an unknown kind on him in hubhidden: left out
  await HH.noteSync({ list: [hash("dancf")] });
  await refresh();
  assert.equal(CV.kindNow(hash("dancf")), "out");
  L = await live(U.mem);
  assert.ok(!L.d.feed.some((x) => x.text === "dan says hello there"), "left out, as quotes / tips leave him out");
});

test("the owner sync block: wm_chat / wm_tx follow the room's own reconciled watermarks, removed_ok, changed_at only for the pad; chatlog_known", async () => {
  await setup;
  await runQuery("INSERT INTO pad_chat_cfg (room_id, window_s, updated) VALUES (?, 3600, 1) ON CONFLICT(room_id) DO UPDATE SET window_s = 3600, updated = 1", [ROOM.id]);
  await CL.loadPadCfg();
  let b = (await CL.forOwnerSync([{ id: ROOM.id }]))[0].chatlog;
  assert.equal(b.window_s, 3600);
  assert.equal(b.removed_ok, true);
  assert.ok(Number.isInteger(b.wm_chat) && Number.isInteger(b.wm_tx), JSON.stringify(b));
  const wm0 = b.wm_chat;
  // the owner widens the window to "everything" - a hook the sync never saw: the sync's own reconcile raises the watermark (never
  // retroactive), so Pepe, following wm_chat exactly, still closes what was outside the old hour
  const t0 = Date.now();
  await runQuery("UPDATE pad_chat_cfg SET window_s = NULL, updated = 2 WHERE room_id = ?", [ROOM.id]);
  await CL.loadPadCfg();
  b = (await CL.forOwnerSync([{ id: ROOM.id }]))[0].chatlog;
  assert.ok(b.wm_chat >= t0 - 3600e3 - 2000 && b.wm_chat <= Date.now() && b.wm_chat > wm0, `wm_chat ${b.wm_chat} vs ${t0 - 3600e3}`);
  assert.ok(b.wm_tx >= t0 - 3600e3 - 2000, "mic lines too");
  // a global switch flip is no change to the pad's !log
  const chg = b.changed_at;
  await CL.setSwitch("downloads", true, "test");
  await CL.setSwitch("downloads", false, "test");
  b = (await CL.forOwnerSync([{ id: ROOM.id }]))[0].chatlog;
  assert.equal(b.changed_at, chg);
  // the route says this site HAS the archive (Pepe keeps his last blocks for good if a sync then carries none)
  const r = await post("/api/rooms/owners", null, { password: "bot" });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.equal(r.d.chatlog_known, true);
  await runQuery("DELETE FROM pad_chat_cfg WHERE room_id = ?", [ROOM.id]);
  await CL.loadPadCfg();
});

test("the CL13 merge item: the per-login staff tool counts the login's !msg copy records and Camfrog logs, and Delete every line re-keys them", async () => {
  await setup;
  const M = require(path.join(repo, "messages"));
  await runQuery("INSERT INTO dm_relays (message_id, relay_key, via, from_login, to_login, created) VALUES (9001, 'k9001', 'cf_pm', 'adminx', 'bobcf', 1)");
  await runQuery("INSERT INTO dm_relays (message_id, relay_key, via, from_login, to_login, created) VALUES (9002, 'k9002', 'cf_pm', 'bobcf', 'alicecf', 1)");
  await runQuery("INSERT INTO conversations (id, kind, dm_key, created_at) VALUES ('cfpm-t3', 'cfpm', ?, 1)", [M.cfKey(U.staff.userId, "bobcf")]);
  await bridge.ingest({ rooms: [snap()], events: [ev("message", { user: { id: "bobcf", login: "bobcf", display: "Bob" }, text: "bob line for the tool" })] });
  let r = await post("/api/admin/chatlog/who", U.staff, { key: "bobcf", action: "look", why: "privacy@ request #77" });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.d.summary.camfrog, { copies_to: 1, copies_from: 1, threads: 1 });
  assert.ok(!r.text.includes("adminx"), "counts only - never who sent a copy");
  r = await post("/api/admin/chatlog/who", U.staff, { key: "bobcf", action: "export", why: "privacy@ request #77" });
  assert.deepEqual(r.d.export.camfrog, { copies_to: 1, copies_from: 1, threads: 1 });
  r = await post("/api/admin/chatlog/who", U.staff, { key: "bobcf", action: "purge_all", why: "privacy@ request #77" });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.d.purged >= 1);
  assert.deepEqual(r.d.camfrog_forgot, { relays: 2, threads: 1 });
  assert.deepEqual(r.d.summary.camfrog, { copies_to: 0, copies_from: 0, threads: 0 });
  assert.deepEqual(await M.cfLoginSummary("bobcf"), { copies_to: 0, copies_from: 0, threads: 0 });
  const rel = await getQuery("SELECT from_login, to_login FROM dm_relays WHERE message_id IN (9001, 9002) ORDER BY message_id");
  assert.match(rel[0].to_login, /^deleted-[0-9a-f]{10}$/);
  assert.equal(rel[1].from_login, rel[0].to_login, "one pseudonym per login");
  // audited by the pseudonym and the counts - that row never names the login
  const a = await getQuery("SELECT who, why FROM chatlog_views WHERE kind = 'login_tool' AND who = ? AND why LIKE 'purge_all: !msg%'", [rel[0].to_login]);
  assert.equal(a.length, 1);
  assert.match(a[0].why, /^purge_all: !msg copies -> pseudonym \(2 copy record\(s\), 1 Camfrog log\(s\)\)$/);
  assert.ok(!a[0].why.includes("bobcf"));
  // Train 3 review fix-up: nor does the action's own row (written a few ms before - it would link the login to the pseudonym), and
  // the earlier rows that named the login as their subject (the look, the export) carry the pseudonym now (accountdelete's rule)
  const mine = await getQuery("SELECT who, why FROM chatlog_views WHERE kind = 'login_tool' AND why LIKE '%privacy@ request #77' ORDER BY id");
  assert.deepEqual(mine.map((x) => [x.who, x.why.replace(/:.*/, "")]), [[rel[0].to_login, "look"], [rel[0].to_login, "export"], [rel[0].to_login, "purge_all"]]);
  assert.deepEqual(await getQuery("SELECT id FROM chatlog_views WHERE ' ' || lower(who) || ' ' LIKE '% bobcf %'"), [], "no audit row names the login");
  assert.ok(r.d.audit_renamed >= 2, JSON.stringify(r.d.audit_renamed));
});

test("Train 3 review fix-up: a purge_all refused by a legal hold forgets nothing - it is audited by the login, as every other action", async () => {
  await setup;
  await bridge.ingest({ rooms: [snap()], events: [ev("message", { user: { id: "heldcf", login: "heldcf", display: "Held" }, text: "held line for the tool" })] });
  assert.equal((await post("/api/admin/chatlog/who", U.staff, { key: "heldcf", action: "hold", why: "legal order #5" })).status, 200);
  const r = await post("/api/admin/chatlog/who", U.staff, { key: "heldcf", action: "purge_all", why: "privacy@ request #78" });
  assert.deepEqual([r.status, r.d.code], [409, "held"]);
  const a = await getQuery("SELECT who FROM chatlog_views WHERE kind = 'login_tool' AND why = 'purge_all: privacy@ request #78'");
  assert.deepEqual(a, [{ who: "heldcf" }]);
  assert.equal((await post("/api/admin/chatlog/who", U.staff, { key: "heldcf", action: "unhold", why: "lifted" })).status, 200);
});

test("Train 3 review fix-up: a left-out person (!bridge hide) is not in the rosters at all - never a 'someone' entry; incognito stays 'someone'", async () => {
  await setup;
  const OUT = { id: "rosterout", login: "rosterout", display: "Gone Guy" }, INC = { id: "rosterinc", login: "rosterinc", display: "Shy Guy" };
  await bridge.ingest({ rooms: [], events: [pev("privacy.hidden", "rosterout", "bridge"), pev("privacy.hidden", "rosterinc", "incognito")] });
  await CL.noteSync({ list: [] });
  const SOME = { anon: true, display: "someone" };
  assert.deepEqual(CV.roster([ALICE, OUT, INC, SOME]), [ALICE, SOME, SOME], "left out: gone; incognito: someone; Pepe's stand-in as it is");
  // the live page: a named entry Pepe sent for someone the site leaves out (a site-only reason, or his list caught up later)
  await bridge.ingest({ rooms: [snap({ members: [ALICE, DAN, OUT, INC], mic: [OUT], count: 4 })], events: [] });
  const r = await live(U.mem);
  assert.equal(r.status, 200, r.text.slice(0, 300));
  const names = (r.d.members || []).map((u) => (u.anon ? "someone" : u.login));
  assert.ok(!names.includes("rosterout") && !r.text.includes("Gone Guy"), JSON.stringify(names));
  assert.deepEqual(names.filter((x) => x === "someone").length, 1, "only the incognito one is 'someone': " + JSON.stringify(names));
  assert.deepEqual(r.d.mic || [], [], "the left-out mic holder isn't on the mic card either");
  await bridge.ingest({ rooms: [snap()], events: [] });
});

test("decision 15: the retention purge deletes nothing before chatlog.archive was first switched on (why not_started), then may", async () => {
  await setup;
  assert.deepEqual([preMode.mode, preMode.why], ["report", "not_started"]);
  assert.ok(CL.cfg().started_at > 0);
  const m = await CLP.modeNow();
  assert.notEqual(m.why, "not_started");
});
