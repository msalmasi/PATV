// 1.99ou Phase 2: the escrow ledger (escrow/ledger.js) and the wager engine (escrow/wagers.js, escrow/games.js).
//   * ledger: off by default on prod; the import needs the pools live, checks digest / totals / Pepe's supply row, keeps the supply
//     total to the PAT, is idempotent; hold / refund / settle / grant are keyed one-transaction moves (a refused one isn't recorded);
//     fee legs land in the site's pools and the House; rollback hands every held stake back
//   * wagers: create / accept / settle (fee split exactly like Pepe's _route_fees) / void / decline / cancel / deadlines, keyed acts,
//     the website's /act form runs here, the per-game import checks every stake against the ledger, rollback hands records back
//   NODE_PATH=G:/PATV/node_modules node --test test/escrow.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "escrow-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const P = require(path.join(repo, "pools"));
const L = require(path.join(repo, "escrow", "ledger"));
const G = require(path.join(repo, "escrow", "games"));

const bal = async (id) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [id]))[0].b;
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

let base, server;
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ password: "bot" }, body)) })
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const actor = (login, username, extra = {}) => Object.assign({ login, username, admin: false, room: "Lab", via: "room" }, extra);
const act = (game, verb, a, args, idem) => post("/api/escrow/bot/act", { game, verb, actor: a, args, idem });

const HOLDS = [
  { id: "h10", ref: "W1", user: "ann", nick: "ann_cf", amount: 2000 },
  { id: "h11", ref: "W1", user: "bob", nick: "bob_cf", amount: 2000 },
  { id: "h12", ref: "BT4", user: "ann", nick: "ann_cf", amount: 1500 },
  { id: "h13", ref: "B2", user: "bob", nick: "bob_cf", amount: 300 },
];
function pack(holds, extra = {}, key = "ec-0001") {
  const sum = holds.reduce((t, h) => t + h.amount, 0);
  const supplyRows = extra.supply !== undefined ? extra.supply : [{ key: "escrow:holds", label: "holds", amount: sum }, { key: "escrow", label: "payouts", amount: 77 }];
  const payload = JSON.stringify({ v: 1, source: "pepe", holds, seq: 13, supply: supplyRows });
  const per = {};
  for (const h of holds) per[L.kindOf(h.ref)] = (per[L.kindOf(h.ref)] || 0) + h.amount;
  return { key, payload, digest: sha(payload), totals: Object.assign({ sum, count: holds.length, per_kind: per }, extra.totals || {}) };
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, level INTEGER DEFAULT 0, created_at TEXT)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)");
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER, created DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE supply_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), pools TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
  for (const [id, name, b, cf, cls] of [["u1", "ann", 50000, "ann_cf", "pleb"], ["u2", "bob", 50000, "bob_cf", "pleb"], ["u3", "carol", 0, "carol_cf", "pleb"],
                                        ["u4", "adm", 0, "boss", "Admin"], ["u5", "web", 9000, null, "pleb"]]) {
    await runQuery("INSERT INTO users (userId, username, password, points_balance, camfrogUsername, class) VALUES (?, ?, 'x', ?, ?, ?)", [id, name, b, cf, cls]);
  }
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, userId, amount) VALUES ('seed', 's', NULL, 1000000)");
  await require(path.join(repo, "funding")).init();
  await P.init();
  L._setSupplyFn(supply);
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  const deps = { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() };
  P.register(app, deps);
  L.register(app, deps);
  G.register(app, deps);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());

test("off by default on prod: no import, no moves", async () => {
  assert.equal(await L.enabled(), false);
  const r = await post("/api/escrow/admin/import", pack(HOLDS));
  assert.equal(r.body.code, "E_FEATURE_OFF");
  const h = await post("/api/escrow/bot/hold", { key: "hold:h1", hid: "h1", username: "ann", amount: 100, ref: "W9" });
  assert.equal(h.body.code, "E_NOT_LIVE");
});

test("import: needs the pools live; digest / totals / supply row checked; nothing kept on a mismatch", async () => {
  await L.setMeta("enabled", true);
  assert.equal((await post("/api/escrow/admin/import", pack(HOLDS))).body.code, "E_POOLS_NOT_LIVE");
  // the pools go live (Phase 1) with a reserve, the bingo pot and Fort Knox
  await P._setMeta("live", true);
  P._forgetLive();
  await P.move({ key: "seed-pools", legs: [["reserve", 100000], ["bingo", 5000], ["fortknox", 10]], flow: "test", kind: "admin" });
  const bad = pack(HOLDS);
  bad.digest = "0".repeat(64);
  assert.equal((await post("/api/escrow/admin/import", bad)).body.code, "E_DIGEST");
  assert.equal((await post("/api/escrow/admin/import", pack(HOLDS, { totals: { sum: 1 } }))).body.code, "E_TOTALS");
  assert.equal((await post("/api/escrow/admin/import", pack(HOLDS, { totals: { per_kind: { W: 1 } } }))).body.code, "E_TOTALS");
  assert.equal((await post("/api/escrow/admin/import", pack(HOLDS, { supply: [{ key: "escrow:holds", amount: 1 }] }))).body.code, "E_SUPPLY");
  assert.equal((await post("/api/escrow/admin/import", pack([{ id: "h1", ref: "W1", user: "nobody", amount: 5 }]))).body.code, "E_TARGET_NOT_FOUND");
  assert.equal(await L.live(), false);
  assert.equal((await L.heldTotal()).count, 0);
});

test("import: every hold lands, the supply total doesn't move, idempotent by key", async () => {
  await runQuery("INSERT INTO supply_snapshot (id, pools) VALUES (1, '[]')");
  const r = await post("/api/escrow/admin/import", pack(HOLDS));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.total, 5800);
  assert.equal(r.body.count, 4);
  assert.equal(r.body.supply_before, r.body.supply_after);
  assert.deepEqual(r.body.per_kind, { W: 4000, BT: 1500, B: 300 });
  assert.equal(await L.live(), true);
  assert.equal((await post("/api/escrow/admin/import", pack(HOLDS))).body.already, true);
  assert.equal((await post("/api/escrow/admin/import", pack(HOLDS, {}, "ec-0002"))).body.code, "E_ALREADY");
  const s = await supply();
  assert.equal(s.rows.find((x) => x.key === "escrow:holds").amount, 5800);
});

test("hold / refund: keyed, one transaction; a refused hold isn't recorded", async () => {
  const before = await bal("u1");
  const h = await post("/api/escrow/bot/hold", { key: "hold:h20", hid: "h20", username: "ann", login: "ann_cf", amount: 1000, ref: "DN5", reason: "donation" });
  assert.equal(h.body.ok, true, JSON.stringify(h.body));
  assert.equal(await bal("u1"), before - 1000);
  const again = await post("/api/escrow/bot/hold", { key: "hold:h20", hid: "h20", username: "ann", amount: 1000, ref: "DN5" });
  assert.equal(again.body.dup, true);
  assert.equal(await bal("u1"), before - 1000);
  const poor = await post("/api/escrow/bot/hold", { key: "hold:h21", hid: "h21", username: "carol", amount: 1000, ref: "W77" });
  assert.equal(poor.body.code, "E_INSUFFICIENT_PAT");
  assert.equal((await post("/api/escrow/bot/status", { keys: ["hold:h21"] })).body.results["hold:h21"], null);
  const rf = await post("/api/escrow/bot/refund", { key: "refund:h20", hid: "h20", reason: "donation-refund" });
  assert.equal(rf.body.ok, true);
  assert.equal(await bal("u1"), before);
  const twice = await post("/api/escrow/bot/refund", { key: "refund:h20b", hid: "h20", reason: "x" });
  assert.equal(twice.body.code, "E_NOT_HELD");
  assert.equal(await bal("u1"), before);
});

test("settle: payouts + fee legs (pool and House) + kept remainder; overpay refused; supply holds steady", async () => {
  const s0 = (await supply()).total;
  const h0 = await house();
  const r0 = (await P.balances()).reserve;
  const b0 = await bal("u2");
  // W1: ann + bob each 2000; bob wins 3800, 100 to the House, 100 to the Reserve
  const over = await post("/api/escrow/bot/settle", { key: "settle:h10", hids: ["h10", "h11"], payouts: [{ nick: "bob_cf", amount: 4000 }], fees: [["jackpot", 1]], ref: "W1" });
  assert.equal(over.body.code, "E_OVERPAY");
  const st = await post("/api/escrow/bot/settle", { key: "settle:h10", hids: ["h10", "h11"], ref: "W1",
                                                    payouts: [{ nick: "bob_cf", amount: 3800, reason: "wager-win", cp: "ann_cf" }],
                                                    fees: [["jackpot", 100], ["reserve", 100]] });
  assert.equal(st.body.ok, true, JSON.stringify(st.body));
  assert.equal(await bal("u2"), b0 + 3800);
  assert.equal(await house(), h0 + 100);
  assert.equal((await P.balances()).reserve, r0 + 100);
  assert.equal((await supply()).total, s0);
  // a stash-style settle keeps everything (the PAT leaves escrow into something Pepe tracks)
  const keep = await post("/api/escrow/bot/settle", { key: "settle:h13", hids: ["h13"], ref: "B2", payouts: [], fees: [] });
  assert.equal(keep.body.kept, 300);
  assert.equal((await supply()).total, s0 - 300);
  const dup = await post("/api/escrow/bot/settle", { key: "settle:h10", hids: ["h10", "h11"], payouts: [], ref: "W1" });
  assert.equal(dup.body.dup, true);
});

test("grant: pool -> wallets in one transaction; a short pool refuses and moves nothing", async () => {
  const b0 = await bal("u3");
  const short = await post("/api/escrow/bot/grant", { key: "grant:bingo-B9", pool: "bingo", payouts: [{ nick: "carol_cf", amount: 999999 }], ref: "B9" });
  assert.equal(short.body.code, "E_INSUFFICIENT");
  assert.equal(await bal("u3"), b0);
  const g = await post("/api/escrow/bot/grant", { key: "grant:bingo-B9", pool: "bingo", payouts: [{ nick: "carol_cf", amount: 1200, reason: "bingo-rollover" }], ref: "B9" });
  assert.equal(g.body.ok, true, JSON.stringify(g.body));
  assert.equal(await bal("u3"), b0 + 1200);
  assert.equal((await P.balances()).bingo, 3800);
  assert.equal((await post("/api/escrow/bot/grant", { key: "grant:bingo-B9", pool: "bingo", payouts: [{ nick: "carol_cf", amount: 1200 }], ref: "B9" })).body.dup, true);
  assert.equal(await bal("u3"), b0 + 1200);
  assert.equal((await post("/api/escrow/bot/grant", { key: "grant:burn-1", pool: "burn", payouts: [{ nick: "carol_cf", amount: 1 }] })).body.code, "E_BURN_ONLY");
});

test("a !donate lotto while the lotto service owns the pot lands in ITS pot (lotto_pot), not a pools row", async () => {
  const LS = require(path.join(repo, "lotto", "service"));
  await LS.ensure();
  await runQuery("INSERT INTO lotto_pot (moveId, draw, amount, why, created) VALUES ('seed-pot', NULL, 1000000, 'seed', 1)");
  const p0 = await LS.potBalance();
  const h = await post("/api/escrow/bot/hold", { key: "hold:h40", hid: "h40", username: "ann", login: "ann_cf", amount: 2500, ref: "DN40", reason: "donation" });
  assert.equal(h.body.ok, true);
  const s = await post("/api/escrow/bot/settle", { key: "settle:h40", hids: ["h40"], payouts: [], fees: [["lotto", 2500]], ref: "DN40" });
  assert.equal(s.body.ok, true, JSON.stringify(s.body));
  assert.equal(await LS.potBalance(), p0 + 2500);
  assert.equal((await P.balances()).lotto || 0, 0);
  assert.equal((await post("/api/escrow/bot/grant", { key: "grant:lotto-x1", pool: "lotto", payouts: [{ nick: "ann_cf", amount: 1 }] })).body.code, "E_LOTTO_POT");
  await runQuery("DELETE FROM lotto_pot");
});

test("fee split = Pepe's _route_split + stake scaling", () => {
  assert.deepEqual(G.split([["jackpot", 100]], 199), [["jackpot", 199]]);
  assert.deepEqual(G.split([["stakers", 33], ["mm", 33]], 100), [["stakers", 33], ["mm", 33], ["reserve", 34]]);
  assert.deepEqual(G.split([["stakers", 50], ["reserve", 50]], 101, 0.5), [["stakers", 25], ["reserve", 76]]);
});

test("wagers: the per-game import checks every stake against the ledger", async () => {
  await L.setMeta("enabled:wagers", true);
  // W1's stakes were spent above - an export still naming them is refused
  const recs = { wagers: [{ id: 1, creator: "ann_cf", opponent: "bob_cf", judge: "carol_cf", amount: 2000, terms: "x wins", status: "active",
                            created: 1, offer_until: 2, deadline: 9e9, holds: { creator: "h10", opponent: "h11" } }], seq: 1 };
  const payload = JSON.stringify(recs);
  const r = await post("/api/escrow/admin/game-import", { game: "wagers", key: "gc-w-1", payload, digest: sha(payload), totals: { sum: 4000, count: 1 } });
  assert.equal(r.body.code, "E_HOLDS");
  // a live offer whose stake is held
  await post("/api/escrow/bot/hold", { key: "hold:h30", hid: "h30", username: "ann", login: "ann_cf", amount: 5000, ref: "W3", reason: "wager-stake" });
  const ok = { wagers: [{ id: 3, creator: "ann_cf", opponent: "bob_cf", judge: "carol_cf", amount: 5000, terms: "rain tomorrow", status: "offered",
                          created: Math.floor(Date.now() / 1000), offer_until: Math.floor(Date.now() / 1000) + 600, deadline: Math.floor(Date.now() / 1000) + 86400,
                          holds: { creator: "h30" }, users: { creator: "ann" } }], seq: 3 };
  const p2 = JSON.stringify(ok);
  const r2 = await post("/api/escrow/admin/game-import", { game: "wagers", key: "gc-w-2", payload: p2, digest: sha(p2), totals: { sum: 5000, count: 1 } });
  assert.equal(r2.body.ok, true, JSON.stringify(r2.body));
  assert.equal(await G.gameLive("wagers"), true);
  // the display table got it
  const row = (await getQuery("SELECT status FROM wagers WHERE id = 3"))[0];
  assert.equal(row.status, "offered");
});

test("wagers: accept / settle with the routed fee; keyed acts; events for Pepe", async () => {
  await post("/api/escrow/bot/fee-plans", { plans: { k: 1, shares: { wager_fee: [["jackpot", 60], ["fortknox", 40]] } } });
  const b2 = await bal("u2");
  const acc = await act("wagers", "accept", actor("bob_cf", "bob"), { ref: "W3" }, "idem-acc-1");
  assert.equal(acc.body.ok, true, JSON.stringify(acc.body));
  assert.equal(await bal("u2"), b2 - 5000);
  assert.equal((await act("wagers", "accept", actor("bob_cf", "bob"), { ref: "W3" }, "idem-acc-1")).body.dup, true);
  assert.equal(await bal("u2"), b2 - 5000);
  assert.equal((await act("wagers", "settle", actor("ann_cf", "ann"), { ref: "W3", outcome: "ann_cf" }, "idem-s0")).body.code, "not_judge");
  // the opponent's stake is the site engine's: Pepe's ledger calls can't refund or spend it while wagers are live here
  const siteHid = acc.body.wager.holds.opponent;
  assert.equal((await post("/api/escrow/bot/refund", { key: "refund:" + siteHid, hid: siteHid, reason: "x" })).body.code, "E_SITE_HOLD");
  assert.equal((await post("/api/escrow/bot/settle", { key: "settle:x-" + siteHid, hids: [siteHid], payouts: [], fees: [] })).body.code, "E_SITE_HOLD");
  const h0 = await house();
  const fk0 = (await P.balances()).fortknox;
  const b1 = await bal("u1");
  const s = await act("wagers", "settle", actor("carol_cf", "carol"), { ref: "W3", outcome: "@ANN_CF" }, "idem-s1");
  assert.equal(s.body.ok, true, JSON.stringify(s.body));
  assert.equal(s.body.paid, 9500);
  assert.equal(await bal("u1"), b1 + 9500);
  assert.equal(await house(), h0 + 300);
  assert.equal((await P.balances()).fortknox, fk0 + 200);
  const ev = await post("/api/escrow/bot/poll", { after: 0, wait: 0, games: ["wagers"] });
  assert.deepEqual(ev.body.events.map((e) => e.kind), ["accepted", "won"]);
  assert.equal(ev.body.events[1].data.wager.winner, "ann_cf");
});

test("wagers: create from chat and from the website form; decline / cancel / void refund; deadlines on the site tick", async () => {
  const c = await act("wagers", "create", actor("bob_cf", "bob"), { opponent: { login: "ann_cf" }, judge: { login: "carol_cf" }, amount: 1000,
                                                                   terms: "that the lakers win", secs: 3600, room: "Lab" }, "idem-c1");
  assert.equal(c.body.ok, true, JSON.stringify(c.body));
  assert.equal(c.body.ref, "W4");
  assert.equal(c.body.wager.terms, "the lakers win");
  assert.equal((await act("wagers", "create", actor("bob_cf", "bob"), { opponent: { login: "ann_cf" }, judge: { login: "carol_cf" }, amount: 1000,
                                                                        terms: "the lakers win", secs: 3600 }, "idem-c2")).body.code, "dup");
  const b2 = await bal("u2");
  assert.equal((await act("wagers", "decline", actor("ann_cf", "ann"), { ref: "W4" }, "idem-d1")).body.ok, true);
  assert.equal(await bal("u2"), b2 + 1000);
  // the website form (an account with no Camfrog link)
  const msg = await G.fromForm("u5", "wager", ["@bob_cf", "2k", "it snows", "judge @carol_cf", "by 1d"], "form-abc-123");
  assert.match(msg, /W5 offered/);
  assert.equal(await bal("u5"), 7000);
  assert.match(await G.fromForm("u5", "wager", ["cancel", "W5"], "form-abc-124"), /cancelled/);
  assert.equal(await bal("u5"), 9000);
  // void: both back
  await act("wagers", "create", actor("ann_cf", "ann"), { opponent: { login: "bob_cf" }, judge: { login: "carol_cf" }, amount: 1500, terms: "coin flip", secs: 7200 }, "idem-c3");
  await act("wagers", "accept", actor("bob_cf", "bob"), { ref: "W6" }, "idem-a6");
  const a0 = await bal("u1"), bb0 = await bal("u2");
  assert.equal((await act("wagers", "settle", actor("boss", "adm", { admin: true }), { ref: "W6", outcome: "void" }, "idem-v6")).body.wager.status, "void");
  assert.equal(await bal("u1"), a0 + 1500);
  assert.equal(await bal("u2"), bb0 + 1500);
  // deadlines: an offer nobody took and an active wager nobody settled - both refunded by the site tick
  await act("wagers", "create", actor("ann_cf", "ann"), { opponent: { login: "bob_cf" }, judge: { login: "carol_cf" }, amount: 1000, terms: "late offer", secs: 7200 }, "idem-c7");
  await act("wagers", "create", actor("ann_cf", "ann"), { opponent: { login: "bob_cf" }, judge: { login: "carol_cf" }, amount: 1000, terms: "late judge", secs: 7200 }, "idem-c8");
  await act("wagers", "accept", actor("bob_cf", "bob"), { ref: "W8" }, "idem-a8");
  const w7 = await G.load("wagers", 7), w8 = await G.load("wagers", 8);
  w7.offer_until = 1; w8.deadline = 1;
  await G.save("wagers", w7); await G.save("wagers", w8);
  const a1 = await bal("u1"), bb1 = await bal("u2");
  await G.tick();
  assert.equal((await G.load("wagers", 7)).status, "expired");
  assert.equal((await G.load("wagers", 8)).status, "expired");
  assert.equal(await bal("u1"), a1 + 2000);
  assert.equal(await bal("u2"), bb1 + 1000);
});

test("wagers: rollback hands the records back (keyed); the ledger rollback waits for it", async () => {
  await act("wagers", "create", actor("ann_cf", "ann"), { opponent: { login: "bob_cf" }, judge: { login: "carol_cf" }, amount: 1000, terms: "stays open", secs: 7200 }, "idem-c9");
  assert.equal((await post("/api/escrow/admin/rollback", { key: "er-0001" })).body.code, "E_GAMES_LIVE");
  const rb = await post("/api/escrow/admin/game-rollback", { game: "wagers", key: "gr-w-1" });
  assert.equal(rb.body.ok, true, JSON.stringify(rb.body));
  assert.equal(rb.body.count, 1);
  assert.equal(rb.body.sum, 1000);
  assert.ok(rb.body.records.find((r) => r.id === 9 && r.status === "offered"));
  assert.equal((await post("/api/escrow/admin/game-rollback", { game: "wagers", key: "gr-w-1" })).body.dup, true);
  assert.equal(await G.gameLive("wagers"), false);
  assert.equal((await act("wagers", "accept", actor("bob_cf", "bob"), { ref: "W9" }, "idem-a9")).body.code, "not_live");
  // now the ledger: every held stake goes back, the table holds nothing
  const s0 = (await supply()).total;
  const held = await L.heldTotal();
  const r = await post("/api/escrow/admin/rollback", { key: "er-0002" });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));
  assert.equal(r.body.sum, held.amount);
  assert.equal(r.body.count, held.count);
  assert.equal((await L.heldTotal()).count, 0);
  assert.equal(await L.live(), false);
  // the supply now counts Pepe's row again (his snapshot would carry escrow:holds = what came back)
  await runQuery("UPDATE supply_snapshot SET pools = ? WHERE id = 1", [JSON.stringify([{ key: "escrow:holds", label: "h", amount: held.amount }, { key: "escrow", label: "p", amount: 77 }])]);
  assert.equal((await supply()).total, s0);
  // a re-import with a new key works (ids re-used)
  const again = await post("/api/escrow/admin/import", pack(r.body.holds.map((h) => ({ id: h.id, ref: h.ref, user: h.user, nick: h.nick, amount: h.amount })),
                                                             { supply: [{ key: "escrow:holds", amount: held.amount }] }, "ec-0003"));
  assert.equal(again.body.ok, true, JSON.stringify(again.body));
});
