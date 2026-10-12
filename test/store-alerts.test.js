// Offline tests for 1.99tp: per-item purchase alerts for official store items (storealerts.js), through the real shop
// purchase path and routes (shop.register on a bare express app, temp DB). Nothing here depends on the time of day.
//   * one alert per purchase per recipient: inbox notice (kind store_purchase) + Telegram outbox row (when linked + ticked) +
//     a Camfrog PM action (when ticked); a retried hook / second call never alerts again
//   * a refused purchase and a refunded order send nothing
//   * anonymous gifts: "someone (anonymous gift)" to members, the real giver to admins
//   * the privacy checkbox: without it no buyer details and the link is the item page (the order page 404s for them); with it
//     the Camfrog login + what the buyer typed, the order link, and the order page opens (never what was delivered)
//   * the admin config: add by username or Camfrog login, update, remove, audit rows, staff only, official items only, overview
//   * an account merge carries (and folds) the recipient rows
//   NODE_PATH=G:/PATV/node_modules node --test test/store-alerts.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "storealerts-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;
delete process.env.MEDIACTL_URL;
process.env.SECRET_KEY = "test-secret";

const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const shop = require(path.join(repo, "shop"));
const SA = require(path.join(repo, "storealerts"));
const TG = require(path.join(repo, "telegram"));
const AM = require(path.join(repo, "accountMerge"));

const CARDS = "item-cards", OTHER = "item-other", LISTING = "item-listing";
let server, base;

async function mkUser(id, name, { cls = "pleb", bal = 100000000, camfrog = null } = {}) {
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername) VALUES (?, ?, ?, 'x', ?, ?, ?)",
                 [id, name, name, cls, bal, camfrog]);
}
const notices = (userId) => getQuery("SELECT * FROM inbox WHERE user_id = ? AND kind = 'store_purchase' ORDER BY id", [userId]);
const outbox = (userId) => getQuery("SELECT * FROM telegram_outbox WHERE user_id = ? AND kind = 'store_purchase' ORDER BY id", [userId]);
const pms = (userId) => getQuery("SELECT * FROM pepe_actions WHERE user_id = ? AND kind = 'notify'", [userId]);
const buy = async (userId, username, prizeId, extra = {}) => {
  const r = await shop.purchasePrize({ userId, username, prizeId, source: "website", ...extra });
  await shop.saleHooksIdle();
  return r;
};
const get = async (url, as) => {
  const r = await fetch(base + url, { headers: as ? { "x-test-user": as } : {}, redirect: "manual" });
  return { status: r.status, html: await r.text(), location: r.headers.get("location") };
};
const post = async (url, as, form) => {
  const r = await fetch(base + url, { method: "POST", redirect: "manual",
    headers: { "x-test-user": as, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
  return { status: r.status, location: decodeURIComponent(r.headers.get("location") || "") };
};
const ADMIN = { userId: "u-boss", username: "boss" };

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, extra_daily_spins INTEGER DEFAULT 0,
                  discordId TEXT, camfrogUsername TEXT, email TEXT, isEmailVerified INTEGER DEFAULT 0, avatar TEXT, created_at TEXT, xp INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE IF NOT EXISTS jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  await runQuery("CREATE TABLE IF NOT EXISTS user_roles (userId TEXT, role TEXT, source TEXT, PRIMARY KEY (userId, role))");
  await runQuery("CREATE TABLE IF NOT EXISTS dm_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (blocker_id, blocked_id))");
  await shop.ready;
  await SA.init();
  await TG.init();
  await mkUser("pb", "pb", { bal: 0 });
  await mkUser("u-boss", "boss", { cls: "Admin", bal: 0 });
  await mkUser("u-tricon", "LongNameOfTricon", { camfrog: "tricon", bal: 0 });     // the fulfiller (found by Camfrog login)
  await mkUser("u-watch", "watcher", { camfrog: "watchcf", bal: 0 });              // alerted, no details
  await mkUser("u-buyer", "buyer", { camfrog: "buyercf" });
  await mkUser("u-poor", "poor", { bal: 10 });
  await mkUser("u-giver", "giver");
  await mkUser("u-crush", "crush", { camfrog: "crushcf" });
  await mkUser("u-seller", "seller");
  await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity, status) VALUES (?, 'Random Pack of Pokemon Cards', 2000, 50, 'active')", [CARDS]);
  await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity, status) VALUES (?, 'Something else', 1000, 50, 'active')", [OTHER]);
  await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity, status, seller_id) VALUES (?, 'A listing', 1000, 5, 'active', 'u-seller')", [LISTING]);
  // tricon and the admin linked Telegram
  for (const [u, tg] of [["u-tricon", "111"], ["u-boss", "222"], ["u-watch", "333"]]) {
    await runQuery("INSERT INTO telegram_links (user_id, tg_id, linked_at) VALUES (?, ?, 1)", [u, tg]);
  }

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => { req.flash = () => []; next(); });
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  shop.register(app, { isBotToken: () => false, addUser, requireUser: (req, res, next) => (req.user ? next() : res.status(401).end()) });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { if (server) server.close(); });

test("admin config: staff add by username or Camfrog login, update, remove - audited; members and seller listings refused", async () => {
  // a member can't
  const no = await post(`/shop/admin/alerts/${CARDS}/add`, "u-buyer", { who: "watcher", back: `/shop/admin/edit/${CARDS}` });
  assert.match(no.location, /Admins only/);
  assert.equal((await SA.forItem(CARDS)).length, 0);
  // tricon by his Camfrog login (his PATV name is something else), as the fulfiller, Telegram + PM on
  const a = await post(`/shop/admin/alerts/${CARDS}/add`, "u-boss", { who: "tricon", tg: "1", pm: "1", details: "1", back: `/shop/admin/edit/${CARDS}` });
  assert.match(a.location, /LongNameOfTricon will be alerted/);
  assert.match(a.location, /#alerts$/);
  // the watcher by username: defaults from the form = Telegram on, no PM, no details
  await post(`/shop/admin/alerts/${CARDS}/add`, "u-boss", { who: "watcher", tg: "1" });
  // the admin on the item, without details
  await post(`/shop/admin/alerts/${CARDS}/add`, "u-boss", { who: "boss", tg: "1" });
  const rows = await SA.forItem(CARDS);
  assert.deepEqual(rows.map((r) => [r.username, r.tg, r.pm, r.details]),
                   [["LongNameOfTricon", true, true, true], ["watcher", true, false, false], ["boss", true, false, false]]);
  // update + remove (a temporary one on the other item)
  await post(`/shop/admin/alerts/${OTHER}/add`, "u-boss", { who: "crush" });
  await post(`/shop/admin/alerts/${OTHER}/update`, "u-boss", { userId: "u-crush", pm: "1" });
  assert.deepEqual((await SA.forItem(OTHER)).map((r) => [r.username, r.tg, r.pm, r.details]), [["crush", false, true, false]]);
  await post(`/shop/admin/alerts/${OTHER}/remove`, "u-boss", { userId: "u-crush" });
  assert.equal((await SA.forItem(OTHER)).length, 0);
  // never a member's listing; an unknown name is a clear refusal
  const l = await post(`/shop/admin/alerts/${LISTING}/add`, "u-boss", { who: "watcher" });
  assert.match(l.location, /isn't an official store item/);
  const x = await post(`/shop/admin/alerts/${CARDS}/add`, "u-boss", { who: "nobody-here" });
  assert.match(x.location, /no member called nobody-here/);
  // every change is in the admin audit log
  const au = await getQuery("SELECT action, target_name, detail FROM admin_audit WHERE action LIKE 'store_alert_%' ORDER BY id");
  assert.deepEqual(au.map((r) => [r.action, r.target_name]), [["store_alert_add", "LongNameOfTricon"], ["store_alert_add", "watcher"], ["store_alert_add", "boss"],
    ["store_alert_add", "crush"], ["store_alert_update", "crush"], ["store_alert_remove", "crush"]]);
  assert.equal(JSON.parse(au[0].detail).details, 1);
  // the pages: the edit page lists them, the shop admin overview too
  const ed = await get(`/shop/admin/edit/${CARDS}`, "u-boss");
  assert.equal(ed.status, 200);
  assert.match(ed.html, /id="alerts"/);
  assert.match(ed.html, /LongNameOfTricon/);
  assert.match(ed.html, /list="saPeople"/);
  const ad = await get("/shop/admin", "u-boss");
  assert.match(ad.html, /id="alerts"/);
  assert.match(ad.html, /<b>LongNameOfTricon<\/b> 📨✈️🐸📦/);
  assert.match(ad.html, /<b>watcher<\/b> 📨✈️ /);
  const le = await get(`/shop/admin/edit/${LISTING}`, "u-boss");
  assert.doesNotMatch(le.html, /id="alerts"/, "no alert section on a member's listing");
});

let orderId;
test("one alert per purchase per recipient, on every channel asked for; a retry never alerts again", async () => {
  const r = await buy("u-buyer", "buyer", CARDS);
  assert.equal(r.success, true, r.message);
  orderId = r.order_id;
  for (const u of ["u-tricon", "u-watch", "u-boss"]) assert.equal((await notices(u)).length, 1, u + " got one notice");
  assert.equal((await notices("u-buyer")).length, 0, "the buyer isn't alerted");
  // Telegram: everyone here linked it and has it ticked
  for (const u of ["u-tricon", "u-watch", "u-boss"]) assert.equal((await outbox(u)).length, 1, u + " one Telegram alert");
  // a Camfrog PM only for tricon (ticked), through Pepe's notify action
  assert.equal((await pms("u-tricon")).length, 1);
  assert.match(JSON.parse((await pms("u-tricon"))[0].args)[1], /buyer just bought Random Pack of Pokemon Cards/);
  assert.equal((await pms("u-watch")).length, 0);
  // retries: the hook again, and a direct call
  assert.equal(await SA.alertOrder(orderId), 0);
  assert.equal(await SA.alertOrder(orderId), 0);
  for (const u of ["u-tricon", "u-watch", "u-boss"]) {
    assert.equal((await notices(u)).length, 1, u + " still one notice");
    assert.equal((await outbox(u)).length, 1, u + " still one Telegram alert");
  }
  assert.equal((await pms("u-tricon")).length, 1);
  // a second purchase is a second alert
  const r2 = await buy("u-buyer", "buyer", CARDS);
  assert.equal(r2.success, true);
  assert.equal((await notices("u-watch")).length, 2);
  // another item doesn't alert them
  await buy("u-buyer", "buyer", OTHER);
  assert.equal((await notices("u-watch")).length, 2);
});

test("Telegram is per recipient and per kind: unticked or muted -> inbox only", async () => {
  await SA.setRecipient(ADMIN, CARDS, "update", { userId: "u-watch", tg: "" });
  await TG.setPrefs("u-boss", { store_purchase: false });                  // the admin muted the kind in their Telegram settings
  const r = await buy("u-buyer", "buyer", CARDS);
  assert.equal(r.success, true);
  const ws = await notices("u-watch");
  assert.equal(ws.length, 3);
  assert.equal((await outbox("u-watch")).length, 2, "no new Telegram row for the unticked recipient");
  assert.equal((await notices("u-boss")).length, 3);
  assert.equal((await outbox("u-boss")).length, 2, "muted kind: no Telegram");
  assert.equal((await outbox("u-tricon")).length, 3);
  await SA.setRecipient(ADMIN, CARDS, "update", { userId: "u-watch", tg: "1" });
  await TG.setPrefs("u-boss", { store_purchase: true });
});

test("a refused purchase and a refunded order send no alert", async () => {
  const before = (await notices("u-watch")).length;
  const r = await buy("u-poor", "poor", CARDS);
  assert.equal(r.success, false);
  assert.equal((await notices("u-watch")).length, before, "a failed purchase: nothing");
  // an order refunded before its alert went out (e.g. a service refund) is skipped
  const t = Date.now();
  const o = await runQuery(`INSERT INTO shop_orders (prize_id, buyer_id, seller_id, official, title, price, fee_pct, fee, net, seller_paid, status, source, created, updated)
                            VALUES (?, 'u-buyer', NULL, 1, 'Random Pack of Pokemon Cards', 2000, 0, 0, 2000, 1, 'refunded', 'website', ?, ?)`, [CARDS, t, t]);
  assert.equal(await SA.alertOrder(o.id), 0);
  assert.equal((await notices("u-watch")).length, before);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM store_alert_sent WHERE order_id = ?", [o.id]))[0].n, 0);
});

test("the privacy checkbox: details + the order page for the fulfiller only; others get the item and the buyer", async () => {
  await runQuery("UPDATE shop_orders SET buyer_input = 'ship to: 1 Frog Lane' WHERE id = ?", [orderId]);
  await runQuery("UPDATE shop_orders SET seller_note = 'DELIVERED-SECRET' WHERE id = ?", [orderId]);
  const o = (await getQuery(`SELECT o.*, b.username AS buyer_name, b.camfrogUsername AS buyer_camfrog FROM shop_orders o
                             LEFT JOIN users b ON b.userId = o.buyer_id WHERE o.id = ?`, [orderId]))[0];
  const t = (k, v) => require(path.join(repo, "gifts")).tFor("x")(k, v);
  const plain = SA.compose(o, { class: "pleb", details: 0 }, t);
  assert.match(plain.body, /Buyer: buyer/);
  assert.match(plain.body, /\/u\/buyer/, "the buyer's profile link");
  assert.match(plain.body, /Quantity: 1/);
  assert.match(plain.body, /When: \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
  assert.doesNotMatch(plain.body, /buyercf|Frog Lane|Order #/, "no details, no order for a plain recipient");
  assert.equal(plain.link, `/shop/item/${CARDS}`);
  const ful = SA.compose(o, { class: "pleb", details: 1 }, t);
  assert.match(ful.body, /Camfrog: buyercf/);
  assert.match(ful.body, /They wrote: ship to: 1 Frog Lane/);
  assert.match(ful.body, new RegExp(`Order #${orderId}`));
  assert.equal(ful.link, `/shop/orders/${orderId}`);
  const adm = SA.compose(o, { class: "Admin", details: 0 }, t);
  assert.equal(adm.link, `/shop/orders/${orderId}`, "an admin can open orders anyway");
  assert.doesNotMatch(adm.body, /buyercf|Frog Lane/, "but gets the details only with the box ticked");
  // the stored notices match
  const tn = (await notices("u-tricon"))[0], wn = (await notices("u-watch"))[0];
  assert.match(tn.body, /Camfrog: buyercf/);
  assert.equal(tn.link, `/shop/orders/${orderId}`);
  assert.doesNotMatch(wn.body, /buyercf/);
  assert.equal(wn.link, `/shop/item/${CARDS}`);
  assert.match((await outbox("u-tricon"))[0].text, /Camfrog: buyercf/);
  assert.doesNotMatch((await outbox("u-watch"))[0].text, /buyercf/);
  // the order page: the fulfiller opens it (details yes, what was delivered no); the plain recipient gets a 404
  const fp = await get(`/shop/orders/${orderId}`, "u-tricon");
  assert.equal(fp.status, 200);
  assert.match(fp.html, /1 Frog Lane/);
  assert.match(fp.html, /set as a fulfiller/);
  assert.doesNotMatch(fp.html, /DELIVERED-SECRET/);
  assert.equal((await get(`/shop/orders/${orderId}`, "u-watch")).status, 404);
  // un-ticking takes the access away
  await SA.setRecipient(ADMIN, CARDS, "update", { userId: "u-tricon", tg: "1", pm: "1", details: "" });
  assert.equal((await get(`/shop/orders/${orderId}`, "u-tricon")).status, 404);
  await SA.setRecipient(ADMIN, CARDS, "update", { userId: "u-tricon", tg: "1", pm: "1", details: "1" });
});

test("gifts: the giver is named; an anonymous gift says someone (anonymous gift) - except to an admin", async () => {
  const g = await buy("u-giver", "giver", CARDS, { giftTo: "crush" });
  assert.equal(g.success, true, g.message);
  const w = (await notices("u-watch")).pop();
  assert.match(w.body, /giver bought it as a gift for crush/);
  const an = await buy("u-giver", "giver", CARDS, { giftTo: "crush", giftAnon: "1" });
  assert.equal(an.success, true, an.message);
  for (const u of ["u-watch", "u-tricon"]) {
    const n = (await notices(u)).pop();
    assert.match(n.body, /Someone \(anonymous gift\) bought it for crush/);
    assert.doesNotMatch(`${n.title} ${n.body}`, /giver/, u + ": the anonymous giver is never named");
    const tg = (await outbox(u)).pop();
    assert.doesNotMatch(tg.text, /giver/);
  }
  const pm = JSON.parse((await pms("u-tricon")).pop().args)[1];
  assert.match(pm, /someone \(anonymous gift\) just bought/);
  assert.doesNotMatch(pm, /giver/);
  const b = (await notices("u-boss")).pop();
  assert.match(b.body, /giver bought it as a gift for crush \(an anonymous gift/, "admins see the real giver (the gift_log rule)");
  // the fulfiller's view of the order page masks the giver too
  const fp = await get(`/shop/orders/${an.order_id}`, "u-tricon");
  assert.equal(fp.status, 200);
  assert.doesNotMatch(fp.html, /giver/);
});

test("an account merge carries the recipient rows (and folds them when both were on the same item)", async () => {
  await mkUser("u-alt", "altacct");
  await mkUser("u-main", "mainacct");
  await SA.setRecipient(ADMIN, CARDS, "add", { who: "altacct", details: "1" });
  await SA.setRecipient(ADMIN, OTHER, "add", { who: "altacct", tg: "1" });
  await SA.setRecipient(ADMIN, CARDS, "add", { who: "mainacct", pm: "1" });
  await runQuery("INSERT INTO store_alert_sent (order_id, user_id, prize_id, at) VALUES (999, 'u-alt', ?, 1)", [CARDS]);
  const out = await AM.moveUserRows("u-alt", "u-main");
  assert.deepEqual(out.unclassified.filter((k) => k.startsWith("store_alert")), []);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM store_alerts WHERE user_id = 'u-alt'"))[0].n, 0);
  const rows = await getQuery("SELECT prize_id, tg, pm, details FROM store_alerts WHERE user_id = 'u-main' ORDER BY prize_id");
  assert.deepEqual(rows.map((r) => [r.prize_id, r.tg, r.pm, r.details]), [[CARDS, 0, 1, 1], [OTHER, 1, 0, 0]], "folded: any channel either had");
  assert.equal((await getQuery("SELECT user_id FROM store_alert_sent WHERE order_id = 999"))[0].user_id, "u-main");
  assert.ok(AM.classify("store_alerts", "user_id") && AM.classify("store_alerts", "added_by") && AM.classify("store_alert_sent", "user_id"));
});
