// 1.99fy security hotfix: bot-only user lookups with a minimal field set (userlookup.js), the
// transactional Twitch / Discord account merge (providermerge.js), unique Twitch / Discord ids, the
// connect bonus paid once under a race (welcome.js) and the verified-email-only OAuth auto-link.
//   NODE_PATH=G:/PATV/node_modules node --test test/security-hotfix.test.js   (temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sec-hotfix-test-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const stale = require(path.join(repo, "staleaccounts"));
const userlookup = require(path.join(repo, "userlookup"));
const providerMerge = require(path.join(repo, "providermerge"));
const welcome = require(path.join(repo, "welcome"));

const TWITCH = { label: "Twitch", idCol: "twitchId", nameCol: "twitchDisplayname", otherIdCol: "discordId", otherNameCol: "discordUsername" };
const SECRET_KEYS = /password|email|token|reset/i;

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, displayname TEXT, class TEXT DEFAULT 'pleb',
    email TEXT, password TEXT NOT NULL DEFAULT 'x', points_balance REAL DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0,
    liked INTEGER DEFAULT 0, discordId TEXT, discordUsername TEXT, twitchId TEXT, twitchDisplayname TEXT, twitchLogin TEXT,
    camfrogUsername TEXT, emailVerificationToken TEXT, tokenExpires DATETIME, isEmailVerified INTEGER DEFAULT 0,
    resetPasswordToken TEXT, resetPasswordExpires DATETIME, twitchBonus INTEGER DEFAULT 0, discordBonus INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT, note TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS reserve_claims (claimId TEXT PRIMARY KEY, flow TEXT, userId TEXT, type TEXT, amount INTEGER, created DATETIME DEFAULT CURRENT_TIMESTAMP, settled INTEGER DEFAULT 0)");
  await runQuery("CREATE TABLE IF NOT EXISTS user_badges (userId TEXT, badgeId TEXT, awardedAt TEXT, PRIMARY KEY (userId, badgeId))");
  await runQuery("CREATE TABLE IF NOT EXISTS stage_slots (id INTEGER PRIMARY KEY, userId TEXT, status TEXT, settled INTEGER DEFAULT 0)");
  await runQuery("CREATE TABLE IF NOT EXISTS rooms_registry (room_id TEXT PRIMARY KEY, owner_user_id TEXT)");
  await runQuery("CREATE TABLE IF NOT EXISTS welcome_bonus_x (k TEXT)");    // unrelated table: moveUserRows skips what isn't there
  assert.equal(await stale.ensure(), true);

  const app = express();
  userlookup.register(app, { isPlatformBot: (t) => t === "bot-token", stale });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());

let n = 0;
async function user(id, o = {}) {
  await runQuery(`INSERT INTO users (userId, username, email, password, points_balance, xp, level, liked, discordId, discordUsername,
      twitchId, twitchDisplayname, twitchLogin, camfrogUsername, emailVerificationToken, resetPasswordToken, isEmailVerified)
    VALUES (?, ?, ?, '$2b$12$hashhashhash', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verify-tok', 'reset-tok', ?)`,
  [id, o.username || id, o.email || `${id}@example.com`, o.bal || 0, o.xp || 0, o.level || 0, o.liked || 0, o.discord || null,
    o.discord ? "d_" + id : null, o.twitch || null, o.twitch ? "T_" + id : null, o.twitch ? "t_" + id : null, o.cf || null, o.verified ? 1 : 0]);
  if (o.bal) await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, 'bonus win', ?)", ["tx" + ++n, id, o.bal]);
}
const row = async (id) => (await getQuery("SELECT * FROM users WHERE userId = ?", [id]))[0];
const get = (p, headers = {}) => fetch(base + p, { headers });

// ── lookups ──
test("lookups: no token -> 401, wrong token -> 403, for all three routes", async () => {
  await user("lk1", { discord: "D100", twitch: "T100", bal: 500 });
  for (const p of ["/api/users/discord/D100", "/api/users/twitch/T100", "/api/users/twitch/displayname/T_lk1"]) {
    assert.equal((await get(p)).status, 401, p);
    assert.equal((await get(p, { "x-bot-token": "nope" })).status, 403, p);
    assert.equal((await get(p, { authorization: "Bearer nope" })).status, 403, p);
    const body = await (await get(p)).json();
    assert.equal(body.user, undefined);
  }
});

test("lookups: the bot token gets a minimal field set - no password / email / token / reset keys", async () => {
  for (const [p, h] of [["/api/users/discord/D100", { "x-bot-token": "bot-token" }],
                        ["/api/users/twitch/T100", { authorization: "Bearer bot-token" }],
                        ["/api/users/twitch/displayname/T_lk1", { "x-bot-token": "bot-token" }]]) {
    const r = await get(p, h);
    assert.equal(r.status, 200, p);
    const { user: u } = await r.json();
    assert.equal(u.userId, "lk1");
    assert.equal(u.username, "lk1");
    assert.equal(u.points_balance, 500);
    assert.equal(u.discordId, "D100");
    assert.equal(u.twitchId, "T100");
    for (const k of Object.keys(u)) {
      assert.ok(userlookup.LOOKUP_FIELDS.includes(k), `unexpected field ${k}`);
      assert.ok(!SECRET_KEYS.test(k), `secret field ${k}`);
    }
    const raw = JSON.stringify(u);
    for (const s of ["hashhash", "verify-tok", "reset-tok", "@example.com"]) assert.ok(!raw.includes(s), `${s} leaked`);
  }
  assert.equal((await get("/api/users/discord/nobody", { "x-bot-token": "bot-token" })).status, 404);
});

test("lookups: touch() (un-archive) only fires for the bot", async () => {
  await user("lk2", { discord: "D200", twitch: "T200", bal: 7000 });
  await stale.archiveOne("lk2", { runId: "t", tier: "A", why: "test" });
  assert.notEqual((await row("lk2")).archived_at, null);
  assert.equal((await get("/api/users/discord/D200")).status, 401);
  assert.equal((await get("/api/users/twitch/T200")).status, 401);
  assert.notEqual((await row("lk2")).archived_at, null, "an unauthenticated caller un-archived it");
  assert.equal((await row("lk2")).points_balance, 0);
  const r = await get("/api/users/twitch/T200", { "x-bot-token": "bot-token" });
  const { user: u } = await r.json();
  assert.equal((await row("lk2")).archived_at, null);
  assert.equal(u.points_balance, 7000);
});

// ── merges ──
test("merge: a parallel double submit credits once; a later replay finds nothing", async () => {
  await user("to1", { bal: 100, xp: 5, level: 1, liked: 1 });
  await user("from1", { twitch: "T300", discord: "D300", bal: 1000, xp: 50, level: 3, liked: 2, cf: "frogguy" });
  const args = { provider: "twitch", L: TWITCH, fromId: "from1", toId: "to1", linkId: "T300", linkName: "T300name" };
  const rs = await Promise.all([providerMerge.mergeProviderAccount(args), providerMerge.mergeProviderAccount(args)]);
  assert.equal(rs.filter((r) => r.ok).length, 1, JSON.stringify(rs));
  const again = await providerMerge.mergeProviderAccount(args);
  assert.equal(again.ok, false);
  const to = await row("to1");
  assert.equal(to.points_balance, 1100);
  assert.equal(to.xp, 55);
  assert.equal(to.level, 3);
  assert.equal(to.liked, 3);
  assert.equal(to.twitchId, "T300");
  assert.equal(to.discordId, "D300");              // the other provider came along (to had none)
  assert.equal(to.camfrogUsername, "frogguy");
  assert.equal(await row("from1"), undefined);
  // the ledger adds up: moved history + a 0-PAT "account merge" row
  const sum = (await getQuery("SELECT SUM(points) AS s FROM transactions WHERE userId = 'to1'"))[0].s;
  assert.equal(sum, 1100);
  const m = await getQuery("SELECT * FROM transactions WHERE userId = 'to1' AND type = 'account merge'");
  assert.equal(m.length, 1);
  assert.equal(m[0].points, 0);
  // the archive snapshot of the old row: no password / email / tokens
  const a = (await getQuery("SELECT * FROM account_archive WHERE userId = 'from1'"))[0];
  assert.equal(a.tier, "MERGE");
  assert.equal(a.balance, 1000);
  const snap = JSON.parse(a.snapshot);
  assert.equal(snap.username, "from1");
  assert.equal(snap.merged_into, "to1");
  for (const k of Object.keys(snap)) assert.ok(!SECRET_KEYS.test(k), `snapshot has ${k}`);
});

test("merge: the old account no longer holding the id -> nothing moves", async () => {
  await user("to2", { bal: 10 });
  await user("from2", { twitch: "T400", bal: 900 });
  const r = await providerMerge.mergeProviderAccount({ provider: "twitch", L: TWITCH, fromId: "from2", toId: "to2", linkId: "T-other", linkName: "x" });
  assert.deepEqual([r.ok, r.code], [false, "changed"]);
  assert.equal((await row("to2")).points_balance, 10);
  assert.equal((await row("from2")).points_balance, 900);
});

test("merge: a crash partway rolls everything back", async () => {
  await user("to3", { bal: 5 });
  await user("from3", { twitch: "T500", bal: 4000, xp: 9 });
  await runQuery(`CREATE TRIGGER crash_from3 BEFORE DELETE ON users WHEN OLD.userId = 'from3'
                  BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`);
  await assert.rejects(providerMerge.mergeProviderAccount({ provider: "twitch", L: TWITCH, fromId: "from3", toId: "to3", linkId: "T500", linkName: "x" }),
                       /simulated crash/);
  await runQuery("DROP TRIGGER crash_from3");
  const from = await row("from3"), to = await row("to3");
  assert.equal(from.points_balance, 4000);
  assert.equal(from.twitchId, "T500");
  assert.equal(to.points_balance, 5);
  assert.equal(to.twitchId, null);
  assert.equal((await getQuery("SELECT COUNT(*) AS c FROM transactions WHERE userId = 'from3'"))[0].c, 1);
  assert.equal((await getQuery("SELECT COUNT(*) AS c FROM transactions WHERE userId = 'to3' AND type = 'account merge'"))[0].c, 0);
  // and it still works afterwards (the connection isn't left inside a transaction)
  const ok = await providerMerge.mergeProviderAccount({ provider: "twitch", L: TWITCH, fromId: "from3", toId: "to3", linkId: "T500", linkName: "x" });
  assert.equal(ok.ok, true);
  assert.equal((await row("to3")).points_balance, 4005);
});

test("merge: holds (stage slot, room owner) refuse the merge; a pending welcome bonus does not", async () => {
  await user("to4", { bal: 1 });
  await user("from4", { twitch: "T600", bal: 3000 });
  await runQuery("INSERT INTO stage_slots (userId, status, settled) VALUES ('from4', 'booked', 0)");
  let r = await providerMerge.mergeProviderAccount({ provider: "twitch", L: TWITCH, fromId: "from4", toId: "to4", linkId: "T600", linkName: "x" });
  assert.deepEqual([r.ok, r.code], [false, "holds"]);
  assert.ok(r.holds.includes("stage slot"));
  await runQuery("UPDATE stage_slots SET status = 'ended', settled = 1 WHERE userId = 'from4'");
  await runQuery("INSERT INTO rooms_registry (room_id, owner_user_id) VALUES ('frogs', 'from4')");
  r = await providerMerge.mergeProviderAccount({ provider: "twitch", L: TWITCH, fromId: "from4", toId: "to4", linkId: "T600", linkName: "x" });
  assert.deepEqual([r.ok, r.code], [false, "holds"]);
  assert.ok(r.holds.includes("room owner"));
  assert.equal((await row("from4")).points_balance, 3000);
  assert.equal((await row("to4")).points_balance, 1);
  await runQuery("DELETE FROM rooms_registry WHERE owner_user_id = 'from4'");
  // bot-made accounts nearly always have a pending welcome bonus - that must not block
  await runQuery("INSERT INTO welcome_bonus (userId, state, created) VALUES ('from4', 'pending', ?)", [Date.now()]);
  r = await providerMerge.mergeProviderAccount({ provider: "twitch", L: TWITCH, fromId: "from4", toId: "to4", linkId: "T600", linkName: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("merge: an archived old account is restored first, so its archived PAT comes along", async () => {
  await user("to5", { bal: 0 });
  await user("from5", { twitch: "T700", bal: 25000 });
  await stale.archiveOne("from5", { runId: "t", tier: "A2", why: "test" });
  assert.equal((await row("from5")).points_balance, 0);
  const r = await providerMerge.mergeProviderAccount({ provider: "twitch", L: TWITCH, fromId: "from5", toId: "to5", linkId: "T700", linkName: "x" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.amount, 25000);
  assert.equal((await row("to5")).points_balance, 25000);
});

// ── unique ids ──
test("unique indexes: one account per Twitch id / Discord id; duplicates -> logged, no crash", async () => {
  const ok = await userlookup.ensureProviderUnique();
  assert.deepEqual(ok, { twitchId: true, discordId: true });
  await assert.rejects(user("dupT", { twitch: "T100" }), /UNIQUE/);
  await assert.rejects(user("dupD", { discord: "D100" }), /UNIQUE/);
  await runQuery("INSERT INTO users (userId, username, twitchId) VALUES ('n1', 'n1', NULL), ('n2', 'n2', NULL), ('e1', 'e1', ''), ('e2', 'e2', '')");
  // a database that already has duplicates: refused, logged, never thrown
  await runQuery("DROP INDEX users_twitch_id");
  await runQuery("INSERT INTO users (userId, username, twitchId) VALUES ('dupT2', 'dupT2', 'T100')");
  const errs = [];
  const orig = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  try { assert.deepEqual(await userlookup.ensureProviderUnique(), { twitchId: false, discordId: true }); }
  finally { console.error = orig; }
  assert.ok(errs.some((e) => /unique twitchId index not built/.test(e)));
  await runQuery("DELETE FROM users WHERE userId = 'dupT2'");
  assert.deepEqual(await userlookup.ensureProviderUnique(), { twitchId: true, discordId: true });
});

// ── connect bonus ──
test("connect bonus: paid once per Twitch id, even when two links race", async () => {
  await user("cb1", {});
  await user("cb2", {});
  const paid = [];
  const award = async (uid, type, amt) => { paid.push([uid, type, amt]); };
  const rs = await Promise.all([
    welcome.connectBonus("cb1", "twitch", "T-race", award),
    welcome.connectBonus("cb2", "twitch", "T-race", award),
    welcome.connectBonus("cb1", "twitch", "T-race", award),
  ]);
  assert.equal(paid.length, 1, JSON.stringify(rs));
  assert.equal(rs.filter((x) => x === "paid").length, 1);
  assert.equal(rs.filter((x) => x === "dup").length, 2);
  assert.equal(await welcome.connectBonus("cb2", "twitch", "T-race", award), "dup");
  assert.equal(paid.length, 1);
});

// ── email auto-link ──
test("OAuth email auto-link: only into a verified email with no other id for that provider", async () => {
  assert.equal(providerMerge.emailLinkable({ isEmailVerified: 0, twitchId: null }, "twitchId", "T1"), false);
  assert.equal(providerMerge.emailLinkable({ isEmailVerified: null, discordId: null }, "discordId", "D1"), false);
  assert.equal(providerMerge.emailLinkable({ isEmailVerified: 1, twitchId: "T-else" }, "twitchId", "T1"), false);
  assert.equal(providerMerge.emailLinkable({ isEmailVerified: 1, twitchId: null }, "twitchId", "T1"), true);
  assert.equal(providerMerge.emailLinkable({ isEmailVerified: 1, discordId: "D1" }, "discordId", "D1"), true);
  assert.equal(providerMerge.emailLinkable(null, "twitchId", "T1"), false);
  // both callbacks refuse before linking or creating an account
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  for (const [v, col, label] of [["existingTwitchEmail", "twitchId", "Twitch"], ["existingDiscordEmail", "discordId", "Discord"]]) {
    const i = src.indexOf(`if (${v}.length > 0 && !providerMerge.emailLinkable(${v}[0], "${col}"`);
    assert.ok(i > 0, `${label} callback gate missing`);
    assert.ok(src.indexOf(`then link ${label} from your profile`, i) > i);
    assert.ok(i < src.indexOf(`if (${v}.length > 0) {`), `${label} gate must come before the auto-link`);
  }
});

test("index.js: the old open SELECT * lookups are gone", () => {
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  assert.ok(!/app\.get\(['"]\/api\/users\/(discord|twitch)\//.test(src));
  assert.ok(!/SELECT \* FROM users WHERE twitchDisplayname/.test(src));
  assert.ok(src.includes('require("./userlookup").register(app, { isPlatformBot, stale })'));
});
