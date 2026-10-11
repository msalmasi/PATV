// Offline tests for 1.99pv: ⭐ PATV Creators (creators.js, creatorsweb.js) + the P0 safety pieces (imagesafety locked checks,
// TAKE IT DOWN takedown.js, the locked-never-NSFW rule).
//   * the explicit tier is hard-disabled (code + database trigger); eligibility; apply with tiers; 18+ needs the attestation
//   * locked posts: refusals before any charge (not a creator, NSFW, no title, media while the locked check is off), teasers,
//     what a non-payer / subscriber / buyer / author / staff / pad owner gets from decorate and /media/f (mediaGate)
//   * locked media: always enforcing + fail-closed; suggestive only in an 18+ community; explicit never
//   * money: purchases need the escrow live; subscribe / unlock = an escrow hold (kind CRS / CRP), idempotent by key, caps;
//     release after the hold (80% to the creator, the cut as reserve claims), the weekly cap; refunds (post deleted, explicit
//     takedown), disputes freeze; renewals, grace, lapse, cancel; Pepe's holds never include the service's
//   * 18+ communities: the gate until the viewer confirms their age
//   * TAKE IT DOWN: a request hides the post, removal deletes it and blocks an exact re-upload; an NCII report opens a case
//   * Pepe's bot API: quote / subscribe / subs / creator
//   NODE_PATH=G:/PATV/node_modules node --test test/creators.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "creators-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.PAD_DIR = path.join(tmp, "pad");
process.env.IMAGESAFETY_DIR = path.join(tmp, "isf");
const sharp = require("sharp");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const ISF = require(path.join(repo, "imagesafety"));
const CR = require(path.join(repo, "creators"));
const ESC = require(path.join(repo, "escrow", "ledger"));
const TD = require(path.join(repo, "takedown"));
require(path.join(repo, "terms"))._setRequired(false);

const DAY = 86400000;
let T = Date.UTC(2026, 9, 12, 12, 0, 0);       // a Monday noon UTC
const clock = () => T;
CR._setClock(clock); TD._setClock(clock);
const PLANT = "plant_based_chatting";
const U = {};
async function mkUser(name, { cls = "pleb", bal = 50000000, level = 9, camfrog = null, created = "2025-01-01 00:00:00", verified = 1 } = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned, isEmailVerified)
                  VALUES (?, ?, ?, 'x', ?, ?, ?, ?, ?, 0, ?)`, [id, name, name, cls, bal, camfrog, level, created, verified]);
  U[name] = { userId: id, username: name, class: cls };
  return U[name];
}
const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [u.userId]))[0].b;
const png = (w = 64, h = 64, c = { r: 200, g: 60, b: 90 }) => sharp({ create: { width: w, height: h, channels: 3, background: c } }).png().toBuffer();
let ANSWER = { verdict: "allow", scores: {} };
ISF.setClassifier(async () => (typeof ANSWER === "function" ? ANSWER() : ANSWER));
const CLEAN = { verdict: "allow", scores: { nudity_explicit: 0.01 }, reason: "a plant" };
const SUGGESTIVE = { verdict: "nsfw", scores: { suggestive: 0.85 }, reason: "lingerie" };
const EXPLICIT = { verdict: "nsfw", scores: { nudity_explicit: 0.95, sexual: 0.8 }, reason: "explicit" };
const fm = require(path.join(repo, "feedmedia"));
let nAtt = 0;
async function mkAtt(owner, color) {
  const id = "att" + String(++nAtt).padStart(9, "0");
  const file = require("crypto").createHash("md5").update(id).digest("hex") + ".webp";
  const p = fm.filePath(file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, await sharp(await png(80, 60, color || { r: 20 * nAtt % 255, g: 60, b: 90 })).webp().toBuffer());
  await runQuery(`INSERT INTO feed_attachments (id, owner_id, kind, ct, file, w, h, bytes, state, created, size_declared, received)
                  VALUES (?, ?, 'image', 'image/webp', ?, 80, 60, 10, 'ready', ?, 10, 10)`, [id, owner.userId, file, T]);
  return { id, file };
}
const prof = (u) => "u/" + u.username;
const view = async (id, viewer) => store.get(id, viewer);

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT, isEmailVerified INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT, note TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, created DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery(`CREATE TABLE IF NOT EXISTS reserve_claims (claimId TEXT PRIMARY KEY, flow TEXT NOT NULL, userId TEXT, type TEXT, amount INTEGER NOT NULL,
                  created DATETIME DEFAULT CURRENT_TIMESTAMP, settled INTEGER DEFAULT 0)`);
  await mkUser("maker", { camfrog: "makercf" });            // the creator
  await mkUser("fan");
  await mkUser("fan2");
  await mkUser("poor", { bal: 100 });
  await mkUser("newbie", { level: 1, created: "2026-10-10 00:00:00", verified: 0 });
  await mkUser("boss", { cls: "Admin" });
  await mkUser("plantowner", { camfrog: "foamy1111" });
  await rooms.init();
  await rooms.setOwner(PLANT, "plantowner", "test");
  await store.init();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, new_account_posts_per_day: 100 }, "test");
  await require(path.join(repo, "funding")).init();
  await ISF.init();
  await ISF.setConfig({ ...ISF.DEFAULTS, locked_enforce: false, timeout_secs: 1 }, "test");
  await require(path.join(repo, "inbox")).ready;
  await CR.init();
  await CR.setConfig({ enabled: true }, "test");
  await ESC.init();
});

test("the explicit tier is hard-disabled: a constant, a refusal and a database trigger", async () => {
  assert.equal(CR.EXPLICIT_TIER_ENABLED, false);
  assert.throws(() => CR.assertRating("explicit"), (e) => e.code === "E_EXPLICIT_DISABLED");
  assert.equal(CR.assertRating("r18"), "r18");
  await runQuery("INSERT INTO creators (user_id, status, rating, created, updated) VALUES ('x1', 'active', 'sfw', 1, 1)");
  await assert.rejects(runQuery("UPDATE creators SET rating = 'explicit' WHERE user_id = 'x1'"), /E_EXPLICIT_DISABLED/);
  await assert.rejects(runQuery("INSERT INTO creators (user_id, status, rating, created, updated) VALUES ('x2', 'active', 'explicit', 1, 1)"), /E_EXPLICIT_DISABLED/);
  await runQuery("DELETE FROM creators WHERE user_id = 'x1'");
  await assert.rejects(CR.apply(U.maker, { terms: true, rating: "explicit", plans: [{ name: "a", price: 20000 }] }), (e) => e.code === "E_EXPLICIT_DISABLED");
  const r = await CR.readiness();
  assert.equal(r.enabled, false);
  assert.ok(r.gates.length >= 12 && r.gates.every((g) => g.status === "todo"));
  await assert.rejects(CR.setGate(U.fan, "legal", { status: "done" }), /Admins only/);
  await CR.setGate(U.boss, "legal", { status: "in_progress", owner: "counsel", evidence: "email 2026-10-11" });
  assert.equal((await CR.readiness()).gates.find((g) => g.key === "legal").status, "in_progress");
  assert.equal((await CR.readiness()).enabled, false, "a checklist can't enable the tier");
});

test("eligibility (D6) and applying: terms, tiers in bounds and ascending, 18+ needs every attestation box", async () => {
  const e = await CR.eligibility(U.newbie.userId);
  assert.equal(e.ok, false);
  assert.deepEqual(e.checks.filter((c) => !c.ok).map((c) => c.key).sort(), ["age", "email", "identity", "level"]);
  await assert.rejects(CR.apply(U.newbie, { terms: true, plans: [{ name: "a", price: 20000 }] }), (x) => x.code === "E_NOT_ELIGIBLE");
  assert.equal((await CR.eligibility(U.maker.userId)).ok, true);
  await assert.rejects(CR.apply(U.maker, { plans: [{ name: "a", price: 20000 }] }), (x) => x.code === "E_TERMS");
  await assert.rejects(CR.apply(U.maker, { terms: true, plans: [{ name: "a", price: 500 }] }), (x) => x.code === "E_PRICE");
  await assert.rejects(CR.apply(U.maker, { terms: true, plans: [{ name: "a", price: 50000 }, { name: "b", price: 20000 }] }), (x) => x.code === "E_PRICE");
  await assert.rejects(CR.apply(U.maker, { terms: true, rating: "r18", attest: { adult: true }, plans: [{ name: "a", price: 20000 }] }), (x) => x.code === "E_ATTEST");
  const r = await CR.apply(U.maker, { terms: true, rating: "sfw", plans: [{ name: "Supporter", price: "20k" }, { name: "Super", price: 100000, ppv_discount: 20 }] });
  assert.equal(r.status, "active");
  assert.ok(CR.isActiveCreator(U.maker.userId));
  assert.deepEqual((await CR.plansOf(U.maker.userId)).map((p) => [p.tier, p.price]), [[1, 20000], [2, 100000]]);
});

test("locked posts: refusals come before anything is charged; a text lock works; a non-creator can't lock", async () => {
  await assert.rejects(store.create(U.fan.userId, { title: "x", body: "y", community: prof(U.fan), lock: { kind: "sub" } }), (e) => e.code === "E_NOT_CREATOR");
  await assert.rejects(store.create(U.maker.userId, { title: "x", body: "y", nsfw: true, community: prof(U.maker), lock: { kind: "sub" } }), (e) => e.code === "E_LOCKED_NSFW");
  await assert.rejects(store.create(U.maker.userId, { body: "no title", community: prof(U.maker), lock: { kind: "sub" } }), (e) => e.code === "E_LOCK_TITLE");
  await assert.rejects(store.create(U.maker.userId, { title: "x", body: "y", community: PLANT, lock: { kind: "sub" } }), (e) => e.code === "E_LOCK_PAD");
  await assert.rejects(store.create(U.maker.userId, { title: "x", body: "y", community: prof(U.maker), lock: { kind: "ppv", price: 50 } }), (e) => e.code === "E_PRICE");
  const a = await mkAtt(U.maker);
  await assert.rejects(store.create(U.maker.userId, { title: "pic", community: prof(U.maker), attachments: [a.id], lock: { kind: "sub" } }), (e) => e.code === "E_SAFETY_OFF");
  assert.equal((await getQuery("SELECT post_id FROM feed_attachments WHERE id = ?", [a.id]))[0].post_id, null, "the file isn't used");
  const p = await store.create(U.maker.userId, { title: "Tier 2 diary", body: "the secret text", community: prof(U.maker), lock: { kind: "sub", tier: 2, teaser: "Behind the scenes" } });
  const row = await store.getRow(p.id);
  assert.deepEqual([row.lock_kind, row.lock_tier, row.lock_rating, row.nsfw], ["sub", 2, "sfw", 0]);
  // the hard rule in the database: a locked post can't be NSFW
  await assert.rejects(runQuery("UPDATE feed_posts SET nsfw = 1 WHERE id = ?", [p.id]), /E_LOCKED_NSFW/);
  await assert.rejects(runQuery("UPDATE feed_posts SET nsfw_admin = 1 WHERE id = ?", [p.id]), /E_LOCKED_NSFW/);
  await assert.rejects(store.edit(U.maker, p.id, { nsfw: true }), /can't be NSFW/);
  await assert.rejects(store.crosspost(U.maker.userId, p.id, { community: prof(U.maker) }).catch((e) => { throw e; }), /crossposted|already/);
});

test("locked media: enforcing + fail-closed, suggestive refused for a SFW creator, explicit always refused; teasers never the original", async () => {
  await ISF.setConfig({ locked_enforce: true }, "test");
  ANSWER = SUGGESTIVE;
  const a1 = await mkAtt(U.maker);
  await assert.rejects(store.create(U.maker.userId, { title: "beach", community: prof(U.maker), attachments: [a1.id], lock: { kind: "sub" } }), (e) => e.status === 422 && /safe for work/.test(e.message));
  ANSWER = () => new Promise(() => {});                 // Pepe never answers -> fail closed
  const a2 = await mkAtt(U.maker);
  await assert.rejects(store.create(U.maker.userId, { title: "slow", community: prof(U.maker), attachments: [a2.id], lock: { kind: "sub" } }), (e) => e.status === 422 && /couldn't be safety-checked/.test(e.message));
  const logs = await getQuery("SELECT action FROM image_safety_log WHERE surface = 'locked' ORDER BY id");
  assert.deepEqual(logs.map((l) => l.action), ["refuse", "failclosed"]);
  ANSWER = CLEAN;
  const a3 = await mkAtt(U.maker);
  const p = await store.create(U.maker.userId, { title: "Pay to see", body: "ppv words", community: prof(U.maker), attachments: [a3.id], lock: { kind: "ppv", price: 5000, tier: 2 } });
  const tz = await getQuery("SELECT * FROM feed_attachments WHERE post_id = ? AND kind = 'teaser'", [p.id]);
  assert.equal(tz.length, 1);
  assert.notEqual(tz[0].file, a3.file);
  assert.equal(tz[0].teaser_of, a3.id);
  const meta = await sharp(fm.filePath(tz[0].file)).metadata();
  assert.ok(meta.width <= 480, "a downscaled blur");
  // a non-payer: title + teaser text + the blurred teaser, never the body or the original
  const anon = await view(p.id, null);
  assert.equal(anon.title, "Pay to see");
  assert.equal(anon.body, "");
  assert.deepEqual(anon.images, []);
  assert.equal(anon.creator.gated, true);
  assert.equal(anon.creator.price, 5000);
  assert.deepEqual(anon.creator.teasers.map((x) => x.file), [tz[0].file]);
  assert.equal(anon.creator.counts.images, 1);
  // files: the original 404s for a non-payer, the teaser is served
  const att = async (file) => (await getQuery("SELECT a.*, p.author_id FROM feed_attachments a LEFT JOIN feed_posts p ON p.id = a.post_id WHERE a.file = ?", [file]))[0];
  assert.equal((await CR.mediaGate(null, await att(a3.file))).allow, false);
  assert.equal((await CR.mediaGate(U.fan, await att(a3.file))).allow, false);
  assert.equal((await CR.mediaGate(null, await att(tz[0].file))).allow, true);
  // the author and staff see everything
  assert.equal((await view(p.id, U.maker)).body, "ppv words");
  assert.equal((await view(p.id, U.boss)).images.length, 1);
  assert.equal((await CR.mediaGate(U.boss, await att(a3.file))).allow, true);
  test.ppvPost = p.id;
  test.ppvFile = a3.file;
});

test("purchases need the escrow live; subscribe = an escrow hold (CRS), idempotent, unlocks tier posts; Pepe's holds don't include it", async () => {
  await assert.rejects(CR.subscribe(U.fan, { creator: "maker", tier: 1, key: "key-subscribe-1" }), (e) => e.code === "E_ESCROW_NOT_LIVE");
  await ESC.setMeta("live", true); ESC._forgetLive();
  await assert.rejects(CR.subscribe(U.maker, { creator: "maker", tier: 1, key: "key-self-0001" }), (e) => e.code === "E_SELF");
  await assert.rejects(CR.subscribe(U.poor, { creator: "maker", tier: 1, key: "key-poor-0001" }), (e) => e.code === "E_INSUFFICIENT_PAT");
  await assert.rejects(CR.subscribe(U.fan, { creator: "maker", tier: 1, expect: 1, key: "key-exp-00001" }), (e) => e.code === "E_PRICE_CHANGED");
  const b0 = await bal(U.fan);
  const r = await CR.subscribe(U.fan, { creator: "maker", tier: 1, expect: 20000, key: "key-subscribe-1" });
  assert.equal(r.price, 20000);
  assert.equal(await bal(U.fan), b0 - 20000);
  const again = await CR.subscribe(U.fan, { creator: "maker", tier: 1, key: "key-subscribe-1" });
  assert.equal(again.dup, true);
  assert.equal(await bal(U.fan), b0 - 20000, "a replayed key charges nothing");
  await assert.rejects(CR.subscribe(U.fan, { creator: "maker", tier: 2, key: "key-subscribe-2" }), (e) => e.code === "E_ALREADY");
  const h = await getQuery("SELECT * FROM escrow_holds WHERE kind = 'CRS'");
  assert.equal(h.length, 1);
  assert.equal(h[0].amount, 20000);
  assert.equal((await ESC.holdsHeld()).filter((x) => x.kind === "CRS").length, 0, "never in Pepe's mirror");
  assert.equal((await ESC.heldTotal("pepe")).amount, 0);
  assert.equal((await ESC.heldTotal("service")).amount, 20000);
  await assert.rejects(ESC.refund({ key: "pepe-tries-refund", hid: h[0].id }), (e) => e.code === "E_SITE_HOLD");
  // tier 1 doesn't open the tier-2 diary; the PPV post isn't free for tier 1
  const diary = (await getQuery("SELECT id FROM feed_posts WHERE title = 'Tier 2 diary'"))[0].id;
  assert.equal((await view(diary, U.fan)).creator.gated, true);
  assert.equal((await view(test.ppvPost, U.fan)).creator.gated, true);
  // upgrade: the prorated difference now, the tier at once
  const sub = (await getQuery("SELECT * FROM creator_subs WHERE fan_id = ?", [U.fan.userId]))[0];
  const up = await CR.changeTier(U.fan, sub.id, { tier: 2, key: "key-upgrade-01" });
  assert.equal(up.charged, 80000, "a full period left: the whole difference");
  assert.equal((await view(diary, U.fan)).body, "the secret text");
  assert.equal((await view(test.ppvPost, U.fan)).body, "ppv words", "free for tier 2 and up");
  const att = (await getQuery("SELECT a.*, p.author_id FROM feed_attachments a LEFT JOIN feed_posts p ON p.id = a.post_id WHERE a.file = ?", [test.ppvFile]))[0];
  assert.equal((await CR.mediaGate(U.fan, att)).allow, true);
});

test("pay-per-view unlock (CRP) with caps; deleting the post refunds unreleased unlocks", async () => {
  const p = await store.create(U.maker.userId, { title: "One-off", body: "unlocked words", community: prof(U.maker), lock: { kind: "ppv", price: 3000 } });
  const b0 = await bal(U.fan2);
  await assert.rejects(CR.unlock(U.fan2, { post: p.id, expect: 1, key: "key-unlock-x1" }), (e) => e.code === "E_PRICE_CHANGED");
  await CR.unlock(U.fan2, { post: p.id, expect: 3000, key: "key-unlock-01" });
  assert.equal(await bal(U.fan2), b0 - 3000);
  assert.equal((await view(p.id, U.fan2)).body, "unlocked words");
  assert.equal((await getQuery("SELECT kind FROM escrow_holds WHERE cp = 'maker' AND kind = 'CRP'")).length, 1);
  // tier 2's 20% PPV discount for fan
  const q = await CR.quote(U.fan, { post: p.id });
  assert.equal(q.price, 2400);
  await store.remove(U.maker, p.id);
  assert.equal(await bal(U.fan2), b0, "refunded on deletion");
  assert.equal((await view(p.id, U.boss)).deleted, true);
  assert.equal((await getQuery("SELECT state FROM creator_unlocks WHERE fan_id = ? AND post_id = ?", [U.fan2.userId, p.id]))[0].state, "refunded");
});

test("release after the hold: 80% to the creator, the 20% cut as reserve claims (profile: all Fort Knox); the weekly cap holds the rest", async () => {
  const before = await bal(U.maker);
  const claims0 = (await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM reserve_claims"))[0].t;
  let r = await CR.releaseDue(T + DAY);
  assert.equal(r.released, 0, "nothing before the hold ends");
  r = await CR.releaseDue(T + 8 * DAY);
  assert.equal(r.released, 2, "the sub + the upgrade");
  assert.equal(await bal(U.maker), before + 16000 + 64000);
  const claims = (await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM reserve_claims"))[0].t - claims0;
  assert.equal(claims, -(4000 + 16000), "the cut is deposited (negative claims)");
  const flows = await getQuery("SELECT DISTINCT flow FROM reserve_claims WHERE type LIKE 'creators cut%'");
  assert.ok(flows.every((f) => /^(fortknox:)?creators$/.test(f.flow)), "a profile purchase: all Fort Knox (or its stand-in)");
  assert.equal((await ESC.heldTotal("service")).amount, 0);
  const again = await CR.releaseDue(T + 9 * DAY);
  assert.equal(again.released, 0, "idempotent");
  await CR.setConfig({ release_cap_week: 1000 }, "test");      // a 4,000 share over a 1,000 cap stays held
  await CR.unlock(U.fan2, { post: test.ppvPost, key: "key-unlock-capped", expect: 5000 });
  r = await CR.releaseDue(T + 30 * DAY);
  assert.equal(r.capped, 1);
  await CR.setConfig({ release_cap_week: 20000000 }, "test");
  r = await CR.releaseDue(T + 30 * DAY);
  assert.equal(r.released, 1);
});

test("disputes freeze a hold; an admin refund returns it; marking a locked post NSFW takes it down and refunds", async () => {
  T += 31 * DAY;
  const p = await store.create(U.maker.userId, { title: "Disputed", body: "?", community: prof(U.maker), lock: { kind: "ppv", price: 4000 } });
  const b0 = await bal(U.fan2);
  await CR.unlock(U.fan2, { post: p.id, key: "key-unlock-disp", expect: 4000 });
  const l = (await getQuery("SELECT * FROM creator_ledger WHERE post_id = ?", [p.id]))[0];
  const d = await CR.dispute(U.fan2, { ledger: l.id, reason: "empty", note: "nothing there" });
  assert.ok(d.id);
  const r = await CR.releaseDue(T + 10 * DAY);
  assert.equal((await getQuery("SELECT state FROM creator_ledger WHERE id = ?", [l.id]))[0].state, "held", "frozen: not released");
  void r;
  await assert.rejects(CR.resolveDispute(U.fan, d.id, { action: "refund" }), /Staff only/);
  await CR.resolveDispute(U.boss, d.id, { action: "refund", note: "upheld" });
  assert.equal(await bal(U.fan2), b0);
  // explicit takedown
  const p2 = await store.create(U.maker.userId, { title: "Marked", body: "?", community: prof(U.maker), lock: { kind: "ppv", price: 2000 } });
  await CR.unlock(U.fan2, { post: p2.id, key: "key-unlock-nsfw", expect: 2000 });
  await store.adminSet(U.boss, p2.id, { nsfw: 1 });
  const row = await store.getRow(p2.id);
  assert.ok(row.deleted_at, "taken down");
  assert.equal(row.nsfw_admin, null, "never marked NSFW");
  assert.equal(await bal(U.fan2), b0, "buyer refunded");
});

test("renewals: renew, grace when short, lapse after it; cancel ends at the paid date", async () => {
  const s = (await getQuery("SELECT * FROM creator_subs WHERE fan_id = ? AND status = 'active'", [U.fan.userId]))[0];
  const b0 = await bal(U.fan);
  assert.equal(await CR.renewOne(s, Number(s.paid_through) + 1), "renewed");
  assert.equal(await bal(U.fan), b0 - 100000, "tier 2's price");
  const s2 = (await getQuery("SELECT * FROM creator_subs WHERE id = ?", [s.id]))[0];
  assert.equal(await CR.renewOne(s, Number(s.paid_through) + 1), "dup", "a stale row can't charge twice");
  await runQuery("UPDATE users SET points_balance = 10 WHERE userId = ?", [U.fan.userId]);
  assert.equal(await CR.renewOne(s2, Number(s2.paid_through) + 1), "grace");
  const s3 = (await getQuery("SELECT * FROM creator_subs WHERE id = ?", [s.id]))[0];
  assert.equal(s3.status, "grace");
  assert.equal((await CR.liveTiers(U.fan.userId)).get(U.maker.userId), 2, "access during grace");
  assert.equal(await CR.renewOne(s3, Number(s3.paid_through) + 4 * DAY), "lapsed");
  await runQuery("UPDATE users SET points_balance = 50000000 WHERE userId = ?", [U.fan.userId]);
  const n = await CR.subscribe(U.fan, { creator: "maker", tier: 1, key: "key-subscribe-again" });
  await CR.cancel(U.fan, n.sub_id);
  const c = (await getQuery("SELECT * FROM creator_subs WHERE id = ?", [n.sub_id]))[0];
  assert.equal(c.status, "active");
  assert.equal(await CR.renewOne(c, Number(c.paid_through) + 1), "ended");
});

test("18+ communities: the gate until the viewer confirms; suggestive locked media passes there, explicit never", async () => {
  await CR.apply(U.maker, { terms: true, rating: "r18", attest: { adult: true, depicted_adults: true, not_explicit: true, rules: true }, plans: [{ name: "Supporter", price: 20000 }, { name: "Super", price: 100000 }] });
  assert.ok(CR.isR18Room("user:" + U.maker.userId));
  const pub = await store.create(U.maker.userId, { title: "Public r18 post", body: "hello", community: prof(U.maker) });
  const g = await view(pub.id, U.fan2);
  assert.equal(g.creator.r18Gate, true);
  assert.equal(g.title, "");
  assert.equal(g.body, "");
  assert.equal((await view(pub.id, U.maker)).body, "hello");
  await CR.attestAge(U.fan2, true);
  assert.equal((await view(pub.id, U.fan2)).body, "hello");
  ANSWER = SUGGESTIVE;
  const a = await mkAtt(U.maker);
  const p = await store.create(U.maker.userId, { title: "R-rated set", community: prof(U.maker), attachments: [a.id], lock: { kind: "sub", tier: 1 } });
  assert.equal((await store.getRow(p.id)).lock_rating, "r18");
  ANSWER = EXPLICIT;
  const b = await mkAtt(U.maker);
  await assert.rejects(store.create(U.maker.userId, { title: "too far", community: prof(U.maker), attachments: [b.id], lock: { kind: "sub" } }), (e) => e.status === 422 && /never explicit/.test(e.message));
  // the fan without an age confirmation can't buy into an 18+ community
  await assert.rejects(CR.subscribe(U.poor, { creator: "maker", tier: 1, key: "key-age-0001" }), (e) => e.code === "E_AGE");
  await CR.apply(U.maker, { terms: true, rating: "sfw", plans: [{ name: "Supporter", price: 20000 }, { name: "Super", price: 100000 }] });
});

test("TAKE IT DOWN: a request hides the post at once, removal deletes it + blocks an exact re-upload; an NCII report opens a case", async () => {
  ANSWER = CLEAN;
  await ISF.setConfig({ locked_enforce: false }, "test");
  const a = await mkAtt(U.fan2, { r: 1, g: 2, b: 3 });
  const p = await store.create(U.fan2.userId, { body: "someone else's picture", community: PLANT, attachments: [a.id] });
  const r = await TD.request({ name: "Pat Victim", email: "pat@example.com", relationship: "self", urls: "https://publicaccess.tv/p/x/posts/" + p.id + "/slug",
                               good_faith: true, signature: "Pat Victim" }, { ip: "1.2.3.4" });
  assert.equal(r.found, 1);
  assert.ok((await store.getRow(p.id)).hidden_at, "hidden pending review");
  assert.equal(r.deadline - T, 48 * 3600e3);
  await assert.rejects(TD.request({ name: "x", email: "bad", relationship: "self", urls: "u", good_faith: true, signature: "x" }), /email/);
  await assert.rejects(TD.remove(U.fan, r.id), /Staff only/);
  const out = await TD.remove(U.boss, r.id, "valid");
  assert.equal(out.removed, 1);
  assert.equal(out.hashes, 1);
  assert.ok((await store.getRow(p.id)).deleted_at);
  // the same file again: refused
  const copy = await mkAtt(U.fan2, { r: 9, g: 9, b: 9 });
  fs.copyFileSync(fm.filePath(a.file), fm.filePath(copy.file));
  await assert.rejects(store.create(U.fan2.userId, { body: "again", community: PLANT, attachments: [copy.id] }), (e) => e.status === 422 && /non-consensual/.test(e.message));
  // an NCII report on a post
  const p2 = await store.create(U.fan2.userId, { body: "another", community: PLANT });
  await store.report(U.fan, { post: p2.id, reason: "ncii", note: "that's me" });
  const q = await TD.queue();
  const c = q.find((x) => x.source === "report");
  assert.ok(c && c.posts.some((x) => x.id === p2.id));
  // reminders at 24 h and 8 h left
  await TD.tick(T + 30 * 3600e3);
  assert.equal((await getQuery("SELECT reminded FROM takedown_cases WHERE id = ?", [c.id]))[0].reminded, 1);
});

test("Pepe's bot API: quote, subscribe (keyed), subs, creator", async () => {
  await runQuery("UPDATE users SET points_balance = 50000000 WHERE userId = ?", [U.fan2.userId]);
  const c = await CR.botAct({ verb: "creator", creator: "maker" });
  assert.equal(c.ok, true);
  assert.equal(c.plans.length, 2);
  const q = await CR.botAct({ verb: "quote", username: "fan2", creator: "maker", tier: 1 });
  assert.deepEqual([q.ok, q.price, q.tierName], [true, 20000, "Supporter"]);
  const s = await CR.botAct({ verb: "subscribe", username: "fan2", creator: "maker", tier: 1, expect: 20000, idem: "abc123def456" });
  assert.equal(s.ok, true);
  const s2 = await CR.botAct({ verb: "subscribe", username: "fan2", creator: "maker", tier: 1, expect: 20000, idem: "abc123def456" });
  assert.equal(s2.ok, false, "already subscribed (quote refuses first)");
  const l = await CR.botAct({ verb: "subs", username: "fan2" });
  assert.ok(l.subs.some((x) => x.creator === "maker"));
  await CR.setConfig({ pepe_commands: false }, "test");
  assert.equal((await CR.botAct({ verb: "subs", username: "fan2" })).code, "off");
  await CR.setConfig({ pepe_commands: true }, "test");
});

test("a creator ban refunds every unreleased payment and ends the subscriptions", async () => {
  const held = (await getQuery("SELECT COUNT(*) AS n FROM creator_ledger WHERE creator_id = ? AND state = 'held'", [U.maker.userId]))[0].n;
  assert.ok(held > 0);
  const r = await CR.staffSet(U.boss, U.maker.userId, { status: "banned", note: "test" });
  assert.equal(r.refunded, held);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM creator_subs WHERE creator_id = ? AND status IN ('active','grace')", [U.maker.userId]))[0].n, 0);
  assert.equal(CR.isActiveCreator(U.maker.userId), false);
  assert.equal((await ESC.heldTotal("service")).amount, 0);
});
