// Offline tests for the Federal Reserve borrow limit on /wallet (1.99aw): Pepe's loans sync carries the
// formula terms + per-borrower factors, the page works out the signed-in user's own instant limit
// (with their level), shows it with a breakdown and caps the borrow form at it, shows the reason when
// they can't borrow, never shows anyone else's limit, and tells unlinked users to link.
//   node --test test/wallet-limit.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-limit-test-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
process.env.SECRET_KEY = "test-secret";
process.env.TWITCH_BOT_TOKEN = "bot-token";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const wallet = require(path.join(repo, "wallet"));

// what Pepe (pepe_loan.py _loan_publish_soon) sends; numbers below are what his _rloan_limit gives
const TERMS = { rate_week: 0.03, max_days: 30, enabled: true, book: 0, room: 2_500_000, base: 10000, per_level: 2000, max_auto: 250000, max_open: 1, min: 1000 };
const LIMITS = {
  alicecf: { repaid: 2, lates: 0, open: 0, late: false, reason: null },
  bobcf: { repaid: 1, lates: 1, open: 0, late: false, reason: null },
  davecf: { repaid: 0, lates: 0, open: 1, late: false, reason: "you already have a Reserve loan open — repay it first" },
  erincf: { repaid: 0, lates: 0, open: 0, late: true, reason: "you're late on a loan — pay it off first" },
  frankcf: { repaid: 6, lates: 0, open: 0, late: false, reason: null },
};

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0,
                  camfrogUsername TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  for (const [id, name, cf, lv] of [["u1", "alice", "AliceCF", 12], ["u2", "bob", "bobcf", 30], ["u3", "carol", null, 50],
    ["u4", "dave", "davecf", 5], ["u5", "erin", "erincf", 80], ["u6", "frank", "frankcf", 200], ["u7", "newbie", "newbiecf", 3]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, level, points_balance) VALUES (?, ?, ?, 'x', ?, ?, 5000)",
      [id, name, name, cf, lv]);
  }
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  app.use(express.json());
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  wallet.register(app, { isBotToken: (t) => t === "bot-token", addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server.close());

async function sync(reserve) {
  const r = await fetch(base + "/api/wallet/loans", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "bot-token", loans: [], requests: [], reserve }) });
  assert.equal(r.status, 200);
}
async function page(u) {
  const r = await fetch(base + "/wallet", { headers: u ? { "x-test-user": u } : {} });
  return r.text();
}
const borrowMax = (html) => {
  const m = html.match(/name="a0" value="reserve">\s*<input type="number" name="a1"[^>]*>/);
  return m ? m[0] : null;
};

test("reserveLimit mirrors Pepe's _rloan_limit", () => {
  const rv = wallet.cleanLoans({ reserve: { ...TERMS, limits: LIMITS } }).reserve;
  assert.equal(wallet.reserveLimit(rv, "alicecf", 12).limit, 51000);         // (10k + 24k) x 1.5
  assert.equal(wallet.reserveLimit(rv, "BobCF", 30).limit, 43700);           // (10k + 60k) x 1.25 x 0.5 = 43,750, to the 100 below
  assert.equal(wallet.reserveLimit(rv, "frankcf", 200).limit, 250000);       // 2x, capped at the max instant loan
  assert.equal(wallet.reserveLimit(rv, "frankcf", 200).breakdown.capped, "max");
  assert.equal(wallet.reserveLimit(rv, "newbiecf", 3).limit, 16000);         // no history: base + level bonus
  assert.equal(wallet.reserveLimit(rv, "davecf", 5).state, "blocked");
  assert.match(wallet.reserveLimit(rv, "erincf", 80).reason, /late on a loan/);
  assert.equal(wallet.reserveLimit(rv, null, 10).state, "nolink");
  assert.equal(wallet.reserveLimit({ ...rv, enabled: false }, "alicecf", 12).state, "blocked");
  assert.match(wallet.reserveLimit({ ...rv, enabled: false }, "alicecf", 12).reason, /paused/);
  const tight = wallet.reserveLimit({ ...rv, room: 20050 }, "alicecf", 12);
  assert.equal(tight.limit, 20000);
  assert.equal(tight.breakdown.capped, "room");
  assert.match(wallet.reserveLimit({ ...rv, room: 300 }, "alicecf", 12).reason, /fully lent out/);
  assert.equal(wallet.reserveLimit(wallet.cleanLoans({ reserve: { rate_week: 0.03 } }).reserve, "alicecf", 12).state, "nodata");
});

test("the page shows my own limit, breakdown and a borrow form capped at it", async () => {
  await sync({ ...TERMS, limits: LIMITS });
  const h = await page("u1");
  assert.match(h, /you can borrow up to <b class="lim">PAT 51,000<\/b> instantly/);
  assert.match(h, /3\.0% a week \(pro rata\)/);
  assert.match(h, /up to 30 days/);
  assert.match(h, /Level 12 bonus/);
  assert.match(h, /× 1\.5/);
  const f = borrowMax(h);
  assert.ok(f, "borrow form present");
  assert.match(f, /max="51000"/);
  assert.match(f, /value="51000"/);
  assert.match(h, /href="#reserve-request">Request a bigger loan/);
  assert.match(h, /id="reserve-request"/);
});

test("never anyone else's limit or factors", async () => {
  const h = await page("u1");
  assert.doesNotMatch(h, /davecf|erincf|frankcf|bobcf/i);
  assert.doesNotMatch(h, /250,000<\/b> instantly|43,700|16,000<\/b>/);
  assert.doesNotMatch(h, /already have a Reserve loan/);
});

test("the reason I can't borrow, and no instant borrow form", async () => {
  const d = await page("u4");
  assert.match(d, /No instant Reserve loan right now/);
  assert.match(d, /You already have a Reserve loan open/);
  assert.equal(borrowMax(d), null);
  assert.match(d, /id="reserve-request"/);            // can still ask the admins
  const e = await page("u5");
  assert.match(e, /You're late on a loan|You&#39;re late on a loan/);
});

test("lending paused shows the reason", async () => {
  await sync({ ...TERMS, enabled: false, limits: LIMITS });
  const h = await page("u1");
  assert.match(h, /Reserve lending is paused right now/);
  assert.equal(borrowMax(h), null);
  await sync({ ...TERMS, limits: LIMITS });
});

test("unlinked: link your Camfrog name to borrow", async () => {
  const h = await page("u3");
  assert.match(h, /Link your Camfrog name<\/a> \(<code>!verify<\/code>\) to borrow/);
  assert.equal(borrowMax(h), null);
  assert.doesNotMatch(h, /instantly/);
});

test("a level-up shows at once (level comes from our users table)", async () => {
  await runQuery("UPDATE users SET level = 13 WHERE userId = 'u1'");
  const h = await page("u1");
  assert.match(h, /PAT 54,000<\/b> instantly/);         // (10k + 26k) x 1.5
});
