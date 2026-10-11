// Offline tests for 1.99nj:
//   * 📼 Plex-on-pads achievements (plexpad.js): what counts as a play (on air 10 min / half the runtime, not a seek to the
//     end, a carried resume = one play), the metrics (genres, franchises, deep cuts, decades, a whole season, a marathon,
//     foreign-language films), the quiet backfill + the "history alone earned it" quiet rule, loud awards after it;
//   * 📊 Plex watch stats on profiles (plexstats.js) from a mocked Tautulli: only PROVEN Plex links (never the email guess),
//     home-stats rows checked against the user's own history, the streak, per-panel privacy (both private by default);
//   * the profile layout's default-private panels and the 📼 Plex tab's partial.
// Nothing leaves the process (Tautulli + mediactl are stubs).
//   NODE_PATH=G:/PATV/node_modules node --test test/plex-watch-stats.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plexstats-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.MEDIACTL_URL;
delete process.env.TAUTULLI_URL;
delete process.env.TAUTULLI_API_KEY;
process.env.SECRET_KEY = "test-secret";

const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const tautulli = require(path.join(repo, "tautulli"));
const PP = require(path.join(repo, "plexpad"));
const PS = require(path.join(repo, "plexstats"));
const layout = require(path.join(repo, "profilelayout"));
let A;

const MIN = 60 * 1000, H = 60 * MIN, DAY = 24 * H;
const T0 = Date.UTC(2026, 9, 1, 12);
let n = 0, slotN = 0;
const U = {};
async function mkUser(name) {
  const id = "u" + (++n);
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance) VALUES (?, ?, ?, 'x', 'pleb', 0)", [id, name, name]);
  U[name] = { userId: id, username: name };
  return U[name];
}
/** One play on a pad. o: {key, kind, title, year, dur (s), aired (s on air), live, end: finished|stopped, off, seekEnd, carried} */
async function play(u, o) {
  const sid = "s" + (++slotN);
  const ts = o.ts || T0;
  await runQuery("INSERT INTO stage_slots (id, userId, room_id, status, went_live) VALUES (?, ?, 'padA', 'ended', ?)", [sid, u.userId, o.live === false ? null : ts]);
  const off = o.off || 0;
  const aired = o.aired != null ? o.aired : o.dur;
  const wall = o.seekEnd ? 30 : aired;
  const r = await runQuery(`INSERT INTO media_plays (ts, user_id, username, room_id, slot_id, rating_key, title, kind, year, duration, offset_start, ended_at, end_reason, last_pos, carried_from)
                            VALUES (?, ?, ?, 'padA', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                           [ts, u.userId, u.username, sid, String(o.key), o.title, o.kind || "movie", o.year || null, o.dur, off, ts + wall * 1000,
                            o.end || "stopped", o.seekEnd ? o.dur - 5 : off + aired, o.carried || null]);
  return r.id;
}
async function meta(key, m) {
  await PP.init();
  await runQuery(`INSERT OR REPLACE INTO plex_meta (rating_key, kind, title, year, show_key, season_key, show_title, lang, genres, collections, studio, server_plays, item_at, taut_ok, tries, updated)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, 1)`,
                 [String(key), m.kind || "movie", m.title || null, m.year || null, m.show_key || null, m.season_key || null, m.show_title || null, m.lang || null,
                  JSON.stringify(m.genres || []), JSON.stringify(m.collections || []), m.studio || null, m.server_plays == null ? null : m.server_plays, m.taut === false ? 0 : 1]);
}
// the 📼 pad ones only (the older cf_plex_play "Now Showing" counts any play that went live - not this feature's rule)
const badges = async (u) => (await getQuery("SELECT badgeId FROM user_badges WHERE userId = ? AND badgeId LIKE 'cf_plex_%' ORDER BY badgeId", [u.userId]))
  .map((r) => r.badgeId).filter((id) => { const a = A.list().find((x) => x.id === id); return a && PP.METRICS.includes(a.metric); });
const feedFor = async (u) => (await getQuery("SELECT badgeId FROM achievement_feed WHERE userId = ? ORDER BY id", [u.userId])).map((r) => r.badgeId);
const xp = [];

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, camfrogUsername TEXT, email TEXT, avatar TEXT, archived_at INTEGER)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS badges (badgeId TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, icon TEXT,
                  points INTEGER DEFAULT 0, requirement TEXT NOT NULL, createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS user_badges (userId TEXT NOT NULL, badgeId TEXT NOT NULL, awardedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (userId, badgeId))`);
  await runQuery("CREATE TABLE stage_slots (id TEXT PRIMARY KEY, userId TEXT, room_id TEXT, status TEXT, went_live INTEGER, mode TEXT, source TEXT, featured INTEGER DEFAULT 0, feature_by TEXT)");
  await runQuery(`CREATE TABLE media_plays (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT, username TEXT, room_id TEXT NOT NULL, slot_id TEXT,
                  rating_key TEXT, title TEXT, kind TEXT, year INTEGER, duration INTEGER, quality INTEGER, offset_start INTEGER, audio INTEGER, sub INTEGER,
                  ended_at INTEGER, end_reason TEXT, last_pos INTEGER, error TEXT, carried_from INTEGER, queue_id INTEGER)`);
  await runQuery(`CREATE TABLE plex_members (plex_id TEXT PRIMARY KEY, share_id TEXT, username TEXT, title TEXT, email_hash TEXT, on_server INTEGER NOT NULL DEFAULT 0,
                  pending INTEGER NOT NULL DEFAULT 0, invited_at INTEGER, accepted_at INTEGER, user_id TEXT, link_source TEXT, link_lock INTEGER NOT NULL DEFAULT 0,
                  linked_at INTEGER, linked_by TEXT, access TEXT, access_pinned INTEGER NOT NULL DEFAULT 0, expires INTEGER, first_seen INTEGER, last_seen INTEGER,
                  last_synced INTEGER, revoke TEXT, revoke_at INTEGER, revoke_by TEXT, revoke_error TEXT)`);
  // ── history from BEFORE the quiet backfill ──
  const vet = await mkUser("vet");
  await play(vet, { key: 101, title: "The Thing (1982)", year: 1982, dur: 6540, aired: 6540, end: "finished" });
  await play(vet, { key: 102, title: "Psycho (1960)", year: 1960, dur: 6540, aired: 3000 });
  await play(vet, { key: 103, title: "Halloween (1978)", year: 1978, dur: 5460, aired: 4000 });
  await meta(101, { title: "The Thing", year: 1982, genres: ["Horror", "Science Fiction"] });
  await meta(102, { title: "Psycho", year: 1960, genres: [], taut: false, server_plays: 30 });   // its genres arrive "later" (below)
  await meta(103, { title: "Halloween", year: 1978, genres: [], taut: false });
  A = require(path.join(repo, "achievements"));
  A.setUpdateLevel(async (userId, amount) => { xp.push({ userId, amount }); return null; });
  await A.ready;
});

// ── pure ──
test("what counts: 10 minutes on air (or half a short title), never a seek to the end; not live = nothing", () => {
  const base = { went_live: 1, ts: 0, offset_start: 0, end_reason: "stopped" };
  assert.equal(PP.airedOf({ ...base, last_pos: 700, ended_at: 700e3, duration: 6000 }), 700);
  assert.equal(PP.airedOf({ ...base, last_pos: 5990, ended_at: 30e3, duration: 6000 }), 90, "a seek to the end counts the wall clock (+60 s slack)");
  assert.equal(PP.airedOf({ ...base, went_live: null, last_pos: 3000, ended_at: 3000e3, duration: 6000 }), 0);
  assert.equal(PP.airedOf({ ...base, end_reason: "finished", offset_start: 600, last_pos: 10, ended_at: 9e6, duration: 6000 }), 5400, "finished = to the end");
  assert.ok(PP.qualifies(600, 6000) && !PP.qualifies(599, 6000));
  assert.ok(PP.qualifies(300, 600) && !PP.qualifies(299, 600), "a 10-minute short needs half");
});

test("franchises: collections, curated titles (with years), prefixes, the Pixar studio; no false friends", () => {
  const F = PP.FRANCHISES;
  const m = (id, o) => PP.inFranchise(F[id], { collections: [], ...o });
  assert.ok(m("mcu", { title: "Thor: Ragnarok", year: 2017 }));
  assert.ok(m("mcu", { title: "Ant-Man and the Wasp", year: 2018 }));
  assert.ok(m("mcu", { title: "Some Film", collections: ["Marvel Cinematic Universe"] }));
  assert.ok(!m("mcu", { title: "Spider-Man", year: 2002 }), "Raimi isn't MCU");
  assert.ok(!m("mcu", { title: "Thor", year: 1975 }));
  assert.ok(m("starwars", { title: "Star Wars: Episode IV - A New Hope", year: 1977 }));
  assert.ok(m("starwars", { title: "Andor" }));
  assert.ok(m("potter", { title: "Harry Potter and the Goblet of Fire" }));
  assert.ok(m("lotr", { title: "The Hobbit: An Unexpected Journey" }));
  assert.ok(m("bond", { title: "GoldenEye", year: 1995 }) && m("bond", { title: "On Her Majesty's Secret Service", year: 1969 }));
  assert.ok(!m("bond", { title: "Spectre", year: 1977 }));
  assert.ok(m("fast", { title: "Fast & Furious 6", year: 2013 }) && m("fast", { title: "Furious 7", year: 2015 }));
  assert.ok(m("pixar", { title: "WALL·E", year: 2008 }) && m("pixar", { title: "Monsters, Inc.", year: 2001 }));
  assert.ok(m("pixar", { title: "Anything", studio: "Pixar Animation Studios" }));
  assert.ok(!m("pixar", { title: "Up", year: 1976 }), "the 1976 Up isn't Pixar");
});

test("compute(): genres by work, decades, a whole season, deep cuts, foreign films, a 24 h marathon", () => {
  const p = (o) => ({ id: 1, ts: T0, key: "k", kind: "movie", aired: 3600, work: "m:" + (o.key || "k"), genres: [], collections: [], ...o });
  const Q = [
    p({ key: "1", year: 1965, genres: ["Horror"], lang: "jpn", ts: T0 }),
    p({ key: "2", year: 1975, genres: ["Comedy"], lang: "eng", ts: T0 + H }),
    p({ key: "e1", kind: "episode", work: "s:S", season_key: "Z", year: 1985, genres: ["Animation", "Comedy"], ts: T0 + 2 * H }),
    p({ key: "e2", kind: "episode", work: "s:S", season_key: "Z", year: 1995, genres: ["Animation"], ts: T0 + 3 * H }),
    p({ key: "e2", kind: "episode", work: "s:S", season_key: "Z", year: 2005, genres: ["Animation"], ts: T0 + 4 * H }),
    p({ key: "3", year: 2015, genres: ["Science Fiction"], lang: "fra", ts: T0 + 5 * H, server_plays: 40 }),
    p({ key: "4", year: 2024, genres: ["Documentary"], ts: T0 + 3 * DAY }),
  ];
  // when someone ELSE first had each work on a pad (absent = nobody else yet; equal or later = this play was first)
  const first = new Map([["m:2", T0 - DAY], ["s:S", T0 + 2 * H], ["m:4", T0 + 4 * DAY]]);
  const m = PP.compute(Q, first, new Map([["Z", 2]]));
  assert.equal(m.plexpad_plays, 7);
  assert.equal(m.plexpad_movies, 4);
  assert.equal(m.plexpad_episodes, 3);
  assert.equal(m.plexpad_same_title, 2);
  assert.equal(m.plexpad_comedy, 2, "a movie + a show = 2 works");
  assert.equal(m.plexpad_animation, 1, "two episodes of one show = 1 work");
  assert.equal(m.plexpad_horror, 1);
  assert.equal(m.plexpad_scifi, 1);
  assert.equal(m.plexpad_documentary, 1);
  assert.equal(m.plexpad_genres, 5);
  assert.equal(m.plexpad_decades, 7, "1960s..2020s");
  assert.equal(m.plexpad_oldies, 1);
  assert.equal(m.plexpad_seasons, 1, "both episodes of the 2-episode season");
  assert.equal(m.plexpad_foreign, 2, "jpn + fra movies, not the English one");
  assert.equal(m.plexpad_deepcuts, 3, "first on a pad: 1, the show, 4 (3 has 40 server plays, 2 was someone else's first)");
  assert.equal(m.plexpad_marathon, 6 * 3600, "6 plays of an hour inside 24 h");
});

// ── the DB flow: quiet backfill, quiet-by-history, loud after ──
test("the quiet backfill: history earns badges only (no XP, PAT, feed); before it every metric is 0", async () => {
  const vet = U.vet;
  const before = await PP.metrics(vet.userId);
  assert.equal(before.plexpad_plays, 0, "nothing counts before the backfill");
  const r = await PP.backfill();
  assert.equal(r.done, true);
  assert.deepEqual(await badges(vet), ["cf_plex_movie", "cf_plex_oldie"]);
  assert.equal((await feedFor(vet)).length, 0);
  assert.equal(xp.length, 0);
  const m = await PP.metrics(vet.userId);
  assert.equal(m.plexpad_plays, 3);
  assert.equal(m.plexpad_horror, 1, "only The Thing has its genres so far");
  assert.equal(m._quiet.plexpad_plays, 3, "all of it is from before the cutoff");
});

test("genres that arrive later for OLD plays award quietly; a NEW play's achievement is loud (feed, XP)", async () => {
  const vet = U.vet;
  await meta(102, { title: "Psycho", year: 1960, genres: ["Horror", "Thriller"] });
  await meta(103, { title: "Halloween", year: 1978, genres: ["Horror"] });
  await A.checkWeb(vet.userId);
  assert.ok((await badges(vet)).includes("cf_plex_horror"), "3 horror works now");
  assert.equal((await feedFor(vet)).length, 0, "quiet: old plays alone earned it");
  // a new play after the cutoff: the first episode -> loud
  const cut = JSON.parse((await getQuery("SELECT v FROM achievement_meta WHERE k = ?", [PP.CUTOFF_KEY]))[0].v).cutoff;
  await play(vet, { key: 201, kind: "episode", title: "Cosmos — S1E1 The Shores", year: 1980, dur: 3600, aired: 3600, end: "finished", ts: cut + 1000 });
  await meta(201, { kind: "episode", show_key: "200", season_key: "210", show_title: "Cosmos", year: 1980, genres: ["Documentary"] });
  await A.checkWeb(vet.userId);
  assert.ok((await badges(vet)).includes("cf_plex_episode"));
  assert.deepEqual(await feedFor(vet), ["cf_plex_episode"]);
  assert.ok(xp.some((x) => x.userId === vet.userId && x.amount === 2000));
});

test("anti-farming: a play that didn't air long enough, a seek to the end, or never went live earns nothing", async () => {
  const f = await mkUser("farmer");
  const cut = JSON.parse((await getQuery("SELECT v FROM achievement_meta WHERE k = ?", [PP.CUTOFF_KEY]))[0].v).cutoff;
  await play(f, { key: 301, title: "Quick (2020)", year: 2020, dur: 6000, aired: 300, ts: cut + 1 });
  await play(f, { key: 302, title: "Skip (2020)", year: 2020, dur: 6000, seekEnd: true, ts: cut + 2 });
  await play(f, { key: 303, title: "Never (2020)", year: 2020, dur: 6000, aired: 6000, live: false, ts: cut + 3 });
  await A.checkWeb(f.userId);
  assert.deepEqual(await badges(f), []);
  // a resume on a fresh slot continues the first play: 5 + 6 minutes = one play of 11 minutes
  const a = await play(f, { key: 304, title: "Split (2020)", year: 2020, dur: 6000, aired: 300, ts: cut + 10 });
  await play(f, { key: 304, title: "Split (2020)", year: 2020, dur: 6000, off: 300, aired: 360, ts: cut + 20, carried: a });
  await A.checkWeb(f.userId);
  assert.deepEqual(await badges(f), ["cf_plex_movie"]);
  assert.equal((await PP.metrics(f.userId)).plexpad_plays, 1);
});

test("a whole season (sizes from Tautulli or mediactl), cached; noteItem keeps mediactl's language", async () => {
  const s = await mkUser("binger");
  const cut = JSON.parse((await getQuery("SELECT v FROM achievement_meta WHERE k = ?", [PP.CUTOFF_KEY]))[0].v).cutoff;
  tautulli._set(async (cmd, p) => {
    if (cmd === "get_children_metadata") return { children_count: 3 };
    if (cmd === "get_metadata") return { rating_key: p.rating_key, media_type: "episode", title: "Ep", year: 2010, genres: [], collections: [],
                                         grandparent_rating_key: "500", parent_rating_key: "510", grandparent_title: "Show" };
    if (cmd === "get_item_watch_time_stats") return [{ query_days: 0, total_plays: 50 }];
    throw new Error("unexpected " + cmd);
  });
  for (let i = 1; i <= 3; i++) {
    await PP.noteItem({ key: String(500 + i), type: "episode", title: "Ep " + i, year: 2010, show: "Show", show_key: "500", season_key: "510", audio: [{ index: 1, lang: "eng" }] });
    await play(s, { key: 500 + i, kind: "episode", title: "Show — S1E" + i + " Ep", year: 2010, dur: 1500, aired: 1500, end: "finished", ts: cut + i * H });
  }
  const r = await PP.enrichPending(10);
  assert.ok(r.filled >= 1);
  assert.equal((await getQuery("SELECT size FROM plex_seasons WHERE season_key = '510'"))[0].size, 3);
  assert.equal((await getQuery("SELECT lang FROM plex_meta WHERE rating_key = '501'"))[0].lang, "eng");
  assert.equal((await PP.metrics(s.userId)).plexpad_seasons, 1);
  // the fill pokes the players itself (fire-and-forget): wait for that check
  for (let i = 0; i < 50 && !(await badges(s)).includes("cf_plex_season"); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok((await badges(s)).includes("cf_plex_season"));
  assert.ok((await feedFor(s)).includes("cf_plex_season"), "new plays: loud");
  tautulli._set(null);
});

test("catalog: 25 📼 pad achievements, art, sane rewards, en.json strings; the Plex group on /achievements", () => {
  const list = A.list().filter((a) => PP.METRICS.includes(a.metric));
  assert.equal(list.length, 25);
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  for (const a of list) {
    assert.ok(a.id.startsWith("cf_plex_"), a.id);
    assert.equal(a.side, "web");
    assert.ok(fs.existsSync(path.join(repo, a.icon.replace(/^\//, ""))), "badge art " + a.id);
    assert.ok(a.xp <= 25000 && a.pat <= 250000, a.id);
    assert.ok(en["ach.n." + a.id] && en["ach.d." + a.id], a.id);
  }
  for (const m of PP.METRICS) assert.ok(list.some((a) => a.metric === m), "every metric has an achievement: " + m);
});

// ── 📊 watch stats ──
function fakeTautulli(calls) {
  const H1 = [
    { started: Math.floor((T0 - 0 * DAY) / 1000), media_type: "episode", rating_key: 901, grandparent_rating_key: 900, grandparent_title: "Severance", full_title: "Severance - Good News About Hell", play_duration: 3000, percent_complete: 100, watched_status: 1 },
    { started: Math.floor((T0 - 1 * DAY) / 1000), media_type: "episode", rating_key: 902, grandparent_rating_key: 900, grandparent_title: "Severance", full_title: "Severance - Half Loop", play_duration: 3000, percent_complete: 100, watched_status: 1 },
    { started: Math.floor((T0 - 2 * DAY) / 1000), media_type: "movie", rating_key: 950, title: "Arrival", full_title: "Arrival", year: 2016, play_duration: 6000, percent_complete: 60, watched_status: 0 },
    { started: Math.floor((T0 - 9 * DAY) / 1000), media_type: "movie", rating_key: 951, title: "Heat", full_title: "Heat", year: 1995, play_duration: 9000, percent_complete: 100, watched_status: 1 },
  ];
  return async (cmd, p) => {
    calls.push([cmd, p.user_id || null]);
    switch (cmd) {
      case "get_users": return [{ user_id: 111 }, { user_id: 222 }];
      case "get_libraries": return [{ section_id: 1, section_name: "Movies", section_type: "movie" }, { section_id: 2, section_name: "TV Shows", section_type: "show" },
                                    { section_id: 3, section_name: "Music", section_type: "artist" }];
      case "get_library_user_stats": return p.section_id === 1 ? [{ user_id: 111, total_plays: 2, total_time: 15000 }, { user_id: 222, total_plays: 9, total_time: 1 }]
                                                              : [{ user_id: 111, total_plays: 2, total_time: 6000 }];
      case "get_user_watch_time_stats": return [{ query_days: 1, total_time: 3000, total_plays: 1 }, { query_days: 7, total_time: 12000, total_plays: 3 },
                                                { query_days: 30, total_time: 21000, total_plays: 4 }, { query_days: 0, total_time: 360000, total_plays: 140 }];
      case "get_user_player_stats": return [{ platform_name: "Roku", player_name: "Living Room TV", total_plays: 100 }, { platform_name: "Chrome", player_name: "Mike's laptop", total_plays: 40 }];
      case "get_history": return { recordsFiltered: 4, data: H1 };
      case "get_home_stats": return [{ stat_id: "top_movies", rows: [{ title: "Heat", rating_key: 951, total_duration: 9000, total_plays: 1, year: 1995 },
                                                                    { title: "Somebody Else's Movie", rating_key: 777, total_duration: 99999, total_plays: 50 }] },
                                     { stat_id: "top_tv", rows: [{ title: "Severance", grandparent_rating_key: 900, rating_key: 900, total_duration: 6000, total_plays: 2 }] }];
      case "get_metadata": return { rating_key: p.rating_key, media_type: String(p.rating_key) === "900" ? "show" : "movie", title: "x",
                                    genres: String(p.rating_key) === "900" ? ["Drama", "Science Fiction"] : ["Science Fiction"], collections: [] };
      case "get_item_watch_time_stats": return [{ query_days: 0, total_plays: 3 }];
      default: throw new Error("unexpected " + cmd);
    }
  };
}

test("sync: only PROVEN links (self/admin/wizarr/overseerr - never the email guess), nobody else's numbers, cached in the site table", async () => {
  const fan = await mkUser("fan");
  const guess = await mkUser("guess");
  await runQuery("INSERT INTO plex_members (plex_id, user_id, link_source, on_server, access) VALUES ('111', ?, 'self', 1, 'pre-existing')", [fan.userId]);
  await runQuery("INSERT INTO plex_members (plex_id, user_id, link_source, on_server, access) VALUES ('222', ?, 'email', 1, 'pre-existing')", [guess.userId]);
  PS._setClock(() => T0);
  const calls = [];
  tautulli._set(fakeTautulli(calls));
  const r = await PS.sync();
  assert.equal(r.ok, true);
  assert.equal(r.synced, 1);
  assert.ok(!calls.some(([c, u]) => u === "222"), "the email-linked account is never looked up");
  assert.deepEqual(await PS.linkedIds(guess.userId), []);
  const row = (await getQuery("SELECT data FROM plex_watch_stats WHERE user_id = ?", [fan.userId]))[0];
  const d = JSON.parse(row.data);
  assert.equal(d.found, true);
  assert.equal(d.total_plays, 140);
  assert.equal(d.month_seconds, 21000);
  assert.deepEqual(d.top_movies.map((x) => x.title), ["Heat"], "a home-stats row that isn't in their history is dropped");
  assert.deepEqual(d.top_shows.map((x) => x.title), ["Severance"]);
  assert.deepEqual(d.libraries.map((l) => [l.name, l.plays]), [["Movies", 2], ["TV Shows", 2]], "their rows only; music skipped");
  assert.deepEqual(d.platforms.map((p) => p.name), ["Roku", "Chrome"], "platforms, never the device names");
  assert.ok(!JSON.stringify(d).includes("Mike's laptop"));
  assert.equal(d.streak.best, 3);
  assert.equal(d.streak.current, 3);
  assert.equal(d.genres[0].name, "Science Fiction");
  assert.equal(d.recent[0].title, "Severance - Good News About Hell");
  assert.equal(d.recent[2].pct, 60);
  assert.ok(!(await getQuery("SELECT * FROM plex_watch_stats WHERE user_id = ?", [guess.userId])).length);
  tautulli._set(null);
});

test("forProfile: panels load only when this viewer may see them; a dead streak shows 0; no link + no plays = no tab", async () => {
  const fan = U.fan;
  const vis = layout.view(await layout.get(fan.userId), {});
  assert.equal(vis.show("px_watch"), false, "private by default");
  assert.equal(vis.show("px_pads"), false);
  assert.equal(await PS.forProfile(fan.userId, { show: vis.show }), null, "a visitor gets no tab");
  const own = layout.view(await layout.get(fan.userId), { owner: true });
  PS._setClock(() => T0 + 5 * DAY);
  const mine = await PS.forProfile(fan.userId, { show: own.show, owner: true });
  assert.equal(mine.watch.total_plays, 140);
  assert.equal(mine.watch.streak.current, 0, "no play in 5 days");
  assert.equal(mine.watch.streak.best, 3);
  // made public: a visitor gets the stats
  const pub = layout.view(layout.sanitize({ pub: ["px_watch"] }), {});
  assert.equal((await PS.forProfile(fan.userId, { show: pub.show })).watch.total_plays, 140);
  assert.equal(await PS.forProfile(U.guess.userId, { show: pub.show }), null);
  PS._setClock(null);
});

test("layout: the 📼 panels are 'Only me & admins' by default; the form can make them public or hidden; old layouts too", () => {
  const d = layout.sanitize({});
  assert.ok(d.priv.includes("px_watch") && d.priv.includes("px_pads"));
  assert.equal(layout.stateOf(d, "px_watch"), "private");
  assert.equal(layout.stateOf(d, "an_words"), "public", "the analytics panels keep their public default");
  const old = layout.sanitize({ order: ["posts", "analytics"], hidden: [], priv: ["an_words"] });
  assert.equal(layout.stateOf(old, "px_pads"), "private", "a layout saved before 1.99nj");
  assert.ok(old.order.includes("plex"));
  const body = { order: layout.SECTION_IDS, show: layout.SECTION_IDS };
  for (const p of layout.PRIV_IDS) body["vis_" + p] = "public";
  body.vis_px_pads = "hidden";
  const f = layout.fromForm(body);
  assert.equal(layout.stateOf(f, "px_watch"), "public");
  assert.equal(layout.stateOf(f, "px_pads"), "hidden");
  assert.equal(layout.stateOf(layout.sanitize(JSON.parse(JSON.stringify(f))), "px_watch"), "public", "round-trips through the stored JSON");
  const missing = layout.fromForm({ order: layout.SECTION_IDS, show: layout.SECTION_IDS });
  assert.equal(layout.stateOf(missing, "px_watch"), "hidden", "fails closed");
  const tabs = layout.tabsFor(layout.view(d, {}), { posts: true, gtf: true, badges: true, analytics: true, plex: true });
  assert.deepEqual(tabs.map((t) => t.id), ["posts", "overview", "analytics", "plex"]);
});

test("the 📼 Plex tab renders: owner sees both panels with the lock tag; strings come from en.json", async () => {
  const fan = U.fan;
  const own = layout.view(await layout.get(fan.userId), { owner: true });
  PS._setClock(() => T0);
  const px = await PS.forProfile(fan.userId, { show: own.show, owner: true });
  px.pads = { plays: 2, movies: 1, episodes: 1, hours: 1.5, titles: 2, recent: [{ title: "Cosmos — S1E1", kind: "episode", at: T0, room: "padA" }] };
  const html = await ejs.renderFile(path.join(repo, "views", "partials", "profile-plex.ejs"), { px, L: own });
  assert.match(html, /Watch time/);
  assert.match(html, /100 h/, "360,000 s = 100 h");
  assert.match(html, /140 plays/);
  assert.match(html, /Favourite shows[\s\S]*Severance/);
  assert.match(html, /Only you &amp; admins can see this/);
  assert.match(html, /Plays on pads/);
  assert.match(html, /Cosmos — S1E1/);
  assert.doesNotMatch(html, /profile\.px\./, "every string is in en.json");
  // a linked owner before the first sync
  const early = await ejs.renderFile(path.join(repo, "views", "partials", "profile-plex.ejs"),
    { px: { linked: true, configured: true, owner: true, watch: null, pads: null }, L: own });
  assert.match(early, /after the next sync/);
  PS._setClock(null);
});

test("the editor shows the 📼 switches in the Plex row; the client never gets Tautulli's address or key", () => {
  const ed = fs.readFileSync(path.join(repo, "views", "editProfile.ejs"), "utf8");
  assert.match(ed, /privs\.filter\(\(p\) => \(p\.sec \|\| 'analytics'\) === id\)/);
  assert.ok(layout.PRIV.filter((p) => p.sec === "plex").length === 2);
  const src = fs.readFileSync(path.join(repo, "tautulli.js"), "utf8");
  assert.match(src, /replace\(\/\[A-Za-z0-9\]\{24,\}\/g/, "error messages scrub long tokens");
  const ex = fs.readFileSync(path.join(repo, ".env.example"), "utf8");
  assert.match(ex, /TAUTULLI_URL=https:\/\/TAUTULLI_HOST/);
  assert.match(ex, /TAUTULLI_API_KEY=REPLACE_ME/);
});
