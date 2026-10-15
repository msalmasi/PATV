// 1.99zm: padstreaks.js - 🔥 pad streaks + regular streaks, the quiet history import and the achievements.
//   * participation rows -> pad days (distinct people, Pepe never counts) + account-keyed regular days; live rows only for the last days
//   * the pad streak needs min_users people a day (admin setting); regular streaks per pad; streaks.compute semantics
//   * the backfill: participation history + Pepe's room analytics (pad days only), quiet badges for milestones reached (no feed)
//   * metrics: the best regular run in one pad; the best run of a pad the member owns
//   * the catalog: six web achievements, XP and 0 PAT, localized names; the card API; the profile's top regular pad
//   NODE_PATH=G:/PATV/node_modules node --test test/padstreaks.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "padstreaks-test-")));
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const ST = require(path.join(repo, "streaks"));
const PS = require(path.join(repo, "padstreaks"));

const DRAMA = "DRAMA_CENTRAL";
let T = Date.UTC(2026, 9, 14, 18, 0, 0);          // 2026-10-14 14:00 Eastern
ST._setClock(() => T); PS._setClock(() => T);
const day = (n) => ST.dayOf(T - n * 86400000);    // n days ago (Eastern)

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, level INTEGER DEFAULT 1, xp REAL DEFAULT 0)`);
  for (const [id, name, cf] of [["o1", "owner", "dq"], ["a1", "alice", "alicecf"], ["b1", "bob", "bobcf"], ["c1", "carol", "carolcf"], ["p1", "pepe", "pepefrog"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, camfrogUsername) VALUES (?, ?, ?, ?)", [id, name, name, cf]);
  }
  await runQuery(`CREATE TABLE econ_participation (room_id TEXT NOT NULL, day TEXT NOT NULL, login TEXT NOT NULL, lines INTEGER, mic_min REAL, cmds INTEGER,
                  active_min INTEGER, updated INTEGER, PRIMARY KEY (room_id, day, login))`);
  await runQuery("CREATE TABLE camfrog_roomstats (room_id TEXT PRIMARY KEY, name TEXT, data TEXT NOT NULL, updated INTEGER)");
  await runQuery(`CREATE TABLE IF NOT EXISTS badges (badgeId TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, icon TEXT,
                  points INTEGER DEFAULT 0, requirement TEXT NOT NULL, createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS user_badges (userId TEXT NOT NULL, badgeId TEXT NOT NULL, awardedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (userId, badgeId))`);
  const A = require(path.join(repo, "achievements"));
  A.setUpdateLevel(async () => null);
  await A.ready;
  await rooms.init();
  await rooms.addRoom(DRAMA, null, "test");
  await rooms.setOwner(DRAMA, "owner", "test");
  await PS.ready;
});

const part = async (dayKey, login, lines, mic = 0) => {
  await runQuery("INSERT OR REPLACE INTO econ_participation (room_id, day, login, lines, mic_min, cmds, active_min, updated) VALUES (?, ?, ?, ?, ?, 0, 0, 0)",
                 [DRAMA, dayKey, login, lines, mic]);
  return { room: DRAMA, day: dayKey, login, lines, mic_min: mic };
};

test("history: the backfill reads participation + room analytics; quiet badges", async () => {
  // 10 days of alice (chat) and bob (mic) + carol on some days; Pepe every day (never counts)
  const rows = [];
  for (let n = 10; n >= 1; n--) {
    rows.push(await part(day(n), "alicecf", 5), await part(day(n), "bobcf", 0, 3), await part(day(n), "pepefrog", 50));
    if (n % 2 === 0) rows.push(await part(day(n), "carolcf", 2));
  }
  // analytics: 20 days of 8 chatters before that
  const days = {};
  for (let n = 30; n >= 11; n--) days[day(n)] = { m: 100, c: 8 };
  await runQuery("INSERT INTO camfrog_roomstats (room_id, name, data, updated) VALUES (?, ?, ?, 0)", [DRAMA, DRAMA, JSON.stringify({ days })]);
  const r = await PS.backfill();
  assert.ok(r.done);
  // min_users 3: days with alice + bob + carol (even days) only from participation; analytics days all count -> the run is broken
  let s = await PS.padStreak(DRAMA);
  assert.equal(s.best, 21, "20 analytics days + day 10 (carol) - day 9 has only 2 people");
  await PS.setConfig({ min_users: 2 });
  s = await PS.padStreak(DRAMA);
  assert.equal(s.best, 30, "at a bar of 2 every day counts");
  assert.equal(s.current, 30, "yesterday counts and today isn't over: the run is alive");
  assert.equal(s.atRisk, true);
  const reg = await PS.regularStreak(DRAMA, "a1");
  assert.equal(reg.best, 10);
  const pepe = await getQuery("SELECT COUNT(*) AS n FROM pad_regulars WHERE userId = 'p1'");
  assert.equal(pepe[0].n, 0, "Pepe never has regular days");
  const badges = await getQuery("SELECT userId, badgeId FROM user_badges ORDER BY userId, badgeId");
  const got = badges.map((b) => b.userId + ":" + b.badgeId);
  assert.ok(got.includes("a1:cf_regular_7") && got.includes("b1:cf_regular_7"), "regulars past 7 days: badge");
  assert.ok(got.includes("o1:cf_padstreak_7"), "the owner's pad past 7 days (at the bar of the backfill: 3 -> 21 days)");
  assert.ok(!got.some((g) => g.startsWith("c1:cf_regular") || g.startsWith("c1:cf_padstreak")), "carol never ran 7 days in a row");
  const feed = await getQuery("SELECT COUNT(*) AS n FROM achievement_feed").catch(() => [{ n: 0 }]);
  assert.equal(feed[0].n, 0, "quiet: nothing announced");
});

test("live rows: today extends the streaks; old days are ignored live", async () => {
  const rows = [await part(day(0), "alicecf", 3), await part(day(0), "bobcf", 1)];
  await PS.fromParticipation(rows);
  const s = await PS.padStreak(DRAMA);
  assert.equal(s.current, 31);
  assert.equal(s.todayDone, true);
  const r = await PS.regularStreak(DRAMA, "a1");
  assert.equal(r.current, 11);
  await PS.fromParticipation([{ room: DRAMA, day: day(40), login: "carolcf", lines: 5 }]);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pad_regulars WHERE day = ?", [day(40)]))[0].n, 0, "an old day only comes from the backfill");
});

test("metrics, card, profile", async () => {
  const m = await PS.metrics("o1");
  assert.equal(m.pad_streak, 31);
  assert.equal((await PS.metrics("a1")).pad_regular_streak, 11);
  const c = await PS.card(DRAMA, { userId: "a1" });
  assert.equal(c.pad.current, 31);
  assert.equal(c.me.current, 11);
  assert.equal(c.me.next, 30);
  assert.equal((await PS.card(DRAMA, null)).me, null);
  const top = await PS.topForUser("a1");
  assert.equal(top.room, DRAMA);
  assert.equal(top.current, 11);
  assert.equal(await PS.topForUser("c1"), null, "no running streak: nothing on the profile");
});

test("the catalog: six web achievements, XP and no PAT, localized", async () => {
  const cat = JSON.parse(fs.readFileSync(path.join(repo, "achievements.json"), "utf8"));
  const list = (cat.achievements || cat).filter((a) => /^cf_(regular|padstreak)_/.test(a.id));
  assert.equal(list.length, 6);
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  for (const a of list) {
    assert.equal(a.side, "web");
    assert.equal(a.pat, 0, a.id + " pays no PAT (the user's call)");
    assert.ok(a.xp > 0);
    assert.equal(en["ach.n." + a.id], a.name);
    assert.equal(en["ach.d." + a.id], a.desc);
    assert.ok(fs.existsSync(path.join(repo, "public", "img", "badges", "ach", a.id + ".png")), a.id + " has art");
  }
});
