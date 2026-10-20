// CL13: Camfrog threads ("📨 Sent in Camfrog to <login>", conversations.kind = 'cfpm') - messages.js relayCopy + the page.
//   * a `!msg` copy whose target login has no real PATV account (`no_account`) or whose target's DM rules refuse the sender
//     (`refused`) is kept in the SENDER's own thread; Pepe gets {ok: false, code, kept: true}; nobody is alerted
//   * dm_key = dmKey(sender, 'cf:' + login) - the same sorted join as every 1:1 key (merge: test/account-merge.test.js)
//   * the header is neutral: the same answer for "not on PATV" and "refuses you"; the DM is offered ONLY when a message would
//     pass refusal() now (no block oracle); new copies then go to the DM, the old ones stay
//   * send() refuses the kind; list / header / history / markRead / clear / delete handle it
//   * coverage: export (the sender's side), the per-login staff tool contract (cfLoginSummary / cfLoginForget)
//   * CFPM.on = false is CL11's behaviour (decision 22's switch)
// Written to run under Node 16 too (no test.before / global fetch):
//   node --test test/messages-cfpm.test.js
//   npx -y -p node@16 node --test test/messages-cfpm.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dm-cfpm-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const inbox = require(path.join(repo, "inbox"));
const follows = require(path.join(repo, "follows"));
const store = require(path.join(repo, "feedstore"));
const dm = require(path.join(repo, "messages"));
const telegram = require(path.join(repo, "telegram"));
const webpush = require(path.join(repo, "webpush"));

let T = Date.UTC(2026, 9, 19, 21, 4);
dm._setClock(() => T);
const tick = (ms = 1000) => { T += ms; };

const calls = { tg: [], push: [] };
telegram.onDm = (uid) => { calls.tg.push(uid); };
webpush.onDm = (uid) => { calls.push.push(uid); };
const events = new Map();
function listen(uid) {
  const got = [];
  events.set(uid, got);
  dm._streams.set(uid, new Set([{ write(line) { const m = /^data: (.*)\n\n$/.exec(line); if (m) got.push(JSON.parse(m[1])); } }]));
  return got;
}

async function mkUser(id, name, cf, extra = {}) {
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, camfrogUsername, level, created_at, email, auto_source)
                  VALUES (?, ?, ?, 'x', ?, ?, ?, '2026-01-01 00:00:00', ?, ?)`,
                 [id, name, extra.display || name, extra.class || "pleb", cf, extra.level == null ? 5 : extra.level,
                  extra.email === undefined ? `${name}@example.com` : extra.email, extra.auto ? "camfrog" : null]);
}

let base = null, server = null, readyP = null;
function setup() {
  if (readyP) return readyP;
  readyP = (async () => {
    await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                    points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                    level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0,
                    archived_at INTEGER, email TEXT, auto_source TEXT)`);
    await inbox.ready; await follows.init(); await store.init(); await dm.init();
    await mkUser("u_owner", "pb", "foamy1111", { display: "Plantbaked", class: "Admin" });
    await mkUser("u_alice", "alice", "alicecf", { display: "Alice" });
    await mkUser("u_bob", "bob", "bobcf");
    await mkUser("u_eve", "eve", "evecf");
    await mkUser("u_frank", "frank", "frankcf");
    await mkUser("u_later", "laterperson", null, { display: "Later Person" });       // links latercf during the tests
    await mkUser("u_auto", "CFa1b2c3d4", "autocf", { auto: true, email: "a1b2c3d4randomnoat" });   // Pepe's auto account: nobody signs in
    await mkUser("u_dan", "strangercf", null);              // a PATV USERNAME equal to a Camfrog login, nothing linked
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername, email) VALUES ('pepe-bot', 'Pepe', 'Pepe', 'x', 'Bot', 'pepefrog', 'pepe@example.com')");
    const app = express();
    app.use(express.json());
    const addUser = async (req, res, next) => {
      const u = req.get("x-test-user");
      req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
      next();
    };
    dm.register(app, { isBotToken: (p) => p === "bot-token", addUser });
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    server.unref();
    base = `http://127.0.0.1:${server.address().port}`;
  })();
  return readyP;
}
function call(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, data ? { "content-length": data.length } : {}, headers);
    const r = http.request(base + p, { method, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const s = Buffer.concat(chunks).toString("utf8");
        let d = s;
        try { d = JSON.parse(s); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, d });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
let seq = 0;
const key = () => "c" + (++seq).toString(16).padStart(39, "0");
const relay = (b) => call("POST", "/api/messages/relay-camfrog-pm", Object.assign({ password: "bot-token", key: key(), room: "PepeLab", sent_at: T - 2000 }, b));
const asUser = (uid) => ({ "x-test-user": uid });
const one = async (sql, p = []) => (await getQuery(sql, p))[0];
const count = async (sql, p = []) => (await one(sql, p)).n;
const reset = () => { calls.tg.length = 0; calls.push.length = 0; };
// the head of a Camfrog thread without what names it (id / login) - for "the same answer either way"
const shapeOf = (h) => { const x = { ...h }; delete x.id; delete x.cfLogin; x.with = { ...x.with, display: "*", camfrog: "*" }; return x; };

test("no_account: the copy is kept in the sender's own 'Sent in Camfrog to <login>' thread - Pepe hears kept, nobody is alerted", async () => {
  await setup();
  tick(5000); reset();
  const ownEv = listen("u_owner"), bobEv = listen("u_bob"), danEv = listen("u_dan");
  const k = key();
  const r = await relay({ from: "foamy1111", to: "StrangerCF", text: "you aren't on PATV", key: k, sent_at: T - 3000, present: true });
  assert.equal(r.status, 404, JSON.stringify(r.d));
  assert.equal(r.d.ok, false); assert.equal(r.d.code, "no_account"); assert.equal(r.d.kept, true); assert.equal(r.d.silent, true);
  assert.match(r.d.error, /^Kept in your Camfrog log on PATV/);
  assert.ok(r.d.conversation && r.d.message);
  const conv = await one("SELECT * FROM conversations WHERE id = ?", [r.d.conversation]);
  assert.equal(conv.kind, "cfpm");
  assert.equal(conv.dm_key, ["u_owner", "cf:strangercf"].sort().join("|"), "the sorted join, login lower-cased");
  assert.equal(conv.dm_key, dm.cfKey("u_owner", "strangercf")); assert.equal(conv.dm_key, dm.dmKey("cf:strangercf", "u_owner"));
  assert.equal(dm.cfLoginOf(conv), "strangercf");
  assert.equal(conv.created_by, "u_owner"); assert.equal(conv.last_msg_at, T);
  assert.deepEqual((await getQuery("SELECT user_id FROM conversation_members WHERE conversation_id = ?", [conv.id])).map((x) => x.user_id), ["u_owner"], "the sender is the only member");
  const m = await one("SELECT * FROM messages WHERE id = ?", [r.d.message]);
  assert.equal(m.sender_id, "u_owner"); assert.equal(m.via, "cf_pm"); assert.equal(m.created_at, T); assert.equal(m.body, "you aren't on PATV");
  const rel = await one("SELECT * FROM dm_relays WHERE relay_key = ?", [k]);
  assert.deepEqual({ ...rel }, { message_id: m.id, relay_key: k, via: "cf_pm", from_login: "foamy1111", to_login: "strangercf", cf_room: "PepeLab",
                                 cf_sent_at: T - 3000, present: null, created: T, kept: "no_account" }, "presence isn't kept for a copy that alerts nobody");
  // nobody alerted, no job for Pepe; the PATV username equal to the login (u_dan) gets nothing
  assert.equal(await count("SELECT COUNT(*) AS n FROM dm_alerts"), 0);
  assert.deepEqual(calls.tg, []); assert.deepEqual(calls.push, []);
  assert.equal(await count("SELECT COUNT(*) AS n FROM pepe_dm_jobs"), 0);
  assert.deepEqual(bobEv, []); assert.deepEqual(danEv, [], "no username fallback");
  assert.equal(await count("SELECT COUNT(*) AS n FROM conversation_members WHERE user_id = 'u_dan'"), 0);
  // the sender's own pages: the live event names the login, never a PATV account
  const ev = ownEv.find((e) => e.t === "msg" && e.c === conv.id);
  assert.ok(ev, JSON.stringify(ownEv));
  assert.deepEqual(ev.conv, { id: conv.id, kind: "cfpm", with: { username: null, display: "strangercf", camfrog: "strangercf" } });
  assert.equal(ev.m.via, "cf_pm"); assert.equal(ev.m.cfSentAt, T - 3000);
  assert.equal(await dm.unreadTotal("u_owner"), 0, "your own copies are read");
  // the admin-only abuse record, like every message
  const a = await one("SELECT * FROM content_audit WHERE kind = 'message' AND target_id = ?", [String(m.id)]);
  assert.ok(a && a.ua === "Camfrog !msg (Pepe)" && a.user_id === "u_owner");
  // an auto-only login is "no account" too: its own thread
  const au = await relay({ from: "foamy1111", to: "autocf", text: "to an auto account", present: false });
  assert.equal(au.status, 404); assert.equal(au.d.kept, true);
  assert.equal((await one("SELECT dm_key FROM conversations WHERE id = ?", [au.d.conversation])).dm_key, dm.cfKey("u_owner", "autocf"));
  assert.equal(await count("SELECT COUNT(*) AS n FROM conversation_members WHERE user_id = 'u_auto'"), 0);
});

test("the same login again -> the same thread; a duplicate key answers the same (kept, duplicate) and writes nothing", async () => {
  await setup();
  tick(5000);
  const a = await relay({ from: "foamy1111", to: "strangercf", text: "second one", present: false });
  assert.equal(a.status, 404); assert.equal(a.d.kept, true);
  const first = await one("SELECT id FROM conversations WHERE dm_key = ?", [dm.cfKey("u_owner", "strangercf")]);
  assert.equal(a.d.conversation, first.id);
  const k = key();
  const body = { from: "foamy1111", to: "strangercf", text: "only once", key: k, present: true };
  const n0 = await count("SELECT COUNT(*) AS n FROM messages");
  const [x, y] = await Promise.all([relay(body), relay(body)]);
  for (const r of [x, y]) { assert.equal(r.status, 404); assert.equal(r.d.code, "no_account"); assert.equal(r.d.kept, true); }
  assert.equal([x, y].filter((r) => r.d.duplicate).length, 1);
  assert.equal(x.d.message, y.d.message);
  tick(60000);
  const z = await relay(body);
  assert.equal(z.status, 404); assert.equal(z.d.duplicate, true); assert.equal(z.d.kept, true); assert.equal(z.d.message, x.d.message);
  assert.equal(await count("SELECT COUNT(*) AS n FROM messages"), n0 + 1);
  assert.equal(await count("SELECT COUNT(*) AS n FROM dm_relays WHERE relay_key = ?", [k]), 1);
});

test("refused (blocks either way, 'who can message me'): kept in the sender's thread with the one refusal wording; nothing reaches the target", async () => {
  await setup();
  tick(5000); reset();
  const eveEv = listen("u_eve");
  await dm.setBlock({ userId: "u_eve" }, "pb", true);           // eve blocks the owner
  const b = await relay({ from: "foamy1111", to: "evecf", text: "eve blocked me", present: false });
  assert.equal(b.status, 403, JSON.stringify(b.d));
  assert.equal(b.d.code, "refused"); assert.equal(b.d.kept, true); assert.equal(b.d.error, "Kept in your Camfrog log on PATV: they don't take messages from you there.");
  assert.doesNotMatch(b.d.error, /block/i);
  const conv = await one("SELECT * FROM conversations WHERE id = ?", [b.d.conversation]);
  assert.equal(conv.kind, "cfpm"); assert.equal(conv.dm_key, dm.cfKey("u_owner", "evecf"));
  assert.equal((await one("SELECT kept FROM dm_relays WHERE message_id = ?", [b.d.message])).kept, "refused");
  // "who can message me": nobody
  await dm.setPrefs("u_frank", { who: "nobody" });
  const w = await relay({ from: "foamy1111", to: "frankcf", text: "frank is closed", present: true });
  assert.equal(w.status, 403); assert.equal(w.d.code, "refused"); assert.equal(w.d.kept, true); assert.equal(w.d.error, b.d.error, "one wording");
  // nothing reached eve or frank: no membership, no unread, no alert, no live event
  for (const u of ["u_eve", "u_frank"]) {
    assert.equal(await count("SELECT COUNT(*) AS n FROM conversation_members WHERE user_id = ?", [u]), 0, u);
    assert.equal(await dm.unreadTotal(u), 0);
  }
  assert.deepEqual(eveEv, []);
  assert.equal(await count("SELECT COUNT(*) AS n FROM dm_alerts"), 0); assert.deepEqual(calls.tg, []); assert.deepEqual(calls.push, []);
  // the sender's OWN block / a feed ban are theirs to know and aren't kept
  tick(1000);                                                   // (setBlock has a 500 ms double-click gap)
  await dm.setBlock({ userId: "u_eve" }, "pb", false);
  tick(1000);
  await dm.setBlock({ userId: "u_owner" }, "eve", true);
  const yb = await relay({ from: "foamy1111", to: "evecf", text: "I blocked eve", present: true });
  assert.equal(yb.status, 403); assert.equal(yb.d.code, "you_blocked"); assert.equal(yb.d.kept, undefined);
  tick(1000);
  await dm.setBlock({ userId: "u_owner" }, "eve", false);
  await runQuery("INSERT INTO feed_bans (user_id, room_id, username, reason, by, at, until) VALUES ('u_alice', '', 'alice', 'test', 'pb', ?, NULL)", [T]);
  const fb = await relay({ from: "alicecf", to: "strangercf", text: "banned sender", present: true });
  assert.equal(fb.status, 403); assert.equal(fb.d.code, "banned"); assert.equal(fb.d.kept, undefined);
  await runQuery("DELETE FROM feed_bans WHERE user_id = 'u_alice'");
  assert.equal(await count("SELECT COUNT(*) AS n FROM messages WHERE body IN ('I blocked eve', 'banned sender')"), 0);
  // the text / rate answers come before the target's rules (they can't hint at them)
  const lg = await relay({ from: "foamy1111", to: "frankcf", text: "x".repeat(dm.LIMITS.max_len + 1), present: true });
  assert.equal(lg.status, 400); assert.equal(lg.d.code, "long");
});

test("the thread for the sender: neutral header (the same for 'not on PATV' and 'refuses you'), no composer, list + history; nobody else can open it", async () => {
  await setup();
  tick(5000);
  const stranger = (await one("SELECT id FROM conversations WHERE dm_key = ?", [dm.cfKey("u_owner", "strangercf")])).id;
  const eveT = (await one("SELECT id FROM conversations WHERE dm_key = ?", [dm.cfKey("u_owner", "evecf")])).id;
  await dm.setBlock({ userId: "u_eve" }, "pb", true);
  const hs = await call("GET", `/api/messages/c/${stranger}?head=1`, undefined, asUser("u_owner"));
  const he = await call("GET", `/api/messages/c/${eveT}?head=1`, undefined, asUser("u_owner"));
  assert.equal(hs.status, 200); assert.equal(he.status, 200);
  const H = hs.d.conversation;
  assert.equal(H.kind, "cfpm"); assert.equal(H.cfLogin, "strangercf"); assert.equal(H.canSend, false); assert.equal(H.refusal, null);
  assert.equal(H.refusalCode, "cfpm"); assert.equal(H.linked, null); assert.deepEqual(H.with, { username: null, display: "strangercf", camfrog: "strangercf" });
  assert.deepEqual(shapeOf(he.d.conversation), shapeOf(H), "a block looks exactly like 'not on PATV'");
  tick(1000);
  await dm.setBlock({ userId: "u_eve" }, "pb", false);
  // history: the copies with the chip's data
  assert.ok(hs.d.messages.length >= 3 && hs.d.messages.every((m) => m.via === "cf_pm" && m.from === "pb"));
  // the list: kind, the login, the 📨 snippet data, nothing unread
  const l = await call("GET", "/api/messages/conversations", undefined, asUser("u_owner"));
  const it = l.d.conversations.find((c) => c.id === stranger);
  assert.equal(it.kind, "cfpm"); assert.deepEqual(it.with, { username: null, display: "strangercf", camfrog: "strangercf" });
  assert.equal(it.last.via, "cf_pm"); assert.equal(it.last.mine, true); assert.equal(it.unread, 0); assert.equal(it.blocked, false);
  // nobody else: not bob, not the PATV username that equals the login
  for (const u of ["u_bob", "u_dan"]) {
    assert.equal((await call("GET", `/api/messages/c/${stranger}?head=1`, undefined, asUser(u))).status, 404, u);
    assert.ok(!(await call("GET", "/api/messages/conversations", undefined, asUser(u))).d.conversations.some((c) => c.id === stranger));
  }
  // send refuses the kind (API and route); nothing is written
  const n0 = await count("SELECT COUNT(*) AS n FROM messages");
  await assert.rejects(dm.send({ userId: "u_owner" }, { conversation: stranger, body: "typed here" }), (e) => e.status === 403 && e.code === "cfpm" && /!msg strangercf/.test(e.message));
  const s = await call("POST", "/api/messages/send", { conversation: stranger, body: "typed here" }, asUser("u_owner"));
  assert.equal(s.status, 403); assert.equal(s.d.code, "cfpm");
  assert.equal(await count("SELECT COUNT(*) AS n FROM messages"), n0);
  // groups' actions don't apply
  await assert.rejects(dm.addMembers({ userId: "u_owner" }, stranger, ["bob"]), (e) => e.status === 400);
});

test("the linked-later hand-off: offered only when a DM would go through; then new copies go to the DM and the old ones stay", async () => {
  await setup();
  tick(5000); reset();
  const r1 = await relay({ from: "foamy1111", to: "latercf", text: "before you linked", present: true });
  assert.equal(r1.status, 404); assert.equal(r1.d.kept, true);
  const thread = r1.d.conversation;
  const head = async () => (await call("GET", `/api/messages/c/${thread}?head=1`, undefined, asUser("u_owner"))).d.conversation;
  const before = await head();
  assert.equal(before.linked, null);
  // the login gets linked, but its owner takes messages from nobody: still nothing offered (and the copy stays in the thread)
  await runQuery("UPDATE users SET camfrogUsername = 'latercf' WHERE userId = 'u_later'");
  await dm.setPrefs("u_later", { who: "nobody" });
  const mid = await head();
  assert.deepEqual(shapeOf(mid), shapeOf(before), "no oracle: linked-but-refusing reads exactly like not linked");
  tick(1000);
  const r2 = await relay({ from: "foamy1111", to: "latercf", text: "you're closed", present: true });
  assert.equal(r2.status, 403); assert.equal(r2.d.code, "refused"); assert.equal(r2.d.conversation, thread, "the same thread");
  // a block either way: nothing offered either
  await dm.setPrefs("u_later", { who: "everyone" });
  await dm.setBlock({ userId: "u_later" }, "pb", true);
  assert.equal((await head()).linked, null);
  tick(1000);
  await dm.setBlock({ userId: "u_later" }, "pb", false);
  // takes messages now: the DM is offered (no conversation yet)
  const open = await head();
  assert.deepEqual(open.linked, { username: "laterperson", display: "Later Person", conversation: null });
  // the next copy goes to the account-pair DM (and alerts like any copy that wasn't delivered in the room)
  tick(1000); reset();
  const r3 = await relay({ from: "foamy1111", to: "latercf", text: "now you're on PATV", present: false });
  assert.equal(r3.status, 200, JSON.stringify(r3.d)); assert.equal(r3.d.ok, true); assert.equal(r3.d.kept, undefined);
  const pair = await one("SELECT * FROM conversations WHERE id = ?", [r3.d.conversation]);
  assert.equal(pair.kind, "dm"); assert.equal(pair.dm_key, dm.dmKey("u_owner", "u_later"));
  assert.deepEqual(calls.tg, ["u_later"]);
  // the old copies stay in the thread (never handed to them); the offer now points at the DM
  assert.deepEqual((await getQuery("SELECT body FROM messages WHERE conversation_id = ? ORDER BY id", [thread])).map((m) => m.body), ["before you linked", "you're closed"]);
  assert.equal(await count("SELECT COUNT(*) AS n FROM conversation_members WHERE conversation_id = ? AND user_id = 'u_later'", [thread]), 0);
  assert.equal((await head()).linked.conversation, pair.id);
  const page = await call("GET", "/api/messages/conversations", undefined, asUser("u_later"));
  assert.ok(!page.d.conversations.some((c) => c.id === thread), "the thread is never theirs");
});

test("a thread made under the sorted key elsewhere (a merge re-keys it) is the one the next copy finds", async () => {
  await setup();
  tick(5000);
  // what accountMerge.mergeConversations leaves behind: [toId, other].sort().join("|") with other = "cf:<login>"
  const k = ["u_alice", "cf:mergedcf"].sort().join("|");
  await runQuery("INSERT INTO conversations (id, kind, dm_key, created_by, created_at, last_msg_id) VALUES ('aaaaaaaaaaaaaaaa', 'cfpm', ?, 'u_alice', 1, 0)", [k]);
  await runQuery("INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES ('aaaaaaaaaaaaaaaa', 'u_alice', 1)");
  const r = await relay({ from: "alicecf", to: "MergedCF", text: "after the merge", present: true });
  assert.equal(r.status, 404); assert.equal(r.d.kept, true);
  assert.equal(r.d.conversation, "aaaaaaaaaaaaaaaa");
  assert.equal(await count("SELECT COUNT(*) AS n FROM conversations WHERE kind = 'cfpm' AND instr(dm_key, 'cf:mergedcf') > 0"), 1);
});

test("read, clear, hide (a new copy brings it back) and delete work on a thread; deleting a copy deletes its relay row", async () => {
  await setup();
  tick(5000);
  const r = await relay({ from: "foamy1111", to: "clearcf", text: "one", present: true });
  const id = r.d.conversation;
  assert.equal(await dm.markRead({ userId: "u_owner" }, id), await dm.unreadTotal("u_owner"));
  await dm.clear({ userId: "u_owner" }, id, { hide: true });
  assert.ok(!(await dm.list("u_owner")).some((c) => c.id === id), "hidden from the list");
  tick(1000);
  const k2 = key();
  const r2 = await relay({ from: "foamy1111", to: "clearcf", text: "two", key: k2, present: true });
  assert.equal(r2.d.conversation, id);
  const back = (await dm.list("u_owner")).find((c) => c.id === id);
  assert.ok(back, "a new copy brings it back");
  const h = await dm.history({ userId: "u_owner" }, id);
  assert.deepEqual(h.messages.map((m) => m.text), ["two"], "cleared history stays cleared");
  await dm.deleteMessage({ userId: "u_owner" }, r2.d.message);
  assert.equal(await count("SELECT COUNT(*) AS n FROM dm_relays WHERE message_id = ?", [r2.d.message]), 0);
  // a late retry from Pepe of the deleted (kept) copy: answered "kept, duplicate, deleted" and nothing comes back
  const n0 = await count("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?", [id]);
  tick(60000);
  const again = await relay({ from: "foamy1111", to: "clearcf", text: "two", key: k2, present: true });
  assert.equal(again.status, 404); assert.equal(again.d.code, "no_account"); assert.equal(again.d.kept, true);
  assert.equal(again.d.duplicate, true); assert.equal(again.d.deleted, true); assert.equal(again.d.conversation, null); assert.equal(again.d.message, null);
  assert.equal(await count("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?", [id]), n0);
  assert.equal(await count("SELECT COUNT(*) AS n FROM dm_relays WHERE relay_key = ?", [k2]), 0);
});

test("CFPM.on = false is CL11: no_account / refused answered without keeping anything", async () => {
  await setup();
  tick(5000);
  dm.CFPM.on = false;
  try {
    const n0 = await count("SELECT COUNT(*) AS n FROM messages"), c0 = await count("SELECT COUNT(*) AS n FROM conversations WHERE kind = 'cfpm'");
    const a = await relay({ from: "foamy1111", to: "offcf", text: "no thread please", present: true });
    assert.equal(a.status, 404); assert.equal(a.d.code, "no_account"); assert.equal(a.d.kept, undefined);
    assert.equal(a.d.error, "That Camfrog login has no PATV account.");
    await dm.setPrefs("u_frank", { who: "nobody" });
    const b = await relay({ from: "foamy1111", to: "frankcf", text: "nor here", present: true });
    assert.equal(b.status, 403); assert.equal(b.d.code, "refused"); assert.equal(b.d.kept, undefined);
    assert.equal(b.d.error, "They don't take messages from you on PATV.", "CL11's wording - nothing says 'kept'");
    assert.equal(await count("SELECT COUNT(*) AS n FROM messages"), n0);
    assert.equal(await count("SELECT COUNT(*) AS n FROM conversations WHERE kind = 'cfpm'"), c0);
  } finally { dm.CFPM.on = true; }
});

test("fix-up: the text is checked BEFORE the target - with CFPM off (CL11 checked the target first and answered refused / no_account) a long or empty text answers the same for every target", async () => {
  await setup();
  tick(5000);
  dm.CFPM.on = false;
  try {
    await dm.setPrefs("u_frank", { who: "nobody" });             // frank refuses the owner
    const long = "x".repeat(dm.LIMITS.max_len + 1);
    const n0 = await count("SELECT COUNT(*) AS n FROM messages");
    for (const to of ["frankcf", "nobodyhere", "autocf", "bobcf"]) {    // refuses / no account / auto only / takes messages
      const l = await relay({ from: "foamy1111", to, text: long, present: true });
      assert.equal(l.status, 400, to); assert.equal(l.d.code, "long", `${to}: ${JSON.stringify(l.d)}`);
      const e = await relay({ from: "foamy1111", to, text: "   ", present: true });
      assert.equal(e.status, 400, to); assert.equal(e.d.code, "empty", `${to}: ${JSON.stringify(e.d)}`);
    }
    assert.equal(await count("SELECT COUNT(*) AS n FROM messages"), n0);
    // (with a valid text the target's answer still differs - that is the answer Pepe words: refused / no_account / ok)
    const ok = await relay({ from: "foamy1111", to: "frankcf", text: "short", present: true });
    assert.equal(ok.d.code, "refused");
  } finally { dm.CFPM.on = true; }
});

test("fix-up: an auto-only login's thread offers nothing (an auto account isn't a person who takes messages); every shape() in relayCopy is per viewer", async () => {
  await setup();
  tick(5000);
  const t = (await one("SELECT id FROM conversations WHERE dm_key = ?", [dm.cfKey("u_owner", "autocf")])).id;
  const h = (await call("GET", `/api/messages/c/${t}?head=1`, undefined, asUser("u_owner"))).d.conversation;
  assert.equal(h.kind, "cfpm"); assert.equal(h.cfLogin, "autocf"); assert.equal(h.linked, null); assert.equal(h.canSend, false);
  const strangerT = (await one("SELECT id FROM conversations WHERE dm_key = ?", [dm.cfKey("u_owner", "strangercf")])).id;
  const hs = (await call("GET", `/api/messages/c/${strangerT}?head=1`, undefined, asUser("u_owner"))).d.conversation;
  assert.deepEqual(shapeOf(h), shapeOf(hs), "an auto-only login reads exactly like no account");
  // merge shim (1.99ade's cardBlocks on staging): each live event of a copy is shaped for ITS viewer
  const src = fs.readFileSync(path.join(repo, "messages.js"), "utf8");
  const body = src.slice(src.indexOf("async function relayCopy("), src.indexOf("async function relayViewerCtx("))
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const uses = body.split(/\bshape\(/).slice(1);
  assert.equal(uses.length, 3, "the kept copy's event + one per party of a pair copy");
  for (const c of uses) assert.match(c,/^row, await relayViewerCtx\((sender|target)\.userId\)\)/, c.slice(0, 80));
});

test("export: the sender's side (the thread names its login, never its key); the target's export has none of it", async () => {
  await setup();
  const X = require(path.join(repo, "accountexport"));
  const out = await X.collect("u_owner");
  const threads = out.messages.conversations.filter((c) => c.conversation.kind === "cfpm");
  assert.ok(threads.length >= 4, JSON.stringify(out.errors || null));
  const st = threads.find((c) => c.conversation.camfrog_login === "strangercf");
  assert.ok(st && st.messages_you_sent.length >= 3 && st.messages_you_sent.every((m) => m.via === "cf_pm"));
  assert.ok(threads.every((c) => !("dm_key" in c.conversation)), "no internal key");
  // fix-up: `kept` is a yes / no - never WHY (no account vs refuses you is a fact about the recipient, as `present` is)
  const copies = out.messages.camfrog_copies;
  assert.ok(copies.some((c) => c.kept === true && c.to_login === "strangercf"));
  assert.ok(copies.some((c) => c.kept === true && c.to_login === "evecf"));
  assert.ok(copies.some((c) => c.kept === false && c.to_login === "latercf"), "a copy that went to the pair DM");
  assert.ok(copies.every((c) => typeof c.kept === "boolean" && !("present" in c)));
  assert.doesNotMatch(JSON.stringify(out), /no_account|"refused"/, "the reason a copy was kept is nowhere in the export");
  const eveOut = await X.collect("u_eve");
  assert.deepEqual(eveOut.messages.conversations, []); assert.deepEqual(eveOut.messages.camfrog_copies, []);
});

test("the per-login staff tool contract: counts only; forget re-keys exactly that login (not a longer one) and folds into an existing thread", async () => {
  await setup();
  tick(5000);
  await relay({ from: "foamy1111", to: "a_b", text: "to a_b", present: true });
  await relay({ from: "foamy1111", to: "a_bc", text: "to a_bc", present: true });
  await relay({ from: "alicecf", to: "a_b", text: "alice to a_b", present: true });
  const s = await dm.cfLoginSummary("A_B");
  assert.deepEqual(s, { copies_to: 2, copies_from: 0, threads: 2 });
  assert.equal(await dm.cfLoginSummary("not a login!"), null);
  // the owner already has a thread under the pseudonym: the a_b thread folds into it
  await relay({ from: "foamy1111", to: "removed-0001", text: "already there", present: true });
  const f = await dm.cfLoginForget("a_b", "removed-0001");
  assert.deepEqual(f, { relays: 2, threads: 2 });
  assert.deepEqual(await dm.cfLoginSummary("a_b"), { copies_to: 0, copies_from: 0, threads: 0 });
  assert.equal((await dm.cfLoginSummary("a_bc")).threads, 1, "a longer login is untouched");
  const own = await one("SELECT * FROM conversations WHERE dm_key = ?", [dm.cfKey("u_owner", "removed-0001")]);
  assert.deepEqual((await getQuery("SELECT body FROM messages WHERE conversation_id = ? ORDER BY id", [own.id])).map((m) => m.body), ["to a_b", "already there"]);
  assert.equal(own.last_msg_id, (await one("SELECT MAX(id) AS n FROM messages WHERE conversation_id = ?", [own.id])).n);
  assert.ok(await one("SELECT id FROM conversations WHERE dm_key = ?", [dm.cfKey("u_alice", "removed-0001")]), "alice's thread renamed");
  assert.equal(await count("SELECT COUNT(*) AS n FROM conversations WHERE instr(dm_key, 'cf:a_b|') > 0 OR dm_key LIKE '%|cf:a_b'"), 0);
  // the next copy to the old login starts a fresh thread (the pseudonym's thread keeps what was there)
  const n = await relay({ from: "foamy1111", to: "a_b", text: "a new one", present: true });
  assert.notEqual(n.d.conversation, own.id);
});

test("tools/cflogin.js (a privacy@ request without an account): staff only, audited without the login, counts only; --forget needs a reason, is a dry run until --apply, and stops at a legal hold", async () => {
  await setup();
  tick(5000);
  await require(path.join(repo, "adminaudit")).init();
  await relay({ from: "foamy1111", to: "toolcf", text: "secret words for toolcf", present: true });
  await relay({ from: "alicecf", to: "toolcf", text: "more secret words", present: false });
  const run = (...a) => require("child_process").spawnSync(process.execPath, [path.join(repo, "tools", "cflogin.js"), `--dir=${tmp}`, ...a],
                                                            { encoding: "utf8", env: process.env, timeout: 60000 });
  const schema = async () => JSON.stringify(await getQuery("SELECT type, name, sql FROM sqlite_master ORDER BY type, name"));
  const audits = async () => getQuery("SELECT * FROM admin_audit WHERE action LIKE 'cflogin.%' ORDER BY id");
  // who may run it
  assert.equal(run("--login=toolcf").status, 2, "no --admin");
  const nb = run("--login=toolcf", "--admin=bob");
  assert.equal(nb.status, 2); assert.match(nb.stderr, /not PATV staff/);
  assert.equal(run("--login=toolcf", "--admin=pb", "--forget").status, 2, "--forget without a reason");
  assert.equal(run("--login=toolcf", "--admin=pb", "--forget", "--reason=x").status, 2, "a reason of 3+ characters");
  assert.equal((await audits()).length, 0, "refused runs did nothing");
  // the look: counts only, read-only (no table created or altered), audited
  const s0 = await schema();
  const look = run("--login=ToolCF", "--admin=pb");
  assert.equal(look.status, 0, look.stderr);
  assert.match(look.stdout, /toolcf: copies to it: 2, copies from it: 0, admins' Camfrog logs named after it: 2/);
  assert.doesNotMatch(look.stdout + look.stderr, /secret words|foamy1111|alicecf|u_owner|u_alice/, "counts only: no text, no sender");
  assert.equal(await schema(), s0, "the look changes no table");
  const dry = run("--login=toolcf", "--admin=pb", "--reason=privacy@ request 2026-10-20", "--forget");
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /DRY RUN toolcf -> deleted-[0-9a-f]{10}: 2 copy record\(s\), 2 log\(s\) re-keyed/);
  assert.deepEqual(await dm.cfLoginSummary("toolcf"), { copies_to: 2, copies_from: 0, threads: 2 }, "the dry run changed nothing");
  // a legal hold (the chat archive's chatlog_holds, CL6) stops --forget --apply
  await runQuery("CREATE TABLE IF NOT EXISTS chatlog_holds (key TEXT PRIMARY KEY, by_user TEXT NOT NULL, why TEXT NOT NULL, at INTEGER NOT NULL)");
  await runQuery("INSERT INTO chatlog_holds (key, by_user, why, at) VALUES ('who:toolcf', 'u_owner', 'order', 1)");
  const held = run("--login=toolcf", "--admin=pb", "--reason=privacy@ request 2026-10-20", "--forget", "--apply");
  assert.equal(held.status, 1); assert.match(held.stderr, /legal hold/);
  assert.deepEqual(await dm.cfLoginSummary("toolcf"), { copies_to: 2, copies_from: 0, threads: 2 }, "held: nothing changed");
  await runQuery("DELETE FROM chatlog_holds WHERE key = 'who:toolcf'");
  const ap = run("--login=toolcf", "--admin=pb", "--reason=privacy@ request 2026-10-20", "--forget", "--apply");
  assert.equal(ap.status, 0, ap.stderr);
  const p = /APPLIED toolcf -> (deleted-[0-9a-f]{10}): 2 copy record\(s\), 2 log\(s\) re-keyed/.exec(ap.stdout);
  assert.ok(p, ap.stdout);
  assert.deepEqual(await dm.cfLoginSummary("toolcf"), { copies_to: 0, copies_from: 0, threads: 0 });
  assert.deepEqual(await dm.cfLoginSummary(p[1]), { copies_to: 2, copies_from: 0, threads: 2 });
  assert.ok(await one("SELECT id FROM conversations WHERE dm_key = ?", [dm.cfKey("u_owner", p[1])]), "the owner's log, re-keyed");
  // the audit: who, what, why and the counts - never the login it was about (a forget must not leave the name behind)
  const a = await audits();
  assert.deepEqual(a.map((r) => r.action), ["cflogin.look", "cflogin.forget_dry", "cflogin.forget_refused", "cflogin.forget"]);
  assert.ok(a.every((r) => r.admin_id === "u_owner" && r.target_id === null && r.target_name === null));
  assert.ok(a.slice(1).every((r) => r.reason === "privacy@ request 2026-10-20"));
  assert.doesNotMatch(JSON.stringify(a), /toolcf/i);
  assert.deepEqual(JSON.parse(a[3].detail), { pseudonym: p[1], relays: 2, threads: 2 });
  assert.equal(run("--login=not a login", "--admin=pb").status, 2);
});

test("DDL (SQLite 3.31), Node 16 guards, and the page's strings (en.json keys, defaults equal)", async () => {
  const src = fs.readFileSync(path.join(repo, "messages.js"), "utf8");
  const ddl = [...src.matchAll(/CREATE TABLE IF NOT EXISTS dm_relays \(([\s\S]*?)\)`/g), ...src.matchAll(/ALTER TABLE dm_relays ADD COLUMN kept TEXT/g)].map((m) => m[0]);
  assert.equal(ddl.length, 2);
  assert.match(ddl[0], /\bkept TEXT\)/);
  for (const d of ddl) for (const bad of [/\biif\(/i, /->>/, /\bunixepoch\(/i, /\bSTRICT\b/, /\bRETURNING\b/i]) assert.doesNotMatch(d, bad, "SQLite 3.31: " + bad);
  assert.doesNotMatch(src.replace(/\/\/[^\n]*/g, ""), /\bBEGIN\b/, "transactions only through dbUtils.tx");
  for (const f of ["messages.js", "accountexport.js", "accountdelete.js", "accountMerge.js", path.join("tools", "cflogin.js"), path.join("public", "js", "messages.js")]) {
    const s = fs.readFileSync(path.join(repo, f), "utf8").replace(/\/\/[^\n]*/g, "");
    for (const bad of [/\.findLast(Index)?\(/, /\.toSorted\(/, /\bstructuredClone\(/, /zlib\.crc32\(/]) assert.doesNotMatch(s, bad, `${f}: Node 16 has no ${bad}`);
    if (!f.startsWith("public")) assert.doesNotMatch(s, /(^|[^.\w])fetch\(/m, `${f}: no global fetch on the server (Node 16)`);
  }
  const js = fs.readFileSync(path.join(repo, "public", "js", "messages.js"), "utf8");
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  const want = {
    "js.msg.cfpm_head": "📨 Sent in Camfrog to {login}",
    "js.msg.cfpm_composer": "Reply in Camfrog: PM Pepe !msg {login} …",
    "js.msg.cfpm_linked": "Open your DM with {name}",
    "js.msg.cfpm_start": "Copies of the Camfrog PMs you sent {login} with !msg through Pepe. Only you can see this thread.",
    "js.msg.confirm_clear_cf": "Clear this log? You won't see these copies here again.",
  };
  for (const [k, v] of Object.entries(want)) {
    assert.equal(en[k], v, k);
    const m = js.match(new RegExp(`_t\\('${k.replace(/\./g, "\\.")}', '((?:[^'\\\\]|\\\\.)*)'`));
    assert.ok(m, `${k} is used in public/js/messages.js`);
    assert.equal(m[1].replace(/\\'/g, "'"), v, `${k}: the default equals en.json`);
  }
  assert.match(js, /function isCf\(\)/); assert.match(js, /data-cfopen/);
  assert.match(fs.readFileSync(path.join(repo, "public", "css", "messages.css"), "utf8"), /\.dm-cfopen \{[^}]*min-height: 44px/);
  if (server) server.close();
});
