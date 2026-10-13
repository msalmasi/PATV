// Offline tests for 1.99xi: 🔥 daily activity streaks (streaks.js) and the level tier names (leveltiers.js).
// Injected clocks: New York day boundaries across both DST switches, a streak continuing / breaking, several sources the same
// day, the optional weekly freeze, Pepe's login feeds, the one-off history import (quiet milestones) and the 🔥 milestones
// awarded once with an announcement. Nothing leaves the process.
//   node --test test/streaks.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "streaks-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");

const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const ST = require(path.join(repo, "streaks"));
const LT = require(path.join(repo, "leveltiers"));
let A;

let T = Date.parse("2026-10-13T16:00:00Z");          // noon in New York
ST._setClock(() => T);
const at = (iso) => { T = Date.parse(iso); ST._clearCache(); };
const xp = [];
let n = 0;
async function mkUser(name, cf) {
  const id = "u" + (++n) + "-streak";
  const username = name || "frog" + n;
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername) VALUES (?, ?, ?, 'x', 'pleb', 0, ?)",
                 [id, username, username, cf || null]);
  return { userId: id, username };
}
const badgesOf = async (u) => (await getQuery("SELECT badgeId FROM user_badges WHERE userId = ? AND badgeId LIKE 'cf_daily_%' ORDER BY badgeId", [u.userId])).map((r) => r.badgeId);
const feedOf = async (u) => (await getQuery("SELECT badgeId FROM achievement_feed WHERE userId = ? AND badgeId LIKE 'cf_daily_%' ORDER BY id", [u.userId])).map((r) => r.badgeId);

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, xp REAL DEFAULT 0, extra_daily_spins INTEGER DEFAULT 0,
                  discordId TEXT, camfrogUsername TEXT, email TEXT, isEmailVerified INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS badges (badgeId TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, icon TEXT,
                  points INTEGER DEFAULT 0, requirement TEXT NOT NULL, createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS user_badges (userId TEXT NOT NULL, badgeId TEXT NOT NULL, awardedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (userId, badgeId))`);
  await runQuery(`CREATE TABLE IF NOT EXISTS camfrog_userstats (login TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS econ_participation (room_id TEXT NOT NULL, day TEXT NOT NULL, login TEXT NOT NULL, lines INTEGER DEFAULT 0,
                  mic_min REAL DEFAULT 0, cmds INTEGER DEFAULT 0, active_min INTEGER DEFAULT 0, updated INTEGER, PRIMARY KEY (room_id, day, login))`);
  await ST.ready;
  A = require(path.join(repo, "achievements"));
  A.setUpdateLevel(async (userId, amount) => { xp.push({ userId, amount }); return null; });
  await A.ready;
});

// ── the day key ──
test("the day is the New York calendar day - midnight boundaries on both sides of both DST switches", () => {
  const d = (iso) => ST.dayOf(Date.parse(iso));
  // EDT (UTC-4)
  assert.equal(d("2026-10-14T03:59:59Z"), "2026-10-13");
  assert.equal(d("2026-10-14T04:00:00Z"), "2026-10-14");
  // fall back: Sun 2026-11-01 02:00 EDT -> 01:00 EST. That day is 25 hours long: 04:00Z .. 05:00Z next day
  assert.equal(d("2026-11-01T03:59:59Z"), "2026-10-31");
  assert.equal(d("2026-11-01T04:00:00Z"), "2026-11-01");
  assert.equal(d("2026-11-01T06:30:00Z"), "2026-11-01", "the repeated 1 am hour");
  assert.equal(d("2026-11-02T04:59:59Z"), "2026-11-01", "still Nov 1 at 23:59:59 EST");
  assert.equal(d("2026-11-02T05:00:00Z"), "2026-11-02");
  // spring forward: Sun 2027-03-14 02:00 EST -> 03:00 EDT. That day is 23 hours long: 05:00Z .. 04:00Z next day
  assert.equal(d("2027-03-14T04:59:59Z"), "2027-03-13");
  assert.equal(d("2027-03-14T05:00:00Z"), "2027-03-14");
  assert.equal(d("2027-03-15T03:59:59Z"), "2027-03-14");
  assert.equal(d("2027-03-15T04:00:00Z"), "2027-03-15");
  assert.equal(ST.TZ, "America/New_York");
});

// ── compute(): pure ──
test("compute: a run up to today, yesterday's run still alive (at risk), a gap breaks it, best keeps the longest", () => {
  const C = (days, on, o) => ST.compute(days, on, o);
  assert.deepEqual(C([], "2026-10-13"), { current: 0, best: 0, lastDay: null, startDay: null, todayDone: false, atRisk: false, frozen: [], pendingFreeze: [], days: 0 });
  let s = C(["2026-10-11", "2026-10-12", "2026-10-13"], "2026-10-13");
  assert.deepEqual([s.current, s.best, s.todayDone, s.atRisk, s.startDay], [3, 3, true, false, "2026-10-11"]);
  s = C(["2026-10-11", "2026-10-12"], "2026-10-13");
  assert.deepEqual([s.current, s.best, s.todayDone, s.atRisk], [2, 2, false, true], "today not done yet: yesterday's run is alive");
  s = C(["2026-10-10", "2026-10-11"], "2026-10-13");
  assert.deepEqual([s.current, s.best, s.atRisk, s.startDay], [0, 2, false, null], "a whole day missed: broken");
  s = C(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-12", "2026-10-13"], "2026-10-13");
  assert.deepEqual([s.current, s.best, s.days], [2, 4, 6]);
  s = C(["2026-10-13", "2026-10-13", "2026-10-12", "bad", "2026-10-14"], "2026-10-13");
  assert.deepEqual([s.current, s.days], [2, 2], "duplicates, junk and future days don't count");
});

test("compute: across the DST switches a day is still one day (23 / 25 hours)", () => {
  const s = ST.compute(["2026-10-31", "2026-11-01", "2026-11-02"], "2026-11-02");
  assert.equal(s.current, 3);
  const t = ST.compute(["2027-03-13", "2027-03-14", "2027-03-15"], "2027-03-15");
  assert.equal(t.current, 3);
  assert.equal(ST.dn("2027-03-15") - ST.dn("2027-03-14"), 1);
});

test("compute: the weekly freeze (grace) - OFF by default; N a week bridges missed days without counting them", () => {
  const days = ["2026-10-05", "2026-10-06", "2026-10-08", "2026-10-09"];      // Mon, Tue, (Wed missed), Thu, Fri
  assert.deepEqual([ST.compute(days, "2026-10-09").current, ST.compute(days, "2026-10-09").best], [2, 2], "off: Wed breaks it");
  let s = ST.compute(days, "2026-10-09", { freezePerWeek: 1 });
  assert.deepEqual([s.current, s.best, s.frozen], [4, 4, ["2026-10-07"]], "1 a week: Wed is bridged, not counted");
  s = ST.compute(["2026-10-05", "2026-10-08"], "2026-10-08", { freezePerWeek: 1 });
  assert.equal(s.current, 1, "two missed days in one week need two freezes");
  s = ST.compute(["2026-10-05", "2026-10-07", "2026-10-09"], "2026-10-09", { freezePerWeek: 1 });
  assert.equal(s.current, 1, "the week's one freeze is spent on Tue; Thu breaks it");
  s = ST.compute(["2026-10-09", "2026-10-11", "2026-10-13"], "2026-10-13", { freezePerWeek: 1 });
  assert.equal(s.current, 3, "Sat (week of Oct 5) and Mon (week of Oct 12) each use their own week's freeze");
  s = ST.compute(["2026-10-10", "2026-10-11"], "2026-10-13", { freezePerWeek: 1 });
  assert.deepEqual([s.current, s.atRisk, s.pendingFreeze], [2, true, ["2026-10-12"]], "a freeze covers yesterday while today is still open");
});

// ── touch(): the table ──
test("touch: several sources the same day are one day; a new day reports 'day' once; the streak follows the clock", async () => {
  const u = await mkUser("hopper");
  at("2026-10-10T14:00:00Z");
  assert.equal(await ST.touch(u.userId, "chat"), "day");
  assert.equal(await ST.touch(u.userId, "spin"), true, "a new source the same day: a row, not a new day");
  assert.equal(await ST.touch(u.userId, "spin"), false, "the same source again: nothing");
  assert.equal(await ST.touch(u.userId, "nope"), false, "unknown source");
  at("2026-10-11T03:30:00Z");                         // 23:30 EDT Oct 10: still the same NY day
  assert.equal(await ST.touch(u.userId, "post"), true);
  assert.deepEqual((await ST.forUser(u.userId)).current, 1);
  at("2026-10-11T04:10:00Z");                         // 00:10 EDT Oct 11
  assert.equal(await ST.touch(u.userId, "comment"), "day");
  at("2026-10-12T15:00:00Z");
  let s = await ST.forUser(u.userId);
  assert.deepEqual([s.current, s.atRisk, s.todayDone], [2, true, false]);
  await ST.touch(u.userId, "tip");
  s = await ST.forUser(u.userId);
  assert.deepEqual([s.current, s.best, s.todayDone], [3, 3, true]);
  assert.deepEqual((await ST.sourcesOn(u.userId, "2026-10-10")).sort(), ["chat", "post", "spin"]);
  at("2026-10-14T15:00:00Z");                         // the 13th was missed
  s = await ST.forUser(u.userId);
  assert.deepEqual([s.current, s.best], [0, 3], "broken");
  await ST.touch(u.userId, "game");
  s = await ST.forUser(u.userId);
  assert.deepEqual([s.current, s.best], [1, 3], "a new run starts");
  assert.equal(await ST.touch("pepe-bot", "post"), false, "Pepe's own account never holds a streak");
});

test("touch across the fall-back DST day keeps the run going", async () => {
  const u = await mkUser("dstfrog");
  at("2026-10-31T23:00:00Z"); await ST.touch(u.userId, "chat");      // Oct 31 19:00 EDT
  at("2026-11-01T05:30:00Z"); await ST.touch(u.userId, "chat");      // Nov 1 01:30 EST (the repeated hour)
  at("2026-11-02T04:30:00Z"); await ST.touch(u.userId, "chat");      // Nov 1 23:30 EST - same day
  at("2026-11-02T05:30:00Z"); await ST.touch(u.userId, "chat");      // Nov 2 00:30 EST
  const s = await ST.forUser(u.userId);
  assert.deepEqual([s.current, s.days], [3, 3]);
});

// ── Pepe's feeds ──
test("Pepe's participation + analytics: the login's account (real before the auto CF one, or u:<userId>), live days only", async () => {
  const real = await mkUser("realfrog", "ChattyFrog");
  await mkUser("CFchattyfrog", "chattyfrog");               // an auto account with the same login: not the one credited
  const webOnly = await mkUser("webonly");
  at("2026-10-20T16:00:00Z");
  const rows = ST.fromParticipation([
    { room: "r1", day: "2026-10-20", login: "chattyfrog", lines: 5, mic_min: 0, cmds: 2 },
    { room: "r2", day: "2026-10-19", login: "chattyfrog", lines: 0, mic_min: 3.5, cmds: 0 },
    { room: "r1", day: "2026-09-01", login: "chattyfrog", lines: 9 },               // too old for a live sync
    { room: "r1", day: "2026-10-20", login: "nobodyhere", lines: 1 },
  ]);
  assert.deepEqual(rows.map((r) => r.src), ["chat", "cmd", "mic", "chat", "chat"]);
  await ST.fromLogins(rows);
  assert.deepEqual((await getQuery("SELECT day, src FROM activity_days WHERE userId = ? ORDER BY day, src", [real.userId])).map((r) => r.day + ":" + r.src),
                   ["2026-10-19:mic", "2026-10-20:chat", "2026-10-20:cmd"]);
  assert.equal((await ST.forUser(real.userId)).current, 2);
  // userstats day maps, keyed by the account key for an account with no chat login
  const row = { login: "u:" + webOnly.userId.toLowerCase(), chat: { days: { "2026-10-20": 4, "2026-10-18": 2, "2026-07-01": 9 } }, mic: { days: {} }, cmds: { days: { "2026-10-19": 1 } } };
  assert.deepEqual(ST.fromUserstats(row).map((x) => x.day + ":" + x.src).sort(), ["2026-10-18:chat", "2026-10-19:cmd", "2026-10-20:chat"]);
  assert.equal(ST.fromUserstats(row, { all: true }).length, 4);
  await ST.fromLogins(ST.fromUserstats(row));
  assert.equal((await ST.forUser(webOnly.userId)).current, 3);
});

// ── milestones ──
test("backfill: history (Pepe's analytics + participation) imported once; milestones it reached given QUIETLY", async () => {
  const vet = await mkUser("veteran", "VetFrog");
  at("2026-10-20T16:00:00Z");
  const days = {};
  for (let i = 0; i < 9; i++) days[ST.dk(ST.dn("2026-10-08") + i)] = 3;   // Oct 8..16
  await runQuery("INSERT INTO camfrog_userstats (login, data, updated) VALUES ('vetfrog', ?, 0)", [JSON.stringify({ login: "vetfrog", chat: { days } })]);
  await runQuery("INSERT INTO econ_participation (room_id, day, login, lines, mic_min, cmds) VALUES ('r', '2026-10-17', 'vetfrog', 0, 2, 0)");
  assert.equal(await ST.metric(vet.userId), 0, "nothing counts before the import");
  const r = await ST.backfill();
  assert.equal(r.done, true);
  assert.equal((await ST.forUser(vet.userId)).best, 10, "Oct 8..17");
  assert.deepEqual(await badgesOf(vet), ["cf_daily_7"], "the 7-day milestone, quietly");
  assert.deepEqual(await feedOf(vet), [], "no announcement");
  assert.equal(xp.filter((x) => x.userId === vet.userId).length, 0, "no XP");
  assert.equal((await ST.backfill()).already, undefined, "the same promise");
  await A.checkWeb(vet.userId);
  assert.deepEqual(await feedOf(vet), [], "a later check doesn't announce it either");
});

test("live: the 7th day in a row awards 🔥 On a Roll ONCE - XP, announced; more days / checks never repeat it", async () => {
  const u = await mkUser("rolling");
  for (let i = 0; i < 7; i++) {
    at(ST.dk(ST.dn("2026-10-21") + i) + "T15:00:00Z");
    await ST.touch(u.userId, i % 2 ? "spin" : "post");
    await A.checkWeb(u.userId);
    if (i < 6) assert.deepEqual(await badgesOf(u), [], `day ${i + 1}: not yet`);
  }
  assert.deepEqual(await badgesOf(u), ["cf_daily_7"]);
  assert.deepEqual(await feedOf(u), ["cf_daily_7"], "queued for Pepe to announce");
  assert.deepEqual(xp.filter((x) => x.userId === u.userId).map((x) => x.amount), [2000]);
  at("2026-10-28T15:00:00Z");
  await ST.touch(u.userId, "chat");
  await A.checkWeb(u.userId);
  await A.checkWeb(u.userId);
  assert.deepEqual(await feedOf(u), ["cf_daily_7"], "once");
  // a broken streak and a new 7-day run: still once (best-run metric, a badge is for keeps)
  for (let i = 0; i < 7; i++) {
    at(ST.dk(ST.dn("2026-11-05") + i) + "T15:00:00Z");
    await ST.touch(u.userId, "chat");
  }
  await A.checkWeb(u.userId);
  assert.deepEqual(await feedOf(u), ["cf_daily_7"]);
});

test("the catalog: four 🔥 milestones (7 / 30 / 100 / 365) on the web side, localized, with badge art", () => {
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  const ms = A.list().filter((a) => a.metric === ST.METRIC);
  assert.deepEqual(ms.map((a) => a.threshold), ST.MILESTONES);
  for (const a of ms) {
    assert.equal(a.side, "web");
    assert.ok(/^cf_daily_\d+$/.test(a.id), a.id);
    assert.equal(en["ach.n." + a.id], a.name);
    assert.equal(en["ach.d." + a.id], a.desc);
    assert.ok(fs.existsSync(path.join(repo, a.icon.replace(/^\//, ""))), "badge art: " + a.icon);
  }
  assert.ok(en["ach.group.daily"]);
  assert.equal(ST.nextMilestone(0), 7);
  assert.equal(ST.nextMilestone(7), 30);
  assert.equal(ST.nextMilestone(400), null);
});

test("the grace rule is an admin setting, 0..7, off by default", async () => {
  assert.equal((await ST.config()).freeze_per_week, 0);
  assert.equal((await ST.setConfig({ freeze_per_week: 99 })).freeze_per_week, 7);
  assert.equal((await ST.setConfig({ freeze_per_week: 1 })).freeze_per_week, 1);
  await ST.setConfig({ freeze_per_week: 0 });
});

test("account merges move the days (folded per day + source); deletes and exports cover the table", () => {
  const AM = require(path.join(repo, "accountMerge"));
  const r = AM.classify("activity_days", "userId");
  assert.ok(r && r.move, "moved");
  assert.deepEqual(r.key, ["day", "src"]);
  assert.match(fs.readFileSync(path.join(repo, "accountdelete.js"), "utf8"), /\["activity_days", "userId", "uid"\]/);
  assert.match(fs.readFileSync(path.join(repo, "accountexport.js"), "utf8"), /rows\("activity_days"/);
});

// ── level tiers ──
test("level tiers: a name per 10 levels from Tadpole, Roman numerals past the ladder, i18n keys match the data file", () => {
  assert.equal(LT.tierOf(0).name, "Tadpole");
  assert.equal(LT.tierOf(9).name, "Tadpole");
  assert.equal(LT.tierOf(10).name, "Froglet");
  assert.equal(LT.tierOf(41).label, "Reed Runner");
  assert.deepEqual([LT.tierOf(41).min, LT.tierOf(41).max, LT.tierOf(41).rank], [40, 49, 5]);
  assert.equal(LT.tierOf(199).label, "Eternal Frog");
  assert.equal(LT.tierOf(200).label, "Pond Deity I");
  assert.equal(LT.tierOf(215).label, "Pond Deity II");
  assert.equal(LT.tierOf(1000).label, "Pond Deity LXXXI");
  assert.equal(LT.tierOf(-3).name, "Tadpole");
  assert.equal(LT.tierOf("12").name, "Froglet");
  const L = LT.ladder();
  assert.equal(L.tiers.length, 20);
  assert.equal(new Set(L.tiers.map((t) => t.key)).size, 20, "unique keys");
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  for (const t of [...L.tiers, L.beyond]) assert.equal(en["tier." + t.key], t.name, "tier." + t.key);
  const t = (k) => en[k];
  t.has = (k) => k in en;
  assert.equal(LT.labelOf(15, t), "🐸 Froglet");
  assert.equal(LT.labelOf(203, t), "🌟 Pond Deity I");
  assert.deepEqual(LT.forApi(23), { key: "pond_hopper", name: "Pond Hopper", emoji: "💧", min: 20, max: 29, rank: 3 });
});
