// 💸 Tips on feed posts (1.99pv, posttips.js): the Tip button on every post card, the shared tip money path
// (tips.transferPat - unchanged routing: full amount sender -> author, no cut), the post tag (post_tips), retry
// safety (one idempotency key per attempt), the refusals (own post, Pepe, deleted, blocks, bad amounts, balance),
// the author's inbox notice linking the post, the tally on the card, and the tip achievements counting post tips.
//   NODE_PATH=G:/PATV/node_modules node --test test/post-tips.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "posttips-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const web = require(path.join(repo, "feedweb"));
const PT = require(path.join(repo, "posttips"));
const tips = require(path.join(repo, "tips"));
require(path.join(repo, "terms"))._setRequired(false);

let base, server, U = {};
const users = new Map();
async function mkUser(name, bal = 0, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', 'pleb', ?, ?, 0, '2026-01-01 00:00:00', 0)`, [id, name, extra.display || name, bal, extra.camfrog || null]);
  const u = { userId: id, username: name, class: "pleb" };
  users.set(id, u);
  return u;
}
const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [u.userId]))[0].b;

// the same claim / replay / release rules as index.js idemBegin (the tip route's table)
async function idemBegin(req, res, endpoint) {
  const key = req.body && req.body.idempotency_key ? String(req.body.idempotency_key).slice(0, 120) : null;
  if (!key) return { replay: false, done: () => {}, fail: () => {} };
  await runQuery(`CREATE TABLE IF NOT EXISTS idempotency_keys (key TEXT PRIMARY KEY, endpoint TEXT NOT NULL, status INTEGER, body TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  const claimed = await runQuery("INSERT OR IGNORE INTO idempotency_keys (key, endpoint) VALUES (?, ?)", [key, endpoint]);
  if (!claimed || claimed.changes === 0) {
    const prev = await getQuery("SELECT status, body FROM idempotency_keys WHERE key = ?", [key]);
    if (prev.length && prev[0].status) res.status(prev[0].status).json(Object.assign(JSON.parse(prev[0].body || "{}"), { replayed: true }));
    else res.status(409).json({ ok: false, error: "in_progress" });
    return { replay: true };
  }
  return { replay: false, done: (s, b) => runQuery("UPDATE idempotency_keys SET status = ?, body = ? WHERE key = ?", [s, JSON.stringify(b || {}), key]),
           fail: () => runQuery("DELETE FROM idempotency_keys WHERE key = ? AND status IS NULL", [key]) };
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0)`);
  await runQuery(`CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, counterparty TEXT,
                  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ct TEXT NOT NULL, file TEXT NOT NULL, bytes INTEGER, secs REAL, subject TEXT,
                  by_user TEXT, room TEXT, created INTEGER, expires INTEGER, deleted INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE IF NOT EXISTS dm_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (blocker_id, blocked_id))");
  U.alice = await mkUser("alice", 0, { camfrog: "alicecf", display: "Alice ✨" });
  U.bob = await mkUser("bob", 100000, { camfrog: "bobcf" });
  U.carol = await mkUser("carol", 5000, { camfrog: "carolcf" });
  U.dave = await mkUser("dave", 50000, { camfrog: "davecf" });
  await rooms.init();
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0, comments_per_hour: 1000 }, "test");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  web.register(app, { addUser, isBotToken: (t) => t === "bot" });
  PT.register(app, { addUser, idemBegin });
  require(path.join(repo, "pads")).register(app);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });

const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {});
async function call(method, url, u, body, headers) {
  const r = await fetch(base + url, { method, headers: Object.assign(H(u), headers || {}), body: body === undefined ? undefined : JSON.stringify(body) });
  let d = null;
  try { d = await r.json(); } catch (e) { d = null; }
  return { status: r.status, d };
}
const page = async (url, u) => { const r = await fetch(base + url, { headers: u ? { "x-test-user": u.userId } : {} }); return { status: r.status, html: await r.text() }; };
const mkPost = async (u, body) => {
  const r = await call("POST", "/api/feed/posts", u, Object.assign({ community: "patv:lounge" }, body));
  assert.equal(r.status, 200, JSON.stringify(r.d));
  return r.d.id;
};
const tipPost = (u, id, body) => call("POST", `/api/feed/posts/${id}/tip`, u, body);
let P1;

test("a post tip moves PAT over the normal tip path: full amount, both ledger rows, counterparty + note, tagged with the post", async () => {
  P1 = await mkPost(U.alice, { title: "My first set", body: "hello" });
  const r = await tipPost(U.bob, P1, { amount: "2,500", note: "  great   set  ", idempotency_key: "k1" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.amount, 2500);
  assert.equal(r.d.balance, 97500);
  assert.deepEqual(r.d.tips, { n: 1, total: 2500 });
  assert.equal(await bal(U.bob), 97500);
  assert.equal(await bal(U.alice), 2500);                 // the full amount - no cut
  const tx = await getQuery("SELECT userId, type, points, counterparty, note, transactionId FROM transactions ORDER BY type");
  assert.deepEqual(tx.map((t) => [t.userId, t.type, t.points, t.counterparty, t.note]),
                   [["u_alice", "tip received", 2500, "u_bob", "great set"], ["u_bob", "tip sent", -2500, "u_alice", "great set"]]);
  const tag = (await getQuery("SELECT * FROM post_tips"))[0];
  assert.equal(tag.post_id, P1);
  assert.equal(tag.sender_id, "u_bob");
  assert.equal(tag.recipient_id, "u_alice");
  assert.equal(tag.amount, 2500);
  assert.equal(tag.kind, "post");
  assert.deepEqual([tag.sent_tx, tag.recv_tx].sort(), tx.map((t) => t.transactionId).sort());
});

test("the author's inbox notice (kind tip, so the Telegram tip alert follows) links the post", async () => {
  const n = (await getQuery("SELECT * FROM inbox WHERE user_id = 'u_alice' AND kind = 'tip'"))[0];
  assert.ok(n, "a notice was filed");
  assert.match(n.title, /^bob tipped your post PAT 2,500$/);
  assert.equal(n.body, '"great set"');
  assert.equal(n.link, await store.postPath(P1));
  assert.match(n.link, /\/posts\//);
});

test("retry-safe: the same key replays the answer and never tips (or tags) twice; a new key is a new tip", async () => {
  const again = await tipPost(U.bob, P1, { amount: "2,500", idempotency_key: "k1" });
  assert.equal(again.status, 200);
  assert.equal(again.d.replayed, true);
  assert.equal(await bal(U.bob), 97500);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM post_tips"))[0].n, 1);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM transactions"))[0].n, 2);
  // the key is per sender: carol's "k1" is hers
  const c = await tipPost(U.carol, P1, { amount: "1k", idempotency_key: "k1" });
  assert.equal(c.status, 200, JSON.stringify(c.d));
  assert.equal(c.d.replayed, undefined);
  assert.deepEqual(c.d.tips, { n: 2, total: 3500 });
});

test("refusals: own post, bad amounts, more than the balance, blocks, Pepe's posts, deleted posts, signed out, cross-site", async () => {
  const before = await bal(U.alice);
  assert.equal((await tipPost(U.alice, P1, { amount: 100 })).status, 400);                      // own post
  for (const a of ["0", "-5", "abc", "1,2,3", ""]) {
    const r = await tipPost(U.bob, P1, { amount: a });
    assert.equal(r.status, 400, a);
  }
  const over = await tipPost(U.carol, P1, { amount: "1m", idempotency_key: "over" });
  assert.equal(over.status, 400);
  assert.match(over.d.error, /insufficient/i);
  assert.equal(await bal(U.carol), 4000);
  // a refused key is released: the same key can try again (nothing was committed)
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM idempotency_keys WHERE key LIKE '%:over'"))[0].n, 0);
  // blocks either way (the gifts rule)
  await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES ('u_alice', 'u_dave', 1)");
  const b = await tipPost(U.dave, P1, { amount: 100 });
  assert.equal(b.status, 403);
  assert.match(b.d.error, /can't tip alice/);
  await runQuery("DELETE FROM dm_blocks");
  // Pepe's posts
  await runQuery("INSERT INTO feed_posts (id, author_id, body, created) VALUES ('pepepost0001', ?, 'ribbit', ?)", [store.PEPE_ID, Date.now()]);
  assert.equal((await tipPost(U.bob, "pepepost0001", { amount: 100 })).status, 400);
  // deleted
  const P2 = await mkPost(U.alice, { body: "to delete" });
  await runQuery("UPDATE feed_posts SET deleted_at = ? WHERE id = ?", [Date.now(), P2]);
  assert.equal((await tipPost(U.bob, P2, { amount: 100 })).status, 409);
  assert.equal((await tipPost(U.bob, "nosuchpost99", { amount: 100 })).status, 404);
  assert.equal((await tipPost(null, P1, { amount: 100 })).status, 401);
  assert.equal((await call("POST", `/api/feed/posts/${P1}/tip`, U.bob, { amount: 100 }, { origin: "https://evil.example" })).status, 403);
  assert.equal(await bal(U.alice), before);
});

test("Pepe's own posts can't be tipped (the button is hidden, the API refuses)", async () => {
  const r = await PT.tip({ sender: U.bob, postId: "pepepost0001", amount: 100 }).catch((e) => e);
  assert.ok(r.refuse);
  assert.match(r.message, /Pepe/);
});

test("the card: a Tip button for signed-in viewers on other people's posts, the tally for everyone, none on your own post", async () => {
  const id = P1;
  const asBob = (await page("/feed?sort=new", U.bob)).html;
  const card = asBob.slice(asBob.indexOf(`id="p-${id}"`), asBob.indexOf("</article>", asBob.indexOf(`id="p-${id}"`)));
  assert.match(card, /data-act="tip" data-to="alice" data-name="Alice ✨"/);
  assert.match(card, /class="fp-tips"[^>]*title="2 tips on this post, 3,500 PAT in all"/);
  assert.match(card, /2 tips · <\/span><b>3.5k<\/b> PAT/);
  assert.match(asBob, /post-tip\.js\?v=2" data-me="bob"/);
  assert.match(asBob, /patamount\.js/);
  const asAlice = (await page("/feed?sort=new", U.alice)).html;
  const own = asAlice.slice(asAlice.indexOf(`id="p-${id}"`), asAlice.indexOf("</article>", asAlice.indexOf(`id="p-${id}"`)));
  assert.doesNotMatch(own, /data-act="tip"/);
  assert.match(own, /class="fp-tips"/);                   // the author sees the tally too
  const anon = (await page("/feed?sort=new")).html;
  assert.doesNotMatch(anon, /data-act="tip"/);
  assert.doesNotMatch(anon, /post-tip\.js/);
  assert.match(anon, /class="fp-tips"/);                  // visible to everyone
  // the post page uses the same card
  const pp = (await page(await store.postPath(id), U.bob)).html;
  assert.match(pp, /data-act="tip" data-to="alice"/);
});

test("achievements: post tips count as tips (tip_people / tip_fans, tips_sent_pat / tips_recv_pat) - the rows are the same", async () => {
  await runQuery("CREATE TABLE IF NOT EXISTS follows (follower TEXT, target_kind TEXT, target_id TEXT)");
  const S = require(path.join(repo, "achsocial"));
  const bob = await S.metrics("u_bob");
  const alice = await S.metrics("u_alice");
  assert.equal(bob.tip_people, 1);                         // 2,500 >= TIP_MIN to one person
  assert.equal(alice.tip_fans, 2);                         // bob (2,500) and carol (1,000) - both >= TIP_MIN
  const carol = await S.metrics("u_carol");
  assert.equal(carol.tip_people, 1);
  const sent = (await getQuery("SELECT COALESCE(SUM(-points),0) AS s FROM transactions WHERE userId = 'u_bob' AND type = 'tip sent'"))[0].s;
  assert.equal(sent, 2500);
});

test("posttips.forPosts: totals per post, kind filter for other surfaces (PATV Creators)", async () => {
  const m = await PT.forPosts([P1, "nosuchpost99"]);
  assert.deepEqual(m.get(P1), { n: 2, total: 3500 });
  assert.equal(m.has("nosuchpost99"), false);
  assert.deepEqual(await PT.forPost(P1, { kind: "creator" }), { n: 0, total: 0 });
  // a caller's own check runs before any PAT moves
  const b0 = await bal(U.dave);
  const e = await PT.tip({ sender: U.dave, postId: P1, amount: 100, kind: "creator", check: () => { throw new PT.Refuse(403, "subscribers only"); } }).catch((x) => x);
  assert.equal(e.message, "subscribers only");
  assert.equal(await bal(U.dave), b0);
  const ok = await PT.tip({ sender: U.dave, postId: P1, amount: 100, kind: "creator", key: "dave:c1" });
  assert.equal(ok.amount, 100);
  assert.deepEqual(await PT.forPost(P1, { kind: "creator" }), { n: 1, total: 100 });
});

test("tips.js is the one tip path: index.js uses it (no second copy), no cut, the note rules", async () => {
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  assert.match(src, /require\("\.\/tips"\)/);
  assert.doesNotMatch(src, /async function transferPat\(/);
  assert.match(src, /require\("\.\/posttips"\)\.register\(app, \{ addUser, idemBegin \}\)/);
  assert.equal(tips.cleanTipNote("  a\u0000b   c "), "a b c");
  assert.equal(Array.from(tips.cleanTipNote("x".repeat(200))).length, tips.TIP_NOTE_MAX);
  assert.equal((await tips.transferPat("bob", "bob", 5)).status, 400);
  assert.equal((await tips.transferPat("bob", "alice", 0)).status, 400);
});

test("post-tip.js: parses amounts with patamount, builds the sheet from the design system, updates the tally", () => {
  const src = fs.readFileSync(path.join(repo, "public/js/post-tip.js"), "utf8");
  assert.match(src, /ds-scrim sheet/);
  assert.match(src, /ds-modal/);
  assert.match(src, /ds-btn gold/);
  assert.match(src, /idempotency_key: p\.key/);
  assert.doesNotMatch(src, /innerHTML/);
  // run it in a tiny DOM-less sandbox for the parser
  const ctx = { window: {}, document: { currentScript: null, addEventListener() {} }, console };
  ctx.window.PATVAmount = require(path.join(repo, "public/js/patamount"));
  ctx.self = ctx.window;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const P = ctx.window.PATVPostTip;
  assert.equal(P._parse("2,500"), 2500);
  assert.equal(P._parse("1.5m"), 1500000);
  assert.ok(Number.isNaN(P._parse("1,2,3")));
});

test("every string the feature shows is in en.json", () => {
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales/en.json"), "utf8"));
  for (const k of ["feed.p.tip", "feed.p.tip_title", "feed.p.tips_n", "feed.p.tips_title"]) assert.ok(en[k], k);
  const js = fs.readFileSync(path.join(repo, "public/js/post-tip.js"), "utf8");
  const keys = [...js.matchAll(/_t\('(js\.feed\.tip\.[a-z0-9_]+)'/g)].map((m) => m[1]);
  assert.ok(keys.length > 20);
  for (const k of keys) assert.ok(en[k], k);
});
