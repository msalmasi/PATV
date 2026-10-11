// Offline tests for 1.99oy "more achievements" (101 new): using things (heist kit, relics, voices, stickers, cosmetics), the
// everyday site actions (feed, follows, polls, tips, boosts, banners) and the card tables (blackjack + hold'em hands).
//   * the catalog: badge art for every one, rewards in line with the tiers, localized, grouped on /achievements
//   * casino/achhands.js: what a showdown / a blackjack seat is worth (the same rules as Pepe's pepe_casinoach.py)
//   * achsocial.js: quiet backfill first (badge only), then the hooks award loudly; the anti-farming rules (your own
//     upvotes / alts don't count, tips need 1,000+ PAT and DIFFERENT people, a poll needs 3 OTHER voters)
//   node --test test/more-achievements.test.js       (temp DB; node_modules = G:/PATV/node_modules)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "moreach-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");

const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const AH = require(path.join(repo, "casino", "achhands"));
let A, SO;

const NEW_PREFIXES = ["cf_use_", "cf_clutch", "cf_relic_", "cf_crate_", "cf_avatar_", "cf_voice_", "cf_stickers_", "cf_cos_", "cf_post_",
  "cf_comment_", "cf_likes_", "cf_follow", "cf_poll_", "cf_tip_first", "cf_tip_people_", "cf_tip_fans_", "cf_boost_", "cf_banner",
  "cf_wager_made", "cf_wager_rivals", "cf_market_made", "cf_cards_"];
const xp = [];
let n = 0;
const U = {};
async function mkUser(name, cf) {
  const id = "m" + (++n);
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername) VALUES (?, ?, ?, 'x', 'pleb', 0, ?)",
                 [id, name, name, cf || null]);
  U[name] = { userId: id, username: name };
  return U[name];
}
const badges = async (u) => (await getQuery("SELECT badgeId FROM user_badges WHERE userId = ? ORDER BY badgeId", [u.userId])).map((r) => r.badgeId);
const feedFor = async (u) => (await getQuery("SELECT badgeId FROM achievement_feed WHERE userId = ? ORDER BY id", [u.userId])).map((r) => r.badgeId);
const settle = () => new Promise((r) => setTimeout(r, 150));
let pn = 0;
async function post(u, extra = {}) {
  const id = "p" + (++pn);
  await runQuery("INSERT INTO feed_posts (id, author_id, created, deleted_at, crosspost_of) VALUES (?, ?, ?, ?, ?)",
                 [id, u.userId, Date.now(), extra.deleted ? 1 : null, extra.crosspost || null]);
  return id;
}
const vote = (postId, u, value = 1) => runQuery("INSERT OR REPLACE INTO feed_votes (post_id, user_id, value, w, created) VALUES (?, ?, ?, 1, 1)", [postId, u.userId, value]);
let tn = 0;
const tip = (from, to, amount) => Promise.all([
  runQuery("INSERT INTO transactions (transactionId, userId, type, points, counterparty) VALUES (?, ?, 'tip sent', ?, ?)", ["t" + (++tn), from.userId, -amount, to.userId]),
  runQuery("INSERT INTO transactions (transactionId, userId, type, points, counterparty) VALUES (?, ?, 'tip received', ?, ?)", ["t" + (++tn), to.userId, amount, from.userId]),
]);
const follow = (a, b) => runQuery("INSERT OR IGNORE INTO follows (follower, target_kind, target_id, created_at) VALUES (?, 'user', ?, 1)", [a.userId, b.userId]);

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, extra_daily_spins INTEGER DEFAULT 0,
                  discordId TEXT, twitchId TEXT, camfrogUsername TEXT, email TEXT, isEmailVerified INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS badges (badgeId TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, icon TEXT,
                  points INTEGER DEFAULT 0, requirement TEXT NOT NULL, createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS user_badges (userId TEXT NOT NULL, badgeId TEXT NOT NULL, awardedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (userId, badgeId))`);
  await runQuery(`CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL, points INTEGER NOT NULL,
                  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)`);
  await runQuery("CREATE TABLE welcome_bonus (userId TEXT PRIMARY KEY, dup_of TEXT)");
  await runQuery("CREATE TABLE feed_posts (id TEXT PRIMARY KEY, author_id TEXT, created INTEGER, deleted_at INTEGER, crosspost_of TEXT)");
  await runQuery("CREATE TABLE feed_comments (id TEXT PRIMARY KEY, post_id TEXT, author_id TEXT, body TEXT, created INTEGER, deleted_at INTEGER)");
  await runQuery("CREATE TABLE feed_votes (post_id TEXT NOT NULL, user_id TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 1, w INTEGER, created INTEGER, PRIMARY KEY (post_id, user_id))");
  await runQuery("CREATE TABLE follows (follower TEXT NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (follower, target_kind, target_id))");
  await runQuery("CREATE TABLE polls (id TEXT PRIMARY KEY, data TEXT NOT NULL, status TEXT, created TEXT, updated INTEGER)");
  await runQuery(`CREATE TABLE room_flow_ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT, kind TEXT, room_id TEXT, payer_id TEXT, amount INTEGER,
                  owner_self INTEGER DEFAULT 0, created INTEGER)`);
  await runQuery("CREATE TABLE banner_bookings (id TEXT PRIMARY KEY, user_id TEXT, status TEXT, start_day TEXT)");

  // ── history from BEFORE these achievements existed ──
  const vet = await mkUser("veteran", "VetCF");
  const pal = await mkUser("pal", "PalCF");
  const alt = await mkUser("vetalt");
  await mkUser("newcomer", "NewCF");
  for (const x of ["fan1", "fan2", "fan3"]) await mkUser(x, x.toUpperCase());
  await runQuery("INSERT INTO welcome_bonus (userId, dup_of) VALUES (?, ?)", [alt.userId, vet.userId]);
  const p1 = await post(vet);
  await vote(p1, vet);                                       // the author's own upvote: never counted
  await vote(p1, alt);                                       // an alt's: never counted
  for (const f of ["fan1", "fan2", "fan3", "pal"]) await vote(p1, U[f]);
  for (let i = 0; i < 9; i++) await post(vet);              // 10 posts: First Post! + Columnist
  await post(vet, { crosspost: p1 });                       // a crosspost isn't a post
  await runQuery("INSERT INTO feed_comments (id, post_id, author_id, body, created) VALUES ('c1', ?, ?, 'hi', 1)", [p1, pal.userId]);
  await tip(vet, pal, 5000);                                 // a real tip
  await tip(vet, U.fan1, 50);                                // a 50-PAT tip: never counts
  await tip(vet, alt, 9000);                                 // to an alt: never counts
  await runQuery("INSERT INTO room_flow_ledger (ref, kind, room_id, payer_id, amount, owner_self, created) VALUES ('b1', 'boost', 'R1', ?, 1000, 0, 1)", [vet.userId]);
  await runQuery("INSERT INTO room_flow_ledger (ref, kind, room_id, payer_id, amount, owner_self, created) VALUES ('b2', 'boost', 'R2', ?, 1000, 1, 1)", [pal.userId]);
  await runQuery("INSERT INTO banner_bookings (id, user_id, status, start_day) VALUES ('bb1', ?, 'approved', '2026-10-01')", [vet.userId]);
  await runQuery("INSERT INTO banner_bookings (id, user_id, status, start_day) VALUES ('bb2', ?, 'rejected', '2026-10-01')", [pal.userId]);
  await runQuery("INSERT INTO polls (id, data, status) VALUES ('poll_a', ?, 'ended')", [JSON.stringify({ id: "poll_a", creator: "VetCF",
    votes: { 0: ["FAN1"], 1: ["PalCF", "VetCF"] }, options: ["a", "b"], status: "ended" })]);
  await runQuery("INSERT INTO polls (id, data, status) VALUES ('poll_b', ?, 'ended')", [JSON.stringify({ id: "poll_b", creator: "🌐pal",
    votes: { 0: ["FAN1", "VetCF"] }, options: ["a", "b"], status: "ended" })]);

  A = require(path.join(repo, "achievements"));
  SO = require(path.join(repo, "achsocial"));
  A.setUpdateLevel(async (userId, amount) => { xp.push({ userId, amount }); return null; });
  await A.ready;
  const COS = require(path.join(repo, "cosmetics"));
  await COS.ready;
  const leg = COS.catalog().find((i) => i.rarity === "legendary" && !i.kind.startsWith("gtf_"));
  const ins = await runQuery("INSERT INTO user_cosmetics (user_id, item_id, source, acquired, idem, locked) VALUES (?, ?, 'test', 1, 'i1', 0)", [vet.userId, leg.id]);
  await runQuery("INSERT INTO user_cosmetic_equips (user_id, kind, inv_id) VALUES (?, ?, ?)", [vet.userId, leg.kind, ins.id]);
});

test("catalog: 101 new achievements, badge art for each, tiers + rewards in line, localized, grouped (nothing new in 'Everything else')", async () => {
  const list = A.list();
  const fresh = list.filter((a) => NEW_PREFIXES.some((p) => a.id.startsWith(p)) || /^cf_(bj|holdem)_/.test(a.id) && !["cf_bj_natural", "cf_bj_100", "cf_bj_1000",
    "cf_holdem_pot", "cf_holdem_25"].includes(a.id) || ["cf_reroll_10"].includes(a.id));
  assert.equal(fresh.length, 101, fresh.length);
  const band = { common: [500, 2000, 5000, 20000], uncommon: [2000, 5000, 20000, 50000], rare: [8000, 15000, 80000, 150000], legendary: [20000, 30000, 250000, 500000] };
  for (const a of fresh) {
    assert.ok(fs.existsSync(path.join(repo, a.icon.replace(/^\//, ""))), "badge art: " + a.icon);
    const [x0, x1, p0, p1] = band[a.tier];
    assert.ok(a.xp >= x0 && a.xp <= x1 && a.pat >= p0 && a.pat <= p1, `${a.id} ${a.tier} ${a.xp}/${a.pat}`);
    assert.ok(a.threshold >= 1 && a.metric, a.id);
  }
  // site-side ones are exactly the achsocial metrics; the rest are Pepe's (and the casino's)
  for (const a of fresh) assert.equal(a.side === "web", SO.METRICS.includes(a.metric), a.id);
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  for (const k of ["ach.group.kit", "ach.group.cards", "ach.group.style", "ach.group.social"]) assert.ok(en[k], k);
  const html = await ejs.renderFile(path.join(repo, "views", "achievements.ejs"), {
    achievements: list, holders: {}, owned: null, viewing: null, own: false, user: null, signedIn: false,
  }, { root: path.join(repo, "views") });
  const grp = (slug) => { const m = html.match(new RegExp(`<section class="grp" data-group="${slug}"[\\s\\S]*?</section>`)); return m ? m[0] : ""; };
  for (const [slug, ids] of [["kit", ["cf_use_lockpick", "cf_clutch_10", "cf_relic_ring_20", "cf_crate_jackpot"]], ["cards", ["cf_holdem_royal", "cf_bj_charlie", "cf_cards_velvet", "cf_bj_natural"]],
                             ["style", ["cf_voice_buy", "cf_stickers_kinds", "cf_cos_legendary", "cf_avatar_25"]], ["social", ["cf_post_1", "cf_likes_1000", "cf_followers_100", "cf_poll_vote"]],
                             ["room", ["cf_tip_first", "cf_tip_fans_10"]], ["pads", ["cf_boost_5", "cf_banner"]], ["casino", ["cf_wager_made", "cf_market_made"]], ["heists", ["cf_reroll_10"]]]) {
    for (const id of ids) assert.ok(grp(slug).includes(list.find((a) => a.id === id).icon), `${id} in ${slug}`);
  }
  for (const a of fresh) assert.ok(!grp("else").includes(a.icon), a.id + " lands in a real group");
});

test("achhands: royal flush / straight flush / quads / full house only when the hole cards make them; 7-2; big pot; all-in; knock-out; high stakes", () => {
  const sd = (hands, board, awards, stacks, highStakes) => AH.holdemShowdown({ reveals: Object.entries(hands).map(([who, cards]) => ({ who, cards })),
    board, awards, stacks, highStakes });
  let r = sd({ a: ["Ah", "Kh"], b: ["7c", "2d"] }, ["Qh", "Jh", "Th", "3s", "4c"], [{ who: "a", amount: 1200000, pot: "main pot" }], { a: 1200000, b: 0 }, true);
  assert.deepEqual(r.a, { hm_sflush: 1, hm_royal: 1, hm_big_pots: 1, hm_allin_wins: 1, casino_hr_wins: 1, hm_busts: 1 });
  assert.deepEqual(r._bustPairs, [["a", "b"]]);
  assert.equal(r.b, undefined, "7-2 that LOST is nothing");
  // a royal flush on the board is nobody's (split pot, nobody's hole cards made it)
  r = sd({ a: ["2c", "3d"], b: ["4c", "5d"] }, ["Ah", "Kh", "Qh", "Jh", "Th"], [{ who: "a", amount: 50, pot: "main pot" }, { who: "b", amount: 50, pot: "main pot" }], { a: 500, b: 500 });
  assert.deepEqual(r, {});
  r = sd({ a: ["9s", "9h"], b: ["Kc", "Kd"] }, ["9c", "9d", "Ks", "2h", "3c"], [{ who: "a", amount: 300, pot: "main pot" }], { a: 900, b: 400 });
  assert.deepEqual(r.a, { hm_quads: 1 });
  assert.deepEqual(r.b, undefined, "a full house that lost isn't a bad beat (K-K was way behind on the turn)");
  r = sd({ a: ["7s", "2h"], b: ["Ac", "Kd"] }, ["7c", "7d", "2s", "Qh", "3c"], [{ who: "a", amount: 300, pot: "main pot" }], { a: 900, b: 400 });
  assert.deepEqual(r.a, { hm_boats: 1, hm_72: 1 });
  // 7-2 SUITED isn't the hammer
  r = sd({ a: ["7h", "2h"], b: ["Ac", "Kd"] }, ["7c", "8d", "2s", "Qh", "3c"], [{ who: "a", amount: 300, pot: "main pot" }], { a: 900, b: 400 });
  assert.deepEqual(r.a, undefined);
});

test("achhands: bad beats - quads that lost, and a big favourite on the turn that lost on the river", () => {
  const sd = (hands, board, winner) => AH.holdemShowdown({ reveals: Object.entries(hands).map(([who, cards]) => ({ who, cards })), board,
    awards: [{ who: winner, amount: 1000, pot: "main pot" }], stacks: { a: 10, b: 10 } });
  // quads lose to a straight flush
  let r = sd({ a: ["8s", "8h"], b: ["9c", "Tc"] }, ["8c", "8d", "Jc", "Qc", "2h"], "b");
  assert.equal(r.a.hm_badbeats, 1);
  assert.equal(r.b.hm_sflush, 1);
  // aces vs a gutshot on the turn (~91% favourite), the river fills it
  r = sd({ a: ["As", "Ah"], b: ["8c", "9d"] }, ["Ac", "6h", "Td", "2s", "7h"], "b");
  assert.ok(AH.riverEquity({ a: ["As", "Ah"], b: ["8c", "9d"] }, "a", ["Ac", "6h", "Td", "2s"]) >= AH.BADBEAT_EQ);
  assert.equal(r.a.hm_badbeats, 1);
  // a coin flip that lost isn't a bad beat
  r = sd({ a: ["Ks", "Qs"], b: ["Jc", "Jd"] }, ["2c", "5h", "9d", "3s", "4h"], "b");
  assert.equal(r.a, undefined);
});

test("achhands: blackjack seat - Five-Card Charlie, doubles, a split sweep, insurance, a win at a 💎 High Roller table, the round result", () => {
  const seat = (hands, extra = {}, hs = false) => AH.blackjackSeat(Object.assign({ hands, insurance: null, total_bet: 0, total_payout: 0 }, extra), hs);
  const h = (cards, outcome, bet, more = {}) => Object.assign({ cards, outcome, bet }, more);
  assert.deepEqual(seat([h(["2s", "3d", "2h", "3c", "4s"], "win", 100)], { total_bet: 100, total_payout: 200 }), { bj_charlies: 1, _result: "win" });
  assert.deepEqual(seat([h(["2s", "3d", "2h", "3c", "Ks"], "bust", 100)], { total_bet: 100 }), { _result: "loss" }, "five cards that bust: nothing");
  assert.deepEqual(seat([h(["5s", "6d", "Kc"], "win", 200, { doubled: true })], { total_bet: 200, total_payout: 400 }), { bj_double_wins: 1, _result: "win" });
  assert.deepEqual(seat([h(["8s", "3d", "Kc"], "win", 100, { from_split: true }), h(["8h", "Ks"], "win", 100, { from_split: true })],
                        { total_bet: 200, total_payout: 400 }), { bj_split_sweeps: 1, _result: "win" });
  assert.deepEqual(seat([h(["8s", "3d", "Kc"], "win", 100, { from_split: true }), h(["8h", "9s"], "lose", 100, { from_split: true })],
                        { total_bet: 200, total_payout: 200 }), { _result: "push" }, "split, one won one lost: no sweep");
  assert.deepEqual(seat([h(["Ts", "9d"], "lose", 100)], { insurance: { amount: 50, won: true, payout: 150 }, total_bet: 150, total_payout: 150 }),
                   { bj_insurance_wins: 1, _result: "push" });
  assert.deepEqual(seat([h(["Ts", "Qd"], "win", 500000)], { total_bet: 500000, total_payout: 1000000 }, true), { casino_hr_wins: 1, _result: "win" });
  assert.deepEqual(seat([h(["Ts", "Qd"], "lose", 500000)], { total_bet: 500000, total_payout: 0 }, true), { _result: "loss" }, "losing at a High Roller table");
  assert.deepEqual(seat([h(["Ts", "Qd"], "win", 100000)], { total_bet: 100000, total_payout: 200000 }), { _result: "win" }, "a max bet at a normal table");
});

test("social: before the quiet backfill nothing counts; the backfill gives what history earned QUIETLY (no XP / PAT / feed), once", async () => {
  // the metrics read 0 until it ran (webMetrics runs it first) - the raw metrics already see the history
  const m = await SO.metrics(U.veteran.userId);
  assert.deepEqual([m.posts, m.likes_recv, m.tip_people, m.boost_pads, m.banners, m.polls_made, m.poll_votes, m.cos_equipped, m.cos_legendary],
                   [10, 4, 1, 1, 1, 0, 2, 1, 1], JSON.stringify(m));
  const r = await SO.backfill();
  const vet = await badges(U.veteran);
  for (const id of ["cf_post_1", "cf_post_10", "cf_tip_first", "cf_boost_1", "cf_banner", "cf_poll_vote", "cf_cos_equip", "cf_cos_legendary"]) {
    assert.ok(vet.includes(id), id + " in " + vet.join(","));
  }
  for (const id of ["cf_likes_10", "cf_poll_made", "cf_post_100", "cf_cos_fit"]) assert.ok(!vet.includes(id), id + " not earned");
  const pal = await badges(U.pal);
  for (const id of ["cf_comment_1", "cf_tip_fans_1", "cf_poll_vote"]) assert.ok(pal.includes(id), id);
  assert.ok(!pal.includes("cf_boost_1"), "boosting your OWN pad isn't 'someone else's'");
  assert.ok(!pal.includes("cf_banner"), "a rejected banner");
  assert.deepEqual(await feedFor(U.veteran), [], "no announcement");
  assert.equal(xp.length, 0, "no XP");
  assert.ok(r.given >= 11, JSON.stringify(r.by));
  assert.equal((await SO.backfill()).given, r.given, "memoized");
  const meta = JSON.parse((await getQuery("SELECT v FROM achievement_meta WHERE k = ?", [SO.FLAG]))[0].v);
  assert.equal(meta.given, r.given);
});

test("social: after it, the hooks award loudly - a 10th upvote from someone else, a poll's 3rd other voter, 10 follows", async () => {
  const vet = U.veteran;
  for (const f of ["fan1", "fan2", "fan3", "pal", "newcomer"]) await vote("p2", U[f]);
  for (const f of ["fan1", "fan2"]) await vote("p3", U[f]);
  // 4 (p1) + 5 (p2) + 2 (p3) = 11 upvotes from other people
  A.poke(vet.userId);
  await settle();
  assert.ok((await feedFor(vet)).includes("cf_likes_10"));
  assert.ok(xp.some((x) => x.userId === vet.userId && x.amount === 1000));
  // the poll: VetCF started it, FAN1 / PalCF voted (VetCF's own vote doesn't count) - FAN2's vote makes 3 others
  const pa = { id: "poll_a", creator: "VetCF", votes: { 0: ["FAN1", "FAN2"], 1: ["PalCF", "VetCF"] }, options: ["a", "b"], status: "ended" };
  await runQuery("UPDATE polls SET data = ? WHERE id = 'poll_a'", [JSON.stringify(pa)]);
  SO.pokePoll(pa);
  await settle();
  assert.ok((await feedFor(vet)).includes("cf_poll_made"), (await feedFor(vet)).join(","));
  // pal's web poll had 2 voters: not yet
  assert.ok(!(await badges(U.pal)).includes("cf_poll_made"));
  const social = await mkUser("social");
  const targets = [];
  for (let i = 0; i < 10; i++) targets.push(await mkUser("t" + i));
  for (const t of targets) await follow(social, t);
  await follow(social, social);
  A.poke(social.userId);
  await settle();
  assert.deepEqual(await feedFor(social), ["cf_follow_10"]);
});

test("social: tips count DIFFERENT people at 1,000+ PAT each; ten small tips or ten to one friend don't make Spreading the Love", async () => {
  const g = await mkUser("giver");
  for (let i = 0; i < 10; i++) await tip(g, U.pal, 2000);
  for (let i = 0; i < 10; i++) await tip(g, U["t" + i], 999);
  let m = await SO.metrics(g.userId);
  assert.equal(m.tip_people, 1);
  for (let i = 0; i < 9; i++) await tip(g, U["t" + i], 1000);
  m = await SO.metrics(g.userId);
  assert.equal(m.tip_people, 10);
  assert.equal((await SO.metrics(U.t0.userId)).tip_fans, 1);
  await A.checkWeb(g.userId);
  const f = await feedFor(g);
  assert.ok(f.includes("cf_tip_first") && f.includes("cf_tip_people_10"), f.join(","));
});

test("cosmetics: every profile slot filled = Fit Check; every heist-avatar slot = Full Disguise; 25 different items = Wardrobe", async () => {
  const C = require(path.join(repo, "cosmetics"));
  const u = await mkUser("dresser");
  const cat = C.catalog();
  const kinds = Array.from(new Set(cat.map((i) => i.kind)));
  let k = 0;
  for (const kind of kinds) {
    const it = cat.find((i) => i.kind === kind && i.rarity !== "legendary");
    const ins = await runQuery("INSERT INTO user_cosmetics (user_id, item_id, source, acquired, idem, locked) VALUES (?, ?, 'test', 1, ?, 0)", [u.userId, it.id, "d" + (++k)]);
    await runQuery("INSERT INTO user_cosmetic_equips (user_id, kind, inv_id) VALUES (?, ?, ?)", [u.userId, kind, ins.id]);
  }
  let m = await SO.metrics(u.userId);
  assert.deepEqual([m.cos_equipped, m.cos_profile_full, m.cos_gtf_full, m.cos_legendary], [1, 1, 1, 0]);
  for (const it of cat.filter((i) => i.rarity === "common").slice(0, 25)) {
    await runQuery("INSERT OR IGNORE INTO user_cosmetics (user_id, item_id, source, acquired, idem, locked) VALUES (?, ?, 'test', 1, ?, 0)", [u.userId, it.id, "w" + it.id]);
  }
  m = await SO.metrics(u.userId);
  assert.ok(m.cos_owned >= 25, m.cos_owned);
  await A.checkWeb(u.userId);
  const f = await feedFor(u);
  for (const id of ["cf_cos_equip", "cf_cos_fit", "cf_cos_gtf", "cf_cos_25"]) assert.ok(f.includes(id), id + " in " + f.join(","));
});
