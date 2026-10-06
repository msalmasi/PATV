// Offline tests for chat commands from the room relay (bridge-relay.js, 1.99): a "!" line becomes a
// "cmd" job carrying the account's VERIFIED Camfrog link (never anything from the request), only for
// commands on the room's menu from Pepe and not on the deny-list, JSON + X-Requested-With only, rate
// limited, audited in bridge_cmd_log (admins read it), and Pepe's private replies reach only that
// user's own feed.
//   node --test test/relaycmd.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relaycmd-test-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const relay = require(path.join(repo, "bridge-relay"));

const R = { id: "Room.One", slug: "room-one", relay: true, members: [],
  cmds: relay.cleanCmds({ "!topic": 1000, "!kick": 0, "!help": 0, "!update": 0, "!msg": 0, "bogus": 5, "!ask": 1000 }) };
const OFF = { id: "Room.Two", slug: "room-two", relay: true, members: [], cmds: {} };

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  for (const [id, cf, cls] of [["u1", "alice", "pleb"], ["u2", null, "pleb"], ["u3", "bossadmin", "Admin"], ["u4", "dana", "pleb"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, 'x', ?, ?)",
      [id, id + "_patv", id, cls, cf]);
  }
  await new Promise((r) => setTimeout(r, 100));               // bridge_cmd_log is created on load
  const app = express();
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u } : null; next(); };
  relay.register(app, { isBotToken: (t) => t === "bot-token", addUser, bySlug: (s) => (s === R.slug ? R : s === OFF.slug ? OFF : null), isLive: () => true });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server.close());

const H = (u, extra = {}) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u } : {}, extra);
async function say(text, u, { slug = R.slug, headers } = {}) {
  relay._hits.clear();
  const r = await fetch(base + "/api/rooms/" + slug + "/say", { method: "POST", headers: headers || H(u), body: JSON.stringify(Object.assign({ text }, { camfrog: "bossadmin", user: "u3" })) });
  return { status: r.status, d: await r.json() };
}
const jobsOf = (kind) => relay.takeJobs(new Set([R.id, OFF.id])).filter((j) => j.kind === kind);

test("menu from Pepe is cleaned: deny-listed and malformed names dropped", () => {
  assert.deepEqual(Object.keys(R.cmds).sort(), ["!ask", "!help", "!kick", "!topic"]);
  assert.equal(R.cmds["!topic"], 1000);
});

test("a ! line is a command job with the account's verified Camfrog link - never the body's", async () => {
  const r = await say("!topic frogs rule", "u1");
  assert.equal(r.status, 200);
  assert.ok(r.d.ok && r.d.cmd);
  const js = jobsOf("cmd");
  assert.equal(js.length, 1);
  assert.equal(js[0].camfrog, "alice");                 // the body said "bossadmin" - ignored
  assert.equal(js[0].text, "!topic frogs rule");
  assert.equal(js[0].room, R.id);
  assert.equal(jobsOf("say").length, 0, "not relayed as chat");
});

test("unlinked accounts are refused with the link hint", async () => {
  const r = await say("!help", "u2");
  assert.equal(r.status, 403);
  assert.match(r.d.error, /Link your Camfrog name/);
});

test("not signed in -> 401", async () => {
  const r = await say("!help", null);
  assert.equal(r.status, 401);
});

test("deny-list and off-menu commands are refused before Pepe sees them", async () => {
  for (const t of ["!update now", "!msg bob hi", "!redlist add x", "!nosuch", "!!"]) {
    const r = await say(t, "u3");
    assert.equal(r.status, 400, t);
    assert.match(r.d.error, /isn't available/);
  }
  assert.equal(jobsOf("cmd").length, 0);
});

test("commands off in the room -> refused; !commands answered by the site", async () => {
  let r = await say("!help", "u1", { slug: OFF.slug });
  assert.equal(r.status, 403);
  r = await say("!commands", "u1");
  assert.ok(r.d.ok && r.d.local);
  assert.match(r.d.reply, /!topic/);
  assert.match(r.d.reply, /1,000 PAT/);
  assert.equal(jobsOf("cmd").length, 0, "!commands never reaches Pepe");
});

test("CSRF: commands need JSON + X-Requested-With", async () => {
  const r = await say("!help", "u1", { headers: { "content-type": "application/json", "x-test-user": "u1" } });
  assert.equal(r.status, 400);
  const f = await fetch(base + "/api/rooms/" + R.slug + "/say", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-test-user": "u1", "x-requested-with": "fetch" }, body: "text=!kick+bob" });
  assert.notEqual(f.status, 200);
  assert.equal(jobsOf("cmd").length, 0);
});

test("rate limit per account", async () => {
  relay._hits.clear();
  const post = () => fetch(base + "/api/rooms/" + R.slug + "/say", { method: "POST", headers: H("u4"), body: JSON.stringify({ text: "!help" }) });
  const a = await post(), b = await post();
  assert.equal(a.status, 200);
  assert.equal(b.status, 429);
  jobsOf("cmd");
});

test("acks: result + private replies only in that user's feed; late replies appended; audit row updated", async () => {
  await say("!topic -p", "u1");
  const [job] = jobsOf("cmd");
  relay.applyAcks([{ id: job.id, ok: true, msg: "usage: !topic <text>", replies: ["usage: !topic <text>"] }]);
  relay.applyAcks([{ id: job.id, ok: true, msg: "", replies: ["and one more thing"], late: true }]);
  const mine = relay.mineFor("u1", R.id).find((x) => x.id === job.id);
  assert.equal(mine.state, "done");
  assert.deepEqual(mine.replies, ["usage: !topic <text>", "and one more thing"]);
  assert.equal(relay.mineFor("u4", R.id).some((x) => x.id === job.id), false, "other users never see it");
  await new Promise((r) => setTimeout(r, 100));
  const row = (await getQuery("SELECT * FROM bridge_cmd_log WHERE job = ?", [job.id]))[0];
  assert.equal(row.camfrog, "alice");
  assert.equal(row.room, R.id);
  assert.equal(row.command, "!topic -p");
  assert.equal(row.status, "ok");
});

test("audit log: admins only", async () => {
  let r = await fetch(base + "/api/bridge/cmdlog", { headers: H("u1") });
  assert.equal(r.status, 403);
  r = await fetch(base + "/api/bridge/cmdlog?camfrog=alice", { headers: H("u3") });
  const d = await r.json();
  assert.ok(d.ok && d.rows.length >= 1);
  assert.ok(d.rows.every((x) => x.camfrog === "alice"));
});

test("a command is offered to Pepe once (no re-run after a lost ack / restart)", async () => {
  await say("!help", "u1");
  const [job] = jobsOf("cmd");
  const j = relay._jobs.get(job.id);
  j.claimed = Date.now() - 10 * 60 * 1000;               // long past the retry window, never acked
  assert.equal(jobsOf("cmd").length, 0);
});

test("plain chat lines still relay as before", async () => {
  const r = await say("hello room", "u1");
  assert.equal(r.status, 200);
  assert.equal(jobsOf("say").length, 1);
});
