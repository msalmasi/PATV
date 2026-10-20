// Offline tests for the 🍏 Core Member achievement (cf_apple_linked) for linking an Apple Account - from Settings -> Account
// -> Connections or by Sign in with Apple ("I already have an account" / a new account) - and the Brushed Metal profile border
// it unlocks for good. Accounts linked before it existed get it quietly (badge + cosmetic, no XP / PAT / announcement).
// Nothing leaves the process.
//   NODE_PATH=G:/PATV/node_modules node --test test/apple-achievements.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "appleach-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");

const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const SSO = require(path.join(repo, "ssolinks"));
require(path.join(repo, "applesso"));           // registers the shared flow's Apple provider (linkTo)
const COS = require(path.join(repo, "cosmetics"));
let A;                                         // required once the badge tables + the old links exist (it seeds on load)

const xp = [];
let n = 0;
async function mkUser(name) {
  const id = "a" + (++n);
  const username = name || "afan" + n;
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance) VALUES (?, ?, ?, 'x', 'pleb', 0)", [id, username, username]);
  return { userId: id, username };
}
const badges = async (u) => (await getQuery("SELECT badgeId FROM user_badges WHERE userId = ? AND badgeId = 'cf_apple_linked'", [u.userId])).map((r) => r.badgeId);
const items = async (u) => (await COS.inventory(u.userId)).items.map((i) => i.item_id);
const feedFor = async (u) => (await getQuery("SELECT badgeId FROM achievement_feed WHERE userId = ? ORDER BY id", [u.userId])).map((r) => r.badgeId);
const link = (u, sub) => SSO.addLink("apple", u.userId, { subject: sub, proof: "oidc", email: u.username + "@privaterelay.appleid.com", name: u.username, relay: true });

let old, google;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, extra_daily_spins INTEGER DEFAULT 0,
                  discordId TEXT, twitchId TEXT, camfrogUsername TEXT, email TEXT, isEmailVerified INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS badges (badgeId TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, icon TEXT,
                  points INTEGER DEFAULT 0, requirement TEXT NOT NULL, createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS user_badges (userId TEXT NOT NULL, badgeId TEXT NOT NULL, awardedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (userId, badgeId))`);
  await SSO.init();
  // linked BEFORE the achievement existed (and a Google-only account, which must not get the Apple one)
  old = await mkUser("earlyapple");
  await runQuery("INSERT INTO sso_links (provider, subject, user_id, link_source, proof, email, name, linked_at) VALUES ('apple', 'sub-old', ?, 'self', 'oidc', NULL, NULL, 1)", [old.userId]);
  google = await mkUser("googleonly");
  await runQuery("INSERT INTO sso_links (provider, subject, user_id, link_source, proof, email, name, linked_at) VALUES ('google', 'g-sub-old', ?, 'self', 'oidc', NULL, NULL, 1)", [google.userId]);
  A = require(path.join(repo, "achievements"));
  A.setUpdateLevel(async (userId, amount) => { xp.push({ userId, amount }); return null; });
  await A.ready;
  await COS.ready;
});

test("catalog: 🍏 Core Member (web side, 2,000 XP / 25,000 PAT like the other link badges) with badge art, unlocking the Brushed Metal border", () => {
  const a = A.list().find((x) => x.id === "cf_apple_linked");
  assert.deepEqual([a.name, a.emoji, a.metric, a.threshold, a.xp, a.pat, a.tier, a.side], ["Core Member", "🍏", "apple_linked", 1, 2000, 25000, "common", "web"]);
  const art = path.join(repo, a.icon.replace(/^\//, ""));
  assert.ok(fs.existsSync(art), "badge art: " + a.icon);
  const png = fs.readFileSync(art);
  assert.equal(png.slice(1, 4).toString(), "PNG");
  assert.equal(png[25], 6, "RGBA (a transparent background)");
  const cat = JSON.parse(fs.readFileSync(path.join(repo, "cosmetics.json"), "utf8")).items;
  const pb = cat.find((i) => i.id === "pb_brushedmetal");
  assert.deepEqual([pb.kind, pb.unlock, pb.perk, pb.price, pb.source], ["profile_border", { achievement: "cf_apple_linked" }, undefined, 0, ["achievement"]]);
  // a slot the 📨 Telegram (name colour) and 🍀 Google (avatar ring) unlocks don't use, and it's not for sale
  assert.equal(cat.filter((i) => i.unlock && i.unlock.achievement === "cf_apple_linked").length, 1);
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  assert.equal(en["ach.n.cf_apple_linked"], a.name);
  assert.equal(en["ach.d.cf_apple_linked"], a.desc);
  assert.match(en["settings.connections.apple_ach"], /Core Member \{!link\}/);
  assert.ok(en["settings.connections.apple_ach_link"]);
  // listed under "Getting started" on /achievements
  assert.match(fs.readFileSync(path.join(repo, "views", "achievements.ejs"), "utf8"), /\['start', [^\]]*"cf_apple_"/);
});

test("backfill: an account linked before gets it QUIETLY (badge + Brushed Metal, no XP / PAT / announcement), once; Google-only accounts don't", async () => {
  await A.appleBackfill();
  assert.deepEqual(await badges(old), ["cf_apple_linked"]);
  assert.ok((await items(old)).includes("pb_brushedmetal"));
  assert.deepEqual(await feedFor(old), [], "no announcement");
  assert.equal(xp.length, 0, "no XP");
  assert.deepEqual(await badges(google), []);
  const meta = await getQuery("SELECT v FROM achievement_meta WHERE k = 'apple_backfill'");
  assert.deepEqual([JSON.parse(meta[0].v).users, JSON.parse(meta[0].v).given], [1, 1]);
  assert.equal((await A.appleBackfill()).done, true);
  await A.checkWeb(old.userId);
  assert.deepEqual(await feedFor(old), [], "an unrelated website check afterwards doesn't announce it either");
});

let fan;
test("unlock on link (Settings -> Account -> Connections): 🍏 with XP, queued for Pepe to announce, + Brushed Metal", async () => {
  fan = await mkUser();
  assert.deepEqual(await badges(fan), []);
  assert.equal((await link(fan, "sub-fan")).already, false);
  assert.deepEqual(await badges(fan), ["cf_apple_linked"]);
  assert.deepEqual(await feedFor(fan), ["cf_apple_linked"]);
  assert.deepEqual(xp.filter((x) => x.userId === fan.userId).map((x) => x.amount), [2000]);
  assert.ok((await items(fan)).includes("pb_brushedmetal"));
});

test("signing in again (the same link) and unlink + link another Apple Account: no second award; badge and border stay", async () => {
  assert.equal((await link(fan, "sub-fan")).already, true);
  assert.equal(await SSO.removeLink("apple", fan.userId), true);
  assert.deepEqual(await badges(fan), ["cf_apple_linked"], "achievements are for keeps");
  assert.ok((await items(fan)).includes("pb_brushedmetal"));
  await link(fan, "sub-fan-2");
  assert.deepEqual(await feedFor(fan), ["cf_apple_linked"], "announced once");
  assert.equal(xp.filter((x) => x.userId === fan.userId).length, 1);
});

test("unlock on Sign in with Apple too (the shared flow's linkTo: \"I already have an account\" / a new account)", async () => {
  const s = await mkUser();
  await SSO.PROVIDERS.apple.linkTo(s, { provider: "apple", subject: "sub-signin", contact: null, name: "Signin", relay: false });
  assert.deepEqual(await badges(s), ["cf_apple_linked"]);
  assert.deepEqual(await feedFor(s), ["cf_apple_linked"]);
  assert.ok((await items(s)).includes("pb_brushedmetal"));
  // linking Google doesn't give the Apple one (and vice versa)
  const g = await mkUser();
  await SSO.addLink("google", g.userId, { subject: "g-new", proof: "oidc" });
  assert.deepEqual(await badges(g), []);
});

test("one Apple Account earns it ONCE: unlinked and linked to another PATV account (or a fresh sign-up) - no second 🍏, XP or PAT; Google the same", async () => {
  const a = await mkUser(), b = await mkUser();
  await link(a, "sub-farm");
  assert.deepEqual(await badges(a), ["cf_apple_linked"]);
  assert.equal(await SSO.removeLink("apple", a.userId), true);
  assert.equal((await link(b, "sub-farm")).already, false, "the link itself is fine");
  assert.deepEqual(await badges(b), [], "but it earns nothing on the second account");
  assert.deepEqual(await feedFor(b), []);
  assert.equal(xp.filter((x) => x.userId === b.userId).length, 0);
  await A.checkWeb(b.userId);
  assert.deepEqual(await badges(b), [], "nor on a later website check");
  assert.equal((await SSO.linkOf("apple", b.userId)).rewarded, 0);
  // the record outlives the link (and the account): a hash, never the Apple id
  const rows = await getQuery("SELECT * FROM sso_rewarded WHERE k = ?", [SSO.rewardKey("apple", "sub-farm")]);
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes("sub-farm"));
  // back on the first account: it already holds it - nothing new either
  await SSO.removeLink("apple", b.userId);
  await link(a, "sub-farm");
  assert.deepEqual(await feedFor(a), ["cf_apple_linked"]);
  // 🍀 Google: the same rule (the shared addLink)
  const g1 = await mkUser(), g2 = await mkUser();
  const gBadge = async (u) => (await getQuery("SELECT badgeId FROM user_badges WHERE userId = ? AND badgeId = 'cf_google_linked'", [u.userId])).length;
  await SSO.addLink("google", g1.userId, { subject: "g-farm", proof: "oidc" });
  assert.equal(await gBadge(g1), 1);
  await SSO.removeLink("google", g1.userId);
  await SSO.addLink("google", g2.userId, { subject: "g-farm", proof: "oidc" });
  assert.equal(await gBadge(g2), 0);
});

test("a refused link (that Apple Account is linked to another PATV account) awards nothing", async () => {
  const x = await mkUser();
  await assert.rejects(() => link(x, "sub-signin"), (e) => e.code === "E_TAKEN");
  assert.deepEqual(await badges(x), []);
  assert.deepEqual(await feedFor(x), []);
});

test("the Brushed Metal border equips and renders as a static silver frame", async () => {
  const it = (await COS.inventory(fan.userId)).items.find((i) => i.item_id === "pb_brushedmetal");
  assert.equal(it.source, "achievement");
  assert.equal((await COS.equip(fan.userId, it.inv_id, true)).ok, true);
  const p = await COS.profileData(fan.username);
  const fr = p.equipped.profile_border && p.equipped.profile_border.r;
  assert.ok(fr, "equipped");
  assert.match(fr.css, /^border: 3px solid #c7c7cc;/);
  assert.equal(fr.cls, "", "no pulse / hue animation");
  assert.ok(!/[<>"{}]/.test(fr.css), "the catalog CSS survives the sanitizer intact");
});
