// 1.99tq: donation promos (donationpromo.js) - the ONE credit function both rails use (Stripe webhook, crypto settle).
// Offline, fixed clocks (never time-of-day dependent): the cap split, the budget, webhook retries, card == crypto, the window
// edges, an account-less donor, validation / locks, and the account-merge rule for the new table.
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

test("admin validation: rate ceiling, end required, <= 7 days, no past start, no overlap; today-only ends at New York midnight", async () => {
  const bad = async (b, re) => assert.rejects(DP.create(ADMIN, b), (e) => e.refuse && re.test(e.message));
  await bad({ mode: "rate", rate: 6000000, cap_usd: 100, ends: now + H }, /at most 10x/);
  await bad({ mode: "rate", rate: 500000, cap_usd: 100, ends: now + H }, /more than the normal rate/);
  await bad({ mode: "mult", mult: 11, cap_usd: 100, ends: now + H }, /at most 10x/);
  await bad({ mode: "rate", rate: 1000000, cap_usd: 100 }, /end time is required/);
  await bad({ mode: "rate", rate: 1000000, cap_usd: 100, ends: now + 8 * 24 * H }, /at most 7 days/);
  await bad({ mode: "rate", rate: 1000000, cap_usd: 100, starts: now - 2 * H, ends: now + H }, /past/);
  await bad({ mode: "rate", rate: 1000000, cap_usd: 0, ends: now + H }, /cap/);
  await bad({ mode: "rate", rate: 1000000, cap_usd: 100, ends: now + H, budget: -5 }, /budget/);
  // today only: 2026-10-12 12:00 EDT -> 2026-10-13 00:00 EDT = 04:00 UTC
  assert.equal(DP.nextMidnight(T0, "America/New_York"), Date.UTC(2026, 9, 13, 4));
  assert.equal(DP.nextMidnight(Date.UTC(2026, 10, 1, 12), "America/New_York"), Date.UTC(2026, 10, 2, 5), "across the DST change (EST)");
  const p = await DP.create(ADMIN, { mode: "rate", rate: 1000000, cap_usd: 100, today: true, starts: now + 3 * H, ends: now + 4 * H, label: "x" });
  assert.equal(p.starts, now); assert.equal(p.ends, Date.UTC(2026, 9, 13, 4));
  await bad({ mode: "mult", mult: 2, cap_usd: 50, starts: now + H, ends: now + 2 * H }, /overlaps/);
  const a = await getQuery("SELECT * FROM admin_audit WHERE action = 'donation_promo'");
  assert.equal(a.length, 1, "the create is audit-logged");
  await DP.end(ADMIN, p.id);
  assert.equal((await getQuery("SELECT ends FROM donation_promos WHERE id = ?", [p.id]))[0].ends, now, "end now");
  now = Math.ceil(now / 1000) * 1000 + 1000;   // Stripe times are whole seconds
});

test("the user's example: 1M per $1 up to $100 - the cap per donor, a straddling donation, and a retried webhook", async () => {
  const p = await DP.create(ADMIN, { mode: "rate", rate: 1000000, cap_usd: 100, starts: now, ends: now + 6 * H, label: "Today only: 1M PAT per $1, up to $100" });
  // $60, then $60 (straddles: $40 promo + $20 normal), then $10 (all normal)
  const r1 = await SB.handleEvent(card("evt_a1", "ann", 6000, now + 1000));
  assert.equal(r1.outcome, "donation-credited");
  assert.equal(await bal("ann"), 60000000);
  await SB.handleEvent(card("evt_a2", "ann", 6000, now + 2000));
  assert.equal(await bal("ann"), 60000000 + 40000000 + 10000000);
  await SB.handleEvent(card("evt_a3", "ann", 1000, now + 3000));
  assert.equal(await bal("ann"), 110000000 + 5000000);
  // retries (Stripe resends the same event) change nothing - not the balance, not the cap usage
  for (const id of ["evt_a1", "evt_a2", "evt_a2"]) assert.equal((await SB.handleEvent(card(id, "ann", 6000, now + 2000))).outcome, "dup");
  // the credit function itself is idempotent per ref, even called again outside the webhook's dedupe
  const again = await DP.creditTerms({ ref: "don-evt_a2", userId: "u-ann", cents: 6000, paidAt: now + 2000, via: "card" });
  assert.deepEqual([again.promo_cents, again.normal_cents, again.pat], [4000, 2000, 50000000]);
  const c = await credits(p.id);
  assert.deepEqual(c.map((x) => [x.promo_cents, x.normal_cents]), [[6000, 0], [4000, 2000], [0, 1000]]);
  // the claim meta shows the split; the bonus is on the normal portion only; the history note says it
  const m = JSON.parse((await getQuery("SELECT meta FROM reserve_claims WHERE claimId = 'don-evt_a2'"))[0].meta);
  assert.deepEqual(m, { bonus: 2000000, usd_cents: 6000, rate: 500000, bonus_pct: 20, event: "evt_a2",
                        promo: { id: p.id, usd_cents: 4000, pat: 40000000, rate: 1000000 }, normal: { usd_cents: 2000, pat: 10000000 } });
  const note = (await getQuery("SELECT note FROM transactions WHERE transactionId = 'don-evt_a2'"))[0].note;
  assert.match(note, /Promo \(Today only.*\): 40,000,000 PAT for \$40\.00 at 1,000,000\/\$1 \+ 10,000,000 PAT for \$20\.00/);
  // another donor has their own $100
  await SB.handleEvent(card("evt_b1", "bob", 10000, now + 4000));
  assert.equal(await bal("bob"), 100000000);
  // what a signed-in donor sees before paying: the live promo + their allowance + a quote
  const L = await DP.live("u-ann");
  assert.equal(L.allowance_cents, 0); assert.equal(L.rate, 1000000);
  assert.equal((await DP.live("u-cat")).allowance_cents, 10000);
  const q = await DP.quote("u-cat", 150);
  assert.deepEqual([q.promo_cents, q.normal_cents, q.pat], [10000, 5000, 125000000]);
  const st = (await DP.adminState()).promos.find((x) => x.id === p.id);
  assert.equal(st.status, "live"); assert.equal(st.stats.donors, 2); assert.equal(st.stats.promo_cents, 20000); assert.equal(st.stats.promo_pat, 200000000);
  assert.equal(st.stats.extra_pat, 100000000);
  await DP.end(ADMIN, p.id);
  now = Math.ceil(now / 1000) * 1000 + 1000;   // Stripe times are whole seconds
});

test("window edges: paid at the start = promo, at the end = normal; the card session's CREATION time decides", async () => {
  const start = now + H, endT = now + 2 * H;
  const p = await DP.create(ADMIN, { mode: "mult", mult: 2, cap_usd: 100, starts: start, ends: endT });
  now = start - 1;
  await SB.handleEvent(card("evt_e0", "cat", 100, start - 1));   // session opened 1 ms before - normal
  now = endT + 10;
  await SB.handleEvent(card("evt_e1", "cat", 100, start));       // opened at the start, paid after the end - promo
  await SB.handleEvent(card("evt_e2", "cat", 100, endT - 1));    // last ms - promo
  await SB.handleEvent(card("evt_e3", "cat", 100, endT));        // at the end - normal
  assert.equal(await bal("cat"), 500000 + 1000000 + 1000000 + 500000);
  assert.deepEqual((await credits(p.id)).map((x) => x.ref), ["don-evt_e1", "don-evt_e2"]);
  now = Math.ceil(now / 1000) * 1000 + 1000;   // Stripe times are whole seconds
});

test("card and crypto credit the same: same amounts, split, bonus and claim meta promo/normal for the same donor state", async () => {
  const p = await DP.create(ADMIN, { mode: "rate", rate: 2000000, cap_usd: 50, starts: now, ends: now + H, bonus_base: "equivalent" });
  await SB.handleEvent(card("evt_c1", "dan", 8000, now + 10));
  const pid = await cryptoPay("eve", 8000, now + 10);
  assert.equal(await CP.settle(pid), "credited");
  assert.equal(await bal("dan"), await bal("eve"));
  assert.equal(await bal("dan"), 100000000 + 15000000);
  const metas = await getQuery("SELECT userId, amount, meta FROM reserve_claims WHERE userId IN ('u-dan','u-eve') ORDER BY userId");
  const [a, b] = metas.map((r) => ({ amount: r.amount, ...JSON.parse(r.meta) }));
  for (const k of ["amount", "bonus", "usd_cents", "rate", "bonus_pct", "promo", "normal"]) assert.deepEqual(a[k], b[k], k);
  assert.equal(a.bonus, 8000000, "equivalent: 20% of what $80 earns at the normal rate");
  // a crypto settle retried (a restart, a second pass) is a no-op
  assert.equal(await CP.settle(pid), "credited");
  assert.equal((await credits(p.id)).length, 2);
  assert.equal(await bal("eve"), 115000000);
  await DP.end(ADMIN, p.id);
  now = Math.ceil(now / 1000) * 1000 + 1000;   // Stripe times are whole seconds
});

test("the budget: promo PAT across all donors stop at the budget (a straddling donation splits), then the normal rate", async () => {
  const p = await DP.create(ADMIN, { mode: "rate", rate: 1000000, cap_usd: 100, budget: 70000000, starts: now, ends: now + H });
  await SB.handleEvent(card("evt_g1", "fay", 5000, now + 1));     // 50M of the 70M
  await SB.handleEvent(card("evt_g2", "gus", 5000, now + 2));     // 20M fit ($20), $30 normal
  assert.equal(await bal("fay"), 50000000);
  assert.equal(await bal("gus"), 20000000 + 15000000);
  await SB.handleEvent(card("evt_g3", "gus", 1000, now + 3));     // budget gone: normal
  assert.equal(await bal("gus"), 35000000 + 5000000);
  assert.equal((await DP.live("u-gus")).budget_left_pat, 0);
  // the budget can't be edited below what's used; the locked fields can't change after the start
  await assert.rejects(DP.edit(ADMIN, p.id, { budget: 1000 }), /can't go below/);
  await assert.rejects(DP.edit(ADMIN, p.id, { rate: 1500000 }), /has started/);
  await assert.rejects(DP.edit(ADMIN, p.id, { cap_usd: 500 }), /has started/);
  const e = await DP.edit(ADMIN, p.id, { budget: 90000000, label: "more room", ends: now + 2 * H });
  assert.equal(e.budget_pat, 90000000);
  await SB.handleEvent(card("evt_g4", "fay", 5000, now + 4));     // 20M more fit ($20 of fay's remaining $50)
  assert.equal(await bal("fay"), 50000000 + 20000000 + 15000000);
  // the credits already priced never change
  assert.deepEqual((await credits(p.id)).slice(0, 2).map((x) => x.promo_pat), [50000000, 20000000]);
  await DP.end(ADMIN, p.id);
  now = Math.ceil(now / 1000) * 1000 + 1000;   // Stripe times are whole seconds
});

test("an account-less donor is capped by a hashed donor key; no identity at all = the normal rate", async () => {
  const p = await DP.create(ADMIN, { mode: "rate", rate: 1000000, cap_usd: 10, starts: now, ends: now + H });
  const key = DP.donorKeyOf("email", "Someone@Example.com");
  assert.match(key, /^email:[0-9a-f]{32}$/); assert.ok(!key.includes("example"), "never the raw value");
  assert.equal(key, DP.donorKeyOf("email", " someone@example.com "));
  const run = (ref, cents, o) => tx(() => DP.creditTerms({ ref, cents, paidAt: now + 1, via: "card", ...o }));
  const a = await run("anon-1", 600, { donorKey: key });
  const b = await run("anon-2", 600, { donorKey: key });
  assert.deepEqual([a.promo_cents, b.promo_cents, b.normal_cents], [600, 400, 200]);
  const c = await run("anon-3", 600, {});
  assert.equal(c.promo, null); assert.equal(c.pat, 3000000);
  assert.equal((await credits(p.id)).length, 2, "a donor we can't identify leaves no usage row");
  await DP.end(ADMIN, p.id);
  now = Math.ceil(now / 1000) * 1000 + 1000;   // Stripe times are whole seconds
});

test("account merge: donation_promo_credits.user_id moves, so the merged account shares ONE per-donor cap", async () => {
  assert.ok(AM.classify("donation_promo_credits", "user_id").move, "classified as a move");
  for (const c of ["created_by", "updated_by", "ended_by"]) assert.ok(AM.classify("donation_promos", c).deny);
  const p = await DP.create(ADMIN, { mode: "rate", rate: 1000000, cap_usd: 100, starts: now, ends: now + H });
  await SB.handleEvent(card("evt_m1", "old", 7000, now + 1));
  await SB.handleEvent(card("evt_m2", "new", 7000, now + 2));
  await tx(() => AM.moveUserRows("u-old", "u-new", { fromUsername: "old", toUsername: "new" }));
  assert.equal((await DP.live("u-new")).used_cents, 14000);
  assert.equal((await DP.live("u-new")).allowance_cents, 0);
  const q = await DP.quote("u-new", 10);
  assert.equal(q.promo_cents, 0, "the merged account's cap is used up");
  await DP.end(ADMIN, p.id);
});

test("settings: ceiling within 1..50, bonus base + tz validated, audited", async () => {
  await assert.rejects(DP.setSettings(ADMIN, { ceiling_x: 51 }), /1 to 50/);
  await assert.rejects(DP.setSettings(ADMIN, { tz: "Mars/Olympus" }), /time zone/);
  const r = await DP.setSettings(ADMIN, { ceiling_x: 3, bonus_base: "all" });
  assert.deepEqual(Object.keys(r.changed).sort(), ["bonus_base", "ceiling_x"]);
  await assert.rejects(DP.create(ADMIN, { mode: "mult", mult: 4, cap_usd: 10, starts: now + H, ends: now + 2 * H }), /at most 3x/);
  await DP.setSettings(ADMIN, { ceiling_x: 10, bonus_base: "normal" });
  const a = await getQuery("SELECT detail FROM admin_audit WHERE action = 'donation_promo' AND detail LIKE '%settings%'");
  assert.equal(a.length, 2);
});
