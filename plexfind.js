// The clerk selects only catalog keys. Playback, account access and PAT checks stay in plexchat / mediaqueue.
"use strict";
const crypto = require("crypto");
const KEY = /^\d{1,12}$/;
const SELECT = new Set(["one", "random", "latest", "oldest", "first_n", "last_n", "pilot", "finale", "season", "series", "in_order"]);
const norm = (s) => {
  const value = String(s || "").toLowerCase().normalize("NFKD").replace(/([a-z])[\u0300-\u036f]+/g, "$1").normalize("NFC").replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim().replace(/^(the|a|an) /, "");
  return /[\p{L}\p{N}]/u.test(value) ? value : "";
};
const sameName = (left, right) => { const value = norm(left); return !!value && value === norm(right); };
const clean = (s, n = 100) => typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n) : "";
const integer = (v, lo, hi) => typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null;
const names = (v) => Array.isArray(v) ? v.filter((x) => typeof x === "string").map((x) => clean(x)).filter(Boolean).slice(0, 3) : [];
const ratingNames = (s) => new Set(String(s == null ? "" : s).split(",").map((x) => x.trim().toUpperCase()).filter(Boolean));
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
class ClerkError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; this.refuse = true; }
}
function askOf(value) {
  const a = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (a.select != null && !SELECT.has(a.select)) throw new ClerkError("bad", "Bad selection.");
  if (a.kind != null && !["movie", "show", "episode"].includes(a.kind)) throw new ClerkError("bad", "Bad kind.");
  const years = Array.isArray(a.years) && a.years.length === 2 && a.years.every((x) => integer(x, 1880, 2200) != null) && a.years[0] <= a.years[1] ? a.years : null;
  return { title: clean(a.title), kind: a.kind || null, select: a.select || "one", n: integer(a.n, 1, 60),
    season: integer(a.season, 0, 200), episode: integer(a.episode, 0, 2000), year: integer(a.year, 1880, 2200), years,
    genres: names(a.genres), shelves: names(a.shelves), people: names(a.people), studio: clean(a.studio),
    min_minutes: integer(a.min_minutes, 0, 1440), max_minutes: integer(a.max_minutes, 1, 1440),
    deep_cut: a.deep_cut === true, popular: a.popular === true, unseen: a.unseen === true,
    quality: ["good", "best"].includes(a.quality) ? a.quality : "any", steamy: a.steamy === true,
    about: clean(a.about, 200), like: clean(a.like), guesses: Array.isArray(a.guesses) ? a.guesses.slice(0, 5) : [] };
}
function createFinder({ catalog, settings, now = Date.now, rng = crypto.randomInt, deepMax } = {}) {
  catalog = catalog || require("./plexcatalog");
  settings = settings || (() => require("./mediaconf").get());
  const deepLimits = () => deepMax || require("./plexpad").DEEP_MAX;
  const effectiveRating = (r, parents) => r.content_rating || (r.type === "episode" && parents.get(String(r.show_key)) || {}).content_rating || "";
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
    if (!a.shelves.every((g) => inherited("shelves").some((x) => sameName(x, g)))) return false;
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
  async function find(request = {}, context = {}) {
    const state = await catalog.status();
    const base = { rows: [], exact: false, recall: [], catalog: { ready: !!state.ready, at: state.at || null } };
    if (!state.ready) return base;
    const a = askOf(request.ask), s = settings();
    const limit = Math.max(1, Math.min(20, Math.floor(Number(request.limit) || 20)));
    const exclude = new Set((Array.isArray(request.exclude) ? request.exclude : []).slice(0, 40).map(String));
    const seen = new Set((context.seenKeys || []).map(String));
    const sections = new Set((state.sections || []).filter((x) => x.policy === "allowed").map((x) => String(x.id)));
    const [movies, shows] = await Promise.all([catalog.rows({ kind: "movie" }), catalog.rows({ kind: "show" })]);
    const parents = new Map(shows.map((r) => [String(r.key), r]));
    const safe = (rows) => rows.filter((r) => allowed(r, sections, s, parents) && !exclude.has(String(r.key)));
    const raw = clean(request.raw).replace(/^!(?:plex|watch)\s+/i, "").replace(/^(?:pepe[,!:]?\s+)?(?:please\s+)?(?:play|watch|put on|show me)\s+/i, "");
    const roots = safe([...movies, ...shows]);
    let exactRows = raw ? roots.filter((r) => sameName(r.title, raw)) : [];
    if (!exactRows.length && raw) exactRows = safe(await catalog.search(raw, { kind: "episode", limit: 500, budgetMs: 400 })).filter((r) => sameName(r.title, raw));
    const literal = exactRows.length > 0;
    if (literal) {
      const kinds = [...new Set(exactRows.map((r) => r.type))];
      // A literal whole title outranks every inferred selector (including a mistaken kind or a year inside its name).
      Object.assign(a, askOf({ title: exactRows[0].title, kind: kinds.length === 1 ? kinds[0] : null }));
    }
    if (!exactRows.length && a.title) exactRows = roots.filter((r) => sameName(r.title, a.title));
    if (!exactRows.length && a.title) exactRows = safe(await catalog.search(a.title, { kind: "episode", limit: 500, budgetMs: 400 })).filter((r) => sameName(r.title, a.title));
    const exact = literal || (exactRows.length > 0 && a.select === "one" && !a.about && !a.like);
    let candidates = exactRows.filter((r) => r.type === "episode" && matches(r, a, seen, parents)).map((r) => ({ r, why: "exact", exact })), plans = [], alternatives = [];
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
    const wantedShows = a.kind === "movie" ? [] : (exactShows.length ? exactShows : roots.filter((r) => r.type === "show" && (a.title ? titleMatch(r.title, a.title)
      : (a.kind === "show" || a.shelves.length > 0) && matches(r, { ...a, min_minutes: null, max_minutes: null }, seen, parents))));
    if (wantedShows.length) {
      for (const show of wantedShows.slice(0, 5)) {
        let eps = safe(await catalog.rows({ kind: "episode", show_key: String(show.key) })).filter((r) => (a.season === 0 || Number(r.season) !== 0) && matches(r, { ...a, year: null, years: null }, seen, parents)).sort(episodeOrder);
        if (a.year != null && Number(show.year) !== a.year) continue;
        const available = eps.slice();
        const offerSeasons = () => {
          for (const sn of [...new Set(available.map((r) => Number(r.season)))].sort((x, y) => x - y)) makePlan(available.filter((r) => Number(r.season) === sn), "filter", show, "season", true);
        };
        if (a.season != null) eps = eps.filter((r) => Number(r.season) === a.season);
        if (a.episode != null) eps = eps.filter((r) => Number(r.episode) === a.episode && (a.season != null || Number(r.season) === 1));
        if (a.about) {
          const hits = new Set((await catalog.search(a.about, { kind: "episode", show_key: String(show.key), limit: 500, budgetMs: 400 })).map((r) => String(r.key)));
          eps = eps.filter((r) => hits.has(String(r.key)));
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
          else if (a.episode != null || a.select === "oldest" || (a.kind !== "episode" && !a.like && !a.guesses.length && !a.genres.length && !a.people.length && !a.studio && !a.shelves.length && a.quality === "any")) selected = [eps[0]];
          else selected = [];
          if (!selected.length) offerSeasons();
          candidates.push(...selected.filter(Boolean).map((r) => ({ r, why: a.about ? "fts" : a.select === "latest" || a.select === "finale" ? "latest" : a.select === "oldest" || a.select === "pilot" ? "oldest" : "exact", exact })));
        }
      }
    }
    let films = safe(movies).filter((r) => matches(r, a, seen, parents));
    if (a.title) films = films.filter((r) => titleMatch(r.title, a.title) || (r.shelves || []).some((name) => titleMatch(name, a.title)));
    if (literal) films = films.filter((r) => exactRows.some((x) => x.key === r.key));
    else if (exact && exactRows.some((r) => r.type === "movie")) films = films.filter((r) => exactRows.some((x) => x.key === r.key));
    if (a.about) {
      const hits = new Set((await catalog.search(a.about, { kind: "movie", limit: 500, budgetMs: 400 })).map((r) => String(r.key)));
      films = films.filter((r) => hits.has(String(r.key)));
    }
    if (a.kind === "episode" && !wantedShows.length && !a.title) {
      const eps = safe(await catalog.rows({ kind: "episode" })).filter((r) => (a.season === 0 || Number(r.season) !== 0) && matches(r, a, seen, parents));
      candidates.push(...eps.sort(episodeOrder).map((r) => ({ r, why: a.select === "random" ? "random" : "filter", exact: false })));
    }
    if (a.kind !== "show" && a.kind !== "episode" && (!a.title || !wantedShows.length || a.kind === "movie" || exactRows.some((r) => r.type === "movie"))) {
      films.sort(movieOrder);
      if (selectionList && films.length) {
        if (a.select === "first_n") films = films.slice(0, a.n || 1);
        if (a.select === "last_n") films = films.slice(-(a.n || 1));
        makePlan(films, "list", null);
      } else {
        if (["latest", "finale"].includes(a.select)) films = films.slice(-1);
        else if (["oldest", "pilot"].includes(a.select)) films = films.slice(0, 1);
        else if (a.select === "random") { /* shuffled with every other eligible candidate below */ }
        else films.sort((x, y) => (a.popular ? (Number(y.server_plays) || 0) - (Number(x.server_plays) || 0) : 0) || (rating(y) || 0) - (rating(x) || 0));
        const why = exact ? "exact" : a.select === "random" ? "random" : a.select === "latest" ? "latest" : a.select === "oldest" ? "oldest" : a.about ? "fts" : a.shelves.length ? "shelf" : "filter";
        candidates.push(...films.map((r) => ({ r, why, exact })));
      }
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
    const by = new Map(chosen.rows.map((r) => [String(r.key), r]));
    // Use only parents whose children survived the final policy read. A denied variant must not affect labels or ambiguity.
    const parentKeys = new Set(chosen.rows.filter((r) => r.type === "episode").map((r) => String(r.show_key)));
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
    const offered = rows.slice(0, limit);
    const ambiguous = !!a.title && wantedShows.length > 1 && new Set(offered.map((r) => r.show_key).filter(Boolean)).size > 1;
    return { ...base, rows: offered, exact: !!exact && rows.length > 0, ...(ambiguous ? { ambiguous: true } : {}), ...(cut ? { cut } : {}),
      ...(!rows.length && alternativeRows.length ? { alternatives: alternativeRows } : {}), catalog: { ready: true, at: chosen.state.at || null } };
  }
  return { find, validateKeys };
}
let current;
const singleton = () => current || (current = createFinder());
module.exports = { createFinder, norm, askOf, ClerkError, episodeOrder, movieOrder, find: (...args) => singleton().find(...args), validateKeys: (...args) => singleton().validateKeys(...args) };
