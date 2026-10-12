// 1.99ou Phase 2: the parimutuel BETTING POOLS on the site (escrow/pools.js on escrow/ledger.js + escrow/games.js).
//   * the money is Pepe's _market_pay to the PAT: test/fixtures/pool-payout-vectors.json is what the real Python function paid on
//     fixed pools (bot repo escrow_pool_test.py --write) - the engine's payoutPlan AND a real settle through the ledger must match
//   * the cutover: Pepe's live pools (their bets' holds already on the ledger) import with their totals checked; the display table
//     (`markets`) gets the rows the /wagers and /markets pages read
//   * create / bet / settle / void / cancel / deadlines / AI-judge state; keyed acts; events for Pepe; the website's /act form and the
//     /markets/:id bet + resolve forms run on the engine (nothing queued); reserve_id hands Pepe's LMSR markets their M ids;
//     /api/markets/sync never overwrites a site pool row; rollback hands the records back
//   NODE_PATH=G:/PATV/node_modules node --test test/escrow-pools.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "escrow-pools-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const P = require(path.join(repo, "pools"));
const L = require(path.join(repo, "escrow", "ledger"));
const G = require(path.join(repo, "escrow", "games"));
const E = require(path.join(repo, "escrow", "pools"));
const VECTORS = require(path.join(repo, "test", "fixtures", "pool-payout-vectors.json")).vectors;

const bal = async (id) => Number((await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b);
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
const post = (p, body, headers = {}) => fetch(base + p, { method: "POST", redirect: "manual", headers: Object.assign({ "content-type": "application/json" }, headers),
                                                          body: JSON.stringify(Object.assign({ password: "bot" }, body)) })
  .then(async (r) => ({ status: r.status, location: r.headers.get("location"), body: await r.json().catch(() => null) }));
const actor = (login, username, extra = {}) => Object.assign({ login, username, admin: false, room: "Lab", via: "room" }, extra);
const PEPE = actor("PepeBot", "pepebot", { pepe: true });
let idemN = 0;
const act = (verb, a, args, idem) => post("/api/escrow/bot/act", { game: "pools", verb, actor: a, args, idem: idem || `idem-p-${++idemN}` });
const poolRow = async (id) => { const r = (await getQuery("SELECT data FROM markets WHERE id = ?", [id]))[0]; return r ? JSON.parse(r.data) : null; };
const mm = async () => (await P.balances()).mm || 0;

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, created DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE supply_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), pools TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("INSERT INTO supply_snapshot (id, pools) VALUES (1, '[]')");
  for (const [id, name, b, cf, cls, ban] of [["u1", "ann", 100000, "ann_cf", "pleb", 0], ["u2", "bob", 100000, "bob_cf", "pleb", 0],
                                             ["u3", "carol", 1000, "carol_cf", "pleb", 0], ["u4", "adm", 0, "boss", "Admin", 0],
                                             ["u5", "web", 9000, null, "pleb", 0], ["u6", "dave", 600, "dave_cf", "pleb", 0], ["u7", "banned", 50000, "bad_cf", "pleb", 1]]) {
    await runQuery("INSERT INTO users (userId, username, password, points_balance, camfrogUsername, class, casino_banned) VALUES (?, ?, 'x', ?, ?, ?, ?)", [id, name, b, cf, cls, ban]);
  }
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES ('seed', 's', NULL, 1000000)");
  await require(path.join(repo, "funding")).init();
  await P.init();
  L._setSupplyFn(supply);
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const deps = { isBotToken: (t) => t === "bot", addUser: (req, res, next) => { const u = req.get("x-user"); if (u) req.user = { userId: u }; next(); } };
  P.register(app, deps);
  L.register(app, deps);
  G.register(app, deps);
  require(path.join(repo, "markets")).register(app, deps);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
  // Phase 1 live, then the ledger: Pepe's pool M3 has two bets (h10, h11) held in escrow
  await P._setMeta("live", true);
  P._forgetLive();
  await P.move({ key: "seed-pools", legs: [["reserve", 100000], ["mm", 10]], flow: "test", kind: "admin" });
  await L.setMeta("enabled", true);
  const holds = [{ id: "h10", ref: "M3", user: "ann", nick: "ann_cf", amount: 2000 }, { id: "h11", ref: "M3", user: "bob", nick: "bob_cf", amount: 3000 }];
  const payload = JSON.stringify({ v: 1, source: "pepe", holds, seq: 11, supply: [{ key: "escrow:holds", label: "h", amount: 5000 }] });
  const r = await post("/api/escrow/admin/import", { key: "ec-p-0001", payload, digest: sha(payload), totals: { sum: 5000, count: 2, per_kind: { M: 5000 } } });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
});
test.after(() => server && server.close());

test("payoutPlan = Pepe's _market_pay on every vector, to the PAT", () => {
  assert.ok(VECTORS.length >= 10);
  for (const v of VECTORS) {
    const m = { options: v.options, bets: v.bets.map((b) => ({ nick: b.nick, option: b.option, amount: b.amount })) };
    const p = E.payoutPlan(m, v.result);
    assert.equal(p.refund_all, v.expect.refund_all, v.name);
    assert.deepEqual(p.payouts, v.expect.payouts, v.name);
    assert.equal(p.fee, v.expect.fee, v.name);
    assert.equal(p.refund_all ? (v.result ? "settled" : "void") : "settled", v.expect.status, v.name);
  }
});

test("the pools cutover: every bet checked against the ledger; the display table gets the rows", async () => {
  const rec = { id: 3, question: "Will it rain Friday?", options: ["yes", "no"], creator: "ann_cf", judge: "carol_cf", room: "Lab", status: "open",
                created: nowS() - 100, closes: nowS() + 86400, model: "pool",
                bets: [{ nick: "ann_cf", option: "yes", amount: 2000, hold: "h10", ts: nowS() - 90, user: "ann" },
                       { nick: "bob_cf", option: "no", amount: 3000, hold: "h11", ts: nowS() - 80, user: "bob" }] };
  const bad = JSON.stringify({ pools: [Object.assign({}, rec, { bets: [Object.assign({}, rec.bets[0], { amount: 2500 }), rec.bets[1]] })], seq: 11 });
  assert.equal((await post("/api/escrow/admin/game-import", { game: "pools", key: "gc-p-1", payload: bad, digest: sha(bad), totals: { sum: 5500, count: 1 } })).body.code,
               "E_FEATURE_OFF");
  await L.setMeta("enabled:pools", true);
  assert.equal((await post("/api/escrow/admin/game-import", { game: "pools", key: "gc-p-1", payload: bad, digest: sha(bad), totals: { sum: 5500, count: 1 } })).body.code,
               "E_HOLDS");
  const busy = JSON.stringify({ pools: [Object.assign({}, rec, { status: "settling" })], seq: 11 });
  assert.equal((await post("/api/escrow/admin/game-import", { game: "pools", key: "gc-p-2", payload: busy, digest: sha(busy), totals: { sum: 5000, count: 1 } })).body.code,
               "E_BUSY");
  const lm = JSON.stringify({ pools: [Object.assign({}, rec, { model: "lmsr" })], seq: 11 });
  assert.equal((await post("/api/escrow/admin/game-import", { game: "pools", key: "gc-p-3", payload: lm, digest: sha(lm), totals: { sum: 5000, count: 1 } })).body.code,
               "E_BAD_RECORD");
  const ok = JSON.stringify({ v: 1, source: "pepe", pools: [rec], seq: 11 });
  const r = await post("/api/escrow/admin/game-import", { game: "pools", key: "gc-p-4", payload: ok, digest: sha(ok), totals: { sum: 5000, count: 1 } });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.seq, 11);
  assert.equal(await G.gameLive("pools"), true);
  const row = await poolRow(3);
  assert.equal(row.model, "pool");
  assert.equal(row.bets.length, 2);
  assert.equal(row.bets[0].hold, undefined);                       // the page's shape: no hold ids
});

test("create: Pepe's rules (judge, options, window, question, double post, max open) - no money moves", async () => {
  assert.equal((await act("create", actor("ann_cf", "ann"), { question: "Will it snow?", secs: 3600 })).body.code, "no_judge");
  assert.equal((await act("create", actor("ann_cf", "ann"), { question: "Will it snow?", judge: { login: "carol_cf" }, secs: 60 })).body.code, "bad_secs");
  assert.equal((await act("create", actor("ann_cf", "ann"), { question: "Will it snow?", judge: { login: "carol_cf" }, options: ["a"] })).body.code, "bad_options");
  assert.equal((await act("create", actor("ann_cf", "ann"), { question: "Wh?", judge: { login: "carol_cf" } })).body.code, "no_question");
  assert.equal((await act("create", actor("bad_cf", "banned"), { question: "Will it snow?", judge: { login: "carol_cf" } })).body.code, "banned");
  const b0 = await bal("u1");
  const c = await act("create", actor("ann_cf", "ann"), { question: "  Will it snow?  ", options: ["Snow", "No snow", "snow"], judge: { login: "@carol_cf" },
                                                          secs: 7200, room: "Lab" });
  assert.equal(c.body.ok, true, JSON.stringify(c.body));
  assert.equal(c.body.ref, "M12");                                 // after Pepe's sequence (11)
  assert.deepEqual(c.body.pool.options, ["Snow", "No snow", "snow"]);
  assert.equal(c.body.pool.judge, "carol_cf");
  assert.equal(await bal("u1"), b0);
  const d = await act("create", actor("ann_cf", "ann"), { question: "will it SNOW", options: ["snow", "no snow", "Snow"], judge: { login: "carol_cf" } });
  assert.equal(d.body.code, "dup");
  assert.equal(d.body.ref, "M12");
  // max open: ann has M3 + M12 here; with 3 LMSR markets of hers on Pepe that's 5
  assert.equal((await act("create", actor("ann_cf", "ann"), { question: "Another one?", judge: { login: "carol_cf" }, lmsr_open: 3 })).body.code, "max_open");
  assert.equal((await act("create", actor("ann_cf", "ann"), { question: "Another one?", judge: { login: "carol_cf" }, lmsr_open: 2 })).body.ok, true);
  assert.equal((await poolRow(12)).status, "open");
});

test("reserve_id: Pepe's LMSR markets take their ids from the same sequence (keyed)", async () => {
  assert.equal((await act("reserve_id", actor("ann_cf", "ann"), {})).body.code, "not_pepe");
  const a = await act("reserve_id", PEPE, {}, "rid-aaaa-1");
  assert.equal(a.body.ok, true);
  assert.equal(a.body.id, 14);
  assert.equal((await act("reserve_id", PEPE, {}, "rid-aaaa-1")).body.id, 14);   // a retry: the same id
  assert.equal((await act("reserve_id", PEPE, {}, "rid-aaaa-2")).body.id, 15);
  // Pepe's snapshot: his LMSR rows land; a pool row (or an LMSR row on a pool's id) never overwrites the engine's
  const s = await post("/api/markets/sync", { markets: [{ id: 14, model: "lmsr", question: "BTC?", options: ["Yes", "No"], status: "open", closes: nowS() + 99 },
                                                        { id: 12, model: "pool", question: "stale", options: ["a", "b"], status: "void" },
                                                        { id: 3, model: "lmsr", question: "clash", options: ["Yes", "No"], status: "open" }] });
  assert.equal(s.status, 200);
  assert.equal((await poolRow(14)).model, "lmsr");
  assert.equal((await poolRow(12)).status, "open");
  assert.equal((await poolRow(12)).question, "Will it snow?");
  assert.equal((await poolRow(3)).model, "pool");
  // max open counts Pepe's LMSR markets too (the display table's, for a website create): ann has M3, M12, M13 + two LMSR = 5
  const r16 = (await act("reserve_id", PEPE, {}, "rid-aaaa-3")).body.id, r17 = (await act("reserve_id", PEPE, {}, "rid-aaaa-4")).body.id;
  const lm = (id, status) => ({ id, model: "lmsr", creator: "ann_cf", question: `LMSR ${id}`, options: ["Yes", "No"], status, closes: nowS() + 99 });
  await post("/api/markets/sync", { markets: [lm(r16, "open"), lm(r17, "closed")] });
  assert.equal((await act("create", actor("ann_cf", "ann"), { question: "One too many?", judge: { login: "carol_cf" } })).body.code, "max_open");
  await post("/api/markets/sync", { markets: [lm(r16, "settled"), lm(r17, "void")] });
});

test("bet: Pepe's checks in his order; each bet its own hold; a refused bet changes nothing", async () => {
  assert.equal((await act("bet", actor("carol_cf", "carol"), { ref: "M12", option: "snow", amount: 1000 })).body.code, "judge");
  assert.equal((await act("bet", actor("bad_cf", "banned"), { ref: "M12", option: "snow", amount: 1000 })).body.code, "banned");
  const amb = await act("bet", actor("bob_cf", "bob"), { ref: "M12", option: "s", amount: 1000 });     // "s" starts two options
  assert.equal(amb.body.code, "bad_option");
  assert.equal(amb.body.error, "M12 options are: Snow / No snow / snow.");
  assert.equal((await act("bet", actor("bob_cf", "bob"), { ref: "M12", option: "snow", amount: 499 })).body.code, "min");
  const seq0 = await L.meta("seq");
  const poor = await act("bet", actor("dave_cf", "dave"), { ref: "M12", option: "no", amount: 1000 });
  assert.equal(poor.body.code, "insufficient");
  assert.match(poor.body.error, /that needs PAT 1,000 and dave_cf has 600/);
  assert.equal(await L.meta("seq"), seq0);                          // rolled back: no hold id drawn
  assert.equal(await bal("u6"), 600);
  const b0 = await bal("u2");
  const b = await act("bet", actor("bob_cf", "bob"), { ref: "m12", option: "NO", amount: 4000 }, "idem-bet-1");
  assert.equal(b.body.ok, true, JSON.stringify(b.body));
  assert.equal(b.body.option, "No snow");                           // "no" starts only "No snow"
  assert.equal(b.body.mine, 4000);
  assert.equal((await act("bet", actor("bob_cf", "bob"), { ref: "m12", option: "NO", amount: 4000 }, "idem-bet-1")).body.dup, true);
  assert.equal(await bal("u2"), b0 - 4000);
  await act("bet", actor("bob_cf", "bob"), { ref: "M12", option: "no snow", amount: 1000 });
  const a = await act("bet", actor("ann_cf", "ann"), { ref: "M12", option: "Snow", amount: 2500 });
  assert.equal(a.body.pool.bets.length, 3);
  const holds = await L.holdsByIds(a.body.pool.bets.map((x) => x.hold));
  assert.deepEqual(holds.map((h) => [h.ref, h.amount, h.state]), [["M12", 4000, "held"], ["M12", 1000, "held"], ["M12", 2500, "held"]]);
  assert.equal((await poolRow(12)).bets.length, 3);
});

test("settle: winners split the losing pot pro rata minus 5% routed by market_fee; events for Pepe", async () => {
  await post("/api/escrow/bot/fee-plans", { plans: { k: 1, shares: { market_fee: [["mm", 60], ["fortknox", 40]] } } });
  assert.equal((await act("settle", actor("ann_cf", "ann"), { ref: "M12", outcome: "snow" })).body.code, "not_judge");
  assert.equal((await act("settle", actor("carol_cf", "carol"), { ref: "M12", outcome: "hail" })).body.code, "bad_option");
  const s0 = (await supply()).total;
  const a0 = await bal("u1"), m0 = await mm(), fk0 = (await P.balances()).fortknox || 0;
  // Snow 2,500 (ann) vs No snow 5,000 (bob): lose 5,000 -> fee 250, ann 2,500 + 4,750 = 7,250
  const s = await act("settle", actor("carol_cf", "carol"), { ref: "M12", outcome: "Snow" });
  assert.equal(s.body.ok, true, JSON.stringify(s.body));
  assert.equal(s.body.kind, "settled");
  assert.deepEqual(s.body.payouts, [["ann_cf", 7250]]);
  assert.equal(s.body.fee, 250);
  assert.equal(await bal("u1"), a0 + 7250);
  assert.equal(await mm(), m0 + 150);
  assert.equal((await P.balances()).fortknox, fk0 + 100);
  assert.equal((await supply()).total, s0);
  assert.equal(s.body.pool.status, "settled");
  assert.equal((await poolRow(12)).result, "Snow");
  assert.equal((await act("settle", actor("carol_cf", "carol"), { ref: "M12", outcome: "Snow" })).body.code, "done");
  const ev = await post("/api/escrow/bot/poll", { after: 0, wait: 0, games: ["pools"] });
  const kinds = ev.body.events.map((e) => e.kind);
  assert.deepEqual(kinds.filter((k) => k !== "created"), ["bet", "bet", "bet", "settled"]);
  const last = ev.body.events[ev.body.events.length - 1].data;
  assert.equal(last.ref, "M12");
  assert.deepEqual(last.payouts, [["ann_cf", 7250]]);
  assert.equal(last.by, "carol_cf");
});

test("every vector through the real engine + ledger: the wallets and the fee move exactly as Pepe paid", async () => {
  await post("/api/escrow/bot/fee-plans", { plans: { k: 1, shares: { market_fee: [["mm", 100]] } } });
  const users = {};
  for (const v of VECTORS) for (const b of v.bets) {
    const k = b.nick.toLowerCase();
    if (users[k]) continue;
    users[k] = `vu-${k}`;
    await runQuery("INSERT INTO users (userId, username, password, points_balance, camfrogUsername) VALUES (?, ?, 'x', ?, ?)",
                   [users[k], `v_${k}`, 10 ** 13, `vec_${k}`]);
  }
  let i = 0;
  for (const v of VECTORS) {
    i++;
    if (v.bets.some((b) => b.amount < E.MIN_BET)) continue;          // a pure-maths vector (bets below the minimum): payoutPlan covers it
    const c = await act("create", actor("boss", "adm", { admin: true }), { question: `Vector ${i}: ${v.name}`, options: v.options, judge: { login: "carol_cf" }, secs: 3600 });
    assert.equal(c.body.ok, true, `${v.name}: ${JSON.stringify(c.body)}`);
    const ref = c.body.ref;
    for (const b of v.bets) {
      const r = await act("bet", actor(`vec_${b.nick}`, `v_${b.nick.toLowerCase()}`),
                          { ref, option: b.option, amount: b.amount });
      assert.equal(r.body.ok, true, `${v.name}: ${JSON.stringify(r.body)}`);
    }
    const before = {};
    for (const k of Object.keys(users)) before[k] = await bal(users[k]);
    const m0 = await mm();
    const s0 = (await supply()).total;
    const s = await act("settle", actor("carol_cf", "carol"), { ref, outcome: v.result == null ? "void why not" : v.result });
    assert.equal(s.body.ok, true, `${v.name}: ${JSON.stringify(s.body)}`);
    assert.equal(s.body.pool.status, v.expect.status, v.name);
    assert.equal(s.body.fee, v.expect.fee, v.name);
    assert.deepEqual(s.body.payouts.map(([n, a]) => [n.replace(/^vec_/, ""), a]), v.expect.payouts, v.name);
    // the wallets: a refund gives every stake back; a split pays the winners exactly
    const want = {};
    if (v.expect.refund_all) for (const b of v.bets) want[b.nick.toLowerCase()] = (want[b.nick.toLowerCase()] || 0) + b.amount;
    else for (const [n, a] of v.expect.payouts) want[n.toLowerCase()] = (want[n.toLowerCase()] || 0) + a;
    for (const k of Object.keys(users)) assert.equal(await bal(users[k]) - before[k], want[k] || 0, `${v.name}: ${k}`);
    assert.equal(await mm() - m0, v.expect.fee, `${v.name}: the fee`);
    assert.equal((await supply()).total, s0, `${v.name}: supply`);
  }
});

test("void / nobody backed it / cancel: every stake back, no fee; cancel rules", async () => {
  const c = await act("create", actor("ann_cf", "ann"), { question: "Coin lands heads?", judge: { login: "carol_cf" }, secs: 3600 });
  const ref = c.body.ref;
  await act("bet", actor("ann_cf", "ann"), { ref, option: "yes", amount: 1000 });
  // the creator alone in it may cancel; once someone else bets only an admin can
  await act("bet", actor("bob_cf", "bob"), { ref, option: "no", amount: 1500 });
  assert.equal((await act("cancel", actor("ann_cf", "ann"), { ref })).body.code, "not_yours");
  const a0 = await bal("u1"), b0 = await bal("u2");
  const x = await act("cancel", actor("boss", "adm", { admin: true }), { ref });
  assert.equal(x.body.ok, true, JSON.stringify(x.body));
  assert.equal(x.body.kind, "void");
  assert.equal(x.body.why_code, "cancel");
  assert.equal(await bal("u1"), a0 + 1000);
  assert.equal(await bal("u2"), b0 + 1500);
  assert.equal((await act("cancel", actor("boss", "adm", { admin: true }), { ref })).body.code, "done");
  const c2 = await act("create", actor("ann_cf", "ann"), { question: "Lonely pool?", judge: { login: "carol_cf" }, secs: 3600 });
  await act("bet", actor("ann_cf", "ann"), { ref: c2.body.ref, option: "yes", amount: 800 });
  assert.equal((await act("cancel", actor("ann_cf", "ann"), { ref: c2.body.ref })).body.ok, true);
  // a judge's void with a reason
  const c3 = await act("create", actor("ann_cf", "ann"), { question: "Void me?", judge: { login: "carol_cf" }, secs: 3600 });
  await act("bet", actor("bob_cf", "bob"), { ref: c3.body.ref, option: "no", amount: 900 });
  const v = await act("settle", actor("carol_cf", "carol"), { ref: c3.body.ref, outcome: "void the event was cancelled" });
  assert.equal(v.body.pool.status, "void");
  assert.equal(v.body.why, "the event was cancelled");
  assert.equal(v.body.pool.void_reason, "the event was cancelled");
});

test("deadlines on the site tick: open -> closed (event), closed past the grace -> refunded; an AI hold waits", async () => {
  const c = await act("create", actor("ann_cf", "ann"), { question: "Deadline test?", judge: { login: "carol_cf" }, secs: 3600 });
  const id = c.body.pool.id;
  await act("bet", actor("bob_cf", "bob"), { ref: c.body.ref, option: "yes", amount: 2000 });
  let m = await G.load("pools", id);
  m.closes = nowS() - 10;
  await G.save("pools", m);
  assert.equal((await act("bet", actor("ann_cf", "ann"), { ref: c.body.ref, option: "no", amount: 1000 })).body.code, "closed");
  await G.tick();
  assert.equal((await G.load("pools", id)).status, "closed");
  // AI-judged and Pepe holds the deadline: nothing happens; without the hold: refunded
  const ai = await act("create", actor("ann_cf", "ann"), { question: "Will Pepe know?", ai_judge: true, pepe: "PepeBot", secs: 3600 });
  assert.equal(ai.body.pool.judge, "PepeBot");
  await act("bet", actor("bob_cf", "bob"), { ref: ai.body.ref, option: "yes", amount: 1000 });
  for (const mid of [id, ai.body.pool.id]) {
    m = await G.load("pools", mid);
    m.status = "closed"; m.closes = nowS() - E.SETTLE_GRACE - 10;
    await G.save("pools", m);
  }
  const put = await act("ai_put", PEPE, { ref: ai.body.ref, ai: { state: "proposed", result: "yes", until: nowS() + 600 }, hold: true });
  assert.equal(put.body.ok, true);
  assert.equal((await act("ai_put", actor("bob_cf", "bob"), { ref: ai.body.ref, ai: {}, hold: false })).body.code, "not_pepe");
  const b0 = await bal("u2");
  await G.tick();
  assert.equal((await G.load("pools", id)).status, "void");
  assert.equal((await G.load("pools", ai.body.pool.id)).status, "closed");
  assert.equal(await bal("u2"), b0 + 2000);
  assert.equal((await poolRow(ai.body.pool.id)).ai.state, "proposed");
  // the AI judge's own call (Pepe): only Pepe settles an AI pool besides an admin
  assert.equal((await act("settle", actor("carol_cf", "carol"), { ref: ai.body.ref, outcome: "yes" })).body.code, "not_judge");
  const s = await act("settle", PEPE, { ref: ai.body.ref, outcome: "yes" });
  assert.equal(s.body.kind, "refunded");                             // everyone backed yes: a wash
  assert.equal(s.body.note, "wash");
  const ev = (await post("/api/escrow/bot/poll", { after: 0, wait: 0, games: ["pools"] })).body.events;
  assert.ok(ev.some((e) => e.kind === "closed" && e.data.ref === c.body.ref));
  assert.ok(ev.some((e) => e.kind === "void" && e.data.ref === c.body.ref && e.data.why_code === "overdue"));
});

test("the website: /act pool forms and /markets/:id bet + resolve run on the engine - nothing is queued", async () => {
  const msg = await G.fromForm("u5", "pool", ["new", "Will the site work?", "options yes/no/maybe", "judge @carol_cf", "closes 2d"], "form-pool-0001");
  assert.match(msg, /Pool M\d+ is open: "Will the site work\?" — yes \/ no \/ maybe\. Betting closes in 2d\./);
  const id = Number(/M(\d+)/.exec(msg)[1]);
  const m = await G.load("pools", id);
  assert.equal(m.creator, "web");                                   // no Camfrog link: the PATV username
  assert.match(await G.fromForm("u5", "pool", [`M${id}`, "maybe", "2k"], "form-pool-0002"), /you're in for PAT 2,000 on maybe/);
  assert.equal(await bal("u5"), 7000);
  assert.match(await G.fromForm("u5", "pool", ["new", "Will it rain at all?"], "form-pool-0003"), /needs a judge/);
  // the market page's bet form (a JSON body here) -> the engine, then a redirect with the answer
  const r = await post(`/markets/${id}/bet`, { option: "yes", amount: "1.5k" }, { "x-user": "u2" });
  assert.equal(r.status, 302);
  assert.match(decodeURIComponent(r.location), /you're in for PAT 1,500 on yes/);
  const q = await getQuery("SELECT COUNT(*) AS n FROM market_orders");
  assert.equal(q[0].n, 0);
  // the judge's form
  const rv = await post(`/markets/${id}/resolve`, { outcome: "maybe" }, { "x-user": "u3" });
  assert.match(decodeURIComponent(rv.location), /maybe! 1 winner\(s\) split PAT 3,425/);       // 2,000 + 1,500 - 75
  assert.equal(await bal("u5"), 7000 + 3425);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM market_orders"))[0].n, 0);
  // ai / dispute on an AI pool from the site -> an ai_request event for Pepe's judge
  const ai = await act("create", actor("ann_cf", "ann"), { question: "Ask Pepe?", ai_judge: true, pepe: "PepeBot", secs: 3600 });
  await act("bet", actor("bob_cf", "bob"), { ref: ai.body.ref, option: "yes", amount: 1000 });
  assert.match(await G.fromForm("u2", "pool", ["dispute", ai.body.ref, "he", "is", "wrong"], "form-pool-0004"), /dispute/);
  const ev = (await post("/api/escrow/bot/poll", { after: 0, wait: 0, games: ["pools"] })).body.events.filter((e) => e.kind === "ai_request");
  assert.equal(ev[ev.length - 1].data.why, "he is wrong");
  assert.equal(ev[ev.length - 1].data.who, "bob_cf");
});

test("1.99th: Pepe's auto pools carry `auto` (display table too) and skip the per-creator cap; nobody else can send one", async () => {
  const auto = { v: 1, id: "a1", cat: "sports", tag: "NFL", resolver: "sports", criteria: "Settles on the official final score on ESPN's scoreboard.",
                 source_url: "https://www.espn.com/nfl/game/_/gameId/401", source_name: "ESPN", starts: nowS() + 86400, resolve_at: nowS() + 86400 + 14400,
                 spec: { league: "nfl", event_id: "401" } };
  const refs = [];
  for (let i = 0; i < 6; i++) {
    const r = await act("create", PEPE, { question: `NFL: auto game number ${i} - who wins?`, options: ["Texans", "Jaguars"], ai_judge: true, pepe: "PepeBot",
                                          secs: 3600, room: "Lab", lmsr_open: 9, auto: Object.assign({}, auto, { id: "a" + i }) });
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    assert.equal(r.body.pool.auto.cat, "sports");
    assert.equal(r.body.pool.auto.id, "a" + i);
    refs.push(r.body.ref);
  }
  const row = await poolRow(Number(refs[0].slice(1)));
  assert.equal(row.auto.source_url, auto.source_url);
  assert.equal(row.auto.criteria, auto.criteria);
  // Pepe's own chat pools still count (6 auto ones are open now)
  assert.equal((await act("create", PEPE, { question: "A chat pool by Pepe?", ai_judge: true, pepe: "PepeBot", secs: 3600 })).body.code, "max_open");
  // a person can't smuggle an auto record in
  const r = await act("create", actor("dave_cf", "dave"), { question: "Sneaky auto pool?", judge: { login: "carol_cf" }, secs: 3600, auto });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.pool.auto, undefined);
});

test("rollback: the records go back to Pepe (keyed), the stakes stay on the ledger", async () => {
  const c = await act("create", actor("ann_cf", "ann"), { question: "Stays open?", judge: { login: "carol_cf" }, secs: 3600 });
  await act("bet", actor("bob_cf", "bob"), { ref: c.body.ref, option: "no", amount: 1200 });
  const live = (await G.list("pools", E.LIVE));
  const sum = live.reduce((t, m) => t + m.bets.reduce((a, b) => a + b.amount, 0), 0);
  const rb = await post("/api/escrow/admin/game-rollback", { game: "pools", key: "gr-p-1" });
  assert.equal(rb.body.ok, true, JSON.stringify(rb.body));
  assert.equal(rb.body.count, live.length);
  assert.equal(rb.body.sum, sum);
  assert.ok(rb.body.records.find((r) => r.id === c.body.pool.id && r.status === "open" && r.bets[0].hold));
  assert.equal(rb.body.seq, (await L.meta("seq:pools")));
  assert.equal((await post("/api/escrow/admin/game-rollback", { game: "pools", key: "gr-p-1" })).body.dup, true);
  assert.equal(await G.gameLive("pools"), false);
  assert.equal((await act("bet", actor("ann_cf", "ann"), { ref: c.body.ref, option: "no", amount: 1000 })).body.code, "not_live");
  const held = await L.holdsByIds(rb.body.records.find((r) => r.id === c.body.pool.id).bets.map((b) => b.hold));
  assert.equal(held[0].state, "held");
  // Pepe's snapshot owns the pool rows again
  await post("/api/markets/sync", { markets: [{ id: c.body.pool.id, model: "pool", question: "Stays open?", options: ["yes", "no"], status: "closed", bets: [] }] });
  assert.equal((await poolRow(c.body.pool.id)).status, "closed");
});
