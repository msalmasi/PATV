// 1.99xk: 🎫 PAT Raffles (raffles.js) - site-owned raffles: escrowed tickets, provably fair draws, Pepe a chat client.
//   * the switch (raffles_meta.enabled: off unless STAGING), the escrow must be live, only verified accounts create
//   * a PAT prize is escrowed at creation; tickets are escrow holds (RFT) with contiguous numbers; buys are idempotent;
//     the creator and their linked alts can't buy; max per person, the cap, the purchase limit
//   * the target trigger draws on the purchase that reaches it: the winner gets the prize, the creator the pot minus the fee,
//     the fee goes by the PAT Routing row raffle_fee (House by default, an override wins); supply never moves
//   * the draw is provably fair: commitment = sha256(seed), the digest, the winning number re-derive; tampering shows
//   * the date trigger with the minimum unmet keeps selling and refunds everything at the expiry (injected clock)
//   * a Prize Shop item: one reserved from stock, the creator's price escrowed; expiry puts it back; a draw makes the order
//   * house raffles: the pot to the House, a PAT prize paid by the House, announced in every room
//   * custom prizes: the pot waits for the winner (confirm / the hold window / a dispute -> admin refund)
//   * takedown refunds everything; rate limits; Pepe's verbs + events; the pages and the embed card render
//   NODE_PATH=G:/PATV/node_modules node --test test/raffles.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "raffles-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.RAFFLES_NO_TIMER = "1";
// achievements are the site's big module: record the pokes instead
const poked = [];
require.cache[require.resolve(path.join(repo, "achievements"))] = {
  id: "ach", filename: "ach", loaded: true, exports: { poke: (...ids) => poked.push(...ids), awardCount: async () => [], checkWeb: () => {} },
};
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const P = require(path.join(repo, "pools"));
const E = require(path.join(repo, "econstore"));
const ESC = require(path.join(repo, "escrow", "ledger"));
const S = require(path.join(repo, "shop"));
const RF = require(path.join(repo, "raffles"));

const DAY = 86400000, HOUR = 3600000;
let T = Date.UTC(2026, 9, 13, 12, 0, 0);
RF._setClock(() => T);
const U = {};
async function mkUser(name, { cls = "pleb", bal = 10000000, camfrog = null, email = 1 } = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, isEmailVerified, email)
                  VALUES (?, ?, ?, 'x', ?, ?, ?, ?, ?)`, [id, name, name, cls, bal, camfrog, email, email ? name + "@example.com" : null]);
  U[name] = { userId: id, username: name };
  return U[name];
}
const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [u.userId || u]))[0].b;
const house = async () => Number((await getQuery("SELECT COALESCE(SUM(amount),0) AS s FROM jackpot_rakes"))[0].s);
const held = async () => (await ESC.heldTotal()).amount;
const supply = async () => Number((await getQuery("SELECT SUM(points_balance) AS s FROM users"))[0].s) + (await house()) + (await P.total()).amount + (await held());
let SUPPLY0 = 0;
const raffle = async (id) => (await getQuery("SELECT * FROM raffles WHERE id = ?", [id]))[0];
let n = 0;
const idem = () => "idem" + String(++n).padStart(8, "0");
const refused = (code) => (e) => { assert.equal(e.code, code, `${e.code}: ${e.message}`); return true; };

let base, server, cookieUser = null;
const req = (method, p, body, headers = {}) => fetch(base + p, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined })
  .then(async (r) => ({ status: r.status, text: await r.text() }));
const web = (who, p, body) => { cookieUser = who && who.userId; return req("POST", p, body, { "X-Requested-With": "fetch", origin: base }).then((r) => ({ status: r.status, body: JSON.parse(r.text) })); };
const page = (who, p) => { cookieUser = who && who.userId; return req("GET", p); };
const bot = (p, body) => req("POST", p, Object.assign({ password: "bot" }, body)).then((r) => ({ status: r.status, body: JSON.parse(r.text) }));

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordId TEXT, twitchId TEXT, level INTEGER DEFAULT 0,
                  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, isEmailVerified INTEGER DEFAULT 0, email TEXT,
                  extra_daily_spins INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT, note TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery(`CREATE TABLE reserve_claims (claimId TEXT PRIMARY KEY, flow TEXT NOT NULL, userId TEXT, type TEXT, amount INTEGER NOT NULL,
                  created DATETIME DEFAULT CURRENT_TIMESTAMP, settled INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE welcome_bonus (userId TEXT PRIMARY KEY, dup_of TEXT)");
  await runQuery("CREATE TABLE IF NOT EXISTS user_roles (userId TEXT, role TEXT, source TEXT, PRIMARY KEY (userId, role))");
  await mkUser("maker", { camfrog: "makercf" });
  await mkUser("ann", { camfrog: "ann_cf" });
  await mkUser("bob");
  await mkUser("cat");
  await mkUser("dan");
  await mkUser("alt");                                  // maker's second account
  await mkUser("unverified", { email: 0 });
  await mkUser("poor", { bal: 500 });
  await mkUser("boss", { cls: "Admin", camfrog: "bosscf" });
  await mkUser("boss2", { cls: "Admin", camfrog: "boss2cf" });          // an Admin who isn't a Pepe owner
  await require(path.join(repo, "staffroles")).init();
  await runQuery("INSERT INTO pepe_roles (login, role, ts) VALUES ('bosscf', 'owner', 1), ('boss2cf', 'admin', 1)");
  await mkUser("pb", { bal: 0 });                        // the store owner
  await runQuery("INSERT INTO welcome_bonus (userId, dup_of) VALUES ('u_alt', 'u_maker')");
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES ('seed', 'seed', NULL, 50000000)");
  await rooms.init();
  await P.init(); await E.init(); await ESC.init();
  await P._setMeta("live", true); P._forgetLive();
  await runQuery("INSERT INTO pools (key, balance, updated) VALUES ('fortknox', 0, 0), ('reserve', 0, 0), ('mm', 0, 0)");
  await S.ready;
  await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity) VALUES ('9c0aa228-e0c4-46dd-97cc-dc41a245bc05', 'PS5 Pro', 400000, 2)");
  await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity) VALUES ('spinboost100', '+100 Daily Gold Spins', 3000000, 50)");
  await require(path.join(repo, "inbox")).ready;
  await RF.init();
  await RF.setConfig({ per_day: 100, open_max: 100 });      // the abuse-limit test sets its own
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { if (cookieUser) req.user = { userId: cookieUser, username: cookieUser.replace(/^u_/, "") }; next(); });
  const addUser = (req, res, next) => next();
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  RF.register(app, { isBotToken: (t) => t === "bot", addUser, noTimers: true });
  require(path.join(repo, "embedcards")).register(app, { addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  SUPPLY0 = await supply();
});
test.after(() => server && server.close());

const PAT_RAFFLE = (o = {}) => Object.assign({ title: "Friday mega raffle", prize_kind: "pat", prize_amount: "100k", price: 1000, trigger: "target", target: 5,
                                               min_tickets: 1, idem: idem() }, o);

test("the switch is off without STAGING; the escrow must be live; only verified accounts create", async () => {
  await assert.rejects(RF.create(U.maker.userId, PAT_RAFFLE()), refused("E_OFF"));
  assert.equal((await web(U.boss, "/api/admin/raffles", { enabled: true })).body.enabled, true);
  assert.equal((await web(U.maker, "/api/admin/raffles", { enabled: false })).status, 403, "admins only");
  await assert.rejects(RF.create(U.maker.userId, PAT_RAFFLE()), refused("E_ESCROW_NOT_LIVE"));
  await ESC.setMeta("live", true); ESC._forgetLive();
  await assert.rejects(RF.create(U.unverified.userId, PAT_RAFFLE()), refused("E_VERIFY"));
  // and a cross-site post is refused before anything
  cookieUser = U.maker.userId;
  const x = await req("POST", "/api/raffles/create", PAT_RAFFLE(), { origin: "https://evil.example" });
  assert.equal(x.status, 403);
});

let R1;
test("create a PAT raffle: the prize goes into escrow (RFP), a commitment is published, the same key is one raffle", async () => {
  const before = await bal(U.maker);
  const body = PAT_RAFFLE({ idem: "make-r1-0001" });
  const r = await web(U.maker, "/api/raffles/create", body);
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  R1 = r.body.id;
  assert.equal(await bal(U.maker), before - 100000);
  const row = await raffle(R1);
  assert.equal(row.status, "open");
  assert.equal(row.commitment, crypto.createHash("sha256").update(row.server_seed).digest("hex"));
  const h = (await getQuery("SELECT * FROM escrow_holds WHERE id = ?", [row.prize_hold]))[0];
  assert.deepEqual([h.kind, h.amount, h.state], ["RFP", 100000, "held"]);
  assert.ok(ESC.isServiceKind("RFP") && ESC.isServiceKind("RFT") && ESC.isServiceKind("RFI"), "raffle holds are a site service's, never Pepe's");
  assert.equal((await ESC.holdsHeld()).length, 0, "not in Pepe's mirror");
  const again = await web(U.maker, "/api/raffles/create", body);
  assert.equal(again.body.dup, true);
  assert.equal(again.body.id, R1);
  assert.equal(await bal(U.maker), before - 100000, "charged once");
  // the seed is secret while it's open
  const v = await RF.detail(R1, null);
  assert.equal(v.server_seed, undefined);
  assert.equal(await supply(), SUPPLY0);
});

test("validation: prizes, prices, triggers, expiry, pictures, text guard", async () => {
  const bad = async (o, code) => assert.rejects(RF.create(U.maker.userId, PAT_RAFFLE(o)), refused(code));
  await bad({ prize_amount: 10 }, "E_PRIZE");
  await bad({ price: 0 }, "E_PRICE");
  await bad({ price: "2m" }, "E_PRICE");                       // over the 1M ticket price cap
  await bad({ target: 0 }, "E_TARGET");
  await bad({ min_tickets: 10, target: 5 }, "E_TARGET");
  await bad({ trigger: "date", draw_at: T + 60000 }, "E_DRAW_AT");
  await bad({ trigger: "date", draw_at: T + DAY, expires_at: T + DAY + 60000 }, "E_EXPIRY");
  await bad({ expires_at: T + 40 * DAY }, "E_EXPIRY");
  await bad({ image_url: "https://example.com/x.png" }, "E_IMAGE");
  await bad({ title: "send me your pat" }, "E_TEXT");
  await bad({ prize_kind: "item", prize_item: "spinboost100" }, "E_ITEM");     // the per-owner spin boost can't be raffled
  await bad({ title: "x" }, "E_TITLE");
  // 1.99xl: "PATV Friday ..." isn't a pad code (that check is for room topics)
  const ok = await RF.create(U.maker.userId, PAT_RAFFLE({ title: "PATV Friday Mega Raffle", prize_amount: 1000 }));
  await RF.cancel(U.maker.userId, ok.id);
});

test("buy: numbers are contiguous, the hold is escrowed, the same key is one purchase; the creator and their alt can't buy", async () => {
  const a = await web(U.ann, `/api/raffles/${R1}/buy`, { qty: 2, idem: "ann-buy-0001", expect: 1000 });
  assert.equal(a.body.ok, true, JSON.stringify(a.body));
  assert.deepEqual([a.body.from, a.body.to], [1, 2]);
  const again = await web(U.ann, `/api/raffles/${R1}/buy`, { qty: 2, idem: "ann-buy-0001", expect: 1000 });
  assert.equal(again.body.dup, true);
  assert.equal(await bal(U.ann), 10000000 - 2000);
  const b = await web(U.bob, `/api/raffles/${R1}/buy`, { qty: 1, idem: "bob-buy-0001" });
  assert.deepEqual([b.body.from, b.body.to], [3, 3]);
  assert.equal((await web(U.maker, `/api/raffles/${R1}/buy`, { qty: 1, idem: "self-buy-001" })).body.code, "E_SELF");
  assert.equal((await web(U.alt, `/api/raffles/${R1}/buy`, { qty: 1, idem: "alt-buy-0001" })).body.code, "E_SELF");
  assert.equal((await web(U.poor, `/api/raffles/${R1}/buy`, { qty: 1, idem: "poor-buy-001" })).body.code, "E_INSUFFICIENT_PAT");
  assert.equal((await web(U.cat, `/api/raffles/${R1}/buy`, { qty: 9, idem: "cat-buy-0001" })).body.code, "E_SOLD_OUT", "only 2 left of the target");
  assert.equal((await web(U.cat, `/api/raffles/${R1}/buy`, { qty: 1, idem: "cat-buy-0002", expect: 5 })).body.code, "E_PRICE_CHANGED");
  const row = await raffle(R1);
  assert.deepEqual([row.sold, row.pot, row.buyers, row.status], [3, 3000, 2, "open"]);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM escrow_holds WHERE kind = 'RFT' AND state = 'held'"))[0].n, 2);
  assert.equal(await supply(), SUPPLY0);
});

test("the target trigger draws on the purchase that reaches it: prize to the winner, pot minus 10% to the creator, the fee to the House", async () => {
  const makerBefore = await bal(U.maker), houseBefore = await house();
  const c = await web(U.cat, `/api/raffles/${R1}/buy`, { qty: 2, idem: "cat-buy-0003" });
  assert.equal(c.body.ok, true, JSON.stringify(c.body));
  assert.equal(c.body.drawn, true);
  const row = await raffle(R1);
  assert.equal(row.status, "drawn");
  assert.equal(row.sold, 5);
  assert.equal(row.fee, 500);
  assert.equal(row.creator_payout, 4500);
  assert.equal(await bal(U.maker), makerBefore + 4500);
  assert.equal(await house(), houseBefore + 500, "raffle_fee: the House by default");
  const winner = row.winner_id;
  const owner = { u_ann: [1, 2], u_bob: [3, 3], u_cat: [4, 5] }[winner];
  assert.ok(row.winning_no >= owner[0] && row.winning_no <= owner[1], "the winner holds the winning ticket");
  const tx = (await getQuery("SELECT points FROM transactions WHERE userId = ? AND type = 'raffle prize'", [winner]))[0];
  assert.equal(tx.points, 100000);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM escrow_holds WHERE ref IN (?, ?) AND state = 'held'", [`RFT-${R1}`, `RFP-${R1}`]))[0].n, 0);
  assert.equal(await supply(), SUPPLY0);
  assert.ok(poked.includes(winner), "achievements poked");
  // a draw again is a no-op
  assert.equal((await RF.draw(R1)).drawn, false);
  assert.equal(await supply(), SUPPLY0);
});

test("provably fair: the commitment, the digest and the winning number re-derive; a tampered seed / ticket list fails", async () => {
  const row = await raffle(R1);
  const tickets = await getQuery("SELECT first_no, last_no, username FROM raffle_tickets WHERE raffle_id = ? ORDER BY first_no", [R1]);
  const rec = { id: R1, commitment: row.commitment, server_seed: row.server_seed, tickets_digest: row.tickets_digest, sold: row.sold, winning_no: row.winning_no, tickets };
  assert.deepEqual(RF.verify(rec), { ok: true, commitment_ok: true, digest_ok: true, number_ok: true, number: row.winning_no });
  assert.equal(RF.verify(Object.assign({}, rec, { server_seed: "f".repeat(64) })).commitment_ok, false);
  assert.equal(RF.verify(Object.assign({}, rec, { tickets: tickets.map((t, i) => (i ? t : Object.assign({}, t, { username: "someoneelse" }))) })).digest_ok, false);
  // the winning number is uniform-ish over many seeds (no modulo bias, every ticket reachable)
  const hits = new Array(7).fill(0);
  for (let i = 0; i < 7000; i++) hits[RF.winningNumber("seed" + i, "digest", 1, 7) - 1]++;
  for (const h of hits) assert.ok(h > 850 && h < 1150, "roughly 1/7 each: " + hits.join(","));
  // the public record (the page's browser check reads it)
  const f = await req("GET", `/api/raffles/${R1}/fair`);
  const j = JSON.parse(f.text);
  assert.equal(j.server_seed, row.server_seed);
  assert.equal(j.tickets.length, 3);
  const clientLine = require(path.join(repo, "public", "js", "raffles.js")).ticketLine;
  assert.equal(crypto.createHash("sha256").update(j.tickets.map(clientLine).join("")).digest("hex"), row.tickets_digest, "the browser's ticket lines = the server's");
});

test("the fee follows the PAT Routing row raffle_fee (an admin override wins; pool legs while the pools are live)", async () => {
  await E.putSettings({ pat_routes: { raffle_fee: [["reserve", 60], ["fortknox", 40]] }, by: "test" }).catch(async () => {
    await runQuery("INSERT INTO pat_routes (flow, shares, updated, by) VALUES ('raffle_fee', ?, 0, 'test')", [JSON.stringify([["reserve", 60], ["fortknox", 40]])]);
  });
  assert.deepEqual(await RF.feeLegs(1000), [["reserve", 600], ["fortknox", 400]]);
  const r = await RF.create(U.maker.userId, PAT_RAFFLE({ target: 2, prize_amount: 5000, price: 10000 }));
  const res = await RF.buy(U.ann.userId, { id: r.id, qty: 1, idem: "ann-fee-0001" });
  assert.equal(res.ok, true);
  const rv = await P.balance("reserve"), fk = await P.balance("fortknox");
  await RF.buy(U.bob.userId, { id: r.id, qty: 1, idem: "bob-fee-0001" });
  assert.equal((await raffle(r.id)).status, "drawn");
  assert.equal(await P.balance("reserve"), rv + 1200);
  assert.equal(await P.balance("fortknox"), fk + 800);
  await runQuery("DELETE FROM pat_routes WHERE flow = 'raffle_fee'");
  assert.deepEqual(await RF.feeLegs(1000), [["jackpot", 1000]], "no override -> the House");
  assert.equal(await supply(), SUPPLY0);
});

test("the date trigger with the minimum unmet keeps selling past the draw date and refunds everything at the expiry", async () => {
  const before = await bal(U.maker);
  const r = await RF.create(U.maker.userId, PAT_RAFFLE({ trigger: "date", draw_at: T + DAY, expires_at: T + 3 * DAY, min_tickets: 5, target: undefined, prize_amount: 20000 }));
  await RF.buy(U.ann.userId, { id: r.id, qty: 2, idem: "ann-date-001" });
  await RF.buy(U.bob.userId, { id: r.id, qty: 1, idem: "bob-date-001" });
  const ann = await bal(U.ann), bob = await bal(U.bob);
  T += DAY + HOUR;                                        // past the draw date
  await RF.tick();
  assert.equal((await raffle(r.id)).status, "open", "the minimum isn't met - it waits");
  T += 2 * DAY;                                           // past the expiry
  const out = await RF.tick();
  assert.equal(out.expired, 1);
  const row = await raffle(r.id);
  assert.equal(row.status, "expired");
  assert.equal(await bal(U.ann), ann + 2000);
  assert.equal(await bal(U.bob), bob + 1000);
  assert.equal(await bal(U.maker), before, "the prize came back");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM raffle_tickets WHERE raffle_id = ? AND state = 'refunded'", [r.id]))[0].n, 2);
  assert.equal(await supply(), SUPPLY0);
  // buying an expired raffle is refused
  assert.equal((await web(U.cat, `/api/raffles/${r.id}/buy`, { qty: 1, idem: "cat-late-001" })).body.code, "E_CLOSED");
});

test("a date raffle whose minimum is met after its draw date draws on that purchase", async () => {
  const r = await RF.create(U.maker.userId, PAT_RAFFLE({ trigger: "date", draw_at: T + HOUR, expires_at: T + 2 * DAY, min_tickets: 2, target: undefined, prize_amount: 3000 }));
  await RF.buy(U.ann.userId, { id: r.id, qty: 1, idem: "ann-date-002" });
  T += 2 * HOUR;
  await RF.tick();
  assert.equal((await raffle(r.id)).status, "open");
  const b = await RF.buy(U.bob.userId, { id: r.id, qty: 1, idem: "bob-date-002" });
  assert.equal(b.drawn, true);
  assert.equal((await raffle(r.id)).status, "drawn");
  assert.equal(await supply(), SUPPLY0);
});

test("a Prize Shop item: one reserved from stock + the creator's price escrowed; expiry puts both back; a draw makes the winner's order", async () => {
  const PS5 = "9c0aa228-e0c4-46dd-97cc-dc41a245bc05";
  const stock = async () => (await getQuery("SELECT quantity, sold FROM prizes WHERE prizeId = ?", [PS5]))[0];
  const items = await S.raffleItems();
  assert.deepEqual(items.map((i) => i.prizeId), [PS5], "the spin boost isn't raffleable");
  const before = await bal(U.maker);
  const r = await RF.create(U.maker.userId, PAT_RAFFLE({ prize_kind: "item", prize_item: PS5, target: 3, expires_at: T + DAY }));
  assert.equal((await stock()).quantity, 1, "one reserved");
  assert.equal(await bal(U.maker), before - 400000, "the item's shop price into escrow");
  assert.equal((await getQuery("SELECT kind FROM escrow_holds WHERE ref = ?", [`RFI-${r.id}`]))[0].kind, "RFI");
  await RF.buy(U.ann.userId, { id: r.id, qty: 1, idem: "ann-item-001" });
  T += DAY + 1;
  await RF.tick();
  assert.equal((await raffle(r.id)).status, "expired");
  assert.equal((await stock()).quantity, 2, "back in stock");
  assert.equal(await bal(U.maker), before, "the price came back");
  // now one that draws
  const r2 = await RF.create(U.maker.userId, PAT_RAFFLE({ prize_kind: "item", prize_item: PS5, target: 2 }));
  const pb = await bal(U.pb);
  await RF.buy(U.ann.userId, { id: r2.id, qty: 1, idem: "ann-item-002" });
  await RF.buy(U.bob.userId, { id: r2.id, qty: 1, idem: "bob-item-002" });
  const row = await raffle(r2.id);
  assert.equal(row.status, "drawn");
  assert.equal(await bal(U.pb), pb + 400000, "the store owner is paid the item's price, like a sale");
  const o = (await getQuery("SELECT * FROM shop_orders WHERE id = ?", [row.order_id]))[0];
  assert.deepEqual([o.buyer_id, o.status, o.source, o.official, o.prize_id], [row.winner_id, "completed", "raffle", 1, PS5]);
  const st = await stock();
  assert.deepEqual([st.quantity, st.sold], [1, 1]);
  assert.equal(await supply(), SUPPLY0);
  // a sold-out item can't be put up
  await runQuery("UPDATE prizes SET quantity = 0 WHERE prizeId = ?", [PS5]);
  await assert.rejects(RF.create(U.maker.userId, PAT_RAFFLE({ prize_kind: "item", prize_item: PS5 })), refused("E_ITEM"));
  await runQuery("UPDATE prizes SET quantity = 1 WHERE prizeId = ?", [PS5]);
});

test("house raffles: admins only, first in the list, the pot to the House, a PAT prize paid by the House, announced everywhere", async () => {
  const notAdmin = await RF.create(U.ann.userId, PAT_RAFFLE({ house: true, target: 2 }));
  assert.equal((await raffle(notAdmin.id)).house, 0, "the house flag needs an admin");
  // review of the owner answers 2026-10-20 (1): a House PAT prize moves the House's PAT to the winner - a Pepe OWNER's. An Admin
  // who isn't one is refused (nothing created); a House raffle with a custom prize moves no House PAT and stays an Admin's
  await assert.rejects(RF.create(U.boss2.userId, PAT_RAFFLE({ house: true, target: 2 })), refused("owner_only"));
  const cu = await RF.create(U.boss2.userId, PAT_RAFFLE({ house: true, target: 2, prize_kind: "custom", prize_text: "A shout-out on stream" }));
  assert.equal((await raffle(cu.id)).house, 1);
  await RF.cancel(U.boss2.userId, cu.id);
  const h0 = await house();
  const r = await RF.create(U.boss.userId, PAT_RAFFLE({ house: true, target: 2, prize_amount: 50000, price: 2000 }));
  const row0 = await raffle(r.id);
  assert.deepEqual([row0.house, row0.prize_hold, row0.fee_pct], [1, null, 0], "no prize hold: the House pays at the draw");
  const L = await RF.list({ status: "open" });
  assert.equal(L.house[0].id, r.id);
  await RF.buy(U.cat.userId, { id: r.id, qty: 1, idem: "cat-house-01" });
  const winnerBal = await bal(U.dan);
  await RF.buy(U.dan.userId, { id: r.id, qty: 1, idem: "dan-house-01" });
  const row = await raffle(r.id);
  assert.equal(row.status, "drawn");
  assert.equal(await house(), h0 + 4000 - 50000, "the pot in, the prize out");
  if (row.winner_id === U.dan.userId) assert.equal(await bal(U.dan), winnerBal - 2000 + 50000);
  const ev = (await getQuery("SELECT data FROM raffle_events WHERE raffle_id = ? AND kind = 'created'", [r.id]))[0];
  assert.deepEqual(JSON.parse(ev.data).rooms, ["*"]);
  assert.equal(await supply(), SUPPLY0);
  await RF.cancel(U.ann.userId, notAdmin.id);
});

test("custom prizes: the pot waits for the winner - confirm pays the creator; a dispute goes to an admin who can refund everyone", async () => {
  const r = await RF.create(U.maker.userId, PAT_RAFFLE({ prize_kind: "custom", prize_text: "A custom avatar drawn by me", target: 2, price: 5000 }));
  await RF.buy(U.ann.userId, { id: r.id, qty: 1, idem: "ann-cust-001" });
  const makerBefore = await bal(U.maker);
  await RF.buy(U.bob.userId, { id: r.id, qty: 1, idem: "bob-cust-001" });
  let row = await raffle(r.id);
  assert.equal(row.status, "delivering");
  assert.equal(await bal(U.maker), makerBefore, "nothing paid yet");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM escrow_holds WHERE ref = ? AND state = 'held'", [`RFT-${r.id}`]))[0].n, 2);
  const loser = row.winner_id === U.ann.userId ? U.bob : U.ann;
  const winner = row.winner_id === U.ann.userId ? U.ann : U.bob;
  assert.equal((await web(loser, `/api/raffles/${r.id}/confirm`, {})).body.code, "E_NOT_WINNER");
  const ok = await web(winner, `/api/raffles/${r.id}/confirm`, {});
  assert.equal(ok.body.ok, true, JSON.stringify(ok.body));
  assert.equal(await bal(U.maker), makerBefore + 9000, "10,000 pot minus the 10% fee");
  assert.equal((await raffle(r.id)).status, "complete");
  // a second one: disputed, then refunded by an admin
  const r2 = await RF.create(U.maker.userId, PAT_RAFFLE({ prize_kind: "custom", prize_text: "Signed photo", target: 2, price: 5000 }));
  const a0 = await bal(U.ann), b0 = await bal(U.bob);
  await RF.buy(U.ann.userId, { id: r2.id, qty: 1, idem: "ann-cust-002" });
  await RF.buy(U.bob.userId, { id: r2.id, qty: 1, idem: "bob-cust-002" });
  row = await raffle(r2.id);
  const w2 = row.winner_id === U.ann.userId ? U.ann : U.bob;
  assert.equal((await web(w2, `/api/raffles/${r2.id}/dispute`, { note: "never got it" })).body.status, "disputed");
  assert.equal((await web(w2, `/api/raffles/${r2.id}/confirm`, {})).body.code, "E_STATE");
  assert.equal((await web(U.maker, `/api/raffles/${r2.id}/decide`, { decision: "refund" })).status, 403);
  const d = await web(U.boss, `/api/raffles/${r2.id}/decide`, { decision: "refund", reason: "not delivered" });
  assert.equal(d.body.status, "refunded");
  assert.equal(await bal(U.ann), a0);
  assert.equal(await bal(U.bob), b0);
  // a third: released by the hold window
  const r3 = await RF.create(U.maker.userId, PAT_RAFFLE({ prize_kind: "custom", prize_text: "A shoutout", target: 1, price: 2000 }));
  await RF.buy(U.cat.userId, { id: r3.id, qty: 1, idem: "cat-cust-003" });
  assert.equal((await raffle(r3.id)).status, "delivering");
  const m3 = await bal(U.maker);
  T += 6 * DAY; await RF.tick();
  assert.equal((await raffle(r3.id)).status, "delivering");
  T += DAY + 1; const t = await RF.tick();
  assert.equal(t.released, 1);
  assert.equal(await bal(U.maker), m3 + 1800);
  assert.equal(await supply(), SUPPLY0);
});

test("admin takedown refunds every ticket and the prize; creators cancel only before a sale", async () => {
  const before = await bal(U.maker);
  const r = await RF.create(U.maker.userId, PAT_RAFFLE({ target: 10, prize_amount: 7000 }));
  await RF.buy(U.ann.userId, { id: r.id, qty: 3, idem: "ann-take-001" });
  const ann = await bal(U.ann);
  assert.equal((await web(U.maker, `/api/raffles/${r.id}/cancel`, {})).body.code, "E_SOLD");
  assert.equal((await web(U.ann, `/api/raffles/${r.id}/takedown`, { reason: "spam" })).status, 403);
  const t = await web(U.boss, `/api/raffles/${r.id}/takedown`, { reason: "misleading prize" });
  assert.equal(t.body.ok, true, JSON.stringify(t.body));
  assert.equal((await raffle(r.id)).status, "removed");
  assert.equal(await bal(U.ann), ann + 3000);
  assert.equal(await bal(U.maker), before);
  const ev = (await getQuery("SELECT kind FROM raffle_events WHERE raffle_id = ? ORDER BY id DESC LIMIT 1", [r.id]))[0];
  assert.equal(ev.kind, "removed");
  const c = await RF.create(U.maker.userId, PAT_RAFFLE({ prize_amount: 1000 }));
  assert.equal((await web(U.maker, `/api/raffles/${c.id}/cancel`, {})).body.ok, true);
  assert.equal(await bal(U.maker), before);
  assert.equal(await supply(), SUPPLY0);
});

test("abuse limits: open raffles per creator, raffles per day, max per person, 1,000 tickets a purchase; no raffle-size cap", async () => {
  await RF.setConfig({ open_max: 2, per_day: 50 });
  const a = await RF.create(U.dan.userId, PAT_RAFFLE({ prize_amount: 1000 }));
  await RF.create(U.dan.userId, PAT_RAFFLE({ prize_amount: 1000 }));
  await assert.rejects(RF.create(U.dan.userId, PAT_RAFFLE({ prize_amount: 1000 })), refused("E_OPEN_MAX"));
  await RF.setConfig({ open_max: 50, per_day: 2 });
  await assert.rejects(RF.create(U.dan.userId, PAT_RAFFLE({ prize_amount: 1000 })), refused("E_RATE"));
  await RF.setConfig({ ...RF.DEFAULTS, per_day: 100, open_max: 100 });
  const r = await RF.create(U.maker.userId, PAT_RAFFLE({ target: 100, prize_amount: 1000, max_per_user: 3 }));
  assert.equal((await RF.buy(U.ann.userId, { id: r.id, qty: 3, idem: "ann-max-0001" })).ok, true);
  await assert.rejects(RF.buy(U.ann.userId, { id: r.id, qty: 1, idem: "ann-max-0002" }), refused("E_MAX_PER"));
  await assert.rejects(RF.buy(U.ann.userId, { id: r.id, qty: 1001, idem: "ann-max-0003" }), refused("E_QTY"), "1,000 a purchase");
  // 1.99xo: no ticket limit per raffle - a 10M-ticket target / cap / minimum is fine
  await runQuery("UPDATE users SET points_balance = points_balance + 2000000000 WHERE userId = 'u_maker'");
  SUPPLY0 += 2000000000;
  const big = await RF.create(U.maker.userId, PAT_RAFFLE({ target: 10000000, min_tickets: 5000000, prize_amount: "1.5b", price: 10 }));
  assert.equal((await raffle(big.id)).target, 10000000);
  await assert.rejects(RF.create(U.maker.userId, PAT_RAFFLE({ prize_amount: "1.6b" })), refused("E_PRIZE"), "the max PAT prize is 1.5B");
  assert.equal("tickets_max" in RF.config() || "purchases_max" in RF.config(), false, "no ticket / purchase cap settings");
  const r2 = big;
  for (const id of [a.id, r.id, r2.id]) await RF.takedown(U.boss.userId, id, "test cleanup");
  assert.equal(await supply(), SUPPLY0);
});

test("1.99xo: many separate purchases settle in chunks inside the one draw transaction - fee, payout and supply exact", async () => {
  RF._setSettleChunk(3);
  const r = await RF.create(U.maker.userId, PAT_RAFFLE({ target: 8, prize_amount: 1000, price: 1001 }));
  const m0 = await bal(U.maker), h0 = await house();
  const who = [U.ann, U.bob, U.cat, U.dan, U.ann, U.bob, U.cat, U.dan];
  for (let i = 0; i < 8; i++) await RF.buy(who[i].userId, { id: r.id, qty: 1, idem: "chunk-buy-" + String(i).padStart(4, "0") });
  const row = await raffle(r.id);
  assert.equal(row.status, "drawn");
  assert.equal(row.fee, 800);
  assert.equal(await bal(U.maker), m0 + 8008 - 800);
  assert.equal(await house(), h0 + 800);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM escrow_moves WHERE key LIKE ?", [`rfd:${r.id}:pot%`]))[0].n, 3, "3 chunks of 3/3/2");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM escrow_holds WHERE ref = ? AND state = 'held'", [`RFT-${r.id}`]))[0].n, 0);
  // a house raffle too
  const hr = await RF.create(U.boss.userId, PAT_RAFFLE({ house: true, target: 5, prize_amount: 1000, price: 1000 }));
  const h1 = await house();
  for (let i = 0; i < 5; i++) await RF.buy(who[i].userId, { id: hr.id, qty: 1, idem: "chunk-house-" + String(i).padStart(4, "0") });
  assert.equal((await raffle(hr.id)).status, "drawn");
  assert.equal(await house(), h1 + 5000 - 1000);
  RF._setSettleChunk(2000);
  assert.equal(await supply(), SUPPLY0);
});

test("Pepe: list / show / buy by Camfrog login, the events feed (cursor), the switch answer", async () => {
  const r = await RF.create(U.maker.userId, PAT_RAFFLE({ target: 4, prize_amount: 2000 }));
  const first = await bot("/api/raffles/bot/poll", { after: -1 });
  assert.ok(first.body.cursor > 0);
  assert.deepEqual(first.body.events, []);
  const l = await bot("/api/raffles/bot/act", { verb: "list" });
  assert.ok(l.body.raffles.some((x) => x.id === r.id));
  const s = await bot("/api/raffles/bot/act", { verb: "show", id: "R" + r.id });
  assert.equal(s.body.raffle.prize, "2,000 PAT");
  const b = await bot("/api/raffles/bot/act", { verb: "buy", login: "Ann_CF", id: r.id, qty: 2, key: "pepe-buy-000001" });
  assert.equal(b.body.ok, true, JSON.stringify(b.body));
  assert.deepEqual([b.body.from, b.body.to], [1, 2]);
  const dup = await bot("/api/raffles/bot/act", { verb: "buy", login: "ann_cf", id: r.id, qty: 2, key: "pepe-buy-000001" });
  assert.equal(dup.body.dup, true);
  assert.equal((await bot("/api/raffles/bot/act", { verb: "buy", login: "nobody_here", id: r.id, qty: 1, key: "pepe-buy-000002" })).body.code, "E_NO_ACCOUNT");
  assert.equal((await bot("/api/raffles/bot/act", { verb: "buy", login: "makercf", id: r.id, qty: 1, key: "pepe-buy-000003" })).body.code, "E_SELF");
  const ev = await bot("/api/raffles/bot/poll", { after: first.body.cursor });
  assert.deepEqual(ev.body.events.map((e) => e.kind), ["milestone"], "50% of the target");
  assert.equal((await bot("/api/raffles/bot/act", { password: "nope", verb: "list" })).status, 403);
  await RF.takedown(U.boss.userId, r.id, "test cleanup");
  const ev2 = await bot("/api/raffles/bot/poll", { after: ev.body.cursor });
  assert.equal(ev2.body.events[0].kind, "removed");
  assert.equal(await supply(), SUPPLY0);
});

test("pages render (list, one raffle, the create form, /admin/raffles) and the feed embed card answers R<id>", async () => {
  const l = await page(U.ann, "/raffles");
  assert.equal(l.status, 200, l.text.slice(0, 400));
  assert.match(l.text, /Run a raffle/);
  assert.match(l.text, /data-rf-form="create"/);
  assert.doesNotMatch(l.text, /\brf\.[a-z_]+\b(?![-\w])/.test(l.text) ? /\brf\.(title|h1|lead|f_[a-z_]+)\b/ : /$^/);
  // 1.99xq: no admin card on the public page - admins get a link; the settings / House raffle / moderation live on /admin/raffles
  const pub = await page(U.boss, "/raffles?status=drawn");
  assert.equal(pub.status, 200, pub.text.slice(0, 400));
  assert.doesNotMatch(pub.text, /data-rf-form="admin"|\/api\/admin\/raffles|name="house"/);
  assert.match(pub.text, /href="\/admin\/raffles"/);
  assert.doesNotMatch(l.text, /href="\/admin\/raffles"/, "members get no admin link");
  const adm = await page(U.boss, "/admin/raffles");
  assert.equal(adm.status, 200, adm.text.slice(0, 400));
  assert.match(adm.text, /data-rf-form="admin"/);
  assert.match(adm.text, /data-rf-url="\/api\/admin\/raffles"/);
  assert.match(adm.text, /name="config\.fee_pct"/);
  assert.match(adm.text, /name="house" value="1"/);
  assert.equal((await page(U.ann, "/admin/raffles")).status, 403);
  const oneAdm = await page(U.boss, "/raffles/" + R1);
  assert.doesNotMatch(oneAdm.text, /\/api\/raffles\/\d+\/(takedown|decide)/, "moderation moved to /admin/raffles");
  assert.match(oneAdm.text, /href="\/admin\/raffles#R/);
  const st = await RF.adminState();
  assert.ok(Array.isArray(st.review) && Array.isArray(st.open) && Array.isArray(st.recent));
  const one = await page(U.ann, "/raffles/" + R1);
  assert.equal(one.status, 200, one.text.slice(0, 400));
  assert.match(one.text, /Provably fair/);
  assert.match(one.text, /data-rf-verify/);
  assert.equal((await page(null, "/raffles/999999")).status, 404);
  cookieUser = null;
  const e = JSON.parse((await req("GET", "/api/embeds?refs=R" + R1 + ",M5")).text);
  assert.equal(e.items["R" + R1].kind, "raffle");
  assert.equal(e.items["R" + R1].status, "settled");
  assert.equal(require(path.join(repo, "embedcards")).parseRef("r12").ref, "R12");
  assert.equal(require(path.join(repo, "public", "js", "embed-cards.js")).refFromHref("https://publicaccess.tv/raffles/12"), "R12");
});

test("achievement metrics count drawn raffles with 3+ different buyers only; supply never moved", async () => {
  const m = await RF.achMetrics(U.maker.userId);
  assert.ok(m.raffles_made >= 1, JSON.stringify(m));
  assert.equal(await supply(), SUPPLY0);
});
