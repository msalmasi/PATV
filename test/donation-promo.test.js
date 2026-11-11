// 1.99tq: donation promos (donationpromo.js) - the ONE credit function both rails use (Stripe webhook, crypto settle).
// 1.99ans (NY S5935-A, owner 2026-11-11: "Perks only, no PAT"): promos are RETIRED and that credit is always 0 PAT
// (nopat.js). What stays tested: the pure split / ceiling arithmetic, create + edit refused, an old promo row that never
// applies (card and crypto credit 0 PAT, no promo credits row, nothing shows), the settings, the account-merge rules.
//   NODE_PATH=<a PATV node_modules> node --test test/donation-promo.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "donpromo-test-"));
process.chdir(tmp);
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

const T0 = Date.UTC(2026, 9, 12, 16, 0, 0);           // a Monday, 12:00 in New York - fixed, never "now"
let now = T0;
DP._setClock(() => now);
SB._setClock(() => now);
CP._setClock(() => now);
const ADMIN = { userId: "u-admin", username: "admin", class: "Admin" };
const H = 3600000;

const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", ["u-" + u]))[0].b;
const credits = (pid) => getQuery("SELECT * FROM donation_promo_credits WHERE promo_id = ? ORDER BY credited, rowid", [pid]);
const card = (id, user, cents, createdMs) => ({ id, type: "checkout.session.completed", created: Math.floor(createdMs / 1000) + 5,
  data: { object: { id: "cs_" + id, object: "checkout.session", mode: "payment", payment_status: "paid", amount_total: cents, currency: "usd",
                    created: Math.floor(createdMs / 1000), client_reference_id: "u-" + user, metadata: { kind: "donation", userId: "u-" + user } } } });
let payN = 0;
async function cryptoPay(user, cents, seenMs) {
  const addr = "0x" + String(user).padEnd(40, "0").replace(/[^0-9a-f]/g, "a").slice(0, 40);
  await runQuery("INSERT OR IGNORE INTO crypto_wallets (user_id, family, address, created) VALUES (?, 'evm', ?, ?)", ["u-" + user, addr, now]);
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
  for (const n of ["admin", "ann", "bob", "cat", "dan", "eve", "fay", "gus", "old", "new"]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class) VALUES (?, ?, ?, 'x', ?)", ["u-" + n, n, n, n === "admin" ? "Admin" : "pleb"]);
  }
  await F.init();
  F.sync({ reserve: 1, monetary: { donation: { rate: 500000, bonus_pct: 20 } } });
  await SB.init();
  await CP.init();
  await CP.set({ max_usd: 1000, min_usd: 1 }, "test");
  await DP.init();
});

test("split (pure): the cap splits a straddling donation pro rata; no promo = the old formula exactly", () => {
  const promo = { rate: 1000000, capCents: 10000, budgetPat: null, bonusBase: "normal" };
  // $150 with a $100 cap: $100 at 1M + $50 at 500k
  const s = DP.split({ cents: 15000, normalRate: 500000, bonusPct: 20, promo });
  assert.deepEqual([s.promo_cents, s.normal_cents, s.promo_pat, s.normal_pat, s.pat], [10000, 5000, 100000000, 25000000, 125000000]);
  assert.equal(s.bonus, 5000000, "bonus on the normal portion only (default)");
  // $40 already used: $100 -> $60 promo + $40 normal
  const s2 = DP.split({ cents: 10000, normalRate: 500000, bonusPct: 20, promo, usedCents: 4000 });
  assert.deepEqual([s2.promo_cents, s2.normal_cents], [6000, 4000]);
  // the old formula without a promo (bonus on everything)
  const n = DP.split({ cents: 1234, normalRate: 500000, bonusPct: 20 });
  assert.deepEqual([n.pat, n.bonus, n.promo_cents], [Math.floor(1234 * 500000 / 100), Math.floor(Math.floor(1234 * 500000 / 100) * 20 / 100), 0]);
  // the bonus bases
  assert.equal(DP.split({ cents: 15000, normalRate: 500000, bonusPct: 20, promo: { ...promo, bonusBase: "equivalent" } }).bonus, 15000000);
  assert.equal(DP.split({ cents: 15000, normalRate: 500000, bonusPct: 20, promo: { ...promo, bonusBase: "all" } }).bonus, 25000000);
});

test("ceilings: the effective rate is clamped to ceiling_x x the normal rate at credit time, and never below the normal rate", () => {
  assert.equal(DP.effectiveRate({ mode: "rate", rate: 9000000, ceiling_x: 10 }, 500000), 5000000);
  assert.equal(DP.effectiveRate({ mode: "mult", mult: 2, ceiling_x: 10 }, 500000), 1000000);
  assert.equal(DP.effectiveRate({ mode: "rate", rate: 400000, ceiling_x: 10 }, 500000), 0, "worse than normal = no promo portion");
  assert.equal(DP.effectiveRate({ mode: "rate", rate: 1000000, ceiling_x: 999 }, 10000), 500000, "the hard ceiling (50x) holds");
});

test("1.99ans: promos are retired - create and edit are refused before anything else; an old one can still be ended", async () => {
  await assert.rejects(DP.create(ADMIN, { mode: "rate", rate: 1000000, cap_usd: 100, starts: now, ends: now + H }), (e) => e.status === 410 && /retired/.test(e.message));
  await assert.rejects(DP.create(ADMIN, {}), /retired/, "refused before any validation");
  // a promo row from before 1.99ans
  await runQuery(`INSERT INTO donation_promos (id, label, mode, rate, cap_cents, bonus_base, enabled, starts, ends, ceiling_x, normal_rate, cancelled)
                  VALUES ('DP-old', 'Old promo', 'rate', 1000000, 10000, 'normal', 1, ?, ?, 10, 500000, 0)`, [now - H, now + 24 * H]);
  await DP.refresh();
  await assert.rejects(DP.edit(ADMIN, "DP-old", { label: "x" }), /retired/);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM donation_promos"))[0].n, 1, "nothing created");
});

test("1.99ans: an old live promo row never applies - no promo shows, every quote / credit is 0 PAT, card and crypto alike", async () => {
  assert.equal(await DP.live("u-ann"), null);
  assert.equal(DP.liveCached(), null, "the homepage banner sees none");
  const q = await DP.quote("u-ann", 50);
  assert.deepEqual([q.pat, q.bonus, q.promo_cents, q.promo], [0, 0, 0, null]);
  const pv = await DP.previewTerms({ userId: "u-ann", cents: 5000, paidAt: now });
  assert.deepEqual([pv.pat, pv.bonus, pv.usd_cents], [0, 0, 5000]);
  const ct = await DP.creditTerms({ ref: "don-x", userId: "u-ann", cents: 5000, paidAt: now, via: "card" });
  assert.deepEqual([ct.pat, ct.bonus, ct.promo, ct.perks_only], [0, 0, null, true]);
  // the card rail and the crypto rail: recorded, perks, no PAT, no promo credits row
  const b0 = await bal("ann");
  assert.equal((await SB.handleEvent(card("evt_r1", "ann", 7000, now + 1))).outcome, "donation-perks");
  const id = await cryptoPay("ann", 7000, now + 2);
  assert.equal(await CP.settle(id), "credited");
  assert.equal(await bal("ann"), b0, "no PAT for dollars");
  assert.deepEqual(await credits("DP-old"), [], "no promo split was recorded");
  assert.deepEqual((await getQuery("SELECT via, usd_cents, pat FROM donation_usd_log WHERE user_id = 'u-ann' AND status = 'credited' ORDER BY via")).map((r) => [r.via, r.usd_cents, r.pat]),
                   [["card", 7000, 0], ["crypto", 7000, 0]]);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM reserve_claims WHERE flow = 'mint:donation'"))[0].n, 0, "nothing minted");
  await DP.end(ADMIN, "DP-old");
});

test("account merge: the promo tables keep their rules (donation_promo_credits.user_id moves; the admin columns don't)", () => {
  assert.ok(AM.classify("donation_promo_credits", "user_id").move, "classified as a move");
  for (const c of ["created_by", "updated_by", "ended_by"]) assert.ok(AM.classify("donation_promos", c).deny);
});

test("settings: ceiling within 1..50, bonus base + tz validated, audited", async () => {
  await assert.rejects(DP.setSettings(ADMIN, { ceiling_x: 51 }), /1 to 50/);
  await assert.rejects(DP.setSettings(ADMIN, { tz: "Mars/Olympus" }), /time zone/);
  const r = await DP.setSettings(ADMIN, { ceiling_x: 3, bonus_base: "all" });
  assert.deepEqual(Object.keys(r.changed).sort(), ["bonus_base", "ceiling_x"]);
  await DP.setSettings(ADMIN, { ceiling_x: 10, bonus_base: "normal" });
  const a = await getQuery("SELECT detail FROM admin_audit WHERE action = 'donation_promo' AND detail LIKE '%settings%'");
  assert.equal(a.length, 2);
});
