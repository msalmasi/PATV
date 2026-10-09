// Offline tests for the PAD LAUNCHPAD on the site (launchpad.js; camfrog-bot docs/ECONOMY-V2.md section 15; Pepe's
// pepe_launchpad.py):
//   * funding.sync: the launchpad state exists only while Pepe reports it (every sync resets it); cfg cleaned
//   * launch pads: user-owned pads registered after `since` (or enrolled); house / excluded / older pads never; no
//     `since` = nothing automatic (never retroactive)
//   * momentum + ANTI-FARMING: regulars = qualified people active on 2+ days; the owner and accounts sharing the owner's
//     identity keys never count; alts sharing a strong key are ONE person; welcome-dedupe duplicates, unlinked, too new
//     and low-level accounts don't count; a visit alone is not activity; active days need 3 people
//   * 1. graduations: one row per (pad, tier) ever (re-evaluation adds nothing), review on -> 'review', off ->
//     'approved'; admin approve / reject; Pepe's pending list + paid marks (idempotent; "paid" wins over a late reject)
//   * 2. newcomer welcomes: paid once per person globally (alts by key = the same person), per-pad cap, only while live
//     and the launchpad group + spendable budget (net of unsettled claims) cover it; CONSERVATION: wallet credits ==
//     the incentives:launchpad_welcome claims Pepe settles
//   * 4. boost credit: virtual boost PAT in the ranking map only (badges unaffected), first boost_days only, off = none
//   * routes: the public card (owner details only for the owner / staff), visits recorded, admin + bot gates
//   NODE_PATH=G:/PATV/node_modules node --test test/launchpad.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "launchpad-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.NODE_ENV = "test";
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const F = require(path.join(repo, "funding"));
const LP = require(path.join(repo, "launchpad"));
const B = require(path.join(repo, "boosts"));
const rooms = require(path.join(repo, "rooms"));
const S = require(path.join(repo, "mainstage"));

const DAY = 24 * 3600 * 1000;
const T0 = Date.now();
let T = T0;
LP._setClock(() => T); B._setClock(() => T);
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const sqlTime = (t) => new Date(t).toISOString().slice(0, 19).replace("T", " ");
const NEW = "NewPad.Room", OLDP = "OldPad.Room", HOUSE = "PepeBeta.Room", SITE = "patv:mysite";
let n = 0;
async function mkUser(extra = {}) {
  const id = extra.id || "u" + String(++n).padStart(3, "0");
  const name = extra.username || "user" + id;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, points_balance, camfrogUsername, discordId, twitchId, email, isEmailVerified, class, level, created_at)
                  VALUES (?, ?, ?, 'x', ?, ?, ?, NULL, NULL, 0, ?, ?, ?)`,
    [id, name, name, extra.bal != null ? extra.bal : 0, extra.camfrog === undefined ? name.toLowerCase() : extra.camfrog, extra.discord || null,
     extra.cls || "pleb", extra.level != null ? extra.level : 5, sqlTime(T0 - (extra.ageDays != null ? extra.ageDays : 60) * DAY)]);
  return { userId: id, username: name, class: extra.cls || "pleb" };
}
async function key(userId, kind, k) { await runQuery("INSERT OR IGNORE INTO welcome_keys (k, userId, kind, created) VALUES (?, ?, ?, ?)", [kind + ":" + k, userId, kind, T0]); }
async function chat(room, login, daysAgo, lines = 10, mic = 0) {
  await runQuery(`INSERT INTO econ_participation (room_id, day, login, lines, mic_min, cmds, active_min, updated) VALUES (?, ?, ?, ?, ?, 0, 30, ?)
                  ON CONFLICT(room_id, day, login) DO UPDATE SET lines = excluded.lines, mic_min = excluded.mic_min`, [room, dayOf(T0 - daysAgo * DAY), login.toLowerCase(), lines, mic, T0]);
}
const wallets = async () => (await getQuery("SELECT COALESCE(SUM(points_balance), 0) AS w FROM users"))[0].w;
const welcomeClaims = async () => (await getQuery("SELECT COALESCE(SUM(amount), 0) AS t, COUNT(*) AS n FROM reserve_claims WHERE flow = 'incentives:launchpad_welcome'"))[0];
const CFG = { weekly_cap: 1000000, keep_balance: 2000000, review: true, window_days: 14, max_age_days: 45, since: T0 - 4 * DAY, regular_days: 2,
              active_day_people: 3, min_account_days: 7, min_level: 2, chat_lines: 5, mic_min: 2,
              tiers: [[3, 2, 150000], [5, 3, 300000], [8, 4, 550000]],
              welcome_amount: 5000, welcome_min_age_hours: 24, welcome_per_pad: 4, match_days: 30, match_ratio_pct: 100, match_cap: 250000,
              boost_days: 7, boost_credit_pat: 10000 };
function syncLive(over = {}, lp = {}) {
  F.sync(Object.assign({ reserve: 5000000, flows: {}, fortknox: 1,
    incentives: { balance: 5000000, week: "W", remaining: { launchpad: 1000000 }, budgets: { launchpad: 1000000 }, groups: { launchpad_welcome: "launchpad" } },
    room_vaults: { on: true, cap: 50000000 },
    launchpad: Object.assign({ on: true, live: true, room_vaults: true, cfg: CFG, week: "W", budget: { cap: 1000000, left: 1000000 }, spendable: 1000000,
                               matched: { [NEW]: 40000 }, paid: {} }, lp) }, over));
}

let base, server, owner, ownerAlt, staff, people = {};
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordId TEXT, twitchId TEXT, email TEXT, isEmailVerified INTEGER DEFAULT 0,
                  level INTEGER DEFAULT 1, created_at TEXT, discordUsername TEXT, twitchDisplayname TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  await runQuery(`CREATE TABLE feed_posts (id TEXT PRIMARY KEY, author_id TEXT NOT NULL, created INTEGER NOT NULL, deleted_at INTEGER, hidden_at INTEGER)`);
  await runQuery(`CREATE TABLE feed_post_rooms (post_id TEXT NOT NULL, room_id TEXT NOT NULL, created INTEGER, removed_at INTEGER, PRIMARY KEY (post_id, room_id))`);
  await runQuery(`CREATE TABLE feed_comments (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, author_id TEXT NOT NULL, created INTEGER NOT NULL, deleted_at INTEGER)`);
  await require(path.join(repo, "econ")).ready;
  await require(path.join(repo, "welcome")).config;            // its tables are made on require
  await new Promise((r) => setTimeout(r, 200));
  owner = await mkUser({ username: "padowner" });
  ownerAlt = await mkUser({ username: "padowner2" });
  await key(owner.userId, "dev", "ownerbrowser");
  await key(ownerAlt.userId, "dev", "ownerbrowser");
  staff = await mkUser({ username: "boss", cls: "Admin", camfrog: null });
  for (const nm of ["ann", "ben", "cat", "dan", "eve", "fay"]) people[nm] = await mkUser({ username: nm });
  people.alt1 = await mkUser({ username: "annalt" });                 // ann's alt (same Discord)
  await key(people.ann.userId, "discord", "d-ann"); await key(people.alt1.userId, "discord", "d-ann");
  people.dup = await mkUser({ username: "dupe" });
  await runQuery("INSERT INTO welcome_bonus (userId, state, created, dup_of) VALUES (?, 'duplicate', ?, ?)", [people.dup.userId, T0, people.ben.userId]);
  people.young = await mkUser({ username: "young", ageDays: 0.5 });   // under both the 7-day and the 24-hour gate
  people.low = await mkUser({ username: "lowlvl", level: 1 });
  people.anon = await mkUser({ username: "anon", camfrog: null });   // no linked identity
  await S.init();
  await rooms.init();
  await B.init();
  await LP.init();
  await rooms.addRoom(NEW, "New Pad", "test");
  await rooms.setOwner(NEW, "padowner", "test");
  await rooms.addRoom(OLDP, "Old Pad", "test");
  await rooms.setOwner(OLDP, "padowner", "test");
  await runQuery("UPDATE rooms_registry SET created = ? WHERE room_id = ?", [T0 - 30 * DAY, OLDP]);
  await runQuery("UPDATE rooms_registry SET created = ? WHERE room_id IN (?, ?)", [T0 - 3.5 * DAY, NEW, SITE]);
  await rooms.addRoom(SITE, "My site pad", "test");
  await rooms.setOwner(SITE, "padowner", "test");
  await rooms.loadCache();
  const app = express();
  app.use(express.json());
  const isBotToken = (t) => t === "bot-token";
  let who = null;
  const addUser = (req, res, next) => { req.user = who; next(); };
  app.use((req, res, next) => { const h = req.headers["x-test-user"]; who = h === "owner" ? owner : h === "staff" ? staff : h === "eve" ? people.eve : null; next(); });
  LP.register(app, { addUser, isBotToken });
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());
const post = (p, body, user) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}) }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (p, user) => fetch(base + p, { headers: user ? { "x-test-user": user } : {} }).then(async (r) => ({ status: r.status, body: await r.json() }));

test("funding.sync: the launchpad exists only while Pepe reports it; cfg cleaned", () => {
  F.sync({ reserve: 1, flows: {} });
  assert.equal(F.state.launchpad, null);
  assert.equal(LP.isOn(), false);
  syncLive();
  assert.equal(LP.isOn(), true);
  assert.equal(LP.isLive(), true);
  assert.deepEqual(LP.cfg().tiers, CFG.tiers);
  F.sync({ reserve: 1, flows: {}, launchpad: { on: false } });
  assert.equal(F.state.launchpad, null, "on: false = off");
  const c = LP.cleanState({ on: true, cfg: { tiers: [[5, 1, 1], [3, 1, 1]], weekly_cap: "x" } }).cfg;
  assert.deepEqual(c.tiers, LP.DEFAULTS.tiers, "falling tiers -> defaults");
  assert.equal(c.weekly_cap, LP.DEFAULTS.weekly_cap);
});

test("launch pads: new user-owned pads after `since`, enrollments, exclusions; never retroactive", async () => {
  syncLive();
  let pads = (await LP.launchPads()).map((p) => p.id).sort();
  assert.deepEqual(pads, [NEW, SITE].sort(), "the old pad and house pads are not launch pads");
  await LP.setPad(OLDP, "enroll", "boss");
  assert.ok((await LP.launchPads()).find((p) => p.id === OLDP && p.enrolled && p.start === T), "an admin can enroll an older pad (launch starts now)");
  await LP.setPad(OLDP, "exclude", "boss");
  assert.ok(!(await LP.launchPads()).find((p) => p.id === OLDP), "excluded");
  await assert.rejects(LP.setPad(HOUSE, "enroll", "boss"), /House/);
  syncLive({}, { cfg: Object.assign({}, CFG, { since: 0 }) });
  assert.deepEqual((await LP.launchPads()).map((p) => p.id), [], "since 0 (never armed): nothing automatic");
  syncLive();
});

test("momentum + anti-farming: owner, alts, duplicates, new / low-level / unlinked accounts never count", async () => {
  syncLive();
  const pad = (await LP.launchPads()).find((p) => p.id === NEW);
  // the owner and the owner's alt (same browser key) chat a lot on 3 days
  for (const d of [0, 1, 2]) { await chat(NEW, "padowner", d, 50, 30); await chat(NEW, "padowner2", d, 50); }
  // ann + her alt, and people who must not count, on 2 days each
  for (const nm of ["ann", "annalt", "dupe", "young", "lowlvl"]) for (const d of [0, 1]) await chat(NEW, nm, d);
  // ben: 1 day only (not a regular); cat: 2 days by mic only
  await chat(NEW, "ben", 0);
  await chat(NEW, "cat", 0, 0, 5); await chat(NEW, "cat", 1, 0, 5);
  // dan: chats once, then only visits on another day -> returning; eve: visits only -> nothing
  await chat(NEW, "dan", 0);
  await runQuery("INSERT INTO launchpad_visits (room_id, user_id, day) VALUES (?, ?, ?)", [NEW, people.dan.userId, dayOf(T0 - DAY)]);
  await runQuery("INSERT INTO launchpad_visits (room_id, user_id, day) VALUES (?, ?, ?), (?, ?, ?)", [NEW, people.eve.userId, dayOf(T0), NEW, people.eve.userId, dayOf(T0 - DAY)]);
  // anon (unlinked) posts on the website
  await runQuery("INSERT INTO feed_posts (id, author_id, created) VALUES ('p1', ?, ?)", [people.anon.userId, T0 - 1000]);
  await runQuery("INSERT INTO feed_post_rooms (post_id, room_id, created) VALUES ('p1', ?, ?)", [NEW, T0 - 1000]);
  const m = await LP.metrics(pad, T, { fresh: true });
  assert.equal(m.regulars, 3, `regulars = ann (+ alt as one person), cat (mic), dan (chat + visit) - got ${m.regulars}`);
  assert.equal(m.excluded.owner, 2, "the owner + the owner's alt");
  assert.equal(m.excluded.duplicate, 1);
  assert.equal(m.excluded["too new"], 1);
  assert.equal(m.excluded["low level"], 1);
  assert.equal(m.excluded.unlinked, 1);
  assert.equal(m.active_days, 1, "today: ann, ben, cat, dan = 4 people; yesterday: ann (+ alt), cat = 2 people (dan's visit isn't activity)");
  assert.deepEqual(m.reached, [], "tier 1 needs 3 regulars AND 2 active days (yesterday only had 2 people)");
  await chat(NEW, "fay", 1);
  await chat(NEW, "fay", 0);
  const m2 = await LP.metrics(pad, T, { fresh: true });
  assert.equal(m2.regulars, 4);
  assert.equal(m2.active_days, 2);
  assert.deepEqual(m2.reached, [1], "tier 1 reached");
  assert.equal(LP.clusters(["a", "b", "c"], new Map([["a", new Set(["k1"])], ["c", new Set(["k1"])]])).get("c"), "a", "key clusters: one person");
});

test("1. graduations: one row per (pad, tier) ever; review queue; Pepe's pending + paid marks", async () => {
  syncLive();
  const pad = (await LP.launchPads()).find((p) => p.id === NEW);
  const m = await LP.metrics(pad, T, { fresh: true });
  assert.deepEqual(await LP.recordGrads(pad, m), [1]);
  assert.deepEqual(await LP.recordGrads(pad, m), [], "re-evaluation records nothing new");
  let g = (await getQuery("SELECT * FROM launchpad_grads WHERE room_id = ?", [NEW]))[0];
  assert.equal(g.state, "review");
  assert.equal(g.amount, 150000);
  let p = await LP.pending();
  assert.equal(p.grants.length, 0, "nothing approved yet");
  assert.ok(p.pads.find((x) => x.room_id === NEW && x.owner_camfrog === "padowner"), "Pepe gets the launch pads (owner match)");
  const r1 = await post("/api/admin/launchpad/grad", { id: g.id, action: "approve" }, "eve");
  assert.equal(r1.status, 403, "admins only");
  const r2 = await post("/api/admin/launchpad/grad", { id: g.id, action: "approve" }, "staff");
  assert.equal(r2.status, 200);
  assert.equal(r2.body.grad.state, "approved");
  const bad = await post("/api/g/launchpad/pending", { password: "nope" });
  assert.equal(bad.status, 403, "bot token required");
  p = (await post("/api/g/launchpad/pending", { password: "bot-token" })).body;
  assert.deepEqual(p.grants.map((x) => [x.room_id, x.tier]), [[NEW, 1]]);
  const mk = { password: "bot-token", id: g.id, room_id: NEW, tier: 1, state: "paid", amount: 150000, tid: "lp-grant-x" };
  assert.equal((await post("/api/g/launchpad/paid", mk)).body.ok, true);
  assert.equal((await post("/api/g/launchpad/paid", mk)).body.dup, true, "a replayed mark is a no-op");
  assert.equal((await post("/api/g/launchpad/paid", { ...mk, tier: 2 })).status, 404, "a mark must match the row");
  g = (await getQuery("SELECT * FROM launchpad_grads WHERE id = ?", [g.id]))[0];
  assert.equal(g.state, "paid"); assert.equal(g.paid_amount, 150000);
  await assert.rejects(LP.decide(g.id, "reject", "late", "boss"), /Already paid/);
  assert.equal((await LP.pending()).grants.length, 0, "paid rows are never handed out again");
  // review OFF: approved straight away; a late admin reject is overridden by Pepe's "paid"
  syncLive({}, { cfg: Object.assign({}, CFG, { review: false }) });
  await chat(NEW, "eve", 0); await chat(NEW, "eve", 1); await chat(NEW, "ben", 1); await chat(NEW, "dan", 1);
  for (const nm of ["eve", "ben", "dan"]) await chat(NEW, nm, 2);       // a third active day
  const m2 = await LP.metrics(pad, T, { fresh: true });
  assert.ok(m2.reached.includes(2), `tier 2 reached (${m2.regulars} regulars, ${m2.active_days} days)`);
  await LP.recordGrads(pad, m2);
  const g2 = (await getQuery("SELECT * FROM launchpad_grads WHERE room_id = ? AND tier = 2", [NEW]))[0];
  assert.equal(g2.state, "approved");
  await LP.decide(g2.id, "reject", "changed my mind", "boss");
  await LP.markPaid({ id: g2.id, room_id: NEW, tier: 2, state: "paid", amount: 300000, tid: "t2" });
  assert.equal((await getQuery("SELECT state FROM launchpad_grads WHERE id = ?", [g2.id]))[0].state, "paid", "money moved in Pepe: paid wins");
  syncLive();
});

test("2. newcomer welcomes: once per person, per-pad cap, budget-gated; CONSERVATION", async () => {
  syncLive();
  const pad = (await LP.launchPads()).find((p) => p.id === NEW);
  const w0 = await wallets(), c0 = await welcomeClaims();
  const m = await LP.metrics(pad, T, { fresh: true });
  const paid = await LP.payWelcomes(pad, m);
  assert.equal(paid, 4, "the per-pad cap (4) stops it");
  const rows = await getQuery("SELECT user_id, state FROM launchpad_welcomes WHERE room_id = ? AND state = 'paid'", [NEW]);
  const ids = rows.map((r) => r.user_id);
  assert.ok(!ids.includes(owner.userId) && !ids.includes(ownerAlt.userId), "never the owner");
  assert.ok(!ids.includes(people.dup.userId) && !ids.includes(people.anon.userId) && !ids.includes(people.young.userId), "never dups / unlinked / too new");
  assert.ok(!(ids.includes(people.ann.userId) && ids.includes(people.alt1.userId)), "ann and her alt are one person");
  const c1 = await welcomeClaims();
  assert.equal(c1.n - c0.n, 4);
  assert.equal((await wallets()) - w0, c1.t - c0.t, "CONSERVATION: wallet credits == the claims Pepe settles from incentives");
  assert.equal(c1.t - c0.t, 20000);
  const tx = await getQuery("SELECT COUNT(*) AS n FROM transactions WHERE transactionId LIKE 'lpw-%'");
  assert.equal(tx[0].n, 4, "one ledger row each, transaction id lpw-<user>");
  // the same people in another pad: never again (global), and the cap blocks the rest here
  const site = (await LP.launchPads()).find((p) => p.id === SITE);
  for (const id of ids) {
    await runQuery("INSERT INTO feed_posts (id, author_id, created) VALUES (?, ?, ?)", ["s" + id, id, T0 - 500]);
    await runQuery("INSERT INTO feed_post_rooms (post_id, room_id, created) VALUES (?, ?, ?)", ["s" + id, SITE, T0 - 500]);
  }
  const ms = await LP.metrics(site, T, { fresh: true });
  assert.equal(await LP.payWelcomes(site, ms), 0, "already welcomed people are never paid again in another pad");
  assert.equal(await LP.payWelcomes(pad, await LP.metrics(pad, T, { fresh: true })), 0, "re-run: nothing more");
  // budget-gated: the unsettled claims count against the group
  await runQuery("UPDATE launchpad_welcomes SET state = 'test' WHERE room_id = ?", [NEW]);   // free the cap for the check
  syncLive({ incentives: { balance: 2015000, week: "W", remaining: { launchpad: 1000000 }, budgets: {}, groups: { launchpad_welcome: "launchpad" } } });
  assert.equal(await LP.welcomeRoom(), 0, "2,015,000 - 2,000,000 kept - 20,000 unsettled = nothing to spend");
  assert.equal(await LP.payWelcomes(pad, await LP.metrics(pad, T, { fresh: true })), 0, "not paid when the budget can't cover it");
  syncLive({}, { live: false });
  assert.equal(await LP.payWelcomes(pad, await LP.metrics(pad, T, { fresh: true })), 0, "not live: nothing paid");
  await runQuery("UPDATE launchpad_welcomes SET state = 'paid' WHERE state = 'test'");
  syncLive();
});

test("4. boost credit: virtual boost in the ranking map only, first boost_days, off = none", async () => {
  syncLive();
  await LP.evaluate(T);
  const plain = await B.activeMap(T, 60);
  const scored = await B.activeMap(T, 60, { credits: true });
  assert.equal(plain.get(NEW) || 0, 0, "the badges' map has no credit (no PAT was spent)");
  assert.equal(scored.get(NEW), 10000, "the ranking map gets 10,000 virtual boost PAT");
  assert.equal(scored.get(OLDP) || 0, 0, "not for a pad that isn't launching");
  T = T0 + 8 * DAY;
  await LP.evaluate(T);
  assert.equal((await B.activeMap(T, 60, { credits: true })).get(NEW) || 0, 0, "after boost_days: none");
  T = T0;
  F.sync({ reserve: 1, flows: {} });
  assert.equal(LP.boostCredits().size, 0, "launchpad off: no credit");
  syncLive();
  await LP.evaluate(T);
});

test("routes: the public card, owner details, visits", async () => {
  syncLive();
  const slug = (await rooms.get(NEW)).slug;
  const anon = await get(`/api/rooms/${slug}/launch`);
  assert.equal(anon.status, 200);
  assert.equal(anon.body.eligible, true);
  assert.ok(anon.body.progress.regulars >= 4 && anon.body.progress.next, "progress toward the next tier");
  assert.equal(anon.body.owner, undefined, "no owner details for the public");
  assert.equal(anon.body.tiers[0].state, "paid");
  const own = await get(`/api/rooms/${slug}/launch`, "owner");
  assert.ok(own.body.owner && own.body.owner.excluded.owner >= 1, "the owner sees who didn't count");
  assert.equal(own.body.owner.match.used, 40000, "the owner sees Pepe's match total");
  const before = (await getQuery("SELECT COUNT(*) AS n FROM launchpad_visits WHERE user_id = ?", [people.eve.userId]))[0].n;
  await runQuery("DELETE FROM launchpad_visits WHERE user_id = ? AND day = ?", [people.eve.userId, dayOf(T0)]);
  await get(`/api/rooms/${slug}/launch`, "eve");
  const after = (await getQuery("SELECT COUNT(*) AS n FROM launchpad_visits WHERE user_id = ?", [people.eve.userId]))[0].n;
  assert.equal(after, before, "a signed-in view records today's visit (once)");
  const old = await get(`/api/rooms/${(await rooms.get(OLDP)).slug}/launch`);
  assert.equal(old.body.eligible, false, "an excluded / old pad shows nothing");
  const adm = await get("/api/admin/launchpad", "staff");
  assert.equal(adm.status, 200);
  assert.ok(adm.body.grads.length >= 2 && adm.body.pads.find((p) => p.id === NEW));
  assert.equal((await get("/api/admin/launchpad", "eve")).status, 403);
  F.sync({ reserve: 1, flows: {} });
  const off = await get(`/api/rooms/${slug}/launch`);
  assert.equal(off.body.on, false, "off: the card hides");
});
