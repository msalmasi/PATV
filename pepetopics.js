// pepetopics.js — 1.99wq: one story, one pad. Pepe's NEWS-like posts (his news takes, the auto-market announcements, his DJ-set
// write-ups) used to go out per pad - the same headline could land in Pepe's Pad, PepeLab, the Camfrog Lounge and "All" at once.
//
// Every such post now passes through here (pepefeed.post, automkt.announce):
//   1. DEDUPE over a recent-topics memory (pepe_topics, WINDOW_MS = 48 h): the same story key (the headline normalised, a URL
//      without its query, a market ref) or a semantically similar one (token overlap: OVERLAP of the smaller set with at least
//      MIN_SHARED shared words, or Jaccard >= JACCARD) is refused, wherever it went.
//   2. ROUTE (news / markets): ONE pad - the best-fit pad among the pads where Pepe may post that kind (his posts on there, the
//      kind allowed, not a profile / 18+ pad): the story's words against each pad's own words (title, description, its own tags,
//      its popular tags, its post flair names; a tag hit counts double). A pad needs FIT_MIN points to win; otherwise the
//      DEFAULT pad - Pepe's Pad (rooms.HOUSE_ROOM; automkt: its configured pad) - when he may post there, else the pad asked for.
//      DJ write-ups aren't routed (they belong to the music room they're about) - only deduped.
//   Recaps are per pad by design and never come here.
//   pepe_topics  id, at, kind, room_id, post_id, story_key, title, sig (JSON: the story's words)
// The bot also gets the last 48 h of topics in its feed sync (recent()), so it doesn't spend a model call on a story that's taken.
"use strict";
const { runQuery, getQuery } = require("./dbUtils");

const WINDOW_MS = 48 * 3600e3;
const ROUTED = new Set(["news", "markets"]);
const DEDUPED = new Set(["news", "markets", "dj"]);
const OVERLAP = 0.6, MIN_SHARED = 3, JACCARD = 0.45, FIT_MIN = 2;
const STOP = new Set(("the a an and or but of to in on for with at by from is are was were be been being it its this that these those as " +
  "about into over after before new just not no yes you your we our they their he she his her them him i me my so than then there here " +
  "what when where who why how all any some more most very can could will would should may might must has have had do does did " +
  "says said say via amid vs per out up down off one two get gets got make makes made take takes year years today week day " +
  "published ago hours hour minutes mon tue wed thu fri sat sun jan feb mar apr jun jul aug sep sept oct nov dec").split(/\s+/));
let NOW = () => Date.now();

let ready = null;
function init() {
  if (!ready) {
    ready = (async () => {
      await runQuery(`CREATE TABLE IF NOT EXISTS pepe_topics (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL,
        room_id TEXT, post_id TEXT, story_key TEXT, title TEXT, sig TEXT)`);
      await runQuery("CREATE INDEX IF NOT EXISTS pepe_topics_at ON pepe_topics (at)");
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** A headline without the bot's "(published 3h ago, Tue Oct 6)" note and its " - Source" tail. */
function cleanHeadline(s) {
  return String(s || "").replace(/\s*\((?:published|updated)[^)]*\)\s*$/i, "").replace(/\s+[-–—|]\s+[^-–—|]{2,40}$/, "").replace(/\s+/g, " ").trim();
}
const stem = (w) => (w.length > 4 && /ies$/.test(w) ? w.slice(0, -3) + "y" : w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w);
/** The meaningful words of a text (lowercased, stop words out, plural -s off). */
function tokens(text) {
  const out = new Set();
  for (const w of String(text || "").toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.add(stem(w));
  }
  return out;
}
/** The story's key: an explicit id / ref, a URL (host + path), else the normalised headline. */
function storyKey(story = {}) {
  if (story.id) return "id:" + String(story.id).slice(0, 120);
  if (story.url) {
    try { const u = new URL(String(story.url)); return "url:" + (u.host.replace(/^www\./, "") + u.pathname.replace(/\/+$/, "")).toLowerCase().slice(0, 200); }
    catch (e) { /* not a URL */ }
  }
  const h = cleanHeadline(story.headline || story.title || "");
  return h ? "h:" + h.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 200) : null;
}
/** How alike two word sets are: {shared, overlap, jaccard, same} */
function similarity(a, b) {
  const A = a instanceof Set ? a : new Set(a || []), B = b instanceof Set ? b : new Set(b || []);
  if (!A.size || !B.size) return { shared: 0, overlap: 0, jaccard: 0, same: false };
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  const overlap = shared / Math.min(A.size, B.size), jaccard = shared / (A.size + B.size - shared);
  return { shared, overlap, jaccard, same: (overlap >= OVERLAP && shared >= MIN_SHARED) || (jaccard >= JACCARD && shared >= 2) };
}
/** The words a story is about: its headline when there is one (that's what the news is), else the post's title + body. */
function storyWords(o = {}) {
  const s = o.story || {};
  const h = cleanHeadline(s.headline || "");
  return tokens(h || `${s.title || ""} ${o.title || ""} ${o.body || ""}`);
}

/** The last 48 h of topics: [{kind, room, post, key, title, at, words}] */
async function recent({ t = NOW(), kinds = null } = {}) {
  await init();
  const rows = await getQuery("SELECT * FROM pepe_topics WHERE at > ? ORDER BY at DESC LIMIT 400", [t - WINDOW_MS]);
  return rows.filter((r) => !kinds || kinds.includes(r.kind)).map((r) => {
    let w = [];
    try { w = JSON.parse(r.sig || "[]"); } catch (e) { w = []; }
    return { kind: r.kind, room: r.room_id, post: r.post_id, key: r.story_key, title: r.title, at: r.at, words: w };
  });
}
/** The earlier topic this story repeats (same key, or similar words), or null. Every topic kind counts against every other. */
async function duplicate(o = {}) {
  const key = o.key !== undefined ? o.key : storyKey(o.story || {});
  const W = o.words || storyWords(o);
  for (const r of await recent({ t: o.t })) {
    if (key && r.key && r.key === key) return { ...r, why: "same story" };
    if (similarity(W, r.words).same) return { ...r, why: "similar story" };
  }
  return null;
}

/** The words a pad is about (title, description, own + popular tags, post flair names). Tags weigh double. -> {words, tagWords} */
async function padWords(R) {
  const TG = require("./feedtags");
  const words = tokens(`${R.title || ""} ${R.description || ""}`);
  const tagWords = new Set();
  let tags = [];
  try { tags = [...(await TG.padTags(R.id)), ...(await TG.popular(R.id, { limit: 15 })).map((x) => x.tag)]; } catch (e) { tags = []; }
  for (const t of tags) for (const w of tokens(t.replace(/-/g, " "))) tagWords.add(w);
  try { for (const f of (await require("./padflair").postRules(R.id)).flairs) for (const w of tokens(f.name)) words.add(w); } catch (e) { /* none */ }
  return { words, tagWords };
}
/** Fit points of a story's words for one pad. */
function fit(storyW, P) {
  let n = 0;
  for (const w of storyW) { if (P.tagWords.has(w)) n += 2; else if (P.words.has(w)) n += 1; }
  return n;
}
/** May Pepe post this kind in this pad? (his posts on there, the kind allowed, not a profile / 18+ pad, not switched off) */
async function mayPost(roomId, kind) {
  const rooms = require("./rooms");
  const pf = require("./pepefeed");
  const R = rooms.getCached(roomId) || (await rooms.get(roomId));
  if (!R || R.profile || rooms.isProfile(roomId)) return false;
  try { const CR = require("./creators"); await CR.init(); if (CR.isR18Room(roomId)) return false; } catch (e) { /* no creators */ }
  const S = await pf.scopeSettings(roomId);
  if (S.enabled === false || !pf.postsOn(S)) return false;
  const k = kind === "markets" ? "news" : kind;                 // auto-market announcements are news-like for the owner's kinds
  return pf.kindsOf(S).includes(k);
}
/**
 * Where ONE news-like post goes. o: {kind, story, title, body, scope (the pad asked for), fallback (the default pad; Pepe's Pad),
 * candidates (pad ids; default every listed pad)} -> {room, why, score, scores}
 */
async function route(o = {}) {
  const rooms = require("./rooms");
  const kind = o.kind || "news";
  const def = o.fallback || rooms.HOUSE_ROOM;
  if (!ROUTED.has(kind)) return { room: o.scope || def, why: "not routed" };
  const W = storyWords(o);
  const ids = o.candidates || (await rooms.list()).map((r) => r.id);
  let best = null;
  const scores = {};
  for (const id of ids) {
    if (!(await mayPost(id, kind).catch(() => false))) continue;
    const R = rooms.getCached(id) || (await rooms.get(id));
    if (!R) continue;
    const s = fit(W, await padWords(R));
    scores[id] = s;
    // ties: the default pad, then the pad asked for, then the first listed
    if (!best || s > best.s || (s === best.s && (id === def || (id === o.scope && best.id !== def)))) best = { id, s };
  }
  if (best && best.s >= FIT_MIN) return { room: best.id, why: best.id === def ? "default pad fits best" : "best fit", score: best.s, scores };
  if (await mayPost(def, kind).catch(() => false)) return { room: def, why: "default pad", score: scores[def] || 0, scores };
  if (o.force && def) return { room: def, why: "default pad (forced)", score: 0, scores };
  if (o.scope && (await mayPost(o.scope, kind).catch(() => false))) return { room: o.scope, why: "the pad asked for", score: scores[o.scope] || 0, scores };
  return { room: null, why: "no pad takes this kind of post", scores };
}
/** Remember a posted topic. */
async function remember(o = {}) {
  await init();
  const key = o.key !== undefined ? o.key : storyKey(o.story || {});
  const W = [...(o.words || storyWords(o))].slice(0, 60);
  const title = cleanHeadline((o.story && o.story.headline) || o.title || "").slice(0, 200);
  await runQuery("INSERT INTO pepe_topics (at, kind, room_id, post_id, story_key, title, sig) VALUES (?, ?, ?, ?, ?, ?, ?)",
                 [NOW(), String(o.kind || "news"), o.room || null, o.post || null, key, title || null, JSON.stringify(W)]);
  await runQuery("DELETE FROM pepe_topics WHERE at < ?", [NOW() - 7 * 86400e3]).catch(() => {});
}

module.exports = { init, route, duplicate, remember, recent, mayPost, padWords, fit, tokens, storyKey, storyWords, similarity, cleanHeadline,
                   ROUTED, DEDUPED, WINDOW_MS, FIT_MIN, _setClock: (fn) => { NOW = fn || (() => Date.now()); } };
