// Offline tests for 1.99jv: the 📼 Plex achievements (Tuned In / Front Row / Be Kind, Rewind) and the cosmetics they
// unlock for good (VHS Reels avatar ring, Now Playing banner). Plex is a stub; nothing leaves the process.
//   NODE_PATH=G:/PATV/node_modules node --test test/plex-achievements.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plexach-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;
delete process.env.WIZARR_URL;
delete process.env.OVERSEERR_URL;
process.env.SECRET_KEY = "test-secret";
process.env.MEDIACTL_URL = "http://127.0.0.1:1";
process.env.MEDIACTL_SECRET = "s".repeat(40);

const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const conf = require(path.join(repo, "mediaconf"));
const PM = require(path.join(repo, "plexmembers"));
let A;                                   // required once the badge tables exist (it seeds them on load)
const COS = require(path.join(repo, "cosmetics"));

const DAY = 24 * 3600 * 1000;
let T = Date.UTC(2026, 9, 10, 12);
PM._setClock(() => T);

let n = 0;
async function mkUser(name) {
  const id = "u" + (++n);
  const username = name || "plexfan" + n;
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance) VALUES (?, ?, ?, 'x', 'pleb', 0)", [id, username, username]);
  return { userId: id, username };
}
const badges = async (u) => (await getQuery("SELECT badgeId FROM user_badges WHERE userId = ? AND badgeId LIKE 'cf_plex_%' ORDER BY badgeId", [u.userId])).map((r) => r.badgeId);
const items = async (u) => (await COS.inventory(u.userId)).items.map((i) => i.item_id).sort();
const feedFor = async (u) => (await getQuery("SELECT badgeId FROM achievement_feed WHERE userId = ? ORDER BY id", [u.userId])).map((r) => r.badgeId);
const share = (plexId, username, acceptedDaysAgo) => ({ share_id: "s" + plexId, plex_id: String(plexId), username, title: "", email: null,
  invited_at: Math.floor((T - acceptedDaysAgo * DAY) / 1000), accepted_at: Math.floor((T - acceptedDaysAgo * DAY) / 1000), pending: false });

let SHARES = [];
let OWNER = null;
PM._set({
  fetchShares: async () => ({ shares: SHARES.map((s) => ({ ...s })), owner: OWNER ? { ...OWNER } : null }),
  wizarrRedemptions: async () => [],
  overseerrUsers: async () => [],
  removeShare: async () => ({ ok: true }),
});
const xp = [];

let old, owner;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, extra_daily_spins INTEGER DEFAULT 0,
                  discordId TEXT, camfrogUsername TEXT, email TEXT, isEmailVerified INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS badges (badgeId TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, icon TEXT,
                  points INTEGER DEFAULT 0, requirement TEXT NOT NULL, createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS user_badges (userId TEXT NOT NULL, badgeId TEXT NOT NULL, awardedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (userId, badgeId))`);
  A = require(path.join(repo, "achievements"));
  A.setUpdateLevel(async (userId, amount) => { xp.push({ userId, amount }); return null; });
  await A.ready;
  await COS.ready;
  await conf.init();
  // linked BEFORE these achievements existed: a member since 2023 and the server owner (pb)
  old = await mkUser("oldtimer");
  owner = await mkUser("pb");
  await runQuery(`CREATE TABLE IF NOT EXISTS plex_members (
        plex_id TEXT PRIMARY KEY, share_id TEXT, username TEXT, title TEXT, email_hash TEXT,
        on_server INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0, invited_at INTEGER, accepted_at INTEGER,
        user_id TEXT, link_source TEXT, link_lock INTEGER NOT NULL DEFAULT 0, linked_at INTEGER, linked_by TEXT,
        access TEXT, access_pinned INTEGER NOT NULL DEFAULT 0, expires INTEGER,
        first_seen INTEGER, last_seen INTEGER, last_synced INTEGER,
        revoke TEXT, revoke_at INTEGER, revoke_by TEXT, revoke_error TEXT)`);
  const acc = T - 900 * DAY;
  await runQuery(`INSERT INTO plex_members (plex_id, share_id, username, on_server, invited_at, accepted_at, user_id, link_source, access, first_seen)
                  VALUES ('500', 's500', 'oldtimer', 1, ?, ?, ?, 'email', 'pre-existing', ?)`, [acc, acc, old.userId, T]);
  await runQuery(`INSERT INTO plex_members (plex_id, share_id, username, on_server, user_id, link_source, link_lock, access, access_pinned, first_seen)
                  VALUES ('111', NULL, 'plantbaked', 1, ?, 'self', 1, 'owner', 1, ?)`, [owner.userId, T]);
  SHARES = [share(500, "oldtimer", 900)];
  OWNER = { plex_id: "111", username: "plantbaked", title: "" };
  await PM.init();
  await PM.achCheck();
});

test("catalog: three 📼 Plex achievements (web side) with badge art, and two cosmetics they unlock for good", () => {
  const list = A.list().filter((a) => a.id.startsWith("cf_plex_"));
  assert.deepEqual(list.map((a) => [a.id, a.name, a.metric, a.threshold, a.xp, a.pat, a.tier, a.side]), [
    ["cf_plex_linked", "Tuned In", "plex_linked", 1, 2000, 25000, "common", "web"],
    ["cf_plex_member", "Front Row", "plex_member", 1, 5000, 50000, "uncommon", "web"],
    ["cf_plex_90d", "Be Kind, Rewind", "plex_days", 90, 10000, 100000, "rare", "web"],
  ]);
  for (const a of list) assert.ok(fs.existsSync(path.join(repo, a.icon.replace(/^\//, ""))), "badge art: " + a.icon);
  const cat = JSON.parse(fs.readFileSync(path.join(repo, "cosmetics.json"), "utf8")).items;
  const vhs = cat.find((i) => i.id === "ad_vhs"), np = cat.find((i) => i.id === "bn_nowplaying");
  assert.deepEqual([vhs.kind, vhs.unlock, vhs.perk], ["avatar_decoration", { achievement: "cf_plex_linked" }, undefined]);
  assert.deepEqual([np.kind, np.unlock, np.perk], ["profile_banner", { achievement: "cf_plex_member" }, undefined]);
});

test("backfill: accounts linked before the achievements get them QUIETLY (badge + cosmetics, no XP / PAT / announcement), once", async () => {
  assert.deepEqual(await badges(old), ["cf_plex_90d", "cf_plex_linked", "cf_plex_member"]);
  assert.deepEqual(await badges(owner), ["cf_plex_90d", "cf_plex_linked", "cf_plex_member"], "the owner counts from the oldest share");
  assert.deepEqual(await feedFor(old), [], "no announcement");
  assert.deepEqual(await feedFor(owner), []);
  assert.equal(xp.length, 0, "no XP");
  for (const u of [old, owner]) {
    const it = await items(u);
    assert.ok(it.includes("ad_vhs") && it.includes("bn_nowplaying"), "unlocked cosmetics: " + it.join(","));
  }
  const meta = await getQuery("SELECT v FROM achievement_meta WHERE k = 'plex_backfill'");
  assert.equal(JSON.parse(meta[0].v).given, 6);
  const again = await A.plexBackfill();
  assert.equal(again.done, true);
});

let fan;
test("unlock on link: signing in with Plex links the account -> 📼 Tuned In (XP + announced) + VHS Reels; not on our server = no Front Row", async () => {
  fan = await mkUser();
  await PM.linkSelf(fan, { plex_id: "700", username: "fanplex" });
  assert.deepEqual(await badges(fan), ["cf_plex_linked"]);
  assert.deepEqual(await feedFor(fan), ["cf_plex_linked"], "queued for Pepe to announce");
  assert.deepEqual(xp.filter((x) => x.userId === fan.userId).map((x) => x.amount), [2000]);
  assert.ok((await items(fan)).includes("ad_vhs"));
  assert.ok(!(await items(fan)).includes("bn_nowplaying"));
  // a second sync / link changes nothing
  await PM.reload();
  assert.deepEqual(await feedFor(fan), ["cf_plex_linked"]);
});

test("unlock on membership: on our server (sync) -> 🍿 Front Row + Now Playing; 90 days in a row -> 📼 Be Kind, Rewind", async () => {
  SHARES.push(share(700, "fanplex", 0));
  await PM.sync({ actor: "test" });
  assert.deepEqual(await badges(fan), ["cf_plex_linked", "cf_plex_member"]);
  assert.ok((await items(fan)).includes("bn_nowplaying"));
  assert.deepEqual((await PM.achMetrics(fan.userId)), { plex_linked: 1, plex_member: 1, plex_days: 0 });
  T += 89 * DAY;
  await PM.sync({ actor: "test" });
  assert.ok(!(await badges(fan)).includes("cf_plex_90d"), "89 days isn't 3 months");
  T += 1 * DAY;
  await PM.sync({ actor: "test" });
  assert.deepEqual(await badges(fan), ["cf_plex_90d", "cf_plex_linked", "cf_plex_member"]);
  assert.deepEqual(await feedFor(fan), ["cf_plex_linked", "cf_plex_member", "cf_plex_90d"]);
});

test("an admin link of someone already on the server: Tuned In + Front Row together; a re-share starts the 90 days over", async () => {
  const b = await mkUser();
  SHARES.push(share(800, "boxset", 5));
  await PM.sync({ actor: "test" });
  assert.deepEqual(await badges(b), []);
  await PM.adminLink("800", b.username, "admin");
  assert.deepEqual(await badges(b), ["cf_plex_linked", "cf_plex_member"]);
  assert.equal((await PM.achMetrics(b.userId)).plex_days, 5);
  // removed and shared again: the new share's acceptance is day 0
  SHARES = SHARES.filter((s) => s.plex_id !== "800");
  await PM.sync({ actor: "test" });
  assert.equal((await PM.achMetrics(b.userId)).plex_member, 0);
  SHARES.push(share(800, "boxset", 0));
  await PM.sync({ actor: "test" });
  assert.equal((await PM.achMetrics(b.userId)).plex_days, 0);
});

test("the unlocked cosmetics render and STAY when Plex access ends (unlike the pb_plex / nc_plex perks)", async () => {
  const inv = (await COS.inventory(fan.userId)).items;
  const vhs = inv.find((i) => i.item_id === "ad_vhs"), np = inv.find((i) => i.item_id === "bn_nowplaying"), frame = inv.find((i) => i.item_id === "pb_plex");
  assert.equal(vhs.perk, null);
  assert.equal(vhs.source, "achievement");
  assert.equal((await COS.equip(fan.userId, vhs.inv_id, true)).ok, true);
  assert.equal((await COS.equip(fan.userId, np.inv_id, true)).ok, true);
  assert.equal((await COS.equip(fan.userId, frame.inv_id, true)).ok, true);
  let p = await COS.profileData(fan.username);
  const deco = p.equipped.avatar_decoration.r, ban = p.equipped.profile_banner.r;
  assert.equal(deco.emoji, "📼");
  assert.equal(deco.spin, true);
  assert.match(deco.conic, /^background: conic-gradient\(#1b1b1b, #e5a00d/);
  assert.match(ban.css, /^background: repeating-linear-gradient/);
  assert.match(ban.css, /#3d2a0c\);$/);
  assert.ok(p.equipped.profile_border, "the perk frame renders while a member");
  // access ends (the share goes away)
  SHARES = SHARES.filter((s) => s.plex_id !== "700");
  await PM.sync({ actor: "test" });
  assert.equal(PM.memberSync(fan.userId), null);
  p = await COS.profileData(fan.username);
  assert.equal(p.equipped.profile_border, undefined, "the perk frame is off");
  assert.ok(p.equipped.avatar_decoration && p.equipped.profile_banner, "the achievement cosmetics stay on");
  assert.deepEqual(await badges(fan), ["cf_plex_90d", "cf_plex_linked", "cf_plex_member"], "achievements are for keeps");
  // the subscriptions page mentions them, in English and translated
  const ejs = require("ejs");
  const i18n = require(path.join(repo, "i18n"));
  const locals = { user: fan.username, title: "Subscriptions", data: { grace_days: 3, subs: [], offers: [], premium: [] }, plex: await PM.mine(fan.userId),
                   invites: [], selflink: true, balance: 0, pin: null, libraryOpen: false, price: 0 };
  let html;
  html = await ejs.renderFile(path.join(repo, "views", "subscriptions.ejs"), locals);
  if (html) {
    assert.match(html, /Tuned In/);
    assert.match(html, /<a href="\/achievements">achievements<\/a>/);
    const t = i18n.tFor("de");
    const de = await ejs.renderFile(path.join(repo, "views", "subscriptions.ejs"), { ...locals, i18nT: t, t, i18nClient: (q) => i18n.clientJson("de", q) });
    assert.match(de, /<a href="\/achievements">Erfolge<\/a>/);
  }
});
