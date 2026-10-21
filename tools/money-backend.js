#!/usr/bin/env node
// tools/money-backend.js — PO-0b (economy policy -> site plan, D-6): the pools / stashes / capital / gangs backend switches
// from the server's shell. Since PO-0b the web switches (/api/admin/{pools,stash,capital,gangs}-backend) are a Pepe owner's;
// this is the emergency path the plan keeps for them, like tools/escrow-backend.js (escrow) and tools/fed-backend.js (Fed).
// Run in the site directory (it opens ./myapp.db), or pass --dir=<folder with myapp.db>.
//   node tools/money-backend.js [status] [--dir=<folder>]                    # every switch: enabled (or the default) / live
//   node tools/money-backend.js --actor=<who> <feature> on|off [--dir=...]   # allow / refuse Pepe's hand-over of that feature
//     feature: pools | stashes | capital | gangs
// A switch only says whether Pepe MAY hand the feature over; once the site owns it (live) it is refused here as on the
// web - the way back is that feature's rollback from Pepe (docs/<feature>-cutover-runbook.md).
// Read-only by default (status only SELECTs); `on` / `off` write ONE <feature>_meta row + who did it (on prod only with
// the owner's explicit go), the admin_audit row "backend_switch" (via cli) and, for the stashes, the wish /admin/backends shows.
// The review of the owner answers 2026-10-20: it never opens a database that isn't there (tools/sitedb.js) - from the wrong
// directory it used to create an empty ./myapp.db, write the switch into it and report success while the site never saw it.
"use strict";
const path = require("path");
const db = () => require(path.join(__dirname, "..", "dbUtils"));      // loaded only after siteDb() checked the directory

const FEATURES = {
  pools: { mod: "pools", table: "pools_meta", live: "live" },
  stashes: { mod: "stashes", table: "stash_meta", live: "imported", backend: "stashes" },
  capital: { mod: path.join("capital", "core"), table: "capital_meta", live: "live" },
  gangs: { mod: "gangs", table: "gangs_meta", live: "live" },
};
const parse = (s) => { if (s == null) return null; try { return JSON.parse(s); } catch (e) { return s; } };
async function hasTable(t) {
  return (await db().getQuery("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t])).length > 0;
}
async function metaOf(table, key) {
  if (!(await hasTable(table))) return null;
  const r = (await db().getQuery(`SELECT value FROM ${table} WHERE key = ?`, [key]))[0];
  return r ? parse(r.value) : null;
}
async function status() {
  const out = {};
  for (const [f, x] of Object.entries(FEATURES)) {
    const en = await metaOf(x.table, "enabled");
    out[f] = { enabled: en === true || en === false ? en : null, live: !!(await metaOf(x.table, x.live)), by: await metaOf(x.table, "enabled_by") };
  }
  return out;
}

async function main() {
  const actor = (process.argv.find((a) => a.startsWith("--actor=")) || "").slice(8);
  const words = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const [first, second] = words;
  if (first && first !== "status") {
    const x = FEATURES[first];
    if (!x || !["on", "off"].includes(second)) throw new Error("usage: node tools/money-backend.js [status] | --actor=<who> <pools|stashes|capital|gangs> on|off [--dir=<folder with myapp.db>]");
    if (!actor) throw new Error("say who is changing it: --actor=<name>");
  }
  require("./sitedb").siteDb();                                         // exits 2 (nothing opened) without ./myapp.db
  if (first && first !== "status") {
    const x = FEATURES[first];
    const M = require(path.join(__dirname, "..", x.mod));
    await M.init();
    if (await M.live()) {
      throw new Error(first === "stashes" ? "the site owns the stashes now (the import is for good - nothing to switch)"
                                          : `the site owns ${first} now - roll back from Pepe instead (docs/${first}-cutover-runbook.md)`);
    }
    const on = second === "on";
    const before = await metaOf(x.table, "enabled");
    const put = (key, v) => db().runQuery(`INSERT INTO ${x.table} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, JSON.stringify(v)]);
    await put("enabled", on);
    await put("enabled_by", { by: actor + " (cli)", at: Date.now(), on });
    // the same trail as the web switches: the wish (/admin/backends' stashes row) and the audit row
    if (x.backend) await require(path.join(__dirname, "..", "backends")).noteCli(x.backend, on, actor);
    await require("./sitedb").cliAudit(actor, { feature: first, want: on, was: before === true || before === false ? before : null, live: false, tool: "money-backend" });
    console.log(`${first} backend ${on ? "enabled" : "disabled"} by ${actor}`);
  }
  const st = await status();
  if (process.argv.includes("--json")) { console.log(JSON.stringify(st, null, 2)); return; }
  for (const [f, v] of Object.entries(st)) {
    console.log(`${f.padEnd(8)} enabled=${v.enabled === null ? `default (${process.env.STAGING ? "on: staging" : "off"})` : v.enabled} live=${v.live}`
      + (v.by ? `  last switched by ${v.by.by || "?"} ${v.by.at ? new Date(Number(v.by.at)).toISOString().slice(0, 16) : ""}` : ""));
  }
}

if (require.main === module) main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { status, FEATURES };
