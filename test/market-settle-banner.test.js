// Settled market page (1.99dy): a settlement banner (outcome, judge, when, Pepe's reasoning, payout rule,
// totals), a personal result card for a viewer who held a position (won / lost / refunded), the
// settlement + per-holder payout rows on top of the Trades table, a final "settled" line in the
// viewer's website orders, adaptive price precision (0.00415, not 0.004 / 0.000), and the stale
// "🤖 looking into M27…" interim replies collapsed into one pointer at the result.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "market-banner-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const markets = require(path.join(repo, "markets"));
const actions = require(path.join(repo, "actions"));

const B = 50000;
const now = Date.now() / 1000;
const pos = (nick, shares, cost) => ({ nick, shares, cost });
// M27 as on prod: Pepe's AI ruling (state final), settled No, 2 No holders paid
const M27 = {
  id: 27, model: "lmsr", question: "Will Bitcoin hit $87,000 today?", options: ["Yes", "No"], b: B, volume: 2512980,
  q: { Yes: 2409135, No: 2485637 }, status: "settled", result: "No", settled_by: "pepefrog",
  creator: "ritchiecuh", judge: "pepefrog", room: "PATV", created: now - 86400, closes: now - 3600, ended: now - 600,
  ai_judge: true,
  ai: { state: "final", result: "No", confidence: 0.99, reason: "BTC's HIGH over the window was $86,698.35, never reaching $87,000.00 (Coinbase data).",
        evidence: "PRICE DATA (Coinbase, 1-min candles): HIGH $86,698.35, LOW $85,100.01. Target $87,000.00.", disputes: [] },
  paid_out: { at: now - 600, total: 2485637, result: "No" },
  positions: {
    foamy1111: pos("foamy1111", { Yes: 2409135.3357, No: 0 }, { Yes: 10000, No: 0 }),
    tsyko: pos("tsyko", { Yes: 0, No: 2483696.198 }, { Yes: 0, No: 2500000 }),
    ritchiecuh: pos("ritchiecuh", { Yes: 0, No: 1941.16 }, { Yes: 0, No: 1000 }),
  },
  trades: [
    { ts: now - 9000, nick: "ritchiecuh", side: "buy", option: "No", shares: 1941.16, pat: 1000 },
    { ts: now - 7000, nick: "foamy1111", side: "buy", option: "Yes", shares: 2289517, pat: 1000, web: true },
    { ts: now - 5000, nick: "foamy1111", side: "buy", option: "Yes", shares: 2409135.34, pat: 10000, web: true },
  ],
  history: [[now - 86400, { Yes: 0.5, No: 0.5 }], [now - 3600, { Yes: 0.178, No: 0.822 }]],
};
// a void judged by a person, refunds scaled to 50%
const M28 = {
  id: 28, model: "lmsr", question: "Will it rain on the parade?", options: ["Yes", "No"], b: B, volume: 40000,
  q: { Yes: 0, No: 0 }, status: "void", result: "void", void_reason: "parade cancelled", settled_by: "ritchiecuh",
  creator: "pepefrog", judge: "ritchiecuh", room: "PATV", created: now - 86400, closes: now - 3600, ended: now - 500,
  paid_out: { at: now - 500, total: 19600, result: "void" },
  positions: {
    foamy1111: pos("foamy1111", { Yes: 15000, No: 0 }, { Yes: 10000, No: 0 }),
    other: pos("other", { Yes: 0, No: 50000 }, { Yes: 0, No: 30000 }),
  },
  trades: [], history: [],
};

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0,
                  camfrogUsername TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  for (const [id, name, cf] of [["u1", "pb", "foamy1111"], ["u2", "tsyko", "tsyko"], ["u3", "lurker", "lurker"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, points_balance) VALUES (?, ?, ?, 'x', ?, 5000)", [id, name, name, cf]);
  }
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  app.use(express.json({ limit: "5mb" }));
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  markets.register(app, { isBotToken: (t) => t === "bot-token", addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  const r = await fetch(base + "/api/markets/sync", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "bot-token", markets: [M27, M28] }) });
  assert.equal(r.status, 200);
  await actions.recentFor("u1", "x");   // the pepe_actions table exists
  for (const t of [1791347150241, 1791347220630]) {
    await runQuery(`INSERT INTO pepe_actions (user_id, username, camfrog, kind, args, tag, label, status, message, created, updated)
                    VALUES ('u1', 'pb', 'foamy1111', 'cmd', '["market","ai","M27"]', 'market-27', '!market ai M27', 'done', '🤖 looking into M27…', ?, ?)`, [t, t]);
  }
  await page("u3", "/markets/27");      // the market_orders table exists
  await runQuery(`INSERT INTO market_orders (market_id, user_id, username, camfrog, option, amount, kind, status, message, created, updated)
                  VALUES (27, 'u1', 'pb', 'foamy1111', 'Yes', 10000, 'buy', 'placed', 'bought 2,409,135 Yes shares for 10,000 PAT (avg 0.00) — Yes now 18%', 1, 1)`);
});
test.after(() => server.close());
async function page(u, p) { return (await fetch(base + p, { headers: u ? { "x-test-user": u } : {} })).text(); }
const between = (h, a, b) => { const i = h.indexOf(a); return i < 0 ? "" : h.slice(i, b ? h.indexOf(b, i + a.length) : undefined); };

test("banner: outcome, Pepe as AI judge, when, his reasoning with a link to the full judgement, rule, totals", async () => {
  const h = await page(null, "/markets/27");
  const ban = between(h, 'id="settlement"', 'class="opts"');
  assert.match(ban, /--oc: #e57373/, "No is red");
  assert.match(ban, /⚖ Resolved: NO/);
  assert.match(ban, /judged by 🤖 Pepe \(AI judge\)/);
  assert.match(ban, /settled \d{4}-\d\d-\d\d \d\d:\d\d UTC/);
  assert.match(ban, /never reaching \$87,000\.00[\s\S]*href="#judgement"/);
  assert.match(ban, /Each <b>No<\/b> share paid <b>1 PAT<\/b>; Yes shares are worth 0/);
  assert.match(ban, /<b>2,485,637<\/b>PAT paid out/);
  assert.match(ban, /<b>2<\/b>winning holders/);
  // the full judgement stays on the page after payout
  assert.match(h, /id="judgement">Pepe ruled <b>No<\/b> \(99% sure\)/);
  assert.match(h, /PRICE DATA \(Coinbase/);
  // the banner comes before the price bars
  assert.ok(h.indexOf('id="settlement"') < h.indexOf('class="opts"'));
});

test("no-position viewer: banner but no personal card, no settled order line", async () => {
  for (const u of [null, "u3"]) {
    const h = await page(u, "/markets/27");
    assert.match(h, /id="settlement"/);
    assert.doesNotMatch(h, /id="my-result"/);
    assert.doesNotMatch(h, /class="settle-ord"/);
  }
});

test("lost: the card says You lost, 0 paid, net −10,000 (−100%) in red, shares listed", async () => {
  const h = await page("u1", "/markets/27");
  const card = between(h, 'id="my-result"', 'href="#your-position"');
  assert.match(card, /You lost/);
  assert.match(h, /class="myres lost" id="my-result"/);
  assert.match(card, /<b>0 PAT<\/b>paid to you/);
  assert.match(card, /class="down">−10,000 \(-100%\)/);
  assert.match(card, /2,409,135 Yes shares → worth 0/);
  // the detailed table is still there, with the entry at a readable precision (0.00415, not 0.004)
  assert.match(h, /id="your-position"/);
  assert.match(h, /<td class="r">0\.00415<\/td>/);
});

test("won: the card says You won, payout and +P/L in green", async () => {
  const h = await page("u2", "/markets/27");
  assert.match(h, /class="myres won" id="my-result"/);
  const card = between(h, 'id="my-result"', 'href="#your-position"');
  assert.match(card, /🏆 Your No shares won/, "not 'You won' when the payout is less than they put in");
  assert.match(card, /<b>2,483,696 PAT<\/b>paid to you/);
  assert.match(card, /class="down">−16,304 \(-1%\)/, "a 'win' that cost more than it paid is still a net loss");
  assert.match(card, /2,483,696 No shares → paid 2,483,696 PAT/);
});

test("void: banner greyed with the reason and the person who voided it; card says refunded (≈ when scaled)", async () => {
  const h = await page("u1", "/markets/28");
  const ban = between(h, 'id="settlement"', 'class="s-stats"');
  assert.match(ban, /--oc: #9e9e9e/);
  assert.match(ban, /⚖ Voided/);
  assert.match(ban, /judged by .*ritchiecuh/);
  assert.match(ban, /Reason: parade cancelled\./);
  assert.match(ban, /scaled to 50%/);
  assert.match(h, /<b>19,600<\/b>PAT refunded/);
  assert.match(h, /class="myres refunded" id="my-result"/);
  assert.match(h, /<b>4,900 PAT<\/b>refund \(≈\)/);
  assert.match(h, /class="settle-ev void"><td colspan="7">⚖ Voided by/);
  assert.match(h, /<td class="pay">refund<\/td>[\s\S]*?≈ 14,700/);
});

test("trades: a settlement row on top, then one payout row per winner, then the trades (newest first)", async () => {
  const h = await page(null, "/markets/27");
  const tbl = between(h, "<h3>Trades</h3>", "</table>");
  const ev = tbl.indexOf('class="settle-ev won"');
  assert.ok(ev > 0, "settlement row");
  assert.match(tbl, /<td colspan="7">⚖ Settled NO by 🤖 Pepe \(AI judge\) · \d{4}-\d\d-\d\d \d\d:\d\d UTC · 2,485,637 PAT paid to 2 holders \(1 PAT per No share\)<\/td>/);
  const pays = tbl.match(/<tr class="payout">[\s\S]*?<\/tr>/g) || [];
  assert.equal(pays.length, 2);
  assert.match(pays[0], /tsyko[\s\S]*payout[\s\S]*2,483,696[\s\S]*2,483,696[\s\S]*1\.000/);
  assert.match(pays[1], /ritchiecuh[\s\S]*1,941/);
  assert.ok(tbl.indexOf('class="payout"') > ev && tbl.indexOf('class="payout"') < tbl.indexOf(">buy<"));
  // the losing Yes holder gets no payout row; tiny prices keep their digits
  assert.doesNotMatch(pays.join(""), /foamy1111/);
  assert.match(tbl, /<td class="r">0\.000437<\/td>/);
  assert.match(tbl, /<td class="r">0\.00415<\/td>/);
  assert.doesNotMatch(tbl, /<td class="r">0\.000<\/td>/);
});

test("website orders: avg re-derived, a final settled line on top; stale 'looking into' replies collapse to the result", async () => {
  const h = await page("u1", "/markets/27");
  const ord = between(h, "<h3>Your website orders</h3>", "</table>");
  assert.match(ord, /\(avg 0\.00415\)/);
  assert.doesNotMatch(ord, /avg 0\.00\)/);
  assert.ok(ord.indexOf('class="settle-ord"') > 0 && ord.indexOf('class="settle-ord"') < ord.indexOf("bought"));
  assert.match(ord, /⚖ lost — nothing paid · net −10,000/);
  const acts = between(h, "Your recent requests to Pepe", "Your website orders");
  assert.equal((acts.match(/!market ai M27/g) || []).length, 1);
  assert.doesNotMatch(acts, /looking into/);
  assert.match(acts, /Pepe has ruled: settled No/);
});

test("helpers: fmtPrice, fixOrderMessage, settledActs", () => {
  assert.equal(markets.fmtPrice(0.822), "0.822");
  assert.equal(markets.fmtPrice(1), "1.000");
  assert.equal(markets.fmtPrice(0), "0");
  assert.equal(markets.fmtPrice(10000 / 2409135), "0.00415");
  assert.equal(markets.fmtPrice(4.372e-7), "4.37e-7");
  assert.equal(markets.fixOrderMessage("bought 2,289,517 Yes shares for 1,000 PAT (avg 0.00) — Yes now 2%"),
    "bought 2,289,517 Yes shares for 1,000 PAT (avg 0.000437) — Yes now 2%");
  assert.equal(markets.fixOrderMessage("bought 1,941 No shares for 1,000 PAT (avg 0.52) — No now 51%"),
    "bought 1,941 No shares for 1,000 PAT (avg 0.52) — No now 51%");
  const acts = [{ status: "done", message: "🤖 looking into M5…" }, { status: "done", message: "ok" }];
  assert.deepEqual(markets.settledActs(acts, { settle: null }), acts, "an unsettled market keeps them");
});
