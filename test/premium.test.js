// Offline tests for 1.99iv: Prime Time (pad tier) + Season Pass (personal tier) - premium.js, and the perks wired into
// padcosmetics.js (Prime Time items, badge slots, the automatic badge), cosmetics.js (Season Pass items), rooms.view
// (pad.primeTime) and roomsweb (extra stage slots).
//   NODE_PATH=G:/PATV/node_modules node --test test/premium.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "premium-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.STRIPE_ENABLED;
process.env.SECRET_KEY = "test-secret";
process.env.PAD_DIR = path.join(tmp, "pad");
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const PR = require(path.join(repo, "premium"));
const PC = require(path.join(repo, "padcosmetics"));
const COS = require(path.join(repo, "cosmetics"));
const F = require(path.join(repo, "funding"));

const PLANT = "plant_based_chatting", DRAMA = "DRAMA_CENTRAL";
const DAY = 24 * 3600 * 1000;
const USERS = {};
let owner, fan, boss, poor, server, base;
let T0 = Date.UTC(2026, 9, 10, 12);
let t = T0;
PR._setClock(() => t);

async function mkUser(name, { cls = "pleb", bal = 50000000 } = {}) {
  const id = "u-" + name;
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, points_balance) VALUES (?, ?, ?, 'x', ?, ?)", [id, name, name, cls, bal]);
  USERS[name] = { userId: id, username: name, class: cls };
  return USERS[name];
}
const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [u.userId]))[0].b;
const setBal = (u, b) => runQuery("UPDATE users SET points_balance = ? WHERE userId = ?", [b, u.userId]);
const ref = () => "r" + Math.random().toString(36).slice(2, 12) + "x";
const claims = async (u) => (await getQuery("SELECT flow, amount FROM reserve_claims WHERE userId = ? ORDER BY rowid", [u.userId])).map((c) => [c.flow, c.amount]);
const clearClaims = () => runQuery("DELETE FROM reserve_claims");

function req(method, url, { user, json } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Origin: base };
    if (user) h["x-test-user"] = user;
    let data = null;
    if (json !== undefined) { data = Buffer.from(JSON.stringify(json)); h["Content-Type"] = "application/json"; h["Content-Length"] = data.length; }
    const r = http.request(base + url, { method, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch (e) { j = null; } resolve({ status: res.statusCode, json: j }); });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, level INTEGER DEFAULT 0, avatar TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  owner = await mkUser("plantowner");
  fan = await mkUser("fan");
  boss = await mkUser("boss", { cls: "Admin" });
  poor = await mkUser("poor", { bal: 1000 });
  await rooms.init();
  await rooms.setOwner(PLANT, "plantowner", "test");
  await rooms.addRoom(DRAMA, null, "test");
  await rooms.setOwner(DRAMA, "boss", "test");
  await PR.init();
  await PC.init();
  const app = express();
  app.use(express.json());
  const addUser = (rq, rs, next) => { const u = rq.get("x-test-user"); rq.user = u ? USERS[u] || null : null; next(); };
  PR.register(app, { addUser });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { if (server) server.close(); F.sync({}); });

test("config: the proposed prices and perks, routing rows with defaults; a bad row falls back, 'room' only on Prime Time", async () => {
  const C = PR.config();
  assert.deepEqual([C.prime_price, C.season_price, C.period_days, C.grace_days, C.sticker_price], [10000000, 2000000, 30, 3, 250000]);
  assert.deepEqual(C.routes, { prime_time: [["fortknox", 50], ["room", 50]], season_pass: [["fortknox", 100]], stickers: [["fortknox", 100]] });
  const R = PR.cleanRoutes({ prime_time: [["burn", 100]], season_pass: [["room", 100]], stickers: [["reserve", 30], ["fortknox", 60]] });
  assert.deepEqual(R.prime_time, [["fortknox", 50], ["room", 50]], "no burn destination exists");
  assert.deepEqual(R.season_pass, [["fortknox", 100]], "a personal flow has no room");
  assert.deepEqual(R.stickers, [["reserve", 30], ["fortknox", 60]]);
  assert.deepEqual(PR.splitRoute([["fortknox", 50], ["room", 50]], 10000001), [{ dest: "fortknox", amount: 5000000 }, { dest: "room", amount: 5000000 }, { dest: "reserve", amount: 1 }]);
  assert.deepEqual(PR.splitRoute([["reserve", 30], ["fortknox", 60]], 1000), [{ dest: "reserve", amount: 400 }, { dest: "fortknox", amount: 600 }], "the rest joins the Reserve share");
});

test("Season Pass for yourself: one debit with a ledger row, 100% Fort Knox, perks on + Season Pass items in the inventory; a replayed ref charges nothing", async () => {
  F.sync({ fortknox: 1000 });                                   // Fort Knox live in Pepe
  const b0 = await bal(fan);
  const r0 = ref();
  const r = await PR.buy(fan, { tier: "season_pass", months: 1, ref: r0 });
  assert.deepEqual([r.dup, r.amount, r.days, r.gift, r.paid_through], [false, 2000000, 30, false, T0 + 30 * DAY]);
  assert.equal(await bal(fan), b0 - 2000000);
  const tx = await getQuery("SELECT type, points, transactionId FROM transactions WHERE userId = ?", [fan.userId]);
  assert.deepEqual(tx.map((x) => x.points), [-2000000]);
  assert.match(tx[0].type, /🎟️ Season Pass buy: u\/fan/);
  assert.equal(tx[0].transactionId, PR.txRef(`prem:${fan.userId}:${r0}`), "the transaction id comes from the ref");
  assert.deepEqual(await claims(fan), [["fortknox:season_pass", -2000000]]);
  const L = await getQuery("SELECT kind, amount, days, period_from, period_to FROM premium_ledger WHERE payer_id = ?", [fan.userId]);
  assert.deepEqual(L.map((x) => [x.kind, x.amount, x.days, x.period_from, x.period_to]), [["buy", 2000000, 30, T0, T0 + 30 * DAY]]);
  assert.equal(PR.hasPass(fan.userId), true);
  assert.deepEqual(PR.userPerks(fan.userId), { seasonPass: true, uploadMult: 2, stickerPacks: 1 });
  const inv = await COS.inventory(fan.userId);
  assert.deepEqual(inv.items.map((i) => i.item_id).sort(), ["ad_seasonpass", "bn_seasonpass", "nc_seasonpass"]);
  assert.ok(inv.items.every((i) => i.perk === "season_pass" && !i.perk_off));
  // replay
  const again = await PR.buy(fan, { tier: "season_pass", months: 1, ref: r0 });
  assert.equal(again.dup, true);
  assert.equal(await bal(fan), b0 - 2000000);
  // a second period stacks on the first
  const r2 = await PR.buy(fan, { tier: "season_pass", months: 2, ref: ref() });
  assert.equal(r2.paid_through, T0 + 90 * DAY);
  await clearClaims();
});

test("Season Pass items: equip only while the pass is on, never listed / traded, hidden when it lapses", async () => {
  const inv = await COS.inventory(fan.userId);
  const nc = inv.items.find((i) => i.item_id === "nc_seasonpass");
  assert.equal((await COS.equip(fan.userId, nc.inv_id, true)).ok, true);
  assert.ok((await COS.equippedFor(fan.userId)).name_color, "rendered while the pass is on");
  const tr = await COS.transfer({ invId: nc.inv_id, fromId: fan.userId, toId: owner.userId, idem: "x1" });
  assert.equal(tr.ok, false);
  assert.match(tr.error, /can't be traded/);
  // a moment past the paid time with no renewer: lapsed
  const save = t; t = T0 + 91 * DAY;
  try {
    assert.equal(PR.hasPass(fan.userId), false);
    assert.equal((await COS.equippedFor(fan.userId)).name_color, undefined, "a lapsed pass's look stops rendering");
    const e2 = await COS.equip(fan.userId, nc.inv_id, true);
    assert.equal(e2.ok, false);
    assert.match(e2.error, /Season Pass/);
  } finally { t = save; }
});

test("Prime Time gift / contribution: 50% Fort Knox, 50% the pad's room vault; the owner paying: 100% Fort Knox; no vaults: all Fort Knox", async () => {
  F.sync({ fortknox: 1000, room_vaults: { on: true, cap: 50000000 } });
  const r = await PR.buy(fan, { tier: "prime_time", pad: PLANT, months: 1, ref: ref() });
  assert.deepEqual([r.amount, r.gift, r.kind, r.paid_through], [10000000, true, "gift", T0 + 30 * DAY]);
  assert.deepEqual(await claims(fan), [["fortknox:prime_time", -5000000], ["room:prime_time:" + PLANT, -5000000]]);
  assert.equal(PR.isPrime(PLANT), true);
  assert.equal((await rooms.get(PLANT)).primeTime, true, "pad.primeTime");
  assert.equal((await rooms.get(DRAMA)).primeTime, false);
  // the owner was told
  const n = await getQuery("SELECT kind, title FROM inbox WHERE user_id = ?", [owner.userId]);
  assert.equal(n.length, 1);
  assert.match(n[0].title, /fan paid for Prime Time on p\//);
  await clearClaims();
  // the owner, own pad: self-spend never feeds your own vault
  await PR.buy(owner, { tier: "prime_time", pad: PLANT, months: 1, ref: ref() });
  assert.deepEqual(await claims(owner), [["fortknox:prime_time", -10000000]]);
  await clearClaims();
  // a contribution: pro rata, at least a day
  const c = await PR.buy(fan, { tier: "prime_time", pad: PLANT, amount: 1000000, ref: ref() });
  assert.equal(c.kind, "contribute");
  assert.equal(c.days, 3);
  assert.equal(c.paid_through, T0 + 63 * DAY);
  await assert.rejects(PR.buy(fan, { tier: "prime_time", pad: PLANT, amount: 1000, ref: ref() }), /at least 333,334 PAT/);
  // vaults off (and Fort Knox off): the room share isn't escrowed - it all goes to Fort Knox's stand-in, the Reserve flow
  await clearClaims();
  F.sync({});
  await PR.buy(fan, { tier: "prime_time", pad: PLANT, amount: 1000000, ref: ref() });
  assert.deepEqual(await claims(fan), [["prime_time", -1000000]]);
  await clearClaims();
});

test("not enough PAT: refused (402), nothing written; comped pads / accounts can't be bought; bad input", async () => {
  const n0 = (await getQuery("SELECT COUNT(*) AS n FROM premium_ledger"))[0].n;
  await assert.rejects(PR.buy(poor, { tier: "season_pass", months: 1, ref: ref() }), (e) => e.status === 402);
  assert.equal(await bal(poor), 1000);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM premium_ledger"))[0].n, n0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM transactions WHERE userId = ?", [poor.userId]))[0].n, 0);
  assert.equal((await claims(poor)).length, 0);
  await assert.rejects(PR.buy(fan, { tier: "gold", ref: ref() }), /Prime Time or Season Pass/);
  await assert.rejects(PR.buy(fan, { tier: "season_pass", ref: "x" }), /ref/);
  await assert.rejects(PR.buy(fan, { tier: "prime_time", pad: "nope-nope", ref: ref() }), /No such pad/);
});

test("renewals: the daily job charges the renewer once per period (idempotent), extends from the paid date; can't pay -> grace -> lapse", async () => {
  // fresh: owner's Season Pass with auto-renew
  await PR.buy(owner, { tier: "season_pass", months: 1, ref: ref(), renew: true });
  const sub = await PR.subRow("season_pass", owner.userId);
  assert.equal(sub.renewer_id, owner.userId);
  const end = sub.paid_through;
  t = end + 3600 * 1000;                                     // due
  const b0 = await bal(owner);
  const r1 = await PR.renewDue(t);
  assert.equal(r1.renewed, 1);
  assert.equal(await bal(owner), b0 - 2000000);
  assert.equal((await PR.subRow("season_pass", owner.userId)).paid_through, end + 30 * DAY, "from the paid date, not from now");
  const r2 = await PR.renewDue(t);
  assert.equal(r2.renewed, 0, "a second run charges nothing");
  assert.equal(await bal(owner), b0 - 2000000);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM premium_ledger WHERE kind = 'renew' AND target = ?", [owner.userId]))[0].n, 1);
  // next period: broke -> grace (perks stay on), one notice
  await setBal(owner, 5);
  t = end + 30 * DAY + 1000;
  const g = await PR.renewDue(t);
  assert.deepEqual([g.renewed, g.failed], [0, 1]);
  const sg = await PR.subRow("season_pass", owner.userId);
  assert.equal(PR.statusOf(sg, t), "grace");
  assert.equal(PR.hasPass(owner.userId), true, "grace keeps the perks on");
  await PR.renewDue(t + 1000);
  const notes = await getQuery("SELECT title FROM inbox WHERE user_id = ? AND title LIKE '%couldn''t be paid%'", [owner.userId]);
  assert.equal(notes.length, 1, "one grace notice per period");
  // grace over -> lapsed, renewer cleared, perks off, a notice
  t = end + 30 * DAY + 3 * DAY + 1000;
  const l = await PR.renewDue(t);
  assert.equal(l.lapsed >= 1, true);
  const sl = await PR.subRow("season_pass", owner.userId);
  assert.deepEqual([PR.statusOf(sl, t), sl.renewer_id], ["lapsed", null]);
  assert.equal(PR.hasPass(owner.userId), false);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = ? AND title LIKE '%ended%'", [owner.userId]))[0].n, 1);
  await PR.renewDue(t + 1000);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM inbox WHERE user_id = ? AND title LIKE '%ended%'", [owner.userId]))[0].n, 1, "lapse notice once");
  await setBal(owner, 50000000);
  t = T0;
  await clearClaims();
});

test("admin comp: the site admin's account gets a Season Pass, their pads Prime Time - once per day, undone when they stop being an admin", async () => {
  t = T0 + 200 * DAY;
  const r = await PR.tick();
  assert.equal(r.skipped, undefined);
  assert.deepEqual([r.comps.added, r.comps.total], [2, 2]);
  assert.equal(PR.hasPass(boss.userId), true);
  assert.equal(PR.isPrime(DRAMA), true);
  assert.equal(PR.statusOf(await PR.subRow("prime_time", DRAMA)), "comped");
  assert.equal((await PR.tick()).skipped, true, "the daily job runs once a day");
  // comped: buying is refused, perks forever
  await assert.rejects(PR.buy(fan, { tier: "prime_time", pad: DRAMA, months: 1, ref: ref() }), /for free/);
  t = T0 + 5000 * DAY;
  assert.equal(PR.isPrime(DRAMA), true);
  // demoted -> the automatic comps go; a hand-made comp stays
  await PR.setComp("season_pass", fan.userId, true, "boss", "thanks");
  await runQuery("UPDATE users SET class = 'pleb' WHERE userId = ?", [boss.userId]);
  const r2 = await PR.tick({ force: true });
  assert.equal(r2.comps.removed, 2);
  assert.equal(PR.isPrime(DRAMA), false);
  assert.equal(PR.hasPass(boss.userId), false);
  assert.equal(PR.hasPass(fan.userId), true, "manual comp kept");
  await runQuery("UPDATE users SET class = 'Admin' WHERE userId = ?", [boss.userId]);
  await PR.tick({ force: true });
  assert.equal(PR.isPrime(DRAMA), true);
  t = T0;
});

test("Prime Time perks on the pad: its items equip only while it's on, +2 badge slots, the automatic badge; stage slot bonus", async () => {
  // DRAMA is comped (admin's pad)
  assert.deepEqual(PR.padPerks(DRAMA), { primeTime: true, extraSlots: 2, extraBadges: 2, lowLatency: true });
  await PC.equip(boss, DRAMA, "pt_frame", true);
  for (const b of ["pt_onair", "pt_premiere"]) await PC.equip(boss, DRAMA, b, true);
  const fx = PC.fx(DRAMA);
  assert.match(fx.cls, /pfx-f-primetime/);
  assert.match(fx.badges, /pfx-b pfx-b-pt.*Prime Time/);
  assert.match(fx.badges, /On Air/);
  await assert.rejects(PC.buy(fan, DRAMA, "pt_frame", { ref: ref() }), /comes with 📺 Prime Time/);
  // a pad without it (PLANT once its paid time is over): refused, and the badge is absent
  t = T0 + 400 * DAY;                                          // PLANT's Prime Time is long over
  try {
    assert.equal(PR.isPrime(PLANT), false);
    await assert.rejects(PC.equip(owner, PLANT, "pt_glow", true), /Prime Time/);
    assert.doesNotMatch(PC.fx(PLANT).badges, /Prime Time/);
  } finally { t = T0; }
  const st = await PC.state(rooms.getCached(DRAMA), boss);
  assert.equal(st.slots.pad_badge.max, 5);
  assert.equal(st.prime.on, true);
  assert.ok(st.has.includes("pt_frame"));
});

test("HTTP: buy + state + renew toggle, same-site JSON only; admin view is staff-only", async () => {
  const s0 = await req("GET", "/api/premium/state?pad=" + PLANT, { user: "fan" });
  assert.equal(s0.status, 200);
  assert.equal(s0.json.prices.prime_time, 10000000);
  assert.equal(s0.json.stripe.enabled, false, "Stripe is off and says nothing more");
  assert.deepEqual(Object.keys(s0.json.stripe), ["enabled"]);
  const b = await req("POST", "/api/premium/buy", { user: "fan", json: { tier: "prime_time", pad: PLANT, months: 1, ref: ref(), renew: true } });
  assert.equal(b.status, 200, JSON.stringify(b.json));
  assert.equal(b.json.state.pad.renewer_me, true);
  const off = await req("POST", "/api/premium/renew", { user: "plantowner", json: { tier: "prime_time", pad: PLANT, on: false } });
  assert.equal(off.json.ok, true, "the pad's owner can switch a renewer off");
  const anon = await req("POST", "/api/premium/buy", { json: { tier: "season_pass", ref: ref() } });
  assert.equal(anon.status, 401);
  const adm = await req("GET", "/api/premium/admin", { user: "fan" });
  assert.equal(adm.status, 403);
  const adm2 = await req("POST", "/api/premium/admin", { user: "boss", json: { config: { prime_price: 12000000 }, comp: { tier: "season_pass", user: "poor", on: true } } });
  assert.equal(adm2.status, 200, JSON.stringify(adm2.json));
  assert.equal(adm2.json.config.prime_price, 12000000);
  assert.equal(PR.hasPass(poor.userId), true);
  await PR.setConfig({ prime_price: 10000000 }, "test");
  await clearClaims();
});
