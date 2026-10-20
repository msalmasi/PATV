#!/usr/bin/env node
// tools/staking-backfill.js — the staking fix plan's one-time fixes (2026-10-19; capital/backfill.js). Run in the site directory
// (it opens ./myapp.db), outside the 10 minutes around the 04:00 UTC cut-off. Nothing moves PAT.
//
//   node tools/staking-backfill.js cost                          DRY RUN: what /staking's cost history would get
//   node tools/staking-backfill.js cost --apply --key=<key>      a verified DB backup, then ONE transaction; recorded - a second
//                                                                run prints the stored result. PROD: RUN BEFORE 2026-11-04 (the
//                                                                vault queue drops a request 30 days after it ran).
//                                                                Rows it can't fully explain stay "partial" (/staking shows "—").
//   node tools/staking-backfill.js earned [--before=<ISO time>] [--apply --key=<key>]
//                                                                (optional) stashes.earned += past staking payouts / corrections.
//                                                                If Pepe d366b94 was deployed BEFORE this site version, an apply
//                                                                needs --before=<the time that Pepe started> (it refuses without).
//   node tools/staking-backfill.js cushion [--days=<n>] [--apply --key=<key>]
//                                                                (optional) seed the protocol cushion from the skims made before it
//                                                                started recording (only needed if it ships late; see the plan)
//   node tools/staking-backfill.js status                        what was applied, when, with which key and backup
"use strict";
const path = require("path");
const B = require(path.join(__dirname, "..", "capital", "backfill"));

const opt = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const fmt = (n) => Math.trunc(Number(n || 0)).toLocaleString("en-US");
const what = process.argv[2];
const apply = process.argv.includes("--apply");
const key = opt("key");

(async () => {
  if (what === "status") {
    const C = require(path.join(__dirname, "..", "capital", "core"));
    await C.init();
    for (const w of ["cost", "earned", "cushion"]) {
      const m = await C.meta(`backfill:${w}`);
      console.log(`${w}: ${m ? `applied as ${m.key} at ${new Date(m.at).toISOString()} (backup ${m.backup}) ${JSON.stringify(m.result).slice(0, 400)}` : "not applied"}`);
    }
    return;
  }
  let r;
  if (what === "cost") r = await B.cost({ key, apply });
  else if (what === "earned") {
    const before = opt("before") ? Date.parse(opt("before")) : null;
    if (opt("before") && !Number.isFinite(before)) throw new Error("--before must be a date / time (ISO)");
    r = await B.earned({ key, apply, before });
  } else if (what === "cushion") r = await B.cushion({ key, apply, days: opt("days") == null ? null : Number(opt("days")) });
  else throw new Error("usage: node tools/staking-backfill.js cost|earned|cushion [--apply --key=<key>] | status");
  if (r.already) {
    console.log(`ALREADY APPLIED as ${r.key} at ${new Date(r.at).toISOString()} - nothing changed now (backup then: ${r.backup})`);
    console.log(JSON.stringify(r.result, null, 1).slice(0, 4000));
    return;
  }
  console.log(`${apply ? `APPLIED ${what} as ${key}` : `DRY RUN ${what} (nothing changed)`}${r.backup ? ` - backup ${r.backup}` : ""}`);
  if (what === "cost") {
    console.log(`requests counted: ${r.items} from ${r.stashes} stash(es): in ${fmt(r.in)} PAT, out ${fmt(r.out)} PAT`);
    console.log(r.whole ? "the queue still holds every request since the first cut-off"
                        : "WARNING: requests older than 30 days are already gone from the queue - rows they belong to stay partial");
    console.log(`partial rows (Staked / P/L shown as "—"): ${(r.partial || []).length}${(r.partial || []).length ? " - " + r.partial.slice(0, 30).map((x) => x.join("/")).join(", ") : ""}`);
    for (const [s, x] of Object.entries(r.per_stash || {})) {
      console.log(`  stash ${s}: ${Object.entries(x).map(([v, c]) => `${v} in ${fmt(c.in)} out ${fmt(c.out)}${c.partial ? " (partial)" : ""}`).join(" · ")}`);
    }
  } else if (what === "earned") {
    console.log(`deploy order: ${r.order}${r.before ? ` - counting only moves before ${new Date(r.before).toISOString()}` : ""}`);
    if (r.warning) console.log(`WARNING: ${r.warning}`);
    console.log(`moves: ${r.moves} (${r.skipped} already counted), ${fmt(r.total)} PAT`);
    for (const [s, a] of Object.entries(r.stashes || {})) console.log(`  stash ${s}: +${fmt(a)} earned`);
  } else {
    console.log(`window: ${r.days} days; each cut-off replayed by the ceiling its snapshot recorded, ${r.ceil} for one that didn't`);
    for (const [v, x] of Object.entries(r.vaults || {})) {
      console.log(`  ${v}: ${x.skipped ? `SKIPPED - ${x.skipped}` : `${x.added.length} skim(s), ${(x.added.reduce((a, e) => a + e[1], 0)).toFixed(2)} shares (~${fmt(x.pat)} PAT)`}`);
      for (const [ts, sh] of x.added) console.log(`     ${new Date(ts * 1000).toISOString().slice(0, 16)} ${sh.toFixed(4)} shares`);
    }
  }
  if (!apply) console.log("dry run - add --apply --key=<key> to write it");
})().then(() => process.exit(0), (e) => { console.error(`REFUSED: ${e.message}`); process.exit(1); });
