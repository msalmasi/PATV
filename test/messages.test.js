// Offline tests for direct messages (messages.js, 1.99cp): members-only reading, blocks both ways, "who can message
// me", the new-account rule, rate limits, reports (admin-only, every read logged, content_audit on send), Pepe's
// Camfrog alerts (grace, one per conversation per 10 min, "N new messages", default on, previews, incognito text),
// the SSE stream, deleting / clearing, safe rendering, and the page + nav count.
//   node --test test/messages.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dm-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const inbox = require(path.join(repo, "inbox"));
const follows = require(path.join(repo, "follows"));
const store = require(path.join(repo, "feedstore"));
const dm = require(path.join(repo, "messages"));

let T = Date.now();
dm._setClock(() => T);
const tick = (ms = 1000) => { T += ms; };

let base, server;
const U = {};
async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, camfrogUsername, level, created_at, discordId)
                  VALUES (?, ?, ?, 'x', ?, ?, ?, ?, ?)`,
                 [id, name, extra.display || name, extra.class || "pleb", extra.camfrog || null, extra.level == null ? 5 : extra.level,
                  "2026-01-01 00:00:00", extra.discord || null]);
  return (U[name] = { userId: id, username: name, class: extra.class || "pleb" });
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await inbox.ready;
  await follows.init();
  await store.init();
  await dm.init();
  await mkUser("alice", { camfrog: "alicecf", display: "Alice ✨" });
  await mkUser("bob", { camfrog: "bobcf" });
  await mkUser("carol", { camfrog: "carolcf" });
  await mkUser("dave");                                   // level 5, nothing linked: not new
  await mkUser("newbie", { level: 0 });                   // level 0, unlinked: new
  await mkUser("lvl1disc", { level: 1, discord: "d1" });  // linked (Discord): not new
  await mkUser("boss", { class: "Admin", camfrog: "bosscf" });
  await mkUser("mod", { class: "Staff", camfrog: "modcf" });
  await mkUser("eve", { camfrog: "evecf" });
  await mkUser("frank", { camfrog: "frankcf" });
  await mkUser("gina", { camfrog: "ginacf" });
  await mkUser("hank", { camfrog: "hankcf" });
  await mkUser("ivy");
  await runQuery("INSERT INTO users (userId, username, displayname, password, class) VALUES ('pepe-bot', 'Pepe', 'Pepe', 'x', 'Bot')");

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  app.use(dm.navCount);
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  app.get("/probe", (req, res) => res.json({ dm: res.locals.dmUnread || 0 }));
  app.get("/events", addUser, (req, res) => (req.query.type === "dm" ? dm.sse(req, res) : res.status(404).end()));
  dm.register(app, { isBotToken: (t) => t === "bot", addUser });
  inbox.register(app, { isBotToken: (t) => t === "bot", addUser });      // 1.99cu: the 🔔 Notices pane lives in /messages
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); for (const set of dm._streams.values()) for (const r of set) { try { r.end(); } catch (e) { /* */ } } });
test.beforeEach(() => { dm._gaps.clear(); tick(2000); });

const H = (u, extra = {}) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {}, extra);
async function call(method, url, u, body, headers) {
  const r = await fetch(base + url, { method, headers: headers || H(u), body: body === undefined ? undefined : JSON.stringify(body) });
  let d = null;
  try { d = await r.json(); } catch (e) { d = null; }
  return { status: r.status, d };
}
const post = (url, u, body, headers) => call("POST", url, u, body, headers);
const get = (url, u) => call("GET", url, u);
async function say(from, to, body = "hi") { tick(1000); return post("/api/messages/send", from, { to: to.username, body }); }
async function sayIn(from, conv, body = "hi") { tick(1000); return post("/api/messages/send", from, { conversation: conv, body }); }
const claim = (pw = "bot") => post("/api/messages/alerts/claim", null, { password: pw });

// ───────────────────────── basics + permissions ─────────────────────────
test("send starts one conversation per pair; only its members can read, mark, delete or report in it", async () => {
  const a = await say(U.alice, U.bob, "hello bob");
  assert.equal(a.status, 200, JSON.stringify(a.d));
  assert.equal(a.d.created, true);
  const c = a.d.conversation.id;
  assert.match(c, /^[a-f0-9]{16}$/);
  const b = await say(U.bob, U.alice, "hi alice");
  assert.equal(b.d.conversation.id, c, "the same conversation both ways");
  assert.equal(b.d.created, false);
  // members read it
  const h = await get(`/api/messages/c/${c}?head=1`, U.alice);
  assert.equal(h.status, 200);
  assert.deepEqual(h.d.messages.map((m) => m.text), ["hello bob", "hi alice"]);
  assert.equal(h.d.conversation.with.username, "bob");
  // non-members get nothing
  assert.equal((await get(`/api/messages/c/${c}`, U.carol)).status, 404);
  assert.equal((await post(`/api/messages/c/${c}/read`, U.carol, {})).status, 404);
  assert.equal((await post(`/api/messages/c/${c}/clear`, U.carol, {})).status, 404);
  assert.equal((await post("/api/messages/send", U.carol, { conversation: c, body: "let me in" })).status, 404);
  assert.equal((await post(`/api/messages/m/${a.d.message.id}/report`, U.carol, { reason: "spam" })).status, 404);
  assert.equal((await post(`/api/messages/m/${a.d.message.id}/delete`, U.carol, {})).status, 404);
  assert.equal((await get(`/api/messages/admin/report/${a.d.message.id}`, U.boss)).status, 404, "not even an admin can open an unreported message");
  const carolList = await get("/api/messages/conversations", U.carol);
  assert.equal(carolList.d.conversations.length, 0);
  // signed out / cross-site / not fetch
  assert.equal((await get("/api/messages/conversations", null)).status, 401);
  assert.equal((await call("GET", "/api/messages/conversations", U.alice, undefined, { "x-test-user": U.alice.userId })).status, 403);
  assert.equal((await call("POST", "/api/messages/send", U.alice, { to: "bob", body: "x" }, H(U.alice, { origin: "https://evil.example" }))).status, 403);
  // unread: bob has read up to his own message (sending marks read); alice has 1 unread from bob
  assert.equal(await dm.unreadTotal(U.alice.userId), 1);
  assert.equal(await dm.unreadTotal(U.bob.userId), 0);
  const L = (await get("/api/messages/conversations", U.alice)).d.conversations[0];
  assert.equal(L.unread, 1);
  assert.equal(L.with.username, "bob");
  assert.equal(L.last.text, "hi alice");
  await post(`/api/messages/c/${c}/read`, U.alice, {});
  assert.equal(await dm.unreadTotal(U.alice.userId), 0);
});

test("refusals: yourself, Pepe, unknown people, empty and over-long messages", async () => {
  assert.equal((await say(U.alice, U.alice)).status, 400);
  assert.equal((await say(U.alice, { username: "Pepe" })).status, 400);
  assert.equal((await say(U.alice, { username: "nobody-here" })).status, 404);
  assert.equal((await say(U.alice, U.carol, "   ")).status, 400);
  assert.equal((await say(U.alice, U.carol, "x".repeat(2001))).status, 400);
});

test("blocks stop messages both ways (and the blocked person isn't told who blocked)", async () => {
  await say(U.carol, U.dave, "hey dave");
  const blk = await post("/api/messages/block", U.dave, { username: "carol", on: true });
  assert.equal(blk.status, 200);
  const c2d = await say(U.carol, U.dave, "you there?");
  assert.equal(c2d.status, 403);
  assert.equal(c2d.d.code, "blocked");
  assert.doesNotMatch(c2d.d.error, /blocked you/i);
  const d2c = await say(U.dave, U.carol, "nope");
  assert.equal(d2c.status, 403);
  assert.equal(d2c.d.code, "you_blocked");
  const head = await get("/api/messages/check?to=carol", U.dave);
  assert.equal(head.d.canSend, false);
  const prefs = await get("/api/messages/prefs", U.dave);
  assert.deepEqual(prefs.d.blocks.map((b) => b.username), ["carol"]);
  await post("/api/messages/block", U.dave, { username: "carol", on: false });
  assert.equal((await say(U.carol, U.dave, "unblocked?")).status, 200);
});

test("who can message me: nobody / people I follow / everyone; once you've written, they can always reply", async () => {
  await post("/api/messages/prefs", U.eve, { who: "nobody" });
  const r = await say(U.frank, U.eve, "hi eve");
  assert.equal(r.status, 403);
  assert.equal(r.d.code, "closed");
  // eve writes to frank herself: frank may reply, despite "nobody"
  const e = await say(U.eve, U.frank, "frank, quick question");
  assert.equal(e.status, 200);
  assert.equal((await say(U.frank, U.eve, "sure")).status, 200);
  // people I follow
  await post("/api/messages/prefs", U.eve, { who: "following" });
  const g = await say(U.gina, U.eve, "hello");
  assert.equal(g.status, 403);
  assert.equal(g.d.code, "following");
  await follows.follow(U.eve, "user", "gina", true);
  assert.equal((await say(U.gina, U.eve, "hello again")).status, 200);
  // back to everyone
  await post("/api/messages/prefs", U.eve, { who: "everyone" });
  assert.equal((await say(U.hank, U.eve, "hi")).status, 200);
  const P = await dm.prefs(U.eve.userId);
  assert.equal(P.who, "everyone");
  // a bogus value doesn't change it
  await post("/api/messages/prefs", U.eve, { who: "admins-only" });
  assert.equal((await dm.prefs(U.eve.userId)).who, "everyone");
});

test("new accounts (level < 2, unlinked) only message people who follow them or wrote to them first", async () => {
  assert.equal(dm.isNewAccount(await store.account(U.newbie.userId)), true);
  assert.equal(dm.isNewAccount(await store.account(U.lvl1disc.userId)), false, "a linked identity isn't new");
  assert.equal(dm.isNewAccount(await store.account(U.dave.userId)), false, "level 2+ isn't new");
  const r = await say(U.newbie, U.alice, "buy my stuff");
  assert.equal(r.status, 403);
  assert.equal(r.d.code, "new");
  // alice follows newbie -> allowed
  await follows.follow(U.alice, "user", "newbie", true);
  assert.equal((await say(U.newbie, U.alice, "thanks for the follow")).status, 200);
  // bob writes to newbie first -> newbie can reply
  assert.equal((await say(U.newbie, U.bob, "hi bob")).status, 403);
  assert.equal((await say(U.bob, U.newbie, "welcome!")).status, 200);
  assert.equal((await say(U.newbie, U.bob, "thank you")).status, 200);
  // the level-1 Discord-linked account isn't limited
  assert.equal((await say(U.lvl1disc, U.carol, "hi")).status, 200);
});

test("rate limits: a double send is refused, per-minute cap, new conversations per day for new accounts", async () => {
  // double Enter
  tick(1000);
  const first = await post("/api/messages/send", U.dave, { to: "ivy", body: "one" });
  assert.equal(first.status, 200);
  const dup = await post("/api/messages/send", U.dave, { to: "ivy", body: "one" });
  assert.equal(dup.status, 429);
  // per minute (20 for established accounts)
  const conv = first.d.conversation.id;
  let refused = null;
  for (let i = 0; i < 25 && !refused; i++) {
    tick(500);
    const r = await post("/api/messages/send", U.dave, { conversation: conv, body: "spam " + i });
    if (r.status === 429) refused = { i, r };
  }
  assert.ok(refused, "the per-minute cap bites");
  assert.equal(refused.i, dm.LIMITS.per_min - 1, "after per_min messages in a minute");
  tick(61e3);
  assert.equal((await sayIn(U.dave, conv, "a minute later")).status, 200);
  // new conversations per day for a new account (who's followed by everyone it writes to)
  const targets = [];
  for (let i = 0; i < dm.LIMITS.new_convos_per_day + 1; i++) {
    const t = await mkUser("tgt" + i, { camfrog: "tgt" + i + "cf" });
    await follows.follow(t, "user", "newbie", true);
    targets.push(t);
  }
  tick(86400e3 + 1000);                                  // a fresh day (newbie started conversations in an earlier test)
  const codes = [];
  for (const t of targets) codes.push((await say(U.newbie, t, "hello")).status);
  assert.deepEqual(codes.slice(0, -1).filter((s) => s !== 200), [], "the first N go through");
  assert.equal(codes[codes.length - 1], 429, "then: come back tomorrow");
  tick(86400e3 + 1000);
  assert.equal((await say(U.newbie, targets[targets.length - 1], "next day")).status, 200);
});

// ───────────────────────── delete / clear / render ─────────────────────────
test("delete: only your own message, for everyone ('message deleted', text gone from the database)", async () => {
  const s = await say(U.alice, U.carol, "oops wrong chat");
  const id = s.d.message.id, c = s.d.conversation.id;
  assert.equal((await post(`/api/messages/m/${id}/delete`, U.carol, {})).status, 403, "the other member can't delete it");
  assert.equal((await post(`/api/messages/m/${id}/delete`, U.alice, {})).status, 200);
  const row = (await getQuery("SELECT body, deleted_at, deleted_by FROM messages WHERE id = ?", [id]))[0];
  assert.equal(row.body, null);
  assert.ok(row.deleted_at);
  assert.equal(row.deleted_by, "author");
  const h = await get(`/api/messages/c/${c}`, U.carol);
  const m = h.d.messages.find((x) => x.id === id);
  assert.equal(m.deleted, true);
  assert.equal(m.text, "");
  assert.equal(m.html, "");
  // clear (for me) and delete conversation (for me): the other side keeps theirs
  await say(U.carol, U.alice, "still here");
  assert.equal((await post(`/api/messages/c/${c}/clear`, U.alice, {})).status, 200);
  assert.equal((await get(`/api/messages/c/${c}`, U.alice)).d.messages.length, 0);
  assert.ok((await get(`/api/messages/c/${c}`, U.carol)).d.messages.length > 0);
  await post(`/api/messages/c/${c}/clear`, U.alice, { hide: true });
  assert.ok(!(await get("/api/messages/conversations", U.alice)).d.conversations.some((x) => x.id === c), "gone from alice's list");
  await say(U.carol, U.alice, "come back");
  const back = (await get("/api/messages/conversations", U.alice)).d.conversations.find((x) => x.id === c);
  assert.ok(back, "a new message brings it back");
  assert.deepEqual((await get(`/api/messages/c/${c}`, U.alice)).d.messages.map((x) => x.text), ["come back"]);
});

test("rendering: escaped, links are nofollow ugc in a new tab, only http(s)", () => {
  const h = dm.render('<img src=x onerror=alert(1)> see https://example.com/a?b=1&c=2. javascript:alert(1)\nnext "line"');
  assert.doesNotMatch(h, /<img/);
  assert.match(h, /&lt;img/);
  assert.match(h, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" rel="nofollow noopener noreferrer ugc" target="_blank">/);
  assert.doesNotMatch(h, /href="javascript/);
  assert.match(h, /<br>next &quot;line&quot;/);
});

// ───────────────────────── reports + admin access ─────────────────────────
test("report: admin-only queue + notice; only admins open it, only reported messages, every read logged; content_audit on send", async () => {
  const s = await say(U.frank, U.gina, "you are a [slur]");
  const id = s.d.message.id;
  const aud = await getQuery("SELECT * FROM content_audit WHERE kind = 'message' AND target_id = ?", [String(id)]);
  assert.equal(aud.length, 1, "an admin-only safety record for the message");
  assert.equal(aud[0].user_id, U.frank.userId);
  assert.equal((await post(`/api/messages/m/${id}/report`, U.frank, { reason: "harassment" })).status, 400, "not your own");
  const r = await post(`/api/messages/m/${id}/report`, U.gina, { reason: "harassment", note: "please look" });
  assert.equal(r.status, 200);
  assert.equal((await post(`/api/messages/m/${id}/report`, U.gina, { reason: "harassment" })).status, 429, "a burst guard");
  tick(4000);
  assert.equal((await post(`/api/messages/m/${id}/report`, U.gina, { reason: "harassment" })).d.already, true);
  const notes = await getQuery("SELECT * FROM inbox WHERE user_id = ? AND kind = 'admin' AND link = '/feed/admin#dms'", [U.boss.userId]);
  assert.equal(notes.length, 1, "admins get one notice");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = ? AND link = '/feed/admin#dms'", [U.mod.userId]))[0].n, 0, "Staff don't");
  const Q = await dm.reportQueue();
  const g = Q.find((x) => x.messageId === id);
  assert.ok(g);
  assert.equal(g.sender, "frank");
  assert.equal(JSON.stringify(Q).includes("slur"), false, "the queue never carries the text");
  // the sender deletes it - the report keeps a copy
  await post(`/api/messages/m/${id}/delete`, U.frank, {});
  // Staff and members can't open it; admins can, and it's logged first
  assert.equal((await get(`/api/messages/admin/report/${id}`, U.mod)).status, 403);
  assert.equal((await get(`/api/messages/admin/report/${id}`, U.gina)).status, 403);
  const before = (await getQuery("SELECT COUNT(*) AS n FROM content_audit_views"))[0].n;
  const d = await get(`/api/messages/admin/report/${id}?why=checking`, U.boss);
  assert.equal(d.status, 200, JSON.stringify(d.d));
  assert.equal(d.d.message.text, "you are a [slur]");
  assert.equal(d.d.message.deleted, true);
  assert.equal(d.d.details.records.length, 1);
  const views = await getQuery("SELECT * FROM content_audit_views ORDER BY id DESC LIMIT 1");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM content_audit_views"))[0].n, before + 1);
  assert.equal(views[0].target_kind, "message");
  assert.equal(views[0].target_id, String(id));
  assert.equal(views[0].admin_id, U.boss.userId);
  assert.equal(views[0].subject_id, U.frank.userId);
  assert.equal(views[0].reason, "checking");
  // outcome: remove + tell the reporter
  const act = await post("/api/messages/admin/report-action", U.boss, { message: id, action: "remove" });
  assert.equal(act.status, 200);
  assert.equal(act.d.notified, 1);
  assert.ok(!(await dm.reportQueue()).some((x) => x.messageId === id));
  assert.equal((await post("/api/messages/admin/report-action", U.mod, { message: id, action: "dismiss" })).status, 403);
});

test("report: ban removes the message and bans the sender from the feed - and from messaging", async () => {
  const s = await say(U.hank, U.ivy, "spam spam spam");
  await post(`/api/messages/m/${s.d.message.id}/report`, U.ivy, { reason: "spam" });
  const a = await post("/api/messages/admin/report-action", U.boss, { message: s.d.message.id, action: "ban", days: 0, reason: "spam" });
  assert.equal(a.status, 200, JSON.stringify(a.d));
  const r = await say(U.hank, U.alice, "hi");
  assert.equal(r.status, 403);
  assert.equal(r.d.code, "banned");
  const m = (await getQuery("SELECT deleted_by FROM messages WHERE id = ?", [s.d.message.id]))[0];
  assert.equal(m.deleted_by, "admin:boss");
  await store.unban(U.boss, U.hank.userId, "");
  assert.equal((await say(U.hank, U.alice, "hi again")).status, 200, "unbanned: messaging again");
});

// ───────────────────────── Camfrog alerts ─────────────────────────
test("alerts: bot token; grace period; one per conversation per 10 min with 'N new messages'; reading cancels; default on", async () => {
  assert.equal((await claim("nope")).status, 403);
  await claim(); tick(dm.ALERT_GAP_MS + 1000); await claim();       // drain earlier tests
  const P = await dm.prefs(U.bob.userId);
  assert.equal(P.alerts, true, "Camfrog alerts are on by default");
  assert.equal(P.preview, true);
  const s = await say(U.carol, U.bob, "are you coming to the stream tonight? it starts at nine and there's a raffle");
  assert.equal((await claim()).d.alerts.length, 0, "nothing inside the grace period (they may be reading it)");
  tick(dm.ALERT_GRACE_MS + 1000);
  let A = (await claim()).d.alerts;
  assert.equal(A.length, 1);
  assert.equal(A[0].login, "bobcf");
  assert.equal(A[0].from_login, "carolcf");
  assert.equal(A[0].count, 1);
  assert.match(A[0].text, /^💬 New message from carol on publicaccess\.tv\/messages: "are you coming/);
  assert.ok(A[0].text.length < 160, "a short preview (~60 chars)");
  assert.equal(A[0].text_plain, "💬 New message from carol on publicaccess.tv/messages");
  assert.equal((await claim()).d.alerts.length, 0, "claimed once");
  // three more within 10 minutes -> nothing until the gap is over, then ONE "3 new messages"
  const c = s.d.conversation.id;
  await sayIn(U.carol, c, "hello?"); await sayIn(U.carol, c, "bob"); await sayIn(U.carol, c, "BOB");
  tick(dm.ALERT_GRACE_MS + 1000);
  assert.equal((await claim()).d.alerts.length, 0, "inside the 10-minute gap");
  tick(dm.ALERT_GAP_MS);
  A = (await claim()).d.alerts;
  assert.equal(A.length, 1);
  assert.match(A[0].text, /^💬 4 new messages from carol/, "counts what bob hasn't read");
  // reading it on the site cancels the pending alert
  tick(dm.ALERT_GAP_MS + 1000);
  await sayIn(U.carol, c, "ping");
  await post(`/api/messages/c/${c}/read`, U.bob, {});
  tick(dm.ALERT_GRACE_MS + 1000);
  assert.equal((await claim()).d.alerts.length, 0, "read on the site: no Camfrog alert");
});

test("alerts: off switch (the inbox 'dm' category), no-preview, no Camfrog link, blocked sender, deleted message", async () => {
  tick(dm.ALERT_GAP_MS + 1000); await claim();
  // alerts off
  await post("/api/messages/prefs", U.gina, { alerts: false });
  assert.equal(await inbox.pmAllowed(U.gina.userId, "dm"), false, "stored as the inbox's per-category PM preference");
  await say(U.dave, U.gina, "hey gina");
  tick(dm.ALERT_GRACE_MS + 1000);
  assert.equal((await claim()).d.alerts.filter((a) => a.login === "ginacf").length, 0);
  await post("/api/messages/prefs", U.gina, { alerts: true });
  // alert without preview
  await post("/api/messages/prefs", U.alice, { preview: false });
  tick(dm.ALERT_GAP_MS + 1000);
  await say(U.dave, U.alice, "secret plans");
  tick(dm.ALERT_GRACE_MS + 1000);
  const A = (await claim()).d.alerts.filter((a) => a.login === "alicecf");
  assert.equal(A.length, 1);
  assert.equal(A[0].text, "💬 New message from dave on publicaccess.tv/messages");
  assert.doesNotMatch(A[0].text + A[0].text_plain, /secret/);
  assert.equal(A[0].from_login, null, "dave has no Camfrog login");
  // no Camfrog link -> no alert row at all
  await say(U.alice, U.dave, "hi dave");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM dm_alerts WHERE user_id = ?", [U.dave.userId]))[0].n, 0);
  // the only unread message got deleted -> no alert
  tick(dm.ALERT_GAP_MS + 1000);
  const x = await say(U.frank, U.carol, "nvm");
  await post(`/api/messages/m/${x.d.message.id}/delete`, U.frank, {});
  tick(dm.ALERT_GRACE_MS + 1000);
  assert.equal((await claim()).d.alerts.filter((a) => a.login === "carolcf").length, 0);
  // blocking the sender drops what was queued
  tick(dm.ALERT_GAP_MS + 1000);
  await say(U.frank, U.carol, "one more thing");
  await post("/api/messages/block", U.carol, { username: "frank", on: true });
  tick(dm.ALERT_GRACE_MS + 1000);
  assert.equal((await claim()).d.alerts.filter((a) => a.login === "carolcf").length, 0);
  await post("/api/messages/block", U.carol, { username: "frank", on: false });
});

// ───────────────────────── live (SSE) ─────────────────────────
function stream(u, { cookie = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = cookie ? { cookie } : u ? { "x-test-user": u.userId } : {};
    const req = http.get(base + "/events?type=dm&identifier=u_alice", { headers }, (res) => {
      const ev = [];
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = block.split("\n").find((l) => l.startsWith("data: "));
          if (line) ev.push(JSON.parse(line.slice(6)));
        }
      });
      resolve({ status: res.statusCode, ev, close: () => req.destroy() });
    });
    req.on("error", reject);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("SSE: the signed-in user's own stream (the URL can't pick someone else's); new messages, deletes and reads arrive", async () => {
  const anon = await stream(null);
  assert.equal(anon.status, 401);
  anon.close();
  const bob = await stream(U.bob);
  const ivy = await stream(U.ivy);                       // asks for identifier=u_alice: gets her own stream only
  const viaCookie = await stream(null, { cookie: "jwt=" + jwt.sign({ userId: U.bob.userId, username: "bob" }, "test-secret") });
  assert.equal(bob.status, 200);
  assert.equal(viaCookie.status, 200);
  await wait(50);
  const s = await say(U.carol, U.bob, "live one");
  await wait(100);
  const got = bob.ev.find((e) => e.t === "msg");
  assert.ok(got, "bob's stream got it");
  assert.equal(got.m.text, "live one");
  assert.equal(got.conv.with.username, "carol");
  assert.ok(viaCookie.ev.some((e) => e.t === "msg"), "the cookie-authenticated stream too");
  assert.ok(!ivy.ev.some((e) => e.t === "msg"), "nobody else's stream");
  await post(`/api/messages/m/${s.d.message.id}/delete`, U.carol, {});
  await post(`/api/messages/c/${s.d.conversation.id}/read`, U.bob, {});
  await wait(100);
  assert.ok(bob.ev.some((e) => e.t === "del" && e.id === s.d.message.id));
  assert.ok(bob.ev.some((e) => e.t === "read" && e.c === s.d.conversation.id && typeof e.unread === "number"));
  bob.close(); ivy.close(); viaCookie.close();
});

// ───────────────────────── pages ─────────────────────────
test("the page: signed-out redirect, the E2E notice, escaped boot data; the nav count", async () => {
  const out = await fetch(base + "/messages", { redirect: "manual" });
  assert.equal(out.status, 302);
  await mkUser("xss</script><b>", { camfrog: "xsscf" });
  await say(U["xss</script><b>"], U.alice, "</script><script>alert(1)</script>");
  const r = await fetch(base + "/messages", { headers: { "x-test-user": U.alice.userId } });
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.match(html, /aren't end-to-end encrypted/);
  assert.match(html, /\/public\/css\/messages\.css\?v=\d+/);
  assert.match(html, /\/public\/js\/messages\.js\?v=\d+/);
  const boot = html.match(/<script type="application\/json" id="dmBoot">([\s\S]*?)<\/script>/)[1];
  assert.doesNotMatch(boot, /<\/script>|<script/i, "nothing can close the boot block");
  const B = JSON.parse(boot);
  assert.equal(B.me.username, "alice");
  assert.ok(B.conversations.length > 0);
  assert.match(html, /id="navDm"/, "the 💬 in the nav");
  const probe = await (await fetch(base + "/probe", { headers: { cookie: "jwt=" + jwt.sign({ userId: U.alice.userId }, "test-secret") } })).json();
  assert.equal(probe.dm, await dm.unreadTotal(U.alice.userId));
  assert.ok(probe.dm > 0);
});

test("one inbox: the 🔔 Notices item is pinned in /messages, /messages/notices opens it in the page, counts + mark read", async () => {
  const u = await mkUser("noticer", { camfrog: "noticercf" });
  await inbox.add(u.userId, { kind: "loan", title: "Loan repaid </script><script>alert(1)</script>", body: "<img src=x onerror=1>", link: "/wallet", ref: "nt:1" });
  await inbox.add(u.userId, { kind: "tip", title: "bob tipped you PAT 500", ref: "nt:2" });
  await inbox.add(u.userId, { kind: "tip", title: "carol tipped you PAT 50", ref: "nt:3" });
  await inbox.addForCamfrog("noticercf", { kind: "lotto", title: "You won the lotto", ref: "nt:4" });
  const page = async (p) => {
    const r = await fetch(base + p, { headers: { "x-test-user": u.userId } });
    const html = await r.text();
    const boot = html.match(/<script type="application\/json" id="dmBoot">([\s\S]*?)<\/script>/)[1];
    return { r, html, boot, B: JSON.parse(boot) };
  };
  // /messages: no tab toggle any more - the pinned item with its unread count, server-rendered
  const m = await page("/messages");
  assert.equal(m.r.status, 200);
  assert.doesNotMatch(m.html, /dm-tabs|aria-label="Inbox sections"/, "the fake Notices | Messages tabs are gone");
  assert.match(m.html, /id="dmNotices" href="\/messages\/notices"/);
  assert.match(m.html, /id="dmPinBd" aria-label="4 unread">4</, "the pinned item's unread badge (incl. the pending notice attached on open)");
  assert.match(m.html, /<a href="\/messages\/notices" id="navBell"[^>]*aria-label="Notices, 4 unread">[\s\S]{0,80}?nav-badge">4</, "the nav 🔔 opens the same page");
  assert.match(m.html, /<a href="\/messages" id="navDm"/, "the nav 💬 opens /messages");
  assert.equal(m.B.view, null);
  assert.equal(m.B.notices.unread, 4);
  assert.equal(m.B.notices.latest.title, "You won the lotto");
  // /messages/notices: the pane is selected, its first page in the boot data; hostile text can't escape the JSON block
  const n = await page("/messages/notices");
  assert.equal(n.r.status, 200);
  assert.equal(n.B.view, "notices");
  assert.match(n.html, /<title>Notices \(4\)<\/title>/);
  assert.match(n.html, /<main class="dm" id="dm" data-view="chat">/, "phones open straight on the notices screen");
  assert.match(n.html, /id="dmNt" aria-labelledby="dmNtT">/, "the pane isn't hidden");
  assert.doesNotMatch(n.boot, /<\/script>|<script|<img/i);
  assert.equal(n.B.notices.items.length, 4);
  const loan = n.B.notices.items.find((x) => x.kind === "loan");
  assert.equal(loan.title, "Loan repaid </script><script>alert(1)</script>", "plain text, for textContent");
  assert.equal(loan.body, "<img src=x onerror=1>");
  assert.equal(loan.link, true);
  assert.ok(n.B.notices.kinds.some((k) => k.key === "tip" && k.icon && k.label));
  assert.equal(n.B.notices.pm.tip.pm, true, "the PM switches for the ⚙ dialog");
  assert.deepEqual(n.B.notices.counts.find((c) => c.kind === "tip"), { kind: "tip", n: 2, unread: 2 });
  // ?kind= / ?page= / ?msg= (what an old /inbox?... link 301s to) pick the filter
  const f = await page("/messages/notices?kind=tip&msg=Saved");
  assert.equal(f.B.notices.kind, "tip");
  assert.equal(f.B.notices.items.length, 2);
  assert.equal(f.B.notices.msg, "Saved");
  assert.equal((await page("/messages?kind=tip")).B.notices.kind, null, "only the notices view filters");
  // the conversations poll carries the pinned item's count
  assert.equal((await get("/api/messages/conversations", u)).d.notices.unread, 4);
  // mark read (the pane's buttons: POST /inbox/read as a fetch) - one, then all
  const r1 = await fetch(base + "/inbox/read", { method: "POST", headers: H(u), body: JSON.stringify({ id: loan.id }) });
  assert.deepEqual(await r1.json(), { ok: true, changed: 1, unread: 3 });
  assert.equal((await get("/api/messages/conversations", u)).d.notices.unread, 3);
  assert.equal((await page("/messages/notices")).B.notices.items.find((x) => x.id === loan.id).unread, false);
  const r2 = await fetch(base + "/inbox/read", { method: "POST", headers: H(u), body: JSON.stringify({ all: 1 }) });
  assert.equal((await r2.json()).unread, 0);
  const after = await page("/messages");
  assert.equal(after.B.notices.unread, 0);
  assert.match(after.html, /id="dmPinBd" hidden/);
  assert.doesNotMatch(after.html, /id="navBell"[^>]*>[\s\S]{0,80}?nav-badge/, "no 🔔 badge once all are read");
  // the old address still lands here
  const old = await fetch(base + "/inbox?kind=tip", { headers: { "x-test-user": u.userId }, redirect: "manual" });
  assert.equal(old.status, 301);
  assert.equal(old.headers.get("location"), "/messages/notices?kind=tip");
});
