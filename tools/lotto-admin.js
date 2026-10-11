#!/usr/bin/env node
// tools/lotto-admin.js — 1.99mj: the lotto backend (lotto/service.js) from the server's shell. Run in the site directory (it opens
// ./myapp.db); the running site picks a settings change up within 5 s. docs/lotto-cutover-runbook.md.
//   node tools/lotto-admin.js                                       # status: settings, draws, pot, tickets, totals
//   node tools/lotto-admin.js --actor=<who> lotto_backend=0         # switch (1 = on). price= / pot_share= exist too (the import sets them)
//   node tools/lotto-admin.js totals [draw]                         # the per-player ticket counts (JSON) for the cutover check
//   node tools/lotto-admin.js reset --confirm                       # STAGING ONLY: wipe the backend lotto (refused on prod)
"use strict";
const path = require("path");
const svc = require(path.join(__dirname, "..", "lotto", "service"));
const { getQuery } = require(path.join(__dirname, "..", "dbUtils"));
(async () => {
  await svc.ensure();
  const args = process.argv.slice(2);
  const actor = (args.find((a) => a.startsWith("--actor=")) || "").slice(8);
  if (args[0] === "reset") {
    if (!process.env.STAGING) throw new Error("reset is staging-only (STAGING isn't set)");
    if (!args.includes("--confirm")) throw new Error("add --confirm");
    console.log(JSON.stringify(await svc.resetAll()));
    process.exit(0);
  }
  if (args[0] === "totals") {
    const d = Number(args[1]) || ((await getQuery("SELECT MAX(draw) AS d FROM lotto_draws WHERE state IN ('selling','closed')"))[0] || {}).d;
    console.log(JSON.stringify(Object.assign({ draw: d }, await svc.totals(d)), null, 1));
    process.exit(0);
  }
  const pairs = args.filter((a) => !a.startsWith("--") && a.includes("="));
  if (pairs.length && !actor) throw new Error("say who is changing it: --actor=<name>");
  for (const p of pairs) {
    const i = p.indexOf("=");
    await svc.setSetting(p.slice(0, i), p.slice(i + 1), actor + " (cli)");
    console.log(`set ${p.slice(0, i)} = ${p.slice(i + 1)}`);
  }
  const st = await svc.loadSettings(true);
  console.log(`lotto_backend = ${st.lotto_backend}  price = ${st.price}  pot_share = ${st.pot_share}`);
  console.log(`pot = ${(await svc.potBalance()).toLocaleString("en-US")}`);
  const ds = await getQuery("SELECT draw, state, next_at, sold, tickets_digest, white, pb, reseed FROM lotto_draws ORDER BY draw DESC LIMIT 4");
  for (const d of ds) console.log(`draw #${d.draw} ${d.state} next_at=${new Date(d.next_at * 1000).toISOString()} sold=${d.sold}`
                                  + (d.white ? ` numbers=${d.white} pb=${d.pb}` : "") + (d.reseed ? ` reseed=${d.reseed}` : ""));
  const pend = await getQuery("SELECT COUNT(*) AS n FROM lotto_purchases WHERE state = 'charging'");
  console.log(`purchases in flight: ${pend[0].n}; history rows: ${(await getQuery("SELECT COUNT(*) AS n FROM lotto_history"))[0].n}`);
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
