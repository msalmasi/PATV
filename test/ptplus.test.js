// Offline tests for 1.99qp: 💎 Prime Time Plus (premium.js prime_plus) - the tier, the Prime Time upgrade, the Camfrog
// bridge gate, the perks wired into stickers.js (perk packs + 🎃 Spooky Season), padcosmetics.js, padflair.js and Pepe's
// owner sync (rooms.ownersForPepe), the comp path (comps.compPremium) and the PATV Creators nav switch.
//   node --test test/ptplus.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ptplus-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.STRIPE_ENABLED;
process.env.SECRET_KEY = "test-secret";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const PR = require(path.join(repo, "premium"));
const STK = require(path.join(repo, "stickers"));
const PC = require(path.join(repo, "padcosmetics"));
const FL = require(path.join(repo, "padflair"));
const F = require(path.join(repo, "funding"));

const PAD_A = "plus_pad_a", PAD_B = "pt_pad_b", PAD_C = "plain_pad_c", HOUSE = "PepeFrog.Room";
const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 9, 12, 12);          // 12 Oct: Spooky Season is on
let t = T0;
PR._setClock(() => t);
STK._setClock(() => t);
const U = {};
async function mk(name, { cls = "pleb", bal = 200000000 } = {}) {
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance) VALUES (?, ?, ?, 'x', ?, ?)", ["u-" + name, name, name, cls, bal]);
  U[name] = { userId: "u-" + name, username: name, class: cls };
  return U[name];
}
const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [u.userId]))[0].b;
const ref = () => "r" + Math.random().toString(36).slice(2, 12) + "x";

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, level INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await mk("ann"); await mk("bob"); await mk("fan"); await mk("boss", { cls: "Admin" });
  await rooms.init();
  for (const [id, who] of [[PAD_A, "ann"], [PAD_B, "bob"], [PAD_C, "fan"]]) { await rooms.addRoom(id, null, "test"); await rooms.setOwner(id, who, "test"); }
  await PR.init();
  await PR.setConfig({ comp_admins: false }, "test");
  await STK.init();
  await PC.init();
  await FL.init();
});
test.after(() => F.sync({}));

test("config: Plus is 50M PAT / 30 days, routed like Prime Time; soundboard slots 0 / 8 / 24; the bridge gate ships OFF", () => {
  const C = PR.config();
  assert.equal(C.plus_price, 50000000);
  assert.deepEqual([C.sb_slots_free, C.sb_slots_prime, C.sb_slots_plus], [0, 8, 24]);
  assert.equal(C.plus_bridge_gate, false);
  assert.deepEqual(C.routes.prime_plus, C.routes.prime_time);
  assert.equal(PR.TIERS.prime_plus.kind, "pad");
  assert.deepEqual(PR.padPerks(PAD_C), { primeTime: false, primePlus: false, tier: null, extraSlots: 0, extraBadges: 0, lowLatency: false,
                                          bridge: true, retention: "standard", soundboardSlots: 0 });
});

test("buying Plus: one debit, 50/50 Fort Knox / room vault for a gift, the pad has Prime Time too; plain Prime Time is refused on it", async () => {
  F.sync({ fortknox: 1 });
  const b0 = await bal(U.fan);
  const r = await PR.buy(U.fan, { tier: "prime_plus", pad: PAD_A, months: 1, ref: ref() });
  assert.deepEqual([r.amount, r.days, r.gift, r.upgrade, r.paid_through], [50000000, 30, true, null, T0 + 30 * DAY]);
  assert.equal(await bal(U.fan), b0 - 50000000);
  const cl = await getQuery("SELECT flow, amount FROM reserve_claims WHERE userId = ?", [U.fan.userId]);
  assert.equal(cl.reduce((a, c) => a + c.amount, 0), -50000000);
  assert.ok(cl.every((c) => /prime_plus/.test(c.flow)), "its own routing row");
  assert.equal(PR.isPrimePlus(PAD_A), true);
  assert.equal(PR.isPrime(PAD_A), true, "Plus includes Prime Time");
  assert.equal(PR.padTier(PAD_A), "prime_plus");
  assert.deepEqual(PR.padPerks(PAD_A), { primeTime: true, primePlus: true, tier: "prime_plus", extraSlots: 2, extraBadges: 2, lowLatency: true,
                                          bridge: true, retention: "unlimited", soundboardSlots: 24 });
  await assert.rejects(PR.buy(U.fan, { tier: "prime_time", pad: PAD_A, months: 1, ref: ref() }), /includes Prime Time/);
  const st = await PR.state(U.ann, PAD_A);
  assert.equal(st.prices.prime_plus, 50000000);
  assert.equal(st.pad.plus.status, "active");
  assert.equal(st.pad.plus.upgrade, null);
});

test("upgrade: a pad's paid Prime Time time left becomes Plus time at the price ratio; Prime Time stops renewing, no lapse notice, no charge", async () => {
  await PR.buy(U.bob, { tier: "prime_time", pad: PAD_B, months: 1, ref: ref(), renew: true });
  t = T0 + 10 * DAY;                                  // 20 days of Prime Time left
  const prev = await PR.state(U.bob, PAD_B);
  assert.deepEqual(prev.pad.plus.upgrade, { pt_days: 20, plus_days: 4 }, "20 days x 10M / 50M = 4 days");
  const b0 = await bal(U.bob);
  const r = await PR.buy(U.bob, { tier: "prime_plus", pad: PAD_B, months: 1, ref: ref(), renew: true });
  assert.equal(await bal(U.bob), b0 - 50000000, "the conversion moves no PAT");
  assert.equal(r.paid_through, t + 34 * DAY, "30 bought + 4 converted");
  assert.equal(Math.round(r.upgrade.plus_days), 4);
  const pt = await PR.subRow("prime_time", PAD_B);
  assert.deepEqual([pt.paid_through, pt.renewer_id], [t, null]);
  const L = await getQuery("SELECT kind, tier, amount, days FROM premium_ledger WHERE kind LIKE 'upgrade-%' ORDER BY id");
  assert.deepEqual(L.map((x) => [x.kind, x.tier, x.amount, x.days]), [["upgrade-out", "prime_time", 0, -20], ["upgrade-in", "prime_plus", 0, 4]]);
  t += 2 * DAY;
  const n = (await getQuery("SELECT COUNT(*) AS n FROM transactions WHERE userId = ?", [U.bob.userId]))[0].n;
  const job = await PR.renewDue(t);
  assert.equal(job.lapsed, 0, "the converted Prime Time doesn't send an 'ended' notice");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM transactions WHERE userId = ?", [U.bob.userId]))[0].n, n, "nothing charged");
  assert.equal(PR.isPrimePlus(PAD_B), true);
});

test("the Camfrog bridge gate: off = every pad; on = Plus pads and house pads only", async () => {
  assert.equal(PR.bridgeAllowed(PAD_C), true);
  await PR.setConfig({ plus_bridge_gate: true }, "test");
  assert.equal(PR.bridgeAllowed(PAD_C), false);
  assert.equal(PR.bridgeAllowed(PAD_A), true);
  assert.equal(PR.bridgeAllowed(HOUSE), true, "Pepe's Pad is a house pad");
  assert.equal(PR.padPerks(PAD_C).bridge, false);
  const B = require(path.join(repo, "bridge"));
  assert.equal(B.bridgeOk(PAD_C), false);
  assert.equal(B.isLiveShown({ id: PAD_C, updated: Date.now() }), false, "the web relay / clips / audio treat it as not live");
  assert.equal(B.isLiveShown({ id: PAD_A, updated: Date.now() }), true);
  await PR.setConfig({ plus_bridge_gate: false }, "test");
  assert.equal(B.bridgeOk(PAD_C), true);
});

test("Pepe's owner sync: prime_plus, soundboard_slots and bridge per room (his retention keeps Plus pads' logs and recordings for good)", async () => {
  const o = await rooms.ownersForPepe();
  const a = o.find((r) => r.id === PAD_A), c = o.find((r) => r.id === PAD_C);
  assert.deepEqual([a.prime_time, a.prime_plus, a.soundboard_slots, a.bridge], [true, true, 24, true]);
  assert.deepEqual([c.prime_time, c.prime_plus, c.soundboard_slots], [false, false, 0]);
});

test("sticker perk packs: Prime Time Plus for Plus pad owners, 🎃 Spooky Season for Season Pass holders in season; never sold", async () => {
  const has = async (u) => [...(await STK.ownedPacks(u.userId))].sort();
  assert.deepEqual(await has(U.ann), ["primeplus"], "ann owns a Plus pad");
  assert.deepEqual(await has(U.fan), [], "fan paid for it but doesn't own the pad");
  await assert.rejects(STK.buy(U.fan, { pack: "primeplus", ref: ref() }), /comes with 💎 Prime Time Plus/);
  await assert.rejects(STK.validate(U.fan.userId, "[sticker:primeplus/crown]"), /comes with 💎 Prime Time Plus/);
  assert.equal(await STK.validate(U.ann.userId, "[sticker:primeplus/crown] hi"), true);
  // Spooky Season: a Season Pass, in October
  await PR.buy(U.fan, { tier: "season_pass", months: 1, ref: ref() });
  assert.deepEqual(await has(U.fan), ["spooky"]);
  await assert.rejects(STK.buy(U.fan, { pack: "spooky", ref: ref(), allowance: true }), /Season Pass/);
  assert.match(STK.inline("[sticker:spooky/pumpkin]"), /<img class="stk stk-l" src="\/public\/stickers\/spooky\/pumpkin\.svg"/);
  const saved = t;
  t = Date.UTC(2026, 10, 9, 12);                      // 9 Nov: the season is over (the pass still runs)
  assert.deepEqual(await has(U.fan), [], "out of season");
  assert.ok(!STK.catalog().some((p) => p.id === "spooky"), "not listed out of season");
  assert.match(STK.inline("[sticker:spooky/ghost]"), /<img/, "already-sent stickers still render");
  t = saved;
  assert.equal(STK.inSeason({ season: { from: "12-20", to: "01-05" } }, Date.UTC(2027, 0, 2)), true, "a window can wrap the new year");
  // comps never hand out a perk pack
  await assert.rejects(STK.grantComp(U.bob.userId, "spooky", "test"), /Comp the tier instead/);
});

test("pad cosmetics: Plus items + the automatic 💎 badge on a Plus pad; Prime Time pads can't equip Plus items", async () => {
  const fxA = PC.fx(PAD_A);
  assert.match(fxA.badges, /pfx-b-pp/);
  assert.match(fxA.badges, /Prime Time Plus/);
  const cat = PC.catalog();
  const plusItems = cat.filter((i) => i.perk === "prime_plus").map((i) => i.id).sort();
  assert.deepEqual(plusItems, ["pp_frame", "pp_glow", "pp_headliner", "pp_redcarpet"]);
  assert.ok(cat.filter((i) => i.perk).every((i) => !i.sale), "perk items are never sold");
  const css = fs.readFileSync(path.join(repo, "public", "css", "padfx.css"), "utf8");
  assert.match(css, /\.pfx-f-primeplus\b/);
  assert.match(css, /\.pfx-g-primeplus \{ animation: none !important; \}/);
  const R = await rooms.get(PAD_A);
  const st = await PC.state(R, U.ann);
  assert.ok(["pp_frame", "pt_frame"].every((id) => st.has.includes(id)), "a Plus pad has the Plus AND the Prime Time items");
  const Rc = await rooms.get(PAD_C);
  assert.ok(!(await PC.state(Rc, U.fan)).has.includes("pp_frame"));
});

test("flair: the Plus pad's owner wears the automatic 💎 Plus flair there (not elsewhere); a Plus pad gets 50 flair slots", async () => {
  const f = await FL.forUsers(PAD_A, [U.ann.userId, U.fan.userId]);
  assert.equal(f.get(U.ann.userId).auto, "plus");
  assert.equal(f.has(U.fan.userId), false);
  assert.equal((await FL.byUsername(PAD_A)).get("ann").auto, "plus");
  assert.equal((await FL.forUsers(PAD_C, [U.fan.userId])).has(U.fan.userId), false);
  assert.equal(FL.maxFlairs(PAD_A), 50);
  assert.equal(FL.maxFlairs(PAD_C), 25);
  assert.match(FL.html(FL.plusFlair()), /Prime Time Plus pad/);
});

test("comps: a timed Plus comp (3 periods = 90 days) and a lifetime one, through comps.compPremium", async () => {
  const C = require(path.join(repo, "comps"));
  C._setClock(() => t);
  const r = await C.compPremium(U.boss, { tier: "prime_plus", pad: PAD_C, mode: "periods", n: 3, reason: "launch comp test" });
  assert.equal(r.until, t + 90 * DAY);
  assert.equal(PR.isPrimePlus(PAD_C), true);
  const h = await C.compPremium(U.boss, { tier: "prime_plus", pad: HOUSE, mode: "lifetime", reason: "launch comp test" });
  assert.equal(h.until, null);
  assert.equal(PR.statusOf(await PR.subRow("prime_plus", HOUSE)), "comped");
  t += 91 * DAY;
  await PR.expireComps(t);
  assert.equal(PR.isPrimePlus(PAD_C), false, "the timed comp ends");
  assert.equal(PR.isPrimePlus(HOUSE), true, "the lifetime one doesn't");
});

test("PATV Creators links follow the feature switch (creators.navFor)", async () => {
  const CR = require(path.join(repo, "creators"));
  await CR.init();
  assert.deepEqual(CR.navFor("ann"), { on: false, creator: false }, "off on prod by default (STAGING unset)");
  const layout = fs.readFileSync(path.join(repo, "views", "layout.ejs"), "utf8");
  assert.match(layout, /_cr\.on && \['\/creators', '⭐', t\('nav\.creators'\)\]/);
  assert.match(layout, /_cr\.creator \? \['\/creator', '⭐', t\('nav\.creator_dash'\)\] : \['\/creators#apply', '🌟', t\('nav\.become_creator'\)\]/);
  const EN = require(path.join(repo, "locales", "en.json"));
  for (const k of ["nav.creators", "nav.creator_dash", "nav.become_creator", "cr.links.subscribe", "cr.links.creator_chip", "cr.links.browse", "pad.plus.h", "premium.pp.bridge", "premium.lead3"]) assert.ok(EN[k], k);
});

test("1.99qt: chip in to a pad's Plus (amount / price x 30 days, at least a day's worth, anonymous allowed); the card has the box", async () => {
  const sub0 = await PR.subRow("prime_plus", PAD_A);
  const day = Math.ceil(50000000 / 30);
  await assert.rejects(PR.buy(U.fan, { tier: "prime_plus", pad: PAD_A, amount: day - 1, ref: ref() }), /at least/);
  const r = await PR.buy(U.fan, { tier: "prime_plus", pad: PAD_A, amount: 5000000, ref: ref(), anon: true });
  assert.deepEqual([r.kind, r.amount, r.days], ["contribute", 5000000, 3]);
  assert.equal(r.paid_through, Math.max(Number(sub0.paid_through), t) + 3 * DAY);
  const L = (await getQuery("SELECT kind, anon FROM premium_ledger WHERE tier = 'prime_plus' AND kind = 'contribute'"))[0];
  assert.deepEqual([L.kind, L.anon], ["contribute", 1]);
  const v = fs.readFileSync(path.join(repo, "views", "premium.ejs"), "utf8");
  assert.match(v, /id="ppAmt" min="<%= S\.day_price\.prime_plus %>"/);
  assert.match(v, /data-chip="prime_plus"/);
  assert.match(v, /data-chip="prime_time"/);
  assert.match(v, /document\.getElementById\(chipTier === 'prime_plus' \? 'ppAnon' : 'ptAnon'\)/);
  assert.ok(require(path.join(repo, "locales", "en.json"))["js.premium.confirm_chip_plus"]);
});
