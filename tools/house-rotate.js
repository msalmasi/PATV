#!/usr/bin/env node
// tools/house-rotate.js — 1.99?? (Pepe account rotation): move Pepe's house pad to his new Camfrog home room from the command line
// (houserotate.js does the work). DRY RUN BY DEFAULT.
//
// The normal path is Pepe's `!identity rotate` (he calls POST /api/pepe/identity/rotate and the site reloads its caches in-process).
// This tool is for a REHEARSAL on a copy of the database, and for emergencies. After an --apply on the live database the site must
// be restarted (pm2 restart <app>): its registry, house room and chat caches are in-process.
//
//   node tools/house-rotate.js --from PepeFrog.Room --to The_Swamp --title "The Swamp" --slug the-swamp \
//                              --login-from PepeFrog --login-to Pepe_Frog [--key <k>] [--merge] [--archive keep]
//                              [--dir <folder with myapp.db> | --db <path to a myapp.db>] [--backup-dir <dir>] [--apply] [--json]
//   node tools/house-rotate.js --status [--dir ...]
//   node tools/house-rotate.js --restore <key> --login-to <Pepe's login now> [--dir ...] [--apply]
//
//   --dir / --db   the database: a folder holding myapp.db (the site's code always opens ./myapp.db), or a path to such a
//                  file (its name must be myapp.db - put a rehearsal copy in a folder of its own:
//                  sqlite3 -readonly /home/PATV/myapp.db "VACUUM INTO '/home/PATV/backups/rehearsal-20261110/myapp.db'")
//   --apply        a VACUUM INTO backup first (<backup dir>/myapp-pre-house-rotate-<time>.db; refused when it fails or the
//                  disk has less than twice the database's size free), then the rotation in one transaction
//   --backup-dir   default $DB_BACKUP_DIR, else <dir>/backups
// Exit codes: 0 done / dry run / already, 2 usage, 3 refused, 1 error. Never prints a secret (the bot token isn't used here).
"use strict";
const fs = require("fs");
const path = require("path");

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(argv[i]);
  if (!m) continue;
  if (m[2] !== undefined) args[m[1]] = m[2];
  else if (i + 1 < argv.length && !/^--/.test(argv[i + 1])) args[m[1]] = argv[++i];
  else args[m[1]] = true;
}
const usage = (msg) => { console.error(msg); console.error("see the header of tools/house-rotate.js"); process.exit(2); };
const ROOT = path.resolve(__dirname, "..");
let DIR = process.cwd();
if (args.db) {
  const f = path.resolve(String(args.db));
  if (path.basename(f) !== "myapp.db") usage(`--db must name a file called myapp.db (the site opens ./myapp.db) - put the copy in a folder of its own: ${f}`);
  DIR = path.dirname(f);
} else if (args.dir) DIR = path.resolve(String(args.dir));
if (!fs.existsSync(path.join(DIR, "myapp.db"))) usage(`no myapp.db in ${DIR}`);
process.chdir(DIR);
try {
  const env = [path.join(DIR, ".env"), path.join(ROOT, ".env")].find((f) => fs.existsSync(f));
  if (env) require("dotenv").config({ path: env });
} catch (e) { /* no dotenv: the shell's environment */ }
const M = (n) => require(path.join(ROOT, n));
const APPLY = !!args.apply;

async function backup() {
  const dir = path.resolve(String(args["backup-dir"] || process.env.DB_BACKUP_DIR || path.join(DIR, "backups")));
  fs.mkdirSync(dir, { recursive: true });
  const size = fs.statSync(path.join(DIR, "myapp.db")).size + (fs.existsSync(path.join(DIR, "myapp.db-wal")) ? fs.statSync(path.join(DIR, "myapp.db-wal")).size : 0);
  try {
    const st = fs.statfsSync(dir);
    const free = Number(st.bavail) * Number(st.bsize);
    if (free < 2 * size) throw new Error(`only ${(free / 1e9).toFixed(2)} GB free in ${dir}, the database is ${(size / 1e9).toFixed(2)} GB - need twice that`);
  } catch (e) { if (!/statfsSync is not a function/.test(e.message)) throw e; }
  const file = path.join(dir, `myapp-pre-house-rotate-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  await M("dbUtils").runQuery(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error(`the backup ${file} wasn't written`);
  return file;
}

(async () => {
  const H = M("houserotate");
  try { await M("chatlog").attach(); } catch (e) { /* no separate archive database (CHATLOG_DB unset) */ }
  const out = (x) => console.log(JSON.stringify(x, null, args.json ? 1 : 2));
  if (args.status) { out(await H.status()); return 0; }
  const s = (k) => (args[k] === undefined || args[k] === true ? undefined : String(args[k]));
  const body = {
    key: s("key"), restore_of: s("restore"), merge: !!args.merge, archive: s("archive") || "move",
    from: { room: s("from"), login: s("login-from") },
    to: { room: s("to"), title: s("title"), slug: s("slug"), login: s("login-to") },
    actor: "cli:" + (process.env.USER || process.env.USERNAME || "operator"),
  };
  if (!body.to.login) usage("--login-to <Pepe's Camfrog login now> is needed");
  if (!body.restore_of && !body.to.room) usage("--to <the new home room id> is needed (or --restore <key>)");
  const p = await H.plan(body);
  out(p);
  if (p.refusal) { console.error(`REFUSED (${p.refusal.code}): ${p.refusal.error} - nothing written`); return 3; }
  if (p.already) { console.log("already done - nothing to do"); return 0; }
  if (!APPLY) { console.log("dry run - nothing written (add --apply)"); return 0; }
  const file = await backup();
  console.log(`backup: ${file}`);
  const r = await H.apply(body, { live: false });
  out(r);
  console.log(r.already ? "already done - nothing to do" : `done: ${r.key}. If this is the live database, restart the site now (pm2 restart <app>) - its caches are in-process.`);
  return 0;
})().then((code) => process.exit(code || 0), (e) => {
  if (e && e.refuse) { console.error(`REFUSED (${e.code}): ${e.message} - nothing written`); process.exit(3); }
  console.error("FAILED:", e && e.stack ? e.stack : e);
  process.exit(1);
});
