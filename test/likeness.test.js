// Offline tests for 1.99qw likeness royalties (likeness.js) + the 250 PAT chat quote (quotes.js).
//   booking: split between subjects, never to the payer / a linked account, young / low-level accounts and opted-out
//   people earn nothing, the per-pair daily cap; voids; the daily release (24 h hold, 00:00 UTC, per-subject cap, frozen,
//   crash recovery); Pepe's sync route (bot token, opt-outs + blocks + % back); the opt-out routes and page; a quote
//   charges its author 250, books 40% for the people quoted as an lkhold claim and is refused when one opted out.
//   NODE_PATH=G:/PATV/node_modules node --test test/likeness.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "likeness-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const L = require(path.join(repo, "likeness"));
const funding = require(path.join(repo, "funding"));

const DAY = 24 * 3600 * 1000;
let T = Date.UTC(2026, 9, 11, 15, 0, 0);
L._setClock(() => T);
let base, server;
const users = new Map();
async function mkUser(name, o = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at)
                  VALUES (?, ?, ?, 'x', ?, ?, ?, ?, ?)`, [id, name, name, o.class || "pleb", o.bal == null ? 100000 : o.bal, o.camfrog === undefined ? name + "cf" : o.camfrog,
                  o.level == null ? 10 : o.level, o.created || "2026-01-01 00:00:00"]);
  const x = { userId: id, username: name, class: o.class || "pleb" };
  users.set(id, x);
  return x;
}
const H = (x) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch", origin: base }, x ? { "x-test-user": x.userId } : {});
async function call(method, url, x, body) {
  const r = await fetch(base + url, { method, headers: H(x), body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  let d = null;
  try { d = await r.clone().json(); } catch (e) { d = null; }
  return { status: r.status, d, text: d ? null : await r.text() };
}
const U = {};
const rows = (ref) => getQuery("SELECT * FROM likeness_ledger WHERE ref LIKE ? ORDER BY ref", [ref + "%"]);

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await runQuery("CREATE TABLE welcome_bonus (userId TEXT PRIMARY KEY, state TEXT, dup_of TEXT)");
  await runQuery("CREATE TABLE dm_blocks (blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL)");
  await funding.init();
  await L.init();
  U.alice = await mkUser("alice");
  U.bob = await mkUser("bob");
  U.carol = await mkUser("carol");
  U.newbie = await mkUser("newbie", { created: "2026-10-09 00:00:00" });
  U.low = await mkUser("lowlvl", { level: 1 });
  U.alt = await mkUser("bobalt");
  U.shy = await mkUser("shy");
  U.admin = await mkUser("boss", { class: "Admin" });
  await runQuery("INSERT INTO welcome_bonus (userId, state, dup_of) VALUES (?, 'duplicate', ?)", [U.alt.userId, U.bob.userId]);
  // the Reserve pays the release (Pepe's funding sync: likeness -> reserve, 10M in it)
  funding.sync({ reserve: 10000000, flows: { likeness: "reserve" } });
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  L.register(app, { addUser, isBotToken: (t) => t === "bot" });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });

test("booking: split between subjects; payer, alts, young / low-level accounts earn nothing", async () => {
  let r = await L.book({ ref: "c1", key: "imagine", flow: "imagine", subjects: ["bobcf", "carolcf"], payer: "alicecf", base: 25000, amount: 10001, ts: T });
  assert.deepEqual(r, { held: 10001, forfeit: 0 });
  const c1 = await rows("c1");
  assert.deepEqual(c1.map((x) => [x.subject_user_id, x.amount, x.status]), [[U.bob.userId, 5001, "held"], [U.carol.userId, 5000, "held"]]);
  assert.equal(c1[0].release_after, T + DAY);
  assert.equal(c1[0].kind, "cam");
  r = await L.book({ ref: "c1", key: "imagine", subjects: ["bobcf"], payer: "alicecf", amount: 500 });
  assert.equal(r.dup, true, "a re-sent ref books nothing");
  r = await L.book({ ref: "c2", key: "snap", subjects: ["bobcf"], payer: "bobaltcf", amount: 1000, ts: T });
  assert.deepEqual(r, { held: 0, forfeit: 1000 }, "an alt (welcome_bonus dup_of) earns nothing from its main");
  assert.equal((await rows("c2"))[0].reason, "self or a linked account");
  r = await L.book({ ref: "c3", key: "snap", subjects: ["newbiecf", "lowlvlcf"], payer: "alicecf", amount: 2000, ts: T });
  assert.equal(r.forfeit, 2000);
  assert.deepEqual((await rows("c3")).map((x) => x.reason), ["account under 7 days", "below level 3"]);
  r = await L.book({ ref: "c4", key: "snap", subjects: ["nobodycf"], payer: "alicecf", amount: 100, ts: T });
  assert.deepEqual(r, { held: 0, forfeit: 100 }, "no account -> stays with the platform");
});

test("the per-pair daily cap (25,000) forfeits the excess; opted-out subjects earn nothing", async () => {
  let r = await L.book({ ref: "p1", key: "clip", subjects: ["carolcf"], payer: "bobcf", amount: 20000, ts: T });
  assert.equal(r.held, 20000);
  r = await L.book({ ref: "p2", key: "clip", subjects: ["carolcf"], payer: "bobcf", amount: 20000, ts: T });
  assert.deepEqual(r, { held: 5000, forfeit: 15000 });
  assert.deepEqual((await rows("p2")).map((x) => [x.amount, x.status, x.reason]), [[5000, "held", null], [15000, "forfeit", "daily pair cap"]]);
  await L.setPrefs(U.shy.userId, { snaps: false });
  r = await L.book({ ref: "p3", key: "snap", subjects: ["shycf"], payer: "bobcf", amount: 1000, ts: T });
  assert.equal(r.forfeit, 1000);
  r = await L.book({ ref: "p4", key: "look", subjects: ["shycf"], payer: "bobcf", amount: 1000, ts: T });
  assert.equal(r.held, 1000, "another kind still earns");
});

test("voids: a refunded charge never releases, and a late copy can't book", async () => {
  await L.book({ ref: "v1", key: "roast", subjects: ["carolcf"], payer: "alicecf", amount: 500, ts: T });
  assert.equal(await L.voidRef("v1"), true);
  assert.equal((await rows("v1"))[0].status, "void");
  await L.voidRef("v2");
  const r = await L.book({ ref: "v2", key: "roast", subjects: ["carolcf"], payer: "alicecf", amount: 500, ts: T });
  assert.equal(r.dup, true, "the void arrived first");
});

test("release: after the hold, at 00:00 UTC, per-subject daily cap, frozen subjects wait, notices", async () => {
  let out = await L.releaseTick();
  assert.equal(out.length, 0, "nothing is due before the hold ends");
  T += DAY;                          // 15:00 next day - hold ended at 15:00, but the last midnight was before that
  out = await L.releaseTick();
  assert.equal(out.length, 0, "due only at the next 00:00 UTC");
  T += 10 * 3600 * 1000;             // 01:00 the day after
  await L.setConfig({ subject_day_cap: 6000 }, "test");
  await L.freeze(U.carol.userId, true, "test", "alt check");
  out = await L.releaseTick();
  const bob = out.find((x) => x.user === U.bob.userId);
  assert.deepEqual(bob, { user: U.bob.userId, outcome: "paid", amount: 5001 });
  assert.equal(out.find((x) => x.user === U.carol.userId).outcome, "frozen");
  const tx = await getQuery("SELECT points, type FROM transactions WHERE userId = ?", [U.bob.userId]);
  assert.equal(tx.length, 1);
  assert.equal(tx[0].points, 5001);
  assert.match(tx[0].type, /likeness royalties/);
  const claims = await getQuery("SELECT flow, amount FROM reserve_claims WHERE userId = ? AND flow = 'likeness'", [U.bob.userId]);
  assert.deepEqual(claims.map((c) => [c.flow, c.amount]), [["likeness", 5001]], "a Reserve claim Pepe settles");
  await L.freeze(U.carol.userId, false, "test");
  out = await L.releaseTick();
  const carol = out.find((x) => x.user === U.carol.userId);
  assert.equal(carol.outcome, "paid");
  assert.ok(carol.amount <= 6000, "at most the per-subject daily cap");
  const st = await L.status(U.carol.userId);
  assert.ok(st.held > 0 && st.paid === carol.amount, "the rest stays held for the next day");
  await L.setConfig({ subject_day_cap: 250000 }, "test");
});

test("release recovery: a crash between marking and paying is settled by the transaction it left (or retried)", async () => {
  await L.book({ ref: "r1", key: "snap", subjects: ["carolcf"], payer: "alicecf", amount: 700, ts: T - 3 * DAY });
  const id = (await rows("r1"))[0].id;
  await runQuery("UPDATE likeness_ledger SET status = 'paying', batch = 'lkr:x:y:1' WHERE id = ?", [id]);
  await runQuery("INSERT INTO transactions (transactionId, userId, type, points) VALUES ('tx-r1', ?, ?, 700)", [U.carol.userId, "🪞 likeness royalties (lkr:x:y:1)"]);
  await L.book({ ref: "r2", key: "snap", subjects: ["carolcf"], payer: "alicecf", amount: 800, ts: T - 3 * DAY });
  const id2 = (await rows("r2"))[0].id;
  await runQuery("UPDATE likeness_ledger SET status = 'paying', batch = 'lkr:x:y:2' WHERE id = ?", [id2]);
  // a fresh module instance recovers at init
  delete require.cache[require.resolve(path.join(repo, "likeness"))];
  const L2 = require(path.join(repo, "likeness"));
  await L2.init();
  assert.equal((await rows("r1"))[0].status, "paid");
  assert.equal((await rows("r2"))[0].status, "held");
});

test("Pepe's sync: bot token, cuts booked, opt-outs + blocks + % back; !likeness prefs route", async () => {
  assert.equal((await call("POST", "/api/likeness/sync", null, { password: "nope", items: [] })).status, 403);
  await runQuery("INSERT INTO dm_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, 1)", [U.carol.userId, U.alice.userId]);
  const r = await call("POST", "/api/likeness/sync", null, { password: "bot", items: [
    { ref: "s1", key: "snap", kind: "snaps", flow: "snap", subjects: ["carolcf"], payer: "alicecf", room: "X.Room", base: 25000, amount: 10000, ts: T },
    { ref: "s0", void: true }, { nonsense: 1 }] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.d.accepted, ["s1", "s0"]);
  assert.deepEqual(r.d.optouts, { shycf: ["snaps"] });
  assert.deepEqual(r.d.blocks, [["carolcf", "alicecf"]]);
  assert.equal(r.d.pct.snap, 40);
  assert.equal(r.d.pct.clipmic, 40);
  assert.equal(r.d.pct.look, 15);
  assert.equal(r.d.pct.roast, 10);
  const p = await call("POST", "/api/likeness/prefs/bot", null, { password: "bot", camfrog: "bobcf", kinds: ["roast", "cam"], on: false });
  assert.equal(p.status, 200);
  assert.deepEqual(p.d.prefs, { clips: true, snaps: true, cam: false, roast: false, soundboard: true });
  assert.equal((await call("POST", "/api/likeness/prefs/bot", null, { password: "bot", camfrog: "ghostcf", kinds: ["roast"], on: false })).status, 404);
});

test("web: the opt-out switches and /settings/likeness", async () => {
  assert.equal((await call("POST", "/api/likeness/prefs", null, { clips: false })).status, 401);
  const r = await call("POST", "/api/likeness/prefs", U.alice, { clips: false, bogus: false });
  assert.equal(r.status, 200);
  assert.equal(r.d.prefs.clips, false);
  const me = await call("GET", "/api/likeness/me", U.alice);
  assert.equal(me.d.prefs.clips, false);
  const page = await call("GET", "/settings/likeness", U.carol);
  assert.equal(page.status, 200);
  assert.match(page.text, /data-lk-kind="snaps"/);
  assert.match(page.text, /likeness\.js/);
  assert.equal((await call("GET", "/settings/likeness", null)).status, 302);
  await L.setPrefs(U.alice.userId, { clips: true });
});

test("site cut: an lkhold claim for the hold + the booking, inside the caller's transaction", async () => {
  const cut = await L.siteCut({ key: "quote", flow: "quotes", base: 250, subjects: ["bobcf", "carolcf"], payerId: U.alice.userId, room: "X.Room", ref: "quote-abc" });
  assert.equal(cut, 100, "40% of 250");
  const c = await getQuery("SELECT flow, amount FROM reserve_claims WHERE flow LIKE 'lkhold:%'");
  assert.deepEqual(c.map((x) => [x.flow, x.amount]), [["lkhold:quotes", -100]]);
  assert.deepEqual((await rows("quote-abc")).map((x) => [x.subject_login, x.amount]), [["bobcf", 50], ["carolcf", 50]]);
  assert.equal(await L.siteCut({ key: "quote", base: 250, subjects: [], payerId: U.alice.userId, ref: "quote-none" }), 0, "nobody quoted -> no cut");
});
