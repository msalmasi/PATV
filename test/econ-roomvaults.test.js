// Offline tests for economy v2 phase E-3 on the site (camfrog-bot docs/ECONOMY-V2.md 6.4 / 9 / 11.5 / 12; Pepe's
// pepe_roomvault.py):
//   * funding.sync: room vaults are "live" only while Pepe reports them (every sync resets it)
//   * boosts.routeInTx: OFF = the room half is held in the escrow exactly as before (no room claim, rv_to NULL);
//     ON = it is a "room:<flow>:<room id>" claim (rv_to 'room') that never counts as escrow; the owner / a pad without a
//     vault (a site pad) = all Fort Knox; site-side conservation (wallet debits == every claim + the escrow)
//   * room claims are not the Reserve's (fundable / canFund unaffected)
//   * the escrow migration: per-room NET escrow (challenge prizes subtracted, live rows excluded), the mark is
//     batch-keyed, amount-checked per room, a replay is a no-op, bot token required
//   * mic challenges: room-vault mode budgets on Pepe's balance (same caps), rv_to 'room', echoes the vault; an
//     escrow-mode prize is refused while room vaults are live; off = unchanged
//   * roomvaults.js: Pepe's sync, the pad card (inflow vs deposits), the owner's rate (bounds, owner only, once a
//     week, staff any time), the routes
//   NODE_PATH=G:/PATV/node_modules node --test test/econ-roomvaults.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "econ-rv-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const B = require(path.join(repo, "boosts"));
const F = require(path.join(repo, "funding"));
const CP = require(path.join(repo, "challengepay"));
const RV = require(path.join(repo, "roomvaults"));
const rooms = require(path.join(repo, "rooms"));
const S = require(path.join(repo, "mainstage"));

const DAY = 24 * 3600 * 1000;
let T = Date.UTC(2026, 9, 9, 18, 0, 0);
rooms._setClock(() => T); B._setClock(() => T); S._setClock(() => T); CP._setClock(() => T); RV._setClock(() => T);
const DRAMA = "DRAMA_CENTRAL", PLANT = "plant_based_chatting", LOUNGE = "patv:lounge";
let n = 0;
async function mkUser(extra = {}) {
  const id = "v" + (++n);
  const name = extra.username || "user" + n;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, points_balance, camfrogUsername, class)
                  VALUES (?, ?, ?, 'x', ?, ?, ?)`, [id, name, name, extra.bal != null ? extra.bal : 1000000, extra.camfrog || null, extra.cls || "pleb"]);
  return { userId: id, username: name, class: extra.cls || "pleb" };
}
const ref = () => "r" + Math.random().toString(36).slice(2, 12) + "x";
const wallets = async () => (await getQuery("SELECT COALESCE(SUM(points_balance), 0) AS w FROM users"))[0].w;
const claimsSum = async () => (await getQuery("SELECT COALESCE(SUM(amount), 0) AS t FROM reserve_claims"))[0].t;
const LIVE = { reserve: 5000000, flows: {}, fortknox: 0, room_vaults: { on: true, cap: 50000000 } };
const OFF = { reserve: 5000000, flows: {}, fortknox: 0 };

let base, server, owner, fan, staff;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  owner = await mkUser({ username: "pb", camfrog: "foamy1111" });
  fan = await mkUser({ username: "fan" });
  staff = await mkUser({ username: "boss", cls: "Admin" });
  await S.init();
  await rooms.init();
  await B.init();
  await CP.init();
  await RV.init();
  await rooms.addRoom(DRAMA, null, "test");
  await rooms.setOwner(PLANT, "foamy1111", "test");
  const app = express();
  app.use(express.json());
  const isBotToken = (t) => t === "bot-token";
  let who = null;
  const addUser = (req, res, next) => { req.user = who; next(); };
  app.use((req, res, next) => { const h = req.headers["x-test-user"]; who = h === "owner" ? owner : h === "fan" ? fan : h === "staff" ? staff : null; next(); });
  B.register(app, { addUser, isBotToken });
  RV.register(app, { addUser, isBotToken });
  app.get("/roomsweb-stub", (req, res) => res.end());
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server && server.close());
const post = (p, body, user) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}) }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (p, user) => fetch(base + p, { headers: user ? { "x-test-user": user } : {} }).then(async (r) => ({ status: r.status, body: await r.json() }));

test("funding.sync: room vaults are live only while Pepe reports them; any sync without it turns them off", () => {
  assert.equal(F.roomVaultsLive(), false, "never synced: not live");
  F.sync(LIVE);
  assert.equal(F.roomVaultsLive(), true);
  assert.deepEqual(F.state.room_vaults, { on: true, cap: 50000000 });
  F.sync(OFF);
  assert.equal(F.roomVaultsLive(), false, "an older Pepe / room vaults off: no key");
  F.sync({ ...OFF, room_vaults: null });
  assert.equal(F.roomVaultsLive(), false);
  F.sync({ ...OFF, room_vaults: { on: "yes" } });
  assert.equal(F.roomVaultsLive(), false, "junk is not live");
});

test("routeInTx OFF: the room half is held in the escrow exactly as before E-3", async () => {
  F.sync(OFF);
  const w0 = await wallets(), c0 = await claimsSum(), e0 = (await B.escrow()).room_vault;
  const r = await B.boost(fan, DRAMA, { amount: 10001, ref: ref() });
  assert.deepEqual([r.fortknox, r.room_vault], [5001, 5000]);
  const row = (await getQuery("SELECT rv_to, fk_to FROM room_flow_ledger ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual(row, { rv_to: null, fk_to: "fortknox" });
  const cl = await getQuery("SELECT flow, amount FROM reserve_claims ORDER BY rowid DESC LIMIT 1");
  assert.deepEqual(cl.map((x) => [x.flow, x.amount]), [["fortknox:boost", -5001]], "only the Fort Knox claim");
  assert.equal((await B.escrow()).room_vault - e0, 5000, "the room half is in the escrow");
  assert.equal(w0 - (await wallets()), -((await claimsSum()) - c0) + 5000, "site conservation: debit == claims + escrow");
});

test("routeInTx ON: the room half is a room:<flow>:<room> claim (never escrow); owner / site pad = all Fort Knox", async () => {
  F.sync(LIVE);
  const w0 = await wallets(), c0 = await claimsSum(), e0 = (await B.escrow()).room_vault;
  const r = await B.boost(fan, DRAMA, { amount: 8001, ref: ref() });
  assert.deepEqual([r.fortknox, r.room_vault], [4001, 4000]);
  const row = (await getQuery("SELECT rv_to, room_vault FROM room_flow_ledger ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual(row, { rv_to: "room", room_vault: 4000 });
  const cl = await getQuery("SELECT flow, amount FROM reserve_claims ORDER BY rowid DESC LIMIT 2");
  assert.deepEqual(cl.map((x) => [x.flow, x.amount]).sort(), [["fortknox:boost", -4001], ["room:boost:DRAMA_CENTRAL", -4000]]);
  assert.equal((await B.escrow()).room_vault, e0, "a live room half is NOT escrow");
  assert.equal(w0 - (await wallets()), -((await claimsSum()) - c0), "site conservation: every PAT is a claim Pepe credits");
  // the owner boosting their own pad: all Fort Knox (7.1)
  const o = await B.boost(owner, PLANT, { amount: 3000, ref: ref() });
  assert.deepEqual([o.fortknox, o.room_vault], [3000, 0]);
  // a pad that can't have a room vault (a site pad - pad cosmetics / challenge fees can name one): all Fort Knox
  const t = await B.tx(() => B.routeInTx({ ref: "t-" + ref(), kind: "pad_cosmetic", room_id: LOUNGE, payer_id: fan.userId, amount: 999, owner_self: false, flow: "pad_cosmetics" }));
  assert.deepEqual([t.fortknox, t.room_vault, t.rv_to], [999, 0, null]);
  const u = await B.tx(() => B.routeInTx({ ref: "t-" + ref(), kind: "challenge_fee", room_id: "Not.Registered", payer_id: null, amount: 500, owner_self: false, flow: "challenge_fee" }));
  assert.deepEqual([u.fortknox, u.room_vault], [500, 0], "an unregistered room: all Fort Knox");
  // the room claims are not the Reserve's: fundable() for a Reserve flow is unchanged by them
  assert.equal(await F.fundable("levelup"), 5000000 - 0 + (await getQuery("SELECT COALESCE(-SUM(amount),0) AS t FROM reserve_claims WHERE settled = 0 AND COALESCE(queued,0) = 0 AND flow NOT LIKE 'incentives:%' AND flow NOT LIKE 'room:%'"))[0].t,
               "room claims are excluded from the Reserve's unsettled sum");
  await runQuery("UPDATE reserve_claims SET settled = 1");
});

test("escrow migration: per-room net escrow, per-room amount check, replay-safe, bot token", async () => {
  F.sync(OFF);
  await B.boost(fan, PLANT, { amount: 40000, ref: ref() });             // 20,000 into Houseplants' escrow
  // a mic challenge prize paid out of the escrow (escrow mode, room vaults off)
  const singer = await mkUser({ username: "singer", camfrog: "singer" });
  const p = await CP.payout(PLANT, { ref: "AC1-1", userId: singer.userId, login: "singer", amount: 1000, min: 500, pct: 10, cap: 50000 });
  assert.equal(p.paid, 1000);
  assert.equal(p.vault, undefined, "an escrow prize doesn't claim the room vault");
  const s = await B.rvMigrationSummary();
  const per = Object.fromEntries(s.rooms.map((r) => [r.room_id, r.amount]));
  assert.deepEqual(per, { [DRAMA]: 5000, [PLANT]: 19000 }, "net escrow per pad; the live (rv_to) row and the challenge prize handled");
  assert.equal(s.amount, 24000);
  assert.ok(s.rooms.every((r) => r.eligible), "both pads can have a vault");
  assert.equal((await post("/api/g/roomvault-migration", { password: "nope" })).status, 403);
  const got = await post("/api/g/roomvault-migration", { password: "bot-token" });
  assert.deepEqual([got.status, got.body.amount, got.body.max_id], [200, 24000, s.max_id]);
  F.sync(OFF);
  await B.boost(fan, DRAMA, { amount: 2000, ref: ref() });              // after the summary: not in the batch
  const bad = await post("/api/g/roomvault-migration/mark", { password: "bot-token", batch: "rvm" + s.max_id, max_id: s.max_id, amount: 24000, rooms: { [DRAMA]: 4000, [PLANT]: 20000 } });
  assert.equal(bad.status, 409, "the right total but the wrong split per room: nothing stamped");
  assert.equal((await post("/api/g/roomvault-migration/mark", { password: "bot-token", batch: "x;drop", max_id: 1, amount: 1, rooms: { a: 1 } })).status, 400);
  const ok = await post("/api/g/roomvault-migration/mark", { password: "bot-token", batch: "rvm" + s.max_id, max_id: s.max_id, amount: 24000, rooms: per });
  assert.deepEqual([ok.status, ok.body.ok, ok.body.dup], [200, true, false]);
  const again = await post("/api/g/roomvault-migration/mark", { password: "bot-token", batch: "rvm" + s.max_id, max_id: s.max_id, amount: 24000, rooms: per });
  assert.deepEqual([again.body.ok, again.body.dup], [true, true], "a replay returns the first result");
  const left = await B.rvMigrationSummary();
  assert.deepEqual(left.rooms.map((r) => [r.room_id, r.amount]), [[DRAMA, 1000]], "only the boost booked after the summary is left");
  const marked = (await getQuery("SELECT COUNT(*) AS n FROM room_flow_ledger WHERE migrated_rv IS NOT NULL AND kind = 'challenge'"))[0].n;
  assert.equal(marked, 1, "the challenge payout row was stamped with its room's batch");
});

test("mic challenges: room-vault mode while live (same caps, rv_to, vault echoed); escrow mode refused while live", async () => {
  F.sync(LIVE);
  const singer = await mkUser({ username: "singer2", camfrog: "singer2" });
  const b0 = (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [singer.userId]))[0].b;
  const bud = await CP.budget(DRAMA, { vault: "room", balance: 100000, pct: 5, cap: 60000 });
  assert.deepEqual([bud.balance, bud.cap, bud.left, bud.vault], [100000, 5000, 5000, "room"], "5% of the room vault's balance");
  const e0 = (await B.escrow()).room_vault;
  const r = await CP.payout(DRAMA, { ref: "AC2-1", userId: singer.userId, login: "singer2", amount: 8000, min: 500, pct: 5, cap: 60000, vault: "room", balance: 100000 });
  assert.deepEqual([r.ok, r.paid, r.vault], [true, 5000, "room"], "capped at 5%, paid, the vault echoed");
  const row = (await getQuery("SELECT rv_to, room_vault FROM room_flow_ledger WHERE ref = 'challenge:AC2-1'"))[0];
  assert.deepEqual(row, { rv_to: "room", room_vault: -5000 });
  assert.equal((await B.escrow()).room_vault, e0, "a room-vault prize never touches the escrow");
  const d = await CP.payout(DRAMA, { ref: "AC2-1", userId: singer.userId, login: "singer2", amount: 8000, min: 500, vault: "room", balance: 100000 });
  assert.deepEqual([d.dup, d.paid, d.vault], [true, 5000, "room"], "a retry: the first result, the vault echoed");
  const capped = await CP.payout(DRAMA, { ref: "AC2-2", userId: singer.userId, login: "singer2", amount: 8000, min: 500, pct: 5, cap: 60000, vault: "room", balance: 95000 });
  assert.equal(capped.code, "cap", "the 24 h cap counts room-vault prizes too");
  const esc = await CP.payout(DRAMA, { ref: "AC2-3", userId: singer.userId, login: "singer2", amount: 1000, min: 500 });
  assert.deepEqual([esc.ok, esc.code], [false, "moved"], "an escrow prize while room vaults are live: refused, nothing paid");
  assert.equal((await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [singer.userId]))[0].b, b0 + 5000);
  F.sync(OFF);
  const v = await CP.vault(DRAMA, { pct: 5, cap: 60000 });
  assert.equal(v.vault, undefined, "off: the escrow view as before");
});

test("roomvaults: Pepe's sync, the pad card (inflow vs deposits), the owner's rate", async () => {
  const days = {};
  for (let i = 0; i < 9; i++) days[new Date(T - i * DAY).toISOString().slice(0, 10)] = { in: 1000 * (i + 1), dep: i === 0 ? 50000 : 0, mig: i === 1 ? 24000 : 0, out: 0, ovf: 0 };
  assert.equal((await post("/api/g/roomvaults/sync", { password: "nope" })).status, 403);
  const s = await post("/api/g/roomvaults/sync", { password: "bot-token", on: true, cap: 50000000, total: 123456,
    rooms: [{ id: DRAMA, balance: 123456, days, history: [{ ts: 1, kind: "deposit", flow: "deposit", amount: 50000, overflow: 0 }, { ts: 2, kind: "<script>", amount: 1 }] }] });
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.settings, {}, "no rate set yet");
  const c = await RV.card(DRAMA, fan, {});
  assert.equal(c.live, true);
  assert.equal(c.balance, 123456);
  assert.equal(c.inflow7, 1000 * (1 + 2 + 3 + 4 + 5 + 6 + 7), "7 days of inflow (Pepe's local days)");
  assert.equal(c.deposits7, 50000, "deposits are their own figure");
  assert.equal(c.migrated7, 24000, "the migration is its own figure, never inflow");
  assert.equal(c.history[1].kind, "flow", "junk history kinds are cleaned");
  assert.deepEqual([c.rate, c.rate_default, c.can_set_rate], [10, true, false]);
  // the owner sets the rate: bounds, owner only, once a week
  await rooms.setOwner(DRAMA, "foamy1111", "test");
  await assert.rejects(RV.setRate(DRAMA, fan, 12), /owner/);
  await assert.rejects(RV.setRate(DRAMA, owner, 1), /between 2% and 15%/);
  await assert.rejects(RV.setRate(DRAMA, owner, 16), /between/);
  assert.deepEqual(await RV.setRate(DRAMA, owner, 12), { rate: 12, changed: true });
  await assert.rejects(RV.setRate(DRAMA, owner, 8), /once a week/);
  T += 7 * DAY + 1;
  assert.deepEqual(await RV.setRate(DRAMA, owner, 7.5), { rate: 7.5, changed: true });
  assert.deepEqual(await RV.setRate(DRAMA, staff, 9), { rate: 9, changed: true }, "staff can change it any time");
  await assert.rejects(RV.setRate(LOUNGE, staff, 9), /Camfrog room/, "a site pad has no room vault");
  const s2 = await post("/api/g/roomvaults/sync", { password: "bot-token", on: true, rooms: [] });
  assert.equal(s2.body.settings[DRAMA].rate, 9, "the rate goes back to Pepe (stored for E-4)");
  assert.equal((await RV.card(DRAMA, fan, {})).balance, 0, "a room Pepe no longer lists is at 0");
  const log = await getQuery("SELECT rate, prev FROM room_vault_rate_log WHERE room_id = ? ORDER BY at", [DRAMA]);
  assert.deepEqual(log.map((x) => [x.prev, x.rate]), [[10, 12], [12, 7.5], [7.5, 9]], "every change is logged");
  const ov = await RV.overview(5);
  assert.equal(ov.live, true);
});
