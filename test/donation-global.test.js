// 1.99uh: the GLOBAL daily donation cap (donationpromo.js + stripebilling.donate / webhook + cryptopay.settle).
// Fixed clocks only (each test on its own New York day): the fixed and % modes, the supply frozen at the day's start, open
// checkouts reserved, the partial-fit offer + "full for today", the webhook race credited and flagged, the crypto hold, the
// USD cap, and all three limits together (per-member limit, promo cap, global cap).
// 1.99ans (no PAT for dollars, nopat.js): a donation mints 0 PAT, so the PAT caps never fill and the USD cap does the limiting;
// promos are retired - the tests below are the USD cap, the race, the crypto hold, and the member limit with it.
//   NODE_PATH=<a PATV node_modules with @noble/curves> node --test test/donation-global.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "donglobal-test-")));
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.STRIPE_ENABLED = "1";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_fake";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const F = require(path.join(repo, "funding"));
const DP = require(path.join(repo, "donationpromo"));
const SB = require(path.join(repo, "stripebilling"));
const CP = require(path.join(repo, "cryptopay"));

const DAY = 86400000;
const NOON = (d) => Date.UTC(2026, 9, 12 + d, 16, 0, 0);       // 12:00 New York (EDT) on Oct 12 + d
const START = (d) => Date.UTC(2026, 9, 12 + d, 4, 0, 0);       // 00:00 New York
let now = NOON(0);
DP._setClock(() => now); SB._setClock(() => now); CP._setClock(() => now);
const ADMIN = { userId: "u-admin", username: "admin", class: "Admin" };
const user = (n) => ({ userId: "u-" + n, username: n, class: "pleb" });
const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", ["u-" + u]))[0].b;
let sess = 0, lastSession = null;
SB._setFetch(async () => { lastSession = "cs_g_" + (++sess); return { ok: true, json: async () => ({ id: lastSession, url: "https://checkout.stripe.com/c/pay/" + lastSession }) }; });
const paidEv = (id, u, cents, sessionId, createdMs) => ({ id, type: "checkout.session.completed", created: Math.floor(createdMs / 1000),
  data: { object: { id: sessionId, object: "checkout.session", mode: "payment", payment_status: "paid", amount_total: cents, currency: "usd",
                    created: Math.floor(createdMs / 1000), client_reference_id: "u-" + u, metadata: { kind: "donation", userId: "u-" + u } } } });
let payN = 0;
async function cryptoPay(u, cents, seenMs) {
  const addr = "0x" + String(u).padEnd(40, "0").replace(/[^0-9a-f]/g, "c").slice(0, 40);
  await runQuery("INSERT OR IGNORE INTO crypto_wallets (user_id, family, address, created) VALUES (?, 'evm', ?, ?)", ["u-" + u, addr, now]);
  const id = "eth:0x" + String(++payN).padStart(64, "0") + ":1";
  await runQuery(`INSERT INTO crypto_payments (id, chain, token, token_addr, tx, idx, block, src_addr, dst_addr, raw_amount, usd_cents, status, seen)
                  VALUES (?, 'eth', 'USDC', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', ?, '1', 1, ?, '0xbd329b245135fcf5539f4d1ef40ba2d310e761a1', ?, ?, 'final', ?)`,
    [id, "0x" + String(payN).padStart(64, "0"), addr, String(cents * 10000), cents, seenMs]);
  return id;
}
async function settings(o) { await DP.setSettings(ADMIN, { global_mode: "off", global_pat: 0, global_pct: 0, global_usd: 0, daily_limit_usd: 0, ...o }); }

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, note TEXT)");
  await runQuery("CREATE TABLE inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, kind TEXT, ref TEXT, title TEXT, body TEXT, link TEXT, created INTEGER, read INTEGER DEFAULT 0)").catch(() => {});
  for (const n of ["admin", "ann", "bob", "cy", "dee", "eli", "fox", "gil", "hal"]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class) VALUES (?, ?, ?, 'x', ?)", ["u-" + n, n, n, n === "admin" ? "Admin" : "pleb"]);
  }
  await F.init();
  // prod's terms today: 250,000 PAT per $1, +20% to incentives -> $1 mints 300,000 PAT
  F.sync({ reserve: 1, monetary: { donation: { rate: 250000, bonus_pct: 20 } } });
  await SB.init(); await CP.init(); await CP.set({ max_usd: 1000, min_usd: 1 }, "test"); await DP.init();
  DP._setSupply(async () => 1000000000);
});

// 1.99ans (no PAT for dollars, nopat.js): a donation mints 0 PAT, so the PAT caps (fixed / % of supply) can never fill; the
// USD cap is what limits a day's donations now.
test("1.99ans: the PAT caps can never fill - a donation mints nothing; nobody is credited PAT", async () => {
  now = NOON(0);
  await settings({ global_mode: "fixed", global_pat: 6000000 });
  for (const [u, usd] of [["ann", 15], ["bob", 10], ["cy", 5]]) await SB.donate(user(u), { usd });
  assert.equal((await DP.globalPublic()).full, false);
  const A = await DP.globalAdmin();
  assert.deepEqual([A.cap_pat, A.used_pat, A.left_pat], [6000000, 0, 6000000]);
  assert.deepEqual(await DP.quote("u-dee", 10).then((q) => [q.pat, q.bonus, q.global.fits]), [0, 0, true]);
  now = START(2) + 1000;
  await settings({ global_mode: "pct", global_pct: 0.5 });
  assert.equal(await DP.ensureFrozen(now), 1000000000, "the % cap still freezes its base");
  now = NOON(2);
  await SB.handleEvent(paidEv("evt_p1", "dee", 1500, "cs_p1", now));
  assert.equal((await DP.globalAdmin()).used_pat, 0);
  assert.equal(await bal("dee"), 0, "no PAT for dollars");
});

test("the USD cap: open checkouts are reserved, a partial fit is offered, then 'full for today'; a new day reopens", async () => {
  now = NOON(7);
  await settings({ global_usd: 30 });
  assert.equal((await DP.globalPublic()).pct_left, 100);
  await SB.donate(user("ann"), { usd: 25 });
  await assert.rejects(SB.donate(user("bob"), { usd: 10 }), (e) => e.status === 409 && /room for \$5 more - you can donate up to \$5/.test(e.message));
  const q = await DP.quote("u-bob", 10);
  assert.deepEqual(q.global, { on: true, fits: false, max_usd: 5 });
  await SB.donate(user("bob"), { usd: 5 });
  await assert.rejects(SB.donate(user("cy"), { usd: 1 }), /Donations are full for today; they reopen at midnight New York time/);
  assert.equal((await DP.globalPublic()).full, true);
  const A = await DP.globalAdmin();
  assert.deepEqual([A.cap_cents, A.used_cents, A.left_cents, A.used_pat], [3000, 3000, 0, 0]);
  now = START(8);
  assert.equal((await DP.globalPublic()).full, false, "midnight New York reopens it");
});

test("the webhook race over the USD cap: counted (the money is taken) and flagged - and still no PAT", async () => {
  now = NOON(4);
  await settings({ global_usd: 10 });
  await SB.handleEvent(paidEv("evt_r1", "fox", 800, "cs_r1", now));
  const r = await SB.handleEvent(paidEv("evt_r2", "gil", 500, "cs_r2", now + 1000));
  assert.equal(r.outcome, "donation-perks");
  assert.equal(await bal("gil"), 0);
  const rows = await getQuery("SELECT ref, over_global, pat FROM donation_usd_log WHERE ref IN ('don-evt_r1','don-evt_r2') ORDER BY ref");
  assert.deepEqual(rows.map((x) => [x.ref, x.over_global, x.pat]), [["don-evt_r1", 0, 0], ["don-evt_r2", 1, 0]]);
  const A = await DP.globalAdmin();
  assert.equal(A.used_cents, 1300, "counted"); assert.ok(A.flagged_count >= 1);
  assert.equal((await SB.handleEvent(paidEv("evt_r2", "gil", 500, "cs_r2", now + 1000))).outcome, "dup");
  assert.equal((await DP.globalAdmin()).used_cents, 1300, "a retry never counts twice");
});

test("crypto over the USD cap is held (global_daily_limit, donor told); approve counts it on the seen day - no PAT", async () => {
  now = NOON(5);
  await settings({ global_usd: 10 });
  await SB.handleEvent(paidEv("evt_c1", "hal", 900, "cs_c1", now));
  const id = await cryptoPay("hal", 500, now + 60000);
  assert.equal(await CP.settle(id), "held");
  const p = (await getQuery("SELECT status, hold_reason FROM crypto_payments WHERE id = ?", [id]))[0];
  assert.deepEqual([p.status, p.hold_reason], ["held", "global_daily_limit"]);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = 'u-hal' AND ref LIKE 'cglobal-%'"))[0].n, 1);
  assert.equal((await DP.globalAdmin()).crypto_held, 1);
  now = NOON(6);
  assert.equal((await CP.decide(id, "approve", "admin")).status, "credited");
  assert.equal(await bal("hal"), 0, "no PAT for dollars");
  const l = (await getQuery("SELECT over_global, paid_at, pat FROM donation_usd_log WHERE ref = ?", [CP.claimIdOf(id)]))[0];
  assert.deepEqual([l.over_global, l.paid_at, l.pat], [1, NOON(5) + 60000, 0], "counted on the day it was seen, flagged");
});

test("the per-member limit and the USD cap both apply", async () => {
  now = NOON(9);
  await settings({ daily_limit_usd: 50, global_usd: 60 });
  await assert.rejects(SB.donate(user("eli"), { usd: 51 }), /donate \$50 more today/, "the member limit first");
  await SB.donate(user("eli"), { usd: 40 });
  await assert.rejects(SB.donate(user("eli"), { usd: 11 }), /donate \$10 more today/, "member: $10 left");
  await assert.rejects(SB.donate(user("fox"), { usd: 21 }), /room for \$20 more/, "global: $40 of $60 reserved");
  await SB.handleEvent(paidEv("evt_all", "eli", 4000, lastSession, now));
  assert.equal(await bal("eli"), 0);
  assert.equal((await DP.globalAdmin()).used_cents, 4000);
});

test("settings are validated and audit-logged", async () => {
  await assert.rejects(DP.setSettings(ADMIN, { global_mode: "lots" }), /off, a fixed PAT amount/);
  await assert.rejects(DP.setSettings(ADMIN, { global_pct: 101 }), /0 to 100/);
  await assert.rejects(DP.setSettings(ADMIN, { global_pat: -1 }), /whole number of PAT/);
  const a = await getQuery("SELECT detail FROM admin_audit WHERE action = 'donation_promo' AND detail LIKE '%global_%'");
  assert.ok(a.length >= 5);
});
