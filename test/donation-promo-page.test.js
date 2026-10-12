// 1.99tq: donation promos on the page + the API: /support shows the promo (boosted rate, cap, the viewer's allowance,
// countdown) and prices every tier with the SAME split the credit uses; /api/donate/promo quotes before paying; the admin
// routes are Admin-only and refuse overlaps. Offline: a scratch DB, the routes on a local express app.
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

test("no promo: /support is unchanged (no callout, no data-promo), the quote is the normal rate", async () => {
  const r = await req("GET", "/support");
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes('id="spPromo"') && !r.text.includes("data-promo="));
  const q = await req("GET", "/api/donate/promo?usd=10");
  assert.equal(q.json.promo, null);
  assert.equal(q.json.quote.pat, 5000000);
});

test("admin routes: Admins only, validated, audit-logged; overlaps refused", async () => {
  const now = Date.now();
  assert.equal((await req("POST", "/api/admin/donpromo/create", { user: "alice", body: { mode: "rate", rate: 1000000, cap_usd: 100, ends: now + 3600e3 } })).status, 403);
  assert.equal((await req("GET", "/api/admin/donpromo")).status, 401);
  const bad = await req("POST", "/api/admin/donpromo/create", { user: "boss", body: { mode: "rate", rate: 9000000, cap_usd: 100, ends: now + 3600e3 } });
  assert.equal(bad.status, 400); assert.match(bad.json.error, /at most 10x/);
  const ok = await req("POST", "/api/admin/donpromo/create", { user: "boss", body: { mode: "rate", rate: 1000000, cap_usd: 100, ends: now + 3 * 3600e3, label: "Today only: 1M PAT per $1, up to $100" } });
  assert.equal(ok.status, 200, ok.text);
  const dup = await req("POST", "/api/admin/donpromo/create", { user: "boss", body: { mode: "mult", mult: 2, cap_usd: 10, ends: now + 600e3 } });
  assert.equal(dup.status, 409);
  const st = await req("GET", "/api/admin/donpromo", { user: "boss" });
  assert.equal(st.json.promos[0].status, "live");
  assert.equal(st.json.log[0].detail.what, "create");
});

test("a live promo on /support: the callout, the allowance, a countdown, and every tier priced with the promo split", async () => {
  const anon = await req("GET", "/support");
  assert.match(anon.text, /id="spPromo"/);
  assert.match(anon.text, /Today only: 1M PAT per \$1, up to \$100/);
  assert.match(anon.text, /Get <b>1,000,000<\/b> PAT per \$1 on your first \$100/);
  assert.match(anon.text, /Sign in to see how much of yours is left/);
  assert.match(anon.text, /id="spPromoLeft" data-ends="\d+"/);
  assert.match(anon.text, /10,000,000 PAT/, "the $10 tier at the promo rate");
  // alice already used $95 of her $100: her $10 tier = $5 promo + $5 normal = 5M + 2.5M
  const p = (await DP.adminState()).promos[0];
  await runQuery(`INSERT INTO donation_promo_credits (ref, promo_id, user_id, via, paid_at, credited, usd_cents, promo_cents, normal_cents, promo_rate, normal_rate, promo_pat, normal_pat, bonus, bonus_pct)
                  VALUES ('don-x', ?, 'u-alice', 'card', ?, ?, 9500, 9500, 0, 1000000, 500000, 95000000, 0, 0, 20)`, [p.id, Date.now(), Date.now()]);
  const a = await req("GET", "/support", { user: "alice" });
  assert.match(a.text, /You have \$<b>5<\/b> of your \$100 promo allowance left/);
  assert.match(a.text, /7,500,000 PAT/);
  const dp = a.text.match(/data-promo="([^"]+)"/);
  const D = JSON.parse(dp[1].replace(/&#34;/g, '"').replace(/&quot;/g, '"'));
  assert.equal(D.allowance_cents, 500); assert.equal(D.rate, 1000000); assert.equal(D.bonus_base, "normal");
  // the quote API agrees
  const q = await req("GET", "/api/donate/promo?usd=10", { user: "alice" });
  assert.deepEqual([q.json.quote.promo_cents, q.json.quote.normal_cents, q.json.quote.pat], [500, 500, 7500000]);
  assert.equal(q.json.promo.allowance_cents, 500);
  // the started promo's price is locked; the end can move; ending it takes it off the page
  const lock = await req("POST", `/api/admin/donpromo/${p.id}/edit`, { user: "boss", body: { rate: 2000000 } });
  assert.equal(lock.status, 409);
  assert.equal((await req("POST", `/api/admin/donpromo/${p.id}/end`, { user: "boss", body: {} })).status, 200);
  assert.ok(!(await req("GET", "/support")).text.includes('id="spPromo"'));
});
