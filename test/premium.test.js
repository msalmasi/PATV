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
  assert.deepEqual(C.routes, { prime_time: [["fortknox", 50], ["room", 50]], prime_plus: [["fortknox", 50], ["room", 50]], season_pass: [["fortknox", 100]], stickers: [["fortknox", 100]], banner: [["fortknox", 100]],
                               creators: [["fortknox", 50], ["room", 50]],     // 1.99pv: PATV Creators' 20% cut
                               quotes: [["fortknox", 50], ["room", 50]],       // 1.99qw: chat quotes (after the likeness cut)
                               soundboard_pack: [["fortknox", 100]], soundboard_legend: [["fortknox", 100]], voice_unlock: [["fortknox", 100]] });
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
  await runQuery("UPDATE users SET camfrogUsername = ? WHERE userId = ?", ["FanCF", fan.userId]);
  assert.deepEqual(await PR.passCamfrogs(), ["fancf"], "1.99nw: Pepe's list - Camfrog logins with a Season Pass, lowercase");
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
  await assert.rejects(PR.buy(fan, { tier: "gold", ref: ref() }), /Prime Time, Prime Time Plus or Season Pass/);
  await assert.rejects(PR.buy(fan, { tier: "season_pass", ref: "x" }), /ref/);
  await assert.rejects(PR.buy(fan, { tier: "prime_time", pad: "nope-nope", ref: ref() }), /No pad called nope-nope/);
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
  assert.deepEqual(PR.padPerks(DRAMA), { primeTime: true, primePlus: false, tier: "prime_time", extraSlots: 2, extraBadges: 2, lowLatency: true,
                                         bridge: true, retention: "prime", soundboardSlots: 8 });
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

// A12's helpers: the drawn pills' texts, in order (padcosmetics.badgeHtml); PLANT's stored pad badges; the hub's drawing of
// a pads/changed payload's badges (seam plan §12.4 - the hub's seam-s1-fixtures drawPad): the live ones in equip order,
// cut to badge_max.prime (clamped to 7) on Prime / Plus and to badge_max.free otherwise
const pills = (html) => [...String(html).matchAll(/<span class="pfx-b(?: pfx-b-p[tp])?">(?:<span aria-hidden="true">[^<]*<\/span>)?([^<]*)<\/span>/g)].map((m) => m[1]);
const storedBadges = async (room) => JSON.parse((await getQuery("SELECT cosmetics FROM pad_looks WHERE room_id = ?", [room]))[0].cosmetics).pad_badge;
function hubDraw(badges, tier, bm) {
  const shows = (perk) => perk === null || (perk === "prime_plus" ? tier === "plus" : tier === "prime" || tier === "plus");
  const prime = Math.min(bm.prime, 7);
  const cap = tier === "free" ? Math.min(bm.free, prime) : prime;
  return badges.filter((b) => shows(b.perk)).slice(0, cap).map((b) => b.id);
}
const A12_FIVE = ["pb_est2026", "pt_onair", "pb_community", "pt_premiere", "pb_talk"];
const A12_DRAWN = ["Prime Time", "Est. 2026", "On Air", "Community", "Premiere", "Talk"];
/** The catalog plus free badges for the tests ("pb_six", "pb_x4", ...: common, 25,000 PAT, text only). */
const withBadges = (real, ids) => PC.buildCatalog({ items: [...real.items, ...ids.map((id) => ({ id, kind: "pad_badge", name: id, rarity: "common", price: 25000,
  style: { text: id === "pb_six" ? "Six" : id.slice(3).toUpperCase() } }))] }, real.rarities);

test("A12 (S1 call 12): a Prime Time pad keeps badge_max.prime (5) pad badges - stored, drawn, mirrored; a 6th is refused; a lapse or a lowered config hides the extra ones and keeps them", async () => {
  const PL = require(path.join(repo, "padlook"));
  const HP = require(path.join(repo, "hubpads"));
  const stored = () => storedBadges(PLANT);
  const five = A12_FIVE;
  assert.deepEqual(PC.badgeMax(), { free: 3, prime: 5 }, "the hub's badge_max: 3, and 3 + prime_extra_badges");
  assert.equal(PC.badgeStoreMax(), 7, "pad_looks keeps up to 3 + premium.PRIME_EXTRA_BADGES_MAX, whatever the config");
  assert.equal(PR.isPrime(PLANT), true);
  for (const b of ["pb_est2026", "pb_community", "pb_talk"]) await PC.buy(owner, PLANT, b, { ref: ref() });
  let c;
  for (const b of five) c = await PC.equip(owner, PLANT, b, true);
  assert.deepEqual(c.pad_badge, five, "all five come back from the write (it used to keep 3)");
  assert.deepEqual(await stored(), five, "pad_looks.cosmetics holds all five");
  assert.deepEqual(PL.cosmeticsOf(PLANT).pad_badge, five, "and they read back");
  assert.deepEqual(pills(PC.fx(PLANT).badges), A12_DRAWN, "drawn: the automatic badge + five");
  // the seam payload follows (hubpads reads pad_looks.cosmetics through padlook.parseCosmetics)
  assert.deepEqual(HP.cosmeticsOf(JSON.stringify({ pad_badge: five })).badges.map((b) => b.id), five);
  // a 6th: refused at the pad's cap
  const real = PC.CAT;
  PC._setCatalog(withBadges(real, ["pb_six"]));
  try {
    await PC.buy(owner, PLANT, "pb_six", { ref: ref() });
    await assert.rejects(PC.equip(owner, PLANT, "pb_six", true), (e) => e.status === 409 && e.message === "Up to 5 badges at a time - take one off first.");
    // parseCosmetics: deduped (the copy is inside the first five), cut at badgeStoreMax (7) - not at the current cap
    assert.deepEqual(PL.parseCosmetics(JSON.stringify({ pad_badge: ["pb_est2026", "pb_est2026", "pt_onair", "pb_community", "pt_premiere", "pb_talk"] })).pad_badge, five, "deduped");
    const nine = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9"];
    assert.deepEqual(PL.parseCosmetics(JSON.stringify({ pad_badge: nine })).pad_badge, nine.slice(0, 7), "cut at 7");
    // the cap follows premium's prime_extra_badges (one source with the seam's badge_max - test/huboutbox-s1-l1.test.js)
    await PR.setConfig({ prime_extra_badges: 3 }, "test");
    try {
      assert.deepEqual(PC.badgeMax(), { free: 3, prime: 6 });
      c = await PC.equip(owner, PLANT, "pb_six", true);
      assert.deepEqual(c.pad_badge, [...five, "pb_six"]);
      assert.deepEqual(pills(PC.fx(PLANT).badges), [...A12_DRAWN, "Six"]);
    } finally { await PR.setConfig({ prime_extra_badges: 2 }, "test"); }
    // lowered again: the 6th stops drawing but stays equipped - through an unrelated write too - and draws again with the config
    assert.deepEqual(pills(PC.fx(PLANT).badges), A12_DRAWN);
    c = await PC.equip(owner, PLANT, "pb_est2026", true);       // a write (it's already on)
    assert.deepEqual([c.pad_badge, await stored()], [[...five, "pb_six"], [...five, "pb_six"]], "the write keeps the hidden 6th");
    let st = await PC.state(rooms.getCached(PLANT), owner);
    assert.deepEqual([st.slots.pad_badge.max, st.equipped.pad_badge, st.shown_badges], [5, [...five, "pb_six"], five], "the sheet: 6 on, 5 shown");
    await PR.setConfig({ prime_extra_badges: 3 }, "test");
    try { assert.deepEqual(pills(PC.fx(PLANT).badges), [...A12_DRAWN, "Six"], "back with the config"); }
    finally { await PR.setConfig({ prime_extra_badges: 2 }, "test"); }
    c = await PC.equip(owner, PLANT, "pb_six", false);
    assert.deepEqual(c.pad_badge, five);
    // the clamp: v1's prime cap never passes the hub's PAD_BADGE_CAP (7, seam plan §12.4)
    assert.equal(PR.PRIME_EXTRA_BADGES_MAX, 4);
    assert.equal(PR.cleanConfig({ prime_extra_badges: 5 }).prime_extra_badges, 4, "was allowed up to 5 (a cap of 8)");
    // the tier lapses: the two Prime Time badges stop drawing and the free cap (3) applies; all five stay equipped
    t = T0 + 400 * DAY;
    try {
      assert.equal(PR.isPrime(PLANT), false);
      assert.deepEqual(pills(PC.fx(PLANT).badges), ["Est. 2026", "Community", "Talk"]);
      await assert.rejects(PC.equip(owner, PLANT, "pb_six", true),
        (e) => e.status === 409 && e.message === "Up to 3 badges at a time - 5 are on (2 not shown), so take 3 off first.");
      c = await PC.equip(owner, PLANT, "pb_talk", true);          // a write while lapsed (already on) keeps the other four
      assert.deepEqual(c.pad_badge, five);
      assert.deepEqual(await stored(), five);
      st = await PC.state(rooms.getCached(PLANT), owner);
      assert.deepEqual([st.slots.pad_badge.max, st.equipped.pad_badge, st.shown_badges], [3, five, ["pb_est2026", "pb_community", "pb_talk"]],
                       "the sheet: the free cap, all five on, the three it draws (the rest are marked 'not shown')");
      assert.equal(st.has.includes("pt_onair"), false, "the perk item isn't the pad's while lapsed (the sheet's own Take off button)");
      // a perk badge the tier no longer covers can still be taken off (the sheet's Take off), and then it counts no more
      c = await PC.equip(owner, PLANT, "pt_onair", false);
      assert.deepEqual(c.pad_badge, ["pb_est2026", "pb_community", "pt_premiere", "pb_talk"]);
      await assert.rejects(PC.equip(owner, PLANT, "pb_six", true), (e) => e.status === 409 && /4 are on \(1 not shown\), so take 2 off first\.$/.test(e.message));
      c = await PC.equip(owner, PLANT, "pt_premiere", false);
      await assert.rejects(PC.equip(owner, PLANT, "pb_six", true), (e) => e.status === 409 && e.message === "Up to 3 badges at a time - take one off first.");
      assert.deepEqual(pills(PC.fx(PLANT).badges), ["Est. 2026", "Community", "Talk"]);
      // at the cap with two of the three hidden (perk badges while lapsed): the refusal says so - one shows, "up to 3"
      await PL.setCosmetics(PLANT, { pad_badge: ["pt_onair", "pt_premiere", "pb_est2026"] }, "test");
      assert.deepEqual(pills(PC.fx(PLANT).badges), ["Est. 2026"]);
      await assert.rejects(PC.equip(owner, PLANT, "pb_six", true),
        (e) => e.status === 409 && e.message === "Up to 3 badges at a time - 3 are on (2 not shown), so take 1 off first.");
    } finally { t = T0; }
    await PL.setCosmetics(PLANT, { pad_badge: five }, "test");
    assert.deepEqual(pills(PC.fx(PLANT).badges), A12_DRAWN, "back with the tier");
  } finally { PC._setCatalog(real); }
});

test("A12 fix-ups: a lapse with five free badges draws the same 3 as the hub's §12.4 rule, in order; one equip at a time per pad", async () => {
  const PL = require(path.join(repo, "padlook"));
  const HP = require(path.join(repo, "hubpads"));
  const stored = () => storedBadges(PLANT);
  const real = PC.CAT;
  PC._setCatalog(withBadges(real, ["pb_six", "pb_x4", "pb_x5"]));
  try {
    for (const b of ["pb_x4", "pb_x5"]) await PC.buy(owner, PLANT, b, { ref: ref() });     // pb_six: the test above
    assert.equal(PR.isPrime(PLANT), true);
    // two at once on a pad with 3 on (cap 5): both land - each used to write over the other, both reporting success
    await PL.setCosmetics(PLANT, { pad_badge: ["pb_est2026", "pb_community", "pb_talk"] }, "test");
    const [a, b] = await Promise.all([PC.equip(owner, PLANT, "pb_six", true), PC.equip(owner, PLANT, "pb_x4", true)]);
    const freeFive = ["pb_est2026", "pb_community", "pb_talk", "pb_six", "pb_x4"];
    assert.deepEqual([a.pad_badge, b.pad_badge], [freeFive.slice(0, 4), freeFive]);
    assert.deepEqual(await stored(), freeFive);
    // three at once with 4 on: the first lands, the other two are refused (the cap holds and nobody is told a lie)
    await PC.equip(owner, PLANT, "pb_x4", false);
    const r = await Promise.allSettled(["pb_x4", "pb_x5", "pt_onair"].map((x) => PC.equip(owner, PLANT, x, true)));
    assert.deepEqual(r.map((x) => x.status), ["fulfilled", "rejected", "rejected"]);
    assert.ok(r.slice(1).every((x) => x.reason.status === 409 && x.reason.message === "Up to 5 badges at a time - take one off first."));
    assert.deepEqual(await stored(), freeFive);
    // the tier lapses: v1 draws the first 3, and the hub's rule on the seam's badges picks the same 3 in the same order
    const pills5 = ["Prime Time", "Est. 2026", "Community", "Talk", "Six", "X4"];
    assert.deepEqual(pills(PC.fx(PLANT).badges), pills5);
    t = T0 + 400 * DAY;
    try {
      assert.equal(PR.isPrime(PLANT), false);
      const drawn = PC.shownBadges(PLANT).map((i) => i.id);
      assert.deepEqual(drawn, ["pb_est2026", "pb_community", "pb_talk"]);
      assert.deepEqual(pills(PC.fx(PLANT).badges), ["Est. 2026", "Community", "Talk"], "3, the free cap - not the 5 stored");
      const sent = HP.cosmeticsOf(JSON.stringify({ pad_badge: await stored() })).badges;
      assert.deepEqual(sent.map((x) => x.id), freeFive, "the seam sends all five");
      assert.deepEqual(hubDraw(sent, "free", PC.badgeMax()), drawn, "the hub draws the same 3, in the same order");
      const st = await PC.state(rooms.getCached(PLANT), owner);
      assert.deepEqual([st.slots.pad_badge.max, st.equipped.pad_badge, st.shown_badges], [3, freeFive, drawn], "the sheet: 5 on, 3 shown");
      await assert.rejects(PC.equip(owner, PLANT, "pb_x5", true),
        (e) => e.status === 409 && e.message === "Up to 3 badges at a time - 5 are on (2 not shown), so take 3 off first.");
      // one off: the next in equip order shows, on both sides
      const c = await PC.equip(owner, PLANT, "pb_community", false);
      assert.deepEqual(pills(PC.fx(PLANT).badges), ["Est. 2026", "Talk", "Six"]);
      assert.deepEqual(hubDraw(HP.cosmeticsOf(JSON.stringify(c)).badges, "free", PC.badgeMax()), ["pb_est2026", "pb_talk", "pb_six"]);
    } finally { t = T0; }
    // back with the tier: all four live ones, on both sides
    const back = PC.shownBadges(PLANT).map((i) => i.id);
    assert.deepEqual(back, ["pb_est2026", "pb_talk", "pb_six", "pb_x4"]);
    assert.deepEqual(hubDraw(HP.cosmeticsOf(JSON.stringify({ pad_badge: await stored() })).badges, "prime", PC.badgeMax()), back);
  } finally {
    PC._setCatalog(real);
    await PL.setCosmetics(PLANT, { pad_badge: A12_FIVE }, "test");
  }
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
