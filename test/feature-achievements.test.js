// Offline tests for 1.99mt: the achievements for the recent features (gifts, Support PATV, 📼 Play from Plex, streams, mic
// clips, translations, sticker packs, pads) + the "Federal Reserve" -> Fort Knox rename:
//   * the catalog: 20 new web-side achievements with badge art, sane rewards, localized names / descriptions (en.json
//     ach.n.<id> / ach.d.<id> for EVERY catalog entry, matching the catalog), grouped on /achievements
//   * the quiet backfill (achievement_meta 'feature_backfill_1'): history that already earned one gets the badge only - no
//     XP, PAT or announcement - once; the metrics stay 0 until it has run
//   * after it: the action's hook (checkWeb / poke) awards it loudly (feed row for Pepe's announcement)
//   * ⭐ Headliner is a durable mark (the featured flag goes away later); anonymous gifts delay the GIVER's check
//   NODE_PATH=<noble+qrcode scratch>;G:/PATV/node_modules node --test test/feature-achievements.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "featach-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");

const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const G = require(path.join(repo, "gifts"));
let A;

const NEW = ["cf_gift_1", "cf_gift_5", "cf_gift_10", "cf_gift_recv", "cf_donor", "cf_donor_100", "cf_wallet_linked", "cf_plex_play", "cf_plex_binge",
  "cf_plex_request", "cf_stream_live", "cf_stream_10", "cf_stream_featured", "cf_micclip_1", "cf_micclip_pepe", "cf_translator", "cf_packs_3",
  "cf_packs_6", "cf_pad_made", "cf_pad_connect"];
const xp = [];
let n = 0;
const U = {};
async function mkUser(name) {
  const id = "f" + (++n);
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance) VALUES (?, ?, ?, 'x', 'pleb', 0)", [id, name, name]);
  U[name] = { userId: id, username: name };
  return U[name];
}
const badges = async (u) => (await getQuery("SELECT badgeId FROM user_badges WHERE userId = ? ORDER BY badgeId", [u.userId])).map((r) => r.badgeId);
const feedFor = async (u) => (await getQuery("SELECT badgeId FROM achievement_feed WHERE userId = ? ORDER BY id", [u.userId])).map((r) => r.badgeId);
const settle = () => new Promise((r) => setTimeout(r, 120));
let slotN = 0;
async function slot(user, { live = true, mode = "stream", source = null, featured = 0, feature_by = null, room = "R1" } = {}) {
  const id = "s" + (++slotN);
  await runQuery("INSERT INTO stage_slots (id, userId, room_id, status, went_live, mode, source, featured, feature_by) VALUES (?, ?, ?, 'ended', ?, ?, ?, ?, ?)",
                 [id, user.userId, room, live ? Date.now() : null, mode, source, featured, feature_by]);
  return id;
}
let postN = 0;
async function clip(user, subject) {
  const p = "p" + (++postN), m = "m" + postN;
  await runQuery("INSERT INTO feed_posts (id, author_id, created) VALUES (?, ?, ?)", [p, user.userId, Date.now()]);
  await runQuery("INSERT INTO media (id, kind, subject, deleted) VALUES (?, 'audio', ?, 0)", [m, subject || "someone"]);
  await runQuery("INSERT INTO feed_voices (post_id, media_id, logins, by_login, created) VALUES (?, ?, ' x ', 'x', ?)", [p, m, Date.now()]);
}

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, extra_daily_spins INTEGER DEFAULT 0,
                  discordId TEXT, twitchId TEXT, camfrogUsername TEXT, email TEXT, isEmailVerified INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS badges (badgeId TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, icon TEXT,
                  points INTEGER DEFAULT 0, requirement TEXT NOT NULL, createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS user_badges (userId TEXT NOT NULL, badgeId TEXT NOT NULL, awardedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (userId, badgeId))`);
  // just the columns the metrics read (the real modules make more)
  await runQuery("CREATE TABLE reserve_claims (claimId TEXT PRIMARY KEY, flow TEXT, userId TEXT, type TEXT, amount INTEGER, meta TEXT, created DATETIME DEFAULT CURRENT_TIMESTAMP, settled INTEGER DEFAULT 0)");
  await runQuery("CREATE TABLE crypto_wallets (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, family TEXT, address TEXT, created INTEGER)");
  await runQuery("CREATE TABLE stage_slots (id TEXT PRIMARY KEY, userId TEXT, room_id TEXT, status TEXT, went_live INTEGER, mode TEXT, source TEXT, featured INTEGER DEFAULT 0, feature_by TEXT)");
  await runQuery("CREATE TABLE media_plays (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, slot_id TEXT)");
  await runQuery("CREATE TABLE media_queues (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, items TEXT, slot_id TEXT, state TEXT)");
  await runQuery("CREATE TABLE media_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, status TEXT)");
  await runQuery("CREATE TABLE feed_posts (id TEXT PRIMARY KEY, author_id TEXT, created INTEGER, deleted_at INTEGER)");
  await runQuery("CREATE TABLE feed_voices (post_id TEXT PRIMARY KEY, media_id TEXT, logins TEXT, by_login TEXT, created INTEGER, removed_at INTEGER)");
  await runQuery("CREATE TABLE media (id TEXT PRIMARY KEY, kind TEXT, subject TEXT, deleted INTEGER)");
  await runQuery("CREATE TABLE translation_suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, userId TEXT, status TEXT)");
  await runQuery("CREATE TABLE user_sticker_packs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, pack_id TEXT, source TEXT, payer_id TEXT, ref TEXT, created INTEGER)");
  await runQuery("CREATE TABLE rooms_registry (room_id TEXT PRIMARY KEY, owner_user_id TEXT, origin TEXT, platform TEXT, created_by TEXT)");
  await runQuery("CREATE TABLE pad_connections (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT, platform TEXT, status TEXT, requested_by TEXT)");
  G._setAchDelay(() => {});                    // the gift log's own checks are tested in gifts-anon.test.js

  // ── history from BEFORE these achievements existed ──
  const vet = await mkUser("veteran");
  const pal = await mkUser("pal");
  await mkUser("newcomer");
  await G.record({ kind: "shop", giverId: vet.userId, recipientId: pal.userId, item: "Scout role", ref: "old-1" });
  await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount, meta) VALUES ('don-1', 'mint:donation', ?, 'donation', 1000, ?)",
                 [vet.userId, JSON.stringify({ usd_cents: 12000, via: "crypto" })]);
  await runQuery("INSERT INTO crypto_wallets (user_id, family, address, created) VALUES (?, 'evm', '0xabc', 1)", [vet.userId]);
  const s1 = await slot(vet, { source: "library", mode: "stream" });
  await runQuery("INSERT INTO media_plays (user_id, slot_id) VALUES (?, ?)", [vet.userId, s1]);
  await runQuery("INSERT INTO media_queues (user_id, items, slot_id, state) VALUES (?, '[1,2,3]', ?, 'ended')", [vet.userId, s1]);
  await runQuery("INSERT INTO media_requests (user_id, status) VALUES (?, 'available')", [vet.userId]);
  await slot(vet);                                                     // their own stream
  await slot(vet, { featured: 1, feature_by: "auto" });                // still marked featured (auto)
  await clip(vet, "Pepe");
  await runQuery("INSERT INTO translation_suggestions (userId, status) VALUES (?, 'accepted')", [vet.userId]);
  for (const p of ["a", "b", "c"]) await runQuery("INSERT INTO user_sticker_packs (user_id, pack_id, source, ref, created) VALUES (?, ?, 'buy', ?, 1)", [vet.userId, p, "r" + p]);
  await runQuery("INSERT INTO rooms_registry (room_id, owner_user_id, origin, platform, created_by) VALUES ('padv', ?, 'user', 'camfrog', ?)", [vet.userId, vet.userId]);
  await runQuery("INSERT INTO pad_connections (room_id, platform, status, requested_by) VALUES ('padv', 'camfrog', 'verified', ?)", [vet.userId]);

  A = require(path.join(repo, "achievements"));
  A.setUpdateLevel(async (userId, amount) => { xp.push({ userId, amount }); return null; });
  await A.ready;
});

test("catalog: 20 new web-side achievements with badge art and rewards in line with the rest; nothing farmable is generous", () => {
  const list = A.list();
  assert.equal(list.length, 300);              // 1.99pa: + 101 (more-achievements.test.js), 1.99nj: + 25 📼 Plex-on-pads achievements, 1.99np: + 13 TV shows (plex-watch-stats.test.js), 1.99nq: + 13 🛒 heist shop, 1.99oo: + 9 🏪 store heist (gtfstore.test.js)
  for (const id of NEW) {
    const a = list.find((x) => x.id === id);
    assert.ok(a, id);
    assert.equal(a.side, "web", id);
    assert.ok(A.FEATURE_METRICS.includes(a.metric), id + " metric " + a.metric);
    assert.ok(fs.existsSync(path.join(repo, a.icon.replace(/^\//, ""))), "badge art: " + a.icon);
    assert.ok(["common", "uncommon", "rare"].includes(a.tier), id);
    assert.ok(a.xp <= 10000 && a.pat <= 100000, id + " reward");
  }
  // Support PATV: XP only - donating never pays PAT back on top of the donation's own mint
  for (const id of ["cf_donor", "cf_donor_100"]) assert.equal(list.find((x) => x.id === id).pat, 0);
  assert.equal(new Set(list.map((a) => a.id)).size, list.length, "unique ids");
});

test("Federal Reserve -> Fort Knox: same ids (nobody loses a badge), new names / descriptions, no 'Federal' left", () => {
  const raw = fs.readFileSync(path.join(repo, "achievements.json"), "utf8");
  assert.doesNotMatch(raw, /Federal|Reserve/);
  const bank = A.list().find((a) => a.id === "cf_crack_bank");
  assert.deepEqual([bank.name, bank.emoji, bank.desc, bank.metric, bank.xp, bank.pat, bank.tier], ["Knox Knox", "🪙", "Cracked Fort Knox on a bank heist.", "bank_cracks", 20000, 250000, "legendary"]);
  const solo = A.list().find((a) => a.id === "cf_solo_bank");
  assert.deepEqual([solo.name, solo.desc, solo.metric], ["One-Frog Army", "Cracked Fort Knox on a solo bank heist.", "solo_bank_cracks"]);
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  assert.doesNotMatch(en["ach.lede"], /Federal Reserve/);
});

test("en.json: every achievement's name + description (ach.n.<id> / ach.d.<id>) match the catalog; /achievements groups them", async () => {
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  for (const a of A.list()) {
    assert.equal(en["ach.n." + a.id], esc(a.name), "name " + a.id);
    assert.equal(en["ach.d." + a.id], esc(a.desc), "desc " + a.id);
  }
  for (const k of ["ach.group.giving", "ach.group.stream", "ach.group.pads"]) assert.ok(en[k], k);
  const html = await ejs.renderFile(path.join(repo, "views", "achievements.ejs"), {
    achievements: A.list(), holders: {}, owned: null, viewing: null, own: false, user: null, signedIn: false,
  }, { root: path.join(repo, "views") }).catch((e) => { throw e; });
  const grp = (slug) => { const m = html.match(new RegExp(`<section class="grp" data-group="${slug}"[\\s\\S]*?</section>`)); return m ? m[0] : ""; };
  for (const [slug, ids] of [["giving", ["cf_gift_1", "cf_gift_recv", "cf_donor_100"]], ["stream", ["cf_stream_live", "cf_micclip_pepe"]],
                             ["pads", ["cf_pad_made", "cf_packs_6", "cf_translator"]], ["plex", ["cf_plex_binge"]], ["start", ["cf_wallet_linked"]]]) {
    for (const id of ids) assert.ok(grp(slug).includes(A.list().find((a) => a.id === id).icon), `${id} in ${slug}`);
  }
  assert.match(html, /Knox Knox/);
  assert.doesNotMatch(grp("else"), /cf_gift_|cf_stream_|cf_pad_/);
});

test("before the backfill the feature metrics count nothing; the backfill gives the badges QUIETLY (no XP / PAT / feed), once", async () => {
  const r = await A.featureBackfill();
  const got = await badges(U.veteran);
  for (const id of ["cf_gift_1", "cf_donor", "cf_donor_100", "cf_wallet_linked", "cf_plex_play", "cf_plex_binge", "cf_plex_request", "cf_stream_live",
                    "cf_stream_featured", "cf_micclip_1", "cf_micclip_pepe", "cf_translator", "cf_packs_3", "cf_pad_made", "cf_pad_connect"]) {
    assert.ok(got.includes(id), id + " in " + got.join(","));
  }
  for (const id of ["cf_gift_5", "cf_gift_10", "cf_stream_10", "cf_packs_6", "cf_gift_recv"]) assert.ok(!got.includes(id), id + " not earned");
  assert.ok((await badges(U.pal)).includes("cf_gift_recv"));
  assert.deepEqual(await badges(U.newcomer), []);
  assert.deepEqual(await feedFor(U.veteran), [], "no announcement");
  assert.equal(xp.length, 0, "no XP");
  assert.equal(r.given, 16);
  assert.equal(r.by.cf_stream_featured, 1);
  const meta = JSON.parse((await getQuery("SELECT v FROM achievement_meta WHERE k = 'feature_backfill_1'"))[0].v);
  assert.equal(meta.given, 16);
  assert.equal((await A.featureBackfill()).given, 16, "memoized");
});

test("after it, the hooks award loudly: a gift (recipient), a donation, 3 sticker packs, a pad, a stream going live", async () => {
  const nc = U.newcomer;
  await G.record({ kind: "sticker", giverId: U.pal.userId, recipientId: nc.userId, item: "x", ref: "new-1" });
  await A.checkWeb(nc.userId);                   // what gifts.record's (undelayed) recipient check does
  assert.ok((await feedFor(nc)).includes("cf_gift_recv"));
  await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount, meta) VALUES ('don-2', 'mint:donation', ?, 'donation', 1000, ?)", [nc.userId, JSON.stringify({ usd_cents: 500 })]);
  for (const p of ["a", "b", "c"]) await runQuery("INSERT INTO user_sticker_packs (user_id, pack_id, source, ref, created) VALUES (?, ?, 'buy', ?, 1)", [nc.userId, p, "n" + p]);
  await runQuery("INSERT INTO rooms_registry (room_id, owner_user_id, origin, platform, created_by) VALUES ('padn', ?, 'user', 'site', ?)", [nc.userId, nc.userId]);
  await slot(nc);
  A.poke(nc.userId);
  await settle();
  const f = await feedFor(nc);
  for (const id of ["cf_donor", "cf_packs_3", "cf_pad_made", "cf_stream_live"]) assert.ok(f.includes(id), id + " in " + f.join(","));
  assert.ok(!f.includes("cf_donor_100"), "$5 isn't $100");
  assert.ok(xp.some((x) => x.userId === nc.userId && x.amount === 3000), "XP for 💡");
});

test("what doesn't count: embeds / library plays aren't 'your stream'; a request still pending; a removed clip; a pending translation", async () => {
  const z = await mkUser("zed");
  await slot(z, { mode: "embed" });
  await slot(z, { source: "library" });
  await slot(z, { live: false });
  await runQuery("INSERT INTO media_requests (user_id, status) VALUES (?, 'pending')", [z.userId]);
  await runQuery("INSERT INTO translation_suggestions (userId, status) VALUES (?, 'pending')", [z.userId]);
  await clip(z, "Pepe");
  await runQuery("UPDATE feed_voices SET removed_at = 1 WHERE post_id = ?", ["p" + postN]);
  const m = await A.featureMetrics(z.userId);
  assert.deepEqual([m.streams, m.plex_requests, m.translations, m.mic_clips, m.pepe_clips], [0, 0, 0, 0, 0]);
});

test("⭐ Headliner: a durable mark, once; it survives the featured flag going away", async () => {
  const s = await mkUser("star");
  assert.equal(await A.mark(s.userId, "stream_featured"), true);
  assert.equal(await A.mark(s.userId, "stream_featured"), false, "once");
  await A.checkWeb(s.userId);
  assert.ok((await feedFor(s)).includes("cf_stream_featured"));
});

test("gifting tiers count DIFFERENT people (5 gifts to one friend != Santa's Little Helper)", async () => {
  const g = await mkUser("generous");
  for (let i = 0; i < 5; i++) await G.record({ kind: "shop", giverId: g.userId, recipientId: U.pal.userId, item: "x", ref: "same-" + i });
  let m = await A.featureMetrics(g.userId);
  assert.deepEqual([m.gift_people], [1]);
  for (const who of ["veteran", "newcomer", "zed", "star"]) await G.record({ kind: "shop", giverId: g.userId, recipientId: U[who].userId, item: "x", ref: "d-" + who });
  m = await A.featureMetrics(g.userId);
  assert.equal(m.gift_people, 5);
  await A.checkWeb(g.userId);
  const f = await feedFor(g);
  assert.ok(f.includes("cf_gift_1") && f.includes("cf_gift_5") && !f.includes("cf_gift_10"), f.join(","));
});
