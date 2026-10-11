// Offline tests for 1.99oj: ONE address per Camfrog pad (rooms.noteBridged / followName, bridge.roomFor, roomsweb.linkSlug,
// pads.currentSlugFor, tools/pad-slug-canonical.js).
//   - the prod case: a pad registered under its room ID's slug (you-were-never-here) whose room shows the display name
//     "Players__lounge" -> the registry slug becomes players-lounge, the id slug an alias that 301s, one identity everywhere
//   - a room bridged for the first time gets its display-name slug straight away (no alias, no event)
//   - kept when it can't have it: another pad's slug, a reserved word; the bridge then shows the registry slug too
//   - a chosen address (slug_set) never follows; a display-name change does, and changing back takes the alias back
//   - Pepe's owner sync says every slug is the link (slug_set true)
//   - the migration script on a scratch copy: dry run writes nothing, --apply moves (backup first), a re-run is a no-op
//   node --test test/pad-slug-canonical.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pad-slug-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const pads = require(path.join(repo, "pads"));
const bridge = require(path.join(repo, "bridge"));
const web = require(path.join(repo, "roomsweb"));

let seq = 0;
const snap = (id, name) => ({ room: { id, name }, topic: "", count: 2, members: [], mic: [] });
const msg = (id, name) => ({ op: "event", id: "ps-" + (++seq), ts: new Date().toISOString(), type: "message", scope: { platform: "camfrog", room: { id, name } },
                             data: { user: { id: "a", login: "a", display: "A" }, text: "hi" } });
const sync = (id, name) => bridge.ingest({ events: [msg(id, name)], rooms: [snap(id, name)] });
const T0 = Date.UTC(2026, 9, 1);
// a registry row the way 1.99bi-1.99oi made one for a bridged room: slug from the room ID, title = the display name
const oldRow = (id, slug, title, extra = "") => runQuery(`INSERT INTO rooms_registry (room_id, slug, title, owner_kind, platform, created, updated${extra ? ", slug_set" : ""})
                                                          VALUES (?, ?, ?, 'none', 'camfrog', ?, ?${extra ? ", 1" : ""})`, [id, slug, title, T0, T0]);
let base, server;

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await rooms.init();
  await oldRow("You_Were_Never_Here", "you-were-never-here", "Players__lounge");
  await oldRow("Chosen.Room", "my-chosen-pad", "Chosen", true);
  // a site pad whose slug a Camfrog room's display name wants
  await runQuery("INSERT INTO rooms_registry (room_id, slug, title, owner_kind, platform, slug_set, created, updated) VALUES ('patv:hangout', 'hangout', 'Hangout', 'house', 'site', 1, 1, 1)");
  await oldRow("Clash.Room", "clash-room", "Hangout");
  await oldRow("Admin.Room", "admin-room", "Admin");                  // display name "Admin" -> a reserved word
  await require(path.join(repo, "feedgallery")).init();
  await runQuery("INSERT INTO feed_view (user_id, scope, view, updated) VALUES ('u1', 'p/you-were-never-here', 'gallery', 1)");
  await rooms.loadCache();
  await bridge.load();
  const app = express();
  pads.register(app);
  app.get("/p/:slug", (req, res) => res.status(200).send("pad " + req.params.slug));
  app.get("/p/:slug/settings", (req, res) => res.status(200).send("settings " + req.params.slug));
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });

test("the prod case: You_Were_Never_Here (Players__lounge) ends up with one address, players-lounge", async () => {
  await sync("You_Were_Never_Here", "Players__lounge");
  const R = await rooms.get("You_Were_Never_Here");
  assert.deepEqual([R.slug, R.slug_set, R.slug_changed_at], ["players-lounge", false, null], "inherited, not chosen: the owner's rename limit is untouched");
  assert.equal(bridge._rooms.get("You_Were_Never_Here").slug, "players-lounge");
  assert.equal(web.linkSlug(R), "players-lounge");
  assert.equal(pads.padSlug(R), "players-lounge");
  assert.equal(pads.padHref(R), "/p/players-lounge");
  // the old registry slug is an alias: it still finds the pad (APIs, premium / comps lookups) and 301s on pages
  const al = await getQuery("SELECT slug, by FROM pad_slug_aliases WHERE room_id = 'You_Were_Never_Here'");
  assert.deepEqual(al, [{ slug: "you-were-never-here", by: "display-name" }]);
  for (const s of ["players-lounge", "you-were-never-here"]) {
    assert.equal((await rooms.bySlug(s)).id, "You_Were_Never_Here", s);
    assert.equal((await web.resolveRoom(s)).id, "You_Were_Never_Here", s);
    assert.equal(bridge.bySlug(s).id, "You_Were_Never_Here", s);
  }
  assert.equal(pads.currentSlugFor("you-were-never-here"), "players-lounge");
  assert.equal(pads.currentSlugFor("players-lounge"), null);
  let r = await fetch(base + "/p/you-were-never-here/settings?tab=general", { redirect: "manual" });
  assert.equal(r.status, 301);
  assert.equal(r.headers.get("location"), "/p/players-lounge/settings?tab=general");
  r = await fetch(base + "/p/players-lounge", { redirect: "manual" });
  assert.equal(r.status, 200, "the address itself never redirects");
  assert.match(pads.padRefs("see p/you-were-never-here"), /href="\/p\/players-lounge">p\/you-were-never-here/);
  assert.equal((await getQuery("SELECT scope FROM feed_view WHERE user_id = 'u1'"))[0].scope, "p/players-lounge");
  const ev = await getQuery("SELECT actor, detail FROM room_events WHERE room_id = 'You_Were_Never_Here' AND what = 'pad-address'");
  assert.equal(ev.length, 1);
  assert.match(ev[0].detail, /p\/you-were-never-here -> p\/players-lounge \(inherited from the Camfrog room's display name "Players__lounge"\)/);
  // the next syncs change nothing
  await sync("You_Were_Never_Here", "Players__lounge");
  assert.equal((await getQuery("SELECT COUNT(*) n FROM room_events WHERE room_id = 'You_Were_Never_Here' AND what = 'pad-address'"))[0].n, 1);
  // nobody else can take either slug
  const A = require(path.join(repo, "padaddress"));
  assert.ok(await A.takenProblem("you-were-never-here", "patv:hangout"));
  assert.ok(await A.takenProblem("players-lounge", "patv:hangout"));
});

test("a room bridged for the first time gets its display-name slug straight away", async () => {
  await sync("Brand_New.Room", "Late Night Vibes");
  const R = await rooms.get("Brand_New.Room");
  assert.equal(R.slug, "late-night-vibes");
  assert.equal(R.title, "Late Night Vibes");
  assert.equal(bridge._rooms.get("Brand_New.Room").slug, "late-night-vibes");
  assert.equal((await getQuery("SELECT COUNT(*) n FROM pad_slug_aliases WHERE room_id = 'Brand_New.Room'"))[0].n, 0);
  assert.equal((await rooms.bySlug("brand-new-room")).id, "Brand_New.Room", "its id-based slug still finds it");
  assert.equal(pads.currentSlugFor("brand-new-room"), "late-night-vibes");
});

test("kept when the display-name slug can't be had: another pad's slug, a reserved word - and the bridge agrees", async () => {
  await sync("Clash.Room", "Hangout");
  assert.equal((await rooms.get("Clash.Room")).slug, "clash-room");
  assert.equal(bridge._rooms.get("Clash.Room").slug, "clash-room", "one identity: the bridge shows the registry slug");
  assert.equal((await rooms.bySlug("hangout")).id, "patv:hangout");
  await sync("Admin.Room", "Admin");
  assert.equal((await rooms.get("Admin.Room")).slug, "admin-room");
  assert.equal(bridge._rooms.get("Admin.Room").slug, "admin-room");
  // ...but the display-name slug the bridge used to show still lands (a redirect, not an address)
  assert.deepEqual(await getQuery("SELECT slug, room_id FROM pad_slug_aliases WHERE room_id = 'Admin.Room'"), [{ slug: "admin", room_id: "Admin.Room" }]);
  assert.equal(pads.currentSlugFor("admin"), "admin-room");
  assert.equal((await web.resolveRoom("admin")).id, "Admin.Room");
  // the taken one is NOT aliased (it's another pad's address)
  assert.equal((await getQuery("SELECT COUNT(*) n FROM pad_slug_aliases WHERE room_id = 'Clash.Room'"))[0].n, 0);
  // a refused name isn't re-checked on every sync, but a forced run (the script) does check it
  assert.equal(await rooms.followName("Clash.Room", "Hangout"), null);
  assert.equal(await rooms.followName("Clash.Room", "Hangout", { force: true }), null);
});

test("a chosen address never follows the display name", async () => {
  await sync("Chosen.Room", "Something Else");
  assert.equal((await rooms.get("Chosen.Room")).slug, "my-chosen-pad");
  assert.equal(bridge._rooms.get("Chosen.Room").slug, "my-chosen-pad");
  assert.equal(await rooms.followName("Chosen.Room", "Something Else", { force: true }), null);
});

test("a display-name change moves the address (old one redirects); changing back takes the alias back", async () => {
  await sync("Brand_New.Room", "Early Birds");
  assert.equal((await rooms.get("Brand_New.Room")).slug, "early-birds");
  assert.equal(bridge._rooms.get("Brand_New.Room").slug, "early-birds");
  assert.equal(pads.currentSlugFor("late-night-vibes"), "early-birds");
  await sync("Brand_New.Room", "Late Night Vibes");
  assert.equal((await rooms.get("Brand_New.Room")).slug, "late-night-vibes");
  const al = (await getQuery("SELECT slug FROM pad_slug_aliases WHERE room_id = 'Brand_New.Room'")).map((a) => a.slug);
  assert.deepEqual(al, ["early-birds"]);
});

test("a pad's own address beats another pad's id-based slug", async () => {
  // a Camfrog room whose ID slugifies to an existing pad's address
  await oldRow("Players_Lounge", "players-lounge-2", "Players Lounge Two");
  await rooms.loadCache();
  assert.equal((await rooms.bySlug("players-lounge")).id, "You_Were_Never_Here");
  assert.equal(pads.currentSlugFor("players-lounge"), null);
});

test("Pepe's owner sync: every pad's slug is its link", async () => {
  const o = (await rooms.ownersForPepe()).find((x) => x.id === "You_Were_Never_Here");
  assert.deepEqual([o.slug, o.slug_set], ["players-lounge", true]);
});

test("tools/pad-slug-canonical.js on a scratch copy: dry run, --apply (backup first), re-run is a no-op", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pad-slug-script-"));
  const sqlite3 = require("sqlite3");
  const db = new sqlite3.Database(path.join(dir, "myapp.db"));
  const exec = (sql) => new Promise((ok, no) => db.exec(sql, (e) => (e ? no(e) : ok())));
  await exec(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb', camfrogUsername TEXT);
    CREATE TABLE rooms_registry (room_id TEXT PRIMARY KEY, slug TEXT NOT NULL, title TEXT, description TEXT, banner TEXT, owner_kind TEXT NOT NULL DEFAULT 'none',
      owner_user_id TEXT, slot_count INTEGER NOT NULL DEFAULT 1, approval INTEGER NOT NULL DEFAULT 0, slot_price INTEGER NOT NULL DEFAULT 0, created INTEGER, updated INTEGER,
      platform TEXT, slug_set INTEGER NOT NULL DEFAULT 0, slug_changed_at INTEGER, origin TEXT, created_by TEXT);
    CREATE UNIQUE INDEX rooms_registry_slug ON rooms_registry (slug);
    CREATE TABLE bridge_rooms (id TEXT PRIMARY KEY, slug TEXT, name TEXT, snap TEXT, updated INTEGER);
    CREATE TABLE rooms_kv (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO rooms_kv VALUES ('seeded:PepeFrog.Room', 'house'), ('seeded:PepeBeta.Room', 'house'), ('seeded:plant_based_chatting', 'x'), ('seeded:patv:lounge', 'house'), ('lounge_camfrog_v1', '{}');
    INSERT INTO rooms_registry (room_id, slug, title, platform, created) VALUES
      ('You_Were_Never_Here', 'you-were-never-here', 'Players__lounge', 'camfrog', 1),
      ('DRAMA_CENTRAL', 'drama-central', 'DRAMA_CENTRAL', 'camfrog', 1),
      ('PepeFrog.Room', 'pepefrog-room', 'Pepe''s Pad', 'camfrog', 1),
      ('Camfrog', 'camfrog', 'Camfrog', 'camfrog', 1);
    INSERT INTO bridge_rooms (id, slug, name, updated) VALUES
      ('You_Were_Never_Here', 'players-lounge', 'Players__lounge', 1), ('DRAMA_CENTRAL', 'drama-central', 'DRAMA_CENTRAL', 1),
      ('PepeFrog.Room', 'pepefrog-room', 'PepeFrog.Room', 1);
    CREATE TABLE feed_view (user_id TEXT, scope TEXT, view TEXT, updated INTEGER, PRIMARY KEY (user_id, scope));
    INSERT INTO feed_view VALUES ('u1', 'p/you-were-never-here', 'list', 1);`);
  await new Promise((ok) => db.close(ok));
  const run = (...a) => execFileSync(process.execPath, [path.join(repo, "tools", "pad-slug-canonical.js"), `--dir=${dir}`, ...a],
                                     { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });
  const q = (sql) => new Promise((ok, no) => { const d = new sqlite3.Database(path.join(dir, "myapp.db")); d.all(sql, (e, rows) => { d.close(); e ? no(e) : ok(rows); }); });

  const dry = run();
  assert.match(dry, /DRY RUN: would move p\/you-were-never-here -> p\/players-lounge/);
  assert.equal((await q("SELECT slug FROM rooms_registry WHERE room_id = 'You_Were_Never_Here'"))[0].slug, "you-were-never-here", "dry run writes nothing");

  const out = run("--apply", `--backup-dir=${path.join(dir, "bk")}`);
  assert.match(out, /You_Were_Never_Here: p\/you-were-never-here -> p\/players-lounge/);
  assert.equal(fs.readdirSync(path.join(dir, "bk")).length, 1, "a backup first");
  const reg = await q("SELECT room_id, slug, slug_set FROM rooms_registry ORDER BY room_id");
  assert.deepEqual(reg.find((r) => r.room_id === "You_Were_Never_Here"), { room_id: "You_Were_Never_Here", slug: "players-lounge", slug_set: 0 });
  assert.equal(reg.find((r) => r.room_id === "DRAMA_CENTRAL").slug, "drama-central");
  assert.equal(reg.find((r) => r.room_id === "PepeFrog.Room").slug, "pepefrog-room");
  assert.deepEqual(await q("SELECT slug, room_id, by FROM pad_slug_aliases"), [{ slug: "you-were-never-here", room_id: "You_Were_Never_Here", by: "migration" }]);
  assert.equal((await q("SELECT slug FROM bridge_rooms WHERE id = 'You_Were_Never_Here'"))[0].slug, "players-lounge");
  assert.equal((await q("SELECT scope FROM feed_view"))[0].scope, "p/players-lounge");
  assert.equal((await q("SELECT COUNT(*) n FROM room_events WHERE what = 'pad-address'"))[0].n, 1);

  const again = run("--apply", `--backup-dir=${path.join(dir, "bk")}`);
  assert.match(again, /nothing to do/);
  assert.equal(fs.readdirSync(path.join(dir, "bk")).length, 1, "no second backup when there's nothing to do");
  assert.equal((await q("SELECT COUNT(*) n FROM pad_slug_aliases"))[0].n, 1);
});
