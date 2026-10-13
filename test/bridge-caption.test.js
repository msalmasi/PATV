// 1.99xu: Pepe's TTS mic-up showed TWICE on the pad's web chat - his "🔊 <line>" caption (a chat line, tagged
// data.caption = "tts" by the bot) AND the 🎙 transcript line of the same mic-up. bridge.js drops the tagged caption
// while the room has transcripts on; an untagged Pepe line (a soundboard clip caption, a caption posted because the
// line was never heard), someone else's line claiming the tag, and a room with transcripts off keep it.
//   NODE_PATH=G:/PATV/node_modules node --test test/bridge-caption.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-caption-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const { runQuery } = require(path.join(repo, "dbUtils"));
const bridge = require(path.join(repo, "bridge"));
const UL = require(path.join(repo, "userlinks"));

const PEPE = { id: "pepefrog", login: "PepeFrog", display: "PepeFrog", is_self: true };
const ALICE = { id: "alice", login: "alice", display: "Alice" };
let seq = 0;
const ev = (room, type, data) => ({ op: "event", id: "cap-" + (++seq), ts: new Date().toISOString(), type,
                                    scope: { platform: "camfrog", room }, data });
const snap = (room, transcripts) => ({ room, members: [PEPE], mic: [], count: 1, transcripts });

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER)`);
  UL._setQuery(null);
});

async function feed(room, events, transcripts) {
  await bridge.ingest({ events, rooms: [snap(room, transcripts)] });
  const R = bridge.bySlug(bridge.slugify(room.name));
  assert.ok(R, "room exists");
  return (await bridge.liveView(R, 0)).feed;
}

test("transcripts on: the tagged caption is dropped, the transcript line shows the mic-up once", async () => {
  const room = { id: "Cap.Room", name: "Cap Room" };
  const f = await feed(room, [
    ev(room, "message", { user: PEPE, text: "🔊 the vault is open", self: true, caption: "tts" }),
    ev(room, "x.pepe.transcript", { id: "tx-0123456789abcdef", user: PEPE, text: "the vault is open", source: "mic" }),
    ev(room, "message", { user: PEPE, text: "🔊 [airhorn]", self: true }),                         // soundboard caption: untagged
    ev(room, "message", { user: PEPE, text: "an ordinary line", self: true }),
    ev(room, "message", { user: ALICE, text: "🔊 not a caption", caption: "tts" }),                  // not Pepe: ignored tag
  ], true);
  const texts = f.map((it) => it.k + ":" + it.text);
  assert.ok(!texts.includes("msg:🔊 the vault is open"), "the caption is not on the web feed");
  assert.equal(texts.filter((t) => t.includes("the vault is open")).length, 1, "the mic-up shows once");
  assert.ok(texts.includes("tx:the vault is open"), "as its transcript line");
  assert.ok(texts.includes("msg:🔊 [airhorn]"), "an untagged (soundboard) caption stays");
  assert.ok(texts.includes("msg:an ordinary line"), "Pepe's other lines stay");
  assert.ok(texts.includes("msg:🔊 not a caption"), "the tag only counts on Pepe's own line");
  assert.ok(f.every((it) => !("cap" in it)), "no internal marker leaks to the feed");
});

test("transcripts off: the caption is the only text of the mic-up, so it stays", async () => {
  const room = { id: "NoTx.Room", name: "NoTx Room" };
  const f = await feed(room, [ev(room, "message", { user: PEPE, text: "🔊 hello there", self: true, caption: "tts" })], false);
  assert.ok(f.some((it) => it.k === "msg" && it.text === "🔊 hello there"), "caption kept");
});
