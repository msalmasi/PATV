// Twitch / Discord linking (1.99gb): usernames by the register form's rules, idempotent awardBadge, link rewards
// that never block a link (and ignore the legacy flag when no connect bonus was ever paid), provider email
// capture, the Twitch Client-ID from the environment.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "linking-"));
process.chdir(dir);                                      // dbUtils opens ./myapp.db
const repo = path.join(__dirname, "..");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const guard = require(path.join(repo, "middleware", "authGuard"));
const UC = require(path.join(repo, "user.controller"));
const OL = require(path.join(repo, "oauthlink"));

const setup = (async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT, email TEXT UNIQUE,
    isEmailVerified INTEGER DEFAULT 0, emailVerificationToken TEXT, tokenExpires DATETIME, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0,
    points_balance INTEGER DEFAULT 0, twitchId TEXT, twitchBonus INTEGER DEFAULT 0, discordId TEXT, discordBonus INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE IF NOT EXISTS badges (badgeId TEXT PRIMARY KEY, points INTEGER)");
  await runQuery("CREATE TABLE IF NOT EXISTS user_badges (userId TEXT, badgeId TEXT, awardedAt DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (userId, badgeId))");
  await runQuery("CREATE TABLE IF NOT EXISTS bonus_winners (bonusId TEXT, type TEXT, userId TEXT, transactionId TEXT, amount INTEGER, timestamp DATETIME)");
  await runQuery("CREATE TABLE IF NOT EXISTS levelup_rewards (userId TEXT, level INTEGER, amount INTEGER, paid INTEGER DEFAULT 0, PRIMARY KEY (userId, level))");
  await runQuery("CREATE TABLE IF NOT EXISTS levelup_milestones (userId TEXT, level INTEGER, amount INTEGER, paid INTEGER DEFAULT 0, paid_at DATETIME, PRIMARY KEY (userId, level))");
  await runQuery("INSERT OR IGNORE INTO badges (badgeId, points) VALUES ('twitch-user', 100), ('discord-user', 100), ('fresh_meat', 50)");
})();
async function user(id, o = {}) {
  await runQuery("INSERT INTO users (userId, username, password, email, isEmailVerified, twitchBonus) VALUES (?, ?, 'x', ?, ?, ?)",
                 [id, o.username || id, o.email === undefined ? null : o.email, o.verified ? 1 : 0, o.flag || 0]);
}

test("usernames from Twitch / Discord names follow the register form's rules", () => {
  const cases = [
    ["JohnDoe", "JohnDoe"], ["José María", "Jose_Maria"], ["cool guy 99", "cool_guy_99"], ["__x.y__", "x.y"],
    ["CFsomebody", "somebody"], ["cfcfabc", "abc"], ["cf", null], ["CF_", null], ["日本語", null], ["ab", null], ["", null], [null, null],
    ["a".repeat(40), "a".repeat(24)], ["name/with?bad#chars", "namewithbadchars"], ["<@1234567890>", "1234567890"], ["[object Object]", "object_Object"],
    ["dots...end.", "dots...end"], ["x_".repeat(20), "x_".repeat(11) + "x"],
  ];
  for (const [raw, want] of cases) {
    const got = UC.normaliseUsername(raw);
    assert.equal(got, want, JSON.stringify(raw));
    if (got) assert.equal(guard.checkUsername(got), null, `${got} passes checkUsername`);
  }
});

test("generateUniqueUsername: case-insensitive uniqueness, numbered within 24 chars, user#### fallback", async () => {
  await setup;
  await user("n1", { username: "Catnip" });
  assert.equal(await UC.generateUniqueUsername("catnip"), "catnip1", "Catnip exists in another case");
  await user("n2", { username: "CATNIP1" });
  assert.equal(await UC.generateUniqueUsername("catnip"), "catnip2");
  const long = "b".repeat(24);
  await user("n3", { username: long });
  const u = await UC.generateUniqueUsername(long.toUpperCase());
  assert.equal(u, "B".repeat(23) + "1"); assert.equal(guard.checkUsername(u), null);
  for (const raw of ["CF", "😀😀😀", "", undefined]) {
    const f = await UC.generateUniqueUsername(raw);
    assert.match(f, /^user\d{4,}$/, String(raw)); assert.equal(guard.checkUsername(f), null);
  }
  assert.equal(await UC.generateUniqueUsername("CFmike"), "mike");
});

test("awardBadge is idempotent: XP only when inserted, no throw on a repeat, no raw transaction", async () => {
  await setup;
  await user("b1");
  const r1 = await UC.awardBadge("b1", "twitch-user");
  assert.equal(r1.success, true); assert.equal(r1.awarded, true);
  const xp1 = (await getQuery("SELECT xp, level FROM users WHERE userId = 'b1'"))[0];
  assert.equal(xp1.xp, 100, "XP paid (awaited)");
  const r2 = await UC.awardBadge("b1", "twitch-user");
  assert.equal(r2.success, false); assert.equal(r2.already, true);
  const [a, b] = await Promise.all([UC.awardBadge("b1", "fresh_meat"), UC.awardBadge("b1", "fresh_meat")]);
  assert.equal([a, b].filter((x) => x.awarded).length, 1, "two racing calls award once");
  assert.equal((await getQuery("SELECT xp FROM users WHERE userId = 'b1'"))[0].xp, 150);
  await assert.rejects(UC.awardBadge("b1", "nope"), /Badge not found/);
  assert.equal(await OL.safeBadge("b1", "nope"), null, "safeBadge never throws");
  const src = fs.readFileSync(path.join(repo, "user.controller.js"), "utf8");
  const body = src.slice(src.indexOf("async function awardBadge"), src.indexOf("// Function to Award Bonus PAT"));
  assert.ok(!/BEGIN|COMMIT|ROLLBACK/.test(body), "no raw transaction in awardBadge");
});

test("link rewards: badge always (idempotent), connect bonus unless one was paid; the legacy flag alone no longer blocks it", async () => {
  await setup;
  const paid = [];
  const connect = async (u, p, id) => { paid.push([u, p, id]); return "paid"; };
  await user("l1", { flag: 1 });                                       // legacy flag, never paid -> bonus
  let r = await OL.linkRewards({ userId: "l1", provider: "twitch", providerId: "T1", priorFlag: 1, connect });
  assert.ok(r.badge && r.badge.awarded); assert.equal(r.bonus, "paid");
  await user("l2", { flag: 1 });                                       // flag + a twitch connect payout on record -> no bonus
  await runQuery("INSERT INTO bonus_winners (bonusId, type, userId, amount) VALUES ('bw', 'twitch connect', 'l2', 50000)");
  r = await OL.linkRewards({ userId: "l2", provider: "twitch", providerId: "T2", priorFlag: 1, connect });
  assert.equal(r.bonus, "none");
  await user("l3");                                                    // flag 0 -> bonus (welcome dedupes by id)
  r = await OL.linkRewards({ userId: "l3", provider: "discord", providerId: "D3", priorFlag: 0, connect });
  assert.equal(r.bonus, "paid");
  r = await OL.linkRewards({ userId: "l3", provider: "discord", providerId: "D3", priorFlag: 0, created: true, connect });
  assert.equal(r.bonus, "none", "an account the sign-in created gets no connect bonus");
  assert.deepStrictEqual(paid.map((p) => p[0]), ["l1", "l3"]);
  // a throwing bonus never escapes
  r = await OL.linkRewards({ userId: "l3", provider: "twitch", providerId: "T9", priorFlag: 0, connect: async () => { throw new Error("boom"); } });
  assert.equal(r.bonus, "error");
});

test("email capture: placeholder / missing / unverified replaced by the provider's verified email; verified kept; collisions refused", async () => {
  await setup;
  await user("e1", { email: "k3j4h5g6" });                             // bot placeholder (no @)
  await user("e2");                                                    // none
  await user("e3", { email: "typed@example.org" });                    // unverified
  await user("e4", { email: "mine@example.org", verified: true });     // verified: never replaced
  await user("e5", { email: "Taken@Example.org", verified: true });    // someone else's
  await user("e6");
  const C = (userId, email, verified = true) => OL.captureEmail({ userId, provider: "discord", email, verified });
  assert.equal(await C("e1", "one@example.org"), true);
  assert.equal(await C("e2", "two@example.org"), true);
  assert.equal(await C("e3", "three@example.org"), true);
  assert.equal(await C("e4", "four@example.org"), false);
  assert.equal(await C("e6", "taken@example.org"), false, "another account has it (any case)");
  assert.equal(await C("e6", "six@example.org", false), false, "the provider hasn't verified it");
  assert.equal(await C("e6", "not-an-email"), false);
  const rows = Object.fromEntries((await getQuery("SELECT userId, email, isEmailVerified FROM users WHERE userId LIKE 'e%'")).map((r) => [r.userId, r]));
  assert.deepStrictEqual([rows.e1.email, rows.e1.isEmailVerified], ["one@example.org", 1]);
  assert.deepStrictEqual([rows.e2.email, rows.e2.isEmailVerified], ["two@example.org", 1]);
  assert.deepStrictEqual([rows.e3.email, rows.e3.isEmailVerified], ["three@example.org", 1]);
  assert.deepStrictEqual([rows.e4.email, rows.e4.isEmailVerified], ["mine@example.org", 1]);
  assert.equal(rows.e6.email, null);
  // the same address, unverified, becomes verified
  await user("e7", { email: "Same@example.org" });
  assert.equal(await C("e7", "same@example.org"), true);
  assert.equal((await getQuery("SELECT isEmailVerified FROM users WHERE userId = 'e7'"))[0].isEmailVerified, 1);
  // the notice text, and no address in the logs
  assert.equal(OL.noticeText("discord"), "We added your Discord email for account recovery — change it in settings.");
  const logs = []; const orig = console.log; console.log = (...a) => logs.push(a.join(" "));
  try { await user("e8"); await C("e8", "eight@example.org"); await C("e8", "nine@example.org"); } finally { console.log = orig; }
  assert.ok(logs.length >= 1 && logs.every((l) => !/@/.test(l)), "no email address in the logs");
});

test("Twitch: Client-ID from TWITCH_CLIENT_ID, user:read:email only, nothing hard-coded", () => {
  const was = process.env.TWITCH_CLIENT_ID;
  process.env.TWITCH_CLIENT_ID = "test-client-id";
  try {
    assert.deepStrictEqual(OL.twitchHeaders("tok"), { Authorization: "Bearer tok", "Client-ID": "test-client-id" });
  } finally { if (was === undefined) delete process.env.TWITCH_CLIENT_ID; else process.env.TWITCH_CLIENT_ID = was; }
  assert.equal(OL.TWITCH_SCOPE, "user:read:email");
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  assert.ok(!/bkwg34x1/.test(src), "no hard-coded Client-ID");
  assert.ok(!/user:read:subscriptions/.test(src), "no subscriptions scope");
  assert.ok(/headers: oauthLink\.twitchHeaders\(accessToken\)/.test(src), "the Helix call uses the env Client-ID");
});

test("discord bot: usernames URL-encoded, a cash-out only looks up, GuildMembers aren't passed as names", () => {
  const uu = fs.readFileSync(path.join(repo, "discord-bot", "userUtils.js"), "utf8");
  assert.ok(/\/api\/users\/username\/\$\{encodeURIComponent\(username\)\}/.test(uu));
  const d = fs.readFileSync(path.join(repo, "discord-bot", "discord.js"), "utf8");
  const cash = d.slice(d.indexOf("async function processCashout"), d.indexOf("async function addLevelUpBonus"));
  assert.ok(/findDiscordUser\(discordId\)/.test(cash) && !/findOrCreateDiscordUser/.test(cash), "look up only");
  assert.ok(!/const displayName = newMessage\.mentions\.members\.first\(\);/.test(d));
  assert.ok(!/const discordUsername = newMessage\.mentions\.members\.last\(\);/.test(d));
});
