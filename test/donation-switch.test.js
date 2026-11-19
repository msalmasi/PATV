// 1.99aor: THE DONATIONS SWITCH (donationmode.js: on | perks | off). The owner, 2026-11-18: perks-only was temporary; bring PAT donations
// and promos back behind one owner switch, default perks, with a way to pause donations.
//   * the default and every unreadable state is "perks"; each state end to end on both rails (fake Stripe, recorded transfers)
//   * what a donor was quoted is what they get, whichever way the switch moved; no retroactive credit; no double credit
//   * refunds and disputes claw back (never below zero), a won dispute restores; supply stays conserved; the Fed journals the mints
//   * the daily caps and promo cap / budget, including open quotes
//   * owner + password step-up + audit on the switch; the ledger guard refuses everyone but the donation path
//   * review fixes: disputes by their own id (an inquiry takes nothing, a win always makes the donor whole), crypto by chain time, a stale
//     admin tab, /support never waits for a write, the rollback list, and every page once the switch has been on (no "never" while a
//     quoted donation can still land)
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
/** Back to the deploy state: no row, the switch never used. */
const forgetOn = async () => { await runQuery("DELETE FROM donation_promo_settings WHERE key = 'donations_mode'"); await DM.get(); };
async function raw(method, url, { user, body, headers = {} } = {}) {
  const h = { "content-type": "application/json", Origin: base, ...headers };
  if (user) h["x-test-user"] = user;
  const r = await fetch(base + url, { method, headers: h, body: body == null ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  if (DP._quotesSettled) await DP._quotesSettled();     // /support writes its crypto quote after the response
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
const transfer = (from, cents) => { const h = (++seq).toString(16).padStart(64, "0"); return { id: `eth:0x${h}:1`, chain: "eth", token: "USDC", token_addr: USDC, tx: "0x" + h, idx: "1", block: 1, src_addr: from, dst_addr: RECV, raw_amount: String(cents * 10000), usd_cents: cents, block_ms: t }; };
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
  require(path.join(repo, "padguide")).register(app, { addUser });
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
  // an account that is gone: nothing can move, the event still completes (Stripe isn't left retrying)
  const g = await checkout("erin", 1);
  await pay(g);
  await runQuery("UPDATE donation_credits SET user_id = 'u-gone' WHERE ref = ?", ["don-evt_" + g.id]);
  assert.equal((await SB.handleEvent(refundEvent(g, 100, "evt_gone"))).outcome, "donation-refund");
  assert.deepEqual((await getQuery("SELECT clawed_pat, short_pat FROM donation_credits WHERE ref = ?", ["don-evt_" + g.id]))[0], { clawed_pat: 0, short_pat: RATE });
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
const flip = async (user, body, headers = FETCH) => raw("POST", "/api/admin/donations/mode", { user, body: { from: (await DM.get()).mode, ...body }, headers });

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
  // perks, the switch never used (the deploy state)
  await setMode("perks");
  await forgetOn();
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
  assert.match(tr, /currently 20% of the PAT at the normal rate/);
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
  assert.match(tr, /<b>Perks for new donations:<\/b>/);
  assert.doesNotMatch(tr, /Perks, never PAT/);
  assert.match(tr, /while donations gave PAT/, "the date claim no longer holds once PAT donations came back");
  const up = /Last updated ([^<]+)</.exec(tr)[1];
  assert.notEqual(up, "11 November 2026", "a switch change moves the date");
  await setMode("perks");
});

// ── review fixes ──
const pool = (k, n) => runQuery("UPDATE pools SET balance = ? WHERE key = ?", [n, k]);
const credit = async (s) => (await getQuery("SELECT * FROM donation_credits WHERE ref = ?", ["don-evt_" + s.id]))[0];
const mints = async () => (await FED.botState()).doc.fed_mints;
const closeEv = (s, cents, id, status) => disputeEvent(s, cents, id, "charge.dispute.closed", status);
const page = (url, user) => raw("GET", url, { user }).then((r) => r.text);
/** The thank-you reads the member's newest card donation of the last hour (by the real clock): every other one is made old. */
const ageOthers = async (u, ref = "-") => {
  await runQuery("UPDATE reserve_claims SET created = datetime('now', '-2 hours') WHERE userId = ? AND claimId != ?", ["u-" + u, ref]);
  await runQuery("UPDATE donation_usd_log SET paid_at = MIN(paid_at, ?) WHERE user_id = ? AND ref != ?", [Date.now() - 7200000, "u-" + u, ref]);
};
const NEVER = /never (buy|add|adds|bring|create|PAT)|Never PAT|can(’|')t be bought|perks only, never|Perks only:|Perks, never PAT/i;

test("a dispute won always completes and makes the donor whole, whatever the Reserve still holds", async () => {
  await setMode("on");
  const s = await checkout("dave", 100);
  await pay(s); await FED.donationSweep();
  const pat = 100 * RATE, bonus = pat * BONUS / 100, d0 = await bal("dave"), i0 = await P.balance("incentives");
  assert.equal((await SB.handleEvent(disputeEvent(s, 10000, "evt_w1"))).outcome, "donation-dispute");
  assert.deepEqual([await bal("dave"), await P.balance("incentives")], [d0 - pat, i0 - bonus]);
  // the ceiling release and the Monday guarantee have spent nearly all of what came in
  await pool("reserve", 5 * M);
  const s0 = await supply();
  const r = await SB.handleEvent(closeEv(s, 10000, "evt_w2", "won"));
  assert.equal(r.outcome, "donation-dispute-won");
  assert.deepEqual([await bal("dave"), await P.balance("incentives"), await P.balance("reserve")], [d0, i0, 0], "the donor and the pot are whole; the Reserve paid what it had");
  assert.equal(await supply(), s0 + pat + bonus - 5 * M, "only what the Reserve no longer held was minted again");
  const J = await mints();
  assert.deepEqual([J["donret-evt_w2-mw"].amount, J["donret-evt_w2-mw"].dest, J["donret-evt_w2-mw"].policy], [pat - 5 * M, "site", "donation"], "on the journal");
  assert.deepEqual([J["donret-evt_w2-mb"].amount, J["donret-evt_w2-mb"].dest], [bonus, "incentives"]);
  const c = await credit(s);
  assert.deepEqual([c.disputed_cents, c.clawed_pat, c.clawed_bonus, c.short_pat, c.owed_pat], [0, 0, 0, 0, 0]);
  // an empty Reserve, and a pot that had nothing to give back at the time: the wallet still comes back in full
  const q = await checkout("erin", 20);
  await pay(q); await FED.donationSweep();
  const e0 = await bal("erin");
  await pool("incentives", 0);
  await SB.handleEvent(disputeEvent(q, 2000, "evt_w3"));
  assert.equal((await credit(q)).clawed_bonus, 0);
  await pool("reserve", 0);
  await pool("incentives", i0);
  assert.equal((await SB.handleEvent(closeEv(q, 2000, "evt_w4", "won"))).outcome, "donation-dispute-won");
  assert.equal(await bal("erin"), e0);
  assert.equal((await mints())["donret-evt_w4-mw"].amount, 20 * RATE);
  await pool("reserve", POOLS.reserve);
});

test("a card network's inquiry takes nothing, and closing one leaves the PAT alone", async () => {
  await setMode("on");
  const s = await checkout("bob", 10);
  await pay(s); await FED.donationSweep();
  const b0 = await bal("bob");
  assert.equal((await SB.handleEvent(disputeEvent(s, 1000, "evt_i1", "charge.dispute.created", "warning_needs_response"))).outcome, "donation-inquiry");
  assert.equal(await bal("bob"), b0);
  assert.deepEqual([(await credit(s)).disputed_cents, (await credit(s)).clawed_pat], [0, 0]);
  assert.equal((await SB.handleEvent(closeEv(s, 1000, "evt_i2", "warning_closed"))).outcome, "donation-dispute-won");
  assert.equal(await bal("bob"), b0);
  // the Supporter dollars weren't touched either
  assert.equal((await getQuery(`SELECT usd_cents FROM ${require(path.join(repo, "donations")).SQL} d WHERE d.ref = ?`, ["don-evt_" + s.id]))[0].usd_cents, 1000);
});

test("disputes follow their own id: a late 'created' changes nothing, and a close that arrives alone is enough", async () => {
  await setMode("on");
  const a = await checkout("carol", 10), b = await checkout("carol", 10);
  await pay(a); await pay(b); await FED.donationSweep();
  const c0 = await bal("carol");
  // closed (won) first, the "created" retried after it
  await SB.handleEvent(closeEv(a, 1000, "evt_o1", "won"));
  await SB.handleEvent(disputeEvent(a, 1000, "evt_o2"));
  assert.equal(await bal("carol"), c0, "a dispute already closed doesn't reopen");
  assert.equal((await credit(a)).disputed_cents, 0);
  // lost with no "created" ever seen (the events weren't subscribed yet)
  assert.equal((await SB.handleEvent(closeEv(b, 400, "evt_o3", "lost"))).outcome, "donation-dispute-lost");
  assert.deepEqual([await bal("carol"), (await credit(b)).disputed_cents, (await credit(b)).clawed_pat], [c0 - 4 * RATE / 1, 400, 4 * RATE]);
  // the same close again under another event id, and a late "created": once
  await SB.handleEvent(closeEv(b, 400, "evt_o4", "lost"));
  await SB.handleEvent(disputeEvent(b, 400, "evt_o5"));
  assert.equal(await bal("carol"), c0 - 4 * RATE);
});

test("crypto: a transfer mined before the switch went on gets perks, however late the watcher sees it", async () => {
  await setMode("perks");
  tick(60000);
  const before = transfer(ADDR.bob, 500);              // mined now, under perks
  tick(60000);
  await setMode("on");
  tick(1000);
  assert.equal((await raw("GET", "/support", { user: "bob" })).status, 200, "and looking at the page afterwards doesn't change what was already sent");
  tick(1000);
  const b0 = await bal("bob");
  assert.equal(await CP.record(before, true), "credited");
  assert.deepEqual([(await row(before)).pat, (await row(before)).claim_id, (await row(before)).terms, await bal("bob")], [0, null, null, b0]);
  const after = transfer(ADDR.bob, 500);               // mined after the flip: PAT
  tick(1000);
  assert.equal(await CP.record(after, true), "credited");
  assert.equal((await row(after)).pat, 5 * RATE);
  assert.equal(await bal("bob"), b0 + 5 * RATE);
  // EVM: the block's time is read from the chain, once a block, and only while the switch is on
  let calls = 0;
  CP._setFetch(async (url, o) => { const q = JSON.parse(o.body); assert.equal(q.method, "eth_getBlockByNumber"); assert.equal(q.params[0], "0x309"); calls++; return { ok: true, json: async () => ({ result: { timestamp: "0x" + Math.floor(t / 1000 - 3600).toString(16) } }) }; });
  const strip = (x) => { const { block_ms, ...y } = x; return { ...y, block: 777 }; };
  const u1 = strip(transfer(ADDR.bob, 100)), u2 = strip(transfer(ADDR.bob, 100));
  await CP.record(u1, true); await CP.record(u2, true);
  assert.equal(calls, 1);
  assert.deepEqual([(await row(u1)).pat, (await row(u2)).pat], [0, 0], "that block is an hour before the flip");
  // no time for the block: nothing is recorded, so the watcher's pass is retried
  CP._setFetch(async () => ({ ok: true, json: async () => ({ result: null }) }));
  const u3 = { ...strip(transfer(ADDR.bob, 100)), block: 778 };
  await assert.rejects(CP.record(u3, true), /no time for block/);
  assert.equal(await row(u3), undefined);
  CP._setFetch(async () => { throw new Error("no network in the tests"); });
  // both parsers hand the time over when the chain gives it
  const SOL = "So11111111111111111111111111111111111111112", USDC_S = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const sol = CP.parseSolTx("sig1", { slot: 9, blockTime: 1800000000, meta: { err: null, preTokenBalances: [], postTokenBalances: [], innerInstructions: [] },
    transaction: { message: { accountKeys: [], instructions: [{ program: "spl-token", parsed: { type: "transfer", info: { destination: "acct", amount: "1000000", authority: SOL } } }] } } }, "acct", USDC_S, SOL);
  assert.equal(sol[0].block_ms, 1800000000000);
  const pad = (a) => "0x" + "0".repeat(24) + a.slice(2);
  const evm = CP.parseEvmLogs("eth", [{ address: USDC, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", pad(ADDR.bob), pad(RECV)], data: "0x" + (1000000).toString(16).padStart(64, "0"),
    transactionHash: "0x" + "e".repeat(64), logIndex: "0x1", blockNumber: "0x10", blockTimestamp: "0x6b49d200" }], RECV);
  assert.equal(evm[0].block_ms, 0x6b49d200 * 1000);
});

test("the switch: a page left open can't override a newer change (409 stale, nothing spent, nothing written)", async () => {
  await setMode("perks");
  const n = (await nonce("boss")).json.nonce;
  await setMode("off");                                 // changed elsewhere after that page loaded
  const a0 = (await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'donation_mode'"))[0].n;
  const r = await raw("POST", "/api/admin/donations/mode", { user: "boss", headers: FETCH, body: { mode: "on", from: "perks", password: "pw-right", nonce: n } });
  assert.deepEqual([r.status, r.json.code, r.json.detail.mode], [409, "stale", "off"], r.text);
  assert.equal((await DM.get()).mode, "off", "the pause stands");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'donation_mode'"))[0].n, a0);
  const none = await raw("POST", "/api/admin/donations/mode", { user: "boss", headers: FETCH, body: { mode: "on", password: "pw-right", nonce: n } });
  assert.equal(none.json.code, "stale", "a request that names no state is stale too");
  const ok = await raw("POST", "/api/admin/donations/mode", { user: "boss", headers: FETCH, body: { mode: "perks", from: "off", password: "pw-right", nonce: n } });
  assert.equal(ok.status, 200, "the refused try didn't use the nonce: " + ok.text);
  // the same check inside the write (two requests racing past the first look)
  await assert.rejects(DM.set(OWNER, "on", null, { from: "off" }), (e) => e.status === 409 && e.code === "stale");
  assert.equal((await DM.get()).mode, "perks");
});

test("admin-donmode.js sends the state it shows, and a stale answer redraws the card", async () => {
  const vm = require("vm");
  const els = {}, events = [], radios = ["on", "perks", "off"].map((value) => ({ value, checked: value === "perks" }));
  const el = (id) => (els[id] = els[id] || { id, textContent: "", className: "", value: "", hidden: false, disabled: false, appendChild() {}, focus() {}, closest: () => null, addEventListener(t, f) { this["on" + t] = f; } });
  els.dmAdm = Object.assign(el("dmAdm"), { querySelector: () => radios.find((r) => r.checked) || null, querySelectorAll: () => radios });
  let sent = null;
  const state = { mode: "off", readable: true, updated: 1, actor: "x", ever_on: true, describe: { on: { label: "On", text: "o" }, perks: { label: "Perks only", text: "p" }, off: { label: "Paused", text: "f" } },
                  credits: { n: 0, pat: 0, bonus: 0, clawed: 0, short: 0, owed: 0 }, open_quotes: 0, normal: { rate: RATE, bonus_pct: BONUS }, history: [], reversals: [], rollback: { card: [], crypto: [{ ref: "r", user_id: "u", usd_cents: 100 }] } };
  const fetch_ = async (url, o) => {
    if (/nonce/.test(url)) return { ok: true, status: 200, json: async () => ({ ok: true, nonce: "n1" }) };
    sent = JSON.parse(o.body);
    return { ok: false, status: 409, json: async () => ({ ok: false, code: "stale", error: "changed", detail: state }) };
  };
  vm.runInNewContext(fs.readFileSync(path.join(repo, "public/js/admin-donmode.js"), "utf8"), { document: { getElementById: el, createElement: () => ({ appendChild() {} }), dispatchEvent: (e) => events.push(e.type) }, fetch: fetch_, CustomEvent: function (t) { this.type = t; } });
  radios[0].checked = true; radios[1].checked = false;
  el("dmPw").value = "pw";
  el("dmForm").onsubmit({ preventDefault() {} });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([sent.mode, sent.from], ["on", "perks"]);
  assert.equal(els.dmPill.textContent, "Paused", "the card now shows what is true");
  assert.deepEqual(radios.map((r) => r.checked), [false, false, true]);
  assert.match(els.dmRate.textContent, /not applied in this state/);
  assert.equal(els.dmRbBox.hidden, false);
  assert.equal(els.dmMsg.textContent, "changed");
  assert.deepEqual(events, ["donmode:changed"]);
});

test("one failed read doesn't drop a Supporter from the cache; a real 'nothing counts' still does", async () => {
  const SUP = require(path.join(repo, "supporter"));
  await SUP.init();
  assert.ok(await SUP.refresh("u-alice"));
  await runQuery("ALTER TABLE donation_credits RENAME TO dc_hidden");
  try {
    assert.ok(await SUP.refresh("u-alice"), "the read failed: the member stays as they were");
    assert.ok(SUP.supporterSync("u-alice"));
    assert.ok(SUP.supporterByName("alice"));
  } finally { await runQuery("ALTER TABLE dc_hidden RENAME TO donation_credits"); }
});

test("/support doesn't wait for a write: the quote lands after the page, with the page's own moment and state", async () => {
  await setMode("on");
  tick(3 * 3600000);                                    // bob's earlier quote has lapsed: this view needs a new one
  const shownAt = t;
  const { tx } = require(path.join(repo, "dbUtils"));
  let open, entered;
  const gate = new Promise((r) => { open = r; }), inside = new Promise((r) => { entered = r; });
  const held = tx(async () => { entered(); await gate; });
  await inside;
  const res = await Promise.race([fetch(base + "/support", { headers: { "x-test-user": "bob" } }).then((r) => r.status), new Promise((r) => setTimeout(() => r("still waiting"), 2500))]);
  open(); await held;
  assert.equal(res, 200);
  await DP._quotesSettled();
  const q = (await getQuery("SELECT created, mode FROM donation_quotes WHERE user_id = 'u-bob' AND via = 'crypto' ORDER BY created DESC LIMIT 1"))[0];
  assert.deepEqual([q.created, q.mode], [shownAt, "on"]);
  // the switch moved between the page and the write: what the page showed is not on offer any more
  const n0 = (await getQuery("SELECT COUNT(*) AS n FROM donation_quotes WHERE user_id = 'u-carol' AND via = 'crypto'"))[0].n;
  tick(3 * 3600000);
  assert.equal(await DP.noteCryptoQuote("u-carol", t, "perks"), null);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM donation_quotes WHERE user_id = 'u-carol' AND via = 'crypto'"))[0].n, n0);
});

test("a rollback's casualties are listed for the owner, and only those", async () => {
  await setMode("on");
  const before = await DP.rollbackCases();
  const lost = await checkout("erin", 7);
  await runQuery("INSERT INTO donation_usd_log (ref, user_id, via, paid_at, usd_cents, pat, status, session, created) VALUES ('don-old', 'u-erin', 'card', ?, 700, 0, 'credited', ?, ?)", [t, lost.id, t]);
  const fine = await checkout("erin", 8);
  await pay(fine);
  const x = transfer(ADDR.alice, 300);
  await CP.record(x, true);
  await runQuery("UPDATE crypto_payments SET pat = 0, bonus = 0, claim_id = NULL, applied = NULL WHERE id = ?", [x.id]);   // what an older build's settle leaves
  const after = transfer(ADDR.alice, 300);
  await CP.record(after, true);
  const R = await DP.rollbackCases();
  assert.deepEqual([R.card.length - before.card.length, R.crypto.length - before.crypto.length], [1, 1]);
  assert.equal(R.card[0].ref, lost.metadata.quote);
  assert.equal(R.crypto[0].ref, x.id);
  assert.equal((await DP.modeState()).rollback.crypto[0].ref, x.id);
  assert.match(await page("/admin/economy", "boss"), new RegExp("Quoted PAT, settled without it[\\s\\S]*" + lost.metadata.quote));
  await runQuery("DELETE FROM donation_usd_log WHERE ref = 'don-old'");
  await runQuery("UPDATE crypto_payments SET applied = 'perks' WHERE id = ?", [x.id]);
});

test("refund and dispute notices name the dollars this event moved, under their own title", async () => {
  await setMode("on");
  const s = await checkout("carol", 10);
  await pay(s); await FED.donationSweep();
  await SB.handleEvent(refundEvent(s, 200, "evt_n1"));
  let n = (await inbox("carol"))[0];
  assert.match(n.title, /Your PATV donation was updated/);
  assert.match(n.body, /\$2\.00 of your \$10\.00 donation was refunded, so 1,000,000 PAT/);
  await SB.handleEvent(refundEvent(s, 500, "evt_n2"));
  assert.match((await inbox("carol"))[0].body, /\$3\.00 of your \$10\.00 donation was refunded, so 1,500,000 PAT/);
  await SB.handleEvent(disputeEvent(s, 100, "evt_n3"));
  assert.match((await inbox("carol"))[0].body, /\$1\.00 of your \$10\.00 donation is being disputed/);
  const w = await checkout("carol", 4);
  await pay(w); await FED.donationSweep();
  await SB.handleEvent(closeEv(w, 400, "evt_n4", "lost"));
  assert.match((await inbox("carol"))[0].body, /^Your \$4\.00 donation was charged back, so 2,000,000 PAT/);
  const r = await checkout("carol", 3);
  await pay(r); await SB.handleEvent(refundEvent(r, 300, "evt_n5"));
  assert.match((await inbox("carol"))[0].body, /^Your \$3\.00 donation was refunded/);
});

test("after the switch has been on, perks and paused never say 'never': quoted PAT can still land", async () => {
  await setMode("on");
  const s = await checkout("carol", 4);
  await setMode("off");
  const c0 = await bal("carol");
  assert.equal((await pay(s)).outcome, "donation-credited");
  assert.equal(await bal("carol"), c0 + 4 * RATE);
  await ageOthers("carol", "don-evt_" + s.id);
  const B = require(path.join(repo, "banner"));
  const econ = (over) => require("ejs").renderFile(path.join(repo, "views/economy.ejs"), { user: null, treasury: null, roomVaults: null, ogBase: "http://t",
    live: { supply: { total: 5e8, circulating: 5e8, burned: { total: 0 }, layers: [] }, pools: {}, fed: 8e7, band: { floor: 5e7, ceiling: 15e7 }, incentives: { balance: 1e7, budgets: {}, remaining: {}, share: null }, fortknox: 9e6, history: [], month: { minted: 0, burned: 0, change: 0 }, ...over } }, { views: [path.join(repo, "views")] });
  for (const m of ["off", "perks"]) {
    await setMode(m);
    const sp = await page("/support?donate=success", "carol"), tr = await page("/terms"), own = await page("/pads/owners", "carol");
    assert.match(sp, /2,000,000<\/b> PAT just landed/, m);
    assert.doesNotMatch(sp, NEVER, m + ": /support");
    assert.doesNotMatch(tr, /never adds PAT|never PAT|can't be bought/, m + ": /terms");
    assert.match(tr, /<b>Perks for new donations:<\/b>[^<]*quoted PAT before this changed still receives it/, m);
    assert.match(tr, /new donations give supporter perks and don't add PAT right now, and donating doesn't change the odds/, m);
    assert.doesNotMatch(own, NEVER, m + ": /pads/owners");
    assert.match(own, /doesn’t add PAT right now/, m);
    assert.doesNotMatch(await econ({ donationMode: m, donationEverOn: true }), NEVER, m + ": /economy");
    assert.match(await econ({ donationMode: m, donationEverOn: true }), /New ones don’t add PAT right now/, m);
    assert.doesNotMatch(await require("ejs").renderFile(path.join(repo, "views/partials/donate-card.ejs"), { donate: SB.donateLocals("/wallet", "success") }), NEVER, m + ": the card");
  }
  const house = (await B.chatHouse(false)).items.find((i) => i.kind === "support");
  assert.doesNotMatch(house.line, /never/i);
  const slot = await require("ejs").renderFile(path.join(repo, "views/partials/banner.ejs"), { bn: { ad: "h:s", paid: false, kind: "text", promo: "support", href: "/b/go/h/s", vars: { was: true } } });
  assert.match(slot, /a Supporter flair, badges and cosmetics\./, "the homepage slot uses the same text");
  assert.doesNotMatch(slot, /never add/i);
  // a perks receipt after that can't say "never" either
  const p = await checkout("carol", 2);
  await pay(p);
  assert.doesNotMatch((await inbox("carol"))[0].body, /never/i);
  // ever_on survives a damaged row: the audit log still says PAT donations happened
  await runQuery("UPDATE donation_promo_settings SET value = '{broken' WHERE key = 'donations_mode'");
  assert.deepEqual([(await DM.get()).mode, (await DM.get()).ever_on], ["perks", true]);
  assert.doesNotMatch(await page("/terms"), /never adds PAT/);
  await setMode("off");
  assert.equal((await DM.get()).ever_on, true, "rewriting the row keeps it");
  // on: /pads/owners follows too (and the default state keeps today's sentence: the last test)
  await setMode("on");
  const own = await page("/pads/owners");
  assert.doesNotMatch(own, /can(’|')t be bought|never PAT/);
  assert.match(own, /can add some as a thank-you/);
  await setMode("perks");
});

test("the deploy state keeps today's sentences on /pads/owners, /economy and the card", async () => {
  await forgetOn();
  assert.match(await page("/pads/owners"), /They can’t be bought/);
  const html = await require("ejs").renderFile(path.join(repo, "views/partials/donate-card.ejs"), { donate: SB.donateLocals("/wallet", null) });
  assert.match(html, /Donations never add PAT/);
});

test("the community pot: promo dollars under the default bonus base aren't promised a bonus", async () => {
  await setMode("on");
  tick(5000);
  const p = await DP.create(OWNER, { mode: "rate", rate: RATE * 2, cap_usd: 50, today: true });
  assert.equal(p.bonus_base, "normal");
  const s = await checkout("bob", 10);
  await pay(s);
  await ageOthers("bob", "don-evt_" + s.id);
  assert.equal((await credit(s)).bonus, 0);
  let h = await page("/support?donate=success", "bob");
  assert.match(h, /10,000,000<\/b> PAT just landed/);
  assert.doesNotMatch(h, /went to the community pot/, "this donation added nothing to it");
  assert.doesNotMatch(h, /\+0 PAT to the pot/);
  assert.doesNotMatch(h, /\+20% extra to the community pot|an extra 20% goes to the community pot|Every donation also grows/);
  assert.match(h, /\+20% to the community pot, at the normal rate/);
  assert.match(h, /you get <b>[0-9,]+<\/b> PAT\.<\/p>/, "the summary doesn't count +0 for the pot");
  assert.match(await page("/terms"), /currently 20% of the PAT at the normal rate; a promotion can change this/);
  await DP.end(OWNER, p.id);
  // a donation that did add to the pot says exactly how much
  const n = await checkout("bob", 5);
  await pay(n);
  await ageOthers("bob", "don-evt_" + n.id);
  assert.match(await page("/support?donate=success", "bob"), /<b>500,000<\/b> PAT went to the community pot/);
});

test("copy that follows the donation, not the switch: the wait after Stripe, 'Credited', the Terms' licence bullet", async () => {
  await setMode("perks");
  await checkout("erin", 5);                            // quoted perks...
  await setMode("on");                                  // ...the switch moves before the donor is back from Stripe
  await ageOthers("erin");
  const h = await page("/support?donate=success", "erin");
  assert.doesNotMatch(h, /Your PAT will be in your wallet/);
  assert.match(h, /We’re confirming your donation, and your inbox will say what it added/);
  const c = await require("ejs").renderFile(path.join(repo, "views/partials/donate-card.ejs"), { donate: SB.donateLocals("/wallet", "success") });
  assert.doesNotMatch(c, /Your PAT will be/);
  // a past perks-only transfer isn't shown as "Credited" with nothing beside it; one that gave PAT is
  const a = await page("/support", "alice");
  assert.match(a, /data-pat=""[\s\S]*?Received - thank you!/);
  assert.match(a, /data-pat="\d+"[\s\S]*?Credited/);
  assert.match(a, /stays yours unless the donation is refunded or charged back/);
  assert.doesNotMatch(a, /it's yours for good/);
  const tr = await page("/terms");
  assert.match(tr, /or for anything outside PATV, is not allowed\.<\/li>/, "no exception for donations in the rule against buying PAT");
  assert.doesNotMatch(tr, /funds rewards/);
  assert.match(tr, /pays out rewards across PATV/);
  await setMode("perks");
});

test("the paused card still answers a donor back from Stripe, and shows only where a donation would have been offered", async () => {
  await setMode("off");
  const R = (d) => require("ejs").renderFile(path.join(repo, "views/partials/donate-card.ejs"), { donate: d });
  const ok = await R(SB.donateLocals("/shop", "success"));
  assert.match(ok, /Donations are paused/);
  assert.match(ok, /We’re confirming your donation/);
  assert.match(await R(SB.donateLocals("/shop", "cancel")), /nothing was charged/);
  assert.doesNotMatch(await R(SB.donateLocals("/shop", null)), /confirming|nothing was charged/);
  process.env.STRIPE_ENABLED = "";
  await CP.set({ crypto_donations_enabled: false }, "test");
  try {
    const d = SB.donateLocals("/shop", null);
    assert.equal(d.paused, undefined);
    assert.doesNotMatch(await R(d), /Donations are paused/);
  } finally { process.env.STRIPE_ENABLED = "1"; await CP.set({ crypto_donations_enabled: true }, "test"); }
  await setMode("perks");
});

test("the admin card agrees with the switch", async () => {
  await forgetOn();
  let h = await page("/admin/economy", "boss");
  assert.doesNotMatch(h, /Promos are retired|retired: a donation/);
  assert.doesNotMatch(h, /re-read the note on/);
  assert.match(h, /reedsmith\.com/);
  const quote = /for material changes we'll give notice on the site — the next time you post, you'll be asked to accept the new version\./;
  assert.match(h, quote, "the card quotes the Terms' promise");
  assert.match(await page("/terms"), quote, "...word for word");
  assert.match(h, /href="#donations"[^>]*>[^<]*Donations/, "the sidebar has an entry");
  assert.match(h, /id="dmRate"/);
  await assert.rejects(DP.create(OWNER, { mode: "rate", rate: RATE * 2, cap_usd: 10, today: true }), (e) => e.status === 410 && /need donations set to On/.test(e.message) && !/retired/.test(e.message));
  const css = fs.readFileSync(path.join(repo, "public/css/admin.css"), "utf8");
  assert.match(css, /\.adm-form\[hidden\], \.adm-btn\[hidden\] \{ display: none; \}/, "hidden must win over .adm-form's display: grid");
  const js = fs.readFileSync(path.join(repo, "public/js/admin-donpromo.js"), "utf8");
  assert.doesNotMatch(js, /Normal rate \(Pepe\)/);
  assert.match(js, /Promo on hold/);
});
