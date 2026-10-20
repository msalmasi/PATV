// quotes.js — chat quotes (1.99fp): a moment of a Camfrog room's conversation clipped into a quote post on its pad,
// bash.org style. Lines are chat lines and 🎙 mic transcripts, from one or more speakers.
//
// Where the lines come from: ONLY the bridge's own copy of the room (bridge.js R.feed - what the pad's Live tab
// shows). So nothing the bridge doesn't already show publicly can be quoted: never PMs (the bridge drops them),
// never a line of anyone who was !incognito / !bridge hide when they said it (Pepe never sends those), and anyone
// who is private NOW shows as "someone" too: Pepe sends one-way hashes of the private logins with every sync
// (hidden_h: sha256("pepe-hidden:<login>"), 20 hex - hubhidden.js keeps them, setHidden), checked when a quote is made AND when
// one is shown (a quote whose speaker went private since is anonymised for good the first time it's rendered).
// The owner's decision-9 change (2026-10-19, "incognito hides WHO, not WHAT" - 1.99add refix 4 and the chat-history owner change
// alike): the sticky hidden sets say WHY - someone hidden only by INCOGNITO is "someone" with their words (the stored line keeps
// `h`, their hash, so it can still be left out later; Pepe's anonymised lines - an incognito speaker's, `ah` - are quotable the
// same way); someone LEFT OUT (!bridge hide, a kind Pepe never said, forget / delete / staff - and, fail closed, anyone Pepe's
// raw list hides whose kind the set doesn't know yet, everyone while a set loads) isn't quoted at all: their lines are dropped
// from a new quote and from an existing one's card and body (left_out counts them; they come back as "someone" if they show
// themselves again). A 🔊 mic clip of anyone hidden is refused (a voice says who it is - micclip.js).
//
// Making one
//   web   the Live tab's "✂️ Clip chat" (public/js/chat-clip.js): pick lines (tap, shift-click, long-press), preview,
//         optional title, "also on my profile" -> POST /api/rooms/:slug/quote {cs: [feed cursor ids], title, profile}.
//         clipmodal: the preview is the server's (the same POST with {preview: true}): only for someone who can see the
//         Live tab (GET /live's gates: members-tier pad access, the 💎 bridge perk), then every check Post has - terms() (the
//         lines as they'd be stored, the opt-outs, the price, the balance) and the pad's own post rules (postTerms(): who can
//         post, bans, the post limits, a required flair, the approval queue) - plus where it goes and who can read it. Nothing
//         made or charged, not counted as a quote; naming an opt-out costs the quote limit's budget (revealLimited()).
//         The ids are looked up in the bridge feed here (never text from the browser); at most MAX_LINES lines spanning
//         at most SPAN_MAX feed items. Credited to the signed-in account; the pad's posting rules apply (feedstore).
//   chat  !quote last 5 · !quote @user 3 · !quote from <words> to <words> (pepe_quote.py) -> POST /api/bridge/quote
//         (bot token) {room, camfrog, spec, before, title}: the lines are picked here from the same feed, only lines
//         before the command; credited to the requester's linked PATV account, else to Pepe.
//   Both: rate-limited per account / login (GAP, BURST per WINDOW) on top of the feed's own post limits.
//
// The post: an ordinary feed post (votes, comments, crossposts, reports) whose body is the quote as plain text (search,
// labels) plus a feed_quotes row {post_id, room_id, lines: [{k, login|null, name, text, ts}], logins}. decorate()
// adds `quote` and the card shows it as a quote (feed-post-content.ejs); Hop shows it as a card; /p/<pad>/quotes lists
// a pad's quotes (top / new + "Quote of the day": the best-voted quote of the last 24 h, else of the week).
// The body can't be edited (feedstore.edit), only the title.
//
// Consent: anyone quoted (their linked Camfrog login is one of the speakers) gets "Remove me": their lines in THAT
// quote become "someone", their name is blanked inside the other lines too, and the body is rewritten. The quote's
// author is told. A room's !clip switch doesn't apply: a quote is text, the same text the pad already shows.
"use strict";
const crypto = require("crypto");
const express = require("express");
const { runQuery, getQuery } = require("./dbUtils");
const SP = require("./siteperms");   // 1.99ack: the website's capabilities (siteperms.js)

const MAX_LINES = 20, SPAN_MAX = 40, LINE_MAX = 490, TITLE_MAX = 140, PHRASE_MAX = 60;   // 1.99acf: LINE_MAX 490 = the bridge's inbound cap (a quoted line stays whole)
const NOT_QUOTABLE = "Those lines can't be quoted.";    // CL3: the one answer when a picked line is outside the quoter's view
// 1.99acf: a quoted line is cut by code points, as bridge.js caps it (an emoji counts once; never half a surrogate pair)
const cpCut = (s, n) => (s.length <= n ? s : Array.from(s).slice(0, n).join(""));
const GAP = 20 * 1000, BURST = 5, WINDOW = 30 * 60 * 1000;
const POST_RE = /^[A-Za-z0-9]{8,16}$/;
const LOGIN_RE = /^[\w.\-]{1,40}$/;
let NOW = () => Date.now();
function _setClock(fn) { NOW = fn; }

class Refuse extends Error { constructor(status, msg) { super(msg); this.status = status; this.refuse = true; } }

// ── who is private right now (Pepe's hidden_h) ──
// 1.99add: the bridge no longer hands Pepe's raw list over here - hubhidden.js keeps the STICKY set (a short or empty list from
// Pepe un-hides nobody; see hubhidden.js for what does) and calls setHidden with all of it on every change, and at start-up
// (hubhidden.boot). isHidden also gates pad tips, boost / go-live names and @mention alerts.
// 1.99add refix 4: setHidden(all, leftOut) - every hidden hash, and those whose lines are LEFT OUT (!bridge hide, or a kind the
// site can't tell); a list without leftOut leaves them all out (fail closed). While hubhidden's start-up read hasn't worked
// (loading) EVERYONE counts as hidden and left out - a failed read never names anyone (tips refused, no names, no mention
// alerts, no new quotes; existing ones show no lines and nothing is stored meanwhile).
let HIDDEN = new Set();
let LEFT = new Set();
const HASH_RE = /^[0-9a-f]{20}$/;
const hiddenHash = (login) => crypto.createHash("sha256").update("pepe-hidden:" + String(login || "").trim().toLowerCase()).digest("hex").slice(0, 20);
function setHidden(list, leftOut) {
  if (!Array.isArray(list)) return;
  HIDDEN = new Set(list.filter((x) => typeof x === "string" && HASH_RE.test(x)).slice(0, 100000));   // hubhidden.SET_MAX
  LEFT = Array.isArray(leftOut) ? new Set(leftOut.filter((x) => HIDDEN.has(x))) : new Set(HIDDEN);
}
// ONE rule from TWO sticky sets (cl-site's merge of hubhidden-site): hubhidden.js (the chat hub's hh: cache; it calls
// setHidden(all, leftOut) on every change) and the pad chat archive's chatlog.js
// (hiddenKind - the live chat, its history, search and downloads). Both take the same inputs (Pepe's hidden_h and kinded lists,
// privacy.hidden / privacy.shown {scope}, his incognito reports, a website ON) and keep the same kinds; they differ only in what
// may un-hide (hubhidden also reads an older Pepe's drop, chatlog only Pepe's privacy.shown or an operator) - so a quote takes the
// STRICTER of the two: private if either hides them, left out if either leaves them out, nothing while either is loading.
// train2 + cl-site merge: that stricter answer is the ONE reader rule for every "is this login hidden" outside the chat itself
// too - isHidden is what pad tips, boost / go-live names, @mention alerts, mic clips and the 🎙 mic stage (micfollow) ask, and
// it now says hidden when EITHER set hides them (either kind; fail closed while either loads), so nothing names or shows a
// person whom the live chat, its history, search or downloads show as "someone" or leave out. (The two stores themselves stay
// two until they are folded into one - chatlog.hubRows() is that map; docs/chat-tickets.md.)
const hubLoading = () => { try { return require("./hubhidden").loading(); } catch (e) { return false; } };
// the owner's decision-9 change: the archive set's kind (chatlog.hiddenKind: "out" | "anon" | null - "out" while it loads)
const stickyKindH = (h) => { try { return require("./chatlog").hiddenKind(h); } catch (e) { return "out"; } };
const isHidden = (login) => {
  if (!login) return false;
  const h = hiddenHash(login);
  return hubLoading() || HIDDEN.has(h) || stickyKindH(h) != null;
};
/** Left out of quotes now (by hash): hubhidden's set leaves them out (LEFT: !bridge hide, or a kind it can't tell - an older
 *  Pepe's mixed list; or it is loading), or the archive's set does ("out"; also until it is loaded). HIDDEN is hubhidden's KINDED
 *  set now (never Pepe's raw list), so a hash it holds outside LEFT is incognito: "someone". */
const leftOutH = (h) => hubLoading() || LEFT.has(h) || stickyKindH(h) === "out";
/** Left out of quotes now (by login). */
const isLeftOut = (login) => !!login && leftOutH(hiddenHash(login));
/** Private now by any kind (incognito or left out) in either set - their name is never shown in a quote. (= isHidden since
 *  the train2 merge; kept for its readers.) */
const isPrivate = (login) => isHidden(login);
/** A stored quote line is left out now: by its speaker's login, or (an anonymised line) by the hash kept for it - Train 3 review:
 *  or by ANY of the speaker's other incognito hashes Pepe sent with the line (`hs`, data.anon.hs; server-only like `h`). */
const lineHashes = (l) => [l.h, ...(Array.isArray(l.hs) ? l.hs : [])].filter((x) => typeof x === "string" && HASH_RE.test(x));
const lineLeftOut = (l) => (l.login ? isLeftOut(l.login) : lineHashes(l).some(leftOutH));
/** Either sticky set is still loading (a site start): nothing is quoted, existing quotes show no line and nothing is stored. */
async function setLoading() {
  if (hubLoading()) return true;
  try { const CL = require("./chatlog"); await CL.init(); return CL.loading(); } catch (e) { return true; }
}

// ── rate limits (memory) ──
const hits = new Map();
function limited(key, now = NOW()) {
  const q = (hits.get(key) || []).filter((t) => now - t < WINDOW);
  if (q.length && now - q[q.length - 1] < GAP) return `Slow down — one quote every ${Math.round(GAP / 1000)}s.`;
  if (q.length >= BURST) return `Slow down — ${BURST} quotes per ${Math.round(WINDOW / 60000)} min.`;
  q.push(now);
  hits.set(key, q);
  if (hits.size > 5000) hits.delete(hits.keys().next().value);
  return null;
}
// clipmodal: the clip card's previews (they follow the picks while it's open) - their own light limit, never a quote slot
const PEEK_MAX = 60, PEEK_WINDOW = 60 * 1000;
const peeks = new Map();
function peekLimited(key, now = NOW()) {
  const q = (peeks.get(key) || []).filter((t) => now - t < PEEK_WINDOW);
  if (q.length >= PEEK_MAX) return "Slow down — too many previews. Try again in a minute.";
  q.push(now);
  peeks.set(key, q);
  if (peeks.size > 5000) peeks.delete(peeks.keys().next().value);
  return null;
}
// clipmodal: a preview says who opted out of quotes (!likeness clips off) - Post did too, at most BURST times per WINDOW. The
// preview keeps that budget: at most BURST different people's opt-outs per account per WINDOW (one already shown is free).
const reveals = new Map();
function revealLimited(key, login, now = NOW()) {
  const m = reveals.get(key) || new Map();
  for (const [k, t] of m) if (now - t >= WINDOW) m.delete(k);
  if (!m.has(login) && m.size >= BURST) return true;
  if (!m.has(login)) m.set(login, now);
  reveals.set(key, m);
  if (reveals.size > 5000) reveals.delete(reveals.keys().next().value);
  return false;
}

// ── picking lines out of the bridge feed ──
// (the owner's decision-9 change: Pepe's anonymised line of an incognito speaker - `ah`, their hash - is a line too: "someone")
const isLine = (it) => !!it && (it.k === "msg" || it.k === "tx") && !!it.u && (it.u.anon ? HASH_RE.test(String(it.ah || "")) : !!it.u.login) &&
  typeof it.text === "string" && !!it.text.trim();
const isCmd = (it) => it.k === "msg" && /^\s*[!/]/.test(it.text);
// Pepe's own announcements of quotes / clips / captures aren't conversation
const isPepeNoise = (it) => !!it.u.self && /^\s*(💬 quoted|🔊 |📹 |📸 |🎬 )/u.test(it.text);
const low = (s) => String(s == null ? "" : s).trim().toLowerCase();
const nameMatches = (it, who) => {
  const w = low(who).replace(/^@/, "");
  return !!w && !it.u.anon && (low(it.u.login) === w || low(it.u.display) === w || low(it.u.cf) === w);   // "someone" is nobody's name
};

/**
 * Pick the lines of a quote from a bridge feed (oldest first). spec:
 *   {cs: [cursor ids]}                    the website's selection (exactly these lines, any of them a command)
 *   {mode: "last", n}                     the last n lines before `before`
 *   {mode: "user", login|user, n}         that user's last n lines with the lines around them
 *   {mode: "range", from, to}             from the line containing `from` to the (latest) line containing `to`
 * -> {items} or {error}
 */
function pick(feed, spec, before = null) {
  const F = Array.isArray(feed) ? feed : [];
  if (spec && Array.isArray(spec.cs)) {
    // CL3 fix-up: each error carries a code - the web route answers the line-specific ones (missing, not_line) with ONE
    // generic refusal, and picks only from the quoter's own view of the feed
    const want = [...new Set(spec.cs.map(Number).filter((c) => Number.isInteger(c) && c > 0))];
    if (!want.length) return { error: "Pick the lines to quote.", code: "empty" };
    if (want.length > MAX_LINES) return { error: `A quote is at most ${MAX_LINES} lines.`, code: "count" };
    const idx = want.map((c) => F.findIndex((it) => it && it.c === c));
    if (idx.some((i) => i < 0)) return { error: "Some of those lines aren't in the room's feed any more — pick again.", code: "missing" };
    const items = idx.map((i) => F[i]);
    if (items.some((it) => !isLine(it))) return { error: "Only chat and 🎙 mic lines can be quoted.", code: "not_line" };
    const span = Math.max(...idx) - Math.min(...idx) + 1;
    if (span > SPAN_MAX) return { error: "Those lines are too far apart — pick lines close together.", code: "span" };
    return { items: idx.map((i, k) => [i, items[k]]).sort((a, b) => a[0] - b[0]).map((x) => x[1]) };
  }
  const cut = Number(before) > 0 ? Number(before) : Infinity;
  const cand = F.filter((it) => isLine(it) && it.ts <= cut && !isCmd(it) && !isPepeNoise(it));
  const mode = spec && spec.mode;
  const n = Math.max(1, Math.min(MAX_LINES, Math.floor(Number(spec && spec.n)) || 0));
  if (mode === "last") {
    if (!cand.length) return { error: "Nothing's been said here lately." };
    return { items: cand.slice(-n) };
  }
  if (mode === "user") {
    const who = spec.login || spec.user;
    const theirs = cand.map((it, i) => [i, it]).filter((x) => nameMatches(x[1], who) || (spec.user && nameMatches(x[1], spec.user)));
    if (!theirs.length) return { error: `No recent lines from ${String(spec.user || who).slice(0, 40)} on the pad.` };
    const mine = theirs.slice(-n);
    const a = Math.max(0, mine[0][0] - 1), b = Math.min(cand.length - 1, mine[mine.length - 1][0] + 1);
    if (b - a + 1 <= MAX_LINES) return { items: cand.slice(a, b + 1) };
    return { items: mine.map((x) => x[1]) };
  }
  if (mode === "range") {
    const A = low(spec.from).slice(0, PHRASE_MAX), B = low(spec.to).slice(0, PHRASE_MAX);
    if (A.length < 2 || B.length < 2) return { error: "Give a couple of words for each end." };
    let j = -1;
    for (let k = cand.length - 1; k >= 0; k--) if (low(cand[k].text).includes(B)) { j = k; break; }
    if (j < 0) return { error: `No recent line says “${String(spec.to).slice(0, 40)}”.` };
    let i = -1;
    for (let k = j; k >= Math.max(0, j - SPAN_MAX); k--) if (low(cand[k].text).includes(A)) { i = k; break; }
    if (i < 0) return { error: `No line before that says “${String(spec.from).slice(0, 40)}”.` };
    if (j - i + 1 > MAX_LINES) return { error: `That's more than ${MAX_LINES} lines — narrow it down.` };
    return { items: cand.slice(i, j + 1) };
  }
  return { error: "Pick the lines to quote." };
}

/** CL3 fix-up (Pepe's !quote): the lines of people the site's sticky hidden set leaves out (and the 🎙 lines of !transcripts off)
 *  are left out of what a chat quote can pick - the live chat leaves them out for every viewer, so a quote post never republishes
 *  them. The owner's decision-9 change: an incognito person's lines stay (buildLines makes them "someone"), exactly as /live shows
 *  them (chatlogview.privacyOf). The set fails closed while it loads (nothing to quote then). */
function shownFeed(feed) {
  const CV = require("./chatlogview");
  return (Array.isArray(feed) ? feed : []).filter((it) => !!it && CV.privacyOf(it) !== "out");
}

// ── building the stored lines (names as the bridge shows them; private people as "someone") ──
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function redactor(names) {
  // clipmodal: 2-letter names too (whole words only - see the pattern); a 1-letter one would blank every "a" / "I"
  const list = [...new Set(names.map((n) => String(n || "").trim()).filter((n) => n.length >= 2))].sort((a, b) => b.length - a.length).slice(0, 200);
  if (!list.length) return (s) => s;
  const rx = new RegExp("(^|[^\\w])@?(?:" + list.map(esc).join("|") + ")(?![\\w])", "gi");
  return (s) => String(s).replace(rx, (m, pre) => pre + "someone");
}
async function namesFor(items) {
  try {
    const B = require("./bridge");
    const L = await B.resolveNames(items.map((it) => it.u));
    return (u) => B.withPatv(u, L);
  } catch (e) { return (u) => u; }
}
/** feed items -> stored lines [{k, login, name, text, ts}] (+ the names to blank for anyone private).
 *  CL3 fix-up: a quote republishes lines on the pad's feed, so it takes the live chat's own redaction - the names of everyone
 *  in the site's sticky hidden set (chatlogview.redact: login + display names, the stop-list) become "someone" inside every
 *  quoted line, exactly as /live shows them; a speaker in that set (a website Incognito Pepe hasn't confirmed yet) is
 *  "someone" like one on Pepe's list. Fails closed: no quote while the hidden names can't be loaded. */
async function buildLines(items) {
  const CV = require("./chatlogview");
  try { await CV.init(); } catch (e) { throw new Refuse(503, "Quotes can't be made right now - try again in a minute."); }
  if (await setLoading()) throw new Refuse(503, "Quotes can't be made right now - try again in a minute.");
  const view = await namesFor(items);
  const hiddenNames = [];
  const lines = [];
  for (const it of items) {
    const anon = !!it.u.anon;
    const login = anon ? "" : low(it.u.login);
    // the owner's decision-9 change: someone LEFT OUT now isn't quoted at all (never stored); incognito only -> "someone" + h
    const out = CV.privacyOf(it) === "out" || (!anon && isLeftOut(login));
    const u = view(it.u) || it.u;
    const hidden = anon || out || isPrivate(login) || CV.isHiddenLogin(login);
    if (hidden && !anon) {
      hiddenNames.push(login, it.u.display, u.display, u.cf);
      // clipmodal: a private speaker's PATV username is blanked inside the lines too (their Camfrog names + display are above);
      // train2 merge: taken before a left-out speaker's line is skipped, so their names are blanked inside the OTHER lines too
      if (u.patv && u.patv.username) hiddenNames.push(u.patv.username);
    }
    if (out) continue;
    const h = anon ? it.ah : hidden ? hiddenHash(login) : null;
    // Train 3 review: the speaker's other incognito hashes (Pepe's data.anon.hs, `ahs`) stay with the line - left out once any is
    const hs = anon && Array.isArray(it.ahs) ? [...new Set(it.ahs.filter((x) => typeof x === "string" && HASH_RE.test(x) && x !== h))].slice(0, 32) : [];
    // CL6: c = the line's feed cursor, so a staff purge of that line reaches this copy (dropLines); never shown
    lines.push({ k: it.k === "tx" ? "tx" : "msg", login: hidden ? null : login, ...(h ? { h } : {}), ...(hs.length ? { hs } : {}),
                 name: hidden ? "someone" : String(u.display || it.u.display || login).slice(0, 40),
                 text: cpCut(String(it.text), LINE_MAX), ts: Number(it.ts) || 0, ...(it.u.self && !hidden ? { pepe: true } : {}), ...(Number(it.c) > 0 ? { c: Number(it.c) } : {}) });
  }
  const red = redactor(hiddenNames);
  for (const l of lines) l.text = CV.redact(red(l.text));
  // review 2 fix-up: the same redaction for the quote's title (create) - never stored, so the stored lines stay plain JSON
  // (the sticky set's names first: a hidden person's whole display name, before a shorter name of theirs could split it)
  Object.defineProperty(lines, "redact", { value: (s) => red(CV.redact(String(s == null ? "" : s))), enumerable: false });
  return lines;
}
/**
 * Review 2 fix-up (consent): the speakers of these stored lines who opted out of being quoted (!likeness clips off) and aren't the
 * quoter - by the line's login, or (an incognito speaker's line: no login) by the one-way hash it keeps, matched against every
 * opted-out account's chat login and account key (u:<id>). -> {named: [their shown names], logins: [the same speakers' logins],
 * anon: n of hidden ones, hashes: [the matched hidden ones' hashes]}
 */
async function optedOut(lines, authorId) {
  const L = require("./likeness");
  await L.init();
  const named = [], logins = [], hashes = [];
  let anon = 0;
  for (const lg of loginsOf(lines)) {
    let su = null;
    if (/^u:/.test(lg)) su = (await getQuery("SELECT userId FROM users WHERE lower(userId) = ? LIMIT 1", [lg.slice(2)]).catch(() => []))[0] || null;
    else su = await L.userByLogin(lg);
    if (su && su.userId !== authorId && !(await L.allows(su.userId, "clips"))) { named.push(lines.find((l) => l.login === lg).name); logins.push(lg); }
  }
  // (Train 3 review: every hash an anonymised line's speaker could be - an opted-out member among them refuses, fails closed)
  const hs = new Set(lines.filter((l) => !l.login).flatMap(lineHashes));
  if (hs.size) {
    const rows = await getQuery(`SELECT p.user_id, u.camfrogUsername AS cf FROM likeness_prefs p LEFT JOIN users u ON u.userId = p.user_id
                                 WHERE p.clips = 0`).catch(() => null);
    // (a lookup that fails refuses: never quote someone who may have opted out)
    if (!rows) return { named, logins, anon: hs.size, hashes: [...hs] };
    for (const r of rows) {
      if (String(r.user_id) === String(authorId)) continue;
      const keys = ["u:" + String(r.user_id).toLowerCase(), r.cf ? low(r.cf) : null].filter(Boolean);
      const hit = keys.map((k) => hiddenHash(k)).find((h) => hs.has(h));
      if (hit) { anon++; hashes.push(hit); }
    }
  }
  return { named, logins, anon, hashes };
}
/** The body a quote's lines give once the left-out ones are dropped. */
const shownBody = (lines) => bodyOf(lines.filter((l) => !lineLeftOut(l)));
const bodyOf = (lines) => lines.map((l) => `<${l.name}> ${l.k === "tx" ? "🎙 " : ""}${l.text}`).join("\n").slice(0, 5000);
const loginsOf = (lines) => [...new Set(lines.map((l) => l.login).filter(Boolean))];

// ── storage ──
let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await require("./feedstore").init();          // creates feed_quotes too (list() filters on it)
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
async function rowOf(postId) {
  await init();
  return (await getQuery("SELECT * FROM feed_quotes WHERE post_id = ?", [String(postId)]))[0] || null;
}
function parse(s, d) { try { const v = JSON.parse(s); return v == null ? d : v; } catch (e) { return d; } }

/**
 * What a quote of these feed items would be (create() and the web preview share it, so the preview shows exactly what Post
 * makes): {lines (stored form), speakers (logins), price, refuse: the Refuse Post would throw | null, why: that, for a preview,
 *  leftOut: how many picked lines were dropped as left out (the owner's decision-9 change)}
 */
async function terms({ authorId, items, viaPepe = false }) {
  // 1.99add refix 4: who is private isn't known yet (the website is starting) - nothing is quoted until it is. train2 merge: a
  // refusal here, so create() throws it and the clip card's preview says it - while EITHER sticky set loads (cl-site's setLoading)
  if (await setLoading()) {
    const msg = "The website is just starting up - try again in a moment.";
    return { lines: [], speakers: [], price: 0, refuse: new Refuse(503, msg), why: msg, leftOut: 0 };
  }
  const lines = await buildLines(items);
  const leftOut = items.length - lines.length;
  // the owner's decision-9 change: the lines of people left out were dropped - none left, nothing to quote (train2 merge: as
  // terms' refuse, so the clip card's preview says why instead of offering Post)
  if (!lines.length) {
    const msg = "Those lines are private - they can't be quoted.";
    return { lines, speakers: [], price: 0, refuse: new Refuse(400, msg), why: msg, leftOut };
  }
  // 1.99qw (likeness royalties): a quote costs quote_price PAT (250; Pepe's own / site admins free); 40% of it goes to the
  // people quoted (held 24 h, likeness.js), and anyone quoted who opted out of clips (!likeness clips off) refuses it
  const L = require("./likeness");
  await L.init();
  const speakers = loginsOf(lines);
  // review 2 fix-up: incognito speakers' lines (no login - their hash) are checked too, and refused with an answer naming nobody.
  // (rebase onto clipmodal: returned as terms' refuse, so the preview says it too; optOut keys the preview's reveal budget)
  const opt = await optedOut(lines, authorId);
  if (opt.named.length) {
    const name = opt.named[0];
    return { lines, speakers, price: 0, refuse: new Refuse(403, `${name} has opted out of being quoted - nothing was charged.`), why: `${name} has opted out of being quoted.`, optOut: opt.logins[0], leftOut };
  }
  if (opt.anon) {
    return { lines, speakers, price: 0, refuse: new Refuse(403, "Someone in those lines has opted out of being quoted - nothing was charged."),
             why: "Someone in those lines has opted out of being quoted.", optOut: "h:" + (opt.hashes[0] || ""), leftOut };
  }
  const author = viaPepe ? null : (await getQuery("SELECT userId, class, points_balance FROM users WHERE userId = ?", [authorId]))[0];
  const price = !author || SP.can(author, "quotes.free") ? 0 : Math.max(0, Number(L.config().quote_price) || 0);
  if (price > 0 && Number(author.points_balance || 0) < price) {
    const msg = `A quote costs ${price.toLocaleString("en-US")} PAT - you have ${Number(author.points_balance || 0).toLocaleString("en-US")}.`;
    return { lines, speakers, price, refuse: new Refuse(402, msg), why: msg, leftOut };
  }
  return { lines, speakers, price, refuse: null, why: null, leftOut };
}

/**
 * clipmodal: the ✂️ Clip chat card's preview - the lines as the quote card will show them (names, "someone" for anyone private,
 * never a login), how many people, where it goes and who can see it (where: {pad, who, pending}), the price (save: {cost}) or
 * why it can't be posted (save: null, why: an opt-out - at most BURST people named per WINDOW -, the balance, the pad's post
 * rules). Stores and charges nothing.
 */
async function preview({ authorId, roomId, roomName = "", items, viewer }) {
  await init();
  if (!items || !items.length) throw new Refuse(400, "Pick the lines to quote.");
  const T = await terms({ authorId, items });
  const me = await linkedLogin(viewer);
  const P = await postTerms(authorId, roomId, roomName);
  let why = T.refuse ? T.why : P.why;
  if (T.refuse && T.optOut && revealLimited("web|" + authorId, T.optOut)) why = `Slow down — ${BURST} quotes per ${Math.round(WINDOW / 60000)} min.`;
  return {
    lines: T.lines.map((l) => ({ name: l.name, text: l.text, mic: l.k === "tx", pepe: !!l.pepe, me: !!me && l.login === me })),
    speakers: new Set(T.lines.map((l) => l.login || "someone:" + l.name)).size,
    save: why ? null : { cost: T.price }, why: why || null,
    where: { pad: P.pad, who: P.who, pending: !!P.pending },
  };
}

/**
 * clipmodal: the pad's own post rules for a preview - what feedstore.create would refuse before anything is stored, in its
 * order (a required flair - a quote carries none -, the account-wide refusals and room bans, the post limits, who can post
 * here), read-only: the short post gap and the content filter (it logs what it blocks) are left to Post itself. Plus where it
 * goes: {why, pad (its title), who: all | approved | adult, pending (the pad's approval queue holds it)}.
 */
async function postTerms(authorId, roomId, roomName = "") {
  const S = require("./feedstore");
  const rooms = require("./rooms");
  const PA = require("./padaccess");
  const AG = require("./adultgate");
  await S.init();
  const R = rooms.getCached(roomId);
  const out = { why: null, pad: String((R && R.title) || roomName || roomId), who: PA.isApproved(roomId) ? "approved" : AG.applies(roomId) ? "adult" : "all", pending: false };
  const u = await S.account(authorId);
  if (!u) return { ...out, why: "Sign in to post." };
  try { await require("./padflair").checkPostFlair(u, roomId, null); } catch (e) { if (e && e.refuse) return { ...out, why: e.message }; throw e; }
  const no = await S.postRefusal(u, [roomId]);
  if (no) return { ...out, why: no.message };
  if (!SP.can(u, "feed.limits_exempt") && !S.isPepe(u)) {
    const b = await S.postBudget(u);
    if (b.left <= 0) return { ...out, why: b.why };
  }
  const here = await S.roomPostRefusal(u, roomId);
  if (here) return { ...out, why: here.message };
  out.pending = !!(await S.roomSettings(roomId)).approval && !(await rooms.canManage(u, roomId));
  return out;
}

/**
 * Make the quote post. -> {post: {id, url}, lines: n, profile: crosspost result | null}
 * authorId: the account credited; roomId: the pad (registry id = the Camfrog room id); deps.viaPepe: Pepe's own account
 */
async function create({ authorId, roomId, items, title = "", profile = false, source = "web", viaPepe = false }) {
  await init();
  const S = require("./feedstore");
  if (!items || !items.length) throw new Refuse(400, "Pick the lines to quote.");
  const T = await terms({ authorId, items, viaPepe });
  if (T.refuse) throw T.refuse;
  const { lines, speakers, price, leftOut } = T;
  const L = require("./likeness");
  // adultgate site: liveRoom = the room these lines came from - the 18+ gate follows the post (feedstore.liveRoomOf), from its
  // first notice on (the feed_quotes row below is written after the post)
  // review 2 fix-up: the title takes the lines' redaction (a hidden speaker's names, everyone the sticky set hides) - it is shown
  // with the lines and is in the post's address; it is redacted again whenever it is shown (forPosts: a later edit, a later hide)
  const redTitle = typeof lines.redact === "function" ? lines.redact : (s) => s;
  const made = await S.create(authorId, { title: S.cleanLine(redTitle(S.cleanLine(title, TITLE_MAX)), TITLE_MAX), body: bodyOf(lines), community: roomId, announce: [] },
                              viaPepe ? { roomGen: true, liveRoom: roomId } : { liveRoom: roomId });
  let charged = null;
  if (price > 0) {
    try {
      charged = await require("./boosts").tx(async () => {
        await require("./ledger").postOrThrow(authorId, -price, "💬 chat quote", { requireCover: true, transactionId: "quote:" + made.id });
        const cut = await L.siteCut({ key: "quote", flow: "quotes", base: price, subjects: speakers.filter((s) => s), payerId: authorId, room: roomId,
                                      ref: "quote-" + made.id });
        const routing = await require("./premium").bookRoute("quotes", price - cut, { roomId, ownerSelf: false, payerId: authorId, label: "chat quote" });
        return { price, cut, routing };
      });
    } catch (e) {
      await runQuery("UPDATE feed_posts SET deleted_at = ?, deleted_by = 'system', delete_reason = 'quote not paid' WHERE id = ?", [NOW(), made.id]).catch(() => {});
      if (e && (e.code === "E_INSUFFICIENT" || /INSUFFICIENT/.test(String(e.message)))) throw new Refuse(402, `A quote costs ${price.toLocaleString("en-US")} PAT - you don't have enough.`);
      throw e;
    }
  }
  try {
    await runQuery(`INSERT INTO feed_quotes (post_id, room_id, source, lines, logins, removed, created_by, created) VALUES (?, ?, ?, ?, ?, '[]', ?, ?)`,
                   [made.id, roomId, source, JSON.stringify(lines), " " + loginsOf(lines).join(" ") + " ", authorId, NOW()]);
  } catch (e) {
    await runQuery("UPDATE feed_posts SET deleted_at = ?, deleted_by = 'system', delete_reason = 'quote failed' WHERE id = ?", [NOW(), made.id]).catch(() => {});
    throw e;
  }
  let prof = null;
  if (profile && !viaPepe) {
    try { prof = await S.crosspostMany(authorId, made.id, { pads: ["profile"] }); } catch (e) { prof = { error: e.message }; }
  }
  console.log(`[quotes] ${made.id} in ${roomId} by ${authorId} (${source}): ${lines.length} lines, ${loginsOf(lines).length} speakers`);
  // clipmodal: the pad's approval queue holds it (the clip card then says so instead of "posted")
  const pending = !!(await getQuery("SELECT 1 FROM feed_post_rooms WHERE post_id = ? AND pending != 0 LIMIT 1", [made.id]))[0];
  return { post: { id: made.id, url: made.url }, lines: lines.length, left_out: leftOut, profile: prof, price: charged ? charged.price : 0, cut: charged ? charged.cut : 0, pending };
}

/** Blank `logins` out of a quote: their lines become "someone", their names inside the other lines too. The owner's decision-9
 *  change: such a line keeps the speaker's hash (`h`) - it is left out while they are left out - and the post's body leaves those
 *  lines out. -> changed? */
async function anonymise(row, logins, { names = [] } = {}) {
  const set = new Set(logins.map(low).filter(Boolean));
  if (!row || !set.size) return false;
  const lines = parse(row.lines, []);
  const blank = [...names];
  let changed = false;
  for (const l of lines) {
    if (l.login && set.has(low(l.login))) { blank.push(l.login, l.name); l.h = hiddenHash(l.login); l.login = null; l.name = "someone"; l.pepe = undefined; changed = true; }
  }
  for (const s of set) blank.push(s);
  const red = redactor(blank);
  for (const l of lines) { const t = red(l.text); if (t !== l.text) { l.text = t; changed = true; } }
  if (!changed) return false;
  const removed = parse(row.removed, []).concat([...set].map(hiddenHash));
  await runQuery("UPDATE feed_quotes SET lines = ?, logins = ?, removed = ? WHERE post_id = ?",
                 [JSON.stringify(lines), " " + loginsOf(lines).join(" ") + " ", JSON.stringify([...new Set(removed)]), row.post_id]);
  const body = shownBody(lines);
  await runQuery("UPDATE feed_posts SET body = ? WHERE id = ?", [body, row.post_id]);
  // review 2 fix-up: their names leave the quote's title too
  const tr = (await getQuery("SELECT title FROM feed_posts WHERE id = ?", [row.post_id]))[0];
  if (tr && tr.title) {
    let t2 = tr.title;
    try { t2 = require("./chatlogview").redact(t2); } catch (e) { /* the speakers' own names below */ }
    t2 = red(t2);
    if (t2 !== tr.title) await runQuery("UPDATE feed_posts SET title = ? WHERE id = ?", [t2, row.post_id]);
  }
  row.lines = JSON.stringify(lines);
  if (row.post_body !== undefined) row.post_body = body;
  return true;
}

async function linkedLogin(viewer) {
  if (!viewer || !viewer.userId) return null;
  if (viewer.camfrogUsername !== undefined) return low(viewer.camfrogUsername) || null;
  const r = (await getQuery("SELECT camfrogUsername FROM users WHERE userId = ?", [viewer.userId]))[0];
  return r && r.camfrogUsername ? low(r.camfrogUsername) : null;
}

/** "Remove me": the viewer's linked login is one of the speakers -> anonymised in this quote. Idempotent. */
async function removeMe(user, postId) {
  await init();
  if (!user || !user.userId) throw new Refuse(401, "Sign in first.");
  if (!POST_RE.test(String(postId || ""))) throw new Refuse(404, "No such quote.");
  const row = await rowOf(postId);
  if (!row) throw new Refuse(404, "No such quote.");
  const me = await linkedLogin(user);
  const removedBefore = parse(row.removed, []);
  if (me && removedBefore.includes(hiddenHash(me))) return { removed: true, again: true };
  if (!me || !String(row.logins || "").includes(" " + me + " ")) throw new Refuse(403, "Only people quoted in it can remove themselves.");
  const u = (await getQuery("SELECT username, displayname FROM users WHERE userId = ?", [user.userId]))[0] || {};
  await anonymise(row, [me], { names: [u.displayname, u.username] });
  try {
    if (row.created_by && row.created_by !== user.userId) {
      const S = require("./feedstore");
      await S.notify(row.created_by, { kind: "feed", title: "Someone in your quote removed themselves", body: "One of the people quoted asked to be shown as “someone” — their lines stay, without their name.",
                                       link: await S.postPath(row.post_id).catch(() => "/feed"), ref: "quote-rm:" + row.post_id });
    }
  } catch (e) { /* the notice is a courtesy */ }
  console.log(`[quotes] ${row.post_id}: a speaker removed themselves`);
  return { removed: true, again: false };
}

/**
 * CL6: a staff purge (or the 30-day removal of a hidden line, chatlogmod.js) reaches the quotes that copied it: the line leaves
 * every quote of that room made after it was said (by its cursor; a quote from before CL6 by its time + text + speaker), the
 * post's text is rewritten, and a quote left with no line is removed. Runs inside the purge's transaction.
 * lines: [{c, ts, login, text}] (the archived rows before they were blanked). -> quotes changed
 */
async function dropLines(roomId, lines, t = NOW()) {
  if (!roomId || !Array.isArray(lines) || !lines.length) return 0;
  const cs = new Set(lines.map((l) => Number(l.c)).filter((c) => c > 0));
  const sig = new Set(lines.map((l) => `${Number(l.ts) || 0}|${cpCut(String(l.text == null ? "" : l.text), LINE_MAX)}`));
  const logins = new Map(lines.map((l) => [`${Number(l.ts) || 0}|${cpCut(String(l.text == null ? "" : l.text), LINE_MAX)}`, low(l.login)]));
  const since = Math.min(...lines.map((l) => Number(l.ts) || 0)) - 60e3;
  const rows = await getQuery("SELECT * FROM feed_quotes WHERE room_id = ? AND created >= ?", [String(roomId), since]);
  let n = 0;
  for (const row of rows) {
    const before = parse(row.lines, []);
    const after = before.filter((l) => {
      if (l.c != null) return !cs.has(Number(l.c));
      const k = `${Number(l.ts) || 0}|${String(l.text == null ? "" : l.text)}`;
      if (!sig.has(k)) return true;
      return !!(l.login && logins.get(k) && low(l.login) !== logins.get(k));        // the same words and second from someone else
    });
    if (after.length === before.length) continue;
    n++;
    await runQuery("UPDATE feed_quotes SET lines = ?, logins = ? WHERE post_id = ?", [JSON.stringify(after), " " + loginsOf(after).join(" ") + " ", row.post_id]);
    if (!after.length) {
      await runQuery("UPDATE feed_posts SET deleted_at = ?, deleted_by = 'system', delete_reason = 'its chat line was removed', body = '' WHERE id = ? AND deleted_at IS NULL", [t, row.post_id]);
    } else await runQuery("UPDATE feed_posts SET body = ? WHERE id = ?", [bodyOf(after), row.post_id]);
  }
  if (n) console.log(`[quotes] ${n} quote(s) in ${roomId} lost a removed chat line`);
  return n;
}

/** decorate(): post id -> {lines: [{name, text, mic, pepe, ts, me}], speakers, canRemoveMe, removedMe, first, source, left_out,
 *  body}. The owner's decision-9 change: lines of someone LEFT OUT now (!bridge hide, a kind Pepe never said, forget / delete /
 *  staff) aren't shown (left_out counts them) and `body` - the post's text for search, previews and its address - leaves them out
 *  too (stored when it differs: they come back, as "someone", once that person shows themselves again); an incognito speaker is
 *  "someone". While the hidden set is still loading no line is shown and nothing is stored. */
/**
 * CL6 fix-up: the quoted lines (by their feed cursor `c`) the pad chat archive has taken down NOW - hidden by a moderator or staff,
 * hidden by a "minor" report, removed by their author, purged. A quote leaves them out while they are down (left_out counts them;
 * one shown again comes back). A quote from before CL6 carries no cursor (only a purge reaches it: dropLines). Fails closed: a read
 * that fails leaves out every line with a cursor ("all"); no archive table = nothing was ever taken down. -> Set(c) | "all"
 */
async function takenDown(cs) {
  const list = [...new Set(cs.map(Number).filter((c) => c > 0))];
  if (!list.length) return new Set();
  try {
    const out = new Set();
    for (let i = 0; i < list.length; i += 400) {
      const part = list.slice(i, i + 400);
      for (const r of await getQuery(`SELECT c FROM chat_log WHERE c IN (${part.map(() => "?").join(",")}) AND (rm_at IS NOT NULL OR purged IS NOT NULL)`, part)) out.add(Number(r.c));
    }
    return out;
  } catch (e) {
    if (/no such table/i.test(String(e && e.message))) return new Set();
    console.error("[quotes] taken-down lines:", e && e.message);
    return "all";
  }
}
async function forPosts(ids, viewer) {
  const out = new Map();
  if (!ids || !ids.length) return out;
  const rows = await getQuery(`SELECT q.*, p.body AS post_body, p.title AS post_title FROM feed_quotes q LEFT JOIN feed_posts p ON p.id = q.post_id
                               WHERE q.post_id IN (${ids.map(() => "?").join(",")})`, ids);
  if (!rows.length) return out;
  const me = await linkedLogin(viewer);
  const wait = await setLoading();
  try { await require("./chatlogview").init(); } catch (e) { /* the titles show as stored (redacted when made) */ }
  const down = await takenDown(rows.flatMap((r) => parse(r.lines, []).map((l) => (l && l.c != null ? l.c : 0))));
  const isDown = (l) => l && l.c != null && (down === "all" || down.has(Number(l.c)));
  for (const r of rows) {
    // anyone private since the quote was made: anonymised for good, now (not while the set loads: everyone looks private then)
    const lines0 = parse(r.lines, []);
    const gone = wait ? [] : loginsOf(lines0).filter(isPrivate);
    if (gone.length) { try { await anonymise(r, gone); } catch (e) { /* shown anonymised below anyway */ } }
    const all = parse(r.lines, []).map((l) => (l.login && isPrivate(l.login) ? { ...l, h: hiddenHash(l.login), login: null, name: "someone", pepe: undefined } : l));
    const lines = wait ? [] : all.filter((l) => !lineLeftOut(l) && !isDown(l));
    const body = bodyOf(lines);
    if (!wait && r.post_body != null && body !== r.post_body) {
      try { await runQuery("UPDATE feed_posts SET body = ? WHERE id = ?", [body, r.post_id]); } catch (e) { /* the card shows the right lines anyway */ }
    }
    const removed = parse(r.removed, []);
    // review 2 fix-up: the title as shown - the names of everyone the sticky set hides now redacted (a title edited later, or naming
    // someone who went incognito since); stored redacted at creation and on "remove me", so while the set loads it shows as stored
    let title;
    if (typeof r.post_title === "string") {
      title = r.post_title;
      if (!wait) { try { title = require("./chatlogview").redact(title); } catch (e) { title = ""; } }
    }
    out.set(r.post_id, {
      ...(title !== undefined ? { title } : {}),
      lines: lines.map((l) => ({ name: l.name, text: l.text, mic: l.k === "tx", pepe: !!l.pepe, ts: l.ts, me: !!me && l.login === me })),
      speakers: new Set(lines.map((l) => l.login || "someone:" + l.name)).size,       // ("someone"s are never told apart)
      canRemoveMe: !!me && lines.some((l) => l.login === me),
      removedMe: !!me && removed.includes(hiddenHash(me)),
      first: lines[0] ? lines[0].text : "", firstName: lines[0] ? lines[0].name : "", source: r.source,
      left_out: all.length - lines.length, body,
    });
  }
  return out;
}

/** The pad's quote of the day: its best-voted quote (score >= 2) of the last 24 h, else of the last 7 days. */
async function quoteOfDay(roomId, viewer) {
  const S = require("./feedstore");
  for (const top of ["day", "week"]) {
    const L = await S.list({ room: roomId, quotes: true, sort: "top", top, viewer, limit: 1, pins: false });
    const p = (L.posts || [])[0];
    if (p && p.score >= 2 && p.quote) return { post: p, window: top };
  }
  return null;
}

/** clipmodal: the Live tab's own gates for a preview (bridge.js GET /live) -> answered (true) or not. */
async function previewRefused(req, res, R) {
  const PA = require("./padaccess");
  await PA.init();
  if (!PA.full(req.user, R.id)) { res.status(403).json({ ok: false, error: "This pad is for approved members." }); return true; }
  if (!require("./bridge").bridgeOk(R.id)) { res.status(403).json({ ok: false, error: "This pad's live chat room comes with 💎 Prime Time Plus.", locked: "bridge" }); return true; }
  return false;
}

function register(app, { addUser, isBotToken, bySlug }) {
  const json = express.json({ limit: "16kb" });
  const fail = (res, e) => {
    if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message });
    console.error("[quotes]", e);
    res.status(500).json({ ok: false, error: "Something went wrong — nothing was posted." });
  };
  const jsonOnly = (req, res) => {
    if (!req.is("application/json") || req.get("X-Requested-With") !== "fetch") { res.status(400).json({ ok: false, error: "Bad request." }); return false; }
    return true;
  };

  // web: the Live tab's ✂️ Clip chat
  app.post("/api/rooms/:slug/quote", addUser, json, async (req, res) => {
    if (!jsonOnly(req, res)) return;
    try {
      if (!req.user || !req.user.userId) return res.status(401).json({ ok: false, error: "Sign in to quote." });
      const B = require("./bridge");
      await (B.load ? B.load() : null);
      const R = bySlug(req.params.slug);
      if (!R) return res.status(404).json({ ok: false, error: "That Camfrog room isn't on PATV right now." });
      // adultgate site: the 18+ gate on the room this resolved (before its lines are looked at - not even which cursors exist)
      if (require("./adultgate").refuseJson(req, res, R.id)) return;
      // clipmodal: a preview answers only someone who can see the Live tab - GET /live's gates (members-tier pad access, the 💎
      // bridge perk) - before any line is looked at (Post's own rules stay as they are)
      if (req.body && req.body.preview === true && (await previewRefused(req, res, R))) return;
      const b = req.body || {};
      const cs = Array.isArray(b.cs) ? b.cs.slice(0, MAX_LINES + 1) : [];
      // the selection's shape first - it says nothing about the room's feed
      const shape = pick([], { cs });
      if (shape.code === "empty" || shape.code === "count") return res.status(400).json({ ok: false, error: shape.error });
      // CL3 (decision 13) + fix-up: the lines are picked from the quoter's OWN view of the pad - its access, the bridge perk, the
      // public floors, the hidden set; nothing outside it is ever looked at, so one answer covers a line from another room, one
      // that doesn't exist, one below the floor, a hidden person's, a presence line they can't see, and a pad they can't read
      const vis = await require("./chatlogview").quotableFeed(req.user, R.id, R.feed);
      const got = pick(vis, { cs });
      if (got.error && got.code !== "span") return res.status(403).json({ ok: false, code: "not_quotable", error: NOT_QUOTABLE });
      if (got.error) return res.status(400).json({ ok: false, code: got.code, error: got.error });   // too far apart (in their own view)
      // clipmodal: {preview: true} = the clip card's preview, behind every check Post has; nothing is made, no quote slot is used
      if (b.preview === true) {
        const pl = peekLimited("web|" + req.user.userId);
        if (pl) return res.status(429).json({ ok: false, error: pl });
        return res.json({ ok: true, preview: true, ...(await preview({ authorId: req.user.userId, roomId: R.id, roomName: R.name, items: got.items, viewer: req.user })) });
      }
      const lim = limited("web|" + req.user.userId);
      if (lim) return res.status(429).json({ ok: false, error: lim });
      const r = await create({ authorId: req.user.userId, roomId: R.id, items: got.items, title: b.title, profile: b.profile === true, source: "web" });
      res.json({ ok: true, ...r });
    } catch (e) { fail(res, e); }
  });

  // chat: Pepe's !quote
  app.post("/api/bridge/quote", express.json({ limit: "8kb" }), async (req, res) => {
    const b = req.body || {};
    if (!isBotToken(b.password)) return res.status(403).json({ ok: false });
    try {
      const B = require("./bridge");
      await (B.load ? B.load() : null);
      const R = B._rooms.get(String(b.room || ""));
      if (!R) return res.status(404).json({ ok: false, error: "this room isn't on its pad right now (bridge it with !bridge on)" });
      const cf = low(b.camfrog);
      const lim = limited("chat|" + R.id + "|" + (cf || "someone"));
      if (lim) return res.status(429).json({ ok: false, error: lim.replace(/^Slow down — /, "slow down: ") });
      const s = b.spec && typeof b.spec === "object" ? b.spec : {};
      const spec = { mode: String(s.mode || ""), n: Number(s.n) || 0, login: LOGIN_RE.test(low(s.login)) ? low(s.login) : "",
                     user: String(s.user || "").slice(0, 40), from: String(s.from || "").slice(0, PHRASE_MAX), to: String(s.to || "").slice(0, PHRASE_MAX) };
      const CV = require("./chatlogview");
      if (spec.mode === "user" && (isHidden(spec.login) || isHidden(spec.user) || CV.isHiddenLogin(spec.login))) return res.status(400).json({ ok: false, error: "they're private" });
      const got = pick(shownFeed(R.feed), spec, Number(b.before) || null);
      if (got.error) return res.status(400).json({ ok: false, error: got.error });
      // credited to the requester's linked PATV account (never an archived one), else to Pepe (the owner's decision-9 change: and to
      // Pepe when the requester is hidden by any kind - the post's author would name them)
      let author = null;
      if (cf && LOGIN_RE.test(cf) && !isHidden(cf) && !CV.isHiddenLogin(cf)) {
        const C = (await getQuery("PRAGMA table_info(users)")).some((c) => c.name === "archived_at");
        author = (await getQuery(`SELECT userId FROM users WHERE lower(camfrogUsername) = ? ${C ? "AND archived_at IS NULL" : ""}
                                  ORDER BY CASE WHEN username LIKE 'CF%' THEN 1 ELSE 0 END LIMIT 1`, [cf]))[0] || null;
      }
      const S = require("./feedstore");
      const r = await create({ authorId: author ? author.userId : S.PEPE_ID, roomId: R.id, items: got.items, title: b.title, source: "chat", viaPepe: !author });
      res.json({ ok: true, url: r.post.url, id: r.post.id, lines: r.lines });
    } catch (e) {
      if (e && e.refuse) return res.status(e.status || 400).json({ ok: false, error: e.message });
      console.error("[quotes] bridge:", e);
      res.status(500).json({ ok: false, error: "the website hit an error" });
    }
  });

  app.post("/api/feed/posts/:id/quote-remove-me", addUser, json, async (req, res) => {
    if (!jsonOnly(req, res)) return;
    try { res.json({ ok: true, ...(await removeMe(req.user, req.params.id)) }); } catch (e) { fail(res, e); }
  });

  // a pad's quotes: /p/<pad>/quotes (top of the week by default, or new) + the quote of the day
  app.get("/p/:slug/quotes", addUser, async (req, res, next) => {
    try {
      const S = require("./feedstore");
      const P = require("./pads");
      const R = (await require("./rooms").bySlug(String(req.params.slug || "").toLowerCase())) || (await require("./roomsweb").resolveRoom(String(req.params.slug || "")).catch(() => null));
      if (!R || (R.profile && R.profile.username)) return next();
      const viewer = req.user && req.user.userId ? await S.account(req.user.userId) : null;
      const q = req.query || {};
      const sort = q.sort === "new" ? "new" : "top";
      const top = S.cleanWindow(q.t, "week");
      const page = Math.max(1, Math.min(200, parseInt(q.p, 10) || 1));
      const L = await S.list({ room: R.id, quotes: true, sort, top, page, viewer, pins: false, sfw: !viewer });
      const qotd = page === 1 ? await quoteOfDay(R.id, viewer).catch(() => null) : null;
      const modRooms = new Set();
      try { if (viewer && (await require("./rooms").canManage(viewer, R.id))) modRooms.add(R.id); } catch (e) { /* none */ }
      res.set("Cache-Control", "private, no-store");
      res.render("quotes", { user: viewer ? viewer.username : null, viewer, pad: { id: R.id, title: R.title, slug: P.padSlug(R), href: P.padHref(R) },
        posts: L.posts, more: L.more, page, sort, top, qotd, fx: require("./feedweb").fx, embeds: require("./stageembed"), host: req.hostname || "publicaccess.tv", modRooms });
    } catch (e) { next(e); }
  });
}

module.exports = { register, pick, shownFeed, buildLines, bodyOf, shownBody, create, removeMe, anonymise, dropLines, forPosts, quoteOfDay, setHidden, isHidden,
  isLeftOut, isPrivate, lineLeftOut, hiddenHash, limited,
  // tests (hubhidden's own rules): hubhidden.js's half of isHidden - what its setHidden handed over (or it is loading)
  _hubHidden: (login) => !!login && (hubLoading() || HIDDEN.has(hiddenHash(login))),
  MAX_LINES, SPAN_MAX, Refuse, _setClock, _hits: hits };
