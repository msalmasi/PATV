#!/usr/bin/env node
// tools/stash-rekey.js — 1.99wy: stashes belong to PATV ACCOUNTS, not chat logins (stashes.js). The one-off that moves the
// rows the 1.99ne hand-over imported as Pepe had them (owner / members = Camfrog logins) to account keys "u:<userId>".
// Run in the site directory (it opens ./myapp.db).
//
//   node tools/stash-rekey.js --key=<key>            DRY RUN: the exact changes + every check, then rolled back
//   node tools/stash-rekey.js --key=<key> --apply    a verified DB backup, then ONE transaction: the re-key + the checks
//                                                    (refused and rolled back unless all are exactly equal)
//   node tools/stash-rekey.js --status               the stored results of past runs
//
// Mapping (stashes.targetKey): a login -> the account linked to it NOW (the link; never the login history - 1.99tj); a
// "u:<id>" -> the live account (merges followed); a login no account has linked stays as it is until one links it
// (loginrekey.changed -> stashes.claimLogin). A member who is the owner's own account is dropped.
// Checks (before == after, in the same transaction): every stash's balance / stake lock / earned / name / dates, the
// totals, the stash move journal, the vault book (shares per stash "s<id>" - untouched), every vault's NAV and share price,
// and the total PAT supply. The key makes it idempotent: the same key again prints the stored result and changes nothing.
"use strict";
const path = require("path");
const S = require(path.join(__dirname, "..", "stashes"));

const opt = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const fmt = (n) => Number(n || 0).toLocaleString("en-US");

(async () => {
  await S.init();
  if (process.argv.includes("--status")) {
    const { getQuery } = require(path.join(__dirname, "..", "dbUtils"));
    const rows = await getQuery("SELECT key, value FROM stash_meta WHERE key LIKE 'rekey:%' OR key = 'acct_keyed' ORDER BY key");
    if (!rows.length) console.log("no stash re-key has been applied");
    for (const r of rows) console.log(`${r.key}: ${r.value.slice(0, 600)}`);
    return;
  }
  const key = opt("key");
  if (!key) throw new Error("usage: node tools/stash-rekey.js --key=<key> [--apply] | --status");
  const apply = process.argv.includes("--apply");
  const r = await S.rekeyAll({ key, apply });
  if (r.already) {
    console.log(`ALREADY APPLIED as ${key} at ${new Date(r.at).toISOString()} - nothing changed now`);
  } else {
    console.log(`${apply ? "APPLIED" : "DRY RUN (rolled back)"} ${key}${r.backup ? ` - backup ${r.backup}` : ""}`);
  }
  const c = r.changes || { owners: [], members: [], kept: [] };
  console.log(`owners re-keyed: ${c.owners.length}`);
  for (const x of c.owners) console.log(`  stash ${x.stash}: ${x.from} -> ${x.to} (${x.why})`);
  console.log(`member rows changed: ${c.members.length}`);
  for (const x of c.members) console.log(`  stash ${x.stash}: ${x.from} -> ${x.to || "(dropped)"} (${x.why})`);
  console.log(`kept as a chat login (no account has linked it): ${c.kept.length}`);
  for (const x of c.kept) console.log(`  stash ${x.stash} ${x.role}: ${x.key} (${x.why})`);
  const t = r.totals || {};
  console.log(`checks: ${Object.entries(r.checks || {}).map(([k, v]) => `${k}=${v ? "equal" : "DIFFERENT"}`).join(", ")}`);
  console.log(`stashes: ${t.count} (${t.open} open) holding ${fmt(t.total)} PAT, ${fmt(t.staked)} staked; supply ${fmt(t.supply)}; facts sha256 ${t.digest}`);
  if (r.vaults && r.vaults.nav) {
    console.log(`vaults: book sha256 ${r.vaults.book}; NAV ${Object.entries(r.vaults.nav).map(([v, n]) => `${v} ${n}`).join(", ")}; ` +
                `prices ${Object.entries(r.vaults.prices).map(([v, p]) => `${v} ${p}`).join(", ")}`);
  }
  if (!apply && !r.already) console.log("dry run - nothing changed (add --apply)");
})().then(() => process.exit(0), (e) => { console.error(`REFUSED: ${e.message}`); process.exit(1); });
