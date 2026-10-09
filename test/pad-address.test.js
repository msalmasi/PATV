// Offline tests for 1.99iy: changing a pad's address (padaddress.js, rooms.js pad_slug_aliases, pads.js redirects).
//   - the slug rules: folding, length, charset, reserved words, u- / site prefixes
//   - uniqueness: another pad's slug, an id-based slug, a slug the bridge shows for another Camfrog room, another pad's old slug
//   - a rename: the alias, slug_set, the event in the pad's log, per-account feed views moved, the bridge's live slug
//   - the owner's once-per-30-days limit (staff any time), non-owners refused, profile pads refused, taking an old slug back
//   - old URLs 301 to the new address with the query kept (/p/<old>, /p/<old>/settings?tab=..., /rooms/<old>), p/<old> autolinks
//   - the HTTP API (check + rename, JSON only) and the settings hub's Address section
//   NODE_PATH=G:/PATV/node_modules node --test test/pad-address.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pad-address-test-"));
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
const PAD = require(path.join(repo, "padaddress"));
const bridge = require(path.join(repo, "bridge"));
require(path.join(repo, "terms"))._setRequired(false);

const users = new Map();
const U = {};
async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, camfrogUsername, level, created_at)
                  VALUES (?, ?, ?, 'x', ?, ?, 5, '2026-01-01 00:00:00')`, [id, name, name, extra.class || "pleb", extra.camfrog || null]);
  const u = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, u);
  return u;
}
let base, server;
const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {});
async function call(method, url, u, body, headers) {
  const r = await fetch(base + url, { method, headers: headers || H(u), body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, text, location: r.headers.get("location") };
}
let seq = 0;
const ev = (room, type, data) => ({ op: "event", id: "pa-" + (++seq), ts: new Date().toISOString(), type, scope: { platform: "camfrog", room }, data });

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await require(path.join(repo, "media")).ready;
  await require(path.join(repo, "inbox")).ready;
  U.owner = await mkUser("padowner", { camfrog: "ownercf" });
  U.other = await mkUser("otherowner");
  U.admin = await mkUser("siteadmin", { class: "Admin" });
  U.rando = await mkUser("rando");
  await rooms.init();
  await rooms.addRoom("Frog.Room", "Frog Room", "test");
  await rooms.setOwner("Frog.Room", "padowner", "test");
  await rooms.addRoom("patv:other", "Other Pad", "test");
  await rooms.setOwner("patv:other", "otherowner", "test");
  await rooms.addRoom("Taken_Room", "Taken", "test");
  // Frog.Room is live through the bridge under its display name "Lily Pond" (bridge slug lily-pond, registry slug frog-room)
  await bridge.load();
  await bridge.ingest({ events: [ev({ id: "Frog.Room", name: "Lily Pond" }, "message", { user: { id: "a", login: "a", display: "A" }, text: "hi" })],
                        rooms: [{ room: { id: "Frog.Room", name: "Lily Pond" }, topic: "", count: 2, members: [], mic: [] }] });
  // another Camfrog room Pepe is in, with no pad of its own yet
  await bridge.ingest({ rooms: [{ room: { id: "Swamp.Room", name: "Swamp Things" }, topic: "", count: 1, members: [], mic: [] }] });
  await require(path.join(repo, "feedgallery")).init();
  await runQuery("INSERT INTO feed_view (user_id, scope, view, updated) VALUES ('u_rando', 'p/frog-room', 'gallery', 1)");

  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const id = req.get("x-test-user"); req.user = id ? users.get(id) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; res.locals.ogPath = req.originalUrl.split("?")[0]; next(); });
  pads.register(app);
  PAD.register(app, { addUser });
  require(path.join(repo, "padsettings")).register(app, { addUser });
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  app.get("/p/:slug", (req, res) => res.status(200).send("pad " + req.params.slug));
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });

test("slug rules: folded input, length, charset, reserved words, prefixes", () => {
  assert.equal(PAD.fold("  My Cool_Pad  "), "my-cool-pad");
  assert.equal(PAD.fold("p/Some--Thing"), "some-thing");
  assert.equal(PAD.formProblem("ok-pad"), null);
  assert.match(PAD.formProblem("ab"), /At least 3/);
  assert.match(PAD.formProblem("a".repeat(33)), /At most 32/);
  assert.match(PAD.formProblem("bad!slug"), /Letters a-z/);
  assert.match(PAD.formProblem("-edge"), /Letters a-z/);
  assert.match(PAD.formProblem("12345"), /at least one letter/);
  for (const r of ["admin", "new", "settings", "pepe", "patv", "camfrog", "api", "feed", "stage"]) assert.match(PAD.formProblem(r), /reserved/, r);
  assert.match(PAD.formProblem("u-someone"), /member profiles/);
  assert.match(PAD.formProblem("patv-news"), /reserved for the site/);
});

test("uniqueness: another pad's slug, an id-based slug, another Camfrog room's bridge slug", async () => {
  const R = await rooms.get("Frog.Room");
  assert.match((await PAD.check("patv-other", R.id)).problem || "", /reserved for the site/);                // patv:other's slug
  assert.match((await PAD.check("taken-room", R.id)).problem || "", /Another pad/);
  assert.match((await PAD.check("swamp-things", R.id)).problem || "", /Camfrog room Pepe is in/);
  assert.equal((await PAD.check("lily-pond", R.id)).problem, null, "its own bridge slug is fine");
  assert.equal((await PAD.check("the-frog-pond", R.id)).problem, null);
});

test("owner rename: alias kept, slug_set, logged, feed views moved, bridge shows the new slug", async () => {
  const out = await PAD.rename(U.owner, "Frog.Room", "The Frog Pond", { now: Date.UTC(2026, 9, 1) });
  assert.equal(out.slug, "the-frog-pond");
  assert.equal(out.slug_set, true);
  const al = await getQuery("SELECT slug FROM pad_slug_aliases WHERE room_id = 'Frog.Room' ORDER BY slug");
  assert.deepEqual(al.map((a) => a.slug), ["frog-room", "lily-pond"], "the registry slug and the bridge's display-name slug both redirect");
  const evs = await getQuery("SELECT what, actor, detail FROM room_events WHERE room_id = 'Frog.Room' AND what = 'pad-address'");
  assert.equal(evs.length, 1);
  assert.equal(evs[0].actor, "padowner");
  assert.match(evs[0].detail, /p\/frog-room -> p\/the-frog-pond/);
  const audit = await require(path.join(repo, "feedstore")).roomAudit("Frog.Room");
  assert.ok(audit.some((a) => a.what === "pad-address"), "the rename is in the pad's audit (mod) log");
  assert.equal((await getQuery("SELECT scope FROM feed_view WHERE user_id = 'u_rando'"))[0].scope, "p/the-frog-pond");
  assert.equal(bridge._rooms.get("Frog.Room").slug, "the-frog-pond");
  assert.equal(require(path.join(repo, "roomsweb")).linkSlug(await rooms.get("Frog.Room")), "the-frog-pond");
  assert.equal(pads.padSlug(await rooms.get("Frog.Room")), "the-frog-pond");
  // every old slug still finds the pad (APIs) and the bridge's live room
  for (const s of ["frog-room", "lily-pond", "the-frog-pond"]) {
    assert.equal((await rooms.bySlug(s)).id, "Frog.Room", s);
    assert.equal(bridge.bySlug(s).id, "Frog.Room", s);
  }
  // ...and nobody else can take them
  assert.match((await PAD.check("frog-room", "patv:other")).problem || "", /belonged to another pad/);
});

test("the owner waits 30 days between renames; staff don't; others can't; taking an old slug back", async () => {
  const day = 24 * 3600e3, t0 = Date.UTC(2026, 9, 1);
  await assert.rejects(PAD.rename(U.owner, "Frog.Room", "frog-pond-two", { now: t0 + 5 * day }), /again on 2026-10-31/);
  await assert.rejects(PAD.rename(U.rando, "Frog.Room", "mine-now", { now: t0 + 40 * day }), /Only this pad's owner/);
  await assert.rejects(PAD.rename(U.other, "Frog.Room", "mine-now", { now: t0 + 40 * day }), /Only this pad's owner/);
  const a = await PAD.rename(U.admin, "Frog.Room", "frog-pond-two", { now: t0 + 6 * day });
  assert.equal(a.slug, "frog-pond-two");
  // back to an old one (after the wait): the alias goes, the slug comes back
  const b = await PAD.rename(U.owner, "Frog.Room", "frog-room", { now: t0 + 6 * day + 31 * day });
  assert.equal(b.slug, "frog-room");
  const al = (await getQuery("SELECT slug FROM pad_slug_aliases WHERE room_id = 'Frog.Room'")).map((x) => x.slug).sort();
  assert.deepEqual(al, ["frog-pond-two", "lily-pond", "the-frog-pond"]);
  await assert.rejects(PAD.rename(U.admin, "Frog.Room", "frog-room"), /already this pad's address/);
});

test("profile pads have no address of their own", async () => {
  const P = await rooms.ensureProfile(U.rando.userId);
  await assert.rejects(PAD.rename(U.rando, P.id, "rando-pad"), /profile's address/);
});

test("old URLs 301 to the current address, query kept; p/<old> autolinks to it", async () => {
  let r = await call("GET", "/p/the-frog-pond", null);
  assert.equal(r.status, 301);
  assert.equal(r.location, "/p/frog-room");
  r = await call("GET", "/p/lily-pond/settings?tab=stage", null);
  assert.equal(r.status, 301);
  assert.equal(r.location, "/p/frog-room/settings?tab=stage");
  r = await call("GET", "/rooms/frog-pond-two?sort=new", null);
  assert.equal(r.status, 301);
  assert.equal(r.location, "/p/frog-room?sort=new");
  r = await call("GET", "/p/frog-room", null);
  assert.equal(r.status, 200);
  const html = pads.padRefs("see p/the-frog-pond and p/frog-room");
  assert.match(html, /href="\/p\/frog-room">p\/the-frog-pond</);
  assert.match(html, /href="\/p\/frog-room">p\/frog-room</);
});

test("HTTP: check + rename (JSON only, owner/staff), then the settings hub shows the Address section", async () => {
  let r = await call("GET", "/api/rooms/patv-other/address?slug=Fresh%20Name", U.other);
  assert.equal(r.status, 200);
  assert.deepEqual([r.d.slug, r.d.available, r.d.problem], ["fresh-name", true, null]);
  r = await call("GET", "/api/rooms/patv-other/address?slug=frog-room", U.other);
  assert.equal(r.d.available, false);
  r = await call("GET", "/api/rooms/patv-other/address?slug=x", U.rando);
  assert.equal(r.status, 403);
  r = await call("POST", "/api/rooms/patv-other/address", U.other, { slug: "fresh-name" }, { "content-type": "text/plain", "x-test-user": U.other.userId });
  assert.equal(r.status, 415);
  r = await call("POST", "/api/rooms/patv-other/address", U.other, { slug: "fresh-name" }, Object.assign(H(U.other), { "sec-fetch-site": "cross-site" }));
  assert.equal(r.status, 403);
  r = await call("POST", "/api/rooms/patv-other/address", U.other, { slug: "fresh-name" });
  assert.equal(r.status, 200);
  assert.equal(r.d.slug, "fresh-name");
  assert.equal(r.d.href, "/p/fresh-name/settings?tab=general#address");
  r = await call("GET", "/api/rooms/fresh-name/address?slug=another-one", U.other);
  assert.ok(r.d.can_rename_at > Date.now(), "the 30-day wait shows");
  r = await call("POST", "/api/rooms/fresh-name/address", U.other, { slug: "another-one" });
  assert.equal(r.status, 429);
  r = await call("GET", "/p/fresh-name/settings?tab=address", U.other);
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.match(r.text, /id="address"/);
  assert.match(r.text, /data-tab="address"/);
  assert.match(r.text, /<code>p\/patv-other<\/code>/, "the old address is listed");
  assert.match(r.text, /Next change possible on/);
});

test("admin settings: /pads/admin shows the card; only Admins save (values clamped); the limit follows the setting", async () => {
  const staff = await mkUser("staffer", { class: "Staff" });
  let r = await call("GET", "/pads/admin", U.admin);
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.match(r.text, /id="padsCfgForm"/);
  r = await call("POST", "/api/pads/admin/config", staff, { rename_days: 1 });
  assert.equal(r.status, 403);
  r = await call("POST", "/api/pads/admin/config", U.admin, { rename_days: 9999 });
  assert.equal(r.status, 200);
  assert.equal(r.d.config.rename_days, 365);
  r = await call("POST", "/api/pads/admin/config", U.admin, { rename_days: 0 });
  assert.equal(r.d.config.rename_days, 0);
  const R = await rooms.get("patv:other");
  assert.equal(await PAD.nextRenameAt(U.other, R), R.slug_changed_at, "0 days = no wait");
  await call("POST", "/api/pads/admin/config", U.admin, { rename_days: 30 });
});
