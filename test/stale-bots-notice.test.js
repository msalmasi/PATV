// 1.99bs stale cleanup follow-ups: the Twitch/Discord-bot account rule (keep real activity + >= 100k,
// prune the rest once quiet, A2M merge proposals, system accounts), the duplicate merge sending the
// copy's welcome mint to the Reserve, the warning window (pending -> cleared by any activity, banner
// once, Pepe's login list, apply marks archived) and the one-account-per-Camfrog-login index.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stale-bots-"));
process.chdir(dir);                                      // dbUtils opens ./myapp.db
const repo = path.join(__dirname, "..");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const stale = require(path.join(repo, "staleaccounts"));
const { ensureCamfrogUnique, accountForLogin } = require(path.join(repo, "accountMerge"));

const DAY = 86400000;
const NOW = Date.now();
const ts = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString().replace("T", " ").slice(0, 19);

const setup = (async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT, class TEXT DEFAULT 'pleb', email TEXT,
    isEmailVerified INTEGER DEFAULT 0, discordId TEXT, discordUsername TEXT, twitchId TEXT, twitchDisplayname TEXT, camfrogUsername TEXT,
    points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, displayname TEXT, liked INTEGER DEFAULT 0, created_at TIMESTAMP)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT, note TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS reserve_claims (claimId TEXT PRIMARY KEY, flow TEXT, userId TEXT, type TEXT, amount INTEGER, created DATETIME DEFAULT CURRENT_TIMESTAMP, settled INTEGER DEFAULT 0)");
  await runQuery("CREATE TABLE IF NOT EXISTS user_badges (userId TEXT, badgeId TEXT, awardedAt TEXT, PRIMARY KEY (userId, badgeId))");
  await runQuery("CREATE TABLE IF NOT EXISTS levelup_rewards (userId TEXT, level INTEGER, PRIMARY KEY (userId, level))");
})();

let seq = 0;
async function user(id, o = {}) {
  await runQuery(`INSERT INTO users (userId, username, email, discordId, discordUsername, twitchId, twitchDisplayname, camfrogUsername, points_balance, xp, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [id, o.username || id, o.email === undefined ? "k3j4h5g6f7d8s" : o.email, o.discord || null, o.dname || null,
    o.twitch || null, o.tname || null, o.cf || null, o.bal || 0, o.xp || 0, ts(o.created == null ? 400 : o.created)]);
}
async function txn(id, type, points, daysAgo) {
  await runQuery("INSERT INTO transactions (transactionId, userId, type, points, timestamp) VALUES (?, ?, ?, ?, ?)", ["t" + ++seq, id, type, points, ts(daysAgo)]);
}
const tiers = async () => Object.fromEntries((await stale.plan({ now: NOW, supply: { total: 1, wallets: 1 } })).rows.map((r) => [r.f.userId, r.tier]));

test("bot-made accounts: keep real activity + >= 100k, prune dust and no-activity, hold the recently active, propose merges", async () => {
  await setup;
  // real (lots of own actions) and rich: kept (dormant -> D, recent -> active)
  await user("keep", { username: "richtwitch", twitch: "1", tname: "richtwitch", bal: 500000, created: 400 });
  for (let i = 0; i < 6; i++) await txn("keep", "Wager: Public Spin", -5000, 300 + i);
  // real but under 100k, quiet for 120 days: pruned
  await user("dust", { username: "dusty", discord: "2", dname: "dusty", bal: 58000, created: 400 });
  for (let i = 0; i < 6; i++) await txn("dust", "blackjack wager", -1000, 120 + i);
  // no real activity, big raffle balance, quiet: pruned regardless of balance
  await user("rich0", { username: "rafflebot", discord: "3", dname: "rafflebot", bal: 831000, created: 600 });
  await txn("rich0", "discord connect", 50000, 600);
  await txn("rich0", "discord-raffle", 781000, 400);
  // brand new bot account with only its creation bonus: no activity at all -> pruned
  await user("fresh", { username: "newbie", discord: "4", dname: "newbie", bal: 110000, created: 20 });
  await txn("fresh", "discord connect", 50000, 20);
  // no real activity but a raffle 10 days ago: still around -> active (not warned)
  await user("recent", { username: "lurker", discord: "5", dname: "lurker", bal: 694000, created: 300 });
  await txn("recent", "discord-raffle", 1000, 10);
  // its Discord name is a real Camfrog login with its own account: merge proposal
  await user("cfreal", { username: "CFabcdefgh", email: "x@gmail.com", cf: "stents85", bal: 5, created: 300 });
  await user("twin", { username: "stents85", discord: "6", dname: "stents85", bal: 110000, created: 300 });   // its own name too
  // the system accounts are never touched
  await user("wom", { username: "Wheel_of_Misfortune", twitch: "7", tname: "Wheel_of_Misfortune", bal: 0, created: 500 });
  // a bot account the person later linked to Camfrog: real, small balance -> still pruned when quiet...
  await user("linked", { username: "tatyb", twitch: "8", tname: "tatyb", cf: "tatyb", bal: 4755, created: 400 });
  await txn("linked", "tip sent", -100, 200);

  const t = await tiers();
  assert.deepStrictEqual([t.keep, t.dust, t.rich0, t.fresh, t.recent, t.twin, t.wom, t.linked],
                         ["D", "A2", "A2", "A2", "active", "A2M", "X", "A2"]);
  // a raised keep threshold makes the rich real account a candidate too
  const p = await stale.plan({ now: NOW, supply: { total: 1, wallets: 1 }, botKeepMin: 1e9 });
  assert.strictEqual(p.rows.find((r) => r.f.userId === "keep").tier, "A2");
  assert.ok(stale.DEFAULT_TIERS.includes("A2"));
});

test("duplicate merge: the copy's welcome mint goes to the Reserve, its own earnings to the primary", async () => {
  await setup;
  await user("prim", { username: "CFprimary1", email: "p@gmail.com", cf: "drama1", bal: 1000, created: 200 });
  await user("copy", { username: "CFcopy0001", cf: "drama1x", bal: 61500, xp: 37, created: 5 });
  await txn("copy", "ledger-correction", 60000, 5);              // at creation: the duplicate welcome
  await txn("copy", "lotto-0pb", 1500, 2);                        // its own winnings
  await runQuery("INSERT INTO levelup_rewards (userId, level) VALUES ('copy', 1), ('copy', 2), ('prim', 1)");
  assert.deepStrictEqual(await stale.dupSplit("copy"), { balance: 61500, toReserve: 60000, toMain: 1500 });
  const r = await stale.mergeDuplicate("copy", "prim");
  assert.deepStrictEqual([r.toMain, r.toReserve, r.xp], [1500, 60000, 37]);
  const p = (await getQuery("SELECT points_balance, xp FROM users WHERE userId = 'prim'"))[0];
  assert.deepStrictEqual([p.points_balance, p.xp], [2500, 37]);
  assert.strictEqual((await getQuery("SELECT 1 FROM users WHERE userId = 'copy'")).length, 0);
  const c = await getQuery("SELECT flow, amount FROM reserve_claims WHERE type LIKE 'duplicate welcome mint%'");
  assert.deepStrictEqual(c.map((x) => [x.flow, x.amount]), [["stale_reclaim", -60000]]);
  // the primary's history still adds up: +60000 carried over, -60000 to the Reserve, +1500 lotto
  const sum = (await getQuery("SELECT SUM(points) AS s FROM transactions WHERE userId = 'prim'"))[0].s;
  assert.strictEqual(sum, 1500);
  assert.deepStrictEqual((await getQuery("SELECT level FROM levelup_rewards WHERE userId = 'prim' ORDER BY level")).map((x) => x.level), [1, 2]);
});

test("warning window: pending -> cleared by any activity; banner once; Pepe's list; apply marks archived", async () => {
  await setup;
  await stale.ensure();
  const p = await stale.plan({ now: NOW, supply: { total: 1, wallets: 1 } });
  const sel = p.rows.filter((r) => stale.DEFAULT_TIERS.includes(r.tier));
  const inboxed = [];
  const r = await stale.startNotice(sel, { runId: "notice-test", applyOn: "2026-11-05", purgeOn: "2027-01-04", now: NOW,
    addInbox: async (id, n) => inboxed.push([id, n.ref, n.title]) });
  assert.strictEqual(r.added, sel.length);
  assert.ok(inboxed.length === sel.length && inboxed.every((x) => x[1] === "stale-notice:notice-test"));
  // idempotent: a second start adds nobody and sends no second inbox notice
  assert.strictEqual((await stale.startNotice(sel, { runId: "notice-test", applyOn: "2026-11-05", purgeOn: "2027-01-04", now: NOW })).added, 0);
  const ids = sel.map((x) => x.f.userId);
  assert.ok(ids.includes("dust") && ids.includes("linked") && !ids.includes("keep") && !ids.includes("recent") && !ids.includes("twin"));

  // Pepe's list has the Camfrog-linked ones; seeing the login clears it
  const pl = await stale.pendingLogins();
  assert.strictEqual(pl.apply_on, "2026-11-05");
  assert.ok(pl.logins.some((x) => x.login === "tatyb" && x.balance === 4755));
  assert.strictEqual(await stale.seenLogin("TatyB"), 1);
  assert.ok(!(await stale.pendingLogins()).logins.some((x) => x.login === "tatyb"));

  // a Discord lookup / sign-in (touch) clears it too, without restoring anything
  assert.strictEqual(await stale.touch("rich0", "discord"), null);
  assert.strictEqual((await getQuery("SELECT state, cleared_via FROM stale_notice WHERE userId = 'rich0'"))[0].state, "cleared");

  // a signed-in page view: cleared + a one-time banner
  const mw = stale.noticeMiddleware(() => "fresh");
  const run = () => new Promise((resolve) => { const res = { locals: {} }; mw({ method: "GET", path: "/" }, res, () => resolve(res)); });
  const r1 = await run();
  assert.deepStrictEqual([r1.locals.staleNotice.apply_on, r1.locals.staleNotice.balance], ["2026-11-05", 110000]);
  assert.strictEqual((await run()).locals.staleNotice, undefined);       // once
  assert.strictEqual((await getQuery("SELECT cleared_via FROM stale_notice WHERE userId = 'fresh'"))[0].cleared_via, "site visit");

  // activity that doesn't pass through touch (a spin) is picked up by the refresh
  for (let i = 0; i < 5; i++) await txn("dust", "Wager: Public Spin", -5000, 0);
  await runQuery("UPDATE users SET points_balance = 200000 WHERE userId = 'dust'");
  const rf = await stale.refreshNotice({ now: NOW });
  assert.ok(rf.cleared >= 1);
  assert.strictEqual((await getQuery("SELECT state FROM stale_notice WHERE userId = 'dust'"))[0].state, "cleared");

  // the apply archives a still-pending one and marks it
  const pend = (await getQuery("SELECT userId FROM stale_notice WHERE state = 'pending'")).map((x) => x.userId);
  assert.ok(pend.length >= 1);
  await stale.archiveOne(pend[0], { runId: "run-x", tier: "A2", now: NOW });
  assert.strictEqual((await getQuery("SELECT state FROM stale_notice WHERE userId = ?", [pend[0]]))[0].state, "archived");
  const s = await stale.noticeSummary();
  assert.strictEqual(s.meta.purge_on, "2027-01-04");
  assert.ok(s.rows.some((x) => x.state === "archived") && s.rows.some((x) => x.state === "cleared"));
});

test("one account per Camfrog login: a unique index on the normalised login", async () => {
  await setup;
  assert.strictEqual(await ensureCamfrogUnique(), true);
  await user("one", { username: "CFonelogin", cf: "SomeOne", created: 1 });
  await assert.rejects(user("two", { username: "CFtwologin", cf: " someone ", created: 1 }), /UNIQUE/);
  await user("three", { username: "CFnologin1", cf: null, created: 1 });    // no login: no limit
  await user("four", { username: "CFnologin2", cf: "", created: 1 });
  assert.strictEqual((await accountForLogin("SOMEONE")).userId, "one");
  assert.strictEqual(await accountForLogin("nobody"), null);
});

test("the unique index is refused (and the duplicates named) while duplicates exist", async () => {
  await setup;
  await runQuery("DROP INDEX IF EXISTS users_camfrog_login");
  await user("dupA", { username: "CFdupaaaaa", cf: "twice", created: 1 });
  await user("dupB", { username: "CFdupbbbbb", cf: "Twice", created: 1 });
  assert.strictEqual(await ensureCamfrogUnique(), false);
});
