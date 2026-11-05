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
  data.finder = createFinder({ catalog, settings: () => settings, rng: () => 0, deepMax: { movie: 2, show: 10 } });
  return data;
}
const run = (f, ask, extra = {}, context = {}) => f.finder.find({ ask, ...extra }, context);

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
