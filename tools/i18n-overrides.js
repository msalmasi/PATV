#!/usr/bin/env node
// tools/i18n-overrides.js - 1.99kf: make accepted translation suggestions permanent.
//
//   node tools/i18n-overrides.js fold <export.json> [--dry-run]
//       <export.json> = /admin/translations -> "Download the overrides" (or the export below). Each entry whose English
//       is unchanged and that passes i18n-check.js is written into locales/<code>.json and marked human-reviewed in
//       locales/.i18n-state.json, so tools/i18n-sync.js never overwrites it. Then commit + deploy, and press "Clear the
//       ones already in the catalogs" on /admin/translations.
//   node tools/i18n-overrides.js export --db=/home/PATV/myapp.db
//       the same JSON straight from a database (read-only), e.g. over ssh on the VPS.
"use strict";
const fs = require("fs");
const path = require("path");
const C = require("../i18n-check");
const S = require("./i18n-sync");

/** Fold an export into the catalogs of the project at `root`. Returns { written: [lang:key], skipped: [{lang, key, why}] }. */
function fold(root, data, { dryRun = false } = {}) {
  const project = S.loadProject(root);
  const list = data && Array.isArray(data.overrides) ? data.overrides : [];
  const written = [], skipped = [];
  for (const o of list) {
    const { lang, key, value } = o || {};
    const cat = project.cats[lang];
    const en = project.en[key];
    if (!cat) { skipped.push({ lang, key, why: "no catalog for " + lang }); continue; }
    if (en == null) { skipped.push({ lang, key, why: "not an English key any more" }); continue; }
    if (o.src_hash && o.src_hash !== C.hash(en)) { skipped.push({ lang, key, why: "the English changed since it was accepted" }); continue; }
    const problems = C.check(key, en, value);
    if (problems.length) { skipped.push({ lang, key, why: problems.join("; ") }); continue; }
    if (!dryRun) {
      cat.body[key] = value;
      project.dirty.add(lang);
      S.setLocks(project, [{ lang, key }], true);
    }
    written.push(lang + ":" + key);
  }
  if (!dryRun && written.length) S.save(project);
  return { written, skipped };
}

async function exportDb(dbPath) {
  const sqlite3 = require("sqlite3");
  const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
  const rows = await new Promise((res, rej) => db.all("SELECT lang, key, value_json, src_hash, by FROM translation_overrides ORDER BY lang, key", (e, r) => (e ? rej(e) : res(r))));
  db.close();
  return { format: "patv-translation-overrides", version: 1, exported_at: new Date().toISOString(),
           overrides: rows.map((r) => ({ lang: r.lang, key: r.key, value: JSON.parse(r.value_json), src_hash: r.src_hash, by: r.by })) };
}

async function main(argv = process.argv.slice(2)) {
  const [cmd, file] = argv.filter((a) => !a.startsWith("--"));
  const flag = (n) => { const a = argv.find((x) => x === "--" + n || x.startsWith("--" + n + "=")); return a ? (a.includes("=") ? a.split("=").slice(1).join("=") : true) : null; };
  const root = path.resolve(flag("root") || path.join(__dirname, ".."));
  if (cmd === "fold" && file) {
    const r = fold(root, JSON.parse(fs.readFileSync(file, "utf8")), { dryRun: !!flag("dry-run") });
    for (const s of r.skipped) console.log(`skipped ${s.lang}:${s.key} - ${s.why}`);
    console.log(`${flag("dry-run") ? "would fold" : "folded"} ${r.written.length} override(s)${r.written.length ? ": " + r.written.join(", ") : ""}`);
    return 0;
  }
  if (cmd === "export" && flag("db")) {
    process.stdout.write(JSON.stringify(await exportDb(flag("db")), null, 2) + "\n");
    return 0;
  }
  console.log("usage: node tools/i18n-overrides.js fold <export.json> [--dry-run] | export --db=<myapp.db>");
  return 2;
}

if (require.main === module) main().then((c) => { process.exitCode = c; }, (e) => { console.error(e.message); process.exitCode = 1; });

module.exports = { fold, exportDb, main };
