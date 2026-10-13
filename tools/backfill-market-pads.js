// tools/backfill-market-pads.js — 1.99ur: give every market / betting pool / poll its pad (padlinks.js). DRY RUN BY DEFAULT.
//
//   node tools/backfill-market-pads.js [--dir=<folder with myapp.db>] [--apply] [--web-sitewide] [--backup-dir=<dir>] [--json]
//
// Before 1.99ur a market / pool / poll had no pad: markets and pools carried the CHAT ROOM they were made in (`room` in the
// JSON row), polls nothing at all. The site never let you pick a pad, so the room was an artifact:
//   * a chat create: the room's id (= its pad's id for a Camfrog pad)                         -> that pad   (how = room)
//   * some rows hold the room's DISPLAY NAME ("PepeLab" for PepeBeta.Room) instead of its id   -> the pad with that title,
//     when exactly one has it (how = room-title) - reported
//   * a website create ran in "the room the creator happened to be in right now" (pepe_webact._webact_home_room) - no
//     choice was ever made. Found through pepe_actions (a done "!market new" / "!pool new" whose reply names the M id).
//     Kept on that room's pad by default (reported as web-room); --web-sitewide makes them site-wide instead.
//   * no room at all                                                                            -> site-wide (NULL)
//   * a room no pad knows ("Camfrog", a typo)                                                   -> reported, left NULL
// Only the `pad` COLUMN of the markets / polls tables is written (the JSON rows are the engines' and are rewritten on every
// trade; storeRow keeps the column with COALESCE). A row whose column is already set is never changed (a re-key may have moved
// it) - differences are reported as "differs". Idempotent. --apply takes a VACUUM INTO backup first, always.
"use strict";
const fs = require("fs");
const path = require("path");

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const appDir = path.resolve(__dirname, "..");
if (args.dir) process.chdir(path.resolve(String(args.dir)));          // dbUtils opens ./myapp.db
if (!fs.existsSync(path.join(process.cwd(), "myapp.db"))) { console.error(`no myapp.db in ${process.cwd()}`); process.exit(2); }
const { runQuery, getQuery } = require(path.join(appDir, "dbUtils"));
const padlinks = require(path.join(appDir, "padlinks"));
const apply = !!args.apply;

async function hasTable(t) { return (await getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t])).length > 0; }
async function ensureColumn(t) {
  const cols = new Set((await getQuery(`PRAGMA table_info(${t})`)).map((c) => c.name));
  if (!cols.has("pad")) {
    if (!apply) return false;
    await runQuery(`ALTER TABLE ${t} ADD COLUMN pad TEXT`);
  }
  return true;
}

/** M ids a website "!market new" / "!pool new" made (Pepe's reply names the ref). */
async function webCreated() {
  const out = new Map();
  if (!(await hasTable("pepe_actions"))) return out;
  const rows = await getQuery(`SELECT id, username, args, message FROM pepe_actions WHERE status = 'done'
                               AND (args LIKE '["market","new"%' OR args LIKE '["market","create"%' OR args LIKE '["pool","new"%' OR args LIKE '["pool","create"%')`);
  for (const r of rows) {
    const m = /\bM(\d+)\b/.exec(String(r.message || ""));
    if (m) out.set(Number(m[1]), { action: r.id, by: r.username });
  }
  return out;
}

async function survey() {
  await padlinks.ready();
  const web = await webCreated();
  const plan = [];
  for (const [table, key] of [["markets", "id"], ["polls", "id"]]) {
    if (!(await hasTable(table))) continue;
    const colOk = await ensureColumn(table);
    const rows = await getQuery(`SELECT ${key} AS id, data${colOk ? ", pad" : ", NULL AS pad"} FROM ${table} ORDER BY ${key}`);
    for (const r of rows) {
      let d = {};
      try { d = JSON.parse(r.data); } catch (e) { d = {}; }
      const { pad, how } = padlinks.resolveHow(d);
      const isWeb = table === "markets" && web.has(Number(r.id));
      let want = pad, action;
      if (isWeb && args["web-sitewide"]) { want = null; }
      if (r.pad) action = r.pad === want ? "ok" : "differs (kept)";
      else if (want) action = "set";
      else if (d.room && !pad) action = "unresolved (left site-wide)";
      else action = "site-wide";
      plan.push({ table, id: r.id, ref: table === "markets" ? `M${r.id}` : String(r.id), model: d.model || (table === "polls" ? "poll" : "pool"),
                  status: d.status || null, room: d.room || null, pad_field: d.pad || null, column: r.pad || null, want: want || null,
                  how: isWeb ? (args["web-sitewide"] ? "web (site-wide)" : `web-room (${how || "none"})`) : how, action,
                  web: isWeb ? web.get(Number(r.id)) : null });
    }
  }
  return plan;
}

async function backup(dir) {
  const d = path.resolve(String(dir || "db-backups"));
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, `myapp-pre-marketpads-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  await runQuery(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return file;
}

(async () => {
  const plan = await survey();
  const count = (f) => plan.filter(f).length;
  const summary = {
    rows: plan.length, set: count((p) => p.action === "set"), ok: count((p) => p.action === "ok"),
    site_wide: count((p) => p.action === "site-wide"), unresolved: count((p) => p.action.startsWith("unresolved")),
    differs: count((p) => p.action.startsWith("differs")),
    by_how: plan.reduce((a, p) => { const k = p.how || "none"; a[k] = (a[k] || 0) + 1; return a; }, {}),
    rooms_unresolved: [...new Set(plan.filter((p) => p.action.startsWith("unresolved")).map((p) => p.room))],
    display_names: [...new Set(plan.filter((p) => p.how === "room-title" || p.how === "room-slug").map((p) => `${p.room} -> ${p.want}`))],
  };
  if (args.json) console.log(JSON.stringify({ apply, summary, plan }, null, 1));
  else {
    for (const p of plan) if (p.action !== "ok") console.log(`${p.ref.padEnd(14)} ${String(p.model).padEnd(5)} ${String(p.status || "").padEnd(8)} room=${JSON.stringify(p.room)} -> ${p.want || "(site-wide)"}  [${p.how || "-"}] ${p.action}${p.web ? ` (web action #${p.web.action} by ${p.web.by})` : ""}`);
    console.log(JSON.stringify(summary, null, 1));
  }
  if (!apply) { console.log("dry run - nothing written (add --apply)"); return; }
  const file = await backup(args["backup-dir"]);
  console.log(`backup: ${file}`);
  const { tx } = require(path.join(appDir, "dbUtils"));
  let n = 0;
  await tx(async () => {
    for (const p of plan) {
      if (p.action !== "set") continue;
      const r = await runQuery(`UPDATE ${p.table} SET pad = ? WHERE id = ? AND pad IS NULL`, [p.want, p.id]);
      n += (r && r.changes) || 0;
    }
  });
  console.log(`applied: ${n} row(s) given a pad`);
})().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
