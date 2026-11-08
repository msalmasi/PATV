"use strict";
// 1.99amq clerkfast (owner 2026-11-08: "video clerk just failed again in Pepe's pad on the simpsons/pink shirt question"):
// "the episode of <show> where <description>" is searched in THAT show's episodes by the description's words. The rows come in
// the word search's own order (they were re-sorted into season / episode order - the best hit was wherever it aired), and the
// answer says `clear` only when exactly ONE of the show's episodes has every telling word of the description in its title or
// summary: words a good share of the show's episodes have ("homer") tell nothing, and a word NO episode has (prod's summary for
// the pink-shirt episode never says "pink") means the summaries can't settle it - the bot's model decides then.
// The real catalog (FTS5 bm25) on a synthetic fixture; the summaries are original fixture prose.
const test = require("node:test");
const assert = require("node:assert/strict");
const { fixtureRunner } = require("../tools/clerk-find");
const base = require("./fixtures/clerk_catalog.json");

const SHOW = "1001";
const ep = (n, title, season, episode, aired, summary) => ({ key: String(1001500 + n), type: "episode", title, section: "72",
  year: Number(aired.slice(0, 4)), aired, added: 1700000000, updated: 1700001000, duration: 1320, summary, tagline: "",
  genres: ["Comedy", "Animation"], content_rating: "TV-14", rating: 7.2, audience_rating: null, studio: "Lantern Studio",
  directors: [], cast: [], countries: ["United States"], imdb: null, tmdb: null, tvdb: null, show_key: SHOW,
  season_key: String(1001900 + season), show: "The Simpsons", season, episode, server_plays: 0, pad_plays: 0, shelves: [] });
// prod-shaped: the pink-shirt episode's summary never says "pink" or "shirt"; other episodes have "shirt" / "wears"
const PROD = () => [
  ep(1, "Stark Raving Dad", 3, 1, "1991-09-19", "A mix-up lands Homer in a mental hospital, where his room-mate insists he is a famous pop singer. Lisa waits for a birthday present."),
  ep(2, "Team Homer", 7, 12, "1996-01-07", "Homer forms a bowling team with his friends and has matching team shirts made with money from Mr. Burns."),
  ep(3, "Fat Man and Little Boy", 16, 5, "2004-12-12", "Bart sells slogan shirts while Homer helps him build a science fair reactor."),
  ep(4, "The Devil Wears Nada", 21, 5, "2009-11-15", "Marge poses for a charity calendar and Homer wears himself out on a new job."),
  ep(5, "Bart vs. Australia", 6, 16, "1995-02-19", "A collect call to a stranger sends the family across the world to apologise in person to Australia."),
  ep(6, "Lisa's Pony", 3, 8, "1991-11-07", "Homer takes a night job at a convenience store to pay for a pony for Lisa."),
  ep(7, "Homer Goes to College", 5, 3, "1993-10-14", "Homer has to pass a class at the college before he can keep his job at the plant."),
  ep(8, "Homer at the Bat", 3, 17, "1992-02-20", "Homer joins the plant's softball team and Mr. Burns hires ringers to win a bet."),
  ep(9, "Board Day", 9, 9, "1997-12-14", "Bart rides his skateboard down the hill and into trouble at school."),
  ep(10, "Ramp Summer", 9, 10, "1998-01-04", "Bart and Milhouse build a skateboard ramp in the yard for the summer."),
  ep(11, "Marge on the Lam", 5, 6, "1993-11-04", "Marge and her neighbour go on a road trip and end up chased by the police."),
  ep(12, "Lisa the Vegetarian", 7, 5, "1995-10-15", "Lisa stops eating meat after a visit to a petting zoo."),
];
// the summary a source that knows the episode would carry
const IDEAL = () => PROD().map((row) => row.title === "Stark Raving Dad"
  ? { ...row, summary: "Homer wears a pink shirt to work and is sent to a mental hospital, where his room-mate insists he is a famous pop singer." } : row);

async function runner(episodes) {
  const fixture = structuredClone(base);
  assert.ok(!fixture.rows.some((r) => episodes.some((e) => e.key === r.key)), "fixture keys are new");
  fixture.rows = fixture.rows.filter((r) => r.show_key !== SHOW).concat(episodes);
  return fixtureRunner(fixture, { vectors: [] });
}
const find = (r, ask, extra = {}) => r.find({ ask: { kind: "episode", title: "The Simpsons", select: "one", ...ask }, raw: extra.raw || "", ...extra });
const key = (rows, title) => rows.find((r) => r.title === title).key;

test("clerkfast: one show + a description comes back in the word search's own order, not season order", async () => {
  const r = await runner(PROD());
  try {
    const about = "homer wears a pink shirt";
    const got = await find(r, { about });
    assert.ok(got.rows.length >= 3, "the word hits are offered");
    const ranked = (await r.catalog.search(about, { kind: "episode", show_key: SHOW, limit: 500 })).map((row) => String(row.key));
    assert.deepEqual(got.rows.map((row) => row.key), ranked.filter((k) => got.rows.some((row) => row.key === k)), "the search's rank order");
    const aired = [...got.rows].sort((x, y) => x.season - y.season || x.episode - y.episode).map((row) => row.key);
    assert.notDeepEqual(got.rows.map((row) => row.key), aired, "not re-sorted into season / episode order");
    assert.ok(got.rows.every((row) => row.why === "fts"));
  } finally { await r.close(); }
});

test("clerkfast: a word no summary has never lets the summaries decide (prod: the pink-shirt summary never says pink)", async () => {
  const r = await runner(PROD());
  try {
    for (const about of ["homer wears a pink shirt", "homer wears the pink shirt", "Homer wears a pink shirt"]) {
      const got = await find(r, { about });
      assert.equal(got.clear, undefined, about);
      assert.ok(got.rows.length > 0, "still a ranked list to offer");
    }
    // even when one episode has every OTHER word, "pink" (no episode has it) keeps it unclear - the model decides
    const lucky = PROD().map((row) => row.title === "Team Homer" ? { ...row, summary: "Homer wears a lucky team shirt to the bowling alley." } : row);
    const r2 = await runner(lucky);
    try {
      const got = await find(r2, { about: "homer wears a pink shirt" });
      assert.equal(got.clear, undefined, "Team Homer has homer + wears + shirt but not pink: never the clear answer");
      assert.equal(got.rows[0].title, "Team Homer", "it is still the best word hit to offer");
    } finally { await r2.close(); }
  } finally { await r.close(); }
});

test("clerkfast: exactly one episode with every telling word is clear and comes first", async () => {
  const r = await runner(IDEAL());
  try {
    for (const about of ["homer wears the pink shirt", "homer wears a pink shirt", "Homer wears a pink shirt", "wears a pink shirt"]) {
      const got = await find(r, { about });
      assert.equal(got.clear, true, about);
      assert.equal(got.rows[0].title, "Stark Raving Dad", about);
      assert.equal(got.rows[0].season, 3); assert.equal(got.rows[0].episode, 1);
      assert.equal(got.exact, false, "a summary hit is never an exact title");
    }
    // one telling word only one episode has
    const oz = await find(r, { about: "they go to australia" });
    assert.equal(oz.clear, true); assert.equal(oz.rows[0].title, "Bart vs. Australia");
    // plurals / third person fold either way ("shirts" in the summary, "shirt" asked)
    const team = await find(r, { about: "matching bowling shirt" });
    assert.equal(team.clear, true); assert.equal(team.rows[0].title, "Team Homer");
  } finally { await r.close(); }
});

test("clerkfast: two episodes with every telling word, or only the show's common words, stay for the model", async () => {
  const r = await runner(IDEAL());
  try {
    const both = await find(r, { about: "bart skateboard" });
    assert.equal(both.clear, undefined, "two skateboard episodes");
    assert.deepEqual(both.rows.slice(0, 2).map((row) => row.title).sort(), ["Board Day", "Ramp Summer"], "both lead the list");
    assert.ok(both.rows.slice(2).some((row) => row.title === "Fat Man and Little Boy"), "a bart-only hit comes after them");
    const common = await find(r, { about: "homer" });
    assert.equal(common.clear, undefined, "homer is in most of the show's summaries: it tells nothing");
    const none = await find(r, { about: "a comet over the lighthouse" });
    assert.equal(none.clear, undefined); assert.deepEqual(none.rows, []);
  } finally { await r.close(); }
});

test("clerkfast: the clear episode must pass every other filter, and two shows of that name are never clear", async () => {
  const r = await runner(IDEAL());
  try {
    const season = await find(r, { about: "homer wears a pink shirt", season: 7 });
    assert.equal(season.clear, undefined, "season 7 asked: Stark Raving Dad (season 3) is not a candidate");
    assert.ok(season.rows.every((row) => row.season === 7));
    const excluded = await find(r, { about: "homer wears a pink shirt" }, { exclude: [key(IDEAL(), "Stark Raving Dad")] });
    assert.equal(excluded.clear, undefined, "an excluded (already offered) episode is never the clear one");
    assert.ok(!excluded.rows.some((row) => row.title === "Stark Raving Dad"));
  } finally { await r.close(); }
  const fixture = structuredClone(base);
  const office = fixture.rows.find((row) => row.show_key === "1002");
  office.summary = "A paper company runs a lighthouse raffle.";
  const r2 = await fixtureRunner(fixture, { vectors: [] });
  try {
    const got = await r2.find({ ask: { kind: "episode", title: "The Office", about: "lighthouse raffle", select: "one" }, raw: "" });
    assert.equal(got.rows[0].key, office.key);
    assert.equal(got.clear, undefined, "two shows are called The Office: the model decides which");
  } finally { await r2.close(); }
});

// review (2026-11-08) F1: the word search's rank order is for a single pick only. A selection word with a description ("the newest
// Simpsons Halloween episode", "in order", "the first 2") still orders the matching episodes by air date - in rank order "latest"
// took the worst word hit and "in order" queued them by relevance.
const HALLOWEEN = () => [
  ep(21, "Treehouse of Horror", 2, 3, "1990-10-25", "Bart and Lisa tell scary stories in the treehouse on halloween night."),
  ep(22, "Treehouse of Horror V", 6, 6, "1994-10-30", "A halloween special: halloween stories of a haunted hotel and halloween dinner, halloween again."),
  ep(23, "Treehouse of Horror X", 11, 4, "1999-10-31", "Halloween halloween: the family gets superpowers on halloween."),
  ep(24, "Bart vs. Australia", 6, 16, "1995-02-19", "A collect call sends the family to Australia."),
  ep(25, "Lisa's Pony", 3, 8, "1991-11-07", "Homer takes a night job to pay for a pony."),
  ep(26, "Homer at the Bat", 3, 17, "1992-02-20", "Homer joins the softball team."),
];

test("clerkfast review F1: a selection word with a description keeps air order; only a single pick is in rank order", async () => {
  const r = await runner(HALLOWEEN());
  try {
    const [I, V, X] = ["Treehouse of Horror", "Treehouse of Horror V", "Treehouse of Horror X"].map((t) => key(HALLOWEEN(), t));
    const pick = async (select, n) => find(r, { about: "halloween", select, ...(n ? { n } : {}) });
    const plan = (got) => got.rows[0].keys;
    assert.deepEqual(plan(await pick("in_order")), [I, V, X], "in order: by air date");
    assert.deepEqual(plan(await pick("first_n", 1)), [I], "the first one: the oldest-aired match");
    assert.deepEqual(plan(await pick("last_n", 1)), [X], "the last one: the newest-aired match");
    assert.equal((await pick("latest")).rows[0].key, X, "the newest match, not the worst word hit");
    assert.equal((await pick("finale")).rows[0].key, X);
    assert.equal((await pick("pilot")).rows[0].key, I);
    assert.equal((await pick("oldest")).rows[0].key, I);
    const one = await pick("one");
    const ranked = (await r.catalog.search("halloween", { kind: "episode", show_key: SHOW, limit: 500 })).map((row) => String(row.key));
    assert.deepEqual(one.rows.map((row) => row.key), ranked.filter((k) => [I, V, X].includes(k)), "a single pick: the search's rank order");
    assert.notEqual(one.rows[0].key, I, "fixture check: the best word hit is not the oldest-aired one");
  } finally { await r.close(); }
});

// review F7: the description check reads every episode summary of the show; those must not go into the bounded name cache that
// keeps the films' and shows' titles normalised (1.99amh) - at ~1 KB an entry a few asks fill it, and at its cap it is cleared.
test("clerkfast review F7: the summaries never go into the titles' name cache", async () => {
  const plexfind = require("../plexfind");
  const episodes = IDEAL().map((row) => ({ ...row, summary: `${row.summary} (review F7 ${row.key})` }));
  const r = await runner(episodes);
  try {
    const got = await find(r, { about: "homer wears a pink shirt" });
    assert.equal(got.clear, true, "the description check ran");
    for (const row of episodes) assert.equal(plexfind._normCached(`${row.title || ""} ${row.summary || ""}`), false, row.title);
    assert.equal(plexfind._normCached("The Simpsons"), true, "fixture check: the titles' cache itself is used");
  } finally { await r.close(); }
});
