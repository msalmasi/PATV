// 1.99ans: THE HARD RULE "no PAT for dollars" (nopat.js; NY S5935-A, owner 2026-11-11: donations are "Perks only, no PAT").
//   * nopat.donorTerms is always 0 PAT / 0 bonus, whatever Pepe synced; donationpromo's credit / preview / quote agree
//   * ledger.post refuses ANY positive credit labelled as a dollar donation (type or source), whoever calls it
//   * no site code books a "mint:donation" claim or posts a donation credit any more (a source scan)
//   * card and crypto donations: recorded, perks, 0 PAT, 0 mint - even with a high synced rate
//   NODE_PATH=G:/PATV/node_modules TZ=UTC node --test test/nopat.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "nopat-")));
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.STRIPE_ENABLED = "1";
process.env.STRIPE_SECRET_KEY = "sk_test_nopat";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_nopat";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const NP = require(path.join(repo, "nopat"));
const L = require(path.join(repo, "ledger"));
const F = require(path.join(repo, "funding"));
const DP = require(path.join(repo, "donationpromo"));
const SB = require(path.join(repo, "stripebilling"));
const CP = require(path.join(repo, "cryptopay"));

const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [u]))[0].b;

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, note TEXT)");
  for (const n of ["ann", "bob"]) await runQuery("INSERT INTO users (userId, username, password, points_balance) VALUES (?, ?, 'x', 100)", ["u-" + n, n]);
  await F.init();
  await SB.init();
  await CP.init();
  await CP.set({ max_usd: 1000, min_usd: 1 }, "test");
  await DP.init();
});

test("donorTerms: 0 PAT and 0 bonus for any amount; the rule is a constant, not a setting", () => {
  for (const c of [0, 1, 100, 99999, 100000000]) {
    const t = NP.donorTerms(c);
    assert.deepEqual([t.pat, t.bonus, t.rate, t.bonus_pct, t.promo, t.perks_only], [0, 0, 0, 0, null, true], String(c));
    assert.equal(t.usd_cents, c);
    assert.ok(Object.isFrozen(t));
  }
  assert.equal(NP.PAT_PER_USD, 0);
  assert.equal(NP.BONUS_PCT, 0);
  assert.equal(NP.assertNoPat(0), 0);
  assert.throws(() => NP.assertNoPat(1, "card donation"), (e) => e.code === "E_NO_PAT_FOR_DOLLARS" && /card donation/.test(e.message));
});

test("donationpromo's credit, preview and quote follow it - even when Pepe syncs a big rate", async () => {
  F.sync({ reserve: 1, monetary: { donation: { rate: 9000000, bonus_pct: 100 } } });
  assert.equal(F.donationTerms().rate, 9000000, "Pepe's setting is carried for the record...");
  const c = await DP.creditTerms({ ref: "don-1", userId: "u-ann", cents: 5000, paidAt: Date.now(), via: "card" });
  assert.deepEqual([c.pat, c.bonus], [0, 0], "...and never applied");
  const p = await DP.previewTerms({ userId: "u-ann", cents: 5000, paidAt: Date.now() });
  assert.deepEqual([p.pat, p.bonus], [0, 0]);
  const q = await DP.quote("u-ann", 50);
  assert.deepEqual([q.pat, q.bonus], [0, 0]);
  assert.deepEqual(CP.patFor(5000), { pat: 0, bonus: 0, rate: 0, bonus_pct: 0 });
  F.sync({ reserve: 1 });
});

test("ledger.post refuses any positive credit labelled as a dollar donation; other moves are untouched", async () => {
  const b0 = await bal("u-ann");
  for (const [type, opts] of [["donation", {}], ["donation-crypto", {}], ["anything", { source: "stripe donation" }], ["x", { source: "Crypto Donation" }]]) {
    const r = await L.post("u-ann", 1000, type, opts);
    assert.deepEqual([r.ok, r.code], [false, L.E_NO_PAT_FOR_DOLLARS], type);
    await assert.rejects(L.postOrThrow("u-ann", 1000, type, opts), /E_NO_PAT_FOR_DOLLARS/);
  }
  assert.equal(await bal("u-ann"), b0, "nothing moved");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM transactions WHERE userId = 'u-ann'"))[0].n, 0);
  assert.equal(NP.refusedCredit(-5, "donation"), false, "a debit is never a dollar credit");
  assert.equal((await L.post("u-ann", -10, "donation", {})).ok, true, "a debit labelled donation (e.g. a reversal) still works");
  assert.equal((await L.post("u-ann", 10, "tip from bob", { source: "tip" })).ok, true, "ordinary credits are untouched");
  assert.equal(await bal("u-ann"), b0);
});

test("the rails: a card and a crypto donation are recorded and give perks - no PAT, no mint claim", async () => {
  F.sync({ reserve: 1, monetary: { donation: { rate: 500000, bonus_pct: 20 } } });
  const ev = { id: "evt_np1", type: "checkout.session.completed", created: 1, data: { object: { id: "cs_np1", object: "checkout.session", mode: "payment",
    payment_status: "paid", amount_total: 2500, currency: "usd", client_reference_id: "u-bob", metadata: { kind: "donation", userId: "u-bob" } } } };
  assert.equal((await SB.handleEvent(ev)).outcome, "donation-perks");
  const addr = "0x" + "b0b".padEnd(40, "0");
  await runQuery("INSERT INTO crypto_wallets (user_id, family, address, created) VALUES ('u-bob', 'evm', ?, ?)", [addr, Date.now()]);
  const id = "eth:0x" + "1".padStart(64, "0") + ":1";
  await runQuery(`INSERT INTO crypto_payments (id, chain, token, token_addr, tx, idx, block, src_addr, dst_addr, raw_amount, usd_cents, status, seen)
                  VALUES (?, 'eth', 'USDC', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', ?, '1', 1, ?, '0xbd329b245135fcf5539f4d1ef40ba2d310e761a1', '25000000', 2500, 'final', ?)`,
    [id, "0x" + "1".padStart(64, "0"), addr, Date.now()]);
  assert.equal(await CP.settle(id), "credited");
  assert.equal(await bal("u-bob"), 100, "no PAT for dollars");
  assert.deepEqual(await getQuery("SELECT * FROM transactions WHERE userId = 'u-bob'"), []);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM reserve_claims WHERE flow = 'mint:donation'"))[0].n, 0, "nothing for Pepe or the Fed to mint");
  const log = await getQuery("SELECT via, usd_cents, pat, status FROM donation_usd_log WHERE user_id = 'u-bob' ORDER BY via");
  assert.deepEqual(log.map((r) => [r.via, r.usd_cents, r.pat, r.status]), [["card", 2500, 0, "credited"], ["crypto", 2500, 0, "credited"]]);
  const pay = (await getQuery("SELECT status, pat, bonus, claim_id FROM crypto_payments WHERE id = ?", [id]))[0];
  assert.deepEqual(pay, { status: "credited", pat: 0, bonus: 0, claim_id: null });
  assert.equal((await require(path.join(repo, "supporter")).refresh("u-bob")).tier, "silver", "$50 in total: the perks");
});

test("source scan: no site code books a donation mint claim or credits PAT for a donation any more", () => {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", "test", ".git", "public", "tools", "docs", "data", "locales", "views", "uploads"].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith(".js")) files.push(p);
    }
  };
  walk(repo);
  assert.ok(files.length > 100, "the site's modules");
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    assert.doesNotMatch(src, /INSERT INTO reserve_claims[^;]*'mint:donation'/, path.relative(repo, f) + " books a donation mint");
    assert.doesNotMatch(src, /\.post(?:OrThrow)?\([^)]*"donation(?:-crypto)?"/, path.relative(repo, f) + " posts a donation credit");
  }
  for (const f of ["stripebilling.js", "cryptopay.js"]) assert.match(fs.readFileSync(path.join(repo, f), "utf8"), /nopat"\)\.assertNoPat\(/, f + " asserts the rule");
});
