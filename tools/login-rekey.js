#!/usr/bin/env node
// tools/login-rekey.js — 1.99tj: move an account's records off a Camfrog login it no longer has (loginrekey.js). Run in the
// site directory (it opens ./myapp.db). Records follow the ACCOUNT: the old login seen again in chat is a new, empty account.
//   node tools/login-rekey.js --relink=<oldLogin>=<userId> [...]           # DRY RUN: the exact site changes (rolled back)
//   node tools/login-rekey.js --relink=<oldLogin>=<userId> [...] --apply   # DB backup, then per pair ONE transaction: the
//                                                                          #   login_changes row (Pepe re-keys HIS records from it
//                                                                          #   within ~2 min) + the site's own tables re-keyed
//   node tools/login-rekey.js --list [--after=<id>]                        # the recorded changes (Pepe's feed)
// The new key is the account's login today (or u:<userId> when it has none). A pair already recorded is not repeated.
"use strict";
const path = require("path");
const R = require(path.join(__dirname, "..", "loginrekey"));

const opt = (k) => process.argv.filter((a) => a.startsWith(`--${k}=`)).map((a) => a.slice(k.length + 3));
(async () => {
  await R.ensure();
  if (process.argv.includes("--list")) {
    const s = await R.since(Number(opt("after")[0] || 0), 500);
    for (const c of s.changes) console.log(`#${c.id} ${new Date(c.at).toISOString()} ${c.userId}: ${c.old_key} -> ${c.new_key} (${c.via})`);
    console.log(`${s.changes.length} change(s), last #${s.last}`);
    return;
  }
  const pairs = opt("relink");
  if (!pairs.length) throw new Error("usage: node tools/login-rekey.js --relink=<oldLogin>=<userId> [--apply] | --list");
  const apply = process.argv.includes("--apply");
  for (const pr of pairs) {
    const i = pr.lastIndexOf("=");
    const r = await R.relink(pr.slice(0, i), pr.slice(i + 1), { apply });
    if (!r.ok) { console.log(`${pr}: REFUSED - ${r.error}`); continue; }
    if (r.already) { console.log(`${pr}: ${r.note}`); continue; }
    console.log(`${apply ? "APPLIED" : "DRY RUN"} ${r.from} -> ${r.to} for ${r.user.username} (${r.user.userId})${r.id ? ` as change #${r.id}` : ""}${r.backup ? `, backup ${r.backup}` : ""}`);
    if (!r.site.length) console.log("  site: nothing keyed by that login");
    for (const c of r.site) console.log(`  site ${c.table}: ${c.action}${c.key ? ` [${c.key}]` : ""}${c.from ? ` ${c.from} -> ${c.to}` : ""}`);
  }
  if (!apply) console.log("dry run - nothing changed (add --apply)");
})().then(() => process.exit(0), (e) => { console.error(e.message); process.exit(1); });
