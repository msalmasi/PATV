"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { performance } = require("node:perf_hooks");
const { createCatalog } = require(process.env.PATV_SITE_DIR ? path.join(process.env.PATV_SITE_DIR, "plexcatalog") : "../plexcatalog");
const { createVectors, documentText, textHash, quantize, decodeVector } = require("../plexvectors");
const AT = Date.UTC(2026, 10, 5, 12), MODEL = "fixture-embedding-v1";
const row = (key, title, extra = {}) => ({ key: String(key), type: "movie", title, section: "1", content_rating: "PG", year: 2001,
  genres: ["Comedy"], summary: "Original fixture prose about a rainy afternoon.", duration: 5400, ...extra });
const fixture = () => ({ v: 1, allow_list_set: true, sections: [
  { id: "1", title: "Fixture films", type: "movie", policy: "allowed" },
  { id: "2", title: "Fixture shows", type: "show", policy: "allowed" },
  { id: "3", title: "Denied fixture section", type: "movie", policy: "adult" },
], rows: [row(1, "Raincoat"), row(2, "Sunny Turn", { genres: ["Drama"] }), row(3, "Denied marker", { section: "3" }),
  row(4, "Blocked marker", { content_rating: "X" }), row(20, "Sky Office", { type: "show", section: "2", content_rating: "TV-14" }),
  row(21, "Launch Day", { type: "episode", section: "2", show_key: "20", show: "Sky Office", season: 1, episode: 1 }),
  row(22, "Return Day", { type: "episode", section: "2", show_key: "20", show: "Sky Office", season: 1, episode: 2 }),
  row(30, "Other Show", { type: "show", section: "2" }),
  row(31, "Other Launch", { type: "episode", section: "2", show_key: "30", show: "Other Show", season: 1, episode: 1 })], shelves: [] });

async function setup(t, snapshot = fixture(), overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plexvectors-test-"));
  const cfg = { clerk_embed: true, clerk_embed_k: 30, clerk_block_ratings: "X,XXX,AO,R18,R18+" };
  const catalog = createCatalog({ file: path.join(dir, "catalog.db"), now: () => AT, settings: () => cfg, noFts: true,
    mainRead: async () => [], mediactl: async () => { throw new Error("no network"); }, tautulli: { configured: () => false },
    log: { log() {}, error() {} } });
  t.after(async () => {
    await catalog.close();
    const resolved = fs.realpathSync(dir);
    assert.ok(path.basename(resolved).startsWith("plexvectors-test-") && path.dirname(resolved) === fs.realpathSync(os.tmpdir()));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  await catalog.importSnapshot(snapshot);
  const vectors = createVectors({ catalog, settings: () => cfg, now: () => AT, ...overrides });
  await vectors.configure({ model: MODEL, dim: 4 });
  return { cfg, catalog, vectors, snapshot };
}
const qvec = (values = [1, 0, 0, 0], model = MODEL) => ({ model, dim: values.length, ...quantize(values) });
async function store(h, key, values = [1, 0, 0, 0]) {
  const current = (await h.catalog.getByKeys([String(key)]))[0];
  const value = { key: String(key), hash: textHash(documentText(current)), ...quantize(values) };
  const result = await h.vectors.put({ model: MODEL, dim: values.length, vecs: [value] });
  assert.equal(result.stored, 1);
  return value;
}
async function change(h, key, patch) {
  await h.catalog.write(async (tx) => {
    const stored = (await tx.all("SELECT data FROM plex_catalog WHERE key=?", [String(key)]))[0];
    const data = { ...JSON.parse(stored.data), ...patch };
    await tx.run("UPDATE plex_catalog SET data=?,title=?,content_rating=?,section=? WHERE key=?", [JSON.stringify(data), data.title, data.content_rating, data.section, String(key)]);
  });
}

test("metadata text is bounded and explicit; int8 quantization is canonical with positive scale", () => {
  const value = row(1, "Title", { file: "SECRET_PATH", tokens: "SECRET_TOKEN", summary: "s".repeat(1400) });
  const text = documentText(value);
  assert.ok(text.length <= 1200);
  assert.equal(text.includes("SECRET"), false);
  assert.equal(textHash(text).length, 64);
  const compressed = quantize([.5, -1, .25, 0]);
  const decoded = decodeVector(compressed, 4);
  assert.deepEqual([...decoded.vector], [64, -127, 32, 0]);
  assert.equal(decoded.bytes.length, 4);
  for (const invalid of [[], [0, 0], [NaN], [Infinity]]) assert.throws(() => quantize(invalid), /bad_vector/);
  for (const invalid of [{ ...compressed, scale: 0 }, { ...compressed, v: "AAAAAA==" }, { ...compressed, v: compressed.v + "\n" }, { ...compressed, v: "bad!" }])
    assert.equal(decodeVector(invalid, 4), null);
});

test("off paths do not initialize or read the catalog, and model configuration is registry-supplied", async () => {
  const catalog = { write() { throw new Error("must not initialize"); }, read() { throw new Error("must not read"); } };
  const vectors = createVectors({ catalog, settings: () => ({ clerk_embed: false }) });
  assert.equal((await vectors.todo()).code, "embed_off");
  assert.equal((await vectors.put({})).code, "embed_off");
  assert.equal((await vectors.configure({ model: MODEL, dim: 4 })).code, "embed_off");
  assert.deepEqual(await vectors.nearest({}), []);
  assert.equal((await vectors.status()).enabled, false);
});

test("todo contains only permitted text, validates model pairs, pages and resumes without losing work", async (t) => {
  const h = await setup(t);
  await assert.rejects(h.vectors.configure({ model: "bad\nmodel", dim: 4 }), /bad_embed_model/);
  await assert.rejects(h.vectors.configure({ model: MODEL, dim: 4097 }), /bad_embed_model/);
  const first = await h.vectors.todo({ limit: 2 });
  assert.equal(first.ok, true);
  assert.equal(first.model, MODEL);
  assert.equal(first.rows.length, 2);
  assert.equal(first.left, 7);
  const next = await h.vectors.todo({ limit: 2, after: first.next });
  assert.equal(next.rows.length, 2);
  assert.equal(first.rows.some((r) => next.rows.some((n) => n.key === r.key)), false);
  const all = await h.vectors.todo({ limit: 1000 });
  assert.equal(all.rows.length, 7);
  assert.equal(JSON.stringify(all).includes("marker"), false);
  for (const item of all.rows) assert.equal(item.hash, textHash(item.text));
  await store(h, all.rows[0].key);
  assert.equal((await h.vectors.todo()).rows.some((r) => r.key === all.rows[0].key), false);
  // A restart's only persisted state is on the shared catalog file.
  const reopened = createVectors({ catalog: h.catalog, settings: () => h.cfg, now: () => AT });
  assert.equal((await reopened.todo()).left, 6);
});

test("store/replace are atomic and reject malformed vectors, over-16KB payloads, missing or denied rows", async (t) => {
  const h = await setup(t), original = await store(h, "1");
  assert.equal((await h.catalog.read("SELECT length(v) AS bytes FROM plex_vectors"))[0].bytes, 4);
  await store(h, "1", [0, 1, 0, 0]);
  assert.equal((await h.catalog.read("SELECT COUNT(*) AS n FROM plex_vectors"))[0].n, 1);
  for (const patch of [{ v: "AA==" }, { scale: -1 }, { hash: "bad" }, { key: "x" }, { v: "AAAAAA==" }])
    await assert.rejects(h.vectors.put({ model: MODEL, dim: 4, vecs: [{ ...original, ...patch }] }), /bad_vectors/);
  await assert.rejects(h.vectors.put({ model: MODEL, dim: 4, vecs: [original, original] }), /bad_vectors/);
  await assert.rejects(h.vectors.put({ model: MODEL, dim: 4, note: "x".repeat(16384), vecs: [original] }), /bad_vectors/);
  const result = await h.vectors.put({ model: MODEL, dim: 4, vecs: ["3", "4", "999"].map((key) => ({ ...original, key })) });
  assert.deepEqual(result, { ok: true, stored: 0, rejected: 3 });
  assert.equal((await h.vectors.put({ model: "different-model", dim: 4, vecs: [original] })).code, "embed_model");
});

test("hash/model/dimension staleness, non-text edits, and row deletion are reflected immediately", async (t) => {
  const h = await setup(t), saved = await store(h, "1");
  const find = () => h.vectors.nearest({ qvec: qvec(), kind: "movie", keys: ["1"] });
  assert.equal((await find()).length, 1);
  await change(h, "1", { summary: "A newly written space mission." });
  assert.deepEqual(await find(), []);
  const changed = (await h.vectors.todo()).rows.find((r) => r.key === "1");
  assert.notEqual(changed.hash, saved.hash);
  assert.equal((await h.vectors.put({ model: MODEL, dim: 4, vecs: [saved] })).rejected, 1);
  await store(h, "1");
  await change(h, "1", { rating: 8 });
  assert.deepEqual(await find(), []); // conservatively invalid until its dirty text hash is refreshed
  assert.equal((await h.vectors.todo()).rows.some((r) => r.key === "1"), false); // unchanged text needs no provider call
  assert.equal((await find()).length, 1);
  await h.vectors.configure({ model: "fixture-embedding-v2", dim: 4 });
  assert.deepEqual(await find(), []);
  assert.equal((await h.vectors.todo()).rows.some((r) => r.key === "1"), true);
  await h.vectors.configure({ model: MODEL, dim: 3 });
  assert.deepEqual(await find(), []);
  await h.catalog.write((tx) => tx.run("DELETE FROM plex_catalog WHERE key='1'"));
  assert.equal((await h.catalog.read("SELECT COUNT(*) AS n FROM plex_vectors WHERE key='1'"))[0].n, 0);
});

test("current rating, parent-show and section policy revoke cached vectors and never expose text", async (t) => {
  const h = await setup(t);
  await store(h, "1"); await store(h, "21");
  assert.equal((await h.vectors.nearest({ qvec: qvec(), kind: "movie", keys: ["1"] })).length, 1);
  h.cfg.clerk_block_ratings += ",TV-14";
  assert.deepEqual(await h.vectors.nearest({ qvec: qvec(), kind: "episode", show_key: "20", keys: ["21"] }), []);
  assert.equal((await h.catalog.read("SELECT COUNT(*) AS n FROM plex_vectors WHERE key='21'"))[0].n, 0);
  assert.equal(JSON.stringify(await h.vectors.todo()).includes("Sky Office"), false);
  await h.catalog.write((tx) => tx.run("UPDATE plex_sections SET policy='off' WHERE id='1'"));
  assert.deepEqual(await h.vectors.nearest({ qvec: qvec(), kind: "movie", keys: ["1"] }), []);
  assert.equal((await h.catalog.read("SELECT COUNT(*) AS n FROM plex_vectors"))[0].n, 0);
  assert.equal(JSON.stringify(await h.vectors.todo()).includes("Raincoat"), false);
});

test("filtered nearest uses only supplied movie keys or one named show; query mismatch and budgets fall back", async (t) => {
  const h = await setup(t);
  await store(h, "1", [1, 0, 0, 0]); await store(h, "2", [0, 1, 0, 0]);
  await store(h, "21", [1, 0, 0, 0]); await store(h, "22", [.8, .2, 0, 0]); await store(h, "31", [1, 0, 0, 0]);
  assert.deepEqual((await h.vectors.nearest({ qvec: qvec(), kind: "movie", keys: ["2"] })).map((r) => r.key), ["2"]);
  assert.deepEqual((await h.vectors.nearest({ qvec: qvec(), kind: "episode", show_key: "20", keys: ["21", "22", "31"] })).map((r) => r.key), ["21", "22"]);
  assert.deepEqual(await h.vectors.nearest({ qvec: qvec(), kind: "episode", keys: ["21"] }), []);
  assert.deepEqual(await h.vectors.nearest({ qvec: qvec([1, 0, 0, 0], "old-model"), kind: "movie", keys: ["1"] }), []);
  assert.deepEqual(await h.vectors.nearest({ qvec: qvec([1, 0, 0]), kind: "movie", keys: ["1"] }), []);
  assert.deepEqual(await h.vectors.nearest({ qvec: qvec(), kind: "episode", show_key: "20", keys: Array(3001).fill("21") }), []);
  assert.deepEqual(await h.vectors.nearest({ qvec: qvec(), kind: "movie", keys: Array(20001).fill("1") }), []);
  let clock = 0;
  const slow = createVectors({ catalog: h.catalog, settings: () => h.cfg, now: () => AT, clock: () => clock += 500 });
  assert.deepEqual(await slow.nearest({ qvec: qvec(), kind: "movie", keys: ["1"], budgetMs: 400 }), []);
  h.cfg.clerk_embed = false;
  assert.deepEqual(await h.vectors.nearest({ qvec: qvec(), kind: "movie", keys: ["1"] }), []);
});

test("a policy change during final reread cannot use a formerly allowed cache; queued initialization obeys wall deadline", async (t) => {
  const h = await setup(t);
  await store(h, "1");
  const original = h.catalog.read;
  const adapter = { ...h.catalog, read: async (sql, ...rest) => {
    const result = await original(sql, ...rest);
    if (sql.startsWith("SELECT c.key,c.data")) h.cfg.clerk_block_ratings += ",PG";
    return result;
  } };
  const vectors = createVectors({ catalog: adapter, settings: () => h.cfg, now: () => AT });
  assert.deepEqual(await vectors.nearest({ qvec: qvec(), kind: "movie", keys: ["1"] }), []);
  let finish;
  const held = new Promise((resolve) => { finish = resolve; });
  const slowCatalog = { ...h.catalog, write: async (fn) => { await held; return h.catalog.write(fn); } };
  const slow = createVectors({ catalog: slowCatalog, settings: () => h.cfg, now: () => AT });
  const before = performance.now();
  assert.deepEqual(await slow.nearest({ qvec: qvec(), kind: "movie", keys: ["1"], budgetMs: 5 }), []);
  assert.ok(performance.now() - before < 100, "a held writer must not hold the response open");
  finish();
  await slow.init(); // finish the bounded background initialization before closing its test catalog
});

test("10k movie plus one 3k-episode search stays bounded and warm cosine searches finish under 50ms", async (t) => {
  const snapshot = fixture();
  snapshot.rows = [row(900000, "One indexed show", { type: "show", section: "2" })];
  const movies = [], episodes = [];
  for (let i = 0; i < 10000; i++) { const key = String(100000 + i); movies.push(key); snapshot.rows.push(row(key, "Synthetic film " + i)); }
  for (let i = 0; i < 3000; i++) { const key = String(200000 + i); episodes.push(key); snapshot.rows.push(row(key, "Synthetic chapter " + i,
    { type: "episode", section: "2", show_key: "900000", show: "One indexed show", season: 1, episode: i + 1 })); }
  const h = await setup(t, snapshot);
  await h.vectors.configure({ model: MODEL, dim: 768 });
  let seed = 123456789, first;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 255) - 127; };
  await h.catalog.write(async (tx) => {
    for (let start = 1; start < snapshot.rows.length; start += 64) {
      const batch = snapshot.rows.slice(start, start + 64), params = [];
      for (const r of batch) {
        const bytes = Int8Array.from({ length: 768 }, random), buffer = Buffer.from(bytes.buffer);
        if (!first) first = buffer;
        params.push(r.key, MODEL, 768, textHash(documentText(r)), 1, buffer, r.type, r.show_key || null);
      }
      await tx.run("INSERT INTO plex_vectors(key,model,dim,hash,scale,v,kind,show_key) VALUES " + batch.map(() => "(?,?,?,?,?,?,?,?)").join(","), params);
    }
    await tx.run("UPDATE plex_vector_docs SET hash=(SELECT hash FROM plex_vectors v WHERE v.key=plex_vector_docs.key),dirty=0 WHERE key IN (SELECT key FROM plex_vectors)");
  });
  const query = { model: MODEL, dim: 768, scale: 1, v: first.toString("base64") };
  const movieAsk = { qvec: query, kind: "movie", keys: movies }, episodeAsk = { qvec: query, kind: "episode", show_key: "900000", keys: episodes };
  const cold = performance.now();
  assert.equal((await h.vectors.nearest(movieAsk))[0].key, movies[0]);
  assert.equal((await h.vectors.nearest(episodeAsk)).length, 30);
  const coldMs = performance.now() - cold;
  const timings = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    assert.equal((await h.vectors.nearest(movieAsk)).length, 30);
    assert.equal((await h.vectors.nearest(episodeAsk)).length, 30);
    timings.push(performance.now() - started);
  }
  const median = timings.sort((a, b) => a - b)[2];
  t.diagnostic(`13k x 768 int8: warm movie+show median ${median.toFixed(2)}ms; cold pair ${coldMs.toFixed(2)}ms`);
  assert.ok(median < 50, "warm 10k movies + 3k episode show must fit 50ms");
  assert.equal((await h.catalog.read("SELECT MIN(length(v)) AS low,MAX(length(v)) AS high,COUNT(*) AS n FROM plex_vectors"))[0].low, 768);
  assert.equal((await h.catalog.read("SELECT SUM(length(v)) AS bytes FROM plex_vectors"))[0].bytes, 13000 * 768);
});
