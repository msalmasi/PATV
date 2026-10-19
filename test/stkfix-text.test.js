// stkfix B2 + B4 through the real paths (messages.js, telegram.js, feedmentions.js, feedstore.js):
//   B2 a sticker reads "[sticker: Happy Pepe]" - never the raw [sticker:pack/id] token - in the Camfrog DM alert's quote,
//      the Telegram DM alert, the feed @mention notice and the comment / reply notices; the DM itself still shows the picture
//   B4 Pepe's DM answer keeps only stickers of house packs listed right now; any other known token is stored as text
//   NODE_PATH=G:/PATV/node_modules node --test test/stkfix-text.test.js      (temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stkfix-text-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const inbox = require(path.join(repo, "inbox"));
const dm = require(path.join(repo, "messages"));
const TG = require(path.join(repo, "telegram"));
const M = require(path.join(repo, "mentions"));
const PA = require(path.join(repo, "padaccess"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const STK = require(path.join(repo, "stickers"));
const i18n = require(path.join(repo, "i18n"));
require(path.join(repo, "terms"))._setRequired(false);
// the catalogs' text is HTML-safe; these lines are plain text
const plain = (s) => String(s).replace(/&(amp|lt|gt|quot|#34|#39);/g, (m, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#34": '"', "#39": "'" })[e]);
const ES = Object.fromEntries(Object.entries(require(path.join(repo, "locales", "es.json"))).map(([k, v]) => [k, typeof v === "string" ? plain(v) : v]));
const word = (lang) => { const t = i18n.tFor(lang); return t.has("stk.fallback_word") ? plain(t("stk.fallback_word")) : "sticker"; };

let T = Date.UTC(2026, 9, 10, 12);
for (const m of [dm, TG, M, STK]) m._setClock(() => T);
const tick = (ms) => { T += ms; };
const RAW = /\[sticker:[a-z0-9]+\/[a-z0-9]+\]/;

const U = {};
async function mkUser(name, o = {}) {
  const id = o.id || "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, 5, '2026-01-01 00:00:00', 0)`, [id, name, o.display || name, o.class || "pleb", o.cf === undefined ? name + "cf" : o.cf]);
  U[name] = { userId: id, username: name, class: o.class || "pleb" };
}
const until = async (fn, ms = 5000) => { let v; for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 40))) { v = await fn(); if (v) return v; } return v; };

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery(`CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ct TEXT NOT NULL, file TEXT NOT NULL, bytes INTEGER, secs REAL, subject TEXT,
                  by_user TEXT, room TEXT, created INTEGER, expires INTEGER, deleted INTEGER DEFAULT 0)`);
  await mkUser("alice", { display: "Alice A" });
  await mkUser("bob");
  await mkUser("carol");
  await mkUser("plantowner");
  await mkUser("dave");                                  // reads Spanish (his Telegram alert)
  await mkUser("Pepe", { id: "pepe-bot", class: "Bot", cf: null });
  await inbox.ready;
  await dm.init();
  await M.init();
  await PA.init();
  await rooms.init();
  await rooms.setOwner("plant_based_chatting", "plantowner", "test");
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0, comments_per_hour: 1000 }, "test");
  await STK.init();
  await TG.init();
  for (const n of ["alice", "carol"]) await STK.grantComp(U[n].userId, "pixelpepe", "test");
  await runQuery("INSERT INTO telegram_links (user_id, tg_id, linked_at) VALUES (?, '900001', ?)", [U.bob.userId, T]);
  await runQuery("INSERT INTO telegram_links (user_id, tg_id, linked_at) VALUES (?, '900002', ?)", [U.dave.userId, T]);
});

test("B2: a DM with a sticker - the page shows the picture; the Camfrog and Telegram alerts quote '[sticker: Happy Pepe]'", async () => {
  const r = await dm.send(U.alice, { to: "bob", body: "look [sticker:pixelpepe/happy] ok" });
  assert.match(r.message.html, /<img class="stk" src="\/public\/stickers\/pixelpepe\/happy\.svg" alt="Happy Pepe"/, "the site still renders it");
  // Camfrog (Pepe's alert in a room PM): after the grace period
  tick(dm.ALERT_GRACE_MS + 1000);
  const a = (await dm.claimAlerts()).find((x) => x.login === "bobcf");
  assert.ok(a, "bob's Camfrog alert");
  assert.match(a.text, /: "look \[sticker: Happy Pepe\] ok"$/);
  assert.doesNotMatch(a.text, RAW);
  // Telegram (fire and forget from send)
  const row = await until(async () => (await getQuery("SELECT text FROM telegram_outbox WHERE user_id = ? AND kind = 'dm'", [U.bob.userId]))[0]);
  assert.ok(row, "bob's Telegram alert");
  assert.match(row.text, /“look \[sticker: Happy Pepe\] ok”/);
  assert.doesNotMatch(row.text, RAW);
});

test("B2: the /messages list's preview (plain text) reads '[sticker: Name]' - in the viewer's language - never the raw token", async () => {
  const conv = (await dm.list(U.bob.userId)).find((c) => c.with && c.with.username === "alice");
  assert.ok(conv && conv.last, "bob's conversation with alice");
  assert.equal(conv.last.text, "look [sticker: Happy Pepe] ok");
  const es = (await dm.list(U.bob.userId, { t: i18n.tFor("es") })).find((c) => c.with && c.with.username === "alice");
  assert.equal(es.last.text, `look [${word("es")}: ${ES["stk.s.pixelpepe.happy"]}] ok`);
  assert.doesNotMatch(es.last.text, RAW);
  // the page and its poll pass the viewer's translator
  const src = fs.readFileSync(path.join(repo, "messages.js"), "utf8");
  assert.match(src, /const convs = await list\(me\.userId, \{ t: req\.t \}\);/);
  assert.match(src, /conversations: await list\(req\.user\.userId, \{ t: req\.t \}\)/);
});

test("B2: the Telegram DM alert names the sticker in the member's language, like the rest of the alert", async () => {
  i18n._prefs.set(U.dave.userId, "es");
  await dm.send(U.alice, { to: "dave", body: "mira [sticker:pixelpepe/happy]" });
  const row = await until(async () => (await getQuery("SELECT text FROM telegram_outbox WHERE user_id = ? AND kind = 'dm'", [U.dave.userId]))[0]);
  assert.ok(row, "dave's Telegram alert");
  assert.ok(row.text.includes(`“mira [${word("es")}: ${ES["stk.s.pixelpepe.happy"]}]”`), row.text);
  assert.doesNotMatch(row.text, RAW);
});

test("B2: feed notices - the @mention notice and the comment / reply notices quote '[sticker: Name]'", async () => {
  const P = await store.create(U.alice.userId, { community: "plant_based_chatting", title: "Monstera", body: "hey @bob [sticker:pixelpepe/cool]" });
  const men = await until(async () => (await getQuery("SELECT * FROM inbox WHERE user_id = ? AND kind = 'mention'", [U.bob.userId]))[0]);
  assert.ok(men, "bob's mention notice");
  assert.match(men.body, /hey @bob \[sticker: Cool Pepe\]/);
  assert.doesNotMatch(men.body, RAW);
  const c = await store.comment(U.carol, P.id, { body: "love it [sticker:pixelpepe/love]" });
  const cn = (await getQuery("SELECT * FROM inbox WHERE user_id = ? AND ref = ?", [U.alice.userId, "feed-c:" + c.id]))[0];
  assert.ok(cn, "alice's comment notice");
  assert.equal(cn.body, '"Monstera": love it [sticker: Pepe in love]');
  const rep = await store.comment(U.alice, P.id, { body: "[sticker:pixelpepe/happy] thanks", parent: c.id });
  const rn = (await getQuery("SELECT * FROM inbox WHERE user_id = ? AND ref = ?", [U.carol.userId, "feed-c:" + rep.id + ":p"]))[0];
  assert.ok(rn, "carol's reply notice");
  assert.equal(rn.body, 'On "Monstera": [sticker: Happy Pepe] thanks');
  // a post with no title: its body is "what" - a sticker there reads as text too
  const P2 = await store.create(U.alice.userId, { community: "plant_based_chatting", title: "", body: "[sticker:pixelpepe/sad] rough day" });
  const c2 = await store.comment(U.carol, P2.id, { body: "hugs" });
  const n2 = (await getQuery("SELECT * FROM inbox WHERE user_id = ? AND ref = ?", [U.alice.userId, "feed-c:" + c2.id]))[0];
  assert.ok(n2, "alice's second comment notice");
  assert.equal(n2.body, '"[sticker: Sad Pepe] rough day": hugs');
});

test("B2: Pepe's '📌 New post' line in the Camfrog room - a post with no title that starts with a sticker reads '[sticker: Name]'", async () => {
  store._setPepeIn(() => true);
  try {
    const P = await store.create(U.alice.userId, { community: "plant_based_chatting", title: "", body: "[sticker:pixelpepe/sleepy] nap time" });
    await runQuery("UPDATE feed_mentions SET sent_at = 1 WHERE sent_at IS NULL AND post_id != ?", [P.id]);     // only this post's line
    const lines = await store.takeMentions("https://patv.test");
    const line = lines.find((x) => x.post === P.id);
    assert.ok(line, "the announcement for the post");
    assert.match(line.text, /^📌 New post on p\/\S+ by \{author\}: \[sticker: Sleepy Pepe\] nap time — https:\/\/patv\.test\//);
    assert.doesNotMatch(line.text, RAW);
  } finally { store._setPepeIn(null); }
});

test("B4: Pepe's answer - house packs listed right now stay stickers; out of season (and unknown) tokens are text", async () => {
  tick(dm.ALERT_GAP_MS);
  const asked = await dm.send(U.carol, { to: "Pepe", body: "send me a sticker" });
  T = Date.UTC(2026, 11, 2, 12);                        // December: 🎃 Spooky Season isn't listed
  const ans = await dm.pepeReply({ conversation: asked.conversation.id, upto: 0, text: "[sticker:pixelpepe/happy] boo [sticker:spooky/pumpkin] [sticker:fake/x]" });
  assert.ok(ans.message && ans.message.id);
  const row = (await getQuery("SELECT body FROM messages WHERE id = ?", [ans.message.id]))[0];
  assert.equal(row.body, "[sticker:pixelpepe/happy] boo [sticker: Jack-o'-lantern] [sticker:fake/x]");
  const html = dm.render(row.body);
  assert.equal((html.match(/<img class="stk/g) || []).length, 1, "one picture: Pixel Pepe");
  assert.doesNotMatch(html, /spooky\/pumpkin\.svg/);
  // in season it would have been a sticker (the same text in October)
  assert.equal(STK.forPepe("[sticker:spooky/pumpkin]", Date.UTC(2026, 9, 20)), "[sticker:spooky/pumpkin]");
});
