// banfix review (siteban.js, ledger.js): the paths that act for an account WITHOUT a session refuse a site-banned one where it
// starts something - and the ledger backs every one of them up:
//   * ledger.post: a debit the account has to cover itself (requireCover - a spend, a stake, a buy) is refused for a site-banned
//     account (E_SITE_BANNED), whoever asks; opts.system (a repayment, a clawback, the deletion job's routing) and credits still go;
//     an Admin with a stray ban (exempt - D1), a temporary ban that has ended, a pad's ban: unaffected
//   * Pepe's generic charges: /api/wager/charge (index.js - its routed form is patroutes.charge) and /api/pat/charge (pools.charge)
//     refuse a banned account - or one PATV staff scheduled for deletion - for what it starts (a duel stake, a paid command, heist
//     gear); a fine / a clawback (siteban.systemCharge) is not the account acting and still goes through
// Fake accounts only.
//   node --test test/siteban-ledger.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "siteban-ledger-test-")));
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const SB = require(path.join(repo, "siteban"));
const ledger = require(path.join(repo, "ledger"));
const PR = require(path.join(repo, "patroutes"));
const P = require(path.join(repo, "pools"));

const bal = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;
const DAY = 86400000;
async function ban(id, { room = "", until = null } = {}) {
  await runQuery(`INSERT INTO feed_bans (user_id, room_id, username, reason, by, at, until) VALUES (?, ?, ?, 'spam', 'staffer', ?, ?)
                  ON CONFLICT(user_id, room_id) DO UPDATE SET until = excluded.until`, [id, room, id, Date.now(), until]);
  SB.forget(id);
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, created DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE supply_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), pools TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery(`CREATE TABLE feed_bans (user_id TEXT NOT NULL, room_id TEXT NOT NULL DEFAULT '', username TEXT, reason TEXT, by TEXT, at INTEGER, until INTEGER,
                  PRIMARY KEY (user_id, room_id))`);
  await runQuery(`CREATE TABLE account_deletions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, state TEXT, requested_at INTEGER, execute_at INTEGER,
                  requested_by TEXT, reauth TEXT, reason TEXT)`);
  for (const [id, name, cls] of [["u1", "ann", "pleb"], ["u2", "tee", "pleb"], ["u3", "zed", "Admin"], ["u4", "old", "pleb"], ["u5", "pad", "pleb"], ["u6", "del", "pleb"]]) {
    await runQuery("INSERT INTO users (userId, username, password, class, points_balance, camfrogUsername) VALUES (?, ?, 'x', ?, 100000, ?)", [id, name, cls, name + "_cf"]);
  }
  await P.init();
});

test("ledger.post: a site-banned account's own debit is refused (E_SITE_BANNED); system moves, credits and everyone else go through", async () => {
  await ban("u2");
  const b0 = await bal("u2");
  const r = await ledger.post("u2", -500, "market-buy", { requireCover: true, source: "capital" });
  assert.equal(r.ok, false);
  assert.equal(r.code, ledger.E_SITE_BANNED);
  assert.equal(await bal("u2"), b0, "nothing moved");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM transactions WHERE userId = 'u2'"))[0].n, 0, "no row");
  // not the account acting: a repayment / clawback / the deletion's routing (system), a credit, a debit nobody had to cover
  assert.equal((await ledger.post("u2", -100, "loan-repayment", { requireCover: true, system: true })).ok, true);
  assert.equal((await ledger.post("u2", 300, "refund", {})).ok, true);
  assert.equal((await ledger.post("u2", -50, "padfine", {})).ok, true);
  assert.equal(await bal("u2"), b0 - 100 + 300 - 50);
  // unaffected: a member, an Admin with a stray ban (D1), a temporary ban that has ended, a pad's ban
  assert.equal((await ledger.post("u1", -500, "market-buy", { requireCover: true })).ok, true);
  await ban("u3");
  assert.equal((await ledger.post("u3", -500, "market-buy", { requireCover: true })).ok, true, "an Admin is exempt");
  await ban("u4", { until: Date.now() - 1000 });
  assert.equal((await ledger.post("u4", -500, "market-buy", { requireCover: true })).ok, true, "an ended ban");
  await ban("u5", { room: "PepeLab" });
  assert.equal((await ledger.post("u5", -500, "market-buy", { requireCover: true })).ok, true, "a pad's ban isn't a site ban");
  // lifted: at once (forget)
  await runQuery("DELETE FROM feed_bans WHERE user_id = 'u2'");
  SB.forget("u2");
  assert.equal((await ledger.post("u2", -500, "market-buy", { requireCover: true })).ok, true);
  await ban("u2");
});

test("Pepe's routed charge (patroutes.charge - /api/wager/charge with a route): a banned account isn't charged; a fine / clawback is", async () => {
  const b0 = await bal("u2");
  const r = await PR.charge({ key: "cmd-banfix-000001", userId: "u2", username: "tee", amount: 1000, reason: "command-ask", route: { flow: "ask", room: null, payer: "tee_cf", item_sink: null } });
  assert.equal(r.ok, false);
  assert.equal(r.code, ledger.E_SITE_BANNED);
  assert.equal(await bal("u2"), b0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pat_route_intents WHERE key = 'cmd-banfix-000001'"))[0].n, 0, "no route intent");
  const f = await PR.charge({ key: "cmd-banfix-000002", userId: "u2", username: "tee", amount: 200, reason: "market-resettle-clawback", route: { flow: "resettle", room: null, payer: null, item_sink: null } });
  assert.equal(f.ok, true, "a clawback is not the account acting");
  assert.equal(await bal("u2"), b0 - 200);
  assert.equal(SB.systemCharge("modfine"), true);
  assert.equal(SB.systemCharge("rw-rehearsal-return"), true);
  assert.equal(SB.systemCharge("command-ask"), false);
  assert.equal(SB.systemCharge("duel"), false);
});

test("index.js /api/wager/charge: a banned or staff-deleting account is refused BEFORE either debit; fines / clawbacks are let through", () => {
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  const i = src.indexOf('app.post("/api/wager/charge"');
  assert.ok(i > 0);
  const body = src.slice(i, src.indexOf("app.post(", i + 10));
  const check = body.indexOf("siteBan.startLock(userId)");
  assert.ok(check > 0, "the route asks siteban.startLock");
  assert.ok(body.indexOf("siteBan.systemCharge(reason)") > 0 && body.indexOf("siteBan.systemCharge(reason)") < check, "a fine / clawback skips it");
  assert.ok(check < body.indexOf("patroutes.charge("), "before the routed charge");
  assert.ok(check < body.indexOf("ledger.post(userId, -amount"), "before the plain debit");
  assert.match(body, /reply\(403, \{ ok: false, error: lock\.kind === "deletion" \? "deleting" : "banned"/, "a keyed 403 (a retry replays it)");
});

test("pools.charge (/api/pat/charge): a banned account - or one under a staff deletion - pays for nothing it starts; a fine passes the check", async () => {
  const legs = [["reserve", 1000]];
  await assert.rejects(P.charge({ key: "cmd-banfix-000003", username: "tee", amount: 1000, reason: "command-imagine", route: { flow: "imagine" }, legs }),
                       (e) => e.code === "E_SITE_BANNED" && e.status === 403 && /banned/.test(e.message));
  await runQuery("INSERT INTO account_deletions (user_id, state, requested_at, execute_at, requested_by, reauth) VALUES ('u6', 'scheduled', ?, ?, 'admin:u3', 'admin')",
                 [Date.now(), Date.now() + 14 * DAY]);
  SB.forget("u6");
  await assert.rejects(P.charge({ key: "cmd-banfix-000004", username: "del", amount: 1000, reason: "command-imagine", route: { flow: "imagine" }, legs }),
                       (e) => e.code === "E_DELETION_PENDING" && /scheduled for deletion/.test(e.message));
  // a moderator's fine isn't the account acting: past the ban check (then this test database's pools aren't live)
  await assert.rejects(P.charge({ key: "cmd-banfix-000005", username: "tee", amount: 1000, reason: "modfine", route: { flow: "modfine" }, legs }),
                       (e) => e.code !== "E_SITE_BANNED" && e.code !== "E_DELETION_PENDING");
  // a member's OWN pending request doesn't count, nor a cancelled staff one
  await runQuery("UPDATE account_deletions SET requested_by = 'self' WHERE user_id = 'u6'");
  SB.forget("u6");
  assert.equal(await SB.startLock("u6"), null);
  await runQuery("UPDATE account_deletions SET requested_by = 'admin:u3', state = 'cancelled' WHERE user_id = 'u6'");
  SB.forget("u6");
  assert.equal(await SB.startLock("u6"), null);
  assert.equal(await bal("u6"), 100000);
});

// banfix final verify: Pepe's penalties (a fine, an exploit clawback) are system debits - a site ban never blocks them; any
// other deduction (and every credit) is not flagged
test("botcredits.systemDebit: only a NEGATIVE fine/modfine/automod-fine/exploit/clawback is a system debit", () => {
  const BC = require(path.join(repo, "botcredits"));
  for (const t of ["fine", "modfine", "automod-fine", "Automod-Fine", "exploit", "clawback"]) assert.equal(BC.systemDebit(t, -100), true, t);
  for (const [t, a] of [["automod-fine", 100], ["fine", 0], ["dice", -100], ["slots", -5], ["fine-refund", -5], ["", -1], [null, -1]])
    assert.equal(BC.systemDebit(t, a), false, `${t} ${a}`);
});

test("a system debit on a site-banned account goes through (what botcredits passes for a fine)", async () => {
  await ban("u2");
  const b0 = await bal("u2");
  const r = await ledger.post("u2", -100, "bonus win", { requireCover: true, system: true, source: "bonus automod-fine" });
  assert.equal(r.ok, true);
  assert.equal(await bal("u2"), b0 - 100);
});
