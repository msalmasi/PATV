// 1.99wq: post flair + pad tags (padflair.js / feedtags.js), Pepe's labels on his posts (pepelabels.js) and one story, one pad
// (pepetopics.js):
//   - a pad's post flairs: the author picks one; unknown / mods-only (for a non-mod) / missing-but-required are refused before
//     anything is made; ?flair= filters the pad's feed; the card shows the chip; the pad's own tags lead its tag bar
//   - Pepe flairs his posts by kind (deterministic), else his own pick only when it IS one of the pad's, never a mods-only one in
//     someone else's pad, a general one where a flair is required; tags only from the pad's vocabulary; the owner's switch
//   - news: the same / a similar story twice in 48 h is refused wherever it went; a news post goes to the best-fit pad, else
//     Pepe's Pad; recaps stay per pad; the sync carries the news scope, the recent topics and each pad's labels
//   NODE_PATH=G:/PATV/node_modules node --test test/pepe-labels-topics.test.js      (temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pepe-labels-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");

const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const web = require(path.join(repo, "feedweb"));
const terms = require(path.join(repo, "terms"));
const audit = require(path.join(repo, "contentaudit"));
const PF = require(path.join(repo, "pepefeed"));
const FL = require(path.join(repo, "padflair"));
const TG = require(path.join(repo, "feedtags"));
const LB = require(path.join(repo, "pepelabels"));
const TP = require(path.join(repo, "pepetopics"));

const HOUSE = "PepeFrog.Room", PLANT = "plant_based_chatting", SPORTS = "Sports.Room";
let base, server;
const U = {};
const users = new Map();
let clock = Date.parse("2026-10-13T16:00:00Z");
const NOW = () => clock;

async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned, email)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, 5, '2026-01-01 00:00:00', 0, ?)`, [id, name, name, extra.class || "pleb", name + "cf", name + "@example.com"]);
  const u = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, u);
  return u;
}
const H = (u, extra = {}) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {}, extra);
async function call(method, url, u, body, extra) {
  const r = await fetch(base + url, { method, headers: H(u, extra), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, text };
}
const post = (url, u, body, extra) => call("POST", url, u, body, extra);
const get = (url, u) => call("GET", url, u);
const bot = (url, body) => post(url, null, body, { "x-bot-token": "bot" });
const resetLog = async () => { await runQuery("DELETE FROM pepe_feed_log"); };

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, email TEXT UNIQUE, xp INTEGER DEFAULT 0,
                  avatar TEXT, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery(`CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ct TEXT NOT NULL, file TEXT NOT NULL, bytes INTEGER, secs REAL, subject TEXT,
                  by_user TEXT, room TEXT, created INTEGER, expires INTEGER, deleted INTEGER DEFAULT 0)`);
  U.owner = await mkUser("plantowner");
  U.admin = await mkUser("boss", { class: "Admin" });
  U.alice = await mkUser("alice");
  U.bob = await mkUser("bob");
  await rooms.init();
  await rooms.setOwner(PLANT, "plantowner", "test");
  await rooms.addRoom(SPORTS, "Sports Talk", "test");
  await rooms.setPage(SPORTS, { description: "Football, basketball, the NFL and the NBA - scores and hot takes" }, "test");
  await store.init();
  await terms.init();
  await audit.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0, comments_per_hour: 1000 }, "test");
  for (const u of users.values()) await terms.accept(u.userId);
  PF._setClock(NOW);
  TP._setClock(NOW);
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; res.locals.ogPath = req.originalUrl.split("?")[0]; next(); });
  require(path.join(repo, "pads")).register(app);
  web.register(app, { addUser, isBotToken: (t) => t === "bot" });
  PF.register(app, { addUser, isBotToken: (t) => t === "bot" });
  FL.register(app, { addUser });
  TG.register(app, { addUser });
  require(path.join(repo, "bridge")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });
test.beforeEach(() => { store._gaps.clear(); PF._writes.length = 0; clock += 3600e3; FL._clear(); });

// ───────────────────────────── post flair ─────────────────────────────
let NEWS, CHAT, STAFF;
test("post flair: owners define them (kind post, mods only), user flair stays separate; the limits are per kind", async () => {
  NEWS = (await FL.save(U.owner, PLANT, { kind: "post", name: "News", emoji: "📰", color: "#2196f3" })).find((f) => f.name === "News");
  CHAT = (await FL.save(U.owner, PLANT, { kind: "post", name: "Discussion", emoji: "💬" })).find((f) => f.name === "Discussion");
  STAFF = (await FL.save(U.owner, PLANT, { kind: "post", name: "Announcement", emoji: "📣", mod_only: true })).find((f) => f.name === "Announcement");
  assert.equal(STAFF.mod_only, true);
  await FL.save(U.owner, PLANT, { name: "Regular", self: true });          // a user flair
  assert.deepEqual((await FL.list(PLANT)).map((f) => f.name), ["Regular"], "user flair list has no post flairs");
  assert.deepEqual((await FL.postFlairs(PLANT)).map((f) => f.name), ["News", "Discussion", "Announcement"]);
  await assert.rejects(FL.save(U.alice, PLANT, { kind: "post", name: "Mine" }), /owner and mods/);
  await assert.rejects(FL.save(U.owner, PLANT, { kind: "post", name: "news" }), /already has a post flair/);
  // a post flair can't be worn
  await assert.rejects(FL.assign(U.owner, PLANT, "alice", NEWS.id), /No such flair/);
  await assert.rejects(FL.pick(U.alice, PLANT, NEWS.id), /No such flair/);
});

let P1;
test("posting with a flair: by id or name; unknown and mods-only refused; required means pick one; staff may use mods-only", async () => {
  P1 = await store.create(U.alice.userId, { community: PLANT, title: "Monstera news", flair: NEWS.id });
  assert.equal(P1.postFlair.name, "News");
  const p2 = await store.create(U.bob.userId, { community: PLANT, title: "What's your fav plant?", flair: "💬 discussion" });
  assert.equal(p2.postFlair.id, CHAT.id, "a name (emoji tolerated) works too");
  const before = (await getQuery("SELECT COUNT(*) AS n FROM feed_posts"))[0].n;
  await assert.rejects(store.create(U.alice.userId, { community: PLANT, title: "x", flair: "Memes" }), /isn't one of this pad's/);
  await assert.rejects(store.create(U.alice.userId, { community: PLANT, title: "x", flair: STAFF.id }), /Only this pad's mods/);
  await FL.setRequired(U.owner, PLANT, true);
  await assert.rejects(store.create(U.alice.userId, { community: PLANT, title: "no flair" }), /asks for a flair/);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM feed_posts"))[0].n, before, "nothing made");
  const p3 = await store.create(U.owner.userId, { community: PLANT, title: "Pad news!", flair: STAFF.id });
  assert.equal(p3.postFlair.name, "Announcement", "the owner may use a mods-only flair");
  // the author changes it in the Edit form
  await store.edit(U.alice, P1.id, { flair: CHAT.id });
  assert.equal((await store.get(P1.id, null)).postFlair.id, CHAT.id);
  await assert.rejects(store.edit(U.alice, P1.id, { flair: "" }), /asks for a flair/);
  await FL.setRequired(U.owner, PLANT, false);
  await store.edit(U.alice, P1.id, { flair: NEWS.id });
});

test("?flair= filters the pad feed; the pad page shows the chip and the flair bar; the composer carries the choices", async () => {
  const L = await store.list({ room: PLANT, flair: NEWS.id });
  assert.deepEqual(L.posts.map((p) => p.id), [P1.id]);
  const slug = (await rooms.get(PLANT)).slug;
  let r = await get(`/p/${slug}?flair=${NEWS.id}`, U.alice);
  assert.equal(r.status, 200);
  assert.match(r.text, /class="pfl-post"/);
  assert.ok(r.text.includes("Monstera news") && !r.text.includes("fav plant"), "only the flaired posts");
  r = await get(`/p/${slug}`, U.alice);
  assert.match(r.text, new RegExp(`href="\\?flair=${NEWS.id}#feed"`), "the flair bar links filter the feed");
  assert.match(r.text, /data-flairs="[^"]*Discussion/, "the composer knows the pad's flairs");
  assert.doesNotMatch(r.text.match(/data-flairs="([^"]*)"/)[1], /Announcement/, "not the mods-only one for a member");
  // the edit form's choices
  r = await get(`/api/pads/${slug}/flair`, U.alice);
  assert.deepEqual(r.d.post.flairs.map((f) => f.name), ["News", "Discussion"]);
});

test("the pad's own tags: owners set them, they lead the tag bar and the suggestions; members can't", async () => {
  const slug = (await rooms.get(PLANT)).slug;
  let r = await post(`/api/pads/${slug}/flair/tags`, U.alice, { tags: "a1, b2" });
  assert.equal(r.status, 403);
  r = await post(`/api/pads/${slug}/flair/tags`, U.owner, { tags: "#Plant Care, monstera, news" });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.d.manage.padTags, ["plant-care", "monstera", "news"]);
  assert.deepEqual((await TG.padBar(PLANT)).slice(0, 3).map((x) => x.tag), ["plant-care", "monstera", "news"]);
  await assert.rejects(TG.setPadTags(U.owner, PLANT, Array.from({ length: 13 }, (_, i) => "tag" + i)), /Up to 12/);
});

// ───────────────────────────── Pepe's labels ─────────────────────────────
test("kindFlair: the deterministic map (names, then words, then emoji)", () => {
  const F = [{ id: 1, name: "Daily Recap", emoji: "" }, { id: 2, name: "Hot News", emoji: "" }, { id: 3, name: "Tunes", emoji: "🎶" }, { id: 4, name: "Pepe Says", emoji: "🐸" }];
  assert.equal(LB.kindFlair("recap", F).id, 1);
  assert.equal(LB.kindFlair("news", F).id, 2);
  assert.equal(LB.kindFlair("dj", F).id, 3);
  assert.equal(LB.kindFlair("question", F), null);
  assert.equal(LB.generalFlair(F).id, 4);
});

test("pick(): the kind's flair, else his pick only when it's the pad's; never a mods-only one off a house pad; tags only from the pad's vocabulary", async () => {
  let L = await LB.pick({ roomId: PLANT, kind: "news", title: "x" });
  assert.equal(L.flair.name, "News", "kind -> flair");
  L = await LB.pick({ roomId: PLANT, kind: "question" });
  assert.equal(L.flair.name, "Discussion", "question -> Discussion");
  L = await LB.pick({ roomId: PLANT, kind: "snaps", flair: "Discussion" });
  assert.equal(L.flair.name, "Discussion", "no kind match: his pick, constrained");
  L = await LB.pick({ roomId: PLANT, kind: "snaps", flair: "Memes" });
  assert.equal(L.flair, null, "an invented flair is dropped");
  L = await LB.pick({ roomId: PLANT, kind: "snaps", flair: "Announcement" });
  assert.equal(L.flair, null, "a mods-only flair isn't his in someone else's pad");
  await FL.setRequired(U.owner, PLANT, true);
  FL._clear();
  L = await LB.pick({ roomId: PLANT, kind: "snaps", flair: "Memes" });
  assert.equal(L.flair.name, "Discussion", "required: a general one");
  await FL.setRequired(U.owner, PLANT, false);
  FL._clear();
  L = await LB.pick({ roomId: PLANT, kind: "news", tags: ["monstera", "made-up"], title: "Plant care tips", body: "" });
  assert.deepEqual(L.tags, ["news", "monstera", "plant-care"], "kind tag, his pick from the vocabulary, a topic match - never an invented one");
  L = await LB.pick({ roomId: SPORTS, kind: "news", tags: ["nfl"] });
  assert.deepEqual(L.tags, [], "a pad that uses no tags gets none");
  assert.equal(L.flair, null, "nor a flair it doesn't have");
  // the owner's switch: off = no optional labels
  await PF.setScope(U.owner, PLANT, { labels: false });
  L = await LB.pick({ roomId: PLANT, kind: "news", tags: ["monstera"] });
  assert.equal(L.flair, null); assert.deepEqual(L.tags, []);
  await PF.setScope(U.owner, PLANT, { labels: true });
});

// ───────────────────────────── one story, one pad ─────────────────────────────
test("similarity / storyKey: the same headline with a different note is the same story; a different one isn't", () => {
  const a = "SpaceX launches Starship on its fifth test flight (published 3h ago, Tue Oct 13)";
  const b = "SpaceX launches Starship on fifth test flight - Reuters";
  assert.equal(TP.storyKey({ headline: a }), TP.storyKey({ headline: "SpaceX launches Starship on its fifth test flight" }));
  assert.equal(TP.similarity(TP.tokens(TP.cleanHeadline(a)), TP.tokens(TP.cleanHeadline(b))).same, true);
  assert.equal(TP.similarity(TP.tokens(a), TP.tokens("Lakers beat the Celtics in overtime thriller")).same, false);
});

test("news: routed to the best-fit pad, else Pepe's Pad; the same or a similar story again is refused anywhere; recaps stay per pad", async () => {
  await resetLog();
  for (const s of [HOUSE, PLANT, SPORTS]) await PF.setScope(U.admin, s, { posts: true, posts_per_day: 10, gap_min: 0, quiet_start: -1, quiet_end: -1 });
  await PF.setScope(U.admin, "", { posts: true, posts_per_day: 10, gap_min: 0 });
  await PF.setGlobal(U.admin, { posts_per_day: 100 });
  // a general headline -> Pepe's Pad, whichever scope the bot asked for
  let r = await bot("/api/pepe/feed/post", { scope: "", kind: "news", title: "Starship flies again", body: "SpaceX did the thing.",
                                            story: { headline: "SpaceX launches Starship on its fifth test flight (published 2h ago, Tue Oct 13)" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.scope, HOUSE);
  assert.equal((await getQuery("SELECT home_pad FROM feed_posts WHERE id = ?", [r.d.id]))[0].home_pad, HOUSE);
  // the same story again (another pad asked, a different wording) is refused
  r = await bot("/api/pepe/feed/post", { scope: PLANT, kind: "news", title: "Rocket news", body: "Big launch",
                                        story: { headline: "SpaceX launches Starship on fifth test flight - AP" } });
  assert.equal(r.status, 409, r.text);
  assert.match(r.d.error, /already posted/);
  // a sports story fits the sports pad best (its words)
  r = await bot("/api/pepe/feed/post", { scope: "", kind: "news", title: "Upset!", body: "What a game.",
                                        story: { headline: "Jaguars stun the Texans as NFL basketball fans shrug" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.scope, SPORTS);
  // a plant story fits the plant pad (its own tags weigh double) - and gets its flair + tags
  r = await bot("/api/pepe/feed/post", { scope: HOUSE, kind: "news", title: "Monstera prices crash", body: "Plant care on a budget", tags: ["monstera"],
                                        story: { headline: "Monstera prices crash as plant care craze cools" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.scope, PLANT);
  assert.equal(r.d.flair, "News");
  assert.ok(r.d.tags.includes("news") && r.d.tags.includes("monstera"), JSON.stringify(r.d.tags));
  assert.equal((await store.get(r.d.id, null)).postFlair.name, "News");
  // recaps: each pad its own, even with the same title
  for (const s of [HOUSE, SPORTS]) {
    r = await bot("/api/pepe/feed/post", { scope: s, kind: "recap", title: "What went down tonight", body: "Chaos, as usual." });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.d.scope, s);
  }
  // the topics memory
  const T = await TP.recent();
  assert.equal(T.filter((x) => x.kind === "news").length, 3);
  // 48 h later the story may come back
  clock += 49 * 3600e3;
  assert.equal(await TP.duplicate({ story: { headline: "SpaceX launches Starship on its fifth test flight" } }), null);
});

test("sync: the one news scope, the recent topics and each pad's labels (names only, mods-only left out off house pads)", async () => {
  await resetLog();
  await TP.remember({ kind: "news", story: { headline: "Fresh headline about the moon landing anniversary" }, room: HOUSE, post: "x" });
  const r = await bot("/api/pepe/feed/sync", {});
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.news.scope, HOUSE);
  assert.ok(r.d.news.recent.some((x) => /moon landing/i.test(x.title)));
  const lab = r.d.scopes[PLANT].labels;
  assert.deepEqual(lab.flairs.map((f) => f.name), ["News", "Discussion"]);
  assert.ok(lab.tags.includes("monstera"));
  for (const s of [HOUSE, PLANT, SPORTS, ""]) await PF.setScope(U.admin, s, { posts: false });
});
