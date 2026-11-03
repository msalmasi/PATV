// camevidence.js — 1.99?? (privacy controls S4, owner Q12 2026-11-02: "Saved stills/clips as well, as evidence if required"):
// moderation EVIDENCE stills and clips of a cam revealed for moderation (camreveal.js). The WP-5 evidence pattern (evidence.js):
//   * who: a PATV admin (chatlog.see_through) or the pad's owner (their own pad, now) WHILE they view the reveal (a fresh beat inside
//     its 3 minutes) - Staff and room mods may view a hidden cam, never keep it;
//   * how: the SERVER captures it - ffmpeg reads the reveal's own relay over MediaMTX's loopback RTSP (a job-scoped password, livecam
//     .revealAuth -> rtspAuth here: only while that job reads, only that path, only 127.0.0.1) - a still (one JPEG frame) or a clip
//     (5-30 s of video, no sound: a cam has none). The browser supplies nothing, so nothing a page made can pass for evidence;
//   * where: the evidence store (evidence.js's directory, 0700, never under uploads/ or media/, never a public URL), in cam/<2 hex>/
//     <32 hex>.jpg|mp4 - stored as that store stores (it does not encrypt at rest: the directory's own permissions and backups, as for
//     the audio clips); rows in cam_evidence (subject login, veil, who, why, sha256, created, expires_at = +30 days, never moved, a
//     per-row legal hold, subject_gone_at);
//   * kept 30 days, then the hourly sweep deletes row then file - unless its own hold or a chat legal hold covers it (evidence.heldWhy);
//   * never posted: not the feed, stories, a pad, search, a sitemap, a soundboard or an AI picture - nothing reads cam_evidence but this;
//   * every save, view, list, download, hold and delete is a seethrough_log row (cam_evidence_save / _view / _list / _download / _hold /
//     _delete) and, for what changes or copies something, an admin_audit row (evidence.cam_save / cam_download / cam_hold / cam_unhold /
//     cam_delete); a save is ONE dbUtils.tx (the row, its see-through row, its admin_audit row) - a file whose rows fail is deleted;
//   * viewing: admins every pad (download: admins only - the admin export), a pad's owner their own pad's (saved while they own it);
//   * dark: on() = cam reveals effective (camreveal.js) AND evidence clips effective (evidence.js's switch + privacy wire v2). Off: every
//     route here answers 409 / 404, the sweep is a no-op on an empty table.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { spawn } = require("child_process");
const express = require("express");
const { runQuery, getQuery, tx } = require("./dbUtils");

const KEEP_MS = 30 * 864e5;
const CLIP_MIN = 5, CLIP_MAX = 30, CLIP_DEF = 15;
const MAX_BYTES = 60 * 1024 * 1024;
const REQ_GAP = 10e3, REQ_BURST = 6, REQ_WINDOW = 10 * 60e3;
const REASON_MAX = 200, WHY_MIN = 3;
const VIEW_LOG_MS = 3600e3;
const SWEEP_MS = 3600e3;
const ID_RE = /^ce[a-f0-9]{16}$/;
const FILE_RE = /^[a-f0-9]{32}\.(jpg|mp4)$/;
const LOGIN_RE = /^[\w.\-]{1,40}$/;
const KINDS = { still: { ext: "jpg", mime: "image/jpeg" }, clip: { ext: "mp4", mime: "video/mp4" } };
const SECRET = process.env.SECRET_KEY || crypto.randomBytes(32).toString("hex");
const headersOf = (mime) => ({
  "Content-Type": mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store, max-age=0", "Pragma": "no-cache",
  "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; sandbox", "Cross-Origin-Resource-Policy": "same-origin",
  "X-Robots-Tag": "noindex, noarchive", "Referrer-Policy": "no-referrer",
});

let clock = () => Date.now();
const now = () => clock();
const JOBS = new Map();          // job id -> {id, path, user, expiry, reading}
const BUSY = new Set();          // userId: one capture at a time each
const SEEN = new Map();          // "userId|what|id" -> ms (the hourly view / list log)
let ready = null;
class Refuse extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code || null; this.refuse = true; } }
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();

function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS cam_evidence (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, rk INTEGER, subject_login TEXT NOT NULL, veil TEXT,
                      kind TEXT NOT NULL, secs REAL, bytes INTEGER, sha256 TEXT, file TEXT NOT NULL, by_user TEXT NOT NULL, role TEXT NOT NULL, reason TEXT,
                      sid TEXT, st_id INTEGER, created INTEGER NOT NULL, expires_at INTEGER NOT NULL, hold_at INTEGER, hold_by TEXT, hold_why TEXT,
                      subject_gone_at INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS cam_evidence_room ON cam_evidence (room_id, created)");
      await runQuery("CREATE INDEX IF NOT EXISTS cam_evidence_exp ON cam_evidence (expires_at)");
      await runQuery("CREATE INDEX IF NOT EXISTS cam_evidence_subject ON cam_evidence (subject_login)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
const EV = () => require("./evidence");
/** May evidence of a revealed cam be saved now? Cam reveals in effect AND evidence clips in effect. Synchronous; fails closed. */
function on() {
  try { return require("./camreveal").effective() === true && EV().effective() === true; } catch (e) { return false; }
}

// ── the store (evidence.js's directory, a cam/ part of its own) ──
function base(create) {
  const b = create ? EV().storeDir() : EV().existingStoreDir();
  if (!b) return null;
  const d = path.join(b, "cam");
  if (create) { fs.mkdirSync(path.join(d, "pending"), { recursive: true, mode: 0o700 }); try { fs.chmodSync(d, 0o700); } catch (e) { /* Windows */ } }
  return fs.existsSync(d) ? d : null;
}
const filePath = (name, b) => (FILE_RE.test(String(name || "")) && b ? path.join(b, name.slice(0, 2), name) : null);
function unlinkQuiet(p) { if (!p) return true; try { fs.unlinkSync(p); return true; } catch (e) { return !!(e && e.code === "ENOENT"); } }
const isJpeg = (b) => !!b && b.length > 64 && b.length <= MAX_BYTES && b[0] === 0xff && b[1] === 0xd8;
const isMp4 = (b) => !!b && b.length > 64 && b.length <= MAX_BYTES && b.toString("latin1", 4, 8) === "ftyp";

// ── the loopback RTSP reader (stagemiccap.js's pattern) ──
function loopback(ip) {
  const s = String(ip || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (s === "::1" || s === "0:0:0:0:0:0:0:1") return true;
  const v4 = s.replace(/^::ffff:/, "");
  return net.isIP(v4) === 4 && v4.split(".")[0] === "127";
}
const password = (job) => crypto.createHmac("sha256", SECRET).update("camevidence-read:" + job.path + ":" + job.id + ":" + job.expiry).digest("hex");
/** livecam.revealAuth: an RTSP reader of a reveal's path - only a running capture of THAT path, from loopback, its own password. */
function rtspAuth(b, p) {
  if (!b || !loopback(b.ip)) return 403;
  if (!b.user && !b.password) return 401;
  if (b.user !== "camrev" || typeof b.password !== "string" || !/^[a-f0-9]{64}$/.test(b.password)) return 403;
  const t = now();
  for (const j of JOBS.values()) {
    if (!j.reading || j.path !== p || j.expiry < t) continue;
    if (crypto.timingSafeEqual(Buffer.from(password(j)), Buffer.from(b.password))) return 200;
  }
  return 403;
}
function rtspUrl(job) {
  const raw = process.env.STAGECAP_RTSP_BASE || "rtsp://127.0.0.1:8554";
  const u = new URL(raw), host = u.hostname.replace(/^\[|\]$/g, "");
  if (u.protocol !== "rtsp:" || !net.isIP(host) || !loopback(host)) throw new Refuse(500, "Evidence capture isn't set up on this server.", "rtsp");
  u.username = "camrev"; u.password = password(job); u.pathname = "/" + job.path; u.search = ""; u.hash = "";
  return u.toString();
}
const ffmpeg = () => { try { return require("./feedmedia").bin("ffmpeg"); } catch (e) { return "ffmpeg"; } };
function run(args, timeoutMs) {
  return new Promise((resolve) => {
    let err = "", done = false, timer = null;
    const cp = spawn(ffmpeg(), args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    const fin = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ ok: code === 0, error: err.replace(/camrev:[^@\s]*@/g, "camrev:[redacted]@").slice(-400) }); };
    cp.stderr.on("data", (b) => { err = (err + b.toString()).slice(-4096); });
    cp.once("error", () => fin(-1));
    cp.once("close", fin);
    timer = setTimeout(() => { try { cp.kill("SIGKILL"); } catch (e) { /* gone */ } }, timeoutMs);
  });
}
/** The real capture: one JPEG frame, or `secs` of video (mpegts first, then remuxed to MP4 - no re-encode). -> Buffer | throws */
async function captureReal(S, kind, secs) {
  const b = base(true);
  const job = { id: crypto.randomBytes(8).toString("hex"), path: S.path, expiry: now() + (kind === "clip" ? secs : 6) * 1000 + 20000, reading: true };
  JOBS.set(job.id, job);
  const tmp = path.join(b, "pending", "cap-" + job.id);
  try {
    const input = ["-hide_banner", "-nostdin", "-v", "error", "-protocol_whitelist", "rtsp,tcp,rtp", "-rtsp_transport", "tcp", "-f", "rtsp", "-i", rtspUrl(job),
                   "-map", "0:v:0", "-an", "-map_metadata", "-1"];
    if (kind === "still") {
      const r = await run(input.concat(["-frames:v", "1", "-c:v", "mjpeg", "-q:v", "3", "-f", "image2", "-y", tmp + ".jpg"]), 20000);
      job.reading = false;
      if (!r.ok) throw new Refuse(502, "Couldn't take the still - is their cam still showing?", "capture");
      return fs.readFileSync(tmp + ".jpg");
    }
    const r = await run(input.concat(["-t", String(secs), "-c:v", "copy", "-f", "mpegts", "-y", tmp + ".ts"]), secs * 1000 + 20000);
    job.reading = false;
    if (!r.ok && !fs.existsSync(tmp + ".ts")) throw new Refuse(502, "Couldn't record the clip - is their cam still showing?", "capture");
    const m = await run(["-hide_banner", "-nostdin", "-v", "error", "-protocol_whitelist", "file", "-i", tmp + ".ts", "-c", "copy", "-movflags", "+faststart",
                         "-f", "mp4", "-y", tmp + ".mp4"], 30000);
    if (!m.ok) throw new Refuse(502, "Couldn't record the clip - is their cam still showing?", "capture");
    return fs.readFileSync(tmp + ".mp4");
  } finally {
    job.reading = false;
    JOBS.delete(job.id);
    for (const x of [".jpg", ".ts", ".mp4"]) unlinkQuiet(tmp + x);
  }
}
let deps = { capture: captureReal };

async function rkOf(roomId) {
  try { const r = (await getQuery("SELECT rk FROM chatlog_rooms WHERE room_id = ?", [String(roomId)]))[0]; return r ? Number(r.rk) : null; } catch (e) { return null; }
}
/** Write one evidence file + ONE transaction: the row, its see-through row (cam_evidence_save), its admin_audit row (evidence.cam_save). */
async function store({ buf, kind, S, secs, user, role, reason }) {
  const ST = require("./seethrough"), AA = require("./adminaudit");
  await init(); await ST.init(); await AA.init();
  if (!KINDS[kind] || !(kind === "still" ? isJpeg(buf) : isMp4(buf))) throw new Refuse(502, "The capture couldn't be read - nothing was saved.", "capture");
  const b = base(true);
  const id = "ce" + crypto.randomBytes(8).toString("hex");
  const file = crypto.randomBytes(16).toString("hex") + "." + KINDS[kind].ext;
  const dest = filePath(file, b);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const part = path.join(b, "pending", "up-" + crypto.randomBytes(8).toString("hex") + ".part");
  fs.writeFileSync(part, buf, { mode: 0o600 });
  fs.renameSync(part, dest);
  const t = now(), exp = t + KEEP_MS, why = clean(reason, REASON_MAX) || null;
  const veil = S.rv && S.rv.veiled ? "veiled" : "named";
  const rk = await rkOf(S.roomId);
  try {
    await tx(async () => {
      const st = await ST.log({ userId: String(user.userId), role, scope: "cam_evidence_save", roomId: S.roomId, logins: [S.login], reason: why || "",
                                ref: "cev:" + id });
      if (!st) throw new Error("camevidence: no see-through row");
      await runQuery(`INSERT INTO cam_evidence (id, room_id, rk, subject_login, veil, kind, secs, bytes, sha256, file, by_user, role, reason, sid, st_id, created, expires_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                     [id, String(S.roomId), rk, S.login, veil, kind, kind === "clip" ? secs : 0, buf.length, crypto.createHash("sha256").update(buf).digest("hex"), file,
                      String(user.userId), role, why, S.sid, st, t, exp]);
      await AA.record({ userId: String(user.userId), username: user.username || null }, "evidence.cam_save", null, { id, room: String(S.roomId), kind, role, st }, why);
    });
  } catch (e) { unlinkQuiet(dest); throw e; }
  return { id, expires_at: exp };
}

/** A moderator saves evidence from the reveal they're viewing. -> {ok, id, kind, expires_at} */
async function save(user, R, sid, kind, secs0, reason0) {
  await init();
  if (!on()) throw new Refuse(404, "Saving evidence of a cam isn't switched on.", "off");
  if (!KINDS[kind]) throw new Refuse(400, "A still or a clip?", "bad");
  const reason = clean(reason0, REASON_MAX);
  if (reason.length < WHY_MIN) throw new Refuse(400, "Say why (at least 3 characters) - it's logged.", "why");
  const CR = require("./camreveal"), LC = require("./livecam");
  const role = await CR.roleOf(user, R);
  if (!role || !CR.SAVERS.has(role)) throw new Refuse(403, "Only PATV admins, and a pad's owner in their own pad, can save evidence of a cam.", "not_entitled");
  const S = LC.revealSess(R.id, sid);
  const v = S && !S.ended ? S.viewers.get(String(user.userId)) : null;
  const t = now();
  if (!v || t - v.beat > LC.BEAT_MS || t > v.until) throw new Refuse(410, "Open the cam first - evidence comes from a view that's running.", "ended");
  if (!S.liveAt) throw new Refuse(409, "Their cam isn't showing yet.", "not_live");
  if (S.rv.bylogin && !CR.SITE_WIDE.has(role)) throw new Refuse(403, "Only PATV admins can save evidence of a cam opened by its login.", "not_entitled");
  const uid = String(user.userId);
  if (BUSY.has(uid)) throw new Refuse(409, "Your last capture is still running.", "busy");
  const lim = require("./bridge-relay").limited("camevidence|" + uid, REQ_GAP, REQ_BURST, REQ_WINDOW);
  if (lim) throw new Refuse(429, lim, "rate");
  const secs = kind === "clip" ? Math.max(CLIP_MIN, Math.min(CLIP_MAX, Math.round(Number(secs0) || CLIP_DEF))) : 0;
  if (kind === "clip" && t + secs * 1000 > v.until) throw new Refuse(409, "Not enough of your 3 minutes left for that clip - Extend first.", "too_long");
  BUSY.add(uid);
  let buf;
  try { buf = await deps.capture(S, kind, secs); } finally { BUSY.delete(uid); }
  const saved = await store({ buf, kind, S, secs, user, role, reason });
  if (role === "owner") { try { await require("./seethrough").noteOwnerUse(user, R.id, "lines", 1); } catch (e) { /* best effort */ } }
  console.log(`[camevidence] saved ${kind} room=${R.id} by=${uid} as=${role}`);
  return { ok: true, id: saved.id, kind, expires_at: saved.expires_at };
}

// ── viewing (admins every pad; the pad's owner their pad, saved while they own it) ──
async function isAdmin(user) { try { return !!(user && user.userId && (await require("./siteperms").canId(user.userId, "chatlog.see_through"))); } catch (e) { return false; } }
async function viewRole(user, roomId) {
  if (await isAdmin(user)) return { role: "admin", since: 0 };
  try { const r = await require("./seethrough").chatRole(user, roomId); return r && r.role === "owner" ? r : null; } catch (e) { return null; }
}
async function lapsed(r, t = now()) { return Number(r.expires_at) <= t && !r.hold_at && !(await EV().heldWhy(r)); }
const seenOnce = (k, t = now()) => { const at = SEEN.get(k); if (at && t - at < VIEW_LOG_MS) return false; SEEN.delete(k); SEEN.set(k, t); if (SEEN.size > 20000) SEEN.delete(SEEN.keys().next().value); return true; };

/** The hourly sweep: past 30 days and under no hold -> the row, then the file. -> {deleted, held, failed} */
async function sweep(t = now()) {
  await init();
  const out = { deleted: 0, held: 0, failed: 0 };
  const b = base(false);
  const due = await getQuery("SELECT * FROM cam_evidence WHERE expires_at <= ? AND hold_at IS NULL ORDER BY expires_at, id LIMIT 500", [t]);
  for (const r of due) {
    if (await EV().heldWhy(r)) { out.held++; continue; }
    const gone = await tx(async () => {
      const x = (await getQuery("SELECT * FROM cam_evidence WHERE id = ? AND hold_at IS NULL", [r.id]))[0];
      if (!x || (await EV().heldWhy(x))) return false;
      const d = await runQuery("DELETE FROM cam_evidence WHERE id = ? AND hold_at IS NULL", [r.id]);
      return !!(d && d.changes === 1);
    });
    if (!gone) { out.held++; continue; }
    out.deleted++;
    if (b && !unlinkQuiet(filePath(r.file, b))) out.failed++;
  }
  for (const [k, at] of SEEN) if (t - at > VIEW_LOG_MS) SEEN.delete(k);
  if (out.deleted || out.failed) console.log(`[camevidence] sweep: ${out.deleted} expired, ${out.held} held, ${out.failed} file(s) not deleted`);
  return out;
}
/** Forget-me / account deletion of the SUBJECT: flagged (never extended; still deleted at 30 days). -> rows flagged */
async function subjectGone(keys, t = now()) {
  // (never creates the table: a forget-me on a site that never saved any cam evidence changes nothing)
  try { if (!(await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cam_evidence'")).length) return 0; } catch (e) { return 0; }
  const logins = [...new Set((Array.isArray(keys) ? keys : [keys]).map(low).filter((k) => LOGIN_RE.test(k)))];
  if (!logins.length) return 0;
  const r = await runQuery(`UPDATE cam_evidence SET subject_gone_at = ? WHERE subject_gone_at IS NULL AND subject_login IN (${logins.map(() => "?").join(",")})`, [t, ...logins]);
  return (r && r.changes) || 0;
}

function register(app, { addUser, bySlug, noTimers = false }) {
  init().catch((e) => console.error("[camevidence] init:", e.message));
  if (!noTimers) {
    const iv = setInterval(() => sweep().catch((e) => console.error("[camevidence] sweep:", e.message)), SWEEP_MS);
    if (iv.unref) iv.unref();
  }
  const guard = require("./middleware/authGuard");
  const ST = require("./seethrough"), AA = require("./adminaudit");
  const json = express.json({ limit: "4kb" });
  const noStore = (res) => { res.set("Cache-Control", "private, no-store"); res.set("Referrer-Policy", "no-referrer"); res.set("X-Robots-Tag", "noindex"); };
  const fetchOnly = (req, res) => {
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) { res.status(403).json({ ok: false, error: "Security check failed - reload the page." }); return false; }
    return true;
  };
  const fail = (res, where, e) => {
    if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, code: e.code || null, error: e.message });
    console.error(`[camevidence] ${where} failed (${String((e && (e.code || e.name)) || "error").replace(/[^\w.]/g, "").slice(0, 40)})`);
    return res.status(500).json({ ok: false, error: "Something went wrong - nothing was saved." });
  };
  const userOf = async (req) => (req.user && req.user.userId ? (await getQuery("SELECT userId, username, class, camfrogUsername FROM users WHERE userId = ?", [String(req.user.userId)]))[0] || null : null);

  // a still / a clip of the reveal the moderator is viewing: {rv, kind: still | clip, secs?, reason}
  app.post("/api/rooms/:slug/livecam/reveal/evidence", addUser, json, async (req, res) => {
    noStore(res);
    if (!fetchOnly(req, res)) return;
    try {
      const u = await userOf(req);
      if (!u) return res.status(401).json({ ok: false, error: "Sign in first." });
      const R = bySlug(req.params.slug);
      if (!R) throw new Refuse(404, "That Camfrog room isn't live right now.", "offline");
      const b = req.body || {};
      res.json(await save(u, R, String(b.rv || "").slice(0, 24), String(b.kind || ""), b.secs, b.reason));
    } catch (e) { fail(res, "save", e); }
  });
  app.get("/api/evidence/cam", addUser, async (req, res) => {
    noStore(res);
    try {
      if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
      await init();
      const admin = await isAdmin(req.user);
      const roomQ = clean(req.query.room, 80);
      let roomId = roomQ || null;
      try { const R = roomQ ? bySlug(roomQ.toLowerCase()) : null; if (R) roomId = R.id; } catch (e) { /* the id itself */ }
      const n = Math.max(1, Math.min(500, Math.floor(Number(req.query.limit) || 100)));
      let rows;
      if (admin) {
        rows = roomId ? await getQuery("SELECT * FROM cam_evidence WHERE room_id = ? ORDER BY created DESC LIMIT ?", [roomId, n])
          : await getQuery("SELECT * FROM cam_evidence ORDER BY created DESC LIMIT ?", [n]);
      } else {
        const r = roomId ? await viewRole(req.user, roomId) : null;
        if (!r) return res.status(403).json({ ok: false, error: "Only PATV admins, and a pad's owner for their own pad, can see cam evidence." });
        rows = await getQuery("SELECT * FROM cam_evidence WHERE room_id = ? AND created >= ? ORDER BY created DESC LIMIT ?", [String(roomId), Number(r.since) || 0, n]);
      }
      const live = [];
      for (const r of rows) if (!(await lapsed(r))) live.push(r);
      const ids = [...new Set(live.flatMap((r) => [r.by_user, r.hold_by]).filter(Boolean).map(String))];
      const names = new Map(ids.length ? (await getQuery(`SELECT userId, username FROM users WHERE userId IN (${ids.map(() => "?").join(",")})`, ids).catch(() => []))
        .map((x) => [String(x.userId), x.username]) : []);
      const out = live.map((r) => ({ id: r.id, room_id: r.room_id, subject: r.subject_login, veil: r.veil, kind: r.kind, secs: Number(r.secs) || 0,
        bytes: Number(r.bytes) || 0, role: r.role, by: names.get(String(r.by_user)) || null, reason: r.reason || "", created: Number(r.created),
        expires_at: Number(r.expires_at), file: "/api/evidence/cam/" + r.id + "/file",
        ...(admin ? { subject_gone: r.subject_gone_at != null, hold: r.hold_at ? { at: Number(r.hold_at), by: names.get(String(r.hold_by)) || null, why: r.hold_why || "" } : null } : {}) }));
      const key = `${req.user.userId}|camlist|${roomId || "*"}|`;
      const fresh = [...new Set(out.map((o) => low(o.subject)))].filter((s) => seenOnce(key + s));
      if (fresh.length) { await ST.init(); await tx(() => ST.logAll({ userId: String(req.user.userId), role: admin ? "admin" : "owner", scope: "cam_evidence_list", roomId, logins: fresh, ref: "cel:" + out.length })); }
      res.json({ ok: true, on: on(), admin, rows: out });
    } catch (e) { fail(res, "list", e); }
  });
  app.get("/api/evidence/cam/:id/file", addUser, async (req, res) => {
    try {
      const id = String(req.params.id || "");
      if (!ID_RE.test(id) || !req.user || !req.user.userId) return res.status(404).json({ ok: false, error: "No such evidence." });
      await init();
      const r = (await getQuery("SELECT * FROM cam_evidence WHERE id = ?", [id]))[0];
      const vr = r ? await viewRole(req.user, r.room_id) : null;
      if (!r || !vr || (vr.role === "owner" && Number(r.created) < Number(vr.since))) return res.status(404).json({ ok: false, error: "No such evidence." });
      if (await lapsed(r)) return res.status(410).json({ ok: false, error: "Its 30 days are up - it's being deleted." });
      const b = base(false), f = b ? filePath(r.file, b) : null;
      if (!f || !fs.existsSync(f)) return res.status(410).json({ ok: false, error: "Its file is gone." });
      const dl = req.query.dl === "1";
      if (dl && vr.role !== "admin") return res.status(403).json({ ok: false, error: "Only PATV admins can download evidence." });
      const uid = String(req.user.userId);
      await ST.init(); await AA.init();
      if (dl) {
        await tx(async () => {
          await ST.log({ userId: uid, role: "admin", scope: "cam_evidence_download", roomId: r.room_id, logins: [r.subject_login], ref: "cev:" + r.id });
          await AA.record({ userId: uid, username: req.user.username || null }, "evidence.cam_download", null, { id: r.id, room: r.room_id });
        });
      } else if (seenOnce(`${uid}|camview|${r.id}`)) {
        await ST.log({ userId: uid, role: vr.role, scope: "cam_evidence_view", roomId: r.room_id, logins: [r.subject_login], ref: "cev:" + r.id });
      }
      const k = KINDS[r.kind] || KINDS.still;
      res.set(headersOf(k.mime));
      res.set("Content-Disposition", dl ? `attachment; filename="patv-cam-evidence-${r.id}.${k.ext}"` : "inline");
      res.sendFile(f, { acceptRanges: true, etag: false, lastModified: false, cacheControl: false, headers: headersOf(k.mime) }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
    } catch (e) { fail(res, "file", e); }
  });
  const adminRow = async (req, res) => {
    noStore(res);
    if (!fetchOnly(req, res)) return null;
    if (!(await isAdmin(req.user))) { res.status(403).json({ ok: false, error: "Admins only." }); return null; }
    const id = String(req.params.id || "");
    await init();
    const r = ID_RE.test(id) ? (await getQuery("SELECT * FROM cam_evidence WHERE id = ?", [id]))[0] : null;
    if (!r) { res.status(404).json({ ok: false, error: "No such evidence." }); return null; }
    const why = clean((req.body || {}).why, REASON_MAX);
    if (why.length < WHY_MIN) { res.status(400).json({ ok: false, code: "why", error: "Give the reason (the request, the order, the case) - it's audited." }); return null; }
    return { r, why, uid: String(req.user.userId) };
  };
  app.post("/api/evidence/cam/:id/hold", addUser, json, async (req, res) => {
    try {
      const x = await adminRow(req, res);
      if (!x) return;
      const hold = (req.body || {}).on === true;
      await ST.init(); await AA.init();
      const done = await tx(async () => {
        const u = hold ? await runQuery("UPDATE cam_evidence SET hold_at = ?, hold_by = ?, hold_why = ? WHERE id = ?", [now(), x.uid, x.why, x.r.id])
          : await runQuery("UPDATE cam_evidence SET hold_at = NULL, hold_by = NULL, hold_why = NULL WHERE id = ?", [x.r.id]);
        if (!u || u.changes !== 1) return false;
        await ST.log({ userId: x.uid, role: "admin", scope: "cam_evidence_hold", roomId: x.r.room_id, logins: [x.r.subject_login], reason: x.why, ref: (hold ? "hold:" : "unhold:") + x.r.id });
        await AA.record({ userId: x.uid, username: req.user.username || null }, hold ? "evidence.cam_hold" : "evidence.cam_unhold", null, { id: x.r.id, room: x.r.room_id }, x.why);
        return true;
      });
      if (!done) return res.status(404).json({ ok: false, error: "No such evidence." });
      res.json({ ok: true, held: hold });
    } catch (e) { fail(res, "hold", e); }
  });
  app.post("/api/evidence/cam/:id/delete", addUser, json, async (req, res) => {
    try {
      const x = await adminRow(req, res);
      if (!x) return;
      await ST.init(); await AA.init();
      await tx(async () => {
        await ST.log({ userId: x.uid, role: "admin", scope: "cam_evidence_delete", roomId: x.r.room_id, logins: [x.r.subject_login], reason: x.why, ref: "del:" + x.r.id });
        await AA.record({ userId: x.uid, username: req.user.username || null }, "evidence.cam_delete", null, { id: x.r.id, room: x.r.room_id }, x.why);
        await runQuery("DELETE FROM cam_evidence WHERE id = ?", [x.r.id]);
      });
      const b = base(false);
      if (b) unlinkQuiet(filePath(x.r.file, b));
      res.json({ ok: true, deleted: true });
    } catch (e) { fail(res, "delete", e); }
  });
}

module.exports = { init, on, rtspAuth, save, store, sweep, subjectGone, register, KEEP_MS, CLIP_MIN, CLIP_MAX, CLIP_DEF, ID_RE, Refuse,
                   _jobs: JOBS, password,
                   _setDeps: (d) => { deps = Object.assign({}, deps, d || {}); },
                   _setClock: (f) => { clock = f || (() => Date.now()); },
                   _reset: () => { ready = null; JOBS.clear(); BUSY.clear(); SEEN.clear(); } };
