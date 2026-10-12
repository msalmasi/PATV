// 1.99ts: the daily donation limit (donationpromo.js + stripebilling.donate / webhook + cryptopay.settle / decide).
// Fixed clocks only (never the real time of day): the New York day edges, open checkouts counted, the webhook race credited
// and flagged, the crypto hold -> admin credit (promo terms of the moment it was seen) / refunded mark, the per-member
// override, the quote, and the account-merge rule for the new tables.
//   NODE_PATH=<a PATV node_modules with @noble/curves> node --test test/donation-limit.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "donlimit-test-")));
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.STRIPE_ENABLED = "1";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_fake";
const { runQuery, getQuery, tx } = require(path.join(repo, "dbUtils"));
const F = require(path.join(repo, "funding"));
const DP = require(path.join(repo, "donationpromo"));
const SB = require(path.join(repo, "stripebilling"));
const CP = require(path.join(repo, "cryptopay"));
const AM = require(path.join(repo, "accountMerge"));

const T0 = Date.UTC(2026, 9, 12, 16, 0, 0);            // Mon 12:00 New York (EDT) - the day is [04:00Z Oct 12, 04:00Z Oct 13)
const DAY0 = Date.UTC(2026, 9, 12, 4), DAY1 = Date.UTC(2026, 9, 13, 4);
let now = T0;
DP._setClock(() => now); SB._setClock(() => now); CP._setClock(() => now);
const ADMIN = { userId: "u-admin", username: "admin", class: "Admin" };
const user = (n) => ({ userId: "u-" + n, username: n, class: "pleb" });
const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", ["u-" + u]))[0].b;
let sess = 0, lastSession = null;
SB._setFetch(async () => { lastSession = "cs_lim_" + (++sess); return { ok: true, json: async () => ({ id: lastSession, url: "https://checkout.stripe.com/c/pay/" + lastSession }) }; });
const paidEv = (id, u, cents, sessionId, createdMs) => ({ id, type: "checkout.session.completed", created: Math.floor(createdMs / 1000),
  data: { object: { id: sessionId, object: "checkout.session", mode: "payment", payment_status: "paid", amount_total: cents, currency: "usd",
                    created: Math.floor(createdMs / 1000), client_reference_id: "u-" + u, metadata: { kind: "donation", userId: "u-" + u } } } });
let payN = 0;
async function cryptoPay(u, cents, seenMs) {
  const addr = "0x" + String(u).padEnd(40, "0").replace(/[^0-9a-f]/g, "b").slice(0, 40);
  await runQuery("INSERT OR IGNORE INTO crypto_wallets (user_id, family, address, created) VALUES (?, 'evm', ?, ?)", ["u-" + u, addr, now]);
  const id = "eth:0x" + String(++payN).padStart(64, "0") + ":1";
  await runQuery(`INSERT INTO crypto_payments (id, chain, token, token_addr, tx, idx, block, src_addr, dst_addr, raw_amount, usd_cents, status, seen)
                  VALUES (?, 'eth', 'USDC', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', ?, '1', 1, ?, '0xbd329b245135fcf5539f4d1ef40ba2d310e761a1', ?, ?, 'final', ?)`,
    [id, "0x" + String(payN).padStart(64, "0"), addr, String(cents * 10000), cents, seenMs]);
  return id;
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, note TEXT)");
  await runQuery("CREATE TABLE inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, kind TEXT, ref TEXT, title TEXT, body TEXT, link TEXT, created INTEGER, read INTEGER DEFAULT 0)").catch(() => {});
  for (const n of ["admin", "ann", "bob", "cy", "dee", "eli", "old", "new", "vip"]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class) VALUES (?, ?, ?, 'x', ?)", ["u-" + n, n, n, n === "admin" ? "Admin" : "pleb"]);
  }
  await F.init();
  F.sync({ reserve: 1, monetary: { donation: { rate: 500000, bonus_pct: 20 } } });
  await SB.init(); await CP.init(); await CP.set({ max_usd: 1000, min_usd: 1 }, "test"); await DP.init();
  await DP.setSettings(ADMIN, { daily_limit_usd: 100 });
});

test("the day is midnight to midnight New York time (DST-aware); no limit set = null", async () => {
  assert.deepEqual(DP.dayWindow(T0), { start: DAY0, end: DAY1 });
  assert.deepEqual(DP.dayWindow(DAY1 - 1), { start: DAY0, end: DAY1 });
  assert.deepEqual(DP.dayWindow(DAY1), { start: DAY1, end: Date.UTC(2026, 9, 14, 4) });
  assert.deepEqual(DP.dayWindow(Date.UTC(2026, 10, 2, 12)), { start: Date.UTC(2026, 10, 2, 5), end: Date.UTC(2026, 10, 3, 5) }, "EST after the change");
  assert.equal(await DP.daily(null), null);
  const d = await DP.daily("u-ann");
  assert.deepEqual([d.limit_cents, d.used_cents, d.left_cents, d.resets_at, d.tz], [10000, 0, 10000, DAY1, "America/New_York"]);
  await assert.rejects(DP.setSettings(ADMIN, { daily_limit_usd: -1 }), /whole number/);
});

test("card: open checkouts count (two tabs can't double up), over the limit is refused with what's left, an expired checkout frees it", async () => {
  await SB.donate(user("ann"), { usd: 60, back: "/support" });
  const s1 = lastSession;
  assert.equal((await DP.daily("u-ann")).left_cents, 4000, "the open $60 checkout already counts");
  await assert.rejects(SB.donate(user("ann"), { usd: 50 }), (e) => e.status === 409 && /donate \$40 more today/.test(e.message) && /midnight America\/New York/.test(e.message));
  assert.equal(sess, 1, "no Stripe session was opened for the refused one");
  assert.equal((await DP.quote("u-ann", 50)).limit.over, true);
  assert.equal((await DP.quote("u-ann", 40)).limit.over, false);
  await SB.donate(user("ann"), { usd: 40 });
  await assert.rejects(SB.donate(user("ann"), { usd: 1 }), /reached today's donation limit/);
  // the first checkout expires unpaid -> its $60 is free again
  await SB.handleEvent({ id: "evt_exp1", type: "checkout.session.expired", created: 1, data: { object: { id: s1, object: "checkout.session", metadata: { kind: "donation", userId: "u-ann" } } } });
  assert.equal((await DP.daily("u-ann")).left_cents, 6000);
  // ...and a hold past its expiry stops counting by itself (31-minute sessions)
  const s2 = lastSession;
  now += 40 * 60000;
  assert.equal((await DP.daily("u-ann")).left_cents, 10000);
  // paying the open one (Stripe can still deliver it) counts it as credited, not twice
  await SB.handleEvent(paidEv("evt_s2", "ann", 4000, s2, T0));
  assert.equal((await DP.daily("u-ann")).left_cents, 6000);
  assert.equal(await bal("ann"), 20000000);
  now = T0;
});

test("window edges: a donation paid at 23:59:59 New York counts for that day, not the next; one at 00:00 counts for the new day", async () => {
  await SB.handleEvent(paidEv("evt_e1", "bob", 9000, "cs_e1", DAY1 - 1000));
  now = DAY1 - 1000;
  assert.equal((await DP.daily("u-bob")).left_cents, 1000);
  now = DAY1;
  assert.equal((await DP.daily("u-bob")).left_cents, 10000, "a new day");
  await SB.handleEvent(paidEv("evt_e2", "bob", 10000, "cs_e2", DAY1));
  assert.equal((await DP.daily("u-bob")).left_cents, 0);
  now = T0;
});

test("webhook race: two checkouts paid at once past the limit - both credited (the money is taken), the second flagged and counted", async () => {
  await SB.handleEvent(paidEv("evt_r1", "cy", 8000, "cs_r1", T0));
  const r = await SB.handleEvent(paidEv("evt_r2", "cy", 5000, "cs_r2", T0 + 1000));
  assert.equal(r.outcome, "donation-credited");
  assert.equal(await bal("cy"), 65000000);
  const rows = await getQuery("SELECT ref, over_limit, usd_cents FROM donation_usd_log WHERE user_id = 'u-cy' ORDER BY paid_at");
  assert.deepEqual(rows.map((x) => [x.ref, x.over_limit]), [["don-evt_r1", 0], ["don-evt_r2", 1]]);
  assert.equal((await DP.daily("u-cy")).used_cents, 13000, "counted");
  const st = await DP.limitState();
  assert.ok(st.flagged.some((f) => f.ref === "don-evt_r2") && st.flagged_count >= 1);
  // a retried event never double counts
  assert.equal((await SB.handleEvent(paidEv("evt_r2", "cy", 5000, "cs_r2", T0 + 1000))).outcome, "dup");
  assert.equal((await DP.daily("u-cy")).used_cents, 13000);
});

test("crypto: over the limit is HELD (not credited, the donor is told); the admin credits it at the seen-time terms, or marks it refunded", async () => {
  await SB.handleEvent(paidEv("evt_c0", "dee", 8000, "cs_c0", T0));
  // a promo live when the transfer is seen
  const P = await DP.create(ADMIN, { mode: "mult", mult: 2, cap_usd: 100, starts: T0, ends: T0 + 3600e3 });
  const id = await cryptoPay("dee", 5000, T0 + 60000);
  assert.equal(await CP.settle(id), "held");
  const p = (await getQuery("SELECT status, hold_reason, pat FROM crypto_payments WHERE id = ?", [id]))[0];
  assert.deepEqual([p.status, p.hold_reason, p.pat], ["held", "daily_limit", null]);
  assert.equal(await bal("dee"), 40000000, "not credited");
  const n = await getQuery("SELECT body FROM inbox WHERE user_id = 'u-dee' AND ref LIKE 'climit-%'");
  assert.equal(n.length, 1); assert.match(n[0].body, /daily donation limit \(\$80\.00 of \$100\.00/);
  assert.equal((await DP.limitState()).crypto_held, 1);
  // the promo ends; the admin credits it anyway - at the terms of when it was SEEN (promo: $20 of the $100 promo cap is left
  // after the $80 card... the card donation was before the promo, so all $50 fit the promo cap)
  now = T0 + 2 * 3600e3;
  await DP.end(ADMIN, P.id).catch(() => {});
  assert.equal((await CP.decide(id, "approve", "admin", "ok")).status, "credited");
  assert.equal(await bal("dee"), 40000000 + 50000000, "$50 at 2x the normal rate");
  const l = (await getQuery("SELECT over_limit FROM donation_usd_log WHERE ref = (SELECT claim_id FROM crypto_payments WHERE id = ?)", [id]))[0];
  assert.equal(l.over_limit, 1, "an approved over-limit credit is flagged and counted");
  // another one over the limit, sent back by hand
  const id2 = await cryptoPay("dee", 2000, T0 + 120000);
  assert.equal(await CP.settle(id2), "held");
  assert.equal((await CP.decide(id2, "refunded", "admin", "sent back 0xabc")).status, "refunded");
  assert.equal(await bal("dee"), 90000000);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = 'u-dee' AND ref LIKE 'crefund-%'"))[0].n, 1);
  await assert.rejects(CP.decide(id2, "approve", "admin"), /not held/);
  // under the limit the next day: credited normally
  const id3 = await cryptoPay("dee", 1000, DAY1 + 1000);
  now = DAY1 + 2000;
  assert.equal(await CP.settle(id3), "credited");
  now = T0;
});

test("per-member override: higher, lower, 0 = none, removed = the default again; audit-logged", async () => {
  await DP.setOverride(ADMIN, "u-vip", 500, "big fan");
  assert.equal((await DP.daily("u-vip")).limit_cents, 50000);
  await SB.donate(user("vip"), { usd: 300 });
  await DP.setOverride(ADMIN, "u-vip", 0, "no limit");
  assert.equal(await DP.daily("u-vip"), null);
  await SB.donate(user("vip"), { usd: 1000 });
  await DP.setOverride(ADMIN, "u-eli", 10);
  await assert.rejects(SB.donate(user("eli"), { usd: 11 }), /\$10 more today/);
  await DP.setOverride(ADMIN, "u-eli", "");
  assert.equal((await DP.daily("u-eli")).limit_cents, 10000, "the default again");
  await assert.rejects(DP.setOverride(ADMIN, "u-eli", -5), /whole number/);
  const a = await getQuery("SELECT detail FROM admin_audit WHERE action = 'donation_limit' ORDER BY id");
  assert.deepEqual(a.map((r) => JSON.parse(r.detail).after), [500, 0, 10, null]);
  const s = await getQuery("SELECT detail FROM admin_audit WHERE action = 'donation_promo' AND detail LIKE '%daily_limit_usd%'");
  assert.equal(s.length, 1, "the default's change is audit-logged too");
});

test("account merge: the day's donations and an override move - the merged account has ONE daily limit", async () => {
  assert.ok(AM.classify("donation_usd_log", "user_id").move);
  assert.ok(AM.classify("donation_limit_overrides", "user_id").move);
  await SB.handleEvent(paidEv("evt_m1", "old", 7000, "cs_m1", T0));
  await SB.handleEvent(paidEv("evt_m2", "new", 2000, "cs_m2", T0));
  await DP.setOverride(ADMIN, "u-old", 300);
  await tx(() => AM.moveUserRows("u-old", "u-new", { fromUsername: "old", toUsername: "new" }));
  const d = await DP.daily("u-new");
  assert.equal(d.used_cents, 9000);
  assert.equal(d.limit_cents, 30000, "the old account's override came along (the target had none)");
});
