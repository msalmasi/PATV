// 1.99aco: the duel / brawl win-streak achievements (Pepe 1.99acn counts them: pepe_pvpstreak.py).
//   * the catalog: six rows (cf_duel_streak_5/10/20 on duel_streak, cf_brawl_streak_5/10/20 on brawl_streak), rewards by tier,
//     badge art (256x256 RGBA PNG) for each, unique names, localized (en.json), grouped with the fight badges on /achievements
//   * the achievements backend (achprogress.js): Pepe's metric is the BEST run (the current run is duel_streak_run, reset on a
//     loss with no check) - a counted win crossing 5 / 10 / 20 awards once (XP + PAT from the achievements group), a loss
//     awards nothing, a 5th win and a loss inside one heartbeat still award, held ids stay quiet
//   * a login re-key keeps the larger run (MAX_KEYS), never the sum
//   * review: the texts name the anti-farming rules Pepe applies (the stake floor = pvpcfg's default knob, established players,
//     evenly matched brawls, no alts; 1.99act: the same-opponent window is a knob, off by default)
//   NODE_PATH=G:/PATV/node_modules node --test test/pvp-streak-achievements.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pvpstreak-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.DB_BACKUP_DIR = path.join(tmp, "backups");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const funding = require(path.join(repo, "funding"));
const paid = [];
funding.fundPayout = async (userId, amount, flow, why) => { paid.push({ userId, amount, flow, why }); return true; };
let A, AP;
const xp = [];

const ROWS = [
  ["cf_duel_streak_5", "Hop Streak", "🐸", "duel_streak", 5, 3000, 30000, "uncommon"],
  ["cf_duel_streak_10", "Leaps and Bounds", "🎲", "duel_streak", 10, 10000, 120000, "rare"],
  ["cf_duel_streak_20", "Frog of Fortune", "🍀", "duel_streak", 20, 25000, 350000, "legendary"],
  ["cf_brawl_streak_5", "Bullfrog", "💪", "brawl_streak", 5, 3000, 30000, "uncommon"],
  ["cf_brawl_streak_10", "Toad Warrior", "🛡️", "brawl_streak", 10, 10000, 120000, "rare"],
  ["cf_brawl_streak_20", "King of the Pond", "👑", "brawl_streak", 20, 25000, 350000, "legendary"],
];
// 1.99aco review: the anti-farming rules Pepe applies (pepe_pvpstreak.py) - the stake floor, established players, (brawls) an even
// match, each opponent once per 24 h, never your own alts (1.99acn: repeat opponents inside one streak are allowed)
const DUEL_DESC = (n) => `Won ${n} dice duels in a row at 10,000+ PAT vs established players - no alts.`;
const BRAWL_DESC = (n) => `Won ${n} brawls in a row at 10,000+ PAT vs established, evenly matched players - no alts.`;

function pack(file, key) {
  const users = {};
  for (const [l, r] of Object.entries(file)) users[l] = Object.assign({}, r, { m: Object.fromEntries(Object.entries(r.m).map(([k, v]) => [k, String(v)])) });
  const payload = JSON.stringify({ v: 1, users, flags: {} });
  let got = 0, metrics = 0, sum = 0n;
  for (const r of Object.values(file)) { got += r.got.length; for (const v of Object.values(r.m)) { metrics++; sum += BigInt(v); } }
  return { key, payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"),
           totals: { users: Object.keys(file).length, got, metrics, value_sum: sum.toString(), flags: 0 } };
}
const badges = async (uid) => (await getQuery("SELECT badgeId FROM user_badges WHERE userId = ? AND badgeId != 'cf_linked' ORDER BY badgeId", [uid])).map((r) => r.badgeId);
let seq = 0;
const ev = (login, m, extra = {}) => Object.assign({ key: `pb:pvp:${++seq}`, login, m }, extra);
const one = async (e, held = []) => (await AP.applyEvents([e], held)).results[e.key];

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, camfrogUsername TEXT, archived_at INTEGER)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS badges (badgeId TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, icon TEXT,
                  points INTEGER DEFAULT 0, requirement TEXT NOT NULL, createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS user_badges (userId TEXT NOT NULL, badgeId TEXT NOT NULL, awardedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (userId, badgeId))`);
  await runQuery("INSERT INTO users (userId, username, camfrogUsername) VALUES ('d1', 'duelist', 'Duelist'), ('b1', 'brawler', 'Brawler'), ('r1', 'racer', 'racer')");
  A = require(path.join(repo, "achievements"));
  A.setUpdateLevel(async (userId, amount) => { xp.push({ userId, amount }); return null; });
  await A.ready;
  AP = require(path.join(repo, "achprogress"));
  await AP.init();
  await AP.setMeta("enabled", true);
  const r = await AP.importFromPepe(pack({ duelist: { m: { duel_streak: 4, duel_streak_run: 4 }, got: [] } }, "ac-pvpstreak-1"));
  assert.equal(r.match, true);
});

test("catalog: six streak achievements, exactly as specified; rewards inside their tier's band; Pepe counts them", () => {
  const list = A.list();
  for (const [id, name, emoji, metric, threshold, x, pat, tier] of ROWS) {
    const a = list.find((r) => r.id === id);
    assert.ok(a, id);
    const desc = metric === "duel_streak" ? DUEL_DESC(threshold) : BRAWL_DESC(threshold);
    assert.deepEqual([a.name, a.emoji, a.desc, a.metric, a.threshold, a.xp, a.pat, a.tier, a.side], [name, emoji, desc, metric, threshold, x, pat, tier, "bot"], id);
    assert.equal(a.icon, `/public/img/badges/ach/${id}.png`);
  }
  // the bands every other achievement of a tier sits in (test/more-achievements.test.js)
  const band = { uncommon: [2000, 5000, 20000, 50000], rare: [8000, 15000, 80000, 150000], legendary: [20000, 30000, 250000, 500000] };
  for (const [id, , , , , x, pat, tier] of ROWS) {
    const [x0, x1, p0, p1] = band[tier];
    assert.ok(x >= x0 && x <= x1 && pat >= p0 && pat <= p1, id);
  }
  assert.equal(list.filter((a) => a.metric === "duel_streak" || a.metric === "brawl_streak").length, 6, "no other row on these metrics");
  assert.ok(!list.some((a) => /_streak_run$/.test(a.metric)), "nothing keyed on the CURRENT run (it drops to 0 on a loss)");
  assert.equal(new Set(list.map((a) => a.name.toLowerCase())).size, list.length, "every name is unique across the catalog");
  assert.equal(new Set(list.map((a) => a.id)).size, list.length, "unique ids");
  for (const [id] of ROWS) assert.ok(list.find((a) => a.id === id).desc.length <= 130, id + " short enough for the room's unlock line");
});

test("the texts match Pepe's rules: the stake floor is pvpcfg's default (= pepe_pvp.PVP_CFG_DEFAULTS), established players, once per 24 h", () => {
  const C = require(path.join(repo, "pvpcfg"));
  const floor = C.DEFAULTS.streak_min_stake.toLocaleString("en-US");
  assert.equal(floor, "10,000");
  for (const [id, , , metric] of ROWS) {
    const a = A.list().find((r) => r.id === id);
    assert.ok(a.desc.includes(floor + "+ PAT"), id + " names the stake floor");
    assert.match(a.desc, /established/, id);
    assert.doesNotMatch(a.desc, /once per|per 24 h/, id);   // 1.99act: no same-opponent limit by default
    assert.doesNotMatch(a.desc, /per streak/, id);
    assert.match(a.desc, /no alts/, id);
    if (metric === "brawl_streak") assert.match(a.desc, /evenly matched/, id + ": the brawl strength rule");
  }
  for (const k of ["streak_min_stake", "streak_min_acct_days", "streak_min_level", "streak_min_sheet_games", "streak_max_gap"]) assert.ok(k in C.LIMITS, k + " is an admin knob");
});

test("badge art: a 256x256 8-bit RGBA PNG for each", () => {
  for (const [id] of ROWS) {
    const f = path.join(repo, "public", "img", "badges", "ach", id + ".png");
    assert.ok(fs.existsSync(f), f);
    const b = fs.readFileSync(f);
    assert.equal(b.subarray(1, 4).toString("latin1"), "PNG", id);
    assert.equal(b.subarray(12, 16).toString("latin1"), "IHDR", id);
    assert.deepEqual([b.readUInt32BE(16), b.readUInt32BE(20), b[24], b[25]], [256, 256, 8, 6], id + " 256x256, 8-bit RGBA");
  }
});

test("en.json: names + descriptions localized; /achievements lists all six with the fight badges (games), none in 'else'", async () => {
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  for (const [id, name, , metric, threshold] of ROWS) {
    assert.equal(en["ach.n." + id], name, id);
    assert.equal(en["ach.d." + id], metric === "duel_streak" ? DUEL_DESC(threshold) : BRAWL_DESC(threshold), id);
  }
  const list = A.list();
  const html = await ejs.renderFile(path.join(repo, "views", "achievements.ejs"), {
    achievements: list, holders: {}, owned: null, viewing: null, own: false, user: null, signedIn: false,
  }, { root: path.join(repo, "views") });
  const grp = (slug) => { const m = html.match(new RegExp(`<section class="grp" data-group="${slug}"[\\s\\S]*?</section>`)); return m ? m[0] : ""; };
  for (const [id] of ROWS) {
    assert.ok(grp("games").includes(`/public/img/badges/ach/${id}.png`), id + " in games");
    assert.ok(!grp("else").includes(`/public/img/badges/ach/${id}.png`), id + " not in else");
  }
  assert.ok(grp("games").includes("/public/img/badges/ach/cf_fight_1.png"), "next to the fight badges");
  assert.match(html, /King of the Pond/);
});

test("events: a counted win crossing 5 awards once (XP + PAT from the achievements group); a loss is quiet; 10 and 20 each once", async () => {
  let r = await one(ev("duelist", { duel_streak: ["4", "5"], duel_streak_run: ["4", "5"] }, { check: ["duel_streak"] }));
  assert.deepEqual(r.awards.map((a) => a.id), ["cf_duel_streak_5"]);
  assert.equal(r.awards[0].patPaid, true);
  assert.deepEqual(await badges("d1"), ["cf_duel_streak_5"]);
  assert.deepEqual(paid.map((p) => [p.userId, p.amount, p.flow]), [["d1", 30000, "achievements"]]);
  assert.deepEqual(xp.map((x) => [x.userId, x.amount]), [["d1", 3000]]);
  // a loss: only the current run goes to 0, no check - nothing evaluated, nothing paid; the best stays 5
  r = await one(ev("duelist", { duel_streak_run: ["5", "0"] }));
  assert.equal(r.awards, undefined);
  let rec = await AP.readRecord("duelist");
  assert.deepEqual([rec.m.duel_streak, rec.m.duel_streak_run], ["5", "0"]);
  // a run back up to 5 re-checks the best (5): already got, nothing twice
  r = await one(ev("duelist", { duel_streak_run: ["0", "5"] }, { check: ["duel_streak"] }));
  assert.deepEqual(r.awards, []);
  assert.equal(paid.length, 1);
  r = await one(ev("duelist", { duel_streak: ["5", "10"], duel_streak_run: ["5", "10"] }, { check: ["duel_streak"] }));
  assert.deepEqual(r.awards.map((a) => a.id), ["cf_duel_streak_10"], "the 10 only - the 5 isn't paid again");
  assert.deepEqual(paid.slice(1).map((p) => [p.amount, p.flow]), [[120000, "achievements"]]);
  r = await one(ev("duelist", { duel_streak: ["10", "20"], duel_streak_run: ["10", "20"] }, { check: ["duel_streak"] }));
  assert.deepEqual(r.awards.map((a) => [a.id, a.tier]), [["cf_duel_streak_20", "legendary"]]);
  assert.deepEqual(paid.slice(2).map((p) => [p.amount, p.flow]), [[350000, "achievements"]]);
  assert.deepEqual(xp.map((x) => x.amount), [3000, 10000, 25000]);
  r = await one(ev("duelist", { duel_streak: ["20", "21"], duel_streak_run: ["20", "21"] }, { check: ["duel_streak"] }));
  assert.deepEqual(r.awards, [], "past 20 there's nothing left");
  assert.deepEqual(await badges("d1"), ["cf_duel_streak_10", "cf_duel_streak_20", "cf_duel_streak_5"]);
  assert.deepEqual((await badges("d1")).filter((b) => b.startsWith("cf_brawl_")), [], "duels never award a brawl badge");
});

test("events: the 5th win and a loss inside one heartbeat (best 5, run 0) still award; a check on the run alone awards nothing", async () => {
  let r = await one(ev("racer", { duel_streak: ["0", "5"], duel_streak_run: ["0", "0"] }, { check: ["duel_streak"] }));
  assert.deepEqual(r.awards.map((a) => a.id), ["cf_duel_streak_5"]);
  r = await one(ev("racer", { duel_streak_run: ["0", "10"] }, { check: ["duel_streak_run"] }));
  assert.deepEqual(r.awards, [], "no catalog row keys on the current run");
});

test("events: brawls - held ids stay quiet, then the 5 awards once; the brawl badges are separate from the duel ones", async () => {
  let r = await one(ev("brawler", { brawl_streak: ["0", "5"], brawl_streak_run: ["0", "5"] }, { check: ["brawl_streak"] }), ["cf_brawl_streak_5"]);
  assert.deepEqual(r.awards, []);
  assert.deepEqual(await badges("b1"), []);
  r = await one(ev("brawler", { brawl_streak: ["5", "6"], brawl_streak_run: ["5", "6"] }, { check: ["brawl_streak"] }));
  assert.deepEqual(r.awards.map((a) => a.id), ["cf_brawl_streak_5"]);
  assert.deepEqual(await badges("b1"), ["cf_brawl_streak_5"]);
  assert.deepEqual(paid.filter((p) => p.userId === "b1").map((p) => [p.amount, p.flow]), [[30000, "achievements"]]);
});

test("rekey: two logins' runs keep the larger (4 and 3 -> 4, not 7 - not a rarer badge from two short runs); counters still add", async () => {
  await AP.applyEvents([ev("oldlogin", { brawl_streak: ["0", "4"], brawl_streak_run: ["0", "2"], duel_streak: ["0", "3"], fight_wins: ["0", "5"] }),
                        ev("newlogin", { brawl_streak: ["0", "3"], brawl_streak_run: ["0", "3"], duel_streak: ["0", "9"], fight_wins: ["0", "2"] })], []);
  await AP.applyEvents([{ key: `pb:pvp:${++seq}`, rekey: { old: "oldlogin", new: "newlogin" } }], []);
  const rec = await AP.readRecord("newlogin");
  assert.deepEqual([rec.m.brawl_streak, rec.m.brawl_streak_run, rec.m.duel_streak, rec.m.fight_wins], ["4", "3", "9", "7"]);
  assert.equal(await AP.readRecord("oldlogin"), null);
  // the bot's MAX_KEYS (pepe_loginrekey.py) and the site's are the same list for these names
  const src = fs.readFileSync(path.join(repo, "achprogress.js"), "utf8");
  for (const k of ["duel_streak", "brawl_streak", "duel_streak_run", "brawl_streak_run"]) assert.match(src, new RegExp(`MAX_KEYS = new Set\\([^)]*"${k}"`));
});
