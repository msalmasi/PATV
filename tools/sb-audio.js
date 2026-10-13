// tools/sb-audio.js — 1.99wi: the soundboard catalogue's ready-made audio (soundboards.json "file", data/soundboard-audio/) on
// this server: what's installed, what's waiting for Pepe, what failed. DRY RUN BY DEFAULT (a read-only report).
//
//   node tools/sb-audio.js [--dir=<folder with myapp.db>] [--apply] [--backup-dir=<dir>] [--json]
//
// Normally there is nothing to do: at boot the site queues every catalogue file whose audio isn't up yet (soundboards.js
// seedCatalog), Pepe fetches + converts + uploads them within a few minutes (6 per 60 s sync), the WAV a clip played before is
// kept in SB_DIR/.replaced/, and anything that failed is offered again an hour later. This tool is for checking that, and
// for pushing it along at once:
//   --apply   1. backs up first: VACUUM INTO <backup-dir>/myapp-<ts>.db + a copy of every WAV in SB_DIR (<backup-dir>/sb-<ts>/)
//             2. a file clip that FAILED -> 'render' (new) / pending (it still plays its old WAV), tries 0
//                a file clip still playing audio that isn't its file (its note isn't its src) -> pending, tries 0
//                a live clip (the Gawk legendary) stuck in 'render' -> 'active' (it needs no WAV)
//             one dbUtils.tx; idempotent (a second run finds nothing to change). Ids, ownership, plays: never touched.
"use strict";
const fs = require("fs");
const path = require("path");

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const appDir = path.resolve(__dirname, "..");
if (args.dir) process.chdir(path.resolve(String(args.dir)));
if (!fs.existsSync(path.join(process.cwd(), "myapp.db"))) { console.error(`no myapp.db in ${process.cwd()}`); process.exit(2); }
const { runQuery, getQuery, tx } = require(path.join(appDir, "dbUtils"));
const SB = require(path.join(appDir, "soundboards"));
const apply = !!args.apply;
const SB_DIR = process.env.SB_DIR ? path.resolve(process.env.SB_DIR) : path.join(appDir, "uploads", "soundboards");

(async () => {
  const has = (await getQuery("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sb_clips'")).length;
  if (!has) { console.log("no sb_clips table yet - the site creates it at boot; nothing to do"); process.exit(0); }
  const cols = (await getQuery("PRAGMA table_info(sb_clips)")).map((c) => c.name);
  const pendingCol = cols.includes("pending");
  const want = [];
  for (const c of SB.CAT.global.clips) want.push(c);
  for (const p of SB.CAT.packs) for (const c of p.clips) want.push(c);
  for (const g of SB.CAT.legendaries) want.push(g);
  const rows = [];
  const fixes = [];
  for (const c of want) {
    const r = (await getQuery("SELECT * FROM sb_clips WHERE id = ?", [c.id]))[0] || null;
    if (c.live) {
      rows.push({ id: c.id, kind: "live", status: r ? r.status : "(not seeded)" });
      if (r && r.status === "render") fixes.push({ id: c.id, why: "live clip stuck in 'render'", sql: "UPDATE sb_clips SET status = 'active', tries = 0 WHERE id = ?" });
      continue;
    }
    if (!c.file) continue;
    const src = SB.fileSrc(c);
    const row = { id: c.id, file: c.file, src_ok: !!src, status: r ? r.status : "(not seeded)", pending: r && pendingCol ? r.pending : null,
                  tries: r ? r.tries : null, secs: r && r.secs ? Math.round(r.secs * 100) / 100 : null, installed: !!(r && src && r.note === src && r.status !== "failed") };
    rows.push(row);
    if (!r || !src) continue;
    if (r.src !== src) { row.note = "the site hasn't booted with this file yet (a restart queues it)"; continue; }
    if (r.status === "failed") {
      fixes.push({ id: c.id, why: "failed", sql: r.audio ? "UPDATE sb_clips SET status = 'active', pending = 1, tries = 0 WHERE id = ?" : "UPDATE sb_clips SET status = 'render', tries = 0 WHERE id = ?" });
    } else if (["active", "hidden"].includes(r.status) && r.note !== src && !(pendingCol && r.pending)) {
      fixes.push({ id: c.id, why: "still playing its old audio", sql: "UPDATE sb_clips SET pending = 1, tries = 0 WHERE id = ?" });
    }
  }
  const summary = { installed: rows.filter((x) => x.installed).length, file_clips: rows.filter((x) => x.file).length,
                    waiting: rows.filter((x) => x.file && !x.installed && x.status !== "failed").length, failed: rows.filter((x) => x.status === "failed").length,
                    to_fix: fixes.length };
  if (args.json) console.log(JSON.stringify({ summary, rows, fixes: fixes.map((f) => ({ id: f.id, why: f.why })) }, null, 1));
  else {
    for (const x of rows) console.log(`${x.id.padEnd(18)} ${String(x.status).padEnd(8)} ${x.kind === "live" ? "live (no WAV needed)" : (x.installed ? `installed ${x.secs}s` : `waiting (pending ${x.pending}, tries ${x.tries})`)}${x.note ? " - " + x.note : ""}`);
    console.log(`\n${summary.installed}/${summary.file_clips} catalogue files installed, ${summary.waiting} waiting for Pepe, ${summary.failed} failed; ${fixes.length} to fix`);
    for (const f of fixes) console.log(`  fix ${f.id}: ${f.why}`);
  }
  if (!apply) { if (fixes.length) console.log("\ndry run - nothing changed (--apply to back up and fix)"); process.exit(0); }
  if (!fixes.length) { console.log("nothing to fix"); process.exit(0); }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const bdir = path.resolve(String(args["backup-dir"] || path.join(process.cwd(), "backups")));
  fs.mkdirSync(bdir, { recursive: true });
  const dbBak = path.join(bdir, `myapp-sb-audio-${ts}.db`);
  await runQuery(`VACUUM INTO '${dbBak.replace(/'/g, "''")}'`);
  if (fs.existsSync(SB_DIR)) {
    const wdir = path.join(bdir, `sb-${ts}`);
    fs.mkdirSync(wdir, { recursive: true });
    for (const f of fs.readdirSync(SB_DIR)) if (f.endsWith(".wav")) fs.copyFileSync(path.join(SB_DIR, f), path.join(wdir, f));
  }
  console.log(`backup: ${dbBak} (+ the WAVs in ${bdir})`);
  await tx(async () => { for (const f of fixes) await runQuery(f.sql, [f.id]); });
  console.log(`fixed ${fixes.length}; Pepe picks them up at his next sync (6 per minute)`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
