// chatlogexport.js — CL10: download a pad's chat log (the chat-history spec §2.4, §3.5 "Downloads", §3.8, §3.11; decision 8 at its
// default). Ships DARK: nothing answers until the chatlog.downloads switch is on - and chatlog.history with it (CL10 fix-up: a file is
// an archive read beyond the live tail, so history off is an emergency stop for downloads too; chatlog.js; the owner turns them on
// after this slice is live and checked - runbook step 8).
//
//   POST /api/rooms/:slug/chatlog/export {range: today | 24h | 7d} or {from, to (YYYY-MM-DD or YYYY-MM-DDTHH:MM in your time zone,
//        ISO-8601 or ms - whole minutes)}, fmt: html | txt | jsonl, sys: bool
//        -> {ok, url: "/p/<slug>/chatlog/dl/<token>", estimate: {lines, more} (exactly what the projection keeps; nulls when the site is
//           busy), tz, from, to, cut?: {days, next}}       same-origin only; no-store + noindex
//   GET  /p/:slug/chatlog/dl/:token  -> the file, streamed as it is made: single use, 2 minutes, the same account only; a refusal is a
//        303 back to the pad with ?cldl=<code> (the pad page says why, in the viewer's language)
//        Content-Disposition: attachment; filename="patv-<slug>-chat-<YYYYMMDD>-<YYYYMMDD>.<ext>"; Cache-Control: private, no-store;
//        X-Accel-Buffering: no
//   GET  /api/account/chatlog-downloads -> your own downloads of the last 90 days (metadata only - Settings › Account)
//
// Who (decision 8): signed-in viewers who can read the pad (padaccess.full) and whose view allows history (chatlogview.view
// can.history: age-confirmed on an 18+ pad, not blocked from the whole bridge nor banned from the pad's feed, the 💎 gate), with an
// ESTABLISHED account (the DM new-account rule: level 2, or a linked Camfrog / Discord / Twitch account - messages.isNewAccount), on a
// pad whose "Allow downloads" is on (on for Public / Members pads, off for Approved ones; can.downloads - the owner and staff always).
// What: only what the downloader could scroll to - their own floors (chatlogview), except that a Camfrog mod always gets the PUBLIC
// floors (mods_all or not: a demoted mod keeps the file). The owner and staff with chatlog.read_all get everything the tier keeps
// (a staff file below the public floor is a chatlog_views row). Presence lines (joins, leaves, mic) only when asked (sys), and for
// viewers without full history only from the last 24 hours. Every line goes through chatlogview's projection (the owner's change
// to decision 9, 2026-10-19 - incognito hides WHO, not WHAT): the lines of people on !bridge hide (and anyone the sticky hidden set
// leaves out: a kind Pepe never said, forget-me / deletion / staff), !transcripts off 🎙 lines, and any hidden person's joins,
// leaves and mic lines are LEFT OUT (counted "left out: privacy"); an INCOGNITO person's chat and 🎙 lines stay, shown as "someone" -
// no name, login, picture, looks, flair or 🎙 id, in the HTML, the TXT and the JSONL alike (their speakers are never looked up, so
// not even an unused picture of theirs reaches the file); the names of both kinds inside other people's lines become "someone".
// Taken-down lines are left out for EVERYONE here, the owner and staff too - their 30-day appeal copy never goes into a file later
// removals can't reach (counted "removed by moderators"). Names, avatars, styles and flair are today's, by a resolver of the file's
// own (the live chat's 60 s name cache is never evicted by a 50,000-line file; a lookup that fails fails the FILE - never a line
// shown by a name the projection couldn't check); a picture is embedded only for a person the file shows by name, only from a file
// under the site's public root (path.resolve, realpath prefix check, ".." refused; PNG / JPEG / GIF / WebP by their bytes - never an
// SVG), <= 64 KB each, once each (a rule of
// the file's own stylesheet), 2 MB in all - anything else is the letter bubble: the file never contacts PATV or anyone else.
// How (spec §3.5): at most 31 days (a longer range is cut there) and 50,000 lines per file - the footer says where to continue; the
// archive is read in pages of 1,000 rows by c on chatlogdb's read connection, both cursor bounds (chatlogview.cursorBounds - one seek
// per floor), and each page is written straight out (res.write, waiting for drain): the file never sits in memory. Two passes over
// the same rows (the upper bound fixed when it starts): the first counts what the header says (and resolves names / pictures), the
// second writes - both under ONE privacy state (pinned; a move remakes pass 1 or fails the file), within a deadline (10 minutes, 30 s
// for a socket that takes nothing). Formats are "PATV chat log v1" (§3.8, frozen by the golden files in test/fixtures/chatlog/): one renderer for all of
// them (public/js/chatlog-core.js), dates / day dividers / times from the zone's offset (tz-core) and the chatlog.file.* names - never
// Intl's wording, so a file is the same on Node 16 and 20 - in the downloader's language and time zone (account zone, else the
// patv_tz cookie, else UTC).
// Limits, checked in the database so they survive a restart (§3.11): 2 a minute and 10 a day per account (COUNT_UNUSED / COUNT_CUT: a
// link counts once asked for; a file that failed or was cut off counts once its header reached the downloader - one that failed before
// anything was sent never does), one streaming per account, 3 across the site (busy); at boot every `streaming` row becomes `failed`.
// A staff file below the public floor is audited BEFORE it is sent. Audit:
// chatlog_exports (metadata only, never content; kept 90 days), shown to the person (Settings › Account) and to admins
// (/admin/bridge). Nothing here logs a line or a name.
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { runQuery, getQuery, tx } = require("./dbUtils");
const CL = require("./chatlog");
const CORE = require("./public/js/chatlog-core.js");
const makeTz = require("./tz-core");

// ── owner decisions (spec §6 decision 8) and limits (§2.4, §3.5, §3.11): each one constant ──
const ESTABLISHED_ONLY = true;          // decision 8: level 2 or a linked account (the DM new-account rule)
const DAYS_MAX = 31;                    // a file covers at most 31 days; a longer range is cut there
const LINES_MAX = 50000;                // and at most 50,000 lines
const PAGE_ROWS = 1000;                 // archive rows per read (and per write)
const PER_MIN = 2, PER_DAY = 10;        // downloads per account: a minute, a day (failed / aborted don't count toward the day)
const USER_STREAMS = 1, SITE_STREAMS = 3;
const TOKEN_TTL_MS = 2 * 60e3;          // a download link: single use, 2 minutes
const KEEP_MS = 90 * 864e5;             // chatlog_exports rows (metadata): 90 days
const AVATAR_MAX = 64 * 1024, AVATARS_TOTAL = 2 * 1024 * 1024;
const FORMAT_V1 = "PATV chat log v1";
const JSONL_ID = "patv-chatlog/1";
const FMTS = Object.freeze({
  html: { ext: "html", type: "text/html; charset=utf-8" },
  txt: { ext: "txt", type: "text/plain; charset=utf-8" },
  jsonl: { ext: "jsonl", type: "application/x-ndjson; charset=utf-8" },
});
const RANGES = Object.freeze({ today: 1, "24h": 1, "7d": 1 });
const DAY = 864e5, MINUTE = 60e3, C_MAX = 1e15;
// CL10 fix-up (review): what keeps a download from being a probe or a stuck slot - each one constant
const STREAM_MAX_MS = 10 * 60e3;        // a download's whole life (pass 1 and the stream): a stalled or crawling client loses its slot
const DRAIN_MAX_MS = 30e3;              // the socket must take more of the file within this, or the file fails (a client that stopped reading)
const MOVED_TRIES = 3;                  // pass 1 is made again this often when the privacy state moves under it; then the file fails
const ESTIMATES_AT_ONCE = 2;            // the POST's line count is a projected pass over the range: at most this many at once on the site
const GET_PER_MIN = 20;                 // download-link fetches a minute per account (a bad token is refused before any view is computed)
// what counts toward the 10 a day (§3.5 says failed and aborted files never count - two deliberate departures, for the owner):
const COUNT_UNUSED = true;              // a link asked for and never fetched counts (each POST runs a pass over the range for its estimate)
const COUNT_CUT = true;                 // a file that failed or was cut off counts once its header reached the downloader (the JSONL header
                                        // carries the file's counts - left out for privacy too - so a free cut-off would be a free count);
                                        // one that failed before anything was sent never counts
const PRESENCE = Object.freeze(["join", "leave", "mic", "unmic"]);
const WD_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MO_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const siteBase = () => String(process.env.PUBLIC_BASE_URL || process.env.SITE_URL ||
  (process.env.STAGING ? "https://staging.publicaccess.tv" : "https://publicaccess.tv")).replace(/\/+$/, "");

let clock = () => Date.now();
const now = () => clock();
const LIMITS0 = Object.freeze({ perMin: PER_MIN, perDay: PER_DAY, siteStreams: SITE_STREAMS, linesMax: LINES_MAX, pageRows: PAGE_ROWS,
                                streamMs: STREAM_MAX_MS, drainMs: DRAIN_MAX_MS, estimates: ESTIMATES_AT_ONCE, getPerMin: GET_PER_MIN });
const limits = Object.assign({}, LIMITS0);
let ESTIMATING = 0;                     // estimate passes running now (site-wide)
let GET_HIT = null;                     // the per-account limiter on link fetches (authGuard.limiter)
class Refuse extends Error {
  constructor(status, message, code, extra) { super(message); this.status = status; this.code = code || null; this.refuse = true; Object.assign(this, extra || {}); }
}
const notFound = () => new Refuse(404, "That pad isn't available.", "not_found");
const bool = (v) => v === true || v === 1 || v === "1" || v === "true" || v === "on";
const yieldNow = () => new Promise((r) => setImmediate(r));
/** The row id of a download token: the token itself is never stored (an admin listing can't rebuild a link). */
const idOf = (tok) => crypto.createHash("sha256").update("chatlog-dl:" + String(tok)).digest("hex").slice(0, 32);

async function roRead(sql, params) {
  try { return await require("./chatlogdb").read(sql, params); } catch (e) {
    if (e && e.code === "unavailable") return getQuery(sql, params);          // no read connection (tests / tools): the shared one
    throw e;
  }
}

// ── time: the zone's offset (tz-core), the wall clock from it, never Intl's wording ──
const pad2 = (n) => ("0" + n).slice(-2);
function wallOf(ms, off) {
  const d = new Date(Number(ms) + off * 60000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
}
const ymd = (w, sep = "-") => w.y + sep + pad2(w.mo + 1) + sep + pad2(w.d);
const hm = (w) => pad2(w.h) + ":" + pad2(w.mi);
/** "UTC−04:00" / "UTC+05:30" / "UTC+00:00" (a real minus sign, as the file grammar has it). */
function offLabel(off) {
  const a = Math.abs(Math.round(off));
  return "UTC" + (off < 0 ? "−" : "+") + pad2(Math.floor(a / 60)) + ":" + pad2(a % 60);
}
/** A wall-clock time on a calendar date in a zone (00:00 by default), as ms (DST-safe: the offset is re-read until it settles). */
function localTime(zone, y, m, d, h = 0, mi = 0) {
  const base = Date.UTC(y, m - 1, d, h, mi);
  if (!Number.isFinite(base)) return null;
  let guess = base;
  for (let i = 0; i < 3; i++) {
    const next = base - makeTz.offset(zone, guess) * 60000;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}
/** 00:00 on a calendar date in a zone, as ms. */
const localMidnight = (zone, y, m, d) => localTime(zone, y, m, d);
/**
 * A range end: a calendar date in the downloader's zone (`end`: that day's end), a date and time there ("YYYY-MM-DDTHH:MM", the
 * dialog's Custom with a time - how a file cut inside a day is continued), an ISO date-time with its zone, or ms. Whatever the form,
 * rangeOf makes the range whole minutes (CL10 fix-up: the file's footer counts what it leaves out, so a range to the millisecond would
 * date a left-out line to the millisecond).
 */
function timeIn(v, zone, end) {
  const s = String(v == null ? "" : v).trim().slice(0, 40);
  if (/^\d{9,15}$/.test(s)) return Number(s);
  const okDate = (mo, d) => mo >= 1 && mo <= 12 && d >= 1 && d <= 31;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    if (!okDate(Number(m[2]), Number(m[3]))) return null;
    return localMidnight(zone, Number(m[1]), Number(m[2]), Number(m[3]) + (end ? 1 : 0));
  }
  const w = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(s);
  if (w) {
    if (!okDate(Number(w[2]), Number(w[3])) || Number(w[4]) > 23 || Number(w[5]) > 59) return null;
    return localTime(zone, Number(w[1]), Number(w[2]), Number(w[3]), Number(w[4]), Number(w[5]));
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s.replace(" ", "T"));
    return Number.isFinite(t) ? t : null;
  }
  return null;
}
const floorMin = (ms) => Math.floor(ms / MINUTE) * MINUTE;
const ceilMin = (ms) => Math.ceil(ms / MINUTE) * MINUTE;
/** The range asked for -> {from, to, cut: {days, next} | null}. range today | 24h | 7d (default 24h), or from / to. Whole minutes: the
 *  start rounded down, a custom end up (the present - "now" - is the only end that isn't a whole minute). */
function rangeOf(body, zone, t) {
  const b = body || {};
  const r = String(b.range == null ? "" : b.range);
  let from, to;
  const custom = !RANGES[r] && ((b.from != null && b.from !== "") || (b.to != null && b.to !== ""));
  if (r && !RANGES[r] && r !== "custom") throw new Refuse(400, "Pick a range: today, the last 24 hours, the last 7 days or your own dates.", "bad_range");
  if (r === "custom" && !custom) throw new Refuse(400, "Pick the dates to download.", "bad_range");
  if (!custom) {
    const k = RANGES[r] ? r : "24h";
    to = t;
    if (k === "24h") from = t - DAY;
    else if (k === "7d") from = t - 7 * DAY;
    else { const w = wallOf(t, makeTz.offset(zone, t)); from = localMidnight(zone, w.y, w.mo + 1, w.d); }
  } else {
    from = timeIn(b.from, zone, false);
    to = b.to == null || b.to === "" ? t : timeIn(b.to, zone, true);
    if (to != null && to < t) to = ceilMin(to);
  }
  if (from == null || to == null) throw new Refuse(400, "Pick the dates to download.", "bad_range");
  from = floorMin(from);
  to = Math.min(to, t);
  if (!(to > from)) throw new Refuse(400, "That range is empty - pick an earlier start.", "bad_range");
  let cut = null;
  if (to - from > DAYS_MAX * DAY) { to = from + DAYS_MAX * DAY; cut = { days: DAYS_MAX, next: to }; }
  return { from: Math.floor(from), to: Math.floor(to), cut };
}

// ── the translator: plain text in the downloader's language (i18n-core's t() HTML-escapes {name}; this fills them in raw) ──
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(s) {
  return String(s).replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,6});/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENT, e.toLowerCase()) ? ENT[e.toLowerCase()] : m;
  });
}
/** t(key, englishDefault, vars) -> plain text (chatlog-core's ctx.t). A plural picks by vars.count. */
function rawT(lang) {
  let t = null;
  try { t = require("./i18n").tFor(lang || "en"); } catch (e) { t = null; }
  return (key, def, vars) => {
    const v = vars || {};
    let tpl;
    if (t && t.has(key)) tpl = decode(t(key, v.count != null ? { count: v.count } : undefined));
    else {
      let d = def;
      if (d && typeof d === "object") d = v.count === 1 ? d.one : d.other;
      tpl = d == null ? key : String(d);
    }
    return tpl.replace(/\{!?(\w+)\}/g, (m, n) => (v[n] != null ? String(v[n]) : m));
  };
}
function numFmt(lang) {
  let f = null;
  try { f = new Intl.NumberFormat(lang && lang !== "en" ? lang : "en-US"); } catch (e) { f = null; }
  return (n) => (f ? f.format(n) : String(n));
}

/**
 * The renderer's context for a file: the zone's offset, the names of days and months from chatlog.file.*, absolute links, no data-*
 * attributes, no picture from anywhere (avatarCls: the file's own embedded ones), each time's full date in its tooltip.
 */
function fileCtx({ zone = "UTC", lang = "en", origin = siteBase(), avatars = null } = {}) {
  const t = rawT(lang);
  const offset = (ms) => makeTz.offset(zone, ms);
  const names = { weekdays: WD_EN.map((d, i) => t("chatlog.file.weekday_" + i, d)), months: MO_EN.map((m, i) => t("chatlog.file.month_" + (i + 1), m)) };
  const ctx = { t, lang, offset, names, year: true, origin, data: false, zone,
                avatar: () => null,
                avatarCls: (u) => (avatars && u && u.patv && u.patv.avatar ? avatars.get(u.patv.avatar) || null : null) };
  ctx.timeTitle = (ts) => {
    const off = offset(ts), w = wallOf(ts, off);
    return t("chatlog.file.when", "{day}, {time} · {zone} ({offset})", { day: CORE.dayLabel(ts, ctx), time: hm(w) + ":" + pad2(w.s), zone, offset: offLabel(off) });
  };
  ctx.date = (ms) => { const w = wallOf(ms, offset(ms)); return w.d + " " + names.months[w.mo]; };
  return ctx;
}

// ── the file's stylesheet: the pad chat's own (chatlog.css + the flair chip), the ds token values written in, a print variant ──
const BASE_CSS = `*, *::before, *::after { box-sizing: border-box; }
html { color-scheme: dark; -webkit-text-size-adjust: 100%; }
body.chatlog { margin: 0; background: var(--ds-surface); color: var(--ds-text);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"; }
.chatlog a { color: var(--ds-green-2); text-decoration: none; }
.chatlog a:hover { text-decoration: underline; }
.chatlog .cx-name { font-weight: bold; }
.chatlog .dl-head, .chatlog .dl-log, .chatlog .dl-foot { max-width: 860px; margin-inline: auto; padding-inline: 16px; }
.chatlog .dl-head { padding-block: 20px 12px; border-block-end: 1px solid var(--ds-line); }
.chatlog .dl-kicker { margin: 0 0 4px; color: var(--ds-text-muted); font-size: 12px; font-weight: bold; letter-spacing: .04em; text-transform: uppercase; }
.chatlog .dl-head h1 { margin: 0 0 6px; font-size: 20px; line-height: 1.3; color: var(--ds-text-strong); overflow-wrap: anywhere; }
.chatlog .dl-adult { display: inline-block; margin-inline-start: 8px; padding: 0 7px; border: 1px solid var(--ds-line-strong); border-radius: 999px;
  font-size: 12px; line-height: 18px; vertical-align: middle; color: var(--ds-text-2); }
.chatlog .dl-head p, .chatlog .dl-foot p { margin: 2px 0; color: var(--ds-text-2); font-size: 13px; overflow-wrap: anywhere; }
.chatlog .dl-head .dl-note { color: var(--ds-text-muted); font-size: 12.5px; }
.chatlog .dl-log { display: flex; flex-direction: column; gap: 2px; padding-block: 8px 16px; }
.chatlog h2.daydiv { margin-block: 12px 2px; }
.chatlog .dl-empty { margin: 16px 0; color: var(--ds-text-muted); }
.chatlog .dl-foot { padding-block: 12px 24px; border-block-start: 1px solid var(--ds-line); }`;
const PRINT_CSS = `@media print {
  body.chatlog { background: #fff; color: #111; }
  .chatlog a { color: #0b5d1e; }
  .chatlog .line:hover, .chatlog .line.pepe { background: transparent; }
  .chatlog .line.tx { background: #f2f6fb; border-inline-start-color: #7aa0c8; }
  .chatlog .line.tx .body { color: #1f3b57; }
  .chatlog .line .when, .chatlog .sys, .chatlog .sys.note, .chatlog .daydiv, .chatlog .dl-head .dl-note, .chatlog .dl-kicker { color: #555; }
  .chatlog .sys.topic { color: #7a5b00; }
  .chatlog .daydiv::before, .chatlog .daydiv::after, .chatlog .dl-head, .chatlog .dl-foot { border-color: #ccc; }
  .chatlog .dl-head h1, .chatlog .dl-head p, .chatlog .dl-foot p { color: #111; }
  .chatlog .line { break-inside: avoid; }
}`;
let CSS = null;
/** The ds tokens (public/css/ds.css :root) -> {name: value}. */
function dsTokens() {
  const src = fs.readFileSync(path.join(__dirname, "public", "css", "ds.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const i = src.indexOf(":root"), open = src.indexOf("{", i);
  let depth = 0, end = open;
  for (; end < src.length; end++) { if (src[end] === "{") depth++; else if (src[end] === "}" && --depth === 0) break; }
  const out = {};
  for (const m of src.slice(open + 1, end).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[m[1]] = m[2].trim();
  return out;
}
/** var(--ds-x[, fallback]) -> the token's value (nested ones too); other custom properties (a flair chip's --fl) stay. */
function literal(css, tokens) {
  const re = /var\(\s*(--ds-[a-z0-9-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/gi;
  let out = css;
  for (let i = 0; i < 6 && re.test(out); i++) {
    re.lastIndex = 0;
    out = out.replace(re, (m, name, fb) => (tokens[name] != null ? tokens[name] : fb != null ? fb.trim() : m));
  }
  return out;
}
/** The rules a file needs, with the token values written in (built once). */
function fileCss() {
  if (CSS != null) return CSS;
  const rd = (...p) => fs.readFileSync(path.join(__dirname, ...p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const chat = rd("public", "css", "chatlog.css");
  // the flair chip (padflair.js): its own three rules, as flair.css has them
  const flair = [];
  for (const m of rd("public", "css", "flair.css").matchAll(/(^|\})\s*(\.ufl(?:-e|-n)?)\s*\{([^}]*)\}/g)) flair.push(".chatlog " + m[2] + " {" + m[3].replace(/\s+/g, " ") + "}");
  const tokens = dsTokens();
  const lines = [BASE_CSS, chat, flair.join("\n"), PRINT_CSS].join("\n").split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
  CSS = literal(lines.join("\n"), tokens);
  return CSS;
}

// ── pictures: only files under the site's public root, <= 64 KB each, embedded once, 2 MB in all ──
// (Profile pictures are a CDN's https links - never fetched for a file: the letter bubble - or the site's own /public ones. The spec
// also names an "uploads" root, but nothing serves /uploads/ - it is multer's folder of raw uploads in flight - so no live page ever
// shows a picture from there, and a file never takes one from it.)
let ROOTS = () => [["/public/", path.join(__dirname, "public")]];
/** A profile picture's site path -> the real file under a root, or null (an https picture, "..", a symlink out, anything else). */
function avatarFile(src) {
  if (typeof src !== "string" || src.length > 300 || !/^\/[A-Za-z0-9/_.\-]+$/.test(src)) return null;
  if (src.split("/").some((seg) => seg === ".." || seg === ".")) return null;
  for (const [pre, root] of ROOTS()) {
    if (!src.startsWith(pre)) continue;
    try {
      const base = fs.realpathSync(root);
      const real = fs.realpathSync(path.resolve(root, src.slice(pre.length)));
      return real.startsWith(base + path.sep) ? real : null;
    } catch (e) { return null; }
  }
  return null;
}
/** PNG, JPEG, GIF or WebP by their magic bytes (nothing else - an SVG never goes into a file). */
function sniff(b) {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b.slice(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (b.length >= 12 && b.slice(0, 4).toString("latin1") === "RIFF" && b.slice(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
/** srcs -> {map: Map(src -> class), css: the rules carrying them} within the budgets. */
async function embedAvatars(srcs) {
  const map = new Map(), rules = [];
  let total = 0, n = 0;
  for (const src of srcs) {
    if (map.has(src) || n >= 400) continue;
    const file = avatarFile(src);
    if (!file) continue;
    try {
      const st = await fs.promises.stat(file);
      if (!st.isFile() || st.size > AVATAR_MAX || st.size <= 0) continue;
      const buf = await fs.promises.readFile(file);
      const type = sniff(buf);
      if (!type) continue;
      const uri = "data:" + type + ";base64," + buf.toString("base64");
      if (total + uri.length > AVATARS_TOTAL) continue;
      total += uri.length;
      const cls = "av-" + (++n);
      map.set(src, cls);
      rules.push(`.chatlog .av.${cls} { background: center / cover no-repeat url("${uri}"); }`);
    } catch (e) { /* the letter bubble */ }
  }
  return { map, css: rules.join("\n") };
}

// ── the file writer (pure: the golden files run it with fixed items) ──
const LINES_DEF = { one: "{n} line", other: "{n} lines" };
/** Is this (projected, dressed) item a line of the file? The same answer for every format: the chat shows it (its TXT form exists
 *  - renderItem draws exactly those; a 📜 note of a kind this build doesn't know is in no file, the JSONL's included). */
const shows = (it, ctx) => !!(it && CORE.textItem(it, ctx));
/** Header text on one line (a pad title, a room name: never a forged line in the TXT, never a control character). */
const flat = (s) => String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
const B_ESC = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/**
 * fmt html | txt | jsonl; meta {title, slug, room, adult, from, to, zone, lang, generated, by (username), origin, floor? (true: the
 * viewer's view starts inside the range - said, never when), css? (html: the stylesheet), avatarCss? (html)}; ctx = fileCtx(...).
 * -> {head(counts) -> text, item(it) -> text ("" for a kind the chat doesn't show; a day divider first when the day changes),
 *     foot(counts) -> text}. counts {lines, removed, privacy, truncated, next (ms), cut ({days, next} | null)}
 */
function writer(fmt, meta0, ctx) {
  const meta = Object.assign({}, meta0, { title: flat(meta0.title), room: flat(meta0.room), by: flat(meta0.by), zone: flat(meta0.zone || "UTC") });
  const t = ctx.t, nf = numFmt(meta.lang);
  const off = (ms) => (typeof ctx.offset === "function" ? ctx.offset(ms) : Number(ctx.offset) || 0);
  const at = (ms) => { const w = wallOf(ms, off(ms)); return ymd(w) + " " + hm(w); };
  const origin = String(meta.origin || siteBase()).replace(/\/+$/, "");
  const host = origin.replace(/^https?:\/\//, "");
  const padHref = origin + "/p/" + encodeURIComponent(meta.slug);
  const padLabel = host + "/p/" + meta.slug;
  const linesTxt = (n) => t("chatlog.file.lines", LINES_DEF, { count: n, n: nf(n) });
  const title = t("chatlog.file.title", "PATV chat log");
  const room = t("chatlog.file.room", "Camfrog room: {room}", { room: meta.room });
  const range = t("chatlog.file.range", "{from} → {to} · {zone} ({offset})", { from: at(meta.from), to: at(meta.to), zone: meta.zone, offset: offLabel(off(meta.from)) });
  const notice = t("chatlog.file.notice", "A copy: later removals and privacy changes aren't applied to it.");
  const autoTx = t("chatlog.file.auto_tx", "🎙 lines are automatic transcripts and may contain mistakes.");
  const adult = t("chatlog.file.adult", "18+");
  // the range reaches back past what this downloader can see of the pad - said without the moment it starts (that would tell when a
  // watermark moved: an owner change, an opening from Approved, a narrower window)
  const floorLine = meta.floor ? t("chatlog.file.floor", "Your view of this pad starts later than this range, so its earliest lines aren't in this file.") : null;
  const downloaded = (c) => t("chatlog.file.downloaded", "Downloaded {when} by {who}", { when: at(meta.generated), who: "@" + meta.by }) + " · " + linesTxt(c.lines);
  const tail = (c) => {
    const parts = [linesTxt(c.lines)];
    if (c.removed) parts.push(t("chatlog.file.left_removed", "{n} left out (removed by moderators)", { count: c.removed, n: nf(c.removed) }));
    if (c.privacy) parts.push(t("chatlog.file.left_privacy", "{n} left out (privacy)", { count: c.privacy, n: nf(c.privacy) }));
    return parts;
  };
  const cutLine = (c) => (c.truncated ? t("chatlog.file.cut_lines", "Cut at {n} lines — the next file starts at {when}.", { count: limits.linesMax, n: nf(limits.linesMax), when: at(c.next) })
    : c.cut ? t("chatlog.file.cut_days", "Cut at {n} days — the next file starts at {when}.", { count: c.cut.days, n: nf(c.cut.days), when: at(c.cut.next) }) : null);
  const none = t("chatlog.file.none", "No lines in this range.");
  let day = null, shown = 0;
  const dayKey = (ts) => { const w = wallOf(ts, off(ts)); return ymd(w); };
  const dayText = (ts) => CORE.dayLabel(ts, ctx);
  const H = CORE.htmlH;

  if (fmt === "txt") {
    return {
      head: (c) => [title + " · " + meta.title + " · " + padLabel + (meta.adult ? " · " + adult : ""), room, range, downloaded(c), notice, autoTx]
        .concat(floorLine ? [floorLine] : []).join("\n") + "\n\n",
      item: (it) => {
        const line = CORE.textItem(it, ctx);
        if (!line) return "";
        shown++;
        const k = dayKey(it.ts);
        let pre = "";
        if (k !== day) { pre = (day == null ? "" : "\n") + "── " + dayText(it.ts) + " ──\n"; day = k; }
        return pre + line + "\n";
      },
      foot: (c) => (shown ? "" : none + "\n") + "\n— " + tail(c).concat([FORMAT_V1]).join(" · ") + "\n" + (cutLine(c) ? "— " + cutLine(c) + "\n" : ""),
    };
  }
  if (fmt === "jsonl") {
    return {
      head: (c) => JSON.stringify(Object.assign({
        format: JSONL_ID, pad: { slug: String(meta.slug), title: String(meta.title), adult: !!meta.adult }, room: String(meta.room),
        from: CORE.localIso(meta.from, ctx), to: CORE.localIso(meta.to, ctx), tz: meta.zone, lang: meta.lang,
        generated_at: new Date(meta.generated).toISOString().replace(/\.\d{3}Z$/, "Z"), requested_by: String(meta.by),
        items: c.lines, left_out: { removed: c.removed, privacy: c.privacy }, truncated: !!c.truncated, notice,
      }, c.truncated ? { continue_from: CORE.localIso(c.next, ctx) } : c.cut ? { continue_from: CORE.localIso(c.cut.next, ctx) } : {})) + "\n",
      item: (it) => {
        const o = shows(it, ctx) ? CORE.jsonItem(it, ctx) : null;
        if (!o) return "";
        shown++;
        return JSON.stringify(o) + "\n";
      },
      foot: () => "",
    };
  }
  // html: one self-contained page - no scripts, no requests (its CSP says so too); the lines in exactly the live markup
  const dir = /^(ar|fa|he|ur)(-|$)/.test(String(meta.lang || "")) ? "rtl" : "ltr";
  const css = (meta.css != null ? meta.css : fileCss()) + (meta.avatarCss ? "\n" + meta.avatarCss : "");
  return {
    head: (c) => {
      const h1 = [meta.title];
      if (meta.adult) h1.push(H("span", { "class": "dl-adult" }, [adult]));
      const head = H("header", { "class": "dl-head" }, [
        H("p", { "class": "dl-kicker" }, [title]),
        H("h1", null, h1),
        H("p", null, [H("a", { href: padHref, rel: "nofollow noopener" }, [padLabel]), " · " + room]),
        H("p", null, [range]),
        H("p", null, [downloaded(c)]),
        H("p", { "class": "dl-note" }, [notice]),
        H("p", { "class": "dl-note" }, [autoTx]),
      ].concat(floorLine ? [H("p", { "class": "dl-note" }, [floorLine])] : []));
      return "<!doctype html>\n<html lang=\"" + B_ESC(meta.lang || "en") + "\" dir=\"" + dir + "\">\n<head>\n<meta charset=\"utf-8\">\n" +
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<meta name=\"robots\" content=\"noindex\">\n" +
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\">\n" +
        "<title>" + B_ESC(meta.title + " · " + title + " · " + at(meta.from).slice(0, 10) + " → " + at(meta.to).slice(0, 10)) + "</title>\n" +
        "<style>\n" + css + "\n</style>\n</head>\n<body class=\"chatlog\">\n" + String(head) + "\n" +
        "<main class=\"dl-log\" role=\"log\" aria-label=\"" + B_ESC(t("chatlog.file.log", "Chat log")) + "\">\n";
    },
    item: (it) => {
      const n = shows(it, ctx) ? CORE.renderItem(it, ctx, H) : null;
      if (!n) return "";
      shown++;
      const k = dayKey(it.ts);
      let pre = "";
      if (k !== day) { pre = String(H("h2", { "class": "daydiv" }, [dayText(it.ts)])) + "\n"; day = k; }
      return pre + String(n) + "\n";
    },
    foot: (c) => (shown ? "" : String(H("p", { "class": "dl-empty" }, [none])) + "\n") + "</main>\n" +
      String(H("footer", { "class": "dl-foot" }, [H("p", null, [tail(c).join(" · ")])].concat(cutLine(c) ? [H("p", null, [cutLine(c)])] : [],
        [H("p", null, [t("chatlog.file.footer", "Generated by {site} · {format}", { site: host, format: FORMAT_V1 })])]))) + "\n</body>\n</html>\n",
  };
}

// ── who may download here ──
async function established(user) {
  if (!ESTABLISHED_ONLY) return true;
  let row = null;
  try { row = (await getQuery("SELECT userId, username, class, level, camfrogUsername, discordId, twitchId FROM users WHERE userId = ?", [String(user.userId)]))[0] || null; }
  catch (e) { row = null; }
  if (!row) return false;
  const u = Object.assign({}, user, row);
  try { return !require("./messages").isNewAccount(u); } catch (e) {
    return !!(u.camfrogUsername || u.discordId || u.twitchId) || (Number(u.level) || 0) >= 2;        // the same rule, should messages.js fail to load
  }
}
/** The pad, the viewer's view, and every gate (signed in, pad access, history allowed, the pad's switch, established). */
async function access(user, slug, { checkEstablished = true } = {}) {
  if (!user || !user.userId) throw new Refuse(401, "Sign in to download this pad's chat.", "signin");
  await CL.init();
  const R = await require("./roomsweb").resolveRoom(String(slug || "").slice(0, 128)).catch(() => null);
  if (!R || !R.id) throw notFound();
  const roomId = R.id;
  let platform = "camfrog";
  try { platform = require("./rooms").platformOf(roomId); } catch (e) { platform = "camfrog"; }
  if (platform !== "camfrog") throw notFound();                         // a pad with no Camfrog room has no chat archive
  const PA = require("./padaccess");
  await PA.init();
  if (!PA.full(user, roomId)) throw notFound();
  const pm = require("./padmod");
  let login = null;
  try { login = await pm.linkedLogin(user.userId); } catch (e) { login = null; }
  if (login) { try { pm.noteViewer(roomId, login); } catch (e) { /* no mod caps this time */ } }
  const CV = require("./chatlogview");
  const V = await CV.view(roomId, user);
  if (!V.can.history) throw new Refuse(403, "This pad's chat history isn't available to you.", "no_history");
  if (!V.can.downloads) throw new Refuse(403, "This pad doesn't allow downloads of its chat.", "off_pad");
  if (checkEstablished && !(await established(user))) {
    throw new Refuse(403, "Downloads need an established account: reach level 2, or link your Camfrog, Discord or Twitch account.", "established");
  }
  let slugNow = R.slug;
  try { slugNow = require("./pads").padSlug(R) || R.slug; } catch (e) { slugNow = R.slug; }
  return { R, roomId, V, slug: String(slugNow || slug).toLowerCase() };
}

/** The floors a download reads to: the viewer's own - a Camfrog mod's are the PUBLIC ones (a demoted mod keeps the file). */
function floorsOf(V) {
  const CV = require("./chatlogview");
  if (V.role === "mod") {
    const audm = V.inside ? 0 : Number(V.aud_m) || 0;
    const chat = Math.max(V.pub.chat, audm), txf = Math.max(V.pub.tx, audm);
    return { chat, tx: txf, presence: Math.max(chat, V.now - CV.PRESENCE_MS), full: false };
  }
  return { chat: V.floor.chat, tx: V.floor.tx, presence: V.floor.presence, full: V.role === "owner" || V.role === "staff" };
}
/** Everything a read of the range needs: the floors (never before `from`), cursor bounds, the upper bound fixed now, the page SQL. */
async function planOf(A, { from, to, sys }) {
  const CV = require("./chatlogview");
  const V = A.V, f = floorsOf(V);
  const fl = { chat: Math.max(f.chat, from), tx: Math.max(f.tx, from), presence: Math.max(f.presence, from) };
  const P = { rk: V.rk, view: V, V: Object.assign({}, V, { floor: fl }), floors: fl, full: f.full, from, to, sys, lo: C_MAX, hi: 0,
              cb: { tx: C_MAX, presence: C_MAX, chat: C_MAX }, viewFloor: f.chat };
  if (V.rk == null) return P;
  const cb0 = await CV.cursorBounds(V.rk, fl);
  P.cb = { tx: cb0.tx == null ? C_MAX : cb0.tx, presence: !sys || cb0.presence == null ? C_MAX : cb0.presence, chat: cb0.chat == null ? C_MAX : cb0.chat };
  P.lo = Math.min(P.cb.tx, P.cb.presence, P.cb.chat);
  const seek = (await roRead("SELECT c FROM chat_log WHERE rk = ? AND ts >= ? ORDER BY ts LIMIT 1", [V.rk, Math.floor(to)]))[0];
  const top = (await roRead("SELECT c FROM chat_log WHERE rk = ? ORDER BY c DESC LIMIT 1", [V.rk]))[0];
  P.hi = Math.min(seek ? Number(seek.c) : C_MAX, top ? Number(top.c) + 1 : 0);
  P.sql = require("./chatloghist").pageSql({ dir: "after", sys, keepRemoved: true, approved: !!V.inside });
  return P;
}
/** Read [lo, upTo) in pages of PAGE_ROWS, ascending; onPage(rows) -> false stops. Stops when aborted(). */
async function walk(P, upTo, onPage, aborted) {
  let pos = P.lo - 1;
  for (;;) {
    if (aborted && aborted()) return false;
    const lo = Math.max(P.lo, pos + 1);
    if (!(lo < upTo)) break;
    const rows = await roRead(P.sql, [P.rk, lo, upTo, P.cb.tx, P.cb.presence, P.cb.chat, limits.pageRows]);
    if (!rows.length) break;
    pos = Number(rows[rows.length - 1].c);
    if ((await onPage(rows)) === false) return true;
    if (rows.length < limits.pageRows) break;
    await yieldNow();
  }
  return true;
}
/** One page through the projection: [{it, keep, why: privacy | removed | null}], in c order, inside [from, to). */
function sortPage(rows, P) {
  const CV = require("./chatlogview");
  const items = rows.map(CV.itemOf).filter((it) => it.ts >= P.from && it.ts < P.to);
  const fctx = { view: P.V, jc: null, now: P.view.now, noRemoved: true };
  const keep = new Set(CV.filter(items, fctx).items);
  return items.map((it) => {
    if (keep.has(it)) return { it, keep: true, why: null };
    const l = CV.filter([it], fctx).left;
    return { it, keep: false, why: l.privacy ? "privacy" : l.removed ? "removed" : null };
  });
}
/**
 * The first pass: what the header says - lines (at most LINES_MAX), left out, where a cut file stops - and the pictures of the
 * people the file shows BY NAME (each line dressed exactly as the second pass will: an incognito person's line is "someone" and
 * brings no picture). M = the file's name map (filled here, reused by the second pass), F = the pad's flair.
 */
async function countPass(P, aborted, M = new Map(), F = null, ctx = fileCtx()) {
  const out = { lines: 0, removed: 0, privacy: 0, lastC: null, truncated: false, next: null, avatars: [], below: { lo: null, hi: null } };
  if (P.rk == null || !(P.lo < P.hi)) return out;
  const CV = require("./chatlogview");
  let pend = { removed: 0, privacy: 0 };
  const pics = new Set();
  await walk(P, P.hi, async (rows) => {
    const xs = sortPage(rows, P);
    const dressed = await dressPage(xs.filter((x) => x.keep).map((x) => x.it), P, M, F);
    let j = 0;
    for (const x of xs) {
      if (!x.keep) { if (x.why) pend[x.why]++; continue; }
      const o = dressed[j++];
      if (!shows(o, ctx)) continue;                                  // a kind the chat doesn't show is in no file
      if (out.lines >= limits.linesMax) { out.truncated = true; out.next = o.ts; return false; }
      out.lines++; out.removed += pend.removed; out.privacy += pend.privacy; pend = { removed: 0, privacy: 0 };
      out.lastC = o.c;
      // CL10 fix-up: the span a staff file will hold below the public floor (chat, 🎙, presence's 24 h) - audited BEFORE it is sent
      if (P.view.audit && o.ts < CV.pubFloor(P.view, o.k)) {
        if (out.below.lo == null || o.ts < out.below.lo) out.below.lo = o.ts;
        if (out.below.hi == null || o.ts > out.below.hi) out.below.hi = o.ts;
      }
      const u = o.u;
      if (u && !u.anon && !u.former && u.patv && typeof u.patv.avatar === "string" && u.patv.avatar.charAt(0) === "/") pics.add(u.patv.avatar);
    }
    return true;
  }, aborted);
  if (!out.truncated) { out.removed += pend.removed; out.privacy += pend.privacy; }
  out.avatars = [...pics];
  return out;
}

/** The file's own name resolver (bridge.resolveNames' rules - UL.lookup linked logins only, u:<id> by id, the private flag failing
 *  closed - in a Map of its own, so a big file never evicts the live chat's name cache). Fills M; -> M. Only for the speakers the file
 *  NAMES (the caller leaves out everyone the projection anonymises). A lookup that fails throws (code "names"): a live page can show
 *  a line by its Camfrog name for a moment, a file keeps it - so the file fails instead (a private account's joins would otherwise
 *  carry its name, a deleted web account would keep its stored name). */
async function namesInto(users, M) {
  const B = require("./bridge"), UL = require("./userlinks");
  const miss = new Set(), missIds = new Set();
  for (const u of users) {
    if (!u || u.anon || u.former || !u.login) continue;
    const k = B.nameKey(u.login);
    if (!k || M.has(k)) continue;
    (k.startsWith("u:") ? missIds : miss).add(k);
  }
  const failed = () => Object.assign(new Error("names"), { code: "names" });
  const hitL = [], hitI = [];
  const ids = [...missIds].map((k) => k.slice(2));
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    let found = null;
    try { found = await UL.resolve({ ids: part }); } catch (e) { found = null; }
    if (!found || !found.ids || typeof found.ids.get !== "function") throw failed();
    for (const id of part) { const acc = found.ids.get(id) || null; M.set("u:" + id, { acc, priv: true }); if (acc) hitI.push(id); }
  }
  const keys = [...miss];
  for (let i = 0; i < keys.length; i += 400) {
    const part = keys.slice(i, i + 400);
    let found = null;
    try { found = await UL.lookup(part, { linkedOnly: true }); } catch (e) { found = null; }
    if (!found || typeof found.get !== "function") throw failed();
    for (const k of part) { const acc = found.get(k) || null; M.set(k, { acc, priv: true }); if (acc) hitL.push(k); }
  }
  if (hitL.length || hitI.length) {
    let pv = null;
    try { pv = await require("./chatlogview").privateFlags({ logins: hitL, ids: hitI }); } catch (e) { pv = null; }
    for (const k of hitL) M.get(k).priv = pv ? pv.logins.has(k) : true;          // unknown = private: their joins / leaves are "someone"
    for (const id of hitI) M.get("u:" + id).priv = pv ? pv.ids.has(id) : true;
  }
  return M;
}
/**
 * Kept items (in c order) -> the lines exactly as the file shows them: the speakers it names looked up first (never anyone the
 * projection anonymises or leaves out - chatlogview.privacyOf), then chatlogview.dress (incognito -> "someone", private presence ->
 * "someone", former members, hidden names redacted inside the text) and bridge.withPatv (today's PATV name, picture, style, flair).
 */
async function dressPage(kept, P, M, F) {
  if (!kept.length) return [];
  const B = require("./bridge"), CV = require("./chatlogview");
  await namesInto(kept.filter((it) => CV.privacyOf(it) == null).map((it) => it.u).filter(Boolean), M);
  const dressed = CV.dress(kept, { view: P.V, lookup: (u) => M.get(B.nameKey(u.login)) });
  return dressed.map((it) => (it.u ? Object.assign({}, it, { u: B.withPatv(it.u, M, F) }) : it));
}

// ── the limits (in the database: they survive a restart) ──
/** Downloads answer only while both switches are on: chatlog.downloads AND chatlog.history (CL10 fix-up - a file is an archive
 *  read beyond the live tail, like scrollback and search; turning history off as an emergency stop stops them too). */
const dlOn = () => CL.on("downloads") && CL.on("history");
/** Does this chatlog_exports row count toward the account's 10 a day? (COUNT_UNUSED / COUNT_CUT above.) items is NULL on a failed
 *  or aborted row exactly when nothing reached the downloader - set from the moment the file's header is written. */
function counts(r, t) {
  if (r.state === "failed" || r.state === "aborted") return COUNT_CUT && r.items != null;
  if (r.state === "issued") return COUNT_UNUSED || Number(r.created) > t - TOKEN_TTL_MS;
  return true;                                                         // done, streaming
}
async function claimLimits(uid, t) {
  const mine = await getQuery("SELECT state, items, created FROM chatlog_exports WHERE user_id = ? AND created > ?", [uid, t - DAY]);
  if (mine.filter((r) => Number(r.created) > t - 60e3).length >= limits.perMin) throw new Refuse(429, "Slow down - try again in a minute.", "rate", { retry: 60 });
  if (mine.filter((r) => counts(r, t)).length >= limits.perDay) throw new Refuse(429, "That's 10 chat-log downloads in a day - try again tomorrow.", "limit_day");
  await streamsFree(uid);
}
async function streamsFree(uid) {
  const r = (await getQuery("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN user_id = ? THEN 1 ELSE 0 END), 0) AS me FROM chatlog_exports WHERE state = 'streaming'", [uid]))[0];
  if (Number(r.me) >= USER_STREAMS) throw new Refuse(429, "Your other download is still being made - try again when it's done.", "busy_me", { retry: 10 });
  if (Number(r.n) >= limits.siteStreams) throw new Refuse(429, "Too many chat logs are being made right now - try again in a minute.", "busy", { retry: 30 });
}

/**
 * How many lines the file would hold - exactly what the projection keeps (CL10 fix-up: the old count of archived rows between the
 * cursor bounds counted !bridge hide people's lines, taken-down lines, Pepe's anonymised presence and presence past a member's 24 h -
 * a per-millisecond oracle). The same pass as the file's first one, without names (whether a line shows never depends on them): the
 * floors, the audience, the sticky hidden set, takedowns, the kinds a file shows. It stops past LINES_MAX lines (what the downloader
 * can see - never how many rows it read). -> {lines, more} | {lines: null, more: null} when ESTIMATES_AT_ONCE passes are already
 * running on the site (the dialog then just says the download is starting).
 */
async function estimate(P) {
  if (P.rk == null || !(P.lo < P.hi)) return { lines: 0, more: false };
  if (ESTIMATING >= limits.estimates) return { lines: null, more: null };
  ESTIMATING++;
  try {
    const CV = require("./chatlogview"), ctx = fileCtx();
    let n = 0, more = false;
    await walk(P, P.hi, async (rows) => {
      const kept = sortPage(rows, P).filter((x) => x.keep).map((x) => x.it);
      for (const o of CV.dress(kept, { view: P.V })) {
        if (!shows(o, ctx)) continue;
        if (n >= limits.linesMax) { more = true; return false; }
        n++;
      }
      return true;
    });
    return { lines: n, more };
  } finally { ESTIMATING--; }
}

/** POST: ask for a file. env = {tz, lang} (the request's). -> {ok, url, estimate, tz, from, to, cut?} | throws Refuse */
async function request(user, slug, body = {}, env = {}) {
  if (!dlOn()) throw new Refuse(404, "Chat downloads aren't available here yet.", "off");
  await init();
  const A = await access(user, slug);
  const b = body && typeof body === "object" ? body : {};
  const fmt = String(b.fmt || "");
  if (!Object.prototype.hasOwnProperty.call(FMTS, fmt)) throw new Refuse(400, "Pick a format: web page, text or data.", "bad_fmt");
  const sys = bool(b.sys);
  const zone = env.tz || "UTC", lang = env.lang || "en";
  const t = now();
  const rg = rangeOf(b, zone, t);
  const uid = String(user.userId);
  await claimLimits(uid, t);                                         // before the work below (checked again with the insert)
  const P = await planOf(A, { from: rg.from, to: rg.to, sys });
  const est = await estimate(P);
  const tok = crypto.randomBytes(16).toString("hex"), id = idOf(tok);
  // the zone, the language and a 31-day cut live with the row (CL10 fix-up: a restart between the POST and the GET kept none of them)
  await tx(async () => {
    await claimLimits(uid, t);
    await runQuery(`INSERT INTO chatlog_exports (id, user_id, rk, from_ts, to_ts, fmt, sys, role, items, bytes, state, created, tz, lang, cut_next)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'issued', ?, ?, ?, ?)`,
                   [id, uid, A.V.rk, rg.from, rg.to, fmt, sys ? 1 : 0, A.V.role, t, String(zone).slice(0, 64), String(lang).slice(0, 16), rg.cut ? rg.cut.next : null]);
  });
  return Object.assign({ ok: true, url: "/p/" + encodeURIComponent(A.slug) + "/chatlog/dl/" + tok, estimate: est, tz: zone, from: rg.from, to: rg.to,
                         full: P.full }, rg.cut ? { cut: rg.cut } : {});
}

/**
 * res.write with backpressure and a stall limit (CL10 fix-up: a client that stopped reading held one of the site's 3 slots until its
 * socket closed - Node's server.timeout is 0). -> async write(s): resolves once the socket takes more, it closes, or `drainMs`
 * passes with nothing taken - then onStall() (the caller cuts the connection and fails the file). write.bytes() = what was handed
 * to the socket. Nothing is written once gone() says the download is over.
 */
function sink(res, { drainMs, onStall, gone }) {
  let bytes = 0;
  const write = async (s) => {
    if (!s || gone()) return;
    bytes += Buffer.byteLength(s, "utf8");
    if (res.write(s)) return;
    await new Promise((resolve) => {
      let tm = null;
      const done = () => { clearTimeout(tm); res.removeListener("drain", done); res.removeListener("close", done); resolve(); };
      tm = setTimeout(() => { done(); onStall(); }, drainMs);
      res.on("drain", done);
      res.on("close", done);
    });
  };
  write.bytes = () => bytes;
  return write;
}

// CL10 fix-up: where a refused link sends the browser - back to the pad, whose page says why in the viewer's own language
// (pad-download.js reads ?cldl=<code>). The dialog starts a file by following a link, so the plain English page these refusals
// used to be replaced the pad page. Only the code travels - never a message, a name or anything about the file.
const CLDL_CODES = new Set(["gone", "signin", "off", "rate", "busy", "busy_me", "no_history", "off_pad", "established", "not_found", "failed"]);
function backTo(res, slug, code) {
  const s = String(slug == null ? "" : slug).toLowerCase();
  const to = /^[a-z0-9][a-z0-9-]{0,127}$/.test(s) ? "/p/" + s : "/";
  res.set("Cache-Control", "private, no-store");
  return res.redirect(303, to + "?cldl=" + (CLDL_CODES.has(code) ? code : "failed"));
}
const moved = () => Object.assign(new Error("moved"), { code: "moved" });
const zoneOk = (z) => { try { return require("./tz").valid(z) || null; } catch (e) { return null; } };

/**
 * GET: make the file and stream it. Every refusal is a 303 back to the pad (?cldl=<code>). The link is looked up first - its own
 * account's, still issued, not expired - so a made-up token costs one keyed read, never a view (CL10 fix-up); fetches are limited
 * per account (GET_PER_MIN). Then the full gate (access), then the claim (one streaming per account, SITE_STREAMS on the site).
 */
async function download(req, res) {
  res.set({ "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow, noarchive", "X-Content-Type-Options": "nosniff" });
  let slug = req.params.slug;
  const back = (code) => backTo(res, slug, code);
  if (!dlOn()) return back("off");
  const user = req.user;
  if (!user || !user.userId) return back("signin");
  const uid = String(user.userId);
  if (!GET_HIT) GET_HIT = require("./middleware/authGuard").limiter({ max: limits.getPerMin, windowMs: 60e3 });
  if (GET_HIT.blocked(uid)) return back("rate");
  GET_HIT.hit(uid);
  const tok = String(req.params.token || "");
  if (!/^[a-f0-9]{32}$/.test(tok)) return back("gone");
  const id = idOf(tok);
  const usable = (r, t) => !!r && String(r.user_id) === uid && r.state === "issued" && Number(r.created) > t - TOKEN_TTL_MS;
  try {
    await init();
    if (!usable((await getQuery("SELECT user_id, state, created FROM chatlog_exports WHERE id = ?", [id]))[0], now())) return back("gone");
  } catch (e) {
    console.error("[chatlogexport] link:", (e && e.code) || "error");
    return back("failed");
  }
  let A;
  try { A = await access(user, slug); } catch (e) {
    if (e && e.refuse) return back(e.code);
    console.error("[chatlogexport] access:", (e && e.code) || "error");
    return back("failed");
  }
  slug = A.slug;
  const t = now();
  let row = null;
  try {
    await tx(async () => {
      const r = (await getQuery("SELECT * FROM chatlog_exports WHERE id = ?", [id]))[0];
      if (!usable(r, t) || Number(r.rk) !== Number(A.V.rk)) throw new Refuse(410, "gone", "gone");
      await streamsFree(uid);
      const u = await runQuery("UPDATE chatlog_exports SET state = 'streaming' WHERE id = ? AND state = 'issued'", [id]);
      if (!u || u.changes !== 1) throw new Refuse(410, "gone", "gone");
      row = r;
    });
  } catch (e) {
    if (e && e.refuse) return back(e.code);
    console.error("[chatlogexport] claim:", (e && e.code) || "error");
    return back("failed");
  }
  return stream(req, res, { A, row, user, id, back });
}

/**
 * The claimed link -> the file, written as it is made. Two passes over the same rows (the upper bound fixed by planOf):
 *   pass 1 (nothing sent yet - any failure is still a redirect "try again"): the header's counts, the names the lines show (looked up
 *     once, into the file's own map M), the pictures of the people it names, the span a staff file holds below the public floor;
 *   the staff audit row for that span, written BEFORE anything is sent (CL10 fix-up: a crash mid-file left no row);
 *   pass 2: the lines, page by page.
 * CL10 fix-up - one privacy state per file: the version of the sticky hidden set, the redaction and this room's takedowns
 * (chatlogview.privacyVer) is pinned when pass 1 starts. Pass 1 is made again (MOVED_TRIES) when it moved under it - so a person who
 * went incognito or typed !bridge hide meanwhile leaves no picture, count or name of theirs behind - and pass 2 checks it before
 * every write: a move then fails the file (the connection is cut; the browser marks the download failed) - nothing is ever written
 * under a state other than the one its header was counted under (a file can't take "the next answer drops it").
 * CL10 fix-up - a deadline: STREAM_MAX_MS for the whole download and DRAIN_MAX_MS for a socket that takes nothing; either one cuts
 * the connection, marks the file failed and frees the slot.
 */
async function stream(req, res, { A, row, user, id, back }) {
  const CV = require("./chatlogview");
  const zone = (row.tz && zoneOk(row.tz)) || zoneOf(req), lang = row.lang || req.lang || "en";
  const fmt = FMTS[row.fmt] ? row.fmt : "txt";
  const from = Number(row.from_ts), to = Number(row.to_ts);
  const cut0 = Number(row.cut_next) > 0 ? { days: DAYS_MAX, next: Number(row.cut_next) } : null;   // the 31-day cut (kept with the row)
  const tally = { lines: 0, removed: 0, privacy: 0 };
  let aborted = false, finished = false, stalled = false, sent = false;
  const started = now();
  const kill = () => {
    if (finished || stalled) return;
    stalled = true; aborted = true;
    try { res.destroy(); } catch (e) { /* gone */ }
  };
  const deadline = setTimeout(kill, limits.streamMs);
  // the same limit by the module's clock, read at every page (and how the tests move time)
  const stop = () => { if (!aborted && now() - started > limits.streamMs) kill(); return aborted; };
  res.on("close", () => { if (!finished) aborted = true; });
  const sock = res.socket || req.socket;
  if (!sock || sock.destroyed) aborted = true;          // gone while the link was checked (its "close" came before this listener)
  const write = sink(res, { drainMs: limits.drainMs, onStall: kill, gone: () => aborted });
  const mark = (state, items) => runQuery("UPDATE chatlog_exports SET state = ?, items = ?, bytes = ? WHERE id = ?", [state, items == null ? null : items, write.bytes(), id])
    .catch((e) => console.error("[chatlogexport] state:", (e && e.code) || "error"));
  // a file that didn't finish: items NULL when nothing reached the downloader (never counted), else the lines written (COUNT_CUT)
  const ended = (state) => mark(state, sent ? tally.lines : null);
  const cutOff = () => ended(stalled ? "failed" : "aborted");
  // what pass 2 wrote below the public floor - widens the audit row if it ever reached past what pass 1 planned (it can't: same rows)
  const below = { lo: null, hi: null };
  const audit = () => {
    if (!A.V.audit || below.lo == null) return;
    CV.auditRead(A.V, A.roomId, "download", below.lo, below.hi).catch(() => {});
  };
  const pinOf = () => CV.privacyVer(A.V.rk) + (CL.hiddenReady() ? "" : "|loading");
  try {
    const sys = !!Number(row.sys);
    const P = await planOf(A, { from, to, sys });
    const offF = (ms) => makeTz.offset(zone, ms);
    const fname = "patv-" + String(A.slug).replace(/[^a-z0-9-]+/g, "-").slice(0, 60) + "-chat-" + ymd(wallOf(from, offF(from)), "") + "-" +
                  ymd(wallOf(to - 1, offF(to - 1)), "") + "." + FMTS[fmt].ext;
    const B = require("./bridge");
    let F = null;
    try { F = await require("./padflair").byUsername(A.roomId); } catch (e) { F = null; }
    // pass 1, under one privacy state
    let prep = null;
    for (let i = 0; i < MOVED_TRIES && !prep && !stop(); i++) {
      const pin = pinOf(), M = new Map();
      const count = await countPass(P, stop, M, F, fileCtx({ zone, lang }));
      if (stop()) break;
      const av = fmt === "html" ? await embedAvatars(count.avatars) : { map: new Map(), css: "" };
      if (pinOf() === pin) prep = { pin, M, count, av };
    }
    if (aborted) { await cutOff(); return; }
    if (!prep) throw moved();
    const { M, count, av } = prep;
    const by = await byName(user);
    if (A.V.audit && count.below.lo != null) await CV.auditRead(A.V, A.roomId, "download", count.below.lo, count.below.hi, { strict: true });
    if (stop()) { await cutOff(); return; }
    if (pinOf() !== prep.pin) throw moved();
    const reg = (() => { try { return require("./rooms").getCached(A.roomId); } catch (e) { return null; } })();
    const live = (() => { try { return B._rooms.get(A.roomId) || null; } catch (e) { return null; } })();
    const meta = { title: (reg && reg.title) || (live && live.name) || A.roomId, slug: A.slug, room: (live && live.name) || A.roomId, adult: !!(reg && reg.adult),
                   from, to, zone, lang, generated: now(), by, origin: siteBase(),
                   floor: P.viewFloor > from + 60e3 && P.viewFloor < to, avatarCss: av.css };
    const ctx = fileCtx({ zone, lang, origin: meta.origin, avatars: av.map });
    const W = writer(fmt, meta, ctx);
    const cut = count.truncated ? null : cut0;
    res.status(200);
    res.set({ "Content-Type": FMTS[fmt].type, "Content-Disposition": `attachment; filename="${fname}"`, "X-Accel-Buffering": "no",
              "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox" });
    sent = true;
    await write(W.head({ lines: count.lines, removed: count.removed, privacy: count.privacy, truncated: count.truncated, next: count.next, cut }));
    // pass 2: the same rows (up to where the count stopped), dressed the same way, written page by page
    const upTo = count.truncated ? Number(count.lastC) + 1 : P.hi;
    let pend = { removed: 0, privacy: 0 };
    if (P.rk != null && P.lo < upTo) {
      await walk(P, upTo, async (rows) => {
        const xs = sortPage(rows, P);
        const dressed = await dressPage(xs.filter((x) => x.keep).map((x) => x.it), P, M, F);
        let out = "", j = 0, add = 0;
        const span = { lo: below.lo, hi: below.hi };
        for (const x of xs) {
          if (!x.keep) { if (x.why) pend[x.why]++; continue; }
          const o = dressed[j++];
          if (tally.lines + add >= limits.linesMax) break;
          const s = W.item(o);
          if (!s) continue;
          out += s;
          add++; tally.removed += pend.removed; tally.privacy += pend.privacy; pend = { removed: 0, privacy: 0 };
          if (A.V.audit && o.ts < CV.pubFloor(A.V, o.k)) {
            if (span.lo == null || o.ts < span.lo) span.lo = o.ts;
            if (span.hi == null || o.ts > span.hi) span.hi = o.ts;
          }
        }
        // nothing is written under another privacy state than the header's (checked with no await between it and the write)
        if (pinOf() !== prep.pin) throw moved();
        await write(out);
        tally.lines += add; below.lo = span.lo; below.hi = span.hi;
        return tally.lines < limits.linesMax;
      }, stop);
    }
    if (!count.truncated) { tally.removed += pend.removed; tally.privacy += pend.privacy; }
    if (stop()) { await cutOff(); audit(); return; }
    await write(W.foot({ lines: tally.lines, removed: tally.removed, privacy: tally.privacy, truncated: count.truncated, next: count.next, cut }));
    if (aborted) { await cutOff(); audit(); return; }
    finished = true;
    res.end();
    await mark("done", tally.lines);
    audit();
  } catch (e) {
    console.error("[chatlogexport] download failed:", (e && e.code) || "error");
    await ended("failed");
    audit();
    if (!res.headersSent && !aborted) {
      for (const h of ["Content-Type", "Content-Disposition", "Content-Security-Policy", "X-Accel-Buffering"]) res.removeHeader(h);
      return back("failed");
    }
    // half a file must never look whole: the connection is cut (the browser marks the download failed), no footer is written
    finished = true;
    try { res.destroy(); } catch (x) { /* gone */ }
  } finally {
    clearTimeout(deadline);
  }
}
/** The downloader as the file names them: their PATV username (never an account id). */
async function byName(user) {
  if (user && user.username) return String(user.username);
  try {
    const r = (await getQuery("SELECT username FROM users WHERE userId = ?", [String(user.userId)]))[0];
    if (r && r.username) return String(r.username);
  } catch (e) { /* below */ }
  return "member";
}
/** The request's zone: tz.js's middleware (req.tz), else the account's zone, else the patv_tz cookie, else UTC. */
function zoneOf(req) {
  try {
    const TZ = require("./tz");
    if (req.tz) return TZ.valid(req.tz) || "UTC";
    const cookie = req.cookies && req.cookies[TZ.COOKIE];
    return TZ.negotiate({ user: TZ.getPref(req.user && req.user.userId), cookie });
  } catch (e) { return "UTC"; }
}

// ── the person's own list (Settings › Account) and the admins' (/admin/bridge) ──
async function mine(userId) {
  // CL10 fix-up: a link that was never used counts toward the day (COUNT_UNUSED), so it is listed too, as "unused" - only a link still
  // within its 2 minutes isn't (it is on its way)
  const t = now();
  const rows = await getQuery(`SELECT e.from_ts, e.to_ts, e.fmt, e.sys, e.items, e.bytes, e.state, e.created, r.room_id FROM chatlog_exports e
                               LEFT JOIN chatlog_rooms r ON r.rk = e.rk WHERE e.user_id = ? AND e.created > ? AND (e.state <> 'issued' OR e.created <= ?)
                               ORDER BY e.created DESC LIMIT 100`, [String(userId), t - KEEP_MS, t - TOKEN_TTL_MS]);
  return rows.map((r) => Object.assign({ from: Number(r.from_ts) || null, to: Number(r.to_ts) || null, fmt: r.fmt, sys: !!Number(r.sys),
                                         items: r.items == null ? null : Number(r.items), bytes: r.bytes == null ? null : Number(r.bytes),
                                         state: r.state === "issued" ? "unused" : r.state, created: Number(r.created) }, { pad: padOf(r.room_id) }));
}
function padOf(roomId) {
  if (!roomId) return null;
  try {
    const reg = require("./rooms").getCached(roomId);
    if (!reg) return { title: roomId, slug: null };
    return { title: reg.title || roomId, slug: require("./pads").padSlug(reg) || reg.slug || null };
  } catch (e) { return { title: roomId, slug: null }; }
}
/** The admin card: the last 50 downloads (who, which pad, range, format, lines, state - never content) + today's count. */
async function adminRows() {
  const t = now();
  const rows = await getQuery(`SELECT e.user_id, e.from_ts, e.to_ts, e.fmt, e.sys, e.role, e.items, e.bytes, e.state, e.created, r.room_id, u.username
                               FROM chatlog_exports e LEFT JOIN chatlog_rooms r ON r.rk = e.rk LEFT JOIN users u ON u.userId = e.user_id
                               WHERE e.state <> 'issued' ORDER BY e.created DESC LIMIT 50`).catch(() => []);
  const day = (await getQuery("SELECT COUNT(*) AS n FROM chatlog_exports WHERE created > ? AND state IN ('done','streaming')", [t - DAY]).catch(() => [{ n: 0 }]))[0];
  const live = (await getQuery("SELECT COUNT(*) AS n FROM chatlog_exports WHERE state = 'streaming'").catch(() => [{ n: 0 }]))[0];
  return { day: Number(day.n) || 0, streaming: Number(live.n) || 0, keep_days: KEEP_MS / DAY,
           rows: rows.map((r) => ({ who: r.username || null, pad: padOf(r.room_id), from: Number(r.from_ts) || null, to: Number(r.to_ts) || null, fmt: r.fmt,
                                    sys: !!Number(r.sys), role: r.role, items: r.items == null ? null : Number(r.items), bytes: r.bytes == null ? null : Number(r.bytes),
                                    state: r.state, at: Number(r.created) })) };
}

// ── upkeep: at boot `streaming` -> `failed` (a deploy mid-download); rows older than 90 days go ──
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await CL.init();
      // CL10 fix-up: the zone, the language and a 31-day cut live with the row (a table made before them gets the columns)
      const cols = (await getQuery("SELECT name FROM pragma_table_info('chatlog_exports')")).map((c) => c.name);
      for (const [c, type] of [["tz", "TEXT"], ["lang", "TEXT"], ["cut_next", "INTEGER"]]) {
        if (!cols.includes(c)) await runQuery(`ALTER TABLE chatlog_exports ADD COLUMN ${c} ${type}`);
      }
      const r = await runQuery("UPDATE chatlog_exports SET state = 'failed' WHERE state = 'streaming'");
      if (r && r.changes) console.log(`[chatlogexport] ${r.changes} download(s) cut off by the restart marked failed`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
async function sweep() {
  const r = await runQuery("DELETE FROM chatlog_exports WHERE created < ?", [now() - KEEP_MS]);
  return (r && r.changes) || 0;
}
let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => sweep().catch((e) => console.error("[chatlogexport] sweep:", (e && e.code) || "error")), 6 * 3600e3);
  if (timer.unref) timer.unref();
}

function register(app, { addUser }) {
  const express = require("express");
  const guard = require("./middleware/authGuard");
  const json = express.json({ limit: "4kb" });
  init().then(() => sweep()).catch((e) => console.error("[chatlogexport] init:", e.message));
  start();
  const head = (res) => res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive" });
  app.post("/api/rooms/:slug/chatlog/export", addUser, json, async (req, res) => {
    head(res);
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page.", code: "origin" });
    try {
      await init();
      res.json(await request(req.user, req.params.slug, req.body && typeof req.body === "object" ? req.body : {}, { tz: zoneOf(req), lang: req.lang || "en" }));
    } catch (e) {
      if (e && e.refuse) {
        if (e.retry) res.set("Retry-After", String(e.retry));
        return res.status(e.status || 400).json({ ok: false, error: e.message, code: e.code || undefined });
      }
      console.error("[chatlogexport] request failed:", (e && e.code) || "error");
      res.status(500).json({ ok: false, error: "Couldn't start the download - try again." });
    }
  });
  app.get("/p/:slug/chatlog/dl/:token", addUser, (req, res) => download(req, res));
  app.get("/api/account/chatlog-downloads", addUser, async (req, res) => {
    head(res);
    if (!req.user || !req.user.userId) return res.status(401).json({ ok: false });
    try { res.json({ ok: true, on: dlOn(), keep_days: KEEP_MS / DAY, downloads: await mine(req.user.userId) }); }
    catch (e) { res.status(500).json({ ok: false }); }
  });
}

module.exports = {
  register, init, start, sweep, request, download, writer, fileCtx, fileCss, literal, dsTokens, rawT, rangeOf, timeIn, localMidnight, offLabel,
  avatarFile, embedAvatars, sniff, namesInto, dressPage, shows, floorsOf, planOf, countPass, estimate, mine, adminRows, idOf, zoneOf, Refuse,
  ESTABLISHED_ONLY, DAYS_MAX, LINES_MAX, PAGE_ROWS, PER_MIN, PER_DAY, USER_STREAMS, SITE_STREAMS, TOKEN_TTL_MS, KEEP_MS, AVATAR_MAX, AVATARS_TOTAL,
  FORMAT_V1, JSONL_ID, FMTS,
  // CL10 fix-up
  sink, counts, dlOn, localTime, CLDL_CODES, STREAM_MAX_MS, DRAIN_MAX_MS, MOVED_TRIES, ESTIMATES_AT_ONCE, GET_PER_MIN, COUNT_UNUSED, COUNT_CUT,
  _setClock: (f) => { clock = f || (() => Date.now()); },
  _setLimits: (o) => { Object.assign(limits, o || {}); if (o && o.getPerMin != null) GET_HIT = null; },
  _reset: () => { Object.assign(limits, LIMITS0); GET_HIT = null; ESTIMATING = 0; clock = () => Date.now(); },
  _boot: () => { ready = null; return init(); },
  _cssReset: () => { CSS = null; },
  _setRoots: (list) => { ROOTS = list ? () => list : () => [["/public/", path.join(__dirname, "public")]]; },
};
