// sqlitecfg.js — how every connection to the site's SQLite file (myapp.db) is set up, plus a WAL-safe backup (1.99fb).
//
// Why: prod's pm2 log had ~850 "SQLITE_BUSY: database is locked" ("Failed to prepare spin", "[rooms] activity", ...).
// The site opens several connections to the one file (dbUtils.js's shared one, index.js's, user.controller.js's) and
// each had node-sqlite3's default busy timeout (1 s), so a writer colliding with another's transaction - or with the
// nightly backup's read lock - soon failed. Now every connection gets:
//   - busy_timeout 5000 ms (per connection: wait for a lock instead of failing),
//   - journal_mode=WAL (persistent, stored in the file: readers never block the writer and vice versa),
//   - synchronous=NORMAL (per connection; safe with WAL - a power cut can lose the last commits, never corrupt).
// and dbUtils' runQuery / getQuery retry SQLITE_BUSY a couple of times with jitter (withBusyRetry) as defence in depth.
//
// WAL keeps recent commits in myapp.db-wal (+ the index myapp.db-shm) until a checkpoint copies them into myapp.db,
// so COPYING myapp.db ALONE (cp, fs.copyFile, scp) MISSES DATA. Back up through SQLite instead: backupTo() below (the
// online backup API), VACUUM INTO, or `sqlite3 myapp.db ".backup ..."`. checkpoint() folds the WAL back into the main
// file and truncates it (the site runs it hourly; backup-db.js after the nightly backup).
//
// Rollback (app stopped): sqlite3 myapp.db "PRAGMA journal_mode=DELETE;"  (and remove the WAL switch here first, or
// the next open turns it back on).
"use strict";

const BUSY_MS = 5000;
const CHECKPOINT_MS = 60 * 60 * 1000;

function isBusy(err) {
  return !!err && (err.code === "SQLITE_BUSY" || err.errno === 5 || /SQLITE_BUSY|database is locked/i.test(String(err.message || "")));
}

/** Run `fn` (-> promise) again when it fails with SQLITE_BUSY: `tries` attempts in all, a jittered pause between. */
async function withBusyRetry(fn, { tries = 3, baseMs = 60, jitterMs = 140, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isBusy(e) || i === tries - 1) throw e;
      await sleep(baseMs * (i + 1) + Math.floor(Math.random() * jitterMs));
    }
  }
  throw last;
}

const p = (db, method, sql, params = []) => new Promise((resolve, reject) =>
  db[method](sql, params, function (err, row) { if (err) reject(err); else resolve(method === "run" ? this : row); }));

/**
 * Configure a node-sqlite3 connection. Call right after `new sqlite3.Database(...)`: the busy timeout is set first and
 * the pragmas are queued in serialize mode, so they run before anything the caller queues next.
 * -> promise of {journal_mode, synchronous, busy_timeout} (never rejects; problems are logged).
 *   opts.wal = false: leave the journal mode alone (backup / inspection tools).
 */
function tune(db, { label = "db", wal = true, log = console } = {}) {
  db.configure("busyTimeout", BUSY_MS);
  let mode = null;
  const done = new Promise((resolve) => {
    db.serialize(() => {
      db.run(`PRAGMA busy_timeout = ${BUSY_MS}`);
      if (wal) {
        db.get("PRAGMA journal_mode = WAL", (err, row) => {
          mode = row ? String(row.journal_mode || "").toLowerCase() : null;
          if (err) log.error(`[sqlite] ${label}: couldn't switch to WAL (${err.message}) - staying in the old journal mode`);
          else if (mode !== "wal" && mode !== "memory") log.error(`[sqlite] ${label}: journal_mode is ${mode}, not wal`);
        });
        // NORMAL is only safe with WAL: set it once we know the switch worked (FULL stays otherwise)
        db.get("PRAGMA journal_mode", (err, row) => {
          const m = row ? String(row.journal_mode || "").toLowerCase() : null;
          if (m === "wal") db.run("PRAGMA synchronous = NORMAL");
          finish();
        });
      } else {
        db.get("PRAGMA journal_mode", (err, row) => { mode = row ? String(row.journal_mode || "").toLowerCase() : null; finish(); });
      }
    });
    function finish() {
      db.get("PRAGMA synchronous", (e1, s) => db.get("PRAGMA busy_timeout", (e2, b) => db.get("PRAGMA journal_mode", (e3, j) =>
        resolve({ journal_mode: j ? String(j.journal_mode).toLowerCase() : mode, synchronous: s ? s.synchronous : null,
                  busy_timeout: b ? (b.timeout != null ? b.timeout : b.busy_timeout) : null }))));
    }
  });
  return done;
}

/** PRAGMA wal_checkpoint(TRUNCATE) -> {busy, log, checkpointed} (busy = 1: a reader kept it from finishing; harmless). */
async function checkpoint(db, mode = "TRUNCATE") {
  const m = /^(PASSIVE|FULL|RESTART|TRUNCATE)$/.test(mode) ? mode : "TRUNCATE";
  return p(db, "get", `PRAGMA wal_checkpoint(${m})`);
}

/** Checkpoint every `everyMs` (unref'd - never keeps a process alive). -> the timer. */
function startCheckpoints(db, { everyMs = CHECKPOINT_MS, label = "db", log = console } = {}) {
  const t = setInterval(() => {
    checkpoint(db).then((r) => {
      if (r && r.busy) log.log(`[sqlite] ${label}: hourly checkpoint couldn't finish (a reader was busy) - wal pages ${r.log}, copied ${r.checkpointed}`);
    }).catch((e) => log.error(`[sqlite] ${label}: checkpoint failed: ${e.message}`));
  }, everyMs);
  if (t.unref) t.unref();
  return t;
}

/**
 * A consistent copy of `db` (its main database) in `file`, through SQLite's online backup API - so it includes every
 * commit still sitting in the -wal file. Written to file + ".part" and renamed when done; the copy is switched to
 * journal_mode=DELETE (one self-contained file, no -wal / -shm) and checked with PRAGMA integrity_check.
 * -> promise of {file, pages, integrity: "ok"}; rejects (and removes the partial file) on any failure.
 */
function backupTo(db, file, { verify = true, sqlite3 = require("sqlite3") } = {}) {
  const fs = require("fs");
  const part = file + ".part";
  const rm = (f) => { for (const x of [f, f + "-wal", f + "-shm", f + "-journal"]) { try { fs.unlinkSync(x); } catch (e) { /* none */ } } };
  rm(part);
  return new Promise((resolve, reject) => {
    const b = db.backup(part, (err) => {
      if (err) { rm(part); return reject(err); }
      let tries = 0;
      const step = () => b.step(-1, (e) => {
        if (e && isBusy(e) && ++tries < 20) return setTimeout(step, 100 + Math.floor(Math.random() * 200));
        if (e || !b.completed) {
          const why = e || new Error("backup didn't complete");
          return b.finish(() => { rm(part); reject(why); });
        }
        b.finish((fe) => {
          if (fe) { rm(part); return reject(fe); }
          resolve(b.pageCount);
        });
      });
      step();
    });
  }).then(async (pages) => {
    let integrity = null;
    const out = new sqlite3.Database(part);
    try {
      out.configure("busyTimeout", BUSY_MS);
      await p(out, "get", "PRAGMA journal_mode = DELETE");
      if (verify) {
        const r = await p(out, "all", "PRAGMA integrity_check");
        integrity = r.map((x) => x.integrity_check).join("; ");
      }
    } finally {
      await new Promise((r) => out.close(() => r()));
    }
    if (verify && integrity !== "ok") { rm(part); throw new Error("backup failed integrity_check: " + String(integrity).slice(0, 300)); }
    rm(file);
    fs.renameSync(part, file);
    return { file, pages, integrity: integrity || "unchecked" };
  });
}

module.exports = { tune, withBusyRetry, isBusy, checkpoint, startCheckpoints, backupTo, BUSY_MS, CHECKPOINT_MS };
