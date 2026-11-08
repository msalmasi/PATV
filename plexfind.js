// The clerk selects only catalog keys. Playback, account access and PAT checks stay in plexchat / mediaqueue.
"use strict";
const crypto = require("crypto");
const { performance } = require("node:perf_hooks");
// plexvectors 1.99amo: the pool a vector search may score - the vectors module's own caps (films 100,000: prod has 30,682)
const { MAX_MOVIES, MAX_EPISODES } = require("./plexvectors");
const KEY = /^\d{1,12}$/;
const SELECT = new Set(["one", "random", "latest", "oldest", "first_n", "last_n", "pilot", "finale", "season", "series", "in_order"]);
const normOf = (text) => {
  const value = text.toLowerCase().normalize("NFKD").replace(/([a-z])[\u0300-\u036f]+/g, "$1").normalize("NFC").replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim().replace(/^(the|a|an) /, "");
  return /[\p{L}\p{N}]/u.test(value) ? value : "";
};
// 1.99amh plexclerk: a find compares the line with every film's and show's title (35k at the real library's size) several times;
// the normalising was most of a find's CPU on the site's event loop. A pure function of the string: remembered (bounded).
const normKept = new Map(), NORM_KEEP = 200000;
const norm = (s) => {
  const text = typeof s === "string" ? s : String(s || "");
  let value = normKept.get(text);
  if (value === undefined) {
    value = normOf(text);
    if (normKept.size >= NORM_KEEP) normKept.clear();
    normKept.set(text, value);
  }
  return value;
};
const sameName = (left, right) => { const value = norm(left); return !!value && value === norm(right); };
// 1.99?? clerkreq S3: a name as said, its article KEPT - "The Good Doctor" (2017) is not "Good Doctor" (2013), though sameName folds both
const keptOf = (text) => String(text || "").toLowerCase().normalize("NFKD").replace(/([a-z])[̀-ͯ]+/g, "$1").normalize("NFC")
  .replace(/&/g, " and ").replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim();
const clean = (s, n = 100) => typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n) : "";
const integer = (v, lo, hi) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null;
const names = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x) => clean(x)).filter(Boolean).slice(0, 3) : [];
const ratingSets = new Map();   // 1.99amh plexclerk: allowed() asked for the block list's Set once per row; one per setting text
const ratingNames = (s) => {
  const text = String(s == null ? "" : s);
  let set = ratingSets.get(text);
  if (!set) {
    set = new Set(text.split(",").map((x) => x.trim().toUpperCase().replace(/^[A-Z]{2}\/\s*/, "")).filter(Boolean));
    if (ratingSets.size >= 32) ratingSets.clear();
    ratingSets.set(text, set);
  }
  return set;
};
const number = (v) => v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
const rating = (r) => number(r.rating) != null ? number(r.rating) : number(r.audience_rating);
const duration = (r) => Math.max(0, Number(r.duration) || 0);
const titleMatch = (title, query) => {
  const t = norm(title), q = norm(query);
  return !!q && (t === q || t.startsWith(q + " ") || q.split(" ").every((w) => (" " + t + " ").includes(" " + w + " ")));
};
const episodeOrder = (a, b) => (a.aired && b.aired ? String(a.aired).localeCompare(String(b.aired)) : 0)
  || ((Number(a.season) || 0) - (Number(b.season) || 0)) || ((Number(a.episode) || 0) - (Number(b.episode) || 0)) || String(a.key).localeCompare(String(b.key));
const movieOrder = (a, b) => String(a.aired || `${a.year || 0}-01-01`).localeCompare(String(b.aired || `${b.year || 0}-01-01`)) || String(a.key).localeCompare(String(b.key));
// 1.99amq clerkfast (owner 2026-11-08, the pink-shirt ask): "the episode of <show> where <description>" - is ONE of that show's
// episodes clearly the one? Only when exactly one episode has every TELLING word of the description in its title or summary.
// Telling: not a filler word, not the show's own name, and in no more than a fifth of the show's episodes ("homer" is in most
// Simpsons summaries and tells nothing). A word NO episode has means the summaries can't settle it (prod's summary for the
// pink-shirt episode never says "pink" or "shirt" - and Team Homer's has "shirts"): never clear then, the bot's model decides.
// Plurals / third person fold ("shirts" = "shirt", "wears" = "wear"); nothing else is stemmed.
const DESCRIBE_SKIP = new Set(("a an the of and or but in on at to for by with from into onto off over under about as is are was were be been being " +
  "it its this that these those they them their there here where when which who whom whose what how why he she his her him we us our you " +
  "your i me my do does did not no so than then too very can will just one some any all has have had get gets got goes going went gone " +
  "episode episodes show shows season seasons series part whereas while also").split(" "));
const DESCRIBE_COMMON = 0.2;
const stem = (w) => w.length > 4 && w.endsWith("ies") ? w.slice(0, -3) + "y"
  : w.length > 4 && /(?:s|x|z|ch|sh)es$/.test(w) ? w.slice(0, -2)
    : w.length > 3 && w.endsWith("s") && !/(?:ss|us|is)$/.test(w) ? w.slice(0, -1) : w;
// review F7: normOf, not the cached norm - summaries are long and many; the bounded cache is for the titles (1.99amh)
const wordsOf = (text) => new Set(normOf(String(text || "")).split(" ").filter(Boolean).map(stem));
function describedOnce(about, show, episodes) {
  const own = wordsOf(show && show.title);
  const words = [...new Set(norm(about).split(" ").filter((w) => w.length >= 3 && !DESCRIBE_SKIP.has(w)).map(stem))].filter((w) => !own.has(w));
  if (!words.length || !episodes.length) return null;
  const texts = episodes.map((r) => wordsOf(`${r.title || ""} ${r.summary || ""}`));
  const df = new Map(words.map((w) => [w, texts.reduce((n, t) => n + (t.has(w) ? 1 : 0), 0)]));
  if (words.some((w) => !df.get(w))) return null;
  const cap = Math.max(2, Math.ceil(episodes.length * DESCRIBE_COMMON));
  const telling = words.filter((w) => df.get(w) <= cap);
  if (!telling.length) return null;
  const covering = episodes.filter((_, i) => telling.every((w) => texts[i].has(w)));
  return covering.length === 1 ? String(covering[0].key) : null;
}
class ClerkError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; this.refuse = true; }
}
function askOf(value) {
  const a = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (a.select != null && !SELECT.has(a.select)) throw new ClerkError("bad", "Bad selection.");
  if (a.kind != null && !["movie", "show", "episode"].includes(a.kind)) throw new ClerkError("bad", "Bad kind.");
  if (a.rank_max != null && integer(a.rank_max, 1, 1000) == null) throw new ClerkError("bad", "Bad rank limit.");
  const years = Array.isArray(a.years) && a.years.length === 2 && a.years.every((x) => integer(x, 1880, 2200) != null) && a.years[0] <= a.years[1] ? a.years : null;
  return { title: clean(a.title), action: a.action === "browse" ? "browse" : null, kind: a.kind || null, select: a.select || "one", n: integer(a.n, 1, 60),
    season: integer(a.season, 0, 200), episode: integer(a.episode, 0, 2000), year: integer(a.year, 1880, 2200), years,
    genres: names(a.genres), shelves: names(a.shelves), unknown_shelves: names(a.unknown_shelves), rank_max: integer(a.rank_max, 1, 1000), people: names(a.people), studio: clean(a.studio),
    min_minutes: integer(a.min_minutes, 0, 1440), max_minutes: integer(a.max_minutes, 1, 1440),
    deep_cut: a.deep_cut === true, popular: a.popular === true, unseen: a.unseen === true,
    quality: ["good", "best"].includes(a.quality) ? a.quality : "any", steamy: a.steamy === true,
    about: clean(a.about, 200), like: clean(a.like), guesses: Array.isArray(a.guesses) ? a.guesses.slice(0, 5) : [] };
}
function createFinder({ catalog, settings, requests, vectors, lists, now = Date.now, rng = crypto.randomInt, deepMax } = {}) {
  catalog = catalog || require("./plexcatalog");
  settings = settings || (() => require("./mediaconf").get());
  const listSource = () => lists || require("./plexlists");
  async function shelves(fallbackRows = []) {
    const base = typeof catalog.shelves === "function" ? await catalog.shelves() : { ok: true, genres: [], shelves: [...new Set(fallbackRows.flatMap((r) => r.shelves || []))].map((name) => ({ name, source: "kometa", ranked: false })) };
    const local = (base.shelves || []).filter((r) => r && typeof r.name === "string" && r.source !== "mdblist").map((r) => ({ ...r, source: "kometa", ranked: false }));
    let outside = [];
    if (settings().clerk_lists === true) try { outside = await listSource().shelves(); } catch (_) { /* Cached source failure contributes no names or members. */ }
    if (settings().clerk_lists !== true) outside = [];
    return { ...base, shelves: [...local, ...outside.filter((r) => r && r.source === "mdblist" && r.count > 0)] };
  }
  // 1.99amh plexclerk: an Oscars list keeps its provider's name ("Oscar Best Picture Winners", "Academy Award Winners") - every
  // such name is the one "oscars" shelf, so "an oscar winner" finds whichever the admin added
  const OSCARS = /^(?:(?:oscars?|academy awards?)(?: best picture)?(?: winners?| winning(?: films?| movies?| pictures?)?)?|best picture(?: oscar| academy award)?(?: winners?)?)$/;
  function shelfName(value) {
    const n = norm(value).replace(/\s+(?:shelf|list)$/, "");
    if (OSCARS.test(n)) return "oscars";
    const aliases = { criterion: "criterion collection" };
    return aliases[n] || n.replace(/^(imdb|letterboxd) top \d+$/, "$1 top 250");
  }
  async function shelfFilters(a, raw, roots, literal) {
    if (literal) return { filters: [], missing: false, suggestions: [] };
    let explicit = raw.match(/^(?:something|anything|a movie|a film|a show|an episode)\s+from\s+(?:(?:the|our)\s+)?(.+?)(?:\s+(?:shelf|list))?[.!?]*$/i);
    if (!explicit) explicit = raw.match(/^(?:(?:a|an|some|any|something|anything)\s+)?(?:the\s+)?((?:imdb|letterboxd|afi) top \d+)(?:\s+(?:pick|movie|film|list))?[.!?]*$/i);
    if (!explicit && /^(?:(?:a|an|some|any)\s+)?(?:oscar|academy award)[ -](?:winners?|winning)(?:\s+(?:movie|film|picture)s?)?[.!?]*$/i.test(raw)) explicit = [raw, "Oscars"];
    if (explicit) {
      const named = clean(explicit[1]);
      // A raw explicit list constraint survives even if interpretation dropped an unknown shelf name.
      if (!a.shelves.some((name) => shelfName(name) === shelfName(named))) a.shelves.push(named);
      const ranked = norm(named).match(/^(?:imdb|letterboxd) top (\d+)$/);
      if (ranked && !a.rank_max) {
        a.rank_max = integer(Number(ranked[1]), 1, 1000);
        if (!a.rank_max) return { filters: [], missing: true, suggestions: [] };
      }
    }
    if (!a.shelves.length && !a.unknown_shelves.length && !a.rank_max) return { filters: [], missing: false, suggestions: [] };
    const available = (await shelves(roots)).shelves, wanted = [...a.shelves, ...a.unknown_shelves];
    const filters = [], absent = [];
    for (const name of wanted) {
      const choices = available.filter((r) => shelfName(r.name) === shelfName(name));
      const picked = a.rank_max && choices.find((r) => r.source === "mdblist" && r.ranked) || choices.find((r) => r.source === "kometa") || choices[0];
      if (!picked) { absent.push(name); continue; }
      const filter = { ...picked, no_rank: !!a.rank_max && !picked.ranked, members: new Map() };
      if (picked.source === "mdblist") {
        const members = settings().clerk_lists === true ? await listSource().members({ id: picked.id, ...(a.rank_max && picked.ranked ? { rank_max: a.rank_max } : {}) }) : [];
        filter.members = new Map(members.map((m) => [String(m.key), m]));
      }
      if (!filters.some((f) => f.source === filter.source && f.id === filter.id && sameName(f.name, filter.name))) filters.push(filter);
    }
    const score = (candidate) => absent.reduce((best, name) => Math.max(best, norm(name).split(" ").filter((w) => w.length > 2 && norm(candidate.name).split(" ").includes(w)).length), 0);
    return { filters, missing: !!absent.length || !!a.rank_max && !filters.length,
      suggestions: available.filter((r) => score(r) > 0).sort((x, y) => score(y) - score(x)).slice(0, 3) };
  }
  function shelfMatches(r, filter) {
    return filter.source === "mdblist" ? filter.members.has(String(r.key)) || r.type === "episode" && filter.members.has(String(r.show_key))
      : (r.shelves || []).some((name) => sameName(name, filter.name));
  }
  function provenance(row, filters) {
    if (!filters.length) return row;
    const f = filters[0], member = f.members.get(String(row.key)) || f.members.get(String(row.show_key));
    const shelf = { ...(f.id ? { id: f.id } : {}), name: f.name, source: f.source, ranked: !!f.ranked,
      ...(f.ranked && member && member.rank > 0 && (!row.keys || row.keys.length === 1) ? { rank: member.rank } : {}) };
    return { ...row, shelf, shelves: [...new Set([f.name, ...(row.shelves || [])])].slice(0, 3), ...(filters.some((x) => x.no_rank) ? { no_rank: true } : {}) };
  }
  const requestSource = () => requests || require("./mediarequests");
  const vectorSource = () => vectors || require("./plexvectors");
  const seerrCache = new Map(), SEERR_MS = 2000, CACHE_MS = 24 * 3600 * 1000;
  const FAMILY_MAX = 40;   // 1.99amq plexfind recall: a franchise's shows checked for one episode title (prod's "Star Trek": 14 shows)
  async function bounded(fn, deadline) {
    const ms = Math.max(0, deadline - Date.now());
    if (!ms) return null;
    let timer;
    try { return await Promise.race([Promise.resolve().then(fn).catch(() => null), new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); })]); }
    finally { clearTimeout(timer); }
  }
  // Cache only public title/availability fields, never posters, overviews, raw upstream errors or request rights.
  // 1.99?? clerkreq S4: -> the cached entry | {miss: "off" (not allowed here / requests off or not configured) | "none" | "down" (a
  // timeout or an error)} - a Seerr that didn't answer was a silent null, the same as "no such title"
  const seerrOff = (e) => !!(e && e.refuse && !e.upstream && (e.status === 403 || e.status === 503));
  async function seerrSearch(title, context, deadline) {
    if (!context.allowSeerr) return { miss: "off" };
    const key = norm(title);
    if (!title || !key) return { miss: "none" };
    const cached = seerrCache.get(key);
    if (cached && now() - cached.at < CACHE_MS) { seerrCache.delete(key); seerrCache.set(key, cached); return cached; }
    let failure = null;
    const found = await bounded(() => Promise.resolve().then(() => requestSource().search(context.user || null, title))
      .catch((e) => { failure = e || {}; return null; }), deadline);
    if (!Array.isArray(found)) return { miss: seerrOff(failure) ? "off" : "down" };
    const entry = { at: now(), rows: found.filter((r) => r && ["movie", "tv"].includes(r.type) && /^[1-9]\d{0,8}$/.test(String(r.tmdb)))
      .slice(0, 20).map((r) => ({ kind: r.type, tmdb: Number(r.tmdb), title: clean(r.title), year: integer(Number(r.year), 1880, 2200),
        availability: ["unknown", "pending", "processing", "partial", "available", "blocked", "deleted"].includes(r.availability) ? r.availability : "unknown",
        media_status: Number(r.media_status) || 1 })), details: new Map() };
    seerrCache.delete(key); seerrCache.set(key, entry);
    while (seerrCache.size > 500) seerrCache.delete(seerrCache.keys().next().value);
    return entry;
  }
  async function seerrDetails(entry, row, deadline) {
    const key = `${row.kind}:${row.tmdb}`;
    if (entry.details.has(key)) return entry.details.get(key);
    const d = await bounded(() => requestSource().details(row.kind, row.tmdb), deadline);
    if (!d || Number(d.tmdb) !== row.tmdb || d.type !== row.kind || !sameName(d.title, row.title)) return null;
    const value = { title: clean(d.title), year: integer(Number(d.year), 1880, 2200), media_status: Number(d.media_status) || 1,
      seasons: (Array.isArray(d.seasons) ? d.seasons : []).filter((s) => integer(s.n, 1, 200) != null && integer(s.episodes, 0, 2000) != null)
        .map((s) => ({ n: s.n, episodes: s.episodes, status: Number(s.status) || 1 })) };
    entry.details.set(key, value); return value;
  }
  const gated = (r) => r.media_status === 5 || r.media_status === 6 || r.availability === "available";
  /** -> null (no lookup for it) | {miss: off | none | down} | {unavailable} | {requested, title, year, kind, season?} |
   *  {choices: [{title, year, kind, tmdb, media_status}] (2-3)} | the one title {title, year, kind, tmdb, availability, season?} */
  async function missingTitle(want, context, deadline) {
    if (want.recall && want.kind === "movie" && want.year == null) return null;
    const title = clean(want.kind === "episode" ? want.show : want.title);
    const entry = await seerrSearch(title, context, deadline);
    if (entry.miss) return entry;
    const kind = want.kind === "movie" ? "movie" : ["show", "episode"].includes(want.kind) ? "tv" : null;
    let matches = entry.rows.filter((r) => (!kind || r.kind === kind) && sameName(r.title, title)
      && (want.year == null || r.year != null && Math.abs(r.year - want.year) <= (r.kind === "movie" ? 1 : 0)));
    if (!matches.length) return { miss: "none" };
    // Never turn an ambiguous external title into a request. 1.99?? clerkreq S3 (owner 2026-11-08: "The Good Doctor" matched both the 2017
    // series and the 2013 "Good Doctor" - a silent null, "nothing on the shelves fits that"): the one whose name, its article kept, is the
    // name said; then the very year said (a film's ±1 let two in); still several = the speaker's choice, never a guess
    if (matches.length > 1) {
      const said = keptOf(title), kept = matches.filter((r) => keptOf(r.title) === said);
      if (kept.length) matches = kept;
      if (matches.length > 1 && want.year != null) { const year = matches.filter((r) => r.year === want.year); if (year.length) matches = year; }
    }
    if (matches.length > 1) {
      // an already-available one is never offered or named (it may be a title the library keeps out of the clerk's sections)
      const open = matches.filter((r) => !gated(r));
      if (!open.length) return { unavailable: true };
      if (open.length > 1) {
        if (want.kind === "episode") return { miss: "none" };   // which show's episode? the recall's own "which one?" asks
        return { choices: open.slice(0, 3).map((r) => ({ title: r.title, year: r.year, kind: r.kind, tmdb: r.tmdb, media_status: r.media_status })) };
      }
      matches = open;
    }
    const row = matches[0];
    if (gated(row)) return { unavailable: true };
    // 1.99?? clerkreq S3: a film Seerr already has a request for (pending / processing) - said, never offered (request() refuses it at the yes)
    if (row.kind === "movie" && (row.media_status === 2 || row.media_status === 3)) return { requested: true, title: row.title, year: row.year, kind: "movie" };
    if (want.kind === "episode") {
      if (integer(want.season, 1, 200) == null || integer(want.episode, 1, 2000) == null) return { miss: "none" };
      const d = await seerrDetails(entry, row, deadline);
      if (!d || want.year != null && d.year !== want.year) return { miss: "none" };
      const season = d.seasons.find((s) => s.n === want.season && s.episodes >= want.episode);
      if (!season) return { miss: "none" };
      if (d.media_status === 5 || d.media_status === 6 || season.status === 5) return { unavailable: true };
      return { title: d.title, year: d.year, kind: row.kind, season: want.season, tmdb: row.tmdb, availability: row.availability };
    }
    if (row.kind === "tv" && integer(want.season, 1, 200) != null) {
      // 1.99?? clerkreq: a season asked for by number ("!plex request <show> season 3", "pepe play <show> season 3" the library lacks):
      // that season, as Seerr knows it - on its way already (pending / processing / partly in) is said, never offered again
      const d = await seerrDetails(entry, row, deadline);
      if (!d || want.year != null && d.year !== want.year) return { miss: "none" };
      const season = d.seasons.find((s) => s.n === want.season);
      if (!season) return { miss: "none" };
      if (d.media_status === 5 || d.media_status === 6 || season.status === 5) return { unavailable: true };
      if ([2, 3, 4].includes(season.status)) return { requested: true, title: d.title, year: d.year, kind: "tv", season: want.season };
      return { title: d.title, year: d.year, kind: row.kind, season: want.season, tmdb: row.tmdb, availability: row.availability };
    }
    return { title: row.title, year: row.year, kind: row.kind, tmdb: row.tmdb, availability: row.availability };
  }
  /** 1.99?? clerkreq S4: what a missingTitle answer says of Seerr - ok (it answered about the title) | none | down | off */
  const stateOf = (found) => (found && found.miss ? found.miss : "ok");
  const deepLimits = () => deepMax || require("./plexpad").DEEP_MAX;
  const effectiveRating = (r, parents) => String(r.content_rating || (r.type === "episode" && parents.get(String(r.show_key)) || {}).content_rating || "").replace(/^[A-Za-z]{2}\/\s*/, "");   // 1.99alq train3 verify: never a country prefix ("gb/R18")
  const allowed = (r, sections, s, parents = new Map()) => !!r && KEY.test(String(r.key)) && sections.has(String(r.section))
    && ["movie", "show", "episode"].includes(r.type) && !ratingNames(s.clerk_block_ratings == null ? "X,XXX,AO,R18,R18+" : s.clerk_block_ratings).has(String(effectiveRating(r, parents)).toUpperCase())
    && (r.type !== "episode" || (parents.has(String(r.show_key)) && parents.get(String(r.show_key)).type === "show"
      && String(parents.get(String(r.show_key)).section) === String(r.section) && allowed(parents.get(String(r.show_key)), sections, s)));
  const deep = (r) => !(Number(r.pad_plays) > 0) && (r.server_plays == null || Number(r.server_plays) <= deepLimits()[r.type === "movie" ? "movie" : "show"]);
  function warn(r, s, parents) {
    const cr = String(effectiveRating(r, parents)).toUpperCase();
    if (cr === "NC-17") return "nc17";
    if ((!cr && r.type === "movie") || ratingNames(s.clerk_warn_ratings == null ? "NR,Not Rated,Unrated" : s.clerk_warn_ratings).has(cr)) return "unrated";
    return null;
  }
  function matches(r, a, seen, parents) {
    const p = r.type === "episode" ? parents.get(String(r.show_key)) : null;
    const inherited = (field) => (r[field] && r[field].length ? r[field] : p && p[field]) || [];
    if (a.year != null && Number(r.year || p && p.year) !== a.year) return false;
    if (a.years && !(Number(r.year || p && p.year) >= a.years[0] && Number(r.year || p && p.year) <= a.years[1])) return false;
    if (!a.genres.every((g) => inherited("genres").some((x) => sameName(x, g)))) return false;
    if (a._shelfFilters ? !a._shelfFilters.every((f) => shelfMatches(r, f) || p && shelfMatches(p, f)) : !a.shelves.every((g) => inherited("shelves").some((x) => sameName(x, g)))) return false;
    if (!a.people.every((person) => [...inherited("cast"), ...inherited("directors")].some((x) => titleMatch(x, person)))) return false;
    if (a.studio && !sameName(r.studio || p && p.studio, a.studio)) return false;
    if (a.min_minutes != null && duration(r) < a.min_minutes * 60) return false;
    if (a.max_minutes != null && (!duration(r) || duration(r) > a.max_minutes * 60)) return false;
    if (a.unseen && seen.has(String(r.key))) return false;
    if (a.deep_cut && !deep(r)) return false;
    const floor = a.quality === "best" ? 7.5 : a.quality === "good" ? 6.5 : null;
    return floor == null || (rating(r) != null && rating(r) >= floor);
  }
  function shuffled(rows, quality, count = 20) {
    const pool = rows.slice(), out = [], weights = pool.map((r) => quality === "any" ? 1 : Math.max(1, Math.round((rating(r) || 0) * 100)));
    let total = weights.reduce((a, b) => a + b, 0);
    while (pool.length && out.length < count) {
      let i;
      if (quality === "any") i = rng(pool.length);
      else {
        let draw = rng(total);
        i = 0;
        while (i < weights.length - 1 && draw >= weights[i]) draw -= weights[i++];
      }
      total -= weights.splice(i, 1)[0];
      out.push(pool.splice(i, 1)[0]);
    }
    return out;
  }
  function showLabel(r, parents, collisions = new Set()) {
    const parent = parents.get(String(r.show_key)) || {}, title = parent.title || r.show || "";
    return `${title}${collisions.has(norm(title)) && parent.year ? ` (${parent.year})` : ""}`;
  }
  function single(r, why, exact, s, parents, collisions) {
    const parent = r.type === "episode" ? parents.get(String(r.show_key)) || {} : null;
    const label = r.type === "episode" ? `${showLabel(r, parents, collisions)} S${r.season == null ? 0 : r.season}E${r.episode == null ? 0 : r.episode}${r.title ? ` "${r.title}"` : ""}`
      : `${r.title}${r.year ? ` (${r.year})` : ""}`;
    return { key: String(r.key), kind: r.type, type: r.type, title: r.title, label: clean(label, 120), year: r.year || null,
      show: r.show || null, season: r.season == null ? null : r.season, episode: r.episode == null ? null : r.episode,
      ...(parent ? { show_key: String(r.show_key), show_year: parent.year || null } : {}),
      duration: duration(r), minutes: Math.ceil(duration(r) / 60), genres: (r.genres || []).slice(0, 3), shelves: (r.shelves || []).slice(0, 3),
      rating: rating(r), deep_cut: deep(r), snippet: clean(r.summary, 200), why, exact: !!exact,
      warn: warn(r, s, parents), scope: r.type === "episode" ? "episode" : "title" };
  }
  async function fresh(keys) {
    const state = await catalog.status();
    if (!state.ready) return { state, rows: [], parents: new Map(), s: settings() };
    const rows = await catalog.getByKeys(keys);
    const parentKeys = [...new Set(rows.filter((r) => r.type === "episode" && r.show_key).map((r) => String(r.show_key)))];
    const parents = new Map((await catalog.getByKeys(parentKeys)).map((r) => [String(r.key), r]));
    const s = settings(), sections = new Set((state.sections || []).filter((x) => x.policy === "allowed").map((x) => String(x.id)));
    return { state, s, parents, rows: rows.filter((r) => allowed(r, sections, s, parents)) };
  }
  async function validateKeys(keys) {
    if (!Array.isArray(keys) || !keys.length || keys.length > 200 || keys.some((k) => !KEY.test(String(k)))) throw new ClerkError("not_found", "That isn't available here.", 404);
    const data = await fresh(keys.map(String));
    const by = new Map(data.rows.filter((r) => ["movie", "episode"].includes(r.type)).map((r) => [String(r.key), r]));
    if (!data.state.ready || keys.some((key) => !by.has(String(key)))) throw new ClerkError("not_found", "That isn't available here.", 404);
    return keys.map((key) => by.get(String(key)));
  }
  async function verifyRecall(guesses, roots, safe) {
    const records = [], candidates = [], missing = [];
    for (const [index, g] of guesses.entries()) {
      if (!g || !["movie", "show", "episode"].includes(g.kind) || typeof g.confidence !== "number" || !Number.isFinite(g.confidence) || g.confidence < .5) continue;
      const record = { guess: index, status: "unknown" }; records.push(record);
      const title = clean(g.kind === "episode" ? g.show : g.title), year = integer(g.year, 1880, 2200);
      if (!norm(title)) continue;
      // IDs are hints only. Exact names and numbers decide; a valid ID can never override a mismatch.
      if (g.kind === "movie") {
        const hits = roots.filter((r) => r.type === "movie" && sameName(r.title, title) && (year == null || Math.abs(Number(r.year) - year) <= 1));
        if (!hits.length) { missing.push({ record, want: { kind: "movie", title, year, recall: true } }); continue; }
        record.status = "in"; record.match = year == null ? "partial" : "exact";
        if (hits.length === 1) record.key = String(hits[0].key);
        candidates.push(...hits.map((r) => ({ r, why: record.match === "exact" ? "recall" : "guess", exact: record.match === "exact", guess: index })));
        continue;
      }
      // 1.99amq plexfind recall (owner 2026-11-08): an EPISODE guess's year may be the episode's own air year (a model gives Darmok's
      // 1991 for The Next Generation, 1987) - it was compared with the show's year only, so the right episode came back "unknown".
      // The show's year or the episode's (its year / aired, a year either way) both fit; a show guess still needs the show's year.
      const episodeYear = (show, r) => year == null || Number(show.year) === year
        || [Number(r.year), Number(String(r.aired || "").slice(0, 4))].some((y) => y > 0 && Math.abs(y - year) <= 1);
      const shows = roots.filter((r) => r.type === "show" && sameName(r.title, title) && (year == null || g.kind === "episode" || Number(r.year) === year));
      let hits = [], mismatch = false;
      const season = integer(g.season, 0, 200), episode = integer(g.episode, 1, 2000), episodeTitle = clean(g.episode_title);
      for (const show of shows) {
        const eps = safe(await catalog.rows({ kind: "episode", show_key: String(show.key) })).filter((r) => g.kind !== "episode" || episodeYear(show, r)).sort(episodeOrder);
        if (g.kind === "show") { if (eps.length) hits.push({ r: eps.find((r) => Number(r.season) === 1 && Number(r.episode) === 1) || eps[0], match: "partial" }); continue; }
        const named = episodeTitle ? eps.filter((r) => sameName(r.title, episodeTitle)) : [];
        if (season != null && episode != null) {
          const numbered = eps.find((r) => Number(r.season) === season && Number(r.episode) === episode);
          if (!numbered) continue;
          if (!episodeTitle || sameName(numbered.title, episodeTitle)) hits.push({ r: numbered, match: "exact" });
          else if (named.length) hits.push(...named.map((r) => ({ r, match: "partial" })));
          else mismatch = true;
        } else if (season == null && episode == null && named.length) hits.push(...named.map((r) => ({ r, match: "partial" })));
      }
      // 1.99amq plexfind recall: the franchise's name ("Star Trek" for The Next Generation, "The Office" for The Office (US)) - when the
      // named shows have no such episode, the shows whose title starts with that name (whole words) are its family: exactly ONE of
      // their episodes with that episode title (and the guessed numbers and year, when given) verifies; two or more stay unverified.
      if (!hits.length && g.kind === "episode" && episodeTitle) {
        const base = norm(title), family = roots.filter((r) => r.type === "show" && norm(r.title).startsWith(base + " "));
        if (family.length && family.length <= FAMILY_MAX) {
          const byShow = new Map(family.map((r) => [String(r.key), r]));
          const pool = typeof catalog.byTitle === "function" ? safe(await catalog.byTitle(episodeTitle, { kind: "episode" }))
            : (await Promise.all(family.map((show) => catalog.rows({ kind: "episode", show_key: String(show.key) })))).flatMap((rows) => safe(rows));
          const found = pool.filter((r) => byShow.has(String(r.show_key)) && sameName(r.title, episodeTitle)
            && (season == null || Number(r.season) === season) && (episode == null || Number(r.episode) === episode) && episodeYear(byShow.get(String(r.show_key)), r));
          if (found.length === 1) { hits.push({ r: found[0], match: season != null && episode != null ? "exact" : "partial" }); mismatch = false; }
        }
      }
      if (hits.length) {
        record.status = "in"; record.match = hits.every((hit) => hit.match === "exact") ? "exact" : "partial";
        if (hits.length === 1) record.key = String(hits[0].r.key);
        candidates.push(...hits.map((hit) => ({ r: hit.r, why: hit.match === "exact" ? "recall" : "guess", exact: hit.match === "exact", guess: index })));
      } else if (mismatch) record.status = "mismatch";
      else missing.push({ record, want: { kind: g.kind, ...(g.kind === "episode" ? { show: title, season, episode } : { title }), year } });
    }
    return { records, candidates, missing };
  }
  async function find(request = {}, context = {}) {
    context = { ...context, allowSeerr: context.allowSeerr === true && request.probe !== true };
    const state = await catalog.status();
    const base = { rows: [], exact: false, recall: [], catalog: { ready: !!state.ready, at: state.at || null } };
    if (!state.ready) return base;
    const a = askOf(request.ask), s = settings();
    const browse = request.browse === true || a.action === "browse";
    const limit = Math.max(1, Math.min(browse ? 3 : 20, Math.floor(Number(request.limit) || (browse ? 3 : 20))));
    const exclude = new Set((Array.isArray(request.exclude) ? request.exclude : []).slice(0, 40).map(String));
    const seen = new Set((context.seenKeys || []).map(String));
    const sections = new Set((state.sections || []).filter((x) => x.policy === "allowed").map((x) => String(x.id)));
    // 1.99amh plexclerk: the films and shows come from the catalog's kept roots (one indexed read per catalog version) - two
    // whole-kind reads per find were each past the read budget at the real library's size (too_broad -> catalog_down)
    const [movies, shows] = typeof catalog.roots === "function" ? await catalog.roots().then((r) => [r.movies, r.shows])
      : await Promise.all([catalog.rows({ kind: "movie" }), catalog.rows({ kind: "show" })]);
    // "is this whole line an episode's title?" - the title index when the catalog has one (an OR word search over every episode
    // took 1.8 s on prod), else the word search filtered to whole-title matches
    const episodesTitled = async (title) => safe(typeof catalog.byTitle === "function" ? await catalog.byTitle(title, { kind: "episode" })
      : await catalog.search(title, { kind: "episode", limit: 500, budgetMs: 400 })).filter((r) => sameName(r.title, title));
    const parents = new Map(shows.map((r) => [String(r.key), r]));
    const safe = (rows) => rows.filter((r) => allowed(r, sections, s, parents) && !exclude.has(String(r.key)));
    const raw = clean(request.raw).replace(/^!(?:plex|watch)\s+/i, "").replace(/^(?:pepe[,!:]?\s+)?(?:please\s+)?(?:play|watch|put on|show me)\s+/i, "");
    const roots = safe([...movies, ...shows]);
    let reference = null;
    if (a.like) {
      const references = roots.filter((r) => sameName(r.title, a.like));
      if (references.length !== 1) return base;
      reference = references[0]; exclude.add(String(reference.key));
      if (!a.kind) a.kind = reference.type;
    }
    const similarity = (r) => {
      if (!reference) return 0;
      const row = r.type === "episode" ? parents.get(String(r.show_key)) || r : r;
      return (reference.genres || []).filter((g) => (row.genres || []).some((v) => sameName(v, g))).length * 3
        + (reference.shelves || []).filter((g) => (row.shelves || []).some((v) => sameName(v, g))).length * 2
        + (reference.year && row.year && Math.floor(reference.year / 10) === Math.floor(row.year / 10) ? 1 : 0);
    };
    // 1.99?? clerkreq S1 (owner 2026-11-08 13:48 ET: "pepe play the tv series The Good Doctor" -> another show's S1E9 called "The Good
    // Doctor"): a SHOW or a FILM ask never takes an episode that only shares the name - those are kept aside (namedEpisodes: the answer's
    // episode_named, never a candidate, never exact) and the title goes to Seerr. A title-level ask (request_offer) the same, whatever
    // its kind. A bare line that only an episode's title matches is that episode, but never "exact" (episodeNamed: why episode_named) -
    // it may be a show or a film we don't carry (Seerr is asked beside it, S2); an EPISODE ask keeps it as before.
    const askedKind = a.kind, titleLevel = request.titleLevel === true;
    const titleKind = askedKind === "show" || askedKind === "movie" || titleLevel;
    let namedEpisodes = [], episodeNamed = false;
    // 1.99?? clerkreq review F6: a film Plex keeps as a show's special (S00 "Big Score Movie") IS that film for a film ask or a
    // title-level one (the request) - offered as itself, never kept aside and never a request for something already here
    const filmSpecials = new Set();
    const episodesFor = async (title) => {
      const eps = await episodesTitled(title);
      if (titleKind) {
        const films = askedKind === "show" ? [] : eps.filter((r) => (Number(r.season) || 0) === 0);
        for (const r of films) filmSpecials.add(String(r.key));
        if (!namedEpisodes.length) namedEpisodes = eps.filter((r) => !filmSpecials.has(String(r.key)));
        return films;
      }
      if (eps.length && askedKind == null) episodeNamed = true;
      return eps;
    };
    let exactRows = raw ? roots.filter((r) => sameName(r.title, raw)) : [];
    if (!exactRows.length && raw) exactRows = await episodesFor(raw);
    const literal = exactRows.length > 0;
    if (literal) {
      const kinds = [...new Set(exactRows.map((r) => r.type))];
      // A literal whole title outranks every inferred selector (including a mistaken kind or a year inside its name).
      Object.assign(a, askOf({ title: exactRows[0].title, kind: kinds.length === 1 ? kinds[0] : null }));
    }
    const shelfSelection = await shelfFilters(a, raw, roots, literal);
    if (shelfSelection.missing) return { ...base, shelf_missing: true, shelf_suggestions: shelfSelection.suggestions };
    a._shelfFilters = shelfSelection.filters;
    a.shelves = shelfSelection.filters.map((f) => f.name);
    // (S1: "filter by kind as well" - "the movie <a show's name>" is not that show's exact row)
    if (!exactRows.length && a.title) exactRows = roots.filter((r) => sameName(r.title, a.title) && !(["show", "movie"].includes(askedKind) && r.type !== askedKind));
    if (!exactRows.length && a.title) exactRows = await episodesFor(a.title);
    const exact = !episodeNamed && (literal || (exactRows.length > 0 && a.select === "one" && !a.about && !a.like));
    const verified = literal ? { records: [], candidates: [], missing: [] } : await verifyRecall(a.guesses, roots, safe);
    verified.candidates = verified.candidates.filter((x) => matches(x.r, { ...a, title: null, year: null, years: null, about: null, like: null,
      quality: a.quality === "best" && x.r.type === "episode" && rating(x.r) == null ? "any" : a.quality }, seen, parents));
    const recall = verified.records, recalled = recall.length > 0;
    let seerr = null, seerrState = null, seerrChoices = null, seerrRequested = null;
    // 1.99?? clerkreq S3/S4: what one missingTitle answer leaves - its state, a choice for the speaker, an already-requested title
    const took = (found) => {
      if (!found) return;
      seerrState = stateOf(found);
      if (found.choices) seerrChoices = found.choices;
      if (found.requested) seerrRequested = { title: found.title, year: found.year, kind: found.kind, ...(found.season != null ? { season: found.season } : {}) };
    };
    if (recalled && !verified.candidates.length && verified.missing.length) {
      const first = verified.missing[0], found = await missingTitle(first.want, context, Date.now() + SEERR_MS);
      if (found && found.unavailable) return { ...base, code: "unavailable" };
      took(found);
      if (found && found.tmdb) { first.record.status = "missing"; first.record.seerr = found; seerr = found; }
    }
    let clearKey = null;   // 1.99amq clerkfast: the one episode the description singles out (describedOnce), if any
    // (1.99?? clerkreq S1: an episode only its own title named - a bare line - is offered as episode_named, never exact)
    let candidates = recalled ? verified.candidates : exactRows.filter((r) => r.type === "episode" && (!titleKind || filmSpecials.has(String(r.key))) && matches(r, a, seen, parents))
      .map((r) => ({ r, why: episodeNamed ? "episode_named" : "exact", exact })), plans = [], alternatives = [];
    const selectionList = ["first_n", "last_n", "season", "series", "in_order"].includes(a.select) || (a.select === "one" && a.season != null && a.episode == null);
    const makePlan = (rows, why, show, scope = "list", alternative = false) => {
      if (!rows.length) return;
      const maxItems = Math.max(1, Math.min(200, Number(s.library_queue_max_items) || 60));
      const maxSec = Math.min((Number(s.library_queue_max_hours) || 12) * 3600, context.maxSec == null ? Infinity : Math.max(0, Number(context.maxSec) || 0));
      const kept = []; let total = 0;
      for (const r of rows) { if (kept.length >= maxItems || total + duration(r) > maxSec) break; kept.push(r); total += duration(r); }
      if (!kept.length) return;
      (alternative ? alternatives : plans).push({ keys: kept.map((r) => String(r.key)), why, show, scope, requested: rows.length, alternative, season: kept[0].season });
    };
    const exactShows = exactRows.filter((r) => r.type === "show");
    const wantedShows = recalled || a.kind === "movie" ? [] : (exactShows.length ? exactShows : roots.filter((r) => r.type === "show" && !exclude.has(String(r.key)) && (a.title ? titleMatch(r.title, a.title)
      : (a.kind === "show" || a.shelves.length > 0) && matches(r, { ...a, min_minutes: null, max_minutes: null }, seen, parents))));
    if (wantedShows.length) {
      for (const show of wantedShows.slice(0, 5)) {
        let eps = safe(await catalog.rows({ kind: "episode", show_key: String(show.key) })).filter((r) => (a.season === 0 || Number(r.season) !== 0) && (!reference || similarity(r) > 0) && matches(r, { ...a, year: null, years: null }, seen, parents)).sort(episodeOrder);
        if (a.year != null && Number(show.year) !== a.year) continue;
        const available = eps.slice();
        const offerSeasons = () => {
          for (const sn of [...new Set(available.map((r) => Number(r.season)))].sort((x, y) => x - y)) makePlan(available.filter((r) => Number(r.season) === sn), "filter", show, "season", true);
        };
        if (a.season != null) eps = eps.filter((r) => Number(r.season) === a.season);
        if (a.episode != null) eps = eps.filter((r) => Number(r.episode) === a.episode && (a.season != null || Number(r.season) === 1));
        if (a.about) {
          // 1.99amq clerkfast: a single pick in the word search's own (bm25) order - re-sorted into season order, the best hit was
          // wherever it aired. review F1: ONLY a single pick - a selection word (latest / finale / pilot / oldest / first or last N /
          // in order / a season) orders the matches by air date as before ("the newest Halloween episode" took the worst word hit)
          const single = a.select === "one" && !selectionList;
          const rank = new Map();
          (await catalog.search(a.about, { kind: "episode", show_key: String(show.key), limit: 500, budgetMs: 400 }))
            .forEach((r, i) => { if (!rank.has(String(r.key))) rank.set(String(r.key), i); });
          eps = eps.filter((r) => rank.has(String(r.key)));
          if (single) eps.sort((x, y) => rank.get(String(x.key)) - rank.get(String(y.key)));
          // one show, a first ask (a reroll's excluded rows would make the rest look unique), a single pick
          if (wantedShows.length === 1 && !exclude.size && single) {
            const once = describedOnce(a.about, show, available);
            if (once && eps.some((r) => String(r.key) === once)) clearKey = once;
          }
        }
        if (!eps.length) { offerSeasons(); continue; }
        if (a.select === "random") candidates.push(...(a.title && wantedShows.length > 1 ? shuffled(eps, a.quality, 1) : eps).map((r) => ({ r, why: "random", exact: false })));
        else if (selectionList) {
          if (a.select === "season" && a.season == null) {
            const last = Math.max(...eps.map((r) => Number(r.season) || 0)); eps = eps.filter((r) => Number(r.season) === last);
          }
          if (a.select === "first_n") eps = eps.slice(0, a.n || 1);
          if (a.select === "last_n") eps = eps.slice(-(a.n || 1));
          makePlan(eps, "list", show, a.select === "series" ? "series" : a.select === "season" || a.season != null ? "season" : "list");
        } else {
          let selected;
          if (a.select === "latest") selected = [eps[eps.length - 1]];
          else if (a.select === "finale") { const sn = a.season == null ? Math.max(...eps.map((r) => Number(r.season) || 0)) : a.season; selected = [eps.filter((r) => Number(r.season) === sn).at(-1)]; }
          else if (a.select === "pilot") selected = [eps.find((r) => Number(r.season) === 1 && Number(r.episode) === 1) || eps[0]];
          else if (a.about) selected = eps;
          else if (a.quality === "best") selected = eps.filter((r) => rating(r) != null).sort((x, y) => rating(y) - rating(x));
          else if (reference) selected = eps.slice(0, 1);
          else if (a.episode != null || a.select === "oldest" || (a.kind !== "episode" && !a.like && !a.guesses.length && !a.genres.length && !a.people.length && !a.studio && !a.shelves.length && a.quality === "any")) selected = [eps[0]];
          else selected = [];
          if (!selected.length) offerSeasons();
          candidates.push(...selected.filter(Boolean).map((r) => ({ r, why: a.about ? "fts" : a.select === "latest" || a.select === "finale" ? "latest" : a.select === "oldest" || a.select === "pilot" ? "oldest" : "exact", exact })));
        }
      }
    }
    let films = recalled ? [] : safe(movies).filter((r) => (!reference || similarity(r) > 0) && matches(r, a, seen, parents));
    if (a.title) films = films.filter((r) => titleMatch(r.title, a.title) || (r.shelves || []).some((name) => titleMatch(name, a.title)));
    if (literal) films = films.filter((r) => exactRows.some((x) => x.key === r.key));
    else if (exact && exactRows.some((r) => r.type === "movie")) films = films.filter((r) => exactRows.some((x) => x.key === r.key));
    const filmsWanted = a.kind !== "show" && a.kind !== "episode" && (!a.title || !wantedShows.length || a.kind === "movie" || exactRows.some((r) => r.type === "movie"));
    // 1.99amh plexclerk: the films' word search only when films can be offered (a verified recall, an episode or a show ask
    // never uses them - it was a whole-library search the answer threw away)
    if (a.about && filmsWanted && films.length) {
      const hits = new Set((await catalog.search(a.about, { kind: "movie", limit: 500, budgetMs: 400 })).map((r) => String(r.key)));
      films = films.filter((r) => hits.has(String(r.key)));
    }
    if (!recalled && a.kind === "episode" && !wantedShows.length && !a.title && !a.about) {
      const eps = safe(await catalog.rows({ kind: "episode" })).filter((r) => (a.season === 0 || Number(r.season) !== 0) && matches(r, a, seen, parents));
      candidates.push(...eps.sort(episodeOrder).map((r) => ({ r, why: a.select === "random" ? "random" : "filter", exact: false })));
    }
    if (filmsWanted) {
      films.sort(movieOrder);
      if (selectionList && films.length) {
        if (a.select === "first_n") films = films.slice(0, a.n || 1);
        if (a.select === "last_n") films = films.slice(-(a.n || 1));
        makePlan(films, "list", null);
      } else {
        if (browse && !a.title && a.select === "latest") films.sort((x, y) => (Number(y.added) || 0) - (Number(x.added) || 0));
        else if (["latest", "finale"].includes(a.select)) films = films.slice(-1);
        else if (["oldest", "pilot"].includes(a.select)) films = films.slice(0, 1);
        else if (a.select === "random") { /* shuffled with every other eligible candidate below */ }
        else films.sort((x, y) => (reference ? similarity(y) - similarity(x) : 0) || (a.popular ? (Number(y.server_plays) || 0) - (Number(x.server_plays) || 0) : 0) || (rating(y) || 0) - (rating(x) || 0));
        const why = exact ? "exact" : a.select === "random" ? "random" : a.select === "latest" ? "latest" : a.select === "oldest" ? "oldest" : a.about ? "fts" : a.shelves.length ? "shelf" : "filter";
        candidates.push(...films.map((r) => ({ r, why, exact })));
      }
    }
    const recallHasVariants = (list) => {
      const variants = new Map();
      for (const candidate of list) {
        if (candidate.guess == null) continue;
        if (!variants.has(candidate.guess)) variants.set(candidate.guess, new Set());
        variants.get(candidate.guess).add(String(candidate.r.key));
      }
      return [...variants.values()].some((keys) => keys.size > 1);
    };
    // A guessed title with multiple editions is a choice for the speaker, not a franchise list to queue together.
    if (recalled && selectionList && candidates.length && candidates.every((x) => x.r.type === "movie") && !recallHasVariants(candidates)) {
      makePlan(candidates.map((x) => x.r).sort(movieOrder), "list", null);
      candidates = [];
    }
    // A vector is a candidate source only. Resolve one show and apply every ordinary
    // filter before the vector service sees any keys; never scan episodes globally.
    const embedOn = [true, "true", "1", 1].includes(s.clerk_embed);
    if (embedOn && request.qvec && !exact && a.select === "one" && !selectionList && a.episode == null
        && !seerr && !recall.some((record) => record.status === "in" || record.status === "missing")) {
      const started = performance.now();
      let pool = [], kind = "movie", showKey = null;
      const guessedNames = [...new Set(a.guesses.filter((guess) => guess && guess.kind === "episode" && norm(guess.show)).map((guess) => norm(guess.show)))];
      const vectorShows = a.kind === "movie" ? [] : (exactShows.length ? exactShows : roots.filter((row) => row.type === "show"
        && (a.title ? titleMatch(row.title, a.title) : guessedNames.length === 1 && norm(row.title) === guessedNames[0])))
        .filter((row) => (a.year == null || Number(row.year) === a.year) && (!a.years || Number(row.year) >= a.years[0] && Number(row.year) <= a.years[1]));
      if (vectorShows.length === 1) {
        kind = "episode"; showKey = String(vectorShows[0].key);
        pool = safe(await catalog.rows({ kind, show_key: showKey })).filter((row) => (a.season === 0 || Number(row.season) !== 0)
          && (a.season == null || Number(row.season) === a.season) && (!reference || similarity(row) > 0)
          && matches(row, { ...a, year: null, years: null }, seen, parents));
      } else if (!vectorShows.length && a.kind !== "show" && a.kind !== "episode") {
        pool = safe(movies).filter((row) => (!reference || similarity(row) > 0) && matches(row, a, seen, parents)
          && (!a.title || titleMatch(row.title, a.title) || (row.shelves || []).some((name) => titleMatch(name, a.title))));
      }
      // plexvectors 1.99amo: was 20,000 films - every film that passes the filters at prod's size (30,682) skipped the vectors
      if (pool.length && pool.length <= (kind === "episode" ? MAX_EPISODES : MAX_MOVIES)) {
        const byKey = new Map(pool.map((row) => [String(row.key), row]));
        try {
          let wordHits = candidates.filter((candidate) => candidate.why === "fts" && byKey.has(String(candidate.r.key))).map((candidate) => String(candidate.r.key));
          // Failed recalls deliberately had no phase-2a candidates; recover their
          // scoped word hits without making an unknown guess a verified title.
          const query = a.about || raw;
          if (!wordHits.length && query) wordHits = (await catalog.search(query, { kind, ...(showKey ? { show_key: showKey } : {}), limit: 500,
            budgetMs: Math.max(1, 400 - (performance.now() - started)) })).map((row) => String(row.key)).filter((key) => byKey.has(key));
          const budget = 400 - (performance.now() - started);
          const hits = budget > 0 ? await vectorSource().nearest({ qvec: request.qvec, kind, ...(showKey ? { show_key: showKey } : {}),
            keys: [...byKey.keys()], limit: Math.max(20, Math.min(50, Number(s.clerk_embed_k) || 30)), budgetMs: budget }) : [];
          const vectorHits = [...new Set((Array.isArray(hits) ? hits : []).map((hit) => String(hit.key)).filter((key) => byKey.has(key)))];
          if (vectorHits.length) {
            const words = new Map([...new Set(wordHits)].map((key, index) => [key, index])), vecs = new Map(vectorHits.map((key, index) => [key, index]));
            const score = (key) => (words.has(key) && vecs.has(key) ? 2 : 0) + (words.has(key) ? 1 / (words.get(key) + 1) : 0) + (vecs.has(key) ? 1 / (vecs.get(key) + 1) : 0);
            candidates = [...new Set([...wordHits, ...vectorHits])].sort((left, right) => score(right) - score(left)).slice(0, 20)
              .map((key) => ({ r: byKey.get(key), why: vecs.has(key) ? "vector" : "fts", exact: false }));
          }
        } catch (_) { /* A stale/missing vector cache silently keeps phase 2a's candidates. */ }
      }
    }
    if (clearKey) {        // 1.99amq clerkfast: first, whatever the vectors' order (it is always one of the word hits they fuse)
      const at = candidates.findIndex((x) => String(x.r.key) === clearKey);
      if (at < 0) clearKey = null;
      else if (at > 0) candidates.unshift(...candidates.splice(at, 1));
    }
    // The last read is the safety boundary: never trust a search hit or a candidate retained across a sync/settings edit.
    if (a.select === "random") {
      const byKey = new Map(candidates.map((x) => [String(x.r.key), x]));
      candidates = shuffled([...byKey.values()].map((x) => x.r), a.quality, limit).map((r) => byKey.get(String(r.key)));
    } else candidates = candidates.slice(0, limit);
    plans = plans.slice(0, limit);
    alternatives = alternatives.sort((x, y) => (x.season - y.season) || String(x.show.key).localeCompare(String(y.show.key))).slice(0, 5);
    const chosen = await fresh([...candidates.map((x) => String(x.r.key)), ...plans.flatMap((x) => x.keys), ...alternatives.flatMap((x) => x.keys)]);
    if (!chosen.state.ready) return { ...base, catalog: { ready: false, at: chosen.state.at || null } };
    for (const filter of shelfSelection.filters) if (filter.source === "mdblist") {
      const members = settings().clerk_lists === true ? await listSource().members({ id: filter.id, ...(a.rank_max && filter.ranked ? { rank_max: a.rank_max } : {}) }) : [];
      filter.members = new Map(members.map((m) => [String(m.key), m]));
    }
    const by = new Map(chosen.rows.filter((r) => shelfSelection.filters.every((f) => shelfMatches(r, f) || r.type === "episode" && chosen.parents.has(String(r.show_key)) && shelfMatches(chosen.parents.get(String(r.show_key)), f))).map((r) => [String(r.key), r]));
    // Use only parents whose children survived the final policy read. A denied variant must not affect labels or ambiguity.
    const parentKeys = new Set(chosen.rows.filter((r) => by.has(String(r.key)) && r.type === "episode").map((r) => String(r.show_key)));
    const names = new Map();
    for (const key of parentKeys) {
      const name = norm((chosen.parents.get(key) || {}).title);
      if (name) names.set(name, (names.get(name) || 0) + 1);
    }
    const collisions = new Set([...names].filter(([, count]) => count > 1).map(([name]) => name));
    const rows = candidates.filter((x) => by.has(String(x.r.key))).map((x) => single(by.get(String(x.r.key)), x.why, x.exact, chosen.s, chosen.parents, collisions));
    let cut;
    const alternativeRows = [];
    if (request.target !== "cam") for (const plan of [...plans, ...alternatives]) {
      if (plan.keys.some((key) => !by.has(key))) continue;
      const members = plan.keys.map((key) => by.get(key)), first = members[0], out = single(first, plan.why, exact, chosen.s, chosen.parents, collisions);
      const warnings = members.map((r) => warn(r, chosen.s, chosen.parents));
      Object.assign(out, { kind: plan.scope === "season" ? "season" : plan.scope === "series" ? "show" : "list", type: plan.scope === "season" ? "season" : plan.scope === "series" ? "show" : "list", scope: plan.scope,
        keys: plan.keys, items: plan.keys.length, total_sec: members.reduce((n, r) => n + duration(r), 0),
        label: clean(plan.show ? `${showLabel(first, chosen.parents, collisions)}${plan.scope === "season" ? ` S${first.season}` : ""} · ${members.length} episodes` : `${members.length} films · ${first.title}`, 120),
        warn: warnings.includes("nc17") ? "nc17" : warnings.includes("unrated") ? "unrated" : null });
      if (plan.requested > plan.keys.length) { out.cut = { asked: plan.requested, queued: plan.keys.length }; if (!plan.alternative) cut = out.cut; }
      (plan.alternative ? alternativeRows : rows).push(out);
    }
    let offered = rows.slice(0, limit).map((row) => provenance(row, shelfSelection.filters));
    for (const record of recall) if (record.status === "in" && !verified.candidates.some((x) => x.guess === record.guess && by.has(String(x.r.key)))) {
      record.status = "unknown"; delete record.key; delete record.match;
    }
    // One cached Seerr lookup per request, only after a named title failed or for a proven newer-release note.
    // 1.99?? clerkreq S2: a named title failed = nothing offered, OR all that's offered is an episode only its title named (a bare line:
    // the show / film of that name may exist elsewhere), OR (a title-level ask) nothing offered IS that title - a near title isn't it
    const allNamed = offered.length > 0 && offered.every((r) => r.why === "episode_named");
    const isTitle = (r) => (r.kind === "movie" ? sameName(r.title, a.title) : ["episode", "season", "show"].includes(r.kind) && sameName(r.show, a.title))
      || filmSpecials.has(String(r.key));          // (review F6: the film kept as a special is that title)
    if (!recalled && (!offered.length || allNamed || titleLevel && !offered.some(isTitle)) && !shelfSelection.filters.length && a.title && !a.about && !a.like) {
      const k = episodeNamed ? askedKind : (filmSpecials.size ? askedKind : a.kind);
      const seasonOf = a.season != null && a.episode == null ? { season: a.season } : {};
      // review follow-up: a kind word the bot cut off the END of the title is often the title's own ("Scary Movie", "The Truman Show",
      // "Bee Movie") - the line's words are looked up first, as said and with no kind; then the trimmed title as before
      const tail = /^(.*\S)\s+(?:movie|film|show|series|tv show|tv series)$/i.exec(raw || "");
      let found = null;
      if (tail && norm(tail[1]) === norm(a.title) && norm(raw) !== norm(a.title)) {
        const said = await missingTitle({ kind: null, title: raw, year: a.year, ...seasonOf }, context, Date.now() + SEERR_MS);
        if (said && (said.tmdb || said.choices || said.requested || said.unavailable || said.miss === "down" || said.miss === "off")) found = said;
      }
      if (!found) found = await missingTitle({ kind: k === "show" || k === "episode" ? "show" : k, title: a.title, year: a.year, ...seasonOf },
        context, Date.now() + SEERR_MS);
      // review F5: the episode already offered stays offered - a same-named title Seerr says is on Plex (in a section the clerk doesn't
      // serve) is no reason to refuse it ("that one isn't available here" for an episode on the shelves); nothing of it is said
      if (found && found.unavailable) { if (!allNamed) return { ...base, code: "unavailable" }; }
      else took(found);
      if (found && found.tmdb) seerr = found;
    }
    // review F11: the title IS on the shelves - as the other kind ("the movie <a show's name>") or without the season asked - said, never
    // "isn't on our shelves" (a title the clerk may show: roots are the allowed sections only)
    let shelfTitle = null;
    if (!recalled && a.title && !a.about && !a.like && !shelfSelection.filters.length) {
      const seasonAsk = a.season != null && a.episode == null && askedKind !== "movie";
      const show = seasonAsk ? roots.find((r) => r.type === "show" && sameName(r.title, a.title)) : null;
      if (show && !offered.some((r) => sameName(r.show, a.title) && Number(r.season) === a.season)) {
        shelfTitle = { kind: "show", title: show.title, year: integer(Number(show.year), 1880, 2200), season: a.season };
      } else if (["show", "movie"].includes(askedKind) && !offered.some(isTitle)) {
        const other = roots.find((r) => r.type !== askedKind && sameName(r.title, a.title));
        if (other) shelfTitle = { kind: other.type, title: other.title, year: integer(Number(other.year), 1880, 2200) };
      }
    }
    if (!recalled && offered.length && !shelfSelection.filters.length && a.select === "latest" && a.title && offered.every((r) => r.kind === "movie") && context.allowSeerr) {
      const entry = await seerrSearch(a.title, context, Date.now() + SEERR_MS), currentYear = new Date(now()).getUTCFullYear();
      // mediarequests exposes release years only. A past year proves release; a current/future year does not.
      const newer = entry && entry.rows && entry.rows.filter((r) => r.kind === "movie" && (sameName(r.title, a.title) || norm(r.title).startsWith(norm(a.title) + " ")) && r.year > Math.max(...offered.map((x) => Number(x.year) || 0)) && r.year < currentYear)
        .sort((x, y) => y.year - x.year)[0];
      if (newer && !roots.some((r) => r.type === "movie" && norm(r.title) === norm(newer.title) && Math.abs(Number(r.year) - newer.year) <= 1)) {
        if (newer.media_status === 5 || newer.media_status === 6 || newer.availability === "available") return { ...base, code: "unavailable" };
        seerr = { title: newer.title, year: newer.year, kind: "movie", tmdb: newer.tmdb, availability: newer.availability };
      }
      // External I/O may have overlapped a catalog/settings change. Rebuild visible rows from a final safety read.
      const current = await fresh(offered.map((row) => row.key));
      if (!current.state.ready) return { ...base, catalog: { ready: false, at: current.state.at || null } };
      const currentRows = new Map(current.rows.map((row) => [String(row.key), row]));
      offered = offered.filter((row) => currentRows.has(row.key)).map((row) => single(currentRows.get(row.key), row.why, row.exact, current.s, current.parents));
    }
    const visibleKeys = new Set(offered.map((row) => row.key));
    const ambiguous = (!!a.title && wantedShows.length > 1 && new Set(offered.map((r) => r.show_key).filter(Boolean)).size > 1)
      || recallHasVariants(verified.candidates.filter((candidate) => visibleKeys.has(String(candidate.r.key))));
    // 1.99amq clerkfast: clear - the description singles out the first row (the bot may answer without its model)
    const clear = !!clearKey && !ambiguous && !seerr && offered.length > 0 && offered[0].key === clearKey && offered[0].kind === "episode";
    // 1.99?? clerkreq S2: the episodes that only share the name (<= 3, each through the last safety read): {key, label, show} - so the bot
    // can say "no show or film called X - there's a <show> episode by that name"
    let named = [];
    if (allNamed) named = offered.slice(0, 3).map((r) => ({ key: r.key, label: r.label, show: r.show || null }));
    else if (namedEpisodes.length && !offered.length) {
      const checked = await fresh(namedEpisodes.slice(0, 3).map((r) => String(r.key)));
      if (checked.state.ready) named = checked.rows.filter((r) => r.type === "episode").slice(0, 3).map((r) => ({ key: String(r.key),
        label: single(r, "episode_named", false, checked.s, checked.parents).label, show: (checked.parents.get(String(r.show_key)) || {}).title || r.show || null }));
    }
    return { ...base, rows: offered, exact: !!exact && rows.length > 0, recall, ...(seerr ? { seerr } : {}), ...(ambiguous ? { ambiguous: true } : {}), ...(cut ? { cut } : {}),
      ...(seerrState ? { seerr_state: seerrState } : {}), ...(seerrChoices && !seerr ? { seerr_choices: seerrChoices } : {}),
      ...(seerrRequested && !seerr ? { seerr_requested: seerrRequested } : {}), ...(named.length ? { episode_named: named } : {}),
      ...(shelfTitle ? { shelf_title: shelfTitle } : {}),
      ...(clear ? { clear: true } : {}),
      ...(shelfSelection.filters.some((f) => f.no_rank) ? { no_rank: true } : {}),
      ...(!rows.length && alternativeRows.length ? { alternatives: alternativeRows.map((row) => provenance(row, shelfSelection.filters)) } : {}), catalog: { ready: true, at: chosen.state.at || null } };
  }
  return { find, validateKeys, shelves };
}
let current;
const singleton = () => current || (current = createFinder());
// review F7 (test hook): is this text in the bounded name cache?
module.exports = { createFinder, norm, askOf, ClerkError, episodeOrder, movieOrder, _normCached: (text) => normKept.has(String(text)), find: (...args) => singleton().find(...args), validateKeys: (...args) => singleton().validateKeys(...args), shelves: (...args) => singleton().shelves(...args) };
