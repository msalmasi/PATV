#!/usr/bin/env node
// 1.99??: offline fixture runner, never reads a live library or the site's database.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createCatalog } = require("../plexcatalog");
const { createFinder } = require("../plexfind");

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
async function fixtureRunner(fixture) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patv-clerk-fixture-"));
  const catalog = createCatalog({ file: path.join(dir, "catalog.db"), settings: () => ({ ...SETTINGS }), now: () => NOW,
    mainRead: async () => [], mediactl: async () => { throw new Error("Offline fixture only"); },
    tautulli: { configured: () => false }, log: { log() {} } });
  try {
    await catalog.init();
    await catalog.importSnapshot(fixture);
    const finder = createFinder({ catalog, settings: () => ({ ...SETTINGS }), now: () => NOW, deepMax: { movie: 2, show: 10 } });
    return {
      catalog,
      async find(request) {
        const ctx = request.context || {};
        return finder.find({ ask: request.ask || {}, raw: request.raw || "", exclude: request.exclude || [],
          limit: request.limit || 20, target: request.target || "stage" },
        { seenKeys: ctx.seen || [], maxSec: ctx.maxSec || 12 * 3600 });
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
  const runner = await fixtureRunner(JSON.parse(fs.readFileSync(file, "utf8")));
  const start = performance.now(), answers = [];
  try {
    for (const request of requests) {
      const tick = performance.now();
      const result = await runner.find(request);
      answers.push({ id: request.id, result, elapsed_ms: performance.now() - tick });
    }
    process.stdout.write(JSON.stringify({ answers, elapsed_ms: performance.now() - start }) + "\n");
  } finally { await runner.close(); }
}
if (require.main === module) main().catch(() => { process.stderr.write("Offline clerk evaluation failed.\n"); process.exitCode = 1; });
module.exports = { fixtureRunner, rawLine, SETTINGS, NOW };
