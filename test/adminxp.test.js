// The admin XP / level control (1.99cy, adminxp.js + user.controller.js adminAdjustXp): admins only, same-site
// JSON, input checks, preview-then-confirm, add / take away XP / set level, NO level-up rewards, the admin audit row,
// serialised with game XP awards, and the card no longer says "known issue".
//   node --test test/adminxp.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adminxp-"));
process.chdir(tmp);
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const funding = require(path.join(repo, "funding"));
const paid = [];
funding.fundPayout = async (userId, amount, flow, type) => { paid.push({ userId, amount, type }); await runQuery("UPDATE users SET points_balance = points_balance + ? WHERE userId = ?", [amount, userId]); return true; };

let base, server, uc;
const UID = { boss: "u_boss", mod: "u_mod", ann: "u_ann", ben: "u_ben" };
test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT, class TEXT DEFAULT 'pleb', xp REAL DEFAULT 0,
                  level INTEGER DEFAULT 1, points_balance INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER,
                  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT)`);
  for (const [n, id] of Object.entries(UID)) {
    await runQuery("INSERT INTO users (userId, username, class, xp, level) VALUES (?, ?, ?, ?, ?)",
                   [id, n, n === "boss" ? "Admin" : n === "mod" ? "Staff" : "pleb", n === "ann" ? 500 : 0, n === "ann" ? 3 : 1]);
  }
  uc = require(path.join(repo, "user.controller"));
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u } : null; next(); };
  require(path.join(repo, "adminxp")).register(app, { addUser });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server.close());

async function call(who, body, extra = {}) {
  const r = await fetch(base + "/api/admin/update-level", { method: "POST", body: JSON.stringify(body),
    headers: Object.assign({ "content-type": "application/json" }, who ? { "x-test-user": who } : {}, extra) });
  return { status: r.status, d: await r.json().catch(() => null) };
}
const userRow = async (id) => (await getQuery("SELECT xp, level, points_balance FROM users WHERE userId = ?", [id]))[0];

test("level maths: totals and back", () => {
  assert.equal(uc.totalXpOf(0, 0), 0);
  assert.equal(uc.totalXpOf(2, 10), 1000 + 4000 + 10);
  assert.deepEqual(uc.levelOfTotal(5010), { level: 2, xp: 10 });
  assert.deepEqual(uc.levelOfTotal(-50), { level: 0, xp: 0 });
});

test("admins only; same-site; JSON only", async () => {
  assert.equal((await call(null, { username: "ann", mode: "add", amount: 10 })).status, 403);
  assert.equal((await call(UID.ann, { username: "ann", mode: "add", amount: 10 })).status, 403, "a member");
  assert.equal((await call(UID.mod, { username: "ann", mode: "add", amount: 10 })).status, 403, "Staff isn't enough");
  assert.equal((await call(UID.boss, { username: "ann", mode: "add", amount: 10 }, { origin: "https://evil.example" })).status, 403, "cross-site");
  const r = await fetch(base + "/api/admin/update-level", { method: "POST", body: "username=ann&amount=5", headers: { "content-type": "application/x-www-form-urlencoded", "x-test-user": UID.boss } });
  assert.equal(r.status, 415);
});

test("input checks", async () => {
  const bad = async (b, re) => { const r = await call(UID.boss, b); assert.equal(r.status, 400, JSON.stringify(b)); assert.match(r.d.error, re); };
  await bad({ username: "", mode: "add", amount: 5 }, /username/i);
  await bad({ username: "ann", mode: "steal", amount: 5 }, /add XP or set level/);
  await bad({ username: "ann", mode: "add", amount: "12abc" }, /whole number/);
  await bad({ username: "ann", mode: "add", amount: 1.5 }, /whole number/);
  await bad({ username: "ann", mode: "add", amount: 0 }, /changes nothing/);
  await bad({ username: "ann", mode: "add", amount: 60000000 }, /At most/);
  await bad({ username: "ann", mode: "set_level", amount: -1 }, /between 0 and 200/);
  await bad({ username: "ann", mode: "set_level", amount: 201 }, /between 0 and 200/);
  const nf = await call(UID.boss, { username: "nobody", mode: "add", amount: 5 });
  assert.equal(nf.status, 404);
});

test("preview changes nothing; confirm applies; no level-up rewards; audited", async () => {
  const before = await userRow(UID.ann);
  const p = await call(UID.boss, { username: "@Ann", mode: "add", amount: 20000 });
  assert.equal(p.status, 200);
  assert.equal(p.d.applied, false);
  assert.deepEqual(p.d.before, { level: 3, xp: 500 });
  // 3 -> total 14000+500 = 14500 + 20000 = 34500 -> Lv 4 (30000) + 4500
  assert.deepEqual(p.d.after, { level: 4, xp: 4500 });
  assert.equal(p.d.rewards, false);
  assert.deepEqual(await userRow(UID.ann), before, "a preview writes nothing");
  const a = await call(UID.boss, { username: "ann", mode: "add", amount: 20000, reason: "lost XP in the outage", confirm: true });
  assert.equal(a.d.applied, true);
  const u = await userRow(UID.ann);
  assert.deepEqual({ level: u.level, xp: u.xp }, { level: 4, xp: 4500 });
  assert.equal(u.points_balance, 0, "no PAT");
  assert.equal(paid.filter((x) => x.userId === UID.ann).length, 0, "no level-up reward paid");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM levelup_rewards WHERE userId = ?", [UID.ann]))[0].n, 0, "no reward rows written");
  const log = await getQuery("SELECT * FROM admin_audit WHERE action = 'xp' ORDER BY id DESC");
  assert.equal(log.length, 1, "only the applied change is logged");
  assert.equal(log[0].admin_name, "boss");
  assert.equal(log[0].target_name, "ann");
  assert.equal(log[0].reason, "lost XP in the outage");
  const D = JSON.parse(log[0].detail);
  assert.deepEqual(D.before, { level: 3, xp: 500 });
  assert.deepEqual(D.after, { level: 4, xp: 4500 });
  assert.equal(D.rewards, false);
  // the recent list (admins only)
  const rr = await fetch(base + "/api/admin/xp/recent", { headers: { "x-test-user": UID.boss } });
  assert.equal((await rr.json()).items[0].target, "ann");
  assert.equal((await fetch(base + "/api/admin/xp/recent", { headers: { "x-test-user": UID.mod } })).status, 403);
});

test("taking XP away can drop levels (never below 0); set level resets XP to 0", async () => {
  let r = await call(UID.boss, { username: "ann", mode: "add", amount: -30000, confirm: true });
  assert.deepEqual(r.d.after, uc.levelOfTotal(uc.totalXpOf(4, 4500) - 30000));
  r = await call(UID.boss, { username: "ann", mode: "add", amount: -50000000, confirm: true });
  assert.deepEqual(r.d.after, { level: 0, xp: 0 });
  r = await call(UID.boss, { username: "ben", mode: "set_level", amount: 12, confirm: true });
  assert.deepEqual(r.d.after, { level: 12, xp: 0 });
  assert.deepEqual(await userRow(UID.ben), { level: 12, xp: 0, points_balance: 0 }, "Lv 5 and Lv 10 milestones not paid either");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM levelup_milestones WHERE userId = ?", [UID.ben]))[0].n, 0);
  // levels set by an admin and then earned for real later still pay normally (nothing was recorded)
  await call(UID.boss, { username: "ben", mode: "set_level", amount: 1, confirm: true });
  await uc.updateLevel(UID.ben, uc.xpForNextLevel(1));
  assert.ok(paid.some((x) => x.userId === UID.ben && /Lv 2/.test(x.type)), "earning Lv 2 by playing pays");
});

test("serialised with game awards through the same per-user lock", async () => {
  await call(UID.boss, { username: "ann", mode: "set_level", amount: 1, confirm: true });
  await Promise.all([
    uc.updateLevel(UID.ann, 100),
    call(UID.boss, { username: "ann", mode: "add", amount: 50, confirm: true }),
    uc.updateLevel(UID.ann, 100),
  ]);
  const u = await userRow(UID.ann);
  assert.equal(u.level, 1);
  assert.equal(u.xp, 250, "no update lost");
});

test("the card: no 'known issue', a confirm step, the right request body", () => {
  const view = fs.readFileSync(path.join(repo, "views/admin/users.ejs"), "utf8");
  assert.doesNotMatch(view, /Known issue/i);
  assert.match(view, /id="xpMode"/);
  const js = fs.readFileSync(path.join(repo, "public/js/admin-panel.js"), "utf8");
  assert.match(js, /window\.confirm\(msg\)/);
  assert.match(js, /body\.confirm = true/);
});
