// PO-0b (economy policy -> site plan §2.4, T6): Pepe's pool moves (POST /api/pools/move) with TERMINAL answers, and
// move-status answering paid | refused | unknown.
//   * terminal is opt-in per call (terminal:true): today's Pepe RETRIES the same key after E_INSUFFICIENT (his outbox flush
//     keeps a queued move at its head until it lands; _tr_settle_claim resends claim:<id> next tick; turf-season / pad top-up
//     / _tr_finish legs resend <tid>:<leg>), so recording those refusals would freeze his outbox and leave claims unpaid -
//     without the flag nothing changes. Pepe turns it on (PO-0c) once those callers mint a new key for a deliberate retry.
//   * with it, a refusal (E_INSUFFICIENT / E_BURN_ONLY) is recorded under the key (kind "refused", net 0, no legs: a refusal
//     at leg n undoes legs 0..n-1) and every later attempt with that key gets it - the original arriving after Pepe's
//     refund can't move a second time.
//   * in-site callers read "seen" as "it moved": a recorded refusal is not that (the site's claim settle never marks a
//     claim settled on it). Rollback's pre-check reads committed rows, in order (PO-0b c).
//   NODE_PATH=G:/PATV/node_modules node --test test/pool-move-status.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "pool-move-status-test-")));
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery, tx } = require(path.join(repo, "dbUtils"));
const P = require(path.join(repo, "pools"));

const POOLS = { reserve: 1000, incentives: 50, stakers: 0, burn: 400, fortknox: 300 };
let base, server;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot" }, body)) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const move = (key, legs, extra = {}) => post("/api/pools/move", { key, legs, why: "test", flow: "test", ...extra });
const status = (key) => post("/api/pools/move-status", { key });
const bal = (k) => P.balance(k);
const rowsOf = (like) => getQuery("SELECT key, kind, net, legs FROM pool_moves WHERE key LIKE ? ORDER BY ts, key", [like]);

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, created DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE supply_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), pools TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("INSERT INTO supply_snapshot (id, pools) VALUES (1, '[]')");
  await P.init();
  await require(path.join(repo, "funding")).init();
  await P._setMeta("enabled", true);
  const payload = JSON.stringify({ v: 1, source: "pepe", pools: POOLS, docs: {}, routes: {}, econ_cfg: {}, econ_cfg_log: [], catalog: {} });
  const keys = Object.keys(POOLS);
  const pr = await P.importFromPepe({ key: "pc-pms-test", payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"),
                                      totals: { sum: Object.values(POOLS).reduce((t, v) => t + v, 0), count: keys.length, per_pool: POOLS } });
  assert.equal(pr.ok, true, JSON.stringify(pr));
  await P._setMeta("imported", Object.assign((await P.exportState()).imported, { at: 0 }));   // past the cutover's 2-minute window
  P._forgetLive();
  const app = express();
  app.use(express.json());
  P.register(app, { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());

test("move-status: paid / unknown", async () => {
  const m = await move("tr-D1-release:out", [["reserve", -100], ["incentives", 100]]);
  assert.equal(m.body.ok, true);
  const st = await status("tr-D1-release:out");
  assert.equal(st.body.state, "paid");
  const un = await status("never-sent-key");
  assert.equal(un.body.result, null);
  assert.equal(un.body.state, "unknown");
});

test("without terminal (today's Pepe): a refusal is NOT recorded - the same key lands once the pool can cover it", async () => {
  const r = await move("claim:c-old", [["incentives", -500]]);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "E_INSUFFICIENT");
  assert.equal((await status("claim:c-old")).body.state, "unknown", "nothing recorded");
  await move("fund-inc-1", [["reserve", -500], ["incentives", 500]]);
  const again = await move("claim:c-old", [["incentives", -500]]);
  assert.equal(again.body.ok, true, "his retry under the same key settles it (outbox flush / _tr_settle_claim)");
});

test("with terminal: the refusal is recorded under the key (409, code E_INSUFFICIENT) and every later attempt gets it", async () => {
  const inc0 = await bal("incentives"), st0 = await bal("stakers");
  // two legs: the credit (leg 0) went in before the debit (leg 1) failed - it is undone with it
  const r = await move("tr-D2-x:out", [["stakers", 700], ["incentives", -(inc0 + 700)]], { terminal: true });
  assert.equal(r.status, 409);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, "E_INSUFFICIENT");
  assert.equal(r.body.refused, true);
  assert.equal(r.body.pool, "incentives");
  assert.equal(await bal("stakers"), st0, "the leg before the refusal is undone");
  assert.equal(await bal("incentives"), inc0);
  const rows = await rowsOf("tr-D2-x:out");
  assert.deepEqual(rows.map((x) => [x.kind, x.net, x.legs]), [["refused", 0, "[]"]], "kind refused, net 0, no legs");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pool_move_legs WHERE move_key = 'tr-D2-x:out'"))[0].n, 0);
  const st = await status("tr-D2-x:out");
  assert.equal(st.body.state, "refused");
  assert.equal(st.body.result.code, "E_INSUFFICIENT");
  // funds arrive; the same key (with or without the flag) still answers the refusal and moves nothing
  await move("fund-inc-2", [["reserve", -800], ["incentives", 800]]);
  const inc1 = await bal("incentives");
  for (const extra of [{ terminal: true }, {}]) {
    const again = await move("tr-D2-x:out", [["stakers", 700], ["incentives", -700]], extra);
    assert.equal(again.status, 409);
    assert.equal(again.body.dup, true);
    assert.equal(await bal("incentives"), inc1);
  }
  // the burn reserve only burns: a payout out of it is refused - terminal too
  const b = await move("mo-D3-x:out", [["burn", -10], ["reserve", 10]], { terminal: true });
  assert.equal(b.status, 409);
  assert.equal(b.body.code, "E_BURN_ONLY");
  assert.equal((await status("mo-D3-x:out")).body.state, "refused");
  // a bad request (not about the pools' balances) is never recorded
  assert.equal((await move("bad-legs-1", [["nope pool", 5]], { terminal: true })).status, 400);
  assert.equal((await status("bad-legs-1")).body.state, "unknown");
});

test("the harness: the original arrives after the recorded refusal and Pepe's refund - it gets the refusal; exactly one movement", async () => {
  // Pepe's debit K (incentives -> stakers) times out; his retry is refused (the budget is short) and recorded; he refunds
  // what his side moved under K:back; the budget refills; the original - queued in the network all along - arrives
  const K = "corr-rs7-s3";
  const short = (await bal("incentives")) + 1;
  const retry = await move(`${K}:out`, [["incentives", -short], ["stakers", short]], { terminal: true });
  assert.equal(retry.body.code, "E_INSUFFICIENT");
  const back = await move(`${K}:back`, [["reserve", -10], ["fortknox", 10]], { terminal: true });
  assert.equal(back.body.ok, true);
  await move("fund-inc-3", [["reserve", -(short + 5)], ["incentives", short + 5]]);
  const before = { inc: await bal("incentives"), stk: await bal("stakers") };
  const orig = await move(`${K}:out`, [["incentives", -short], ["stakers", short]], { terminal: true });
  assert.equal(orig.status, 409);
  assert.equal(orig.body.dup, true);
  assert.deepEqual({ inc: await bal("incentives"), stk: await bal("stakers") }, before, "the original moved nothing");
  const moved = (await rowsOf(`${K}%`)).filter((x) => x.kind !== "refused");
  assert.deepEqual(moved.map((x) => x.key), [`${K}:back`], "exactly one movement: the refund");
});

test("in-site 'seen' means it MOVED: a recorded refusal never settles a website claim (nothing unbacked)", async () => {
  const { runQuery: rq } = require(path.join(repo, "dbUtils"));
  await rq("INSERT INTO reserve_claims (claimId, flow, userId, type, amount, settled) VALUES ('c-ref-1', 'welcome', NULL, 'welcome', 50, 0)");
  // a Pepe move under the claim's key was refused terminally (the Reserve was short at the time)
  const r = await move("claim:c-ref-1", [["reserve", -1e12]], { terminal: true });
  assert.equal(r.body.refused, true);
  assert.equal(await tx(() => P._seen("claim:c-ref-1")), null, "seen(): not a movement");
  assert.equal((await P.moveStatus("claim:c-ref-1")).ok, false, "moveStatus: the recorded refusal");
  const res0 = await bal("reserve");
  // the guard is what refuses it (the review of PO-0b): one "holds a recorded refusal" line over two passes, never an error
  // (without it the settle would hit the key's UNIQUE row and log an error on every pass)
  const logs = [], errs = [];
  const { log, error } = console;
  console.log = (...a) => { logs.push(a.join(" ")); };
  console.error = (...a) => { errs.push(a.join(" ")); };
  try {
    await P.settleClaims();
    await P.settleClaims();
  } finally {
    console.log = log;
    console.error = error;
  }
  assert.equal(logs.filter((l) => /c-ref-1/.test(l) && /holds a recorded refusal - left unsettled/.test(l)).length, 1, logs.join("\n"));
  assert.deepEqual(errs.filter((l) => /c-ref-1/.test(l)), [], "no error about the claim");
  assert.equal((await getQuery("SELECT settled FROM reserve_claims WHERE claimId = 'c-ref-1'"))[0].settled, 0, "left unsettled (an owner decides)");
  assert.equal(await bal("reserve"), res0, "and nothing debited");
  // an ordinary claim next to it still settles
  await rq("INSERT INTO reserve_claims (claimId, flow, userId, type, amount, settled) VALUES ('c-ok-1', 'welcome', NULL, 'welcome', 50, 0)");
  await P.settleClaims();
  assert.equal((await getQuery("SELECT settled FROM reserve_claims WHERE claimId = 'c-ok-1'"))[0].settled, 1);
  assert.equal(await bal("reserve"), res0 - 50);
});

test("(c) the rollback's pre-check reads committed rows in order: an OPEN transaction's row that rolls back is not a 'dup'", async () => {
  let go, inserted;
  const gate = new Promise((r) => { go = r; });
  const ins = new Promise((r) => { inserted = r; });
  const doomed = tx(async () => {
    await runQuery("INSERT INTO pool_moves (key, kind, ts, net, legs, result) VALUES ('rollback:rbk-0001', 'rollback', ?, 0, '[]', ?)",
                   [Date.now(), JSON.stringify({ ok: true, key: "rbk-0001", pools: {}, sum: 0, fake: true })]);
    inserted();
    await gate;
    throw new Error("COMMIT failed");
  }).catch((e) => e.message);
  await ins;
  assert.equal(((await P.moveStatus("rollback:rbk-0001")) || {}).fake, true, "a plain read sees the uncommitted row (one shared connection)");
  const rb = P.rollbackToPepe({ key: "rbk-0001", actor: "test" });
  await new Promise((r) => setTimeout(r, 60));
  go();
  assert.equal(await doomed, "COMMIT failed");
  const out = await rb;
  assert.equal(out.fake, undefined, "not the doomed row's answer");
  assert.equal(out.dup, undefined);
  assert.equal(out.ok, true, "the rollback really ran (every pool -> 0, live off)");
  assert.equal(await P.live(), false);
});

test("review of the owner answers: the pools' live check is inside the move's transaction, after its dedup - a hand-back committed ahead of a queued move refuses it; a recorded key still answers", async () => {
  // the previous test handed the pools back (every pool 0, live off): live again, with PAT in the Reserve
  await P._setMeta("live", true);
  P._forgetLive();
  await runQuery("UPDATE pools SET balance = 1000 WHERE key = 'reserve'");
  const done = await move("pre-handback-0001", [["reserve", -5], ["fortknox", 5]]);
  assert.equal(done.body.ok, true);
  const r0 = await bal("reserve");
  let release, opened;
  const gate = new Promise((r) => { release = r; });
  const isOpen = new Promise((r) => { opened = r; });
  const blocker = tx(async () => {
    opened();
    await gate;
    await P._setMeta("live", false);                       // the pools go back to Pepe while the moves wait at the write gate
  });
  await isOpen;
  const mv = move("late-after-handback-0001", [["reserve", -7], ["fortknox", 7]]);
  const ch = P.fund({ key: "late-fund-0001", pool: "reserve", username: "nobody_here", amount: 3, flow: "test", type: "test" }).then(() => "ran", (e) => e.code);
  await new Promise((r) => setTimeout(r, 80));
  release();
  await blocker;
  try {
    const r = await mv;                                        // its check reads the row fresh (the 2 s cache still says live)
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.code, "E_NOT_LIVE", "the check made before it queued is not enough");
    assert.ok(["E_NOT_LIVE", "E_TARGET_NOT_FOUND"].includes(await ch));
    assert.equal(await bal("reserve"), r0, "nothing moved into drained, non-live pools");
    assert.equal((await rowsOf("late-after-handback-%")).length, 0, "not recorded");
    // Pepe's retry of a move that DID land before the hand-back gets its recorded answer, not E_NOT_LIVE
    const again = await move("pre-handback-0001", [["reserve", -5], ["fortknox", 5]]);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.dup, true);
  } finally {
    await P._setMeta("live", true);
    P._forgetLive();
  }
  assert.equal((await move("late-after-handback-0001", [["reserve", -7], ["fortknox", 7]])).body.ok, true, "the same key lands once live again");
});
