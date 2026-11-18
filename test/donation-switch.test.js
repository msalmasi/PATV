// 1.99aor: THE DONATIONS SWITCH (donationmode.js: on | perks | off). The owner, 2026-11-18: perks-only was temporary; bring PAT donations
// and promos back behind one owner switch, default perks, with a way to pause donations.
//   * the default and every unreadable state is "perks"; each state end to end on both rails (fake Stripe, recorded transfers)
//   * what a donor was quoted is what they get, whichever way the switch moved; no retroactive credit; no double credit
//   * refunds and disputes claw back (never below zero), a won dispute restores; supply stays conserved; the Fed journals the mints
//   * the daily caps and promo cap / budget, including open quotes
//   * owner + password step-up + audit on the switch; the ledger guard refuses everyone but the donation path
//   NODE_PATH=G:/PATV/node_modules node --test test/donation-switch.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "donswitch-"));
process.chdir(tmp);
delete process.env.STAGING;
Object.assign(process.env, { SECRET_KEY: "test-secret", STRIPE_ENABLED: "1", STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: "whsec_fake", DB_BACKUP_DIR: path.join(tmp, "bk") });
for (const k of ["CRYPTO_RPC_ETH", "CRYPTO_RPC_BASE", "CRYPTO_RPC_SOL"]) delete process.env[k];
const express = require("express");
const bcrypt = require("bcrypt");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const NP = require(path.join(repo, "nopat"));
const DM = require(path.join(repo, "donationmode"));
const L = require(path.join(repo, "ledger"));
const FU = require(path.join(repo, "funding"));
const DP = require(path.join(repo, "donationpromo"));
const SB = require(path.join(repo, "stripebilling"));
const CP = require(path.join(repo, "cryptopay"));
const P = require(path.join(repo, "pools"));
const ES = require(path.join(repo, "econstore"));
const FED = require(path.join(repo, "fed", "service"));
const SR = require(path.join(repo, "staffroles"));

const RATE = 500000, BONUS = 20, M = 1000000;
const POOLS = { reserve: 60 * M, bank: 3 * M, mm: 1 * M, fortknox: 5 * M, heist: 1 * M, incentives: 4 * M, vaultfloat: 0 };
let t = Date.UTC(2026, 10, 18, 15, 0);
const tick = (ms = 1000) => { t += ms; };
for (const m of [DP, SB, CP, DM]) m._setClock(() => t);
const USERS = {};
const OWNER = { userId: "u-boss", username: "boss" };
let base, server, stripeCalls = [], seq = 0;

const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", ["u-" + u]))[0].b;
const setBal = (u, n) => runQuery("UPDATE users SET points_balance = ? WHERE userId = ?", [n, "u-" + u]);
const wallets = async () => (await getQuery("SELECT COALESCE(SUM(points_balance),0) AS w FROM users"))[0].w;
const supply = async () => (await wallets()) + (await getQuery("SELECT COALESCE(SUM(balance),0) AS b FROM pools"))[0].b;
const claim = async (id) => (await getQuery("SELECT * FROM reserve_claims WHERE claimId = ?", [id]))[0] || null;
const setMode = (m) => DM.set(OWNER, m, "test");
async function raw(method, url, { user, body, headers = {} } = {}) {
  const h = { "content-type": "application/json", Origin: base, ...headers };
  if (user) h["x-test-user"] = user;
  const r = await fetch(base + url, { method, headers: h, body: body == null ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { json = null; }
  return { status: r.status, text, json };
}
/** A checkout through the real route; the fake Stripe hands back a session and we keep what it was asked for. */
async function checkout(user, usd) {
  const before = stripeCalls.length;
  const r = await raw("POST", "/api/premium/stripe/donate", { user, body: { usd, back: "/support" } });
  if (r.status !== 200) return { status: r.status, error: r.json && r.json.error, called: stripeCalls.length !== before };
  const f = stripeCalls[stripeCalls.length - 1];
  const meta = {};
  for (const [k, v] of f.entries()) { const m = /^metadata\[(\w+)\]$/.exec(k); if (m) meta[m[1]] = v; }
  return { status: 200, id: r.json.id, cents: usd * 100, user: "u-" + user, at: t, metadata: meta, form: f };
}
const paidEvent = (s, evId) => ({ id: evId || "evt_" + s.id, type: "checkout.session.completed", created: Math.floor(t / 1000), data: { object: { id: s.id, object: "checkout.session", mode: "payment",
  payment_status: "paid", amount_total: s.cents, currency: "usd", created: Math.floor(s.at / 1000), client_reference_id: s.user, payment_intent: "pi_" + s.id, metadata: s.metadata } } });
const pay = (s, evId) => SB.handleEvent(paidEvent(s, evId));
const refundEvent = (s, cents, id, md = {}) => ({ id, type: "charge.refunded", created: 1, data: { object: { id: "ch_" + s.id, object: "charge", payment_intent: "pi_" + s.id, amount: s.cents, amount_refunded: cents, metadata: md } } });
const disputeEvent = (s, cents, id, type = "charge.dispute.created", status = "needs_response") => ({ id, type, created: 1, data: { object: { id: "dp_" + s.id, object: "dispute", payment_intent: "pi_" + s.id, charge: "ch_" + s.id, amount: cents, status } } });

const ADDR = { alice: "0x" + "a1".repeat(20), bob: "0x" + "b2".repeat(20), carol: "0x" + "c3".repeat(20), unlinked: "0x" + "d4".repeat(20) };
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", RECV = "0x" + "ab".repeat(20);
const transfer = (from, cents) => { const h = (++seq).toString(16).padStart(64, "0"); return { id: `eth:0x${h}:1`, chain: "eth", token: "USDC", token_addr: USDC, tx: "0x" + h, idx: "1", block: 1, src_addr: from, dst_addr: RECV, raw_amount: String(cents * 10000), usd_cents: cents }; };
const cid = (x) => CP.claimIdOf(x.id);
const row = async (x) => (await getQuery("SELECT status, pat, bonus, claim_id, user_id, terms FROM crypto_payments WHERE id = ?", [x.id]))[0];
const inbox = async (u) => (await getQuery("SELECT title, body, link FROM inbox WHERE user_id = ? ORDER BY rowid DESC", ["u-" + u]).catch(() => []));

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0,
                  camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, level INTEGER DEFAULT 0, avatar TEXT, created_at TEXT, casino_banned INTEGER DEFAULT 0, archived_at INTEGER, email TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT, note TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE supply_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), pools TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("INSERT INTO supply_snapshot (id, pools) VALUES (1, '[]')");
  const pw = await bcrypt.hash("pw-right", 4);
  for (const [n, cls, cf] of [["alice", "pleb", null], ["bob", "pleb", null], ["carol", "pleb", null], ["dave", "pleb", null], ["erin", "pleb", null], ["boss", "Admin", "boss_cf"], ["adm", "Admin", "adm_cf"], ["staff", "Staff", null]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername, points_balance) VALUES (?, ?, ?, ?, ?, ?, 1000)", ["u-" + n, n, n, pw, cls, cf]);
    USERS[n] = { userId: "u-" + n, username: n, class: cls, camfrogUsername: cf };
  }
  await SR.init();
  await runQuery("INSERT INTO pepe_roles (login, role, ts) VALUES ('boss_cf', 'owner', 1), ('adm_cf', 'admin', 1)");
  await require(path.join(repo, "pepecontrol")).init();
  await require(path.join(repo, "adminaudit")).init();
  await P.init(); await FU.init();
  await P._setMeta("enabled", true);
  const payload = JSON.stringify({ v: 1, source: "pepe", pools: POOLS, docs: {}, routes: {}, econ_cfg: {}, econ_cfg_log: [], catalog: {} });
  assert.equal((await P.importFromPepe({ key: "pc-donswitch", payload, digest: sha(payload), totals: { sum: Object.values(POOLS).reduce((a, b) => a + b, 0), count: Object.keys(POOLS).length, per_pool: POOLS } })).ok, true);
  await ES.putDocs({ econ_layers: { rev: 1, doc: {} } });
  await FED.init();
  await FED.setMeta("live", true);
  FED.forgetLive();
  FU.sync({ reserve: 1, monetary: { donation: { rate: RATE, bonus_pct: BONUS } } });
  await SB.init(); await CP.init(); await DP.init();
  await CP.set({ crypto_donations_enabled: true, chain_eth: true, addr_eth: RECV, verify_payments: false, min_usd: 1, max_usd: 1000 }, "test");
  for (const n of ["alice", "bob", "carol"]) await runQuery("INSERT INTO crypto_wallets (user_id, family, address, created) VALUES (?, 'evm', ?, ?)", ["u-" + n, ADDR[n], t]);
  SB._setFetch(async (url, opts) => { const f = new URLSearchParams(opts.body); stripeCalls.push(f); const id = "cs_" + (++seq); return { ok: true, json: async () => ({ id, url: "https://checkout.stripe.test/" + id }) }; });
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  app.use(express.json());
  const addUser = (q, s, n) => { const u = q.get("x-test-user"); q.user = u ? USERS[u] || null : null; n(); };
  require(path.join(repo, "terms")).register(app, { addUser });
  require(path.join(repo, "cryptoweb")).register(app, { addUser, noTimers: true });
  DP.register(app, { addUser, noTimers: true });
  SB.register(app, { addUser });
  app.post("/api/admin/stepup/nonce", addUser, (q, s) => require(path.join(repo, "stepup")).nonceRoute(q, s));
  require(path.join(repo, "adminweb")).register(app, { addUser });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { CP.stop(); server && server.close(); SB._setFetch(null); });

// ── the default ──
test("no row is perks; an unreadable or unknown value is perks; a broken read is perks", async () => {
  assert.equal((await DM.get()).mode, "perks");
  assert.equal(DM.cachedMode(), "perks");
  assert.deepEqual(DM.MODES, ["on", "perks", "off"]);
  for (const bad of ["{not json", '"maybe"', '{"mode":"sure"}', "12", "null"]) {
    await runQuery("INSERT OR REPLACE INTO donation_promo_settings (key, value, updated, actor) VALUES ('donations_mode', ?, 1, 'x')", [bad]);
    const s = await DM.get();
    assert.deepEqual([s.mode, s.readable], ["perks", false], bad);
    assert.deepEqual([(await DP.quote("u-alice", 10)).pat, await DP.live("u-alice")], [0, null], "and everything downstream reads perks: " + bad);
  }
  await runQuery("DELETE FROM donation_promo_settings WHERE key = 'donations_mode'");
  assert.equal((await DM.get()).readable, true);
  // a failed read: the table gone
  await runQuery("ALTER TABLE donation_promo_settings RENAME TO dps_hidden");
  assert.equal((await DM.get()).mode, "perks");
  await runQuery("ALTER TABLE dps_hidden RENAME TO donation_promo_settings");
});

test("perks (the deploy state): a checkout and a webhook are exactly as before: no quote, no PAT, no claim, no promo", async () => {
  const s = await checkout("alice", 25);
  assert.deepEqual(s.metadata, { kind: "donation", userId: "u-alice" }, "the session's metadata is the old one");
  assert.equal(s.form.get("expires_at"), null);
  assert.equal([...s.form.keys()].some((k) => k.startsWith("payment_intent_data")), false);
  assert.equal((await pay(s)).outcome, "donation-perks");
  assert.equal(await bal("alice"), 1000);
  assert.equal(await claim("don-evt_" + s.id), null);
  assert.deepEqual((await getQuery("SELECT pat, status FROM donation_usd_log WHERE ref = ?", ["don-evt_" + s.id]))[0], { pat: 0, status: "credited" });
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM donation_quotes"))[0].n, 0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM donation_credits"))[0].n, 0);
  assert.match((await inbox("alice"))[0].body, /Donations never add PAT/);
  await assert.rejects(DP.create(OWNER, { mode: "rate", rate: RATE * 2, cap_usd: 10, today: true }), (e) => e.status === 410);
  const x = transfer(ADDR.alice, 1000);
  assert.equal(await CP.record(x, true), "credited");
  assert.deepEqual(await row(x), { status: "credited", pat: 0, bonus: 0, claim_id: null, user_id: "u-alice", terms: null });
  assert.equal(await bal("alice"), 1000);
});

// ── on ──
test("on, card: the quoted PAT lands, the claim is booked, the Fed journals both mints, the supply grows by exactly that", async () => {
  await setMode("on");
  const s0 = await supply(), inc0 = await P.balance("incentives");
  const s = await checkout("bob", 10);
  assert.ok(/^dq_/.test(s.metadata.quote), "a quote travels with the session");
  assert.ok(Number(s.form.get("expires_at")) > 0, "a quoted session is short-lived");
  assert.equal(s.form.get("payment_intent_data[metadata][quote]"), s.metadata.quote);
  assert.equal(await bal("bob"), 1000, "nothing before the payment");
  const r = await pay(s);
  assert.equal(r.outcome, "donation-credited");
  const pat = 10 * RATE, bonus = pat * BONUS / 100, ref = "don-evt_" + s.id;
  assert.equal(await bal("bob"), 1000 + pat);
  const tx = (await getQuery("SELECT type, points FROM transactions WHERE transactionId = ?", [ref]))[0];
  assert.deepEqual(tx, { type: "donation", points: pat });
  const c = await claim(ref), m = JSON.parse(c.meta);
  assert.deepEqual([c.flow, c.amount, c.settled, m.bonus, m.usd_cents, m.rate, m.bonus_pct, m.event], ["mint:donation", pat, 0, bonus, 1000, RATE, BONUS, "evt_" + s.id]);
  assert.equal((await getQuery("SELECT pat FROM donation_usd_log WHERE ref = ?", [ref]))[0].pat, pat + bonus, "the global cap counts what it mints");
  assert.equal(await supply(), s0 + pat, "the wallet holds it at once");
  assert.ok(!(await FU.claims()).some((x) => x.claimId === ref), "the Fed is live: not Pepe's to settle");
  assert.equal(await FED.donationSweep(), 1);
  assert.equal((await claim(ref)).settled, 1);
  assert.equal(await P.balance("incentives"), inc0 + bonus);
  assert.equal(await supply(), s0 + pat + bonus);
  const st = await FED.botState();
  assert.deepEqual([st.doc.fed_mints[ref + "-w"].amount, st.doc.fed_mints[ref + "-w"].dest, st.doc.fed_mints[ref + "-b"].amount, st.doc.fed_mints[ref + "-b"].dest], [pat, "site", bonus, "incentives"]);
  assert.equal(st.mtd.donation, pat + bonus, "journaled under donation");
  const CF = await FED.cfgNow();
  assert.equal(await FED.capRoom("donation", CF), null, "no monthly cap applies to donation mints");
  const n = (await inbox("bob"))[0];
  assert.match(n.body, /\$10\.00 donation added 5,000,000 PAT/);
  assert.equal(n.link, "/wallet");
});

test("idempotent: a replayed event changes nothing; the same checkout under a new event id is not paid twice", async () => {
  const s = await checkout("carol", 2), before = await bal("carol");
  assert.equal((await pay(s, "evt_rep1")).outcome, "donation-credited");
  const b1 = await bal("carol");
  assert.equal(b1, before + 2 * RATE);
  assert.equal((await pay(s, "evt_rep1")).dup, true);
  assert.equal((await pay(s, "evt_rep2")).outcome, "donation-dup");
  assert.equal(await bal("carol"), b1);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM reserve_claims WHERE userId = 'u-carol' AND flow = 'mint:donation'"))[0].n, 1);
});

test("on, crypto: a transfer from a linked wallet credits at the rate, once, with its claim", async () => {
  const b0 = await bal("alice"), x = transfer(ADDR.alice, 300);
  assert.equal(await CP.record(x, true), "credited");
  const pat = 3 * RATE, bonus = pat * BONUS / 100, r = await row(x);
  assert.deepEqual([r.status, r.pat, r.bonus, r.claim_id], ["credited", pat, bonus, cid(x)]);
  assert.equal(await bal("alice"), b0 + pat);
  assert.equal((await getQuery("SELECT type FROM transactions WHERE transactionId = ?", [cid(x)]))[0].type, "donation-crypto");
  assert.deepEqual(JSON.parse((await claim(cid(x))).meta).via, "crypto");
  assert.equal(await CP.settle(x.id), "credited", "settling again changes nothing");
  assert.equal(await CP.record(x, true), "credited");
  assert.equal(await bal("alice"), b0 + pat);
  assert.match((await inbox("alice"))[0].body, /1,500,000 PAT added/);
  await FED.donationSweep();
  assert.equal((await claim(cid(x))).settled, 1);
});

// ── off ──
test("off: no new checkout and no address; what lands is recorded with perks only; what was open is honoured", async () => {
  const open = await checkout("dave", 4);            // opened while on
  await setMode("off");
  const n = stripeCalls.length, r = await checkout("dave", 5);
  assert.equal(r.status, 409);
  assert.match(r.error, /paused/i);
  assert.equal(stripeCalls.length, n, "Stripe is never called");
  const pg = await raw("GET", "/support", { user: "alice" });
  assert.equal(pg.status, 200);
  assert.match(pg.text, /Donations are paused/);
  assert.doesNotMatch(pg.text, /id="give"|id="pane-crypto"|id="donateGo"|class="addr"/);
  assert.ok(!pg.text.includes(RECV) && !pg.text.toLowerCase().includes(RECV.slice(2, 12)), "no receiving address anywhere on the page");
  assert.match(pg.text, /id="payBox"/, "the member's own donations stay visible");
  assert.equal((await raw("GET", "/api/donate/promo")).json.paused, true);
  const card = SB.donateLocals("/wallet", null);
  assert.equal(card.paused, true);
  const html = await require("ejs").renderFile(path.join(repo, "views/partials/donate-card.ejs"), { donate: card });
  assert.match(html, /Donations are paused/);
  assert.doesNotMatch(html, /donateGo/);
  // the transfer that arrives anyway: recorded, perks
  const b0 = await bal("alice"), x = transfer(ADDR.alice, 700);
  assert.equal(await CP.record(x, true), "credited");
  assert.deepEqual([(await row(x)).pat, (await row(x)).claim_id, await bal("alice")], [0, null, b0]);
  // the checkout that was already open is honoured on its quote
  const d0 = await bal("dave");
  assert.equal((await pay(open)).outcome, "donation-credited");
  assert.equal(await bal("dave"), d0 + 4 * RATE);
  await assert.rejects(DP.create(OWNER, { mode: "rate", rate: RATE * 2, cap_usd: 10, today: true }), (e) => e.status === 409);
});

// ── quote vs settlement ──
test("a switch change between quote and settlement, both directions, both rails", async () => {
  // card: quoted on -> perks by the time it's paid
  await setMode("on");
  const a = await checkout("erin", 3);
  await setMode("perks");
  let e0 = await bal("erin");
  assert.equal((await pay(a)).outcome, "donation-credited");
  assert.equal(await bal("erin"), e0 + 3 * RATE, "shown PAT, gets PAT");
  // card: opened in perks -> on by the time it's paid
  const b = await checkout("erin", 3);
  assert.equal(b.metadata.quote, undefined);
  await setMode("on");
  e0 = await bal("erin");
  assert.equal((await pay(b)).outcome, "donation-perks");
  assert.equal(await bal("erin"), e0, "shown perks, gets perks");
  // the rate moves after the quote: the quoted rate holds
  const c = await checkout("erin", 1);
  FU.sync({ reserve: 1, monetary: { donation: { rate: RATE * 3, bonus_pct: 50 } } });
  e0 = await bal("erin");
  await pay(c);
  assert.equal(await bal("erin"), e0 + RATE);
  assert.equal(JSON.parse((await claim("don-evt_" + c.id)).meta).bonus, RATE * BONUS / 100);
  FU.sync({ reserve: 1, monetary: { donation: { rate: RATE, bonus_pct: BONUS } } });

  // crypto: /support showed PAT, the switch goes to perks, then the transfer is seen: the quote holds
  await setMode("on");
  assert.equal((await raw("GET", "/support", { user: "bob" })).status, 200);
  await setMode("perks");
  tick();
  let b0 = await bal("bob"), x = transfer(ADDR.bob, 200);
  assert.equal(await CP.record(x, true), "credited");
  assert.equal((await row(x)).pat, 2 * RATE);
  assert.equal(await bal("bob"), b0 + 2 * RATE);
  // ...and it goes the other way: /support showed perks, the switch goes on, the transfer gets perks
  tick(); assert.equal((await raw("GET", "/support", { user: "carol" })).status, 200);
  await setMode("on");
  tick();
  b0 = await bal("carol"); x = transfer(ADDR.carol, 200);
  assert.equal(await CP.record(x, true), "credited");
  assert.deepEqual([(await row(x)).pat, await bal("carol")], [0, b0]);
  // a newer look at the page replaces the older quote
  tick(); await raw("GET", "/support", { user: "carol" });
  tick(); b0 = await bal("carol"); x = transfer(ADDR.carol, 200);
  await CP.record(x, true);
  assert.equal(await bal("carol"), b0 + 2 * RATE);
  // the quote lapses after two hours: then the state when the transfer was seen decides
  await setMode("perks");
  tick(2 * 3600000 + 1000);
  b0 = await bal("carol"); x = transfer(ADDR.carol, 200);
  await CP.record(x, true);
  assert.equal(await bal("carol"), b0);
});

test("a transfer seen while on and claimed much later keeps its PAT terms; one seen in perks never gains them", async () => {
  await setMode("on");
  const seenOn = transfer(ADDR.unlinked, 100);
  assert.equal(await CP.record(seenOn, true), "unclaimed");
  assert.ok((await row(seenOn)).terms, "the terms are stored with the row");
  await setMode("perks");
  const seenPerks = transfer(ADDR.unlinked, 100);
  assert.equal(await CP.record(seenPerks, true), "unclaimed");
  assert.equal((await row(seenPerks)).terms, null);
  await setMode("off");
  await runQuery("INSERT INTO crypto_wallets (user_id, family, address, created) VALUES ('u-dave', 'evm', ?, ?)", [ADDR.unlinked, t]);
  await setMode("on");
  const d0 = await bal("dave");
  const got = await CP.claimUnclaimed("evm", ADDR.unlinked);
  assert.deepEqual(got.map((g) => g.status), ["credited", "credited"]);
  assert.equal((await row(seenOn)).pat, RATE);
  assert.equal((await row(seenPerks)).pat, 0);
  assert.equal(await bal("dave"), d0 + RATE);
});

test("no retroactive credit: turning it on pays nothing for perks-only donations, old or held", async () => {
  await setMode("perks");
  const s = await checkout("alice", 9);
  await pay(s);
  const heldTx = transfer(ADDR.alice, 150000);        // over max_usd: held for an admin
  assert.equal(await CP.record(heldTx, true), "held");
  const legacy = transfer(ADDR.alice, 500);           // a row from before this release: no terms
  await runQuery(`INSERT INTO crypto_payments (id, chain, token, token_addr, tx, idx, block, src_addr, dst_addr, raw_amount, usd_cents, status, seen) VALUES (?, 'eth', 'USDC', ?, ?, '1', 1, ?, ?, ?, 500, 'unclaimed', ?)`,
                 [legacy.id, USDC, legacy.tx, ADDR.alice, RECV, legacy.raw_amount, t - 86400000]);
  await FED.donationSweep();                          // whatever earlier tests left to journal
  await setMode("on");
  const a0 = await bal("alice"), s0 = await supply(), c0 = (await getQuery("SELECT COUNT(*) AS n FROM reserve_claims WHERE flow = 'mint:donation'"))[0].n;
  assert.equal(await FED.donationSweep(), 0);
  assert.equal(await bal("alice"), a0);
  assert.equal(await CP.settle(legacy.id), "credited");
  assert.equal((await CP.decide(heldTx.id, "approve", "boss", "ok")).status, "credited");
  assert.deepEqual([(await row(legacy)).pat, (await row(heldTx)).pat], [0, 0]);
  assert.deepEqual([await bal("alice"), await supply()], [a0, s0]);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM reserve_claims WHERE flow = 'mint:donation'"))[0].n, c0);
});

// ── refunds and disputes ──
test("a refund claws back pro rata, cumulatively and once; the PAT goes to the Fed, the bonus from incentives; the supply is conserved", async () => {
  await setMode("on");
  const s = await checkout("dave", 10);
  await pay(s); await FED.donationSweep();
  const ref = "don-evt_" + s.id, pat = 10 * RATE, bonus = pat * BONUS / 100;
  const DON = require(path.join(repo, "donations"));
  const counted0 = (await DON.totalsFor("u-dave")).cents;
  const d0 = await bal("dave"), f0 = await P.balance("reserve"), i0 = await P.balance("incentives"), s0 = await supply();
  await setMode("perks");                             // the switch has no say over a refund
  assert.equal((await SB.handleEvent(refundEvent(s, 400, "evt_ref1"))).outcome, "donation-refund");
  assert.equal(await bal("dave"), d0 - pat * 0.4);
  assert.equal(await P.balance("reserve"), f0 + pat * 0.4 + bonus * 0.4);
  assert.equal(await P.balance("incentives"), i0 - bonus * 0.4);
  assert.equal(await supply(), s0, "moved, not destroyed");
  assert.equal((await SB.handleEvent(refundEvent(s, 400, "evt_ref1"))).dup, true);
  await SB.handleEvent(refundEvent(s, 400, "evt_ref1b"));       // the same total under another id moves nothing
  assert.equal(await bal("dave"), d0 - pat * 0.4);
  await SB.handleEvent(refundEvent(s, 1000, "evt_ref2"));
  assert.equal(await bal("dave"), d0 - pat);
  assert.equal(await P.balance("reserve"), f0 + pat + bonus);
  assert.equal(await P.balance("incentives"), i0 - bonus);
  assert.deepEqual(await getQuery("SELECT refunded_cents, clawed_pat, clawed_bonus, short_pat FROM donation_credits WHERE ref = ?", [ref]), [{ refunded_cents: 1000, clawed_pat: pat, clawed_bonus: bonus, short_pat: 0 }]);
  assert.equal(await supply(), s0);
  assert.match((await inbox("dave"))[0].body, /refunded/);
  const FS = (await FED.botState()).doc.fed_mints;
  assert.equal(FS[ref + "-w"].amount, pat, "the mint stays on the record");
  // the dollars no longer count toward the Supporter total
  assert.equal((await getQuery(`SELECT COUNT(*) AS n FROM ${DON.SQL} d WHERE d.ref = ?`, [ref]))[0].n, 0);
  assert.equal((await DON.totalsFor("u-dave")).cents, counted0 - 1000, "the Supporter total follows");
});

test("a member who only ever gave a refunded donation is no longer a Supporter; viewing /support writes one quote, not one per view", async () => {
  await setMode("on");
  const SUP = require(path.join(repo, "supporter"));
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance) VALUES ('u-fay', 'fay', 'fay', 'x', 'pleb', 0)");
  USERS.fay = { userId: "u-fay", username: "fay", class: "pleb" };
  const s = await checkout("fay", 1);
  await pay(s);
  await SUP.refresh("u-fay");
  assert.ok(SUP.supporterSync("u-fay"));
  await SB.handleEvent(refundEvent(s, 100, "evt_fay"));
  await SUP.refresh("u-fay");
  assert.equal(SUP.supporterSync("u-fay"), null);
  const n = async () => (await getQuery("SELECT COUNT(*) AS n FROM donation_quotes WHERE user_id = 'u-bob' AND via = 'crypto'"))[0].n;
  await raw("GET", "/support", { user: "bob" });
  const n0 = await n();
  for (let i = 0; i < 3; i++) { tick(); await raw("GET", "/support", { user: "bob" }); }
  assert.equal(await n(), n0);
});

test("a wallet never goes negative: what's spent is recorded as not recovered; a claim not yet swept is journaled first", async () => {
  await setMode("on");
  const s = await checkout("erin", 4);
  await pay(s);
  const ref = "don-evt_" + s.id, pat = 4 * RATE;
  await setBal("erin", 500000);
  assert.equal((await claim(ref)).settled, 0);
  await SB.handleEvent(refundEvent(s, 400, "evt_short"));
  assert.equal(await bal("erin"), 0);
  assert.equal((await claim(ref)).settled, 1, "settled inside the reversal");
  assert.deepEqual((await getQuery("SELECT clawed_pat, short_pat FROM donation_credits WHERE ref = ?", [ref]))[0], { clawed_pat: 500000, short_pat: pat - 500000 });
  assert.equal((await DP.modeState()).credits.short >= pat - 500000, true);
});

test("a dispute takes the PAT while open; won gives it back, lost keeps it; a perks donation has nothing to take", async () => {
  await setMode("on");
  const s = await checkout("bob", 5), w = await checkout("bob", 6);
  await pay(s); await pay(w); await FED.donationSweep();
  const b0 = await bal("bob"), f0 = await P.balance("reserve"), i0 = await P.balance("incentives"), s0 = await supply();
  assert.equal((await SB.handleEvent(disputeEvent(w, 600, "evt_d1"))).outcome, "donation-dispute");
  assert.equal(await bal("bob"), b0 - 6 * RATE);
  assert.equal((await SB.handleEvent(disputeEvent(w, 600, "evt_d2", "charge.dispute.closed", "won"))).outcome, "donation-dispute-won");
  assert.equal(await bal("bob"), b0, "back in the wallet");
  assert.deepEqual([await P.balance("reserve"), await P.balance("incentives"), await supply()], [f0, i0, s0]);
  assert.match((await inbox("bob"))[0].body, /closed in your favour/);
  assert.equal((await getQuery("SELECT type FROM transactions WHERE transactionId LIKE ?", ["%evt_d2"]))[0].type, "donation-restored");
  await SB.handleEvent(disputeEvent(s, 500, "evt_d3"));
  assert.equal((await SB.handleEvent(disputeEvent(s, 500, "evt_d4", "charge.dispute.closed", "lost"))).outcome, "donation-dispute-lost");
  assert.equal(await bal("bob"), b0 - 5 * RATE, "lost: it stays taken");
  // perks donation: the same events are ignored, as today
  await setMode("perks");
  const p = await checkout("bob", 5);
  await pay(p);
  const b1 = await bal("bob");
  assert.equal((await SB.handleEvent(refundEvent(p, 500, "evt_pref"))).outcome, "ignored");
  assert.equal((await SB.handleEvent(disputeEvent(p, 500, "evt_pdisp"))).outcome, "ignored");
  assert.equal(await bal("bob"), b1);
});

test("a refund that reaches us before the payment is retried, not lost", async () => {
  await setMode("on");
  const s = await checkout("carol", 2);
  const ev = refundEvent(s, 200, "evt_early", { kind: "donation", quote: s.metadata.quote });
  await assert.rejects(SB.handleEvent(ev), (e) => e.status === 409);
  assert.equal((await getQuery("SELECT 1 FROM stripe_events WHERE id = 'evt_early'")).length, 0, "not marked as seen");
  const c0 = await bal("carol");
  await pay(s);
  assert.equal((await SB.handleEvent(ev)).outcome, "donation-refund");
  assert.equal(await bal("carol"), c0);
});

// ── caps + promos ──
test("the per-member and global daily caps apply to PAT donations and count what they mint", async () => {
  await setMode("on");
  t += 86400000;                                        // a fresh economy day
  await DP.setSettings(OWNER, { daily_limit_usd: 20 });
  const a = await checkout("erin", 15);
  assert.equal(a.status, 200);
  assert.equal((await checkout("erin", 10)).status, 409, "the open checkout counts toward today's limit");
  await pay(a);
  await DP.setSettings(OWNER, { daily_limit_usd: 0, global_mode: "fixed", global_pat: (15 * RATE * 1.2) + (2 * RATE * 1.2) });
  const b = await checkout("erin", 2);
  assert.equal(b.status, 200);
  const c = await checkout("erin", 1);
  assert.equal(c.status, 409, "the day's minted PAT is the cap");
  assert.match(c.error, /full for today/);
  await pay(b);
  const G = await DP.globalAdmin();
  assert.equal(G.used_pat, 17 * RATE * 1.2);
  // crypto over the global cap is held, then an admin's approval credits it at its quoted terms
  const e0 = await bal("alice"), x = transfer(ADDR.alice, 100);
  assert.equal(await CP.record(x, true), "held");
  assert.equal(await bal("alice"), e0);
  assert.equal((await CP.decide(x.id, "approve", "boss")).status, "credited");
  assert.equal(await bal("alice"), e0 + RATE);
  await DP.setSettings(OWNER, { global_mode: "off", global_pat: 0 });
});

test("promos: created only in on; they apply to the quote; the cap and budget hold across open checkouts; a quote keeps its split", async () => {
  await setMode("perks");
  assert.equal(await DP.live("u-dave"), null);
  await setMode("on");
  const p = await DP.create(OWNER, { label: "Double", mode: "mult", mult: 2, cap_usd: 10, budget: 25 * RATE, confirm_budget: true, today: true });
  const pub = await DP.live("u-dave");
  assert.deepEqual([pub.id, pub.rate, pub.allowance_cents], [p.id, RATE * 2, 1000]);
  assert.equal(DP.liveCached().id, p.id);
  // $6 now, $8 next: $4 of it fits the $10 cap while the first checkout is still open
  const a = await checkout("dave", 6), b = await checkout("dave", 8);
  assert.equal(a.metadata.promo, p.id);
  const qb = await getQuery("SELECT promo_cents, promo_pat FROM donation_quotes WHERE id = ?", [b.metadata.quote]);
  assert.deepEqual(qb[0], { promo_cents: 400, promo_pat: 4 * RATE * 2 });
  assert.equal((await DP.live("u-dave")).allowance_cents, 0);
  const d0 = await bal("dave");
  await pay(b); await pay(a);
  assert.equal(await bal("dave"), d0 + (4 * 2 + 4) * RATE + 6 * 2 * RATE, "each gets exactly its quote");
  const cr = await getQuery("SELECT promo_cents, promo_pat, normal_cents FROM donation_promo_credits WHERE promo_id = ? ORDER BY paid_at", [p.id]);
  assert.equal(cr.reduce((n, r) => n + r.promo_cents, 0), 1000, "the cap is never exceeded");
  const r2 = (await inbox("dave"))[0];
  assert.match(r2.body, /promo rate/);
  // the budget: 25 x RATE at the promo rate = $12.50 of promo dollars; $10 are used, so $2.50 are left for everyone
  const e = await checkout("erin", 5);
  assert.equal((await getQuery("SELECT promo_cents FROM donation_quotes WHERE id = ?", [e.metadata.quote]))[0].promo_cents, 250);
  // the promo ends before this one is paid: the quote still holds
  await DP.end(OWNER, p.id);
  const e0 = await bal("erin");
  await pay(e);
  assert.equal(await bal("erin"), e0 + Math.floor(250 * RATE * 2 / 100) + Math.floor(250 * RATE / 100));
  assert.equal(await DP.live("u-erin"), null);
  // promo credits are refunded like any other
  const f0 = await bal("erin");
  await SB.handleEvent(refundEvent(e, 500, "evt_prefund"));
  assert.equal(await bal("erin"), f0 - (Math.floor(250 * RATE * 2 / 100) + Math.floor(250 * RATE / 100)));
});

// ── who may change it ──
const FETCH = { "X-Requested-With": "fetch" };
const nonce = async (user) => (await raw("POST", "/api/admin/stepup/nonce", { user, body: { for: "donations_mode" }, headers: FETCH }));
const flip = (user, body, headers = FETCH) => raw("POST", "/api/admin/donations/mode", { user, body, headers });

test("the switch: a Pepe owner with the password, audited; nobody else gets through", async () => {
  await setMode("perks");
  const n0 = (await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'donation_mode'"))[0].n;
  // no account (a bot token is not an account); a member; staff; an Admin who isn't a Pepe owner
  assert.equal((await flip(null, { mode: "on", password: "bot-token" })).status, 401);
  for (const u of ["alice", "staff", "adm"]) {
    const r = await flip(u, { mode: "on", password: "pw-right", nonce: "x" });
    assert.equal(r.status, 403, u);
    assert.equal((await nonce(u)).status, 403, u + " gets no nonce");
  }
  // the owner: same-origin fetch only, a nonce, the right password
  assert.equal((await flip("boss", { mode: "on", password: "pw-right", nonce: (await nonce("boss")).json.nonce }, {})).status, 403, "no X-Requested-With");
  assert.equal((await raw("POST", "/api/admin/donations/mode", { user: "boss", body: { mode: "on", password: "pw-right", nonce: (await nonce("boss")).json.nonce }, headers: { ...FETCH, Origin: "https://evil.example" } })).status, 403);
  assert.equal((await flip("boss", { mode: "on", password: "pw-right", nonce: "nope" })).status, 409);
  assert.equal((await flip("boss", { mode: "on", password: "wrong", nonce: (await nonce("boss")).json.nonce })).status, 403);
  assert.equal((await flip("boss", { mode: "sideways", password: "pw-right", nonce: (await nonce("boss")).json.nonce })).status, 400);
  assert.equal((await DM.get()).mode, "perks", "nothing moved");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'donation_mode'"))[0].n, n0);
  const nn = (await nonce("boss")).json.nonce;
  const ok = await flip("boss", { mode: "off", password: "pw-right", nonce: nn, note: "maintenance" });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual([ok.json.changed, ok.json.before, ok.json.donations.mode], [true, "perks", "off"]);
  assert.equal((await flip("boss", { mode: "on", password: "pw-right", nonce: nn })).status, 409, "a nonce works once");
  const a = (await getQuery("SELECT admin_id, admin_name, detail, reason, at FROM admin_audit WHERE action = 'donation_mode' ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual([a.admin_id, a.admin_name, a.reason, JSON.parse(a.detail).before, JSON.parse(a.detail).after], ["u-boss", "boss", "maintenance", "perks", "off"]);
  assert.ok(a.at > 0);
  const st = await DM.get();
  assert.deepEqual([st.mode, st.actor], ["off", "boss"]);
  // the admin panel: everyone with the card sees the state, only the owner gets the controls
  const own = await raw("GET", "/admin/economy", { user: "boss" }), adm = await raw("GET", "/admin/economy", { user: "adm" });
  assert.equal(own.status, 200);
  assert.match(own.text, /id="dmPill"[^>]*>Paused</);
  assert.match(own.text, /id="dmPw"/);
  assert.match(adm.text, /id="dmPill"/);
  assert.doesNotMatch(adm.text, /id="dmPw"/);
  assert.match(adm.text, /name="dmMode" value="on" disabled/);
  assert.equal((await raw("GET", "/admin/economy", { user: "alice" })).status === 200 && false, false);
  await setMode("perks");
});

test("the ledger guard: only the donation path can credit PAT for dollars", async () => {
  await setMode("on");
  const b0 = await bal("alice");
  for (const [type, opts] of [["donation", {}], ["donation-crypto", {}], ["donation-restored", {}], ["x", { source: "stripe donation" }], ["x", { source: "Crypto Donation" }],
                              ["donation", { donationGrant: {} }], ["donation", { donationGrant: Object.freeze({}), transactionId: "t1" }]]) {
    const r = await L.post("u-alice", 1000, type, opts);
    assert.deepEqual([r.ok, r.code], [false, L.E_NO_PAT_FOR_DOLLARS], type + JSON.stringify(opts));
  }
  assert.throws(() => NP.takeIssuer(), /already taken/, "the issuer belongs to donationpromo.js");
  assert.equal(await bal("alice"), b0);
  assert.equal((await L.post("u-alice", -10, "donation", {})).ok, true, "a debit is not a credit");
  await L.post("u-alice", 10, "tip", { source: "tip" });
  // terms that don't allow PAT can't reach the credit
  const T = await DP.creditTerms({ ref: "x1", userId: "u-alice", cents: 100, paidAt: t, via: "card" });
  assert.deepEqual([T.pat, T.bonus, T.perks_only, T.allow_pat], [0, 0, true, undefined]);
  // a source scan: the claim and the credit live in donationpromo.js alone
  const walk = (d, out = []) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (["node_modules", "test", ".git", "public", "tools", "docs", "data", "locales", "views", "uploads"].includes(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p, out); else if (e.name.endsWith(".js")) out.push(p); } return out; };
  for (const f of walk(repo)) {
    if (["donationpromo.js", "nopat.js"].includes(path.basename(f))) continue;
    const src = fs.readFileSync(f, "utf8");
    assert.doesNotMatch(src, /INSERT INTO reserve_claims[^;]*'mint:donation'/, f);
    assert.doesNotMatch(src, /donationGrant/, f);
  }
  await setMode("perks");
});

// ── what the pages say ──
test("every public sentence follows the state: /support, the card, the banner, /terms", async () => {
  const B = require(path.join(repo, "banner"));
  const body = async (url, user) => (await raw("GET", url, { user })).text;
  // perks
  await setMode("perks");
  let s = await body("/support", "alice");
  assert.match(s, /Donations never buy PAT/);
  assert.doesNotMatch(s, /data-rate=|PAT for you|community pot|Limited-time promo/);
  let tr = await body("/terms");
  assert.match(tr, /<b>Perks, never PAT:<\/b>/);
  assert.match(tr, /it can't be bought: donations give supporter perks, never PAT/);
  assert.doesNotMatch(tr, /Thank-you PAT/);
  assert.match((await B.chatHouse(false)).items.find((i) => i.kind === "support").headline, /Supporter perks/);
  // on
  await setMode("on");
  const p = await DP.create(OWNER, { mode: "rate", rate: RATE * 2, cap_usd: 20, today: true });
  s = await body("/support", "alice");
  assert.match(s, /data-rate="500000" data-bonus="20"/);
  assert.match(s, /data-promo=/);
  assert.match(s, /1,000,000<\/b> PAT per \$1/);
  assert.match(s, /\$1 = <b>500,000<\/b> PAT for you/);
  assert.doesNotMatch(s, /Donations never|never buy PAT|Never PAT/);
  tr = await body("/terms");
  assert.match(tr, /<b>Thank-you PAT:<\/b>[^<]*currently 500,000 PAT for every \$1/);
  assert.match(tr, /currently 20% of that/);
  assert.doesNotMatch(tr, /Perks, never PAT|never PAT/);
  assert.doesNotMatch(tr, /real-world prizes|Real-world prizes|No purchase necessary/i, "virtual prizes stay");
  assert.match(tr, /Virtual prizes in the store/);
  const m = (await B.chatHouse(false)).items.find((i) => i.kind === "support");
  assert.match(m.headline, /Donation promo/);
  const crd = await require("ejs").renderFile(path.join(repo, "views/partials/donate-card.ejs"), { donate: SB.donateLocals("/wallet", null) });
  assert.match(crd, /adds 500,000 PAT|every \$1 adds 500,000 PAT/);
  assert.doesNotMatch(crd, /never add PAT|never PAT/);
  await DP.end(OWNER, p.id);
  assert.match((await B.chatHouse(false)).items.find((i) => i.kind === "support").headline, /get 500,000 PAT per \$1/);
  // off
  await setMode("off");
  assert.equal((await B.chatHouse(false)).items.find((i) => i.kind === "support"), undefined, "no support promo while paused");
  tr = await body("/terms");
  assert.match(tr, /<b>Paused:<\/b> donations are paused right now/);
  assert.match(tr, /<b>Perks, never PAT:<\/b>/);
  assert.match(tr, /while donations gave PAT/, "the date claim no longer holds once PAT donations came back");
  const up = /Last updated ([^<]+)</.exec(tr)[1];
  assert.notEqual(up, "11 November 2026", "a switch change moves the date");
  await setMode("perks");
});
