// Offline tests for 1.99bx: up/down votes on posts and comments (state machine, own-content rules, new-account
// downvotes, rate limits, cache consistency under concurrent votes), the ranking maths (Reddit hot, controversy,
// Wilson), sorts + time filters, the 1.99bw -> 1.99bx migration, room-owner moderation (reports queue, pins,
// locks, room NSFW, approval queue, settings, bans, comment removal, audit) and the rendered pages.
//   NODE_PATH=G:/PATV/node_modules node --test test/feed-votes.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "feedvote-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
const express = require("express");
const ejs = require("ejs");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const web = require(path.join(repo, "feedweb"));
require(path.join(repo, "terms"))._setRequired(false);   // 1.99cc: the Terms gate has its own tests (tos-reports.test.js)

const ROOM_A = "PepeFrog.Room", ROOM_B = "plant_based_chatting", ROOM_C = "Side.Room";
let base, server, U = {}, OLD = null;
const users = new Map();

async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, ?, ?, ?, ?, 0)`,
                 [id, name, extra.display || name, extra.class || "pleb", 0, extra.camfrog || null, extra.level || 0, extra.created || "2026-01-01 00:00:00"]);
  const u = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, u);
  return u;
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery(`CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ct TEXT NOT NULL, file TEXT NOT NULL, bytes INTEGER, secs REAL, subject TEXT,
                  by_user TEXT, room TEXT, created INTEGER, expires INTEGER, deleted INTEGER DEFAULT 0)`);
  // a 1.99bw database: upvote-only votes and a cached score, no ups/downs/hot columns
  await runQuery(`CREATE TABLE feed_posts (
        id TEXT PRIMARY KEY, author_id TEXT NOT NULL, title TEXT, body TEXT, link_url TEXT, link_json TEXT,
        nsfw INTEGER NOT NULL DEFAULT 0, nsfw_admin INTEGER, global INTEGER NOT NULL DEFAULT 1,
        score INTEGER NOT NULL DEFAULT 0, comments INTEGER NOT NULL DEFAULT 0, cost INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL, edited INTEGER, deleted_at INTEGER, deleted_by TEXT, delete_reason TEXT, hidden_at INTEGER, purged_at INTEGER)`);
  await runQuery("CREATE TABLE feed_votes (post_id TEXT NOT NULL, user_id TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 1, created INTEGER, PRIMARY KEY (post_id, user_id))");
  await runQuery(`CREATE TABLE feed_comments (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, parent_id TEXT, author_id TEXT NOT NULL, body TEXT NOT NULL,
        created INTEGER NOT NULL, edited INTEGER, deleted_at INTEGER, deleted_by TEXT)`);
  OLD = { id: "oldpost00001", created: Date.now() - 5 * 3600e3 };
  await runQuery("INSERT INTO feed_posts (id, author_id, body, score, created) VALUES (?, 'u_alice', 'from 1.99bw', 3, ?)", [OLD.id, OLD.created]);
  for (const u of ["u_bob", "u_carol", "u_x"]) await runQuery("INSERT INTO feed_votes (post_id, user_id, value, created) VALUES (?, ?, 1, ?)", [OLD.id, u, OLD.created]);

  U.ownerB = await mkUser("plantowner", { camfrog: "foamy1111" });
  U.ownerC = await mkUser("sideowner", { camfrog: "sidecf" });
  U.admin = await mkUser("boss", { class: "Admin", camfrog: "bossfrog" });
  U.alice = await mkUser("alice", { camfrog: "alicecf" });
  U.bob = await mkUser("bob", { camfrog: "bobcf" });
  U.carol = await mkUser("carol", { camfrog: "carolcf" });
  U.newbie = await mkUser("newbie", { created: new Date().toISOString().replace("T", " ").slice(0, 19) });   // unlinked, level 0
  U.lvl = await mkUser("leveled", { level: 3 });
  U.evil = await mkUser("evil", { display: "<img src=x onerror=alert(1)>", camfrog: "evilcf" });
  for (let i = 0; i < 40; i++) await mkUser("v" + i, { camfrog: "vcf" + i });
  await rooms.init();
  await rooms.setOwner(ROOM_B, "plantowner", "test");
  await rooms.addRoom(ROOM_C, "Side Room", "test");
  await rooms.setOwner(ROOM_C, "sideowner", "test");
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0, comments_per_hour: 1000 }, "test");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  web.register(app, { addUser, isBotToken: (t) => t === "bot" });
  require(path.join(repo, "pads")).register(app);                       // 1.99dc: /p/<s>/mod -> the settings hub
  require(path.join(repo, "padsettings")).register(app, { addUser });   // 1.99dc: the pad settings hub
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });
test.beforeEach(() => { store._gaps.clear(); store._votes.clear(); });

const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {});
// 1.99ci: every post lives in exactly one community - tests post to the Camfrog Lounge unless they pick one
// (community / rooms set), or send noCommunity: true to test the refusal.
const LOUNGE = "patv:lounge";
const withCommunity = (url, body) => (url === "/api/feed/posts" && body && typeof body === "object" && body.community === undefined && !body.rooms && !body.noCommunity
  ? { ...body, community: LOUNGE } : body);
async function call(method, url, u, body) {
  body = withCommunity(url, body);
  const r = await fetch(base + url, { method, headers: H(u), body: body === undefined ? undefined : JSON.stringify(body) });
  let d = null;
  try { d = await r.json(); } catch (e) { d = null; }
  return { status: r.status, d };
}
const post = (url, u, body) => call("POST", url, u, body);
const page = async (url, u) => { const r = await fetch(base + url, { headers: u ? { "x-test-user": u.userId } : {} }); return { status: r.status, html: await r.text() }; };
// 1.99ci: a post is created in ONE community; posts made to several rooms at once (1.99bw-1.99cf) still exist,
// so a test asking for more rooms gets the first through the API and the others as such legacy placements
const mkPost = async (u, body) => {
  const extra = body && Array.isArray(body.rooms) ? body.rooms.slice(1) : [];
  const r = await post("/api/feed/posts", u, extra.length ? { ...body, rooms: body.rooms.slice(0, 1) } : body);
  assert.equal(r.status, 200, JSON.stringify(r.d));
  for (const rid of extra) await runQuery("INSERT OR IGNORE INTO feed_post_rooms (post_id, room_id, created, pending) VALUES (?, ?, ?, 0)", [r.d.id, rid, Date.now()]);
  return r.d.id;
};
const vote = async (u, id, dir) => { store._gaps.clear(); return post(`/api/feed/posts/${id}/vote`, u, dir === undefined ? {} : { dir }); };
const row = async (id) => (await getQuery("SELECT * FROM feed_posts WHERE id = ?", [id]))[0];
const near = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const mod = (u, slug, body) => post(`/api/rooms/${slug}/feed/mod`, u, body);

// ───────────────────────────── migration ─────────────────────────────
test("migration: 1.99bw upvotes become +1, ups/downs/score/hot backfilled, idempotent", async () => {
  const r = await row(OLD.id);
  assert.deepEqual([r.ups, r.downs, r.score], [3, 0, 3]);
  assert.equal(r.hot, store.hotRank(3, OLD.created));
  const v = await getQuery("SELECT value, w, updated FROM feed_votes WHERE post_id = ?", [OLD.id]);
  assert.ok(v.every((x) => x.value === 1 && x.w === 1 && x.updated === OLD.created));
  assert.equal(await getQuery("SELECT value FROM feed_kv WHERE key = 'votes_v2'").then((x) => x[0].value), "1");
  // a second start doesn't redo it (and keeps the numbers)
  await store.recountPost(OLD.id);
  assert.equal((await row(OLD.id)).score, 3);
});

// ───────────────────────────── maths ─────────────────────────────
test("hot: Reddit's formula against known values; the decay is admin-tunable and re-ranks stored posts", async () => {
  const E = store.HOT_EPOCH * 1000;
  assert.equal(store.hotRank(1, E), 0);
  assert.equal(store.hotRank(0, E), 0);
  assert.equal(store.hotRank(10, E), 1);
  assert.equal(store.hotRank(1000, E), 3);
  assert.equal(store.hotRank(-100, E), -2);
  assert.equal(store.hotRank(1, E + 45000e3), 1, "12.5 hours later = one order of magnitude");
  assert.equal(store.hotRank(10, E + 45000e3), 2);
  near(store.hotRank(5, E + 1000e3), Math.log10(5) + 1000 / 45000, 1e-7);
  assert.equal(store.hotRank(10, E + 3600e3, 3600), 2, "custom decay");
  // a real date: 2026-10-06 00:00 UTC, 25 points
  const t = Date.UTC(2026, 9, 6);
  near(store.hotRank(25, t), Math.round((Math.log10(25) + (t / 1000 - 1134028003) / 45000) * 1e7) / 1e7, 1e-9);
  // tuning the decay rewrites every stored hot
  await store.setConfig({ hot_decay_secs: 90000 }, "test");
  assert.equal((await row(OLD.id)).hot, store.hotRank(3, OLD.created, 90000));
  await store.setConfig({ hot_decay_secs: 45000 }, "test");
  assert.equal((await row(OLD.id)).hot, store.hotRank(3, OLD.created, 45000));
  assert.equal(store.config().hot_decay_secs, 45000);
});

test("controversy and Wilson (Best) against known values", () => {
  assert.equal(store.controversy(0, 0), 0);
  assert.equal(store.controversy(10, 0), 0);
  assert.equal(store.controversy(0, 10), 0);
  assert.equal(store.controversy(10, 10), 20);
  near(store.controversy(100, 1), Math.pow(101, 0.01));
  near(store.controversy(5, 10), Math.pow(15, 0.5));
  assert.ok(store.controversy(50, 50) > store.controversy(90, 10), "balanced beats lopsided at the same size");
  assert.ok(store.controversy(50, 50) > store.controversy(5, 5), "bigger beats smaller at the same balance");
  assert.equal(store.wilson(0, 0), 0);
  near(store.wilson(1, 0), 0.37844);
  near(store.wilson(10, 0), 0.85893);
  near(store.wilson(5, 5), 0.31221);
  assert.ok(store.wilson(10, 1) > store.wilson(1, 0), "10 up / 1 down is surer than 1 up");
  assert.ok(store.wilson(100, 10) > store.wilson(10, 1));
});

// ───────────────────────────── votes ─────────────────────────────
test("the author starts at +1, can take it back, and can't downvote their own post", async () => {
  const id = await mkPost(U.alice, { body: "mine" });
  let r = await row(id);
  assert.deepEqual([r.ups, r.downs, r.score], [1, 0, 1]);
  assert.equal((await store.get(id, U.alice)).myVote, 1);
  const d = await vote(U.alice, id, -1);
  assert.equal(d.status, 403);
  assert.match(d.d.error, /can't downvote your own post/);
  assert.equal((await vote(U.alice, id, 0)).d.score, 0);
  assert.equal((await vote(U.alice, id, 1)).d.score, 1);
  assert.equal((await vote(U.alice, id)).d.vote, 0, "the legacy toggle takes the upvote back too");
});

test("vote state machine: up -> down -> none, idempotent, one row per user, score = ups - downs", async () => {
  const id = await mkPost(U.alice, { body: "vote on me" });
  let r = await vote(U.bob, id, 1);
  assert.deepEqual([r.d.vote, r.d.ups, r.d.downs, r.d.score], [1, 2, 0, 2]);
  r = await vote(U.bob, id, 1);                                        // again: nothing changes
  assert.deepEqual([r.d.vote, r.d.score], [1, 2]);
  r = await vote(U.bob, id, -1);                                       // up -> down
  assert.deepEqual([r.d.vote, r.d.ups, r.d.downs, r.d.score], [-1, 1, 1, 0]);
  r = await vote(U.bob, id, 0);                                        // down -> none
  assert.deepEqual([r.d.vote, r.d.ups, r.d.downs, r.d.score], [0, 1, 0, 1]);
  r = await vote(U.bob, id, -1);                                       // none -> down
  assert.deepEqual([r.d.vote, r.d.score], [-1, 0]);
  r = await vote(U.bob, id);                                           // {} = toggle the upvote (1.99bw clients)
  assert.deepEqual([r.d.vote, r.d.score], [1, 2]);
  r = await vote(U.bob, id, "garbage");
  assert.equal(r.d.vote, 0, "anything that isn't a positive/negative number is 'no vote'");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM feed_votes WHERE post_id = ? AND user_id = ?", [id, U.bob.userId]))[0].n, 0);
  const x = await row(id);
  assert.equal(x.hot, store.hotRank(x.score, x.created));
  assert.equal((await vote(null, id, 1)).status, 401);
  assert.equal((await vote(U.bob, "nopenopenope", 1)).status, 404);
});

test("new accounts: a downvote is stored but only counts from level 2 or a linked Camfrog name", async () => {
  const id = await mkPost(U.alice, { body: "brigade target" });
  let r = await vote(U.newbie, id, -1);
  assert.deepEqual([r.d.vote, r.d.counted, r.d.score, r.d.downs], [-1, false, 1, 0]);
  assert.equal((await store.get(id, U.newbie)).myVote, -1, "they still see their downvote");
  r = await vote(U.newbie, id, 1);                                     // their UPvotes count
  assert.deepEqual([r.d.counted, r.d.score], [true, 2]);
  r = await vote(U.lvl, id, -1);                                       // level 3, unlinked
  assert.deepEqual([r.d.counted, r.d.score], [true, 1]);
  r = await vote(U.carol, id, -1);                                     // linked
  assert.deepEqual([r.d.counted, r.d.score, r.d.downs], [true, 0, 2]);
  await store.setConfig({ downvote_min_level: 5 }, "test");
  r = await vote(U.lvl, id, 0); r = await vote(U.lvl, id, -1);
  assert.equal(r.d.counted, false, "level 3 < 5");
  await store.setConfig({ downvote_min_level: 2 }, "test");
});

test("vote spam: per-minute and per-hour limits on vote changes; repeats don't count; feed-banned accounts can't vote", async () => {
  await store.setConfig({ votes_per_min: 4, votes_per_hour: 6 }, "test");
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await mkPost(U.alice, { body: "spam " + i }));
  for (const id of ids) assert.equal((await vote(U.bob, id, 1)).status, 200);
  assert.equal((await vote(U.bob, ids[0], 1)).status, 200, "a repeat of the same vote is free");
  const r = await vote(U.bob, ids[0], -1);
  assert.equal(r.status, 429);
  assert.match(r.d.error, /very fast/);
  let t = Date.now() + 61e3;
  store._setClock(() => t);
  assert.equal((await vote(U.bob, ids[0], -1)).status, 200);
  assert.equal((await vote(U.bob, ids[1], -1)).status, 200);
  const h = await vote(U.bob, ids[2], -1);
  assert.equal(h.status, 429);
  assert.match(h.d.error, /this hour/);
  t += 3601e3;
  assert.equal((await vote(U.bob, ids[2], -1)).status, 200);
  store._setClock(() => Date.now());
  await store.setConfig({ votes_per_min: 30, votes_per_hour: 300 }, "test");
  await runQuery("INSERT INTO feed_bans (user_id, room_id, username, at) VALUES (?, '', 'carol', ?)", [U.carol.userId, Date.now()]);
  assert.equal((await vote(U.carol, ids[3], 1)).status, 403);
  await runQuery("DELETE FROM feed_bans WHERE user_id = ?", [U.carol.userId]);
});

test("cached counts stay exact under concurrent votes (40 voters at once, then flips)", async () => {
  const id = await mkPost(U.alice, { body: "race" });
  const voters = [...users.values()].filter((u) => /^v\d+$/.test(u.username));
  const dirs = voters.map((_, i) => (i % 3 === 0 ? -1 : 1));
  let rs = await Promise.all(voters.map((u, i) => post(`/api/feed/posts/${id}/vote`, u, { dir: dirs[i] })));
  assert.ok(rs.every((r) => r.status === 200));
  const check = async () => {
    const v = await getQuery("SELECT SUM(value = 1 AND w = 1) AS u, SUM(value = -1 AND w = 1) AS d FROM feed_votes WHERE post_id = ?", [id]);
    const r = await row(id);
    assert.deepEqual([r.ups, r.downs, r.score], [v[0].u, v[0].d, v[0].u - v[0].d]);
    assert.equal(r.hot, store.hotRank(r.score, r.created));
    assert.equal(r.controversy, store.controversy(r.ups, r.downs));
    return r;
  };
  let r = await check();
  assert.deepEqual([r.ups, r.downs], [1 + dirs.filter((d) => d > 0).length, dirs.filter((d) => d < 0).length]);
  store._gaps.clear();
  rs = await Promise.all(voters.map((u, i) => post(`/api/feed/posts/${id}/vote`, u, { dir: i % 2 ? 0 : -dirs[i] })));
  assert.ok(rs.every((x) => x.status === 200));
  await check();
});

// ───────────────────────────── sorts + time filters ─────────────────────────────
test("sorts: top / controversial with hour..all windows, new, hot, rising", async () => {
  await runQuery("UPDATE feed_posts SET global = 0");                    // a clean main feed for this test
  const t0 = Date.now();
  const P = {};
  const place = async (name, ageMs, ups, downs) => {
    const id = await mkPost(U.admin, { body: name });
    const created = t0 - ageMs;
    await runQuery("DELETE FROM feed_votes WHERE post_id = ?", [id]);
    const old = t0 - 7 * 3600e3;                                          // the votes themselves aren't fresh (rising is tested below)
    for (let i = 0; i < ups; i++) await runQuery("INSERT INTO feed_votes (post_id, user_id, value, w, created, updated) VALUES (?, ?, 1, 1, ?, ?)", [id, "x" + i, old, old]);
    for (let i = 0; i < downs; i++) await runQuery("INSERT INTO feed_votes (post_id, user_id, value, w, created, updated) VALUES (?, ?, -1, 1, ?, ?)", [id, "y" + i, old, old]);
    await runQuery("UPDATE feed_posts SET created = ? WHERE id = ?", [created, id]);
    await store.recountPost(id);
    P[name] = id;
  };
  await place("min30", 30 * 60e3, 3, 0);
  await place("h5", 5 * 3600e3, 6, 6);
  await place("d3", 3 * 86400e3, 20, 2);
  await place("d20", 20 * 86400e3, 40, 30);
  await place("d200", 200 * 86400e3, 80, 1);
  await place("y2", 2 * 365 * 86400e3, 200, 190);
  const names = Object.fromEntries(Object.entries(P).map(([k, v]) => [v, k]));
  const ids = async (sort, top) => (await store.list({ sort, top, limit: 50 })).posts.map((p) => names[p.id]).filter(Boolean);
  assert.deepEqual(await ids("top", "hour"), ["min30"]);
  assert.deepEqual(await ids("top", "day"), ["min30", "h5"]);
  assert.deepEqual(await ids("top", "week"), ["d3", "min30", "h5"]);
  assert.deepEqual(await ids("top", "month"), ["d3", "d20", "min30", "h5"]);
  assert.deepEqual(await ids("top", "year"), ["d200", "d3", "d20", "min30", "h5"]);
  assert.deepEqual(await ids("top", "all"), ["d200", "d3", "y2", "d20", "min30", "h5"]);
  assert.deepEqual(await ids("controversial", "all"), ["y2", "d20", "h5", "d3", "d200", "min30"]);
  assert.deepEqual(await ids("controversial", "day"), ["h5", "min30"]);
  assert.deepEqual(await ids("controversial", "month"), ["d20", "h5", "d3", "min30"]);
  assert.deepEqual(await ids("new"), ["min30", "h5", "d3", "d20", "d200", "y2"]);
  assert.deepEqual((await ids("hot")).slice(0, 3), ["min30", "h5", "d3"]);
  assert.deepEqual(await ids("top", "bogus"), await ids("top", "all"), "an unknown window = all time");
  // rising: posts under 48 h by other people's net votes in the last 6 h (the author's own vote doesn't count)
  assert.deepEqual(await ids("rising"), [], "nothing has fresh votes");
  await vote(U.bob, P.h5, 1); await vote(U.carol, P.h5, 1);
  await vote(U.bob, P.min30, 1);
  await vote(U.bob, P.d3, 1);                                            // too old to rise
  assert.deepEqual(await ids("rising"), ["h5", "min30"]);
  const spec = store.rankSpec("top", "week", t0);
  assert.equal(spec.where[0], "p.created > ?");
  assert.equal(spec.args[0], t0 - 7 * 86400e3);
  assert.equal(store.rankSpec("drop table", "x").sort, "hot", "unknown sort = hot");
  // the reusable list for Following: authors
  const f = await store.list({ authors: [U.admin.userId], sort: "top", top: "all", limit: 50 });
  assert.ok(f.posts.length >= 6 && f.posts.every((p) => p.author.username === "boss"));
  assert.deepEqual((await store.list({ authors: [] })).posts, []);
  // the pages take every sort + window and only show the time picker for top / controversial
  for (const q of ["?sort=hot", "?sort=new", "?sort=rising", "?sort=top&t=hour", "?sort=controversial&t=year", "?sort=<x>&t=<y>"]) {
    const r = await page("/feed" + q, U.bob);
    assert.equal(r.status, 200, q);
    assert.equal(r.html.includes('class="fs-time"'), /top|controversial/.test(q), q);
    assert.ok(!r.html.includes("<x>") && !r.html.includes("<y>"), q);
  }
  // the Following tab (1.99bz) takes the same sorts + windows
  const fl = await store.list({ following: U.bob.userId, sort: "controversial", top: "day", viewer: U.bob });
  assert.ok(Array.isArray(fl.posts));
  const fp = await page("/feed?tab=following&sort=top&t=day", U.bob);
  assert.equal(fp.status, 200);
  assert.ok(fp.html.includes('class="fs-time"') && fp.html.includes("<span>Today</span>"));
  const tp = await page("/feed?sort=top&t=month", U.bob);
  assert.match(tp.html, /<span>This month<\/span>/);
  assert.match(tp.html, /href="\/feed\?sort=controversial&amp;t=month"/);
  await runQuery("UPDATE feed_posts SET global = 1 WHERE id IN (" + Object.values(P).map(() => "?").join(",") + ")", Object.values(P));
});

// ───────────────────────────── comments ─────────────────────────────
test("comment votes: own +1, no own downvote, state machine; sorts best / top / new / controversial", async () => {
  const id = await mkPost(U.alice, { body: "discuss" });
  const mk = async (u, body, parent) => { store._gaps.clear(); const r = await post(`/api/feed/posts/${id}/comments`, u, { body, parent }); assert.equal(r.status, 200); return r.d.id; };
  const a = await mk(U.bob, "first"), b = await mk(U.carol, "second"), c = await mk(U.lvl, "third"), d = await mk(U.v0 || [...users.values()].find((x) => x.username === "v1"), "fourth");
  const cv = async (u, cid, dir) => { store._gaps.clear(); return post(`/api/feed/comments/${cid}/vote`, u, { dir }); };
  let r = await cv(U.bob, a, -1);
  assert.equal(r.status, 403);
  assert.match(r.d.error, /own comment/);
  r = await cv(U.alice, a, 1);
  assert.deepEqual([r.d.vote, r.d.ups, r.d.score], [1, 2, 2]);
  r = await cv(U.alice, a, -1);
  assert.deepEqual([r.d.vote, r.d.ups, r.d.downs, r.d.score], [-1, 1, 1, 0]);
  r = await cv(U.alice, a, 0);
  assert.deepEqual([r.d.vote, r.d.score], [0, 1]);
  // shape the scores: b = 4 up 0 down; c = 3 up 3 down; d = 2 up 0 down (newest); a = 1 up
  const V = [...users.values()].filter((u) => /^v\d+$/.test(u.username));
  for (let i = 0; i < 3; i++) await cv(V[10 + i], b, 1);
  for (let i = 0; i < 2; i++) await cv(V[20 + i], c, 1);
  for (let i = 0; i < 3; i++) await cv(V[30 + i], c, -1);
  await cv(V[5], d, 1);
  await runQuery("UPDATE feed_comments SET created = created + ? WHERE id = ?", [1000, d]);
  const order = async (s) => (await store.comments(id, U.alice, s)).map((x) => x.id);
  assert.deepEqual(await order("best"), [b, d, a, c]);
  assert.deepEqual(await order("top"), [b, d, a, c]);
  assert.deepEqual(await order("new"), [d, c, b, a]);
  assert.equal((await order("controversial"))[0], c);
  assert.deepEqual(await order("nonsense"), await order("best"), "unknown sort = best");
  const C = await store.comments(id, V[30]);
  assert.equal(C.find((x) => x.id === c).myVote, -1);
  assert.deepEqual(C.map((x) => [x.ups, x.downs, x.score]).find((x, i) => C[i].id === c), [3, 3, 0]);
  // replies are sorted too, and a vote on a deleted comment is refused
  const r1 = await mk(U.carol, "reply one", b), r2 = await mk(U.bob, "reply two", b);
  await cv(V[2], r2, 1);
  const tb = (await store.comments(id, null, "best")).find((x) => x.id === b);
  assert.deepEqual(tb.replies.map((x) => x.id), [r2, r1]);
  await post(`/api/feed/comments/${r1}/delete`, U.carol, {});
  assert.equal((await cv(U.bob, r1, 1)).status, 404);
  // the page: Best by default, the sort links, vote state per viewer
  const pg = await page(`/feed/p/${id}?csort=new`, V[30]);
  assert.equal(pg.status, 200);
  assert.match(pg.html, /<a class="on" href="\?csort=new#comments" aria-current=true>New<\/a>/);
  assert.match(pg.html, new RegExp(`id="c-${c}"[\\s\\S]*?data-v="-1" data-kind="comment"`));
});

// ───────────────────────────── room owners ─────────────────────────────
test("room owners: pin (max 3, own room only), owner vs non-owner vs admin, audit log", async () => {
  const inB = [];
  for (let i = 0; i < 4; i++) inB.push(await mkPost(U.bob, { body: "plant " + i, rooms: [ROOM_B], global: false }));
  const inC = await mkPost(U.bob, { body: "side", rooms: [ROOM_C], global: false });
  const slugB = rooms.getCached(ROOM_B).slug, slugC = rooms.getCached(ROOM_C).slug;
  assert.equal((await mod(U.bob, slugB, { op: "pin", post: inB[0] })).status, 403, "not the owner");
  assert.equal((await mod(U.ownerC, slugB, { op: "pin", post: inB[0] })).status, 403, "another room's owner");
  assert.equal((await mod(U.ownerB, slugB, { op: "pin", post: inC })).status, 404, "a post from another room");
  assert.equal((await mod(U.ownerB, slugC, { op: "pin", post: inC })).status, 403, "can't reach into room C");
  assert.equal((await mod(null, slugB, { op: "pin", post: inB[0] })).status, 401);
  for (let i = 0; i < 3; i++) assert.equal((await mod(U.ownerB, slugB, { op: "pin", post: inB[i] })).status, 200);
  const full = await mod(U.ownerB, slugB, { op: "pin", post: inB[3] });
  assert.equal(full.status, 409);
  assert.match(full.d.error, /pin 3/);
  assert.equal((await mod(U.admin, slugC, { op: "pin", post: inC })).status, 200, "admins everywhere");
  const L = await store.list({ room: ROOM_B, sort: "top", top: "all", viewer: U.carol });
  assert.deepEqual(L.posts.slice(0, 3).map((p) => p.id).sort(), inB.slice(0, 3).sort(), "pins head every sort");
  assert.ok(L.posts.slice(0, 3).every((p) => p.pinned) && !L.posts.slice(3).some((p) => p.pinned));
  assert.equal(L.posts.filter((p) => inB.slice(0, 3).includes(p.id)).length, 3, "no duplicates below");
  const p2 = await store.list({ room: ROOM_B, page: 2, limit: 2, viewer: U.carol });
  assert.ok(!p2.posts.some((p) => p.pinned), "pins only on page 1");
  assert.equal((await mod(U.ownerB, slugB, { op: "unpin", post: inB[0] })).status, 200);
  assert.equal((await mod(U.ownerB, slugB, { op: "pin", post: inB[3] })).status, 200);
  const F = await web.roomFeed(ROOM_B, U.carol, {});
  const html = await ejs.renderFile(path.join(repo, "views/partials/room-feed.ejs"), { feed: F, fx: web.fx, embeds: require(path.join(repo, "stageembed")), host: "test",
                                                                                  room: { name: "Plant room", slug: slugB } });
  assert.match(html, /class="fp-pin"/);
  assert.ok(!html.includes("/settings#rules"), "a visitor gets no owner tools");
  const Fo = await web.roomFeed(ROOM_B, U.ownerB, {});
  const ho = await ejs.renderFile(path.join(repo, "views/partials/room-feed.ejs"), { feed: Fo, fx: web.fx, embeds: require(path.join(repo, "stageembed")), host: "test",
                                                                                  room: { name: "Plant room", slug: slugB } });
  assert.ok(ho.includes("/settings#rules") && ho.includes('data-op="unpin"') && ho.includes('data-op="lock"'), "1.99dc: owner tools in the post menus; moderation lives in the settings hub");
  const audit = await store.roomAudit(ROOM_B);
  assert.deepEqual(audit.slice(0, 3).map((a) => [a.what, a.actor]), [["feed-pin", "plantowner"], ["feed-unpin", "plantowner"], ["feed-pin", "plantowner"]]);
  assert.ok(!(await store.roomAudit(ROOM_C)).some((a) => a.actor === "plantowner"));
});

test("room owners: lock comments only on posts that live in their rooms alone; admins anywhere", async () => {
  const slugB = rooms.getCached(ROOM_B).slug;
  const only = await mkPost(U.bob, { body: "room only", rooms: [ROOM_B], global: false });
  const both = await mkPost(U.bob, { body: "room + the Lounge (legacy)", rooms: [ROOM_B, LOUNGE] });
  const two = await mkPost(U.bob, { body: "two rooms", rooms: [ROOM_B, ROOM_C], global: false });
  assert.equal((await mod(U.ownerB, slugB, { op: "lock", post: only })).status, 200);
  assert.equal((await mod(U.ownerB, slugB, { op: "lock", post: both })).status, 403);
  assert.equal((await mod(U.ownerB, slugB, { op: "lock", post: two })).status, 403);
  assert.equal((await post(`/api/feed/posts/${both}/admin`, U.admin, { locked: true })).status, 200);
  assert.equal((await post(`/api/feed/posts/${both}/admin`, U.ownerB, { locked: true })).status, 403);
  for (const id of [only, both]) {
    const c = await post(`/api/feed/posts/${id}/comments`, U.carol, { body: "hello?" });
    assert.equal(c.status, 403);
    assert.match(c.d.error, /locked/);
  }
  store._gaps.clear();
  assert.equal((await post(`/api/feed/posts/${only}/comments`, U.ownerB, { body: "owner can still answer" })).status, 200);
  const pg = await page(`/feed/p/${only}`, U.carol);
  assert.match(pg.html, /Comments are locked by plantowner/);
  assert.ok(!pg.html.includes('class="cm-new'), "no composer on a locked post");
  assert.equal((await mod(U.ownerB, slugB, { op: "unlock", post: only })).status, 200);
  store._gaps.clear();
  assert.equal((await post(`/api/feed/posts/${only}/comments`, U.carol, { body: "now" })).status, 200);
});

test("room owners: NSFW and hide apply to their room's view only (and the post page for NSFW)", async () => {
  const slugB = rooms.getCached(ROOM_B).slug;
  const id = await mkPost(U.bob, { body: "spicy?", rooms: [ROOM_B, ROOM_C], global: true });
  assert.equal((await mod(U.ownerB, slugB, { op: "nsfw", post: id })).status, 200);
  const nB = (await store.list({ room: ROOM_B, viewer: U.carol, limit: 50 })).posts.find((p) => p.id === id);
  const nC = (await store.list({ room: ROOM_C, viewer: U.carol, limit: 50 })).posts.find((p) => p.id === id);
  const nM = (await store.list({ viewer: U.carol, sort: "new", limit: 50 })).posts.find((p) => p.id === id);
  // 1.99ci: All (like the post page) errs on the safe side - any live community's NSFW mark applies there
  assert.deepEqual([nB.nsfw, nC.nsfw, nM.nsfw], [true, false, true]);
  assert.equal((await store.get(id, U.carol, { detail: true })).nsfw, true, "the post page errs on the safe side");
  assert.equal((await row(id)).nsfw_admin, null, "the post's own flags are untouched");
  assert.equal((await mod(U.ownerB, slugB, { op: "hide", post: id })).status, 200);
  assert.ok(!(await store.list({ room: ROOM_B, viewer: U.carol, limit: 50 })).posts.some((p) => p.id === id), "hidden in B for visitors");
  assert.ok((await store.list({ room: ROOM_B, viewer: U.ownerB, limit: 50 })).posts.find((p) => p.id === id).roomHidden, "the owner still sees it, marked");
  assert.ok((await store.list({ room: ROOM_C, viewer: U.carol, limit: 50 })).posts.some((p) => p.id === id), "still in C");
  assert.ok((await store.list({ viewer: U.carol, sort: "new", limit: 50 })).posts.some((p) => p.id === id), "still on All (it's visible in C)");
  assert.equal((await mod(U.ownerB, slugB, { op: "unhide", post: id })).status, 200);
  assert.equal((await mod(U.ownerB, slugB, { op: "unnsfw", post: id })).status, 200);
});

test("room owners: approval queue - pending posts are invisible in the room until approved; reject tells the author", async () => {
  const slugB = rooms.getCached(ROOM_B).slug;
  assert.equal((await mod(U.bob, slugB, { op: "settings", settings: { approval: true } })).status, 403);
  assert.equal((await mod(U.ownerB, slugB, { op: "settings", settings: { approval: true } })).d.settings.approval, true);
  await runQuery("INSERT OR REPLACE INTO feed_kv (key, value) VALUES ('mention:' || ?, '1')", [ROOM_B]);
  const a = await mkPost(U.carol, { title: "please approve", body: "x", rooms: [ROOM_B], global: false });
  const b = await mkPost(U.carol, { title: "also pending", body: "y", rooms: [ROOM_B] });
  const own = await mkPost(U.ownerB, { body: "owner posts go straight up", rooms: [ROOM_B], global: false });
  const vis = async (u) => (await store.list({ room: ROOM_B, viewer: u, limit: 100 })).posts.map((p) => p.id);
  assert.ok(!(await vis(U.bob)).includes(a) && !(await vis(null)).includes(a));
  assert.ok((await vis(U.carol)).includes(a), "the author sees their own pending post");
  assert.ok((await vis(U.ownerB)).includes(a));
  assert.ok((await vis(U.bob)).includes(own));
  assert.ok(!(await store.list({ viewer: U.bob, sort: "new", limit: 100 })).posts.some((p) => p.id === b), "1.99ci: pending in its only community = not on All either");
  assert.equal((await page(`/feed/p/${a}`, U.bob)).status, 404, "not shown anywhere yet: hidden from others");
  assert.equal((await page(`/feed/p/${a}`, U.carol)).status, 200);
  assert.equal((await page(`/feed/p/${a}`, U.ownerB)).status, 200);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM feed_mentions WHERE post_id = ?", [a]))[0].n, 0, "Pepe waits for the approval");
  const q = await store.roomPending(ROOM_B, U.ownerB);
  assert.deepEqual(q.map((p) => p.id), [a, b]);
  assert.equal((await mod(U.ownerC, rooms.getCached(ROOM_C).slug, { op: "approve", post: a })).status, 404, "another owner can't approve it from their room");
  assert.equal((await mod(U.ownerC, slugB, { op: "approve", post: a })).status, 403);
  assert.equal((await mod(U.ownerB, slugB, { op: "approve", post: a })).status, 200);
  assert.ok((await vis(U.bob)).includes(a));
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM feed_mentions WHERE post_id = ?", [a]))[0].n, 1);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = ? AND ref LIKE 'feed-ok:%'", [U.carol.userId]))[0].n, 1);
  assert.equal((await mod(U.ownerB, slugB, { op: "reject", post: b, reason: "off topic" })).status, 200);
  assert.ok(!(await vis(U.carol)).includes(b));
  const n = await getQuery("SELECT * FROM inbox WHERE user_id = ? AND ref LIKE 'feed-no:%'", [U.carol.userId]);
  assert.match(n[0].body, /off topic/);
  assert.deepEqual((await store.roomPending(ROOM_B, U.ownerB)).map((p) => p.id), []);
  await mod(U.ownerB, slugB, { op: "settings", settings: { approval: false } });
});

test("room owners: who can post (linked / approved / followers), per-user daily rate; owner + admin exempt", async () => {
  const slugB = rooms.getCached(ROOM_B).slug;
  await mod(U.ownerB, slugB, { op: "settings", settings: { who: "linked" } });
  assert.equal((await post("/api/feed/posts", U.lvl, { body: "x", rooms: [ROOM_B], global: false })).status, 403);
  assert.equal((await post("/api/feed/posts", U.lvl, { body: "x", rooms: [ROOM_C], global: false })).status, 200, "room C's rules are its own");
  assert.equal((await post("/api/feed/posts", U.carol, { body: "x", rooms: [ROOM_B], global: false })).status, 200);
  await mod(U.ownerB, slugB, { op: "settings", settings: { who: "approved" } });
  assert.equal((await post("/api/feed/posts", U.carol, { body: "x", rooms: [ROOM_B], global: false })).status, 403);
  assert.equal((await mod(U.ownerB, slugB, { op: "member-add", user: "carolcf" })).status, 200);
  assert.equal((await mod(U.ownerB, slugB, { op: "member-add", user: "nobody-here" })).status, 404);
  assert.equal((await post("/api/feed/posts", U.carol, { body: "x", rooms: [ROOM_B], global: false })).status, 200);
  assert.equal((await post("/api/feed/posts", U.admin, { body: "x", rooms: [ROOM_B], global: false })).status, 200, "admins always can");
  assert.equal((await post("/api/feed/posts", U.ownerB, { body: "x", rooms: [ROOM_B], global: false })).status, 200);
  await mod(U.ownerB, slugB, { op: "settings", settings: { who: "followers" } });
  assert.equal((await post("/api/feed/posts", U.bob, { body: "x", rooms: [ROOM_B], global: false })).status, 403);
  store.setFollowerCheck(async (uid, rid) => uid === U.bob.userId && rid === ROOM_B);
  assert.equal((await post("/api/feed/posts", U.bob, { body: "x", rooms: [ROOM_B], global: false })).status, 200, "a follower (via the Following hook)");
  store.setFollowerCheck(null);
  assert.equal((await mod(U.ownerB, slugB, { op: "member-remove", userId: U.carol.userId })).status, 200);
  await mod(U.ownerB, slugB, { op: "settings", settings: { who: "everyone", per_day: 2, junk: "<x>" } });
  assert.deepEqual(await store.roomSettings(ROOM_B), { who: "everyone", approval: false, per_day: 2 });
  await runQuery("DELETE FROM feed_post_rooms WHERE room_id = ? AND post_id IN (SELECT id FROM feed_posts WHERE author_id = ?)", [ROOM_B, U.lvl.userId]);
  assert.equal((await post("/api/feed/posts", U.lvl, { body: "1", rooms: [ROOM_B], global: false })).status, 200);
  assert.equal((await post("/api/feed/posts", U.lvl, { body: "2", rooms: [ROOM_B], global: false })).status, 200);
  const r = await post("/api/feed/posts", U.lvl, { body: "3", rooms: [ROOM_B], global: false });
  assert.equal(r.status, 429);
  assert.match(r.d.error, /2 posts a day/);
  assert.equal((await post("/api/feed/posts", U.lvl, { body: "3", rooms: [ROOM_C] })).status, 200, "another community isn't limited by B's rule");
  await mod(U.ownerB, slugB, { op: "settings", settings: { per_day: 0 } });
});

test("room owners: report queue (reasons + counts), dismiss / hide / remove; comment removal with a reason; bans 1d/7d/forever", async () => {
  const slugB = rooms.getCached(ROOM_B).slug, slugC = rooms.getCached(ROOM_C).slug;
  const id = await mkPost(U.bob, { body: "reported", rooms: [ROOM_B, ROOM_C] });
  const cm = await post(`/api/feed/posts/${id}/comments`, U.evil, { body: "nasty comment" });
  for (const [u, reason] of [[U.carol, "spam"], [U.lvl, "spam"], [U.alice, "abuse"]]) { store._gaps.clear(); await post(`/api/feed/posts/${id}/report`, u, { reason, note: "<b>bad</b>" }); }
  store._gaps.clear();
  await post(`/api/feed/posts/${id}/report`, U.carol, { reason: "abuse", comment: cm.d.id });
  let Q = await store.roomReports(ROOM_B);
  const pg = Q.find((g) => g.postId === id && !g.commentId), cg = Q.find((g) => g.commentId === cm.d.id);
  assert.equal(pg.count, 3);
  assert.deepEqual(pg.reasons, { Spam: 2, "Harassment or hate": 1 });
  assert.equal(cg.count, 1);
  assert.equal((await mod(U.ownerB, slugB, { op: "dismiss", post: id })).status, 200);
  Q = await store.roomReports(ROOM_B);
  assert.ok(!Q.some((g) => g.postId === id && !g.commentId), "dismissed in B");
  assert.ok((await store.roomReports(ROOM_C)).some((g) => g.postId === id && !g.commentId), "C's queue (and the admins') is separate");
  assert.ok((await store.reports()).some((x) => x.post.id === id), "still open for the admins");
  store._gaps.clear();
  await post(`/api/feed/posts/${id}/report`, U.v0 ? U.v0 : [...users.values()].find((u) => u.username === "v3"), { reason: "nsfw" });
  assert.ok((await store.roomReports(ROOM_B)).some((g) => g.postId === id && !g.commentId), "a new report after the dismiss re-opens it");
  assert.equal((await mod(U.ownerB, slugB, { op: "hide", post: id })).status, 200);
  assert.ok(!(await store.roomReports(ROOM_B)).some((g) => g.postId === id && !g.commentId));
  // the comment: removed by the owner with a reason -> the author's inbox
  assert.equal((await post(`/api/feed/comments/${cm.d.id}/delete`, U.ownerC, { reason: "x" })).status, 200, "C's owner too: the post is in C");
  const n = await getQuery("SELECT * FROM inbox WHERE user_id = ? AND ref = ?", [U.evil.userId, "feed-crm:" + cm.d.id]);
  assert.equal(n.length, 1);
  assert.match(n[0].body, /removed by a moderator: x/);
  const other = await mkPost(U.bob, { body: "in the Lounge only" });
  const oc = await post(`/api/feed/posts/${other}/comments`, U.evil, { body: "in the Lounge" });
  assert.equal((await post(`/api/feed/comments/${oc.d.id}/delete`, U.ownerB, {})).status, 403, "not on a post outside their rooms");
  // bans: 1 day, 7 days, permanent; only in their room
  for (const [days, u] of [[1, "carol"], [7, "leveled"], [0, "evil"]]) assert.equal((await post("/api/feed/ban", U.ownerB, { user: u, room: slugB, days })).status, 200);
  assert.equal((await post("/api/feed/ban", U.ownerB, { user: "bob", room: slugC, days: 1 })).status, 403);
  assert.equal((await post("/api/feed/ban", U.ownerB, { user: "bob", days: 1 })).status, 403, "the whole feed is admins only");
  const B = await store.bans(ROOM_B);
  const until = Object.fromEntries(B.map((b) => [b.username, b.until]));
  assert.ok(Math.abs(until.carol - Date.now() - 86400e3) < 60e3 && Math.abs(until.leveled - Date.now() - 7 * 86400e3) < 60e3 && until.evil === null);
  assert.equal((await post("/api/feed/posts", U.evil, { body: "x", rooms: [ROOM_B], global: false })).status, 403);
  assert.equal((await post("/api/feed/unban", U.ownerB, { userId: U.evil.userId, room: slugB })).status, 200);
  assert.equal((await post("/api/feed/posts", U.evil, { body: "x", rooms: [ROOM_B], global: false })).status, 200);
  for (const u of ["carol", "leveled"]) await post("/api/feed/unban", U.ownerB, { userId: "u_" + u, room: slugB });
  // the page: owner + admin yes, others no; everything escaped
  assert.equal((await page(`/p/${slugB}/settings`, U.ownerB)).status, 200);
  assert.equal((await page(`/p/${slugB}/settings`, U.admin)).status, 200);
  assert.equal((await page(`/p/${slugB}/settings`, U.ownerC)).status, 403);
  assert.equal((await page(`/p/${slugB}/settings`, U.bob)).status, 403);
  const anon = await fetch(`${base}/p/${slugB}/settings`, { redirect: "manual" });
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get("location"), /^\/login\?next=/);
  const mp = await page(`/p/${slugC}/settings`, U.ownerC);
  assert.ok(mp.html.includes("Reports") && mp.html.includes("Audit log") && mp.html.includes("&lt;b&gt;bad&lt;/b&gt;"));
  assert.ok(!mp.html.includes("<b>bad</b>"));
  const audit = (await store.roomAudit(ROOM_B)).map((a) => a.what);
  for (const w of ["feed-dismiss", "feed-hide", "feed-ban", "feed-settings", "feed-approve", "feed-reject", "feed-member-add"]) assert.ok(audit.includes(w), w);
  assert.ok((await store.roomAudit(ROOM_C)).some((a) => a.what === "feed-comment-remove" && a.actor === "sideowner"));
});

// ───────────────────────────── rendering ─────────────────────────────
test("rendering: vote column states, own-post downvote disabled, one menu, escaped names / titles / params", async () => {
  const id = await mkPost(U.evil, { title: "<script>alert(1)</script>", body: "hi", rooms: [ROOM_B] });
  await vote(U.bob, id, -1);
  const mine = await page(`/feed/p/${id}`, U.evil);
  assert.match(mine.html, /class="vote fp-vote" data-v="1" data-kind="post" data-own="1"/);
  assert.match(mine.html, /aria-label="You can&#39;t downvote your own post" disabled>/);
  const bobs = await page(`/feed/p/${id}?csort=<script>`, U.bob);
  assert.match(bobs.html, /class="vote fp-vote" data-v="-1" data-kind="post">/);
  assert.match(bobs.html, /<span class="vs" title="1 up · 1 down">0<\/span>/);
  assert.ok(!bobs.html.includes("<script>alert(1)") && !bobs.html.includes("<img src=x onerror"));
  assert.ok(bobs.html.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && bobs.html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.equal((bobs.html.match(/<details class="more">/g) || []).length, 1, "one overflow menu on the post");
  assert.ok(!/class="adm"|class="own"/.test(bobs.html), "no more mixed-colour link rows");
  const anon = await page(`/feed/p/${id}`);
  assert.ok(!anon.html.includes('<details class="more">'), "signed out: no menu");
  assert.ok(anon.html.includes("Sign in to comment"));
  const owner = await page(`/feed/p/${id}`, U.ownerB);
  for (const op of ["pin", "nsfw", "hide"]) assert.ok(owner.html.includes(`data-op="${op}"`), op);
  assert.ok(owner.html.includes('data-act="room-ban"'));
  assert.ok(owner.html.includes('data-op="lock"'), "1.99ci: B is its only community, so its owner can lock it");
  const adm = await page(`/feed/p/${id}`, U.admin);
  assert.ok(adm.html.includes('data-act="admin-lock"') && adm.html.includes("Mark NSFW"));
  assert.equal(web.fx.num(999), "999");
  assert.equal(web.fx.num(1234), "1.2k");
  assert.equal(web.fx.num(-15400), "-15k");
  assert.equal(web.fx.initial("<b>"), "B");
  assert.equal(web.fx.icon("<x>"), "");
});
