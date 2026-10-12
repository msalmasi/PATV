// 1.99ne: personal stashes on the site (stashes.js), Pepe as a client.
//   * the import (Pepe's export on deploy): off unless enabled, digest + totals checked, a verified backup first,
//     idempotent (same export = "already"), a different export refused, never over existing rows
//   * deposits / withdrawals: wallet row + stash balance in one transaction, idempotent by key, only unstaked PAT out,
//     nothing moves on a refusal; the website form does it without Pepe
//   * Pepe's bot moves (vault legs, stake lock) + move_status; close pays the owner; supply + wallet snapshot rules
//   NODE_PATH=G:/PATV/node_modules node --test test/stashes.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stashes-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "stashes"));

const bal = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;
const sbal = async (id) => (await S.get(id)).balance;
const EXPORT = [
  { id: "1", name: "pbstash", owner: "Foamy1111", members: [], balance: 80990000, staked: 0, earned: 0, created: 1791088717.8 },
  { id: "3", name: "stest", owner: "slacker_", members: ["ann_cf", "slacker_"], balance: 5000, staked: 1000, earned: 12, created: 1791088747.3 },
  { id: "7", name: "old", owner: "ann_cf", members: [], balance: 0, closed: 1791100000, created: 1791000000 },
];
const pack = (list, extra = {}) => {
  const payload = JSON.stringify(list);
  const open = list.filter((s) => !s.closed).reduce((t, s) => t + s.balance, 0);
  return { payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"), seq: 19, total: open, count: list.length, ...extra };
};

let base, server;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  for (const [id, name, b, cf] of [["u1", "ann", 10000, "ann_cf"], ["u2", "slack", 0, "slacker_"], ["u3", "foam", 0, "Foamy1111"], ["u4", "nolink", 500, null]]) {
    await runQuery("INSERT INTO users (userId, username, password, points_balance, camfrogUsername) VALUES (?, ?, 'x', ?, ?)", [id, name, b, cf]);
  }
  const app = express();
  app.use(express.json());
  S.register(app, { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());

test("off by default on prod: no import, nothing live", async () => {
  assert.equal(await S.enabled(), false);
  const r = await post("/api/stash/bot/import", { password: "bot", ...pack(EXPORT) });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "E_FEATURE_OFF");
  assert.equal(await S.live(), false);
  await assert.rejects(S.deposit({ stashId: "1", login: "foamy1111", userId: "u3", amount: 500, key: "k-early-1" }), /still live in Pepe/);
});

test("the import: digest + totals checked, a verified backup first, then idempotent", async () => {
  process.env.STAGING = "1";
  assert.equal(await S.enabled(), true, "on by default on staging");
  assert.equal((await post("/api/stash/bot/import", { password: "bot", ...pack(EXPORT, { digest: "0".repeat(64) }) })).status, 400);
  assert.equal((await post("/api/stash/bot/import", { password: "bot", ...pack(EXPORT, { total: 1 }) })).status, 400);
  const r = await post("/api/stash/bot/import", { password: "bot", ...pack(EXPORT) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.total, 80995000);
  assert.equal(r.body.count, 3);
  assert.ok(r.body.backup && fs.existsSync(r.body.backup), "a backup file exists");
  const chk = new (require("sqlite3").Database)(r.body.backup);
  const n = await new Promise((res, rej) => chk.get("SELECT COUNT(*) AS n FROM users", (e, row) => (e ? rej(e) : res(row.n))));
  chk.close();
  assert.equal(n, 4, "the backup is a real copy of the database");
  assert.equal(await S.live(), true);
  const again = await post("/api/stash/bot/import", { password: "bot", ...pack(EXPORT) });
  assert.equal(again.body.already, true);
  const other = await post("/api/stash/bot/import", { password: "bot", ...pack(EXPORT.slice(0, 1)) });
  assert.equal(other.status, 409);
  const s3 = await S.get("3");
  assert.deepEqual(s3.members, ["ann_cf"], "the owner isn't a member of their own stash");
  assert.equal(s3.staked, 1000);
  assert.equal((await S.total()).amount, 80995000, "closed stashes hold nothing");
});

test("deposit: the wallet row and the stash balance move together; idempotent by key; refused = nothing moves", async () => {
  const r = await S.deposit({ stashId: "3", login: "ann_cf", userId: "u1", amount: 2500, key: "web:u1:deposit:aaaaaaaa" });
  assert.equal(r.ok, true);
  assert.equal(await bal("u1"), 7500);
  assert.equal(await sbal("3"), 7500);
  const t = await getQuery("SELECT type, points FROM transactions WHERE userId = 'u1'");
  assert.deepEqual(t, [{ type: "stash-deposit", points: -2500 }]);
  const dup = await S.deposit({ stashId: "3", login: "ann_cf", userId: "u1", amount: 2500, key: "web:u1:deposit:aaaaaaaa" });
  assert.equal(dup.dup, true);
  assert.equal(await bal("u1"), 7500, "a retry moves nothing twice");
  await assert.rejects(S.deposit({ stashId: "3", login: "ann_cf", userId: "u1", amount: 999999, key: "web:u1:deposit:bbbbbbbb" }), /enough PAT/);
  await assert.rejects(S.deposit({ stashId: "3", login: "ann_cf", userId: "u1", amount: 50, key: "web:u1:deposit:cccccccc" }), /at least 100/);
  assert.equal(await bal("u1"), 7500);
  assert.equal(await sbal("3"), 7500);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM stash_moves WHERE key LIKE 'web:u1:deposit:%'"))[0].n, 1);
});

test("withdraw: only unstaked PAT, to the withdrawer's wallet, once", async () => {
  await assert.rejects(S.withdraw({ stashId: "3", login: "ann_cf", userId: "u1", amount: 7000, key: "w-1-xxxxxxxx" }), /6,500 PAT you can take out.*staked/);
  const r = await S.withdraw({ stashId: "3", login: "ann_cf", userId: "u1", amount: "all", key: "w-2-xxxxxxxx" });
  assert.equal(r.amount, 6500);
  assert.equal(await sbal("3"), 1000);
  assert.equal(await bal("u1"), 14000);
  await S.withdraw({ stashId: "3", login: "ann_cf", userId: "u1", amount: "all", key: "w-2-xxxxxxxx" });
  assert.equal(await bal("u1"), 14000, "same key: paid once");
  await assert.rejects(S.withdraw({ stashId: "3", login: "ann_cf", userId: "u1", amount: "all", key: "w-3-xxxxxxxx" }), /nothing to take out/);
});

test("Pepe's bot moves: vault legs in/out of a stash, the stake lock, move_status after a lost answer", async () => {
  const m = await post("/api/stash/bot/act", { password: "bot", op: "move", stash: "1", amount: -990000, key: "q12-hold:out", kind: "vault" });
  assert.equal(m.body.ok, true);
  assert.equal(await sbal("1"), 80000000);
  const again = await post("/api/stash/bot/act", { password: "bot", op: "move", stash: "1", amount: -990000, key: "q12-hold:out", kind: "vault" });
  assert.equal(again.body.dup, true);
  assert.equal(await sbal("1"), 80000000);
  const st = await post("/api/stash/bot/act", { password: "bot", op: "move_status", key: "q12-hold:out" });
  assert.equal(st.body.result.ok, true);
  assert.equal((await post("/api/stash/bot/act", { password: "bot", op: "move_status", key: "never-seen-key" })).body.result, null);
  const over = await post("/api/stash/bot/act", { password: "bot", op: "move", stash: "3", amount: -500, key: "q13-hold:out" });
  assert.equal(over.body.ok, false, "only unstaked PAT can leave (1000 staked of 1000)");
  const unlock = await post("/api/stash/bot/act", { password: "bot", op: "move", stash: "3", staked_delta: -1000, key: "unstake-3-a", kind: "unstake" });
  assert.equal(unlock.body.staked, 0);
  const payout = await post("/api/stash/bot/act", { password: "bot", op: "move", stash: "3", amount: 40, staked_delta: 40, earned: 40, key: "stkpay-9:3" });
  assert.deepEqual([payout.body.balance, payout.body.staked], [1040, 40]);
  const s = await post("/api/stash/bot/state", { password: "bot" });
  assert.equal(s.body.live, true);
  assert.equal(s.body.stashes.length, 3);
  assert.equal((await post("/api/stash/bot/state", { password: "bot", since_rev: s.body.rev })).body.same, true);
});

test("the website form does it without Pepe: create, deposit, withdraw, grant, rename, close (stake stays Pepe's)", async () => {
  assert.equal(await S.fromForm("u1", ["stake", "x", "10"], "idem00001"), null, "vault staking is still queued for Pepe");
  assert.match(await S.fromForm("u1", ["create", "savings"], "idem00002"), /created/);
  assert.match(await S.fromForm("u1", ["create", "savings"], "idem00003"), /already have/);
  const id = (await S.list()).find((s) => s.name === "savings").id;
  assert.equal(Number(id), 20, "new ids continue Pepe's sequence");
  assert.match(await S.fromForm("u1", ["deposit", "savings", "1.5k"], "idem00004"), /Deposited 1,500 PAT/);
  assert.match(await S.fromForm("u1", ["deposit", "savings", "1.5k"], "idem00004"), /Already done/);
  assert.equal(await sbal(id), 1500);
  assert.match(await S.fromForm("u1", ["grant", "savings", "@slacker_"], "idem00005"), /slacker_ can now use/);
  assert.match(await S.fromForm("u2", ["withdraw", "ann_cf/savings", "500"], "idem00006"), /Withdrew 500 PAT/, "a member withdraws to THEIR wallet");
  assert.equal(await bal("u2"), 500);
  assert.match(await S.fromForm("u2", ["rename", "ann_cf/savings", "x"], "idem00007"), /don't have a stash/, "only the owner renames");
  assert.match(await S.fromForm("u1", ["rename", "savings", "rainy"], "idem00008"), /'savings' is now 'rainy'/);
  assert.match(await S.fromForm("u4", ["create", "x"], "idem00009"), /Link a chat account/);
  const before = await bal("u1");
  assert.match(await S.fromForm("u1", ["close", "rainy"], "idem00010"), /closed - 1,000 PAT sent to your wallet/);
  assert.equal(await bal("u1"), before + 1000);
  assert.equal((await S.get(id)).closed > 0, true);
});

test("index.js / actions.js / wallet.js wiring", () => {
  const idx = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  assert.match(idx, /require\("\.\/stashes"\)\.register\(app/);
  // (the supply moved to supply.js in Phase 5)
  assert.match(fs.readFileSync(path.join(repo, "supply.js"), "utf8"), /pools\.filter\(\(p\) => String\(p\.key \|\| ""\) !== "stashes"\)/, "supply counts the site's stashes");
  const act = fs.readFileSync(path.join(repo, "actions.js"), "utf8");
  assert.match(act, /args\[0\] === "stash"[\s\S]{0,200}fromForm/);
  const w = fs.readFileSync(path.join(repo, "wallet.js"), "utf8");
  assert.match(w, /the site owns stashes/);
});
