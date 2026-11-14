// storyorig.js — the ORIGINAL file of each story upload, kept 48 hours for quality checks (site 1.99anv, the story camera fix).
//
// Why: a choppy iPhone story (2026-11-14: freezes about 1 s apart) couldn't be compared with what the phone sent, because
// feedweb.processUpload deleted the upload as soon as storycompose / feedmedia had re-encoded it. Now the original of a story
// upload (feed_attachments purpose "story", processed and ready) MOVES out of the feed's tmp folder into a private folder:
//   * STORYORIG_DIR (env), else next to FEED_DIR when that is set (tests), else /var/lib/patv[-staging]/storyorig on Linux
//     (0700), else a folder NEXT TO the code tree. Nothing serves it except the admin download below. It is outside the feed
//     folder and the site tree, so pve1's nightly backup - an allow-list of /var/lib/patv/{feed,onair,pad,shopart,banner,cover}
//     plus the site's own uploads/media/data - never copies it (deploy/README.md "Story originals"). Files are named
//     <upload id>.orig; the sniffed format is on the row.
//   * story_originals: id (the upload's feed_attachments id) PK, owner_id, story_id (the media row once posted), kind, fmt,
//     bytes, kept_at, expires (kept_at + KEEP_MS)
//   * deleted at once when the upload is discarded (feedweb), when the story is deleted by its owner, the pad's owner / mods or
//     staff (stagecap.remove) or by Pepe's admin delete (media.js /api/media/delete), when the story couldn't be saved
//     (userstories.create) and when the account is deleted (accountdelete). The sweep (on boot and hourly) takes everything past
//     KEEP_MS, and an upload that never became a story once the feed's own sweep has purged it (unattached for 6 h) or it
//     failed. A story that only expires (24 h) keeps its original until the 48 h are up.
//   * the feed switch story_keep_originals (/feed/admin, on by default): off = no new originals (kept ones still go at 48 h)
//   * site Admins (siteperms feed.story_originals, locked) see how a story was captured on its page (/media/<id>) and can
//     download the original (GET /admin/story-originals/<story id>: an attachment, application/octet-stream, no-store, never
//     inline - the bytes are the member's file as sent, never re-encoded). Each download writes an admin_audit row
//     ("story_original_download", the uploader as the target).
// The capture source (cleanCapture): what the page said about the file - the PATV story camera, or a chosen file (📷 the
// phone's own camera app, 🖼️ the gallery) - and for a camera clip the recorder's mime type and its timeslice (0 = one final
// chunk: WebKit since 1.99anv). Kept as JSON in feed_attachments.capture at upload and copied to media.capture when the story
// is posted, so it outlives the original. Diagnostics only: never shown to members, never a reason to refuse an upload (a
// field that doesn't fit is dropped).
"use strict";
const fs = require("fs");
const path = require("path");
const { runQuery, getQuery } = require("./dbUtils");

const KEEP_MS = 48 * 3600e3;          // the owner's 48 hours (2026-11-14)
const GRACE_MS = 15 * 60e3;           // a file with no row (a restart between the move and the row) waits this long
const ID_RE = /^[a-f0-9]{24}$/, FILE_RE = /^([a-f0-9]{24})\.orig$/;
// the sniffed format (feedmedia.sniff) -> the download's file extension
const EXT = { jpeg: "jpg", png: "png", gif: "gif", webp: "webp", avif: "avif", heic: "heic", mp4: "mp4", webm: "webm", avi: "avi", ogg: "ogg" };
let NOW = () => Date.now();
function _setClock(fn) { NOW = typeof fn === "function" ? fn : () => Date.now(); }

// ── the private directory (evidence.js's pattern) ──
function candidateDir() {
  if (process.env.STORYORIG_DIR) return path.resolve(process.env.STORYORIG_DIR);
  if (process.env.FEED_DIR) return path.join(path.dirname(path.resolve(process.env.FEED_DIR)), "storyorig");
  if (process.platform === "linux") return process.env.STAGING ? "/var/lib/patv-staging/storyorig" : "/var/lib/patv/storyorig";
  return path.resolve(__dirname, "..", path.basename(__dirname) + "-storyorig");
}
function pickDir() {
  const d = candidateDir();
  if (process.env.STORYORIG_DIR || process.env.FEED_DIR || process.platform !== "linux") return d;
  try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (e) { /* not root: below */ }
  return path.resolve(__dirname, "..", path.basename(__dirname) + "-storyorig");
}
let DIR = null;
/** The folder - made (0700) the first time an original is kept, never at boot. */
function dir() {
  if (!DIR) {
    DIR = pickDir();
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(DIR, 0o700); } catch (e) { /* not ours / Windows */ }
    console.log("[storyorig] store dir ready");
  }
  return DIR;
}
/** The folder if it exists already (deleting and sweeping never create it). */
function existingDir() {
  if (DIR) return DIR;
  try { const d = candidateDir(); return fs.existsSync(d) ? d : null; } catch (e) { return null; }
}
function _setDir(d) { DIR = d || null; if (d) fs.mkdirSync(d, { recursive: true }); }
const fileOf = (id, base) => (base && ID_RE.test(String(id || "")) ? path.join(base, String(id) + ".orig") : null);
function unlinkQuiet(p) {
  if (!p) return true;
  try { fs.unlinkSync(p); return true; } catch (e) { return !!(e && e.code === "ENOENT"); }
}

let ready = null, KEPT = 0;       // KEPT: how many originals are on record (the privacy page's row shows while any are)
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS story_originals (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, story_id TEXT, kind TEXT, fmt TEXT, bytes INTEGER,
        kept_at INTEGER NOT NULL, expires INTEGER NOT NULL)`);
      await runQuery("CREATE INDEX IF NOT EXISTS story_originals_story ON story_originals (story_id)");
      await runQuery("CREATE INDEX IF NOT EXISTS story_originals_owner ON story_originals (owner_id)");
      await runQuery("CREATE INDEX IF NOT EXISTS story_originals_expires ON story_originals (expires)");
      await recount();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
async function recount() { try { KEPT = Number((await getQuery("SELECT COUNT(*) AS n FROM story_originals"))[0].n) || 0; } catch (e) { /* as it was */ } }

/** The feed switch story_keep_originals (/feed/admin; on unless switched off). */
function on() {
  try { return require("./feedstore").config().story_keep_originals !== false; } catch (e) { return false; }
}
/** For the privacy page (terms.js): its row shows while originals are being kept, and while any still are. */
function privacyOn() { return on() || KEPT > 0; }

// ── the capture source ──
const MIME_RE = /^[A-Za-z0-9][A-Za-z0-9.+/;=, _-]{0,99}$/;
/** What the page said about a story file -> {source: "camera"|"file", picker?, mime?, timeslice?} | null (said nothing usable).
 *  kind: the upload's kind ("image" | "video"); the recorder's details only for a camera clip. */
function cleanCapture(raw, kind) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const source = raw.source === "camera" || raw.source === "file" ? raw.source : null;
  if (!source) return null;
  const out = { source };
  if (source === "file" && (raw.picker === "camera" || raw.picker === "gallery")) out.picker = raw.picker;
  if (source === "camera" && kind === "video") {
    if (typeof raw.mime === "string" && MIME_RE.test(raw.mime.trim())) out.mime = raw.mime.trim();
    const ts = Number(raw.timeslice);
    if (raw.timeslice !== null && raw.timeslice !== "" && Number.isInteger(ts) && ts >= 0 && ts <= 60000) out.timeslice = ts;
  }
  return out;
}
/** A stored capture JSON (feed_attachments / media .capture) -> its clean object, or null. */
function parseCapture(json, kind) {
  if (!json) return null;
  try { return cleanCapture(JSON.parse(String(json)), kind); } catch (e) { return null; }
}
/** The admin view's words for a capture. */
function describe(c, kind) {
  if (!c) return "not recorded (posted before 1.99anv, or from a page that was open before it)";
  if (c.source === "camera") {
    if (kind !== "video" && kind !== "clip") return "the PATV story camera (a photo)";
    const parts = ["a video"];
    if (c.mime) parts.push(c.mime);
    if (c.timeslice === 0) parts.push("recorded in one piece (no timeslice)");
    else if (c.timeslice > 0) parts.push(`recorded in ${c.timeslice / 1000} s chunks (timeslice ${c.timeslice} ms)`);
    return "the PATV story camera (" + parts.join(", ") + ")";
  }
  if (c.picker === "camera") return "a file from the phone's own camera (📷 Camera)";
  if (c.picker === "gallery") return "a chosen file (🖼️ Gallery)";
  return "a chosen file";
}

// ── keeping, linking, deleting ──
/** processUpload, a story upload just saved as ready: its assembled upload `tmp` moves here instead of being deleted.
 *  -> true when it was kept. Never throws (an original is a diagnostic: the story goes on without it). */
async function keep(a, tmp, sn) {
  try {
    if (!a || a.purpose !== "story" || !ID_RE.test(String(a.id || "")) || !a.owner_id || !on()) return false;
    await init();
    let st;
    try { st = fs.statSync(tmp); } catch (e) { return false; }
    if (!st.isFile() || !st.size) return false;
    const dest = fileOf(a.id, dir());
    try { fs.renameSync(tmp, dest); }
    catch (e) {
      if (!e || e.code !== "EXDEV") throw e;
      fs.copyFileSync(tmp, dest); unlinkQuiet(tmp);       // another filesystem: a copy, then the upload goes
    }
    try { fs.chmodSync(dest, 0o600); } catch (e) { /* Windows */ }
    const t = NOW();
    await runQuery(`INSERT OR REPLACE INTO story_originals (id, owner_id, story_id, kind, fmt, bytes, kept_at, expires) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
                   [a.id, a.owner_id, a.kind === "image" || a.kind === "video" ? a.kind : null, sn && EXT[sn.fmt] ? sn.fmt : null, st.size, t, t + KEEP_MS]);
    KEPT++;
    // discarded while it moved (the discard found no row yet): it goes now
    const cur = (await getQuery("SELECT state, error FROM feed_attachments WHERE id = ?", [a.id]))[0];
    if (!cur || cur.state === "purged" || (cur.state === "deleted" && cur.error !== "used for a story")) { await forgetUpload(a.id); return false; }
    return true;
  } catch (e) {
    console.error("[storyorig] keep:", e.message);
    return false;
  }
}
/** userstories.create: the upload became story `storyId`. */
async function linkStory(uploadId, storyId) {
  if (!ID_RE.test(String(uploadId || "")) || !storyId) return false;
  await init();
  const r = await runQuery("UPDATE story_originals SET story_id = ? WHERE id = ?", [String(storyId), String(uploadId)]);
  return !!(r && r.changes);
}
async function drop(ids) {
  if (!ids.length) return 0;
  const base = existingDir();
  let n = 0;
  for (const id of ids) {
    unlinkQuiet(fileOf(id, base));                         // the file first, then the row
    const r = await runQuery("DELETE FROM story_originals WHERE id = ?", [id]);
    if (r && r.changes) n++;
  }
  await recount();
  return n;
}
/** The upload was discarded (or never became a story): its original goes now. -> rows deleted. Never throws. */
async function forgetUpload(uploadId) {
  try {
    const id = String(uploadId || "");
    if (!ID_RE.test(id)) return 0;
    await init();
    unlinkQuiet(fileOf(id, existingDir()));                // even before its row exists (a discard racing the move)
    return await drop([id]);
  } catch (e) { console.error("[storyorig] forget upload:", e.message); return 0; }
}
/** The story was deleted (its owner, a pad's owner / mods, staff, Pepe's admin delete): its original goes now. Never throws. */
async function forgetStory(storyId) {
  try {
    await init();
    return await drop((await getQuery("SELECT id FROM story_originals WHERE story_id = ?", [String(storyId || "")])).map((r) => r.id));
  } catch (e) { console.error("[storyorig] forget story:", e.message); return 0; }
}
/** The account is deleted: every original of theirs goes now. -> rows deleted (throws on a database error: the caller logs it). */
async function forgetOwner(userId) {
  await init();
  return drop((await getQuery("SELECT id FROM story_originals WHERE owner_id = ?", [String(userId || "")])).map((r) => r.id));
}

// ── the sweep (on boot + hourly) ──
/** -> {expired, unposted, missing, strays}: rows past KEEP_MS (file and row); uploads that never became a story and never will
 *  (the feed's sweep purged the unattached upload after 6 h, it failed, or it was let go); rows whose file is gone; and files of
 *  ours with no row (after GRACE_MS) or older than KEEP_MS by their own time (a file's time is the wall clock's: `wall`). */
async function sweep(now = NOW(), wall = Date.now()) {
  await init();
  const out = { expired: 0, unposted: 0, missing: 0, strays: 0 };
  const base = existingDir();
  out.expired = await drop((await getQuery("SELECT id FROM story_originals WHERE expires <= ?", [now])).map((r) => r.id));
  out.unposted = await drop((await getQuery(`SELECT o.id FROM story_originals o LEFT JOIN feed_attachments a ON a.id = o.id
    WHERE o.story_id IS NULL AND (a.id IS NULL OR a.state IN ('purged', 'failed') OR (a.state = 'deleted' AND COALESCE(a.error, '') <> 'used for a story'))`)).map((r) => r.id));
  const rows = await getQuery("SELECT id, kept_at FROM story_originals");
  const known = new Set(rows.map((r) => r.id));
  const gone = rows.filter((r) => now - Number(r.kept_at) > GRACE_MS && !(base && fs.existsSync(fileOf(r.id, base)))).map((r) => r.id);
  out.missing = await drop(gone);
  if (base) {
    let names = [];
    try { names = fs.readdirSync(base); } catch (e) { names = []; }
    for (const f of names) {
      const m = FILE_RE.exec(f);
      if (!m) continue;                                     // only our own files
      const p = path.join(base, f);
      let st; try { st = fs.statSync(p); } catch (e) { continue; }
      if (!st.isFile()) continue;
      const age = wall - st.mtimeMs;
      if (age > KEEP_MS || (!known.has(m[1]) && age > GRACE_MS)) {
        if (unlinkQuiet(p)) out.strays++;
        if (known.has(m[1])) await drop([m[1]]);
      }
    }
  }
  await recount();
  return out;
}

// ── the admin view ──
/** The /media/<id> page's admin box for a story row (media.source "user"): {how, capture, kept: {bytes, fmt, until, href} | null}. */
async function adminInfo(row) {
  if (!row || row.source !== "user") return null;
  await init();
  const capture = parseCapture(row.capture, row.kind === "clip" ? "video" : "image");
  const o = (await getQuery("SELECT * FROM story_originals WHERE story_id = ?", [String(row.id)]))[0];
  const p = o ? fileOf(o.id, existingDir()) : null;
  const kept = o && p && Number(o.expires) > NOW() && fs.existsSync(p)
    ? { bytes: Number(o.bytes) || 0, fmt: o.fmt || null, until: Number(o.expires), href: "/admin/story-originals/" + encodeURIComponent(String(row.id)) } : null;
  return { how: describe(capture, row.kind), capture, kept };
}

function register(app, { addUser, noTimers = false } = {}) {
  if (!noTimers) {
    const run = () => sweep().then((r) => { if (r.expired || r.unposted || r.missing || r.strays) console.log(`[storyorig] sweep: ${JSON.stringify(r)}`); })
      .catch((e) => console.error("[storyorig] sweep:", e.message));
    const boot = setTimeout(run, 20e3); if (boot.unref) boot.unref();
    const hourly = setInterval(run, 3600e3); if (hourly.unref) hourly.unref();
  }
  const SP = require("./siteperms");
  const nope = (res, status, text) => res.status(status).type("text/plain").send(text);
  app.get("/admin/story-originals/:id", addUser, async (req, res) => {
    res.set({ "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    try {
      if (!req.user || !req.user.userId || !SP.can(req.user, "feed.story_originals")) return nope(res, 404, "Not found.");
      const sid = String(req.params.id || "");
      if (!ID_RE.test(sid)) return nope(res, 404, "Not found.");
      await init();
      const o = (await getQuery("SELECT * FROM story_originals WHERE story_id = ?", [sid]))[0];
      const p = o ? fileOf(o.id, existingDir()) : null;
      if (!o || !p || Number(o.expires) <= NOW() || !fs.existsSync(p)) return nope(res, 404, "That story's original upload isn't kept (any more).");
      // the record first: no download without its audit row
      const owner = (await getQuery("SELECT userId, username FROM users WHERE userId = ?", [o.owner_id]).catch(() => []))[0] || { userId: o.owner_id };
      await require("./adminaudit").record({ userId: req.user.userId, username: req.user.username || null }, "story_original_download", owner,
        { story: sid, upload: o.id, bytes: Number(o.bytes) || 0, fmt: o.fmt || null });
      res.set({ "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="story-${sid}-original.${EXT[o.fmt] || "bin"}"`,
                "Content-Security-Policy": "default-src 'none'; sandbox", "Cross-Origin-Resource-Policy": "same-origin" });
      res.sendFile(p, { headers: { "Content-Type": "application/octet-stream" } }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
    } catch (e) {
      console.error("[storyorig] download:", e.message);
      if (!res.headersSent) nope(res, 500, "Something went wrong.");
    }
  });
}

module.exports = { init, register, keep, linkStory, forgetUpload, forgetStory, forgetOwner, sweep, adminInfo, cleanCapture, parseCapture, describe,
                   on, privacyOn, dir, existingDir, fileOf, _setDir, _setClock, KEEP_MS, GRACE_MS, EXT };
