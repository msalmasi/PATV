// backup-db.js — the nightly database backup (root's crontab: 0 3 * * * /usr/bin/node /home/PATV/backup-db.js).
//
// 1.99fb: myapp.db runs in WAL mode (sqlitecfg.js), so recent commits live in myapp.db-wal until a checkpoint; a file
// copy of myapp.db alone would miss them. This takes the copy through SQLite's online backup API (sqlitecfg.backupTo:
// consistent, includes the WAL, waits for locks instead of failing), checks it (PRAGMA integrity_check), gzips it to
// a .gz.part and only then renames it into place. Afterwards it checkpoints the live DB (wal_checkpoint(TRUNCATE)).
//
// Retention (1.99ff; see deploy/README.md "Database backups"):
//   <dir>/daily/database_backup_daily_YYYY-MM-DD.db.gz  every night; kept 14 days (at least the 14 newest are always
//                                                       kept). Pruned HERE, only after a successful backup.
//   <dir>/database_backup_YYYY-MM.db.gz                 the month's FIRST good backup, never overwritten (re-created if
//                                                       missing or 0 bytes). /etc/cron.d/patv-backup-prune deletes
//                                                       these after 365 days; it uses -maxdepth 1, so it never sees
//                                                       daily/.
// Refuses to start (exit 1) with less than ~2 GB free in <dir>.
//
//   node backup-db.js [--db=/home/PATV/myapp.db | --db=staging] [--dir=/home/PATV/backups] [--date=YYYY-MM-DD]
//   node backup-db.js --name=some_file.db   (one-off: just <dir>/some_file.db.gz - no daily/monthly/prune)
//   --db=staging = /home/PATV-staging/myapp.db, and its default --dir is /root/staging-backups (never prod's folder).
//   --date is a test hook: pretend today is that (local) date.
// Exit code 0 = backed up, 1 = failed or refused (existing backups are left untouched).
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { pipeline } = require("stream");
const { execFileSync } = require("child_process");
const sqlite3 = require("sqlite3");
const sqlitecfg = require("./sqlitecfg");

const PROD_DB = "/home/PATV/myapp.db";
const PROD_DIR = "/home/PATV/backups";
const STAGING_DB = "/home/PATV-staging/myapp.db";
const STAGING_DIR = "/root/staging-backups";
const DAILY_DIR = "daily";
const KEEP_DAILY = 14;
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const DAILY_RE = /^database_backup_daily_(\d{4})-(\d{2})-(\d{2})\.db\.gz$/;

function args(argv) {
  const out = {};
  for (const a of argv) { const m = /^--([a-z-]+)=(.*)$/.exec(a); if (m) out[m[1]] = m[2]; }
  return out;
}

const pad = (n) => String(n).padStart(2, "0");
/** Local calendar date of `d` -> "YYYY-MM-DD" (the cron runs at 03:00 local time). */
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** "YYYY-MM-DD" -> a Date at local noon that day (for --date). */
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!m) throw new Error("bad --date (want YYYY-MM-DD): " + s);
  const d = new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
  if (ymd(d) !== s) throw new Error("bad --date: " + s);
  return d;
}

/** Free bytes on the filesystem holding `dir`. Node 16 has no fs.statfs, so ask df (POSIX output, 1K blocks). */
function freeBytes(dir) {
  if (typeof fs.statfsSync === "function") { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); }
  const out = execFileSync("df", ["-Pk", dir], { encoding: "utf8" }).trim().split("\n");
  const avail = Number(out[out.length - 1].split(/\s+/)[3]);
  if (!Number.isFinite(avail)) throw new Error("couldn't read free space from df");
  return avail * 1024;
}

const gb = (b) => (b / 1024 / 1024 / 1024).toFixed(1) + " GB";
const mb = (b) => (b / 1024 / 1024).toFixed(1) + " MB";

/** Write a verified, gzipped backup of the open `src` to `gz` via `gz.part` + rename. -> pages */
async function writeGz(src, gz) {
  const dbFile = gz.replace(/\.gz$/, "");
  try {
    const r = await sqlitecfg.backupTo(src, dbFile);                      // verified: integrity_check = ok
    await new Promise((resolve, reject) => pipeline(fs.createReadStream(dbFile), zlib.createGzip(), fs.createWriteStream(gz + ".part"),
      (e) => (e ? reject(e) : resolve())));
    fs.renameSync(gz + ".part", gz);
    return r.pages;
  } catch (e) {
    try { fs.unlinkSync(gz + ".part"); } catch (_) { /* none */ }
    throw e;
  } finally {
    try { fs.unlinkSync(dbFile); } catch (_) { /* none */ }
  }
}

/** Copy `from` to `to` atomically (to.part + rename). */
function copyAtomic(from, to) {
  try {
    fs.copyFileSync(from, to + ".part");
    fs.renameSync(to + ".part", to);
  } catch (e) {
    try { fs.unlinkSync(to + ".part"); } catch (_) { /* none */ }
    throw e;
  }
}

/**
 * Delete daily files dated `keepDays` or more days before `today`, but never any of the `keep` newest.
 * Only called after a successful backup. -> [deleted file names]
 */
function pruneDaily(dailyDir, today, { keep = KEEP_DAILY, keepDays = KEEP_DAILY } = {}) {
  const files = fs.readdirSync(dailyDir)
    .map((f) => { const m = DAILY_RE.exec(f); return m ? { f, key: `${m[1]}-${m[2]}-${m[3]}`, t: new Date(+m[1], +m[2] - 1, +m[3]).getTime() } : null; })
    .filter(Boolean)
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));      // newest first
  const cutoff = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (keepDays - 1)).getTime();
  const gone = [];
  files.forEach((x, i) => {
    if (i < keep || x.t >= cutoff) return;
    fs.unlinkSync(path.join(dailyDir, x.f));
    gone.push(x.f);
  });
  return gone;
}

/**
 * Back up `dbPath` into `dir`.
 *  default: daily file + the month's file (first good backup of the month) + prune dailies.
 *  name:    one-off, just <dir>/<name>.gz (replaced on success), no daily/monthly/prune.
 * Options for tests: now (Date), free (dir -> bytes), minFree.
 * -> {file, pages, bytes, checkpoint, monthly, monthlyStatus, pruned, free}
 */
async function run({ dbPath = PROD_DB, dir = PROD_DIR, name = null, checkpoint = true, log = console,
                     now = new Date(), free = freeBytes, minFree = MIN_FREE_BYTES } = {}) {
  if (!fs.existsSync(dbPath)) throw new Error("no database at " + dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const freeBefore = free(dir);
  if (!(freeBefore >= minFree)) {
    const e = new Error(`refused: only ${gb(freeBefore)} free in ${dir} (need ${gb(minFree)}); nothing written, nothing pruned`);
    e.lowDisk = true;
    throw e;
  }
  const today = ymd(now);
  const dailyDir = path.join(dir, DAILY_DIR);
  const target = name ? path.join(dir, name + ".gz") : path.join(dailyDir, `database_backup_daily_${today}.db.gz`);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const src = await new Promise((resolve, reject) => {
    const d = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (e) => (e ? reject(e) : resolve(d)));
  });
  let pages, cp = null;
  try {
    await sqlitecfg.tune(src, { label: "backup", wal: false, log });       // busy_timeout only - the journal mode is the site's
    pages = await writeGz(src, target);
    if (checkpoint) {
      try { cp = await sqlitecfg.checkpoint(src, "TRUNCATE"); } catch (e) { log.error("checkpoint after the backup failed: " + e.message); }
    }
  } finally {
    await new Promise((resolve) => src.close(() => resolve()));
  }
  const out = { file: target, pages, bytes: fs.statSync(target).size, checkpoint: cp, monthly: null, monthlyStatus: null, pruned: [], free: null };
  if (!name) {
    // The month's file: the first good backup of the month, never overwritten (a 0-byte/missing one is (re)made).
    const monthly = path.join(dir, `database_backup_${today.slice(0, 7)}.db.gz`);
    let st = null;
    try { st = fs.statSync(monthly); } catch (_) { /* missing */ }
    if (st && st.size > 0) out.monthlyStatus = "kept";
    else { copyAtomic(target, monthly); out.monthlyStatus = st ? "replaced 0-byte file" : "created"; }
    out.monthly = monthly;
    out.pruned = pruneDaily(dailyDir, now);                               // after success only
  }
  try { out.free = free(dir); } catch (_) { /* informational */ }
  return out;
}

function summary(r, dir) {
  const rel = (f) => path.relative(dir, f).split(path.sep).join("/");
  return `Backup successful: daily=${rel(r.file)} (${mb(r.bytes)} gz, ${r.pages} pages, integrity ok)` +
    (r.monthly ? ` monthly=${rel(r.monthly)} ${r.monthlyStatus}` : "") +
    (r.monthly ? ` pruned=${r.pruned.length}${r.pruned.length ? " [" + r.pruned.join(", ") + "]" : ""}` : "") +
    (r.free != null ? ` free=${gb(r.free)}` : "") +
    (r.checkpoint ? ` checkpoint busy=${r.checkpoint.busy} log=${r.checkpoint.log} copied=${r.checkpoint.checkpointed}` : "");
}

if (require.main === module) {
  const a = args(process.argv.slice(2));
  const staging = a.db === "staging";
  const dbPath = staging ? STAGING_DB : (a.db || PROD_DB);
  const dir = a.dir || (staging ? STAGING_DIR : PROD_DIR);
  let now;
  try { now = a.date ? parseDate(a.date) : new Date(); } catch (e) { console.error(`${new Date().toISOString()} Backup failed: ${e.message}`); process.exit(1); }
  run({ dbPath, dir, name: a.name || null, now })
    .then((r) => { console.log(`${new Date().toISOString()} ${summary(r, dir)}`); })
    .catch((e) => { console.error(`${new Date().toISOString()} Backup failed:`, e && e.message ? e.message : e); process.exitCode = 1; });
}

module.exports = { run, pruneDaily, freeBytes, parseDate, ymd, summary, KEEP_DAILY, MIN_FREE_BYTES };
