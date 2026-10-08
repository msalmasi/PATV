// Offline tests for the homepage's automatic room pick (1.99cj: frontroom.js, rooms.frontRoom,
// roomactivity.js, bridge.pepeIn): a fair ranking, the 30-minute hold, the clear-lead rule, the
// immediate switch when activity dies, persistence across a restart, Pepe's window room ignored, and
// Pepe's stage present in every room he's in.
//   NODE_PATH=G:/PATV/node_modules node --test test/frontroom.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "frontroom-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const FR = require(path.join(repo, "frontroom"));
const RA = require(path.join(repo, "roomactivity"));
let rooms = require(path.join(repo, "rooms"));

const HOUSE = "PepeFrog.Room";
const MIN = 60 * 1000;
let T = Date.UTC(2026, 9, 6, 18, 0, 0);
const adv = (ms) => { T += ms; };
rooms._setClock(() => T);

// a summary row with its activity already measured (what bridge.summary + roomactivity would give)
const row = (id, a = {}, live = true) => ({ id, live, count: (a.people || 0) + 1,
  quiet: a.quiet || 0, act: { chatters: a.chatters || 0, lines: a.lines || 0, micMin: a.mic || 0, people: a.people || 0, lastAt: T - (a.quiet || 0) * MIN } });
async function fresh() {
  await runQuery("DELETE FROM rooms_kv WHERE key IN ('front_auto', 'front_cfg')");
  await rooms._reloadAuto();
  await rooms.setFront("auto", "test");
}
// one evaluation per minute (eval_sec 60)
async function step(rows, mins = 1) {
  adv(mins * MIN);
  for (const r of rows) r.act.lastAt = T - r.quiet * MIN;        // "quiet N" = the last line was N minutes before this check
  return (await rooms.frontRoom(rows)).id;
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT)`);
  await rooms.init();
  for (const id of ["DRAMA_CENTRAL", "Quiet.Room", "Other.Room"]) await rooms.addRoom(id, null, "test");
});

test("score formula: documented weights, no bonus for anyone", () => {
  const s = FR.score({ chatters: 10, lines: 120, micMin: 20, people: 40 });
  // 4*10 + 0.25*120 + 1.5*20 + 0.5*40
  assert.equal(s.score, 40 + 30 + 30 + 20);
  assert.deepEqual(Object.keys(s.parts), ["chatters", "lines", "mic", "people"]);
  assert.equal(s.parts.mic.pts, 30);
  const c = FR.cleanCfg({ hold_min: -5, lead_ratio: 0.5, w_chatters: "7", w: { lines: 999 } });
  assert.equal(c.hold_min, 0); assert.equal(c.lead_ratio, 1); assert.equal(c.w.chatters, 7); assert.equal(c.w.lines, 100);
  assert.equal(c.w.mic, FR.DEFAULTS.w.mic);
});

test("fair ranking: the house room gets no bonus; the busier room wins; equal rooms tie-break by id, not by house", async () => {
  await fresh();
  const rows = [row(HOUSE, { chatters: 3, lines: 20, mic: 5, people: 15 }), row("DRAMA_CENTRAL", { chatters: 10, lines: 120, mic: 20, people: 40 })];
  assert.deepEqual(await rooms.frontRoom(rows), { id: "DRAMA_CENTRAL", pinned: false });
  const st = await rooms.frontStatus();
  assert.equal(st.auto.ranked[0].id, "DRAMA_CENTRAL");
  assert.equal(st.auto.ranked[1].score, FR.score({ chatters: 3, lines: 20, micMin: 5, people: 15 }).score, "the house room scores exactly its activity");
  // identical activity: alphabetical id decides ("DRAMA_CENTRAL" < "PepeFrog.Room"), the house room isn't favoured
  await fresh();
  const same = { chatters: 4, lines: 30, mic: 2, people: 10 };
  assert.equal((await rooms.frontRoom([row(HOUSE, same), row("DRAMA_CENTRAL", same)])).id, "DRAMA_CENTRAL");
  const r = FR.rank([row(HOUSE, same), row("DRAMA_CENTRAL", same), row("Other.Room", same)], FR.DEFAULTS, T);
  assert.equal(new Set(r.map((x) => x.score)).size, 1, "same activity = same score, whoever owns the room");
});

test("30-minute hold: a much busier room doesn't take over before the hold is up", async () => {
  await fresh();
  const A = { chatters: 3, lines: 20, mic: 2, people: 8 }, B = { chatters: 12, lines: 150, mic: 30, people: 30 };
  assert.equal(await step([row("Quiet.Room", A), row("Other.Room", { people: 2, chatters: 1, lines: 2 })]), "Quiet.Room");
  const chosenAt = (await rooms.frontStatus()).auto.at;
  for (let m = 1; m < 30; m++) {
    assert.equal(await step([row("Quiet.Room", A), row("Other.Room", B)]), "Quiet.Room", `minute ${m}: still held`);
  }
  // the lead has been clear for many checks; the hold ends at 30 min -> it switches on the first check after
  assert.equal(await step([row("Quiet.Room", A), row("Other.Room", B)]), "Other.Room");
  const st = await rooms.frontStatus();
  assert.ok(st.auto.at - chosenAt >= 30 * MIN);
  assert.match(st.auto.reason, /clear lead/);
  // and the new pick is held in turn
  assert.equal(await step([row("Quiet.Room", B), row("Other.Room", A)]), "Other.Room");
});

test("clear lead: >= 1.25x for 2 checks in a row after the hold; a near tie or a broken streak doesn't switch", async () => {
  await fresh();
  const cur = { chatters: 5, lines: 40, mic: 4, people: 10 };                  // 20 + 10 + 6 + 5 = 41
  const base = FR.score({ chatters: 5, lines: 40, micMin: 4, people: 10 }).score;
  assert.equal(base, 41);
  assert.equal(await step([row("Quiet.Room", cur)]), "Quiet.Room");
  adv(31 * MIN);                                                                 // past the hold
  const x = (ratio) => ({ chatters: 0, lines: 0, mic: 0, people: Math.round((base * ratio) / 0.5) });   // people-only score = ratio x
  for (let i = 0; i < 5; i++) assert.equal(await step([row("Quiet.Room", cur), row("Other.Room", x(1.2))]), "Quiet.Room", "1.2x is not a clear lead");
  assert.equal(await step([row("Quiet.Room", cur), row("Other.Room", x(1.3))]), "Quiet.Room", "one check isn't enough");
  assert.equal(await step([row("Quiet.Room", cur), row("Other.Room", x(1.1))]), "Quiet.Room", "streak broken");
  assert.equal(await step([row("Quiet.Room", cur), row("Other.Room", x(1.3))]), "Quiet.Room", "streak restarts at 1");
  assert.equal((await rooms.frontStatus()).auto.lead.n, 1);
  assert.equal(await step([row("Quiet.Room", cur), row("Other.Room", x(1.3))]), "Other.Room", "2 checks in a row -> switch");
  // the switch is in the room event log with its reason
  const ev = await getQuery("SELECT * FROM room_events WHERE what = 'front-auto' AND room_id = 'Other.Room' ORDER BY ts DESC LIMIT 1");
  assert.match(ev[0].detail, /Quiet\.Room -> Other\.Room: clear lead/);
  // tunable: a 2x ratio stops the same lead
  await fresh();
  await rooms.setFrontCfg({ lead_ratio: 2 }, "test");
  assert.equal(await step([row("Quiet.Room", cur)]), "Quiet.Room");
  adv(31 * MIN);
  for (let i = 0; i < 4; i++) assert.equal(await step([row("Quiet.Room", cur), row("Other.Room", x(1.5))]), "Quiet.Room");
  await rooms.setFrontCfg({ lead_ratio: 1.25 }, "test");
});

test("dies out: no chat or mic for 10 min (or not live any more) -> the top room at once, hold or not", async () => {
  await fresh();
  const busy = { chatters: 6, lines: 50, mic: 5, people: 12 };
  assert.equal(await step([row("Quiet.Room", busy), row("Other.Room", { people: 3, chatters: 1, lines: 3 })]), "Quiet.Room");
  // 5 minutes in, Quiet.Room's last line was 9 minutes ago: not dead yet
  assert.equal(await step([row("Quiet.Room", { people: 12, quiet: 9 }), row("Other.Room", { people: 3, chatters: 1, lines: 3 })], 5), "Quiet.Room");
  // 11 minutes quiet -> switch immediately (well inside the 30-minute hold)
  assert.equal(await step([row("Quiet.Room", { people: 12, quiet: 11 }), row("Other.Room", { people: 3, chatters: 1, lines: 3 })]), "Other.Room");
  assert.match((await rooms.frontStatus()).auto.reason, /died out/);
  // a dead room never replaces a dead room (no churn when everything is quiet)
  await fresh();
  assert.equal(await step([row("Quiet.Room", { people: 5, quiet: 20 }), row("Other.Room", { people: 2, quiet: 30 })]), "Quiet.Room");
  assert.equal(await step([row("Quiet.Room", { people: 1, quiet: 21 }), row("Other.Room", { people: 9, quiet: 31 })]), "Quiet.Room");
  // the featured room stops being live / bridged -> the top live room at once
  assert.equal(await step([row("Quiet.Room", busy, false), row("Other.Room", { people: 2, chatters: 1, lines: 1 })]), "Other.Room");
  assert.match((await rooms.frontStatus()).auto.reason, /no longer live/);
  // nothing live at all: the last pick stays
  assert.equal(await step([row("Other.Room", busy, false)]), "Other.Room");
});

test("persisted: a restart keeps the pick and when it was made (no flip), and the hold still counts", async () => {
  await fresh();
  const A = { chatters: 3, lines: 20, mic: 2, people: 8 }, B = { chatters: 12, lines: 150, mic: 30, people: 30 };
  assert.equal(await step([row("Quiet.Room", A)]), "Quiet.Room");
  const before = await rooms.frontStatus();
  const kv = JSON.parse((await getQuery("SELECT value FROM rooms_kv WHERE key = 'front_auto'"))[0].value);
  assert.equal(kv.id, "Quiet.Room"); assert.equal(kv.at, before.auto.at);
  // "restart": drop the module and load it again from the database
  delete require.cache[require.resolve(path.join(repo, "rooms"))];
  rooms = require(path.join(repo, "rooms"));
  rooms._setClock(() => T);
  assert.equal(await step([row("Quiet.Room", A), row("Other.Room", B)], 5), "Quiet.Room", "the busier room doesn't win just because we restarted");
  const after = await rooms.frontStatus();
  assert.equal(after.auto.at, before.auto.at, "chosen-at survived");
  assert.equal(after.holdUntil, before.auto.at + 30 * MIN);
  // admin "Re-evaluate now" ignores the hold and logs who asked
  await rooms.frontReevaluate([row("Quiet.Room", A), row("Other.Room", B)], "boss");
  assert.equal((await rooms.frontStatus()).auto.id, "Other.Room");
  const ev = await getQuery("SELECT actor, detail FROM room_events WHERE what = 'front-auto' ORDER BY ts DESC, rowid DESC LIMIT 1");
  assert.equal(ev[0].actor, "boss"); assert.match(ev[0].detail, /re-evaluated by an admin/);
  // pinning still overrides, and the automatic pick keeps running underneath
  await rooms.setFront(HOUSE, "boss");
  assert.deepEqual(await rooms.frontRoom([row("Quiet.Room", B), row("Other.Room", A)]), { id: HOUSE, pinned: true });
  await rooms.setFront("auto", "boss");
});

test("bridge end to end: bots and Pepe don't count, and Pepe's window room (!activeroom) is ignored", async () => {
  rooms._setClock(null);              // the bridge counts on the real clock
  await fresh();
  const bridge = require(path.join(repo, "bridge"));
  const ev = (room, type, data, i) => ({ op: "event", id: room + "-" + type + "-" + i + "-" + Math.random(), type, ts: new Date().toISOString(),
                                        scope: { room: { id: room, name: room } }, data });
  const snap = (id, members, mic = []) => ({ room: { id, name: id }, members, mic, count: members.length });
  const pepe = { login: "PepeTheBot", is_self: true }, bot = { login: "spambot", is_bot: true };
  const house = [pepe, bot, ...[1, 2, 3].map((i) => ({ login: "h" + i }))];
  const drama = [pepe, ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ login: "d" + i }))];
  const events = [];
  // the house room: lots of lines - but from Pepe and a bot
  for (let i = 0; i < 40; i++) events.push(ev(HOUSE, "message", { user: i % 2 ? pepe : bot, text: "spam " + i }, i));
  events.push(ev(HOUSE, "message", { user: { login: "h1" }, text: "hi" }, 99));
  // DRAMA_CENTRAL: real people talking
  for (let i = 0; i < 12; i++) events.push(ev("DRAMA_CENTRAL", "message", { user: { login: "d" + ((i % 6) + 1) }, text: "drama " + i }, i));
  await bridge.ingest({ stage: { active: true, room: HOUSE, room_name: "Pepe's Pad", rooms: [{ id: HOUSE, name: "Pepe's Pad" }, { id: "DRAMA_CENTRAL", name: "DRAMA" }] },
                        rooms: [snap(HOUSE, house, [pepe]), snap("DRAMA_CENTRAL", drama, [{ login: "d1" }])], events });
  const s = await bridge.summary(false);
  const h = s.find((r) => r.id === HOUSE), d = s.find((r) => r.id === "DRAMA_CENTRAL");
  assert.equal(h.people, 3, "Pepe + the bot aren't people"); assert.equal(d.people, 8);
  const ha = RA.stats(HOUSE), da = RA.stats("DRAMA_CENTRAL");
  assert.equal(ha.lines, 1); assert.equal(ha.chatters, 1, "Pepe's and the bot's lines never count");
  assert.equal(da.lines, 12); assert.equal(da.chatters, 6);
  // Pepe's window shows the house room - and the homepage still features the busier room
  assert.deepEqual(await rooms.frontRoom(s, bridge.stageRoomRef()), { id: "DRAMA_CENTRAL", pinned: false });
  assert.equal(bridge.stageRoomRef().id, HOUSE, "(his window really is in the house room)");
  // mic minutes: a human holding the mic accrues time between snapshots; Pepe on the mic doesn't
  RA.micSample("Mic.Room", [{ login: "m1" }], 1000);
  RA.micSample("Mic.Room", [{ login: "m1" }, pepe], 1000 + 30 * 1000);
  assert.equal(RA.stats("Mic.Room", { now: 1000 + 30 * 1000 }).micMin, 0.5);
});

test("Pepe's stage: present on the stage of EVERY room he's in, not only his window room", async () => {
  const bridge = require(path.join(repo, "bridge"));
  // (state from the previous test: Pepe is in the house room + DRAMA_CENTRAL, his window shows the house room)
  assert.equal(bridge.pepeIn(HOUSE), true);
  assert.equal(bridge.pepeIn("DRAMA_CENTRAL"), true, "not his window room - still his stage");
  assert.equal(bridge.pepeIn("Other.Room"), false, "a room he isn't in");
  const express = require("express");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { req.user = null; next(); };
  bridge.register(app, { addUser, isBotToken: (t) => t === "bot" });
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  const srv = await new Promise((ok) => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  const base = "http://127.0.0.1:" + srv.address().port;
  const get = (u) => fetch(base + u).then((r) => r.json());
  try {
    const drama = await get("/api/stage?room=drama-central");
    assert.equal(drama.pepe_here, true);
    assert.equal(drama.active, true, "Pepe's stream state is the same in every room");
    assert.equal((await get("/api/stage?room=pepefrog-room")).pepe_here, true);
    assert.equal((await get("/api/stage?room=other-room")).pepe_here, false, "a room Pepe isn't in has no Pepe stage");
    // the homepage poll (no room): the front room (DRAMA_CENTRAL) with Pepe's stage on it
    const front = await get("/api/stage");
    assert.equal(front.front.id, "DRAMA_CENTRAL"); assert.equal(front.pepe_here, true);
    // the room-page API agrees with /api/stage
    assert.equal((await get("/api/rooms/drama-central/stage")).pepe_here, true);
    assert.equal((await get("/api/rooms/other-room/stage")).pepe_here, false);
    // the channel guide marks the rooms he's in
    const g = await require(path.join(repo, "roomsweb")).guideRows(false);
    assert.equal(g.rows.find((r) => r.id === "DRAMA_CENTRAL").pepe_here, true);
    assert.equal(g.rows.find((r) => r.id === "Other.Room").pepe_here, false);
  } finally { srv.close(); }
});

test("1.99cw: the room's !snap switch as Pepe reports it (stage rooms first, else a live bridged room; unknown = null)", async () => {
  const bridge = require(path.join(repo, "bridge"));
  await bridge.ingest({ stage: { active: true, room: HOUSE, rooms: [{ id: HOUSE, name: "Pepe's Pad", snap: true }, { id: "DRAMA_CENTRAL", name: "DRAMA", snap: false },
                                                                    { id: "Old.Room", name: "Old" }] } });
  assert.equal(bridge.snapSwitch(HOUSE), true);
  assert.equal(bridge.snapSwitch("DRAMA_CENTRAL"), false);
  assert.equal(bridge.snapSwitch("Old.Room"), null, "an older Pepe sends no switch");
  assert.equal(bridge.snapSwitch("Nowhere.Room"), null, "a room Pepe isn't in");
  assert.equal(bridge.stageAdmin().rooms.find((r) => r.id === HOUSE).snap, true);
  // a bridged room's snapshot carries it too (used when the stage list doesn't say)
  await bridge.ingest({ rooms: [{ room: { id: "Old.Room", name: "Old" }, members: [{ login: "x1" }], mic: [], count: 1, snap: true }], events: [] });
  assert.equal(bridge.snapSwitch("Old.Room"), true);
});

test("1.99fa: the room's !clip switch as Pepe reports it, next to !snap (unknown = null)", async () => {
  const bridge = require(path.join(repo, "bridge"));
  await bridge.ingest({ stage: { active: true, room: HOUSE, rooms: [{ id: HOUSE, name: "Pepe's Pad", snap: true, clip: false },
                                                                    { id: "DRAMA_CENTRAL", name: "DRAMA", snap: false, clip: true },
                                                                    { id: "Old.Room", name: "Old", snap: true }] } });
  assert.equal(bridge.clipSwitch(HOUSE), false);
  assert.equal(bridge.clipSwitch("DRAMA_CENTRAL"), true);
  assert.equal(bridge.clipSwitch("Old.Room"), null, "an older Pepe sends no !clip switch");
  assert.equal(bridge.clipSwitch("Nowhere.Room"), null, "a room Pepe isn't in");
  assert.equal(bridge.snapSwitch(HOUSE), true, "!snap unaffected");
  await bridge.ingest({ rooms: [{ room: { id: "Old.Room", name: "Old" }, members: [{ login: "x1" }], mic: [], count: 1, snap: true, clip: true }], events: [] });
  assert.equal(bridge.clipSwitch("Old.Room"), true, "a bridged room's snapshot carries it too");
});
