// 1.99kk: @mentions and #hashtags in feed posts AND comments (feedmentions.js) - one code path for both.
//   - parsing (emails, entities, numbers), rendering on escaped html (known accounts only, never inside links)
//   - notices: comments and posts, edits only for new names, no self / Pepe / blocked / can't-see / pending posts,
//     the "@mentions" preference + mute, no double notice for the post's author, rate limits
//   - the autocomplete endpoint; the post page renders the links
//   NODE_PATH=G:/PATV/node_modules node --test test/feed-mentions.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "feed-mentions-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const web = require(path.join(repo, "feedweb"));
const FM = require(path.join(repo, "feedmentions"));
const MN = require(path.join(repo, "mentions"));
const PA = require(path.join(repo, "padaccess"));
require(path.join(repo, "terms"))._setRequired(false);

const ROOM_B = "plant_based_chatting", ROOM_S = "Secret.Room";
let base, server;
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
const notices = async (u) => getQuery("SELECT * FROM inbox WHERE user_id = ? AND kind = 'mention' ORDER BY id", [u.userId]);

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery(`CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ct TEXT NOT NULL, file TEXT NOT NULL, bytes INTEGER, secs REAL, subject TEXT,
                  by_user TEXT, room TEXT, created INTEGER, expires INTEGER, deleted INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE dm_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (blocker_id, blocked_id))");
  U.owner = await mkUser("plantowner");
  U.alice = await mkUser("alice", { display: "Alice A" });
  U.bob = await mkUser("bob");
  U.cat = await mkUser("cat");
  U.dan = await mkUser("dan");
  U.eve = await mkUser("eve");
  U.gone = await mkUser("gone");
  await runQuery("UPDATE users SET archived_at = 1 WHERE userId = ?", [U.gone.userId]);
  await rooms.init();
  await rooms.setOwner(ROOM_B, "plantowner", "test");
  await rooms.addRoom(ROOM_S, "Secret", "test");
  await rooms.setOwner(ROOM_S, "plantowner", "test");
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0, comments_per_hour: 1000 }, "test");
  await PA.init();
  await PA.setLevel(U.owner, await rooms.get(ROOM_S), "approved");
  await MN.init();
  require(path.join(repo, "pads"))._setNames(new Map([...users.values()].map((u) => [u.username.toLowerCase(), u.username])));
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; res.locals.ogPath = req.originalUrl.split("?")[0]; next(); });
  require(path.join(repo, "pads")).register(app);
  PA.register(app, { addUser });
  web.register(app, { addUser, isBotToken: (x) => x === "bot" });
  FM.register(app, { addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });
test.beforeEach(() => { store._gaps.clear(); FM._reset(); });

test("parsing: @names (not emails), #hashtags (not entities / numbers), distinct, capped", () => {
  assert.deepEqual(FM.names("hi @Bob and @alice, @bob again; mail me at x@bob.com"), ["bob", "alice"]);
  assert.deepEqual(FM.names("(@cat) @dan. @eve!"), ["cat", "dan", "eve"]);
  assert.deepEqual(FM.names("no@one here"), []);
  assert.equal(FM.names(Array.from({ length: 20 }, (_, i) => "@user" + i).join(" ")).length, FM.MAX_NAMES);
  assert.deepEqual(FM.hashtags("#Plant_Care and #diy, not #1 or a&#39;b; #diy again"), ["plant-care", "diy"]);
});

test("rendering: known names link to the profile, hashtags to the tag page; never inside links; text stays escaped", () => {
  const known = (n) => ({ bob: "bob", alice: "alice" }[n.toLowerCase()] || null);
  const h = FM.inlineRefs("hey @Bob, @nobody #Plants &#39;#x&lt;b&gt; #1", known);
  assert.match(h, /<a class="user-ref mention" href="\/u\/bob">@Bob<\/a>/);
  assert.doesNotMatch(h, /@nobody</, "unknown names stay text");
  assert.ok(h.includes("@nobody"));
  assert.match(h, /<a class="tag-ref" href="\/feed\?tag=plants">#Plants<\/a>/);
  assert.ok(h.includes("&#39;#x&lt;b&gt;"), "an entity's # isn't a tag and nothing is unescaped");
  assert.ok(h.includes(" #1"), "#1 stays text");
  const inLink = FM.inlineRefs('<a href="https://x.y/#frag">https://x.y/#frag @bob</a> #out', known);
  assert.ok(inLink.startsWith('<a href="https://x.y/#frag">https://x.y/#frag @bob</a>'), "link text untouched");
  assert.match(inLink, /<a class="tag-ref" href="\/feed\?tag=out">#out<\/a>$/);
  // through the feed's renderer (posts AND comments use fx.body): URLs keep their fragment, the rest is linked
  const b = web.fx.body("see https://example.com/#top @alice #monstera <b>");
  assert.match(b, /href="https:\/\/example.com\/#top"/);
  assert.match(b, /<a class="user-ref mention" href="\/u\/alice">@alice<\/a>/);
  assert.match(b, /<a class="tag-ref" href="\/feed\?tag=monstera">#monstera<\/a>/);
  assert.ok(b.includes("&lt;b&gt;"));
});

let P1;
test("a comment's @mentions notify (once), never the commenter, Pepe, an archived account, or the post's author twice", async () => {
  P1 = await store.create(U.alice.userId, { community: ROOM_B, title: "Monstera", body: "help me @bob" });
  let n = await notices(U.bob);
  assert.equal(n.length, 1, "the post's own mention");
  assert.match(n[0].title, /Alice A mentioned you in a post/);
  assert.ok(n[0].link.includes(P1.id));
  const c = await store.comment(U.cat, P1.id, { body: "@alice @cat @gone @dan look #monstera" });
  assert.equal((await notices(U.alice)).length, 0, "alice got 'commented on your post', not a mention too");
  assert.equal((await notices(U.cat)).length, 0, "no self-mention");
  assert.equal((await notices(U.gone)).length, 0, "archived");
  const d = await notices(U.dan);
  assert.equal(d.length, 1);
  assert.match(d[0].title, /cat mentioned you in a comment/);
  assert.ok(d[0].link.endsWith("#c-" + c.id));
  // an edit: only new names; the same comment never notifies the same person twice
  await store.editComment(U.cat, c.id, "@dan @eve");
  assert.equal((await notices(U.dan)).length, 1, "dan not again");
  assert.equal((await notices(U.eve)).length, 1, "eve is new");
  await store.editComment(U.cat, c.id, "@eve");
  await store.editComment(U.cat, c.id, "@dan @eve");
  assert.equal((await notices(U.dan)).length, 1, "removing and re-adding doesn't re-notify (same ref)");
});

test("blocks either way, the @mentions preference and the mute stop notices", async () => {
  await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, 1)", [U.eve.userId, U.cat.userId]);
  const before = (await notices(U.eve)).length;
  await store.comment(U.cat, P1.id, { body: "@eve hi" });
  assert.equal((await notices(U.eve)).length, before, "eve blocked cat");
  await store.comment(U.eve, P1.id, { body: "@cat hi" });
  assert.equal((await notices(U.cat)).length, 0, "cat is blocked by eve - no notice the other way either");
  await MN.save(U.dan.userId, { enabled: false, names: true, words: [], quiet: null, feed: false });
  const g = await MN.get(U.dan.userId);
  assert.equal(g.prefs.feed, false);
  const dn = (await notices(U.dan)).length;
  await store.comment(U.bob, P1.id, { body: "@dan you there?" });
  assert.equal((await notices(U.dan)).length, dn, "dan turned @mentions off");
  await MN.save(U.dan.userId, { enabled: false, names: true, words: [], quiet: null });     // feed omitted: kept off
  assert.equal((await MN.get(U.dan.userId)).prefs.feed, false);
  await MN.save(U.dan.userId, { enabled: false, names: true, words: [], quiet: null, feed: true });
  await MN.mute(U.dan.userId, 60);
  await store.comment(U.bob, P1.id, { body: "@dan muted?" });
  assert.equal((await notices(U.dan)).length, dn, "muted");
  await MN.mute(U.dan.userId, 0);
  await store.comment(U.bob, P1.id, { body: "@dan now?" });
  assert.equal((await notices(U.dan)).length, dn + 1);
});

test("privacy: nobody is told about a post they can't see (an Approved pad they're outside of)", async () => {
  const S = await store.create(U.owner.userId, { community: ROOM_S, title: "inside", body: "hi @bob and @plantowner" });
  const before = (await notices(U.bob)).length;
  await store.comment(U.owner, S.id, { body: "@bob come in" });
  assert.equal((await notices(U.bob)).length, before, "bob can't see the Approved pad's post");
});

test("post edits notify only names added by the edit; rate limits cap one author", async () => {
  const P = await store.create(U.bob.userId, { community: ROOM_B, title: "edit me", body: "hello" });
  await store.edit(U.bob, P.id, { body: "hello @cat" });
  assert.equal((await notices(U.cat)).length, 1);
  await store.edit(U.bob, P.id, { body: "hello @cat again" });
  assert.equal((await notices(U.cat)).length, 1);
  // PAIR_HOUR: one author -> one person, a few times an hour at most
  for (let i = 0; i < FM.PAIR_HOUR + 3; i++) await store.comment(U.bob, P1.id, { body: "@cat ping " + i });
  assert.equal((await notices(U.cat)).length, FM.PAIR_HOUR, "the edit's notice + the comments, capped at PAIR_HOUR an hour");
});

test("autocomplete: signed in + same-site fetch; prefix on username or display name; never archived accounts", async () => {
  let r = await call("GET", "/api/mentions/suggest?q=al", U.bob);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.d.people.map((p) => p.username), ["alice"]);
  assert.equal(r.d.people[0].display, "Alice A");
  r = await call("GET", "/api/mentions/suggest?q=go", U.bob);
  assert.deepEqual(r.d.people, [], "archived");
  r = await call("GET", "/api/mentions/suggest?q=%25", U.bob);
  assert.deepEqual(r.d.people, [], "wildcards aren't searched");
  r = await call("GET", "/api/mentions/suggest?q=al", null);
  assert.equal(r.status, 401);
  const x = await fetch(base + "/api/mentions/suggest?q=al", { headers: { "x-test-user": U.bob.userId } });
  assert.equal(x.status, 403, "needs X-Requested-With");
});

test("the post page links the mentions and hashtags in the post and its comments", async () => {
  await store.comment(U.dan, P1.id, { body: "same here #monstera" });
  const r =await fetch(base + P1.url, { headers: { "x-test-user": U.bob.userId } });
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.match(html, /<a class="user-ref mention" href="\/u\/bob">@bob<\/a>/);
  assert.match(html, /<a class="tag-ref" href="\/feed\?tag=monstera">#monstera<\/a>/);
  assert.match(html, /mention-complete\.js/);
});
