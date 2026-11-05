// Camfrog's current sendable catalog and small, re-encoded sticker pictures. No user/room data is stored here.
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto"), express = require("express");
const { runQuery, getQuery, tx } = require("./dbUtils");
const MAX_PNG_BYTES = 256 * 1024, MAX_BODY_BYTES = 700000, MAX_PICS = 20, MAX_CATALOG = 10000;
const MAX_INPUT_PIXELS = 16e6, FILE_RE = /^[a-f0-9]{32}\.webp$/, ID_RE = /^[1-9][0-9]{0,9}$/;
let ready = null, writing = Promise.resolve(), CACHE = new Map(), DIR = null;
class Refuse extends Error { constructor(status, code) { super(code); this.status = status; this.refuse = true; } }
const idOf = value => (typeof value === "number" && Number.isSafeInteger(value) || typeof value === "string") && ID_RE.test(String(value)) ? Number(value) : null;
// 1.99aiw dock: review - 240 CODE POINTS, as Pepe cuts them (Python len), never half a surrogate pair: counting UTF-16 units
// refused Pepe's whole atomic list over one long description with an emoji
const DESC_MAX = 240, points = value => Array.from(String(value));
const plain = value => points(String(value == null ? "" : value).replace(/<[^>]*>/g, "").replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim()).slice(0, DESC_MAX).join("").trim();
function pickDir() {
  if (process.env.CFSTICKER_DIR) return path.resolve(process.env.CFSTICKER_DIR);
  if (process.platform === "linux") {
    const d = process.env.STAGING ? "/var/lib/patv-staging/cfsticker" : "/var/lib/patv/cfsticker";
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (_) { /* local fallback */ }
  }
  return path.resolve(__dirname, "..", path.basename(__dirname) + "-cfsticker");
}
function dir() { if (!DIR) { DIR = pickDir(); fs.mkdirSync(DIR, { recursive: true }); } return DIR; }
function filePath(file) { return FILE_RE.test(String(file || "")) ? path.join(dir(), file) : null; }
function remove(file) { const p = filePath(file); if (p) { try { fs.unlinkSync(p); } catch (_) { /* already gone */ } } }
function init() {
  if (!ready) ready = (async () => {
    await runQuery("CREATE TABLE IF NOT EXISTS cf_stickers (id INTEGER PRIMARY KEY, set_id INTEGER NOT NULL, descr TEXT NOT NULL, file TEXT, updated INTEGER NOT NULL)");
    CACHE = new Map((await getQuery("SELECT * FROM cf_stickers")).filter(r => idOf(r.id) && idOf(r.set_id)).map(r => [r.id, r]));
  })().catch(e => { ready = null; throw e; });
  return ready;
}
const enabled = () => require("./paddock").current().cfg.cfstickers === true;
// stkimg 1.99akg: v = the picture's version - the first 8 hex of its file (a random name, nothing else in it). A sticker's chat line
// reaches the page ~30 s before Pepe uploads a picture the site hasn't seen, so that first request 404s; a browser or an edge that
// kept the failed URL left the picker's tile, the very same URL, a caption until a reload. The picker asks for src + "?v=" + v: a new
// picture = a new URL (an old failure or an old cached picture never sticks); the media route ignores the query. src stays the plain
// URL - a page loaded before this release (pad-picker.js v3) accepts only that, and a rollback's picker gets what it knows
const verOf = row => row.file && FILE_RE.test(row.file) ? row.file.slice(0, 8) : null;
function get(set, id) {
  const row = CACHE.get(idOf(id));
  if (!row || row.set_id !== idOf(set)) return null;
  return { id: row.id, set: row.set_id, desc: row.descr, src: row.file ? "/media/cfsticker/" + row.id + ".webp" : null, v: verOf(row) };
}
const valid = (set, id) => !!get(set, id);
// 1.99aiw dock: review - the picker's list is built once per catalog change (GEN) or minute, not with a synchronous fs.existsSync
// per sticker (up to MAX_CATALOG) on the event loop for every signed-in GET of /api/rooms/:slug/cfstickers (no rate limit)
const CATALOG_TTL_MS = 60000;
let GEN = 0, LISTED = null;
function catalog() {
  const now = Date.now();
  if (!LISTED || LISTED.cache !== CACHE || LISTED.gen !== GEN || now - LISTED.at >= CATALOG_TTL_MS)
    LISTED = { cache: CACHE, gen: GEN, at: now, rows: [...CACHE.values()].filter(r => r.file && fs.existsSync(filePath(r.file) || "")).map(r => get(r.set_id, r.id)) };
  return LISTED.rows.map(r => ({ ...r }));
}
function serial(fn) { const task = writing.then(fn); writing = task.catch(() => {}); return task; }
async function syncList(items) {
  if (!Array.isArray(items) || items.length > MAX_CATALOG) throw new Refuse(400, "list");
  const rows = new Map();
  for (const item of items) {
    const id = idOf(item && item.id), set = idOf(item && item.set);
    if (!id || !set || rows.has(id) || typeof item.desc !== "string" || item.desc.length > DESC_MAX * 2 || points(item.desc).length > DESC_MAX) throw new Refuse(400, "sticker");
    rows.set(id, { id, set_id: set, descr: plain(item.desc) });
  }
  return serial(async () => {
    await init(); const next = new Map(), at = Date.now();
    for (const row of rows.values()) { const old = CACHE.get(row.id); next.set(row.id, { ...row, file: old && old.set_id === row.set_id ? old.file : null, updated: at }); }
    // 1.99aiw dock: review - Pepe re-sends the same list every 10 minutes, switches on or off: an unchanged list writes nothing (it
    // was a DELETE + up to 10000 INSERTs holding the write gate, and a fresh picker list, every time)
    const same = next.size === CACHE.size && [...next.values()].every(r => { const o = CACHE.get(r.id); return !!o && o.set_id === r.set_id && o.descr === r.descr && o.file === r.file; });
    if (same) return { need: enabled() ? [...CACHE.values()].filter(r => !r.file || !fs.existsSync(filePath(r.file) || "")).map(r => r.id) : [] };
    await tx(async () => {
      await runQuery("DELETE FROM cf_stickers");
      for (const row of next.values()) await runQuery("INSERT INTO cf_stickers (id,set_id,descr,file,updated) VALUES (?,?,?,?,?)", [row.id, row.set_id, row.descr, row.file, at]);
    });
    const old = CACHE; CACHE = next; GEN++;
    for (const row of old.values()) if (row.file && (!next.has(row.id) || next.get(row.id).file !== row.file)) remove(row.file);
    // 1.99aiw dock: while cfstickers is off the site keeps the list (ids, sets, descriptions - served nowhere) but asks Pepe for no
    // art, so no Camfrog sticker picture reaches the site's disk before the owner switches it on; the first sync after that
    // (Pepe's 10-minute tick) asks for every picture
    if (!enabled()) return { need: [] };
    return { need: [...next.values()].filter(r => !r.file || !fs.existsSync(filePath(r.file) || "")).map(r => r.id) };
  });
}
async function encode(png) {
  if (typeof png !== "string" || png.length > Math.ceil(MAX_PNG_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(png)) throw new Refuse(400, "picture");
  const buf = Buffer.from(png, "base64");
  if (buf.length > MAX_PNG_BYTES) throw new Refuse(413, "picture");
  const sniffed = require("./feedmedia").sniff(buf);
  if (!sniffed || sniffed.fmt !== "png") throw new Refuse(415, "png");
  try {
    const sharp = require("sharp"), image = sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS });
    const meta = await image.metadata();
    if (meta.format !== "png") throw new Error("format");
    // No withMetadata/keepMetadata: strip EXIF, XMP and ICC; first frame, never enlarged.
    return await image.rotate().resize({ width: 128, height: 128, fit: "inside", withoutEnlargement: true }).webp({ quality: 84 }).toBuffer();
  } catch (_) { throw new Refuse(415, "picture"); }
}
async function syncPics(items) {
  if (!enabled()) throw new Refuse(403, "off");             // 1.99aiw dock: no Camfrog art on the site while cfstickers is off
  if (!Array.isArray(items) || items.length > MAX_PICS) throw new Refuse(400, "pictures");
  return serial(async () => {
    await init(); const seen = new Set(), updates = [], made = [];
    for (const item of items) {
      const id = idOf(item && item.id);
      if (!id || seen.has(id) || !CACHE.has(id)) throw new Refuse(400, "sticker");
      seen.add(id); updates.push({ id, buf: await encode(item.png) });
    }
    try {
      for (const update of updates) {
        update.file = crypto.randomBytes(16).toString("hex") + ".webp";
        await fs.promises.writeFile(filePath(update.file), update.buf, { flag: "wx" }); made.push(update.file);
      }
      const at = Date.now();
      await tx(async () => { for (const update of updates) await runQuery("UPDATE cf_stickers SET file=?,updated=? WHERE id=?", [update.file, at, update.id]); });
      for (const update of updates) { const old = CACHE.get(update.id); CACHE.set(update.id, { ...old, file: update.file, updated: at }); if (old.file) remove(old.file); }
      GEN++;
      return { ok: true };
    } catch (e) { made.forEach(remove); throw e; }
  });
}
function register(app, { isBotToken, addUser }) {
  init().catch(() => console.error("[cfstickers] catalog unavailable"));
  const fail = (res, e) => res.status(e && e.refuse ? e.status : 503).json({ ok: false, code: e && e.refuse ? e.message : "busy", error: "Sticker catalog unavailable." });
  app.post("/api/bridge/cfstickers", express.json({ limit: MAX_BODY_BYTES - 1 }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    const body = req.body || {};
    if (!isBotToken(body.password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try {
      if (Buffer.byteLength(JSON.stringify(body)) >= MAX_BODY_BYTES) throw new Refuse(413, "body");
      if (body.op === "list") return res.json(await syncList(body.items));
      if (body.op === "pics") return res.json(await syncPics(body.items));
      throw new Refuse(400, "operation");
    } catch (e) { fail(res, e); }
  });
  app.get("/api/rooms/:slug/cfstickers", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      const access = await require("./bridge-relay").sayEligibility(req, req.params.slug);
      if (!access.ok) return res.status(access.status).json(access.body);
      if (!enabled() || access.R.stickers !== true) return res.status(403).json({ ok: false, code: "sticker", error: "Stickers aren't available here." });
      await init(); res.json(catalog());
    } catch (e) { fail(res, e); }
  });
  // (stkimg 1.99akg: ?v= (the picker's version) and ?r= (a chat line's retry) are ignored - the id alone picks the picture. A "not
  // here" is never kept - no-store: the picture may arrive seconds later, and a browser or Cloudflare (404s on a .webp path, 3 min by
  // default) must ask again)
  app.get("/media/cfsticker/:id.webp", async (req, res) => {
    const none = () => res.set("Cache-Control", "no-store").status(404).end();
    try {
      if (!enabled()) return none();                          // 1.99aiw dock: nothing served while cfstickers is off (a line shows "[sticker]")
      await init(); const row = CACHE.get(idOf(req.params.id)), file = row && filePath(row.file);
      if (!file) return none();
      const headers = { "Content-Type": "image/webp", "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox", "Cross-Origin-Resource-Policy": "same-origin" };
      res.set(headers).sendFile(file, { cacheControl: false, lastModified: false, headers }, err => { if (err && !res.headersSent) none(); });   // (a picture replaced mid-send: no-store over the day's cache set above)
    } catch (_) { if (!res.headersSent) res.status(503).end(); }
  });
}
module.exports = { init, enabled, get, valid, catalog, syncList, syncPics, register, MAX_PNG_BYTES, MAX_BODY_BYTES, MAX_PICS,
  _setDir: d => { DIR = path.resolve(d); fs.mkdirSync(DIR, { recursive: true }); LISTED = null; }, _reset: () => { ready = null; CACHE = new Map(); writing = Promise.resolve(); LISTED = null; } };
