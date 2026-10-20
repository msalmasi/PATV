// PO-0b (economy policy -> site plan §2.4, T6): Pepe's stash moves (POST /api/stash/bot/act op "move") answer once per key,
// TERMINALLY - "paid", or "refused" with its reason recorded under the key (insufficient: 200 as before; no such stash: 404;
// a closed stash's debit: 409) - and move_status answers paid | refused | unknown. The original Pepe gave up on, arriving
// after a recorded refusal (and his refund), gets the same refusal: exactly one movement. The owner's 2026-10-20 rules:
// (a) a credit for a stash its owner already closed is paid to the owner's WALLET (never stranded); (c) requireLive is checked
// inside the move's transaction. In-site callers (capital, policy/apply) that throw on a refusal roll the refusal back with
// their own transaction, so their keys never get stuck.
//   NODE_PATH=G:/PATV/node_modules node --test test/stash-move-status.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "stash-move-status-test-")));
process.env.STAGING = "1";                       // the stash switch defaults on (the import below)
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery, tx } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "stashes"));

const EXPORT = [
  { id: "1", name: "main", owner: "ann_cf", members: [], balance: 10000, staked: 0, earned: 0, created: 1791088717.8 },
  { id: "2", name: "pot", owner: "bob_cf", members: [], balance: 100, staked: 0, earned: 0, created: 1791088717.8 },
  { id: "5", name: "gone", owner: "ann_cf", members: [], balance: 0, staked: 0, earned: 0, closed: 1791100000, created: 1791000000 },
  { id: "6", name: "orphan", owner: "nobody_cf", members: [], balance: 0, staked: 0, earned: 0, closed: 1791100000, created: 1791000000 },
];
let base, server;
const act = (body) => fetch(base + "/api/stash/bot/act", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "bot", ...body }) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const move = (stash, amount, key, extra = {}) => act({ op: "move", stash, amount, key, kind: "vault", ...extra });
const status = (key) => act({ op: "move_status", key });
const sbal = async (id) => (await S.get(id)).balance;
const wallet = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;
const movesOf = (like) => getQuery("SELECT key, kind, amount FROM stash_moves WHERE key LIKE ? ORDER BY ts, key", [like]);

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  for (const [id, name, b, cf] of [["u1", "ann", 1000, "ann_cf"], ["u2", "bob", 0, "bob_cf"]]) {
    await runQuery("INSERT INTO users (userId, username, password, points_balance, camfrogUsername) VALUES (?, ?, 'x', ?, ?)", [id, name, b, cf]);
  }
  const app = express();
  app.use(express.json());
  S.register(app, { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  const payload = JSON.stringify(EXPORT);
  const r = await fetch(base + "/api/stash/bot/import", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "bot", payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"), seq: 6, total: 10100, count: 4 }) });
  assert.equal(r.status, 200, await r.text());
  assert.equal(await S.live(), true);
});
test.after(() => server && server.close());

test("move_status: paid / unknown (nothing recorded yet - never a refusal)", async () => {
  const m = await move("1", 500, "wf-W1-house-stk-1:in", { earned: 500, why: "waterfall stakers" });
  assert.equal(m.status, 200);
  assert.equal(m.body.ok, true);
  const st = await status("wf-W1-house-stk-1:in");
  assert.equal(st.body.state, "paid");
  assert.equal(st.body.result.ok, true);
  const un = await status("never-sent-key");
  assert.equal(un.body.result, null);
  assert.equal(un.body.state, "unknown");
  assert.equal(S.stateOf(null), "unknown");
});

test("a refusal is recorded under its key and is terminal; the status codes stay what they were", async () => {
  // insufficient: 200 {ok:false, error:"insufficient"} as before - now recorded
  const r1 = await move("2", -500, "q1-hold:out");
  assert.equal(r1.status, 200);
  assert.deepEqual([r1.body.ok, r1.body.error], [false, "insufficient"]);
  assert.equal((await status("q1-hold:out")).body.state, "refused");
  // the stash gets the PAT now - the same key still answers the refusal and moves nothing (a retry needs a NEW key)
  await S.botMove({ stashId: "2", amount: 1000, key: "topup-2-a", kind: "vault" });
  const b2 = await sbal("2");
  const r2 = await move("2", -500, "q1-hold:out");
  assert.equal(r2.body.ok, false);
  assert.equal(r2.body.dup, true);
  assert.equal(await sbal("2"), b2, "nothing moved");
  assert.equal((await move("2", -500, "q1-hold-r2:out")).body.ok, true, "a deliberate retry under a new key");
  // no such stash: 404 as before, recorded
  const n1 = await move("404", 10, "corr-x-s404:in");
  assert.equal(n1.status, 404);
  assert.equal(n1.body.code, "E_TARGET_NOT_FOUND");
  const n2 = await move("404", 10, "corr-x-s404:in");
  assert.equal(n2.status, 404, "the same answer again");
  assert.equal(n2.body.dup, true);
  assert.equal((await status("corr-x-s404:in")).body.state, "refused");
  // a closed stash's debit: 409 as before, recorded
  const c1 = await move("5", -10, "vt9:out");
  assert.equal(c1.status, 409);
  assert.equal(c1.body.code, "E_STASH_CLOSED");
  assert.equal((await status("vt9:out")).body.state, "refused");
  // the refusal rows are kind "refused", amount 0 - nothing that sums stash_moves counts them
  const rows = await getQuery("SELECT kind, amount, staked_delta FROM stash_moves WHERE key IN ('q1-hold:out', 'corr-x-s404:in', 'vt9:out')");
  assert.deepEqual(rows.map((r) => [r.kind, r.amount, r.staked_delta]), [["refused", 0, 0], ["refused", 0, 0], ["refused", 0, 0]]);
});

test("the harness: the original arrives after a recorded refusal and Pepe's refund - it gets the refusal; exactly one movement", async () => {
  // (1) a correction's credit: Pepe took the PAT from the Fed (his pool leg), the stash credit's answer was lost. His retry
  // finds no stash 77 (yet) -> refused, recorded; he refunds the Fed under <tid>:back. Then the stash shows up (a late
  // import / a new stash taking that id) and the ORIGINAL credit finally arrives: it must not pay a second time.
  const k = "corr-rs9-s77";
  const retry = await move("77", 2500, `${k}:in`, { why: "staking correction rs9" });
  assert.equal(retry.status, 404);
  const back = { ok: true };      // Pepe's refund is a pool leg on his side (<tid>:back) - the one movement
  assert.ok(back.ok);
  await runQuery("INSERT INTO stashes (id, owner, name, balance, staked, earned, created, updated) VALUES ('77', 'u:u2', 'late', 0, 0, 0, ?, ?)", [Date.now() / 1000, Date.now()]);
  const orig = await move("77", 2500, `${k}:in`, { why: "staking correction rs9" });
  assert.equal(orig.status, 404, "the original gets the recorded refusal");
  assert.equal(orig.body.dup, true);
  assert.equal(await sbal("77"), 0, "no second payment");
  assert.deepEqual((await movesOf(`${k}%`)).map((r) => [r.kind, r.amount]), [["refused", 0]]);
  // (2) a stake hold (stash -> float): the retry finds too little free PAT (the user withdrew meanwhile) -> refused, recorded;
  // the user tops the stash up; the original arrives -> the same refusal, the stash keeps its PAT
  const b0 = await sbal("1");
  await S.botMove({ stashId: "1", amount: -(b0 - 40), key: "user-withdraw-1", kind: "vault" });
  const r = await move("1", -100, "q20-hold:out");
  assert.equal(r.body.error, "insufficient");
  await S.botMove({ stashId: "1", amount: 1000, key: "user-deposit-1", kind: "vault" });
  const late = await move("1", -100, "q20-hold:out");
  assert.equal(late.body.ok, false);
  assert.equal(await sbal("1"), 1040, "the late original moved nothing");
});

test("(a) a credit for a stash its owner already closed goes to the owner's wallet, once; no account to pay -> a recorded 409", async () => {
  const w0 = await wallet("u1");
  const r = await move("5", 300, "wf-W2-bank-stk-5:in", { earned: 300, why: "waterfall stakers" });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.to_wallet, true);
  assert.equal(r.body.user_id, "u1");
  assert.equal(await wallet("u1"), w0 + 300, "paid to ann's wallet");
  assert.equal(await sbal("5"), 0, "the closed stash holds nothing");
  const tx1 = await getQuery("SELECT type, points FROM transactions WHERE userId = 'u1' AND type = 'stash-closed-credit'");
  assert.deepEqual(tx1.map((t) => [t.type, t.points]), [["stash-closed-credit", 300]]);
  const dup = await move("5", 300, "wf-W2-bank-stk-5:in", { earned: 300, why: "waterfall stakers" });
  assert.equal(dup.body.dup, true);
  assert.equal(await wallet("u1"), w0 + 300, "once");
  const row = (await getQuery("SELECT amount, user_id, txid FROM stash_moves WHERE key = 'wf-W2-bank-stk-5:in'"))[0];
  assert.equal(row.amount, 300, "the move is on the stash's record (the weekly payout adds up)");
  assert.equal(row.user_id, "u1");
  assert.ok(row.txid);
  assert.equal((await S.get("5")).earned, 300, "a staking payout still counts as the stash's earnings");
  assert.equal((await status("wf-W2-bank-stk-5:in")).body.state, "paid");
  // a stake change on a closed stash is refused (409, recorded)
  assert.equal((await move("5", 0, "stk-5-x", { staked_delta: 10 })).status, 409);
  // nobody to pay: 409, recorded - Pepe's refund puts it back where it came from
  const o = await move("6", 50, "wf-W2-bank-stk-6:in");
  assert.equal(o.status, 409);
  assert.equal(o.body.code, "E_STASH_CLOSED");
  assert.equal((await status("wf-W2-bank-stk-6:in")).body.state, "refused");
});

test("(c) requireLive is checked inside the move's transaction (a hand-back committed ahead of it refuses it)", async () => {
  let release, opened;
  const gate = new Promise((r) => { release = r; });
  const isOpen = new Promise((r) => { opened = r; });
  const blocker = tx(async () => {
    opened();
    await gate;
    await runQuery("UPDATE stash_meta SET value = 'null' WHERE key = 'imported'");   // the stashes go back while the move waits
  });
  await isOpen;
  const b0 = await sbal("1");
  const mv = move("1", 100, "late-after-handback:in");
  await new Promise((r) => setTimeout(r, 80));
  release();
  await blocker;
  const r = await mv;
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "E_NOT_LIVE");
  assert.equal(await sbal("1"), b0, "nothing moved");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM stash_moves WHERE key = 'late-after-handback:in'"))[0].n, 0, "not about the key: not recorded");
  await runQuery("UPDATE stash_meta SET value = ? WHERE key = 'imported'", [JSON.stringify({ at: Date.now() })]);
  assert.equal((await move("1", 100, "late-after-handback:in")).body.ok, true, "the same key lands once live again");
});

test("an in-site caller that throws on a refusal rolls the refusal back with it - its key never gets stuck", async () => {
  const b0 = await sbal("2");
  await assert.rejects(tx(async () => {
    const r = await S.botMove({ stashId: "2", amount: -(b0 + 1), key: "cap:q99-hold:out", kind: "vault" });
    if (!r.ok) throw new Error("E_STASH: the cut-off step fails (capital stashMove)");
  }), /E_STASH/);
  assert.equal(await S.moveStatus("cap:q99-hold:out"), null, "nothing recorded");
  await S.botMove({ stashId: "2", amount: 5, key: "topup-2-b", kind: "vault" });
  const ok = await S.botMove({ stashId: "2", amount: -(b0 + 1), key: "cap:q99-hold:out", kind: "vault" });
  assert.equal(ok.ok, true, "the next cut-off's same key lands");
});
