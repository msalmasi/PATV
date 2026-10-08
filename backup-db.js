// backup-db.js — the nightly database backup (root's crontab: 0 3 * * * /usr/bin/node /home/PATV/backup-db.js).
//
// 1.99fb: myapp.db runs in WAL mode (sqlitecfg.js), so recent commits live in myapp.db-wal until a checkpoint; a file
// copy of myapp.db alone would miss them. This takes the copy through SQLite's online backup API (sqlitecfg.backupTo:
// consistent, includes the WAL, waits for locks instead of failing - the old `sqlite3 .backup` call had no busy timeout
// and failed with "database is locked" on busy nights), checks it (PRAGMA integrity_check), gzips it, and only then
// replaces the month's previous file. Afterwards it checkpoints the live DB (wal_checkpoint(TRUNCATE)).
//
// One file per month, overwritten nightly (database_backup_YYYY-MM.db.gz); /etc/cron.d/patv-backup-prune deletes
// files older than 365 days.
//   node backup-db.js [--db=/home/PATV/myapp.db] [--dir=/home/PATV/backups] [--name=database_backup_2026-10.db]
// Exit code 0 = backed up, 1 = failed (the previous backup is left untouched).
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { pipeline } = require("stream");
const sqlite3 = require("sqlite3");
const sqlitecfg = require("./sqlitecfg");

function args(argv) {
  const out = {};
  for (const a of argv) { const m = /^--([a-z-]+)=(.*)$/.exec(a); if (m) out[m[1]] = m[2]; }
  return out;
}

/** Back up `dbPath` to `<dir>/<name>.gz` (consistent, verified, atomic). -> {file, pages, bytes, checkpoint} */
async function run({ dbPath = "/home/PATV/myapp.db", dir = "/home/PATV/backups", name = null, checkpoint = true, log = console } = {}) {
  if (!fs.existsSync(dbPath)) throw new Error("no database at " + dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const base = name || `database_backup_${new Date().toISOString().slice(0, 7)}.db`;     // YYYY-MM
  const dbFile = path.join(dir, base);
  const gz = dbFile + ".gz";
  const src = await new Promise((resolve, reject) => {
    const d = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (e) => (e ? reject(e) : resolve(d)));
  });
  try {
    await sqlitecfg.tune(src, { label: "backup", wal: false, log });       // busy_timeout only - the journal mode is the site's
    const r = await sqlitecfg.backupTo(src, dbFile);                      // verified: integrity_check = ok
    await new Promise((resolve, reject) => pipeline(fs.createReadStream(dbFile), zlib.createGzip(), fs.createWriteStream(gz + ".part"),
      (e) => (e ? reject(e) : resolve())));
    fs.renameSync(gz + ".part", gz);
    fs.unlinkSync(dbFile);
    let cp = null;
    if (checkpoint) {
      try { cp = await sqlitecfg.checkpoint(src, "TRUNCATE"); } catch (e) { log.error("checkpoint after the backup failed: " + e.message); }
    }
    return { file: gz, pages: r.pages, bytes: fs.statSync(gz).size, checkpoint: cp };
  } catch (e) {
    try { fs.unlinkSync(gz + ".part"); } catch (_) { /* none */ }
    throw e;
  } finally {
    await new Promise((resolve) => src.close(() => resolve()));
  }
}

if (require.main === module) {
  const a = args(process.argv.slice(2));
  run({ dbPath: a.db || undefined, dir: a.dir || undefined, name: a.name || null })
    .then((r) => {
      console.log(`${new Date().toISOString()} Backup successful: ${r.file} (${r.pages} pages, ${r.bytes} bytes gz, integrity ok` +
                  (r.checkpoint ? `, checkpoint busy=${r.checkpoint.busy} log=${r.checkpoint.log} copied=${r.checkpoint.checkpointed}` : "") + ")");
    })
    .catch((e) => { console.error(`${new Date().toISOString()} Backup failed:`, e && e.message ? e.message : e); process.exitCode = 1; });
}

module.exports = { run };
