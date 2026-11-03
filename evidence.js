// evidence.js - wave 2 WP-5 (incognito / mic-stage spec E.3, E.5, H; owner answers J-7 + M addendum, M addendum 2): moderation
// EVIDENCE clips of an incognito or hidden person's mic turn. Never posted, kept 30 days (longer only under a legal hold), seen
// only by PATV admins (chatlog.see_through) and that pad's owner (their own pad, turns said in their owner era) - every access logged.
//
// Why a store of its own: a voice says who it is, so a veiled speaker's turn is never a pad post, a story, a soundboard sound, a
// voice-clone sample, a search hit or a sitemap entry. Members get the usual answers (micclip.js: an incognito turn can be clipped
// under its frog name - J-7 -, a hidden one can't). What an admin or the pad's owner keeps after a reveal is evidence only:
//   * the files live in EVIDENCE_DIR (env; default /var/lib/patv[-staging]/evidence, 0700; off Linux a folder NEXT TO the code tree)
//     - never under uploads/ or media/ (both are in the GFS backup mirror), never a public URL, random 32-hex names in 2-hex shards;
//     previews Pepe sent wait in EVIDENCE_DIR/pending/ for 10 minutes and are served only to the person who asked;
//     prod's EVIDENCE_DIR has a backup of its own (owner decision 2026-11-01; pve1's patv-backup part "evidence"): pulled nightly into
//     tank/backups/patv-evidence (mode 700) WITHOUT pending/ (previews and chunk slices are never backed up), one @daily snapshot a
//     day kept 30 days by date, never a weekly or monthly one - so a deleted or purged clip's file can sit in those snapshots up to
//     30 more days, and nothing here (the sweep, a delete, tools/evidence-purge.js) reaches them;
//   * the rows live in evidence_clips (myapp.db): pad, subject login, veil level, requester, when the turn was said, size, length,
//     the file's sha256, created / expires_at (+30 days, never moved), a per-clip legal hold, subject_gone_at (the subject used
//     forget-me or deleted their account: flagged, never extended). Deliberately NO transcript and NO hidden words: those stay in
//     bridge_veil / chat_log_veil, which go at forget-me and with the pad's chat window - myapp.db sits in 12 monthly backups;
//   * the hourly sweep (and one 90 s after a start) deletes row then file once expires_at passes, unless the clip's own hold or a chat
//     legal hold (chatlog_holds "room:<rk>" / "who:<login>" / "who:h:<hash>" / "who:u:<id>" of an account linked to the login) covers
//     it; it also drops previews past 10 minutes and orphan files (no row) older than an hour. A no-op on an empty table and a missing
//     directory. A clip past expires_at under no hold is no longer listed or served, whenever the sweep runs;
// Every access is a seethrough_log row (seethrough.js, 180 days; scopes clip_preview, clip_save, clip_play (once per viewer per clip
// per hour - an audio element asks in Ranges), clip_download, clip_list, clip_hold, clip_delete; the admin export is evidenceexport.js:
// export_evidence) plus, for what changes or copies something, an admin_audit row (evidence.preview / save / download / hold /
// unhold / delete / switch). A save is ONE dbUtils.tx: the row, its seethrough row and its admin_audit row.
//
// Two ways in (both refused unless effective(): the "Privacy wire v2" switch AND this module's own switch, /admin/bridge#evidence -
// ships OFF; turning it on is refused while privacy wire v2 is off):
//   1. the website, after a reveal: POST /api/rooms/:slug/evidence {c, reason?} for a live veiled 🎙 line (k tx, its salted id, the
//      identity server-side, revealLookup's rules: never a removed, forgotten or left-out line), by an admin or the pad's owner in
//      their era, within Pepe's 15-minute ring -> seethrough "clip_preview" + admin_audit, then a relay job "micevidence" {target,
//      tx, veil, veil_ok: <that seethrough row's id>} Pepe answers at POST /api/bridge/evidence (bot token: an .m4a of THAT login's
//      turn, the same veil, the same veil_ok). The page plays the preview (requester only), then Save (re-checks the right) or
//      Discard. Pepe never posts it, never charges for it, never keeps a copy of his own.
//   2. Camfrog: an admin or the pad's owner whose !clipmic lands on a veiled turn - Pepe uploads it (POST /api/bridge/evidence/upload,
//      bot token) and answers them by PM only. The site maps the requester's login to its PATV account and checks the same right.
// Viewing: GET /api/evidence (metadata; admins every pad, an owner their pad + era), GET /api/evidence/:id/audio (inline; ?dl=1
// admins only), POST /api/evidence/:id/hold|delete (admins). The sync answer says `evidence: 1` while effective() (bridge.js) so
// Pepe offers the Camfrog path only then. Nothing here logs a body, a login or a file name.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { runQuery, getQuery, tx } = require("./dbUtils");

const KEEP_MS = 30 * 864e5;              // an evidence clip lives 30 days from when it was saved (policy section H) - never moved
const PREVIEW_TTL = 10 * 60e3;           // a preview Pepe sent waits this long for Save / Discard
const PENDING_HOLD = 60e3;               // Pepe has this long to answer a request
const JOB_TTL = 3 * 60e3;                // a request's record (it failed or timed out) goes after this
const LINE_MAX_AGE = 15 * 60e3;          // Pepe's ring keeps a turn 15 minutes (pepe_micclip MAX_AGE)
const MAX_BYTES = 6 * 1024 * 1024;
const ORPHAN_MS = 3600e3;                // a file with no row, older than this, goes
const PLAY_LOG_MS = 3600e3;              // one clip_play / clip_list row per viewer per clip (per list) per hour
const SWEEP_MS = 3600e3;
const OPEN_PER_USER = 2;
const REQ_GAP = 10e3, REQ_BURST = 6, REQ_WINDOW = 10 * 60e3;
const REASON_MAX = 200, WHY_MIN = 3;
const ID_RE = /^ev[a-f0-9]{16}$/;
const JOB_RE = /^w[a-f0-9]{16}$/;
const FILE_RE = /^[a-f0-9]{32}\.m4a$/;
const PART_RE = /^(?:w[a-f0-9]{16}\.m4a|up-[a-f0-9]{16}\.part)$/;
const TX_RE = /^tx-[0-9a-f]{8,32}$/;
const LOGIN_RE = /^[\w.\-]{1,40}$/;
const VEILS = new Set(["incognito", "hidden"]);
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const PRIVATE_HEADERS = {
  "Content-Type": "audio/mp4",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "private, no-store, max-age=0",
  "Pragma": "no-cache",
  "Content-Security-Policy": "default-src 'none'; media-src 'self'; sandbox",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Robots-Tag": "noindex, noarchive",
  "Referrer-Policy": "no-referrer",
};

let clock = () => Date.now();
const now = () => clock();
let STATE = { on: false, at: null, by: null, first_on: null };
let loaded = false, ready = null;
const PEND = new Map();                   // relay job id -> a preview {id, roomId, slug, c, tx, target, veil, saidAt, userId, username, role, stId, reason, state, status, ts, done, secs}
const SEEN = new Map();                   // "userId|what|id" -> ms: the hourly play / list log
class Refuse extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code || null; this.refuse = true; } }

const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();
const dayText = (t) => { const d = new Date(Number(t)); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
function cleanState(o) {
  const v = o && typeof o === "object" ? o : {};
  const n = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.floor(Number(x)) : null);
  return { on: v.on === true, at: n(v.at), by: typeof v.by === "string" ? v.by.slice(0, 60) : null, first_on: n(v.first_on) };
}

// ── setup + the switch (chatlog_meta 'evidence' {on, at, by, first_on}; keep-staging's CHATLOG list keeps staging's own) ──
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS chatlog_meta (key TEXT PRIMARY KEY, value TEXT)");
      // (veil is 'incognito' | 'hidden' - checked by store(), the one writer; no CHECK clause: the merge test seeds every table generically)
      await runQuery(`CREATE TABLE IF NOT EXISTS evidence_clips (id TEXT PRIMARY KEY, room_id TEXT NOT NULL, rk INTEGER, c INTEGER, tx TEXT,
                      subject_login TEXT NOT NULL, veil TEXT NOT NULL, said_at INTEGER NOT NULL, secs REAL,
                      bytes INTEGER, sha256 TEXT, file TEXT NOT NULL, by_user TEXT NOT NULL, role TEXT NOT NULL, via TEXT NOT NULL, reason TEXT,
                      st_id INTEGER, created INTEGER NOT NULL, expires_at INTEGER NOT NULL, hold_at INTEGER, hold_by TEXT, hold_why TEXT,
                      subject_gone_at INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS evidence_clips_room ON evidence_clips (room_id, created)");
      await runQuery("CREATE INDEX IF NOT EXISTS evidence_clips_exp ON evidence_clips (expires_at)");
      await runQuery("CREATE INDEX IF NOT EXISTS evidence_clips_subject ON evidence_clips (subject_login)");
      // 1.99aht transcripts bar review fix (TXBAR-ST-2 / ST-3 / F1): tm = 1 - the turn of a !transcripts off 🎙 bar (its veil is "hidden" for
      // every gate, as the bar's): its clip_save row names that toggle (ref ev:<id>:tx), the lists and exports say "transcripts off"
      // instead of passing it off as !bridge hide, and the privacy text describes it while one is kept (privwire.txKept)
      const ecols = new Set((await getQuery("PRAGMA table_info(evidence_clips)")).map((x) => x.name));
      if (!ecols.has("tm")) { try { await runQuery("ALTER TABLE evidence_clips ADD COLUMN tm INTEGER"); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; } }
      const r = (await getQuery("SELECT value FROM chatlog_meta WHERE key = 'evidence'"))[0];
      try { STATE = cleanState(r ? JSON.parse(r.value) : null); } catch (e) { STATE = cleanState(null); }
      loaded = true;
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
/** This module's own switch (false until loaded: fails closed). */
const isOn = () => loaded && STATE.on === true;
/** May evidence clips be made now? The switch AND privacy wire v2 (veiled turns exist only on v2). Synchronous. */
function effective() {
  if (!isOn()) return false;
  try { return require("./privwire").isOn(); } catch (e) { return false; }
}
function state() { return { ...STATE, loaded }; }
/** Flip the switch (user = {userId, username}). Turning it ON while privacy wire v2 is off is refused (409 privwire_off). Audited
 *  twice (admin_audit evidence.switch + a room_events row), like privwire.js. */
async function setOn(want, user) {
  await init();
  const on = want === true;
  if (on && !require("./privwire").isOn()) throw new Refuse(409, "Turn privacy wire v2 on first - evidence clips exist only on it.", "privwire_off");
  if (STATE.on === on) return { ...state(), unchanged: true };
  const t = now();
  const next = cleanState({ on, at: t, by: user && user.username ? user.username : null, first_on: STATE.first_on || (on ? t : null) });
  await runQuery("INSERT INTO chatlog_meta (key, value) VALUES ('evidence', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [JSON.stringify(next)]);
  STATE = next;
  try { await require("./adminaudit").record(user || { userId: "system" }, "evidence.switch", null, { on }); } catch (e) { console.error("[evidence] audit:", e.message); }
  try { await require("./rooms").event(null, "evidence.switch", user && user.username ? user.username : null, `evidence clips ${on ? "on" : "off"}`); } catch (e) { /* best effort */ }
  console.log(`[evidence] evidence clips switched ${on ? "ON" : "OFF"} (${(user && user.username) || "?"})`);
  return state();
}
/** 1.99aht transcripts bar review fix (F1): is an evidence clip of a !transcripts off bar's turn (tm) still kept? (privwire.txKept - the
 *  privacy text keeps describing those bars while one is.) Only this module reads the store. */
async function anyTxClip() {
  await init();
  return (await getQuery("SELECT 1 FROM evidence_clips WHERE tm = 1 LIMIT 1")).length > 0;
}
try { require("./privwire").setTxClipProbe(anyTxClip); } catch (e) { /* (privwire's own tests load it alone) */ }
/** For the privacy page (terms.js -> privacy.ejs locals.evidence): {on, any, on_at, on_day} while evidence clips can be made, or while
 *  any are still kept (the retention row stays true until the last one is gone); null otherwise - the page reads as before. */
async function privacyCopy() {
  await init();
  const eff = effective();
  let n = 0;
  try { n = Number((await getQuery("SELECT COUNT(*) AS n FROM evidence_clips"))[0].n) || 0; } catch (e) { n = 0; }
  if (!eff && !n) return null;
  const at = STATE.first_on || null;
  return { on: eff, any: n > 0, on_at: at, on_day: at ? dayText(at) : null };
}

// ── the private directory (dmmedia.js's pattern) ──
function candidateDir() {
  if (process.env.EVIDENCE_DIR) return path.resolve(process.env.EVIDENCE_DIR);
  if (process.platform === "linux") return process.env.STAGING ? "/var/lib/patv-staging/evidence" : "/var/lib/patv/evidence";
  return path.resolve(__dirname, "..", path.basename(__dirname) + "-evidence");
}
function pickDir() {
  if (process.env.EVIDENCE_DIR) return path.resolve(process.env.EVIDENCE_DIR);
  if (process.platform === "linux") {
    const d = candidateDir();
    try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (e) { /* not root: below */ }
  }
  return path.resolve(__dirname, "..", path.basename(__dirname) + "-evidence");
}
let DIR = null;
/** The store's directory - made (0700) the first time something is written, never at boot. */
function dir() {
  if (!DIR) {
    DIR = pickDir();
    fs.mkdirSync(path.join(DIR, "pending"), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(DIR, 0o700); } catch (e) { /* not ours / Windows */ }
    console.log("[evidence] store dir ready");
  }
  return DIR;
}
/** The directory if it exists already (the sweep never creates it). */
function existingDir() {
  if (DIR) return DIR;
  try { const d = candidateDir(); return fs.existsSync(d) ? d : null; } catch (e) { return null; }
}
function _setDir(d) { DIR = d; fs.mkdirSync(path.join(DIR, "pending"), { recursive: true }); }
const filePath = (name, base = dir()) => (FILE_RE.test(String(name || "")) ? path.join(base, name.slice(0, 2), name) : null);
const pendingPath = (id, base = dir()) => (JOB_RE.test(String(id || "")) ? path.join(base, "pending", id + ".m4a") : null);
function unlinkQuiet(p) {
  if (!p) return true;
  try { fs.unlinkSync(p); return true; } catch (e) { return !!(e && e.code === "ENOENT"); }
}
const isM4a = (buf) => !!buf && buf.length >= 64 && buf.length <= MAX_BYTES && buf.toString("latin1", 4, 8) === "ftyp";

// ── who may (the see-through rule, seethrough.js: admins every pad and era; a pad's owner, their pad, turns said in their era) ──
async function role(user, roomId, saidAt) {
  if (!user || !user.userId || !roomId) return null;
  const ST = require("./seethrough");
  const r = await ST.chatRole(user, roomId);
  return r && ST.mayReveal(r, saidAt) ? r : null;
}
async function isAdmin(user) {
  if (!user || !user.userId) return false;
  try { return !!(await require("./siteperms").canId(user.userId, "chatlog.see_through")); } catch (e) { return false; }
}
async function rkOf(roomId) {
  try { const r = (await getQuery("SELECT rk FROM chatlog_rooms WHERE room_id = ?", [String(roomId)]))[0]; return r ? Number(r.rk) : null; } catch (e) { return null; }
}
/** Is a clip kept past its 30 days? Its own hold, or a chat legal hold on its pad or its subject (chatlogmod's keys, read fresh from
 *  chatlog_holds). -> "clip" | "room" | "who" | "error" (can't tell: kept - a hold is the law's) | null */
async function heldWhy(row) {
  if (row.hold_at) return "clip";
  try {
    if (!(await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'chatlog_holds'")).length) return null;
    const login = low(row.subject_login);
    const keys = ["who:" + login, "who:h:" + require("./chatlog").hash(login)];
    const rk = row.rk != null ? Number(row.rk) : await rkOf(row.room_id);
    if (rk != null) keys.push("room:" + rk);
    const accts = await getQuery("SELECT userId FROM users WHERE lower(camfrogUsername) = ?", [login]).catch(() => []);
    for (const a of accts) keys.push("who:u:" + low(a.userId));
    const hit = (await getQuery(`SELECT key FROM chatlog_holds WHERE key IN (${keys.map(() => "?").join(",")}) LIMIT 1`, keys))[0];
    return hit ? (String(hit.key).startsWith("room:") ? "room" : "who") : null;
  } catch (e) { return "error"; }
}

// ── previews (memory + pending/) ──
const isOpen = (p) => p.state === "pending";
function timeOut(p, t = now()) {
  if (!isOpen(p) || t - p.ts <= PENDING_HOLD) return false;
  p.state = "failed"; p.status = "Pepe didn't answer in time - try again."; p.done = t;
  try { const relay = require("./bridge-relay"); const j = relay._jobs.get(p.id); if (j && j.state === "pending") relay._jobs.delete(p.id); } catch (e) { /* none */ }
  return true;
}
function dropPending(p) {
  if (!p) return;
  const base = existingDir();
  if (base) unlinkQuiet(pendingPath(p.id, base));
  PEND.delete(p.id);
}
function holdsSlot(p, t = now()) { timeOut(p, t); return isOpen(p) || (p.state === "ready" && t - p.done < PREVIEW_TTL); }
function previewView(p, slug) {
  timeOut(p);
  const t = now();
  const live = p.state === "ready" && t - p.done < PREVIEW_TTL;
  return { ok: true, id: p.id, state: live || p.state !== "ready" ? p.state : "expired", status: p.status || "", secs: p.secs || 0, veil: p.veil,
           audio: live ? "/api/rooms/" + encodeURIComponent(slug) + "/evidence/" + p.id + "/audio" : null, until: live ? p.done + PREVIEW_TTL : null };
}

/** Write one evidence clip: the file into the store (moved from `from`, or `buf` written), then ONE dbUtils.tx - the row, its
 *  seethrough_log row (clip_save) and its admin_audit row (evidence.save). The file goes again if the transaction fails. -> {id, expires_at} */
async function store({ from = null, buf = null, roomId, c = null, txId = null, subject, veil, saidAt, secs, user, role: by, via, reason = "", tm = false }) {
  const ST = require("./seethrough"), AA = require("./adminaudit");
  await init(); await ST.init(); await AA.init();
  if (!LOGIN_RE.test(subject) || !VEILS.has(veil)) throw new Refuse(400, "bad evidence", "bad_request");
  const base = dir();
  const id = "ev" + crypto.randomBytes(8).toString("hex");
  const file = crypto.randomBytes(16).toString("hex") + ".m4a";
  const dest = filePath(file, base);
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  let data = buf;
  if (data) {
    const part = path.join(base, "pending", "up-" + crypto.randomBytes(8).toString("hex") + ".part");
    fs.writeFileSync(part, data, { mode: 0o600 });
    fs.renameSync(part, dest);
  } else {
    fs.renameSync(from, dest);
    data = fs.readFileSync(dest);
  }
  const t = now(), exp = t + KEEP_MS;
  const rk = await rkOf(roomId);
  const why = clean(reason, REASON_MAX) || null;
  try {
    await tx(async () => {
      const st = await ST.log({ userId: user.userId, role: by, scope: "clip_save", roomId, logins: [subject], reason: why || "", ref: "ev:" + id + (tm ? ":tx" : "") });
      if (!st) throw new Error("evidence: no see-through row");          // never a clip without its audit row
      await runQuery(`INSERT INTO evidence_clips (id, room_id, rk, c, tx, subject_login, veil, said_at, secs, bytes, sha256, file, by_user, role, via, reason,
                      st_id, created, expires_at, tm) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                     [id, String(roomId), rk, c == null ? null : Number(c), txId && TX_RE.test(txId) ? txId : null, subject, veil, Math.floor(Number(saidAt) || t),
                      Math.max(0, Math.min(600, Number(secs) || 0)), data.length, crypto.createHash("sha256").update(data).digest("hex"), file,
                      String(user.userId), String(by), String(via), why, st, t, exp, tm ? 1 : null]);
      await AA.record({ userId: user.userId, username: user.username || null }, "evidence.save", null, { id, room: String(roomId), veil, via, st }, why);
    });
  } catch (e) {
    unlinkQuiet(dest);
    throw e;
  }
  return { id, expires_at: exp };
}

/** The hourly sweep (and once shortly after a start). -> {deleted, held, pending, orphans, failed}
 *  Review fixes (WP5-ACC-3 / R1 / R7): the due rows are walked with a keyset cursor (expires_at, id) - every due row is looked at once
 *  per sweep, so rows kept by a chat legal hold (or anything else) at the head of the queue never stall the rest; each row goes FIRST,
 *  re-checked inside one dbUtils.tx (a hold placed since the page was read keeps it, file and all), and its file only once the row is
 *  gone - a file that won't go is an orphan then, retried by the orphan pass below (counted `failed`). */
const SWEEP_PAGE = 200;
async function sweep(t = now()) {
  await init();
  const out = { deleted: 0, held: 0, pending: 0, orphans: 0, failed: 0 };
  for (const p of [...PEND.values()]) {
    timeOut(p, t);
    if (isOpen(p) ? t - p.ts > JOB_TTL : t - (p.done || p.ts) > PREVIEW_TTL) { dropPending(p); out.pending++; }
  }
  const base = existingDir();
  let cur = null;
  for (;;) {
    const due = cur
      ? await getQuery(`SELECT * FROM evidence_clips WHERE expires_at <= ? AND hold_at IS NULL AND (expires_at > ? OR (expires_at = ? AND id > ?))
                        ORDER BY expires_at, id LIMIT ?`, [t, cur.e, cur.e, cur.id, SWEEP_PAGE])
      : await getQuery("SELECT * FROM evidence_clips WHERE expires_at <= ? AND hold_at IS NULL ORDER BY expires_at, id LIMIT ?", [t, SWEEP_PAGE]);
    for (const r of due) {
      if (await heldWhy(r)) { out.held++; continue; }
      const what = await tx(async () => {
        const x = (await getQuery("SELECT * FROM evidence_clips WHERE id = ? AND hold_at IS NULL", [r.id]))[0];
        if (!x) return (await getQuery("SELECT 1 FROM evidence_clips WHERE id = ?", [r.id])).length ? "held" : "gone";
        if (await heldWhy(x)) return "held";
        const d = await runQuery("DELETE FROM evidence_clips WHERE id = ? AND hold_at IS NULL", [r.id]);
        return d && d.changes === 1 ? "deleted" : "held";
      });
      if (what === "held") { out.held++; continue; }
      if (what !== "deleted") continue;                              // (an admin deleted it meanwhile: their route took the file)
      out.deleted++;
      if (base && !unlinkQuiet(filePath(r.file, base))) out.failed++;  // an orphan now: the orphan pass below retries it every sweep
    }
    if (due.length < SWEEP_PAGE) break;
    const last = due[due.length - 1];
    cur = { e: Number(last.expires_at), id: String(last.id) };
  }
  if (base) {
    // previews nobody saved (a restart forgets them) and files with no row (a save that failed half-way)
    try {
      for (const f of fs.readdirSync(path.join(base, "pending"))) {
        if (!PART_RE.test(f)) continue;
        const p = path.join(base, "pending", f), id = f.replace(/\.m4a$/, "");
        let st = null;
        try { st = fs.statSync(p); } catch (e) { continue; }
        if (!PEND.has(id) && t - st.mtimeMs > PREVIEW_TTL && unlinkQuiet(p)) out.pending++;
      }
    } catch (e) { /* no pending dir */ }
    try {
      const known = new Set((await getQuery("SELECT file FROM evidence_clips")).map((r) => r.file));
      for (const sh of fs.readdirSync(base)) {
        if (!/^[a-f0-9]{2}$/.test(sh)) continue;
        for (const f of fs.readdirSync(path.join(base, sh))) {
          if (!FILE_RE.test(f) || known.has(f)) continue;
          const p = path.join(base, sh, f);
          let st = null;
          try { st = fs.statSync(p); } catch (e) { continue; }
          if (t - st.mtimeMs <= ORPHAN_MS) continue;
          if (unlinkQuiet(p)) out.orphans++; else out.failed++;
        }
      }
    } catch (e) { /* nothing there */ }
  }
  for (const [k, at] of SEEN) if (t - at > PLAY_LOG_MS) SEEN.delete(k);
  if (out.deleted || out.orphans || out.failed) {
    (out.failed ? console.error : console.log)(`[evidence] sweep: ${out.deleted} expired clip(s) deleted, ${out.held} kept under a hold, ${out.orphans} orphan file(s)` +
      (out.failed ? `, ${out.failed} file(s) that couldn't be deleted (retried every sweep)` : ""));
  }
  return out;
}
/** Is a clip past its 30 days and under no hold (its own or a chat legal hold)? Such a clip is gone for everyone at expires_at, whenever
 *  the sweep runs (review fix R6: the list and the audio stop serving it then). */
async function lapsed(r, t = now()) {
  return Number(r.expires_at) <= t && !r.hold_at && !(await heldWhy(r));
}

/** Forget-me / account deletion of the SUBJECT (owner question Q1, default): their clips are flagged (subject_gone_at), never extended,
 *  and still go at their 30 days; a preview of theirs waiting for Save goes now. keys = logins (u:<id> keys are ignored). -> rows flagged */
async function subjectGone(keys, t = now()) {
  await init();
  const logins = [...new Set((Array.isArray(keys) ? keys : [keys]).map(low).filter((k) => LOGIN_RE.test(k)))];
  if (!logins.length) return 0;
  for (const p of [...PEND.values()]) if (logins.includes(p.target)) dropPending(p);
  const r = await runQuery(`UPDATE evidence_clips SET subject_gone_at = ? WHERE subject_gone_at IS NULL AND subject_login IN (${logins.map(() => "?").join(",")})`, [t, ...logins]);
  return (r && r.changes) || 0;
}

/** Reveal answers (seethrough.js) carry ev: 1 on a line that can be saved as evidence right now - a live veiled 🎙 line with its id,
 *  inside Pepe's 15 minutes, while effective(). A flag only (like rv). */
function offerable(R, c, t = now()) {
  if (!effective() || !R || !Array.isArray(R.feed)) return false;
  const it = R.feed.find((x) => x && Number(x.c) === Number(c));
  return !!(it && it.k === "tx" && TX_RE.test(String(it.id || "")) && it._vz && it._vz.login && VEILS.has(it._vz.kind) && !it.rm_at && !it.purged &&
            t - Number(it.ts) <= LINE_MAX_AGE);
}

/** Pad settings, chat tab: the "Moderation evidence" card - only for the pad's OWNER (never Staff, who can open the page; admins use
 *  /admin/bridge), and only while evidence clips can be made or the pad has some. -> {on} | null */
async function padCard(roomId, viewer) {
  try {
    await init();
    if (!viewer || !viewer.userId) return null;
    const r = await require("./seethrough").chatRole(viewer, roomId);
    if (!r || r.role !== "owner") return null;
    // (review fix WP5-ACC-6: only the clips of THEIR era - the ones GET /api/evidence shows them - never a sign of an earlier owner's)
    const n = Number((await getQuery("SELECT COUNT(*) AS n FROM evidence_clips WHERE room_id = ? AND said_at >= ?", [String(roomId), Number(r.since) || 0]))[0].n) || 0;
    if (!effective() && !n) return null;
    return { on: effective(), n };
  } catch (e) { return null; }
}

// (review fix WP5-ACC-8: subject_gone - the subject used forget-me or deleted their account - is an ADMIN's to see; a pad's owner never
// learns that private fact about a login)
function rowView(r, admin, names) {
  return { id: r.id, room_id: r.room_id, subject: r.subject_login, veil: r.veil, ...(Number(r.tm) === 1 ? { tx: true } : {}),   // (tx: a !transcripts off bar's turn)
           said_at: Number(r.said_at), secs: Number(r.secs) || 0, bytes: Number(r.bytes) || 0,
           role: r.role, via: r.via, by: names.get(String(r.by_user)) || null, reason: r.reason || "", created: Number(r.created), expires_at: Number(r.expires_at),
           audio: "/api/evidence/" + r.id + "/audio",
           ...(admin ? { subject_gone: r.subject_gone_at != null, hold: r.hold_at ? { at: Number(r.hold_at), by: names.get(String(r.hold_by)) || null, why: r.hold_why || "" } : null } : {}) };
}
async function namesOf(ids) {
  const list = [...new Set(ids.filter(Boolean).map(String))];
  if (!list.length) return new Map();
  try {
    const rows = await getQuery(`SELECT userId, username FROM users WHERE userId IN (${list.map(() => "?").join(",")})`, list);
    return new Map(rows.map((x) => [String(x.userId), x.username]));
  } catch (e) { return new Map(); }
}
const seenLately = (k, t = now()) => { const at = SEEN.get(k); return !!(at && t - at < PLAY_LOG_MS); };
const markSeen = (k, t = now()) => { SEEN.delete(k); SEEN.set(k, t); if (SEEN.size > 20000) SEEN.delete(SEEN.keys().next().value); };
const seenOnce = (k, t = now()) => { if (seenLately(k, t)) return false; markSeen(k, t); return true; };
const BOOT_SWEEP_MS = 90e3;              // review fix R6: a sweep shortly after every start (a restart no longer moves it an hour out)
// Pepe's evidence bodies in chunks (botupload.js, nginx's 1m): their slices are staged HERE, in the store's pending/ (outside uploads/, and
// the evidence backup leaves pending/ out - so outside every backup) - never in uploads/.botupload (review fix R2)
const CHUNK_TARGETS = ["/api/bridge/evidence", "/api/bridge/evidence/upload"];
const chunkStage = (create) => { const b = create ? dir() : existingDir(); return b ? path.join(b, "pending", "chunks") : null; };

function register(app, { isBotToken, addUser, bySlug, isLive, noTimers = false }) {
  init().catch((e) => console.error("[evidence] init:", e.message));
  if (!noTimers) {
    const iv = setInterval(() => sweep().catch((e) => console.error("[evidence] sweep:", e.message)), SWEEP_MS);
    if (iv.unref) iv.unref();
    const boot = setTimeout(() => sweep().catch((e) => console.error("[evidence] sweep:", e.message)), BOOT_SWEEP_MS);
    if (boot.unref) boot.unref();
  }
  try { const BU = require("./botupload"); for (const t of CHUNK_TARGETS) BU.stageAt(t, chunkStage); } catch (e) { console.error("[evidence] chunk staging:", e.message); }
  const SP = require("./siteperms");
  const guard = require("./middleware/authGuard");
  const relay = require("./bridge-relay");
  const ST = require("./seethrough");
  const AA = require("./adminaudit");
  const json = express.json({ limit: "4kb" });
  // Pepe's bodies carry audio and a login: index.js skips the global parser for these paths, and a refused body is logged by its
  // type and status only (Node's JSON errors quote the body)
  const botJson = (label) => {
    const p = express.json({ limit: "9mb" });
    return (req, res, next) => p(req, res, (err) => {
      if (!err) return next();
      const status = Number(err.status) === 413 ? 413 : 400;
      console.error(`[evidence] ${label}: body refused (${String(err.type || "parse").replace(/[^\w.]/g, "").slice(0, 40)}, ${status})`);
      res.status(status).json({ ok: false, error: status === 413 ? "too_large" : "bad_body" });
    });
  };
  const noStore = (res) => { res.set("Cache-Control", "private, no-store"); res.set("Referrer-Policy", "no-referrer"); res.set("X-Robots-Tag", "noindex"); };
  const fetchOnly = (req, res) => {
    if (!req.is("application/json") || !guard.sameOriginFetch(req)) { res.status(403).json({ ok: false, error: "Security check failed - reload the page." }); return false; }
    return true;
  };
  const fail = (res, where, e) => {
    if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, code: e.code || null, error: e.message });
    console.error(`[evidence] ${where} failed (${String((e && (e.code || e.name)) || "error").replace(/[^\w.]/g, "").slice(0, 40)})`);
    return res.status(500).json({ ok: false, error: "Something went wrong - nothing was saved." });
  };
  const OFF = { ok: false, code: "evidence_off", error: "Evidence clips are switched off." };
  const NOT = { ok: false, code: "not_evidence", error: "That line can't be saved as evidence." };
  const NOT_ENTITLED = { ok: false, code: "not_entitled", error: "Only PATV admins, and a pad's owner in their own pad, can save evidence clips." };
  const mine = (req, res) => {
    const p = PEND.get(String(req.params.id || ""));
    const R = bySlug(req.params.slug);
    if (!p || !R || p.roomId !== R.id || !req.user || p.userId !== String(req.user.userId)) { res.status(404).json({ ok: false, error: "No such clip." }); return null; }
    return { p, R };
  };
  // review fix WP5-ACC-7: the preview's status and audio re-check the right (and the switches) on every ask - a requester who lost it
  // (a pad transferred, see-through taken away, evidence clips switched off) hears nothing more, and the preview goes at once
  const mineStill = async (req, res) => {
    const x = mine(req, res);
    if (!x) return null;
    const rl = effective() ? await role(req.user, x.R.id, x.p.saidAt) : null;
    if (rl) return x;
    const j = relay._jobs.get(x.p.id);
    if (j && j.state === "pending") relay._jobs.delete(x.p.id);
    dropPending(x.p);
    res.status(404).json({ ok: false, error: "No such clip." });
    return null;
  };

  // ── 1. the website: ask Pepe for a veiled 🎙 line's audio (after a reveal) ──
  app.post("/api/rooms/:slug/evidence", addUser, json, async (req, res) => {
    noStore(res);
    if (!fetchOnly(req, res)) return;
    try {
      if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
      await init();
      if (!effective()) return res.status(409).json(OFF);
      const R = bySlug(req.params.slug);
      if (!R) return res.status(404).json({ ok: false, error: "That Camfrog room isn't live right now." });
      // review fix XT-3: the role FIRST, before anything about the line (seethrough's chatCtx and the tile Reveal ask in this order): a
      // caller with no see-through on this pad gets the same 403 for every cursor - never which are veiled 🎙 turns, or whose
      // identity row is gone. (The per-line era check, role(..., it.ts), stays below.)
      if (!(await ST.chatRole(req.user, R.id))) return res.status(403).json(NOT_ENTITLED);
      if (!isLive(R)) return res.status(404).json({ ok: false, error: "That Camfrog room isn't live right now." });
      const c = Number((req.body || {}).c);
      const it = Number.isFinite(c) && c > 0 ? (R.feed || []).find((x) => x && Number(x.c) === c) : null;
      if (!it || it.k !== "tx" || !TX_RE.test(String(it.id || "")) || !it._vz || !LOGIN_RE.test(String(it._vz.login || "")) || !VEILS.has(it._vz.kind) || !it.u || !it.u.anon) {
        return res.status(404).json(NOT);
      }
      // revealLookup's rules: never a line taken down, forgotten (its identity row gone) or left out for members now
      if (!(await require("./bridge").revealLookup(R.id, c))) return res.status(404).json(NOT);
      const rl = await role(req.user, R.id, it.ts);
      if (!rl) return res.status(403).json(NOT_ENTITLED);
      if (now() - Number(it.ts) > LINE_MAX_AGE) return res.status(410).json({ ok: false, code: "too_old", error: "Pepe keeps mic audio for 15 minutes - that turn is gone." });
      const uid = String(req.user.userId);
      for (const p of PEND.values()) if (p.userId === uid && p.roomId === R.id && p.c === c && holdsSlot(p)) return res.json({ ok: true, id: p.id, again: true });
      const open = [...PEND.values()].filter((p) => p.userId === uid && holdsSlot(p));
      if (open.length >= OPEN_PER_USER) return res.status(429).json({ ok: false, code: "open", error: "Save or discard the evidence clips you have first." });
      const lim = relay.limited("evidence|" + uid, REQ_GAP, REQ_BURST, REQ_WINDOW);
      if (lim) return res.status(429).json({ ok: false, error: lim });
      const login = low(it._vz.login), veil = it._vz.kind, reason = clean((req.body || {}).reason, REASON_MAX);
      const jid = "w" + crypto.randomBytes(8).toString("hex");
      await ST.init(); await AA.init();
      const stId = await tx(async () => {
        // (1.99aht transcripts bar: ":tx" = the turn of a !transcripts off 🎙 bar - the log says which toggle was seen through)
        const st = await ST.log({ userId: uid, role: rl.role, scope: "clip_preview", roomId: R.id, logins: [login], reason,
                                  ref: "evp:" + jid + (it.tm === 1 ? ":tx" : "") });
        if (!st) throw new Error("evidence: no see-through row");
        await AA.record({ userId: uid, username: req.user.username || null }, "evidence.preview", null, { room: R.id, c, veil, st }, reason || null);
        return st;
      });
      PEND.set(jid, { id: jid, roomId: R.id, slug: R.slug || String(req.params.slug), c, tx: it.id, tm: it.tm === 1, target: login, veil, saidAt: Number(it.ts), userId: uid,
                      username: req.user.username || null, role: rl.role, stId, reason, state: "pending", status: "", ts: now(), done: 0, secs: 0 });
      relay.newJob({ id: jid, kind: "micevidence", roomId: R.id, userId: uid, username: req.user.username || null, camfrog: "", target: login, tx: it.id, veil,
                     veil_ok: stId, viewers: new Set([uid]) });
      console.log(`[evidence] preview asked room=${R.id} by=${uid} as=${rl.role} job=${jid}`);
      res.json({ ok: true, id: jid });
    } catch (e) { fail(res, "request", e); }
  });

  // ── 2. Pepe: the preview (or why not) ──
  app.post("/api/bridge/evidence", botJson("answer"), async (req, res) => {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    const p = PEND.get(String(b.id || ""));
    if (!p) return res.status(404).json({ ok: false, error: "unknown" });
    const j = relay._jobs.get(p.id);
    if (timeOut(p) || !isOpen(p)) return res.status(410).json({ ok: false, error: "too late" });
    if (String(b.state || "") === "ok") {
      let buf = null;
      try { buf = Buffer.from(String(b.data || ""), "base64"); } catch (e) { buf = null; }
      // THAT login's turn, at the same veil, answering THIS audited request (veil_ok = its seethrough row)
      if (!isM4a(buf) || low(b.target) !== p.target || String(b.veil || "") !== p.veil || Number(b.veil_ok) !== p.stId) {
        p.state = "failed"; p.status = "Pepe's clip couldn't be read."; p.done = now();
      } else {
        try {
          fs.writeFileSync(pendingPath(p.id), buf, { mode: 0o600 });
          p.secs = Math.max(1, Math.min(600, Number(b.secs) || 1));
          p.state = "ready"; p.status = "ok"; p.done = now();
        } catch (e) {
          p.state = "failed"; p.status = "The website couldn't keep the clip."; p.done = now();
          console.error(`[evidence] preview write failed (${String(e && e.code || "error").replace(/[^\w.]/g, "")})`);
        }
      }
    } else {
      p.state = "failed"; p.status = relay.clean(b.status, 160) || "Pepe couldn't clip that."; p.done = now();
    }
    if (j) { j.state = "done"; j.doneAt = now(); j.result = { ok: p.state === "ready", msg: p.status }; }
    res.json({ ok: true });
  });

  // ── 3. the requester's preview: status, audio (10 minutes), discard, save ──
  app.get("/api/rooms/:slug/evidence/:id", addUser, async (req, res) => {
    noStore(res);
    try {
      const x = await mineStill(req, res);
      if (x) res.json(previewView(x.p, req.params.slug));
    } catch (e) { fail(res, "status", e); }
  });
  app.get("/api/rooms/:slug/evidence/:id/audio", addUser, async (req, res) => {
    let x = null;
    try { x = await mineStill(req, res); } catch (e) { return fail(res, "preview audio", e); }
    if (!x) return;
    const base = existingDir(), f = base ? pendingPath(x.p.id, base) : null;
    if (x.p.state !== "ready" || now() - x.p.done >= PREVIEW_TTL || !f || !fs.existsSync(f)) return res.status(410).json({ ok: false, error: "That clip expired." });
    res.set(PRIVATE_HEADERS);
    res.set("Content-Disposition", "inline");
    res.sendFile(f, { acceptRanges: true, etag: false, lastModified: false, cacheControl: false, headers: PRIVATE_HEADERS }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
  });
  app.post("/api/rooms/:slug/evidence/:id/discard", addUser, json, (req, res) => {
    noStore(res);
    if (!fetchOnly(req, res)) return;
    const x = mine(req, res);
    if (!x) return;
    const j = relay._jobs.get(x.p.id);
    if (j && j.state === "pending") relay._jobs.delete(x.p.id);
    dropPending(x.p);
    res.json({ ok: true });
  });
  app.post("/api/rooms/:slug/evidence/:id/save", addUser, json, async (req, res) => {
    noStore(res);
    if (!fetchOnly(req, res)) return;
    try {
      const x = mine(req, res);
      if (!x) return;
      const { p, R } = x;
      await init();
      if (!effective()) return res.status(409).json(OFF);
      if (p.state !== "ready" || now() - p.done >= PREVIEW_TTL) return res.status(410).json({ ok: false, error: "That clip expired - ask for it again." });
      const rl = await role(req.user, R.id, p.saidAt);                 // the right, again (an owner who lost the pad can't save)
      if (!rl) return res.status(403).json(NOT_ENTITLED);
      if (p.saving) return res.status(409).json({ ok: false, error: "It's being saved." });
      p.saving = true;
      let saved = null;
      try {
        saved = await store({ from: pendingPath(p.id), roomId: R.id, c: p.c, txId: p.tx, subject: p.target, veil: p.veil, saidAt: p.saidAt, secs: p.secs,
                              user: { userId: String(req.user.userId), username: req.user.username || null }, role: rl.role, via: "web",
                              reason: clean((req.body || {}).reason, REASON_MAX) || p.reason, tm: p.tm === true });
      } finally { p.saving = false; }
      PEND.delete(p.id);
      if (rl.role === "owner") { try { await ST.noteOwnerUse(req.user, R.id, "lines", 1); } catch (e) { /* the E.6 notice is best effort */ } }
      console.log(`[evidence] saved via=web room=${R.id} by=${req.user.userId} as=${rl.role}`);
      res.json({ ok: true, id: saved.id, expires_at: saved.expires_at });
    } catch (e) { fail(res, "save", e); }
  });

  // ── 4. Camfrog: an admin's / the pad owner's !clipmic of a veiled turn (Pepe uploads it, answers them by PM) ──
  app.post("/api/bridge/evidence/upload", botJson("upload"), async (req, res) => {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    try {
      await init();
      if (!effective()) return res.status(409).json({ ok: false, error: "evidence_off" });
      const room = clean(b.room, 64), target = low(b.target), requester = low(b.requester), veil = String(b.veil || "");
      const saidMs = Math.floor(Number(b.said_at) * 1000);
      if (!room || !LOGIN_RE.test(target) || !LOGIN_RE.test(requester) || !VEILS.has(veil) || !(saidMs > 0)) return res.status(400).json({ ok: false, error: "bad_request" });
      let buf = null;
      try { buf = Buffer.from(String(b.data || ""), "base64"); } catch (e) { buf = null; }
      if (!isM4a(buf)) return res.status(400).json({ ok: false, error: "bad_audio" });
      // the requester's PATV account: their linked Camfrog login (full accounts before automatic CF ones, as micclip.js)
      const accts = await getQuery(`SELECT userId, username, class FROM users WHERE lower(camfrogUsername) = ? ORDER BY CASE WHEN username LIKE 'CF%' THEN 1 ELSE 0 END`, [requester]);
      let acct = null, rl = null;
      for (const a of accts) { const r = await role(a, room, saidMs); if (r) { acct = a; rl = r; break; } }
      if (!rl) return res.status(403).json({ ok: false, error: "not_entitled" });
      // (1.99aht transcripts bar review fix TXBAR-ST-2: the turn of a !transcripts off bar - its 🎙 line in the live ring is tm)
      let tm = false;
      try {
        const txId = String(b.tx || ""), R = TX_RE.test(txId) ? require("./bridge")._rooms.get(room) : null;
        tm = !!(R && (R.feed || []).some((x) => x && x.k === "tx" && x.id === txId && x.tm === 1));
      } catch (e) { tm = false; }
      const saved = await store({ buf, roomId: room, txId: String(b.tx || ""), subject: target, veil, saidAt: saidMs, secs: Number(b.secs) || 0,
                                  user: { userId: String(acct.userId), username: acct.username || null }, role: rl.role, via: "camfrog", reason: "Camfrog !clipmic", tm });
      if (rl.role === "owner") { try { await ST.noteOwnerUse({ userId: String(acct.userId), username: acct.username }, room, "lines", 1); } catch (e) { /* best effort */ } }
      let url = "/admin/bridge#evidence";
      if (rl.role === "owner") {
        let slug = null;
        try { const R = require("./bridge")._rooms.get(room); slug = R && R.slug ? R.slug : null; } catch (e) { slug = null; }
        if (slug) url = "/p/" + encodeURIComponent(slug) + "/settings?tab=chat#evidence";
      }
      console.log(`[evidence] saved via=camfrog room=${room} by=${acct.userId} as=${rl.role}`);
      res.json({ ok: true, id: saved.id, expires_at: saved.expires_at, url });
    } catch (e) {
      console.error(`[evidence] upload failed (${String((e && (e.code || e.name)) || "error").replace(/[^\w.]/g, "").slice(0, 40)})`);
      res.status(500).json({ ok: false, error: "error" });
    }
  });

  // ── 5. viewing: admins every pad; a pad's owner their own pad, turns said in their era. Staff, mods, members: never ──
  app.get("/api/evidence", addUser, async (req, res) => {
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
        rows = roomId ? await getQuery("SELECT * FROM evidence_clips WHERE room_id = ? ORDER BY created DESC LIMIT ?", [roomId, n])
          : await getQuery("SELECT * FROM evidence_clips ORDER BY created DESC LIMIT ?", [n]);
      } else {
        const r = roomId ? await ST.chatRole(req.user, roomId) : null;
        if (!r || r.role !== "owner") return res.status(403).json(NOT_ENTITLED);
        rows = await getQuery("SELECT * FROM evidence_clips WHERE room_id = ? AND said_at >= ? ORDER BY created DESC LIMIT ?", [String(roomId), r.since, n]);
      }
      // (review fix R6: a clip past its 30 days and under no hold is gone for everyone, whether or not the sweep has run yet)
      const live = [];
      for (const r of rows) if (!(await lapsed(r))) live.push(r);
      const names = await namesOf(live.flatMap((r) => [r.by_user, r.hold_by]));
      const out = live.map((r) => rowView(r, admin, names));
      // listing names the subjects: a seethrough row (clip_list) naming every subject this viewer hasn't been logged for in this list within
      // the hour (review fix WP5-ACC-4 / WP5-T8: a subject added later, or shown by a bigger ?limit, is logged too; past 200 logins the
      // row is split - logAll - so none is dropped)
      const key = `${req.user.userId}|list|${roomId || "*"}|`;
      const fresh = [...new Set(out.map((o) => low(o.subject)))].filter((s) => !seenLately(key + s));
      if (fresh.length) {
        await ST.init();
        await tx(() => ST.logAll({ userId: String(req.user.userId), role: admin ? "admin" : "owner", scope: "clip_list", roomId, logins: fresh, ref: "evl:" + out.length }));
        for (const s of fresh) markSeen(key + s);
      }
      res.json({ ok: true, on: effective(), admin, rows: out });
    } catch (e) { fail(res, "list", e); }
  });
  app.get("/api/evidence/:id/audio", addUser, async (req, res) => {
    try {
      const id = String(req.params.id || "");
      if (!ID_RE.test(id) || !req.user || !req.user.userId) return res.status(404).json({ ok: false, error: "No such clip." });
      await init();
      const r = (await getQuery("SELECT * FROM evidence_clips WHERE id = ?", [id]))[0];
      const admin = await isAdmin(req.user);
      const rl = r ? (admin ? { role: "admin" } : await role(req.user, r.room_id, r.said_at)) : null;
      if (!r || !rl) return res.status(404).json({ ok: false, error: "No such clip." });       // (the same answer: nothing confirmed to others)
      if (await lapsed(r)) return res.status(410).json({ ok: false, error: "That clip's 30 days are up - it's being deleted." });   // (review fix R6)
      const base = existingDir(), f = base ? filePath(r.file, base) : null;
      if (!f || !fs.existsSync(f)) return res.status(410).json({ ok: false, error: "That clip's file is gone." });
      const dl = req.query.dl === "1";
      if (dl && rl.role !== "admin") return res.status(403).json({ ok: false, error: "Only PATV admins can download evidence clips." });
      const uid = String(req.user.userId);
      if (dl) {
        await ST.init(); await AA.init();
        await tx(async () => {
          await ST.log({ userId: uid, role: "admin", scope: "clip_download", roomId: r.room_id, logins: [r.subject_login], ref: "ev:" + r.id });
          await AA.record({ userId: uid, username: req.user.username || null }, "evidence.download", null, { id: r.id, room: r.room_id });
        });
      } else if (seenOnce(`${uid}|play|${r.id}`)) {
        await ST.log({ userId: uid, role: rl.role, scope: "clip_play", roomId: r.room_id, logins: [r.subject_login], ref: "ev:" + r.id });
      }
      res.set(PRIVATE_HEADERS);
      res.set("Content-Disposition", dl ? `attachment; filename="patv-evidence-${r.id}.m4a"` : "inline");
      res.sendFile(f, { acceptRanges: true, etag: false, lastModified: false, cacheControl: false, headers: PRIVATE_HEADERS }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
    } catch (e) { fail(res, "audio", e); }
  });
  const adminRow = async (req, res) => {
    noStore(res);
    if (!fetchOnly(req, res)) return null;
    if (!(await isAdmin(req.user))) { res.status(403).json({ ok: false, error: "Admins only." }); return null; }
    const id = String(req.params.id || "");
    await init();
    const r = ID_RE.test(id) ? (await getQuery("SELECT * FROM evidence_clips WHERE id = ?", [id]))[0] : null;
    if (!r) { res.status(404).json({ ok: false, error: "No such clip." }); return null; }
    const why = clean((req.body || {}).why, REASON_MAX);
    if (why.length < WHY_MIN) { res.status(400).json({ ok: false, code: "why", error: "Give the reason (the request, the order, the case) - it's audited." }); return null; }
    return { r, why, uid: String(req.user.userId) };
  };
  app.post("/api/evidence/:id/hold", addUser, json, async (req, res) => {
    try {
      const x = await adminRow(req, res);
      if (!x) return;
      const on = (req.body || {}).on === true;
      await ST.init(); await AA.init();
      const done = await tx(async () => {
        // (review fix R7: the row may have gone since it was read - the sweep deletes the row first now; then nothing is held or logged)
        const u = on ? await runQuery("UPDATE evidence_clips SET hold_at = ?, hold_by = ?, hold_why = ? WHERE id = ?", [now(), x.uid, x.why, x.r.id])
          : await runQuery("UPDATE evidence_clips SET hold_at = NULL, hold_by = NULL, hold_why = NULL WHERE id = ?", [x.r.id]);
        if (!u || u.changes !== 1) return false;
        await ST.log({ userId: x.uid, role: "admin", scope: "clip_hold", roomId: x.r.room_id, logins: [x.r.subject_login], reason: x.why, ref: (on ? "hold:" : "unhold:") + x.r.id });
        await AA.record({ userId: x.uid, username: req.user.username || null }, on ? "evidence.hold" : "evidence.unhold", null, { id: x.r.id, room: x.r.room_id }, x.why);
        return true;
      });
      if (!done) return res.status(404).json({ ok: false, error: "No such clip." });
      res.json({ ok: true, held: on });
    } catch (e) { fail(res, "hold", e); }
  });
  app.post("/api/evidence/:id/delete", addUser, json, async (req, res) => {
    try {
      const x = await adminRow(req, res);
      if (!x) return;
      await ST.init(); await AA.init();
      await tx(async () => {
        await ST.log({ userId: x.uid, role: "admin", scope: "clip_delete", roomId: x.r.room_id, logins: [x.r.subject_login], reason: x.why, ref: "del:" + x.r.id });
        await AA.record({ userId: x.uid, username: req.user.username || null }, "evidence.delete", null, { id: x.r.id, room: x.r.room_id }, x.why);
        await runQuery("DELETE FROM evidence_clips WHERE id = ?", [x.r.id]);
      });
      const base = existingDir();
      if (base) unlinkQuiet(filePath(x.r.file, base));            // (one that won't go is an orphan: the sweep takes it within the hour)
      res.json({ ok: true, deleted: true });
    } catch (e) { fail(res, "delete", e); }
  });

  // ── 6. the switch (/admin/bridge#evidence; chatlog.admin, like privacy wire v2) ──
  const canSwitch = (req) => !!(req.user && SP.can(req.user, "chatlog.admin"));
  app.get("/api/admin/evidence", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!canSwitch(req)) return res.status(403).json({ ok: false, error: "Site admins only." });
    try {
      await init();
      const c = (await getQuery("SELECT COUNT(*) AS n, SUM(CASE WHEN hold_at IS NOT NULL THEN 1 ELSE 0 END) AS held FROM evidence_clips"))[0];
      let pw = false;
      try { pw = require("./privwire").isOn(); } catch (e) { pw = false; }
      res.json({ ok: true, state: state(), effective: effective(), privwire: pw, counts: { clips: Number(c.n) || 0, held: Number(c.held) || 0, previews: PEND.size } });
    } catch (e) { fail(res, "admin", e); }
  });
  app.post("/api/admin/evidence", addUser, json, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!canSwitch(req)) return res.status(403).json({ ok: false, error: "Site admins only." });
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    const b = req.body || {};
    if (typeof b.on !== "boolean") return res.status(400).json({ ok: false, error: "Say on: true or false." });
    try { res.json({ ok: true, state: await setOn(b.on, { userId: req.user.userId, username: req.user.username }), effective: effective() }); }
    catch (e) { fail(res, "switch", e); }
  });
}

module.exports = { init, isOn, effective, state, setOn, privacyCopy, anyTxClip, role, heldWhy, lapsed, store, sweep, subjectGone, offerable, padCard, register,
                   KEEP_MS, PREVIEW_TTL, LINE_MAX_AGE, PRIVATE_HEADERS, ID_RE, Refuse, filePath, pendingPath, SWEEP_PAGE, BOOT_SWEEP_MS, CHUNK_TARGETS,
                   _pending: PEND, _seen: SEEN, _setDir,
                   _setClock: (f) => { clock = f || (() => Date.now()); },
                   _reset: () => { STATE = cleanState(null); loaded = false; ready = null; PEND.clear(); SEEN.clear(); } };
