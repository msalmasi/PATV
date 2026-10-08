// media.js — Pepe's snaps and clips, served by PATV (moved off Netlify).
//
// Pepe POSTs each capture here (bot token, base64 JSON, same fields the Netlify function took).
// Files live on the server's disk in media/ (gitignored, never deployed over) — webcam captures
// that expire don't belong in a public S3 bucket. The raw route is served with res.sendFile, which
// answers HTTP Range requests with 206: iOS Safari won't play a <video> without that (the Netlify
// function advertised ranges but always sent the whole file, which is why clips failed on phones).
const fs = require("fs");
const path = require("path");
const express = require("express");
const { runQuery, getQuery } = require("./dbUtils");

const DIR = process.env.MEDIA_DIR ? path.resolve(process.env.MEDIA_DIR) : path.join(__dirname, "media");   // MEDIA_DIR: tests
try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) { /* exists */ }

const ready = runQuery(`CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, ct TEXT NOT NULL, file TEXT NOT NULL, bytes INTEGER,
  secs REAL, subject TEXT, by_user TEXT, room TEXT, created INTEGER, expires INTEGER,
  deleted INTEGER DEFAULT 0)`)
  // 1.99bz: Pepe may flag a capture's subject as private (!incognito / !bridge hide) - the site then
  // never names them (stories, strips, the capture page)
  .then(() => runQuery("ALTER TABLE media ADD COLUMN anon INTEGER DEFAULT 0").catch(() => {}))
  // 1.99cr: stage captures (stagecap.js): source "stage" (NULL = Pepe's cam capture), the stream ("pepe" |
  // "slot:<id>"), NSFW (from the slot), who took it (account id) and the slot (its streamer may delete it).
  // Their files are webp (snaps) / mp4 (clips), written by stagecap.js itself - never uploaded here.
  .then(() => runQuery("ALTER TABLE media ADD COLUMN source TEXT").catch(() => {}))
  .then(() => runQuery("ALTER TABLE media ADD COLUMN stream TEXT").catch(() => {}))
  .then(() => runQuery("ALTER TABLE media ADD COLUMN nsfw INTEGER DEFAULT 0").catch(() => {}))
  .then(() => runQuery("ALTER TABLE media ADD COLUMN by_user_id TEXT").catch(() => {}))
  .then(() => runQuery("ALTER TABLE media ADD COLUMN slot_id TEXT").catch(() => {}))
  // 1.99ez: the subject's Camfrog LOGIN (Pepe sends it with each capture; `subject` is their display name) - how a
  // capture of someone reaches their profile story (userstories.js). Source "user" = a member's own story upload.
  .then(() => runQuery("ALTER TABLE media ADD COLUMN subject_login TEXT").catch(() => {}))
  .catch(() => {});

/** Is this capture's file still on disk? (A row can outlive its file: a staging DB refreshed from prod,
 *  a file removed by hand. Such rows would render as broken images, so lists skip them.) */
function fileExists(row) {
  return !!(row && typeof row.file === "string" && /^[A-Za-z0-9]+\.(jpg|mp4|m4a|webp)$/.test(row.file) && fs.existsSync(path.join(DIR, row.file)));
}

// ── poster frames (1.99dq) ──
// Every clip (and room-audio capture) gets a small webp poster next to its file: "<id>_p.webp" (a fixed
// name, no column - the id is all we need, and fileExists() never matches it). Clips: one frame at ~1 s
// (10% of a short clip). Audio: a waveform on the story strip's purple card. ffmpeg runs in feedmedia.js's
// job queue (2 at a time, niced, timeouts). Made at upload (/api/media), at a stage capture's publish
// (stagecap.js) and by a backfill (startup + the 5-minute sweep) for anything still missing one.
const POSTER_PX = 360;
const ID_RE = /^[a-f0-9]{8,32}$/i;
const posterFile = (id) => (ID_RE.test(String(id || "")) ? path.join(DIR, String(id) + "_p.webp") : null);
function hasPoster(row) {
  const p = row && (row.kind === "clip" || row.kind === "audio") ? posterFile(row.id) : null;
  return !!p && fs.existsSync(p);
}
const posterFailed = new Set();   // ids whose poster couldn't be made (not retried until a restart)
const posterPending = new Map();  // id -> promise (one job per id)

const defaultPosterImpl = async (row, src, out) => {
  const fm = require("./feedmedia");
  const sharp = require("sharp");
  const png = out + ".png";
  const base = ["-hide_banner", "-nostdin", "-v", "error", "-protocol_whitelist", "file", "-f", "mov"];
  const release = await fm.slot();
  try {
    if (row.kind === "clip") {
      const secs = Number(row.secs) || 0;
      const at = secs >= 10 ? 1 : secs > 0 ? Math.round(secs * 10) / 100 : 0;
      const grab = (t) => fm.run(fm.bin("ffmpeg"), [...base, "-ss", String(t), "-i", src, "-map", "0:v:0", "-frames:v", "1",
        "-an", "-map_metadata", "-1", "-f", "image2", "-c:v", "png", "-y", png], { timeoutMs: 30000 });
      await grab(at);
      if (!fs.existsSync(png) && at > 0) await grab(0);     // -ss past the last frame writes nothing
    } else {
      await fm.run(fm.bin("ffmpeg"), [...base, "-i", src, "-filter_complex",
        "[0:a:0]aformat=channel_layouts=mono,showwavespic=s=640x200:colors=0xc6e94f[w]", "-map", "[w]", "-frames:v", "1",
        "-f", "image2", "-c:v", "png", "-y", png], { timeoutMs: 30000 });
    }
  } finally { release(); }
  try {
    if (!fs.existsSync(png)) throw new Error("no frame");
    if (row.kind === "clip") {
      await sharp(fs.readFileSync(png), { limitInputPixels: 60e6 }).resize({ width: POSTER_PX, height: POSTER_PX * 2, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 72, effort: 4 }).toFile(out);
    } else {
      const W = POSTER_PX, H = 240;
      const card = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><radialGradient id="g" cx="50%" cy="40%" r="75%">` +
        `<stop offset="0" stop-color="#3b1d4f"/><stop offset="1" stop-color="#000"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/></svg>`);
      const wave = await sharp(fs.readFileSync(png)).resize({ width: W - 32, height: 110, fit: "fill" }).png().toBuffer();
      await sharp(card).composite([{ input: wave, top: 65, left: 16 }]).webp({ quality: 72, effort: 4 }).toFile(out);
    }
  } finally { try { fs.unlinkSync(png); } catch (e) { /* none */ } }
};
let posterImpl = defaultPosterImpl;
function _setPosterImpl(fn) { posterImpl = fn || defaultPosterImpl; }

/** Make `row`'s poster unless it has one. -> true (made or already there) | false. One job per id. */
function makePoster(row) {
  if (!row || (row.kind !== "clip" && row.kind !== "audio")) return Promise.resolve(false);
  const out = posterFile(row.id);
  if (!out || !fileExists(row)) return Promise.resolve(false);
  if (fs.existsSync(out)) return Promise.resolve(true);
  if (posterPending.has(row.id)) return posterPending.get(row.id);
  const tmp = out + ".part.webp";
  const p = (async () => {
    try {
      await posterImpl(row, path.join(DIR, row.file), tmp);
      if (!fs.existsSync(tmp) || !fs.statSync(tmp).size) throw new Error("empty poster");
      fs.renameSync(tmp, out);
      posterFailed.delete(row.id);
      return true;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) { /* none */ }
      posterFailed.add(row.id);
      console.error(`[media] poster ${row.id}:`, e.message, e.stderr || "");
      return false;
    } finally { posterPending.delete(row.id); }
  })();
  posterPending.set(row.id, p);
  return p;
}

/** Posters for every live clip / audio capture that lacks one. Idempotent. -> {checked, made, had, failed} */
async function backfillPosters({ retryFailed = false } = {}) {
  await ready;
  const rows = await getQuery("SELECT * FROM media WHERE deleted = 0 AND expires > ? AND kind IN ('clip', 'audio')", [Date.now()]);
  const res = { checked: rows.length, made: 0, had: 0, failed: 0 };
  for (const r of rows) {
    if (hasPoster(r)) { res.had++; continue; }
    if (!fileExists(r) || (!retryFailed && posterFailed.has(r.id))) continue;
    if (await makePoster(r)) res.made++; else res.failed++;
  }
  return res;
}

const TYPES = { "image/jpeg": ".jpg", "video/mp4": ".mp4", "audio/mp4": ".m4a" };
const KINDS = new Set(["photo", "clip", "audio"]);
const MAX_BYTES = 6 * 1024 * 1024;

function botAuthed(req, isBotToken) {
  const auth = req.get("Authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  return isBotToken((req.body && req.body.password) || bearer);
}

async function removeMedia(row) {
  try { fs.unlinkSync(path.join(DIR, row.file)); } catch (e) { /* already gone */ }
  removePoster(row.id);
  await runQuery("UPDATE media SET deleted = 1 WHERE id = ?", [row.id]);
}
function removePoster(id) {
  const p = posterFile(id);
  if (p) { try { fs.unlinkSync(p); } catch (e) { /* none */ } }
}

function ttlText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.max(1, Math.floor(s / 60))}m`;
}

function register(app, { isBotToken, addUser, noTimers }) {
  const bigJson = express.json({ limit: "9mb" });   // a 6 MB clip is ~8 MB of base64

  // Upload (Pepe)
  app.post("/api/media", bigJson, async (req, res) => {
    if (!botAuthed(req, isBotToken)) return res.status(403).json({ success: false, error: "unauthorized" });
    const b = req.body || {};
    const id = String(b.id || "");
    const ct = String(b.ct || "image/jpeg");
    const kind = KINDS.has(b.kind) ? b.kind : "photo";
    if (!/^[a-f0-9]{8,32}$/i.test(id) || !TYPES[ct] || !b.image) {
      return res.status(400).json({ success: false, error: "id, ct (jpeg/mp4/m4a) and image required" });
    }
    const buf = Buffer.from(String(b.image), "base64");
    if (!buf.length || buf.length > MAX_BYTES) return res.status(413).json({ success: false, error: "too big" });
    const now = Date.now();
    const expires = Number(b.expires) || now + 24 * 3600 * 1000;
    const file = id + TYPES[ct];
    try {
      await ready;
      fs.writeFileSync(path.join(DIR, file), buf);
      const anon = b.anon === true || b.anon === 1 || b.anon === "1";
      // 1.99ez: subject_login (a Camfrog login, lower-case) - never stored for a private (anon) subject
      const sl = String(b.subject_login || "").trim().toLowerCase();
      const subjectLogin = !anon && /^[\w.\-]{1,40}$/.test(sl) ? sl : null;
      await runQuery(`INSERT OR REPLACE INTO media (id, kind, ct, file, bytes, secs, subject, by_user, room, created, expires, deleted, anon, subject_login)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [id, kind, ct, file, buf.length, Number(b.secs) || 0, anon ? "" : String(b.subject || "").slice(0, 60),
         String(b.by || "").slice(0, 60), String(b.room || "").slice(0, 80), Number(b.created) || now, expires, anon ? 1 : 0, subjectLogin]);
      res.json({ success: true, id, expires, url: `/media/${id}` });
      // the poster frame / waveform card, in the ffmpeg queue (an INSERT OR REPLACE re-upload gets a fresh one)
      if (kind === "clip" || kind === "audio") {
        removePoster(id);
        posterFailed.delete(id);
        makePoster({ id, kind, file, secs: Number(b.secs) || 0 }).catch(() => {});
      }
    } catch (e) {
      console.error("[media] upload:", e);
      res.status(500).json({ success: false, error: "server_error" });
    }
  });

  // Delete (Pepe: admin !snap delete, or the expiry sweep)
  app.post("/api/media/delete", async (req, res) => {
    if (!botAuthed(req, isBotToken)) return res.status(403).json({ success: false, error: "unauthorized" });
    await ready;
    const rows = await getQuery("SELECT * FROM media WHERE id = ? AND deleted = 0", [String((req.body || {}).id || "")]);
    if (rows.length) await removeMedia(rows[0]);
    // 1.99eq: taken down before it expired (admin !snap delete) - Saved copies go with it, a post of it is hidden
    if (rows.length && Number(rows[0].expires) > Date.now()) {
      await require("./storykeep").onCaptureRemoved(rows[0].id, { reason: "removed" }).catch((e) => console.error("[media] keep cascade:", e.message));
    }
    res.json({ success: true, existed: rows.length > 0 });
  });

  // Mark existing captures private (Pepe, 1.99cb: the subject or requester went !incognito /
  // bridge-hidden after the capture was posted). items: [{id, subject: bool, by: bool}] - subject
  // blanks the name and sets anon (never named in stories / strips / the feed), by blanks the requester.
  app.post("/api/media/anon", async (req, res) => {
    if (!botAuthed(req, isBotToken)) return res.status(403).json({ success: false, error: "unauthorized" });
    const items = Array.isArray((req.body || {}).items) ? req.body.items.slice(0, 200) : [];
    await ready;
    let marked = 0;
    for (const it of items) {
      const id = String((it && it.id) || "");
      if (!/^[a-f0-9]{8,32}$/i.test(id) || !(it.subject || it.by)) continue;
      if (it.subject) await runQuery("UPDATE media SET anon = 1, subject = '', subject_login = NULL WHERE id = ?", [id]);
      // 1.99eq: the subject went private - Saved copies of them go, a post of them is hidden (storykeep.js)
      if (it.subject) await require("./storykeep").onCaptureRemoved(id, { reason: "private" }).catch((e) => console.error("[media] keep cascade:", e.message));
      if (it.by) await runQuery("UPDATE media SET by_user = 'someone' WHERE id = ?", [id]);
      marked++;
    }
    res.json({ success: true, marked });
  });

  async function live(id) {
    await ready;
    const rows = await getQuery("SELECT * FROM media WHERE id = ? AND deleted = 0", [id]);
    if (!rows.length) return { gone: 404 };
    if (Date.now() >= rows[0].expires) { await removeMedia(rows[0]); return { gone: 410 }; }
    return { row: rows[0] };
  }

  // 1.99fu: a capture taken in an Approved pad (padaccess.js) is only for the people inside it - the file, the poster
  // and the page all 404 for anyone else (the sign-in cookie is only read when it matters)
  async function padGate(req, res, row) {
    if (!row || !row.room) return true;
    const PA = require("./padaccess");
    await PA.init();
    if (!PA.isApproved(row.room)) return true;
    if (req.user === undefined && typeof addUser === "function") await new Promise((r) => addUser(req, res, r));
    return PA.canSee(req.user || null, row.room);
  }

  // The file itself — Range-aware (206), so phones can play clips
  app.get("/media/:id/raw", async (req, res) => {
    const { row, gone } = await live(req.params.id);
    if (gone) return res.status(gone).send(gone === 410 ? "This capture has expired." : "Not found.");
    if (!(await padGate(req, res, row))) return res.status(404).send("Not found.");
    res.set("X-Robots-Tag", "noindex");
    res.set("Cache-Control", `private, max-age=${Math.max(0, Math.min(300, Math.floor((row.expires - Date.now()) / 1000)))}`);
    res.set("X-Content-Type-Options", "nosniff");
    res.type(row.ct);
    res.sendFile(path.join(DIR, row.file), { acceptRanges: true });
  });

  // 1.99dq: a clip's poster frame / an audio capture's waveform card. Same rules as /raw (anyone with the
  // capture's id, expiry honoured; the pages that list captures are members-only, and NSFW is blurred by the
  // page). 404 when there's none yet - the UI falls back to the camcorder icon.
  app.get("/media/:id/poster", async (req, res) => {
    const { row, gone } = await live(req.params.id);
    res.set("X-Robots-Tag", "noindex");
    res.set("X-Content-Type-Options", "nosniff");
    if (gone) return res.status(gone).type("text/plain").send(gone === 410 ? "This capture has expired." : "Not found.");
    if (!(await padGate(req, res, row))) return res.status(404).type("text/plain").send("Not found.");
    if (!hasPoster(row)) {
      res.set("Cache-Control", "no-store");
      if (!posterFailed.has(row.id)) makePoster(row).catch(() => {});   // missed by upload + backfill: make it now for next time
      return res.status(404).type("text/plain").send("No poster.");
    }
    res.set("Cache-Control", `private, max-age=${Math.max(0, Math.min(3600, Math.floor((row.expires - Date.now()) / 1000)))}`);
    res.type("image/webp");
    res.sendFile(posterFile(row.id));
  });

  // One capture's page (the link Pepe posts in chat)
  app.get("/media/:id", addUser, async (req, res) => {
    const { row, gone } = await live(req.params.id);
    res.set("X-Robots-Tag", "noindex");
    if (gone) return res.status(gone).render("media", { user: req.user ? req.user.username : null, item: null, gone });
    if (!(await padGate(req, res, row))) return res.status(404).render("media", { user: req.user ? req.user.username : null, item: null, gone: 404 });
    // 1.99cr: the pad it belongs to (a link, not the raw room id) and whether this viewer may delete it
    let pad = null, canDelete = false;
    try {
      const R = row.room ? require("./rooms").getCached(row.room) : null;
      if (R) pad = { title: R.title, href: require("./pads").padHref(R) };
    } catch (e) { pad = null; }
    try { canDelete = !!(req.user && req.user.userId) && (await require("./stagecap").canDelete(req.user, row)); } catch (e) { canDelete = false; }
    const poster = hasPoster(row) ? `/media/${encodeURIComponent(row.id)}/poster` : null;   // 1.99dq
    res.render("media", { user: req.user ? req.user.username : null, item: { ...row, ttl: ttlText(row.expires - Date.now()) }, gone: null, pad, canDelete, poster });
  });

  // The /feed page (posts + these captures) lives in feedweb.js since 1.99bv.

  // Expired files go away even if nobody opens them
  setInterval(async () => {
    try {
      await ready;
      const rows = await getQuery("SELECT * FROM media WHERE deleted = 0 AND expires <= ?", [Date.now()]);
      for (const r of rows) await removeMedia(r);
      if (rows.length) console.log(`[media] purged ${rows.length} expired`);
    } catch (e) { console.error("[media] purge:", e.message); }
    try {
      const b = await backfillPosters();
      if (b.made || b.failed) console.log(`[media] posters: made ${b.made}, failed ${b.failed} (${b.checked} live clips/audio)`);
    } catch (e) { console.error("[media] posters:", e.message); }
  }, 5 * 60 * 1000).unref();

  // 1.99dq: one-time backfill of posters for the captures that predate them (idempotent: skips any that have one)
  if (!noTimers) {
    setTimeout(async () => {
      try {
        const b = await backfillPosters();
        console.log(`[media] poster backfill: ${b.checked} live clips/audio, ${b.had} had one, made ${b.made}, failed ${b.failed}`);
      } catch (e) { console.error("[media] poster backfill:", e.message); }
    }, 20 * 1000).unref();
  }
}

module.exports = { register, fileExists, hasPoster, makePoster, backfillPosters, removePoster, posterFile, _setPosterImpl, DIR, ready };
