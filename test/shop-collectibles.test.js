// Offline tests for 1.99ans: the 21 official prize-shop items with a real-world value are VIRTUAL IN-GAME COLLECTIBLES
// (NY S5935-A, owner 2026-11-11):
//   * the catalogue: exactly those 21 are delivery "collectible", none is "staff"; names, descriptions and en.json lines say
//     what they are (virtual, no cash value; the memberships are not memberships, the gift card is not a gift card, the
//     joke items are jokes); the pictures stay; the gaming PC stays featured
//   * the startup migration: renames + describes exactly those official rows, puts back on sale exactly the rows the
//     compliance pause took off (status paused + review_note '2026-11-11 compliance...'), never another row, a member
//     listing, a price, stock or sold count; idempotent (marker + conditional statements; an admin rename after it sticks)
//   * a collectible order completes at once and is the record of ownership: no staff "Purchase Notification" email, no
//     raffle-delivery email, no store_alerts (the vendor never hears), no fulfiller access; gifts, comps and raffle wins too
//   * the pages say "virtual in-game collectible"; /api/prizes carries the delivery
//   NODE_PATH=G:/PATV/node_modules TZ=UTC node --test test/shop-collectibles.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ejs = require("ejs");
const express = require("express");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shopcollect-test-"));
process.chdir(tmp);
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;
process.env.STORE_NOTIFY_EMAIL = "store@example.test";

const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const shop = require(path.join(repo, "shop"));
const CAT = require(path.join(repo, "shopcatalog"));
const SA = require(path.join(repo, "storealerts"));
const EN = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));

// the 21 prizeIds the owner's compliance pause took off sale (scratchpad nysweeps/ids.txt)
const IDS21 = ["71cf8e5a-5d78-46fe-be71-0abf258a6a82", "0a44cc26-98f0-4778-aa67-5bfaf59ee262", "fbcbfa46-b9a3-401e-a6a8-4640f26047f5",
  "63f13c8b-9339-4895-b92c-eeefb8949f60", "cf681df9-ed2d-409f-9ffc-b2d8b63e4ca3", "54c8df0e-1a1f-45c0-8623-046b157da033",
  "178a838b-df7f-42b7-aef4-915d6a8a5c4a", "4b0c7b3c-61f5-4294-a4a4-b932f8977670", "9c0aa228-e0c4-46dd-97cc-dc41a245bc05",
  "741fa7e3-5804-454f-a064-c5b537fb782a", "35433a15-f2d4-4b43-b886-3bdb1686e8b2", "1289bc9c-4c1f-4f02-b61f-354d4c51ff0b",
  "5509b71a-e671-4004-8932-fc82059ace41", "0c920cd9-564a-4338-8716-3f4b0250af57", "37e6ceed-781c-46b6-8644-c134e53338f4",
  "02072b01-5ae0-4e4b-ae64-a033a0dc04ea", "e2626ad3-82b9-42c3-9ed1-5d6c22e1c6e5", "6ba29deb-fe99-43c5-82a9-8fa0a155bf2f",
  "532f7e83-5d6a-4e3f-b876-24019d66452f", "e9c179b4-ee7c-4dcc-b087-dccca9df4725", "769d3a54-0ac6-4dbe-873f-c325e77137ec"];
const PC = "35433a15-f2d4-4b43-b886-3bdb1686e8b2";
const CARDS = "0c920cd9-564a-4338-8716-3f4b0250af57";
const GIFT_CARD = "37e6ceed-781c-46b6-8644-c134e53338f4";
const NITRO = "178a838b-df7f-42b7-aef4-915d6a8a5c4a";
const RING = "e2626ad3-82b9-42c3-9ed1-5d6c22e1c6e5";
const PLEX_1M = "1c120384-c080-4186-b246-f1227e82ab01";
const HIGH_ROLLER = "491cde2e-097e-4c2a-a351-ce441137ba38";
const NOTE = "2026-11-11 compliance (NY S5935-A): off sale until it is a virtual in-game collectible";

const mails = [];
let n = 0;
async function mkUser(bal = 0, extra = {}) {
  const id = "sc" + (++n);
  await runQuery("INSERT INTO users (userId, username, password, points_balance, level, camfrogUsername, class, email) VALUES (?, ?, 'x', ?, 5, ?, ?, ?)",
                 [id, extra.username || "collector" + n, bal, extra.camfrog || null, extra.cls || "pleb", extra.email || null]);
  return { userId: id, username: extra.username || "collector" + n };
}
const row = async (id) => (await getQuery("SELECT prizeId, prize, description, cost, quantity, sold, status, review_note, seller_id FROM prizes WHERE prizeId = ?", [id]))[0];
const storeMails = () => mails.filter((m) => m.to === "store@example.test");

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, extra_daily_spins INTEGER DEFAULT 0,
                  discordId TEXT, camfrogUsername TEXT, email TEXT, isEmailVerified INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE IF NOT EXISTS jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  await runQuery("CREATE TABLE IF NOT EXISTS user_roles (userId TEXT, role TEXT, source TEXT, granted_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (userId, role))");
  await shop.ready;
  await SA.init();
  shop._setMailer((m) => { mails.push(m); return true; });
  await mkUser(0, { username: "pb" });
});
test.after(() => shop._setMailer(null));

// ── the catalogue ──
test("catalogue: exactly the 21 real-world items are virtual collectibles; nothing is 'staff'; the art stays; the PC stays featured", () => {
  const coll = Object.entries(CAT.ITEMS).filter(([, v]) => v.delivery === "collectible").map(([id]) => id).sort();
  assert.deepEqual(coll, IDS21.slice().sort());
  assert.deepEqual(Object.keys(CAT.COLLECTIBLES).sort(), IDS21.slice().sort());
  assert.ok(!Object.values(CAT.ITEMS).some((v) => v.delivery === "staff"), "no catalogue item is delivered by hand any more");
  for (const id of IDS21) {
    assert.ok(fs.existsSync(path.join(repo, "public", "img", "shop", CAT.ITEMS[id].key + ".svg")), "keeps its picture: " + id);
    assert.equal(CAT.info({ prizeId: id }).delivery, "collectible");
    assert.equal(CAT.isCollectible({ prizeId: id }), true);
  }
  assert.equal(CAT.isCollectible({ prizeId: PC, seller_id: "someone" }), false, "a member's listing is never one");
  assert.equal(CAT.isCollectible({ prizeId: PLEX_1M }), false);
  assert.equal(CAT.FEATURED[0], PC, "the gaming PC is still the top pick");
  assert.equal(CAT.ITEMS[PC].delivery, "collectible");
});

test("catalogue copy: virtual, no cash value; memberships aren't memberships, the gift card isn't one, the joke items are jokes", () => {
  for (const id of IDS21) {
    const c = CAT.COLLECTIBLES[id];
    assert.match(c.name, /virtual collectible/, c.name);
    assert.ok(c.name.length <= 120, "fits an order title: " + c.name);
    assert.match(c.description, /virtual/i);
    assert.match(c.description, /no cash value/);
    assert.match(c.description, /Nothing is shipped/);
    const line = EN["shop.cat.item." + CAT.tkey(CAT.ITEMS[id].key)];
    assert.match(line, /virtual (in-game )?collectible/, id);
    assert.match(line, /no cash value/, id);
    assert.doesNotMatch(line + c.name + c.description, /deliver(ed|s)? (to|by hand)|on your Camfrog account\.$|real prize/i);
  }
  for (const id of IDS21.slice(0, 8)) {
    const what = id === NITRO || id === "4b0c7b3c-61f5-4294-a4a4-b932f8977670" ? "Discord Nitro" : "Camfrog";
    assert.match(EN["shop.cat.item." + CAT.tkey(CAT.ITEMS[id].key)], new RegExp(`It is not a ${what} membership`));
    assert.match(CAT.COLLECTIBLES[id].name, /not a membership/);
    assert.match(CAT.COLLECTIBLES[id].description, new RegExp(`NOT a ${what} membership`));
  }
  assert.match(EN["shop.cat.item.gift_card"], /It is NOT a gift card/);
  assert.match(EN["shop.cat.item.gift_card"], /can’t be redeemed at chaosuk\.shop or anywhere else/);
  assert.match(CAT.COLLECTIBLES[GIFT_CARD].name, /not a gift card/);
  assert.match(CAT.COLLECTIBLES[GIFT_CARD].description, /NOT a gift card.*can't be redeemed/);
  for (const k of ["probation", "pizza_for_blake"]) assert.match(EN["shop.cat.item." + k], /^A joke virtual collectible/);
  for (const id of ["e9c179b4-ee7c-4dcc-b087-dccca9df4725", "769d3a54-0ac6-4dbe-873f-c325e77137ec"]) {
    assert.match(CAT.COLLECTIBLES[id].name, /joke virtual collectible/);
    assert.match(CAT.COLLECTIBLES[id].description, /^A joke virtual collectible/);
  }
  assert.match(EN["shop.deliver.collectible"], /virtual in-game collectible/);
  assert.match(EN["shop.orders.deliv_collectible"], /^A virtual in-game collectible - it’s yours on PATV now\. Nothing is shipped; it has no cash value\.$/);
  assert.match(shop.COLLECTIBLE_NOTE, /^A virtual in-game collectible - it's yours on PATV now\. Nothing is shipped; it has no cash value\.$/);
  assert.doesNotMatch(EN["shop.hero.lead"] + EN["shop.orders.empty.all.p"] + EN["shop.deliver.staff"], /real|by hand|Camfrog memberships/);
});

// ── the migration ──
async function seed() {
  await runQuery("DELETE FROM prizes");
  await runQuery("DELETE FROM shop_settings WHERE key = ?", [shop.COLLECTIBLES_KEY]);
  let i = 0;
  for (const id of IDS21) {
    i++;
    // most are paused by the compliance pause; the card pack was paused for another reason; the ring is still active
    const status = id === CARDS ? "paused" : id === RING ? "active" : "paused";
    const note = id === CARDS ? "2026-11-01 restock: waiting on Tricon" : id === RING ? null : NOTE;
    await runQuery(`INSERT INTO prizes (prizeId, prize, cost, quantity, status, review_note, sold, description, image_url, category)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Gift cards')`,
                   [id, "Old name " + i, 1000 * i, i % 4, status, note, i, "We ship it to your door.", CAT.artPath(CAT.ITEMS[id].key)]);
  }
  // not one of the 21, paused with the same note: stays paused (the owner's pause, or someone's, of something else)
  await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity, status, review_note) VALUES (?, 'Plex Invite 1 Month Access', 500, 4, 'paused', ?)", [PLEX_1M, NOTE]);
  // a member's listing with one of the 21's ids can't exist (PK), but a listing that LOOKS like one, paused the same way, stays put
  await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity, status, review_note, seller_id) VALUES ('lst-ring', 'Plain pure silver band', 50000000, 1, 'paused', ?, 'sc-seller')", [NOTE]);
}

test("migration: renames + describes the 21, puts back on sale only the compliance-paused ones, nothing else changes", async () => {
  await seed();
  const before = {};
  for (const r of await getQuery("SELECT * FROM prizes")) before[r.prizeId] = r;
  const r = await shop.collectiblesMigration();
  assert.deepEqual(r, { renamed: 21, reactivated: 19 });
  for (const id of IDS21) {
    const p = await row(id);
    assert.equal(p.prize, CAT.COLLECTIBLES[id].name);
    assert.equal(p.description, CAT.COLLECTIBLES[id].description);
    assert.deepEqual([p.cost, p.quantity, p.sold], [before[id].cost, before[id].quantity, before[id].sold], "price, stock and sold untouched: " + id);
    if (id === CARDS) assert.deepEqual([p.status, p.review_note], ["paused", "2026-11-01 restock: waiting on Tricon"], "paused for another reason: stays");
    else if (id === RING) assert.deepEqual([p.status, p.review_note], ["active", null]);
    else assert.deepEqual([p.status, p.review_note], ["active", null], "back on sale, note cleared: " + id);
  }
  const plex = await row(PLEX_1M);
  assert.deepEqual([plex.prize, plex.status, plex.review_note], ["Plex Invite 1 Month Access", "paused", NOTE], "another official row stays paused");
  const lst = await row("lst-ring");
  assert.deepEqual([lst.prize, lst.status, lst.review_note, lst.cost], ["Plain pure silver band", "paused", NOTE, 50000000], "a member listing is never touched");
  const mark = JSON.parse((await getQuery("SELECT value FROM shop_settings WHERE key = ?", [shop.COLLECTIBLES_KEY]))[0].value);
  assert.deepEqual([mark.renamed, mark.reactivated], [21, 19]);
});

test("migration: safe on every boot - a second run is skipped, an admin's later rename sticks; without the marker it changes nothing", async () => {
  await seed();
  await shop.collectiblesMigration();
  const snap = async () => JSON.stringify(await getQuery("SELECT prizeId, prize, description, cost, quantity, sold, status, review_note, seller_id FROM prizes ORDER BY prizeId"));
  await runQuery("UPDATE prizes SET prize = 'PS5 Pro (limited) - virtual collectible' WHERE prizeId = '9c0aa228-e0c4-46dd-97cc-dc41a245bc05'");
  const a = await snap();
  assert.deepEqual(await shop.collectiblesMigration(), { skipped: true });
  assert.equal(await snap(), a, "the marker: the next boot changes nothing (the admin's rename sticks)");
  // the statements themselves are idempotent too: drop the marker after a run and nothing moves except that one rename
  await runQuery("UPDATE prizes SET prize = ? WHERE prizeId = '9c0aa228-e0c4-46dd-97cc-dc41a245bc05'", [CAT.COLLECTIBLES["9c0aa228-e0c4-46dd-97cc-dc41a245bc05"].name]);
  const b = await snap();
  await runQuery("DELETE FROM shop_settings WHERE key = ?", [shop.COLLECTIBLES_KEY]);
  assert.deepEqual(await shop.collectiblesMigration(), { renamed: 0, reactivated: 0 });
  assert.equal(await snap(), b);
  // an empty database (a fresh staging site): nothing to do, marker set, no error
  await runQuery("DELETE FROM prizes");
  await runQuery("DELETE FROM shop_settings WHERE key = ?", [shop.COLLECTIBLES_KEY]);
  assert.deepEqual(await shop.collectiblesMigration(), { renamed: 0, reactivated: 0 });
});

// ── buying one ──
async function stockAll() {
  await runQuery("DELETE FROM prizes");
  for (const id of IDS21) {
    await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity, status, image_url, description) VALUES (?, ?, 100, 5, 'active', ?, ?)",
                   [id, CAT.COLLECTIBLES[id].name, CAT.artPath(CAT.ITEMS[id].key), CAT.COLLECTIBLES[id].description]);
  }
  await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity, status, image_url) VALUES (?, 'High Roller Role', 100, 5, 'active', ?)", [HIGH_ROLLER, CAT.artPath("role-high-roller")]);
}

test("a collectible order completes at once; the store gets no email, the vendor no alert, no fulfiller can open it", async () => {
  await stockAll();
  const admin = await mkUser(0, { username: "boss", cls: "Admin" });
  const vendor = await mkUser(0, { username: "tricon", camfrog: "TriconCF" });
  await SA.setRecipient({ userId: admin.userId, username: "boss" }, CARDS, "add", { who: "tricon", tg: 1, pm: 1, details: 1 });
  const buyer = await mkUser(1000, { camfrog: "BuyerCF", email: "buyer@example.test" });
  mails.length = 0;
  const r = await shop.purchasePrize({ userId: buyer.userId, username: buyer.username, prizeId: CARDS, source: "website", expectedCost: 100 });
  assert.equal(r.success, true, r.message);
  assert.equal(r.collectible, true);
  const o = (await getQuery("SELECT * FROM shop_orders WHERE id = ?", [r.order_id]))[0];
  assert.deepEqual([o.status, o.official, o.buyer_id, o.title], ["completed", 1, buyer.userId, CAT.COLLECTIBLES[CARDS].name], "the order is the record of ownership");
  const ev = await getQuery("SELECT status, note FROM shop_order_events WHERE order_id = ?", [r.order_id]);
  assert.deepEqual(ev.map((e) => [e.status, e.note]), [["completed", shop.COLLECTIBLE_NOTE]]);
  await shop.saleHooksIdle();
  assert.equal(await SA.alertOrder(r.order_id), 0, "no store alert for a collectible");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM store_alert_sent WHERE order_id = ?", [r.order_id]))[0].n, 0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = ?", [vendor.userId]).catch(() => [{ n: 0 }]))[0].n, 0, "the vendor hears nothing");
  assert.equal(await SA.isFulfiller(CARDS, vendor.userId), false, "no fulfiller access to a collectible's orders");
  assert.deepEqual(storeMails(), [], "no Purchase Notification to the store");
  // the contrast: an item PATV still sets up (a role) does email the store
  const r2 = await shop.purchasePrize({ userId: buyer.userId, username: buyer.username, prizeId: HIGH_ROLLER, source: "website", expectedCost: 100 });
  assert.equal(r2.success, true, r2.message);
  assert.equal(r2.collectible, undefined);
  await new Promise((res) => setTimeout(res, 30));
  assert.deepEqual(storeMails().map((m) => m.subject), ["Purchase Notification"]);
  assert.match(storeMails()[0].text, /purchased High Roller Role for 100 PAT/);
});

test("gifts and comps of a collectible: the recipient's order, no store email; comps are allowed (PATV fulfils it itself)", async () => {
  await stockAll();
  const payer = await mkUser(1000), to = await mkUser(0);
  mails.length = 0;
  const g = await shop.purchasePrize({ userId: payer.userId, username: payer.username, prizeId: PC, source: "website", expectedCost: 100, giftTo: to.username });
  assert.equal(g.success, true, g.message);
  const o = (await getQuery("SELECT buyer_id, gift_from, status FROM shop_orders WHERE id = ?", [g.order_id]))[0];
  assert.deepEqual(o, { buyer_id: to.userId, gift_from: payer.userId, status: "completed" });
  const ev = (await getQuery("SELECT note FROM shop_order_events WHERE order_id = ?", [g.order_id]))[0];
  assert.match(ev.note, /a virtual in-game collectible/);
  const pol = shop.compPolicy(await row(GIFT_CARD));
  assert.deepEqual([pol.kind, pol.compable, pol.giftable], ["collectible", true, true]);
  const admin = await mkUser(0, { username: "boss2", cls: "Admin" });
  const c = await shop.compPrize({ admin: { userId: admin.userId, username: "boss2" }, to: to.username, prizeId: RING, reason: "season prize" });
  assert.equal(c.success, true, c.message);
  await new Promise((res) => setTimeout(res, 30));
  assert.deepEqual(storeMails(), [], "neither the gift nor the comp emails the store");
});

test("raffles: collectibles can still be raffle prizes; a win sends no store email, and the winner hears it's a virtual collectible", async () => {
  await stockAll();
  const items = await shop.raffleItems();
  assert.ok(items.some((i) => i.prizeId === PC && i.delivery === "collectible"), "behaviour unchanged: the items stay raffle-able");
  const winner = await mkUser(0);
  mails.length = 0;
  const oid = await require(path.join(repo, "dbUtils")).tx(() => shop.raffleOrderInTx({ prizeId: PC, title: CAT.COLLECTIBLES[PC].name, winnerId: winner.userId, price: 0, raffleId: 9 }));
  shop.raffleOrderAfter({ orderId: oid, prizeId: PC, title: CAT.COLLECTIBLES[PC].name, userId: winner.userId, username: "w", price: 0, raffleId: 9 });
  await new Promise((res) => setTimeout(res, 60));
  assert.deepEqual(storeMails(), [], "no 'Raffle prize to deliver' email");
  const note = await getQuery("SELECT body FROM inbox WHERE user_id = ?", [winner.userId]);
  assert.ok(note.some((x) => /virtual in-game collectible/.test(x.body) && /no cash value/.test(x.body)), JSON.stringify(note));
  // a non-collectible raffle win still asks the store to deliver it
  const oid2 = await require(path.join(repo, "dbUtils")).tx(() => shop.raffleOrderInTx({ prizeId: HIGH_ROLLER, title: "High Roller Role", winnerId: winner.userId, price: 0, raffleId: 10 }));
  shop.raffleOrderAfter({ orderId: oid2, prizeId: HIGH_ROLLER, title: "High Roller Role", userId: winner.userId, username: "w", price: 0, raffleId: 10 });
  await new Promise((res) => setTimeout(res, 60));
  assert.deepEqual(storeMails().map((m) => m.subject), ["Raffle prize to deliver"]);
});

// ── pages + the bots' list ──
const base = (extra) => Object.assign({ user: null, me: null, H: shop.H, msg: null, settings: shop.settings, categories: shop.settings.categories, donate: null }, extra);

test("pages: the item page, My orders and the order page say it's a virtual in-game collectible", async () => {
  await stockAll();
  const me = { userId: "sc-me", username: "me", points_balance: 1000, staff: false };
  const p = await getQuery("SELECT * FROM prizes WHERE prizeId = ?", [PC]).then((r) => r[0]);
  const item = await ejs.renderFile(path.join(repo, "views", "shopItem.ejs"), base({ p, me, user: "me", sales: 0, more: [], sub: null }));
  assert.match(item, /Virtual in-game collectible: yours on PATV the moment you buy/);
  assert.match(item, /your order is the record that you own it/);
  assert.match(item, /src="\/public\/img\/shop\/gaming-pc\.svg"/);
  assert.doesNotMatch(item, /by the PATV team|by hand/);
  const o = { id: 3, prize_id: PC, title: CAT.COLLECTIBLES[PC].name, price: 100, official: 1, status: "completed", buyer_id: "sc-me", buyer_name: "me",
              created: Date.now(), source: "website", delivery: "collectible", shelf: "gaming", art: CAT.artPath("gaming-pc") };
  const one = await ejs.renderFile(path.join(repo, "views", "shopOrder.ejs"), base({ o, events: [], role: "buyer", me, user: "me" }));
  assert.match(one, /A virtual in-game collectible - it’s yours on PATV now\. Nothing is shipped; it has no cash value\./);
  const list = await ejs.renderFile(path.join(repo, "views", "shopOrders.ejs"), base({ orders: [o], events: {}, spent: { t: 100, n: 1 }, open: { n: 0, t: 0 }, page: 1, pages: 1, me, user: "me" }));
  assert.match(list, /A virtual in-game collectible - it’s yours on PATV now/);
  assert.doesNotMatch(list, /Delivered by the PATV team/);
});

test("/api/prizes (Discord /shop, Pepe's !prizes) lists the collectible names and their delivery", async () => {
  await stockAll();
  const app = express();
  app.use(express.json());
  shop.register(app, { isBotToken: () => false, addUser: (req, res, next) => next(), requireUser: (req, res) => res.status(401).end() });
  const server = app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/prizes`);
    const list = await r.json();
    const pc = list.find((x) => x.prizeId === PC);
    assert.deepEqual([pc.prize, pc.delivery], [CAT.COLLECTIBLES[PC].name, "collectible"]);
    assert.equal(list.find((x) => x.prizeId === HIGH_ROLLER).delivery, "role");
  } finally { server.close(); }
});
