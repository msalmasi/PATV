// 1.99ahz: stored Markdown is opt-in for new posts/comments; migrations and edits never reinterpret old text.
// Uses a fresh, temporary SQLite database, including pre-migration post/comment fixtures.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "feed-markdown-store-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
require(path.join(repo, "terms"))._setRequired(false);
for (const [name, exports] of [["achievements", { poke: () => {} }], ["streaks", { note: () => {} }]]) {
  const id = require.resolve(path.join(repo, name));
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
require(path.join(repo, "follows")).notifyNewPost = async () => {};
const LOUNGE = "patv:lounge", ROOM = "plant_based_chatting";
const U = {};
const oldPostBody = "## Legacy heading\n- **still plain**";
const oldCommentBody = "- Legacy comment with ||literal marks||";
const create = (u, body, extra = {}) => store.create(u.userId, { body, community: LOUNGE, ...extra });
const row = async (table, id) => (await getQuery(`SELECT * FROM ${table} WHERE id = ?`, [id]))[0];
const notice = async (ref) => (await getQuery("SELECT * FROM inbox WHERE ref = ?", [ref]))[0];

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
    points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
    level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  for (const name of ["alice", "bob", "owner"]) {
    U[name] = { userId: "u_" + name, username: name, class: "pleb" };
    await runQuery(`INSERT INTO users (userId, username, displayname, password, camfrogUsername, level, created_at)
      VALUES (?, ?, ?, 'x', ?, 5, '2020-01-01 00:00:00')`, [U[name].userId, name, name, name + "cf"]);
  }
  // The legacy table definitions intentionally lack fmt. Migration must add a nullable column without rewriting content.
  await runQuery(`CREATE TABLE feed_posts (
    id TEXT PRIMARY KEY, author_id TEXT NOT NULL, title TEXT, body TEXT, link_url TEXT, link_json TEXT,
    nsfw INTEGER NOT NULL DEFAULT 0, nsfw_admin INTEGER, global INTEGER NOT NULL DEFAULT 1,
    score INTEGER NOT NULL DEFAULT 0, comments INTEGER NOT NULL DEFAULT 0, cost INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL, edited INTEGER, deleted_at INTEGER, deleted_by TEXT, delete_reason TEXT,
    hidden_at INTEGER, purged_at INTEGER)`);
  await runQuery(`CREATE TABLE feed_comments (
    id TEXT PRIMARY KEY, post_id TEXT NOT NULL, parent_id TEXT, author_id TEXT NOT NULL, body TEXT NOT NULL,
    created INTEGER NOT NULL, edited INTEGER, deleted_at INTEGER, deleted_by TEXT)`);
  await runQuery("INSERT INTO feed_posts (id, author_id, body, created, global) VALUES ('legacypost01', ?, ?, 1234, 0)", [U.alice.userId, oldPostBody]);
  await runQuery("INSERT INTO feed_comments (id, post_id, author_id, body, created) VALUES ('legacyc001', 'legacypost01', ?, ?, 1235)", [U.bob.userId, oldCommentBody]);
  await rooms.init();
  await rooms.setOwner(ROOM, U.owner.username, "test");
  await store.init();
  await runQuery("INSERT INTO feed_post_rooms (post_id, room_id, created) VALUES ('legacypost01', ?, 1234)", [LOUNGE]);
  await runQuery("UPDATE feed_posts SET home_pad = ? WHERE id = 'legacypost01'", [LOUNGE]);
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, comments_per_hour: 1000, post_gap_secs: 0, comment_gap_secs: 0 }, "test");
});

test("nullable guarded migrations keep legacy posts/comments byte-for-byte plain on repeated startup", async () => {
  for (const table of ["feed_posts", "feed_comments"]) {
    const fmt = (await getQuery(`PRAGMA table_info(${table})`)).filter((c) => c.name === "fmt");
    assert.equal(fmt.length, 1);
    assert.equal(fmt[0].type, "TEXT");
    assert.equal(fmt[0].notnull, 0);
    assert.equal(fmt[0].dflt_value, null);
  }
  assert.equal((await row("feed_posts", "legacypost01")).fmt, null);
  assert.equal((await row("feed_comments", "legacyc001")).fmt, null);
  assert.equal((await row("feed_posts", "legacypost01")).body, oldPostBody);
  assert.equal((await row("feed_comments", "legacyc001")).body, oldCommentBody);
  assert.equal((await row("feed_posts", "legacypost01")).created, 1234);
  const resolved = require.resolve(path.join(repo, "feedstore"));
  const cached = require.cache[resolved];
  delete require.cache[resolved];
  try { await require(resolved).init(); } finally { require.cache[resolved] = cached; }
  assert.equal((await row("feed_posts", "legacypost01")).body, oldPostBody);
  assert.equal((await row("feed_comments", "legacyc001")).body, oldCommentBody);
});

test("Markdown defaults OFF and uses existing boolean config validation/persistence", async () => {
  assert.equal(store.DEFAULTS.feed_markdown, false);
  assert.equal(store.config().feed_markdown, false);
  await store.setConfig({ feed_markdown: "on" }, "test");
  assert.equal(store.config().feed_markdown, true);
  const saved = JSON.parse((await getQuery("SELECT value FROM feed_kv WHERE key = 'config'"))[0].value);
  assert.equal(saved.feed_markdown, true);
  await store.loadConfig();
  assert.equal(store.config().feed_markdown, true);
  await store.setConfig({ feed_markdown: "false" }, "test");
  assert.equal(store.config().feed_markdown, false);
});

test("only enabled new posts/comments receive md; explicit plain and forced md while OFF stay NULL", async () => {
  for (const enabled of [false, true]) {
    await store.setConfig({ feed_markdown: enabled }, "test");
    for (const fmt of [undefined, "md", "plain"]) {
      const expected = enabled && fmt !== "plain" ? "md" : null;
      const p = await create(U.alice, "## New post", { fmt });
      assert.equal(p.fmt, expected);
      assert.equal((await row("feed_posts", p.id)).fmt, expected);
      const c = await store.comment(U.bob, p.id, { body: "**New comment**", fmt });
      assert.equal((await row("feed_comments", c.id)).fmt, expected);
      const read = (await store.comments(p.id, U.alice)).find((x) => x.id === c.id);
      assert.equal(read.fmt, expected);
      assert.equal(read.body, "**New comment**");
    }
  }
});

test("edits keep the original format after switch changes and ignore requested post format", async () => {
  await store.setConfig({ feed_markdown: true }, "test");
  const old = await store.edit(U.alice, "legacypost01", { body: "## Still legacy", fmt: "md" });
  assert.equal(old.fmt, null);
  await store.editComment(U.bob, "legacyc001", "**Still legacy comment**");
  assert.equal((await row("feed_comments", "legacyc001")).fmt, null);
  const p = await create(U.alice, "## Formatted post");
  const c = await store.comment(U.bob, p.id, { body: "**Formatted comment**" });
  await store.setConfig({ feed_markdown: false }, "test");
  const edited = await store.edit(U.alice, p.id, { body: "## Edited post", fmt: "plain" });
  await store.editComment(U.bob, c.id, "**Edited comment**");
  assert.equal(edited.fmt, "md");
  assert.equal(edited.body, "## Edited post");
  assert.equal((await row("feed_comments", c.id)).fmt, "md");
  assert.equal((await row("feed_comments", c.id)).body, "**Edited comment**");
});

test("post lists, details, comment threads and moderator projections retain stored fmt", async () => {
  await store.setConfig({ feed_markdown: true }, "test");
  const p = await create(U.alice, "## Read paths", { community: ROOM });
  const c = await store.comment(U.bob, p.id, { body: "## Parent" });
  const reply = await store.comment(U.alice, p.id, { body: "**Reply**", parent: c.id });
  const read = await store.get(p.id, U.owner);
  assert.equal(read.fmt, "md");
  const listed = await store.list({ room: ROOM, viewer: U.owner, sort: "new" });
  assert.equal(listed.posts.find((x) => x.id === p.id).fmt, "md");
  const comments = await store.comments(p.id, U.owner);
  assert.equal(comments.find((x) => x.id === c.id).fmt, "md");
  assert.equal(comments.find((x) => x.id === c.id).replies.find((x) => x.id === reply.id).fmt, "md");
  await runQuery("INSERT INTO feed_reports (post_id, comment_id, reporter_id, reason, created) VALUES (?, ?, ?, 'spam', ?)", [p.id, c.id, U.owner.userId, Date.now()]);
  assert.equal((await store.reports()).find((g) => g.post.id === p.id).reports[0].comment.fmt, "md");
  assert.equal((await store.roomReports(ROOM)).find((g) => g.postId === p.id).comment.fmt, "md");
});

test("crossposts keep the original's format and derive a readable fallback title while OFF", async () => {
  await store.setConfig({ feed_markdown: true }, "test");
  const p = await create(U.alice, "## Original **heading**");
  await store.setConfig({ feed_markdown: false }, "test");
  const shared = await store.crosspost(U.bob.userId, p.id, { community: ROOM });
  assert.equal(shared.fmt, null, "the crosspost owns no body");
  assert.equal(shared.xpost.post.fmt, "md");
  assert.equal(shared.xpost.post.body, "## Original **heading**");
  assert.equal(shared.title, "Original heading");
});

test("comment notices strip md bodies but preserve legacy text and unformatted titles", async () => {
  await store.setConfig({ feed_markdown: true }, "test");
  const p = await create(U.alice, "## Post **heading**");
  const c = await store.comment(U.bob, p.id, { body: "**A clear answer**" });
  assert.equal((await notice("feed-c:" + c.id)).body, '"Post heading": A clear answer');
  const plain = await create(U.alice, "## Plain **body**", { fmt: "plain" });
  const pc = await store.comment(U.bob, plain.id, { body: "**Literal comment**", fmt: "plain" });
  assert.equal((await notice("feed-c:" + pc.id)).body, '"## Plain **body**": **Literal comment**');
  const titled = await create(U.alice, "## Formatted body", { title: "**Literal title**" });
  const tc = await store.comment(U.bob, titled.id, { body: "**Readable**" });
  assert.equal((await notice("feed-c:" + tc.id)).body, '"**Literal title**": Readable');
});

test("Pepe relay announcements use stored md even after OFF and leave plain bodies unchanged", async () => {
  await store.setMention(U.owner, ROOM, true);
  await runQuery("DELETE FROM feed_mentions");
  await runQuery("DELETE FROM feed_kv WHERE key LIKE 'mention_at:%'");
  await store.setConfig({ feed_markdown: true }, "test");
  const p = await create(U.alice, "## Relay **heading**", { community: ROOM });
  await store.setConfig({ feed_markdown: false }, "test");
  let lines = await store.takeMentions("https://example.test");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].post, p.id);
  assert.match(lines[0].text, /Relay heading — /);
  assert.doesNotMatch(lines[0].text, /\*\*|##/);
  await runQuery("DELETE FROM feed_kv WHERE key LIKE 'mention_at:%'");
  await create(U.alice, "## Literal **marks**", { community: ROOM });
  lines = await store.takeMentions("https://example.test");
  assert.equal(lines.length, 1);
  assert.match(lines[0].text, /## Literal \*\*marks\*\* — /);
});

test("closed Markdown code can illustrate unowned stickers; actual stickers still require ownership", async () => {
  await store.setConfig({ feed_markdown: true }, "test");
  const token = "[sticker:pixelpepe/happy]";
  const p = await create(U.alice, "Use `" + token + "` as an example.");
  assert.equal(p.fmt, "md");
  const c = await store.comment(U.bob, p.id, { body: "```text\n" + token + "\n```" });
  await store.setConfig({ feed_markdown: false }, "test");
  await store.edit(U.alice, p.id, { body: "```\n" + token + "\n```" });
  await store.editComment(U.bob, c.id, "Example: `" + token + "`");
  await assert.rejects(store.edit(U.alice, p.id, { body: token }), (e) => e.refuse === true);
  await assert.rejects(store.editComment(U.bob, c.id, token), (e) => e.refuse === true);
  await store.setConfig({ feed_markdown: true }, "test");
  await assert.rejects(create(U.alice, token), (e) => e.refuse === true);
  await assert.rejects(store.comment(U.bob, p.id, { body: token }), (e) => e.refuse === true);
  await assert.rejects(create(U.alice, "`" + token + "`", { fmt: "plain" }), (e) => e.refuse === true);
});

test("formatting fragments and URL destinations cannot manufacture active sticker tokens", async () => {
  await store.setConfig({ feed_markdown: true }, "test");
  const fragments = "[sticker:pixe**lpepe**/happy]";
  const url = "[example](https://example.test/[sticker:pixelpepe/happy])";
  const p = await create(U.alice, fragments);
  assert.equal(p.body, fragments);
  const c = await store.comment(U.bob, p.id, { body: url });
  assert.equal((await row("feed_comments", c.id)).body, url);
  await store.edit(U.alice, p.id, { body: url });
  await store.editComment(U.bob, c.id, fragments);
});

// ── 1.99aij (owner 2026-11-03): a Markdown spoiler reads "[spoiler]" in every plain excerpt, never its words ──
const SECRET = "Snape kills Dumbledore";
const spoiled = "## The ||" + SECRET + "|| ending\nWorth **reading**.";
const LABEL = "The [spoiler] ending Worth reading.";
const noSecret = (s, what) => assert.ok(!/snape|kills|dumbledore/i.test(String(s)), what + " leaks the spoiler: " + s);
async function admin() {
  await runQuery("INSERT OR IGNORE INTO users (userId, username, displayname, password, class, level, created_at) VALUES ('u_boss', 'boss', 'boss', 'x', 'Admin', 5, '2020-01-01 00:00:00')");
  return { userId: "u_boss", username: "boss", class: "Admin" };
}

test("1.99aij: comment, reply, mention, crosspost, report and removal notices read [spoiler]", async () => {
  const A = await admin();
  await store.setConfig({ feed_markdown: true }, "test");
  try {
    const p = await create(U.alice, spoiled);
    const c = await store.comment(U.bob, p.id, { body: "Agreed, ||" + SECRET + "|| was a shock" });
    assert.equal((await notice("feed-c:" + c.id)).body, '"' + LABEL + '": Agreed, [spoiler] was a shock');
    const r = await store.comment(U.alice, p.id, { body: "||" + SECRET + "|| indeed", parent: c.id });
    assert.equal((await notice("feed-c:" + r.id + ":p")).body, 'On "' + LABEL + '": [spoiler] indeed');
    // a name inside a spoiler still notifies its owner (sourceText), but the notice's text is "[spoiler]" too
    const m = await store.comment(U.owner, p.id, { body: "@bob look: ||" + SECRET + " @bob||" });
    assert.equal((await notice("fmention:c:" + m.id + ":" + U.bob.userId)).body, "@bob look: [spoiler]");
    const x = await store.crosspost(U.bob.userId, p.id, { community: ROOM });
    assert.equal(x.title, LABEL, "the crosspost's stored title");
    assert.equal((await row("feed_posts", x.id)).title, LABEL);
    assert.equal((await notice("feed-xp:" + x.id)).body, '"' + LABEL + '"');
    await store.report(U.bob, { post: p.id, reason: "spam" });
    const rep = await notice("feed-rep:" + p.id + ":" + (await row("feed_posts", p.id)).created);
    assert.equal(rep.body, 'Spam: "The [spoiler] ending\n\nWorth reading."');
    await store.removeComment(A, c.id, "spoilers");
    assert.equal((await notice("feed-crm:" + c.id)).body, '"Agreed, [spoiler] was a shock" was removed by a moderator: spoilers');
    await store.remove(A, p.id, "spoilers");
    assert.equal((await notice("feed-rm:" + p.id)).body, '"The [spoiler] ending\n\nWorth reading." was removed by an admin: spoilers');
    for (const n of await getQuery("SELECT title, body FROM inbox")) { noSecret(n.title, "a title"); noSecret(n.body, "a notice"); }
  } finally { await store.setConfig({ feed_markdown: false }, "test"); }
});

test("1.99aij: labels, slugs and Pepe's Camfrog relay read [spoiler]; a cut never reaches into the hidden words", async () => {
  await store.setMention(U.owner, ROOM, true);
  await runQuery("DELETE FROM feed_mentions");
  await runQuery("DELETE FROM feed_kv WHERE key LIKE 'mention_at:%'");
  await store.setConfig({ feed_markdown: true }, "test");
  try {
    const p = await create(U.alice, spoiled, { community: ROOM });
    const PL = require(path.join(repo, "postlabel"));
    assert.equal(PL.postLabel(p), LABEL);
    noSecret(p.url, "the post's address");
    assert.match(p.url, /\/the-spoiler-ending/);
    const lines = await store.takeMentions("https://example.test");
    assert.equal(lines.length, 1);
    assert.match(lines[0].text, /The \[spoiler\] ending Worth reading\. — /);
    noSecret(lines[0].text, "the relay line");
    // a long spoiler is one word: the words after it survive the label's word limit, none of its own are counted
    const long = "Intro ||" + Array.from({ length: 40 }, (_, i) => "hidden" + i).join(" ") + "|| after the spoiler";
    const w = PL.bodyWords({ body: long, fmt: "md" });
    assert.equal(w.text, "Intro [spoiler] after the spoiler");
    assert.equal(w.cut, false);
    for (const n of [5, 9, 12, 60]) assert.ok(!/hidden/.test(require(path.join(repo, "postmd")).plain(long).slice(0, n)), "a cut at " + n);
  } finally { await store.setConfig({ feed_markdown: false }, "test"); }
});

test("1.99aij: plain-stored posts and comments keep || as typed (no spoilers to hide), the switch off as before", async () => {
  await store.setConfig({ feed_markdown: false }, "test");
  const p = await create(U.alice, "Plain ||" + SECRET + "|| text");
  assert.equal(p.fmt, null);
  const c = await store.comment(U.bob, p.id, { body: "Plain ||reply||" });
  assert.equal((await notice("feed-c:" + c.id)).body, '"Plain ||' + SECRET + '|| text": Plain ||reply||');
});
