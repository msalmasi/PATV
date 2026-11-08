"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { performance } = require("node:perf_hooks");
const { createCatalog } = require(process.env.PATV_SITE_DIR ? path.join(process.env.PATV_SITE_DIR, "plexcatalog") : "../plexcatalog");
const { createVectors, documentText, textHash, quantize, decodeVector, MAX_MOVIES } = require("../plexvectors");
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

async function setup(t, snapshot = fixture(), overrides = {}, catalogOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plexvectors-test-"));
  const cfg = { clerk_embed: true, clerk_embed_k: 30, clerk_block_ratings: "X,XXX,AO,R18,R18+" };
  const catalog = createCatalog({ file: path.join(dir, "catalog.db"), now: () => AT, settings: () => cfg, noFts: true,
    mainRead: async () => [], mediactl: async () => { throw new Error("no network"); }, tautulli: { configured: () => false },
    log: { log() {}, error() {} }, ...catalogOptions });
  let vectors = null;
  t.after(async () => {
    if (vectors && typeof vectors.idle === "function") await vectors.idle().catch(() => {}); // a count started in the background
    await catalog.close();
    const resolved = fs.realpathSync(dir);
    assert.ok(path.basename(resolved).startsWith("plexvectors-test-") && path.dirname(resolved) === fs.realpathSync(os.tmpdir()));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  await catalog.importSnapshot(snapshot);
  vectors = createVectors({ catalog, settings: () => cfg, now: () => AT, ...overrides });
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
  assert.deepEqual(await h.vectors.nearest({ qvec: qvec(), kind: "movie", keys: Array(MAX_MOVIES + 1).fill("1") }), []);   // 1.99amo: 100,000 (was 20,000)
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

// ── plexvectors 1.99amg (prod 2026-11-08): Pepe's summary-embedding backfill was refused on every call ("[plexchat] embed_todo:
// refused catalog_down", 61 times) and /admin/media said "Summary embeddings: waiting for the bot's model configuration." ──
// Proven on prod (a read-only probe through the site's own plexcatalog / plexvectors, every write skipped): 255,835 catalog rows,
// 255,835 docs all dirty, 0 vectors, plex_vector_meta already nomic-embed-text:v1.5 / 768 (the bot's configure had landed).
// todo()'s first catalog read - prepare(): every dirty doc joined with the catalog, policy-checked, then sorted ("SEARCH d USING
// COVERING INDEX plex_vector_docs_dirty (dirty=?) ... USE TEMP B-TREE FOR ORDER BY") - took 565-713 ms with no budget, and the
// 400 ms chat search budget stopped it (too_broad) on every call, which plexchat answered as catalog_down. The counts read behind
// the card ("SCAN s | SEARCH c USING INDEX plex_catalog_section (section=?)") took 1.2-1.4 s, so status() threw and the card fell
// back to an embed state with no model: "waiting for the bot's model configuration".
const CATALOG = require(process.env.PATV_SITE_DIR ? path.join(process.env.PATV_SITE_DIR, "plexcatalog") : "../plexcatalog");
const PROD = { films: 30682, shows: 4257, episodes: 220896 };
async function bigCatalog(h, { blocked = 10 } = {}) {
  // prod's shape: films in section 1, shows and their episodes in section 2, every summary new (dirty); a few blocked films that
  // slipped past a sync must never be offered, counted or stored
  const prose = "Original synthetic prose about a long afternoon by the harbour. ".repeat(8);
  await h.catalog.write(async (tx) => {
    for (const [n, base, type, section, rating, title] of [[PROD.films, 1000000, "movie", "1", "PG", "Synthetic film "],
      [PROD.shows, 3000000, "show", "2", "TV-14", "Synthetic show "], [PROD.episodes, 2000000, "episode", "2", "TV-14", "Synthetic chapter "],
      [blocked, 4000000, "movie", "1", "X", "Blocked marker "]]) {
      const show = "CASE WHEN ?='episode' THEN CAST(3000000+((x-1)%" + PROD.shows + ")+1 AS TEXT) END";
      await tx.run(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?)
        INSERT INTO plex_catalog(key,type,title,title_fold,show_key,show_fold,section,content_rating,data,seen_at,server_plays,pad_plays)
        SELECT CAST(?+x AS TEXT),?,?||x,'synthetic',${show},'synthetic',?,?,
          json_object('key',CAST(?+x AS TEXT),'type',?,'section',?,'title',?||x,'show_key',${show},'show',CASE WHEN ?='episode' THEN 'Synthetic show' END,
            'content_rating',?,'year',2001,'genres',json_array('Drama'),'summary',?),1,0,0 FROM n`,
      [n, base, type, title, type, section, rating, base, type, section, title, type, type, rating, prose]);
    }
  });
  return PROD.films + PROD.shows + PROD.episodes;
}
// Every statement a call read, with its query plan: none may walk the whole catalog or sort a whole table (the cost follows the page).
const WALKS = [/TEMP B-TREE/, /\bSCAN (c|d|v|p|plex_catalog|plex_vector_docs|plex_vectors)\b/, /INDEX plex_catalog_section\b/];
async function bounded(h, armed, label) {
  const seen = [...new Set(armed.map((j) => j.sql))]; armed.length = 0;
  assert.ok(seen.length > 0, label + ": read something");
  for (const sql of seen) {
    const plan = (await h.catalog.admin.read("EXPLAIN QUERY PLAN " + sql)).map((r) => r.detail).join(" | ");
    assert.ok(!WALKS.some((re) => re.test(plan)), label + ": " + sql.replace(/\s+/g, " ").slice(0, 160) + " -> " + plan);
  }
  armed.length = 0;
}
const lanes = (armed) => [...new Set(armed.map((j) => j.budgetMs))].sort();
const vecs = (rows, values = [1, 0, 0, 0]) => rows.map((r) => ({ key: r.key, hash: r.hash, ...quantize(values) }));

test("prod shape (255,835 rows, every summary new): todo / put / the card answer on the background lane, page from the bot's cursor, never walk the catalog", { timeout: 300000 }, async (t) => {
  const armed = [], h = await setup(t, { ...fixture(), rows: [] }, {}, { onRead: (job) => armed.push(job) });
  const total = await bigCatalog(h);
  const ask = { model: MODEL, dim: 4, limit: 32 };
  armed.length = 0;
  const first = await h.vectors.todo(ask);
  assert.equal(first.ok, true, "embed_todo answers: " + JSON.stringify(first));
  assert.equal(first.rows.length, 32);
  assert.deepEqual([first.model, first.dim, first.total, first.done, first.left], [MODEL, 4, total, 0, total]);
  assert.equal(JSON.stringify(first).includes("marker"), false, "a blocked title is never offered");
  for (const r of first.rows) assert.equal(r.hash, textHash(r.text));
  assert.deepEqual(lanes(armed), [CATALOG.ADMIN_BUDGET_MS], "every read on the background (admin) lane, none on the 400 ms chat search budget");
  await bounded(h, armed, "the first todo");
  // the bot stores the batch, then asks after its cursor (pepe_plexembed EmbedJob: the cursor is the last stored key)
  assert.deepEqual(await h.vectors.put({ model: MODEL, dim: 4, vecs: vecs(first.rows) }), { ok: true, stored: 32, rejected: 0 });
  assert.deepEqual(lanes(armed).filter((b) => b !== CATALOG.ADMIN_BUDGET_MS), [], "put");
  armed.length = 0;
  const second = await h.vectors.todo({ ...ask, after: first.rows[31].key });
  assert.equal(second.ok, true); assert.equal(second.rows.length, 32);
  assert.ok(second.rows.every((r) => r.key > first.rows[31].key), "pages after the cursor");
  assert.deepEqual([second.done, second.left], [32, total - 32]);
  assert.deepEqual(lanes(armed), [CATALOG.ADMIN_BUDGET_MS]);
  await bounded(h, armed, "a todo after a cursor");
  // the card: model, dimensions and the numbers (status() threw on prod -> "waiting for the bot's model configuration")
  const card = await h.vectors.status();
  assert.deepEqual([card.enabled, card.ready, card.model, card.dim, card.done, card.left, card.counted], [true, true, MODEL, 4, 32, total - 32, true]);
  assert.deepEqual(lanes(armed).filter((b) => b !== CATALOG.ADMIN_BUDGET_MS), [], "the card");
  if (armed.length) await bounded(h, armed, "the card");
  // the clerk's quick look (opShelves) reads no count at all
  const quick = await h.vectors.status({ quick: true });
  assert.deepEqual([quick.ready, quick.model, quick.done, quick.left], [true, MODEL, 32, total - 32]);
  assert.ok(armed.every((j) => !/COUNT\(/.test(j.sql)), "a chat path never counts the catalog");
  // a few backfill steps with chat reads in between: no chat read is refused or held past its budget
  let cursor = second.rows[31].key, prev = second;
  const chat = [];
  for (let step = 0; step < 3; step++) {
    const job = (async () => {
      assert.equal((await h.vectors.put({ model: MODEL, dim: 4, vecs: vecs(prev.rows) })).stored, prev.rows.length);
      prev = await h.vectors.todo({ ...ask, after: cursor }); assert.equal(prev.ok, true); cursor = prev.rows[prev.rows.length - 1].key;
    })();
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      chat.push(h.catalog.read("SELECT key FROM plex_catalog WHERE key=?", [String(1000001 + i)])
        .then(() => performance.now() - started < CATALOG.SEARCH_BUDGET_MS ? "ok" : "slow", (e) => e.code));
    }
    await job;
  }
  assert.deepEqual([...new Set(await Promise.all(chat))], ["ok"], "chat reads while the backfill runs");
  assert.equal((await h.vectors.nearest({ qvec: qvec(), kind: "movie", keys: first.rows.map((r) => r.key) })).length, 30, "stored vectors are searchable");
});

test("a refused embed call says busy or down, and the real reason is logged once a streak - never every call", async (t) => {
  const h = await setup(t), logs = [];
  let fail = null;
  const lane = (rd) => async (sql, ...rest) => { if (fail && fail.test.test(sql)) throw fail.error(); return rd(sql, ...rest); };
  const catalog = { ...h.catalog, read: lane(h.catalog.read), admin: { ...h.catalog.admin, read: lane(h.catalog.admin.read) } };
  const make = () => createVectors({ catalog, settings: () => h.cfg, now: () => AT, log: { log: (l) => logs.push(String(l)), error: (l) => logs.push(String(l)) } });
  let vectors = make();
  const err = (code) => () => Object.assign(new Error(code), { code });
  fail = { test: /dirty=1/, error: err("too_broad") };   // prepare's read, past its budget
  const r1 = await vectors.todo({ model: MODEL, dim: 4 });
  assert.equal(r1.ok, false); assert.equal(r1.code, "embed_busy", "a read past its budget is busy (try again), not 'catalog down'");
  assert.equal(logs.length, 1, logs.join(" / ")); assert.match(logs[0], /plexvectors/); assert.match(logs[0], /too_broad/); assert.match(logs[0], /prepare/);
  assert.equal((await vectors.todo({ model: MODEL, dim: 4 })).code, "embed_busy");
  assert.equal(logs.length, 1, "the same reason again is not logged again");
  fail = { test: /dirty=1/, error: err("busy") };
  assert.equal((await vectors.todo({ model: MODEL, dim: 4 })).code, "embed_busy", "the read queue was full");
  assert.equal(logs.length, 2); assert.match(logs[1], /busy/);
  fail = { test: /dirty=1/, error: () => Object.assign(new Error("SQLITE_IOERR: disk I/O error"), { code: "SQLITE_IOERR" }) };
  assert.equal((await vectors.todo({ model: MODEL, dim: 4 })).code, "catalog_down", "anything else is 'down'");
  assert.equal(logs.length, 3); assert.match(logs[2], /SQLITE_IOERR/);
  fail = null;
  assert.equal((await vectors.todo({ model: MODEL, dim: 4 })).ok, true);
  fail = { test: /dirty=1/, error: err("too_broad") };
  assert.equal((await vectors.todo({ model: MODEL, dim: 4 })).code, "embed_busy");
  assert.equal(logs.length, 4, "a new streak after a good call is logged again");
  fail = null;
  // the catalog not ready: down, said once with the reason
  await h.catalog.write((tx) => tx.run("UPDATE plex_catalog_state SET value='1' WHERE key='full_at'"));
  assert.equal((await vectors.todo({ model: MODEL, dim: 4 })).code, "catalog_down");
  assert.equal((await vectors.todo({ model: MODEL, dim: 4 })).code, "catalog_down");
  assert.equal(logs.length, 5, logs.join(" / ")); assert.match(logs[4], /not ready/);
  await h.catalog.write((tx) => tx.run("UPDATE plex_catalog_state SET value=? WHERE key='full_at'", [String(AT)]));
  // the card while the count can't be read: model and dimensions still shown, no numbers made up, nothing thrown
  vectors = make();
  fail = { test: /COUNT\(/, error: err("too_broad") };
  const card = await vectors.status();
  assert.deepEqual([card.enabled, card.model, card.dim, card.counted, card.ready], [true, MODEL, 4, false, false]);
  fail = null;
  assert.equal((await vectors.status()).counted, true);
  for (const line of logs) assert.doesNotMatch(line, /Raincoat|Sunny|rainy afternoon/, "no catalog text in the log");
});

test("the backfill's reads wait behind chat reads and never make a chat read busy", async (t) => {
  const order = [], h = await setup(t, fixture(), {}, { onRead: (job) => order.push(job.sql) });
  // hold the one read connection with a long background read, then queue background and chat reads behind it
  const hold = h.catalog.admin.read("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1500000) SELECT COUNT(*) AS n FROM n");
  await new Promise((resolve) => setImmediate(resolve));
  const background = [1, 2, 3].map((i) => h.catalog.admin.read("SELECT " + i + " AS background"));
  const chat = [1, 2, 3, 4].map((i) => h.catalog.read("SELECT " + i + " AS chat").then(() => "ok", (e) => e.code));
  assert.deepEqual(await Promise.all(chat), ["ok", "ok", "ok", "ok"], "queued background reads take no room from chat reads");
  await Promise.all([hold, ...background]);
  const ran = order.filter((sql) => /AS (background|chat)$/.test(sql)).map((sql) => /chat$/.test(sql) ? "chat" : "background");
  assert.deepEqual(ran, ["chat", "chat", "chat", "chat", "background", "background", "background"], "a waiting chat read goes first");
});

test("the bot's loop finishes: an empty page from the start with nothing dirty says left 0; work before the cursor sends it back to the start", async (t) => {
  const h = await setup(t);
  async function backfill(edit) {
    let cursor = null, last = null;
    for (let step = 0; step < 40; step++) {
      last = await h.vectors.todo({ model: MODEL, dim: 4, limit: 2, after: cursor });
      assert.equal(last.ok, true, JSON.stringify(last));
      assert.ok(Number.isInteger(last.left) && last.left >= 0);
      if (!last.rows.length) { if (last.left === 0) return { last, step }; cursor = null; continue; }   // EmbedJob: wrap to the start
      const put = await h.vectors.put({ model: MODEL, dim: 4, vecs: vecs(last.rows) });
      assert.equal(put.stored, last.rows.length);
      cursor = last.rows[last.rows.length - 1].key;
      if (edit && step === 1) await edit();
    }
    throw new Error("the backfill never finished: " + JSON.stringify(last));
  }
  // a title before the cursor changes mid-way: the pass ends empty with work left, the bot starts over and finds it
  const done = await backfill(() => change(h, "1", { summary: "A newly written lighthouse story." }));
  assert.deepEqual([done.last.left, done.last.done, done.last.total], [0, 7, 7]);
  assert.equal((await h.catalog.read("SELECT COUNT(*) AS n FROM plex_vectors"))[0].n, 7);
  const one = (await h.catalog.getByKeys(["1"]))[0];
  assert.equal((await h.catalog.read("SELECT hash FROM plex_vectors WHERE key='1'"))[0].hash, textHash(documentText(one)), "the changed title was embedded again");
  // finished: asking again from the start still says 0 (no busy loop for the bot) ...
  const finished = await h.vectors.todo({ model: MODEL, dim: 4 });
  assert.deepEqual([finished.rows.length, finished.left], [0, 0]);
  // ... until a summary changes
  await change(h, "2", { summary: "Another newly written chapter." });
  const again = await h.vectors.todo({ model: MODEL, dim: 4 });
  assert.deepEqual(again.rows.map((r) => r.key), ["2"]); assert.ok(again.left >= 1);
});

test("a policy change re-checks stored vectors once, however many calls arrive together", async (t) => {
  const writes = [], h = await setup(t, fixture(), {}, { onWrite: (sql) => writes.push(sql) });
  await store(h, "1"); await store(h, "21");
  await h.vectors.status();
  const two = { key: "2", hash: textHash(documentText((await h.catalog.getByKeys(["2"]))[0])), ...quantize([0, 1, 0, 0]) };
  h.cfg.clerk_block_ratings += ",TV-14";
  writes.length = 0;
  await Promise.all([h.vectors.status(), h.vectors.todo({ model: MODEL, dim: 4 }), h.vectors.nearest({ qvec: qvec(), kind: "movie", keys: ["1"] }),
    h.vectors.put({ model: MODEL, dim: 4, vecs: [two] })]);
  const purges = writes.filter((sql) => /^\s*DELETE FROM plex_vectors\b/.test(sql));
  assert.ok(purges.length <= 1, "one purge, not one per caller: " + purges.length);
  assert.deepEqual((await h.catalog.read("SELECT key FROM plex_vectors ORDER BY key")).map((r) => r.key), ["1", "2"], "the blocked show's episode is gone");
});

test("the card shows the model while the catalog is still being counted, and the numbers once it is", async () => {
  const vm = require("node:vm"), locale = require("../locales/en.json");
  function element(tag) {
    return { tag, children: [], handlers: {}, style: {}, textContent: "", hidden: false, value: "", disabled: false,
      get firstChild() { return this.children[0] || null; },
      appendChild(child) { this.children.push(child); return child; },
      removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
      addEventListener(name, fn) { this.handlers[name] = fn; },
      set innerHTML(_) { throw new Error("text only"); } };
  }
  const L = (k, values) => String(locale["js.media.catalog." + k]).replace(/\{(\w+)\}/g, (m, n) => values && values[n] != null ? String(values[n]) : m);
  const base = { ok: true, ready: true, count: 255835, allow_list_set: true, version: "1.7.0", sections: [] };
  for (const [embed, want] of [
    [{ enabled: true, ready: false, model: "nomic-embed-text:v1.5", dim: 768, counted: false, done: 0, left: null }, L("embed_counting", { model: "nomic-embed-text:v1.5", dim: 768 })],
    [{ enabled: true, ready: true, model: "nomic-embed-text:v1.5", dim: 768, counted: true, done: 64, left: 255771 }, L("embed_progress", { done: 64, left: 255771, model: "nomic-embed-text:v1.5", dim: 768 })],
    [{ enabled: true, ready: false, model: null, dim: null, done: 0, left: 0 }, L("embed_waiting")],
    [{ enabled: false, ready: false, done: 0, left: 0 }, L("embed_off")]]) {
    const nodes = new Map([["pcOut", element("div")], ["pcMsg", element("div")]]);
    const context = {
      document: { getElementById: (id) => nodes.get(id) || null, createElement: element, querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, hidden: false },
      window: { addEventListener() {}, __t(key, fallback, values) {
        assert.ok(locale[key], key); assert.equal(locale[key], fallback, key + " default equals en.json");
        return fallback.replace(/\{(\w+)\}/g, (m, n) => values && values[n] != null ? String(values[n]) : m); } },
      console, Promise, Date, Number, setTimeout, clearTimeout, encodeURIComponent,
      fetch(url) { const r = url.split("?")[0] === "/api/media/admin/catalog" ? { ...base, embed } : { ok: true, checks: {} }; return Promise.resolve({ ok: true, json: () => Promise.resolve(r) }); }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/js/media-admin.js"), "utf8"), context);
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve));
    const lines = nodes.get("pcOut").children.filter((n) => n.tag === "p").map((n) => n.textContent);
    assert.ok(lines.includes(want), JSON.stringify(embed) + " -> " + JSON.stringify(lines));
  }
});

// ── plexvectors 1.99amo (follow-up to 1.99amg): once vectors exist, a FILM vector search at prod's size fell back to word search
// every time, silently. Prod has 30,682 films; MAX_MOVIES was 20,000. An ask over every film ("a film about ...") was refused
// before any read (more keys than MAX_MOVIES) - and plexfind never even asked (its own 20,000 cap on the pool). A filtered ask
// (one genre, under 20k keys) found more than 20,000 film vectors, took the "partial" path - the supplied keys 400 at a time,
// every chunk a chat read of 768-byte blobs, never cached - and ran out of the 400 ms budget: 405 ms and [] every time (bench:
// tools/plexvectors-scale.js). And any cache there was died with every embed_put (vector_rev) and every catalog write
// (catalog_rev): a backfill writes all day, so it would have been a whole reload per ask even under the cap.
const BUDGET = require("../plexvectors").BUDGET;
// what the chat and background lanes hand back: how many vector blobs each read (a whole reload is every film's)
function counting(h) {
  const blobs = { chat: 0, admin: 0 };
  const count = (lane, rows) => { for (const r of rows || []) if (r && Buffer.isBuffer(r.v)) blobs[lane]++; return rows; };
  const catalog = { ...h.catalog, read: async (...args) => count("chat", await h.catalog.read(...args)),
    admin: { ...h.catalog.admin, read: async (...args) => count("admin", await h.catalog.admin.read(...args)) } };
  return { catalog, blobs, reset() { blobs.chat = 0; blobs.admin = 0; }, total: () => blobs.chat + blobs.admin };
}
// a 768-dim int8 vector for every visible film bigCatalog made but the last `spare` (left for embed_put), and for the blocked
// films too (vectors that slipped past a sync's block list - never offered); the vectors at the `keep` positions are returned
async function filmVectors(h, { dim = 768, spare = 24, keep = [] } = {}) {
  let seed = 88172645;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 255) - 127; };
  const kept = new Map();
  let films = [], blocked = [], spares = [];
  await h.catalog.write(async (tx) => {
    const all = await tx.all("SELECT key,data,content_rating FROM plex_catalog WHERE type='movie' ORDER BY key");
    const visible = all.filter((r) => r.content_rating !== "X"), hidden = all.filter((r) => r.content_rating === "X");
    blocked = hidden.map((r) => r.key);
    spares = visible.slice(visible.length - spare).map((r) => r.key);
    films = visible.slice(0, visible.length - spare).map((r) => r.key);
    const position = new Map(films.map((key, i) => [key, i]));
    const stored = visible.slice(0, visible.length - spare).concat(hidden);
    for (let start = 0; start < stored.length; start += 64) {
      const batch = stored.slice(start, start + 64), params = [];
      for (const r of batch) {
        const buffer = Buffer.from(Int8Array.from({ length: dim }, random).buffer), at = position.get(r.key);
        if (keep.includes(at)) kept.set(at, { key: r.key, v: buffer.toString("base64") });
        if (at == null && !kept.has("blocked")) kept.set("blocked", { key: r.key, v: buffer.toString("base64") });
        params.push(r.key, MODEL, dim, textHash(documentText(JSON.parse(r.data))), 1, buffer, "movie", null);
      }
      await tx.run("INSERT INTO plex_vectors(key,model,dim,hash,scale,v,kind,show_key) VALUES " + batch.map(() => "(?,?,?,?,?,?,?,?)").join(","), params);
    }
    await tx.run("UPDATE plex_vector_docs SET hash=(SELECT hash FROM plex_vectors v WHERE v.key=plex_vector_docs.key),dirty=0 WHERE key IN (SELECT key FROM plex_vectors)");
  });
  return { films, blocked, spares, kept };
}
const median = (list) => list.slice().sort((a, b) => a - b)[Math.floor(list.length / 2)];

test("the film index follows each embed_put without reading every film again, and the chat lane never reads film vectors", async (t) => {
  const snapshot = fixture();
  for (let i = 0; i < 500; i++) snapshot.rows.push(row(5000 + i, "Synthetic film " + i));
  const armed = [], h = await setup(t, snapshot, {}, { onRead: (job) => armed.push(job) }), c = counting(h);
  const vectors = createVectors({ catalog: c.catalog, settings: () => h.cfg, now: () => AT });
  const films = Array.from({ length: 500 }, (_, i) => String(5000 + i)), current = await h.catalog.getByKeys(films);
  for (let i = 0; i < current.length; i += 64)
    assert.equal((await h.vectors.put({ model: MODEL, dim: 4, vecs: current.slice(i, i + 64).map((r) => ({ key: r.key, hash: textHash(documentText(r)),
      ...quantize([1, (Number(r.key) % 7) / 7, 0, 0]) })) })).stored, Math.min(64, current.length - i));
  const keys = ["1", "2", ...films], ask = (values) => vectors.nearest({ qvec: qvec(values), kind: "movie", keys });
  assert.equal((await ask([1, 0, 0, 0])).length, 30);
  await vectors.idle();
  assert.ok(c.total() >= 500, "the first ask read the films' vectors once: " + JSON.stringify(c.blobs));
  for (let i = 0; i < 3; i++) assert.equal((await ask([1, 0, 0, 0])).length, 30);
  await vectors.idle();
  assert.equal(c.blobs.chat, 0, "the chat lane never reads film vectors: " + JSON.stringify(c.blobs));
  c.reset();
  for (let i = 0; i < 3; i++) assert.equal((await ask([1, 0, 0, 0])).length, 30);
  await vectors.idle();
  assert.equal(c.total(), 0, "asking again reads no vector: " + JSON.stringify(c.blobs));
  // a backfill step: the bot stores one more film (embed_put) - the next ask finds it, having read only that one vector
  await store(h, "2", [0, 0, 1, 0]);
  c.reset();
  const after = await ask([0, 0, 1, 0]);
  assert.equal(after[0] && after[0].key, "2", "the film stored a moment ago is the nearest: " + JSON.stringify(after.slice(0, 2)));
  await vectors.idle();
  assert.ok(c.total() <= 2, "an embed_put is read on its own, not with every film again: " + JSON.stringify(c.blobs));
  // a catalog write (a sync, a play count) keeps the index; a film whose summary changed is never offered on its old vector
  await change(h, "2", { summary: "A newly written space mission." });
  c.reset();
  assert.equal((await ask([0, 0, 1, 0])).some((r) => r.key === "2"), false);
  await vectors.idle();
  assert.equal(c.total(), 0, "a catalog write is no reason to read the films again: " + JSON.stringify(c.blobs));
  // a play count (not the text): the doc is dirty - left out until it's hashed again, then back without reading its vector
  await store(h, "5003", [0, 0, 0, 1]);
  assert.equal((await ask([0, 0, 0, 1]))[0].key, "5003");
  await change(h, "5003", { rating: 8 });
  c.reset();
  assert.equal((await ask([0, 0, 0, 1])).some((r) => r.key === "5003"), false, "a dirty doc stays out until it's hashed again");
  assert.equal((await h.vectors.todo()).rows.some((r) => r.key === "5003"), false, "unchanged text needs no provider call");
  assert.equal((await ask([0, 0, 0, 1]))[0].key, "5003", "hashed again: offered again");
  await vectors.idle();
  assert.equal(c.total(), 0, "... without reading any vector: " + JSON.stringify(c.blobs));
  // every read the index made: an index range (kind + rowid, kind + rev) and lookups by key - never a walk or a sort
  const reads = armed.filter((j) => /plex_vectors_(kind|rev)\b/.test(j.sql));
  assert.ok(reads.some((j) => /plex_vectors_kind/.test(j.sql)) && reads.some((j) => /plex_vectors_rev/.test(j.sql)), "a build and a refresh were read");
  assert.deepEqual([...new Set(reads.map((j) => j.budgetMs))], [require("../plexcatalog").ADMIN_BUDGET_MS], "on the background lane");
  await bounded(h, reads, "the films' index");
  // a policy change: the index is built again from what is still visible
  h.cfg.clerk_block_ratings += ",PG";
  assert.deepEqual(await ask([1, 0, 0, 0]), []);
  await vectors.idle();
  assert.equal(vectors.stats().films, 0, "nothing the policy hides is kept");
  assert.equal(c.blobs.chat, 0);
});

test("a cold film ask while the index loads answers on time from words, the asks after it have the films, and the clerk's quick look starts the load", async (t) => {
  const snapshot = fixture();
  for (let i = 0; i < 200; i++) snapshot.rows.push(row(5000 + i, "Synthetic film " + i));
  const h = await setup(t, snapshot), films = Array.from({ length: 200 }, (_, i) => String(5000 + i));
  for (let i = 0; i < films.length; i += 64) {
    const part = await h.catalog.getByKeys(films.slice(i, i + 64));
    assert.equal((await h.vectors.put({ model: MODEL, dim: 4, vecs: part.map((x) => ({ key: x.key, hash: textHash(documentText(x)), ...quantize([1, 0, 0, 0]) })) })).stored, part.length);
  }
  // the background lane is slow (a long backfill read ahead of it): every read there takes 300 ms
  const slow = { ...h.catalog, admin: { ...h.catalog.admin, read: async (...args) => { await new Promise((resolve) => setTimeout(resolve, 300)); return h.catalog.admin.read(...args); } } };
  const make = () => createVectors({ catalog: slow, settings: () => h.cfg, now: () => AT });
  let vectors = make();
  let started = performance.now();
  assert.deepEqual(await vectors.nearest({ qvec: qvec(), kind: "movie", keys: films }), [], "nothing to scan yet: the clerk keeps its word search");
  assert.ok(performance.now() - started < BUDGET + 100, "on time: " + (performance.now() - started).toFixed(0) + " ms");
  await vectors.idle();
  assert.equal(vectors.stats().films, 200, "the load finished in the background");
  started = performance.now();
  assert.equal((await vectors.nearest({ qvec: qvec(), kind: "movie", keys: films })).length, 30);
  assert.ok(performance.now() - started < 300, "a warm ask doesn't wait for the background lane");
  // a restart: the clerk's quick look (a person's ask, before the find) starts the load
  vectors = make();
  assert.equal((await vectors.status({ quick: true })).ready, true);
  await vectors.idle();
  assert.equal(vectors.stats().films, 200, "loaded before the first find");
  assert.equal((await vectors.nearest({ qvec: qvec(), kind: "movie", keys: films })).length, 30);
  // switched off: the films' memory goes
  h.cfg.clerk_embed = false;
  await vectors.status();
  assert.equal(vectors.stats().films, 0);
});

test("a library past the films' memory cap answers from words, says so once, and is not read again on every ask", async (t) => {
  const h = await setup(t), logs = [], c = counting(h);
  // 4,200 films with a 4-dim vector each; a cap of one block (4,096 films x 4 dims)
  await h.catalog.write(async (tx) => {
    await tx.run(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<4200)
      INSERT INTO plex_catalog(key,type,title,title_fold,show_key,show_fold,section,content_rating,data,seen_at,server_plays,pad_plays)
      SELECT CAST(600000+x AS TEXT),'movie','Synthetic film '||x,'synthetic',NULL,'',1,'PG',
        json_object('key',CAST(600000+x AS TEXT),'type','movie','section','1','title','Synthetic film '||x,'content_rating','PG','summary','Original synthetic prose.'),1,0,0 FROM n`);
    const rows = await tx.all("SELECT key,data FROM plex_catalog WHERE key>'600000' AND type='movie'");
    for (let i = 0; i < rows.length; i += 64) {
      const batch = rows.slice(i, i + 64), params = [];
      for (const r of batch) params.push(r.key, MODEL, 4, textHash(documentText(JSON.parse(r.data))), 1, Buffer.from(Int8Array.from([100, 1, 1, 1]).buffer), "movie", null);
      await tx.run("INSERT INTO plex_vectors(key,model,dim,hash,scale,v,kind,show_key) VALUES " + batch.map(() => "(?,?,?,?,?,?,?,?)").join(","), params);
    }
    await tx.run("UPDATE plex_vector_docs SET hash=(SELECT hash FROM plex_vectors v WHERE v.key=plex_vector_docs.key),dirty=0 WHERE key IN (SELECT key FROM plex_vectors)");
  });
  const vectors = createVectors({ catalog: c.catalog, settings: () => h.cfg, now: () => AT, filmMaxBytes: 4096 * 4,
    log: { log: (l) => logs.push(String(l)), error: (l) => logs.push(String(l)) } });
  const keys = Array.from({ length: 4200 }, (_, i) => String(600001 + i));
  assert.deepEqual(await vectors.nearest({ qvec: qvec(), kind: "movie", keys }), []);
  await vectors.idle();
  assert.equal(logs.length, 1, logs.join(" / ")); assert.match(logs[0], /films refused/); assert.match(logs[0], /answer from words/);
  const read = c.total();
  assert.ok(read > 4000 && read <= 4200, "the films were read once: " + read);
  for (let i = 0; i < 3; i++) assert.deepEqual(await vectors.nearest({ qvec: qvec(), kind: "movie", keys }), []);
  await vectors.idle();
  assert.equal(c.total(), read, "not read again on every ask");
  assert.equal(logs.length, 1, "said once");
  assert.deepEqual(vectors.stats(), { films: 0, dim: null, bytes: 0, rev: null, building: false });
  // the episodes of one show are unaffected (their own per-show read)
  await store(h, "21", [1, 0, 0, 0]);
  assert.deepEqual((await vectors.nearest({ qvec: qvec(), kind: "episode", show_key: "20", keys: ["21"] })).map((r) => r.key), ["21"]);
  // a library that grows past the cap through the backfill: exactly the cap loads; the embed_put past it drops the index
  await h.catalog.write((tx) => tx.run("DELETE FROM plex_vectors WHERE key>'604096' AND key<'700000'"));
  const fits = createVectors({ catalog: c.catalog, settings: () => h.cfg, now: () => AT, filmMaxBytes: 4096 * 4,
    log: { log: (l) => logs.push(String(l)), error: (l) => logs.push(String(l)) } });
  assert.equal((await fits.nearest({ qvec: qvec(), kind: "movie", keys })).length, 30);
  await fits.idle();
  assert.equal(fits.stats().films, 4096);
  const extra = (await h.catalog.getByKeys(["604097"]))[0];
  assert.equal((await fits.put({ model: MODEL, dim: 4, vecs: [{ key: "604097", hash: textHash(documentText(extra)), ...quantize([1, 0, 0, 0]) }] })).stored, 1);
  await fits.idle();
  assert.equal(fits.stats().films, 0, "past the cap: no index");
  assert.deepEqual(await fits.nearest({ qvec: qvec(), kind: "movie", keys }), []);
  assert.ok(logs.some((l) => /films refused/.test(l) && /4096\+ films/.test(l)), logs.join(" / "));
});

test("prod size (30,682 films with 768-dim vectors): every film or one genre answers from vectors inside the 400 ms budget, warm; the clerk's find() uses them", { timeout: 300000 }, async (t) => {
  const h = await setup(t, { ...fixture(), rows: [] }, {}, { noFts: false });
  await bigCatalog(h);
  await h.vectors.configure({ model: MODEL, dim: 768 });
  const PLANT = 12344;
  const { films, blocked, spares, kept } = await filmVectors(h, { keep: [PLANT] });
  assert.equal(films.length + spares.length, PROD.films);
  const c = counting(h);
  const vectors = createVectors({ catalog: c.catalog, settings: () => h.cfg, now: () => AT });
  const planted = kept.get(PLANT).key, query = (v) => ({ model: MODEL, dim: 768, scale: 1, v });
  const ask = (keys, v = kept.get(PLANT).v) => vectors.nearest({ qvec: query(v), kind: "movie", keys, budgetMs: BUDGET });
  const everyFilm = films.concat(spares);
  // the first ask after a start may answer from words only while the films load (background lane) - on time, never wrong
  let started = performance.now();
  const cold = await ask(everyFilm);
  const coldMs = performance.now() - started;
  assert.ok(coldMs < BUDGET + 150, "the first ask returns on time: " + coldMs.toFixed(1) + " ms");
  assert.ok(!cold.length || cold[0].key === planted, "a cold answer is the right one or none");
  await vectors.idle();
  const warm = [];
  for (let i = 0; i < 5; i++) {
    started = performance.now();
    const hits = await ask(everyFilm);
    warm.push(performance.now() - started);
    assert.equal(hits.length, 30, "an ask over all " + everyFilm.length + " films answers from vectors (it was [] - more keys than MAX_MOVIES): " + warm.at(-1).toFixed(1) + " ms, " + JSON.stringify(vectors.stats()));
    assert.equal(hits[0].key, planted);
    assert.ok(hits[0].score > .99 && hits.every((r) => r.why === "vector"));
  }
  // one genre: half the films (under the old 20,000 cap, with more film vectors than it: the uncached partial path, 405 ms and [])
  const half = everyFilm.filter((_, i) => i % 2 === 0);
  assert.ok(half.includes(planted) && half.length < 20000);
  const filtered = [];
  for (let i = 0; i < 5; i++) {
    started = performance.now();
    const hits = await ask(half);
    filtered.push(performance.now() - started);
    assert.equal(hits.length, 30, "an ask over one genre answers from vectors (it was [] - the partial path ran out of time)");
    assert.equal(hits[0].key, planted);
    assert.ok(hits.every((r) => half.includes(r.key)), "only the keys asked about");
  }
  t.diagnostic(`30,682 films x 768 int8: first ask ${coldMs.toFixed(1)} ms (${cold.length} hits); warm every film median ${median(warm).toFixed(1)} ms, max ${Math.max(...warm).toFixed(1)} ms; warm one genre median ${median(filtered).toFixed(1)} ms`);
  assert.ok(Math.max(...warm, ...filtered) < BUDGET, "every warm ask inside the chat budget");
  assert.ok(median(warm) < 200, "a warm ask over every film well inside the budget: " + median(warm).toFixed(1) + " ms");
  assert.equal(c.blobs.chat, 0, "the chat lane never reads film vectors: " + JSON.stringify(c.blobs));
  // a film whose vector slipped past a sync's block list is never offered, even asked about by key with its own vector
  const leak = await ask(everyFilm.concat(blocked), kept.get("blocked").v);
  assert.equal(leak.some((r) => blocked.includes(r.key)), false, "a blocked film is never offered");
  // a backfill step between asks: the bot stores the 24 films still without a vector, 12 a call (pepe_plexembed keeps a body under
  // 16 KB); the next ask finds them, having read only those 24 vectors
  const unit = quantize(Array.from({ length: 768 }, (_, i) => i === 0 ? 1 : 0));
  const rows = await h.catalog.getByKeys(spares);
  c.reset();
  for (let i = 0; i < rows.length; i += 12)
    assert.equal((await h.vectors.put({ model: MODEL, dim: 768, vecs: rows.slice(i, i + 12).map((r) => ({ key: r.key, hash: textHash(documentText(r)), ...unit })) })).stored, 12);
  const fresh = await vectors.nearest({ qvec: { model: MODEL, dim: 768, ...unit }, kind: "movie", keys: everyFilm, budgetMs: BUDGET, limit: 30 });
  assert.equal(fresh.filter((r) => spares.includes(r.key)).length, 24, "the 24 films stored a moment ago are offered");
  await vectors.idle();
  assert.ok(c.total() <= 24 * 2, "the puts were read on their own, not with every film again: " + JSON.stringify(c.blobs));
  // the clerk's find(): an unfiltered "a film about ..." and a one-genre ask both offer films by their vectors
  const { createFinder } = require("../plexfind");
  const finder = createFinder({ catalog: h.catalog, settings: () => h.cfg, now: () => AT, rng: () => 0, vectors, deepMax: { movie: 2, show: 10 },
    lists: { shelves: async () => [], members: async () => [] }, requests: { search: async () => [], details: async () => null } });
  const ctx = { seenKeys: [], maxSec: 4 * 3600, allowSeerr: false }, raw = "a film about a lighthouse keeper";
  for (const want of [{ kind: "movie", about: "a lighthouse keeper who forgets the sea" }, { kind: "movie", genres: ["Drama"], about: "a lighthouse keeper who forgets the sea" }]) {
    await finder.find({ ask: want, raw, limit: 20, qvec: query(kept.get(PLANT).v) }, ctx);   // the kept roots, read once
    started = performance.now();
    const out = await finder.find({ ask: want, raw, limit: 20, qvec: query(kept.get(PLANT).v) }, ctx);
    const ms = performance.now() - started;
    t.diagnostic(`find(${JSON.stringify(want)}): ${ms.toFixed(1)} ms, ${out.rows.length} rows, ${out.rows.filter((r) => r.why === "vector").length} from vectors`);
    assert.ok(out.rows.some((r) => r.why === "vector"), "the clerk offers films by what they're about: " + JSON.stringify(want));
    assert.equal(out.rows[0].key, planted);
  }
  // what it costs: the films' int8 vectors in typed arrays, about a byte a dimension a film
  const stats = vectors.stats();
  t.diagnostic("film index: " + JSON.stringify(stats));
  assert.equal(stats.films, PROD.films);
  assert.ok(stats.bytes >= PROD.films * 768 && stats.bytes <= PROD.films * 768 * 1.25, "about one byte per dimension per film: " + stats.bytes);
  await vectors.idle();
});

test("a cache from before plex_vectors.rev (prod's) gets the column once; its old vectors are read by a build, a put after it by a refresh", async (t) => {
  const h = await setup(t);
  await store(h, "1", [1, 0, 0, 0]);
  await h.catalog.write(async (tx) => { await tx.run("DROP INDEX plex_vectors_rev"); await tx.run("ALTER TABLE plex_vectors DROP COLUMN rev"); });
  assert.equal((await h.catalog.read("SELECT name FROM pragma_table_info('plex_vectors') WHERE name='rev'")).length, 0);
  const vectors = createVectors({ catalog: h.catalog, settings: () => h.cfg, now: () => AT });   // a restart on the new code
  assert.deepEqual((await vectors.nearest({ qvec: qvec(), kind: "movie", keys: ["1", "2"] })).map((r) => r.key), ["1"]);
  assert.equal((await h.catalog.read("SELECT rev FROM plex_vectors WHERE key='1'"))[0].rev, 0, "an old row keeps rev 0 (no rewrite)");
  assert.equal((await h.catalog.read("SELECT name FROM sqlite_master WHERE name='plex_vectors_rev'")).length, 1);
  const two = (await h.catalog.getByKeys(["2"]))[0];
  assert.equal((await vectors.put({ model: MODEL, dim: 4, vecs: [{ key: "2", hash: textHash(documentText(two)), ...quantize([0, 1, 0, 0]) }] })).stored, 1);
  const meta = (await h.catalog.read("SELECT vector_rev FROM plex_vector_meta"))[0], rev = (await h.catalog.read("SELECT rev FROM plex_vectors WHERE key='2'"))[0].rev;
  assert.ok(rev > 0 && rev <= meta.vector_rev, "a put stores the vector_rev it made: " + rev + " / " + meta.vector_rev);
  assert.deepEqual((await vectors.nearest({ qvec: qvec([0, 1, 0, 0]), kind: "movie", keys: ["1", "2"] })).map((r) => r.key), ["2", "1"]);
  await vectors.idle();
  assert.equal(vectors.stats().films, 2);
});

// plexvectors 1.99amo review: the bot sends its model and dims with EVERY embed_todo (pepe_plexembed EmbedJob.step: op
// "embed_todo", model, dim, limit, after - every ~1.6 s for hours during a backfill), and todo() hands them to configure().
// configure() threw the films' index away (invalidate) even when the stored pair was the same - so on prod's one shared
// instance every backfill step dropped every film's vector, the next person's ask found no index (cold: a whole re-read of
// 30,682 films on the background lane, longer than the cold ask's wait on prod's CPU -> word search), and a library past the
// memory cap lost its 10-minute back-off (filmRefused) and was read in full again on every ask.
test("the bot's embed_todo (its model and dims on every call) keeps the films' index and the memory cap's back-off; a real model change drops them", async (t) => {
  const snapshot = fixture();
  for (let i = 0; i < 300; i++) snapshot.rows.push(row(5000 + i, "Synthetic film " + i));
  const h = await setup(t, snapshot), c = counting(h);
  const vectors = createVectors({ catalog: c.catalog, settings: () => h.cfg, now: () => AT });   // one instance, as on prod
  const films = Array.from({ length: 300 }, (_, i) => String(5000 + i)), current = await h.catalog.getByKeys(films);
  for (let i = 0; i < current.length; i += 64)
    assert.equal((await vectors.put({ model: MODEL, dim: 4, vecs: current.slice(i, i + 64).map((r) => ({ key: r.key, hash: textHash(documentText(r)),
      ...quantize([1, (Number(r.key) % 7) / 7, 0, 0]) })) })).stored, Math.min(64, current.length - i));
  const ask = () => vectors.nearest({ qvec: qvec([1, 0, 0, 0]), kind: "movie", keys: films });
  await ask(); await vectors.idle();
  assert.equal((await ask()).length, 30);
  assert.equal(vectors.stats().films, 300);
  c.reset();
  // three backfill steps, exactly as the bot makes them (the same model and dims every time)
  for (let i = 0; i < 3; i++) assert.equal((await vectors.todo({ model: MODEL, dim: 4, limit: 32 })).ok, true);
  assert.equal(vectors.stats().films, 300, "an embed_todo with the stored model keeps the films' index");
  assert.equal((await ask()).length, 30);
  await vectors.idle();
  assert.equal(c.total(), 0, "no film vector read again after the bot's embed_todo: " + JSON.stringify(c.blobs));
  // a real model change (the registry moved): the old model's index goes, and a new-model ask never uses it
  assert.equal((await vectors.todo({ model: "fixture-embedding-v2", dim: 4, limit: 32 })).ok, true);
  assert.equal(vectors.stats().films, 0, "a model change drops the old model's index");
  assert.deepEqual(await vectors.nearest({ qvec: qvec([1, 0, 0, 0], "fixture-embedding-v2"), kind: "movie", keys: films }), []);
  await vectors.idle();
  // the memory cap's back-off survives the bot's embed_todo too
  const logs = [], capped = createVectors({ catalog: c.catalog, settings: () => h.cfg, now: () => AT, filmMaxBytes: 1,
    log: { log: (l) => logs.push(String(l)), error: (l) => logs.push(String(l)) } });
  await capped.configure({ model: MODEL, dim: 4 });
  const cappedAsk = () => capped.nearest({ qvec: qvec([1, 0, 0, 0]), kind: "movie", keys: films });
  assert.deepEqual(await cappedAsk(), []);
  await capped.idle();
  assert.ok(logs.some((l) => /films refused/.test(l)), logs.join(" / "));
  c.reset();
  for (let i = 0; i < 3; i++) { await capped.todo({ model: MODEL, dim: 4, limit: 32 }); assert.deepEqual(await cappedAsk(), []); await capped.idle(); }
  assert.equal(c.total(), 0, "past the cap: not read again on every ask between the bot's embed_todo calls: " + JSON.stringify(c.blobs));
});

// plexvectors 1.99amo review (finding 2): an ordinary sync moved policy_rev though nothing in Plex had changed - plexcatalog's
// installSections replaced plex_sections whole (DELETE + every INSERT again) and each row fired a section trigger (+2 a section,
// prod +6 every hour). The vectors were never lost (prod's 1.99amg path, probed: 36,882 vectors, an unchanged delta and full
// sweep -> policy_rev 0 -> 6 -> 12, the purge deleted 0 rows, vec=1 kept), but every sync made the guard re-check every stored
// vector (a write a page) and drop the films' index: 30,682 films read again and the asks meanwhile answered from words.
// Now the sections are updated in place, and an UPDATE of a section moves policy_rev only when its id, type or policy changes.
function syncedCatalog(t, cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plexvectors-test-"));
  const api = { sections: [{ id: "1", title: "Films A", type: "movie", policy: "allowed", count: 300 }, { id: "4", title: "Films B", type: "movie", policy: "allowed", count: 100 },
    { id: "2", title: "Series", type: "show", policy: "allowed", count: 1 }, { id: "3", title: "Adult", type: "movie", policy: "adult", count: 1 }], rows: [] };
  for (let i = 0; i < 300; i++) api.rows.push({ ...row(5000 + i, "Synthetic film " + i), type: 1, added: 100, updated: 100 });
  for (let i = 0; i < 100; i++) api.rows.push({ ...row(6000 + i, "Other film " + i, { section: "4" }), type: 1, added: 100, updated: 100 });
  api.rows.push({ ...row(20, "Sky Office", { section: "2", content_rating: "TV-14" }), type: 2, added: 100, updated: 100 });
  for (let i = 0; i < 20; i++) api.rows.push({ ...row(7000 + i, "Launch Day " + i, { section: "2", show_key: "20", show: "Sky Office", season: 1, episode: i + 1 }), type: 4, added: 100, updated: 100 });
  const mediactl = async (method, route) => {
    const u = new URL(route, "http://fixture.local");
    if (route === "/sections") return { status: 200, json: { ok: true, allow_list_set: true, sections: api.sections } };
    if (route === "/health") return { status: 200, json: { ok: true, version: "1.7.1" } };
    if (u.pathname === "/collections") return { status: 200, json: { ok: true, collections: [], total: 0, next: null } };
    if (u.pathname === "/catalog") {
      const type = Number(u.searchParams.get("type")), sec = u.searchParams.get("section");
      let list = api.rows.filter((r) => r.type === type && r.section === sec);
      if (u.searchParams.has("since")) list = list.filter((r) => r.updated >= Number(u.searchParams.get("since")));
      const start = Number(u.searchParams.get("start")), page = list.slice(start, start + 500);
      return { status: 200, json: { ok: true, rows: page, total: list.length, next: start + page.length < list.length ? start + page.length : null } };
    }
    return { status: 404, json: { ok: false } };
  };
  const clock = { at: AT };
  const catalog = createCatalog({ file: path.join(dir, "catalog.db"), now: () => clock.at, settings: () => cfg, noFts: true, mediactl, sleep: async () => {},
    mainRead: async () => [], tautulli: { configured: () => false }, lists: { enabled: () => false, close: async () => {} }, log: { log() {}, error() {} } });
  t.after(async () => {
    await catalog.close();
    const resolved = fs.realpathSync(dir);
    assert.ok(path.basename(resolved).startsWith("plexvectors-test-") && path.dirname(resolved) === fs.realpathSync(os.tmpdir()));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { catalog, api, clock };
}
test("an unchanged sync (the hourly delta, the daily full sweep) keeps every stored vector, the docs' vec and the films' index; a section hidden in Plex still drops its titles' vectors", async (t) => {
  const cfg = { clerk_embed: true, clerk_embed_k: 30, clerk_block_ratings: "X,XXX,AO,R18,R18+", catalog_sync_min: 60 };
  const { catalog, api, clock } = syncedCatalog(t, cfg);
  assert.equal((await catalog.sync({ full: true })).ok, true);
  const counted = { blobs: 0 };
  const lane = { ...catalog, admin: { ...catalog.admin, read: async (...args) => { const rows = await catalog.admin.read(...args); for (const r of rows || []) if (r && Buffer.isBuffer(r.v)) counted.blobs++; return rows; } } };
  const vectors = createVectors({ catalog: lane, settings: () => cfg, now: () => clock.at });
  t.after(() => vectors.idle());
  await vectors.configure({ model: MODEL, dim: 4 });
  const all = await catalog.getByKeys(api.rows.map((r) => r.key));
  assert.equal(all.length, api.rows.length);
  for (let i = 0; i < all.length; i += 64)
    assert.equal((await vectors.put({ model: MODEL, dim: 4, vecs: all.slice(i, i + 64).map((r) => ({ key: r.key, hash: textHash(documentText(r)), ...quantize([1, (Number(r.key) % 7) / 7, 0, 0]) })) })).stored, Math.min(64, all.length - i));
  const films = api.rows.filter((r) => r.type === 1).map((r) => r.key), ask = (limit = 30) => vectors.nearest({ qvec: qvec([1, 0, 0, 0]), kind: "movie", keys: films, limit });
  await ask(); await vectors.idle();
  assert.equal((await ask()).length, 30);
  assert.equal(vectors.stats().films, 400);
  const state = async () => (await catalog.read("SELECT (SELECT COUNT(*) FROM plex_vectors) AS vectors,(SELECT COUNT(*) FROM plex_vector_docs WHERE vec=1) AS vec,(SELECT policy_rev FROM plex_vector_meta) AS policy_rev"))[0];
  const before = await state();
  assert.deepEqual([before.vectors, before.vec], [421, 421]);
  for (const [label, at] of [["the hourly delta", AT + 3600000], ["the next day's full sweep", AT + 86400000 + 3600000], ["a count and a title changed in Plex", AT + 86400000 + 7200000]]) {
    if (label.startsWith("a count")) api.sections = api.sections.map((s) => s.id === "1" ? { ...s, count: 301, title: "Films A (4K)" } : s);
    clock.at = at;
    const out = await catalog.sync();
    assert.equal(out.ok, true, label + ": " + JSON.stringify(out));
    counted.blobs = 0;
    assert.equal((await ask()).length, 30, label);
    await vectors.idle();
    assert.deepEqual(await state(), before, label + ": policy_rev, the stored vectors and docs.vec unchanged");
    assert.equal(vectors.stats().films, 400, label + ": the films' index kept");
    assert.equal(counted.blobs, 0, label + ": no film vector read again");
  }
  // a real policy change: section 4 switched to adult in Plex's allow-list - its titles and their vectors go (as before), the
  // policy moves, the index is built again without them, and none of them is ever offered
  api.sections = api.sections.map((s) => s.id === "4" ? { ...s, policy: "adult" } : s);
  clock.at = AT + 86400000 + 10800000;
  assert.equal((await catalog.sync()).ok, true);
  const hidden = await state();
  assert.ok(hidden.policy_rev > before.policy_rev, "the policy moved");
  assert.deepEqual([hidden.vectors, hidden.vec], [321, 321], "section 4's 100 films' vectors are gone");
  const offered = await ask(50);
  await vectors.idle();
  assert.equal(offered.some((r) => r.key >= "6000" && r.key < "6100"), false);
  assert.equal(vectors.stats().films, 300, "built again from what is still visible");
});

test("the section trigger: a cache from before gets the conditional trigger; a title or count update leaves policy_rev, a policy update moves it and the stored vectors are re-checked as before", async (t) => {
  const h = await setup(t);
  await store(h, "1", [1, 0, 0, 0]); await store(h, "2", [0, 1, 0, 0]);
  // prod's 1.99amg trigger: every UPDATE of a section moved policy_rev
  await h.catalog.write(async (tx) => {
    await tx.run("DROP TRIGGER plex_vectors_section_update");
    await tx.run("CREATE TRIGGER plex_vectors_section_update AFTER UPDATE ON plex_sections BEGIN UPDATE plex_vector_meta SET policy_rev=policy_rev+1 WHERE id=1; END");
  });
  const vectors = createVectors({ catalog: h.catalog, settings: () => h.cfg, now: () => AT });   // a restart on the new code
  await vectors.init();
  const rev = async () => (await h.catalog.read("SELECT policy_rev FROM plex_vector_meta"))[0].policy_rev;
  const r0 = await rev();
  await h.catalog.write((tx) => tx.run("UPDATE plex_sections SET count=COALESCE(count,0)+1,title=title||' (4K)'"));
  assert.equal(await rev(), r0, "a title / count update is not a policy change");
  await h.catalog.write((tx) => tx.run("UPDATE plex_sections SET policy=policy"));
  assert.equal(await rev(), r0, "a policy written unchanged is not a policy change");
  assert.deepEqual((await vectors.nearest({ qvec: qvec(), kind: "movie", keys: ["1", "2"] })).map((r) => r.key), ["1", "2"]);
  await vectors.idle();
  // section 1 switched off in place (no catalog delete): the policy moves, the guard re-checks the stored vectors, and both
  // films' vectors (section 1) are deleted by the purge and never offered
  await h.catalog.write((tx) => tx.run("UPDATE plex_sections SET policy='off' WHERE id='1'"));
  assert.equal(await rev(), r0 + 1);
  assert.deepEqual(await vectors.nearest({ qvec: qvec(), kind: "movie", keys: ["1", "2"] }), []);
  await vectors.idle();
  assert.equal((await h.catalog.read("SELECT COUNT(*) AS n FROM plex_vectors WHERE key IN ('1','2')"))[0].n, 0, "re-checked and purged");
  assert.equal((await h.catalog.read("SELECT COUNT(*) AS n FROM plex_vector_docs WHERE key IN ('1','2') AND vec=1"))[0].n, 0);
  // a section's id or type changing, a section added or removed: policy changes
  await h.catalog.write((tx) => tx.run("UPDATE plex_sections SET type='show' WHERE id='3'"));
  assert.equal(await rev(), r0 + 2);
  await h.catalog.write((tx) => tx.run("INSERT INTO plex_sections(id,title,type,count,policy) VALUES ('9','New','movie',0,'allowed')"));
  assert.equal(await rev(), r0 + 3);
  await h.catalog.write((tx) => tx.run("DELETE FROM plex_sections WHERE id='9'"));
  assert.equal(await rev(), r0 + 4);
  // the trigger is replaced once: a second start leaves it as it is
  const sql = async () => (await h.catalog.read("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='plex_vectors_section_update'"))[0].sql;
  const once = await sql();
  assert.match(once, /\bWHEN\b/);
  await createVectors({ catalog: h.catalog, settings: () => h.cfg, now: () => AT }).init();
  assert.equal(await sql(), once);
});

// plexvectors 1.99amo review (finding 3): a films build still reading when invalidate() ran (a model change, a policy change's
// purge) or when the switch went off installed its result anyway when it finished - the old model's index, or an index while
// switched off - kept until the next rebuild (twice the memory during it) or the next status().
test("a films build that finishes after a model change, an invalidate() or switching off is not installed", async (t) => {
  const snapshot = fixture();
  for (let i = 0; i < 100; i++) snapshot.rows.push(row(5000 + i, "Synthetic film " + i));
  const h = await setup(t, snapshot), films = Array.from({ length: 100 }, (_, i) => String(5000 + i));
  const current = await h.catalog.getByKeys(films);
  for (let i = 0; i < current.length; i += 64)
    await h.vectors.put({ model: MODEL, dim: 4, vecs: current.slice(i, i + 64).map((r) => ({ key: r.key, hash: textHash(documentText(r)), ...quantize([1, 0, 0, 0]) })) });
  // the films' first page read waits until the test lets it go
  let release = null;
  const held = { ...h.catalog, admin: { ...h.catalog.admin, read: async (sql, args) => {
    if (/FROM plex_vectors v INDEXED BY plex_vectors_kind/.test(sql) && release === null) await new Promise((resolve) => { release = resolve; });
    return h.catalog.admin.read(sql, args);
  } } };
  const until = async (fn) => { for (let i = 0; i < 400 && !fn(); i++) await new Promise((resolve) => setTimeout(resolve, 5)); assert.ok(fn()); };
  for (const [label, during] of [
    ["a model change", (v) => v.configure({ model: "fixture-embedding-v2", dim: 4 })],
    ["invalidate()", async (v) => { v.invalidate(); }],
    ["switching off", async (v) => { h.cfg.clerk_embed = false; await v.status(); }]]) {
    h.cfg.clerk_embed = true; release = null;
    await h.vectors.configure({ model: MODEL, dim: 4 });
    const vectors = createVectors({ catalog: held, settings: () => h.cfg, now: () => AT });
    const cold = vectors.nearest({ qvec: qvec(), kind: "movie", keys: films, budgetMs: 50 });
    await until(() => typeof release === "function");   // the build is reading its first page
    await during(vectors);
    release();
    await cold; await vectors.idle();
    assert.equal(vectors.stats().films, 0, label + " during the build: its result is not installed - " + JSON.stringify(vectors.stats()));
    if (label === "invalidate()") {
      assert.equal((await vectors.nearest({ qvec: qvec(), kind: "movie", keys: films })).length, 30, "the next ask builds it again");
      await vectors.idle();
      assert.equal(vectors.stats().films, 100);
    }
  }
});
