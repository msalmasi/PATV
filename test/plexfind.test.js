"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFinder } = require("../plexfind");

function fixture() {
  const settings = { clerk_block_ratings: "X,XXX,AO,R18,R18+", clerk_warn_ratings: "NR,Not Rated,Unrated", library_queue_max_items: 60, library_queue_max_hours: 12 };
  const sections = [{ id: "71", policy: "allowed" }, { id: "72", policy: "adult" }, { id: "73", policy: "off" }];
  const movie = (key, title, patch = {}) => ({ key: String(key), type: "movie", title, section: "71", year: 2001, aired: "2001-01-01", duration: 5000,
    genres: ["Horror"], content_rating: "R", rating: 8, audience_rating: null, studio: "Lantern Studio", cast: ["Aster Willow"], directors: ["Mira Rowan"],
    summary: "A lantern arrives at a quiet station.", shelves: ["Cult Horror"], server_plays: 1, pad_plays: 0, ...patch });
  const rows = [movie(10, "Random Hearts"), movie(11, "Harbour Signal", { year: 1984, aired: "1984-02-02", rating: 6.8 }),
    movie(12, "Harbour Signal Returns", { year: 2024, aired: "2024-03-03", rating: 7.7, server_plays: 80, pad_plays: 4 }),
    movie(13, "Paper Afternoon", { content_rating: "NC-17" }), movie(14, "The Unrated Lantern", { content_rating: "NR" }),
    movie(15, "No Rating Picnic", { content_rating: null }), movie(16, "Adult Beginners", { genres: ["Comedy"] }),
    movie(90, "Synthetic Restricted Title", { section: "72" }), movie(91, "Synthetic Blocked Title", { content_rating: "X" }),
    movie(92, "Synthetic Off Title", { section: "73" }),
    { key: "100", type: "show", title: "Clockwork Orchard", section: "71", year: 2002, genres: ["Comedy"], content_rating: "TV-14", shelves: ["Adult Swim"] },
    { key: "200", type: "show", title: "Clockwork Orchard UK", section: "71", year: 2004, genres: ["Comedy"], content_rating: "NR", shelves: ["Adult Swim"] }];
  for (const show of rows.filter((r) => r.type === "show")) for (let sn = 0; sn <= 3; sn++) for (let ep = 1; ep <= 3; ep++) rows.push({
    ...movie(Number(show.key) * 100 + sn * 10 + ep, `Chapter ${sn}.${ep}`), type: "episode", show_key: show.key, show: show.title,
    season: sn, episode: ep, year: show.year, aired: `200${sn + 3}-01-0${ep}`, duration: 1200, genres: ["Comedy"], shelves: ["Adult Swim"], content_rating: null,
  });
  const data = { rows, settings, sections, ready: true, calls: [], beforeRead: null };
  const visible = (rs) => rs.filter((r) => sections.some((x) => x.id === r.section && x.policy === "allowed"));
  const catalog = {
    async status() { return { ready: data.ready, at: 123, sections }; },
    async rows(f = {}) { data.calls.push(["rows", f]); return structuredClone(visible(rows).filter((r) => (!f.kind || r.type === f.kind) && (!f.show_key || r.show_key === f.show_key))); },
    async getByKeys(keys) { if (data.beforeRead) data.beforeRead(keys); return structuredClone(visible(rows).filter((r) => keys.includes(r.key))); },
    async search(text, f) { data.calls.push(["search", text, f]); return structuredClone(rows.filter((r) => (!f.kind || r.type === f.kind) && (!f.show_key || r.show_key === f.show_key) && (r.title + " " + r.summary).toLowerCase().includes(text.toLowerCase()))); },
  };
  data.external = { search: {}, details: {} }; data.now = Date.UTC(2026, 10, 5);
  const requests = {
    async search(user, q) { data.calls.push(["seerr_search", q, user]); if (data.searchDelay) await new Promise((r) => setTimeout(r, data.searchDelay)); if (data.afterSearch) data.afterSearch(); return structuredClone(data.external.search[q.toLowerCase()] || []); },
    async details(kind, tmdb) { data.calls.push(["seerr_details", kind, tmdb]); return structuredClone(data.external.details[`${kind}:${tmdb}`] || null); },
  };
  data.vectorHits = []; data.vectorCalls = [];
  const vectors = { async nearest(request) {
    data.vectorCalls.push(structuredClone(request));
    if (data.vectorError) throw new Error("Synthetic vector failure");
    if (data.beforeVector) data.beforeVector(request);
    return structuredClone(data.vectorHits);
  } };
  data.catalog = catalog; data.requests = requests;
  data.finder = createFinder({ catalog, settings: () => settings, requests, vectors, now: () => data.now, rng: () => 0, deepMax: { movie: 2, show: 10 } });
  return data;
}
const run = (f, ask, extra = {}, context = {}) => f.finder.find({ ask, ...extra }, context);

function listFixture() {
  const f = fixture(); f.settings.clerk_lists = true; f.keyPresent = true;
  for (const row of f.rows.filter((r) => r.type === "movie")) row.shelves.push("IMDB Top 250");
  f.catalog.shelves = async () => ({ ok: true, genres: ["Horror"], shelves: [
    { name: "IMDB Top 250", count: 7, source: "kometa", ranked: false },
    { name: "Cult Horror", count: 7, source: "kometa", ranked: false },
  ], catalog: { ready: true, at: 123 } });
  f.listRows = [
    { key: "11", rank: 37, list_id: "mdblist:8001", name: "IMDb Top 250", source: "mdblist", ranked: true },
    { key: "12", rank: 101, list_id: "mdblist:8001", name: "IMDb Top 250", source: "mdblist", ranked: true },
    { key: "100", rank: null, list_id: "mdblist:8002", name: "Orchard Picks", source: "mdblist", ranked: false },
  ];
  const lists = {
    async shelves() { return f.keyPresent ? [
      { id: "mdblist:8001", name: "IMDb Top 250", count: 2, kind: "movie", source: "mdblist", ranked: true },
      { id: "mdblist:8002", name: "Orchard Picks", count: 1, kind: "show", source: "mdblist", ranked: false },
    ] : []; },
    async members(filters) { f.calls.push(["list_members", filters]); return f.keyPresent ? structuredClone(f.listRows.filter((r) => r.list_id === filters.id && (!filters.rank_max || r.rank > 0 && r.rank <= filters.rank_max))) : []; },
  };
  f.finder = createFinder({ catalog: f.catalog, settings: () => f.settings, lists, requests: f.requests, now: () => f.now, rng: () => 0, deepMax: { movie: 2, show: 10 } });
  return f;
}

test("phase3 ranks use matched MDBList members ahead of same-name Kometa and never claim completeness", async () => {
  const f = listFixture();
  const r = await run(f, { shelves: ["IMDB Top 250"], rank_max: 100, select: "random" });
  assert.deepEqual(r.rows.map((r) => r.key), ["11"]);
  assert.deepEqual(r.rows[0].shelf, { id: "mdblist:8001", name: "IMDb Top 250", source: "mdblist", ranked: true, rank: 37 });
  assert.equal(r.no_rank, undefined); assert.ok(r.rows[0].shelves.includes("IMDb Top 250"));
  const vocab = await f.finder.shelves(); assert.equal(vocab.shelves.length, 4);
  assert.equal(f.calls.some((r) => String(r[0]).startsWith("seerr")), false);
  const award = await run(f, { select: "random", guesses: [{ kind: "movie", title: "Random Hearts", year: 2001, confidence: .95 }] }, { raw: "an Oscar winner" });
  assert.deepEqual(award.rows, []); assert.equal(award.shelf_missing, true);
  const invalid = await run(f, { select: "random" }, { raw: "IMDb top 0" }); assert.deepEqual(invalid.rows, []);
  await assert.rejects(() => run(f, { shelves: ["IMDb Top 250"], rank_max: -1 }), (e) => e.code === "bad");
});

test("phase3 key/switch off offers only honest unranked Kometa fallback", async () => {
  for (const off of ["key", "switch"]) {
    const f = listFixture(); if (off === "key") f.keyPresent = false; else f.settings.clerk_lists = false;
    const r = await run(f, { shelves: ["IMDB Top 250"], rank_max: 100, select: "random" });
    assert.ok(r.rows.length > 0); assert.equal(r.no_rank, true);
    assert.ok(r.rows.every((row) => row.shelf.source === "kometa" && row.shelf.rank === undefined && row.no_rank));
    assert.ok((await f.finder.shelves()).shelves.every((row) => row.source === "kometa"));
  }
});

test("phase3 unknown explicit or model-dropped lists never become unrestricted picks", async () => {
  const f = listFixture();
  for (const ask of [{ shelves: ["AFI Top 100"], select: "random" }, { unknown_shelves: ["AFI Top 100"], select: "random" }, { rank_max: 100, select: "random" }]) {
    const r = await run(f, ask); assert.deepEqual(r.rows, []); assert.equal(r.shelf_missing, true);
  }
  const r = await run(f, { select: "random" }, { raw: "play something from the AFI top 100" }, { allowSeerr: true });
  assert.deepEqual(r.rows, []); assert.equal(r.shelf_missing, true);
  assert.ok(r.shelf_suggestions.every((s) => ["IMDB Top 250", "IMDb Top 250", "Cult Horror", "Orchard Picks"].includes(s.name)));
  assert.equal(f.calls.some((r) => String(r[0]).startsWith("seerr")), false);
});

test("phase3 raw explicit rank constraint survives dropped interpretation and exact raw title still wins", async () => {
  const f = listFixture();
  const r = await run(f, { select: "random" }, { raw: "play something from the IMDb top 100" });
  assert.deepEqual(r.rows.map((r) => r.key), ["11"]); assert.equal(r.rows[0].shelf.rank, 37);
  const literal = await run(f, { unknown_shelves: ["Missing List"], rank_max: 100, select: "random" }, { raw: "Random Hearts" });
  assert.deepEqual(literal.rows.map((r) => r.key), ["10"]); assert.equal(literal.rows[0].shelf, undefined);
});

test("phase3 list membership and current ratings are rechecked after selection", async () => {
  for (const change of ["remove", "off", "rating"]) {
    const f = listFixture(); f.beforeRead = () => {
      if (change === "remove") f.listRows = [];
      if (change === "off") f.settings.clerk_lists = false;
      if (change === "rating") f.settings.clerk_block_ratings += ",R";
    };
    const r = await run(f, { shelves: ["IMDb Top 250"], rank_max: 100, select: "random" });
    assert.deepEqual(r.rows, [], change);
  }
});

test("phase3 show membership filters its episodes and all explicit filters remain mandatory", async () => {
  const f = listFixture();
  let r = await run(f, { shelves: ["Orchard Picks"], kind: "episode", select: "random" });
  assert.ok(r.rows.length > 0); assert.ok(r.rows.every((r) => r.show_key === "100" && r.shelf.name === "Orchard Picks"));
  r = await run(f, { shelves: ["IMDb Top 250"], rank_max: 100, genres: ["Comedy"], select: "random" });
  assert.deepEqual(r.rows, []);
});
const qvec = { model: "fixture-embed", dim: 2, v: "fwA=", scale: 1 };

test("vectors receive only filtered movies and overlap outranks either single source", async () => {
  const f = fixture(); f.settings.clerk_embed = true;
  const seed = f.rows.find((row) => row.key === "10");
  for (let i = 0; i < 25; i++) f.rows.push({ ...seed, key: String(800 + i), title: `Fixture mood ${i}`, summary: i === 1 ? "quiet space" : "different words", year: 1990, duration: 3600 });
  f.rows.find((row) => row.key === "802").content_rating = "X";
  f.rows.find((row) => row.key === "803").section = "72";
  f.rows.find((row) => row.key === "804").year = 2005;
  f.rows.find((row) => row.key === "805").rating = 3;
  f.rows.find((row) => row.key === "806").pad_plays = 2;
  f.rows.find((row) => row.key === "807").genres = ["Comedy"];
  f.rows.find((row) => row.key === "808").shelves = ["Other shelf"];
  f.rows.find((row) => row.key === "809").duration = 9000;
  f.vectorHits = ["800", "801", "802", "803", ...Array.from({ length: 15 }, (_, i) => String(810 + i))].map((key) => ({ key, score: 1 }));
  const r = await run(f, { kind: "movie", about: "quiet space", genres: ["Horror"], shelves: ["Cult Horror"], years: [1980, 1999], quality: "good", deep_cut: true,
    unseen: true, max_minutes: 90, studio: "Lantern Studio", people: ["Rowan"] }, { qvec, exclude: ["810"] }, { seenKeys: ["811"] });
  assert.equal(f.vectorCalls.length, 1);
  const call = f.vectorCalls[0]; assert.equal(call.kind, "movie"); assert.equal(call.show_key, undefined); assert.deepEqual(call.qvec, qvec);
  assert.ok(call.budgetMs > 0 && call.budgetMs <= 400); assert.equal(call.limit, 30);
  for (const key of ["802", "803", "804", "805", "806", "807", "808", "809", "810", "811", "90", "91", "92"]) assert.ok(!call.keys.includes(key), key);
  assert.equal(r.rows[0].key, "801", "word/vector overlap precedes a higher vector-only rank");
  assert.equal(r.rows[0].why, "vector"); assert.ok(r.rows.every((row) => call.keys.includes(row.key))); assert.ok(r.rows.length <= 20);
  assert.equal(new Set(r.rows.map((row) => row.key)).size, r.rows.length);
});

test("episode vectors stay inside one resolved show and cannot override episode filters", async () => {
  const f = fixture(); f.settings.clerk_embed = true;
  f.vectorHits = [{ key: "10023", score: 1 }, { key: "20023", score: 1 }, { key: "10001", score: 1 }];
  const r = await run(f, { kind: "episode", title: "Clockwork Orchard", about: "astronaut voyage", quality: "good", unseen: true }, { qvec, exclude: ["10011"] }, { seenKeys: ["10012"] });
  assert.deepEqual(r.rows.map((row) => row.key), ["10023"]);
  assert.equal(f.vectorCalls[0].kind, "episode"); assert.equal(f.vectorCalls[0].show_key, "100");
  assert.ok(f.vectorCalls[0].keys.every((key) => key.startsWith("100") && !["10001", "10002", "10003", "10011", "10012"].includes(key)));
  f.vectorCalls.length = 0;
  await run(f, { kind: "episode", title: "Clockwork", about: "astronaut voyage" }, { qvec });
  await run(f, { kind: "episode", about: "astronaut voyage" }, { qvec });
  assert.equal(f.vectorCalls.length, 0, "ambiguous or unknown shows never trigger an episode scan");
});

test("exact, deterministic and verified recall paths never consult vectors", async () => {
  const f = fixture(); f.settings.clerk_embed = true;
  const asks = [{ title: "Random Hearts" }, { title: "Clockwork Orchard", select: "random" }, { title: "Clockwork Orchard", select: "latest" },
    { title: "Clockwork Orchard", select: "season", season: 2 }, { title: "Clockwork Orchard", season: 2, episode: 3 },
    { kind: "movie", select: "in_order" }, { guesses: [episodeGuess()] }, { guesses: [{ kind: "movie", title: "Harbour Signal", year: 1984, confidence: .9 }] }];
  for (const ask of asks) await run(f, ask, { qvec });
  await run(f, { about: "some mood", kind: "movie" }, { raw: "play Random Hearts", qvec });
  assert.equal(f.vectorCalls.length, 0);
});

test("unknown recalls and good deep cuts may use vectors but failures preserve phase 2a", async () => {
  const f = fixture(); f.settings.clerk_embed = true;
  f.vectorHits = [{ key: "10023", score: .8 }];
  const ask = { kind: "episode", title: "Clockwork Orchard", about: "astronaut voyage", guesses: [episodeGuess({ episode_title: "Not the episode" })] };
  let r = await run(f, ask, { qvec });
  assert.deepEqual(r.rows.map((row) => row.key), ["10023"]); assert.equal(r.recall[0].status, "mismatch"); assert.equal(r.rows[0].why, "vector");
  f.vectorHits = [{ key: "10", score: .8 }];
  r = await run(f, { kind: "movie", genres: ["Horror"], shelves: ["Cult Horror"], deep_cut: true, quality: "good" }, { qvec });
  assert.deepEqual(r.rows.map((row) => row.key), ["10"]);
  const fallback = { kind: "movie", about: "lantern" };
  const baseline = await run(f, fallback);
  f.vectorHits = []; assert.deepEqual(await run(f, fallback, { qvec }), baseline);
  f.vectorError = true; assert.deepEqual(await run(f, fallback, { qvec }), baseline);
  f.settings.clerk_embed = false; f.vectorCalls.length = 0;
  assert.deepEqual(await run(f, fallback, { qvec }), baseline); assert.equal(f.vectorCalls.length, 0);
});

test("vector results are capped and reread after a concurrent policy or metadata change", async () => {
  const f = fixture(); f.settings.clerk_embed = true;
  const seed = f.rows.find((row) => row.key === "10");
  for (let i = 0; i < 35; i++) f.rows.push({ ...seed, key: String(800 + i), title: `Synthetic scene ${i}` });
  f.vectorHits = Array.from({ length: 35 }, (_, i) => ({ key: String(800 + i), score: 1 - i / 100 }));
  let r = await run(f, { kind: "movie", about: "unmatched mood" }, { qvec });
  assert.equal(r.rows.length, 20);
  f.beforeVector = () => { f.rows.find((row) => row.key === "800").content_rating = "X"; f.rows.find((row) => row.key === "801").title = "Refreshed scene"; };
  r = await run(f, { kind: "movie", about: "unmatched mood" }, { qvec });
  assert.ok(!r.rows.some((row) => row.key === "800")); assert.equal(r.rows.find((row) => row.key === "801").title, "Refreshed scene");
  assert.doesNotMatch(JSON.stringify(r), /Synthetic scene 0/);
});

test("finder merges real catalog vectors without a provider and falls back on model changes", async (t) => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const { createCatalog } = require(path.join(process.env.PATV_SITE_DIR || path.resolve(__dirname, ".."), "plexcatalog.js"));
  const { createVectors, quantize } = require("../plexvectors");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clerk-find-vectors-")), clock = Date.UTC(2026, 10, 5, 12);
  const settings = { clerk_embed: true, clerk_embed_k: 30, clerk_block_ratings: "X,XXX,AO,R18,R18+" };
  const catalog = createCatalog({ file: path.join(dir, "fixture.db"), settings: () => settings, now: () => clock, log: { log() {}, error() {} } });
  t.after(async () => { await catalog.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const common = { year: 2020, content_rating: "PG", rating: 8, duration: 1200, genres: ["Science Fiction"] };
  const rows = [
    { ...common, key: "1", type: "movie", title: "Orbital Postcards", section: "1", summary: "A NASA mission visits a satellite." },
    { ...common, key: "2", type: "movie", title: "Quiet Meadow", section: "1", summary: "A peaceful walk beside the river.", genres: ["Comedy"] },
    { ...common, key: "10", type: "show", title: "Fixture Space Diary", section: "2", content_rating: "TV-14" },
    { ...common, key: "11", type: "episode", title: "Moon Lunch", section: "2", show_key: "10", show: "Fixture Space Diary", season: 1, episode: 1, summary: "A NASA mission visits a satellite." },
    { ...common, key: "12", type: "episode", title: "Afternoon Garden", section: "2", show_key: "10", show: "Fixture Space Diary", season: 1, episode: 2, summary: "A peaceful walk beside the river." },
  ];
  await catalog.importSnapshot({ v: 1, allow_list_set: true, rows, shelves: [], sections: [
    { id: "1", title: "Fixture Films", type: "movie", policy: "allowed" }, { id: "2", title: "Fixture Shows", type: "show", policy: "allowed" },
  ] });
  const vectors = createVectors({ catalog, settings: () => settings, now: () => clock });
  const pending = await vectors.todo({ model: "fixture-embed", dim: 2, limit: 64 });
  assert.equal(pending.ok, true); assert.equal(pending.rows.length, 5);
  const uploaded = await vectors.put({ model: "fixture-embed", dim: 2, vecs: pending.rows.map((row) => ({ key: row.key, hash: row.hash,
    ...quantize(["1", "11"].includes(row.key) ? [1, 0] : [0, 1]) })) });
  assert.equal(uploaded.stored, 5);
  const finder = createFinder({ catalog, settings: () => settings, vectors, deepMax: { movie: 2, show: 10 } });
  const ask = { kind: "movie", genres: ["Science Fiction"], about: "astronaut" };
  const found = await finder.find({ ask, qvec });
  assert.deepEqual(found.rows.map((row) => [row.key, row.why]), [["1", "vector"]]);
  const episode = await finder.find({ ask: { kind: "episode", title: "Fixture Space Diary", about: "astronaut" }, qvec });
  assert.equal(episode.rows[0].key, "11"); assert.ok(episode.rows.every((row) => row.show_key === "10"));
  const wrongYears = await finder.find({ ask: { kind: "episode", title: "Fixture Space Diary", about: "astronaut", years: [1990, 1999] }, qvec });
  assert.deepEqual(wrongYears.rows, []);
  assert.deepEqual((await finder.find({ ask, qvec: { ...qvec, model: "other-fixture-model" } })).rows, []);
  assert.deepEqual((await finder.find({ ask })).rows, []);
  settings.clerk_block_ratings += ",PG";
  assert.deepEqual((await finder.find({ ask, qvec })).rows, []);
});

test("raw exact titles override selection words, including command forms; ordinary words never gate a title", async () => {
  const f = fixture();
  for (const raw of ["Random Hearts", "pepe play Random Hearts", "!plex Random Hearts"]) {
    const r = await run(f, { title: "hearts", select: "random" }, { raw });
    assert.equal(r.exact, true); assert.deepEqual(r.rows.map((x) => x.key), ["10"]);
  }
  const r = await run(f, { title: "Adult Beginners" }, { raw: "play Adult Beginners" });
  assert.deepEqual(r.rows.map((x) => x.key), ["16"]);
  const wrongKind = await run(f, { title: "hearts", select: "latest", kind: "show", year: 1980 }, { raw: "play Random Hearts" });
  assert.deepEqual(wrongKind.rows.map((x) => x.key), ["10"]); assert.equal(wrongKind.exact, true);
  const episode = f.rows.find((r) => r.key === "10023"); episode.title = "The Last Lantern";
  // 1.99?? clerkreq: a film / show ask never takes an episode that only shares the name (it is kept aside: episode_named); a bare
  // line that only an episode's title matches is that episode, but never "exact" (it may be a show or film we don't carry)
  const rawEpisode = await run(f, { title: "lantern", select: "latest", kind: "movie" }, { raw: "play The Last Lantern" });
  assert.ok(!rawEpisode.rows.some((x) => x.key === "10023"), "a film ask's films ('lantern'), never the episode"); assert.equal(rawEpisode.exact, false);
  const onlyEpisode = await run(f, { title: "The Last Lantern", kind: "movie" }, { raw: "play The Last Lantern" });
  assert.deepEqual(onlyEpisode.rows, []); assert.deepEqual(onlyEpisode.episode_named.map((x) => x.key), ["10023"]);
  const bareEpisode = await run(f, { title: "lantern", select: "latest" }, { raw: "play The Last Lantern" });
  assert.deepEqual(bareEpisode.rows.map((x) => [x.key, x.why]), [["10023", "episode_named"]]); assert.equal(bareEpisode.exact, false);
  const askedEpisode = await run(f, { title: "lantern", select: "latest", kind: "episode" }, { raw: "play The Last Lantern" });
  assert.deepEqual(askedEpisode.rows.map((x) => x.key), ["10023"]); assert.equal(askedEpisode.exact, true);
});

test("episodes: latest, missing dates, pilot, finale, specials, last N order and ambiguous shows", async () => {
  const f = fixture();
  let r = await run(f, { title: "Clockwork Orchard", select: "latest" });
  assert.deepEqual(r.rows.map((x) => x.key), ["10033"]);
  f.rows.find((x) => x.key === "10033").aired = null;
  r = await run(f, { title: "Clockwork Orchard", select: "latest" }); assert.equal(r.rows[0].key, "10033");
  assert.equal((await run(f, { title: "Clockwork Orchard", select: "pilot" })).rows[0].key, "10011");
  assert.equal((await run(f, { title: "Clockwork Orchard", select: "finale", season: 2 })).rows[0].key, "10023");
  r = await run(f, { title: "Clockwork Orchard", select: "last_n", n: 3 });
  assert.deepEqual(r.rows[0].keys, ["10031", "10032", "10033"]);
  assert.equal(r.rows[0].items, 3); assert.equal(r.rows[0].total_sec, 3600);
  r = await run(f, { title: "Clockwork Orchard", select: "random" }); assert.ok(r.rows.every((x) => x.season > 0));
  assert.equal((await run(f, { title: "Clockwork Orchard", season: 0, episode: 2 })).rows[0].key, "10002");
  r = await run(f, { title: "Clockwork", select: "season", season: 1 });
  assert.equal(r.rows.length, 2); assert.ok(r.rows.every((x) => x.kind === "season"));
});

test("same-name shows keep stable parent identities and visible years, without making genre pools ambiguous", async () => {
  const f = fixture();
  f.rows.find((r) => r.key === "200").title = "Clockwork Orchard";
  for (const row of f.rows.filter((r) => r.show_key === "200")) row.show = "Clockwork Orchard";
  for (const select of ["random", "latest", "season", "series"]) {
    const r = await run(f, { title: "Clockwork Orchard", select, ...(select === "season" ? { season: 1 } : {}) });
    assert.equal(r.ambiguous, true, select);
    assert.equal(r.rows.length, 2);
    assert.deepEqual(r.rows.map((row) => row.show_key).sort(), ["100", "200"]);
    for (const row of r.rows) {
      assert.equal(row.show_year, row.show_key === "100" ? 2002 : 2004);
      assert.match(row.label, new RegExp(`Clockwork Orchard \\(${row.show_year}\\)`));
    }
  }
  const exact = await run(f, { title: "Orchard", select: "random" }, { raw: "Clockwork Orchard" });
  assert.equal(exact.exact, true); assert.equal(exact.ambiguous, true);
  assert.deepEqual(exact.rows.map((r) => r.key), ["10011", "20011"]);
  const year = await run(f, { title: "Clockwork Orchard", select: "random", year: 2004 });
  assert.equal(year.ambiguous, undefined); assert.ok(year.rows.every((r) => r.show_key === "200"));
  const pool = await run(f, { kind: "episode", genres: ["Comedy"], select: "random" });
  assert.equal(pool.ambiguous, undefined);
  assert.ok(pool.rows.some((r) => r.show_key === "100") && pool.rows.some((r) => r.show_key === "200"));
  f.beforeRead = () => { f.rows.find((r) => r.key === "200").content_rating = "X"; };
  const filtered = await run(f, { title: "Clockwork Orchard", select: "random" });
  assert.equal(filtered.ambiguous, undefined); assert.deepEqual(filtered.rows.map((r) => r.show_key), ["100"]);
  assert.ok(filtered.rows.every((r) => !r.label.includes("(2004)")), "revoked show metadata does not survive the last read");
});

test("only a bare named show falls back to its first episode; unmatched rich and unspecified episode asks do not", async () => {
  const f = fixture();
  assert.equal((await run(f, { title: "Clockwork Orchard" })).rows[0].key, "10011");
  const missed = await run(f, { title: "Clockwork Orchard", about: "a comet that never exists" });
  assert.deepEqual(missed.rows, []); assert.equal(missed.exact, false); assert.equal(missed.alternatives.length, 3);
  assert.ok(missed.alternatives.every((row) => row.kind === "season" && row.scope === "season" && row.keys.length === 3));
  const unspecified = await run(f, { title: "Clockwork", kind: "episode" });
  assert.deepEqual(unspecified.rows, []); assert.equal(unspecified.alternatives.length, 5);
  assert.ok(unspecified.alternatives.some((row) => row.label.includes("UK")), "ambiguous show labels remain distinct");
});

test("movie release order, exact names, list caps, series and cam single-title restriction", async () => {
  const f = fixture();
  assert.equal((await run(f, { title: "Harbour Signal", kind: "movie", select: "latest" })).rows[0].key, "12");
  assert.equal((await run(f, { title: "Harbour Signal", kind: "movie", select: "oldest" })).rows[0].key, "11");
  assert.deepEqual((await run(f, { title: "Harbour Signal", kind: "movie", select: "in_order" })).rows[0].keys, ["11", "12"]);
  f.settings.library_queue_max_items = 2;
  const r = await run(f, { title: "Clockwork Orchard", select: "series" });
  assert.equal(r.rows[0].kind, "show"); assert.deepEqual(r.rows[0].keys, ["10011", "10012"]); assert.deepEqual(r.cut, { asked: 9, queued: 2 });
  const capped = await run(f, { title: "Clockwork Orchard", select: "season", season: 1 }, {}, { maxSec: 1300 });
  assert.equal(capped.rows[0].items, 1); assert.equal(capped.rows[0].total_sec, 1200);
  assert.deepEqual((await run(f, { title: "Clockwork Orchard", select: "series" }, { target: "cam" })).rows, []);
});

test("basic details, quality, deep cuts, own unseen keys, popular and reroll exclusions", async () => {
  const f = fixture();
  assert.deepEqual((await run(f, { kind: "movie", genres: ["Horror"], years: [1980, 1989], people: ["Rowan"], studio: "Lantern Studio", max_minutes: 90 })).rows.map((x) => x.key), ["11"]);
  const best = await run(f, { kind: "movie", quality: "best", deep_cut: true });
  assert.ok(best.rows.every((r) => r.rating >= 7.5 && r.deep_cut)); assert.ok(!best.rows.some((r) => r.key === "12"));
  assert.equal((await run(f, { kind: "movie", popular: true })).rows[0].key, "12");
  const unseen = await run(f, { kind: "movie", unseen: true, select: "random" }, { exclude: ["11", "90", "91"] }, { seenKeys: ["10"] });
  assert.ok(unseen.rows.length > 0); assert.ok(unseen.rows.every((r) => !["10", "11", "90", "91", "92"].includes(r.key)));
  assert.ok((await run(f, { kind: "movie", select: "random" }, {}, { seenKeys: ["10"] })).rows.some((r) => r.key === "10"), "recent history is not an implicit filter");
  assert.equal(new Set(unseen.rows.map((r) => r.key)).size, unseen.rows.length);
});

test("section/rating boundaries apply to FTS and every last read, and lists fail as a whole", async () => {
  const f = fixture();
  f.rows.find((r) => r.key === "91").summary = "needle";
  f.rows.find((r) => r.key === "90").summary = "needle";
  assert.deepEqual((await run(f, { kind: "movie", about: "needle", guesses: [{ key: "90" }] }, { exclude: ["91"] })).rows, []);
  f.beforeRead = () => { f.rows.find((r) => r.key === "10").content_rating = "X"; };
  assert.deepEqual((await run(f, { title: "Random Hearts" })).rows, []);
  await assert.rejects(() => f.finder.validateKeys(["11", "90"]), (e) => e.code === "not_found" && !e.message.includes("Restricted"));
  f.beforeRead = () => { f.rows.find((r) => r.key === "10012").section = "72"; };
  assert.deepEqual((await run(f, { title: "Clockwork Orchard", select: "season", season: 1 })).rows, []);
  f.beforeRead = () => { f.rows.find((r) => r.key === "100").content_rating = "X"; };
  f.rows.find((r) => r.key === "10011").content_rating = "PG";
  assert.deepEqual((await run(f, { title: "Clockwork Orchard", select: "pilot" })).rows, [], "even an episode with its own safe rating cannot expose a now-blocked show");
});

test("warnings follow current settings and episode show fallback; catalog down serves no descriptive picks", async () => {
  const f = fixture();
  assert.equal((await run(f, { title: "Paper Afternoon" })).rows[0].warn, "nc17");
  assert.equal((await run(f, { title: "The Unrated Lantern" })).rows[0].warn, "unrated");
  assert.equal((await run(f, { title: "No Rating Picnic" })).rows[0].warn, "unrated");
  assert.equal((await run(f, { title: "Clockwork Orchard UK", season: 1, episode: 1 })).rows[0].warn, "unrated");
  f.settings.clerk_warn_ratings = "R";
  assert.equal((await run(f, { title: "Random Hearts" })).rows[0].warn, "unrated");
  f.settings.clerk_block_ratings += ",R";
  assert.deepEqual((await run(f, { title: "Random Hearts" })).rows, []);
  f.ready = false;
  const out = await run(f, { select: "random" }); assert.deepEqual(out.rows, []); assert.equal(out.catalog.ready, false);
});

test("random uses the supplied integer draw over the whole filtered pool and never a recent-play skip", async () => {
  const f = fixture(); let draw = 0;
  const picked = new Set();
  const catalog = { async status() { return { ready: true, sections: f.sections }; }, async rows({ kind }) { return f.rows.filter((r) => r.type === kind); }, async getByKeys(keys) { return f.rows.filter((r) => keys.includes(r.key)); } };
  const finder = createFinder({ catalog, settings: () => f.settings, rng: (max) => draw % max, deepMax: { movie: 2, show: 10 } });
  for (draw = 0; draw < 7; draw++) picked.add((await finder.find({ ask: { select: "random", kind: "movie" }, limit: 1 })).rows[0].key);
  assert.equal(picked.size, 7, "each eligible film occupies one equal-sized part of the draw");
});

const externalContext = { allowSeerr: true, user: { userId: "fixture-user" } };
const episodeGuess = (patch = {}) => ({ kind: "episode", show: "Clockwork Orchard", season: 2, episode: 3, episode_title: "Chapter 2.3", confidence: .9, ...patch });

test("recall checks show/name/SxE and treats IDs only as hints", async () => {
  const f = fixture();
  let r = await run(f, { title: "Clockwork", about: "a detail absent from the summary", guesses: [episodeGuess({ tmdb: "999999" })] });
  assert.equal(r.rows[0].key, "10023"); assert.equal(r.rows[0].why, "recall");
  assert.deepEqual(r.recall, [{ guess: 0, status: "in", key: "10023", match: "exact" }]);
  r = await run(f, { guesses: [episodeGuess({ episode: 2 })] });
  assert.equal(r.rows[0].key, "10023"); assert.equal(r.rows[0].why, "guess"); assert.equal(r.recall[0].match, "partial");
  r = await run(f, { guesses: [episodeGuess({ season: null, episode: null })] });
  assert.equal(r.rows[0].key, "10023"); assert.equal(r.recall[0].match, "partial");
  r = await run(f, { title: "Clockwork Orchard", guesses: [episodeGuess({ episode_title: "A nonexistent chapter" })] });
  assert.deepEqual(r.rows, []); assert.equal(r.recall[0].status, "mismatch");
  r = await run(f, { title: "Clockwork Orchard", guesses: [episodeGuess({ season: 12, episode: 3 })] });
  assert.deepEqual(r.rows, []); assert.equal(r.recall[0].status, "unknown");
  assert.equal(f.calls.filter((x) => x[0] === "seerr_search").length, 0);
});

// 1.99amq plexfind recall (owner 2026-11-08: "the episode of star trek where they communicate by telling stories" - the model answered in
// 6.4 s and its guess came back "unknown": "I'm not sure which one that is"). An episode guess's year is often the EPISODE's air year
// (Darmok 1991, The Next Generation 1987) and its show the franchise's name; the right episode must still verify, a wrong one must not.
test("an episode recall verifies with the episode's air year, and a franchise name finds its one show", async () => {
  const f = fixture();     // Clockwork Orchard (2002): S2E3 "Chapter 2.3" aired 2005-01-03 (episode year 2002, the show's)
  let r = await run(f, { kind: "episode", guesses: [episodeGuess({ year: 2005 })] });
  assert.deepEqual(r.rows.map((x) => [x.key, x.why]), [["10023", "recall"]], "the air year");
  assert.deepEqual(r.recall, [{ guess: 0, status: "in", key: "10023", match: "exact" }]);
  r = await run(f, { kind: "episode", guesses: [episodeGuess({ year: 2002 })] });
  assert.deepEqual(r.rows.map((x) => x.key), ["10023"], "the show's year still works");
  r = await run(f, { kind: "episode", guesses: [episodeGuess({ year: 1990 })] });
  assert.deepEqual(r.rows, [], "a year that is neither"); assert.equal(r.recall[0].status, "unknown");
  r = await run(f, { kind: "show", guesses: [{ kind: "show", title: "Clockwork Orchard", year: 2005, confidence: .9 }] });
  assert.deepEqual(r.rows, [], "a SHOW guess still needs the show's own year"); assert.equal(r.recall[0].status, "unknown");
  // the franchise's name ("Star Trek" for The Next Generation): one show of the family has that episode title (and numbers)
  f.rows.find((x) => x.key === "20023").title = "The Pear Tree";
  r = await run(f, { kind: "episode", guesses: [episodeGuess({ show: "Clockwork", episode_title: "The Pear Tree" })] });
  assert.deepEqual(r.rows.map((x) => [x.key, x.why]), [["20023", "recall"]], "no show is called Clockwork: its family's one Pear Tree");
  r = await run(f, { kind: "episode", guesses: [episodeGuess({ show: "Clockwork Orchard", episode_title: "The Pear Tree", year: 2005 })] });
  assert.deepEqual(r.rows.map((x) => x.key), ["20023"], "the named show's S2E3 is another episode: the family's exact match");
  assert.equal(r.recall[0].status, "in");
  r = await run(f, { kind: "episode", guesses: [episodeGuess({ show: "Clockwork", season: 1, episode: 1, episode_title: "Chapter 1.1" })] });
  assert.deepEqual(r.rows, [], "both shows have a Chapter 1.1 S1E1: never a guess between them"); assert.notEqual(r.recall[0].status, "in");
  r = await run(f, { kind: "episode", guesses: [episodeGuess({ show: "Clockwork", episode_title: "The Pear Tree", season: 1, episode: 1 })] });
  assert.deepEqual(r.rows, [], "the title in the family but not those numbers"); assert.notEqual(r.recall[0].status, "in");
  r = await run(f, { kind: "episode", guesses: [episodeGuess({ show: "Clock", episode_title: "The Pear Tree" })] });
  assert.deepEqual(r.rows, [], "a family is whole words: Clock is not Clockwork");
  r = await run(f, { kind: "episode", guesses: [episodeGuess({ show: "Clockwork", episode_title: "The Pear Tree", year: 1990 })] });
  assert.deepEqual(r.rows, [], "the family's match still checks the year");
  assert.equal(f.calls.filter((x) => x[0] === "seerr_search").length, 0);
});

test("movie recalls require title/year, ambiguous title-only recalls remain choices, and raw exact wins", async () => {
  const f = fixture(), guess = { kind: "movie", title: "Harbour Signal", year: 1985, confidence: .9 };
  let r = await run(f, { guesses: [guess] }); assert.equal(r.rows[0].key, "11"); assert.equal(r.recall[0].match, "exact");
  r = await run(f, { guesses: [{ ...guess, year: 1987 }] }); assert.deepEqual(r.rows, []); assert.equal(r.recall[0].status, "unknown");
  f.rows.push({ ...f.rows.find((x) => x.key === "11"), key: "17", year: 2005 });
  r = await run(f, { guesses: [{ ...guess, year: null }] });
  assert.equal(r.rows.length, 2); assert.equal(r.recall[0].match, "partial"); assert.equal(r.recall[0].key, undefined);
  r = await run(f, { guesses: [guess] }, { raw: "Random Hearts" });
  assert.deepEqual(r.rows.map((x) => x.key), ["10"]); assert.deepEqual(r.recall, []);
});

test("uncertain recalls use scoped FTS, rich misses never become S1E1, and best uses episode ratings", async () => {
  const f = fixture(); f.rows.find((r) => r.key === "10023").summary = "A winter lantern celebration";
  let r = await run(f, { title: "Clockwork Orchard", about: "winter", guesses: [episodeGuess({ confidence: .2 })] });
  assert.deepEqual(r.rows.map((x) => x.key), ["10023"]); assert.equal(r.rows[0].why, "fts"); assert.deepEqual(r.recall, []);
  assert.ok(f.calls.some((c) => c[0] === "search" && c[2].show_key === "100" && c[2].budgetMs === 400));
  r = await run(f, { title: "Clockwork Orchard", about: "candy bar" }); assert.deepEqual(r.rows, []);
  f.rows.find((x) => x.key === "10022").rating = 9.4;
  r = await run(f, { title: "Clockwork Orchard", kind: "episode", quality: "best" }); assert.equal(r.rows[0].key, "10022");
});

test("missing recalls need Seerr confirmation, cache their one lookup, and never expose availability-gated metadata", async () => {
  const f = fixture();
  f.external.search["clockwork orchard"] = [{ type: "tv", tmdb: 501, title: "Clockwork Orchard", year: 2002, media_status: 4, availability: "partial", overview: "NEVER-OVERVIEW", poster: "/NEVER-POSTER" }];
  f.external.details["tv:501"] = { type: "tv", tmdb: 501, title: "Clockwork Orchard", year: 2002, media_status: 4, seasons: [{ n: 4, episodes: 8, status: 1 }] };
  let r = await run(f, { guesses: [episodeGuess({ season: 4, episode: 3, episode_title: "Unknown to Plex" })] }, {}, externalContext);
  assert.equal(r.recall[0].status, "missing"); assert.equal(r.seerr.season, 4); assert.equal(r.seerr.tmdb, 501);
  assert.doesNotMatch(JSON.stringify(r), /NEVER|Unknown to Plex/);
  await run(f, { guesses: [episodeGuess({ season: 4, episode: 3 })] }, {}, externalContext);
  assert.equal(f.calls.filter((x) => x[0] === "seerr_search").length, 1); assert.equal(f.calls.filter((x) => x[0] === "seerr_details").length, 1);
  r = await run(f, { guesses: [episodeGuess({ season: 12, episode: 3 })] }, {}, externalContext);
  assert.equal(r.recall[0].status, "unknown"); assert.equal(r.seerr, undefined);
  f.now += 24 * 3600 * 1000 + 1;
  f.external.search["clockwork orchard"][0].media_status = 5;
  r = await run(f, { guesses: [episodeGuess({ season: 4 })] }, {}, externalContext);
  assert.equal(r.code, "unavailable"); assert.deepEqual(r.rows, []); assert.doesNotMatch(JSON.stringify(r), /Clockwork|501/);
});

test("typed missing titles are folded-equal only; requests off/18+ make no external calls; one guess lookup maximum", async () => {
  const f = fixture(); f.external.search["distant lantern"] = [{ type: "movie", tmdb: 601, title: "Distant Lantern", year: 2020, availability: "unknown" }];
  let r = await run(f, { title: "Distant Lantern", year: 2020 }, {}, externalContext);
  assert.equal(r.seerr.title, "Distant Lantern");
  f.calls.length = 0;
  r = await run(f, { title: "Distant Lantern" }, {}, { allowSeerr: false });
  assert.equal(r.seerr, undefined); assert.equal(f.calls.filter((x) => x[0] === "seerr_search").length, 0);
  f.external.search["distant"] = f.external.search["distant lantern"];
  r = await run(f, { title: "Distant" }, {}, externalContext); assert.equal(r.seerr, undefined);
  f.calls.length = 0;
  r = await run(f, { guesses: [{ kind: "movie", title: "Missing One", year: 2020, confidence: .9 }, { kind: "movie", title: "Distant Lantern", year: 2020, confidence: .8 }] }, {}, externalContext);
  assert.equal(f.calls.filter((x) => x[0] === "seerr_search").length, 1); assert.deepEqual(r.rows, []);
});

test("browse uses three added-order suggestions; like uses shared metadata and excludes its reference", async () => {
  const f = fixture(); f.rows.find((r) => r.key === "11").added = 100; f.rows.find((r) => r.key === "12").added = 200;
  const r = await run(f, { action: "browse", select: "latest", kind: "movie" });
  assert.equal(r.rows.length, 3); assert.deepEqual(r.rows.slice(0, 2).map((x) => x.key), ["12", "11"]);
  f.rows.push({ ...f.rows.find((x) => x.key === "11"), key: "18", title: "Harbour Quiet", year: 1988 });
  const similar = await run(f, { kind: "movie", like: "Harbour Signal" });
  assert.equal(similar.rows[0].key, "18"); assert.ok(!similar.rows.some((r) => r.key === "11"));
  const noShow = await run(f, { kind: "episode", about: "winter" }); assert.deepEqual(noShow.rows, []);
});

test("newer-release notes require a past year, exclude library titles and block already-available hidden titles", async () => {
  const f = fixture(); f.external.search["harbour signal"] = [
    { type: "movie", tmdb: 701, title: "Harbour Signal Forever", year: 2025, media_status: 1, availability: "unknown" },
    { type: "movie", tmdb: 702, title: "Harbour Signal Tomorrow", year: 2026, media_status: 1, availability: "unknown" },
  ];
  let r = await run(f, { kind: "movie", title: "Harbour Signal", select: "latest" }, {}, externalContext);
  assert.equal(r.rows[0].key, "12"); assert.equal(r.seerr.tmdb, 701);
  f.now += 24 * 3600 * 1000 + 1; f.external.search["harbour signal"][0].media_status = 5;
  r = await run(f, { kind: "movie", title: "Harbour Signal", select: "latest" }, {}, externalContext);
  assert.equal(r.code, "unavailable"); assert.doesNotMatch(JSON.stringify(r), /Forever|701/);
});

test("recall candidates obey final rating and section checks, including a newly blocked parent", async () => {
  const f = fixture(); f.beforeRead = () => { f.rows.find((r) => r.key === "100").content_rating = "X"; };
  const r = await run(f, { guesses: [episodeGuess()] });
  assert.deepEqual(r.rows, []); assert.deepEqual(r.recall, [{ guess: 0, status: "unknown" }]);
  assert.doesNotMatch(JSON.stringify(r), /Clockwork|10023/);
});

test("a recalled missing movie without a year stays unknown; best unrated episodes require verified recall", async () => {
  const f = fixture(); f.external.search["distant lantern"] = [{ type: "movie", tmdb: 601, title: "Distant Lantern", year: 2020, availability: "unknown" }];
  let r = await run(f, { guesses: [{ kind: "movie", title: "Distant Lantern", confidence: .9 }] }, {}, externalContext);
  assert.equal(r.recall[0].status, "unknown"); assert.equal(r.seerr, undefined);
  f.rows.find((row) => row.key === "10023").rating = null;
  r = await run(f, { kind: "episode", quality: "best", guesses: [episodeGuess()] });
  assert.deepEqual(r.rows.map((row) => row.key), ["10023"]); assert.equal(r.rows[0].why, "recall");
});

test("Seerr lookup has a two-second cap and ignores late metadata", async () => {
  const f = fixture(); f.searchDelay = 2200;
  f.external.search["late lantern"] = [{ type: "movie", tmdb: 801, title: "Late Lantern", year: 2020, availability: "unknown" }];
  const started = Date.now(), r = await run(f, { title: "Late Lantern" }, {}, externalContext);
  assert.ok(Date.now() - started < 2150, "the lookup did not wait for the delayed provider");
  assert.equal(r.seerr, undefined); assert.deepEqual(r.rows, []);
});

test("Seerr cache evicts least-recent titles at 500 entries", async () => {
  const f = fixture();
  for (let i = 0; i <= 500; i++) await run(f, { title: `Cache Lantern ${i}` }, {}, externalContext);
  const before = f.calls.filter((c) => c[0] === "seerr_search").length;
  await run(f, { title: "Cache Lantern 500" }, {}, externalContext);
  assert.equal(f.calls.filter((c) => c[0] === "seerr_search").length, before);
  await run(f, { title: "Cache Lantern 0" }, {}, externalContext);
  assert.equal(f.calls.filter((c) => c[0] === "seerr_search").length, before + 1);
});

test("a slow newer lookup cannot preserve a row whose rating changed during external I/O", async () => {
  const f = fixture();
  f.afterSearch = () => { f.rows.find((row) => row.key === "12").content_rating = "X"; };
  const r = await run(f, { title: "Harbour Signal", kind: "movie", select: "latest" }, {}, externalContext);
  assert.deepEqual(r.rows, []); assert.doesNotMatch(JSON.stringify(r), /Harbour Signal Returns/);
});

test("recalled title variants require a picker after final policy checks, including film-list asks", async () => {
  const f = fixture();
  f.rows.push({ ...f.rows.find((row) => row.key === "11"), key: "19", year: 2020, aired: "2020-01-01" });
  const guess = { kind: "movie", title: "Harbour Signal", confidence: .9 };
  for (const select of ["one", "in_order"]) {
    const r = await run(f, { kind: "movie", select, guesses: [guess] });
    assert.equal(r.ambiguous, true);
    assert.deepEqual(r.rows.map((row) => row.key), ["11", "19"]);
    assert.ok(r.rows.every((row) => row.kind === "movie" && !row.keys), "same-title variants are never combined into a queue");
  }
  f.beforeRead = () => { f.rows.find((row) => row.key === "19").content_rating = "X"; };
  const filtered = await run(f, { guesses: [guess] });
  assert.equal(filtered.ambiguous, undefined);
  assert.deepEqual(filtered.rows.map((row) => row.key), ["11"]);
  assert.doesNotMatch(JSON.stringify(filtered), /2020|"19"/);
});

test("same-name recalled show editions retain their separate numbered choices", async () => {
  const f = fixture();
  f.rows.find((row) => row.key === "200").title = "Clockwork Orchard";
  for (const row of f.rows.filter((row) => row.show_key === "200")) row.show = "Clockwork Orchard";
  const r = await run(f, { kind: "episode", guesses: [{ kind: "episode", show: "Clockwork Orchard", season: 2, episode: 3,
    episode_title: "Chapter 2.3", confidence: .9 }] });
  assert.equal(r.ambiguous, true);
  assert.deepEqual(r.rows.map((row) => row.show_key), ["100", "200"]);
  assert.ok(r.rows[0].label.includes("(2002)")); assert.ok(r.rows[1].label.includes("(2004)"));
});

test("Unicode recalls verify actual movie, show and episode names", async () => {
  const f = fixture();
  f.rows.find((row) => row.key === "11").title = "春の灯";
  f.rows.find((row) => row.key === "12").title = "秋の雨";
  const movie = await run(f, { guesses: [{ kind: "movie", title: "春の灯", year: 1984, confidence: .9 }] });
  assert.deepEqual(movie.rows.map((row) => row.key), ["11"]);
  for (const title of ["春の雨", "..."]) {
    const miss = await run(f, { guesses: [{ kind: "movie", title, year: 1984, confidence: .9 }] });
    assert.deepEqual(miss.rows, []); assert.equal(miss.recall[0].status, "unknown");
  }
  f.rows.find((row) => row.key === "100").title = "Зимняя Башня";
  f.rows.find((row) => row.key === "200").title = "Летняя Башня";
  f.rows.find((row) => row.key === "10023").title = "冬の便り";
  const guess = episodeGuess({ show: "зимняя башня", episode_title: "冬の便り" });
  const hit = await run(f, { guesses: [guess] });
  assert.deepEqual(hit.rows.map((row) => row.key), ["10023"]);
  const wrongEpisode = await run(f, { guesses: [{ ...guess, episode_title: "夏の便り" }] });
  assert.deepEqual(wrongEpisode.rows, []); assert.equal(wrongEpisode.recall[0].status, "mismatch");
});

test("Seerr never verifies a different Unicode title or shares its cache entry", async () => {
  const f = fixture();
  for (const [title, tmdb] of [["春の灯", 901], ["秋の雨", 902]]) {
    f.external.search[title] = [{ type: "movie", title, tmdb, year: 2020, availability: "unknown" }];
    const r = await run(f, { kind: "movie", title, year: 2020 }, {}, externalContext);
    assert.equal(r.seerr.title, title); assert.equal(r.seerr.tmdb, tmdb);
  }
  assert.equal(f.calls.filter((call) => call[0] === "seerr_search").length, 2);
  f.external.search["冬の星"] = f.external.search["秋の雨"];
  const wrong = await run(f, { kind: "movie", title: "冬の星", year: 2020 }, {}, externalContext);
  assert.equal(wrong.seerr, undefined); assert.deepEqual(wrong.rows, []);
  const before = f.calls.length;
  const empty = await run(f, { kind: "movie", title: "...", year: 2020 }, {}, externalContext);
  assert.equal(empty.seerr, undefined); assert.deepEqual(empty.rows, []);
  assert.equal(f.calls.slice(before).some((call) => call[0] === "seerr_search"), false);
  f.external.search["北の塔"] = [{ type: "tv", title: "北の塔", tmdb: 903, year: 2020, availability: "partial" }];
  f.external.details["tv:903"] = { type: "tv", title: "南の塔", tmdb: 903, year: 2020, seasons: [{ n: 2, episodes: 3 }] };
  const details = await run(f, { guesses: [{ kind: "episode", show: "北の塔", year: 2020, season: 2, episode: 1, confidence: .9 }] }, {}, externalContext);
  assert.equal(details.seerr, undefined); assert.deepEqual(details.rows, []);
});


test("Unicode titles remain distinct and empty folded names never verify a title", async () => {
  const f = fixture(), seed = f.rows.find((row) => row.key === "10");
  for (const [key, title] of [["801", "春の灯"], ["802", "秋の雨"], ["803", "Зимний Маяк"], ["804", "Летний Маяк"], ["805", "별빛 항구"], ["806", "!!!"]]) {
    f.rows.push({ ...seed, key, title });
  }
  for (const [title, key] of [["春の灯", "801"], ["秋の雨", "802"], ["зимний маяк", "803"], ["летний маяк", "804"], ["별빛 항구", "805"]]) {
    const r = await run(f, { title }, { raw: `play ${title}` });
    assert.equal(r.exact, true); assert.deepEqual(r.rows.map((row) => row.key), [key]);
  }
  for (const title of ["春の雨", "...", "\u093e"]) {
    const r = await run(f, { title }, { raw: title });
    assert.equal(r.exact, false); assert.deepEqual(r.rows, []);
  }
  f.rows.find((row) => row.key === "10023").title = "冬の便り";
  assert.deepEqual((await run(f, { title: "冬の便り", kind: "episode" })).rows.map((row) => row.key), ["10023"]);
  assert.deepEqual((await run(f, { title: "夏の便り", kind: "episode" })).rows, []);
});

// 1.99?? clerkreq (owner 2026-11-08 13:48 ET): "pepe play the tv series The Good Doctor" got another show's episode CALLED "The Good
// Doctor" (prod has no 2017 series - only a crime show's S1E9 of that name). A show / film ask never takes an episode that only shares
// the name; it is kept aside (episode_named) and the title goes to Seerr. A bare title that only an episode has is offered as that
// episode, honestly (why episode_named, never exact), beside what Seerr knows. Seerr's state is said (ok / none / down / off).
function goodDoctor(f, seerr = "single") {
  const base = { section: "71", genres: ["Crime"], content_rating: "TV-14", shelves: [], server_plays: 1, pad_plays: 0, rating: 7, summary: "" };
  f.rows.push({ ...base, key: "300", type: "show", title: "Crime Unit: Intent", year: 2001 });
  f.rows.push({ ...base, key: "30019", type: "episode", show_key: "300", show: "Crime Unit: Intent", season: 1, episode: 9, title: "The Good Doctor",
    year: 2001, aired: "2001-11-25", duration: 2646, summary: "A surgeon's wife disappears." });
  f.rows.push({ ...base, key: "30011", type: "episode", show_key: "300", show: "Crime Unit: Intent", season: 1, episode: 1, title: "One",
    year: 2001, aired: "2001-09-30", duration: 2646 });
  const rows = {
    single: [{ type: "tv", tmdb: 750001, title: "The Good Doctor", year: 2017, availability: "unknown", media_status: 1, overview: "NEVER-OVERVIEW" }],
    ambiguous: [{ type: "tv", tmdb: 750001, title: "The Good Doctor", year: 2017, availability: "unknown", media_status: 1 },
      { type: "tv", tmdb: 750002, title: "Good Doctor", year: 2013, availability: "unknown", media_status: 1 },
      { type: "movie", tmdb: 750003, title: "The Good Doctor", year: 2011, availability: "unknown", media_status: 1 }],
  }[seerr] || [];
  f.external.search["the good doctor"] = rows;
  f.external.search["good doctor"] = rows;
  return f;
}

test("clerkreq S1: a show or film ask never takes another show's episode of that name - it goes to Seerr", async () => {
  for (const [ask, raw] of [[{ title: "the good doctor", kind: "show" }, "the show the good doctor"],
    [{ title: "The Good Doctor", kind: "show" }, "the tv series the good doctor"], [{ title: "The Good Doctor", kind: "show" }, "The Good Doctor"]]) {
    const f = goodDoctor(fixture());
    const r = await run(f, ask, { raw }, externalContext);
    assert.deepEqual(r.rows, [], raw); assert.equal(r.exact, false, raw);
    assert.equal(r.seerr && r.seerr.tmdb, 750001, raw); assert.equal(r.seerr_state, "ok", raw);
    assert.deepEqual(r.episode_named, [{ key: "30019", label: 'Crime Unit: Intent S1E9 "The Good Doctor"', show: "Crime Unit: Intent" }], raw);
    assert.doesNotMatch(JSON.stringify(r), /NEVER/);
  }
  const f = goodDoctor(fixture(), "ambiguous");
  const film = await run(f, { title: "The Good Doctor", kind: "movie" }, { raw: "the movie the good doctor" }, externalContext);
  assert.deepEqual(film.rows, []); assert.equal(film.seerr.tmdb, 750003); assert.equal(film.seerr.kind, "movie");
  assert.equal(film.episode_named.length, 1);
  // an episode ask keeps it (the episode IS what was asked for)
  const episode = await run(f, { title: "The Good Doctor", kind: "episode" }, { raw: "the episode the good doctor" }, externalContext);
  assert.deepEqual(episode.rows.map((x) => x.key), ["30019"]); assert.equal(episode.exact, true); assert.equal(episode.rows[0].why, "exact");
  // the probe (no Seerr) of a show ask: nothing exact, so the bot asks its model - never the episode as the answer
  f.calls.length = 0;
  const probe = await run(f, { title: "the good doctor", kind: "show" }, { raw: "the show the good doctor", probe: true }, externalContext);
  assert.deepEqual(probe.rows, []); assert.equal(probe.exact, false); assert.equal(probe.seerr, undefined);
  assert.equal(f.calls.filter((x) => x[0] === "seerr_search").length, 0, "a probe never looks outside");
});

test("clerkreq S1/S2: a bare title only an episode has is that episode, honestly - episode_named, never exact - and Seerr is asked too", async () => {
  const f = goodDoctor(fixture());
  const r = await run(f, { title: "the good doctor" }, { raw: "the good doctor" }, externalContext);
  assert.deepEqual(r.rows.map((x) => x.key), ["30019"]); assert.equal(r.rows[0].why, "episode_named"); assert.equal(r.rows[0].exact, false);
  assert.equal(r.exact, false); assert.equal(r.seerr.tmdb, 750001); assert.equal(r.seerr_state, "ok");
  assert.deepEqual(r.episode_named.map((x) => x.key), ["30019"]);
  // the same bare line, Seerr has nothing: the episode alone, the state said
  const g = goodDoctor(fixture(), "none");
  const alone = await run(g, { title: "the good doctor" }, { raw: "pepe play the good doctor" }, externalContext);
  assert.deepEqual(alone.rows.map((x) => x.key), ["30019"]); assert.equal(alone.seerr, undefined); assert.equal(alone.seerr_state, "none");
  // a real show / film title is never "episode named" and asks nobody
  g.calls.length = 0;
  const show = await run(g, { title: "Clockwork Orchard" }, { raw: "Clockwork Orchard" }, externalContext);
  assert.ok(show.rows.length && show.rows.every((x) => x.why !== "episode_named")); assert.equal(show.seerr_state, undefined);
  assert.equal(g.calls.filter((x) => x[0] === "seerr_search").length, 0);
  // the old 1.99amh rule for a kind the model got wrong still holds for real titles (a film named in full is the film)
  const wrongKind = await run(g, { title: "hearts", select: "latest", kind: "show", year: 1980 }, { raw: "play Random Hearts" });
  assert.deepEqual(wrongKind.rows.map((x) => x.key), ["10"]); assert.equal(wrongKind.exact, true);
});

test("clerkreq S3: Seerr ambiguity prefers the title with its article, then the year - else choices, never a silent null", async () => {
  let f = goodDoctor(fixture(), "ambiguous");
  let r = await run(f, { title: "The Good Doctor", kind: "show" }, { raw: "the show the good doctor" }, externalContext);
  assert.equal(r.seerr.tmdb, 750001, "'The Good Doctor' (2017) over 'Good Doctor' (2013)"); assert.equal(r.seerr_choices, undefined);
  r = await run(f, { title: "Good Doctor", kind: "show" }, { raw: "the show good doctor" }, externalContext);
  assert.equal(r.seerr.tmdb, 750002, "said without the article: the one without it");
  // a bare title: the 2017 show and the 2011 film both read "The Good Doctor" - a choice for the speaker
  r = await run(f, { title: "the good doctor" }, { raw: "the good doctor" }, externalContext);
  assert.equal(r.seerr, undefined); assert.equal(r.seerr_state, "ok");
  assert.deepEqual(r.seerr_choices, [{ title: "The Good Doctor", year: 2017, kind: "tv", tmdb: 750001, media_status: 1 },
    { title: "The Good Doctor", year: 2011, kind: "movie", tmdb: 750003, media_status: 1 }]);
  assert.deepEqual(r.rows.map((x) => x.why), ["episode_named"]);
  // two shows with the very same name: the year settles it, else choices
  f = goodDoctor(fixture(), "none");
  f.external.search["good doctor"] = [{ type: "tv", tmdb: 760001, title: "Good Doctor", year: 2013, availability: "unknown", media_status: 1 },
    { type: "tv", tmdb: 760002, title: "Good Doctor", year: 2020, availability: "unknown", media_status: 1 }];
  r = await run(f, { title: "Good Doctor", kind: "show", year: 2020 }, { raw: "the show good doctor 2020" }, externalContext);
  assert.equal(r.seerr.tmdb, 760002); assert.equal(r.seerr_choices, undefined);
  r = await run(f, { title: "Good Doctor", kind: "show" }, { raw: "the show good doctor" }, externalContext);
  assert.equal(r.seerr, undefined); assert.deepEqual(r.seerr_choices.map((c) => c.tmdb), [760001, 760002]);
  // an already-available one is never a choice (it may be a title the library hides): one left is the offer, none left is unavailable
  f.external.search["good doctor"][1].media_status = 5; f.external.search["good doctor"][1].availability = "available";
  f.now += 24 * 3600 * 1000 + 1;
  r = await run(f, { title: "Good Doctor", kind: "show" }, { raw: "the show good doctor" }, externalContext);
  assert.equal(r.seerr.tmdb, 760001); assert.doesNotMatch(JSON.stringify(r), /760002/);
  f.external.search["good doctor"][0].media_status = 6;
  f.now += 24 * 3600 * 1000 + 1;
  r = await run(f, { title: "Good Doctor", kind: "show" }, { raw: "the show good doctor" }, externalContext);
  assert.equal(r.code, "unavailable"); assert.doesNotMatch(JSON.stringify(r), /Good Doctor|7600/);
  // a film already requested (Seerr pending / processing): said, never offered again
  f = fixture(); f.external.search["distant lantern"] = [{ type: "movie", tmdb: 601, title: "Distant Lantern", year: 2020, availability: "pending", media_status: 2 }];
  r = await run(f, { title: "Distant Lantern", kind: "movie" }, { raw: "the movie distant lantern" }, externalContext);
  assert.equal(r.seerr, undefined); assert.deepEqual(r.seerr_requested, { title: "Distant Lantern", year: 2020, kind: "movie" }); assert.equal(r.seerr_state, "ok");
});

test("clerkreq S4: Seerr's state is said - ok, none, down (a timeout or an error) and off - only when a lookup was due", async () => {
  let f = goodDoctor(fixture(), "none");
  let r = await run(f, { title: "The Good Doctor", kind: "show" }, { raw: "the show the good doctor" }, externalContext);
  assert.equal(r.seerr_state, "none"); assert.deepEqual(r.rows, []);
  r = await run(f, { title: "The Good Doctor", kind: "show" }, { raw: "the show the good doctor" }, { allowSeerr: false });
  assert.equal(r.seerr_state, "off");
  f = goodDoctor(fixture()); f.searchDelay = 2200;
  r = await run(f, { title: "The Good Doctor", kind: "show" }, { raw: "the show the good doctor" }, externalContext);
  assert.equal(r.seerr_state, "down"); assert.equal(r.seerr, undefined);
  f = goodDoctor(fixture()); f.requests.search = async () => { throw Object.assign(new Error("NEVER-UPSTREAM"), { status: 502, refuse: true, upstream: true }); };
  r = await run(f, { title: "The Good Doctor", kind: "show" }, { raw: "the show the good doctor" }, externalContext);
  assert.equal(r.seerr_state, "down"); assert.doesNotMatch(JSON.stringify(r), /NEVER/);
  f = goodDoctor(fixture()); f.requests.search = async () => { throw Object.assign(new Error("Requests aren't configured."), { status: 503, refuse: true }); };
  r = await run(f, { title: "The Good Doctor", kind: "show" }, { raw: "the show the good doctor" }, externalContext);
  assert.equal(r.seerr_state, "off");
  // a title on the shelves: no lookup, no state
  r = await run(fixture(), { title: "Harbour Signal", kind: "movie" }, { raw: "the movie harbour signal" }, externalContext);
  assert.ok(r.rows.length); assert.equal(r.seerr_state, undefined);
});

test("clerkreq S5: a title-level ask (request_offer) never counts an episode or a near title as on the shelves, and finds a missing season", async () => {
  const f = goodDoctor(fixture());
  let r = await f.finder.find({ ask: { title: "The Good Doctor" }, raw: "", titleLevel: true }, externalContext);
  assert.deepEqual(r.rows, []); assert.equal(r.seerr.tmdb, 750001); assert.deepEqual(r.episode_named.map((x) => x.key), ["30019"]);
  // "Harbour Signal" is on the shelves; "Harbour" only nearly - Seerr is asked for the exact one
  f.external.search["harbour"] = [{ type: "movie", tmdb: 701, title: "Harbour", year: 1999, availability: "unknown", media_status: 1 }];
  r = await f.finder.find({ ask: { title: "Harbour", kind: "movie" }, raw: "", titleLevel: true }, externalContext);
  assert.equal(r.seerr && r.seerr.tmdb, 701);
  r = await f.finder.find({ ask: { title: "Harbour Signal", kind: "movie" }, raw: "", titleLevel: true }, externalContext);
  assert.ok(r.rows.some((x) => x.key === "11")); assert.equal(r.seerr, undefined);
  // a season the library lacks: Seerr's season
  f.external.search["clockwork orchard"] = [{ type: "tv", tmdb: 501, title: "Clockwork Orchard", year: 2002, media_status: 4, availability: "partial" }];
  f.external.details["tv:501"] = { type: "tv", tmdb: 501, title: "Clockwork Orchard", year: 2002, media_status: 4,
    seasons: [{ n: 1, episodes: 3, status: 5 }, { n: 4, episodes: 8, status: 1 }] };
  r = await f.finder.find({ ask: { title: "Clockwork Orchard", kind: "show", season: 4, year: 2002 }, raw: "", titleLevel: true }, externalContext);
  assert.deepEqual(r.rows, []); assert.equal(r.seerr.tmdb, 501); assert.equal(r.seerr.season, 4);
});

// ── 1.99?? clerkreq review (2026-11-08) ──
test("clerkreq review F5: a bare title only an episode has stays that episode when Seerr's same-named title is one the clerk can't offer", async () => {
  const f = goodDoctor(fixture(), "none");
  // a film of that name IS on Plex, in a section the clerk doesn't serve (Seerr: available) - the bare line still gets the episode
  f.external.search["the good doctor"] = [{ type: "movie", tmdb: 740006, title: "The Good Doctor", year: 2011, availability: "available", media_status: 5 }];
  const r = await run(f, { title: "the good doctor" }, { raw: "pepe play the good doctor" }, externalContext);
  assert.notEqual(r.code, "unavailable", "the episode on the shelves is offered, never 'that one isn't available here'");
  assert.deepEqual(r.rows.map((x) => x.key), ["30019"]); assert.equal(r.seerr, undefined); assert.equal(r.seerr_choices, undefined);
  assert.doesNotMatch(JSON.stringify(r), /740006|"available"/);
  // a film ask of a title the clerk can't offer is still unavailable (nothing on the shelves to offer instead)
  assert.equal((await run(f, { title: "The Good Doctor", kind: "movie" }, { raw: "the movie the good doctor" }, externalContext)).code, "unavailable");
});

test("clerkreq review F6: a film kept as a show's special (S00) is that film for a film ask and a title-level ask", async () => {
  const f = fixture();
  const special = f.rows.find((r) => r.key === "10001");          // Clockwork Orchard S0E1
  special.title = "Big Score Movie"; special.duration = 5400;
  f.external.search["big score movie"] = [{ type: "movie", tmdb: 7249, title: "Big Score Movie", year: 2007, availability: "unknown", media_status: 1 }];
  let r = await run(f, { title: "Big Score Movie", kind: "movie" }, { raw: "the movie big score movie" }, externalContext);
  assert.deepEqual(r.rows.map((x) => x.key), ["10001"], "the special on the shelves, never a request for it"); assert.equal(r.seerr, undefined);
  r = await f.finder.find({ ask: { title: "Big Score Movie", kind: "movie" }, raw: "", titleLevel: true }, externalContext);
  assert.deepEqual(r.rows.map((x) => x.key), ["10001"]); assert.equal(r.seerr, undefined);
  r = await f.finder.find({ ask: { title: "Big Score Movie" }, raw: "", titleLevel: true }, externalContext);
  assert.deepEqual(r.rows.map((x) => x.key), ["10001"]); assert.equal(r.seerr, undefined);
  assert.equal(f.calls.filter((x) => x[0] === "seerr_search").length, 0, "nothing to look up: it's here");
  // a regular episode of that name is still no film (S1+ - kept aside), and a show ask never takes the special
  special.season = 1;
  r = await run(f, { title: "Big Score Movie", kind: "movie" }, { raw: "the movie big score movie" }, externalContext);
  assert.deepEqual(r.rows, []); assert.equal(r.seerr.tmdb, 7249);
  special.season = 0;
  r = await run(f, { title: "Big Score Movie", kind: "show" }, { raw: "the show big score movie" }, externalContext);
  assert.ok(!r.rows.some((x) => x.key === "10001"), "a show ask never takes another show's special");
});

test("clerkreq review F11: a title on the shelves as the other kind, or without the season asked, says so (shelf_title)", async () => {
  const f = fixture();
  let r = await run(f, { title: "Clockwork Orchard", kind: "movie" }, { raw: "the movie clockwork orchard" }, externalContext);
  assert.deepEqual(r.rows, []); assert.deepEqual(r.shelf_title, { kind: "show", title: "Clockwork Orchard", year: 2002 });
  r = await run(f, { title: "Harbour Signal", kind: "show" }, { raw: "the show harbour signal" }, externalContext);
  assert.deepEqual(r.shelf_title, { kind: "movie", title: "Harbour Signal", year: 1984 });
  r = await f.finder.find({ ask: { title: "Clockwork Orchard", kind: "show", season: 9 }, raw: "", titleLevel: true }, externalContext);
  assert.deepEqual(r.shelf_title, { kind: "show", title: "Clockwork Orchard", year: 2002, season: 9 });
  // the title as asked is here: nothing to say
  r = await run(f, { title: "Clockwork Orchard", kind: "show" }, { raw: "the show clockwork orchard" }, externalContext);
  assert.equal(r.shelf_title, undefined);
  r = await run(f, { title: "Lost Lantern Road", kind: "movie" }, { raw: "the movie lost lantern road" }, externalContext);
  assert.equal(r.shelf_title, undefined);
});
