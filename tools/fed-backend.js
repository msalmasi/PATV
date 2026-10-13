#!/usr/bin/env node
// tools/fed-backend.js — P4-1: the Fed events backend switch (fed/service.js) from the server's shell.
// Run in the site directory (it opens ./myapp.db). See docs/fed-events-cutover-runbook.md for the hand-over and the way back.
//   node tools/fed-backend.js                          # status: switch, live, the journal's totals + sha256, the month's mints
//   node tools/fed-backend.js --actor=<who> on         # allow Pepe to hand the Fed's books over (`!econ fed backend on`)
//   node tools/fed-backend.js --actor=<who> off        # refuse new imports (never takes anything away from a live site:
//                                                      #   the way back is `!econ fed backend off` in Camfrog)
// Read-only by default; `on` / `off` write ONE fed_meta row (on prod only with the user's explicit go).
"use strict";
const path = require("path");
const F = require(path.join(__dirname, "..", "fed", "service"));
(async () => {
  await F.init();
  const actor = (process.argv.find((a) => a.startsWith("--actor=")) || "").slice(8);
  const [cmd] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (cmd === "on" || cmd === "off") {
    if (!actor) throw new Error("say who is changing it: --actor=<name>");
    if (await F.live()) throw new Error("the site owns the Fed's books now - roll back from Pepe instead");
    await F.setMeta("enabled", cmd === "on");
    await F.setMeta("enabled_by", { by: actor + " (cli)", at: Date.now(), on: cmd === "on" });
    console.log(`fed events backend ${cmd === "on" ? "enabled" : "disabled"} by ${actor}`);
  } else if (cmd) {
    throw new Error("usage: node tools/fed-backend.js [--actor=<who> on|off]");
  }
  const st = await F.exportState();
  console.log(`fed      enabled=${st.enabled}${process.env.STAGING ? " (staging default: on)" : ""} live=${st.live}`);
  console.log(`journal  ${JSON.stringify(st.totals)}  sha256 ${st.digest}`);
  console.log(`imported ${st.imported ? JSON.stringify(st.imported) : "never"}`);
  if (st.live) {
    const s = await F.botState();
    console.log(`month    ${JSON.stringify(s.mtd)}  Fed ${s.fed}  loans outstanding ${s.outstanding}`);
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
