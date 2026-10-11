// 1.99ly design pass: /markets, /markets/:id, /wagers, /polls, /bounties and /bounties/:id render with the shared
// bets.css look, keep every form / route / command they had, and print no raw i18n keys (English and another language).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bets-design-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const markets = require(path.join(repo, "markets"));
const wagers = require(path.join(repo, "wagers"));
const polls = require(path.join(repo, "polls"));
const bounties = require(path.join(repo, "bounties"));
const i18n = require(path.join(repo, "i18n"));
const EN = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));

const now = Date.now() / 1000, B = 50000;
const M1 = {
  id: 1, model: "lmsr", question: "Will BTC close above $90,000 on Friday?", options: ["Yes", "No"], b: B, volume: 1843200,
  q: { Yes: B * 0.9, No: B * 0.4 }, status: "open", creator: "ritchiecuh", judge: "pepefrog", room: "PATV",
  created: now - 86400, closes: now + 3 * 3600, ai_judge: true, ai: { state: null },
  positions: { foamy1111: { nick: "foamy1111", shares: { Yes: 24091, No: 0 }, cost: { Yes: 10000, No: 0 } } },
  trades: [{ ts: now - 5000, nick: "foamy1111", side: "buy", option: "Yes", shares: 24091, pat: 10000, web: true }],
  history: [[now - 86400, { Yes: 0.5, No: 0.5 }], [now - 3600, { Yes: 0.6, No: 0.4 }]],
};
const M3 = { id: 3, model: "lmsr", question: "Closed one?", options: ["Yes", "No"], b: B, volume: 1000, q: { Yes: 0, No: 0 }, status: "closed",
  creator: "tsyko", judge: "ffjoker", room: "PATV", created: now - 9000, closes: now - 60, positions: {}, trades: [], history: [] };
const P5 = { id: 5, model: "pool", question: "Will Brian cam tonight?", options: ["yes", "no"], status: "open", creator: "tsyko", judge: "ffjoker",
  room: "PATV", created: now - 3600, closes: now + 5 * 3600, bets: [{ nick: "tsyko", option: "no", amount: 12000, ts: now - 2000 }] };
const W = [
  { id: 11, creator: "tsyko", opponent: "foamy1111", judge: "ffjoker", amount: 10000, terms: "Lakers win tonight", room: "PATV", status: "offered", created: now - 60, offer_until: now + 540, deadline: now + 2 * 86400 },
  { id: 12, creator: "ritchiecuh", opponent: "sard0nicgrin", judge: "foamy1111", amount: 25000, terms: "Chess", room: "PATV", status: "active", created: now - 7200, deadline: now + 86400 },
  { id: 9, creator: "tsyko", opponent: "ritchiecuh", judge: "ffjoker", amount: 4000, terms: "ribbit", room: "PATV", status: "won", winner: "tsyko", settled_by: "ffjoker", ended: now - 86400 },
];
const POLLS = [
  { id: "p3", question: "Next costume?", options: ["Pirate", "Wizard"], votes: { 0: ["tsyko"], 1: ["foamy1111", "x"] }, creator: "ffjoker", status: "active", created_at: "2026-10-11 01:00:00" },
  { id: "p2", question: "Trivia night?", options: ["Friday", "Saturday"], votes: { 0: ["a", "b"], 1: [] }, creator: "sard0nicgrin", status: "ended", created_at: "2026-10-09 20:00:00" },
];
const BOUNTIES = [
  { id: 1, creator: "tsyko", task: "Get Brian on cam", room: "PATV", status: "open", created: now - 7200, deadline: now + 2 * 86400,
    pot: [{ nick: "tsyko", amount: 10000 }, { nick: "foamy1111", amount: 2500 }],
    claims: [{ nick: "ritchiecuh", ts: now - 3000, note: "done", evidence: { links: ["https://clips.example/abc"] }, check: { state: "verified", lines: ["21:02 cam"] } }],
    hunters: [], verify: { text: "ffjoker starts his cam", action: "cam" } },
  { id: 3, creator: "foamy1111", task: "Find the stickers", room: "PATV", status: "resolved", created: now - 86400 * 4, deadline: now - 86400, resolved: now - 86400 * 2,
    pot: [{ nick: "foamy1111", amount: 8000 }], claims: [], hunters: ["tsyko"] },
];

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 0,
                  camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  for (const [id, name, cf, cls] of [["u1", "pb", "foamy1111", "pleb"], ["u2", "tsyko", "tsyko", "pleb"], ["u4", "admin", "ffjoker", "Admin"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, class, points_balance) VALUES (?, ?, ?, 'x', ?, ?, 250000)", [id, name, name, cf, cls]);
  }
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", path.join(repo, "views"));
  app.use(express.json({ limit: "5mb" }));
  app.use((req, res, next) => { const l = req.get("x-lang"); if (l) res.locals.i18nT = i18n.tFor(l); next(); });
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  const opts = { isBotToken: (t) => t === "bot-token", addUser };
  markets.register(app, opts); wagers.register(app, opts); polls.register(app, opts); bounties.register(app, opts);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  const sync = async (p, body) => assert.equal((await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "bot-token", ...body }) })).status, 200);
  await sync("/api/markets/sync", { markets: [M1, M3, P5] });
  await sync("/api/wagers/sync", { wagers: W });
  await sync("/api/polls/sync", { polls: POLLS });
  await sync("/api/bounties/sync", { bounties: BOUNTIES });
});
test.after(() => server.close());
const page = async (u, p, lang) => {
  const r = await fetch(base + p, { headers: Object.assign({}, u ? { "x-test-user": u } : {}, lang ? { "x-lang": lang } : {}) });
  assert.equal(r.status, 200, p);
  return r.text();
};
// a key that t() couldn't find comes back as the key itself
const KEY = /\b(?:bx|markets|market|aij|wagers|polls|bounties|bounty)\.[a-z0-9_]+(?:\.[a-z0-9_]+)*\b/g;
const leaked = (h) => (h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "").match(KEY) || []).filter((k) => k in EN || /^(bx|aij)\./.test(k));

const PAGES = [["u1", "/markets"], ["u1", "/markets/1"], [null, "/markets/1"], ["u4", "/markets/3"], ["u1", "/markets/5"], ["u1", "/wagers"], [null, "/wagers"],
  ["u1", "/polls"], [null, "/polls"], ["u1", "/bounties"], [null, "/bounties"], ["u2", "/bounties/1"], ["u1", "/bounties/1"], [null, "/bounties/3"]];

test("every page has the shared look and prints no raw i18n keys (English + German)", async () => {
  for (const [u, p] of PAGES) {
    for (const lang of [null, "de"]) {
      const h = await page(u, p, lang);
      assert.match(h, /\/public\/css\/bets\.css\?v=\d+/, p);
      assert.match(h, /<main class="bx /, p);
      assert.deepEqual(leaked(h), [], p + " " + (lang || "en"));
    }
  }
});

test("markets: hero, chips, live countdown, the same create form", async () => {
  const h = await page("u1", "/markets");
  assert.match(h, /class="bx-hero"/);
  assert.match(h, /class="bx-chip c-open"/);
  assert.match(h, /class="bx-chip c-closed">waiting for the judge/);
  assert.match(h, /data-until="\d+(\.\d+)?"/);
  assert.match(h, /<form class="newmk bx-form" method="post" action="\/act">/);
  for (const f of ['name="cmd" value="market"', 'name="a0" value="new"', 'name="a1"', 'name="a2"', 'name="a3"', 'name="a4"', 'value="closes 1d" selected', "data-ai"]) assert.ok(h.includes(f), f);
  assert.match(h, /!market new Will X happen\? judge @someone closes 2d/);
});

test("market page: board + trade panel with the same buy / sell posts, quick amounts, the estimate script", async () => {
  const h = await page("u1", "/markets/1");
  assert.match(h, /class="mk-main two"/);
  assert.match(h, /<form class="bet side-card" method="post" action="\/markets\/1\/bet" id="buy">/);
  assert.match(h, /<input type="radio" name="option" value="Yes" checked>/);
  assert.match(h, /name="amount" min="500"/);
  assert.match(h, /data-amt="5000"/);
  assert.match(h, /data-amt="max" data-max="250000"/);
  assert.match(h, /__t\('js\.market\.est'/);
  assert.match(h, /action="\/markets\/1\/sell"/);
  assert.match(h, /<svg viewBox="0 0 600 170"/);
  assert.match(h, /Judgement &amp; evidence/);
  assert.match(h, /name="a0" value="ai"/, "a holder can ask Pepe");
  const out = await page(null, "/markets/1");
  assert.match(out, /href="\/login"/);
  assert.match(out, /<code>!market M1 Yes 5k<\/code>/);
  assert.doesNotMatch(out, /id="buy"/);
});

test("market page: the judge / an admin gets the resolve form on a closed market", async () => {
  const h = await page("u4", "/markets/3");
  assert.match(h, /<form class="bet judge side-card" method="post" action="\/markets\/3\/resolve">/);
  assert.match(h, /name="outcome" value="void"/);
  assert.match(h, /Trading closed — waiting for the judge/);
});

test("pool page: bet form posts to the same route", async () => {
  const h = await page("u1", "/markets/5");
  assert.match(h, /action="\/markets\/5\/bet"/);
  assert.match(h, /Place bet/);
  assert.match(h, /<h3>Bets<\/h3>/);
});

test("wagers: offer card with accept / decline, judge settle form, both start forms with their ids", async () => {
  const h = await page("u1", "/wagers");
  assert.match(h, /Offers waiting for you/);
  assert.match(h, /name="a0" value="accept"><input type="hidden" name="a1" value="W11">/);
  assert.match(h, /name="a0" value="decline">/);
  assert.match(h, /name="a0" value="settle"><input type="hidden" name="a1" value="W12">/, "foamy1111 judges W12");
  for (const id of ['id="wf"', 'id="pf"', 'id="wf-judge"', 'id="wf-ai"', 'id="wf-a3"', 'id="pf-opts"', 'id="pf-a2"', 'id="pf-judge"', 'id="pf-ai"', 'id="pf-a3"']) assert.ok(h.includes(id), id);
  assert.match(h, /name="cmd" value="pool"[\s\S]*name="a0" value="M5"/);
  assert.match(h, /<time datetime=/, "deadlines in the viewer's zone");
  const out = await page(null, "/wagers");
  assert.match(out, /<code>!wager @bob 10k Lakers win judge @carol by 2d<\/code>/);
  assert.doesNotMatch(out, /id="wf"/);
});

test("polls: each option row is the vote button (same poll.vote post); signed out sees plain rows", async () => {
  const h = await page("u1", "/polls");
  assert.equal((h.match(/name="kind" value="poll\.vote"/g) || []).length, 2);
  assert.match(h, /<button class="opt votebtn mine" type="submit" disabled/);
  assert.match(h, /name="a1" value="1">[\s\S]*?<button class="opt votebtn" type="submit"/);
  assert.match(h, /<span class="tag w">winner<\/span>/, "the past poll's winner");
  const out = await page(null, "/polls");
  assert.doesNotMatch(out, /poll\.vote/);
  assert.match(out, /Sign in<\/a> to vote/);
});

test("bounties: poster cards + the same post form; detail keeps add / claim / resolve / cancel", async () => {
  const h = await page("u1", "/bounties");
  assert.match(h, /href="\/bounties\/1"/);
  assert.match(h, /class="bx-chip c-resolved">paid/);
  assert.match(h, /name="cmd" value="bounty"/);
  assert.match(h, /value="by 7d" selected/);
  const own = await page("u2", "/bounties/1");
  for (const a of ["add", "resolve", "cancel", "reject"]) assert.match(own, new RegExp(`action="/bounties/1/${a}"`), a);
  assert.match(own, /name="hunters" value="ritchiecuh"/);
  const other = await page("u1", "/bounties/1");
  assert.match(other, /action="\/bounties\/1\/claim"/);
  assert.match(other, /name="evidence"/);
  assert.doesNotMatch(other, /action="\/bounties\/1\/resolve"/);
});
