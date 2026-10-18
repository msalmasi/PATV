// banner.js — the homepage banner slot (1.99kk): one tasteful strip under the stage, "Sponsored" when someone paid for it,
// a PATV house promo the rest of the time.
//
// PAID BOOKINGS (members buy whole DAYS of the slot with PAT; /sponsor):
//   * a day = a calendar day in BANNER_TZ (America/New_York - the site's audience and the lotto's draw clock); one booking
//     owns a day exclusively (banner_days.day is the PRIMARY KEY, so two buyers can never hold the same day)
//   * a booking is 1..max_days consecutive days, starting tomorrow at the earliest and at most lead_days ahead; a member
//     can hold max_bookings open ones (pending, or approved and not over yet)
//   * content: an IMAGE (uploaded in 512 KB chunks, sniffed by magic bytes, re-encoded by sharp to a 1200x200 webp with
//     no metadata, then the image safety check - surface "banner", the strict profile policy) + alt text, or TEXT
//     (a headline + an optional line); an optional link (https / http, or a path on this site)
//   * MONEY: booking DEBITS the whole price as a HOLD (one transaction with the day rows and the booking; the client's
//     ref makes a double click charge once). Nothing is routed yet. An admin then:
//       approves -> the hold is booked through premium.js's routing table, row "banner" (default 100% Fort Knox: a
//                   site-wide spend, no room resolved - economy rule), and the booking runs on its days
//       rejects  -> a FULL REFUND (and the days free up), with the reason in the member's 🔔 notice
//     The member can cancel while it's pending (full refund). A booking still pending when its first day starts is
//     expired with a full refund. An approved booking can't be cancelled; staff can take one DOWN (it stops showing,
//     no refund - for a Terms breach; staff decide anything else by hand).
//   * paid booking ships OFF (banner_paid_enabled false) until the price is approved; the slot itself is on (house promos)
//
// HOUSE PROMOS fill every day nobody booked, rotating round-robin per page view (weighted): Pepeball (the lotto) with its
// LIVE jackpot and draw time, the Season Pass / Prime Time, Plex access and the Wheel. Admins edit them (text, link,
// on/off, weight) and can add their own; an empty headline uses the built-in, translated text (locales banner.promo.*).
// {jackpot} and {draw} work in any promo's text.
//
// STATS: aggregate counts only - banner_stats (ad, day) -> impressions, clicks. An impression = the banner was at least
// half on screen (a beacon from the page); a click goes through /b/go/<ad>. Each viewer counts once per ad per day,
// deduplicated in memory only (nothing about the viewer is stored). The buyer sees their booking's totals and per day.
//
// Tables: banner_kv (config), banner_bookings, banner_days (day PK -> booking), banner_promos, banner_stats.
// Routes: GET /sponsor; GET /api/banner/state; POST /api/banner/uploads (+ PUT chunk, POST finish); POST /api/banner/book;
// POST /api/banner/bookings/:id/cancel; POST /api/banner/seen; GET /b/go/:kind/:id; GET /media/banner/:file;
// GET /admin/banner; POST /api/banner/admin/{decide,takedown,config,promo,promo/delete}; POST /api/banner/chat-sponsors (Pepe, 1.99qr).
//
// CHAT SPONSOR (1.99qr, admin switch banner_chat_sponsor, default off): an approved booking's headline + link also runs in
// Pepe's !sponsor rotation in the Camfrog rooms on its booked days - see chatSponsors() below. 1.99tc: banner_chat_sponsor_mic
// (default ON) makes it a `-mic` sponsor: Pepe also speaks it on the mic, music ducked, in rooms whose TTS is on.
// 1.99xe: chat_house_promos (default ON): no paid sponsor today -> the house promos fill that chat slot, "From PATV" (chatHouse);
// chat_house_promos_mic (default OFF) has Pepe speak them too.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

const BANNER_TZ = "America/New_York";
const HEADLINE_MAX = 60, LINE_MAX = 120, ALT_MAX = 120, LINK_MAX = 300, REASON_MAX = 200;
const IMG_W = 1200, IMG_H = 200;
const MAX_BYTES = 5 * 1024 * 1024, CHUNK = 512 * 1024, CHUNK_MAX = 768 * 1024, UPLOAD_TTL = 30 * 60e3, MAX_INPUT_PIXELS = 60e6;
const REF_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ID_RE = /^[a-f0-9]{12}$/;
const FILE_RE = /^[a-f0-9]{32}_s\.webp$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const PROMO_KINDS = Object.freeze(["lotto", "season_pass", "prime_time", "plex", "wheel", "support", "custom"]);
const DEFAULTS = Object.freeze({
  enabled: true,              // the slot shows at all (house promos)
  paid_enabled: false,        // members can book it with PAT - OFF until the price is approved
  price_per_day: 1000000,     // PAT per day (proposed; not live while paid_enabled is off)
  max_days: 7,                // days per booking
  max_bookings: 2,            // open bookings per member (pending + approved, not over)
  lead_days: 60,              // how far ahead a booking may start
  chat_sponsor: false,        // 1.99qr: approved bookings also run in Pepe's !sponsor rotation in the Camfrog rooms
  chat_sponsor_mic: true,     // 1.99tc: ...and Pepe also SPEAKS the line on the mic (ducking the music) where the room has TTS on
  chat_house_promos: true,    // 1.99xe: no paid sponsor today -> the house promos rotate in Pepe's chat sponsor slot ("From PATV")
  chat_house_promos_mic: false, // 1.99xe: ...spoken too? OFF: free house ads never talk over a room's music / mic
});
const DEFAULT_PROMOS = Object.freeze([
  { id: "lotto", kind: "lotto", link: "/lotto", weight: 3, sort: 1 },
  { id: "season_pass", kind: "season_pass", link: "/premium", weight: 2, sort: 2 },
  { id: "prime_time", kind: "prime_time", link: "/premium", weight: 2, sort: 3 },
  { id: "plex", kind: "plex", link: "/shop", weight: 1, sort: 4 },
  { id: "wheel", kind: "wheel", link: "/g/wheel", weight: 2, sort: 5 },
  // 1.99kz: Support PATV (/support: card + stablecoin donations) - only shown while a donation rail is on
  { id: "support", kind: "support", link: "/support", weight: 2, sort: 6 },
]);

let NOW = () => Date.now();
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("en-US");
/** 1.99kz: the Support PATV promo's numbers ({rate} PAT per $1, {bonus}% to the community pot), or null while neither
 *  card (Stripe) nor stablecoin donations are on - /support would 404 then. */
let supportTerms = () => {
  let on = false;
  try { on = require("./cryptopay").enabled(); } catch (e) { on = false; }
  if (!on) { try { on = require("./stripebilling").enabled(); } catch (e) { on = false; } }
  if (!on) return null;
  let T = { rate: 500000, bonus_pct: 20 };
  try { T = require("./funding").donationTerms(); } catch (e) { /* defaults */ }
  // 1.99tq: a live donation promo shows its boosted rate + per-donor cap (the "support_promo" texts, views/partials/banner.ejs)
  let P = null;
  try { P = require("./donationpromo").liveCached(); } catch (e) { P = null; }
  if (P) return { rate: fmt(P.rate), bonus: String(Math.round(Number(T.bonus_pct) || 0)), promo_on: true, promo_cap: fmt(P.cap_usd), promo_mult: String(P.mult) };
  return { rate: fmt(T.rate), bonus: String(Math.round(Number(T.bonus_pct) || 0)) };
};
// 1.99ack: the review queue is banner.review (Assistants too since the owner's 2026-10-18 decision), settings + house
// promos banner.config (siteperms.js)
const canReview = (u) => SP.can(u, "banner.review");
const canConfig = (u) => SP.can(u, "banner.config");

class Refuse extends Error {
  constructor(status, message) { super(message); this.status = status; this.refuse = true; }
}

// ── days in BANNER_TZ ──
function partsIn(ms, tz) {
  const o = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}
function dayKey(ms, tz = BANNER_TZ) { const o = partsIn(ms, tz); return `${o.year}-${o.month}-${o.day}`; }
function offsetMs(ms, tz) {
  const o = partsIn(ms, tz);
  return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second) - Math.floor(ms / 1000) * 1000;
}
/** The first millisecond of day `key` in tz. */
function dayStart(key, tz = BANNER_TZ) {
  const [y, m, d] = key.split("-").map(Number);
  const g = Date.UTC(y, m - 1, d);
  let t = g - offsetMs(g, tz);
  t = g - offsetMs(t, tz);
  return t;
}
function addDays(key, n) { const [y, m, d] = key.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); }
function validDay(key) { return typeof key === "string" && DAY_RE.test(key) && addDays(key, 0) === key; }
const daysOf = (start, n) => Array.from({ length: n }, (_, i) => addDays(start, i));

// ── storage ──
let CONFIG = { ...DEFAULTS };
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS banner_kv (k TEXT PRIMARY KEY, v TEXT)");
      await runQuery(`CREATE TABLE IF NOT EXISTS banner_bookings (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, username TEXT, start_day TEXT NOT NULL,
        days INTEGER NOT NULL, kind TEXT NOT NULL, headline TEXT, line TEXT, image TEXT, alt TEXT, link TEXT, price INTEGER NOT NULL,
        ref TEXT NOT NULL UNIQUE, status TEXT NOT NULL, routing TEXT, reason TEXT, created INTEGER NOT NULL, decided_at INTEGER,
        decided_by TEXT, refunded INTEGER NOT NULL DEFAULT 0)`);
      await runQuery("CREATE INDEX IF NOT EXISTS banner_bookings_user ON banner_bookings (user_id, status)");
      await runQuery("CREATE INDEX IF NOT EXISTS banner_bookings_status ON banner_bookings (status, start_day)");
      await runQuery("CREATE TABLE IF NOT EXISTS banner_days (day TEXT PRIMARY KEY, booking_id TEXT NOT NULL)");
      await runQuery("CREATE INDEX IF NOT EXISTS banner_days_booking ON banner_days (booking_id)");
      await runQuery(`CREATE TABLE IF NOT EXISTS banner_promos (id TEXT PRIMARY KEY, kind TEXT NOT NULL, headline TEXT, line TEXT, link TEXT,
        enabled INTEGER NOT NULL DEFAULT 1, weight INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0, updated INTEGER, updated_by TEXT)`);
      await runQuery(`CREATE TABLE IF NOT EXISTS banner_stats (ad TEXT NOT NULL, day TEXT NOT NULL, impressions INTEGER NOT NULL DEFAULT 0,
        clicks INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (ad, day))`);
      if (!(await getQuery("SELECT 1 FROM banner_kv WHERE k = 'promos_seeded'")).length) {
        for (const p of DEFAULT_PROMOS) {
          await runQuery("INSERT OR IGNORE INTO banner_promos (id, kind, link, enabled, weight, sort, updated) VALUES (?, ?, ?, 1, ?, ?, ?)", [p.id, p.kind, p.link, p.weight, p.sort, NOW()]);
        }
        await runQuery("INSERT OR IGNORE INTO banner_kv (k, v) VALUES ('promos_seeded', '1')");
      }
      // 1.99kz: promos added after the first seed - once each (an admin who deletes / switches one off keeps it that way)
      for (const p of DEFAULT_PROMOS.filter((x) => x.id === "support")) {
        const key = "promo_seeded:" + p.id;
        if ((await getQuery("SELECT 1 FROM banner_kv WHERE k = ?", [key])).length) continue;
        await runQuery("INSERT OR IGNORE INTO banner_promos (id, kind, link, enabled, weight, sort, updated) VALUES (?, ?, ?, 1, ?, ?, ?)", [p.id, p.kind, p.link, p.weight, p.sort, NOW()]);
        await runQuery("INSERT OR IGNORE INTO banner_kv (k, v) VALUES (?, '1')", [key]);
      }
      CONFIG = cleanConfig(await readConfig());
    })().catch((e) => { console.error("[banner] init:", e.message); ready = null; throw e; });
  }
  return ready;
}
async function readConfig() {
  try { return JSON.parse(((await getQuery("SELECT v FROM banner_kv WHERE k = 'config'"))[0] || {}).v || "{}"); } catch (e) { return {}; }
}
// setting names (the admin page / API) -> config keys
const SETTING_NAMES = Object.freeze({ banner_enabled: "enabled", banner_paid_enabled: "paid_enabled", banner_price_per_day: "price_per_day",
  banner_max_days: "max_days", banner_max_bookings: "max_bookings", banner_lead_days: "lead_days", banner_chat_sponsor: "chat_sponsor",
  banner_chat_sponsor_mic: "chat_sponsor_mic", banner_chat_house_promos: "chat_house_promos", banner_chat_house_promos_mic: "chat_house_promos_mic" });
function cleanConfig(c, base = DEFAULTS) {
  const src = {};
  for (const [k, v] of Object.entries(c || {})) src[SETTING_NAMES[k] || k] = v;
  const on = (v, d) => (v === undefined || v === null || v === "" ? !!d : v === true || v === "true" || v === 1 || v === "1" || v === "on");
  const int = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
  return {
    enabled: on(src.enabled, base.enabled),
    paid_enabled: on(src.paid_enabled, base.paid_enabled),
    price_per_day: int(src.price_per_day, 1000, 1e11, base.price_per_day),
    max_days: int(src.max_days, 1, 31, base.max_days),
    max_bookings: int(src.max_bookings, 1, 20, base.max_bookings),
    lead_days: int(src.lead_days, 2, 365, base.lead_days),
    chat_sponsor: on(src.chat_sponsor, base.chat_sponsor),
    chat_sponsor_mic: on(src.chat_sponsor_mic, base.chat_sponsor_mic),
    chat_house_promos: on(src.chat_house_promos, base.chat_house_promos),
    chat_house_promos_mic: on(src.chat_house_promos_mic, base.chat_house_promos_mic),
  };
}
function config() { return { ...CONFIG }; }
async function setConfig(patch, actor = "?") {
  await init();
  const next = cleanConfig(patch || {}, CONFIG);
  await runQuery("INSERT INTO banner_kv (k, v) VALUES ('config', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [JSON.stringify(next)]);
  const diff = Object.keys(next).filter((k) => next[k] !== CONFIG[k]).map((k) => `${k} ${CONFIG[k]} -> ${next[k]}`).join(", ");
  CONFIG = next;
  console.log(`[banner] settings by ${actor}: ${diff || "no change"}`);
  return config();
}
function settingsView(c = CONFIG) { const o = {}; for (const [name, k] of Object.entries(SETTING_NAMES)) o[name] = c[k]; return o; }

// ── content checks ──
const cleanLine = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
/** A link a banner may use: http(s) anywhere, or a path on this site. "" -> null. Throws Refuse on anything else. */
function cleanLink(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return null;
  if (s.length > LINK_MAX) throw new Refuse(400, `Links can be up to ${LINK_MAX} characters.`);
  if (s[0] === "/") {
    if (s[1] === "/" || s[1] === "\\" || /[\s"'<>\\\u0000-\u001f\u007f]/.test(s)) throw new Refuse(400, "That link isn't valid.");
    return s;
  }
  let u;
  try { u = new URL(s); } catch (e) { throw new Refuse(400, "Links start with https:// (or a path on this site, like /p/your-pad)."); }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) throw new Refuse(400, "Links start with https:// (or a path on this site).");
  return u.href;
}
const linkDomain = (l) => { if (!l || l[0] === "/") return null; try { return new URL(l).hostname.replace(/^www\./, ""); } catch (e) { return null; } };

// ── image uploads (chunked, like the pad look; in memory, one process) ──
function pickDir() {
  if (process.env.BANNER_DIR) return path.resolve(process.env.BANNER_DIR);
  if (process.platform === "linux") {
    const d = process.env.STAGING ? "/var/lib/patv-staging/banner" : "/var/lib/patv/banner";
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (e) { /* not root: below */ }
  }
  return path.resolve(__dirname, "..", path.basename(__dirname) + "-banner");
}
let DIR = null;
function dir() { if (!DIR) { DIR = pickDir(); fs.mkdirSync(DIR, { recursive: true }); } return DIR; }
function _setDir(d) { DIR = d; fs.mkdirSync(DIR, { recursive: true }); }
function filePath(name) { return FILE_RE.test(String(name || "")) ? path.join(dir(), name) : null; }
const imageUrl = (name) => (name && FILE_RE.test(name) ? "/media/banner/" + name : null);

let SAFETY = null;     // tests stub it; default = imagesafety.check (surface "banner")
function setSafetyCheck(fn) { SAFETY = typeof fn === "function" ? fn : null; }
async function safetyCheck(buf, userId, ref) {
  if (SAFETY) return SAFETY({ buf, userId, ref });
  return require("./imagesafety").check({ surface: "banner", kind: "image", buf, userId, ref });
}
/** Picture bytes -> a 1200x200 webp (cover crop, centre; first frame; no metadata). */
async function encode(buf) {
  const media = require("./feedmedia");
  const sn = media.sniff(buf);
  if (sn.bad || sn.kind !== "image") throw new Refuse(415, "Pictures only: JPEG, PNG, GIF, WebP or AVIF.");
  if (sn.fmt === "heic") throw new Refuse(415, "HEIC isn't supported for banners - save it as JPEG or PNG first.");
  const sharp = require("sharp");
  try {
    let meta;
    try { meta = await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS }).metadata(); } catch (e) { throw new Refuse(415, "That picture couldn't be read."); }
    const fmtOk = { jpeg: "jpeg", png: "png", gif: "gif", webp: "webp", avif: "heif" }[sn.fmt];
    if (!meta || (fmtOk && meta.format !== fmtOk)) throw new Refuse(415, "That picture's contents don't match its type.");
    const out = await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS }).rotate()
      .resize({ width: IMG_W, height: IMG_H, fit: "cover", position: "centre" }).webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
    return { buf: out.data, w: out.info.width, h: out.info.height, bytes: out.info.size };
  } catch (e) {
    if (e && e.refuse) throw e;
    throw new Refuse(415, "That picture couldn't be processed.");
  }
}
const UP = new Map();       // upload id -> {userId, size, parts, received, at, done}
const MINE = new Map();     // file -> {userId, at}: pictures uploaded but not booked yet
function sweepUploads(t = NOW()) {
  for (const [id, u] of UP) if (t - u.at > UPLOAD_TTL) UP.delete(id);
  for (const [f, m] of MINE) if (t - m.at > 24 * 3600e3) MINE.delete(f);
}
function openUpload(userId, { size } = {}) {
  sweepUploads();
  const n = Math.floor(Number(size));
  if (!Number.isFinite(n) || n < 12) throw new Refuse(400, "That file is empty.");
  if (n > MAX_BYTES) throw new Refuse(413, `Pictures can be up to ${MAX_BYTES / 1024 / 1024} MB.`);
  if ([...UP.values()].filter((u) => u.userId === userId && !u.done).length >= 2) throw new Refuse(429, "Finish the upload you have going first.");
  const id = crypto.randomBytes(12).toString("hex");
  UP.set(id, { id, userId, size: n, parts: [], received: 0, at: NOW() });
  return { id, chunk: CHUNK };
}
function chunkUpload(userId, id, offset, buf) {
  const u = UP.get(String(id || ""));
  if (!u || u.userId !== userId) throw new Refuse(404, "No such upload.");
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Refuse(400, "Empty chunk.");
  if (Math.floor(Number(offset)) !== u.received) throw Object.assign(new Refuse(409, "Out of order."), { received: u.received });
  if (u.received + buf.length > u.size) { UP.delete(u.id); throw new Refuse(413, "That file is bigger than it said."); }
  if (u.received === 0) {
    const sn = require("./feedmedia").sniff(buf);
    if (sn.bad || sn.kind !== "image") { UP.delete(u.id); throw new Refuse(415, "Pictures only: JPEG, PNG, GIF, WebP or AVIF."); }
  }
  u.parts.push(Buffer.from(buf));
  u.received += buf.length;
  u.at = NOW();
  return u.received;
}
/** Re-encode + safety-check + store. -> {image (file name), url} */
async function storeImage(userId, buf) {
  const enc = await encode(buf);
  let v;
  try { v = await safetyCheck(enc.buf, userId, "banner-upload"); } catch (e) { v = { ok: false, reason: "The safety check couldn't run - try again in a minute." }; }
  if (!v || v.ok !== true || v.nsfw) throw new Refuse(422, (v && v.reason) || "That picture looks like adult or graphic content - homepage banners must be safe for work (Terms).");
  const name = crypto.randomBytes(16).toString("hex") + "_s.webp";
  fs.writeFileSync(filePath(name), enc.buf, { flag: "wx" });
  MINE.set(name, { userId, at: NOW() });
  return { image: name, url: imageUrl(name) };
}
async function finishUpload(userId, id) {
  const u = UP.get(String(id || ""));
  if (!u || u.userId !== userId) throw new Refuse(404, "No such upload.");
  if (u.done) return u.done;
  if (u.busy) throw new Refuse(409, "Still processing.");
  if (u.received !== u.size) throw Object.assign(new Refuse(409, "Not all of the file arrived."), { received: u.received });
  u.busy = true;
  try {
    const out = await storeImage(userId, Buffer.concat(u.parts));
    u.parts = []; u.done = out;
    return out;
  } catch (e) { UP.delete(u.id); throw e; }
  finally { u.busy = false; }
}
function removeFile(name) { const p = filePath(name); if (p) { try { fs.unlinkSync(p); } catch (e) { /* gone */ } } }

// ── bookings ──
const txRef = (ref) => "banner-" + crypto.createHash("sha256").update(ref).digest("hex").slice(0, 32);
const tx = (fn) => require("./boosts").tx(fn);
const notice = (userId, n) => require("./inbox").addSafe(userId, { kind: "shop", link: "/sponsor", ...n });

/** The first and last day a new booking may start on, and today. */
function bookWindow(t = NOW()) {
  const today = dayKey(t);
  return { today, first: addDays(today, 1), last: addDays(today, CONFIG.lead_days) };
}
/**
 * Book the slot. user = {userId, username}; b = {start, days, kind: image|text, headline, line, image, alt, link, ref}.
 * Idempotent per (user, ref). -> {dup, booking}
 */
async function book(user, b = {}) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  const C = CONFIG;
  if (!C.enabled || !C.paid_enabled) throw new Refuse(423, "Banner bookings aren't open yet.");
  const rawRef = String(b.ref || "");
  if (!REF_RE.test(rawRef)) throw new Refuse(400, "Bad request (ref).");
  const ref = `bn:${user.userId}:${rawRef}`;
  const had = (await getQuery("SELECT * FROM banner_bookings WHERE ref = ?", [ref]))[0];
  if (had) return { dup: true, booking: view(had) };
  const W = bookWindow();
  const start = String(b.start || "");
  if (!validDay(start)) throw new Refuse(400, "Pick a start day.");
  if (start < W.first) throw new Refuse(400, "Bookings start tomorrow at the earliest.");
  if (start > W.last) throw new Refuse(400, `Bookings can start up to ${C.lead_days} days ahead.`);
  const days = Math.floor(Number(b.days));
  if (!Number.isFinite(days) || days < 1 || days > C.max_days) throw new Refuse(400, `Book 1 to ${C.max_days} days.`);
  const kind = b.kind === "image" ? "image" : "text";
  const headline = cleanLine(b.headline, HEADLINE_MAX), line = cleanLine(b.line, LINE_MAX), alt = cleanLine(b.alt, ALT_MAX);
  const link = cleanLink(b.link);
  let image = null;
  if (kind === "image") {
    image = String(b.image || "");
    const m = MINE.get(image);
    if (!FILE_RE.test(image) || !m || m.userId !== user.userId || !fs.existsSync(filePath(image))) throw new Refuse(400, "Upload the picture first (or upload it again).");
    if (!alt) throw new Refuse(400, "Describe the picture in a few words (alt text) - for people using screen readers.");
  } else if (!headline) throw new Refuse(400, "Write a headline.");
  const price = days * C.price_per_day;
  const id = crypto.randomBytes(6).toString("hex");
  const t = NOW();
  const want = daysOf(start, days);
  await tx(async () => {
    // open = pending, or approved and not over yet
    const live = (await getQuery("SELECT start_day, days, status FROM banner_bookings WHERE user_id = ? AND status IN ('pending','approved')", [user.userId]))
      .filter((r) => r.status === "pending" || addDays(r.start_day, r.days - 1) >= W.today).length;
    if (live >= C.max_bookings) throw new Refuse(429, `You can have ${C.max_bookings} banner booking${C.max_bookings === 1 ? "" : "s"} open at once.`);
    const taken = await getQuery(`SELECT day FROM banner_days WHERE day IN (${want.map(() => "?").join(",")})`, want);
    if (taken.length) throw new Refuse(409, `${taken.map((r) => r.day).join(", ")} ${taken.length === 1 ? "is" : "are"} already booked - pick other days.`);
    const r = await require("./ledger").post(user.userId, -price, `📣 homepage banner hold: ${days} day${days === 1 ? "" : "s"} from ${start}`.slice(0, 120),
                                             { requireCover: true, transactionId: txRef(ref), source: "banner" });
    if (!r.ok) throw new Refuse(402, `${days} day${days === 1 ? "" : "s"} cost${days === 1 ? "s" : ""} ${fmt(price)} PAT - you don't have enough.`);
    for (const d of want) await runQuery("INSERT INTO banner_days (day, booking_id) VALUES (?, ?)", [d, id]);
    await runQuery(`INSERT INTO banner_bookings (id, user_id, username, start_day, days, kind, headline, line, image, alt, link, price, ref, status, created)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
                   [id, user.userId, user.username || null, start, days, kind, headline || null, line || null, image, alt || null, link, price, ref, t]);
  });
  if (image) MINE.delete(image);
  console.log(`[banner] booking ${id} by ${user.username || user.userId}: ${days} day(s) from ${start}, ${kind}, held ${price}`);
  try { await notifyStaff(id, user, start, days); } catch (e) { /* notice only */ }
  return { dup: false, booking: view(await row(id)) };
}
async function notifyStaff(id, user, start, days) {
  const staff = await getQuery("SELECT userId FROM users WHERE class IN ('Admin','Staff')");
  for (const s of staff) {
    await require("./inbox").addSafe(s.userId, { kind: "admin", title: `📣 Banner booking to review: ${user.username || "a member"}, ${days} day${days === 1 ? "" : "s"} from ${start}`,
      body: "Approve or reject it before its first day starts (it's refunded automatically if nobody does).", link: "/admin/banner#queue", ref: "banner-q:" + id });
  }
}
async function row(id) { return (await getQuery("SELECT * FROM banner_bookings WHERE id = ?", [String(id || "")]))[0] || null; }
function endDay(r) { return addDays(r.start_day, r.days - 1); }
function view(r, stats = null) {
  if (!r) return null;
  return { id: r.id, username: r.username, start: r.start_day, end: endDay(r), days: r.days, kind: r.kind, headline: r.headline, line: r.line,
           image: imageUrl(r.image), alt: r.alt, link: r.link, domain: linkDomain(r.link), price: r.price, status: r.status, reason: r.reason,
           created: r.created, decided_at: r.decided_at, refunded: r.refunded, stats };
}
/** Refund a booking's hold, once (status moves inside the same transaction). */
async function refundIn(r, why) {
  const out = await require("./ledger").post(r.user_id, r.price, `📣 homepage banner refund: ${why}`.slice(0, 120),
                                             { transactionId: txRef(r.ref + ":refund"), source: "banner refund", resolveMerged: true });
  if (!out.ok) throw new Error(`refund failed (${out.code})`);
  await runQuery("UPDATE banner_bookings SET refunded = ? WHERE id = ?", [r.price, r.id]);
  await runQuery("DELETE FROM banner_days WHERE booking_id = ?", [r.id]);
}
/** A pending booking ends without running: rejected / cancelled / expired, refunded in full. -> the booking */
async function closePending(id, status, { actor = null, reason = null } = {}) {
  await init();
  let r0 = null;
  await tx(async () => {
    const r = await row(id);
    if (!r) throw new Refuse(404, "No such booking.");
    if (r.status !== "pending") throw new Refuse(409, `That booking is already ${r.status}.`);
    const ch = await runQuery("UPDATE banner_bookings SET status = ?, reason = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'",
                              [status, reason || null, NOW(), actor, r.id]);
    if (!ch || ch.changes !== 1) throw new Refuse(409, "That booking just changed - reload.");
    await refundIn(r, status);
    r0 = r;
  });
  if (r0.image) removeFile(r0.image);
  return row(id);
}
async function cancel(user, id) {
  const r = await row(id);
  if (!r || !user || r.user_id !== user.userId) throw new Refuse(404, "No such booking.");
  const out = await closePending(id, "cancelled", { actor: user.username || user.userId });
  console.log(`[banner] booking ${id} cancelled by its buyer, refunded ${r.price}`);
  return view(out);
}
async function decide(staff, id, approve, reason) {
  await init();
  if (!canReview(staff)) throw new Refuse(403, "Staff only.");
  const why = cleanLine(reason, REASON_MAX);
  const who = staff.username || staff.userId;
  if (!approve) {
    if (!why) throw new Refuse(400, "Say why it's rejected (the buyer sees it).");
    const r = await closePending(id, "rejected", { actor: who, reason: why });
    await notice(r.user_id, { title: "📣 Your homepage banner wasn't approved", body: `${why} Your ${fmt(r.price)} PAT were refunded in full.`, ref: "banner-no:" + r.id });
    console.log(`[banner] booking ${id} rejected by ${who}: ${why}`);
    return view(r);
  }
  let routing = null, r0 = null;
  await require("./premium").init();                // its routing table (the "banner" row)
  await tx(async () => {
    const r = await row(id);
    if (!r) throw new Refuse(404, "No such booking.");
    if (r.status !== "pending") throw new Refuse(409, `That booking is already ${r.status}.`);
    if (endDay(r) < dayKey(NOW())) throw new Refuse(409, "That booking's days are over.");
    const ch = await runQuery("UPDATE banner_bookings SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'", [NOW(), who, r.id]);
    if (!ch || ch.changes !== 1) throw new Refuse(409, "That booking just changed - reload.");
    routing = await require("./premium").bookRoute("banner", r.price, { payerId: r.user_id, ownerSelf: true, label: `homepage banner ${r.id}` });
    await runQuery("UPDATE banner_bookings SET routing = ? WHERE id = ?", [JSON.stringify(routing), r.id]);
    r0 = r;
  });
  await notice(r0.user_id, { title: "📣 Your homepage banner is approved", body: `It shows on ${r0.start_day}${r0.days > 1 ? " to " + endDay(r0) : ""} (New York time). Its views and clicks are on /sponsor.`, ref: "banner-ok:" + r0.id });
  console.log(`[banner] booking ${id} approved by ${who}; routed ${JSON.stringify(routing)}`);
  require("./achievements").poke(r0.user_id);               // 1.99pa: 🪧 Billboard (achsocial.js)
  return view(await row(id));
}
/** Staff take an approved booking down (a Terms breach): it stops showing, its remaining days free up, no refund. */
async function takedown(staff, id, reason) {
  await init();
  if (!canReview(staff)) throw new Refuse(403, "Staff only.");
  const why = cleanLine(reason, REASON_MAX);
  if (!why) throw new Refuse(400, "Say why it's taken down (the buyer sees it).");
  const r = await row(id);
  if (!r || r.status !== "approved") throw new Refuse(404, "No approved booking with that id.");
  const who = staff.username || staff.userId;
  await runQuery("UPDATE banner_bookings SET status = 'removed', reason = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'approved'", [why, NOW(), who, r.id]);
  await runQuery("DELETE FROM banner_days WHERE booking_id = ? AND day > ?", [r.id, dayKey(NOW())]);
  await notice(r.user_id, { title: "📣 Your homepage banner was taken down", body: why, ref: "banner-down:" + r.id });
  console.log(`[banner] booking ${id} taken down by ${who}: ${why}`);
  return view(await row(id));
}
/** Pending bookings whose first day has started: expired, refunded in full. Run by the timer. -> count */
async function expire(t = NOW()) {
  await init();
  const today = dayKey(t);
  const due = await getQuery("SELECT id, user_id, price, start_day FROM banner_bookings WHERE status = 'pending' AND start_day <= ?", [today]);
  let n = 0;
  for (const r of due) {
    try {
      await closePending(r.id, "expired", { actor: "auto", reason: "Not reviewed before its first day." });
      await notice(r.user_id, { title: "📣 Your homepage banner booking expired", body: `Nobody reviewed it before ${r.start_day}. Your ${fmt(r.price)} PAT were refunded in full - sorry!`, ref: "banner-exp:" + r.id });
      n++;
    } catch (e) { if (!e.refuse) console.error("[banner] expire", r.id, e.message); }
  }
  return n;
}

// ── what shows ──
const RR = { n: 0 };
async function promos({ all = false } = {}) {
  await init();
  return getQuery(`SELECT * FROM banner_promos ${all ? "" : "WHERE enabled = 1"} ORDER BY sort, id`);
}
function compact(n) {
  const x = Number(n) || 0;
  if (x >= 1e9) return (Math.round(x / 1e8) / 10) + "B";
  if (x >= 1e6) return (Math.round(x / 1e5) / 10) + "M";
  if (x >= 1e3) return (Math.round(x / 100) / 10) + "k";
  return String(Math.round(x));
}
/** "Sunday 9 pm ET" (the lotto's draw), in the viewer's language. */
function drawLabel(nextAt, lang = "en") {
  let ms = Number(nextAt) || 0;
  if (!ms) return null;
  if (ms < 1e11) ms *= 1000;
  try {
    const o = partsIn(ms, BANNER_TZ);
    const opts = { timeZone: BANNER_TZ, hour: "numeric" };
    if (Number(o.minute)) opts.minute = "2-digit";
    const d = new Date(ms);
    return new Intl.DateTimeFormat(lang || "en", { timeZone: BANNER_TZ, weekday: "long" }).format(d) + " " + new Intl.DateTimeFormat(lang || "en", opts).format(d) + " ET";
  } catch (e) { return null; }
}
/**
 * The banner for one page view, or null (slot off / nothing to show). lotto = home.stats().lotto ({jackpot, next_at}).
 * -> {ad: "b:<id>" | "h:<id>", paid: bool, kind: image|text, promo (house kind), headline, line, image, alt, link (the
 *     click-through), href (the counted /b/go/... link), external, domain, by, vars: {jackpot, draw}}
 */
async function pick({ lotto = null, lang = "en", t = NOW() } = {}) {
  await init();
  if (!CONFIG.enabled) return null;
  const today = dayKey(t);
  const d = (await getQuery(`SELECT b.* FROM banner_days d JOIN banner_bookings b ON b.id = d.booking_id WHERE d.day = ? AND b.status = 'approved'`, [today]))[0];
  if (d) {
    return { ad: "b:" + d.id, paid: true, kind: d.kind === "image" && d.image ? "image" : "text", headline: d.headline, line: d.line,
             image: imageUrl(d.image), alt: d.alt, link: d.link, href: d.link ? "/b/go/b/" + d.id : null, external: !!(d.link && d.link[0] !== "/"),
             domain: linkDomain(d.link), by: d.username, vars: {}, bookable: !!CONFIG.paid_enabled };
  }
  const vars = { jackpot: lotto && lotto.jackpot ? compact(lotto.jackpot) : null, draw: lotto && lotto.next_at ? drawLabel(lotto.next_at, lang) : null };
  // 1.99kz: the lotto promo's own design shows the exact jackpot (the /lotto page's number: lotto_state.jackpot), a live
  // countdown to the draw and the tickets sold
  if (vars.jackpot) Object.assign(vars, { jackpot_n: Math.round(Number(lotto.jackpot)), next_at: Number(lotto.next_at) || 0, sold: Math.max(0, Math.round(Number(lotto.sold) || 0)) });
  const sup = supportTerms();                  // 1.99kz: {rate, bonus} while /support has a donation rail on, else null
  if (sup) Object.assign(vars, sup);
  const list = (await promos()).filter((p) => (p.kind !== "lotto" || (vars.jackpot && vars.draw)) && (p.kind !== "support" || sup));
  if (!list.length) return null;
  const bag = [];
  for (const p of list) for (let i = 0; i < Math.max(1, Math.min(10, p.weight || 1)); i++) bag.push(p);
  const p = bag[RR.n++ % bag.length];
  if (RR.n > 1e9) RR.n = 0;
  const fill = (s) => (s ? String(s).replace(/\{(jackpot|draw)\}/g, (m, k) => vars[k] || "") : s);
  return { ad: "h:" + p.id, paid: false, kind: "text", promo: p.kind, headline: fill(p.headline) || null, line: fill(p.line) || null,
           link: p.link || null, href: p.link ? "/b/go/h/" + encodeURIComponent(p.id) : null, external: !!(p.link && p.link[0] !== "/"),
           domain: linkDomain(p.link), by: null, vars, bookable: !!CONFIG.paid_enabled };
}

// ── 1.99qr: the booking in Pepe's chat !sponsor rotation ("enable for site banners", banner_chat_sponsor) ──
// While the switch is on, the booking that owns TODAY (an approved one) is handed to Pepe, who runs its headline + link
// as one of his !sponsor slots (camfrog-bot pepe_bannersponsor.py): the same 4 slots, the same hourly cadence and the
// same ad-slot gap as a paid !sponsor, so the rooms never see more sponsor lines than before. Nothing is charged there:
// the booking was paid for here (the hold, booked through the "banner" routing row on approval). Pepe keys the entry by
// the booking id (one rotation entry per booking) and drops it once it isn't listed any more (switch off, taken down,
// its last day over).
const siteBase = () => String(process.env.PUBLIC_BASE_URL || process.env.SITE_URL
  || (process.env.STAGING ? "https://staging.publicaccess.tv" : "https://publicaccess.tv")).replace(/\/+$/, "");
/** -> {on, mic, items: [{id, headline, line, link (absolute or null), by, start, end, until (ms: the end of its last day)}],
 *      house: {on, mic, items: [{id, kind, headline, line, link, weight}]}} (1.99xe: house promos, below) */
async function chatSponsors(t = NOW()) {
  await init();
  const paid = await chatBookings(t);
  return { ...paid, house: await chatHouse(paid.items.length > 0) };
}
async function chatBookings(t) {
  if (!CONFIG.chat_sponsor) return { on: false, mic: false, items: [] };
  const today = dayKey(t);
  const rows = await getQuery(`SELECT b.* FROM banner_days d JOIN banner_bookings b ON b.id = d.booking_id WHERE d.day = ? AND b.status = 'approved'`, [today]);
  const items = [];
  for (const r of rows) {
    const headline = cleanLine(r.headline || r.alt, HEADLINE_MAX);
    if (!headline) continue;                       // an image booking with no words has nothing to say in chat
    const link = r.link ? (r.link[0] === "/" ? siteBase() + r.link : r.link) : null;
    items.push({ id: r.id, headline, line: cleanLine(r.line, LINE_MAX) || null, link, by: r.username || null,
                 start: r.start_day, end: endDay(r), until: dayStart(addDays(endDay(r), 1)) });
  }
  return { on: true, mic: !!CONFIG.chat_sponsor_mic, items };      // 1.99tc: mic = Pepe also reads it aloud (rooms with TTS on)
}

// ── 1.99xe: house promos in Pepe's chat sponsor slot (chat_house_promos, default ON) ──
// With NO paid sponsor running in chat today (no approved booking listed above - a booking always wins), Pepe rotates the
// enabled house promos (banner_promos: Pepeball, Season Pass, Prime Time, Plex, the Wheel, Support PATV, admins' own)
// in his chat sponsor slot, tagged "From PATV" instead of "Sponsored" - it's our own ad, and it says so. Same headline +
// line + link as the homepage card; the dynamic ones render their CURRENT values (the Pepeball jackpot + draw time, the
// donation rate / a live donation promo's boosted rate) each time Pepe asks (every few minutes). A promo whose page isn't
// live (no jackpot / draw yet, no donation rail on) is left out, like on the homepage. Pepe (pepe_bannersponsor.py) runs
// ONE house line an hour at most, only while his whole !sponsor rotation is empty (a member's !sponsor wins too), only
// in rooms whose own settings allow sponsor / house ad lines, and never inside a room's shared ad-slot gap.
// MIC: chat_house_promos_mic, default OFF - paid sponsors bought the read; free house ads don't talk over a room's music.
let EN = null;
function enText(key, vars) {
  if (!EN) { try { EN = JSON.parse(fs.readFileSync(path.join(__dirname, "locales", "en.json"), "utf8")); } catch (e) { EN = {}; } }
  const raw = EN[key];
  if (typeof raw !== "string") return "";
  return plainText(raw.replace(/\{!?(\w+)\}/g, (m, k) => (vars[k] == null ? "" : String(vars[k]))));
}
// catalog values are HTML-safe text: chat wants plain words
const plainText = (s) => String(s || "").replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot|#34|#39|nbsp);/g, (m, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#34": '"', "#39": "'", nbsp: " " })[e]);
async function lottoNow() {
  try {
    const row = (await getQuery("SELECT data FROM lotto_state WHERE id = 1"))[0];
    const L = row ? JSON.parse(row.data) : null;
    return L ? { jackpot: Number(L.jackpot) || 0, next_at: Number(L.next_at) || 0 } : null;
  } catch (e) { return null; }
}
async function chatHouse(paidToday) {
  const mic = !!CONFIG.chat_house_promos_mic;
  if (!CONFIG.chat_house_promos) return { on: false, mic, items: [] };
  if (paidToday) return { on: true, mic, items: [], paid: true };          // a paid booking owns the slot today
  const lotto = await lottoNow();
  const vars = { jackpot: lotto && lotto.jackpot ? compact(lotto.jackpot) : null, draw: lotto && lotto.next_at ? drawLabel(lotto.next_at, "en") : null };
  const sup = supportTerms();
  if (sup) Object.assign(vars, sup);
  const items = [];
  for (const p of await promos()) {
    if (p.kind === "lotto" && !(vars.jackpot && vars.draw)) continue;
    if (p.kind === "support" && !sup) continue;
    const fill = (s) => plainText(String(s || "").replace(/\{(jackpot|draw)\}/g, (m, k) => vars[k] || ""));
    const own = !!(p.headline || p.line);                                    // an admin's own text, else the built-in
    const base = p.kind === "support" && vars.promo_on ? "support_promo" : p.kind;
    const headline = cleanLine(own ? fill(p.headline) : enText(`banner.promo.${base}.h`, vars), HEADLINE_MAX);
    if (!headline) continue;
    const line = cleanLine(own ? fill(p.line) : enText(`banner.promo.${base}.l`, vars), LINE_MAX) || null;
    const link = p.link ? (p.link[0] === "/" ? siteBase() + p.link : p.link) : null;
    items.push({ id: "h:" + p.id, kind: p.kind, headline, line, link, weight: Math.max(1, Math.min(10, Number(p.weight) || 1)) });
  }
  return { on: true, mic, items };
}

// ── stats (aggregate counts only) ──
const SEEN = new Map();     // `${kind}|${viewer}|${ad}` -> day (in memory only; dedupe)
function viewerKey(req) {
  if (req.user && req.user.userId) return "u:" + req.user.userId;
  return "a:" + crypto.createHash("sha256").update(String(req.ip || "") + "|" + String(req.get("user-agent") || "")).digest("hex").slice(0, 16);
}
async function count(ad, what, vkey, t = NOW()) {
  if (!/^(b:[a-f0-9]{12}|h:[a-z0-9_-]{1,40})$/.test(String(ad || ""))) return false;
  const day = dayKey(t);
  const k = `${what}|${vkey}|${ad}`;
  if (SEEN.get(k) === day) return false;
  if (SEEN.size > 200000) SEEN.clear();
  SEEN.set(k, day);
  await init();
  const col = what === "click" ? "clicks" : "impressions";
  await runQuery(`INSERT INTO banner_stats (ad, day, ${col}) VALUES (?, ?, 1) ON CONFLICT(ad, day) DO UPDATE SET ${col} = ${col} + 1`, [ad, day]);
  return true;
}
async function statsFor(ads) {
  const list = [...new Set(ads)];
  const out = new Map(list.map((a) => [a, { impressions: 0, clicks: 0, days: [] }]));
  if (!list.length) return out;
  for (const r of await getQuery(`SELECT ad, day, impressions, clicks FROM banner_stats WHERE ad IN (${list.map(() => "?").join(",")}) ORDER BY day`, list)) {
    const s = out.get(r.ad);
    s.impressions += r.impressions; s.clicks += r.clicks;
    s.days.push({ day: r.day, impressions: r.impressions, clicks: r.clicks });
  }
  return out;
}

// ── pages' data ──
async function calendar(t = NOW()) {
  await init();
  const W = bookWindow(t);
  const rows = await getQuery("SELECT d.day, b.status FROM banner_days d JOIN banner_bookings b ON b.id = d.booking_id WHERE d.day >= ? AND d.day <= ?", [W.today, W.last]);
  const taken = new Map(rows.map((r) => [r.day, r.status]));
  return daysOf(W.today, CONFIG.lead_days + 1).map((d) => ({ day: d, taken: taken.has(d), bookable: d >= W.first && !taken.has(d) }));
}
async function mine(userId) {
  await init();
  const rows = await getQuery("SELECT * FROM banner_bookings WHERE user_id = ? ORDER BY created DESC LIMIT 50", [userId]);
  const S = await statsFor(rows.map((r) => "b:" + r.id));
  return rows.map((r) => view(r, S.get("b:" + r.id)));
}
async function state(user, t = NOW()) {
  await init();
  const C = config();
  const W = bookWindow(t);
  let balance = null;
  if (user && user.userId) { const b = (await getQuery("SELECT points_balance FROM users WHERE userId = ?", [user.userId]))[0]; balance = b ? b.points_balance : null; }
  return { config: { enabled: C.enabled, paid: C.enabled && C.paid_enabled, price: C.price_per_day, maxDays: C.max_days, maxBookings: C.max_bookings, leadDays: C.lead_days },
           window: W, tz: BANNER_TZ, calendar: await calendar(t), mine: user && user.userId ? await mine(user.userId) : [], balance,
           limits: { headline: HEADLINE_MAX, line: LINE_MAX, alt: ALT_MAX, link: LINK_MAX, bytes: MAX_BYTES, w: IMG_W, h: IMG_H } };
}
async function adminData() {
  await init();
  const rows = await getQuery(`SELECT * FROM banner_bookings WHERE status = 'pending' OR (status = 'approved' AND start_day >= ?) OR created > ?
                               ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, start_day LIMIT 200`, [addDays(dayKey(NOW()), -31), NOW() - 30 * 86400e3]);
  const ps = await promos({ all: true });
  const S = await statsFor([...rows.map((r) => "b:" + r.id), ...ps.map((p) => "h:" + p.id)]);
  return { config: config(), settings: settingsView(), bookings: rows.map((r) => view(r, S.get("b:" + r.id))),
           promos: ps.map((p) => ({ ...p, enabled: !!p.enabled, stats: S.get("h:" + p.id) })), kinds: PROMO_KINDS, tz: BANNER_TZ, today: dayKey(NOW()) };
}
async function savePromo(admin, b = {}) {
  await init();
  if (!canConfig(admin)) throw new Refuse(403, "Admins only.");
  let id = String(b.id || "").trim().toLowerCase();
  const exists = id ? (await getQuery("SELECT * FROM banner_promos WHERE id = ?", [id]))[0] : null;
  if (!exists) {
    if (!id) id = "p" + crypto.randomBytes(4).toString("hex");
    if (!/^[a-z0-9_-]{1,40}$/.test(id)) throw new Refuse(400, "Promo ids are a-z, 0-9, - and _.");
  }
  const kind = exists ? exists.kind : PROMO_KINDS.includes(b.kind) ? b.kind : "custom";
  const headline = cleanLine(b.headline, HEADLINE_MAX) || null, line = cleanLine(b.line, LINE_MAX) || null;
  if (kind === "custom" && !headline) throw new Refuse(400, "A custom promo needs a headline.");
  const link = cleanLink(b.link);
  const weight = Math.max(1, Math.min(10, Math.floor(Number(b.weight)) || 1));
  const sort = Math.max(0, Math.min(1000, Math.floor(Number(b.sort)) || 0));
  const enabled = b.enabled === false || b.enabled === 0 || b.enabled === "0" ? 0 : 1;
  await runQuery(`INSERT INTO banner_promos (id, kind, headline, line, link, enabled, weight, sort, updated, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET headline = excluded.headline, line = excluded.line, link = excluded.link, enabled = excluded.enabled,
                  weight = excluded.weight, sort = excluded.sort, updated = excluded.updated, updated_by = excluded.updated_by`,
                 [id, kind, headline, line, link, enabled, weight, sort, NOW(), admin.username || admin.userId]);
  console.log(`[banner] promo ${id} saved by ${admin.username || admin.userId}`);
  return (await getQuery("SELECT * FROM banner_promos WHERE id = ?", [id]))[0];
}
async function deletePromo(admin, id) {
  await init();
  if (!canConfig(admin)) throw new Refuse(403, "Admins only.");
  const r = (await getQuery("SELECT kind FROM banner_promos WHERE id = ?", [String(id || "")]))[0];
  if (!r) throw new Refuse(404, "No such promo.");
  if (r.kind !== "custom") throw new Refuse(400, "Built-in promos can be switched off, not deleted.");
  await runQuery("DELETE FROM banner_promos WHERE id = ?", [String(id)]);
  return true;
}

// ── routes ──
function register(app, { addUser, isBotToken = () => false, noTimers = false }) {
  init().catch(() => {});
  const express = require("express");
  const guard = require("./middleware/authGuard");
  const rawChunk = express.raw({ type: "application/octet-stream", limit: CHUNK_MAX });
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message, ...(e.received != null ? { received: e.received } : {}) });
    console.error("[banner]", e);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  const api = (json, who = "user") => (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!guard.sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    if (json && !req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    if (who === "staff" && !canReview(req.user)) return res.status(403).json({ ok: false, error: "Staff only." });
    if (who === "admin" && !canConfig(req.user)) return res.status(403).json({ ok: false, error: "Admins only." });
    next();
  };
  const paidOpen = (req, res, next) => (CONFIG.enabled && CONFIG.paid_enabled ? next() : res.status(423).json({ ok: false, error: "Banner bookings aren't open yet." }));

  // 1.99qr: Pepe's read of the bookings for his !sponsor rotation (bot token; {on: false} while the switch is off)
  app.post("/api/banner/chat-sponsors", async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!isBotToken((req.body || {}).password)) return res.status(403).json({ ok: false, error: "unauthorized" });
    try { res.json({ ok: true, ...(await chatSponsors()) }); } catch (e) { fail(res, e); }
  });
  app.get("/sponsor", addUser, async (req, res) => {
    try {
      const S = await state(req.user);
      res.set({ "Cache-Control": "no-store" });
      res.render("sponsor", { user: req.user ? req.user.username : null, signed: !!(req.user && req.user.userId), S, fmt });
    } catch (e) { console.error("[banner] page:", e); res.status(500).send("Couldn't load the banner page."); }
  });
  app.get("/api/banner/state", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try { res.json({ ok: true, ...(await state(req.user)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/banner/uploads", addUser, api(true), paidOpen, (req, res) => {
    try { res.json({ ok: true, ...openUpload(req.user.userId, req.body || {}) }); } catch (e) { fail(res, e); }
  });
  app.put("/api/banner/uploads/:id", addUser, api(false), paidOpen, rawChunk, (req, res) => {
    try { res.json({ ok: true, received: chunkUpload(req.user.userId, req.params.id, req.query.offset, req.body) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/banner/uploads/:id/finish", addUser, api(true), paidOpen, async (req, res) => {
    try { res.json({ ok: true, ...(await finishUpload(req.user.userId, req.params.id)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/banner/book", addUser, api(true), async (req, res) => {
    try { res.json({ ok: true, ...(await book(req.user, req.body || {})) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/banner/bookings/:id/cancel", addUser, api(true), async (req, res) => {
    try { res.json({ ok: true, booking: await cancel(req.user, req.params.id) }); } catch (e) { fail(res, e); }
  });
  // an impression: the banner was at least half on screen (the page's beacon)
  app.post("/api/banner/seen", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    if (!guard.sameSite(req) || req.get("X-Requested-With") !== "fetch" || !req.is("application/json")) return res.status(403).json({ ok: false });
    try { await count(String((req.body || {}).ad || ""), "seen", viewerKey(req)); res.json({ ok: true }); } catch (e) { res.json({ ok: false }); }
  });
  // a click: count it, then go to the banner's link (only ever the stored link)
  app.get("/b/go/:kind/:id", addUser, async (req, res) => {
    res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
    try {
      await init();
      const kind = req.params.kind, id = String(req.params.id || "");
      let link = null, ad = null;
      if (kind === "b" && ID_RE.test(id)) { const r = await row(id); if (r && r.status === "approved") { link = r.link; ad = "b:" + r.id; } }
      else if (kind === "h" && /^[a-z0-9_-]{1,40}$/.test(id)) { const p = (await getQuery("SELECT * FROM banner_promos WHERE id = ?", [id]))[0]; if (p) { link = p.link; ad = "h:" + p.id; } }
      if (!link) return res.redirect(302, "/");
      if (ad) await count(ad, "click", viewerKey(req)).catch(() => {});
      res.redirect(302, link);
    } catch (e) { console.error("[banner] go:", e.message); res.redirect(302, "/"); }
  });
  // the pictures: approved (public) or pending / rejected (only its buyer and staff)
  app.get("/media/banner/:file", addUser, async (req, res) => {
    const name = String(req.params.file || "");
    const p = filePath(name);
    if (!p) return res.status(404).end();
    try {
      await init();
      const r = (await getQuery("SELECT user_id, status FROM banner_bookings WHERE image = ? ORDER BY created DESC LIMIT 1", [name]))[0];
      const mineUp = MINE.get(name);
      const pub = r && r.status === "approved";
      const may = pub || (req.user && ((r && r.user_id === req.user.userId) || (mineUp && mineUp.userId === req.user.userId) || canReview(req.user)));
      if (!may || (!r && !mineUp)) { res.set("Cache-Control", "no-store"); return res.status(404).end(); }
      const H = { "Content-Type": "image/webp", "X-Content-Type-Options": "nosniff", "Cache-Control": pub ? "public, max-age=86400" : "private, no-store",
                  "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox", "Cross-Origin-Resource-Policy": "same-origin" };
      res.set(H);
      res.sendFile(p, { etag: true, lastModified: false, cacheControl: false, headers: H }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
    } catch (e) { console.error("[banner] file:", e.message); if (!res.headersSent) res.status(500).end(); }
  });

  // admin: the moderation queue (banner.review), settings + house promos (banner.config)
  app.get("/admin/banner", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent("/admin/banner"));
    if (!canReview(req.user)) return res.status(403).send("Staff only.");
    try {
      res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex" });
      res.render("admin/banner", { user: req.user.username, isAdmin: canConfig(req.user), D: await adminData(), fmt });
    } catch (e) { console.error("[banner] admin:", e); res.status(500).send("Couldn't load the banner admin."); }
  });
  app.post("/api/banner/admin/decide", addUser, api(true, "staff"), async (req, res) => {
    const b = req.body || {};
    try { res.json({ ok: true, booking: await decide(req.user, String(b.id || ""), b.approve === true, b.reason) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/banner/admin/takedown", addUser, api(true, "staff"), async (req, res) => {
    const b = req.body || {};
    try { res.json({ ok: true, booking: await takedown(req.user, String(b.id || ""), b.reason) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/banner/admin/config", addUser, api(true, "admin"), async (req, res) => {
    try { res.json({ ok: true, config: await setConfig(req.body || {}, req.user.username), settings: settingsView() }); } catch (e) { fail(res, e); }
  });
  app.post("/api/banner/admin/promo", addUser, api(true, "admin"), async (req, res) => {
    try { res.json({ ok: true, promo: await savePromo(req.user, req.body || {}) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/banner/admin/promo/delete", addUser, api(true, "admin"), async (req, res) => {
    try { res.json({ ok: true, deleted: await deletePromo(req.user, (req.body || {}).id) }); } catch (e) { fail(res, e); }
  });
  if (!noTimers) {
    const tick = () => { sweepUploads(); expire().catch((e) => console.error("[banner] expire:", e.message)); };
    setInterval(tick, 10 * 60e3).unref();
    setTimeout(tick, 30e3).unref();
  }
}

module.exports = { init, register, chatSponsors, chatHouse, config, setConfig, settingsView, cleanConfig, book, cancel, decide, takedown, expire, pick, promos, savePromo, deletePromo,
                   state, adminData, calendar, mine, count, statsFor, storeImage, openUpload, chunkUpload, finishUpload, encode, cleanLink, dayKey, dayStart,
                   addDays, drawLabel, compact, setSafetyCheck, filePath, imageUrl, _setDir, Refuse, DEFAULTS, DEFAULT_PROMOS, PROMO_KINDS, BANNER_TZ, SETTING_NAMES,
                   _setClock: (fn) => { NOW = fn || (() => Date.now()); }, _uploads: UP, _mine: MINE, _seen: SEEN };
