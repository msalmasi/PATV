// Talking to Pepe on the site (messages.js, 1.99ik): a 1:1 message to Pepe's account queues a job; Pepe claims it per
// conversation (bot token) with the member's PATV identity + the conversation's recent history, answers through
// /api/messages/pepe/reply (a message from Pepe, live to the member, no Camfrog alert), stale jobs expire, unanswered
// claims are re-offered at most twice, groups can't include him, blocks still apply, and his price shows in the header.
//   node --test test/messages-pepe.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dm-pepe-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const inbox = require(path.join(repo, "inbox"));
const follows = require(path.join(repo, "follows"));
const store = require(path.join(repo, "feedstore"));
const dm = require(path.join(repo, "messages"));

let T = Date.now();
dm._setClock(() => T);
const tick = (ms = 1000) => { T += ms; };

const U = {};
async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, camfrogUsername, level, created_at) VALUES (?, ?, ?, 'x', ?, ?, ?, '2026-01-01 00:00:00')`,
                 [id, name, extra.display || name, extra.class || "pleb", extra.camfrog || null, extra.level == null ? 5 : extra.level]);
  return (U[name] = { userId: id, username: name });
}
let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await inbox.ready; await follows.init(); await store.init(); await dm.init();
  await mkUser("alice", { camfrog: "alicecf", display: "Alice ✨" });
  await mkUser("bob", { camfrog: "bobcf" });
  await mkUser("newbie", { level: 0 });                     // a new account: may still talk to Pepe
  await mkUser("carol", { camfrog: "carolcf" });
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES ('pepe-bot', 'PepeFrog', 'Pepe', 'x', 'Bot', 'pepefrog')");
  const app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  dm.register(app, { isBotToken: (t) => t === "bot", addUser });
  inbox.register(app, { isBotToken: (t) => t === "bot", addUser });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

async function call(method, p, user, body) {
  const h = { "X-Requested-With": "fetch" };
  if (user) h["x-test-user"] = user.userId;
  if (body) h["Content-Type"] = "application/json";
  const r = await fetch(base + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  let d; try { d = JSON.parse(txt); } catch (e) { d = txt; }
  return { status: r.status, d };
}
const say = (from, body) => { tick(1000); return call("POST", "/api/messages/send", from, { to: "PepeFrog", body }); };
const claim = (extra = {}) => call("POST", "/api/messages/pepe/claim", null, { password: "bot", ...extra });
const answer = (conversation, upto, text) => call("POST", "/api/messages/pepe/reply", null, { password: "bot", conversation, upto, text });

test("a message to Pepe is allowed (even for a new account), queued, and raises no Camfrog alert", async () => {
  const r = await say(U.alice, "hey pepe, who won the heist?");
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const n = await say(U.newbie, "hi pepe");
  assert.equal(n.status, 200, "no new-account / who-can-message rule for the bot");
  const jobs = await getQuery("SELECT * FROM pepe_dm_jobs ORDER BY message_id");
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].state, "pending");
  assert.equal((await getQuery("SELECT * FROM dm_alerts WHERE user_id = 'pepe-bot'")).length, 0, "Pepe never gets a Camfrog alert");
});

test("claim: bot token; one entry per conversation with the PATV identity, the new messages and the history", async () => {
  assert.equal((await claim({ password: "nope" })).status, 403);
  tick(1000);
  await say(U.alice, "and how much was the vault?");
  const c = await claim({ price: 1000 });
  assert.equal(c.status, 200);
  const A = c.d.conversations.find((x) => x.user.username === "alice");
  assert.ok(A);
  assert.deepEqual(A.user, { username: "alice", display: "Alice ✨", camfrog: "alicecf", level: 5, staff: false, admin: false });
  assert.deepEqual(A.messages.map((m) => m.text), ["hey pepe, who won the heist?", "and how much was the vault?"]);
  assert.deepEqual(A.history.map((m) => [m.from, m.text]), [["them", "hey pepe, who won the heist?"], ["them", "and how much was the vault?"]]);
  assert.equal(A.upto, A.messages[1].id);
  const N = c.d.conversations.find((x) => x.user.username === "newbie");
  assert.equal(N.user.camfrog, null, "not linked");
  assert.equal((await claim()).d.conversations.length, 0, "claimed ones aren't handed out again at once");
});

test("reply: lands as a message from Pepe, live to the member, closes the jobs; the header shows his price", async () => {
  const conv = (await getQuery("SELECT conversation_id FROM pepe_dm_jobs WHERE user_id = 'u_alice' LIMIT 1"))[0].conversation_id;
  const upto = (await getQuery("SELECT MAX(message_id) AS m FROM pepe_dm_jobs WHERE user_id = 'u_alice'"))[0].m;
  const events = [];
  dm._streams.set("u_alice", new Set([{ write: (l) => events.push(l) }]));
  const r = await answer(conv, upto, "kevin won it, 40k in the vault. you weren't there, frog.");
  assert.equal(r.status, 200, JSON.stringify(r.d));
  dm._streams.delete("u_alice");
  const h = await call("GET", `/api/messages/c/${conv}?head=1`, U.alice);
  const last = h.d.messages[h.d.messages.length - 1];
  assert.equal(last.text, "kevin won it, 40k in the vault. you weren't there, frog.");
  assert.equal(last.from, "PepeFrog");
  assert.ok(events.some((e) => e.includes("kevin won it")), "live event to the member");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pepe_dm_jobs WHERE user_id = 'u_alice' AND state = 'done'"))[0].n, 2);
  assert.equal(h.d.conversation.canSend, true);
  assert.match(h.d.conversation.pepe.note, /1,000 PAT, like !ask/);
  assert.equal(h.d.conversation.pepe.online, true);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM dm_alerts WHERE user_id = 'u_alice'"))[0].n, 0, "Pepe's answers raise no Camfrog alert");
  assert.equal(await dm.unreadTotal("u_alice"), 1, "it counts as unread in the 💬");
  // the next claim's history carries Pepe's answer
  tick(1000);
  await say(U.alice, "lol ok");
  const c2 = (await claim()).d.conversations.find((x) => x.user.username === "alice");
  assert.deepEqual(c2.history.slice(-2).map((m) => m.from), ["pepe", "them"]);
  await answer(c2.conversation, c2.upto, "");                     // no answer: just closes the jobs
  assert.equal((await getQuery("SELECT state FROM pepe_dm_jobs WHERE message_id = ?", [c2.upto]))[0].state, "done");
});

test("away / stale: unanswered claims come back (twice at most); jobs older than 15 min expire; the header says he's away", async () => {
  tick(1000);
  await say(U.bob, "pepe?");
  const c1 = (await claim()).d.conversations.find((x) => x.user.username === "bob");
  assert.ok(c1);
  tick(121e3);
  const c2 = (await claim()).d.conversations.find((x) => x.user.username === "bob");
  assert.ok(c2, "re-offered after 2 minutes");
  tick(121e3);
  assert.equal((await claim()).d.conversations.find((x) => x.user.username === "bob"), undefined, "not a third time");
  tick(16 * 60e3);
  await claim();
  const st = (await getQuery("SELECT state FROM pepe_dm_jobs WHERE user_id = 'u_bob'"))[0].state;
  assert.equal(st, "expired");
  tick(5 * 60e3);
  const chk = await call("GET", "/api/messages/check?to=PepeFrog", U.carol);
  assert.equal(chk.d.canSend, true);
  assert.match(chk.d.pepe.note, /away right now/);
});

test("groups can't include Pepe; blocks still apply; another person's conversation can't be answered into", async () => {
  tick(1000);
  const g = await call("POST", "/api/messages/groups", U.alice, { members: ["bob", "PepeFrog"] });
  assert.equal(g.status, 403);
  assert.ok(g.d.refused.some((x) => x.code === "bot"));
  tick(1000);
  await dm.setBlock(U.carol, "PepeFrog", true);
  const r = await say(U.carol, "hi");
  assert.equal(r.status, 403);
  assert.equal(r.d.code, "you_blocked");
  const bobConv = (await getQuery("SELECT conversation_id FROM pepe_dm_jobs WHERE user_id = 'u_bob' LIMIT 1"))[0].conversation_id;
  const ab = await call("POST", "/api/messages/send", U.alice, { to: "bob", body: "hey bob" });
  assert.equal((await answer(ab.d.conversation.id, 1, "injected")).status, 404, "only conversations Pepe is in");
  assert.ok(bobConv);
});

test("the page: a 🐸 Message Pepe button and the note box", async () => {
  const r = await fetch(base + "/messages", { headers: { "x-test-user": U.alice.userId } });
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.match(html, /id="dmPepeBtn" href="\/messages\?to=PepeFrog"/);
  assert.match(html, /id="dmPepeNote"/);
  const js = fs.readFileSync(path.join(repo, "public", "js", "messages.js"), "utf8");
  assert.match(js, /\$\('dmPepeNote'\)\.textContent = pn && pn\.note/);
});
