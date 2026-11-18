// The incentive week as a site service (policy/budget.js), with the site as its owner: POST /spend and /spend-status (one keyed transaction:
// budget check, debit, destination, the row), terminal refusals, what records nothing (not the owner, paused, cut-over, pools not live, a bad
// request), the House's Fed cover, the Fed guard, pacing, the week rolling by the clock, and website claims settled in their payout's transaction.
//   NODE_PATH=G:/PATV/node_modules node --test test/policy-budget.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const H = require("./fixtures/budget-harness");

H.setProcess("policy-budget-test");
const repo = path.resolve(__dirname, "..");
const { M, T0, WEEK, WEEK_START } = H;
let X, B, server, base;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot" }, body)) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const spend = (over) => post("/api/policy/bot/spend", H.spendBody(over));
const count = async (t, where = "1=1") => (await X.getQuery(`SELECT COUNT(*) AS n FROM ${t} WHERE ${where}`))[0].n;
const bal = async (id) => (await X.getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;
const inc = () => X.P.balance("incentives");
const house = () => X.FUND.jackpotPot();
let keyN = 0;
const alerts = [];
const k = (p = "beg") => `${p}:t${++keyN}xx`;

test.before(async () => {
  X = await H.boot(repo);
  B = X.R("policy", "budget");
  X.R("opsalerts").alert = async (a) => { alerts.push(a); return { admins: 0 }; };
  const express = require("express");
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  B.register(app, { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  await B.init();
  await X.owner("site");
});
test.after(() => server && server.close());
test.beforeEach(() => X.setNow(T0));

test("a keyed spend pays once: pool debit, wallet credit, the row, bonus and credit log; the same key answers the first result", async () => {
  const i0 = await inc(), w0 = await bal("u1");
  const key = k();
  const r = await spend({ key });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.state, "paid");
  assert.equal(r.body.group, "roomgames");
  assert.equal(r.body.week, WEEK);
  assert.equal(r.body.vault, "incentives");
  assert.equal(r.body.balance, i0 - 2000);
  assert.equal(r.body.spent, 2000);
  assert.equal(await inc(), i0 - 2000);
  assert.equal(await bal("u1"), w0 + 2000);
  assert.equal(await count("incentive_spends", `key='${key}' AND status='paid' AND grp='roomgames'`), 1);
  assert.equal(await count("pool_moves", `key='spend:${key}' AND kind='fund'`), 1);
  assert.equal(await count("bonus_winners", "type='beg'"), 1);
  assert.equal(await count("bot_credit_log", `ref='${key}' AND endpoint='spend' AND outcome='ok'`), 1);
  const again = await spend({ key });
  assert.equal(again.status, 200);
  assert.equal(again.body.dup, true);
  assert.equal(again.body.transaction, undefined);
  assert.equal(again.body.dest.transactionId, r.body.dest.transactionId);
  assert.equal(await inc(), i0 - 2000, "no second debit");
  assert.equal(await bal("u1"), w0 + 2000, "no second credit");
  const st = await post("/api/policy/bot/spend-status", { key });
  assert.equal(st.body.state, "paid");
  assert.equal(st.body.result.amount, 2000);
  assert.equal(st.body.owner, "site");
});

test("the same key with a different spend is a conflict: nothing moves, nothing changes", async () => {
  const key = k();
  await spend({ key });
  const i = await inc();
  const r = await spend({ key, amount: 2001 });
  assert.equal(r.status, 409);
  assert.equal(r.body.state, "conflict");
  assert.equal(r.body.terminal, false);
  const other = await spend({ key, dest: { kind: "user", userId: "u2", type: "beg" } });
  assert.equal(other.body.state, "conflict");
  assert.equal(await inc(), i);
});

test("over the group's budget: a terminal refusal recorded under the key; unknown before, refused after; a new key can pay", async () => {
  const key = k();
  assert.equal((await post("/api/policy/bot/spend-status", { key })).body.state, "unknown");
  const i0 = await inc();
  const r = await spend({ key, amount: 3 * M });                       // day 3 of a paced 3.5M week allows 1.5M
  assert.equal(r.status, 409);
  assert.equal(r.body.state, "refused");
  assert.equal(r.body.terminal, true);
  assert.equal(r.body.code, "E_OVER_BUDGET");
  assert.ok(r.body.left < 1500000);
  assert.equal(await inc(), i0);
  assert.equal(await count("pool_moves", `key='spend:${key}'`), 0);
  const again = await spend({ key, amount: 3 * M });
  assert.equal(again.body.dup, true);
  assert.equal(again.body.code, "E_OVER_BUDGET");
  const st = await post("/api/policy/bot/spend-status", { keys: [key, "beg:never-seen"] });
  assert.equal(st.body.items[key].state, "refused");
  assert.equal(st.body.items["beg:never-seen"].state, "unknown");
  assert.equal((await spend({ key: k(), amount: 1000 })).body.state, "paid");
});

test("pacing: day 1 allows a seventh, day 7 the whole budget; a -1 budget is limited only by the pool", async () => {
  await X.db.tx(async () => { await X.runQuery("DELETE FROM incentive_spends"); });
  X.setNow(WEEK_START + 3600e3);
  assert.equal(await B.remaining("roomgames"), 500000);
  assert.equal((await spend({ key: k(), amount: 500001 })).body.code, "E_OVER_BUDGET");
  X.setNow(WEEK_START + 6.5 * 86400e3);
  assert.equal(await B.remaining("roomgames"), 3500000);
  assert.equal(await B.remaining("levelup"), await inc(), "-1: the pool's balance");
  assert.equal(await B.remaining("activity", { at: WEEK_START + 86400e3 }), 200000, "a chosen moment, in milliseconds; activity's budget is paced too");
  const w = await B.weekOf(T0);
  assert.deepEqual(w, { start: WEEK_START, end: WEEK_START + 7 * 86400e3 });
});

test("the week rolls by the clock with no epoch: the new week opens at its first spend and starts empty", async () => {
  const key1 = k();
  await spend({ key: key1, amount: 1000 });
  const old = (await X.getQuery("SELECT eid FROM incentive_spends WHERE key = ?", [key1]))[0].eid;
  assert.equal(old, WEEK);
  X.setNow(WEEK_START + 7 * 86400e3 + 5000);                           // Monday 04:00:05, nothing ran
  assert.equal(await count("policy_runs"), 0);
  const r = await spend({ key: k(), amount: 1000 });
  assert.equal(r.body.state, "paid");
  assert.equal(r.body.week, "W2026-11-23");
  assert.equal(r.body.spent, 1000);
  assert.equal(await count("incentive_weeks", "eid='W2026-11-23'"), 1);
  const v = (await post("/api/policy/bot/week", {})).body;
  assert.equal(v.owner, "site");
  assert.equal(v.week.id, "W2026-11-23");
  assert.equal(v.week.spent.roomgames, 1000);
  assert.ok(v.weeks.some((w) => w.id === WEEK));
});

test("nothing recorded: not the owner, cutting, paused (503), a bad request, pools not live; a recorded key still answers", async () => {
  const done = k();
  await spend({ key: done, amount: 1000 });
  const before = [await count("incentive_spends"), await count("pool_moves"), await count("transactions"), await inc()];
  const same = async () => assert.deepEqual([await count("incentive_spends"), await count("pool_moves"), await count("transactions"), await inc()], before);
  await X.owner("pepe");
  let r = await spend({ key: k() });
  assert.equal(r.status, 409); assert.equal(r.body.state, "not_owner"); assert.equal(r.body.terminal, false);
  assert.equal((await post("/api/policy/bot/spend", { key: k(), void: true, reason: "ttl" })).body.state, "not_owner", "nothing can exist to void");
  assert.equal((await spend({ key: done, amount: 1000 })).body.dup, true, "a recorded key answers first");
  await X.owner("cutting");
  r = await spend({ key: k() });
  assert.equal(r.status, 423); assert.equal(r.body.state, "cutting");
  await X.owner("site", 1);
  r = await spend({ key: k() });
  assert.equal(r.status, 503); assert.equal(r.body.state, "paused"); assert.ok(r.body.retry_after_s > 0);
  await same();
  await X.owner("site");
  for (const bad of [{ key: "x" }, { flow: "not_a_flow" }, { amount: 0 }, { amount: 1.5 }, { dest: { kind: "user", userId: "u1" } }, { dest: { kind: "pad", id: "room-1" } }, { keep: -1 }]) {
    r = await spend(Object.assign({ key: k() }, bad));
    assert.equal(r.status, 400, JSON.stringify(bad)); assert.equal(r.body.state, "invalid");
  }
  await X.P._setMeta("live", false); X.P._forgetLive();
  r = await spend({ key: k() });
  assert.equal(r.status, 503); assert.equal(r.body.state, "offline");
  await X.P._setMeta("live", true); X.P._forgetLive();
  await same();
  assert.equal((await post("/api/policy/bot/spend", { password: "nope", key: k() })).status, 403);
});

test("void: an unrecorded key is refused for good (a late arrival can't pay); a recorded one keeps its answer", async () => {
  const key = k();
  let r = await post("/api/policy/bot/spend", { key, void: true, reason: "ttl", flow: "beg" });
  assert.equal(r.body.code, "E_EXPIRED");
  const i = await inc();
  r = await spend({ key });
  assert.equal(r.body.code, "E_EXPIRED"); assert.equal(r.body.dup, true);
  assert.equal(await inc(), i);
  await new Promise((res) => setImmediate(res));
  assert.ok(alerts.some((a) => a.ref === `budget-expired:${key}`), "the owners are told about an expired spend");
  const gone = k();
  assert.equal((await post("/api/policy/bot/spend", { key: gone, void: true, reason: "gave_up" })).body.code, "E_VOIDED");
  const paid = k();
  await spend({ key: paid, amount: 500 });
  r = await post("/api/policy/bot/spend", { key: paid, void: true, reason: "gave_up" });
  assert.equal(r.body.state, "paid");
});

test("the Fed guard, the routing table, keep, an unknown account, a merged one, the destination's failure rolling the debit back", async () => {
  await X.R("econstore").putSettings({ pat_routes: { raffle: [["reserve", 100]], pictionary: [["fortknox", 100]] } });
  let r = await spend({ key: k("raffle"), flow: "raffle", dest: { kind: "user", userId: "u1", type: "camfrog-raffle" } });
  assert.equal(r.body.code, "E_FED_GUARD");
  const fk = await X.P.balance("fortknox");
  r = await spend({ key: k("pict"), flow: "pictionary", dest: { kind: "user", userId: "u1", type: "pictionary-win" } });
  assert.equal(r.body.state, "paid"); assert.equal(r.body.vault, "fortknox"); assert.equal(r.body.group, null, "only incentive-paid spends count against a group");
  assert.equal(await X.P.balance("fortknox"), fk - 2000);
  await X.R("econstore").putSettings({ pat_routes: {} });
  const i = await inc();
  r = await spend({ key: k(), amount: 100, keep: i });
  assert.equal(r.body.code, "E_INSUFFICIENT", "keep: the pool must stay at or above it");
  r = await spend({ key: k(), dest: { kind: "user", userId: "ghost", type: "beg" } });
  assert.equal(r.body.code, "E_NO_ACCOUNT");
  assert.equal(await inc(), i, "the debit went with the failed destination");
  assert.equal(await count("pool_moves", `key='spend:${r.body.key}'`), 0);
  await X.R("ledger").recordMerge("u-old", "u3", "test merge");
  const w = await bal("u3");
  r = await spend({ key: k(), dest: { kind: "user", userId: "u-old", type: "beg" } });
  assert.equal(r.body.state, "paid"); assert.equal(r.body.dest.userId, "u3");
  assert.equal(await bal("u3"), w + 2000);
});

test("an auto account's reward is held: the answer says so and the destination is the escrow", async () => {
  const AE = X.R("autoescrow");
  const real = AE.credit;
  AE.credit = async (u, a, t, o) => ({ ok: true, userId: u, transactionId: o.transactionId, escrowed: true, expires_at: 1800000000000 });
  try {
    const r = await spend({ key: k(), amount: 300 });
    assert.equal(r.body.dest.escrowed, true); assert.equal(r.body.dest.expires_at, 1800000000000);
  } finally { AE.credit = real; }
});

test("pad and launchpad destinations: pool to pool in one move, the cap's excess to Fort Knox; a flow without a routing row still pays from incentives", async () => {
  await X.P._inTx.seen("x").catch(() => {});
  await X.tx(() => X.P._inTx.applyLegs("seed-pad-1", [{ pool: "room:pad-1", amount: 50 * M - 1000 }], { kind: "move" }));
  const i = await inc(), fk = await X.P.balance("fortknox");
  const r = await spend({ key: "rctopa-2026-11-18-pad-1", flow: "activity_rewards", amount: 5000, dest: { kind: "pad", id: "pad-1", tag: "activity_topup" } });
  assert.equal(r.body.state, "paid", JSON.stringify(r.body));
  assert.equal(r.body.vault, "incentives"); assert.equal(r.body.group, "activity");
  assert.equal(r.body.dest.room_in, 1000); assert.equal(r.body.dest.overflow, 4000);
  assert.equal(await inc(), i - 5000); assert.equal(await X.P.balance("fortknox"), fk + 4000); assert.equal(await X.P.balance("room:pad-1"), 50 * M);
  const lp = await spend({ key: "lp-grant-pad-2-1:a0", flow: "launchpad_grant", amount: 40000, keep: 100000, dest: { kind: "launchpad", id: "pad-2", tag: "launchpad grant" } });
  assert.equal(lp.body.state, "paid"); assert.equal(lp.body.group, "launchpad");
  assert.equal(await X.P.balance("room:pad-2"), 40000);
  assert.equal((await spend({ key: "lp-grant-pad-2-2:a0", flow: "launchpad_grant", amount: 40000, keep: 50 * M, dest: { kind: "launchpad", id: "pad-2" } })).body.code, "E_INSUFFICIENT");
  const tip = await spend({ key: "turf-tip:2026-11-18", flow: "turf_income", amount: 700, dest: { kind: "none", tag: "turf tips" } });
  assert.equal(tip.body.state, "paid"); assert.equal(tip.body.group, "turf");
});

test("the House: a payout that would take it under its floor gets the Fed's flash loan IN the transaction; a later refusal takes the loan back", async () => {
  await X.ES.putSettings({ pat_routes: { store_heist: [["jackpot", 100]] } });
  await X.runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, amount) VALUES ('drain', 't', ?)", [-(await house()) + 5 * M + 100]);
  assert.equal(await house(), 5 * M + 100);
  const d = { kind: "user", userId: "u2", type: "store-heist" };
  const fed0 = await X.P.balance("reserve");
  const r = await spend({ key: "sheist:9:u2:1", flow: "store_heist", amount: 1000, dest: d });
  assert.equal(r.body.state, "paid", JSON.stringify(r.body));
  assert.equal(r.body.vault, "jackpot");
  assert.equal(r.body.flash.gap, 900);
  assert.equal(await X.P.balance("reserve"), fed0 - 900);
  assert.equal(await house(), 5 * M + 100 + 900 - 1000, "floor kept: loan in, payout out");
  assert.equal(await count("jackpot_rakes", "jackpotId='spend:sheist:9:u2:1' AND spinId='fund:store_heist' AND amount=-1000"), 1);
  assert.equal(await count("reserve_claims", "flow LIKE 'flash:%'"), 0, "no claim for Pepe");
  // a refused destination rolls the loan back with the payout
  const f1 = await X.P.balance("reserve"), h1 = await house(), loans = await count("fed_records", "kind='loan'");
  const no = await spend({ key: "sheist:9:ghost:1", flow: "store_heist", amount: 1000, dest: { kind: "user", userId: "ghost", type: "store-heist" } });
  assert.equal(no.body.code, "E_NO_ACCOUNT");
  assert.deepEqual([await X.P.balance("reserve"), await house(), await count("fed_records", "kind='loan'")], [f1, h1, loans]);
  await X.ES.putSettings({ pat_routes: {} });
});

test("a claim pays and debits atomically: credit, pool debit, group count, settled row - and nothing is left for Pepe", async () => {
  X.FUND.sync(H.syncBody());
  await X.FUND.budgetAfterSync();
  const i = await inc(), w = await bal("u1");
  const r = await X.FUND.fundPayoutEx("u1", 25000, "levelup", "level up");
  assert.deepEqual([r.ok, r.queued], [true, false]);
  assert.equal(await bal("u1"), w + 25000); assert.equal(await inc(), i - 25000);
  const c = (await X.getQuery("SELECT claimId, settled FROM reserve_claims WHERE claimId = ?", [r.claimId]))[0];
  assert.equal(c.settled, 1);
  assert.equal(await count("pool_moves", `key='claim:${r.claimId}'`), 1);
  assert.equal((await X.getQuery("SELECT grp, eid, source FROM incentive_settled WHERE claim_id = ?", [r.claimId]))[0].grp, "levelup");
  assert.equal((await X.FUND.claims()).filter((x) => String(x.flow).startsWith("incentives:")).length, 0);
});

test("a pool refusal rolls the credit back: the grant waits in the queue, unpaid", async () => {
  const w = await bal("u2");
  const take = X.P._inTx.applyLegs;
  // the pool is emptied between the pre-check and the debit
  const P = X.P._inTx;
  P.applyLegs = async (k2, legs, o) => { if (String(k2).startsWith("claim:")) throw new X.P.Refuse(409, "short", "E_INSUFFICIENT", { pool: "incentives", balance: 0 }); return take(k2, legs, o); };
  try {
    const r = await X.FUND.fundPayoutEx("u2", 30000, "levelup", "level up");
    assert.deepEqual([r.ok, r.queued], [true, true]);
  } finally { P.applyLegs = take; }
  assert.equal(await bal("u2"), w, "the credit went with the refused debit");
  assert.equal(await count("reserve_claims", "queued=1 AND amount=30000"), 1);
  await X.FUND.drainQueue();
  assert.equal(await bal("u2"), w + 30000, "the queue pays it, debited in the same transaction");
  assert.equal(await count("reserve_claims", "amount=30000 AND queued=0 AND settled=1"), 1);
});

test("take with a real undo; staff grant and its clawback through the settled path", async () => {
  X.FUND.sync(H.syncBody());
  await X.FUND.budgetAfterSync();
  const i = await inc();
  const misc0 = await B.remaining("misc");
  const t = await X.FUND.takeFundsRef("redeem_codes", 5000, "u1", "code");
  assert.equal(t.ok, true);
  assert.equal(await inc(), i - 5000);
  assert.equal(await B.remaining("misc"), misc0 - 5000);
  await t.undo();
  await t.undo();
  assert.equal(await inc(), i, "the debit is reversed, once");
  assert.equal(await B.remaining("misc"), misc0, "the group gets it back");
  assert.equal(await count("reserve_claims", `claimId='${t.claimId}'`), 0);
  const g = await X.FUND.takeIncentivesRef("staff_grant", 7000, "u1", "staff");
  assert.equal(g.ok, true); assert.equal(await inc(), i - 7000);
  const back = await X.FUND.takeIncentivesRef("staff_grant", -7000, "u1", "clawback");
  assert.equal(back.ok, true); assert.equal(await inc(), i);
  assert.equal((await X.getQuery("SELECT COUNT(*) AS n FROM incentive_settled WHERE claim_id IN (?, ?) AND grp IS NULL", [g.claimId, back.claimId]))[0].n, 2);
  await back.undo();
  assert.equal(await inc(), i - 7000, "a clawback's undo takes it back out");
  await g.undo();
  assert.equal(await inc(), i);
});

test("a credit that fails: fundPayoutEx takes nothing, the staff grant's undo gives everything back; while paused grants wait and clawbacks still land", async () => {
  X.FUND.sync(H.syncBody());
  await X.FUND.budgetAfterSync();
  const AE = X.R("autoescrow"), L = X.R("ledger"), real = AE.credit, realPost = L.post;
  const i = await inc(), claims = await count("reserve_claims");
  AE.credit = async () => ({ ok: false, code: "E_TARGET_NOT_FOUND" });
  try {
    const r = await X.FUND.fundPayoutEx("u1", 4000, "achievements", "badge");
    assert.deepEqual([r.ok, r.queued], [false, false]);
  } finally { AE.credit = real; }
  assert.equal(await inc(), i); assert.equal(await count("reserve_claims"), claims);
  L.post = async () => ({ ok: false, code: "E_TARGET_NOT_FOUND" });
  try {
    const t = await X.FUND.takeIncentivesRef("staff_grant", 6000, "u1", "staff transfer");
    assert.equal((await L.post("u1", 6000, "x")).ok, false);
    await t.undo();
  } finally { L.post = realPost; }
  assert.equal(await inc(), i, "the undo reversed the debit");
  await X.owner("site", 1);
  const w = await bal("u1");
  const q = await X.FUND.fundPayoutEx("u1", 4000, "achievements", "badge");
  assert.deepEqual([q.ok, q.queued], [true, true], "paused: it waits");
  assert.equal(await bal("u1"), w);
  const cb = await X.FUND.takeIncentivesRef("staff_grant", -500, "u1", "clawback");
  assert.equal(cb.ok, true); assert.equal(await inc(), i + 500, "a clawback still lands in the pool");
  await X.owner("site");
  await cb.undo();
  await X.FUND.drainQueue();
  assert.equal(await bal("u1"), w + 4000);
});

test("claims booked before the hand-over settle once on the site; a flash claim becomes the Fed's loan", async () => {
  await X.runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount) VALUES ('legacy-1', 'incentives:achievements', 'u1', 'x', 1200), ('legacy-2', 'flash:house:wheel', 'u1', 'x', 800)");
  const i = await inc(), f = await X.P.balance("reserve");
  assert.deepEqual((await X.FUND.claims()).filter((c) => /^legacy-/.test(c.claimId)), [], "none of them is offered to Pepe any more");
  assert.ok((await B.sweepLegacyClaims()).settled >= 2);
  assert.equal(await inc(), i - 1200); assert.equal(await X.P.balance("reserve"), f - 800);
  assert.equal(await count("reserve_claims", "claimId IN ('legacy-1','legacy-2') AND settled=1"), 2);
  assert.equal((await B.sweepLegacyClaims()).settled, 0);
  assert.equal(await inc(), i - 1200);
});

test("spendInTx in the caller's transaction: several destinations, one row, terminal refusal vs a throw, what casino guarantees need", async () => {
  await assert.rejects(() => B.spendInTx({ key: "mtt:1:guar", group: "misc", flow: "incentives:casino_mtt", legs: [{ userId: "u1", amount: 5 }] }), /transaction/);
  const w1 = await bal("u1"), w2 = await bal("u2"), i = await inc();
  const r = await X.tx(() => B.spendInTx({ key: "mtt:1:guar", group: "misc", flow: "incentives:casino_mtt", legs: [{ userId: "u1", amount: 100, reason: "tournament guarantee", cp: "tournament #1" }, { userId: "u2", amount: 50 }], via: "casino", why: "guarantee" }));
  assert.equal(r.ok, true); assert.equal(r.amount, 150);
  assert.deepEqual([await bal("u1"), await bal("u2"), await inc()], [w1 + 100, w2 + 50, i - 150]);
  assert.equal(await count("incentive_spends", "key='mtt:1:guar' AND grp='misc' AND flow='casino_mtt'"), 1);
  const dup = await X.tx(() => B.spendInTx({ key: "mtt:1:guar", group: "misc", flow: "incentives:casino_mtt", legs: [{ userId: "u1", amount: 100 }] }));
  assert.equal(dup.dup, true);
  const over = await X.tx(() => B.spendInTx({ key: "mtt:2:guar", group: "misc", flow: "incentives:casino_mtt", legs: [{ userId: "u1", amount: 2 * M }] }));
  assert.deepEqual([over.ok, over.terminal, over.code], [false, true, "E_OVER_BUDGET"]);
  await X.owner("site", 1);
  await assert.rejects(() => X.tx(() => B.spendInTx({ key: "mtt:3:guar", group: "misc", flow: "casino_mtt", legs: [{ userId: "u1", amount: 1 }] })));
  await X.owner("site");
  const BUD = X.R("casino", "mttbudget");
  assert.equal(BUD.hasApi(B), true);
  assert.equal(await BUD.headroom("misc", T0), await B.remaining("misc"));
  assert.equal(B.multiLeg, true);
});

test("the engines' side: the epoch's share and the activity spends go into the week's record, no effect for Pepe", async () => {
  await X.tx(() => B.setShareInTx(WEEK, 642187, 91741));
  const w = await B.weekForEngines(T0 / 1000);
  assert.equal(w.id, WEEK); assert.equal(w.share, 642187); assert.equal(w.release_per_day, 91741);
  const blk = await B.fundingBlock(T0 / 1000);
  assert.equal(blk.share, 642187); assert.equal(blk.treasury, true);
  assert.equal((await post("/api/policy/bot/week", {})).body.week.share, 642187);
});
