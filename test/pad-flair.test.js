// 1.99ir: user flair per pad (padflair.js).
//   - cleaning: names, emoji (no letters / markup), colours (strict hex, contrast-guarded)
//   - the owner (and staff) create / edit / delete flairs; strangers can't; names unique per pad; the cap
//   - a mod gives a member a flair (by username or Camfrog name) or takes it off; members pick self-assignable ones,
//     never a mod-only one, and can't swap away a flair a mod gave them
//   - where it shows: the pad's own feed, a post page of a post whose home is the pad (post + comments), the pad page's
//     live chat (linked logins) - never on All, never in another pad
//   - the settings hub's Flair & tags tab, the pad page's "Your flair here" card; an Approved pad's flair stays inside
//   NODE_PATH=G:/PATV/node_modules node --test test/pad-flair.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pad-flair-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const web = require(path.join(repo, "feedweb"));
const PF = require(path.join(repo, "padflair"));
const PA = require(path.join(repo, "padaccess"));
const bridge = require(path.join(repo, "bridge"));
require(path.join(repo, "terms"))._setRequired(false);

const ROOM_B = "plant_based_chatting", ROOM_S = "Secret.Room";
let base, server, slugB;
const U = {};
const users = new Map();

async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, 5, '2026-01-01 00:00:00', 0)`, [id, name, extra.display || name, extra.class || "pleb", name + "cf"]);
  const u = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, u);
  return u;
}
const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {});
async function call(method, url, u, body) {
  const r = await fetch(base + url, { method, headers: H(u), body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, text };
}
const get = (url, u) => call("GET", url, u);
const post = (url, u, body) => call("POST", url, u, body);
let seq = 0;
const ev = (room, type, data) => ({ op: "event", id: "fl-" + (++seq), ts: new Date().toISOString(), type, scope: { platform: "camfrog", room }, data });

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await require(path.join(repo, "media")).ready;
  U.owner = await mkUser("plantowner");
  U.alice = await mkUser("alice", { display: "Alice" });
  U.bob = await mkUser("bob");
  U.admin = await mkUser("siteadmin", { class: "Admin" });
  await rooms.init();
  await rooms.setOwner(ROOM_B, "plantowner", "test");
  await rooms.addRoom(ROOM_S, "Secret", "test");
  await rooms.setOwner(ROOM_S, "plantowner", "test");
  slugB = rooms.getCached(ROOM_B).slug;
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0, comments_per_hour: 1000 }, "test");
  await PA.init();
  await PA.setLevel(U.owner, await rooms.get(ROOM_S), "approved");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; res.locals.ogPath = req.originalUrl.split("?")[0]; next(); });
  require(path.join(repo, "pads")).register(app);
  PA.register(app, { addUser });
  web.register(app, { addUser, isBotToken: (x) => x === "bot" });
  PF.register(app, { addUser });
  require(path.join(repo, "padsettings")).register(app, { addUser });
  bridge.register(app, { addUser, isBotToken: (x) => x === "bot" });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });
test.beforeEach(() => { store._gaps.clear(); PF._clear(); });

test("cleaning: names, emoji, colours", () => {
  assert.equal(PF.cleanName("  Plant   Parent \u202e "), "Plant Parent");
  assert.equal(PF.cleanName("x".repeat(40)).length, PF.NAME_MAX);
  assert.equal(PF.cleanName("!!!"), null);
  assert.equal(PF.cleanEmoji("🌱"), "🌱");
  assert.equal(PF.cleanEmoji("👩‍🌾"), "👩‍🌾", "ZWJ sequences");
  assert.equal(PF.cleanEmoji("🇬🇧"), "🇬🇧", "flags");
  assert.equal(PF.cleanEmoji(""), "");
  assert.equal(PF.cleanEmoji("abc"), null);
  assert.equal(PF.cleanEmoji("<b>"), null);
  assert.equal(PF.cleanEmoji("🌱x"), null);
  assert.equal(PF.cleanColor("#ABC").hex, "#aabbcc");
  assert.equal(PF.cleanColor("red; background:url(x)"), null);
  const dark = PF.cleanColor("#000010");
  assert.notEqual(dark.hex, "#000010", "too dark for the page: lightened");
  assert.match(PF.html({ name: "<x>", color: "#66bb6a", ink: "#111111", emoji: "🌱" }), /^<span class="ufl" style="--fl:#66bb6a;--fli:#111111" title="Pad flair: &lt;x&gt;"><span class="ufl-e" aria-hidden="true">🌱<\/span>&lt;x&gt;<\/span>$/);
});

let F_REG, F_GREEN, F_MOD;
test("the owner and staff manage flairs; strangers can't; names are unique per pad; the audit log records it", async () => {
  let r = await post("/api/pads/" + slugB + "/flair/save", U.alice, { name: "Regular", color: "#ff8a50" });
  assert.equal(r.status, 403);
  r = await post("/api/pads/" + slugB + "/flair/save", null, { name: "Regular" });
  assert.equal(r.status, 401);
  r = await post("/api/pads/" + slugB + "/flair/save", U.owner, { name: "Regular", color: "#ff8a50", emoji: "⭐", self: true });
  assert.equal(r.status, 200, r.text);
  F_REG = r.d.manage.flairs.find((f) => f.name === "Regular");
  assert.equal(F_REG.self, true);
  assert.equal(F_REG.emoji, "⭐");
  r = await post("/api/pads/" + slugB + "/flair/save", U.owner, { name: "regular" });
  assert.equal(r.status, 409, "names are unique (case-insensitive)");
  r = await post("/api/pads/" + slugB + "/flair/save", U.owner, { name: "Bad emoji", emoji: "lol" });
  assert.equal(r.status, 400);
  r = await post("/api/pads/" + slugB + "/flair/save", U.admin, { name: "Green Thumb", color: "#66bb6a", emoji: "🌱", self: 1 });
  assert.equal(r.status, 200, "site staff manage every pad");
  F_GREEN = r.d.manage.flairs.find((f) => f.name === "Green Thumb");
  r = await post("/api/pads/" + slugB + "/flair/save", U.owner, { name: "Mod", color: "#ef5350", emoji: "🛡️" });
  F_MOD = r.d.manage.flairs.find((f) => f.name === "Mod");
  assert.equal(F_MOD.self, false);
  // edit
  r = await post("/api/pads/" + slugB + "/flair/save", U.owner, { id: F_REG.id, name: "Regular", color: "#ffca28", emoji: "⭐", self: true });
  assert.equal(r.d.manage.flairs.find((f) => f.id === F_REG.id).color, "#ffca28");
  r = await post("/api/pads/" + slugB + "/flair/save", U.owner, { id: 99999, name: "Ghost" });
  assert.equal(r.status, 404);
  const ev2 = await getQuery("SELECT * FROM room_events WHERE room_id = ? AND what = 'feed-flair'", [ROOM_B]);
  assert.ok(ev2.length >= 4);
  // no cross-site writes
  const x = await fetch(base + "/api/pads/" + slugB + "/flair/save", { method: "POST", headers: { "content-type": "application/json", "x-test-user": U.owner.userId }, body: "{}" });
  assert.equal(x.status, 403);
});

test("a mod gives / takes off flair; members pick self-assignable ones only, and can't swap a mod-given one", async () => {
  let r = await post("/api/pads/" + slugB + "/flair/assign", U.alice, { user: "bob", flair: F_MOD.id });
  assert.equal(r.status, 403);
  r = await post("/api/pads/" + slugB + "/flair/assign", U.owner, { user: "bobcf", flair: F_MOD.id });
  assert.equal(r.status, 200, "by Camfrog name too: " + r.text);
  assert.equal(r.d.manage.people.find((p) => p.userId === U.bob.userId).flair.name, "Mod");
  r = await post("/api/pads/" + slugB + "/flair/assign", U.owner, { user: "nobody-here", flair: F_MOD.id });
  assert.equal(r.status, 404);
  // bob can't swap the mod's flair away
  r = await post("/api/pads/" + slugB + "/flair/mine", U.bob, { flair: F_GREEN.id });
  assert.equal(r.status, 403);
  assert.match(r.d.error, /A mod gave you/);
  // alice picks a self-assignable one, not the mod-only one
  r = await post("/api/pads/" + slugB + "/flair/mine", U.alice, { flair: F_MOD.id });
  assert.equal(r.status, 403);
  r = await post("/api/pads/" + slugB + "/flair/mine", U.alice, { flair: F_GREEN.id });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.mine.flair.name, "Green Thumb");
  assert.equal(r.d.mine.locked, false);
  r = await post("/api/pads/" + slugB + "/flair/mine", U.alice, { flair: F_REG.id });
  assert.equal(r.d.mine.flair.name, "Regular", "she can switch between self-assignable ones");
  r = await post("/api/pads/" + slugB + "/flair/mine", U.alice, { flair: null });
  assert.equal(r.d.mine.flair, null);
  await post("/api/pads/" + slugB + "/flair/mine", U.alice, { flair: F_GREEN.id });
  // banned from the pad's feed: no picking
  await runQuery("INSERT INTO feed_bans (user_id, room_id, username, reason, by, at, until) VALUES (?, ?, 'carol', 'x', 'test', ?, NULL)", ["u_carol", ROOM_B, Date.now()]);
  U.carol = await mkUser("carol");
  r = await post("/api/pads/" + slugB + "/flair/mine", U.carol, { flair: F_GREEN.id });
  assert.equal(r.status, 403);
  // the GET: everyone who can see the pad gets the list; mods get the manage view
  r = await get("/api/pads/" + slugB + "/flair", null);
  assert.equal(r.status, 200);
  assert.equal(r.d.flairs.length, 3);
  assert.equal(r.d.manage, undefined);
  r = await get("/api/pads/" + slugB + "/flair", U.owner);
  assert.ok(r.d.manage.people.length >= 2);
});

let POST;
test("it shows next to the name in the pad's feed, on its posts' pages (post + comments) - not on All, not in another pad", async () => {
  POST = await store.create(U.alice.userId, { community: ROOM_B, title: "Flair test post", body: "hello" });
  await store.comment(U.bob, POST.id, { body: "nice one" });
  const other = await store.create(U.alice.userId, { community: "patv:lounge", title: "Lounge post by alice" });
  const chip = /<span class="ufl" style="--fl:#[0-9a-f]{6};--fli:#[0-9a-f]{6}" title="Pad flair: Green Thumb"><span class="ufl-e" aria-hidden="true">🌱<\/span>Green Thumb<\/span>/;
  let r = await get("/p/" + slugB, U.alice);
  assert.equal(r.status, 200);
  assert.match(r.text, chip, "the pad's own feed");
  r = await get(POST.url, null);
  assert.equal(r.status, 200);
  assert.match(r.text, chip, "the post page (home pad)");
  assert.match(r.text, /title="Pad flair: Mod">/, "bob's comment carries his flair");
  r = await get("/feed", U.alice);
  assert.doesNotMatch(r.text, /class="ufl"/, "never on All");
  r = await get(other.url, null);
  assert.doesNotMatch(r.text, /class="ufl"/, "not on a post in another pad");
  // "Your flair here" on the pad page
  r = await get("/p/" + slugB, U.alice);
  assert.match(r.text, /data-pfl="/);
  assert.match(r.text, /<option value="\d+" selected>🌱 Green Thumb<\/option>/);
  r = await get("/p/" + slugB, U.bob);
  assert.match(r.text, /given by a mod/);
  assert.doesNotMatch(r.text, /data-pfl-pick/);
});

test("the live chat on the pad page carries the flair of linked logins", async () => {
  const room = { id: ROOM_B, name: ROOM_B };
  await bridge.ingest({
    events: [ev(room, "message", { user: { id: "alicecf", login: "alicecf", display: "Ali" }, text: "hi from cam" }),
             ev(room, "message", { user: { id: "strangercf", login: "strangercf", display: "Stranger" }, text: "who dis" })],
    rooms: [{ room, topic: "t", count: 3, members: [{ id: "alicecf", login: "alicecf", display: "Ali" }, { id: "strangercf", login: "strangercf", display: "Stranger" }], mic: [] }],
  });
  const r = await get("/api/rooms/" + slugB + "/live", U.bob);
  assert.equal(r.status, 200, r.text);
  const line = r.d.feed.find((it) => it.text === "hi from cam");
  assert.ok(line && line.u && line.u.patv, JSON.stringify(r.d.feed));
  assert.deepEqual(line.u.patv.flair && line.u.patv.flair.name, "Green Thumb");
  assert.match(line.u.patv.flair.color, /^#[0-9a-f]{6}$/);
  const other = r.d.feed.find((it) => it.text === "who dis");
  assert.ok(!(other.u.patv && other.u.patv.flair));
  const html = (await get("/p/" + slugB, U.bob)).text;
  assert.match(html, /function flairEl\(u\)/, "the chat renderer draws it");
});

test("the settings hub has the Flair & tags tab; deleting a flair takes it off everyone; an Approved pad's flair stays inside", async () => {
  let r = await get("/p/" + slugB + "/settings", U.owner);
  assert.equal(r.status, 200);
  assert.match(r.text, /data-tab="flair"/);
  assert.match(r.text, /id="flairMgr" data-slug="/);
  assert.match(r.text, /pad-flair\.js\?v=1/);
  r = await get("/p/" + slugB + "/settings?tab=flair", U.owner);
  assert.match(r.text, /data-tab="flair"/);
  r = await post("/api/pads/" + slugB + "/flair/delete", U.alice, { id: F_GREEN.id });
  assert.equal(r.status, 403);
  r = await post("/api/pads/" + slugB + "/flair/delete", U.owner, { id: F_GREEN.id });
  assert.equal(r.status, 200);
  assert.equal((await PF.of(ROOM_B, U.alice.userId)), null);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pad_user_flairs WHERE flair_id = ?", [F_GREEN.id]))[0].n, 0);
  // Approved pad
  const slugS = rooms.getCached(ROOM_S).slug;
  await PF.save(U.owner, ROOM_S, { name: "Insider", self: true });
  r = await get("/api/pads/" + slugS + "/flair", U.alice);
  assert.equal(r.status, 404, "outsiders don't see an Approved pad's flair");
  const f = (await PF.list(ROOM_S))[0];
  r = await post("/api/pads/" + slugS + "/flair/mine", U.alice, { flair: f.id });
  assert.equal(r.status, 404);
  r = await get("/api/pads/" + slugS + "/flair", U.owner);
  assert.equal(r.status, 200);
  // profile pads have none
  await assert.rejects(PF.save(U.admin, "user:u_alice", { name: "Nope" }), /Profiles don't have flair/);
});
