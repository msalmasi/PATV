// stagecover.js — 1.99?? the STAGE COVER: the picture the 🎙 mic stage shows for a person it names but has no live picture of
// (cam off / not broadcasting, "cam starting…", a refused or failed cam card, a still not loaded yet). Owner 2026-11-02: "When cam
// is off, lets also show their GTF avatar as a default cover (but give every user the ability to configure their default cover as
// anything)." The card keeps its reason ("cam starting…") as a small label under the picture.
//
// THE CHOICE (Settings -> 🎙 Stage cover, /settings/stage-cover; table stage_covers, one row per account, no row = the default):
//   gtf      their Grand Theft Frogger pixel avatar (avatar.js, server-rendered from the seed Pepe syncs into cosmetic_avatar_seeds,
//            with the account's equipped GTF layers). As the DEFAULT only while their profile's "gtf" section is public (the GTF
//            boards' rule); picked here it shows anyway (their choice).
//   photo    their profile picture (userlook.avatarOf: the default Pepe face counts as none)
//   sticker  a sticker from a pack they own (stickers.js; a pack they no longer have falls back)
//   upload   a picture they uploaded - see UPLOADS
//   card     the plain card: the letter (the stage's look before this)
// Anything that can't be shown falls back to the DEFAULT: the GTF avatar (above's rule), then the profile picture (the stage's
// look before this for a linked person with a photo), then the letter. A Camfrog login with no linked account: the GTF avatar
// from Pepe's synced seed, else the letter.
//
// UPLOADS - only through the site's safety-scanned picture path (imagesafety.js, Pepe's vision; surface "stage_cover", policy
// group "profile" = safe for work, like profile photos and pad avatars). Hard rules: an upload is taken ONLY while that check
// ENFORCES for stage_cover (master switch on, shadow mode off, the surface on - imagesafety.enforcing); otherwise the choice is
// offered as "off" with a note and the routes refuse. And it fails CLOSED here: no classification in time (a fail-open pass), a
// shadow pass or any error = refused, nothing stored. The re-encode drops every byte the member sent (sharp -> webp, no metadata,
// first frame, at most COVER_PX). A check that FLAGS the picture stores it HELD: not shown (the stage falls back) until an admin
// marks the check on /admin/imagesafety - "false positive" puts it up, "correct" or "false negative" takes it down (onReview).
// Admins can also take any uploaded cover down from the "Stage covers" card there (removeUpload). A removed / held picture falls
// back to the default. Files: COVER_DIR (default /var/lib/patv[-staging]/cover), random 32-hex names (never a user id), served by
// GET /media/cover/u/<file> only while a member's row holds it: OK = public + immutable; HELD = to its owner only (private).
//
// PRIVACY (hard rules, spec wave 2 + this task): a cover is ONLY for a person the stage shows BY NAME. Veiled tiles (incognito, `!bridge
// hide`: wave 2's hooded covers, veilstage.js) never reach this module - micfollow.viewFor builds them before any lookup - and
// coverOf() refuses a login quotes.isHidden() hides now or that Pepe reports incognito (defence in depth), so no frog name is ever
// tied to a person's GTF avatar, photo or custom picture through a URL, a cache key, an alt text, a data attribute or an API field.
// The cache is keyed by the named login only. The GTF image URL is /media/cover/a/<seed~layers>.<hmac>.svg: the seed is no user id
// (the avatar itself shows as much), the HMAC (SECRET_KEY) makes the URL immutable-cacheable and stops the route from rendering
// arbitrary input. `!livecam off` people never reach the mic stage at all (micfollow) - unchanged.
//
// PERF: the program carries only a URL; the stage page sets an <img> src only when it changes, and every cover URL is immutable
// (a new picture = a new URL), so a program update never re-fetches a picture. Lookups are cached CACHE_MS per login.
//
//   coverOf(login) -> {url, k} | null        k = gtf | photo | sticker | upload    (micfollow.viewFor)
//   localImage(url) -> {buf, k} | null       the picture of a cover URL from local data, never the network (stagemiccap)
//   onReview(logId, mark, actor)             imagesafety.review's hook for stage_cover checks
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");

const KINDS = Object.freeze(["gtf", "photo", "sticker", "upload", "card"]);
const PIC_KINDS = Object.freeze(["gtf", "photo", "sticker", "upload"]);
const LOGIN_RE = /^[\w.\-]{1,40}$/;
const FILE_RE = /^[a-f0-9]{32}\.webp$/;
const LAYER_KEYS = Object.freeze(["bg", "outfit", "mask", "hat", "prop", "frame"]);
const GTF_RE = /^(\d{1,10}(?:~(?:bg|outfit|mask|hat|prop|frame)-[a-z0-9_]{1,40}){0,6})\.([a-f0-9]{20})\.svg$/;
const STICKER_RE = /^([a-z0-9]{1,32})\/([a-z0-9]{1,32})$/;
const GTF_PX = 176, COVER_PX = 512, MAX_INPUT_PIXELS = 60e6;
const MAX_BYTES = 5 * 1024 * 1024, CHUNK = 512 * 1024, CHUNK_MAX = 768 * 1024, UPLOAD_TTL = 15 * 60e3, OPEN_PER_USER = 2;
const CACHE_MS = 60e3, CACHE_MAX = 5000, SVG_MAX = 500;
const SURFACE = "stage_cover";
const SECRET = process.env.SECRET_KEY || crypto.randomBytes(32).toString("hex");
let NOW = () => Date.now();
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();

class Refuse extends Error { constructor(status, msg, code) { super(msg); this.refuse = true; this.status = status; this.code = code || null; } }

// ── storage (padlook's pattern) ──
function pickDir() {
  if (process.env.COVER_DIR) return path.resolve(process.env.COVER_DIR);
  if (process.platform === "linux") {
    const d = process.env.STAGING ? "/var/lib/patv-staging/cover" : "/var/lib/patv/cover";
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (e) { /* not root: below */ }
  }
  return path.resolve(__dirname, "..", path.basename(__dirname) + "-cover");
}
let DIR = null;
function dir() { if (!DIR) { DIR = pickDir(); fs.mkdirSync(DIR, { recursive: true }); } return DIR; }
function _setDir(d) { DIR = d; fs.mkdirSync(DIR, { recursive: true }); }
function filePath(name) { return FILE_RE.test(String(name || "")) ? path.join(dir(), name.slice(0, 2), name) : null; }
function removeFile(name) { const p = filePath(name); if (p) { try { fs.unlinkSync(p); } catch (e) { /* gone */ } } }
const uploadUrl = (name) => (FILE_RE.test(String(name || "")) ? "/media/cover/u/" + name : null);

// ── table ──
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS stage_covers (user_id TEXT PRIMARY KEY, kind TEXT, sticker TEXT, upload TEXT, upload_state TEXT,
        upload_log INTEGER, upload_at INTEGER, updated INTEGER)`);
      await runQuery("CREATE INDEX IF NOT EXISTS stage_covers_upload ON stage_covers (upload)");
      await runQuery("CREATE INDEX IF NOT EXISTS stage_covers_log ON stage_covers (upload_log)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
async function rowOf(userId) {
  await init();
  return (await getQuery("SELECT * FROM stage_covers WHERE user_id = ?", [String(userId)]))[0] || null;
}
async function upsert(userId, patch) {
  await init();
  const cur = (await rowOf(userId)) || {};
  const next = { kind: null, sticker: null, upload: null, upload_state: null, upload_log: null, upload_at: null, ...cur, ...patch };
  await runQuery(`INSERT INTO stage_covers (user_id, kind, sticker, upload, upload_state, upload_log, upload_at, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(user_id) DO UPDATE SET kind = excluded.kind, sticker = excluded.sticker, upload = excluded.upload, upload_state = excluded.upload_state,
                  upload_log = excluded.upload_log, upload_at = excluded.upload_at, updated = excluded.updated`,
    [String(userId), next.kind, next.sticker, next.upload, next.upload_state, next.upload_log, next.upload_at, NOW()]);
  invalidate(userId);
  return cur;
}

// ── the pieces of a cover ──
let _avatarFn = null;
function avatarFn() {
  if (!_avatarFn) {
    try { require("./public/js/avatar.js"); _avatarFn = typeof globalThis.pepeAvatarSVG === "function" ? globalThis.pepeAvatarSVG : null; }
    catch (e) { console.error("[stagecover] avatar.js:", e.message); }
  }
  return _avatarFn;
}
function layerIds(k) { try { require("./public/js/avatar.js"); const L = globalThis.pepeAvatarLayers; return L && Array.isArray(L[k]) ? L[k] : []; } catch (e) { return []; } }
const sign = (spec) => crypto.createHmac("sha256", SECRET).update("stagecover-gtf|" + spec).digest("hex").slice(0, 20);
/** The GTF avatar's cover URL: the seed + the equipped layers (only known layer ids), signed. */
function gtfUrl(seed, layers) {
  const s = Math.floor(Number(seed));
  if (!(s >= 1 && s < 2 ** 31)) return null;
  const parts = [String(s)];
  for (const k of LAYER_KEYS) { const id = layers && layers[k]; if (id && /^[a-z0-9_]{1,40}$/.test(String(id)) && layerIds(k).includes(id)) parts.push(k + "-" + id); }
  const spec = parts.join("~");
  return "/media/cover/a/" + spec + "." + sign(spec) + ".svg";
}
/** "<spec>.<sig>.svg" -> {seed, layers} | null (a bad signature or an unknown layer = null) */
function parseGtf(file) {
  const m = GTF_RE.exec(String(file || ""));
  if (!m) return null;
  const a = Buffer.from(sign(m[1])), b = Buffer.from(m[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [s, ...rest] = m[1].split("~");
  const layers = {};
  for (const r of rest) { const i = r.indexOf("-"), k = r.slice(0, i), id = r.slice(i + 1); if (!layerIds(k).includes(id)) return null; layers[k] = id; }
  const seed = Number(s);
  return seed >= 1 && seed < 2 ** 31 ? { seed, layers } : null;
}
const SVGS = new Map();
function gtfSvg(seed, layers) {
  const k = seed + "|" + JSON.stringify(layers);
  if (SVGS.has(k)) return SVGS.get(k);
  const fn = avatarFn();
  let svg = null;
  try { svg = fn ? fn(seed, GTF_PX, layers) : null; } catch (e) { console.error("[stagecover] render:", e.message); }
  if (svg) { SVGS.set(k, svg); if (SVGS.size > SVG_MAX) SVGS.delete(SVGS.keys().next().value); }
  return svg;
}
async function seedOf(login) {
  try { const r = (await getQuery("SELECT seed FROM cosmetic_avatar_seeds WHERE camfrog = ?", [low(login)]))[0]; return r && Number(r.seed) > 0 ? Number(r.seed) : null; }
  catch (e) { return null; }       // (no table yet: nobody has one)
}
async function layersOf(userId) {
  const out = {};
  try {
    const OPT = require("./cosmeticstyle").GTF_OPT;
    const eq = await require("./cosmetics").equippedFor(String(userId));
    for (const [kind, opt] of Object.entries(OPT)) if (eq[kind] && eq[kind].r && eq[kind].r.layer) out[opt] = eq[kind].r.layer;
  } catch (e) { /* the bare frog */ }
  return out;
}
/** Is the account's profile "gtf" section public? (the GTF boards' rule; unreadable = no, fails closed) */
async function gtfPublic(userId) {
  try { const PL = require("./profilelayout"); return PL.stateOf(await PL.get(String(userId)), "gtf") === "public"; } catch (e) { return false; }
}
const photoOf = (raw) => { try { return require("./userlook").avatarOf(raw); } catch (e) { return null; } };
/** "pack/id" -> the sticker's art URL while the account owns the pack (stickers.ownedPacks: bought, gifted, a live perk), else null */
async function stickerOf(userId, ref) {
  const m = STICKER_RE.exec(String(ref || ""));
  if (!m) return null;
  try {
    const S = require("./stickers");
    await S.init();
    const p = S.CAT.byId[m[1]], s = p && p.byId[m[2]];
    if (!s || !(await S.owns(String(userId), p.id))) return null;
    return s.url;
  } catch (e) { return null; }
}
/** The linked account of a Camfrog login (the bridge's rule: a real account before an automatic "CF..." one; never archived). */
async function accountOf(login) {
  const l = low(login);
  let rows;
  try { rows = await getQuery("SELECT userId, username, avatar FROM users WHERE LOWER(camfrogUsername) = ? AND archived_at IS NULL", [l]); }
  catch (e) { rows = await getQuery("SELECT userId, username, avatar FROM users WHERE LOWER(camfrogUsername) = ?", [l]).catch(() => []); }
  if (!rows.length) return null;
  const auto = (u) => { try { return require("./autoaccount").isAutoName(u, { anyCase: true }); } catch (e) { return /^CF/i.test(String(u || "")); } };
  return rows.slice().sort((a, b) => (auto(a.username) ? 1 : 0) - (auto(b.username) ? 1 : 0))[0];
}
/** Pepe reports this login incognito (the bridge-only privacy switch) - never a cover then. No table yet: nobody reported. */
async function incognitoOn(login) {
  try { const r = (await getQuery(`SELECT "on" AS o FROM incognito_state WHERE login = ?`, [low(login)]))[0]; return !!(r && Number(r.o) === 1); }
  catch (e) { return false; }
}
/** quotes.isHidden: THE "is this login hidden" rule (incognito or `!bridge hide`; true while it loads). Fails closed. */
function hiddenNow(login) { try { return require("./quotes").isHidden(low(login)) === true; } catch (e) { return true; } }

/** One account's cover (its choice, then the default chain). login = its linked Camfrog login (null: no GTF avatar). */
async function forAccount(acct, login, row) {
  const r = row === undefined ? await rowOf(acct.userId) : row;
  const kind = r && KINDS.includes(r.kind) ? r.kind : null;
  const photo = photoOf(acct.avatar);
  const gtf = async (explicit) => {
    if (!login || (!explicit && !(await gtfPublic(acct.userId)))) return null;
    const s = await seedOf(login);
    const url = s ? gtfUrl(s, await layersOf(acct.userId)) : null;
    return url ? { url, k: "gtf" } : null;
  };
  const dflt = async (explicit = false) => (await gtf(explicit)) || (photo ? { url: photo, k: "photo" } : null);
  if (kind === "card") return null;
  if (kind === "photo") return photo ? { url: photo, k: "photo" } : dflt();
  if (kind === "sticker") { const u = await stickerOf(acct.userId, r.sticker); return u ? { url: u, k: "sticker" } : dflt(); }
  if (kind === "upload") return r.upload_state === "ok" && uploadUrl(r.upload) ? { url: uploadUrl(r.upload), k: "upload" } : dflt();
  return dflt(kind === "gtf");
}
async function resolve(login) {
  if (await incognitoOn(login)) return { v: null, uid: null };
  const acct = await accountOf(login);
  if (!acct) {
    const s = await seedOf(login);
    const url = s ? gtfUrl(s, {}) : null;
    return { v: url ? { url, k: "gtf" } : null, uid: null };
  }
  return { v: await forAccount(acct, low(login)), uid: String(acct.userId) };
}

// ── the cache (by the NAMED login only - never a cover id, a frog name or a session) ──
const CACHE = new Map(), INFLIGHT = new Map();
/** -> {url, k} | null: the cover of a person the stage shows by name (see PRIVACY). */
async function coverOf(login) {
  const l = low(login);
  if (!LOGIN_RE.test(l) || hiddenNow(l)) return null;
  const c = CACHE.get(l);
  if (c && NOW() - c.at < CACHE_MS) return c.v;
  if (!INFLIGHT.has(l)) {
    INFLIGHT.set(l, (async () => {
      try {
        const r = await resolve(l);
        CACHE.delete(l); CACHE.set(l, { v: r.v, uid: r.uid, at: NOW() });
        while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
        return r.v;
      } catch (e) { console.error("[stagecover] resolve:", e.message); return null; }
      finally { INFLIGHT.delete(l); }
    })());
  }
  const v = await INFLIGHT.get(l);
  return hiddenNow(l) ? null : v;          // (hidden while it was looked up)
}
/** Drop an account's cached covers (its choice changed; a merge / delete). No argument = everything. */
function invalidate(userId) {
  if (userId == null) { CACHE.clear(); return; }
  for (const [k, c] of CACHE) if (c.uid === String(userId)) CACHE.delete(k);
}

/** The picture of a cover URL from LOCAL data (the GTF render, an uploaded file that is up, a sticker's art) - never the network.
 *  -> {buf, k} | null. A photo (an https URL) is null: a capture draws the letter for it. */
function localImage(url) {
  const u = String(url || "");
  let m = /^\/media\/cover\/a\/([^/?#]+)$/.exec(u);
  if (m) { const g = parseGtf(m[1]); const svg = g && gtfSvg(g.seed, g.layers); return svg ? { buf: Buffer.from(svg), k: "gtf" } : null; }
  m = /^\/media\/cover\/u\/([a-f0-9]{32}\.webp)$/.exec(u);
  if (m) {
    const p = filePath(m[1]);
    try { return p ? { buf: fs.readFileSync(p), k: "upload" } : null; } catch (e) { return null; }
  }
  m = /^\/public\/stickers\/([a-z0-9]{1,32})\/([a-z0-9]{1,32})\.svg$/.exec(u);
  if (m) { try { return { buf: fs.readFileSync(path.join(__dirname, "public", "stickers", m[1], m[2] + ".svg")), k: "sticker" }; } catch (e) { return null; } }
  return null;
}
/** stagemiccap: the upload's state is re-read (a picture taken down since the program was built is never drawn). */
async function localImageChecked(url) {
  const m = /^\/media\/cover\/u\/([a-f0-9]{32}\.webp)$/.exec(String(url || ""));
  if (m) {
    await init();
    const r = (await getQuery("SELECT upload_state FROM stage_covers WHERE upload = ?", [m[1]]))[0];
    if (!r || r.upload_state !== "ok") return null;
  }
  return localImage(url);
}

// ── uploads ──
/** Uploads are open only while the safety check ENFORCES for stage_cover (see UPLOADS). */
async function uploadsOn() { try { return await require("./imagesafety").enforcing(SURFACE); } catch (e) { return false; } }
async function encode(buf) {
  const media = require("./feedmedia");
  const sn = media.sniff(buf);
  if (sn.bad || sn.kind !== "image") throw new Refuse(415, "Pictures only: JPEG, PNG, GIF, WebP, AVIF or HEIC.", "type");
  let input = buf, cleanup = () => {};
  if (sn.fmt === "heic") {
    const tmp = path.join(dir(), "tmp-" + crypto.randomBytes(8).toString("hex") + ".heic");
    fs.writeFileSync(tmp, buf);
    try { const h = await media.heicToPng(tmp, { tmpDir: dir() }); input = h.png; cleanup = h.cleanup; } finally { try { fs.unlinkSync(tmp); } catch (e) { /* none */ } }
  }
  const sharp = require("sharp");
  try {
    let meta;
    try { meta = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata(); } catch (e) { throw new Refuse(415, "That picture couldn't be read.", "read"); }
    const fmtOk = { jpeg: "jpeg", png: "png", gif: "gif", webp: "webp", avif: "heif", heic: "png" }[sn.fmt];
    if (!meta || (fmtOk && meta.format !== fmtOk)) throw new Refuse(415, "That picture's contents don't match its type.", "type");
    // first frame only, orientation baked in, no metadata (sharp writes none unless asked), never enlarged
    const out = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().resize({ width: COVER_PX, height: COVER_PX, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
    return { buf: out.data, w: out.info.width, h: out.info.height };
  } catch (e) {
    if (e && e.refuse) throw e;
    throw new Refuse(415, "That picture couldn't be processed.", "read");
  } finally { cleanup(); }
}
/** Check (fail-closed) + store a re-encoded picture as the account's uploaded cover, and pick it. -> {state: "ok" | "held"} */
async function setUpload(userId, buf) {
  if (!(await uploadsOn())) throw new Refuse(409, "Picture uploads are off until the site's picture safety checks are on.", "off");
  if (!Buffer.isBuffer(buf) || buf.length < 12) throw new Refuse(400, "That file is empty.", "empty");
  if (buf.length > MAX_BYTES) throw new Refuse(413, `Pictures can be up to ${MAX_BYTES / 1024 / 1024} MB.`, "big");
  const enc = await encode(buf);
  let v;
  try { v = await require("./imagesafety").check({ surface: SURFACE, kind: "image", buf: enc.buf, userId: String(userId), ref: "cover:" + userId }); }
  catch (e) { v = null; }
  // fail closed: only a real ENFORCING classification that passed is taken (never a fail-open / shadow / switched-off pass)
  if (!v || v.ok !== true || v.nsfw || v.mode !== "enforce") {
    throw new Refuse(v && v.ok === false ? 422 : 503, v && v.ok === false ? (v.reason || "That picture can't be used.")
      : "The picture couldn't be safety-checked right now - try again in a minute.", v && v.ok === false ? "refused" : "unchecked");
  }
  const state = v.flagged ? "held" : "ok";
  const name = crypto.randomBytes(16).toString("hex") + ".webp";
  const p = filePath(name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, enc.buf, { flag: "wx" });
  let old;
  try { old = await upsert(userId, { kind: "upload", upload: name, upload_state: state, upload_log: Number(v.logId) || null, upload_at: NOW() }); }
  catch (e) { removeFile(name); throw e; }
  if (old && old.upload && old.upload !== name) removeFile(old.upload);
  console.log(`[stagecover] ${userId}: cover upload ${enc.w}x${enc.h} ${state}${v.logId ? " (check #" + v.logId + ")" : ""}`);
  return { state };
}
/** Take an account's uploaded cover down (its owner, an admin, a review). The choice falls back to the default when it was "upload". */
async function removeUpload(userId, why = "owner") {
  const r = await rowOf(userId);
  if (!r || !r.upload) return false;
  await upsert(userId, { upload: null, upload_state: why === "owner" ? null : "removed", upload_log: null, ...(r.kind === "upload" ? { kind: null } : {}) });
  removeFile(r.upload);
  console.log(`[stagecover] ${userId}: uploaded cover taken down (${why})`);
  return true;
}
/** imagesafety.review's hook (stage_cover checks): "fn" takes the picture down; on a HELD (flagged) one "ok" (the flag was right)
 *  takes it down and "fp" puts it up. */
async function onReview(logId, mark, actor) {
  await init();
  const r = (await getQuery("SELECT * FROM stage_covers WHERE upload_log = ? AND upload IS NOT NULL", [Number(logId) || 0]))[0];
  if (!r) return null;
  if (mark === "fn" || (mark === "ok" && r.upload_state === "held")) { await removeUpload(r.user_id, "review " + mark + " by " + String(actor || "?").slice(0, 60)); return "removed"; }
  if (mark === "fp" && r.upload_state === "held") { await upsert(r.user_id, { upload_state: "ok" }); return "released"; }
  return null;
}

// ── chunked uploads (padlook's protocol; in memory: one process, a few MB each, a short TTL) ──
const UP = new Map();
function sweepUploads(t = NOW()) { for (const [id, u] of UP) if (t - u.at > UPLOAD_TTL) UP.delete(id); }
function openUpload(userId, size) {
  sweepUploads();
  const n = Math.floor(Number(size));
  if (!Number.isFinite(n) || n < 12) throw new Refuse(400, "That file is empty.", "empty");
  if (n > MAX_BYTES) throw new Refuse(413, `Pictures can be up to ${MAX_BYTES / 1024 / 1024} MB.`, "big");
  if ([...UP.values()].filter((u) => u.userId === userId && !u.done).length >= OPEN_PER_USER) throw new Refuse(429, "Finish the upload you have going first.", "busy");
  const id = crypto.randomBytes(12).toString("hex");
  UP.set(id, { id, userId, size: n, parts: [], received: 0, at: NOW() });
  return { id, chunk: CHUNK };
}
function chunkUpload(userId, id, offset, buf) {
  const u = UP.get(String(id || ""));
  if (!u || u.userId !== userId) throw new Refuse(404, "No such upload.", "gone");
  if (!Buffer.isBuffer(buf) || !buf.length) throw new Refuse(400, "Empty chunk.", "empty");
  if (Math.floor(Number(offset)) !== u.received) throw Object.assign(new Refuse(409, "Out of order.", "order"), { received: u.received });
  if (u.received + buf.length > u.size) { UP.delete(u.id); throw new Refuse(413, "That file is bigger than it said.", "big"); }
  if (u.received === 0) {
    const sn = require("./feedmedia").sniff(buf);
    if (sn.bad || sn.kind !== "image") { UP.delete(u.id); throw new Refuse(415, "Pictures only: JPEG, PNG, GIF, WebP, AVIF or HEIC.", "type"); }
  }
  u.parts.push(Buffer.from(buf));
  u.received += buf.length;
  u.at = NOW();
  return u.received;
}
async function finishUpload(userId, id) {
  const u = UP.get(String(id || ""));
  if (!u || u.userId !== userId) throw new Refuse(404, "No such upload.", "gone");
  if (u.done) return u.done;
  if (u.busy) throw new Refuse(409, "Still processing.", "busy");
  if (u.received !== u.size) throw Object.assign(new Refuse(409, "Not all of the file arrived.", "short"), { received: u.received });
  u.busy = true;
  try { const r = await setUpload(userId, Buffer.concat(u.parts)); u.parts = []; u.done = r; return r; }
  catch (e) { UP.delete(u.id); throw e; }
  finally { u.busy = false; }
}

// ── the member's settings ──
/** What Settings -> 🎙 Stage cover shows (t = req.t for sticker names, optional). */
async function stateFor(userId, t) {
  await init();
  const u = (await getQuery("SELECT userId, username, avatar, camfrogUsername FROM users WHERE userId = ?", [String(userId)]))[0];
  if (!u) throw new Refuse(404, "No such account.", "gone");
  const login = u.camfrogUsername && LOGIN_RE.test(low(u.camfrogUsername)) ? low(u.camfrogUsername) : null;
  const r = await rowOf(userId);
  const seed = login ? await seedOf(login) : null;
  const S = require("./stickers");
  let stickers = [];
  try {
    await S.init();
    const mine = await S.ownedPacks(String(userId));
    const L = (k, d) => (t && typeof t.has === "function" && t.has(k) ? String(t(k)).replace(/&(amp|lt|gt|quot|#39);/g, (m0, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[e])) : d);
    for (const p of S.CAT.packs) if (mine.has(p.id)) for (const s of p.stickers) stickers.push({ ref: p.id + "/" + s.id, url: s.url, name: L(`stk.s.${p.id}.${s.id}`, s.name), pack: L(`stk.pack.${p.id}.name`, p.name) });
  } catch (e) { stickers = []; }
  const now = await forAccount(u, login, r);
  return {
    kind: r && KINDS.includes(r.kind) ? r.kind : "gtf", chosen: !!(r && r.kind), linked: !!login,
    gtf: seed ? { url: gtfUrl(seed, await layersOf(userId)) } : null, gtf_private: !(await gtfPublic(userId)),
    photo: photoOf(u.avatar), stickers, sticker: r && STICKER_RE.test(String(r.sticker || "")) ? r.sticker : null,
    upload: r && r.upload && (r.upload_state === "ok" || r.upload_state === "held") ? { url: uploadUrl(r.upload), state: r.upload_state } : null,
    removed: !!(r && r.upload_state === "removed"),
    uploads: await uploadsOn(), max_mb: MAX_BYTES / 1024 / 1024, chunk: CHUNK,
    now: now ? { url: now.url, k: now.k } : null,
  };
}
/** The saved choice (the hub's state): one of KINDS, "gtf" when none was made. */
async function choiceOf(userId) { const r = await rowOf(userId); return r && KINDS.includes(r.kind) ? r.kind : "gtf"; }
/** Save the choice. b = {kind, sticker?} */
async function save(userId, b = {}) {
  const kind = String(b.kind || "");
  if (!KINDS.includes(kind)) throw new Refuse(400, "Pick one of the choices.", "bad");
  const r = await rowOf(userId);
  const patch = { kind };
  if (kind === "sticker") {
    const ref = String(b.sticker || "");
    if (!(await stickerOf(userId, ref))) throw new Refuse(400, "Pick a sticker from a pack you own.", "sticker");
    patch.sticker = ref;
  }
  if (kind === "photo") {
    const u = (await getQuery("SELECT avatar FROM users WHERE userId = ?", [String(userId)]))[0];
    if (!u || !photoOf(u.avatar)) throw new Refuse(400, "You don't have a profile picture yet.", "photo");
  }
  if (kind === "upload" && !(r && r.upload && (r.upload_state === "ok" || r.upload_state === "held"))) throw new Refuse(400, "Upload a picture first.", "upload");
  await upsert(userId, patch);
  return true;
}

// ── admins ──
/** The uploaded covers (newest first) for /admin/imagesafety's "Stage covers" card. */
async function adminList(limit = 60) {
  await init();
  const rows = await getQuery(`SELECT c.user_id, c.kind, c.upload, c.upload_state, c.upload_log, c.upload_at, u.username FROM stage_covers c
    LEFT JOIN users u ON u.userId = c.user_id WHERE c.upload IS NOT NULL ORDER BY c.upload_at DESC LIMIT ?`, [Math.min(200, Math.max(1, Number(limit) || 60))]);
  return rows.map((x) => ({ userId: x.user_id, username: x.username || null, state: x.upload_state, inUse: x.kind === "upload", logId: x.upload_log,
                            at: x.upload_at, url: uploadUrl(x.upload) }));
}

/** Uploaded files no row holds any more (a replace that crashed, a deleted / merged account) - gone after an hour. */
async function sweepFiles(t = NOW()) {
  await init();
  const used = new Set((await getQuery("SELECT upload FROM stage_covers WHERE upload IS NOT NULL")).map((r) => r.upload));
  let n = 0;
  let subs = [];
  try { subs = fs.readdirSync(dir(), { withFileTypes: true }).filter((d) => d.isDirectory() && /^[a-f0-9]{2}$/.test(d.name)); } catch (e) { return 0; }
  for (const d of subs) {
    for (const f of fs.readdirSync(path.join(dir(), d.name))) {
      if (!FILE_RE.test(f) || used.has(f)) continue;
      const p = path.join(dir(), d.name, f);
      try { if (t - fs.statSync(p).mtimeMs > 3600e3) { fs.unlinkSync(p); n++; } } catch (e) { /* gone */ }
    }
  }
  return n;
}

// ── routes ──
function register(app, { addUser, noTimers = false }) {
  init().catch((e) => console.error("[stagecover] init:", e.message));
  const express = require("express");
  const guard = require("./middleware/authGuard");
  const SP = require("./siteperms");
  const rawChunk = express.raw({ type: "application/octet-stream", limit: CHUNK_MAX });
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message, code: e.code || null, ...(e.received != null ? { received: e.received } : {}) });
    console.error("[stagecover]", e);
    res.status(500).json({ ok: false, error: "Something went wrong." });
  };
  // signed in, same-site, JSON bodies (chunks: X-Requested-With) - a cross-site form can't send either
  const me = (json) => (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page." });
    if (json ? !req.is("application/json") : req.get("X-Requested-With") !== "fetch") return res.status(415).json({ ok: false, error: "Bad request." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    next();
  };
  const uid = (req) => String(req.user.userId);
  app.get("/settings/stage-cover", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent("/settings/stage-cover"));
    try {
      res.set({ "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" });
      res.render("stageCover", { user: req.user.username, st: await stateFor(uid(req), req.t) });
    } catch (e) {
      console.error("[stagecover] page:", e.message);
      res.status(500).send("Couldn't load your stage cover.");
    }
  });
  app.get("/api/stage-cover", addUser, (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in first." });
    next();
  }, async (req, res) => { try { res.json({ ok: true, ...(await stateFor(uid(req), req.t)) }); } catch (e) { fail(res, e); } });
  app.post("/api/stage-cover", addUser, me(true), async (req, res) => {
    try { await save(uid(req), req.body || {}); res.json({ ok: true, ...(await stateFor(uid(req), req.t)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stage-cover/uploads", addUser, me(true), async (req, res) => {
    try {
      if (!(await uploadsOn())) throw new Refuse(409, "Picture uploads are off until the site's picture safety checks are on.", "off");
      res.json({ ok: true, ...openUpload(uid(req), (req.body || {}).size) });
    } catch (e) { fail(res, e); }
  });
  app.put("/api/stage-cover/uploads/:id", addUser, me(false), rawChunk, (req, res) => {
    try { res.json({ ok: true, received: chunkUpload(uid(req), req.params.id, req.query.offset, req.body) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stage-cover/uploads/:id/finish", addUser, me(true), async (req, res) => {
    try { const r = await finishUpload(uid(req), req.params.id); res.json({ ok: true, held: r.state === "held", ...(await stateFor(uid(req), req.t)) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/stage-cover/upload/remove", addUser, me(true), async (req, res) => {
    try { await removeUpload(uid(req), "owner"); res.json({ ok: true, ...(await stateFor(uid(req), req.t)) }); } catch (e) { fail(res, e); }
  });
  // admins (/admin/imagesafety's "Stage covers" card): take a member's uploaded cover down
  app.post("/api/admin/stage-cover/remove", addUser, me(true), async (req, res) => {
    try {
      const a = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [uid(req)]))[0];
      if (!a || !SP.can(a, "imagesafety.admin")) return res.status(403).json({ ok: false, error: "Admins only." });
      const who = String((req.body || {}).user_id || "");
      if (!who || !(await removeUpload(who, "admin " + a.username))) throw new Refuse(404, "That cover is already gone.", "gone");
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  const pictureHeaders = (type, pub) => ({ "Content-Type": type, "X-Content-Type-Options": "nosniff",
    "Cache-Control": pub ? "public, max-age=31536000, immutable" : "private, no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox", "Cross-Origin-Resource-Policy": "same-origin" });
  // the GTF avatar: the signed spec IS the picture, so it's immutable
  app.get("/media/cover/a/:file", (req, res) => {
    const g = parseGtf(req.params.file);
    const svg = g && gtfSvg(g.seed, g.layers);
    if (!svg) { res.set("Cache-Control", "no-store"); return res.status(404).end(); }
    res.set(pictureHeaders("image/svg+xml", true));
    res.send(svg);
  });
  // an uploaded cover: public while it is up; a held one only to its owner; anything else 404
  app.get("/media/cover/u/:file", async (req, res) => {
    const name = String(req.params.file || "");
    const p = filePath(name);
    if (!p) return res.status(404).end();
    try {
      await init();
      const r = (await getQuery("SELECT user_id, upload_state FROM stage_covers WHERE upload = ?", [name]))[0];
      const pub = !!r && r.upload_state === "ok";
      let ok = pub;
      if (r && r.upload_state === "held") {                      // held: its owner only (Settings shows them what they sent)
        if (req.user === undefined && typeof addUser === "function") await new Promise((next) => addUser(req, res, next));
        ok = !!(req.user && String(req.user.userId) === String(r.user_id));
      }
      if (!ok) { res.set("Cache-Control", "no-store"); return res.status(404).end(); }
      const H = pictureHeaders("image/webp", pub);
      res.set(H);
      res.sendFile(p, { etag: true, lastModified: false, cacheControl: false, headers: H }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
    } catch (e) {
      console.error("[stagecover] file:", e.message);
      if (!res.headersSent) res.status(500).end();
    }
  });
  if (!noTimers) {
    setInterval(() => sweepUploads(), 5 * 60e3).unref();
    setTimeout(() => sweepFiles().catch(() => {}), 60e3).unref();
    setInterval(() => sweepFiles().catch(() => {}), 6 * 3600e3).unref();
  }
}

module.exports = {
  init, register, coverOf, invalidate, localImage, localImageChecked, onReview, removeUpload, setUpload, save, stateFor, choiceOf, adminList, sweepFiles,
  gtfUrl, parseGtf, forAccount, uploadsOn, openUpload, chunkUpload, finishUpload, filePath, dir, _setDir, Refuse,
  KINDS, PIC_KINDS, SURFACE, MAX_BYTES, CHUNK, COVER_PX, CACHE_MS, FILE_RE,
  _setClock: (fn) => { NOW = fn || (() => Date.now()); },
};
