#!/usr/bin/env node
// tools/evidence-purge.js - wave 2 WP-5 (incognito / mic-stage spec I.5): moderation evidence clips (evidence.js) without the site's
// hourly sweep. A site rolled back past WP-5 runs no sweep, so stored clips would outlive their 30 days: switch evidence clips off at
// /admin/bridge#evidence, then run this with --all BEFORE that rollback (the older build doesn't have this file - copy it out of the
// checkout first). The steps, holds included: deploy/README.md "Rolling the site back past wave 2 WP-5".
//
//   node tools/evidence-purge.js [myapp.db] [--dir <EVIDENCE_DIR>]                   dry run (the default): counts only
//   node tools/evidence-purge.js [myapp.db] [--dir <dir>] --apply                    delete the clips past their 30 days (file, then row)
//   node tools/evidence-purge.js [myapp.db] [--dir <dir>] --all --apply              every clip, whatever its age
//   ... --include-held                                                                 also clips under a hold (else they are kept and counted)
//
// A hold = the clip's own (hold_at) or a chat legal hold on its pad or its subject (chatlog_holds "room:<rk>", "who:<login>",
// "who:h:<hash>", "who:u:<id>" of an account linked to the login) - the same rule as evidence.js's sweep. The directory: --dir, else
// EVIDENCE_DIR, else /var/lib/patv[-staging]/evidence on Linux (STAGING=1 for staging), else ../<repo>-evidence. Its own sqlite
// connection (run it with the site stopped or not - each row goes in its own statement, file first). Prints counts - never a row.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const FILE_RE = /^[a-f0-9]{32}\.m4a$/;
const hashOf = (login) => crypto.createHash("sha256").update("pepe-hidden:" + String(login == null ? "" : login).trim().toLowerCase(), "utf8").digest("hex").slice(0, 20);
function defaultDir() {
  if (process.env.EVIDENCE_DIR) return path.resolve(process.env.EVIDENCE_DIR);
  if (process.platform === "linux") return process.env.STAGING ? "/var/lib/patv-staging/evidence" : "/var/lib/patv/evidence";
  const repo = path.resolve(__dirname, "..");
  return path.resolve(repo, "..", path.basename(repo) + "-evidence");
}
function open(file) {
  const sqlite3 = require("sqlite3");
  return new Promise((resolve, reject) => { const db = new sqlite3.Database(file, (e) => (e ? reject(e) : resolve(db))); });
}
const P = (db, fn, sql, args = []) => new Promise((resolve, reject) => db[fn](sql, args, function (e, r) { if (e) reject(e); else resolve(fn === "run" ? this : r); }));

async function held(db, r, hasHolds) {
  if (r.hold_at != null) return true;
  if (!hasHolds) return false;
  const login = String(r.subject_login || "").toLowerCase();
  const keys = ["who:" + login, "who:h:" + hashOf(login)];
  let rk = r.rk;
  if (rk == null) { const x = (await P(db, "all", "SELECT rk FROM chatlog_rooms WHERE room_id = ?", [r.room_id]).catch(() => []))[0]; rk = x ? x.rk : null; }
  if (rk != null) keys.push("room:" + rk);
  for (const a of await P(db, "all", "SELECT userId FROM users WHERE lower(camfrogUsername) = ?", [login]).catch(() => [])) keys.push("who:u:" + String(a.userId).toLowerCase());
  return (await P(db, "all", `SELECT 1 FROM chatlog_holds WHERE key IN (${keys.map(() => "?").join(",")}) LIMIT 1`, keys)).length > 0;
}

async function purge(db, { dir, apply = false, all = false, includeHeld = false, now = Date.now() } = {}) {
  const has = async (t) => (await P(db, "all", "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t])).length > 0;
  const out = { apply, all, clips: 0, due: 0, deleted: 0, held: 0, files_missing: 0, file_errors: 0 };
  if (!(await has("evidence_clips"))) return out;
  const hasHolds = await has("chatlog_holds");
  const rows = await P(db, "all", "SELECT * FROM evidence_clips ORDER BY created");
  out.clips = rows.length;
  for (const r of rows) {
    if (!all && Number(r.expires_at) > now) continue;
    out.due++;
    if (!includeHeld && (await held(db, r, hasHolds))) { out.held++; continue; }
    if (!apply) continue;
    const f = FILE_RE.test(String(r.file || "")) ? path.join(dir, r.file.slice(0, 2), r.file) : null;
    if (f) {
      try { fs.unlinkSync(f); } catch (e) {
        if (e && e.code === "ENOENT") out.files_missing++;
        else { out.file_errors++; continue; }                         // the row stays: run it again
      }
    }
    await P(db, "run", "DELETE FROM evidence_clips WHERE id = ?", [r.id]);
    out.deleted++;
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (f) => args.includes(f);
  const di = args.indexOf("--dir");
  const dir = di >= 0 && args[di + 1] ? path.resolve(args[di + 1]) : defaultDir();
  const file = path.resolve(args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--dir") || "myapp.db");
  const db = await open(file);
  try {
    const r = await purge(db, { dir, apply: flag("--apply"), all: flag("--all"), includeHeld: flag("--include-held") });
    console.log(`[evidence-purge] ${r.apply ? "APPLIED" : "dry run"} (${r.all ? "every clip" : "past their 30 days"}): ${r.clips} clip(s) kept now, ${r.due} due, ` +
                `${r.held} kept under a hold${r.apply ? `, ${r.deleted} deleted (${r.files_missing} file(s) already gone, ${r.file_errors} file error(s) - rows kept)` : " - add --apply"}`);
  } finally { db.close(); }
}

if (require.main === module) main().catch((e) => { console.error("[evidence-purge] failed:", e.message); process.exit(1); });
module.exports = { purge, defaultDir };
