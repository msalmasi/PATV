// 1.99afn (FU-3, owner 2026-10-27 K-1 / D-12 / D-13 / D-14 / D-15 / J-18): room analytics show private people under a daily frog
// name at their real rank with their exact numbers, and admins (every pad) / a pad's owner (their own pad, after owning it for the
// 90 days the boards cover) can see who is behind one - a row at a time or with a toggle that stays on until turned off - each
// reveal logged in seethrough_log; never Staff, members or another pad's owner; never by a GET; no-store, no-referrer. The leak
// test: no private login, display name or hash in the page for anyone who didn't reveal.
//   node --test test/roomstats-frognames.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "rs-frog-test-")));
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

test("the page: frog names at the real ranks (the same person, the same name on both boards), exact numbers; signed out and for every role before a reveal - no login, display name or hash", async () => {
  const pages = {};
  for (const who of [null, "u_mem", "u_staff", "u_owner2", "u_owner", "u_admin"]) {
    const res = await get("/p/frog-pad/analytics", who);
    assert.equal(res.status, 200, String(who));
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    const html = await res.text();
    for (const n of NEEDLES) assert.ok(!html.includes(n), `${n} leaked to ${who}`);
    pages[who] = html;
  }
  const f = frogs(pages[null]);
  assert.equal(f.length, 5, "3 private regulars + 2 private mic rows: " + f.join(", "));
  assert.equal(f[0], f[3], "eve: regulars #2 = mic #1 (one name per page)");
  assert.equal(new Set(f).size, 4, "four private people");
  assert.match(pages[null], /someone and someone run the jokes here/, "Pepe's notes keep 'someone' (D-17), never a frog name");
  for (const who of ["u_mem", "u_staff", "u_owner2"]) assert.doesNotMatch(pages[who], /id="raSee"|class="ra-rv"/, who + ": no see-through controls");
  for (const who of ["u_owner", "u_admin"]) {
    assert.match(pages[who], /id="raSee"/, who + ": the controls");
    assert.equal((pages[who].match(/class="ra-rv"/g) || []).length, 5, who + ": a Reveal per private row");
  }
  assert.deepEqual(frogs(pages.u_admin), f, "the same names for everyone");
  const a = await roomstats.forRoom((await roomstats.all()).find((x) => x.room === PAD), "frog-pad", null);
  assert.equal(a.regulars[1].d30, 9, "exact numbers (D-13)");
  assert.deepEqual(a.mic.map((x) => x.rank), [1, 2, 3]);
  assert.equal(a.mic[0].pct, 100);
  // the day's name, from the shared generator - keyed by the hidden-set hash
  const want = FN.boardAliases(PAD, FN.boardPeriod(Date.now()), [hash("evecf"), hash("carolcf"), hash("ghostlogin"), hash("danacf")], ["alicecf", "Alice"]);
  assert.equal(f[0], want.get(hash("evecf")));
  assert.equal(f[1], want.get(hash("carolcf")), "a masked stored row is keyed like an anon row");
  assert.equal(f[4], want.get(hash("danacf")));
  assert.equal(f[2], want.get(hash("ghostlogin")));
});

test("reveal: members, Staff, another pad's owner and an owner who hasn't owned it for 90 days get 403 and write NOTHING; never without the site's fetch headers; never by a GET", async () => {
  const alias = frogs(await (await get("/p/frog-pad/analytics")).text())[0];
  for (const who of ["u_mem", "u_staff", "u_owner2", null]) {
    const r = await post("/p/frog-pad/analytics/reveal", who, { row: alias });
    assert.equal(r.status, who ? 403 : 401, String(who));
    const t = await post("/p/frog-pad/analytics/seethrough", who, { on: true });
    assert.equal(t.status, who ? 403 : 401, String(who));
  }
  assert.equal((await post("/p/frog-pad/analytics/reveal", "u_admin", { row: alias }, { fetchHdr: false })).status, 403, "a form / link from elsewhere");
  await runQuery("UPDATE chatlog_rooms SET owner_since = ? WHERE room_id = ?", [Date.now() - 10 * DAY, PAD]);
  assert.equal((await post("/p/frog-pad/analytics/reveal", "u_owner", { row: alias })).status, 403, "owner for 10 days: no (D-15)");
  await runQuery("UPDATE chatlog_rooms SET owner_since = ? WHERE room_id = ?", [Date.now() - 100 * DAY, PAD]);
  await runQuery("INSERT INTO room_events (room_id, ts, what, actor, detail) VALUES (?, ?, 'owner', 'x', 'u_owner')", [PAD, Date.now() - 20 * DAY]);
  assert.equal((await post("/p/frog-pad/analytics/reveal", "u_owner", { row: alias })).status, 403, "an owner change 20 days ago: no");
  await runQuery("DELETE FROM room_events");
  const html = await (await get("/p/frog-pad/analytics?reveal=1&seethrough=1", "u_admin")).text();
  assert.doesNotMatch(html, /🕶 Real names are on|class="real"/, "a GET reveals nothing");
  for (const n of NEEDLES) assert.ok(!html.includes(n), n);
  assert.equal((await logRows()).length, 0, "no row for any of it");
});

test("reveal one row: an admin (any pad) and the pad's owner (90 days+) get the login - no-store, no-referrer, ONE log row each; unknown -> null; a stale name -> 409", async () => {
  const f = frogs(await (await get("/p/frog-pad/analytics")).text());
  const r = await post("/p/frog-pad/analytics/reveal", "u_admin", { row: f[0], reason: "report #12" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  assert.deepEqual(await r.json(), { ok: true, row: f[0], real: "evecf" });
  const o = await post("/p/frog-pad/analytics/reveal", "u_owner", { row: f[1] });
  assert.deepEqual(await o.json(), { ok: true, row: f[1], real: "carolcf" }, "the owner, for a masked stored row");
  const g = await post("/p/frog-pad/analytics/reveal", "u_admin", { row: f[2] });
  assert.deepEqual(await g.json(), { ok: true, row: f[2], real: null }, "a hash nobody on the site has: null ('not known to the site')");
  assert.equal((await post("/p/frog-pad/analytics/reveal", "u_admin", { row: "Soggy Nonexistent" })).status, 409);
  const rows = await logRows();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((x) => [x.user_id, x.role, x.scope, x.room_id, JSON.parse(x.logins).join(), x.n, x.ended != null]),
                   [["u_admin", "admin", "analytics_line", PAD, "evecf", 1, true], ["u_owner", "owner", "analytics_line", PAD, "carolcf", 1, true],
                    ["u_admin", "admin", "analytics_line", PAD, "", 0, true]]);
  assert.equal(rows[0].reason, "report #12");
  const list = await (await get("/api/admin/seethrough", "u_admin")).json();
  assert.equal(list.rows.length, 3, "admins read the log");
  assert.equal((await get("/api/admin/seethrough", "u_staff")).status, 403, "Staff don't");
  await runQuery("DELETE FROM seethrough_log");
});

test("the toggle (owner J-18): on until turned off - every page shows the real names to that viewer only and counts on ONE log row; off closes it; a viewer who loses the right has it closed", async () => {
  const on = await post("/p/frog-pad/analytics/seethrough", "u_admin", { on: true, reason: "audit" });
  assert.deepEqual(await on.json(), { ok: true, on: true });
  const p1 = await get("/p/frog-pad/analytics", "u_admin");
  assert.equal(p1.headers.get("referrer-policy"), "no-referrer");
  const html = await p1.text();
  assert.match(html, /Real names are on for you on this pad/);
  assert.match(html, /<span class="real" title="Only you can see this">· evecf 🕶<\/span>/);
  assert.match(html, /· carolcf 🕶/);
  assert.match(html, /· \(not known to the site\) 🕶/);
  assert.match(html, /· danacf 🕶/, "dana: incognito_state names her (the site's own table)");
  assert.doesNotMatch(html, /class="ra-rv"/, "no per-row buttons while all are shown");
  await get("/p/frog-pad/analytics", "u_admin");
  let rows = await logRows();
  assert.equal(rows.length, 1, "one row for the toggle");
  assert.deepEqual([rows[0].scope, rows[0].ended, rows[0].n, rows[0].reason], ["analytics_toggle", null, 2, "audit"]);
  assert.deepEqual(JSON.parse(rows[0].logins).sort(), ["carolcf", "danacf", "evecf"]);
  // nobody else sees anything
  for (const who of [null, "u_mem", "u_staff", "u_owner"]) {
    const h = await (await get("/p/frog-pad/analytics", who)).text();
    for (const n of NEEDLES) assert.ok(!h.includes(n), n + " to " + who);
  }
  const off = await post("/p/frog-pad/analytics/seethrough", "u_admin", { on: false });
  assert.deepEqual(await off.json(), { ok: true, on: false });
  rows = await logRows();
  assert.ok(rows[0].ended != null && rows[0].ref === "off:viewer");
  const after = await (await get("/p/frog-pad/analytics", "u_admin")).text();
  for (const n of NEEDLES) assert.ok(!after.includes(n), n + " after off");
  // lost the right while it was on: closed at the next page, nothing shown
  await post("/p/frog-pad/analytics/seethrough", "u_admin", { on: true });
  await runQuery("UPDATE users SET class = 'Staff' WHERE userId = 'u_admin'");
  try {
    const h = await (await get("/p/frog-pad/analytics", "u_admin")).text();
    for (const n of NEEDLES) assert.ok(!h.includes(n), n + " after losing the right");
    rows = await logRows();
    assert.equal(rows[1].ref, "off:lost_right");
    assert.ok(rows[1].ended != null);
  } finally { await runQuery("UPDATE users SET class = 'Admin' WHERE userId = 'u_admin'"); }
});
