// 1.99ans: THE HARD RULE "no PAT for dollars" (nopat.js; NY S5935-A, owner 2026-11-11: donations are "Perks only, no PAT").
//   * nopat.donorTerms is always 0 PAT / 0 bonus, whatever Pepe synced; donationpromo's credit / preview / quote agree
//   * ledger.post refuses ANY positive credit labelled as a dollar donation (type or source), whoever calls it
//   * no site code books a "mint:donation" claim or posts a donation credit any more (a source scan)
//   * card and crypto donations: recorded, perks, 0 PAT, 0 mint - even with a high synced rate
//   * the 💡 Supporter cosmetics a donation unlocks are bound: no listing, sale, trade or gift (indirect PAT for dollars)
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

test("the 💡 Supporter cosmetics a donation unlocks are bound: never listed, sold, traded or gifted (that would be PAT for dollars)", async () => {
  const COS = require(path.join(repo, "cosmetics"));
  const N = require(path.join(repo, "notices"));
  await COS.ready;
  assert.deepEqual([...COS.BOUND_IDS].sort(), ["ad_supporter", "nc_supporter"]);
  for (const it of COS.catalog()) {
    if (/^cf_donor/.test(String((it.unlock || {}).achievement || ""))) assert.ok(COS.isBound(it), it.id + " comes with a donation, so it's bound");
  }
  const plain = COS.catalog().find((i) => !COS.isBound(i) && i.kind === "name_color");
  assert.ok(plain && !COS.isBound(plain), "ordinary items are not bound");
  // a Supporter copy listed before 1.99ans comes off the market (and back to its owner, unlocked); safe on every boot
  const old = await COS.grant("u-ann", "nc_supporter", "achievement", "np-old");
  await runQuery("UPDATE user_cosmetics SET locked = 1 WHERE id = ?", [old.inv_id]);
  const ol = await runQuery("INSERT INTO cosmetic_listings (inv_id, seller_id, price, status, created, updated) VALUES (?, 'u-ann', 5000000, 'active', 1, 1)", [old.inv_id]);
  assert.equal(await COS.unlistBound(), 1);
  assert.equal(await COS.unlistBound(), 0, "a no-op the next boot");
  assert.equal((await getQuery("SELECT status FROM cosmetic_listings WHERE id = ?", [ol.id]))[0].status, "cancelled");
  assert.equal((await getQuery("SELECT locked, user_id FROM user_cosmetics WHERE id = ?", [old.inv_id]))[0].locked, 0);
  // Pepe's market sale of it (buylisting -> transfer with the listing) is refused even if a listing were active
  await runQuery("UPDATE cosmetic_listings SET status = 'active' WHERE id = ?", [ol.id]);
  const tr = await COS.transfer({ invId: old.inv_id, fromId: "u-ann", toId: "u-bob", idem: "np-sale", listingId: ol.id });
  assert.equal(tr.ok, false);
  assert.match(tr.error, /Supporter items can't be traded or gifted/);
  assert.equal((await getQuery("SELECT user_id FROM user_cosmetics WHERE id = ?", [old.inv_id]))[0].user_id, "u-ann");
  await COS.unlistBound();
  // the owner's own buttons (POST /cosmetics/list and /cosmetics/gift) refuse both items
  const express = require("express");
  const http = require("http");
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u } : null; next(); });
  COS.register(app, { isBotToken: () => false, addUser: (req, res, next) => next() });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, user, json) => new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(json));
    const r = http.request(base + url, { method: "POST", headers: { Origin: base, "x-test-user": user, "Content-Type": "application/json", "Content-Length": data.length } },
      (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode, location: res.headers.location })); });
    r.on("error", reject);
    r.end(data);
  });
  try {
    for (const id of ["nc_supporter", "ad_supporter"]) {
      const g = await COS.grant("u-ann", id, "achievement", "np-own-" + id);
      const l = await post("/cosmetics/list", "u-ann", { inv_id: g.inv_id, price: "50000", tab: "mine" });
      assert.equal(l.status, 302);
      assert.match(N.textOf(l.location, "u-ann"), /Supporter items can't be sold/, id);
      const gf = await post("/cosmetics/gift", "u-ann", { inv_id: g.inv_id, to: "bob", tab: "mine" });
      assert.equal(gf.status, 302);
      assert.match(N.textOf(gf.location, "u-ann"), /can't be traded or gifted/, id);
      assert.deepEqual(await getQuery("SELECT user_id, locked FROM user_cosmetics WHERE id = ?", [g.inv_id]), [{ user_id: "u-ann", locked: 0 }], id + " stays with the donor");
      assert.equal((await COS.inventory("u-ann")).items.find((i) => i.inv_id === g.inv_id).bound, true, "the page hides List / Gift");
    }
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM cosmetic_listings WHERE status = 'active'"))[0].n, 0, "nothing on the market");
    // an ordinary item still lists (the rule is only for the bound ones)
    const p = await COS.grant("u-ann", plain.id, "shop", "np-plain");
    const pl = await post("/cosmetics/list", "u-ann", { inv_id: p.inv_id, price: "50000", tab: "mine" });
    assert.match(N.textOf(pl.location, "u-ann"), /^Listed /);
  } finally {
    server.close();
  }
});

test("copy: no English string promises PAT for a donation; the retired PAT-per-dollar strings are gone from every catalog", () => {
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  const bad = /PAT per \$1|\$1 (=|adds)[^.]*PAT|mint that lands in a wallet|PAT (just landed|credited to your wallet)|added \{pat\} PAT|community pot gets|credit your stablecoin|won.t be credited|donation\(s\) credited/i;
  for (const [k, v] of Object.entries(en)) assert.doesNotMatch(typeof v === "string" ? v : JSON.stringify(v), bad, k);
  assert.match(en["economy.loop.s1_d"], /Donations never create PAT: they give supporter perks\.$/, "the public /economy page");
  const gone = ["support.rate", "support.hero_deal", "support.hero_deal_pot", "support.promo_deal", "support.promo_signin", "support.promo_left",
    "support.promo_used", "support.faq_promo_a", "support.sum", "support.tier_pat", "support.tier_bonus", "support.mini_pot", "support.where_pot",
    "support.where_pot_d", "support.faq_pot_q", "support.faq_pot_a", "support.thanks_credited", "donate.notice_body", "donate.notice_promo_split",
    "donate.notice_promo_all", "donate.promo_line", "economy.map.don", "banner.promo.support_promo.h", "banner.promo.support_promo.l",
    "js.support.sum", "js.support.credited"];
  for (const f of fs.readdirSync(path.join(repo, "locales")).filter((x) => x.endsWith(".json") && x !== "glossary.json" && !x.startsWith("."))) {
    const cat = JSON.parse(fs.readFileSync(path.join(repo, "locales", f), "utf8"));
    for (const k of gone) assert.equal(cat[k], undefined, `${f}: ${k}`);
    // rewritten: dropped from the machine catalogs until the i18n sync re-translates them from the new English
    if (f !== "en.json") for (const k of ["economy.loop.s1_d", "settings.connections.crypto_hint", "js.crypto.linked_claimed", "js.crypto.unlink_confirm"]) assert.equal(cat[k], undefined, `${f}: ${k}`);
  }
  for (const f of ["banner.js", path.join("views", "partials", "banner.ejs")]) assert.doesNotMatch(fs.readFileSync(path.join(repo, f), "utf8"), /support_promo/, f);
});
