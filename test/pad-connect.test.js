// Offline tests for 1.99ja: connecting a pad to a platform (padconnect.js, padrekey.js).
//   - Camfrog: a code (PATV-XXXXXX), refusals (house room, a room whose pad has an owner, a non-site pad), proof by TOPIC (Pepe's
//     report or the site's own bridge check) = instant; proof by !verifypad = a site admin's review (instant when Pepe vouches
//     for one of his admins); wrong room / unknown / expired codes
//   - the re-key: the pad becomes the room's pad (id, platform) with its posts, follows, settings (feed_kv), visibility,
//     events and address; merging into the room's unowned pad (its posts stay, its old address redirects, the site pad's look wins)
//   - disconnect: back to a site pad (its old patv: id) with its feed; the room vault / activity stay with the room, the bridged
//     room gets a fresh unowned pad and never shows the pad's address
//   - Pepe joining: only opted-in + approved by a site Admin (queues a room.visit action); visits for unverified rooms
//   - Twitch: the owner's linked Twitch login, one pad per channel, the Live tab player, disconnect; Discord: 501
//   - HTTP: owner routes (JSON + same-site), the admin queue, Pepe's /api/pads/verify (bot token) and pad_verify on the owner sync
//   NODE_PATH=G:/PATV/node_modules node --test test/pad-connect.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pad-connect-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const PC = require(path.join(repo, "padcreate"));
const CN = require(path.join(repo, "padconnect"));
const PA = require(path.join(repo, "padaccess"));
const bridge = require(path.join(repo, "bridge"));
const store = require(path.join(repo, "feedstore"));
require(path.join(repo, "terms"))._setRequired(false);

const users = new Map();
const U = {};
async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, camfrogUsername, twitchId, twitchLogin, level, created_at, points_balance)
                  VALUES (?, ?, ?, 'x', ?, ?, ?, ?, 5, '2026-01-01 00:00:00', 100000)`,
                 [id, name, name, extra.class || "pleb", extra.camfrog || null, extra.twitchId || null, extra.twitchLogin || null]);
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
const ev = (room, type, data) => ({ op: "event", id: "pc-" + (++seq), ts: new Date().toISOString(), type, scope: { platform: "camfrog", room }, data });
const live = (id, name, topic) => bridge.ingest({ rooms: [{ room: { id, name }, topic: topic || "", count: 2, members: [], mic: [] }] });
async function mkPad(owner, title, extra = {}) {
  PC._resetRecent();
  return PC.create(owner, { title, ...extra });
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT, twitchLogin TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await require(path.join(repo, "media")).ready;
  await require(path.join(repo, "inbox")).ready;
  U.owner = await mkUser("padowner", { camfrog: "ownercf", twitchId: "tw1", twitchLogin: "owlstream" });
  U.other = await mkUser("otherowner", { camfrog: "othercf", twitchId: "tw2" });
  U.third = await mkUser("thirdowner", { camfrog: "thirdcf", twitchId: "tw3", twitchLogin: "owlstream" });
  U.admin = await mkUser("siteadmin", { class: "Admin" });
  U.staff = await mkUser("staffer", { class: "Staff" });
  U.rando = await mkUser("rando", { camfrog: "randocf" });
  await rooms.init();
  await require(path.join(repo, "padcfg")).set({ create_max_per_user: 10 }, "test");
  await PA.init();
  await store.init();
  await bridge.load();
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const id = req.get("x-test-user"); req.user = id ? users.get(id) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; res.locals.ogPath = req.originalUrl.split("?")[0]; next(); });
  require(path.join(repo, "pads")).register(app);
  require(path.join(repo, "padaddress")).register(app, { addUser });
  CN.register(app, { addUser, isBotToken: (t) => t === "bot", noTimers: true });
  require(path.join(repo, "padsettings")).register(app, { addUser });
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  require(path.join(repo, "actions")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  bridge.register(app, { addUser, isBotToken: (t) => t === "bot" });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });

test("request: a PATV-XXXXXX code for a site pad; house rooms, owned rooms and non-site pads are refused", async () => {
  const P = await mkPad(U.owner, "Night Owls");
  const c = await CN.requestCamfrog(U.owner, P, { room: "Night Owls Lounge", join: true });
  assert.match(c.code, /^PATV-[A-Z2-9]{6}$/);
  assert.deepEqual([c.status, c.external_name, c.join_opt_in], ["pending", "Night Owls Lounge", true]);
  await assert.rejects(CN.requestCamfrog(U.owner, P, { room: "PepeFrog.Room" }), /Pepe's own room/);
  await rooms.addRoom("Owned.Room", "Owned", "test");
  await rooms.setOwner("Owned.Room", "otherowner", "test");
  await assert.rejects(CN.requestCamfrog(U.owner, P, { room: "Owned.Room" }), /already has an owner/);
  await assert.rejects(CN.requestCamfrog(U.rando, P, { room: "Whatever" }), /Only this pad's owner/);
  await assert.rejects(CN.requestCamfrog(U.owner, P, { room: "<script>" }), /Type the Camfrog room's name/);
  // a new code replaces the pending one
  const c2 = await CN.requestCamfrog(U.owner, P, { room: "Night Owls Lounge", join: true });
  assert.notEqual(c2.code, c.code);
  assert.equal((await getQuery("SELECT status FROM pad_connections WHERE code = ?", [c.code]))[0].status, "cancelled");
  assert.deepEqual((await CN.pendingForPepe()).map((x) => x.code), [c2.code]);
});

test("topic proof (Pepe's report): the pad becomes the room's pad with its posts, follows, settings, visibility, events and address", async () => {
  const P = await rooms.bySlug("night-owls");
  const oldId = P.id;
  // things hanging off the site pad
  const post = await store.create(U.owner.userId, { community: oldId, title: "first owl post", body: "hoot" });
  await runQuery("INSERT INTO follows (follower, target_kind, target_id, created_at) VALUES ('u_rando', 'room', ?, 1)", [oldId]).catch(async () => {
    await require(path.join(repo, "follows")).init();
    await runQuery("INSERT INTO follows (follower, target_kind, target_id, created_at) VALUES ('u_rando', 'room', ?, 1)", [oldId]);
  });
  await store.kvSet("rules:" + oldId, JSON.stringify({ rules: [{ title: "be nice" }] }));
  await PA.setLevel(U.owner, P, "public");
  const c = await CN.current(oldId, "camfrog");
  // Pepe sees the code in the topic of "Night Owls Lounge" (id Night.Room)
  let r = await CN.verifyFromPepe({ via: "topic", room: "Night.Room", room_name: "Night Owls Lounge", code: c.code.toLowerCase(), topic: "welcome " + c.code });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.status, "verified");
  const R = await rooms.get("Night.Room");
  assert.deepEqual([R.slug, R.platform, R.title, R.owner.userId], ["night-owls", "camfrog", "Night Owls", U.owner.userId]);
  assert.equal(await rooms.get(oldId), null, "the patv: id is gone");
  assert.equal((await getQuery("SELECT room_id FROM feed_post_rooms WHERE post_id = ?", [post.id]))[0].room_id, "Night.Room");
  assert.equal((await getQuery("SELECT home_pad FROM feed_posts WHERE id = ?", [post.id]))[0].home_pad, "Night.Room");
  assert.equal((await getQuery("SELECT target_id FROM follows WHERE follower = 'u_rando'"))[0].target_id, "Night.Room");
  assert.match(await store.kvGet("rules:Night.Room"), /be nice/);
  assert.equal(await store.kvGet("rules:" + oldId), null);
  assert.equal(PA.levelOf("Night.Room"), "public", "visibility moved (cache reloaded)");
  assert.ok((await getQuery("SELECT 1 FROM room_events WHERE room_id = 'Night.Room' AND what = 'pad-created'")).length, "its events came along");
  assert.ok((await getQuery("SELECT 1 FROM room_events WHERE room_id = 'Night.Room' AND what = 'pad-connected'")).length);
  const conn = await CN.current("Night.Room", "camfrog");
  assert.deepEqual([conn.status, conn.method, conn.external_id, conn.orig_id, conn.join_status], ["verified", "topic", "Night.Room", oldId, "requested"]);
  assert.equal((await rooms.ownersForPepe()).find((x) => x.id === "Night.Room").owner.camfrog, "ownercf", "Pepe's owner sync knows the owner");
  // the same code again does nothing
  r = await CN.verifyFromPepe({ via: "topic", room: "Night.Room", room_name: "Night Owls Lounge", code: c.code });
  assert.equal(r.ok, false);
});

test("!verifypad: review for a site admin (instant for one of Pepe's admins); wrong room, unknown and expired codes", async () => {
  const P = await mkPad(U.other, "Swamp Club");
  const c = await CN.requestCamfrog(U.other, P, { room: "Swamp_Club" });
  let r = await CN.verifyFromPepe({ via: "command", room: "Other.Room", room_name: "Other", code: c.code, by: "othercf" });
  assert.match(r.message, /for the room "Swamp_Club"/);
  r = await CN.verifyFromPepe({ via: "command", room: "Swamp_Club", room_name: "Swamp Club!", code: "PATV-ZZZZZZ", by: "othercf" });
  assert.match(r.message, /no pad is waiting/);
  r = await CN.verifyFromPepe({ via: "command", room: "Swamp_Club", room_name: "Swamp Club!", code: c.code, by: "othercf" });
  assert.deepEqual([r.ok, r.status], [true, "review"]);
  assert.match(r.message, /a site admin will confirm/);
  const cur = await CN.current(P.id, "camfrog");
  assert.deepEqual([cur.status, cur.evidence.command.by, cur.evidence.command.owner_login], ["review", "othercf", true]);
  assert.equal((await rooms.get(P.id)).platform, "site", "not connected yet");
  const q = await CN.queueList();
  assert.ok(q.some((x) => x.id === cur.id && x.status === "review"));
  // a site admin approves (Pepe's evidence gave the room id)
  await assert.rejects(CN.adminOp(U.rando, cur.id, "approve"), /Site staff only/);
  const out = await CN.adminOp(U.staff, cur.id, "approve");
  assert.equal(out.pad.id, "Swamp_Club");
  assert.equal(out.pad.platform, "camfrog");
  // Pepe vouching for one of his admins = instant; an expired code is refused
  const P2 = await mkPad(U.third, "Bog Hall");
  const c2 = await CN.requestCamfrog(U.third, P2, { room: "Bog.Hall" });
  r = await CN.verifyFromPepe({ via: "command", room: "Bog.Hall", room_name: "Bog Hall", code: c2.code, by: "someop", admin: true });
  assert.deepEqual([r.ok, r.status], [true, "verified"]);
  const P3 = await mkPad(U.rando, "Late Pad");
  const c3 = await CN.requestCamfrog(U.rando, P3, { room: "Late.Room" });
  CN._setClock(() => Date.now() + 49 * 3600e3);
  r = await CN.verifyFromPepe({ via: "topic", room: "Late.Room", room_name: "Late", code: c3.code });
  CN._setClock(null);
  assert.match(r.message, /expired/);
});

test("merge: connecting to a room that already has an UNOWNED pad keeps its posts, redirects its address, the site pad's look wins", async () => {
  await rooms.addRoom("Merge.Room", "Merge Room", "test");           // what the bridge registers on its own (no owner)
  const old = await store.create(U.rando.userId, { community: "Merge.Room", title: "room post from before", body: "x" });
  PC._resetRecent();
  const P = await PC.create(U.admin, { title: "Merged Pad" });        // staff: no cap
  await rooms.setOwner(P.id, "rando", "test");
  const P2 = await rooms.get(P.id);
  await runQuery("INSERT INTO pad_looks (room_id, accent, updated) VALUES (?, '#ff0000', 1)", [P.id]).catch(async () => {
    await require(path.join(repo, "padlook")).init();
    await runQuery("INSERT INTO pad_looks (room_id, accent, updated) VALUES (?, '#ff0000', 1)", [P.id]);
  });
  await runQuery("INSERT INTO pad_looks (room_id, accent, updated) VALUES ('Merge.Room', '#00ff00', 1)");
  const c = await CN.requestCamfrog(U.rando, P2, { room: "Merge.Room" });
  const r = await CN.verifyFromPepe({ via: "topic", room: "Merge.Room", room_name: "Merge Room", code: c.code });
  assert.equal(r.ok, true, r.message);
  const R = await rooms.get("Merge.Room");
  assert.deepEqual([R.slug, R.owner.username, R.platform], ["merged-pad", "rando", "camfrog"]);
  assert.equal((await getQuery("SELECT room_id FROM feed_post_rooms WHERE post_id = ?", [old.id]))[0].room_id, "Merge.Room", "the room's posts stay");
  assert.equal(require(path.join(repo, "pads")).currentSlugFor("merge-room"), "merged-pad", "the room's old address redirects");
  const red = await call("GET", "/p/merge-room?tab=feed", null);
  assert.deepEqual([red.status, red.location], [301, "/p/merged-pad?tab=feed"]);
  assert.equal((await getQuery("SELECT accent FROM pad_looks WHERE room_id = 'Merge.Room'"))[0].accent, "#ff0000");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM rooms_registry WHERE room_id = 'Merge.Room'"))[0].n, 1);
});

test("site topic check: a bridged room's topic finishes a pending request (Check now)", async () => {
  const P = await mkPad(U.other, "Bridge Pad");
  await assert.rejects(CN.requestCamfrog(U.other, P, { room: "x" }), /Type the Camfrog room's name/);
  const c = await CN.requestCamfrog(U.other, P, { room: "Bridged Lily" });
  await live("Lily.Room", "Bridged Lily", "nothing yet");
  let r = await call("POST", "/api/rooms/bridge-pad/connect/camfrog/check", U.other, {});
  assert.deepEqual([r.status, r.d.done, r.d.bridged], [200, false, true]);
  await live("Lily.Room", "Bridged Lily", "hi " + c.code + " bye");
  r = await call("POST", "/api/rooms/bridge-pad/connect/camfrog/check", U.other, {});
  assert.equal(r.d.done, true, JSON.stringify(r.d));
  assert.equal((await rooms.get("Lily.Room")).slug, "bridge-pad");
  assert.equal(bridge._rooms.get("Lily.Room").slug, "bridge-pad", "the bridge shows the pad's address");
});

test("Pepe joining: opted in + a site Admin's OK queues room.visit [name, stay]; Staff can't send Pepe; visits for waiting rooms", async () => {
  const conn = await CN.current("Night.Room", "camfrog");
  assert.equal(conn.join_status, "requested");
  await assert.rejects(CN.adminOp(U.staff, conn.id, "join"), /Only site Admins/);
  const out = await CN.adminOp(U.admin, conn.id, "join");
  assert.ok(out.action);
  const a = (await getQuery("SELECT kind, args, site_admin FROM pepe_actions WHERE id = ?", [out.action]))[0];
  assert.deepEqual([a.kind, JSON.parse(a.args), a.site_admin], ["room.visit", ["Night Owls Lounge", "stay"], 1]);
  assert.equal((await CN.current("Night.Room", "camfrog")).join_status, "approved");
  // a room that didn't ask can't get Pepe; a waiting request can get a visit
  const sw = await CN.current("Swamp_Club", "camfrog");
  await assert.rejects(CN.adminOp(U.admin, sw.id, "join"), /owner asked/);
  const P = await mkPad(U.third, "Visit Me");
  const c = await CN.requestCamfrog(U.third, P, { room: "Far Away Room" });
  const v = await CN.adminOp(U.admin, c.id, "visit");
  assert.deepEqual(JSON.parse((await getQuery("SELECT args FROM pepe_actions WHERE id = ?", [v.action]))[0].args), ["Far Away Room", "visit"]);
  await assert.rejects(CN.adminOp(U.admin, c.id, "approve"), /Pepe hasn't seen that room yet/);
  await CN.adminOp(U.admin, c.id, "deny", { note: "not your room" });
  assert.equal((await CN.current(P.id, "camfrog")), null);
});

test("disconnect: back to its old site id with its feed; the room keeps its vault + activity and gets its own unowned pad", async () => {
  await runQuery("INSERT INTO room_vault_state (room_id, balance, updated) VALUES ('Lily.Room', 777, 1)").catch(async () => {
    await require(path.join(repo, "roomvaults")).init();
    await runQuery("INSERT INTO room_vault_state (room_id, balance, updated) VALUES ('Lily.Room', 777, 1)");
  });
  await rooms.noteActivity("Lily.Room", 3, 2);
  const post = await store.create(U.other.userId, { community: "Lily.Room", title: "lily post", body: "y" });
  const conn = await CN.current("Lily.Room", "camfrog");
  const R = await rooms.get("Lily.Room");
  await assert.rejects(CN.disconnect(U.rando, R, "camfrog"), /Only this pad's owner/);
  const P = await CN.disconnect(U.other, R, "camfrog");
  assert.equal(P.id, conn.orig_id, "its old patv: id when it's free");
  assert.deepEqual([P.platform, P.slug, P.owner.username], ["site", "bridge-pad", "otherowner"]);
  assert.equal((await getQuery("SELECT room_id FROM feed_post_rooms WHERE post_id = ?", [post.id]))[0].room_id, P.id, "the feed comes along");
  assert.equal((await getQuery("SELECT balance FROM room_vault_state WHERE room_id = 'Lily.Room'"))[0].balance, 777, "the vault stays with the room");
  assert.ok((await getQuery("SELECT 1 FROM room_activity WHERE room_id = 'Lily.Room'")).length, "activity stays with the room");
  const fresh = await rooms.get("Lily.Room");
  assert.ok(fresh && !fresh.owner && fresh.platform === "camfrog", "Pepe's still in it: a fresh unowned pad");
  assert.notEqual(bridge._rooms.get("Lily.Room").slug, "bridge-pad", "the room never shows the pad's address");
  assert.equal(bridge.bySlug("bridge-pad"), null);
  assert.equal((await rooms.bySlug("bridge-pad")).id, P.id);
  assert.equal((await CN.current(P.id, "camfrog")), null);
  assert.equal((await getQuery("SELECT status FROM pad_connections WHERE id = ?", [conn.id]))[0].status, "disconnected");
});

test("Twitch: the owner's linked login (one pad per channel), the Live tab player, disconnect; Discord is 'coming later'", async () => {
  const P = await mkPad(U.owner, "Owl TV");
  const Q = await mkPad(U.other, "No Login TV");
  await assert.rejects(CN.connectTwitch(U.other, Q), /Sign in with Twitch once more/);
  let r = await call("POST", "/api/rooms/owl-tv/connect/twitch", U.owner, {});
  assert.equal(r.status, 200, r.text);
  const R = await rooms.get(P.id);
  assert.equal(R.platform, "twitch");
  assert.deepEqual(await CN.twitchOf(P.id), { login: "owlstream", chat_bridge: false });
  assert.deepEqual(await CN.twitchChatHook(P.id), { login: "owlstream", enabled: false });
  const T = await mkPad(U.third, "Copy TV");
  await assert.rejects(CN.connectTwitch(U.third, T), /already connected to another pad/);
  await assert.rejects(CN.requestCamfrog(U.owner, R, { room: "Some.Room" }), /Disconnect this pad from twitch first/);
  r = await call("GET", "/p/owl-tv", U.rando);
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.match(r.text, /player\.twitch\.tv\/\?channel=owlstream&amp;parent=/);
  r = await call("POST", "/api/rooms/owl-tv/connect/discord", U.owner, {});
  assert.equal(r.status, 501);
  r = await call("POST", "/api/rooms/owl-tv/disconnect", U.owner, { platform: "twitch" });
  assert.equal(r.status, 400, "needs confirm");
  r = await call("POST", "/api/rooms/owl-tv/disconnect", U.owner, { platform: "twitch", confirm: true });
  assert.equal(r.d.platform, "site");
  assert.equal(await CN.twitchOf(P.id), null);
});

test("HTTP: settings card, owner routes (JSON + same-site), admin queue, Pepe's verify (bot token) + pad_verify on the owner sync", async () => {
  let r = await call("GET", "/p/owl-tv/settings?tab=address", U.owner);
  assert.equal(r.status, 200, r.text.slice(0, 300));
  assert.match(r.text, /id="connections"/);
  assert.match(r.text, /Get a verification code/);
  assert.match(r.text, /Discord server/);
  r = await call("POST", "/api/rooms/owl-tv/connect/camfrog", U.owner, { room: "Owl Room" }, { "content-type": "text/plain", "x-test-user": U.owner.userId });
  assert.equal(r.status, 415);
  r = await call("POST", "/api/rooms/owl-tv/connect/camfrog", U.owner, { room: "Owl Room" }, Object.assign(H(U.owner), { "sec-fetch-site": "cross-site" }));
  assert.equal(r.status, 403);
  r = await call("POST", "/api/rooms/owl-tv/connect/camfrog", U.owner, { room: "Owl Room", join: false });
  assert.equal(r.status, 200, r.text);
  const code = r.d.camfrog.code;
  r = await call("GET", "/p/owl-tv/settings?tab=address", U.owner);
  assert.ok(r.text.includes(code), "the code is on the card");
  r = await call("GET", "/api/rooms/owl-tv/connect", U.rando);
  assert.equal(r.status, 403);
  r = await call("GET", "/api/pads/connections", U.rando);
  assert.equal(r.status, 403);
  r = await call("GET", "/api/pads/connections", U.staff);
  assert.ok(r.d.items.some((x) => x.code === code));
  r = await call("POST", "/api/rooms/owners", null, { password: "bot" });
  assert.ok(r.d.pad_verify.some((x) => x.code === code && x.room === "Owl Room"));
  r = await call("POST", "/api/pads/verify", null, { password: "nope", code, room: "Owl.Room", via: "topic" });
  assert.equal(r.status, 403);
  r = await call("POST", "/api/pads/verify", null, { password: "bot", code, room: "Owl_Room", room_name: "Owl Room", via: "topic", topic: code });
  assert.equal(r.d.ok, true, JSON.stringify(r.d));
  assert.equal((await rooms.get("Owl_Room")).slug, "owl-tv");
  r = await call("GET", "/pads/admin", U.admin);
  assert.equal(r.status, 200);
  assert.match(r.text, /id="padconn"/);
});
