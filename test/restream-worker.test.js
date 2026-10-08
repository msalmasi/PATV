// Offline tests for the relay worker's supervisor (deploy/restream/patv-restream.js, 1.99fk) with a FAKE ffmpeg:
// start / stop / destination change, restart with backoff, the stall watchdog, progress parsing, target rules,
// and that no URL or key ever reaches the log or the status.
//   node --test test/restream-worker.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");
const W = require(path.resolve(__dirname, "..", "deploy", "restream", "patv-restream.js"));

const KEY = "live_123456789_SecretSecretSecret";
const SRC = "rtmp://127.0.0.1/live/broadcast";
const TGT = "rtmp://live-jfk.twitch.tv/app/" + KEY;

function harness(o = {}) {
  let T = 1_000_000;
  const procs = [];
  const logs = [];
  const sup = new W.Supervisor({
    now: () => T, log: (m) => logs.push(m), allowTargets: o.allow || "twitch",
    spawn: (args) => {
      const p = new EventEmitter();
      p.args = args; p.stdout = new PassThrough(); p.stderr = new PassThrough(); p.killed = null;
      p.kill = (sig) => { p.killed = sig; setImmediate(() => p.emit("exit", null, sig)); };
      procs.push(p);
      return p;
    },
  });
  return { sup, procs, logs, adv: (ms) => { T += ms; }, now: () => T };
}
const tick = () => new Promise((r) => setImmediate(r));
function progress(p, frame, kbps) {
  p.stdout.write(`frame=${frame}\nfps=30.0\nbitrate=${kbps}kbits/s\ntotal_size=1\nprogress=continue\n`);
}

test("args: loopback source, copy only, progress on stdout, flv to the target", () => {
  const a = W.ffmpegArgs(SRC, TGT);
  assert.ok(a.includes("copy") && !a.includes("libx264"), "no re-encode");
  assert.equal(a[a.indexOf("-i") + 1], SRC);
  assert.equal(a[a.length - 1], TGT);
  assert.equal(a[a.indexOf("-progress") + 1], "pipe:1");
  assert.equal(a[a.indexOf("-f") + 1], "flv");
});

test("targets: twitch only by default, loopback mode for staging; sources must be loopback rtmp", () => {
  assert.equal(W.allowed(TGT, "twitch"), true);
  assert.equal(W.allowed("rtmps://lhr03.contribute.live-video.net/app/x", "twitch"), true);
  assert.equal(W.allowed("rtmp://evil.example/app/x", "twitch"), false);
  assert.equal(W.allowed("rtmp://127.0.0.1:19350/sink/x", "twitch"), false);
  assert.equal(W.allowed("rtmp://127.0.0.1:19350/sink/x", "loopback"), true);
  assert.equal(W.allowed(TGT, "loopback"), false, "staging can never reach Twitch");
  assert.equal(W.allowed("file:///etc/passwd", "any"), false);
  assert.equal(W.allowedSource(SRC), true);
  assert.equal(W.allowedSource("rtmp://1.2.3.4/live/x"), false);
  assert.equal(W.allowedSource("file:///etc/passwd"), false);
});

test("redact: URLs and keys never survive", () => {
  const line = `[flv @ 0x1] Failed to connect to ${TGT}: I/O error (key ${KEY})`;
  const r = W.redact(line, [KEY]);
  assert.ok(!r.includes(KEY) && !r.includes("twitch.tv"), r);
  assert.match(W.redact("live_998877665_abcdefABCDEF"), /<key>/);
});

test("start -> live on progress -> stop when no longer wanted", async () => {
  const h = harness();
  h.sup.sync([{ id: "main", source: SRC, target: TGT }]);
  assert.equal(h.procs.length, 1);
  assert.equal(h.sup.status().main.state, "starting");
  progress(h.procs[0], 0, "N/A"); await tick();
  assert.equal(h.sup.status().main.state, "starting", "no frames yet");
  progress(h.procs[0], 120, "5980.5"); await tick();
  const st = h.sup.status().main;
  assert.equal(st.state, "live"); assert.equal(st.frames, 120); assert.equal(st.kbps, 5980.5);
  h.sup.sync([{ id: "main", source: SRC, target: TGT }]);
  assert.equal(h.procs.length, 1, "already running: nothing new");
  h.sup.sync([]);
  assert.equal(h.procs[0].killed, "SIGINT", "clean stop (RTMP close)");
  assert.deepEqual(h.sup.status(), {});
  await tick();
  assert.equal(h.procs.length, 1, "no restart after a wanted stop");
});

test("exit while wanted: error + restart with doubling backoff, reset after a stable run", async () => {
  const h = harness();
  const want = [{ id: "slot:1", source: SRC, target: TGT }];
  h.sup.sync(want);
  h.procs[0].stderr.write(`Failed to update header with correct duration.\n[rtmp @ 0x1] Server error: ${TGT}\n`);
  await tick();
  h.procs[0].emit("exit", 1, null);
  let st = h.sup.status()["slot:1"];
  assert.equal(st.state, "error"); assert.equal(st.restarts, 1);
  assert.match(st.detail, /exited \(code 1\)/);
  h.sup.sync(want);
  assert.equal(h.procs.length, 1, "waits out the backoff (2 s)");
  h.adv(W.BACKOFF_MIN); h.sup.sync(want);
  assert.equal(h.procs.length, 2, "restarted");
  h.procs[1].emit("exit", 1, null);
  h.adv(W.BACKOFF_MIN); h.sup.sync(want);
  assert.equal(h.procs.length, 2, "second backoff is 4 s");
  h.adv(W.BACKOFF_MIN); h.sup.sync(want);
  assert.equal(h.procs.length, 3);
  // a long clean run resets the backoff
  progress(h.procs[2], 10, "6000"); await tick();
  for (let i = 0; i < 25; i++) { h.adv(3000); progress(h.procs[2], 20 + i * 90, "6000"); await tick(); h.sup.sync(want); }
  h.procs[2].emit("exit", 0, null);
  h.adv(W.BACKOFF_MIN); h.sup.sync(want);
  assert.equal(h.procs.length, 4, "backoff back to 2 s after a stable run");
  // nothing secret anywhere
  const all = h.logs.join("\n") + JSON.stringify(h.sup.status());
  assert.ok(!all.includes(KEY) && !all.includes("twitch.tv"), "no key / URL in logs or status");
});

test("watchdog: no first frames in the grace period, or frames that stop moving -> kill + restart", async () => {
  const h = harness();
  const want = [{ id: "main", source: SRC, target: TGT }];
  h.sup.sync(want);
  h.adv(W.START_GRACE_MS + 1000); h.sup.sync(want);
  assert.equal(h.procs[0].killed, "SIGKILL");
  assert.match(h.sup.status().main.detail, /no frames within/);
  h.adv(W.BACKOFF_MIN); h.sup.sync(want);
  assert.equal(h.procs.length, 2);
  progress(h.procs[1], 50, "6000"); await tick();
  assert.equal(h.sup.status().main.state, "live");
  progress(h.procs[1], 50, "6000"); await tick();      // frame counter stuck
  h.adv(W.STALL_MS + 1000); h.sup.sync(want);
  assert.equal(h.procs[1].killed, "SIGKILL");
  assert.match(h.sup.status().main.detail, /stalled/);
});

test("a changed destination restarts the relay; refused targets never spawn", async () => {
  const h = harness();
  h.sup.sync([{ id: "main", source: SRC, target: TGT }]);
  h.sup.sync([{ id: "main", source: SRC, target: TGT.replace("live-jfk", "live-iad") }]);
  assert.equal(h.procs[0].killed, "SIGINT");
  assert.equal(h.procs.length, 2);
  assert.equal(h.procs[1].args[h.procs[1].args.length - 1], TGT.replace("live-jfk", "live-iad"));
  const h2 = harness();
  h2.sup.sync([{ id: "x", source: SRC, target: "rtmp://evil.example/app/" + KEY }, { id: "y", source: "rtmp://8.8.8.8/live/a", target: TGT }]);
  assert.equal(h2.procs.length, 0);
  assert.ok(!h2.logs.join("\n").includes(KEY));
});
