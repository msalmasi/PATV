// Offline tests for the daily backups + 14-day retention in backup-db.js: daily file, the month's file (first good
// backup, never overwritten; a 0-byte one is replaced), pruning (exactly 14 kept, only after a successful backup) and
// the low-disk refusal. Temp dirs + a fake clock and fake free-space reader only.
//   NODE_PATH=<repo>/node_modules node --test test/backup-daily.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const sqlite3 = require("sqlite3");

const repo = path.resolve(__dirname, "..");
const { run, pruneDaily, parseDate, summary } = require(path.join(repo, "backup-db"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "backup-daily-test-"));
const quiet = { error() {}, log() {}, warn() {} };
const plenty = () => 50 * 1024 ** 3;

const open = (file) => new Promise((resolve, reject) => { const d = new sqlite3.Database(file, (e) => (e ? reject(e) : resolve(d))); });
const q = (db, method, sql, params = []) => new Promise((resolve, reject) =>
  db[method](sql, params, function (e, r) { if (e) reject(e); else resolve(method === "run" ? this : r); }));
const close = (db) => new Promise((r) => db.close(() => r()));

let n = 0;
async function makeDb(rows = 20) {
  const f = path.join(tmp, `site${++n}.db`);
  const db = await open(f);
  await q(db, "run", "CREATE TABLE users (userId TEXT PRIMARY KEY, points_balance INTEGER)");
  for (let i = 0; i < rows; i++) await q(db, "run", "INSERT INTO users VALUES (?, ?)", ["u" + i, i]);
  await close(db);
  return f;
}
const newDir = () => fs.mkdtempSync(path.join(tmp, "dir-"));
const daily = (dir, d) => path.join(dir, "daily", `database_backup_daily_${d}.db.gz`);
const rows = async (gz) => {
  const f = gz + ".restored.db";
  fs.writeFileSync(f, zlib.gunzipSync(fs.readFileSync(gz)));
  const db = await open(f);
  const ok = (await q(db, "get", "PRAGMA integrity_check")).integrity_check;
  const c = (await q(db, "get", "SELECT COUNT(*) AS n FROM users")).n;
  await close(db);
  fs.unlinkSync(f);
  return { ok, n: c };
};

test("the daily file is created (gzipped, verified, no leftovers), plus the month's file", async () => {
  const dbPath = await makeDb(20), dir = newDir();
  const r = await run({ dbPath, dir, now: parseDate("2026-10-08"), free: plenty, log: quiet });
  assert.equal(r.file, daily(dir, "2026-10-08"));
  assert.deepEqual(await rows(r.file), { ok: "ok", n: 20 });
  assert.equal(r.monthly, path.join(dir, "database_backup_2026-10.db.gz"));
  assert.equal(r.monthlyStatus, "created");
  assert.deepEqual(await rows(r.monthly), { ok: "ok", n: 20 });
  assert.deepEqual(fs.readdirSync(path.join(dir, "daily")), ["database_backup_daily_2026-10-08.db.gz"], "no .db / .part left");
  assert.deepEqual(fs.readdirSync(dir).sort(), ["daily", "database_backup_2026-10.db.gz"]);
  const line = summary(r, dir);
  assert.match(line, /daily=daily\/database_backup_daily_2026-10-08\.db\.gz/);
  assert.match(line, /monthly=database_backup_2026-10\.db\.gz created pruned=0 free=50\.0 GB/);
});

test("the month's file is the first good backup of the month and is never overwritten; a new month gets its own", async () => {
  const dir = newDir();
  await run({ dbPath: await makeDb(5), dir, now: parseDate("2026-10-01"), free: plenty, log: quiet });
  const monthly = path.join(dir, "database_backup_2026-10.db.gz");
  const first = fs.readFileSync(monthly);
  const r2 = await run({ dbPath: await makeDb(30), dir, now: parseDate("2026-10-02"), free: plenty, log: quiet });
  assert.equal(r2.monthlyStatus, "kept");
  assert.deepEqual(fs.readFileSync(monthly), first, "not overwritten");
  assert.equal((await rows(monthly)).n, 5);
  assert.equal((await rows(r2.file)).n, 30, "the daily has the new data");
  const r3 = await run({ dbPath: await makeDb(30), dir, now: parseDate("2026-11-01"), free: plenty, log: quiet });
  assert.equal(r3.monthlyStatus, "created");
  assert.ok(fs.existsSync(path.join(dir, "database_backup_2026-11.db.gz")));
  assert.deepEqual(fs.readFileSync(monthly), first);
});

test("a 0-byte (or missing) month's file is replaced by a good one", async () => {
  const dir = newDir();
  const monthly = path.join(dir, "database_backup_2026-10.db.gz");
  fs.writeFileSync(monthly, "");
  const r = await run({ dbPath: await makeDb(7), dir, now: parseDate("2026-10-15"), free: plenty, log: quiet });
  assert.equal(r.monthlyStatus, "replaced 0-byte file");
  assert.deepEqual(await rows(monthly), { ok: "ok", n: 7 });
  assert.ok(!fs.existsSync(monthly + ".part"));
});

test("pruning keeps exactly the 14 newest dailies (and leaves other files alone)", async () => {
  const dir = newDir();
  fs.mkdirSync(path.join(dir, "daily"));
  for (let i = 1; i <= 20; i++) fs.writeFileSync(daily(dir, `2026-09-${String(i).padStart(2, "0")}`), "old");
  fs.writeFileSync(path.join(dir, "daily", "notes.txt"), "x");
  fs.writeFileSync(path.join(dir, "database_backup_2025-01.db.gz"), "monthly");
  const r = await run({ dbPath: await makeDb(3), dir, now: parseDate("2026-09-21"), free: plenty, log: quiet });
  const left = fs.readdirSync(path.join(dir, "daily")).filter((f) => f.endsWith(".db.gz")).sort();
  assert.equal(left.length, 14);
  assert.equal(left[0], "database_backup_daily_2026-09-08.db.gz");
  assert.equal(left[13], "database_backup_daily_2026-09-21.db.gz");
  assert.equal(r.pruned.length, 7);
  assert.ok(fs.existsSync(path.join(dir, "daily", "notes.txt")));
  assert.ok(fs.existsSync(path.join(dir, "database_backup_2025-01.db.gz")), "monthlies are the cron prune's job");
});

test("pruning never drops below 14 files even when the newest are old (backups stopped for a while)", () => {
  const dir = newDir();
  for (let i = 1; i <= 16; i++) fs.writeFileSync(path.join(dir, `database_backup_daily_2026-01-${String(i).padStart(2, "0")}.db.gz`), "x");
  const gone = pruneDaily(dir, parseDate("2026-10-08"));
  assert.deepEqual(gone, ["database_backup_daily_2026-01-02.db.gz", "database_backup_daily_2026-01-01.db.gz"]);
  assert.equal(fs.readdirSync(dir).length, 14);
});

test("pruning only runs after a successful backup: a failed run deletes nothing", async () => {
  const dir = newDir();
  fs.mkdirSync(path.join(dir, "daily"));
  for (let i = 1; i <= 20; i++) fs.writeFileSync(daily(dir, `2026-09-${String(i).padStart(2, "0")}`), "old");
  const broken = path.join(tmp, "broken.db");
  fs.writeFileSync(broken, "this is not a sqlite database".repeat(100));
  await assert.rejects(run({ dbPath: broken, dir, now: parseDate("2026-09-30"), free: plenty, log: quiet }));
  assert.equal(fs.readdirSync(path.join(dir, "daily")).length, 20, "nothing pruned, nothing half-written");
  await assert.rejects(run({ dbPath: path.join(tmp, "missing.db"), dir, now: parseDate("2026-09-30"), free: plenty, log: quiet }), /no database/);
  assert.equal(fs.readdirSync(path.join(dir, "daily")).length, 20);
  assert.ok(!fs.existsSync(path.join(dir, "database_backup_2026-09.db.gz")));
});

test("low disk: refuses before writing anything (and prunes nothing)", async () => {
  const dir = newDir();
  fs.mkdirSync(path.join(dir, "daily"));
  for (let i = 1; i <= 20; i++) fs.writeFileSync(daily(dir, `2026-09-${String(i).padStart(2, "0")}`), "old");
  const seen = [];
  const low = (d) => { seen.push(d); return 1.5 * 1024 ** 3; };
  await assert.rejects(run({ dbPath: await makeDb(3), dir, now: parseDate("2026-09-21"), free: low, log: quiet }),
    (e) => e.lowDisk === true && /refused: only 1\.5 GB free .*need 2\.0 GB/.test(e.message));
  assert.deepEqual(seen, [dir]);
  assert.equal(fs.readdirSync(path.join(dir, "daily")).length, 20);
  assert.deepEqual(fs.readdirSync(dir), ["daily"]);
});

test("--name keeps the old one-off mode: just <dir>/<name>.gz, no daily/monthly/prune", async () => {
  const dir = newDir();
  const r = await run({ dbPath: await makeDb(4), dir, name: "manual.db", now: parseDate("2026-10-08"), free: plenty, log: quiet });
  assert.equal(r.file, path.join(dir, "manual.db.gz"));
  assert.equal(r.monthly, null);
  assert.deepEqual(fs.readdirSync(dir), ["manual.db.gz"]);
});

test("the CLI: --db=staging never defaults to prod's folder; --date is validated", () => {
  const src = fs.readFileSync(path.join(repo, "backup-db.js"), "utf8");
  assert.match(src, /a\.dir \|\| \(staging \? STAGING_DIR : PROD_DIR\)/);
  assert.match(src, /STAGING_DIR = "\/root\/staging-backups"/);
  assert.throws(() => parseDate("2026-02-30"), /bad --date/);
  assert.throws(() => parseDate("20261008"), /bad --date/);
  assert.equal(parseDate("2026-10-08").getDate(), 8);
});
