// tools/pad-slug-canonical.js — 1.99oj: ONE address per Camfrog pad. DRY RUN BY DEFAULT.
//
//   node tools/pad-slug-canonical.js [--dir=<folder with myapp.db>] [--apply] [--backup-dir=<dir>]
//
// Before 1.99oj a Camfrog room's pad had two slugs: the registry row was made from the room ID
// (You_Were_Never_Here -> you-were-never-here) while the bridge, Pepe's !bridge links and every link people shared
// used the room's DISPLAY NAME (Players__lounge -> players-lounge). Premium / comps / launchpad / boosts and the rest
// read the registry one. 1.99oj makes the registry slug the one address (rooms.noteBridged / followName keep it on the
// display name while the owner hasn't chosen one); this brings existing pads over.
//
// For every Camfrog pad the bridge has a persisted room for (bridge_rooms: id, display name), with no chosen address
// (rooms_registry.slug_set = 0), whose registry slug isn't slugify(display name): rooms.followName() - the same code the
// site runs live - in one transaction: the old slug becomes an alias (/p/<old>[/...] 301s to the new address), the
// registry slug becomes the display-name slug, feed_view "p/<old>" rows move, a "pad-address" event goes in the pad's
// log. Only when that slug is a valid address that no other pad uses / gave up / shows on the bridge.
// Then bridge_rooms.slug is set to the registry slug for every registered room (cosmetic: the bridge recomputes it).
// Everything else is keyed by the room id (rooms_registry.room_id), not the slug.
// Idempotent: a second run finds nothing to change. With --apply a VACUUM INTO backup is taken first, always.
"use strict";
const fs = require("fs");
const path = require("path");

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
}));
const appDir = path.resolve(__dirname, "..");
if (args.dir) process.chdir(path.resolve(String(args.dir)));          // dbUtils opens ./myapp.db
if (!fs.existsSync(path.join(process.cwd(), "myapp.db"))) { console.error(`no myapp.db in ${process.cwd()}`); process.exit(2); }
const { runQuery, getQuery } = require(path.join(appDir, "dbUtils"));
const rooms = require(path.join(appDir, "rooms"));
const A = require(path.join(appDir, "padaddress"));
const apply = !!args.apply;

async function survey() {
  const br = await getQuery("SELECT id, slug, name FROM bridge_rooms");
  // a live bridge room shows slug s for room id -> the same rule as padaddress.bridgeHolder, from the persisted rooms
  const holder = (s) => { for (const b of br) if (b.slug === s || rooms.slugify(b.id) === s) return b.id; return null; };
  const out = [];
  for (const b of br) {
    const R = await rooms.get(b.id);
    if (!R || R.platform !== "camfrog") continue;
    const want = rooms.slugify(b.name);
    const row = { room_id: b.id, display_name: b.name, registry_slug: R.slug, bridge_slug: b.slug, slug_set: R.slug_set, want };
    if (R.slug_set) row.action = R.slug === b.slug ? "ok" : "bridge-only (chosen address; the bridge shows it from 1.99oj)";
    else if (want === R.slug) row.action = R.slug === b.slug ? "ok" : "bridge-only";
    else {
      const problem = A.formProblem(want) || (await A.takenProblem(want, b.id, { holder }));
      row.action = problem ? `keep (${problem})` : "move";
    }
    out.push(row);
  }
  return { rows: out, holder };
}

async function backup(dir) {
  const d = path.resolve(String(dir || "db-backups"));
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, `myapp-pre-padslug-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  await runQuery(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  if (fs.statSync(file).size < 4096) throw new Error("backup looks empty");
  return file;
}

(async () => {
  await rooms.init();
  const before = await survey();
  console.log(JSON.stringify({ mode: apply ? "APPLY" : "DRY RUN", rooms: before.rows }, null, 1));
  const todo = before.rows.filter((r) => r.action === "move");
  const fix = before.rows.filter((r) => r.action !== "ok");
  if (!apply) {
    console.log(todo.length ? `DRY RUN: would move ${todo.map((r) => `p/${r.registry_slug} -> p/${r.want}`).join(", ")} (old slugs kept as redirects). Re-run with --apply.`
                            : "DRY RUN: nothing to move.");
    process.exit(0);
  }
  if (!fix.length) { console.log("nothing to do (already canonical)"); process.exit(0); }
  const file = await backup(args["backup-dir"]);
  console.log("backup:", file);
  const moved = [];
  for (const r of todo) {
    const m = await rooms.followName(r.room_id, r.display_name, { force: true, by: "migration", holder: before.holder });
    if (m) moved.push(`${r.room_id}: p/${m.from} -> p/${m.to}`);
  }
  // the persisted bridge rows show the registry slug too (the bridge recomputes it on load; this keeps the table honest)
  for (const r of before.rows) {
    const R = await rooms.get(r.room_id);
    if (R && R.slug && R.slug !== r.bridge_slug) await runQuery("UPDATE bridge_rooms SET slug = ? WHERE id = ?", [R.slug, r.room_id]);
  }
  const after = await survey();
  console.log(JSON.stringify({ moved, after: after.rows }, null, 1));
  const aliases = await getQuery("SELECT slug, room_id, by FROM pad_slug_aliases ORDER BY created DESC LIMIT 20");
  console.log(JSON.stringify({ aliases }, null, 1));
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
