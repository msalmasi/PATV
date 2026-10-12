// 1.99th: Pepe's auto markets on the site (automkt.js + markets.cleanAuto + views/partials/mk-auto.ejs).
//   * cleanAuto keeps only the display / settle fields (https source links only, bounded spec); /api/markets/sync stores it
//   * /markets shows the 🤖 auto tag; /markets/:id shows the criteria, how it settles, the times and the source (no raw i18n keys)
//   * Pepe's status push + the admins' requests: queued, handed out once, re-offered after 5 min, acked; settings validated; admins only
//   * the feed post: one per batch, at most one every 6 h and 3 a day, whatever Pepe sends
//   NODE_PATH=G:/PATV/node_modules node --test test/automkt.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "automkt-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));

// the feed is stubbed (its own tests cover it): what the auto-markets post would create
const POSTS = [];
const stub = (name, exp) => { const p = require.resolve(path.join(repo, name)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub("pepefeed", { ensureAccount: async () => ({ userId: "pepe-id", username: "Pepe" }) });
stub("feedstore", { TITLE_MAX: 140, create: async (uid, input) => { POSTS.push({ uid, ...input }); return { id: "p" + POSTS.length, url: "/feed/p" + POSTS.length }; },
                    account: async () => ({ userId: "pepe-id" }) });
stub("contentaudit", { record: async () => {} });
const markets = require(path.join(repo, "markets"));
const A = require(path.join(repo, "automkt"));
const EN = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));

const now = Math.floor(Date.now() / 1000);
const AUTO_SPORT = { v: 1, id: "a1", cat: "sports", tag: "NFL", resolver: "sports", source_url: "https://www.espn.com/nfl/game/_/gameId/401",
  source_name: "ESPN", starts: now + 2 * 86400, resolve_at: now + 2 * 86400 + 4 * 3600,
  criteria: "Settles on the official final score on ESPN's scoreboard, overtime included. A tie is VOID.",
  spec: { league: "nfl", event_id: "401", day: "20261018", sides: ["Houston Texans", "Jacksonville Jaguars"] } };
const AUTO_PRICE = { v: 1, id: "a2", cat: "prices", tag: "Crypto", resolver: "price", source_url: "https://www.coinbase.com/price/bitcoin", source_name: "Coinbase",
  starts: now + 3 * 86400, resolve_at: now + 3 * 86400, criteria: "YES if BTC's price on Coinbase at 00:00 UTC is at or above $82,000; NO if it's below.",
  spec: { asset: "BTC", target: 82000 } };
const B = 50000;
const M7 = { id: 7, model: "lmsr", question: "Will Bitcoin (BTC) be above $82,000 at 00:00 UTC on Thu Oct 15?", options: ["yes", "no"], b: B, volume: 0,
  q: { yes: 0, no: 0 }, status: "open", creator: "pepefrog", judge: "pepefrog", room: "PepeLab", created: now - 60, closes: now + 86400,
  ai_judge: true, ai: {}, positions: {}, trades: [], history: [], auto: AUTO_PRICE };
const P8 = { id: 8, model: "pool", question: "NFL: Houston Texans at Jacksonville Jaguars — who wins? (Sun Oct 18, 9:30 AM ET)",
  options: ["Houston Texans", "Jacksonville Jaguars"], status: "open", creator: "pepefrog", judge: "pepefrog", room: "PepeLab", created: now - 60,
  closes: now + 2 * 86400 - 900, ai_judge: true, bets: [], auto: AUTO_SPORT };
const M9 = { id: 9, model: "pool", question: "An ordinary pool?", options: ["yes", "no"], status: "open", creator: "tsyko", judge: "ffjoker", room: "PATV",
  created: now - 60, closes: now + 3600, bets: [] };

let base, server;
const post = (p, body, headers = {}) => fetch(base + p, { method: "POST", headers: Object.assign({ "content-type": "application/json" }, headers), body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
const page = async (u, p) => {
  const r = await fetch(base + p, { headers: u ? { "x-test-user": u } : {}, redirect: "manual" });
  return { status: r.status, text: await r.text() };
};
const KEY = /\b(?:bx|markets|market|automkt)\.[a-z0-9_]+(?:\.[a-z0-9_]+)*\b/g;
const leaked = (h) => (h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "").match(KEY) || []).filter((k) => k in EN);

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0,
                  camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  for (const [id, name, cf, cls] of [["u1", "pb", "foamy1111", "pleb"], ["u4", "admin", "ffjoker", "Admin"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, class) VALUES (?, ?, ?, 'x', ?, ?)", [id, name, name, cf, cls]);
  }
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  app.use((req, res, next) => (req.path === "/api/automkt/sync" ? next() : express.json()(req, res, next)));
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  const opts = { isBotToken: (t) => t === "bot-token", addUser };
  markets.register(app, opts);
  A.register(app, opts);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  assert.equal((await post("/api/markets/sync", { password: "bot-token", markets: [M7, P8, M9] })).status, 200);
});
test.after(() => server.close());

test("cleanAuto: only the display / settle fields; https links only; bounded spec; unknown categories dropped", () => {
  const a = markets.cleanAuto(Object.assign({}, AUTO_SPORT, { extra: "x", source_url: "javascript:alert(1)", spec: { big: "x".repeat(3000) } }));
  assert.equal(a.extra, undefined);
  assert.equal(a.source_url, null);
  assert.deepEqual(a.spec, {});
  assert.equal(markets.cleanAuto({ cat: "elections" }), null);
  assert.equal(markets.cleanAuto(null), null);
  assert.equal(markets.cleanAuto(Object.assign({}, AUTO_PRICE, { resolver: "nope" })).resolver, "ai");
  const m = markets.cleanMarket(M7);
  assert.equal(m.auto.cat, "prices");
  assert.equal(m.auto.source_url, "https://www.coinbase.com/price/bitcoin");
  assert.equal(markets.cleanMarket(M9).auto, undefined);
});

test("/markets: the 🤖 auto tag on auto markets only; the market page explains how it settles", async () => {
  const h = (await page("u1", "/markets")).text;
  assert.match(h, /🤖<\/span> auto · Prices/);
  assert.match(h, /🤖<\/span> auto · Sports/);
  assert.deepEqual(leaked(h), []);
  const m7 = (await page("u1", "/markets/7")).text;
  assert.match(m7, /class="mk-auto"/);
  assert.match(m7, /Pepe made this one/);
  assert.match(m7, /YES if BTC&#39;s price on Coinbase at 00:00 UTC is at or above \$82,000/);
  assert.match(m7, /exchange price data at the resolution time/);
  assert.match(m7, /href="https:\/\/www.coinbase.com\/price\/bitcoin" target="_blank" rel="noopener nofollow">Coinbase<\/a>/);
  assert.match(m7, /no cash value/);
  assert.deepEqual(leaked(m7), []);
  const p8 = (await page("u1", "/markets/8")).text;
  assert.match(p8, /class="mk-auto"/);
  assert.match(p8, /official final score on ESPN/);
  assert.match(p8, /Event starts/);
  assert.deepEqual(leaked(p8), []);
  const m9 = (await page("u1", "/markets/9")).text;
  assert.doesNotMatch(m9, /class="mk-auto"/);
  assert.ok(!/money/i.test((m7 + p8).replace(/<script[\s\S]*?<\/script>/g, "")), "PAT is points: the copy never says money");
});

test("Pepe's status push + the admins' requests: queued, handed out once, re-offered after 5 min, acked", async () => {
  const st = { cfg: { enabled: false, per_week: 5 }, week: { count: 0, target: 5 }, review: [], items: [], runs: [], sources: [] };
  assert.equal((await post("/api/automkt/sync", { password: "nope", status: st })).status, 403);
  let r = await post("/api/automkt/sync", { password: "bot-token", status: st });
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.requests, []);
  // admins only, same-site JSON
  assert.equal((await post("/api/admin/automkt", { action: "generate" }, { "x-test-user": "u1" })).status, 403);
  assert.equal((await post("/api/admin/automkt", { action: "explode" }, { "x-test-user": "u4" })).status, 400);
  assert.equal((await post("/api/admin/automkt", { action: "set", args: { cfg: { bogus: 1 } } }, { "x-test-user": "u4" })).status, 400);
  assert.equal((await post("/api/admin/automkt", { action: "approve", args: { id: "'; drop" } }, { "x-test-user": "u4" })).status, 400);
  r = await post("/api/admin/automkt", { action: "set", args: { cfg: { enabled: true, per_week: "7", review: "all", cats: { news: false, x: true }, junk: 1 } } }, { "x-test-user": "u4" });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.state.cfg.per_week, 5);                        // Pepe's last push - unchanged until he applies it
  await post("/api/admin/automkt", { action: "generate", args: { n: 99 } }, { "x-test-user": "u4" });
  r = await post("/api/automkt/sync", { password: "bot-token", status: st });
  assert.equal(r.body.requests.length, 2);
  assert.deepEqual(r.body.requests[0].args, { cfg: { enabled: true, per_week: 7, review: "all", cats: { news: false } } });
  assert.equal(r.body.requests[0].by, "admin");
  assert.deepEqual(r.body.requests[1].args, { n: 10, force: true });
  assert.deepEqual((await post("/api/automkt/sync", { password: "bot-token" })).body.requests, [], "handed out once");
  const real = Date.now;
  A._setClock(() => real() + 6 * 60e3);
  assert.equal((await post("/api/automkt/sync", { password: "bot-token" })).body.requests.length, 2, "re-offered after 5 min without an ack");
  A._setClock(null);
  for (const q of r.body.requests) assert.equal((await post("/api/automkt/ack", { password: "bot-token", id: q.id, ok: true, message: "done" })).body.ok, true);
  A._setClock(() => real() + 12 * 60e3);
  assert.deepEqual((await post("/api/automkt/sync", { password: "bot-token" })).body.requests, [], "acked = done");
  A._setClock(null);
  const s = await A.adminState();
  assert.equal(s.requests[0].status, "done");
  assert.equal(s.online, true);
  const pg = await page("u4", "/admin/markets");
  assert.equal(pg.status, 200);
  assert.match(pg.text, /Auto markets/);
  assert.match(pg.text, /admin-automkt\.js/);
  assert.equal((await page("u1", "/admin/markets")).status, 302);
});

test("the feed post: one per batch, at most one every 6 h and 3 a day", async () => {
  const items = [{ ref: "M7", id: 7, question: M7.question, options: ["yes", "no"], closes: now + 86400, cat: "prices", tag: "Crypto", model: "lmsr" },
                 { ref: "M8", id: 8, question: P8.question, options: P8.options, closes: P8.closes, cat: "sports", tag: "NFL", model: "pool" }];
  assert.equal((await post("/api/automkt/announce", { password: "x", items })).status, 403);
  let r = await post("/api/automkt/announce", { password: "bot-token", items });
  assert.equal(r.body.posted, true, JSON.stringify(r.body));
  assert.equal(POSTS.length, 1);
  assert.match(POSTS[0].title, /2 new auto markets/);
  assert.match(POSTS[0].body, /M7: Will Bitcoin/);
  assert.match(POSTS[0].body, /\/markets\/8/);
  assert.match(POSTS[0].body, /no cash value/);
  assert.doesNotMatch(POSTS[0].body, /&#39;|&amp;/, "plain text, not HTML-escaped");
  assert.equal(POSTS[0].community, "patv:lounge");
  r = await post("/api/automkt/announce", { password: "bot-token", items: items.slice(0, 1) });
  assert.equal(r.body.posted, false);
  assert.match(r.body.skipped, /too soon/);
  const real = Date.now;
  let t = real();
  A._setClock(() => t);
  for (let i = 0; i < 3; i++) { t += 6 * 3600e3 + 1000; await post("/api/automkt/announce", { password: "bot-token", items: items.slice(0, 1) }); }
  A._setClock(null);
  assert.equal(POSTS.length, 3, "the daily cap (3 in 24 h) holds");
  assert.equal((await post("/api/automkt/announce", { password: "bot-token", items: [] })).status, 400);
});
