// Offline tests for 1.99ix: Stripe Checkout + Billing for Prime Time / Season Pass (stripebilling.js) - OFF by default and
// hidden; signature verification, idempotent events, mapping onto the same entitlement rows PAT pays for. No network:
// the Stripe API is a mocked fetch, events are signed here with a fake test secret.
//   NODE_PATH=G:/PATV/node_modules node --test test/stripe-billing.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stripe-test-"));
process.chdir(tmp);
delete process.env.STAGING;
for (const k of ["STRIPE_ENABLED", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_PRIME_TIME", "STRIPE_PRICE_SEASON_PASS"]) delete process.env[k];
process.env.SECRET_KEY = "test-secret";
process.env.PAD_DIR = path.join(tmp, "pad");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const PR = require(path.join(repo, "premium"));
const SB = require(path.join(repo, "stripebilling"));

const SECRET = "whsec_test_fake_secret_for_tests";
const PLANT = "plant_based_chatting";
const USERS = {};
let server, base, owner, fan;
let t = Date.UTC(2026, 9, 10, 12);
PR._setClock(() => t);
SB._setClock(() => t);

function on() {
  process.env.STRIPE_ENABLED = "1";
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  process.env.STRIPE_PRICE_PRIME_TIME = "price_prime_fake";
  process.env.STRIPE_PRICE_SEASON_PASS = "price_pass_fake";
}
function off() { delete process.env.STRIPE_ENABLED; }
function signed(ev, secret = SECRET, at = Math.floor(t / 1000)) {
  const body = JSON.stringify(ev);
  return { body, header: `t=${at},v1=${SB.sign(body, secret, at)}` };
}
function raw(method, url, { body, headers = {}, user } = {}) {
  return new Promise((resolve, reject) => {
    const h = Object.assign({ Origin: base }, headers);
    if (user) h["x-test-user"] = user;
    if (body != null) h["Content-Length"] = Buffer.byteLength(body);
    const r = http.request(base + url, { method, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const s = Buffer.concat(chunks).toString("utf8"); let j = null; try { j = JSON.parse(s); } catch (e) { j = null; } resolve({ status: res.statusCode, json: j, text: s }); });
    });
    r.on("error", reject);
    if (body != null) r.write(body);
    r.end();
  });
}
const invoice = (id, sub, end, meta) => ({ id: "evt_" + id, type: "invoice.paid", created: 1, data: { object: { id: "in_" + id, object: "invoice", subscription: sub, customer: "cus_1",
  currency: "usd", amount_paid: 999, subscription_details: { metadata: meta || {} }, lines: { data: [{ period: { start: end / 1000 - 30 * 86400, end: end / 1000 } }] } } } });

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  for (const n of ["plantowner", "fan"]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, points_balance) VALUES (?, ?, ?, 'x', 0)", ["u-" + n, n, n]);
    USERS[n] = { userId: "u-" + n, username: n, class: "pleb" };
  }
  owner = USERS.plantowner; fan = USERS.fan;
  await rooms.init();
  await rooms.setOwner(PLANT, "plantowner", "test");
  await SB.init();
  const app = express();
  // the real app parses JSON everywhere EXCEPT the webhook (index.js skip list): the same here
  app.use((req, res, next) => (req.path === "/api/premium/stripe/webhook" ? next() : express.json()(req, res, next)));
  const addUser = (rq, rs, next) => { const u = rq.get("x-test-user"); rq.user = u ? USERS[u] || null : null; next(); };
  SB.register(app, { addUser });
  app.use((req, res) => res.status(404).send("not found"));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { if (server) server.close(); SB._setFetch(null); off(); });

test("off by default: every Stripe route is a 404 and the public state says only enabled:false", async () => {
  off();
  assert.equal(SB.enabled(), false);
  assert.deepEqual(SB.publicState(), { enabled: false });
  const { body, header } = signed({ id: "evt_off", type: "invoice.paid", data: { object: {} } });
  assert.equal((await raw("POST", "/api/premium/stripe/webhook", { body, headers: { "Stripe-Signature": header, "Content-Type": "application/json" } })).status, 404);
  assert.equal((await raw("POST", "/api/premium/stripe/checkout", { user: "fan", body: "{}", headers: { "Content-Type": "application/json" } })).status, 404);
  assert.equal((await raw("POST", "/api/premium/stripe/portal", { user: "fan", body: "{}", headers: { "Content-Type": "application/json" } })).status, 404);
  // on but a key missing: still off
  process.env.STRIPE_ENABLED = "1"; delete process.env.STRIPE_WEBHOOK_SECRET;
  assert.equal(SB.enabled(), false);
  off();
});

test("signatures: a good one parses; wrong secret, tampered body, too old, junk header: refused", () => {
  const ev = { id: "evt_sig", type: "x" };
  const { body, header } = signed(ev);
  assert.deepEqual(SB.verify(body, header, SECRET, t), ev);
  assert.deepEqual(SB.verify(Buffer.from(body), `t=1,v1=00,${header}`.replace("t=1,", ""), SECRET, t), ev, "any matching v1 among several");
  assert.throws(() => SB.verify(body, signed(ev, "whsec_other").header, SECRET, t), /mismatch/);
  assert.throws(() => SB.verify(body.replace("evt_sig", "evt_sih"), header, SECRET, t), /mismatch/);
  assert.throws(() => SB.verify(body, signed(ev, SECRET, Math.floor(t / 1000) - 600).header, SECRET, t), /too old/);
  assert.throws(() => SB.verify(body, "nonsense", SECRET, t), /header/);
  assert.throws(() => SB.verify(body, header, "", t), /secret/);
});

test("checkout: a subscription-mode Checkout Session with the tier / target / user in the metadata (mocked Stripe API)", async () => {
  on();
  let seen = null;
  SB._setFetch(async (url, opts) => { seen = { url, opts }; return { ok: true, json: async () => ({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1" }) }; });
  const r = await raw("POST", "/api/premium/stripe/checkout", { user: "plantowner", body: JSON.stringify({ tier: "prime_time", pad: PLANT }), headers: { "Content-Type": "application/json" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.url, "https://checkout.stripe.com/c/pay/cs_test_1");
  assert.equal(seen.url, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(seen.opts.headers.Authorization, "Bearer sk_test_fake");
  const f = new URLSearchParams(seen.opts.body);
  assert.equal(f.get("mode"), "subscription");
  assert.equal(f.get("line_items[0][price]"), "price_prime_fake");
  assert.equal(f.get("metadata[tier]"), "prime_time");
  assert.equal(f.get("metadata[target]"), PLANT);
  assert.equal(f.get("subscription_data[metadata][user_id]"), owner.userId);
  assert.match(f.get("success_url"), /\/premium\?pad=.*stripe=success$/);
  // a fan can't open a card subscription for someone else's pad
  const r2 = await raw("POST", "/api/premium/stripe/checkout", { user: "fan", body: JSON.stringify({ tier: "prime_time", pad: PLANT }), headers: { "Content-Type": "application/json" } });
  assert.equal(r2.status, 403);
  assert.deepEqual(SB.publicState(), { enabled: true, test: true, tiers: { prime_time: true, season_pass: true } });
});

test("webhook: checkout.session.completed links, invoice.paid extends stripe_through (entitlement on), a replayed event changes nothing, deleted unlinks", async () => {
  on();
  const meta = { tier: "season_pass", target: fan.userId, user_id: fan.userId };
  const send = (ev) => { const s = signed(ev); return raw("POST", "/api/premium/stripe/webhook", { body: s.body, headers: { "Stripe-Signature": s.header, "Content-Type": "application/json" } }); };
  const c = await send({ id: "evt_c1", type: "checkout.session.completed", created: 1, data: { object: { id: "cs_1", mode: "subscription", subscription: "sub_1", customer: "cus_1", metadata: meta } } });
  assert.equal(c.status, 200, c.text);
  assert.equal(c.json.outcome, "linked");
  let s = await PR.subRow("season_pass", fan.userId);
  assert.deepEqual([s.stripe_sub, s.stripe_customer, s.stripe_user], ["sub_1", "cus_1", fan.userId]);
  assert.equal(PR.hasPass(fan.userId), false, "linked, nothing paid yet");
  const end = t + 30 * 86400 * 1000;
  const p = await send(invoice("p1", "sub_1", end, meta));
  assert.equal(p.json.outcome, "extended");
  s = await PR.subRow("season_pass", fan.userId);
  assert.equal(s.stripe_through, end);
  assert.equal(PR.hasPass(fan.userId), true);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM transactions WHERE userId = ?", [fan.userId]))[0].n, 0, "real money: no PAT moves");
  // the same event again (Stripe retries): no-op
  const again = await send(invoice("p1", "sub_1", end + 99999000, meta));
  assert.equal(again.json.outcome, "dup");
  assert.equal((await PR.subRow("season_pass", fan.userId)).stripe_through, end);
  // an older invoice delivered late never moves the date back
  await send(invoice("p0", "sub_1", end - 30 * 86400 * 1000, meta));
  assert.equal((await PR.subRow("season_pass", fan.userId)).stripe_through, end);
  // the Season Pass perks came with it
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM user_cosmetics WHERE user_id = ? AND source = 'season_pass'", [fan.userId]))[0].n, 3);
  // cancelled: unlinked; the paid period still runs; then it lapses on the paid date (no grace without a renewal)
  const d = await send({ id: "evt_d1", type: "customer.subscription.deleted", created: 1, data: { object: { id: "sub_1", status: "canceled" } } });
  assert.equal(d.json.outcome, "unlinked");
  assert.equal(PR.hasPass(fan.userId), true);
  const save = t; t = end + 1000;
  try { assert.equal(PR.hasPass(fan.userId), false); } finally { t = save; }
  // bad signature: 400, nothing recorded
  const bad = await raw("POST", "/api/premium/stripe/webhook", { body: JSON.stringify({ id: "evt_x" }), headers: { "Stripe-Signature": "t=1,v1=00", "Content-Type": "application/json" } });
  assert.equal(bad.status, 400);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM stripe_events WHERE id = 'evt_x'"))[0].n, 0);
  // events, each once
  assert.deepEqual((await getQuery("SELECT id, outcome FROM stripe_events ORDER BY received, id")).map((r) => r.id).sort(), ["evt_c1", "evt_d1", "evt_p0", "evt_p1"]);
});

test("an invoice for an unknown subscription with metadata creates the mapping (checkout event lost); a payment failure leaves a notice", async () => {
  on();
  const meta = { tier: "prime_time", target: PLANT, user_id: owner.userId };
  const end = t + 30 * 86400 * 1000;
  const r = await SB.handleEvent(invoice("q1", "sub_9", end, meta));
  assert.equal(r.outcome, "extended");
  assert.equal(PR.isPrime(PLANT), true);
  const f = await SB.handleEvent({ id: "evt_f1", type: "invoice.payment_failed", data: { object: { id: "in_f1", subscription: "sub_9" } } });
  assert.equal(f.outcome, "failed-noted");
  const n = await getQuery("SELECT title FROM inbox WHERE user_id = ?", [owner.userId]);
  assert.ok(n.some((x) => /card payment failed/.test(x.title)));
});
