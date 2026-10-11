// Offline tests for 1.99lk: the 📨 Carrier Frog achievement (cf_telegram_linked) for linking Telegram - by the bridge's
// /start code or Sign in with Telegram - and the Air Mail name colour it unlocks for good. Accounts linked before it
// existed get it quietly (badge + cosmetic, no XP / PAT / announcement). Nothing leaves the process.
//   NODE_PATH=G:/PATV/node_modules node --test test/telegram-achievements.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tgach-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");

const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const TG = require(path.join(repo, "telegram"));
const COS = require(path.join(repo, "cosmetics"));
let A;                                   // required once the badge tables + the old links exist (it seeds on load)

let T = Date.parse("2026-10-11T12:00:00Z");
TG._setClock(() => T);
const xp = [];
let n = 0;
async function mkUser(name) {
  const id = "u" + (++n);
  const username = name || "tgfan" + n;
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance) VALUES (?, ?, ?, 'x', 'pleb', 0)", [id, username, username]);
  return { userId: id, username };
}
const badges = async (u) => (await getQuery("SELECT badgeId FROM user_badges WHERE userId = ? AND badgeId = 'cf_telegram_linked'", [u.userId])).map((r) => r.badgeId);
const items = async (u) => (await COS.inventory(u.userId)).items.map((i) => i.item_id);
const feedFor = async (u) => (await getQuery("SELECT badgeId FROM achievement_feed WHERE userId = ? ORDER BY id", [u.userId])).map((r) => r.badgeId);
const linkByCode = async (u, tgId, handle) => { const c = await TG.makeCode(u.userId); return TG.link({ code: c.code, tg_id: tgId, handle }); };

let old;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, extra_daily_spins INTEGER DEFAULT 0,
                  discordId TEXT, camfrogUsername TEXT, email TEXT, isEmailVerified INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS feed_bans (user_id TEXT NOT NULL, room_id TEXT NOT NULL DEFAULT '', username TEXT, reason TEXT, by TEXT, at INTEGER,
                  until INTEGER, PRIMARY KEY (user_id, room_id))`);
  await runQuery(`CREATE TABLE IF NOT EXISTS badges (badgeId TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, icon TEXT,
                  points INTEGER DEFAULT 0, requirement TEXT NOT NULL, createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS user_badges (userId TEXT NOT NULL, badgeId TEXT NOT NULL, awardedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (userId, badgeId))`);
  await TG.init();
  // linked BEFORE the achievement existed
  old = await mkUser("earlybird");
  await runQuery("INSERT INTO telegram_links (user_id, tg_id, handle, link_source, proof, linked_at, paused) VALUES (?, '5550001', 'earlybird', 'self', 'start_code', ?, 0)", [old.userId, T]);
  A = require(path.join(repo, "achievements"));
  A.setUpdateLevel(async (userId, amount) => { xp.push({ userId, amount }); return null; });
  await A.ready;
  await COS.ready;
});

test("catalog: 📨 Carrier Frog (web side, 2,000 XP / 25,000 PAT like Tuned In) with badge art, unlocking the Air Mail name colour", () => {
  const a = A.list().find((x) => x.id === "cf_telegram_linked");
  assert.deepEqual([a.name, a.emoji, a.metric, a.threshold, a.xp, a.pat, a.tier, a.side], ["Carrier Frog", "📨", "telegram_linked", 1, 2000, 25000, "common", "web"]);
  assert.ok(fs.existsSync(path.join(repo, a.icon.replace(/^\//, ""))), "badge art: " + a.icon);
  const cat = JSON.parse(fs.readFileSync(path.join(repo, "cosmetics.json"), "utf8")).items;
  const nc = cat.find((i) => i.id === "nc_airmail");
  assert.deepEqual([nc.kind, nc.unlock, nc.perk, nc.price], ["name_color", { achievement: "cf_telegram_linked" }, undefined, 0]);
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  assert.match(en["settings.telegram.ach"], /Carrier Frog \{!link\}/);
  assert.ok(en["settings.telegram.ach_link"]);
});

test("backfill: an account linked before gets it QUIETLY (badge + Air Mail, no XP / PAT / announcement), once", async () => {
  await A.telegramBackfill();
  assert.deepEqual(await badges(old), ["cf_telegram_linked"]);
  assert.ok((await items(old)).includes("nc_airmail"));
  assert.deepEqual(await feedFor(old), [], "no announcement");
  assert.equal(xp.length, 0, "no XP");
  const meta = await getQuery("SELECT v FROM achievement_meta WHERE k = 'telegram_backfill'");
  assert.deepEqual([JSON.parse(meta[0].v).users, JSON.parse(meta[0].v).given], [1, 1]);
  assert.equal((await A.telegramBackfill()).done, true);
  // an unrelated website check afterwards doesn't announce it either
  await A.checkWeb(old.userId);
  assert.deepEqual(await feedFor(old), []);
});

let fan;
test("unlock on link (bridge /start code): 📨 Carrier Frog with XP, queued for Pepe to announce, + Air Mail", async () => {
  fan = await mkUser();
  assert.deepEqual(await badges(fan), []);
  await linkByCode(fan, "5550002", "tgfan");
  assert.deepEqual(await badges(fan), ["cf_telegram_linked"]);
  assert.deepEqual(await feedFor(fan), ["cf_telegram_linked"]);
  assert.deepEqual(xp.filter((x) => x.userId === fan.userId).map((x) => x.amount), [2000]);
  assert.ok((await items(fan)).includes("nc_airmail"));
});

test("unlink + link again (even another Telegram account): no second award; the badge and the colour stay", async () => {
  await TG.unlink(fan.userId, { force: true });
  assert.deepEqual(await badges(fan), ["cf_telegram_linked"], "achievements are for keeps");
  assert.ok((await items(fan)).includes("nc_airmail"));
  await linkByCode(fan, "5550003", "tgfan2");
  assert.deepEqual(await feedFor(fan), ["cf_telegram_linked"], "announced once");
  assert.equal(xp.filter((x) => x.userId === fan.userId).length, 1);
});

test("unlock on Sign in with Telegram (linkProven, the Login Widget path) too", async () => {
  const s = await mkUser();
  await TG.linkProven(s.userId, { tg_id: "5550004", handle: "widgetfan" });
  assert.deepEqual(await badges(s), ["cf_telegram_linked"]);
  assert.deepEqual(await feedFor(s), ["cf_telegram_linked"]);
  assert.ok((await items(s)).includes("nc_airmail"));
});

test("a refused link (Telegram id taken by another account) awards nothing", async () => {
  const x = await mkUser();
  await assert.rejects(() => TG.linkProven(x.userId, { tg_id: "5550004" }), (e) => e.code === "E_TG_TAKEN");
  assert.deepEqual(await badges(x), []);
});

test("the Air Mail name colour equips and renders as an animated Telegram-blue gradient", async () => {
  const it = (await COS.inventory(fan.userId)).items.find((i) => i.item_id === "nc_airmail");
  assert.equal(it.source, "achievement");
  assert.equal((await COS.equip(fan.userId, it.inv_id, true)).ok, true);
  const p = await COS.profileData(fan.username);
  assert.ok(p.equipped.name_color, "equipped");
  assert.match(JSON.stringify(p.equipped.name_color), /#229ed9/i);
});
