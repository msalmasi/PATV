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
  data.finder = createFinder({ catalog, settings: () => settings, requests, now: () => data.now, rng: () => 0, deepMax: { movie: 2, show: 10 } });
  return data;
}
const run = (f, ask, extra = {}, context = {}) => f.finder.find({ ask, ...extra }, context);

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
  const rawEpisode = await run(f, { title: "lantern", select: "latest", kind: "movie" }, { raw: "play The Last Lantern" });
  assert.deepEqual(rawEpisode.rows.map((x) => x.key), ["10023"]); assert.equal(rawEpisode.exact, true);
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
