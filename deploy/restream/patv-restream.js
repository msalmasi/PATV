#!/usr/bin/env node
// deploy/restream/patv-restream.js - PATV 1.99fk: the "Also stream to Twitch" relay worker.
//
// Runs as systemd patv-restream@<inst> (user patv-restream, see patv-restream@.service / install.sh). Every
// SYNC_MS it POSTs what it runs to the site's loopback API (/api/restream/worker/sync, token in X-Restream-Token)
// and gets back the relays it should run: [{id, source, target}]. One ffmpeg per relay:
//     ffmpeg -i <source: rtmp://127.0.0.1/...> -c copy -f flv <target: Twitch ingest/<key>>
// (copy only - no re-encode). A relay that exits while still wanted is restarted with backoff (2 s doubling to
// 60 s, reset after 60 s of clean running); one whose frame counter stalls for STALL_MS is killed and restarted.
// Site unreachable: what runs keeps running for HOLD_MS (a site restart doesn't cut Twitch), then everything stops.
//
// Secrets: the target URL (it holds the stream key) is passed to ffmpeg as an argument - visible in /proc to root and
// to the patv-restream user only on this box (hidepid isn't on; the URL is in the process list) - and NEVER logged:
// ffmpeg's messages and our own lines go through redact(), which blanks every rtmp(s):// URL and the key itself.
// Config (environment, from /etc/patv-restream/<inst>.env):
//   SITE_URL=http://127.0.0.1:3000   RESTREAM_TOKEN=<shared token>   FFMPEG=ffmpeg   ALLOW_TARGETS=twitch|loopback|any
// No npm dependencies (runs on the system Node).
"use strict";
const http = require("http");
const { spawn } = require("child_process");

const VERSION = "1.99fl";
const SYNC_MS = 3000;
const HOLD_MS = 60 * 1000;
const STALL_MS = 25 * 1000;
const START_GRACE_MS = 30 * 1000;      // a fresh ffmpeg gets this long to produce its first frames
const BACKOFF_MIN = 2000, BACKOFF_MAX = 60 * 1000, STABLE_MS = 60 * 1000;

/** Blank URLs and anything key-like in a log line. */
function redact(line, secrets = []) {
  let s = String(line == null ? "" : line);
  for (const k of secrets) if (k && k.length >= 4) s = s.split(k).join("<key>");
  return s.replace(/rtmps?:\/\/[^\s'"]+/gi, "<url>").replace(/live_[A-Za-z0-9_]{6,}/g, "<key>");
}
function keyOf(target) {
  const i = String(target).lastIndexOf("/");
  return i >= 0 ? String(target).slice(i + 1) : "";
}
function allowed(target, mode) {
  let u;
  try { u = new URL(target); } catch (e) { return false; }
  if (!/^rtmps?:$/.test(u.protocol)) return false;
  const loop = /^(127\.0\.0\.1|localhost)$/i.test(u.hostname);
  const twitch = /^([a-z0-9-]+\.)*(twitch\.tv|contribute\.live-video\.net)$/i.test(u.hostname);
  if (mode === "loopback") return loop;
  if (mode === "any") return true;
  return twitch;              // "twitch" (default)
}
function allowedSource(source) {
  try { const u = new URL(source); return u.protocol === "rtmp:" && /^(127\.0\.0\.1|localhost)$/i.test(u.hostname); } catch (e) { return false; }
}
function ffmpegArgs(source, target) {
  return ["-hide_banner", "-nostdin", "-loglevel", "warning", "-nostats",
          "-rtmp_live", "live", "-i", source,
          "-map", "0:v:0?", "-map", "0:a:0?", "-c", "copy",
          "-progress", "pipe:1",
          "-f", "flv", "-flvflags", "no_duration_filesize", target];
}

class Supervisor {
  constructor(o = {}) {
    this.spawn = o.spawn || ((args) => spawn(o.ffmpeg || "ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] }));
    this.now = o.now || (() => Date.now());
    this.log = o.log || ((m) => console.log(m));
    this.allowTargets = o.allowTargets || "twitch";
    this.relays = new Map();   // id -> relay
  }
  /** desired = [{id, source, target}] -> start / stop / restart so exactly those run. */
  sync(desired) {
    const t = this.now();
    const want = new Map();
    for (const d of desired || []) {
      if (!d || !d.id || !d.source || !d.target) continue;
      if (!allowedSource(d.source)) { this.log(`[${d.id}] refused: source must be loopback rtmp`); continue; }
      if (!allowed(d.target, this.allowTargets)) { this.log(`[${d.id}] refused: target not allowed (${this.allowTargets})`); continue; }
      want.set(String(d.id), d);
    }
    for (const [id, r] of this.relays) {
      const d = want.get(id);
      if (!d) { this.stop(id, "not wanted"); continue; }
      if (d.source !== r.source || d.target !== r.target) { this.stop(id, "destination changed"); }
    }
    for (const [id, d] of want) {
      let r = this.relays.get(id);
      if (!r) { r = this.newRelay(d); this.relays.set(id, r); }
      if (!r.proc && t >= r.retryAt) this.start(r);
    }
    this.watchdog(t);
  }
  newRelay(d) {
    return { id: String(d.id), source: d.source, target: d.target, key: keyOf(d.target), proc: null, state: "starting",
             detail: null, retryAt: 0, backoff: BACKOFF_MIN, restarts: 0, startedAt: 0, frames: 0, framesAt: 0,
             kbps: null, fps: null, lastErr: null, progress: {} };
  }
  start(r) {
    const t = this.now();
    r.state = "starting"; r.detail = r.restarts ? r.detail : null; r.startedAt = t; r.frames = 0; r.framesAt = t; r.kbps = null; r.fps = null; r.progress = {};
    r.lastErr = null;
    let proc;
    try { proc = this.spawn(ffmpegArgs(r.source, r.target)); } catch (e) { this.failed(r, "ffmpeg didn't start: " + (e.code || e.message)); return; }
    r.proc = proc;
    this.log(`[${r.id}] start (attempt ${r.restarts + 1})`);
    let buf = "";
    if (proc.stdout) proc.stdout.on("data", (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { this.onProgress(r, buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
      if (buf.length > 8192) buf = "";
    });
    let ebuf = "";
    if (proc.stderr) proc.stderr.on("data", (d) => {
      ebuf += String(d);
      let i;
      while ((i = ebuf.indexOf("\n")) >= 0) {
        const line = redact(ebuf.slice(0, i).trim(), [r.key]).slice(0, 300);
        ebuf = ebuf.slice(i + 1);
        if (!line) continue;
        r.lastErr = line;
        this.log(`[${r.id}] ffmpeg: ${line}`);
      }
      if (ebuf.length > 8192) ebuf = "";
    });
    proc.on("error", (e) => { if (r.proc === proc) { r.proc = null; this.failed(r, "ffmpeg didn't start: " + (e.code || e.message)); } });
    proc.on("exit", (code, sig) => {
      if (r.proc !== proc) return;
      r.proc = null;
      if (r.stopping) return;
      const ran = this.now() - r.startedAt;
      if (ran >= STABLE_MS) r.backoff = BACKOFF_MIN;
      this.failed(r, `ffmpeg exited (${sig || "code " + code})${r.lastErr ? ": " + r.lastErr : ""}`);
    });
  }
  failed(r, why) {
    r.state = "error";
    r.detail = redact(why, [r.key]).slice(0, 200);
    r.restarts++;
    r.retryAt = this.now() + r.backoff;
    this.log(`[${r.id}] ${r.detail} - retry in ${Math.round(r.backoff / 1000)} s`);
    r.backoff = Math.min(BACKOFF_MAX, r.backoff * 2);
  }
  onProgress(r, line) {
    const eq = line.indexOf("=");
    if (eq < 0) return;
    const k = line.slice(0, eq).trim(), v = line.slice(eq + 1).trim();
    r.progress[k] = v;
    if (k !== "progress") return;
    // one block done
    const p = r.progress;
    const frames = Number(p.frame);
    const t = this.now();
    if (Number.isFinite(frames) && frames > r.frames) { r.frames = frames; r.framesAt = t; }
    const fps = Number(p.fps); r.fps = Number.isFinite(fps) ? fps : r.fps;
    const m = /([\d.]+)\s*kbits\/s/.exec(p.bitrate || "");
    if (m) r.kbps = Number(m[1]);
    if (r.frames > 0 && r.state !== "live") { r.state = "live"; r.detail = null; this.log(`[${r.id}] live`); }
    if (v === "end") this.log(`[${r.id}] ffmpeg reported end of stream`);
    r.progress = {};
  }
  watchdog(t = this.now()) {
    for (const r of this.relays.values()) {
      if (!r.proc || r.stopping) continue;
      const quiet = t - r.framesAt;
      const limit = r.frames > 0 ? STALL_MS : START_GRACE_MS;
      if (quiet > limit) {
        this.log(`[${r.id}] no frames for ${Math.round(quiet / 1000)} s - restarting`);
        const p = r.proc;
        r.proc = null;
        try { p.kill("SIGKILL"); } catch (e) { /* gone */ }
        this.failed(r, r.frames > 0 ? "stalled (no frames moving)" : `no frames within ${Math.round(limit / 1000)} s${r.lastErr ? ": " + r.lastErr : ""}`);
      }
    }
  }
  stop(id, why) {
    const r = this.relays.get(id);
    if (!r) return false;
    this.relays.delete(id);
    if (r.proc) {
      r.stopping = true;
      const p = r.proc;
      r.proc = null;
      this.log(`[${id}] stop (${why})`);
      try { p.kill("SIGINT"); } catch (e) { /* gone */ }
      const k = setTimeout(() => { try { p.kill("SIGKILL"); } catch (e) { /* gone */ } }, 5000);
      if (k.unref) k.unref();
    }
    return true;
  }
  stopAll(why) { for (const id of [...this.relays.keys()]) this.stop(id, why); }
  /** What the site gets: no URLs, no keys. */
  status() {
    const out = {};
    for (const r of this.relays.values()) {
      out[r.id] = { state: r.state, detail: r.detail, kbps: r.kbps, fps: r.fps, frames: r.frames,
                    since: r.state === "live" ? r.startedAt : null, restarts: r.restarts };
    }
    return out;
  }
}

// ── the loop ──
function post(siteUrl, token, body, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const u = new URL("/api/restream/worker/sync", siteUrl);
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: "POST", timeout: timeoutMs,
      headers: { "Content-Type": "application/json", "Content-Length": data.length, "X-Restream-Token": token } }, (res) => {
      let b = "";
      res.on("data", (d) => { b += d; if (b.length > 1e6) req.destroy(); });
      res.on("end", () => {
        if (res.statusCode !== 200) return reject(new Error("site answered " + res.statusCode));
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error("bad JSON from the site")); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(data);
  });
}

function main() {
  const SITE = process.env.SITE_URL || "http://127.0.0.1:3000";
  const TOKEN = process.env.RESTREAM_TOKEN || "";
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(SITE)) { console.error("SITE_URL must be a loopback http:// URL"); process.exit(2); }
  if (TOKEN.length < 16) { console.error("RESTREAM_TOKEN is missing"); process.exit(2); }
  const sup = new Supervisor({ ffmpeg: process.env.FFMPEG || "ffmpeg", allowTargets: process.env.ALLOW_TARGETS || "twitch",
                               log: (m) => console.log(redact(m)) });
  let lastOk = Date.now(), failing = false, busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const j = await post(SITE, TOKEN, { worker: { version: VERSION, pid: process.pid }, status: sup.status() });
      if (failing) console.log("site reachable again");
      failing = false; lastOk = Date.now();
      sup.sync(Array.isArray(j.relays) ? j.relays : []);
    } catch (e) {
      if (!failing) console.log("site sync failed: " + redact(e.message));
      failing = true;
      if (Date.now() - lastOk > HOLD_MS && sup.relays.size) { console.log(`site unreachable for ${Math.round(HOLD_MS / 1000)} s - stopping every relay`); sup.stopAll("site unreachable"); }
      else sup.watchdog();
    } finally { busy = false; }
  };
  const shutdown = (sig) => { console.log(`${sig}: stopping`); sup.stopAll(sig); setTimeout(() => process.exit(0), 1500); };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  console.log(`patv-restream ${VERSION} -> ${SITE} (targets: ${sup.allowTargets})`);
  tick();
  setInterval(tick, SYNC_MS);
}

if (require.main === module) main();
module.exports = { Supervisor, redact, allowed, allowedSource, ffmpegArgs, keyOf, BACKOFF_MIN, BACKOFF_MAX, STALL_MS, START_GRACE_MS, STABLE_MS };
