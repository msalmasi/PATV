// Offline tests for 1.99cg: Pepe on the feed (pepefeed.js) - the bot-token API (auth, acts only as Pepe,
// server-side limits), mention detection, what he must never touch (NSFW, reported, hidden, locked, muted,
// banned / restricted authors), settings permissions (owner vs admin, admin lock, main feed + global caps),
// "Mute Pepe in this thread", no self-votes, the bot-marked content_audit row and the 🤖 Pepe badge.
//   NODE_PATH=G:/PATV/node_modules node --test test/pepefeed.test.js     (temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pepefeed-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");

const express = require("express");
const cookieParser = require("cookie-parser");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const web = require(path.join(repo, "feedweb"));
const terms = require(path.join(repo, "terms"));
const audit = require(path.join(repo, "contentaudit"));
const PF = require(path.join(repo, "pepefeed"));

const OWNED = "plant_based_chatting", HOUSE = "PepeFrog.Room", OTHER = "Side.Room";
let base, server, U = {};
const users = new Map();
let clock = Date.parse("2026-10-06T16:00:00Z");          // 12:00 New York
const NOW = () => clock;

async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned, email)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, ?, ?, 0, ?)`,
                 [id, name, name, extra.class || "pleb", extra.camfrog || null, extra.level || 0, "2026-01-01 00:00:00", name + "@example.com"]);
  const u = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, u);
  return u;
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, email TEXT UNIQUE, xp INTEGER DEFAULT 0,
                  avatar TEXT, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery(`CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ct TEXT NOT NULL, file TEXT NOT NULL, bytes INTEGER, secs REAL, subject TEXT,
                  by_user TEXT, room TEXT, created INTEGER, expires INTEGER, deleted INTEGER DEFAULT 0)`);
  U.owner = await mkUser("plantowner", { camfrog: "foamy1111" });
  U.admin = await mkUser("boss", { class: "Admin", camfrog: "bossfrog" });
  U.staff = await mkUser("helper", { class: "Staff", camfrog: "helpercf" });
  U.alice = await mkUser("alice", { camfrog: "alicecf" });
  U.bob = await mkUser("bob", { camfrog: "bobcf" });
  U.troll = await mkUser("troll", { camfrog: "trollcf" });
  U.pepeName = await mkUser("Pepe", { camfrog: "someguy" });      // a human already called "Pepe": the bot account must not take it
  await rooms.init();
  await rooms.setOwner(OWNED, "plantowner", "test");
  await rooms.addRoom(OTHER, "Side Room", "test");
  await store.init();
  await terms.init();
  await audit.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0, comments_per_hour: 1000 }, "test");
  for (const u of users.values()) await terms.accept(u.userId);
  PF._setClock(NOW);
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  web.register(app, { addUser, isBotToken: (t) => t === "bot" });
  PF.register(app, { addUser, isBotToken: (t) => t === "bot" });
  require(path.join(repo, "pads")).register(app);                       // 1.99dc: app.locals.padBadge + the old /mod redirect
  require(path.join(repo, "padsettings")).register(app, { addUser });   // 1.99dc: the pad settings hub
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });
test.beforeEach(async () => {
  store._gaps.clear();
  PF._writes.length = 0;
  clock += 3600e3;                                          // every test starts an hour later (spacing)
});

const H = (u, extra = {}) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {}, extra);
// 1.99ci: every post lives in exactly one community - tests post to the Camfrog Lounge (house: follows Pepe's All
// settings) unless they pick one
const LOUNGE = "patv:lounge";
const withCommunity = (url, body) => (url === "/api/feed/posts" && body && typeof body === "object" && body.community === undefined && !body.rooms
  ? { ...body, community: LOUNGE } : body);
async function call(method, url, u, body, extra) {
  body = withCommunity(url, body);
  const r = await fetch(base + url, { method, headers: H(u, extra), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, text };
}
const post = (url, u, body, extra) => call("POST", url, u, body, extra);
const BOT = { "x-bot-token": "bot" };
const bot = (url, body) => post(url, null, body, BOT);
async function mkPost(u, body = {}) {
  const r = await post("/api/feed/posts", u, { body: "hello", ...body });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  return r.d.id;
}
async function mkComment(u, postId, body, parent = null) {
  const r = await post(`/api/feed/posts/${postId}/comments`, u, { body, parent });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  return r.d.id;
}
const sync = async () => { const r = await bot("/api/pepe/feed/sync", {}); assert.equal(r.status, 200, r.text); return r.d; };
const targets = (d) => d.mentions.map((m) => m.target);
const resetLimits = async () => {
  await runQuery("DELETE FROM pepe_feed_log");
  await PF.setGlobal(U.admin, { ...PF.GLOBAL_DEFAULTS });
};

// ───────────────────────────── bot API auth ─────────────────────────────
test("bot API: no token / wrong token are refused; the header or the body's password both work", async () => {
  assert.equal((await post("/api/pepe/feed/sync", null, {})).status, 403);
  assert.equal((await post("/api/pepe/feed/sync", null, {}, { "x-bot-token": "nope" })).status, 403);
  assert.equal((await post("/api/pepe/feed/sync", U.admin, {})).status, 403, "a signed-in admin is not the bot");
  assert.equal((await post("/api/pepe/feed/comment", null, { post: "x", body: "hi" })).status, 403);
  assert.equal((await post("/api/pepe/feed/post", null, { body: "hi" })).status, 403);
  assert.equal((await post("/api/pepe/feed/sync", null, { password: "bot" })).status, 200);
  const d = await sync();
  assert.equal(d.account.userId, "pepe-bot");
  assert.notEqual(d.account.username.toLowerCase(), "pepe", "a human already owns the name Pepe - the bot account takes another");
  const row = (await getQuery("SELECT class, password FROM users WHERE userId = 'pepe-bot'"))[0];
  assert.equal(row.class, "Bot");
  assert.ok(row.password.length > 20 && row.password !== "x", "an unusable random password");
});

// ───────────────────────────── mentions ─────────────────────────────
test("mention detection: @pepe, pepe as a word, replies to Pepe; not pepefrog / pepperoni", () => {
  for (const t of ["@pepe what do you think", "pepe is this real?", "lol Pepe.", "ask PEPE", "what's pepe's take"]) assert.ok(PF.mentions(t), t);
  for (const t of ["pepefrog posted", "pepperoni pizza", "repepe", "nope", "https://x.y/pepe_gif"]) assert.ok(!PF.mentions(t), t);
  assert.ok(PF.mentions("hey @PepeBot", "PepeBot"));
});

test("a main-feed mention is offered once; Pepe's reply is HIS (fields naming another author are ignored), threaded, audited as bot, no self-vote", async () => {
  await resetLimits();
  const pid = await mkPost(U.alice, { title: "Best pizza?", body: "hot takes only" });
  const cid = await mkComment(U.bob, pid, "@pepe settle this");
  let d = await sync();
  const m = d.mentions.find((x) => x.target === "c:" + cid);
  assert.ok(m, "offered");
  assert.equal(m.scope, "");
  assert.equal(m.post.title, "Best pizza?");
  assert.equal(m.reply_to.author.login, "bobcf");
  assert.equal(m.parent, cid);
  const r = await bot("/api/pepe/feed/comment", { target: m.target, post: pid, parent: m.parent, scope: "", why: "mention", body: "Pineapple. Fight me.",
                                                  userId: U.admin.userId, author: "boss", cost: 0.002 });
  assert.equal(r.status, 200, r.text);
  const c = (await getQuery("SELECT * FROM feed_comments WHERE id = ?", [r.d.id]))[0];
  assert.equal(c.author_id, "pepe-bot", "always Pepe");
  assert.equal(c.parent_id, cid);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM feed_comment_votes WHERE user_id = 'pepe-bot'"))[0].n, 0, "no automatic self-upvote");
  const a = (await getQuery("SELECT * FROM content_audit WHERE target_id = ?", [r.d.id]))[0];
  assert.equal(a.bot, 1); assert.equal(a.via, "bot"); assert.equal(a.ip, null);
  d = await sync();
  assert.ok(!targets(d).includes("c:" + cid), "never offered twice");
  // the same target again: refused (seen) is fine either way, but a second write can't double post via the inbox
  const log = await getQuery("SELECT * FROM pepe_feed_log WHERE action = 'comment'");
  assert.equal(log.length, 1);
  assert.ok(Math.abs(log[0].cost - 0.002) < 1e-9);
  // a reply to Pepe's reply (same conversation, right after him) is a mention too - no "pepe" needed
  clock += 60e3;
  const c2 = await mkComment(U.bob, pid, "no way, pineapple is a crime", cid);
  d = await sync();
  const m2 = d.mentions.find((x) => x.target === "c:" + c2);
  assert.ok(m2, "a reply right after Pepe counts as replying to him");
  assert.equal(m2.depth, 1);
  assert.equal(m2.thread.length, 3);
  assert.ok(m2.thread.some((t) => t.author.pepe));
  // a conversation with Pepe reads in time order under every sort (his replies start at 0 votes)
  const tree = (await store.comments(pid, U.alice, "best")).find((x) => x.id === cid);
  assert.deepEqual(tree.replies.map((x) => x.id), [r.d.id, c2]);
  assert.equal(tree.replies[0].author.bot, true);
  // Pepe can't vote
  assert.equal((await store.vote({ userId: "pepe-bot" }, pid, 1).catch((e) => e)).status, 403);
});

test("never: NSFW, reported, hidden, locked, muted posts, or banned / restricted authors - and his own posts", async () => {
  await resetLimits();
  const nsfw = await mkPost(U.alice, { body: "pepe look", nsfw: true });
  const rep = await mkPost(U.alice, { body: "pepe look at this" });
  await post(`/api/feed/posts/${rep}/report`, U.bob, { reason: "spam" });
  const hid = await mkPost(U.alice, { body: "pepe hidden one" });
  await store.adminSet(U.admin, hid, { hidden: true });
  const lock = await mkPost(U.alice, { body: "pepe locked one" });
  await store.adminSet(U.admin, lock, { locked: true });
  const muted = await mkPost(U.alice, { body: "pepe muted one" });
  assert.equal((await post(`/api/feed/posts/${muted}/pepe-mute`, U.alice, { on: true })).status, 200);
  const banned = await mkPost(U.troll, { body: "pepe banned one" });
  await store.ban(U.admin, "troll", { reason: "x" });
  const restr = await mkPost(U.bob, { body: "pepe restricted one" });
  await store.setRestricted([{ login: "bobcf", room: "", reason: "ignored", until: 0 }]);
  const ok = await mkPost(U.alice, { body: "pepe this one is fine" });
  const d = await sync();
  const t = targets(d);
  for (const [id, what] of [[nsfw, "nsfw"], [rep, "reported"], [hid, "hidden"], [lock, "locked"], [muted, "muted"], [banned, "banned"], [restr, "restricted"]]) {
    assert.ok(!t.includes("p:" + id), what);
  }
  assert.ok(t.includes("p:" + ok), "the clean one is offered");
  // and the write side refuses them too (a buggy bot can't get around it)
  for (const id of [nsfw, rep, hid, muted, banned]) {
    const r = await bot("/api/pepe/feed/comment", { post: id, scope: "", why: "mention", body: "hi" });
    assert.ok(r.status === 409 || r.status === 404, id + " " + r.status);
  }
  await store.unban(U.admin, U.troll.userId, "");
  await store.setRestricted([]);
});

test("rooms: 1.99cu mentions are answered by default in EVERY pad (house and owners'); an owner's explicit off holds", async () => {
  await resetLimits();
  const inHouse = await mkPost(U.alice, { body: "pepe in your own room", rooms: [HOUSE], global: false });
  const inOwned = await mkPost(U.alice, { body: "pepe in plant room", rooms: [OWNED], global: false });
  let d = await sync();
  const h = d.mentions.find((x) => x.target === "p:" + inHouse);
  assert.ok(h); assert.equal(h.scope, "", "1.99ci: a house community with no settings of its own is the All scope");
  const ow = d.mentions.find((x) => x.target === "p:" + inOwned);
  assert.ok(ow, "owner's pad: ON by default now"); assert.equal(ow.scope, OWNED);
  assert.equal((await PF.scopeSettings(OWNED)).respond, true);
  assert.equal((await PF.scopeSettings(HOUSE)).respond, true);
  assert.equal((await PF.scopeSettings("")).respond, true);
  assert.equal(PF.respondDefault("Some.Unowned.Room"), true);
  assert.equal((await PF.scopeSettings(HOUSE)).auto, false, "auto is off everywhere by default");
  assert.equal((await PF.scopeSettings(OWNED)).auto, false, "auto stays off in owners' pads too");
  // the settings form re-sending respond:true (the default) doesn't make it explicit; unchecking does
  assert.equal((await post(`/api/rooms/${OWNED}/feed/pepe`, U.owner, { settings: { respond: true } })).status, 200);
  assert.ok(!(await PF.scopeSettings(OWNED)).respond_set);
  assert.equal((await post(`/api/rooms/${OWNED}/feed/pepe`, U.owner, { settings: { respond: false } })).status, 200);
  assert.equal((await PF.scopeSettings(OWNED)).respond, false);
  assert.equal((await post(`/api/rooms/${OWNED}/feed/pepe`, U.owner, { settings: { respond: false, comments_per_day: 7 } })).status, 200);
  assert.equal((await PF.scopeSettings(OWNED)).respond, false, "an explicit off survives later saves");
  // a mention left while the pad is off is dropped for good (marked seen), never queued for later
  const whileOff = await mkPost(U.alice, { body: "pepe are you there", rooms: [OWNED], global: false });
  d = await sync();
  assert.ok(!targets(d).includes("p:" + whileOff));
  const seenRow = (await getQuery("SELECT outcome FROM pepe_feed_seen WHERE target = ?", ["p:" + whileOff]))[0];
  assert.match(String(seenRow && seenRow.outcome), /mentions off/);
  // the owner switches mentions back on -> the old one stays dropped, a NEW mention there is offered
  assert.equal((await post(`/api/rooms/${OWNED}/feed/pepe`, U.owner, { settings: { respond: true } })).status, 200);
  const later = await mkPost(U.alice, { body: "pepe now?", rooms: [OWNED], global: false });
  d = await sync();
  assert.ok(!targets(d).includes("p:" + whileOff), "never re-offered");
  const o = d.mentions.find((x) => x.target === "p:" + later);
  assert.ok(o); assert.equal(o.scope, OWNED);
  // a room-only NSFW mark keeps him out
  const marked = await mkPost(U.alice, { body: "pepe marked", rooms: [OWNED], global: false });
  await post(`/api/rooms/${OWNED}/feed/mod`, U.owner, { op: "nsfw", post: marked });
  d = await sync();
  assert.ok(!targets(d).includes("p:" + marked));
});

// ───────────────────────────── limits (server side) ─────────────────────────────
test("limits: comments per day (scope + global), back-and-forth depth, reply spacing, writes per minute", async () => {
  await resetLimits();
  await PF.setScope(U.admin, "", { comments_per_day: 2, max_depth: 2 });
  await PF.setGlobal(U.admin, { reply_gap_secs: 30 });
  const pid = await mkPost(U.alice, { body: "thread" });
  const c1 = await mkComment(U.bob, pid, "pepe one");
  const say = (parent, body = "ok") => bot("/api/pepe/feed/comment", { target: "c:" + parent, post: pid, parent, scope: "", why: "mention", body });
  assert.equal((await say(c1)).status, 200);
  assert.equal((await say(c1)).status, 429, "30 s spacing between mention replies");
  clock += 31e3;
  assert.equal((await say(c1)).status, 200);
  clock += 31e3;
  const r = await say(c1);
  assert.equal(r.status, 429);
  assert.match(r.d.error, /back-and-forth|comment limit/);
  const c2 = await mkComment(U.alice, pid, "pepe another thread");
  const r2 = await say(c2);
  assert.equal(r2.status, 429); assert.match(r2.d.error, /comment limit/, "2 a day in this scope");
  // depth: a new conversation with max_depth 2 lets 2 replies, then the mention isn't even offered
  await resetLimits();
  await PF.setScope(U.admin, "", { comments_per_day: 50, max_depth: 2 });
  await PF.setGlobal(U.admin, { reply_gap_secs: 0, writes_per_min: 3 });
  const c3 = await mkComment(U.troll, pid, "pepe fight me");
  assert.equal((await say(c3)).status, 200);
  assert.equal((await say(c3)).status, 200);
  const r3 = await say(c3);
  assert.equal(r3.status, 429); assert.match(r3.d.error, /back-and-forth/);
  clock += 1000;
  const c4 = await mkComment(U.troll, pid, "pepe coward", c3);
  const d = await sync();
  assert.ok(!targets(d).includes("c:" + c4), "a troll past the depth limit isn't offered");
  // writes per minute: 3
  PF._writes.length = 0;
  const c5 = await mkComment(U.bob, pid, "pepe a"), c6 = await mkComment(U.bob, pid, "pepe b"), c7 = await mkComment(U.bob, pid, "pepe c"), c8 = await mkComment(U.bob, pid, "pepe d");
  assert.equal((await say(c5)).status, 200); assert.equal((await say(c6)).status, 200); assert.equal((await say(c7)).status, 200);
  const r4 = await say(c8);
  assert.equal(r4.status, 429); assert.match(r4.d.error, /this minute/);
  await PF.setScope(U.admin, "", { ...PF.SCOPE_DEFAULTS });
});

test("limits: auto posts need auto on, obey posts per day (scope + global), spacing, quiet hours and the LLM budget", async () => {
  await resetLimits();
  const mk = (scope, kind = "question", cost = 0.001) => bot("/api/pepe/feed/post", { scope, title: "Question of the day", body: "Cats or dogs?", kind, cost, userId: U.alice.userId });
  let r = await mk(HOUSE);
  assert.equal(r.status, 429); assert.match(r.d.error, /auto posting is off/);
  await PF.setScope(U.admin, HOUSE, { auto: true, posts_per_day: 2, gap_min: 30, quiet_start: -1, quiet_end: -1 });
  r = await mk(HOUSE);
  assert.equal(r.status, 200, r.text);
  const p = (await getQuery("SELECT * FROM feed_posts WHERE id = ?", [r.d.id]))[0];
  assert.equal(p.author_id, "pepe-bot");
  assert.equal(p.global, 0);
  assert.equal(p.score, 0, "his own vote doesn't count - no self-upvote");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM feed_votes WHERE post_id = ?", [r.d.id]))[0].n, 0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM feed_post_rooms WHERE post_id = ? AND room_id = ?", [r.d.id, HOUSE]))[0].n, 1);
  r = await mk(HOUSE);
  assert.equal(r.status, 429); assert.match(r.d.error, /too soon/);
  clock += 31 * 60e3;
  assert.equal((await mk(HOUSE)).status, 200);
  clock += 31 * 60e3;
  r = await mk(HOUSE);
  assert.equal(r.status, 429); assert.match(r.d.error, /post limit/);
  // global cap beats the scope
  await resetLimits();
  await PF.setGlobal(U.admin, { posts_per_day: 1 });
  await PF.setScope(U.admin, "", { auto: true, posts_per_day: 5, gap_min: 0 });
  assert.equal((await mk("")).status, 200);
  r = await mk("");
  assert.equal(r.status, 429); assert.match(r.d.error, /global post cap/);
  // quiet hours (New York): 12:00 + n hours... set quiet around "now"
  await resetLimits();
  const h = PF.localHour(clock);
  await PF.setScope(U.admin, "", { auto: true, posts_per_day: 5, gap_min: 0, quiet_start: h, quiet_end: (h + 2) % 24 });
  r = await mk("");
  assert.equal(r.status, 429); assert.match(r.d.error, /quiet hours/);
  await PF.setScope(U.admin, "", { quiet_start: (h + 3) % 24, quiet_end: (h + 5) % 24 });
  assert.equal((await mk("")).status, 200);
  // the LLM budget: once the day's reported spend reaches it, nothing more
  await resetLimits();
  await PF.setGlobal(U.admin, { llm_budget_usd: 0.01 });
  await PF.setScope(U.admin, "", { auto: true, posts_per_day: 5, gap_min: 0, quiet_start: -1, quiet_end: -1 });
  assert.equal((await mk("", "news", 0.011)).status, 200, "the call that crosses it is already paid for");
  r = await mk("", "news", 0.001);
  assert.equal(r.status, 429); assert.match(r.d.error, /budget/);
  // master switch
  await resetLimits();
  await PF.setGlobal(U.admin, { enabled: false });
  r = await mk("");
  assert.equal(r.status, 429); assert.match(r.d.error, /switched off/);
  const d = await sync();
  assert.equal(d.mentions.length, 0);
  await resetLimits();
  await PF.setScope(U.admin, "", { ...PF.SCOPE_DEFAULTS });
  await PF.setScope(U.admin, HOUSE, { auto: false });
});

test("gate(): the pure limit check", () => {
  const S = { ...PF.SCOPE_DEFAULTS, respond: true, auto: true, comments_per_day: 3, posts_per_day: 1, max_depth: 2, gap_min: 10 };
  const G = { ...PF.GLOBAL_DEFAULTS };
  const U0 = { posts: 0, comments: 0, cost: 0, last: 0, byScope: {} };
  const t = Date.parse("2026-10-06T16:00:00Z");
  assert.equal(PF.gate("comment", "mention", S, G, U0, { t }), null);
  assert.match(PF.gate("comment", "mention", S, G, U0, { depth: 2, t }), /back-and-forth/);
  assert.match(PF.gate("comment", "mention", { ...S, respond: false }, G, U0, { t }), /mention replies are off/);
  assert.match(PF.gate("post", "mention", S, G, U0, { t }), /auto posting/);
  const U1 = { posts: 0, comments: 3, cost: 0, last: t - 5 * 60e3, byScope: { "": { posts: 0, comments: 3, last: t - 5 * 60e3 } } };
  assert.match(PF.gate("comment", "mention", S, G, U1, { t }), /comment limit/);
  const U2 = { posts: 0, comments: 1, cost: 0, last: t - 5 * 60e3, byScope: { "": { posts: 0, comments: 1, last: t - 5 * 60e3 } } };
  assert.match(PF.gate("comment", "auto", S, G, U2, { t }), /too soon/, "auto: gap_min");
  assert.equal(PF.gate("comment", "mention", S, G, U2, { t }), null, "mentions use reply_gap_secs, not gap_min");
  assert.match(PF.gate("post", "auto", S, G, { ...U0, cost: 0.5 }, { t }), /budget/);
  assert.equal(PF.quietNow({ quiet_start: 22, quiet_end: 6 }, Date.parse("2026-10-07T05:00:00Z")), true, "1 am New York, wraps midnight");
  assert.equal(PF.quietNow({ quiet_start: 22, quiet_end: 6 }, t), false);
  assert.equal(PF.quietNow({ quiet_start: -1, quiet_end: 6 }, t), false);
});

// ───────────────────────────── settings permissions ─────────────────────────────
test("settings: the room owner sets their room; others can't; only admins lock, set the main feed and the global caps", async () => {
  let r = await post(`/api/rooms/${OWNED}/feed/pepe`, U.alice, { settings: { auto: true } });
  assert.equal(r.status, 403);
  r = await post(`/api/rooms/${OWNED}/feed/pepe`, U.owner, { settings: { auto: true, posts_per_day: 99, admin_lock: true, gap_min: 15 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.settings.auto, true);
  assert.equal(r.d.settings.posts_per_day, 20, "clamped");
  assert.equal(r.d.settings.admin_lock, false, "an owner can't lock");
  r = await post(`/api/rooms/${OWNED}/feed/pepe`, U.admin, { settings: { auto: false, admin_lock: true } });
  assert.equal(r.status, 200);
  r = await post(`/api/rooms/${OWNED}/feed/pepe`, U.owner, { settings: { auto: true } });
  assert.equal(r.status, 403); assert.match(r.d.error, /locked/);
  assert.equal((await PF.scopeSettings(OWNED)).auto, false);
  await post(`/api/rooms/${OWNED}/feed/pepe`, U.admin, { settings: { admin_lock: false } });
  // main feed + caps: Admins only (not Staff, not owners)
  assert.equal((await post("/api/feed/admin/pepe", U.owner, { main: { auto: true } })).status, 403);
  assert.equal((await post("/api/feed/admin/pepe", U.staff, { global: { posts_per_day: 50 } })).status, 403);
  r = await post("/api/feed/admin/pepe", U.admin, { global: { posts_per_day: 7, llm_budget_usd: "0.75" }, main: { comments_per_day: 12 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.global.posts_per_day, 7); assert.equal(r.d.global.llm_budget_usd, 0.75); assert.equal(r.d.main.comments_per_day, 12);
  // CSRF-ish guard like the rest of the feed
  assert.equal((await post(`/api/rooms/${OWNED}/feed/pepe`, U.owner, { settings: {} }, { "x-requested-with": "" })).status, 403);
  await resetLimits();
  await PF.setScope(U.admin, "", { ...PF.SCOPE_DEFAULTS });
});

// ───────────────────────────── mute ─────────────────────────────
test("mute Pepe in this thread: author, room owner and staff can; others can't; muted threads are skipped and his writes refused", async () => {
  await resetLimits();
  const pid = await mkPost(U.alice, { body: "pepe chat", rooms: [OWNED] });
  assert.equal((await post(`/api/feed/posts/${pid}/pepe-mute`, U.bob, { on: true })).status, 403);
  assert.equal((await post(`/api/feed/posts/${pid}/pepe-mute`, U.owner, { on: true })).status, 200, "an owner of a room it's in");
  assert.equal(await PF.isMuted(pid), true);
  const cid = await mkComment(U.bob, pid, "pepe?");
  const d = await sync();
  assert.ok(!targets(d).includes("c:" + cid) && !targets(d).includes("p:" + pid));
  const r = await bot("/api/pepe/feed/comment", { post: pid, parent: cid, scope: "", why: "mention", body: "hi" });
  assert.equal(r.status, 409);
  assert.equal((await post(`/api/feed/posts/${pid}/pepe-mute`, U.staff, { on: false })).status, 200);
  assert.equal(await PF.isMuted(pid), false);
  const log = await getQuery("SELECT action, by FROM pepe_feed_log WHERE action IN ('mute','unmute') AND post_id = ?", [pid]);
  assert.deepEqual(log.map((x) => x.action), ["mute", "unmute"]);
});

// ───────────────────────────── rendering ─────────────────────────────
test("render: Pepe's comment and post show his avatar + the 🤖 Pepe badge; the post menu offers the mute; /feed/admin has the log with links", async () => {
  await resetLimits();
  const pid = await mkPost(U.alice, { title: "Render me", body: "pepe say hi" });
  const r = await bot("/api/pepe/feed/comment", { target: "p:" + pid, post: pid, scope: "", why: "mention", body: "hi from the pond" });
  assert.equal(r.status, 200, r.text);
  let html = (await call("GET", "/feed/p/" + pid, U.alice)).text;
  assert.ok(html.includes("🤖 Pepe"), "badge");
  assert.ok(html.includes("/public/img/pepe.png"), "avatar");
  assert.ok(html.includes("hi from the pond"));
  assert.ok(html.includes('data-act="pepe-mute"'), "the author gets the mute item");
  assert.ok(!(await call("GET", "/feed/p/" + pid, U.bob)).text.includes('data-act="pepe-mute"'), "a random viewer doesn't");
  await PF.setScope(U.admin, "", { auto: true, gap_min: 0 });
  const pp = await bot("/api/pepe/feed/post", { scope: "", title: "What went down tonight", body: "A recap.", kind: "recap" });
  assert.equal(pp.status, 200, pp.text);
  html = (await call("GET", "/feed?sort=new", U.bob)).text;
  assert.ok(html.includes("What went down tonight") && html.includes("🤖 Pepe"));
  html = (await call("GET", "/feed/admin", U.admin)).text;
  assert.ok(html.includes("Pepe on the feed"));
  assert.ok(html.includes(`/feed/p/${pid}#c-${r.d.id}`), "the log links to his comment");
  html = (await call("GET", `/p/${OWNED}/settings`, U.owner)).text;
  assert.ok(html.includes("Pepe on this pad's feed") && html.includes('name="respond"'));
  assert.ok(!html.includes('name="admin_lock"'), "owners don't get the lock");
  html = (await call("GET", `/p/${OWNED}/settings`, U.admin)).text;
  assert.ok(html.includes('name="admin_lock"'));
  await PF.setScope(U.admin, "", { ...PF.SCOPE_DEFAULTS });
});

test("auto threads: fresh eligible posts in auto scopes, never his own or ones he already touched; skip retires a target", async () => {
  await resetLimits();
  await PF.setScope(U.admin, "", { auto: true, gap_min: 0 });
  const a = await mkPost(U.alice, { title: "Auto candidate", body: "a fresh post" });
  let d = await sync();
  assert.ok(d.threads.some((x) => x.target === "a:" + a && x.why === "auto"));
  assert.ok(!d.threads.some((x) => x.post.author.pepe), "never his own posts");
  assert.equal((await bot("/api/pepe/feed/skip", { target: "a:" + a, why: "nothing to add", cost: 0.0004 })).status, 200);
  d = await sync();
  assert.ok(!d.threads.some((x) => x.target === "a:" + a));
  assert.equal((await bot("/api/pepe/feed/skip", { target: "zz" })).status, 400);
  await PF.setScope(U.admin, "", { ...PF.SCOPE_DEFAULTS });
});

// ───────────────────────────── 1.99ci: communities only ─────────────────────────────
test("communities: Pepe's All-scope posts land in the Camfrog Lounge; a house room with its own settings is its own scope", async () => {
  await resetLimits();
  await PF.setScope(U.admin, "", { auto: true, posts_per_day: 5, gap_min: 0, quiet_start: -1, quiet_end: -1 });
  const r = await bot("/api/pepe/feed/post", { scope: "", title: "All-scope post", body: "hello everyone", kind: "question", cost: 0.001 });
  assert.equal(r.status, 200, r.text);
  const placed = await getQuery("SELECT room_id FROM feed_post_rooms WHERE post_id = ?", [r.d.id]);
  assert.deepEqual(placed.map((x) => x.room_id), [LOUNGE]);
  assert.equal((await getQuery("SELECT global FROM feed_posts WHERE id = ?", [r.d.id]))[0].global, 0);
  await PF.setScope(U.admin, "", { ...PF.SCOPE_DEFAULTS });
});

// ───────────────────────────── 1.99cq: vision default ON ─────────────────────────────
test("vision: ON by default for All, house and owners' pads; old default rows migrate to ON, explicit offs stay OFF", async () => {
  await resetLimits();
  assert.equal(PF.SCOPE_DEFAULTS.vision, true);
  assert.equal(PF.cleanScope(null).vision, true);
  assert.equal(PF.cleanScope({ vision: false }).vision, true, "an old row's vision:false was just the old default");
  assert.equal(PF.cleanScope({ vision: false, vision_set: true }).vision, false, "an explicit off holds");
  // migration: A only ever held the old default -> ON; B was turned on then off (log shows it) -> OFF kept; C is on
  await store.kvSet("pepe:scope:Mig.A", JSON.stringify({ ...PF.SCOPE_DEFAULTS, vision: false, respond: true }));
  await store.kvSet("pepe:scope:Mig.B", JSON.stringify({ ...PF.SCOPE_DEFAULTS, vision: false, respond: true }));
  await store.kvSet("pepe:scope:Mig.C", JSON.stringify({ ...PF.SCOPE_DEFAULTS, vision: true, respond: true }));
  await runQuery("INSERT INTO pepe_feed_log (at, action, scope, note, by) VALUES (?, 'settings', 'Mig.B', ?, 'plantowner')",
                 [clock - 5000, JSON.stringify({ ...PF.SCOPE_DEFAULTS, vision: true })]);
  await runQuery("INSERT INTO pepe_feed_log (at, action, scope, note, by) VALUES (?, 'settings', 'Mig.A', ?, 'plantowner')",
                 [clock - 4000, JSON.stringify({ ...PF.SCOPE_DEFAULTS, vision: false, respond: true })]);
  await store.kvSet("pepe:vision_v1", "");
  const r = await PF.migrateVisionDefault();
  assert.ok(r.on.includes("Mig.A")); assert.ok(r.kept.includes("Mig.B")); assert.ok(!r.on.includes("Mig.C"));
  assert.equal((await PF.scopeSettings("Mig.A")).vision, true);
  assert.equal((await PF.scopeSettings("Mig.B")).vision, false);
  assert.equal((await PF.scopeSettings("Mig.C")).vision, true);
  assert.equal(await PF.migrateVisionDefault(), null, "runs once");
  // owners' pads default ON too; the form re-sending vision:true doesn't make it explicit, unchecking does
  await store.kvSet("pepe:scope:" + OWNED, "");
  assert.equal((await PF.scopeSettings(OWNED)).vision, true);
  await PF.setScope(U.owner, OWNED, { respond: true, vision: true });
  assert.ok(!(await PF.scopeSettings(OWNED)).vision_set);
  await PF.setScope(U.owner, OWNED, { respond: true, vision: false });
  assert.equal((await PF.scopeSettings(OWNED)).vision, false);
  await PF.setScope(U.owner, OWNED, { respond: true, comments_per_day: 5, vision: false });
  assert.equal((await PF.scopeSettings(OWNED)).vision, false, "an explicit off survives later saves");
  // the work items carry it: a mention under All has vision on
  await PF.setScope(U.admin, "", { ...PF.SCOPE_DEFAULTS });
  const pid = await mkPost(U.alice, { body: "pepe look at this" });
  const d = await sync();
  const m = d.mentions.find((x) => x.target === "p:" + pid);
  assert.ok(m); assert.equal(m.vision, true);
  await PF.setScope(U.owner, OWNED, { respond: false, vision: true });
});

test("vision: a crosspost carries its original's pictures (site media URL) and text; an NSFW original keeps him out", async () => {
  const orig = await mkPost(U.alice, { title: "Faded", body: "selfie" });
  await runQuery(`INSERT INTO feed_attachments (id, post_id, owner_id, kind, ct, file, thumb, w, h, state, created) VALUES (?, ?, ?, 'image', 'image/webp', ?, ?, 800, 600, 'ready', ?)`,
                 ["att_x1", orig, U.alice.userId, "aaaaaaaaaaaaaaaa.webp", "aaaaaaaaaaaaaaaa_t.webp", clock]);
  const r = await post(`/api/feed/posts/${orig}/crosspost`, U.bob, { community: OTHER });
  assert.equal(r.status, 200, r.text);
  const x = await store.getRow(r.d.id);
  assert.equal(x.crosspost_of, orig);
  const v = await PF.postView(x);
  assert.equal(v.images.length, 1);
  assert.match(v.images[0].url, /\/feed\/f\/aaaaaaaaaaaaaaaa_t\.webp$/, "the site's own re-encoded webp");
  assert.equal(v.title, "Faded"); assert.equal(v.body, "selfie");
  assert.equal(v.crosspost.author.username, "alice");
  assert.ok(await PF.postScopes(x));
  await runQuery("UPDATE feed_posts SET nsfw_admin = 1 WHERE id = ?", [orig]);
  assert.equal(await PF.postScopes(x), null, "an NSFW original: the crosspost is off-limits too");
  await runQuery("UPDATE feed_posts SET nsfw_admin = NULL WHERE id = ?", [orig]);
});

// ───────────────────────────── 1.99cu: mentions default ON everywhere ─────────────────────────────
test("respond: old default-off rows migrate to ON, explicit offs (seen in the log) stay OFF, runs once", async () => {
  await resetLimits();
  assert.equal(PF.cleanScope({ respond: false }).respond, undefined, "an old row's respond:false was just the old default");
  assert.equal(PF.cleanScope({ respond: false, respond_set: true }).respond, false, "an explicit off holds");
  await store.kvSet("pepe:scope:Resp.A", JSON.stringify({ ...PF.SCOPE_DEFAULTS, respond: false }));
  await store.kvSet("pepe:scope:Resp.B", JSON.stringify({ ...PF.SCOPE_DEFAULTS, respond: false }));
  await store.kvSet("pepe:scope:Resp.C", JSON.stringify({ ...PF.SCOPE_DEFAULTS, respond: true }));
  await runQuery("INSERT INTO pepe_feed_log (at, action, scope, note, by) VALUES (?, 'settings', 'Resp.B', ?, 'plantowner')",
                 [clock - 5000, JSON.stringify({ ...PF.SCOPE_DEFAULTS, respond: true })]);
  await runQuery("INSERT INTO pepe_feed_log (at, action, scope, note, by) VALUES (?, 'settings', 'Resp.A', ?, 'plantowner')",
                 [clock - 4000, JSON.stringify({ ...PF.SCOPE_DEFAULTS, respond: false })]);
  await store.kvSet("pepe:respond_v1", "");
  const r = await PF.migrateRespondDefault();
  assert.ok(r.on.includes("Resp.A")); assert.ok(r.kept.includes("Resp.B")); assert.ok(!r.on.includes("Resp.C") && !r.kept.includes("Resp.C"));
  assert.equal((await PF.scopeSettings("Resp.A")).respond, true);
  assert.equal((await PF.scopeSettings("Resp.B")).respond, false);
  assert.equal((await PF.scopeSettings("Resp.C")).respond, true);
  assert.equal(JSON.parse(await store.kvGet("pepe:scope:Resp.C")).respond_set, true, "a stored ON is marked explicit");
  assert.equal(await PF.migrateRespondDefault(), null, "runs once");
});

test("crossposts: mentions on the original and on a crosspost are each answered in their own thread, never twice", async () => {
  await resetLimits();
  await PF.setScope(U.owner, OWNED, { respond: true });
  const orig = await mkPost(U.alice, { title: "Hot take @pepe", body: "thoughts?", community: OTHER });
  const xr = await post(`/api/feed/posts/${orig}/crosspost`, U.bob, { community: LOUNGE });
  assert.equal(xr.status, 200, xr.text);
  const xpost = xr.d.id;
  const xr2 = await post(`/api/feed/posts/${orig}/crosspost`, U.bob, { community: OWNED, title: "pepe what do you make of this" });
  assert.equal(xr2.status, 200, xr2.text);
  const xpost2 = xr2.d.id;
  const c1 = await mkComment(U.bob, orig, "@pepe on the original");
  const c2 = await mkComment(U.alice, xpost, "@pepe on the crosspost");
  const d = await sync();
  const t = targets(d);
  assert.ok(t.includes("p:" + orig), "the original's own mention");
  assert.ok(!t.includes("p:" + xpost), "a crosspost with the original's title is not a second mention");
  assert.ok(t.includes("p:" + xpost2), "a crosspost with its own title mentioning him is its own");
  const m1 = d.mentions.find((x) => x.target === "c:" + c1), m2 = d.mentions.find((x) => x.target === "c:" + c2);
  assert.ok(m1 && m2);
  assert.equal(m1.post.id, orig, "answered in the original's thread");
  assert.equal(m2.post.id, xpost, "answered in the crosspost's thread");
  assert.equal(new Set(t).size, t.length, "no target offered twice");
});

// ───────────────────────────── 1.99cu: richer reply context ─────────────────────────────
test("context: the whole thread (oldest first, target + Pepe's lines marked), siblings, exclusions, crosspost pads", async () => {
  await resetLimits();
  const pid = await mkPost(U.alice, { title: "Thread test", body: "the post", community: OTHER });
  const top = await mkComment(U.bob, pid, "top level opinion");
  clock += 1000;
  const r1 = await mkComment(U.alice, pid, "a reply", top);
  clock += 1000;
  await runQuery("INSERT INTO feed_comments (id, post_id, parent_id, author_id, body, created) VALUES (?, ?, ?, ?, ?, ?)",
                 ["pepeline01", pid, top, store.PEPE_ID, "Pepe said this earlier", clock]);
  clock += 1000;
  const hid = await mkComment(U.troll, pid, "hidden one", top);
  await runQuery("UPDATE feed_comments SET hidden_at = ? WHERE id = ?", [clock, hid]);
  clock += 1000;
  const del = await mkComment(U.troll, pid, "deleted one", top);
  await runQuery("UPDATE feed_comments SET deleted_at = ? WHERE id = ?", [clock, del]);
  clock += 1000;
  const rep = await mkComment(U.troll, pid, "reported one", top);
  await runQuery("INSERT INTO feed_reports (post_id, comment_id, reporter_id, reason, created) VALUES (?, ?, ?, 'spam', ?)", [pid, rep, U.alice.userId, clock]);
  clock += 1000;
  const tgt = await mkComment(U.bob, pid, "@pepe what do you think", top);
  const sib = await mkComment(U.alice, pid, "a different conversation");
  // deterministic order (comments take the store's clock): top < r1 < Pepe's line < hidden/deleted/reported < target
  const order = [top, r1, "pepeline01", hid, del, rep, tgt];
  for (let i = 0; i < order.length; i++) await runQuery("UPDATE feed_comments SET created = ? WHERE id = ?", [clock - 60000 + i * 1000, order[i]]);
  const conv = await PF.conversation(pid, top, tgt);
  assert.deepEqual(conv.map((c) => c.id), [top, r1, "pepeline01", tgt], "oldest first; hidden, deleted and reported left out");
  assert.equal(conv.find((c) => c.id === "pepeline01").author.pepe, true, "Pepe's own line is marked");
  assert.equal(conv.find((c) => c.id === tgt).target, true);
  assert.equal(conv.filter((c) => c.target).length, 1);
  assert.equal(conv.find((c) => c.id === r1).parent, top);
  const others = await PF.otherComments(pid, top);
  assert.deepEqual(others.map((c) => c.id), [sib], "siblings: the other top-level conversations only");
  const d = await sync();
  const m = d.mentions.find((x) => x.target === "c:" + tgt);
  assert.ok(m, "offered");
  assert.deepEqual(m.thread.map((c) => c.id), [top, r1, "pepeline01", tgt]);
  assert.deepEqual(m.others.map((c) => c.id), [sib]);
  assert.equal(m.reply_to.parent, top);
  assert.equal(m.post.pad.title, "Side Room");
  // a crosspost: the original's content, its pad, and the crossposting pad
  const xr = await post(`/api/feed/posts/${pid}/crosspost`, U.bob, { community: LOUNGE, title: "look at this" });
  assert.equal(xr.status, 200, xr.text);
  const v = await PF.postView(await store.getRow(xr.d.id));
  assert.equal(v.source_id, pid);
  assert.equal(v.body, "the post");
  assert.equal(v.crosspost.title, "Thread test");
  assert.equal(v.crosspost.pad.title, "Side Room");
  assert.ok(v.pad && v.pad.slug, "the crossposting pad");
  assert.notEqual(v.pad.title, "Side Room");
});
