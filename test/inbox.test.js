// Offline tests for the on-site inbox (inbox.js, 1.99au): Pepe's push lands with the linked account,
// an unlinked Camfrog name's notices wait and attach on link (!verify) / account merge, only the owner
// can see or mark their notices, mark read / mark all read, prefs feed Pepe's "may I PM" answer, the
// nav bell count, and the page escapes what it shows.
//   node --test test/inbox.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-test-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token";
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const inbox = require(path.join(repo, "inbox"));
const { moveUserRows } = require(path.join(repo, "accountMerge"));

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0,
                  liked INTEGER DEFAULT 0, twitchBonus INTEGER DEFAULT 0, twitchBonus_at TEXT, discordBonus INTEGER DEFAULT 0,
                  discordBonus_at TEXT, camfrogUsername TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT, userId TEXT, type TEXT, points INTEGER)");
  await runQuery("CREATE TABLE IF NOT EXISTS pending_camfrog_links (code TEXT, userId TEXT, camfrogUsername TEXT, expires_at TEXT)");
  await inbox.ready;
  for (const [id, name, cf] of [["u1", "alice", "alicecf"], ["u2", "bob", "bobcf"], ["u3", "carol", null]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES (?, ?, ?, 'x', ?)", [id, name, name, cf]);
  }
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  app.use(cookieParser());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(inbox.navCount);
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  app.get("/probe", (req, res) => res.json({ unread: res.locals.inboxUnread }));
  inbox.register(app, { isBotToken: (t) => t === "bot-token", addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server.close());

const H = (u, extra = {}) => Object.assign({ "content-type": "application/json" }, u ? { "x-test-user": u } : {}, extra);
async function push(body, token = "bot-token") {
  const r = await fetch(base + "/api/inbox/push", { method: "POST", headers: H(null), body: JSON.stringify(Object.assign({ password: token }, body)) });
  return { status: r.status, d: await r.json() };
}
async function page(u, q = "") {
  const r = await fetch(base + "/inbox" + q, { headers: H(u), redirect: "manual" });
  return { status: r.status, html: await r.text(), loc: r.headers.get("location") };
}
async function form(p, u, fields, extra) {
  return fetch(base + p, { method: "POST", redirect: "manual",
    headers: Object.assign({ "content-type": "application/x-www-form-urlencoded" }, u ? { "x-test-user": u } : {}, extra || {}),
    body: new URLSearchParams(fields).toString() });
}
const rows = (uid) => getQuery("SELECT * FROM inbox WHERE user_id = ? ORDER BY id", [uid]);

test("push needs the bot token and a sane Camfrog name", async () => {
  assert.equal((await push({ camfrog: "alicecf", body: "x" }, "nope")).status, 403);
  assert.equal((await push({ camfrog: "bad name!", body: "x" })).status, 400);
  assert.equal((await push({ camfrog: "alicecf" })).status, 400);
});

test("push files the notice under the linked account (case-insensitive), once per ref", async () => {
  const body = { camfrog: "AliceCF", kind: "staking", title: "Stake done: PAT 100,000",
                 body: "🏦 alicecf/main: staked PAT 100,000 in 🤖 Auto at today's price.", link: "/staking", ref: "vault:q1:1" };
  const r = await push(body);
  assert.equal(r.status, 200);
  assert.equal(r.d.stored, "user");
  assert.equal(r.d.pm, true);
  const again = await push(body);
  assert.equal(again.d.dup, true);
  const mine = await rows("u1");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].kind, "staking");
  assert.equal(mine[0].link, "/staking");
  assert.equal(mine[0].read_at, null);
});

test("links are local paths only; unknown kinds become 'system'", async () => {
  await push({ camfrog: "alicecf", kind: "evil", body: "a", link: "//evil.example/x", ref: "l1" });
  await push({ camfrog: "alicecf", kind: "loan", body: "b", link: "javascript:alert(1)", ref: "l2" });
  const r = (await rows("u1")).filter((x) => x.ref === "l1" || x.ref === "l2");
  assert.equal(r[0].kind, "system");
  assert.equal(r[0].link, null);
  assert.equal(r[1].link, "/wallet");            // the category's default
});

test("an unlinked Camfrog name waits as pending and attaches on !verify", async () => {
  const r = await push({ camfrog: "newbie", kind: "lotto", body: "🎟️ you won PAT 5,000", ref: "lotto:1:newbie" });
  assert.equal(r.d.stored, "pending");
  assert.equal(r.d.pm, true);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox_pending WHERE camfrog = 'newbie'"))[0].n, 1);
  // carol links "newbie" through the real !verify path (user.controller.js -> completeCamfrogLink)
  const uc = require(path.join(repo, "user.controller"));
  await runQuery("INSERT INTO pending_camfrog_links (code, userId, camfrogUsername, expires_at) VALUES ('ABC123', 'u3', 'newbie', ?)",
    [new Date(Date.now() + 600000).toISOString()]);
  let out = null;
  const res = { status() { return this; }, json(d) { out = d; return this; } };
  await uc.verifyCamfrogLink({ body: { code: "ABC123", camfrogUsername: "newbie", password: "bot-token" } }, res);
  assert.equal(out && out.success, true, JSON.stringify(out));
  const c = await rows("u3");
  assert.equal(c.length, 1);
  assert.match(c[0].body || c[0].title, /won PAT 5,000/);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox_pending WHERE camfrog = 'newbie'"))[0].n, 0);
});

test("pending notices also attach when an auto (CF…) account is merged on link", async () => {
  await runQuery("INSERT INTO users (userId, username, password, camfrogUsername) VALUES ('cf1', 'CFdave', 'x', 'davecf')");
  await runQuery("INSERT INTO users (userId, username, password) VALUES ('u4', 'dave', 'x')");
  await push({ camfrog: "davecf", kind: "wager", body: "you're the judge", ref: "w:1" });      // -> the auto account
  await inbox.add("u4", { kind: "wager", body: "same notice, already here", ref: "w:1" });      // dup ref on the target
  await inbox.add("cf1", { kind: "loan", body: "only on the auto account", ref: "l:9" });
  const moved = await moveUserRows("cf1", "u4");
  assert.ok(moved["inbox.user_id"] >= 1);
  const d = await rows("u4");
  assert.equal(d.length, 2, "the duplicate ref stays once, the other moves");
  assert.equal((await rows("cf1")).length, 0);
});

test("only the owner sees their inbox; signed-out goes to login", async () => {
  const anon = await page(null);
  assert.equal(anon.status, 302);
  assert.match(anon.loc, /^\/login\?next=/);
  await push({ camfrog: "bobcf", kind: "market", title: "<script>alert('x')</script> judge", body: "<img src=x onerror=1>", ref: "m:1" });
  const a = await page("u1");
  assert.equal(a.status, 200);
  assert.match(a.html, /Stake done: PAT 100,000/);
  assert.doesNotMatch(a.html, /judge/);
  const b = await page("u2");
  assert.doesNotMatch(b.html, /Stake done/);
  assert.match(b.html, /&lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt; judge/);
  assert.doesNotMatch(b.html, /<script>alert/);
  assert.doesNotMatch(b.html, /<img src=x/);
});

test("mark read: one, someone else's (refused), and all", async () => {
  const bobs = await rows("u2");
  const r1 = await form("/inbox/read", "u1", { id: String(bobs[0].id) });
  assert.equal(r1.status, 302);
  assert.equal((await rows("u2"))[0].read_at, null, "alice can't mark bob's notice read");
  const open = await fetch(base + "/inbox/open/" + bobs[0].id, { headers: H("u1"), redirect: "manual" });
  assert.equal(open.headers.get("location"), "/inbox");
  assert.equal((await rows("u2"))[0].read_at, null, "nor open it");

  const a = await rows("u1");
  const r2 = await fetch(base + "/inbox/read", { method: "POST", headers: Object.assign(H("u1"), { "x-requested-with": "fetch" }),
                                                 body: JSON.stringify({ id: a[0].id }) });
  const d2 = await r2.json();
  assert.equal(d2.changed, 1);
  assert.equal(d2.unread, a.length - 1);
  const o = await fetch(base + "/inbox/open/" + a[1].id, { headers: H("u1"), redirect: "manual" });
  assert.equal(o.headers.get("location"), "/inbox", "a notice without a safe link opens the inbox");
  const r3 = await form("/inbox/read", "u1", { all: "1", back: "/inbox?page=1" });
  assert.equal(r3.headers.get("location"), "/inbox?page=1");
  assert.equal((await rows("u1")).filter((x) => !x.read_at).length, 0);
  const bad = await form("/inbox/read", "u1", { all: "1", back: "https://evil.example/" });
  assert.equal(bad.headers.get("location"), "/inbox");
  const xs = await form("/inbox/read", "u2", { all: "1" }, { origin: "https://evil.example" });
  assert.equal(xs.status, 403);
});

test("opening a notice marks it read and follows its local link", async () => {
  await push({ camfrog: "bobcf", kind: "loan", body: "paid", link: "/wallet", ref: "o:1" });
  const n = (await rows("u2")).find((x) => x.ref === "o:1");
  const r = await fetch(base + "/inbox/open/" + n.id, { headers: H("u2"), redirect: "manual" });
  assert.equal(r.headers.get("location"), "/wallet");
  assert.ok((await rows("u2")).find((x) => x.ref === "o:1").read_at);
});

test("prefs: unticked categories make the push answer pm:false", async () => {
  const r = await form("/inbox/prefs", "u2", { pm_staking: "1", pm_loan: "1" });          // everything else off
  assert.equal(r.status, 302);
  assert.equal((await push({ camfrog: "bobcf", kind: "market", body: "x", ref: "p:1" })).d.pm, false);
  assert.equal((await push({ camfrog: "bobcf", kind: "loan", body: "x", ref: "p:2" })).d.pm, true);
  assert.equal(await inbox.pmAllowed("u2", "shop"), false);
  assert.equal(await inbox.pmAllowed("u1", "shop"), true, "defaults to on");
});

test("nav bell: unread count for a signed-in page view, nothing for API calls or signed-out", async () => {
  const tok = jwt.sign({ userId: "u2", username: "bob" }, "test-secret");
  const unread = (await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = 'u2' AND read_at IS NULL"))[0].n;
  const r = await (await fetch(base + "/probe", { headers: { cookie: "jwt=" + tok } })).json();
  assert.equal(r.unread, unread);
  assert.ok(unread > 0);
  const anon = await (await fetch(base + "/probe")).json();
  assert.equal(anon.unread, undefined);
  const bad = await (await fetch(base + "/probe", { headers: { cookie: "jwt=garbage" } })).json();
  assert.equal(bad.unread, undefined);
});

test("pagination and the category filter", async () => {
  for (let i = 0; i < 30; i++) await inbox.add("u3", { kind: i % 2 ? "tip" : "shop", title: `n${i}`, ref: "pg" + i });
  const p1 = await page("u3");
  assert.match(p1.html, /Page 1 of 2/);
  assert.match(p1.html, /Older →/);
  const p2 = await page("u3", "?page=2");
  assert.match(p2.html, /Page 2 of 2/);
  const tips = await page("u3", "?kind=tip");
  assert.doesNotMatch(tips.html, /Page 1 of/);
  assert.doesNotMatch(tips.html, />n0</);
  assert.match(tips.html, />n1</);
  const empty = await page("u3", "?kind=bounty");
  assert.match(empty.html, /Nothing here in Bounties/);
});

test("the site's own notices: shop order updates land in the inbox and the PM honours the inbox switch", async () => {
  await runQuery("ALTER TABLE users ADD COLUMN email TEXT").catch(() => {});
  const shop = require(path.join(repo, "shop"));
  await shop.ready;
  const out = await shop.notify("u1", { subject: "Order #7 fulfilled: Gift card", text: "The seller fulfilled it.", pm: "📦 Order #7 is ready", link: "/shop/orders/7" });
  assert.equal(out.inbox, true);
  assert.equal(out.pm, true);
  const n = (await rows("u1")).find((x) => x.title === "Order #7 fulfilled: Gift card");
  assert.ok(n && n.kind === "shop" && n.link === "/shop/orders/7");
  const act = (await getQuery("SELECT args FROM pepe_actions WHERE kind = 'notify' ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual(JSON.parse(act.args).slice(0, 1).concat(JSON.parse(act.args).slice(2)), ["alicecf", "shop"]);
  // bob turned shop PMs off on the inbox page (prefs test): inbox only
  const out2 = await shop.notify("u2", { subject: "Order #8 refunded", text: "Refunded.", link: "/shop/orders/8" });
  assert.equal(out2.inbox, true);
  assert.equal(out2.pm, false);
});
