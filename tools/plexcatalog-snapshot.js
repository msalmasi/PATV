#!/usr/bin/env node
// A reviewed catalog snapshot for staging without mediactl. No real media paths or denied rows are exported.
"use strict";
const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3");
const { createCatalog } = require("../plexcatalog");

// Read only the current rating policy when this cache sits beside its site's DB. Never import dbUtils:
// that module creates tables and starts shared state connections. A detached staging snapshot uses defaults.
async function blockedRatings(file) {
  if (!fs.existsSync(file)) return "X,XXX,AO,R18,R18+";
  const db = await new Promise((resolve, reject) => {
    const d = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (e) => e ? reject(e) : resolve(d));
  });
  try {
    const row = await new Promise((resolve, reject) => db.get("SELECT value FROM media_settings WHERE key='clerk_block_ratings'", (e, r) => e ? reject(e) : resolve(r)));
    if (!row) return "X,XXX,AO,R18,R18+";
    const value = JSON.parse(row.value);
    if (typeof value !== "string") throw new Error("Invalid rating policy.");
    return value;
  } finally { await new Promise((resolve) => db.close(() => resolve())); }
}

async function main(argv = process.argv.slice(2)) {
  const [action, file, snapshot, flag, settingsFile] = argv;
  if (!["import", "export"].includes(action) || !file || !snapshot || !(argv.length === 3 || (argv.length === 5 && flag === "--settings-db"))) {
    throw new Error("Usage: node tools/plexcatalog-snapshot.js import|export <catalog.db> <snapshot.json> [--settings-db <myapp.db>]");
  }
  if (action === "export" && !fs.existsSync(path.resolve(file))) throw new Error("Catalog file does not exist.");
  if (settingsFile && !fs.existsSync(path.resolve(settingsFile))) throw new Error("Settings database does not exist.");
  const blocked = await blockedRatings(path.resolve(settingsFile || path.join(path.dirname(path.resolve(file)), "myapp.db")));
  const catalog = createCatalog({ file, readOnly: action === "export", settings: () => ({ clerk_block_ratings: blocked }) });
  try {
    if (action === "export") {
      const data = await catalog.exportSnapshot();
      fs.writeFileSync(path.resolve(snapshot), JSON.stringify(data, null, 2) + "\n", { flag: "wx" });
      console.log("Exported " + data.rows.length + " allowed rows.");
    } else {
      const data = JSON.parse(fs.readFileSync(path.resolve(snapshot), "utf8"));
      const result = await catalog.importSnapshot(data);
      console.log("Imported " + result.kept + " allowed rows; dropped " + result.dropped + " invalid or denied rows.");
    }
  } finally { await catalog.close(); }
}
if (require.main === module) main().catch(() => { console.error("Catalog snapshot failed. Check the command, reviewed allow-list and files."); process.exitCode = 1; });
module.exports = { main, blockedRatings };
