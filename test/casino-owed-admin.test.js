// 1.99aoj - the OWED-PAT tool and the close-refund fix, on a temp DB (casino/owed.js, casino/owedweb.js, casino/service.js, casino/holdem.js):
//   * (B) the blackjack close-refund fix: a stake refund refused when a player leaves the betting window or the table closes (admin close,
//     the idle close, the frozen table's final close once an owed payout lands) used to stay in T.stakes "for retry" while the table closed
//     anyway - the stake was lost. Now it is OWED (T.owed[<stake key>:refund], the payouts' store and clock), the table never closes while it
//     is owed, and it lands once by its own key.
//   * (C) the sweep: a restart's refund of a stake / buy-in caught in its intent was logged and the intent cleared when refused (lost) - owed.
//   * (A) /admin/casino/owed: every owed item listed (no account id, ever); retry now (casino admins), pay another account / write off to
//     the House (a Pepe owner + the password step-up); idempotent, refused when the item changed, under the mutex, journalled across a
//     restart, audited; PAT conserved (wallets + House + tables + escrow) across every action; a redirect never pays twice.
//   NODE_PATH=G:/PATV/node_modules node --test test/casino-owed-admin.test.js      (uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "casino-owed-admin-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.PEPE_CONTROL_SECRET;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const bcrypt = require("bcrypt");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const E = require(path.join(repo, "casino", "bjengine"));
const H = require(path.join(repo, "casino", "hmengine"));
const svc = require(path.join(repo, "casino", "service"));
const OW = require(path.join(repo, "casino", "owed"));
const SUP = require(path.join(repo, "supply"));
require(path.join(repo, "casino", "veil"))._hooks.kind = async () => null;        // nobody is veiled here
require(path.join(repo, "casino", "rewards")).hooks.updateLevel = async () => {};
const funding = require(path.join(repo, "funding"));

let NOW = Date.UTC(2026, 10, 17, 2, 0, 0);
svc.S.hooks.now = () => NOW;
const later = async (secs) => { NOW += secs * 1000; await svc.tickOnce(); };
let k = 0;
// account ids long enough that a page carrying one would be caught (never a hex hash's characters)
const ID = { ann: "p-ann-01", bob: "p-bob-02", cat: "p-cat-03", own: "p-own-09", adm: "p-adm-08", dan: "p-dan-04" };
const mk = (uid, name) => ({ uid, name, username: name.toLowerCase(), camfrog: null, via: "web", iph: null, admin: false });
const ann = mk(ID.ann, "Ann"), bob = mk(ID.bob, "Bob"), cat = mk(ID.cat, "Cat");
const boss = Object.assign(mk(ID.adm, "Adminy"), { admin: true });
const A = (who, verb, args, opts) => { svc.S.rate.clear(); return svc.act(who, verb, args || [], opts || {}, "oa-" + ++k); };
const HA = (who, verb, args, opts) => A(who, verb, args, Object.assign({ game: "holdem" }, opts || {}));
const ok = (r) => { assert.ok(r && r.ok, r && (r.reply || r.error || JSON.stringify(r))); return r; };
const bal = async (uid) => ((await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [uid]))[0] || {}).b;
const house = async () => (await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM jackpot_rakes"))[0].t;
const wallets = async () => (await getQuery("SELECT COALESCE(SUM(points_balance),0) AS t FROM users"))[0].t;
const escrow = async () => ((await getQuery("SELECT COALESCE(SUM(amount),0) AS t FROM escrow_holds WHERE state = 'held'").catch(() => [{ t: 0 }]))[0] || { t: 0 }).t;
const keys = async (key) => (await getQuery("SELECT points FROM transactions WHERE transactionId = ?", [key])).map((r) => r.points);
const rakes = async (key) => (await getQuery("SELECT amount, spinId FROM jackpot_rakes WHERE jackpotId = ?", [key]));
const row = async (id) => { const r = (await getQuery("SELECT status, state FROM casino_tables WHERE id = ?", [id]))[0]; return { status: r.status, s: JSON.parse(r.state) }; };
const audits = async () => (await getQuery("SELECT * FROM admin_audit WHERE action = 'casino_owed' ORDER BY id")).map((r) => Object.assign(r, { detail: JSON.parse(r.detail) }));
const get = (id) => svc.getTable(id);
// accounts that are gone (a hard purge): their balances are kept aside so the conservation sum counts them
const away = new Map();
async function gone(uid) {
  away.set(uid, (await bal(uid)) || 0);
  await runQuery("DELETE FROM users WHERE userId = ?", [uid]);
}
async function back(uid, name) {
  await runQuery("INSERT INTO users (userId, username, displayname, password, points_balance) VALUES (?, ?, ?, 'x', ?)", [uid, name.toLowerCase(), name, away.get(uid) || 0]);
  away.delete(uid);
}
/** every PAT there is: the wallets (+ the accounts set aside), the House, what supply.js counts at the casino tables, escrow */
const total = async () => (await wallets()) + Array.from(away.values()).reduce((s, v) => s + v, 0) + (await house()) + (await SUP.casinoHeld()) + (await escrow());

async function fresh() {
  svc.stop();
  svc.S.hooks.shoe = null;
  svc.S.hooks.deck = null;
  svc.S.hooks.crash = null;
  svc.S.rate.clear();
  for (const t of ["casino_tables", "casino_events", "casino_rounds", "casino_actions", "transactions", "reserve_claims", "casino_settings", "admin_audit"]) {
    await runQuery(`DELETE FROM ${t}`).catch(() => {});
  }
  await runQuery("DELETE FROM users");
  const pw = await bcrypt.hash("pw-right", 4);
  for (const [id, name, cls, cf] of [[ID.ann, "Ann", "pleb", null], [ID.bob, "Bob", "pleb", null], [ID.cat, "Cat", "pleb", null], [ID.dan, "Dan", "pleb", null],
                                     [ID.own, "Owner", "Admin", "own_cf"], [ID.adm, "Adminy", "Admin", "adm_cf"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername, points_balance) VALUES (?, ?, ?, ?, ?, ?, 100000)",
                   [id, name.toLowerCase(), name, pw, cls, cf]);
  }
  away.clear();
  await runQuery("DELETE FROM jackpot_rakes");
  await runQuery("INSERT INTO jackpot_rakes (jackpotId, spinId, amount) VALUES ('seed', 'seed', 10000000)");
  funding.sync({});
  NOW += 3600e3;
  await svc.boot({ tick: false });
  for (const [kk, v] of [["bj_enabled", "1"], ["hm_enabled", "1"]]) await svc.setSetting(kk, v, "test");
}
async function restart(crash) {
  svc.stop();
  svc.S.hooks.crash = crash || null;
  await svc.boot({ tick: false });
}
// round 1: two players (Ann 20, Bob 20 vs Pepe 9+7 who hits a K = bust: both win 1000 on 1000); later rounds: one player, the same
const TWO = ["Ts", "Js", "9h", "Qd", "Kd", "7d", "Kc"];
const ONE = ["Ts", "9h", "Qd", "7d", "Kc"];
function shoes() { svc.S.hooks.shoe = (T) => (Object.keys(T.eng.bets).length >= 2 ? TWO : ONE).concat(E.makeShoe(6)); }
const capture = async (fn) => {
  const errs = [], ce = console.error, cw = console.warn;
  console.error = (...a) => errs.push(a.join(" "));
  console.warn = (...a) => errs.push(a.join(" "));
  try { await fn(); } finally { console.error = ce; console.warn = cw; }
  return errs;
};

// ── the web routes (casino/owedweb.js + the step-up nonce) ──
let base, server;
async function call(p, who, body, extra) {
  const headers = Object.assign({ "content-type": "application/json", "x-test-user": who || "", "X-Requested-With": "fetch", origin: base }, extra || {});
  for (const kk of Object.keys(headers)) if (headers[kk] === null) delete headers[kk];
  const r = await fetch(base + p, body === undefined ? { redirect: "manual", headers } : { method: "POST", redirect: "manual", headers, body: JSON.stringify(body) });
  let j = null;
  const text = await r.text();
  try { j = JSON.parse(text); } catch (e) { j = null; }
  return { status: r.status, body: j, text, location: r.headers.get("location") };
}
const list = async (who) => (await call("/api/casino/admin/owed", who || ID.adm)).body;
const nonce = async (who) => (await call("/api/admin/stepup/nonce", who, { for: "casino_owed" })).body.nonce;
let ik = 0;
const idem = () => "owedtest-" + ++ik;
/** an owner action through the route: nonce + password */
async function ownerAct(op, it, fields, who) {
  const n = await nonce(who || ID.own);
  return call("/api/casino/admin/owed/" + op, who || ID.own, Object.assign({ table: it.table, item: it.id, amount: it.amount, idem: idem(), nonce: n, password: "pw-right" }, fields || {}));
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, casino_banned INTEGER DEFAULT 0, level INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER,
                  created_at TEXT)`);
  await runQuery(`CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL, points INTEGER NOT NULL,
                  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery("CREATE TABLE jackpot_rakes (jackpotId TEXT PRIMARY KEY, spinId TEXT, userId TEXT, amount INTEGER NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE user_roles (userId TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (userId, role))");
  await runQuery("CREATE TABLE welcome_bonus (userId TEXT PRIMARY KEY, dup_of TEXT)");
  await runQuery("CREATE TABLE badges (badgeId TEXT PRIMARY KEY, name TEXT, description TEXT, icon TEXT, points INTEGER, requirement TEXT, pat INTEGER DEFAULT 0)");
  await runQuery("CREATE TABLE classes (classId TEXT PRIMARY KEY, class TEXT)");
  await funding.init();
  const SR = require(path.join(repo, "staffroles"));
  await SR.init();
  await runQuery("INSERT INTO pepe_roles (login, role, ts) VALUES ('own_cf', 'owner', 1), ('adm_cf', 'admin', 1)");
  await require(path.join(repo, "pepecontrol")).init();
  await require(path.join(repo, "adminaudit")).init();

  const app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { req.flash = () => []; res.locals.ogBase = "http://test"; next(); });
  const addUser = async (req, res, next) => {
    const u = req.get("x-test-user");
    req.user = u ? (await getQuery("SELECT userId, username, class FROM users WHERE userId = ?", [u]))[0] || null : null;
    next();
  };
  require(path.join(repo, "casino", "owedweb")).register(app, { addUser });
  app.post("/api/admin/stepup/nonce", addUser, (req, res) => require(path.join(repo, "stepup")).nonceRoute(req, res));
  require(path.join(repo, "adminweb")).register(app, { addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { svc.stop(); if (server) server.close(); });

/** Ann and Bob bet 1000 each and both win; Ann's account is gone before the round settles -> {t, key} (Ann's payout key) */
async function refusedRound() {
  const t = ok(await A(bob, "start", [], { room: null })).table;
  shoes();
  ok(await A(bob, "bet", ["1000"], { table: t }));
  ok(await A(ann, "bet", ["1000"], { table: t }));
  ok(await A(bob, "deal", [], { table: t }));
  await gone(ID.ann);
  await capture(async () => {
    ok(await A(bob, "stand", [], { table: t }));
    ok(await A(ann, "stand", [], { table: t }));
  });
  return { t, key: `cbj:${t}:r1:${ID.ann}:pay` };
}
const stakeOf = (T, uid) => (T.stakes || []).find((s) => s.uid === uid);

// ───────────────────────────── (B) the blackjack close-refund fix ─────────────────────────────

test("(B) admin close in the betting window: a refused stake refund is OWED (its own refund key), the table stays frozen, and it lands once when it can", async () => {
  await fresh();
  const start = await total();
  const t = ok(await A(bob, "start", [], { room: null })).table;
  ok(await A(ann, "bet", ["1500"], { table: t }));
  ok(await A(bob, "bet", ["700"], { table: t }));
  const s = stakeOf(get(t), ID.ann);
  const rkey = s.key + ":refund";
  await gone(ID.ann);
  let end;
  const errs = await capture(async () => { end = await A(boss, "end", [], { table: t }); });
  assert.equal(end.ok, false);
  assert.match(end.reply, /still owed/);
  assert.ok(errs.some((l) => l.includes("refused") && l.includes("kept owed")), errs.join("\n"));
  const T = get(t);
  assert.equal(T.status, "open", "not closed - it used to close here and the stake was lost");
  assert.equal(T.closing, "closed by Adminy");
  assert.deepEqual(Object.keys(T.owed), [rkey], "owed by the refund's own key");
  assert.equal(T.owed[rkey].kind, "refund");
  assert.equal(T.owed[rkey].amount, 1500);
  assert.deepEqual(T.stakes, [], "not in T.stakes any more");
  assert.deepEqual(T.escrowed, {}, "nor escrowed (supply counts it as owed instead)");
  assert.deepEqual(T.eng.bets, {}, "no bet left in the engine");
  assert.deepEqual(await keys(s.key + ":refund"), []);
  assert.equal(await bal(ID.bob), 100000, "Bob's bet went back");
  assert.equal(await SUP.casinoHeld(), 1500, "the owed refund is PAT at the table");
  assert.equal(await total(), start);
  // frozen: no bet, no deal
  assert.match((await A(cat, "bet", ["500"], { table: t })).reply, /closing/);
  assert.match((await A(bob, "deal", [], { table: t })).reply, /closing/);
  // its clock: still refused -> still owed; the account is back -> paid once, the table closes
  await capture(() => later(601));
  assert.equal(get(t).status, "open");
  assert.ok(get(t).owed[rkey].tries >= 2);
  await back(ID.ann, "Ann");
  const a0 = await bal(ID.ann);
  await later(601);
  assert.deepEqual(await keys(rkey), [1500], "refunded once, by its own key");
  assert.equal(await bal(ID.ann), a0 + 1500);
  assert.equal(get(t).status, "closed");
  assert.equal((await row(t)).status, "closed");
  assert.equal(await SUP.casinoHeld(), 0);
  assert.equal(await total(), start);
  await restart();
  await later(700);
  assert.deepEqual(await keys(rkey), [1500], "never twice");
});

test("(B) leave in the betting window, then the idle close: the refused refund is owed, the table plays on, then waits frozen - never closed on it", async () => {
  await fresh();
  const start = await total();
  const t = ok(await A(bob, "start", [], { room: null })).table;
  shoes();
  ok(await A(bob, "bet", ["1000"], { table: t }));                     // round 1: both play (Bob is seated from now on)
  ok(await A(ann, "bet", ["1000"], { table: t }));
  ok(await A(bob, "deal", [], { table: t }));
  ok(await A(bob, "stand", [], { table: t }));
  ok(await A(ann, "stand", [], { table: t }));
  assert.equal(get(t).eng.phase, "betting");
  ok(await A(ann, "bet", ["1000"], { table: t }));                     // round 2: Ann bets, her account goes, she leaves the window
  const rkey = stakeOf(get(t), ID.ann).key + ":refund";
  await gone(ID.ann);
  await capture(async () => ok(await A(ann, "leave", [], { table: t })));     // (a web player whose account went in between)
  let T = get(t);
  assert.equal(T.status, "open");
  assert.ok(!T.eng.seats.includes(ID.ann), "she left");
  assert.deepEqual(Object.keys(T.owed || {}), [rkey]);
  assert.equal(T.closing, undefined, "the table plays on (Bob is seated)");
  assert.equal(await total(), start);
  // nobody bets: two empty windows -> the idle close ("no bets") - frozen, not closed
  await capture(async () => { for (let i = 0; i < 8; i++) await later(31); });
  T = get(t);
  assert.equal(T.status, "open", "the idle close waits for the owed refund");
  assert.ok(T.closing, "frozen: " + T.closing);
  assert.deepEqual(T.dl, { bet: null, ins: null, turn: null });
  assert.equal(await total(), start);
  await back(ID.ann, "Ann");
  await later(601);
  assert.deepEqual(await keys(rkey), [1000]);
  assert.equal(get(t).status, "closed");
  assert.equal(await total(), start);
});

test("(B) the frozen table's final close after an owed payout lands: a stake refund refused there is owed too - the table waits for it (it used to close and lose it)", async () => {
  await fresh();
  const start = await total();
  const { t, key } = await refusedRound();                            // Ann's payout owed; round 2's window open
  ok(await A(bob, "bet", ["1000"], { table: t }));
  const rkey = stakeOf(get(t), ID.bob).key + ":refund";
  await gone(ID.bob);
  let end;
  await capture(async () => { end = await A(bob, "end", [], { table: t }); });     // (the host)
  assert.equal(end.ok, false);
  let T = get(t);
  assert.ok(T.closing);
  assert.deepEqual(Object.keys(T.owed).sort(), [key, rkey].sort(), "the payout and the refund are both owed");
  assert.equal(await total(), start);
  // Ann is back: her payout lands on its clock - the table still waits (Bob's refund is owed)
  await back(ID.ann, "Ann");
  await capture(() => later(601));
  assert.deepEqual(await keys(key), [2000]);
  T = get(t);
  assert.equal(T.status, "open", "not closed with Bob's refund owed");
  assert.deepEqual(Object.keys(T.owed), [rkey]);
  assert.equal(await total(), start);
  await restart();                                                    // a restart in between changes nothing
  assert.equal(get(t).status, "open");
  await back(ID.bob, "Bob");
  await later(601);
  assert.deepEqual(await keys(rkey), [1000]);
  assert.equal(get(t).status, "closed");
  assert.equal(await total(), start);
});

test("(B) a timed-out (AFK) seat holds no refund: its stake is in play (its refused payout is owed like any other); the missed-rounds strike removes only seats with no bet", async () => {
  await fresh();
  const start = await total();
  const t = ok(await A(bob, "start", [], { room: null })).table;
  shoes();
  ok(await A(ann, "bet", ["1000"], { table: t }));
  ok(await A(bob, "bet", ["1000"], { table: t }));
  ok(await A(bob, "deal", [], { table: t }));
  await gone(ID.ann);
  // nobody acts: each turn times out (Bob's and Ann's) - Ann's stake is in play, settled by the round, never refunded in a window
  await capture(async () => { for (let i = 0; i < 4; i++) await later(31); });
  const T = get(t);
  assert.ok(T.eng.round_no >= 1);
  const pay = `cbj:${t}:r1:${ID.ann}:pay`;
  assert.ok(T.owed && T.owed[pay], "her refused payout is owed (kind payout)");
  assert.equal(T.owed[pay].kind, "payout");
  assert.deepEqual(Object.keys(T.owed).filter((x) => x.endsWith(":refund")), [], "no refund was owed: nothing was held in a window");
  assert.equal(await total(), start);
});

test("(C) recover at boot: a stake caught in its intent whose refund is refused is owed (it was logged and lost); the table waits for it, then closes", async () => {
  await fresh();
  let start = await total();
  const t = ok(await A(bob, "start", [], { room: null })).table;
  // Ann's stake: charged, then a crash before the table had it (the intent journal)
  const ikey = `cbj:${t}:r1:${ID.ann}:bet:99`;
  ok(await require(path.join(repo, "casino", "money")).charge(ikey, ID.ann, 800, "blackjack bet"));
  svc.stop();
  await runQuery("UPDATE casino_tables SET state = json_set(state, '$.intent', json(?)) WHERE id = ?", [JSON.stringify({ key: ikey, uid: ID.ann, amount: 800, op: "bet", ts: NOW }), t]);
  await gone(ID.ann);
  // (the 800 left Ann's wallet before she was set aside: the charged intent is PAT nowhere in the sum until it is owed)
  start -= 800;
  await capture(() => restart());
  const T = get(t);
  assert.equal(T.intent, null);
  assert.deepEqual(Object.keys(T.owed || {}), [ikey + ":refund"], "owed by the intent's refund key");
  assert.equal(T.owed[ikey + ":refund"].round, 1);
  assert.equal(T.owed[ikey + ":refund"].kind, "refund");
  assert.equal(await total(), start + 800, "counted at the table now (it used to vanish)");
  await capture(async () => { for (let i = 0; i < 6; i++) await later(31); });   // nobody bets: the idle close waits, frozen
  assert.equal(get(t).status, "open");
  assert.ok(get(t).closing);
  await back(ID.ann, "Ann");
  for (let i = 0; i < 70; i++) await later(10);
  assert.deepEqual(await keys(ikey + ":refund"), [800]);
  assert.equal((await row(t)).status, "closed", "the table that waited closes");
  assert.equal(await total(), start + 800);
});

// ───────────────────────────── (C) the Hold'em sweep fix ─────────────────────────────

test("(C) Hold'em: a buy-in caught in its intent whose refund is refused at boot is owed (it was logged and lost); the table never closes on it; it lands once", async () => {
  await fresh();
  let start = await total();
  const t = ok(await HA(bob, "start", ["25/50"], { room: null })).table;
  ok(await HA(bob, "sit", ["2000"], { table: t }));
  const ikey = `chm:${t}:${ID.ann}:buy:77`;
  ok(await require(path.join(repo, "casino", "money")).charge(ikey, ID.ann, 3000, "holdem buy-in"));
  svc.stop();
  await runQuery("UPDATE casino_tables SET state = json_set(state, '$.intent', json(?)) WHERE id = ?", [JSON.stringify({ kind: "buy", key: ikey, uid: ID.ann, amount: 3000, ts: NOW }), t]);
  await gone(ID.ann);
  start -= 3000;
  await capture(() => restart());
  const T = get(t);
  assert.deepEqual(Object.keys(T.owed || {}), [ikey + ":refund"]);
  assert.equal(await total(), start + 3000, "counted at the table");
  // Bob leaves: the table would close - it waits for the owed refund
  const errs = await capture(async () => ok(await HA(bob, "stand", [], { table: t })));
  assert.ok(errs.some((l) => /not closed .*refund is still owed/.test(l)), errs.join("\n"));
  assert.equal(get(t).status, "open");
  assert.equal(get(t).closing, "table empty");
  assert.match((await HA(bob, "end", [], { table: t })).reply || "", /stays open|not seated|only the table starter/);
  assert.equal(await total(), start + 3000);
  // its clock: the account is back -> refunded once, by its own key, and the table closes
  await back(ID.ann, "Ann");
  await capture(() => later(601));
  assert.deepEqual(await keys(ikey + ":refund"), [3000]);
  assert.equal(get(t).status, "closed");
  assert.equal(await total(), start + 3000);
});

// ───────────────────────────── (A) the tool ─────────────────────────────

/** a blackjack payout, a blackjack stake refund and a Hold'em cash-out, each owed (their accounts gone) -> {bj, bj2, hm, ...} */
async function threeOwed() {
  const { t, key } = await refusedRound();                            // Ann's payout (2000), owed at table t
  ok(await A(cat, "bet", ["600"], { table: t }));
  const cs = stakeOf(get(t), ID.cat);
  await gone(ID.cat);
  await capture(async () => A(bob, "end", [], { table: t }));        // the host closes it: frozen, Cat's refund owed
  const h = ok(await HA(bob, "start", ["25/50"], { room: null })).table;
  ok(await HA(bob, "sit", ["2000"], { table: h }));
  ok(await HA(mk(ID.dan, "Dan"), "sit", ["2500"], { table: h }));
  await gone(ID.dan);
  await capture(async () => HA(bob, "end", [], { table: h }));       // Dan's cash-out refused: the seat stays (owed), Bob's paid
  return { t, key, rkey: cs.key + ":refund", h, hkey: get(h).qol[ID.dan].refused.key };
}

test("(A) the list: every owed item - game, table, what, the member (or 'account missing' + a short reference: never an account id), amount, since, tries, the refusal, the next try", async () => {
  await fresh();
  const o = await threeOwed();
  const r = await call("/api/casino/admin/owed", ID.adm);
  assert.equal(r.status, 200);
  const items = r.body.items;
  assert.equal(items.length, 3);
  const by = (game, kind) => items.find((x) => x.game === game && x.kind === kind);
  const p = by("bj", "payout"), rf = by("bj", "refund"), c = by("holdem", "cashout");
  assert.ok(p && rf && c, JSON.stringify(items));
  assert.equal(p.what, "round 1 payout");
  assert.equal(p.amount, 2000);
  assert.equal(p.table, o.t);
  assert.equal(p.url, `/casino/blackjack/t/${o.t}`);
  assert.equal(rf.what, "stake refund (round 2)");
  assert.equal(rf.amount, 600);
  assert.equal(c.what, "cash-out (the seat's chips)");
  assert.equal(c.amount, 2500);
  assert.equal(c.url, `/casino/holdem/t/${o.h}`);
  for (const x of items) {
    assert.equal(x.member.name, null);
    assert.equal(x.member.missing, true);
    assert.match(x.member.ref, /^[0-9a-f]{8}$/);
    assert.ok(x.since && x.tries >= 1 && x.next, JSON.stringify(x));
    assert.equal(x.code, "E_TARGET_NOT_FOUND");
    assert.match(x.id, /^[0-9a-f]{16}$/);
  }
  assert.equal(p.closing, true, "its table waits to close");
  for (const uid of Object.values(ID)) assert.ok(!r.text.includes(uid), `no account id in the answer (${uid})`);
  assert.ok(!r.text.includes(o.key) && !r.text.includes(o.hkey), "nor an item's key (keys name the account)");
  // an account that is there shows by its username
  await back(ID.ann, "Ann");
  const r2 = await list();
  assert.equal(r2.items.find((x) => x.kind === "payout").member.name, "ann");
  // casino admins only; the page too; the /admin/games badge counts them
  assert.equal((await call("/api/casino/admin/owed", ID.bob)).status, 403);
  assert.equal((await call("/api/casino/admin/owed", "")).status, 401);
  const pg = await call("/admin/casino/owed", ID.adm);
  assert.equal(pg.status, 200, pg.text.slice(0, 300));
  assert.match(pg.text, /Owed casino PAT/);
  assert.match(pg.text, /Write off to the House/);
  assert.match(pg.text, /admin-owed\.js/);
  const no = await call("/admin/casino/owed", ID.bob);
  assert.equal(no.status, 302);
  assert.equal(no.location, "/login");
  const games = await call("/admin/games", ID.adm);
  assert.equal(games.status, 200);
  assert.match(games.text, /id="casinoOwedBadge">3</);
  assert.match(games.text, /href="\/admin\/casino\/owed"/);
});

test("(A) retry now (casino admins): runs the item's own key - still refused: owed, tried later; the account back: paid once, and a table waiting on it closes", async () => {
  await fresh();
  const start = await total();
  const o = await threeOwed();
  let items = (await list()).items;
  const p = items.find((x) => x.kind === "payout");
  // a casino admin (not an owner) may retry; a member may not
  assert.equal((await call("/api/casino/admin/owed/retry", ID.bob, { table: p.table, item: p.id, amount: p.amount, idem: idem() })).status, 403);
  let r;
  await capture(async () => { r = await call("/api/casino/admin/owed/retry", ID.adm, { table: p.table, item: p.id, amount: p.amount, idem: idem() }); });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "E_REFUSED");
  assert.ok(get(o.t).owed[o.key].tries >= 2);
  // Ann is back: retry now -> paid by its own key, once; a double submit (the same idem) answers the same and pays nothing more
  await back(ID.ann, "Ann");
  const a0 = await bal(ID.ann);
  const body = { table: p.table, item: p.id, amount: p.amount, idem: idem() };
  r = await call("/api/casino/admin/owed/retry", ID.adm, body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const again = await call("/api/casino/admin/owed/retry", ID.adm, body);
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.deepEqual(await keys(o.key), [2000]);
  assert.equal(await bal(ID.ann), a0 + 2000);
  assert.equal(get(o.t).status, "open", "Cat's refund is still owed there");
  // the Hold'em seat: Dan is back, retry now cashes him out by the owed key; the table that waited closes
  await back(ID.dan, "Dan");
  items = (await list()).items;
  const c = items.find((x) => x.kind === "cashout");
  r = await call("/api/casino/admin/owed/retry", ID.adm, { table: c.table, item: c.id, amount: c.amount, idem: idem() });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(await keys(o.hkey), [2500], "the refused cash-out's own key");
  assert.equal(get(o.h).status, "closed");
  // Cat's refund: back -> retry -> the blackjack table that waited closes
  await back(ID.cat, "Cat");
  const rf = (await list()).items.find((x) => x.kind === "refund");
  ok((await call("/api/casino/admin/owed/retry", ID.adm, { table: rf.table, item: rf.id, amount: rf.amount, idem: idem() })).body);
  assert.deepEqual(await keys(o.rkey), [600]);
  assert.equal(get(o.t).status, "closed");
  assert.equal((await list()).items.length, 0);
  assert.equal(await total(), start);
  const au = await audits();
  assert.ok(au.length >= 4);
  assert.ok(au.every((x) => x.detail.op === "retry" && x.detail.via === "web" && x.admin_name === "adminy"));
  assert.deepEqual(au.map((x) => x.detail.outcome), ["still refused", "paid", "paid", "paid"]);
});

test("(A) pay another account: a Pepe owner + the password step-up + a reason; credited under a NEW derived key, the item closed, the table that waited closes - and the original never paid", async () => {
  await fresh();
  const start = await total();
  const o = await threeOwed();
  const p = (await list()).items.find((x) => x.kind === "payout");
  // an Admin who isn't a Pepe owner: refused before any step-up
  const na = await ownerAct("redirect", p, { to: "bob", reason: "member's new account" }, ID.adm);
  assert.equal(na.status, 403);
  assert.equal(na.body.code, "owner_only");
  // the owner: no nonce / a wrong password / no reason / an unknown or the original account - refused, nothing moves
  const noNonce = await call("/api/casino/admin/owed/redirect", ID.own, { table: p.table, item: p.id, amount: p.amount, idem: idem(), to: "bob", reason: "member's new account", password: "pw-right" });
  assert.equal(noNonce.status, 409);
  assert.equal(noNonce.body.code, "nonce");
  assert.equal((await ownerAct("redirect", p, { to: "bob", reason: "member's new account", password: "pw-wrong" })).body.code, "password");
  assert.equal((await ownerAct("redirect", p, { to: "bob", reason: "short" })).status, 400);
  assert.equal((await ownerAct("redirect", p, { to: "nobody-here", reason: "member's new account" })).status, 404);
  const cross = await call("/api/casino/admin/owed/redirect", ID.own, { table: p.table, item: p.id, amount: p.amount, idem: idem(), to: "bob", reason: "member's new account" }, { origin: "https://evil.example" });
  assert.equal(cross.status, 403);
  assert.equal(cross.body.code, "cross_site");
  assert.equal(await total(), start);
  assert.deepEqual(await keys(o.key + ":redirect"), []);
  // the right one: Bob gets Ann's 2000 under <key>:redirect
  const b0 = await bal(ID.bob);
  const n = await nonce(ID.own);
  const body = { table: p.table, item: p.id, amount: p.amount, idem: idem(), to: "Bob", reason: "member's new account (ticket 12)", nonce: n, password: "pw-right" };
  const r = await call("/api/casino/admin/owed/redirect", ID.own, body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.message, /Paid 2,000 PAT to bob/);
  assert.deepEqual(await keys(o.key + ":redirect"), [2000]);
  assert.equal(await bal(ID.bob), b0 + 2000);
  assert.ok(!get(o.t).owed[o.key], "closed");
  assert.equal(await total(), start, "conserved");
  // a double submit (the same idem, a fresh nonce): answered from the first, nothing more moves
  const again = await call("/api/casino/admin/owed/redirect", ID.own, Object.assign({}, body, { nonce: await nonce(ID.own) }));
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(await bal(ID.bob), b0 + 2000);
  // the original account comes back; its clock and a restart never pay the original key
  await back(ID.ann, "Ann");
  await later(700);
  await restart();
  await later(700);
  assert.deepEqual(await keys(o.key), [], "never paid to the original after a redirect");
  assert.deepEqual(await keys(o.key + ":redirect"), [2000]);
  const au = (await audits()).filter((x) => x.detail.op === "redirect" && x.detail.outcome === "done");
  assert.equal(au.length, 1);
  assert.equal(au[0].admin_name, "owner");
  assert.equal(au[0].reason, "member's new account (ticket 12)");
  assert.equal(au[0].detail.to, "bob");
  assert.equal(au[0].detail.amount, 2000);
  assert.equal(au[0].detail.via, "web");
  // the last owed items of the blackjack table: Cat's refund redirected too -> the table that waited closes
  const rf = (await list()).items.find((x) => x.kind === "refund");
  assert.equal((await ownerAct("redirect", rf, { to: "dan", reason: "the member asked for it" })).status, 404, "Dan's account is gone");
  ok((await ownerAct("redirect", rf, { to: "bob", reason: "the member asked for it" })).body);
  assert.equal(get(o.t).status, "closed");
  assert.equal((await row(o.t)).status, "closed");
  // the Hold'em seat: redirected -> the seat leaves without a credit of its own, the table that waited closes
  const c = (await list()).items.find((x) => x.kind === "cashout");
  const b1 = await bal(ID.bob);
  ok((await ownerAct("redirect", c, { to: "bob", reason: "the member's other account" })).body);
  assert.equal(await bal(ID.bob), b1 + 2500);
  assert.equal(get(o.h).status, "closed");
  assert.deepEqual(await keys(o.hkey + ":redirect"), [2500]);
  assert.deepEqual(await keys(o.hkey), [], "the seat's own cash-out key never landed");
  await back(ID.dan, "Dan");
  await restart();
  await later(700);
  assert.deepEqual(await keys(o.hkey), []);
  assert.equal(await SUP.casinoHeld(), 0);
  assert.equal(await total(), start);
});

test("(A) write off to the House: the owed PAT goes to the House leg (jackpot_rakes, the table's casino spin id) - never burned; supply stops counting it; the tables close", async () => {
  await fresh();
  const start = await total();
  const o = await threeOwed();
  const h0 = await house();
  const held0 = await SUP.casinoHeld();
  const items = (await list()).items;
  for (const it of items) {
    const r = await ownerAct("writeoff", it, { reason: "account purged, nobody to pay" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.message, /back to the House/);
  }
  assert.equal(await house(), h0 + 2000 + 600 + 2500);
  assert.deepEqual(await rakes(o.key + ":writeoff"), [{ amount: 2000, spinId: `cbj:${o.t}:r1` }]);
  assert.deepEqual(await rakes(o.rkey + ":writeoff"), [{ amount: 600, spinId: `cbj:${o.t}:r2` }]);
  assert.deepEqual(await rakes(o.hkey + ":writeoff"), [{ amount: 2500, spinId: `chm:${o.h}:owed` }]);
  assert.equal(held0, 2000 + 600 + 2500);
  assert.equal(await SUP.casinoHeld(), 0, "supply stops counting what was written off");
  assert.equal(get(o.t).status, "closed");
  assert.equal(get(o.h).status, "closed");
  assert.equal(await total(), start, "conserved: the House has it");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM transactions WHERE transactionId LIKE '%:writeoff'"))[0].n, 0, "nothing credited to a wallet");
  // the accounts come back: nothing is paid to them (the clocks, a restart)
  for (const [id, nm] of [[ID.ann, "Ann"], [ID.cat, "Cat"], [ID.dan, "Dan"]]) await back(id, nm);
  await restart();
  await later(700);
  for (const kk of [o.key, o.rkey, o.hkey]) assert.deepEqual(await keys(kk), []);
  assert.equal(await total(), start);
  const au = (await audits()).filter((x) => x.detail.op === "writeoff");
  assert.equal(au.length, 3);
  assert.ok(au.every((x) => x.reason === "account purged, nobody to pay" && x.detail.outcome === "done" && x.admin_name === "owner"));
  // a frozen ROUND (everyone left; its payout owed): settling its last owed item marks it done and closes the table
  await fresh();
  const s2 = await total();
  const t = ok(await A(ann, "start", [], { room: null })).table;
  shoes();
  ok(await A(ann, "bet", ["1000"], { table: t }));
  ok(await A(ann, "deal", [], { table: t }));
  ok(await A(ann, "leave", [], { table: t }));
  await gone(ID.ann);
  await capture(async () => ok(await A(ann, "stand", [], { table: t })));
  assert.equal(get(t).round.settle, "owed");
  assert.equal(get(t).closing, "everyone left");
  const it = (await list()).items[0];
  ok((await ownerAct("writeoff", it, { reason: "account purged, nobody to pay" })).body);
  assert.equal(get(t).round.settle, "done", "the frozen round is done");
  assert.equal(get(t).status, "closed");
  assert.equal(get(t).closing, undefined);
  assert.equal(await total(), s2);
});

test("(A) refused when the item changed since the page was drawn: a wrong amount, an item paid in between, a table gone - nothing moves", async () => {
  await fresh();
  const start = await total();
  const o = await threeOwed();
  const p = (await list()).items.find((x) => x.kind === "payout");
  const wrong = await ownerAct("writeoff", Object.assign({}, p, { amount: p.amount - 1 }), { reason: "account purged for good" });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.code, "E_CHANGED");
  // the automatic retry pays it between the page and the click
  await back(ID.ann, "Ann");
  await later(601);
  assert.deepEqual(await keys(o.key), [2000]);
  const late = await ownerAct("redirect", p, { to: "bob", reason: "member's new account" });
  assert.equal(late.status, 409);
  assert.equal(late.body.code, "E_CHANGED");
  const late2 = await call("/api/casino/admin/owed/retry", ID.adm, { table: p.table, item: p.id, amount: p.amount, idem: idem() });
  assert.equal(late2.body.code, "E_CHANGED");
  assert.deepEqual(await keys(o.key + ":redirect"), []);
  assert.deepEqual(await keys(o.key), [2000]);
  assert.equal((await call("/api/casino/admin/owed/retry", ID.adm, { table: "0000000000", item: p.id, amount: p.amount, idem: idem() })).body.code, "E_GONE");
  assert.equal(await total(), start);
});

test("(A) an item whose own credit landed while the table's save was behind: a redirect / write-off finds it paid - closes it, moves nothing", async () => {
  await fresh();
  const start = await total();
  const o = await threeOwed();
  const p = (await list()).items.find((x) => x.kind === "payout");
  await back(ID.ann, "Ann");
  ok(await require(path.join(repo, "casino", "money")).credit(o.key, ID.ann, 2000, "blackjack payout"));   // (landed; the table never saw it)
  assert.equal(await total(), start, "supply doesn't count a landed item twice");
  const r = await ownerAct("redirect", p, { to: "bob", reason: "member's new account" });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "E_LANDED");
  assert.deepEqual(await keys(o.key + ":redirect"), []);
  assert.ok(!get(o.t).owed[o.key], "closed as paid");
  const h0 = await house();
  const rf = (await list()).items.find((x) => x.kind === "refund");
  await back(ID.cat, "Cat");
  ok(await require(path.join(repo, "casino", "money")).credit(o.rkey, ID.cat, 600, "blackjack refund (table closed)"));
  const w = await ownerAct("writeoff", rf, { reason: "account purged for good" });
  assert.equal(w.body.code, "E_LANDED");
  assert.equal(await house(), h0, "nothing written off");
  assert.equal(get(o.t).status, "closed", "its last owed item closed: the table that waited closes");
  assert.equal(await total(), start);
});

test("(A) a restart mid-action: journalled before the money moves - a crash before it drops the action (still owed), a crash after it finishes it (closed, never paid twice)", async () => {
  // (1) a crash after the journal, before the move: nothing moved; the boot drops the act (audited) and the item stays owed
  await fresh();
  let start = await total();
  let o = await threeOwed();
  let p = (await list()).items.find((x) => x.kind === "payout");
  svc.S.hooks.crash = "owed:act";
  await assert.rejects(svc.OW.act("redirect", { userId: ID.own, username: "owner" }, { table: p.table, item: p.id, amount: p.amount, idem: idem(), to: "bob", reason: "member's new account" }));
  assert.ok((await row(o.t)).s.owed_act, "the act is journalled on the table");
  assert.deepEqual(await keys(o.key + ":redirect"), []);
  await capture(() => restart());
  assert.equal(get(o.t).owed_act, null);
  assert.ok(get(o.t).owed[o.key], "still owed");
  assert.equal((await audits()).filter((x) => /interrupted/.test(x.detail.outcome)).length, 1);
  assert.equal(await total(), start);
  await back(ID.ann, "Ann");
  await later(601);
  assert.deepEqual(await keys(o.key), [2000], "paid by its own clock afterwards, once");
  // (2) a crash after the move, before the item closed: supply counts it once meanwhile; the boot closes it - the original account back
  //     and its clock firing never pay it again
  await fresh();
  start = await total();
  o = await threeOwed();
  p = (await list()).items.find((x) => x.kind === "payout");
  svc.S.hooks.crash = "owed:moved";
  await assert.rejects(svc.OW.act("redirect", { userId: ID.own, username: "owner" }, { table: p.table, item: p.id, amount: p.amount, idem: idem(), to: "bob", reason: "member's new account" }));
  assert.deepEqual(await keys(o.key + ":redirect"), [2000]);
  svc.stop();                                                          // (the process died here: the saved table still has the item + the act)
  assert.ok((await row(o.t)).s.owed[o.key]);
  assert.equal(await total(), start, "between the move and the table's save the item is counted once (the redirect landed)");
  await back(ID.ann, "Ann");                                           // the original account is back before the boot
  await capture(() => restart());
  assert.ok(!get(o.t).owed[o.key], "the boot finished the act: the item is closed");
  await later(700);
  assert.deepEqual(await keys(o.key), [], "never paid to the original");
  assert.equal((await audits()).filter((x) => x.detail.op === "redirect").length, 1, "one audit row for the act");
  assert.equal(await total(), start);
  // the same for a Hold'em seat written off: the seat leaves at the boot
  const c = (await list()).items.find((x) => x.kind === "cashout");
  svc.S.hooks.crash = "owed:moved";
  await assert.rejects(svc.OW.act("writeoff", { userId: ID.own, username: "owner" }, { table: c.table, item: c.id, amount: c.amount, idem: idem(), reason: "account purged for good" }));
  svc.stop();
  assert.equal(await total(), start, "the seat's stack is counted once (the House has it)");
  await back(ID.dan, "Dan");
  await capture(() => restart());
  assert.ok(!get(o.h).eng.seats.includes(ID.dan), "the seat left at the boot");
  await later(700);
  assert.deepEqual(await keys(o.hkey), []);
  assert.equal(await total(), start);
});

test("(A) a staging copy taken between a redirect's move and its close: the copy's retire never pays the original key (the act is finished first)", async () => {
  await fresh();
  const start = await total();
  const o = await threeOwed();
  const p = (await list()).items.find((x) => x.kind === "payout");
  svc.S.hooks.crash = "owed:moved";
  await assert.rejects(svc.OW.act("redirect", { userId: ID.own, username: "owner" }, { table: p.table, item: p.id, amount: p.amount, idem: idem(), to: "bob", reason: "member's new account" }));
  svc.stop();
  // the copy's scrub (deploy/keep-staging-tables.js), then staging's boot with every account there
  const K = require(path.join(repo, "deploy", "keep-staging-tables"));
  for (const s of K.CASINO_SCRUB) await runQuery(s.sql.replace(/\bmain\./g, "")).catch((e) => { if (!/no such table/.test(e.message)) throw e; });
  for (const [id, nm] of [[ID.ann, "Ann"], [ID.cat, "Cat"], [ID.dan, "Dan"]]) await back(id, nm);
  await capture(() => restart());
  assert.equal((await row(o.t)).status, "closed", "the copy is retired");
  assert.deepEqual(await keys(o.key), [], "never paid to the original - the redirect landed");
  assert.deepEqual(await keys(o.key + ":redirect"), [2000]);
  assert.deepEqual(await keys(o.rkey), [600], "what was still owed is paid by its own key");
  assert.equal(await total(), start);
});

test("(A) a redirect never pays twice even when the original account comes back and the automatic retry fires at the same moment", async () => {
  for (const order of ["tick-first", "redirect-first"]) {
    await fresh();
    const start = await total();
    const o = await threeOwed();
    const p = (await list()).items.find((x) => x.kind === "payout");
    await back(ID.ann, "Ann");
    NOW += 601e3;                                                        // its clock has run out: the tick will try it
    const tick = () => svc.tickOnce();
    const redirect = () => svc.OW.act("redirect", { userId: ID.own, username: "owner" }, { table: p.table, item: p.id, amount: p.amount, idem: idem(), to: "bob", reason: "member's new account" });
    const b = order === "tick-first" ? (await Promise.all([tick(), redirect()]))[1] : (await Promise.all([redirect(), tick()]))[0];
    const paid = (await keys(o.key)).length, redirected = (await keys(o.key + ":redirect")).length;
    assert.equal(paid + redirected, 1, `${order}: exactly one of the original and the redirect landed (${paid} / ${redirected}; ${JSON.stringify(b)})`);
    await restart();
    await later(700);
    assert.equal((await keys(o.key)).length + (await keys(o.key + ":redirect")).length, 1, order);
    assert.equal(await total(), start, order);
  }
});

test("(A) the owner's step-up purpose: a nonce for casino_owed only for a Pepe owner; a retry needs none", async () => {
  await fresh();
  assert.equal((await call("/api/admin/stepup/nonce", ID.adm, { for: "casino_owed" })).status, 403);
  assert.ok(await nonce(ID.own));
  assert.equal(OW.itemsOf({ status: "open", game: "bj", owed: { x: { uid: "z", amount: 0 } } }).length, 0, "nothing of 0 PAT is listed");
  // an item's id is never its key, and one table's item can't be acted on through another
  const T1 = { id: "aaaaaaaaaa" }, T2 = { id: "bbbbbbbbbb" };
  assert.notEqual(OW.itemId(T1, "k"), OW.itemId(T2, "k"));
  assert.match(OW.itemId(T1, "cbj:aaaaaaaaaa:r1:p-ann-01:pay"), /^[0-9a-f]{16}$/);
});
