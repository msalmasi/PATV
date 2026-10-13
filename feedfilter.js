// feedfilter.js — the cheap content filter for feed posts and comments (1.99ux). No model, no network: word and pattern
// lists checked synchronously when a post or comment is submitted (typically well under 5 ms). It is the FLOOR a pad owner
// can switch on; Pepe's AI feed moderation (feedautomod.js) is the owner's optional EXTRA on top and runs afterwards, on
// his own schedule, over whatever the filter let through (or hid). Both are opt-in per pad.
//
// CATEGORIES (what scan() looks for)                                             default action
//   hate      slurs + hate terms / phrases; obfuscation-tolerant (leetspeak, spacing, punctuation inside a word,
//             repeated letters, homoglyphs, accents, zero-width characters, full-width / maths letters)   hide
//   doxxing   phone numbers, government-ID-like numbers (SSN, NI, SIN), card numbers (Luhn), public IP addresses
//             = STRONG; emails, street addresses, postcodes = WEAK (one weak signal alone is at most flagged; two
//             weak kinds, or a weak one + a cue like "her address is", act fully). Prices, dates, times, versions,
//             PAT amounts, private IPs and famous public addresses are not matched.                      hide
//   threats   threats of violence, "kys" / "kill yourself", swatting / doxxing threats                    flag
//   selfharm  someone saying they may hurt themselves. NEVER a punishment: "notice" = the author gets a gentle
//             inbox note with helplines and the post goes up as normal; "flag" = that + the owner's queue.  notice
//   spam      link floods, character / word floods, mention floods, the same text posted again and again,
//             PAT / crypto scam lines, fake staff announcements                                           flag
// ACTIONS per category: allow (count it only) | flag (a report in the pad owner's queue + the admins' queue, the
// author is told nothing changed) | hide (hidden in that pad pending review + the report; the author is told) |
// block (refused on submit with a message saying why - nothing is stored). selfharm: allow | notice | flag.
// The strictest category decides; doxxing with only one weak signal is capped at flag.
//
// SETTINGS (feed_kv): "filter:global" {enabled = the MASTER switch (off = nothing runs anywhere), default_on (pads that
// haven't chosen; off = opt-in), actions (the default action per category)}; "filter:scope:<padId>" {on (null =
// follow default_on), actions (per-category overrides), admin_lock}. Profile pads (user:<id>) are pads like any other.
// Owners set theirs on the owner panel's 🧹 Safety card (/p/<slug>/owner#safety); admins on /feed/admin/filter.
// NOTE 1.99ux: a site-wide command/feature master-switch model was being built in parallel; this module keeps its own
// simple master + default (filter:global.enabled / default_on) until that lands - fold it in then.
//
// NEVER FILTERED: Pepe, site staff, the pad's own owner (they are its moderators - as in feedautomod), posts made on
// someone's behalf (room generations, story keeps). Image safety, reports, TAKE IT DOWN and the CSAM escalation are
// separate and always on.
//
// THE LISTS live in data/feedfilter-lists.json as base64-encoded JSON (this repo is PUBLIC: the slur list should not be
// readable, greppable or indexed as plain text there), and admins can replace them from /feed/admin/filter - an edited
// set is stored in the DB (feed_kv "filter:lists"), never in the repo; "reset" goes back to the file.
// tools/feedfilter-lists.js decodes / encodes the file.
//
// AUDIT: feed_filter_daily (day, cat, action, n) counts every hit (allowed ones too) for tuning false positives;
// feed_filter keeps one row per flag / hide / block (the category, the KIND of match and the list entry - never the
// matched personal data itself) for the owner's card and the admin page. Self-harm "notice" hits are counted, not logged.
"use strict";
const fs = require("fs");
const path = require("path");
const { runQuery, getQuery } = require("./dbUtils");
const rooms = require("./rooms");

const CATS = Object.freeze(["hate", "doxxing", "threats", "selfharm", "spam"]);
const ACTIONS = Object.freeze(["allow", "flag", "hide", "block"]);
const SELFHARM_ACTIONS = Object.freeze(["allow", "notice", "flag"]);
const DEFAULT_ACTIONS = Object.freeze({ hate: "hide", doxxing: "hide", threats: "flag", selfharm: "notice", spam: "flag" });
const GLOBAL_DEFAULTS = Object.freeze({ enabled: true, default_on: false, actions: DEFAULT_ACTIONS });
const RANK = Object.freeze({ allow: 0, notice: 0, flag: 1, hide: 2, block: 3 });
const REPORT_REASON = Object.freeze({ hate: "hate", doxxing: "personal", threats: "violence", spam: "spam", selfharm: "other" });
const FILTER_ID = "patv-filter";          // the reporter id on the filter's reports (like feedstore.PEPE_ID for Pepe's)
const BY = "patv-filter";                 // feed_post_rooms.hidden_by for a filter hide
const APPEAL = "/terms#moderation";
const LIST_FILE = path.join(__dirname, "data", "feedfilter-lists.json");
const LIST_KEYS = Object.freeze(["hate_words", "hate_phrases", "hate_allow", "hate_allow_phrases", "threat_phrases", "selfharm_phrases",
  "spam_phrases", "dox_cues", "dox_public"]);
const LIST_MAX = 2000, LINE_MAX = 400;
const SPAM = Object.freeze({ links_post: 5, links_comment: 3, mentions: 10, dup_window_ms: 30 * 60e3, dup_count: 3, dup_min_chars: 12 });
const CACHE_MS = 30e3;
let NOW = () => Date.now();

// ── the lists ────────────────────────────────────────────────────────────────────────────────────────────────────────
function decodeFile(j) {
  const b64 = Array.isArray(j.data) ? j.data.join("") : String(j.data || "");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}
function encodeFile(lists) {
  const b64 = Buffer.from(JSON.stringify(lists), "utf8").toString("base64");
  const data = [];
  for (let i = 0; i < b64.length; i += 100) data.push(b64.slice(i, i + 100));
  return { _about: "PATV content filter word lists (feedfilter.js). base64-encoded JSON so the slur list isn't plain text in this public repo. Decode/encode: node tools/feedfilter-lists.js",
           format: "base64-json", v: 1, data };
}
function fileLists() {
  try { return cleanLists(decodeFile(JSON.parse(fs.readFileSync(LIST_FILE, "utf8")))); }
  catch (e) { console.error("[filter] list file:", e.message); return cleanLists({}); }
}
/** {key: [lines]} - every known key, trimmed, lower-cased, de-duplicated, capped. */
function cleanLists(L) {
  const out = {};
  for (const k of LIST_KEYS) {
    const src = Array.isArray(L && L[k]) ? L[k] : typeof (L && L[k]) === "string" ? L[k].split(/\r?\n/) : [];
    const seen = new Set();
    out[k] = [];
    for (const raw of src) {
      const s = String(raw == null ? "" : raw).toLowerCase().replace(/\s+/g, " ").trim();
      if (!s || s.startsWith("#") || seen.has(s)) continue;
      seen.add(s);
      out[k].push(s);
      if (out[k].length >= LIST_MAX) break;
    }
  }
  return out;
}

// ── normalising ──────────────────────────────────────────────────────────────────────────────────────────────────────
// look-alike letters (after lower-casing) -> latin. NFKC already folds full-width / maths / circled letters.
const HOMO = {
  "а": "a", "в": "b", "е": "e", "ё": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x", "і": "i",
  "ї": "i", "ј": "j", "ѕ": "s", "һ": "h", "ԁ": "d", "ӏ": "l", "ɡ": "g", "ԛ": "q", "ԝ": "w", "ү": "y", "ց": "g", "օ": "o", "ս": "u",
  "α": "a", "β": "b", "γ": "y", "ε": "e", "η": "n", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "ω": "w",
  "ı": "i", "ł": "l", "ø": "o", "đ": "d", "ð": "d", "þ": "p", "ß": "ss", "æ": "ae", "œ": "oe", "ŋ": "n", "ſ": "s", "ɑ": "a", "ʀ": "r", "ᴀ": "a",
  "ʙ": "b", "ᴄ": "c", "ᴅ": "d", "ᴇ": "e", "ɢ": "g", "ʜ": "h", "ɪ": "i", "ᴊ": "j", "ᴋ": "k", "ʟ": "l", "ᴍ": "m", "ɴ": "n", "ᴏ": "o", "ᴘ": "p",
  "ᴛ": "t", "ᴜ": "u", "ᴠ": "v", "ᴡ": "w", "ʏ": "y", "ᴢ": "z",
};
const NON_ASCII = /[^\x00-\x7f]/g;
/** lower-case, look-alikes folded, accents and invisible format characters stripped */
function normalize(s) {
  let t = String(s == null ? "" : s).normalize("NFKC").replace(/\p{Cf}/gu, "").toLowerCase();
  t = t.replace(NON_ASCII, (ch) => (HOMO[ch] != null ? HOMO[ch] : ch));
  return t.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");
}
// leetspeak: what each letter of a list entry may be typed as
const LEET = { a: "a@4", b: "b8", e: "e3€", g: "g9", i: "i1!|", l: "l1|", o: "o0", s: "s5$", t: "t7+", z: "z2" };
const KEEP = /[^a-z0-9@$!|+€]/g;                 // what survives inside a word (letters, digits, leet symbols)
const SPLIT = /[^a-z0-9@$!|+€]+/;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
/** a word as a run-tolerant, leet-tolerant pattern: "nigg" -> n+ i+ g{2,} (extra repeats are fine, fewer aren't) */
function wordRe(w, strict = false) {
  let out = "", i = 0;
  while (i < w.length) {
    const c = w[i];
    let n = 1;
    while (w[i + n] === c) n++;
    i += n;
    const cls = strict ? null : LEET[c];
    if (strict) { out += escRe(c.repeat(n)); continue; }
    const body = cls ? "[" + cls.replace(/[\]\\^-]/g, "\\$&").replace(/\|/g, "\\|") + "]" : escRe(c);
    out += /[a-z]/.test(c) ? (n > 1 ? `${body}{${n},}` : `${body}+`) : body.repeat(n);
  }
  return out;
}
/**
 * A phrase -> a pattern over the "words" string (tokens joined by single spaces, padded with a space at both ends).
 * Syntax: words in order; [a|b c] = one of; [x]? = optional; ~ = up to two filler words; apostrophes are ignored.
 */
function phraseRe(p) {
  const parts = [];
  const rx = /\[([^\]]*)\](\?)?|(~)|([^\s[\]~]+)/g;
  let m;
  while ((m = rx.exec(p))) {
    if (m[3]) { parts.push("(?: [^ ]+){0,2}"); continue; }
    const alts = m[1] != null ? m[1].split("|") : [m[4]];
    const res = alts.map((a) => a.replace(/'/g, "").replace(KEEP, " ").trim().split(/\s+/).filter(Boolean).map(wordRe).join(" ")).filter(Boolean);
    if (!res.length) continue;
    const body = res.length === 1 ? res[0] : "(?:" + res.join("|") + ")";
    parts.push(m[2] ? `(?: ${body})?` : ` ${body}`);
  }
  if (!parts.length || parts.every((x) => x.startsWith("(?: [^ ]+)") || x.startsWith("(?: "))) return null;
  return parts.join("") + "(?= )";
}

// ── compiled lists (cached; rebuilt when the admins change them) ─────────────────────────────────────────────────────
let LISTS = null;            // {source: 'file'|'db', lists, C}
function compileWords(entries, strict = false) {
  const exact = [], prefix = [], contains = [], phrases = [];
  for (const e of entries) {
    const pre = e.startsWith("*"), suf = e.endsWith("*");
    const w = e.replace(/^\*|\*$/g, "");
    if (!w) continue;
    if (/\s/.test(w)) { phrases.push(w); continue; }         // two words: matched as a phrase
    const re = wordRe(w.replace(KEEP, ""), strict);
    if (!re) continue;
    (pre && suf ? contains : suf ? prefix : exact).push({ e, re });
  }
  const one = (xs, a, b) => (xs.length ? new RegExp(a + "(?:" + xs.map((x) => x.re).join("|") + ")" + b) : null);
  return { exact, prefix, contains, phrases, X: one(exact, "^", "$"), P: one(prefix, "^", ""), N: one(contains, "", "") };
}
function compilePhrases(list) {
  const items = [];
  for (const p of list) { const re = phraseRe(p); if (re) items.push({ e: p, re, rx: new RegExp(re) }); }
  return { items, all: items.length ? new RegExp("(?:" + items.map((x) => x.re).join("|") + ")") : null };
}
function compile(lists) {
  const words = compileWords(lists.hate_words);
  const allowW = compileWords(lists.hate_allow, true);      // allow entries match as written (no stretching / leet)
  return {
    words, allowWords: allowW,
    hatePhrases: compilePhrases(lists.hate_phrases.concat(words.phrases)),
    allowPhrases: compilePhrases(lists.hate_allow_phrases),
    threats: compilePhrases(lists.threat_phrases), selfharm: compilePhrases(lists.selfharm_phrases), spam: compilePhrases(lists.spam_phrases),
    cues: compilePhrases(lists.dox_cues), publicAddr: lists.dox_public.map((x) => " " + x.replace(KEEP, " ").replace(/\s+/g, " ").trim() + " "),
  };
}
function compiled() {
  if (!LISTS) { const lists = fileLists(); LISTS = { source: "file", lists, C: compile(lists) }; }
  return LISTS.C;
}
/** Check a set of lists compiles; -> null or the first bad line. */
function listProblem(lists) {
  for (const k of LIST_KEYS) {
    for (const line of lists[k]) {
      if (line.length > LINE_MAX) return `${k}: a line is longer than ${LINE_MAX} characters`;
      let depth = 0;
      for (const ch of line) { if (ch === "[") depth++; else if (ch === "]") depth--; if (depth < 0 || depth > 1) break; }
      if (depth !== 0) return `${k}: "${line}" has unbalanced [ ]`;
      try {
        if (/phrases|cues/.test(k)) { const r = phraseRe(line); if (!r) return `${k}: "${line}" has no words`; new RegExp(r); }
        else if (k !== "dox_public") { const w = line.replace(/^\*|\*$/g, ""); if (/\s/.test(w)) { const r = phraseRe(w); if (r) new RegExp(r); } else if (!w.replace(KEEP, "")) return `${k}: "${line}" has no letters`; else new RegExp(wordRe(w.replace(KEEP, ""))); }
      } catch (e) { return `${k}: "${line}" - ${e.message}`; }
    }
  }
  return null;
}

// ── scanning (pure + synchronous) ────────────────────────────────────────────────────────────────────────────────────
/** text -> {tokens: [{a, pieces}], words: " w1 w2 ... "} */
function tokenize(norm) {
  const tokens = [];
  for (const raw of norm.split(/\s+/)) {
    if (!raw) continue;
    if (/^(?:https?:\/\/|www\.)/.test(raw) || /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(raw)) continue;   // links and emails aren't words
    const t = raw.replace(/'/g, "").replace(/^[\s"“”‘’()[\]{}<>*_~.,;:?-]+/, "").replace(/[\s"“”‘’()[\]{}<>*_~.,;:?!-]+$/, "");
    const a = t.replace(KEEP, "");
    if (!a) continue;
    const pieces = t.split(SPLIT).filter((x) => x && x !== a);
    tokens.push({ a, pieces });
  }
  return { tokens, words: " " + tokens.map((x) => x.a).join(" ") + " " };
}
function firstEntry(list, s) { for (const x of list) if (new RegExp(x.re).test(s)) return x.e; return null; }
function wordHit(C, s) {
  const W = C.words, A = C.allowWords;
  if ((A.X && A.X.test(s)) || (A.P && A.P.test(s)) || (A.N && A.N.test(s))) return null;
  if (W.X && W.X.test(s)) return firstEntry(W.exact.map((x) => ({ e: x.e, re: "^(?:" + x.re + ")$" })), s);
  if (W.P && W.P.test(s)) return firstEntry(W.prefix.map((x) => ({ e: x.e, re: "^(?:" + x.re + ")" })), s);
  if (W.N && W.N.test(s)) return firstEntry(W.contains, s);
  return null;
}
function phraseHits(P, words, cap = 3) {
  if (!P.all || !P.all.test(words)) return [];
  const out = [];
  for (const x of P.items) { if (x.rx.test(words)) { out.push(x.e); if (out.length >= cap) break; } }
  return out;
}
/** token indexes covered by an allowed phrase ("chink in the armour") */
function allowedTokens(C, T) {
  const skip = new Set();
  if (!C.allowPhrases.all || !C.allowPhrases.all.test(T.words)) return skip;
  const starts = [];
  let pos = 1;
  for (const t of T.tokens) { starts.push(pos); pos += t.a.length + 1; }
  for (const x of C.allowPhrases.items) {
    const g = new RegExp(x.re, "g");
    let m;
    while ((m = g.exec(T.words))) {
      const a = m.index, b = m.index + m[0].length;
      starts.forEach((s, i) => { if (s >= a && s < b) skip.add(i); });
      if (g.lastIndex === m.index) g.lastIndex++;
    }
  }
  return skip;
}

function scanHate(C, T) {
  const terms = [];
  const skip = allowedTokens(C, T);
  const seen = new Set();
  const test = (s) => { if (s.length < 2 || seen.has(s)) return; seen.add(s); const e = wordHit(C, s); if (e && !terms.includes(e)) terms.push(e); };
  let run = [];
  // spaced-out letters ("n i g g e r", "a f a g"): every stretch of 3+ single letters in a row
  const flush = () => {
    if (run.length >= 3) {
      const r = run.slice(0, 24);
      for (let a = 0; a <= r.length - 3; a++) for (let b = a + 3; b <= r.length; b++) test(r.slice(a, b).join(""));
    }
    run = [];
  };
  T.tokens.forEach((t, i) => {
    if (skip.has(i)) { flush(); return; }
    if (t.a.length === 1) run.push(t.a); else flush();
    test(t.a);
    for (const p of t.pieces) test(p);
  });
  flush();
  for (const e of phraseHits(C.hatePhrases, T.words)) if (!terms.includes(e)) terms.push(e);
  return terms;
}

// doxxing - on the NFKC text (case kept: postcodes / NI numbers are upper-case)
const CUR_BEFORE = /[$£€¥₹#]\s*$/;
const AMOUNT_AFTER = /^\s*(?:pat|points?|pts|usd|eur|gbp|dollars?|pounds?|euros?|coins?|k|m|mil|million|%|x\b)/i;
const SSN_CUE = /\b(?:ssn|ss#|ss no|social security|social sec|social|soc sec)\b[^\n]{0,24}$/i;
const PHONE_CUE = /\b(?:call|text|txt|phone|ph|tel|cell|mobile|mob|number|num|digits|whatsapp|wa|sms|ring)\b[^\n]{0,24}$/i;
const RX = {
  nanp: /(?<![\w+$£€#.,/:-])(?:\+?1[\s.\-]?)?(?:\(\s*[2-9]\d{2}\s*\)|[2-9]\d{2})[\s.\-]?[2-9]\d{2}[\s.\-]?\d{4}(?![\w%]|[.,]\d)/g,
  intl: /(?<![\w+$£€#])\+[2-9]\d{0,2}[\s.\-]?(?:\(?\d{1,5}\)?[\s.\-]?){1,5}\d{2,5}(?![\w%]|[.,]\d)/g,
  uk: /(?<![\w+$£€#.,/:-])0(?:7\d{3}[\s.\-]?\d{3}[\s.\-]?\d{3}|[1-9]\d{1,3}[\s.\-]?\d{3,4}[\s.\-]?\d{3,4})(?![\w%]|[.,]\d)/g,
  ssn: /(?<![\w-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\w-])/g,
  card: /(?<![\w-])\d{4}([\s-])\d{4}\1\d{4}\1\d{1,4}(?:\1\d{1,3})?(?![\w-])/g,
  sin: /(?<![\w-])[1-79]\d{2}-\d{3}-\d{3}(?![\w-])/g,
  ni: /(?<![A-Za-z0-9])(?!BG|GB|NK|KN|TN|NT|ZZ)[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D](?![A-Za-z0-9])/g,
  ipv4: /(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w]|\.\d)/g,
  ipv6: /(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}:){0,5}[0-9a-f]{1,4})(?![\w:])/gi,
  email: /(?<![\w.+-])[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*\.[a-z]{2,24}(?![\w.-]*\w)/gi,
  addr: /(?<![\w#$£€.,/-])\d{1,5}[a-z]?\s+((?:[a-z][a-z'.-]*\s+){1,3}?)(street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd|terrace|crescent|parkway|pkwy|highway|hwy|mews|way|close|place|court|row|walk|square|grove|gardens|circle)\b\.?/gi,
  ukpost: /(?<![A-Za-z0-9])(?:[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]? ?\d[ABD-HJLNP-UW-Z]{2})(?![A-Za-z0-9])/g,
  zip: /(?<![A-Za-z])(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC),? \d{5}(?:-\d{4})?(?!\d)/g,
};
const AMBIG_SUFFIX = new Set(["way", "close", "place", "court", "row", "walk", "square", "grove", "gardens", "circle"]);
const ADDR_STOP = new Set(("the a an on in of my your ur his her their our its to at and or for more other with from by this that these those some any all few " +
  "many much big small new old first last next times time years year days day hours hour minutes mins weeks people guys friends things ways miles mile " +
  "km kms blocks block houses doors floors lanes cars feet ft yards metres meters steps is are was were be been i you he she we they it me us them " +
  "very so too just like about over under down up into out off no not").split(" "));
function luhn(d) {
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) { let n = d.charCodeAt(i) - 48; if (alt) { n *= 2; if (n > 9) n -= 9; } sum += n; alt = !alt; }
  return sum % 10 === 0;
}
function eachMatch(rx, s, fn) { rx.lastIndex = 0; let m; while ((m = rx.exec(s))) { fn(m); if (rx.lastIndex === m.index) rx.lastIndex++; } }
function amountish(s, m) {
  const before = s.slice(Math.max(0, m.index - 3), m.index), after = s.slice(m.index + m[0].length, m.index + m[0].length + 10);
  return CUR_BEFORE.test(before) || AMOUNT_AFTER.test(after);
}
function scanDox(C, raw, T) {
  const kinds = new Set();
  const masked = [];                         // ranges already explained (so an IP isn't also a "phone")
  const take = (m) => masked.push([m.index, m.index + m[0].length]);
  const inMask = (m) => masked.some(([a, b]) => m.index < b && m.index + m[0].length > a);
  eachMatch(RX.ipv4, raw, (m) => {
    const o = m.slice(1, 5).map(Number);
    if (o.some((x) => x > 255) || m.slice(1, 5).some((x) => x.length > 1 && x[0] === "0")) return;
    take(m);
    const [a, b] = o;
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return;
    if (["8.8.8.8", "8.8.4.4", "1.1.1.1", "1.0.0.1", "9.9.9.9", "208.67.222.222", "208.67.220.220"].includes(o.join("."))) return;
    if (o.every((x) => x <= 20)) return;                                   // 1.2.3.4-style version numbers
    if (/(?:\bv|version|ver|build|release|update|patch)\s*$/i.test(raw.slice(Math.max(0, m.index - 10), m.index))) return;
    kinds.add("ip");
  });
  eachMatch(RX.ipv6, raw, (m) => {
    const g = m[0].toLowerCase();
    if (/^(?:fe8|fe9|fea|feb|fc|fd)/.test(g) || g.split(":").filter(Boolean).length < 3 || !/[0-9a-f]{3,4}/.test(g)) return;
    take(m); kinds.add("ip");
  });
  // a US SSN-shaped number only next to an SSN word (a bare 3-2-4 is as likely a score or a part number)
  eachMatch(RX.ssn, raw, (m) => { if (SSN_CUE.test(raw.slice(Math.max(0, m.index - 40), m.index))) { take(m); kinds.add("govid"); } });
  eachMatch(RX.card, raw, (m) => { const d = m[0].replace(/\D/g, ""); if (d.length >= 13 && d.length <= 19 && luhn(d)) { take(m); kinds.add("card"); } });
  eachMatch(RX.sin, raw, (m) => { if (inMask(m)) return; const d = m[0].replace(/\D/g, ""); if (luhn(d)) { take(m); kinds.add("govid"); } });
  eachMatch(RX.ni, raw, (m) => { take(m); kinds.add("govid"); });
  eachMatch(RX.nanp, raw, (m) => {
    if (inMask(m) || amountish(raw, m)) return;
    const s = m[0];
    const sep = /[\s.\-()]/.test(s) || s.startsWith("+");
    // a bare 10-digit run only counts next to a phone word ("call me 5551234567")
    if (!sep && !PHONE_CUE.test(raw.slice(Math.max(0, m.index - 40), m.index))) return;
    // "555.123.4567" vs a version / dotted id: dots only count with a phone word nearby
    if (/^\d{3}\.\d{3}\.\d{4}$/.test(s) && !PHONE_CUE.test(raw.slice(Math.max(0, m.index - 40), m.index))) return;
    take(m); kinds.add("phone");
  });
  eachMatch(RX.intl, raw, (m) => {
    if (inMask(m) || amountish(raw, m)) return;
    const d = m[0].replace(/\D/g, "");
    if (d.length < 9 || d.length > 15) return;
    take(m); kinds.add("phone");
  });
  eachMatch(RX.uk, raw, (m) => {
    if (inMask(m) || amountish(raw, m)) return;
    const d = m[0].replace(/\D/g, "");
    if (d.length < 10 || d.length > 11) return;
    take(m); kinds.add("phone");
  });
  eachMatch(RX.email, raw, () => kinds.add("email"));
  eachMatch(RX.addr, raw, (m) => {
    const mid = m[1].trim().split(/\s+/);
    const suffix = m[2];
    if (mid.some((w) => ADDR_STOP.has(w.toLowerCase().replace(/[^a-z]/g, "")))) return;
    if (AMBIG_SUFFIX.has(suffix.toLowerCase()) && !(/^[A-Z]/.test(suffix) && mid.every((w) => /^[A-Z]/.test(w)))) return;
    const flat = " " + normalize(m[0]).replace(KEEP, " ").replace(/\s+/g, " ").trim() + " ";
    if (C.publicAddr.some((p) => flat.includes(p) || p.includes(flat))) return;
    kinds.add("address");
  });
  eachMatch(RX.ukpost, raw, (m) => { if (!/^(?:PS[45]|XB1|GTA\d)/.test(m[0])) kinds.add("postcode"); });
  eachMatch(RX.zip, raw, () => kinds.add("postcode"));
  if (kinds.size && phraseHits(C.cues, T.words, 1).length) kinds.add("cue");
  return [...kinds];
}
const STRONG = new Set(["phone", "govid", "card", "ip"]);
/** "full" when any strong signal, or two different weak ones (a cue counts as one); "weak" = one weak signal alone */
function doxStrength(kinds) {
  if (kinds.some((k) => STRONG.has(k))) return "full";
  const weak = kinds.filter((k) => k !== "cue");
  if (!weak.length) return null;
  return weak.length + (kinds.includes("cue") ? 1 : 0) >= 2 ? "full" : "weak";
}

const LINK_RX = /\bhttps?:\/\/[^\s<>"]+|\bwww\.[^\s<>"]+|(?<![@\w.-])[a-z0-9][a-z0-9-]{1,62}\.(?:com|net|org|io|xyz|ru|tk|top|ly|gg|me|co|info|biz|click|link|site|online|shop|live|app|cc|to|tv|us|uk)\b(?:\/[^\s<>"]*)?/gi;
function scanSpam(C, raw, T, { kind = "post", links = 0 } = {}) {
  const why = [];
  const n = (raw.match(LINK_RX) || []).length + (links || 0);
  if (n >= (kind === "comment" ? SPAM.links_comment : SPAM.links_post)) why.push("links");
  if (/([\p{L}\p{N}\p{Extended_Pictographic}])\1{24,}/u.test(raw)) why.push("flood");
  else {
    const ws = T.tokens.map((t) => t.a);
    if (ws.length >= 20) {
      const cnt = new Map();
      for (const w of ws) cnt.set(w, (cnt.get(w) || 0) + 1);
      if (Math.max(...cnt.values()) >= ws.length * 0.6) why.push("flood");
    }
  }
  if ((raw.match(/(?<![\w@])@[a-z0-9_.-]{2,}/gi) || []).length >= SPAM.mentions) why.push("mentions");
  for (const e of phraseHits(C.spam, T.words, 2)) why.push("scam:" + e);
  return why;
}

/**
 * The scan itself: text -> [{cat, kinds: [...], terms: [...], strength?}] (no settings, no DB). opts {kind, links}.
 * Terms are LIST entries (never the user's own words); doxxing reports only the kinds of match.
 */
function scan(text, opts = {}) {
  const C = compiled();
  const raw = String(text == null ? "" : text).normalize("NFKC").replace(/\p{Cf}/gu, "");
  if (!raw.trim()) return [];
  const T = tokenize(normalize(raw));
  const hits = [];
  const hate = scanHate(C, T);
  if (hate.length) hits.push({ cat: "hate", kinds: ["term"], terms: hate });
  const dox = scanDox(C, raw, T);
  const st = doxStrength(dox);
  if (st) hits.push({ cat: "doxxing", kinds: dox, terms: [], strength: st });
  const th = phraseHits(C.threats, T.words);
  if (th.length) hits.push({ cat: "threats", kinds: ["phrase"], terms: th });
  const sh = phraseHits(C.selfharm, T.words);
  if (sh.length) hits.push({ cat: "selfharm", kinds: ["phrase"], terms: sh });
  const sp = scanSpam(C, raw, T, opts);
  if (sp.length) hits.push({ cat: "spam", kinds: [...new Set(sp.map((x) => x.split(":")[0]))], terms: sp.filter((x) => x.startsWith("scam:")).map((x) => x.slice(5)) });
  return hits;
}

// ── settings ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const bool = (v) => v === true || v === 1 || v === "1" || v === "on" || v === "true";
const choicesFor = (cat) => (cat === "selfharm" ? SELFHARM_ACTIONS : ACTIONS);
const okAct = (cat, v) => choicesFor(cat).includes(v);
function cleanGlobal(c) {
  c = c && typeof c === "object" ? c : {};
  const o = { enabled: GLOBAL_DEFAULTS.enabled, default_on: GLOBAL_DEFAULTS.default_on, actions: { ...DEFAULT_ACTIONS } };
  if (c.enabled != null) o.enabled = bool(c.enabled);
  if (c.default_on != null) o.default_on = bool(c.default_on);
  const a = c.actions && typeof c.actions === "object" ? c.actions : {};
  for (const k of CATS) if (okAct(k, a[k])) o.actions[k] = a[k];
  return o;
}
function cleanScope(c) {
  c = c && typeof c === "object" ? c : {};
  const o = { on: c.on == null ? null : bool(c.on), actions: {}, admin_lock: bool(c.admin_lock) };
  const a = c.actions && typeof c.actions === "object" ? c.actions : {};
  for (const k of CATS) if (okAct(k, a[k])) o.actions[k] = a[k];
  return o;
}
const CACHE = new Map();
async function kv(key) {
  const hit = CACHE.get(key);
  if (hit && NOW() - hit.at < CACHE_MS) return hit.v;
  let v = null;
  try { const r = (await getQuery("SELECT value FROM feed_kv WHERE key = ?", [key]))[0]; v = r ? JSON.parse(r.value) : null; } catch (e) { v = null; }
  CACHE.set(key, { v, at: NOW() });
  if (CACHE.size > 5000) CACHE.clear();
  return v;
}
async function kvPut(key, v) {
  await runQuery("INSERT INTO feed_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, JSON.stringify(v)]);
  CACHE.delete(key);
}
async function kvDel(key) { await runQuery("DELETE FROM feed_kv WHERE key = ?", [key]); CACHE.delete(key); }

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await require("./feedstore").init();
      await runQuery(`CREATE TABLE IF NOT EXISTS feed_filter (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, room_id TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL, post_id TEXT, comment_id TEXT, author_id TEXT, action TEXT NOT NULL, cats TEXT, kinds TEXT, terms TEXT, edit INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'open', released_at INTEGER, released_by TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS feed_filter_room ON feed_filter (room_id, at)");
      await runQuery("CREATE INDEX IF NOT EXISTS feed_filter_at ON feed_filter (at)");
      await runQuery("CREATE TABLE IF NOT EXISTS feed_filter_daily (day TEXT NOT NULL, cat TEXT NOT NULL, action TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, cat, action))");
      const L = await kv("filter:lists");
      if (L && typeof L === "object") { const lists = cleanLists(L); LISTS = { source: "db", lists, C: compile(lists) }; }
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

async function globalSettings() { return cleanGlobal(await kv("filter:global")); }
async function scopeSettings(roomId) { return cleanScope(await kv("filter:scope:" + String(roomId || ""))); }
/** A pad's effective settings: {master, on, inherited, actions, own: {on, actions}, admin_lock} */
async function effective(roomId) {
  const G = await globalSettings(), S = await scopeSettings(roomId);
  const actions = {};
  for (const k of CATS) actions[k] = S.actions[k] || G.actions[k];
  return { master: G.enabled, on: S.on == null ? G.default_on : S.on, inherited: S.on == null, actions, own: S, admin_lock: S.admin_lock, G };
}

// ── the check (feedstore.create / comment / edit) ────────────────────────────────────────────────────────────────────
const DUPS = new Map();       // author -> [{h, t}] (spam: the same text again and again)
function dupCount(authorId, text) {
  const s = normalize(text).replace(/\s+/g, " ").trim();
  if (!authorId || s.length < SPAM.dup_min_chars) return 0;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  const t = NOW();
  const list = (DUPS.get(authorId) || []).filter((x) => t - x.t < SPAM.dup_window_ms);
  list.push({ h, t });
  DUPS.set(authorId, list.slice(-30));
  if (DUPS.size > 20000) DUPS.clear();
  return list.filter((x) => x.h === h).length;
}
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
function count(cat, action) {
  runQuery(`INSERT INTO feed_filter_daily (day, cat, action, n) VALUES (?, ?, ?, 1)
            ON CONFLICT(day, cat, action) DO UPDATE SET n = n + 1`, [dayOf(NOW()), cat, action]).catch((e) => console.error("[filter] count:", e.message));
}
const WHAT = { hate: "a slur or hate term", doxxing: "what looks like someone's personal information (a phone number, address, email, IP or ID number)",
               threats: "what reads as a threat", spam: "what looks like spam (a flood of links, repeated text or a scam line)", selfharm: "something about self-harm" };
const CARE_TITLE = "We're here if you need it";
const CARE_BODY = "Something you wrote sounded like you might be going through a hard time. If you're thinking about hurting yourself, please reach out to someone now: " +
  "in the US call or text 988, in the UK and Ireland call Samaritans on 116 123, or find a free, confidential helpline near you at findahelpline.com. " +
  "If you're in immediate danger, call your local emergency number. Nothing happened to your post - this note is only for you.";

/**
 * Check a post / comment before it's stored. -> null (filter off / exempt / nothing found) or
 * {action: allow|flag|hide|block, roomId, cats: [{cat, action, kinds, terms}], selfharm: null|notice|flag, message, ms}.
 * action "block": the caller refuses with `message` (already logged + counted here).
 */
async function check(u, roomIds, { kind = "post", title = "", body = "", links = 0, edit = false, postId = null, commentId = null } = {}) {
  const t0 = process.hrtime.bigint();
  await init();
  const store = require("./feedstore");
  if (!u || !u.userId || store.isPepe(u) || store.isStaff(u)) return null;
  const G = await globalSettings();
  if (!G.enabled) return null;
  let pick = null;                                             // the pad whose settings apply (the strictest, if several)
  const pads = [];
  for (const rid of [...new Set((roomIds || []).map(String))]) {
    const E = await effective(rid);
    if (!E.on) continue;
    if (await rooms.canManage(u, rid)) continue;                // the pad's own owner moderates it
    pads.push({ rid, E });
  }
  if (!pads.length) return null;
  const text = [title, body].filter(Boolean).join("\n");
  const hits = scan(text, { kind, links });
  const dup = edit ? 0 : dupCount(u.userId, text);
  if (dup >= SPAM.dup_count) {
    const s = hits.find((h) => h.cat === "spam");
    if (s) s.kinds.push("repeat"); else hits.push({ cat: "spam", kinds: ["repeat"], terms: [] });
  }
  if (!hits.length) return null;
  const cats = [];
  let top = "allow", selfharm = null;
  for (const P of pads) {
    let padTop = "allow";
    for (const h of hits) {
      let a = P.E.actions[h.cat];
      if (h.cat === "selfharm") continue;
      if (h.cat === "doxxing" && h.strength === "weak" && RANK[a] > RANK.flag) a = "flag";
      if (RANK[a] > RANK[padTop]) padTop = a;
    }
    if (!pick || RANK[padTop] > RANK[top]) { pick = P; top = padTop; }
  }
  for (const h of hits) {
    let a = pick.E.actions[h.cat];
    if (h.cat === "selfharm") { selfharm = a === "allow" ? null : a; cats.push({ cat: h.cat, action: a, kinds: h.kinds, terms: [] }); count(h.cat, a); continue; }
    if (h.cat === "doxxing" && h.strength === "weak" && RANK[a] > RANK.flag) a = "flag";
    cats.push({ cat: h.cat, action: a, kinds: h.kinds, terms: h.terms });
    count(h.cat, a);
  }
  if (selfharm === "flag" && RANK[top] < RANK.flag) top = "flag";
  const worst = cats.filter((c) => c.cat !== "selfharm" && c.action === top).map((c) => WHAT[c.cat]);
  const v = { action: top, roomId: pick.rid, cats, selfharm, kind, edit, message: null, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  if (top === "block") {
    v.message = `This pad's content filter stopped your ${kind}: it caught ${worst.join(" and ")}. Edit it and try again.` +
      (selfharm ? " " + CARE_BODY.replace(" Nothing happened to your post - this note is only for you.", "") : "");
    await log(v, { authorId: u.userId, postId, commentId }).catch((e) => console.error("[filter] log:", e.message));
  } else if (top === "hide") v.message = `Your ${kind} is hidden until the pad owner reviews it - this pad's content filter caught ${worst.join(" and ")}.`;
  else if (top === "flag" && worst.length) v.message = `Your ${kind} is up. This pad's content filter flagged it for the pad owner to look at (${worst.join(" and ")}).`;
  else if (selfharm) v.message = CARE_BODY;
  return v;
}

async function log(v, { authorId, postId = null, commentId = null }) {
  const acts = v.cats.filter((c) => RANK[c.action] >= RANK.flag && !(c.cat === "selfharm" && c.action !== "flag"));
  if (!acts.length && v.action !== "block") return null;
  const terms = [...new Set(acts.flatMap((c) => c.terms || []))].slice(0, 8).join(", ");
  const r = await runQuery(`INSERT INTO feed_filter (at, room_id, kind, post_id, comment_id, author_id, action, cats, kinds, terms, edit, state)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [NOW(), v.roomId || "", v.kind, postId, commentId, authorId || null, v.action, acts.map((c) => c.cat).join(","),
     [...new Set(acts.flatMap((c) => c.kinds || []))].join(","), terms || null, v.edit ? 1 : 0, v.action === "block" ? "blocked" : "open"]);
  return r && r.id;
}

/**
 * After the post / comment is stored: log it, file the filter's report (flag / hide), hide it on an edit (a new post or
 * comment is stored hidden already), tell the author (and the owner on a hide), send the self-harm note.
 * ctx {kind, postId, commentId, authorId}
 */
async function record(v, ctx) {
  if (!v || v.action === "block") return null;
  const store = require("./feedstore");
  const t = NOW();
  const isPost = ctx.kind === "post";
  const id = RANK[v.action] >= RANK.flag ? await log(v, { authorId: ctx.authorId, postId: ctx.postId, commentId: isPost ? null : ctx.commentId }) : null;
  const R = rooms.getCached(v.roomId) || (await rooms.get(v.roomId));
  const slug = R ? R.slug : v.roomId;
  if (id) {
    const acts = v.cats.filter((c) => RANK[c.action] >= RANK.flag);
    const main = acts.slice().sort((a, b) => RANK[b.action] - RANK[a.action])[0];
    const note = `🧹 Content filter: ${acts.map((c) => c.cat + (c.cat === "doxxing" ? " (" + c.kinds.filter((k) => k !== "cue").join("/") + ")" : "")).join(", ")} - #${id}`;
    const args = [ctx.postId, isPost ? null : ctx.commentId, FILTER_ID, REPORT_REASON[main.cat] || "other", note.slice(0, 300), t];
    const r = await runQuery("INSERT OR IGNORE INTO feed_reports (post_id, comment_id, reporter_id, reason, note, created) VALUES (?, ?, ?, ?, ?, ?)", args);
    if (!r || !r.changes) {
      await runQuery(`UPDATE feed_reports SET resolved_at = NULL, resolved_by = NULL, action = NULL, reason = ?, note = ?, created = ?
                      WHERE post_id = ? AND COALESCE(comment_id, '') = ? AND reporter_id = ?`, [args[3], args[4], t, ctx.postId, isPost ? "" : ctx.commentId, FILTER_ID]);
    }
    if (v.action === "hide" && v.edit) {
      if (isPost) await runQuery("UPDATE feed_post_rooms SET hidden_at = ?, hidden_by = ? WHERE post_id = ? AND room_id = ? AND hidden_at IS NULL", [t, BY, ctx.postId, v.roomId]);
      else await runQuery("UPDATE feed_comments SET hidden_at = ? WHERE id = ? AND hidden_at IS NULL", [t, ctx.commentId]);
    }
    const what = isPost ? "post" : "comment";
    const told = v.action === "hide" ? `hid your ${what} until the pad owner reviews it` : `flagged your ${what} for the pad owner to look at - nothing has changed yet`;
    const why = acts.map((c) => WHAT[c.cat]).join(" and ");
    await store.notify(ctx.authorId, { kind: "feed", title: `The content filter in p/${slug} ${v.action === "hide" ? "hid" : "flagged"} your ${what}`,
      body: `It caught ${why}. The filter ${told}. Think it got it wrong? The pad owner can release it, or you can appeal (${APPEAL}).`,
      link: await store.postLink(ctx.postId, isPost ? "" : "#c-" + ctx.commentId).catch(() => "/feed"), ref: "filter:" + id });
    if (v.action === "hide" && R && R.owner && R.owner.userId && R.owner.userId !== ctx.authorId) {
      await store.notify(R.owner.userId, { kind: "feed", title: `The content filter hid a ${what} in p/${slug}`,
        body: `It caught ${why}. Review it - release it or remove it - on your owner panel.`, link: "/p/" + encodeURIComponent(slug) + "/owner#safety", ref: "filter-own:" + id });
    }
    await rooms.event(v.roomId, "feed-filter", "filter", `${v.action} ${what} ${isPost ? ctx.postId : ctx.commentId}: ${acts.map((c) => c.cat).join(", ")}${v.edit ? " (edit)" : ""}`);
  }
  if (v.selfharm) {
    await store.notify(ctx.authorId, { kind: "feed", title: CARE_TITLE, body: CARE_BODY, link: "https://findahelpline.com", ref: "filter-care:" + dayOf(t) });
  }
  return id;
}

/** The pad owner (or staff) releases a flag / hide: un-hides it, closes the filter's report, tells the author. */
async function release(user, id) {
  await init();
  const store = require("./feedstore");
  if (!user || !user.userId) throw new store.Refuse(401, "Sign in first.");
  const row = (await getQuery("SELECT * FROM feed_filter WHERE id = ?", [Number(id) || 0]))[0];
  if (!row) throw new store.Refuse(404, "No such filter action.");
  if (!(await rooms.canManage(user, row.room_id))) throw new store.Refuse(403, "Only this pad's owner can release it.");
  if (row.state === "released") return row;
  if (row.state !== "open") throw new store.Refuse(409, "Nothing to release - it was never posted.");
  const t = NOW();
  if (row.kind === "post") {
    await runQuery("UPDATE feed_post_rooms SET hidden_at = NULL, hidden_by = NULL WHERE post_id = ? AND room_id = ? AND hidden_by = ?", [row.post_id, row.room_id, BY]);
  } else {
    const urgent = (await getQuery(`SELECT 1 FROM feed_reports WHERE comment_id = ? AND resolved_at IS NULL AND reason IN (${store.URGENT.map(() => "?").join(",")})`,
      [row.comment_id, ...store.URGENT]))[0];
    if (urgent) throw new store.Refuse(409, "That comment is also under a site review - the site admins will decide.");
    await runQuery("UPDATE feed_comments SET hidden_at = NULL WHERE id = ? AND hidden_at IS NOT NULL", [row.comment_id]);
  }
  await runQuery(`UPDATE feed_reports SET resolved_at = ?, resolved_by = ?, action = 'filter-released' WHERE reporter_id = ? AND post_id = ?
                  AND COALESCE(comment_id, '') = ? AND resolved_at IS NULL`, [t, user.username || "?", FILTER_ID, row.post_id, row.comment_id || ""]);
  await runQuery("UPDATE feed_filter SET state = 'released', released_at = ?, released_by = ? WHERE id = ?", [t, user.username || "?", row.id]);
  await rooms.event(row.room_id, "feed-filter-release", user.username || "?", `#${row.id} ${row.action} ${row.kind} ${row.comment_id || row.post_id}`);
  const R = rooms.getCached(row.room_id);
  if (row.author_id) {
    await store.notify(row.author_id, { kind: "feed", title: `Your ${row.kind} was released in p/${R ? R.slug : row.room_id}`,
      body: `The pad's moderators looked at what the content filter caught and released it${row.action === "hide" ? " - it's visible again" : ""}.`,
      link: await store.postLink(row.post_id, row.comment_id ? "#c-" + row.comment_id : "").catch(() => "/feed"), ref: "filter-rel:" + row.id });
  }
  return (await getQuery("SELECT * FROM feed_filter WHERE id = ?", [row.id]))[0];
}

// ── views ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const clip = (s, n) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
async function decorateRows(rows, { terms = false } = {}) {
  const store = require("./feedstore");
  const out = [];
  for (const r of rows) {
    let what = "";
    if (r.state !== "blocked") {
      if (r.kind === "post") { const p = await store.getRow(r.post_id); what = p ? p.title || p.body || "(media post)" : "(gone)"; }
      else { const c = (await getQuery("SELECT body FROM feed_comments WHERE id = ?", [r.comment_id]))[0]; what = c ? c.body : "(gone)"; }
    }
    const A = r.author_id ? await store.account(r.author_id) : null;
    const R = rooms.getCached(r.room_id);
    out.push({ id: r.id, at: r.at, kind: r.kind, action: r.action, state: r.state, cats: String(r.cats || "").split(",").filter(Boolean),
               kinds: String(r.kinds || "").split(",").filter(Boolean), terms: terms ? r.terms || "" : undefined, edit: !!r.edit,
               what: clip(what, 140), author: A ? A.displayname || A.username : "?", pad: R ? { slug: R.slug, title: R.title } : { slug: r.room_id, title: r.room_id },
               href: r.post_id ? (await store.postLink(r.post_id, r.comment_id ? "#c-" + r.comment_id : "").catch(() => null)) : null,
               releasable: r.state === "open" && (r.action === "flag" || r.action === "hide"), released_by: r.released_by || null });
  }
  return out;
}
async function list(roomId, limit = 20) {
  await init();
  return decorateRows(await getQuery("SELECT * FROM feed_filter WHERE room_id = ? ORDER BY id DESC LIMIT ?", [String(roomId || ""), limit]));
}
async function adminList(limit = 100) {
  await init();
  return decorateRows(await getQuery("SELECT * FROM feed_filter ORDER BY id DESC LIMIT ?", [limit]), { terms: true });
}
async function padCounts(roomId, days = 7) {
  const rows = await getQuery("SELECT cats, action FROM feed_filter WHERE room_id = ? AND at > ?", [String(roomId || ""), NOW() - days * 86400e3]);
  const out = {};
  for (const k of CATS) out[k] = 0;
  for (const r of rows) for (const c of String(r.cats || "").split(",")) if (c in out) out[c]++;
  return out;
}
/** feed_filter_daily for the last `days` days: [{day, cats: {cat: {action: n}}}] newest first */
async function daily(days = 14) {
  await init();
  const since = dayOf(NOW() - (days - 1) * 86400e3);
  const rows = await getQuery("SELECT * FROM feed_filter_daily WHERE day >= ? ORDER BY day DESC", [since]);
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.day)) by.set(r.day, {});
    const d = by.get(r.day);
    (d[r.cat] = d[r.cat] || {})[r.action] = r.n;
  }
  return [...by.entries()].map(([day, cats]) => ({ day, cats }));
}

/** The owner panel's 🧹 Safety card. */
async function state(roomId) {
  await init();
  const E = await effective(roomId);
  const actions = {};
  for (const k of CATS) actions[k] = { value: E.actions[k], def: E.G.actions[k], own: !!E.own.actions[k], choices: choicesFor(k).slice() };
  return { master: E.master, on: { value: E.on, def: E.G.default_on, own: !E.inherited }, actions, cats: CATS.slice(), locked: E.admin_lock,
           recent: await list(roomId, 15), counts: await padCounts(roomId) };
}

// ── changing settings ────────────────────────────────────────────────────────────────────────────────────────────────
const HITS = new Map();
function limit(user, roomId) {
  if (rooms.isStaff(user)) return null;
  const k = user.userId + "|" + roomId, t = NOW();
  const hits = (HITS.get(k) || []).filter((x) => t - x < 3600e3);
  if (hits.filter((x) => t - x < 60e3).length >= 20) return "That's a lot of changes at once - try again in a minute.";
  if (hits.length >= 100) return "That's a lot of changes this hour - try again later.";
  hits.push(t);
  HITS.set(k, hits);
  if (HITS.size > 5000) HITS.clear();
  return null;
}
const isAdmin = (u) => !!u && u.class === "Admin";
/** One owner change: key "on" | "act_<cat>" | "admin_lock" (admins), value, or {reset: true}. -> state() */
async function setScope(user, roomId, key, value, { reset = false } = {}) {
  await init();
  const store = require("./feedstore");
  if (!user || !user.userId) throw new store.Refuse(401, "Sign in first.");
  const id = String(roomId || "");
  if (!(await rooms.get(id))) throw new store.Refuse(404, "No such pad.");
  if (!(await rooms.canManage(user, id))) throw new store.Refuse(403, "Only this pad's owner can do that.");
  const cur = await scopeSettings(id);
  if (cur.admin_lock && !isAdmin(user) && key !== "admin_lock") throw new store.Refuse(403, "A site admin has locked the content filter settings for this pad.");
  const next = { ...cur, actions: { ...cur.actions } };
  let note;
  if (key === "on") {
    if (reset) next.on = null;
    else {
      const v = typeof value === "string" ? (value === "on" || value === "true" ? true : value === "off" || value === "false" ? false : null) : value;
      if (typeof v !== "boolean") throw new store.Refuse(400, "On or off.");
      next.on = v;
    }
    note = reset ? "on reset to default" : `on=${next.on}`;
  } else if (/^act_/.test(key) && CATS.includes(key.slice(4))) {
    const cat = key.slice(4);
    if (reset) delete next.actions[cat];
    else { if (!okAct(cat, value)) throw new store.Refuse(400, "Pick one of the choices."); next.actions[cat] = value; }
    note = reset ? `${cat} reset to default` : `${cat}=${value}`;
  } else if (key === "admin_lock") {
    if (!isAdmin(user)) throw new store.Refuse(403, "Admins only.");
    next.admin_lock = reset ? false : bool(value);
    note = `admin_lock=${next.admin_lock}`;
  } else throw new store.Refuse(400, "That isn't a setting you can change here.");
  const why = limit(user, id);
  if (why) throw new store.Refuse(429, why);
  await kvPut("filter:scope:" + id, cleanScope(next));
  await rooms.event(id, "feed-filter-settings", user.username || "?", note);
  return state(id);
}
async function setGlobal(user, patch) {
  const store = require("./feedstore");
  if (!isAdmin(user)) throw new store.Refuse(403, "Admins only.");
  await init();
  const cur = await globalSettings();
  const p = patch || {};
  const actions = { ...cur.actions, ...(p.actions || {}) };
  for (const k of CATS) if (p["act_" + k] != null) actions[k] = p["act_" + k];
  for (const k of CATS) if (!okAct(k, actions[k])) throw new store.Refuse(400, `Pick one of the choices for ${k}.`);
  const next = cleanGlobal({ enabled: p.enabled != null ? p.enabled : cur.enabled, default_on: p.default_on != null ? p.default_on : cur.default_on, actions });
  await kvPut("filter:global", next);
  console.log(`[filter] global by=${user.username}: ${JSON.stringify(next)}`);
  return next;
}
/** The admins' list editor: {key: "line\nline"} for any of LIST_KEYS (keys left out keep their current lines). */
async function setLists(user, patch) {
  const store = require("./feedstore");
  if (!isAdmin(user)) throw new store.Refuse(403, "Admins only.");
  await init();
  compiled();
  const merged = { ...LISTS.lists };
  for (const k of LIST_KEYS) if (patch && patch[k] != null) merged[k] = patch[k];
  const lists = cleanLists(merged);
  const bad = listProblem(lists);
  if (bad) throw new store.Refuse(400, "That list doesn't compile: " + bad);
  await kvPut("filter:lists", lists);
  LISTS = { source: "db", lists, C: compile(lists) };
  console.log(`[filter] lists edited by ${user.username}: ${LIST_KEYS.map((k) => k + "=" + lists[k].length).join(" ")}`);
  return listsView();
}
async function resetLists(user) {
  const store = require("./feedstore");
  if (!isAdmin(user)) throw new store.Refuse(403, "Admins only.");
  await kvDel("filter:lists");
  LISTS = null;
  compiled();
  console.log(`[filter] lists reset to the file by ${user.username}`);
  return listsView();
}
function listsView() { compiled(); return { source: LISTS.source, lists: LISTS.lists, keys: LIST_KEYS.slice() }; }

// ── routes ───────────────────────────────────────────────────────────────────────────────────────────────────────────
function register(app, { addUser }) {
  const express = require("express");
  const bad = (res, st, error) => res.status(st).json({ ok: false, error });
  const jsonOnly = (req, res, next) => (req.is("application/json") && req.get("X-Requested-With") === "fetch" ? next() : bad(res, 400, "Bad request."));
  const acct = async (req) => (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [req.user.userId]))[0] || null;
  const fail = (res, e, tag) => {
    if (e && e.refuse) return bad(res, e.status || 400, e.message);
    console.error("[filter] " + tag, e);
    bad(res, 500, "Something went wrong - nothing was changed.");
  };
  app.post("/api/rooms/:slug/owner/filter", addUser, express.json({ limit: "2kb" }), jsonOnly, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!req.user || !req.user.userId) return bad(res, 401, "Sign in first.");
      const R = await require("./roomsweb").resolveRoom(req.params.slug);
      if (!R) return bad(res, 404, "No such pad.");
      const b = req.body || {};
      res.json({ ok: true, filter: await setScope(await acct(req), R.id, String(b.key || ""), b.value, { reset: b.reset === true }) });
    } catch (e) { fail(res, e, "scope"); }
  });
  app.post("/api/rooms/:slug/owner/filter/release", addUser, express.json({ limit: "2kb" }), jsonOnly, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!req.user || !req.user.userId) return bad(res, 401, "Sign in first.");
      const R = await require("./roomsweb").resolveRoom(req.params.slug);
      if (!R) return bad(res, 404, "No such pad.");
      const row = (await getQuery("SELECT room_id FROM feed_filter WHERE id = ?", [Number((req.body || {}).id) || 0]))[0];
      if (!row || row.room_id !== R.id) return bad(res, 404, "No such filter action in this pad.");
      await release(await acct(req), (req.body || {}).id);
      res.json({ ok: true, filter: await state(R.id) });
    } catch (e) { fail(res, e, "release"); }
  });
  app.post("/api/feed/admin/filter", addUser, express.json({ limit: "512kb" }), jsonOnly, async (req, res) => {
    res.set("Cache-Control", "no-store");
    try {
      if (!req.user || !req.user.userId) return bad(res, 401, "Sign in first.");
      const v = await acct(req);
      if (!isAdmin(v)) return bad(res, 403, "Admins only.");
      const b = req.body || {}, out = { ok: true };
      if (b.global) out.global = await setGlobal(v, b.global);
      if (b.lists) out.lists = await setLists(v, b.lists);
      if (b.reset_lists && b.reset_lists.confirm) out.lists = await resetLists(v);
      if (b.test != null) {
        const text = String(typeof b.test === "object" ? b.test.text || "" : b.test).slice(0, 20000);
        const t0 = process.hrtime.bigint();
        out.hits = scan(text, { kind: "post" });
        out.ms = Number(process.hrtime.bigint() - t0) / 1e6;
      }
      res.json(out);
    } catch (e) { fail(res, e, "admin"); }
  });
  app.get("/feed/admin/filter", addUser, async (req, res) => {
    try {
      if (!req.user || !req.user.userId) return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));
      const v = await acct(req);
      if (!isAdmin(v)) return res.status(403).render("notFound", { user: req.user.username, heading: "Admins only", message: "The content filter's settings and word lists are for site admins.", title: "Admins only" });
      await init();
      res.set({ "X-Robots-Tag": "noindex", "Cache-Control": "no-store" });
      res.render("feedFilterAdmin", { user: v.username, G: await globalSettings(), CATS, ACTIONS, SELFHARM_ACTIONS, DEFAULT_ACTIONS, L: listsView(),
                                      days: await daily(14), log: await adminList(100), SPAM });
    } catch (e) { console.error("[filter] admin page", e); res.status(500).send("Something went wrong."); }
  });
}

module.exports = {
  init, register, scan, check, record, release, state, list, adminList, daily, padCounts, effective, globalSettings, scopeSettings, setScope, setGlobal,
  setLists, resetLists, listsView, normalize, encodeFile, decodeFile, cleanLists, listProblem,
  CATS, ACTIONS, SELFHARM_ACTIONS, DEFAULT_ACTIONS, GLOBAL_DEFAULTS, FILTER_ID, BY, SPAM, LIST_KEYS, LIST_FILE, WHAT, CARE_BODY,
  _setClock: (fn) => { NOW = fn; }, _reset: () => { HITS.clear(); DUPS.clear(); CACHE.clear(); },
};
