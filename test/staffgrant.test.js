// The /admin/economy "PAT grant" (1.99jw, staffgrant.js): Admin only, paid by the INCENTIVE BUDGET (an
// "incentives:staff_grant" claim Pepe settles), never the Reserve, never minted; refused while the budget isn't synced,
// when its balance net of unsettled incentive claims can't cover it, or past Pepe's weekly staff-grant cap; never queued;
// a negative grant returns PAT to the budget; the history entry stays "staff transfer".
// + the House adjustment (POST /api/g/wheel/jackpot, staffgrant.houseAdjust): Admin only, a reason, a Fed <-> House move.
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
const claims = () => getQuery("SELECT flow, userId, type, amount, settled FROM reserve_claims WHERE flow = 'incentives:staff_grant' ORDER BY created, rowid");
const reserveClaims = () => getQuery("SELECT flow, amount FROM reserve_claims WHERE flow NOT LIKE 'incentives:%'");
const txs = (u) => getQuery("SELECT t.type, t.points FROM transactions t JOIN users u ON u.userId = t.userId WHERE u.username = ?", [u]);
const budget = (balance) => ({ balance, week: "W2026-10-05", remaining: { welcome: 0 }, budgets: { welcome: 0 }, groups: { new_account: "welcome" } });
function sync(balance, monetary) {
  F.sync({ reserve: 1e9, flows: {}, incentives: balance === null ? undefined : budget(balance), monetary });
}

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER,
                  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER)");
  await runQuery("INSERT INTO users (userId, username, points_balance, class) VALUES ('u_ann', 'ann', 100, 'pleb'), ('u_boss', 'boss', 0, 'Admin')");
  await F.claims();     // the reserve_claims table is ready
});

test("an incentive budget Pepe never synced covers nothing (even with a rich Reserve)", async () => {
  sync(null);
  const r = await SG.grant("ann", 50);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "E_INCENTIVES_UNKNOWN");
  assert.match(r.body.message, /isn't known yet/);
  assert.equal(await bal("ann"), 100);
  assert.equal((await claims()).length, 0);
  assert.equal((await reserveClaims()).length, 0, "never the Reserve");
});

test("input checks", async () => {
  sync(1000);
  for (const a of [0, "abc", 1.5, "", null, 2e12]) assert.equal((await SG.grant("ann", a)).status, 400, String(a));
  assert.equal((await SG.grant("nobody", 5)).status, 404);
  assert.equal((await claims()).length, 0);
});

test("a grant comes out of the incentive budget: an incentives:staff_grant claim + a 'staff transfer' credit", async () => {
  sync(1000);
  const r = await SG.grant("ann", 600, "boss");
  assert.equal(r.status, 200);
  assert.equal(r.body.message, "Points transferred successfully.");
  assert.equal(r.body.from, "incentives");
  assert.equal(await bal("ann"), 700);
  assert.deepEqual((await claims()).map((c) => [c.userId, c.type, c.amount, c.settled]), [["u_ann", "staff transfer", 600, 0]]);
  assert.deepEqual((await txs("ann")).map((t) => [t.type, t.points]), [["staff transfer", 600]]);
  assert.equal((await reserveClaims()).length, 0, "nothing booked on the Reserve");
  assert.equal(await F.unsettledIncentives(), 600, "counts against the budget");
});

test("refused (E_INCENTIVES_SHORT) when the budget, net of unsettled incentive claims, can't cover it; never queued", async () => {
  // 1000 synced - 600 unsettled = 400 available
  const r = await SG.grant("ann", 401);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "E_INCENTIVES_SHORT");
  assert.equal(r.body.available, 400);
  assert.match(r.body.message, /can't cover 401 PAT \(it has 400 PAT available\)/);
  assert.equal(await bal("ann"), 700);
  assert.equal((await claims()).length, 1);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM reserve_claims WHERE queued = 1"))[0].n, 0, "not queued");
  assert.equal((await SG.grant("ann", 400)).status, 200, "exactly what's left is fine");
  assert.equal(await bal("ann"), 1100);
});

test("the weekly staff-grant cap (monetary.grant_weekly_cap): this budget week's positive grants + the new one", async () => {
  const pending = await F.claims();
  await F.settle(pending.map((c) => c.claimId));
  const weekStart = Math.floor(Date.now() / 1000) - 3600;
  sync(1e6, { grant_weekly_cap: 1500, week_start: weekStart });
  // 1000 granted this week so far (600 + 400)
  const r = await SG.grant("ann", 501);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "E_GRANT_CAP");
  assert.equal(r.body.cap, 1500);
  assert.equal(r.body.used, 1000);
  assert.match(r.body.message, /cap of 1,500 PAT \(1,000 PAT granted so far this week\)/);
  assert.equal((await SG.grant("ann", 500)).status, 200, "up to the cap is fine");
  // a new week (week_start after the grants): the cap starts over
  sync(1e6, { grant_weekly_cap: 1500, week_start: Math.floor(Date.now() / 1000) + 5 });
  assert.equal((await SG.grant("ann", 1500)).status, 200);
  // -1 = unlimited
  sync(1e6, { grant_weekly_cap: -1, week_start: weekStart });
  assert.equal((await SG.grant("ann", 50000)).status, 200);
});

test("the routing table can't move it to the House or the Reserve", async () => {
  sync(1e6);
  F.state.flows.staff_grant = "jackpot";
  try {
    const before = (await getQuery("SELECT COUNT(*) AS n FROM jackpot_rakes"))[0].n;
    assert.equal((await SG.grant("ann", 5)).status, 200);
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM jackpot_rakes"))[0].n, before, "nothing taken from the House");
    assert.equal((await claims()).at(-1).amount, 5);
    assert.equal((await reserveClaims()).length, 0);
  } finally { delete F.state.flows.staff_grant; }
});

test("Pepe sees the claims (with userId + username) and settling them frees nothing twice", async () => {
  const pending = (await F.claims()).filter((c) => c.flow === "incentives:staff_grant");
  assert.ok(pending.length > 0);
  assert.deepEqual([pending[0].userId, pending[0].username], ["u_ann", "ann"]);
  await F.settle(pending.map((c) => c.claimId));
  assert.equal((await claims()).filter((c) => !c.settled).length, 0);
});

test("a negative grant takes PAT back (only what they have) into the incentive budget", async () => {
  sync(0);
  const have = await bal("ann");
  const no = await SG.grant("ann", -(have + 1));
  assert.equal(no.status, 409);
  assert.equal(await bal("ann"), have);
  const r = await SG.grant("ann", -100);
  assert.equal(r.status, 200);
  assert.equal(await bal("ann"), have - 100);
  const last = (await claims()).at(-1);
  assert.equal(last.amount, -100, "a negative claim: Pepe credits the incentive budget");
  assert.equal(last.settled, 0);
  assert.equal((await txs("ann")).at(-1).type, "staff transfer");
  // and a clawback works while the budget isn't synced too (it only returns PAT)
  sync(null);
  assert.equal((await SG.grant("ann", -1)).status, 200);
});

// ── the House adjustment ──
const ADMIN = { userId: "u_boss", username: "boss" };
const house = async () => (await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM jackpot_rakes"))[0].t;
const houseClaims = () => getQuery("SELECT amount, userId, type FROM reserve_claims WHERE flow = 'house_adjust' ORDER BY created, rowid");

test("House adjustment: a reason (>= 8 chars) and a whole non-zero amount", async () => {
  F.state.reserve = 1000000;
  for (const [a, why] of [[0, "a good reason"], [1.5, "a good reason"], ["x", "a good reason"], [100, "short"], [100, ""], [100, null]]) {
    assert.equal((await SG.houseAdjust(ADMIN, a, why)).status, 400, `${a} / ${why}`);
  }
  assert.equal((await houseClaims()).length, 0);
});

test("House adjustment +: the Reserve pays it (a house_adjust claim), refused when it can't", async () => {
  await runQuery("DELETE FROM reserve_claims WHERE settled = 0");
  F.state.reserve = 1000;
  const h0 = await house();
  const no = await SG.houseAdjust(ADMIN, 1001, "top the House up for the weekend");
  assert.equal(no.status, 409);
  assert.equal(no.body.code, "E_RESERVE_SHORT");
  assert.equal(await house(), h0, "the House didn't change");
  assert.equal((await houseClaims()).length, 0);
  F.state.reserve = null;
  assert.match((await SG.houseAdjust(ADMIN, 5, "top the House up")).body.message, /isn't known yet/);
  F.state.reserve = 1000;
  const ok = await SG.houseAdjust(ADMIN, 700, "top the House up for the weekend");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.message, "Jackpot updated successfully.");
  assert.equal(await house(), h0 + 700);
  assert.deepEqual((await houseClaims()).map((c) => [c.amount, c.userId, c.type]), [[700, "u_boss", "top the House up for the weekend"]]);
  assert.equal(await F.reserveAvailable(), 300, "counts against the Reserve");
  const row = (await getQuery("SELECT spinId FROM jackpot_rakes ORDER BY rowid DESC LIMIT 1"))[0];
  assert.match(row.spinId, /^admin:/);
  const audit = await getQuery("SELECT action, admin_id, reason, detail FROM admin_audit WHERE action = 'house_adjust'");
  assert.equal(audit.length, 1);
  assert.equal(JSON.parse(audit[0].detail).amount, 700);
});

test("House adjustment -: only what the House holds goes back to the Reserve (a negative claim)", async () => {
  const h = await house();
  const no = await SG.houseAdjust(ADMIN, -(h + 1), "return the surplus to the Fed");
  assert.equal(no.status, 409);
  assert.equal(no.body.code, "E_HOUSE_SHORT");
  assert.equal(await house(), h);
  const ok = await SG.houseAdjust(ADMIN, -200, "return the surplus to the Fed");
  assert.equal(ok.status, 200);
  assert.equal(await house(), h - 200);
  assert.equal((await houseClaims()).at(-1).amount, -200);
  // CONSERVATION: House change == - (the Reserve's claims)
  assert.equal((await houseClaims()).reduce((s, c) => s + c.amount, 0), 500);
});

test("index.js: both routes are Admin only (Staff lost access); the cards say where the PAT comes from", () => {
  const idx = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  assert.match(idx, /require\("\.\/staffgrant"\)\.grant/);
  assert.match(idx, /require\("\.\/staffgrant"\)\.houseAdjust/);
  assert.doesNotMatch(idx, /postOrThrow\([^)]*"staff transfer"/, "no minting path");
  const at = idx.indexOf('"/api/admin/transfer/:username"');
  const grantRoute = idx.slice(at, at + 900);
  assert.match(grantRoute, /if \(userType === "Admin"\) \{/);
  assert.doesNotMatch(grantRoute, /userType === "Admin" \|\| userType === "Staff"/);
  const j = idx.indexOf('app.post("/api/g/wheel/jackpot"');
  const jp = idx.slice(j, j + 900);
  assert.match(jp, /me\.class !== "Admin"/);
  assert.doesNotMatch(jp, /"Staff"/);
  const v = fs.readFileSync(path.join(repo, "views/admin/economy.ejs"), "utf8");
  assert.match(v, /Paid from the incentive budget/);
  assert.match(v, /the Reserve only fills the protocol's pools/i);
  assert.doesNotMatch(v, /Paid from the Federal Reserve/);
  const g = fs.readFileSync(path.join(repo, "views/admin/games.ejs"), "utf8");
  assert.match(g, /id="jackpotReason"/);
});
