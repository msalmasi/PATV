// 1.99tt: the 🥷 heist market (heistmarket.js) - players sell heist items to each other for PAT, Pepe moves the items.
//   * a listing takes the item OUT of the seller's sheet first (an escrow op Pepe applies + acks): only then it's for sale;
//     an item he can't find voids the listing
//   * a sale is ONE transaction: the buyer pays, the seller gets the price minus the fee, the fee goes where the PAT Routing
//     row heist_market_fee says (Fort Knox by default, an admin override wins), the delivery op is queued - no PAT made or
//     destroyed (only the fee moves, buyer -> pool)
//   * retries: the same list / buy click answers "already"; an ack seen twice changes nothing
//   * one-of-each: a buyer who owns that permanent gear is refused; a delivery Pepe refuses leaves the item "held" for them
//   * self-dealing: your own listing / a linked account's listing is refused; prices, rate limits
//   * the pawn shop is OFF by default; on, the House (Casino vault) pays a % of the shop price once Pepe has the item
//   * delist (also while escrowing), admin delist, Pepe's chat endpoint by login, the page renders
//   NODE_PATH=G:/PATV/node_modules node --test test/heistmarket.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ejs = require("ejs");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "heistmarket-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
// the achievements module is the site's (big, boots its own backfills): record what the market asks of it instead
const awarded = [];
require.cache[require.resolve(path.join(repo, "achievements"))] = {
  id: "ach", filename: "ach", loaded: true,
  exports: { awardCount: async (userId, metric, value) => { awarded.push([userId, metric, value]); return []; }, poke: () => {} },
};
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const G = require(path.join(repo, "gtfstore"));
const S = require(path.join(repo, "gtfsheet"));
const P = require(path.join(repo, "pools"));
const E = require(path.join(repo, "econstore"));
const M = require(path.join(repo, "heistmarket"));

const CAT = { shop: {
  lockpick: { name: "Lockpick", emoji: "🔓", kind: "item", cost: 1000, desc: "DEX rescue" },
  armor: { name: "Body Armor", emoji: "🦺", kind: "gear", cost: 15000, desc: "+2 CON" },
  kingpinring: { name: "Kingpin's Ring", emoji: "💍", kind: "item", cost: 0, buyable: false, desc: "+1 stat" },
  fence: { name: "The Fence", emoji: "📈", kind: "gear", cost: 0, buyable: false },
  pardon: { name: "Presidential Pardon", emoji: "📜", kind: "instant", cost: 100000 },
}, prices: { sheetregen: 50000, avatarregen: 20000 }, heat_max: 100, heat_decay: 40, levels_per_point: 10, item_cap: 10 };
const sheet = (o) => JSON.stringify(Object.assign({ stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 }, loot: 0, heists: 0 }, o));

let base, server, cookieUser = null;
const post = (p, body, headers = {}) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const web = (who, p, body) => { cookieUser = who; return post(p, body, { "X-Requested-With": "fetch", origin: base }); };
const bot = (p, body) => post(p, Object.assign({ password: "bot" }, body));
const bal = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;
const pool = (k) => P.balance(k);
const supply = async () => (await getQuery("SELECT SUM(points_balance) AS s FROM users"))[0].s + (await P.total()).amount +
  (await getQuery("SELECT COALESCE(SUM(amount), 0) AS s FROM jackpot_rakes"))[0].s;
const L = async (id) => (await getQuery("SELECT * FROM heist_market_listings WHERE id = ?", [id]))[0];
/** Pepe's side, minimal: apply every open op to the mirror sheets (what pepe_heistmarket does), ack with the result. */
async function pepe(sheets, override = {}) {
  const ops = (await bot("/api/gtf/bot/market/ops", {})).body.ops;
  const results = [];
  for (const o of ops) {
    const sh = sheets[o.login] || (sheets[o.login] = { gear: [], items: {} });
    let r = override[o.key];
    if (!r) {
      const gear = CAT.shop[o.item].kind === "gear";
      if (o.op === "escrow") {
        if (gear ? sh.gear.includes(o.item) : (sh.items[o.item] || 0) >= o.qty) {
          if (gear) sh.gear = sh.gear.filter((g) => g !== o.item); else sh.items[o.item] -= o.qty;
          r = "ok";
        } else r = "missing";
      } else if (gear) {
        if (sh.gear.includes(o.item)) r = "owned"; else { sh.gear.push(o.item); r = "ok"; }
      } else if ((sh.items[o.item] || 0) + o.qty > 10) r = "full";
      else { sh.items[o.item] = (sh.items[o.item] || 0) + o.qty; r = "ok"; }
    }
    results.push({ key: o.key, result: r });
  }
  const a = await bot("/api/gtf/bot/market/ack", { results });
  // the display mirror follows (as Pepe's push would)
  const push = {};
  for (const [k, sh] of Object.entries(sheets)) push[k] = sheet(sh);
  await bot("/api/gtf/bot/sheet-mirror", { full: false, sheets: push });
  return { ops, ack: a.body };
}

const SHEETS = { ann_cf: { gear: ["armor", "fence"], items: { lockpick: 4, kingpinring: 2 } }, bob: { gear: [], items: { lockpick: 9 } },
                 cat: { gear: ["armor"], items: {} }, alt: { gear: [], items: {} } };

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery(`CREATE TABLE reserve_claims (claimId TEXT PRIMARY KEY, flow TEXT NOT NULL, userId TEXT, type TEXT, amount INTEGER NOT NULL,
                  created DATETIME DEFAULT CURRENT_TIMESTAMP, settled INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE welcome_bonus (userId TEXT PRIMARY KEY, dup_of TEXT)");
  for (const [id, name, cf, b, cls] of [["u1", "ann", "Ann_CF", 0, "pleb"], ["u2", "bob", "bob", 500000, "pleb"], ["u3", "cat", "cat", 500000, "pleb"],
                                        ["u4", "alt", "alt", 500000, "pleb"], ["u5", "nolink", null, 500000, "pleb"], ["u9", "boss", "boss", 0, "Admin"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, points_balance, class) VALUES (?, ?, ?, 'x', ?, ?, ?)",
                   [id, name, name.toUpperCase(), cf, b, cls]);
  }
  await runQuery("INSERT INTO welcome_bonus (userId, dup_of) VALUES ('u4', 'u1')");          // alt is ann's second account
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { if (cookieUser) req.user = { userId: cookieUser, username: cookieUser }; next(); };
  const deps = { isBotToken: (t) => t === "bot", addUser };
  G.register(app, deps);
  S.register(app, deps);
  M.register(app, deps);
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await S.init();
  await M.init();
  await P.init();
  await E.init();
  await P._setMeta("live", true);
  P._forgetLive();
  await runQuery("INSERT INTO pools (key, balance, updated) VALUES ('fortknox', 1000, 0), ('heist', 50000, 0), ('reserve', 0, 0)");
  await bot("/api/gtf/bot/meta", { catalog: CAT });
  const push = {};
  for (const [k, sh] of Object.entries(SHEETS)) push[k] = sheet(sh);
  assert.equal((await bot("/api/gtf/bot/sheet-mirror", { full: true, sheets: push })).status, 200);
});
test.after(() => server && server.close());

let ring;
test("list: the item leaves the sheet first (escrow op), then it's for sale; the same click twice is one listing", async () => {
  const r = await web("u1", "/api/gtf/market/list", { item: "kingpinring", qty: 1, price: "250k", idem: "click-ring-1" });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  ring = r.body.listing.id;
  assert.equal(r.body.listing.status, "escrowing");
  assert.equal(r.body.listing.price, 250000);
  const again = await web("u1", "/api/gtf/market/list", { item: "kingpinring", qty: 1, price: "250k", idem: "click-ring-1" });
  assert.equal(again.body.already, true);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM heist_market_listings"))[0].n, 1);
  // not for sale (and not buyable) until Pepe has it
  assert.equal((await web("u2", "/api/gtf/market/buy", { id: ring, idem: "buy-early-1" })).body.code, "E_NOT_ACTIVE");
  const p = await pepe(SHEETS);
  assert.deepEqual(p.ops.map((o) => [o.op, o.login, o.item, o.qty]), [["escrow", "ann_cf", "kingpinring", 1]]);
  assert.equal(SHEETS.ann_cf.items.kingpinring, 1, "one ring left in the sheet - the listed one can't be used");
  assert.equal((await L(ring)).status, "active");
  // an ack seen again changes nothing
  const twice = await bot("/api/gtf/bot/market/ack", { results: [{ key: p.ops[0].key, result: "missing" }] });
  assert.equal(twice.body.acked, 0);
  assert.equal((await L(ring)).status, "active");
});

test("list refusals: unknown / instant items, prices, more than you have, gear twice, unlinked accounts", async () => {
  assert.equal((await web("u1", "/api/gtf/market/list", { item: "pardon", price: 5, idem: "c-pardon-1" })).body.code, "E_UNTRADABLE");
  assert.equal((await web("u1", "/api/gtf/market/list", { item: "nope", price: 5, idem: "c-nope-01" })).body.code, "E_ITEM");
  assert.equal((await web("u1", "/api/gtf/market/list", { item: "lockpick", price: 0, idem: "c-price-1" })).body.code, "E_PRICE");
  assert.equal((await web("u1", "/api/gtf/market/list", { item: "lockpick", price: "2b", idem: "c-price-2" })).body.code, "E_PRICE");
  assert.equal((await web("u1", "/api/gtf/market/list", { item: "lockpick", qty: 5, price: 10, idem: "c-qty-001" })).body.code, "E_MISSING");
  assert.equal((await web("u5", "/api/gtf/market/list", { item: "lockpick", price: 10, idem: "c-link-01" })).body.code, "E_NOT_LINKED");
  const a = await web("u1", "/api/gtf/market/list", { item: "Body Armor", price: 20000, idem: "c-armor-1" });
  assert.equal(a.body.ok, true, "items by name too");
  assert.equal((await web("u1", "/api/gtf/market/list", { item: "armor", price: 20000, idem: "c-armor-2" })).body.code, "E_LISTED");
  await pepe(SHEETS);
  assert.deepEqual(SHEETS.ann_cf.gear, ["fence"], "listing gear takes it off (unequips it)");
  assert.equal((await L(a.body.listing.id)).status, "active");
});

test("a sale is one transaction: buyer pays, seller gets price - 5%, the fee to Fort Knox, delivery queued; supply unchanged", async () => {
  const s0 = await supply();
  const fk0 = await pool("fortknox");
  const b = await web("u2", "/api/gtf/market/buy", { id: ring, idem: "buy-ring-1" });
  assert.equal(b.body.ok, true, JSON.stringify(b.body));
  assert.equal(b.body.fee, 12500);
  assert.equal(b.body.net, 237500);
  assert.deepEqual(b.body.fee_legs, [["fortknox", 12500]]);
  assert.equal(await bal("u2"), 250000);
  assert.equal(await bal("u1"), 237500);
  assert.equal(await pool("fortknox"), fk0 + 12500);
  assert.equal(await supply(), s0, "no PAT made or destroyed - only the fee moved, buyer -> Fort Knox");
  const tx = await getQuery("SELECT userId, type, points, counterparty FROM transactions ORDER BY rowid");
  assert.deepEqual(tx.map((t) => [t.userId, t.type, t.points, t.counterparty]),
                   [["u2", "heist-market-buy", -250000, "ann"], ["u1", "heist-market-sale", 237500, "bob"]]);
  // a retry of the same click: already, nothing moves
  const again = await web("u2", "/api/gtf/market/buy", { id: ring, idem: "buy-ring-1" });
  assert.equal(again.body.already, true);
  assert.equal(await bal("u2"), 250000);
  // someone else is too late
  assert.equal((await web("u3", "/api/gtf/market/buy", { id: ring, idem: "buy-late-1" })).body.code, "E_NOT_ACTIVE");
  assert.equal((await L(ring)).status, "sold");
  const p = await pepe(SHEETS);
  assert.deepEqual(p.ops.map((o) => [o.op, o.login, o.item]), [["deliver", "bob", "kingpinring"]]);
  assert.deepEqual(p.ops[0].announce && [p.ops[0].announce.name, p.ops[0].announce.price, p.ops[0].announce.seller, p.ops[0].announce.buyer],
                   ["Kingpin's Ring", 250000, "ann_cf", "bob"], "a ring sale is announced");
  assert.equal(SHEETS.bob.items.kingpinring, 1);
  assert.equal((await L(ring)).status, "done");
  assert.deepEqual(awarded.filter((a) => a[0] === "u1"), [["u1", "hm_sales", 1], ["u1", "hm_ring_sales", 1]], "First sale + Fence");
  const h = await M.history("kingpinring");
  assert.equal(h.kingpinring.last, 250000);
});

test("one of each: a buyer who owns that gear is refused; a delivery Pepe refuses waits in the market (held) to be claimed", async () => {
  const armor = (await getQuery("SELECT id FROM heist_market_listings WHERE item = 'armor' AND status = 'active'"))[0].id;
  const r = await web("u3", "/api/gtf/market/buy", { id: armor, idem: "buy-armor-1" });
  assert.equal(r.body.code, "E_OWNED");
  assert.match(r.body.error, /already own Body Armor/);
  assert.equal(await bal("u3"), 500000, "nothing charged");
  // bob doesn't own armor (as far as the site knows) - but Pepe finds one (he got it in a heist a second ago): held
  const b = await web("u2", "/api/gtf/market/buy", { id: armor, idem: "buy-armor-2" });
  assert.equal(b.body.ok, true, JSON.stringify(b.body));
  SHEETS.bob.gear.push("armor");
  await pepe(SHEETS);
  assert.equal((await L(armor)).status, "held");
  assert.equal((await L(armor)).note, "owned");
  // a second armor can't be bought meanwhile (one per player, the held one counts)
  // ... bob drops his own armor (sold elsewhere) and claims it
  SHEETS.bob.gear = SHEETS.bob.gear.filter((g) => g !== "armor");
  assert.equal((await web("u3", "/api/gtf/market/claim", { id: armor })).body.code, "E_NOT_YOURS");
  assert.equal((await web("u2", "/api/gtf/market/claim", { id: armor })).body.status, "claiming");
  await pepe(SHEETS);
  assert.equal((await L(armor)).status, "done");
  assert.ok(SHEETS.bob.gear.includes("armor"));
});

test("self-dealing: your own listing and a linked account's are refused", async () => {
  const r = await web("u1", "/api/gtf/market/list", { item: "lockpick", qty: 2, price: 3000, idem: "c-lp-0001" });
  await pepe(SHEETS);
  const id = r.body.listing.id;
  assert.equal((await web("u1", "/api/gtf/market/buy", { id, idem: "buy-self-1" })).body.code, "E_SELF");
  assert.equal((await web("u4", "/api/gtf/market/buy", { id, idem: "buy-alt-01" })).body.code, "E_ALT");
  assert.equal((await L(id)).status, "active");
});

test("not enough PAT: refused, nothing moves, the listing stays up", async () => {
  await runQuery("UPDATE users SET points_balance = 100 WHERE userId = 'u3'");
  const id = (await getQuery("SELECT id FROM heist_market_listings WHERE item = 'lockpick' AND status = 'active'"))[0].id;
  const s0 = await supply();
  const r = await web("u3", "/api/gtf/market/buy", { id, idem: "buy-poor-1" });
  assert.equal(r.body.code, "E_INSUFFICIENT_PAT");
  assert.equal((await L(id)).status, "active");
  assert.equal(await bal("u3"), 100);
  assert.equal(await supply(), s0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM heist_market_ops WHERE done_at IS NULL"))[0].n, 0, "no delivery queued");
  await runQuery("UPDATE users SET points_balance = 500000 WHERE userId = 'u3'");
});

test("the fee follows the PAT Routing row heist_market_fee (an admin override wins; the rest to the Reserve)", async () => {
  assert.deepEqual(await M.feeShares(), [["fortknox", 100]], "default: Fort Knox");
  await runQuery("INSERT INTO pat_routes (flow, shares, updated, by) VALUES ('heist_market_fee', ?, 0, 'test')", [JSON.stringify([["heist", 50]])]);
  const id = (await getQuery("SELECT id FROM heist_market_listings WHERE item = 'lockpick' AND status = 'active'"))[0].id;
  const h0 = await pool("heist"), r0 = await pool("reserve");
  const b = await web("u3", "/api/gtf/market/buy", { id, idem: "buy-route-1" });
  assert.equal(b.body.fee, 150);
  assert.deepEqual(b.body.fee_legs, [["heist", 75], ["reserve", 75]]);
  assert.equal(await pool("heist"), h0 + 75);
  assert.equal(await pool("reserve"), r0 + 75);
  assert.deepEqual(M.splitShares([["fortknox", 33.33]], 10), [["fortknox", 3], ["reserve", 7]], "rounding remainder never burned");
  await runQuery("DELETE FROM pat_routes WHERE flow = 'heist_market_fee'");
  await pepe(SHEETS);
});

test("delist: back into the loadout; while still escrowing it comes back as soon as Pepe has it; Pepe can't find it -> void", async () => {
  const a = await web("u2", "/api/gtf/market/list", { item: "lockpick", qty: 1, price: 900, idem: "c-bob-lp-1" });
  const d = await web("u2", "/api/gtf/market/delist", { id: a.body.listing.id });
  assert.equal(d.body.cancel, true, "escrowing: taken down when Pepe has it");
  const before = SHEETS.bob.items.lockpick;
  await pepe(SHEETS);
  assert.equal((await L(a.body.listing.id)).status, "returning");
  await pepe(SHEETS);
  assert.equal((await L(a.body.listing.id)).status, "delisted");
  assert.equal(SHEETS.bob.items.lockpick, before, "the lockpick is back");
  const v = await web("u2", "/api/gtf/market/list", { item: "lockpick", qty: 1, price: 900, idem: "c-bob-lp-2" });
  const k = (await bot("/api/gtf/bot/market/ops", {})).body.ops[0].key;
  await pepe(SHEETS, { [k]: "missing" });
  assert.equal((await L(v.body.listing.id)).status, "void");
  assert.equal((await web("u1", "/api/gtf/market/delist", { id: v.body.listing.id })).body.code, "E_NOT_YOURS");
});

test("admins: delist anyone's listing (the seller gets the item back); the config", async () => {
  const a = await web("u2", "/api/gtf/market/list", { item: "lockpick", qty: 1, price: 900, idem: "c-bob-lp-3" });
  await pepe(SHEETS);
  assert.equal((await web("u3", "/api/admin/heist-market/delist", { id: a.body.listing.id })).body.code, "E_ADMIN");
  const r = await web("u9", "/api/admin/heist-market/delist", { id: a.body.listing.id, reason: "price typo" });
  assert.equal(r.body.status, "returning");
  assert.match((await L(a.body.listing.id)).note, /admin: price typo/);
  await pepe(SHEETS);
  assert.equal((await L(a.body.listing.id)).status, "delisted");
  const c = await web("u9", "/api/admin/heist-market", { config: { fee_pct: 7.5, list_per_hour: 3, untradable: ["fence"] } });
  assert.equal(c.body.config.fee_pct, 7.5);
  assert.equal((await web("u1", "/api/gtf/market/list", { item: "fence", price: 5, idem: "c-fence-1" })).body.code, "E_UNTRADABLE");
  // the hourly rate limit (bob listed 3 times this hour already)
  assert.equal((await web("u2", "/api/gtf/market/list", { item: "lockpick", price: 5, idem: "c-bob-lp-9" })).body.code, "E_RATE");
  await M.setConfig({ fee_pct: 5, list_per_hour: 10, untradable: [] });
});

test("the pawn shop: OFF by default; on, the House (Casino vault) pays rate x shop price once Pepe has the item; loot needs a value", async () => {
  assert.equal((await M.config()).pawn_on, false);
  assert.equal((await web("u2", "/api/gtf/market/pawn", { item: "lockpick", qty: 2, idem: "p-bob-0001" })).body.code, "E_PAWN_OFF");
  await M.setConfig({ pawn_on: true });
  assert.equal((await web("u2", "/api/gtf/market/pawn", { item: "kingpinring", idem: "p-bob-0002" })).body.code, "E_NO_VALUE");
  const s0 = await supply(), h0 = await pool("heist"), b0 = await bal("u2"), n0 = SHEETS.bob.items.lockpick;
  const r = await web("u2", "/api/gtf/market/pawn", { item: "lockpick", qty: 2, idem: "p-bob-0003" });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.pay, 800, "40% of 2 x 1,000");
  assert.equal(await bal("u2"), b0, "nothing paid before Pepe has the item");
  await pepe(SHEETS);
  assert.equal((await L(r.body.listing.id)).status, "pawned");
  assert.equal(await bal("u2"), b0 + 800);
  assert.equal(await pool("heist"), h0 - 800);
  assert.equal(SHEETS.bob.items.lockpick, n0 - 2);
  assert.equal(await supply(), s0, "the House paid: pool -> wallet");
  // the House can't cover it -> refused up front
  await M.setConfig({ pawn_values: { kingpinring: 10000000 } });
  assert.equal((await web("u2", "/api/gtf/market/pawn", { item: "kingpinring", idem: "p-bob-0004" })).body.code, "E_HOUSE_SHORT");
  await M.setConfig({ pawn_on: false, pawn_values: {} });
});

test("Pepe's chat side: browse / list / buy / mine by Camfrog login", async () => {
  const l = await bot("/api/gtf/bot/market/act", { op: "list", login: "BOB", item: "lockpick", qty: 1, price: "1.5k", key: "chat-bob-lp-1" });
  assert.equal(l.body.ok, true, JSON.stringify(l.body));
  await pepe(SHEETS);
  const br = await bot("/api/gtf/bot/market/act", { op: "browse", login: "cat", item: "lockpick" });
  assert.ok(br.body.listings.some((x) => x.id === l.body.listing.id && x.price === 1500));
  const b = await bot("/api/gtf/bot/market/act", { op: "buy", login: "cat", id: l.body.listing.id, key: "chat-cat-buy-1" });
  assert.equal(b.body.ok, true, JSON.stringify(b.body));
  assert.equal((await bot("/api/gtf/bot/market/act", { op: "buy", login: "nobody", id: 1, key: "chat-x-buy-1" })).body.code, "E_NOT_LINKED");
  assert.equal((await post("/api/gtf/bot/market/ops", { password: "nope" })).status, 403);
  const mine = await bot("/api/gtf/bot/market/act", { op: "mine", login: "bob" });
  assert.ok(Array.isArray(mine.body.mine));
  await pepe(SHEETS);
});

test("the page renders for visitors, members and admins; web calls need a same-site fetch", async () => {
  cookieUser = null;
  let html = await (await fetch(base + "/gtf/market")).text();
  assert.match(html, /Heist market/);
  assert.match(html, /Sign in/);
  cookieUser = "u2";
  html = await (await fetch(base + "/gtf/market")).text();
  assert.match(html, /SELL AN ITEM/);
  assert.match(html, /YOUR LISTINGS/);
  cookieUser = "u9";
  html = await (await fetch(base + "/gtf/market")).text();
  assert.match(html, /MARKET SETTINGS/);
  cookieUser = "u2";
  const r = await post("/api/gtf/market/list", { item: "lockpick", price: 5, idem: "c-xsite-01" });
  assert.equal(r.status, 403);
});

test("the market achievements: catalog rows (bot side, counted by the site), badge art, en.json strings", () => {
  const cat = JSON.parse(fs.readFileSync(path.join(repo, "achievements.json"), "utf8")).achievements;
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  for (const [id, metric] of [["cf_hm_sale_1", "hm_sales"], ["cf_hm_ring", "hm_ring_sales"]]) {
    const a = cat.find((x) => x.id === id);
    assert.ok(a, id);
    assert.deepEqual([a.metric, a.threshold, a.side], [metric, 1, "bot"]);
    assert.ok(fs.existsSync(path.join(repo, "public", "img", "badges", "ach", id + ".png")), id + " art");
    assert.equal(en["ach.n." + id], a.name);
  }
});
