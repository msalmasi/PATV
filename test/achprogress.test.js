// Phase 5 (5.14): the achievement counters on the site (achprogress.js).
//   * import: off unless enabled, digest + totals checked, verified backup, ONE transaction, idempotent by key, exact
//     decimals (a counter past 2^53 survives the round trip)
//   * events: once per key (a retry answers the stored result), counters compare-and-set from Pepe's base, fields / unlocks
//     merged, thresholds evaluated ONLY for the metrics in `check` (a backfill's direct write stays quiet), held ids never
//     awarded loudly, one award per account per achievement (XP + PAT through fundPayout "achievements")
//   * rekey: counters add up, streak keeps the larger (Pepe's rule); the login re-key (loginrekey.js) moves them too
//   * rollback: the exact store handed back (sha256 + totals), the tables emptied, live off; a new import after it
//   NODE_PATH=G:/PATV/node_modules node --test test/achprogress.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "achprogress-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.DB_BACKUP_DIR = path.join(tmp, "backups");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const funding = require(path.join(repo, "funding"));
const paid = [];
funding.fundPayout = async (userId, amount, flow, why) => { paid.push({ userId, amount, flow, why }); return true; };
let A, AP;
const xp = [];

const BIG = "9007199254740993";          // 2^53 + 1: a Number can't hold it
const FILE = {
  foamy1111: { m: { chat: 99, streak: 6, heists: 154, heist_won_pat: BIG, commands: 0 }, got: ["cf_heist_1"], streak: 6, day: "2026-10-12",
               cmds: ["!spin"], shop: ["armor"] },
  _satchmo_: { m: { chat: 10, streak: 1 }, got: [], streak: 1, day: "2026-10-11" },
  nolink: { m: { chat: 99 }, got: [] },
};
const FLAGS = { _backfilled: true, _bounty_backfill: 1, _shop_backfill_v2: { at: 1, badges: 3 } };

// Pepe's export: counters as exact strings
function pack(file = FILE, flags = FLAGS, key = "ac-test-1") {
  const users = {};
  for (const [l, r] of Object.entries(file)) users[l] = Object.assign({}, r, { m: Object.fromEntries(Object.entries(r.m).map(([k, v]) => [k, String(v)])) });
  const payload = JSON.stringify({ v: 1, users, flags });
  let got = 0, metrics = 0, sum = 0n;
  for (const r of Object.values(file)) { got += r.got.length; for (const v of Object.values(r.m)) { metrics++; sum += BigInt(v); } }
  return { key, payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"),
           totals: { users: Object.keys(file).length, got, metrics, value_sum: sum.toString(), flags: Object.keys(flags).length } };
}
const badges = async (uid) => (await getQuery("SELECT badgeId FROM user_badges WHERE userId = ? AND badgeId != 'cf_linked' ORDER BY badgeId", [uid])).map((r) => r.badgeId);

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, level INTEGER DEFAULT 1, camfrogUsername TEXT, archived_at INTEGER)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS badges (badgeId TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, icon TEXT,
                  points INTEGER DEFAULT 0, requirement TEXT NOT NULL, createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS user_badges (userId TEXT NOT NULL, badgeId TEXT NOT NULL, awardedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                  PRIMARY KEY (userId, badgeId))`);
  await runQuery("INSERT INTO users (userId, username, camfrogUsername) VALUES ('u1', 'foamy', 'Foamy1111'), ('u2', 'satch', '_satchmo_'), ('u3', 'webonly', NULL)");
  A = require(path.join(repo, "achievements"));
  A.setUpdateLevel(async (userId, amount) => { xp.push({ userId, amount }); return null; });
  await A.ready;
  AP = require(path.join(repo, "achprogress"));
  await AP.init();
});

test("import: refused while the switch is off; digest and totals are checked; nothing is written by a refusal", async () => {
  await assert.rejects(AP.importFromPepe(pack()), (e) => e.code === "E_FEATURE_OFF");
  await AP.setMeta("enabled", true);
  const bad = pack();
  await assert.rejects(AP.importFromPepe(Object.assign({}, bad, { digest: "0".repeat(64) })), (e) => e.code === "E_DIGEST");
  await assert.rejects(AP.importFromPepe(Object.assign({}, bad, { totals: Object.assign({}, bad.totals, { got: 99 }) })), (e) => e.code === "E_TOTALS");
  await assert.rejects(AP.importFromPepe(Object.assign({}, bad, { totals: Object.assign({}, bad.totals, { value_sum: "1" }) })), (e) => e.code === "E_TOTALS");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM ach_progress"))[0].n, 0);
  assert.equal(await AP.live(), false);
});

test("import: one transaction, exact (a counter past 2^53 stays exact), idempotent by key; a second import refused", async () => {
  const p = pack();
  const r = await AP.importFromPepe(p);
  assert.equal(r.ok, true);
  assert.equal(r.match, true);
  assert.deepEqual(r.totals, p.totals);
  assert.ok(fs.existsSync(r.backup), "verified backup first");
  assert.equal(await AP.live(), true);
  const rec = await AP.readRecord("foamy1111");
  assert.equal(rec.m.heist_won_pat, BIG);
  assert.deepEqual(rec.cmds, ["!spin"]);
  assert.deepEqual(rec.got, ["cf_heist_1"]);
  const again = await AP.importFromPepe(p);
  assert.equal(again.already, true);
  await assert.rejects(AP.importFromPepe(pack(FILE, FLAGS, "ac-test-2")), (e) => e.code === "E_ALREADY");
  assert.deepEqual((await AP.exportObject()).flags, FLAGS);
});

test("events: a bump crossing a threshold awards ONCE (XP + PAT from the achievements group), a retry answers the same", async () => {
  const ev = { key: "pb:1:1", login: "foamy1111", m: { chat: ["99", "100"] }, check: ["chat"] };
  const r = await AP.applyEvents([ev], []);
  const res = r.results["pb:1:1"];
  assert.deepEqual(res.awards.map((a) => a.id), ["cf_chat_100"]);
  assert.equal(res.awards[0].patPaid, true);
  assert.deepEqual(res.got, ["cf_chat_100"]);
  assert.deepEqual(await badges("u1"), ["cf_chat_100"]);
  assert.deepEqual(paid.map((p) => [p.userId, p.amount, p.flow]), [["u1", 10000, "achievements"]]);
  assert.deepEqual(xp.map((x) => x.amount), [1000]);
  const again = await AP.applyEvents([ev], []);
  assert.equal(again.results["pb:1:1"].replay, true);
  assert.deepEqual(again.results["pb:1:1"].awards.map((a) => a.id), ["cf_chat_100"], "the stored answer (Pepe announces once: he dropped it from his outbox)");
  assert.equal(paid.length, 1, "paid once");
  assert.equal((await AP.readRecord("foamy1111")).m.chat, "100");
  assert.ok((await AP.readRecord("foamy1111")).got.includes("cf_chat_100"));
});

test("events: a backfill's direct write (no check) is quiet; held ids are never awarded loudly; no account = nothing paid, retried later", async () => {
  // the shop backfill sets counters straight into the record - no `check`: nothing evaluated
  let r = await AP.applyEvents([{ key: "pb:1:2", login: "_satchmo_", m: { chat: ["10", "5000"] } }], []);
  assert.equal(r.results["pb:1:2"].awards, undefined);
  assert.deepEqual(await badges("u2"), []);
  // a bump of a held metric's achievement: skipped
  r = await AP.applyEvents([{ key: "pb:1:3", login: "_satchmo_", m: { chat: ["5000", "5001"] }, check: ["chat"] }], ["cf_chat_100", "cf_chat_1k"]);
  assert.deepEqual(r.results["pb:1:3"].awards, []);
  assert.deepEqual(await badges("u2"), []);
  // nobody behind the login: refused, not marked got, so a later bump tries again
  r = await AP.applyEvents([{ key: "pb:1:4", login: "nolink", m: { chat: ["99", "100"] }, check: ["chat"] }], []);
  assert.deepEqual(r.results["pb:1:4"].awards, []);
  assert.deepEqual(r.results["pb:1:4"].failed, ["cf_chat_100"]);
  assert.ok(!(await AP.readRecord("nolink")).got.includes("cf_chat_100"));
  await runQuery("INSERT INTO users (userId, username, camfrogUsername) VALUES ('u4', 'nl', 'nolink')");
  r = await AP.applyEvents([{ key: "pb:1:5", login: "nolink", m: { chat: ["100", "101"] }, check: ["chat"] }], []);
  assert.deepEqual(r.results["pb:1:5"].awards.map((a) => a.id), ["cf_chat_100"]);
});

test("events: compare-and-set from Pepe's base; a stale base adds the difference; fields / unlocks merge; flags; a new login", async () => {
  // the site has chat=101 for foamy... no: foamy is at 100. A stale `from` (98 -> 99) adds +1
  let r = await AP.applyEvents([{ key: "pb:1:6", login: "foamy1111", m: { chat: ["98", "99"] }, set: { day: "2026-10-13", cmds: ["!spin", "!tip"] },
                                   got: ["cf_shop_1"] }], []);
  assert.equal(r.results["pb:1:6"].diverged, 1);
  let rec = await AP.readRecord("foamy1111");
  assert.equal(rec.m.chat, "101");
  assert.equal(rec.day, "2026-10-13");
  assert.deepEqual(rec.cmds, ["!spin", "!tip"]);
  assert.deepEqual(rec.got, ["cf_heist_1", "cf_chat_100", "cf_shop_1"]);
  // the big counter moves exactly
  await AP.applyEvents([{ key: "pb:1:7", login: "foamy1111", m: { heist_won_pat: [BIG, "9007199254741000"] } }], []);
  assert.equal((await AP.readRecord("foamy1111")).m.heist_won_pat, "9007199254741000");
  await AP.applyEvents([{ key: "pb:1:8", flag: "_kit_backfill_v1", value: { at: 2 } }, { key: "pb:1:9", login: "newbie", m: { chat: ["0", "1"] }, set: { day: "2026-10-12", streak: 1 } }], []);
  assert.deepEqual((await AP.exportObject()).flags._kit_backfill_v1, { at: 2 });
  rec = await AP.readRecord("newbie");
  assert.deepEqual([rec.m.chat, rec.streak, rec.got], ["1", 1, []]);
  await assert.rejects(AP.applyEvents([{ key: "x", login: "a" }], []), /bad event key/);
});

test("rekey: counters add up, the streak keeps the larger, lists union (Pepe's merge); the login re-key moves the record", async () => {
  await AP.applyEvents([{ key: "pb:1:10", login: "oldname", m: { chat: ["0", "50"], streak: ["0", "9"] }, set: { cmds: ["!heist"] }, got: ["cf_cmd_1"] }], []);
  await AP.applyEvents([{ key: "pb:1:11", rekey: { old: "oldname", new: "_satchmo_" } }], []);
  const rec = await AP.readRecord("_satchmo_");
  assert.equal(rec.m.chat, "5051");
  assert.equal(rec.m.streak, "9");
  assert.deepEqual(rec.cmds, ["!heist"]);
  assert.ok(rec.got.includes("cf_cmd_1"));
  assert.equal(await AP.readRecord("oldname"), null);
  // a replayed re-key changes nothing
  await AP.applyEvents([{ key: "pb:1:12", rekey: { old: "oldname", new: "_satchmo_" } }], []);
  assert.equal((await AP.readRecord("_satchmo_")).m.chat, "5051");
  // loginrekey.js (the site's own re-key of a relink) includes the counters
  const LR = require(path.join(repo, "loginrekey"));
  await LR.ensure();
  await LR.changed("u3", "newbie", null, "test");
  assert.equal(await AP.readRecord("newbie"), null);
  assert.equal((await AP.readRecord("u:u3")).m.chat, "1");
});

test("rollback: the exact store handed back (sha256 + totals), tables emptied, live off, idempotent; events refused; re-import", async () => {
  const before = await AP.exportObject();
  const r = await AP.rollbackToPepe({ key: "ar-test-1", actor: "test" });
  assert.equal(r.digest, crypto.createHash("sha256").update(r.state, "utf8").digest("hex"));
  assert.deepEqual(JSON.parse(r.state), before);
  assert.deepEqual(r.totals, AP.totalsOf(before));
  assert.equal(await AP.live(), false);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM ach_metrics"))[0].n, 0);
  const again = await AP.rollbackToPepe({ key: "ar-test-1" });
  assert.equal(again.already, true);
  assert.equal(again.state, r.state);
  await assert.rejects(AP.applyEvents([{ key: "pb:1:13", login: "foamy1111", m: { chat: ["101", "102"] } }], []), (e) => e.code === "E_NOT_LIVE");
  // back again with the handed-back state as Pepe's file
  const st = JSON.parse(r.state);
  const payload = JSON.stringify(st);
  const t = AP.totalsOf(st);
  const imp = await AP.importFromPepe({ key: "ac-test-3", payload, digest: crypto.createHash("sha256").update(payload, "utf8").digest("hex"), totals: t });
  assert.equal(imp.match, true);
  assert.deepEqual(await AP.exportObject(), before);
});

test("routes: bot token, the import parses its own body (index.js skip list), the admin switch refuses while live", async () => {
  const app = express();
  app.use((req, res, next) => (req.path === "/api/achievements/admin/import" || req.path === "/api/achievements/bot/events" ? next() : express.json()(req, res, next)));
  AP.register(app, { isBotToken: (t) => t === "bot", addUser: (req, res, next) => next() });
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, b) => fetchJson(base + p, b);
  try {
    assert.equal((await post("/api/achievements/bot/state", { password: "nope" })).status, 403);
    const s = await post("/api/achievements/bot/state", { password: "bot" });
    assert.equal(s.body.live, true);
    assert.equal(s.body.state.users.foamy1111.m.heist_won_pat, "9007199254741000");
    const e = await post("/api/achievements/bot/events", { password: "bot", events: [{ key: "pb:1:14", login: "foamy1111", m: { chat: ["101", "102"] } }] });
    assert.equal(e.body.ok, true);
    const idx = fs.readFileSync(path.join(repo, "index.js"), "utf8");
    assert.ok(idx.includes('req.path === "/api/achievements/admin/import"') && idx.includes('req.path === "/api/achievements/bot/events"'));
  } finally { srv.close(); }
});

function fetchJson(url, body) {
  const http = require("http");
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } },
      (res) => { let s = ""; res.on("data", (c) => { s += c; }); res.on("end", () => { let j = null; try { j = JSON.parse(s); } catch (e) { j = s; } resolve({ status: res.statusCode, body: j }); }); });
    req.on("error", reject);
    req.end(data);
  });
}
