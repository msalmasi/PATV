// migrate-displaynames.js - 1.99az: fill every missing / random-CF display name (see displaynames.js).
// Dry run by default; --apply writes, in one transaction. Idempotent. Run from the app directory:
//   node migrate-displaynames.js            (dry run: counts by source + a sample)
//   node migrate-displaynames.js --apply
// Camfrog display names arrive later from Pepe (/api/users/camfrog/displaynames), which upgrades the
// automatic names this sets; user-chosen names are never touched by either.
"use strict";
const displaynames = require("./displaynames");

(async () => {
  const apply = process.argv.includes("--apply");
  const n = Number((process.argv.find((a) => a.startsWith("--sample=")) || "--sample=15").split("=")[1]) || 15;
  const { changes, bySource, unresolved } = await displaynames.backfill({ dryRun: !apply });
  console.log(`${apply ? "APPLIED" : "DRY RUN"}: ${changes.length} display names ${apply ? "set" : "to set"}`);
  console.log("by source:", JSON.stringify(bySource));
  console.log(`unresolved (only a random CF name known, left as is): ${unresolved.length}${unresolved.length ? " - " + unresolved.slice(0, 20).join(", ") : ""}`);
  for (const c of changes.slice(0, n)) {
    console.log(`  ${c.username}: ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)} (${c.source})`);
  }
  process.exit(0);
})().catch((e) => { console.error("failed:", e.message); process.exit(1); });
