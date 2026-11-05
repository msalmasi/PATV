// 1.99aku stashstake: what a stash has STAKED is its vault shares, not the 1.90 `staked` column (owner 2026-11-05: "Showing 0
// staked here when i hit !stash" - plantstash, balance 931,541, earned 20,987, 100,000 🤖 Auto shares ~ PAT 106,653).
//   * /api/stash/bot/state: each stash carries `paid` = what staking paid it (capital/vaults.paidByStash over stash_moves - the
//     figure /staking shows), so Pepe's !stash says the same "earned" (the `earned` counter misses the payouts before staking
//     fix P0.2); no `paid` at all when that read fails (never a made-up 0)
//   * the website's stash form list says what each stash has staked (the staking snapshot's shares, valued like /wallet) and
//     what staking paid it - never the dead column
//   TZ=UTC node --test test/stash-staked.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stash-staked-test-"));
process.chdir(tmp);
process.env.STAGING = "1";                     // the stash backend is on by default on staging (the import below)
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "stashes"));
const staking = require(path.join(repo, "staking"));
const V = require(path.join(repo, "capital", "vaults"));

// plantstash before its staking payouts (the moves below bring it to prod's 931,541 / earned 20,987)
const EXPORT = [
  { id: "1", name: "plantstash", owner: "foamy1111", members: ["zemonsta"], balance: 909_970, staked: 0, earned: 0, created: 1791088717.8 },
  { id: "3", name: "quiet", owner: "zemonsta", members: [], balance: 5_000, staked: 0, earned: 0, created: 1791088747.3 },
];
const pack = (list) => {
  const payload = JSON.stringify(list);
  return { payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"), seq: 19,
           total: list.reduce((t, s) => t + s.balance, 0), count: list.length };
};

let base, server;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  for (const [id, name, cf] of [["u1", "pb", "foamy1111"], ["u2", "zem", "zemonsta"]]) {
    await runQuery("INSERT INTO users (userId, username, password, points_balance, camfrogUsername) VALUES (?, ?, 'x', 0, ?)", [id, name, cf]);
  }
  const app = express();
  app.use(express.json());
  S.register(app, { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  const imp = await post("/api/stash/bot/import", { password: "bot", ...pack(EXPORT) });
  assert.equal(imp.body.ok, true, JSON.stringify(imp.body));
  // prod's stash_moves for stash 1 (all kind 'vault', staked_delta 0): three weekly payouts from before P0.2 (no `earned`),
  // two after it, and two staking corrections
  const moves = [["wf-W10-12-house", 135, 0, "waterfall stakers"], ["wf-W10-12-bank", 285, 0, "waterfall stakers"],
                 ["wf-W10-19-house", 164, 0, "waterfall stakers"], ["corr-rs1-s1", 500, 500, "staking correction rs1"],
                 ["corr-rs3-s1", 20_185, 20_185, "staking correction rs3"], ["wf-W10-26-house", 150, 150, "waterfall stakers"],
                 ["wf-W11-02-house", 152, 152, "waterfall stakers"]];
  for (const [key, amount, earned, why] of moves) {
    const r = await post("/api/stash/bot/act", { password: "bot", op: "move", stash: "1", amount, earned, key: key + ":in", kind: "vault", why });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
  }
  // a stake's PAT leaving the stash (not a payout) is never "paid"
  await post("/api/stash/bot/act", { password: "bot", op: "move", stash: "3", amount: -1_000, key: "q9-hold:out", kind: "vault", why: "vault deposit" });
});
test.after(() => server && server.close());

test("the plantstash fixture: balance 931,541, the `earned` counter 20,987, the dead `staked` column 0", async () => {
  const s = await S.get("1");
  assert.deepEqual([s.balance, s.earned, s.staked], [931_541, 20_987, 0]);
});

test("bot/state: each stash carries what staking paid it (/staking's figure), keyed by the rev like the rest", async () => {
  const st = await post("/api/stash/bot/state", { password: "bot" });
  assert.equal(st.body.ok, true);
  const one = st.body.stashes.find((s) => s.id === "1"), three = st.body.stashes.find((s) => s.id === "3");
  assert.equal(one.paid.all, 21_571, "135 + 285 + 164 + 500 + 20,185 + 150 + 152 (the counter says 20,987)");
  assert.equal(one.paid.corr, 20_685);
  assert.deepEqual(one.paid, (await V.paidByStash(Date.now()))["1"], "the same numbers /staking's snapshot carries");
  assert.deepEqual(three.paid, { d7: 0, all: 0, corr: 0 }, "a stash nothing was paid to: zeros (a stake leaving is not a payout)");
  assert.equal(one.earned, 20_987, "the counter itself is untouched");
  assert.equal((await post("/api/stash/bot/state", { password: "bot", since_rev: st.body.rev })).body.same, true);
  // a payout is a stash move -> a new rev -> Pepe gets the new figure
  await post("/api/stash/bot/act", { password: "bot", op: "move", stash: "1", amount: 10, earned: 10, key: "wf-W11-09-house:in", kind: "vault", why: "waterfall stakers" });
  const st2 = await post("/api/stash/bot/state", { password: "bot", since_rev: st.body.rev });
  assert.notEqual(st2.body.same, true);
  assert.equal(st2.body.stashes.find((s) => s.id === "1").paid.all, 21_581);
});

test("bot/state: the paid read failing -> no `paid` at all (Pepe shows the counter), the stashes still answered", async () => {
  const keep = V.paidByStash;
  V.paidByStash = async () => null;
  try {
    const st = await post("/api/stash/bot/state", { password: "bot" });
    assert.equal(st.body.ok, true);
    assert.equal(st.body.stashes.length, 2);
    assert.ok(st.body.stashes.every((s) => !("paid" in s)), "never a made-up 0");
  } finally {
    V.paidByStash = keep;
  }
});

test("the website's stash list says what each stash has staked (its vault shares) and earned - not the dead column", async () => {
  // prod's snapshot for plantstash (staking_state 2026-11-05 17:26Z)
  staking.setCache({ prices: { bank: 1.024782161111687, house: 2.373090182116741, mm: 1.1368896408489675, auto: 1.06653706972311 },
                     positions: { 1: { owner: "foamy1111", name: "plantstash", owner_name: "pb", members: ["zemonsta"],
                                       hold: { auto: { shares: 100000, value: 106653 } }, cost: { auto: { in: 100000, out: 0 } },
                                       paid: { d7: 152, all: 21571, corr: 20685 } },
                                  3: { owner: "zemonsta", name: "quiet", hold: { bank: { shares: 500, value: 512 }, auto: { shares: 500, value: 533 } },
                                       paid: { d7: 0, all: 0, corr: 0 } } },
                     queue: [] }, Date.now());
  const msg = await S.fromForm("u1", ["list"], "idem-list-1");
  assert.match(msg, /🔐 pb\/plantstash: 931,551 PAT \(106,653 staked in 🤖 Auto, earned 21,571\)/, "(931,541 + the 10 paid above)");
  assert.doesNotMatch(msg, /0 staked/);
  const zem = await S.fromForm("u2", ["list"], "idem-list-2");
  assert.match(zem, /zem\/quiet: 4,000 PAT \(1,045 staked in 🏦 Bank 512 \+ 🤖 Auto 533\)/, "several vaults: the total and each; nothing paid -> no 'earned'");
  // no snapshot yet -> just the balance, as before
  staking.setCache(null, Date.now());
  assert.match(await S.fromForm("u1", ["list"], "idem-list-3"), /🔐 pb\/plantstash: 931,551 PAT( ·|$)/);
});
