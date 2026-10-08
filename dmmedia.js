// dmmedia.js — pictures in direct messages (1.99cz). PRIVATE: only the members of the conversation ever get the
// bytes, through an authenticated route that checks membership on every request.
//
// Pipeline: the feed's (feedmedia.js) - chunked 512 KB uploads, the type decided by MAGIC BYTES (pictures only:
// JPEG, PNG, GIF, WebP, AVIF, HEIC), then sharp re-encodes to webp (EXIF / GPS / XMP / ICC dropped, orientation
// baked in, <= 2048 px, plus a 640 px thumbnail; HEIC through heif-convert). Nothing a user sent is served.
//
// Storage: a SEPARATE private directory (DM_DIR; default /var/lib/patv[-staging]/dm, created 0700; off Linux a
// folder next to the code tree), random 32-hex names. Never under /public, never a public URL, never the feed's
// /media/f/ route (was /feed/f/). Served ONLY by GET /messages/media/<file>:
//   * signed in, and a CURRENT member of the message's conversation (not left), and the message is after the
//     member's "clear history" point and not deleted - checked on every request (else 404, the same answer as
//     "no such file", so nothing is confirmed to outsiders); the uploader may also see an upload not sent yet
//   * Cache-Control: private, no-store; nosniff; a sandboxing CSP; CORP same-origin; noindex; no ETag
//
// Table dm_media: id, owner_id, conversation_id, message_id (NULL until sent), state (uploading | processing |
// ready | failed | purged), file, thumb, w, h, bytes, nsfw (the sender's mark: blurred until clicked), sort,
// created, size_declared, received, sniff, error, purged_at.
//
// Lifetimes: a deleted message's files are purged by the sweep (every 30 min) after DELETED_GRACE_MS - unless
// the message has an OPEN report, then they're kept until it's resolved (admins may need to see them). Leaving or
// clearing a conversation only hides them from that member (the route checks). Uploads never sent: purged after
// 6 h; abandoned chunk files after 2 h.
//
// Who may send pictures: the feed's rule - a linked Camfrog name or level >= the feed's media_min_level (2);
// staff always. Caps: the feed's max_image_mb per picture, MAX_PER_MESSAGE per message, per-hour / per-day upload
// counts, a per-user DM storage quota, and the feed's global quota + disk floor (shared).
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");
const media = require("./feedmedia");

const MAX_PER_MESSAGE = 4;
const LIMITS = { uploads_per_hour: 40, mb_per_day: 300, user_quota_mb: 500, open: 4 };
const DELETED_GRACE_MS = 3600e3;
const ORPHAN_TTL = 6 * 3600e3;
const FILE_RE = /^[a-f0-9]{32}(?:_t)?\.webp$/;
const ID_RE = /^[a-f0-9]{24}$/;
let NOW = () => Date.now();
function _setClock(fn) { NOW = fn; }

// ── the private directory ──
function pickDir() {
  if (process.env.DM_DIR) return path.resolve(process.env.DM_DIR);
  if (process.platform === "linux") {
    const d = process.env.STAGING ? "/var/lib/patv-staging/dm" : "/var/lib/patv/dm";
    try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (e) { /* not root: below */ }
  }
  return path.resolve(__dirname, "..", path.basename(__dirname) + "-dm");
}
let DIR = null;
function dir() {
  if (!DIR) {
    DIR = pickDir();
    fs.mkdirSync(path.join(DIR, "tmp"), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(DIR, 0o700); } catch (e) { /* not ours / Windows */ }
    console.log(`[dm] media dir ${DIR}`);
  }
  return DIR;
}
function _setDir(d) { DIR = d; fs.mkdirSync(path.join(DIR, "tmp"), { recursive: true }); }
function filePath(name) {
  if (!FILE_RE.test(String(name || ""))) return null;
  return path.join(dir(), name.slice(0, 2), name);
}
const tmpPath = (id) => path.join(dir(), "tmp", id + ".part");
function removeFiles(names) {
  for (const n of names) { const p = filePath(n); if (p) { try { fs.unlinkSync(p); } catch (e) { /* gone */ } } }
}

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS dm_media (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, conversation_id TEXT, message_id INTEGER, state TEXT NOT NULL,
        file TEXT, thumb TEXT, w INTEGER, h INTEGER, bytes INTEGER NOT NULL DEFAULT 0, nsfw INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0,
        created INTEGER NOT NULL, size_declared INTEGER, received INTEGER NOT NULL DEFAULT 0, sniff TEXT, error TEXT, purged_at INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS dm_media_msg ON dm_media (message_id)");
      await runQuery("CREATE INDEX IF NOT EXISTS dm_media_owner ON dm_media (owner_id, created)");
      await runQuery("CREATE INDEX IF NOT EXISTS dm_media_file ON dm_media (file)");
      await runQuery("CREATE INDEX IF NOT EXISTS dm_media_thumb ON dm_media (thumb)");
    })().catch((e) => { console.error("[dm] media init:", e.message); ready = null; throw e; });
  }
  return ready;
}

class MediaRefuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }
const isStaff = (u) => !!u && (u.class === "Admin" || u.class === "Staff");
const feedConfig = () => { try { return require("./feedstore").config(); } catch (e) { return { max_image_mb: 10, media_min_level: 2, global_quota_gb: 20, min_free_gb: 8 }; } };

/** Why `u` (an account row) can't send pictures, or null. Same rule as feed uploads. */
function pictureRefusal(u) {
  if (!u) return "Sign in first.";
  if (isStaff(u) || u.camfrogUsername) return null;
  const min = Number(feedConfig().media_min_level) || 0;
  if ((Number(u.level) || 0) >= min) return null;
  return `Sending pictures needs a linked Camfrog name (type !verify in a Camfrog room with Pepe) or level ${min}.`;
}

async function usedBytes(userId) {
  await init();
  const live = "state IN ('uploading','processing','ready')";
  const sum = "COALESCE(SUM(CASE WHEN state IN ('uploading','processing') THEN MAX(bytes, received) ELSE bytes END), 0) AS b";
  if (userId) return (await getQuery(`SELECT ${sum} FROM dm_media WHERE owner_id = ? AND ${live}`, [userId]))[0].b;
  return (await getQuery(`SELECT ${sum} FROM dm_media WHERE ${live}`))[0].b;
}

// ── uploads ──
async function open(u, { size, nsfw = false } = {}) {
  await init();
  const why = pictureRefusal(u);
  if (why) throw new MediaRefuse(403, why);
  const C = feedConfig();
  const n = Math.floor(Number(size));
  if (!Number.isFinite(n) || n < 12) throw new MediaRefuse(400, "That file is empty.");
  if (n > C.max_image_mb * 1024 * 1024) throw new MediaRefuse(413, `Pictures can be up to ${C.max_image_mb} MB.`);
  const t = NOW();
  if (!isStaff(u)) {
    const hr = await getQuery("SELECT COUNT(*) AS n FROM dm_media WHERE owner_id = ? AND created > ?", [u.userId, t - 3600e3]);
    if (hr[0].n >= LIMITS.uploads_per_hour) throw new MediaRefuse(429, "You've sent a lot of pictures this hour - try again later.");
    const day = await getQuery("SELECT COALESCE(SUM(size_declared), 0) AS b FROM dm_media WHERE owner_id = ? AND created > ?", [u.userId, t - 86400e3]);
    if (day[0].b + n > LIMITS.mb_per_day * 1024 * 1024) throw new MediaRefuse(429, "You've hit today's picture allowance.");
    const o = await getQuery("SELECT COUNT(*) AS n FROM dm_media WHERE owner_id = ? AND state IN ('uploading','processing')", [u.userId]);
    if (o[0].n >= LIMITS.open) throw new MediaRefuse(429, "Finish the uploads you have going first.");
    if ((await usedBytes(u.userId)) + n > LIMITS.user_quota_mb * 1024 * 1024) throw new MediaRefuse(413, "You're out of space for pictures in messages - delete some old ones.");
  }
  let feedUsed = 0;
  try { feedUsed = await require("./feedstore").usedBytes(null); } catch (e) { feedUsed = 0; }
  if (feedUsed + (await usedBytes(null)) + n > C.global_quota_gb * 1024 ** 3 || media.diskFreeBytes() - n * 2 < C.min_free_gb * 1024 ** 3) {
    console.error("[dm] upload refused: storage full (quota or disk floor)");
    throw new MediaRefuse(507, "Storage is full right now - try again later.");
  }
  const id = crypto.randomBytes(12).toString("hex");
  await runQuery("INSERT INTO dm_media (id, owner_id, state, created, size_declared, received, nsfw) VALUES (?, ?, 'uploading', ?, ?, 0, ?)",
                 [id, u.userId, t, n, nsfw ? 1 : 0]);
  fs.writeFileSync(tmpPath(id), Buffer.alloc(0), { flag: "wx" });
  return { id, chunk: media.CHUNK };
}
async function row(id) {
  await init();
  if (!ID_RE.test(String(id || ""))) return null;
  return (await getQuery("SELECT * FROM dm_media WHERE id = ?", [String(id)]))[0] || null;
}
async function failUpload(a, msg) {
  await runQuery("UPDATE dm_media SET state = 'failed', error = ? WHERE id = ?", [String(msg).slice(0, 300), a.id]);
  try { fs.unlinkSync(tmpPath(a.id)); } catch (e) { /* none */ }
}
async function chunk(userId, id, offset, buf) {
  const a = await row(id);
  if (!a || a.owner_id !== userId) throw new MediaRefuse(404, "No such upload.");
  if (a.state !== "uploading") throw new MediaRefuse(409, "That upload is finished.");
  if (!Buffer.isBuffer(buf) || !buf.length) throw new MediaRefuse(400, "Empty chunk.");
  const off = Math.floor(Number(offset));
  if (off !== a.received) throw Object.assign(new MediaRefuse(409, "Out of order."), { received: a.received });
  if (a.received + buf.length > a.size_declared) { await failUpload(a, "That file is bigger than it said."); throw new MediaRefuse(413, "That file is bigger than it said."); }
  if (off === 0) {
    const sn = media.sniff(buf);
    if (sn.bad || sn.kind !== "image") {
      const msg = sn.bad && /HTML|Text|PDF|Archives|Playlists/.test(sn.bad) ? sn.bad : "Only pictures can be sent in messages (JPEG, PNG, GIF, WebP, AVIF, HEIC).";
      await failUpload(a, msg);
      throw new MediaRefuse(415, msg);
    }
    await runQuery("UPDATE dm_media SET sniff = ? WHERE id = ?", [JSON.stringify(sn), a.id]);
  }
  fs.appendFileSync(tmpPath(a.id), buf);
  const r = await runQuery("UPDATE dm_media SET received = received + ? WHERE id = ? AND received = ?", [buf.length, a.id, off]);
  if (!r.changes) throw new MediaRefuse(409, "Out of order.");
  return off + buf.length;
}
// 1.99fc: the safety hook (imagesafety.install sets it). fn({file, userId, ref}) -> {ok:true, nsfw?} | {ok:false, reason}
let SAFETY = async () => ({ ok: true });
function setSafetyCheck(fn) { SAFETY = typeof fn === "function" ? fn : async () => ({ ok: true }); }
async function processUpload(a) {
  const tmp = tmpPath(a.id);
  try {
    const head = Buffer.alloc(64);
    const fd = fs.openSync(tmp, "r");
    fs.readSync(fd, head, 0, 64, 0);
    fs.closeSync(fd);
    const sn = media.sniff(head);                         // again, on the assembled file
    if (sn.bad || sn.kind !== "image") throw new media.MediaError(sn.bad || "That file isn't a picture.");
    const out = await media.processImage(tmp, sn.fmt, { outDir: dir(), tmpDir: path.join(dir(), "tmp") });
    // 1.99fc: the image safety check (imagesafety.js; a pass-through while it's off): refused -> the upload fails;
    // NSFW -> the picture is marked NSFW (blurred until clicked), like the sender's own mark
    let sv;
    try { sv = await SAFETY({ file: filePath(out.file), userId: a.owner_id, ref: "dm:" + a.id }); }
    catch (e) { sv = { ok: false, reason: "The safety check couldn't run - try again in a minute." }; }
    if (!sv || sv.ok !== true) {
      removeFiles([out.file, out.thumb].filter(Boolean));
      throw new media.MediaError((sv && sv.reason) || "That picture can't be sent.");
    }
    await runQuery("UPDATE dm_media SET state = 'ready', file = ?, thumb = ?, w = ?, h = ?, bytes = ?, error = NULL, nsfw = CASE WHEN ? THEN 1 ELSE nsfw END WHERE id = ? AND state = 'processing'",
                   [out.file, out.thumb, out.w, out.h, out.bytes, sv.nsfw === true ? 1 : 0, a.id]);
  } catch (e) {
    const msg = e && e.refuse ? e.message : "That picture couldn't be processed.";
    if (!(e && e.refuse)) console.error("[dm] process", a.id, e && e.message);
    await runQuery("UPDATE dm_media SET state = 'failed', error = ? WHERE id = ?", [msg.slice(0, 300), a.id]);
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) { /* none */ }
  }
}
/** -> {state, promise} (promise: the processing, for tests) */
async function finish(userId, id) {
  const a = await row(id);
  if (!a || a.owner_id !== userId) throw new MediaRefuse(404, "No such upload.");
  if (a.state !== "uploading") return { state: a.state, promise: Promise.resolve() };
  if (a.received !== a.size_declared) throw Object.assign(new MediaRefuse(409, "Not all of the file arrived."), { received: a.received });
  const r = await runQuery("UPDATE dm_media SET state = 'processing' WHERE id = ? AND state = 'uploading'", [a.id]);
  if (!r.changes) return { state: "processing", promise: Promise.resolve() };
  const promise = processUpload(a).catch((e) => console.error("[dm] process:", e && e.message));
  return { state: "processing", promise };
}
const url = (name) => (name && FILE_RE.test(name) ? "/messages/media/" + name : null);
async function status(userId, id) {
  const a = await row(id);
  if (!a || a.owner_id !== userId) throw new MediaRefuse(404, "No such upload.");
  return { state: a.state, error: a.error, received: a.received,
           picture: a.state === "ready" ? { id: a.id, w: a.w, h: a.h, thumb: url(a.thumb), full: url(a.file) } : null };
}
async function discard(userId, id) {
  const a = await row(id);
  if (!a || a.owner_id !== userId || a.message_id) throw new MediaRefuse(404, "No such upload.");
  removeFiles([a.file, a.thumb].filter(Boolean));
  try { fs.unlinkSync(tmpPath(a.id)); } catch (e) { /* none */ }
  await runQuery("UPDATE dm_media SET state = 'purged', purged_at = ? WHERE id = ?", [NOW(), a.id]);
  return true;
}

// ── sending ──
/** Check the pictures a message will carry: the sender's own, ready, not sent yet, at most MAX_PER_MESSAGE. -> ids */
async function checkAttach(u, ids) {
  await init();
  const want = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
  if (!want.length) return [];
  if (want.length > MAX_PER_MESSAGE) throw new MediaRefuse(400, `Up to ${MAX_PER_MESSAGE} pictures per message.`);
  const why = pictureRefusal(u);
  if (why) throw new MediaRefuse(403, why);
  for (const id of want) {
    const a = await row(id);
    if (!a || a.owner_id !== u.userId || a.message_id) throw new MediaRefuse(400, "One of the pictures is gone - add it again.");
    if (a.state === "failed") throw new MediaRefuse(400, a.error || "One of the pictures couldn't be processed.");
    if (a.state !== "ready") throw new MediaRefuse(409, "Wait for the pictures to finish uploading.");
  }
  return want;
}
/** Bind checked pictures to the message just written. nsfwIds: the ones the sender marked NSFW. */
async function attach(ids, { conversationId, messageId, ownerId, nsfwIds = [] }) {
  const nsfw = new Set((Array.isArray(nsfwIds) ? nsfwIds : []).map(String));
  let i = 0;
  for (const id of ids) {
    await runQuery("UPDATE dm_media SET conversation_id = ?, message_id = ?, sort = ?, nsfw = CASE WHEN ? THEN 1 ELSE nsfw END WHERE id = ? AND owner_id = ? AND message_id IS NULL AND state = 'ready'",
                   [conversationId, messageId, i++, nsfw.has(id) ? 1 : 0, id, ownerId]);
  }
}
/** messageId -> [{id, thumb, full, w, h, nsfw}] for these messages (ready files only). */
async function forMessages(ids) {
  await init();
  const want = [...new Set(ids.filter((x) => Number.isInteger(x) && x > 0))];
  const out = new Map();
  if (!want.length) return out;
  const rows = await getQuery(`SELECT * FROM dm_media WHERE message_id IN (${want.map(() => "?").join(",")}) AND state = 'ready' ORDER BY sort`, want);
  for (const r of rows) {
    if (!out.has(r.message_id)) out.set(r.message_id, []);
    out.get(r.message_id).push({ id: r.id, thumb: url(r.thumb), full: url(r.file), w: r.w, h: r.h, nsfw: !!r.nsfw });
  }
  return out;
}
async function countFor(messageId) {
  await init();
  return (await getQuery("SELECT COUNT(*) AS n FROM dm_media WHERE message_id = ? AND state = 'ready'", [messageId]))[0].n;
}

/**
 * May `userId` see this file? -> the dm_media row or null. A current member, the message after their clear
 * point and not deleted; or the uploader's own upload that isn't sent yet.
 */
async function viewable(userId, name) {
  if (!userId || !FILE_RE.test(String(name || ""))) return null;
  await init();
  const a = (await getQuery("SELECT * FROM dm_media WHERE (file = ? OR thumb = ?) AND state = 'ready' LIMIT 1", [name, name]))[0];
  if (!a) return null;
  if (!a.message_id) return a.owner_id === userId ? a : null;
  const ok = (await getQuery(`SELECT 1 FROM messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
                              WHERE m.id = ? AND m.deleted_at IS NULL AND cm.user_id = ? AND cm.left_at IS NULL AND m.id > cm.cleared_id`,
                             [a.message_id, userId]))[0];
  return ok ? a : null;
}
const PRIVATE_HEADERS = {
  "Content-Type": "image/webp",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private, no-store, max-age=0",
  "Pragma": "no-cache",
  "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Robots-Tag": "noindex, noarchive",
  "Referrer-Policy": "no-referrer",
};
function sendFile(res, a, name) {
  const p = filePath(name);
  res.set(PRIVATE_HEADERS);
  res.set("Content-Disposition", `inline; filename="patv-dm-${a.id}${name.includes("_t.") ? "-thumb" : ""}.webp"`);
  res.sendFile(p, { etag: false, lastModified: false, cacheControl: false, headers: PRIVATE_HEADERS }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
}

// ── deleting + the sweep ──
async function sweep() {
  await init();
  const t = NOW();
  // a deleted message's files, after the grace period, unless the message has an open report (admins may need them)
  const dead = await getQuery(`SELECT d.* FROM dm_media d JOIN messages m ON m.id = d.message_id
                               WHERE d.state = 'ready' AND m.deleted_at IS NOT NULL AND m.deleted_at <= ?
                               AND NOT EXISTS (SELECT 1 FROM dm_reports r WHERE r.message_id = m.id AND r.resolved_at IS NULL)`, [t - DELETED_GRACE_MS]);
  const orphans = await getQuery("SELECT * FROM dm_media WHERE message_id IS NULL AND state IN ('ready','failed','uploading','processing') AND created <= ?", [t - ORPHAN_TTL]);
  for (const a of dead.concat(orphans)) {
    removeFiles([a.file, a.thumb].filter(Boolean));
    try { fs.unlinkSync(tmpPath(a.id)); } catch (e) { /* none */ }
    await runQuery("UPDATE dm_media SET state = 'purged', purged_at = ? WHERE id = ?", [t, a.id]);
  }
  let tmp = 0;
  try {
    for (const f of fs.readdirSync(path.join(dir(), "tmp"))) {
      const p = path.join(dir(), "tmp", f);
      try { if (t - fs.statSync(p).mtimeMs > media.TMP_TTL) { fs.rmSync(p, { recursive: true, force: true }); tmp++; } } catch (e) { /* raced */ }
    }
  } catch (e) { /* no dir */ }
  return { purged: dead.length, orphans: orphans.length, tmp };
}

// ── routes ──
function register(app, { addUser, guard, fail, account }) {
  init().catch(() => {});
  const express = require("express");
  const rawChunk = express.raw({ type: "application/octet-stream", limit: media.CHUNK_MAX });
  const chunkGuard = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const host = req.get("host"), src = req.get("origin") || req.get("referer");
    let same = true;
    if (src && host) { try { same = new URL(src).host === host; } catch (e) { same = false; } }
    if (!same || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    next();
  };
  app.post("/api/messages/uploads", addUser, guard(true), async (req, res) => {
    try { res.json({ ok: true, ...(await open(await account(req.user.userId), { size: (req.body || {}).size, nsfw: !!(req.body || {}).nsfw })) }); } catch (e) { fail(res, e); }
  });
  app.put("/api/messages/uploads/:id", addUser, chunkGuard, rawChunk, async (req, res) => {
    try { res.json({ ok: true, received: await chunk(req.user.userId, req.params.id, req.query.offset, req.body) }); }
    catch (e) { if (e && e.received != null) return res.status(409).json({ ok: false, error: e.message, received: e.received }); fail(res, e); }
  });
  app.post("/api/messages/uploads/:id/finish", addUser, guard(true), async (req, res) => {
    try { const r = await finish(req.user.userId, req.params.id); res.json({ ok: true, state: r.state }); }
    catch (e) { if (e && e.received != null) return res.status(409).json({ ok: false, error: e.message, received: e.received }); fail(res, e); }
  });
  app.get("/api/messages/uploads/:id", addUser, guard(false), async (req, res) => {
    try { res.json({ ok: true, ...(await status(req.user.userId, req.params.id)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/messages/uploads/:id/discard", addUser, guard(true), async (req, res) => {
    try { await discard(req.user.userId, req.params.id); res.json({ ok: true }); } catch (e) { fail(res, e); }
  });
  // the ONLY way to a DM picture: members of its conversation, checked on every request
  app.get("/messages/media/:file", addUser, async (req, res) => {
    const name = String(req.params.file || "");
    try {
      const a = await viewable(req.user && req.user.userId, name);
      if (!a || !filePath(name)) { res.set({ "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" }); return res.status(404).end(); }
      sendFile(res, a, name);
    } catch (e) {
      console.error("[dm] media:", e && e.message);
      if (!res.headersSent) res.status(500).end();
    }
  });
  const run = () => sweep().then((r) => { if (r.purged || r.orphans || r.tmp) console.log(`[dm] media sweep: ${JSON.stringify(r)}`); }).catch((e) => console.error("[dm] media sweep:", e.message));
  setTimeout(run, 90e3).unref();
  setInterval(run, 30 * 60e3).unref();
  // stuck in "processing" after a restart
  init().then(() => runQuery("UPDATE dm_media SET state = 'failed', error = 'The server restarted while processing - add it again.' WHERE state = 'processing'")).catch(() => {});
}

module.exports = { init, register, open, chunk, finish, status, discard, checkAttach, attach, forMessages, countFor, viewable, sendFile, sweep, pictureRefusal, setSafetyCheck,
                   usedBytes, dir, _setDir, filePath, url, MAX_PER_MESSAGE, LIMITS, FILE_RE, DELETED_GRACE_MS, ORPHAN_TTL, PRIVATE_HEADERS, MediaRefuse, _setClock };
