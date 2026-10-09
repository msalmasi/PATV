// Messages from Camfrog through Pepe (messages.js fromCamfrog, 1.99ij): `!message <PATV user or Camfrog name> <text>`.
// The sender must be LINKED (Pepe's "CF…" auto accounts don't count), the recipient is a linked Camfrog login first,
// else a PATV username ("u/<name>" forces it); it is an ordinary send - blocks, "who can message me", rate limits.
//   node --test test/messages-camfrog.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dm-cf-test-"));
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

let T = Date.now();
dm._setClock(() => T);

async function mkUser(id, name, cf, extra = {}) {
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, camfrogUsername, level, created_at) VALUES (?, ?, ?, 'x', 'pleb', ?, 5, '2026-01-01 00:00:00')`,
                 [id, name, extra.display || name, cf]);
}

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await inbox.ready; await follows.init(); await store.init(); await dm.init();
  await mkUser("u_alice", "alice", "alicecf", { display: "Alice" });
  await mkUser("u_bob", "bob", "bobcf");
  await mkUser("u_auto", "CFa1b2c3d4", "autocf");          // Pepe's auto account only: not linked
  await mkUser("u_carol", "carol", null);                   // no Camfrog link (reachable by PATV username)
  await mkUser("u_dave", "dave", "carol");                  // dave's Camfrog login is "carol" - the login wins over the username
  await mkUser("u_eve", "eve", "evecf");
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES ('pepe-bot', 'Pepe', 'Pepe', 'x', 'Bot', 'pepefrog')");
  const app = express();
  app.use(express.json());
  dm.register(app, { isBotToken: (p) => p === "bot-token", addUser: (req, res, next) => next() });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

async function post(body) {
  const r = await fetch(base + "/api/messages/from-camfrog", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, d: await r.json() };
}
const last = async (conv) => (await getQuery("SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1", [conv]))[0];

test("bot token only", async () => {
  assert.equal((await post({ password: "nope", from: "alicecf", to: "bob", text: "hi" })).status, 403);
});

test("a linked sender reaches a PATV username; it is a normal DM from their account", async () => {
  T += 5000;
  const r = await post({ password: "bot-token", from: "AliceCF", to: "bob", text: "hey bob, from camfrog" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.to.username, "bob");
  const m = await last(r.d.conversation);
  assert.equal(m.sender_id, "u_alice"); assert.equal(m.body, "hey bob, from camfrog");
  const a = (await getQuery("SELECT * FROM dm_alerts WHERE user_id = 'u_bob'"))[0];
  assert.ok(a && a.pending >= 1, "bob's usual Camfrog alert is queued");
});

test("recipient by Camfrog login first; u/<name> forces the PATV username", async () => {
  T += 5000;
  const r1 = await post({ password: "bot-token", from: "alicecf", to: "@carol", text: "to the camfrog login carol" });
  assert.equal(r1.d.to.username, "dave", "the linked login 'carol' is dave");
  T += 5000;
  const r2 = await post({ password: "bot-token", from: "alicecf", to: "u/carol", text: "to the PATV user carol" });
  assert.equal(r2.d.to.username, "carol");
});

test("not linked (no account, or only Pepe's CF… auto account): refused with code unlinked", async () => {
  for (const from of ["nobodycf", "autocf"]) {
    const r = await post({ password: "bot-token", from, to: "bob", text: "hi" });
    assert.equal(r.status, 403); assert.equal(r.d.code, "unlinked");
  }
});

test("unknown recipient, Pepe himself, empty text", async () => {
  T += 5000;
  assert.equal((await post({ password: "bot-token", from: "alicecf", to: "ghost", text: "hi" })).d.code, "gone");
  assert.equal((await post({ password: "bot-token", from: "alicecf", to: "pepefrog", text: "hi" })).d.code, "bot");
  assert.equal((await post({ password: "bot-token", from: "alicecf", to: "bob", text: "   " })).d.code, "empty");
});

test("blocks and 'who can message me' apply like on the site; so do rate limits", async () => {
  T += 5000;
  await dm.setBlock({ userId: "u_eve" }, "alice", true);
  const b = await post({ password: "bot-token", from: "alicecf", to: "evecf", text: "hello eve" });
  assert.equal(b.status, 403); assert.equal(b.d.code, "blocked");
  T += 1000;
  await dm.setBlock({ userId: "u_eve" }, "alice", false);
  await dm.setPrefs("u_eve", { who: "nobody" });
  T += 5000;
  assert.equal((await post({ password: "bot-token", from: "alicecf", to: "evecf", text: "hello eve" })).d.code, "closed");
  T += 5000;
  const ok = await post({ password: "bot-token", from: "bobcf", to: "alicecf", text: "one" });
  assert.equal(ok.status, 200);
  const fast = await post({ password: "bot-token", from: "bobcf", to: "alicecf", text: "two" });
  assert.equal(fast.status, 429, "the 350 ms double-send gap");
});

test("the web relay's command deny-list keeps !message off the website", () => {
  const relay = require(path.join(repo, "bridge-relay"));
  assert.ok(relay.CMD_DENY.has("!message") && relay.CMD_DENY.has("!patvmsg"));
});
