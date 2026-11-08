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
