// 1.99??: Pepe's feed context is readable plain text, selected by stored fmt; code examples never summon him.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pepefeed-markdown-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
const { runQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const PF = require(path.join(repo, "pepefeed"));
require(path.join(repo, "terms"))._setRequired(false);
for (const [name, exports] of [["achievements", { poke: () => {} }], ["streaks", { note: () => {} }]]) {
  const id = require.resolve(path.join(repo, name));
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
require(path.join(repo, "follows")).notifyNewPost = async () => {};
const U = {}, LOUNGE = "patv:lounge", ROOM = "plant_based_chatting";
let acct, clock = Date.parse("2026-11-02T16:00:00Z");
const now = () => clock;
const create = (body, extra = {}) => store.create(U.alice.userId, { body, community: LOUNGE, ...extra });
const cmt = (post, body, extra = {}) => store.comment(U.bob, post.id, { body, ...extra });

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
    points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
    level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  for (const name of ["alice", "bob"]) {
    U[name] = { userId: "u_" + name, username: name, class: "pleb" };
    await runQuery(`INSERT INTO users (userId, username, displayname, password, camfrogUsername, level, created_at)
      VALUES (?, ?, ?, 'x', ?, 5, '2020-01-01 00:00:00')`, [U[name].userId, name, name, name + "cf"]);
  }
  await rooms.init();
  await store.init();
  store._setClock(now);
  PF._setClock(now);
  await store.setConfig({ feed_markdown: true, posts_per_hour: 1000, posts_per_day: 1000, comments_per_hour: 1000, post_gap_secs: 0, comment_gap_secs: 0 }, "test");
  acct = await PF.ensureAccount();
});
test.beforeEach(async () => {
  clock += 3 * 86400e3; // Past scenarios leave the discovery window; every assertion uses this test's real rows.
  store._gaps.clear();
  await store.setConfig({ feed_markdown: true }, "test");
});

test("post and crosspost payloads strip stored Markdown after OFF, leaving titles and plain posts literal", async () => {
  const p = await create("## Readable **body**", { title: "**Literal title**" });
  const legacy = await create("## Literal **body**", { fmt: "plain" });
  const shared = await store.crosspost(U.bob.userId, p.id, { community: ROOM });
  await store.setConfig({ feed_markdown: false }, "test");
  const v = await PF.postView(await store.getRow(p.id));
  assert.equal(v.title, "**Literal title**");
  assert.equal(v.body, "Readable body");
  assert.equal((await PF.postView(await store.getRow(legacy.id))).body, "## Literal **body**");
  const x = await PF.postView(await store.getRow(shared.id));
  assert.equal(x.body, "Readable body");
  assert.equal(x.source_id, p.id);
});

test("conversation and sibling context use each comment's own stored format", async () => {
  const p = await create("A conversation");
  const top = await cmt(p, "## Parent **thoughts**");
  const reply = await cmt(p, "**Formatted reply**", { parent: top.id });
  const literal = await cmt(p, "**Literal reply**", { parent: top.id, fmt: "plain" });
  const other = await cmt(p, "### Other **thoughts**");
  const otherLiteral = await cmt(p, "### Literal **thoughts**", { fmt: "plain" });
  await store.setConfig({ feed_markdown: false }, "test");
  const thread = await PF.conversation(p.id, top.id, reply.id);
  assert.equal(thread.find((x) => x.id === top.id).body, "Parent thoughts");
  assert.equal(thread.find((x) => x.id === reply.id).body, "Formatted reply");
  assert.equal(thread.find((x) => x.id === reply.id).target, true);
  assert.equal(thread.find((x) => x.id === literal.id).body, "**Literal reply**");
  const others = await PF.otherComments(p.id, top.id);
  assert.equal(others.find((x) => x.id === other.id).body, "Other thoughts");
  assert.equal(others.find((x) => x.id === otherLiteral.id).body, "### Literal **thoughts**");
});

test("only live Markdown prose mentions summon Pepe; closed code is literal, old plain behavior remains", async () => {
  const inline = await create("Example: `@pepe`");
  const fenced = await create("```text\npepe\n```");
  const live = await create("**@pepe** help");
  const plain = await create("`@pepe`", { fmt: "plain" });
  const title = await create("Body without a mention", { title: "`pepe`" });
  const unclosed = await create("An unclosed `@pepe example");
  const neutral = await create("Comment examples");
  const codeComment = await cmt(neutral, "`@pepe`");
  const liveComment = await cmt(neutral, "**@pepe** answer");
  const plainComment = await cmt(neutral, "`@pepe`", { fmt: "plain" });
  const found = await PF.findMentions(acct);
  const targets = new Set(found.map((x) => x.target));
  for (const p of [inline, fenced]) assert.equal(targets.has("p:" + p.id), false);
  assert.equal(targets.has("c:" + codeComment.id), false);
  for (const p of [live, plain, title, unclosed]) assert.equal(targets.has("p:" + p.id), true);
  for (const c of [liveComment, plainComment]) assert.equal(targets.has("c:" + c.id), true);
  assert.equal(found.find((x) => x.target === "c:" + liveComment.id).reply_to.body, "@pepe answer");
  assert.equal(found.find((x) => x.target === "c:" + plainComment.id).reply_to.body, "`@pepe`");
});

test("crossposting a readable fallback title does not repeat the original mention", async () => {
  const p = await create("## Hey **pepe**");
  const x = await store.crosspost(U.bob.userId, p.id, { community: ROOM });
  assert.equal(x.title, "Hey pepe");
  const targets = new Set((await PF.findMentions(acct)).map((m) => m.target));
  assert.equal(targets.has("p:" + p.id), true);
  assert.equal(targets.has("p:" + x.id), false);
});

test("formatting fragments and URL destinations never manufacture a new summon", async () => {
  const fragmented = await create("@Pe**pe**");
  const destination = await create("[example](https://example.test/pepe)");
  const naked = await create("https://example.test/pepe");
  const comment = await cmt(fragmented, "@Pe**pe**");
  const live = await create("**@pepe** hello");
  const targets = new Set((await PF.findMentions(acct)).map((m) => m.target));
  for (const p of [fragmented, destination, naked]) assert.equal(targets.has("p:" + p.id), false);
  assert.equal(targets.has("c:" + comment.id), false);
  assert.equal(targets.has("p:" + live.id), true);
});

test("automatic thread candidates have readable comment text without exposing hidden or NSFW posts", async () => {
  const p = await create("## Automatic **context**");
  const md = await cmt(p, "**Formatted context**");
  const plain = await cmt(p, "**Literal context**", { fmt: "plain" });
  const hidden = await create("## @pepe hidden");
  await runQuery("UPDATE feed_posts SET hidden_at = ? WHERE id = ?", [clock, hidden.id]);
  const nsfw = await create("## @pepe NSFW", { nsfw: true });
  const threads = await PF.findThreads([""]);
  const picked = threads.find((x) => x.post.id === p.id);
  assert.ok(picked);
  assert.equal(picked.post.body, "Automatic context");
  assert.equal(picked.thread.find((x) => x.id === md.id).body, "Formatted context");
  assert.equal(picked.thread.find((x) => x.id === plain.id).body, "**Literal context**");
  const mentions = await PF.findMentions(acct);
  for (const offLimits of [hidden, nsfw]) {
    assert.equal(threads.some((x) => x.post.id === offLimits.id), false);
    assert.equal(mentions.some((x) => x.post.id === offLimits.id), false);
  }
});

test("admin log fallback labels are readable only for stored Markdown", async () => {
  const md = await create("## Markdown **label**");
  const plain = await create("## Plain **label**", { fmt: "plain" });
  const titled = await create("## Body", { title: "**Literal title**" });
  for (const p of [md, plain, titled]) await PF.setMute(U.alice, p.id, true);
  const log = (await PF.adminView()).log;
  assert.equal(log.find((x) => x.post_id === md.id).postTitle, "Markdown label");
  assert.equal(log.find((x) => x.post_id === plain.id).postTitle, "## Plain **label**");
  assert.equal(log.find((x) => x.post_id === titled.id).postTitle, "**Literal title**");
});
