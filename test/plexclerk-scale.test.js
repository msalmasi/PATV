"use strict";
// 1.99?? plexclerk (owner report 2026-11-08 "pepe says he is still shelving the library, also its unable to get external lists"):
// at the real library's size (30,682 films, 4,257 shows, 220,894 episodes) every clerk find read ALL films and ALL shows with
// no index on the kind - each read past the 400 ms read budget -> too_broad -> the route's catalog_down -> the bot's "still
// shelving"; the exact-episode-title check was an OR word search over every episode (1.8 s on prod); the lists' add path read
// the same two kinds and the lists' membership read scanned the whole catalog first (773 ms on prod) -> "lists_unavailable".
// These tests pin the shapes that keep a find inside its budget at any size, and replay the owner's two descriptions.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const sqlite3 = require("sqlite3");
const { createCatalog } = require("../plexcatalog");
const { createFinder } = require("../plexfind");
const { createLists } = require("../plexlists");

const AT = Date.UTC(2026, 10, 8, 6);
const SETTINGS = { clerk_block_ratings: "X,XXX,AO,R18,R18+", clerk_warn_ratings: "NR,Not Rated,Unrated", library_queue_max_items: 60, library_queue_max_hours: 12 };
const sections = [{ id: "1", title: "Fixture Cinema", type: "movie", count: 0, policy: "allowed" }, { id: "2", title: "Fixture Series", type: "show", count: 0, policy: "allowed" }];
const movie = (key, title, extra = {}) => ({ key: String(key), type: "movie", section: "1", title, year: 1990 + (key % 30), duration: 5400,
  added: 100, updated: 100, genres: ["Drama"], content_rating: "PG", summary: "A quiet story about a harbour town and its people.", ...extra });
const show = (key, title, extra = {}) => ({ key: String(key), type: "show", section: "2", title, year: 1987, added: 100, updated: 100, genres: ["Science Fiction"], content_rating: "TV-PG", ...extra });
const episode = (key, parent, season, number, title, extra = {}) => ({ key: String(key), type: "episode", section: "2", title, show: parent.title, show_key: parent.key,
  season, episode: number, year: parent.year, duration: 2700, added: 100, updated: 100, content_rating: "TV-PG", summary: "The crew of the ship meets someone new.", ...extra });

function library() {
  const tng = show(5000, "Star Trek: The Next Generation"), tos = show(5100, "Star Trek", { year: 1966 }), simpsons = show(5200, "The Simpsons", { year: 1989, genres: ["Animation", "Comedy"] });
  const rows = [tng, tos, simpsons, movie(4000, "Star Trek", { year: 2009, genres: ["Science Fiction"] })];
  for (let i = 1; i <= 400; i++) rows.push(movie(i, "Fixture Film " + i));
  for (const [parent, base] of [[tng, 50000], [tos, 51000], [simpsons, 52000]]) for (let s = 1; s <= 5; s++) for (let e = 1; e <= 6; e++)
    rows.push(episode(base + s * 100 + e, parent, s, e, "Fixture chapter " + s + "." + e));
  const set = (key, patch) => Object.assign(rows.find((r) => r.key === String(key)), patch);
  set(50502, { title: "Darmok", summary: "Picard is stranded on a planet with an alien captain who speaks only in metaphors." });
  set(52301, { title: "Stark Raving Dad", summary: "Homer wears a pink shirt to work and is committed to a mental institution." });
  return { v: 1, allow_list_set: true, sections, rows, shelves: [{ key: "900", name: "Fixture Classics", members: ["1", "2", "3"] }] };
}

async function setup(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plexclerk-scale-"));
  const reads = [];
  const catalog = createCatalog({ file: path.join(dir, "catalog.db"), settings: () => SETTINGS, now: () => AT, log: { log() {}, error() {} },
    mainRead: async () => [], mediactl: async () => { throw new Error("offline fixture"); }, tautulli: { configured: () => false },
    onRead: (r) => reads.push(r.sql), ...options });
  await catalog.importSnapshot(library());
  const finder = createFinder({ catalog, settings: () => SETTINGS, now: () => AT, rng: () => 0, deepMax: { movie: 2, show: 10 },
    lists: { shelves: async () => [], members: async () => [] }, requests: { search: async () => [], details: async () => null }, vectors: { nearest: async () => [] } });
  const plain = new sqlite3.Database(path.join(dir, "catalog.db"), sqlite3.OPEN_READONLY);
  const plan = (sql) => new Promise((resolve, reject) => plain.all("EXPLAIN QUERY PLAN " + sql, [], (e, r) => e ? reject(e) : resolve(r.map((x) => x.detail).join(" / "))));
  t.after(async () => { await new Promise((r) => plain.close(r)); await catalog.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { catalog, finder, reads, plan, dir };
}
const ROOTS = (sql) => /c\.type IN \('movie','show'\)/.test(sql);
const KIND_READ = (sql) => /^SELECT c\.\* FROM plex_catalog c JOIN plex_sections s ON s\.id=c\.section WHERE /.test(sql) && /c\.type=\?$/.test(sql.trim());
const WORD_SEARCH = (sql) => /plex_catalog_fts MATCH/.test(sql);
// What the bot sends for the owner's lines (pepe_plexnl.parse -> pepe_plexclerk.to_ask, the clerk worker's probe body)
const STAR_TREK = "the episode of star trek where they communicate by telling stories";
const SIMPSONS = "the episode of the simpsons where homer wears the pink shirt";
const probe = (raw) => ({ ask: { intent: "plex", action: "play", kind: "show", select: null, quality: "any", title: raw, guesses: [], genres: [], shelves: [], people: [], confidence: 1 },
  raw, exclude: [], limit: 20, target: "stage", probe: true });
// What a model answers for them (validated by pepe_plexclerk.validate_clerk, then to_ask) - the site verifies every guess
const interpreted = (raw, guess, about) => ({ ask: { intent: "plex", action: "play", kind: "episode", select: null, quality: "any", title: null, about,
  guesses: [guess], genres: [], shelves: [], people: [], confidence: .9 }, raw, exclude: [], limit: 20, target: "stage" });

test("the clerk's films+shows read uses its own index; title checks use the title index; a show's episodes keep the show index", async (t) => {
  const h = await setup(t);
  assert.equal(typeof h.catalog.roots, "function", "catalog.roots() reads every film and show once per catalog version");
  assert.equal(typeof h.catalog.byTitle, "function", "catalog.byTitle() answers 'is this a whole title' from the title index");
  h.reads.length = 0; await h.catalog.roots();
  const roots = h.reads.find(ROOTS);
  assert.ok(roots, "one read covers both kinds");
  const rootsPlan = await h.plan(roots);
  assert.match(rootsPlan, /plex_catalog_roots/, rootsPlan);
  assert.doesNotMatch(rootsPlan, /SCAN c\b/, "never a scan of the whole catalog (" + rootsPlan + ")");
  h.reads.length = 0; await h.catalog.byTitle("Darmok", { kind: "episode" });
  const titled = await h.plan(h.reads.find((sql) => /title_fold IN/.test(sql)));
  assert.match(titled, /plex_catalog_title/, titled);
  h.reads.length = 0; await h.catalog.rows({ kind: "episode", show_key: "5000" });
  const perShow = await h.plan(h.reads.find((sql) => /c\.show_key=\?/.test(sql)));
  assert.match(perShow, /plex_catalog_show/, "the new index never takes over the per-show read (" + perShow + ")");
});

test("byTitle finds a whole title with or without a leading article and nothing else", async (t) => {
  const h = await setup(t);
  assert.deepEqual((await h.catalog.byTitle("darmok", { kind: "episode" })).map((r) => r.key), ["50502"]);
  assert.deepEqual((await h.catalog.byTitle("Simpsons", { kind: "show" })).map((r) => r.key), ["5200"]);
  assert.deepEqual((await h.catalog.byTitle("The Simpsons")).map((r) => r.key), ["5200"]);
  assert.deepEqual(await h.catalog.byTitle("Simpsons where homer", { kind: "show" }), []);
  assert.deepEqual(await h.catalog.byTitle("...", {}), []);
});

test("the films+shows are read once per catalog version; each caller gets its own arrays of frozen rows", async (t) => {
  const h = await setup(t);
  h.reads.length = 0;
  const first = await h.catalog.roots(), second = await h.catalog.roots();
  assert.equal(h.reads.filter(ROOTS).length, 1, "the second call is answered from memory");
  assert.equal(first.movies.length, 401); assert.equal(first.shows.length, 3);
  assert.notEqual(first.movies, second.movies, "a caller's array is its own");
  first.movies.length = 0; assert.equal((await h.catalog.roots()).movies.length, 401);
  assert.ok(Object.isFrozen(second.shows[0]), "kept rows can't be changed by a caller");
  assert.deepEqual(second.shows.find((r) => r.key === "5000").shelves, []);
  await h.catalog.importSnapshot(library());                               // any write is a new catalog version
  h.reads.length = 0; await h.catalog.roots();
  assert.equal(h.reads.filter(ROOTS).length, 1, "read again after a write");
});

test("owner 11-08: the two descriptions' probe finds answer quickly without reading every film twice or word-searching every episode", async (t) => {
  const h = await setup(t);
  for (const raw of [STAR_TREK, SIMPSONS]) {
    h.reads.length = 0;
    const out = await h.finder.find(probe(raw), { seenKeys: [], maxSec: 4 * 3600, allowSeerr: false });
    assert.equal(out.catalog.ready, true); assert.deepEqual(out.rows, []); assert.equal(out.exact, false);
    assert.equal(h.reads.filter(KIND_READ).length, 0, "no whole-kind read (films/shows come from roots())");
    assert.equal(h.reads.filter(WORD_SEARCH).length, 0, "a whole-title check is the title index, not a word search: " + h.reads.filter(WORD_SEARCH).join(" | "));
  }
  assert.ok(h.reads.filter(ROOTS).length <= 1, "the roots were kept from the first find");
});

test("owner 11-08 replay: phase 2a recall names the episode and the site verifies it (Darmok, Stark Raving Dad)", async (t) => {
  const h = await setup(t);
  const cases = [
    [STAR_TREK, { kind: "episode", show: "Star Trek: The Next Generation", season: 5, episode: 2, episode_title: "Darmok", confidence: .95 },
      "Picard and an alien captain who speaks in stories", "50502", "exact"],
    [SIMPSONS, { kind: "episode", show: "The Simpsons", season: 3, episode: 1, episode_title: "Stark Raving Dad", confidence: .9 },
      "Homer wears a pink shirt to work and is sent to a mental hospital", "52301", "exact"],
    [STAR_TREK, { kind: "episode", show: "Star Trek: The Next Generation", episode_title: "Darmok", confidence: .9 }, null, "50502", "partial"],
  ];
  for (const [raw, guess, about, key, match] of cases) {
    h.reads.length = 0;
    const out = await h.finder.find(interpreted(raw, guess, about), { seenKeys: [], maxSec: 4 * 3600, allowSeerr: false });
    assert.equal(out.rows[0] && out.rows[0].key, key, raw);
    assert.equal(out.rows.length, 1);
    assert.equal(out.recall[0].status, "in"); assert.equal(out.recall[0].match, match);
    assert.equal(out.rows[0].why, match === "exact" ? "recall" : "guess");
    assert.equal(h.reads.filter(WORD_SEARCH).length, 0, "a verified recall needs no word search over the films");
    assert.equal(h.reads.filter(KIND_READ).length, 0);
  }
});

test("a word search drops English function words when other words remain", async (t) => {
  const h = await setup(t);
  // every fixture film's summary has "a", "about", "and", "its"; only one episode summary has "pink"
  assert.deepEqual((await h.catalog.search("a pink shirt", {})).map((r) => r.key), ["52301"]);
  assert.equal((await h.catalog.search("a lantern about its keeper", { kind: "movie", limit: 5 })).length, 0, "'a', 'about', 'its' match every film");
  assert.ok((await h.catalog.search("the", { kind: "movie", limit: 5 })).length >= 0, "only function words: searched as typed (no throw)");
});

test("lists: the membership read starts from the members, and adding a list matches through the kept roots", async (t) => {
  const h = await setup(t);
  const cfg = { ...SETTINGS, clerk_lists: true };
  const lists = createLists({ catalog: h.catalog, settings: () => cfg, key: () => "fixture-only", now: () => AT, request: async () => { throw new Error("offline"); } });
  t.after(() => lists.close());
  h.reads.length = 0;
  assert.equal((await lists.importSnapshot({ configured: [{ id: "8001", name: "IMDb Top 250", ranked: true, items: [
    { rank: 1, type: "movie", title: "Fixture Film 7", year: 1997 }, { rank: 2, type: "show", title: "The Simpsons", year: 1989 }] }] })).ok, true);
  assert.equal(h.reads.filter(KIND_READ).length, 0, "match() takes the films and shows from roots()");
  h.reads.length = 0;
  const listed = await lists.list();
  assert.equal(listed.ok, true, JSON.stringify(listed)); assert.equal(listed.lists[0].matched, 2);
  const final = h.reads.find((sql) => /json_valid\(c\.data\)/.test(sql));
  const finalPlan = await h.plan(final);
  assert.match(finalPlan, /^SCAN m\b/, "members first, then each member's catalog row by key (" + finalPlan + ")");
  // 1.99?? rebase onto site 1.99amd (its card fix started every membership read from the lists): ONE order for both reads, the
  // members first - offline at the real library's size a full read costs the same either order (0 lists 0.1 ms, 20 x 20,000
  // ~3.1-3.4 s), and a key lookup (the clerk's candidates) goes straight to plex_list_member_key
  const membership = [...new Set(h.reads.filter((sql) => /^SELECT m\.key,m\.rank,m\.item_no\b/.test(sql)))];
  assert.equal(membership.length, 2, "the membership read and its final re-check");
  for (const sql of membership) {
    const p = await h.plan(sql); assert.match(p, /^SCAN m\b/, "members first (" + p + ")");
    assert.match(sql, / FROM plex_list_members m CROSS JOIN plex_lists l ON l\.id=m\.list_id\b/, "pinned (a CROSS JOIN), never the planner's pick");
  }
  h.reads.length = 0;
  assert.deepEqual((await lists.membership(["7"])).map((r) => r.key), ["7"]);
  const byKey = [...new Set(h.reads.filter((sql) => /^SELECT m\.key,m\.rank,m\.item_no\b/.test(sql)))];
  assert.equal(byKey.length, 2);
  for (const sql of byKey) { const p = await h.plan(sql); assert.match(p, /^SEARCH m USING (COVERING )?INDEX plex_list_member_key \(key=\?\)/, "a key lookup (" + p + ")"); }
  assert.deepEqual((await lists.shelves()).map((r) => [r.name, r.count]), [["IMDb Top 250", 2]]);
});

test("lists: a list's add / import / rematch match through the kept roots on the admin lane - one indexed read of the films and shows for all the lists, on the admin budget", async (t) => {
  // 1.99?? rebase onto site 1.99amd: amd moved a list's matching to the admin lane (two whole-kind reads, ADMIN_BUDGET_MS);
  // plexclerk moved it to roots() (one read through plex_catalog_roots, kept). Both: catalog.admin.roots() - the same kept
  // answer the clerk reads, read on the admin lane when it has to be read (offline at the real library's size: 355 ms vs 540 ms
  // for the two whole-kind reads, and a rematch of every list reads it once instead of twice per list)
  const { ADMIN_BUDGET_MS } = require("../plexcatalog");
  const seen = [];
  const h = await setup(t, { onRead: (r) => seen.push(r) });
  const cfg = { ...SETTINGS, clerk_lists: true };
  const lists = createLists({ catalog: h.catalog, settings: () => cfg, key: () => "fixture-only", now: () => AT, request: async () => { throw new Error("offline"); } });
  t.after(() => lists.close());
  assert.equal(typeof h.catalog.admin.roots, "function");
  const rootReads = () => seen.filter((r) => /^SELECT c\.\* FROM plex_catalog c/.test(r.sql) && ROOTS(r.sql));
  seen.length = 0;
  assert.equal((await lists.importSnapshot({ configured: [
    { id: "8201", name: "List A", ranked: true, items: [{ rank: 1, type: "movie", title: "Fixture Film 7", year: 1997 }] },
    { id: "8202", name: "List B", ranked: false, items: [{ type: "show", title: "The Simpsons", year: 1989 }] },
    { id: "8203", name: "List C", ranked: false, items: [{ type: "movie", title: "Fixture Film 9", year: 1999 }] }] })).ok, true);
  assert.equal(rootReads().length, 1, "three lists matched: the films and shows read once");
  assert.equal(seen.filter((r) => KIND_READ(r.sql)).length, 0, "no whole-kind read");
  assert.deepEqual([...new Set(seen.map((r) => r.budgetMs))], [ADMIN_BUDGET_MS], "every read the matching made is on the admin lane");
  const p = await h.plan(rootReads()[0].sql);
  assert.match(p, /INDEX plex_catalog_roots/, p); assert.doesNotMatch(p, /SCAN c\b/, p);
  seen.length = 0;
  assert.equal((await lists.rematch()).ok, true);
  assert.equal(rootReads().length, 0, "nothing changed: the rematch reuses the kept roots");
  assert.deepEqual((await lists.shelves()).map((r) => [r.name, r.count]), [["List A", 1], ["List B", 1], ["List C", 1]]);
  // the clerk's roots() and the admin lane's are one kept answer
  seen.length = 0;
  const kept = await h.catalog.roots();
  assert.equal(kept.movies.length + kept.shows.length, 404); assert.equal(rootReads().length, 0, "the clerk gets the answer the lists read");
});

test("a catalog that isn't ready (or whose state can't be read) refuses roots() - a rematch then keeps every list's last members", async (t) => {
  // review: roots() answered empty arrays for a catalog that wasn't ready (status() also says not ready when its own read fails),
  // so a rematch after a delta sync on a catalog whose last full sweep is older than 3 days stored 0 members for every list
  let clock = AT;
  const h = await setup(t, { now: () => clock });
  const cfg = { ...SETTINGS, clerk_lists: true };
  const lists = createLists({ catalog: h.catalog, settings: () => cfg, key: () => "fixture-only", now: () => clock, request: async () => { throw new Error("offline"); } });
  t.after(() => lists.close());
  assert.equal((await lists.importSnapshot({ configured: [{ id: "8001", name: "IMDb Top 250", ranked: true, items: [
    { rank: 1, type: "movie", title: "Fixture Film 7", year: 1997 }, { rank: 2, type: "show", title: "The Simpsons", year: 1989 }] }] })).ok, true);
  const members = async () => (await h.catalog.read("SELECT COUNT(*) AS n FROM plex_list_members"))[0].n;
  assert.equal(await members(), 2);
  clock = AT + 4 * 86400000;                                                // the last full sweep is now older than 3 days
  assert.equal((await h.catalog.status()).ready, false);
  await assert.rejects(h.catalog.roots(), (e) => e.code === "catalog_down", "never an empty library standing in for one that can't be read");
  await assert.rejects(h.catalog.admin.roots(), (e) => e.code === "catalog_down", "the admin lane's roots too (1.99amd rebase)");
  const again = await lists.rematch();
  assert.equal(again.ok, false, "the rematch is refused");
  assert.equal(await members(), 2, "the lists keep their last complete members");
  clock = AT;
  assert.equal((await h.catalog.roots()).movies.length, 401, "ready again: the films come back");
});

test("an outside list named like 'Oscar Best Picture Winners' answers 'an oscar winner'; IMDb Top 250 answers 'the imdb top 100'", async (t) => {
  const h = await setup(t);
  const cfg = { ...SETTINGS, clerk_lists: true };
  const lists = createLists({ catalog: h.catalog, settings: () => cfg, key: () => "fixture-only", now: () => AT, request: async () => { throw new Error("offline"); } });
  t.after(() => lists.close());
  assert.equal((await lists.importSnapshot({ configured: [
    { id: "8101", name: "Oscar Best Picture Winners", ranked: false, items: [{ type: "movie", title: "Fixture Film 7", year: 1997 }, { type: "movie", title: "Fixture Film 8", year: 1998 }] },
    { id: "8102", name: "IMDb Top 250", ranked: true, items: [{ rank: 3, type: "movie", title: "Fixture Film 9", year: 1999 }, { rank: 180, type: "movie", title: "Fixture Film 10", year: 2000 }] }] })).ok, true);
  const finder = createFinder({ catalog: h.catalog, settings: () => cfg, lists, now: () => AT, rng: () => 0, deepMax: { movie: 2, show: 10 },
    requests: { search: async () => [], details: async () => null }, vectors: { nearest: async () => [] } });
  const ctx = { seenKeys: [], maxSec: 4 * 3600, allowSeerr: false };
  for (const raw of ["an oscar winner", "an Oscar-winning film", "something from the oscars", "something from the best picture winners"]) {
    const out = await finder.find({ ask: { select: "random" }, raw, limit: 3 }, ctx);
    assert.equal(out.shelf_missing, undefined, raw);
    assert.deepEqual(out.rows.map((r) => r.key).sort(), ["7", "8"], raw);
    assert.equal(out.rows[0].shelf.name, "Oscar Best Picture Winners");
  }
  const ranked = await finder.find({ ask: { select: "random" }, raw: "something from the imdb top 100", limit: 3 }, ctx);
  assert.deepEqual(ranked.rows.map((r) => [r.key, r.shelf.rank]), [["9", 3]], "rank 180 is past the top 100");
});

test("the admin lists panel says why an action was refused (the maintenance window, the key, the input, the limits)", () => {
  const js = fs.readFileSync(path.join(__dirname, "..", "public", "js", "media-admin.js"), "utf8");
  const en = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "locales", "en.json"), "utf8"));
  // 1.99?? rebase onto site 1.99amd: amd's card reasons (js.media.lists.busy / why_*, live and translated) are the one set - one
  // line per code, no second js.media.lists.err.* set; the key's own refusal (needs_key) joins them. Every code here has its line.
  const reasons = { quiet: "why_quiet", needs_key: "why_needs_key", invalid_list: "why_invalid_list", not_found: "why_not_found", list_limit: "why_list_limit",
    rate_limited: "why_rate_limited", daily_budget: "why_rate_limited", provider_auth: "why_provider_auth", list_too_large: "why_list_too_large", lists_busy: "busy" };
  for (const [code, key] of Object.entries(reasons)) {
    assert.ok(typeof en["js.media.lists." + key] === "string" && en["js.media.lists." + key].length > 10, code + " -> " + key);
    assert.match(js, new RegExp("case \"" + code + "\":[^\\n]*lt\\(\"" + key + "\""), "the panel says " + key + " for " + code);
  }
  assert.deepEqual(Object.keys(en).filter((k) => k.startsWith("js.media.lists.err.")), [], "no second set of the same reasons");
  assert.match(en["js.media.lists.why_needs_key"], /MDBLIST_API_KEY/);
  assert.match(en["js.media.lists.why_quiet"], /03:40/); assert.match(en["js.media.lists.why_quiet"], /04:20/);
  // review: 03:40-04:20 UTC is the SITE's own nightly window (plexlists/plexcatalog quiet(): no provider call), not MDBList's
  assert.match(en["js.media.lists.why_quiet"], /nightly maintenance/);
  assert.doesNotMatch(en["js.media.lists.why_quiet"], /MDBList/, "the provider isn't the one pausing");
  assert.match(js, /\.code = j\.code/, "api() keeps the server's code on the error");
});
