// Offline tests for econ.js (economy v2 E-0, measurement only): the bot's charge attribution sync
// (tags kept, idempotent refs, bot token), participation upserts, the stage watch heartbeat (one
// session per account, consecutive beats, paused / hidden tabs earn nothing, the position must
// advance, the streamer and linked accounts excluded, shared-browser / crowded-network alts flagged),
// the admin telemetry card's API, and the dry-run math against docs/ECONOMY-V2.md's examples.
//   node --test test/econ.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "econ-test-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const econ = require(path.join(repo, "econ"));
const welcome = require(path.join(repo, "welcome"));

const near = (a, b, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
let base, server, now = 1800000000000;

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, class TEXT DEFAULT 'pleb', camfrogUsername TEXT)`);
  for (const [id, cls] of [["admin1", "Admin"], ["s1", "pleb"], ["v1", "pleb"], ["v2", "pleb"], ["v3", "pleb"], ["alt1", "pleb"]]) {
    await runQuery("INSERT INTO users (userId, username, class) VALUES (?, ?, ?)", [id, id, cls]);
  }
  await runQuery(`CREATE TABLE IF NOT EXISTS stage_slots (id INTEGER PRIMARY KEY, userId TEXT, room_id TEXT, status TEXT, embed TEXT)`);
  await runQuery("INSERT INTO stage_slots (id, userId, room_id, status, embed) VALUES (7, 's1', 'DRAMA_CENTRAL', 'active', NULL)");
  await runQuery("INSERT INTO stage_slots (id, userId, room_id, status, embed) VALUES (8, 's1', 'DRAMA_CENTRAL', 'ended', NULL)");
  await runQuery("INSERT INTO stage_slots (id, userId, room_id, status, embed) VALUES (9, 's1', 'DRAMA_CENTRAL', 'active', '{\"p\":\"youtube\"}')");
  await welcome.ready;
  await econ.ready;
  // alt1 is the streamer's other account: same Discord id
  const k = welcome.hash("discord", "12345");
  await runQuery("INSERT INTO welcome_keys (k, userId, kind, created) VALUES (?, 's1', 'discord', 0), (?, 'alt1', 'discord', 0)", [k, k]);
  econ._setClock(() => now);
  const app = express();
  app.use((req, res, next) => (req.path === "/api/econ/charges" || req.path === "/api/econ/participation" ? next() : express.json()(req, res, next)));
  const addUser = (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? { userId: u, username: u } : null;
    req.cookies = req.get("x-dev") ? { patv_dev: req.get("x-dev") } : {};
    next();
  };
  econ.register(app, { isBotToken: (t) => t === "bot-token", addUser, resolveRoom: async (slug) => (slug === "drama" ? "DRAMA_CENTRAL" : "PepeFrog.Room") });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

const post = (p, body, h = {}) => fetch(base + p, { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, h), body: JSON.stringify(body) });
const DEV = (c) => c.repeat(32).slice(0, 32);
function beat(user, b, h = {}) {
  return post("/api/econ/watch/beat", Object.assign({ stream: "7", room: "drama", sid: "sess-" + user, playing: true, visible: true, muted: false }, b),
    Object.assign({ "x-test-user": user, "x-dev": DEV(user === "v1" ? "a" : user === "v2" ? "b" : user === "v3" ? "a" : "c"), "cf-connecting-ip": "10.0.0." + user.length }, h))
    .then((r) => r.json().then((j) => Object.assign({ status: r.status }, j)));
}

// ── pure: the session rule ──
test("sessionStep: consecutive, advancing beats from one session; paused / hidden earn nothing", () => {
  const s = econ.sessionStep;
  const b = (o) => Object.assign({ sid: "A", stream: "slot:7", playing: true, visible: true, pos: 0 }, o);
  let r = s(undefined, b({}), 0);
  assert.equal(r.credit, 0); assert.equal(r.why, "started");                      // the first beat only arms
  const armed = r.next;
  r = s(armed, b({ pos: 30 }), 30000);
  assert.equal(r.credit, 30); assert.equal(r.why, "counted");
  assert.equal(s(armed, b({ pos: 30, playing: false }), 30000).credit, 0);        // paused
  assert.equal(s(armed, b({ pos: 30, playing: false }), 30000).next, null);       // ...and disarmed
  assert.equal(s(armed, b({ pos: 30, visible: false }), 30000).why, "hidden");
  assert.equal(s(armed, b({ pos: 1 }), 30000).why, "not advancing");              // frozen player
  assert.equal(s(armed, b({ pos: 30 }), 5000).why, "too soon");
  assert.equal(s(armed, b({ pos: 300 }), 120000).why, "gap");                      // a long gap restarts, no credit
  assert.equal(s(armed, b({ sid: "B", pos: 30 }), 30000).why, "another session");   // a second tab / device
  assert.equal(s(armed, b({ sid: "B", pos: 30 }), 60000).why, "started");           // ...takes over once the first is gone
  assert.equal(s(armed, b({ stream: "slot:9", pos: 30 }), 30000).why, "started");  // switching streams re-arms
});

// ── pure: the doc's dry-run math ──
test("recipe matches ECONOMY-V2 7.3 (DRAMA_CENTRAL, B = 680k, I7 = 510k)", () => {
  const B = 680000, I7 = 510350;
  const empty = econ.recipe(B, { I7 });
  assert.equal(empty.paid, 0); assert.equal(empty.stays, B);
  const busy = econ.recipe(B, { I7, ownerPresent: true, gangHolds: true, qualified: 50, gamesRan: true });
  near(busy.owner, 102000); near(busy.gang, 102000); near(busy.participants, 238000); near(busy.games, 68000);
  assert.equal(busy.streamers, 0); near(busy.paid, 510000); near(busy.stays, 170000);
  const watched = econ.recipe(B, { I7, ownerPresent: true, gangHolds: true, qualified: 50, gamesRan: true, vwm: 900 });
  near(watched.streamers, 170000); near(watched.paid, 680000); near(watched.stays, 0);
  const oneViewer = econ.recipe(B, { I7, ownerPresent: true, gangHolds: true, qualified: 50, gamesRan: true, vwm: 60 });
  near(oneViewer.streamers, 17000); near(oneViewer.paid, 527000);
  const house = econ.recipe(100000, { I7: 69620, house: true, ownerPresent: true, qualified: 1 });   // PepeFrog.Room row
  assert.equal(house.owner, 0); near(house.participants, 1750);
  // the owner / gang slices are capped at 25% of the 7-day inflow
  near(econ.recipe(2000000, { I7: 100000, ownerPresent: true }).owner, 25000);
});

test("equilibrium and gang net match ECONOMY-V2 5.1 / 8.1", () => {
  near(econ.equilibrium(510350, 0.75), 6804667);          // busy, no stream
  near(econ.equilibrium(510350, 1.0), 5103500);           // watched stream
  near(econ.equilibrium(69620, 0.4), 1740500);            // thin room
  const B = 0.10 * econ.equilibrium(510350, 0.75);
  const gang = econ.recipe(B, { I7: 510350, gangHolds: true }).gang;
  near(gang - Math.max(3000, 0.08 * 510350), 61242, 2);   // DRAMA_CENTRAL gang net/day
});

test("split5050: owner self-spend and no-room spend go to Fort Knox; games are not split", () => {
  const s = econ.split5050([
    { kind: "room", room_id: "DRAMA_CENTRAL", payer_kind: "other", amount: 1000 },
    { kind: "room", room_id: "DRAMA_CENTRAL", payer_kind: "owner", amount: 500 },
    { kind: "room", room_id: "", payer_kind: "other", amount: 200 },
    { kind: "federal", room_id: "DRAMA_CENTRAL", amount: 100 },
    { kind: "fine", room_id: "DRAMA_CENTRAL", amount: 50 },
    { kind: "game", room_id: "DRAMA_CENTRAL", amount: 7 },
  ]);
  assert.equal(s.to_vault, 500);
  assert.equal(s.to_fortknox, 500 + 500 + 200 + 100 + 50);
  assert.equal(s.owner_self, 500); assert.equal(s.no_room, 200); assert.equal(s.games, 7);
});

// ── ingest ──
test("charges: bot token, tags kept, refs idempotent, junk dropped", async () => {
  const d = new Date(now).toISOString().slice(0, 10);
  const items = [
    { ref: "a".repeat(32), ts: now, day: d, room: "DRAMA_CENTRAL", flow: "say", kind: "room", payer: "alice", payer_kind: "other", amount: 10000, via: "chat" },
    { ref: "b".repeat(32), ts: now, day: d, room: "DRAMA_CENTRAL", flow: "ask", kind: "room", payer: "bob", payer_kind: "other", amount: 1000, via: "pm" },
    { ref: "c".repeat(32), ts: now, day: d, room: "", flow: "imagine", kind: "room", payer: "dave", payer_kind: "other", amount: 5000, via: "web" },
    { ref: "d".repeat(32), ts: now, day: d, room: "DRAMA_CENTRAL", flow: "say", kind: "room", payer: "own", payer_kind: "owner", amount: 10000, via: "chat" },
    { ref: "e".repeat(32), ts: now, day: d, room: "DRAMA_CENTRAL", flow: "ask", kind: "room", payer: "bob", payer_kind: "other", amount: -1000, via: "system" },
    { ref: "bad ref!", room: "X", flow: "say", amount: 5 },
    { ref: "f".repeat(32), room: "bad room <x>", flow: "say", amount: 5 },
  ];
  assert.equal((await post("/api/econ/charges", { password: "nope", items })).status, 403);
  let j = await (await post("/api/econ/charges", { password: "bot-token", items })).json();
  assert.equal(j.saved, 5);
  j = await (await post("/api/econ/charges", { password: "bot-token", items })).json();
  assert.equal(j.saved, 0);                                          // a re-send changes nothing
  const rows = await getQuery("SELECT * FROM econ_charges ORDER BY ref");
  assert.equal(rows.length, 5);
  assert.deepEqual([rows[1].room_id, rows[1].via, rows[1].payer], ["DRAMA_CENTRAL", "pm", "bob"]);
  assert.deepEqual([rows[2].room_id, rows[2].via], ["", "web"]);
  assert.equal(rows[3].payer_kind, "owner"); assert.equal(rows[4].amount, -1000);
});

test("participation: upserts per room/day/login, keeping the larger counts", async () => {
  const d = new Date(now).toISOString().slice(0, 10);
  const rows = [{ room: "DRAMA_CENTRAL", day: d, login: "alice", lines: 12, mic_min: 0, cmds: 2, active_min: 9 },
                { room: "DRAMA_CENTRAL", day: d, login: "bob", lines: 2, mic_min: 7.5, cmds: 0, active_min: 8 },
                { room: "DRAMA_CENTRAL", day: d, login: "lurk", lines: 1, mic_min: 0, cmds: 0, active_min: 1 },
                { room: "", day: d, login: "x", lines: 50 }, { room: "DRAMA_CENTRAL", day: "nope", login: "x" }];
  assert.equal((await post("/api/econ/participation", { password: "x", rows })).status, 403);
  assert.equal((await (await post("/api/econ/participation", { password: "bot-token", rows })).json()).saved, 3);
  await post("/api/econ/participation", { password: "bot-token", rows: [{ room: "DRAMA_CENTRAL", day: d, login: "alice", lines: 5, active_min: 20 }] });
  const a = (await getQuery("SELECT * FROM econ_participation WHERE login = 'alice'"))[0];
  assert.equal(a.lines, 12); assert.equal(a.active_min, 20);
});

// ── heartbeats ──
test("watch: signed-in only; consecutive beats credit; paused / hidden / embeds / ended slots don't", async () => {
  assert.equal((await post("/api/econ/watch/beat", { stream: "7", sid: "xxxxxxxx", playing: true, visible: true })).status, 401);
  let r = await beat("v1", { pos: 0 });
  assert.equal(r.counted, false); assert.equal(r.why, "started");
  now += 30000;
  r = await beat("v1", { pos: 30 });
  assert.equal(r.counted, true); assert.equal(r.secs, 30); assert.equal(r.status, "ok");
  now += 30000;
  r = await beat("v1", { pos: 60, visible: false });                  // tab hidden
  assert.equal(r.counted, false); assert.equal(r.why, "hidden");
  now += 30000;
  r = await beat("v1", { pos: 90 });                                  // re-armed, not credited
  assert.equal(r.counted, false);
  now += 30000;
  r = await beat("v1", { pos: 120, playing: false });                 // paused
  assert.equal(r.counted, false); assert.equal(r.why, "paused");
  r = await beat("v1", { stream: "9", pos: 0 });                      // an embed slot
  assert.equal(r.counted, false); assert.match(r.why, /not a live/);
  r = await beat("v1", { stream: "8", pos: 0 });                      // an ended slot
  assert.equal(r.counted, false);
  const w = (await getQuery("SELECT * FROM econ_watch WHERE viewer_id = 'v1'"))[0];
  assert.equal(w.secs, 30); assert.equal(w.room_id, "DRAMA_CENTRAL"); assert.equal(w.streamer_id, "s1"); assert.equal(w.stream, "slot:7");
});

test("watch: one counted session per account (a second tab earns nothing)", async () => {
  now += 600000;
  await beat("v2", { pos: 0, sid: "tab-one" });
  now += 30000;
  assert.equal((await beat("v2", { pos: 30, sid: "tab-one" })).counted, true);
  const r = await beat("v2", { pos: 30, sid: "tab-two" });
  assert.equal(r.counted, false); assert.equal(r.why, "another session");
});

test("watch: the streamer and their linked accounts are excluded (status self)", async () => {
  now += 600000;
  for (const u of ["s1", "alt1"]) {
    await beat(u, { pos: 0 });
    now += 30000;
    const r = await beat(u, { pos: 30 });
    assert.equal(r.counted, true); assert.equal(r.status, "self", u);
    now -= 30000;
  }
});

test("watch: a viewer sharing another viewer's browser is flagged alt", async () => {
  now += 600000;
  await beat("v3", { pos: 0 });                                       // same patv_dev cookie as v1
  now += 30000;
  const r = await beat("v3", { pos: 30 });
  assert.equal(r.counted, true); assert.equal(r.status, "alt");
});

test("watch: Pepe's stream resolves the room from the page", async () => {
  now += 600000;
  await beat("v2", { stream: "pepe", room: "drama", pos: 0, sid: "pepe-tab" });
  now += 30000;
  const r = await beat("v2", { stream: "pepe", room: "drama", pos: 30, sid: "pepe-tab", muted: true });
  assert.equal(r.counted, true);
  const w = (await getQuery("SELECT * FROM econ_watch WHERE stream = 'pepe:DRAMA_CENTRAL'"))[0];
  assert.equal(w.streamer_id, null); assert.equal(w.muted_secs, 30);
});

// ── the admin card ──
test("telemetry: admins only; per-room revenue, watch, participants and the dry run", async () => {
  const realNow = Date.now;
  Date.now = () => now;                                                // telemetry's 7-day window
  try {
    assert.equal((await fetch(base + "/api/admin/econ/telemetry", { headers: { "x-test-user": "v1" } })).status, 403);
    const d = await (await fetch(base + "/api/admin/econ/telemetry", { headers: { "x-test-user": "admin1" } })).json();
    assert.equal(d.ok, true); assert.equal(d.enabled, true);
    const dc = d.rooms.find((r) => r.room_id === "DRAMA_CENTRAL");
    assert.equal(dc.revenue.total, 10000 + 1000 + 10000 - 1000);
    assert.equal(dc.revenue.by_via.pm, 1000);
    assert.equal(dc.split.owner_self, 10000);
    assert.equal(dc.split.to_vault, (10000 + 1000 - 1000) / 2);
    assert.equal(dc.watch.vwm, Math.round((30 + 30 + 30) / 60));          // v1 + v2 + Pepe's stream (v2); alt / self apart
    assert.equal(dc.watch.self_min, 1); assert.equal(dc.watch.alt_min, 1);
    assert.equal(dc.people.unique, 2);                                      // alice (12 lines), bob (7.5 mic min)
    assert.ok(dc.dryrun && dc.dryrun.inflow === 5000 && dc.dryrun.paid > 0 && dc.dryrun.balance > 0);
    const none = d.rooms.find((r) => r.room_id === "");
    assert.equal(none.revenue.total, 5000); assert.equal(none.dryrun, null);
  } finally { Date.now = realNow; }
});

test("flag off: ingest and beats are accepted and dropped", async () => {
  await econ.setConfig({ economy_e0: 0 });
  const j = await (await post("/api/econ/charges", { password: "bot-token", items: [{ ref: "z".repeat(32), room: "DRAMA_CENTRAL", flow: "say", kind: "room", amount: 5 }] })).json();
  assert.equal(j.off, true);
  assert.equal((await beat("v1", { pos: 999 })).why, "off");
  await econ.setConfig({ economy_e0: 1 });
});
