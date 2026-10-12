#!/usr/bin/env node
// tools/ptplus-comps.js — the launch comps of 💎 Prime Time Plus (user decisions 2026-10-11) and the switch that makes Plus
// decide Camfrog rooms. Run in the site directory (it opens ./myapp.db) - staging first, then prod.
//
//   node tools/ptplus-comps.js --actor=<site admin>                     # DRY RUN: the Plus spots (N of ptplus_max_rooms),
//                                                                       # the targets, and the rooms Pepe would LEAVE
//   node tools/ptplus-comps.js --actor=<site admin> --apply             # comp them (comps.js, admin audit + notices)
//   node tools/ptplus-comps.js --actor=<site admin> --apply --gate=on   # ... then switch premium_config plus_bridge_gate on:
//                                                                       # Plus decides Camfrog rooms (connect needs it, Pepe
//                                                                       # leaves non-Plus pads' rooms, their live view hides).
//                                                                       # Only if no bridged pad would lose Pepe (--force-gate)
//   node tools/ptplus-comps.js --actor=<site admin> --gate=off          # back to the old model (connect free, no join/leave)
//
// 1.99qy (the user's model): Plus is what puts Pepe in a Camfrog room, and he can be in 5 rooms, so at most
// ptplus_max_rooms (default 5) pads have Plus at once - comps included. These comps take spots:
//   Pepe's Pad      (PepeFrog.Room)                                        no end date   (Pepe's own room)
//   Houseplants     (plant_based_chatting)                                 3 periods (90 days) (the user, 2026-10-11)
//   PepeLab         (PepeBeta.Room)                                        no end date   only where Pepe sits in it (bridged
//                                                                                        in the last 14 days = staging)
//   players-lounge  (Players__lounge, Camfrog room You_Were_Never_Here)   3 periods (90 days)
//   DRAMA_CENTRAL                                                         3 periods (90 days)
// A pad that already has a Plus comp is skipped (running it twice never extends anything); a comp that would go over the
// cap is refused (comps.compPremium -> premium.plusCapCheck). The running site picks comps and the gate up within a minute.
"use strict";
const path = require("path");
const ROOT = path.join(__dirname, "..");
const { getQuery } = require(path.join(ROOT, "dbUtils"));
const P = require(path.join(ROOT, "premium"));
const C = require(path.join(ROOT, "comps"));
const rooms = require(path.join(ROOT, "rooms"));

const REASON = "Prime Time Plus launch comp (user decision 2026-10-11)";
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
  const since = Date.now() - BRIDGED_DAYS * 86400000;
  const bridged = await getQuery("SELECT id, name, updated FROM bridge_rooms WHERE updated >= ? ORDER BY updated DESC", [since]).catch(() => []);
  const TARGETS = [
    { pad: "PepeFrog.Room", mode: "lifetime", label: "Pepe's Pad" },
    ...(bridged.some((b) => b.id === "PepeBeta.Room") ? [{ pad: "PepeBeta.Room", mode: "lifetime", label: "PepeLab" }] : []),
    // 1.99rl / 1.99ru: the user (2026-10-11) - Houseplants gets Plus for 3 months, like players-lounge and DRAMA_CENTRAL
    { pad: "plant_based_chatting", mode: "periods", n: 3, label: "Houseplants" },
    { pad: "players-lounge", mode: "periods", n: 3, label: "Players__lounge" },
    { pad: "DRAMA_CENTRAL", mode: "periods", n: 3, label: "DRAMA_CENTRAL" },
  ];
  const sp0 = P.plusSpots();
  console.log(`${apply ? "APPLY" : "DRY RUN"} as ${admin.username} · plus_price ${P.config().plus_price.toLocaleString("en-US")} PAT · ` +
              `Plus spots ${sp0.used} of ${sp0.max} taken · Plus decides Camfrog rooms (gate): ${P.config().plus_bridge_gate ? "ON" : "off"}`);

  // ── the comps ──
  const plusIds = new Set();
  let wouldUse = sp0.used;
  for (const T of TARGETS) {
    const R = await P.padTarget(T.pad);
    if (!R) { console.log(`  ✗ ${T.label}: no pad found for "${T.pad}" - skipped`); continue; }
    plusIds.add(R.id);
    const sub = await P.subRow("prime_plus", R.id);
    const st = P.statusOf(sub);
    const active = sub && Date.now() < P.endsAt(sub);
    const what = T.mode === "lifetime" ? "no end date" : `${T.n} periods (${T.n * P.config().period_days} days)`;
    const head = `  ${T.label} -> p/${R.slug || R.id} [${R.id}] owner ${R.owner ? R.owner.username : R.house ? "house" : "none"}`;
    if (sub && sub.comped) { console.log(`${head}: already comped (${P.compUntil(sub) ? "until " + day(P.compUntil(sub)) : "no end date"}) - skipped`); continue; }
    if (!apply) {
      if (!active) wouldUse++;
      console.log(`${head}: Plus now ${st}; would comp ${what}${T.confirm ? "  <- " + T.confirm : ""}${!active && wouldUse > sp0.max ? "  !! OVER THE CAP - would be refused" : ""}`);
      continue;
    }
    try {
      const r = await C.compPremium(admin, { tier: "prime_plus", pad: R.id, mode: T.mode, n: T.n, reason: REASON });
      console.log(`${head}: comped ${r.until ? "until " + day(r.until) : "with no end date"}`);
    } catch (e) { console.log(`${head}: REFUSED - ${e.message}`); }
  }
  await P.loadCache();
  const sp = P.plusSpots();
  console.log(apply ? `Plus spots now: ${sp.used} of ${sp.max} taken (${sp.left} left)` : `Plus spots after the comps: ${Math.min(wouldUse, sp0.max)} of ${sp0.max} taken`);

  // ── rooms Pepe is in (bridged lately) that would lose him with the gate on ──
  const lose = [];
  console.log(`bridged in the last ${BRIDGED_DAYS} days (rooms Pepe sits in): ${bridged.length}`);
  for (const b of bridged) {
    const R = rooms.getCached(b.id);
    const ok = (R && R.house) || P.isPrimePlus(b.id) || (!apply && plusIds.has(b.id));
    console.log(`  ${ok ? "✓" : "✗"} ${b.name || b.id} [${b.id}] last ${new Date(Number(b.updated)).toISOString().slice(0, 16)}${R && R.house ? " (house)" : ""}`);
    if (!ok) lose.push(b);
  }
  if (lose.length) console.log(`!! with the gate on Pepe would LEAVE ${lose.length} room(s): ${lose.map((b) => b.name || b.id).join(", ")}`);
  console.log("note: rooms on Pepe's auto-join list that aren't bridged don't show here - check !rooms / the admin panel's Auto-join card too");

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
