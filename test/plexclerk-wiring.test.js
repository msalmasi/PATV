"use strict";
// 1.99?? plexclerk review (owner report 2026-11-08 "still shelving" / "unable to get external lists"): the fix gave the catalog
// roots() / byTitle(), but production never builds a finder or a lists cache with a createCatalog() instance - plexchat's finder
// is require("./plexfind")'s singleton (catalog = the plexcatalog MODULE), plexfind reads lists through require("./plexlists")'s
// singleton (the same module), and the catalog's own lists cache (the /admin/media routes, the rematch after every sync and
// import) gets a facade of the catalog's functions. Every other clerk test hands a createCatalog() instance straight in, so
// none of them used this wiring. These tests drive exactly the modules the site runs, with the prod-sized reads simulated:
// at 30,682 films / 4,257 shows / 220,894 episodes a whole-kind read and an all-episode word search are past their 400 ms
// budget (prod: 1.07-1.27 s, 0.46 s, 1.65 s) - the catalog interrupts them (too_broad), here at once.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plexclerk-wiring-"));
process.env.PLEX_CATALOG_DB = path.join(dir, "catalog.db");     // the module singleton's file (read when it is first used)
process.env.MDBLIST_API_KEY = "fixture-only-not-a-key";          // lists enabled; nothing here calls the provider
const sqlite3 = require("sqlite3");
const conf = require("../mediaconf");
Object.assign(conf._S, { clerk_enabled: "everyone", clerk_lists: true, clerk_embed: false });
const CAT = require("../plexcatalog"), FIND = require("../plexfind"), LISTS = require("../plexlists");

const PROD_SIZED = [];
const tooBroad = (sql, args) => (/^SELECT c\.\* FROM plex_catalog c JOIN plex_sections s ON s\.id=c\.section WHERE /.test(sql) && /c\.type=\?$/.test(sql.trim()))
  || (/plex_catalog_fts MATCH/.test(sql) && args.includes("episode") && !/c\.show_key=\?/.test(sql));
const realAll = sqlite3.Database.prototype.all;
sqlite3.Database.prototype.all = function (sql, args, cb) {
  const params = Array.isArray(args) ? args : [], done = typeof args === "function" ? args : cb;
  if (typeof sql === "string" && typeof done === "function" && tooBroad(sql, params)) {
    PROD_SIZED.push(sql);
    process.nextTick(() => done(new Error("SQLITE_INTERRUPT: interrupted")));
    return this;
  }
  return realAll.apply(this, arguments);
};

const sections = [{ id: "1", title: "Fixture Cinema", type: "movie", count: 0, policy: "allowed" }, { id: "2", title: "Fixture Series", type: "show", count: 0, policy: "allowed" }];
const movie = (key, title, extra = {}) => ({ key: String(key), type: "movie", section: "1", title, year: 1990 + (key % 30), duration: 5400,
  added: 100, updated: 100, genres: ["Drama"], content_rating: "PG", summary: "A quiet story about a harbour town.", ...extra });
const show = (key, title, extra = {}) => ({ key: String(key), type: "show", section: "2", title, year: 1987, added: 100, updated: 100, genres: ["Science Fiction"], content_rating: "TV-PG", ...extra });
const episode = (key, parent, season, number, title, extra = {}) => ({ key: String(key), type: "episode", section: "2", title, show: parent.title, show_key: parent.key,
  season, episode: number, year: parent.year, duration: 2700, added: 100, updated: 100, content_rating: "TV-PG", summary: "The crew meets someone new.", ...extra });
function library(extraFilms = 0) {
  const tng = show(5000, "Star Trek: The Next Generation"), simpsons = show(5200, "The Simpsons", { year: 1989, genres: ["Animation", "Comedy"] });
  const rows = [tng, simpsons];
  for (let i = 1; i <= 40 + extraFilms; i++) rows.push(movie(i, "Fixture Film " + i));
  for (const [parent, base] of [[tng, 50000], [simpsons, 52000]]) for (let s = 1; s <= 5; s++) for (let e = 1; e <= 4; e++)
    rows.push(episode(base + s * 100 + e, parent, s, e, "Fixture chapter " + s + "." + e));
  Object.assign(rows.find((r) => r.key === "50502"), { title: "Darmok", summary: "Picard is stranded with an alien captain who speaks only in metaphors." });
  Object.assign(rows.find((r) => r.key === "52301"), { title: "Stark Raving Dad", summary: "Homer wears a pink shirt to work." });
  return { v: 1, allow_list_set: true, sections, rows, shelves: [{ key: "900", name: "Fixture Classics", members: ["1", "2", "3"] }] };
}
const STAR_TREK = "the episode of star trek where they communicate by telling stories";
const probe = (raw) => ({ ask: { intent: "plex", action: "play", kind: "show", select: null, quality: "any", title: raw, guesses: [], genres: [], shelves: [], people: [], confidence: 1 },
  raw, exclude: [], limit: 20, target: "stage", probe: true });
const recall = (raw, guess) => ({ ask: { intent: "plex", action: "play", kind: "episode", select: null, quality: "any", title: null, about: "the plot the speaker described",
  guesses: [guess], genres: [], shelves: [], people: [], confidence: .9 }, raw, exclude: [], limit: 20, target: "stage" });
const ctx = { seenKeys: [], maxSec: 4 * 3600, allowSeerr: false };
const outside = (titles) => ({ configured: [{ id: "8101", name: "Oscar Best Picture Winners", ranked: false,
  items: titles.map((title) => ({ type: "movie", title, year: 1990 + (Number(title.split(" ").pop()) % 30) })) }] });
const listed = async () => (await LISTS.shelves()).map((r) => [r.name, r.count]);

test.after(async () => {
  sqlite3.Database.prototype.all = realAll;
  await LISTS.close().catch(() => {});
  await CAT.close().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the plexcatalog module (what plexfind and plexlists use in production) has roots() and byTitle()", () => {
  assert.equal(typeof CAT.roots, "function");
  assert.equal(typeof CAT.byTitle, "function");
});

test("production finder: the owner's probe and the recall that follows answer at the real library's size", async () => {
  assert.equal((await CAT.importSnapshot(library())).ok, true);
  PROD_SIZED.length = 0;
  const first = await FIND.find(probe(STAR_TREK), ctx);
  assert.equal(first.catalog.ready, true); assert.deepEqual(first.rows, []);
  const second = await FIND.find(recall(STAR_TREK, { kind: "episode", show: "Star Trek: The Next Generation", season: 5, episode: 2, episode_title: "Darmok", confidence: .95 }), ctx);
  assert.equal(second.rows[0] && second.rows[0].key, "50502");
  assert.equal(second.recall[0].status, "in");
  assert.deepEqual(PROD_SIZED, [], "no read that is past its budget at the real library's size");
});

test("production lists: the module's lists and the catalog's own lists cache (rematch after a sync/import) match through roots()", async () => {
  assert.equal((await CAT.importSnapshot(library())).ok, true);
  PROD_SIZED.length = 0;
  const added = await LISTS.importSnapshot(outside(["Fixture Film 7", "Fixture Film 8", "Fixture Film 45"]));
  assert.equal(added.ok, true, JSON.stringify(added));
  assert.deepEqual(await listed(), [["Oscar Best Picture Winners", 2]], "Fixture Film 45 isn't in the library yet");
  // a catalog import (like every sync) rematches through the catalog's own lists cache: the new film joins the list
  assert.equal((await CAT.importSnapshot(library(10))).ok, true);
  assert.deepEqual(await listed(), [["Oscar Best Picture Winners", 3]], "the catalog's lists cache rematched after the import");
  assert.deepEqual(PROD_SIZED, [], "no read that is past its budget at the real library's size");
});
