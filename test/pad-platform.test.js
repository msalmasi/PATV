// Offline tests for pad platforms and the Lounge's name: 1.99x renamed "PATV Lounge" to "Camfrog Lounge"; S1 Q4 (ADR 0007 D1,
// the owner's OQ-1 answer) renames it back to the "PATV Lounge" (slug patv-lounge), camfrog-lounge kept as a 301.
//   - the lounge_patv_v1 migration on a 1.99x registry: title / description / slug swapped only while they still hold a seeded
//     value, once (idempotent), admin edits never overwritten; the old slug becomes the pad's alias; id unchanged
//   - the platform column: derived once for older rows (patv: -> site, else camfrog), twitch / discord valid
//   - the retired slugs: /p/camfrog-lounge[/<sub>] (and the 1.99x one, /p/patv-lounge, when an admin moved the pad) 301 to the
//     pad's current slug with the query kept (also /rooms, /feed/c)
//   - p/camfrog-lounge in old post text still autolinks (to the current address)
//   - the platform badge html
//   NODE_PATH=G:/PATV/node_modules node --test test/pad-platform.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pad-platform-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const ejs = require("ejs");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const pads = require(path.join(repo, "pads"));

const CI_DESC = "The general PATV community: anything that isn't about one room. Old main-feed posts live here.";      // 1.99ci
const CAMFROG_DESC = "The general Camfrog pad: hang out, share anything, talk about any room or none.";                   // 1.99x
const NEW_DESC = "The general PATV pad: hang out, share anything, talk about any room or none.";                          // S1 Q4
const row = async (id) => (await getQuery("SELECT * FROM rooms_registry WHERE room_id = ?", [id]))[0];
let base, server;

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT)`);
  // a registry from before the platform column (1.99x added it), already holding the 1.99x Lounge (prod's state)
  await runQuery(`CREATE TABLE rooms_registry (
    room_id TEXT PRIMARY KEY, slug TEXT NOT NULL, title TEXT, description TEXT, banner TEXT,
    owner_kind TEXT NOT NULL DEFAULT 'none', owner_user_id TEXT,
    slot_count INTEGER NOT NULL DEFAULT 1, approval INTEGER NOT NULL DEFAULT 0, slot_price INTEGER NOT NULL DEFAULT 0,
    created INTEGER, updated INTEGER)`);
  await runQuery("CREATE TABLE rooms_kv (key TEXT PRIMARY KEY, value TEXT)");
  const ins = (id, slug, title, desc, kind) => runQuery("INSERT INTO rooms_registry (room_id, slug, title, description, owner_kind, created, updated) VALUES (?, ?, ?, ?, ?, 1, 1)",
                                                        [id, slug, title, desc, kind]);
  await ins("patv:lounge", "camfrog-lounge", "Camfrog Lounge", CAMFROG_DESC, "house");
  await ins("PepeFrog.Room", "pepefrog-room", "Pepe's Pad", null, "house");
  await ins("Some.Room", "some-room", "Some Room", null, "none");
  await ins("discord:12345", "discord-12345", "A Discord server", null, "none");
  for (const id of ["patv:lounge", "PepeFrog.Room", "PepeBeta.Room", "plant_based_chatting", "patv:staff", "patv:canary"]) {
    await runQuery("INSERT INTO rooms_kv (key, value) VALUES (?, 'house')", ["seeded:" + id]);
  }
  await runQuery("INSERT INTO rooms_kv (key, value) VALUES ('lounge_camfrog_v1', '{\"at\":1,\"title\":true,\"description\":true,\"slug\":true}')");
  await rooms.init();

  const app = express();
  pads.register(app);
  app.get("/p/:slug", (req, res) => res.status(200).send("pad " + req.params.slug));
  app.get("/p/:slug/manage", (req, res) => res.status(200).send("manage " + req.params.slug));
  app.post("/p/:slug", (req, res) => res.status(200).send("posted"));
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });

const get = async (url, method = "GET") => {
  const r = await fetch(base + url, { method, redirect: "manual" });
  return { status: r.status, location: r.headers.get("location"), text: await r.text() };
};

test("migration: the Camfrog Lounge is the PATV Lounge again (title, description, slug; camfrog-lounge its alias), id unchanged, marked done", async () => {
  const L = await row("patv:lounge");
  assert.deepEqual([L.room_id, L.title, L.description, L.slug], ["patv:lounge", "PATV Lounge", NEW_DESC, "patv-lounge"]);
  assert.ok(!/main.feed/i.test(L.description), "no main-feed history in the description");
  const done = JSON.parse(await rooms.kvGet("lounge_patv_v1"));
  assert.deepEqual([done.title, done.description, done.slug], [true, true, true]);
  assert.deepEqual(await getQuery("SELECT slug, room_id FROM pad_slug_aliases"), [{ slug: "camfrog-lounge", room_id: "patv:lounge" }],
                   "the 1.99x address is the pad's alias (nobody else can take it)");
  const R = await rooms.get(rooms.LOUNGE_ID);
  assert.equal(R.title, "PATV Lounge");
  assert.equal(R.slug, "patv-lounge");
  assert.equal(rooms.aliasTarget("camfrog-lounge"), "patv:lounge");
  const ev = (await getQuery("SELECT what, actor, detail FROM room_events WHERE room_id = 'patv:lounge'"))[0];
  assert.deepEqual(ev, { what: "page", actor: "migration", detail: "PATV Lounge rename (S1): title, description, slug" });
});

test("platform: derived once for older rows (patv: -> site, else camfrog); twitch / discord valid; Lounge is a SITE pad", async () => {
  assert.equal((await row("patv:lounge")).platform, "site");
  assert.equal((await row("PepeFrog.Room")).platform, "camfrog");
  assert.equal((await row("Some.Room")).platform, "camfrog");
  assert.equal((await row("discord:12345")).platform, "discord");
  assert.equal((await rooms.get("patv:lounge")).platform, "site");
  assert.equal((await rooms.get("patv:lounge")).community, true);
  assert.equal(rooms.isCommunityOnly("patv:lounge"), true);
  assert.equal(rooms.isCommunityOnly("PepeFrog.Room"), false);
  assert.equal(rooms.isCommunityOnly("Never.Registered"), false, "an unregistered Camfrog room is camfrog");
  assert.deepEqual(rooms.PLATFORMS, ["camfrog", "site", "twitch", "discord", "profile"]);   // 1.99df: + profile pads
  assert.equal(rooms.platformFromId("twitch:somechan"), "twitch");
  assert.equal(rooms.platformFromId("patv:new"), "site");
  assert.equal(rooms.platformFromId("Any.Room"), "camfrog");
  // an explicit value wins over the id (derivation fills blanks only)
  await runQuery("UPDATE rooms_registry SET platform = 'twitch' WHERE room_id = 'Some.Room'");
  await rooms.loadCache();
  assert.equal(rooms.platformOf("Some.Room"), "twitch");
  await runQuery("UPDATE rooms_registry SET platform = 'camfrog' WHERE room_id = 'Some.Room'");
  await rooms.loadCache();
  // a room Pepe bridges later is registered as camfrog
  await rooms.noteBridged("New.Room", "New Room");
  assert.equal((await row("New.Room")).platform, "camfrog");
});

test("redirects: /p/camfrog-lounge (and its sub-pages, /rooms, /feed/c) 301 to /p/patv-lounge, query kept", async () => {
  const cases = [
    ["/p/camfrog-lounge", "/p/patv-lounge"],
    ["/p/camfrog-lounge?sort=top&t=week", "/p/patv-lounge?sort=top&t=week"],
    ["/p/Camfrog-Lounge?x=1", "/p/patv-lounge?x=1"],
    ["/p/camfrog-lounge/manage?tab=page", "/p/patv-lounge/manage?tab=page"],
    ["/p/camfrog-lounge/mod", "/p/patv-lounge/mod"],
    ["/rooms/camfrog-lounge?sort=new", "/p/patv-lounge?sort=new"],
    ["/rooms/camfrog-lounge/manage", "/p/patv-lounge/settings?tab=stage"],     // 1.99dc: straight to the settings hub, one hop
    ["/feed/c/camfrog-lounge?sort=top", "/p/patv-lounge?sort=top"],
  ];
  for (const [from, to] of cases) {
    const r = await get(from);
    assert.equal(r.status, 301, from);
    assert.equal(r.location, to, from);
  }
  const ok = await get("/p/patv-lounge");
  assert.equal(ok.status, 200, "the current address is not redirected (patv-lounge is the 1.99x retired slug no more)");
  assert.equal(ok.text, "pad patv-lounge");
  assert.equal((await get("/p/some-room")).status, 200, "other pads are untouched");
  assert.equal((await get("/p/camfrog-lounge", "POST")).status, 200, "only GET / HEAD redirect");
});

test("autolink: p/camfrog-lounge in old post text still links (to the current address); p/patv-lounge links too", async () => {
  assert.equal(pads.padRefs("old post: p/camfrog-lounge!"), 'old post: <a class="pad-ref" href="/p/patv-lounge">p/camfrog-lounge</a>!');
  assert.equal(pads.padRefs("new: p/patv-lounge"), 'new: <a class="pad-ref" href="/p/patv-lounge">p/patv-lounge</a>');
  assert.equal(pads.padRefs("p/no-such-pad"), "p/no-such-pad");
});

test("badges: Camfrog / Site (Twitch / Discord ready), compact, by platform / pad / id / slug; in a rendered card", async () => {
  assert.equal(pads.padBadge("camfrog"), '<span class="pad-plat pp-camfrog" title="A Camfrog Pad: backed by a Camfrog room">🐸 Camfrog Pad</span>');
  assert.match(pads.padBadge("site"), /class="pad-plat pp-site"[^>]*>🌐 Site Pad</);
  assert.match(pads.padBadge("twitch"), /pp-twitch[^>]*>🟣 Twitch Pad</);
  assert.match(pads.padBadge("discord"), /pp-discord[^>]*>💬 Discord Pad</);
  assert.match(pads.padBadge("site", { compact: true }), /class="pad-plat pp-site sm" title="A Site Pad[^"]*">🌐<\/span>/);
  assert.match(pads.padBadge({ id: "patv:lounge" }), /Site Pad/);
  assert.match(pads.padBadge({ slug: "patv-lounge" }), /Site Pad/, "the PATV Lounge is a site pad");
  assert.match(pads.padBadge({ slug: "pepefrog-room" }), /Camfrog Pad/);
  assert.match(pads.padBadge("PepeFrog.Room"), /Camfrog Pad/);
  assert.match(pads.padBadge(null), /Camfrog Pad/);
  // Hot on PATV: a compact badge before p/<slug>
  const fx = { fileUrl: (x) => x, num: (n) => String(n), ago: () => "1m", padBadge: pads.padBadge };
  const hot = { posts: [{ url: "/feed/p/x", title: "t", community: { slug: "patv-lounge", title: "PATV Lounge", platform: "site" }, score: 1, comments: 0, created: 0, kind: "text" }] };
  const html = await ejs.renderFile(path.join(repo, "views/partials/home-hot.ejs"), { hot, fx });
  assert.match(html, /<span class="pad-plat pp-site sm"[^>]*>🌐<\/span> p\/patv-lounge/);
});

test("migration is idempotent and never overwrites an admin's edits; a pre-1.99x install keeps its PATV Lounge", async () => {
  // run again: the marker stops it
  assert.deepEqual(await rooms.migrateLounge(), { title: false, description: false, slug: false });
  // an install whose admin edited the Lounge: nothing they changed is touched
  await runQuery("DELETE FROM rooms_kv WHERE key = 'lounge_patv_v1'");
  await runQuery("UPDATE rooms_registry SET title = 'The Couch', description = 'Our own words.', slug = 'couch' WHERE room_id = 'patv:lounge'");
  assert.deepEqual(await rooms.migrateLounge(), { title: false, description: false, slug: false });
  let L = await row("patv:lounge");
  assert.deepEqual([L.title, L.description, L.slug], ["The Couch", "Our own words.", "couch"]);
  // partly edited: only the still-seeded fields change (the 1.99x title + the 1.99ci text, the custom slug kept)
  await runQuery("DELETE FROM rooms_kv WHERE key = 'lounge_patv_v1'");
  await runQuery("UPDATE rooms_registry SET title = 'Camfrog Lounge', description = ? WHERE room_id = 'patv:lounge'", [CI_DESC]);
  assert.deepEqual(await rooms.migrateLounge(), { title: true, description: true, slug: false });
  L = await row("patv:lounge");
  assert.deepEqual([L.room_id, L.title, L.description, L.slug], ["patv:lounge", "PATV Lounge", NEW_DESC, "couch"]);
  // and once more: a no-op
  assert.deepEqual(await rooms.migrateLounge(), { title: false, description: false, slug: false });
  // a slug the admin changed means /p/camfrog-lounge (and the 1.99x /p/patv-lounge) follow the pad to its current slug
  await rooms.loadCache();
  assert.equal((await get("/p/camfrog-lounge?a=1")).location, "/p/couch?a=1");
  assert.equal((await get("/p/patv-lounge?a=1")).location, "/p/couch?a=1");
  // a pre-1.99x install (the PATV Lounge, never renamed: no marker at all): the name stays, the old seed text is replaced, and
  // the 1.99x rename never runs again (its marker is set)
  await runQuery("DELETE FROM rooms_kv WHERE key IN ('lounge_patv_v1', 'lounge_camfrog_v1')");
  await runQuery("UPDATE rooms_registry SET title = 'PATV Lounge', slug = 'patv-lounge', description = ? WHERE room_id = 'patv:lounge'", [CI_DESC]);
  assert.deepEqual(await rooms.migrateLounge(), { title: false, description: true, slug: false });
  L = await row("patv:lounge");
  assert.deepEqual([L.title, L.description, L.slug], ["PATV Lounge", NEW_DESC, "patv-lounge"]);
  assert.ok(JSON.parse(await rooms.kvGet("lounge_camfrog_v1")).superseded, "the 1.99x rename is marked done");
});
