// 1.99aid (privacy controls, review fixes 2 - RV-D; G:/ops/privacy-controls-spec-2026-11-02.md section 8, the owner's "yes" to staff and
// room mods revealing who is behind a frog name): the room analytics' see-through card while text_reveal_roles is on - worded for the
// viewer's role (PATV staff, the pad's moderators, the pad's owner, an admin) and saying the reason is REQUIRED for everyone but an
// admin (the server refuses a reveal without one); off, the card is today's. On the roomstats-frognames.test.js harness.
//   node --test test/privm-review2-analytics.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "privm-review2-an-")));
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token";
process.env.ALIAS_SECRET = "5e".repeat(32);
delete process.env.STAGING;
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const roomstats = require(path.join(repo, "roomstats"));
const rooms = require(path.join(repo, "rooms"));
const PA = require(path.join(repo, "padaccess"));
const FN = require(path.join(repo, "frognames"));

const hash = (l) => crypto.createHash("sha256").update("pepe-hidden:" + l).digest("hex").slice(0, 20);
const DAY = 864e5;
const PAD = "Frog_Pad";
const NEEDLES = ["evecf", "Eve Private", "carolcf", "Carol Stale", "danacf", "Dana Quiet", "ghostlogin", hash("evecf"), hash("carolcf"), hash("danacf"), hash("ghostlogin")];
let base, server;

const nums = (s) => ({ m30: s, s30: s * 10, d30: 9, m90: s * 3, s90: s * 30, d90: 30 });
function roomRow() {
  const days = {};
  for (let i = 0; i < 5; i++) days[new Date(Date.now() - i * DAY).toISOString().slice(0, 10)] = { m: 10, s: 60, k: 1, u: 3, c: 1, n: 0 };
  return {
    room: PAD, name: "Frog Pad", first: 1780000000, last: Math.floor(Date.now() / 1000), days, how: [], hows: [], size: {}, peak: "", uniq: { d30: 5, d90: 9 },
    regulars: [{ login: "alicecf", display: "Alice", ...nums(90), last: 1790000000 },
               { anon: true, h: hash("evecf"), ...nums(80) },
               { login: "carolcf", display: "Carol Stale", ...nums(70), last: 1790000000 },       // a stale named row, incognito now
               { anon: true, h: hash("ghostlogin"), ...nums(60) }],                              // nobody the site knows
    mic_top: [{ anon: true, h: hash("evecf"), s90: 9000, d90: 40 }, { login: "alicecf", display: "Alice", s90: 8000, d90: 40 },
              { anon: true, h: hash("danacf"), s90: 100, d90: 2 }],
    cmds: { top: [], cats: {} }, games: { days: {} }, mod: { total: {}, days: {} },
    knowledge: { summary: "evecf and carolcf run the jokes here.", topics: [], jokes: [], events: [], rules: [] }, changes: [], history: [],
  };
}
const get = (p, user) => fetch(base + p, { headers: user ? { "x-test-user": user } : {} });
const post = (p, user, body, { fetchHdr = true } = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}),
  ...(fetchHdr ? { "x-requested-with": "fetch", origin: base } : {}) }, body: JSON.stringify(body || {}) });
const logRows = () => getQuery("SELECT * FROM seethrough_log ORDER BY id");
const frogs = (html) => [...html.matchAll(/<span class="anon">([^<]+)<\/span><span class="ptag">private<\/span>/g)].map((m) => m[1]);

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT)`);
  for (const [id, cls, cf] of [["u_admin", "Admin", null], ["u_staff", "Staff", null], ["u_owner", "pleb", null], ["u_owner2", "pleb", null],
                               ["u_mem", "pleb", null], ["u_eve", "pleb", "evecf"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, 'x', ?, ?)", [id, id, id, cls, cf]);
  }
  await runQuery(`CREATE TABLE IF NOT EXISTS incognito_state (login TEXT PRIMARY KEY, "on" INTEGER NOT NULL DEFAULT 0, updated INTEGER)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS incognito_anon (login TEXT PRIMARY KEY, since INTEGER)`);
  await runQuery(`INSERT INTO incognito_state (login, "on", updated) VALUES ('carolcf', 1, 1), ('danacf', 1, 1)`);
  await runQuery("CREATE TABLE IF NOT EXISTS room_events (room_id TEXT, ts INTEGER, what TEXT, actor TEXT, detail TEXT)");
  await PA.init();
  await runQuery("INSERT OR REPLACE INTO pad_access (room_id, level) VALUES (?, 'public')", [PAD]);
  await PA.load();
  // the pad's owner (the registry) - stubbed: this harness has no bridge
  const realGet = rooms.get;
  rooms.get = async (id) => (String(id) === PAD ? { id: PAD, owner: { userId: "u_owner" } } : String(id) === "Other_Pad" ? { id: "Other_Pad", owner: { userId: "u_owner2" } } : realGet(id));
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  app.use((req, res, next) => (req.path === "/api/roomstats/sync" ? next() : express.json()(req, res, next)));
  app.use((req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u, username: u } : null; next(); });
  const addUser = (req, res, next) => next();
  roomstats.register(app, { isBotToken: (t) => t === "bot-token", addUser });
  require(path.join(repo, "seethrough")).register(app, { addUser, noTimers: true });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  const r = await fetch(base + "/api/roomstats/sync", { method: "POST", headers: { "content-type": "application/json" },
                                                         body: JSON.stringify({ password: "bot-token", tz: "UTC", days: 90, rooms: [roomRow()] }) });
  assert.equal(r.status, 200);
  await getQuery("SELECT 1 FROM chatlog_rooms LIMIT 1").catch(async () => { await require(path.join(repo, "chatlogview")).init(); });
  await runQuery(`INSERT INTO chatlog_rooms (room_id, pad_id, owner_id, owner_since, created) VALUES (?, ?, 'u_owner', ?, ?)
                  ON CONFLICT(room_id) DO UPDATE SET owner_id = excluded.owner_id, owner_since = excluded.owner_since`, [PAD, PAD, Date.now() - 100 * DAY, Date.now() - 100 * DAY]);
});
test.after(() => server && server.close());

// ── review fixes 2 - RV-D: the analytics card follows text reveal roles ──
const TRV = require(path.join(repo, "textreveal"));
const card = (html) => { const m = /<section class="card ra-see[^"]*" id="raSee"[^]*?<\/section>/.exec(html); return m ? m[0] : null; };

test("RV-D: text reveal roles off - the card is today's (admin / owner wording, the reason optional); staff get none", async () => {
  await TRV.init();
  assert.equal(TRV.isOn(), false);
  const own = card(await (await get("/p/frog-pad/analytics", "u_owner")).text());
  assert.ok(own && /As this pad(&#39;|')s owner/.test(own), String(own));
  assert.match(own, /placeholder="Reason \(optional\)"/);
  assert.equal(card(await (await get("/p/frog-pad/analytics", "u_staff")).text()), null, "staff: no controls (today's roles)");
});

test("RV-D: text reveal roles on - staff get the card worded for them, and everyone but an admin is told the reason is required", async () => {
  await TRV.setOn(true, { userId: "u_admin", username: "u_admin" });
  try {
    const st = card(await (await get("/p/frog-pad/analytics", "u_staff")).text());
    assert.ok(st, "staff: the controls");
    assert.match(st, /As PATV staff you can see who is behind a frog name here/);
    assert.match(st, /placeholder="Reason \(required\)"[^>]*required/);
    const own = card(await (await get("/p/frog-pad/analytics", "u_owner")).text());
    assert.match(own, /As this pad(&#39;|')s owner/);
    assert.match(own, /placeholder="Reason \(required\)"/, "the owner gives a reason too while it's on");
    const adm = card(await (await get("/p/frog-pad/analytics", "u_admin")).text());
    assert.match(adm, /As a PATV admin/);
    assert.match(adm, /placeholder="Reason \(optional\)"/, "admins: none needed");
    // the server agrees: a staff reveal without a reason is refused
    const r = await post("/p/frog-pad/analytics/seethrough", "u_staff", { on: true });
    assert.equal(r.status, 409);
  } finally { await TRV.setOn(false, { userId: "u_admin", username: "u_admin" }); }
});
