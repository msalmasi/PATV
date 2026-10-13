// tools/scrub-consent-feed.js — 1.99wp: remove a voice-clone consent reading that reached a bridged room's feed as Pepe's mic
// transcript (before bot 1.99wo a !clonemyvoice reading was treated as ordinary mic speech). DRY RUN BY DEFAULT.
// The VM half is camfrog-bot tools/scrub_consent.py (Pepe 1.99wo+ never sends a consent turn to the site any more).
//
//   node tools/scrub-consent-feed.js --login=<camfrog login> --room=<room id> --since=<ISO time> --until=<ISO time>
//                                    [--codes=<code>,<code>]
//                                    [--dir=<folder with myapp.db>] [--backup-dir=<dir>] [--apply]
//
// What is removed: bridge_feed rows of the room that are a mic transcript ({k:"tx"}) said by --login whose text is a consent
// READING (the same rule as Pepe's pepe_voiceclone.is_consent_reading): "I consent to ... voice", or one of --codes read out
// (digits or words: "I am fond of code seven three nine three"). Talking ABOUT consent is not. Matched by content.
// Reported, never changed: any OTHER table/column whose text has a reading by that login (quotes, posts...) - look at them
// first; the legal consent record (voice_consents / voices / voice_owned*) is never scanned or touched.
// --apply takes an online SQLite backup first (sqlitecfg.backupTo = what `sqlite3 .backup` does, verified) into --backup-dir
// (default ./backups), then deletes in one dbUtils.tx. Idempotent: a second run finds nothing.
// The running site keeps each room's last 200 feed items IN MEMORY (bridge.js): a deleted row that is still among them stays
// visible until the site restarts - the tool says so ("LIVE") and the operator restarts the site once.
"use strict";
const fs = require("fs");
const path = require("path");

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const LOGIN = String(args.login || "").toLowerCase();
const CODES = String(args.codes || "").split(",").map((c) => c.replace(/\D/g, "")).filter((c) => c.length >= 4);
const ROOM = String(args.room || "");
const SINCE = Date.parse(String(args.since || ""));
const UNTIL = Date.parse(String(args.until || ""));
if (!/^[\w.\-]{1,40}$/.test(LOGIN) || !ROOM) { console.error("--login=<camfrog login> and --room=<room id> are required"); process.exit(2); }
const FEED_KEEP = 200;                                   // bridge.js: the items a running site holds per room
const SKIP_TABLES = new Set(["voice_consents", "voiceclone_config", "voices", "voice_owned", "voice_owned_logins", "bridge_feed"]);
const appDir = path.resolve(__dirname, "..");
if (args.dir) process.chdir(path.resolve(String(args.dir)));
if (!fs.existsSync(path.join(process.cwd(), "myapp.db"))) { console.error(`no myapp.db in ${process.cwd()}`); process.exit(2); }
if (!(SINCE < UNTIL)) { console.error("--since=<ISO time> and --until=<ISO time> are required (since < until)"); process.exit(2); }
const apply = !!args.apply;
const q = (n) => '"' + String(n).replace(/"/g, '""') + '"';

const DIGITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const norm = (t) => String(t == null ? "" : t).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function isConsentReading(text, codes = CODES) {
  const t = norm(text);
  if (!t) return false;
  if (/\bi consent to\b/.test(t) && /\bvoice\b/.test(t)) return true;
  for (const d of codes) {
    if (new RegExp(`\\b${d}\\b`).test(t)) return true;
    if (new RegExp(`\\b${[...d].map((x) => DIGITS[+x]).join(" ")}\\b`).test(t)) return true;
  }
  return false;
}

async function main() {
  const { runQuery, getQuery, tx, db } = require(path.join(appDir, "dbUtils"));
  const hasFeed = (await getQuery("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bridge_feed'")).length > 0;
  const feed = [];
  let live = new Set();
  if (hasFeed) {
    const rows = await getQuery("SELECT c, room_id, ts, data FROM bridge_feed WHERE room_id = ? AND ts >= ? AND ts < ?", [ROOM, SINCE, UNTIL]);
    for (const r of rows) {
      let d;
      try { d = JSON.parse(r.data); } catch (e) { continue; }
      if (!d || d.k !== "tx" || !d.u || String(d.u.login || "").toLowerCase() !== LOGIN || !isConsentReading(d.text)) continue;
      feed.push({ c: r.c, ts: new Date(r.ts).toISOString(), text: String(d.text).slice(0, 60) });
    }
    live = new Set((await getQuery("SELECT c FROM bridge_feed WHERE room_id = ? ORDER BY c DESC LIMIT ?", [ROOM, FEED_KEEP])).map((r) => r.c));
  }
  // everything else: report only
  const other = [];
  for (const { name } of await getQuery("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
    if (SKIP_TABLES.has(name)) continue;
    for (const c of await getQuery(`PRAGMA table_info(${q(name)})`)) {
      if (c.type && !/TEXT|CHAR|CLOB|JSON/i.test(c.type)) continue;
      const rows = await getQuery(`SELECT rowid AS _rid, ${q(c.name)} AS v FROM ${q(name)} WHERE instr(lower(${q(c.name)}), 'consent to') > 0
                                   OR ${CODES.map(() => `instr(${q(c.name)}, ?) > 0`).join(" OR ") || "0"}`, CODES).catch(() => []);
      for (const r of rows) {
        const v = String(r.v || "");
        if (v.toLowerCase().includes(LOGIN) && isConsentReading(v)) other.push({ table: name, column: c.name, rowid: r._rid, text: v.slice(0, 80) });
      }
    }
  }
  console.log(`room ${ROOM}, login ${LOGIN}, ${new Date(SINCE).toISOString()} .. ${new Date(UNTIL).toISOString()}`);
  for (const f of feed) console.log(`  bridge_feed  delete  c=${f.c} ${f.ts}${live.has(f.c) ? " LIVE (in the running site's memory - restart the site after --apply)" : ""}: ${JSON.stringify(f.text)}`);
  for (const o of other) console.log(`  REPORT ONLY  ${o.table}.${o.column} rowid=${o.rowid}: ${JSON.stringify(o.text)}`);
  if (!feed.length) console.log("  bridge_feed: nothing to remove");
  if (!apply) { console.log("dry run - nothing written (add --apply)"); return; }
  if (!feed.length) return;
  const dir = path.resolve(String(args["backup-dir"] || "backups"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `myapp-pre-consent-scrub-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  await require(path.join(appDir, "sqlitecfg")).backupTo(db, file);
  console.log(`backup: ${file}`);
  let n = 0;
  await tx(async () => {
    for (const f of feed) {
      const r = await runQuery("DELETE FROM bridge_feed WHERE c = ? AND room_id = ?", [f.c, ROOM]);
      n += (r && r.changes) || 0;
    }
  });
  console.log(`deleted ${n} bridge_feed row(s)`);
  if (feed.some((f) => live.has(f.c))) console.log("restart the site now: the running process still shows them (in memory) until it restarts");
}

main().then(() => setTimeout(() => process.exit(process.exitCode || 0), 50))
  .catch((e) => { console.error(e); process.exit(1); });
