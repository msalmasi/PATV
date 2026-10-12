// Offline tests for 1.99th: 💎 Prime Time Plus by card (stripebilling.js) - the STRIPE_PRICE_PRIME_PLUS Price, the
// ptplus_max_rooms cap (sold out BEFORE Stripe, a held spot per open checkout, released on expiry / payment), a paid
// subscription honoured even over the cap (+ the admins' alert), the in-place upgrade of a card Prime Time (prorated
// subscription update) and the /subscriptions card rows. No network: the Stripe API is a mocked fetch.
//   NODE_PATH=G:/PATV/node_modules node --test test/stripe-plus.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stripe-plus-test-"));
process.chdir(tmp);
delete process.env.STAGING;
for (const k of ["STRIPE_ENABLED", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_PRIME_TIME", "STRIPE_PRICE_SEASON_PASS", "STRIPE_PRICE_PRIME_PLUS"]) delete process.env[k];
process.env.SECRET_KEY = "test-secret";
process.env.PAD_DIR = path.join(tmp, "pad");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const PR = require(path.join(repo, "premium"));
const SB = require(path.join(repo, "stripebilling"));
const SUBS = require(path.join(repo, "subscriptions"));

const DAY = 24 * 3600 * 1000;
const PADS = { ann: "plus_card_a", bob: "plus_card_b", cat: "plus_card_c", dan: "plus_card_d", eve: "plus_card_e" };
const U = {};
let t = Date.UTC(2026, 9, 12, 12);
PR._setClock(() => t);
SB._setClock(() => t);
SUBS._setClock(() => t);
let server, base;

function on({ plus = true } = {}) {
  process.env.STRIPE_ENABLED = "1";
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_fake";
  process.env.STRIPE_PRICE_PRIME_TIME = "price_prime_fake";
  process.env.STRIPE_PRICE_SEASON_PASS = "price_pass_fake";
  if (plus) process.env.STRIPE_PRICE_PRIME_PLUS = "price_plus_fake"; else delete process.env.STRIPE_PRICE_PRIME_PLUS;
}
// the mocked Stripe API: every call is recorded; responses by path
let calls = [];
let nextSub = null;           // what the subscription update answers
let expireFails = null;       // session id whose /expire is refused, and the status a GET then reports
let n = 0;
function stripe() {
  calls = [];
  SB._setFetch(async (url, opts) => {
    const p = url.replace("https://api.stripe.com/v1", "");
    const body = opts.body ? new URLSearchParams(opts.body) : null;
    calls.push({ p, method: opts.method, body });
    const ok = (j) => ({ ok: true, json: async () => j });
    if (p === "/checkout/sessions" && opts.method === "POST") { n++; return ok({ id: "cs_test_" + n, url: "https://checkout.stripe.com/c/pay/cs_test_" + n }); }
    const ex = p.match(/^\/checkout\/sessions\/([^/]+)\/expire$/);
    if (ex) {
      if (expireFails && expireFails.id === ex[1]) return { ok: false, json: async () => ({ error: { message: "Only Checkout Sessions with a status of open can be expired." } }) };
      return ok({ id: ex[1], status: "expired" });
    }
    const gs = p.match(/^\/checkout\/sessions\/([^/]+)$/);
    if (gs) return ok({ id: gs[1], status: expireFails && expireFails.id === gs[1] ? expireFails.status : "expired" });
    const sub = p.match(/^\/subscriptions\/([^/]+)$/);
    if (sub && opts.method === "GET") return ok({ id: sub[1], status: "active", items: { data: [{ id: "si_" + sub[1], price: { id: "price_prime_fake" } }] } });
    if (sub) return ok(body && body.get("metadata[tier]") ? { id: sub[1] } : (nextSub || { id: sub[1], status: "active", pending_update: null }));
    return { ok: false, json: async () => ({ error: { message: "unexpected " + p } }) };
  });
}
const holds = () => getQuery("SELECT * FROM premium_plus_holds ORDER BY created, id");
const invoice = (id, sub, end, meta) => ({ id: "evt_" + id, type: "invoice.paid", created: 1, data: { object: { id: "in_" + id, object: "invoice", subscription: sub, customer: "cus_" + id,
  currency: "usd", amount_paid: 10000, subscription_details: { metadata: meta || {} }, lines: { data: [{ period: { start: end / 1000 - 30 * 86400, end: end / 1000 } }] } } } });
const completed = (id, sessionId, sub, meta) => ({ id: "evt_" + id, type: "checkout.session.completed", created: 1,
  data: { object: { id: sessionId, mode: "subscription", subscription: sub, customer: "cus_" + id, metadata: meta } } });
const metaOf = (call) => ({ tier: call.body.get("metadata[tier]"), target: call.body.get("metadata[target]"), user_id: call.body.get("metadata[user_id]"), hold: call.body.get("metadata[hold]") });

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery("CREATE TABLE prizes (prizeId TEXT PRIMARY KEY, prize TEXT, cost INTEGER, quantity INTEGER, status TEXT, seller_id TEXT)");   // /subscriptions' shop offers
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  for (const name of [...Object.keys(PADS), "boss"]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance) VALUES (?, ?, ?, 'x', ?, 200000000)",
                   ["u-" + name, name, name, name === "boss" ? "Admin" : "pleb"]);
    U[name] = { userId: "u-" + name, username: name, class: name === "boss" ? "Admin" : "pleb" };
  }
  await rooms.init();
  for (const [who, id] of Object.entries(PADS)) { await rooms.addRoom(id, null, "test"); await rooms.setOwner(id, who, "test"); }
  await SB.init();
  await PR.setConfig({ comp_admins: false, ptplus_max_rooms: 2 }, "test");
  const app = express();
  app.use((req, res, next) => (req.path === "/api/premium/stripe/webhook" ? next() : express.json()(req, res, next)));
  const addUser = (rq, rs, next) => { const u = rq.get("x-test-user"); rq.user = u ? U[u] || null : null; next(); };
  SB.register(app, { addUser });
  app.use((req, res) => res.status(404).send("not found"));
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { if (server) server.close(); SB._setFetch(null); delete process.env.STRIPE_ENABLED; });
function post(url, user, body) {
  return new Promise((resolve, reject) => {
    const s = JSON.stringify(body || {});
    const r = http.request(base + url, { method: "POST", headers: { Origin: base, "x-test-user": user, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) } }, (res) => {
      const c = []; res.on("data", (x) => c.push(x));
      res.on("end", () => { const txt = Buffer.concat(c).toString("utf8"); let j = null; try { j = JSON.parse(txt); } catch (e) { j = null; } resolve({ status: res.statusCode, json: j, text: txt }); });
    });
    r.on("error", reject); r.write(s); r.end();
  });
}

test("the Plus price is optional: no STRIPE_PRICE_PRIME_PLUS -> tiers.prime_plus false and checkout refuses (423)", async () => {
  on({ plus: false });
  stripe();
  assert.equal(SB.publicState().tiers.prime_plus, false);
  await assert.rejects(SB.checkout(U.ann, { tier: "prime_plus", pad: PADS.ann }), (e) => e.status === 423);
  assert.equal(calls.length, 0);
  on();
  assert.deepEqual(SB.publicState(), { enabled: true, test: true, tiers: { prime_time: true, season_pass: true, prime_plus: true } });
});

test("checkout: the Plus Price, the tier/target/hold metadata, a 31-minute session and a held spot; only the owner", async () => {
  on(); stripe();
  const r = await SB.checkout(U.ann, { tier: "prime_plus", pad: PADS.ann });
  assert.match(r.url, /^https:\/\/checkout\.stripe\.com\//);
  const c = calls.find((x) => x.p === "/checkout/sessions");
  assert.equal(c.body.get("mode"), "subscription");
  assert.equal(c.body.get("line_items[0][price]"), "price_plus_fake");
  assert.equal(Number(c.body.get("expires_at")), Math.floor(t / 1000) + 31 * 60, "Stripe's minimum is 30 minutes");
  const m = metaOf(c);
  assert.deepEqual([m.tier, m.target, m.user_id], ["prime_plus", PADS.ann, U.ann.userId]);
  assert.match(m.hold, /^hold_/);
  assert.equal(c.body.get("subscription_data[metadata][hold]"), m.hold);
  assert.match(c.body.get("success_url"), /\/premium\?pad=plus.card.a&stripe=success#plus$/);
  const h = await holds();
  assert.deepEqual(h.map((x) => [x.id, x.target, x.session, x.expires - t]), [[m.hold, PADS.ann, r.id, SB.HOLD_MS]]);
  // the page: the held spot counts for everyone else, not for ann's own pad
  assert.deepEqual(PR.plusSpots(t), { used: 0, held: 1, max: 2, left: 1, soldOut: false });
  assert.equal(PR.plusSpots(t, PADS.ann).held, 0);
  // someone else's pad: refused
  await assert.rejects(SB.checkout(U.bob, { tier: "prime_plus", pad: PADS.ann }), (e) => e.status === 403);
});

test("the cap: two open checkouts take both spots; a third is SOLD OUT before Stripe is called; PAT buys and comps respect the holds", async () => {
  on(); stripe();
  await SB.checkout(U.bob, { tier: "prime_plus", pad: PADS.bob });
  assert.equal((await holds()).length, 2);
  calls = [];
  await assert.rejects(SB.checkout(U.cat, { tier: "prime_plus", pad: PADS.cat }), (e) => e.status === 409 && e.soldOut === true && /sold out/i.test(e.message));
  assert.equal(calls.length, 0, "never sent to Stripe");
  const r = await post("/api/premium/stripe/checkout", "cat", { tier: "prime_plus", pad: PADS.cat });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /sold out/i);
  await assert.rejects(PR.buy(U.cat, { tier: "prime_plus", pad: PADS.cat, months: 1, ref: "rcatbuy01" }), (e) => e.status === 409 && e.soldOut);
  await assert.rejects(PR.setComp("prime_plus", PADS.cat, true, "test"), (e) => e.status === 409);
  assert.equal(PR.plusSpots(t).soldOut, true);
});

test("a pad's second checkout replaces its first (the old session is expired at Stripe); one that can't be expired is refused", async () => {
  on(); stripe();
  const before = (await holds()).find((h) => h.target === PADS.bob);
  await SB.checkout(U.bob, { tier: "prime_plus", pad: PADS.bob });
  assert.ok(calls.some((c) => c.p === `/checkout/sessions/${before.session}/expire`), "the old session closed first");
  const now = (await holds()).filter((h) => h.target === PADS.bob);
  assert.equal(now.length, 1);
  assert.notEqual(now[0].session, before.session);
  // the old session was just paid (can't be expired): refuse, keep no new hold
  expireFails = { id: now[0].session, status: "complete" };
  try {
    stripe();
    await assert.rejects(SB.checkout(U.bob, { tier: "prime_plus", pad: PADS.bob }), (e) => e.status === 409 && /going through/.test(e.message));
    assert.equal(calls.filter((c) => c.p === "/checkout/sessions").length, 0);
    assert.equal((await holds()).filter((h) => h.target === PADS.bob).length, 0);
  } finally { expireFails = null; }
  // a Stripe failure releases the hold too
  SB._setFetch(async () => ({ ok: false, json: async () => ({ error: { message: "boom" } }) }));
  await assert.rejects(SB.checkout(U.bob, { tier: "prime_plus", pad: PADS.bob }), (e) => e.status === 502);
  assert.equal((await holds()).filter((h) => h.target === PADS.bob).length, 0);
});

test("holds end: checkout.session.expired frees the spot; an abandoned one frees itself after HOLD_MS", async () => {
  on(); stripe();
  await PR.loadCache();
  // ann's hold (from the first checkout) + nobody else's: cat can check out now
  const r = await SB.checkout(U.cat, { tier: "prime_plus", pad: PADS.cat });
  const catHold = (await holds()).find((h) => h.target === PADS.cat);
  assert.equal(catHold.session, r.id);
  const e = await SB.handleEvent({ id: "evt_exp1", type: "checkout.session.expired", created: 1, data: { object: { id: r.id, metadata: { tier: "prime_plus", target: PADS.cat, hold: catHold.id } } } });
  assert.equal(e.outcome, "hold-released");
  assert.equal((await holds()).filter((h) => h.target === PADS.cat).length, 0);
  // abandoned: ann's hold is past its time -> the cap no longer counts it
  const save = t;
  t += SB.HOLD_MS + 1000;
  try {
    await PR.loadCache();
    assert.equal(PR.plusSpots(t).held, 0);
    stripe();
    await SB.checkout(U.dan, { tier: "prime_plus", pad: PADS.dan });
    await SB.checkout(U.cat, { tier: "prime_plus", pad: PADS.cat });
    assert.deepEqual((await holds()).map((h) => h.target).sort(), [PADS.cat, PADS.dan], "the expired hold was swept");
  } finally { t = save; }
  await runQuery("DELETE FROM premium_plus_holds");
  await PR.loadCache();
});

test("paid: completed keeps the spot held, the first invoice makes the pad Plus (held -> used), renewals extend, cancel lapses after the period", async () => {
  on(); stripe();
  await SB.checkout(U.dan, { tier: "prime_plus", pad: PADS.dan });
  const c = calls.find((x) => x.p === "/checkout/sessions");
  const meta = metaOf(c);
  const done = await SB.handleEvent(completed("dc1", "cs_paid_dan", "sub_dan", meta));
  assert.equal(done.outcome, "linked");
  const h = (await holds()).find((x) => x.target === PADS.dan);
  assert.ok(h.expires >= t + 23 * 3600 * 1000, "held until the invoice lands");
  assert.equal(PR.isPrimePlus(PADS.dan), false, "linked, nothing paid yet");
  const end = t + 30 * DAY;
  const p = await SB.handleEvent(invoice("dp1", "sub_dan", end, meta));
  assert.equal(p.outcome, "extended");
  assert.equal(PR.isPrimePlus(PADS.dan), true);
  assert.equal(PR.isPrime(PADS.dan), true);
  assert.equal((await holds()).filter((x) => x.target === PADS.dan).length, 0, "the hold became a used spot");
  assert.deepEqual(PR.plusSpots(t), { used: 1, held: 0, max: 2, left: 1, soldOut: false });
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM transactions WHERE userId = ?", [U.dan.userId]))[0].n, 0, "real money: no PAT moves");
  // renewal (looked up by the subscription id)
  const p2 = await SB.handleEvent(invoice("dp2", "sub_dan", end + 30 * DAY, {}));
  assert.equal(p2.outcome, "extended");
  assert.equal((await PR.subRow("prime_plus", PADS.dan)).stripe_through, end + 30 * DAY);
  // renewals of a Plus pad never need a spot, even when the cap is full
  await PR.setConfig({ ptplus_max_rooms: 1 }, "test");
  try {
    const p3 = await SB.handleEvent(invoice("dp3", "sub_dan", end + 60 * DAY, {}));
    assert.equal(p3.outcome, "extended");
  } finally { await PR.setConfig({ ptplus_max_rooms: 2 }, "test"); }
  // the portal works for Plus
  stripe();
  calls = [];
  SB._setFetch(async (url, opts) => { calls.push({ p: url, body: new URLSearchParams(opts.body) }); return { ok: true, json: async () => ({ url: "https://billing.stripe.com/p/session/x" }) }; });
  const pt = await SB.portal(U.dan, { tier: "prime_plus", pad: PADS.dan });
  assert.equal(pt.url, "https://billing.stripe.com/p/session/x");
  assert.equal(calls[0].body.get("customer"), "cus_dc1");
  // cancelled: unlinked, the paid period runs out, then no grace
  const d = await SB.handleEvent({ id: "evt_dd1", type: "customer.subscription.deleted", created: 1, data: { object: { id: "sub_dan", status: "canceled" } } });
  assert.equal(d.outcome, "unlinked");
  assert.equal(PR.isPrimePlus(PADS.dan), true);
  const save = t; t = end + 60 * DAY + 1000;
  try { assert.equal(PR.isPrimePlus(PADS.dan), false); } finally { t = save; }
});

test("a race over the cap: the paid subscription is HONOURED and every admin is alerted", async () => {
  on();
  // dan uses spot 1; eve takes spot 2 with PAT; then cat's card invoice lands (its checkout started before the cap filled)
  await PR.buy(U.eve, { tier: "prime_plus", pad: PADS.eve, months: 1, ref: "revebuy01" });
  assert.equal(PR.plusSpots(t).soldOut, true);
  const meta = { tier: "prime_plus", target: PADS.cat, user_id: U.cat.userId };
  const r = await SB.handleEvent(invoice("race1", "sub_cat", t + 30 * DAY, meta));
  assert.equal(r.outcome, "extended-over-cap");
  assert.equal(PR.isPrimePlus(PADS.cat), true, "a paying customer is never refused");
  assert.equal(PR.plusSpots(t).used, 3);
  const alerts = await getQuery("SELECT user_id, title, body FROM inbox WHERE title LIKE '%over its%cap%'");
  assert.deepEqual(alerts.map((a) => a.user_id), [U.boss.userId]);
  assert.match(alerts[0].body, /p\/plus.card.c/);
  // the same invoice again: nothing more
  assert.equal((await SB.handleEvent(invoice("race1", "sub_cat", t + 30 * DAY, meta))).outcome, "dup");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE title LIKE '%over its%cap%'"))[0].n, 1);
});

test("upgrade: a card Prime Time switches its Stripe subscription to the Plus price with proration; the mapping moves to the Plus row", async () => {
  on();
  await PR.setConfig({ ptplus_max_rooms: 10 }, "test");
  const end = t + 20 * DAY;
  const meta = { tier: "prime_time", target: PADS.bob, user_id: U.bob.userId };
  assert.equal((await SB.handleEvent(invoice("bpt1", "sub_bob", end, meta))).outcome, "extended");
  await runQuery("UPDATE premium_subs SET stripe_user = ? WHERE stripe_sub = 'sub_bob'", [U.bob.userId]);
  assert.equal(PR.padTier(PADS.bob), "prime_time");
  // a NEW Plus card subscription on top is refused - upgrade instead
  stripe();
  await assert.rejects(SB.checkout(U.bob, { tier: "prime_plus", pad: PADS.bob }), (e) => e.status === 409 && /upgrade/i.test(e.message));
  // only the card's owner
  await assert.rejects(SB.upgrade(U.ann, { pad: PADS.bob }), (e) => e.status === 403);
  stripe();
  const r = await post("/api/premium/stripe/upgrade", "bob", { pad: PADS.bob });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.json.pending, r.json.upgraded], [false, true]);
  const upd = calls.find((c) => c.p === "/subscriptions/sub_bob" && c.method === "POST" && c.body.get("items[0][price]"));
  assert.equal(upd.body.get("items[0][id]"), "si_sub_bob");
  assert.equal(upd.body.get("items[0][price]"), "price_plus_fake");
  assert.equal(upd.body.get("proration_behavior"), "always_invoice");
  assert.equal(upd.body.get("payment_behavior"), "pending_if_incomplete");
  const tag = calls.find((c) => c.p === "/subscriptions/sub_bob" && c.body && c.body.get("metadata[tier]"));
  assert.equal(tag.body.get("metadata[tier]"), "prime_plus");
  const pp = await PR.subRow("prime_plus", PADS.bob), pt = await PR.subRow("prime_time", PADS.bob);
  assert.deepEqual([pp.stripe_sub, pp.stripe_user, pp.stripe_through], ["sub_bob", U.bob.userId, end]);
  assert.deepEqual([pt.stripe_sub, pt.stripe_through], [null, t]);
  assert.equal(PR.padTier(PADS.bob), "prime_plus");
  assert.deepEqual((await getQuery("SELECT kind FROM premium_ledger WHERE ref LIKE 'stripe-up:sub_bob:%' ORDER BY kind")).map((x) => x.kind), ["upgrade-in", "upgrade-out"]);
  assert.equal((await holds()).filter((h) => h.target === PADS.bob).length, 0);
  // the next renewal invoice extends Plus
  assert.equal((await SB.handleEvent(invoice("bpp2", "sub_bob", end + 30 * DAY, {}))).outcome, "extended");
  assert.equal((await PR.subRow("prime_plus", PADS.bob)).stripe_through, end + 30 * DAY);
  assert.equal((await PR.subRow("prime_time", PADS.bob)).stripe_through, t);
});

test("upgrade with a pending proration payment: nothing moves until customer.subscription.updated says it went through; sold out refuses", async () => {
  on();
  const end = t + 10 * DAY;
  await SB.handleEvent(invoice("apt1", "sub_ann", end, { tier: "prime_time", target: PADS.ann, user_id: U.ann.userId }));
  await runQuery("UPDATE premium_subs SET stripe_user = ? WHERE stripe_sub = 'sub_ann'", [U.ann.userId]);
  // full: refused before Stripe is touched
  await PR.setConfig({ ptplus_max_rooms: 4 }, "test");          // dan(lapsed? no: paid) + cat + eve + bob = 4
  stripe();
  await assert.rejects(SB.upgrade(U.ann, { pad: PADS.ann }), (e) => e.status === 409 && e.soldOut);
  assert.equal(calls.length, 0);
  await PR.setConfig({ ptplus_max_rooms: 10 }, "test");
  stripe();
  nextSub = { id: "sub_ann", status: "active", pending_update: { expires_at: 1 } };
  try {
    const r = await SB.upgrade(U.ann, { pad: PADS.ann });
    assert.deepEqual(r, { pending: true });
  } finally { nextSub = null; }
  assert.equal(PR.padTier(PADS.ann), "prime_time");
  assert.equal((await holds()).filter((h) => h.target === PADS.ann).length, 1, "the spot is held while Stripe confirms");
  // still pending: an update event with pending_update changes nothing
  const ev = (id, o) => ({ id, type: "customer.subscription.updated", created: 1, data: { object: Object.assign({ id: "sub_ann", object: "subscription", status: "active",
    items: { data: [{ id: "si_sub_ann", price: { id: "price_plus_fake" } }] }, metadata: { tier: "prime_time", target: PADS.ann, user_id: U.ann.userId } }, o) } });
  assert.equal((await SB.handleEvent(ev("evt_au0", { pending_update: { expires_at: 1 } }))).outcome, "ignored");
  stripe();
  const r = await SB.handleEvent(ev("evt_au1", { pending_update: null }));
  assert.equal(r.outcome, "upgraded");
  assert.equal(PR.padTier(PADS.ann), "prime_plus");
  assert.equal((await PR.subRow("prime_plus", PADS.ann)).stripe_through, end);
  assert.ok(calls.some((c) => c.body && c.body.get("metadata[tier]") === "prime_plus"), "the subscription's metadata now says Plus");
  assert.equal((await holds()).filter((h) => h.target === PADS.ann).length, 0);
  // replayed / a later update: nothing more
  assert.equal((await SB.handleEvent(ev("evt_au1", {}))).outcome, "dup");
  assert.equal((await SB.handleEvent(ev("evt_au2", {}))).outcome, "ignored");
  // a card Prime Time checkout on a Plus pad is refused
  await assert.rejects(SB.checkout(U.ann, { tier: "prime_time", pad: PADS.ann }), (e) => e.status === 409);
});

test("/subscriptions lists card subscriptions with Stripe's portal (not the PAT auto-renew switch); /premium shows the Plus card button", async () => {
  const d = await SUBS.pageData(U.bob);
  const row = d.premium.find((p) => p.tier === "prime_plus");
  assert.ok(row, JSON.stringify(d.premium));
  assert.deepEqual([row.card, row.pad, row.status], [true, "plus-card-b", "active"]);
  const ejs = fs.readFileSync(path.join(repo, "views", "subscriptions.ejs"), "utf8");
  assert.match(ejs, /data-portal="<%= p\.tier %>"/);
  assert.match(fs.readFileSync(path.join(repo, "public", "js", "subscriptions.js"), "utf8"), /\/api\/premium\/stripe\/portal/);
  const prem = fs.readFileSync(path.join(repo, "views", "premium.ejs"), "utf8");
  assert.match(prem, /ST\.tiers\.prime_plus && PAD\.mine/);
  assert.match(prem, /data-card="prime_plus"/);
  assert.match(prem, /data-portal="prime_plus"/);
  assert.match(prem, /data-card-upgrade/);
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  for (const k of ["premium.pp.card_upgrade", "premium.pp.card_upgrade_note", "subs.card_monthly", "subs.card_renews", "js.premium.q_card_upgrade", "js.premium.upgrade_pending", "js.premium.card_upgraded"]) assert.ok(en[k], k);
  assert.match(fs.readFileSync(path.join(repo, ".env.example"), "utf8"), /^STRIPE_PRICE_PRIME_PLUS=price_REPLACE_ME$/m);
});
