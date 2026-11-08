#!/usr/bin/env node
// 1.99amh plexclerk: offline scale check for the clerk's catalog reads. Builds a SYNTHETIC library the size of the real one
// (default 30,682 films / 4,257 shows / 220,894 episodes - the 2026-11-08 sync) in a temp dir and times what a clerk ask and
// the outside lists do. Never reads a live library or the site's database. Usage: node tools/clerk-scale.js [films shows episodes]
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { createCatalog } = require("../plexcatalog");
const { createFinder } = require("../plexfind");
const { createLists } = require("../plexlists");

const [FILMS, SHOWS, EPISODES] = process.argv.slice(2).map(Number).concat([30682, 4257, 220894]).slice(0, 3);
const AT = Date.UTC(2026, 10, 8, 6);
const SETTINGS = { clerk_block_ratings: "X,XXX,AO,R18,R18+", clerk_warn_ratings: "NR,Not Rated,Unrated", library_queue_max_items: 60, library_queue_max_hours: 12, clerk_lists: true };
// summaries: 16 common words (in every row - the worst case for a word search) plus words from a 3,000-word vocabulary
const COMMON = "harbour lantern river winter signal orchard copper meadow station paper window thunder garden ember canyon quiet".split(" ");
const VOCAB = Array.from({ length: 3000 }, (_, i) => "word" + i.toString(36));
const text = (i, n) => Array.from({ length: n }, (_, k) => k < 8 ? COMMON[(i + k) % COMMON.length] : VOCAB[(i * 7919 + k * 104729) % VOCAB.length]).join(" ");
const fold = (v) => String(v).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

async function build(catalog) {
  const rows = [], add = (r) => rows.push(r);
  add({ key: "1", type: "show", section: "2", title: "Star Trek: The Next Generation", year: 1987 });
  add({ key: "2", type: "show", section: "2", title: "The Simpsons", year: 1989 });
  for (let i = 3; i <= SHOWS; i++) add({ key: String(i), type: "show", section: "2", title: "Synthetic Series " + i, year: 1950 + i % 70 });
  for (let i = 1; i <= FILMS; i++) add({ key: String(100000 + i), type: "movie", section: "1", title: "Synthetic Film " + i, year: 1930 + i % 95 });
  let key = 1000000;
  const perShow = Math.max(1, Math.floor((EPISODES - 2 * 154) / Math.max(1, SHOWS - 2)));
  for (let s = 1; s <= SHOWS && key - 1000000 < EPISODES; s++) for (let e = 0; e < (s <= 2 ? 154 : perShow) && key - 1000000 < EPISODES; e++) {
    const season = 1 + Math.floor(e / 22), number = 1 + e % 22, show = rows[s - 1];
    let title = "Chapter " + season + "." + number;
    if (s === 1 && season === 5 && number === 2) title = "Darmok";
    if (s === 2 && season === 3 && number === 1) title = "Stark Raving Dad";
    add({ key: String(key++), type: "episode", section: "2", title, show: show.title, show_key: show.key, season, episode: number, year: show.year });
  }
  const stamp = AT;
  await catalog.write(async (tx) => {
    await tx.run("INSERT INTO plex_sections(id,title,type,count,policy) VALUES ('1','Synthetic Cinema','movie',?,'allowed'),('2','Synthetic Series','show',?,'allowed')", [FILMS, SHOWS]);
    for (let i = 0; i < rows.length; i += 400) {
      const part = rows.slice(i, i + 400), args = [], fts = [];
      for (const r of part) {
        const data = { key: r.key, type: r.type, title: r.title, year: r.year, aired: null, added: 100, updated: 100, duration: r.type === "episode" ? 1500 : 5400,
          summary: text(Number(r.key), r.type === "episode" ? 40 : 70), tagline: "", genres: ["Drama", "Comedy"], content_rating: r.type === "movie" ? "PG-13" : "TV-PG",
          rating: 7, audience_rating: null, studio: "Synthetic Studio", directors: ["Synthetic Director"], cast: ["Synthetic Player A", "Synthetic Player B", "Synthetic Player C"],
          countries: ["Nowhere"], imdb: r.type === "episode" ? null : "tt" + r.key, tmdb: r.key, tvdb: null, show_key: r.show_key || null, season_key: null,
          show: r.show || "", season: r.season == null ? null : r.season, episode: r.episode == null ? null : r.episode, section: r.section, server_plays: 0, pad_plays: 0 };
        args.push(r.key, r.type, r.title, fold(r.title), r.show_key || null, fold(r.show || ""), r.section, data.content_rating, JSON.stringify(data), stamp);
        fts.push(r.key, r.key, r.title, r.show || "", data.summary, "drama comedy", "", "synthetic player");
      }
      await tx.run("INSERT INTO plex_catalog(key,type,title,title_fold,show_key,show_fold,section,content_rating,data,seen_at) VALUES " + part.map(() => "(?,?,?,?,?,?,?,?,?,?)").join(","), args);
      await tx.run("INSERT INTO plex_catalog_fts(rowid,key,title,show,summary,genres,shelves,people) VALUES " + part.map(() => "(?,?,?,?,?,?,?,?)").join(","), fts);
    }
    for (const [k, v] of Object.entries({ at: stamp, full_at: stamp, supported: true, allow_list_set: true, version: "synthetic", v: 1, error: null, shelves_skipped: [] }))
      await tx.run("INSERT INTO plex_catalog_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [k, JSON.stringify(v)]);
  });
  return rows.length;
}
async function timed(label, fn) {
  const t = performance.now();
  try { const v = await fn(); console.log(label.padEnd(58), "ok   ", (performance.now() - t).toFixed(0).padStart(6) + " ms", v === undefined ? "" : v); return v; }
  catch (e) { console.log(label.padEnd(58), "FAIL ", (performance.now() - t).toFixed(0).padStart(6) + " ms", "code=" + (e && e.code)); return null; }
}
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patv-clerk-scale-"));
  const catalog = createCatalog({ file: path.join(dir, "catalog.db"), settings: () => SETTINGS, now: () => AT, log: { log() {}, error() {} },
    mainRead: async () => [], mediactl: async () => { throw new Error("offline"); }, tautulli: { configured: () => false } });
  let lists;
  try {
    await catalog.init();
    await timed("build synthetic library (" + FILMS + " films, " + SHOWS + " shows, " + EPISODES + " episodes)", () => build(catalog));
    await timed("before: rows({kind:'movie'}) - the old per-find read", async () => (await catalog.rows({ kind: "movie" })).length);
    await timed("before: rows({kind:'show'}) - the old per-find read", async () => (await catalog.rows({ kind: "show" })).length);
    await timed("before: word search of the whole line over episodes", async () => (await catalog.search("the episode of star trek where they communicate by telling stories", { kind: "episode", limit: 500 })).length);
    await timed("roots() - first ask after a catalog change", async () => { const r = await catalog.roots(); return r.movies.length + r.shows.length; });
    await timed("roots() - kept", async () => { const r = await catalog.roots(); return r.movies.length + r.shows.length; });
    await timed("byTitle(whole line, episode)", async () => (await catalog.byTitle("the episode of star trek where they communicate by telling stories", { kind: "episode" })).length);
    const finder = createFinder({ catalog, settings: () => SETTINGS, now: () => AT, rng: () => 0, lists: { shelves: async () => [], members: async () => [] },
      requests: { search: async () => [], details: async () => null }, vectors: { nearest: async () => [] } });
    const ctx = { seenKeys: [], maxSec: 4 * 3600, allowSeerr: false };
    for (const raw of ["the episode of star trek where they communicate by telling stories", "the episode of the simpsons where homer wears the pink shirt"]) {
      await timed("find(probe) " + raw.slice(0, 40), async () => (await finder.find({ ask: { kind: "show", title: raw }, raw, limit: 20, probe: true }, ctx)).rows.length);
    }
    await timed("find(recall) Darmok", async () => { const out = await finder.find({ ask: { kind: "episode", about: "Picard and an alien captain who speak in stories",
      guesses: [{ kind: "episode", show: "Star Trek: The Next Generation", season: 5, episode: 2, episode_title: "Darmok", confidence: .95 }] }, raw: "x", limit: 20 }, ctx);
      return out.rows.map((r) => r.label).join(", "); });
    await timed("find(recall) Stark Raving Dad", async () => { const out = await finder.find({ ask: { kind: "episode", about: "Homer wears a pink shirt to work",
      guesses: [{ kind: "episode", show: "The Simpsons", season: 3, episode: 1, episode_title: "Stark Raving Dad", confidence: .9 }] }, raw: "x", limit: 20 }, ctx);
      return out.rows.map((r) => r.label).join(", "); });
    await timed("find(about only, no recall) - films word search", async () => (await finder.find({ ask: { kind: "movie", about: "a " + VOCAB[17] + " and " + VOCAB[1001] + " in the " + VOCAB[2500] }, raw: "x", limit: 20 }, ctx)).rows.length);
    await timed("find(about only) - worst case: words in every row", async () => (await finder.find({ ask: { kind: "movie", about: "a quiet harbour lantern in winter" }, raw: "x", limit: 20 }, ctx)).rows.length);
    lists = createLists({ catalog, settings: () => SETTINGS, key: () => "offline", now: () => AT, request: async () => { throw new Error("offline"); } });
    const items = Array.from({ length: 250 }, (_, i) => ({ rank: i + 1, type: "movie", imdb: "tt" + (100001 + i * 97), title: "x", year: 2000 }));
    await timed("lists: add a 250-entry ranked list (match through roots)", async () => JSON.stringify(await lists.importSnapshot({ configured: [{ id: "9001", name: "IMDb Top 250", ranked: true, items }] })));
    await timed("lists: list() (the /admin/media panel)", async () => { const l = await lists.list(); return l.ok ? "matched=" + l.lists[0].matched : JSON.stringify(l); });
    await timed("lists: shelves() (what the clerk advertises)", async () => JSON.stringify((await lists.shelves()).map((r) => [r.name, r.count])));
  } finally {
    if (lists) await lists.close().catch(() => {});
    await catalog.close().catch(() => {});
    if (path.dirname(dir) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith("patv-clerk-scale-")) fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error("scale check failed:", e && e.code, String(e && e.message).slice(0, 120)); process.exitCode = 1; });
