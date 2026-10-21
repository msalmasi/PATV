#!/usr/bin/env node
// tools/casino-backend.js — owner answer (6), 2026-10-21: the casino's per-room switch from the server's shell - the emergency
// path next to /admin/backends (where a Pepe owner switches it; chat only shows the status since then). Like the web switch it
// records a WISH (backend_wants "casino:<room>", "casino" = the rooms Pepe joins later) that Pepe follows within a minute, and
// writes the admin_audit row "backend_switch" (via cli). Nothing on the site changes: the per-room switch is Pepe's, so - as on
// the web - it is refused while Pepe doesn't follow the casino switches (no fresh read listing "casino"), and only the rooms he
// listed can be switched. Run in the site directory (it opens ./myapp.db), or pass --dir=<folder with myapp.db>.
//   node tools/casino-backend.js [status] [--dir=<folder>]                      # Pepe's rooms, the wishes, what he reported
//   node tools/casino-backend.js --actor=<who> room <room id> on|off [--dir=...] # one room: the site's casino / Pepe's tables
//   node tools/casino-backend.js --actor=<who> default on|off [--dir=...]        # the rooms Pepe joins later
//   node tools/casino-backend.js --actor=<who> all on|off [--dir=...]            # every room he listed + the default
// On prod only with the owner's explicit go (the casino holds members' PAT). See docs/admin-backends.md.
"use strict";
const path = require("path");

function usage() {
  return "usage: node tools/casino-backend.js [status] | --actor=<who> room <room id> on|off | --actor=<who> default|all on|off [--dir=<folder with myapp.db>]";
}

async function main() {
  const argv = process.argv.slice(2);
  const actor = (argv.find((a) => a.startsWith("--actor=")) || "").slice(8).trim();
  const words = argv.filter((a) => !a.startsWith("--"));
  const scope = words[0] || "status";
  let room = null, sw = null;
  if (scope === "room") { room = words[1]; sw = words[2]; }
  else if (scope === "default" || scope === "all") sw = words[1];
  else if (scope !== "status") throw new Error(usage());
  if (scope !== "status") {
    if (!["on", "off"].includes(sw) || (scope === "room" && !room)) throw new Error(usage());
    if (!actor) throw new Error("say who is changing it: --actor=<name>");
  }
  require("./sitedb").siteDb();                                          // exits 2 (nothing opened) without ./myapp.db
  const B = require(path.join(__dirname, "..", "backends"));
  await B.init();
  if (scope !== "status") {
    const me = { username: actor.slice(0, 60) + " (cli)", userId: null };
    try {
      const r = await B.flipCasino(scope, room, sw === "on", me, { via: "cli", auditAs: { userId: ("cli:" + actor).slice(0, 64), username: actor.slice(0, 80) } });
      const what = sw === "on" ? "the site's casino" : "Pepe's tables";
      console.log(scope === "room" ? `casino in ${r.room}: ${what} (wish recorded by ${actor}; Pepe follows it within a minute)`
                                   : `casino ${scope === "all" ? "in " + (r.rooms.length ? r.rooms.join(", ") + " and " : "") + "new rooms" : "in new rooms"}: ${what} (wish recorded by ${actor})`);
    } catch (e) {
      if (e && e.refuse) throw new Error(e.message);
      throw e;
    }
  }
  const rd = await B.reader();
  const W = await B.wants();
  const follows = !!(rd.fresh && rd.follows.includes(B.CASINO));
  console.log(follows ? `Pepe follows the casino switches (last read ${new Date(rd.at).toISOString().slice(0, 16)} UTC, Pepe ${rd.version || "?"})`
                      : rd.at ? `Pepe does NOT follow the casino switches now (last read ${new Date(rd.at).toISOString().slice(0, 16)} UTC${rd.follows.includes(B.CASINO) ? "" : ", without the casino"})`
                              : "Pepe has never read these switches in this contract");
  const line = (label, live, w) => console.log(`  ${label.padEnd(24)} plays on ${live === true ? "the site" : live === false ? "Pepe" : "?"}`
    + `  wish: ${w ? (w.want ? "the site" : "Pepe") + ` (${w.by || "?"}, ${w.via || "?"})` : "-"}`
    + (w && w.pepe ? `  Pepe: ${w.pepe.state || (w.pepe.ok ? "done" : "not done")}${w.pepe.msg ? " - " + w.pepe.msg : ""}` : ""));
  const rep = rd.casino || { default: null, rooms: [] };
  line("new rooms", rep.default, W[B.CASINO]);
  const listed = new Set();
  for (const r of rep.rooms) { listed.add(r.room); line(r.room + (r.joined ? "" : " (not joined)"), r.on, W[B.CASINO + ":" + r.room]); }
  for (const k of Object.keys(W)) if (k.startsWith(B.CASINO + ":") && !listed.has(k.slice(B.CASINO.length + 1))) line(k.slice(B.CASINO.length + 1) + " (not listed)", null, W[k]);
}

if (require.main === module) main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
