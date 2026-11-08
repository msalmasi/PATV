// verifyfix (owner, 2026-11-08 ~00:30Z: "connecting camfrog gives error message even though it worked"). Prod 2026-11-08
// 00:24:12Z: Pepe's POST /api/users/camfrog/verify gave up after 10 s (nginx 499 10.007) and he said "couldn't reach the
// website", but the site finished the link 32 s after the request (account_archive / account_merge_log 00:24:44.9Z,
// login_changes #45 + #46 00:24:45Z) - for a merge that moved 6 rows. His retry 30 s later got "Invalid or expired" (the code
// was spent). The merge ran OUTSIDE any transaction, so each of its few hundred writes (accountMerge.moveUserRows: every user
// column of all 584 tables) waited at dbUtils' write gate for whatever other transaction was open, one after another
// (reproduced on the real schema: 0.4 s idle, ~12 s with other transactions back to back). Now:
//   * the request answers at once with the true outcome: the link (login on the account, code spent, the merge job) is
//     committed in ONE transaction first; the auto account's merge runs in one transaction of its own (atomic) and the
//     answer waits for it only a moment (CF_LINK_WAIT_MS)
//   * a merge that fails is retried by the job tick - nothing half-moved, nothing moved twice
//   * a repeat !verify of the code that login just used (same account, 15 minutes) answers 200 "already linked" with the
//     same payload Pepe reads (frida-bot.py handle_verify: success, websiteUsername, unlinkedFrom, merged, addedBalance, addedXp)
//   * the login re-key runs once per change (it ran twice: two login_changes rows per link)
//   TZ=UTC node --test test/cfverify-fast.test.js      (uses a temp DB with the full schema)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const sqlite3 = require("sqlite3");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfverify-fast-"));
process.chdir(dir);                                      // dbUtils opens ./myapp.db
process.env.TWITCH_BOT_TOKEN = "bot-token";
delete process.env.STAGING;
const repo = path.join(__dirname, "..");
const { scanSource, schemaSql } = require(path.join(__dirname, "fixtures", "schemascan"));

const built = (async () => {
  const db = new sqlite3.Database(path.join(dir, "myapp.db"));
  const run = (q) => new Promise((res, rej) => db.exec(q, (e) => (e ? rej(e) : res())));
  await run(schemaSql());
  for (const [, v] of scanSource(repo)) for (const sql of v.creates) await run(sql).catch(() => {});
  await new Promise((r) => db.close(r));
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// the slow / failing part, stubbed: the row move of the merge (installed BEFORE user.controller is loaded - it destructures it)
const slow = { ms: 0, failNext: false, calls: 0 };
let uc, D, runQuery, getQuery;
const ready = built.then(async () => {
  D = require(path.join(repo, "dbUtils"));
  ({ runQuery, getQuery } = D);
  const funding = require(path.join(repo, "funding"));
  funding.fundPayout = async (userId, amount) => {
    await runQuery("UPDATE users SET points_balance = points_balance + ? WHERE userId = ?", [amount, userId]);
    return true;
  };
  const AM = require(path.join(repo, "accountMerge"));
  const orig = AM.moveUserRows;
  AM.moveUserRows = async (...a) => {
    slow.calls++;
    if (slow.ms) await sleep(slow.ms);
    if (slow.failNext) { slow.failNext = false; throw new Error("boom (test: the row move failed)"); }
    return orig(...a);
  };
  uc = require(path.join(repo, "user.controller"));
  await require(path.join(repo, "ledger")).ensure();
});

async function user(id, o = {}) {
  await runQuery(`INSERT INTO users (userId, username, password, points_balance, xp, level, camfrogUsername, created_at)
                  VALUES (?, ?, 'x', ?, ?, ?, ?, '2026-01-01 00:00:00')`,
                 [id, o.username || id, o.balance || 0, o.xp || 0, o.level || 0, o.cf || null]);
}
const row = async (id) => (await getQuery("SELECT points_balance, xp, level, camfrogUsername FROM users WHERE userId = ?", [id]))[0];
const total = async (id) => { const r = await row(id); return r ? uc.totalXpOf(Number(r.level) || 0, Number(r.xp) || 0) : null; };
const exists = async (id) => !!(await row(id));
async function pending(me, cf, code) {
  await runQuery("INSERT INTO pending_camfrog_links (code, userId, camfrogUsername, expires_at) VALUES (?, ?, ?, ?)",
                 [code, me, cf, new Date(Date.now() + 600000).toISOString()]);
}
/** Pepe's call (frida-bot.py handle_verify): POST {code, camfrogUsername, password} -> {status, out, ms} */
async function verify(code, cf) {
  let out = null, status = 200;
  const res = { status(c) { status = c; return this; }, json(d) { out = d; return this; } };
  const t0 = Date.now();
  await uc.verifyCamfrogLink({ body: { code, camfrogUsername: cf, password: "bot-token" } }, res);
  return { status, out, ms: Date.now() - t0 };
}
const PAYLOAD = ["success", "websiteUsername", "camfrogUsername", "merged", "addedBalance", "addedXp", "unlinkedFrom"];

test("!verify answers well under 2 s while the merge is slow: the link is committed first, the merge then lands exactly once", async () => {
  await ready;
  await user("fa-me", { username: "fastreal", balance: 100, level: 3, xp: 500 });
  await user("fa-auto", { username: "CFfast", balance: 700, level: 1, xp: 200, cf: "fastcf" });
  const before = (await total("fa-me")) + (await total("fa-auto"));
  await pending("fa-me", "fastcf", "FAST01");
  slow.ms = 2500;
  let r;
  try { r = await verify("FAST01", "fastcf"); } finally { slow.ms = 0; }
  assert.equal(r.status, 200, JSON.stringify(r.out));
  assert.ok(r.ms < 2000, `answered in ${r.ms} ms - Pepe waits 10 s and the target is well under 2 s`);
  for (const k of PAYLOAD) assert.ok(k in r.out, `the payload Pepe reads has ${k}: ${JSON.stringify(r.out)}`);
  assert.equal(r.out.success, true);
  assert.equal(r.out.websiteUsername, "fastreal");
  assert.equal(r.out.camfrogUsername, "fastcf");
  assert.equal(r.out.merged, true);
  assert.equal(r.out.addedBalance, 700, "the auto account's PAT");
  assert.equal(r.out.addedXp, 1200, "the auto account's cumulative XP");
  assert.equal(r.out.unlinkedFrom, null);
  assert.equal((await row("fa-me")).camfrogUsername, "fastcf", "the link itself is committed when the answer goes out");
  await uc.settleCamfrogLinks();
  assert.equal(await exists("fa-auto"), false, "the auto account was merged away");
  assert.equal(Number((await row("fa-me")).points_balance), 800, "its PAT moved once");
  assert.equal(await total("fa-me"), before, "its XP moved once");
});

test("a busy site (other transactions back to back, as on 11-08): the answer still comes in well under 2 s", async () => {
  await ready;
  await user("bz-me", { username: "busyreal", balance: 10 });
  await user("bz-auto", { username: "CFbusy", balance: 90, cf: "busycf" });
  await pending("bz-me", "busycf", "BUSY01");
  let stop = false, bg = 0;
  const loop = (async () => {
    while (!stop) {
      await D.tx(async () => { await runQuery("UPDATE users SET liked = liked WHERE userId = 'nobody-at-all'"); await sleep(30); });
      bg++;
    }
  })();
  await sleep(60);
  let r;
  try { r = await verify("BUSY01", "busycf"); } finally { stop = true; await loop; }
  assert.equal(r.status, 200, JSON.stringify(r.out));
  assert.equal(r.out.success, true);
  assert.ok(r.ms < 2000, `answered in ${r.ms} ms with ${bg} other transactions meanwhile (the old path: ~12 s here, 32 s on prod)`);
  await uc.settleCamfrogLinks();
  assert.equal(await exists("bz-auto"), false);
  assert.equal(Number((await row("bz-me")).points_balance), 100);
});

test("the merge fails: nothing half-done (one transaction), the answer is still the link's, the job tick retries - PAT and XP move once", async () => {
  await ready;
  await user("fl-me", { username: "failreal", balance: 5, level: 2, xp: 10 });
  await user("fl-auto", { username: "CFfail", balance: 333, level: 1, xp: 7, cf: "failcf" });
  const before = (await total("fl-me")) + (await total("fl-auto"));
  await pending("fl-me", "failcf", "FAIL01");
  slow.failNext = true;
  const r = await verify("FAIL01", "failcf");
  assert.equal(r.status, 200, `the link went through - not a 500: ${JSON.stringify(r.out)}`);
  assert.equal(r.out.success, true);
  assert.equal(r.out.merged, true, "the merge is on its way (the job)");
  await uc.settleCamfrogLinks();
  assert.equal((await row("fl-me")).camfrogUsername, "failcf", "linked");
  assert.equal(await exists("fl-auto"), true, "the failed merge left the auto account whole");
  assert.equal(Number((await row("fl-auto")).points_balance), 333, "its PAT is still on it");
  assert.equal(Number((await row("fl-me")).points_balance), 5, "and not ALSO on the real account (the old merge added it, then failed)");
  const job = (await getQuery("SELECT state, tries, error FROM camfrog_link_jobs WHERE code = 'FAIL01'"))[0];
  assert.ok(job && job.state === "merge" && job.tries >= 1 && /boom/.test(job.error || ""), JSON.stringify(job));
  // the tick (index.js starts it) picks it up again once it is due
  await uc.runCamfrogLinkJobs({ now: Date.now() + 3600e3 });
  await uc.settleCamfrogLinks();
  assert.equal(await exists("fl-auto"), false, "merged on the retry");
  assert.equal(Number((await row("fl-me")).points_balance), 338, "PAT moved exactly once");
  assert.equal(await total("fl-me"), before, "XP moved exactly once");
  assert.equal((await getQuery("SELECT state FROM camfrog_link_jobs WHERE code = 'FAIL01'"))[0].state, "done");
  await uc.runCamfrogLinkJobs({ now: Date.now() + 7200e3 });
  await uc.settleCamfrogLinks();
  assert.equal(Number((await row("fl-me")).points_balance), 338, "a done job never runs again");
});

test("a repeat !verify of the code that login just used: 200 'already linked', the same payload; anyone else, later, or after an unlink: 404", async () => {
  await ready;
  await user("rp-me", { username: "replayreal", balance: 1 });
  await user("rp-auto", { username: "CFreplay", balance: 49, level: 1, xp: 0, cf: "replaycf" });
  await pending("rp-me", "replaycf", "RPT001");
  const first = await verify("RPT001", "replaycf");
  assert.equal(first.status, 200);
  await uc.settleCamfrogLinks();
  const again = await verify("RPT001", "ReplayCF");           // Pepe passes the chat author as typed
  assert.equal(again.status, 200, `Pepe's retry (his first answer timed out) gets the outcome: ${JSON.stringify(again.out)}`);
  assert.equal(again.out.success, true);
  assert.equal(again.out.already, true);
  for (const k of PAYLOAD) assert.deepEqual(again.out[k], first.out[k], `${k} as in the first answer`);
  assert.ok(again.ms < 1000, `${again.ms} ms`);
  assert.equal(Number((await row("rp-me")).points_balance), 50, "nothing merged twice");
  const other = await verify("RPT001", "someoneelse");
  assert.equal(other.status, 404, "another login with that code learns nothing");
  assert.equal(other.out.error, "Invalid or expired verification code");
  await runQuery("UPDATE camfrog_link_jobs SET created = created - 16 * 60000 WHERE code = 'RPT001'");
  const late = await verify("RPT001", "replaycf");
  assert.equal(late.status, 404, "after 15 minutes it is just a spent code");
  // a fresh link, then the login is unlinked: the replay no longer says "linked"
  await user("rp-me2", { username: "replay2" });
  await pending("rp-me2", "replay2cf", "RPT002");
  assert.equal((await verify("RPT002", "replay2cf")).status, 200);
  await uc.settleCamfrogLinks();
  await runQuery("UPDATE users SET camfrogUsername = NULL WHERE userId = 'rp-me2'");
  assert.equal((await verify("RPT002", "replay2cf")).status, 404, "unlinked since: not 'already linked'");
  assert.equal((await verify("NOPE99", "replaycf")).status, 404, "an unknown code: 404 as before");
});

test("two !verify of one code at once: one link, one merge, both answered success", async () => {
  await ready;
  await user("tw-me", { username: "twicereal", balance: 0, level: 2, xp: 0 });
  await user("tw-auto", { username: "CFtwice", balance: 1000, level: 1, xp: 100, cf: "twicecf" });
  const before = (await total("tw-me")) + (await total("tw-auto"));
  await pending("tw-me", "twicecf", "TWC001");
  const [a, b] = await Promise.all([verify("TWC001", "twicecf"), verify("TWC001", "twicecf")]);
  assert.equal(a.status, 200, JSON.stringify(a.out));
  assert.equal(b.status, 200, JSON.stringify(b.out));
  assert.equal(a.out.success && b.out.success, true);
  await uc.settleCamfrogLinks();
  assert.equal(await exists("tw-auto"), false);
  assert.equal(Number((await row("tw-me")).points_balance), 1000, "merged once");
  assert.equal(await total("tw-me"), before);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM camfrog_link_jobs WHERE code = 'TWC001'"))[0].n, 1, "one link job");
});

test("the login re-key runs once per change (prod: login_changes #45 and #46 for one link)", async () => {
  await ready;
  // a login another real account holds ("camfrog:taken") moving to this one ("camfrog:relink")
  await user("rk-old", { username: "rkold", cf: "rekeycf" });
  await user("rk-new", { username: "rknew" });
  await pending("rk-new", "rekeycf", "RKY001");
  const r = await verify("RKY001", "rekeycf");
  assert.equal(r.status, 200, JSON.stringify(r.out));
  assert.equal(r.out.unlinkedFrom, "rkold");
  await uc.settleCamfrogLinks();
  const ch = await getQuery("SELECT userId, old_key, new_key, via FROM login_changes WHERE userId IN ('rk-old', 'rk-new') ORDER BY id");
  assert.deepEqual(ch.map((c) => [c.userId, c.old_key, c.new_key, c.via]),
                   [["rk-old", "rekeycf", "u:rk-old", "camfrog:taken"], ["rk-new", "u:rk-new", "rekeycf", "camfrog:relink"]],
                   "one row per change, the old holder's first");
  assert.equal((await row("rk-old")).camfrogUsername, null);
  assert.equal((await row("rk-new")).camfrogUsername, "rekeycf");
});

test("completeCamfrogLink (the !signup claim page) still returns after the whole merge", async () => {
  await ready;
  await user("cl-me", { username: "claimreal", balance: 2 });
  await user("cl-auto", { username: "CFclaim", balance: 40, level: 1, xp: 5, cf: "claimcf" });
  const r = await uc.completeCamfrogLink("cl-me", "claimcf");
  assert.equal(r.merged, true);
  assert.equal(r.addedBalance, 40);
  assert.equal(await exists("cl-auto"), false, "merged by the time it returns");
  assert.equal(Number((await row("cl-me")).points_balance), 42);
  assert.equal((await row("cl-me")).camfrogUsername, "claimcf");
});
