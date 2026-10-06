// Welcome bonus (1.99bg, welcome.js): no cash at sign-up, vests after real play, once per person
// (Camfrog identity / Discord / Twitch / email / browser / network), paid from the Reserve and retried
// when it can't cover it, connect bonuses once per platform id and held until the welcome vests, the
// one-off backfill (no clawback), admin "pay anyway".
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "welcome-"));
process.chdir(dir);                                      // dbUtils opens ./myapp.db
const repo = path.join(__dirname, "..");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const funding = require(path.join(repo, "funding"));
const paid = [];
let reserve = 1e9;
funding.fundPayout = async (userId, amount, flow, type) => {
  if (reserve < amount) return false;
  reserve -= amount;
  paid.push({ userId, amount, flow, type });
  await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, ?, ?)", [String(Math.random()), userId, type, amount]);
  return true;
};
const connects = [];
const award = async (userId, type, amount) => { connects.push({ userId, type, amount }); };
let welcome;
const setup = (async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT, camfrogUsername TEXT, discordId TEXT, twitchId TEXT,
    email TEXT, isEmailVerified INTEGER DEFAULT 0, level INTEGER DEFAULT 0, discordBonus INTEGER DEFAULT 0, twitchBonus INTEGER DEFAULT 0,
    points_balance INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, displayname TEXT)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS bonus_winners (bonusId TEXT, type TEXT, userId TEXT, transactionId TEXT, amount INTEGER, timestamp DATETIME)");
  await runQuery("CREATE TABLE IF NOT EXISTS camfrog_userstats (login TEXT PRIMARY KEY, data TEXT NOT NULL, updated INTEGER)");
  welcome = require(path.join(repo, "welcome"));
  await welcome.ready;
  require(path.join(repo, "inbox")).addSafe = async () => true;
  welcome.useConnectAward(award);
})();

const ago = (days) => new Date(Date.now() - days * 86400000).toISOString().replace("T", " ").slice(0, 19);
const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
async function user(id, o) {
  o = Object.assign({ level: 0, created: 3 }, o || {});
  await runQuery(`INSERT INTO users (userId, username, camfrogUsername, discordId, twitchId, email, isEmailVerified, level, created_at, discordBonus, twitchBonus)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, o.username || id, o.cf || null, o.discord || null, o.twitch || null, o.email || null,
    o.verified ? 1 : 0, o.level, ago(o.created), o.discordBonus || 0, o.twitchBonus || 0]);
}
const stats = (login, days) => runQuery("INSERT OR REPLACE INTO camfrog_userstats (login, data, updated) VALUES (?, ?, ?)",
  [login, JSON.stringify({ chat: { days: Object.fromEntries(days.map((d) => [day(d), 20])) } }), Date.now()]);
const req = (dev, ip) => ({ cookies: { patv_dev: dev }, get: (h) => (h === "cf-connecting-ip" ? ip : undefined), secure: false, socket: {} });
const res = { cookie() {} };
const state = async (id) => ((await getQuery("SELECT state, reason, dup_of FROM welcome_bonus WHERE userId = ?", [id]))[0] || {});
const paidTo = (id) => paid.filter((p) => p.userId === id).reduce((t, p) => t + p.amount, 0);
const DEV = (c) => c.repeat(32);

test("backfill: existing accounts are legacy (no clawback), unpaid recent ones follow the new rule", async () => {
  await setup;
  await user("old", { cf: "bob", created: 400, level: 9 });                                // legacy, identity bob
  await user("CFaaaaaaaa", { username: "CFaaaaaaaa", cf: "recentcf", created: 3 });          // never got its welcome
  await user("CFbbbbbbbb", { username: "CFbbbbbbbb", cf: "gotpaid", created: 3 });
  await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES ('t0', 'CFbbbbbbbb', 'Welcome PAT', 50000)");
  await user("dlinked", { discord: "D-OLD", discordBonus: 1, created: 100 });
  await welcome.backfill();
  assert.strictEqual((await state("old")).state, "legacy");
  assert.strictEqual((await state("CFaaaaaaaa")).state, "pending");
  assert.strictEqual((await state("CFbbbbbbbb")).state, "legacy");
  await welcome.backfill();                                                                 // once only
  assert.strictEqual(paid.length, 0, "nobody is paid or charged by the backfill");
});

test("a new Camfrog account vests only after real play, then is paid once from the Reserve", async () => {
  await user("cf1", { cf: "alice", level: 0, created: 0.5 });
  await welcome.enroll("cf1", "camfrog", null, null, "alice");
  assert.strictEqual(await welcome.check("cf1"), "pending");
  let p = await welcome.progress("cf1");
  assert.strictEqual(p.need.length, 3, p.need.join(" | "));                                // level, days, age
  await runQuery("UPDATE users SET level = 2, created_at = ? WHERE userId = 'cf1'", [ago(2)]);
  await stats("alice", [0]);
  assert.strictEqual(await welcome.check("cf1"), "pending", "one active day isn't enough");
  await stats("alice", [0, 1]);
  assert.strictEqual(await welcome.check("cf1"), "paid");
  assert.strictEqual(paidTo("cf1"), 10000);
  assert.strictEqual(paid.find((x) => x.userId === "cf1").flow, "new_account");
  assert.strictEqual(await welcome.check("cf1"), "paid");
  await welcome.sweep();
  assert.strictEqual(paidTo("cf1"), 10000, "never twice");
});

test("an alt of a known person is a duplicate (Pepe's alias identity, browser, email, network)", async () => {
  // Camfrog alt: Pepe says login bobalt is bob (a legacy account)
  await user("cf2", { cf: "bobalt", level: 2, created: 3 });
  await welcome.enroll("cf2", "camfrog", null, null, "bob");
  await stats("bobalt", [0, 1]);
  assert.strictEqual(await welcome.check("cf2"), "duplicate");
  assert.strictEqual((await state("cf2")).dup_of, "old");
  // web alt from the same browser as a paid account
  await user("w1", { email: "carol.smith+pat@gmail.com", verified: 1, level: 2, created: 3 });
  await welcome.enroll("w1", "web", req(DEV("a"), "203.0.113.5"), res);
  await welcome.touch("w1", null, null);
  await runQuery("INSERT OR IGNORE INTO welcome_activity (userId, day) VALUES ('w1', ?)", [day(1)]);
  assert.strictEqual(await welcome.check("w1"), "paid");
  await user("w2", { email: "x@example.org", verified: 1, level: 2, created: 3 });
  await welcome.enroll("w2", "web", req(DEV("a"), "198.51.100.7"), res);
  await runQuery("INSERT OR IGNORE INTO welcome_activity (userId, day) VALUES ('w2', ?), ('w2', ?)", [day(0), day(1)]);
  assert.strictEqual(await welcome.check("w2"), "duplicate");
  assert.match((await state("w2")).reason, /browser/);
  // gmail dots / +tags are the same address
  await user("w3", { email: "CarolSmith@googlemail.com", verified: 1, level: 2, created: 3 });
  await welcome.enroll("w3", "web", req(DEV("b"), "198.51.100.8"), res);
  await runQuery("INSERT OR IGNORE INTO welcome_activity (userId, day) VALUES ('w3', ?), ('w3', ?)", [day(0), day(1)]);
  assert.strictEqual(await welcome.check("w3"), "duplicate");
  assert.match((await state("w3")).reason, /email/);
  // network: two welcomes already went to 203.0.113.5 (w1 + w4) -> the third waits for an admin
  await user("w4", { email: "dan@proton.me", verified: 1, level: 2, created: 3 });
  await welcome.enroll("w4", "web", req(DEV("c"), "203.0.113.5"), res);
  await runQuery("INSERT OR IGNORE INTO welcome_activity (userId, day) VALUES ('w4', ?), ('w4', ?)", [day(0), day(1)]);
  assert.strictEqual(await welcome.check("w4"), "paid");
  await user("w5", { email: "erin@proton.me", verified: 1, level: 2, created: 3 });
  await welcome.enroll("w5", "web", req(DEV("d"), "203.0.113.5"), res);
  await runQuery("INSERT OR IGNORE INTO welcome_activity (userId, day) VALUES ('w5', ?), ('w5', ?)", [day(0), day(1)]);
  assert.strictEqual(await welcome.check("w5"), "duplicate");
  assert.match((await state("w5")).reason, /network/);
  // admin pays it anyway
  const r = await welcome.payout("w5", true);
  assert.ok(r.ok);
  assert.strictEqual((await state("w5")).state, "paid");
  assert.strictEqual(paidTo("w5"), 10000);
  assert.strictEqual((await welcome.payout("w5", true)).ok, false, "an override can't pay twice");
});

test("no real identity -> never vests; hashed keys only", async () => {
  await user("w6", { email: "zz@mailinator.com", verified: 1, level: 3, created: 5 });
  await welcome.enroll("w6", "web", req(DEV("e"), "192.0.2.1"), res);
  await runQuery("INSERT OR IGNORE INTO welcome_activity (userId, day) VALUES ('w6', ?), ('w6', ?)", [day(0), day(1)]);
  assert.strictEqual(await welcome.check("w6"), "pending");
  assert.match((await welcome.progress("w6")).need.join(" "), /link your Camfrog/);
  const keys = await getQuery("SELECT k FROM welcome_keys");
  assert.ok(keys.every((r) => /^[a-z-]+:[0-9a-f]{32}$/.test(r.k)), "keys are kind:hash");
  assert.ok(!keys.some((r) => /192\.0|mailinator|alice/.test(r.k)), "no raw values stored");
});

test("Reserve short: stays pending, paid once it can", async () => {
  await user("cf3", { cf: "frank", level: 2, created: 3 });
  await welcome.enroll("cf3", "camfrog", null, null, "frank");
  await stats("frank", [0, 2]);
  reserve = 5000;
  assert.strictEqual(await welcome.check("cf3"), "pending");
  assert.match((await state("cf3")).reason, /can't cover/);
  reserve = 1e9;
  await welcome.sweep();
  assert.strictEqual((await state("cf3")).state, "paid");
  assert.strictEqual(paidTo("cf3"), 10000);
});

test("connect bonuses: none for an account the sign-in created, once per platform id, held until the welcome vests", async () => {
  assert.strictEqual(await welcome.connectBonus("cf1", "discord", "D1", award, true), "none");
  assert.strictEqual(await welcome.connectBonus("old", "discord", "D-NEW", award), "paid");        // legacy account
  assert.strictEqual(await welcome.connectBonus("cf1", "discord", "D-NEW", award), "dup");         // same Discord again
  assert.strictEqual(await welcome.connectBonus("cf1", "twitch", "T-OLD", award), "paid");         // cf1 vested earlier
  assert.strictEqual(await welcome.connectBonus("w1", "discord", "D-OLD", award), "dup", "an id that got one before 1.99bg");
  await user("cf4", { cf: "gina", level: 0, created: 3 });
  await welcome.enroll("cf4", "camfrog", null, null, "gina");
  assert.strictEqual(await welcome.connectBonus("cf4", "twitch", "T-G", award), "held");
  assert.strictEqual(connects.filter((c) => c.userId === "cf4").length, 0);
  await runQuery("UPDATE users SET level = 2 WHERE userId = 'cf4'");
  await stats("gina", [0, 1]);
  assert.strictEqual(await welcome.check("cf4"), "paid");
  assert.strictEqual(connects.filter((c) => c.userId === "cf4").length, 1, "the held connect bonus is paid with the welcome");
  assert.strictEqual(connects.find((c) => c.userId === "old").amount, 50000);
});

test("admin settings: amount and rules", async () => {
  await welcome.setConfig({ amount: 25000, min_days: 3, junk: 1, enabled: 0 });
  const c = welcome.config();
  assert.strictEqual(c.amount, 25000);
  assert.strictEqual(c.min_days, 3);
  assert.strictEqual(c.enabled, 0);
  assert.strictEqual(c.junk, undefined);
  await user("cf5", { cf: "hank", level: 2, created: 3 });
  await welcome.enroll("cf5", "camfrog", null, null, "hank");
  await stats("hank", [0, 1, 2]);
  assert.strictEqual(await welcome.check("cf5"), "pending", "switched off: waits");
  await welcome.setConfig({ enabled: 1 });
  assert.strictEqual(await welcome.check("cf5"), "paid");
  assert.strictEqual(paidTo("cf5"), 25000);
  const v = await welcome.adminView();
  assert.ok(v.counts.paid >= 5 && v.counts.duplicate >= 2 && v.paid7.total > 0);
  await welcome.setConfig({ amount: 10000, min_days: 2 });
});

test("helpers: email + IP normalisation", () => {
  assert.strictEqual(welcome.normEmail("A.B.C+x@Gmail.com").addr, "abc@gmail.com");
  assert.strictEqual(welcome.normEmail("a.b@proton.me").addr, "a.b@proton.me");
  assert.ok(welcome.normEmail("q@yopmail.com").disposable);
  assert.strictEqual(welcome.normEmail("nope"), null);
  assert.strictEqual(welcome.normIp("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
  assert.strictEqual(welcome.normIp("::ffff:203.0.113.9"), "203.0.113.9");
  assert.strictEqual(welcome.normIp("127.0.0.1"), null);
});
