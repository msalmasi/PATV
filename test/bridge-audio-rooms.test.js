// 1.99ia: room audio per room. With Pepe's net_audio every bridged room with its audio switched on streams its
// own audio: the sync reports `audio` per room, /api/bridge/audio and /p/<slug>/audio keep one hub per room,
// and a room whose switch is on but can't stream (loopback mode: only the audio room) says why.
//   NODE_PATH=G:/PATV/node_modules node --test test/bridge-audio-rooms.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-audio-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const bridge = require(path.join(repo, "bridge"));

const LOOPBACK_WHY = "loopback mode streams only the audio room (Alpha.Room) - !netaudio on streams every room";

/** The first chunk a listener receives, then hang up. */
async function firstChunk(url, headers) {
  const ac = new AbortController();
  const r = await fetch(url, { headers, signal: ac.signal });
  if (r.status !== 200) { ac.abort(); return { status: r.status }; }
  const rd = r.body.getReader();
  const x = await Promise.race([rd.read(), new Promise((res) => setTimeout(() => res({ timeout: true }), 3000))]);
  ac.abort();
  return { status: 200, bytes: x && x.value ? Buffer.from(x.value) : null };
}

test("net_audio: two rooms stream at once, each to its own listeners; a room that can't stream says why", async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT)`);
  await runQuery("INSERT OR IGNORE INTO users (userId, username, displayname, password) VALUES ('u1', 'lis', 'lis', 'x')");
  await new Promise((r) => setTimeout(r, 150));
  const app = express();
  app.use((req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u, username: u } : null; next(); });
  bridge.register(app, { isBotToken: (t) => t === "bot-token", addUser: (req, res, next) => next() });
  const server = app.listen(0);
  const base = "http://127.0.0.1:" + server.address().port;
  const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(Object.assign({ password: "bot-token" }, body)) }).then((r) => r.json());
  const room = (id, name, a) => Object.assign({ room: { id, name }, topic: "", members: [{ login: "bob", display: "Bob" }], count: 2 }, a);
  try {
    // both rooms streaming (net_audio)
    await post("/api/bridge/sync", { events: [], rooms: [room("Alpha.Room", "Alpha", { audio: true, audio_on: true }),
                                                        room("Beta.Room", "Beta", { audio: true, audio_on: true })] });
    const live = async (slug) => (await fetch(base + "/api/rooms/" + slug + "/live", { headers: { "x-test-user": "u1" } })).json();
    assert.equal((await live("alpha")).room.audio, true);
    assert.equal((await live("beta")).room.audio, true);
    // one listener on each pad
    const H = { "x-test-user": "u1" };
    const la = firstChunk(base + "/p/alpha/audio", H);
    const lb = firstChunk(base + "/p/beta/audio", H);
    await new Promise((r) => setTimeout(r, 150));
    const ra = await post("/api/bridge/audio", { room: "Alpha.Room", seq: 1, data: Buffer.from("AAAA").toString("base64") });
    const rb = await post("/api/bridge/audio", { room: "Beta.Room", seq: 1, data: Buffer.from("BBBB").toString("base64") });
    assert.equal(ra.listeners, 1, "Alpha's post reaches Alpha's listener");
    assert.equal(rb.listeners, 1, "Beta's post reaches Beta's listener");
    const [ca, cb] = await Promise.all([la, lb]);
    assert.equal(String(ca.bytes), "AAAA", "Alpha's listener hears Alpha only");
    assert.equal(String(cb.bytes), "BBBB", "Beta's listener hears Beta only");

    // loopback mode: Beta's switch is on but it can't stream - reported off, with the reason
    await post("/api/bridge/sync", { events: [], rooms: [room("Alpha.Room", "Alpha", { audio: true, audio_on: true }),
                                                        room("Beta.Room", "Beta", { audio: false, audio_on: true, audio_why: LOOPBACK_WHY })] });
    const vb = await live("beta");
    assert.equal(vb.room.audio, false);
    assert.match(vb.room.audioWhy, /loopback mode streams only the audio room/);
    assert.equal((await live("alpha")).room.audioWhy, "", "a streaming room has no reason");
    assert.equal((await post("/api/bridge/audio", { room: "Beta.Room", seq: 2, data: "" })).listeners, 0, "Beta's heartbeat: off");
    assert.equal((await firstChunk(base + "/p/beta/audio", H)).status, 404, "nobody can tune in to Beta");
    // the pad's switch follows audio_on (not "streaming now")
    const B = bridge._rooms.get("Beta.Room");
    assert.equal(B.audioOn, true);
    assert.equal(B.audio, false);
    // an older Pepe (no audio_on): the switch follows `audio`
    await post("/api/bridge/sync", { events: [], rooms: [room("Beta.Room", "Beta", { audio: false })] });
    assert.equal(bridge._rooms.get("Beta.Room").audioOn, false);
    assert.equal(bridge._rooms.get("Beta.Room").audioWhy, "");
  } finally { server.close(); }
});

test("pad settings: the audio switch shows the room's toggle, and the reason it isn't streaming", async () => {
  const src = fs.readFileSync(path.join(repo, "padsettings.js"), "utf8");
  assert.match(src, /audio: B\.audioOn != null \? !!B\.audioOn : !!B\.audio/);
  assert.match(src, /audioLive: !!B\.audio, audioWhy: B\.audioWhy \|\| ""/);
  const ejs = fs.readFileSync(path.join(repo, "views", "padSettings.ejs"), "utf8");
  assert.match(ejs, /bridge\.audio && !bridge\.audioLive/);
  assert.match(ejs, /isn't streaming right now<%= bridge\.audioWhy/);
});
