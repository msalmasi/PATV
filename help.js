// help.js - Pepe's command help at /help (1.99fq) + the "ask how to do something" prompter.
//
// THE DATA is Pepe's (camfrog-bot help/catalog.json + tools/build_help.py, which reads aliases, prices, mod grants and
// room-feature gates off the bot's code). Pepe publishes it here with the bot token whenever it changes - with the admin
// panel's LIVE prices - so each site shows the help of the Pepe deployed on it:
//   POST /api/pepe/help/sync {hash, version, data}        (bot token) -> stored in help_kv 'data'
//     (1.99afi: a card over HELP_LIMITS is clipped or left out, not the whole sync refused - see the data section)
// Before the first sync (a fresh DB) the committed copy data/help-commands.json is used (the build writes it with
// --site). Pages: GET /help (GET /commands -> 301 /help), the cards grouped in the 10 categories, deep links
// /help#cmd-<id> (and /help#cmd-<any command or alias>, resolved by the page), ?q= prefills the search.
//
// THE PROMPTER (POST /api/help/ask {q}):
//   1. a local ranking of the data (public/js/helpsearch.js - the same file the page runs in the browser) -> the best
//      cards. The page shows these instantly, before it even asks the server.
//   2. signed-in users only, when the AI answers are on and Pepe is pulling: the question + the 15 best cards go into an
//      in-memory queue; Pepe's long-poll (POST /api/pepe/help/pull, bot token) takes it, his registry's "help" function
//      (cheap tier) answers from THOSE cards only, POST /api/pepe/help/answer. The answer is checked again here: ids
//      must be candidates, and an answer naming any !command that isn't on a candidate card is thrown away.
//   3. no Pepe / slow Pepe (ANSWER_WAIT) / a bad answer -> the search results alone, never an error.
// Why signed-out visitors get search only: every AI answer is a paid model call, and a per-IP quota is easy to dodge
// (rotating addresses) and unfair to shared ones (one NAT, many people). The local search answers most "how do I"
// questions on its own, so signing in is only needed for the extra.
// Limits (signed in): USER_BURST per 10 min + USER_DAY per day each, IP_HOUR per IP per hour (all accounts on it),
// QUEUE_MAX waiting questions site-wide. Over a limit -> search results + a note.
//
// MISSES (help_misses): questions with no good answer - the search's best score under MISS_SCORE and no AI answer with
// a command - are logged (question, signed-in user id, best score, why) for the admins: /admin/help, so the help can
// be improved. No IPs are stored.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const SHUTDOWN = require("./shutdown");
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)
const HS = require("./public/js/helpsearch");

const FALLBACK_FILE = path.join(__dirname, "data", "help-commands.json");
const CAT_IDS = ["start", "chat", "games", "wallet", "markets", "heists", "stage", "music", "moderation", "admin"];
const ROLES = ["everyone", "mod", "owner", "admin"];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const CMD_RE = /^![a-z0-9_]{1,40}$/;
const Q_MIN = 2, Q_MAX = 200;
const CANDIDATES = 15;
const ANSWER_WAIT = 12e3;           // how long /api/help/ask waits for Pepe
const PULL_WAIT_MAX = 10e3;         // Pepe's long-poll (staging's router gives a POST 15 s)
const PULL_MAX_JOBS = 4;
const CLAIM_TTL = 30e3;
const JOB_TTL = 60e3;
const ONLINE_MS = 40e3;             // Pepe counts as online while he pulled this recently
const QUEUE_MAX = 20;
const USER_BURST = 8, USER_BURST_MS = 10 * 60e3;
const USER_DAY = 40, DAY_MS = 24 * 3600e3;
const IP_HOUR = 30, HOUR_MS = 3600e3;
const MISS_SCORE = 20;
const TEXT_MAX = 400;
let NOW = () => Date.now();
function _setClock(fn) { NOW = fn; }
let WAIT_MS = ANSWER_WAIT;
function _setWait(ms) { WAIT_MS = ms; }

// ── storage ──
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery("CREATE TABLE IF NOT EXISTS help_kv (k TEXT PRIMARY KEY, v TEXT)");
      await runQuery(`CREATE TABLE IF NOT EXISTS help_misses (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, q TEXT NOT NULL,
        user_id TEXT, score REAL, why TEXT, top TEXT, resolved INTEGER NOT NULL DEFAULT 0)`);
      await runQuery("CREATE INDEX IF NOT EXISTS help_misses_at ON help_misses (resolved, at)");
    })().catch((e) => { console.error("[help] init:", e.message); ready = null; throw e; });
  }
  return ready;
}
async function kvGet(k) {
  await init();
  const r = (await getQuery("SELECT v FROM help_kv WHERE k = ?", [k]))[0];
  if (!r) return null;
  try { return JSON.parse(r.v); } catch (e) { return null; }
}
async function kvSet(k, v) {
  await init();
  await runQuery("INSERT INTO help_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", [k, JSON.stringify(v)]);
}

// ── the data ──
// 1.99afi: the limits. camfrog-bot tools/build_help.py SITE_LIMITS mirrors these numbers (its build refuses data over
// them and its CI checks every card) - keep the two in step. Lengths are JavaScript string lengths (UTF-16 units).
// One card over a limit used to refuse the WHOLE sync (10-27: Pepe 1.99afd's 6,300-character !econ card kept prod's
// /help on 1.99adr's 338 cards, "[HELP] help sync failed: 400" every 2 min). Now only the SHAPE refuses a sync (types,
// ids, categories, roles, command names, links, prices) - with the bot token and the body size (SYNC_BODY_MAX) - and a
// card over a limit is kept with its text clipped (summary / details) or left out (anything else over): logged, counted
// in the sync's answer and on /admin/help.
const HELP_LIMITS = Object.freeze({
  entries: 1500, title: 200, summary: 400, details: 6000, syntax: 12, syntaxLine: 200, examples: 12, example: 300,
  keywords: 30, keyword: 80, commands: 20, gates: 10, gate: 60, webLabel: 200, undocumented: 2000, undocumentedCmd: 42,
});
const SYNC_BODY_MAX = "3mb";       // the whole sync request (express.json limit: over it -> 413)
const CLIPPABLE = new Set(["summary", "details"]);
const TRIMMED_MAX = 50;            // the over-the-limit list kept with the data / sent back (the counts are exact)
const L = HELP_LIMITS;
const str = (v, max) => typeof v === "string" && v.length <= max;
const strList = (v, max, each) => Array.isArray(v) && v.length <= max && v.every((x) => str(x, each));
const isStrList = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
const longest = (xs) => xs.reduce((m, x) => Math.max(m, x.length), 0);
const safeUrl = (u) => typeof u === "string" && u.length <= 300 && (/^\/(?!\/)/.test(u) || /^https:\/\/[^\s"'<>]+$/.test(u));
/** null when the data's SHAPE is usable, else what's wrong - a sync with a bad shape is refused whole. */
function shapeError(d) {
  if (!d || typeof d !== "object") return "not an object";
  if (d.schema !== 1) return "unknown schema";
  if (!Array.isArray(d.entries) || !d.entries.length || d.entries.length > L.entries) return "entries";
  if (!Array.isArray(d.categories) || !d.categories.every((c) => c && CAT_IDS.includes(c.id) && str(c.label, 60) && str(c.icon || "", 16) && str(c.blurb || "", 300))) return "categories";
  const ids = new Set();
  for (const e of d.entries) {
    const w = "entry " + (e && e.id);
    if (!e || typeof e !== "object" || !ID_RE.test(String(e.id || ""))) return w + ": id";
    if (ids.has(e.id)) return w + ": duplicate id";
    ids.add(e.id);
    if (typeof e.title !== "string" || !e.title.trim()) return w + ": title";
    if (!CAT_IDS.includes(e.category)) return w + ": category";
    if (!ROLES.includes(e.role)) return w + ": role";
    if (!Array.isArray(e.commands) || !e.commands.every((c) => CMD_RE.test(c))) return w + ": commands";
    if (!Array.isArray(e.aliases || []) || !(e.aliases || []).every((c) => CMD_RE.test(c))) return w + ": aliases";
    if (!isStrList(e.syntax) || !e.syntax.length) return w + ": syntax";
    if (typeof e.summary !== "string" || typeof (e.details || "") !== "string") return w + ": text";
    if (!isStrList(e.examples || []) || !isStrList(e.keywords || [])) return w + ": examples/keywords";
    if (e.cost != null && !(Number.isInteger(e.cost) && e.cost >= 0 && e.cost < 1e12)) return w + ": cost";
    if (e.gates != null && !isStrList(e.gates)) return w + ": gates";
    if (e.web != null && !(e.web && typeof e.web.label === "string" && safeUrl(e.web.url))) return w + ": web";
  }
  if (d.undocumented != null && !strList(d.undocumented, L.undocumented, L.undocumentedCmd)) return "undocumented";
  return null;
}
// field -> the word validateData has always used for it
const OVER_WORD = { title: "title", summary: "text", details: "text", syntax: "syntax", "syntax line": "syntax", examples: "examples/keywords",
  example: "examples/keywords", keywords: "examples/keywords", keyword: "examples/keywords", commands: "commands", gates: "gates", gate: "gates", "web label": "web" };
/** a card (shape already checked) -> its fields over HELP_LIMITS: [{field, len, max}] */
function oversize(e) {
  const out = [];
  const chk = (field, len, max) => { if (len > max) out.push({ field, len, max }); };
  chk("title", e.title.length, L.title);
  chk("summary", e.summary.length, L.summary);
  chk("details", (e.details || "").length, L.details);
  chk("syntax", e.syntax.length, L.syntax);
  chk("syntax line", longest(e.syntax), L.syntaxLine);
  chk("examples", (e.examples || []).length, L.examples);
  chk("example", longest(e.examples || []), L.example);
  chk("keywords", (e.keywords || []).length, L.keywords);
  chk("keyword", longest(e.keywords || []), L.keyword);
  chk("commands", e.commands.length, L.commands);
  if (e.gates != null) { chk("gates", e.gates.length, L.gates); chk("gate", longest(e.gates), L.gate); }
  if (e.web != null) chk("web label", e.web.label.length, L.webLabel);
  return out;
}
/** null when the data is usable AS IS, else what's wrong (the stored / bundled copy must pass this after normalizeData). */
function validateData(d) {
  const err = shapeError(d);
  if (err) return err;
  for (const e of d.entries) { const o = oversize(e)[0]; if (o) return "entry " + e.id + ": " + OVER_WORD[o.field]; }
  return null;
}
/** Text cut to `max` JavaScript characters with a "…": never inside a surrogate pair, back to a space when one is near,
 *  and never leaving a `code span open. */
function clip(s, max) {
  let t = String(s).slice(0, max - 1);
  const last = t.charCodeAt(t.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1);          // half an emoji
  const sp = t.search(/\s\S*$/);
  if (sp > max * 0.8) t = t.slice(0, sp);
  if ((t.match(/`/g) || []).length % 2) t = t.slice(0, t.lastIndexOf("`"));
  return t.replace(/\s+$/, "") + "…";
}
/**
 * The data the site keeps: -> {data, error, cards, clipped, skipped, trimmed}. A bad shape -> error (refuse it all).
 * A card over a limit: only its summary / details over -> kept, clipped; anything else over -> left out. trimmed lists
 * them ({id, field, len, max, action}, at most TRIMMED_MAX; clipped / skipped count them all).
 */
function normalizeData(d) {
  const none = { data: null, cards: 0, clipped: 0, skipped: 0, trimmed: [] };
  const err = shapeError(d);
  if (err) return { ...none, error: err };
  const entries = [], trimmed = [];
  let clipped = 0, skipped = 0;
  for (const e of d.entries) {
    const over = oversize(e);
    if (!over.length) { entries.push(e); continue; }
    const fits = over.every((o) => CLIPPABLE.has(o.field));
    if (fits) {
      const c = { ...e };
      for (const o of over) c[o.field] = clip(c[o.field], o.max);
      entries.push(c);
      clipped++;
    } else skipped++;
    for (const o of over) if (trimmed.length < TRIMMED_MAX) trimmed.push({ id: e.id, ...o, action: fits ? "clipped" : "skipped" });
  }
  if (!entries.length) return { ...none, error: "entries", skipped, trimmed };
  const data = clipped || skipped ? { ...d, entries } : d;
  const left = validateData(data);                                    // what is kept passes the strict check
  if (left) return { ...none, error: left };
  return { data, error: null, cards: entries.length, clipped, skipped, trimmed };
}
const trimNote = (t) => t.slice(0, 10).map((x) => `${x.id} ${x.field} ${x.len}>${x.max} ${x.action}`).join(", ") + (t.length > 10 ? ", ..." : "");

let FALLBACK = null;
function fallback() {
  if (!FALLBACK) {
    try {
      const n = normalizeData(JSON.parse(fs.readFileSync(FALLBACK_FILE, "utf8")));
      if (n.error) console.error("[help] fallback: bad help data:", n.error);
      else if (n.trimmed.length) console.warn(`[help] fallback: the bundled copy has cards over the limits (${n.clipped} clipped, ${n.skipped} left out): ${trimNote(n.trimmed)}`);
      FALLBACK = n.data ? { data: n.data, version: null, hash: null, at: null, source: "bundled", trimmed: n.trimmed } : null;
    } catch (e) { console.error("[help] fallback:", e.message); }
  }
  return FALLBACK;
}
let CUR = undefined;               // undefined = not loaded yet; null = nothing synced
async function current() {
  if (CUR === undefined) {
    try {
      const s = await kvGet("data");
      const n = s ? normalizeData(s.data) : null;          // stored normalized; again in case a limit shrank since
      CUR = n && n.data ? { data: n.data, version: s.version || null, hash: s.hash || null, at: s.at || null, source: "pepe",
                            trimmed: Array.isArray(s.trimmed) && s.trimmed.length ? s.trimmed : n.trimmed } : null;
    } catch (e) { CUR = null; }
  }
  return CUR || fallback() || { data: { schema: 1, categories: [], entries: [] }, version: null, hash: null, at: null, source: "none", trimmed: [] };
}
/** Pepe's sync -> {hash, cards, clipped, skipped, trimmed}. The hash stays Pepe's (his pull compares it with his own,
 *  so a clipped copy isn't published again every 2 minutes). */
async function sync(body = {}) {
  const n = normalizeData(body.data);
  if (n.error) throw Object.assign(new Error("bad help data: " + n.error), { status: 400 });
  const hash = String(body.hash || "").slice(0, 64) || crypto.createHash("sha256").update(JSON.stringify(body.data)).digest("hex").slice(0, 16);
  const version = String(body.version || "").slice(0, 20) || null;
  if (n.trimmed.length) {
    console.warn(`[help] sync ${hash} (Pepe ${version || "?"}): ${n.clipped} card(s) clipped, ${n.skipped} left out - over the limits: ${trimNote(n.trimmed)}`);
  }
  const rec = { data: n.data, version, hash, at: NOW(), trimmed: n.trimmed };
  await kvSet("data", rec);
  CUR = { ...rec, source: "pepe" };
  return { hash, cards: n.cards, clipped: n.clipped, skipped: n.skipped, trimmed: n.trimmed };
}

// ── config (help_kv 'config') ──
const DEFAULTS = Object.freeze({ ai: true });
async function config() {
  const c = (await kvGet("config").catch(() => null)) || {};
  return { ai: c.ai === undefined ? DEFAULTS.ai : !!c.ai };
}
async function setConfig(patch) {
  const c = await config();
  if (patch && "ai" in patch) c.ai = !!patch.ai;
  await kvSet("config", c);
  return c;
}

// ── text: the help's tiny markdown (`code`, **bold**, [text](url), newlines) -> safe HTML ──
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);
function md(s) {
  const parts = String(s || "").split(/(`[^`\n]*`)/);
  return parts.map((p) => {
    if (/^`[^`\n]*`$/.test(p)) return "<code>" + esc(p.slice(1, -1)) + "</code>";
    let h = esc(p);
    h = h.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
    h = h.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, t, u) => {
      const url = u.replace(/&amp;/g, "&");
      return safeUrl(url) ? `<a href="${esc(url)}"${/^https:/.test(url) ? ' rel="noopener"' : ""}>${t}</a>` : t;
    });
    return h.replace(/\n/g, "<br>");
  }).join("");
}
const plain = (s) => String(s || "").replace(/`([^`]*)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

// ── the local search ──
function search(data, q, limit = CANDIDATES) { return HS.rank((data && data.entries) || [], q, { limit }); }
function card(e, score) {
  const c = { id: e.id, title: e.title, commands: e.commands, aliases: e.aliases || [], syntax: e.syntax, summary: plain(e.summary), role: e.role, category: e.category };
  if (e.cost) c.cost = e.cost;
  if (score != null) c.score = score;
  return c;
}
/** the commands a set of cards allows an answer to name */
function allowedCommands(cards) {
  const ok = new Set();
  for (const c of cards) {
    for (const x of [].concat(c.commands || [], c.aliases || [])) ok.add(String(x).toLowerCase());
    for (const s of [].concat(c.syntax || [], c.title || "")) for (const m of String(s).toLowerCase().match(/!\w+/g) || []) ok.add(m);
  }
  return ok;
}
/** Pepe's answer, checked against the cards he was given -> {text, ids} | null */
function cleanAnswer(a, cards) {
  if (!a || typeof a !== "object") return null;
  const valid = new Set(cards.map((c) => c.id));
  const ids = [];
  for (const x of Array.isArray(a.ids) ? a.ids : []) { const s = String(x); if (valid.has(s) && !ids.includes(s)) ids.push(s); }
  const text = String(a.text || "").replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);
  if (!text && !ids.length) return null;
  const ok = allowedCommands(cards);
  for (const m of text.toLowerCase().match(/!\w+/g) || []) if (!ok.has(m)) return null;      // an invented command
  return { text, ids: ids.slice(0, 3) };
}

// ── the queue (in memory: the asker's request is waiting in this process anyway) ──
const JOBS = new Map();
const PULLERS = [];
let LAST_PULL = 0;
function wake() { while (PULLERS.length) { try { PULLERS.shift()(); } catch (e) { /* gone */ } } }
SHUTDOWN.onDrain(wake);   // 1.99gd: on a restart, answer the waiting long-polls (no work) instead of cutting them -> no nginx 502
function expire(t = NOW()) {
  for (const [id, j] of JOBS) if (t - j.created > JOB_TTL) { JOBS.delete(id); j.reject(Object.assign(new Error("expired"), { code: "expired" })); }
}
function online() { return LAST_PULL > 0 && NOW() - LAST_PULL < ONLINE_MS; }
function enqueue(q, candidates) {
  expire();
  if (JOBS.size >= QUEUE_MAX) return null;
  const id = crypto.randomBytes(12).toString("hex");
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  promise.catch(() => {});
  JOBS.set(id, { id, q, candidates, created: NOW(), claimed: 0, resolve, reject });
  wake();
  return { id, promise };
}
const claimable = (t = NOW()) => [...JOBS.values()].filter((j) => !j.claimed || t - j.claimed > CLAIM_TTL);
async function pull(waitMs = 0) {
  LAST_PULL = NOW();
  expire();
  let list = claimable();
  if (!list.length && waitMs > 0 && !SHUTDOWN.isDraining()) {   // 1.99gd: a stopping site doesn't hold a long-poll
    await new Promise((res) => {
      const t = setTimeout(() => { const i = PULLERS.indexOf(done); if (i >= 0) PULLERS.splice(i, 1); res(); }, Math.min(PULL_WAIT_MAX, waitMs));
      function done() { clearTimeout(t); res(); }
      PULLERS.push(done);
    });
    list = claimable();
  }
  const t = NOW();
  LAST_PULL = t;
  return list.slice(0, PULL_MAX_JOBS).map((j) => { j.claimed = t; return { id: j.id, q: j.q, candidates: j.candidates }; });
}
function answer(body = {}) {
  const j = JOBS.get(String(body.id || ""));
  if (!j) return false;
  JOBS.delete(j.id);
  const a = body.error ? null : cleanAnswer(body.answer, j.candidates);
  if (!a) j.reject(Object.assign(new Error(String(body.error || "unusable answer").slice(0, 120)), { code: "error" }));
  else j.resolve({ ...a, model: String(body.model || "").slice(0, 80) || null, cost: Math.max(0, Number(body.cost) || 0) });
  return true;
}
function _reset() { for (const j of JOBS.values()) j.reject(new Error("reset")); JOBS.clear(); PULLERS.length = 0; LAST_PULL = 0; LIMITS.clear(); CUR = undefined; }

// ── rate limits (fixed windows, in memory) ──
const LIMITS = new Map();      // key -> {n, until}
function over(key, max, ms) {
  const t = NOW(), c = LIMITS.get(key);
  return !!c && c.until > t && c.n >= max;
}
function count(key, ms) {
  const t = NOW(), c = LIMITS.get(key);
  if (!c || c.until <= t) LIMITS.set(key, { n: 1, until: t + ms });
  else c.n += 1;
  if (LIMITS.size > 20000) for (const [k, v] of LIMITS) if (v.until <= t) LIMITS.delete(k);
}
/** -> null when this asker may have an AI answer now, else why not (and nothing is counted) */
function limitFor(userId, ip) {
  const keys = [["u10:" + userId, USER_BURST, USER_BURST_MS], ["ud:" + userId, USER_DAY, DAY_MS], ["ip:" + ip, IP_HOUR, HOUR_MS]];
  for (const [k, max, ms] of keys) if (over(k, max, ms)) return k.startsWith("ip:") ? "ip" : k.startsWith("ud:") ? "day" : "burst";
  for (const [k, , ms] of keys) count(k, ms);
  return null;
}

// ── misses ──
async function logMiss({ q, userId, score, why, top }) {
  try {
    await init();
    await runQuery("INSERT INTO help_misses (at, q, user_id, score, why, top) VALUES (?, ?, ?, ?, ?, ?)",
      [NOW(), String(q).slice(0, Q_MAX), userId || null, score == null ? null : Number(score), String(why || "").slice(0, 40), top ? String(top).slice(0, 48) : null]);
    await runQuery("DELETE FROM help_misses WHERE at < ?", [NOW() - 90 * DAY_MS]);
  } catch (e) { console.error("[help] miss log:", e.message); }
}
async function misses({ limit = 200, all = false } = {}) {
  await init();
  return getQuery(`SELECT m.id, m.at, m.q, m.score, m.why, m.top, m.resolved, u.username FROM help_misses m LEFT JOIN users u ON u.userId = m.user_id
                   ${all ? "" : "WHERE m.resolved = 0"} ORDER BY m.at DESC LIMIT ?`, [Math.max(1, Math.min(500, limit))]);
}

/** The prompter. -> {ok, q, results, answer, source, note?} */
async function ask({ q, user, ip }) {
  q = String(q == null ? "" : q).replace(/\s+/g, " ").trim();
  if (q.length < Q_MIN || q.length > Q_MAX) throw Object.assign(new Error(`Ask in ${Q_MIN}-${Q_MAX} characters.`), { status: 400 });
  const cur = await current();
  const ranked = search(cur.data, q, CANDIDATES);
  const results = ranked.slice(0, 5).map((r) => card(r.entry, r.score));
  const best = ranked.length ? ranked[0].score : 0;
  const out = { ok: true, q, results, answer: null, source: "search" };
  const miss = (why) => { if (best < MISS_SCORE) logMiss({ q, userId: user && user.userId, score: best, why, top: ranked[0] && ranked[0].entry.id }); };
  if (!user || !user.userId) { out.note = "signin"; miss("signed-out"); return out; }
  const c = await config();
  if (!c.ai) { out.note = "ai-off"; miss("ai-off"); return out; }
  if (!ranked.length) { out.note = "nothing"; miss("no-match"); return out; }
  if (!online()) { out.note = "pepe-offline"; miss("pepe-offline"); return out; }
  const lim = limitFor(user.userId, ip || "?");
  if (lim) { out.note = "limit-" + lim; miss("limited"); return out; }
  const candidates = ranked.map((r) => card(r.entry));
  const job = enqueue(q, candidates);
  if (!job) { out.note = "busy"; miss("busy"); return out; }
  let timer;
  try {
    const a = await Promise.race([job.promise, new Promise((res, rej) => { timer = setTimeout(() => rej(Object.assign(new Error("timeout"), { code: "timeout" })), WAIT_MS); })]);
    out.answer = { text: a.text, ids: a.ids, cards: a.ids.map((id) => card(candidates.find((x) => x.id === id) || {})) };
    out.source = "pepe";
    if (!a.ids.length && best < MISS_SCORE) logMiss({ q, userId: user.userId, score: best, why: "pepe-none", top: ranked[0].entry.id });
  } catch (e) {
    out.note = e.code === "timeout" ? "pepe-slow" : "pepe-error";
    JOBS.delete(job.id);
    miss(out.note);
  } finally { clearTimeout(timer); }
  return out;
}

// ── the page model ──
async function pageModel() {
  const cur = await current();
  const d = cur.data;
  const cats = (d.categories || []).map((c) => ({ ...c, entries: (d.entries || []).filter((e) => e.category === c.id) })).filter((c) => c.entries.length);
  // the browser's search index: compact, no details (the filter reads each card's text)
  const index = (d.entries || []).map((e) => ({ id: e.id, title: e.title, commands: e.commands, aliases: e.aliases || [], syntax: e.syntax,
    summary: plain(e.summary), keywords: e.keywords || [], role: e.role, category: e.category, cost: e.cost || 0 }));
  return { cats, index, version: cur.version, source: cur.source, at: cur.at, roles: d.roles || {}, gates: d.gates || {}, count: (d.entries || []).length };
}
const fmt = (n) => Number(n || 0).toLocaleString("en-US");

function register(app, { addUser, isBotToken, clientIp = (req) => req.ip || "?" }) {
  const express = require("express");
  const small = express.json({ limit: "16kb" });
  const big = express.json({ limit: SYNC_BODY_MAX });
  const fail = (res, e) => {
    const st = e && e.status && e.status < 500 ? e.status : 500;
    if (st === 500) console.error("[help]", e);
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
  const helpAdmin = async (req) => {
    if (!req.user || !req.user.userId) return null;
    const u = (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]))[0];
    return SP.can(u, "help.admin") ? u : null;
  };

  app.get("/help", addUser, async (req, res) => {
    try {
      const m = await pageModel();
      res.set("Cache-Control", "private, max-age=0, must-revalidate");
      res.render("help", { user: req.user ? req.user.username : null, signedIn: !!(req.user && req.user.userId), M: m, md, fmt, esc,
                           q: typeof req.query.q === "string" ? req.query.q.slice(0, Q_MAX) : "" });
    } catch (e) { console.error("[help] page:", e); res.status(500).send("Something went wrong."); }
  });
  app.get("/commands", (req, res) => {
    const q = typeof req.query.q === "string" && req.query.q ? "?q=" + encodeURIComponent(req.query.q.slice(0, Q_MAX)) : "";
    res.redirect(301, "/help" + q);
  });
  app.get("/api/help/data", async (req, res) => {
    try { const c = await current(); res.set("Cache-Control", "public, max-age=300"); res.json({ ok: true, version: c.version, hash: c.hash, data: c.data }); }
    catch (e) { fail(res, e); }
  });
  app.post("/api/help/ask", small, addUser, async (req, res) => {
    if (!sameSite(req)) return res.status(403).json({ ok: false, error: "Bad request." });
    try { res.json(await ask({ q: (req.body || {}).q, user: req.user, ip: clientIp(req) })); } catch (e) { fail(res, e); }
  });

  // Pepe: publish the data, the prompter's long-poll + his answers
  // 1.99afi: {ok, hash, cards, clipped, skipped, trimmed} - cards over the limits no longer refuse the whole sync
  app.post("/api/pepe/help/sync", big, bot, async (req, res) => {
    try { res.json({ ok: true, ...(await sync(req.body || {})) }); } catch (e) { fail(res, e); }
  });
  app.post("/api/pepe/help/pull", small, bot, async (req, res) => {
    try {
      const cur = await current();
      const hash = cur.source === "pepe" ? cur.hash : null;
      const c = await config();
      if (!c.ai) { LAST_PULL = NOW(); return res.json({ ok: true, enabled: false, hash, jobs: [], idle: 60 }); }
      const wait = Math.min(PULL_WAIT_MAX, Math.max(0, Number((req.body || {}).wait) * 1000 || 0));
      const jobs = await pull(wait);
      // 1.99ge: stopping (a restart) -> tell Pepe to pull again in a few s, not at once into a refused port (nginx
      // would then park the upstream for 10 s and 502 everyone)
      res.json({ ok: true, enabled: true, hash, jobs, ...(SHUTDOWN.isDraining() && !jobs.length ? { retry: true, idle: 5 } : {}) });
    } catch (e) { fail(res, e); }
  });
  app.post("/api/pepe/help/answer", small, bot, async (req, res) => {
    try { res.json({ ok: true, waiting: answer(req.body || {}) }); } catch (e) { fail(res, e); }
  });

  // admins: the questions nobody could answer + the AI switch
  app.get("/admin/help", addUser, async (req, res) => {
    if (!req.user || !req.user.userId) return res.redirect("/login");
    try {
      const a = await helpAdmin(req);
      res.set("Cache-Control", "no-store");
      res.set("X-Robots-Tag", "noindex");
      if (!a) return res.status(403).render("notFound", { user: req.user.username, heading: "Admins only", message: "The help questions page is for site admins.", title: "Admins only" });
      const all = req.query.all === "1";
      const cur = await current();
      res.render("admin/help", { title: "Help questions", user: a.username, isAdmin: true, C: await config(), rows: await misses({ all }), all,
                                 cur: { version: cur.version, source: cur.source, at: cur.at, hash: cur.hash, count: (cur.data.entries || []).length,
                                        undocumented: cur.data.undocumented || [], trimmed: cur.trimmed || [] },
                                 pepe: { online: online(), lastPull: LAST_PULL || null, queued: JOBS.size } });
    } catch (e) { console.error("[help] admin:", e); res.status(500).send("Something went wrong."); }
  });
  const adminApi = async (req, res, next) => {
    if (!sameSite(req) || req.get("X-Requested-With") !== "fetch") return res.status(403).json({ ok: false, error: "Bad request." });
    const a = await helpAdmin(req).catch(() => null);
    if (!a) return res.status(403).json({ ok: false, error: "Admins only." });
    next();
  };
  app.post("/admin/help/config", small, addUser, adminApi, async (req, res) => {
    try { res.json({ ok: true, config: await setConfig(req.body || {}) }); } catch (e) { fail(res, e); }
  });
  app.post("/admin/help/misses/:id/resolve", small, addUser, adminApi, async (req, res) => {
    try {
      await init();
      await runQuery("UPDATE help_misses SET resolved = ? WHERE id = ?", [(req.body || {}).resolved === false ? 0 : 1, Number(req.params.id) || 0]);
      res.json({ ok: true });
    } catch (e) { fail(res, e); }
  });
}

module.exports = {
  register, validateData, normalizeData, clip, current, sync, search, ask, pull, answer, cleanAnswer, allowedCommands, md, plain, config, setConfig,
  misses, logMiss, online, pageModel, _setClock, _setWait, _reset, HELP_LIMITS, SYNC_BODY_MAX,
  LIMITS: { USER_BURST, USER_DAY, IP_HOUR, QUEUE_MAX, MISS_SCORE, ANSWER_WAIT },
};
