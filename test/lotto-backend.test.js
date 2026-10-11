// 1.99ml: Pepeball on the backend (lotto/*.js, docs/lotto-backend.md):
//   * engine: the Sunday 21:00 ET schedule (EDT + EST), provably fair numbers (commit / tickets digest / reveal, verify), the
//     prize plan per tier (Pepe's per-ticket int scaling, the jackpot split per ticket);
//   * the service on a temp DB: purchases (40% pot / 60% House, keyed, replay-safe, refused when short / closed / banned),
//     a full draw (close -> draw -> pay), payouts per tier, jackpot won (pot paid, reseed due -> Pepe's keyed pot top-up)
//     and rolled over, the House short (Fed flash claim / pro-rata scale), restart mid-draw and mid-purchase,
//     the cutover import / export round trip with totals equality (and a mismatch refused, nothing kept);
//   * HTTP: web purchase (JSON fetch), the /act form path, Pepe's act / poll / pot, Telegram refused, Pepe's old sync refused.
//   NODE_PATH=<scratch with @noble/curves, @noble/hashes, qrcode-generator>;G:/PATV/node_modules node --test test/lotto-backend.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lotto-backend-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const E = require(path.join(repo, "lotto", "engine"));
const svc = require(path.join(repo, "lotto", "service"));
const routes = require(path.join(repo, "lotto", "routes"));
const LT = require(path.join(repo, "lotto"));
const funding = require(path.join(repo, "funding"));

const TOKEN = "bot-token";
// Thursday 2026-10-08 12:00 EDT
let NOW = Date.UTC(2026, 9, 8, 16, 0, 0);
svc._S.hooks.now = () => NOW;
const xp = [];
svc._S.hooks.updateLevel = async (uid, n) => { xp.push([uid, n]); };
let k = 0;
const key = () => `lt:test-${++k}-${Date.now()}`;
const ann = { uid: "u1", name: "AnnCF", via: "room" };
const bob = { uid: "u2", name: "bob", via: "web" };
const cat = { uid: "u3", name: "Cat", via: "web" };
const bal = async (uid) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [uid]))[0].b;
const house = async () => (await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM jackpot_rakes"))[0].t;
const setBal = (uid, b) => runQuery("UPDATE users SET points_balance = ? WHERE userId = ?", [b, uid]);
const setHouse = async (amt) => { await runQuery("DELETE FROM jackpot_rakes"); await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, amount) VALUES ('seed', 'seed', ?)", [amt]); };
const cur = async () => (await getQuery("SELECT * FROM lotto_draws WHERE state IN ('selling','closed') ORDER BY draw DESC LIMIT 1"))[0];
const at = async (sec) => { NOW = sec * 1000; await svc.tick(); };
let base, server;

async function fresh(opts = {}) {
  svc.stop();
  svc._S.hooks.numbers = null;
  svc._S.hooks.crash = null;
  svc._S.payBackoff.clear();
  svc._S.rate.clear();
  for (const t of ["lotto_tickets", "lotto_draws", "lotto_pot", "lotto_history", "lotto_purchases", "lotto_imports", "lotto_events",
                   "lotto_settings", "transactions", "reserve_claims", "lotto_state", "lotto_last_tickets"]) {
    await runQuery(`DELETE FROM ${t}`).catch(() => {});
  }
  for (const u of ["u1", "u2", "u3"]) await setBal(u, 1000000);
  await runQuery("UPDATE users SET casino_banned = 0");
  await setHouse(opts.house === undefined ? 50000000 : opts.house);
  NOW = Date.UTC(2026, 9, 8, 16, 0, 0);
  xp.length = 0;
  funding.sync({});
  await svc.boot({ tick: false });
  if (opts.on !== false) await svc.setSetting("lotto_backend", "1", "test");
  if (opts.pot) await runQuery("INSERT INTO lotto_pot (moveId, draw, amount, why, created) VALUES ('seedpot', 1, ?, 'test', 0)", [opts.pot]);
  await svc.tick();                                  // opens draw #1
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, level INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await runQuery(`CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL, points INTEGER NOT NULL,
                  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  for (const [id, u, d, cf] of [["u1", "ann", "Ann", "AnnCF"], ["u2", "bob", "Bob", null], ["u3", "cat", "Cat", "CatCF"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, points_balance) VALUES (?, ?, ?, 'x', ?, 1000000)", [id, u, d, cf]);
  }
  await funding.init();
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; res.locals.t = (k2) => k2; next(); });
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u, username: u } : null; next(); };
  LT.register(app, { isBotToken: (p) => p === TOKEN, addUser });
  routes.register(app, { isBotToken: (p) => p === TOKEN, addUser, updateLevel: svc._S.hooks.updateLevel });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { svc.stop(); server.close(); });

const post = async (url, body, uid, fetchHdr = true) => {
  const h = { "content-type": "application/json" };
  if (uid) h["x-test-user"] = uid;
  if (fetchHdr) h["X-Requested-With"] = "fetch";
  const r = await fetch(base + url, { method: "POST", headers: h, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};

// ── engine ──
test("schedule: the next Sunday 21:00 America/New_York, in summer (EDT) and winter (EST)", () => {
  const thu = Date.UTC(2026, 9, 8, 16) / 1000;
  assert.equal(E.nextDrawTs(thu), Date.UTC(2026, 9, 12, 1) / 1000);          // Sun Oct 11 21:00 EDT = Mon 01:00 UTC
  assert.equal(E.nextDrawTs(Date.UTC(2026, 9, 12, 1) / 1000), Date.UTC(2026, 9, 19, 1) / 1000);   // at the draw -> next week
  assert.equal(E.nextDrawTs(Date.UTC(2026, 11, 2, 12) / 1000), Date.UTC(2026, 11, 7, 2) / 1000);  // Sun Dec 6 21:00 EST = 02:00 UTC
  assert.equal(E.nextDrawTs(Date.UTC(2026, 10, 1, 12) / 1000), Date.UTC(2026, 10, 2, 2) / 1000);  // DST ends Nov 1: 21:00 EST
  const z = E.zoned(E.nextDrawTs(thu));
  assert.deepEqual([z.wd, z.h, z.mi], [0, 21, 0]);
});

test("fairness: commitment, tickets digest and numbers re-derive; any change breaks the proof", () => {
  const seed = E.newServerSeed();
  const tickets = [{ id: 1, w: [1, 2, 3, 4], pb: 5 }, { id: 2, w: [7, 11, 20, 30], pb: 10 }];
  const digest = E.ticketsDigest(tickets);
  const n = E.drawNumbers(seed, digest, 7);
  assert.equal(n.white.length, 4);
  assert.equal(new Set(n.white).size, 4);
  assert.ok(n.white.every((x) => x >= 1 && x <= 30) && n.pb >= 1 && n.pb <= 10);
  assert.deepEqual(E.drawNumbers(seed, digest, 7), n, "deterministic");
  const rec = { draw: 7, commitment: E.commitment(seed), server_seed: seed, tickets_digest: digest, white: n.white, pb: n.pb,
                tickets: tickets.map((t) => [t.id, t.w, t.pb]) };
  assert.equal(E.verify(rec).ok, true);
  assert.equal(E.verify(Object.assign({}, rec, { server_seed: E.newServerSeed() })).commitment_ok, false);
  assert.equal(E.verify(Object.assign({}, rec, { tickets: [[1, [1, 2, 3, 4], 6]] })).digest_ok, false);
  assert.notEqual(E.ticketsDigest([tickets[0]]), digest);
  // uniform-ish: every number and ball shows up over many draws
  const seen = new Set(), balls = new Set();
  for (let i = 0; i < 400; i++) { const x = E.drawNumbers(seed, digest, i); x.white.forEach((w) => seen.add(w)); balls.add(x.pb); }
  assert.equal(seen.size, 30); assert.equal(balls.size, 10);
});

test("prize plan: every tier, Pepe's per-ticket scaling, the jackpot split per winning ticket, capped", () => {
  const W = [1, 2, 3, 4], PB = 5;
  const T = (uid, w, pb) => ({ uid, name: uid, w, pb });
  const tickets = [T("a", [1, 2, 3, 4], 5), T("a", [1, 2, 3, 4], 5), T("b", [1, 2, 3, 4], 6), T("b", [1, 2, 3, 9], 5), T("c", [1, 2, 3, 9], 6),
                   T("c", [1, 2, 9, 10], 5), T("c", [1, 2, 9, 10], 6), T("d", [1, 9, 10, 11], 5), T("d", [9, 10, 11, 12], 5), T("d", [9, 10, 11, 12], 6),
                   T("e", [1, 9, 10, 11], 6)];
  const p = E.plan({ tickets, white: W, pb: PB, house: 10000000, pot: 3000001 });
  const sum = (uid, r) => p.entries.filter((e) => e.uid === uid && (!r || e.reason === r)).reduce((s, e) => s + e.amount, 0);
  assert.equal(sum("a", "lotto-jackpot"), 3000000, "two jackpot tickets: floor(3,000,001 / 2) each");
  assert.equal(sum("b"), 500000 + 150000);
  assert.equal(sum("c"), 15000 + 7500 + 1000);
  assert.equal(sum("d"), 3000 + 1500);
  assert.equal(sum("e"), 0, "1 white without the ball wins nothing");
  assert.equal(p.winners, 9, "the two no-ball losers (0 and 1 white) don't count");
  assert.equal(p.jackpot, 3000001);
  // the House short: every fixed prize scaled, int per ticket (Pepe's int(a * scale))
  const q = E.plan({ tickets, white: W, pb: PB, house: 339000, pot: 0 });
  assert.ok(q.scale < 1);
  assert.equal(q.entries.filter((e) => e.reason === "lotto-jackpot").length, 0, "no pot, no jackpot");
  assert.ok(q.paid <= 339000);
  // capped at 100M
  assert.equal(E.plan({ tickets: [T("a", W, PB)], white: W, pb: PB, house: 0, pot: 250000000 }).paid, 100000000);
});

// ── purchases ──
test("purchase: 40% to the pot, 60% to the House, keyed; a replay never charges twice; short / closed / banned refused", async () => {
  await fresh();
  const h0 = await house();
  const r = await svc.buy(ann, { picks: [[[25, 3, 7, 12], 4]] }, "lt:k1");
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.bought, [[[3, 7, 12, 25], 4]]);
  assert.equal(await bal("u1"), 999000);
  assert.equal(await svc.potBalance(), 400);
  assert.equal(await house() - h0, 600);
  const again = await svc.buy(ann, { picks: [[[25, 3, 7, 12], 4]] }, "lt:k1");
  assert.ok(again.replay);
  assert.equal(await bal("u1"), 999000, "same key: charged once");
  const q = await svc.buy(bob, { quick: 7 }, "lt:k2");
  assert.equal(q.count, 7);
  assert.equal(q.mine, 7);
  assert.equal(await svc.potBalance(), 400 + 2800);
  assert.equal((await cur()).sold, 8);
  await setBal("u3", 500);
  assert.equal((await svc.buy(cat, { quick: 1 }, "lt:k3")).code, "insufficient");
  assert.equal(await bal("u3"), 500);
  assert.equal((await svc.buy(ann, { picks: [[[1, 1, 2, 3], 4]] }, "lt:k4")).code, "bad_pick");
  await runQuery("UPDATE users SET casino_banned = 1 WHERE userId = 'u2'");
  assert.equal((await svc.buy(bob, { quick: 1 }, "lt:k5")).code, "banned");
  await at((await cur()).close_at);
  assert.equal((await cur()).state, "closed");
  assert.equal((await svc.buy(ann, { quick: 1 }, "lt:k6")).code, "closed");
  assert.equal((await svc.buy(ann, { quick: 600 }, "lt:k7")).code, "closed");
  const tx = await getQuery("SELECT COUNT(*) AS n FROM transactions WHERE type = 'lotto-tickets'");
  assert.equal(tx[0].n, 2);
});

test("a full draw: close (digest) -> draw (numbers from the seed) -> pay per tier; next draw opens Sunday; fairness verifies", async () => {
  await fresh({ pot: 5000000 });
  await svc.buy(ann, { picks: [[[1, 2, 3, 4], 5], [[1, 2, 3, 9], 5], [[20, 21, 22, 23], 5]] }, "lt:a");   // 3+PB, 0+PB, and a jackpot? no
  await svc.buy(bob, { picks: [[[1, 2, 3, 4], 6], [[1, 2, 10, 11], 6]] }, "lt:b");                       // 4 (no ball), 2
  await svc.buy(cat, { picks: [[[9, 10, 11, 12], 1]] }, "lt:c");                                           // nothing
  svc._S.hooks.numbers = () => ({ white: [1, 2, 3, 4], pb: 5 });
  const D = await cur();
  const before = { u1: await bal("u1"), u2: await bal("u2"), u3: await bal("u3"), house: await house(), pot: await svc.potBalance() };
  await at(D.next_at);
  await svc.tick();
  const d1 = (await getQuery("SELECT * FROM lotto_draws WHERE draw = 1"))[0];
  assert.equal(d1.state, "paid");
  // ann: (4+PB) jackpot ticket 1,2,3,4 PB5 -> the pot; 1,2,3,9 PB5 = 3+PB 150k; 20.. PB5 = 0+PB 1.5k
  assert.equal(await bal("u1") - before.u1, before.pot + 150000 + 1500);
  assert.equal(await bal("u2") - before.u2, 500000 + 1000);
  assert.equal(await bal("u3"), before.u3);
  assert.equal(before.house - await house(), 150000 + 1500 + 500000 + 1000, "the House paid the fixed prizes");
  assert.equal(await svc.potBalance(), 0, "the jackpot emptied the pot");
  const types = (await getQuery("SELECT type, points FROM transactions WHERE transactionId LIKE 'lotto:T1:win:%' ORDER BY type")).map((r) => r.type);
  assert.deepEqual(types, ["lotto-0pb", "lotto-2", "lotto-3pb", "lotto-4", "lotto-jackpot"]);
  const h = (await svc.history(1))[0];
  assert.equal(h.draw, 1); assert.equal(h.tickets, 6); assert.equal(h.winners, 5);
  assert.deepEqual(h.jackpot_winners, ["AnnCF"]);
  assert.equal(h.paid, before.pot + 150000 + 1500 + 500000 + 1000);
  const nx = await cur();
  assert.equal(nx.draw, 2);
  assert.equal(nx.next_at, Date.UTC(2026, 9, 19, 1) / 1000, "next Sunday 21:00 EDT");
  assert.ok(xp.some(([u]) => u === "u1"));
  // the reseed is due -> Pepe tops the pot up through his keyed endpoint, then acks
  const pl = await svc.poll(-1, 0);
  assert.deepEqual(pl.reseed, [{ draw: 1, want: 1000000 }]);
  assert.ok((await svc.botPot(600000, "lotto-reseed-1-house:in", "reseed")).ok);
  assert.ok((await svc.botPot(600000, "lotto-reseed-1-house:in", "reseed")).replay, "the same ref twice moves once");
  assert.ok((await svc.botPot(400000, "lotto-reseed-1-inc:in", "reseed")).ok);
  assert.equal(await svc.potBalance(), 1000000);
  await svc.botReseeded(1, 1000000);
  assert.deepEqual((await svc.poll(-1, 0)).reseed, []);
  assert.equal((await svc.botPot(-2000000, "too-much-1", "x")).code, "short", "the pot never goes negative");
  // the fairness record (real numbers this time on draw #2)
  svc._S.hooks.numbers = null;
  await svc.buy(ann, { quick: 3 }, "lt:d2");
  await at(nx.next_at);
  await svc.tick();
  const fr = await svc.fairRecord(2);
  assert.equal(fr.state, "paid");
  assert.equal(E.verify(fr).ok, true, "the published record verifies");
});

test("jackpot rolls over: no 4+PB -> the pot stays (plus the new 40%), no reseed", async () => {
  await fresh({ pot: 2000000 });
  await svc.buy(ann, { picks: [[[1, 2, 3, 4], 6]] }, "lt:r1");
  svc._S.hooks.numbers = () => ({ white: [1, 2, 3, 4], pb: 5 });
  await at((await cur()).next_at);
  await svc.tick();
  assert.equal(await svc.potBalance(), 2000400);
  assert.deepEqual((await svc.poll(-1, 0)).reseed, []);
  const ev = await getQuery("SELECT kind, data FROM lotto_events WHERE kind = 'drawn'");
  assert.equal(JSON.parse(ev[0].data).next_jackpot, 2000400);
});

test("the House short: Fed flash claim booked (flash on), else fixed prizes scaled pro rata", async () => {
  await fresh({ house: 5100000 });
  funding.sync({ flows: { wheel_shortfall: "jackpot" }, monetary: { flash: { house: true }, fedloan_room: 10000000, house_hard_floor: 5000000 } });
  await svc.buy(ann, { picks: [[[1, 2, 3, 4], 6]] }, "lt:f1");               // 4 = 500k
  svc._S.hooks.numbers = () => ({ white: [1, 2, 3, 4], pb: 5 });
  const b0 = await bal("u1");
  await at((await cur()).next_at);
  await svc.tick();
  assert.equal(await bal("u1") - b0, 500000, "paid in full");
  const fl = await getQuery("SELECT amount, meta FROM reserve_claims WHERE flow = 'flash:house:lotto'");
  assert.equal(fl.length, 1);
  assert.ok(fl[0].amount > 0 && JSON.parse(fl[0].meta).ref === "lotto:T1:fixed");
  // flash off + the House can't cover: scaled
  await fresh({ house: 100000 });
  await svc.buy(ann, { picks: [[[1, 2, 3, 4], 6]] }, "lt:f2");
  svc._S.hooks.numbers = () => ({ white: [1, 2, 3, 4], pb: 5 });
  const b1 = await bal("u1");
  await at((await cur()).next_at);
  await svc.tick();
  const got = await bal("u1") - b1;
  assert.ok(got >= 100599 && got <= 100600, "the whole House (incl. the ticket's 600) - scaled: " + got);
  assert.ok((await house()) >= 0 && (await house()) <= 1, "never negative");
});

test("restart mid-draw: a crash after the House paid / after one credit resumes - nobody paid twice", async () => {
  await fresh({ pot: 1000000 });
  await svc.buy(ann, { picks: [[[1, 2, 3, 4], 5], [[1, 2, 3, 9], 6]] }, "lt:m1");
  await svc.buy(bob, { picks: [[[1, 2, 3, 4], 6]] }, "lt:m2");
  svc._S.hooks.numbers = () => ({ white: [1, 2, 3, 4], pb: 5 });
  let n = 0;
  svc._S.hooks.crash = (step) => { if (step === "after-credit" && ++n === 1) throw new Error("boom"); };
  const b = { u1: await bal("u1"), u2: await bal("u2") };
  const h0 = await house();
  await at((await cur()).next_at);
  assert.equal((await getQuery("SELECT state FROM lotto_draws WHERE draw = 1"))[0].state, "drawn", "the plan is saved, paying failed");
  // "restart"
  svc.stop();
  svc._S.hooks.crash = null;
  await svc.boot({ tick: false });
  NOW += 31000;
  await svc.tick();
  assert.equal((await getQuery("SELECT state FROM lotto_draws WHERE draw = 1"))[0].state, "paid");
  assert.equal(await bal("u1") - b.u1, 1001200 + 15000, "jackpot (pot incl. the 3 tickets' 40%) + 3 = 15k, once");
  assert.equal(await bal("u2") - b.u2, 500000);
  assert.equal(h0 - await house(), 515000, "the House debited once");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM jackpot_rakes WHERE jackpotId = 'lotto:T1:fixed'"))[0].n, 1);
});

test("restart mid-purchase: charged but no tickets -> finished while open, refunded once the draw closed; uncharged -> failed", async () => {
  await fresh();
  const D = await cur();
  const mk = async (kk, uid, charged) => {
    await runQuery(`INSERT INTO lotto_purchases (key, draw, userId, name, picks, count, cost, pot, state, via, created)
                    VALUES (?, ?, ?, 'x', ?, 2, 2000, 800, 'charging', 'web', 0)`, [kk, D.draw, uid, JSON.stringify([[[1, 2, 3, 4], 5], [[5, 6, 7, 8], 9]])]);
    if (charged) {
      await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES (?, ?, 'lotto-tickets', -2000)", [kk, uid]);
      await runQuery("UPDATE users SET points_balance = points_balance - 2000 WHERE userId = ?", [uid]);
    }
  };
  await mk("lt:c1", "u1", true);
  await mk("lt:c2", "u2", false);
  await svc.recover();
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM lotto_tickets WHERE purchase = 'lt:c1'"))[0].n, 2);
  assert.equal(await svc.potBalance(), 800);
  assert.equal((await getQuery("SELECT state FROM lotto_purchases WHERE key = 'lt:c2'"))[0].state, "failed");
  await svc.recover();
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM lotto_tickets WHERE purchase = 'lt:c1'"))[0].n, 2, "idempotent");
  await at(D.close_at);
  await mk("lt:c3", "u3", true);
  const b3 = await bal("u3");
  await svc.recover();
  assert.equal(await bal("u3") - b3, 2000, "refunded");
  assert.equal((await getQuery("SELECT type FROM transactions WHERE transactionId = 'lt:c3:refund'"))[0].type, "lotto-late-refund");
});

// ── the cutover ──
function exportFixture() {
  const tickets = [];
  for (let i = 0; i < 30; i++) tickets.push({ user: i % 3 === 0 ? "ann" : i % 3 === 1 ? "Bob" : "cat", who: ["AnnCF", "bob", "CatCF"][i % 3], w: [1 + (i % 20), 21, 22, 23], pb: 1 + (i % 10) });
  const history = [{ draw: 4, white: [1, 2, 3, 4], pb: 5, tickets: 7575, winners: 1200, paid: 4000000, jackpot: 18000000, jackpot_winners: [], jackpot_paid: 0, won: [["AnnCF", 15000]], ts: 1790000000 },
                   { draw: 3, white: [5, 6, 7, 8], pb: 2, tickets: 6000, winners: 900, paid: 3000000, jackpot: 15000000, jackpot_winners: [], jackpot_paid: 0, won: [], ts: 1789400000 }];
  return { v: 1, source: "pepe", draw: 5, next_at: Date.UTC(2026, 9, 19, 1) / 1000, price: 1000, pot_share: 0.4, pot: 21345678, tickets, history, pending_draw: null,
           totals: { tickets: 30, players: 3, pot: 21345678, history: 2, per_user: { ann: 10, bob: 10, cat: 10 } } };
}
test("cutover: import -> totals match exactly -> backend on; export round-trips; a mismatch keeps nothing; replay is safe", async () => {
  await fresh({ on: false });
  const x = exportFixture();
  // a mismatch (the export claims one more ticket for ann) -> refused, the backend stays empty and off
  const bad = JSON.parse(JSON.stringify(x));
  bad.totals.per_user.ann = 11; bad.totals.tickets = 31;
  const r0 = await svc.importState(bad, "cut-bad", { enable: true });
  assert.equal(r0.ok, false);
  assert.match(r0.error, /mismatch/);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM lotto_tickets"))[0].n, 0);
  assert.equal(await svc.potBalance(), 0);
  assert.equal((await svc.loadSettings(true)).lotto_backend, false);
  // an unknown owner -> refused
  const unk = JSON.parse(JSON.stringify(x)); unk.tickets[0].user = "nobody";
  assert.match((await svc.importState(unk, "cut-unk", {})).error, /no PATV account/);
  // the real one
  const r = await svc.importState(x, "cut-1", { enable: true, actor: "test" });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.totals.tickets, 30); assert.equal(r.totals.pot, 21345678); assert.equal(r.totals.history, 2);
  assert.deepEqual(r.totals.per_user, { ann: 10, bob: 10, cat: 10 });
  assert.equal(r.enabled, true);
  assert.equal((await svc.loadSettings(true)).lotto_backend, true);
  assert.ok((await svc.importState(x, "cut-1", {})).replay, "the same key again: the stored result");
  assert.equal((await svc.importState(x, "cut-2", {})).ok, false, "a second, different import is refused (not empty)");
  const info = await svc.info("u1");
  assert.equal(info.draw, 5); assert.equal(info.mine, 10); assert.equal(info.jackpot, 21345678); assert.equal(info.next_at, x.next_at);
  // the page snapshot carries the history + players keyed like Pepe's
  const snap = await svc.snapshot();
  assert.equal(snap.players.anncf.count, 10); assert.equal(snap.players["@bob"].count, 10); assert.equal(snap.history[0].draw, 4);
  // export (the rollback) = the same totals and tickets
  const out = await svc.exportState();
  assert.ok(out.ok);
  assert.equal(out.pot, x.pot); assert.equal(out.tickets.length, 30); assert.equal(out.draw, 5);
  assert.deepEqual(out.totals.per_user, { ann: 10, bob: 10, cat: 10 });
  const norm = (ts) => ts.map((t) => `${String(t.user).toLowerCase()}|${t.w.slice().sort((a, b) => a - b).join(",")}|${t.pb}`).sort();
  assert.deepEqual(norm(out.tickets), norm(x.tickets));
  // and it keeps selling + drawing on schedule
  assert.ok((await svc.buy(bob, { quick: 2 }, "lt:after")).ok);
  assert.equal((await svc.info("u2")).mine, 12);
});

// ── HTTP ──
test("HTTP: web purchase (JSON fetch only), the /act form path, Pepe's act / poll / pot, Telegram refused, old sync refused", async () => {
  await fresh();
  assert.equal((await post("/api/lotto/buy", { quick: 2, idem: "web-idem-0001" }, null)).status, 401);
  assert.equal((await post("/api/lotto/buy", { quick: 2, idem: "web-idem-0001" }, "u2", false)).status, 400, "no X-Requested-With");
  const w = await post("/api/lotto/buy", { quick: 2, idem: "web-idem-0001" }, "u2");
  assert.equal(w.status, 200); assert.equal(w.json.count, 2);
  const w2 = await post("/api/lotto/buy", { quick: 2, idem: "web-idem-0001" }, "u2");
  assert.ok(w2.json.replay);
  assert.equal(await bal("u2"), 998000);
  const p = await post("/api/lotto/buy", { picks: [[[30, 1, 15, 8], 10]], idem: "web-idem-0002" }, "u2");
  assert.deepEqual(p.json.bought, [[[1, 8, 15, 30], 10]]);
  const msg = await routes.buyFromForm("u3", ["3", "9", "14", "27", "pb", "6"], "form-idem-001");
  assert.match(msg, /1 ticket bought/);
  assert.match(await routes.buyFromForm("u3", ["quick", "3"], "form-idem-002"), /3 tickets bought/);
  // Pepe
  assert.equal((await post("/api/lotto/bot/act", { password: "nope", verb: "info" })).status, 403);
  const a = await post("/api/lotto/bot/act", { password: TOKEN, username: "ann", camfrog: "AnnCF", verb: "quick", args: ["5"], idem: "cf-idem-0001" });
  assert.equal(a.json.count, 5);
  const t = await post("/api/lotto/bot/act", { password: TOKEN, username: "ann", verb: "tickets" });
  assert.equal(t.json.tickets.length, 5);
  assert.equal((await post("/api/lotto/bot/act", { password: TOKEN, username: "ann", verb: "draw", admin: false })).json.code, "admin");
  assert.equal((await post("/api/lotto/bot/act", { password: TOKEN, username: "ann", verb: "quick", channel: "telegram", idem: "tg-idem-0001" })).json.code, "telegram");
  const pl = await post("/api/lotto/bot/poll", { password: TOKEN, after: 0, wait: 0 });
  assert.ok(pl.json.events.some((e) => e.kind === "sale" && e.data.camfrog === "AnnCF" && e.data.count === 5));
  assert.equal(pl.json.state.sold, 12);
  assert.equal((await post("/api/lotto/bot/pot", { password: TOKEN, amount: 5000, ref: "donate-ref-01", why: "donation" })).json.ok, true);
  assert.equal((await post("/api/lotto/bot/state", { password: TOKEN })).json.pot, 12 * 400 + 5000);
  // Pepe's old snapshot push is refused while the backend owns the lotto
  const s = await post("/api/lotto/sync", { password: TOKEN, draw: 9, players: {}, history: [] });
  assert.equal(s.status, 409);
  assert.equal(s.json.backend, true);
  // milestone event at 1,000 tickets
  await setBal("u3", 5000000);
  await post("/api/lotto/bot/act", { password: TOKEN, username: "cat", verb: "quick", args: ["500"], idem: "cf-idem-0002" });
  await post("/api/lotto/bot/act", { password: TOKEN, username: "cat", verb: "quick", args: ["500"], idem: "cf-idem-0003" });
  assert.ok((await getQuery("SELECT 1 FROM lotto_events WHERE kind = 'milestone'")).length);
  // the closing "last call" once, an hour before sales close
  const D = await cur();
  await at(D.close_at - 3000);
  await svc.tick();
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM lotto_events WHERE kind = 'closing'"))[0].n, 1);
  // the page renders from the backend's snapshot (switch off -> the old mirror path still answers)
  const fair = await fetch(base + "/api/lotto/fair/1").then((r) => r.json());
  assert.ok(fair.ok && fair.commitment && fair.server_seed === null, "the seed stays secret until the draw");
});
