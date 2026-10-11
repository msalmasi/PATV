// 1.99ou Phase 2: player-to-player loans on the site (escrow/loans.js) - Pepe's pepe_loan.py P2P rules.
//   * import: offered loans' principal checked against the ledger, active loans carried (nothing held), Reserve loans refused
//   * offer / accept / decline / cancel / repay (cut of the part beyond the principal, routed by loan_interest) / forgive
//   * due-date collection: up to what the borrower has (read in the transaction), daily penalty capped, LATE mark, keeps trying
//   * reserve_id: Pepe's Reserve loans take their L id here (keyed); the website's forms run here, Reserve forms go to Pepe
//   * the /wallet snapshot (wallet_snapshots "loans") follows the records; Pepe's publish keeps his Reserve loans only
//   NODE_PATH=G:/PATV/node_modules node --test test/escrow-loans.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "escrow-loans-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const P = require(path.join(repo, "pools"));
const L = require(path.join(repo, "escrow", "ledger"));
const G = require(path.join(repo, "escrow", "games"));
const LN = require(path.join(repo, "escrow", "loans"));

const bal = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;
const setBal = (id, b) => runQuery("UPDATE users SET points_balance = ? WHERE userId = ?", [b, id]);
const house = async () => (await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM jackpot_rakes"))[0].t;
async function supply() {
  const w = (await getQuery("SELECT COALESCE(SUM(points_balance),0) AS w FROM users"))[0].w;
  const j = await house();
  const snap = (await getQuery("SELECT pools FROM supply_snapshot WHERE id = 1"))[0];
  let rows = snap ? JSON.parse(snap.pools) : [];
  rows = await P.supplyRows(rows);
  rows = await L.supplyRows(rows);
  return { total: w + j + rows.reduce((t, r) => t + r.amount, 0), rows };
}
const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const nowS = () => Math.floor(Date.now() / 1000);

let base, server;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot" }, body)) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const actor = (login, username, extra = {}) => Object.assign({ login, username, admin: false, room: "Lab", via: "room" }, extra);
const act = (verb, a, args, idem) => post("/api/escrow/bot/act", { game: "loans", verb, actor: a, args, idem });
const snapLoans = async () => JSON.parse((await getQuery("SELECT data FROM wallet_snapshots WHERE key = 'loans'"))[0].data);
let cursor = 0;
async function events() {
  const r = await post("/api/escrow/bot/poll", { after: cursor, wait: 0, games: ["loans"] });
  cursor = r.body.cursor;
  return r.body.events;
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, created DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE supply_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), pools TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  for (const [id, name, b, cf, cls] of [["u1", "ann", 100000, "ann_cf", "pleb"], ["u2", "bob", 50000, "bob_cf", "pleb"], ["u3", "carol", 0, "carol_cf", "pleb"],
                                        ["u4", "adm", 0, "boss", "Admin"], ["u5", "web", 20000, null, "pleb"], ["u6", "dan", 0, "dan_cf", "pleb"]]) {
    await runQuery("INSERT INTO users (userId, username, password, points_balance, camfrogUsername, class) VALUES (?, ?, 'x', ?, ?, ?)", [id, name, b, cf, cls]);
  }
  await runQuery("INSERT INTO supply_snapshot (id, pools) VALUES (1, '[]')");
  await require(path.join(repo, "funding")).init();
  await P.init();
  L._setSupplyFn(supply);
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const deps = { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() };
  P.register(app, deps);
  L.register(app, deps);
  G.register(app, deps);
  require(path.join(repo, "wallet")).register(app, deps);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  // the pools live (Phase 1), then the ledger: L3's principal (ann 5000) held by Pepe
  await P._setMeta("live", true);
  P._forgetLive();
  await P.move({ key: "seed-pools", legs: [["reserve", 100000], ["bank", 1000]], flow: "test", kind: "admin" });
  await L.setMeta("enabled", true);
  const holds = [{ id: "h50", ref: "L3", user: "ann", nick: "ann_cf", amount: 5000 }];
  const payload = JSON.stringify({ v: 1, holds, seq: 50, supply: [{ key: "escrow:holds", amount: 5000 }] });
  const r = await post("/api/escrow/admin/import", { key: "ec-l-0001", payload, digest: sha(payload), totals: { sum: 5000, count: 1, per_kind: { L: 5000 } } });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  await post("/api/escrow/bot/fee-plans", { plans: { k: 1, shares: { loan_interest: [["bank", 100]] } } });
});
test.after(() => server && server.close());

const T = nowS();
const EXPORT = {
  v: 1, seq: 7, loans: [
    { id: 3, lender: "ann_cf", borrower: "bob_cf", principal: 5000, rate: 10, term: 86400, owed: 5500, paid: 0, penalty: 0, status: "offered",
      room: "Lab", created: T, offer_until: T + 600, holds: { principal: "h50" }, payments: [], users: { lender: "ann" } },
    // active and 2.5 days overdue, the borrower (carol) broke
    { id: 5, lender: "bob_cf", borrower: "carol_cf", principal: 10000, rate: 10, term: 86400, owed: 11000, paid: 0, penalty: 0, status: "active",
      room: "Lab", created: T - 4 * 86400, accepted: T - 3.5 * 86400, due: T - 2.5 * 86400, holds: { principal: "h40" }, payments: [] },
    { id: 6, lender: "ann_cf", borrower: "bob_cf", principal: 2000, rate: 0, term: 86400, owed: 2000, paid: 2000, status: "repaid",
      created: T - 9 * 86400, ended: T - 8 * 86400, holds: { principal: "h41" }, payments: [{ hold: "h42", amount: 2000, interest: 0, source: "repay", ts: T - 8 * 86400 }] },
  ],
};
const gpack = (x, totals, key) => { const payload = JSON.stringify(x); return { game: "loans", key, payload, digest: sha(payload), totals }; };

test("import: switch off -> refused; a Reserve loan / a mid-step loan refused; totals = offered principal", async () => {
  assert.equal((await post("/api/escrow/admin/game-import", gpack(EXPORT, { sum: 5000, count: 2 }, "gc-l-1"))).body.code, "E_FEATURE_OFF");
  await L.setMeta("enabled:loans", true);
  const fed = JSON.parse(JSON.stringify(EXPORT));
  fed.loans.push({ id: 7, lender: "🏛️ Federal Reserve", borrower: "dan_cf", principal: 1000, owed: 1100, status: "active", reserve: true, due: T });
  assert.equal((await post("/api/escrow/admin/game-import", gpack(fed, { sum: 5000, count: 3 }, "gc-l-1"))).body.code, "E_BAD_RECORD");
  const busy = JSON.parse(JSON.stringify(EXPORT));
  busy.loans[0].status = "accepting";
  assert.equal((await post("/api/escrow/admin/game-import", gpack(busy, { sum: 0, count: 1 }, "gc-l-1"))).body.code, "E_BUSY");
  assert.equal((await post("/api/escrow/admin/game-import", gpack(EXPORT, { sum: 4000, count: 2 }, "gc-l-1"))).body.code, "E_TOTALS");
  const r = await post("/api/escrow/admin/game-import", gpack(EXPORT, { sum: 5000, count: 2 }, "gc-l-1"));
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.seq, 7);
  assert.equal(await G.gameLive("loans"), true);
  const snap = await snapLoans();
  assert.deepEqual(snap.loans.map((l) => [l.id, l.status]).sort(), [[3, "offered"], [5, "active"], [6, "repaid"]]);
});

test("accept: the principal goes to the borrower; keyed; decline / cancel refund the lender", async () => {
  const b0 = await bal("u2");
  assert.equal((await act("accept", actor("carol_cf", "carol"), { ref: "L3" }, "idem-l-a0")).body.code, "not_yours");
  const a = await act("accept", actor("bob_cf", "bob"), { ref: "L3" }, "idem-l-a1");
  assert.equal(a.body.ok, true, JSON.stringify(a.body));
  assert.equal(a.body.loan.status, "active");
  assert.equal(a.body.loan.due, a.body.loan.accepted + 86400);
  assert.equal(await bal("u2"), b0 + 5000);
  assert.equal((await act("accept", actor("bob_cf", "bob"), { ref: "L3" }, "idem-l-a1")).body.dup, true);
  assert.equal(await bal("u2"), b0 + 5000);
  assert.equal((await L.holdsByIds(["h50"]))[0].state, "spent");
  // a new offer: the next id comes after Pepe's sequence
  const a0 = await bal("u1");
  const o = await act("offer", actor("ann_cf", "ann"), { borrower: { login: "dan_cf" }, principal: 3000, rate: 12.5, secs: 7 * 86400, room: "Lab" }, "idem-l-o1");
  assert.equal(o.body.ok, true, JSON.stringify(o.body));
  assert.equal(o.body.ref, "L8");
  assert.equal(o.body.loan.owed, 3375);
  assert.equal(await bal("u1"), a0 - 3000);
  assert.equal((await act("offer", actor("ann_cf", "ann"), { borrower: { login: "dan_cf" }, principal: 3000, rate: 12.5, secs: 7 * 86400 }, "idem-l-o2")).body.code, "dup");
  assert.equal((await act("cancel", actor("bob_cf", "bob"), { ref: "L8" }, "idem-l-c0")).body.code, "not_yours");
  assert.equal((await act("decline", actor("dan_cf", "dan"), { ref: "L8" }, "idem-l-d1")).body.ok, true);
  assert.equal(await bal("u1"), a0);
  await act("offer", actor("ann_cf", "ann"), { borrower: { login: "dan_cf" }, principal: 1000, rate: 0, secs: 3600 }, "idem-l-o3");
  assert.equal((await act("cancel", actor("ann_cf", "ann"), { ref: "L9" }, "idem-l-c1")).body.loan.status, "cancelled");
  assert.equal(await bal("u1"), a0);
  // validation (nothing written)
  assert.equal((await act("offer", actor("ann_cf", "ann"), { borrower: { login: "ANN_CF" }, principal: 5000, rate: 1, secs: 3600 }, "idem-l-v1")).body.code, "self");
  assert.equal((await act("offer", actor("ann_cf", "ann"), { borrower: { login: "dan_cf" }, principal: 999, rate: 1, secs: 3600 }, "idem-l-v2")).body.code, "min");
  assert.equal((await act("offer", actor("ann_cf", "ann"), { borrower: { login: "dan_cf" }, principal: 5000, rate: 51, secs: 3600 }, "idem-l-v3")).body.code, "max_rate");
  assert.equal((await act("offer", actor("ann_cf", "ann"), { borrower: { login: "dan_cf" }, principal: 5000, rate: 1, secs: 60 }, "idem-l-v4")).body.code, "bad_term");
  assert.equal((await act("offer", actor("carol_cf", "carol"), { borrower: { login: "dan_cf" }, principal: 5000, rate: 1, secs: 3600 }, "idem-l-v5")).body.code, "insufficient");
  const ev = await events();
  assert.deepEqual(ev.map((e) => e.kind), ["accepted", "offered", "declined", "offered", "cancelled"]);
});

test("repay: partial then the rest; the cut is 10% of what's beyond the principal, routed by loan_interest", async () => {
  // L3: 5000 at 10% -> owes 5500
  const a0 = await bal("u1"), b0 = await bal("u2"), k0 = (await P.balances()).bank;
  const p1 = await act("repay", actor("bob_cf", "bob"), { ref: "L3", amount: 4000 }, "idem-l-r1");
  assert.equal(p1.body.ok, true, JSON.stringify(p1.body));
  assert.equal(p1.body.left, 1500);
  assert.equal(await bal("u1"), a0 + 4000);           // all principal: no cut
  assert.equal(await bal("u2"), b0 - 4000);
  const p2 = await act("repay", actor("bob_cf", "bob"), { ref: "L3", amount: 99999 }, "idem-l-r2");   // capped at what's left
  assert.equal(p2.body.paid, 1500);
  assert.equal(p2.body.loan.status, "repaid");
  // 1000 principal + 500 interest: cut 50 -> the Bank
  assert.equal(p2.body.cut, 50);
  assert.equal(await bal("u1"), a0 + 4000 + 1450);
  assert.equal((await P.balances()).bank, k0 + 50);
  assert.equal((await L.heldTotal()).count, 0);        // every payment hold settled in its own transaction
  assert.equal((await act("repay", actor("bob_cf", "bob"), { ref: "L3" }, "idem-l-r3")).body.code, "not_yours");
  const ev = await events();
  assert.deepEqual(ev.map((e) => e.kind), ["paid", "repaid"]);
  const snap = await snapLoans();
  assert.equal(snap.loans.find((l) => l.id === 3).status, "repaid");
});

test("collection: penalties per full day (capped), LATE mark, takes up to the balance, keeps trying, pays off", async () => {
  const s0 = (await supply()).total;
  await G.tick();
  let ln = await G.load("loans", 5);
  assert.equal(ln.penalty_days, 2);
  assert.equal(ln.penalty, 220 + 224);
  assert.equal(ln.owed, 11444);
  assert.equal(ln.late, true);
  assert.equal(ln.was_late, true);
  assert.equal(ln.paid, 0);
  assert.ok(ln.next_collect > nowS());
  assert.deepEqual((await events()).map((e) => [e.kind, e.data.took]), [["late", 0]]);
  // not again until next_collect
  await setBal("u3", 3000);
  await G.tick();
  assert.equal((await G.load("loans", 5)).paid, 0);
  ln.next_collect = 0;
  await G.save("loans", ln);
  const b0 = await bal("u2");
  await G.tick();
  ln = await G.load("loans", 5);
  assert.equal(ln.paid, 3000);
  assert.equal(await bal("u3"), 0);
  assert.equal(await bal("u2"), b0 + 3000);
  assert.equal(ln.payments[0].source, "auto-collect");
  assert.deepEqual((await events()).map((e) => [e.kind, e.data.took]), [["collected", 3000]]);
  // the rest: 7000 principal + 1444 beyond it -> cut 144
  await setBal("u3", 20000);
  ln.next_collect = 0;
  await G.save("loans", ln);
  const k0 = (await P.balances()).bank;
  await G.tick();
  ln = await G.load("loans", 5);
  assert.equal(ln.status, "repaid");
  assert.equal(ln.late, false);
  assert.equal(await bal("u3"), 20000 - 8444);
  assert.equal(await bal("u2"), b0 + 3000 + 8444 - 144);
  assert.equal((await P.balances()).bank, k0 + 144);
  assert.deepEqual((await events()).map((e) => [e.kind, e.data.took]), [["collected_paid", 8444]]);
  // money only moved between wallets and the Bank (the supply total adds the 3000 + 20000 the test minted)
  assert.equal((await supply()).total, s0 + 23000);
});

test("penalty cap: 50% of the principal at most", async () => {
  const o = await act("offer", actor("ann_cf", "ann"), { borrower: { login: "dan_cf" }, principal: 1200, rate: 0, secs: 3600 }, "idem-l-o10");
  await act("accept", actor("dan_cf", "dan"), { ref: o.body.ref }, "idem-l-a10");
  await setBal("u6", 0);
  const ln = await G.load("loans", o.body.loan.id);
  ln.due = nowS() - 60 * 86400;
  await G.save("loans", ln);
  await G.tick();
  const after = await G.load("loans", ln.id);
  assert.equal(after.penalty, 600);
  assert.equal(after.owed, 1800);
  assert.equal(after.penalty_days, 60);
  // forgive: lender only
  assert.equal((await act("forgive", actor("dan_cf", "dan"), { ref: o.body.ref }, "idem-l-f0")).body.code, "not_yours");
  const f = await act("forgive", actor("ann_cf", "ann"), { ref: o.body.ref }, "idem-l-f1");
  assert.equal(f.body.left, 1800);
  assert.equal(f.body.loan.status, "forgiven");
  assert.equal(f.body.loan.late, false);
  await events();
});

test("offer expiry on the tick refunds the lender; reserve_id is Pepe's and keyed", async () => {
  const a0 = await bal("u1");
  const o = await act("offer", actor("ann_cf", "ann"), { borrower: { login: "bob_cf" }, principal: 2000, rate: 5, secs: 3600 }, "idem-l-o20");
  const ln = await G.load("loans", o.body.loan.id);
  ln.offer_until = 1;
  await G.save("loans", ln);
  await G.tick();
  assert.equal((await G.load("loans", ln.id)).status, "expired");
  assert.equal(await bal("u1"), a0);
  assert.deepEqual((await events()).map((e) => e.kind), ["offered", "expired"]);
  assert.equal((await act("reserve_id", actor("bob_cf", "bob"), {}, "idem-rid-0")).body.code, "not_pepe");
  const r1 = await act("reserve_id", actor("pepe", null, { pepe: true }), {}, "rid-abc-1");
  const r2 = await act("reserve_id", actor("pepe", null, { pepe: true }), {}, "rid-abc-1");
  assert.equal(r1.body.id, r2.body.id);
  const o2 = await act("offer", actor("ann_cf", "ann"), { borrower: { login: "bob_cf" }, principal: 1000, rate: 5, secs: 3600 }, "idem-l-o21");
  assert.equal(o2.body.loan.id, r1.body.id + 1);
  await act("cancel", actor("ann_cf", "ann"), { ref: o2.body.ref }, "idem-l-c21");
  await events();
});

test("max open: P2P + Pepe's Reserve loans (his count, or his published book)", async () => {
  await runQuery("UPDATE wallet_snapshots SET data = ? WHERE key = 'loans'", [JSON.stringify(Object.assign(await snapLoans(), {
    loans: (await snapLoans()).loans.concat([{ id: 2, lender: "🏛️ Federal Reserve", borrower: "dan_cf", principal: 1000, owed: 1100, paid: 0, status: "active", reserve: true }]) }))]);
  const r = await act("offer", actor("ann_cf", "ann"), { borrower: { login: "dan_cf" }, principal: 1100, rate: 0, secs: 3600 }, "idem-l-m1");
  assert.equal(r.body.ok, true);                       // 1 open (Reserve) < 5
  const full = await act("offer", actor("bob_cf", "bob"), { borrower: { login: "dan_cf" }, principal: 1300, rate: 0, secs: 3600, reserve_open: 3 }, "idem-l-m2");
  assert.equal(full.body.ok, true);                    // Pepe's count (3) + 1 P2P = 4 < 5
  const over = await act("offer", actor("ann_cf", "ann"), { borrower: { login: "dan_cf" }, principal: 1400, rate: 0, secs: 3600, reserve_open: 3 }, "idem-l-m3");
  assert.equal(over.body.code, "max_open");            // 3 + 2 P2P = 5
  for (const ref of [r.body.ref, full.body.ref]) {
    const ln = await G.load("loans", Number(ref.slice(1)));
    await act("cancel", actor(ln.lender, null), { ref }, "idem-l-mc-" + ref);
  }
  await events();
});

test("website forms: P2P runs here, Reserve forms and unknown refs go to Pepe; the snapshot keeps Pepe's Reserve loans", async () => {
  assert.equal(await G.fromForm("u5", "loan", ["reserve", "5000", "7d"], "form-l-001"), null);
  assert.equal(await G.fromForm("u5", "loan", ["request", "5000", "7d", "why"], "form-l-002"), null);
  assert.equal(await G.fromForm("u5", "loan", ["repay", "L2", ""], "form-l-003"), null);       // a Reserve loan (not here)
  assert.match(await G.fromForm("u5", "loan", ["@nobody_here", "5k", "10%", "7d"], "form-l-004"), /don't know who/);
  const msg = await G.fromForm("u5", "loan", ["@carol_cf", "5k", "10%", "3d"], "form-l-005");
  assert.match(msg, /offered to carol_cf: PAT 5,000 at 10%, pay back PAT 5,500 within 3d/);
  assert.equal(await bal("u5"), 15000);
  const ln = (await G.list("loans", ["offered"])).find((l) => l.lender === "web");
  assert.ok(ln);
  const ev = await events();
  assert.equal(ev[0].kind, "offered");
  assert.equal(ev[0].data.via, "web");
  // carol accepts from chat, the web user cancels nothing; carol repays from the website (her account u3 has 11556)
  await act("accept", actor("carol_cf", "carol"), { ref: `L${ln.id}` }, "idem-l-wa");
  assert.match(await G.fromForm("u3", "loan", ["repay", `L${ln.id}`, ""], "form-l-006"), /paid off loan/);
  assert.equal(await bal("u5"), 15000 + 5500 - 50);
  // Pepe's publish: his P2P rows are dropped for the site's, his Reserve loans kept
  const r = await post("/api/wallet/loans", { loans: [{ id: 2, lender: "🏛️ Federal Reserve", borrower: "dan_cf", principal: 1000, owed: 1100, status: "active", reserve: true },
                                                      { id: 3, lender: "ann_cf", borrower: "bob_cf", principal: 5000, owed: 5500, status: "active" }], requests: [], reserve: {} });
  assert.equal(r.status, 200);
  const snap = await snapLoans();
  assert.equal(snap.loans.find((l) => l.id === 3).status, "repaid");
  assert.ok(snap.loans.find((l) => l.id === 2 && l.reserve));
  assert.ok(snap.loans.find((l) => l.id === ln.id && l.status === "repaid"));
});

test("rollback hands the records back (keyed), seq included", async () => {
  await act("offer", actor("ann_cf", "ann"), { borrower: { login: "bob_cf" }, principal: 4000, rate: 5, secs: 3600 }, "idem-l-rb");
  const rb = await post("/api/escrow/admin/game-rollback", { game: "loans", key: "gr-l-1" });
  assert.equal(rb.body.ok, true, JSON.stringify(rb.body));
  assert.equal(rb.body.count, 1);
  assert.equal(rb.body.sum, 4000);
  assert.equal(rb.body.seq, Math.max(...rb.body.records.map((r) => r.id)));
  assert.equal((await post("/api/escrow/admin/game-rollback", { game: "loans", key: "gr-l-1" })).body.dup, true);
  assert.equal(await G.gameLive("loans"), false);
  assert.equal(await G.fromForm("u5", "loan", ["@carol_cf", "5k", "10%", "3d"], "form-l-007"), null);
});
