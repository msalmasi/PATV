// 1.99?? Pepe account rotation, the SITE half (houserotate.js, rooms.js house room, padrekey.js, padaddress.renameInTx,
// tools/house-rotate.js): Pepe's house pad PepeFrog.Room "Pepe's Pad" (p/pepes-pad) moves to The_Swamp "The Swamp" (p/the-swamp).
//   - rooms.HOUSE_ROOM is a getter over rooms_kv house_room; retired house rooms; padconnect refuses them
//   - plan is read-only and counts what would move
//   - refusals: bad_request, not_house, retired_home, slug_taken, to_owned, to_has_data, open_slots, to_has_archive
//   - one transaction: a throw midway changes nothing
//   - apply: the registry, every pad row (+ the gaps: modlog room_l, soundboard, casino wish, media requests, AI prices, pad art),
//     the room's evidence kept (D4), the seeded marker, the vault re-key row, the archive (D1), title, address + aliases + 301s,
//     house_room, Pepe's logins, the rules intro + welcome post, the event / audit / journal; a stray pad folds in
//   - re-apply = already; seed() makes no ghost house pad; the HTTP route + the owner sync's identity / house_room
//   - restore_of: the round trip (and what it refuses after); a case-only fix
//   - review fixes: the room's privacy audit (seethrough_log) and where an on-air consent was asked (onair_consent.room) stay with
//     the Camfrog room (S11); a bot key of another caller is refused (S9); a SEEDS id gets its marker even without a seeded: row (F8)
//   TZ=UTC NODE_PATH=G:/PATV/node_modules node --test test/houserotate.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "houserotate-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.STAGE_DEFAULT_ROOM;
delete process.env.CHATLOG_DB;
delete process.env.PEPE_LOGINS;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
fs.mkdirSync(process.env.MEDIA_DIR, { recursive: true });
const express = require("express");
const { runQuery, getQuery, tx: dbTx } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const H = require(path.join(repo, "houserotate"));
const PL = require(path.join(repo, "pepelogins"));
const RK = require(path.join(repo, "padrekey"));
const CN = require(path.join(repo, "padconnect"));
const A = require(path.join(repo, "padaddress"));
const bridge = require(path.join(repo, "bridge"));
const store = require(path.join(repo, "feedstore"));
require(path.join(repo, "terms"))._setRequired(false);

const OLD = "PepeFrog.Room", NEW = "The_Swamp";
const users = new Map();
const U = {};
async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, camfrogUsername, level, created_at, points_balance)
                  VALUES (?, ?, ?, 'x', ?, ?, 5, '2026-01-01 00:00:00', 100000)`, [id, name, name, extra.class || "pleb", extra.camfrog || null]);
  const u = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, u);
  return u;
}
let base, server;
async function call(method, url, body, headers) {
  const r = await fetch(base + url, { method, headers: headers || { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const text = await r.text();
  let d = null;
  try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, d, location: r.headers.get("location") };
}
const one = async (sql, p = []) => (await getQuery(sql, p))[0] || null;
const n = async (sql, p = []) => Number((await one(sql, p) || {}).n) || 0;
const kv = async (k) => { const r = await one("SELECT value FROM rooms_kv WHERE key = ?", [k]); return r ? r.value : null; };
const fkv = async (k) => { const r = await one("SELECT value FROM feed_kv WHERE key = ?", [k]); return r ? r.value : null; };
/** what a rotation can write, in full - "nothing changed" (other modules' own background writes - achievements, gifts - left out) */
const SNAP = ["rooms_registry", "pad_slug_aliases", "rooms_kv", "feed_kv", "test_pad_rows", "pepe_modlog", "bridge_spans", "livecam_audit", "sb_clips",
              "backend_wants", "media_requests", "premium_subs", "follows", "feed_seen", "feed_view", "chatlog_rooms", "chatlog_meta", "escrow_meta",
              "oracle_meta", "pad_vault_rekeys", "house_rotations", "admin_audit", "pad_connections"];
async function snapshot() {
  const have = new Set((await getQuery("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name));
  const out = {};
  for (const t of SNAP) out[t] = have.has(t) ? JSON.stringify(await getQuery(`SELECT * FROM "${t}" ORDER BY rowid`)) : null;
  out.feed_posts = JSON.stringify(await getQuery("SELECT id, title, body, home_pad FROM feed_posts ORDER BY id"));
  out.room_events = (await one("SELECT COUNT(*) AS n FROM room_events WHERE what = 'house-rotated'")).n;
  return out;
}
const FWD = { from: { room: OLD, login: "PepeFrog" }, to: { room: NEW, title: "The Swamp", slug: "the-swamp", login: "Pepe_Frog" }, actor: "pepe:owner" };
const WELCOME_BODY = "This is my pad.\n\nPad rules: /p/pepes-pad?tab=about#rules · Help: /help · the older one: p/pepes-pad-2";
let LINES = 0;

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT, twitchLogin TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  await require(path.join(repo, "media")).ready;
  await require(path.join(repo, "inbox")).ready;
  U.owner = await mkUser("padowner", { camfrog: "ownercf" });
  U.admin = await mkUser("siteadmin", { class: "Admin" });
  await rooms.init();
  await require(path.join(repo, "padaccess")).init();
  await store.init();
  await bridge.load();
  await require(path.join(repo, "mainstage")).init();
  await require(path.join(repo, "premium")).init();
  await require(path.join(repo, "follows")).init();
  await require(path.join(repo, "feedseen")).init();
  await require(path.join(repo, "feedgallery")).init();
  await require(path.join(repo, "pepemodlog")).init();
  await require(path.join(repo, "bridgespans")).init();
  await require(path.join(repo, "chatlog")).init();
  await require(path.join(repo, "adminaudit")).init();
  // tables only this test touches (minimal shapes of the real ones) + a generic pad table padrekey finds by its column name
  await runQuery("CREATE TABLE IF NOT EXISTS livecam_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, target TEXT NOT NULL, at INTEGER)");
  await runQuery("CREATE TABLE IF NOT EXISTS sb_clips (id TEXT PRIMARY KEY, board TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active')");
  await runQuery("CREATE TABLE IF NOT EXISTS backend_wants (feature TEXT PRIMARY KEY, want INTEGER NOT NULL, at INTEGER NOT NULL)");
  await runQuery("CREATE TABLE IF NOT EXISTS media_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, pad_id TEXT)");
  await runQuery("CREATE TABLE IF NOT EXISTS escrow_meta (key TEXT PRIMARY KEY, value TEXT)");
  await runQuery("CREATE TABLE IF NOT EXISTS oracle_meta (key TEXT PRIMARY KEY, value TEXT)");
  await runQuery("CREATE TABLE test_pad_rows (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT, note TEXT)");
  // review S11: minimal shapes of seethrough.js / onairconsent.js
  await runQuery("CREATE TABLE IF NOT EXISTS seethrough_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, scope TEXT NOT NULL, room_id TEXT)");
  await runQuery("CREATE TABLE IF NOT EXISTS onair_consent (id TEXT PRIMARY KEY, kind TEXT NOT NULL, pad TEXT, room TEXT, status TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL)");
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const id = req.get("x-test-user"); req.user = id ? users.get(id) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; res.locals.ogPath = req.originalUrl.split("?")[0]; next(); });
  require(path.join(repo, "pads")).register(app);
  require(path.join(repo, "padaddress")).register(app, { addUser });
  CN.register(app, { addUser, isBotToken: (t) => t === "bot", noTimers: true });
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;

  // ── prod's house pad, as on 2026-11-10 ──
  // the seed made PepeFrog.Room "Pepe's Pad" (slug pepefrog-room); its address followed the room's display name (pepes-pad)
  await rooms.followName(OLD, "Pepe's Pad", { force: true, holder: () => null });
  const R = await rooms.get(OLD);
  assert.deepEqual([R.house, R.slug, R.title], [true, "pepes-pad", "Pepe's Pad"]);
  const t = Date.now();
  for (let i = 0; i < 3; i++) {
    await runQuery("INSERT INTO pepe_modlog (k, room_id, room_l, ts, type, cat) VALUES (?, ?, ?, ?, 'kick', 'mod')", ["k" + i, OLD, OLD.toLowerCase(), t]);
  }
  for (let i = 0; i < 4; i++) await runQuery("INSERT INTO test_pad_rows (room_id, note) VALUES (?, ?)", [OLD, "row " + i]);
  await runQuery("INSERT INTO test_pad_rows (room_id, note) VALUES ('Other.Room', 'not ours')");
  for (let i = 0; i < 2; i++) await runQuery("INSERT INTO bridge_spans (room_id, session, opened_at, last_seen, closed_at) VALUES (?, ?, ?, ?, ?)", [OLD, "s" + i, t, t, t + 1]);
  await runQuery("INSERT INTO livecam_audit (room_id, target, at) VALUES (?, 'cam', ?)", [OLD, t]);
  await runQuery("INSERT INTO seethrough_log (at, user_id, role, scope, room_id) VALUES (?, 'u_siteadmin', 'admin', 'room', ?)", [t, OLD]);
  await runQuery("INSERT INTO onair_consent (id, kind, pad, room, status, created, expires) VALUES ('oc1', 'cam', ?, ?, 'allowed', ?, ?)", [OLD, OLD, t, t + 1]);
  await runQuery("INSERT INTO sb_clips (id, board, label) VALUES ('c1', ?, 'Ribbit')", ["room:" + OLD]);
  await runQuery("INSERT INTO backend_wants (feature, want, at) VALUES (?, 1, ?)", ["casino:" + OLD, t]);
  await runQuery("INSERT INTO media_requests (title, pad_id) VALUES ('Charade', ?)", [OLD]);
  await runQuery("INSERT INTO follows (follower, target_kind, target_id, created_at) VALUES ('u_padowner', 'room', ?, ?)", [OLD, t]);
  await runQuery("INSERT INTO feed_seen (user_id, scope, upto, updated) VALUES ('u_padowner', ?, 1, 1)", ["pad:" + OLD]);
  await runQuery("INSERT INTO feed_view (user_id, scope, view, updated) VALUES ('u_padowner', 'p/pepes-pad', 'gallery', 1)");
  await runQuery(`INSERT INTO premium_subs (tier, target, paid_through, comped, status, started, updated) VALUES ('prime_plus', ?, 0, 1, 'active', ?, ?)`, [OLD, t, t]);
  await store.kvSet("rules:" + OLD, JSON.stringify({ intro: "Pepe's Pad is the house room: loud, friendly and a bit unhinged.", rules: [], updated: t, by: "x" }));
  await store.kvSet("aigen_prices", JSON.stringify({ global: { imagine: 50 }, rooms: { [OLD]: { imagine: 100 }, DRAMA_CENTRAL: { imagine: 70 } }, at: t }));
  await store.kvSet("mention_at:" + OLD, "123");
  await rooms.kvSet("pepespad:art:" + OLD, JSON.stringify({ avatar: "abc" }));
  await runQuery("INSERT INTO feed_posts (id, author_id, title, body, created, home_pad) VALUES ('w1', 'pepe-bot', ?, ?, ?, ?)",
                 ["\u{1F44B} Welcome to Pepe's Pad - start here", WELCOME_BODY, t, OLD]);
  await runQuery("INSERT INTO escrow_meta (key, value) VALUES ('pepe_login', ?)", [JSON.stringify("pepefrog")]);
  await runQuery("INSERT INTO oracle_meta (key, value) VALUES ('pepe_login', ?)", [JSON.stringify("pepefrog")]);
  // the house pad's chat archive (rk) with its tier
  await runQuery("INSERT INTO chatlog_rooms (room_id, pad_id, owner_id, owner_since, created) VALUES (?, ?, NULL, 0, ?)", [OLD, OLD, t]);
  const rk = (await one("SELECT rk FROM chatlog_rooms WHERE room_id = ?", [OLD])).rk;
  for (let i = 1; i <= 5; i++) {
    await runQuery("INSERT INTO chat_log (c, rk, ts, k, who, text, rt, aud, d) VALUES (?, ?, ?, 'msg', 'alice', ?, ?, 'p', '{}')", [1000 + i, rk, t + i, "line " + i, "r" + rk]);
  }
  LINES = 5;
  await runQuery("INSERT INTO chatlog_meta (key, value) VALUES (?, ?)", ["tier:" + OLD, JSON.stringify({ tier: "plus", lapsed: [] })]);
  // a stray pad at the new id: Pepe bridged The_Swamp before the rotation (unowned, no pad rows of its own), its slug swamp-old
  await rooms.addRoom(NEW, "The Swamp", "test");
  await runQuery("UPDATE rooms_registry SET slug = 'swamp-old' WHERE room_id = ?", [NEW]);
  await rooms.loadCache();
  await PL.refresh();
});
test.after(() => { server.close(); });

test("rooms.HOUSE_ROOM is a getter over rooms_kv house_room; retired house rooms; padconnect refuses them", async () => {
  assert.equal(rooms.HOUSE_ROOM, OLD, "unset: the literal default");
  assert.deepEqual(rooms.retiredHouseRooms(), ["PepeBeta.Room"]);
  await rooms.kvSet("house_room", JSON.stringify({ id: "Some.Room", title: "Some", slug: "some", since: 1, prev: [{ id: OLD, title: "Pepe's Pad", slug: "pepes-pad", until: "2026-11-10" }] }));
  await rooms.loadCache();
  try {
    assert.equal(rooms.HOUSE_ROOM, "Some.Room", "the kv wins, read at call time");
    assert.equal(rooms.houseRoom(), "Some.Room");
    assert.deepEqual(rooms.retiredHouseRooms().sort(), [OLD, "PepeBeta.Room"].sort());
    assert.ok(rooms.isPepeHome("pepefrog.room") && rooms.isPepeHome("SOME.ROOM") && !rooms.isPepeHome("Other.Room"));
    assert.ok(Object.keys(rooms).includes("HOUSE_ROOM"), "still enumerable");
    // a site pad can't be connected to any of Pepe's homes (padconnect.targetProblem)
    const PC = require(path.join(repo, "padcreate"));
    await require(path.join(repo, "padcfg")).set({ create_max_per_user: 10 }, "test");
    PC._resetRecent();
    const P = await PC.create(U.owner, { title: "Night Owls" });
    for (const id of ["Some.Room", "pepefrog.room", "PepeBeta.Room"]) {
      await assert.rejects(CN.requestCamfrog(U.owner, P, { room: id }), /Pepe's own room/, id);
    }
  } finally {
    await runQuery("DELETE FROM rooms_kv WHERE key = 'house_room'");
    await rooms.loadCache();
  }
  assert.equal(rooms.HOUSE_ROOM, OLD);
});

test("plan is read-only and counts what would move", async () => {
  const before = await snapshot();
  const p = await H.plan(FWD);
  assert.deepEqual(await snapshot(), before, "nothing written");
  assert.equal(p.ok, true, JSON.stringify(p.refusal));
  assert.deepEqual([p.mode, p.already, p.house, p.key], ["move", false, OLD, "rot-" + new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-the_swamp"]);
  assert.deepEqual([p.from.title, p.from.slug, p.to.title, p.to.slug], ["Pepe's Pad", "pepes-pad", "The Swamp", "the-swamp"]);
  assert.equal(p.counts.move["test_pad_rows.room_id"], 4);
  assert.equal(p.counts.move["pepe_modlog.room_id"], 3);
  assert.equal(p.counts.extra["pepe_modlog.room_l"], 3);
  assert.deepEqual(p.counts.keep, { "bridge_spans.room_id": 2, "livecam_audit.room_id": 1, "seethrough_log.room_id": 1, "onair_consent.room": 1 });
  assert.equal(p.counts.move["onair_consent.pad"], 1, "the consent ask's pad column moves with the pad (S11)");
  for (const k of ["sb_clips.board", "backend_wants.feature", "media_requests.pad_id", "feed_kv.aigen_prices", "rooms_kv.pepespad:art:",
                   "rooms_kv.seeded", "follows.target_id", "feed_seen.scope", "premium_subs.target", "feed_kv.rules:", "feed_kv.mention_at:"]) {
    assert.equal(p.counts.extra[k], 1, k);
  }
  assert.equal(p.counts.vault_rekey, 1);
  assert.deepEqual(p.stray, { room: NEW, slug: "swamp-old", title: "The Swamp" });
  assert.equal(p.archive.mode, "move");
  assert.equal(p.archive.from.lines, LINES);
  assert.deepEqual(p.address.aliases_after, ["pepefrog-room", "pepes-pad", "swamp-old"]);
  assert.deepEqual(p.text, { rules_intro: true, welcome_post: "w1" });
  assert.deepEqual(p.logins.after, { current: "pepe_frog", former: ["pepefrog"] });
});

test("refusals: bad requests, not the house, a retired home, a taken address, an owned / busy target, open slots, a target archive", async () => {
  const before = await snapshot();
  const refused = async (body, code) => {
    const p = await H.plan(body);
    assert.equal(p.refusal && p.refusal.code, code, JSON.stringify(p.refusal));
    await assert.rejects(H.apply(body, { live: false }), (e) => e.code === code && e.status >= 400, code);
  };
  await assert.rejects(H.plan({ ...FWD, to: { ...FWD.to, login: "" } }), (e) => e.code === "bad_request");
  await assert.rejects(H.plan({ ...FWD, to: { ...FWD.to, room: "patv:lounge" } }), (e) => e.code === "bad_request");
  await assert.rejects(H.plan({ ...FWD, archive: "nope" }), (e) => e.code === "bad_request");
  await rooms.addRoom("Owned.Room", "Owned", "test");
  await rooms.setOwner("Owned.Room", "padowner", "test");
  await refused({ ...FWD, from: { room: "Owned.Room" } }, "not_house");
  await refused({ ...FWD, to: { ...FWD.to, room: "PepeBeta.Room" } }, "retired_home");
  await refused({ ...FWD, to: { ...FWD.to, slug: "owned-room" } }, "slug_taken");
  await refused({ ...FWD, to: { ...FWD.to, slug: "patv-lounge" } }, "bad_slug");
  await refused({ ...FWD, to: { ...FWD.to, room: "Owned.Room" } }, "to_owned");
  await rooms.addRoom("Busy.Room", "Busy", "test");
  await runQuery("INSERT INTO test_pad_rows (room_id, note) VALUES ('Busy.Room', 'its own')");
  const busy = await H.plan({ ...FWD, to: { ...FWD.to, room: "Busy.Room", slug: "busy-new" } });
  assert.equal(busy.refusal.code, "to_has_data");
  assert.deepEqual(busy.refusal.counts, { "test_pad_rows.room_id": 1 });
  assert.equal((await H.plan({ ...FWD, merge: true, to: { ...FWD.to, room: "Busy.Room", slug: "busy-new" } })).refusal, null, "merge: allowed");
  const realOpen = CN.openSlots;
  CN.openSlots = async (id) => (id === OLD ? 2 : 0);
  try { await refused(FWD, "open_slots"); } finally { CN.openSlots = realOpen; }
  await rooms.addRoom("Chatty.Room", "Chatty", "test");
  await runQuery("INSERT INTO chatlog_rooms (room_id, pad_id, owner_since, created) VALUES ('Chatty.Room', 'Chatty.Room', 0, 1)");
  const crk = (await one("SELECT rk FROM chatlog_rooms WHERE room_id = 'Chatty.Room'")).rk;
  await runQuery("INSERT INTO chat_log (c, rk, ts, k, who, text, rt, aud, d) VALUES (9001, ?, 1, 'msg', 'bob', 'hi', ?, 'p', '{}')", [crk, "r" + crk]);
  await refused({ ...FWD, to: { ...FWD.to, room: "Chatty.Room", slug: "chatty-new" } }, "to_has_archive");
  assert.equal((await H.plan({ ...FWD, archive: "keep", to: { ...FWD.to, room: "Chatty.Room", slug: "chatty-new" } })).refusal, null, "archive keep: allowed");
  // clean up what this test added, then: nothing else changed
  await runQuery("DELETE FROM chat_log WHERE rk = ?", [crk]);
  await runQuery("DELETE FROM chatlog_rooms WHERE room_id IN ('Owned.Room', 'Busy.Room', 'Chatty.Room')");
  await runQuery("DELETE FROM chatlog_meta WHERE key IN ('tier:Owned.Room', 'tier:Busy.Room', 'tier:Chatty.Room')");
  await runQuery("DELETE FROM test_pad_rows WHERE room_id = 'Busy.Room'");
  for (const id of ["Owned.Room", "Busy.Room", "Chatty.Room"]) {
    await runQuery("DELETE FROM rooms_registry WHERE room_id = ?", [id]);
    await runQuery("DELETE FROM room_events WHERE room_id = ?", [id]);
    await runQuery("DELETE FROM rooms_kv WHERE key = ?", ["seeded:" + id]);
  }
  await rooms.loadCache();
  const after = await snapshot();
  for (const s of [before, after]) { s.rooms_kv = JSON.parse(s.rooms_kv).filter((r) => !/^seeded:(Owned|Busy|Chatty)\.Room$/.test(r.key)); }
  assert.deepEqual(after, before, "a refusal writes nothing");
});

test("one transaction: a throw midway (the address step) leaves everything as it was", async () => {
  const before = await snapshot();
  const real = A.renameInTx;
  A.renameInTx = async () => { throw new Error("boom (test)"); };
  try {
    await assert.rejects(H.apply(FWD, { live: false }), /boom/);
  } finally { A.renameInTx = real; }
  const after = await snapshot();
  assert.deepEqual(after, before, "the journal, the re-key, the registry, the archive: all rolled back");
  assert.ok(!after.house_rotations || after.house_rotations === "[]", "no journal row");
  assert.ok(!after.pad_vault_rekeys || after.pad_vault_rekeys === "[]", "no vault re-key for Pepe");
  assert.equal((await one("SELECT room_id FROM chatlog_rooms WHERE room_id = ?", [OLD])).room_id, OLD);
});

let KEY = null;
test("review S9: only Pepe's own bot key may rotate the house pad (another caller's key is refused; the shared token still works)", async () => {
  const BK = require(path.join(repo, "botkeys"));
  const real = BK.current;
  const before = await snapshot();
  try {
    BK.current = () => ({ caller: "pepe-vm", mode: "enforce", scopes: ["/api/pepe"] });
    const r = await call("POST", "/api/pepe/identity/rotate", { password: "bot", action: "apply", ...FWD });
    assert.deepEqual([r.status, r.d.code], [403, "caller"]);
    BK.current = () => ({ caller: "pepe", mode: "enforce", scopes: [] });
    const p = await call("POST", "/api/pepe/identity/rotate", { password: "bot", action: "plan", ...FWD });
    assert.equal(p.status, 200, "Pepe's own key plans");
    BK.current = () => ({ caller: "pepe-staging", mode: "enforce", scopes: [] });
    assert.equal((await call("POST", "/api/pepe/identity/rotate", { password: "bot", action: "plan", ...FWD })).status, 200, "staging Pepe's too");
  } finally { BK.current = real; }
  assert.deepEqual(await snapshot(), before, "nothing written");
  assert.deepEqual([...H.PEPE_CALLERS].sort(), ["pepe", "pepe-staging"]);
});

test("apply (the API): the house pad becomes The_Swamp - rows, evidence kept, gaps, archive, title, address, house room, logins, text", async () => {
  // the bot token is needed; JSON over 8 kB is refused
  assert.equal((await call("POST", "/api/pepe/identity/rotate", { password: "nope", action: "plan", ...FWD })).status, 403);
  assert.equal((await call("POST", "/api/pepe/identity/rotate", { password: "bot", action: "plan", ...FWD, pad: "x".repeat(9000) })).status, 413);
  const bad = await call("POST", "/api/pepe/identity/rotate", { password: "bot", action: "apply", ...FWD, to: { ...FWD.to, login: "" } });
  assert.deepEqual([bad.status, bad.d.code], [400, "bad_request"]);
  const r = await call("POST", "/api/pepe/identity/rotate", { password: "bot", action: "apply", ...FWD });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.ok, true);
  KEY = r.d.key;
  assert.deepEqual(r.d.house_room, { id: NEW, slug: "the-swamp", title: "The Swamp" });
  // the registry: one house pad, at the new id
  assert.equal(await n("SELECT COUNT(*) AS n FROM rooms_registry WHERE room_id = ?", [OLD]), 0);
  const row = await one("SELECT * FROM rooms_registry WHERE room_id = ?", [NEW]);
  assert.deepEqual([row.owner_kind, row.platform, row.title, row.slug, row.slug_set], ["house", "camfrog", "The Swamp", "the-swamp", 1]);
  assert.equal(rooms.HOUSE_ROOM, NEW, "the getter follows in-process");
  assert.ok(rooms.retiredHouseRooms().includes(OLD));
  const H0 = JSON.parse(await kv("house_room"));
  assert.deepEqual([H0.id, H0.title, H0.slug, H0.prev.length, H0.prev[0].id, H0.prev[0].title, H0.prev[0].slug], [NEW, "The Swamp", "the-swamp", 1, OLD, "Pepe's Pad", "pepes-pad"]);
  // every pad row moved; the room's evidence stayed (D4)
  assert.equal(await n("SELECT COUNT(*) AS n FROM test_pad_rows WHERE room_id = ?", [NEW]), 4);
  assert.equal(await n("SELECT COUNT(*) AS n FROM test_pad_rows WHERE room_id = 'Other.Room'"), 1);
  assert.equal(await n("SELECT COUNT(*) AS n FROM pepe_modlog WHERE room_id = ? AND room_l = ?", [NEW, NEW.toLowerCase()]), 3, "modlog: room_id AND room_l");
  assert.equal(await n("SELECT COUNT(*) AS n FROM bridge_spans WHERE room_id = ?", [OLD]), 2, "bridge spans stay with the Camfrog room");
  assert.equal(await n("SELECT COUNT(*) AS n FROM livecam_audit WHERE room_id = ?", [OLD]), 1, "the live-cam audit stays too");
  assert.equal(await n("SELECT COUNT(*) AS n FROM seethrough_log WHERE room_id = ?", [OLD]), 1, "review S11: the see-through audit stays with the room");
  assert.deepEqual(await one("SELECT pad, room FROM onair_consent WHERE id = 'oc1'"), { pad: NEW, room: OLD }, "review S11: the consent ask: pad moves, room stays");
  // the gaps padrekey didn't reach before
  assert.equal((await one("SELECT board FROM sb_clips WHERE id = 'c1'")).board, "room:" + NEW);
  assert.ok(await one("SELECT 1 AS x FROM backend_wants WHERE feature = ?", ["casino:" + NEW]));
  assert.equal((await one("SELECT pad_id FROM media_requests")).pad_id, NEW);
  const pr = JSON.parse(await fkv("aigen_prices"));
  assert.deepEqual(pr.rooms, { [NEW]: { imagine: 100 }, DRAMA_CENTRAL: { imagine: 70 } });
  assert.equal(await kv("pepespad:art:" + NEW), JSON.stringify({ avatar: "abc" }));
  assert.equal(await kv("pepespad:art:" + OLD), null);
  // the seeded marker: copied, and the old id marked (seed() never re-creates it)
  assert.equal(await kv("seeded:" + NEW), "house");
  assert.equal(await kv("seeded:" + OLD), "rekeyed:" + NEW);
  // the vault for Pepe, the Plus, follows, feed scopes
  assert.deepEqual((await RK.vaultRekeysForPepe()).map((x) => [x.from, x.to]), [[OLD, NEW]]);
  assert.equal((await one("SELECT target FROM premium_subs WHERE tier = 'prime_plus'")).target, NEW);
  assert.ok(await one("SELECT 1 AS x FROM follows WHERE target_kind = 'room' AND target_id = ?", [NEW]));
  assert.ok(await one("SELECT 1 AS x FROM feed_seen WHERE scope = ?", ["pad:" + NEW]));
  assert.ok(await one("SELECT 1 AS x FROM feed_view WHERE scope = 'p/the-swamp'"));
  assert.equal(await fkv("mention_at:" + NEW), "123");
  // the archive moved with the pad (D1): same rk, the tier too
  const ar = await one("SELECT room_id, pad_id FROM chatlog_rooms WHERE room_id = ?", [NEW]);
  assert.deepEqual([ar.room_id, ar.pad_id], [NEW, NEW]);
  assert.equal(await n("SELECT COUNT(*) AS n FROM chatlog_rooms WHERE room_id = ?", [OLD]), 0);
  assert.ok(await one("SELECT 1 AS x FROM chatlog_meta WHERE key = ?", ["tier:" + NEW]));
  assert.equal(await one("SELECT 1 AS x FROM chatlog_meta WHERE key = ?", ["tier:" + OLD]), null);
  assert.equal(require(path.join(repo, "chatlogview"))._rows.has(OLD), false, "the archive's cache dropped the old id");
  // addresses: every old one points here; the stray's slug too
  for (const s of ["pepes-pad", "pepefrog-room", "swamp-old"]) assert.equal(rooms.aliasTarget(s), NEW, s);
  let red = await call("GET", "/p/pepes-pad?tab=feed");
  assert.deepEqual([red.status, red.location], [301, "/p/the-swamp?tab=feed"]);
  red = await call("GET", "/p/pepefrog-room/settings?tab=general");
  assert.deepEqual([red.status, red.location], [301, "/p/the-swamp/settings?tab=general"]);
  // Pepe's logins (deny-only list) + the learned login
  assert.deepEqual(PL.record(), { current: "pepe_frog", former: ["pepefrog"] });
  assert.ok(PL.has("Pepe_Frog") && PL.has("PepeFrog") && PL.has("pepebeta"));
  assert.equal((await one("SELECT value FROM escrow_meta WHERE key = 'pepe_login'")).value, JSON.stringify("Pepe_Frog"));
  assert.equal((await one("SELECT value FROM oracle_meta WHERE key = 'pepe_login'")).value, JSON.stringify("Pepe_Frog"));
  // the stored text: exact replacements only
  assert.equal(JSON.parse(await fkv("rules:" + NEW)).intro, "The Swamp is the house room: loud, friendly and a bit unhinged.");
  const w = await one("SELECT title, body FROM feed_posts WHERE id = 'w1'");
  assert.equal(w.title, "\u{1F44B} Welcome to The Swamp - start here");
  assert.equal(w.body, "This is my pad.\n\nPad rules: /p/the-swamp?tab=about#rules · Help: /help · the older one: p/pepes-pad-2", "a longer slug is left alone");
  assert.equal(await fkv("pepespad:welcome:" + NEW), "w1");
  // the record: event, audit, journal with the before-image
  const ev = await one("SELECT actor, detail FROM room_events WHERE room_id = ? AND what = 'house-rotated'", [NEW]);
  assert.equal(ev.actor, "pepe:owner");
  assert.match(ev.detail, /PepeFrog\.Room -> The_Swamp; p\/pepes-pad -> p\/the-swamp; 'Pepe's Pad' -> 'The Swamp'/);
  assert.ok(await one("SELECT 1 AS x FROM admin_audit WHERE action = 'house-rotate'"));
  const j = await one("SELECT * FROM house_rotations WHERE key = ?", [KEY]);
  const B = JSON.parse(j.before);
  assert.deepEqual([j.from_id, j.to_id, B.registry.from.slug, B.registry.to.slug, B.welcome.id], [OLD, NEW, "pepes-pad", "swamp-old", "w1"]);
  assert.equal(B.rows["test_pad_rows.room_id"].length, 4);
  assert.equal(JSON.parse(j.result).archive, "moved");
  // the site Admins heard about it
  assert.ok(await one("SELECT 1 AS x FROM inbox WHERE user_id = ? AND title LIKE '%House pad%'", [U.admin.userId]), "one notice to each site Admin");
});

test("again: already (the same key, another key, plan); restarting the seeds makes no ghost house pad", async () => {
  const before = await snapshot();
  const r = await H.apply(FWD, { live: false });
  assert.deepEqual([r.ok, r.already, r.house_room.id], [true, true, NEW]);
  assert.equal((await H.apply({ ...FWD, key: "another-key" }, { live: false })).already, true, "the change is in place whatever the key");
  assert.equal((await H.plan(FWD)).already, true);
  assert.deepEqual(await snapshot(), before, "nothing written");
  // a restart: the seeds again (PepeFrog.Room "Pepe's Pad" is still a seed - it's skipped: its marker says rekeyed)
  await rooms._seed();
  await rooms.loadCache();
  assert.equal(await n("SELECT COUNT(*) AS n FROM rooms_registry WHERE room_id = ?", [OLD]), 0, "no ghost at the old id");
  // ...and the bridge seeing the old room again (Pepe back in it) doesn't make one either
  await rooms.noteBridged(OLD, "Pepe's Pad");
  assert.equal(await n("SELECT COUNT(*) AS n FROM rooms_registry WHERE room_id = ?", [OLD]), 0, "no unowned pad at a retired home");
  assert.equal(rooms.aliasTarget("pepefrog-room"), NEW, "and /p/pepefrog-room still redirects");
  assert.deepEqual((await rooms.listAll()).filter((p) => p.house && p.platform === "camfrog").map((p) => p.id).sort(), ["PepeBeta.Room", NEW]);
});

test("the owner sync: Pepe's identity joins the login list; the answer carries the house room", async () => {
  const r = await call("POST", "/api/rooms/owners", { password: "bot", identity: { login: "Pepe_Frog", former_logins: ["PepeFrog", "OldPepe"] } });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.deepEqual(r.d.house_room, { id: NEW, slug: "the-swamp", title: "The Swamp" });
  assert.deepEqual(PL.record(), { current: "pepe_frog", former: ["pepefrog", "oldpepe"] });
  assert.ok(PL.has("oldpepe"));
  // status: the journal
  const s = await call("POST", "/api/pepe/identity/rotate", { password: "bot", action: "status" });
  assert.equal(s.d.house_room.id, NEW);
  assert.deepEqual(s.d.rotations.map((x) => [x.key, x.from, x.to, x.mode]), [[KEY, OLD, NEW, "move"]]);
});

test("review F8: a SEEDS id that moves away is marked even when its seeded: row is missing (no ghost on the next seed)", async () => {
  // a seed whose marker was lost (prod's PepeFrog.Room marker is there; the guarantee mustn't depend on it): PepeBeta.Room is a seed too
  const PB = "PepeBeta.Room";
  await runQuery("DELETE FROM rooms_kv WHERE key = ?", ["seeded:" + PB]);
  await dbTx(async () => { await RK.rekey(PB, "PepeBeta2.Room"); });
  assert.equal(await kv("seeded:" + PB), "rekeyed:PepeBeta2.Room", "the marker is written anyway");
  // put it back as it was (the registry row never moved: this calls padrekey alone)
  await dbTx(async () => { await RK.rekey("PepeBeta2.Room", PB); });
  await runQuery("DELETE FROM pad_vault_rekeys WHERE from_id IN (?, ?) OR to_id IN (?, ?)", [PB, "PepeBeta2.Room", PB, "PepeBeta2.Room"]);
  await runQuery("INSERT OR REPLACE INTO rooms_kv (key, value) VALUES (?, 'house')", ["seeded:" + PB]);
  await runQuery("DELETE FROM rooms_kv WHERE key = ?", ["seeded:PepeBeta2.Room"]);
  // a non-seed id without a marker gets none (nothing to guard)
  await dbTx(async () => { await RK.rekey("Other.Room", "Other2.Room"); });
  assert.equal(await kv("seeded:Other.Room"), null);
  await dbTx(async () => { await RK.rekey("Other2.Room", "Other.Room"); });
  await runQuery("DELETE FROM pad_vault_rekeys WHERE from_id IN ('Other.Room', 'Other2.Room')");
});

test("restore_of: the undo puts the house pad back (the login stays); a later undo / the old key are refused", async () => {
  const r = await H.apply({ restore_of: KEY, from: { login: "Pepe_Frog" }, to: { login: "Pepe_Frog" }, actor: "pepe:owner" }, { live: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.key, KEY + "-undo");
  const row = await one("SELECT * FROM rooms_registry WHERE room_id = ?", [OLD]);
  assert.deepEqual([row.owner_kind, row.title, row.slug, row.slug_set], ["house", "Pepe's Pad", "pepes-pad", 0]);
  assert.equal(await n("SELECT COUNT(*) AS n FROM rooms_registry WHERE room_id = ?", [NEW]), 0);
  assert.equal(rooms.HOUSE_ROOM, OLD);
  assert.equal(await kv("house_room"), null, "unset again (the default is the old home)");
  assert.equal(await kv("seeded:" + OLD), "house");
  assert.equal(rooms.aliasTarget("the-swamp"), OLD, "the rotation's address redirects back");
  assert.equal(rooms.bySlugCached("pepefrog-room").id, OLD, "the id's own slug reaches it again");
  assert.equal(rooms.aliasTarget("pepes-pad"), null, "it's the address again");
  assert.equal(rooms.bySlugCached("pepes-pad").id, OLD);
  assert.equal(await n("SELECT COUNT(*) AS n FROM test_pad_rows WHERE room_id = ?", [OLD]), 4);
  assert.equal(await n("SELECT COUNT(*) AS n FROM pepe_modlog WHERE room_id = ? AND room_l = ?", [OLD, OLD.toLowerCase()]), 3);
  assert.equal(await n("SELECT COUNT(*) AS n FROM bridge_spans WHERE room_id = ?", [OLD]), 2);
  assert.equal((await one("SELECT board FROM sb_clips WHERE id = 'c1'")).board, "room:" + OLD);
  assert.equal((await one("SELECT room_id FROM chatlog_rooms WHERE room_id = ?", [OLD])).room_id, OLD, "the archive came back");
  assert.ok(await one("SELECT 1 AS x FROM chatlog_meta WHERE key = ?", ["tier:" + OLD]));
  assert.equal(JSON.parse(await fkv("rules:" + OLD)).intro, "Pepe's Pad is the house room: loud, friendly and a bit unhinged.");
  assert.deepEqual(await one("SELECT title, body FROM feed_posts WHERE id = 'w1'"), { title: "\u{1F44B} Welcome to Pepe's Pad - start here", body: WELCOME_BODY });
  assert.equal(PL.current(), "pepe_frog", "the login doesn't go back (the Camfrog account changed)");
  assert.deepEqual((await RK.vaultRekeysForPepe()).map((x) => [x.from, x.to]), [[OLD, NEW], [NEW, OLD]], "the vault goes back too");
  const j = await one("SELECT restored_by FROM house_rotations WHERE key = ?", [KEY]);
  assert.equal(j.restored_by, (await one("SELECT id FROM house_rotations WHERE key = ?", [KEY + "-undo"])).id);
  // again: already; another undo of it / the forward key again: refused
  assert.equal((await H.apply({ restore_of: KEY, to: { login: "Pepe_Frog" } }, { live: false })).already, true);
  await assert.rejects(H.apply({ restore_of: KEY, key: "undo-2", to: { login: "Pepe_Frog" } }, { live: false }), (e) => e.code === "already_restored");
  await assert.rejects(H.apply(FWD, { live: false }), (e) => e.code === "key_conflict");
});

test("a case-only fix: a rotation typed the_swamp is healed to The_Swamp (no extra retired home)", async () => {
  const r1 = await H.apply({ ...FWD, key: "rot-2", to: { ...FWD.to, room: "the_swamp" } }, { live: true });
  assert.equal(r1.house_room.id, "the_swamp");
  const r2 = await H.apply({ key: "case-The_Swamp", from: { room: "the_swamp", login: "Pepe_Frog" }, to: { room: NEW, title: "The Swamp", slug: "the-swamp", login: "Pepe_Frog" } }, { live: true });
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.deepEqual(r2.house_room, { id: NEW, slug: "the-swamp", title: "The Swamp" });
  assert.equal(rooms.HOUSE_ROOM, NEW);
  assert.deepEqual(JSON.parse(await kv("house_room")).prev.map((p) => p.id), [OLD], "the wrong case isn't a home of its own");
  assert.ok(!rooms.retiredHouseRooms().some((x) => x.toLowerCase() === "the_swamp"));
  assert.equal(await n("SELECT COUNT(*) AS n FROM test_pad_rows WHERE room_id = ?", [NEW]), 4);
  assert.equal((await one("SELECT room_id FROM chatlog_rooms WHERE room_id = ?", [NEW])).room_id, NEW);
});

test("tools/house-rotate.js: a dry run on a copy writes nothing; --apply backs up first; then already", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "houserotate-cli-"));
  await runQuery(`VACUUM INTO '${path.join(dir, "myapp.db").replace(/'/g, "''")}'`);
  const run = (...a) => {
    try { return { code: 0, out: execFileSync(process.execPath, [path.join(repo, "tools", "house-rotate.js"), "--dir", dir, ...a], { encoding: "utf8", env: { ...process.env, NODE_PATH: process.env.NODE_PATH || "" } }) }; }
    catch (e) { return { code: e.status, out: String(e.stdout || "") + String(e.stderr || "") }; }
  };
  const args = ["--from", NEW, "--to", "Next.Room", "--title", "Next Home", "--login-from", "Pepe_Frog", "--login-to", "Pepe_Next", "--key", "cli-1"];
  let r = run(...args);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /dry run - nothing written/);
  assert.match(r.out, /"slug": "next-home"/);
  r = run(...args, "--apply", "--backup-dir", path.join(dir, "bk"));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /backup: .*myapp-pre-house-rotate-/);
  assert.equal(fs.readdirSync(path.join(dir, "bk")).filter((f) => /^myapp-pre-house-rotate-.*\.db$/.test(f)).length, 1);
  r = run(...args);
  assert.match(r.out, /already done/);
  r = run("--from", "Next.Room", "--to", "PepeBeta.Room", "--login-to", "x");
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /REFUSED \(retired_home\)/);
  r = run("--db", path.join(dir, "copy.db"), "--login-to", "x");
  assert.equal(r.code, 2);
  assert.equal(rooms.HOUSE_ROOM, NEW, "the live database didn't move");
});
