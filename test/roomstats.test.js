// Offline tests for room analytics (1.99be): Pepe's POST /api/roomstats/sync (bot token, sanitised,
// removals), /rooms/:slug/analytics (signed-in only like the live room page; visitors get the sign-in
// prompt and no data), privacy (people who hide Analytics on their profile aren't named, moderation is
// counts only, moderation commands never listed), slugs shared with bridged rooms, and the links from
// /rooms and the live room page.
//   node --test test/roomstats.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roomstats-test-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token";
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const roomstats = require(path.join(repo, "roomstats"));
const bridge = require(path.join(repo, "bridge"));
const profileLayout = require(path.join(repo, "profilelayout"));

const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
function room(id, name, extra = {}) {
  const days = {};
  for (let i = 0; i < 40; i++) days[day(i)] = { m: 100 + i, s: 600, k: 7, u: 12, c: 9, n: i % 5 === 0 ? 2 : 0 };
  const how = Array(168).fill(0); how[5 * 24 + 21] = 500; how[2 * 24 + 14] = 40;
  return {
    room: id, name, first: 1780000000, last: Math.floor(Date.now() / 1000) - 60, days, how, hows: Array(168).fill(3),
    size: { typical: 14, peak: 31, src: "roster" }, peak: "busiest Fri-Sat, around 21:00-00:00", uniq: { d30: 57, d90: 120 },
    regulars: [
      { login: "alicecf", display: "Alice <b>W</b>", m30: 900, s30: 3600, d30: 22, m90: 2000, s90: 9000, d90: 60, last: 1790000000 },
      { login: "shycf", display: "ShyPerson", m30: 500, s30: 0, d30: 18, m90: 900, s90: 0, d90: 40, last: 1790000000 },
      { login: "carolcf", display: "Carol", m30: 300, s30: 60, d30: 10, m90: 600, s90: 100, d90: 20, last: 1790000000 },
      { login: "bad login!", display: "x" },
    ],
    mic_top: [{ login: "alicecf", display: "Alice", s90: 9000, d90: 50 }, { login: "shycf", display: "ShyPerson", s90: 100, d90: 2 }],
    cmds: { top: [["bj", 50, "games"], ["kick", 9, "moderation"], ["spin", 20, "games"], ["<script>", 3, "x"]], cats: { games: 70, moderation: 9 } },
    games: { days: { [day(1)]: { casino: 5, wheel: 2 }, [day(50)]: { heists: 3 } } },
    mod: { total: { kick: 4, topic: 2 }, days: { [day(2)]: { kick: 3 }, [day(3)]: { topic: 2 } } },
    knowledge: { summary: "A loud late-night room <img src=x onerror=alert(1)>", vibe: "chaotic but friendly", at: Math.floor(Date.now() / 1000) - 3600,
                 topics: [{ t: "football", w: 5 }, { t: "crypto prices", w: 2 }], jokes: ["Dave's one more spin"], events: ["the great mic war"], rules: ["no politics on mic"] },
    changes: ["chat up 20% on the month before"], history: [{ at: 1790000000, topics: ["football"] }, { at: 1790500000, topics: ["football", "crypto prices"] }],
    ...extra,
  };
}

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0,
                  camfrogUsername TEXT, avatar TEXT)`);
  for (const [id, name, cf] of [["u1", "alice", "AliceCF"], ["u2", "shy", "shycf"], ["u3", "viewer", null]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES (?, ?, ?, 'x', ?)", [id, name, name, cf]);
  }
  await profileLayout.save("u2", { hidden: ["analytics"] });      // shy hides Analytics on their profile
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  app.use((req, res, next) => (req.path === "/api/roomstats/sync" ? next() : express.json()(req, res, next)));
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? { userId: u, username: u === "u3" ? "viewer" : u } : null;
    next();
  };
  roomstats.register(app, { isBotToken: (t) => t === "bot-token", addUser });
  bridge.register(app, { isBotToken: (t) => t === "bot-token", addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server.close());

const sync = (body) => fetch(base + "/api/roomstats/sync", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ password: "bot-token", tz: "EDT", days: 90, ...body }) });
const get = (p, user) => fetch(base + p, { headers: user ? { "x-test-user": user } : {} });

test("sync needs the bot token", async () => {
  const r = await fetch(base + "/api/roomstats/sync", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "nope", rooms: [room("X", "X")] }) });
  assert.equal(r.status, 403);
});

test("sync stores sanitised rooms", async () => {
  const r = await sync({ rooms: [room("DRAMA_CENTRAL", "DRAMA_CENTRAL"), room("PepeFrog.Room", "Pepe's Pad"), room("camfrog", "old"), room("bad id!", "x")] });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.saved, 2);
  const row = (await roomstats.all()).find((x) => x.room === "DRAMA_CENTRAL");
  assert.deepEqual(row.cmds.top.map((t) => t[0]), ["bj", "spin"], "moderation commands and junk are never listed");
  assert.equal(row.regulars.length, 3, "a bad login is dropped");
  assert.equal(row.regulars[0].display, "Alice W", "Camfrog markup stripped from display names");
  assert.equal(row.how.length, 168);
});

test("visitors get the sign-in prompt and no data", async () => {
  const r = await get("/rooms/drama-central/analytics");
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /for signed-in members/);
  assert.doesNotMatch(html, /Alice|football|ShyPerson/);
});

test("signed-in members see the analytics, privacy respected", async () => {
  const r = await get("/rooms/drama-central/analytics", "u3");
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /football/);
  assert.match(html, /chaotic but friendly/);
  assert.match(html, /href="\/u\/alice\/profile"/, "a linked public profile is linked");
  assert.match(html, />Carol</, "an unlinked regular is shown by their Camfrog name");
  assert.doesNotMatch(html, /ShyPerson/, "someone who hides Analytics on their profile is never named");
  assert.match(html, /\+1 regular keep their activity private/);
  assert.match(html, /\+1 keep their activity private/, "mic leaderboard folds them too");
  assert.doesNotMatch(html, /<img src=x/, "model text is escaped");
  assert.match(html, /&lt;img src=x/);
  assert.equal((html.match(/class="ra-cell"/g) || []).length, 168 * 2, "chat + mic hour-of-week heatmaps");
  assert.match(html, /Kicks<b>3<\/b>/, "moderation is aggregate counts (90 days)");
  assert.doesNotMatch(html, /!kick/, "moderation commands aren't listed");
  assert.match(html, /Casino/);
  assert.match(html, /busiest Fri-Sat/);
  assert.match(html, /57/, "unique visitors 30d");
});

test("slug for a non-bridged room comes from its name; bridged rooms share the live page slug", async () => {
  let r = await get("/rooms/pepes-pad/analytics", "u3");
  assert.equal(r.status, 200);
  await bridge.ingest({ rooms: [{ room: { id: "PepeFrog.Room", name: "Pepe's Pad" }, members: [], count: 3 }], events: [] });
  r = await get("/rooms/pepes-pad", "u3");
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /href="\/rooms\/pepes-pad\/analytics"/, "the live room page links its analytics");
  const a = await (await get("/rooms/pepes-pad/analytics", "u3")).text();
  assert.match(a, /Live room/, "analytics links back to the live room");
  const list = await (await get("/rooms")).text();
  assert.match(list, /href="\/rooms\/drama-central\/analytics"/);
  assert.match(list, /href="\/rooms\/pepes-pad\/analytics"/);
});

test("unknown rooms 404, removed rooms disappear", async () => {
  assert.equal((await get("/rooms/nope/analytics", "u3")).status, 404);
  const r = await sync({ rooms: [], remove: ["DRAMA_CENTRAL"] });
  assert.equal((await r.json()).removed, 1);
  assert.equal((await get("/rooms/drama-central/analytics", "u3")).status, 404);
});
