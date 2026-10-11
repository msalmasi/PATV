// Offline tests for 1.99mv: the shop design pass - My orders, an order, the seller dashboard, a storefront, and the /shop
// shelf-chips row. Through the real routes (shop.register on a bare express app, temp DB):
//   * My orders: item pictures, status badges, the marketplace stepper, view chips (all / open / gifts in / gifts out) with
//     counts, gift lines (an 🕶 anonymous gift never names its giver to the recipient), empty states with a call to action,
//     the buyer actions (cancel / confirm / dispute forms) unchanged
//   * an order: its picture + badge; the gifter still never sees what was delivered
//   * the seller dashboard: headline stats, the orders to fulfil (fulfil + refund forms), the listings table with its quick
//     actions (edit / pause / resume / remove), top items, the recent-orders feed, the notification form; a seller below the
//     level gets the level notice and no listing form
//   * a storefront: hero (photo / name / level / stats), best sellers strip, the grid; an unknown seller still 404s
//   * /shop: the chips row has its wrapper + arrow buttons, no native scrollbar
//   node --test test/shop-pages.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shoppages-test-"));
process.chdir(tmp);
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;

const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const shop = require(path.join(repo, "shop"));
const CAT = require(path.join(repo, "shopcatalog"));

const PLEX_1M = "1c120384-c080-4186-b246-f1227e82ab01";
const PC = "35433a15-f2d4-4b43-b886-3bdb1686e8b2";
let server, base;
const H = 3600e3, now = Date.now();

async function order(o, evs = []) {
  const r = await runQuery(`INSERT INTO shop_orders (prize_id, buyer_id, seller_id, official, title, price, fee_pct, fee, net, seller_paid, status, source, created,
      fulfilled_at, buyer_input, seller_note, dispute_reason, gift_from, gift_note, gift_anon, updated)
    VALUES (?, ?, ?, ?, ?, ?, 10, ?, ?, ?, ?, 'website', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [o.prize_id || null, o.buyer, o.seller || null, o.seller ? 0 : 1, o.title, o.price, o.fee || 0, o.net || o.price, o.paid ? 1 : 0, o.status, o.created || now,
     o.fulfilled_at || null, o.input || null, o.note || null, o.dispute || null, o.gift_from || null, o.gift_note || null, o.anon ? 1 : 0, o.created || now]);
  const id = (await getQuery("SELECT MAX(id) AS id FROM shop_orders"))[0].id;
  for (const [st, note] of evs) await runQuery("INSERT INTO shop_order_events (order_id, ts, status, note) VALUES (?, ?, ?, ?)", [id, now, st, note || null]);
  return id;
}
const get = async (url, as) => {
  const r = await fetch(base + url, { headers: as ? { "x-test-user": as } : {}, redirect: "manual" });
  return { status: r.status, html: await r.text(), location: r.headers.get("location") };
};

const IDS = {};
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, extra_daily_spins INTEGER DEFAULT 0,
                  discordId TEXT, camfrogUsername TEXT, email TEXT, isEmailVerified INTEGER DEFAULT 0, avatar TEXT, created_at TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await shop.ready;
  for (const [id, name, lv] of [["pb", "pb", 1], ["sp-alice", "alice", 40], ["sp-bob", "bob", 10], ["sp-carol", "carol", 10], ["sp-dave", "dave", 3], ["sp-new", "newbie", 1]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, points_balance, level, created_at) VALUES (?, ?, ?, 'x', 100000, ?, '2025-03-14 10:00:00')",
                   [id, name, name === "alice" ? "Alice the Dealer" : name, lv]);
  }
  for (const [id, name] of [[PLEX_1M, "Plex Invite 1 Month Access"], [PC, "Custom Gaming PC"]]) {
    await runQuery("INSERT OR REPLACE INTO prizes (prizeId, prize, cost, quantity, status, image_url) VALUES (?, ?, 500, 5, 'active', ?)", [id, name, CAT.artPath(CAT.ITEMS[id].key)]);
  }
  const L = [["sp1", "Steam card", 2500, 4, "/public/img/shop/gift-card.svg", 7, "active"], ["sp2", "Pepe portrait", 6000, 1, null, 3, "active"],
             ["sp3", "Game key", 1200, 2, null, 11, "active"], ["sp4", "Room banner", 4000, 2, null, 0, "paused"], ["sp5", "Sticker sheet", 800, 6, null, 0, "active"]];
  for (const [id, title, cost, q, img, sold, st] of L) {
    await runQuery(`INSERT INTO prizes (prizeId, prize, cost, quantity, status, image_url, sold, seller_id, category, description, created)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'sp-alice', 'Gift cards', 'x', ?)`, [id, title, cost, q, st, img, sold, now - sold * H]);
  }
  IDS.paid = await order({ prize_id: "sp2", buyer: "sp-bob", seller: "sp-alice", title: "Pepe portrait", price: 6000, status: "paid", input: "a crown please" }, [["paid"]]);
  IDS.fulfilled = await order({ prize_id: "sp1", buyer: "sp-bob", seller: "sp-alice", title: "Steam card", price: 2500, fee: 250, net: 2250, paid: true, status: "fulfilled",
                                fulfilled_at: now - H, note: "CODE-123" }, [["paid"], ["fulfilled", "sent"]]);
  IDS.anon = await order({ prize_id: PLEX_1M, buyer: "sp-bob", gift_from: "sp-carol", anon: true, gift_note: "for movie night", title: "Plex Invite 1 Month Access",
                           price: 500, status: "completed", note: "https://plex.example/invite" }, [["completed"]]);
  IDS.sent = await order({ prize_id: PC, buyer: "sp-dave", gift_from: "sp-bob", title: "Custom Gaming PC", price: 500, status: "completed", note: "DAVE-ONLY" }, [["completed"]]);
  IDS.done = await order({ prize_id: "sp3", buyer: "sp-carol", seller: "sp-alice", title: "Game key", price: 1200, fee: 120, net: 1080, paid: true, status: "completed",
                           fulfilled_at: now - 2 * H }, [["paid"], ["fulfilled"], ["completed"]]);

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
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

test("attachArt: an order gets its item's picture, shelf and delivery; a comp / service / gone listing gets none", async () => {
  const os_ = [{ prize_id: PLEX_1M, official: 1 }, { prize_id: "sp1", seller_id: "sp-alice" }, { prize_id: null, official: 1 }, { prize_id: "gone", seller_id: "x" }];
  await shop.attachArt(os_);
  assert.equal(os_[0].art, "/public/img/shop/plex-1m.svg");
  assert.equal(os_[0].delivery, "invite");
  assert.equal(os_[1].art, "/public/img/shop/gift-card.svg");
  assert.equal(os_[1].shelf, "market");
  assert.equal(os_[2].art, null);
  assert.equal(os_[3].art, null);
});

test("My orders: pictures, badges, the stepper, gift lines (anonymous masked), view chips with counts, the buyer actions", async () => {
  const { status, html } = await get("/shop/orders", "sp-bob");
  assert.equal(status, 200);
  assert.match(html, /<main class="sh sd">/);
  assert.match(html, /src="\/public\/img\/shop\/plex-1m\.svg"/, "the official item's picture");
  assert.match(html, /src="\/public\/img\/shop\/gift-card\.svg"/, "the listing's picture");
  assert.match(html, /class="sd-badge live" style="--c:#ffd700">Paid — awaiting seller</);
  assert.match(html, /<ol class="sd-steps"/);
  assert.match(html, /aria-current="step">Seller delivering</);
  assert.match(html, /aria-current="step">Confirm receipt</);
  assert.match(html, /Gift from someone \(anonymous\)/);
  assert.doesNotMatch(html, /carol/, "the anonymous giver is never named to the recipient");
  assert.match(html, /“?for movie night/);
  assert.match(html, /Gift for dave/);
  assert.doesNotMatch(html, /DAVE-ONLY/, "the gifter never sees what was delivered");
  assert.match(html, /https:\/\/plex\.example\/invite/, "the recipient sees their invite");
  assert.match(html, /aria-current="true"><span aria-hidden="true">🧾<\/span> All <span class="n">4<\/span>/);
  assert.match(html, /In progress <span class="n hot">2<\/span>/);
  assert.match(html, /Gifts received <span class="n">1<\/span>/);
  assert.match(html, /Gifts sent <span class="n">1<\/span>/);
  assert.match(html, new RegExp(`action="/shop/orders/${IDS.paid}/cancel"`));
  assert.match(html, new RegExp(`action="/shop/orders/${IDS.fulfilled}/confirm"`));
  assert.match(html, new RegExp(`action="/shop/orders/${IDS.fulfilled}/dispute"`));
  assert.match(html, /from <a href="\/shop\/seller\/alice">alice<\/a>/);
});

test("My orders: the view chips filter; empty views show a call to action", async () => {
  const open = await get("/shop/orders?view=open", "sp-bob");
  assert.match(open.html, /Pepe portrait/);
  assert.doesNotMatch(open.html, /Custom Gaming PC/);
  const sent = await get("/shop/orders?view=gifts_out", "sp-bob");
  assert.match(sent.html, /Custom Gaming PC/);
  assert.doesNotMatch(sent.html, /Pepe portrait/);
  const none = await get("/shop/orders?view=gifts_out", "sp-new");
  assert.match(none.html, /class="sd-empty"/);
  assert.match(none.html, /You haven&#39;t sent a gift yet|You haven't sent a gift yet/);
  assert.match(none.html, /<a class="qbtn gold" href="\/shop">Find a gift<\/a>/);
  const all = await get("/shop/orders?view=bogus", "sp-new");
  assert.match(all.html, /No orders yet/);
  assert.match(all.html, /Browse the shop/);
  assert.equal((await get("/shop/orders")).location, "/login");
});

test("an order: picture + badge; the gifter's view still hides the delivery; strangers get the not-found card", async () => {
  const asGifter = await get(`/shop/orders/${IDS.sent}`, "sp-bob");
  assert.match(asGifter.html, /src="\/public\/img\/shop\/gaming-pc\.svg"/);
  assert.match(asGifter.html, /class="sd-badge" style="--c:#4caf50">Completed</);
  assert.doesNotMatch(asGifter.html, /DAVE-ONLY/);
  const asRecipient = await get(`/shop/orders/${IDS.anon}`, "sp-bob");
  assert.match(asRecipient.html, /From someone \(anonymous\) to bob/);
  assert.doesNotMatch(asRecipient.html, /carol/);
  const stranger = await get(`/shop/orders/${IDS.paid}`, "sp-dave");
  assert.equal(stranger.status, 404);
  assert.match(stranger.html, /Order not found/);
});

test("seller dashboard: stats, orders to fulfil, the listings table + quick actions, top items, recent orders, notifications", async () => {
  const { status, html } = await get("/shop/seller", "sp-alice");
  assert.equal(status, 200);
  assert.match(html, /<h1 id="sdH">Seller dashboard<\/h1>/);
  assert.match(html, /Net revenue<\/span><b class="gold">3,330 <small>PAT<\/small>/);
  assert.match(html, /To fulfil<\/span><b class="gold">1<\/b>/);
  assert.match(html, new RegExp(`action="/shop/orders/${IDS.paid}/fulfil"`));
  assert.match(html, new RegExp(`action="/shop/orders/${IDS.paid}/refund"`));
  assert.match(html, /a crown please/);
  assert.match(html, /<table class="sd-t">/);
  assert.match(html, /href="\/shop\/seller\?edit=sp1#edit"/);
  assert.match(html, /action="\/shop\/listing\/sp1\/pause"/);
  assert.match(html, /action="\/shop\/listing\/sp4\/activate"/);
  assert.match(html, /action="\/shop\/listing\/sp1\/remove"/);
  assert.match(html, /<details class="sd-card" id="new"/);
  assert.match(html, /action="\/shop\/listing"/);
  assert.match(html, /<ol class="sd-bars">/);
  assert.match(html, /<ul class="sd-feed">/);
  assert.match(html, /action="\/shop\/prefs"/);
  for (const a of ["todo", "listings", "revenue", "history", "notify"]) assert.match(html, new RegExp(`id="${a}"`), a);
  const edit = await get("/shop/seller?edit=sp2", "sp-alice");
  assert.match(edit.html, /id="edit"/);
  assert.match(edit.html, /Edit “Pepe portrait”/);
  assert.match(edit.html, /action="\/shop\/listing\/sp2"/);
  const low = await get("/shop/seller", "sp-new");
  assert.match(low.html, /You need to be level \d+ to sell in the shop/);
  assert.doesNotMatch(low.html, /action="\/shop\/listing"/);
  assert.match(low.html, /Nothing waiting/);
});

test("storefront: hero, best sellers, the grid; unknown seller 404s", async () => {
  const { status, html } = await get("/shop/seller/alice", "sp-bob");
  assert.equal(status, 200);
  assert.match(html, /class="st-hero st-store"/);
  assert.match(html, /<span class="cx-name">Alice the Dealer<\/span>&#39;s shop|<span class="cx-name">Alice the Dealer<\/span>'s shop/);
  assert.match(html, /LV 40/);
  assert.match(html, /Member since 2025-03/);
  assert.match(html, /<section class="st-sbest"/);
  assert.match(html, /TOP SELLER/);
  assert.match(html, /class="st-grid"/);
  assert.doesNotMatch(html, /Room banner/, "paused listings aren't for sale");
  assert.doesNotMatch(html, /Manage your shop/, "only the owner gets the manage button");
  assert.match((await get("/shop/seller/alice", "sp-alice")).html, /Manage your shop/);
  const q = await get("/shop/seller/alice?q=steam", "sp-bob");
  assert.doesNotMatch(q.html, /class="st-sbest"/, "a search shows results, not the strip");
  const missing = await get("/shop/seller/nobody-here", "sp-bob");
  assert.equal(missing.status, 404);
});

test("/shop: the shelf chips row - wrapper, arrows, the scroll script; no native scrollbar", async () => {
  const { html } = await get("/shop", "sp-bob");
  assert.match(html, /<div class="st-chipwrap" id="stChipwrap">/);
  assert.match(html, /class="st-chip-arr l"[^>]*aria-label="Scroll the shelves left"/);
  assert.match(html, /class="st-chip-arr r"[^>]*aria-label="Scroll the shelves right"/);
  assert.match(html, /<nav class="st-chips" id="stChips" aria-label="Shelves">/);
  assert.match(html, /\.st \.st-chips::-webkit-scrollbar \{ display: none/);
  assert.match(html, /scrollbar-width: none/);
});
