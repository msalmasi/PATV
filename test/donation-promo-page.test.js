// 1.99tq: donation promos on the page + the API. 1.99ans (no PAT for dollars, nopat.js): promos are retired - /support never
// shows one or a PAT price, the quote is 0 PAT, creating one is refused; the admin routes stay Admin-only. Offline: a scratch DB, the routes on a local express app.
//   NODE_PATH=<a PATV node_modules with @noble/curves + qrcode-generator> node --test test/donation-promo-page.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "donpromo-page-")));
delete process.env.STAGING;
for (const k of ["CRYPTO_RPC_ETH", "CRYPTO_RPC_BASE", "CRYPTO_RPC_SOL", "STRIPE_ENABLED"]) delete process.env[k];
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const CP = require(path.join(repo, "cryptopay"));
const F = require(path.join(repo, "funding"));
const DP = require(path.join(repo, "donationpromo"));

const USERS = {};
let server, base;

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT, points_balance INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  for (const n of ["alice", "bob", "boss"]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class) VALUES (?, ?, ?, 'x', ?)", ["u-" + n, n, n, n === "boss" ? "Admin" : "pleb"]);
    USERS[n] = { userId: "u-" + n, username: n, class: n === "boss" ? "Admin" : "pleb" };
  }
  // owner answers 2026-10-20 (1): donation promos (and approving a held crypto payment) are a Pepe owner's - boss's account is
  // linked to an owner login
  await runQuery("ALTER TABLE users ADD COLUMN camfrogUsername TEXT");
  await runQuery("UPDATE users SET camfrogUsername = 'boss_cf' WHERE userId = 'u-boss'");
  await require(path.join(repo, "staffroles")).init();
  await runQuery("INSERT INTO pepe_roles (login, role, ts) VALUES ('boss_cf', 'owner', 1)");
  await CP.init();
  await CP.set({ crypto_donations_enabled: true }, "test");
  await F.init();
  F.sync({ reserve: 1, monetary: { donation: { rate: 500000, bonus_pct: 20 } } });
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  app.use(express.json());
  const addUser = (rq, rs, next) => { const u = rq.get("x-test-user"); rq.user = u ? USERS[u] || null : null; next(); };
  require(path.join(repo, "cryptoweb")).register(app, { addUser, noTimers: true });
  DP.register(app, { addUser, noTimers: true });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { CP.stop(); server && server.close(); });

async function req(method, p, { user, body } = {}) {
  const headers = { "Content-Type": "application/json", Origin: base, Host: base.replace(/^http:\/\//, "") };
  if (user) headers["x-test-user"] = user;
  const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (e) { json = null; }
  return { status: r.status, text, json };
}

test("1.99ans: /support shows no promo and no PAT price; the quote API answers 0 PAT", async () => {
  const r = await req("GET", "/support");
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes('id="spPromo"') && !r.text.includes("data-promo=") && !r.text.includes("data-rate="));
  assert.doesNotMatch(r.text, /PAT per \$1|\d PAT for you|5,000,000 PAT/);
  const q = await req("GET", "/api/donate/promo?usd=10");
  assert.equal(q.json.promo, null);
  assert.deepEqual([q.json.quote.pat, q.json.quote.bonus], [0, 0]);
});

test("1.99ans: admin routes are still Admins only, and creating a promo is refused (retired)", async () => {
  const now = Date.now();
  assert.equal((await req("POST", "/api/admin/donpromo/create", { user: "alice", body: { mode: "rate", rate: 1000000, cap_usd: 100, ends: now + 3600e3 } })).status, 403);
  assert.equal((await req("GET", "/api/admin/donpromo")).status, 401);
  const no = await req("POST", "/api/admin/donpromo/create", { user: "boss", body: { mode: "rate", rate: 1000000, cap_usd: 100, ends: now + 3 * 3600e3, label: "Today only" } });
  assert.equal(no.status, 410, no.text);
  assert.match(no.json.error, /retired/);
  const st = await req("GET", "/api/admin/donpromo", { user: "boss" });
  assert.equal(st.status, 200);
  assert.deepEqual(st.json.promos, []);
});

test("1.99ans: an old promo row left in the table never reaches the page", async () => {
  const now = Date.now();
  await runQuery(`INSERT INTO donation_promos (id, label, mode, rate, cap_cents, bonus_base, enabled, starts, ends, ceiling_x, normal_rate, cancelled)
                  VALUES ('DP-old', 'Today only: 1M PAT per $1', 'rate', 1000000, 10000, 'normal', 1, ?, ?, 10, 500000, 0)`, [now - 60e3, now + 3600e3]);
  await DP.refresh();
  const anon = await req("GET", "/support");
  assert.ok(!anon.text.includes('id="spPromo"'));
  assert.doesNotMatch(anon.text, /1M PAT per|1,000,000/);
  const q = await req("GET", "/api/donate/promo?usd=10", { user: "alice" });
  assert.equal(q.json.promo, null);
  assert.equal(q.json.quote.pat, 0);
  assert.equal((await req("POST", "/api/admin/donpromo/DP-old/end", { user: "boss", body: {} })).status, 200, "an old one can still be ended");
});
