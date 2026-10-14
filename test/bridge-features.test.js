// 1.99zf: per-feature web bridge blocks (bridgeblocks.js) + Pepe's mod log on the site (pepemodlog.js) + the room-join error text.
//   - the old (room_id, user_id) table migrates to per-feature rows ("all")
//   - a one-feature block refuses only that feature (chat / soundboard via !sb / commands / voice ...), "all" covers each, the text
//     names the feature, the end and the reason
//   - admins set several features at once for every room (admin_audit), and lift some
//   - Pepe's mirror: an older Pepe only gets "all" rows, a feature-aware one (blocks_cap 2) every row with its feature
//   - the mod log: bot token, allow-listed moderation only, deduped by key, pinned to the pad's room for its owner, + the
//     site's bridge-block events, category filter + paging; admins see every room
//   - weberrors: an E_INTERNAL on a room join never says "check your balance"
//   node --test test/bridge-features.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-features-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const BB = require(path.join(repo, "bridgeblocks"));
const ML = require(path.join(repo, "pepemodlog"));
const relay = require(path.join(repo, "bridge-relay"));
const rooms = require(path.join(repo, "rooms"));
const W = require(path.join(repo, "weberrors"));

const ROOM = "plant_based_chatting";
const LR = { id: ROOM, slug: "plant-based-chatting", relay: true, micRelay: true, members: [], cmds: relay.cleanCmds({ "!help": 0, "!sb": 0 }), mod: {} };
let T = Date.parse("2026-10-14T12:00:00Z");
BB._setClock(() => T);
let base, server, SLUG;
const U = {};

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordId TEXT, twitchId TEXT, discordUsername TEXT, twitchDisplayname TEXT,
                  level INTEGER DEFAULT 0, avatar TEXT, created_at TEXT, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  const mk = async (key, id, name, cf, cls = "pleb") => {
    await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername, class) VALUES (?, ?, ?, 'x', ?, ?)", [id, name, name, cf, cls]);
    U[key] = { userId: id, username: name, class: cls };
  };
  await mk("owner", "own-0001", "padowner", "foamy1111");
  await mk("alice", "ali-0001", "alicep", "alice");
  await mk("bob", "bob-0001", "bobp", "bobcf");
  await mk("rando", "ran-0001", "rando", "randocf");
  await mk("admin", "adm-0001", "boss", "bossy", "Admin");
  // a site from before 1.99zf: the old table, one block
  await runQuery(`CREATE TABLE bridge_blocks (room_id TEXT NOT NULL, user_id TEXT NOT NULL, username TEXT, reason TEXT,
        blocked_by TEXT, blocker_name TEXT, via TEXT, created INTEGER NOT NULL, until INTEGER, updated INTEGER NOT NULL, op_key TEXT,
        PRIMARY KEY (room_id, user_id))`);
  await runQuery("INSERT INTO bridge_blocks (room_id, user_id, username, reason, via, created, until, updated) VALUES (?, 'bob-0001', 'bobp', 'old one', 'chat', ?, NULL, ?)", [ROOM, T, T]);
  await rooms.init();
  await rooms.setOwner(ROOM, "foamy1111", "test");
  SLUG = (await rooms.get(ROOM)).slug || ROOM;
  LR.slug = SLUG;
  await BB.init();
  const app = express();
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? U[u] || null : null; next(); };
  const isBotToken = (t) => t === "bot-token";
  const bySlug = (s) => (s === SLUG ? LR : null);
  relay.register(app, { isBotToken, addUser, bySlug, isLive: () => true });
  BB.register(app, { isBotToken, addUser, bySlug });
  ML.register(app, { isBotToken, addUser, bySlug });
  await new Promise((r) => { server = app.listen(0, r); });
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());

const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch", origin: base }, u ? { "x-test-user": u } : {});
const post = (p, u, body) => fetch(base + p, { method: "POST", headers: H(u), body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, d: await r.json() }));
const get = (p, u) => fetch(base + p, { headers: H(u) }).then(async (r) => ({ status: r.status, d: await r.json() }));
const say = (u, text) => { relay._hits.clear(); return post("/api/rooms/" + SLUG + "/say", u, { text }); };

test("the old table migrates: every old block is an 'all' block, the key now has the feature", async () => {
  const cols = (await getQuery("PRAGMA table_info(bridge_blocks)")).map((c) => c.name);
  assert.ok(cols.includes("feature"));
  const rows = await getQuery("SELECT room_id, user_id, feature, reason FROM bridge_blocks");
  assert.deepEqual(rows, [{ room_id: ROOM, user_id: "bob-0001", feature: "all", reason: "old one" }]);
  const s = await say("bob", "hello");
  assert.equal(s.status, 403);
  assert.match(s.d.error, /A mod of this room blocked you from chatting in it from the website \(old one\)/);
  await BB.unblock({ roomId: ROOM, target: { userId: "bob-0001", username: "bobp" }, by: { name: "t", via: "web" } });
});

test("a one-feature block: only that feature is refused, with its own words; the owner route takes `feature`", async () => {
  let r = await post("/api/rooms/" + SLUG + "/blocks", "owner", { op: "block", target: "alice", hours: 24, reason: "sb spam", feature: "soundboard" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.block.feature, "soundboard");
  assert.equal((await say("alice", "plain chat is fine")).status, 200);
  const sb = await say("alice", "!sb 12");
  assert.equal(sb.status, 403);
  assert.equal(sb.d.code, "blocked");
  assert.equal(sb.d.feature, "soundboard");
  assert.match(sb.d.error, /blocked you from using its soundboard until 2026-10-15 12:00 UTC \(sb spam\)/);
  assert.notEqual((await say("alice", "!help")).status, 403, "other commands still go");
  assert.equal(await BB.refusal(ROOM, "ali-0001", "livecams"), null);
  r = await post("/api/rooms/" + SLUG + "/blocks", "owner", { op: "block", target: "alice", hours: 1, feature: "chat" });
  assert.equal(r.status, 200);
  assert.equal((await say("alice", "now chat is off")).status, 403);
  r = await get("/api/rooms/" + SLUG + "/blocks", "owner");
  assert.deepEqual(r.d.blocks.map((b) => b.feature).sort(), ["chat", "soundboard"]);
  r = await post("/api/rooms/" + SLUG + "/blocks", "owner", { op: "unblock", target: "u:ali-0001", feature: "chat" });
  assert.equal(r.d.removed, true);
  assert.equal((await say("alice", "chat again")).status, 200);
  assert.ok(await BB.refusal(ROOM, "ali-0001", "soundboard"), "the soundboard block stays");
  r = await post("/api/rooms/" + SLUG + "/blocks", "owner", { op: "unblock", target: "u:ali-0001" });
  assert.equal(r.d.removed, true, "no feature = every block in the room");
  assert.equal(await BB.refusal(ROOM, "ali-0001", "soundboard"), null);
  r = await post("/api/rooms/" + SLUG + "/blocks", "owner", { op: "block", target: "alice", feature: "everything-ish" });
  assert.equal(r.status, 400);
  const ev = await getQuery("SELECT detail FROM room_events WHERE room_id = ? AND what = 'bridge-block' ORDER BY ts", [ROOM]);
  assert.ok(ev.some((e) => /from the web bridge's soundboard/.test(e.detail)));
});

test("an 'all' block covers every feature; Pepe's route takes a feature", async () => {
  let r = await post("/api/bridge/blocks", null, { password: "bot-token", room: ROOM, op: "block", target: "alice", by: "foamy1111", secs: 600, key: "kA" });
  assert.equal(r.d.block.feature, "all");
  for (const f of BB.FEATURES) assert.ok(await BB.refusal(ROOM, "ali-0001", f), f);
  assert.match(await BB.refusal(ROOM, "ali-0001", "snapshots"), /taking cam snapshots in it/);
  r = await post("/api/bridge/blocks", null, { password: "bot-token", room: ROOM, op: "unblock", target: "alice", by: "foamy1111", key: "kB" });
  assert.equal(r.d.removed, true);
  r = await post("/api/bridge/blocks", null, { password: "bot-token", room: ROOM, op: "block", target: "alice", by: "foamy1111", feature: "voice", key: "kC" });
  assert.equal(r.d.block.feature, "voice");
  assert.equal(await BB.refusal(ROOM, "ali-0001", "chat"), null);
  r = await post("/api/bridge/blocks", null, { password: "bot-token", room: ROOM, op: "block", target: "alice", by: "foamy1111", feature: "nope" });
  assert.equal(r.status, 400);
  await post("/api/bridge/blocks", null, { password: "bot-token", room: ROOM, op: "unblock", target: "alice", by: "foamy1111" });
});

test("admins: several features in every room at once, audited; lift some; the account view", async () => {
  let r = await post("/api/admin/bridge/blocks", "owner", { op: "block", room: "", target: "bobp", features: ["chat"] });
  assert.equal(r.status, 403, "admins only");
  r = await post("/api/admin/bridge/blocks", "admin", { op: "block", room: "", target: "bobp", features: ["chat", "livecams"], hours: 168, reason: "abuse" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.deepEqual(r.d.blocks.map((b) => [b.global, b.feature]).sort(), [[true, "chat"], [true, "livecams"]]);
  assert.match(await BB.refusal("Any.Room", "bob-0001", "livecams"), /^You're blocked from watching live cams until .* \(abuse\)\.$/);
  assert.equal(await BB.refusal("Any.Room", "bob-0001", "soundboard"), null);
  r = await get("/api/admin/bridge/blocks?target=" + encodeURIComponent("bobp"), "admin");
  assert.equal(r.d.target.userId, "bob-0001");
  assert.equal(r.d.blocks.length, 2);
  assert.ok(r.d.features.includes("clips"));
  r = await post("/api/admin/bridge/blocks", "admin", { op: "unblock", room: "", target: "u:bob-0001", features: ["chat"] });
  assert.deepEqual(r.d.blocks.map((b) => b.feature), ["livecams"]);
  const aud = await getQuery("SELECT detail FROM admin_audit WHERE action = 'bridge_block' AND target_id = 'bob-0001'");
  assert.equal(aud.length, 3, "two blocks + one unblock");
  r = await post("/api/admin/bridge/blocks", "admin", { op: "block", room: "", target: "bobp", features: ["chat", "bogus"] });
  assert.equal(r.status, 400);
  // an admin's ROOM block is in admin_audit too
  await post("/api/admin/bridge/blocks", "admin", { op: "block", room: ROOM, target: "bobp", features: ["clips"] });
  assert.equal((await getQuery("SELECT 1 FROM admin_audit WHERE action = 'bridge_block' AND target_id = 'bob-0001'")).length, 4);
});

test("Pepe's mirror: 'all' rows only for an older Pepe, every row with its feature for blocks_cap 2", async () => {
  await post("/api/bridge/blocks", null, { password: "bot-token", room: ROOM, op: "block", target: "alice", by: "foamy1111", key: "kM" });
  const old = await BB.forSync({ relay_cap: 1, blocks_v: "x" });
  assert.ok(old.bridge_blocks.rows.every((x) => x.feature === undefined));
  assert.deepEqual(old.bridge_blocks.rows.map((x) => x.user_id), ["ali-0001"]);
  const neu = await BB.forSync({ relay_cap: 1, blocks_cap: 2, blocks_v: old.bridge_blocks.v });
  assert.ok(neu.bridge_blocks, "the old Pepe's version doesn't satisfy a feature-aware one");
  assert.deepEqual(neu.bridge_blocks.rows.map((x) => [x.user_id, x.feature]).sort(), [["ali-0001", "all"], ["bob-0001", "clips"], ["bob-0001", "livecams"]]);
  assert.deepEqual(await BB.forSync({ relay_cap: 1, blocks_cap: 2, blocks_v: neu.bridge_blocks.v }), {});
});

test("the mod log: bot token, allow-list, dedupe; the owner sees this room only (+ site bridge events); filter + paging; admins all", async () => {
  const ev = (k, type, room, mins, extra) => Object.assign({ k, type, room, ts: T - mins * 60e3, actor: "modlogin", target: "troll", details: type }, extra || {});
  let r = await post("/api/bridge/modlog", null, { password: "nope", events: [] });
  assert.equal(r.status, 403);
  r = await post("/api/bridge/modlog", null, { password: "bot-token", events: [
    ev("a1", "kick", ROOM, 50), ev("a2", "pepe_ban", ROOM, 40), ev("a3", "punish", ROOM, 30), ev("a4", "strike", ROOM, 20),
    ev("a5", "web_relay", ROOM, 10), ev("a6", "pepe_msg", ROOM, 9), ev("a7", "kick", "Other.Room", 5), ev("a1", "kick", ROOM, 50),
  ] });
  assert.deepEqual([r.d.stored, r.d.skipped], [5, 3], "chat lines / PMs refused, a replayed key ignored");
  r = await get("/api/rooms/" + SLUG + "/modlog", "rando");
  assert.equal(r.status, 403);
  r = await get("/api/rooms/" + SLUG + "/modlog", "owner");
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.ok(r.d.rows.every((x) => x.room.toLowerCase() === ROOM.toLowerCase()), "this room only");
  assert.ok(!r.d.rows.some((x) => x.type === "kick" && x.room === "Other.Room"));
  assert.ok(r.d.rows.some((x) => x.src === "site" && x.type === "bridge-block"), "the site's bridge blocks are in it");
  for (let i = 1; i < r.d.rows.length; i++) assert.ok(r.d.rows[i - 1].ts >= r.d.rows[i].ts, "newest first");
  r = await get("/api/rooms/" + SLUG + "/modlog?cat=ban", "owner");
  assert.deepEqual(r.d.rows.map((x) => [x.type, x.cat]), [["pepe_ban", "ban"]]);
  r = await get("/api/rooms/" + SLUG + "/modlog?cat=automod", "owner");
  assert.deepEqual(r.d.rows.map((x) => x.type), ["strike"]);
  r = await get("/api/rooms/" + SLUG + "/modlog?cat=bridge", "owner");
  assert.ok(r.d.rows.length && r.d.rows.every((x) => x.cat === "bridge"));
  r = await get("/api/rooms/" + SLUG + "/modlog?limit=2&page=0", "owner");
  assert.equal(r.d.rows.length, 2);
  assert.equal(r.d.more, true);
  const r2 = await get("/api/rooms/" + SLUG + "/modlog?limit=2&page=1", "owner");
  assert.notDeepEqual(r2.d.rows, r.d.rows);
  r = await get("/api/rooms/" + SLUG + "/modlog?q=TROLL&cat=kick", "owner");
  assert.deepEqual(r.d.rows.map((x) => x.type), ["kick"]);
  r = await get("/api/admin/pepe/modlog", "owner");
  assert.equal(r.status, 403);
  r = await get("/api/admin/pepe/modlog?cat=kick", "admin");
  assert.deepEqual(r.d.rows.map((x) => x.room).sort(), ["Other.Room", ROOM]);
});

test("weberrors: a crashed room join says nothing about the balance; a money action still does", () => {
  const msg = "Something went wrong on Pepe's side (incident 6408028f). Check your balance before trying again.";
  const room = W.present({ status: "failed", kind: "room.ctl", code: "E_INTERNAL", incident: "6408028f", message: msg });
  assert.doesNotMatch(room.message + room.hint, /balance/i);
  assert.match(room.message, /incident 6408028f\). The room change may not have happened/);
  const loan = W.present({ status: "failed", kind: "cmd", code: "E_INTERNAL", incident: "6408028f", message: msg });
  assert.match(loan.message, /Check your balance/);
});
