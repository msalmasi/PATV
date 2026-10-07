// Offline tests for 1.99x: "PATV Lounge" -> "Camfrog Lounge" and pad platforms.
//   - the lounge_camfrog_v1 migration on a pre-1.99x registry: title / description / slug swapped only while
//     they still hold the old seeded values, once (idempotent), admin edits never overwritten; id unchanged
//   - the platform column: derived once for older rows (patv: -> site, else camfrog), twitch / discord valid
//   - the retired slug: /p/patv-lounge[/<sub>] 301s to /p/camfrog-lounge with the query kept (also /rooms, /feed/c)
//   - p/patv-lounge in old post text still autolinks (to the current address)
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

const OLD_DESC = "The general PATV pad: anything that isn't about one Camfrog room. Old main-feed posts live here.";
const NEW_DESC = "The general Camfrog pad: hang out, share anything, talk about any room or none.";
const row = async (id) => (await getQuery("SELECT * FROM rooms_registry WHERE room_id = ?", [id]))[0];
let base, server;

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT)`);
  // a pre-1.99x registry (no platform column), already seeded with the old Lounge
  await runQuery(`CREATE TABLE rooms_registry (
    room_id TEXT PRIMARY KEY, slug TEXT NOT NULL, title TEXT, description TEXT, banner TEXT,
    owner_kind TEXT NOT NULL DEFAULT 'none', owner_user_id TEXT,
    slot_count INTEGER NOT NULL DEFAULT 1, approval INTEGER NOT NULL DEFAULT 0, slot_price INTEGER NOT NULL DEFAULT 0,
    created INTEGER, updated INTEGER)`);
  await runQuery("CREATE TABLE rooms_kv (key TEXT PRIMARY KEY, value TEXT)");
  const ins = (id, slug, title, desc, kind) => runQuery("INSERT INTO rooms_registry (room_id, slug, title, description, owner_kind, created, updated) VALUES (?, ?, ?, ?, ?, 1, 1)",
                                                        [id, slug, title, desc, kind]);
  await ins("patv:lounge", "patv-lounge", "PATV Lounge", OLD_DESC, "house");
  await ins("PepeFrog.Room", "pepefrog-room", "Pepe's Pad", null, "house");
  await ins("Some.Room", "some-room", "Some Room", null, "none");
  await ins("discord:12345", "discord-12345", "A Discord server", null, "none");
  for (const id of ["patv:lounge", "PepeFrog.Room", "PepeBeta.Room", "plant_based_chatting"]) await runQuery("INSERT INTO rooms_kv (key, value) VALUES (?, 'house')", ["seeded:" + id]);
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

test("migration: the old Lounge becomes the Camfrog Lounge (title, description, slug), id unchanged, marked done", async () => {
  const L = await row("patv:lounge");
  assert.deepEqual([L.room_id, L.title, L.description, L.slug], ["patv:lounge", "Camfrog Lounge", NEW_DESC, "camfrog-lounge"]);
  assert.ok(!/main.feed/i.test(L.description), "no main-feed history in the new description");
  const done = JSON.parse(await rooms.kvGet("lounge_camfrog_v1"));
  assert.deepEqual([done.title, done.description, done.slug], [true, true, true]);
  const R = await rooms.get(rooms.LOUNGE_ID);
  assert.equal(R.title, "Camfrog Lounge");
  assert.equal(R.slug, "camfrog-lounge");
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

test("redirects: /p/patv-lounge (and its sub-pages, /rooms, /feed/c) 301 to /p/camfrog-lounge, query kept", async () => {
  const cases = [
    ["/p/patv-lounge", "/p/camfrog-lounge"],
    ["/p/patv-lounge?sort=top&t=week", "/p/camfrog-lounge?sort=top&t=week"],
    ["/p/PATV-Lounge?x=1", "/p/camfrog-lounge?x=1"],
    ["/p/patv-lounge/manage?tab=page", "/p/camfrog-lounge/manage?tab=page"],
    ["/p/patv-lounge/mod", "/p/camfrog-lounge/mod"],
    ["/rooms/patv-lounge?sort=new", "/p/camfrog-lounge?sort=new"],
    ["/rooms/patv-lounge/manage", "/p/camfrog-lounge/settings?tab=stage"],     // 1.99dc: straight to the settings hub, one hop
    ["/feed/c/patv-lounge?sort=top", "/p/camfrog-lounge?sort=top"],
  ];
  for (const [from, to] of cases) {
    const r = await get(from);
    assert.equal(r.status, 301, from);
    assert.equal(r.location, to, from);
  }
  const ok = await get("/p/camfrog-lounge");
  assert.equal(ok.status, 200);
  assert.equal(ok.text, "pad camfrog-lounge");
  assert.equal((await get("/p/some-room")).status, 200, "other pads are untouched");
  assert.equal((await get("/p/patv-lounge", "POST")).status, 200, "only GET / HEAD redirect");
});

test("autolink: p/patv-lounge in old post text still links (to the current address); p/camfrog-lounge links too", async () => {
  assert.equal(pads.padRefs("old post: p/patv-lounge!"), 'old post: <a class="pad-ref" href="/p/camfrog-lounge">p/patv-lounge</a>!');
  assert.equal(pads.padRefs("new: p/camfrog-lounge"), 'new: <a class="pad-ref" href="/p/camfrog-lounge">p/camfrog-lounge</a>');
  assert.equal(pads.padRefs("p/no-such-pad"), "p/no-such-pad");
});

test("badges: Camfrog / Site (Twitch / Discord ready), compact, by platform / pad / id / slug; in a rendered card", async () => {
  assert.equal(pads.padBadge("camfrog"), '<span class="pad-plat pp-camfrog" title="A Camfrog Pad: backed by a Camfrog room">🐸 Camfrog Pad</span>');
  assert.match(pads.padBadge("site"), /class="pad-plat pp-site"[^>]*>🌐 Site Pad</);
  assert.match(pads.padBadge("twitch"), /pp-twitch[^>]*>🟣 Twitch Pad</);
  assert.match(pads.padBadge("discord"), /pp-discord[^>]*>💬 Discord Pad</);
  assert.match(pads.padBadge("site", { compact: true }), /class="pad-plat pp-site sm" title="A Site Pad[^"]*">🌐<\/span>/);
  assert.match(pads.padBadge({ id: "patv:lounge" }), /Site Pad/);
  assert.match(pads.padBadge({ slug: "camfrog-lounge" }), /Site Pad/, "the Camfrog Lounge is a site pad despite its name");
  assert.match(pads.padBadge({ slug: "pepefrog-room" }), /Camfrog Pad/);
  assert.match(pads.padBadge("PepeFrog.Room"), /Camfrog Pad/);
  assert.match(pads.padBadge(null), /Camfrog Pad/);
  // Hot on PATV: a compact badge before p/<slug>
  const fx = { fileUrl: (x) => x, num: (n) => String(n), ago: () => "1m", padBadge: pads.padBadge };
  const hot = { posts: [{ url: "/feed/p/x", title: "t", community: { slug: "camfrog-lounge", title: "Camfrog Lounge", platform: "site" }, score: 1, comments: 0, created: 0, kind: "text" }] };
  const html = await ejs.renderFile(path.join(repo, "views/partials/home-hot.ejs"), { hot, fx });
  assert.match(html, /<span class="pad-plat pp-site sm"[^>]*>🌐<\/span> p\/camfrog-lounge/);
});

test("migration is idempotent and never overwrites an admin's edits", async () => {
  // run again: the marker stops it
  assert.deepEqual(await rooms.migrateLounge(), { title: false, description: false, slug: false });
  // an install whose admin edited the Lounge before 1.99x: nothing they changed is touched
  await runQuery("DELETE FROM rooms_kv WHERE key = 'lounge_camfrog_v1'");
  await runQuery("UPDATE rooms_registry SET title = 'The Couch', description = 'Our own words.', slug = 'couch' WHERE room_id = 'patv:lounge'");
  assert.deepEqual(await rooms.migrateLounge(), { title: false, description: false, slug: false });
  let L = await row("patv:lounge");
  assert.deepEqual([L.title, L.description, L.slug], ["The Couch", "Our own words.", "couch"]);
  // partly edited: only the still-seeded fields change (old title + 1.99ci text, custom slug kept)
  await runQuery("DELETE FROM rooms_kv WHERE key = 'lounge_camfrog_v1'");
  await runQuery("UPDATE rooms_registry SET title = 'PATV Lounge', description = ? WHERE room_id = 'patv:lounge'",
                 ["The general PATV community: anything that isn't about one room. Old main-feed posts live here."]);
  assert.deepEqual(await rooms.migrateLounge(), { title: true, description: true, slug: false });
  L = await row("patv:lounge");
  assert.deepEqual([L.room_id, L.title, L.description, L.slug], ["patv:lounge", "Camfrog Lounge", NEW_DESC, "couch"]);
  // and once more: a no-op
  assert.deepEqual(await rooms.migrateLounge(), { title: false, description: false, slug: false });
  // a slug the admin changed means /p/patv-lounge follows the pad to its current slug
  await rooms.loadCache();
  const r = await get("/p/patv-lounge?a=1");
  assert.equal(r.location, "/p/couch?a=1");
});
