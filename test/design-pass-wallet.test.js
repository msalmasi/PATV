// 1.99lx design pass - /wallet, /history and /economy render with every function they had before:
//   wallet: balance up front, quick actions (send/tip, history, subscriptions, Support PATV), recent activity, every /act
//           form (stash, loans, Reserve, donate) and the anchors other pages link to (#admin-requests ...)
//   history: periods, categories with totals, staff lookup, counterparty links (archived = not linked), notes,
//            the "Balance carried over" ledger rows (marked as adjustments), pages, grouped by day
//   economy: the live section (supply, Fed band, where PAT sits, incentive groups incl. Activity rewards, vaults,
//            supply history charts + table) from econpage.js, and the guide below it
//   node --test test/design-pass-wallet.test.js      (needs the repo's node_modules; temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "design-wallet-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
const ejs = require("ejs");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const opts = { views: [path.join(repo, "views")] };
const ul = (n) => '<a href="/u/' + encodeURIComponent(n) + '">' + String(n).replace(/[<>&"]/g, "") + "</a>";

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0,
                  camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS transactions (transactionId INTEGER PRIMARY KEY AUTOINCREMENT, userId TEXT, type TEXT, points INTEGER,
                  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS bonus_winners (id INTEGER PRIMARY KEY AUTOINCREMENT, transactionId INTEGER, type TEXT)`);
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername, level, points_balance) VALUES ('u1','alice','alice','x','Admin','AliceCF',12,1234567)");
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, level, points_balance) VALUES ('u2','bob','bob','x','bobcf',3,10)");
  await runQuery("INSERT INTO transactions (userId, type, points) VALUES ('u1', 'Reward: Gold Spin', 25000)");
  await runQuery("INSERT INTO transactions (userId, type, points) VALUES ('u1', 'ledger-correction', 777)");
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  app.use(express.json());
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  require(path.join(repo, "wallet")).register(app, { isBotToken: (t) => t === "bot", addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot" }, body)) });
  await post("/api/wallet/stashes", { stashes: [{ id: 1, name: "savings", owner: "AliceCF", members: ["bobcf"], balance: 50000, staked: 0 }] });
  await post("/api/wallet/loans", { loans: [{ id: 4, lender: "bobcf", borrower: "AliceCF", principal: 1000, rate: 5, term: 86400, owed: 1050, paid: 0, status: "active", due: Date.now() / 1000 + 3600 }],
    requests: [], reserve: { rate_week: 0.03, max_days: 30, enabled: true, book: 0, room: 2500000, base: 10000, per_level: 2000, max_auto: 250000, max_open: 1, min: 1000 } });
});
test.after(() => server.close());

test("/wallet: balance up front, quick actions, recent activity and every form it had", async () => {
  const html = await (await fetch(base + "/wallet", { headers: { "x-test-user": "u1" } })).text();
  assert.match(html, /<h1 id="wlH" class="bal ds-pat xl"><b>1,234,567<\/b> <span>PAT<\/span><\/h1>/);
  for (const href of ['href="#send"', 'href="/history"', 'href="/subscriptions"', 'href="/support"', 'href="/u/alice/tip"']) assert.ok(html.includes(href), href);
  assert.match(html, /id="activity"[\s\S]*Recent activity[\s\S]*Won 25,000 PAT on the gold wheel/);
  assert.match(html, /<form class="card" id="send" method="get" action="\/search"/, "send/tip works without JS too (search)");
  // the forms post the same commands as before
  for (const cmd of ["stash", "loan", "donate"]) assert.match(html, new RegExp('name="cmd" value="' + cmd + '"'), cmd);
  for (const a0 of ["deposit", "stake", "create", "repay", "reserve", "request", "grant"]) assert.ok(html.includes('value="' + a0 + '"'), a0);
  for (const id of ["lend", "reserve-request", "credit", "donate", "admin-requests", "admin-book", "admin-stashes", "stashes", "staking", "loans", "reserve", "positions"]) assert.ok(html.includes('id="' + id + '"'), id);
  assert.match(html, /How stashes and staking work/);
  // signed out: the sign-in prompt, no forms
  const out = await (await fetch(base + "/wallet")).text();
  assert.match(out, /to see your wallet/);
  assert.doesNotMatch(out, /name="cmd"/);
});

test("/history: every filter, link and ledger row, grouped by day", async () => {
  const history = require(path.join(repo, "history"));
  const items = [
    { timestamp: "2026-10-11 10:00:00", rawType: "tip sent", points: -500, cat: "tips", icon: "💸", text: "Tipped", cpPrep: "", cp: { name: "bob", title: "Camfrog: bobcf", alt: "bobcf", archived: false }, note: "for the song" },
    { timestamp: "2026-10-11 09:00:00", rawType: "tip received", points: 200, cat: "tips", icon: "💰", text: "Tip from", cpPrep: "", cp: { name: "ghost", title: "PAT account only", alt: null, archived: true } },
    { timestamp: "2026-10-09 09:00:00", rawType: "ledger-correction", points: 1234, ...history.describe({ type: "ledger-correction", points: 1234 }) },
  ];
  const data = { totals: { tips: { label: "💸 Tips", in: 200, out: 500, n: 2 }, admin: { label: "🛠️ Admin & other", in: 1234, out: 0, n: 1 } }, items, page: 2, pages: 3, count: 3 };
  const html = await ejs.renderFile(path.join(repo, "views", "history.ejs"),
    { user: "alice", canLookup: true, period: "30d", cat: "tips", target: "alice", targetId: { title: "Camfrog: AliceCF", alt: "AliceCF" }, own: true, data, error: null }, opts);
  for (const p of ["7d", "30d", "90d", "all"]) assert.ok(html.includes("period=" + p), p);
  assert.match(html, /class="on" href="\/history\?user=alice&amp;period=30d&amp;cat=&amp;page=1"|class="on" href="\/history\?user=alice&amp;period=30d/);
  assert.match(html, /cat=tips&amp;page=1"[^>]*>💸 Tips <span class="mut">\(2\)<\/span>/);
  assert.match(html, /<form class="look" method="get" action="\/history"/, "staff lookup");
  assert.match(html, /<a class="cp" href="\/u\/bob" title="Camfrog: bobcf">bob<\/a> <span class="mut">\(bobcf\)<\/span>/);
  assert.match(html, /<span class="cp" title="PAT account only">ghost<\/span>/, "an archived account is named, not linked");
  assert.match(html, /&ldquo;for the song&rdquo;/);
  assert.match(html, /class="row2 adj"[\s\S]*Balance carried over from before the full history[\s\S]*Ledger adjustment[\s\S]*\+1,234/);
  assert.equal((html.match(/class="daycard"/g) || []).length, 2, "grouped by day");
  assert.match(html, /page=1" rel="prev">← newer<\/a>/);
  assert.match(html, /page=3" rel="next">older →<\/a>/);
  assert.match(html, /page 2 \/ 3/);
  assert.match(html, /id="hxFind"/);
  // signed out / errors still render
  const err = await ejs.renderFile(path.join(repo, "views", "history.ejs"),
    { user: null, canLookup: false, period: "30d", cat: null, target: null, targetId: null, own: false, data: null, error: "Log in to see your PAT history." }, opts);
  assert.match(err, /role="alert">Log in to see your PAT history\./);
});

test("/economy: the live section from econpage.js, and the guide still there", async () => {
  const P = require(path.join(repo, "econpage"));
  const rows = [];
  for (let i = 0; i < 10; i++) rows.push({ day: "2026-10-0" + i, total: 500e6 + i * 1e6, fed: 80e6 + i, band: { fed: 80e6, floor: 50e6, ceiling: 150e6 },
                                           mints: i === 3 ? { donation: 2500000 } : {}, burns: i === 5 ? 400000 : 0 });
  const hist = P.series(rows);
  assert.equal(hist[3].minted, 2500000);
  assert.equal(hist[5].burned, 400000);
  const live = { supply: { total: 509e6, circulating: 509e6, burned: { total: 400000 }, layers: [{ key: "players", label: "👛 Players", blurb: "wallets", amount: 400e6 }, { key: "fed", label: "🏛️ Federal Reserve", blurb: "x", amount: 80e6 }], updated: "2026-10-11 06:00:00" },
                 pools: { jackpot: 16e6, "vault:heist": 6e6, "vault:lotto": 7e6, "vault:bank": 5e6, "vault:mm": 1e6 }, fed: 80000009, band: { floor: 50e6, ceiling: 150e6 },
                 incentives: { balance: 18e6, budgets: { activity: 12350000, welcome: 1500000 }, remaining: { activity: 12350000, welcome: 900000 }, share: null },
                 fortknox: 9e6, history: hist, month: { minted: 2500000, burned: 400000, change: 0.018 } };
  const html = await ejs.renderFile(path.join(repo, "views", "economy.ejs"), { user: null, treasury: null, roomVaults: null, live, ogBase: "http://t" }, opts);
  assert.match(html, /Total supply<\/span><b>509,000,000<\/b>/);
  assert.match(html, /inside its band right now/);
  assert.match(html, /The Fed holds 80,000,009 PAT/);
  assert.match(html, /Activity rewards/);
  assert.match(html, /900k of 1\.5M left/);
  for (const v of ["Fort Knox", "Casino vault", "Lotto pot", "The House"]) assert.ok(html.includes(v), v);
  assert.match(html, /id="supply-history"/);
  assert.match(html, /<polyline points="[0-9., ]+" fill="none" stroke="#e0a830"/);
  assert.match(html, /<td>2026-10-09<\/td><td class="n">509,000,000<\/td>/);
  // the guide below is intact (the treasury-off copy, the pad cosmetics line, the burn log)
  assert.match(html, /Coming soon/);
  assert.match(html, /id="burnLog"/);
  assert.match(html, /the bank job cracks <b>Fort Knox<\/b>/);
  // nothing reported yet: no live section, no crash
  const bare = await ejs.renderFile(path.join(repo, "views", "economy.ejs"), { user: null, treasury: null, roomVaults: null, ogBase: "http://t" }, opts);
  assert.doesNotMatch(bare, /id="live"/);
  assert.match(bare, /What PAT is/);
});
