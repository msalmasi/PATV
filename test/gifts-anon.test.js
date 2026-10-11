// Offline tests for 1.99mt: 🕶 anonymous gifts (gifts.js anonFlag / record / gift log) on every gift path:
//   * shop item gifts: the recipient's notice, order (events + masked giver) and role source never name the giver; the giver
//     still sees their own order; admins see the real giver (order admin view, the gift log)
//   * Season Pass / Prime Time gifts, sticker-pack gifts, owned-cosmetic gifts, Pepe-sold cosmetic gifts (grant `from`)
//   * the rules still apply to anonymous gifts: blocks (same words, never "blocked"), already-owned refusals, before a charge
//   * the gift log backfill copies older gifts once
//   NODE_PATH=<noble+qrcode scratch>;G:/PATV/node_modules node --test test/gifts-anon.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gifts-anon-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.STRIPE_ENABLED;
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;
delete process.env.MEDIACTL_URL;
process.env.SECRET_KEY = "test-secret";
process.env.PAD_DIR = path.join(tmp, "pad");

const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const shop = require(path.join(repo, "shop"));
const PR = require(path.join(repo, "premium"));
const G = require(path.join(repo, "gifts"));
const ST = require(path.join(repo, "stickers"));
const COS = require(path.join(repo, "cosmetics"));
const rooms = require(path.join(repo, "rooms"));
const CP = require(path.join(repo, "comps"));

let t = Date.now();
const clock = () => t;
for (const m of [PR, G, CP]) m._setClock(clock);
const delayed = [];
G._setAchDelay((userId, ms) => delayed.push({ userId, ms }));     // no real timers / achievement checks in this test

const SCOUT = "147ce895-37c2-4c43-98cc-9f7045de0cf3", GIFTCARD = "gc-amazon-25";
const U = {};
const users = new Map();
async function mkUser(name, { cls = "pleb", bal = 400000000, camfrog = null } = {}) {
  const id = "u-" + name;
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername) VALUES (?, ?, ?, 'x', ?, ?, ?)",
                 [id, name, name, cls, bal, camfrog]);
  U[name] = { userId: id, username: name, class: cls };
  users.set(id, U[name]);
  return U[name];
}
const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [u.userId]))[0].b;
const notices = async (u) => getQuery("SELECT * FROM inbox WHERE user_id = ? ORDER BY id", [u.userId]);
const gift = (from, to, prizeId, extra = {}) => shop.purchasePrize({ userId: from.userId, username: from.username, prizeId, source: "website", giftTo: to, ...extra });
const settle = () => new Promise((r) => setTimeout(r, 80));
let base, server;
function req(method, url, { user, json } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Origin: base };
    if (user) h["x-test-user"] = user;
    let data = null;
    if (json !== undefined) { data = Buffer.from(JSON.stringify(json)); h["Content-Type"] = "application/json"; h["Content-Length"] = data.length; }
    const r = http.request(base + url, { method, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const txt = Buffer.concat(chunks).toString("utf8"); let j = null; try { j = JSON.parse(txt); } catch (e) { j = null; } resolve({ status: res.statusCode, json: j, text: txt, location: res.headers.location }); });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, extra_daily_spins INTEGER DEFAULT 0,
                  discordId TEXT, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, email TEXT, avatar TEXT, isEmailVerified INTEGER DEFAULT 0, xp INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE IF NOT EXISTS jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  await runQuery("CREATE TABLE IF NOT EXISTS user_roles (userId TEXT, role TEXT, source TEXT, PRIMARY KEY (userId, role))");
  await runQuery("CREATE TABLE IF NOT EXISTS dm_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (blocker_id, blocked_id))");
  await shop.ready;
  await rooms.init();
  await PR.init();
  await ST.init();
  await CP.init();
  await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity) VALUES (?, 'Scout role', 50000000, 50)", [SCOUT]);
  await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity) VALUES (?, '$25 Amazon gift card', 30000000, 50)", [GIFTCARD]);
  await mkUser("pb", { bal: 0 });
  await mkUser("boss", { cls: "Admin", bal: 0 });
  await mkUser("secret", { camfrog: "secretcf" });
  await mkUser("crush", { camfrog: "crushcf" });
  await mkUser("blocker");
  await mkUser("padowner");
  await rooms.addRoom("ANON_PAD", null, "test");
  await rooms.setOwner("ANON_PAD", "padowner", "test");

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.flash = () => []; next(); });
  app.use((req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); });
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  COS.register(app, { isBotToken: (p) => p === "bot-pw", addUser: (req, res, next) => next() });
  CP.register(app, { addUser: (req, res, next) => next() });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { if (server) server.close(); });

test("anonFlag: only an explicit yes", () => {
  for (const v of [true, 1, "1", "on", "true", "yes", "anon"]) assert.equal(G.anonFlag(v), true, String(v));
  for (const v of [false, 0, "", null, undefined, "no", "0", {}]) assert.equal(G.anonFlag(v), false, String(v));
});

test("shop: an anonymous gift never names the giver to the recipient; the giver + admins still see who", async () => {
  const g0 = await bal(U.secret);
  const r = await gift(U.secret, "crush", SCOUT, { giftNote: "from a fan", giftAnon: "1" });
  assert.equal(r.success, true, r.message);
  assert.equal(await bal(U.secret), g0 - 50000000, "the giver pays as for any gift");
  const o = await shop.getOrder(r.order_id);
  assert.equal(o.buyer_id, U.crush.userId);
  assert.equal(o.gift_from, U.secret.userId, "the DB keeps the giver (admins, refunds, merges)");
  assert.equal(Number(o.gift_anon), 1);
  assert.equal((await getQuery("SELECT source FROM user_roles WHERE userId = ?", [U.crush.userId]))[0].source, "gift:anonymous");
  // the order's events are shown to the recipient: no name in them
  const ev = await getQuery("SELECT actor, note FROM shop_order_events WHERE order_id = ?", [r.order_id]);
  assert.ok(ev.length);
  for (const e of ev) { assert.doesNotMatch(String(e.actor || "") + " " + String(e.note || ""), /secret/i); }
  // the recipient's notice
  await settle();
  const n = (await notices(U.crush)).filter((x) => x.kind === "shop");
  assert.ok(n.length, "the recipient is told");
  for (const x of n) { assert.doesNotMatch(`${x.title} ${x.body}`, /secret/i); }
  assert.ok(n.some((x) => /Someone sent you a gift: Scout role/.test(x.title)));
  // the views: masked for the recipient, kept for the giver and an admin (not their own order)
  const asRecipient = shop.maskAnonGift({ ...o, gift_from_name: "secret" }, { userId: U.crush.userId });
  assert.equal(asRecipient.gift_from_name, null);
  assert.equal(asRecipient.gift_from, "anonymous");
  assert.equal(asRecipient.anon_view, true);
  assert.equal(shop.maskAnonGift({ ...o, gift_from_name: "secret" }, { userId: U.secret.userId }).gift_from_name, "secret");
  assert.equal(shop.maskAnonGift({ ...o, gift_from_name: "secret" }, { userId: U.boss.userId, staff: true }).gift_from_name, "secret");
  // a staff member who RECEIVED it is a recipient like anyone
  assert.equal(shop.maskAnonGift({ ...o, buyer_id: U.boss.userId, gift_from_name: "secret" }, { userId: U.boss.userId, staff: true }).gift_from_name, null);
  // the gift log: the real giver, marked anonymous; the giver's achievement check is delayed, the recipient's isn't
  const log = (await G.adminLog()).find((x) => x.kind === "shop" && x.recipient === "crush");
  assert.equal(log.giver, "secret");
  assert.equal(log.anon, 1);
  assert.ok(delayed.some((d) => d.userId === U.secret.userId && d.ms >= 20 * 60 * 1000), "giver's check delayed");
  assert.ok(delayed.some((d) => d.userId === U.crush.userId && d.ms === 0), "recipient's check right away");
});

test("shop: a named gift still names the giver (nothing changed for them)", async () => {
  const r = await gift(U.secret, "crush", GIFTCARD, { giftNote: "hi" });
  assert.equal(r.success, true, r.message);
  const o = await shop.getOrder(r.order_id);
  assert.equal(Number(o.gift_anon), 0);
  assert.equal(shop.maskAnonGift({ ...o, gift_from_name: "secret" }, { userId: U.crush.userId }).gift_from_name, "secret");
  const log = (await G.adminLog()).find((x) => x.item === "$25 Amazon gift card");
  assert.equal(log.anon, 0);
});

test("the rules apply to anonymous gifts: a block refuses with the usual words (never 'blocked'), already-owned refused, nothing charged", async () => {
  await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)", [U.blocker.userId, U.secret.userId, t]);
  const g0 = await bal(U.secret);
  const named = await gift(U.secret, "blocker", GIFTCARD);
  const anon = await gift(U.secret, "blocker", GIFTCARD, { giftAnon: true });
  assert.equal(anon.success, false);
  assert.equal(anon.message, named.message, "the same refusal either way");
  assert.doesNotMatch(anon.message, /blocked/i);
  const again = await gift(U.secret, "crush", SCOUT, { giftAnon: true });
  assert.equal(again.success, false);
  assert.match(again.message, /already has the Scout role/);
  await assert.rejects(PR.buy(U.secret, { tier: "season_pass", user: "blocker", months: 1, ref: "anon-blocked-sp", anon: true }), (e) => /can't send gifts/.test(e.message) && !/blocked/i.test(e.message));
  const pack = ST.catalog()[0];
  await assert.rejects(ST.buy(U.secret, { pack: pack.id, to: "blocker", ref: "anon-blocked-stk", anon: true }), /can't send gifts/);
  assert.equal(await bal(U.secret), g0, "nothing was charged");
});

test("Season Pass: an anonymous gift's notice says Someone; the ledger keeps the payer (anon = 1); the gift log has it", async () => {
  const r = await PR.buy(U.secret, { tier: "season_pass", user: "crush", months: 1, ref: "anon-sp-1", anon: true });
  assert.equal(r.gift, true);
  const n = (await notices(U.crush)).filter((x) => /Season Pass/.test(x.title));
  assert.ok(n.length);
  for (const x of n) assert.doesNotMatch(`${x.title} ${x.body}`, /secret/i);
  assert.ok(n.some((x) => /Someone sent you/.test(x.body)));
  const l = (await getQuery("SELECT payer_id, anon FROM premium_ledger WHERE ref LIKE '%anon-sp-1'"))[0];
  assert.equal(l.payer_id, U.secret.userId);
  assert.equal(l.anon, 1);
  const log = (await G.adminLog()).find((x) => x.kind === "season_pass" && x.recipient === "crush");
  assert.equal(log.giver, "secret");
  assert.equal(log.anon, 1);
});

test("Prime Time for someone else's pad, anonymously: the owner's notice + the backers list + the pad log say Someone", async () => {
  const r = await PR.buy(U.secret, { tier: "prime_time", pad: "ANON_PAD", months: 1, ref: "anon-pt-1", anon: true });
  assert.equal(r.gift, true);
  const n = (await notices(U.padowner)).filter((x) => /Prime Time/.test(x.title));
  assert.ok(n.length);
  for (const x of n) assert.doesNotMatch(`${x.title} ${x.body}`, /secret/i);
  assert.ok(n.some((x) => /Someone paid/.test(x.title)));
  const S = await PR.state(U.padowner, "ANON_PAD");
  assert.ok(S.pad.contributors.length);
  assert.ok(S.pad.contributors.every((c) => c.anon && c.name === null), JSON.stringify(S.pad.contributors));
  const log = (await G.adminLog()).find((x) => x.kind === "prime_time");
  assert.equal(log.giver, "secret");
  assert.equal(log.recipient, "padowner");
  // the owner paying for their own pad is never "anonymous"
  await PR.buy(U.padowner, { tier: "prime_time", pad: "ANON_PAD", months: 1, ref: "own-pt-1", anon: true });
  assert.equal((await getQuery("SELECT anon FROM premium_ledger WHERE ref LIKE '%own-pt-1'"))[0].anon, 0);
});

test("sticker pack: an anonymous gift's notice says Someone; already-owned is still refused", async () => {
  const pack = ST.catalog()[1] || ST.catalog()[0];
  const r = await ST.buy(U.secret, { pack: pack.id, to: "crush", ref: "anon-stk-1", anon: true });
  assert.equal(r.source, "gift");
  const n = (await notices(U.crush)).filter((x) => /sticker pack/.test(x.title));
  assert.ok(n.some((x) => /^🧸 Someone gave you/.test(x.title)));
  for (const x of n) assert.doesNotMatch(x.title, /secret/i);
  await assert.rejects(ST.buy(U.secret, { pack: pack.id, to: "crush", ref: "anon-stk-2", anon: true }), /already has/);
  const log = (await G.adminLog()).find((x) => x.kind === "sticker");
  assert.equal(log.giver, "secret");
  assert.equal(log.anon, 1);
});

test("cosmetics: gifting an owned copy anonymously (the recipient is now told - 'Someone'); Pepe's grant logs `from`", async () => {
  const item = COS.catalog().find((i) => !i.perk && i.kind === "name_color") || COS.catalog().find((i) => !i.perk);
  const g = await COS.grant(U.secret.userId, item.id, "shop", "test-own-1");
  assert.ok(g.ok, JSON.stringify(g));
  const inv = (await getQuery("SELECT id FROM user_cosmetics WHERE user_id = ? AND item_id = ?", [U.secret.userId, item.id]))[0].id;
  const res = await req("POST", "/cosmetics/gift", { user: U.secret.userId, json: { inv_id: inv, to: "crush", anon: "1", tab: "mine" } });
  assert.equal(res.status, 302);
  assert.match(decodeURIComponent(res.location || ""), /anonymously/);
  assert.equal((await getQuery("SELECT user_id FROM user_cosmetics WHERE id = ?", [inv]))[0].user_id, U.crush.userId);
  const n = (await notices(U.crush)).filter((x) => x.title.includes(item.name));
  assert.ok(n.length, "the recipient hears about it");
  for (const x of n) assert.doesNotMatch(`${x.title} ${x.body}`, /secret/i);
  assert.ok(n.some((x) => /Someone sent you/.test(x.body)));
  // Pepe-sold gift: the bot's grant names the giver + anon -> the gift log
  const item2 = COS.catalog().filter((i) => !i.perk && i.id !== item.id)[0];
  const gr = await req("POST", "/api/cosmetics/grant", { json: { password: "bot-pw", user: { camfrog: "crushcf" }, item: item2.id, source: "gift", idem: "cos-c77", from: { camfrog: "secretcf" }, anon: true } });
  assert.equal(gr.status, 200, gr.text);
  const log = (await G.adminLog()).filter((x) => x.kind === "cosmetic");
  assert.equal(log.length, 2);
  assert.ok(log.every((x) => x.giver === "secret" && x.recipient === "crush" && x.anon === 1));
});

test("gifting metrics + the admin page: the gift log shows the real giver to admins only", async () => {
  const m = await G.achMetrics(U.secret.userId);
  assert.ok(m.gifts_sent >= 6, JSON.stringify(m));
  assert.equal(m.gift_people, 2, "crush + padowner");
  assert.ok((await G.achMetrics(U.crush.userId)).gifts_received >= 5);
  const api = await req("GET", "/api/admin/comps", { user: U.boss.userId });
  assert.equal(api.status, 200);
  assert.ok(api.json.gifts.some((x) => x.giver === "secret" && x.anon === 1));
  assert.equal((await req("GET", "/api/admin/comps", { user: U.crush.userId })).status, 403);
});

test("log backfill: older gifts (before the log) are copied once, named", async () => {
  // pretend an old shop gift + sticker gift exist without log rows, and the backfill hasn't run
  await runQuery("DELETE FROM gift_log");
  await runQuery("DELETE FROM gift_meta");
  const G2 = G;
  const r = await G2.logBackfill();                   // memoized from earlier achMetrics: already ran in this process
  assert.ok(r);
  // a fresh module instance runs it again
  delete require.cache[require.resolve(path.join(repo, "gifts"))];
  const Gf = require(path.join(repo, "gifts"));
  const out = await Gf.logBackfill();
  assert.ok(out.n >= 4, JSON.stringify(out));
  const rows = await getQuery("SELECT kind, anon FROM gift_log");
  assert.ok(rows.some((x) => x.kind === "shop") && rows.some((x) => x.kind === "sticker") && rows.some((x) => x.kind === "cosmetic"));
  assert.ok(rows.every((x) => x.anon === 0), "the backfill never guesses anonymity");
  assert.equal((await Gf.logBackfill()).n, out.n, "memoized");
  delete require.cache[require.resolve(path.join(repo, "gifts"))];
  const again = await require(path.join(repo, "gifts")).logBackfill();
  assert.equal(again.already, true, "runs once (gift_meta)");
});
