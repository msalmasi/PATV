#!/usr/bin/env node
// tools/veil-scrub.js - wave 2 WP-2 (incognito / mic-stage spec I.5): the scrub needed ONLY before a site rollback PAST WP-1
// (1.99afl, the whitelisted projection - the rollback floor). A rollback to any build from WP-1 on needs nothing: the live ring
// and room snapshots never held a real identity in their JSON (veil.js), and older builds don't read the side tables.
//
//   node tools/veil-scrub.js [myapp.db]            dry run (the default): what would go, counts only
//   node tools/veil-scrub.js [myapp.db] --apply    do it, in one transaction
//
// What it does: deletes every row of bridge_veil and bridge_rooms_veil (the live feed's real identities and hidden words), and
// takes the frog-name fields (alias, hood, id, veil) out of bridge_feed items and bridge_rooms snapshots - so a pre-WP-1 build,
// whose projection copied an item and deleted only the fields it knew, can't serialise them. chat_log_veil STAYS: it holds who
// was behind archived lines for logged reveals, and no older build reads it. Before running it: switch "Privacy wire v2" off at
// /admin/bridge and check that its accepted count has stopped (Pepe is back on v1). Prints table names and counts - never a row.
"use strict";
const path = require("path");

const FROG = ["alias", "hood", "id", "veil"];

function open(file) {
  const sqlite3 = require("sqlite3");
  return new Promise((resolve, reject) => { const db = new sqlite3.Database(file, (e) => (e ? reject(e) : resolve(db))); });
}
const P = (db, fn, sql, args = []) => new Promise((resolve, reject) => db[fn](sql, args, function (e, r) { if (e) reject(e); else resolve(fn === "run" ? this : r); }));

/** The frog-name fields out of one user object (a veiled one only: anon + veil). -> changed? */
function scrubUser(u) {
  if (!u || typeof u !== "object" || !u.anon) return false;
  let ch = false;
  for (const k of FROG) if (k in u) { delete u[k]; ch = true; }
  return ch;
}

async function scrub(db, { apply = false } = {}) {
  const has = async (t) => (await P(db, "all", "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [t])).length > 0;
  const out = { apply, bridge_veil: 0, bridge_rooms_veil: 0, feed_items: 0, room_snaps: 0 };
  if (apply) await P(db, "run", "BEGIN IMMEDIATE");
  try {
    for (const t of ["bridge_veil", "bridge_rooms_veil"]) {
      if (!(await has(t))) continue;
      out[t] = Number((await P(db, "all", `SELECT COUNT(*) AS n FROM ${t}`))[0].n) || 0;
      if (apply) await P(db, "run", `DELETE FROM ${t}`);
    }
    if (await has("bridge_feed")) {
      for (const r of await P(db, "all", "SELECT c, data FROM bridge_feed WHERE data LIKE '%\"veil\"%'")) {
        let it;
        try { it = JSON.parse(r.data); } catch (e) { continue; }
        if (!scrubUser(it.u)) continue;
        out.feed_items++;
        if (apply) await P(db, "run", "UPDATE bridge_feed SET data = ? WHERE c = ?", [JSON.stringify(it), r.c]);
      }
    }
    if (await has("bridge_rooms")) {
      for (const r of await P(db, "all", "SELECT id, snap FROM bridge_rooms WHERE snap LIKE '%\"veil\"%'")) {
        let s;
        try { s = JSON.parse(r.snap); } catch (e) { continue; }
        let ch = false;
        for (const list of [s.members, s.mic]) for (const u of Array.isArray(list) ? list : []) ch = scrubUser(u) || ch;
        if (!ch) continue;
        out.room_snaps++;
        if (apply) await P(db, "run", "UPDATE bridge_rooms SET snap = ? WHERE id = ?", [JSON.stringify(s), r.id]);
      }
    }
    if (apply) await P(db, "run", "COMMIT");
  } catch (e) {
    if (apply) await P(db, "run", "ROLLBACK").catch(() => {});
    throw e;
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const file = path.resolve(args.find((a) => !a.startsWith("--")) || "myapp.db");
  const db = await open(file);
  try {
    const r = await scrub(db, { apply });
    console.log(`[veil-scrub] ${apply ? "APPLIED" : "dry run"} on ${file}: bridge_veil ${r.bridge_veil} row(s), bridge_rooms_veil ${r.bridge_rooms_veil}, ` +
                `frog-name fields in ${r.feed_items} feed item(s) and ${r.room_snaps} room snapshot(s)${apply ? " - removed" : " - would go (add --apply)"}; chat_log_veil kept`);
  } finally { db.close(); }
}

if (require.main === module) main().catch((e) => { console.error("[veil-scrub] failed:", e.message); process.exit(1); });
module.exports = { scrub, scrubUser, FROG };
