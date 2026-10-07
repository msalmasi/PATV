// Offline tests for PAT burning, website side (burns.js, 1.99dk): the bot-only record endpoint (keyed,
// burn reserve only), supply going down by exactly the burned amount, the public log having no user data,
// and the admin burn request (Admin class, CSRF, single-use nonce, step-up password) queued for Pepe.
//   node --test test/burns.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "burns-test-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
process.env.SECRET_KEY = "test-secret";
delete process.env.PEPE_CONTROL_SECRET;
const express = require("express");
const bcrypt = require("bcrypt");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const B = require(path.join(repo, "burns"));
const P = require(path.join(repo, "pepecontrol"));

let base, server;
const BOT = "bot-token";
test.before(async () => {
  await runQuery("CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT, class TEXT DEFAULT 'pleb', camfrogUsername TEXT, points_balance INTEGER DEFAULT 0)");
  const h = await bcrypt.hash("right-pass", 4);
  await runQuery("INSERT INTO users (userId, username, password, class, points_balance) VALUES ('a1', 'boss', ?, 'Admin', 500), ('s1', 'staffer', ?, 'Staff', 700), ('p1', 'alice', ?, 'pleb', 1000)", [h, h, h]);
  await B.ensure();
  await P.init();
  const app = express();
  app.use(express.json());
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  B.register(app, { isBotToken: (t) => t === BOT, addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server.close());

const H = (u, csrf) => Object.assign({ "content-type": "application/json" }, u ? { "x-test-user": u } : {}, csrf ? { "x-csrf-token": csrf } : {});
async function call(p, u, body, csrf) {
  const r = await fetch(base + p, body === undefined ? { headers: H(u, csrf) } : { method: "POST", headers: H(u, csrf), body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const rec = (key, amount, extra = {}) => Object.assign({ id: "B1", key, ts: Date.now(), source: "burn", amount, reason: "waterfall leftover", actor_kind: "auto", actor: "accrual" }, extra);

test("record: bot only, keyed (a resend is a no-op), burn reserve only", async () => {
  assert.equal((await call("/api/g/burns/record", null, { password: "nope", burns: [rec("key-1", 100)] })).status, 403);
  let r = await call("/api/g/burns/record", null, { password: BOT, burns: [rec("key-1", 100)] });
  assert.deepEqual(r.body.recorded, ["key-1"]);
  r = await call("/api/g/burns/record", null, { password: BOT, burns: [rec("key-1", 100)] });
  assert.deepEqual(r.body.recorded, ["key-1"]);
  assert.equal((await B.burned()).total, 100, "the resend didn't count twice");
  // anything but the burn reserve is refused - a wallet, the House, the Reserve can't be recorded as burned
  for (const source of ["reserve", "house", "jackpot", "wallet", "alice"]) {
    r = await call("/api/g/burns/record", null, { password: BOT, burns: [rec("key-" + source, 50, { source })] });
    assert.deepEqual(r.body.recorded, [], source + " refused");
  }
  r = await call("/api/g/burns/record", null, { password: BOT, burns: [rec("key-neg", -5), rec("bad key!", 5)] });
  assert.deepEqual(r.body.recorded, []);
  assert.equal((await B.burned()).total, 100);
});

test("stats: total, 7 and 30 days", async () => {
  const old = Date.now() - 20 * 86400 * 1000, older = Date.now() - 40 * 86400 * 1000;
  await call("/api/g/burns/record", null, { password: BOT, burns: [rec("key-20d", 1000, { ts: old }), rec("key-40d", 10000, { ts: older })] });
  const s = await B.burned();
  assert.equal(s.total, 11100);
  assert.equal(s.d7, 100);
  assert.equal(s.d30, 1100);
});

test("public log: no user data", async () => {
  await call("/api/g/burns/record", null, { password: BOT, burns: [rec("key-adm", 7, { actor_kind: "admin", actor: "boss", reason: "test burn ok'd by @alice" })] });
  const r = await call("/api/burns", null);
  assert.equal(r.status, 200);
  const txt = JSON.stringify(r.body);
  assert.ok(!/boss|alice|userId|actor"/.test(txt), "no actor, no handles, no user ids: " + txt);
  for (const b of r.body.burns) assert.deepEqual(Object.keys(b).sort(), ["amount", "at", "how", "id", "reason", "source", "sourceLabel"]);
  assert.ok(r.body.burns.some((b) => b.reason.includes("@…")));
  assert.equal(r.body.burned.total, 11107);
});

test("supply: the burn reserve falls by exactly the burned amount; burned PAT is never a pool", async () => {
  // patSupply's arithmetic (index.js): wallets + jackpot + Pepe's pools, any "burned*" pool dropped
  const pools = (burnReserve) => [{ key: "vault:reserve", amount: 30_000_000 }, { key: "vault:burn", amount: burnReserve }, { key: "burned", amount: 999 }];
  const sum = (ps) => 2200 + 5_000_000 + ps.filter((p) => !/^burned/i.test(p.key)).reduce((s, p) => s + p.amount, 0);
  const before = sum(pools(400_000));
  const after = sum(pools(400_000 - 150_000));          // Pepe burned 150k out of the burn reserve
  assert.equal(before - after, 150_000);
  const src = fs.readFileSync(path.join(repo, "index.js"), "utf8");
  assert.match(src, /pools = pools\.filter\(\(p\) => !\/\^burned\/i\.test/);
  assert.match(src, /circulating: total - outOfCirculation/);
});

test("admin burn: Admin + CSRF + single-use nonce + step-up password, queued for Pepe with a key", async () => {
  const tok = P.csrfToken("boss");
  assert.equal((await call("/api/admin/burn", null, { amount: 5 })).status, 401);
  assert.equal((await call("/api/admin/burn", "s1", { amount: 5 }, P.csrfToken("staffer"))).status, 403);
  assert.equal((await call("/api/admin/burn", "p1", { amount: 5 }, P.csrfToken("alice"))).status, 403);
  assert.equal((await call("/api/admin/burn/nonce", "a1", {}, "bad")).status, 403, "CSRF");
  assert.equal((await call("/api/admin/burn", "a1", { amount: 5, password: "right-pass" }, tok)).status, 409, "no nonce");
  B.sync({ max_now: 1000, reserve: 1000, cfg: { mode: "batch" }, stats: { total: 11107 } });
  let n = (await call("/api/admin/burn/nonce", "a1", {}, tok)).body.nonce;
  assert.equal((await call("/api/admin/burn", "a1", { amount: 5, nonce: n, password: "wrong" }, tok)).status, 403, "wrong password");
  assert.equal((await call("/api/admin/burn", "a1", { amount: 5, nonce: n, password: "right-pass" }, tok)).status, 409, "nonce is single use");
  n = (await call("/api/admin/burn/nonce", "a1", {}, tok)).body.nonce;
  assert.equal((await call("/api/admin/burn", "a1", { amount: 5000, nonce: n, password: "right-pass" }, tok)).status, 400, "over what Pepe allows");
  n = (await call("/api/admin/burn/nonce", "a1", {}, tok)).body.nonce;
  const r = await call("/api/admin/burn", "a1", { amount: 500, reason: "test", nonce: n, password: "right-pass" }, tok);
  assert.equal(r.status, 200);
  const a = (await getQuery("SELECT * FROM pepe_actions WHERE id = ?", [r.body.request.id]))[0];
  assert.equal(a.kind, "econ.burn");
  assert.equal(a.site_admin, 1);
  const args = JSON.parse(a.args);
  assert.equal(args[0], "500");
  assert.equal(args[2], r.body.request.key);
  assert.ok(/^[0-9a-f]{24}$/.test(args[2]));
  const st = await call("/api/admin/burn/" + a.id, "a1");
  assert.equal(st.body.action.status, "pending");
  const v = await call("/api/admin/burn", "a1");
  assert.equal(v.body.reconcile.ok, true, "Pepe's total and the public log agree");
});
