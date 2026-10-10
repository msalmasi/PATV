// The /admin/economy "PAT grant" (1.99jt, staffgrant.js): paid by the Federal Reserve (a "staff_grant" reserve claim
// Pepe settles), never minted; refused when the Reserve (net of unsettled claims) can't cover it or was never synced;
// always the Reserve whatever the PAT Routing table says; a negative grant returns PAT to the Reserve; the history
// entry stays "staff transfer".
//   NODE_PATH=G:/PATV/node_modules node --test test/staffgrant.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "staffgrant-test-"));
process.chdir(tmp);
delete process.env.STAGING;
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const F = require(path.join(repo, "funding"));
const SG = require(path.join(repo, "staffgrant"));

const bal = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE username = ?", [u]))[0].b;
const claims = () => getQuery("SELECT flow, userId, type, amount, settled FROM reserve_claims WHERE flow = 'staff_grant' ORDER BY created, rowid");
const txs = (u) => getQuery("SELECT t.type, t.points FROM transactions t JOIN users u ON u.userId = t.userId WHERE u.username = ?", [u]);

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER,
                  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)`);
  await runQuery("INSERT INTO users (userId, username, points_balance) VALUES ('u_ann', 'ann', 100)");
  await F.claims();     // the reserve_claims table is ready
});

test("a Reserve Pepe never synced covers nothing", async () => {
  F.state.reserve = null;
  const r = await SG.grant("ann", 50);
  assert.equal(r.status, 409);
  assert.match(r.body.message, /isn't known yet/);
  assert.equal(await bal("ann"), 100);
  assert.equal((await claims()).length, 0);
});

test("input checks", async () => {
  F.state.reserve = 1000;
  for (const a of [0, "abc", 1.5, "", null, 2e12]) assert.equal((await SG.grant("ann", a)).status, 400, String(a));
  assert.equal((await SG.grant("nobody", 5)).status, 404);
  assert.equal((await claims()).length, 0);
});

test("a grant comes out of the Reserve: a staff_grant claim + a 'staff transfer' credit", async () => {
  F.state.reserve = 1000;
  const r = await SG.grant("ann", 600, "boss");
  assert.equal(r.status, 200);
  assert.equal(r.body.message, "Points transferred successfully.");
  assert.equal(await bal("ann"), 700);
  assert.deepEqual((await claims()).map((c) => [c.userId, c.type, c.amount, c.settled]), [["u_ann", "staff transfer", 600, 0]]);
  assert.deepEqual((await txs("ann")).map((t) => [t.type, t.points]), [["staff transfer", 600]]);
});

test("refused when the Reserve, net of unsettled claims, can't cover it", async () => {
  // 1000 synced - 600 unsettled = 400 available
  assert.equal(await F.reserveAvailable(), 400);
  const r = await SG.grant("ann", 401);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "E_RESERVE_SHORT");
  assert.equal(r.body.available, 400);
  assert.match(r.body.message, /can't cover 401 PAT \(it has 400 PAT available\)/);
  assert.equal(await bal("ann"), 700);
  assert.equal((await claims()).length, 1);
  assert.equal((await SG.grant("ann", 400)).status, 200, "exactly what's left is fine");
  assert.equal(await bal("ann"), 1100);
});

test("always the Reserve, even when the routing table sends other flows elsewhere", async () => {
  F.state.reserve = 10000;
  F.state.flows.staff_grant = "jackpot";
  try {
    const before = (await getQuery("SELECT COUNT(*) AS n FROM jackpot_rakes").catch(() => [{ n: 0 }]))[0].n;
    assert.equal((await SG.grant("ann", 5)).status, 200);
    const after = (await getQuery("SELECT COUNT(*) AS n FROM jackpot_rakes").catch(() => [{ n: 0 }]))[0].n;
    assert.equal(after, before, "nothing taken from the House");
    assert.equal((await claims()).at(-1).amount, 5);
  } finally { delete F.state.flows.staff_grant; }
});

test("Pepe sees the claims and settling them frees nothing twice", async () => {
  const pending = (await F.claims()).filter((c) => c.flow === "staff_grant");
  assert.equal(pending.reduce((s, c) => s + c.amount, 0), 600 + 400 + 5);
  await F.settle(pending.map((c) => c.claimId));
  assert.equal((await claims()).filter((c) => !c.settled).length, 0);
});

test("a negative grant takes PAT back (only what they have) into the Reserve", async () => {
  F.state.reserve = 0;
  const have = await bal("ann");
  const no = await SG.grant("ann", -(have + 1));
  assert.equal(no.status, 409);
  assert.equal(await bal("ann"), have);
  const r = await SG.grant("ann", -100);
  assert.equal(r.status, 200);
  assert.equal(await bal("ann"), have - 100);
  const last = (await claims()).at(-1);
  assert.equal(last.amount, -100, "a negative claim: Pepe credits the Reserve");
  assert.equal(last.settled, 0);
  assert.equal((await txs("ann")).at(-1).type, "staff transfer");
});

test("the card says it's paid from the Federal Reserve", () => {
  const v = fs.readFileSync(path.join(repo, "views/admin/economy.ejs"), "utf8");
  assert.match(v, /Paid from the Federal Reserve/);
  assert.doesNotMatch(v, /doesn't come out of the Reserve/);
  const idx = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  assert.match(idx, /require\("\.\/staffgrant"\)\.grant/);
  assert.doesNotMatch(idx, /postOrThrow\([^)]*"staff transfer"/, "no more minting path");
});
