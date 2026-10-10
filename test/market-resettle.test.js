// An admin re-settle (1.99ka, Pepe's pepe_mktresettle): M49 was paid out No, then re-settled Yes. The sync keeps
// m.resettle; the settlement banner and the judgement section say "Re-settled Yes by <admin>: <reason>", the
// settlement is no longer credited to Pepe's (wrong) ruling, and the PAT history names the moves.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "market-resettle-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const markets = require(path.join(repo, "markets"));
const history = require(path.join(repo, "history"));

const B = 50000, T = "Whereismymoneyfortrainingurbotandsellingmydata";
const M49 = {
  id: 49, model: "lmsr", question: "Will Bitcoin climb back to $83,000 USD in the next 24 hours?", options: ["Yes", "No"], b: B,
  q: { Yes: 818643.94, No: 407479.70 }, pool: 0, seed: 34659, volume: 800000, seed_from: "mm",
  status: "settled", result: "Yes", settled_by: "admin1", creator: "ritchiecuh", judge: "pepefrog", room: "DRAMA_CENTRAL",
  created: 1791568375, closes: 1791654775, ended: 1791670000, ai_judge: true,
  ai: { state: "final", result: "No", raw: "No", confidence: 0.7, at: 1791655685, reason: "the latest price (~$82,567) shows it stayed just below that level" },
  paid_out: { at: 1791670000, total: 818642, result: "Yes" },
  resettle: { at: 1791670000, by: "admin1", from: "No", to: "Yes", reason: "Coinbase 1-min high $83,093.39 at 17:38 UTC, inside the window.",
              clawback: [{ nick: "ritchiecuh", amount: 407479 }], funder: "mm", funder_back: 411180,
              payouts: [{ nick: "ritchiecuh", amount: 40903 }, { nick: "foamy1111", amount: 138126 }, { nick: "tricon", amount: 639613 }],
              paid: 818642, leftover: 17, junk: "<script>" },
  positions: {
    ritchiecuh: { nick: "ritchiecuh", user: "brocklee258", shares: { No: 407479.7, Yes: 40903.65 }, cost: { No: 100000, Yes: 10000 } },
    foamy1111: { nick: "foamy1111", user: "pb", shares: { Yes: 138126.89 }, cost: { Yes: 100000 } },
    tricon: { nick: "tricon", user: T, shares: { Yes: 639613.4 }, cost: { Yes: 590000 } },
  },
  trades: [], history: [],
};

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0,
                  camfrogUsername TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  app.use(express.json({ limit: "5mb" }));
  markets.register(app, { isBotToken: (t) => t === "bot-token", addUser: (req, res, next) => { req.user = null; next(); } });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  const r = await fetch(base + "/api/markets/sync", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "bot-token", markets: [M49] }) });
  assert.equal(r.status, 200);
});
test.after(() => server.close());

test("the sync keeps the re-settle record (whitelisted fields only)", async () => {
  const d = JSON.parse((await getQuery("SELECT data FROM markets WHERE id = 49"))[0].data);
  assert.equal(d.resettle.to, "Yes");
  assert.equal(d.resettle.from, "No");
  assert.equal(d.resettle.paid, 818642);
  assert.deepEqual(d.resettle.clawback, [{ nick: "ritchiecuh", amount: 407479 }]);
  assert.equal(d.resettle.junk, undefined);
});

test("the banner: Resolved YES, judged by the admin (not Pepe), and the re-settle line with the PAT it moved", async () => {
  const h = await (await fetch(base + "/markets/49")).text();
  assert.match(h, /⚖ Resolved: YES/);
  assert.doesNotMatch(h, /judged by 🤖 Pepe \(AI judge\)/, "the settlement isn't credited to Pepe's wrong ruling");
  assert.match(h, /id="resettle">⚖ <b>Re-settled Yes<\/b> by /);
  assert.match(h, /Coinbase 1-min high \$83,093\.39 at 17:38 UTC, inside the window\./);
  assert.match(h, /It was first settled No\. Taken back: ritchiecuh 407,479 · 411,180 from the mm vault\. Paid: ritchiecuh \+40,903, foamy1111 \+138,126, tricon \+639,613 · 17 back to the mm vault\./);
});

test("the judgement section says it was re-settled and that Pepe's ruling was wrong", async () => {
  const h = await (await fetch(base + "/markets/49")).text();
  assert.match(h, /<p class="aij-rs">⚖ <b>Re-settled Yes<\/b> by an admin \(admin1\): Coinbase 1-min high[^<]*Pepe's ruling below was wrong\.<\/p>\s*<p id="judgement">Pepe ruled <b>No<\/b>/);
});

test("PAT history names the re-settle moves", () => {
  assert.equal(history.describe({ type: "market-resettle-clawback", points: -407479 }).text, "Market payout taken back (re-settled)");
  assert.equal(history.describe({ type: "market-win (re-settled)", points: 40903 }).text, "Won a prediction market bet (re-settled)");
  assert.equal(history.describe({ type: "market-resettle-undo", points: 407479 }).text, "Market re-settle undone - payout returned");
  assert.equal(history.describe({ type: "market-win", points: 5 }).text, "Won a prediction market bet");
});
