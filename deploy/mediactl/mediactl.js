#!/usr/bin/env node
// deploy/mediactl/mediactl.js - PATV media-control service ("📼 Play from library", site 1.99ji).
//
// Runs in the homelab NEXT TO the media files and the Intel iGPU (the Plex container), never on the VPS.
// It is the only thing that touches the Plex token and the files; the PATV site talks to it with signed
// requests and gets back titles, posters and play status - never the token.
//
//   GET  /health                      {ok, version, encoder, streams}            (no auth; says nothing secret)
//   GET  /search?q=&limit=            Plex search: movies, shows, episodes
//   GET  /item/:key                   one item: duration, parts, audio + subtitle tracks (shows: their episodes)
//   GET  /poster/:key                 the poster (a small JPEG via Plex's photo transcoder)
//   GET  /streams                     every stream's status
//   PUT  /streams/:stage              start {rtmp, key, ratingKey, offset, quality, audio, sub, title}
//   POST /streams/:stage/stop         stop + forget
//   POST /streams/:stage/pause        stop ffmpeg, remember the position (pause-by-stop)
//   POST /streams/:stage/resume       start again at the remembered position
//   POST /streams/:stage/seek         {offset} restart at that position (seek-by-restart)
//
// ONE stream per stage (a stage = a PATV pad id). ffmpeg reads the file in real time (-re) and pushes H.264 + AAC
// as FLV to the stage's RTMP ingest with that slot's one-time key, so the site's stage, HLS, WHEP and the Twitch
// relay all see an ordinary slot.
//
// Auth (every route but /health): HMAC-SHA256 over "ts\nnonce\nMETHOD\n/path?query\nsha256(body)" with
// MEDIACTL_SECRET, in the headers x-mc-ts (ms), x-mc-nonce, x-mc-sig (hex); +-120 s window, nonces remembered.
// Plus an IP allow-list (MEDIACTL_ALLOW, CIDRs) and, when MEDIACTL_TLS_CERT/KEY are set, HTTPS (the site pins
// the certificate's SHA-256 fingerprint). RTMP targets must start with one of MEDIACTL_RTMP_ALLOW, so a leaked
// secret can't push the library anywhere else; files come only from Plex and must sit under MEDIACTL_MEDIA_ROOTS.
//
// Node 18+, no npm dependencies. Configuration: environment (see mediactl.env.example).
"use strict";
const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const childProcess = require("child_process");

const VERSION = "1.0.0";

// ── config ──
function loadConfig(env = process.env) {
  const list = (v, d) => String(v == null || v === "" ? d : v).split(",").map((s) => s.trim()).filter(Boolean);
  const c = {
    secret: String(env.MEDIACTL_SECRET || ""),
    listen: String(env.MEDIACTL_LISTEN || "0.0.0.0:8790"),
    allow: list(env.MEDIACTL_ALLOW, "127.0.0.1/32,::1"),
    tlsCert: env.MEDIACTL_TLS_CERT || "",
    tlsKey: env.MEDIACTL_TLS_KEY || "",
    plexUrl: String(env.PLEX_URL || "http://127.0.0.1:32400").replace(/\/+$/, ""),
    plexToken: String(env.PLEX_TOKEN || ""),
    ffmpeg: env.FFMPEG || "ffmpeg",
    encoder: ["vaapi", "x264"].includes(env.MEDIACTL_ENCODER) ? env.MEDIACTL_ENCODER : "vaapi",
    vaapiDevice: env.MEDIACTL_VAAPI_DEVICE || "/dev/dri/renderD128",
    rtmpAllow: list(env.MEDIACTL_RTMP_ALLOW, "rtmp://stream.publicaccess.tv/"),
    mediaRoots: list(env.MEDIACTL_MEDIA_ROOTS, "/mnt/"),
    maxStreams: Math.max(1, parseInt(env.MEDIACTL_MAX_STREAMS, 10) || 2),
    workDir: env.MEDIACTL_WORKDIR || path.join(os.tmpdir(), "mediactl"),
    retries: Math.max(0, parseInt(env.MEDIACTL_RETRIES, 10) || 3),
  };
  return c;
}

// ── small helpers ──
const sha256hex = (b) => crypto.createHash("sha256").update(b || "").digest("hex");
function sign(secret, { ts, nonce, method, url, body }) {
  return crypto.createHmac("sha256", secret).update(`${ts}\n${nonce}\n${String(method).toUpperCase()}\n${url}\n${sha256hex(body || "")}`).digest("hex");
}
function safeEq(a, b) {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function ipToBig(ip) {
  ip = String(ip || "").trim();
  if (ip.startsWith("::ffff:") && ip.includes(".")) ip = ip.slice(7);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    const p = ip.split(".").map(Number);
    if (p.some((n) => n > 255)) return null;
    return { v: 4, n: BigInt(((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) };
  }
  if (!ip.includes(":")) return null;
  let [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [], t = tail != null ? (tail ? tail.split(":") : []) : null;
  const groups = t == null ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) { const v = parseInt(g || "0", 16); if (!(v >= 0 && v <= 0xffff)) return null; n = (n << 16n) + BigInt(v); }
  return { v: 6, n };
}
function ipAllowed(ip, cidrs) {
  const a = ipToBig(ip);
  if (!a) return false;
  for (const c of cidrs) {
    const [base, bitsS] = String(c).split("/");
    const b = ipToBig(base);
    if (!b || b.v !== a.v) continue;
    const width = a.v === 4 ? 32 : 128;
    const bits = bitsS == null || bitsS === "" ? width : Math.max(0, Math.min(width, parseInt(bitsS, 10)));
    const shift = BigInt(width - bits);
    if ((a.n >> shift) === (b.n >> shift)) return true;
  }
  return false;
}
const clampInt = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const STAGE_RE = /^[A-Za-z0-9._-]{1,80}$/;
const KEY_RE = /^\d{1,12}$/;
const QUALITY = { 1080: { h: 1080, vb: 5000, ab: 160 }, 720: { h: 720, vb: 3000, ab: 128 }, 480: { h: 480, vb: 1500, ab: 128 } };
const TEXT_SUBS = new Set(["srt", "subrip", "ass", "ssa", "mov_text", "webvtt", "vtt", "text", "tx3g"]);
const IMAGE_SUBS = new Set(["pgs", "hdmv_pgs_subtitle", "dvd_subtitle", "vobsub", "dvb_subtitle", "dvdsub"]);

// ── Plex ──
function request(urlStr, { method = "GET", headers = {}, body = null, timeout = 15000, insecure = false, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(u, { method, headers, timeout, ...(u.protocol === "https:" && insecure ? { rejectUnauthorized: false } : {}) }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (d) => { size += d.length; if (size > 20 * 1024 * 1024) { req.destroy(new Error("response too big")); return; } chunks.push(d); });
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (raw) return resolve({ status: res.statusCode, headers: res.headers, body: buf });
        let json = null;
        try { json = buf.length ? JSON.parse(buf.toString("utf8")) : null; } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text: json ? null : buf.toString("utf8").slice(0, 500) });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function makePlex(cfg, req = request) {
  const headers = () => ({ Accept: "application/json", "X-Plex-Token": cfg.plexToken, "X-Plex-Client-Identifier": "patv-mediactl",
                           "X-Plex-Product": "PATV mediactl", "X-Plex-Version": VERSION });
  const insecure = /^https:\/\/(127\.|localhost|\[::1\])/.test(cfg.plexUrl);
  async function get(p, raw = false) {
    if (!cfg.plexToken) { const e = new Error("PLEX_TOKEN is not set"); e.status = 503; throw e; }
    const r = await req(cfg.plexUrl + p, { headers: headers(), insecure, raw });
    if (r.status === 401) { const e = new Error("Plex refused the token"); e.status = 502; throw e; }
    if (r.status === 404) { const e = new Error("Not in the Plex library"); e.status = 404; throw e; }
    if (r.status >= 400) { const e = new Error(`Plex answered ${r.status}`); e.status = 502; throw e; }
    return raw ? r : (r.json && r.json.MediaContainer) || {};
  }
  const brief = (m) => ({
    key: String(m.ratingKey), type: m.type, title: m.title || "", year: m.year || null,
    show: m.grandparentTitle || null, season: m.parentIndex != null ? m.parentIndex : null, episode: m.index != null && m.type === "episode" ? m.index : null,
    duration: m.duration ? Math.round(m.duration / 1000) : null, poster: !!(m.thumb || m.grandparentThumb || m.parentThumb),
    leafs: m.leafCount || null,
  });
  return {
    async search(q, limit = 20) {
      const mc = await get(`/hubs/search?query=${encodeURIComponent(q)}&limit=${clampInt(limit, 1, 50, 20)}&includeCollections=0&includeExternalMedia=0`);
      const out = [];
      for (const h of mc.Hub || []) {
        if (!["movie", "show", "episode"].includes(h.type)) continue;
        for (const m of h.Metadata || []) if (["movie", "show", "episode"].includes(m.type)) out.push(brief(m));
      }
      return out;
    },
    async item(key) {
      const mc = await get(`/library/metadata/${key}`);
      const m = (mc.Metadata || [])[0];
      if (!m) { const e = new Error("Not in the Plex library"); e.status = 404; throw e; }
      const out = { ...brief(m), summary: String(m.summary || "").slice(0, 600) };
      if (m.type === "show" || m.type === "season") {
        const eps = await get(`/library/metadata/${key}/allLeaves`);
        out.episodes = (eps.Metadata || []).map(brief);
        return out;
      }
      const media = (m.Media || [])[0] || {};
      const part = (media.Part || [])[0] || {};
      const streams = part.Stream || [];
      const subs = streams.filter((s) => s.streamType === 3);
      const embeddedSubs = subs.filter((s) => s.index != null && !s.key).sort((a, b) => a.index - b.index);
      const v = streams.find((s) => s.streamType === 1) || {};
      Object.assign(out, {
        file: part.file || null, container: part.container || media.container || null,
        duration: Math.round((part.duration || media.duration || m.duration || 0) / 1000) || null,
        width: media.width || v.width || null, height: media.height || v.height || null,
        hdr: /smpte2084|arib-std-b67/i.test(String(v.colorTrc || "")),
        video: { index: v.index != null ? v.index : null, codec: v.codec || null },
        audio: streams.filter((s) => s.streamType === 2 && s.index != null).map((s) => ({
          index: s.index, label: s.displayTitle || s.title || s.language || `Track ${s.index}`, lang: s.languageCode || null,
          default: !!(s.selected || s.default), codec: s.codec || null })),
        subs: embeddedSubs.map((s, i) => {
          const codec = String(s.codec || "").toLowerCase();
          return { index: s.index, rel: i, label: s.displayTitle || s.title || s.language || `Subtitle ${s.index}`, lang: s.languageCode || null,
                   codec, forced: !!s.forced, image: IMAGE_SUBS.has(codec), burnable: TEXT_SUBS.has(codec) || IMAGE_SUBS.has(codec) };
        }),
      });
      return out;
    },
    async poster(key) {
      const mc = await get(`/library/metadata/${key}`);
      const m = (mc.Metadata || [])[0];
      const thumb = m && (m.thumb || m.parentThumb || m.grandparentThumb);
      if (!thumb) { const e = new Error("No poster"); e.status = 404; throw e; }
      const r = await get(`/photo/:/transcode?width=240&height=360&minSize=1&upscale=1&format=jpeg&url=${encodeURIComponent(thumb)}`, true);
      return { type: String(r.headers["content-type"] || "image/jpeg"), body: r.body };
    },
  };
}

// ── ffmpeg ──
// Pure: the argument list for one stream. info = plex.item(), o = {offset, quality, audio, sub, url, srcLink}.
function ffmpegArgs(cfg, info, o) {
  const q = QUALITY[o.quality] || QUALITY[720];
  const sh = Number(info.height) || q.h, sw = Number(info.width) || Math.round(sh * 16 / 9);
  const outH = Math.min(q.h, sh) - (Math.min(q.h, sh) % 2);
  const outW = Math.max(2, Math.round((sw * outH / sh) / 2) * 2);
  const offset = Math.max(0, Number(o.offset) || 0);
  const sub = o.sub != null ? (info.subs || []).find((s) => s.index === Number(o.sub) && s.burnable) : null;
  const audio = o.audio != null ? (info.audio || []).find((a) => a.index === Number(o.audio)) : null;
  const vaapi = cfg.encoder === "vaapi";
  const fullHw = vaapi && !sub;                 // decode + scale (+ tone-map) on the GPU when nothing has to be drawn on the CPU
  const src = o.srcLink || info.file;
  const a = ["-hide_banner", "-nostdin", "-loglevel", "warning", "-nostats", "-progress", "pipe:1"];
  if (fullHw) a.push("-hwaccel", "vaapi", "-hwaccel_device", cfg.vaapiDevice, "-hwaccel_output_format", "vaapi");
  else if (vaapi) a.push("-init_hw_device", `vaapi=va:${cfg.vaapiDevice}`, "-filter_hw_device", "va");
  // burnt-in subtitles need the original timestamps to line up after a seek: keep them, then rebase the output to 0
  const rebase = !!sub && offset > 0;
  a.push("-re");
  if (offset > 0) a.push("-ss", offset.toFixed(3));
  if (rebase) a.push("-copyts");
  a.push("-i", src);
  let vchain;
  if (fullHw) {
    vchain = `[0:v:0]${info.hdr ? "tonemap_vaapi=format=nv12:p=bt709:t=bt709:m=bt709," : ""}scale_vaapi=w=${outW}:h=${outH}:format=nv12[v]`;
  } else {
    const parts = [];
    if (sub && sub.image) vchain = `[0:v:0][0:${sub.index}]overlay=eof_action=pass`;
    else if (sub) vchain = `[0:v:0]subtitles=filename=${escFilter(src)}:si=${sub.rel}`;
    else vchain = "[0:v:0]null";
    if (rebase) parts.push("setpts=PTS-STARTPTS");
    parts.push(`scale=${outW}:${outH}`, "format=nv12");
    if (vaapi) parts.push("hwupload");
    vchain += "," + parts.join(",") + "[v]";
  }
  a.push("-filter_complex", vchain, "-map", "[v]");
  a.push("-map", audio ? `0:${audio.index}` : "0:a:0?");
  if (rebase) a.push("-af", "asetpts=PTS-STARTPTS");
  if (vaapi) a.push("-c:v", "h264_vaapi", "-profile:v", "high", "-bf", "0");
  else a.push("-c:v", "libx264", "-preset", "veryfast", "-tune", "film", "-profile:v", "high", "-pix_fmt", "yuv420p");
  a.push("-b:v", `${q.vb}k`, "-maxrate", `${q.vb}k`, "-bufsize", `${q.vb * 2}k`, "-g", "60", "-force_key_frames", "expr:gte(t,n_forced*2)",
         "-c:a", "aac", "-b:a", `${q.ab}k`, "-ac", "2", "-ar", "48000", "-f", "flv", o.url);
  return a;
}
// a path inside a filtergraph option value: escape for the option level, then for the graph level
function escFilter(p) {
  const opt = String(p).replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
  return opt.replace(/\\/g, "\\\\").replace(/([[\],;'])/g, "\\$1");
}

// ── the streams ──
function makeStreams(cfg, plex, spawn = childProcess.spawn, clock = () => Date.now()) {
  const streams = new Map();   // stage -> state
  const view = (s) => ({
    stage: s.stage, state: s.state, ratingKey: s.ratingKey, title: s.title, quality: s.quality, audio: s.audio, sub: s.sub,
    offset: Math.round(s.offset), position: Math.round(position(s)), duration: s.duration, started: s.started, error: s.error || null,
    restarts: s.restarts, encoder: cfg.encoder,
  });
  const position = (s) => (s.state === "playing" ? s.offset + s.played : s.offset);
  function linkFor(stage, file) {
    // ffmpeg's subtitles filter takes a path inside a filtergraph: a symlink with a plain name avoids escaping surprises
    try {
      fs.mkdirSync(cfg.workDir, { recursive: true, mode: 0o700 });
      const ext = path.extname(file).replace(/[^.A-Za-z0-9]/g, "") || ".mkv";
      const l = path.join(cfg.workDir, `${stage.replace(/[^A-Za-z0-9_-]/g, "_")}${ext}`);
      try { fs.unlinkSync(l); } catch (e) { /* none */ }
      fs.symlinkSync(file, l);
      return l;
    } catch (e) { return file; }
  }
  function launch(s) {
    const args = ffmpegArgs(cfg, s.info, { offset: s.offset, quality: s.quality, audio: s.audio, sub: s.sub, url: s.url,
                                           srcLink: s.sub != null ? linkFor(s.stage, s.info.file) : null });
    s.played = 0;
    s.error = null;
    s.state = "playing";
    s.tail = [];
    const p = spawn(cfg.ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    s.proc = p;
    s.launchedAt = clock();
    let buf = "";
    p.stdout && p.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m && s.proc === p) s.played = Number(m[1]) / 1e6;
      }
    });
    p.stderr && p.stderr.on("data", (d) => {
      for (const l of d.toString().split("\n")) if (l.trim()) { s.tail.push(l.trim().replace(/rtmp:\/\/\S+/g, "rtmp://…")); if (s.tail.length > 12) s.tail.shift(); }
    });
    p.on("error", (e) => { if (s.proc === p) { s.proc = null; s.state = "error"; s.error = "ffmpeg: " + e.message; } });
    p.on("exit", (code) => {
      if (s.proc !== p) return;           // a stop / seek / pause replaced it
      s.proc = null;
      s.offset += s.played;
      s.played = 0;
      if (code === 0 || (s.duration && s.offset >= s.duration - 5)) { s.state = "ended"; return; }
      // a network blip: start again where it was (a few times, not when it dies straight away)
      const ranFor = clock() - s.launchedAt;
      if (s.restarts < cfg.retries && ranFor > 5000) {
        s.restarts++;
        setTimeout(() => { if (streams.get(s.stage) === s && s.state === "playing" && !s.proc) launch(s); }, 2000).unref();
        return;
      }
      s.state = "error";
      s.error = (s.tail.slice(-3).join(" | ") || `ffmpeg exited with ${code}`).slice(0, 400);
    });
  }
  function kill(s) {
    const p = s.proc;
    if (!p) return;
    s.offset += s.played;
    s.played = 0;
    s.proc = null;
    try { p.kill("SIGTERM"); } catch (e) { /* gone */ }
    const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch (e) { /* gone */ } }, 4000);
    t.unref && t.unref();
  }
  const fail = (status, msg) => { const e = new Error(msg); e.status = status; return e; };
  return {
    list: () => [...streams.values()].map(view),
    get: (stage) => (streams.get(stage) ? view(streams.get(stage)) : null),
    async start(stage, b) {
      if (!STAGE_RE.test(stage)) throw fail(400, "bad stage id");
      const existing = streams.get(stage);
      if (existing && ["playing", "paused"].includes(existing.state)) throw fail(409, "That stage is already playing something - stop it first.");
      const busy = [...streams.values()].filter((s) => s.state === "playing" && s.stage !== stage).length;
      if (busy >= cfg.maxStreams) throw fail(429, `Already ${busy} streams running (the most this box encodes at once).`);
      const rtmp = String(b.rtmp || "").replace(/\/+$/, ""), key = String(b.key || "");
      if (!cfg.rtmpAllow.some((p) => (rtmp + "/").startsWith(p))) throw fail(400, "RTMP target not allowed");
      if (!/^[A-Za-z0-9_.~-]{8,200}$/.test(key)) throw fail(400, "bad stream key");
      const ratingKey = String(b.ratingKey || "");
      if (!KEY_RE.test(ratingKey)) throw fail(400, "bad ratingKey");
      const info = await plex.item(ratingKey);
      if (!info.file) throw fail(400, "That item has no playable file (pick a movie or an episode).");
      const real = (() => { try { return fs.realpathSync(info.file); } catch (e) { return null; } })();
      if (!real) throw fail(404, "The media file isn't reachable from this box.");
      if (!cfg.mediaRoots.some((r) => real.startsWith(r))) throw fail(403, "That file is outside the allowed media folders.");
      const quality = QUALITY[Number(b.quality)] ? Number(b.quality) : 720;
      const audio = b.audio != null && b.audio !== "" ? Number(b.audio) : null;
      const sub = b.sub != null && b.sub !== "" ? Number(b.sub) : null;
      if (sub != null && !(info.subs || []).some((s) => s.index === sub && s.burnable)) throw fail(400, "That subtitle track can't be burnt in.");
      const s = { stage, ratingKey, info: { ...info, file: real }, title: String(b.title || info.title || "").slice(0, 120), url: `${rtmp}/${key}`,
                  quality, audio, sub, offset: clampInt(b.offset, 0, Math.max(0, (info.duration || 0) - 1), 0), duration: info.duration || null,
                  started: clock(), restarts: 0, played: 0, state: "starting", proc: null };
      streams.set(stage, s);
      launch(s);
      return view(s);
    },
    stop(stage) {
      const s = streams.get(stage);
      if (!s) return null;
      kill(s);
      s.state = "stopped";
      streams.delete(stage);
      return view(s);
    },
    pause(stage) {
      const s = streams.get(stage);
      if (!s || s.state !== "playing") throw fail(409, "Nothing is playing on that stage.");
      kill(s);
      s.state = "paused";
      return view(s);
    },
    resume(stage) {
      const s = streams.get(stage);
      if (!s || !["paused", "error"].includes(s.state)) throw fail(409, "Nothing is paused on that stage.");
      s.restarts = 0;
      launch(s);
      return view(s);
    },
    seek(stage, offset) {
      const s = streams.get(stage);
      if (!s || !["playing", "paused", "error", "ended"].includes(s.state)) throw fail(409, "Nothing is loaded on that stage.");
      kill(s);
      s.offset = clampInt(offset, 0, Math.max(0, (s.duration || 0) - 1), 0);
      s.restarts = 0;
      launch(s);
      return view(s);
    },
    stopAll() { for (const k of [...streams.keys()]) this.stop(k); },
    _streams: streams,
  };
}

// ── HTTP ──
function makeServer(cfg, { plex, streams, clock = () => Date.now() } = {}) {
  plex = plex || makePlex(cfg);
  streams = streams || makeStreams(cfg, plex);
  const nonces = new Map();
  const NONCE_MS = 5 * 60 * 1000;
  function authOk(req, body) {
    if (!cfg.secret || cfg.secret.length < 32) return false;
    const ts = Number(req.headers["x-mc-ts"]), nonce = String(req.headers["x-mc-nonce"] || ""), sig = String(req.headers["x-mc-sig"] || "");
    if (!Number.isFinite(ts) || Math.abs(clock() - ts) > 120000) return false;
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return false;
    const want = sign(cfg.secret, { ts: String(req.headers["x-mc-ts"]), nonce, method: req.method, url: req.url, body });
    if (!safeEq(sig, want)) return false;
    const t = clock();
    for (const [n, at] of nonces) if (t - at > NONCE_MS) nonces.delete(n);
    if (nonces.has(nonce)) return false;
    nonces.set(nonce, t);
    return true;
  }
  const send = (res, status, obj) => {
    const b = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { "Content-Type": "application/json", "Content-Length": b.length, "Cache-Control": "no-store" });
    res.end(b);
  };
  async function route(req, res, body) {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    let m;
    if (req.method === "GET" && p === "/search") {
      const q = String(u.searchParams.get("q") || "").trim().slice(0, 100);
      if (q.length < 2) return send(res, 400, { ok: false, error: "Type at least 2 characters." });
      return send(res, 200, { ok: true, results: await plex.search(q, u.searchParams.get("limit")) });
    }
    if (req.method === "GET" && (m = /^\/item\/(\d{1,12})$/.exec(p))) return send(res, 200, { ok: true, item: await plex.item(m[1]) });
    if (req.method === "GET" && (m = /^\/poster\/(\d{1,12})$/.exec(p))) {
      const img = await plex.poster(m[1]);
      res.writeHead(200, { "Content-Type": /^image\//.test(img.type) ? img.type : "image/jpeg", "Content-Length": img.body.length, "Cache-Control": "private, max-age=3600" });
      return res.end(img.body);
    }
    if (req.method === "GET" && p === "/streams") return send(res, 200, { ok: true, streams: streams.list() });
    if ((m = /^\/streams\/([A-Za-z0-9._-]{1,80})(?:\/(stop|pause|resume|seek))?$/.exec(p))) {
      const stage = m[1], op = m[2] || null;
      let b = {};
      try { b = body.length ? JSON.parse(body.toString("utf8")) : {}; } catch (e) { return send(res, 400, { ok: false, error: "bad JSON" }); }
      if (req.method === "GET" && !op) return send(res, 200, { ok: true, stream: streams.get(stage) });
      if (req.method === "PUT" && !op) return send(res, 200, { ok: true, stream: await streams.start(stage, b) });
      if ((req.method === "DELETE" && !op) || (req.method === "POST" && op === "stop")) return send(res, 200, { ok: true, stream: streams.stop(stage) });
      if (req.method === "POST" && op === "pause") return send(res, 200, { ok: true, stream: streams.pause(stage) });
      if (req.method === "POST" && op === "resume") return send(res, 200, { ok: true, stream: streams.resume(stage) });
      if (req.method === "POST" && op === "seek") return send(res, 200, { ok: true, stream: streams.seek(stage, b.offset) });
    }
    return send(res, 404, { ok: false, error: "not found" });
  }
  const handler = (req, res) => {
    const ip = req.socket.remoteAddress;
    if (!ipAllowed(ip, cfg.allow)) { res.writeHead(403); return res.end(); }
    const chunks = [];
    let size = 0;
    req.on("data", (d) => { size += d.length; if (size > 64 * 1024) { req.destroy(); return; } chunks.push(d); });
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      if (req.method === "GET" && req.url === "/health") {
        return send(res, 200, { ok: true, version: VERSION, encoder: cfg.encoder, plex: !!cfg.plexToken, streams: streams.list().filter((s) => s.state === "playing").length });
      }
      if (!authOk(req, body)) return send(res, 401, { ok: false, error: "unauthorized" });
      try { await route(req, res, body); }
      catch (e) {
        const st = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
        if (st >= 500) console.error("[mediactl]", req.method, req.url.split("?")[0], e.message);
        if (!res.headersSent) send(res, st, { ok: false, error: e.status ? e.message : "internal error" });
      }
    });
  };
  const server = cfg.tlsCert && cfg.tlsKey
    ? https.createServer({ cert: fs.readFileSync(cfg.tlsCert), key: fs.readFileSync(cfg.tlsKey), minVersion: "TLSv1.2" }, handler)
    : http.createServer(handler);
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  return { server, streams, plex };
}

function main() {
  const cfg = loadConfig();
  if (!cfg.secret || cfg.secret.length < 32) { console.error("[mediactl] MEDIACTL_SECRET must be set (32+ characters)"); process.exit(2); }
  if (!cfg.plexToken) console.error("[mediactl] PLEX_TOKEN is not set - search and play will fail until it is");
  const { server, streams } = makeServer(cfg);
  const i = cfg.listen.lastIndexOf(":");
  const host = cfg.listen.slice(0, i).replace(/^\[|\]$/g, "") || "0.0.0.0", port = parseInt(cfg.listen.slice(i + 1), 10) || 8790;
  server.listen(port, host, () => console.log(`[mediactl] ${VERSION} listening on ${host}:${port} (${cfg.tlsCert ? "https" : "http"}, encoder ${cfg.encoder}, allow ${cfg.allow.join(" ")})`));
  const bye = () => { streams.stopAll(); server.close(); setTimeout(() => process.exit(0), 500).unref(); };
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);
}

if (require.main === module) main();
module.exports = { loadConfig, sign, ipAllowed, ffmpegArgs, escFilter, makePlex, makeStreams, makeServer, VERSION, QUALITY };
