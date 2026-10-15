// stageaudio.js — 1.99aay: a stage slot whose stream carries a BROKEN audio track still plays on the site.
//
// What happened (2026-10-15): an OBS stream announced AAC audio but sent no usable audio frames (ffprobe: aac, 0 Hz,
// 0 channels). nginx-rtmp's HLS kept the empty track, and the site's player (video.js VHS) failed "audio append ... failed
// for segment #3" and retried forever - "Stream is starting / reconnecting". A stream with NO audio track at all plays fine,
// and a good one too; only the declared-but-empty case breaks.
//
// So, once per RTMP-ingested slot shortly after it goes live, check() probes its newest HLS segment (ffprobe, ~50 ms).
// Broken audio -> repair: ONE ffmpeg reads the slot from the local RTMP app, copies the video untouched and adds a silent
// AAC track (anullsrc, 64 kbps - next to nothing), publishing "<stream>-a" to the same app (mainstage's local-push gate
// accepts it). hlsOf() then hands out the repaired playlist, so pages (they re-point on their next poll), stage captures
// and Pepe's OBS all play it. The streamer is told once (inbox) to switch their audio on. The repair stops with the slot
// (publish_done / end) and restarts a few times if ffmpeg dies while the slot is still live. Off: STAGE_AUDIO_FIX=off.
"use strict";
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const SUFFIX = "-a";
const PROBE_DELAY_MS = 12 * 1000;      // the first segments exist by then (hls_fragment 1 s; OBS keyframes every 2-8 s)
const PROBE_TRIES = 4;
const RESTARTS = 5;

let deps = {
  hlsDir: () => path.resolve(process.env.STAGECAP_HLS_DIR || ("/mnt/hls" + (process.env.STAGING ? "/staging" : ""))),   // = stagecap.js
  outLocal: () => require("./mainstage").OUT_LOCAL,
  stillLive: async (slotId) => { const s = await require("./mainstage").getSlot(slotId); return !!(s && !s.settled && s.publishing && ["waiting", "active"].includes(s.status)); },
  tell: (s) => require("./rooms").notify(s.userId, { kind: "stage", title: "Your stream's audio isn't coming through",
    body: "We couldn't read any audio from your stream, so viewers get silence for now. In OBS: Settings → Output → Audio (AAC, track 1 ticked) and an unmuted audio source, then restart the stream.",
    link: "/stage", ref: "stageaudio:" + s.id, pm: true }),
  onChange: () => { try { require("./mainstage").clearCache(); } catch (e) { /* older mainstage */ } },
  ffprobe: (file) => new Promise((resolve) => {
    execFile("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_name,sample_rate,channels", "-of", "json", file],
      { timeout: 8000 }, (err, out) => { if (err) return resolve(null); try { resolve(JSON.parse(out)); } catch (e) { resolve(null); } });
  }),
  spawnFix: (args) => spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] }),
};

const FIX = new Map();     // slotId -> {name, proc, restarts, stopped}
const PROBED = new Set();  // slotIds already checked this live run
const enabled = () => String(process.env.STAGE_AUDIO_FIX || "on").toLowerCase() !== "off";

/** The repaired stream name for a slot, or null (hlsOf uses it). */
function fixedName(s) {
  const f = s && FIX.get(s.id);
  return f && !f.stopped ? f.name : null;
}

/** Is a probed audio stream broken? (declared, but no sample rate / channels). No audio stream at all = fine. */
function brokenAudio(j) {
  const a = j && Array.isArray(j.streams) ? j.streams : null;
  if (!a || !a.length) return false;
  return a.some((x) => !(Number(x.sample_rate) > 0) || !(Number(x.channels) > 0));
}

function newestSegment(stream) {
  const dir = deps.hlsDir();
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = f.startsWith(stream + "-") && /^(?:stage|stg)-[0-9a-f]{16}-(\d+)\.ts$/.exec(f);
      if (m && (!best || Number(m[1]) > best.n)) best = { n: Number(m[1]), file: path.join(dir, f) };
    }
  } catch (e) { return null; }
  return best ? best.file : null;
}

/** A slot just went live by RTMP: probe its audio once (a few tries while segments appear) and repair if broken. */
function check(s, { delay = PROBE_DELAY_MS } = {}) {
  if (!enabled() || !s || !s.id || PROBED.has(s.id) || s.source === "library") return;
  PROBED.add(s.id);
  let tries = 0;
  const run = async () => {
    try {
      if (!(await deps.stillLive(s.id))) { PROBED.delete(s.id); return; }
      const file = newestSegment(s.stream);
      if (!file) { if (++tries < PROBE_TRIES) setTimeout(run, delay).unref(); return; }
      const j = await deps.ffprobe(file);
      if (!j) { if (++tries < PROBE_TRIES) setTimeout(run, delay).unref(); return; }
      if (!brokenAudio(j)) return;
      console.log(`[stageaudio] ${s.stream}: audio track declared but empty - repairing with silent audio (${s.stream}${SUFFIX})`);
      start(s);
      Promise.resolve(deps.tell(s)).catch(() => {});
    } catch (e) { console.error("[stageaudio] check:", e.message); }
  };
  setTimeout(run, delay).unref();
}

function fixArgs(s) {
  const base = deps.outLocal();
  return ["-hide_banner", "-nostdin", "-loglevel", "error", "-rw_timeout", "15000000",
    "-i", `${base}/${s.stream}`, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
    "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "64k", "-shortest",
    "-f", "flv", `${base}/${s.stream}${SUFFIX}`];
}

function start(s) {
  let f = FIX.get(s.id);
  if (f && f.proc && !f.stopped) return f;
  f = f || { name: s.stream + SUFFIX, proc: null, restarts: 0, stopped: false };
  f.stopped = false;
  FIX.set(s.id, f);
  const proc = deps.spawnFix(fixArgs(s));
  f.proc = proc;
  let err = "";
  if (proc.stderr) proc.stderr.on("data", (d) => { err = (err + d).slice(-400); });
  proc.on("exit", async (code) => {
    if (f.proc !== proc) return;
    f.proc = null;
    if (f.stopped) return;
    if (f.restarts < RESTARTS && (await deps.stillLive(s.id).catch(() => false))) {
      f.restarts++;
      console.log(`[stageaudio] ${s.stream}: repair exited (${code}) - restart ${f.restarts}/${RESTARTS}${err ? ": " + err.trim().split("\n").pop() : ""}`);
      setTimeout(() => { if (!f.stopped) start(s); }, 3000 * f.restarts).unref();
    } else {
      stop(s.id);
    }
  });
  deps.onChange();
  return f;
}

/** The slot stopped publishing / ended: stop its repair (the next live run probes again). */
function stop(slotId) {
  PROBED.delete(slotId);
  const f = FIX.get(slotId);
  if (!f) return false;
  f.stopped = true;
  FIX.delete(slotId);
  if (f.proc) { try { f.proc.kill("SIGTERM"); } catch (e) { /* gone */ } }
  deps.onChange();
  return true;
}

/** A local push named "<stream>-a" -> the slot's own stream name (mainstage's local-push gate), else null. */
const baseName = (name) => (String(name || "").endsWith(SUFFIX) ? String(name).slice(0, -SUFFIX.length) : null);

module.exports = { check, start, stop, fixedName, brokenAudio, baseName, fixArgs, SUFFIX, enabled,
  _setDeps: (d) => { deps = Object.assign({}, deps, d || {}); }, _fix: FIX, _probed: PROBED };
