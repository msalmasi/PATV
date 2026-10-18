// 1.99acf bridgespans.js: when each Camfrog room was bridged, recorded from Pepe's syncs for the later VM-log import (the chat
// design §3.7): a span opens on the first sync that carries the room, last_seen is written at most once a minute, closed[] and
// room.left close it, a gap of more than 10 minutes closes it at last_seen + 10 min and opens a new one, the sweeper closes
// silent rooms, the switch off records nothing, and a database error never fails /api/bridge/sync.
//   node --test test/bridge-spans.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-spans-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const BS = require(path.join(repo, "bridgespans"));
const HO = require(path.join(repo, "huboutbox"));

const MIN = 60000;
const T0 = Date.parse("2026-10-18T12:00:00Z");
const spans = (room) => getQuery("SELECT * FROM bridge_spans WHERE room_id = ? ORDER BY id", [room]);
const snap = (id) => ({ room: { id, name: id }, members: [], mic: [], count: 0 });
const evIn = (id, type = "message") => ({ op: "event", id: "e" + Math.random(), type, scope: { platform: "camfrog", room: { id, name: id } }, data: {} });

let base, server;
test.before(async () => {
  await HO.init();
  await BS.init();
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER)`);
  const bridge = require(path.join(repo, "bridge"));
  const app = express();
  bridge.register(app, { isBotToken: (t) => t === "bot-token", addUser: (req, res, next) => { req.user = null; next(); } });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());

test("a sync that carries a room opens its span; last_seen is written at most once a minute", async () => {
  await BS.note({ session: "s1", rooms: [snap("Room.A")] }, T0);
  let s = await spans("Room.A");
  assert.equal(s.length, 1);
  assert.deepEqual([s[0].session, s[0].opened_at, s[0].last_seen, s[0].closed_at], ["s1", T0, T0, null]);
  await BS.note({ session: "s1", rooms: [snap("Room.A")] }, T0 + 30 * 1000);
  assert.equal((await spans("Room.A"))[0].last_seen, T0, "30 s later: not written yet");
  await BS.note({ session: "s1", events: [evIn("Room.A")] }, T0 + 61 * 1000);
  assert.equal((await spans("Room.A"))[0].last_seen, T0 + 61 * 1000, "an event scoped to the room carries it too; written after a minute");
});

test("closed[] closes now (closed); a room.left event closes (left)", async () => {
  await BS.note({ session: "s1", rooms: [snap("Room.B")] }, T0);
  await BS.note({ session: "s1", closed: ["Room.B"] }, T0 + 5 * MIN);
  let s = await spans("Room.B");
  assert.deepEqual([s[0].closed_at, s[0].close_reason], [T0 + 5 * MIN, "closed"]);
  await BS.note({ session: "s1", rooms: [snap("Room.C")] }, T0);
  await BS.note({ session: "s1", events: [evIn("Room.C", "room.left")] }, T0 + 2 * MIN);
  s = await spans("Room.C");
  assert.deepEqual([s[0].closed_at, s[0].close_reason], [T0 + 2 * MIN, "left"]);
  await BS.note({ session: "s2", rooms: [snap("Room.B")] }, T0 + 20 * MIN);
  s = await spans("Room.B");
  assert.equal(s.length, 2, "a later sync opens a new span");
  assert.equal(s[1].session, "s2");
});

test("a gap of more than 10 minutes closes the span at last_seen + 10 min (timeout) and opens a new one", async () => {
  await BS.note({ session: "s1", rooms: [snap("Room.D")] }, T0);
  await BS.note({ session: "s1", rooms: [snap("Room.D")] }, T0 + 5 * MIN);
  await BS.note({ session: "s1", rooms: [snap("Room.D")] }, T0 + 25 * MIN);
  const s = await spans("Room.D");
  assert.equal(s.length, 2);
  assert.deepEqual([s[0].closed_at, s[0].close_reason, s[0].last_seen], [T0 + 15 * MIN, "timeout", T0 + 5 * MIN]);
  assert.deepEqual([s[1].opened_at, s[1].closed_at], [T0 + 25 * MIN, null]);
});

test("the sweeper closes rooms silent for > 10 min at last_seen + 10 min (in memory and spans left open by a restart)", async () => {
  await BS.note({ session: "s1", rooms: [snap("Room.E")] }, T0);
  await runQuery("INSERT INTO bridge_spans (room_id, session, opened_at, last_seen) VALUES ('Room.Old', 'old', ?, ?)", [T0 - 60 * MIN, T0 - 30 * MIN]);
  await BS.sweep(T0 + 5 * MIN);
  assert.equal((await spans("Room.E"))[0].closed_at, null, "5 min of quiet: still open");
  await BS.sweep(T0 + 11 * MIN);
  const e = (await spans("Room.E"))[0];
  assert.deepEqual([e.closed_at, e.close_reason], [T0 + 10 * MIN, "timeout"]);
  const o = (await spans("Room.Old"))[0];
  assert.deepEqual([o.closed_at, o.close_reason], [T0 - 20 * MIN, "timeout"]);
});

test("switch off: nothing is recorded", async () => {
  await HO.setSettings({ spans: false });
  await BS.note({ session: "s1", rooms: [snap("Room.F")] }, T0);
  assert.equal((await spans("Room.F")).length, 0);
  await HO.setSettings({ spans: true });
});

test("through /api/bridge/sync: the room's span opens; a database error never fails the sync", async () => {
  const sync = (body) => fetch(base + "/api/bridge/sync", { method: "POST", headers: { "content-type": "application/json" },
                                                            body: JSON.stringify({ password: "bot-token", events: [], ...body }) });
  let r = await sync({ session: "live1", rooms: [snap("Room.G")] });
  assert.equal(r.status, 200);
  await BS._settle();
  assert.equal((await spans("Room.G")).length, 1);
  assert.equal((await spans("Room.G"))[0].session, "live1");
  await runQuery("ALTER TABLE bridge_spans RENAME TO bridge_spans_away");
  BS._open.clear();
  const errs = [];
  const orig = console.error;
  console.error = (...a) => { errs.push(a.join(" ")); };
  try {
    r = await sync({ session: "live1", rooms: [snap("Room.H")] });
    await BS._settle();
  } finally { console.error = orig; }
  assert.equal(r.status, 200, "the sync answered normally");
  assert.ok(errs.some((e) => /bridge_spans/.test(e)), "the error was logged");
  await runQuery("ALTER TABLE bridge_spans_away RENAME TO bridge_spans");
});
