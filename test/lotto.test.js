// 1.99lb: Pepeball (/lotto) - the snapshot cleaner, odds, ticket matching, the last draw's tickets kept by the site,
// and the page: hero states (open / closed / drawing), the picker posting the same /act commands, your tickets with
// the matches lit, prize tiers, the last draw + winners (anonymised names stay plain), the 40/60 explainer.
//   NODE_PATH=G:/PATV/node_modules node --test test/lotto.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lotto-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const ejs = require("ejs");
const { runQuery } = require(path.join(repo, "dbUtils"));
const LT = require(path.join(repo, "lotto"));

const TOKEN = "bot-token";
const users = new Map();
let base, server;
const H = (uid) => Object.assign({ "content-type": "application/json" }, uid ? { "x-test-user": uid } : {});
async function get(url, uid) {
  const r = await fetch(base + url, { headers: H(uid), redirect: "manual" });
  return { status: r.status, text: await r.text() };
}
async function sync(snap) {
  const r = await fetch(base + "/api/lotto/sync", { method: "POST", headers: H(), body: JSON.stringify(Object.assign({ password: TOKEN }, snap)) });
  return r.status;
}

const now = () => Math.floor(Date.now() / 1000);
const PRIZES = [[4, true, 0], [4, false, 500000], [3, true, 150000], [3, false, 15000], [2, true, 7500], [1, true, 3000], [0, true, 1500], [2, false, 1000]];
const snap = (o) => Object.assign({ draw: 2, next_at: now() + 3 * 86400, sales_open: true, price: 1000, close_secs: 300, jackpot: 20982296, sold: 7572,
  prizes: PRIZES, players: {}, history: [] }, o);

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, points_balance) VALUES ('u1', 'ann', 'Ann', 'x', 'AnnCF', 1234567)");
  await runQuery("INSERT INTO users (userId, username, displayname, password, points_balance) VALUES ('u2', 'bob', 'Bob', 'x', 50)");
  users.set("u1", { userId: "u1", username: "ann" });
  users.set("u2", { userId: "u2", username: "bob" });
  const app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  LT.register(app, { isBotToken: (p) => p === TOKEN, addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server.close());

test("odds, the snapshot cleaner and ticket matching (rules unchanged: 4 of 1-30 + a Pepe Ball 1-10)", () => {
  assert.equal(LT.oddsFor(4, true), 274050);
  assert.equal(LT.oddsFor(0, true), 18);
  const c = LT.cleanSnapshot({ draw: "3", players: { AnnCF: { count: 2, tickets: [[[1, 2, 3, 99, 5], 44], "junk"] } }, history: [{ draw: 2, white: [1, 2], pb: 3, won: [["x", 5]] }] });
  assert.equal(c.draw, 3);
  assert.deepEqual(c.players.anncf.tickets, [[[1, 2, 3, 30], 10]], "lowercased name, 4 whites clamped, ball clamped");
  const prizes = [{ w: 4, ball: true, amount: 9, jackpot: true }, { w: 3, ball: false, amount: 15000, jackpot: false }];
  const h = { white: [1, 2, 3, 4], pb: 5 };
  assert.deepEqual(LT.ticketPrize([[1, 2, 3, 9], 6], h, prizes), { w: 3, ball: false, amount: 15000, jackpot: false });
  assert.equal(LT.ticketPrize([[1, 2, 3, 4], 5], h, prizes).jackpot, true);
  assert.equal(LT.ticketPrize([[9, 10, 11, 12], 6], h, prizes), null);
});

test("signed out, sales open: hero with the exact jackpot + countdown + stats, sign-in prompt, prize tiers, explainer", async () => {
  assert.equal(await sync(snap({ players: { anncf: { count: 2, tickets: [[[3, 9, 14, 27], 6], [[1, 2, 3, 4], 5]] }, zed: { count: 1, tickets: [[[5, 6, 7, 8], 1]] } } })), 200);
  const { status, text } = await get("/lotto");
  assert.equal(status, 200);
  assert.match(text, /<title>[^<]*Pepeball/);
  assert.match(text, /class="pb-jpn" data-count="20982296">20,982,296</);
  assert.match(text, /Draw #2/);
  assert.match(text, /role="timer"/);
  assert.match(text, /data-state="open"/);
  assert.match(text, /<b>7,572<\/b>tickets sold/);
  assert.match(text, /<b>2<\/b>players/);
  assert.match(text, /<time datetime=/, "draw time in the viewer's zone");
  assert.match(text, /href="#pb-buy"/);
  assert.match(text, /<a href="\/login">Sign in<\/a> to pick your numbers/);
  assert.doesNotMatch(text, /id="pb-pick"/);
  assert.match(text, /class="pb-tier jp"/, "the jackpot tier glows");
  assert.match(text, /1 in 274,050/);
  assert.match(text, /Pepe Ball only/);
  assert.match(text, /40% grows the jackpot/);
  assert.match(text, /60% goes to the House/);
  assert.match(text, /prefers-reduced-motion: reduce/);
  assert.doesNotMatch(text, /AnnCF|zed/i, "nobody's tickets are public");
});

test("linked player: the picker posts the same /act commands; their tickets as balls", async () => {
  const { text } = await get("/lotto", "u1");
  // pick your own -> `!lotto a0 a1 a2 a3 pb a5`; quick pick -> `!lotto quick a1`
  const pick = text.match(/<form class="pb-card pb-pick" method="post" action="\/act" id="pb-pick"[\s\S]*?<\/form>/)[0];
  for (const f of ['name="cmd" value="lotto"', 'name="a0" value=""', 'name="a3" value=""', 'name="a4" value="pb"', 'name="a5" value=""', 'name="back" value="/lotto"']) assert.ok(pick.includes(f), f);
  assert.equal((pick.match(/class="pb-n"/g) || []).length, 40, "30 numbers + 10 Pepe Balls, all real buttons");
  assert.match(pick, /type="button" class="pb-n" data-n="30" aria-pressed="false"/);
  assert.match(pick, /Buy this ticket · 1,000 PAT/);
  const qp = text.match(/<form class="pb-card pb-qp"[\s\S]*?<\/form>/)[0];
  assert.match(qp, /name="a0" value="quick"/);
  assert.match(qp, /name="a1" min="1" max="500" value="1"/);
  assert.match(qp, /data-bal="1234567"/);
  assert.match(text, /Your balance: <b>1,234,567<\/b> PAT/);
  assert.match(text, /<b>2<\/b> tickets in the draw/);
  assert.match(text, /<span class="pb-b">3<\/span><span class="pb-b">9<\/span><span class="pb-b">14<\/span><span class="pb-b">27<\/span><span class="pb-b pb">6<\/span>/);
  const bob = await get("/lotto", "u2");
  assert.match(bob.text, /Link a chat account \(Edit profile → Connections; for Camfrog, <code>!verify<\/code>\)/);
});

test("the draw: the site keeps last draw's tickets, lights the matches and shows the winnings; anonymised winners stay plain", async () => {
  const history = [{ draw: 2, white: [3, 9, 20, 21], pb: 6, tickets: 3, winners: 2, paid: 158000, jackpot: 21000000, jackpot_winners: [],
    jackpot_paid: 0, won: [["AnnCF", 7500], ["someone", 150500]], ts: now() - 60 }];
  assert.equal(await sync(snap({ draw: 3, sold: 0, players: {}, history })), 200);
  const { text } = await get("/lotto", "u1");
  assert.match(text, /Your tickets · last draw #2/);
  assert.match(text, /You won 7,500 PAT in draw #2/);
  // 3 9 14 27 + 6 vs 3 9 20 21 + 6: two whites and the ball lit, the rest dimmed; the winning ticket first
  assert.match(text, /<div class="pb-tk won"><span class="pb-balls"><span class="pb-b sm hit">3<\/span><span class="pb-b sm hit">9<\/span><span class="pb-b sm dim">14<\/span><span class="pb-b sm dim">27<\/span><span class="pb-b pb sm hit">6<\/span><\/span><span class="pb-tag2">\+7,500<\/span>/);
  assert.match(text, /class="pb-tk lost"/);
  assert.match(text, /No tickets yet for draw #3/);
  // results: big balls, stats, rollover, winners list (someone = anonymised, printed plain)
  assert.match(text, /<span class="pb-b lg" style="--i:0">3<\/span>/);
  assert.match(text, /<span class="pb-b lg pb" style="--i:4">6<\/span>/);
  assert.match(text, /Nobody hit the jackpot, so 21,000,000 PAT rolled over/);
  assert.match(text, /<span class="nm">someone<\/span><b>150,500<\/b>/);
  assert.match(text, /<td>#2<\/td>/, "past draws table");
  // anyone else sees the results, not Ann's tickets
  const out = await get("/lotto");
  assert.doesNotMatch(out.text, /last draw #2|You won/);
});

test("sales closed and drawing states; no snapshot yet", async () => {
  await sync(snap({ draw: 3, sales_open: false, next_at: now() + 120 }));
  let { text } = await get("/lotto", "u1");
  assert.match(text, /data-state="closed"/);
  assert.match(text, /<div class="pb-state closed" data-s="closed">/);
  assert.match(text, /Sales are closed for this draw/);
  assert.doesNotMatch(text, /id="pb-pick"/);
  await sync(snap({ draw: 3, sales_open: false, next_at: now() - 30 }));
  ({ text } = await get("/lotto"));
  assert.match(text, /data-state="drawing"/);
  assert.match(text, /<div class="pb-state drawing" data-s="drawing">🎱 Drawing now!/);
  const empty = await ejs.renderFile(path.join(repo, "views", "lotto.ejs"), { user: null, L: null, me: null, mine: null, prizes: [], anyOdds: null, acts: [], msg: null,
    players: 0, last: null, rules: { WHITE_MAX: 30, WHITE_PICK: 4, BALL_MAX: 10 }, ul: (n) => n });
  assert.match(empty, /Pepe hasn't posted Pepeball yet/);
});
