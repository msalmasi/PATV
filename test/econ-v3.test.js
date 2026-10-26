// Economy v3 on the site (1.99jw, "the Reserve only funds the protocol"):
//   * funding-sync `monetary` (cleaned, every sync sets it), reserve-claims with userId / username / meta
//   * unsettledReserve: mints out, flash + house_adjust in; incentives flows never fall back to the Reserve
//   * House flash liquidity (wheel + blackjack): on / off, room exhausted, floor breach vs a plain shortage
//   * botcredits.js: chatwinner source + ref, the log, idempotency; jackpot-adjust; merge-balance; stale/reclaimed
//   * supplyhistory.js: today's row, month-to-date inflation, late mints patched, the admin route
//   NODE_PATH=G:/PATV/node_modules node --test test/econ-v3.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "econ-v3-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const F = require(path.join(repo, "funding"));
const BC = require(path.join(repo, "botcredits"));
const SH = require(path.join(repo, "supplyhistory"));

const bal = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;
const house = async () => (await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM jackpot_rakes"))[0].t;
const setHouse = async (amt) => {
  await runQuery("DELETE FROM jackpot_rakes");
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES ('seed', NULL, NULL, ?)", [amt]);
};
const flashClaims = () => getQuery("SELECT flow, amount, meta FROM reserve_claims WHERE flow LIKE 'flash:%' AND settled = 0 ORDER BY created, rowid");
const V2 = { wheel_shortfall: "jackpot" };
const MON = (o) => Object.assign({ flash: { house: true, bank: true, mm: true }, fedloan_room: 10000000, house_hard_floor: 5000000,
                                   donation: { rate: 500000, bonus_pct: 20 }, grant_weekly_cap: -1, week_start: 0, band: { fed: 25e6, floor: 20e6, ceiling: 30e6 } }, o);

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  await runQuery("CREATE TABLE bonus_winners (bonusId TEXT PRIMARY KEY, type TEXT, userId TEXT, transactionId TEXT, amount INTEGER)");
  for (const [id, name, b, cls] of [["u1", "ann", 1000, "pleb"], ["u2", "bob", 50, "pleb"], ["u3", "cat", 0, "pleb"], ["ua", "boss", 0, "Admin"]]) {
    await runQuery("INSERT INTO users (userId, username, password, points_balance, class) VALUES (?, ?, 'x', ?, ?)", [id, name, b, cls]);
  }
  await F.claims();
});

// ── A1 / A2 / A3 ──
test("A1: monetary is cleaned and every sync sets it (absent / garbage -> null)", () => {
  F.sync({ reserve: 1, monetary: { flash: { house: false }, fedloan_room: "123.9", house_hard_floor: 4000000, donation: { rate: 1000, bonus_pct: 12.5 },
                                   grant_weekly_cap: -7, week_start: 1760000000, band: { fed: 25000000, floor: "x", ceiling: 30000000 } } });
  const m = F.state.monetary;
  assert.deepEqual(m.flash, { house: false, bank: true, mm: true }, "missing switches default on");
  assert.equal(m.fedloan_room, 123);
  assert.equal(m.house_hard_floor, 4000000);
  assert.deepEqual(m.donation, { rate: 1000, bonus_pct: 12.5 });
  assert.equal(m.grant_weekly_cap, -1, "any negative = unlimited");
  assert.equal(m.week_start, 1760000000);
  assert.deepEqual(m.band, { fed: 25000000, floor: null, ceiling: 30000000 });
  assert.deepEqual(F.donationTerms(), { rate: 1000, bonus_pct: 12.5 });
  F.sync({ reserve: 1 });
  assert.equal(F.state.monetary, null, "a sync without it clears it");
  assert.deepEqual(F.donationTerms(), { rate: 500000, bonus_pct: 20 }, "defaults while never synced");
  for (const g of ["nope", 5, [1], null]) { F.sync({ reserve: 1, monetary: g }); assert.equal(F.state.monetary, null, String(g)); }
  F.sync({ reserve: 1, monetary: {} });
  assert.equal(F.state.monetary.house_hard_floor, 5000000);
  assert.equal(F.state.monetary.fedloan_room, 0);
});

test("A2/A3: claims carry userId, username and meta; unsettledReserve leaves mints out, counts flash + house_adjust", async () => {
  await runQuery("DELETE FROM reserve_claims");
  F.sync({ reserve: 1000000, flows: {} });
  const ins = (id, flow, uid, amt, meta) => runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount, meta) VALUES (?, ?, ?, ?, ?, ?)",
                                                     [id, flow, uid, flow, amt, meta || null]);
  await ins("c-mint", "mint:donation", "u1", 2500000, JSON.stringify({ bonus: 500000 }));
  await ins("c-flash", "flash:house:wheel", "u1", 3000);
  await ins("c-ha", "house_adjust", "ua", 2000);
  await ins("c-inc", "incentives:staff_grant", "u2", 500);
  await ins("c-gone", "levelup", "u-gone", 100);
  assert.equal(await F.unsettledReserve(), 3000 + 2000 + 100);
  assert.equal(await F.reserveAvailable(), 1000000 - 5100);
  assert.equal(await F.unsettledIncentives(), 500, "incentives:staff_grant counts against the incentive budget");
  const cs = await F.claims();
  const by = Object.fromEntries(cs.map((c) => [c.claimId, c]));
  assert.deepEqual([by["c-mint"].userId, by["c-mint"].username, JSON.parse(by["c-mint"].meta).bonus], ["u1", "ann", 500000]);
  assert.equal(by["c-gone"].username, null, "LEFT JOIN: a gone account still lists");
  assert.ok("meta" in by["c-ha"]);
  await F.settle(cs.map((c) => c.claimId));
});

// ── B3 ──
test("B3: a flow routed to incentives never falls back to the Reserve; with no budget it is refused / queued", async () => {
  F.sync({ reserve: 1e9, flows: { levelup: "incentives" } });
  assert.equal(F.vaultFor("levelup"), "incentives");
  assert.equal(await F.canFund("levelup", 1), false);
  assert.equal(await F.fundable("levelup"), 0);
  assert.equal(await F.takeFunds("levelup", 10, "u3", "x"), false, "takeFunds refuses");
  const r = await F.fundPayoutEx("u3", 25000, "levelup", "Level-up reward (Lv 2)");
  assert.deepEqual([r.ok, r.queued], [true, true]);
  assert.equal(await bal("u3"), 0);
  const q = await getQuery("SELECT flow, queued FROM reserve_claims WHERE claimId = ?", [r.claimId]);
  assert.deepEqual([q[0].flow, q[0].queued], ["incentives:levelup", 1]);
  assert.equal(await F.unsettledReserve(), 0, "nothing on the Reserve");
  // once a budget is synced the drain pays it
  F.sync({ reserve: 1e9, flows: { levelup: "incentives" },
           incentives: { balance: 100000, week: "W", remaining: { levelup: 100000 }, budgets: { levelup: 100000 }, groups: { levelup: "levelup" } } });
  await F.drainQueue();
  assert.equal(await bal("u3"), 25000);
  await F.settle((await F.claims()).map((c) => c.claimId));
  F.sync({ reserve: 1e9, flows: {} });
});

// ── B4: House flash liquidity ──
test("B4 wheel: flash OFF (monetary null or flash.house false) behaves exactly as before", async () => {
  await setHouse(3000);
  F.sync({ reserve: 1e9, flows: V2 });                       // monetary null
  let d = await F.wheelDraw(5000, "s-off1", "u1");
  assert.deepEqual([d.paid, d.refused, d.flash], [3000, 2000, 0]);
  assert.equal(await house(), 0);
  await setHouse(3000);
  F.sync({ reserve: 1e9, flows: V2, monetary: MON({ flash: { house: false } }) });
  d = await F.wheelDraw(5000, "s-off2", "u1");
  assert.deepEqual([d.paid, d.refused, d.flash], [3000, 2000, 0]);
  assert.equal((await flashClaims()).length, 0);
  // and v1 (not House-backed): no flash even when on
  await setHouse(3000);
  F.sync({ reserve: 1e9, flows: { wheel_shortfall: "reserve" }, monetary: MON() });
  d = await F.wheelDraw(5000, "s-v1", "u1");
  assert.equal(d.backstop, "reserve");
  assert.equal(d.flash, 0);
  assert.equal((await flashClaims()).length, 0);
  await F.settle((await F.claims()).map((c) => c.claimId));
});

test("B4 wheel: flash ON - a floor breach is paid in full, the gap is a flash:house:wheel claim", async () => {
  await setHouse(5_000_400);                                 // 400 above the 5M hard floor
  F.sync({ reserve: 1e9, flows: V2, monetary: MON() });
  // above the floor: the House pays it, no flash
  let d = await F.wheelDraw(300, "s-a", "u1");
  assert.deepEqual([d.paid, d.flash], [300, 0]);
  assert.equal((await flashClaims()).length, 0);
  // 100 left above the floor: a 1,000 prize -> the House pays 100, the Fed lends the 900 gap
  d = await F.wheelDraw(1000, "s-b", "u1");
  assert.deepEqual([d.paid, d.fromHouse, d.flash, d.refused], [1000, 100, 900, 0]);
  assert.equal(await house(), 5_000_400 - 300 - 1000, "the House paid the prize in full (Pepe's loan brings it back to the floor)");
  const fc = await flashClaims();
  assert.deepEqual(fc.map((c) => [c.flow, c.amount]), [["flash:house:wheel", 900]]);
  assert.equal(JSON.parse(fc[0].meta).ref, "spin:s-b");
  assert.equal(await F.unsettledFlash(), 900);
  assert.equal(await F.unsettledReserve(), 900, "a flash claim is the Reserve's");
  // already below the floor: the whole prize is the gap (never more than the payout)
  d = await F.wheelDraw(700, "s-c", "u1");
  assert.deepEqual([d.paid, d.flash], [700, 700]);
});

test("B4 wheel: the Fed loan room (net of unsettled flash claims) caps it; a plain shortage beyond the room is refused as before", async () => {
  await runQuery("DELETE FROM reserve_claims");
  await setHouse(5_000_000);
  F.sync({ reserve: 1e9, flows: V2, monetary: MON({ fedloan_room: 1000 }) });
  let d = await F.wheelDraw(600, "r-1", "u1");
  assert.equal(d.flash, 600);
  d = await F.wheelDraw(500, "r-2", "u1");                    // 1000 - 600 unsettled = 400 room < 500 gap
  assert.equal(d.flash, 0, "room exhausted: no flash");
  assert.deepEqual([d.paid, d.refused], [500, 0], "the House still holds it: paid as before (below the floor)");
  assert.equal((await flashClaims()).length, 1);
  // Pepe settles (turns it into a Fed loan; the room he syncs next is smaller) - the site's own net room frees up
  await F.settle((await F.claims()).map((c) => c.claimId));
  F.sync({ reserve: 1e9, flows: V2, monetary: MON({ fedloan_room: 400 }) });
  await setHouse(100);
  d = await F.wheelDraw(1000, "r-3", "u1");                   // gap 1000 > room 400 -> today's behaviour: pay the 100 it has
  assert.deepEqual([d.paid, d.refused, d.flash], [100, 900, 0]);
  assert.equal(await house(), 0);
});

test("B4 blackjack: houseFlashCover books the gap for the payout the caller then makes; off = nothing", async () => {
  await runQuery("DELETE FROM reserve_claims");
  await setHouse(5_000_050);
  F.sync({ reserve: 1e9, flows: V2, monetary: MON() });
  let r = await F.houseFlashCover("blackjack", 40, "u1", "blackjack payout", "bj:t1");
  assert.equal(r.used, false, "covered above the floor");
  r = await F.houseFlashCover("blackjack", 250, "u1", "blackjack payout", "bj:t2");
  assert.deepEqual([r.used, r.gap], [true, 200]);
  assert.deepEqual((await flashClaims()).map((c) => [c.flow, c.amount]), [["flash:house:blackjack", 200]]);
  F.sync({ reserve: 1e9, flows: V2 });
  r = await F.houseFlashCover("blackjack", 1e9, "u1", "blackjack payout", "bj:t3");
  assert.equal(r.used, false, "monetary null: off");
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  const bj = src.slice(src.indexOf('app.post("/api/blackjack/result"'));
  assert.match(bj.slice(0, 2500), /funding\.houseFlashCover\("blackjack", Number\(payout\)/, "the blackjack result books flash before the House debit");
  await F.settle((await F.claims()).map((c) => c.claimId));
});

// ── A7: chatwinner ──
const log = (ref) => getQuery("SELECT * FROM bot_credit_log WHERE ref = ?", [ref]).then((r) => r[0]);
test("A7: a positive non-platform credit without source + ref is refused (unsourced) and logged; nothing moves", async () => {
  const b0 = await bal("u2");
  for (const body of [{ userId: "u2", type: "bonus", amount: 100 }, { userId: "u2", type: "bonus", amount: 100, source: "vault:casino" },
                      { userId: "u2", type: "bonus", amount: 100, ref: "r-x" }]) {
    const r = await BC.chatwinner(body);
    assert.equal(r.status, 400);
    assert.deepEqual(r.json, { success: false, error: "unsourced" });
  }
  assert.equal(await bal("u2"), b0);
  const n = (await getQuery("SELECT COUNT(*) AS n FROM bot_credit_log WHERE outcome = 'unsourced' AND endpoint = 'chatwinner'"))[0].n;
  assert.equal(n, 3, "every refusal is logged");
  assert.equal((await BC.chatwinner({ userId: "u2", type: "bonus", amount: 1, source: "x".repeat(65), ref: "r" })).status, 400, "source too long");
});

test("A7: a sourced credit moves once per ref (a repeat is a duplicate), logged with its source", async () => {
  const b0 = await bal("u2");
  const body = { userId: "u2", type: "heist-win", amount: 700, source: "vault:fortknox", ref: "heist:42:u2" };
  const r = await BC.chatwinner(body);
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(await bal("u2"), b0 + 700);
  const row = await log("heist:42:u2");
  assert.deepEqual([row.endpoint, row.userId, row.type, row.amount, row.source, row.outcome], ["chatwinner", "u2", "heist-win", 700, "vault:fortknox", "ok"]);
  const again = await BC.chatwinner(body);
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicate, true);
  assert.equal(await bal("u2"), b0 + 700, "credited once");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM bonus_winners WHERE userId = 'u2' AND type = 'heist-win'"))[0].n, 1);
});

test("A7: debits need no source (only what the balance covers) and are logged; a failed ref may be retried", async () => {
  const b0 = await bal("u2");
  const no = await BC.chatwinner({ userId: "u2", type: "fine", amount: -(b0 + 1), ref: "fine:1" });
  assert.equal(no.status, 402);
  assert.equal((await log("fine:1")).outcome, "insufficient");
  assert.equal(await bal("u2"), b0);
  const ok = await BC.chatwinner({ userId: "u2", type: "fine", amount: -10, ref: "fine:1" });
  assert.equal(ok.status, 200, "the same ref after a refusal runs");
  assert.equal(await bal("u2"), b0 - 10);
  assert.equal((await log("fine:1")).outcome, "ok");
  const auto = await BC.chatwinner({ userId: "u2", type: "fine", amount: -5 });
  assert.equal(auto.status, 200);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM bot_credit_log WHERE ref LIKE 'auto:chatwinner:%' AND outcome = 'ok'"))[0].n, 1, "a made-up ref when none was sent");
  assert.equal((await BC.chatwinner({ userId: "nobody", type: "fine", amount: -5 })).status, 404);
});

test("A7: discord-/twitch- credits keep the platform_rewards funded path (no source needed), refused when unfunded", async () => {
  // 1.99afh: the incentive budget only - never the Reserve (owner, 2026-10-26); test/twitchcp.test.js has the rest
  const INC = { balance: 100000, week: "W", remaining: { misc: 100000 }, budgets: { misc: 100000 }, groups: { platform_rewards: "misc" } };
  F.sync({ reserve: 0, flows: { platform_rewards: "incentives" } });
  const b0 = await bal("u3");
  const no = await BC.chatwinner({ userId: "u3", type: "discord-raffle", amount: 500, ref: "d:1" });
  assert.equal(no.status, 409);
  assert.equal((await log("d:1")).outcome, "unfunded");
  delete F.state.flows.platform_rewards;   // a site no sync has routed it on yet (a sync only adds / changes rows)
  F.sync({ reserve: 10000, flows: {} });
  const nr = await BC.chatwinner({ userId: "u3", type: "twitch-raffle", amount: 500, ref: "t:0" });
  assert.deepEqual([nr.status, nr.json.error], [409, "no_route"], "not routed yet: never the Reserve's default");
  assert.equal((await log("t:0")).outcome, "no_route");
  F.sync({ reserve: 10000, flows: { platform_rewards: "incentives" }, incentives: INC });
  const ok = await BC.chatwinner({ userId: "u3", type: "twitch-raffle", amount: 500 });
  assert.equal(ok.status, 200);
  assert.equal(await bal("u3"), b0 + 500);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM reserve_claims WHERE flow = 'incentives:platform_rewards' AND settled = 0"))[0].n, 1);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM reserve_claims WHERE flow = 'platform_rewards'"))[0].n, 0, "nothing on the Reserve");
  await F.settle((await F.claims()).map((c) => c.claimId));
  delete F.state.flows.platform_rewards;
  F.sync({ reserve: 10000, flows: {} });
});

// ── A8: jackpot-adjust ──
test("A8: jackpot-adjust needs source + ref, is logged, and a repeated ref inserts nothing", async () => {
  await setHouse(1000);
  assert.equal((await BC.jackpotAdjust({ amount: 50 })).status, 400);
  assert.equal((await BC.jackpotAdjust({ amount: 50, source: "heist" })).status, 400);
  assert.equal((await BC.jackpotAdjust({ amount: 50, ref: "h1" })).status, 400);
  assert.equal((await BC.jackpotAdjust({ amount: "x", source: "heist", ref: "h1" })).status, 400);
  assert.equal(await house(), 1000);
  const r = await BC.jackpotAdjust({ amount: -300, userId: "u1", source: "heist:payout", ref: "h1" });
  assert.deepEqual(r.json, { success: true, jackpotTotal: 700 });
  const again = await BC.jackpotAdjust({ amount: -300, userId: "u1", source: "heist:payout", ref: "h1" });
  assert.deepEqual(again.json, { success: true, jackpotTotal: 700, duplicate: true });
  assert.equal(await house(), 700);
  const row = await log("h1");
  assert.deepEqual([row.endpoint, row.amount, row.source, row.outcome], ["jackpot-adjust", -300, "heist:payout", "ok"]);
  assert.match((await getQuery("SELECT spinId FROM jackpot_rakes WHERE amount = -300"))[0].spinId, /^bot:/);
});

// ── A6: merge-balance ──
test("A6: merge-balance moves the WHOLE balance atomically, two 'account merge' rows, idempotent per ref", async () => {
  await runQuery("UPDATE users SET points_balance = 1234.5 WHERE userId = 'u1'");
  const to0 = await bal("u3");
  assert.equal((await BC.mergeBalance({ fromUserId: "u1", toUserId: "u1", ref: "m1" })).status, 400);
  assert.equal((await BC.mergeBalance({ fromUserId: "u1", toUserId: "u3" })).status, 400, "ref required");
  assert.equal((await BC.mergeBalance({ fromUserId: "nope", toUserId: "u3", ref: "m0" })).status, 404);
  assert.equal((await BC.mergeBalance({ fromUserId: "u1", toUserId: "nope", ref: "m0" })).status, 404);
  const r = await BC.mergeBalance({ fromUserId: "u1", toUserId: "u3", ref: "m1" });
  assert.deepEqual(r.json, { ok: true, moved: 1234.5 });
  assert.equal(await bal("u1"), 0);
  assert.equal(await bal("u3"), to0 + 1234.5);
  const rows = await getQuery("SELECT userId, points, counterparty FROM transactions WHERE type = 'account merge' ORDER BY points");
  assert.deepEqual(rows.map((x) => [x.userId, x.points, x.counterparty]), [["u1", -1234.5, "u3"], ["u3", 1234.5, "u1"]]);
  await runQuery("UPDATE users SET points_balance = 99 WHERE userId = 'u1'");
  const again = await BC.mergeBalance({ fromUserId: "u1", toUserId: "u3", ref: "m1" });
  assert.deepEqual(again.json, { ok: true, moved: 1234.5, duplicate: true });
  assert.equal(await bal("u1"), 99, "a repeat moves nothing");
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  assert.doesNotMatch(src, /app\.post\("\/api\/users\/zero-balance"/, "zero-balance is gone");
  assert.doesNotMatch(src, /app\.post\("\/api\/bonus\/winner"/, "the dead bonus/winner route is gone");
});

// ── A5: stale/reclaimed ──
test("A5: stale/reclaimed sums the account's stale_reclaim / stale_restore claims; 404 for an unknown user", async () => {
  const ins = (id, flow, amt) => runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount, settled) VALUES (?, ?, 'u2', 'x', ?, 1)", [id, flow, amt]);
  await ins("s1", "stale_reclaim", -800); await ins("s2", "stale_reclaim", -200); await ins("s3", "stale_restore", 300);
  for (const who of ["bob", "BOB", "u2"]) assert.deepEqual((await BC.staleReclaimed(who)).json, { ok: true, userId: "u2", username: "bob", reclaimed: 1000, restored: 300 });
  assert.deepEqual((await BC.staleReclaimed("cat")).json, { ok: true, userId: "u3", username: "cat", reclaimed: 0, restored: 0 });
  assert.deepEqual(await BC.staleReclaimed("ghost"), { status: 404, json: { ok: false } });
});

test("routes: bot token required; stale/reclaimed is a POST", async () => {
  const app = express();
  app.use(express.json());
  BC.register(app, { isBotToken: (t) => t === "bot", idemBegin: null, resolveCounterparty: async () => null });
  const server = app.listen(0);
  const base = "http://127.0.0.1:" + server.address().port;
  const post = (url, body) => fetch(base + url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    for (const u of ["/api/bonus/chatwinner", "/api/g/heist/jackpot-adjust", "/api/users/merge-balance", "/api/g/stale/reclaimed"]) {
      assert.equal((await post(u, { password: "nope" })).status, 403, u);
    }
    const r = await post("/api/g/stale/reclaimed", { password: "bot", user: "bob" });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).reclaimed, 1000);
    assert.equal((await post("/api/g/stale/reclaimed", { password: "bot", user: "ghost" })).status, 404);
    assert.equal((await fetch(base + "/api/g/stale/reclaimed?password=bot&user=bob")).status, 404, "no GET variant");
    const c = await post("/api/bonus/chatwinner", { password: "bot", userId: "u2", type: "bonus", amount: 5 });
    assert.equal(c.status, 400);
    assert.equal((await c.json()).error, "unsourced");
  } finally { server.close(); }
});

// ── B6: supply history ──
test("B6: today's row from the supply + Pepe's mints, month-to-date inflation, late mints patched, admin-only route", async () => {
  let t = Date.UTC(2026, 9, 1, 12);
  SH._setClock(() => t);
  const sup = (total, fed) => ({ total, circulating: total - 10, rows: [{ key: "vault:reserve", amount: fed }],
                                 layers: [{ key: "fed", amount: fed }, { key: "players", amount: total - fed }] });
  const mon = (mints) => SH.cleanMonetary({ band: { fed: 25e6, floor: 20e6, ceiling: 30e6, action: "hold" }, mints,
                                             mtd: { issuance: { minted: 3000, cap: 100000 }, admin: { minted: 0, cap: -1 } }, month: "2026-10" });
  let r = await SH.record(sup(1000000, 25000000), mon({ "2026-10-01": { issuance: 1000 } }));
  assert.equal(r.mtd_inflation_pct, 0, "the month's first row");
  t = Date.UTC(2026, 9, 2, 9);
  await runQuery("CREATE TABLE IF NOT EXISTS pat_burns (key TEXT PRIMARY KEY, id TEXT, at INTEGER NOT NULL, source TEXT NOT NULL, amount INTEGER NOT NULL, reason TEXT, actor_kind TEXT, actor TEXT, recorded_at INTEGER)");
  await runQuery("INSERT INTO pat_burns (key, at, source, amount) VALUES ('b-1', ?, 'burn', 400), ('b-0', ?, 'burn', 99)", [Date.UTC(2026, 9, 2, 1), Date.UTC(2026, 9, 1, 23)]);
  r = await SH.record(sup(1010000, 24000000), mon({ "2026-10-01": { issuance: 1000, donation: 2500 }, "2026-10-02": { loan: 500 } }));
  assert.equal(r.mtd_inflation_pct, 1, "+1% on the 1st's total");
  assert.equal(r.burns, 400, "burns of this UTC day only");
  // a push without monetary keeps today's mints / band
  r = await SH.record(sup(1020000, 24000000), null);
  const rows = await SH.history(30);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].mints, { issuance: 1000, donation: 2500 }, "yesterday's mints patched from the map");
  assert.deepEqual(rows[1].mints, { loan: 500 });
  assert.deepEqual(rows[1].band, { fed: 25e6, floor: 20e6, ceiling: 30e6, action: "hold" });
  assert.equal(rows[1].total, 1020000);
  assert.equal(rows[1].fed, 24000000);
  assert.deepEqual(rows[1].layers, { fed: 24000000, players: 1020000 - 24000000 });
  assert.equal(rows[1].mtd_inflation_pct, 2);
  assert.deepEqual(SH.state.monetary.mtd.admin, { minted: 0, cap: -1 });
  // a new month starts over
  t = Date.UTC(2026, 10, 1, 0, 5);
  r = await SH.record(sup(2000000, 1), null);
  assert.equal(r.mtd_inflation_pct, 0);
  // the admin route
  const app = express();
  const who = { a: { userId: "ua", class: "Admin" }, p: { userId: "u2", class: "pleb" } };
  SH.register(app, { addUser: (req, res, next) => { req.user = who[req.get("x-u")] || null; next(); } });
  const server = app.listen(0);
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    assert.equal((await fetch(base + "/api/admin/econ/supply-history", { headers: { "x-u": "p" } })).status, 403);
    assert.equal((await fetch(base + "/api/admin/econ/supply-history")).status, 401);
    const j = await (await fetch(base + "/api/admin/econ/supply-history?days=90", { headers: { "x-u": "a" } })).json();
    assert.equal(j.ok, true);
    assert.equal(j.rows.length, 3);
    assert.equal(j.monetary.month, "2026-10");
  } finally { server.close(); SH._setClock(null); }
  const idx = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  assert.match(idx, /SH\.record\(await patSupply\(\), SH\.cleanMonetary\(req\.body\.monetary\)\)/, "the supply POST writes the history");
  const v = fs.readFileSync(path.join(repo, "views/admin/economy.ejs"), "utf8");
  assert.match(v, /id="supply-history"/);
  assert.match(v, /admin-supply\.js/);
});
