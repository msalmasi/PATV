// Offline tests for 1.99lu: the 🍀 I'm Feeling Lucky achievement (cf_google_linked) for linking a Google account - from Edit
// profile -> Connections or by Sign in with Google ("I already have an account" / a new account) - and the Search Party
// avatar ring it unlocks for good. Accounts linked before it existed get it quietly (badge + cosmetic, no XP / PAT /
// announcement). Nothing leaves the process.
//   NODE_PATH=G:/PATV/node_modules node --test test/google-achievements.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "googleach-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");

const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const SSO = require(path.join(repo, "ssolinks"));
require(path.join(repo, "googlesso"));          // registers the shared flow's Google provider (linkTo)
const COS = require(path.join(repo, "cosmetics"));
let A;                                         // required once the badge tables + the old links exist (it seeds on load)

const xp = [];
let n = 0;
async function mkUser(name) {
  const id = "g" + (++n);
  const username = name || "gfan" + n;
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance) VALUES (?, ?, ?, 'x', 'pleb', 0)", [id, username, username]);
  return { userId: id, username };
}
const badges = async (u) => (await getQuery("SELECT badgeId FROM user_badges WHERE userId = ? AND badgeId = 'cf_google_linked'", [u.userId])).map((r) => r.badgeId);
const items = async (u) => (await COS.inventory(u.userId)).items.map((i) => i.item_id);
const feedFor = async (u) => (await getQuery("SELECT badgeId FROM achievement_feed WHERE userId = ? ORDER BY id", [u.userId])).map((r) => r.badgeId);
const link = (u, sub) => SSO.addLink("google", u.userId, { subject: sub, proof: "oidc", email: u.username + "@example.com", name: u.username });

let old;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, extra_daily_spins INTEGER DEFAULT 0,
                  discordId TEXT, twitchId TEXT, camfrogUsername TEXT, email TEXT, isEmailVerified INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS badges (badgeId TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, icon TEXT,
                  points INTEGER DEFAULT 0, requirement TEXT NOT NULL, createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS user_badges (userId TEXT NOT NULL, badgeId TEXT NOT NULL, awardedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (userId, badgeId))`);
  await SSO.init();
  // linked BEFORE the achievement existed
  old = await mkUser("earlybird");
  await runQuery("INSERT INTO sso_links (provider, subject, user_id, link_source, proof, email, name, linked_at) VALUES ('google', 'sub-old', ?, 'self', 'oidc', NULL, NULL, 1)", [old.userId]);
  A = require(path.join(repo, "achievements"));
  A.setUpdateLevel(async (userId, amount) => { xp.push({ userId, amount }); return null; });
  await A.ready;
  await COS.ready;
});

test("catalog: 🍀 I'm Feeling Lucky (web side, 2,000 XP / 25,000 PAT like Carrier Frog) with badge art, unlocking the Search Party ring", () => {
  const a = A.list().find((x) => x.id === "cf_google_linked");
  assert.deepEqual([a.name, a.emoji, a.metric, a.threshold, a.xp, a.pat, a.tier, a.side], ["I'm Feeling Lucky", "🍀", "google_linked", 1, 2000, 25000, "common", "web"]);
  assert.ok(fs.existsSync(path.join(repo, a.icon.replace(/^\//, ""))), "badge art: " + a.icon);
  const cat = JSON.parse(fs.readFileSync(path.join(repo, "cosmetics.json"), "utf8")).items;
  const ad = cat.find((i) => i.id === "ad_searchparty");
  assert.deepEqual([ad.kind, ad.unlock, ad.perk, ad.price], ["avatar_decoration", { achievement: "cf_google_linked" }, undefined, 0]);
  // a slot / style the 📼 Plex and 📨 Telegram unlocks don't use: a static four-colour ring (VHS Reels spins, Air Mail is a name colour)
  assert.equal(ad.style.spin, undefined);
  for (const c of ["#4285f4", "#ea4335", "#fbbc05", "#34a853"]) assert.ok(ad.style.conic.some((s) => s.startsWith(c)), c);
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  assert.match(en["settings.connections.google_ach"], /I'm Feeling Lucky \{!link\}/);
  assert.ok(en["settings.connections.google_ach_link"]);
});

test("backfill: an account linked before gets it QUIETLY (badge + Search Party, no XP / PAT / announcement), once", async () => {
  await A.googleBackfill();
  assert.deepEqual(await badges(old), ["cf_google_linked"]);
  assert.ok((await items(old)).includes("ad_searchparty"));
  assert.deepEqual(await feedFor(old), [], "no announcement");
  assert.equal(xp.length, 0, "no XP");
  const meta = await getQuery("SELECT v FROM achievement_meta WHERE k = 'google_backfill'");
  assert.deepEqual([JSON.parse(meta[0].v).users, JSON.parse(meta[0].v).given], [1, 1]);
  assert.equal((await A.googleBackfill()).done, true);
  // an unrelated website check afterwards doesn't announce it either
  await A.checkWeb(old.userId);
  assert.deepEqual(await feedFor(old), []);
});

let fan;
test("unlock on link (Edit profile -> Connections): 🍀 with XP, queued for Pepe to announce, + Search Party", async () => {
  fan = await mkUser();
  assert.deepEqual(await badges(fan), []);
  assert.equal((await link(fan, "sub-fan")).already, false);
  assert.deepEqual(await badges(fan), ["cf_google_linked"]);
  assert.deepEqual(await feedFor(fan), ["cf_google_linked"]);
  assert.deepEqual(xp.filter((x) => x.userId === fan.userId).map((x) => x.amount), [2000]);
  assert.ok((await items(fan)).includes("ad_searchparty"));
});

test("signing in again (the same link) and unlink + link another Google account: no second award; badge and ring stay", async () => {
  assert.equal((await link(fan, "sub-fan")).already, true);
  assert.equal(await SSO.removeLink("google", fan.userId), true);
  assert.deepEqual(await badges(fan), ["cf_google_linked"], "achievements are for keeps");
  assert.ok((await items(fan)).includes("ad_searchparty"));
  await link(fan, "sub-fan-2");
  assert.deepEqual(await feedFor(fan), ["cf_google_linked"], "announced once");
  assert.equal(xp.filter((x) => x.userId === fan.userId).length, 1);
});

test("unlock on Sign in with Google too (the shared flow's linkTo: \"I already have an account\" / a new account)", async () => {
  const s = await mkUser();
  await SSO.PROVIDERS.google.linkTo(s, { provider: "google", subject: "sub-signin", email: null, name: "Signin" });
  assert.deepEqual(await badges(s), ["cf_google_linked"]);
  assert.deepEqual(await feedFor(s), ["cf_google_linked"]);
  assert.ok((await items(s)).includes("ad_searchparty"));
});

test("a refused link (that Google account is linked to another PATV account) awards nothing", async () => {
  const x = await mkUser();
  await assert.rejects(() => link(x, "sub-signin"), (e) => e.code === "E_TAKEN");
  assert.deepEqual(await badges(x), []);
  assert.deepEqual(await feedFor(x), []);
});

test("the Search Party ring equips and renders as a four-colour conic ring", async () => {
  const it = (await COS.inventory(fan.userId)).items.find((i) => i.item_id === "ad_searchparty");
  assert.equal(it.source, "achievement");
  assert.equal((await COS.equip(fan.userId, it.inv_id, true)).ok, true);
  const p = await COS.profileData(fan.username);
  const deco = p.equipped.avatar_decoration && p.equipped.avatar_decoration.r;
  assert.ok(deco, "equipped");
  assert.match(deco.conic, /^background: conic-gradient\(from -45deg, #4285f4 0 25%, #ea4335 0 50%, #fbbc05 0 75%, #34a853 0 100%\);$/);
  assert.equal(deco.spin, false);
  assert.equal(deco.emoji, "🔍");
});
