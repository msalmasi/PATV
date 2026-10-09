// 1.99gi: every account merge holds the per-user level lock (user.controller withLevelLocks) of BOTH accounts,
// taken in sorted order, for its whole transaction + the afterMerge settle. A game XP award for either account
// waits for the merge instead of interleaving with its xp/level write; an award for the merged-away account
// that arrives after it was deleted follows ledger account_merges to the survivor.
//   NODE_PATH=<PATV>/node_modules node --test test/merge-lock.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const sqlite3 = require("sqlite3");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "merge-lock-"));
process.chdir(dir);                                      // dbUtils opens ./myapp.db
process.env.TWITCH_BOT_TOKEN = "bot-token";
const repo = path.join(__dirname, "..");
const { scanSource, schemaSql } = require(path.join(__dirname, "fixtures", "schemascan"));

const built = (async () => {
  const db = new sqlite3.Database(path.join(dir, "myapp.db"));
  const run = (q) => new Promise((res, rej) => db.exec(q, (e) => (e ? rej(e) : res())));
  await run(schemaSql());
  for (const [, v] of scanSource(repo)) for (const sql of v.creates) await run(sql).catch(() => {});
  await new Promise((r) => db.close(r));
})();

let uc, stale, PM, runQuery, getQuery;
const ready = built.then(async () => {
  ({ runQuery, getQuery } = require(path.join(repo, "dbUtils")));
  const funding = require(path.join(repo, "funding"));
  funding.fundPayout = async (userId, amount) => {
    await runQuery("UPDATE users SET points_balance = points_balance + ? WHERE userId = ?", [amount, userId]);
    return true;
  };
  uc = require(path.join(repo, "user.controller"));
  stale = require(path.join(repo, "staleaccounts"));
  PM = require(path.join(repo, "providermerge"));
  await require(path.join(repo, "ledger")).ensure();
});

async function user(id, o = {}) {
  await runQuery(`INSERT INTO users (userId, username, password, points_balance, xp, level, camfrogUsername, created_at)
                  VALUES (?, ?, 'x', 0, ?, ?, ?, '2026-01-01 00:00:00')`,
                 [id, o.username || id, o.xp || 0, o.level || 0, o.cf || null]);
}
const total = async (id) => {
  const r = (await getQuery("SELECT xp, level FROM users WHERE userId = ?", [id]))[0];
  return r ? uc.totalXpOf(Number(r.level) || 0, Number(r.xp) || 0) : null;
};
const exists = async (id) => (await getQuery("SELECT 1 FROM users WHERE userId = ?", [id])).length > 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what}: no progress in ${ms} ms (deadlock?)`); })]);

/** Fire `n` awards of `each` XP at `ids` (round robin), staggered across the merge. -> the XP fired */
function awardStorm(ids, n, each) {
  const ps = [];
  for (let i = 0; i < n; i++) {
    ps.push(sleep(i % 7).then(() => uc.updateLevel(ids[i % ids.length], each)));
  }
  return { done: Promise.all(ps), xp: n * each };
}

async function camfrogVerify(me, cf, code) {
  await runQuery("INSERT INTO pending_camfrog_links (code, userId, camfrogUsername, expires_at) VALUES (?, ?, ?, ?)",
                 [code, me, cf, new Date(Date.now() + 600000).toISOString()]);
  let out = null;
  const res = { status() { return this; }, json(d) { out = d; return this; } };
  await uc.verifyCamfrogLink({ body: { code, camfrogUsername: cf, password: "bot-token" } }, res);
  return out;
}

test("withLevelLocks: re-entrant, both ids held, sorted - opposite orders never deadlock", async () => {
  await ready;
  await user("lk-a", { xp: 0 }); await user("lk-b", { xp: 0 });
  // re-entrant: updateLevel inside a held lock (afterMerge does this) doesn't queue behind itself
  await withTimeout(uc.withLevelLocks(["lk-b", "lk-a"], async () => {
    assert.deepEqual(uc.heldLevelLocks().sort(), ["lk-a", "lk-b"]);
    await uc.updateLevel("lk-a", 10);
    await uc.updateLevel("lk-b", 10);
  }), 5000, "re-entrant");
  assert.deepEqual(uc.heldLevelLocks(), [], "released afterwards");
  // opposite orders, each holding its first lock while the other wants it
  const order = [];
  const one = uc.withLevelLocks(["lk-a", "lk-b"], async () => { order.push("ab+"); await sleep(20); order.push("ab-"); });
  const two = uc.withLevelLocks(["lk-b", "lk-a"], async () => { order.push("ba+"); await sleep(20); order.push("ba-"); });
  const three = uc.updateLevel("lk-b", 5);
  await withTimeout(Promise.all([one, two, three]), 5000, "opposite order");
  assert.deepEqual(order, ["ab+", "ab-", "ba+", "ba-"], "never both inside at once");
  assert.equal(await total("lk-a"), 10);
  assert.equal(await total("lk-b"), 15);
});

test("Camfrog !verify merge: XP awards to both accounts DURING the merge - the total is exact", async () => {
  await ready;
  await user("cv-me", { username: "carol", level: 3, xp: 500 });
  await user("cv-auto", { username: "CFcarol", level: 1, xp: 200, cf: "carolcf" });
  const before = (await total("cv-me")) + (await total("cv-auto"));
  const storm = awardStorm(["cv-me", "cv-auto"], 40, 137);
  const out = await withTimeout(camfrogVerify("cv-me", "carolcf", "LOCK01"), 10000, "verify");
  await withTimeout(storm.done, 10000, "awards");
  assert.equal(out && out.merged, true, JSON.stringify(out));
  assert.equal(await exists("cv-auto"), false);
  assert.equal(await total("cv-me"), before + storm.xp, "no XP lost or counted twice");
});

test("duplicate merge (mergeDuplicate): awards during the merge, then an award to the gone source lands on the survivor", async () => {
  await ready;
  await user("dm-p", { level: 5, xp: 1234 });
  await user("dm-d", { level: 2, xp: 777 });
  const before = (await total("dm-p")) + (await total("dm-d"));
  const storm = awardStorm(["dm-d", "dm-p"], 40, 251);
  const r = await withTimeout(stale.mergeDuplicate("dm-d", "dm-p"), 10000, "mergeDuplicate");
  await withTimeout(storm.done, 10000, "awards");
  assert.ok(r, "merged");
  assert.equal(await exists("dm-d"), false);
  assert.equal(await total("dm-p"), before + storm.xp, "no XP lost or counted twice");
  // a late award (queued for the source, arriving after it was deleted) follows account_merges
  const late = await uc.updateLevel("dm-d", 999);
  assert.ok(late, "not dropped");
  assert.equal(await total("dm-p"), before + storm.xp + 999);
});

test("provider merge (Twitch): awards during the merge are kept, the source's go to the survivor", async () => {
  await ready;
  await user("pm-from", { level: 4, xp: 300 });
  await user("pm-to", { level: 1, xp: 50 });
  await runQuery("UPDATE users SET twitchId = 'T-LOCK', twitchDisplayname = 'tw' WHERE userId = 'pm-from'");
  const before = (await total("pm-from")) + (await total("pm-to"));
  const L = { label: "Twitch", idCol: "twitchId", nameCol: "twitchDisplayname", otherIdCol: "discordId", otherNameCol: "discordUsername" };
  const storm = awardStorm(["pm-from", "pm-to"], 30, 173);
  const r = await withTimeout(PM.mergeProviderAccount({ provider: "twitch", L, fromId: "pm-from", toId: "pm-to", linkId: "T-LOCK", linkName: "tw" }),
                              10000, "provider merge");
  await withTimeout(storm.done, 10000, "awards");
  assert.equal(r && r.ok, true, JSON.stringify(r && { ok: r.ok, code: r.code, holds: r.holds }));
  assert.equal(await exists("pm-from"), false);
  assert.equal(await total("pm-to"), before + storm.xp);
});

test("two merges sharing an account, named in opposite order, run concurrently: no deadlock, XP counted once", async () => {
  await ready;
  await user("op-x", { level: 2, xp: 100 });
  await user("op-y", { level: 3, xp: 200 });
  await user("op-z", { level: 1, xp: 300 });
  const before = (await total("op-x")) + (await total("op-y")) + (await total("op-z"));
  const storm = awardStorm(["op-x", "op-y", "op-z"], 30, 89);
  const rs = await withTimeout(Promise.all([
    stale.mergeDuplicate("op-x", "op-y"),          // x into y
    stale.mergeDuplicate("op-y", "op-x"),          // y into x (the opposite order)
    stale.mergeDuplicate("op-z", "op-y"),          // z into y
  ]), 15000, "concurrent merges");
  await withTimeout(storm.done, 10000, "awards");
  const live = [];
  for (const id of ["op-x", "op-y", "op-z"]) if (await exists(id)) live.push(id);
  assert.ok(rs.filter(Boolean).length >= 1, "at least one merge ran");
  let sum = 0;
  for (const id of live) sum += await total(id);
  assert.equal(sum, before + storm.xp, `no XP lost or counted twice (live: ${live.join(", ")})`);
});
