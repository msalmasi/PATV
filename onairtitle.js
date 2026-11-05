// onairtitle.js (1.99akr onairtitle) - the NAME of what's on Pepe's main stream, for Pepe himself.
//
// Asked "pepe whats playing on your cam" while a pasted YouTube link was on air, Pepe only had "🔗 YouTube video" (the label
// stageembed.js makes from {p, t, id}) and the model made up "it's whatever YouTube's serving, I don't pick the video".
// An embed pick (a pasted link, an embed slot, a ⏰ queued link) now carries its video's title + channel:
//   * YouTube video / live: YouTube's oEmbed (no key: https://www.youtube.com/oembed) through linkpreview.safeGet (public
//     hosts only, a short timeout, a small cap), looked up ONCE per video in the background - a pick never waits for it;
//     a hit is kept TTL_MS, a miss (removed / private / the network) is not asked again for MISS_MS, failure = the label
//     as before ("a YouTube video");
//   * what the OBS player page says it's playing (onair-player.js: the YouTube player's getVideoData) - the only source
//     for a channel's live stream (no oEmbed for that), and a second one when oEmbed can't be reached;
//   * Twitch: the channel is in the label already ("Twitch: <login>"; there's no keyless oEmbed any more).
// A 📼 Plex / Go Live / stage slot's title and a card's title are the pick's own (onair.js botTarget).
// Everything here is UNTRUSTED text the video's uploader wrote: one line, controls / invisible characters / markup / links
// out, capped (clean). Pepe frames it as data in his prompt (pepe_onairnow.py) - it's never an instruction.
// Review (safety 1): a title / channel reaches public chat with no model in between (Pepe's plain fallback line, the 📼 "what's
// on your cam" answer, the !onair status), so it gets the rule a caption / card text already has (onairmedia.textBad: textguard,
// the feed filter, the broadcast explicit-terms list - fail closed) and its link-shaped words ("site.example/claim") go: vet().
// A title that trips the filter is HELD - Pepe is told one exists but not what it says ({held: true}); never the raw text.
"use strict";
const TC = () => require("./textclean");
const EMB = () => require("./stageembed");

const TITLE_MAX = 100;
const AUTHOR_MAX = 60;
const TTL_MS = 6 * 3600 * 1000;
const MISS_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;
const TIMEOUT_MS = 4000;
const MAX_BYTES = 64 * 1024;

let clock = () => Date.now();
const CACHE = new Map();      // "p:t:id" -> {at, title, author} | {at, miss: true}   (Map order = least recently set first)
const FLIGHT = new Map();     // "p:t:id" -> the lookup's promise (one at a time per video)
const VETTED = new Map();     // raw title + channel -> vet()'s answer (the OBS player reports every 5 s; a slot's title every poll)
const VET_MAX = 200;
const RAW_MAX = 300;          // what's vetted: the cleaned text up to here (the cap after)

/** Untrusted one-line text (a video title, a channel name) -> safe to show and to hand Pepe. Never throws. */
function clean(s, n = TITLE_MAX) {
  if (s == null || typeof s === "object") return "";
  let t = TC().oneLine(String(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, " "));
  t = t.replace(/<[^>]{0,200}>/g, " ").replace(/[<>]/g, " ").replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ").replace(/\bwww\.\S+/gi, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
}
/** Link-shaped words out ("evil.example/claim", "Node.js" too - the caption rule: no link on Pepe's stream text). */
function delink(t) {
  const U = require("./onairmedia").URLISH;
  return t.split(" ").filter((w) => !U.test(w.replace(/^[("'“‘[<]+|[)"'”’\]>.,!?;:]+$/g, ""))).join(" ").replace(/\s+/g, " ").trim();
}
/** Untrusted text that may be SAID in chat (a video title, its channel) -> {text} | {held: true} (the abuse filter tripped -
 *  never the text) | null (nothing). Cleaned, link-shaped words out, then onairmedia.textBad (fail closed: an error = held). */
function vetText(s, n = TITLE_MAX) {
  const t = delink(clean(s, RAW_MAX));
  if (!t) return null;
  let bad;
  try { bad = require("./onairmedia").textBad(t); } catch (e) { bad = true; }
  return bad ? { held: true } : { text: t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t };
}
/** A title + its channel, both untrusted -> {title, author} | {held: true} | null. A channel that trips the filter is just
 *  dropped (the title stays); a title that does = held (the channel goes with it). Memoised (cheap to call every poll). */
function vet(title, author) {
  if (title == null || typeof title === "object") return null;
  const key = JSON.stringify([String(title).slice(0, 2 * RAW_MAX), author == null || typeof author === "object" ? "" : String(author).slice(0, RAW_MAX)]);
  if (VETTED.has(key)) return VETTED.get(key);
  const ti = vetText(title, TITLE_MAX);
  let out = null;
  if (ti && ti.held) out = { held: true };
  else if (ti) {
    const au = vetText(author, AUTHOR_MAX);
    out = { title: ti.text, author: au && au.text ? au.text : null };
  }
  VETTED.set(key, out);
  while (VETTED.size > VET_MAX) VETTED.delete(VETTED.keys().next().value);
  return out;
}
const keyOf = (c) => `${c.p}:${c.t}:${c.id}`;
/** The keyless oEmbed address for an embed, or null (a YouTube channel's live stream, Twitch: none). */
function oembedUrl(c) {
  if (c && c.p === "youtube" && (c.t === "video" || c.t === "live")) {
    return "https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + c.id);
  }
  return null;
}
async function defaultFetch(url) {
  if (process.env.NODE_TEST_CONTEXT) return null;          // the tests never go out (they set their own: _setFetch)
  const r = await require("./linkpreview").safeGet(url, { maxBytes: MAX_BYTES, accept: "application/json", timeoutMs: TIMEOUT_MS });
  if (!r || r.status !== 200 || r.truncated) return null;
  return JSON.parse(r.body.toString("utf8"));
}
let fetchJson = defaultFetch;
function withTimeout(p, ms) {
  let timer;
  return Promise.race([p, new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); if (timer.unref) timer.unref(); })])
    .finally(() => clearTimeout(timer));
}
function prune(t) {
  for (const [k, v] of CACHE) if (t - v.at > (v.miss ? MISS_MS : TTL_MS)) CACHE.delete(k);
  while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
}

/** What's cached for an embed -> {title, author} | {held: true} (a title the filter held) | null. Never waits, never fetches. */
function cached(e, t = clock()) {
  const c = EMB().clean(e);
  const v = c ? CACHE.get(keyOf(c)) : null;
  if (!v || v.miss || t - v.at > TTL_MS) return null;
  return v.held ? { held: true } : { title: v.title, author: v.author || null };
}
const answerOf = (v) => (v.miss ? null : v.held ? { held: true } : { title: v.title, author: v.author || null });
/** An embed's title + channel, looked up (deduped per video; a miss remembered MISS_MS) -> {title, author} | {held: true} | null.
 *  Never throws. */
function lookup(e, t = clock()) {
  const c = EMB().clean(e);
  if (!c) return Promise.resolve(null);
  const k = keyOf(c);
  const v = CACHE.get(k);
  if (v && t - v.at <= (v.miss ? MISS_MS : TTL_MS)) return Promise.resolve(answerOf(v));
  const url = oembedUrl(c);
  if (!url) return Promise.resolve(null);
  if (FLIGHT.has(k)) return FLIGHT.get(k);
  const p = (async () => {
    let j = null;
    try { j = await withTimeout(Promise.resolve().then(() => fetchJson(url)), TIMEOUT_MS + 1000); } catch (err) { j = null; }
    const r = j && typeof j === "object" ? vet(j.title, j.author_name) : null;
    const v2 = !r ? { at: clock(), miss: true } : r.held ? { at: clock(), held: true } : { at: clock(), title: r.title, author: r.author || null };
    CACHE.delete(k);
    CACHE.set(k, v2);
    prune(clock());
    return answerOf(v2);
  })().finally(() => FLIGHT.delete(k));
  FLIGHT.set(k, p);
  return p;
}
/** The cached title, else a lookup started in the background (not awaited) and null. Never waits, never throws. */
function peek(e, t = clock()) {
  const hit = cached(e, t);
  if (hit) return hit;
  lookup(e, t).catch(() => {});
  return null;
}
/** What the OBS player page reported it's playing ({title, author} from the page, untrusted) -> {title, author} | {held: true}
 *  | null (vet: the same filter as an oEmbed title). */
function fromPlayer(meta) {
  if (!meta || typeof meta !== "object") return null;
  return vet(meta.title, meta.author);
}

module.exports = { clean, vet, cached, lookup, peek, fromPlayer, oembedUrl, TITLE_MAX, AUTHOR_MAX, TTL_MS, MISS_MS, CACHE_MAX, TIMEOUT_MS,
  _setFetch: (fn) => { fetchJson = fn || defaultFetch; },
  _setClock: (fn) => { clock = fn || (() => Date.now()); },
  _reset: () => { CACHE.clear(); FLIGHT.clear(); VETTED.clear(); } };
