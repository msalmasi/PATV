// Offline tests for 1.99ex's mobile + identity pass:
//   * phones: every text field is >= 16px (iOS zooms into smaller ones, then the page scrolls sideways); user zoom stays on
//   * the pad's "In the Camfrog room" rows: avatar | name (ellipsis) | fixed controls - never pushed out of the card;
//     a long name on the mic no longer widens the page
//   * people look like themselves everywhere: profile photo + equipped name style on feed posts, comments and DMs,
//     from ONE batched users query per page / response (userlook.js, feedstore.authors, messages.dress); Pepe stays Pepe
//   * postLabel(): never "(no title)" - title > link title > first words > media kind > "Post by <author>"
//   * feed "seen" state per account (feedseen.js) + the pad Feed tab's local merge on sign-in (pad-tabs.js)
//   NODE_PATH=G:/PATV/node_modules node --test test/mobile-ux.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-ux-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");

// count the users lookups: wrap getQuery BEFORE the modules that destructure it are loaded
const dbUtils = require(path.join(repo, "dbUtils"));
const { runQuery } = dbUtils;
const realGet = dbUtils.getQuery;
const seenSql = [];
dbUtils.getQuery = (sql, params) => { seenSql.push(String(sql)); return realGet(sql, params); };
const getQuery = dbUtils.getQuery;
const lookQueries = () => seenSql.filter((s) => /FROM users WHERE (userId IN|LOWER\(username\) IN)/.test(s) && /avatar/.test(s)).length;

const ejs = require("ejs");
const inbox = require(path.join(repo, "inbox"));
const follows = require(path.join(repo, "follows"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const dm = require(path.join(repo, "messages"));
const cosmetics = require(path.join(repo, "cosmetics"));
const web = require(path.join(repo, "feedweb"));
const UL = require(path.join(repo, "userlook"));
const PL = require(path.join(repo, "postlabel"));
const seen = require(path.join(repo, "feedseen"));
const T = require(path.join(repo, "public", "js", "pad-tabs.js"));
require(path.join(repo, "terms"))._setRequired(false);

const rd = (...p) => fs.readFileSync(path.join(repo, ...p), "utf8");
const ROOM = "plant_based_chatting";
const U = {};
async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, camfrogUsername, level, created_at, avatar)
                  VALUES (?, ?, ?, 'x', 'pleb', ?, 5, '2026-01-01 00:00:00', ?)`, [id, name, extra.display || name, name + "cf", extra.avatar || null]);
  return (U[name] = { userId: id, username: name, class: "pleb" });
}
async function equipName(userId, itemId) {
  const r = await runQuery("INSERT INTO user_cosmetics (user_id, item_id, source, acquired) VALUES (?, ?, 'test', ?)", [userId, itemId, Date.now()]);
  const inv = (await getQuery("SELECT id FROM user_cosmetics WHERE user_id = ? AND item_id = ? ORDER BY id DESC LIMIT 1", [userId, itemId]))[0].id;
  await runQuery("INSERT OR REPLACE INTO user_cosmetic_equips (user_id, kind, inv_id) VALUES (?, 'name_color', ?)", [userId, inv]);
  return r;
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await inbox.ready;
  await follows.init();
  await rooms.init();
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, uploads_per_hour: 1000, post_gap_secs: 0, comment_gap_secs: 0 }, "test");
  await dm.init();
  await cosmetics.ready;
  await mkUser("alice", { display: "Alice", avatar: "https://cdn.example.com/a.png" });
  await mkUser("bob", { display: "Bob", avatar: "avatar.png" });                 // the default placeholder = no photo
  await mkUser("carol", { display: "Carol", avatar: "javascript:alert(1)" });     // never a usable photo
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, avatar) VALUES ('pepe-bot', 'Pepe', 'Pepe', 'x', 'Bot', '/public/img/pepe.png')");
  await equipName(U.alice.userId, "nc_bubblegum");
  await equipName(U.carol.userId, "nc_frogbow");
  await equipName("pepe-bot", "nc_gold");                                         // Pepe stays Pepe even if he had one
  await require(path.join(repo, "cosmetics")).nameStyles(["alice"]);              // warm the shared name cache
});

// ── 1. phones: no zoom on focus ──
test("styles.css: every text field is >= 16px at phone widths / touch, over page CSS; zoom is never disabled", () => {
  const css = rd("public", "css", "styles.css");
  const m = css.match(/@media \(max-width: 820px\), \(pointer: coarse\) \{([\s\S]*?)\n\}/);
  assert.ok(m, "the phone media block");
  const block = m[1];
  for (const sel of ["input:not([type=\"checkbox\"])", "textarea", "select", "[contenteditable]"]) assert.ok(block.includes(sel), sel);
  assert.match(block, /font-size: max\(16px, 1em\) !important;/);
  assert.match(block, /html:not\(#patv-16px\) textarea/, "id-level specificity beats feed.css's !important composer rule");
  assert.doesNotMatch(block, /type="submit"\]\)?,\s*$/m);
  // the one page rule with !important on a field's font-size is a class rule - lower specificity than the global one
  const feed = rd("public", "css", "feed.css");
  assert.doesNotMatch(feed, /#[A-Za-z][\w-]*[^{]*textarea[^{]*\{[^}]*font-size:[^;]*!important/);
  const layout = rd("views", "layout.ejs");
  assert.match(layout, /<meta name="viewport" content="width=device-width, initial-scale=1.0">/);
  for (const f of fs.readdirSync(path.join(repo, "views"))) {
    if (!f.endsWith(".ejs")) continue;
    assert.doesNotMatch(rd("views", f), /maximum-scale|user-scalable/, f + " never disables zoom");
  }
  assert.match(layout, /styles\.css\?v=\d+/);
});

// ── 2. the pad's user list ──
test("room.ejs: roster rows are avatar | name (ellipsis) | fixed controls; mic names ellipse instead of widening the page", () => {
  const html = rd("views", "room.ejs");
  assert.match(html, /\.rm \.people li \{ display: grid; grid-template-columns: 28px minmax\(0, 1fr\) max-content;[^}]*min-width: 0; max-width: 100%/);
  assert.match(html, /\.rm \.people \.nm \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
  assert.match(html, /\.rm \.people \.ic \{[^}]*justify-self: end;[^}]*flex: none;[^}]*white-space: nowrap;/);
  assert.match(html, /\.rm \.people \.ic > \* \{ display: inline-grid; place-items: center; width: 26px; height: 26px;/, "the buttons are fixed squares");
  assert.match(html, /\.rm \.people \{ overflow-x: hidden; \}/);
  assert.match(html, /\.rm \.mic \.holder \.nm \{ min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
  // the row is built as avatar, name, then the controls span (cam, ⋯, mic) - in that order
  const js = html.slice(html.indexOf("var li = el('li'); li.appendChild(avatar(u));"));
  assert.ok(js.indexOf("li.appendChild(n);") < js.indexOf("li.appendChild(ic)"), "name before the controls");
});

// ── 3. people look like themselves ──
test("userlook: one users query for a mix of ids and usernames; safe photos only; Pepe never gets a style", async () => {
  const before = lookQueries();
  const L = await UL.looks({ ids: [U.alice.userId, "pepe-bot"], usernames: ["BOB", "carol", "nobody"] });
  assert.equal(lookQueries() - before, 1, "ONE query");
  assert.equal(L.get(U.alice.userId).avatar, "https://cdn.example.com/a.png");
  assert.equal(L.get("alice").nameCss, "color: #ff6ec7;");
  assert.equal(L.get("bob").avatar, null, "the default placeholder is no photo");
  assert.equal(L.get("carol").avatar, null, "javascript: never");
  assert.match(L.get("carol").nameCss, /linear-gradient/);
  assert.equal(L.get("pepe-bot").nameCss, ""); assert.equal(L.get("pepe-bot").avatar, null); assert.equal(L.get("pepe-bot").bot, true);
  assert.equal(UL.avatarOf("/media/u/x.webp"), "/media/u/x.webp");
  assert.equal(UL.avatarOf("/a/../b.png"), null);
  assert.equal(UL.avatarOf('https://x.y/a"onerror="1'), null);
  const av = UL.avHtml({ username: "alice", display: "Alice", avatar: "https://cdn.example.com/a.png" });
  assert.match(av, /^<span class="av av-ph" style="--h:\d+" aria-hidden="true">A<img src="https:\/\/cdn\.example\.com\/a\.png" alt="" loading="lazy"[^>]*onerror="this\.remove\(\)"><\/span>$/, "photo over the monogram");
  assert.equal(UL.avHtml({ username: "bob", display: "Bob" }).includes("<img"), false);
  assert.match(UL.avHtml({ username: "Pepe", bot: true }), /av-pepe/);
  assert.equal(UL.nameHtml({ display: "<b>x</b>", nameCss: "color: #ff6ec7;" }), '<span class="cx-name" style="color: #ff6ec7;">&lt;b&gt;x&lt;/b&gt;</span>');
  assert.equal(UL.nameHtml({ display: "Pepe", nameCss: "color: red;", bot: true }), "Pepe");
});

test("name colours stay readable on the dark theme (every solid name colour >= 4.5:1 on #111)", () => {
  const lum = (hex) => { const c = hex.replace("#", "").match(/../g).map((x) => parseInt(x, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const cat = JSON.parse(rd("cosmetics.json"));
  for (const it of cat.items.filter((i) => i.kind === "name_color")) {
    const s = it.style || {};
    if (s.color) assert.ok(ratio(s.color, "#111111") >= 4.5, it.id + " " + s.color);
    if (Array.isArray(s.gradient)) {
      const avg = s.gradient.reduce((a, c) => a + ratio(c, "#111111"), 0) / s.gradient.length;
      assert.ok(avg >= 4.5, it.id + " gradient average " + avg.toFixed(2));
    }
  }
});

test("feed: post header + comments show the photo and name style, from ONE users query per page; Pepe stays Pepe", async () => {
  const a = await store.create(U.alice.userId, { title: "", body: "", link: null, community: ROOM, images: [] }).catch((e) => e);
  // a body-less, picture-less post is refused; post with a body instead
  const p1 = a && a.id ? a : await store.create(U.alice.userId, { title: "Hello", body: "first post body here", community: ROOM });
  await store.comment(U.bob, p1.id, { body: "nice" });
  await store.comment(U.carol, p1.id, { body: "agreed" });
  const pepeP = await store.create("pepe-bot", { title: "", body: "ribbit from the pond", community: ROOM }).catch(() => null);

  let before = lookQueries();
  const page = await store.list({ room: ROOM, viewer: U.bob, sort: "new" });
  assert.equal(lookQueries() - before, 1, "the page's authors in ONE query");
  const post = page.posts.find((x) => x.id === p1.id);
  assert.equal(post.author.avatar, "https://cdn.example.com/a.png");
  assert.equal(post.author.nameCss, "color: #ff6ec7;");
  if (pepeP) { const pp = page.posts.find((x) => x.author.bot); if (pp) { assert.equal(pp.author.nameCss, ""); assert.equal(pp.author.avatar, null); } }

  const html = await ejs.renderFile(path.join(repo, "views", "partials", "feed-post.ejs"),
    { p: post, fx: web.fx, embeds: require(path.join(repo, "stageembed")), host: "test", viewer: U.bob, modRooms: new Set(), detail: false, ctxRoom: null });
  assert.match(html, /<span class="av av-ph" style="--h:\d+" aria-hidden="true">A<img src="https:\/\/cdn\.example\.com\/a\.png"/);
  assert.match(html, /<a class="fp-author" href="\/u\/alice"><span class="cx-name" style="color: #ff6ec7;">Alice<\/span><\/a>/);

  before = lookQueries();
  const C = await store.comments(p1.id, U.bob);
  assert.equal(lookQueries() - before, 1, "every commenter in ONE query");
  const cb = C.find((c) => c.author.username === "bob"), cc = C.find((c) => c.author.username === "carol");
  assert.equal(cb.author.avatar, null); assert.equal(cb.author.nameCss, "");
  assert.match(cc.author.nameCss, /linear-gradient/);
  const ch = await ejs.renderFile(path.join(repo, "views", "partials", "feed-comment.ejs"), { c: cc, p: post, fx: web.fx, viewer: U.bob, staff: false, modRooms: new Set() });
  assert.match(ch, /<span class="av" style="--h:\d+" aria-hidden="true">C<\/span>/, "no photo: the monogram");
  assert.match(ch, /class="fp-author" href="\/u\/carol"><span class="cx-name" style="background: linear-gradient/);
  const pepeHtml = await ejs.renderFile(path.join(repo, "views", "partials", "feed-comment.ejs"),
    { c: { ...cc, author: { username: "Pepe", display: "Pepe", bot: true, nameCss: "color: red;" } }, p: post, fx: web.fx, viewer: U.bob, staff: false, modRooms: new Set() });
  assert.match(pepeHtml, /av-pepe/); assert.match(pepeHtml, /🤖 Pepe/); assert.doesNotMatch(pepeHtml, /color: red/);
});

test("DMs: the conversation list, the header and the bubbles carry photos + name styles, one users query each", async () => {
  const r = await dm.send({ userId: U.alice.userId }, { to: "bob", body: "hi bob" });
  await dm.send({ userId: U.bob.userId }, { conversation: r.conversation.id, body: "hey" });
  assert.equal(r.message.fromAvatar, "https://cdn.example.com/a.png", "the live event's message");
  assert.equal(r.message.fromCss, "color: #ff6ec7;");

  let before = lookQueries();
  const L = await dm.list(U.bob.userId);
  assert.equal(lookQueries() - before, 1);
  assert.equal(L[0].with.username, "alice"); assert.equal(L[0].with.avatar, "https://cdn.example.com/a.png"); assert.equal(L[0].with.nameCss, "color: #ff6ec7;");

  before = lookQueries();
  const H = await dm.history(U.bob, r.conversation.id);
  assert.equal(lookQueries() - before, 1);
  const fromA = H.messages.find((m) => m.from === "alice"), fromB = H.messages.find((m) => m.from === "bob");
  assert.equal(fromA.fromAvatar, "https://cdn.example.com/a.png"); assert.equal(fromA.fromCss, "color: #ff6ec7;");
  assert.equal(fromB.fromAvatar, null); assert.equal(fromB.fromCss, "");

  const head = await dm.header(U.bob, r.conversation.id);
  assert.equal(head.with.avatar, "https://cdn.example.com/a.png");
  // the page script draws them (photo over the monogram, styled name) and the CSS knows both
  const js = rd("public", "js", "messages.js");
  assert.match(js, /function photoOn\(a, src\)/);
  assert.match(js, /avatar\(m\.from, m\.fromDisplay, null, m\.fromAvatar\)/);
  assert.match(js, /nameNode\(w\.display \|\| '\[gone\]', w\.nameCss\)/);
  assert.match(js, /nameNode\(m\.fromDisplay \|\| m\.from \|\| '\[gone\]', m\.fromCss\)/);
  assert.match(rd("public", "css", "messages.css"), /\.dm \.av-ph > img \{ position: absolute; inset: 0;/);
});

// ── 4. postLabel ──
test("postLabel: title > link title > first ~10 words > media kind > Post by <author>", () => {
  const a = { display: "Alice", username: "alice" };
  assert.deepEqual(PL.labelOf({ title: "  Hi  there ", body: "x", author: a }), { text: "Hi there", fallback: false, level: 1 });
  assert.deepEqual(PL.labelOf({ title: "", link: { title: "A <b>page</b>" }, body: "words", author: a }), { text: "A page", fallback: true, level: 2 });
  assert.equal(PL.postLabel({ body: "**one** two [three](https://x.y) https://drop.me four five six seven eight nine ten eleven", author: a }),
    "one two three four five six seven eight nine ten…");
  assert.equal(PL.postLabel({ body: "just a few words", author: a }), "just a few words", "no … when nothing was cut");
  assert.equal(PL.postLabel({ body: "https://only.a.link/", images: [{}], author: a }), "📷 Photo by Alice", "a bare URL isn't words");
  assert.equal(PL.postLabel({ capture: { room: { title: "PepeLab" } }, images: [{}], author: a }), "📌 Capture from PepeLab");
  assert.equal(PL.postLabel({ images: [{}], ai: [{ kind: "image" }], author: a }), "✨ AI picture by Alice");
  assert.equal(PL.postLabel({ video: [{}], images: [{}], author: a }), "🎬 Video by Alice");
  assert.equal(PL.postLabel({ images: [{}], author: a }), "📷 Photo by Alice");
  assert.equal(PL.postLabel({ audio: [{}], author: a }), "🔊 Audio by Alice");
  assert.deepEqual(PL.labelOf({ author: a }), { text: "Post by Alice", fallback: true, level: 5 });
  assert.equal(PL.postLabel({ author: { username: "Pepe", display: "Pepe", bot: true } }), "Post by Pepe");
  assert.equal(PL.postLabel({ title: "", xpost: { post: { title: "The original", author: a } }, author: { display: "Bob" } }), "The original", "a crosspost reads as its original");
  assert.equal(PL.postLabel(null), "Post");
  // the URL slug uses the same words
  const pads = require(path.join(repo, "pads"));
  assert.equal(pads.postSlug({ body: "**Hello** world https://x.y/z and more" }), "hello-world-and-more");
});

test("no view or module renders \"(no title)\"; HOT, cards, Hop, DM embeds, the pad's latest posts and og:title use postLabel", () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? (d.name === "node_modules" || d.name === "test" || d.name.startsWith(".") || d.name === "camfrog-bot" ? [] : walk(path.join(dir, d.name))) : [path.join(dir, d.name)]));
  for (const f of walk(repo).filter((f) => /\.(ejs|js)$/.test(f) && !/\.min\.js$/.test(f))) {
    assert.doesNotMatch(fs.readFileSync(f, "utf8"), /\(no title\)/, path.relative(repo, f));
  }
  assert.match(rd("feedstore.js"), /const lab = require\("\.\/postlabel"\)\.labelOf\(p\);/);
  assert.match(rd("views", "partials", "home-hot.ejs"), /h\.titleFallback \? ' class="hh-fb"'/);
  assert.match(rd("views", "partials", "feed-post.ejs"), /fp-title fp-fb/);
  assert.match(rd("hop.js"), /title: PL\.postLabel\(p\), titleFallback: PL\.labelOf\(p\)\.fallback/);
  assert.match(rd("dmembeds.js"), /postlabel"\)\.postLabel\(p\)/);
  assert.match(rd("bridge.js"), /postlabel"\)\.postLabel\(p\)\.slice\(0, 120\)/);
  assert.match(rd("feedweb.js"), /postlabel"\)\.postLabel\(p\)\.slice\(0, 90\)/);
  assert.match(rd("views", "post.ejs"), /fx\.postLabel\(p\)/);
  assert.match(rd("follows.js"), /postlabel"\)\.postLabel\(/);
});

test("feed card: a picture-only post shows the muted fallback label; a titled post the normal title", async () => {
  const base = (await store.list({ room: ROOM, viewer: U.bob, sort: "new" })).posts.find((x) => x.author.username === "alice");
  const pic = { ...base, title: "", body: "", link: null, images: [{ id: "i", kind: "image", file: "0".repeat(32) + ".webp", thumb: null, w: 10, h: 10 }], ai: [] };
  const render = (p) => ejs.renderFile(path.join(repo, "views", "partials", "feed-post.ejs"),
    { p, fx: web.fx, embeds: require(path.join(repo, "stageembed")), host: "test", viewer: U.bob, modRooms: new Set(), detail: false, ctxRoom: null });
  const h1 = await render(pic);
  assert.match(h1, /<h3 class="fp-title fp-fb"><a href="[^"]+">📷 Photo by Alice<\/a><\/h3>/);
  const h2 = await render({ ...base, title: "Real title" });
  assert.match(h2, /<h3 class="fp-title"><a href="[^"]+">Real title<\/a><\/h3>/);
  const h3 = await render({ ...pic, body: "some words of text" });
  assert.doesNotMatch(h3, /fp-fb/, "a body already says what it is - no repeated label");
  assert.match(rd("public", "css", "feed.css"), /\.fp-title\.fp-fb \{ font-weight: 500;/);
});

// ── 5. feed seen per account ──
test("feedseen: per account, monotonic, scopes validated, clamped to now; GET/POST guarded", async () => {
  let now = Date.UTC(2026, 9, 8, 12);
  seen._setClock(() => now);
  const sc = seen.padScope(ROOM);
  assert.equal(sc, "pad:" + ROOM);
  assert.equal(await seen.one(U.alice.userId, sc), null, "never seen");
  assert.equal(await seen.mark(U.alice.userId, sc, now - 5000), now - 5000);
  assert.equal(await seen.mark(U.alice.userId, sc, now - 9000), now - 5000, "never moves back (a stale browser can't un-see)");
  assert.equal(await seen.mark(U.alice.userId, sc, now + 3600e3), now + 60e3, "never the future");
  assert.equal(await seen.mark(U.alice.userId, "pad:<x>", now), null);
  assert.equal(await seen.mark(U.alice.userId, "everything", now), null);
  assert.equal(await seen.mark(U.alice.userId, "all", 0), null);
  await seen.mark(U.alice.userId, "following", now - 1);
  await seen.mark(U.alice.userId, "profile:bob", now - 2);
  assert.deepEqual(await seen.get(U.alice.userId, ["all", "following", "profile:bob", "bad scope"]), { following: now - 1, "profile:bob": now - 2 });
  assert.equal(await seen.one(U.bob.userId, sc), null, "per account");

  // the routes
  const express = require("express");
  const app = express(); app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? U[u] : null; next(); };
  seen.register(app, { addUser });
  const server = app.listen(0); const base = "http://127.0.0.1:" + server.address().port;
  try {
    const post = (body, h = {}) => fetch(base + "/api/feed/seen", { method: "POST", headers: { "Content-Type": "application/json", "X-Requested-With": "fetch", ...h }, body: JSON.stringify(body) });
    assert.equal((await post({ scope: sc, upto: now })).status, 401, "signed out: localStorage only");
    assert.equal((await post({ scope: sc, upto: now }, { "x-test-user": "bob", "X-Requested-With": "" })).status, 403);
    assert.equal((await post({ scope: sc, upto: now }, { "x-test-user": "bob", Origin: "https://evil.example" })).status, 403);
    const ok = await post({ scope: sc, upto: now - 10 }, { "x-test-user": "bob" });
    assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { ok: true, upto: now - 10 });
    const g = await fetch(base + "/api/feed/seen?scopes=" + encodeURIComponent(sc + ",all"), { headers: { "x-test-user": "bob" } });
    assert.deepEqual(await g.json(), { ok: true, seen: { [sc]: now - 10 } });
  } finally { server.close(); }
});

test("pad Feed tab: signed in, the account's seen time merges this browser's (max) and pushes it up; each view syncs", () => {
  assert.equal(T.mergeSeen(1000, 2000), 2000);
  assert.equal(T.mergeSeen(3000, 2000), 3000);
  assert.equal(T.mergeSeen(null, 2000), 2000, "first sign-in: the browser's value");
  assert.equal(T.mergeSeen(3000, null), 3000, "a new browser: the account's value");
  assert.equal(T.mergeSeen(null, null), null);
  assert.equal(T.needsPush(1000, 2000), true, "the browser saw more: send it up");
  assert.equal(T.needsPush(null, 2000), true);
  assert.equal(T.needsPush(3000, 2000), false);
  assert.equal(T.needsPush(3000, null), false);
  // a post the account already saw isn't new on another browser
  const posts = [{ id: "a", created: 1500 }, { id: "b", created: 2500 }];
  assert.equal(T.newCount(posts, T.mergeSeen(2000, null), 3000), 1);
  const js = rd("public", "js", "pad-tabs.js");
  assert.match(js, /root\.fetch\('\/api\/feed\/seen', \{ method: 'POST', credentials: 'same-origin'/);
  assert.match(js, /'X-Requested-With': 'fetch'/);
  assert.match(js, /store\(keySeen, seen\); syncSeen\(seen\);/, "localStorage stays (the signed-out fallback)");
  assert.match(js, /setTimeout\(pushSeen, 1500\)/, "debounced");
  assert.match(js, /var keyTab = 'patvPadTab:'/, "the remembered tab stays per browser");
  const room = rd("views", "room.ejs");
  assert.match(room, /account: typeof feedSeen !== 'undefined' && feedSeen && feedSeen\.scope \? \{ scope: feedSeen\.scope, upto:/);
  assert.match(rd("bridge.js"), /feedSeen = \{ scope: require\("\.\/feedseen"\)\.padScope\(R\.id\), upto: await require\("\.\/feedseen"\)\.one\(/);
  assert.match(rd("index.js"), /require\("\.\/feedseen"\)\.register\(app, \{ addUser \}\);/);
});
