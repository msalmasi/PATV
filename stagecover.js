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
// GET /media/cover/u/<file> only while a member's row holds it: OK = public; HELD = to its owner and the safety admins only.
// Review fixes (1.99??):
//   * a TAKE-DOWN that isn't the owner's own (an admin's, a review's) sticks: the picture's hash is blocked for every account
//     (stage_cover_blocks - no user id) and the account's uploads are HELD for an admin's check for HOLD_MS (hold_until, strikes).
//   * an OK upload is cached SHORT (public, max-age=600 + a 300 s CDN TTL, ETag) - never immutable: a take-down must reach the
//     browsers and Cloudflare's edge within minutes (nothing on the site can purge the edge). A row whose file is missing = no upload.
//   * uploads are capped per account (UPLOADS_PER_HOUR / UPLOADS_PER_DAY image-safety checks, one held picture at a time) and refused
//     for a restricted account (archived, casino_banned = the relay's "restricted", a global feed ban, Pepe's global feed_restricted).
//   * the GTF URL's signature covers avatar.js's render version: a redrawn layer = new URLs (the route is immutable-cached).
//
// PRIVACY (hard rules, spec wave 2 + this task): a cover is ONLY for a person the stage shows BY NAME. Veiled tiles (incognito, `!bridge
// hide`: wave 2's hooded covers, veilstage.js) never reach this module - micfollow.viewFor builds them before any lookup - and
// coverOf() refuses a login quotes.isHidden() hides now or that Pepe reports incognito (defence in depth), so no frog name is ever
// tied to a person's GTF avatar, photo or custom picture through a URL, a cache key, an alt text, a data attribute or an API field.
// The cache is keyed by the named login only. The GTF image URL is /media/cover/a/<seed~layers>.<hmac>.svg: the seed is no user id
// (the avatar itself shows as much), the HMAC (SECRET_KEY) makes the URL immutable-cacheable and stops the route from rendering
// arbitrary input. `!livecam off` people never reach the mic stage at all (micfollow) - unchanged.
//
// PERF: the program carries only a URL; the stage page sets an <img> src only when it changes, so a program update never re-fetches
// a picture. A GTF render is immutable (a new picture or render version = a new URL); an uploaded one is cached UPLOAD_MAX_AGE and
// then revalidated by its ETag (a 304) - see the review fixes above. Lookups are cached CACHE_MS per login.
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
// 1.99?? review fixes: per-account upload caps (counted in image_safety_log: every check is a classification + a row + a thumbnail),
// the forced hold after a take-down, and the uploaded file's cache lifetimes (browser / CDN edge)
const UPLOADS_PER_HOUR = 5, UPLOADS_PER_DAY = 20, HOLD_MS = 30 * 86400e3;
const UPLOAD_MAX_AGE = 600, UPLOAD_CDN_MAX_AGE = 300;
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
        upload_log INTEGER, upload_at INTEGER, updated INTEGER, upload_hash TEXT, hold_until INTEGER, strikes INTEGER)`);
      // (a table made before the review fixes: their columns)
      for (const c of ["upload_hash TEXT", "hold_until INTEGER", "strikes INTEGER"]) {
        try { await runQuery("ALTER TABLE stage_covers ADD COLUMN " + c); } catch (e) { /* already there */ }
      }
      await runQuery("CREATE INDEX IF NOT EXISTS stage_covers_upload ON stage_covers (upload)");
      await runQuery("CREATE INDEX IF NOT EXISTS stage_covers_log ON stage_covers (upload_log)");
      // 1.99?? review fix: pictures taken down by an admin or a review - by the re-encoded file's sha256, never reusable as a cover
      // (no user id: a safety record of the picture, not of the member)
      await runQuery("CREATE TABLE IF NOT EXISTS stage_cover_blocks (hash TEXT PRIMARY KEY, at INTEGER, why TEXT)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
async function rowOf(userId) {
  await init();
  return (await getQuery("SELECT * FROM stage_covers WHERE user_id = ?", [String(userId)]))[0] || null;
}
const COLS = Object.freeze(["kind", "sticker", "upload", "upload_state", "upload_log", "upload_at", "upload_hash", "hold_until", "strikes"]);
async function upsert(userId, patch) {
  await init();
  const cur = (await rowOf(userId)) || {};
  const next = {};
  for (const c of COLS) next[c] = c in patch ? patch[c] : c in cur ? cur[c] : null;
  await runQuery(`INSERT INTO stage_covers (user_id, ${COLS.join(", ")}, updated) VALUES (?, ${COLS.map(() => "?").join(", ")}, ?)
                  ON CONFLICT(user_id) DO UPDATE SET ${COLS.map((c) => c + " = excluded." + c).join(", ")}, updated = excluded.updated`,
    [String(userId), ...COLS.map((c) => next[c]), NOW()]);
  invalidate(userId);
  return cur;
}
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

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
// 1.99?? review fix (COMPAT-1): the render version - avatar.js's source + the render size. The signature covers it, so a redrawn
// layer (avatar.js changed) gives every GTF cover a NEW URL; the old ones 404 (the stage then shows the letter until the next program
// carries the new URL). The route's pictures stay immutable-cacheable.
let RENDER_V = null;
function renderV() {
  if (RENDER_V == null) {
    try { RENDER_V = sha256(Buffer.concat([fs.readFileSync(path.join(__dirname, "public", "js", "avatar.js")), Buffer.from("|" + GTF_PX)])).slice(0, 12); }
    catch (e) { RENDER_V = "0"; }
  }
  return RENDER_V;
}
const sign = (spec) => crypto.createHmac("sha256", SECRET).update("stagecover-gtf|" + renderV() + "|" + spec).digest("hex").slice(0, 20);
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
/** The linked account of a Camfrog login (the bridge's rule: a real account before an automatic "CF..." one; never archived).
 *  1.99?? review fix (PRIV-3): a failed read THROWS (coverOf then shows the letter, uncached) - only "no rows" means Camfrog-only;
 *  a read error must never turn a linked member into a Camfrog-only login (whose seed would override their choice). */
async function accountOf(login) {
  const l = low(login);
  let rows;
  try { rows = await getQuery("SELECT userId, username, avatar FROM users WHERE LOWER(camfrogUsername) = ? AND archived_at IS NULL", [l]); }
  catch (e) {
    if (!/no such column/i.test(String(e && e.message))) throw e;
    rows = await getQuery("SELECT userId, username, avatar FROM users WHERE LOWER(camfrogUsername) = ?", [l]);   // (a schema without archived_at)
  }
  if (!rows.length) return null;
  const auto = (u) => { try { return require("./autoaccount").isAutoName(u, { anyCase: true }); } catch (e) { return /^CF/i.test(String(u || "")); } };
  return rows.slice().sort((a, b) => (auto(a.username) ? 1 : 0) - (auto(b.username) ? 1 : 0))[0];
}
const noTable = (e) => /no such table/i.test(String(e && e.message));
/** Pepe reports this login incognito (the bridge-only privacy switch) - never a cover then. No table yet: nobody reported; any other
 *  read error throws (fails closed: the letter). */
async function incognitoOn(login) {
  try { const r = (await getQuery(`SELECT "on" AS o FROM incognito_state WHERE login = ?`, [low(login)]))[0]; return !!(r && Number(r.o) === 1); }
  catch (e) { if (noTable(e)) return false; throw e; }
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
  if (kind === "upload") return uploadUp(r) ? { url: uploadUrl(r.upload), k: "upload" } : dflt();
  return dflt(kind === "gtf");
}
/** An uploaded picture that is up: its row says "ok" AND its file is there (1.99?? review fix SC-SAFE-7: after a restore without the
 *  cover folder the row outlives its file - that's no upload, so the default shows instead of a 404 and the letter). */
function uploadUp(r) {
  if (!r || r.upload_state !== "ok" || !uploadUrl(r.upload)) return false;
  try { return fs.statSync(filePath(r.upload)).isFile(); } catch (e) { return false; }
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
/** 1.99?? review fixes (SC-SAFE-3/4): may this account upload a cover now? -> a Refuse, or null. Checked when an upload opens and
 *  again before its safety check. Fails closed (a read error = refused).
 *   * the account: archived, restricted (casino_banned = the relay's "restricted", as feedstore.postRefusal), a global feed ban, or
 *     Pepe's global feed_restricted for its Camfrog login (the feed's media rules that apply to a public picture anywhere)
 *   * one picture waiting for an admin's check at a time
 *   * at most UPLOADS_PER_HOUR / UPLOADS_PER_DAY stage-cover safety checks (each is a classification, a log row and a thumbnail) */
async function uploadRefusal(userId, t = NOW()) {
  try {
    await init();
    const u = (await getQuery("SELECT userId, archived_at, casino_banned, camfrogUsername FROM users WHERE userId = ?", [String(userId)]))[0];
    if (!u) return new Refuse(404, "No such account.", "gone");
    if (u.archived_at) return new Refuse(403, "This account is archived.", "restricted");
    if (Number(u.casino_banned)) return new Refuse(403, "Your account is restricted.", "restricted");
    const opt = (sql, args) => getQuery(sql, args).catch((e) => { if (noTable(e)) return []; throw e; });
    if ((await opt("SELECT 1 AS x FROM feed_bans WHERE user_id = ? AND room_id = '' AND (until IS NULL OR until > ?) LIMIT 1", [String(u.userId), t])).length) {
      return new Refuse(403, "You can't post pictures on the site right now.", "restricted");
    }
    if (u.camfrogUsername && (await opt("SELECT 1 AS x FROM feed_restricted WHERE login = ? AND room_id = '' AND (until IS NULL OR until > ?) LIMIT 1",
      [low(u.camfrogUsername), t])).length) return new Refuse(403, "Pepe says you can't post pictures right now.", "restricted");
    const r = await rowOf(userId);
    if (r && r.upload && r.upload_state === "held") {
      return new Refuse(409, "Your last picture is still waiting for a check by the admins - remove it to upload another.", "held");
    }
    const c = (await opt(`SELECT COUNT(*) AS d, SUM(CASE WHEN at > ? THEN 1 ELSE 0 END) AS h FROM image_safety_log WHERE surface = ? AND user_id = ? AND at > ?`,
      [t - 3600e3, SURFACE, String(userId), t - 86400e3]))[0] || {};
    if ((Number(c.h) || 0) >= UPLOADS_PER_HOUR) return new Refuse(429, `That's ${UPLOADS_PER_HOUR} pictures this hour - try again later.`, "rate");
    if ((Number(c.d) || 0) >= UPLOADS_PER_DAY) return new Refuse(429, `That's ${UPLOADS_PER_DAY} pictures today - try again tomorrow.`, "rate");
    return null;
  } catch (e) {
    console.error("[stagecover] upload check:", e.message);
    return new Refuse(503, "Couldn't check that right now - try again in a minute.", "unchecked");
  }
}
/** A picture an admin or a review took down (stage_cover_blocks) - never reusable as a cover. Unreadable = blocked (fails closed). */
async function hashBlocked(hash) {
  try { await init(); return (await getQuery("SELECT 1 AS x FROM stage_cover_blocks WHERE hash = ?", [String(hash)])).length > 0; }
  catch (e) { return true; }
}
/** Check (fail-closed) + store a re-encoded picture as the account's uploaded cover, and pick it. -> {state: "ok" | "held"} */
async function setUpload(userId, buf) {
  if (!(await uploadsOn())) throw new Refuse(409, "Picture uploads are off until the site's picture safety checks are on.", "off");
  if (!Buffer.isBuffer(buf) || buf.length < 12) throw new Refuse(400, "That file is empty.", "empty");
  if (buf.length > MAX_BYTES) throw new Refuse(413, `Pictures can be up to ${MAX_BYTES / 1024 / 1024} MB.`, "big");
  const no = await uploadRefusal(userId);
  if (no) throw no;
  const enc = await encode(buf);
  // 1.99?? review fix (SC-SAFE-1): a picture that was taken down is refused before it is classified again (the re-encode is
  // deterministic: the same picture = the same file = the same hash)
  const hash = sha256(enc.buf);
  if (await hashBlocked(hash)) throw new Refuse(422, "That picture was taken down - it can't be used as a stage cover.", "blocked");
  let v;
  try { v = await require("./imagesafety").check({ surface: SURFACE, kind: "image", buf: enc.buf, userId: String(userId), ref: "cover:" + userId }); }
  catch (e) { v = null; }
  // fail closed: only a real ENFORCING classification that passed is taken (never a fail-open / shadow / switched-off pass)
  if (!v || v.ok !== true || v.nsfw || v.mode !== "enforce") {
    throw new Refuse(v && v.ok === false ? 422 : 503, v && v.ok === false ? (v.reason || "That picture can't be used.")
      : "The picture couldn't be safety-checked right now - try again in a minute.", v && v.ok === false ? "refused" : "unchecked");
  }
  // HELD = not shown until an admin's check: a flagged picture, or any picture while the account is on hold after a take-down
  const cur = await rowOf(userId);
  const onHold = !!(cur && Number(cur.hold_until) > NOW());
  const state = v.flagged || onHold ? "held" : "ok";
  const name = crypto.randomBytes(16).toString("hex") + ".webp";
  const p = filePath(name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, enc.buf, { flag: "wx" });
  let old;
  try { old = await upsert(userId, { kind: "upload", upload: name, upload_state: state, upload_log: Number(v.logId) || null, upload_at: NOW(), upload_hash: hash }); }
  catch (e) { removeFile(name); throw e; }
  if (old && old.upload && old.upload !== name) removeFile(old.upload);
  console.log(`[stagecover] ${userId}: cover upload ${enc.w}x${enc.h} ${state}${onHold && !v.flagged ? " (account on hold)" : ""}${v.logId ? " (check #" + v.logId + ")" : ""}`);
  return { state };
}
/** Take an account's uploaded cover down (its owner, an admin, a review). The choice falls back to the default when it was "upload".
 *  1.99?? review fix (SC-SAFE-1): a take-down that isn't the owner's own STICKS - the picture's hash is blocked (every account) and
 *  the account's next uploads are held for an admin's check for HOLD_MS (a strike). */
async function removeUpload(userId, why = "owner") {
  const r = await rowOf(userId);
  if (!r || !r.upload) return false;
  const takedown = why !== "owner";
  const patch = { upload: null, upload_state: takedown ? "removed" : null, upload_log: null, upload_hash: null, ...(r.kind === "upload" ? { kind: null } : {}) };
  if (takedown) Object.assign(patch, { hold_until: NOW() + HOLD_MS, strikes: (Number(r.strikes) || 0) + 1 });
  if (takedown) {
    let hash = r.upload_hash;
    if (!hash) { try { hash = sha256(fs.readFileSync(filePath(r.upload))); } catch (e) { hash = null; } }
    const code = /^admin\b/.test(why) ? "admin" : /^review (fn|ok)\b/.test(why) ? why.slice(0, 9) : "other";      // (a code, never a name)
    if (hash) await runQuery("INSERT OR IGNORE INTO stage_cover_blocks (hash, at, why) VALUES (?, ?, ?)", [hash, NOW(), code]);
  }
  await upsert(userId, patch);
  removeFile(r.upload);
  console.log(`[stagecover] ${userId}: uploaded cover taken down (${why})${takedown ? " - picture blocked, uploads held until checked" : ""}`);
  return true;
}
/** An admin puts a HELD picture up (the "Stage covers" card's Put up; a "false positive" review). -> true when it was held. */
async function releaseUpload(userId) {
  const r = await rowOf(userId);
  if (!r || !r.upload || r.upload_state !== "held") return false;
  await upsert(userId, { upload_state: "ok" });
  return true;
}
/** imagesafety.review's hook (stage_cover checks): "fn" takes the picture down; "ok" (the check was right) on a check that FLAGGED it
 *  takes it down whatever its state now (1.99?? review fix SC-SAFE-5: a mistaken "fp" corrected to "ok" brings it down again - a
 *  picture held only because its account is on hold passed its check, so "ok" leaves it to the card's Put up / Take down);
 *  "fp" on a held one puts it up. */
async function onReview(logId, mark, actor) {
  await init();
  const r = (await getQuery("SELECT * FROM stage_covers WHERE upload_log = ? AND upload IS NOT NULL", [Number(logId) || 0]))[0];
  if (!r) return null;
  let flagged = false;
  try { const l = (await getQuery("SELECT flagged FROM image_safety_log WHERE id = ?", [Number(logId) || 0]))[0]; flagged = !!(l && Number(l.flagged) === 1); }
  catch (e) { flagged = true; }        // (unreadable: treat "ok" as the flag being right - fails closed)
  if (mark === "fn" || (mark === "ok" && flagged)) {
    await removeUpload(r.user_id, "review " + mark + " by " + String(actor || "?").slice(0, 60));
    return "removed";
  }
  if (mark === "fp" && r.upload_state === "held") { await releaseUpload(r.user_id); return "released"; }
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
  // 1.99?? review fix (UX-4): what the stage would show for each choice (the page previews a pick before Save); a sticker previews
  // the sticker picked on the page
  const pv = async (kind) => { const c = await forAccount(u, login, { ...(r || {}), kind }); return c ? { url: c.url, k: c.k } : null; };
  const preview = { auto: await pv(null), gtf: await pv("gtf"), photo: await pv("photo"), upload: await pv("upload"), card: null };
  return {
    // 1.99?? review fix (UX-3): no saved choice = "auto" (the default chain) - never shown as a GTF pick the member didn't make
    kind: r && KINDS.includes(r.kind) ? r.kind : "auto", chosen: !!(r && KINDS.includes(r.kind)), linked: !!login,
    gtf: seed ? { url: gtfUrl(seed, await layersOf(userId)) } : null, gtf_private: !(await gtfPublic(userId)),
    photo: photoOf(u.avatar), stickers, sticker: r && STICKER_RE.test(String(r.sticker || "")) ? r.sticker : null,
    upload: r && r.upload && (r.upload_state === "ok" || r.upload_state === "held") ? { url: uploadUrl(r.upload), state: r.upload_state } : null,
    removed: !!(r && r.upload_state === "removed"),
    hold: !!(r && Number(r.hold_until) > NOW()),
    uploads: await uploadsOn(), max_mb: MAX_BYTES / 1024 / 1024, chunk: CHUNK,
    now: now ? { url: now.url, k: now.k } : null, preview,
  };
}
/** The saved choice (the hub's state): one of KINDS, "auto" when none was made (the default chain). */
async function choiceOf(userId) { const r = await rowOf(userId); return r && KINDS.includes(r.kind) ? r.kind : "auto"; }
/** Save the choice. b = {kind, sticker?}; kind "auto" = no choice (the default chain: GTF avatar while the profile's GTF section is
 *  public, then the profile photo, then the letter) - the way back to the default. */
async function save(userId, b = {}) {
  const kind = String(b.kind || "");
  if (kind === "auto") { if (await rowOf(userId)) await upsert(userId, { kind: null }); return true; }
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
  const rows = await getQuery(`SELECT c.user_id, c.kind, c.upload, c.upload_state, c.upload_log, c.upload_at, c.hold_until, c.strikes, u.username FROM stage_covers c
    LEFT JOIN users u ON u.userId = c.user_id WHERE c.upload IS NOT NULL ORDER BY c.upload_at DESC LIMIT ?`, [Math.min(200, Math.max(1, Number(limit) || 60))]);
  return rows.map((x) => ({ userId: x.user_id, username: x.username || null, state: x.upload_state, inUse: x.kind === "upload", logId: x.upload_log,
                            at: x.upload_at, url: uploadUrl(x.upload), onHold: Number(x.hold_until) > NOW(), strikes: Number(x.strikes) || 0 }));
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
      const no = await uploadRefusal(uid(req));                 // 1.99?? review fixes: restricted accounts, caps, one held at a time
      if (no) throw no;
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
  // admins (/admin/imagesafety's "Stage covers" card): take a member's uploaded cover down / put a held one up
  const safetyAdmin = async (req) => {
    const a = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [uid(req)]))[0];
    return a && SP.can(a, "imagesafety.admin") ? a : null;
  };
  app.post("/api/admin/stage-cover/remove", addUser, me(true), async (req, res) => {
    try {
      const a = await safetyAdmin(req);
      if (!a) return res.status(403).json({ ok: false, error: "Admins only." });
      const who = String((req.body || {}).user_id || "");
      if (!who || !(await removeUpload(who, "admin " + a.username))) throw new Refuse(404, "That cover is already gone.", "gone");
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/stage-cover/release", addUser, me(true), async (req, res) => {
    try {
      const a = await safetyAdmin(req);
      if (!a) return res.status(403).json({ ok: false, error: "Admins only." });
      const who = String((req.body || {}).user_id || "");
      if (!who || !(await releaseUpload(who))) throw new Refuse(404, "That cover isn't waiting for a check.", "gone");
      console.log(`[stagecover] ${who}: held cover put up by admin ${a.username}`);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // 1.99?? review fixes (SC-SAFE-2, PRIV-4, COMPAT-2): only a GTF render is immutable (its URL is its picture + render version). An
  // uploaded cover can be taken down, so it is cached SHORT - the browser revalidates (ETag) after UPLOAD_MAX_AGE, and the CDN edge
  // (Cloudflare: CDN-Cache-Control / Cloudflare-CDN-Cache-Control win over Cache-Control there) keeps it UPLOAD_CDN_MAX_AGE at most,
  // so a removed picture stops being served within minutes. The stage sets a src only when the URL changes, so this costs no refetch
  // per program update.
  const pictureHeaders = (type, cache) => ({ "Content-Type": type, "X-Content-Type-Options": "nosniff",
    "Cache-Control": cache === "immutable" ? "public, max-age=31536000, immutable" : cache === "public" ? `public, max-age=${UPLOAD_MAX_AGE}` : "private, no-store",
    ...(cache === "public" ? { "CDN-Cache-Control": `max-age=${UPLOAD_CDN_MAX_AGE}`, "Cloudflare-CDN-Cache-Control": `max-age=${UPLOAD_CDN_MAX_AGE}` } : {}),
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox", "Cross-Origin-Resource-Policy": "same-origin" });
  // the GTF avatar: the signed spec (+ the render version) IS the picture, so it's immutable
  app.get("/media/cover/a/:file", (req, res) => {
    const g = parseGtf(req.params.file);
    const svg = g && gtfSvg(g.seed, g.layers);
    if (!svg) { res.set("Cache-Control", "no-store"); return res.status(404).end(); }
    res.set(pictureHeaders("image/svg+xml", "immutable"));
    res.send(svg);
  });
  // an uploaded cover: public while it is up; a held one only to its owner and the safety admins (the "Stage covers" card); else 404
  app.get("/media/cover/u/:file", async (req, res) => {
    const name = String(req.params.file || "");
    const p = filePath(name);
    if (!p) return res.status(404).end();
    try {
      await init();
      const r = (await getQuery("SELECT user_id, upload_state FROM stage_covers WHERE upload = ?", [name]))[0];
      const pub = !!r && r.upload_state === "ok";
      let ok = pub;
      if (r && r.upload_state === "held") {
        if (req.user === undefined && typeof addUser === "function") await new Promise((next) => addUser(req, res, next));
        ok = !!(req.user && req.user.userId && (String(req.user.userId) === String(r.user_id) || (await safetyAdmin(req))));
      }
      if (!ok) { res.set("Cache-Control", "no-store"); return res.status(404).end(); }
      const H = pictureHeaders("image/webp", pub ? "public" : "private");
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
  init, register, coverOf, invalidate, localImage, localImageChecked, onReview, removeUpload, releaseUpload, setUpload, uploadRefusal, save, stateFor, choiceOf,
  adminList, sweepFiles, gtfUrl, parseGtf, forAccount, uploadsOn, openUpload, chunkUpload, finishUpload, filePath, dir, _setDir, Refuse,
  KINDS, PIC_KINDS, SURFACE, MAX_BYTES, CHUNK, COVER_PX, CACHE_MS, FILE_RE, UPLOADS_PER_HOUR, UPLOADS_PER_DAY, HOLD_MS, UPLOAD_MAX_AGE, UPLOAD_CDN_MAX_AGE,
  _setClock: (fn) => { NOW = fn || (() => Date.now()); },
  _setRenderVersion: (v) => { RENDER_V = v == null ? null : String(v); SVGS.clear(); },
};
