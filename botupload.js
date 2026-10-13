// botupload.js — Pepe's big uploads in chunks (1.99vk; the 413 from !clonemyvoice on 2026-10-13).
//
// nginx in front of publicaccess.tv (and staging) has client_max_body_size 1m, so ONE JSON POST from Pepe bigger than
// ~1 MB never reaches the app (HTTP 413), whatever the route's own parser limit says. A consent recording (16 kHz WAV, 60 s
// = ~2.6 MB of base64), a 10 s soundboard mic clip (44.1 kHz WAV, ~1.2 MB), a 5 min mic clip, a cam clip or a cutover
// export can all be bigger. Instead of one POST Pepe sends the SAME JSON body in pieces:
//
//   POST /api/bot/upload/chunk   {password, id, target, seq, total, size, data}   data = base64 of one slice (<= 512 KB raw;
//                                Pepe sends 384 KB -> 512 KB of base64, the /api/feed/aigen/chunk size)
//   POST /api/bot/upload/finish  {password, id, target, sha256}
//
// finish reassembles the slices, checks the byte count and the sha256 of the whole body, parses it and hands it to the
// target route AS IF it had been POSTed there (app.handle with the parsed body; the route's own express.json() sees
// req._body and leaves it alone) - so the target runs its own bot-token check, validation and answer, and Pepe gets that
// answer from /finish. Nothing about the targets changes; an old Pepe still POSTs them in one piece.
//
//   * bot-only: every call carries the bot token (the target checks it again on the parsed body).
//   * only the targets listed in TARGETS, each capped at its own route's parser limit (chunking never lets a route take
//     more than it would in one piece).
//   * idempotent per chunk: the same slice again answers {ok, dup}; a DIFFERENT slice under the same seq is refused (409).
//   * the id, target, total and size of an upload are fixed by its first chunk; a chunk that disagrees is refused (409).
//   * a sha256 / size mismatch at finish is refused (400) and the upload thrown away - Pepe starts over or POSTs in one piece.
//   * finish delivers once: a second finish answers 409 {delivered: true} (a retried finish must not apply a write twice).
//   * abandoned uploads expire TTL after their last chunk (sweep every minute + on each chunk); at most MAX_OPEN uploads and
//     MAX_OPEN_BYTES announced bytes at once (429 beyond).
//
// Slices live on disk under BOTUPLOAD_DIR (default uploads/.botupload, git-ignored) - one directory per upload.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");

let DIR = process.env.BOTUPLOAD_DIR ? path.resolve(process.env.BOTUPLOAD_DIR) : path.join(__dirname, "uploads", ".botupload");
const MB = 1024 * 1024;
const CHUNK_MAX = 512 * 1024;           // raw bytes of one slice (base64 ~683 KB: under nginx's 1m with room for the envelope)
const TTL = 15 * 60e3;                  // an upload not touched for 15 minutes is thrown away
const DONE_TTL = 10 * 60e3;             // a delivered upload's marker (answers a retried finish)
const MAX_OPEN = 16;
const MAX_OPEN_BYTES = 256 * MB;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
// target -> cap (bytes of the whole JSON body) = that route's own parser limit
const TARGETS = Object.freeze({
  "/api/voiceclone/bot/recorded": 12 * MB,
  "/api/soundboards/bot/audio": 6 * MB,
  "/api/soundboards/bot/room-clip": 6 * MB,
  "/api/bridge/micclip": 9 * MB,
  "/api/bridge/camclip": 9 * MB,
  "/api/media": 9 * MB,
  "/api/gtf/bot/import": 32 * MB,
  "/api/gtf/bot/put": 32 * MB,
  "/api/gtf/bot/sheet-mirror": 32 * MB,
  "/api/pools/admin/import": 32 * MB,
  "/api/escrow/admin/import": 32 * MB,
  "/api/gangs/admin/import": 32 * MB,
  "/api/capital/admin/import": 32 * MB,
  "/api/fed/admin/import": 32 * MB,
  "/api/achievements/admin/import": 32 * MB,
  "/api/achievements/bot/events": 4 * MB,
  "/api/econ/docs/put": 32 * MB,
  "/api/userstats/sync": 4 * MB,
});

let clock = () => Date.now();
function _setClock(fn) { clock = fn || (() => Date.now()); }
function _setDir(d) { DIR = d; }

class Refuse extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra || {}; } }
const dirOf = (id) => path.join(DIR, id);
const metaOf = (id) => path.join(DIR, id, "meta.json");
const partOf = (id, seq) => path.join(DIR, id, "p" + seq);
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; } };
function writeAtomic(file, data) {
  const tmp = file + ".tmp" + process.pid + "-" + crypto.randomBytes(3).toString("hex");
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
const rm = (id) => { try { fs.rmSync(dirOf(id), { recursive: true, force: true }); } catch (e) { /* gone */ } };
const int = (v) => (typeof v === "number" && Number.isInteger(v) ? v : (typeof v === "string" && /^\d{1,12}$/.test(v) ? Number(v) : NaN));

function listOpen() {
  let ids = [];
  try { ids = fs.readdirSync(DIR).filter((d) => ID_RE.test(d)); } catch (e) { return []; }
  return ids.map((id) => ({ id, meta: readJson(metaOf(id)) }));
}

/** Throw away uploads nobody touched for TTL (and delivered markers after DONE_TTL). -> how many went. */
function sweep(t = clock()) {
  let n = 0;
  for (const { id, meta } of listOpen()) {
    const last = meta ? Number(meta.done || meta.touched || meta.created || 0) : 0;
    if (!meta || t - last > (meta.done ? DONE_TTL : TTL)) { rm(id); n += 1; }
  }
  return n;
}
let lastSweep = 0;
function maybeSweep() {
  const t = clock();
  if (t - lastSweep < 60e3) return;
  lastSweep = t;
  try { sweep(t); } catch (e) { console.error("[botupload] sweep:", e.message); }
}

/** One slice. -> {ok, have, dup?} */
function chunk(b) {
  const id = String(b.id || ""), target = String(b.target || "");
  if (!ID_RE.test(id)) throw new Refuse(400, "bad upload id");
  const cap = TARGETS[target];
  if (!cap) throw new Refuse(400, "that route doesn't take chunked uploads", { code: "E_TARGET" });
  const seq = int(b.seq), total = int(b.total), size = int(b.size);
  if (!(size >= 1 && size <= cap)) throw new Refuse(413, `too big for ${target} (${size} bytes, at most ${cap})`, { code: "E_SIZE" });
  if (!(total >= 1 && total <= Math.ceil(size / 1024) && total >= Math.ceil(size / CHUNK_MAX))) throw new Refuse(400, "bad chunk count");
  if (!(seq >= 0 && seq < total)) throw new Refuse(400, "bad chunk number");
  if (typeof b.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(b.data)) throw new Refuse(400, "data must be base64");
  const buf = Buffer.from(b.data, "base64");
  if (!buf.length || buf.length > CHUNK_MAX) throw new Refuse(400, `a chunk is 1..${CHUNK_MAX} bytes`);
  maybeSweep();
  const t = clock();
  let meta = readJson(metaOf(id));
  if (meta && meta.done) throw new Refuse(409, "that upload was already delivered", { delivered: true });
  if (meta) {
    if (meta.target !== target || meta.total !== total || meta.size !== size) throw new Refuse(409, "that upload id was started with a different target / size");
  } else {
    const open = listOpen().filter((o) => o.meta && !o.meta.done);
    if (open.length >= MAX_OPEN || open.reduce((s, o) => s + (Number(o.meta.size) || 0), 0) + size > MAX_OPEN_BYTES) {
      throw new Refuse(429, "too many uploads at once - try again in a minute");
    }
    fs.mkdirSync(dirOf(id), { recursive: true });
    meta = { id, target, total, size, created: t };
  }
  const part = partOf(id, seq);
  let dup = false;
  if (fs.existsSync(part)) {
    if (sha(fs.readFileSync(part)) !== sha(buf)) throw new Refuse(409, `chunk ${seq} was already sent with different data`);
    dup = true;
  } else {
    writeAtomic(part, buf);
  }
  meta.touched = t;
  writeAtomic(metaOf(id), JSON.stringify(meta));
  let have = 0;
  for (let i = 0; i < total; i++) if (fs.existsSync(partOf(id, i))) have += 1;
  return { ok: true, have, total, ...(dup ? { dup: true } : {}) };
}

/** Reassemble + check -> the parsed body (the upload is marked delivered). Throws a Refuse otherwise. */
function assemble(b) {
  const id = String(b.id || ""), target = String(b.target || "");
  if (!ID_RE.test(id)) throw new Refuse(400, "bad upload id");
  const meta = readJson(metaOf(id));
  if (!meta) throw new Refuse(404, "no such upload (expired?) - send it again", { code: "E_UNKNOWN" });
  if (meta.done) throw new Refuse(409, "that upload was already delivered", { delivered: true });
  if (meta.target !== target) throw new Refuse(409, "that upload is for a different route");
  const missing = [];
  for (let i = 0; i < meta.total; i++) if (!fs.existsSync(partOf(id, i))) missing.push(i);
  if (missing.length) throw new Refuse(409, `missing chunk(s) ${missing.slice(0, 20).join(", ")}`, { missing: missing.slice(0, 200) });
  const whole = Buffer.concat(Array.from({ length: meta.total }, (_, i) => fs.readFileSync(partOf(id, i))));
  const want = String(b.sha256 || "").toLowerCase();
  if (whole.length !== meta.size || !/^[0-9a-f]{64}$/.test(want) || sha(whole) !== want) {
    rm(id);
    throw new Refuse(400, "the upload doesn't match its size / sha256 - send it again", { code: "E_SHA" });
  }
  let body;
  try { body = JSON.parse(whole.toString("utf8")); } catch (e) { body = null; }
  if (!body || typeof body !== "object" || Array.isArray(body)) { rm(id); throw new Refuse(400, "the upload isn't a JSON object"); }
  // delivered: the slices go, a small marker answers a retried finish until DONE_TTL
  rm(id);
  try { fs.mkdirSync(dirOf(id), { recursive: true }); writeAtomic(metaOf(id), JSON.stringify({ id, target, done: clock() })); } catch (e) { /* best effort */ }
  return { body, bytes: whole.length };
}

function register(app, { isBotToken, noTimers } = {}) {
  const big = express.json({ limit: "1mb" });     // one chunk (index.js keeps its global 100 KB parser off this path)
  const bot = (req, res, next) => (isBotToken((req.body || {}).password) ? next() : res.status(403).json({ ok: false, error: "unauthorized" }));
  const fail = (res, e) => {
    if (e instanceof Refuse) return res.status(e.status).json({ ok: false, error: e.message, ...e.extra });
    console.error("[botupload]", e);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  app.post("/api/bot/upload/chunk", big, bot, (req, res) => {
    try { res.json(chunk(req.body || {})); } catch (e) { fail(res, e); }
  });
  app.post("/api/bot/upload/finish", express.json({ limit: "16kb" }), bot, (req, res) => {
    let got;
    try { got = assemble(req.body || {}); } catch (e) { return fail(res, e); }
    const target = String(req.body.target), id = String(req.body.id);
    console.log(`[botupload] ${id} -> ${target} (${got.bytes} bytes)`);
    // hand the body to the target route as if it had been POSTed there in one piece
    req.url = target;
    req.body = got.body;
    req._body = true;                    // body-parser: already parsed (the route's own express.json() skips it)
    req.botUpload = { id, bytes: got.bytes };
    app.handle(req, res, (err) => {
      if (res.headersSent) return;
      if (err) { console.error("[botupload] target:", err); return res.status(500).json({ ok: false, error: "Something went wrong." }); }
      res.status(404).json({ ok: false, error: "no such route" });
    });
  });
  if (!noTimers) {
    const t = setInterval(() => { try { sweep(); } catch (e) { console.error("[botupload] sweep:", e.message); } }, 60e3);
    if (t.unref) t.unref();
  }
}

module.exports = { register, chunk, assemble, sweep, TARGETS, CHUNK_MAX, TTL, DONE_TTL, MAX_OPEN, Refuse, _setClock, _setDir };
