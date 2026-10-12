#!/usr/bin/env node
// tools/ptplus-comps.js — 1.99qp: the launch comps of 💎 Prime Time Plus (user decision 2026-10-11), and the switch that
// makes the Camfrog bridge a Plus perk. Run in the site directory (it opens ./myapp.db) - staging first, then prod.
//
//   node tools/ptplus-comps.js --actor=<site admin>                     # DRY RUN: the targets, what they have now, and
//                                                                       # which bridged pads would lose the bridge
//   node tools/ptplus-comps.js --actor=<site admin> --apply             # comp them (comps.js, admin audit + notices)
//   node tools/ptplus-comps.js --actor=<site admin> --apply --gate=on   # ... then switch premium_config plus_bridge_gate on,
//                                                                       # only if no other bridged pad would lose its bridge
//                                                                       # (--force-gate to switch it on anyway)
//   node tools/ptplus-comps.js --actor=<site admin> --gate=off          # switch the gate off again (the bridge for everyone)
//
// Comps (premium.setComp through comps.compPremium: free, never routed, never auto-renewed, revocable on /admin/comps):
//   players-lounge  (Players__lounge, Camfrog room You_Were_Never_Here)   3 periods (90 days)
//   DRAMA_CENTRAL                                                         3 periods (90 days)
//   Pepe's Pad      (PepeFrog.Room)                                        no end date
// A pad that already has a Plus comp is skipped (so running it twice never extends anything). The running site picks
// comps and the gate up within a minute (premium.js re-reads its cache + config every 60 s).
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..");
const { getQuery } = require(path.join(ROOT, "dbUtils"));
const P = require(path.join(ROOT, "premium"));
const C = require(path.join(ROOT, "comps"));
const rooms = require(path.join(ROOT, "rooms"));

const REASON = "Prime Time Plus launch comp (user decision 2026-10-11)";
const TARGETS = [
  { pad: "players-lounge", mode: "periods", n: 3, label: "Players__lounge" },
  { pad: "DRAMA_CENTRAL", mode: "periods", n: 3, label: "DRAMA_CENTRAL" },
  { pad: "PepeFrog.Room", mode: "lifetime", label: "Pepe's Pad" },
];
const BRIDGED_DAYS = 14;
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const flag = (k) => process.argv.includes(`--${k}`);
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : "-");

(async () => {
  const actorName = arg("actor");
  if (!actorName) throw new Error("say who is doing it: --actor=<site admin username>");
  const admin = (await getQuery("SELECT userId, username, class FROM users WHERE LOWER(username) = LOWER(?)", [actorName]))[0];
  if (!admin) throw new Error(`no account called ${actorName}`);
  if (admin.class !== "Admin") throw new Error(`${admin.username} isn't a site admin`);
  const apply = flag("apply");
  const gate = arg("gate");
  await P.init();
  await rooms.init();
  console.log(`${apply ? "APPLY" : "DRY RUN"} as ${admin.username} · plus_price ${P.config().plus_price.toLocaleString("en-US")} PAT · bridge gate now ${P.config().plus_bridge_gate ? "ON" : "off"}`);

  // ── the comps ──
  const plusIds = new Set();
  for (const T of TARGETS) {
    const R = await P.padTarget(T.pad);
    if (!R) { console.log(`  ✗ ${T.label}: no pad found for "${T.pad}" - skipped`); continue; }
    plusIds.add(R.id);
    const sub = await P.subRow("prime_plus", R.id);
    const st = P.statusOf(sub);
    const what = T.mode === "lifetime" ? "no end date" : `${T.n} periods (${T.n * P.config().period_days} days)`;
    const head = `  ${T.label} -> p/${R.slug || R.id} [${R.id}] owner ${R.owner ? R.owner.username : R.house ? "house" : "none"}`;
    if (sub && sub.comped) { console.log(`${head}: already comped (${P.compUntil(sub) ? "until " + day(P.compUntil(sub)) : "no end date"}) - skipped`); continue; }
    if (!apply) { console.log(`${head}: Plus now ${st}; would comp ${what}`); continue; }
    const r = await C.compPremium(admin, { tier: "prime_plus", pad: R.id, mode: T.mode, n: T.n, reason: REASON });
    console.log(`${head}: comped ${r.until ? "until " + day(r.until) : "with no end date"}`);
  }
  await P.loadCache();

  // ── who would lose the bridge with the gate on ──
  const since = Date.now() - BRIDGED_DAYS * 86400000;
  const bridged = await getQuery("SELECT id, name, updated FROM bridge_rooms WHERE updated >= ? ORDER BY updated DESC", [since]).catch(() => []);
  const lose = [];
  console.log(`bridged in the last ${BRIDGED_DAYS} days: ${bridged.length}`);
  for (const b of bridged) {
    const R = rooms.getCached(b.id);
    const ok = (R && R.house) || P.isPrimePlus(b.id) || (!apply && plusIds.has(b.id));
    console.log(`  ${ok ? "✓" : "✗"} ${b.name || b.id} [${b.id}] last ${new Date(Number(b.updated)).toISOString().slice(0, 16)}${R && R.house ? " (house)" : ""}`);
    if (!ok) lose.push(b);
  }
  if (lose.length) console.log(`!! ${lose.length} bridged pad(s) would lose the bridge with the gate on: ${lose.map((b) => b.name || b.id).join(", ")}`);

  // ── the gate ──
  if (gate === "on") {
    if (!apply) console.log("(dry run: the gate isn't switched - add --apply)");
    else if (lose.length && !flag("force-gate")) console.log("gate NOT switched on: comp or upgrade those pads first, or add --force-gate");
    else { await P.setConfig({ plus_bridge_gate: true }, admin.username + " (cli)"); console.log("plus_bridge_gate = ON (the site picks it up within a minute)"); }
  } else if (gate === "off") {
    await P.setConfig({ plus_bridge_gate: false }, admin.username + " (cli)");
    console.log("plus_bridge_gate = off");
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
