// 1.99st: the site's ONE transaction primitive (dbUtils.tx) keeps the ledger whole when transactions roll back.
// Every module shares one SQLite connection. Before, any statement issued outside a transaction while another
// request's transaction was open became part of it, so if that transaction rolled back, the unrelated write went with
// it. ledger.post() did its INSERT INTO transactions and its UPDATE users as two autocommit statements, so a rollback
// landing between them could leave a balance change without its row (or the reverse). Now:
//   * ledger.post / reverse run in a transaction of their own when the caller isn't in one,
//   * outside writes wait at the gate while a transaction is open (and a transaction waits for writes already sent),
//   * a tx() inside a tx() is a savepoint, and every module's tx (mainstage._tx, boosts.tx, pools._tx,
//     staleaccounts.tx) delegates to dbUtils.tx.
// The invariant checked throughout: per user, SUM(transactions.points) == users.points_balance.
//   node --test test/tx-global.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "txglobal-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const D = require(path.join(repo, "dbUtils"));
const { runQuery, getQuery, tx, inTx } = D;
const ledger = require(path.join(repo, "ledger"));

const USERS = 8;
const SEED = 1000000;
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const balance = async (u) => (await getQuery("SELECT points_balance AS b FROM users WHERE userId = ?", [u]))[0].b;
async function drift() {
  return getQuery(`SELECT u.userId, u.points_balance - COALESCE(SUM(t.points), 0) AS d FROM users u
                   LEFT JOIN transactions t ON t.userId = u.userId GROUP BY u.userId HAVING d <> 0`);
}

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT,
                  points_balance INTEGER DEFAULT 0)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS transactions (transactionId TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL,
                  points INTEGER NOT NULL, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, counterparty TEXT, note TEXT)`);
  await runQuery("CREATE TABLE IF NOT EXISTS side_log (id INTEGER PRIMARY KEY AUTOINCREMENT, what TEXT)");
  for (let i = 0; i < USERS; i++) {
    await runQuery("INSERT INTO users (userId, username, password, points_balance) VALUES (?, ?, 'x', 0)", ["u" + i, "user" + i]);
    await ledger.postOrThrow("u" + i, SEED, "seed");
  }
});

test("a standalone ledger.post during a transaction that rolls back keeps both halves", async () => {
  const before = await balance("u0");
  let opened;
  const isOpen = new Promise((r) => { opened = r; });
  // a transaction that writes, stays open across several event-loop turns, then fails
  const doomed = tx(async () => {
    await ledger.postOrThrow("u1", -500, "doomed");
    opened();
    for (let i = 0; i < 20; i++) await tick();
    throw new Error("boom");
  }).catch((e) => e.message);
  await isOpen;
  // while it is open: standalone posts and an unrelated autocommit write
  const solo = await Promise.all([
    ledger.post("u0", 111, "solo credit"),
    ledger.post("u0", -11, "solo debit", { requireCover: true }),
    runQuery("INSERT INTO side_log (what) VALUES ('outside write')"),
  ]);
  assert.equal(await doomed, "boom");
  assert.ok(solo[0].ok && solo[1].ok, "both standalone posts went through");
  assert.equal(await balance("u0"), before + 100, "the standalone posts survived the rollback");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM transactions WHERE type LIKE 'solo%'"))[0].n, 2, "with their rows");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM side_log WHERE what = 'outside write'"))[0].n, 1, "the unrelated write survived");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM transactions WHERE type = 'doomed'"))[0].n, 0, "the failed transaction left nothing");
  assert.deepEqual(await drift(), []);
});

test("an outside write never lands inside an open transaction (the gate holds it until COMMIT / ROLLBACK)", async () => {
  const order = [];
  let release;
  const hold = new Promise((r) => { release = r; });
  let opened;
  const isOpen = new Promise((r) => { opened = r; });
  const t = tx(async () => {
    await runQuery("INSERT INTO side_log (what) VALUES ('in tx')");
    opened();
    await hold;
    order.push("tx-end");
    throw new Error("rolled back");
  }).catch(() => {});
  await isOpen;
  const w = runQuery("INSERT INTO side_log (what) VALUES ('gated')").then(() => order.push("outside-write"));
  await sleep(30);
  assert.deepEqual(order, [], "the outside write waits while the transaction is open");
  assert.equal(D.txStats().pending, 1);
  release();
  await Promise.all([t, w]);
  assert.deepEqual(order, ["tx-end", "outside-write"]);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM side_log WHERE what = 'gated'"))[0].n, 1, "and runs after it, outside it");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM side_log WHERE what = 'in tx'"))[0].n, 0);
  // reads are never held
  let r2;
  const hold2 = new Promise((r) => { r2 = r; });
  let o2;
  const open2 = new Promise((r) => { o2 = r; });
  const t2 = tx(async () => { o2(); await hold2; });
  await open2;
  const n = await getQuery("SELECT COUNT(*) AS n FROM users");
  assert.equal(n[0].n, USERS, "a SELECT answers while a transaction is open");
  r2();
  await t2;
});

test("a burst of interleaved transactions (some rolled back), nested savepoints and standalone posts: no drift", async () => {
  const want = {};                    // expected net movement per user from the calls that reported success
  const add = (u, n) => { want[u] = (want[u] || 0) + n; };
  const start = {};
  for (let i = 0; i < USERS; i++) start["u" + i] = await balance("u" + i);
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const jobs = [];
  for (let i = 0; i < 400; i++) {
    const u = "u" + rnd(USERS), v = "u" + rnd(USERS), amt = 1 + rnd(5000);
    switch (rnd(7)) {
      case 0:      // standalone credit
        jobs.push(ledger.post(u, amt, "solo").then((r) => { if (r.ok) add(r.userId, amt); }));
        break;
      case 1:      // standalone covered debit
        jobs.push(ledger.post(u, -amt, "solo debit", { requireCover: true }).then((r) => { if (r.ok) add(r.userId, -amt); }));
        break;
      case 2:      // a transfer that commits
        jobs.push(tx(async () => {
          await ledger.postOrThrow(u, -amt, "xfer out", { requireCover: true });
          await tick();
          await ledger.postOrThrow(v, amt, "xfer in");
        }).then(() => { add(u, -amt); add(v, amt); }, () => {}));
        break;
      case 3:      // a transfer that fails half way, after yielding to everything else
        jobs.push(tx(async () => {
          await ledger.postOrThrow(u, -amt, "doomed out");
          for (let k = 0; k < 3; k++) await tick();
          throw new Error("refused");
        }).catch(() => {}));
        break;
      case 4:      // nested: an inner step fails and is caught - only it is undone, the outer commits
        jobs.push(tx(async () => {
          await ledger.postOrThrow(u, amt, "outer");
          const inner = await tx(async () => {
            await ledger.postOrThrow(v, amt, "inner doomed");
            throw new Error("inner refused");
          }).catch((e) => e.message);
          assert.equal(inner, "inner refused");
          await tx(() => ledger.postOrThrow(v, 1, "inner kept"));
          return true;
        }).then(() => { add(u, amt); add(v, 1); }));
        break;
      case 5:      // post then reverse, standalone
        jobs.push((async () => {
          const r = await ledger.post(u, amt, "to reverse");
          await tick();
          await ledger.reverse(r, amt);
        })());
        break;
      default:     // an unrelated autocommit write
        jobs.push(runQuery("INSERT INTO side_log (what) VALUES ('burst')"));
    }
  }
  await Promise.all(jobs);
  assert.deepEqual(await drift(), [], "every balance equals its transaction sum");
  for (let i = 0; i < USERS; i++) {
    const u = "u" + i;
    assert.equal(await balance(u), start[u] + (want[u] || 0), `${u}: exactly the successful moves`);
  }
  const left = await getQuery("SELECT type, COUNT(*) AS n FROM transactions WHERE type IN ('doomed out', 'inner doomed', 'to reverse') GROUP BY type");
  assert.deepEqual(left, [], "rolled-back and reversed rows are gone");
  assert.equal(D.txStats().open, false);
  assert.equal(D.txStats().pending, 0);
});

test("ledger.post joins the caller's transaction (rolled back with it) and opens its own otherwise", async () => {
  assert.equal(inTx(), false);
  const before = await balance("u2");
  await tx(async () => {
    assert.equal(inTx(), true);
    await ledger.postOrThrow("u2", 999, "joined");
    throw new Error("undo");
  }).catch(() => {});
  assert.equal(await balance("u2"), before, "the post went with the caller's rollback");
  const n0 = D.txStats().tx;
  await ledger.post("u2", 5, "own");
  assert.equal(D.txStats().tx, n0 + 1, "a standalone post is one transaction");
  assert.equal(await balance("u2"), before + 5);
  // a refused post (missing account / no cover) writes nothing either way
  assert.equal((await ledger.post("nobody", 5, "ghost")).ok, false);
  assert.equal((await ledger.post("u2", -1e12, "too much", { requireCover: true })).ok, false);
  assert.deepEqual(await drift(), []);
});

test("work that outlives its transaction is not treated as inside it", async () => {
  let late;
  await tx(async () => {
    late = (async () => { await sleep(20); return inTx(); })();     // fire-and-forget, finishes after COMMIT
  });
  assert.equal(await late, false);
  // and its write is an ordinary outside write (gated, autocommit) - another transaction rolling back can't take it
  let leak;
  await tx(async () => { leak = (async () => { await sleep(20); return runQuery("INSERT INTO side_log (what) VALUES ('late')"); })(); });
  let o;
  const opened = new Promise((r) => { o = r; });
  const t = tx(async () => { o(); await sleep(60); throw new Error("x"); }).catch(() => {});
  await opened;
  await Promise.all([leak, t]);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM side_log WHERE what = 'late'"))[0].n, 1);
});

test("every module's transaction helper is the shared one (nesting is a savepoint, not a deadlock or a second BEGIN)", async () => {
  const helpers = {
    "mainstage._tx": require(path.join(repo, "mainstage"))._tx,
    "boosts.tx": require(path.join(repo, "boosts")).tx,
    "pools._tx": require(path.join(repo, "pools"))._tx,
    "staleaccounts.tx": require(path.join(repo, "staleaccounts")).tx,
  };
  for (const [name, h] of Object.entries(helpers)) {
    const n0 = D.txStats().nested;
    const out = await Promise.race([
      tx(() => h(async () => { assert.equal(inTx(), true); return name; })),
      sleep(3000).then(() => "timeout"),
    ]);
    assert.equal(out, name, `${name} inside dbUtils.tx`);
    assert.equal(D.txStats().nested, n0 + 1, `${name} ran as a savepoint`);
    const before = await balance("u3");
    await h(async () => { await ledger.postOrThrow("u3", 7, "via " + name); throw new Error("no"); }).catch(() => {});
    assert.equal(await balance("u3"), before, `${name} rolls back its own work`);
  }
  assert.deepEqual(await drift(), []);
});

test("no raw BEGIN / COMMIT / ROLLBACK on the shared connection outside dbUtils.js", () => {
  const skip = new Set(["node_modules", "test", "public", ".git"]);
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) files.push(p);
    }
  })(repo);
  const raw = /\b(runQuery|getQuery)\(\s*["'`]\s*(BEGIN|COMMIT|ROLLBACK|END\b|SAVEPOINT|RELEASE)/i;
  const bad = [];
  for (const f of files) {
    if (path.basename(f) === "dbUtils.js" && path.dirname(f) === repo) continue;
    fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => { if (raw.test(line)) bad.push(`${path.relative(repo, f)}:${i + 1}`); });
  }
  assert.deepEqual(bad, [], "use dbUtils.tx()");
});

test.after(() => setTimeout(() => process.exit(0), 50));
