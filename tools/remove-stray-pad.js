// tools/remove-stray-pad.js — 1.99vm: remove a stray pad and what belongs only to it. DRY RUN BY DEFAULT.
//
//   node tools/remove-stray-pad.js --id=<pad / room id> [--dir=<folder with myapp.db>] [--apply] [--with-user-history]
//                                  [--backup-dir=<dir>] [--json]
//
// Made for the pad whose id is literally "Camfrog" (a Camfrog room of that name Pepe bridged on 2026-10-09/10; the user's call:
// remove it, its chat logs and its mic-ups). This is the SITE half; Pepe's files on the VM (chat logs, transcripts,
// recordings) are tools/remove_room_files.py in camfrog-bot.
//
// It scans EVERY table and column for the id (exact values, "room:<id>" / "pad:<id>" / "pepe:<id>" forms, and the id as a JSON
// string), then sorts each hit into:
//   delete     rows that only describe the pad / its room: the registry row, its events, activity, room stats, Pepe's per-room
//              settings, chat-economy telemetry (econ_participation, Pepe's own econ_watch rows), feed_seen pad:<id>, slug
//              aliases, connections, rooms_kv seeded:<id>; CL2: the room's chat archive (chat_log by its rk - never value-scanned -,
//              chatlog_rooms, chatlog_open) and the pad's chat settings (pad_chat_cfg); a legal hold on the archive BLOCKS (the
//              room's, or a person's whose lines are in it)
//   edit      JSON settings that carry the pad as a key (feed_kv aigen_prices rooms.<id>) - the key is removed
//   user       a real person's history ON the pad (stage slots / stage events / go-live log / their watch rows / follows):
//              kept unless --with-user-history
//   keep       history that must stay (pepe_actions = the website action audit, econ_docs = archived economy documents,
//              camfrog_userstats = per-user analytics where the room is one key among many, pepe_rooms_state = Pepe's live list)
//   BLOCK      anything else, and ANY PAT: a pad vault (pools room:<id>) or vault row with a balance, ledger rows. --apply refuses
//              while there is a BLOCK.
// --apply takes a VACUUM INTO backup first and runs every change in one dbUtils.tx. Idempotent: a second run finds nothing.
"use strict";
const fs = require("fs");
const path = require("path");

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const ID = String(args.id || "");
if (!ID || !/^[A-Za-z0-9][A-Za-z0-9._:~\-]{0,127}$/.test(ID)) { console.error("--id=<pad id> is required"); process.exit(2); }
const appDir = path.resolve(__dirname, "..");
if (args.dir) process.chdir(path.resolve(String(args.dir)));
if (!fs.existsSync(path.join(process.cwd(), "myapp.db"))) { console.error(`no myapp.db in ${process.cwd()}`); process.exit(2); }
const { runQuery, getQuery, tx } = require(path.join(appDir, "dbUtils"));
const apply = !!args.apply;
const q = (n) => '"' + String(n).replace(/"/g, '""') + '"';

// table -> how its hits are handled. where: the exact condition that selects the pad's rows.
const PLAN = {
  rooms_registry: { as: "delete", where: "room_id = ?" },
  room_events: { as: "delete", where: "room_id = ?" },
  room_activity: { as: "delete", where: "room_id = ?" },
  camfrog_roomstats: { as: "delete", where: "room_id = ?" },
  camfrog_roomstats_meta: { as: "delete", where: "room_id = ?" },
  room_pepe_settings: { as: "delete", where: "room_id = ?" },
  econ_participation: { as: "delete", where: "room_id = ?" },
  econ_watch: { as: "delete", where: "room_id = ? AND stream = 'pepe:' || ?", n: 2 },
  econ_watch_keys: { as: "delete", where: "stream = 'pepe:' || ?" },
  feed_seen: { as: "delete", where: "scope = 'pad:' || ?" },
  pad_slug_aliases: { as: "delete", where: "room_id = ?" },
  pad_connections: { as: "delete", where: "room_id = ?" },
  pad_access: { as: "delete", where: "room_id = ?" },
  pad_members: { as: "delete", where: "room_id = ?" },
  rooms_kv: { as: "delete", where: "key = 'seeded:' || ?" },
  bridge_rooms: { as: "delete", where: "id = ?" },
  bridge_feed: { as: "delete", where: "room_id = ?" },                  // CL2: the column is room_id (`room` matched nothing, silently)
  bridge_cmd_log: { as: "delete", where: "room = ?" },
  // CL2: the pad chat archive (chatlog.js). chat_log has no room column (rk -> chatlog_rooms), so its rows are planned
  // explicitly (ALWAYS below) and deleted before chatlog_rooms; the FTS index follows by trigger. A legal hold blocks.
  chat_log: { as: "delete", where: "rk IN (SELECT rk FROM chatlog_rooms WHERE room_id = ?)" },
  chatlog_open: { as: "delete", where: "rk IN (SELECT rk FROM chatlog_rooms WHERE room_id = ?)" },
  chatlog_rooms: { as: "delete", where: "room_id = ?" },
  pad_chat_cfg: { as: "delete", where: "room_id = ?" },
  chatlog_reports: { as: "keep" }, chatlog_views: { as: "keep" }, chatlog_exports: { as: "keep" },
  stage_slots: { as: "user", where: "room_id = ?" },
  stage_events: { as: "user", where: "room_id = ?" },
  golive_log: { as: "user", where: "room_id = ?" },
  follows: { as: "user", where: "target_kind = 'room' AND target_id = ?" },
  pepe_actions: { as: "keep" }, econ_docs: { as: "keep" }, camfrog_userstats: { as: "keep" }, pepe_rooms_state: { as: "keep" },
  pepe_control_status: { as: "keep" }, content_audit: { as: "keep" }, casino_tables: { as: "keep" }, premium_config: { as: "keep" },
  feed_kv: { as: "edit" },
};

// CL2: planned even when the value scan doesn't see them (chat_log is never value-scanned: millions of rows, and its rows name
// the room by rk). Deleted before chatlog_rooms, whose rk they use.
const ALWAYS = ["chat_log", "chatlog_open"];
const SCAN_SKIP = (name) => name === "chat_log" || name.startsWith("chat_log_fts");

async function scan() {
  const hits = [];
  for (const { name } of await getQuery("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")) {
    if (SCAN_SKIP(name)) continue;
    for (const c of await getQuery(`PRAGMA table_info(${q(name)})`)) {
      const col = q(c.name);
      const r = await getQuery(`SELECT COUNT(*) AS n FROM ${q(name)} WHERE ${col} = ? OR ${col} = ? OR ${col} = ? OR ${col} = ? OR instr(${col}, ?) > 0`,
                               [ID, "room:" + ID, "pad:" + ID, "pepe:" + ID, JSON.stringify(ID)]).catch(() => [{ n: 0 }]);
      if (r[0].n) hits.push({ table: name, column: c.name, n: r[0].n });
    }
  }
  return hits;
}

async function survey() {
  const hits = await scan();
  const tables = [...new Set(hits.map((h) => h.table))];
  const out = { delete: [], user: [], edit: [], keep: [], block: [] };
  // PAT first: a vault / pool / ledger row for this pad stops everything
  for (const [t, sql] of [["pools", "SELECT key, balance FROM pools WHERE key = 'room:' || ? AND balance != 0"],
                          ["room_vaults", "SELECT * FROM room_vaults WHERE room_id = ?"]]) {
    const rows = await getQuery(sql, [ID]).catch(() => []);
    if (rows.length) out.block.push({ table: t, why: "PAT held for this pad", rows });
  }
  // CL2: a legal hold on the room's chat archive (chatlog_holds 'room:<rk>') stops everything too
  const holds = await getQuery("SELECT h.key FROM chatlog_holds h JOIN chatlog_rooms r ON h.key = 'room:' || r.rk WHERE r.room_id = ?", [ID]).catch(() => []);
  if (holds.length) out.block.push({ table: "chatlog_holds", why: "a legal hold on this room's chat archive" });
  // CL2 fix-up: ...and so does a per-person hold ("who:<login or u:id>", CL6) on anyone whose lines are in it - purged lines too
  // (their speaker is "h:" + the login's hash)
  const whoKeys = (await getQuery("SELECT key FROM chatlog_holds WHERE key LIKE 'who:%'").catch(() => [])).map((r) => String(r.key).slice(4).trim().toLowerCase()).filter(Boolean);
  if (whoKeys.length) {
    const hashOf = require(path.join(appDir, "chatlog")).hash;
    const forms = [...new Set(whoKeys.reduce((a, k) => a.concat([k, "h:" + hashOf(k)]), []))];
    let hit = 0;
    for (let i = 0; i < forms.length && !hit; i += 400) {
      const part = forms.slice(i, i + 400);
      hit = Number((await getQuery(`SELECT COUNT(*) AS n FROM chat_log l JOIN chatlog_rooms r ON r.rk = l.rk WHERE r.room_id = ? AND l.who IN (${part.map(() => "?").join(",")})`,
                                   [ID, ...part]).catch(() => [{ n: 0 }]))[0].n) || 0;
    }
    if (hit) out.block.push({ table: "chatlog_holds", why: "a legal hold on a person whose lines are in this room's chat archive" });
  }
  for (const t of ALWAYS) {
    if (tables.includes(t)) continue;
    const n = (await getQuery(`SELECT COUNT(*) AS n FROM ${q(t)} WHERE ${PLAN[t].where}`, [ID]).catch(() => [{ n: 0 }]))[0].n;
    if (n) out.delete.push({ table: t, where: PLAN[t].where, rows: n });
  }
  for (const t of tables) {
    const p = PLAN[t];
    if (!p) { out.block.push({ table: t, why: "not in the plan - look at it first", columns: hits.filter((h) => h.table === t) }); continue; }
    if (p.as === "keep") { out.keep.push({ table: t, columns: hits.filter((h) => h.table === t) }); continue; }
    if (p.as === "edit") {
      for (const r of await getQuery("SELECT key, value FROM feed_kv WHERE instr(value, ?) > 0", [JSON.stringify(ID)])) {
        let v;
        try { v = JSON.parse(r.value); } catch (e) { v = null; }
        if (v && v.rooms && Object.prototype.hasOwnProperty.call(v.rooms, ID)) out.edit.push({ table: t, key: r.key, path: `rooms.${ID}` });
        else out.block.push({ table: t, key: r.key, why: "mentions the pad in a shape this tool doesn't know" });
      }
      continue;
    }
    const params = p.n === 2 ? [ID, ID] : [ID];
    const n = (await getQuery(`SELECT COUNT(*) AS n FROM ${q(t)} WHERE ${p.where}`, params).catch(() => [{ n: 0 }]))[0].n;
    const total = hits.filter((h) => h.table === t).reduce((a, h) => Math.max(a, h.n), 0);
    const row = { table: t, where: p.where, rows: n };
    if (n < total) row.note = `${total - n} other row(s) mention it (kept: not the pad's own rows)`;
    if (p.as === "user") {
      row.sample = await getQuery(`SELECT * FROM ${q(t)} WHERE ${p.where} LIMIT 3`, params).catch(() => []);
      out.user.push(row);
    } else if (n) out.delete.push(row);
  }
  // the econ_watch rows of real viewers / stage slots on this pad are user history
  const slotWatch = await getQuery("SELECT COUNT(*) AS n FROM econ_watch WHERE room_id = ? AND stream != 'pepe:' || ?", [ID, ID]).catch(() => [{ n: 0 }]);
  if (slotWatch[0].n) out.user.push({ table: "econ_watch", where: "room_id = ? AND stream != 'pepe:' || ? (stage-slot watch rows)", rows: slotWatch[0].n, n2: true });
  // CL2: rows found through chatlog_rooms go before chatlog_rooms itself
  const viaRooms = (x) => /FROM chatlog_rooms/.test(x.where);
  out.delete.sort((a, b) => Number(viaRooms(b)) - Number(viaRooms(a)));
  return out;
}

async function backup(dir) {
  const d = path.resolve(String(dir || "db-backups"));
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, `myapp-pre-removepad-${ID.replace(/[^A-Za-z0-9_-]/g, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  await runQuery(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return file;
}

(async () => {
  try { await require(path.join(appDir, "chatlog")).attach(); } catch (e) { console.error("chat archive (CHATLOG_DB) not attached:", e.message); }   // CL2
  const s = await survey();
  const summary = { id: ID, delete: s.delete.map((x) => `${x.table}: ${x.rows}`), edit: s.edit.map((x) => `${x.table} ${x.key}: drop ${x.path}`),
                    user_history: s.user.map((x) => `${x.table}: ${x.rows}${args["with-user-history"] ? " (deleted: --with-user-history)" : " (kept)"}`),
                    keep: s.keep.map((x) => `${x.table} (${x.columns.map((c) => c.column + " " + c.n).join(", ")})`),
                    block: s.block };
  console.log(JSON.stringify(args.json ? { summary, detail: s } : summary, null, 1));
  if (!apply) { console.log("dry run - nothing written (add --apply)"); return; }
  if (s.block.length) { console.error("REFUSED: blocking references above - nothing written"); process.exitCode = 3; return; }
  const file = await backup(args["backup-dir"]);
  console.log(`backup: ${file}`);
  const done = {};
  await tx(async () => {
    const run = async (t, where, params) => { const r = await runQuery(`DELETE FROM ${q(t)} WHERE ${where}`, params); done[t] = (done[t] || 0) + ((r && r.changes) || 0); };
    for (const x of s.delete) await run(x.table, x.where, PLAN[x.table].n === 2 ? [ID, ID] : [ID]);
    if (args["with-user-history"]) {
      for (const x of s.user) {
        if (x.n2) await run("econ_watch", "room_id = ? AND stream != 'pepe:' || ?", [ID, ID]);
        else await run(x.table, PLAN[x.table].where, [ID]);
      }
    }
    for (const x of s.edit) {
      const r = (await getQuery("SELECT value FROM feed_kv WHERE key = ?", [x.key]))[0];
      const v = JSON.parse(r.value);
      delete v.rooms[ID];
      await runQuery("UPDATE feed_kv SET value = ? WHERE key = ?", [JSON.stringify(v), x.key]);
      done["feed_kv." + x.key] = 1;
    }
  });
  console.log("applied:", JSON.stringify(done));
})().then(() => process.exit(process.exitCode || 0), (e) => { console.error(e); process.exit(1); });
