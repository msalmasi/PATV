// 1.99wv (connections audit C): the PATV ACCOUNT as the actor. A chat line from an account with no chat login is relayed
// (as "🌐 <username> (PATV web)" by Pepe) only while a capable Pepe runs (actorcap), only for a verified, unbanned account
// whose username isn't someone else's chat login, and never with text the guard catches; every job and every claimed
// action carries the account; "u:<userId>" names resolve to the account on the site's pages.
//   node --test test/relay-account.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-account-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const relay = require(path.join(repo, "bridge-relay"));
const cap = require(path.join(repo, "actorcap"));
const V = require(path.join(repo, "verified"));

const R = { id: "Room.One", slug: "room-one", relay: true, members: [], cmds: relay.cleanCmds({ "!help": 0 }) };
let base, server;

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordId TEXT, twitchId TEXT, level INTEGER DEFAULT 0,
                  created_at TEXT, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery(`CREATE TABLE feed_bans (user_id TEXT NOT NULL, room_id TEXT NOT NULL DEFAULT '', username TEXT, reason TEXT, by TEXT, at INTEGER,
                  until INTEGER, PRIMARY KEY (user_id, room_id))`);
  await runQuery("CREATE TABLE telegram_links (user_id TEXT PRIMARY KEY, tg_id TEXT NOT NULL UNIQUE, link_source TEXT NOT NULL DEFAULT 'self', linked_at INTEGER)");
  const users = [
    ["u1", "alicep", "alice", null],          // linked
    ["u2", "webbob", null, null],             // no chat login, Telegram-verified
    ["u3", "plainjo", null, null],            // no chat login, nothing proven
    ["u4", "carol", null, null],              // verified, but "carol" is u5's chat login
    ["u5", "carolp", "carol", null],
    ["u6", "banned1", null, null],            // verified, feed-banned from Room.One
  ];
  for (const [id, name, cf] of users) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES (?, ?, ?, 'x', ?)", [id, name, name, cf]);
  }
  for (const [id, tg] of [["u2", "1"], ["u4", "2"], ["u6", "3"]]) await runQuery("INSERT INTO telegram_links (user_id, tg_id) VALUES (?, ?)", [id, tg]);
  await runQuery("INSERT INTO feed_bans (user_id, room_id, at) VALUES ('u6', 'Room.One', 1)");
  const app = express();
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u } : null; next(); };
  relay.register(app, { isBotToken: (t) => t === "bot-token", addUser, bySlug: (s) => (s === R.slug ? R : null), isLive: () => true });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server.close());

async function say(text, u) {
  relay._hits.clear();
  const r = await fetch(base + "/api/rooms/" + R.slug + "/say", { method: "POST",
    headers: { "content-type": "application/json", "x-requested-with": "fetch", "x-test-user": u }, body: JSON.stringify({ text }) });
  return { status: r.status, d: await r.json() };
}
const take = () => relay.takeJobs(new Set([R.id])).filter((j) => j.kind === "say");

test("an old Pepe (no actor_cap): an unlinked account is refused as before", async () => {
  cap._set(0);
  const r = await say("hello", "u2");
  assert.equal(r.status, 403);
  assert.match(r.d.error, /link a chat account first/);
  assert.equal(take().length, 0);
});

test("a capable Pepe: a verified account relays as itself - the job carries the actor, no chat login", async () => {
  cap.note({ actor_cap: 1 });
  assert.equal(cap.on(), true);
  const r = await say("hello room", "u2");
  assert.equal(r.status, 200, JSON.stringify(r.d));
  const js = take();
  assert.equal(js.length, 1);
  assert.equal(js[0].camfrog, "");
  assert.equal(js[0].user_id, "u2");
  assert.deepEqual([js[0].actor.userId, js[0].actor.username, js[0].actor.login], ["u2", "webbob", null]);
  assert.equal(js[0].display, undefined, "no free-text display name for an account line");
});

test("a linked account: unchanged, its job carries the actor with the login", async () => {
  const r = await say("yo", "u1");
  assert.equal(r.status, 200);
  const js = take();
  assert.equal(js[0].camfrog, "alice");
  assert.equal(js[0].actor.login, "alice");
});

test("refused: nothing proven, a feed ban on this pad, another member's chat name, guarded text", async () => {
  V.forget("u3");
  let r = await say("hi", "u3");
  assert.equal(r.status, 403);
  assert.match(r.d.error, /Telegram, Google or Plex/);
  r = await say("hi", "u6");
  assert.equal(r.status, 403);
  assert.match(r.d.error, /can't talk in this pad/);
  r = await say("hi", "u4");
  assert.equal(r.status, 403);
  assert.match(r.d.error, /another member's chat name/);
  r = await say("send me your PAT", "u2");
  assert.equal(r.status, 400);
  assert.equal(take().length, 0);
});

test("typed ! commands stay chat-login only", async () => {
  const r = await say("!help", "u2");
  assert.equal(r.status, 403);
  assert.match(r.d.error, /Typed commands run as a chat name/);
});

test("the website action queue hands Pepe the actor; Pepe's claim turns the capability on", async () => {
  const actions = require(path.join(repo, "actions"));
  const app = express();
  app.use(express.json());
  actions.register(app, { isBotToken: (t) => t === "bot-token", addUser: (q, s, n) => n() });
  const srv = app.listen(0);
  const url = "http://127.0.0.1:" + srv.address().port;
  try {
    await actions.queue("u2", { kind: "cmd", args: ["donate", "lotto", "25k"], tag: "wallet" });
    cap._set(0);
    const r = await fetch(url + "/api/actions/claim", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "bot-token", actor_cap: 1 }) });
    const d = await r.json();
    assert.equal(cap.on(), true, "actor_cap on a claim");
    const a = d.actions.find((x) => x.user_id === "u2");
    assert.ok(a, "the action carries user_id");
    assert.deepEqual([a.actor.userId, a.actor.username, a.actor.login, a.camfrog], ["u2", "webbob", null, null]);
  } finally { srv.close(); }
});

test("userlinks: a u:<userId> name resolves to the account (never shown as the raw id)", async () => {
  const UL = require(path.join(repo, "userlinks"));
  const id = "0b1c2d3e-aaaa-bbbb-cccc-1234567890ab";
  await runQuery("INSERT INTO users (userId, username, displayname, password) VALUES (?, 'uuidguy', 'Uuid Guy', 'x')", [id]);
  const html = await UL.finish("<p>" + UL.ul("u:" + id) + " and " + UL.ul("u:ffffffff-0000-0000-0000-000000000000") + "</p>");
  assert.match(html, /href="\/u\/uuidguy"/);
  assert.doesNotMatch(html, /u:0b1c|u:ffff/);
  assert.match(html, /a PATV member/);
});
