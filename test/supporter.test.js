// 1.99mv: 💚 Supporter perks (supporter.js) - any confirmed donation (card or crypto: a "mint:donation" claim) makes the
// account a Supporter: the automatic flair with a tier look by lifetime total (🥉 any / 🥈 $25+ / 🥇 $100+), the 💡 Supporter
// achievement (+ 🌟 Gold Supporter at $100), which unlock the Supporter Gold name colour + Supporter Halo for good, quietly
// backfilled for past donors; and the perks block on /support.
//   NODE_PATH=<scratch with @noble/curves, @noble/hashes, qrcode-generator>;G:/PATV/node_modules node --test test/supporter.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "supporter-")));
delete process.env.STAGING;
for (const k of ["CRYPTO_RPC_ETH", "CRYPTO_RPC_BASE", "CRYPTO_RPC_SOL", "STRIPE_ENABLED"]) delete process.env[k];
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const CP = require(path.join(repo, "cryptopay"));
const F = require(path.join(repo, "funding"));
const SUP = require(path.join(repo, "supporter"));
const COS = require(path.join(repo, "cosmetics"));
let A;

const USERS = {};
let server, base;
const xp = [];
async function donate(id, user, cents) {
  await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount, meta) VALUES (?, 'mint:donation', ?, 'donation', ?, ?)",
                 [id, user, cents * 5000, JSON.stringify({ usd_cents: cents })]);
}
const badges = async (u) => (await getQuery("SELECT badgeId FROM user_badges WHERE userId = ? AND badgeId LIKE 'cf_donor%' ORDER BY badgeId", [u])).map((r) => r.badgeId);
const items = async (u) => (await COS.inventory(u)).items.map((i) => i.item_id).filter((x) => /supporter/.test(x)).sort();
const feedFor = async (u) => (await getQuery("SELECT badgeId FROM achievement_feed WHERE userId = ? ORDER BY id", [u])).map((r) => r.badgeId);

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT,
                  points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, camfrogUsername TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery(`CREATE TABLE IF NOT EXISTS badges (badgeId TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, icon TEXT,
                  points INTEGER DEFAULT 0, requirement TEXT NOT NULL, createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS user_badges (userId TEXT NOT NULL, badgeId TEXT NOT NULL, awardedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (userId, badgeId))`);
  for (const n of ["alice", "bob", "carol", "dave", "boss"]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class) VALUES (?, ?, ?, 'x', ?)", ["u-" + n, n, n, n === "boss" ? "Admin" : "pleb"]);
    USERS[n] = { userId: "u-" + n, username: n, class: n === "boss" ? "Admin" : "pleb" };
  }
  await CP.init();
  await CP.set({ crypto_donations_enabled: true, chain_eth: true, chain_base: true, chain_sol: true }, "test");
  await F.init();
  // donors from BEFORE the perks existed
  await donate("don-1", "u-alice", 2500);                                     // $25 -> silver
  await donate("cdon-2", "u-bob", 500);                                       // $5 -> bronze
  await donate("don-3", "u-carol", 6000); await donate("cdon-4", "u-carol", 4000);   // $100 -> gold
  A = require(path.join(repo, "achievements"));
  A.setUpdateLevel(async (userId, amount) => { xp.push({ userId, amount }); return null; });
  await A.ready;
  await COS.ready;
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  app.use(express.json());
  const addUser = (rq, rs, next) => { const u = rq.get("x-test-user"); rq.user = u ? USERS[u] || null : null; next(); };
  require(path.join(repo, "cryptoweb")).register(app, { addUser, noTimers: true });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { CP.stop(); server && server.close(); });

test("tiers by lifetime total: bronze any, silver $25+, gold $100+; the flair is automatic and never stored", async () => {
  await SUP.init();
  assert.deepEqual(["u-alice", "u-bob", "u-carol", "u-dave"].map((u) => (SUP.supporterSync(u) || {}).tier || null), ["silver", "bronze", "gold", null]);
  assert.equal(SUP.supporterSync("u-carol").usd, 100);
  assert.equal(SUP.supporterByName("CAROL").tier, "gold");
  const f = SUP.flair(SUP.supporterSync("u-carol"));
  assert.deepEqual([f.name, f.emoji, f.auto, f.id], ["Supporter", "🥇", "supporter", 0]);
  assert.equal(SUP.flair(null), null);
  const html = require(path.join(repo, "padflair")).html(f);
  assert.match(html, /Supports PATV with donations/);
});

test("the quiet backfill gives past donors the badges + both cosmetics: no XP, PAT or announcement", async () => {
  await A.featureBackfill();
  assert.deepEqual(await badges("u-alice"), ["cf_donor"]);
  assert.deepEqual(await badges("u-carol"), ["cf_donor", "cf_donor_100"]);
  for (const u of ["u-alice", "u-bob", "u-carol"]) assert.deepEqual(await items(u), ["ad_supporter", "nc_supporter"], u);
  assert.deepEqual(await items("u-dave"), []);
  for (const u of ["u-alice", "u-carol"]) assert.deepEqual(await feedFor(u), []);
  assert.equal(xp.length, 0);
});

test("a new donation (Stripe or crypto hook -> onDonation): cache + tier now, the achievement announced, cosmetics granted", async () => {
  await donate("cdon-5", "u-dave", 3000);
  const v = await SUP.onDonation("u-dave");
  assert.equal(v.tier, "silver");
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(await badges("u-dave"), ["cf_donor"]);
  assert.deepEqual(await feedFor("u-dave"), ["cf_donor"], "Pepe announces it");
  assert.ok(xp.some((x) => x.userId === "u-dave" && x.amount === 3000));
  assert.deepEqual(await items("u-dave"), ["ad_supporter", "nc_supporter"]);
  // bob tops up past $100 -> gold + 🌟
  await donate("don-6", "u-bob", 9600);
  assert.equal((await SUP.onDonation("u-bob")).tier, "gold");
  await new Promise((r) => setTimeout(r, 200));
  assert.ok((await feedFor("u-bob")).includes("cf_donor_100"));
});

test("cosmetics: the two Supporter items are achievement unlocks (free, never sold), the catalog knows them", () => {
  for (const id of ["nc_supporter", "ad_supporter"]) {
    const it = COS.byId(id);
    assert.ok(it, id);
    assert.deepEqual([it.price, it.unlock, it.source], [0, { achievement: "cf_donor" }, ["achievement"]]);
  }
  assert.equal(COS.byId("nc_supporter").kind, "name_color");
  assert.equal(COS.byId("ad_supporter").kind, "avatar_decoration");
});

test("/support shows the perks: the three tiers, the halo + name, both badges; a supporter sees their tier", async () => {
  const anon = await (await fetch(base + "/support")).text();
  assert.match(anon, /id="perks"/);
  assert.match(anon, /What you get for supporting/);
  for (const w of ["Bronze", "Silver", "Gold"]) assert.ok(anon.includes(w), w);
  assert.match(anon, /class="perk-halo spin"/);
  assert.match(anon, /cf_donor\.png/);
  assert.match(anon, /cf_donor_100\.png/);
  assert.doesNotMatch(anon, /You're a Supporter/);
  const me = await (await fetch(base + "/support", { headers: { "x-test-user": "alice" } })).text();
  assert.match(me, /You(?:'|&#39;)re a Supporter: 🥈 Silver/);
});
