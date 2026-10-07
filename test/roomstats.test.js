// Offline tests for room analytics (1.99be): Pepe's POST /api/roomstats/sync (bot token, sanitised,
// removals), /p/:slug/analytics (was /rooms/...) (signed-in only like the live room page; visitors get the sign-in
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
  const r = await get("/p/drama-central/analytics");
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /for signed-in members/);
  assert.doesNotMatch(html, /Alice|football|ShyPerson/);
});

test("signed-in members see the analytics, privacy respected", async () => {
  const r = await get("/p/drama-central/analytics", "u3");
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /football/);
  assert.match(html, /chaotic but friendly/);
  assert.match(html, /href="\/u\/alice"/, "a linked public profile is linked");
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
  let r = await get("/p/pepes-pad/analytics", "u3");
  assert.equal(r.status, 200);
  await bridge.ingest({ rooms: [{ room: { id: "PepeFrog.Room", name: "Pepe's Pad" }, members: [], count: 3 }], events: [] });
  r = await get("/p/pepes-pad", "u3");
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /href="\/p\/pepes-pad\/analytics"/, "the pad page links its analytics");
  const a = await (await get("/p/pepes-pad/analytics", "u3")).text();
  assert.match(a, /Pad page/, "analytics links back to the pad page");
  // 1.99ed: /p no longer lists every pad's analytics (the pad page / About tab links it)
  const list = await (await get("/p")).text();
  assert.doesNotMatch(list, /\/analytics"/);
  assert.doesNotMatch(list, /class="ral"/);
});

// 1.99el: the pad About tab's Analytics card (was an "Analytics: Pad analytics ›" row in the details list)
test("About tab: an Analytics card with the headline numbers for members, the sign-in prompt for visitors", async () => {
  const r = (await roomstats.all()).find((x) => x.room === "PepeFrog.Room");
  const p = roomstats.preview(r);
  assert.equal(p.uniq30, "57");
  assert.equal(p.typical, "14");
  assert.equal(p.peakSize, "31");
  assert.equal(typeof p.msgsTrend, "number", "the month-on-month trend is there");
  assert.equal(roomstats.preview(r), p, "cached until the next sync");
  const html = await (await get("/p/pepes-pad", "u3")).text();
  const card = html.slice(html.indexOf('class="card an-card"'), html.indexOf("</section>", html.indexOf('class="card an-card"')));
  assert.ok(card.length > 50, "the card is on the About tab");
  assert.match(card, /📈 Analytics/);
  assert.equal((card.match(/class="an-t( an-wide)?"/g) || []).length, 5, "messages, visitors, mic time, typical size, busiest");
  assert.ok(card.includes(">" + p.msgs30 + "<"), "messages (30d)");
  assert.match(card, /class="(up|down)">[▲▼] \d+%<\/span> on the month before/, "with its trend arrow");
  assert.ok(card.includes(">" + p.mic30 + "<"), "mic time (30d)");
  assert.match(card, /peak 31/);
  assert.match(card, /busiest Fri-Sat/);
  assert.match(card, /href="\/p\/pepes-pad\/analytics">See full analytics ›<\/a>/);
  assert.doesNotMatch(html, /<dt>Analytics<\/dt>/, "the old details-list row is gone");
  assert.match(html, /role="menuitem"[^>]*href="\/p\/pepes-pad\/analytics"|href="\/p\/pepes-pad\/analytics"[^>]*role="menuitem"/, "the header ⋯ menu link stays");
  // a visitor: the analytics page's sign-in prompt, no numbers
  const v = await (await get("/p/pepes-pad")).text();
  const vc = v.slice(v.indexOf('class="card an-card"'), v.indexOf("</section>", v.indexOf('class="card an-card"')));
  assert.match(vc, /for signed-in members/);
  assert.match(vc, /See full analytics ›/);
  assert.doesNotMatch(vc, /class="an-t/);
  assert.doesNotMatch(vc, /busiest Fri-Sat|peak 31/);
});

// 1.99el: notes stored before 1.99el were cut at 400 characters mid-sentence
test("summary: a cut note shows up to its last full sentence, a full one as written", async () => {
  const cut = "DRAMA_CENTRAL is a rowdy late-night hangout where regulars roast each other on the mic and argue about everything. "
    + "Lately it has been Pad Wars talk, PAT gifting and a lawn-care cam feud between wattz and tha_hussler that will not die. "
    + "Lawn care, bowel troubles and Canada-vs-NYC arguments fill the quiet hours between the louder sets on the mic. "
    + "The earlier bot-building/heist crowd was around a lot less this week, and new faces showed up most nights.";
  const stored = cut.slice(0, 400);          // what the old 400 cap kept: mid-sentence
  assert.ok(cut.length > 400 && stored.includes("The earlier") && !stored.trim().endsWith("."), JSON.stringify(stored.slice(-30)));
  assert.equal(roomstats.sentenceTrim(stored), cut.slice(0, cut.indexOf(" The earlier")));
  assert.equal(roomstats.sentenceTrim("Busy room. Lots of football talk"), "Busy room. Lots of football talk", "a short note is never trimmed");
  const whole = cut.slice(0, cut.indexOf(" The earlier")) + " The earlier bot-building crowd comes back on weekends.";
  assert.equal(roomstats.sentenceTrim(whole), whole);
  assert.ok(roomstats.sentenceTrim("x".repeat(1200)).endsWith("…"), "a runaway note is capped with an ellipsis");
  assert.ok(roomstats.sentenceTrim("x".repeat(1200)).length <= 901);
  // longer notes survive the sync now (was cut at 400)
  const long = whole + " Two more sentences keep it going past the old cap. And here is the last one, with a full stop.";
  await sync({ rooms: [room("DRAMA_CENTRAL", "DRAMA_CENTRAL", { knowledge: { summary: long, topics: [{ t: "football", w: 3 }], at: 1790000000 } })] });
  let html = await (await get("/p/drama-central/analytics", "u3")).text();
  assert.ok(html.includes("And here is the last one, with a full stop.</p>"), "a long note is shown whole");
  await sync({ rooms: [room("DRAMA_CENTRAL", "DRAMA_CENTRAL", { knowledge: { summary: stored, topics: [{ t: "football", w: 3 }], at: 1790000000 } })] });
  html = await (await get("/p/drama-central/analytics", "u3")).text();
  assert.ok(html.includes("between the louder sets on the mic.</p>"), "the cut note ends at its last sentence");
  assert.doesNotMatch(html, /crowd was a/);
});

// 1.99el: snapshots ~6 hours apart showed the same date twice ("Oct 7, 2026" x2)
test("topics over time: each snapshot is labelled with its day and hour, in the page's timezone", async () => {
  const at = (iso) => Math.floor(Date.parse(iso) / 1000);
  const y = new Date().getUTCFullYear();
  assert.equal(roomstats.histWhen(at(`${y}-10-07T12:05:00Z`), "Eastern Daylight Time"), "Oct 7 · 8 AM");
  assert.equal(roomstats.histWhen(at(`${y}-10-07T18:05:00Z`), "Eastern Daylight Time"), "Oct 7 · 2 PM");
  assert.equal(roomstats.histWhen(at(`${y}-10-07T18:05:00Z`), "EDT"), "Oct 7 · 2 PM");
  assert.equal(roomstats.histWhen(at(`${y}-10-07T18:05:00Z`), "Somewhere Odd"), "Oct 7 · 6 PM UTC", "an unknown zone says UTC");
  assert.equal(roomstats.histWhen(at(`${y - 1}-10-07T18:05:00Z`), "UTC"), `Oct 7, ${y - 1} · 6 PM`, "another year shows the year");
  const hist = [`${y}-10-06T08:00:00Z`, `${y}-10-06T14:00:00Z`, `${y}-10-07T02:00:00Z`, `${y}-10-07T08:00:00Z`, `${y}-10-07T14:00:00Z`]
    .map((iso, i) => ({ at: at(iso), topics: ["topic " + i] }));
  await sync({ tz: "Eastern Daylight Time", rooms: [room("DRAMA_CENTRAL", "DRAMA_CENTRAL", { history: hist })] });
  const html = await (await get("/p/drama-central/analytics", "u3")).text();
  const labels = [...html.matchAll(/<div><b>([^<]+)<\/b><span>topic \d<\/span><\/div>/g)].map((m) => m[1]);
  assert.equal(labels.length, 5);
  assert.equal(new Set(labels).size, 5, `no duplicate labels: ${labels.join(" | ")}`);
  assert.deepEqual(labels, ["Oct 7 · 10 AM", "Oct 7 · 4 AM", "Oct 6 · 10 PM", "Oct 6 · 10 AM", "Oct 6 · 4 AM"], "newest first");
});

test("unknown rooms 404, removed rooms disappear", async () => {
  assert.equal((await get("/p/nope/analytics", "u3")).status, 404);
  const r = await sync({ rooms: [], remove: ["DRAMA_CENTRAL"] });
  assert.equal((await r.json()).removed, 1);
  assert.equal((await get("/p/drama-central/analytics", "u3")).status, 404);
});
