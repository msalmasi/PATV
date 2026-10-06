// feedmedia.js — safe user uploads for feed posts (1.99bv). The first user upload surface on PATV,
// so every step assumes the file is hostile.
//
// Pipeline
//   1. The browser opens an upload (POST /api/feed/uploads {kind, size}) and sends the file in
//      512 KB chunks (PUT .../chunk?offset=n). Chunks keep every request far under nginx's default
//      1 MB body limit and Cloudflare's 100 MB one, and a dropped chunk can be resent.
//   2. The type is decided by the file's MAGIC BYTES (sniff), never by its name or the browser's
//      Content-Type. SVG, HTML, XML, PDF, archives, executables - anything not on the list - are
//      refused as soon as the first chunk arrives.
//   3. Size caps per kind (admin-settable; default image 10 MB, audio 25 MB, video 100 MB), checked
//      on open (declared size) and on every chunk (actual bytes).
//   4. Nothing a user sent is ever served. Every file is RE-ENCODED:
//        image -> webp (sharp; HEIC/HEIF first decoded by libheif's heif-convert; EXIF/GPS/XMP/ICC dropped, orientation applied, <= 2048 px, plus a
//                 640 px thumbnail; animated GIF/WebP stay animated, <= 200 frames)
//        audio -> m4a (AAC 128k), ffmpeg, all metadata/chapters/cover art dropped, duration cap
//        video -> mp4 (H.264 High 4.0 yuv420p <= 720p, AAC, +faststart), metadata dropped, duration
//                 cap, plus a webp poster frame
//      ffmpeg runs with the demuxer FORCED from the sniffed type and -protocol_whitelist file, so a
//      crafted file can't make it open playlists / URLs (the HLS/concat SSRF tricks), with a hard
//      timeout, at low priority, at most FFMPEG_JOBS at a time.
//   5. Files live OUTSIDE the code tree (FEED_DIR, default /var/lib/patv[-staging]/feed) under random
//      32-hex names. Served by feedweb.js with the stored content type, nosniff, Content-Disposition
//      inline + a safe filename, a sandboxing CSP and CORP same-origin.
//   6. Quotas: per user (default 500 MB live), global (default 20 GB) and a disk floor (refuse new
//      uploads when the disk has < 8 GB free). Deleted posts' files are purged after
//      deleted_purge_days; unattached uploads after 6 h; abandoned chunk files after 2 h.
//
// v2 note: the v2 media pipeline wants object storage (Garage S3 on the homelab). The VPS can't reach
// it (no tailnet on the VPS), so v1 stores on local disk; attachments carry kind/ct/bytes/w/h/secs so
// a migration is a copy + a `file` -> object key rewrite.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const STAGING = !!process.env.STAGING;
const CHUNK = 512 * 1024;
const CHUNK_MAX = 768 * 1024;          // a chunk request body may not exceed this
const IMG_MAX_PX = 2048, THUMB_PX = 640, MAX_FRAMES = 200, MAX_INPUT_PIXELS = 60e6;
const FFMPEG_TIMEOUT_MS = 6 * 60 * 1000;
const FFMPEG_JOBS = 2;
const TMP_TTL = 2 * 3600 * 1000, ORPHAN_TTL = 6 * 3600 * 1000;

// ── where files live ──
function pickDir() {
  if (process.env.FEED_DIR) return path.resolve(process.env.FEED_DIR);
  if (process.platform === "linux") {
    const d = STAGING ? "/var/lib/patv-staging/feed" : "/var/lib/patv/feed";
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (e) { /* not root: below */ }
  }
  // outside the code tree, next to it
  return path.resolve(__dirname, "..", path.basename(__dirname) + "-feed");
}
let DIR = null;
function dir() {
  if (!DIR) {
    DIR = pickDir();
    fs.mkdirSync(path.join(DIR, "tmp"), { recursive: true });
    console.log(`[feed] media dir ${DIR}`);
  }
  return DIR;
}
function _setDir(d) { DIR = d; fs.mkdirSync(path.join(DIR, "tmp"), { recursive: true }); }
const FILE_RE = /^[a-f0-9]{32}(?:_t|_p)?\.(webp|m4a|mp4)$/;
function filePath(name) {
  if (!FILE_RE.test(String(name || ""))) return null;
  return path.join(dir(), name.slice(0, 2), name);
}

// ── magic bytes ──
// -> {kind: "image"|"audio"|"video"|"av", fmt, ffmt (ffmpeg demuxer)} or {bad: "reason"}
function sniff(buf) {
  if (!buf || buf.length < 12) return { bad: "That file is empty or too small." };
  const b = buf;
  const ascii = (o, n) => b.subarray(o, o + n).toString("latin1");
  // hard refusals first: markup / documents / archives / executables
  let i = 0;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
  while (i < Math.min(b.length, 64) && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i++;
  if (b[i] === 0x3c) return { bad: "HTML, SVG and XML files can't be uploaded." };
  if (b[0] === 0xff && b[1] === 0xfe || b[0] === 0xfe && b[1] === 0xff) return { bad: "Text files can't be uploaded." };
  if (ascii(0, 4) === "%PDF") return { bad: "PDFs can't be uploaded." };
  if (ascii(0, 2) === "PK" || ascii(0, 2) === "MZ" || ascii(1, 3) === "ELF" || ascii(0, 6) === "7z\xbc\xaf\x27\x1c" || ascii(0, 4) === "Rar!") {
    return { bad: "Archives and programs can't be uploaded." };
  }
  if (ascii(0, 7) === "#EXTM3U") return { bad: "Playlists can't be uploaded." };
  // images
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: "image", fmt: "jpeg" };
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { kind: "image", fmt: "png" };
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return { kind: "image", fmt: "gif" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return { kind: "image", fmt: "webp" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return { kind: "audio", fmt: "wav", ffmt: "wav" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "AVI ") return { kind: "video", fmt: "avi", ffmt: "avi" };
  // ISO base media (mp4 / mov / m4a / avif / heic)
  if (ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4).toLowerCase();
    // compatible brands (the rest of the ftyp box, inside this first chunk)
    const boxLen = b.readUInt32BE(0);
    const compat = [];
    for (let o = 16; o + 4 <= Math.min(boxLen, b.length, 256); o += 4) compat.push(ascii(o, 4).toLowerCase());
    if (brand === "avif" || brand === "avis" || ((brand === "mif1" || brand === "msf1") && compat.includes("avif"))) return { kind: "image", fmt: "avif" };
    // 1.99bz: HEIC / HEIF (iPhone photos) - decoded with libheif's heif-convert, then re-encoded like any picture
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1", "heim", "heis"].includes(brand)) return { kind: "image", fmt: "heic" };
    if (brand === "m4a " || brand === "m4b " || brand === "m4p ") return { kind: "audio", fmt: "m4a", ffmt: "mov" };
    return { kind: "av", fmt: "mp4", ffmt: "mov" };          // ffprobe decides audio-only vs video
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { kind: "av", fmt: "webm", ffmt: "matroska" };
  if (ascii(0, 4) === "OggS") return { kind: "av", fmt: "ogg", ffmt: "ogg" };
  if (ascii(0, 4) === "fLaC") return { kind: "audio", fmt: "flac", ffmt: "flac" };
  if (ascii(0, 3) === "ID3") return { kind: "audio", fmt: "mp3", ffmt: "mp3" };
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return { kind: "audio", fmt: "aac", ffmt: "aac" };     // ADTS (layer bits 00)
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return { kind: "audio", fmt: "mp3", ffmt: "mp3" };     // MPEG audio frame sync
  return { bad: "That file type isn't supported. Images: JPEG, PNG, GIF, WebP, AVIF, HEIC. Audio: MP3, M4A/AAC, OGG, WAV, FLAC. Video: MP4, MOV, WebM." };
}

// ── ffmpeg / ffprobe ──
let running = 0;
const waiting = [];
function slot() {
  return new Promise((resolve) => {
    const go = () => { running++; resolve(() => { running--; const n = waiting.shift(); if (n) n(); }); };
    if (running < FFMPEG_JOBS) go(); else waiting.push(go);
  });
}
function bin(name) { return process.env[name.toUpperCase() + "_PATH"] || name; }
function run(cmd, args, { timeoutMs = FFMPEG_TIMEOUT_MS, maxOut = 2 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let full = cmd, argv = args;
    if (process.platform === "linux" && !process.env.FEED_NO_NICE) { full = "nice"; argv = ["-n", "10", cmd, ...args]; }
    const p = spawn(full, argv, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "";
    p.stdout.on("data", (c) => { if (out.length < maxOut) out += c; });
    p.stderr.on("data", (c) => { if (err.length < 64 * 1024) err += c; });
    const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch (e) { /* gone */ } }, timeoutMs);
    p.on("error", (e) => { clearTimeout(t); reject(e); });
    p.on("close", (code, sig) => {
      clearTimeout(t);
      if (code === 0) resolve({ out, err });
      else reject(Object.assign(new Error(`${cmd} failed (${sig || code})`), { stderr: err.slice(-2000) }));
    });
  });
}

async function probe(file, ffmt) {
  const r = await run(bin("ffprobe"), ["-v", "error", "-protocol_whitelist", "file", "-f", ffmt,
    "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,width,height,duration",
    "-of", "json", file], { timeoutMs: 30000 });
  const j = JSON.parse(r.out || "{}");
  const streams = Array.isArray(j.streams) ? j.streams : [];
  const v = streams.find((s) => s.codec_type === "video" && !/^(mjpeg|png|bmp|gif)$/.test(String(s.codec_name)));   // cover art isn't video
  const a = streams.find((s) => s.codec_type === "audio");
  let secs = Number(j.format && j.format.duration);
  if (!Number.isFinite(secs) || secs <= 0) secs = Math.max(Number(v && v.duration) || 0, Number(a && a.duration) || 0);
  return { video: v || null, audio: a || null, secs: Number.isFinite(secs) ? secs : 0 };
}

class MediaError extends Error { constructor(m, status) { super(m); this.status = status || 400; this.refuse = true; } }

// ── processors: input file -> outputs in DIR. Return {kind, ct, files: [{name, role}], w, h, secs, bytes} ──
/**
 * HEIC/HEIF -> a temporary PNG with libheif's heif-convert (sharp's prebuilt libvips has libheif with
 * the AV1 decoder only - no HEVC - and the VPS's ffmpeg 4.2 has no HEIF demuxer). libheif applies the
 * container's rotation/mirror (irot/imir) while decoding; the PNG it writes has no EXIF, and sharp
 * re-encodes it to webp anyway. The decoder runs niced, in the ffmpeg job queue, with a 60 s timeout and
 * (Linux) a 2 GB address-space cap; the picture's size is checked with heif-info before decoding.
 * Everything heif-convert writes (iPhone portraits also get a "-depth" image) is in a private temp dir
 * that is removed afterwards.
 */
const HEIF_TIMEOUT_MS = 60 * 1000;
async function heicToPng(input) {
  const work = fs.mkdtempSync(path.join(dir(), "tmp", "heic-"));
  const release = await slot();
  try {
    const capped = (cmd, args) => (process.platform === "linux" && !process.env.FEED_NO_PRLIMIT
      ? run("prlimit", ["--as=2147483648", "--", bin(cmd), ...args], { timeoutMs: HEIF_TIMEOUT_MS })
      : run(bin(cmd), args, { timeoutMs: HEIF_TIMEOUT_MS }));
    let info;
    try { info = await capped("heif-info", [input]); } catch (e) {
      if (e && e.code === "ENOENT") throw new MediaError("HEIC photos can't be converted right now - export it as JPEG.");
      throw new MediaError("That HEIC photo couldn't be read.");
    }
    const m = /image:\s*(\d+)x(\d+)/.exec(info.out || "");
    if (!m) throw new MediaError("That HEIC photo couldn't be read.");
    if (Number(m[1]) * Number(m[2]) > MAX_INPUT_PIXELS) throw new MediaError("That photo is too big.");
    const out = path.join(work, "out.png");
    try { await capped("heif-convert", [input, out]); } catch (e) {
      if (e && e.code === "ENOENT") throw new MediaError("HEIC photos can't be converted right now - export it as JPEG.");
      console.error("[feed] heif-convert:", e.message, e.stderr || "");
      throw new MediaError("That HEIC photo couldn't be converted.");
    }
    if (!fs.existsSync(out)) throw new MediaError("That HEIC photo couldn't be converted.");
    return { png: out, cleanup: () => { try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* gone */ } } };
  } catch (e) {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) { /* gone */ }
    throw e;
  } finally { release(); }
}

async function processImage(input, fmt) {
  if (fmt === "heic") {
    const h = await heicToPng(input);
    try { return await processImage(h.png, "png"); } finally { h.cleanup(); }
  }
  const sharp = require("sharp");
  const base = crypto.randomBytes(16).toString("hex");
  const sub = path.join(dir(), base.slice(0, 2));
  fs.mkdirSync(sub, { recursive: true });
  const animated = fmt === "gif" || fmt === "webp";
  let meta;
  try {
    meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, animated }).metadata();
  } catch (e) { throw new MediaError("That image couldn't be read."); }
  const fmtOk = { jpeg: "jpeg", png: "png", gif: "gif", webp: "webp", avif: "heif" }[fmt];
  if (!meta || (fmtOk && meta.format !== fmtOk)) throw new MediaError("That image's contents don't match its type.");
  const pages = meta.pages || 1;
  const anim = animated && pages > 1;
  if (anim && pages > MAX_FRAMES) throw new MediaError(`Animations can have up to ${MAX_FRAMES} frames.`);
  const mk = (px) => sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, animated: anim })
    .rotate()                                                  // bake EXIF orientation in (metadata is dropped below)
    .resize({ width: px, height: px, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82, effort: 4 });                         // sharp writes NO metadata unless asked (no EXIF/GPS/XMP/ICC)
  const full = base + ".webp", thumb = base + "_t.webp";
  let info;
  try {
    info = await mk(IMG_MAX_PX).toFile(path.join(sub, full));
    await mk(THUMB_PX).toFile(path.join(sub, thumb));
  } catch (e) {
    for (const f of [full, thumb]) { try { fs.unlinkSync(path.join(sub, f)); } catch (_) { /* none */ } }
    throw new MediaError("That image couldn't be processed.");
  }
  const bytes = fs.statSync(path.join(sub, full)).size + fs.statSync(path.join(sub, thumb)).size;
  return { kind: "image", ct: "image/webp", file: full, thumb, poster: null, w: info.width, h: anim ? (info.pageHeight || info.height) : info.height,
           secs: 0, bytes, animated: anim };
}

async function processAv(input, sn, caps) {
  const pr = await probe(input, sn.ffmt).catch(() => null);
  if (!pr || (!pr.audio && !pr.video)) throw new MediaError("That file has no audio or video we can read.");
  const kind = sn.kind === "audio" || !pr.video ? "audio" : "video";
  if (kind === "audio" && !pr.audio) throw new MediaError("That audio file has no audio track.");
  const cap = kind === "video" ? caps.max_video_secs : caps.max_audio_secs;
  if (pr.secs > cap + 1) throw new MediaError(`${kind === "video" ? "Videos" : "Audio"} can be up to ${fmtSecs(cap)} long (that one is ${fmtSecs(pr.secs)}).`);
  if (kind === "video" && pr.video && Number(pr.video.width) * Number(pr.video.height) > 8192 * 8192) throw new MediaError("That video's frame size is too big.");
  const base = crypto.randomBytes(16).toString("hex");
  const sub = path.join(dir(), base.slice(0, 2));
  fs.mkdirSync(sub, { recursive: true });
  const common = ["-hide_banner", "-nostdin", "-v", "error", "-protocol_whitelist", "file", "-f", sn.ffmt, "-i", input,
                  "-map_metadata", "-1", "-map_chapters", "-1", "-sn", "-dn", "-t", String(cap + 1), "-threads", "4"];
  const release = await slot();
  try {
    if (kind === "audio") {
      const out = base + ".m4a";
      await run(bin("ffmpeg"), [...common, "-vn", "-map", "0:a:0", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "44100",
                                "-movflags", "+faststart", "-f", "mp4", "-y", path.join(sub, out)]);
      const bytes = fs.statSync(path.join(sub, out)).size;
      return { kind, ct: "audio/mp4", file: out, thumb: null, poster: null, w: 0, h: 0, secs: Math.round(pr.secs * 10) / 10, bytes };
    }
    const out = base + ".mp4", poster = base + "_p.webp";
    const vf = "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2";
    const args = [...common, "-map", "0:v:0", "-map", "0:a:0?", "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
                  "-profile:v", "high", "-level", "4.0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-ac", "2",
                  "-movflags", "+faststart", "-f", "mp4", "-y", path.join(sub, out)];
    await run(bin("ffmpeg"), args);
    const sharp = require("sharp");
    // poster: grab one frame to a temp png, re-encode with sharp
    const tmpPng = path.join(dir(), "tmp", base + "_poster.png");
    try {
      await run(bin("ffmpeg"), ["-hide_banner", "-nostdin", "-v", "error", "-protocol_whitelist", "file", "-ss", String(Math.min(1, pr.secs / 2)),
                                "-i", path.join(sub, out), "-frames:v", "1", "-y", tmpPng], { timeoutMs: 30000 });
      await sharp(tmpPng).resize({ width: THUMB_PX, height: THUMB_PX, fit: "inside", withoutEnlargement: true }).webp({ quality: 75 }).toFile(path.join(sub, poster));
    } catch (e) { /* no poster: the player shows its own first frame */ }
    try { fs.unlinkSync(tmpPng); } catch (e) { /* none */ }
    const hasPoster = fs.existsSync(path.join(sub, poster));
    const pr2 = await probe(path.join(sub, out), "mov").catch(() => pr);
    const bytes = fs.statSync(path.join(sub, out)).size + (hasPoster ? fs.statSync(path.join(sub, poster)).size : 0);
    return { kind, ct: "video/mp4", file: out, thumb: null, poster: hasPoster ? poster : null,
             w: Number(pr2.video && pr2.video.width) || 0, h: Number(pr2.video && pr2.video.height) || 0, secs: Math.round((pr2.secs || pr.secs) * 10) / 10, bytes };
  } catch (e) {
    for (const f of [base + ".m4a", base + ".mp4", base + "_p.webp"]) { try { fs.unlinkSync(path.join(sub, f)); } catch (_) { /* none */ } }
    if (e.refuse) throw e;
    console.error("[feed] ffmpeg:", e.message, e.stderr || "");
    throw new MediaError(`That ${kind} couldn't be converted.`);
  } finally { release(); }
}

function fmtSecs(s) {
  s = Math.round(Number(s) || 0);
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} min` : `${s} s`;
}

/** Re-encode a link-preview image (bytes from linkpreview.js) to a 640 px webp. -> {file, w, h, bytes} | null */
async function processPreviewImage(buf) {
  const sn = sniff(buf);
  if (sn.bad || sn.kind !== "image") return null;
  const sharp = require("sharp");
  const base = crypto.randomBytes(16).toString("hex");
  const sub = path.join(dir(), base.slice(0, 2));
  fs.mkdirSync(sub, { recursive: true });
  const name = base + "_t.webp";
  try {
    const info = await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS, pages: 1 }).rotate()
      .resize({ width: THUMB_PX, height: THUMB_PX, fit: "inside", withoutEnlargement: true }).webp({ quality: 75 }).toFile(path.join(sub, name));
    return { file: name, w: info.width, h: info.height, bytes: info.size };
  } catch (e) { try { fs.unlinkSync(path.join(sub, name)); } catch (_) { /* none */ } return null; }
}

// ── disk ──
function diskFreeBytes() {
  try {
    const s = fs.statfsSync(dir());
    return Number(s.bavail) * Number(s.bsize);
  } catch (e) { return Infinity; }
}
function removeFiles(names) {
  for (const n of names) {
    const p = filePath(n);
    if (p) { try { fs.unlinkSync(p); } catch (e) { /* already gone */ } }
  }
}
function tmpPath(id) { return path.join(dir(), "tmp", id + ".part"); }

/** Abandoned chunk files (older than TMP_TTL). */
function sweepTmp(now = Date.now()) {
  let n = 0;
  try {
    for (const f of fs.readdirSync(path.join(dir(), "tmp"))) {
      const p = path.join(dir(), "tmp", f);
      try { if (now - fs.statSync(p).mtimeMs > TMP_TTL) { fs.unlinkSync(p); n++; } } catch (e) { /* raced */ }
    }
  } catch (e) { /* no dir */ }
  return n;
}

module.exports = { sniff, probe, processImage, heicToPng, processAv, processPreviewImage, filePath, dir, _setDir, diskFreeBytes, removeFiles, tmpPath,
                   sweepTmp, MediaError, fmtSecs, CHUNK, CHUNK_MAX, FILE_RE, ORPHAN_TTL, TMP_TTL,
                   slot, run, bin };   // 1.99cr: stagecap.js shares this ffmpeg job queue (FFMPEG_JOBS at a time, niced, timeouts)
