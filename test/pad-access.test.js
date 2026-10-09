// Offline tests for 1.99fu pad visibility (padaccess.js) and 💸 Tip from the pad's user lists.
//
// THE ACCESS MATRIX: three pads - Public, Members (the default, = what every pad did before), Approved - each with a post
// (picture attached), a capture (+ poster), a live Camfrog room (chat line, people, mic), analytics and a stage slot, seen by
// five viewers - signed out, a signed-in member, an approved member, the owner, a site admin - through every content path:
//   pad page + tabs (hop / submit / audio / analytics) · the bridge chat API · feeds (All, Following, a pad, a profile) ·
//   post pages (short + canonical URLs) · stories (strip, /api/stories, pad strip opening for visitors) · Hop, gallery
//   (media-only lists), search (the pads list) · media files (/media/f, /media/<id>, /raw, /poster) · the stage (/api/stage,
//   /api/rooms/<slug>/stage, MediaMTX read auth + tokens) · /p, Trending, Top Pads, the homepage front pick and stories ·
//   og tags of the locked card · DM post cards · follows, votes, comments, crossposts, posting into the pad.
// Plus the request / approve / deny / remove flow, the defaults, and the tip menu gating + routing.
//   NODE_PATH=G:/PATV/node_modules node --test test/pad-access.test.js      (temp DB, temp media dirs)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "padaccess-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const fmedia = require(path.join(repo, "feedmedia"));
require(path.join(repo, "terms"))._setRequired(false);
const PA = require(path.join(repo, "padaccess"));
const bridge = require(path.join(repo, "bridge"));
const stories = require(path.join(repo, "stories"));
const S = require(path.join(repo, "mainstage"));
const W = require(path.join(repo, "webrtc"));
const home = require(path.join(repo, "home"));

// ── the three pads ──
const PUB = "pub.Room", MEM = "mem.Room", APP = "app.Room";
const PADS = {
  public: { id: PUB, slug: "pub-room", title: "Open Pond", post: "OPENPOST public pond news", chat: "CHAT-in-the-open", stream: "stage-0000000000000001" },
  members: { id: MEM, slug: "mem-room", title: "Member Lounge", post: "MEMBERPOST lounge news", chat: "CHAT-in-the-lounge", stream: "stage-0000000000000002" },
  approved: { id: APP, slug: "app-room", title: "Secret Garden", post: "SECRETPOST garden news", chat: "CHAT-in-the-garden", stream: "stage-0000000000000003" },
};
const LEVELS = Object.keys(PADS);

// ── the viewers ──
const users = new Map();
const U = {};
async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, 5, '2026-01-01 00:00:00', 0)`, [id, name, extra.display || name, extra.class || "pleb", extra.camfrog || null]);
  const u = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, u);
  return u;
}
const VIEWERS = ["anon", "member", "approved", "owner", "admin"];
const who = (v) => (v === "anon" ? null : U[v]);
const sees = (level, v) => level !== "approved" || ["approved", "owner", "admin"].includes(v);
const full = (level, v) => (level === "public" ? true : level === "members" ? v !== "anon" : sees(level, v));

let base, server;
const H = (u, extra = {}) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {}, extra);
async function call(method, url, u, body, headers) {
  const r = await fetch(base + url, { method, headers: headers || H(u), body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, text, r };
}
const get = (url, u) => call("GET", url, u);
const post = (url, u, body, headers) => call("POST", url, u, body, headers);

const POSTS = {}, FILES = {}, CAPS = {};
let jpg;
let seq = 0;
const ev = (room, type, data) => ({ op: "event", id: "pa-" + (++seq), ts: new Date().toISOString(), type, scope: { platform: "camfrog", room }, data });

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  await require(path.join(repo, "media")).ready;
  await require(path.join(repo, "inbox")).ready;
  jpg = await require("sharp")({ create: { width: 8, height: 8, channels: 3, background: "#0a0" } }).jpeg().toBuffer();
  U.owner = await mkUser("padowner", { camfrog: "ownercf" });
  U.admin = await mkUser("siteadmin", { class: "Admin", camfrog: "admincf" });
  U.member = await mkUser("plainmember", { camfrog: "membercf" });
  U.approved = await mkUser("invitee", { camfrog: "inviteecf" });
  U.asker = await mkUser("asker");
  U.alice = await mkUser("alice", { camfrog: "alicecf", display: "Alice" });
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('pepe-bot', 'pepe', 'Pepe', 'x', 'pepefrog')");
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('u_cfauto', 'CFa1b2c3d4', 'CFa1b2c3d4', 'x', 'alicecf')");
  await rooms.init();
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0 }, "test");
  for (const lv of LEVELS) {
    const P = PADS[lv];
    await rooms.addRoom(P.id, P.title, "test");
    await rooms.setOwner(P.id, "padowner", "test");
  }
  await PA.init();
  // existing pads default to Members until the owner changes it
  for (const lv of LEVELS) assert.equal(PA.levelOf(PADS[lv].id), "members");
  await PA.setLevel(U.owner, await rooms.get(PUB), "public");
  await PA.setLevel(U.owner, await rooms.get(APP), "approved");
  await PA.request(U.approved, await rooms.get(APP), "hi, it's me");
  await PA.decide(U.owner, await rooms.get(APP), U.approved.userId, true);
  // posts (each with a picture), captures (+ a clip with a poster), live rooms, analytics
  fmedia._setDir(process.env.FEED_DIR);
  let n = 0;
  for (const lv of LEVELS) {
    const P = PADS[lv];
    const made = await store.create(U.owner.userId, { community: P.id, title: P.post, body: "body of " + lv });
    POSTS[lv] = made;
    const file = (++n).toString(16).padStart(32, "a") + ".webp";
    fs.mkdirSync(path.join(process.env.FEED_DIR, file.slice(0, 2)), { recursive: true });
    fs.writeFileSync(path.join(process.env.FEED_DIR, file.slice(0, 2), file), jpg);
    await runQuery(`INSERT INTO feed_attachments (id, post_id, owner_id, kind, ct, file, thumb, w, h, bytes, sort, state, created)
                    VALUES (?, ?, ?, 'image', 'image/webp', ?, ?, 8, 8, 10, 0, 'ready', ?)`, ["att" + n, made.id, U.owner.userId, file, file, Date.now()]);
    FILES[lv] = file;
    const cap = "c0ffee0" + n + "a1b2c3d4";
    const t = Date.now() - 5 * 60e3;
    await runQuery(`INSERT INTO media (id, kind, ct, file, bytes, secs, subject, by_user, room, created, expires, deleted, anon)
                    VALUES (?, 'clip', 'video/mp4', ?, 10, 5, 'alicecf', 'pepefan', ?, ?, ?, 0, 0)`, [cap, cap + ".mp4", P.id, t, t + 24 * 3600e3]);
    fs.writeFileSync(path.join(process.env.MEDIA_DIR, cap + ".mp4"), jpg);
    fs.writeFileSync(path.join(process.env.MEDIA_DIR, cap + "_p.webp"), jpg);
    CAPS[lv] = cap;
    const room = { id: P.id, name: P.id };
    await bridge.ingest({
      events: [ev(room, "message", { user: { id: "alicecf", login: "alicecf", display: "Alice" }, text: P.chat })],
      rooms: [{ room, topic: "TOPIC-" + lv, count: 5,
                members: [{ id: "pepefrog", login: "pepefrog", display: "Pepe", is_self: true }, { id: "alicecf", login: "alicecf", display: "Alice" },
                          { id: "strangercf", login: "strangercf", display: "Stranger" }, { id: "membercf", login: "membercf", display: "Me" },
                          { anonymous: true }, { id: "botcf", login: "botcf", display: "SomeBot", is_bot: true }],
                mic: [{ id: "alicecf", login: "alicecf", display: "Alice" }, { id: "strangercf", login: "strangercf", display: "Stranger" }] }],
    });
  }
  const app = express();
  app.use((req, res, next) => (req.path === "/api/roomstats/sync" ? next() : express.json()(req, res, next)));
  const addUser = (req, res, next) => { const id = req.get("x-test-user"); req.user = id ? users.get(id) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; res.locals.ogPath = req.originalUrl.split("?")[0]; next(); });
  require(path.join(repo, "pads")).register(app);
  PA.register(app, { addUser });
  require(path.join(repo, "feedweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  require(path.join(repo, "follows")).register(app, { addUser });
  stories.register(app, { addUser });
  require(path.join(repo, "userstories")).register(app, { addUser });
  require(path.join(repo, "hop")).register(app, { addUser });
  require(path.join(repo, "media")).register(app, { addUser, isBotToken: (t) => t === "bot", noTimers: true });
  S.register(app, { addUser, isBotToken: (t) => t === "bot", noTimers: true });
  require(path.join(repo, "roomstats")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  require(path.join(repo, "padsettings")).register(app, { addUser });
  bridge.register(app, { addUser, isBotToken: (t) => t === "bot" });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  // every pad's stage has one live WHIP slot (the stage's own tables have their tests - rooms-stages / webrtc)
  S.publicSlots = async (roomId) => {
    const lv = LEVELS.find((k) => PADS[k].id === roomId);
    if (!lv) return [];
    const st = PADS[lv].stream;
    return [{ id: "slot-" + lv, username: "padowner", display: "padowner", hls: "https://stream.publicaccess.tv/" + st + "/index.m3u8",
              whep: "https://stream.publicaccess.tv/whep/" + st, room_id: roomId, mode: "stream", since: Date.now() }];
  };
  // analytics for every pad (Pepe's sync)
  const day = (k) => new Date(Date.now() - k * 86400000).toISOString().slice(0, 10);
  const days = {};
  for (let i = 0; i < 10; i++) days[day(i)] = { m: 100, s: 600, k: 7, u: 12, c: 9, n: 0 };
  const r = await fetch(base + "/api/roomstats/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
    password: "bot", tz: "UTC", days: 90, rooms: LEVELS.map((lv) => ({ room: PADS[lv].id, name: PADS[lv].id, first: 1780000000, last: Math.floor(Date.now() / 1000) - 60,
      days, how: Array(168).fill(1), hows: Array(168).fill(1), size: { typical: 4, peak: 9, src: "roster" }, uniq: { d30: 5, d90: 9 },
      knowledge: { summary: "ANALYTICS-" + lv + " talk", topics: [{ t: "topic" + lv, w: 3 }], at: Math.floor(Date.now() / 1000) } })) }) });
  assert.equal(r.status, 200);
});
test.after(() => { if (server) server.close(); });
test.beforeEach(() => { store._gaps.clear(); });

// ─────────────────────────── settings + requests ───────────────────────────
test("defaults: every pad is Members until its owner changes it; profile pads always Members; levels validated", async () => {
  await rooms.addRoom("fresh.Room", "Fresh", "test");
  assert.equal(PA.levelOf("fresh.Room"), "members");
  assert.equal(PA.levelOf("user:u_alice"), "members");
  assert.equal(PA.canSee(null, "fresh.Room"), true);
  assert.equal(PA.full(null, "fresh.Room"), false, "Members = today: the live room is for signed-in members");
  assert.equal(PA.full(U.member, "fresh.Room"), true);
  await assert.rejects(PA.setLevel(U.admin, await rooms.get("fresh.Room"), "secret"), /Pick Public, Members or Approved/);
  await assert.rejects(PA.setLevel(U.member, await rooms.get(PUB), "approved"), /Only this pad's owner/);
  await assert.rejects(PA.setLevel(U.admin, { id: "user:u_alice", profile: { username: "alice" } }, "public"), /set on the profile itself/);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pad_access WHERE room_id = 'fresh.Room'"))[0].n, 0, "no row until an owner picks one");
});

test("settings API: owner / admin only, same-site JSON, members list + requests come back", async () => {
  let r = await post("/api/pads/mem-room/access/level", U.member, { level: "public" });
  assert.equal(r.status, 403);
  r = await post("/api/pads/mem-room/access/level", null, { level: "public" });
  assert.equal(r.status, 401);
  r = await post("/api/pads/mem-room/access/level", U.owner, { level: "public" }, { "content-type": "application/json", "x-test-user": U.owner.userId });
  assert.equal(r.status, 403, "needs X-Requested-With: fetch");
  r = await post("/api/pads/mem-room/access/level", U.owner, { level: "public" }, H(U.owner, { origin: "https://evil.example" }));
  assert.equal(r.status, 403, "cross-site refused");
  r = await post("/api/pads/mem-room/access/level", U.admin, { level: "members" });
  assert.equal(r.status, 200); assert.equal(r.d.manage.level, "members");
  r = await get("/api/pads/app-room/access", U.owner);
  assert.equal(r.status, 200);
  assert.equal(r.d.manage.level, "approved");
  assert.deepEqual(r.d.manage.members.map((m) => m.username), ["invitee"]);
  assert.equal(r.d.manage.members[0].note, "hi, it's me");
  r = await get("/api/pads/app-room/access", U.member);
  assert.equal(r.d.manage, undefined, "only the owner sees the list");
  assert.equal(r.d.me.see, false); assert.equal(r.d.me.level, "approved");
  // the settings page renders the card for the owner
  const html = await ejs().renderFile(path.join(repo, "views", "padSettings.ejs"), await settingsLocals(APP));
  assert.match(html, /id="access" data-slug="app-room"/);
  assert.match(html, /value="approved" data-label="Approved" checked/);
  assert.match(html, /pad-access\.js\?v=1/);
});

test("request -> approve -> remove -> ask again later; deny; owners and staff never need to ask", async () => {
  const R = await rooms.get(APP);
  let r = await post("/api/pads/app-room/access/request", null, {});
  assert.equal(r.status, 401);
  r = await post("/api/pads/app-room/access/request", U.asker, { note: "let me in <b>please</b>" });
  assert.equal(r.status, 200); assert.equal(r.d.me.request, "pending");
  r = await post("/api/pads/app-room/access/request", U.asker, { note: "again" });
  assert.equal(r.status, 200, "idempotent while waiting");
  const notices = await getQuery("SELECT title, link FROM inbox WHERE user_id = ?", [U.owner.userId]);
  assert.ok(notices.some((x) => /asker asked to join p\/app-room/.test(x.title) && x.link === "/p/app-room/settings#access"), "the owner gets a notice");
  r = await post("/api/pads/app-room/access/decide", U.member, { userId: U.asker.userId, approve: true });
  assert.equal(r.status, 403, "not the owner");
  r = await post("/api/pads/app-room/access/decide", U.owner, { userId: U.asker.userId, approve: true });
  assert.equal(r.status, 200);
  assert.ok(r.d.manage.members.some((m) => m.username === "asker"));
  assert.equal(PA.canSee(U.asker, APP), true);
  assert.equal((await get("/p/app-room", U.asker)).status, 200);
  r = await post("/api/pads/app-room/access/remove", U.owner, { userId: U.asker.userId });
  assert.equal(r.status, 200);
  assert.equal(PA.canSee(U.asker, APP), false);
  assert.equal((await get("/p/app-room", U.asker)).status, 403);
  r = await post("/api/pads/app-room/access/request", U.asker, {});
  assert.equal(r.status, 429, "removed: ask again tomorrow");
  PA._setClock(() => Date.now() + PA.RETRY_MS + 1000);
  r = await post("/api/pads/app-room/access/request", U.asker, {});
  assert.equal(r.status, 200);
  PA._setClock(null);
  r = await post("/api/pads/app-room/access/decide", U.owner, { userId: U.asker.userId, approve: false });
  assert.equal(r.status, 200);
  assert.equal(PA.canSee(U.asker, APP), false);
  assert.equal((await post("/api/pads/app-room/access/request", U.asker, {})).status, 429, "denied: tomorrow");
  assert.equal((await post("/api/pads/app-room/access/request", U.owner, {})).status, 409, "the owner already has access");
  assert.equal((await post("/api/pads/app-room/access/request", U.admin, {})).status, 409, "so do admins");
  assert.equal((await post("/api/pads/mem-room/access/request", U.member, {})).status, 409, "a Members pad needs no asking");
  await assert.rejects(PA.decide(U.owner, R, U.member.userId, true), /No such request/);
});

// ─────────────────────────── the matrix ───────────────────────────
for (const lv of LEVELS) {
  for (const v of VIEWERS) {
    test(`matrix: ${lv} pad × ${v}`, async () => {
      const P = PADS[lv], u = who(v), see = sees(lv, v), fu = full(lv, v);
      const tag = `${lv}/${v}`;
      // pad page
      let r = await get("/p/" + P.slug, u);
      if (see) {
        assert.equal(r.status, 200, tag + " page");
        assert.ok(r.text.includes(P.title), tag + " title shown");
        assert.equal(r.text.includes("Sign in to watch the Camfrog room live"), !fu, tag + " live teaser only when the live room is closed to this viewer");
        assert.equal(r.text.includes('id="rmFeed"'), fu, tag + " live chat panel");
        assert.equal(r.text.includes("TOPIC-" + lv), fu, tag + " topic");
        if (lv === "approved") assert.equal(r.r.headers.get("x-robots-tag"), "noindex");
      } else {
        assert.equal(r.status, u ? 403 : 401, tag + " locked");
        assert.ok(!r.text.includes(P.title) && !r.text.includes(P.post) && !r.text.includes(P.chat), tag + " nothing leaks");
        assert.match(r.text, u ? /Request access/ : /Sign in to request access/);
        assert.match(r.text, /<meta property="og:title" content="p\/app-room on PATV">/, "og: the address only");
        assert.match(r.text, /members-only pad/);
        assert.equal(r.r.headers.get("x-robots-tag"), "noindex");
      }
      // pad tabs / sub-pages
      r = await get("/p/" + P.slug + "/hop", u);
      assert.equal(r.status, see ? 200 : (u ? 403 : 401), tag + " hop page");
      r = await get("/p/" + P.slug + "/submit", u);
      assert.equal(r.status, see ? (u ? 200 : 302) : (u ? 403 : 401), tag + " submit page");
      r = await get("/p/" + P.slug + "/audio", u);
      assert.equal(r.status, fu ? 404 : (u ? 403 : 401), tag + " audio (on: streams; off: 404)");
      r = await get("/p/" + P.slug + "/analytics", u);
      if (!see) assert.equal(r.status, u ? 403 : 401, tag + " analytics locked");
      else {
        assert.equal(r.status, 200, tag + " analytics");
        assert.equal(r.text.includes("ANALYTICS-" + lv), fu, tag + " analytics data (members-tier)");
      }
      // bridge chat API
      r = await get("/api/rooms/" + P.slug + "/live", u);
      if (fu) { assert.equal(r.status, 200, tag + " live API"); assert.ok(r.d.feed.some((x) => x.text === P.chat)); }
      else { assert.equal(r.status, u ? 403 : 401, tag + " live API refused"); assert.ok(!r.text.includes(P.chat)); }
      // feeds
      const viewer = u ? await store.account(u.userId) : null;
      const ids = (L) => L.posts.map((p) => p.id);
      const pid = POSTS[lv].id;
      assert.equal(ids(await store.list({ sort: "new", viewer, limit: 50 })).includes(pid), see, tag + " All");
      assert.equal(ids(await store.list({ room: P.id, sort: "new", viewer, limit: 50 })).includes(pid), see, tag + " the pad's feed");
      assert.equal(ids(await store.list({ author: U.owner.userId, sort: "new", viewer, limit: 50 })).includes(pid), see || v === "owner", tag + " profile posts");
      if (u) {
        await require(path.join(repo, "follows")).follow(u, "user", U.owner.userId, true).catch(() => {});
        assert.equal(ids(await store.list({ following: u.userId, sort: "new", viewer, limit: 50 })).includes(pid) || v === "owner", see || v === "owner", tag + " Following");
      }
      r = await get("/feed?sort=new", u);
      assert.equal(r.status, 200);
      assert.equal(r.text.includes(P.post), see, tag + " /feed page");
      // gallery / Hop (media-only lists) and search (the pads list)
      assert.equal(ids(await store.list({ media: true, sort: "new", viewer, limit: 50, sfw: !u })).includes(pid), see, tag + " gallery");
      r = await get("/api/hop?scope=all&sort=new", u);
      assert.equal(r.d.items.some((x) => x.id === pid), see, tag + " Hop (all)");
      r = await get("/api/hop?scope=p/" + P.slug + "&sort=new", u);
      assert.equal(r.d.items.some((x) => x.id === pid), see, tag + " Hop (pad)");
      assert.ok(!r.text.includes(P.post) || see);
      r = await get("/api/feed/communities", u);
      assert.equal(r.d.communities.some((c) => c.id === P.id), see, tag + " search / pickers");
      // post pages: the short address and the canonical one
      const canon = POSTS[lv].url;
      r = await get("/feed/p/" + pid, u);
      assert.equal(r.status, see ? 301 : 404, tag + " /feed/p/<id>");
      if (see) assert.equal(r.r.headers.get("location"), canon);
      r = await get(canon, u);
      assert.equal(r.status, see ? 200 : 404, tag + " canonical post URL");
      assert.equal(r.text.includes(P.post), see);
      // media files
      r = await get("/media/f/" + FILES[lv], u);
      assert.equal(r.status, see ? 200 : 404, tag + " /media/f");
      if (see && lv === "approved") assert.match(r.r.headers.get("cache-control"), /private/);
      for (const sub of ["", "/raw", "/poster"]) {
        r = await get("/media/" + CAPS[lv] + sub, u);
        assert.equal(r.status, see ? 200 : 404, tag + " /media/<id>" + sub);
      }
      // stories
      const strip = await stories.forViewer(u);
      const circle = strip.find((x) => x.id === P.id);
      assert.equal(!!circle, see, tag + " a circle on the homepage / feed strip");
      if (circle) assert.equal(Array.isArray(circle.items) && circle.items.length > 0, fu, tag + " its pictures (members-tier)");
      r = await get("/api/stories", u);
      if (!u) assert.equal(r.status, 401);
      else assert.equal(r.d.rooms.some((x) => x.id === P.id), see, tag + " /api/stories");
      // the stage: /api/stage and the pad's stage API
      r = await get("/api/stage?room=" + P.slug, u);
      if (see) {
        assert.equal(r.status, 200, tag + " /api/stage");
        const s = r.d.slots[0];
        assert.ok(s, tag + " a slot");
        if (lv === "approved") assert.match(s.hls, /\?pt=r1\./, tag + " a read token on the HLS URL");
        else assert.ok(!/pt=/.test(s.hls), tag + " no token needed");
      } else assert.equal(r.status, u ? 403 : 401, tag + " /api/stage refused");
      r = await get("/api/rooms/" + P.slug + "/stage", u);
      assert.equal(r.status, see ? 200 : (u ? 403 : 401), tag + " /api/rooms/<slug>/stage");
      // /p guide (+ Trending, which marks its rows)
      r = await get("/p", u);
      assert.equal(r.text.includes('href="/p/' + P.slug + '"'), see, tag + " /p guide card");
      assert.equal(r.text.includes(P.title), see, tag + " /p title");
      // the homepage pieces: its pad rows (Top Pads, the room widget), front pick, stories
      const visible = PA.visibleRows(u, await bridge.summary(!!u));
      assert.equal(visible.some((x) => x.id === P.id), see, tag + " homepage rows");
      const tops = home.topPads(visible, visible.map((x) => ({ id: x.id })), new Map(), 10);
      assert.equal(tops.some((x) => x.id === P.id), see, tag + " Top Pads");
      // DM post cards are rendered for nobody in particular: an Approved pad's post is "unavailable" there
      const card = await require(path.join(repo, "dmembeds")).card(pid);
      assert.equal(card.unavailable, lv === "approved", tag + " DM card");
      if (lv === "approved") assert.ok(!JSON.stringify(card).includes("SECRETPOST"));
    });
  }
}

test("the stage read auth (MediaMTX hook): Approved pads need a member's token (or a recently-good IP), others stay open", async () => {
  const origCfg = S.config;
  S.config = () => ({ ...origCfg(), webrtc_enabled: true });
  const slots = { [PADS.public.stream]: PUB, [PADS.members.stream]: MEM, [PADS.approved.stream]: APP };
  const origOpen = S.openSlotByStream;
  S.openSlotByStream = async (p) => (slots[p] ? { id: "s-" + p, stream: p, room_id: slots[p], mode: "stream" } : null);
  try {
    const read = (p, extra = {}) => W.whipAuth({ action: "read", protocol: "hls", path: p, ip: "9.9.9.9", ...extra });
    assert.equal(await read(PADS.public.stream), 200);
    assert.equal(await read(PADS.members.stream), 200);
    const A = PADS.approved.stream;
    assert.equal(await read(A), 403, "no token");
    assert.equal(await read(A, { query: "pt=r1.123.abc.def" }), 403, "a junk token");
    const good = PA.readToken(U.approved.userId, A);
    assert.equal(await read(A, { query: "pt=" + encodeURIComponent(good), ip: "1.1.1.1" }), 200, "a member's token");
    assert.equal(await read(A, { ip: "1.1.1.1" }), 200, "then the same IP's HLS parts without it");
    assert.equal(await read(A, { ip: "2.2.2.2" }), 403, "another IP without one");
    assert.equal(await read(A, { query: "pt=" + encodeURIComponent(PA.readToken(U.approved.userId, PADS.public.stream)), ip: "3.3.3.3" }), 403, "a token for another stream");
    assert.equal(await read(A, { query: "pt=" + encodeURIComponent(PA.readToken(U.member.userId, A)), ip: "4.4.4.4" }), 403, "a validly signed token for someone outside");
    assert.equal(await read(A, { query: "pt=" + encodeURIComponent(PA.readToken(U.admin.userId, A)), ip: "5.5.5.5" }), 200, "an admin");
    assert.equal(await read(A, { protocol: "webrtc", query: "pt=" + encodeURIComponent(PA.readToken(U.owner.userId, A)), ip: "6.6.6.6" }), 200, "WHEP: the owner");
    assert.equal(await read(A, { protocol: "rtsp", ip: "127.0.0.1" }), 200, "the box's own loopback reads");
    const old = PA.readToken(U.approved.userId, A, Date.now() - 3 * 24 * 3600e3);
    assert.equal(await read(A, { query: "pt=" + encodeURIComponent(old), ip: "7.7.7.7" }), 403, "expired");
    // the URL is stable while a page polls (the player only reloads on a new URL)
    assert.equal(PA.readToken(U.approved.userId, A, 1_800_000_000_000), PA.readToken(U.approved.userId, A, 1_800_000_000_000 + 60e3));
    // removed: the token stops working at once
    await PA.remove(U.owner, await rooms.get(APP), U.approved.userId);
    assert.equal(await read(A, { query: "pt=" + encodeURIComponent(good), ip: "8.8.8.8" }), 403, "a removed member's token");
    await PA.request(U.approved, await rooms.get(APP)).catch(() => {});
    await runQuery("UPDATE pad_members SET status = 'pending', decided_at = NULL WHERE room_id = ? AND user_id = ?", [APP, U.approved.userId]);
    await PA.decide(U.owner, await rooms.get(APP), U.approved.userId, true);
    assert.equal(PA.canSee(U.approved, APP), true);
    // tokenizeSlots: only on an Approved pad, only for the people inside it
    const sl = [{ hls: "https://x/" + A + "/index.m3u8", whep: "https://x/whep/" + A }];
    assert.match(PA.tokenizeSlots(sl, U.approved, APP)[0].whep, /\?pt=r1\./);
    assert.deepEqual(PA.tokenizeSlots(sl, U.member, APP), sl);
    assert.deepEqual(PA.tokenizeSlots(sl, U.approved, PUB), sl);
  } finally { S.config = origCfg; S.openSlotByStream = origOpen; }
});

test("front pick: never auto-picks an Approved pad; a pinned one shows to its members only; Trending leaves it out", async () => {
  const summary = [PUB, MEM, APP].map((id, i) => ({ id, slug: PADS[LEVELS[i]].slug, name: id, count: 5, live: true,
    act: { chatters: id === APP ? 50 : 2, lines: id === APP ? 900 : 10, micMin: id === APP ? 60 : 1, lastAt: Date.now(), people: id === APP ? 40 : 3 } }));
  await rooms.setFront("auto", "test");
  const A = await rooms.frontReevaluate(summary, "test");
  assert.notEqual(A.id, APP, "the busiest pad is Approved: not picked");
  assert.ok(!(A.ranked || []).some((x) => x.id === APP), "not even ranked");
  for (const v of VIEWERS) assert.notEqual((await rooms.frontRoom(summary, { viewer: who(v) })).id, APP);
  await rooms.setFront(APP, "test");
  for (const v of VIEWERS) {
    const f = await rooms.frontRoom(summary, { viewer: who(v) });
    assert.equal(f.id === APP, sees("approved", v), v + ": the pinned Approved pad only for its members");
  }
  assert.equal((await rooms.frontRoom(summary)).id, APP, "without a viewer (admin views, the bridge's tick): the setting itself");
  await rooms.setFront("auto", "test");
  const g = await require(path.join(repo, "roomsweb")).guideRows(false, null);
  assert.ok(!g.rows.some((r) => r.id === APP), "/p rows and their Trending marks: no Approved pad for visitors");
  assert.equal(g.rows.find((r) => r.id === PUB).access, "public");
});

test("signed-out visitors: a Public pad's story opens (pictures inlined), a Members pad's asks to sign in", async () => {
  const html = (await get("/p/pub-room")).text;
  assert.match(html, /data-story-room="pub\.Room"[^>]*data-story-open=1/);
  assert.match(html, /class="ss-data">\[\{"id":"pub\.Room"/);
  const mem = (await get("/p/mem-room")).text;
  assert.doesNotMatch(mem, /data-story-open/);
  assert.doesNotMatch(mem, /class="ss-data"/);
  const js = fs.readFileSync(path.join(repo, "public", "js", "stories.js"), "utf8");
  assert.match(js, /strip\.getAttribute\('data-signed'\) !== '1' && !t\.hasAttribute\('data-story-open'\)/);
  // a person's story leaves out captures taken in an Approved pad for outsiders
  const US = require(path.join(repo, "userstories"));
  await runQuery("UPDATE users SET camfrogUsername = 'alicecf' WHERE userId = 'u_alice'");
  const asMember = await US.people(U.member, [U.alice.userId]);
  const asInvitee = await US.people(U.approved, [U.alice.userId]);
  const capsOf = (x) => (x[0] && x[0].items ? x[0].items.map((i) => i.id) : []);
  assert.ok(!capsOf(asMember).includes(CAPS.approved), "outsider: not in Alice's story");
  assert.ok(capsOf(asInvitee).includes(CAPS.approved), "member: there");
});

test("actions on an Approved pad's content: follow, vote, comment, crosspost, post into it", async () => {
  const pid = POSTS.approved.id;
  assert.equal((await post("/api/follow", U.member, { kind: "room", id: "app-room" })).status, 404);
  assert.equal((await post("/api/follow", U.approved, { kind: "room", id: "app-room" })).status, 200);
  assert.equal((await post("/api/feed/posts/" + pid + "/vote", U.member, { dir: 1 })).status, 404);
  assert.equal((await post("/api/feed/posts/" + pid + "/vote", U.approved, { dir: 1 })).status, 200);
  assert.equal((await post("/api/feed/posts/" + pid + "/comments", U.member, { body: "hi" })).status, 404);
  assert.equal((await post("/api/feed/posts/" + pid + "/comments", U.approved, { body: "hi" })).status, 200);
  assert.equal((await post("/api/feed/posts/" + pid + "/crosspost", U.member, { community: PUB })).status, 404);
  const x = await post("/api/feed/posts/" + pid + "/crosspost", U.approved, { community: PUB });
  assert.equal(x.status, 403, "a members-only post stays in its pad");
  assert.match(x.d.error, /members-only pad/);
  let r = await post("/api/feed/posts", U.member, { community: APP, title: "sneaky" });
  assert.equal(r.status, 403);
  r = await post("/api/feed/posts", U.approved, { community: APP, title: "from inside" });
  assert.equal(r.status, 200);
  // a crosspost INTO a public pad of a public post, by a member: still fine
  assert.equal((await post("/api/feed/posts/" + POSTS.members.id + "/crosspost", U.member, { community: PUB })).status, 200);
  // the API gate covers the pad's other endpoints (rules, boosts, DJ, mod, snaps ...)
  for (const p of ["/api/rooms/app-room/rules", "/api/rooms/app-room/boost", "/api/rooms/app-room/dj"]) {
    assert.equal((await get(p, U.member)).status, 403, p);
    assert.equal((await get(p, null)).status, 401, p);
  }
  assert.equal((await post("/api/rooms/app-room/say", U.member, { text: "hi" })).status, 403);
});

test("no sitemap to leak through; the settings page and the owner's routes still work for the owner", async () => {
  assert.equal((await get("/sitemap.xml")).status, 404, "PATV has no sitemap (nothing to gate)");
  assert.equal((await get("/p/app-room/settings", U.member)).status, 403);
});

// ─────────────────────────── 💸 Tip ───────────────────────────
test("tip targets (server): linked -> their PATV tip page; unlinked -> greyed out; never yourself / Pepe / anonymous / bots / signed out", async () => {
  bridge._pepeName("pepe");
  const me = { userId: U.member.userId, username: "plainmember", login: "membercf" };
  const T = bridge.tipFor;
  assert.deepEqual(T({ login: "alicecf", patv: { username: "alice" } }, me, "pepe"), { to: "alice", href: "/u/alice/tip" });
  assert.deepEqual(T({ login: "strangercf" }, me, "pepe"), { off: "not linked to PATV yet" });
  assert.equal(T({ login: "membercf", patv: { username: "plainmember" } }, me, "pepe"), null, "yourself by login");
  assert.equal(T({ login: "otherlogin", patv: { username: "PlainMember" } }, me, "pepe"), null, "yourself by account");
  assert.equal(T({ login: "pepefrog", self: true, patv: { username: "pepe" } }, me, "pepe"), null, "Pepe in the room");
  assert.equal(T({ login: "pepe2", patv: { username: "Pepe" } }, me, "pepe"), null, "Pepe's PATV account");
  assert.equal(T({ anon: true, display: "someone" }, me, "pepe"), null);
  assert.equal(T({ login: "botcf", bot: true }, me, "pepe"), null);
  assert.equal(T({ login: "alicecf", patv: { username: "alice" } }, null, "pepe"), null, "signed out: no tip");
  // end to end: the live API as a member - routed by LOGIN to the linked account (the real one beats Pepe's CF auto account)
  const r = await get("/api/rooms/mem-room/live", U.member);
  const by = (list, login) => list.find((x) => x.login === login);
  assert.deepEqual(by(r.d.members, "alicecf").tip, { to: "alice", href: "/u/alice/tip" });
  assert.deepEqual(by(r.d.mic, "alicecf").tip, { to: "alice", href: "/u/alice/tip" }, "the mic list too");
  assert.deepEqual(by(r.d.members, "strangercf").tip, { off: "not linked to PATV yet" });
  assert.deepEqual(by(r.d.mic, "strangercf").tip, { off: "not linked to PATV yet" });
  assert.equal(by(r.d.members, "membercf").tip, undefined, "yourself");
  assert.equal(by(r.d.members, "pepefrog").tip, undefined, "Pepe");
  assert.equal(by(r.d.members, "botcf").tip, undefined, "a bot");
  assert.ok(r.d.members.filter((x) => x.anon).every((x) => x.tip === undefined), "anonymous");
  const pub = await get("/api/rooms/pub-room/live", null);
  assert.equal(pub.status, 200);
  assert.ok(pub.d.members.every((x) => x.tip === undefined), "a signed-out visitor on a Public pad gets no tip targets");
});

test("tip menu (room-mod.js): a light ⋯ for every signed-in viewer; mods keep their actions; nothing for visitors", () => {
  const win = {};
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public", "js", "room-mod.js"), "utf8"), { window: win });
  const MI = (...a) => JSON.parse(JSON.stringify(win.PATVRoom._modMenuItems(...a)));
  const ids = (xs) => xs.map((x) => x.id);
  const alice = { login: "alicecf", display: "Alice", patv: { username: "alice" }, tip: { to: "alice", href: "/u/alice/tip" } };
  const stranger = { login: "strangercf", display: "Stranger", tip: { off: "not linked to PATV yet" } };
  assert.deepEqual(ids(MI(null, alice, { signed: true, cam: true })), ["profile", "cam", "tip"]);
  const tip = MI(null, alice, { signed: true }).find((x) => x.id === "tip");
  // 1.99il: the Tip opens the modal on the pad (pad-tip.js); the tip page stays as the fallback href
  assert.equal(tip.kind, "tip"); assert.equal(tip.to, "alice"); assert.equal(tip.href, "/u/alice/tip");
  const off = MI(null, stranger, { signed: true }).find((x) => x.id === "tip");
  assert.equal(off.kind, "off"); assert.equal(off.disabled, true); assert.equal(off.note, "not linked to PATV yet");
  assert.deepEqual(MI(null, alice, { signed: false, cam: true }), [], "signed out: no menu");
  assert.deepEqual(MI(null, { login: "membercf", display: "Me" }, { signed: true }), [], "no tip target (yourself): nothing to show");
  assert.deepEqual(MI(null, { login: "pepefrog", self: true }, { signed: true }), [], "Pepe");
  assert.deepEqual(MI(null, { anon: true }, { signed: true }), [], "anonymous");
  assert.ok(!ids(MI(null, { login: "botcf", bot: true, tip: { to: "x", href: "/u/x/tip" } }, { signed: true })).includes("tip"), "bots: never");
  const caps = { actions: ["kick", "djban"], on: true, login: "modcf" };
  assert.deepEqual(ids(MI(caps, alice, { signed: true, inRoom: true })), ["profile", "tip", "kick", "djban", "more"], "mods: tip + their actions");
  assert.deepEqual(ids(MI(caps, { ...alice, login: "modcf" }, { signed: true })), ["profile", "tip"], "a mod's own row: no moderation");
  // the page wires it: the ⋯ shows for signed-in viewers, on both lists, and the tip opens the modal
  const src = fs.readFileSync(path.join(repo, "public", "js", "room-mod.js"), "utf8");
  assert.match(src, /if \(P\.tipModal\) P\.tipModal\(\{ to: it\.to, display: u\.display \|\| u\.login, slug: slug, me: opts\.me \|\| null \}\);/);
  assert.match(src, /else window\.open\(it\.href, '_blank', 'noopener'\);/, "no modal script: the tip page in a new tab");
  assert.match(src, /if \(!caps\) \{ closeDlg\(\); if \(pop && pop\._mod\) closeMenu\(false\);/, "the light menu survives the 1.5 s polls");
});

// helpers
function ejs() { return require("ejs"); }
async function settingsLocals(roomId) {
  const R = await rooms.get(roomId);
  const viewer = await store.account(U.owner.userId);
  const D = await require(path.join(repo, "padsettings")).hubData(R, viewer, null);
  return { user: "padowner", viewer, tab: "general", TABS: require(path.join(repo, "padsettings")).TABS, fx: require(path.join(repo, "feedweb")).fx,
           G: require(path.join(repo, "guidelines")), padBadge: require(path.join(repo, "pads")).padBadge, ...D };
}
