// Auto-account escrow (autoescrow.js, autoaccount.js, docs/auto-account-escrow.md): a free reward for a Camfrog auto account
// is held (switch on), released once when the account is claimed (a merge into a real account, or a sign-in method in place),
// expires six calendar months later to the PAT Routing row (the Fed by default); game winnings stay spendable; the stale
// cleanup's purge waits for held entries and never reclaims the same PAT; supply never moves; no time-of-day dependence.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "autoescrow-test-")));   // dbUtils opens ./myapp.db
delete process.env.STAGING;
const { runQuery, getQuery, tx } = require(path.join(repo, "dbUtils"));
const P = require(path.join(repo, "pools"));
const AA = require(path.join(repo, "autoaccount"));
const AE = require(path.join(repo, "autoescrow"));
const ledger = require(path.join(repo, "ledger"));
const AM = require(path.join(repo, "accountMerge"));

const DAY = 86400000;
const POOLS = { reserve: 10000000, incentives: 5000000 };
const bal = async (id) => Number(((await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0] || {}).b);
const held = async (id) => (await AE.waiting(id, { now: 0 })).amount;
const wallets = async () => Number((await getQuery("SELECT COALESCE(SUM(points_balance),0) AS w FROM users"))[0].w);
const house = async () => Number((await getQuery("SELECT COALESCE(SUM(amount),0) AS j FROM jackpot_rakes"))[0].j);
const supply = async () => (await wallets()) + (await P.total()).amount + (await house()) + (await AE.heldTotal()).amount;
const entries = async (id) => getQuery("SELECT * FROM auto_escrow WHERE user_id = ? ORDER BY id", [id]);

async function user(id, o = {}) {
  await runQuery(`INSERT INTO users (userId, username, email, password, camfrogUsername, discordId, twitchId, points_balance, created_at)
                  VALUES (?, ?, ?, 'x', ?, ?, ?, ?, ?)`,
                 [id, o.username || id, o.email === undefined ? "k3j4h5g6f7d8s" : o.email, o.cf || null, o.discord || null, o.twitch || null,
                  o.bal || 0, "2026-01-01 00:00:00"]);
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, email TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  discordId TEXT, discordUsername TEXT, twitchId TEXT, twitchDisplayname TEXT, camfrogUsername TEXT, points_balance INTEGER DEFAULT 0,
                  xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0, liked INTEGER DEFAULT 0, isEmailVerified INTEGER DEFAULT 0, created_at TIMESTAMP)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT, note TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE bonus_winners (bonusId TEXT PRIMARY KEY, type TEXT, userId TEXT, transactionId TEXT, amount INTEGER)");
  await runQuery("CREATE TABLE user_badges (userId TEXT, badgeId TEXT, awardedAt TEXT, PRIMARY KEY (userId, badgeId))");
  await runQuery("CREATE TABLE levelup_rewards (userId TEXT, level INTEGER, PRIMARY KEY (userId, level))");
  // Pepe's automatic accounts (username CF + 8, an "@"-less random email) - the backfill marks them; a real one; a Discord-claimed one
  await user("auto1", { username: "CFaaaa1111", cf: "chatty" });
  await user("auto2", { username: "CFbbbb2222", cf: "lurker" });
  await user("auto3", { username: "CFcccc3333", cf: "lurker_alt" });
  await user("auto4", { username: "CFdddd4444", cf: "gamer" });
  await user("auto5", { username: "CFeeee5555", cf: "sleepy", bal: 500 });
  await user("dc", { username: "CFffff6666", cf: "discordy", discord: "123" });
  await user("real", { username: "realguy", email: "real@example.com", cf: "realguy_cf" });
  await user("real2", { username: "otherguy", email: "other@example.com" });
  await P.init();
  await require(path.join(repo, "funding")).init();
  await P._setMeta("enabled", true);
  const payload = JSON.stringify({ v: 1, source: "pepe", pools: POOLS, docs: {}, routes: {}, econ_cfg: {}, econ_cfg_log: [], catalog: {} });
  const r = await P.importFromPepe({ key: "pc-autoescrow-test", payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"),
                                     totals: { sum: Object.values(POOLS).reduce((t, v) => t + v, 0), count: 2, per_pool: POOLS } });
  assert.equal(r.ok, true);
  await P._setMeta("imported", Object.assign((await P.exportState()).imported, { at: 0 }));
  P._forgetLive();
  await AE.init();
});

test("the one auto-account test: provenance + still no way to sign in", async () => {
  assert.equal(AA.isAutoName("CFab12cd34"), true);
  assert.equal(AA.isAutoName("cfab12cd34"), false);
  assert.equal(AA.isAutoName("cfab12cd34", { anyCase: true }), true);
  assert.equal(AA.isAutoName("CFab12cd345"), false);
  assert.equal(await AA.isAutoAccount("auto1"), true);
  assert.equal(await AA.isAutoAccount("real"), false);             // a real account
  assert.equal(await AA.isAutoAccount("dc"), false);               // Discord linked: someone can sign in
  assert.equal(await AA.isAutoAccount("nobody"), false);
  const marked = await getQuery("SELECT userId FROM users WHERE auto_source = 'camfrog' ORDER BY userId");
  assert.deepEqual(marked.map((x) => x.userId), ["auto1", "auto2", "auto3", "auto4", "auto5", "dc"]);
  // an SSO link claims it in place
  await runQuery("CREATE TABLE IF NOT EXISTS sso_links (provider TEXT, subject TEXT, user_id TEXT)");
  await user("auto9", { username: "CFzzzz9999", cf: "ssoguy" });
  await AA.markNew("auto9");
  assert.equal(await AA.isAutoAccount("auto9"), true);
  await runQuery("INSERT INTO sso_links (provider, subject, user_id) VALUES ('google', 's1', 'auto9')");
  assert.equal(await AA.isAutoAccount("auto9"), false);
});

test("switch off: everything is paid to the wallet as before", async () => {
  assert.equal(await AE.enabled(), false);
  const r = await AE.credit("auto1", 100, "Achievement: Off", { kind: "achievements" });
  assert.equal(r.ok, true);
  assert.equal(r.escrowed, undefined);
  assert.equal(await bal("auto1"), 100);
  assert.equal(await held("auto1"), 0);
});

test("earn -> escrow: a free reward for an auto account is held, once per transaction id; supply doesn't move", async () => {
  await AE.setSettings({ enabled: true }, { userId: "admin", username: "boss" });
  const s0 = await supply();
  // the incentive budget pays it (a pool leg) and the escrow holds it - like the policy's activity payout
  await tx(async () => {
    await P._inTx.applyLegs("t-act-1:out", [{ pool: "incentives", amount: -1000 }], { kind: "move", flow: "activity_rewards" });
    const r = await AE.credit("auto1", 1000, "bonus win", { kind: "activity-reward", transactionId: "act-1-chatty", requireCover: true });
    assert.equal(r.ok, true);
    assert.equal(r.escrowed, true);
  });
  assert.equal(await supply(), s0);
  assert.equal(await bal("auto1"), 100);
  assert.equal(await held("auto1"), 1000);
  const again = await AE.credit("auto1", 1000, "bonus win", { kind: "activity-reward", transactionId: "act-1-chatty" });
  assert.equal(again.escrowed, true);
  assert.equal(await held("auto1"), 1000, "a retried credit is held once");
  const [e] = await entries("auto1");
  assert.equal(e.login, "chatty");
  assert.equal(e.expires_at, AE.addMonthsUTC(e.earned_at, 6));
  // the supply page has its own row
  const rows = await AE.supplyRows([{ key: "wallets", amount: 1 }]);
  assert.deepEqual(rows.find((x) => x.key === "auto_escrow").amount, 1000);
});

test("game winnings, tips and refunds stay spendable; a real account is never held", async () => {
  const BC = require(path.join(repo, "botcredits"));
  const w = await BC.chatwinner({ userId: "auto4", type: "brawl-win", amount: 5000, source: "escrow:brawl", ref: "ref-brawl-1" });
  assert.equal(w.status, 200);
  assert.equal(w.json.escrowed, undefined);
  assert.equal(await bal("auto4"), 5000);
  const raffle = await BC.chatwinner({ userId: "auto4", type: "camfrog-raffle", amount: 700, source: "incentives", ref: "ref-raffle-1" });
  assert.equal(raffle.status, 200);
  assert.equal(raffle.json.escrowed, true);
  assert.equal(await bal("auto4"), 5000);
  assert.equal(await held("auto4"), 700);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM bonus_winners WHERE userId = 'auto4' AND type = 'camfrog-raffle'"))[0].n, 1);
  // a duplicate ref moves nothing again
  const dup = await BC.chatwinner({ userId: "auto4", type: "camfrog-raffle", amount: 700, source: "incentives", ref: "ref-raffle-1" });
  assert.equal(dup.json.duplicate, true);
  assert.equal(await held("auto4"), 700);
  // a real account (and an auto account someone can sign in to) gets the same reward in its wallet
  const r = await AE.credit("real", 300, "Achievement: Yapper", { kind: "achievements" });
  assert.equal(r.escrowed, undefined);
  assert.equal(await bal("real"), 300);
  const d = await AE.credit("dc", 300, "Achievement: Yapper", { kind: "achievements" });
  assert.equal(d.escrowed, undefined);
  assert.equal(await bal("dc"), 300);
  // the website's payout path (funding.fundPayoutEx): the claim is booked, the auto account's reward held
  const F = require(path.join(repo, "funding"));
  F.sync({ reserve: 10000000, flows: { achievements: "reserve", levelup: "reserve" } });
  const fp = await F.fundPayoutEx("auto4", 250, "levelup", "Level-up reward (Lv 2)");
  assert.equal(fp.ok, true);
  assert.equal(await held("auto4"), 950);
  assert.equal(await bal("auto4"), 5000);
});

test("claim on link: the merge into a real account releases everything once, with one wallet row and a notice", async () => {
  await AE.credit("auto1", 400, "Achievement: Open Mic", { kind: "achievements", transactionId: "ach-open-mic-auto1" });
  assert.equal(await held("auto1"), 1400);
  const s0 = await supply();
  const before = await bal("real");
  // what completeCamfrogLink does: move the rows, record the merge, delete the auto account - then afterMerge
  await tx(async () => {
    const auto = await bal("auto1");
    await runQuery("UPDATE users SET points_balance = points_balance + ? WHERE userId = 'real'", [auto]);
    await AM.moveUserRows("auto1", "real");
    await ledger.recordMerge("auto1", "real", "camfrog link");
    await runQuery("DELETE FROM users WHERE userId = 'auto1'");
  });
  await AM.afterMerge("real", {});
  assert.equal(await bal("real"), before + 100 + 1400);
  assert.equal(await held("real"), 0);
  assert.equal(await supply(), s0);
  const c = await getQuery("SELECT * FROM auto_escrow_claims WHERE user_id = 'real'");
  assert.equal(c.length, 1);
  assert.equal(c[0].amount, 1400);
  assert.equal(c[0].entries, 2);
  const t = await getQuery("SELECT points, type FROM transactions WHERE transactionId = ?", [c[0].id]);
  assert.deepEqual(t.map((x) => [x.points, x.type]), [[1400, AE.CLAIM_TYPE]]);
  const n = await getQuery("SELECT title FROM inbox WHERE user_id = 'real' AND ref = ?", ["autoescrow:" + c[0].id]);
  assert.equal(n.length, 1);
  assert.match(n[0].title, /1,400 waiting from chat/);
  // released once: again, and the sweep, change nothing
  assert.equal((await AE.release("real")).released, 0);
  await AE.sweep();
  assert.equal(await bal("real"), before + 1500);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM transactions WHERE type = ?", [AE.CLAIM_TYPE]))[0].n, 1);
});

test("account merge between two auto accounts keeps the rewards held; a sign-in method in place releases them", async () => {
  await AE.credit("auto2", 600, "bonus win", { kind: "mic-hourly", transactionId: "mic-auto2" });
  const [e] = await entries("auto2");
  await tx(async () => {
    await AM.moveUserRows("auto2", "auto3");
    await ledger.recordMerge("auto2", "auto3", "duplicate");
    await runQuery("DELETE FROM users WHERE userId = 'auto2'");
  });
  await AM.afterMerge("auto3", {});
  const [moved] = await entries("auto3");
  assert.equal(moved.state, "held");
  assert.equal(moved.expires_at, e.expires_at, "same expiry");
  assert.equal(await bal("auto3"), 0);
  // the person links Discord to the auto account itself: the sweep releases it
  await runQuery("UPDATE users SET discordId = '999' WHERE userId = 'auto3'");
  const s = await AE.sweep();
  assert.equal(s.released, 1);
  assert.equal(await bal("auto3"), 600);
});

test("the six-month window: per entry, calendar months UTC, never claimable after its date, expiry -> the Fed, idempotent", async () => {
  assert.equal(AE.addMonthsUTC(Date.UTC(2026, 7, 31, 12), 6), Date.UTC(2027, 1, 28, 12));        // 31 Aug -> 28 Feb
  assert.equal(AE.addMonthsUTC(Date.UTC(2027, 7, 31, 12), 6), Date.UTC(2028, 1, 29, 12));        // leap year
  assert.equal(AE.addMonthsUTC(Date.UTC(2026, 9, 12, 23, 59, 59), 6), Date.UTC(2027, 3, 12, 23, 59, 59));
  // two rewards a few seconds apart around midnight UTC
  const late = Date.UTC(2025, 9, 12, 23, 59, 59), early = Date.UTC(2025, 9, 13, 0, 0, 1);    // (long before the other tests' rewards)
  await AE.credit("auto5", 1000, "Achievement: A", { kind: "achievements", transactionId: "late", now: late });
  await AE.credit("auto5", 2000, "Achievement: B", { kind: "achievements", transactionId: "early", now: early });
  const s0 = await supply();
  const fed0 = await P.balance("reserve");
  // a run one second before the first expiry: nothing; a run at its exact second: only the first; whatever hour the job runs
  assert.equal((await AE.expire({ now: AE.addMonthsUTC(late, 6) - 1000 })).entries, 0);
  assert.equal((await AE.expire({ now: AE.addMonthsUTC(late, 6) })).entries, 1);
  assert.equal(await P.balance("reserve"), fed0 + 1000);
  // between the two expiries, a claim releases only what is still inside its window
  // (the first is gone already; the job not having run yet would change nothing: release() checks the date itself)
  assert.equal((await AE.waiting("auto5", { now: AE.addMonthsUTC(late, 6) })).amount, 2000);
  assert.equal((await AE.waiting("auto5", { now: AE.addMonthsUTC(early, 6) })).amount, 0, "past its date it is not waiting any more");
  // expiry again at the same time: a no-op; later: the second
  assert.equal((await AE.expire({ now: AE.addMonthsUTC(late, 6) })).entries, 0);
  const r2 = await AE.expire({ now: AE.addMonthsUTC(early, 6) + 5 * 3600000 });           // the job ran five hours late
  assert.equal(r2.entries, 1);
  assert.equal(await P.balance("reserve"), fed0 + 3000);
  assert.equal(await supply(), s0);
  const ex = await entries("auto5");
  assert.deepEqual(ex.map((x) => x.state), ["expired", "expired"]);
  assert.equal(ex[1].done_at, AE.addMonthsUTC(early, 6) + 5 * 3600000);
  // an account linked after its rewards expired gets nothing from them
  await runQuery("UPDATE users SET email = 'woke@example.com' WHERE userId = 'auto5'");
  assert.equal((await AE.release("auto5", { now: AE.addMonthsUTC(early, 6) + DAY })).released, 0);
  await runQuery("UPDATE users SET email = 'k3j4h5g6f7d8s' WHERE userId = 'auto5'");
});

test("the routing row decides where unclaimed PAT goes (rest to the Fed); without site pools it's a Reserve claim", async () => {
  const ES = require(path.join(repo, "econstore"));
  await ES.init();
  await ES.putSettings({ pat_routes: { auto_escrow_expired: [["jackpot", 50]] } });
  const t = Date.UTC(2026, 0, 10);
  await AE.credit("auto4", 801, "bonus win", { kind: "beg", transactionId: "beg-auto4", now: t });
  const s0 = await supply(), fed0 = await P.balance("reserve"), h0 = await house();
  const r = await AE.expire({ now: AE.addMonthsUTC(t, 6) });
  assert.equal(r.entries, 1);
  assert.equal(await house(), h0 + 400);
  assert.equal(await P.balance("reserve"), fed0 + 401);
  assert.equal(await supply(), s0);
  await ES.putSettings({ pat_routes: {} });
  assert.deepEqual(AE.split([["fortknox", 30], ["lotto", 20], ["nonsense!", 10]], 1000), [["fortknox", 300], ["reserve", 700]]);
  // pools still in Pepe: a negative website claim his funding tick credits to the Reserve
  await P._setMeta("live", false);
  P._forgetLive();
  await AE.credit("auto4", 99, "bonus win", { kind: "beg", transactionId: "beg2-auto4", now: t });
  await AE.expire({ now: AE.addMonthsUTC(t, 6) });
  const c = await getQuery("SELECT flow, amount, userId FROM reserve_claims WHERE flow = ?", [AE.FLOW]);
  assert.deepEqual(c.map((x) => [x.flow, x.amount, x.userId]), [[AE.FLOW, -99, null]]);
  await P._setMeta("live", true);
  P._forgetLive();
});

test("the stale cleanup: escrow isn't the balance, archive and expiry never take the same PAT, purge waits for held rewards", async () => {
  const stale = require(path.join(repo, "staleaccounts"));
  const t = Date.UTC(2026, 3, 1);
  await AE.credit("auto5", 1000, "Achievement: C", { kind: "achievements", transactionId: "stale-c", now: t });
  const s0 = await supply();
  const fed0 = await P.balance("reserve");
  const ar = await stale.archiveOne("auto5", { runId: "t1", tier: "A", why: "test", graceDays: 0, now: t });
  assert.ok(ar);
  assert.equal(await bal("auto5"), 0);
  assert.equal(await held("auto5"), 1000, "archiving leaves the escrow alone");
  const rc = await getQuery("SELECT amount FROM reserve_claims WHERE flow = 'stale_reclaim' AND userId = 'auto5'");
  assert.deepEqual(rc.map((x) => x.amount), [-500], "the cleanup reclaimed the wallet only");
  // the purge skips it while a reward is held for it
  const p1 = await stale.purge({ now: t + DAY, dryRun: false });
  assert.equal(p1.purged, 0);
  assert.match(p1.skipped.map((x) => x.why).join(","), /auto escrow/);
  // the escrow expires to the Fed on its own clock: the reclaimed wallet (claim) + the escrow (pool) = everything, once each
  await AE.expire({ now: AE.addMonthsUTC(t, 6) });
  assert.equal(await P.balance("reserve"), fed0 + 1000);
  assert.equal(await supply(), s0 - 500, "the -500 is the stale claim Pepe / the pools settle into the Fed");
  const p2 = await stale.purge({ now: AE.addMonthsUTC(t, 6) + DAY, dryRun: false });
  assert.equal(p2.purged, 1);
});

test("Pepe's PM list: only auto accounts with something new, at most every 3 days", async () => {
  const t = Date.now();
  await user("auto7", { username: "CFgggg7777", cf: "newbie" });
  await AA.markNew("auto7");
  await AE.credit("auto7", 50, "bonus win", { kind: "beg", transactionId: "beg-auto7" });
  let L = await AE.noticeLogins({ now: t });
  const me = L.find((x) => x.login === "newbie");
  assert.ok(me);
  assert.equal(me.waiting, 50);
  assert.equal(me.fresh, 50);
  assert.ok(!L.some((x) => x.login === "realguy_cf"));
  assert.equal(await AE.notified("newbie", { now: t, upto: me.upto }), true);
  assert.ok(!(await AE.noticeLogins({ now: t })).some((x) => x.login === "newbie"));
  await AE.credit("auto7", 70, "bonus win", { kind: "beg", transactionId: "beg2-auto7" });
  assert.ok(!(await AE.noticeLogins({ now: t + DAY })).some((x) => x.login === "newbie"), "not again within 3 days");
  L = await AE.noticeLogins({ now: t + 3 * DAY + 1 });
  const again = L.find((x) => x.login === "newbie");
  assert.equal(again.fresh, 70);
  assert.equal(again.waiting, 120);
});

test("admin view and settings", async () => {
  const v = await AE.adminView();
  assert.equal(v.enabled, true);
  assert.equal(v.flow, "auto_escrow_expired");
  assert.ok(v.held.amount > 0);
  assert.ok(Array.isArray(v.top) && v.top.length);
  const s = await AE.setSettings({ kinds: "achievements, levelup", enabled: false, note: "test" }, { userId: "admin", username: "boss" });
  assert.deepEqual(s, { enabled: false, kinds: ["achievements", "levelup"] });
  await assert.rejects(AE.setSettings({ kinds: "bad kind!" }, { userId: "admin", username: "boss" }), /bad kind/);
  await assert.rejects(AE.setSettings({ enabled: "yes" }, { userId: "admin", username: "boss" }), /true or false/);
  // off: new rewards are paid, what was held is still claimable
  await runQuery("UPDATE users SET discordId = '77' WHERE userId = 'auto7'");
  const r = await AE.release("auto7");
  assert.equal(r.amount, 120);
});
