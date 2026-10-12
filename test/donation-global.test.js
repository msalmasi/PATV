// 1.99uh: the GLOBAL daily donation cap (donationpromo.js + stripebilling.donate / webhook + cryptopay.settle).
// Fixed clocks only (each test on its own New York day): the fixed and % modes, the supply frozen at the day's start, open
// checkouts reserved, the partial-fit offer + "full for today", the webhook race credited and flagged, the crypto hold, the
// USD cap, and all three limits together (per-member limit, promo cap, global cap).
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

test("fixed mode: open checkouts are reserved, a partial fit is offered, then 'full for today'; a new day reopens", async () => {
  now = NOON(0);
  await settings({ global_mode: "fixed", global_pat: 6000000 });             // = $20 a day at 300k minted per $1
  assert.deepEqual(await DP.globalPublic(), { on: true, full: false, pct_left: 100, resets_at: START(1), tz: "America/New_York" });
  await SB.donate(user("ann"), { usd: 15 });                                 // open: 4.5M reserved
  assert.equal((await DP.globalPublic()).pct_left, 25);
  await assert.rejects(SB.donate(user("bob"), { usd: 10 }), (e) => e.status === 409 && /room for \$5 more - you can donate up to \$5/.test(e.message));
  const q = await DP.quote("u-bob", 10);
  assert.deepEqual(q.global, { on: true, fits: false, max_usd: 5 });
  assert.equal(sess, 1, "no Stripe session for the refused one");
  await SB.donate(user("bob"), { usd: 5 });
  await assert.rejects(SB.donate(user("cy"), { usd: 1 }), /Donations are full for today; they reopen at midnight New York time/);
  assert.equal((await DP.globalPublic()).full, true);
  const A = await DP.globalAdmin();
  assert.deepEqual([A.cap_pat, A.used_pat, A.left_pat], [6000000, 6000000, 0]);
  now = START(1);
  assert.equal((await DP.globalPublic()).full, false, "midnight New York reopens it");
});

test("% mode: the cap is a % of the supply FROZEN at the day's start - it doesn't drift that day", async () => {
  now = START(2) + 1000;                                                    // 00:00:01 - the minute timer's first look
  await settings({ global_mode: "pct", global_pct: 0.5 });
  DP._setSupply(async () => 1000000000);
  assert.equal(await DP.ensureFrozen(now), 1000000000);
  DP._setSupply(async () => 3000000000);                                    // supply grows during the day
  now = NOON(2);
  assert.equal((await DP.globalCaps(now)).pat, 5000000, "0.5% of the frozen 1B, not of 3B");
  assert.equal((await DP.globalAdmin()).supply, 1000000000);
  await SB.handleEvent(paidEv("evt_p1", "dee", 1500, "cs_p1", now));       // $15 -> 4.5M of 5M
  await assert.rejects(SB.donate(user("eli"), { usd: 2 }), /room for \$1 more/);
  now = NOON(3);
  assert.equal((await DP.globalCaps(now)).pat, 15000000, "the next day freezes the new supply (0.5% of 3B)");
  DP._setSupply(async () => 1000000000);
});

test("the webhook race: paid checkouts over the cap are credited (the money is taken), flagged and counted", async () => {
  now = NOON(4);
  await settings({ global_mode: "fixed", global_pat: 3000000 });            // $10
  await SB.handleEvent(paidEv("evt_r1", "fox", 800, "cs_r1", now));
  const r = await SB.handleEvent(paidEv("evt_r2", "gil", 500, "cs_r2", now + 1000));
  assert.equal(r.outcome, "donation-credited");
  assert.equal(await bal("gil"), 1250000);
  const rows = await getQuery("SELECT ref, over_global, pat FROM donation_usd_log WHERE ref IN ('don-evt_r1','don-evt_r2') ORDER BY ref");
  assert.deepEqual(rows.map((x) => [x.ref, x.over_global, x.pat]), [["don-evt_r1", 0, 2400000], ["don-evt_r2", 1, 1500000]]);
  const A = await DP.globalAdmin();
  assert.equal(A.used_pat, 3900000, "counted"); assert.ok(A.flagged_count >= 1);
  assert.equal((await SB.handleEvent(paidEv("evt_r2", "gil", 500, "cs_r2", now + 1000))).outcome, "dup");
  assert.equal((await DP.globalAdmin()).used_pat, 3900000, "a retry never counts twice");
});

test("crypto over the global cap is held (global_daily_limit, donor told); approve credits it at the seen-time terms", async () => {
  now = NOON(5);
  await settings({ global_mode: "fixed", global_pat: 3000000 });
  await SB.handleEvent(paidEv("evt_c1", "hal", 900, "cs_c1", now));       // 2.7M of 3M
  const id = await cryptoPay("hal", 500, now + 60000);
  assert.equal(await CP.settle(id), "held");
  const p = (await getQuery("SELECT status, hold_reason FROM crypto_payments WHERE id = ?", [id]))[0];
  assert.deepEqual([p.status, p.hold_reason], ["held", "global_daily_limit"]);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = 'u-hal' AND ref LIKE 'cglobal-%'"))[0].n, 1);
  assert.equal((await DP.globalAdmin()).crypto_held, 1);
  now = NOON(6);                                                            // approved the next day - still the seen day's terms
  assert.equal((await CP.decide(id, "approve", "admin")).status, "credited");
  assert.equal(await bal("hal"), 2250000 + 1250000);
  const l = (await getQuery("SELECT over_global, paid_at FROM donation_usd_log WHERE ref = (SELECT claim_id FROM crypto_payments WHERE id = ?)", [id]))[0];
  assert.equal(l.over_global, 1, "counted on the day it was seen, flagged");
  assert.equal(l.paid_at, NOON(5) + 60000);
});

test("the USD cap alone (mode off): whichever is hit first", async () => {
  now = NOON(7);
  await settings({ global_usd: 30 });
  await SB.donate(user("ann"), { usd: 25 });
  await assert.rejects(SB.donate(user("bob"), { usd: 10 }), /room for \$5 more/);
  // and with a PAT cap that binds earlier
  await settings({ global_usd: 30, global_mode: "fixed", global_pat: 7800000 }); // 7.5M used by the open $25 -> $1 fits
  await assert.rejects(SB.donate(user("bob"), { usd: 5 }), /room for \$1 more/);
});

test("all three together: the per-member limit, the promo cap and the global cap each apply", async () => {
  now = NOON(8);
  // promo 500k per $1 (2x), first $10 per donor; member limit $50/day; global 14M PAT
  await settings({ daily_limit_usd: 50, global_mode: "fixed", global_pat: 14000000 });
  const P = await DP.create(ADMIN, { mode: "rate", rate: 500000, cap_usd: 10, starts: now, ends: now + 3600e3 });
  // $40: $10 at 500k + $30 at 250k = 12.5M to the donor + 20% of the normal 7.5M = 1.5M bonus -> 14M minted
  const q = await DP.quote("u-eli", 40);
  assert.deepEqual([q.pat, q.bonus, q.promo_cents, q.limit.over, q.global.fits], [12500000, 1500000, 1000, false, true]);
  await assert.rejects(SB.donate(user("eli"), { usd: 51 }), /donate \$50 more today/, "the member limit first");
  await SB.donate(user("eli"), { usd: 40 });
  await assert.rejects(SB.donate(user("eli"), { usd: 11 }), /donate \$10 more today/, "member: $10 left");
  await assert.rejects(SB.donate(user("fox"), { usd: 1 }), /Donations are full for today/, "global: 14M reserved");
  await SB.handleEvent(paidEv("evt_all", "eli", 4000, lastSession, now));
  assert.equal(await bal("eli"), 12500000);
  const A = await DP.globalAdmin();
  assert.equal(A.used_pat, 14000000);
  await DP.end(ADMIN, P.id);
});

test("settings are validated and audit-logged", async () => {
  await assert.rejects(DP.setSettings(ADMIN, { global_mode: "lots" }), /off, a fixed PAT amount/);
  await assert.rejects(DP.setSettings(ADMIN, { global_pct: 101 }), /0 to 100/);
  await assert.rejects(DP.setSettings(ADMIN, { global_pat: -1 }), /whole number of PAT/);
  const a = await getQuery("SELECT detail FROM admin_audit WHERE action = 'donation_promo' AND detail LIKE '%global_%'");
  assert.ok(a.length >= 5);
});
