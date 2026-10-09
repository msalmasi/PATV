#!/usr/bin/env node
// deploy/restream/patv-restream.js - PATV 1.99fk: the "Also stream to Twitch" relay worker.
//
// Runs as systemd patv-restream@<inst> (user patv-restream, see patv-restream@.service / install.sh). Every
// SYNC_MS it POSTs what it runs to the site's loopback API (/api/restream/worker/sync, token in X-Restream-Token)
// and gets back the relays it should run: [{id, source, target}]. One ffmpeg per relay:
//     ffmpeg -i <source: rtmp://127.0.0.1/...> -c copy -f flv pipe:1      (copy only - no re-encode)
// and THIS process publishes ffmpeg's FLV to the target (Twitch ingest/<key>) with its own small RTMP client
// (RtmpPublisher below, 1.99gn). A relay that exits while still wanted is restarted with backoff (2 s doubling to
// 60 s, reset after 60 s of clean running); one whose frame counter stalls for STALL_MS is killed and restarted.
// Site unreachable: what runs keeps running for HOLD_MS (a site restart doesn't cut Twitch), then everything stops.
//
// Secrets (1.99gn): the stream key is never in any process's arguments. Before, ffmpeg got the target URL as an
// argument, so /proc/<pid>/cmdline showed it to every local account (no hidepid). Now ffmpeg only sees the loopback
// source and writes FLV to a pipe; the key lives in this worker's memory (it comes from the site over loopback HTTP,
// never from argv or the env file) and goes out only inside the RTMP publish command. It is NEVER logged either:
// ffmpeg's messages and our own lines go through redact(), which blanks every rtmp(s):// URL and the key itself.
// RELAY_MODE=argv brings the old ffmpeg-pushes-itself behaviour back (key in argv again) as an emergency fallback.
// Config (environment, from /etc/patv-restream/<inst>.env):
//   SITE_URL=http://127.0.0.1:3000   RESTREAM_TOKEN=<shared token>   FFMPEG=ffmpeg   ALLOW_TARGETS=twitch|loopback|any
//   RELAY_MODE=pipe (default) | argv
// No npm dependencies (runs on the system Node).
"use strict";
const http = require("http");
const net = require("net");
const tls = require("tls");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const { spawn } = require("child_process");

const VERSION = "1.99gn";
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
/** 1.99gn: the same ffmpeg without the target - FLV to stdout (fd 1), progress to fd 3. No URL with a key in it. */
function ffmpegPipeArgs(source) {
  const a = ffmpegArgs(source, "pipe:1");
  a[a.indexOf("-progress") + 1] = "pipe:3";
  return a;
}

// ── a minimal RTMP publisher (1.99gn) - just enough of the protocol to push FLV tags to an ingest ──
// AMF0
function amfEnc(v) {
  if (v === null || v === undefined) return Buffer.from([0x05]);
  if (typeof v === "number") { const b = Buffer.alloc(9); b[0] = 0x00; b.writeDoubleBE(v, 1); return b; }
  if (typeof v === "boolean") return Buffer.from([0x01, v ? 1 : 0]);
  if (typeof v === "string") { const s = Buffer.from(v, "utf8"); const h = Buffer.alloc(3); h[0] = 0x02; h.writeUInt16BE(s.length, 1); return Buffer.concat([h, s]); }
  const parts = [Buffer.from([0x03])];
  for (const [k, val] of Object.entries(v)) {
    const kb = Buffer.from(k, "utf8"); const l = Buffer.alloc(2); l.writeUInt16BE(kb.length, 0);
    parts.push(l, kb, amfEnc(val));
  }
  parts.push(Buffer.from([0x00, 0x00, 0x09]));
  return Buffer.concat(parts);
}
function amfDec(b, o) {
  const t = b[o++];
  switch (t) {
    case 0x00: return [b.readDoubleBE(o), o + 8];
    case 0x01: return [b[o] !== 0, o + 1];
    case 0x02: { const l = b.readUInt16BE(o); return [b.toString("utf8", o + 2, o + 2 + l), o + 2 + l]; }
    case 0x0C: { const l = b.readUInt32BE(o); return [b.toString("utf8", o + 4, o + 4 + l), o + 4 + l]; }
    case 0x05: case 0x06: return [null, o];
    case 0x03: case 0x08: {
      if (t === 0x08) o += 4;
      const obj = {};
      for (;;) {
        const l = b.readUInt16BE(o); o += 2;
        if (l === 0 && b[o] === 0x09) return [obj, o + 1];
        const k = b.toString("utf8", o, o + l); o += l;
        const [val, n] = amfDec(b, o); obj[k] = val; o = n;
      }
    }
    case 0x0A: { const n = b.readUInt32BE(o); o += 4; const arr = []; for (let i = 0; i < n; i++) { const [val, p] = amfDec(b, o); arr.push(val); o = p; } return [arr, o]; }
    case 0x0B: return [b.readDoubleBE(o), o + 10];
    default: throw new Error("unsupported AMF0 type " + t);
  }
}
function amfDecAll(b) { const out = []; let o = 0; while (o < b.length) { const [v, n] = amfDec(b, o); out.push(v); o = n; } return out; }

/** One RTMP message as fmt-0 chunks (absolute timestamp; extended timestamp from 0xFFFFFF on, repeated in fmt-3). */
function chunkMessage(csid, type, msid, ts, payload, chunkSize) {
  ts = ts >>> 0;
  const ext = ts >= 0xFFFFFF;
  const h = Buffer.alloc(ext ? 16 : 12);
  h[0] = csid & 0x3f;
  h.writeUIntBE(ext ? 0xFFFFFF : ts, 1, 3);
  h.writeUIntBE(payload.length, 4, 3);
  h[7] = type;
  h.writeUInt32LE(msid >>> 0, 8);
  if (ext) h.writeUInt32BE(ts, 12);
  const parts = [h];
  let o = 0;
  for (;;) {
    const n = Math.min(chunkSize, payload.length - o);
    parts.push(payload.subarray(o, o + n)); o += n;
    if (o >= payload.length) break;
    const c = Buffer.alloc(ext ? 5 : 1); c[0] = 0xC0 | (csid & 0x3f); if (ext) c.writeUInt32BE(ts, 1);
    parts.push(c);
  }
  return Buffer.concat(parts);
}

/** Reassembles RTMP messages from the incoming chunk stream (all four header formats, extended timestamps). */
class ChunkReader {
  constructor(onMessage) { this.buf = Buffer.alloc(0); this.chunkSize = 128; this.cs = new Map(); this.onMessage = onMessage; }
  push(data) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    let o = 0;
    for (;;) {
      const b = this.buf;
      let p = o;
      if (p >= b.length) break;
      const fmt = b[p] >> 6; let csid = b[p] & 0x3f; p++;
      if (csid === 0) { if (p + 1 > b.length) break; csid = 64 + b[p]; p += 1; }
      else if (csid === 1) { if (p + 2 > b.length) break; csid = 64 + b[p] + b[p + 1] * 256; p += 2; }
      const hl = [11, 7, 3, 0][fmt];
      if (p + hl > b.length) break;
      let st = this.cs.get(csid);
      if (!st) { st = { ts: 0, delta: 0, len: 0, type: 0, msid: 0, ext: false, parts: null, got: 0 }; this.cs.set(csid, st); }
      let tsf = 0, len = st.len, type = st.type, msid = st.msid;
      if (fmt <= 2) tsf = b.readUIntBE(p, 3);
      if (fmt <= 1) { len = b.readUIntBE(p + 3, 3); type = b[p + 6]; }
      if (fmt === 0) msid = b.readUInt32LE(p + 7);
      p += hl;
      const ext = fmt <= 2 ? tsf === 0xFFFFFF : st.ext;
      let extv = 0;
      if (ext) { if (p + 4 > b.length) break; extv = b.readUInt32BE(p); p += 4; }
      const fresh = st.parts === null;
      const n = Math.min(fresh ? len : st.len - st.got, this.chunkSize);
      if (p + n > b.length) break;           // wait for the whole chunk
      if (fresh) {
        if (fmt === 0) { st.ts = ext ? extv : tsf; st.delta = 0; }
        else if (fmt <= 2) { st.delta = ext ? extv : tsf; st.ts = (st.ts + st.delta) >>> 0; }
        else st.ts = (st.ts + st.delta) >>> 0;
        st.len = len; st.type = type; st.msid = msid; st.parts = []; st.got = 0;
      }
      st.ext = ext;
      st.parts.push(b.subarray(p, p + n)); st.got += n; p += n;
      o = p;
      if (st.got >= st.len) {
        const payload = Buffer.concat(st.parts); st.parts = null;
        this.onMessage({ csid, type: st.type, msid: st.msid, ts: st.ts, payload });
      }
    }
    this.buf = this.buf.subarray(o);
  }
}

const RTMP_OUT_CHUNK = 4096;
const RTMP_SETUP_MS = 15 * 1000;
/**
 * Publishes FLV (as ffmpeg's flv muxer writes it) to rtmp(s)://host[:port]/<app>/<stream name>.
 * Events: "ready" (NetStream.Publish.Start - start feeding), "drain" (socket writable again), "error" (Error; the
 * connection is gone), "close". write(buf) -> false means "pause the producer until drain".
 * Error messages never contain the URL; the server's own descriptions may echo the name, so callers redact().
 */
class RtmpPublisher extends EventEmitter {
  constructor(target, o = {}) {
    super();
    const u = new URL(target);
    if (!/^rtmps?:$/.test(u.protocol)) throw new Error("not an rtmp(s) URL");
    this.secure = u.protocol === "rtmps:";
    this.host = u.hostname;
    this.port = Number(u.port) || (this.secure ? 443 : 1935);
    const path = u.pathname.replace(/^\/+/, "");
    const i = path.lastIndexOf("/");
    this.app = i >= 0 ? path.slice(0, i) : path;
    this.name = (i >= 0 ? decodeURIComponent(path.slice(i + 1)) : "") + (u.search || "");
    if (!this.app || !this.name) throw new Error("the target needs an app and a stream name");
    this.tcUrl = `${u.protocol}//${u.host}/${this.app}`;
    this.dial = o.connect || ((cb) => this.secure ? tls.connect({ host: this.host, port: this.port, servername: this.host }, cb)
                                                  : net.connect({ host: this.host, port: this.port }, cb));
    this.setupMs = o.setupMs || RTMP_SETUP_MS;
    this.state = "connecting";   // connecting -> handshake -> connect -> publish -> live -> closed
    this.hs = Buffer.alloc(0);
    this.txn = 0;
    this.pending = new Map();    // txn -> command name
    this.streamId = 0;
    this.windowAck = 2500000; this.bytesIn = 0; this.lastAck = 0;
    this.flvBuf = Buffer.alloc(0); this.flvHead = false;
    this.reader = new ChunkReader((m) => this._onMessage(m));
    this.timer = setTimeout(() => this._fail(new Error(`no publish within ${Math.round(this.setupMs / 1000)} s (stuck at ${this.state})`)), this.setupMs);
    if (this.timer.unref) this.timer.unref();
    try { this.sock = this.dial(() => this._onConnect()); } catch (e) { setImmediate(() => this._fail(e)); return; }
    if (this.sock.setNoDelay) this.sock.setNoDelay(true);
    this.sock.on("data", (d) => this._onData(d));
    this.sock.on("drain", () => this.emit("drain"));
    this.sock.on("error", (e) => this._fail(new Error("connection: " + (e.code || e.message))));
    this.sock.on("close", () => {
      if (this.state === "closed") return;
      this._fail(new Error(this.state === "live" ? "the server closed the connection" : `the server closed the connection during ${this.state}`));
    });
  }
  _onConnect() {
    this.state = "handshake";
    const c1 = crypto.randomBytes(1536);
    c1.writeUInt32BE(0, 0); c1.writeUInt32BE(0, 4);       // time 0, zero field: the plain (non-digest) handshake
    this.sock.write(Buffer.concat([Buffer.from([0x03]), c1]));
  }
  _onData(d) {
    if (this.state === "closed") return;
    this.bytesIn += d.length;
    try {
      if (this.state === "handshake") {
        this.hs = Buffer.concat([this.hs, d]);
        if (!this.c2sent && this.hs.length >= 1537) {
          if (this.hs[0] !== 0x03) throw new Error("bad handshake version " + this.hs[0]);
          this.sock.write(this.hs.subarray(1, 1537));             // C2 = echo of S1
          this.c2sent = true;
        }
        if (this.hs.length < 3073) return;
        const rest = this.hs.subarray(3073);
        this.hs = null;
        this.state = "connect";
        this._send(2, 1, 0, 0, u32(RTMP_OUT_CHUNK));             // Set Chunk Size
        this._command("connect", { app: this.app, type: "nonprivate", flashVer: "FMLE/3.0 (compatible; patv-restream)", tcUrl: this.tcUrl });
        if (rest.length) this.reader.push(rest);
      } else {
        this.reader.push(d);
      }
      if (this.bytesIn - this.lastAck >= this.windowAck) { this.lastAck = this.bytesIn; this._send(2, 3, 0, 0, u32(this.bytesIn >>> 0)); }
    } catch (e) { this._fail(e); }
  }
  _send(csid, type, msid, ts, payload) {
    if (this.state === "closed" || !this.sock) return true;
    return this.sock.write(chunkMessage(csid, type, msid, ts, payload, this.state === "handshake" ? 128 : RTMP_OUT_CHUNK));
  }
  _command(name, obj, ...args) {
    const txn = ++this.txn;
    this.pending.set(txn, name);
    const p = Buffer.concat([amfEnc(name), amfEnc(txn), amfEnc(obj), ...args.map(amfEnc)]);
    this._send(3, 20, name === "publish" ? this.streamId : 0, 0, p);
  }
  _onMessage(m) {
    switch (m.type) {
      case 1: this.reader.chunkSize = m.payload.readUInt32BE(0) & 0x7fffffff; return;
      case 5: this.windowAck = Math.max(1, m.payload.readUInt32BE(0)); return;
      case 6: this._send(2, 5, 0, 0, u32(this.windowAck)); return;      // peer bandwidth -> our window ack size
      case 4: {                                                        // user control: answer pings
        if (m.payload.readUInt16BE(0) === 6) { const r = Buffer.alloc(6); r.writeUInt16BE(7, 0); m.payload.copy(r, 2, 2, 6); this._send(2, 4, 0, 0, r); }
        return;
      }
      case 20: case 17: return this._onCommand(amfDecAll(m.type === 17 ? m.payload.subarray(1) : m.payload));
      default: return;
    }
  }
  _onCommand(a) {
    const [name, txn] = a;
    if (name === "_result" || name === "_error") {
      const what = this.pending.get(txn); this.pending.delete(txn);
      if (name === "_error") {
        if (what === "releaseStream" || what === "FCPublish") return;     // optional, some servers refuse them
        const info = a[3] || {};
        return this._fail(new Error(`${what || "command"} refused: ${info.code || ""} ${info.description || ""}`.trim()));
      }
      if (what === "connect") {
        this.state = "publish";
        this._command("releaseStream", null, this.name);
        this._command("FCPublish", null, this.name);
        this._command("createStream", null);
      } else if (what === "createStream") {
        this.streamId = Number(a[3]) || 1;
        this._command("publish", null, this.name, "live");
      }
      return;
    }
    if (name === "onStatus") {
      const info = a[3] || {};
      const code = String(info.code || "");
      if (code === "NetStream.Publish.Start") {
        if (this.state !== "live") { this.state = "live"; clearTimeout(this.timer); this.emit("ready"); }
      } else if (info.level === "error" || /Failed|BadName|Rejected|Unpublish/.test(code)) {
        this._fail(new Error(`publish refused: ${code} ${info.description || ""}`.trim()));
      }
    }
  }
  /** Feed ffmpeg's FLV output. Only call after "ready". */
  write(data) {
    if (this.state !== "live") return true;
    this.flvBuf = this.flvBuf.length ? Buffer.concat([this.flvBuf, data]) : data;
    const b = this.flvBuf;
    let o = 0, ok = true;
    if (!this.flvHead) {
      if (b.length < 9) return true;
      if (b.toString("latin1", 0, 3) !== "FLV") { this._fail(new Error("ffmpeg's output is not FLV")); return true; }
      const off = b.readUInt32BE(5);
      if (b.length < off + 4) return true;
      o = off + 4; this.flvHead = true;
    }
    while (b.length - o >= 11) {
      const type = b[o] & 0x1f, size = b.readUIntBE(o + 1, 3);
      if (b.length - o < 15 + size) break;
      const ts = (b.readUIntBE(o + 4, 3) | (b[o + 7] << 24)) >>> 0;
      const body = b.subarray(o + 11, o + 11 + size);
      o += 15 + size;
      if (type === 8) ok = this._send(4, 8, this.streamId, ts, body) && ok;
      else if (type === 9) ok = this._send(6, 9, this.streamId, ts, body) && ok;
      else if (type === 18) ok = this._send(5, 18, this.streamId, ts, Buffer.concat([amfEnc("@setDataFrame"), body])) && ok;
      if (this.state === "closed") return true;
    }
    this.flvBuf = o >= b.length ? Buffer.alloc(0) : Buffer.from(b.subarray(o));
    return ok;
  }
  /** Clean end (ffmpeg finished): unpublish, then close. */
  end() {
    if (this.state === "closed") return;
    if (this.state === "live") {
      try {
        this._command("FCUnpublish", null, this.name);
        this._send(3, 20, 0, 0, Buffer.concat([amfEnc("deleteStream"), amfEnc(++this.txn), amfEnc(null), amfEnc(this.streamId)]));
      } catch (e) { /* closing anyway */ }
    }
    this._close();
    if (this.sock) this.sock.end();
  }
  destroy() { if (this.state === "closed") return; this._close(); if (this.sock) this.sock.destroy(); }
  _close() { this.state = "closed"; clearTimeout(this.timer); this.emit("close"); }
  _fail(e) {
    if (this.state === "closed") return;
    this._close();
    if (this.sock) this.sock.destroy();
    this.emit("error", e);
  }
}
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; }

class Supervisor {
  constructor(o = {}) {
    this.spawn = o.spawn || ((args) => spawn(o.ffmpeg || "ffmpeg", args, { stdio: ["ignore", "pipe", "pipe", "pipe"] }));
    this.now = o.now || (() => Date.now());
    this.log = o.log || ((m) => console.log(m));
    this.allowTargets = o.allowTargets || "twitch";
    this.mode = o.mode === "argv" ? "argv" : "pipe";   // pipe: we publish (no key in argv); argv: ffmpeg pushes (legacy)
    this.publisher = o.publisher || ((target) => new RtmpPublisher(target));
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
    const piped = this.mode === "pipe";
    try { proc = this.spawn(piped ? ffmpegPipeArgs(r.source) : ffmpegArgs(r.source, r.target)); } catch (e) { this.failed(r, "ffmpeg didn't start: " + (e.code || e.message)); return; }
    r.proc = proc;
    this.log(`[${r.id}] start (attempt ${r.restarts + 1})`);
    if (piped) this.attachPublisher(r, proc);
    const progressOut = piped ? (proc.stdio && proc.stdio[3]) : proc.stdout;
    let buf = "";
    if (progressOut) progressOut.on("data", (d) => {
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
  /** pipe mode: ffmpeg's FLV (stdout) -> our RTMP publisher. stdout stays paused until the server says Publish.Start
   *  and whenever the socket backs up; a publisher error kills that ffmpeg, so the normal exit -> backoff path runs. */
  attachPublisher(r, proc) {
    const out = proc.stdout;
    let pub;
    try { pub = this.publisher(r.target); } catch (e) {
      r.lastErr = "rtmp: " + redact(e.message, [r.key]);
      try { proc.kill("SIGKILL"); } catch (e2) { /* gone */ }
      return;
    }
    r.pub = pub;
    if (out) {
      out.on("data", (d) => { if (!pub.write(d)) out.pause(); });
      out.pause();
      out.on("end", () => pub.end());
    }
    pub.on("ready", () => { this.log(`[${r.id}] rtmp: publishing`); if (out) out.resume(); });
    pub.on("drain", () => { if (out) out.resume(); });
    pub.on("error", (e) => {
      const line = redact("rtmp: " + (e && e.message), [r.key]).slice(0, 300);
      this.log(`[${r.id}] ${line}`);
      if (r.proc === proc) { r.lastErr = line; try { proc.kill("SIGKILL"); } catch (e2) { /* gone */ } }
    });
    proc.on("exit", () => {   // a clean stop lets the publisher unpublish first (stdout "end"); then make sure it's gone
      const t = setTimeout(() => pub.destroy(), 3000);
      if (t.unref) t.unref();
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
                               mode: process.env.RELAY_MODE || "pipe", log: (m) => console.log(redact(m)) });
  let lastOk = Date.now(), failing = false, busy = false, stopping = false, timer = null;
  const tick = async () => {
    if (busy || stopping) return;
    busy = true;
    try {
      const j = await post(SITE, TOKEN, { worker: { version: VERSION, pid: process.pid }, status: sup.status() });
      if (failing) console.log("site reachable again");
      failing = false; lastOk = Date.now();
      if (!stopping) sup.sync(Array.isArray(j.relays) ? j.relays : []);
    } catch (e) {
      if (!failing) console.log("site sync failed: " + redact(e.message));
      failing = true;
      if (Date.now() - lastOk > HOLD_MS && sup.relays.size) { console.log(`site unreachable for ${Math.round(HOLD_MS / 1000)} s - stopping every relay`); sup.stopAll("site unreachable"); }
      else sup.watchdog();
    } finally { busy = false; }
  };
  // 1.99gn: no more ticks once stopping (a tick in the exit window used to start the relays again)
  const shutdown = (sig) => { if (stopping) return; stopping = true; clearInterval(timer); console.log(`${sig}: stopping`); sup.stopAll(sig); setTimeout(() => process.exit(0), 1500); };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  console.log(`patv-restream ${VERSION} -> ${SITE} (targets: ${sup.allowTargets}, mode: ${sup.mode})`);
  tick();
  timer = setInterval(tick, SYNC_MS);
}

if (require.main === module) main();
module.exports = { Supervisor, RtmpPublisher, ChunkReader, chunkMessage, amfEnc, amfDecAll, redact, allowed, allowedSource, ffmpegArgs, ffmpegPipeArgs, keyOf, BACKOFF_MIN, BACKOFF_MAX, STALL_MS, START_GRACE_MS, STABLE_MS };
