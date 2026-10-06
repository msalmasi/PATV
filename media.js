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
  .catch(() => {});

/** Is this capture's file still on disk? (A row can outlive its file: a staging DB refreshed from prod,
 *  a file removed by hand. Such rows would render as broken images, so lists skip them.) */
function fileExists(row) {
  return !!(row && typeof row.file === "string" && /^[A-Za-z0-9]+\.(jpg|mp4|m4a)$/.test(row.file) && fs.existsSync(path.join(DIR, row.file)));
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
  await runQuery("UPDATE media SET deleted = 1 WHERE id = ?", [row.id]);
}

function ttlText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.max(1, Math.floor(s / 60))}m`;
}

function register(app, { isBotToken, addUser }) {
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
      await runQuery(`INSERT OR REPLACE INTO media (id, kind, ct, file, bytes, secs, subject, by_user, room, created, expires, deleted, anon)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        [id, kind, ct, file, buf.length, Number(b.secs) || 0, anon ? "" : String(b.subject || "").slice(0, 60),
         String(b.by || "").slice(0, 60), String(b.room || "").slice(0, 80), Number(b.created) || now, expires, anon ? 1 : 0]);
      res.json({ success: true, id, expires, url: `/media/${id}` });
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
      if (it.subject) await runQuery("UPDATE media SET anon = 1, subject = '' WHERE id = ?", [id]);
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

  // The file itself — Range-aware (206), so phones can play clips
  app.get("/media/:id/raw", async (req, res) => {
    const { row, gone } = await live(req.params.id);
    if (gone) return res.status(gone).send(gone === 410 ? "This capture has expired." : "Not found.");
    res.set("X-Robots-Tag", "noindex");
    res.set("Cache-Control", `private, max-age=${Math.max(0, Math.min(300, Math.floor((row.expires - Date.now()) / 1000)))}`);
    res.type(row.ct);
    res.sendFile(path.join(DIR, row.file), { acceptRanges: true });
  });

  // One capture's page (the link Pepe posts in chat)
  app.get("/media/:id", addUser, async (req, res) => {
    const { row, gone } = await live(req.params.id);
    res.set("X-Robots-Tag", "noindex");
    if (gone) return res.status(gone).render("media", { user: req.user ? req.user.username : null, item: null, gone });
    res.render("media", { user: req.user ? req.user.username : null, item: { ...row, ttl: ttlText(row.expires - Date.now()) }, gone: null });
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
  }, 5 * 60 * 1000).unref();
}

module.exports = { register, fileExists, DIR, ready };
