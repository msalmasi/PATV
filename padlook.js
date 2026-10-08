// padlook.js — a pad's look (1.99es): its avatar, its banner (an upload, with a vertical focal point) and its accent
// colour. Free, owner-only (rooms.canManage: the pad's owner + site staff), set from the General tab of the pad
// settings hub (padsettings.js, public/js/pad-look.js).
//
// Table pad_looks: room_id PK, avatar (file name), banner (file name), banner_y (0-100: the banner's vertical focal
// point, %), accent (#rrggbb, lowercase), cosmetics (JSON, reserved for premium pad cosmetics - see COSMETIC_SLOTS),
// updated, updated_by. A pad without a row looks exactly as before (the monogram / emoji badge, the link banner).
//
// Uploads: the feed's safety pipeline (feedmedia.js) - the browser sends the file in 512 KB chunks (nginx's body
// limit), the type is decided by MAGIC BYTES (pictures only: JPEG, PNG, GIF, WebP, AVIF, HEIC), and nothing a user
// sent is ever served: sharp re-encodes to webp with NO metadata (EXIF / GPS / XMP / ICC dropped, orientation baked
// in, first frame only), avatar = a 256 px square (smart crop), banner = 1600 px wide, cropped to between 4:1 and 2:1
// around the focal point (so the focal point can still move later without a re-upload). 5 MB cap on the original.
// Then the SAFETY CHECK (setSafetyCheck; the same hook for avatar and banner): the Terms forbid adult content in pad
// listings, so an image the check flags as NSFW is REFUSED (nothing is stored). 1.99fc: index.js installs imagesafety.js
// here (Pepe's vision, surface "pad_look"); it ships switched off, and while it's off the check passes everything, as
// before. A site admin can still remove a pad's avatar / banner from its settings hub (staff manage any pad).
// Files: PAD_DIR (default /var/lib/patv[-staging]/pad; off Linux a folder next to the code tree), random 32-hex names,
// served by GET /media/pad/<file> ONLY while a pad uses it (a replaced file 404s even before it's deleted), immutable
// cache headers (a new upload = a new name). The old file is deleted on replace / remove.
//
// Accent: one of PALETTE, or a custom #rrggbb. It's only ever written into a CSS custom property (--pad-accent,
// --pad-accent-ink) after a strict hex check, never as CSS of its own. Contrast guard: the accent is drawn as text /
// borders on the dark theme and as a button background, so it must reach 4.5:1 against the page (#0d0d0d); a custom
// colour that doesn't is LIGHTENED until it does (the owner is told), and the ink on accent buttons is whichever of
// near-black / white reads better (>= 4.5:1 too).
//
// 1.99ew premium pad cosmetics (padcosmetics.js): pad_looks.cosmetics holds what's EQUIPPED ({pad_frame, pad_glow,
// pad_avatar: item id, pad_badge: [up to 3 ids]}; what a pad owns is padcosmetics' pad_cosmetic_items). The ANIMATED
// AVATAR (item pa_animated, kind pad_avatar) is one more upload kind, "avatar_anim", through this same pipeline (chunks,
// magic-byte sniff, the same safety hook): animated GIF / WebP only, re-encoded by sharp to a 256 px square ANIMATED
// webp (metadata stripped, at most ANIM_MAX_FRAMES frames, the output capped at ANIM_MAX_OUT - quality steps down,
// then it's refused) plus a still of its first frame (<hex>_w.webp) that reduced-motion viewers get (<picture>).
// Only a pad that owns pa_animated can upload one; it shows while pad_avatar is equipped (else the normal avatar).
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");

const MAX_BYTES = 5 * 1024 * 1024;
const CHUNK = 512 * 1024, CHUNK_MAX = 768 * 1024;
const AVATAR_PX = 256, BANNER_W = 1600, BANNER_MIN_H = 400, BANNER_MAX_H = 800;
const MAX_INPUT_PIXELS = 60e6;
const UPLOAD_TTL = 15 * 60e3, OPEN_PER_USER = 2;
const KINDS = Object.freeze(["avatar", "banner", "avatar_anim"]);
const FILE_RE = /^[a-f0-9]{32}_(a|b|v|w)\.webp$/;
const ANIM_MAX_OUT = 1024 * 1024, ANIM_MAX_FRAMES = 150, ANIM_ITEM = "pa_animated";   // 1.99ew: the animated avatar
const stillOf = (anim) => (anim && /_v\.webp$/.test(anim) ? anim.replace(/_v\.webp$/, "_w.webp") : null);
const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
const BG = "#0d0d0d", INK_DARK = "#0b0b0b", INK_LIGHT = "#ffffff", MIN_CONTRAST = 4.5;
// 12 presets, every one >= 4.5:1 on the dark theme (test/pad-look.test.js checks)
const PALETTE = Object.freeze([
  { id: "frog", name: "Frog green", hex: "#66bb6a" }, { id: "lime", name: "Lime", hex: "#c6e94f" },
  { id: "teal", name: "Teal", hex: "#26c6da" }, { id: "sky", name: "Sky", hex: "#4fc3f7" },
  { id: "blue", name: "Blue", hex: "#64b5f6" }, { id: "indigo", name: "Lavender", hex: "#9fa8da" },
  { id: "purple", name: "Purple", hex: "#ba68c8" }, { id: "pink", name: "Pink", hex: "#f06292" },
  { id: "red", name: "Red", hex: "#ef5350" }, { id: "orange", name: "Orange", hex: "#ff8a50" },
  { id: "amber", name: "Amber", hex: "#ffca28" }, { id: "slate", name: "Slate", hex: "#b0bec5" },
]);
// Premium pad cosmetics (1.99ew, padcosmetics.js + padcosmetics.json): a pad's equipped ones live in pad_looks.cosmetics.
const COSMETIC_SLOTS = Object.freeze({ pad_frame: "Banner frame", pad_glow: "Name glow", pad_badge: "Pad badge", pad_avatar: "Animated avatar" });
let NOW = () => Date.now();

class LookRefuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }

// ── colour maths (WCAG 2.x) ──
/** "#abc" / "abc" / "#aabbcc" -> "#aabbcc" (lowercase), or null. Nothing else gets through. */
function normHex(v) {
  if (typeof v !== "string") return null;
  const m = HEX_RE.exec(v.trim());
  if (!m) return null;
  let h = m[1].toLowerCase();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return "#" + h;
}
const rgb = (hex) => { const h = normHex(hex); return h ? [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) : null; };
const toHex = (c) => "#" + c.map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("");
function luminance(hex) {
  const c = rgb(hex);
  if (!c) return 0;
  const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** The ink for text ON the accent: near-black or white, whichever reads better. */
const inkFor = (hex) => (contrast(hex, INK_DARK) >= contrast(hex, INK_LIGHT) ? INK_DARK : INK_LIGHT);
/**
 * The contrast guard. -> {hex, adjusted, ratio} for a usable accent (a too-dark one is mixed towards white until it
 * reaches MIN_CONTRAST on the page), or null for anything that isn't a strict hex colour.
 */
function guardAccent(v) {
  const h = normHex(v);
  if (!h) return null;
  let c = rgb(h), out = h, n = 0;
  while (contrast(out, BG) < MIN_CONTRAST && n < 40) {
    c = c.map((x) => x + (255 - x) * 0.06);
    out = toHex(c);
    n++;
  }
  return { hex: out, adjusted: out !== h, ratio: Math.round(contrast(out, BG) * 100) / 100, ink: inkFor(out) };
}

// ── storage ──
function pickDir() {
  if (process.env.PAD_DIR) return path.resolve(process.env.PAD_DIR);
  if (process.platform === "linux") {
    const d = process.env.STAGING ? "/var/lib/patv-staging/pad" : "/var/lib/patv/pad";
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (e) { /* not root: below */ }
  }
  return path.resolve(__dirname, "..", path.basename(__dirname) + "-pad");
}
let DIR = null;
function dir() {
  if (!DIR) { DIR = pickDir(); fs.mkdirSync(DIR, { recursive: true }); console.log(`[padlook] media dir ${DIR}`); }
  return DIR;
}
function _setDir(d) { DIR = d; fs.mkdirSync(DIR, { recursive: true }); }
function filePath(name) {
  if (!FILE_RE.test(String(name || ""))) return null;
  return path.join(dir(), name.slice(0, 2), name);
}
const url = (name) => (name && FILE_RE.test(name) ? "/media/pad/" + name : null);
function removeFile(name) { const p = filePath(name); if (p) { try { fs.unlinkSync(p); } catch (e) { /* gone */ } } }

// ── table + cache (views read it synchronously) ──
let CACHE = new Map();
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS pad_looks (room_id TEXT PRIMARY KEY, avatar TEXT, banner TEXT, banner_y INTEGER NOT NULL DEFAULT 50,
        accent TEXT, cosmetics TEXT, updated INTEGER, updated_by TEXT)`);
      try { await runQuery("ALTER TABLE pad_looks ADD COLUMN avatar_anim TEXT"); } catch (e) { /* 1.99ew: already there */ }
      await loadCache();
    })().catch((e) => { console.error("[padlook] init:", e.message); ready = null; throw e; });
  }
  return ready;
}
async function loadCache() {
  const m = new Map();
  for (const r of await getQuery("SELECT * FROM pad_looks")) m.set(r.room_id, r);
  CACHE = m;
}
const clampY = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 50; };

/** The equipped pad cosmetics (pad_looks.cosmetics), parsed: {pad_frame, pad_glow, pad_avatar: id|null, pad_badge: [ids]}. Sync. */
function cosmeticsOf(roomId) {
  const r = CACHE.get(String(roomId || ""));
  return parseCosmetics(r && r.cosmetics);
}
function parseCosmetics(raw) {
  let c = null;
  try { c = raw ? JSON.parse(raw) : null; } catch (e) { c = null; }
  const id = (v) => (typeof v === "string" && /^[a-z0-9_]{1,40}$/.test(v) ? v : null);
  const o = { pad_frame: null, pad_glow: null, pad_avatar: null, pad_badge: [] };
  if (c && typeof c === "object") {
    o.pad_frame = id(c.pad_frame); o.pad_glow = id(c.pad_glow); o.pad_avatar = id(c.pad_avatar);
    o.pad_badge = Array.isArray(c.pad_badge) ? [...new Set(c.pad_badge.map(id).filter(Boolean))].slice(0, 3) : [];
  }
  return o;
}
/** A pad's look for views: {avatar, banner (urls or null), bannerY, accent, ink, vars (a safe style string), avatarAnim /
 *  avatarStill (the animated avatar + its still, only while pad_avatar is equipped), hasAnim (uploaded at all)}. Sync. */
function look(roomId) {
  const r = CACHE.get(String(roomId || ""));
  const accent = r ? normHex(r.accent) : null;
  const L = { avatar: r ? url(r.avatar) : null, banner: r ? url(r.banner) : null, bannerY: r ? clampY(r.banner_y) : 50, accent, ink: accent ? inkFor(accent) : null };
  const anim = r && FILE_RE.test(String(r.avatar_anim || "")) ? r.avatar_anim : null;
  L.hasAnim = !!anim;
  L.avatarAnim = anim && cosmeticsOf(roomId).pad_avatar ? url(anim) : null;
  L.avatarStill = L.avatarAnim ? url(stillOf(anim)) : null;
  if (!L.avatar && L.avatarStill) L.avatar = L.avatarStill;        // anything that shows a plain <img> gets the still
  L.vars = cssVars(L);
  return L;
}
/** The ONLY way a look reaches CSS: custom properties from re-validated values ("" when there's nothing). */
function cssVars(L) {
  const out = [];
  const a = L && normHex(L.accent);
  if (a) out.push(`--pad-accent:${a}`, `--pad-accent-ink:${inkFor(a)}`);
  if (L && L.banner) out.push(`--pad-banner-y:${clampY(L.bannerY)}%`);
  return out.join(";");
}
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/** The monogram a pad falls back to: 🛋️ site pads, 🐸 house pads, else its first letter / digit (as the feed's chips). */
function monogram(p) {
  if (p && p.community) return "🛋️";          // the same order as the feed's chips (feedweb cBadge)
  if (p && p.house) return "🐸";
  const t = String((p && (p.title || p.name)) || "?").replace(/^[^\p{L}\p{N}]+/u, "");
  return (Array.from(t)[0] || "?").toUpperCase();
}
/**
 * A pad's avatar as html: <img> when it has one, else `fallback` (already-escaped html; default: the monogram).
 * cls: extra classes. Always aria-hidden (the pad's name is next to it everywhere).
 */
function avatarHtml(roomId, opts = {}) {
  const L = look(roomId);
  const cls = esc(("pad-av " + (opts.cls || "")).trim());
  if (L.avatarAnim) {
    // 1.99ew: the animated avatar; reduced-motion viewers get its first frame
    return `<span class="${cls} has-img is-anim" aria-hidden="true"><picture><source media="(prefers-reduced-motion: reduce)" srcset="${L.avatarStill}">` +
           `<img src="${L.avatarAnim}" alt="" loading="lazy" decoding="async"></picture></span>`;
  }
  if (L.avatar) return `<span class="${cls} has-img" aria-hidden="true"><img src="${L.avatar}" alt="" loading="lazy" decoding="async"></span>`;
  if (opts.fallback != null) return opts.fallback;
  let P = opts.pad || null;
  if (!P || P.house == null) {
    let R = null;
    try { R = require("./rooms").getCached(roomId); } catch (e) { R = null; }
    if (R) P = { title: (P && P.title) || R.title, house: R.house, community: R.community };
  }
  return `<span class="${cls}" aria-hidden="true">${esc(monogram(P))}</span>`;
}

// ── the safety check (pluggable; see the header) ──
let SAFETY = async () => ({ ok: true });
/** fn({buf, kind, roomId, userId}) -> {ok:true} | {ok:false, nsfw:true, reason}. Tests stub it; null restores the default. */
function setSafetyCheck(fn) { SAFETY = typeof fn === "function" ? fn : async () => ({ ok: true }); }

// ── re-encode ──
async function encode(buf, kind, bannerY = 50) {
  const media = require("./feedmedia");
  const sn = media.sniff(buf);
  if (sn.bad || sn.kind !== "image") {
    throw new LookRefuse(415, sn.bad && /HTML|Text|PDF|Archives|Playlists/.test(sn.bad) ? sn.bad : "Pictures only: JPEG, PNG, GIF, WebP, AVIF or HEIC.");
  }
  let input = buf, cleanup = () => {};
  if (sn.fmt === "heic") {
    const tmp = path.join(dir(), "tmp-" + crypto.randomBytes(8).toString("hex") + ".heic");
    fs.writeFileSync(tmp, buf);
    try { const h = await media.heicToPng(tmp, { tmpDir: dir() }); input = h.png; cleanup = h.cleanup; } finally { try { fs.unlinkSync(tmp); } catch (e) { /* none */ } }
  }
  const sharp = require("sharp");
  try {
    let meta;
    try { meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata(); } catch (e) { throw new LookRefuse(415, "That picture couldn't be read."); }
    const fmtOk = { jpeg: "jpeg", png: "png", gif: "gif", webp: "webp", avif: "heif", heic: "png" }[sn.fmt];
    if (!meta || (fmtOk && meta.format !== fmtOk)) throw new LookRefuse(415, "That picture's contents don't match its type.");
    const base = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).rotate();   // first frame only; orientation baked in
    let out;
    if (kind === "avatar") {
      out = await base.resize({ width: AVATAR_PX, height: AVATAR_PX, fit: "cover", position: sharp.strategy.attention }).webp({ quality: 84 }).toBuffer({ resolveWithObject: true });
    } else {
      // 1600 px wide (never enlarged past the original), then cropped to between 4:1 and 2:1 around the focal point
      const W0 = (meta.autoOrient && meta.autoOrient.width) || ((meta.orientation || 1) >= 5 ? meta.height : meta.width);
      const H0 = (meta.autoOrient && meta.autoOrient.height) || ((meta.orientation || 1) >= 5 ? meta.width : meta.height);
      const w = Math.min(BANNER_W, W0);
      const h = Math.round(H0 * (w / W0));
      const hMin = Math.round(w * (BANNER_MIN_H / BANNER_W)), hMax = Math.round(w * (BANNER_MAX_H / BANNER_W));
      const hh = Math.max(Math.min(h, hMax), Math.min(hMin, h));
      const scaled = await base.resize({ width: w, height: h, fit: "fill" }).toBuffer();
      const top = Math.max(0, Math.min(h - hh, Math.round((h - hh) * (clampY(bannerY) / 100))));
      out = await sharp(scaled).extract({ left: 0, top, width: w, height: hh }).webp({ quality: 80 }).toBuffer({ resolveWithObject: true });
    }
    return { buf: out.data, w: out.info.width, h: out.info.height, bytes: out.info.size };
  } catch (e) {
    if (e && e.refuse) throw e;
    throw new LookRefuse(415, "That picture couldn't be processed.");
  } finally { cleanup(); }
}

/**
 * 1.99ew: the animated avatar. GIF / WebP with 2+ frames -> {anim: a 256 px square animated webp (<= ANIM_MAX_OUT),
 * still: its first frame as a webp}. Metadata stripped (sharp writes none unless asked).
 */
async function encodeAnim(buf) {
  const media = require("./feedmedia");
  const sn = media.sniff(buf);
  if (sn.bad || sn.kind !== "image" || !["gif", "webp"].includes(sn.fmt)) throw new LookRefuse(415, "Animated avatars are an animated WebP or GIF.");
  const sharp = require("sharp");
  let meta;
  try { meta = await sharp(buf, { animated: true, limitInputPixels: MAX_INPUT_PIXELS }).metadata(); } catch (e) { throw new LookRefuse(415, "That picture couldn't be read."); }
  if (!meta || meta.format !== sn.fmt) throw new LookRefuse(415, "That picture's contents don't match its type.");
  const pages = Number(meta.pages) || 1;
  if (pages < 2) throw new LookRefuse(415, "That picture isn't animated - upload it as the normal avatar instead.");
  if (pages > ANIM_MAX_FRAMES) throw new LookRefuse(413, `Animated avatars can have up to ${ANIM_MAX_FRAMES} frames.`);
  try {
    const opts = { animated: true, limitInputPixels: MAX_INPUT_PIXELS };
    let anim = null;
    for (const q of [70, 55, 40]) {
      const out = await sharp(buf, opts).resize({ width: AVATAR_PX, height: AVATAR_PX, fit: "cover", position: "centre" })
        .webp({ quality: q, effort: 4, loop: 0 }).toBuffer({ resolveWithObject: true });
      if (out.info.size <= ANIM_MAX_OUT) { anim = out; break; }
    }
    if (!anim) throw new LookRefuse(413, `That animation is too big even at 256 px - keep it under ${ANIM_MAX_OUT / 1024 / 1024} MB (fewer frames or colours).`);
    const still = await sharp(buf, { pages: 1, limitInputPixels: MAX_INPUT_PIXELS }).resize({ width: AVATAR_PX, height: AVATAR_PX, fit: "cover", position: "centre" })
      .webp({ quality: 84 }).toBuffer({ resolveWithObject: true });
    return { buf: anim.data, still: still.data, w: anim.info.width, h: anim.info.pageHeight || anim.info.height, bytes: anim.info.size, frames: pages };
  } catch (e) {
    if (e && e.refuse) throw e;
    throw new LookRefuse(415, "That picture couldn't be processed.");
  }
}

// ── writes ──
async function row(roomId) { await init(); return (await getQuery("SELECT * FROM pad_looks WHERE room_id = ?", [roomId]))[0] || null; }
async function upsert(roomId, patch, actor) {
  await init();
  const cur = (await row(roomId)) || { avatar: null, banner: null, banner_y: 50, accent: null, cosmetics: null, avatar_anim: null };
  const next = { ...cur, ...patch };
  await runQuery(`INSERT INTO pad_looks (room_id, avatar, banner, banner_y, accent, cosmetics, avatar_anim, updated, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(room_id) DO UPDATE SET avatar = excluded.avatar, banner = excluded.banner, banner_y = excluded.banner_y,
                  accent = excluded.accent, cosmetics = excluded.cosmetics, avatar_anim = excluded.avatar_anim, updated = excluded.updated, updated_by = excluded.updated_by`,
                 [roomId, next.avatar || null, next.banner || null, clampY(next.banner_y), next.accent || null, next.cosmetics || null, next.avatar_anim || null, NOW(), String(actor || "?").slice(0, 60)]);
  CACHE.set(roomId, { room_id: roomId, ...next, banner_y: clampY(next.banner_y) });
  return cur;
}
/** Can this pad upload an animated avatar? (it owns pa_animated - padcosmetics) */
async function animAllowed(roomId) {
  try { return await require("./padcosmetics").hasItem(roomId, ANIM_ITEM); } catch (e) { return false; }
}
/** Store a checked, re-encoded picture as the pad's avatar / banner / animated avatar; the old file goes. -> look(roomId) */
async function setImage(roomId, kind, buf, { userId, actor, bannerY } = {}) {
  if (!KINDS.includes(kind)) throw new LookRefuse(400, "Avatar or banner only.");
  if (!Buffer.isBuffer(buf) || buf.length < 12) throw new LookRefuse(400, "That file is empty.");
  if (buf.length > MAX_BYTES) throw new LookRefuse(413, `Pictures can be up to ${MAX_BYTES / 1024 / 1024} MB.`);
  if (kind === "avatar_anim" && !(await animAllowed(roomId))) throw new LookRefuse(403, "Animated avatars are a pad cosmetic - get one in ✨ Cosmetics first.");
  const y = clampY(bannerY);
  const enc = kind === "avatar_anim" ? await encodeAnim(buf) : await encode(buf, kind, y);
  let verdict;
  try { verdict = await SAFETY({ buf: enc.buf, still: enc.still || null, kind, roomId, userId }); } catch (e) { verdict = { ok: false, reason: "The safety check couldn't run - try again in a minute." }; }
  if (!verdict || verdict.ok !== true) {
    const msg = verdict && verdict.nsfw ? "That picture looks like adult content - pad avatars and banners must be safe for work (Terms)."
      : (verdict && verdict.reason) || "That picture can't be used.";
    throw new LookRefuse(422, msg);
  }
  const name = crypto.randomBytes(16).toString("hex") + ({ avatar: "_a", banner: "_b", avatar_anim: "_v" }[kind]) + ".webp";
  const p = filePath(name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, enc.buf, { flag: "wx" });
  if (kind === "avatar_anim") fs.writeFileSync(filePath(stillOf(name)), enc.still, { flag: "wx" });
  const dropNew = () => { removeFile(name); if (kind === "avatar_anim") removeFile(stillOf(name)); };
  let old;
  try { old = await upsert(roomId, kind === "avatar" ? { avatar: name } : kind === "avatar_anim" ? { avatar_anim: name } : { banner: name, banner_y: y }, actor); }
  catch (e) { dropNew(); throw e; }
  const prev = old && old[kind];
  if (prev && prev !== name) { removeFile(prev); if (kind === "avatar_anim") removeFile(stillOf(prev)); }
  await event(roomId, "look-" + kind, actor, `${enc.w}x${enc.h} ${enc.bytes} B`);
  return look(roomId);
}
async function removeImage(roomId, kind, actor) {
  if (!KINDS.includes(kind)) throw new LookRefuse(400, "Avatar or banner only.");
  const old = await upsert(roomId, { [kind]: null }, actor);
  if (old && old[kind]) { removeFile(old[kind]); if (kind === "avatar_anim") removeFile(stillOf(old[kind])); }
  await event(roomId, "look-" + kind + "-remove", actor, "");
  return look(roomId);
}
/** Accent ("" / null = none) and the banner's focal point. -> {look, adjusted, requested} */
async function setStyle(roomId, b, actor) {
  const patch = {};
  let adjusted = false, requested = null;
  if (b && "accent" in b) {
    const raw = b.accent == null ? "" : String(b.accent).trim();
    const preset = PALETTE.find((p) => p.id === raw);
    if (!raw) patch.accent = null;
    else {
      const g = guardAccent(preset ? preset.hex : raw);
      if (!g) throw new LookRefuse(400, "Colours are a hex value like #4caf50.");
      patch.accent = g.hex; adjusted = g.adjusted; requested = normHex(raw);
    }
  }
  if (b && "banner_y" in b) patch.banner_y = clampY(b.banner_y);
  if (!Object.keys(patch).length) throw new LookRefuse(400, "Nothing to change.");
  await upsert(roomId, patch, actor);
  await event(roomId, "look-style", actor, JSON.stringify(patch).slice(0, 200));
  return { look: look(roomId), adjusted, requested };
}
/** 1.99ew: write the equipped pad cosmetics (padcosmetics.equip validates first). -> the parsed set */
async function setCosmetics(roomId, cos, actor) {
  const c = parseCosmetics(JSON.stringify(cos || {}));
  const empty = !c.pad_frame && !c.pad_glow && !c.pad_avatar && !c.pad_badge.length;
  await upsert(roomId, { cosmetics: empty ? null : JSON.stringify(c) }, actor);
  return c;
}
async function event(roomId, what, actor, detail) {
  try { await runQuery("INSERT INTO room_events (room_id, ts, what, actor, detail) VALUES (?, ?, ?, ?, ?)", [roomId, NOW(), what, actor || "?", detail || ""]); } catch (e) { /* no table in a bare test DB */ }
}

// ── chunked uploads (in memory: one process, a few MB each, a short TTL) ──
const UP = new Map();
function sweepUploads(t = NOW()) { for (const [id, u] of UP) if (t - u.at > UPLOAD_TTL) UP.delete(id); }
function openUpload(roomId, userId, { kind, size }) {
  sweepUploads();
  if (!KINDS.includes(kind)) throw new LookRefuse(400, "Avatar or banner only.");
  const n = Math.floor(Number(size));
  if (!Number.isFinite(n) || n < 12) throw new LookRefuse(400, "That file is empty.");
  if (n > MAX_BYTES) throw new LookRefuse(413, `Pictures can be up to ${MAX_BYTES / 1024 / 1024} MB.`);
  if ([...UP.values()].filter((u) => u.userId === userId && !u.done).length >= OPEN_PER_USER) throw new LookRefuse(429, "Finish the upload you have going first.");
  const id = crypto.randomBytes(12).toString("hex");
  UP.set(id, { id, roomId, userId, kind, size: n, parts: [], received: 0, at: NOW() });
  return { id, chunk: CHUNK };
}
function chunkUpload(roomId, userId, id, offset, buf) {
  const u = UP.get(String(id || ""));
  if (!u || u.userId !== userId || u.roomId !== roomId) throw new LookRefuse(404, "No such upload.");
  if (!Buffer.isBuffer(buf) || !buf.length) throw new LookRefuse(400, "Empty chunk.");
  if (Math.floor(Number(offset)) !== u.received) throw Object.assign(new LookRefuse(409, "Out of order."), { received: u.received });
  if (u.received + buf.length > u.size) { UP.delete(u.id); throw new LookRefuse(413, "That file is bigger than it said."); }
  if (u.received === 0) {
    const sn = require("./feedmedia").sniff(buf);
    if (sn.bad || sn.kind !== "image") { UP.delete(u.id); throw new LookRefuse(415, "Pictures only: JPEG, PNG, GIF, WebP, AVIF or HEIC."); }
    if (u.kind === "avatar_anim" && !["gif", "webp"].includes(sn.fmt)) { UP.delete(u.id); throw new LookRefuse(415, "Animated avatars are an animated WebP or GIF."); }
  }
  u.parts.push(Buffer.from(buf));
  u.received += buf.length;
  u.at = NOW();
  return u.received;
}
async function finishUpload(roomId, userId, id, { actor, bannerY } = {}) {
  const u = UP.get(String(id || ""));
  if (!u || u.userId !== userId || u.roomId !== roomId) throw new LookRefuse(404, "No such upload.");
  if (u.done) return u.done;                                   // a retried finish: the same answer
  if (u.busy) throw new LookRefuse(409, "Still processing.");
  if (u.received !== u.size) throw Object.assign(new LookRefuse(409, "Not all of the file arrived."), { received: u.received });
  u.busy = true;
  try {
    const L = await setImage(roomId, u.kind, Buffer.concat(u.parts), { userId, actor, bannerY });
    u.parts = []; u.done = L;
    return L;
  } catch (e) { UP.delete(u.id); throw e; }
  finally { u.busy = false; }
}

// ── routes ──
function register(app, { addUser }) {
  init().catch(() => {});
  const express = require("express");
  const rooms = require("./rooms");
  const guard = require("./middleware/authGuard");
  const rawChunk = express.raw({ type: "application/octet-stream", limit: CHUNK_MAX });
  if (app.locals) { app.locals.padLook = look; app.locals.padAv = avatarHtml; }
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message, ...(e.received != null ? { received: e.received } : {}) });
    console.error("[padlook]", e);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  // owner-only, same-site, signed in (+ JSON bodies / X-Requested-With on chunks: a cross-site form can't send either)
  const owner = (json) => async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    if (json ? !req.is("application/json") : req.get("X-Requested-With") !== "fetch") return res.status(415).json({ ok: false, error: "Bad request." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    try {
      const R = await require("./roomsweb").resolveRoom(req.params.slug);
      if (!R) return res.status(404).json({ ok: false, error: "No such pad." });
      if (!(await rooms.canManage(req.user, R.id))) return res.status(403).json({ ok: false, error: "Only this pad's owner can change its look." });
      if (R.profile) return res.status(400).json({ ok: false, error: "Profiles have their own look (your profile page)." });
      req.pad = R;
      next();
    } catch (e) { fail(res, e); }
  };
  const who = (req) => req.user.username || "?";
  const B = "/api/rooms/:slug/look";
  app.post(B + "/uploads", addUser, owner(true), async (req, res) => {
    try {
      if ((req.body || {}).kind === "avatar_anim" && !(await animAllowed(req.pad.id))) throw new LookRefuse(403, "Animated avatars are a pad cosmetic - get one in ✨ Cosmetics first.");
      res.json({ ok: true, ...openUpload(req.pad.id, req.user.userId, req.body || {}) });
    } catch (e) { fail(res, e); }
  });
  app.put(B + "/uploads/:id", addUser, owner(false), rawChunk, (req, res) => {
    try { res.json({ ok: true, received: chunkUpload(req.pad.id, req.user.userId, req.params.id, req.query.offset, req.body) }); } catch (e) { fail(res, e); }
  });
  app.post(B + "/uploads/:id/finish", addUser, owner(true), async (req, res) => {
    try { res.json({ ok: true, look: await finishUpload(req.pad.id, req.user.userId, req.params.id, { actor: who(req), bannerY: (req.body || {}).banner_y }) }); } catch (e) { fail(res, e); }
  });
  app.post(B + "/remove", addUser, owner(true), async (req, res) => {
    try { res.json({ ok: true, look: await removeImage(req.pad.id, String((req.body || {}).kind || ""), who(req)) }); } catch (e) { fail(res, e); }
  });
  app.post(B, addUser, owner(true), async (req, res) => {
    try { res.json({ ok: true, ...(await setStyle(req.pad.id, req.body || {}, who(req))) }); } catch (e) { fail(res, e); }
  });
  // the files: only while a pad uses them; a new upload is a new name, so they're immutable
  app.get("/media/pad/:file", async (req, res) => {
    const name = String(req.params.file || "");
    const p = filePath(name);
    if (!p) return res.status(404).end();
    try {
      await init();
      const owner = [...CACHE.values()].find((r) => r.avatar === name || r.banner === name || (r.avatar_anim && (r.avatar_anim === name || stillOf(r.avatar_anim) === name)));
      if (!owner) { res.set("Cache-Control", "no-store"); return res.status(404).end(); }
      // 1.99fu: an Approved pad's avatar / banner is for the people inside it (padaccess.js), and never shared-cached
      const PA = require("./padaccess");
      await PA.init();
      const locked = PA.isApproved(owner.room_id);
      if (locked) {
        if (req.user === undefined && typeof addUser === "function") await new Promise((r) => addUser(req, res, r));
        if (!PA.canSee(req.user || null, owner.room_id)) { res.set("Cache-Control", "no-store"); return res.status(404).end(); }
      }
      const H = { "Content-Type": "image/webp", "X-Content-Type-Options": "nosniff", "Cache-Control": locked ? "private, max-age=600" : "public, max-age=31536000, immutable",
                  "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox", "Cross-Origin-Resource-Policy": "same-origin",
                  "Content-Disposition": `inline; filename="patv-pad-${name.slice(0, 8)}.webp"` };
      res.set(H);
      res.sendFile(p, { etag: true, lastModified: false, cacheControl: false, headers: H }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
    } catch (e) {
      console.error("[padlook] file:", e.message);
      if (!res.headersSent) res.status(500).end();
    }
  });
  setInterval(() => sweepUploads(), 5 * 60e3).unref();
}

module.exports = { init, register, look, cssVars, cosmeticsOf, parseCosmetics, setCosmetics, encodeAnim, stillOf, ANIM_MAX_OUT, ANIM_MAX_FRAMES, ANIM_ITEM, avatarHtml, monogram, normHex, contrast, luminance, inkFor, guardAccent, setImage, removeImage, setStyle,
                   openUpload, chunkUpload, finishUpload, encode, setSafetyCheck, filePath, url, dir, _setDir, loadCache, PALETTE, COSMETIC_SLOTS, KINDS,
                   MAX_BYTES, CHUNK, AVATAR_PX, BANNER_W, BANNER_MIN_H, BANNER_MAX_H, MIN_CONTRAST, BG, FILE_RE, LookRefuse,
                   _setClock: (fn) => { NOW = fn; }, _uploads: UP };
