// 2026-10-11: redeem codes (redeem.js) - the used-check and the claim are one transaction with conditional writes, so two
// redeems racing each other (double-click, script) pay once.
//   NODE_PATH=G:/PATV/node_modules node --test test/redeem.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "redeem-test-")));
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const funding = require(path.join(repo, "funding"));
let vaultCalls = 0, vaultOk = true;
funding.takeFunds = async () => { vaultCalls += 1; return vaultOk; };     // the vault itself is funding.js's business
const { redeemCode } = require(path.join(repo, "redeem"));

const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [u]))[0].b;
const uses = async (c) => (await getQuery("SELECT uses_remaining AS n FROM redemption_codes WHERE code = ?", [c]))[0].n;
const credits = async (u) => (await getQuery("SELECT COUNT(*) AS n FROM transactions WHERE userId = ? AND type LIKE 'redemption%'", [u]))[0].n;

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0)`);
  await runQuery(`CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL, points INTEGER NOT NULL,
                  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery(`CREATE TABLE redemption_codes (code TEXT PRIMARY KEY, points INTEGER NOT NULL, uses_remaining INTEGER, expiration_date DATETIME)`);
  await runQuery(`CREATE TABLE user_redemptions (redemption_id INTEGER PRIMARY KEY AUTOINCREMENT, userId TEXT NOT NULL, code TEXT NOT NULL,
                  redeemed_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  for (const u of ["u1", "u2", "u3"]) await runQuery("INSERT INTO users (userId, username, password) VALUES (?, ?, 'x')", [u, u]);
  await runQuery("INSERT INTO redemption_codes (code, points, uses_remaining) VALUES ('MANY', 500, 100), ('ONE', 700, 1), ('BANK', 300, 5)");
  await runQuery("INSERT INTO redemption_codes (code, points, uses_remaining, expiration_date) VALUES ('OLD', 900, 5, '2000-01-01')");
});

test("the same user redeeming twice at once is paid once", async () => {
  vaultCalls = 0;
  const outs = await Promise.all([redeemCode("u1", "MANY"), redeemCode("u1", "MANY"), redeemCode("u1", "MANY")]);
  assert.deepEqual(outs.map((o) => o.status).sort(), [200, 400, 400]);
  assert.equal(await bal("u1"), 500);
  assert.equal(await credits("u1"), 1);
  assert.equal(await uses("MANY"), 99);
  assert.equal(vaultCalls, 1, "the vault pays only for the claim that won");
  assert.equal((await redeemCode("u1", "MANY")).status, 400, "and later too");
});

test("a code with one use left, two users at once: one is paid, the other is told it's used up", async () => {
  vaultCalls = 0;
  const [a, b] = await Promise.all([redeemCode("u2", "ONE"), redeemCode("u3", "ONE")]);
  assert.deepEqual([a.status, b.status].sort(), [200, 404]);
  assert.equal((await bal("u2")) + (await bal("u3")), 700);
  assert.equal(await uses("ONE"), 0);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM user_redemptions WHERE code = 'ONE'"))[0].n, 1);
  assert.equal(vaultCalls, 1);
});

test("the vault can't cover it: nothing is claimed (the code and the user can try again)", async () => {
  vaultOk = false;
  const r = await redeemCode("u2", "BANK");
  vaultOk = true;
  assert.equal(r.status, 503);
  assert.equal(await uses("BANK"), 5, "the use came back with the rollback");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM user_redemptions WHERE userId = 'u2' AND code = 'BANK'"))[0].n, 0);
  assert.equal((await redeemCode("u2", "BANK")).status, 200);
});

test("expired / unknown codes and no user are refused without paying", async () => {
  vaultCalls = 0;
  assert.equal((await redeemCode("u1", "OLD")).status, 404);
  assert.equal((await redeemCode("u1", "NOPE")).status, 404);
  assert.equal((await redeemCode(null, "MANY")).status, 401);
  assert.equal(vaultCalls, 0);
});

test("index.js: the route goes through redeem.js (no check-then-pay left in the route)", () => {
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  const at = src.indexOf('app.post("/api/redeem-code"');
  const body = src.slice(at, src.indexOf("});", at));
  assert.match(body, /require\("\.\/redeem"\)\.redeemCode\(/);
  assert.doesNotMatch(body, /takeFunds|user_redemptions/);
});
