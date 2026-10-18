// onairmedia.js — 📺 pictures and links on Pepe's OBS (1.99acw). onair.js owns the picks (the main lane TARGET and the corner
// lane OVERLAY, the switches, the queue, the audit); this module is the media pipeline behind them:
//
//   * PICTURES ("!onair image <link> …", the bar's 🖼 Image tab): the SITE fetches the link through the SSRF-safe fetcher
//     the feed's link previews use (linkpreview.safeGet: http(s) only, public addresses only - every DNS answer and every
//     redirect hop re-checked, the socket pinned to the checked address), or takes a chunked feed upload (purpose "onair").
//     PNG / JPEG / GIF / WebP only (by magic bytes), at most max_image_mb, 8192 px a side, 60 megapixels counting every frame,
//     200 frames and a 20 s loop. It is RE-ENCODED to webp (no EXIF / GPS / XMP / ICC, orientation baked in, <= 1920x1080 or
//     1280 px for an animation), then the re-encoded file goes through imagesafety.checkBroadcast (Pepe's vision; always
//     enforcing, fail-closed, only "clearly safe" passes - the stream is relayed to Twitch). A passed picture is stored here
//     (ONAIR_MEDIA_DIR, outside the code tree) and served from publicaccess.tv only (/onair/m/<32hex>.webp), so OBS never
//     loads it from the original host (Pepe's home IP stays hidden) and it can't change after the check. A refused picture
//     is remembered by its sha256 for 30 days (refused at once next time, no second vision call) and by its link for an hour.
//   * DIRECT PICTURES ("… direct", the "Load directly (staff)" toggle; locked capability onair.direct_media + Pepe's real
//     staff role + Pepe's "direct" cap, which he only sends once his VM's firewall attestation is set - a rebinding host passes
//     both name checks and then resolves to the LAN for OBS): NO proxy and NO scan. Still http(s) only, a public host
//     (resolved here; Pepe re-checks the FIRST hop on his VM - only the VM firewall covers the rest), a short
//     type probe (the first 64 KB must be a picture - an HTML page / 404 is caught before air), the URL length cap; OBS loads
//     it straight from its site inside our show page, whose CSP allows exactly that one origin.
//   * LINK CARDS ("!onair link <link>", the 🔗 Link tab): the feed's link-preview data (title, description, site name, the
//     page's picture and favicon) rendered by our own show page. The page's text goes through textguard + the feed filter's
//     categories + the broadcast explicit-terms list (a hit refuses the card); its picture and favicon are proxied + scanned
//     like any picture (not clearly safe -> the WHOLE card is refused; a format / fetch problem -> the card goes on without
//     it). ICO / SVG favicons are never decoded (a letter badge instead).
//   * LIVE PAGES ("… live", locked capability onair.live_page + Pepe's real staff role + the live_pages switch (off by default
//     everywhere) + Pepe's "live" cap - he sends it only with his VM firewall attestation, his admin panel's login on and an
//     OBS websocket password): the page itself in OBS (Pepe's VM loads it - his home IP), checked here (public host, not one of
//     the site's own hosts or live_deny) and again on the VM by Pepe (the first hop only: the page can redirect or frame
//     anything afterwards - the VM firewall is what keeps it off the LAN).
//
// Media requests are JOBS (fetch + re-encode + Pepe's vision can take ~25 s; Pepe's poll waits 8 s): at most 2 in flight
// site-wide and 1 per person, kept 10 minutes. The caller gets the answer at once when the job ends within RACE_MS (3 s),
// else a job id to poll (chat: Pepe polls {action: "job"}; web: GET /api/stage/admin/onair/job/:id).
//
// 1.99acw review fixes:
//   * what is CHECKED is what goes ON AIR: a picture is flattened onto the show page's frame colour (imagesafety.BROADCAST_BG)
//     when it's stored (no alpha channel survives) and classified the same way; an animation has EVERY distinct frame
//     classified (imagesafety.broadcastFrames - more than 36 different frames is refused), never a few sampled by index. Two
//     frames count as one only when every pixel of every channel is within 12 of each other (no coarse statistics).
//   * link cards: a page whose own picture (or favicon) isn't clearly safe is refused as a whole (the strongest hint the page is
//     adult); a broadcast-only explicit-terms list (data/onair-explicit.json: sexual / porn words, adult domains and TLDs) runs
//     over captions, the card's title / description / site / domain and the final host; captions can't carry a link-shaped word.
//   * BLOCK: "Cut + block" (the bar, `!onair off block`, the recent-pictures list, an image-safety "fn" mark on an on-air check)
//     sets the stored picture to status "blocked" (never served or reused again), deletes the file and remembers its hash and
//     its link for good (onair_refused.blocked; the sweep keeps those rows).
//   * every attempt is a row in onair_attempts (the rate limit - one bucket per PERSON: a chat login linked to a site account
//     shares it with the web - survives restarts); a refused picture is in onair_log ("refused": who, the link, the code, the
//     safety check's log id); 3 unsafe refusals in 24 h block that person's media requests for 24 h, a possible-minor flag
//     blocks them at once (30 days, until an admin lifts it) - both with an inbox notice to the admins.
"use strict";
const fs = require("fs");
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const { runQuery, getQuery } = require("./dbUtils");

const STAGING = !!process.env.STAGING;
const LP = () => require("./linkpreview");
const FM = () => require("./feedmedia");
const ISF = () => require("./imagesafety");
const TG = () => require("./textguard");
const TS = () => require("./textscan");

const FORMATS = Object.freeze(["jpeg", "png", "gif", "webp"]);
const MAX_PIXELS = 60e6, MAX_SIDE = 8192, MAX_FRAMES = 200, MAX_LOOP_MS = 20000;
const STILL_W = 1920, STILL_H = 1080, ANIM_PX = 1280;
const CAPTION_MAX = 120;
const ICON_MAX = 256 * 1024;
const PROBE_MAX = 64 * 1024;
const MIN_SECS = 5;
const DIRECT_HARD_MAX_S = 300;           // a direct picture is never up longer, whatever direct_max_s says
const JOB_KEEP_MS = 10 * 60 * 1000, JOBS_SITE = 2, JOBS_ACTOR = 1, RACE_MS = 3000;
const REUSE_MS = 24 * 3600 * 1000, KEEP_MS = 30 * 86400 * 1000, URL_REFUSED_MS = 3600 * 1000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const STRIKE_WINDOW_MS = 24 * 3600 * 1000, STRIKES = 3, STRIKE_BLOCK_MS = 24 * 3600 * 1000, MINOR_BLOCK_MS = 30 * 86400 * 1000;
const ACCEPT = "image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8";
const FILE_RE = /^[a-f0-9]{32}\.webp$/;
// a link-shaped first word: a domain (scheme optional), or an IPv4 address with its scheme (checkUrl / resolvePublic still decide)
const URLISH = /^((https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}|https?:\/\/(\d{1,3}\.){3}\d{1,3})([/:?#]|$)/i;
const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i;
const CORNERS = Object.freeze(["tl", "tr", "bl", "br"]);
const OWN_HOSTS = Object.freeze(["publicaccess.tv", "www.publicaccess.tv", "staging.publicaccess.tv"]);
const TEXT_CATS = Object.freeze(["hate", "threats", "selfharm", "doxxing"]);
// control characters + zero-width / bidi overrides (a caption is one plain line)
const JUNK = new RegExp("[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]", "g");
const MODE_WORDS = Object.freeze({ image: "image", img: "image", pic: "image", picture: "image", photo: "image",
                                   link: "link", page: "link", card: "link", site: "link" });

const MSG = Object.freeze({
  not_picture: "That link isn't a picture - PNG, JPEG, GIF or WebP only.",
  page: "That link is a page, not a picture - try !onair link <link> (or the 🔗 Link tab).",
  rights_chat: "Add \"rights\" to confirm you may rebroadcast it (it goes out on Pepe's stream and his Twitch relay)",
  rights_web: "Tick \"I have the rights to rebroadcast this\" first - it goes out on Pepe's stream and his Twitch relay.",
  card_text: "That page's text can't go on Pepe's stream.",
  card_unsafe: "That page's own picture isn't clearly safe, so its card can't go on Pepe's stream (it's relayed to Twitch).",
  caption: "That caption can't go on Pepe's stream.",
  adult: "That site can't go on Pepe's stream (adult content - his stream is relayed to Twitch).",
  blocked: "That was blocked by staff for Pepe's stream.",
  person_blocked: "You can't put pictures or links on Pepe's stream right now (some of yours weren't safe for it) - an admin can lift that.",
});

let clock = () => Date.now();
const now = () => clock();

class MediaError extends Error {
  constructor(status, msg, code, extra) { super(msg); this.status = status || 400; this.refuse = true; this.code = code || "media"; Object.assign(this, extra || {}); }
}
/** extra: {logId (the image safety check), minor (a possible-minor flag)} - kept for the audit + the strike count */
const refuse = (msg, code = "media", status = 400, extra) => new MediaError(status, msg, code, extra);

// ── storage ──
function pickDir() {
  if (process.env.ONAIR_MEDIA_DIR) return path.resolve(process.env.ONAIR_MEDIA_DIR);
  if (process.platform === "linux") {
    const d = STAGING ? "/var/lib/patv-staging/onair" : "/var/lib/patv/onair";
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (e) { /* not root: below */ }
  }
  return path.resolve(__dirname, "..", path.basename(__dirname) + "-onair");      // outside the code tree, next to it
}
let DIR = null;
function dir() { if (!DIR) { DIR = pickDir(); fs.mkdirSync(DIR, { recursive: true }); } return DIR; }
function _setDir(d) { DIR = path.resolve(d); fs.mkdirSync(DIR, { recursive: true }); }
function filePath(name) { return FILE_RE.test(String(name || "")) ? path.join(dir(), String(name)) : null; }
const rm = (p) => { if (p) { try { fs.unlinkSync(p); } catch (e) { /* gone */ } } };
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS onair_media (id TEXT PRIMARY KEY, file TEXT NOT NULL, w INTEGER, h INTEGER, bytes INTEGER,
                      frames INTEGER, loop_ms INTEGER, src_kind TEXT, src_url TEXT, src_host TEXT, sha256 TEXT, safety_log INTEGER, by TEXT,
                      created INTEGER NOT NULL, last_used INTEGER, status TEXT NOT NULL DEFAULT 'ready')`);
      await runQuery("CREATE INDEX IF NOT EXISTS onair_media_src ON onair_media (src_url, created)");
      await runQuery("CREATE INDEX IF NOT EXISTS onair_media_sha ON onair_media (sha256)");
      await runQuery("CREATE TABLE IF NOT EXISTS onair_refused (sha256 TEXT PRIMARY KEY, at INTEGER NOT NULL, reason TEXT)");
      // 1.99acw review: blocked by staff = for good (the sweep keeps it); a blocked LINK is a row keyed "url:<sha256 of the link>"
      for (const col of ["blocked INTEGER NOT NULL DEFAULT 0", "by TEXT", "src TEXT"]) {
        try { await runQuery(`ALTER TABLE onair_refused ADD COLUMN ${col}`); } catch (e) { /* already there */ }
      }
      // every media attempt (the per-person rate limit + the unsafe-refusal count), and people blocked from media
      await runQuery(`CREATE TABLE IF NOT EXISTS onair_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, who TEXT NOT NULL,
                      via TEXT, by TEXT, mode TEXT, url TEXT, state TEXT, code TEXT, log_id INTEGER, minor INTEGER NOT NULL DEFAULT 0)`);
      await runQuery("CREATE INDEX IF NOT EXISTS onair_attempts_who ON onair_attempts (who, at)");
      await runQuery(`CREATE TABLE IF NOT EXISTS onair_person_blocks (who TEXT PRIMARY KEY, until INTEGER NOT NULL, why TEXT, at INTEGER NOT NULL,
                      by TEXT, label TEXT)`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
const assetOf = (r) => ({ id: r.id, file: r.file, w: Number(r.w) || 0, h: Number(r.h) || 0, animated: Number(r.frames) > 1,
                          host: r.src_host || (r.src_kind === "upload" ? "an upload" : null) });
/** The on-disk path of a stored (ready) picture, else null. */
async function assetFile(name) {
  if (!FILE_RE.test(String(name || ""))) return null;
  await init();
  const r = (await getQuery("SELECT file FROM onair_media WHERE file = ? AND status = 'ready'", [String(name)]))[0];
  const p = r ? filePath(r.file) : null;
  return p && fs.existsSync(p) ? p : null;
}
async function touch(ids, t = now()) {
  await init();
  for (const id of ids || []) if (id) await runQuery("UPDATE onair_media SET last_used = ? WHERE id = ? OR file = ?", [t, String(id), String(id)]);
}

// ── text: captions and card text ──
function oneLine(s) { return String(s == null ? "" : s).normalize("NFC").replace(JUNK, " ").replace(/\s+/g, " ").trim(); }
const clip = (s, n) => { const t = oneLine(s); return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t; };
// ── 1.99acw review: the broadcast-only explicit-terms list (data/onair-explicit.json, base64 JSON - not plain text in this public
// repo). Words match whole tokens of the feed filter's normalised text (look-alikes / accents / invisible characters folded),
// as typed and with leetspeak folded; "x*" = a prefix; letters spaced out ("p o r n") are joined and checked too; repeated
// letters are collapsed for terms of 4+ letters. Phrases match whole words in order. Hosts: adult domains (+ subdomains), adult
// TLDs, and the host's own labels through the word list (a "free-porn-site.example" is caught by its name).
let EXPLICIT = null;
function explicitLists() {
  if (EXPLICIT) return EXPLICIT;
  let raw = { words: [], phrases: [], domains: [], tlds: [] };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "onair-explicit.json"), "utf8"));
    raw = JSON.parse(Buffer.from((j.data || []).join(""), "base64").toString("utf8"));
  } catch (e) { console.error("[onairmedia] explicit list:", e.message); raw = null; }
  const collapse = (w) => w.replace(/([a-z])\1+/g, "$1");
  const exact = new Set(), prefix = [];
  for (const e of (raw && raw.words) || []) {
    const w = String(e).toLowerCase();
    if (w.endsWith("*")) prefix.push(w.slice(0, -1)); else exact.add(w);
  }
  EXPLICIT = { ok: !!raw, exact, prefix, collapse,
               exactC: new Set([...exact].filter((w) => w.length >= 4).map(collapse)), prefixC: prefix.filter((w) => w.length >= 4).map(collapse),
               phrases: ((raw && raw.phrases) || []).map((p) => " " + String(p).toLowerCase().trim().replace(/\s+/g, " ") + " "),
               domains: ((raw && raw.domains) || []).map((d) => String(d).toLowerCase()), tlds: new Set(((raw && raw.tlds) || []).map((t) => String(t).toLowerCase())) };
  return EXPLICIT;
}
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", "@": "a", $: "s", "!": "i", "|": "i", "+": "t" };
function tokensOf(text) {
  let t = String(text == null ? "" : text);
  try { t = require("./feedfilter").normalize(t); } catch (e) { t = t.normalize("NFKC").toLowerCase(); }
  const raw = t.split(/[^a-z0-9]+/).filter(Boolean);
  const folded = t.replace(/[013457@$!|+]/g, (c) => LEET[c] || c).split(/[^a-z]+/).filter(Boolean);
  const joined = [];                                       // "p o r n" / "p.o.r.n" -> "porn"
  let run = [];
  for (const w of folded.concat([""])) {
    if (w.length === 1) { run.push(w); continue; }
    if (run.length >= 3) joined.push(run.join(""));
    run = [];
  }
  return { raw, folded, joined };
}
/** true when text holds an explicit term (or the list can't be read: fail closed). */
function explicitText(text) {
  const L = explicitLists();
  const s = String(text == null ? "" : text);
  if (!s.trim()) return false;
  if (!L.ok) return true;
  const { raw, folded, joined } = tokensOf(s);
  const hit = (w) => L.exact.has(w) || L.prefix.some((p) => w.startsWith(p)) ||
    (w.length >= 4 && (L.exactC.has(L.collapse(w)) || L.prefixC.some((p) => L.collapse(w).startsWith(p))));
  if (raw.some(hit) || folded.some(hit) || joined.some(hit)) return true;
  const line = " " + folded.join(" ") + " ", lineRaw = " " + raw.join(" ") + " ";
  return L.phrases.some((p) => line.includes(p) || lineRaw.includes(p));
}
/** true when a host is an adult site: a listed domain (or under one), an adult TLD, or explicit words in its labels. */
function adultHost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h || net.isIP(h)) return false;
  const L = explicitLists();
  if (!L.ok) return true;
  const tld = h.split(".").pop();
  if (L.tlds.has(tld)) return true;
  if (L.domains.some((d) => h === d || h.endsWith("." + d))) return true;
  return explicitText(h.split(".").slice(0, -1).join(" "));
}
/** true when text trips textguard (slurs, minors, threats, scams, fake staff, phone numbers, addresses, pad codes), the
 *  feed filter's hate / threats / selfharm / doxxing categories, or (1.99acw review) the broadcast explicit-terms list.
 *  A filter that can't run counts as a hit (fail closed). */
function textBad(text) {
  const t = String(text == null ? "" : text);
  if (!t.trim()) return false;
  if (TG().bad(t) || TG().hasPadCode(t)) return true;
  if (explicitText(t)) return true;
  let hits = [];
  try { hits = TS().scanText(t); } catch (e) { console.error("[onairmedia] text scan:", e.message); return true; }
  return hits.some((h) => TEXT_CATS.includes(h.cat));
}
function cleanCaption(s) {
  if (s == null) return null;
  const t = oneLine(s);
  if (!t) return null;
  if (t.length > CAPTION_MAX) throw refuse(`Captions can be up to ${CAPTION_MAX} characters.`, "caption");
  // no links: a scheme / www., or any link-shaped word ("example.com", "evil.example/x") - it would advertise a site on stream
  if (/https?:|www\./i.test(t) || t.split(/\s+/).some((w) => URLISH.test(w.replace(/^[("'“‘[<]+|[)"'”’\]>.,!?;:]+$/g, "")))) {
    throw refuse("No links in the caption.", "caption");
  }
  if (textBad(t)) throw refuse(MSG.caption, "caption");
  return t;
}

// ── links ──
function checkUrl(input) {
  try { return LP().checkUrl(input); } catch (e) { throw refuse((e && e.message) || "That doesn't look like a link.", "bad_link"); }
}
function fromPreview(e, maxMb) {
  if (e && e.refuse) return e;
  if (e && e.code === "size") return refuse(`That picture is bigger than ${maxMb || 8} MB.`, "too_big", 413);
  return refuse((e && e.message) || "Couldn't load that link.", (e && e.code) || "fetch");
}
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^\[|\]$/g, "").toLowerCase(); } catch (e) { return null; } };

// ── durations (chat "for 30s", "for 2m", "for 1m30s", "for 90", "for 10min"; the web sends seconds) ──
const UNIT_S = /^(s|sec|secs|second|seconds)$/, UNIT_M = /^(m|min|mins|minute|minutes)$/;
function parseDur(s) {
  const t = String(s == null ? "" : s).toLowerCase().trim();
  let m = /^(\d{1,4})(s|sec|secs|seconds?)?$/.exec(t);
  if (m) return Number(m[1]);
  m = /^(\d{1,3})(m|min|mins|minutes?)$/.exec(t);
  if (m) return Number(m[1]) * 60;
  m = /^(\d{1,3})m(?:in)?(\d{1,2})s?$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  return null;
}
function fmtDur(secs) {
  const s = Math.max(0, Math.round(Number(secs) || 0));
  if (s < 60) return s + " s";
  const m = Math.floor(s / 60), r = s % 60;
  return m + " min" + (r ? " " + r + " s" : "");
}
/** {mode, direct} + the wanted seconds (null = the default) + the on-air config -> {secs, clamped, max}. */
function secsFor({ mode, direct }, want, cfg = {}) {
  const max = direct ? Math.min(Number(cfg.direct_max_s) || 120, DIRECT_HARD_MAX_S)
    : mode === "live" ? Number(cfg.live_max_s) || 600 : Number(cfg.media_max_s) || 600;
  const def = Math.min(max, mode === "live" ? Number(cfg.live_secs) || 60 : Number(cfg.media_secs) || 30);
  let s = want == null || want === "" ? def : Math.round(Number(want));
  if (!Number.isFinite(s)) s = def;
  let clamped = false;
  if (s > max) { s = max; clamped = true; }
  if (s < MIN_SECS) { s = MIN_SECS; clamped = true; }
  return { secs: s, clamped, max };
}

// ── the chat grammar (one place: Pepe only spots direct / live for his own real-role gate) ──
//   !onair image <link> [caption…] [options…] rights      !onair link <link> [caption…] [options…] rights
//   options (whole words, any order, after the caption): for <dur> · full · corner [tl|tr|bl|br] · tl|tr|bl|br · direct
//   (pictures) · live (links) · with sound | sound (live) · rights (required). A quoted caption ("…" or “…”) is literal; then
//   every other leftover word must be an option.
function parseOptions(tokens) {
  const o = { rights: false, full: false, corner: null, cornerWord: false, direct: false, live: false, sound: false, secs: null };
  for (let i = 0; i < tokens.length; i++) {
    const w = String(tokens[i]).toLowerCase().replace(/[.,!;:]+$/, "");
    const nx = String(tokens[i + 1] || "").toLowerCase();
    if (w === "rights") o.rights = true;
    else if (w === "full" || w === "fullscreen") o.full = true;
    else if (w === "corner") { o.cornerWord = true; if (CORNERS.includes(nx)) { o.corner = nx; i++; } }
    else if (CORNERS.includes(w)) o.corner = w;
    else if (w === "direct") o.direct = true;
    else if (w === "live") o.live = true;
    else if (w === "sound") o.sound = true;
    else if (w === "with" && nx === "sound") { o.sound = true; i++; }
    else if (w === "for" && i + 1 < tokens.length) {
      let d = parseDur(nx);
      const unit = String(tokens[i + 2] || "").toLowerCase();
      if (d != null && /^\d+$/.test(nx) && (UNIT_S.test(unit) || UNIT_M.test(unit))) { d = UNIT_M.test(unit) ? Number(nx) * 60 : Number(nx); i++; }
      if (d == null) return { bad: tokens[i] + " " + tokens[i + 1] };
      o.secs = d; i++;
    } else return { bad: tokens[i] };
  }
  return o;
}
/** Chat words after `!onair image|link` -> a clean spec (validateSpec's shape). Throws MediaError with the usage / reason. */
function parseChat(modeWord, words, cfg = {}) {
  const mode0 = MODE_WORDS[String(modeWord || "").toLowerCase()];
  const usage = mode0 === "link" ? "!onair link <link> [caption] [live] [with sound] [for 60s] [corner] rights"
    : "!onair image <link> [caption] [for 30s] [corner] [direct] rights";
  if (!mode0) throw refuse("usage: !onair image <link> … rights · !onair link <link> … rights", "usage");
  const toks = (Array.isArray(words) ? words : String(words == null ? "" : words).split(/\s+/)).map((x) => String(x).trim()).filter(Boolean);
  const first = toks[0] || "";
  if (!first || !URLISH.test(first)) throw refuse((mode0 === "link" ? "Which page? " : "Which picture? ") + usage, "which");
  const rest = toks.slice(1);
  let caption = null, opts = null;
  const joined = rest.join(" ");
  const q = /["“”]([^"“”]*)["“”]/.exec(joined);
  if (q) {
    caption = q[1];
    const left = (joined.slice(0, q.index) + " " + joined.slice(q.index + q[0].length)).split(/\s+/).filter(Boolean);
    opts = parseOptions(left);
    if (opts.bad) throw refuse(`I didn't understand '${clip(opts.bad, 40)}'. ${usage}`, "usage");
  } else {
    for (let k = 0; k <= rest.length; k++) {
      const o = parseOptions(rest.slice(k));
      if (!o.bad) { opts = o; caption = rest.slice(0, k).join(" "); break; }
    }
  }
  if (mode0 === "image" && opts.live) throw refuse("\"live\" is for links: !onair link <link> live … rights", "contradiction");
  if (mode0 === "link" && opts.direct) throw refuse("\"direct\" is for pictures - a link goes on as a card, or as a live page with \"live\".", "contradiction");
  if (opts.sound && !(mode0 === "link" && opts.live)) throw refuse("\"with sound\" only goes with a live page (!onair link <link> live with sound … rights). Quote the caption (\"…\") if those words are part of it.", "contradiction");
  if (opts.full && (opts.corner || opts.cornerWord)) throw refuse("Full or corner - not both.", "contradiction");
  if (!opts.rights) throw refuse(`${MSG.rights_chat}: !onair ${mode0} <link> … rights`, "rights");
  return validateSpec({ mode: mode0 === "image" ? "image" : opts.live ? "live" : "card", url: first, direct: opts.direct, sound: opts.sound,
                        layout: opts.corner || opts.cornerWord ? "corner" : "full", corner: opts.corner || "tr", caption: caption || null,
                        secs: opts.secs, rights: true }, cfg);
}
/**
 * A request (the web body, or parseChat's) -> {mode: image|card|live, url, upload, direct, sound, lane: main|corner, corner, caption,
 * secs, clamped, rights}. Throws MediaError. No network here (that's the job).
 */
function validateSpec(b, cfg = {}) {
  b = b && typeof b === "object" ? b : {};
  const mode = ["image", "card", "live"].includes(b.mode) ? b.mode : null;
  if (!mode) throw refuse("Pick a picture, a link card or a live page.", "bad");
  if (b.direct === true && mode !== "image") throw refuse("Only a picture can be loaded directly.", "bad");
  if (b.sound === true && mode !== "live") throw refuse("\"With sound\" only goes with a live page.", "bad");
  const direct = b.direct === true;
  const upload = b.upload != null && b.upload !== "" ? String(b.upload) : null;
  if (upload && mode !== "image") throw refuse("Only a picture can be uploaded.", "bad");
  if (upload && !/^[a-f0-9]{24}$/.test(upload)) throw refuse("That upload isn't valid.", "bad");
  if (upload && direct) throw refuse("An uploaded picture is always checked - it can't be loaded directly.", "bad");
  const url = upload ? null : checkUrl(b.url).toString();
  if (url && adultHost(hostOf(url))) throw refuse(MSG.adult, "adult", 422);
  if (b.rights !== true) throw refuse(MSG.rights_web, "rights");
  const lane = b.lane === "corner" || b.layout === "corner" ? "corner" : "main";
  const corner = lane === "corner" ? (CORNERS.includes(b.corner) ? b.corner : "tr") : null;
  const caption = cleanCaption(b.caption);
  const s = secsFor({ mode, direct }, b.secs, cfg);
  return { mode, url, upload, direct, sound: mode === "live" && b.sound === true, lane, corner, caption, secs: s.secs, clamped: s.clamped, rights: true };
}

// ── pictures ──
const URL_REFUSED = new Map();          // link -> {at, reason}: a picture refused in the last hour is refused at once
/** Re-encode + check + store one picture (a Buffer or a file path of a sniffed jpeg/png/gif/webp). -> asset. Throws MediaError. */
async function ingestBuffer(input, fmt, meta = {}) {
  await init();
  if (!FORMATS.includes(fmt)) throw refuse(MSG.not_picture, "type");
  const sharp = require("sharp");
  let md;
  try { md = await sharp(input, { limitInputPixels: MAX_PIXELS, animated: fmt === "gif" || fmt === "webp" }).metadata(); }
  catch (e) { throw refuse(/pixel/i.test(String(e && e.message)) ? "That picture is too big (60 megapixels at most)." : "That picture couldn't be read.", "unreadable"); }
  if (!md || md.format !== fmt) throw refuse("That picture's contents don't match its type.", "type");
  const pages = Math.max(1, Number(md.pages) || 1);
  const w = Number(md.width) || 0;
  const ph = Number(md.pageHeight) || (pages > 1 ? Math.round((Number(md.height) || 0) / pages) : Number(md.height) || 0);
  if (!w || !ph) throw refuse("That picture couldn't be read.", "unreadable");
  if (w > MAX_SIDE || ph > MAX_SIDE) throw refuse(`Pictures can be at most ${MAX_SIDE} pixels on a side.`, "dims");
  if (w * ph * pages > MAX_PIXELS) throw refuse("That picture is too big (60 megapixels at most, every frame counted).", "dims");
  if (pages > MAX_FRAMES) throw refuse(`Animations can have up to ${MAX_FRAMES} frames.`, "frames");
  const delays = Array.isArray(md.delay) ? md.delay : [];
  let loop = 0;
  if (pages > 1) for (let i = 0; i < pages; i++) { const d = Number(delays[i]); loop += d > 10 ? d : 100; }   // 0 / 10 ms play as 100 ms
  if (loop > MAX_LOOP_MS) throw refuse(`Animations can loop for at most ${MAX_LOOP_MS / 1000} s (that one is ${(loop / 1000).toFixed(1)} s).`, "loop");
  const anim = pages > 1;
  const name = crypto.randomBytes(16).toString("hex") + ".webp";
  const out = path.join(dir(), name);
  let info;
  try {
    info = await sharp(input, { limitInputPixels: MAX_PIXELS, animated: anim })
      .rotate()                                                 // bake EXIF orientation in (no metadata is written)
      .resize({ width: anim ? ANIM_PX : STILL_W, height: anim ? ANIM_PX : STILL_H, fit: "inside", withoutEnlargement: true })
      // 1.99acw review: opaque on the show page's own frame colour (every page of an animation too) - what's stored, checked and
      // shown is the same picture (content hidden in the alpha channel was blank on white for the check, visible on air)
      .flatten({ background: ISF().BROADCAST_BG })
      .webp({ quality: 82, effort: 4 }).timeout({ seconds: 20 }).toFile(out);
  } catch (e) { rm(out); throw refuse("That picture couldn't be processed.", "unreadable"); }
  const buf = fs.readFileSync(out);
  const sha = sha256(buf);
  const bad = (await getQuery("SELECT reason, at, blocked FROM onair_refused WHERE sha256 = ?", [sha]))[0];
  if (bad && (Number(bad.blocked) || now() - Number(bad.at) < KEEP_MS)) {
    rm(out);
    throw refuse(Number(bad.blocked) ? MSG.blocked : bad.reason || ISF().BROADCAST_REFUSED, Number(bad.blocked) ? "blocked" : "unsafe", 422);
  }
  const same = (await getQuery("SELECT * FROM onair_media WHERE sha256 = ? AND status = 'ready' ORDER BY created DESC LIMIT 1", [sha]))[0];
  if (same && filePath(same.file) && fs.existsSync(filePath(same.file))) { rm(out); return assetOf(same); }
  if (meta.onCheck) meta.onCheck();
  let chk;
  // (the bytes, not the path: libvips keeps a file it opened cached - on Windows that would block deleting a refused one)
  // ref = who asked ("onair:<by>"), src = where it came from - the image safety log row names both (the CSAM procedure)
  const ref = ("onair:" + String(meta.by || "?")).slice(0, 80);
  const src = meta.src_url ? String(meta.src_url).slice(0, 2048) : meta.src_kind === "upload" ? "upload" + (meta.upload ? ":" + meta.upload : "") : null;
  try { chk = await ISF().checkBroadcast({ buf, userId: meta.userId || null, ref, src, background: ISF().BROADCAST_BG }); }
  catch (e) { console.error("[onairmedia] safety:", e && e.message); chk = { ok: false, code: "unavailable", reason: "The picture couldn't be safety-checked right now - nothing was shown." }; }
  if (!chk.ok) {
    rm(out);
    if (chk.code === "unsafe") {
      await runQuery(`INSERT INTO onair_refused (sha256, at, reason, src) VALUES (?, ?, ?, ?)
                      ON CONFLICT(sha256) DO UPDATE SET at = excluded.at, reason = excluded.reason`, [sha, now(), String(chk.reason || "").slice(0, 300), src]);
    }
    const code = chk.code === "unsafe" ? "unsafe" : chk.code === "frames" ? "frames" : "unchecked";
    throw refuse(chk.reason || ISF().BROADCAST_REFUSED, code, 422, { logId: chk.logId || null, minor: !!chk.minor });
  }
  const h = anim ? Number(info.pageHeight) || Math.round(Number(info.height) / pages) : Number(info.height);
  const row = { id: "a" + crypto.randomBytes(8).toString("hex"), file: name, w: Number(info.width) || 0, h: h || 0, bytes: buf.length, frames: pages, loop_ms: loop,
                src_kind: meta.src_kind || "url", src_url: meta.src_url ? String(meta.src_url).slice(0, 2048) : null, src_host: meta.src_host || null,
                sha256: sha, safety_log: chk.logId || null, by: meta.by ? String(meta.by).slice(0, 80) : null, created: now() };
  await runQuery(`INSERT INTO onair_media (id, file, w, h, bytes, frames, loop_ms, src_kind, src_url, src_host, sha256, safety_log, by, created, status)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')`,
    [row.id, row.file, row.w, row.h, row.bytes, row.frames, row.loop_ms, row.src_kind, row.src_url, row.src_host, row.sha256, row.safety_log, row.by, row.created]);
  return assetOf(row);
}
/** A picture from a link: fetched through the SSRF-safe fetcher, re-encoded, scanned, stored. -> asset. */
async function fetchImage(url, { by = null, userId = null, maxMb = 8, lookup, onCheck, timeoutMs } = {}) {
  await init();
  const u = checkUrl(url);
  const key = u.toString();
  const t = now();
  await assertNotBlocked(key);
  const hit = URL_REFUSED.get(key);
  if (hit && t - hit.at < URL_REFUSED_MS) throw refuse(hit.reason, "unsafe", 422);
  if (adultHost(u.hostname)) throw refuse(MSG.adult, "adult", 422);
  const reuse = (await getQuery("SELECT * FROM onair_media WHERE src_url = ? AND status = 'ready' AND created > ? ORDER BY created DESC LIMIT 1", [key, t - REUSE_MS]))[0];
  if (reuse && filePath(reuse.file) && fs.existsSync(filePath(reuse.file))) return assetOf(reuse);
  const mb = Math.max(1, Number(maxMb) || 8);
  let r;
  try { r = await LP().safeGet(u, { maxBytes: Math.round(mb * 1024 * 1024), accept: ACCEPT, lookup, timeoutMs }); }
  catch (e) { throw fromPreview(e, mb); }
  if (adultHost(hostOf(r.url))) throw refuse(MSG.adult, "adult", 422);       // where its redirects ended
  if (r.url && r.url !== key) await assertNotBlocked(r.url);
  if (r.truncated) throw refuse(`That picture is bigger than ${mb} MB.`, "too_big", 413);
  if (/text\/html|xhtml/.test(r.ct)) throw refuse(MSG.page, "page");
  if (!/^image\//.test(r.ct)) throw refuse(MSG.not_picture, "type");
  const sn = FM().sniff(r.body);
  if (sn.bad || sn.kind !== "image" || !FORMATS.includes(sn.fmt)) throw refuse(MSG.not_picture, "type");
  try {
    return await ingestBuffer(r.body, sn.fmt, { src_kind: "url", src_url: key, src_host: hostOf(r.url) || u.hostname, by, userId, onCheck });
  } catch (e) {
    if (e && e.code === "unsafe") URL_REFUSED.set(key, { at: now(), reason: e.message });
    throw e;
  }
}
/** A chunked feed upload made for on-air (purpose "onair"): ingested, then the attachment is consumed (deleted + its files). */
async function ingestUpload(userId, attId, { by = null, onCheck } = {}) {
  await init();
  const a = (await getQuery("SELECT * FROM feed_attachments WHERE id = ?", [String(attId || "")]))[0];
  if (!a || String(a.owner_id) !== String(userId) || a.purpose !== "onair" || a.post_id || a.state === "deleted") {
    throw refuse("That upload isn't yours, or isn't one for Pepe's stream.", "upload", 404);
  }
  if (a.kind !== "image") throw refuse(MSG.not_picture, "type");
  if (a.state !== "ready") throw refuse(a.state === "failed" ? a.error || "That upload failed." : "That upload is still processing.", "upload", 409);
  try {
    let sn = {};
    try { sn = JSON.parse(a.sniff || "{}") || {}; } catch (e) { sn = {}; }
    if (!FORMATS.includes(sn.fmt)) throw refuse(MSG.not_picture, "type");
    const p = FM().filePath(a.file);
    if (!p || !fs.existsSync(p)) throw refuse("That upload is gone - upload it again.", "upload", 410);
    // read into memory first: libvips caches a file it opened (on Windows that blocks removing it below)
    return await ingestBuffer(fs.readFileSync(p), "webp", { src_kind: "upload", upload: a.id, by, userId, onCheck });
  } finally {
    FM().removeFiles([a.file, a.thumb, a.poster].filter(Boolean));
    await runQuery("UPDATE feed_attachments SET state = 'deleted' WHERE id = ?", [a.id]).catch(() => {});
  }
}

// ── link cards ──
async function buildCard(url, { by = null, userId = null, maxMb = 8, lookup, onCheck, timeoutMs } = {}) {
  const u = checkUrl(url);
  await assertNotBlocked(u.toString());
  if (adultHost(u.hostname)) throw refuse(MSG.adult, "adult", 422);
  let pv;
  try { pv = await LP().preview(u.toString(), { lookup, timeoutMs }); } catch (e) { throw fromPreview(e, maxMb); }
  // 1.99acw review: every text the card shows - the domain and the host its redirects ended on too - and adult hosts
  const finalHost = hostOf(pv.url) || u.hostname;
  if ([finalHost, pv.domain].some((h) => h && adultHost(String(h)))) throw refuse(MSG.adult, "adult", 422);
  if (textBad([pv.title, pv.description, pv.site, pv.domain, finalHost].filter(Boolean).join("\n"))) throw refuse(MSG.card_text, "card_text", 422);
  if (pv.imageUrl && adultHost(hostOf(pv.imageUrl))) throw refuse(MSG.adult, "adult", 422);
  const notes = [];
  if (pv.embed) notes.push("to play it instead: !onair <link> rights");
  let asset = null, icon = null, unsafe = null;
  const work = [];
  if (pv.image) {
    work.push((async () => {
      const sn = FM().sniff(pv.image);
      if (sn.bad || sn.kind !== "image" || !FORMATS.includes(sn.fmt)) { notes.push("its picture isn't a PNG / JPEG / GIF / WebP - shown without it"); return; }
      try { asset = await ingestBuffer(pv.image, sn.fmt, { src_kind: "card", src_url: pv.imageUrl, src_host: hostOf(pv.imageUrl), by, userId, onCheck }); }
      catch (e) {
        // the page's OWN picture isn't clearly safe (or was blocked): the strongest hint the page is adult - no card at all.
        // Only a format / fetch / check-availability problem keeps the card (without the picture).
        if (e && (e.code === "unsafe" || e.code === "blocked")) { unsafe = unsafe || e; return; }
        notes.push("its picture couldn't be used - shown without it");
      }
    })());
  }
  if (pv.iconUrl) {
    work.push((async () => {
      try {
        const r = await LP().safeGet(pv.iconUrl, { maxBytes: ICON_MAX, accept: ACCEPT, lookup, timeoutMs });
        if (r.truncated || !/^image\//.test(r.ct)) return;
        const sn = FM().sniff(r.body);
        if (sn.bad || sn.kind !== "image" || !FORMATS.includes(sn.fmt)) return;            // ICO / SVG: never decoded
        icon = (await ingestBuffer(r.body, sn.fmt, { src_kind: "icon", src_url: r.url, src_host: hostOf(r.url), by, userId })).file;
      } catch (e) {
        if (e && (e.code === "unsafe" || e.code === "blocked")) unsafe = unsafe || e;       // an unsafe favicon: no card either
        icon = null;                                                                      // else a letter badge instead
      }
    })());
  }
  await Promise.all(work);
  if (unsafe) throw refuse(MSG.card_unsafe, "card_unsafe", 422, { logId: unsafe.logId || null, minor: !!unsafe.minor });
  return {
    card: { title: clip(pv.title || pv.site || pv.domain, 200), description: clip(pv.description, 300), site: clip(pv.site, 80),
            domain: String(pv.domain || u.hostname).slice(0, 120), url: String(pv.url || u.toString()).slice(0, 2048), icon },
    asset, note: notes.length ? notes.join("; ") : null,
  };
}

// ── direct pictures + live pages (Pepe's VM loads these itself) ──
async function checkDirect(url, { lookup, probe = true, timeoutMs } = {}) {
  const u = checkUrl(url);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) === 6) throw refuse("A direct picture needs a site's name, not an IPv6 address.", "ipv6");
  await assertNotBlocked(u.toString());
  if (adultHost(host)) throw refuse(MSG.adult, "adult", 422);
  try { await LP().resolvePublic(host, lookup); } catch (e) { throw fromPreview(e); }
  let final = u;
  if (probe) {               // a type check, not a scan: the first 64 KB must be a picture (catches an HTML page / a 404)
    let r;
    try { r = await LP().safeGet(u, { maxBytes: PROBE_MAX, accept: ACCEPT, lookup, cut: true, timeoutMs }); } catch (e) { throw fromPreview(e); }
    if (/text\/html|xhtml/.test(r.ct)) throw refuse(MSG.page, "page");
    if (!/^image\//.test(r.ct)) throw refuse(MSG.not_picture, "type");
    const sn = FM().sniff(r.body);
    if (sn.bad || sn.kind !== "image" || !FORMATS.includes(sn.fmt)) throw refuse(MSG.not_picture, "type");
    final = new URL(r.url);                                 // where its redirects (each one checked) ended: what OBS loads
  }
  const fh = final.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIP(fh) === 6) throw refuse("A direct picture needs a site's name, not an IPv6 address.", "ipv6");
  if (adultHost(fh)) throw refuse(MSG.adult, "adult", 422);
  if (final.toString() !== u.toString()) await assertNotBlocked(final.toString());
  const origin = final.origin;
  if (!ORIGIN_RE.test(origin)) throw refuse("That picture's address can't be loaded directly.", "origin");
  return { url: final.toString().slice(0, 2048), origin: origin.toLowerCase(), host: fh };
}
function liveDenied(host, cfg = {}) {
  const deny = [...OWN_HOSTS];
  try { if (process.env.SITE_URL) deny.push(new URL(process.env.SITE_URL).hostname.toLowerCase()); } catch (e) { /* none */ }
  for (const d of String(cfg.live_deny || "").split(",")) if (d.trim()) deny.push(d.trim().toLowerCase());
  return deny.some((d) => host === d || host.endsWith("." + d));
}
const LIVE_DENIED = "That site can't be opened live on Pepe's stream.";
async function checkLive(url, cfg = {}, { lookup } = {}) {
  const u = checkUrl(url);
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (net.isIP(host) === 6) throw refuse("A live page needs a site's name, not an IPv6 address.", "ipv6");
  if (liveDenied(host, cfg)) throw refuse(LIVE_DENIED, "denied", 403);
  if (adultHost(host)) throw refuse(MSG.adult, "adult", 422);
  await assertNotBlocked(u.toString());
  try { await LP().resolvePublic(host, lookup); } catch (e) { throw fromPreview(e); }
  return { url: u.toString(), host };
}

// ── a request -> what goes on air ──
/** The network part of a request (a job): fetch / check / build. -> the prepared parts {asset, card, direct, live, note}. */
async function prepare(spec, j, { userId = null, cfg = {}, by = null, lookup, timeoutMs } = {}) {
  const set = (state, msg) => { if (j) { j.state = state; j.msg = msg; } };
  const checking = () => set("checking", "Checking the picture (safety check)…");
  const maxMb = Number(cfg.max_image_mb) || 8;
  if (spec.mode === "live") {
    set("checking", "Checking the address…");
    return { live: { ...(await checkLive(spec.url, cfg, { lookup })), sound: !!spec.sound } };
  }
  if (spec.mode === "image" && spec.direct) {
    set("checking", "Checking the address…");
    return { direct: await checkDirect(spec.url, { lookup, timeoutMs }) };
  }
  if (spec.mode === "image" && spec.upload) {
    checking();
    return { asset: await ingestUpload(userId, spec.upload, { by }) };
  }
  if (spec.mode === "image") {
    set("fetching", "Fetching the picture…");
    return { asset: await fetchImage(spec.url, { by, userId, maxMb, lookup, onCheck: checking, timeoutMs }) };
  }
  set("fetching", "Fetching the page…");
  const c = await buildCard(spec.url, { by, userId, maxMb, lookup, onCheck: checking, timeoutMs });
  return { card: c.card, asset: c.asset, note: c.note };
}
/** spec + prepared -> the pick's `media` sub-object (onair.js adds until when it goes on). */
function mediaOf(spec, p = {}) {
  return { mode: spec.mode, lane: spec.lane === "corner" ? "corner" : "main", corner: spec.lane === "corner" ? spec.corner || "tr" : null,
           secs: spec.secs, clamped: !!spec.clamped, caption: spec.caption || null, src: spec.url || null,
           asset: p.asset ? { id: p.asset.id, file: p.asset.file, w: p.asset.w, h: p.asset.h, animated: !!p.asset.animated, host: p.asset.host || null } : null,
           card: p.card || null, direct: p.direct || null, live: p.live || null, note: p.note || null };
}
function labelOf(m) {
  if (!m) return "?";
  if (m.mode === "live") return `🌐 ${m.live ? m.live.host : "?"} (live)`;
  if (m.mode === "card") return `🔗 ${clip((m.card && (m.card.title || m.card.domain)) || "a page", 80)} - ${(m.card && m.card.domain) || "?"}`;
  if (m.direct) return `🖼↗ ${m.direct.host} (direct, unscanned)`;
  return `🖼 ${m.caption || (m.asset && m.asset.host) || "a picture"}`;
}
/** The address a pick shows from (the audit's url column). */
const urlOf = (m) => (m && ((m.direct && m.direct.url) || (m.live && m.live.url) || (m.card && m.card.url) || m.src)) || null;
/** Asset ids / files a pick refers to (the sweep keeps them). */
const refsOf = (m) => (m ? [m.asset && m.asset.id, m.asset && m.asset.file, m.card && m.card.icon].filter(Boolean) : []);
/** A queued pick at play time: its stored pictures still there (and not blocked); a direct / live host still public (DNS may
 *  have moved). 1.99acw review: a live page's host is checked against the CURRENT live_deny (cfg) and blocks; a direct picture
 *  gets its type probe again (still a picture, its redirects still end where they did - else it would show something else). */
async function recheck(m, { lookup, cfg = {}, probe = true, timeoutMs } = {}) {
  if (!m || !m.mode) throw refuse("That queued item can't be read.", "bad");
  if (m.asset && !(await assetFile(m.asset.file))) throw refuse("Its picture is gone.", "gone");
  if (m.card && m.card.icon && !(await assetFile(m.card.icon))) m.card.icon = null;           // a blocked favicon: the letter badge
  if (m.live) {
    const host = String(m.live.host || "").toLowerCase();
    if (liveDenied(host, cfg)) throw refuse(LIVE_DENIED, "denied", 403);
    if (adultHost(host)) throw refuse(MSG.adult, "adult", 422);
    await assertNotBlocked(m.live.url);
    try { await LP().resolvePublic(host, lookup); } catch (e) { throw fromPreview(e); }
  }
  if (m.direct) {
    if (!probe) { try { await LP().resolvePublic(m.direct.host, lookup); } catch (e) { throw fromPreview(e); } }
    else {
      const d = await checkDirect(m.direct.url, { lookup, probe: true, timeoutMs });
      if (d.url !== m.direct.url || d.origin !== m.direct.origin) throw refuse("That picture's address now leads somewhere else - queue it again.", "moved");
    }
  }
  if (m.card && m.card.url) await assertNotBlocked(m.card.url);
  return true;
}

// ── 1.99acw review: blocks (a picture / link that wrongly passed, taken down for good) ──
const urlKey = (u) => "url:" + sha256(Buffer.from(String(u || "")));
/** Throws MediaError "blocked" when staff blocked this exact link. */
async function assertNotBlocked(url) {
  if (!url) return;
  await init();
  const r = (await getQuery("SELECT blocked FROM onair_refused WHERE sha256 = ?", [urlKey(url)]))[0];
  if (r && Number(r.blocked)) throw refuse(MSG.blocked, "blocked", 422);
}
async function blockUrl(url, by, reason) {
  if (!url) return false;
  await runQuery(`INSERT INTO onair_refused (sha256, at, reason, blocked, by, src) VALUES (?, ?, ?, 1, ?, ?)
                  ON CONFLICT(sha256) DO UPDATE SET at = excluded.at, reason = excluded.reason, blocked = 1, by = excluded.by, src = excluded.src`,
                 [urlKey(url), now(), String(reason || "blocked").slice(0, 300), String(by || "?").slice(0, 80), String(url).slice(0, 2048)]);
  URL_REFUSED.set(String(url), { at: now(), reason: MSG.blocked });
  return true;
}
/**
 * Block stored pictures (by asset id or file name) and links: each picture -> status "blocked" (assetFile never serves it, the
 * link / hash reuse never finds it), its file deleted, its sha256 and its source link remembered for good (refused at once next
 * time, no vision call); each link -> blocked as an exact address. -> {assets: [{id, file, src_url}], urls: [..]}.
 */
async function block({ refs = [], urls = [], logId = null } = {}, by = "?", reason = null) {
  await init();
  const why = String(reason || "blocked by " + by).slice(0, 300);
  const rows = [];
  const seen = new Set();
  const add = (r) => { if (r && !seen.has(r.id)) { seen.add(r.id); rows.push(r); } };
  for (const x of refs) if (x) for (const r of await getQuery("SELECT * FROM onair_media WHERE id = ? OR file = ?", [String(x), String(x)])) add(r);
  if (logId) for (const r of await getQuery("SELECT * FROM onair_media WHERE safety_log = ?", [Number(logId)])) add(r);
  const out = { assets: [], urls: [] };
  for (const r of rows) {
    await runQuery("UPDATE onair_media SET status = 'blocked' WHERE id = ?", [r.id]);
    if (r.sha256) {
      await runQuery(`INSERT INTO onair_refused (sha256, at, reason, blocked, by, src) VALUES (?, ?, ?, 1, ?, ?)
                      ON CONFLICT(sha256) DO UPDATE SET at = excluded.at, reason = excluded.reason, blocked = 1, by = excluded.by, src = excluded.src`,
                     [r.sha256, now(), why, String(by).slice(0, 80), r.src_url || null]);
    }
    if (r.src_url && /^https?:\/\//i.test(r.src_url)) { await blockUrl(r.src_url, by, why); out.urls.push(r.src_url); }
    rm(filePath(r.file));
    out.assets.push({ id: r.id, file: r.file, src_url: r.src_url || null, safety_log: r.safety_log || null });
  }
  for (const u of urls) if (u && /^https?:\/\//i.test(String(u)) && !out.urls.includes(String(u))) { await blockUrl(String(u), by, why); out.urls.push(String(u)); }
  if (rows.length || out.urls.length) console.log(`[onairmedia] blocked by ${by}: ${rows.length} picture(s), ${out.urls.length} link(s)`);
  return out;
}
/** The links a pick shows from that a block should cover (the source of its picture, a direct / live / card address). */
const blockUrlsOf = (m) => (m ? [m.src, m.direct && m.direct.url, m.live && m.live.url, m.card && m.card.url].filter((u) => u && /^https?:\/\//i.test(String(u))) : []);
/** Recent stored pictures for the staff list (the newest first; blocked ones without their file). */
async function recentAssets(limit = 24) {
  await init();
  const rows = await getQuery(`SELECT id, file, w, h, frames, src_kind, src_url, src_host, by, created, last_used, status, safety_log FROM onair_media
                               WHERE src_kind IN ('url', 'upload', 'card') ORDER BY created DESC, rowid DESC LIMIT ?`, [Math.max(1, Math.min(100, Number(limit) || 24))]);
  return rows.map((r) => ({ id: r.id, file: r.status === "ready" ? r.file : null, w: Number(r.w) || 0, h: Number(r.h) || 0, animated: Number(r.frames) > 1,
                            kind: r.src_kind, src: r.src_url || null, host: r.src_host || null, by: r.by || null, created: Number(r.created) || 0,
                            last_used: r.last_used == null ? null : Number(r.last_used), status: r.status, safety_log: r.safety_log || null }));
}

// ── 1.99acw review: attempts (the per-person rate limit, the refusal audit) + people blocked from media ──
/** The person behind a request: a site account ("u:<userId>"), else a Camfrog login ("cf:<login>"). */
const personKey = ({ userId = null, login = null } = {}) => (userId ? "u:" + String(userId) : "cf:" + String(login || "?").toLowerCase().slice(0, 40));
/** A Camfrog login -> its linked site account's userId (users.camfrogUsername), else null. */
async function userIdForLogin(login) {
  const l = String(login || "").toLowerCase().trim();
  if (!l) return null;
  try { const r = (await getQuery("SELECT userId FROM users WHERE LOWER(camfrogUsername) = ? LIMIT 1", [l]))[0]; return r ? String(r.userId) : null; }
  catch (e) { return null; }
}
/** Throws (403) while the person is blocked from media requests. */
async function assertPersonOk(who, t = now()) {
  await init();
  const r = (await getQuery("SELECT until, why FROM onair_person_blocks WHERE who = ?", [String(who)]))[0];
  if (r && Number(r.until) > t) throw refuse(MSG.person_blocked, "person_blocked", 403);
}
/** The rate limit: at most `max` attempts per person per 10 minutes (every attempt counts - refused ones too). The attempt is
 *  recorded here (-> its id) and survives a restart; chat + web share the person's bucket. */
async function rateCheck(who, max, { via = null, by = null, mode = null, url = null } = {}, t = now()) {
  await init();
  const k = String(who || "?");
  const cap = Math.max(1, Number(max) || 8);
  const n = (await getQuery("SELECT COUNT(*) AS n FROM onair_attempts WHERE who = ? AND at > ?", [k, t - RATE_WINDOW_MS]))[0];
  if (n && Number(n.n) >= cap) throw refuse(`That's a lot of pictures and links - at most ${cap} every 10 minutes.`, "rate", 429);
  const r = await runQuery("INSERT INTO onair_attempts (at, who, via, by, mode, url, state) VALUES (?, ?, ?, ?, ?, ?, 'started')",
    [t, k, via ? String(via).slice(0, 10) : null, by ? String(by).slice(0, 80) : null, mode ? String(mode).slice(0, 10) : null, url ? String(url).slice(0, 2048) : null]);
  return r && (r.id != null ? r.id : r.lastID);
}
async function notifyAdmins(title, body, ref) {
  try {
    const admins = await getQuery("SELECT userId FROM users WHERE class = 'Admin'");
    for (const a of admins) await require("./inbox").addSafe(a.userId, { kind: "admin", title, body, link: "/stage/admin#onair", ref });
  } catch (e) { console.error("[onairmedia] notify:", e.message); }
}
/**
 * How an attempt ended. An unsafe refusal (a picture, or a card whose own picture) counts against the person: STRIKES in
 * STRIKE_WINDOW_MS -> blocked STRIKE_BLOCK_MS; a possible-minor flag -> blocked MINOR_BLOCK_MS at once. Both tell the admins.
 * -> {blocked: until | null}
 */
async function noteOutcome(attemptId, who, { state, code = null, logId = null, minor = false, label = null } = {}, t = now()) {
  await init();
  if (attemptId) {
    await runQuery("UPDATE onair_attempts SET state = ?, code = ?, log_id = ?, minor = ? WHERE id = ?",
      [String(state || "?").slice(0, 10), code ? String(code).slice(0, 30) : null, logId || null, minor ? 1 : 0, attemptId]).catch(() => {});
  }
  const unsafe = code === "unsafe" || code === "card_unsafe";
  if (!unsafe || !who) return { blocked: null };
  const cur = (await getQuery("SELECT until FROM onair_person_blocks WHERE who = ?", [String(who)]))[0];
  let until = null, why = null;
  if (minor) { until = t + MINOR_BLOCK_MS; why = "a picture they sent was flagged as possibly involving a minor"; }
  else {
    const n = (await getQuery("SELECT COUNT(*) AS n FROM onair_attempts WHERE who = ? AND at > ? AND code IN ('unsafe', 'card_unsafe')",
      [String(who), t - STRIKE_WINDOW_MS]))[0];
    if (n && Number(n.n) >= STRIKES) { until = t + STRIKE_BLOCK_MS; why = `${Number(n.n)} pictures refused as not safe in 24 h`; }
  }
  if (!until || (cur && Number(cur.until) >= until)) return { blocked: cur ? Number(cur.until) : null };
  await runQuery(`INSERT INTO onair_person_blocks (who, until, why, at, by, label) VALUES (?, ?, ?, ?, 'system', ?)
                  ON CONFLICT(who) DO UPDATE SET until = excluded.until, why = excluded.why, at = excluded.at, by = excluded.by, label = excluded.label`,
                 [String(who), until, why, t, label ? String(label).slice(0, 80) : null]);
  console.log(`[onairmedia] ${who} blocked from on-air media until ${new Date(until).toISOString()}: ${why}`);
  await notifyAdmins(minor ? "URGENT: on-air picture flagged as a possible minor - sender blocked" : "On-air pictures: a sender was blocked",
    `${label || who} can't put pictures or links on Pepe's stream until ${new Date(until).toISOString().slice(0, 16).replace("T", " ")} UTC (${why}). ` +
    (minor ? "Review the check on the image safety page and follow the CSAM procedure; nothing was shown. " : "Nothing unsafe was shown. ") +
    "Lift it on /stage/admin (Pictures & links).", "onair-person:" + who + ":" + t);
  return { blocked: until };
}
async function personBlocks(t = now()) {
  await init();
  return (await getQuery("SELECT who, until, why, at, by, label FROM onair_person_blocks WHERE until > ? ORDER BY at DESC LIMIT 50", [t]))
    .map((r) => ({ who: r.who, until: Number(r.until), why: r.why, at: Number(r.at), by: r.by, label: r.label || r.who }));
}
async function liftPerson(who, by) {
  await init();
  const r = await runQuery("DELETE FROM onair_person_blocks WHERE who = ?", [String(who || "")]);
  if (r && r.changes) console.log(`[onairmedia] ${who}'s on-air media block lifted by ${by}`);
  return !!(r && r.changes);
}

// ── jobs ──
const JOBS = new Map();
const FINAL = new Set(["done", "refused", "failed"]);
const jobView = (j) => (j ? { id: j.id, state: j.state, msg: j.msg, final: FINAL.has(j.state), created: j.created, code: j.code || null, result: j.result || null } : null);
function sweepJobs(t = now()) { for (const [id, j] of JOBS) if (FINAL.has(j.state) && t - j.created > JOB_KEEP_MS) JOBS.delete(id); }
function inflight(pred) { let n = 0; for (const j of JOBS.values()) if (!FINAL.has(j.state) && pred(j)) n++; return n; }
/** {actor, person, via, run(job) -> {msg, result}} -> the job (running). Throws MediaError (429) past the in-flight caps (one
 *  per actor and per person - a linked login's chat and web jobs count together). */
function startJob({ actor, person = null, via = "web", run }) {
  sweepJobs();
  const a = String(actor || "?"), p = person ? String(person) : null;
  if (inflight((j) => j.actor === a || (p && j.person === p)) >= JOBS_ACTOR) throw refuse("You already have a picture or link being checked - wait for it to finish.", "busy", 429);
  if (inflight(() => true) >= JOBS_SITE) throw refuse("Two pictures are being checked right now - try again in a moment.", "busy", 429);
  const j = { id: crypto.randomBytes(6).toString("hex"), actor: a, person: p, via, state: "queued", msg: "Starting…", created: now(), code: null, result: null };
  JOBS.set(j.id, j);
  j.promise = (async () => {
    try {
      const r = (await run(j)) || {};
      j.state = "done"; j.msg = r.msg || "Done."; j.result = r.result || null;
    } catch (e) {
      j.state = e && e.refuse ? "refused" : "failed";
      j.msg = e && e.refuse ? e.message : "Something went wrong.";
      j.code = (e && e.code) || null;
      j.logId = (e && e.logId) || null;
      if (!(e && e.refuse)) console.error("[onairmedia] job", j.id, e);
    } finally { j.done_at = now(); }
    return j;
  })();
  return j;
}
/** The job's view once it ends, or after `ms` (still running). */
async function race(j, ms = RACE_MS) {
  let timer;
  await Promise.race([j.promise, new Promise((res) => { timer = setTimeout(res, ms); })]);
  clearTimeout(timer);
  return jobView(j);
}
function job(id, actor, { any = false } = {}) {
  const j = JOBS.get(String(id || ""));
  if (!j || (!any && j.actor !== String(actor || ""))) return null;
  return jobView(j);
}
function jobsFor(actor, t = now()) {
  return [...JOBS.values()].filter((j) => j.actor === String(actor || "") && t - j.created < JOB_KEEP_MS).map(jobView).reverse();
}
async function waitJob(id) { const j = JOBS.get(String(id || "")); if (j) await j.promise; return jobView(j); }

// ── cleanup ──
/** Stored pictures neither used nor made in 30 days and not referenced by what's on / queued; refusal memory past 30 days. */
async function sweep(refs = new Set(), t = now()) {
  await init();
  const cut = t - KEEP_MS;
  const keep = refs instanceof Set ? refs : new Set(refs || []);
  const old = await getQuery("SELECT id, file FROM onair_media WHERE created < ? AND COALESCE(last_used, 0) < ?", [cut, cut]);
  let n = 0;
  for (const r of old) {
    if (keep.has(r.id) || keep.has(r.file)) continue;
    rm(filePath(r.file));
    await runQuery("DELETE FROM onair_media WHERE id = ?", [r.id]);
    n++;
  }
  await runQuery("DELETE FROM onair_refused WHERE at < ? AND COALESCE(blocked, 0) = 0", [cut]);     // blocks are for good
  await runQuery("DELETE FROM onair_attempts WHERE at < ?", [cut]);
  await runQuery("DELETE FROM onair_person_blocks WHERE until < ?", [t]);
  for (const [k, v] of URL_REFUSED) if (t - v.at > URL_REFUSED_MS) URL_REFUSED.delete(k);
  sweepJobs(t);
  return n;
}

// ── the file route: what OBS's show page (and the panel's preview) loads ──
function register(app) {
  app.get("/onair/m/:file", async (req, res) => {
    const name = String(req.params.file || "");
    if (!FILE_RE.test(name)) return res.status(404).end();
    try {
      const p = await assetFile(name);
      if (!p) return res.status(404).end();
      res.set({ "Content-Type": "image/webp", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox",
                "Cross-Origin-Resource-Policy": "same-origin", "Cache-Control": "private, max-age=600", "X-Robots-Tag": "noindex" });
      res.sendFile(p, { headers: { "Content-Type": "image/webp" } }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
    } catch (e) {
      console.error("[onairmedia] file:", e.message);
      if (!res.headersSent) res.status(500).end();
    }
  });
}

module.exports = {
  init, register, parseChat, parseOptions, parseDur, fmtDur, secsFor, validateSpec, cleanCaption, textBad, explicitText, adultHost, prepare, mediaOf,
  labelOf, urlOf, refsOf, recheck, ingestBuffer, ingestUpload, fetchImage, buildCard, checkDirect, checkLive, liveDenied, assetFile, filePath, touch, sweep,
  startJob, race, job, jobsFor, waitJob, rateCheck, MediaError, URLISH, ORIGIN_RE, FILE_RE, CORNERS, FORMATS, CAPTION_MAX, MIN_SECS,
  DIRECT_HARD_MAX_S, MAX_FRAMES, MAX_LOOP_MS, MAX_SIDE, MSG, dir, _setDir,
  // 1.99acw review: blocks, attempts, people blocked from media
  block, blockUrl, blockUrlsOf, assertNotBlocked, recentAssets, personKey, userIdForLogin, assertPersonOk, noteOutcome, personBlocks, liftPerson,
  STRIKES, STRIKE_BLOCK_MS, MINOR_BLOCK_MS,
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _reset: () => { JOBS.clear(); URL_REFUSED.clear(); ready = null; EXPLICIT = null; },
};
