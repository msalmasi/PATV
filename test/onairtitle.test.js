// Offline tests for 1.99akr onairtitle: Pepe is told WHAT is on his main stream, not just its kind. The owner (2026-11-05):
// "pepe still doesn't know what youtube is playing on his cam for onair" - a pasted YouTube link reached Pepe as only
// "🔗 YouTube video". onairtitle.js (the oEmbed lookup: once per video, in the background, cached, a miss remembered, a
// timeout = nothing; untrusted text cleaned) + onair.js botTarget's new fields (title / author / embed {p, t} / source /
// picker / owner / next) + the OBS player's own report + the !onair status line + plexchat's np answer.
//   node --test test/onairtitle.test.js      (needs the repo's node_modules; uses a temp DB; never goes to the network)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "onairtitle-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "mainstage"));
const rooms = require(path.join(repo, "rooms"));
const PA = require(path.join(repo, "padaccess"));
const LC = require(path.join(repo, "livecam"));
const OA = require(path.join(repo, "onair"));
const OT = require(path.join(repo, "onairtitle"));
const OQ = require(path.join(repo, "onairqueue"));
const stories = require(path.join(repo, "stories"));

let T = 1_800_000_000_000;
S._setClock(() => T);
OA._setClock(() => T);
OQ._setClock(() => T);
OT._setClock(() => T);
rooms.notify = async () => true;
// private activity = the profile's analytics / an_rooms hidden (onair.privateAccount reads profilelayout by account id)
let PRIVATE = new Set();          // account ids with private activity
const PL = require(path.join(repo, "profilelayout"));
PL.get = async (userId) => {
  if (userId === "THROW") throw new Error("layout store down");
  return { order: [], hidden: PRIVATE.has(String(userId)) ? ["analytics"] : [], priv: [], pub: [] };
};
stories.privateLogins = async () => { throw new Error("onair.pickerOf no longer asks stories.privateLogins"); };

// a fake oEmbed: {url -> answer}; calls counted; an answer can be a function (to hang / throw)
let calls = [];
let ANSWERS = {};
OT._setFetch(async (url) => {
  calls.push(url);
  const a = ANSWERS[url];
  return typeof a === "function" ? a() : a == null ? null : a;
});
const YT = (id) => OT.oembedUrl({ p: "youtube", t: "video", id });
const settle = () => new Promise((r) => setImmediate(r));
const VID = "dQw4w9WgXcQ", VID2 = "aaaaaaaaaaa", VID3 = "bbbbbbbbbbb";

let n = 0;
async function mkUser(cf, username) {
  const id = "u" + (++n);
  await runQuery("INSERT INTO users (userId, username, displayname, password, points_balance, camfrogUsername) VALUES (?, ?, ?, 'x', 0, ?)",
    [id, username || "streamer" + n, "Streamer " + n, cf || null]);
  return { userId: id, username: username || "streamer" + n, displayname: "Streamer " + n };
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await S.init();
  await S.setConfig({ min_minutes: 2, max_minutes: 60, max_concurrent: 6, bookings_per_hour: 100, enabled: true }, "test");
  await rooms.setStage(rooms.HOUSE_ROOM, { slot_count: 4, slot_price: 0 }, "test", { maxSlots: 4, maxPrice: 0 });
  await PA.init();
  await LC.init();
  await OA.init();
  await OQ.init();
});
test.beforeEach(async () => {
  calls = []; ANSWERS = {}; PRIVATE = new Set();
  OT._reset();
  await OA.saveConfig({ enabled: true, cam_optin: true, allow_library: false }, "test");
});
test.afterEach(async () => {
  await OA.clear("test", "test");
  await OQ.cancel("all", "test");
  for (const s of await getQuery("SELECT id FROM stage_slots WHERE status != 'ended'")) await S.end(s.id, "test_cleanup", "test");
});

test("clean: one line, no controls / bidi / invisible / markup / links, capped", () => {
  assert.equal(OT.clean("Lofi\u0007 beats\n\nto <b>study</b> to‮​ https://evil.example/x?k=1 www.evil.example"), "Lofi beats to study to");
  assert.equal(OT.clean("x".repeat(300)).length, OT.TITLE_MAX);
  assert.ok(OT.clean("x".repeat(300)).endsWith("…"));
  assert.equal(OT.clean({ title: "obj" }), "");
  assert.equal(OT.clean(null), "");
  assert.deepEqual(OT.fromPlayer({ title: "  Live ⁦now⁩ ", author: "Chan<script>" }), { title: "Live now", author: "Chan" });
  assert.equal(OT.fromPlayer({ title: "" }), null);
});

test("lookup: once per video, cached, a miss remembered for a while, a hang / throw = nothing, channels and Twitch never asked", async () => {
  ANSWERS[YT(VID)] = { title: "Never Gonna Give You Up", author_name: "Rick Astley", html: "<iframe src=x>" };
  const e = { p: "youtube", t: "video", id: VID };
  assert.equal(OT.cached(e), null);
  const [a, b] = await Promise.all([OT.lookup(e), OT.lookup(e)]);
  assert.deepEqual(a, { title: "Never Gonna Give You Up", author: "Rick Astley" });
  assert.deepEqual(b, a);
  assert.equal(calls.length, 1, "two at once = one request");
  assert.deepEqual(OT.peek(e), a);
  assert.equal(calls.length, 1, "cached: no request");
  // a "live" link is the same video address
  assert.equal(OT.oembedUrl({ p: "youtube", t: "live", id: VID }), YT(VID));
  // a miss is remembered (no hammering), and asked again after MISS_MS
  const m = { p: "youtube", t: "video", id: VID2 };
  assert.equal(await OT.lookup(m), null);
  assert.equal(await OT.lookup(m), null);
  assert.equal(calls.filter((u) => u === YT(VID2)).length, 1);
  T += OT.MISS_MS + 1;
  ANSWERS[YT(VID2)] = { title: "Back again" };
  assert.deepEqual(await OT.lookup(m), { title: "Back again", author: null });
  // a throw / a hang: null, and the pick never waited on it
  ANSWERS[YT(VID3)] = () => { throw new Error("ECONNRESET"); };
  assert.equal(await OT.lookup({ p: "youtube", t: "video", id: VID3 }), null);
  // a channel's live stream and Twitch: no keyless oEmbed - never asked
  const before = calls.length;
  assert.equal(await OT.lookup({ p: "youtube", t: "channel", id: "UC" + "a".repeat(22) }), null);
  assert.equal(await OT.lookup({ p: "twitch", t: "channel", id: "somechannel" }), null);
  assert.equal(await OT.lookup({ p: "evil", t: "video", id: "x" }), null);
  assert.equal(calls.length, before);
  // the cache holds at most CACHE_MAX videos
  for (let i = 0; i < OT.CACHE_MAX + 20; i++) {
    const id = ("v" + i).padEnd(11, "x");
    ANSWERS[YT(id)] = { title: "t" + i };
    await OT.lookup({ p: "youtube", t: "video", id });
  }
  assert.equal(OT.cached({ p: "youtube", t: "video", id: "v0".padEnd(11, "x") }), null, "the oldest went");
  assert.ok(OT.cached({ p: "youtube", t: "video", id: ("v" + (OT.CACHE_MAX + 19)).padEnd(11, "x") }));
});

test("a hanging oEmbed never holds a pick: setEmbed returns at once; the title arrives on a later poll", async () => {
  let release;
  ANSWERS[YT(VID)] = () => new Promise((r) => { release = () => r({ title: "Slow Title", author_name: "Slow Chan" }); });
  const t0 = Date.now();
  const r = await OA.botCommand({ by: "PlantBaked", admin: true, action: "set", query: `https://youtu.be/${VID} rights` });
  assert.equal(r.ok, true, r.msg);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(r.msg, "On Pepe's main stream: 🔗 YouTube video", "no title yet - the label as before");
  let tgt = (await OA.forBot({})).target;
  assert.equal(tgt.title, undefined);
  assert.equal(tgt.label, "🔗 YouTube video");
  release();
  await settle(); await settle();
  tgt = (await OA.forBot({})).target;
  assert.equal(tgt.title, "Slow Title");
  assert.equal(tgt.author, "Slow Chan");
});

test("the owner's case: a pasted YouTube link reaches Pepe with its title, channel, kind, picker and start - never the link or the video id", async () => {
  ANSWERS[YT(VID)] = { title: "Cozy Fireplace 4K", author_name: "Fireplace Channel" };
  T += 1000;
  await OA.botCommand({ by: "PlantBaked", admin: true, action: "set", query: `https://www.youtube.com/watch?v=${VID}&t=42 rights` });
  await settle(); await settle();
  const tgt = (await OA.forBot({})).target;
  assert.equal(tgt.kind, "embed");
  assert.equal(tgt.title, "Cozy Fireplace 4K");
  assert.equal(tgt.author, "Fireplace Channel");
  assert.deepEqual(tgt.embed, { p: "youtube", t: "video" }, "no id");
  assert.equal(tgt.source, "link");
  assert.deepEqual(tgt.picker, { via: "chat", login: "plantbaked", name: "PlantBaked" });
  assert.equal(tgt.since, T);
  const wire = JSON.stringify(tgt);
  assert.ok(!wire.includes(VID), "the video id never goes out");
  assert.ok(!/youtube\.com|youtu\.be/.test(wire), "nor the pasted link");
  assert.match(tgt.url, /\/onair\/player\?t=/, "the url is still the site's own player page");
  // the !onair status line and the next !onair <link> reply name it too
  assert.match((await OA.botCommand({ by: "boss", admin: true, action: "status" })).msg, /On Pepe's main stream: 🔗 YouTube video "Cozy Fireplace 4K" \(since/);
  assert.equal((await OA.botCommand({ by: "boss", admin: true, action: "set", query: `https://youtu.be/${VID} rights` })).msg,
    "On Pepe's main stream: 🔗 YouTube video \"Cozy Fireplace 4K\"", "cached: named at once");
});

test("the OBS player's own report fills the title when oEmbed has none (a channel's live stream), cleaned", async () => {
  const ch = "UC" + "b".repeat(22);
  await OA.botCommand({ by: "boss", admin: true, action: "set", query: `https://www.youtube.com/channel/${ch}/live rights` });
  let tgt = (await OA.forBot({})).target;
  assert.equal(tgt.title, undefined);
  assert.deepEqual(tgt.embed, { p: "youtube", t: "channel" });
  const tok = decodeURIComponent(tgt.url.split("t=")[1]);
  assert.deepEqual(OA.embedState(tok, "playing", "", { title: "24/7 Lofi Radio‮ <i>live</i>", author: "Lofi\u0000 Girl" }), { on: true });
  tgt = (await OA.forBot({})).target;
  assert.equal(tgt.title, "24/7 Lofi Radio live");
  assert.equal(tgt.author, "Lofi Girl");
  assert.equal(calls.length, 0, "a channel is never looked up");
  // a stale token can't set anything
  assert.deepEqual(OA.embedState(tok.slice(0, -2) + "xx", "playing", "", { title: "forged" }), { on: false });
  assert.equal((await OA.forBot({})).target.title, "24/7 Lofi Radio live");
});

test("picker: a web picker's linked chat login (Pepe checks it), private activity = hidden, a ⏰ row = via queue, the system = none", async () => {
  const boss = await mkUser("bossCF", "bossweb");
  const alice = await mkUser("Alice", "alicesite");
  const carol = await mkUser("carol", "carolsite");
  assert.deepEqual(await OA.pickerOf("web:bossweb"), { via: "web", login: "bosscf", name: "bossweb" });
  assert.deepEqual(await OA.pickerOf("queue:pepe:Alice"), { via: "queue", login: "alice", name: "Alice" });
  assert.deepEqual(await OA.pickerOf("queue:web:bossweb"), { via: "queue", login: "bosscf", name: "bossweb" });
  assert.deepEqual(await OA.pickerOf("pepe:nositeacct"), { via: "chat", login: "nositeacct", name: "nositeacct" },
    "a chat login with no site account: named here (Pepe's own veils apply on his side)");
  assert.equal(await OA.pickerOf("system"), null);
  assert.equal(await OA.pickerOf("web:?"), null);
  PRIVATE = new Set([boss.userId, alice.userId]);
  assert.deepEqual(await OA.pickerOf("web:bossweb"), { via: "web", hidden: true });
  assert.deepEqual(await OA.pickerOf("pepe:alice"), { via: "chat", hidden: true });
  // on a live pick: re-checked within a minute (going private after the pick hides them too)
  PRIVATE = new Set();
  await OA.botCommand({ by: "carol", admin: true, action: "set", query: `https://youtu.be/${VID} rights` });
  assert.equal((await OA.forBot({})).target.picker.login, "carol");
  PRIVATE = new Set([carol.userId]);
  assert.equal((await OA.forBot({})).target.picker.login, "carol", "cached for a minute");
  T += 61 * 1000;
  assert.deepEqual((await OA.forBot({})).target.picker, { via: "chat", hidden: true });
});

test("review safety 3: a web-only picker (no Camfrog name) with private activity is hidden; a lookup that fails = hidden", async () => {
  const w = await mkUser(null, "privstaffer");
  assert.deepEqual(await OA.pickerOf("web:privstaffer"), { via: "web", login: null, name: "privstaffer" }, "public: named");
  PRIVATE = new Set([w.userId]);
  assert.deepEqual(await OA.pickerOf("web:PrivStaffer"), { via: "web", hidden: true });
  assert.deepEqual(await OA.pickerOf("queue:web:PrivStaffer"), { via: "queue", hidden: true });
  PRIVATE = new Set();
  assert.deepEqual(await OA.pickerOf("web:nosuchaccount"), { via: "web", hidden: true }, "an account we can't find is never named");
  // the layout store failing / the users table failing: hidden (it used to name them)
  await runQuery("INSERT INTO users (userId, username, displayname, password, points_balance, camfrogUsername) VALUES ('THROW', 'throwy', 'T', 'x', 0, 'throwcf')");
  assert.deepEqual(await OA.pickerOf("web:throwy"), { via: "web", hidden: true });
  assert.deepEqual(await OA.pickerOf("pepe:throwcf"), { via: "chat", hidden: true });
  await runQuery("ALTER TABLE users RENAME TO users_away");
  try {
    assert.deepEqual(await OA.pickerOf("web:privstaffer"), { via: "web", hidden: true });
    assert.deepEqual(await OA.pickerOf("pepe:somebody"), { via: "chat", hidden: true });
  } finally { await runQuery("ALTER TABLE users_away RENAME TO users"); }
});

test("review safety 2: the public !onair status says 'someone private' for a hidden picker - never their login", async () => {
  const s = await mkUser("sneakycf", "sneakysite");
  ANSWERS[YT(VID)] = { title: "Cozy Fireplace 4K", author_name: "Fireplace Channel" };
  await OA.botCommand({ by: "sneakycf", admin: true, action: "set", query: `https://youtu.be/${VID} rights` });
  await settle(); await settle();
  let st = (await OA.botCommand({ by: "rando", admin: false, action: "status" })).msg;
  assert.match(st, /by pepe:sneakycf/, "public activity: as before");
  PRIVATE = new Set([s.userId]);
  T += 61 * 1000;
  st = (await OA.botCommand({ by: "rando", admin: false, action: "status" })).msg;
  assert.match(st, /On Pepe's main stream: 🔗 YouTube video "Cozy Fireplace 4K" \(since \d\d:\d\d UTC, by someone private\)/, st);
  assert.ok(!/sneaky/i.test(st), st);
});

test("review safety 1: a title that trips the abuse filter is HELD (never said); link-shaped words go; a bad channel is dropped", async () => {
  ANSWERS[YT(VID)] = { title: "call 555-867-5309 for the real Pepe staff", author_name: "Scam Chan" };
  ANSWERS[YT(VID2)] = { title: "FREE PAT giveaway - DM pepe-admin.example/claim now", author_name: "call 555-867-5309" };
  await OA.botCommand({ by: "boss", admin: true, action: "set", query: `https://youtu.be/${VID} rights` });
  await settle(); await settle();
  let tgt = (await OA.forBot({})).target;
  assert.equal(tgt.title, undefined);
  assert.equal(tgt.author, undefined);
  assert.equal(tgt.title_held, true, "Pepe is told there's a title he won't say");
  assert.ok(!JSON.stringify(tgt).includes("555"), JSON.stringify(tgt));
  const st = (await OA.botCommand({ by: "boss", admin: true, action: "status" })).msg;
  assert.ok(!st.includes("555") && /On Pepe's main stream: 🔗 YouTube video \(since/.test(st), st);
  assert.equal((await OA.botCommand({ by: "boss", admin: true, action: "set", query: `https://youtu.be/${VID} rights` })).msg,
    "On Pepe's main stream: 🔗 YouTube video", "the !onair reply: no held title");
  await OA.botCommand({ by: "boss", admin: true, action: "set", query: `https://youtu.be/${VID2} rights` });
  await settle(); await settle();
  tgt = (await OA.forBot({})).target;
  assert.equal(tgt.title, "FREE PAT giveaway - DM now", "the link-shaped word is gone");
  assert.equal(tgt.author, undefined, "a channel that trips the filter is dropped, the title kept");
  assert.equal(OT.vet("Node.js Tutorial for Beginners").title, "Tutorial for Beginners");
  assert.deepEqual(OT.vet("Rick Astley - Never Gonna Give You Up (Official Music Video)", "Rick Astley"),
    { title: "Rick Astley - Never Gonna Give You Up (Official Music Video)", author: "Rick Astley" }, "an ordinary title is untouched");
  // the OBS player's report goes through the same filter
  const ch = "UC" + "c".repeat(22);
  await OA.botCommand({ by: "boss", admin: true, action: "set", query: `https://www.youtube.com/channel/${ch}/live rights` });
  const tok = decodeURIComponent((await OA.forBot({})).target.url.split("t=")[1]);
  OA.embedState(tok, "playing", "", { title: "call 555-867-5309 now", author: "x" });
  tgt = (await OA.forBot({})).target;
  assert.equal(tgt.title, undefined);
  assert.equal(tgt.title_held, true);
  // the filter failing = held (fail closed)
  const OM = require(path.join(repo, "onairmedia"));
  const orig = OM.textBad;
  OM.textBad = () => { throw new Error("lists missing"); };
  try { assert.deepEqual(OT.vet("Anything at all"), { held: true }); } finally { OM.textBad = orig; }
});

test("review safety 1: a stage slot's own title is vetted too; a 📼 library title is the library's", async () => {
  const u = await mkUser("bobcf");
  const b = await S.book(u, { minutes: 30, title: "call 555-867-5309 for the real Pepe staff" });
  await S.rtmpCallback({ call: "publish", app: "stage", name: b.key, addr: "1.2.3.4", clientid: "c-held" });
  await OA.setSlot(b.slot.id, "web:boss", {});
  const tgt = (await OA.forBot({})).target;
  assert.equal(tgt.title, undefined);
  assert.equal(tgt.title_held, true);
});

test("review function 1: 'next' is what plays when this ends - the oldest next-up row, not a booking days away; a booking alone has its New York time", async () => {
  ANSWERS[YT(VID2)] = { title: "Queued Next Video" };
  ANSWERS[YT(VID3)] = { title: "Booked Far Away" };
  await OA.botCommand({ by: "boss", admin: true, action: "set", query: `https://youtu.be/${VID} rights` });
  const far = T + 3 * 24 * 3600 * 1000;
  await OQ.add({ url: `https://youtu.be/${VID3}`, at: far, by: "pepe:boss" });
  await OQ.add({ url: `https://youtu.be/${VID2}`, at: null, by: "pepe:boss" });
  await OA.forBot({});
  await settle(); await settle();
  let nx = (await OA.forBot({})).target.next;
  assert.deepEqual(nx, { label: "🔗 YouTube video", title: "Queued Next Video" }, JSON.stringify(nx));
  await OQ.cancel("all", "test");
  await OQ.add({ url: `https://youtu.be/${VID3}`, at: far, by: "pepe:boss" });
  await OA.forBot({});
  await settle(); await settle();
  nx = (await OA.forBot({})).target.next;
  assert.equal(nx.title, "Booked Far Away");
  assert.equal(nx.at, far);
  assert.equal(nx.when, OQ.fmt(far));
  assert.match(nx.when, /^[A-Z][a-z]{2} \d{1,2}:\d{2} [AP]M ET$/, nx.when);
});

test("review function 2: who picked it / the streamer's login / the player's report never land on TARGET (staff view, onair_state)", async () => {
  await mkUser("bossCF2", "bossweb2");
  const u = await mkUser("alicecf2");
  const b = await S.book(u, { minutes: 30, title: "Alice's hour" });
  await S.rtmpCallback({ call: "publish", app: "stage", name: b.key, addr: "1.2.3.4", clientid: "c-view" });
  await OA.setSlot(b.slot.id, "web:bossweb2", {});
  const tgt = (await OA.forBot({})).target;
  assert.equal(tgt.picker.login, "bosscf2", "Pepe still gets it");
  assert.equal(tgt.owner.login, "alicecf2");
  for (const v of [OA.view(), await OA.adminView()]) {
    const w = JSON.stringify(v);
    assert.ok(!w.includes("bosscf2") && !w.includes("alicecf2") && !/"picker"|"picker_at"|"owner_login"|"player_meta"/.test(w), w.slice(0, 400));
  }
  const saved = (await getQuery("SELECT * FROM onair_state"))[0] || {};
  const sw = JSON.stringify(saved);
  assert.ok(!sw.includes("bosscf2") && !sw.includes("alicecf2") && !/picker|owner_login|player_meta/.test(sw), sw.slice(0, 400));
});

test("review function 5: a Go Live pick's 'since' is when its stream came up, not when it was picked", async () => {
  const u = await mkUser("golivecf");
  const g = await OA.setGoLive({ ...u, class: "Staff" }, "web:" + u.username, { minutes: 60, title: "Late show" });
  const picked = T;
  T += 4 * 60 * 1000;                                     // OBS being set up
  await OA.check();
  assert.equal((await OA.forBot({})).target, null);
  assert.equal((await S.rtmpCallback({ call: "publish", app: "stage", name: g.rtmp.key, addr: "1.2.3.4", clientid: "c-golive" })).status, 302);
  const wentLive = T;
  await OA.check();
  T += 1000;
  const tgt = (await OA.forBot({})).target;
  assert.equal(tgt.source, "golive");
  assert.equal(tgt.title, "Late show");
  assert.equal(tgt.since, wentLive);
  assert.notEqual(tgt.since, picked);
});

test("next: the main lane's next ⏰ row - label + cached title + time, never its link or who queued it", async () => {
  ANSWERS[YT(VID2)] = { title: "Up Next Video", author_name: "Someone" };
  await OA.botCommand({ by: "boss", admin: true, action: "set", query: `https://youtu.be/${VID} rights` });
  const q = await OA.botCommand({ by: "queuer", admin: true, action: "queue", query: `https://youtu.be/${VID2} rights` });
  assert.equal(q.ok, true, q.msg);
  let tgt = (await OA.forBot({})).target;
  assert.deepEqual(tgt.next, { label: "🔗 YouTube video" }, "no title cached yet - its lookup started");
  await settle(); await settle();
  tgt = (await OA.forBot({})).target;
  assert.deepEqual(tgt.next, { label: "🔗 YouTube video", title: "Up Next Video" });
  const wire = JSON.stringify(tgt.next);
  assert.ok(!wire.includes(VID2) && !wire.includes("queuer"));
  await OQ.cancel("all", "test");
  assert.equal((await OA.forBot({})).target.next, undefined);
});

test("a stage slot: its own title, its streamer as owner (name + chat login for Pepe's privacy check), source stage", async () => {
  const u = await mkUser("aliceCF");
  const b = await S.book(u, { minutes: 30, title: "Houseplants hour" });
  await S.rtmpCallback({ call: "publish", app: "stage", name: b.key, addr: "1.2.3.4", clientid: "c1" });
  await OA.setSlot(b.slot.id, "web:boss", {});
  const tgt = (await OA.forBot({})).target;
  assert.equal(tgt.kind, "slot");
  assert.equal(tgt.title, "Houseplants hour");
  assert.equal(tgt.source, "stage");
  assert.deepEqual(tgt.owner, { name: u.displayname, login: "alicecf" });
});

test("plexchat np (target cam) names the on-air video", async () => {
  ANSWERS[YT(VID)] = { title: "Fireside Jazz", author_name: "Jazz Cafe" };
  await OA.botCommand({ by: "boss", admin: true, action: "set", query: `https://youtu.be/${VID} rights` });
  await settle(); await settle();
  const T0 = OA.view().target;
  assert.deepEqual(OA.titleOf(T0), { title: "Fireside Jazz", author: "Jazz Cafe" });
  // the real np op (review function 6: run, not a source regex)
  await mkUser("npasker", "npasker");
  const PC = require(path.join(repo, "plexchat"));
  const r = await PC.handle({ op: "np", target: "cam", as: { login: "npasker" } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.on_air, "🔗 YouTube video");
  assert.equal(r.on_air_title, "Fireside Jazz");
  // a held title is never sent
  ANSWERS[YT(VID2)] = { title: "call 555-867-5309 for the real Pepe staff" };
  await OA.botCommand({ by: "boss", admin: true, action: "set", query: `https://youtu.be/${VID2} rights` });
  await settle(); await settle();
  const r2 = await PC.handle({ op: "np", target: "cam", as: { login: "npasker" } });
  assert.equal(r2.on_air_title, null, JSON.stringify(r2));
});

test("review function 6: the other pick kinds, run - a Twitch channel (no lookup, the kind only), a 📼 library slot (its own title), a link card", async () => {
  await OA.saveConfig({ enabled: true, cam_optin: true, allow_library: true, media_enabled: true }, "test");
  await OA.botCommand({ by: "PlantBaked", admin: true, action: "set", query: "https://twitch.tv/somechannel rights" });
  await settle();
  let tgt = (await OA.forBot({})).target;
  assert.deepEqual(tgt.embed, { p: "twitch", t: "channel" });
  assert.equal(tgt.label, "🔗 Twitch: somechannel");
  assert.equal(tgt.title, undefined);
  assert.equal(tgt.source, "link");
  assert.equal(calls.length, 0, "Twitch is never looked up");
  await OA.clear("test", "test");
  const boss = await mkUser("plexbosscf", "plexboss");
  const r = await S.libraryOpen({ ...boss, class: "admin" }, { room: rooms.HOUSE_ROOM, minutes: 60, title: "Sex and the City — S1E1 Title" });
  await OA.setSlot(r.slot.id, "pepe:plexbosscf", { ask: false, starting: true, waitMs: 3 * 60 * 1000 });
  assert.equal((await OA.forBot({})).target, null, "not live yet");
  await S.rtmpCallback({ call: "publish", app: "stage", name: r.key, addr: "1.2.3.4", clientid: "c-plex" });
  tgt = (await OA.forBot({})).target;
  assert.equal(tgt.source, "plex");
  assert.equal(tgt.title, "Sex and the City — S1E1 Title", "a library title is the library's (never held by the chat filter)");
  await OA.clear("test", "test");
  for (const s of await getQuery("SELECT id FROM stage_slots WHERE status != 'ended'")) await S.end(s.id, "test_cleanup", "test");
  await OA.forBot({ caps: ["media", "overlay"], state: { media_ok: true, live_ok: true, top_ok: true } });
  await OA.setMedia({ mode: "card", lane: "main", secs: 30, card: { title: "A Great Article", domain: "example.com", url: "https://example.com/a" } },
    "pepe:PlantBaked", {});
  tgt = (await OA.forBot({ caps: ["media", "overlay"], state: { media_ok: true, live_ok: true, top_ok: true } })).target;
  assert.equal(tgt.kind, "media");
  assert.equal(tgt.mode, "card");
  assert.equal(tgt.title, "A Great Article");
  assert.equal(tgt.source, "media");
  await OA.clear("test", "test", { lane: "all" });
});
