// Offline tests for 1.99lz: the prize shop refresh - item pictures (shopcatalog.js + tools/gen-shop-art.py), shelves,
// "can you afford it", featured, the storefront / item / order views, and 🎁 gifts (an official item bought for someone else):
//   * every catalog item has its picture, its strings, a real shelf; every picture belongs to an item
//   * a gift: the payer pays, the recipient gets the item / role / order (buyer_id) + a notification; gift_from = payer
//   * refused (and nothing charged): the spin boost, a member's listing, yourself, nobody, a role they already have
//   * the gifter sees the order but never what was delivered on it (a Plex invite link lives in seller_note)
//   * browse: the shelf chips and "I can afford" filter
//   node --test test/shop-store.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shopstore-test-"));
process.chdir(tmp);
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;

const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const shop = require(path.join(repo, "shop"));
const CAT = require(path.join(repo, "shopcatalog"));
const EN = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));

const HIGH_ROLLER = "491cde2e-097e-4c2a-a351-ce441137ba38";
const PLEX_1M = "1c120384-c080-4186-b246-f1227e82ab01";
const PC = "35433a15-f2d4-4b43-b886-3bdb1686e8b2";
const RING = "e2626ad3-82b9-42c3-9ed1-5d6c22e1c6e5";

let n = 0;
async function mkUser(bal = 0, extra = {}) {
  const id = "ss" + (++n);
  await runQuery("INSERT INTO users (userId, username, password, points_balance, level, camfrogUsername, class) VALUES (?, ?, 'x', ?, 5, ?, ?)",
                 [id, extra.username || "shopper" + n, bal, extra.camfrog || null, extra.cls || "pleb"]);
  return { userId: id, username: extra.username || "shopper" + n };
}
const bal = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;
const stock = async (id) => (await getQuery("SELECT quantity AS q FROM prizes WHERE prizeId = ?", [id]))[0].q;

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, extra_daily_spins INTEGER DEFAULT 0,
                  discordId TEXT, camfrogUsername TEXT, email TEXT, isEmailVerified INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE IF NOT EXISTS jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  await runQuery("CREATE TABLE IF NOT EXISTS user_roles (userId TEXT, role TEXT, source TEXT, granted_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (userId, role))");
  await shop.ready;
  await mkUser(0, { username: "pb" });
  for (const [id, name, cost, q] of [[HIGH_ROLLER, "High Roller Role", 1000, 5], [PLEX_1M, "Plex Invite 1 Month Access", 500, 5],
                                     [PC, "Custom Gaming PC", 900, 1], [RING, "Custom Ring from Alex", 300, 0], [shop.SPINBOOST_ID, "+100 Daily Gold Spins", 3000000, 99]]) {
    await runQuery("INSERT OR REPLACE INTO prizes (prizeId, prize, cost, quantity, status, image_url) VALUES (?, ?, ?, ?, 'active', ?)", [id, name, cost, q, CAT.artPath(CAT.ITEMS[id].key)]);
  }
});

// ── the catalog + pictures ──
test("every catalog item has its pixel picture and strings; every picture belongs to an item; shelves are real", () => {
  const dir = path.join(repo, "public", "img", "shop");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".svg")).sort();
  const keys = Object.values(CAT.ITEMS).map((v) => v.key);
  assert.equal(new Set(keys).size, keys.length, "keys are unique");
  assert.deepEqual(files, keys.map((k) => k + ".svg").sort(), "one svg per item, no strays");
  for (const f of files) {
    const svg = fs.readFileSync(path.join(dir, f), "utf8");
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 48 36" shape-rendering="crispEdges">/, f);
    assert.match(svg, /<title>[^<]+<\/title>/, f + " has a title");
    assert.doesNotMatch(svg, /<script|href=|on\w+=/i, f + " is plain shapes");
    assert.ok(svg.length < 40000, f + " stays small");
  }
  for (const [id, v] of Object.entries(CAT.ITEMS)) {
    assert.ok(CAT.SHELF_IDS.includes(v.shelf), id);
    assert.ok(["instant", "role", "invite", "staff", "retired"].includes(v.delivery), id);
    if (v.delivery === "role") assert.ok(shop.ROLE_PRIZES[id], id + " is a store role");
    else assert.ok(EN["shop.cat.item." + CAT.tkey(v.key)], "en.json shop.cat.item." + CAT.tkey(v.key));
    if (v.delivery !== "role") assert.ok(EN["shop.deliver." + v.delivery], "en.json shop.deliver." + v.delivery);
  }
  for (const s of CAT.SHELVES) assert.ok(EN["shop.shelf." + s.id], "en.json shop.shelf." + s.id);
  for (const id of CAT.FEATURED) assert.ok(CAT.ITEMS[id], "featured " + id + " is a catalog item");
  for (const id of Object.keys(shop.ROLE_PRIZES)) assert.equal(CAT.ITEMS[id].shelf, "roles");
  for (const id of shop.REQUEST_ITEMS) assert.equal(CAT.ITEMS[id].gift, false, "retired items can't be gifted");
  assert.equal(CAT.ITEMS[shop.SPINBOOST_ID].gift, false, "the spin boost is priced per owner - no gifts");
  assert.deepEqual(CAT.info({ prizeId: "x", seller_id: "u1" }).shelf, "market");
  assert.deepEqual(CAT.info({ prizeId: "unknown" }).shelf, "more");
  assert.equal(CAT.artRows().length, Object.keys(CAT.ITEMS).length);
});

test("the generator is deterministic and matches the committed pictures", () => {
  const src = fs.readFileSync(path.join(repo, "tools", "gen-shop-art.py"), "utf8");
  for (const v of Object.values(CAT.ITEMS)) assert.ok(src.includes(`"${v.key}"`), "gen-shop-art.py draws " + v.key);
});

test("listings may use one of the shop's own pictures; other local paths are still refused", () => {
  const base = { title: "A thing", category: shop.settings.categories[0], price: 10, stock: 1 };
  assert.equal(shop.validateListing({ ...base, image_url: "/public/img/shop/ring.svg" }).image_url, "/public/img/shop/ring.svg");
  assert.throws(() => shop.validateListing({ ...base, image_url: "/public/img/../../x.svg" }), /https/);
  assert.throws(() => shop.validateListing({ ...base, image_url: "javascript:alert(1)" }), /https/);
});

test("1.99nh: image field takes site picture paths (normalized to /public) and https links, nothing else", () => {
  const base = { title: "A thing", category: shop.settings.categories[0], price: 10, stock: 1 };
  const img = (u) => shop.validateListing({ ...base, image_url: u }).image_url;
  // the path the shop art is really served at (express.static on /public), and the short forms people paste
  assert.equal(img("/public/img/shop/ps5-pro.svg"), "/public/img/shop/ps5-pro.svg");
  assert.equal(img("/img/shop/ps5-pro.svg"), "/public/img/shop/ps5-pro.svg");
  assert.equal(img("public/img/shop/ps5-pro.svg"), "/public/img/shop/ps5-pro.svg");
  assert.equal(img(" /public/img/banners/Big_Prize.PNG "), "/public/img/banners/Big_Prize.PNG");
  assert.equal(img("https://cdn.example.com/a.png"), "https://cdn.example.com/a.png");
  assert.equal(img(""), null);
  for (const bad of ["javascript:alert(1)", "data:image/svg+xml,<svg/>", "http://example.com/a.png", "//evil.example/a.png",
                     "/logout", "/public/img/../../index.js", "/public/./x.svg", "/public/img/x.svg?y=1", "/public/img/x.html",
                     "/public\\img\\x.svg", "/public/img/a b.svg", "https://x.example/a\".png"]) {
    assert.throws(() => img(bad), /https/, "refused: " + bad);
  }
  // the edit forms take the same thing in the browser (type=text + pattern; type=url blocked relative paths)
  for (const v of ["shopAdmin.ejs", "shopEdit.ejs", "shopSeller.ejs"]) {
    const src = fs.readFileSync(path.join(repo, "views", v), "utf8");
    const tag = src.match(/<input[^>]*name="image_url"[^>]*>/)[0];
    assert.match(tag, /type="text"/, v);
    const re = new RegExp("^(?:" + tag.match(/pattern="([^"]*)"/)[1] + ")$", "v");
    assert.ok(re.test("/public/img/shop/ps5-pro.svg") && re.test("https://x.example/a.png"), v + " accepts paths and https");
    assert.ok(!re.test("javascript:alert(1)") && !re.test("http://x.example/a.png") && !re.test("data:x"), v + " refuses the rest");
  }
});

// ── gifts ──
test("a gift: the payer pays, the recipient gets the role + the order + a notice; gift_from is the payer", async () => {
  const payer = await mkUser(5000), to = await mkUser(0, { camfrog: "FrogFriend" });
  const before = await stock(HIGH_ROLLER);
  const r = await shop.purchasePrize({ userId: payer.userId, username: payer.username, prizeId: HIGH_ROLLER, source: "website",
                                       expectedCost: 1000, giftTo: "@frogfriend", giftNote: "  enjoy\nthe tables  " });
  assert.equal(r.success, true, r.message);
  assert.equal(r.gift_to, to.username);
  assert.match(r.message, /Sent High Roller Role to shopper\d+ for 1,000 PAT/);
  assert.equal(r.balance, 4000);
  assert.equal(await bal(payer.userId), 4000);
  assert.equal(await bal(to.userId), 0, "the recipient pays nothing");
  assert.equal(await stock(HIGH_ROLLER), before - 1);
  assert.ok((await getQuery("SELECT 1 FROM user_roles WHERE userId = ? AND role = 'high roller'", [to.userId]))[0], "the role is theirs");
  assert.ok(!(await getQuery("SELECT 1 FROM user_roles WHERE userId = ?", [payer.userId]))[0], "not the payer's");
  const o = (await getQuery("SELECT * FROM shop_orders WHERE id = ?", [r.order_id]))[0];
  assert.equal(o.buyer_id, to.userId);
  assert.equal(o.gift_from, payer.userId);
  assert.equal(o.gift_note, "enjoy the tables");
  const tx = await getQuery("SELECT userId, type, points FROM transactions WHERE userId IN (?, ?)", [payer.userId, to.userId]);
  assert.deepEqual(tx, [{ userId: payer.userId, type: `purchase of High Roller Role (gift for ${to.username})`, points: -1000 }]);
  await new Promise((res) => setTimeout(res, 80));
  const note = await getQuery("SELECT * FROM inbox WHERE user_id = ?", [to.userId]).catch(() => []);
  assert.ok(note.some((x) => /sent you a gift: High Roller Role/.test(x.title) && x.link === `/shop/orders/${r.order_id}`), "the recipient's inbox");
});

test("gifts that are refused cost nothing: spin boost, yourself, nobody, a role they have, out of stock", async () => {
  const payer = await mkUser(10000000), to = await mkUser(0);
  const tries = [
    [{ prizeId: shop.SPINBOOST_ID, giftTo: to.username }, /can't be sent as a gift/],
    [{ prizeId: PC, giftTo: payer.username }, /That's you/],
    [{ prizeId: PC, giftTo: "no-such-person" }, /no PATV account called "no-such-person"/],
    [{ prizeId: RING, giftTo: to.username }, /out of stock/],
  ];
  await runQuery("INSERT INTO user_roles (userId, role, source) VALUES (?, 'high roller', 'test')", [to.userId]);
  tries.push([{ prizeId: HIGH_ROLLER, giftTo: to.username }, /already has the High Roller role/]);
  for (const [args, re] of tries) {
    const r = await shop.purchasePrize({ userId: payer.userId, username: payer.username, source: "website", ...args });
    assert.equal(r.success, false, JSON.stringify(args));
    assert.match(r.message, re);
  }
  assert.equal(await bal(payer.userId), 10000000);
  assert.equal((await getQuery("SELECT COUNT(*) AS c FROM shop_orders WHERE gift_from = ?", [payer.userId]))[0].c, 0);
});

test("a member's listing can't be gifted; an empty gift name is a normal purchase", async () => {
  const seller = await mkUser(0), payer = await mkUser(5000), to = await mkUser(0);
  await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity, status, seller_id) VALUES ('lst1', 'Hand-made thing', 100, 3, 'active', ?)", [seller.userId]);
  const r = await shop.purchasePrize({ userId: payer.userId, username: payer.username, prizeId: "lst1", source: "website", giftTo: to.username });
  assert.equal(r.success, false);
  assert.match(r.message, /can't be sent as a gift/);
  const own = await shop.purchasePrize({ userId: payer.userId, username: payer.username, prizeId: PC, source: "website", expectedCost: 900, giftTo: "  " });
  assert.equal(own.success, true, own.message);
  const o = (await getQuery("SELECT buyer_id, gift_from FROM shop_orders WHERE id = ?", [own.order_id]))[0];
  assert.deepEqual(o, { buyer_id: payer.userId, gift_from: null });
});

// ── pages ──
const t0 = () => null;
const base = (extra) => Object.assign({ user: null, me: null, H: shop.H, msg: null, settings: shop.settings, categories: shop.settings.categories, donate: null }, extra);

test("browse: shelf chips + the 'I can afford' filter; counts per shelf", async () => {
  const all = await shop.browse({});
  assert.ok(all.shelfCounts.roles >= 1 && all.shelfCounts.gaming >= 1 && all.shelfCounts.market >= 1);
  const roles = await shop.browse({ shelf: "roles" });
  assert.deepEqual(roles.items.map((i) => i.prizeId), [HIGH_ROLLER]);
  const market = await shop.browse({ shelf: "market" });
  assert.ok(market.items.every((i) => i.seller_id));
  const cheap = await shop.browse({ afford: "1", _balance: 600 });
  assert.ok(cheap.items.length && cheap.items.every((i) => i.cost <= 600), "only what they can pay for");
  assert.equal(cheap.filters.afford, true);
  const ignored = await shop.browse({ afford: "1" });
  assert.equal(ignored.filters.afford, false, "signed out: no balance, no filter");
  assert.equal((await shop.browse({ shelf: "nope" })).filters.shelf, "");
});

test("/shop renders: hero, featured, chips, cards with pictures, afford states, buy-anywhere notes", async () => {
  const me = { userId: "ss-me", username: "me", points_balance: 950, staff: false };
  const data = await shop.browse({ _balance: 950 });
  const html = await ejs.renderFile(path.join(repo, "views", "shop.ejs"), base({ ...data, me, user: "me", store: null, feat: await shop.featured() }));
  assert.match(html, /<section class="st-hero"/);
  assert.match(html, /<em>real prizes<\/em>/);
  assert.match(html, /class="st-feat"/);
  assert.match(html, /src="\/public\/img\/shop\/gaming-pc\.svg"/);
  assert.match(html, /aria-label="Shelves"/);
  assert.match(html, /🎖️<\/span>Roles <span class="n">1<\/span>/);
  assert.match(html, /✓ You can afford this/);
  assert.match(html, /PAT to go/);
  assert.match(html, /<code>!prizes<\/code>/);
  assert.match(html, /<code>\/shop<\/code>/);
  assert.match(html, /id="shopBalance">950</);
  const out = await ejs.renderFile(path.join(repo, "views", "shop.ejs"), base({ ...(await shop.browse({})), store: null, feat: [] }));
  assert.doesNotMatch(out, /You can afford|PAT to go|class="buy-btn"/, "signed out: no afford states, no buy buttons");
  assert.match(out, /Sign in to buy or sell/);
});

test("item page: gallery + lightbox, what you get, gift form only where a gift is allowed, related items", async () => {
  const me = { userId: "ss-me", username: "me", points_balance: 100, staff: false };
  const p = (await getQuery("SELECT * FROM prizes WHERE prizeId = ?", [PLEX_1M]))[0];
  const more = await getQuery("SELECT prizeId, prize, cost, quantity, image_url, seller_id FROM prizes WHERE prizeId != ? AND seller_id IS NULL", [PLEX_1M]);
  const html = await ejs.renderFile(path.join(repo, "views", "shopItem.ejs"), base({ p, me, user: "me", sales: 0, more, sub: { days: 30 } }));
  assert.match(html, /id="galMain"/);
  assert.match(html, /<dialog class="st-lb"/);
  assert.match(html, /src="\/public\/img\/shop\/plex-1m\.svg"/);
  assert.match(html, /Your invite link appears on your order page/);
  assert.match(html, /🎁 Send it as a gift/);
  assert.match(html, /data-gift="1"/);
  assert.match(html, /🔁 Subscribe/);
  assert.match(html, /You might also like/);
  assert.match(html, /400 PAT to go/);
  const sb = (await getQuery("SELECT * FROM prizes WHERE prizeId = ?", [shop.SPINBOOST_ID]))[0];
  const h2 = await ejs.renderFile(path.join(repo, "views", "shopItem.ejs"), base({ p: sb, me, user: "me", sales: 0, more: [], sub: null }));
  assert.doesNotMatch(h2, /data-gift="1"/, "no gifting the spin boost");
  const role = (await getQuery("SELECT * FROM prizes WHERE prizeId = ?", [HIGH_ROLLER]))[0];
  const h3 = await ejs.renderFile(path.join(repo, "views", "shopItem.ejs"), base({ p: role, me: null, sales: 0, more: [], sub: null }));
  assert.match(h3, /High Roller: play for bigger stakes/);
  assert.match(h3, /Sign in to buy/);
  assert.doesNotMatch(h3, /data-gift/);
});

test("order page: the gifter sees the gift, never what was delivered on it", async () => {
  const o = { id: 7, title: "Plex Invite 1 Month Access", price: 500, official: 1, status: "completed", buyer_name: "friend", gift_from: "ss-payer",
              gift_from_name: "payer", gift_note: "for movie night", seller_note: "SECRET-INVITE-LINK", prize_id: PLEX_1M, created: Date.now(), source: "website" };
  const me = { userId: "ss-payer", username: "payer", staff: false };
  const asGifter = await ejs.renderFile(path.join(repo, "views", "shopOrder.ejs"), base({ o, events: [], role: "gifter", me, user: "payer" }));
  assert.match(asGifter, /🎁 From payer to friend/);
  assert.match(asGifter, /for movie night/);
  assert.doesNotMatch(asGifter, /SECRET-INVITE-LINK/);
  const asBuyer = await ejs.renderFile(path.join(repo, "views", "shopOrder.ejs"), base({ o, events: [], role: "buyer", me: { userId: "ss-friend", username: "friend" }, user: "friend" }));
  assert.match(asBuyer, /SECRET-INVITE-LINK/);
  const list = await ejs.renderFile(path.join(repo, "views", "shopOrders.ejs"), base({ orders: [{ ...o, buyer_id: "ss-friend" }], events: {}, spent: { t: 500, n: 1 }, open: { n: 0, t: 0 }, page: 1, pages: 1, me, user: "payer" }));
  assert.match(list, /Gift for friend/);
  assert.doesNotMatch(list, /SECRET-INVITE-LINK/);
});
