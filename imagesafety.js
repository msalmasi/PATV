// imagesafety.js — automated image safety checks for user uploads (1.99fc). SHIPPED OFF.
//
// One module classifies a picture (or a video, through a few sampled frames) and turns the classification into what
// happens on each upload surface. The CLASSIFIER is Pepe's vision: the site never holds a model API key. The site
// queues a check, Pepe pulls it (bot token), looks at the frames with the vision model his model registry picks for the
// "safety" function (admin panel, Pepe), and posts the classification back (camfrog-bot pepe_imagesafety.py).
//
// The classification (what Pepe sends; checked again here by cleanVerdict):
//   verdict     allow | nsfw | refuse  - the model's own overall call (advisory; the POLICY below decides)
//   scores      {nudity_explicit, sexual, suggestive, minor_risk, gore, hate_symbols}: 0..1 each
//   categories  the ones at or over their threshold (config.thresholds)
//   confidence  the highest score among the categories found (or 1 - the highest score when none)
//   reason      one short neutral sentence
//
// The POLICY (config.policy, per surface GROUP; admin-settable). Each category -> an action:
//   allow        nothing
//   flag         allowed, but the check is flagged for the admins' review page
//   nsfw         marked NSFW (a profile surface can't be NSFW, so there it means refuse)
//   nsfw_pad     marked NSFW, refused where the target pad doesn't allow NSFW (profile surfaces: refuse)
//   refuse       refused
//   refuse_flag  refused + flagged + an inbox notice to every admin
// plus the pseudo-category "nsfw_level": the model's own verdict was nsfw / refuse (how "suggestive is fine unless
// it's NSFW-level" is expressed for profile surfaces). A model verdict "refuse" always flags the check too.
// Defaults (Terms + Padiquette):
//   profile (pad avatar / banner / animated avatar, profile photo): nudity_explicit, sexual, gore, nsfw_level -> refuse;
//            minor_risk -> refuse_flag; suggestive -> allow; hate_symbols -> flag
//   media   (feed posts, stories, DM pictures):  minor_risk -> refuse_flag; nudity_explicit, sexual -> nsfw_pad;
//            gore, nsfw_level -> nsfw; suggestive -> allow; hate_symbols -> flag
//   AI generations are NOT checked here: Pepe's aigen post-check (AIGEN_POLICY) already ran on them, and feed
//   attachments with ai_generated are skipped.
//
// SWITCHES (table image_safety_kv, key "config"; /admin/imagesafety, Admins only):
//   image_safety_enabled   master switch, DEFAULT OFF. Off (and shadow off) = every hook is the old pass-through and
//                          NOTHING is queued for Pepe.
//   image_safety_shadow    shadow mode, DEFAULT OFF, separate from the master switch: classify + record + log, never
//                          block or mark (and never makes an upload wait). While it's on it WINS over enforcement.
//   image_safety_fail_mode "open" (default: allowed, recorded as unchecked for admin review) | "closed" (refused)
//   image_safety_timeout_secs  how long an upload waits for Pepe (default 20 s)
//   image_safety_surfaces  {pad_look, profile_photo, feed, story, dm}: each true by default (they only matter once the
//                          master switch or shadow mode is on)
//   image_safety_video_frames, image_safety_thresholds, image_safety_policy, image_safety_notify_minor,
//   image_safety_retention_days
//
// The QUEUE is in memory (the waiting upload is in this process anyway): enqueue -> Pepe's long-poll
// (POST /api/pepe/imagesafety/pull, up to PULL_WAIT_MAX) claims jobs -> POST /api/pepe/imagesafety/verdict. A claimed
// job that gets no verdict in CLAIM_TTL is offered again. An upload waits timeout_secs; past that the fail mode
// decides, but the job stays queued for LATE_MS - a late verdict is still recorded on the check's row (late = 1) and
// flags it when the policy would have acted, so fail-open uploads still reach the admins. Identical frames
// (sha256) share one classification for CACHE_MS (an upload is classified as soon as it's processed - prefetch -
// and the post / story that uses it reuses that).
//
// The LOG (table image_safety_log, one row per decision or shadow check): surface, user, pad, ref, the
// classification, the action taken (allow / nsfw / refuse / shadow / failopen / failclosed), flagged, late, the
// admins' review (fp = false positive, fn = false negative, ok = correct) + who/when. A 256 px thumbnail of the first
// frame is kept in a PRIVATE directory (IMAGESAFETY_DIR, default /var/lib/patv[-staging]/imagesafety; off Linux a
// folder next to the code tree) and served only to Admins (GET /admin/imagesafety/thumb/<id>: no-store, nosniff,
// CORP same-origin). A thumbnail of a minor_risk check is stored BLURRED (never a clear copy). Rows + thumbnails are
// deleted after retention_days (default 30).
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");

const SURFACES = Object.freeze(["pad_look", "profile_photo", "feed", "story", "dm"]);
const SURFACE_LABEL = Object.freeze({ pad_look: "Pad avatar / banner", profile_photo: "Profile photo", feed: "Feed posts", story: "Stories", dm: "DM pictures" });
const GROUP = Object.freeze({ pad_look: "profile", profile_photo: "profile", feed: "media", story: "media", dm: "media" });
const CATEGORIES = Object.freeze(["nudity_explicit", "sexual", "suggestive", "minor_risk", "gore", "hate_symbols"]);
const POLICY_KEYS = Object.freeze([...CATEGORIES, "nsfw_level"]);
const ACTIONS = Object.freeze(["allow", "flag", "nsfw", "nsfw_pad", "refuse", "refuse_flag"]);
const VERDICTS = Object.freeze(["allow", "nsfw", "refuse"]);
const DEFAULT_POLICY = Object.freeze({
  profile: Object.freeze({ nudity_explicit: "refuse", sexual: "refuse", suggestive: "allow", minor_risk: "refuse_flag", gore: "refuse", hate_symbols: "flag", nsfw_level: "refuse" }),
  media: Object.freeze({ nudity_explicit: "nsfw_pad", sexual: "nsfw_pad", suggestive: "allow", minor_risk: "refuse_flag", gore: "nsfw", hate_symbols: "flag", nsfw_level: "nsfw" }),
});
const DEFAULTS = Object.freeze({
  enabled: false, shadow: false, fail_mode: "open", timeout_secs: 20, video_frames: 3, notify_minor: true, retention_days: 30,
  surfaces: Object.freeze({ pad_look: true, profile_photo: true, feed: true, story: true, dm: true }),
  thresholds: Object.freeze({ nudity_explicit: 0.5, sexual: 0.5, suggestive: 0.5, minor_risk: 0.4, gore: 0.5, hate_symbols: 0.6 }),
  policy: DEFAULT_POLICY,
});
// the setting names (what the admin page, the API and the docs call them) -> config keys
const SETTING_NAMES = Object.freeze({
  image_safety_enabled: "enabled", image_safety_shadow: "shadow", image_safety_fail_mode: "fail_mode",
  image_safety_timeout_secs: "timeout_secs", image_safety_surfaces: "surfaces", image_safety_video_frames: "video_frames",
  image_safety_thresholds: "thresholds", image_safety_policy: "policy", image_safety_notify_minor: "notify_minor",
  image_safety_retention_days: "retention_days",
});

const FRAME_PX = 768;
const THUMB_PX = 256;
const PULL_WAIT_MAX = 10e3;        // Pepe's long-poll (staging's router gives a POST 15 s)
const PULL_MAX_JOBS = 4;
const CLAIM_TTL = 90e3;            // a claimed job with no verdict is offered again after this
const LATE_MS = 10 * 60e3;         // a job nobody waits for any more still takes a late verdict this long
const CACHE_MS = 30 * 60e3;
const CACHE_MAX = 500;
const REASON_MAX = 200;
let NOW = () => Date.now();
function _setClock(fn) { NOW = fn; }

const PASS = Object.freeze({ ok: true, nsfw: false });

// ── storage ──
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS image_safety_kv (k TEXT PRIMARY KEY, v TEXT)");
      await runQuery(`CREATE TABLE IF NOT EXISTS image_safety_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
        surface TEXT NOT NULL, kind TEXT, user_id TEXT, room_id TEXT, ref TEXT, hash TEXT, mode TEXT NOT NULL, action TEXT NOT NULL,
        flagged INTEGER NOT NULL DEFAULT 0, verdict TEXT, categories TEXT, scores TEXT, confidence REAL, reason TEXT, model TEXT,
        cost REAL NOT NULL DEFAULT 0, ms INTEGER, late INTEGER NOT NULL DEFAULT 0, would TEXT, thumb TEXT,
        review TEXT, reviewed_by TEXT, reviewed_at INTEGER, note TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS image_safety_log_at ON image_safety_log (at)");
      await runQuery("CREATE INDEX IF NOT EXISTS image_safety_log_flag ON image_safety_log (flagged, at)");
      await runQuery("CREATE INDEX IF NOT EXISTS image_safety_log_hash ON image_safety_log (hash)");
    })().catch((e) => { console.error("[imagesafety] init:", e.message); ready = null; throw e; });
  }
  return ready;
}

function pickDir() {
  if (process.env.IMAGESAFETY_DIR) return path.resolve(process.env.IMAGESAFETY_DIR);
  if (process.platform === "linux") {
    const d = process.env.STAGING ? "/var/lib/patv-staging/imagesafety" : "/var/lib/patv/imagesafety";
    try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (e) { /* not root: below */ }
  }
  return path.resolve(__dirname, "..", path.basename(__dirname) + "-imagesafety");
}
let DIR = null;
function dir() { if (!DIR) { DIR = pickDir(); fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); } return DIR; }
function _setDir(d) { DIR = d; fs.mkdirSync(DIR, { recursive: true }); }
const THUMB_RE = /^[a-f0-9]{32}\.webp$/;
function thumbPath(name) { return THUMB_RE.test(String(name || "")) ? path.join(dir(), name) : null; }

// ── config ──
const bool = (v) => v === true || v === 1 || v === "1" || v === "on" || v === "true";
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
/** Any patch (config keys or image_safety_* setting names) over `base` -> a clean config. */
function cleanConfig(c, base = DEFAULTS) {
  const src = {};
  for (const [k, v] of Object.entries(c || {})) src[SETTING_NAMES[k] || k] = v;
  const o = {
    enabled: src.enabled != null ? bool(src.enabled) : !!base.enabled,
    shadow: src.shadow != null ? bool(src.shadow) : !!base.shadow,
    fail_mode: src.fail_mode === "closed" || src.fail_mode === "open" ? src.fail_mode : (base.fail_mode === "closed" ? "closed" : "open"),
    timeout_secs: num(src.timeout_secs, 0.2, 120, base.timeout_secs),
    video_frames: Math.round(num(src.video_frames, 1, 6, base.video_frames)),
    notify_minor: src.notify_minor != null ? bool(src.notify_minor) : !!base.notify_minor,
    retention_days: Math.round(num(src.retention_days, 1, 365, base.retention_days)),
    surfaces: {}, thresholds: {}, policy: { profile: {}, media: {} },
  };
  const sIn = src.surfaces && typeof src.surfaces === "object" ? src.surfaces : {};
  for (const s of SURFACES) o.surfaces[s] = sIn[s] != null ? bool(sIn[s]) : (base.surfaces || DEFAULTS.surfaces)[s] !== false;
  const tIn = src.thresholds && typeof src.thresholds === "object" ? src.thresholds : {};
  for (const k of CATEGORIES) o.thresholds[k] = num(tIn[k], 0.05, 1, (base.thresholds || DEFAULTS.thresholds)[k]);
  const pIn = src.policy && typeof src.policy === "object" ? src.policy : {};
  for (const g of ["profile", "media"]) {
    const gi = pIn[g] && typeof pIn[g] === "object" ? pIn[g] : {};
    const gb = (base.policy || DEFAULT_POLICY)[g] || DEFAULT_POLICY[g];
    for (const k of POLICY_KEYS) o.policy[g][k] = ACTIONS.includes(gi[k]) ? gi[k] : (ACTIONS.includes(gb[k]) ? gb[k] : DEFAULT_POLICY[g][k]);
  }
  return o;
}
let CFG = null;
async function config() {
  if (CFG) return CFG;
  await init();
  let c = {};
  try { c = JSON.parse(((await getQuery("SELECT v FROM image_safety_kv WHERE k = 'config'"))[0] || {}).v || "{}"); } catch (e) { c = {}; }
  CFG = cleanConfig(c);
  return CFG;
}
async function setConfig(patch, actor = "?") {
  const cur = await config();
  const next = cleanConfig(patch || {}, cur);
  await runQuery("INSERT INTO image_safety_kv (k, v) VALUES ('config', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [JSON.stringify(next)]);
  CFG = next;
  const flip = (k) => (cur[k] !== next[k] ? ` ${k} ${cur[k]} -> ${next[k]}` : "");
  console.log(`[imagesafety] settings saved by ${actor}:${flip("enabled")}${flip("shadow")}${flip("fail_mode")}${flip("timeout_secs")}`);
  return next;
}
/** The config as the image_safety_* setting names (admin page / API). */
function settingsView(c) {
  const o = {};
  for (const [name, k] of Object.entries(SETTING_NAMES)) o[name] = c[k];
  return o;
}
/** Is anything going to be classified for this surface? (master switch or shadow mode, and the surface's toggle) */
function active(c, surface) { return !!c && (c.enabled || c.shadow) && SURFACES.includes(surface) && c.surfaces[surface] !== false; }

// ── the classification ──
/** Pepe's (or a stub's) classification -> a clean one, or null when it's unusable. */
function cleanVerdict(v, thresholds = DEFAULTS.thresholds) {
  if (!v || typeof v !== "object") return null;
  const verdict = VERDICTS.includes(String(v.verdict || "").toLowerCase()) ? String(v.verdict).toLowerCase() : null;
  const scores = {};
  const sIn = v.scores && typeof v.scores === "object" ? v.scores : {};
  const listed = new Set(Array.isArray(v.categories) ? v.categories.map((x) => String(x).toLowerCase()) : []);
  let any = false;
  for (const k of CATEGORIES) {
    let s = Number(sIn[k]);
    if (!Number.isFinite(s)) s = listed.has(k) ? 1 : 0; else any = true;
    scores[k] = Math.round(Math.min(1, Math.max(0, s)) * 1000) / 1000;
  }
  if (!verdict && !any && !listed.size) return null;
  const categories = CATEGORIES.filter((k) => scores[k] >= thresholds[k]);
  const top = Math.max(0, ...CATEGORIES.map((k) => scores[k]));
  let confidence = Number(v.confidence);
  if (!Number.isFinite(confidence)) confidence = categories.length ? Math.max(...categories.map((k) => scores[k])) : 1 - top;
  return {
    verdict: verdict || (categories.length ? "nsfw" : "allow"), categories, scores,
    confidence: Math.round(Math.min(1, Math.max(0, confidence)) * 1000) / 1000,
    reason: String(v.reason || "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, REASON_MAX),
  };
}

const RANK = { allow: 0, flag: 1, nsfw: 2, nsfw_pad: 3, refuse: 4, refuse_flag: 5 };
/**
 * The policy: (surface, classification, {padAllowsNsfw}) -> {action: allow|nsfw|refuse, flagged, why: [keys], message}
 * Pure - the tests drive it with a stubbed classification.
 */
function decide(surface, v, { padAllowsNsfw = true, policy = DEFAULT_POLICY } = {}) {
  const group = GROUP[surface] || "media";
  const P = (policy && policy[group]) || DEFAULT_POLICY[group];
  const keys = [...(v.categories || [])];
  if (v.verdict === "nsfw" || v.verdict === "refuse") keys.push("nsfw_level");
  let flagged = v.verdict === "refuse";
  let worst = "allow";
  const why = [];
  for (const k of keys) {
    const a = P[k] || "allow";
    if (a === "flag" || a === "refuse_flag") flagged = true;
    if (a !== "allow") why.push(k);
    if (RANK[a] > RANK[worst]) worst = a;
  }
  let action = "allow";
  if (worst === "refuse" || worst === "refuse_flag") action = "refuse";
  else if (worst === "nsfw_pad") action = group === "profile" || !padAllowsNsfw ? "refuse" : "nsfw";
  else if (worst === "nsfw") action = group === "profile" ? "refuse" : "nsfw";
  return { action, flagged, why, worst, message: action === "refuse" ? refusalMessage(surface, why, padAllowsNsfw) : "" };
}
function refusalMessage(surface, why, padAllowsNsfw) {
  if (why.includes("minor_risk")) return "That picture can't be posted here (Terms: nothing sexual or suggestive involving anyone who may be under 18).";
  if (GROUP[surface] === "profile") {
    const what = surface === "profile_photo" ? "Profile photos" : "Pad avatars and banners";
    return `That picture looks like adult or graphic content - ${what} must be safe for work (Terms).`;
  }
  if (!padAllowsNsfw && (why.includes("nudity_explicit") || why.includes("sexual"))) return "That looks like explicit content, and this pad doesn't allow NSFW posts.";
  return "That file can't be posted here (Terms).";
}

// ── frames ──
async function jpegFrame(input, page) {
  const sharp = require("sharp");
  const opts = { limitInputPixels: 60e6 };
  if (page != null) opts.page = page;
  return sharp(input, opts).rotate().resize(FRAME_PX, FRAME_PX, { fit: "inside", withoutEnlargement: true }).flatten({ background: "#ffffff" })
    .jpeg({ quality: 80 }).toBuffer();
}
async function imageFrames(input) {
  const sharp = require("sharp");
  let pages = 1;
  try { pages = (await sharp(input, { limitInputPixels: 60e6 }).metadata()).pages || 1; } catch (e) { pages = 1; }
  const out = [await jpegFrame(input, pages > 1 ? 0 : undefined)];
  if (pages > 2) out.push(await jpegFrame(input, Math.floor(pages / 2)));     // an animation: the middle too
  return out;
}
async function videoFrames(file, secs, n) {
  const media = require("./feedmedia");
  const out = [];
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "isf-"));
  const release = await media.slot();
  try {
    let d = Number(secs);
    if (!(d > 0)) { try { d = (await media.probe(file, "mp4")).secs; } catch (e) { d = 0; } }
    const pts = Array.from({ length: n }, (_, i) => (d > 0 ? (d * (i + 0.5)) / n : 0));
    for (let i = 0; i < pts.length; i++) {
      const f = path.join(work, i + ".jpg");
      try {
        await media.run(media.bin("ffmpeg"), ["-hide_banner", "-v", "error", "-protocol_whitelist", "file", "-ss", pts[i].toFixed(2), "-i", file,
          "-frames:v", "1", "-an", "-vf", `scale='min(${FRAME_PX},iw)':-2`, "-y", f], { timeoutMs: 30000 });
        if (fs.existsSync(f)) out.push(await jpegFrame(fs.readFileSync(f)));
      } catch (e) { /* that frame failed: the others still count */ }
      if (d <= 0) break;
    }
  } finally {
    release();
    try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { /* none */ }
  }
  return out;
}
/** {buf | file, kind, poster, secs} -> [jpeg buffers] (empty when nothing could be read) */
async function framesFor({ buf, file, kind, poster, secs } = {}, n = DEFAULTS.video_frames) {
  try {
    if (kind === "video") {
      let fr = file ? await videoFrames(file, secs, n) : [];
      if (!fr.length && poster && fs.existsSync(poster)) fr = [await jpegFrame(poster)];
      return fr;
    }
    if (Buffer.isBuffer(buf)) return await imageFrames(buf);
    if (file && fs.existsSync(file)) return await imageFrames(file);
  } catch (e) { console.error("[imagesafety] frames:", e.message); }
  return [];
}
const hashFrames = (frames) => { const h = crypto.createHash("sha256"); for (const f of frames) h.update(f); return h.digest("hex"); };

// ── the queue (in memory) ──
const JOBS = new Map();          // id -> job
const PULLERS = [];              // pending long-polls: () => void
const CACHE = new Map();         // hash -> {at, promise}
let LAST_PULL = 0;
function wake() { while (PULLERS.length) { try { PULLERS.shift()(); } catch (e) { /* gone */ } } }
function expireJobs(t = NOW()) {
  for (const [id, j] of JOBS) {
    if (t - j.created > LATE_MS) { JOBS.delete(id); j.reject(Object.assign(new Error("expired"), { code: "expired" })); }
  }
  for (const [h, c] of CACHE) if (t - c.at > CACHE_MS) CACHE.delete(h);
}
/** Queue frames for Pepe -> {id, promise (resolves with the clean classification + model/cost; rejects on error)} */
function enqueue(frames, meta = {}) {
  expireJobs();
  const id = crypto.randomBytes(12).toString("hex");
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {});        // a job nobody waits on any more must not be an unhandled rejection
  JOBS.set(id, { id, frames, meta: { surface: meta.surface || "", kind: meta.kind || "image" }, created: NOW(), claimed: 0, resolve, reject });
  wake();
  return { id, promise };
}
/** One classification per distinct set of frames (prefetch and the commit point share it). */
function classifyFrames(frames, meta) {
  const hash = hashFrames(frames);
  expireJobs();
  const hit = CACHE.get(hash);
  if (hit) return { hash, promise: hit.promise, cached: true };
  const { promise } = enqueue(frames, meta);
  CACHE.set(hash, { at: NOW(), promise });
  promise.catch(() => CACHE.delete(hash));         // an error / expiry isn't cached
  if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  return { hash, promise, cached: false };
}
function claimable(t = NOW()) {
  return [...JOBS.values()].filter((j) => !j.claimed || t - j.claimed > CLAIM_TTL);
}
/** Pepe's long-poll -> up to PULL_MAX_JOBS jobs ({id, surface, kind, frames: [base64 jpeg]}), [] after `waitMs`. */
async function pull(waitMs = 0) {
  LAST_PULL = NOW();
  expireJobs();
  let list = claimable();
  if (!list.length && waitMs > 0) {
    await new Promise((res) => {
      const t = setTimeout(() => { const i = PULLERS.indexOf(done); if (i >= 0) PULLERS.splice(i, 1); res(); }, Math.min(PULL_WAIT_MAX, waitMs));
      function done() { clearTimeout(t); res(); }
      PULLERS.push(done);
    });
    list = claimable();
  }
  const t = NOW();
  return list.slice(0, PULL_MAX_JOBS).map((j) => {
    j.claimed = t;
    return { id: j.id, surface: j.meta.surface, kind: j.meta.kind, frames: j.frames.map((f) => f.toString("base64")), created: j.created };
  });
}
/** Pepe's answer for one job. body: {id, verdict: {...}, model, cost} | {id, error} -> true if the job was waiting */
async function result(body = {}) {
  const j = JOBS.get(String(body.id || ""));
  if (!j) return false;
  JOBS.delete(j.id);
  const c = await config();
  const v = body.error ? null : cleanVerdict(body.verdict, c.thresholds);
  if (!v) {
    j.reject(Object.assign(new Error(String(body.error || "unreadable verdict").slice(0, 120)), { code: "error" }));
    return true;
  }
  j.resolve({ ...v, model: String(body.model || "").slice(0, 80) || null, cost: Math.max(0, Number(body.cost) || 0), ms: NOW() - j.created });
  return true;
}
function queueStats() { return { queued: JOBS.size, waiting: claimable().length, lastPull: LAST_PULL || null }; }

// ── the classifier (pluggable: tests stub it; the default is Pepe's queue) ──
let CLASSIFIER = null;
/** fn({frames, surface, kind}) -> Promise<{verdict, scores|categories, reason, model?, cost?}>. null = Pepe's queue. */
function setClassifier(fn) { CLASSIFIER = typeof fn === "function" ? fn : null; }
function classify(frames, meta) {
  if (CLASSIFIER) {
    const hash = hashFrames(frames);
    const promise = Promise.resolve().then(() => CLASSIFIER({ frames, ...meta })).then(async (raw) => {
      const v = cleanVerdict(raw, (await config()).thresholds);
      if (!v) throw Object.assign(new Error("unreadable verdict"), { code: "error" });
      return { ...v, model: (raw && raw.model) || "stub", cost: Number(raw && raw.cost) || 0, ms: 0 };
    });
    promise.catch(() => {});
    return { hash, promise, cached: false };
  }
  return classifyFrames(frames, meta);
}

// ── the log ──
async function thumbFor(frames, blur) {
  if (!frames.length) return null;
  try {
    const sharp = require("sharp");
    let s = sharp(frames[0]).resize(THUMB_PX, THUMB_PX, { fit: "inside" });
    if (blur) s = s.blur(18);
    const name = crypto.randomBytes(16).toString("hex") + ".webp";
    fs.writeFileSync(path.join(dir(), name), await s.webp({ quality: 70 }).toBuffer(), { flag: "wx", mode: 0o600 });
    return name;
  } catch (e) { console.error("[imagesafety] thumb:", e.message); return null; }
}
async function record(row, frames) {
  await init();
  const v = row.v || null;
  const minor = !!(v && v.categories.includes("minor_risk"));
  // DM pictures are private: a thumbnail is kept only when the check acted (or would have, in shadow mode) or flagged it
  const keep = row.surface !== "dm" || !!(v && ((row.would && row.would !== "allow") || row.flagged));
  const thumb = keep ? await thumbFor(frames || [], minor) : null;
  const r = await runQuery(`INSERT INTO image_safety_log (at, surface, kind, user_id, room_id, ref, hash, mode, action, flagged, verdict, categories, scores,
                            confidence, reason, model, cost, ms, would, thumb) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [NOW(), row.surface, row.kind || null, row.userId || null, row.roomId || null, row.ref ? String(row.ref).slice(0, 80) : null, row.hash || null,
     row.mode, row.action, row.flagged ? 1 : 0, v ? v.verdict : null, v ? JSON.stringify(v.categories) : null, v ? JSON.stringify(v.scores) : null,
     v ? v.confidence : null, v ? v.reason : (row.reason || null), v ? v.model : null, v ? v.cost || 0 : 0, v ? v.ms || null : null,
     row.would || null, thumb]);
  const id = r && (r.id != null ? r.id : r.lastID);   // dbUtils.runQuery -> {id, changes}
  if (row.flagged && minor) await notifyAdmins(id, row);
  return id;
}
async function notifyAdmins(id, row) {
  try {
    const c = await config();
    if (!c.notify_minor) return;
    const admins = await getQuery("SELECT userId FROM users WHERE class = 'Admin'");
    const shadow = row.mode === "shadow" ? " (shadow mode: nothing was blocked)" : row.mode === "late" ? " (classified late - the upload went through)" : "";
    for (const a of admins) {
      await require("./inbox").addSafe(a.userId, { kind: "admin", title: "URGENT: image safety flagged a possible minor in sexual / suggestive content",
        body: `A ${SURFACE_LABEL[row.surface] || row.surface} upload${shadow}. Review it on the image safety page. Don't download or share it; follow the CSAM procedure.`,
        link: "/admin/imagesafety#flagged", ref: "imagesafety:" + id });
    }
  } catch (e) { console.error("[imagesafety] notify:", e.message); }
}
/** A late verdict (after the upload stopped waiting): fill in the row, flag it when the policy would have acted. */
async function recordLate(id, v, surface, padAllowsNsfw, c) {
  try {
    const d = decide(surface, v, { padAllowsNsfw, policy: c.policy });
    const flag = d.flagged || d.action !== "allow";
    await runQuery(`UPDATE image_safety_log SET late = 1, verdict = ?, categories = ?, scores = ?, confidence = ?, reason = ?, model = ?, cost = ?, ms = ?,
                    would = ?, flagged = CASE WHEN ? THEN 1 ELSE flagged END WHERE id = ?`,
      [v.verdict, JSON.stringify(v.categories), JSON.stringify(v.scores), v.confidence, v.reason, v.model, v.cost || 0, v.ms || null,
       d.action, flag ? 1 : 0, id]);
    if (v.categories.includes("minor_risk")) {
      // the thumbnail was stored before anyone knew: blur it now (never keep a clear copy)
      const r = (await getQuery("SELECT thumb FROM image_safety_log WHERE id = ?", [id]))[0];
      const p = r && thumbPath(r.thumb);
      if (p && fs.existsSync(p)) {
        const sharp = require("sharp");
        const b = await sharp(fs.readFileSync(p)).blur(18).webp({ quality: 70 }).toBuffer();
        fs.writeFileSync(p, b);
      }
    }
    if (d.flagged && v.categories.includes("minor_risk")) await notifyAdmins(id, { surface, mode: "late" });
  } catch (e) { console.error("[imagesafety] late:", e.message); }
}

// ── the check ──
/**
 * The one entry point every upload surface calls.
 * input: {surface, kind: image|video, buf | file, poster, secs, userId, roomId, ref, padAllowsNsfw}
 * -> {ok: true, nsfw: bool} | {ok: false, nsfw?: bool, reason}  (+ mode, logId, flagged, action - informational)
 * Off (master switch and shadow off, or the surface toggled off): PASS, nothing queued, nothing recorded.
 */
async function check(input = {}) {
  const c = await config();
  const surface = input.surface;
  if (!active(c, surface)) return PASS;
  const kind = input.kind === "video" ? "video" : "image";
  const padAllowsNsfw = input.padAllowsNsfw !== false;
  const base = { surface, kind, userId: input.userId, roomId: input.roomId, ref: input.ref };
  const frames = await framesFor({ ...input, kind }, c.video_frames);
  // shadow mode: classify in the background, record, never block, mark or wait
  if (c.shadow) {
    if (!frames.length) return PASS;
    const job = classify(frames, { surface, kind });
    job.promise.then((v) => {
      const d = decide(surface, v, { padAllowsNsfw, policy: c.policy });
      console.log(`[imagesafety] shadow ${surface}: ${v.verdict} [${v.categories.join(",") || "-"}] -> would ${d.action}${d.flagged ? " +flag" : ""}`);
      return record({ ...base, hash: job.hash, mode: "shadow", action: "shadow", would: d.action, flagged: d.flagged, v }, frames);
    }, (e) => record({ ...base, hash: job.hash, mode: "shadow", action: "shadow", would: "unchecked", reason: "no classification: " + (e.code || e.message) }, frames))
      .catch((e) => console.error("[imagesafety] shadow record:", e.message));
    return { ...PASS, mode: "shadow" };
  }
  // enforcement
  const fail = async (why, job) => {
    const open = c.fail_mode !== "closed";
    const id = await record({ ...base, hash: job && job.hash, mode: "enforce", action: open ? "failopen" : "failclosed", flagged: open, reason: why }, frames);
    console.log(`[imagesafety] ${surface}: no classification (${why}) -> fail-${open ? "open" : "closed"}`);
    if (job && open && id) job.promise.then((v) => recordLate(id, v, surface, padAllowsNsfw, c), () => {});
    return open ? { ...PASS, mode: "failopen", logId: id }
      : { ok: false, reason: "The picture couldn't be safety-checked right now - try again in a minute.", mode: "failclosed", logId: id };
  };
  if (!frames.length) return fail("no frames", null);
  const job = classify(frames, { surface, kind });
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error("timeout"), { code: "timeout" })), c.timeout_secs * 1000); });
  let v;
  try { v = await Promise.race([job.promise, timeout]); }
  catch (e) { return fail(e.code || e.message || "error", e.code === "timeout" ? job : null); }
  finally { clearTimeout(timer); }
  const d = decide(surface, v, { padAllowsNsfw, policy: c.policy });
  const id = await record({ ...base, hash: job.hash, mode: "enforce", action: d.action, would: d.action, flagged: d.flagged, v }, frames);
  if (d.action !== "allow" || d.flagged) console.log(`[imagesafety] ${surface}: ${v.verdict} [${v.categories.join(",") || "-"}] -> ${d.action}${d.flagged ? " +flag" : ""} (#${id})`);
  if (d.action === "refuse") return { ok: false, nsfw: false, reason: d.message, mode: "enforce", logId: id, flagged: d.flagged, action: d.action };
  return { ok: true, nsfw: d.action === "nsfw", mode: "enforce", logId: id, flagged: d.flagged, action: d.action };
}
/**
 * Start classifying an upload as soon as it's processed (fire and forget), so the post / story that uses it finds the
 * classification ready. Only while the surface is active; never in tests that didn't turn it on.
 */
async function prefetch(input = {}) {
  try {
    const c = await config();
    if (!active(c, input.surface) || c.shadow) return false;     // shadow mode classifies at the commit point
    const frames = await framesFor({ ...input, kind: input.kind === "video" ? "video" : "image" }, c.video_frames);
    if (!frames.length) return false;
    classify(frames, { surface: input.surface, kind: input.kind === "video" ? "video" : "image" });
    return true;
  } catch (e) { return false; }
}

// ── the hooks the upload surfaces already have (1.99es / 1.99ez) + the new ones ──
async function padAllowsNsfw(roomId) {
  if (!roomId) return true;
  try {
    const rooms = require("./rooms");
    if (rooms.isProfile && rooms.isProfile(roomId)) return true;
    const S = await require("./feedstore").roomSettings(roomId);
    return S.allow_nsfw !== false;
  } catch (e) { return true; }
}
/** Wire this module into padlook, userstories, feedstore (posts) and dmmedia. index.js calls it once. */
function install() {
  require("./padlook").setSafetyCheck(async ({ buf, still, kind, roomId, userId }) => {
    // (an animated avatar: its animated webp, so the first AND middle frames are looked at; still = its first frame)
    const r = await check({ surface: "pad_look", kind: "image", buf: buf || still, roomId, userId, ref: "pad:" + roomId + ":" + kind });
    return r.ok ? { ok: true } : { ok: false, nsfw: false, reason: r.reason };
  });
  require("./userstories").setSafetyCheck(async ({ file, kind, poster, secs, roomId, userId }) => {
    const r = await check({ surface: "story", kind, file, poster, secs, roomId, userId, ref: "story:" + roomId, padAllowsNsfw: await padAllowsNsfw(roomId) });
    return r.ok ? { ok: true, nsfw: !!r.nsfw } : { ok: false, reason: r.reason };
  });
  require("./feedstore").setMediaSafetyCheck(async ({ atts, roomId, userId }) => {
    const fm = require("./feedmedia");
    const allows = await padAllowsNsfw(roomId);
    // every file at once (a post's files share one wait); AI pictures: aigen's own post-check already ran
    const todo = atts.filter((a) => !a.ai_generated && (a.kind === "image" || a.kind === "video"));
    const rs = await Promise.all(todo.map((a) => check({ surface: "feed", kind: a.kind, file: fm.filePath(a.file), poster: a.poster ? fm.filePath(a.poster) : null,
                                                         secs: a.secs, roomId, userId, ref: "att:" + a.id, padAllowsNsfw: allows })));
    const bad = rs.find((r) => !r.ok);
    if (bad) return { ok: false, reason: bad.reason };
    return { ok: true, nsfw: rs.some((r) => r.nsfw) };
  });
  require("./dmmedia").setSafetyCheck(async ({ file, userId, ref }) => {
    const r = await check({ surface: "dm", kind: "image", file, userId, ref });
    return r.ok ? { ok: true, nsfw: !!r.nsfw } : { ok: false, reason: r.reason };
  });
}

// ── admin review ──
const REVIEWS = Object.freeze(["fp", "fn", "ok"]);
function rowView(r) {
  let cats = [], scores = {};
  try { cats = JSON.parse(r.categories || "[]"); } catch (e) { cats = []; }
  try { scores = JSON.parse(r.scores || "{}"); } catch (e) { scores = {}; }
  return { id: r.id, at: r.at, surface: r.surface, surfaceLabel: SURFACE_LABEL[r.surface] || r.surface, kind: r.kind, user: r.username || r.user_id || null,
           room: r.room_id, ref: r.ref, mode: r.mode, action: r.action, would: r.would, flagged: !!r.flagged, late: !!r.late, verdict: r.verdict,
           categories: cats, scores, confidence: r.confidence, reason: r.reason, model: r.model, cost: r.cost, ms: r.ms,
           thumb: r.thumb ? "/admin/imagesafety/thumb/" + r.id : null, review: r.review, reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at };
}
async function recent({ filter = "all", limit = 100 } = {}) {
  await init();
  const where = { flagged: "l.flagged = 1", blocked: "l.action IN ('refuse','nsfw','failclosed')", unchecked: "l.action IN ('failopen','failclosed')",
                  shadow: "l.mode = 'shadow'", unreviewed: "l.review IS NULL AND l.verdict IS NOT NULL" }[filter] || "1 = 1";
  const rows = await getQuery(`SELECT l.*, u.username FROM image_safety_log l LEFT JOIN users u ON u.userId = l.user_id WHERE ${where}
                               ORDER BY l.id DESC LIMIT ?`, [Math.min(500, Math.max(1, Number(limit) || 100))]);
  return rows.map(rowView);
}
async function stats(t = NOW()) {
  await init();
  const day = t - 86400e3;
  const r = (await getQuery(`SELECT COUNT(*) AS n, SUM(flagged) AS flagged, SUM(CASE WHEN action = 'refuse' THEN 1 ELSE 0 END) AS refused,
                             SUM(CASE WHEN action = 'nsfw' THEN 1 ELSE 0 END) AS marked, SUM(CASE WHEN action IN ('failopen','failclosed') THEN 1 ELSE 0 END) AS unchecked,
                             SUM(CASE WHEN review = 'fp' THEN 1 ELSE 0 END) AS fp, SUM(CASE WHEN review = 'fn' THEN 1 ELSE 0 END) AS fn,
                             SUM(cost) AS cost FROM image_safety_log WHERE at > ?`, [day]))[0] || {};
  return { day: { n: r.n || 0, flagged: r.flagged || 0, refused: r.refused || 0, marked: r.marked || 0, unchecked: r.unchecked || 0, fp: r.fp || 0, fn: r.fn || 0, cost: r.cost || 0 },
           queue: queueStats() };
}
async function review(id, mark, actor, note) {
  await init();
  const m = mark == null || mark === "" ? null : String(mark);
  if (m !== null && !REVIEWS.includes(m)) throw Object.assign(new Error("Mark it fp, fn or ok."), { status: 400 });
  const r = await runQuery("UPDATE image_safety_log SET review = ?, reviewed_by = ?, reviewed_at = ?, note = ? WHERE id = ?",
    [m, m ? String(actor || "?").slice(0, 60) : null, m ? NOW() : null, note ? String(note).slice(0, 300) : null, Number(id) || 0]);
  if (!r.changes) throw Object.assign(new Error("No such check."), { status: 404 });
  return rowView((await getQuery("SELECT * FROM image_safety_log WHERE id = ?", [Number(id)]))[0]);
}
async function sweep(t = NOW()) {
  await init();
  const c = await config();
  const cut = t - c.retention_days * 86400e3;
  const old = await getQuery("SELECT id, thumb FROM image_safety_log WHERE at < ?", [cut]);
  for (const r of old) { const p = thumbPath(r.thumb); if (p) { try { fs.unlinkSync(p); } catch (e) { /* gone */ } } }
  if (old.length) await runQuery("DELETE FROM image_safety_log WHERE at < ?", [cut]);
  expireJobs(t);
  return old.length;
}

// ── routes ──
const isAdmin = (u) => !!u && u.class === "Admin";
function register(app, { addUser, isBotToken, noTimers = false }) {
  const express = require("express");
  const json = express.json({ limit: "64kb" });
  const fail = (res, e) => {
    const st = e && e.status && e.status < 500 ? e.status : 500;
    if (st === 500) console.error("[imagesafety]", e);
    res.status(st).json({ ok: false, error: st === 500 ? "Something went wrong." : e.message });
  };
  const bot = (req, res, next) => {
    const tok = req.get("x-bot-token") || (req.body && typeof req.body.password === "string" ? req.body.password : "");
    if (!isBotToken(tok)) return res.status(403).json({ ok: false, error: "unauthorized" });
    next();
  };
  const sameSite = (req) => {
    const host = req.get("host"), src = req.get("origin") || req.get("referer");
    if (!src || !host) return true;
    try { return new URL(src).host === host; } catch (e) { return false; }
  };
  const admin = async (req) => {
    if (!req.user || !req.user.userId) return null;
    const u = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]))[0];
    return isAdmin(u) ? u : null;
  };
  const adminApi = async (req, res, next) => {
    if (!sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    if (!req.is("application/json")) return res.status(415).json({ ok: false, error: "JSON only." });
    const a = await admin(req).catch(() => null);
    if (!a) return res.status(403).json({ ok: false, error: "Admins only." });
    req.admin = a;
    next();
  };

  // Pepe: the long-poll + his classifications. While nothing is switched on, the pull answers at once with no work
  // (and an idle hint), so nothing is ever sent to Pepe.
  app.post("/api/pepe/imagesafety/pull", json, bot, async (req, res) => {
    try {
      const c = await config();
      const on = (c.enabled || c.shadow) && SURFACES.some((s) => c.surfaces[s]);
      if (!on) { LAST_PULL = NOW(); return res.json({ ok: true, enabled: false, jobs: [], idle: 60 }); }
      const wait = Math.min(PULL_WAIT_MAX, Math.max(0, Number((req.body || {}).wait) * 1000 || 0));
      res.json({ ok: true, enabled: true, jobs: await pull(wait), categories: CATEGORIES });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/pepe/imagesafety/verdict", json, bot, async (req, res) => {
    try { res.json({ ok: true, waiting: await result(req.body || {}) }); } catch (e) { fail(res, e); }
  });

  // admins: the review page, its thumbnails, the settings, the review marks
  app.get("/admin/imagesafety", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login");
    try {
      const a = await admin(req);
      res.set("Cache-Control", "no-store");
      res.set("X-Robots-Tag", "noindex");
      if (!a) return res.status(403).render("notFound", { user: req.user.username, heading: "Admins only", message: "The image safety review page is for site admins.", title: "Admins only" });
      const filter = ["all", "flagged", "blocked", "unchecked", "shadow", "unreviewed"].includes(req.query.f) ? req.query.f : "all";
      const C = await config();
      res.render("admin/imagesafety", { user: a.username, isAdmin: true, C, S: settingsView(C), rows: await recent({ filter }), filter, stats: await stats(),
                                        SURFACES, SURFACE_LABEL, CATEGORIES, POLICY_KEYS, ACTIONS, DEFAULTS, SETTING_NAMES });
    } catch (e) { console.error("[imagesafety] page:", e); res.status(500).send("Something went wrong."); }
  });
  app.get("/admin/imagesafety/thumb/:id", addUser, async (req, res) => {
    try {
      const a = await admin(req);
      if (!a) return res.status(404).end();
      await init();
      const r = (await getQuery("SELECT thumb, surface FROM image_safety_log WHERE id = ?", [Number(req.params.id) || 0]))[0];
      const p = r && thumbPath(r.thumb);
      if (!p || !fs.existsSync(p)) return res.status(404).end();
      if (r.surface === "dm") console.log(`[imagesafety] admin ${a.username} viewed DM check #${req.params.id}'s thumbnail`);
      res.set({ "Content-Type": "image/webp", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
                "Cross-Origin-Resource-Policy": "same-origin", "Content-Security-Policy": "default-src 'none'; sandbox", "X-Robots-Tag": "noindex" });
      res.send(fs.readFileSync(p));
    } catch (e) { res.status(500).end(); }
  });
  app.post("/api/admin/imagesafety/settings", addUser, json, adminApi, async (req, res) => {
    try { const C = await setConfig((req.body || {}).settings || {}, req.admin.username); res.json({ ok: true, settings: settingsView(C) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/admin/imagesafety/review/:id", addUser, json, adminApi, async (req, res) => {
    try { const b = req.body || {}; res.json({ ok: true, row: await review(req.params.id, b.mark, req.admin.username, b.note) }); } catch (e) { fail(res, e); }
  });
  app.get("/api/admin/imagesafety/recent", addUser, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const a = await admin(req).catch(() => null);
    if (!a) return res.status(403).json({ ok: false, error: "Admins only." });
    try { res.json({ ok: true, rows: await recent({ filter: String(req.query.f || "all") }), stats: await stats() }); } catch (e) { fail(res, e); }
  });

  if (!noTimers) {
    const t = setInterval(() => { sweep().catch((e) => console.error("[imagesafety] sweep:", e.message)); }, 3600e3);
    if (t.unref) t.unref();
  }
}

function _reset() { JOBS.clear(); CACHE.clear(); PULLERS.length = 0; CFG = null; CLASSIFIER = null; }

module.exports = {
  init, register, install, check, prefetch, decide, cleanVerdict, cleanConfig, config, setConfig, settingsView, active, framesFor, hashFrames,
  enqueue, pull, result, queueStats, setClassifier, recent, stats, review, sweep, padAllowsNsfw, thumbPath, dir, _setDir, _setClock, _reset,
  SURFACES, SURFACE_LABEL, GROUP, CATEGORIES, POLICY_KEYS, ACTIONS, DEFAULTS, DEFAULT_POLICY, SETTING_NAMES, PULL_WAIT_MAX, CLAIM_TTL, LATE_MS,
};
