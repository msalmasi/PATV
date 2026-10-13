// 1.99wy: stashes belong to PATV ACCOUNTS ("u:<userId>"), not chat logins (stashes.js).
//   * the one-off re-key (rekeyAll / tools/stash-rekey.js): dry run changes nothing; apply moves owners + members to account
//     keys in one transaction with every balance / stake lock / the move journal / the vault book / NAVs / supply exactly
//     equal; keyed (the same key again = the stored answer); a login no account has stays; a check that differs rolls back
//   * chat commands: the login maps to its account through the link; access is checked by account on the site
//   * the website: an account with no chat login owns, deposits, grants - by account
//   * a later link claims a bare-login stash; a login change never moves an account's stash; a merge moves it
//   NODE_PATH=G:/PATV/node_modules node --test test/stash-account-keys.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stash-acct-test-"));
process.chdir(tmp);
process.env.STAGING = "1";
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const S = require(path.join(repo, "stashes"));
const R = require(path.join(repo, "loginrekey"));

const one = async (sql, args = []) => (await getQuery(sql, args))[0];
const bal = async (id) => (await one("SELECT points_balance AS b FROM users WHERE userId = ?", [id])).b;
// the supply / vault facts the tool checks, from this test's own tables (the real ones read supply.js + capital/vaults.js)
const supplyFn = async () => (await one("SELECT COALESCE(SUM(points_balance),0) AS w FROM users")).w + (await S.total()).amount;
let vaultBook = { v: { bank: { total: 100, holders: { s1: 40, protocol: 60 } } }, nav: { bank: 1234567.5 } };
const vaultFacts = async () => JSON.parse(JSON.stringify(vaultBook));

let base, server;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  for (const [id, name, b, cf] of [["a1", "Ann", 10000, "ann_cf"], ["b1", "Bob", 5000, "bob_cf"], ["c1", "Cat", 0, "Cat_CF"], ["w1", "WebOnly", 3000, null]]) {
    await runQuery("INSERT INTO users (userId, username, password, points_balance, camfrogUsername) VALUES (?, ?, 'x', ?, ?)", [id, name, b, cf]);
  }
  await S.init();
  // the prod shape after the 1.99ne hand-over: login keys as Pepe had them (a login no account has: "ghost_cf")
  await runQuery(`INSERT INTO stashes (id, owner, name, balance, staked, earned, created, updated) VALUES
                  ('1', 'ann_cf', 'savings', 700000, 200000, 15, 1791088717.8, 1), ('2', 'bob_cf', 'pot', 5000, 0, 0, 1791088720, 2),
                  ('3', 'ghost_cf', 'old', 900, 0, 0, 1791000000, 3), ('4', 'cat_cf', 'gone', 0, 0, 0, 1791000000, 4)`);
  await runQuery("UPDATE stashes SET closed = 1791100000 WHERE id = '4'");
  await runQuery(`INSERT INTO stash_members (stash_id, login) VALUES ('1', 'bob_cf'), ('1', 'ghost_cf'), ('2', 'ann_cf'), ('2', 'bob_cf')`);
  await runQuery("INSERT INTO stash_moves (key, stash_id, kind, amount, ts, result) VALUES ('m1', '1', 'deposit', 700000, 1, '{}')");
  await runQuery("INSERT INTO stash_meta (key, value) VALUES ('imported', ?), ('rev', '7'), ('seq', '4')", [JSON.stringify({ at: 1, digest: "x", total: 705900, count: 4 })]);
  const app = express();
  app.use(express.json());
  S.register(app, { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());

const keysNow = async () => ({
  owners: (await getQuery("SELECT id, owner FROM stashes ORDER BY id")).map((r) => [r.id, r.owner]),
  members: (await getQuery("SELECT stash_id, login FROM stash_members ORDER BY stash_id, login")).map((r) => [r.stash_id, r.login]),
});

test("before the re-key: login-keyed rows already resolve to their accounts (readers take both forms)", async () => {
  const me = await S.actorOf({ userId: "a1" });
  const s1 = await S.get("1");
  assert.equal(S.isOwner(s1, me), true);
  assert.deepEqual([s1.owner, s1.owner_id, s1.owner_name], ["ann_cf", "a1", "Ann"]);
  assert.equal(S.canUse(await S.get("2"), me), true, "a member by login");
  assert.equal(S.canUse(s1, await S.actorOf({ userId: "w1" })), false);
});

test("dry run: the exact plan + every check, and nothing changes", async () => {
  const before = await keysNow();
  const rev = await one("SELECT value FROM stash_meta WHERE key = 'rev'");
  const r = await S.rekeyAll({ key: "sk-test-1", apply: false, supplyFn, vaultFacts, backup: false });
  assert.equal(r.ok, true);
  assert.deepEqual(r.checks, { stashes: true, vault_book: true, supply: true });
  assert.deepEqual(r.changes.owners.map((o) => [o.stash, o.from, o.to]), [["1", "ann_cf", "u:a1"], ["2", "bob_cf", "u:b1"], ["4", "cat_cf", "u:c1"]]);
  assert.deepEqual(r.changes.members.map((m) => [m.stash, m.from, m.to]), [["1", "bob_cf", "u:b1"], ["2", "ann_cf", "u:a1"], ["2", "bob_cf", null]],
                   "bob is stash 2's owner - his member row is dropped");
  assert.deepEqual(r.changes.kept.map((k) => [k.stash, k.role, k.key]), [["3", "owner", "ghost_cf"], ["1", "member", "ghost_cf"]]);
  assert.deepEqual(await keysNow(), before, "rolled back");
  assert.deepEqual(await one("SELECT value FROM stash_meta WHERE key = 'rev'"), rev);
  assert.equal(await one("SELECT value FROM stash_meta WHERE key = 'rekey:sk-test-1'"), undefined);
});

test("a check that differs refuses and rolls back (the vault book moved under it)", async () => {
  const before = await keysNow();
  let n = 0;
  const moving = async () => ({ book: n++ });
  await assert.rejects(S.rekeyAll({ key: "sk-test-bad", apply: true, supplyFn, vaultFacts: moving, backup: false }), /didn't verify \(vault_book\)/);
  assert.deepEqual(await keysNow(), before);
  assert.equal(await one("SELECT value FROM stash_meta WHERE key = 'rekey:sk-test-bad'"), undefined);
});

test("apply: owners + members to account keys, money exactly equal, keyed (a second run is the stored answer)", async () => {
  const facts0 = await S.moneyFacts();
  const supply0 = await supplyFn();
  const r = await S.rekeyAll({ key: "sk-test-1", apply: true, supplyFn, vaultFacts, backup: false });
  assert.equal(r.ok, true);
  assert.deepEqual(await keysNow(), {
    owners: [["1", "u:a1"], ["2", "u:b1"], ["3", "ghost_cf"], ["4", "u:c1"]],
    members: [["1", "ghost_cf"], ["1", "u:b1"], ["2", "u:a1"]],
  });
  const facts1 = await S.moneyFacts();
  assert.deepEqual(facts1, facts0, "every balance / stake lock / earned / name / date + the journal: identical");
  assert.equal(facts1.total, 705900);
  assert.equal(facts1.staked, 200000);
  assert.equal(await supplyFn(), supply0);
  assert.equal(r.totals.digest, facts0.digest);
  assert.ok(Number(JSON.parse((await one("SELECT value FROM stash_meta WHERE key = 'rev'")).value)) > 7, "Pepe's mirror refreshes");
  const again = await S.rekeyAll({ key: "sk-test-1", apply: true, supplyFn, vaultFacts, backup: false });
  assert.equal(again.already, true);
  const other = await S.rekeyAll({ key: "sk-test-2", apply: false, supplyFn, vaultFacts, backup: false });
  assert.deepEqual([other.changes.owners.length, other.changes.members.length], [0, 0], "nothing left to move");
  // Pepe still sees chat keys; the website names accounts
  const st = await post("/api/stash/bot/state", { password: "bot" });
  const s1 = st.body.stashes.find((s) => s.id === "1");
  assert.deepEqual([s1.owner, s1.members.sort(), s1.owner_id, s1.owner_name], ["ann_cf", ["bob_cf", "ghost_cf"], "a1", "Ann"]);
});

test("chat commands: the login maps to its account; the site checks access by account", async () => {
  // bob (member of stash 1) deposits by chat - old Pepe shape: login + username
  const d = await post("/api/stash/bot/act", { password: "bot", op: "deposit", stash: "1", login: "bob_cf", username: "Bob", amount: 1000, key: "pv-bob-dep-1" });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(await bal("b1"), 4000);
  // new Pepe shape: user_id
  const w = await post("/api/stash/bot/act", { password: "bot", op: "withdraw", stash: "2", login: "ann_cf", user_id: "a1", amount: 500, key: "pv-ann-wd-1" });
  assert.equal(w.status, 200, JSON.stringify(w.body));
  assert.equal(await bal("a1"), 10500);
  // cat isn't in stash 1: refused, nothing moves
  const no = await post("/api/stash/bot/act", { password: "bot", op: "withdraw", stash: "1", login: "cat_cf", amount: 500, key: "pv-cat-wd-1" });
  assert.deepEqual([no.status, no.body.code], [403, "E_NO_ACCESS"]);
  // a member can't rename / grant (owner only)
  const rn = await post("/api/stash/bot/act", { password: "bot", op: "rename", stash: "1", login: "bob_cf", name: "mine" });
  assert.deepEqual([rn.status, rn.body.code], [403, "E_NO_ACCESS"]);
  // the owner grants by chat name -> stored as the account
  const g = await post("/api/stash/bot/act", { password: "bot", op: "members", stash: "1", login: "ann_cf", who: "cat_cf", add: true });
  assert.equal(g.body.ok, true, JSON.stringify(g.body));
  assert.ok((await getQuery("SELECT 1 FROM stash_members WHERE stash_id = '1' AND login = 'u:c1'")).length);
  // an account nick (u:<id>, a web-only account via Telegram / a website action) is that account
  const c = await post("/api/stash/bot/act", { password: "bot", op: "create", login: "u:w1", name: "tg" });
  assert.equal(c.body.ok, true, JSON.stringify(c.body));
  assert.equal(c.body.stash.owner, "u:w1");
  assert.equal(c.body.stash.owner_name, "WebOnly");
});

test("the website: an account with no chat login owns, deposits and grants by account", async () => {
  assert.match(await S.fromForm("w1", ["deposit", "tg", "1k"], "idem-w1-0001"), /Deposited 1,000 PAT into WebOnly\/tg/);
  assert.equal(await bal("w1"), 2000);
  assert.match(await S.fromForm("w1", ["grant", "tg", "@Ann"], "idem-w1-0002"), /can now use WebOnly\/tg/, "a PATV username works");
  assert.match(await S.fromForm("a1", ["withdraw", "WebOnly/tg", "200"], "idem-a1-0003"), /Withdrew 200 PAT/, "owner/name by PATV username");
  assert.match(await S.fromForm("a1", ["withdraw", "u:w1/tg", "100"], "idem-a1-0004"), /Withdrew 100 PAT/);
  assert.match(await S.fromForm("w1", ["revoke", "tg", "ann_cf"], "idem-w1-0005"), /no longer has access/, "revoke by chat login");
  assert.match(await S.fromForm("a1", ["withdraw", "WebOnly/tg", "100"], "idem-a1-0006"), /don't have a stash/);
});

test("links + merges: a bare-login stash goes to the account that links it; an account's stash never moves with a login change; a merge moves it", async () => {
  // ghost_cf links to WebOnly (w1, no login before): its bare rows become u:w1
  await runQuery("UPDATE users SET camfrogUsername = 'ghost_cf' WHERE userId = 'w1'");
  await R.changed("w1", null, "ghost_cf", "camfrog:relink");
  assert.equal((await one("SELECT owner FROM stashes WHERE id = '3'")).owner, "u:w1");
  assert.ok((await getQuery("SELECT 1 FROM stash_members WHERE stash_id = '1' AND login = 'u:w1'")).length);
  // Ann relinks ann_cf -> ann2: stash 1 stays hers (u:a1); Pepe sees her new login
  await runQuery("UPDATE users SET camfrogUsername = 'ann2' WHERE userId = 'a1'");
  await R.changed("a1", "ann_cf", "ann2", "camfrog:relink");
  assert.equal((await one("SELECT owner FROM stashes WHERE id = '1'")).owner, "u:a1");
  assert.equal((await S.get("1")).owner, "ann2");
  // the old login typed again is nobody: no access
  const no = await post("/api/stash/bot/act", { password: "bot", op: "withdraw", stash: "1", login: "ann_cf", amount: 100, key: "pv-old-login-1" });
  assert.equal(no.status, 403);
  // Cat's account is merged into Bob's: her stash + membership move, Bob isn't a member of a stash he owns
  await runQuery("INSERT INTO stash_members (stash_id, login) VALUES ('2', 'u:c1')");
  const m = await S.mergeAccounts("c1", "b1");
  assert.deepEqual(m, { owners: 1, members: 2 });
  assert.equal((await one("SELECT owner FROM stashes WHERE id = '4'")).owner, "u:b1");
  assert.equal((await getQuery("SELECT 1 FROM stash_members WHERE stash_id = '2' AND login IN ('u:c1', 'u:b1')")).length, 0);
  assert.ok((await getQuery("SELECT 1 FROM stash_members WHERE stash_id = '1' AND login = 'u:b1'")).length);
  assert.equal((await S.moneyFacts()).total, 705900 + 1000 - 500 + 1000 - 200 - 100, "only the deposits / withdrawals above moved PAT");
});

test("wiring: loginrekey claims, accountMerge moves, the vault owner check, the tool", () => {
  assert.match(fs.readFileSync(path.join(repo, "loginrekey.js"), "utf8"), /require\("\.\/stashes"\)\.claimLogin/);
  const am = fs.readFileSync(path.join(repo, "accountMerge.js"), "utf8");
  assert.match(am, /"stashes\.owner": \{ deny: "a holder key/);
  assert.match(am, /require\("\.\/stashes"\)\.mergeAccounts\(fromId, toId\)/);
  assert.match(fs.readFileSync(path.join(repo, "capital", "vaults.js"), "utf8"), /only the stash's owner can stake or unstake it/);
  assert.match(fs.readFileSync(path.join(repo, "tools", "stash-rekey.js"), "utf8"), /rekeyAll\(\{ key, apply \}\)/);
});
