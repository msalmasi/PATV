// Helper for the account-merge tests (not a test itself): the database schema the merge must cover.
//   schemaSql()          test/fixtures/schema.sql (a staging .schema dump: every table that exists in a real database)
//   scanSource(repo)     every CREATE TABLE / ALTER TABLE ... ADD COLUMN in the repo's server code, so a table or
//                        column added AFTER the snapshot is still seen: Map table -> {columns: Set, creates: [sql]}
//   columnUniverse(repo) {table: Set(columns)} from both
"use strict";
const fs = require("fs");
const path = require("path");

const SKIP_DIRS = new Set(["node_modules", "public", "test", ".git", "camfrog-bot", "uploads", "data", "backups"]);

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.js$/.test(e.name) && !/\.min\.js$/.test(e.name)) out.push(p);
  }
  return out;
}

function splitTop(body) {
  const parts = []; let depth = 0, cur = "";
  for (const c of body) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += c;
  }
  parts.push(cur);
  return parts;
}

function scanSource(repo) {
  const tables = new Map();
  const T = (t) => { if (!tables.has(t)) tables.set(t, { columns: new Set(), creates: [] }); return tables.get(t); };
  for (const f of walk(repo)) {
    const src = fs.readFileSync(f, "utf8");
    const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?\s*\(/gi;
    let m;
    while ((m = re.exec(src))) {
      let i = re.lastIndex, depth = 1;
      while (i < src.length && depth > 0) { const c = src[i]; if (c === "(") depth++; else if (c === ")") depth--; i++; }
      const body = src.slice(re.lastIndex, i - 1);
      const t = T(m[1]);
      if (!body.includes("${")) t.creates.push(`CREATE TABLE IF NOT EXISTS ${m[1]} (${body})`);
      for (let p of splitTop(body)) {
        p = p.replace(/\/\/[^\n]*/g, "").replace(/--[^\n]*/g, "").trim();
        if (!p || /^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i.test(p) || p.startsWith("$")) continue;
        const c = p.match(/^["`]?([A-Za-z_][A-Za-z0-9_]*)/);
        if (c) t.columns.add(c[1]);
      }
    }
    const ra = /ALTER\s+TABLE\s+["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?\s+ADD\s+(?:COLUMN\s+)?["`]?([A-Za-z_][A-Za-z0-9_]*)/gi;
    while ((m = ra.exec(src))) if (m[2].toUpperCase() !== "COLUMN") T(m[1]).columns.add(m[2]);
  }
  return tables;
}

function schemaSql() {
  return fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
}

/** {table: Set(columns)} of the snapshot (parsed by an in-memory SQLite) + the source scan. */
async function columnUniverse(repo, sqlite3) {
  const db = new sqlite3.Database(":memory:");
  const all = (q, p = []) => new Promise((res, rej) => db.all(q, p, (e, r) => (e ? rej(e) : res(r))));
  await new Promise((res, rej) => db.exec(schemaSql(), (e) => (e ? rej(e) : res())));
  const out = {};
  for (const r of await all("SELECT m.name AS t, p.name AS c FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table'")) {
    (out[r.t] = out[r.t] || new Set()).add(r.c);
  }
  db.close();
  for (const [t, v] of scanSource(repo)) for (const c of v.columns) (out[t] = out[t] || new Set()).add(c);
  return out;
}

module.exports = { scanSource, schemaSql, columnUniverse };
