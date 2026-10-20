// CL11: copies of Camfrog `!msg` PMs in PATV DMs (messages.js relayCopy, POST /api/messages/relay-camfrog-pm) and the
// "where it came from" marker (messages.via: 'cf_pm' copies, 'cf_message' for `!message`).
//   * the copy lands in the account-pair DM with via = 'cf_pm', created_at = now, the Camfrog time kept in dm_relays
//   * present (the target is on the room's fresh user list) = silent: no Camfrog alert, Telegram or web push; pre-read only
//     when nothing else in the thread was unread. Not present = the usual three alerts
//   * dm_relays is inserted FIRST: two calls with one key make one copy; a retry answers duplicate
//   * realLinked: no PATV-username fallback, auto accounts by isAutoAccount (a claimed CF… account counts)
//   * one `refused` for blocks either way, "who can message me" and the new-account rule; no 350 ms burst gap
//     (CL13 keeps `no_account` / `refused` copies in the sender's own Camfrog thread: test/messages-cfpm.test.js)
//   * export / delete / merge coverage, padrekey never moves dm_relays, the DDL parses in SQLite 3.31, Node 16-safe
//   * fix-up (review): a duplicate never half-sees a copy still being written (the key is read inside a transaction and the
//     in-flight row's message_id is a negative placeholder), a rolled-back first call is not a duplicate, the cap holds
//     against parallel calls, `rate` says when to retry, a reused key is a 409 `conflict`, a deleted copy stays deleted
//     on a late retry (only a hash of its key, 48 h), admin removal and the per-day cap are covered
// Written to run under Node 16 too (no test.before / global fetch):
//   node --test test/messages-relay.test.js
//   npx -y -p node@16 node --test test/messages-relay.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dm-relay-test-"));
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

// the alert paths, recorded instead of sent
const calls = { tg: [], push: [] };
telegram.onDm = (uid) => { calls.tg.push(uid); };
webpush.onDm = (uid) => { calls.push.push(uid); };
// the live stream, recorded per user (emit() writes "data: {json}\n\n")
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

let base = null, server = null;
let readyP = null;
function setup() {
  if (readyP) return readyP;
  readyP = (async () => {
    await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                    points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                    level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0,
                    archived_at INTEGER, email TEXT, auto_source TEXT)`);
    await inbox.ready; await follows.init(); await store.init(); await dm.init();
    await mkUser("u_owner", "pb", "foamy1111", { display: "Plantbaked", class: "Admin" });   // the owner: an admin (no DM rate limits)
    await mkUser("u_alice", "alice", "alicecf", { display: "Alice" });                      // a plain linked account
    await mkUser("u_bob", "bob", "bobcf");
    await mkUser("u_carol", "carol", "carolcf");
    await mkUser("u_dan", "dancf", null);                     // a PATV USERNAME equal to a Camfrog login, nothing linked
    await mkUser("u_auto", "CFa1b2c3d4", "autocf", { auto: true, email: "a1b2c3d4randomnoat" });   // Pepe's auto account: nobody signs in
    await mkUser("u_claim", "CFz9y8x7w6", "claimedcf", { auto: true, email: "claimed@example.com" });   // made by Pepe, then claimed (email)
    await mkUser("u_eve", "eve", "evecf");
    await mkUser("u_frank", "frank", "frankcf");
    await mkUser("u_gina", "gina", "ginacf");
    await mkUser("u_hank", "hank", "hankcf");
    await mkUser("u_ivy", "ivy", "ivycf");
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

// Node 16 has no global fetch
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
        resolve({ status: res.statusCode, d, h: res.headers });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}
let seq = 0;
const key = () => "k" + (++seq).toString(16).padStart(39, "0");
const relay = (b) => call("POST", "/api/messages/relay-camfrog-pm", Object.assign({ password: "bot-token", key: key(), room: "PepeLab", sent_at: T - 2000 }, b));
const asUser = (uid) => ({ "x-test-user": uid });
const one = async (sql, p = []) => (await getQuery(sql, p))[0];
const count = async (sql, p = []) => (await one(sql, p)).n;

test("a non-bot caller is refused (403) and nothing is written", async () => {
  await setup();
  const r = await call("POST", "/api/messages/relay-camfrog-pm", { password: "nope", from: "foamy1111", to: "bobcf", text: "hi", key: key(), present: true });
  assert.equal(r.status, 403);
  assert.equal(await count("SELECT COUNT(*) AS n FROM dm_relays"), 0);
  assert.equal(await count("SELECT COUNT(*) AS n FROM messages"), 0);
});

test("a copy lands in the pair DM: via cf_pm, created_at = now, the Camfrog time kept; present = silent (no alerts) and pre-read", async () => {
  await setup();
  tick(5000);
  const bobEv = listen("u_bob"), ownEv = listen("u_owner");
  calls.tg.length = 0; calls.push.length = 0;
  const k = key();
  const r = await relay({ from: "Foamy1111", to: "bobcf", text: "hey bob, call me", key: k, sent_at: T - 3000, present: true });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.ok, true); assert.equal(r.d.silent, true); assert.ok(!r.d.duplicate);
  const m = await one("SELECT * FROM messages WHERE id = ?", [r.d.message]);
  assert.equal(m.conversation_id, r.d.conversation);
  assert.equal(m.sender_id, "u_owner"); assert.equal(m.body, "hey bob, call me");
  assert.equal(m.via, "cf_pm"); assert.equal(m.created_at, T, "created_at = now (never the Camfrog time)");
  const conv = await one("SELECT * FROM conversations WHERE id = ?", [r.d.conversation]);
  assert.equal(conv.kind, "dm"); assert.equal(conv.dm_key, ["u_owner", "u_bob"].sort().join("|")); assert.equal(conv.created_by, "u_owner");
  assert.equal(conv.last_msg_at, T);
  const rel = await one("SELECT * FROM dm_relays WHERE relay_key = ?", [k]);
  assert.deepEqual({ ...rel }, { message_id: m.id, relay_key: k, via: "cf_pm", from_login: "foamy1111", to_login: "bobcf", cf_room: "PepeLab",
                                 cf_sent_at: T - 3000, present: 1, created: T, kept: null });      // CL13: kept NULL = in the pair DM
  // silent: Camfrog already delivered it
  assert.equal(await count("SELECT COUNT(*) AS n FROM dm_alerts WHERE user_id = 'u_bob' AND pending > 0"), 0, "no Camfrog alert queued");
  assert.deepEqual(calls.tg, [], "no Telegram alert"); assert.deepEqual(calls.push, [], "no browser notification");
  assert.equal(await count("SELECT COUNT(*) AS n FROM pepe_dm_jobs"), 0, "never a job for Pepe");
  // pre-read (nothing else was unread) - and the sender's own copy is read too
  assert.equal((await one("SELECT last_read_id FROM conversation_members WHERE conversation_id = ? AND user_id = 'u_bob'", [conv.id])).last_read_id, m.id);
  assert.equal((await one("SELECT last_read_id FROM conversation_members WHERE conversation_id = ? AND user_id = 'u_owner'", [conv.id])).last_read_id, m.id);
  assert.equal(await dm.unreadTotal("u_bob"), 0);
  // live: both parties get it with the chip's data; bob also gets the read mark
  const bm = bobEv.find((e) => e.t === "msg");
  assert.ok(bm && bm.m.via === "cf_pm" && bm.m.cfSentAt === T - 3000 && bm.conv.with.username === "pb", JSON.stringify(bobEv));
  assert.ok(bobEv.some((e) => e.t === "read" && e.upTo === m.id && e.unread === 0));
  assert.ok(ownEv.some((e) => e.t === "msg" && e.m.via === "cf_pm" && e.conv.with.username === "bob"));
  // the page: the chip for BOTH parties (history), and the 📨 before the list snippet
  for (const uid of ["u_bob", "u_owner"]) {
    const h = await call("GET", `/api/messages/c/${conv.id}`, undefined, asUser(uid));
    assert.equal(h.status, 200);
    const x = h.d.messages.find((y) => y.id === m.id);
    assert.equal(x.via, "cf_pm"); assert.equal(x.cfSentAt, T - 3000);
    const l = await call("GET", "/api/messages/conversations", undefined, asUser(uid));
    assert.equal(l.d.conversations.find((c) => c.id === conv.id).last.via, "cf_pm");
  }
  // the admin-only abuse record
  const a = await one("SELECT * FROM content_audit WHERE kind = 'message' AND target_id = ?", [String(m.id)]);
  assert.ok(a, "content_audit row"); assert.equal(a.ua, "Camfrog !msg (Pepe)"); assert.equal(a.bot, 1); assert.equal(a.user_id, "u_owner");
});

test("not present: the copy is the real delivery - Camfrog alert, Telegram and web push, left unread", async () => {
  await setup();
  tick(5000);
  calls.tg.length = 0; calls.push.length = 0;
  const r = await relay({ from: "foamy1111", to: "carolcf", text: "you weren't in the room", present: false });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.silent, false);
  const a = await one("SELECT * FROM dm_alerts WHERE user_id = 'u_carol' AND conversation_id = ?", [r.d.conversation]);
  assert.ok(a && a.pending === 1 && a.last_msg_id === r.d.message, "the usual Camfrog alert is queued");
  assert.deepEqual(calls.tg, ["u_carol"]); assert.deepEqual(calls.push, ["u_carol"]);
  assert.equal(await dm.unreadTotal("u_carol"), 1);
  assert.equal((await one("SELECT present FROM dm_relays WHERE message_id = ?", [r.d.message])).present, 0);
});

test("pre-read only when nothing else in the thread was unread (a silent copy never hides an unread line)", async () => {
  await setup();
  tick(5000);
  calls.tg.length = 0;
  const r1 = await relay({ from: "foamy1111", to: "bobcf", text: "first, while bob was away", present: false });
  assert.equal(r1.status, 200);
  tick(1000);
  const r2 = await relay({ from: "foamy1111", to: "bobcf", text: "second, bob is back in the room", present: true });
  assert.equal(r2.status, 200); assert.equal(r2.d.silent, true);
  const mem = await one("SELECT last_read_id FROM conversation_members WHERE conversation_id = ? AND user_id = 'u_bob'", [r2.d.conversation]);
  assert.ok(mem.last_read_id < r1.d.message, "nothing was marked read");
  assert.equal(await dm.unreadTotal("u_bob"), 2);
  assert.equal((await one("SELECT pending FROM dm_alerts WHERE user_id = 'u_bob' AND conversation_id = ?", [r2.d.conversation])).pending, 1, "only the first queued an alert");
  assert.deepEqual(calls.tg, ["u_bob"]);
  // bob reads it on the site: both are read
  await dm.markRead({ userId: "u_bob" }, r2.d.conversation);
  assert.equal(await dm.unreadTotal("u_bob"), 0);
});

test("one key = one copy: two parallel calls make one row; a later retry answers duplicate with the same conversation", async () => {
  await setup();
  tick(5000);
  const k = key();
  const before = await count("SELECT COUNT(*) AS n FROM messages WHERE via = 'cf_pm'");
  const body = { from: "foamy1111", to: "ivycf", text: "only once", key: k, present: true };
  const [a, b] = await Promise.all([relay(body), relay(body)]);
  assert.equal(a.status, 200, JSON.stringify(a.d)); assert.equal(b.status, 200, JSON.stringify(b.d));
  assert.equal([a, b].filter((x) => x.d.duplicate).length, 1, "exactly one of them is the duplicate");
  assert.equal(a.d.conversation, b.d.conversation); assert.equal(a.d.message, b.d.message);
  assert.equal(await count("SELECT COUNT(*) AS n FROM messages WHERE via = 'cf_pm'"), before + 1);
  assert.equal(await count("SELECT COUNT(*) AS n FROM dm_relays WHERE relay_key = ?", [k]), 1);
  // (fix-up: `message_id IS NULL` could never be true of an INTEGER PRIMARY KEY - check what matters: every relay row points
  // at its own copy, never a placeholder or somebody else's message)
  assert.equal(await count(`SELECT COUNT(*) AS n FROM dm_relays r LEFT JOIN messages m ON m.id = r.message_id
                            WHERE m.id IS NULL OR m.via IS NOT 'cf_pm' OR r.message_id <= 0`), 0, "every relay row is its own copy's");
  tick(60000);
  const c = await relay(body);
  assert.equal(c.status, 200); assert.equal(c.d.duplicate, true); assert.equal(c.d.message, a.d.message); assert.equal(c.d.silent, true);
  assert.equal(await count("SELECT COUNT(*) AS n FROM messages WHERE via = 'cf_pm'"), before + 1);
});

test("back-to-back copies: no 350 ms double-send refusal (Pepe paces them); a typed send keeps its gap", async () => {
  await setup();
  tick(5000);
  for (const from of ["foamy1111", "alicecf"]) {
    const x = await relay({ from, to: "hankcf", text: "one", present: true });
    const y = await relay({ from, to: "hankcf", text: "two", present: true });
    assert.equal(x.status, 200, JSON.stringify(x.d)); assert.equal(y.status, 200, JSON.stringify(y.d));
  }
  dm._gaps.clear();
  await dm.send({ userId: "u_alice" }, { to: "hank", body: "typed" });
  await assert.rejects(dm.send({ userId: "u_alice" }, { to: "hank", body: "typed again" }), (e) => e.code === "rate");
});

test("proven links only: no PATV-username fallback, auto-only -> no_account, a claimed CF… account is real; unlinked senders refused", async () => {
  await setup();
  tick(5000);
  const nu = await relay({ from: "foamy1111", to: "dancf", text: "to a PATV username, not a link", present: true });
  assert.equal(nu.status, 404); assert.equal(nu.d.code, "no_account");
  const au = await relay({ from: "foamy1111", to: "autocf", text: "to an auto account", present: true });
  assert.equal(au.status, 404); assert.equal(au.d.code, "no_account");
  assert.deepEqual(await dm.realLinked("autocf"), { auto: true });
  assert.equal(await dm.realLinked("dancf"), null);
  // the old test treats any CF… username as auto; realLinked asks isAutoAccount (claimed = has a sign-in method)
  assert.deepEqual(await dm.linkedAccount("claimedcf"), { auto: true });
  assert.equal((await dm.realLinked("ClaimedCF")).userId, "u_claim");
  const cl = await relay({ from: "foamy1111", to: "claimedcf", text: "to a claimed account", present: true });
  assert.equal(cl.status, 200, JSON.stringify(cl.d));
  assert.equal((await one("SELECT dm_key FROM conversations WHERE id = ?", [cl.d.conversation])).dm_key, ["u_owner", "u_claim"].sort().join("|"));
  tick(1000);
  const back = await relay({ from: "claimedcf", to: "foamy1111", text: "and back", present: true });
  assert.equal(back.status, 200, JSON.stringify(back.d));
  for (const from of ["nobodycf", "autocf", "bad login!"]) {
    const r = await relay({ from, to: "bobcf", text: "hi", present: true });
    assert.equal(r.status, 403, from); assert.equal(r.d.code, "unlinked", from);
  }
  assert.equal(await count("SELECT COUNT(*) AS n FROM messages WHERE sender_id = 'u_dan' OR sender_id = 'u_auto'"), 0);
});

test("Pepe is never a party; yourself -> self; long text, empty text and a missing key are refused", async () => {
  await setup();
  tick(5000);
  const p = await relay({ from: "foamy1111", to: "pepefrog", text: "hi pepe", present: true });
  assert.equal(p.status, 400); assert.equal(p.d.code, "bot");
  const s = await relay({ from: "foamy1111", to: "FOAMY1111", text: "me", present: true });
  assert.equal(s.status, 400); assert.equal(s.d.code, "self");
  const l = await relay({ from: "foamy1111", to: "bobcf", text: "x".repeat(dm.LIMITS.max_len + 1), present: true });
  assert.equal(l.status, 400); assert.equal(l.d.code, "long");
  const e = await relay({ from: "foamy1111", to: "bobcf", text: "   ", present: true });
  assert.equal(e.status, 400); assert.equal(e.d.code, "empty");
  const nk = await call("POST", "/api/messages/relay-camfrog-pm", { password: "bot-token", from: "foamy1111", to: "bobcf", text: "no key", present: true });
  assert.equal(nk.status, 400); assert.equal(nk.d.code, "bad_request");
});

test("the recipient's rules: blocks either way, 'who can message me' and the new-account rule all answer `refused`; a refused copy is never written", async () => {
  await setup();
  tick(5000);
  const sent = async () => count("SELECT COUNT(*) AS n FROM messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id WHERE cm.user_id = ?", ["u_eve"]);
  // eve blocks the owner
  await dm.setBlock({ userId: "u_eve" }, "pb", true);
  const b1 = await relay({ from: "foamy1111", to: "evecf", text: "blocked by them", present: true });
  assert.equal(b1.status, 403); assert.equal(b1.d.code, "refused");
  assert.doesNotMatch(b1.d.error, /block/i, "the answer never says why");
  tick(1000);
  await dm.setBlock({ userId: "u_eve" }, "pb", false);
  // the owner blocks eve: that one is theirs to know
  tick(1000);
  await dm.setBlock({ userId: "u_owner" }, "eve", true);
  const b2 = await relay({ from: "foamy1111", to: "evecf", text: "blocked by me", present: true });
  assert.equal(b2.status, 403); assert.equal(b2.d.code, "you_blocked");
  tick(1000);
  await dm.setBlock({ userId: "u_owner" }, "eve", false);
  assert.equal(await sent(), 0, "nothing reached eve");
  // "who can message me": nobody / people I follow
  await dm.setPrefs("u_frank", { who: "nobody" });
  const w1 = await relay({ from: "foamy1111", to: "frankcf", text: "closed", present: true });
  assert.equal(w1.status, 403); assert.equal(w1.d.code, "refused");
  await dm.setPrefs("u_gina", { who: "following" });
  const w2 = await relay({ from: "alicecf", to: "ginacf", text: "not followed", present: true });
  assert.equal(w2.status, 403); assert.equal(w2.d.code, "refused");
  assert.equal(w1.d.error, w2.d.error, "one wording for every refusal");
  assert.equal(w1.d.error, b1.d.error);
  // the new-account rule can't trigger for a linked sender, but its code maps the same way
  for (const c of ["blocked", "closed", "following", "new", "anything-else"]) assert.equal(dm._relayCode(c), "refused", c);
  assert.equal(dm._relayCode("you_blocked"), "you_blocked"); assert.equal(dm._relayCode("banned"), "banned"); assert.equal(dm._relayCode("gone"), "no_account");
  assert.equal(dm._relayCode("toString"), "refused", "no prototype keys");
  // a feed-banned sender
  await runQuery("INSERT INTO feed_bans (user_id, room_id, username, reason, by, at, until) VALUES ('u_alice', '', 'alice', 'test', 'pb', ?, NULL)", [T]);
  const fb = await relay({ from: "alicecf", to: "bobcf", text: "banned", present: true });
  assert.equal(fb.status, 403); assert.equal(fb.d.code, "banned");
  await runQuery("DELETE FROM feed_bans WHERE user_id = 'u_alice'");
  // CL13: a `refused` copy is kept in the SENDER's own Camfrog thread (test/messages-cfpm.test.js) - never anywhere the target is
  assert.equal(await count(`SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id
                            WHERE m.body IN ('blocked by them', 'blocked by me', 'closed', 'not followed', 'banned') AND c.kind != 'cfpm'`), 0);
  assert.equal(await count("SELECT COUNT(*) AS n FROM messages WHERE body IN ('blocked by me', 'banned')"), 0, "the sender's own block / ban: not kept either");
});

test("rates: the copies' own per-sender cap (a 429 `rate`)", async () => {
  await setup();
  tick(120000);
  const saved = dm.RELAY.per_min;
  dm.RELAY.per_min = 2;
  try {
    assert.equal((await relay({ from: "foamy1111", to: "carolcf", text: "r1", present: true })).status, 200);
    assert.equal((await relay({ from: "foamy1111", to: "carolcf", text: "r2", present: true })).status, 200);
    const r3 = await relay({ from: "foamy1111", to: "carolcf", text: "r3", present: true });
    assert.equal(r3.status, 429); assert.equal(r3.d.code, "rate");
    // fix-up: when to try again (an upper bound), so Pepe can retry a paced copy instead of dropping it
    assert.equal(r3.d.retry_after, 60); assert.equal(r3.h["retry-after"], "60");
    tick(61000);
    assert.equal((await relay({ from: "foamy1111", to: "carolcf", text: "r4", present: true })).status, 200, "a minute later");
  } finally { dm.RELAY.per_min = saved; }
});

test("fix-up: the copies' per-DAY cap (429 `rate`, retry_after a day); parallel calls with different keys can't pass the cap", async () => {
  await setup();
  tick(120000);
  const savedDay = dm.RELAY.per_day, savedMin = dm.RELAY.per_min;
  const sent = await count("SELECT COUNT(*) AS n FROM messages WHERE sender_id = 'u_alice' AND via = 'cf_pm' AND created_at > ?", [T - 86400e3]);   // (hank takes anyone's messages)
  dm.RELAY.per_day = sent + 2; dm.RELAY.per_min = 1000;
  try {
    // three at once, three keys: the cap is counted inside the write transaction, so exactly two land
    const rs = await Promise.all(["d1", "d2", "d3"].map((text) => relay({ from: "alicecf", to: "hankcf", text, present: true })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 200, 429], JSON.stringify(rs.map((r) => r.d)));
    const no = rs.find((r) => r.status === 429);
    assert.equal(no.d.code, "rate"); assert.equal(no.d.retry_after, 86400); assert.equal(no.h["retry-after"], "86400");
    assert.equal(await count("SELECT COUNT(*) AS n FROM messages WHERE sender_id = 'u_alice' AND via = 'cf_pm' AND created_at > ?", [T - 86400e3]), sent + 2);
    tick(3600e3);
    assert.equal((await relay({ from: "alicecf", to: "hankcf", text: "d4", present: true })).status, 429, "an hour later: still today's cap");
    tick(86400e3);
    assert.equal((await relay({ from: "alicecf", to: "hankcf", text: "d5", present: true })).status, 200, "a day later");
  } finally { dm.RELAY.per_day = savedDay; dm.RELAY.per_min = savedMin; }
});

test("fix-up: a duplicate that arrives while the first call is still being written waits for it - never another pair's conversation", async () => {
  await setup();
  tick(5000); dm._gaps.clear();
  // the shape that broke it: the latest copy is message N, and someone ELSE's site message is N + 1 (CL11 parked the
  // in-flight row at MAX(message_id) + 1 = that message)
  await relay({ from: "foamy1111", to: "ivycf", text: "an earlier copy", present: true });
  tick(1000);
  const priv = await dm.send({ userId: "u_eve" }, { to: "bob", body: "eve and bob's own chat" });
  tick(1000);
  const K = key();
  const input = { from: "foamy1111", to: "ivycf", text: "the copy", key: K, sentAt: T, room: "PepeLab", present: true };
  const A = dm.relayCopy(input);
  let inflight = null;
  for (let i = 0; i < 5000 && inflight == null; i++) {
    const r = (await getQuery("SELECT message_id FROM dm_relays WHERE relay_key = ?", [K]))[0];   // outside a transaction: sees A's open one
    if (r) {
      inflight = r.message_id;
      // what any reader outside the transaction sees of it (an export, the chip's lookup): never somebody else's message
      assert.equal(await count(`SELECT COUNT(*) AS n FROM dm_relays r JOIN messages m ON m.id = r.message_id
                                WHERE r.relay_key = ? AND (m.sender_id != 'u_owner' OR m.via IS NOT 'cf_pm')`, [K]), 0,
                   "the in-flight row never names somebody else's message");
      const peek = await require(path.join(repo, "accountexport")).collect("u_eve");
      assert.deepEqual(peek.messages.camfrog_copies, [], "eve never sent a copy");
    } else await new Promise((res) => setImmediate(res));
  }
  assert.ok(inflight != null && inflight <= 0, `the in-flight row has a negative placeholder (got ${inflight})`);
  const B = await dm.relayCopy(input);
  const a = await A;
  assert.ok(!a.duplicate);
  assert.equal(B.duplicate, true);
  assert.equal(B.conversation, a.conversation, "B answers A's conversation");
  assert.notEqual(B.conversation, priv.conversation.id);
  assert.equal(B.message, a.message);
  assert.equal((await one("SELECT message_id FROM dm_relays WHERE relay_key = ?", [K])).message_id, a.message);
});

test("fix-up: a first call that rolls back is not a duplicate - the retry writes the copy", async () => {
  await setup();
  tick(5000); dm._gaps.clear();
  await relay({ from: "foamy1111", to: "ivycf", text: "another earlier copy", present: true });
  tick(1000);
  await dm.send({ userId: "u_eve" }, { to: "bob", body: "more of eve and bob's chat" });
  tick(1000);
  const K = key();
  // the first attempt (present = 0) fails inside its transaction; the retry (present = 1) goes through
  await runQuery(`CREATE TRIGGER relay_boom BEFORE INSERT ON messages WHEN new.body = 'boom copy'
                  AND (SELECT present FROM dm_relays WHERE relay_key = '${K}') = 0 BEGIN SELECT RAISE(ABORT, 'forced failure'); END`);
  try {
    const input = { from: "foamy1111", to: "ivycf", text: "boom copy", key: K, sentAt: T, room: "PepeLab" };
    const A = dm.relayCopy({ ...input, present: false }).then((x) => ({ ok: x }), (e) => ({ err: e.message }));
    let seen = false;
    for (let i = 0; i < 5000 && !seen; i++) {
      if ((await getQuery("SELECT 1 AS x FROM dm_relays WHERE relay_key = ?", [K])).length) seen = true;
      else await new Promise((res) => setImmediate(res));
    }
    assert.ok(seen, "the retry is sent while the first call is still open");
    const B = await dm.relayCopy({ ...input, present: true });
    const a = await A;
    assert.match(a.err || "", /forced failure/);
    assert.ok(!B.duplicate, "never 'duplicate' for a copy that didn't land: " + JSON.stringify(B));
    assert.equal((await one("SELECT body, via FROM messages WHERE id = ?", [B.message])).body, "boom copy");
    assert.equal(await count("SELECT COUNT(*) AS n FROM dm_relays WHERE relay_key = ? AND message_id = ?", [K, B.message]), 1);
  } finally { await runQuery("DROP TRIGGER IF EXISTS relay_boom"); }
});

test("fix-up: a key that already belongs to a copy naming another sender or target is a 409 `conflict`, never a silent drop", async () => {
  await setup();
  tick(5000);
  const k = key();
  const first = await relay({ from: "foamy1111", to: "hankcf", text: "first", key: k, present: true });
  assert.equal(first.status, 200);
  const other = await relay({ from: "alicecf", to: "hankcf", text: "another sender, same key", key: k, present: true });
  assert.equal(other.status, 409); assert.equal(other.d.code, "conflict");
  const otherTo = await relay({ from: "foamy1111", to: "ivycf", text: "another target, same key", key: k, present: true });
  assert.equal(otherTo.status, 409); assert.equal(otherTo.d.code, "conflict");
  assert.equal(await count("SELECT COUNT(*) AS n FROM messages WHERE body IN ('another sender, same key', 'another target, same key')"), 0);
  // the same copy again: duplicate; a login an account deletion pseudonymised since still matches
  assert.equal((await relay({ from: "foamy1111", to: "hankcf", text: "first", key: k, present: true })).d.duplicate, true);
  await runQuery("UPDATE dm_relays SET to_login = 'deleted-0123456789' WHERE relay_key = ?", [k]);
  const again = await relay({ from: "foamy1111", to: "hankcf", text: "first", key: k, present: true });
  assert.equal(again.status, 200); assert.equal(again.d.duplicate, true); assert.equal(again.d.message, first.d.message);
});

test("`!message` (fromCamfrog) is marked via = 'cf_message' - the 📨 Sent from Camfrog chip; site-typed messages stay NULL", async () => {
  await setup();
  tick(5000);
  const r = await call("POST", "/api/messages/from-camfrog", { password: "bot-token", from: "alicecf", to: "bob", text: "from camfrog via !message" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const m = await one("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1", [r.d.conversation]);
  assert.equal(m.via, "cf_message");
  assert.equal(await count("SELECT COUNT(*) AS n FROM dm_relays WHERE message_id = ?", [m.id]), 0, "no relay row for !message");
  const h = await call("GET", `/api/messages/c/${r.d.conversation}`, undefined, asUser("u_bob"));
  const x = h.d.messages.find((y) => y.id === m.id);
  assert.equal(x.via, "cf_message"); assert.equal(x.cfSentAt, undefined);
  tick(5000); dm._gaps.clear();
  const typed = await dm.send({ userId: "u_bob" }, { to: "alice", body: "typed on the site" });
  assert.equal((await one("SELECT via FROM messages WHERE id = ?", [typed.message.id])).via, null);
  assert.equal(typed.message.via, null);
  // a site request can't claim a Camfrog origin
  tick(5000); dm._gaps.clear();
  const forged = await dm.send({ userId: "u_bob" }, { to: "alice", body: "forged" }, { msgVia: "cf_pm" });
  assert.equal((await one("SELECT via FROM messages WHERE id = ?", [forged.message.id])).via, null);
});

test("deleting a copy (author or admin removal) deletes its relay row: the key and logins go with the message", async () => {
  await setup();
  tick(5000);
  const k = key();
  const r = await relay({ from: "foamy1111", to: "bobcf", text: "delete me", key: k, present: true });
  assert.equal(await count("SELECT COUNT(*) AS n FROM dm_relays WHERE message_id = ?", [r.d.message]), 1);
  await dm.deleteMessage({ userId: "u_owner" }, r.d.message);
  assert.equal(await count("SELECT COUNT(*) AS n FROM dm_relays WHERE message_id = ?", [r.d.message]), 0);
  assert.equal(await count("SELECT COUNT(*) AS n FROM dm_relays WHERE relay_key = ?", [k]), 0, "the key and logins are gone");
  const h = await call("GET", `/api/messages/c/${r.d.conversation}`, undefined, asUser("u_bob"));
  assert.equal(h.d.messages.find((y) => y.id === r.d.message).deleted, true);
  // fix-up: only a one-way hash of the key stays (no key, logins, room or text), so Pepe's late retry can't bring it back
  const g = await getQuery("SELECT * FROM dm_relay_gone WHERE key_hash = ?", [dm._relayGoneHash(k)]);
  assert.equal(g.length, 1); assert.deepEqual(Object.keys(g[0]).sort(), ["gone_at", "kept", "key_hash"]);
  assert.notEqual(g[0].key_hash, k); assert.equal(g[0].kept, null);
  const before = await count("SELECT COUNT(*) AS n FROM messages WHERE via = 'cf_pm'");
  tick(3600e3);
  const retry = await relay({ from: "foamy1111", to: "bobcf", text: "delete me", key: k, present: true });
  assert.equal(retry.status, 200, JSON.stringify(retry.d));
  assert.equal(retry.d.duplicate, true); assert.equal(retry.d.deleted, true); assert.equal(retry.d.message, null); assert.equal(retry.d.conversation, null);
  assert.equal(await count("SELECT COUNT(*) AS n FROM messages WHERE via = 'cf_pm'"), before, "the deleted copy isn't written again");
  // after RELAY_GONE_MS (48 h; Pepe retries for 24 h) the hash is swept
  tick(dm.RELAY_GONE_MS + 3600e3);
  assert.equal((await relay({ from: "foamy1111", to: "bobcf", text: "a later copy", present: true })).status, 200);
  assert.equal(await count("SELECT COUNT(*) AS n FROM dm_relay_gone WHERE key_hash = ?", [dm._relayGoneHash(k)]), 0, "swept after 48 h");

  // an admin's removal (a report -> remove): the same - the relay row goes, the hash stays, a retry writes nothing
  tick(5000);
  const k2 = key();
  const r2 = await relay({ from: "foamy1111", to: "bobcf", text: "report me", key: k2, present: false });
  assert.equal(r2.status, 200, JSON.stringify(r2.d));
  await dm.report({ userId: "u_bob" }, r2.d.message, { reason: "spam" });
  await dm.reportAction({ userId: "u_admin2", username: "boss", class: "Admin" }, { message: r2.d.message, action: "remove", tell: false });
  assert.ok((await one("SELECT deleted_at FROM messages WHERE id = ?", [r2.d.message])).deleted_at, "removed");
  assert.equal(await count("SELECT COUNT(*) AS n FROM dm_relays WHERE relay_key = ? OR message_id = ?", [k2, r2.d.message]), 0, "relay row deleted with the removal");
  assert.equal(await count("SELECT COUNT(*) AS n FROM dm_relay_gone WHERE key_hash = ?", [dm._relayGoneHash(k2)]), 1);
  const before2 = await count("SELECT COUNT(*) AS n FROM messages WHERE via = 'cf_pm'");
  const retry2 = await relay({ from: "foamy1111", to: "bobcf", text: "report me", key: k2, present: false });
  assert.equal(retry2.d.duplicate, true); assert.equal(retry2.d.deleted, true);
  assert.equal(await count("SELECT COUNT(*) AS n FROM messages WHERE via = 'cf_pm'"), before2, "an admin-removed copy isn't written again");
  assert.equal(await count("SELECT COUNT(*) AS n FROM messages WHERE body = 'report me'"), 0);
});

test("account export carries the Camfrog side of the copies you sent (and messages.via); merge rules classify the new columns", async () => {
  await setup();
  const X = require(path.join(repo, "accountexport"));
  const out = await X.collect("u_owner");
  const copies = out.messages && out.messages.camfrog_copies;
  assert.ok(Array.isArray(copies) && copies.length >= 3, JSON.stringify(out.errors || null));
  assert.ok(copies.every((c) => c.from_login === "foamy1111" && c.relay_key && "cf_room" in c && "to_login" in c));
  // fix-up: never `present` (whether the RECIPIENT was in the room is about them), never a placeholder row
  assert.ok(copies.every((c) => !("present" in c) && c.message_id > 0), JSON.stringify(copies[0]));
  const sentVia = out.messages.conversations.flatMap((c) => c.messages_you_sent).map((m) => m.via);
  assert.ok(sentVia.includes("cf_pm"));
  // bob's export: what HE sent only (the owner's copies to him are the owner's)
  const bobOut = await X.collect("u_bob");
  assert.deepEqual(bobOut.messages.camfrog_copies, []);
  // merges: the logins are Camfrog names (not userIds); the relay row follows its message by id
  const AM = require(path.join(repo, "accountMerge"));
  assert.ok(AM.classify("dm_relays", "from_login").deny); assert.ok(AM.classify("dm_relays", "to_login").deny);
  // deletion: the sender's relay rows go with their messages; others' rows naming them are pseudonymised - CL13 fix-up: by
  // their Camfrog LOGINS only (messages.cfLoginForget, test/account-delete.test.js), never by PATV username (NAME_COLUMNS
  // matched both, and a username can be somebody else's Camfrog login)
  const D = require(path.join(repo, "accountdelete"));
  assert.ok(!D.NAME_COLUMNS.includes("dm_relays.from_login") && !D.NAME_COLUMNS.includes("dm_relays.to_login"));
});

test("padrekey never moves dm_relays (cf_room is where the PM went, not a pad); the DDL parses in SQLite 3.31; Node 16-safe modules", async () => {
  await setup();
  const PR = require(path.join(repo, "padrekey"));
  assert.equal(PR.ROOM_COLUMNS.test("cf_room"), false);
  assert.ok(!(await PR.padColumns()).some(([t]) => t === "dm_relays"));
  const src = fs.readFileSync(path.join(repo, "messages.js"), "utf8");
  const ddl = [...src.matchAll(/CREATE TABLE IF NOT EXISTS dm_relays \(([\s\S]*?)\)`/g), ...src.matchAll(/ALTER TABLE messages ADD COLUMN via TEXT/g)].map((m) => m[0]);
  assert.equal(ddl.length, 2);
  for (const d of ddl) for (const bad of [/\biif\(/i, /->>/, /\bunixepoch\(/i, /\bSTRICT\b/, /\bRETURNING\b/i]) assert.doesNotMatch(d, bad, "SQLite 3.31: " + bad);
  for (const f of ["messages.js", "accountexport.js", "accountdelete.js", "accountMerge.js"]) {     // (this file is checked by running it under Node 16)
    const s = fs.readFileSync(path.join(repo, f), "utf8").replace(/\/\/[^\n]*/g, "");
    for (const bad of [/\.findLast(Index)?\(/, /\.toSorted\(/, /\bstructuredClone\(/, /zlib\.crc32\(/, /(^|[^.\w])fetch\(/m]) assert.doesNotMatch(s, bad, `${f}: Node 16 has no ${bad}`);
  }
});

test("rebase onto 1.99ade: a copy's post cards follow each viewer's blocks - live events and history alike", async () => {
  await setup();
  tick(5000);
  await runQuery("INSERT INTO feed_posts (id, author_id, title, body, created, score, comments) VALUES ('RelayPst1', 'u_eve', 'Eve clip', '', ?, 3, 0)", [T]);
  await runQuery("INSERT INTO feed_post_rooms (post_id, room_id, created) VALUES ('RelayPst1', 'room1', ?)", [T]);
  await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES ('u_ivy', 'u_eve', ?)", [T]);   // ivy blocked the post's author
  const ivyEv = listen("u_ivy"), ownEv = listen("u_owner");
  try {
    const r = await relay({ from: "foamy1111", to: "ivycf", text: "look https://publicaccess.tv/feed/p/RelayPst1", present: true });
    assert.equal(r.status, 200, JSON.stringify(r.d));
    const live = (got) => { const e = got.find((x) => x.t === "msg" && x.m.id === r.d.message); assert.ok(e, JSON.stringify(got)); return e.m.embeds[0]; };
    assert.equal(live(ownEv).title, "Eve clip", "the sender (no block with eve) gets the card");
    assert.deepEqual(live(ivyEv), { id: "RelayPst1", href: "/feed/p/RelayPst1", unavailable: true }, "the target blocked the author: unavailable, nothing else");
    const hist = async (uid) => (await call("GET", `/api/messages/c/${r.d.conversation}`, undefined, asUser(uid))).d.messages.find((m) => m.id === r.d.message).embeds[0];
    assert.deepEqual(await hist("u_ivy"), live(ivyEv), "the live event matches a reload");
    assert.equal((await hist("u_owner")).title, "Eve clip");
  } finally {
    await runQuery("DELETE FROM dm_blocks WHERE blocker_id = 'u_ivy' AND blocked_id = 'u_eve'");
  }
});

test("the page: the chip and its strings (en.json keys, defaults equal)", async () => {
  const js = fs.readFileSync(path.join(repo, "public", "js", "messages.js"), "utf8");
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  assert.match(js, /function viaNode\(m\)/);
  assert.equal(en["js.msg.via_cf_pm"], "📨 Relayed from Camfrog");
  assert.equal(en["js.msg.via_cf_pm_tip"], "Sent as a Camfrog PM from Pepe at {time}");
  assert.equal(en["js.msg.via_cf_message"], "📨 Sent from Camfrog");
  assert.match(fs.readFileSync(path.join(repo, "public", "css", "messages.css"), "utf8"), /\.dm-via \{/);
  // fix-up: the copy's chip is a button that shows the Camfrog time on tap / Enter (no hover on touch screens), with its
  // date when it isn't the message's day; the row's tap handler leaves it alone (data-mact)
  const via = js.slice(js.indexOf("function viaNode(m)"), js.indexOf("function msgNode(m)"));
  assert.match(via, /el\('button', \{ type: 'button', cls: 'dm-via', 'data-mact': 'via'/);
  assert.match(via, /dayKey\(at\) === dayKey\(m\.at\) \? hm\(at\) : full\(at\)/);
  assert.match(via, /'aria-expanded': 'false'/);
  assert.match(js, /if \(act === 'via'\) \{[^}]*aria-expanded[^}]*data-tip/);
  assert.match(fs.readFileSync(path.join(repo, "public", "css", "messages.css"), "utf8"), /button\.dm-via \{[^}]*background: none/);
  if (server) server.close();
});
