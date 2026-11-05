// stagecover.js — 1.99ahq the STAGE COVER: the picture the 🎙 mic stage shows for a person it names but has no live picture of
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
// Review fixes (1.99ahq):
//   * a TAKE-DOWN that isn't the owner's own (an admin's, a review's) sticks: the picture's hash is blocked for every account
//     (stage_cover_blocks - no user id) and the account's uploads are HELD for an admin's check for HOLD_MS (hold_until, strikes).
//     Review fix 2 (SC-SAFE-1b): also when the reviewed picture is no longer the member's current upload (replaced, removed) - every
//     stored check's picture is recorded (stage_cover_checks), and any copy of a blocked picture that is up comes down too.
//   * an OK upload is cached SHORT (public, max-age=600 + a 300 s CDN TTL, ETag) - never immutable: a take-down must reach the
//     browsers and Cloudflare's edge within minutes (nothing on the site can purge the edge). A row whose file is missing = no upload.
//   * uploads are capped per account (UPLOADS_PER_HOUR / UPLOADS_PER_DAY image-safety checks, one held picture at a time) and refused
//     for a restricted account (archived, casino_banned = the relay's "restricted", a global feed ban, Pepe's global feed_restricted).
//   * the GTF URL's signature covers avatar.js's render version: a redrawn layer = new URLs (the route is immutable-cached).
// Fix 3 (1.99ahq, owner 2026-11-02: "snaps and clips should replicate whatever the snap/clipper [sees], not just be a letter"; "uploaded
// covers can join the 12-month site backup"):
//   * PROFILE PHOTOS IN CAPTURES: stagemiccap draws every cover the viewer's stage shows, a profile photo too (round, as the page
//     crops it). The photo is fetched SERVER-SIDE (photoImage) - only from PHOTO SOURCES below, never an arbitrary URL - re-encoded
//     by sharp and cached in memory by its keyed URL hash (PHOTO_TTL; a failure PHOTO_FAIL_TTL). Anything that fails = the letter,
//     never a failed or stalled capture. While micfollow's cfg cover_photo_proxy is on (default ON) the live stage gets an allowed
//     photo through the same proxy (/media/cover/p/<key>.webp - no Discord id / user id in the URL; the page and the capture draw the
//     very same bytes); off = the photo's own URL on the page, as before (captures still fetch it here).
//   * PHOTO SOURCES - the hosts the site itself writes into users.avatar (anything else draws as the letter in a capture):
//       the site's own storage: Settings -> profile photo (user.controller updateAvatar -> the S3 bucket S3_BUCKET_NAME, keys
//         avatars/...): the bucket's custom-domain host (the uploader's "customDomainURL" for a bucket named after a domain),
//         <bucket>.s3[.<region> | -<region>].amazonaws.com, the path style s3[.<region>].amazonaws.com/<bucket>/avatars/, plus any host
//         in COVER_PHOTO_HOSTS (comma-separated: a CDN in front of the bucket) - path /avatars/ only
//       Discord (Sign in with Discord - index.js; the Discord bot's accounts): cdn.discordapp.com /avatars/, /embed/avatars/
//       Twitch (Sign in with Twitch - index.js; the Twitch bot's accounts): static-cdn.jtvnw.net /jtv_user_pictures/,
//         /user-default-pictures-uv/
//       a site path under /public/ (read from the site's own public folder)
//     (Google, Apple, Telegram and Plex sign-ins, the sign-up form and Pepe's automatic Camfrog accounts write the default Pepe face
//     = no photo.) The fetch: https on 443 only, no credentials in the URL, the host resolved and refused when ANY of its addresses
//     is private / loopback / link-local / CGNAT / multicast / reserved / an IPv6 one outside global unicast (no SSRF), then
//     connected to that vetted address (no DNS
//     rebinding); no redirects (any 3xx = refused); an image type or the bucket's octet-stream only (never SVG / HTML), sniffed and
//     decoded by sharp; at most PHOTO_MAX_BYTES; PHOTO_TIMEOUT_MS for all of it (DNS included). Never logs the URL.
//   * FILES - HELD PICTURES IN THEIR OWN FOLDER: COVER_DIR/<xx>/<name> = pictures that are UP (state ok) - the off-site backup (pve1,
//     12-month GFS) copies this folder; COVER_DIR/held/<xx>/<name> = pictures HELD for an admin's check (and the HEIC decoder's temp
//     files; review fix 3: every new upload until its row commits "ok") - EXCLUDED from that backup, like imagesafety/: a flagged
//     picture is never backed up. A held picture moves into the
//     normal folder when it's put up (the card's Put up, a "false positive" review: the row first, then the file - a crash between
//     leaves an "ok" picture in held/, never a held one in the backed-up folder) and is deleted from held/ when it's taken down.
//     Serving, uploadUp and the capture look in the row's folder first, then the other (a move cut short); removeFile clears both;
//     placeFiles() - at boot (the one-time migration: held files already in the normal folder, staging has some) and in every
//     sweepFiles - moves each file to its row's folder; sweepFiles removes files no row holds from both folders (what account
//     deletion and merges leave; an export carries records only, never the file).
//   * THE BLOCK RACE: hashBlocked is checked again right before the store - and inside the transaction that stores the row - so an
//     upload being classified while an admin / a review blocks the same picture is refused, never stored after the block.
// Review fixes 3 (1.99ahq):
//   * THE HOLD RACE (SEC-3): held-or-up is decided inside that same transaction (hold_until read there), so a take-down's strike + hold
//     that lands while the next picture is classified or waits for its transaction holds it. Every upload is written to held/ first
//     and moved into the normal folder only after its row commits "ok" (never a held picture in the backed-up folder).
//   * a take-down of a row from before review fix 1 (no upload_hash) hashes its file wherever it is (held/ too), and placeFiles gives
//     such rows their hash (SEC-4).
//   * an IPv6 photo address must be global unicast (2000::/3), minus the special ranges (SEC-1: IPv4-compatible ::/96, SIIT, 3fff::/20,
//     5f00::/16 were let through).
//
// PRIVACY (hard rules, spec wave 2 + this task): a cover is ONLY for a person the stage shows BY NAME. Veiled tiles (incognito, `!bridge
// hide`: wave 2's hooded covers, veilstage.js) never reach this module - micfollow.viewFor builds them before any lookup - and
// coverOf() refuses a login quotes.isHidden() hides now or that Pepe reports incognito (defence in depth), so no frog name is ever
// tied to a person's GTF avatar, photo or custom picture through a URL, a cache key, an alt text, a data attribute or an API field.
// The cache is keyed by the named login only. The GTF image URL is /media/cover/a/<seed~layers>.<hmac>.svg: the seed is no user id
// (the avatar itself shows as much), the HMAC (SECRET_KEY) makes the URL immutable-cacheable and stops the route from rendering
// arbitrary input. 1.99aid (privacy controls S3, micfollow_cfg withheld_cover - dark): a cam opt-out (`!livecam off`, "Pads may put my
// cam on their stage" off, cam access followers / on request) withholds the CAM, not the person - such a mic holder, shown by name,
// gets this cover on a "cam off" card (micfollow card state "withheld": never a relay, still, warm keep or capture of the cam), once
// every other stage rule has passed. Incognito + live cam off stays the peek hood and !bridge hide the shadow hood - never a cover
// (the PRIVACY rules above). Switch off: they never reach the mic stage at all, as before.
//
// PERF: the program carries only a URL; the stage page sets an <img> src only when it changes, so a program update never re-fetches
// a picture. A GTF render is immutable (a new picture or render version = a new URL); an uploaded one is cached UPLOAD_MAX_AGE and
// then revalidated by its ETag (a 304) - see the review fixes above. Lookups are cached CACHE_MS per login.
//
//   coverOf(login) -> {url, k} | null        k = gtf | photo | sticker | upload    (micfollow.viewFor)
//   photoProxyUrl(url) -> url | null         an allowed photo's /media/cover/p/ URL (micfollow.viewFor, cfg cover_photo_proxy)
//   captureImage(url) -> {buf, k} | null     the picture of a cover URL for a capture: local data, or an allowed photo (stagemiccap)
//   localImage(url) -> {buf, k} | null       the picture of a cover URL from local data, never the network
//   onReview(logId, mark, actor)             imagesafety.review's hook for stage_cover checks
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const net = require("net");
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
// 1.99ahq review fixes: per-account upload caps (counted in image_safety_log: every check is a classification + a row + a thumbnail),
// the forced hold after a take-down, and the uploaded file's cache lifetimes (browser / CDN edge)
const UPLOADS_PER_HOUR = 5, UPLOADS_PER_DAY = 20, HOLD_MS = 30 * 86400e3;
const UPLOAD_MAX_AGE = 600, UPLOAD_CDN_MAX_AGE = 300;
const CACHE_MS = 60e3, CACHE_MAX = 5000, SVG_MAX = 500;
// 1.99ahq fix 3: profile photos fetched for captures / the live proxy (see PHOTO SOURCES) - the caps, the cache lifetimes and sizes
const PHOTO_MAX_BYTES = 2 * 1024 * 1024, PHOTO_TIMEOUT_MS = 3000, PHOTO_TTL = 3600e3, PHOTO_FAIL_TTL = 5 * 60e3;
const PHOTO_CACHE_MAX = 300, PHOTO_CACHE_BYTES = 32 * 1024 * 1024, PHOTO_KEYS_MAX = 5000, PHOTO_KEY_TTL = 24 * 3600e3, PHOTO_MAX_PIXELS = 16e6;
const HELD = "held";                                        // 1.99ahq fix 3: COVER_DIR/held/ - never in the off-site backup
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
/** 1.99ahq fix 3: where a picture lives - COVER_DIR/<xx>/<name> (up), COVER_DIR/held/<xx>/<name> (held: never backed up). */
function heldDir() { return path.join(dir(), HELD); }
function filePath(name, held = false) { return FILE_RE.test(String(name || "")) ? path.join(held ? heldDir() : dir(), name.slice(0, 2), name) : null; }
const isFile = (p) => { try { return !!p && fs.statSync(p).isFile(); } catch (e) { return false; } };
/** 1.99ahq fix 3: the file of a row's picture - its state's folder first, then the other (a move a crash cut short); null = none. */
function fileAt(name, state) {
  const held = state === "held";
  for (const p of [filePath(name, held), filePath(name, !held)]) if (isFile(p)) return p;
  return null;
}
/** 1.99ahq fix 3: move a picture into its state's folder (held/ or the normal one). -> true when it is there now. */
function placeFile(name, held) {
  const to = filePath(name, held), from = filePath(name, !held);
  if (!to) return false;
  if (isFile(to)) { if (isFile(from)) { try { fs.unlinkSync(from); } catch (e) { /* gone */ } } return true; }
  if (!isFile(from)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  return true;
}
function removeFile(name) { for (const held of [false, true]) { const p = filePath(name, held); if (p) { try { fs.unlinkSync(p); } catch (e) { /* gone */ } } } }
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
      // 1.99ahq review fix: pictures taken down by an admin or a review - by the re-encoded file's sha256, never reusable as a cover
      // (no user id: a safety record of the picture, not of the member)
      await runQuery("CREATE TABLE IF NOT EXISTS stage_cover_blocks (hash TEXT PRIMARY KEY, at INTEGER, why TEXT)");
      // 1.99ahq review fix 2 (SC-SAFE-1b): the picture each stage-cover check passed (the log id -> the stored file's sha256), so a
      // review of a check whose picture the member has since REPLACED or REMOVED still blocks it. No user id (the log row has it);
      // kept only while its log row is (sweepChecks); taken = when a take-down acted on that check (one strike per check)
      await runQuery("CREATE TABLE IF NOT EXISTS stage_cover_checks (log_id INTEGER PRIMARY KEY, hash TEXT NOT NULL, at INTEGER, taken INTEGER)");
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
// 1.99ahq review fix (COMPAT-1): the render version - avatar.js's source + the render size. The signature covers it, so a redrawn
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
 *  1.99ahq review fix (PRIV-3): a failed read THROWS (coverOf then shows the letter, uncached) - only "no rows" means Camfrog-only;
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
/** An uploaded picture that is up: its row says "ok" AND its file is there (1.99ahq review fix SC-SAFE-7: after a restore without the
 *  cover folder the row outlives its file - that's no upload, so the default shows instead of a 404 and the letter). */
function uploadUp(r) {
  if (!r || r.upload_state !== "ok" || !uploadUrl(r.upload)) return false;
  return !!fileAt(r.upload, "ok");                     // (1.99ahq fix 3: the normal folder, else held/ - a put-up cut short)
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
        if (r.v && r.v.k === "photo") warmPhoto(r.v.url);        // 1.99ahq fix 3: a capture / the proxy then finds it cached
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
    const p = filePath(m[1]);                          // (the normal folder only: a held picture is never read here)
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
    const p = fileAt(m[1], "ok");                      // 1.99ahq fix 3: (an "ok" picture whose move out of held/ was cut short too)
    try { return p ? { buf: fs.readFileSync(p), k: "upload" } : null; } catch (e) { return null; }
  }
  return localImage(url);
}
/** 1.99ahq fix 3: the picture a capture draws for a cover URL from the viewer's program - what their stage shows: the local pictures
 *  (localImageChecked), a proxied photo (/media/cover/p/<key>.webp), a photo's own URL on an allowed host (PHOTO SOURCES) or a site
 *  photo under /public/. -> {buf, k} | null (the letter). Never throws; a photo waits at most PHOTO_TIMEOUT_MS (cold cache). */
async function captureImage(url) {
  try {
    const u = String(url || "");
    let m = /^\/media\/cover\/p\/([a-f0-9]{32})\.webp$/.exec(u);
    if (m) { const src = proxiedUrl(m[1]); return src ? await photoImage(src) : null; }
    if (/^https:\/\//.test(u)) return await photoImage(u);
    m = /^\/public\/((?:[A-Za-z0-9_\-]+\/)*[A-Za-z0-9_\-.]+\.(?:png|jpe?g|webp|gif|avif))$/.exec(u);
    if (m && !u.includes("..") && !/^\/public\/stickers\//.test(u)) {
      if (!require("./userlook").avatarOf(u)) return null;            // (the default Pepe face is no photo)
      const root = path.join(__dirname, "public"), p = path.join(root, m[1]);
      const real = fs.realpathSync(p);
      if (!real.startsWith(fs.realpathSync(root) + path.sep) || !isFile(real) || fs.statSync(real).size > PHOTO_MAX_BYTES) return null;
      return { buf: fs.readFileSync(real), k: "photo" };
    }
    return await localImageChecked(u);
  } catch (e) { return null; }
}

// ── profile photos (1.99ahq fix 3 - see PHOTO SOURCES): the allow-list, the guarded fetch, the cache, the live proxy's keys ──
const HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** The hosts (+ path prefixes) the site writes into users.avatar. The bucket's from the environment the uploader uses. */
function photoSources() {
  const out = [
    { host: "cdn.discordapp.com", paths: ["/avatars/", "/embed/avatars/"] },                         // Discord sign-in / bot
    { host: "static-cdn.jtvnw.net", paths: ["/jtv_user_pictures/", "/user-default-pictures-uv/"] },  // Twitch sign-in / bot
  ];
  const b = low(process.env.S3_BUCKET_NAME), region = low(process.env.AWS_REGION);
  const reg = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/.test(region) ? region : null;
  if (/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(b) && !b.includes("..") && !net.isIP(b)) {
    if (b.includes(".") && HOST_RE.test(b)) out.push({ host: b, paths: ["/avatars/"] });          // the uploader's "customDomainURL"
    for (const h of [b + ".s3.amazonaws.com", reg && b + ".s3." + reg + ".amazonaws.com", reg && b + ".s3-" + reg + ".amazonaws.com"]) if (h) out.push({ host: h, paths: ["/avatars/"] });
    for (const h of ["s3.amazonaws.com", reg && "s3." + reg + ".amazonaws.com"]) if (h) out.push({ host: h, paths: ["/" + b + "/avatars/"] });
  }
  for (const x of String(process.env.COVER_PHOTO_HOSTS || "").split(",")) { const h = low(x); if (HOST_RE.test(h)) out.push({ host: h, paths: ["/avatars/"] }); }
  return out;
}
/** A photo URL -> {href, host, path} when it is on an allowed host (https, 443, no credentials, an allowed path), else null. */
function photoSource(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!/^https:\/\/[^\s"'<>()\\]+$/.test(s) || s.length > 600) return null;
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443") || u.hash) return null;
  const host = u.hostname.toLowerCase();
  if (!HOST_RE.test(host) || /%2e|%2f|%5c/i.test(u.pathname)) return null;
  const ok = photoSources().some((x) => x.host === host && x.paths.some((p) => u.pathname.startsWith(p) && u.pathname.length > p.length));
  return ok ? { href: u.href, host, path: u.pathname + u.search } : null;
}
// Never fetched from (SSRF): private, loopback, link-local, CGNAT, multicast, documentation / benchmarking / reserved ranges, and the
// IPv6 forms that carry an IPv4 address (mapped, IPv4-compatible, SIIT, NAT64, 6to4, Teredo)
// (one list per family: a BlockList's ::ffff:0:0/96 rule also matches every plain IPv4 address)
// 1.99ahq review fix 3 (SEC-1): an IPv6 address must be GLOBAL UNICAST (2000::/3) - everything outside it is refused whole (::/96
// IPv4-compatible, ::ffff:0:0:0/96 SIIT, 5f00::/16 SRv6 SIDs and whatever IANA assigns there next); inside it the special ranges below
// (+ 3fff::/20 documentation) are refused too. The ::/96 and SIIT entries stay listed for the record.
const NOT_PUBLIC = (() => {
  const v4 = new net.BlockList(), v6 = new net.BlockList(), unicast6 = new net.BlockList();
  for (const [a, n] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
    ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]]) v4.addSubnet(a, n, "ipv4");
  for (const [a, n] of [["::", 96], ["::ffff:0:0", 96], ["::ffff:0:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32], ["2001:2::", 48],
    ["2001:10::", 28], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20], ["5f00::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]]) v6.addSubnet(a, n, "ipv6");
  unicast6.addSubnet("2000::", 3, "ipv6");
  return { 4: v4, 6: v6, unicast6 };
})();
/** Is this resolved address one a photo may be fetched from? (the family is the address's own, whatever the resolver said) */
function publicAddr(address) {
  const a = String(address == null ? "" : address), v = net.isIP(a);
  if (!v) return false;
  try {
    if (v === 6 && !NOT_PUBLIC.unicast6.check(a, "ipv6")) return false;          // 1.99ahq review fix 3 (SEC-1): global unicast only
    return !NOT_PUBLIC[v].check(a, v === 6 ? "ipv6" : "ipv4");
  } catch (e) { return false; }
}
// the network (tests swap it: no test ever reaches the internet)
const PNET_REAL = Object.freeze({
  lookup: (host) => require("dns").promises.lookup(host, { all: true, verbatim: true }),
  request: (opts, cb) => require("https").request(opts, cb),
});
let PNET = PNET_REAL;
const OK_TYPE = /^(?:image\/(?:png|jpeg|jpg|pjpeg|gif|webp|avif)|application\/octet-stream|binary\/octet-stream)$/;   // (the bucket's uploads carry no type)
/** GET an allowed photo: the vetted address, no redirects, the type / size caps, one deadline for all of it. -> Buffer (throws). */
function fetchPhoto(src) {
  return new Promise((resolve, reject) => {
    let req = null, done = false;
    const finish = (e, v) => { if (done) return; done = true; clearTimeout(timer); if (req) { try { req.destroy(); } catch (x) { /* closed */ } } if (e) reject(e); else resolve(v); };
    const timer = setTimeout(() => finish(new Error("timeout")), PHOTO_TIMEOUT_MS);
    (async () => {
      const addrs = await PNET.lookup(src.host);
      const list = (Array.isArray(addrs) ? addrs : [addrs]).filter(Boolean);
      // ANY address of the host that isn't public = refused (a name that also points inside the network is never asked)
      if (!list.length || list.some((a) => !a || !publicAddr(a.address))) throw new Error("address");
      if (done) return;
      const a = list[0], fam = net.isIPv6(String(a.address)) ? 6 : 4;
      req = PNET.request({ protocol: "https:", hostname: src.host, servername: src.host, port: 443, path: src.path, method: "GET", agent: false,
        // connect to the address vetted above (never a second, rebinding lookup)
        lookup: (h, o, cb) => (o && o.all ? cb(null, [{ address: a.address, family: fam }]) : cb(null, a.address, fam)),
        headers: { Host: src.host, Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif", "Accept-Encoding": "identity", "User-Agent": "publicaccess.tv-stage-cover" } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return finish(new Error("status " + res.statusCode)); }      // (a 3xx: no redirects)
        const type = String(res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
        if (!OK_TYPE.test(type)) { res.resume(); return finish(new Error("type")); }
        if (Number(res.headers["content-length"]) > PHOTO_MAX_BYTES) return finish(new Error("big"));
        const parts = [];
        let n = 0;
        res.on("data", (c) => { n += c.length; if (n > PHOTO_MAX_BYTES) finish(new Error("big")); else parts.push(c); });
        res.on("end", () => finish(null, Buffer.concat(parts, n)));
        res.on("error", (e) => finish(e));
        res.on("aborted", () => finish(new Error("aborted")));
      });
      req.on("error", (e) => finish(e));
      req.end();
    })().catch((e) => finish(e));
  });
}
/** Decode + re-encode (sharp): a picture only (sniffed, never SVG / HEIC), first frame, orientation baked, at most COVER_PX, webp. */
async function reencodePhoto(buf) {
  const sn = require("./feedmedia").sniff(buf);
  if (sn.bad || sn.kind !== "image" || !["jpeg", "png", "gif", "webp", "avif"].includes(sn.fmt)) throw new Error("not a picture");
  const sharp = require("sharp");
  // (PHOTO_MAX_PIXELS: a 2 MB file can still be a pixel bomb)
  const out = await sharp(buf, { limitInputPixels: PHOTO_MAX_PIXELS }).rotate()
    .resize({ width: COVER_PX, height: COVER_PX, fit: "inside", withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
  if (!out.length) throw new Error("empty");
  return out;
}
// the cache: key -> {at, buf | null (failed), ttl} - in memory only (never in the cover folder, so never in a backup)
const PHOTOS = new Map(), PHOTO_INFLIGHT = new Map();
let photoBytes = 0;
/** The URL's keyed hash: the cache key and the live proxy's file name (names no user / Discord id; unguessable without SECRET). */
const photoKey = (href) => crypto.createHmac("sha256", SECRET).update("stagecover-photo|" + href).digest("hex").slice(0, 32);
function photoPut(key, buf, ttl) {
  const old = PHOTOS.get(key);
  if (old) { photoBytes -= old.buf ? old.buf.length : 0; PHOTOS.delete(key); }
  PHOTOS.set(key, { at: NOW(), buf, ttl });
  photoBytes += buf ? buf.length : 0;
  while (PHOTOS.size > PHOTO_CACHE_MAX || photoBytes > PHOTO_CACHE_BYTES) {
    const [k, v] = PHOTOS.entries().next().value;
    PHOTOS.delete(k); photoBytes -= v.buf ? v.buf.length : 0;
  }
}
/** An allowed photo's picture {buf (webp), k: "photo"} - cached, else fetched (deduplicated); null when it's not allowed or failed. */
async function photoImage(url) {
  const src = photoSource(url);
  if (!src) return null;
  const key = photoKey(src.href);
  const c = PHOTOS.get(key);
  if (c && NOW() - c.at < c.ttl) return c.buf ? { buf: c.buf, k: "photo" } : null;
  if (!PHOTO_INFLIGHT.has(key)) {
    PHOTO_INFLIGHT.set(key, (async () => {
      try { const buf = await reencodePhoto(await fetchPhoto(src)); photoPut(key, buf, PHOTO_TTL); return buf; }
      catch (e) { photoPut(key, null, PHOTO_FAIL_TTL); console.log(`[stagecover] a profile photo couldn't be fetched (${String((e && (e.code || e.message)) || "?").slice(0, 40)}) - the letter`); return null; }
      finally { PHOTO_INFLIGHT.delete(key); }
    })());
  }
  const buf = await PHOTO_INFLIGHT.get(key);
  return buf ? { buf, k: "photo" } : null;
}
/** Fetch an allowed photo in the background (a program carries it: the capture / the proxy then finds it cached). */
function warmPhoto(url) { if (photoSource(url)) photoImage(url).catch(() => {}); }
// the live proxy: key -> the photo's URL, only for photos a program handed out (PHOTO_KEY_TTL since the last time)
const PHOTO_KEYS = new Map();
/** An allowed photo's proxied URL for the live stage (micfollow.viewFor while cfg cover_photo_proxy is on), else null (not allowed). */
function photoProxyUrl(url) {
  const src = photoSource(url);
  if (!src) return null;
  const key = photoKey(src.href);
  PHOTO_KEYS.delete(key); PHOTO_KEYS.set(key, { url: src.href, at: NOW() });
  while (PHOTO_KEYS.size > PHOTO_KEYS_MAX) PHOTO_KEYS.delete(PHOTO_KEYS.keys().next().value);
  return "/media/cover/p/" + key + ".webp";
}
function proxiedUrl(key) {
  const e = PHOTO_KEYS.get(String(key || ""));
  if (!e) return null;
  if (NOW() - e.at > PHOTO_KEY_TTL) { PHOTO_KEYS.delete(String(key)); return null; }
  return e.url;
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
    // 1.99ahq fix 3: the member's raw bytes (not checked yet) only in held/ - never in the backed-up folder, even for a moment
    fs.mkdirSync(heldDir(), { recursive: true });
    const tmp = path.join(heldDir(), "tmp-" + crypto.randomBytes(8).toString("hex") + ".heic");
    fs.writeFileSync(tmp, buf);
    try { const h = await media.heicToPng(tmp, { tmpDir: heldDir() }); input = h.png; cleanup = h.cleanup; } finally { try { fs.unlinkSync(tmp); } catch (e) { /* none */ } }
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
/** 1.99ahq review fixes (SC-SAFE-3/4): may this account upload a cover now? -> a Refuse, or null. Checked when an upload opens and
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
  // 1.99ahq review fix (SC-SAFE-1): a picture that was taken down is refused before it is classified again (the re-encode is
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
  // 1.99ahq review fix 2 (SC-SAFE-1b): remember which picture this check passed - a later review of it must reach the picture even
  // after the member replaced or removed it. Fails closed: a check that can't be recorded (or has no log row) = nothing stored.
  try {
    if (!(Number(v.logId) > 0)) throw new Error("no check id");
    await runQuery("INSERT OR REPLACE INTO stage_cover_checks (log_id, hash, at, taken) VALUES (?, ?, ?, NULL)", [Number(v.logId), hash, NOW()]);
  } catch (e) {
    console.error("[stagecover] check record:", e.message);
    throw new Refuse(503, "The picture couldn't be safety-checked right now - try again in a minute.", "unchecked");
  }
  // 1.99ahq fix 3 (the block race): an admin / a review may have blocked this very picture while it was being classified (the check
  // above ran before) - asked again right before the store, and again inside the transaction that stores the row: a block that
  // commits before it is seen there; one that commits after finds this row (takeDownCopies) and takes it down
  const blockedNow = () => new Refuse(422, "That picture was taken down - it can't be used as a stage cover.", "blocked");
  if (await hashBlocked(hash)) throw blockedNow();
  // 1.99ahq review fix 3 (SEC-3, the hold race): whether it is HELD is decided inside that transaction too (below), so the file is
  // written to held/ first (never backed up) and moves into the normal folder only once its row says "ok" - a held picture never sits
  // in the backed-up folder, not even for a moment
  const name = crypto.randomBytes(16).toString("hex") + ".webp";
  const p = filePath(name, true);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, enc.buf, { flag: "wx" });
  let old, state = "held", onHold = false;
  try {
    old = await require("./dbUtils").tx(async () => {
      if (await hashBlocked(hash)) throw blockedNow();
      // HELD = not shown until an admin's check: a flagged picture, or any picture while the account is on hold after a take-down.
      // 1.99ahq review fix 3 (SEC-3): read HERE - a take-down (its strike + hold) that lands while this picture is classified or waits
      // for this transaction holds it; one that lands after the commit finds this row and takes it down
      const cur = await rowOf(userId);
      onHold = !!(cur && Number(cur.hold_until) > NOW());
      state = v.flagged || onHold ? "held" : "ok";
      return upsert(userId, { kind: "upload", upload: name, upload_state: state, upload_log: Number(v.logId) || null, upload_at: NOW(), upload_hash: hash });
    });
  } catch (e) { removeFile(name); invalidate(userId); throw e; }
  // (up: out of held/ - after the commit; a crash between leaves an "ok" picture in held/, which serving finds and placeFiles moves)
  if (state === "ok") { try { placeFile(name, false); } catch (e) { console.error("[stagecover] upload - move:", e.message); } }
  if (old && old.upload && old.upload !== name) removeFile(old.upload);
  console.log(`[stagecover] ${userId}: cover upload ${enc.w}x${enc.h} ${state}${onHold && !v.flagged ? " (account on hold)" : ""}${v.logId ? " (check #" + v.logId + ")" : ""}`);
  return { state };
}
/** Take an account's uploaded cover down (its owner, an admin, a review). The choice falls back to the default when it was "upload".
 *  1.99ahq review fix (SC-SAFE-1): a take-down that isn't the owner's own STICKS - the picture's hash is blocked (every account) and
 *  the account's next uploads are held for an admin's check for HOLD_MS (a strike). */
async function removeUpload(userId, why = "owner", { strike = true, copies = true } = {}) {
  const r = await rowOf(userId);
  if (!r || !r.upload) return false;
  const takedown = why !== "owner";
  const patch = { upload: null, upload_state: takedown ? "removed" : null, upload_log: null, upload_hash: null, ...(r.kind === "upload" ? { kind: null } : {}) };
  if (takedown && strike) Object.assign(patch, { hold_until: NOW() + HOLD_MS, strikes: (Number(r.strikes) || 0) + 1 });
  let hash = null;
  if (takedown) {
    hash = hashOfRow(r);
    if (hash) await blockHash(hash, blockCode(why));
  }
  await upsert(userId, patch);
  removeFile(r.upload);
  console.log(`[stagecover] ${userId}: uploaded cover taken down (${why})${takedown ? (strike ? " - picture blocked, uploads held until checked" : " - picture blocked") : ""}`);
  if (takedown) {
    await markTaken(r.upload_log);
    if (hash && copies) await takeDownCopies(hash, why);
  }
  return true;
}
// 1.99ahq review fix 2 (SC-SAFE-1b): the pieces of a take-down that a review of an OLD check (no current row holds it) needs too
const blockCode = (why) => (/^admin\b/.test(why) ? "admin" : /^review (fn|ok)\b/.test(why) ? why.slice(0, 9) : "other");    // (a code, never a name)
function blockHash(hash, code) { return runQuery("INSERT OR IGNORE INTO stage_cover_blocks (hash, at, why) VALUES (?, ?, ?)", [String(hash), NOW(), code]); }
/** A take-down acted on this check: a later review of it is no second strike. */
async function markTaken(logId) {
  if (!(Number(logId) > 0)) return;
  await runQuery("UPDATE stage_cover_checks SET taken = ? WHERE log_id = ? AND taken IS NULL", [NOW(), Number(logId)]);
}
/** A blocked picture is never shown as a cover: every account's current upload of it comes down too (it passed its own, later check
 *  before the block - a re-upload, another account's copy). Its own strike is the reviewed check's account's only. */
async function takeDownCopies(hash, why) {
  const rows = await getQuery("SELECT user_id FROM stage_covers WHERE upload_hash = ? AND upload IS NOT NULL", [String(hash)]);
  for (const x of rows) await removeUpload(x.user_id, why, { strike: false, copies: false });
  return rows.length;
}
/** A current upload's picture hash. (a row from before review fix 1 has no upload_hash: its file's - 1.99ahq review fix 3 (SEC-4):
 *  wherever it is, held/ too) */
function hashOfRow(r) {
  if (!r || !r.upload) return null;
  if (r.upload_hash) return r.upload_hash;
  try { return sha256(fs.readFileSync(fileAt(r.upload, r.upload_state))); } catch (e) { return null; }
}

// ── rankrule (owner 2026-11-05: "Rank rule - refuse actions on equal or higher-ranked staff.") - who a take-down acts on ──
// review fix B1: the image-safety REVIEW of a cover's check takes covers down (+ a strike) and puts held ones up exactly like the card's
// Take down / Put up - so it asks the same rule, before the mark is written. Both also take down every other account's copy of the
// picture (takeDownCopies): those accounts are checked too (your own copy is your business - self "allow").
/** The other accounts whose current upload is this picture. */
async function copyHolders(hash, except = null) {
  if (!hash) return [];
  return (await getQuery("SELECT user_id FROM stage_covers WHERE upload_hash = ? AND upload IS NOT NULL", [String(hash)]))
    .map((x) => String(x.user_id)).filter((u) => u !== String(except == null ? "" : except));
}
/** An admin take-down of userId's cover (the card / the review): -> {take: [that account], copies: [other accounts' copies]}. */
async function removeAffects(userId) {
  const r = await rowOf(userId);
  if (!r || !r.upload) return { take: [], copies: [], lift: [] };
  return { take: [String(userId)], copies: await copyHolders(hashOfRow(r), userId), lift: [] };
}
/** A review mark on a stage_cover check, read the way onReview acts on it (nothing written): -> {take, copies, lift}. */
async function reviewAffects(logId, mark) {
  await init();
  const id = Number(logId) || 0;
  const none = { take: [], copies: [], lift: [] };
  const r = (await getQuery("SELECT * FROM stage_covers WHERE upload_log = ? AND upload IS NOT NULL", [id]))[0];
  const l = (await getQuery("SELECT flagged, user_id FROM image_safety_log WHERE id = ?", [id]))[0];
  const take = mark === "fn" || (mark === "ok" && !!(l && Number(l.flagged) === 1));
  if (r) {
    if (take) return removeAffects(r.user_id);
    if (mark === "fp" && r.upload_state === "held") return { ...none, lift: [String(r.user_id)] };
    return none;
  }
  if (!take) return none;
  const ck = (await getQuery("SELECT hash, taken FROM stage_cover_checks WHERE log_id = ?", [id]))[0];
  if (!ck || !ck.hash || ck.taken) return none;          // (onReview does nothing then)
  const owner = l && l.user_id ? String(l.user_id) : null;      // (the hold + the strike)
  return { take: owner ? [owner] : [], copies: await copyHolders(ck.hash, owner), lift: [] };
}
/** The rule on what a take-down / put-up acts on (throws StaffRankError): the account itself - never yours, never PATV staff of your
 *  rank or above; another account's copy - never PATV staff of your rank or above; a put-up is a lift (never your own). */
async function assertAffects(actor, aff) {
  const SR = require("./staffrank");
  for (const u of aff.take || []) await SR.assert(actor, u);
  for (const u of aff.copies || []) await SR.assert(actor, u, { self: "allow" });
  for (const u of aff.lift || []) await SR.assert(actor, u, { lift: true });
}
/** An admin puts a HELD picture up (the "Stage covers" card's Put up; a "false positive" review). -> true when it was held. */
async function releaseUpload(userId) {
  const r = await rowOf(userId);
  if (!r || !r.upload || r.upload_state !== "held") return false;
  await upsert(userId, { upload_state: "ok" });
  // 1.99ahq fix 3: out of held/ into the normal (backed-up) folder - after the row (a crash between leaves an "ok" picture in held/,
  // which serving still finds and placeFiles moves; never a held one in the backed-up folder)
  try { placeFile(r.upload, false); } catch (e) { console.error("[stagecover] put up - move:", e.message); }
  return true;
}
/** imagesafety.review's hook (stage_cover checks): "fn" takes the picture down; "ok" (the check was right) on a check that FLAGGED it
 *  takes it down whatever its state now (1.99ahq review fix SC-SAFE-5: a mistaken "fp" corrected to "ok" brings it down again - a
 *  picture held only because its account is on hold passed its check, so "ok" leaves it to the card's Put up / Take down);
 *  "fp" on a held one puts it up.
 *  1.99ahq review fix 2 (SC-SAFE-1b): a take-down review of a check whose picture is no longer the member's current upload (they
 *  replaced it or removed it themselves) still sticks - from stage_cover_checks: the picture is blocked, any copy that is up again
 *  (a re-upload under a newer check, another account's) comes down, and the check's account gets the hold + a strike (once per check). */
async function onReview(logId, mark, actor) {
  await init();
  const id = Number(logId) || 0;
  const r = (await getQuery("SELECT * FROM stage_covers WHERE upload_log = ? AND upload IS NOT NULL", [id]))[0];
  let flagged = false, owner = null;
  try { const l = (await getQuery("SELECT flagged, user_id FROM image_safety_log WHERE id = ?", [id]))[0]; flagged = !!(l && Number(l.flagged) === 1); owner = l ? l.user_id : null; }
  catch (e) { flagged = true; }        // (unreadable: treat "ok" as the flag being right - fails closed)
  const take = mark === "fn" || (mark === "ok" && flagged);
  const why = "review " + mark + " by " + String(actor || "?").slice(0, 60);
  if (r) {
    if (take) { await removeUpload(r.user_id, why); return "removed"; }
    if (mark === "fp" && r.upload_state === "held") { await releaseUpload(r.user_id); return "released"; }
    return null;
  }
  if (!take) return null;
  const ck = (await getQuery("SELECT hash, taken FROM stage_cover_checks WHERE log_id = ?", [id]))[0];
  if (!ck || !ck.hash || ck.taken) return null;          // (not a stored picture's check, or a take-down already acted on it)
  await blockHash(ck.hash, blockCode(why));
  await markTaken(id);
  if (owner && (await getQuery("SELECT 1 AS x FROM users WHERE userId = ?", [String(owner)])).length) {
    const cur = await rowOf(owner);
    await upsert(owner, { hold_until: NOW() + HOLD_MS, strikes: (Number(cur && cur.strikes) || 0) + 1 });
  }
  const n = await takeDownCopies(ck.hash, why);
  console.log(`[stagecover] check #${id}: a replaced / removed cover taken down (${why}) - picture blocked${owner ? ", uploads held until checked" : ""}${n ? ", " + n + " copy(ies) down" : ""}`);
  return "blocked";
}
/** 1.99ahq review fix 2: a check's picture record goes with its log row (imagesafety.sweep's retention) - a review needs both. */
async function sweepChecks() {
  await init();
  try { return (await runQuery("DELETE FROM stage_cover_checks WHERE log_id NOT IN (SELECT id FROM image_safety_log)")).changes || 0; }
  catch (e) { if (/no such table/i.test(String(e && e.message))) return 0; throw e; }
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
  // 1.99ahq review fix (UX-4): what the stage would show for each choice (the page previews a pick before Save); a sticker previews
  // the sticker picked on the page
  const pv = async (kind) => { const c = await forAccount(u, login, { ...(r || {}), kind }); return c ? { url: c.url, k: c.k } : null; };
  const preview = { auto: await pv(null), gtf: await pv("gtf"), photo: await pv("photo"), upload: await pv("upload"), card: null };
  return {
    // 1.99ahq review fix (UX-3): no saved choice = "auto" (the default chain) - never shown as a GTF pick the member didn't make
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

/** 1.99ahq fix 3: every row's picture into its state's folder - a HELD one into held/ (never backed up), any other into the normal
 *  folder. At boot (the one-time migration of held pictures stored before held/ existed) and in every sweepFiles. -> files moved
 *  1.99ahq review fix 3 (SEC-4): a row from before review fix 1 (no upload_hash - staging only) gets its file's hash, so a take-down
 *  blocks it and finds its copies like any other. */
async function placeFiles() {
  await init();
  let n = 0, h = 0;
  for (const r of await getQuery("SELECT user_id, upload, upload_state, upload_hash FROM stage_covers WHERE upload IS NOT NULL")) {
    const held = r.upload_state === "held", to = filePath(r.upload, held);
    if (!to) continue;
    if (!isFile(to) && isFile(filePath(r.upload, !held))) {
      try { if (placeFile(r.upload, held)) n++; } catch (e) { console.error("[stagecover] place:", e.message); }
    }
    if (!r.upload_hash) {
      const p = fileAt(r.upload, r.upload_state);
      if (!p) continue;
      try {
        await runQuery("UPDATE stage_covers SET upload_hash = ? WHERE user_id = ? AND upload = ? AND upload_hash IS NULL", [sha256(fs.readFileSync(p)), String(r.user_id), r.upload]);
        h++;
      } catch (e) { console.error("[stagecover] hash:", e.message); }
    }
  }
  if (n) console.log(`[stagecover] ${n} cover picture(s) moved to their folder (held/ or the normal one)`);
  if (h) console.log(`[stagecover] ${h} older cover row(s) given their picture's hash`);
  return n;
}
/** Uploaded files no row holds any more (a replace that crashed, a deleted / merged account) - gone after an hour, from BOTH folders
 *  (1.99ahq fix 3: held/ too, and the HEIC decoder's leftovers there). */
async function sweepFiles(t = NOW()) {
  await init();
  try { await placeFiles(); } catch (e) { console.error("[stagecover] place files:", e.message); }
  const used = new Set((await getQuery("SELECT upload FROM stage_covers WHERE upload IS NOT NULL")).map((r) => r.upload));
  let n = 0;
  const old = (p) => { try { return t - fs.statSync(p).mtimeMs > 3600e3; } catch (e) { return false; } };
  for (const root of [dir(), heldDir()]) {
    let subs = [];
    try { subs = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { continue; }
    for (const d of subs) {
      const at = path.join(root, d.name);
      if (root === heldDir() && /^(?:tmp-[a-f0-9]{16}\.heic|heic-.+)$/.test(d.name) && old(at)) {        // (a HEIC decode a crash cut short)
        try { fs.rmSync(at, { recursive: true, force: true }); n++; } catch (e) { /* gone */ }
        continue;
      }
      if (!d.isDirectory() || !/^[a-f0-9]{2}$/.test(d.name)) continue;
      for (const f of fs.readdirSync(at)) {
        if (!FILE_RE.test(f) || used.has(f)) continue;
        const p = path.join(at, f);
        try { if (old(p)) { fs.unlinkSync(p); n++; } } catch (e) { /* gone */ }
      }
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
    if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: require("./staffrank").msg(res, e), code: e.code || null, ...(e.received != null ? { received: e.received } : {}) });
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
      const no = await uploadRefusal(uid(req));                 // 1.99ahq review fixes: restricted accounts, caps, one held at a time
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
      // rankrule: never your own, never PATV staff of your rank or above (the owner above every Admin) - before anything changes; the
      // automatic image checks (imagesafety's hook) still take any cover down. review fix B1: every other account's copy of the
      // picture comes down with it - those accounts too
      if (who) { await require("./staffrank").assert(a, who); await assertAffects(a, await removeAffects(who)); }
      if (!who || !(await removeUpload(who, "admin " + a.username))) throw new Refuse(404, "That cover is already gone.", "gone");
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/stage-cover/release", addUser, me(true), async (req, res) => {
    try {
      const a = await safetyAdmin(req);
      if (!a) return res.status(403).json({ ok: false, error: "Admins only." });
      const who = String((req.body || {}).user_id || "");
      if (who) await require("./staffrank").assert(a, who, { lift: true });      // rankrule: never your own held cover (a lift: no rank)
      if (!who || !(await releaseUpload(who))) throw new Refuse(404, "That cover isn't waiting for a check.", "gone");
      console.log(`[stagecover] ${who}: held cover put up by admin ${a.username}`);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
  // 1.99ahq review fixes (SC-SAFE-2, PRIV-4, COMPAT-2): only a GTF render is immutable (its URL is its picture + render version). An
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
    if (!filePath(name)) return res.status(404).end();
    try {
      await init();
      const r = (await getQuery("SELECT user_id, upload_state FROM stage_covers WHERE upload = ?", [name]))[0];
      const pub = !!r && r.upload_state === "ok";
      let ok = pub;
      if (r && r.upload_state === "held") {
        if (req.user === undefined && typeof addUser === "function") await new Promise((next) => addUser(req, res, next));
        ok = !!(req.user && req.user.userId && (String(req.user.userId) === String(r.user_id) || (await safetyAdmin(req))));
      }
      const p = ok ? fileAt(name, r.upload_state) : null;            // 1.99ahq fix 3: held/ for a held one, else the normal folder
      if (!ok || !p) { res.set("Cache-Control", "no-store"); return res.status(404).end(); }
      const H = pictureHeaders("image/webp", pub ? "public" : "private");
      res.set(H);
      res.sendFile(p, { etag: true, lastModified: false, cacheControl: false, headers: H }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
    } catch (e) {
      console.error("[stagecover] file:", e.message);
      if (!res.headersSent) res.status(500).end();
    }
  });
  // 1.99ahq fix 3: a profile photo through the proxy (micfollow's cfg cover_photo_proxy) - only a key a program handed out
  // (photoProxyUrl), the re-encoded picture from the cache (else fetched from its allowed host); short public caches like an upload
  // (the member may change or remove their photo); anything else / a failed fetch = 404 (the page then shows the letter)
  app.get("/media/cover/p/:file", async (req, res) => {
    const m = /^([a-f0-9]{32})\.webp$/.exec(String(req.params.file || ""));
    const src = m ? proxiedUrl(m[1]) : null;
    try {
      const pic = src ? await photoImage(src) : null;
      if (!pic) { res.set("Cache-Control", "no-store"); return res.status(404).end(); }
      res.set({ ...pictureHeaders("image/webp", "public"), ETag: '"' + sha256(pic.buf).slice(0, 32) + '"' });
      if (req.fresh) return res.status(304).end();
      res.send(pic.buf);
    } catch (e) {
      console.error("[stagecover] photo:", e.message);
      if (!res.headersSent) res.status(500).end();
    }
  });
  placeFiles().catch((e) => console.error("[stagecover] place files:", e.message));   // 1.99ahq fix 3: the one-time migration (idempotent)
  if (!noTimers) {
    setInterval(() => sweepUploads(), 5 * 60e3).unref();
    setTimeout(() => sweepFiles().catch(() => {}), 60e3).unref();
    setInterval(() => sweepFiles().catch(() => {}), 6 * 3600e3).unref();
    setInterval(() => sweepChecks().catch(() => {}), 6 * 3600e3).unref();      // 1.99ahq review fix 2
  }
}

module.exports = {
  init, register, coverOf, invalidate, localImage, localImageChecked, onReview, removeUpload, releaseUpload, setUpload, uploadRefusal, save, stateFor, choiceOf,
  reviewAffects, removeAffects, assertAffects,      // rankrule review fix B1
  adminList, sweepFiles, sweepChecks, gtfUrl, parseGtf, forAccount, uploadsOn, openUpload, chunkUpload, finishUpload, filePath, dir, _setDir, Refuse,
  KINDS, PIC_KINDS, SURFACE, MAX_BYTES, CHUNK, COVER_PX, CACHE_MS, FILE_RE, UPLOADS_PER_HOUR, UPLOADS_PER_DAY, HOLD_MS, UPLOAD_MAX_AGE, UPLOAD_CDN_MAX_AGE,
  // 1.99ahq fix 3: captures draw the photo too (the allow-list + the guarded fetch + the proxy); held pictures in held/
  captureImage, photoImage, photoProxyUrl, photoSource, photoSources, publicAddr, placeFiles, fileAt, heldDir, hashBlocked,
  PHOTO_MAX_BYTES, PHOTO_TIMEOUT_MS, PHOTO_TTL, PHOTO_FAIL_TTL,
  _setClock: (fn) => { NOW = fn || (() => Date.now()); },
  _setRenderVersion: (v) => { RENDER_V = v == null ? null : String(v); SVGS.clear(); },
  /** (tests) the photo fetch's network - {lookup, request}; null = the real one. Clears the photo cache and keys. */
  _setPhotoNet: (n) => { PNET = n ? { ...PNET_REAL, ...n } : PNET_REAL; PHOTOS.clear(); PHOTO_INFLIGHT.clear(); PHOTO_KEYS.clear(); photoBytes = 0; },
};
