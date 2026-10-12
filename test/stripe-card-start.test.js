// Offline tests for 1.99tk: a card subscription never charges for time already paid (stripebilling.js + premium.js).
//   * checkout on a row with PAT time / a timed comp left: subscription_data.trial_end = where that time ends (at least
//     48 h ahead), for Prime Time, 💎 Plus (which also counts the pad's PAT Prime Time at the upgrade rate) and Season Pass
//   * the other way: PAT buys / gifts / chip-ins are refused while a card subscription is linked; after it's cancelled,
//     PAT time adds on after the card's paid time
//   * a comp on a card-paid row defers (trial_end) or pauses the card; revoking resumes it
// No network: the Stripe API is a mocked fetch.
//   NODE_PATH=G:/PATV/node_modules node --test test/stripe-card-start.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stripe-start-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.PAD_DIR = path.join(tmp, "pad");
process.env.STRIPE_ENABLED = "1";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_fake";
process.env.STRIPE_PRICE_PRIME_TIME = "price_prime_fake";
process.env.STRIPE_PRICE_SEASON_PASS = "price_pass_fake";
process.env.STRIPE_PRICE_PRIME_PLUS = "price_plus_fake";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const PR = require(path.join(repo, "premium"));
const SB = require(path.join(repo, "stripebilling"));

const DAY = 24 * 3600 * 1000;
const PADS = { ann: "start_pad_a", bob: "start_pad_b", cat: "start_pad_c", dan: "start_pad_d" };
const U = {};
let t = Date.UTC(2026, 9, 12, 12);
PR._setClock(() => t);
SB._setClock(() => t);
let calls = [];
let n = 0;
SB._setFetch(async (url, opts) => {
  const p = url.replace("https://api.stripe.com/v1", "");
  calls.push({ p, method: opts.method, body: opts.body != null ? new URLSearchParams(opts.body) : null });
  if (p === "/checkout/sessions") { n++; return { ok: true, json: async () => ({ id: "cs_s" + n, url: "https://checkout.stripe.com/c/pay/cs_s" + n }) }; }
  return { ok: true, json: async () => ({ id: p.split("/").pop(), status: "active" }) };
});
const lastSession = () => calls.filter((c) => c.p === "/checkout/sessions").at(-1).body;
const sec = (ms) => String(Math.floor(ms / 1000));
const ref = () => "r" + Math.random().toString(36).slice(2, 12) + "x";
const invoice = (id, sub, end, meta) => ({ id: "evt_" + id, type: "invoice.paid", created: 1, data: { object: { id: "in_" + id, subscription: sub, customer: "cus_" + id,
  currency: "usd", amount_paid: 2000, subscription_details: { metadata: meta || {} }, lines: { data: [{ period: { start: end / 1000 - 30 * 86400, end: end / 1000 } }] } } } });

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  for (const name of [...Object.keys(PADS), "fan"]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, points_balance) VALUES (?, ?, ?, 'x', 900000000)", ["u-" + name, name, name]);
    U[name] = { userId: "u-" + name, username: name, class: "pleb" };
  }
  await rooms.init();
  for (const [who, id] of Object.entries(PADS)) { await rooms.addRoom(id, null, "test"); await rooms.setOwner(id, who, "test"); }
  await SB.init();
  await PR.setConfig({ comp_admins: false }, "test");
});
test.after(() => { SB._setFetch(null); delete process.env.STRIPE_ENABLED; });

test("Prime Time: PAT time left -> the card's first charge is where it ends (trial_end); the page says so; no cover -> charged now", async () => {
  const b = await PR.buy(U.ann, { tier: "prime_time", pad: PADS.ann, months: 1, ref: ref() });
  const st = await PR.state(U.ann, PADS.ann);
  assert.deepEqual(st.pad.card_start, { covered: b.paid_through, first: b.paid_through });
  calls = [];
  const r = await SB.checkout(U.ann, { tier: "prime_time", pad: PADS.ann });
  assert.equal(lastSession().get("subscription_data[trial_end]"), sec(b.paid_through));
  assert.deepEqual([r.covered_until, r.first_charge], [b.paid_through, b.paid_through]);
  // nothing paid: no trial, charged straight away
  calls = [];
  const r2 = await SB.checkout(U.bob, { tier: "prime_time", pad: PADS.bob });
  assert.equal(lastSession().get("subscription_data[trial_end]"), null);
  assert.equal(r2.first_charge, null);
  assert.equal((await PR.state(U.bob, PADS.bob)).pad.card_start, null);
});

test("less than 48 hours of PAT left: the first charge is pushed to Stripe's minimum (a little free time, never a double charge)", async () => {
  const b = await PR.buy(U.cat, { tier: "prime_time", pad: PADS.cat, amount: Math.ceil(PR.config().prime_price / 30), ref: ref() });   // one day
  assert.ok(b.paid_through - t < 2 * DAY);
  calls = [];
  const r = await SB.checkout(U.cat, { tier: "prime_time", pad: PADS.cat });
  assert.equal(r.covered_until, b.paid_through);
  assert.equal(r.first_charge, t + PR.CARD_MIN_DEFER_MS);
  assert.equal(lastSession().get("subscription_data[trial_end]"), sec(t + PR.CARD_MIN_DEFER_MS));
});

test("Season Pass: a timed comp counts as paid (first charge when it ends); a comp with no end is refused", async () => {
  const until = t + 10 * DAY;
  await PR.setComp("season_pass", U.fan.userId, true, "test", null, { until });
  calls = [];
  const r = await SB.checkout(U.fan, { tier: "season_pass" });
  assert.equal(r.first_charge, until);
  assert.equal(lastSession().get("subscription_data[trial_end]"), sec(until));
  await PR.setComp("season_pass", U.fan.userId, false, "test");
  await PR.setComp("season_pass", U.fan.userId, true, "test");
  await assert.rejects(SB.checkout(U.fan, { tier: "season_pass" }), (e) => e.status === 409 && /free/.test(e.message));
  await PR.setComp("season_pass", U.fan.userId, false, "test");
});

test("💎 Plus: the pad's PAT Prime Time counts at the upgrade rate; once paid it ends and Plus runs to the first charge with no gap", async () => {
  await PR.buy(U.dan, { tier: "prime_time", pad: PADS.dan, months: 2, ref: ref() });
  const up = await PR.upgradeCredit(PADS.dan, t);
  assert.ok(up && up.plusMs > 2 * DAY);
  calls = [];
  const r = await SB.checkout(U.dan, { tier: "prime_plus", pad: PADS.dan });
  assert.equal(r.first_charge, t + up.plusMs);
  const f = lastSession();
  assert.equal(f.get("subscription_data[trial_end]"), sec(t + up.plusMs));
  assert.equal(f.get("metadata[convert_pt]"), "1");
  assert.deepEqual((await PR.state(U.dan, PADS.dan)).pad.plus.card_start, { covered: t + up.plusMs, first: t + up.plusMs });
  const meta = { tier: "prime_plus", target: PADS.dan, user_id: U.dan.userId, hold: f.get("metadata[hold]"), convert_pt: "1" };
  const c = await SB.handleEvent({ id: "evt_dconv", type: "checkout.session.completed", created: 1,
    data: { object: { id: "cs_dconv", mode: "subscription", subscription: "sub_dplus", customer: "cus_d", metadata: meta } } });
  assert.equal(c.outcome, "linked");
  const pt = await PR.subRow("prime_time", PADS.dan), pp = await PR.subRow("prime_plus", PADS.dan);
  assert.equal(pt.paid_through, t, "the converted Prime Time ended");
  assert.equal(pp.stripe_through, t + up.plusMs);
  assert.equal(PR.padTier(PADS.dan), "prime_plus");
  assert.deepEqual((await getQuery("SELECT kind FROM premium_ledger WHERE ref LIKE 'stripe-conv:cs_dconv:%' ORDER BY kind")).map((x) => x.kind), ["upgrade-in", "upgrade-out"]);
  // the $0 trial invoice lands: same date, nothing over the cap
  assert.equal((await SB.handleEvent(invoice("dtrial", "sub_dplus", t + up.plusMs, meta))).outcome, "extended");
  // replayed: the conversion happens once
  assert.equal((await SB.handleEvent({ id: "evt_dconv", type: "checkout.session.completed", data: { object: {} } })).outcome, "dup");
});

test("the reverse: PAT buys, gifts and chip-ins are refused while a card pays; after the card is cancelled PAT adds on after its paid time", async () => {
  // bob's pad: card Prime Time paid through +30 days
  const end = t + 30 * DAY;
  await SB.handleEvent({ id: "evt_bc", type: "checkout.session.completed", created: 1, data: { object: { id: "cs_bc", mode: "subscription", subscription: "sub_bob",
    customer: "cus_b", metadata: { tier: "prime_time", target: PADS.bob, user_id: U.bob.userId } } } });
  await SB.handleEvent(invoice("bp1", "sub_bob", end, {}));
  const bal0 = (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [U.fan.userId]))[0].b;
  await assert.rejects(PR.buy(U.bob, { tier: "prime_time", pad: PADS.bob, months: 1, ref: ref() }), (e) => e.status === 409 && /paid by card/.test(e.message));
  await assert.rejects(PR.buy(U.fan, { tier: "prime_time", pad: PADS.bob, amount: 5000000, ref: ref() }), (e) => e.status === 409);
  await assert.rejects(PR.buy(U.bob, { tier: "prime_plus", pad: PADS.bob, months: 1, ref: ref() }), (e) => e.status === 409 && /upgrade/.test(e.message));
  assert.equal((await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [U.fan.userId]))[0].b, bal0, "no PAT moved");
  // a Season Pass by card: gifting one in PAT is refused too
  await SB.handleEvent({ id: "evt_fc", type: "checkout.session.completed", created: 1, data: { object: { id: "cs_fc", mode: "subscription", subscription: "sub_fan",
    customer: "cus_f", metadata: { tier: "season_pass", target: U.fan.userId, user_id: U.fan.userId } } } });
  await assert.rejects(PR.buy(U.ann, { tier: "season_pass", user: "fan", months: 1, ref: ref() }), (e) => e.status === 409);
  // cancelled: PAT is welcome again, and starts where the card's paid time ends
  await SB.handleEvent({ id: "evt_bdel", type: "customer.subscription.deleted", created: 1, data: { object: { id: "sub_bob", status: "canceled" } } });
  const r = await PR.buy(U.bob, { tier: "prime_time", pad: PADS.bob, months: 1, ref: ref() });
  assert.equal(r.paid_through, end + 30 * DAY);
  // the page: no PAT buttons while a card pays (a note instead)
  const ejs = fs.readFileSync(path.join(repo, "views", "premium.ejs"), "utf8");
  assert.equal((ejs.match(/premium\.card_paid_note/g) || []).length, 3, "Prime Time, Plus and Season Pass");
});

test("comps on a card-paid row: a timed comp past the card's date moves the next charge (trial_end), a shorter one changes nothing, no end pauses it, revoking resumes", async () => {
  // fan's card Season Pass, paid through +30 days
  const paid = t + 30 * DAY;
  await SB.handleEvent(invoice("fp1", "sub_fan", paid, {}));
  calls = [];
  let r = await PR.setComp("season_pass", U.fan.userId, true, "test", null, { until: t + 10 * DAY });
  assert.deepEqual(r.card, { ok: true, action: "none" });
  assert.equal(calls.length, 0);
  await PR.setComp("season_pass", U.fan.userId, false, "test");
  calls = [];
  r = await PR.setComp("season_pass", U.fan.userId, true, "test", null, { until: t + 60 * DAY });
  assert.equal(r.card.action, "deferred");
  const d = calls.find((c) => c.p === "/subscriptions/sub_fan");
  assert.equal(d.body.get("trial_end"), sec(t + 60 * DAY));
  assert.equal(d.body.get("proration_behavior"), "none");
  await PR.setComp("season_pass", U.fan.userId, false, "test");
  calls = [];
  r = await PR.setComp("season_pass", U.fan.userId, true, "test");
  assert.equal(r.card.action, "paused");
  assert.equal(calls[0].body.get("pause_collection[behavior]"), "void");
  // revoked: collection back on; the next charge is the card's paid date
  calls = [];
  r = await PR.setComp("season_pass", U.fan.userId, false, "test");
  assert.equal(r.card.action, "resumed");
  assert.equal(calls[0].body.get("pause_collection"), "");
  assert.equal(calls[0].body.get("trial_end"), sec(paid));
  assert.equal(PR.hasPass(U.fan.userId), true);
});

test("strings: the card-start note + confirm, in en.json and on the page", () => {
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  for (const k of ["premium.card_start", "premium.card_paid_note", "js.premium.q_card_start"]) assert.ok(en[k], k);
  assert.match(en["premium.card_start"], /\{covered\}.*\{first\}/);
  const ejs = fs.readFileSync(path.join(repo, "views", "premium.ejs"), "utf8");
  assert.equal((ejs.match(/data-first=/g) || []).length, 3);
  assert.match(ejs, /js\.premium\.q_card_start/);
});
