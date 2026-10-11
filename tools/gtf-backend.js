#!/usr/bin/env node
// tools/gtf-backend.js — 1.99nq: the GTF backend switch (gtfstore.js) from the server's shell. Run in the site directory
// (it opens ./myapp.db). See docs/gtf-backend.md for the whole hand-over and the way back.
//   node tools/gtf-backend.js                       # status: enabled / live / imported / released + record counts and totals
//   node tools/gtf-backend.js --actor=<who> on      # allow Pepe to hand GTF's data over (he still needs `!gtf backend on`)
//   node tools/gtf-backend.js --actor=<who> off     # refuse new imports (does NOT take data away from a live site:
//                                                   #   the way back is `!gtf backend off` in Camfrog, which releases it)
"use strict";
const path = require("path");
const G = require(path.join(__dirname, "..", "gtfstore"));
const { getQuery } = require(path.join(__dirname, "..", "dbUtils"));
(async () => {
  await G.init();
  const actor = (process.argv.find((a) => a.startsWith("--actor=")) || "").slice(8);
  const cmd = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (cmd === "on" || cmd === "off") {
    if (!actor) throw new Error("say who is changing it: --actor=<name>");
    await G.setMeta("enabled", cmd === "on");
    await G.setMeta("enabled_by", { by: actor + " (cli)", at: Date.now(), on: cmd === "on" });
    console.log(`GTF backend ${cmd === "on" ? "enabled" : "disabled"} by ${actor}`);
  } else if (cmd) {
    throw new Error("usage: node tools/gtf-backend.js [--actor=<who> on|off]");
  }
  const st = await G.status();
  console.log(`enabled  = ${st.enabled}${process.env.STAGING ? " (staging default: on)" : ""}`);
  console.log(`live     = ${st.live}`);
  console.log(`imported = ${st.imported ? JSON.stringify(st.imported) : "never"}`);
  console.log(`released = ${st.released ? JSON.stringify(st.released) : "no"}`);
  console.log(`rev      = ${st.rev}`);
  const n = await getQuery("SELECT kind, SUM(deleted = 0) AS live, SUM(deleted) AS gone FROM gtf_records GROUP BY kind");
  for (const r of n) console.log(`  ${r.kind}: ${r.live} record(s)` + (r.gone ? `, ${r.gone} removed` : ""));
  console.log("totals   = " + JSON.stringify(G.totalsOf(await G.exportObject())));
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
