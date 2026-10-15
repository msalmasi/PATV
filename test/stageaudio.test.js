// stageaudio.js (1.99aay): a slot whose audio track is declared but empty gets a repaired copy (video copied + silent AAC);
// hlsOf hands the repaired playlist out until the slot stops; healthy audio / no audio track are left alone.
//   node --test test/stageaudio.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const A = require(path.join(__dirname, "..", "stageaudio"));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stageaudio-"));
let probe = null, live = true, spawned = [], told = [], changes = 0;
function fakeProc() { const p = new EventEmitter(); p.stderr = new EventEmitter(); p.killed = false; p.kill = () => { p.killed = true; }; return p; }
A._setDeps({
  hlsDir: () => dir,
  outLocal: () => "rtmp://127.0.0.1/live",
  stillLive: async () => live,
  tell: async (s) => { told.push(s.id); },
  onChange: () => { changes++; },
  ffprobe: async () => probe,
  spawnFix: (args) => { const p = fakeProc(); spawned.push({ args, p }); return p; },
});
const slot = (id, stream) => ({ id, stream, userId: "u1", source: null });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (const n of [1, 2, 3]) fs.writeFileSync(path.join(dir, `stage-00000000000000a1-${n}.ts`), "x");
fs.writeFileSync(path.join(dir, "stage-00000000000000b2-1.ts"), "x");

test("brokenAudio: declared-but-empty only", () => {
  assert.equal(A.brokenAudio({ streams: [{ codec_name: "aac", sample_rate: "0", channels: 0 }] }), true);
  assert.equal(A.brokenAudio({ streams: [{ codec_name: "aac", sample_rate: "48000", channels: 2 }] }), false);
  assert.equal(A.brokenAudio({ streams: [] }), false, "no audio track at all plays fine");
  assert.equal(A.brokenAudio(null), false);
});

test("a broken slot is repaired once; the copy is what's played; it stops with the slot", async () => {
  probe = { streams: [{ codec_name: "aac", sample_rate: "0", channels: 0 }] };
  const s = slot("s1", "stage-00000000000000a1");
  A.check(s, { delay: 5 });
  A.check(s, { delay: 5 });                       // a second publish callback: probed once
  await wait(40);
  assert.equal(spawned.length, 1);
  const args = spawned[0].args.join(" ");
  assert.match(args, /-i rtmp:\/\/127\.0\.0\.1\/live\/stage-00000000000000a1 /);
  assert.match(args, /anullsrc/);
  assert.match(args, /-c:v copy/);
  assert.match(args, /rtmp:\/\/127\.0\.0\.1\/live\/stage-00000000000000a1-a$/);
  assert.equal(A.fixedName(s), "stage-00000000000000a1-a");
  assert.deepEqual(told, ["s1"], "the streamer is told once");
  assert.equal(A.baseName("stage-00000000000000a1-a"), "stage-00000000000000a1");
  assert.equal(A.baseName("stage-00000000000000a1"), null);
  // ffmpeg dies while the slot is live: restarted
  spawned[0].p.emit("exit", 1);
  await wait(3200);
  assert.equal(spawned.length, 2);
  assert.equal(A.stop("s1"), true);
  assert.equal(spawned[1].p.killed, true);
  assert.equal(A.fixedName(s), null, "back to the slot's own playlist");
  assert.ok(changes >= 2, "the public slot cache is cleared on start and stop");
});

test("healthy audio is left alone; library plays are never probed", async () => {
  spawned = []; told = [];
  probe = { streams: [{ codec_name: "aac", sample_rate: "48000", channels: 2 }] };
  A.check(slot("s2", "stage-00000000000000b2"), { delay: 5 });
  A.check({ ...slot("s3", "stage-00000000000000b2"), source: "library" }, { delay: 5 });
  await wait(40);
  assert.equal(spawned.length, 0);
  assert.equal(told.length, 0);
});

test("STAGE_AUDIO_FIX=off turns it off", async () => {
  spawned = [];
  process.env.STAGE_AUDIO_FIX = "off";
  probe = { streams: [{ codec_name: "aac", sample_rate: "0", channels: 0 }] };
  A.check(slot("s4", "stage-00000000000000a1"), { delay: 5 });
  await wait(30);
  delete process.env.STAGE_AUDIO_FIX;
  assert.equal(spawned.length, 0);
});
