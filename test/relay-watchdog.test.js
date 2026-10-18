// 1.99aai deploy/webrtc/pepe-relay-watchdog.sh: replays the 2026-10-14 broken HLS (0.000/0.021 s segments, a
// DISCONTINUITY on each, nginx "force fragment split" flood) and a healthy one, with the process side stubbed
// (WD_PID / WD_UP / WD_NOW / WD_KILL / WD_ALERT). Needs bash + GNU date/stat (Linux CI, Git Bash); skipped otherwise.
//   node --test test/relay-watchdog.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SCRIPT = path.resolve(__dirname, "..", "deploy", "webrtc", "pepe-relay-watchdog.sh");
const hasBash = spawnSync("bash", ["-c", "date -d @0 +%Y >/dev/null && stat -c %Y / >/dev/null"], { stdio: "ignore", timeout: 10000 }).status === 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-wd-"));
const P = (f) => path.join(dir, f).replace(/\\/g, "/");
const T0 = Math.floor(Date.parse("2026-10-14T23:00:00-04:00") / 1000);

function stamp(t) {   // nginx error-log time, local clock (the script formats its cutoff the same way)
  const r = spawnSync("bash", ["-c", `date -d @${t} '+%Y/%m/%d %H:%M:%S'`], { encoding: "utf8", input: "", timeout: 10000 });
  return r.stdout.trim();
}
function playlist(bad) {
  let s = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-TARGETDURATION:2\n";
  for (let i = 0; i < 10; i++) s += bad ? `#EXT-X-DISCONTINUITY\n#EXTINF:${i % 2 ? "0.021" : "0.000"},\nb-${i}.ts\n` : `#EXTINF:2.000,\nb-${i}.ts\n`;
  return s;
}
function scene({ bad, splits = 0, now, ageS = 2 }) {
  fs.writeFileSync(P("broadcast.m3u8"), playlist(bad));
  spawnSync("bash", ["-c", `touch -d @${now - ageS} '${P("broadcast.m3u8")}'`], { input: "", timeout: 10000 });
  let log = `${stamp(now - 300)} [error] 1#1: *1 hls: force fragment split: 50.0 sec, , client: 127.0.0.1\n`;
  const st = splits ? stamp(now - 5) : "";
  for (let i = 0; i < splits; i++) log += `${st} [error] 701043#701043: *24544499 hls: force fragment split: ${i % 2 ? "-" : ""}29140.2 sec, , client: 127.0.0.1, server: 0.0.0.0:1935\n`;
  fs.writeFileSync(P("error.log"), log);
}
function run(now, extra = {}) {
  const env = { ...process.env, HLS: P("broadcast.m3u8"), NGINX_ERR: P("error.log"), STATE: P("state"), WD_PID: "4242", WD_UP: "3600", WD_NOW: String(now),
                WD_KILL: P("killed"), WD_ALERT: P("alerts"), ...extra };
  const r = spawnSync("bash", [SCRIPT], { env, encoding: "utf8", input: "", timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const lines = (f) => (fs.existsSync(P(f)) ? fs.readFileSync(P(f), "utf8").trim().split("\n").filter(Boolean) : []);
const reset = () => ["state", "killed", "alerts"].forEach((f) => fs.rmSync(P(f), { force: true }));

test("healthy stream: nothing happens", { skip: !hasBash }, () => {
  reset();
  scene({ bad: false, now: T0 });
  run(T0); run(T0 + 20);
  assert.deepEqual(lines("killed"), []);
  assert.deepEqual(lines("alerts"), []);
});

test("the 2026-10-14 failure: two bad checks -> one restart + alert, then 'healthy again'", { skip: !hasBash }, () => {
  reset();
  scene({ bad: true, splits: 500, now: T0 });
  const o1 = run(T0);
  assert.match(o1, /bad check 1\/2/);
  assert.match(o1, /forced 500 HLS fragment splits/);
  assert.match(o1, /10 of 10 HLS segments shorter/);
  assert.match(o1, /DISCONTINUITY marks/);
  assert.deepEqual(lines("killed"), []);
  scene({ bad: true, splits: 500, now: T0 + 20 });
  assert.match(run(T0 + 20), /restarting the relay ffmpeg \(pid 4242\)/);
  assert.deepEqual(lines("killed"), ["4242"]);
  assert.equal(lines("alerts").length, 1);
  assert.match(lines("alerts")[0], /^restart-\d+\tPepe's stream relay restarted/);
  // a fresh relay (up < MIN_UP) is left alone
  assert.equal(run(T0 + 40, { WD_PID: "5000", WD_UP: "20" }), "");
  scene({ bad: false, now: T0 + 120 });
  assert.match(run(T0 + 120, { WD_PID: "5000", WD_UP: "100" }), /healthy again/);
  assert.equal(lines("alerts").length, 2);
  assert.match(lines("alerts")[1], /^ok-/);
});

test("backoff: a relay that keeps breaking is restarted at 60 s, then 120 s, ... not every check", { skip: !hasBash }, () => {
  reset();
  let t = T0;
  const bad = () => { scene({ bad: true, splits: 500, now: t }); return run(t); };
  bad(); t += 20; bad();                                   // restart #1 at T0+20
  assert.equal(lines("killed").length, 1);
  t += 20; bad(); t += 20;
  assert.match(bad(), /held by backoff \(60 s\)/);          // T0+60: 40 s after - held
  t += 20; bad();                                          // T0+80: 60 s after -> restart #2, backoff -> 120
  assert.equal(lines("killed").length, 2);
  t += 20; bad(); t += 20; bad(); t += 20; bad(); t += 20;
  assert.match(bad(), /held by backoff \(120 s\)/);
  assert.equal(lines("killed").length, 2);
});

test("stale playlist counts as bad; no relay running = nothing to do", { skip: !hasBash }, () => {
  reset();
  scene({ bad: false, now: T0, ageS: 120 });
  assert.match(run(T0), /not updated for 120 s/);
  reset();
  scene({ bad: true, splits: 500, now: T0 });
  assert.equal(run(T0, { WD_PID: "" }), "");
  assert.equal(run(T0 + 20, { WD_PID: "" }), "");
  assert.deepEqual(lines("killed"), []);
});

test("DRY_RUN logs instead of restarting", { skip: !hasBash }, () => {
  reset();
  scene({ bad: true, splits: 500, now: T0 });
  run(T0, { DRY_RUN: "1" });
  assert.match(run(T0 + 20, { DRY_RUN: "1" }), /\(dry run\) would restart relay pid 4242/);
  assert.deepEqual(lines("killed"), []);
});

// 1.99acf: with OPS_PATV_KEY in the site's .env the alert sends it as X-PATV-Key - from a pipe (curl -H @file), never on the
// command line - and keeps the bot token in the body as the fallback. A fake curl first on PATH records what it was given.
const hasPy = hasBash && spawnSync("bash", ["-c", "python3 -c 'print(1)'"], { stdio: "ignore", timeout: 20000 }).status === 0;
test("1.99acf: the alert carries OPS_PATV_KEY as X-PATV-Key through a header file, never argv; the token stays in the body", { skip: !hasPy }, () => {
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin", "curl"), [
    "#!/usr/bin/env bash",
    'out="$FAKE_CURL_LOG"',
    "while [ $# -gt 0 ]; do",
    '  case "$1" in',
    '    -H) shift; if [ "${1#@}" != "$1" ]; then echo "HFILE:$(cat "${1#@}")" >> "$out"; else echo "H:$1" >> "$out"; fi ;;',
    '    --data-binary) shift; echo "BODY:$(cat)" >> "$out" ;;',
    "    -m) shift ;;",
    "    -s) ;;",
    '    *) echo "ARG:$1" >> "$out" ;;',
    "  esac",
    "  shift",
    "done",
    "echo '{\"ok\":true}'",
    "",
  ].join("\n"), { mode: 0o755 });
  const envFile = P("site.env");
  const log = P("curl.log");
  const binPath = P("bin").replace(/^([A-Za-z]):/, (m, d) => "/" + d.toLowerCase());     // a Git Bash path on Windows
  const go = (envText) => {
    reset();
    fs.rmSync(log, { force: true });
    fs.writeFileSync(envFile, envText);
    const sh = (now) => spawnSync("bash", ["-c", `export PATH="${binPath}:$PATH"; exec bash "$0"`, SCRIPT], {
      env: { ...process.env, HLS: P("broadcast.m3u8"), NGINX_ERR: P("error.log"), STATE: P("state"), WD_PID: "4242", WD_UP: "3600",
             WD_NOW: String(now), WD_KILL: P("killed"), WD_ALERT: "", SITE_ENV: envFile, SITE: "http://127.0.0.1:9", FAKE_CURL_LOG: log },
      encoding: "utf8", input: "", timeout: 30000 });
    scene({ bad: true, splits: 500, now: T0 });
    sh(T0);
    scene({ bad: true, splits: 500, now: T0 + 20 });
    const r = sh(T0 + 20);
    return { out: r.stdout + r.stderr, log: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "" };
  };
  let r = go('TWITCH_BOT_TOKEN=tok-secret-1\nOPS_PATV_KEY="ops.KEYSECRETKEYSECRETKEYSECRETKEYSECRETKEYSEC"\n');
  assert.match(r.out, /alert sent/, r.out);
  assert.match(r.log, /^HFILE:X-PATV-Key: ops\.KEYSECRETKEYSECRETKEYSECRETKEYSECRETKEYSEC$/m, "the key, from a header file: " + r.log);
  const args = r.log.split("\n").filter((l) => l.startsWith("ARG:") || l.startsWith("H:")).join("\n");
  assert.ok(!args.includes("KEYSECRET") && !args.includes("tok-secret-1"), "neither secret on the command line: " + args);
  assert.equal(JSON.parse(r.log.match(/^BODY:(.*)$/m)[1]).password, "tok-secret-1", "the token stays in the body (fallback)");
  r = go("TWITCH_BOT_TOKEN=tok-secret-1\n");
  assert.match(r.out, /alert sent/);
  assert.ok(!/HFILE:/.test(r.log), "no key configured: no X-PATV-Key header");
  r = go("SOMETHING_ELSE=1\n");
  assert.match(r.out, /alert not sent: no bot token/);
});
