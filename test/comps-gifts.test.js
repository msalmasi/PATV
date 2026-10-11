// Offline tests for 1.99ma: 🎁 admin comps (comps.js) + gift rules (gifts.js) on the 1.99lz shop gift path, shop.compPrize:
//   * Plex: a trial comp for someone not on the server = a one-time Wizarr invite (mocked) on a free order; for a member
//     it extends their access (comp-trial); a trial that ends is listed for removal (admin-confirmed); lifetime; revoke
//   * Prime Time / Season Pass: timed comps (days / periods / no end), the gates honour them, the job ends them
//   * store items: a comp runs the normal fulfilment at price 0, nothing routed; gifts charge the giver, the recipient
//     gets it; refusals (already has it, blocks, rate limit, not giftable) happen BEFORE any charge; admin_audit rows
//   NODE_PATH=<noble+qrcode scratch>;G:/PATV/node_modules node --test test/comps-gifts.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "comps-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.STRIPE_ENABLED;
delete process.env.RESEND_API_KEY;
delete process.env.SENDGRID_API_KEY;
delete process.env.MEDIACTL_URL;
delete process.env.WIZARR_PUBLIC_URL;
process.env.SECRET_KEY = "test-secret";
process.env.WIZARR_API_KEY = "test-wizarr-key";
process.env.PAD_DIR = path.join(tmp, "pad");

const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const shop = require(path.join(repo, "shop"));
const conf = require(path.join(repo, "mediaconf"));
const MI = require(path.join(repo, "mediainvites"));
const PM = require(path.join(repo, "plexmembers"));
const PR = require(path.join(repo, "premium"));
const CP = require(path.join(repo, "comps"));
const G = require(path.join(repo, "gifts"));
const rooms = require(path.join(repo, "rooms"));
const TG = require(path.join(repo, "telegram"));

const DAY = 24 * 3600 * 1000;
let t = Date.now();
const clock = () => t;
for (const m of [PM, PR, CP, G, MI]) m._setClock(clock);

// a mocked Wizarr
const W = { posts: [], n: 0 };
const wiz = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => { body += d; });
  req.on("end", () => {
    const send = (st, j) => { res.writeHead(st, { "Content-Type": "application/json" }); res.end(JSON.stringify(j)); };
    if (req.headers["x-api-key"] !== "test-wizarr-key") return send(401, { error: "Unauthorized" });
    if (req.url === "/api/invitations" && req.method === "POST") {
      W.posts.push(JSON.parse(body));
      const code = "CMP" + (++W.n);
      return send(201, { invitation: { id: W.n, code, url: `https://wizarr.example.test/j/${code}` } });
    }
    send(404, { error: "not found" });
  });
});

const MONTH = "1c120384-c080-4186-b246-f1227e82ab01", LIFE = "e101bcff-cc8c-4db9-b4ca-302ef5e16871";
const SCOUT = "147ce895-37c2-4c43-98cc-9f7045de0cf3", GIFTCARD = "gc-amazon-25";
const U = {};
const users = new Map();
async function mkUser(name, { cls = "pleb", bal = 100000000 } = {}) {
  const id = "u-" + name;
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance) VALUES (?, ?, ?, 'x', ?, ?)", [id, name, name, cls, bal]);
  U[name] = { userId: id, username: name, class: cls };
  users.set(id, U[name]);
  return U[name];
}
const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [u.userId]))[0].b;
const settle = () => new Promise((r) => setTimeout(r, 80));
const audits = async (action) => getQuery("SELECT * FROM admin_audit WHERE action = ? ORDER BY id", [action]);
const notices = async (u) => getQuery("SELECT * FROM inbox WHERE user_id = ? ORDER BY id", [u.userId]);
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
      res.on("end", () => { const txt = Buffer.concat(chunks).toString("utf8"); let j = null; try { j = JSON.parse(txt); } catch (e) { j = null; } resolve({ status: res.statusCode, json: j, text: txt }); });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

test.before(async () => {
  await new Promise((r) => wiz.listen(0, "127.0.0.1", r));
  process.env.WIZARR_URL = `http://127.0.0.1:${wiz.address().port}`;
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, extra_daily_spins INTEGER DEFAULT 0,
                  discordId TEXT, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, email TEXT, avatar TEXT, isEmailVerified INTEGER DEFAULT 0, xp INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE IF NOT EXISTS jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  await runQuery("CREATE TABLE IF NOT EXISTS user_roles (userId TEXT, role TEXT, source TEXT, PRIMARY KEY (userId, role))");
  await runQuery("CREATE TABLE IF NOT EXISTS dm_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (blocker_id, blocked_id))");
  await shop.ready;
  await MI.init();
  await PM.init();
  await rooms.init();
  await PR.init();
  await CP.init();
  await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity) VALUES (?, 'Plex Invite 1 Month Access', 5000000, 50)", [MONTH]);
  await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity) VALUES (?, 'Plex Invite Lifetime Access', 250000000, 50)", [LIFE]);
  await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity) VALUES (?, 'Scout role', 50000000, 50)", [SCOUT]);
  await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity) VALUES (?, '$25 Amazon gift card', 30000000, 5)", [GIFTCARD]);
  await runQuery("INSERT INTO prizes (prizeId, prize, cost, quantity) VALUES ('spinboost100', '+100 Daily Gold Spins', 3000000, 1000)");
  await mkUser("pb", { bal: 0 });
  await mkUser("boss", { cls: "Admin", bal: 0 });
  await mkUser("newbie");
  await mkUser("member");
  await mkUser("giver", { bal: 400000000 });
  await mkUser("friend");
  await mkUser("blocker");
  await mkUser("padowner");
  await rooms.addRoom("COMP_PAD", null, "test");
  await rooms.setOwner("COMP_PAD", "padowner", "test");
  MI.register(null, { noTimers: true });            // the invite hook for Plex items (gifts / comps of store items)

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.flash = () => []; next(); });
  app.use((req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); });
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  CP.register(app, { addUser: (req, res, next) => next() });
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { wiz.close(); if (server) server.close(); });

// ── 📼 Plex ──
test("Plex trial comp for someone NOT on the server: a one-time Wizarr invite on a free comp order + notice + audit", async () => {
  const before = await bal(U.newbie);
  const r = await CP.compPlex(U.boss, { user: "newbie", kind: "trial", reason: "welcome trial" });
  assert.equal(r.delivery, "invite");
  assert.equal(r.days, 7, "the default trial is 7 days");
  assert.ok(r.invite && r.invite.ok, "the invite went out");
  assert.equal(W.posts.length, 1);
  assert.equal(W.posts[0].unlimited, true, "PATV tracks the expiry (wizarr_timed off)");
  const o = await shop.getOrder(r.order_id);
  assert.equal(o.buyer_id, U.newbie.userId);
  assert.equal(o.price, 0);
  assert.equal(o.comp_by, "boss");
  assert.match(o.seller_note, /wizarr\.example\.test\/j\/CMP1/);
  const inv = (await getQuery("SELECT * FROM media_invites WHERE order_id = ?", [r.order_id]))[0];
  assert.equal(inv.status, "created");
  assert.equal(inv.code, "CMP1", "the sync links their Plex account through this code, like a purchase");
  assert.equal(await bal(U.newbie), before, "no PAT moved");
  const pa = await PM.patvAccess(U.newbie.userId, t);
  assert.equal(pa.type, "comp-trial");
  assert.ok(pa.active);
  assert.ok(Math.abs(pa.expires - (t + 7 * DAY)) < 2000);
  const n = await notices(U.newbie);
  assert.ok(n.some((x) => /You’ve been gifted 7 days of Plex access/.test(x.title)), "the 🎁 notice");
  assert.ok(!n.some((x) => /wizarr/.test(String(x.body))), "notices never carry the invite link");
  const a = await audits("comp_plex");
  assert.equal(a.length, 1);
  assert.equal(a[0].reason, "welcome trial");
  assert.equal(a[0].admin_name, "boss");
});

test("Plex trial comp for a member already on the server extends their access (no invite); the end -> listed for removal", async () => {
  // a member who bought a month 10 days ago and is on the server (linked)
  const o = await shop.purchasePrize({ userId: U.member.userId, username: "member", prizeId: MONTH, source: "website" });
  assert.equal(o.success, true);
  await runQuery("UPDATE shop_orders SET created = ? WHERE id = ?", [t - 10 * DAY, o.order_id]);
  await runQuery(`INSERT INTO plex_members (plex_id, share_id, username, on_server, pending, invited_at, accepted_at, user_id, link_source, access, access_pinned, expires, first_seen)
                  VALUES ('9001', 's1', 'memberplex', 1, 0, ?, ?, ?, 'self', 'monthly', 0, ?, ?)`, [t - 10 * DAY, t - 10 * DAY, U.member.userId, t + 20 * DAY, t - 10 * DAY]);
  await PM.refreshUser(U.member.userId);
  const posts = W.posts.length;
  const r = await CP.compPlex(U.boss, { user: "member", kind: "trial", days: 14, reason: "thanks for helping" });
  assert.equal(r.delivery, "extended");
  assert.equal(W.posts.length, posts, "no second invite");
  assert.ok(Math.abs(r.starts - (t + 20 * DAY)) < 5000, "the trial starts where their paid month ends");
  const row = await PM.row("9001");
  assert.equal(row.access, "comp-trial");
  assert.ok(Math.abs(Number(row.expires) - (t + 34 * DAY)) < 5000);
  assert.ok(PM.isActiveRow(row, t));
  assert.ok(PM.memberSync(U.member.userId), "free plays / flair / cosmetics see an active member");
  // the trial ends -> like monthly access running out: a removal candidate (plex_auto_revoke stays OFF)
  t += 35 * DAY;
  await PM.refreshUser(U.member.userId);
  const ended = await PM.row("9001");
  assert.equal(ended.revoke, "candidate");
  assert.equal(conf.get().plex_auto_revoke, false);
  const st = await PM.adminState();
  assert.ok(st.candidates.some((c) => c.plex_id === "9001"), "listed on /admin/media for an admin to Remove");
  // the admin confirms: the share goes, the member hears it was the gifted access that ended
  PM._set({ removeShare: async () => ({ ok: true }) });
  await PM.revoke("9001", "boss");
  const n = await notices(U.member);
  assert.ok(n.some((x) => /gifted Plex access ended/.test(x.title)));
  t -= 35 * DAY;
});

test("Plex lifetime comp: never a removal candidate; refused twice; revoke ends it (then it's listed)", async () => {
  await mkUser("lifer");
  await runQuery(`INSERT INTO plex_members (plex_id, share_id, username, on_server, pending, invited_at, user_id, link_source, access, access_pinned, first_seen)
                  VALUES ('9002', 's2', 'liferplex', 1, 0, ?, ?, 'admin', NULL, 0, ?)`, [t + 1000, U.lifer.userId, t]);
  const r = await CP.compPlex(U.boss, { user: "lifer", kind: "lifetime", reason: "founding member" });
  assert.equal(r.delivery, "extended");
  let row = await PM.row("9002");
  assert.equal(row.access, "comp-lifetime");
  assert.equal(row.expires, null);
  assert.ok(!PM.isCandidate(row, t + 1000 * DAY));
  await assert.rejects(CP.compPlex(U.boss, { user: "lifer", kind: "trial", reason: "again" }), /already has lifetime/);
  await CP.revokePlex(U.boss, r.id, "mistake");
  row = await PM.row("9002");
  assert.equal(row.access, "comp-trial", "a revoked comp is PATV-given access that ended at the revoke");
  t += 1000;
  await PM.refreshUser(U.lifer.userId);
  assert.equal((await PM.row("9002")).revoke, "candidate");
  assert.equal((await audits("comp_revoke")).length, 1);
});

test("Plex trial extend from the admin list; a reason is required", async () => {
  await mkUser("ext");
  const r = await CP.compPlex(U.boss, { user: "ext", kind: "trial", days: 3, reason: "short trial" });
  await assert.rejects(CP.extendPlex(U.boss, r.id, 5, ""), /reason/);
  const x = await CP.extendPlex(U.boss, r.id, 5, "liked it");
  assert.ok(Math.abs(x.until - (r.until + 5 * DAY)) < 2000);
  const pa = await PM.patvAccess(U.ext.userId, t);
  assert.ok(Math.abs(pa.expires - x.until) < 2000);
  const st = await CP.adminState();
  assert.ok(st.plex.find((c) => c.id === r.id && c.active));
});

// ── 📺 / 🎟️ premium ──
test("Season Pass timed comp: gates honour it (pass, sticker allowance, Telegram full tier), shows until, ends by itself", async () => {
  const r = await CP.compPremium(U.boss, { tier: "season_pass", user: "friend", mode: "days", n: 10, reason: "event host" });
  assert.ok(Math.abs(r.until - (t + 10 * DAY)) < 2000);
  assert.equal(PR.hasPass(U.friend.userId, t), true);
  assert.equal(PR.userPerks(U.friend.userId).stickerPacks > 0, true, "the free sticker pack");
  assert.equal(await TG.tierOf({ userId: U.friend.userId }), "full", "the Telegram bridge's Season Pass tier");
  const S = await PR.state(U.friend);
  assert.equal(S.viewer.pass.status, "comped");
  assert.ok(Math.abs(S.viewer.pass.comp_until - r.until) < 2000);
  const sub = await PR.subRow("season_pass", U.friend.userId);
  assert.equal(sub.renewer_id, null, "comps never renew");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM reserve_claims"))[0].n, 0, "nothing routed");
  // extend
  const x = await CP.extendPremium(U.boss, { tier: "season_pass", user: "friend", days: 5, reason: "one more week-ish" });
  assert.ok(Math.abs(x.until - (r.until + 5 * DAY)) < 2000);
  // past the end: the gates stop at once, the job files it
  t += 16 * DAY;
  assert.equal(PR.hasPass(U.friend.userId, t), false);
  assert.equal(PR.statusOf(await PR.subRow("season_pass", U.friend.userId), t), "none");
  assert.equal(await PR.expireComps(t), 1);
  const after = await PR.subRow("season_pass", U.friend.userId);
  assert.equal(after.comped, 0);
  assert.equal(after.comp_until, null);
  assert.ok((await getQuery("SELECT * FROM premium_ledger WHERE kind = 'comp-end' AND target = ?", [U.friend.userId])).length === 1);
  assert.ok((await notices(U.friend)).some((x) => /free time ended/.test(x.title)));
  assert.equal(await PR.expireComps(t), 0, "idempotent");
  t -= 16 * DAY;
});

test("Prime Time comp for a pad by periods; no-end comps; revoke; a timed comp over a no-end one is refused", async () => {
  const r = await CP.compPremium(U.boss, { tier: "prime_time", pad: "COMP_PAD", mode: "periods", n: 2, reason: "launch" });
  assert.ok(Math.abs(r.until - (t + 2 * PR.config().period_days * DAY)) < 2000);
  assert.equal(PR.isPrime("COMP_PAD", t), true);
  assert.equal(PR.padPerks("COMP_PAD").extraSlots, PR.config().prime_extra_slots);
  assert.ok((await notices(U.padowner)).some((x) => /gifted/.test(x.title)), "the pad's owner hears it");
  const life = await CP.compPremium(U.boss, { tier: "prime_time", pad: "COMP_PAD", mode: "lifetime", reason: "house pad now" });
  assert.equal(life.until, null);
  assert.equal(PR.statusOf(await PR.subRow("prime_time", "COMP_PAD"), t + 9999 * DAY), "comped");
  await assert.rejects(CP.compPremium(U.boss, { tier: "prime_time", pad: "COMP_PAD", mode: "days", n: 3, reason: "x timed" }), /no end date/);
  await CP.revokePremium(U.boss, { tier: "prime_time", pad: "COMP_PAD", reason: "test over" });
  assert.equal(PR.isPrime("COMP_PAD", t), false);
  assert.equal((await audits("comp_premium")).length >= 3, true);
});

test("paying during a timed comp starts after it", async () => {
  await mkUser("payer", { bal: 50000000 });
  const r = await CP.compPremium(U.boss, { tier: "season_pass", user: "payer", mode: "days", n: 7, reason: "promo" });
  const b = await PR.buy(U.payer, { tier: "season_pass", months: 1, ref: "pay-after-comp-1" });
  assert.ok(Math.abs(b.paid_through - (r.until + PR.config().period_days * DAY)) < 2000);
});

// ── store items: comps ──
test("comp a role: the normal fulfilment at price 0, nothing routed, comped order + audit; already has it -> refused", async () => {
  const pb0 = await bal(U.pb), q0 = (await getQuery("SELECT quantity FROM prizes WHERE prizeId = ?", [SCOUT]))[0].quantity;
  const r = await CP.compItem(U.boss, { kind: "prize", user: "friend", id: SCOUT, reason: "community helper" });
  assert.equal(r.comp, true);
  const o = await shop.getOrder(r.order_id);
  assert.equal(o.price, 0);
  assert.equal(o.buyer_id, U.friend.userId);
  assert.equal(o.comp_by, "boss");
  assert.equal(o.comp_reason, "community helper");
  const role = (await getQuery("SELECT * FROM user_roles WHERE userId = ?", [U.friend.userId]))[0];
  assert.equal(role.role, "scout");
  assert.equal(role.source, "comp:boss");
  assert.equal(await bal(U.pb), pb0, "no store-owner credit");
  assert.equal((await getQuery("SELECT quantity FROM prizes WHERE prizeId = ?", [SCOUT]))[0].quantity, q0, "no stock used");
  assert.equal((await audits("comp_item")).length, 1);
  await assert.rejects(CP.compItem(U.boss, { kind: "prize", user: "friend", id: SCOUT, reason: "again" }), /already has the Scout/);
  await assert.rejects(CP.compItem(U.boss, { kind: "prize", user: "friend", id: GIFTCARD, reason: "card" }), /by hand outside PATV/);
});

test("comp a Plex store item (invites on): the invite hook runs for the recipient", async () => {
  await conf.set({ invites_enabled: true }, "test");
  await mkUser("plexgift");
  const posts = W.posts.length;
  const r = await CP.compItem(U.boss, { kind: "prize", user: "plexgift", id: MONTH, reason: "raffle prize" });
  await settle();
  assert.equal(W.posts.length, posts + 1);
  assert.match((await shop.getOrder(r.order_id)).seller_note, /wizarr\.example\.test/);
  assert.equal((await PM.patvAccess(U.plexgift.userId, t)).type, "monthly");
});

test("comp a sticker pack: free, refused when they have it", async () => {
  const ST = require(path.join(repo, "stickers"));
  const pack = ST.catalog()[0];
  if (!pack) return;
  const r = await CP.compItem(U.boss, { kind: "sticker", user: "newbie", id: pack.id, reason: "contest" });
  assert.equal(r.item, pack.name);
  assert.equal((await ST.ownedPacks(U.newbie.userId)).has(pack.id), true);
  await assert.rejects(CP.compItem(U.boss, { kind: "sticker", user: "newbie", id: pack.id, reason: "contest" }), /already has/);
});

// ── gifts (the 1.99lz "Send it as a gift" path + the 1.99ma shared rules) ──
const gift = (from, to, prizeId, extra = {}) => shop.purchasePrize({ userId: from.userId, username: from.username, prizeId, source: "website", giftTo: to, ...extra });
test("gift a role: the giver pays the normal price, the recipient gets it (their order, their role); routed like a sale", async () => {
  await mkUser("lucky");
  const g0 = await bal(U.giver), pb0 = await bal(U.pb);
  const r = await gift(U.giver, "lucky", SCOUT, { giftNote: "enjoy!", expectedCost: 50000000 });
  assert.equal(r.success, true, r.message);
  assert.equal(await bal(U.giver), g0 - 50000000);
  assert.equal(await bal(U.pb), pb0 + 50000000, "the store owner, as for a purchase");
  const o = await shop.getOrder(r.order_id);
  assert.equal(o.buyer_id, U.lucky.userId);
  assert.equal(o.gift_from, U.giver.userId);
  assert.equal(o.gift_note, "enjoy!");
  assert.equal((await getQuery("SELECT source FROM user_roles WHERE userId = ?", [U.lucky.userId]))[0].source, "gift:giver");
  // the recipient has it now: a second gift is refused BEFORE any charge
  const g1 = await bal(U.giver);
  const again = await gift(U.giver, "lucky", SCOUT);
  assert.equal(again.success, false);
  assert.match(again.message, /already has the Scout role/);
  assert.equal(await bal(U.giver), g1);
});

test("gift refusals before any charge: yourself, a block (either way), the spin boost", async () => {
  const g0 = await bal(U.giver);
  assert.match((await gift(U.giver, "giver", GIFTCARD)).message, /That's you/);
  await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)", [U.blocker.userId, U.giver.userId, t]);
  const b = await gift(U.giver, "blocker", GIFTCARD);
  assert.equal(b.success, false);
  assert.match(b.message, /can't send gifts/);
  assert.doesNotMatch(b.message, /blocked/i, "never says who blocked whom");
  assert.match((await gift(U.giver, "friend", "spinboost100")).message, /can't be sent as a gift/);
  assert.equal(await bal(U.giver), g0, "nothing was charged");
});

test("gift rate limit (per recipient per day) and the Season Pass / sticker gift paths honour blocks", async () => {
  await mkUser("popular");
  await runQuery("UPDATE prizes SET quantity = 100 WHERE prizeId = ?", [GIFTCARD]);
  let last;
  for (let i = 0; i < G.PAIR_DAY + 1; i++) last = await gift(U.giver, "popular", GIFTCARD);
  assert.equal(last.success, false);
  assert.match(last.message, /gifts to popular today/);
  await assert.rejects(PR.buy(U.giver, { tier: "season_pass", user: "blocker", months: 1, ref: "blocked-gift-1" }), /can't send gifts/);
  const ST = require(path.join(repo, "stickers"));
  const pack = ST.catalog()[0];
  if (pack) await assert.rejects(ST.buy(U.giver, { pack: pack.id, to: "blocker", ref: "blocked-stk-1" }), /can't send gifts/);
});

test("Season Pass gift: one period for the recipient (no renewal on the giver) + the localized 🎁 notice", async () => {
  await mkUser("spfriend");
  const r = await PR.buy(U.giver, { tier: "season_pass", user: "spfriend", months: 1, ref: "sp-gift-ok-1", renew: true });
  assert.equal(r.gift, true);
  const sub = await PR.subRow("season_pass", U.spfriend.userId);
  assert.equal(sub.renewer_id, null, "a gift never makes the giver a renewer");
  assert.ok((await notices(U.spfriend)).some((x) => /gifted 🎟️ Season Pass/.test(x.title) && /giver sent you/.test(x.body)));
});

test("Plex lifetime item can't be gifted to someone with lifetime access", async () => {
  await mkUser("plexlife");
  await CP.compPlex(U.boss, { user: "plexlife", kind: "lifetime", reason: "vip" });
  const g0 = await bal(U.giver);
  const r = await gift(U.giver, "plexlife", LIFE);
  assert.equal(r.success, false);
  assert.match(r.message, /already has lifetime Plex/);
  assert.equal(await bal(U.giver), g0);
});

// ── the admin page + API gates ──
test("/admin/comps: admins only; the API comps with a reason", async () => {
  assert.equal((await req("GET", "/admin/comps", { user: U.friend.userId })).status, 302);
  const page = await req("GET", "/admin/comps?user=friend", { user: U.boss.userId });
  assert.equal(page.status, 200, page.text.slice(0, 400));
  assert.match(page.text, /Comps &amp; gifts/);
  assert.equal((await req("GET", "/admin/premium", { user: U.boss.userId })).status, 302);
  const no = await req("POST", "/api/admin/comps/premium", { user: U.friend.userId, json: { tier: "season_pass", user: "friend", mode: "days", n: 3, reason: "nope" } });
  assert.equal(no.status, 403);
  const noReason = await req("POST", "/api/admin/comps/premium", { user: U.boss.userId, json: { tier: "season_pass", user: "newbie", mode: "days", n: 3 } });
  assert.equal(noReason.status, 400);
  const ok = await req("POST", "/api/admin/comps/premium", { user: U.boss.userId, json: { tier: "season_pass", user: "newbie", mode: "days", n: 3, reason: "api test" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.ok(ok.json.state.premium.some((p) => p.target === U.newbie.userId && p.until));
});
