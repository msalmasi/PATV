// chatlogsearch.js — CL9: search the pad chat's archive (the chat-history spec §2.3, §3.5 "Search", §3.6, §3.11). Ships DARK:
// nothing answers until the chatlog.search switch is on (chatlog.js; the owner turns it on after this slice is live and checked -
// runbook step 8) - and, CL9 fix-up, while chatlog.history is on too (a result opens its line in the history; search never opens
// the archive before scrollback - runbook step 7 - is on).
//
//   POST /api/rooms/:slug/search {q, kind: all|chat|mic, from?, hide_pepe?, before?, cursor?, limit: 1..50 (20)}
//     -> {ok, hits: [{item (projected + dressed exactly like /history's items), hl: [[start, end], ...]}], more, cursor, partial?,
//         exact? (the last word, matched as a whole word only - see "the last-word prefix"), acts}
//   POST (not GET) keeps queries - often names - out of nginx's and Cloudflare's URL logs; same-origin only. A query is never
//   printed to the console (an error logs its code, never its message: SQLite's FTS errors quote the query).
//
// Who: signed-in viewers who can read the pad (padaccess.full) and whose view allows history (chatlogview.view: age-confirmed on
// an 18+ pad, not blocked from the whole bridge nor banned from the pad's feed, the 💎 gate). With the pad's search switch off only
// viewers with full history (the owner, staff holding chatlog.read_all, the room's Camfrog mods) search - 403 search_off for the rest.
//
// The query (chatlogsearch.parse - search.parse has no phrases): NFKC, controls stripped, at most 100 characters and 8 words.
// "Quoted phrases" stay phrases; every other word is exact except the LAST one, which also matches longer words when it has 3 or
// more letters (decision 11). At least one word of 2 or more letters, else 400 too_short - so From only ever narrows a search, it
// never lists a person's lines on its own. Accents are folded (the index's unicode61 remove_diacritics 2).
// The last-word prefix (CL9 fix-up): FTS5 builds the whole doclist of every word a prefix covers, so a COMMON word as a prefix
// ("lol", "hello" - the most usual one-word searches) costs 35-180 ms at 2M rows here, 371-756 ms at 4M on the VPS, against 1-2 ms
// for the word itself. A prefix statement gets PREFIX_BUDGET_MS; when it runs out, the prefix is remembered as too broad (BROAD,
// 6 h - a shorter prefix of a broad one is broad too) and the search runs again with the last word exact; the answer says so
// (`exact`: "“lol” is too common to also match longer words: whole words only."). PREFIX_FALLBACK = false restores "Too broad".
//
// Three plans, each a loop of FETCHES newest first until limit + 1 visible hits are found, the rows run out, or the request's budget
// (FETCH_MAX fetches, REQ_MS) is spent:
//   f  the FTS5 index (chat_log_fts) with the rowid bounded by the viewer's search floors (each turned into a cursor once -
//      chatlogview.cursorBounds) and the scan position, ROWS candidates a fetch, joined to chat_log by its primary key (a CROSS
//      JOIN: the index always drives). The room token (rt : "r<rk>") is added only for rooms holding under chatlog.RT_SHARE of the
//      indexed rows; bigger rooms post-filter on rk (bench: a common word with the token in the biggest room 135 ms, without it 0.1 ms).
//   l  without FTS5 (the self-test failed: chatlog.js made no triggers), and for CJK queries (runs without spaces aren't words to the
//      tokenizer): a LIKE over a window of at most LIKE_ROWS newest indexable rows of the room inside the floors (partial: true -
//      SQLite's LIKE folds ASCII case only; the re-match keeps the index's word rules); the next fetch starts under the window.
//   w  From (CL9 fix-up): the speaker's own lines, newest first, on chat_log_who (who, c) - one statement per key, WHO_ROWS a fetch -
//      matched in JS. Its cost follows the speaker's lines, never how common the words are (the index-driven plan walked every
//      match of a common word in the room: 215-313 ms at 2M rows for an unknown From). A From that is unknown, hidden, a
//      private-activity account, someone who DM-blocked the viewer or a no-hit speaker runs the SAME statement (a key no line has
//      stands in for the ones left out) - one answer, {hits: [], more: false}, at one cost. A speaker whose lines run past the
//      budget (Pepe in a small room) falls back to plan f / l with their keys as a filter.
// Every statement runs on chatlogdb's own search connection, one at a time (a queue of 4, then 429 busy) with a 400 ms budget
// (interrupt() on THAT connection; 422 too_broad "Too broad - add a word."). CL9 fix-up: never on the site's shared connection - with
// no search connection the answer is 503 busy (only tests and tools may allow the shared one: _allowShared).
// The people the sticky hidden set leaves out (chatloghist.hiddenLogins: their logins, !transcripts off for 🎙 lines) and the people
// who DM-blocked the viewer are left out in SQL too, so their lines never count as candidates; then in JS, per candidate:
// chatlogview.filter with the SEARCH floors (the per-class floors, wm_search for viewers without full history - lines said while
// search was off stay unsearchable -, the line's own aud, the sticky hidden set, !transcripts off), the searchable-author rules (not a
// private-activity account - the viewer's own lines always are -, not someone who DM-blocked the viewer; CL9 fix-up: a name lookup
// that failed counts as private), Hide Pepe, and a re-match on the PROJECTED text: a hit whose only match was a name that is now
// redacted ("someone") is dropped - and an exact word or phrase that is a redacted name finds nothing at once. The highlights are
// computed here over the projected text (prefix-aware, accents folded) - FTS5 snippet() is never used: it would quote redacted names.
// Removed and purged lines are out of the index (the triggers) and out of the SQL anyway (a drifted index can't bring one back).
// The owner's decision-9 change (2026-10-19, "incognito hides WHO, not WHAT"): a !bridge hide person's lines are left out as above;
// an INCOGNITO person's lines are found by their words only - shown as "someone" (chatlogview.dress: no name, look or 🎙 id) - and
// never by their name: From them runs the sentinel (nothing found, the same answer as anyone unknown), and their names - login and
// display names - are redacted in every projected text, so a word or phrase naming them finds nothing (deadTerm) and a prefix that
// only reached their name drops (the re-match). Lines Pepe sent anonymised (archived as who "h:<hash>") follow the same rules.
//
// Paging (CL9 fix-up): `more` is true only when ANOTHER VISIBLE hit was found below the last one returned (limit + 1 were looked
// for), or when the request's budget ran out before the rows did - never because dropped candidates were read (that told a viewer
// that a hidden person's line matched, and who a "someone" was). The left-out people's lines are out of the SQL, so the budget only
// runs out on lines the viewer may read in scrollback anyway or on matches inside redacted names. `cursor` = an OPAQUE position
// (AES-256-CTR sealed, fixed width, HMAC-SHA256 over the room, the viewer and THE QUERY - its words, kind, From, Hide Pepe and Before
// - with its issue time, 1 h): the last returned hit's c, or the scan position when the budget ran out; replayed with another query
// it is refused (400 bad_cursor), so it can't place a dropped line.
// The index being repaired (chatlog.ftsPartial) answers partial:true on plan f.
// Limits (§3.11): 20 requests a minute per account - CL9 fix-up: refused ones too (counted before the pad is even looked up) - and
// 300 searches a day (authGuard.limiter + a daily counter in memory: a restart forgives). A staff search below the public floor is a
// coalesced chatlog_views row (kind search).
"use strict";
const crypto = require("crypto");
const { getQuery } = require("./dbUtils");
const CL = require("./chatlog");

// ── owner decisions and limits (spec §2.3, §3.5, §3.11; decision 11): each one constant ──
const PAGE = 20;                   // "newest first, 20 at a time, with More results"
const LIMIT_MAX = 50;
const PREFIX_MIN = 3;              // decision 11: the last word is prefix-matched from 3 letters
const PREFIX_FALLBACK = true;      // CL9 fix-up (decision 11): a prefix too common for its budget -> the last word exact (false: 422)
const TERM_MIN = 2;                // at least one word of 2 or more letters
const TERMS_MAX = 8, Q_MAX = 100;  // at most 8 words and 100 characters
const PER_MIN = 20, PER_DAY = 300; // requests a minute / searches a day per account

const ROWS = 200;                  // FTS candidates one fetch reads
const LIKE_ROWS = 20000;           // the LIKE fallback reads at most this many newest indexable rows of the room a fetch
const WHO_ROWS = 2000;             // From: the speaker's lines one fetch reads (per key)
const FETCH_MAX = 5;               // fetches one request makes before answering "more" at its scan position
const REQ_MS = 800;                // ... or once this long has gone by (after the first fetch)
const PREFIX_BUDGET_MS = 200;      // a statement with a last-word prefix gets this much of the search connection
const BROAD_TTL = 6 * 3600e3, BROAD_MAX = 5000;
const OUT_SQL_MAX = 1000;          // the viewer's DM-blockers left out in SQL (past it only the JS check drops them)
const CURSOR_TTL = 3600e3;         // a More results position is good this long
const FROM_MAX = 64;
const C_MAX = 1e15;
const SENTINEL = " ";              // From: a key no line has (a login never is a space) - it stands in for the keys left out: the same
                                   // statement, nothing found
const LOGIN_RE = /^[\w.-]{1,40}$/; // the bridge's login shape
const KINDS = Object.freeze({ all: ["msg", "tx", "topic"], chat: ["msg", "topic"], mic: ["tx"] });
const SECRET = process.env.SECRET_KEY || crypto.randomBytes(32).toString("hex");
const KEY_ENC = crypto.createHash("sha256").update("chat-search-enc:" + SECRET).digest();
const KEY_MAC = crypto.createHash("sha256").update("chat-search-mac:" + SECRET).digest();

const limits = { perMin: PER_MIN, perDay: PER_DAY, fetchMax: FETCH_MAX, reqMs: REQ_MS, prefixMs: PREFIX_BUDGET_MS };
let runner = null;                 // tests: replace the search connection
let sharedOk = false;              // tests / tools: with no search connection, read on the shared one (never in the site)
let hiddenSql = true;              // tests: leave the left-out people to the JS checks only
const BROAD = new Map();           // folded prefix -> when it ran out of its budget
class Refuse extends Error {
  constructor(status, message, code, extra) { super(message); this.status = status; this.code = code || null; this.refuse = true; Object.assign(this, extra || {}); }
}
const notFound = () => new Refuse(404, "That pad isn't available.", "not_found");
const busyRefusal = () => new Refuse(503, "Search is busy - try again in a moment.", "busy", { retry: 5 });

// ── the query ──
const CTRL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;
// the tokenizer's word characters (FTS5 unicode61: letters, numbers, private use); everything else separates words
const WORD = /[\p{L}\p{N}\p{Co}]+/gu;
// scripts written without spaces: the tokenizer makes one long "word" of a run, so a query word inside it can't match - LIKE path
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
/** Accents folded and lower-cased, as the index compares words (unicode61 remove_diacritics 2). */
const fold = (s) => String(s).normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase();
const cps = (s) => Array.from(String(s)).length;
const wordsOf = (s) => String(s).toLowerCase().match(WORD) || [];

/**
 * What was typed -> {ok, q (cleaned), terms: [{words, f (folded), phrase, quoted, prefix, cjk}], cjk (any CJK term)}. ok = false: no
 * word of TERM_MIN letters (too_short). Quoted "phrases" stay phrases (straight or curly quotes); the last bare word gets the prefix
 * when it has PREFIX_MIN letters or more; at most TERMS_MAX words in all (a phrase counts its words).
 */
function parse(raw) {
  const q = String(raw == null ? "" : raw).normalize("NFKC").replace(CTRL, " ").replace(/\s+/g, " ").trim().slice(0, Q_MAX);
  const terms = [];
  let words = 0;
  const re = /["“”„]([^"“”„]*)["“”„]?|([^\s"“”„]+)/g;
  let m;
  while ((m = re.exec(q)) && words < TERMS_MAX) {
    const phrase = m[1] != null;
    let ws = wordsOf(phrase ? m[1] : m[2]);
    if (!ws.length) continue;
    if (!phrase) {
      // an unquoted chunk the tokenizer splits ("don't", "e-mail") is several words, each its own term
      for (const w of ws) {
        if (words >= TERMS_MAX) break;
        terms.push({ words: [w], phrase: false, quoted: false });
        words++;
      }
      continue;
    }
    ws = ws.slice(0, TERMS_MAX - words);
    terms.push({ words: ws, phrase: ws.length > 1, quoted: true });     // quoted = exact, a single word too
    words += ws.length;
  }
  for (const t of terms) {
    t.f = t.words.map(fold);
    t.cjk = t.words.some((w) => CJK.test(w));
    t.prefix = false;
  }
  const last = terms[terms.length - 1];
  if (last && !last.quoted && !last.cjk && cps(last.words[0]) >= PREFIX_MIN) last.prefix = true;
  const ok = terms.some((t) => t.words.some((w) => cps(w) >= TERM_MIN));
  return { ok, q, terms, cjk: terms.some((t) => t.cjk) };
}
/** The same query with its last word exact (the prefix fallback). */
function exactLast(P) {
  const last = P.terms[P.terms.length - 1];
  if (!last || !last.prefix) return P;
  return Object.assign({}, P, { terms: P.terms.slice(0, -1).concat([Object.assign({}, last, { prefix: false })]) });
}
const lastPrefix = (P) => { const t = P.terms[P.terms.length - 1]; return t && t.prefix ? t.f[0] : null; };

/** The FTS5 MATCH expression: text : ("w1" "a phrase" "last"*), with rt : "r<rk>" AND in front when rk is given. */
function ftsMatch(P, rk = null) {
  const parts = P.terms.map((t) => '"' + t.words.join(" ").replace(/"/g, '""') + '"' + (t.prefix ? "*" : ""));
  const text = "text : (" + parts.join(" ") + ")";
  return rk == null ? text : `rt : "r${Math.floor(Number(rk))}" AND ` + text;
}

// ── the SQL ──
const qs = (n) => new Array(n).fill("?").join(", ");
/** CL9 fix-up: the people left out (nOut logins for every kind, nTx more for 🎙 lines only) as a CASE (never an OR); topic lines
 *  (no speaker) pass. Params: [...out, ...tx] (when nOut + nTx), then [...out] (when nOut) - outParams. */
function outSql(p, nOut, nTx) {
  if (!(nOut + nTx > 0)) return "";
  return ` AND (CASE WHEN ${p}who IS NULL THEN 1 WHEN ${p}k = 'tx' THEN ${p}who NOT IN (${qs(nOut + nTx)})` +
    (nOut > 0 ? ` ELSE ${p}who NOT IN (${qs(nOut)}) END)` : " ELSE 1 END)");
}
const outParams = (out, tx) => [...(out.length + tx.length ? [...out, ...tx] : []), ...out];
/**
 * Plan f's candidates (spec §3.5): the index drives (CROSS JOIN), the rowid bounded on both sides, chat_log by its primary key; the
 * room (always - the token is only a narrowing), removed / purged lines, the kinds, the per-class floors as cursors in a CASE (never
 * an OR), Approved-era lines (approved false), From's keys (from = how many) and the left-out people are filters on the joined row.
 * Params: [match, cmin, hi, rk, ...kinds, c_tx, c_chat, ...fromKeys, ...outParams, limit].
 */
function ftsSql({ kinds = KINDS.all, approved = true, from = 0, nOut = 0, nTx = 0 } = {}) {
  return "SELECT l.* FROM chat_log_fts f CROSS JOIN chat_log l ON l.c = f.rowid" +
    " WHERE chat_log_fts MATCH ? AND f.rowid >= ? AND f.rowid < ?" +
    " AND l.rk = ? AND l.rm_at IS NULL AND l.purged IS NULL AND l.text IS NOT NULL" +
    " AND l.k IN (" + qs(kinds.length) + ")" +
    " AND (CASE WHEN l.k = 'tx' THEN l.c >= ? ELSE l.c >= ? END)" +
    (approved ? "" : " AND l.aud <> 'a'") +
    (from > 0 ? " AND l.who IN (" + qs(from) + ")" : "") +
    outSql("l.", nOut, nTx) +
    " ORDER BY f.rowid DESC LIMIT ?";
}
/** The window plan l reads: the room's newest indexable rows inside the floors (chat_log_room, both c bounds).
 *  Params: [rk, cmin, hi, ...kinds, c_tx, c_chat, ...fromKeys, ...outParams]. */
function windowSql({ kinds = KINDS.all, approved = true, from = 0, nOut = 0, nTx = 0 } = {}) {
  return "SELECT * FROM chat_log WHERE rk = ? AND c >= ? AND c < ? AND rm_at IS NULL AND purged IS NULL AND text IS NOT NULL" +
    " AND k IN (" + qs(kinds.length) + ")" +
    " AND (CASE WHEN k = 'tx' THEN c >= ? ELSE c >= ? END)" +
    (approved ? "" : " AND aud <> 'a'") +
    (from > 0 ? " AND who IN (" + qs(from) + ")" : "") +
    outSql("", nOut, nTx) +
    " ORDER BY c DESC";
}
/** Plan l: every word somewhere in the text, inside a window of at most LIKE_ROWS rows (params: the window's, LIKE_ROWS, then one
 *  pattern per word, then the limit). The window comes newest first (no second sort: the caller orders the <= ROWS rows). */
function likeSql(o = {}, nWords = 1) {
  return "SELECT * FROM (" + windowSql(o) + " LIMIT ?) AS w WHERE " + new Array(Math.max(1, nWords)).fill("w.text LIKE ? ESCAPE '\\'").join(" AND ") +
    " LIMIT ?";
}
const likePat = (w) => "%" + String(w).replace(/[\\%_]/g, (c) => "\\" + c) + "%";
/** CL9 fix-up, plan w: ONE From key's indexable lines in the room inside the floors, newest first, on chat_log_who (who, c) - in
 *  index order, no sort (a who IN (a, b) list let the planner pick chat_log_room: 347 ms at 2M rows; per key: 0.07-9 ms).
 *  Params: [key, cmin, hi, rk, ...kinds, c_tx, c_chat, limit]. */
function whoSql({ kinds = KINDS.all, approved = true } = {}) {
  return "SELECT * FROM chat_log INDEXED BY chat_log_who WHERE who = ? AND c >= ? AND c < ? AND rk = ?" +
    " AND rm_at IS NULL AND purged IS NULL AND text IS NOT NULL AND k IN (" + qs(kinds.length) + ")" +
    " AND (CASE WHEN k = 'tx' THEN c >= ? ELSE c >= ? END)" +
    (approved ? "" : " AND aud <> 'a'") +
    " ORDER BY c DESC LIMIT ?";
}

/**
 * Where the query matches in a (projected) text: [[start, end], ...] merged and sorted, or null when some term doesn't match (AND).
 * Words compare folded (accents, case); the prefix term matches a word starting with it; a phrase = consecutive words; a CJK term
 * matches as a substring.
 */
function matchRanges(text, P) {
  if (typeof text !== "string" || !text || !P || !P.terms || !P.terms.length) return null;
  const toks = [];
  WORD.lastIndex = 0;
  let m;
  while ((m = WORD.exec(text))) toks.push({ s: m.index, e: m.index + m[0].length, f: fold(m[0]) });
  const low = text.toLowerCase();
  const hay = low.length === text.length ? low : text;          // a lower-casing that changes lengths: compare as written
  const out = [];
  for (const t of P.terms) {
    let hit = false;
    if (t.cjk) {
      const needle = t.words.join(" ");                          // lower-cased by parse (CJK scripts have no case)
      for (let i = hay.indexOf(needle); needle && i >= 0; i = hay.indexOf(needle, i + needle.length)) { out.push([i, i + needle.length]); hit = true; }
    } else {
      const k = t.f.length;
      for (let i = 0; i + k <= toks.length; i++) {
        let ok = true;
        for (let j = 0; j < k && ok; j++) {
          const w = t.f[j], f = toks[i + j].f;
          ok = f === w || (t.prefix && j === k - 1 && f.startsWith(w));
        }
        if (ok) { out.push([toks[i].s, toks[i + k - 1].e]); hit = true; }
      }
    }
    if (!hit) return null;
  }
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const r of out) {
    const top = merged[merged.length - 1];
    if (top && r[0] <= top[1]) top[1] = Math.max(top[1], r[1]); else merged.push([r[0], r[1]]);
  }
  return merged;
}
/** Plan w's cheap first test on a line's ORIGINAL text (what the index sees): every word of every term somewhere in it. */
function maybe(text, P) {
  if (typeof text !== "string" || !text) return false;
  const ft = fold(text), low = text.toLowerCase();
  return P.terms.every((t) => (t.cjk ? low.includes(t.words.join(" ")) : t.f.every((w) => ft.includes(w))));
}
/** CL9 fix-up: an exact word or phrase that holds a name redacted now (chatlogview.redact) can't match any projected line - the
 *  redaction replaced every bounded occurrence - so it finds nothing at once (no walk through every line that named them). */
function deadTerm(P, redact) {
  return P.terms.some((t) => {
    if (t.prefix || t.cjk) return false;
    const s = t.words.join(" ");
    try { return redact(s) !== s; } catch (e) { return true; }
  });
}

// ── the position: opaque, signed, bound to the room, the viewer and the query; an issue time ──
/** The query a position belongs to: its words (folded, how each matches), the kind, From, Hide Pepe and Before. */
function queryKey(P, kind, from, hidePepe, beforeTs) {
  const parts = [P.terms.map((t) => [t.f, t.quoted ? 1 : 0, t.prefix ? 1 : 0]), String(kind || "all"), String(from || ""), hidePepe ? 1 : 0,
                 beforeTs == null ? 0 : Math.floor(Number(beforeTs) || 0)];
  return crypto.createHash("sha256").update("chat-search-q:" + JSON.stringify(parts)).digest().slice(0, 16);
}
const macOf = (roomId, userId, qk, buf) => crypto.createHmac("sha256", KEY_MAC).update("chat-search:" + String(roomId) + "|" + String(userId) + "|")
  .update(Buffer.isBuffer(qk) ? qk : Buffer.from(String(qk || ""))).update("|").update(buf).digest().slice(0, 16);
const PLANS = ["f", "l", "w"];
/** pos = {scan, plan: f | l | w, exact} -> "s2.<base64url(iv | sealed fixed-width [scan, issued s, plan, exact] | mac)>" (the same
 *  length whatever the position). */
function sealPos(roomId, userId, qk, pos, t = Date.now()) {
  const scan = Math.max(0, Math.floor(Number(pos && pos.scan) || 0));
  const plan = PLANS.includes(pos && pos.plan) ? pos.plan : "f";
  const plain = String(scan).padStart(16, "0") + "." + String(Math.floor(t / 1000)).padStart(12, "0") + "." + plan + (pos && pos.exact ? "1" : "0");
  const iv = crypto.randomBytes(16);
  const ci = crypto.createCipheriv("aes-256-ctr", KEY_ENC, iv);
  const head = Buffer.concat([iv, ci.update(plain, "utf8"), ci.final()]);
  return "s2." + Buffer.concat([head, macOf(roomId, userId, qk, head)]).toString("base64url");
}
/** -> {scan, plan, exact} | throws 400 bad_cursor (forged, another room's, viewer's or query's, expired, garbage). */
function openPos(tok, roomId, userId, qk, t = Date.now()) {
  const bad = () => new Refuse(400, "Those results are out of date - search again.", "bad_cursor");
  const s = String(tok == null ? "" : tok);
  if (s.length > 200 || !/^s2\.[A-Za-z0-9_-]{40,}$/.test(s)) throw bad();
  const raw = Buffer.from(s.slice(3), "base64url");
  if (raw.length !== 16 + 32 + 16) throw bad();
  const head = raw.slice(0, raw.length - 16), mac = raw.slice(raw.length - 16);
  if (!crypto.timingSafeEqual(mac, macOf(roomId, userId, qk, head))) throw bad();
  let m = null;
  try {
    const d = crypto.createDecipheriv("aes-256-ctr", KEY_ENC, head.slice(0, 16));
    m = /^(\d{16})\.(\d{12})\.([flw])([01])$/.exec(Buffer.concat([d.update(head.slice(16)), d.final()]).toString("utf8"));
  } catch (e) { m = null; }
  if (!m || !(Number(m[1]) > 0)) throw bad();
  const issued = Number(m[2]) * 1000;
  if (issued > t + 60e3 || t - issued > CURSOR_TTL) throw bad();
  return { scan: Number(m[1]), plan: m[3], exact: m[4] === "1" };
}

// ── the reads ──
async function roRead(sql, params) {
  try { return await require("./chatlogdb").read(sql, params); } catch (e) {
    if (e && e.code === "unavailable") return getQuery(sql, params);          // no read connection (tests / tools): the shared one
    throw e;
  }
}
let unavailLogged = 0;
/** One search statement: the search connection's budget and queue (busy / too_broad -> the answers). CL9 fix-up: never the shared
 *  connection - no interrupt() there, and a slow statement would hold up ingest, DMs and the ledger (spec §3.4). */
async function runSearch(sql, params, opts = {}) {
  try {
    if (runner) return await runner(sql, params, opts);
    try { return await require("./chatlogdb").search(sql, params, opts); } catch (e) {
      if (!(e && e.code === "unavailable")) throw e;
      if (sharedOk) return await getQuery(sql, params);
      if (Date.now() - unavailLogged > 60e3) { unavailLogged = Date.now(); console.error("[chatlogsearch] no search connection - searches answer busy"); }
      throw busyRefusal();
    }
  } catch (e) {
    if (e && e.refuse) throw e;
    if (e && e.code === "too_broad") throw new Refuse(422, "Too broad - add a word.", "too_broad");
    if (e && e.code === "busy") throw new Refuse(429, "Search is busy - try again in a moment.", "busy", { retry: 2 });
    throw e;
  }
}

// ── the room token: only for rooms under RT_SHARE of the indexed rows ──
let SHARE = { at: 0, rows: new Map(), total: 0 };
async function useToken(rk) {
  if (Date.now() - SHARE.at > 60e3) {
    const rows = new Map();
    let total = 0;
    for (const r of await getQuery("SELECT rk, idx_rows FROM chatlog_rooms")) { const n = Math.max(0, Number(r.idx_rows) || 0); rows.set(Number(r.rk), n); total += n; }
    SHARE = { at: Date.now(), rows, total };
  }
  const n = SHARE.rows.get(Number(rk)) || 0;
  return SHARE.total > 0 && n / SHARE.total < CL.RT_SHARE;
}

// ── the last-word prefixes too broad for their budget (a shorter prefix of a broad one is broad too) ──
function isBroad(p) {
  if (!p) return false;
  const t = Date.now();
  for (const [q, at] of BROAD) {
    if (t - at > BROAD_TTL) { BROAD.delete(q); continue; }
    if (q.startsWith(p)) return true;
  }
  return false;
}
function noteBroad(p) {
  if (!p) return;
  BROAD.delete(p);
  BROAD.set(p, Date.now());
  while (BROAD.size > BROAD_MAX) BROAD.delete(BROAD.keys().next().value);
}

// ── who can't be found by this viewer ──
/** The chat keys of the people who DM-blocked this viewer (their account u:<id> and their linked login). */
async function blockersOf(userId) {
  const out = new Set();
  const has = (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dm_blocks'")).length > 0;
  if (!has) return out;
  const ids = (await getQuery("SELECT blocker_id FROM dm_blocks WHERE blocked_id = ?", [String(userId)])).map((r) => String(r.blocker_id));
  for (let i = 0; i < ids.length; i += 400) {
    const part = ids.slice(i, i + 400);
    for (const id of part) out.add("u:" + id.toLowerCase());
    for (const r of await getQuery(`SELECT camfrogUsername FROM users WHERE userId IN (${part.map(() => "?").join(",")})`, part)) {
      if (r.camfrogUsername) out.add(String(r.camfrogUsername).trim().toLowerCase());
    }
  }
  // (review 2 fix-up: no "h:<hash>" keys any more - a line shown as "someone" is never told apart by who blocked the viewer, see
  // searchable; the blocked viewer knows who blocked them, so dropping only the blocker's "someone" lines from their search named them)
  return out;
}
/** From as typed -> the normalised value ("" = none): NFKC, controls out, @ and spaces trimmed, lower-cased. */
function normFrom(raw) {
  return String(raw == null ? "" : raw).normalize("NFKC").replace(CTRL, "").trim().replace(/^@+/, "").slice(0, FROM_MAX).trim().toLowerCase();
}
/** From: a PATV username (its account's u: key + its linked login) - or, when no account has that username, an exact Camfrog login.
 *  CL9 fix-up: the username wins (From=bob no longer mixes the PATV user bob with someone else whose Camfrog login is "bob").
 *  -> [keys] (lower-cased) */
async function fromKeysOf(raw) {
  const low = normFrom(raw);
  if (!low) return [];
  let u = null;
  try { u = (await getQuery("SELECT userId, camfrogUsername FROM users WHERE lower(username) = ? LIMIT 1", [low]))[0] || null; } catch (e) { u = null; }
  if (u) {
    const keys = new Set(["u:" + String(u.userId).toLowerCase()]);
    if (u.camfrogUsername) keys.add(String(u.camfrogUsername).trim().toLowerCase());
    return [...keys];
  }
  return LOGIN_RE.test(low) ? [low] : [];
}
/** May this author's lines be searched by this viewer? Not a private-activity account (the name cache's flag; CL9 fix-up: a key
 *  whose lookup failed - no entry - counts as private: fails closed) - the viewer's own lines always are; not someone who DM-blocked
 *  the viewer. Review 2 fix-up: a line the projection shows as "someone" (an incognito person's - named before, or Pepe's
 *  anonymised "h:" row) skips these identity filters: it is searched like everyone's, by its words, never by a name. Leaving out
 *  only the "someone" lines of a blocker (or of a private-activity account) told viewers which "someone" lines were whose - the
 *  blocked person knows who blocked them, and scrollback still shows every one of those lines. */
function searchable(it, L, B, blockers, own) {
  const u = it.u;
  if (it.c != null && require("./chatlogview").privacyOf(it) === "anon") return true;
  if (!u || u.anon || !u.login) return true;
  const login = String(u.login).toLowerCase();
  if (own && own.has(login)) return true;
  if (blockers && blockers.has(login)) return false;
  const k = B.nameKey(u.login);
  if (!k) return true;                                   // not a key an account can have: nobody's private activity
  const e = L ? L.get(k) : null;
  if (!e) return false;
  return !(e.acc && e.priv !== false);
}

// ── the limits ──
let HIT = null;
const DAY = new Map();             // userId -> {d: UTC day number, n: searches}
/** 20 requests a minute - every request, a refused one too (CL9 fix-up: probing pads and views is limited like searching). */
function minuteHit(userId) {
  if (!HIT) HIT = require("./middleware/authGuard").limiter({ max: limits.perMin, windowMs: 60e3 });
  const wait = HIT.blocked(userId);
  if (wait) throw new Refuse(429, "Slow down - try again in a minute.", "rate", { retry: wait });
  HIT.hit(userId);
}
/** 300 searches a day: the ones that run. */
function dailyTake(userId) {
  const d = Math.floor(Date.now() / 864e5);
  let cur = DAY.get(userId);
  if (!cur || cur.d !== d) { cur = { d, n: 0 }; DAY.set(userId, cur); }
  if (cur.n >= limits.perDay) throw new Refuse(429, "You've searched a lot today - try again tomorrow.", "daily");
  cur.n++;
  if (DAY.size > 50000) DAY.delete(DAY.keys().next().value);
}

const bool = (v) => v === true || v === 1 || v === "1" || v === "true" || v === "on";
/** `before`: ms since 1970 or an ISO-8601 date / time -> ms | null */
function timeOf(v) {
  const s = String(v == null ? "" : v).trim().slice(0, 40);
  if (/^\d{9,15}$/.test(s)) return Number(s);
  if (!/^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** One search for a viewer. b = the request body. -> the answer | throws Refuse. */
async function search(user, slug, b = {}) {
  if (!CL.on("search") || !CL.on("history")) throw new Refuse(404, "Search isn't available here yet.", "off");
  if (!user || !user.userId) throw new Refuse(401, "Sign in to search this pad's chat.", "signin");
  const uid = String(user.userId);
  minuteHit(uid);                                                       // CL9 fix-up: before any refusal below - they count too
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
  if (!V.can.history) throw new Refuse(403, "Earlier chat on this pad isn't available to you.", "no_history");
  if (!V.can.search) throw new Refuse(403, "Search is off on this pad.", "search_off");
  const P = parse(typeof b.q === "string" ? b.q : "");
  if (!P.ok) throw new Refuse(400, "Type at least one word of 2 or more letters.", "too_short");
  const kind = Object.prototype.hasOwnProperty.call(KINDS, b.kind) ? b.kind : "all";
  const n0 = Math.floor(Number(b.limit));
  const limit = Number.isFinite(n0) && b.limit != null && b.limit !== "" ? Math.min(LIMIT_MAX, Math.max(1, n0)) : PAGE;
  const hidePepe = bool(b.hide_pepe);
  let beforeTs = null;
  if (b.before != null && b.before !== "") {
    beforeTs = timeOf(b.before);
    if (beforeTs == null) throw new Refuse(400, "Pick a date.", "bad_before");
  }
  const from = normFrom(b.from);
  const qk = queryKey(P, kind, from, hidePepe, beforeTs);
  const pos = b.cursor != null && b.cursor !== "" ? openPos(b.cursor, roomId, uid, qk) : null;
  // the sticky hidden set isn't loaded yet (a restart): it fails closed - every line would be dropped; ask again in a moment
  if (typeof CL.hiddenReady === "function" && !CL.hiddenReady()) throw busyRefusal();
  dailyTake(uid);
  let acts = null;
  try { acts = require("./chatlogmod").actsFor(V, user); } catch (e) { acts = null; }

  // the plan: w for From, f on the index, l without it (or for CJK); a position keeps its page's plan
  const ftsOn = !!CL.ftsState().on;
  let plan = pos ? pos.plan : from ? "w" : ftsOn && !P.cjk ? "f" : "l";
  if (plan === "f" && (!ftsOn || P.cjk)) plan = "l";
  if (plan === "w" && !from) plan = ftsOn && !P.cjk ? "f" : "l";
  const prefix0 = lastPrefix(P);
  let exact = !!(pos && pos.exact) || (plan === "f" && !!prefix0 && PREFIX_FALLBACK && isBroad(prefix0));
  const partialOf = (p) => p === "l" || (p === "f" && CL.ftsPartial());
  const answer = (hits, more, cursor) => Object.assign({ ok: true, hits, more: !!more, cursor: more ? cursor || null : null, acts: acts || null },
    plan === "f" && exact && prefix0 ? { exact: P.terms[P.terms.length - 1].words[0] } : {}, partialOf(plan) ? { partial: true } : {});
  const rk = V.rk;
  if (rk == null) return answer([], false, null);

  const B = require("./bridge");
  const blockers = await blockersOf(uid);
  const own = new Set(["u:" + uid.toLowerCase(), login ? String(login).trim().toLowerCase() : null].filter(Boolean));
  // From: the keys this viewer may find; the ones left out (hidden, private activity, DM-blocked the viewer, !transcripts off for a
  // 🎙-only search) never reach the SQL - a key no line has stands in, so every From runs the same statement
  let fromKeys = null;
  const txOff = new Set();
  if (from) {
    const keys = await fromKeysOf(from);
    const L = keys.length ? await B.resolveNames(keys.map((k) => ({ login: k }))) : null;
    fromKeys = keys.filter((k) => !CV.isHiddenLogin(k) && !(kind === "mic" && CL.isTxHiddenKey(k)) && searchable({ u: { login: k } }, L, B, blockers, own));
    for (const k of fromKeys) if (CL.isTxHiddenKey(k)) txOff.add(k);
    if (!fromKeys.length) fromKeys = [SENTINEL];
  }
  // an exact word or phrase naming someone hidden now matches no projected line
  if (deadTerm(P, CV.redact)) return answer([], false, null);
  let hi = C_MAX;
  if (beforeTs != null) {
    const seek = (await roRead("SELECT c FROM chat_log WHERE rk = ? AND ts >= ? ORDER BY ts LIMIT 1", [rk, Math.max(0, Math.floor(beforeTs))]))[0];
    if (seek) hi = Math.min(hi, Number(seek.c));
  }
  if (pos) hi = Math.min(hi, pos.scan);
  // the SEARCH floors (wm_search for viewers without full history) as cursors
  const sf = V.searchFloor;
  const cb = await CV.cursorBounds(rk, { chat: sf.chat, tx: sf.tx, presence: sf.chat });
  const cTx = cb.tx == null ? C_MAX : cb.tx, cChat = cb.chat == null ? C_MAX : cb.chat;
  const kinds = KINDS[kind];
  const cmin = Math.min(kinds.includes("tx") ? cTx : C_MAX, kinds.some((k) => k !== "tx") ? cChat : C_MAX);
  if (cmin >= hi) return answer([], false, null);

  // the people left out in SQL: the sticky hidden set's (chatloghist.hiddenLogins) and the viewer's DM-blockers
  const X = hiddenSql ? require("./chatloghist").hiddenLogins() : { out: [], tx: [] };
  const outSet = new Set(X.out);
  // (review 2 fix-up: never a blocker who is incognito now - their lines are "someone", searched like everyone's: see searchable)
  if (hiddenSql) {
    let n = 0;
    for (const k of blockers) {
      if (n >= OUT_SQL_MAX) break;
      if (!own.has(k) && !outSet.has(k) && CL.hiddenKind(CL.hash(k)) !== "anon") { outSet.add(k); n++; }
    }
  }
  const out = [...outSet], txList = X.tx.filter((k) => !outSet.has(k));
  const hp = outParams(out, txList);
  const o = { kinds, approved: !!V.inside, nOut: out.length, nTx: txList.length };
  const token = (await useToken(rk)) ? rk : null;
  const likeWords = [...new Set(P.terms.flatMap((t) => (t.cjk ? [t.words.join(" ")] : t.words)))];

  /** One fetch below `top` (exclusive). -> {rows (newest first), next: the position everything at or above it was read down to,
   *  null = the rows ran out} */
  async function fetchOnce(top) {
    if (plan === "w") {
      let rows = [], next = null;
      for (const key of fromKeys) {
        const ks = txOff.has(key) ? kinds.filter((k) => k !== "tx") : kinds;
        if (!ks.length) continue;
        const r = await runSearch(whoSql({ kinds: ks, approved: o.approved }), [key, cmin, top, rk, ...ks, cTx, cChat, WHO_ROWS]);
        if (r.length >= WHO_ROWS) { const low = Number(r[r.length - 1].c); next = next == null ? low : Math.max(next, low); }
        rows = rows.concat(r);
      }
      rows.sort((x, y) => Number(y.c) - Number(x.c));
      // two keys: each list is complete only down to its own last row - keep what both cover (the rest comes again next time)
      if (next != null) rows = rows.filter((r) => Number(r.c) >= next);
      const Pe = exact ? exactLast(P) : P;
      return { rows: rows.filter((r) => maybe(r.text, Pe)), next };
    }
    const fo = Object.assign({}, o, { from: fromKeys ? fromKeys.length : 0 });
    if (plan === "f") {
      const Pe = exact ? exactLast(P) : P;
      const rows = await runSearch(ftsSql(fo), [ftsMatch(Pe, token), cmin, top, rk, ...kinds, cTx, cChat, ...(fromKeys || []), ...hp, ROWS],
                                   lastPrefix(Pe) ? { budgetMs: limits.prefixMs } : {});
      return { rows, next: rows.length >= ROWS ? Number(rows[rows.length - 1].c) : null };
    }
    const wp = [rk, cmin, top, ...kinds, cTx, cChat, ...(fromKeys || []), ...hp];
    const rows = (await runSearch(likeSql(fo, likeWords.length), [...wp, LIKE_ROWS, ...likeWords.map(likePat), ROWS])).sort((x, y) => Number(y.c) - Number(x.c));
    if (rows.length >= ROWS) return { rows, next: Number(rows[rows.length - 1].c) };
    // fewer than ROWS matches: the whole window was read - when it was full, the next fetch starts under it
    const end = (await runSearch(windowSql(fo) + " LIMIT 1 OFFSET ?", [...wp, LIKE_ROWS - 1]))[0];
    return { rows, next: end ? Number(end.c) : null };
  }

  // the loop: limit + 1 visible hits (so `more` means another one exists), the rows' end, or the budget
  const Vs = Object.assign({}, V, { floor: { chat: sf.chat, tx: sf.tx, presence: sf.chat } });
  const need = limit + 1, found = [], t0 = Date.now();
  let fetches = 0, stop = null;
  while (!stop) {
    if (cmin >= hi) { stop = "end"; break; }
    if (fetches >= limits.fetchMax || (fetches > 0 && Date.now() - t0 > limits.reqMs)) { stop = "budget"; break; }
    let got;
    try { got = await fetchOnce(hi); } catch (e) {
      if (!(e && e.refuse && e.code === "too_broad")) throw e;
      if (fetches === 0 && plan === "f" && !exact && prefix0 && PREFIX_FALLBACK) {
        // the last word's prefix is too common: remember it, then the same search with that word exact
        noteBroad(prefix0);
        exact = true;
        if (deadTerm(exactLast(P), CV.redact)) { stop = "end"; break; }
        continue;
      }
      if (fetches === 0 && plan === "w") { plan = ftsOn && !P.cjk ? "f" : "l"; exact = exact || (plan === "f" && !!prefix0 && isBroad(prefix0)); continue; }
      if (fetches > 0) { stop = "budget"; break; }
      throw e;
    }
    fetches++;
    const Pe = exact ? exactLast(P) : P;
    const items = got.rows.map(CV.itemOf);
    const keep = new Set(CV.filter(items, { view: Vs, jc: null }).items);
    const L = await B.resolveNames(items.filter((it) => keep.has(it)).map((it) => it.u).filter(Boolean));
    for (const it of items) {
      if (!keep.has(it) || !searchable(it, L, B, blockers, own)) continue;
      if (hidePepe && it.u && it.u.self) continue;
      const hl = matchRanges(CV.redact(it.text), Pe);
      if (!hl) continue;
      found.push({ it, hl });
      if (found.length >= need) { stop = "need"; break; }
    }
    if (stop) break;
    if (got.next == null) { stop = "end"; break; }
    hi = got.next;
  }
  const shown = found.slice(0, limit);
  let more = false, scan = null;
  if (stop === "need") { more = true; scan = Number(shown[shown.length - 1].it.c); }      // a visible hit's own position
  else if (stop === "budget") { more = true; scan = hi; }                               // everything at or above it was read
  // a staff search below the public floor: audited (coalesced per user, room and 10 minutes)
  if (V.audit) {
    const below = shown.filter((h) => Number(h.it.ts) < CV.pubFloor(V, h.it.k));
    if (below.length) CV.auditRead(V, roomId, "search", below[below.length - 1].it.ts, below[0].it.ts).catch(() => {});
  }
  const dressed = await require("./chatloghist").dress(roomId, shown.map((h) => h.it), V, user, login, acts);
  const hits = dressed.map((item, i) => ({ item, hl: shown[i].hl }));
  return answer(hits, more, more && scan > 0 ? sealPos(roomId, uid, qk, { scan, plan, exact }) : null);
}

function register(app, { addUser }) {
  const guard = require("./middleware/authGuard");
  const head = (res) => res.set({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive" });
  // (no body parser of its own: index.js parses every body first - its own limit; each field is sliced here)
  app.post("/api/rooms/:slug/search", addUser, async (req, res) => {
    head(res);
    if (req.get("X-Requested-With") !== "fetch" || !guard.sameSite(req)) return res.status(403).json({ ok: false, error: "Security check failed - reload the page.", code: "origin" });
    try { res.json(await search(req.user, req.params.slug, req.body && typeof req.body === "object" ? req.body : {})); } catch (e) {
      if (e && e.refuse) {
        if (e.retry) res.set("Retry-After", String(e.retry));
        return res.status(e.status || 400).json({ ok: false, error: e.message, code: e.code || undefined });
      }
      // never the message: an FTS5 error quotes the query
      console.error("[chatlogsearch] search failed:", (e && e.code) || "error");
      res.status(500).json({ ok: false, error: "Couldn't search - try again." });
    }
  });
}

module.exports = {
  register, search, parse, exactLast, ftsMatch, ftsSql, windowSql, likeSql, likePat, whoSql, outSql, outParams, matchRanges, maybe, deadTerm, fold,
  queryKey, sealPos, openPos, timeOf, normFrom, fromKeysOf, blockersOf, searchable, isBroad, Refuse,
  PAGE, LIMIT_MAX, ROWS, WHO_ROWS, FETCH_MAX, REQ_MS, PREFIX_MIN, PREFIX_FALLBACK, PREFIX_BUDGET_MS, TERM_MIN, TERMS_MAX, Q_MAX, PER_MIN, PER_DAY,
  LIKE_ROWS, CURSOR_TTL, KINDS, SENTINEL,
  _setRunner: (f) => { runner = f || null; },
  _setLimits: (o) => { Object.assign(limits, o || {}); HIT = null; },
  _allowShared: (v) => { sharedOk = !!v; },
  _setHiddenSql: (v) => { hiddenSql = v !== false; },
  _reset: () => {
    Object.assign(limits, { perMin: PER_MIN, perDay: PER_DAY, fetchMax: FETCH_MAX, reqMs: REQ_MS, prefixMs: PREFIX_BUDGET_MS });
    HIT = null; DAY.clear(); runner = null; hiddenSql = true; BROAD.clear(); SHARE = { at: 0, rows: new Map(), total: 0 };
  },
};
