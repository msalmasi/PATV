// Settled share markets (1.99do): once Pepe has paid a market out, the page shows the result, not the
// last trading price. A winning row reads Now 1.000 / "Paid N PAT" / P/L = payout - cost; a losing row
// reads Now 0 / 0 / -cost / Lost; a void shows each holder's refund. The outcome bars show the
// winner at 100% with a trophy and the loser at 0%, with the last trading prices noted once. Open
// markets are unchanged, and a paid-out market never shows up as an open position in /wallet.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "market-settled-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const markets = require(path.join(repo, "markets"));
const wallet = require(path.join(repo, "wallet"));

const B = 50000;
const now = Date.now() / 1000;
const pos = (nick, shares, cost) => ({ nick, shares, cost });
// M27 as it was on prod: last traded Yes 0.178 / No 0.822, settled No, 2,485,637 PAT paid to the two No holders
const M27 = {
  id: 27, model: "lmsr", question: "Will Bitcoin hit $87,000 today?", options: ["Yes", "No"], b: B, volume: 2500000,
  q: { Yes: 0, No: B * Math.log(0.822 / 0.178) }, status: "settled", result: "No", settled_by: "pepefrog",
  creator: "pepefrog", judge: "pepefrog", room: "PATV", created: now - 86400, closes: now - 3600, ended: now - 600,
  paid_out: { at: now - 600, total: 2485637, result: "No" },
  positions: {
    foamy1111: pos("foamy1111", { Yes: 2409135, No: 0 }, { Yes: 10000, No: 0 }),
    nohold1: pos("nohold1", { Yes: 0, No: 1500000.4 }, { Yes: 0, No: 900000 }),
    nohold2: pos("nohold2", { Yes: 0, No: 985637.3 }, { Yes: 0, No: 600000 }),
    hedger: pos("hedger", { Yes: 1000, No: 2000.9 }, { Yes: 300, No: 1500 }),
  },
  trades: [{ ts: now - 5000, nick: "foamy1111", side: "buy", option: "Yes", shares: 2409135, pat: 10000 }],
  history: [[now - 86400, { Yes: 0.5, No: 0.5 }], [now - 3600, { Yes: 0.178, No: 0.822 }]],
};
// a void: holders had 10,000 + 30,000 in (98% net of fees = 39,200 owed), the pot after the seed paid 19,600 (half)
const M28 = {
  id: 28, model: "lmsr", question: "Will it rain on the parade?", options: ["Yes", "No"], b: B, volume: 40000,
  q: { Yes: 0, No: 0 }, status: "void", result: "void", void_reason: "parade cancelled",
  creator: "pepefrog", judge: "pepefrog", room: "PATV", created: now - 86400, closes: now - 3600, ended: now - 500,
  paid_out: { at: now - 500, total: 19600, result: "void" },
  positions: {
    foamy1111: pos("foamy1111", { Yes: 15000, No: 0 }, { Yes: 10000, No: 0 }),
    other: pos("other", { Yes: 0, No: 50000 }, { Yes: 0, No: 30000 }),
  },
  trades: [], history: [],
};
// still trading: unchanged live view
const M29 = {
  id: 29, model: "lmsr", question: "Will Pepe sing tonight?", options: ["Yes", "No"], b: B, volume: 10000,
  q: { Yes: B * Math.log(3), No: 0 }, status: "open", result: null,
  creator: "pepefrog", judge: "pepefrog", room: "PATV", created: now - 3600, closes: now + 86400,
  positions: { foamy1111: pos("foamy1111", { Yes: 20000, No: 0 }, { Yes: 10000, No: 0 }) },
  trades: [], history: [],
};

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0,
                  camfrogUsername TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  for (const [id, name, cf] of [["u1", "pb", "foamy1111"], ["u2", "nohold1", "nohold1"], ["u3", "hedger", "hedger"]]) {
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
  wallet.register(app, { isBotToken: (t) => t === "bot-token", addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  const r = await fetch(base + "/api/markets/sync", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "bot-token", markets: [M27, M28, M29] }) });
  assert.equal(r.status, 200);
});
test.after(() => server.close());
const page = async (u, p) => (await fetch(base + p, { headers: u ? { "x-test-user": u } : {} })).text();
const row = (h, label) => { const m = h.match(new RegExp(`<tr class="(won|lost|refunded)"><td><b>${label}</b></td>([\\s\\S]*?)</tr>`)); return m && m[0]; };

test("the sync keeps Pepe's paid_out stamp and void reason", async () => {
  const d = JSON.parse((await getQuery("SELECT data FROM markets WHERE id = 27"))[0].data);
  assert.deepEqual(d.paid_out, { at: M27.paid_out.at, total: 2485637, result: "No" });
  const v = JSON.parse((await getQuery("SELECT data FROM markets WHERE id = 28"))[0].data);
  assert.equal(v.void_reason, "parade cancelled");
});

test("settled No: the Yes holder's row is Lost, worth 0, P/L = -cost (no more 'value 428,797')", async () => {
  const h = await page("u1", "/markets/27");
  assert.match(h, /Settled <b>No<\/b>: No shares paid 1 PAT each; Yes shares are worth 0\./);
  const r = row(h, "Yes");
  assert.ok(r, "a Yes row");
  assert.match(r, /class="lost"/);
  assert.match(r, /2,409,135/);
  assert.match(r, /<td class="r">0<\/td>/, "Now 0");
  assert.match(r, /−10,000 \(-100%\)/);
  assert.match(r, /<td>Lost<\/td>/);
  assert.doesNotMatch(h, /428,797|418,797|4188%/);
  assert.doesNotMatch(h, /0\.178<\/td>/);
  assert.doesNotMatch(h, /action="\/markets\/27\/sell"/, "no Sell button");
});

test("settled No: the No holder's row reads Now 1.000, Paid N PAT, P/L = payout - cost", async () => {
  const h = await page("u2", "/markets/27");
  const r = row(h, "No");
  assert.ok(r);
  assert.match(r, /class="won"/);
  assert.match(r, /<td class="r">1\.000<\/td>/);
  assert.match(r, /Paid 1,500,000 PAT/);
  assert.match(r, /\+600,000 \(67%\)/);
  assert.match(r, /🏆 Won/);
});

test("someone holding both sides gets one won and one lost row", async () => {
  const h = await page("u3", "/markets/27");
  assert.match(row(h, "No"), /Paid 2,000 PAT[\s\S]*\+500/);
  assert.match(row(h, "Yes"), /−300 \(-100%\)[\s\S]*Lost/);
});

test("the bars show the result (No 100% with the trophy, Yes 0%) and the last trade once", async () => {
  const h = await page(null, "/markets/27");
  assert.match(h, /🏆 <b>No<\/b><\/div>\s*<div class="bar"><span style="width: 100%/);
  assert.match(h, /<b>Yes<\/b><\/div>\s*<div class="bar"><span style="width: 0%/);
  assert.match(h, /<span class="price">100%<\/span> · paid 1 PAT\/share/);
  assert.match(h, /<span class="price">0%<\/span> · worth 0/);
  assert.equal((h.match(/last traded 18\/82/g) || []).length, 1);
  assert.doesNotMatch(h, /<span class="price">18%/);
  assert.match(h, /each No share paid 1 PAT \(2,485,637 PAT paid out\)/);
});

test("void: each row shows the refund (cost net of the 2% fee, scaled to what the pot paid)", async () => {
  const h = await page("u1", "/markets/28");
  assert.match(h, /Voided \(parade cancelled\)/);
  assert.match(h, /scaled to 50%/);
  const r = row(h, "Yes");
  assert.ok(r);
  assert.match(r, /Refunded 4,900 PAT/);   // 10,000 × 0.98 × 0.5
  assert.match(r, /−5,100/);
  assert.match(r, /<td class="r">—<\/td>/);
  assert.match(h, /void · refunded/);
});

test("open markets are unchanged: live price, value, sell button", async () => {
  const h = await page("u1", "/markets/29");
  assert.match(h, /<span class="price">75%<\/span>/);
  assert.match(h, /<td class="r">0\.750<\/td>/);
  assert.match(h, /<td class="r">15,000<\/td>/);
  assert.match(h, /\+5,000 \(50%\)/);
  assert.match(h, /action="\/markets\/29\/sell"/);
  assert.doesNotMatch(h, /settled-line|Final result/);
});

test("the markets list: settled card shows 100/0 with the last trade, void is greyed, open is live", async () => {
  const h = await page(null, "/markets");
  const card = (id) => h.slice(h.indexOf(`href="/markets/${id}"`), h.indexOf("</a>", h.indexOf(`href="/markets/${id}"`)));
  assert.match(card(27), /settled: No/);
  assert.match(card(27), /<b>100%<\/b> · paid 1 PAT\/share · last 82%/);
  assert.match(card(27), /<b>0%<\/b> · worth 0 · last 18%/);
  assert.match(card(28), /void · refunded/);
  assert.match(card(29), /<b>75%<\/b> · 0\.75 PAT\/share/);
});

test("wallet: paid-out markets are not open positions; they're listed as settled with what they paid", async () => {
  const h = await page("u1", "/wallet");
  const open = h.slice(h.indexOf("MY MARKET POSITIONS"), h.indexOf("Settled in the last 30 days"));
  assert.match(open, /M29/);
  assert.doesNotMatch(open, /M27|M28/);
  const settled = h.slice(h.indexOf("Settled in the last 30 days"));
  assert.match(settled, /M27[\s\S]*Yes[\s\S]*<td class="r">0<\/td>[\s\S]*-10,000[\s\S]*Lost/);
  assert.match(settled, /M28[\s\S]*4,900 PAT[\s\S]*Refunded \(void\)/);
});

test("a market still 'settling' but already stamped paid_out counts as settled", () => {
  const v = markets.view({ ...M27, status: "settling" }, ["nohold2"]);
  assert.equal(v.settle.kind, "won");
  assert.equal(v.mine[0].payout, 985637);
  assert.equal(v.mine[0].state, "won");
  assert.equal(markets.view({ ...M27, status: "closed", paid_out: null }, ["foamy1111"]).settle, null);
});
