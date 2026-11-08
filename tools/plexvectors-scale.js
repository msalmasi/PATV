#!/usr/bin/env node
// plexvectors 1.99amo: offline scale check for the clerk's MOVIE vector search. Builds a SYNTHETIC library shaped like the real
// one (default 30,682 films / 4,257 shows / 220,896 episodes - the 2026-11-08 sync) in a temp dir, stores a 768-dim int8 vector
// for every film, and times what a chat ask does: nearest() over every film (an unfiltered "a film about ..."), over a filtered
// half (one genre), the clerk's whole find() with a query vector, and a backfill step (embed_put) between asks. Prints the
// process memory before and after. Never reads a live library or the site's database.
// Usage: node --expose-gc tools/plexvectors-scale.js [films] [dim] [episodes]
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { createCatalog } = require("../plexcatalog");
const { createVectors, documentText, textHash, quantize } = require("../plexvectors");
const { createFinder } = require("../plexfind");

const arg = (i, fallback) => Number(process.argv[2 + i]) > 0 ? Math.floor(Number(process.argv[2 + i])) : fallback;
const FILMS = arg(0, 30682), DIM = arg(1, 768), EPISODES = arg(2, 220896);
const SHOWS = 4257, SPARE = 64, MODEL = "synthetic-embedding-v1", AT = Date.UTC(2026, 10, 8, 6);
const SETTINGS = { clerk_embed: true, clerk_embed_k: 30, clerk_block_ratings: "X,XXX,AO,R18,R18+", clerk_warn_ratings: "NR,Not Rated,Unrated",
  library_queue_max_items: 60, library_queue_max_hours: 12 };
const PROSE = "Original synthetic prose about a long afternoon by the harbour. ".repeat(8);
let seed = 2463534242;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 255) - 127; };
const mb = (n) => (n / 1048576).toFixed(1) + " MB";
function memory() {
  if (global.gc) { global.gc(); global.gc(); }
  const m = process.memoryUsage();
  return { rss: m.rss, heap: m.heapUsed, buffers: m.arrayBuffers };
}
const median = (list) => { const s = list.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
async function timed(label, fn) {
  const t = performance.now();
  try { const v = await fn(); console.log(label.padEnd(66), (performance.now() - t).toFixed(1).padStart(8) + " ms ", v === undefined ? "" : v); return v; }
  catch (e) { console.log(label.padEnd(66), (performance.now() - t).toFixed(1).padStart(8) + " ms ", "FAIL code=" + (e && e.code) + " " + String(e && e.message).slice(0, 80)); return null; }
}

async function build(catalog) {
  await catalog.write(async (tx) => {
    // films alternate Drama / Comedy (a one-genre ask is half the library); shows and episodes as on prod
    for (const [n, base, type, section, rating, title] of [[FILMS + SPARE, 1000000, "movie", "1", "PG", "Synthetic film "],
      [SHOWS, 3000000, "show", "2", "TV-14", "Synthetic show "], [EPISODES, 4000000, "episode", "2", "TV-14", "Synthetic chapter "]]) {
      const show = "CASE WHEN ?='episode' THEN CAST(3000000+((x-1)%" + SHOWS + ")+1 AS TEXT) END";
      await tx.run(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?)
        INSERT INTO plex_catalog(key,type,title,title_fold,show_key,show_fold,section,content_rating,data,seen_at,server_plays,pad_plays)
        SELECT CAST(?+x AS TEXT),?,?||x,'synthetic',${show},'synthetic',?,?,
          json_object('key',CAST(?+x AS TEXT),'type',?,'section',?,'title',?||x,'show_key',${show},'show',CASE WHEN ?='episode' THEN 'Synthetic show' END,
            'content_rating',?,'year',1950+x%70,'duration',5400,'genres',json_array(CASE WHEN x%2=0 THEN 'Drama' ELSE 'Comedy' END),'summary',?),1,0,0 FROM n`,
      [n, base, type, title, type, section, rating, base, type, section, title, type, type, rating, PROSE]);
    }
  });
  const films = (await catalog.admin.read("SELECT key,data FROM plex_catalog WHERE type='movie' ORDER BY key")).map((r) => ({ key: r.key, data: JSON.parse(r.data) }));
  const stored = films.slice(0, FILMS), spare = films.slice(FILMS);
  let first = null;
  await catalog.write(async (tx) => {
    for (let start = 0; start < stored.length; start += 64) {
      const batch = stored.slice(start, start + 64), params = [];
      for (const r of batch) {
        const buffer = Buffer.from(Int8Array.from({ length: DIM }, random).buffer);
        if (!first) first = buffer;
        params.push(r.key, MODEL, DIM, textHash(documentText(r.data)), 1, buffer, "movie", null);
      }
      await tx.run("INSERT INTO plex_vectors(key,model,dim,hash,scale,v,kind,show_key) VALUES " + batch.map(() => "(?,?,?,?,?,?,?,?)").join(","), params);
    }
    await tx.run("UPDATE plex_vector_docs SET hash=(SELECT hash FROM plex_vectors v WHERE v.key=plex_vector_docs.key),dirty=0 WHERE key IN (SELECT key FROM plex_vectors)");
  });
  return { stored, spare, query: { model: MODEL, dim: DIM, scale: 1, v: first.toString("base64") } };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patv-vector-scale-"));
  const catalog = createCatalog({ file: path.join(dir, "catalog.db"), settings: () => SETTINGS, now: () => AT, log: { log() {}, error() {} },
    mainRead: async () => [], mediactl: async () => { throw new Error("offline"); }, tautulli: { configured: () => false } });
  let vectors;
  try {
    await catalog.importSnapshot({ v: 1, allow_list_set: true, rows: [], shelves: [], sections: [
      { id: "1", title: "Synthetic Cinema", type: "movie", policy: "allowed" }, { id: "2", title: "Synthetic Series", type: "show", policy: "allowed" }] });
    vectors = createVectors({ catalog, settings: () => SETTINGS, now: () => AT, log: { log() {}, error() {} } });
    await vectors.configure({ model: MODEL, dim: DIM });
    let built;
    await timed("build (" + FILMS + " films with " + DIM + "-dim vectors, " + SHOWS + " shows, " + EPISODES + " episodes)", async () => { built = await build(catalog); });
    const { stored, spare, query } = built;
    const all = stored.map((r) => r.key), drama = stored.filter((r) => r.data.genres[0] === "Drama").map((r) => r.key);
    const before = memory();
    console.log("memory before any search: rss " + mb(before.rss) + ", heap " + mb(before.heap) + ", array buffers " + mb(before.buffers));
    const ask = (keys) => vectors.nearest({ qvec: query, kind: "movie", keys, budgetMs: 400 });
    const describe = (hits) => hits.length + " hits" + (hits.length ? ", top " + hits[0].key + (hits[0].key === all[0] ? " (the planted nearest)" : "") : " (word search fallback)");
    await timed("nearest(): every film (" + all.length + " keys) - first ask after a start", async () => describe(await ask(all)));
    await timed("  ... the background work it started (idle())", async () => { await vectors.idle(); });
    const warm = [];
    let last = [];
    for (let i = 0; i < 7; i++) { const t = performance.now(); last = await ask(all); warm.push(performance.now() - t); }
    console.log("nearest(): every film, warm x7".padEnd(66), median(warm).toFixed(1).padStart(8) + " ms ", "median; max " + Math.max(...warm).toFixed(1) + " ms; " + describe(last));
    const filtered = [];
    for (let i = 0; i < 7; i++) { const t = performance.now(); last = await ask(drama); filtered.push(performance.now() - t); }
    console.log(("nearest(): one genre (" + drama.length + " keys), x7").padEnd(66), median(filtered).toFixed(1).padStart(8) + " ms ", "median; max " + Math.max(...filtered).toFixed(1) + " ms; " + describe(last));
    const after = memory();
    console.log("memory after warm searches: rss " + mb(after.rss) + " (+" + mb(after.rss - before.rss) + "), heap " + mb(after.heap) + " (+" + mb(after.heap - before.heap) +
      "), array buffers " + mb(after.buffers) + " (+" + mb(after.buffers - before.buffers) + ")");
    // a backfill step between asks: the bot stores 32 new film vectors (embed_put, split under the 16 KB body like
    // pepe_plexembed.put_batches - 12 a call at 768 dims), then a person asks again
    const fresh = await catalog.getByKeys(spare.slice(0, 32).map((r) => r.key));
    const put = await timed("embed_put: 32 new film vectors (3 calls)", async () => {
      let stored = 0;
      for (let i = 0; i < fresh.length; i += 12) stored += (await vectors.put({ model: MODEL, dim: DIM, vecs: fresh.slice(i, i + 12).map((r) =>
        ({ key: r.key, hash: textHash(documentText(r)), ...quantize(Array.from({ length: DIM }, (_, k) => k === 0 ? 1 : 0)) })) })).stored || 0;
      return stored + " stored"; });
    if (put) {
      const keys = all.concat(fresh.map((r) => r.key));
      const step = [];
      for (let i = 0; i < 5; i++) { const t = performance.now(); last = await ask(keys); step.push(performance.now() - t); await vectors.idle(); }
      console.log("nearest(): every film, the 5 asks after a put".padEnd(66), median(step).toFixed(1).padStart(8) + " ms ", "median; max " + Math.max(...step).toFixed(1) + " ms; " + describe(last));
      const unit = { model: MODEL, dim: DIM, ...quantize(Array.from({ length: DIM }, (_, i) => i === 0 ? 1 : 0)) };
      await vectors.idle();
      await timed("nearest(): the new films findable after the put", async () => {
        const hits = await vectors.nearest({ qvec: unit, kind: "movie", keys, budgetMs: 400, limit: 50 });
        return hits.filter((h) => fresh.some((r) => r.key === h.key)).length + " of 32 new films in the top 50"; });
    }
    const finder = createFinder({ catalog, settings: () => SETTINGS, now: () => AT, rng: () => 0, deepMax: { movie: 2, show: 10 }, lists: { shelves: async () => [], members: async () => [] },
      requests: { search: async () => [], details: async () => null }, vectors });
    const ctx = { seenKeys: [], maxSec: 4 * 3600, allowSeerr: false };
    for (const [label, want] of [["find(): a film about ... (every film)", { kind: "movie", about: "a lighthouse keeper who forgets the sea" }],
      ["find(): a drama about ... (one genre)", { kind: "movie", genres: ["Drama"], about: "a lighthouse keeper who forgets the sea" }]]) {
      await finder.find({ ask: want, raw: "x", limit: 20, qvec: query }, ctx).catch(() => null); // the kept roots are read once per catalog version
      await vectors.idle();
      await timed(label, async () => { const out = await finder.find({ ask: want, raw: "x", limit: 20, qvec: query }, ctx);
        return out.rows.length + " rows, " + out.rows.filter((r) => r.why === "vector").length + " from vectors"; });
    }
  } finally {
    if (vectors) await vectors.idle().catch(() => {});
    await catalog.close().catch(() => {});
    if (path.dirname(dir) === path.resolve(os.tmpdir()) && path.basename(dir).startsWith("patv-vector-scale-")) fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error("scale check failed:", e && e.code, String(e && e.message).slice(0, 160)); process.exitCode = 1; });
