// Posts count as activity (2026-10-12, engagement.js; Pepe's pepe_padtopup.py) + 💸 boost upvotes + profile vaults:
//   * only engagement FROM OTHERS counts: distinct qualified accounts (>= 7 days, level >= 2, verified / linked, not archived,
//     no dup_of), never the author or the author's alt (shared device key / dup_of), never Pepe's posts
//   * sqrt per post, capped per post and per author per day (a viral post can't take everything); engagers per pad
//   * like-rings: mutual-voting clusters are down-weighted by pair reciprocity; a normal voter keeps weight 1
//   * the vote weight and the boost weight are pluggable; a boost counts extra (diminishing, capped), never from an alt
//   * POST /api/feed/posts/:id/boost: the voter's upvote + a post tip (kind boost, no cut), keyed, min amount, off = 404;
//     the card's tips tally leaves boosts out, the boosted total is its own
//   * /api/g/recipe/engagement needs the bot token; the staging seed is refused off staging
//   * profile vaults: boosts.vaultEligible + roomvaults.hasVault only while Pepe reports them on; the Creators cut on the
//     creator's own profile goes into the profile vault (not from an alt)
//   NODE_PATH=G:/PATV/node_modules node --test test/engagement.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engagement-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const web = require(path.join(repo, "feedweb"));
const PT = require(path.join(repo, "posttips"));
const E = require(path.join(repo, "engagement"));
const RV = require(path.join(repo, "roomvaults"));
const B = require(path.join(repo, "boosts"));
require(path.join(repo, "terms"))._setRequired(false);

const DAY = 86400000;
const T = Date.UTC(2026, 9, 12, 12, 0, 0);
const D0 = Date.UTC(2026, 9, 11, 0, 0, 0);          // the scored day
E._setClock(() => T);
const users = new Map();
const OLD = "2026-08-01 00:00:00";
async function mkUser(id, o = {}) {
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, isEmailVerified, discordId)
                  VALUES (?, ?, ?, 'x', 'pleb', ?, ?, ?, ?, ?, ?)`,
                 [id, o.username || id, o.username || id, o.bal || 0, o.camfrog === undefined ? id + "cf" : o.camfrog, o.level != null ? o.level : 5,
                  o.created || OLD, o.verified != null ? o.verified : 1, o.discord || null]);
  const u = { userId: id, username: o.username || id, class: "pleb" };
  users.set(id, u);
  return u;
}
let seq = 0;
async function post(author, pad, at = D0 - DAY) {
  const id = "p" + (++seq);
  await runQuery("INSERT INTO feed_posts (id, author_id, title, body, created, home_pad, global) VALUES (?, ?, 'a post', '', ?, ?, 1)", [id, author, at, pad]);
  await runQuery("INSERT INTO feed_post_rooms (post_id, room_id, created) VALUES (?, ?, ?)", [id, pad, at]);
  return id;
}
const up = (pid, uid, at = D0 + 3600e3) => runQuery(`INSERT INTO feed_votes (post_id, user_id, value, w, created, updated) VALUES (?, ?, 1, 1, ?, ?)
                                                    ON CONFLICT(post_id, user_id) DO UPDATE SET value = 1, updated = excluded.updated`, [pid, uid, at, at]);
const comment = (pid, uid, at = D0 + 7200e3) => runQuery("INSERT INTO feed_comments (id, post_id, author_id, body, created) VALUES (?, ?, ?, 'nice', ?)",
                                                       ["c" + (++seq), pid, uid, at]);
const boostRow = (pid, uid, to, amt, at = D0 + 9000e3) => runQuery(`INSERT INTO post_tips (post_id, sender_id, recipient_id, amount, kind, ref, created)
                                                                 VALUES (?, ?, ?, ?, 'boost', ?, ?)`, [pid, uid, to, amt, "b" + (++seq), at]);
const score = () => E.score({ day: "2026-10-11", start: D0, end: D0 + DAY });

async function idemBegin(req, res, endpoint) {
  const key = req.body && req.body.idempotency_key ? String(req.body.idempotency_key).slice(0, 120) : null;
  if (!key) return { replay: false, done: () => {}, fail: () => {} };
  await runQuery(`CREATE TABLE IF NOT EXISTS idempotency_keys (key TEXT PRIMARY KEY, endpoint TEXT NOT NULL, status INTEGER, body TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  const claimed = await runQuery("INSERT OR IGNORE INTO idempotency_keys (key, endpoint) VALUES (?, ?)", [key, endpoint]);
  if (!claimed || claimed.changes === 0) {
    const prev = await getQuery("SELECT status, body FROM idempotency_keys WHERE key = ?", [key]);
    if (prev.length && prev[0].status) res.status(prev[0].status).json(Object.assign(JSON.parse(prev[0].body || "{}"), { replayed: true }));
    else res.status(409).json({ ok: false, error: "in_progress" });
    return { replay: true };
  }
  return { replay: false, done: (s, b) => runQuery("UPDATE idempotency_keys SET status = ?, body = ? WHERE key = ?", [s, JSON.stringify(b || {}), key]),
           fail: () => runQuery("DELETE FROM idempotency_keys WHERE key = ? AND status IS NULL", [key]) };
}

let base, server;
const PAD = "DRAMA_CENTRAL";
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, isEmailVerified INTEGER DEFAULT 0, casino_banned INTEGER DEFAULT 0,
                  email TEXT)`);
  await runQuery(`CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, counterparty TEXT,
                  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery("CREATE TABLE IF NOT EXISTS dm_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (blocker_id, blocked_id))");
  await runQuery("CREATE TABLE IF NOT EXISTS welcome_bonus (userId TEXT PRIMARY KEY, state TEXT, created INTEGER, decided INTEGER, amount INTEGER, reason TEXT, dup_of TEXT, connect_owed INTEGER DEFAULT 0, source TEXT)");
  await runQuery("CREATE TABLE IF NOT EXISTS welcome_keys (k TEXT NOT NULL, userId TEXT NOT NULL, kind TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (k, userId))");
  await rooms.init();
  await store.init();
  await PT.ready();
  await store.setConfig({ posts_per_hour: 1000, posts_per_day: 1000, post_gap_secs: 0, comment_gap_secs: 0, comments_per_hour: 1000 }, "test");
  await rooms.addRoom(PAD, "DRAMA CENTRAL", "test");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  web.register(app, { addUser, isBotToken: (t) => t === "bot" });
  PT.register(app, { addUser, idemBegin });
  E.register(app, { addUser, idemBegin, isBotToken: (t) => t === "bot" });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });

const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {});
async function call(method, url, u, body) {
  const r = await fetch(base + url, { method, headers: H(u), body: body === undefined ? undefined : JSON.stringify(body) });
  let d = null;
  try { d = await r.json(); } catch (e) { d = null; }
  return { status: r.status, d };
}

test("only engagement from qualified others counts: the gates, self, alts (device key + dup_of), Pepe", async () => {
  await mkUser("author"); await mkUser("fanA"); await mkUser("fanB");
  await mkUser("young", { created: new Date(T - 3 * DAY).toISOString().replace("T", " ").slice(0, 19) });
  await mkUser("low", { level: 1 });
  await mkUser("unver", { verified: 0, camfrog: null });
  await mkUser("dupd"); await runQuery("INSERT INTO welcome_bonus (userId, state, dup_of) VALUES ('dupd', 'dup', 'someone')");
  await mkUser("altdev"); await runQuery("INSERT INTO welcome_keys (k, userId, kind, created) VALUES ('dev:X', 'author', 'dev', 0), ('dev:X', 'altdev', 'dev', 0)");
  await mkUser("altdup"); await runQuery("INSERT INTO welcome_bonus (userId, state, dup_of) VALUES ('altdup', 'dup', 'author')");
  const p = await post("author", PAD);
  for (const u of ["fanA", "fanB", "young", "low", "unver", "dupd", "altdev", "altdup", "author"]) await up(p, u);
  const s = await score();
  assert.equal(s.ok, true);
  const P = s.pads[PAD];
  assert.ok(P, "the pad has engagement");
  assert.equal(Math.round(P.raw * 100) / 100, 2, "two qualified upvotes (fanA, fanB) = 2");
  assert.equal(P.authors.author, Math.round(Math.sqrt(2) * 1000) / 1000, "post score = sqrt(2)");
  assert.equal(s.stats.self, 1);
  assert.equal(s.stats.alt, 2, "the shared-device alt and the dup_of alt are dropped");
  assert.ok(s.stats.unqualified >= 4, "young / low / unverified / flagged accounts don't count");
  assert.deepEqual(Object.keys(P.engagers).sort(), ["fanA", "fanB"]);
});

test("sqrt + caps: a viral post can't take everything; comments weigh 2; engagers are capped too", async () => {
  await mkUser("viral"); await mkUser("modest");
  const v = await post("viral", "PAD2.Room");
  const m = await post("modest", "PAD2.Room");
  for (let i = 0; i < 80; i++) { const u = "crowd" + i; await mkUser(u); await up(v, u); }
  await mkUser("talker");
  await up(m, "talker"); await comment(m, "talker"); await comment(m, "talker");     // 1 + 2 (comments once) = 3
  const s = await score();
  const P = s.pads["PAD2.Room"];
  const C = E.config();
  assert.equal(P.authors.viral, C.post_cap, "80 upvotes -> sqrt 8.9, capped at post_cap (6)");
  assert.equal(P.authors.modest, Math.round(Math.sqrt(3) * 1000) / 1000, "1 upvote + comments (once, weight 2) = sqrt(3)");
  assert.ok(P.authors.viral / P.authors.modest < 3.5, "the viral post earns ~3.5x, not 27x");
  assert.equal(P.engagers.talker, Math.round(Math.sqrt(3) * 1000) / 1000);
});

test("author cap per day: many posts don't add up past author_cap", async () => {
  await mkUser("spammer");
  for (let k = 0; k < 6; k++) {
    const p = await post("spammer", "PAD3.Room");
    for (let i = 0; i < 40; i++) await up(p, "crowd" + i);
  }
  const s = await score();
  assert.equal(s.pads["PAD3.Room"].authors.spammer, E.config().author_cap, "6 posts x 6 = 36 -> capped at 12");
});

test("like-rings: a mutual-voting cluster is down-weighted; a normal voter keeps weight 1", async () => {
  const ring = ["r1", "r2", "r3", "r4"];
  for (const r of ring) await mkUser(r);
  // 30 days of ring members upvoting each other's posts (and nobody else)
  for (let d = 1; d <= 6; d++) {
    for (const a of ring) {
      const p = await post(a, "RING.Room", D0 - d * DAY);
      for (const v of ring) if (v !== a) await up(p, v, D0 - d * DAY + 1000);
    }
  }
  // today: each ring member posts and the others upvote; a normal fan also upvotes r1 (and votes widely elsewhere)
  const today = {};
  for (const a of ring) {
    today[a] = await post(a, "RING.Room");
    for (const v of ring) if (v !== a) await up(today[a], v);
  }
  await mkUser("normal");
  for (let i = 0; i < 12; i++) { const other = await post("crowd" + i, "ELSE.Room", D0 - 2 * DAY); await up(other, "normal", D0 - 2 * DAY + 5000); }
  await up(today.r1, "normal");
  const s = await score();
  const P = s.pads["RING.Room"];
  const pure = 3;                                              // 3 upvotes without the ring weighting
  assert.ok(s.stats.ring_downweighted >= 12, `ring votes down-weighted (${s.stats.ring_downweighted})`);
  assert.ok(P.authors.r2 < Math.sqrt(pure) * 0.4, `a ring member's post earns a fraction (${P.authors.r2} vs ${Math.sqrt(pure).toFixed(3)})`);
  assert.ok(P.engagers.normal > P.engagers.r2, "the normal fan's one vote outweighs a ring member's three");
  const M = E.ringModel(new Map([["a|b", 5], ["b|a", 5], ["c|a", 1], ["c|x", 9], ["c|y", 9]]));
  assert.equal(M.weight("a", "b"), E.config().ring_floor, "only-each-other: the floor");
  assert.equal(M.weight("c", "a"), 1, "no reciprocity: weight 1");
});

test("pluggable weights: setVoteWeight / setBoostWeight; boosts count extra (diminishing, capped), never from an alt", async () => {
  await mkUser("creator"); await mkUser("booster"); await mkUser("bigbooster"); await mkUser("altboost");
  await runQuery("INSERT INTO welcome_keys (k, userId, kind, created) VALUES ('cf:Y', 'creator', 'cf', 0), ('cf:Y', 'altboost', 'cf', 0)");
  const p = await post("creator", "BOOST.Room");
  await up(p, "booster"); await boostRow(p, "booster", "creator", 400);          // 1 + sqrt(400/100) = 3
  await up(p, "bigbooster"); await boostRow(p, "bigbooster", "creator", 1e6);    // 1 + cap 5 = 6
  await up(p, "altboost"); await boostRow(p, "altboost", "creator", 1e6);        // an alt: nothing
  let s = await score();
  assert.equal(s.pads["BOOST.Room"].engagers.booster, Math.round(Math.sqrt(3) * 1000) / 1000);
  assert.equal(s.pads["BOOST.Room"].engagers.bigbooster, Math.round(Math.sqrt(6) * 1000) / 1000, "a huge boost is capped");
  assert.equal(s.pads["BOOST.Room"].engagers.altboost, undefined, "the author's alt's boost never counts");
  E.setVoteWeight(() => 0);                                        // e.g. upvotes priced: a free upvote counts 0
  E.setBoostWeight((a) => (a >= 100 ? 1 : 0));
  s = await score();
  assert.equal(s.pads["BOOST.Room"].engagers.booster, 1);
  E.setVoteWeight(null); E.setBoostWeight(null);
  assert.equal(E.defaultBoostWeight(99, E.config()), 0, "below the minimum a boost adds nothing");
});

test("boost upvote: the voter's upvote + a post tip (kind boost, no cut), keyed; min; own post refused; off = 404", async () => {
  const a = await mkUser("poster", { bal: 0 });
  const f = await mkUser("tipper", { bal: 5000 });
  const r0 = await call("POST", "/api/feed/posts", a, { community: "patv:lounge", title: "boost me", body: "x" });
  assert.equal(r0.status, 200, JSON.stringify(r0.d));
  const id = r0.d.id;
  assert.equal(E.config().boost_enabled, true, "boosts are ON by default, off staging too (prod)");
  E.setConfig({ boost_enabled: false });
  assert.equal((await call("POST", `/api/feed/posts/${id}/boost`, f, { amount: 100, idempotency_key: "k0" })).status, 404, "off: 404");
  assert.equal((await call("GET", "/api/feed/boost/config")).d.enabled, false);
  E.setConfig({ boost_enabled: true, boost_min: 100 });
  assert.equal((await call("POST", `/api/feed/posts/${id}/boost`, f, { amount: 50, idempotency_key: "k1" })).status, 400, "below the minimum");
  assert.equal((await call("POST", `/api/feed/posts/${id}/boost`, a, { amount: 100, idempotency_key: "k2" })).status, 400, "own post");
  const r = await call("POST", `/api/feed/posts/${id}/boost`, f, { amount: "1k", idempotency_key: "k3" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.vote, 1);
  assert.deepEqual(r.d.boosts, { n: 1, total: 1000 });
  assert.equal(r.d.balance, 4000);
  const again = await call("POST", `/api/feed/posts/${id}/boost`, f, { amount: "1k", idempotency_key: "k3" });
  assert.equal(again.d.replayed, true, "the same key replays the answer");
  assert.equal(Number((await getQuery("SELECT points_balance AS b FROM users WHERE userId = 'tipper'"))[0].b), 4000, "charged once");
  assert.equal(Number((await getQuery("SELECT points_balance AS b FROM users WHERE userId = 'poster'"))[0].b), 1000, "the author gets the full amount (no cut)");
  const v = (await getQuery("SELECT value FROM feed_votes WHERE post_id = ? AND user_id = 'tipper'", [id]))[0];
  assert.equal(v.value, 1, "a boost is also the voter's normal upvote");
  await call("POST", `/api/feed/posts/${id}/tip`, f, { amount: 300, idempotency_key: "t1" });
  const d = (await store.decorate([await store.getRow(id)], users.get("tipper")))[0];
  assert.deepEqual(d.tips, { n: 1, total: 300 }, "the tips tally leaves boosts out");
  assert.deepEqual(d.boosts, { n: 1, total: 1000 }, "the boosted total is its own");
});

test("the engagement endpoint needs the bot token; the seed is staging only", async () => {
  assert.equal((await call("POST", "/api/g/recipe/engagement", null, { password: "nope", day: "2026-10-11" })).status, 403);
  const r = await call("POST", "/api/g/recipe/engagement", null, { password: "bot", day: "2026-10-11", start: D0, end: D0 + DAY });
  assert.equal(r.status, 200);
  assert.ok(r.d.pads[PAD]);
  assert.equal((await call("POST", "/api/g/recipe/engagement/seed", null, { password: "bot" })).status, 403, "off staging the seed is refused");
});

test("profile vaults: eligible only while Pepe reports them on; the Creators cut on the creator's own profile", async () => {
  const P = await rooms.ensureProfile("creator");
  assert.ok(P && rooms.isProfile(P.id));
  RV._setProfileVaults(false);
  assert.equal(await B.vaultEligible(P.id), false);
  assert.equal(RV.hasVault(P.id), false);
  await RV.sync({ on: true, profile_vaults: true, rooms: [] });
  assert.equal(RV.profileVaultsOn(), true, "the sync turns them on");
  assert.equal(await B.vaultEligible(P.id), true);
  assert.equal(RV.hasVault(P.id), true);
  const c = await RV.card(P.id, null, {});
  assert.equal(c.profile, true);
  assert.equal(c.live, true);
  await RV.sync({ on: true, profile_vaults: false, rooms: [] });
  assert.equal(await B.vaultEligible(P.id), false, "and off again");
});

test("the Creators platform cut on the creator's own profile goes into the profile vault (not from an alt; off = Fort Knox)", async () => {
  const F = require(path.join(repo, "funding"));
  const CR = require(path.join(repo, "creators"));
  const P = await rooms.ensureProfile("creator");
  const flows = async () => (await getQuery("SELECT flow, amount FROM reserve_claims ORDER BY rowid DESC LIMIT 3")).map((r) => [r.flow, r.amount]);
  await runQuery(`CREATE TABLE IF NOT EXISTS reserve_claims (claimId TEXT PRIMARY KEY, flow TEXT NOT NULL, userId TEXT, type TEXT, amount INTEGER NOT NULL,
                  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, settled INTEGER DEFAULT 0)`);
  F.state.room_vaults = { on: true, cap: 50000000 };
  await RV.sync({ on: true, profile_vaults: true, rooms: [] });
  let legs = await CR.routeCutInTx(2000, { roomId: P.id, creatorId: "creator", fanId: "booster", ref: "t1", base: 10000 });
  assert.deepEqual(legs, [{ flow: `room:creators:${P.id}`, dest: "room", amount: 2000 }], "the whole cut into room:user:<creator>");
  assert.deepEqual((await flows())[0], [`room:creators:${P.id}`, -2000]);
  legs = await CR.routeCutInTx(2000, { roomId: P.id, creatorId: "creator", fanId: "altboost", ref: "t2", base: 10000 });
  assert.ok(!legs.some((l) => l.dest === "room"), "the creator's alt buying: no profile vault (Fort Knox)");
  await RV.sync({ on: true, profile_vaults: false, rooms: [] });
  legs = await CR.routeCutInTx(2000, { roomId: P.id, creatorId: "creator", fanId: "booster", ref: "t3", base: 10000 });
  assert.ok(!legs.some((l) => l.dest === "room"), "profile vaults off: as before (Fort Knox)");
  F.state.room_vaults = null;
});
