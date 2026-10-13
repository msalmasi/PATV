// 1.99vi: a donation promo's budget can't be misread. On prod an admin typed 1000 meaning $1,000 - the budget is PAT at the
// promo rate, so it was 1,000 PAT and every donation fell back to the normal rate. Now: the form converts as you type
// (public/js/donpromo-budget.js, shared with the server), warns when the budget is smaller than one donor's full promo
// allowance (cap x promo rate), and the server refuses that (409 budget_small) unless confirmed.
//   NODE_PATH=<a PATV node_modules> node --test test/donation-promo-budget.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "donpromo-budget-")));
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const F = require(path.join(repo, "funding"));
const DP = require(path.join(repo, "donationpromo"));
const B = require(path.join(repo, "public", "js", "donpromo-budget"));
const EN = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));

const T0 = Date.UTC(2026, 9, 12, 16, 0, 0);
let now = T0;
DP._setClock(() => now);
const H = 3600000;
const ADMIN = { userId: "u-boss", username: "boss", class: "Admin" };
// the page's __t: the English from en.json (so the defaults in the code must match it), placeholders filled
const t = (k, d, v) => {
  assert.equal(d, EN[k], `${k}: the default in the code equals en.json`);
  return String(EN[k]).replace(/\{!?(\w+)\}/g, (m, n) => (v && v[n] != null ? v[n] : m));
};
let server, base;

test.before(async () => {
  await runQuery("CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT, points_balance INTEGER DEFAULT 0)");
  await runQuery("INSERT INTO users (userId, username, displayname, password, class) VALUES ('u-boss', 'boss', 'boss', 'x', 'Admin')");
  await F.init();
  F.sync({ reserve: 1, monetary: { donation: { rate: 500000, bonus_pct: 20 } } });
  await DP.init();
  const app = express();
  app.use(express.json());
  DP.register(app, { addUser: (rq, rs, next) => { rq.user = rq.get("x-test-user") ? ADMIN : null; next(); }, noTimers: true });
  await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server && server.close(); });

async function post(p, body) {
  const r = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, Host: base.replace(/^http:\/\//, ""), "x-test-user": "boss" },
                                   body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}

test("conversion (pure): PAT <-> dollars at the promo rate, one donor's allowance", () => {
  assert.equal(B.centsOf(1000, 1000000), 0, "1,000 PAT at 1M per $1 covers $0.00");
  assert.equal(B.centsOf(1000000000, 1000000), 100000, "1B PAT = $1,000");
  assert.equal(B.centsOf(1500000, 1000000), 150);
  assert.equal(B.patOfUsd(1000, 1000000), 1000000000, "$1,000 entered = 1B PAT stored");
  assert.equal(B.patOfUsd(2.5, 1000000), 2500000);
  assert.equal(B.allowance(10000, 1000000), 100000000, "$100 cap x 1M = 100M PAT");
  assert.equal(B.centsOf(1000, 0), 0, "no rate yet: nothing");
});

test("the live helper text under the field", () => {
  assert.equal(B.helperText(t, "", "pat", 1000000), "Blank = no budget limit.");
  assert.equal(B.helperText(t, "1000", "pat", 1000000), "= about $0.00 of donations at the promo rate. Blank = no budget limit.");
  assert.equal(B.helperText(t, "250000000", "pat", 1000000), "= about $250.00 of donations at the promo rate. Blank = no budget limit.");
  assert.equal(B.helperText(t, "1000", "usd", 1000000), "= 1,000,000,000 PAT at the promo rate (stored as PAT). Blank = no budget limit.");
  assert.equal(B.helperText(t, "1000", "pat", 0), "Set the promo rate to see what this budget is worth. Blank = no budget limit.");
});

test("the warning: a budget smaller than one donor's full promo allowance", () => {
  assert.equal(B.check("", 10000, 1000000), null, "no budget = no limit");
  assert.equal(B.check(100000000, 10000, 1000000), null, "exactly one allowance is fine");
  assert.equal(B.check(5000000000, 10000, 1000000), null);
  const w = B.check(1000, 10000, 1000000);
  assert.deepEqual(w, { budget_pat: 1000, budget_cents: 0, allowance_pat: 100000000, cap_cents: 10000, rate: 1000000, suggest_pat: 1000000000 });
  assert.equal(B.warnText(t, w), "This budget runs out after $0.00 of promo donations - less than one donor’s full promo allowance ($100.00 = 100,000,000 PAT). Did you mean 1,000,000,000 PAT?");
  assert.equal(B.check(10, 10000, 1000000).suggest_pat, 100000000, "read as dollars it'd still be small: suggest one allowance");
  assert.equal(B.warnText(t, null), "");
});

test("the server refuses a too-small budget unless confirmed (create and edit), and says so over HTTP", async () => {
  const base1 = { mode: "rate", rate: 1000000, cap_usd: 100, starts: now, ends: now + H };
  await assert.rejects(DP.create(ADMIN, { ...base1, budget: 1000 }), (e) => {
    assert.equal(e.code, "budget_small"); assert.equal(e.status, 409);
    assert.match(e.message, /runs out after \$0\.00 of promo donations/); assert.match(e.message, /Did you mean 1,000,000,000 PAT\?/);
    return true;
  });
  const r = await post("/api/admin/donpromo/create", { ...base1, budget: 1000 });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, "budget_small");
  assert.equal(r.json.detail.allowance_pat, 100000000);
  // a multiplier promo checks at its effective rate (x2 of 500k = 1M per $1)
  await assert.rejects(DP.create(ADMIN, { mode: "mult", mult: 2, cap_usd: 100, starts: now, ends: now + H, budget: 99999999 }), (e) => e.code === "budget_small");
  // confirmed: it's kept as typed
  const ok = await post("/api/admin/donpromo/create", { ...base1, budget: 1000, confirm_budget: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.promo.budget_pat, 1000);
  const id = ok.json.promo.id;
  const st = (await DP.adminState()).promos.find((x) => x.id === id);
  assert.equal(st.budget.small, true);
  assert.equal(st.budget.cents, 0);
  // an edit that doesn't touch the budget isn't asked again; a new small budget is
  assert.equal((await post(`/api/admin/donpromo/${id}/edit`, { label: "x", budget: 1000 })).status, 200);
  assert.equal((await post(`/api/admin/donpromo/${id}/edit`, { budget: 5000 })).json.code, "budget_small");
  assert.equal((await post(`/api/admin/donpromo/${id}/edit`, { budget: 1000000000 })).json.promo.budget_pat, 1000000000, "a real budget needs no confirmation");
  assert.equal((await post(`/api/admin/donpromo/${id}/edit`, { budget: "" })).json.promo.budget_pat, null, "blank = no budget");
  await DP.end(ADMIN, id);
});

test("a donation cut short by the budget is counted as a fallback (and replays don't count twice)", async () => {
  now += 2 * H;
  const p = await DP.create(ADMIN, { mode: "rate", rate: 1000000, cap_usd: 100, starts: now, ends: now + H, budget: 1000, confirm_budget: true });
  const s = await DP.creditTerms({ ref: "don-1", userId: "u-boss", cents: 5000, paidAt: now + 1, via: "card" });
  assert.deepEqual([s.promo_cents, s.normal_cents], [0, 5000], "1,000 PAT covers no whole cent at 1M per $1");
  await DP.creditTerms({ ref: "don-1", userId: "u-boss", cents: 5000, paidAt: now + 1, via: "card" });
  const st = (await DP.adminState()).promos.find((x) => x.id === p.id);
  assert.deepEqual([st.stats.budget_fallbacks, st.stats.budget_short_cents, st.budget.exhausted_live], [1, 5000, true]);
  await DP.end(ADMIN, p.id);
});
