// 1.99mn: the /support design pass - supportpage.js (goal meter, total raised, recent supporters: all OFF by default, names only
// for members who opted in, never an exact amount next to a name) and the page itself (amount picker, payment tabs, crypto
// steps, trust notes, FAQ, thank-you). Offline: a scratch DB, cryptoweb's routes on a local express app, Stripe "on" by env.
//   NODE_PATH=<scratch with @noble/curves, @noble/hashes, qrcode-generator>;G:/PATV/node_modules node --test test/support-page.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "support-page-")));
delete process.env.STAGING;
for (const k of ["CRYPTO_RPC_ETH", "CRYPTO_RPC_BASE", "CRYPTO_RPC_SOL", "STRIPE_ENABLED"]) delete process.env[k];
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const CP = require(path.join(repo, "cryptopay"));
const SP = require(path.join(repo, "supportpage"));
const F = require(path.join(repo, "funding"));

const NOW = Date.now();
const USERS = {};
let server, base;
const sqlTime = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT,
                  points_balance INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  for (const n of ["alice", "bob", "boss"]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class) VALUES (?, ?, ?, 'x', ?)", ["u-" + n, n, n === "bob" ? "Bobby" : n, n === "boss" ? "Admin" : "pleb"]);
    USERS[n] = { userId: "u-" + n, username: n, class: n === "boss" ? "Admin" : "pleb" };
  }
  await CP.init();
  await CP.set({ crypto_donations_enabled: true, chain_eth: true, chain_base: true, chain_sol: true }, "test");
  await F.init();
  // donation mint claims: card (don-*) and crypto (cdon-*); one last month
  const rows = [["don-1", "u-alice", 2500, NOW - 1800e3], ["cdon-2", "u-bob", 5000, NOW - 7200e3], ["don-3", "u-bob", 1000, Date.UTC(new Date(NOW).getUTCFullYear(), new Date(NOW).getUTCMonth(), 1) - 5 * 86400e3]];
  for (const [id, u, cents, at] of rows) {
    await runQuery("INSERT INTO reserve_claims (claimId, flow, userId, type, amount, created, meta) VALUES (?, 'mint:donation', ?, 'donation', ?, ?, ?)",
      [id, u, cents * 5000, sqlTime(at), JSON.stringify({ usd_cents: cents })]);
  }
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  app.use(express.json());
  const addUser = (rq, rs, next) => { const u = rq.get("x-test-user"); rq.user = u ? USERS[u] || null : null; next(); };
  require(path.join(repo, "cryptoweb")).register(app, { addUser, noTimers: true });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { CP.stop(); server && server.close(); delete process.env.STRIPE_ENABLED; });

async function raw(method, p, { user, body } = {}) {
  const headers = { "Content-Type": "application/json", Origin: base, Host: base.replace(/^http:\/\//, "") };
  if (user) headers["x-test-user"] = user;
  const r = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  return { status: r.status, text: await r.text() };
}

test("supportpage: everything off by default - no goal, no total, no supporters", async () => {
  assert.deepEqual(SP.DEFAULTS, { goal_on: false, goal_usd: 0, total_on: false, recent_on: false });
  assert.deepEqual(await SP.pageData(NOW), { goal: null, total: null, recent: null });
  const pg = await raw("GET", "/support", { user: "alice" });
  assert.equal(pg.status, 200);
  assert.doesNotMatch(pg.text, /id="spGoal"|id="spTotal"|id="supporters"/);
});

test("supportpage: goal = this UTC month, total = all time, recent = anonymous unless opted in, tier word only", async () => {
  await assert.rejects(SP.set({ goal_usd: -5 }, "boss"), /whole number/);
  const r = await SP.set({ goal_on: true, goal_usd: 300, total_on: true, recent_on: true }, "boss");
  assert.deepEqual(r.changed.sort(), ["goal_on", "goal_usd", "recent_on", "total_on"]);
  let d = await SP.pageData(NOW);
  assert.deepEqual({ usd: d.goal.usd, goal: d.goal.goal, pct: d.goal.pct }, { usd: 75, goal: 300, pct: 25 }, "last month's $10 doesn't count");
  assert.deepEqual(d.total, { usd: 85, supporters: 2 });
  assert.equal(d.recent.length, 3);
  assert.ok(d.recent.every((x) => x.name === null), "nobody opted in: all anonymous");
  assert.deepEqual(d.recent.map((x) => x.tier), ["t25", "t50", "t10"]);
  await SP.setShowName("u-bob", true);
  d = await SP.pageData(NOW);
  assert.equal(d.recent.find((x) => x.tier === "t50").name, "Bobby");
  assert.equal(d.recent.find((x) => x.tier === "t25").name, null, "alice stays Someone");
  assert.deepEqual([SP.tierOf(100), SP.tierOf(999), SP.tierOf(1000), SP.tierOf(2500), SP.tierOf(99999)], ["t5", "t5", "t10", "t25", "t50"]);
  // _bools: an unticked checkbox turns a switch off
  assert.deepEqual((await SP.set({ _bools: ["total_on"] }, "boss")).changed, ["total_on"]);
  assert.equal((await SP.pageData(NOW)).total, null);
  await SP.set({ total_on: true }, "boss");
});

test("routes: the opt-in is the viewer's own (sign-in, same-site); the switches are admins only", async () => {
  assert.equal((await raw("POST", "/api/support/prefs", { body: { show_name: true } })).status, 401);
  assert.equal((await raw("POST", "/api/support/prefs", { user: "alice", body: { show_name: true } })).status, 200);
  assert.equal(await SP.showName("u-alice"), true);
  await raw("POST", "/api/support/prefs", { user: "alice", body: { show_name: false } });
  assert.equal(await SP.showName("u-alice"), false);
  assert.equal((await raw("POST", "/api/support/admin/settings", { user: "alice", body: { goal_on: false } })).status, 403);
  const ok = await raw("POST", "/api/support/admin/settings", { user: "boss", body: { goal_usd: 400 } });
  assert.equal(ok.status, 200);
  assert.equal(SP.get().goal_usd, 400);
  const ad = await raw("GET", "/admin/crypto", { user: "boss" });
  assert.match(ad.text, /id="spsForm"/);
  assert.match(ad.text, /name="goal_usd" min="0" step="1" value="400"/);
});

test("latestCard: the viewer's newest CARD donation in the last hour (not crypto, not older)", async () => {
  assert.deepEqual(await SP.latestCard("u-alice", NOW), { pat: 12500000, usd: 25 });
  assert.equal(await SP.latestCard("u-bob", NOW), null, "bob's recent one was crypto");
  assert.equal(await SP.latestCard("u-alice", NOW + 2 * 3600e3), null, "too old");
});

test("page: hero + value exchange, amount tiers with their PAT, crypto steps, trust, FAQ; card tab only while Stripe is on", async () => {
  let pg = await raw("GET", "/support", { user: "alice" });
  assert.equal(pg.status, 200);
  assert.match(pg.text, /<b>500,000<\/b> PAT for you/);
  assert.match(pg.text, /\+20% extra to the community pot/);
  for (const [usd, pat] of [[5, "2,500,000"], [10, "5,000,000"], [25, "12,500,000"], [50, "25,000,000"]]) {
    assert.match(pg.text, new RegExp(`value="${usd}"[\\s\\S]*?\\$${usd}<\\/span>\\s*<span class="pat">${pat} PAT`), "$" + usd);
  }
  assert.match(pg.text, /id="spCustom"/);
  assert.doesNotMatch(pg.text, /role="tab"/, "Stripe off: no tabs");
  assert.doesNotMatch(pg.text, /id="donateGo"/);
  assert.match(pg.text, /id="pane-crypto"/);
  assert.match(pg.text, /data-crypto-link="sol"/);
  assert.match(pg.text, /<details><summary>/);
  assert.match(pg.text, /PAT can’t be cashed out/);
  assert.match(pg.text, /public\/js\/support\.js/);
  process.env.STRIPE_ENABLED = "1"; process.env.STRIPE_SECRET_KEY = "sk_test_x"; process.env.STRIPE_WEBHOOK_SECRET = "whsec_x";
  try {
    pg = await raw("GET", "/support", { user: "alice" });
    assert.match(pg.text, /role="tab" id="tab-card"/);
    assert.match(pg.text, /id="donateGo" data-back="\/support"/);
    assert.match(pg.text, /\(TEST MODE\)/);
    const anon = await raw("GET", "/support");
    assert.match(anon.text, /href="\/login\?next=%2Fsupport%23pay"/, "signed out: sign in to donate");
    assert.doesNotMatch(anon.text, /id="donateGo"|id="spShowName"/);
    const ty = await raw("GET", "/support?donate=success", { user: "alice" });
    assert.match(ty.text, /id="thanks"/);
    assert.match(ty.text, /<b>12,500,000<\/b> PAT just landed in your wallet/);
    assert.match((await raw("GET", "/support?donate=cancel", { user: "alice" })).text, /Donation cancelled/);
  } finally { delete process.env.STRIPE_ENABLED; }
});

test("stripe: a donation started on /support comes back to /support", () => {
  const src = fs.readFileSync(path.join(repo, "stripebilling.js"), "utf8");
  assert.match(src, /back === "\/support" \? "\/support"/);
});
