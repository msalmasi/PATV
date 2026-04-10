const { exec } = require("child_process");
const path = require("path");

const DB_PATH = "/home/PATV/myapp.db";
const BACKUP_DIR = "/home/PATV/backups";
const timestamp = new Date().toISOString().slice(0, 7); // YYYY-MM

const backupFile = path.join(
  BACKUP_DIR,
  `database_backup_${timestamp}.db`
);

exec(
  `mkdir -p ${BACKUP_DIR} && sqlite3 "${DB_PATH}" ".backup '${backupFile}'" && gzip -f "${backupFile}"`,
  (err) => {
    if (err) {
      console.error("Backup failed:", err);
    } else {
      console.log("Backup successful:", backupFile + ".gz");
    }
  }
);