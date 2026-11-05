#!/usr/bin/env node
// 1.99??: offline fixture runner, never reads a live library or the site's database.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCatalog } = require("../plexcatalog");
const { createFinder, norm } = require("../plexfind");

const { createVectors, documentText, textHash } = require("../plexvectors");

const NOW = Date.UTC(2026, 10, 5, 12);
const SETTINGS = Object.freeze({ clerk_enabled: "everyone", clerk_block_ratings: "X,XXX,AO,R18,R18+",
  clerk_warn_ratings: "NR,Not Rated,Unrated", catalog_sync_min: 60,
  library_queue_max_items: 60, library_queue_max_hours: 12 });
function removeFixtureDir(dir) {
  const resolved = path.resolve(dir);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("patv-clerk-fixture-")) throw new Error("Unexpected fixture directory");
  fs.rmSync(resolved, { recursive: true, force: true });
}
function rawLine(line) {
  return String(line || "").replace(/^pepe\s+/i, "").replace(/^!plex\s*/i, "")
    .replace(/^(?:play|put on|watch)\s+/i, "").slice(0, 100);
}
async function fixtureRunner(fixture, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patv-clerk-fixture-"));
  const catalog = createCatalog({ file: path.join(dir, "catalog.db"), settings: () => ({ ...SETTINGS }), now: () => NOW,
    mainRead: async () => [], mediactl: async () => { throw new Error("Offline fixture only"); },
    tautulli: { configured: () => false }, log: { log() {} } });
  let currentSettings = { ...SETTINGS, clerk_embed: true, clerk_embed_k: 30 };
  try {
    await catalog.init();
    await catalog.importSnapshot(fixture);
    const vectors = createVectors({ catalog, settings: () => currentSettings, now: () => NOW });
    const seeded = options.vectors === undefined ? fixture.vectors || [] : options.vectors;
    if (!Array.isArray(seeded)) throw new Error("Invalid fixture vectors");
    if (seeded.length) {
      await vectors.configure(seeded[0]);
      const byKey = new Map((await catalog.rows()).map(row => [row.key, row]));
      const pair = { model: seeded[0].model, dim: seeded[0].dim };
      if (seeded.some(v => v.model !== pair.model || v.dim !== pair.dim)) throw new Error("Mixed fixture vector models");
      const pending = seeded.filter(v => byKey.has(String(v.key))).map(v => ({
        key: String(v.key), hash: textHash(documentText(byKey.get(String(v.key)))), v: v.v, scale: v.scale
      }));
      let batch = [];
      const send = async () => {
        if (!batch.length) return;
        const result = await vectors.put({ ...pair, vecs: batch });
        if (!result.ok || result.stored !== batch.length || result.rejected) throw new Error("Fixture vectors rejected");
        batch = [];
      };
      for (const value of pending) {
        if (batch.length >= 64 || Buffer.byteLength(JSON.stringify({ ...pair, vecs: [...batch, value] }), "utf8") > 16384) await send();
        batch.push(value);
      }
      await send();
    }
    let vectorCalls = 0;
    const trackedVectors = { status: () => vectors.status(), nearest: async options => { vectorCalls++; return vectors.nearest(options); } };
    const lookups = [];
    const requests = {
      async search(user, query) { lookups.push({ op: "search", query: norm(query) }); return (fixture.seerr && fixture.seerr.search[norm(query)]) || []; },
      async details(kind, tmdb) { lookups.push({ op: "details", kind, tmdb }); return (fixture.seerr && fixture.seerr.details[kind + ":" + tmdb]) || null; },
    };
    const finder = createFinder({ catalog, requests, vectors: trackedVectors, settings: () => currentSettings, now: () => NOW, deepMax: { movie: 2, show: 10 } });
    return {
      catalog,
      async find(request) {
        const ctx = request.context || {};
        const before = lookups.length, beforeVector = vectorCalls;
        currentSettings = { ...SETTINGS, clerk_embed: ctx.embed === true && !request.no_embed, clerk_embed_k: 30 };
        if (request.op === "documents") return { rows: (await catalog.rows()).map(row => ({ key: row.key, text: documentText(row), hash: textHash(documentText(row)) })) };
        if (request.op === "shelves") return { ...(await (finder.shelves ? finder.shelves() : catalog.shelves())), find_count: 0, vector_count: 0, lookup_count: 0 };
        const qvec = !request.no_embed && !ctx.embed_down && ctx.embed === true
          ? Object.hasOwn(request, "qvec") ? request.qvec : (fixture.query_vectors || {})[request.id] : null;
        const result = await finder.find({ ask: request.ask || {}, raw: request.raw || "", exclude: request.exclude || [],
          qvec, limit: request.limit || 20, target: request.target || "stage", browse: request.ask && request.ask.action === "browse", probe: request.probe === true },
        { seenKeys: ctx.seen || [], maxSec: ctx.maxSec || 12 * 3600,
          user: { userId: "fixture-cedar", username: "fixture-cedar" },
          allowSeerr: ctx.requests === true && !ctx.adult && !["pm", "tg"].includes(ctx.via) });
        // This fixture projection mirrors the route's preview. Real auth/once-only requests are tested through plexchat.
        if (result.seerr) {
          const reason = ctx.clerk_requests === "off" ? "clerk_off" : ctx.request_reason || null;
          result.request = reason ? { may: false, reason } : { may: true, cost: ctx.request_cost || { with: "free", price: 0 } };
        }
        result.find_count = 1;
        result.lookup_count = lookups.length - before;
        result.vector_count = vectorCalls - beforeVector;
        return result;
      },
      async close() { await catalog.close(); removeFixtureDir(dir); },
    };
  } catch (e) { await catalog.close().catch(() => {}); removeFixtureDir(dir); throw e; }
}

async function main() {
  const args = process.argv.slice(2), at = args.indexOf("--catalog");
  const file = at >= 0 ? args[at + 1] : path.join(__dirname, "../test/fixtures/clerk_catalog.json");
  if (!file) throw new Error("A fixture catalog path is required");
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  const requests = Array.isArray(input.requests) ? input.requests : [input];
  if (requests.length > 1000) throw new Error("At most 1000 fixture requests");
  const runner = await fixtureRunner(JSON.parse(fs.readFileSync(file, "utf8")), { vectors: input.vectors });
  const start = performance.now(), answers = [];
  try {
    for (const request of requests) {
      const tick = performance.now();
      const result = await runner.find({ ...request, no_embed: args.includes("--no-embed") || input.no_embed === true });
      answers.push({ id: request.id, result, elapsed_ms: performance.now() - tick });
    }
    process.stdout.write(JSON.stringify({ answers, elapsed_ms: performance.now() - start }) + "\n");
  } finally { await runner.close(); }
}
if (require.main === module) main().catch(() => { process.stderr.write("Offline clerk evaluation failed.\n"); process.exitCode = 1; });
module.exports = { fixtureRunner, rawLine, SETTINGS, NOW };
