// Market times + price evidence (1.99jx, after M49): the market page and the /markets cards show when a market
// opened and when it closes / closed (and when Pepe ruled / it settled) as <time> tags the page rewrites in the
// viewer's own time zone (UTC on hover); a "next 24 hours" question gets its window spelled out; Pepe's exchange
// price check (source, the window's HIGH / LOW and when, the rule used) shows in the judgement section.
// Times come from tz.js: the browser's zone (patv_tz cookie) here, UTC without one, always with the zone's label.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "market-times-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const cookieParser = require("cookie-parser");
const tz = require(path.join(repo, "tz"));
const { runQuery } = require(path.join(repo, "dbUtils"));
const markets = require(path.join(repo, "markets"));

const B = 50000;
const now = Date.now() / 1000;
const pos = (nick, shares, cost) => ({ nick, shares, cost });
const CREATED = 1791568375, CLOSES = 1791654775;           // M49 on prod: Fri Oct 9 17:52:55 UTC -> Sat Oct 10 17:52:55 UTC
// M49-shaped, as the fixed judge would leave it (proposed Yes from Coinbase candles)
const M49 = {
  id: 49, model: "lmsr", question: "Will Bitcoin climb back to $83,000 USD in the next 24 hours?", options: ["Yes", "No"],
  b: B, volume: 800000, q: { Yes: 600000, No: 400000 }, status: "closed", result: null,
  creator: "ritchiecuh", judge: "pepefrog", room: "DRAMA_CENTRAL", created: CREATED, closes: CLOSES, ai_judge: true,
  ai: { state: "proposed", result: "Yes", confidence: 0.99, at: CLOSES + 900, until: now + 3000,
        reason: "BTC hit $83,093.39 at 2026-10-10 17:30 UTC, at/above $83,000.00 (Coinbase data).",
        evidence: "PRICE DATA (Coinbase, 1-min candles ...)",
        price: { symbol: "BTC", target: 83000, direction: "up", mode: "touch", start: CREATED, end: CLOSES, source: "Coinbase",
                 gran: 60, candles: 1440, covered: true, high: 83093.39, high_at: 1791653880, low: 82198, low_at: 1791575460,
                 last: 82567.1, cov_start: CREATED, cov_end: CLOSES, used: "up" } },
  positions: { foamy1111: pos("foamy1111", { Yes: 138126, No: 0 }, { Yes: 60000, No: 0 }) },
  trades: [], history: [],
};
// still open, a question with no relative window
const M50 = {
  id: 50, model: "lmsr", question: "Will Pepe sing at the party?", options: ["Yes", "No"], b: B, volume: 1000,
  q: { Yes: 0, No: 0 }, status: "open", result: null, creator: "pepefrog", judge: "someone", room: "PATV",
  created: now - 600, closes: now + 3 * 3600 + 12 * 60 + 30, positions: {}, trades: [], history: [],
};
// an unreadable price question Pepe handed to the admins
const M51 = {
  id: 51, model: "lmsr", question: "Will Bitcoin be worth $83,000 tomorrow?", options: ["Yes", "No"], b: B, volume: 1000,
  q: { Yes: 0, No: 0 }, status: "closed", result: null, creator: "pepefrog", judge: "pepefrog", room: "PATV",
  created: now - 2 * 86400, closes: now - 86400, ai_judge: true,
  ai: { state: "unsure", escalated: now - 60, tries: 1, reason: "a price question Pepe couldn't read", price_unread: true },
  positions: {}, trades: [], history: [],
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
  app.use(cookieParser());
  app.use(tz.middleware(() => null));
  markets.register(app, { isBotToken: (t) => t === "bot-token", addUser: (req, res, next) => { req.user = null; next(); } });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  const r = await fetch(base + "/api/markets/sync", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "bot-token", markets: [M49, M50, M51] }) });
  assert.equal(r.status, 200);
});
test.after(() => server.close());
const page = async (p, zone) => (await fetch(base + p, { headers: zone ? { cookie: "patv_tz=" + encodeURIComponent(zone) } : {} })).text();
const at = (ts) => `<time datetime="${new Date(ts * 1000).toISOString()}" data-tz="[a-z]+" title="${new Date(ts * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC">`;

test("M49 in New York: opened / closed / Pepe ruled with the zone's label, and the 24-hour window spelled out", async () => {
  const h = await page("/markets/49", "America/New_York");
  assert.match(h, new RegExp("Opened " + at(CREATED) + "Fri, Oct 9, 1:52 PM EDT</time>"));
  assert.match(h, new RegExp("Closed " + at(CLOSES) + "Sat, Oct 10, 1:52 PM EDT</time>"));
  assert.match(h, new RegExp("Pepe ruled " + at(CLOSES + 900) + "Sat, Oct 10, 2:07 PM EDT</time>"));
  assert.match(h, new RegExp('class="mk-t-win">Window: ' + at(CREATED) + "Fri, Oct 9, 1:52 PM EDT</time> → " + at(CLOSES) + "Sat, Oct 10, 1:52 PM EDT</time>"));
  assert.match(h, /Times are in your time zone/);
  assert.match(h, /<script src="\/public\/js\/localtime\.js\?v=\d+"><\/script>/, "the browser re-localises the tags");
});

test("without a zone the times are UTC - and say so", async () => {
  const h = await page("/markets/49");
  assert.match(h, new RegExp("Opened " + at(CREATED) + "Fri, Oct 9, 5:52 PM UTC</time>"));
  assert.match(h, new RegExp("Closed " + at(CLOSES) + "Sat, Oct 10, 5:52 PM UTC</time>"));
  const bad = await page("/markets/49", "Not/AZone");
  assert.match(bad, /Fri, Oct 9, 5:52 PM UTC<\/time>/, "an unknown cookie zone falls back to UTC");
});

test("M49: the judgement shows the price check - source, HIGH and LOW with times, target, and the touch rule", async () => {
  const h = await page("/markets/49", "Europe/London");
  assert.match(h, new RegExp("Price check \\(Coinbase, 1-minute candles\\): BTC HIGH \\$83,093\\.39 at " + at(1791653880) + "Oct 10, 6:38 PM GMT\\+1</time>"));
  assert.match(h, new RegExp("LOW \\$82,198\\.00 at " + at(1791575460) + "[^<]+</time>; target \\$83,000\\.00\\."));
  assert.match(h, /A reach\/hit question is Yes if the price touched the target at any moment in the window/);
  assert.doesNotMatch(h, /PRICE DATA \(Coinbase, 1-min candles \.\.\.\)/, "the structured check replaces the raw line");
});

test("an open market: Closes <time> (in 3h 12m), no window line for a question without one", async () => {
  const h = await page("/markets/50");
  assert.match(h, /Trading open/);
  assert.doesNotMatch(h, /closes [A-Z][a-z]{2}, \d\d [A-Z][a-z]{2} \d{4}/, "no more toUTCString()");
  assert.match(h, /Closes <time [^>]*>[^<]* UTC<\/time> \(in 3h 1[12]m\)/);
  assert.doesNotMatch(h, /class="mk-t-win"/);
});

test("an unreadable price question says an admin settles it from the chart", async () => {
  const h = await page("/markets/51");
  assert.match(h, /Pepe couldn’t read this price question, so an admin settles it from the price chart\./);
});

test("the /markets cards carry the compact times", async () => {
  const h = await page("/markets", "Asia/Tokyo");
  assert.match(h, new RegExp('class="mk-times compact">\\s*<span class="mk-t-line">Opened ' + at(CREATED) + "Sat, Oct 10, 2:52 AM GMT\\+9</time>"));
  assert.match(h, /Closes <time [^>]*>[^<]*<\/time> \(in 3h 1[12]m\)/);
});
