// tools/sitedb.js — the review of the owner answers 2026-10-20 (low): the shell switches for members' PAT (tools/money-backend.js,
// escrow-backend.js, fed-backend.js) are the emergency path, so they must never write a database the live site doesn't read.
// dbUtils opens ./myapp.db the moment it loads - CREATING it when it isn't there - so a switch run from the wrong directory
// used to make a fresh empty database, write the switch into it, print success and exit 0. Call siteDb() BEFORE requiring
// dbUtils (or any module that loads it): with --dir=<folder> it runs against that folder's database, and with no myapp.db
// there it stops (exit 2) without opening anything. policy-backend.js has its own copy of the same rule (PO-1 review).
"use strict";
const fs = require("fs");
const path = require("path");

/** -> the absolute path of the site's database; exits 2 (nothing opened) when ./myapp.db (or --dir's) isn't there. */
function siteDb(argv = process.argv.slice(2)) {
  const dir = (argv.find((a) => a.startsWith("--dir=")) || "").slice(6);
  if (dir) process.chdir(path.resolve(dir));
  const db = path.join(process.cwd(), "myapp.db");
  if (!fs.existsSync(db)) {
    console.error(`no myapp.db in ${process.cwd()} - run it in the site directory (cd /home/PATV) or pass --dir=<folder with myapp.db>; nothing was done`);
    process.exit(2);
  }
  return db;
}

/** A write's audit row (admin_audit "backend_switch", via "cli"), like the web switches - who ran it is --actor. */
async function cliAudit(actor, detail) {
  const A = require(path.join(__dirname, "..", "adminaudit"));
  await A.init();
  await A.record({ userId: ("cli:" + actor).slice(0, 64), username: String(actor).slice(0, 80) }, "backend_switch", null, Object.assign({ via: "cli" }, detail));
}

module.exports = { siteDb, cliAudit };
