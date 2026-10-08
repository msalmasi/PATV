// Offline tests for 1.99fb: SQLite WAL mode + busy_timeout on every connection (sqlitecfg.js, dbUtils.js), the
// SQLITE_BUSY retry around runQuery / getQuery, the WAL-safe backup (sqlitecfg.backupTo, backup-db.js) and the
// checkpoint that keeps myapp.db-wal small.
//   NODE_PATH=<repo>/node_modules node --test test/sqlite-wal.test.js      (temp DBs only)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite-wal-test-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
const sqlite3 = require("sqlite3");
const cfg = require(path.join(repo, "sqlitecfg"));

const open = (file, mode) => new Promise((resolve, reject) => {
  const d = mode == null ? new sqlite3.Database(file, (e) => (e ? reject(e) : resolve(d))) : new sqlite3.Database(file, mode, (e) => (e ? reject(e) : resolve(d)));
});
const q = (db, method, sql, params = []) => new Promise((resolve, reject) =>
  db[method](sql, params, function (e, r) { if (e) reject(e); else resolve(method === "run" ? this : r); }));
const close = (db) => new Promise((r) => db.close(() => r()));
const size = (f) => { try { return fs.statSync(f).size; } catch (e) { return -1; } };

test("tune(): WAL (persistent), busy_timeout 5000, synchronous NORMAL", async () => {
  const f = path.join(tmp, "tune.db");
  const db = await open(f);
  const m = await cfg.tune(db, { label: "t" });
  assert.equal(m.journal_mode, "wal");
  assert.equal(m.busy_timeout, 5000);
  assert.equal(m.synchronous, 1, "1 = NORMAL");
  assert.equal((await q(db, "get", "PRAGMA journal_mode")).journal_mode, "wal");
  await close(db);
  // WAL is stored in the file: a plain new connection (no tune) is in WAL too
  const again = await open(f);
  assert.equal((await q(again, "get", "PRAGMA journal_mode")).journal_mode, "wal", "persistent on the file");
  assert.notEqual((await q(again, "get", "PRAGMA busy_timeout")).timeout, 5000, "busy_timeout is per connection (node-sqlite3 default: 1000)");
  await close(again);
  // wal:false leaves the mode alone but still sets the timeout
  const g = path.join(tmp, "nowal.db");
  const d2 = await open(g);
  const m2 = await cfg.tune(d2, { label: "t2", wal: false });
  assert.equal(m2.journal_mode, "delete"); assert.equal(m2.busy_timeout, 5000);
  await close(d2);
});

test("dbUtils' shared connection comes up in WAL with the timeout", async () => {
  const dbu = require(path.join(repo, "dbUtils"));
  const m = await dbu.ready;
  assert.equal(m.journal_mode, "wal"); assert.equal(m.busy_timeout, 5000); assert.equal(m.synchronous, 1);
  await dbu.runQuery("CREATE TABLE t (x INTEGER)");
  await dbu.runQuery("INSERT INTO t (x) VALUES (1)");
  assert.equal((await dbu.getQuery("SELECT COUNT(*) AS c FROM t"))[0].c, 1);
  assert.equal(typeof dbu.startCheckpoints, "function");
});

test("withBusyRetry: retries SQLITE_BUSY only, a few times, then gives up", async () => {
  const busy = () => Object.assign(new Error("SQLITE_BUSY: database is locked"), { code: "SQLITE_BUSY", errno: 5 });
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  let n = 0;
  assert.equal(await cfg.withBusyRetry(async () => { if (++n < 3) throw busy(); return "ok"; }, { sleep }), "ok");
  assert.equal(n, 3); assert.equal(sleeps.length, 2);
  assert.ok(sleeps.every((ms) => ms >= 60 && ms < 400), "jittered pauses: " + sleeps);
  n = 0;
  await assert.rejects(cfg.withBusyRetry(async () => { n++; throw busy(); }, { sleep }), /SQLITE_BUSY/);
  assert.equal(n, 3, "3 tries in all");
  n = 0;
  await assert.rejects(cfg.withBusyRetry(async () => { n++; throw Object.assign(new Error("SQLITE_CONSTRAINT: UNIQUE"), { code: "SQLITE_CONSTRAINT" }); }, { sleep }), /CONSTRAINT/);
  assert.equal(n, 1, "other errors are not retried");
  assert.ok(cfg.isBusy({ message: "SQLITE_BUSY: database is locked" }) && !cfg.isBusy(null) && !cfg.isBusy(new Error("nope")));
});

test("withBusyRetry against a real lock: a writer that outlasts the busy timeout gets through on a retry", async () => {
  const f = path.join(tmp, "lock.db");
  const a = await open(f), b = await open(f);
  await cfg.tune(a, { label: "a" });
  await q(a, "run", "CREATE TABLE t (x INTEGER)");
  b.configure("busyTimeout", 30);                                    // a short wait so the lock outlasts it
  await q(a, "run", "BEGIN IMMEDIATE");
  await q(a, "run", "INSERT INTO t (x) VALUES (1)");
  setTimeout(() => q(a, "run", "COMMIT"), 150);
  let tries = 0;
  await cfg.withBusyRetry(() => { tries++; return q(b, "run", "INSERT INTO t (x) VALUES (2)"); }, { tries: 10, baseMs: 40, jitterMs: 20 });
  assert.ok(tries > 1, "it was busy at first");
  assert.equal((await q(b, "get", "SELECT COUNT(*) AS c FROM t")).c, 2);
  await close(a); await close(b);
});

test("backupTo: a consistent, self-contained copy that includes commits still in the -wal (a file copy misses them)", async () => {
  const f = path.join(tmp, "live.db");
  const db = await open(f);
  await cfg.tune(db, { label: "live" });
  await q(db, "run", "PRAGMA wal_autocheckpoint = 0");               // keep every commit in the WAL
  await q(db, "run", "CREATE TABLE spins (id INTEGER PRIMARY KEY, v TEXT)");
  for (let i = 0; i < 200; i++) await q(db, "run", "INSERT INTO spins (v) VALUES (?)", ["spin" + i]);
  assert.ok(size(f + "-wal") > 0, "the commits are in myapp.db-wal");
  // the trap: copying the main file alone loses them
  fs.copyFileSync(f, path.join(tmp, "naive.db"));
  const naive = await open(path.join(tmp, "naive.db"));
  const naiveRows = await q(naive, "get", "SELECT COUNT(*) AS c FROM sqlite_master WHERE name = 'spins'").catch(() => ({ c: 0 }));
  assert.equal(naiveRows.c, 0, "a plain copy of the main file doesn't even have the table");
  await close(naive);
  // an uncommitted write on another connection must not leak into the backup, nor block it
  const other = await open(f);
  other.configure("busyTimeout", 5000);
  await q(other, "run", "BEGIN IMMEDIATE");
  await q(other, "run", "INSERT INTO spins (v) VALUES ('uncommitted')");
  const out = path.join(tmp, "backups", "copy.db");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = await cfg.backupTo(db, out);
  await q(other, "run", "ROLLBACK"); await close(other);
  assert.equal(r.integrity, "ok"); assert.ok(r.pages > 1);
  assert.ok(!fs.existsSync(out + ".part"), "renamed into place");
  const copy = await open(out, sqlite3.OPEN_READONLY);
  assert.equal((await q(copy, "get", "SELECT COUNT(*) AS c FROM spins")).c, 200, "every committed row, none uncommitted");
  assert.equal((await q(copy, "get", "PRAGMA journal_mode")).journal_mode, "delete", "one self-contained file");
  await close(copy);
  assert.ok(!fs.existsSync(out + "-wal") && !fs.existsSync(out + "-shm"));
  // checkpoint(TRUNCATE) folds the WAL into the main file and empties it
  const cp = await cfg.checkpoint(db);
  assert.equal(cp.busy, 0);
  assert.equal(size(f + "-wal"), 0, "WAL truncated");
  await close(db);
});

test("backupTo refuses to leave a broken file behind", async () => {
  const f = path.join(tmp, "src2.db");
  const db = await open(f);
  await cfg.tune(db, { label: "src2" });
  await q(db, "run", "CREATE TABLE t (x)");
  const out = path.join(tmp, "nodir", "deeper", "x.db");           // the folder doesn't exist
  await assert.rejects(cfg.backupTo(db, out));
  assert.ok(!fs.existsSync(out) && !fs.existsSync(out + ".part"));
  await close(db);
});

test("backup-db.js: gzipped, verified copy with the WAL data; the month's old file is only replaced on success", async () => {
  const f = path.join(tmp, "site.db");
  const db = await open(f);
  await cfg.tune(db, { label: "site" });
  await q(db, "run", "PRAGMA wal_autocheckpoint = 0");
  await q(db, "run", "CREATE TABLE users (userId TEXT PRIMARY KEY, points_balance INTEGER)");
  for (let i = 0; i < 50; i++) await q(db, "run", "INSERT INTO users VALUES (?, ?)", ["u" + i, i * 100]);
  const dir = path.join(tmp, "nightly");
  const { run } = require(path.join(repo, "backup-db"));
  const r = await run({ dbPath: f, dir, name: "database_backup_2026-10.db", log: { error() {}, log() {} } });
  assert.equal(r.file, path.join(dir, "database_backup_2026-10.db.gz"));
  assert.ok(!fs.existsSync(path.join(dir, "database_backup_2026-10.db")), "only the .gz is kept");
  assert.equal(r.checkpoint && r.checkpoint.busy, 0, "checkpointed afterwards");
  const restored = path.join(tmp, "restored.db");
  fs.writeFileSync(restored, zlib.gunzipSync(fs.readFileSync(r.file)));
  const c = await open(restored, sqlite3.OPEN_READONLY);
  assert.equal((await q(c, "get", "PRAGMA integrity_check")).integrity_check, "ok");
  assert.equal((await q(c, "get", "SELECT COUNT(*) AS n, SUM(points_balance) AS s FROM users")).n, 50);
  await close(c);
  // a failed run (no such DB) leaves the previous backup alone
  const before = fs.readFileSync(r.file);
  await assert.rejects(run({ dbPath: path.join(tmp, "missing.db"), dir, name: "database_backup_2026-10.db" }), /no database/);
  assert.deepEqual(fs.readFileSync(r.file), before);
  await close(db);
});

test("every place that opens myapp.db tunes it; nothing copies the db file directly", () => {
  const files = fs.readdirSync(repo).filter((f) => f.endsWith(".js"));
  for (const f of files) {
    const src = fs.readFileSync(path.join(repo, f), "utf8");
    if (/new sqlite3\.Database\(\s*["']\.\/myapp\.db["']/.test(src)) assert.match(src, /sqlitecfg["']\)\.tune\(|sqlitecfg\.tune\(/, f + " opens myapp.db without sqlitecfg.tune");
    assert.doesNotMatch(src, /copyFile(Sync)?\([^)]*myapp\.db/, f + " copies myapp.db as a file");
  }
  const sh = fs.readFileSync(path.join(repo, "deploy", "refresh-staging-db.sh"), "utf8");
  assert.doesNotMatch(sh, /\bcp\s+\S*myapp\.db/); assert.match(sh, /VACUUM INTO/);
  const gi = fs.readFileSync(path.join(repo, ".gitignore"), "utf8");
  assert.match(gi, /^\*\.db-wal$/m); assert.match(gi, /^\*\.db-shm$/m);
});
