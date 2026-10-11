// dbbackup.js — 1.99ne: a verified full copy of the site database before a migration touches it.
//
// sqlitecfg.backupTo = SQLite's online backup API (what `sqlite3 .backup` uses) + PRAGMA integrity_check, written to
// <file>.part and renamed when verified - never a file copy (the database is in WAL mode: a copy can miss commits).
// Files land in DB_BACKUP_DIR (default ./backups) as myapp-<tag>-<time>.db, next to the other pre-migration copies.
"use strict";
const fs = require("fs");
const path = require("path");

async function backupDb(tag) {
  const { db } = require("./dbUtils");
  const dir = path.resolve(process.env.DB_BACKUP_DIR || "backups");
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(tag || "migration").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40);
  const file = path.join(dir, `myapp-${safe}-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  await require("./sqlitecfg").backupTo(db, file);
  return file;
}

module.exports = { backupDb };
