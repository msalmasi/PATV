// 1.99tc: PATV username history + the resolver (usernames.js). The 2026-10-12 prod escrow cutover was refused with "no PATV
// account for Hfddhh": the hold named an account that had been merged into and then renamed. Covered here:
//   * rename after a hold -> the escrow import still resolves the hold to the renamed account (and stores today's name);
//   * merge then rename (the incident, with and without a rename row: the merge log alone is enough);
//   * an old name two accounts used -> refused with a clear E_AMBIGUOUS error, nothing imported; a userId settles it;
//   * strict: a CURRENT name another account used to have is refused unless the record is newer than the hand-over;
//   * renames into another account's old name are refused (reservedFor); merged-away userIds follow the merge;
//   * the backfill from account_merge_log / account_archive / escrow_holds is idempotent; /api/users/resolve.
//   NODE_PATH=G:/PATV/node_modules node --test test/username-history.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "username-history-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const U = require(path.join(repo, "usernames"));
const AM = require(path.join(repo, "accountMerge"));
const ledger = require(path.join(repo, "ledger"));
const P = require(path.join(repo, "pools"));
const L = require(path.join(repo, "escrow", "ledger"));

const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
let base, server;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot" }, body)) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const addUser = (id, name, cf = null, bal = 1000) =>
  runQuery("INSERT INTO users (userId, username, password, points_balance, camfrogUsername) VALUES (?, ?, 'x', ?, ?)", [id, name, bal, cf]);
// what the two rename routes do (index.js /api/users/camfrog/rename, user.controller updateUsername)
async function rename(id, to, via = "rename:pepe") {
  const was = (await getQuery("SELECT username FROM users WHERE userId = ?", [id]))[0].username;
  assert.equal(await U.reservedFor(to, id), null, `${to} is reserved`);
  await runQuery("UPDATE users SET username = ? WHERE userId = ?", [to, id]);
  await U.record(id, was, to, via);
}
// what a merge does: log it (accountMerge.logMerge -> history), remember the id (ledger), delete the old row
async function merge(fromId, toId, via = "camfrog link") {
  const from = (await getQuery("SELECT * FROM users WHERE userId = ?", [fromId]))[0];
  const to = (await getQuery("SELECT * FROM users WHERE userId = ?", [toId]))[0];
  await AM.logMerge({ via, from, to, pat: from.points_balance });
  await ledger.recordMerge(fromId, toId, via);
  await runQuery("DELETE FROM users WHERE userId = ?", [fromId]);
}
function pack(holds, key) {
  const sum = holds.reduce((t, h) => t + h.amount, 0);
  const payload = JSON.stringify({ v: 1, source: "pepe", holds, seq: 1, supply: [{ key: "escrow:holds", label: "holds", amount: sum }] });
  const per = {};
  for (const h of holds) per[L.kindOf(h.ref)] = (per[L.kindOf(h.ref)] || 0) + h.amount;
  return { key, payload, digest: sha(payload), totals: { sum, count: holds.length, per_kind: per } };
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, created DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE supply_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), pools TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES ('seed', 's', NULL, 1000000)");
  await ledger.ensure();
  await U.ensure();
  await require(path.join(repo, "funding")).init();
  await P.init();
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const deps = { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() };
  P.register(app, deps);
  L.register(app, deps);
  U.register(app, deps);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());

test("rename after a hold: the old name resolves to the renamed account; a case-only change writes nothing", async () => {
  await addUser("r1", "Rosie", "rosie_cf");
  await rename("r1", "RoseGold");
  const r = await U.resolve("Rosie");
  assert.equal(r.ok, true);
  assert.equal(r.user.userId, "r1");
  assert.equal(r.user.username, "RoseGold");
  assert.equal(r.via, "history");
  assert.equal((await U.resolve("rosie")).user.userId, "r1", "case-insensitive");
  assert.equal((await U.resolve("RoseGold")).via, "current");
  assert.equal(await U.record("r1", "RoseGold", "rosegold", "rename:web"), false);
  // a rename back into your own old name is fine; into someone else's old name is refused
  await addUser("r2", "Other");
  assert.equal(await U.reservedFor("Rosie", "r1"), null);
  assert.equal(await U.reservedFor("Rosie", "r2"), "r1");
  assert.equal((await U.resolve("never-was")).code, U.E_NOT_FOUND);
});

test("merge then rename (the Hfddhh incident): the merged-away name and the pre-rename name both resolve", async () => {
  await addUser("auto-1", "CFi00snkcl", "watermelonfelon", 0);
  await addUser("hf", "Hfddhh", null, 5000);
  await merge("auto-1", "hf");
  await runQuery("UPDATE users SET camfrogUsername = 'watermelonfelon' WHERE userId = 'hf'");
  // renamed WITHOUT a history row (what happened on prod before 1.99tc): the merge log's target name is enough
  await runQuery("UPDATE users SET username = 'WutUpWattz' WHERE userId = 'hf'");
  for (const old of ["Hfddhh", "CFi00snkcl", "hfddhh"]) {
    const r = await U.resolve(old, { strict: true });
    assert.equal(r.ok, true, `${old}: ${r.error}`);
    assert.equal(r.user.userId, "hf");
    assert.equal(r.user.username, "WutUpWattz");
  }
  // the merged-away userId follows the merge
  assert.equal(await U.resolveUserId("auto-1"), "hf");
  const rr = await U.resolveRecord({ userId: "auto-1", username: "nope" });
  assert.equal(rr.user.userId, "hf");
  assert.equal(rr.via, "merged");
});

test("ambiguous: an old name two live accounts used is refused with a clear error; a userId settles it", async () => {
  await addUser("a1", "dupname");
  await rename("a1", "AliceNew");
  // a2 took "dupname" afterwards and gave it up too (a name freed before 1.99tc reserved it)
  await addUser("a2", "dupname");
  await runQuery("UPDATE users SET username = 'BobNew' WHERE userId = 'a2'");
  await U.record("a2", "dupname", "BobNew", "rename:web", { at: Date.now() + 1000 });
  const r = await U.resolve("dupname");
  assert.equal(r.ok, false);
  assert.equal(r.code, U.E_AMBIGUOUS);
  assert.match(r.error, /dupname was used by 2 accounts \((AliceNew, BobNew|BobNew, AliceNew)\) - can't tell which; send the userId/);
  assert.equal(await U.findUser("dupname"), null);
  const byId = await U.resolveRecord({ userId: "a2", username: "dupname" });
  assert.equal(byId.ok, true);
  assert.equal(byId.user.username, "BobNew");
});

test("strict: a current name another account used to have is refused unless the record is newer than the hand-over", async () => {
  await addUser("s1", "Shared");
  await runQuery("UPDATE users SET username = 'S1new' WHERE userId = 's1'");
  const handover = Date.now() - 60000;
  await U.record("s1", "Shared", "S1new", "rename:web", { at: handover });
  await addUser("s2", "Shared");                         // took the freed name (before the reservation existed)
  assert.equal((await U.resolve("Shared")).user.userId, "s2", "a live call: the account called that now");
  const strict = await U.resolve("Shared", { strict: true });
  assert.equal(strict.code, U.E_AMBIGUOUS);
  assert.match(strict.error, /belongs to Shared now but was S1new's before - send the userId/);
  assert.equal((await U.resolve("Shared", { strict: true, at: handover - 5000 })).ok, false, "an older record could be s1's");
  assert.equal((await U.resolve("Shared", { strict: true, at: handover + 5000 })).user.userId, "s2", "a newer record is s2's");
});

test("the escrow import: a renamed hold resolves; an ambiguous one is refused (nothing kept); user_id wins", async () => {
  await addUser("e1", "HoldName", "holder_cf", 10000);
  await rename("e1", "HoldRenamed");
  await L.setMeta("enabled", true);
  await P._setMeta("live", true);
  P._forgetLive();
  await runQuery("INSERT INTO supply_snapshot (id, pools) VALUES (1, '[]')");
  // ambiguous first: refused, nothing written
  const amb = await post("/api/escrow/admin/import", pack([{ id: "h1", ref: "BT3", user: "dupname", nick: "x", amount: 1000 },
                                                           { id: "h2", ref: "BT3", user: "HoldName", nick: "holder_cf", amount: 500 }], "ec-amb-1"));
  assert.equal(amb.status, 409);
  assert.equal(amb.body.code, "E_AMBIGUOUS");
  assert.match(amb.body.error, /ambiguous PATV account: the old PATV username dupname was used by 2 accounts/);
  assert.equal(await L.live(), false);
  assert.equal((await L.heldTotal()).count, 0);
  // the real one: an old name (renamed), the incident's merged+renamed name, and an ambiguous name carried by its user_id
  const ok = await post("/api/escrow/admin/import", pack([{ id: "h3919", ref: "BT3", user: "Hfddhh", nick: "watermelonfelon", amount: 1000 },
                                                          { id: "h2", ref: "BT3", user: "HoldName", nick: "holder_cf", amount: 500 },
                                                          { id: "h4", ref: "BT3", user: "dupname", user_id: "a1", nick: "x", amount: 250 }], "ec-ok-1"));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.count, 3);
  const rows = await getQuery("SELECT id, user_id, username FROM escrow_holds ORDER BY id");
  assert.deepEqual(rows.map((r) => [r.id, r.user_id, r.username]),
                   [["h2", "e1", "HoldRenamed"], ["h3919", "hf", "WutUpWattz"], ["h4", "a1", "AliceNew"]]);
  // a later payout to the old name lands on the renamed account too (the settle / grant legs use the same resolver)
  assert.equal((await L.accountFor({ username: "HoldName" })).userId, "e1");
});

test("backfill: merge log / archive / escrow_holds traces, only names that differ from today's, idempotent; /api/users/resolve", async () => {
  await runQuery("DELETE FROM username_history_meta");
  const dry = await U.backfill({ apply: false });
  assert.ok(dry.rows.some((r) => r.old === "Hfddhh" && r.userId === "hf"), JSON.stringify(dry.rows));
  assert.ok(!dry.rows.some((r) => r.old === "WutUpWattz"), "today's name is not history");
  // a Camfrog login a hold was charged under that the account isn't linked to (h4: login "x" on AliceNew) -> login history
  assert.ok(dry.rows.some((r) => r.kind === "camfrog" && r.old === "x" && r.userId === "a1"), "login traces from escrow_holds");
  const lines = ["[DUP-MERGE] CFgone1 -> AliceNew: +0 PAT main", "noise", "[ALT-MERGE] stents85 -> nobody-here: x"];
  const a = await U.backfill({ apply: true, mergeLogLines: lines });
  assert.ok(a.written >= 1);
  assert.equal(a.unresolvedLog.length, 1);
  const b = await U.backfill({ apply: true, mergeLogLines: lines });
  assert.equal(b.written, 0, "nothing twice");
  assert.equal((await U.resolve("CFgone1")).user.userId, "a1");
  assert.equal(await U.backfillOnce(), null, "the boot backfill sees it ran");
  const r = await post("/api/users/resolve", { names: ["Hfddhh", "dupname", "nobody", "AliceNew"], ids: ["auto-1", "zzz"] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.names.Hfddhh, { ok: true, userId: "hf", username: "WutUpWattz", via: "history" });
  assert.equal(r.body.names.dupname.code, "E_AMBIGUOUS");
  assert.equal(r.body.names.nobody.ok, false);
  assert.equal(r.body.names.AliceNew.via, "current");
  assert.deepEqual(r.body.ids["auto-1"], { ok: true, userId: "hf", username: "WutUpWattz", via: "merged" });
  assert.equal(r.body.ids.zzz.ok, false);
  assert.equal((await post("/api/users/resolve", { password: "no", names: ["x"] })).status, 403);
});
