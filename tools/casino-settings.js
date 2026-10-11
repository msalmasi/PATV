#!/usr/bin/env node
// tools/casino-settings.js — 1.99lj: read / change the casino backend's switches (casino/service.js, casino_settings) from the
// server's shell. Run in the site directory (it opens ./myapp.db). The running site picks a change up within 10 s.
//   node tools/casino-settings.js                                   # print the settings + open tables
//   node tools/casino-settings.js --actor=<who> bj_enabled=1        # blackjack on the site on (0 = off: no NEW tables)
//   node tools/casino-settings.js --actor=<who> hm_enabled=1        # 1.99lv: Hold'em on the site (0 = off: no NEW tables)
//   node tools/casino-settings.js --actor=<who> max_tables=0        # 0 = no site-wide limit (the default; one table per room always)
"use strict";
const path = require("path");
const svc = require(path.join(__dirname, "..", "casino", "service"));
const { getQuery } = require(path.join(__dirname, "..", "dbUtils"));
(async () => {
  await svc.ensure();
  const actor = (process.argv.find((a) => a.startsWith("--actor=")) || "").slice(8);
  const pairs = process.argv.slice(2).filter((a) => !a.startsWith("--") && a.includes("="));
  if (pairs.length && !actor) throw new Error("say who is changing it: --actor=<name>");
  for (const p of pairs) {
    const i = p.indexOf("=");
    await svc.setSetting(p.slice(0, i), p.slice(i + 1), actor + " (cli)");
    console.log(`set ${p.slice(0, i)} = ${p.slice(i + 1)}`);
  }
  const st = await svc.loadSettings(true);
  console.log(`bj_enabled = ${st.bj_enabled}${process.env.STAGING ? " (staging default: on)" : ""}`);
  console.log(`hm_enabled = ${st.hm_enabled}`);
  console.log(`max_tables = ${st.max_tables || "no limit"}`);
  const open = await getQuery("SELECT id, room, rev, updated FROM casino_tables WHERE status = 'open'");
  console.log(`open tables: ${open.length}` + open.map((t) => `\n  ${t.id} room=${t.room || "web"} rev=${t.rev} updated=${new Date(t.updated).toISOString()}`).join(""));
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
