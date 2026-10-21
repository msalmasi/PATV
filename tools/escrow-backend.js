#!/usr/bin/env node
// tools/escrow-backend.js — 1.99ou: the escrow backend switches (escrow/ledger.js + escrow/games.js) from the server's shell.
// Run in the site directory (it opens ./myapp.db). See docs/escrow-cutover-runbook.md for the hand-over and the way back.
//   node tools/escrow-backend.js                                  # status: switches, live, held stakes by kind, the games' live records
//   node tools/escrow-backend.js --actor=<who> on [game]          # allow Pepe to hand the ledger (or one game) over
//   node tools/escrow-backend.js --actor=<who> off [game]         # refuse new imports (never takes anything away from a live site:
//                                                                 #   the way back is `!escrow backend [game] rollback confirm` in Camfrog)
//   games: wagers | bounties | pools | loans
// Read-only by default; `on` / `off` write ONE escrow_meta row (on prod only with the user's explicit go) + an admin_audit row.
// The review of the owner answers 2026-10-20: it never opens a database that isn't there (tools/sitedb.js; --dir=<folder>).
"use strict";
const path = require("path");
require("./sitedb").siteDb();                                         // exits 2 (nothing opened) without ./myapp.db
const L = require(path.join(__dirname, "..", "escrow", "ledger"));
const { getQuery } = require(path.join(__dirname, "..", "dbUtils"));
(async () => {
  await L.init();
  const actor = (process.argv.find((a) => a.startsWith("--actor=")) || "").slice(8);
  const words = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const [cmd, game] = words;
  if (cmd === "on" || cmd === "off") {
    if (!actor) throw new Error("say who is changing it: --actor=<name>");
    if (game && !L.GAMES.includes(game)) throw new Error(`unknown game ${game} (${L.GAMES.join("|")})`);
    if (game ? await L.meta(`live:${game}`) : await L.live()) throw new Error("the site owns it now - roll back from Pepe instead");
    await L.setMeta(game ? `enabled:${game}` : "enabled", cmd === "on");
    await L.setMeta(game ? `enabled_by:${game}` : "enabled_by", { by: actor + " (cli)", at: Date.now(), on: cmd === "on" });
    await require("./sitedb").cliAudit(actor, { feature: game ? `escrow:${game}` : "escrow", want: cmd === "on", live: false, tool: "escrow-backend" });
    console.log(`escrow backend ${game || "ledger"} ${cmd === "on" ? "enabled" : "disabled"} by ${actor}`);
  } else if (cmd) {
    throw new Error("usage: node tools/escrow-backend.js [--actor=<who> on|off [wagers|bounties|pools|loans]]");
  }
  const st = await L.exportState();
  console.log(`ledger   enabled=${st.enabled}${process.env.STAGING ? " (staging default: on)" : ""} live=${st.live} rev=${st.rev}`);
  console.log(`held     ${st.count} hold(s), ${st.sum} PAT  by kind ${JSON.stringify(st.per_kind)}  sha256 ${st.digest}`);
  console.log(`imported ${st.imported ? JSON.stringify(st.imported) : "never"}`);
  for (const [g, v] of Object.entries(st.games)) {
    const n = await getQuery("SELECT status, COUNT(*) AS n FROM escrow_games WHERE game = ? GROUP BY status", [g]);
    console.log(`${g.padEnd(8)} enabled=${v.enabled} live=${v.live}  ${n.map((r) => `${r.status}:${r.n}`).join(" ") || "no records"}`);
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
