// 1.99xa: !bridge block (bridgeblocks.js) + web-relay lines as normal chat (bridge.js) + an account's incognito (incognito.js).
//   - a block is keyed by (room, account), idempotent by the bot's key, expires on the (injected) clock, a global one covers every room
//   - targets: 🌐name, u:<id>, a linked chat login, a PATV username
//   - the relay refuses a blocked account (say / commands), Pepe's route needs the bot token, the pad route needs owner / staff /
//     a room mod, the admin route admins; Pepe's sync gets the mirror only when his version is old
//   - a web line event with `web` is the SENDER's line (linked login or u:<id>), marked web; an old-style one stays Pepe's
//   - "u:<id>" incognito reports are kept while a relay-capable Pepe runs; the account's privacy page offers the switch
//   node --test test/bridge-blocks.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-blocks-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const BB = require(path.join(repo, "bridgeblocks"));
const relay = require(path.join(repo, "bridge-relay"));
const cap = require(path.join(repo, "actorcap"));
const rooms = require(path.join(repo, "rooms"));

const ROOM = "plant_based_chatting";
const LR = { id: ROOM, slug: "plant-based-chatting", relay: true, members: [], cmds: relay.cleanCmds({ "!help": 0 }), mod: {} };
let T = Date.parse("2026-10-13T12:00:00Z");
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
  await mk("alice", "ali-0001", "alicep", "alice");            // linked
  await mk("web", "web-0001", "webbob", null);                 // no chat login
  await mk("mod", "mod-0001", "modder", "modlogin");           // a room mod by Pepe's caps
  await mk("rando", "ran-0001", "rando", "randocf");
  await mk("admin", "adm-0001", "boss", "bossy", "Admin");
  await rooms.init();
  await rooms.setOwner(ROOM, "foamy1111", "test");
  SLUG = (await rooms.get(ROOM)).slug || ROOM;
  LR.slug = SLUG;
  LR.mod = { modlogin: { actions: ["kick", "ban"], on: true, roles: ["moderator"] } };
  await BB.init();
  const app = express();
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? U[u] || null : null; next(); };
  const isBotToken = (t) => t === "bot-token";
  const bySlug = (s) => (s === SLUG ? LR : null);
  relay.register(app, { isBotToken, addUser, bySlug, isLive: () => true });
  BB.register(app, { isBotToken, addUser, bySlug });
  require(path.join(repo, "incognito")).register(app, { addUser, isBotToken });
  await new Promise((r) => { server = app.listen(0, r); });
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server && server.close());

const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch", origin: base }, u ? { "x-test-user": u } : {});
const post = (p, u, body) => fetch(base + p, { method: "POST", headers: H(u), body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, d: await r.json() }));
const get = (p, u) => fetch(base + p, { headers: H(u) }).then(async (r) => ({ status: r.status, d: await r.json() }));
const bot = (body) => post("/api/bridge/blocks", null, Object.assign({ password: "bot-token", room: ROOM }, body));
const say = (u, text) => { relay._hits.clear(); return post("/api/rooms/" + SLUG + "/say", u, { text }); };

test("targets: 🌐name, u:<id>, a linked chat login (before a username), a PATV username, unknown", async () => {
  assert.equal((await BB.resolveTarget("🌐webbob")).userId, "web-0001");
  assert.equal((await BB.resolveTarget("u:web-0001")).userId, "web-0001");
  assert.equal((await BB.resolveTarget("alice")).userId, "ali-0001", "chat login");
  assert.equal((await BB.resolveTarget("@alicep")).userId, "ali-0001", "PATV username");
  assert.match((await BB.resolveTarget("nobody")).error, /No PATV account/);
  assert.match((await BB.resolveTarget("u:zzzzzzzz")).error, /no PATV account|No PATV account/i);
});

test("Pepe's route: bot token, block with a key is idempotent, the relay refuses, expiry on the clock, unblock", async () => {
  let r = await post("/api/bridge/blocks", null, { password: "nope", op: "block", room: ROOM, target: "alice" });
  assert.equal(r.status, 403);
  assert.equal((await say("alice", "hi there")).status, 200, "not blocked yet");
  r = await bot({ op: "block", target: "alice", by: "modlogin", secs: 3600, reason: "spam", key: "k1" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.again, false);
  assert.equal(r.d.block.until, T + 3600e3);
  assert.equal(r.d.block.reason, "spam");
  assert.match(r.d.block.by, /modder \(chat modlogin\)/);
  const v1 = BB.version();
  T += 60e3;
  r = await bot({ op: "block", target: "alice", by: "modlogin", secs: 3600, reason: "spam", key: "k1" });
  assert.equal(r.d.again, true, "a replayed key changes nothing");
  assert.equal(r.d.block.until, T - 60e3 + 3600e3);
  assert.equal(BB.version(), v1, "no new version for a replay");
  const s = await say("alice", "hi again");
  assert.equal(s.status, 403);
  assert.match(s.d.error, /blocked you.*\(spam\)/);
  const c = await say("alice", "!help");
  assert.equal(c.status, 403, "commands too");
  const ev = await getQuery("SELECT what, actor, detail FROM room_events WHERE room_id = ? AND what = 'bridge-block'", [ROOM]);
  assert.equal(ev.length, 1, "audited once");
  assert.match(ev[0].detail, /blocked alicep from the web relay until .* - spam \(chat\)/);
  T += 3600e3;
  assert.equal((await say("alice", "free again")).status, 200, "expired");
  assert.equal(await BB.active(ROOM, "ali-0001"), null);
  r = await bot({ op: "unblock", target: "alice", by: "modlogin", key: "k2" });
  assert.equal(r.d.removed, true);
  r = await bot({ op: "unblock", target: "alice", by: "modlogin", key: "k2" });
  assert.equal(r.d.removed, false, "idempotent");
});

test("a global block (every room) covers another room; a room block wins the message", async () => {
  let r = await bot({ op: "block", target: "🌐webbob", global: true, by: "bossy", key: "g1" });
  assert.equal(r.status, 200);
  assert.equal(r.d.block.global, true);
  assert.equal(r.d.block.until, null, "until lifted");
  assert.ok(await BB.active("SomeOther.Room", "web-0001"));
  assert.match(await BB.refusal("SomeOther.Room", "web-0001"), /blocked from talking into chat rooms/);
  const aud = await getQuery("SELECT action, target_id FROM admin_audit WHERE action = 'bridge_block'");
  assert.equal(aud.length, 1);
  assert.equal(aud[0].target_id, "web-0001");
  r = await bot({ op: "unblock", target: "u:web-0001", global: true, by: "bossy" });
  assert.equal(r.d.removed, true);
});

test("the pad route: owner / staff / a room mod by Pepe's caps; anyone else 403; list + unblock", async () => {
  let r = await post("/api/rooms/" + SLUG + "/blocks", "rando", { op: "block", target: "🌐webbob", hours: 24 });
  assert.equal(r.status, 403);
  r = await post("/api/rooms/" + SLUG + "/blocks", "owner", { op: "block", target: "🌐webbob", hours: 24, reason: "rude" });
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.equal(r.d.block.until, T + 24 * 3600e3);
  r = await get("/api/rooms/" + SLUG + "/blocks", "mod");
  assert.equal(r.status, 200, JSON.stringify(r.d));
  assert.deepEqual(r.d.blocks.map((b) => b.username), ["webbob"]);
  r = await post("/api/rooms/" + SLUG + "/blocks", "admin", { op: "block", target: "padowner", hours: 1 });
  assert.equal(r.status, 200, "staff");
  r = await post("/api/rooms/" + SLUG + "/blocks", "owner", { op: "block", target: "padowner" });
  assert.equal(r.status, 400, "not yourself");
  r = await post("/api/rooms/" + SLUG + "/blocks", "mod", { op: "unblock", target: "u:web-0001" });
  assert.equal(r.d.removed, true);
  r = await post("/api/rooms/" + SLUG + "/blocks", "owner", { op: "block", target: "x", hours: -3 });
  assert.equal(r.status, 404);
  r = await post("/api/admin/bridge/blocks", "owner", { op: "block", target: "alice" });
  assert.equal(r.status, 403, "admin route: admins only");
  r = await post("/api/admin/bridge/blocks", "admin", { op: "block", target: "alice", room: "", hours: 0 });
  assert.equal(r.status, 200);
  assert.equal(r.d.block.global, true);
  r = await get("/api/admin/bridge/blocks", "admin");
  assert.ok(r.d.blocks.some((b) => b.global && b.userId === "ali-0001"));
  await post("/api/admin/bridge/blocks", "admin", { op: "unblock", target: "alice", room: "" });
});

test("Pepe's sync: the mirror only for a relay-capable Pepe with an old version; it carries the account's chat login", async () => {
  await bot({ op: "block", target: "alice", by: "modlogin", key: "m1" });
  assert.deepEqual(await BB.forSync({ actor_cap: 1 }), {}, "an old Pepe gets nothing");
  const m = await BB.forSync({ relay_cap: 1, blocks_v: "old" });
  assert.equal(m.bridge_blocks.v, BB.version());
  const row = m.bridge_blocks.rows.find((x) => x.user_id === "ali-0001");
  assert.deepEqual([row.room, row.login, row.until], [ROOM, "alice", null]);
  assert.deepEqual(await BB.forSync({ relay_cap: 1, blocks_v: BB.version() }), {}, "up to date");
});

test("bridge: a web line with `web` is the sender's own line (login or u:<id>); an old-style one stays Pepe's", async () => {
  const B = require(path.join(repo, "bridge"));
  const ev = (data, id) => ({ op: "event", id, type: "message", ts: new Date().toISOString(), scope: { room: { id: "Web.Room", name: "Web Room" } }, data });
  await B.ingest({ events: [
    ev({ user: { id: "pepefrog", login: "pepefrog", display: "Pepe", is_self: true }, text: "🌐 Alice (web): hello", self: true,
         web: { user: { id: "alice", login: "alice", display: "Alice" }, text: "hello" } }, "e1"),
    ev({ user: { id: "pepefrog", login: "pepefrog", display: "Pepe", is_self: true }, text: "🌐 webbob (PATV web): yo", self: true,
         web: { user: { id: "u:web-0001", login: "u:web-0001", display: "🌐 webbob" }, text: "yo" } }, "e2"),
    ev({ user: { id: "pepefrog", login: "pepefrog", display: "Pepe", is_self: true }, text: "🌐 Old (web): old style", self: true }, "e3"),
  ], rooms: [] });
  const R = B._rooms.get("Web.Room");
  const msgs = R.feed.filter((x) => x.k === "msg");
  assert.deepEqual(msgs.map((x) => [x.u.login, x.text, !!x.u.web]), [["alice", "hello", true], ["u:web-0001", "yo", true], ["pepefrog", "🌐 Old (web): old style", false]]);
  assert.equal(msgs[1].u.acct, true);
  const L = await B.resolveNames(msgs.map((x) => x.u));
  const shown = B.withPatv(msgs[1].u, L);
  assert.equal(shown.patv && shown.patv.username, "webbob", "u:<id> resolves to the account");
  assert.equal(shown.cf, undefined);
});

test("incognito for an account with no chat login: the key u:<id> while a relay-capable Pepe runs", async () => {
  const I = require(path.join(repo, "incognito"));
  cap._setRelay(0);
  let st = await I.stateOf("web-0001");
  assert.equal(st.linked, false, "an old Pepe: unlinked, as before");
  cap.note({ relay_cap: 1 });
  st = await I.stateOf("web-0001");
  assert.deepEqual([st.linked, st.account, st.login, st.name], [true, true, "u:web-0001", "webbob"]);
  const r = await I.sync({ items: [{ login: "u:web-0001", on: true, via: "web", ts: T }] });
  assert.equal(r.applied, 1);
  st = await I.stateOf("web-0001");
  assert.equal(st.on, true);
  const inbox = await getQuery("SELECT body FROM inbox WHERE user_id = 'web-0001'");
  assert.match(inbox[0].body, /your PATV account/);
  assert.equal((await I.sync({ items: [{ login: "u:ali-0001", on: true, ts: T }] })).applied, 0, "a linked account's key isn't its identity");
});
