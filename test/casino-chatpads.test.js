"use strict";
// tablechat (owner 2026-11-07: "Also for poker table chats, let users pull up any pad chats regardless if its been advertised or added to a
// room chat"): the casino tables' 💬 Chat may open ANY pad chat the viewer may open - GET /api/casino/t/:id/chatpads (casino/chatpads.js).
//   * the list: the table's own pads first (home, pushed, advert - as 1.99ajw casino2 offered), the viewer's recent ones, then every other
//     live bridged pad, most people first - each one through the table chat's gate (gate()): bridge.chatGate (the chat window's own: a live
//     bridged Camfrog pad, its bridge perk, padaccess.full - public / members / approved -, the 18+ gate, the Room Dock) and not banned from
//     that pad (listenban: a pad ban, a whole-bridge block, a login ban, a network ban - never a one-feature block, never an incognito ban)
//   * a pad that wasn't advertised opens; an Approved pad you're not in, a banned pad, an 18+ pad without the gate, a pad Pepe isn't
//     bridging never show (not their name, not their address); guests see Public pads only
//   * UNLISTED pads (reached by their address only): left out of the list unless you manage it or the table plays / advertises there; an
//     exact address (?slug=) reaches one, as typing p/<address> does; a "recent" address from the page never does
//   * padsFor's `chat` is the same gate (a banned viewer isn't offered the table's own pad); `more` = other pads' chats exist for you
//   * anyone may ask (signed out too), private no-store, 40 a minute per account / address
//   node --test test/casino-chatpads.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "casino-chatpads-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.PAD_DIR = path.join(tmp, "pad");
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const PA = require(path.join(repo, "padaccess"));
const PD = require(path.join(repo, "paddock"));
const AG = require(path.join(repo, "adultgate"));
const bridge = require(path.join(repo, "bridge"));
const svc = require(path.join(repo, "casino", "service"));
const people = require(path.join(repo, "casino", "people"));
const CP = require(path.join(repo, "casino", "chatpads"));
require(path.join(repo, "terms"))._setRequired(false);

// the pads: two of the table's own (home + advert), and pads the table knows nothing about
const P = {
  home: { id: "Casino.Pad", level: "public", count: 4 },
  adv: { id: "Advert.Pad", level: "public", count: 4 },
  mem: { id: "Members.Pad", level: "members", count: 9 },        // never advertised to the table: the owner's ask
  pub: { id: "Public.Pad", level: "public", count: 3 },
  app: { id: "Approved.Pad", level: "approved", count: 5 },
  ban: { id: "Banned.Pad", level: "members", count: 6 },
  adult: { id: "Adult.Pad", level: "members", count: 7, adult: true },
  unl: { id: "Unlisted.Pad", level: "members", count: 8, unlisted: true },
};
const QUIET = "Quiet.Pad";                                       // registered, not bridged
const TID = "abcdef0123";
const users = new Map(), U = {};
async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, 5, '2026-01-01 00:00:00', 0)`, [id, name, name, extra.class || "pleb", extra.camfrog || null]);
  const u = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, u); return u;
}
let seq = 0;
const ev = (room, type, data) => ({ op: "event", id: "cpd-" + (++seq), ts: new Date().toISOString(), type, scope: { platform: "camfrog", room }, data });
const snap = (id, count) => ({ room: { id, name: id }, topic: "", count, cams: true, relay: true, mic_relay: true, audio: false,
  members: [{ id: "pepefrog", login: "pepefrog", display: "Pepe", is_self: true }, { id: "willowcf", login: "willowcf", display: "Willow" }], mic: [] });
let base, server;
const SLUG = {};
const H = (u, extra = {}) => Object.assign({ "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {}, extra);
async function get(url, u, headers) {
  const r = await fetch(base + url, { headers: H(u, headers) });
  const text = await r.text(); let d = null; try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, headers: r.headers, d, text };
}
const listOf = async (u, qs = "") => {
  const r = await get("/api/casino/t/" + TID + "/chatpads" + qs, u);
  assert.equal(r.status, 200, r.text.slice(0, 200));
  return r.d;
};
const roomsOf = (d) => d.pads.map((p) => p.room);
const one = async (u, slug) => (await listOf(u, "?slug=" + encodeURIComponent(slug))).pad;
const mode = (m) => PD.save(U.admin, { cfg: { mode: m } });
const T = () => svc.S.tables.get(TID);

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, email TEXT)`);
  U.viewer = await mkUser("viewer", { camfrog: "viewercf" });
  U.member = await mkUser("member");                              // approved in the Approved pad
  U.grown = await mkUser("grown");                                // confirmed 18+
  U.owner = await mkUser("unlowner");                             // owns the unlisted pad
  U.other = await mkUser("otherone");
  U.staff = await mkUser("helper", { class: "Staff" });
  U.admin = await mkUser("boss", { class: "Admin" });
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('pepe-bot', 'pepe', 'Pepe', 'x', 'pepefrog')");
  await rooms.init();
  for (const k of Object.keys(P)) await rooms.addRoom(P[k].id, P[k].id, "test");
  await rooms.addRoom(QUIET, QUIET, "test");
  await PA.init();
  for (const k of Object.keys(P)) if (P[k].level !== "members") await runQuery("INSERT INTO pad_access (room_id, level, updated, updated_by) VALUES (?, ?, ?, 'test')", [P[k].id, P[k].level, Date.now()]);
  await runQuery("INSERT INTO pad_members (room_id, user_id, status, requested_at, decided_at, decided_by) VALUES (?, ?, 'approved', ?, ?, 'test')", [P.app.id, U.member.userId, Date.now(), Date.now()]);
  PA._reset(); await PA.init();
  await rooms.setPage(P.adult.id, { adult: true }, "test");
  await rooms.setListed(P.unl.id, false, "test");
  await rooms.setOwner(P.unl.id, "unlowner", "test");
  await bridge.ingest({ events: [ev({ id: P.home.id, name: P.home.id }, "message", { user: { id: "willowcf", login: "willowcf", display: "Willow" }, text: "hi" })],
                        rooms: Object.keys(P).map((k) => snap(P[k].id, P[k].count)) });
  for (const k of Object.keys(P)) SLUG[k] = (await rooms.get(P[k].id)).slug;
  SLUG.quiet = (await rooms.get(QUIET)).slug;
  // the 18+ gate: on, with one confirmed account
  await AG.init();
  await runQuery("UPDATE users SET age_confirmed_at = ? WHERE userId = ?", [Date.now(), U.grown.userId]);
  await AG.load();
  await AG.setEnabled(true, U.admin, "test");
  // a pad ban for the viewer in the Banned pad (feed_bans: what padbans' "whole pad" writes, with its bridge half)
  await require(path.join(repo, "feedstore")).init();
  await runQuery("INSERT INTO feed_bans (user_id, room_id, username, reason, by, at, until) VALUES (?, ?, 'viewer', 'test', 'boss', ?, NULL)", [U.viewer.userId, P.ban.id, Date.now()]);
  await require(path.join(repo, "listenban")).refresh();
  await PD.init();
  await mode("everyone");
  await svc.boot({ tick: false });
  svc.S.tables.set(TID, { id: TID, game: "holdem", status: "open", room: P.home.id, rooms: [P.home.id], adverts: [P.adv.id, QUIET], host: { uid: U.other.userId, name: "otherone" },
                         eng: { seats: [] }, players: {} });
  const app = express();
  const addUser = (req, res, next) => { const id = req.get("x-test-user"); req.user = id ? users.get(id) || null : null; next(); };
  require(path.join(repo, "casino", "routes")).register(app, { addUser, isBotToken: () => false });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { svc.stop(); if (server) server.close(); });
test.beforeEach(() => { people._reset(); CP._reset(); });

test("a viewer can open a pad they may see that was never advertised to the table: listed after the table's own, most people first", async () => {
  const d = await listOf(U.viewer);
  assert.deepEqual(d.pads.slice(0, 2).map((p) => [p.room, p.role]), [[P.home.id, "home"], [P.adv.id, "advert"]], "the table's own pads stay on top");
  assert.deepEqual(roomsOf(d), [P.home.id, P.adv.id, P.mem.id, P.pub.id], "then every other pad they may open, most people first");
  const m = d.pads.find((p) => p.room === P.mem.id);
  assert.deepEqual(m, { room: P.mem.id, slug: SLUG.mem, name: P.mem.id, role: "pad", count: 9 });
  assert.deepEqual(await one(U.viewer, SLUG.mem), m, "its exact address answers the same entry");
  assert.equal((await CP.gate(U.viewer, SLUG.mem, null)).ok, true, "and the table chat's gate (the embed's) lets it open");
});

test("can't open: an Approved pad they're not in, a banned pad, an 18+ pad without the gate, a pad Pepe isn't bridging - never named", async () => {
  const d = await listOf(U.viewer);
  const wire = JSON.stringify(d);
  for (const k of ["app", "ban", "adult", "unl"]) assert.ok(!wire.includes(P[k].id) && !wire.includes(SLUG[k]), k + ": not on the wire");
  for (const k of ["app", "ban", "adult"]) assert.equal(await one(U.viewer, SLUG[k]), null, k + ": its address doesn't open it either");
  assert.equal(await one(U.viewer, SLUG.quiet), null, "registered but not bridged: no live chat");
  assert.equal(await one(U.viewer, "no-such-pad"), null);
  for (const k of ["app", "ban", "adult"]) assert.equal((await CP.gate(U.viewer, SLUG[k], null)).ok, false, k + ": the gate says no");
  // the same pads for the people who may open them
  assert.ok(roomsOf(await listOf(U.member)).includes(P.app.id), "an approved member sees the Approved pad");
  assert.ok(roomsOf(await listOf(U.staff)).includes(P.app.id), "site staff are inside every Approved pad");
  assert.ok(roomsOf(await listOf(U.other)).includes(P.ban.id), "the pad ban is the viewer's alone");
  assert.ok(roomsOf(await listOf(U.grown)).includes(P.adult.id), "a confirmed adult passes the 18+ gate");
  assert.ok(!roomsOf(await listOf(U.member)).includes(P.adult.id), "an unconfirmed one doesn't");
});

test("bans: a whole-bridge block hides the pad, a one-feature block doesn't; the table's own pad says chat: false to a banned viewer", async () => {
  const BB = require(path.join(repo, "bridgeblocks"));
  await BB.init();
  await BB.block({ roomId: P.mem.id, target: { userId: U.other.userId, username: "otherone" }, feature: "chat", by: { name: "test" } });
  try { assert.ok(roomsOf(await listOf(U.other)).includes(P.mem.id), "a chat-only block: still listed (posting there is refused by its own rule)"); }
  finally { await BB.unblock({ roomId: P.mem.id, target: { userId: U.other.userId, username: "otherone" }, by: { name: "test" } }); }
  await BB.block({ roomId: P.mem.id, target: { userId: U.other.userId, username: "otherone" }, feature: "all", by: { name: "test" } });
  try {
    assert.ok(!roomsOf(await listOf(U.other)).includes(P.mem.id), "a whole-bridge block: gone");
    assert.equal((await CP.gate(U.other, SLUG.mem, null)).ok, false);
  } finally { await BB.unblock({ roomId: P.mem.id, target: { userId: U.other.userId, username: "otherone" }, by: { name: "test" } }); }
  assert.ok(roomsOf(await listOf(U.other)).includes(P.mem.id), "lifted: back");
  await runQuery("INSERT INTO feed_bans (user_id, room_id, username, reason, by, at, until) VALUES (?, ?, 'otherone', 'test', 'boss', ?, NULL)", [U.other.userId, P.home.id, Date.now()]);
  try {
    const d = (await get("/api/casino/t/" + TID + "/pads", U.other)).d;
    assert.deepEqual(d.pads.map((p) => [p.room, p.chat]), [[P.home.id, false], [P.adv.id, true]], "padsFor: the banned pad's chat isn't offered");
    assert.ok(!roomsOf(await listOf(U.other)).includes(P.home.id), "nor in the picker");
  } finally { await runQuery("DELETE FROM feed_bans WHERE user_id = ? AND room_id = ?", [U.other.userId, P.home.id]); }
});

test("unlisted pads: left out of the list (also as a 'recent' from the page) unless you manage it or the table plays there; the exact address reaches it", async () => {
  assert.ok(!roomsOf(await listOf(U.viewer)).includes(P.unl.id));
  assert.ok(!roomsOf(await listOf(U.viewer, "?recent=" + SLUG.unl)).includes(P.unl.id), "a recent address from the page never reaches it");
  const own = await listOf(U.owner);
  assert.equal(own.pads.find((p) => p.room === P.unl.id).role, "pad", "its owner's list has it");
  const byAddr = await one(U.viewer, SLUG.unl);
  assert.deepEqual(byAddr, { room: P.unl.id, slug: SLUG.unl, name: P.unl.id, role: "address", count: 8 }, "typed in full: reached, as p/<address> is");
  assert.equal(await one(U.viewer, "p/" + SLUG.unl).then((p) => p && p.room), P.unl.id, "a p/ prefix is the same address");
  assert.equal(await one(U.viewer, "https://publicaccess.tv/p/" + SLUG.unl + "?x=1").then((p) => p && p.room), P.unl.id, "and a pasted link");
  assert.equal(await one(U.viewer, SLUG.unl.slice(0, -1)), null, "a partial address doesn't");
  assert.equal(await one(null, SLUG.unl), null, "signed out: a Members pad, unlisted or not");
  T().adverts.push(P.unl.id);
  try { assert.equal((await listOf(U.viewer)).pads.find((p) => p.room === P.unl.id).role, "advert", "advertised at this table: it's one of the table's"); }
  finally { T().adverts.pop(); }
});

test("recent pads from the page come right after the table's own - each checked again; nonsense is ignored", async () => {
  const d = await listOf(U.viewer, "?recent=" + [SLUG.pub, SLUG.app, "no-such-pad", "<b>", SLUG.home, SLUG.pub].join(","));
  assert.deepEqual(d.pads.map((p) => [p.room, p.role]), [[P.home.id, "home"], [P.adv.id, "advert"], [P.pub.id, "recent"], [P.mem.id, "pad"]]);
  assert.doesNotMatch(JSON.stringify(d), /Approved\.Pad|no-such-pad/, "a recent pad they may not open isn't told");
});

test("guests: Public pads only (the table's and the others); the Room Dock off: nothing; staff-only Dock: staff", async () => {
  const g = await listOf(null);
  assert.deepEqual(g.pads.map((p) => [p.room, p.role]), [[P.home.id, "home"], [P.adv.id, "advert"], [P.pub.id, "pad"]]);
  assert.equal(await one(null, SLUG.mem), null);
  assert.equal(g.pads.find((p) => p.room === P.pub.id).count, 3);
  await mode("off");
  try {
    assert.deepEqual((await listOf(U.viewer)).pads, []);
    assert.equal(await one(U.viewer, SLUG.mem), null);
    assert.equal((await get("/api/casino/t/" + TID + "/pads", U.viewer)).d.more, false, "no other chats");
  } finally { await mode("everyone"); }
  await mode("staff");
  try {
    assert.deepEqual((await listOf(U.viewer)).pads, [], "the Dock is staff-only: no chat for others");
    assert.ok((await listOf(U.admin)).pads.length > 2);
  } finally { await mode("everyone"); }
});

test("more: the /pads and /people answers say other pads' chats exist for this viewer (the 💬 Chat shows with no table pad)", async () => {
  assert.equal((await get("/api/casino/t/" + TID + "/pads", null)).d.more, true, "a guest: the Public pad");
  assert.equal((await get("/api/casino/t/" + TID + "/pads", U.viewer)).d.more, true);
  assert.equal((await get("/api/casino/t/" + TID + "/people", U.viewer)).d.more, true);
  // a table with no pads of its own (web only, never advertised) still offers the others
  const was = { room: T().room, rooms: T().rooms, adverts: T().adverts };
  Object.assign(T(), { room: null, rooms: [], adverts: [] });
  try {
    const d = (await get("/api/casino/t/" + TID + "/pads", U.viewer)).d;
    assert.deepEqual(d.pads, []); assert.equal(d.more, true);
    assert.deepEqual(roomsOf(await listOf(U.viewer)), [P.mem.id, P.adv.id, P.home.id, P.pub.id], "every pad they may open, most people first (then by name)");
  } finally { Object.assign(T(), was); }
});

test("the route: anyone, private no-store, 404 for a closed table, 40 a minute per account / address; search terms never reach the server", async () => {
  const r = await get("/api/casino/t/" + TID + "/chatpads", null);
  assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.equal((await get("/api/casino/t/ffffffffff/chatpads", U.viewer)).status, 404);
  assert.equal((await get("/api/casino/t/nope/chatpads", U.viewer)).status, 404);
  CP._reset();
  for (let i = 0; i < 40; i++) assert.equal((await get("/api/casino/t/" + TID + "/chatpads", U.viewer)).status, 200);
  assert.equal((await get("/api/casino/t/" + TID + "/chatpads", U.viewer)).status, 429);
  assert.equal((await get("/api/casino/t/" + TID + "/chatpads", U.other)).status, 200, "per account");
  const src = fs.readFileSync(path.join(repo, "public", "js", "casino-chat.js"), "utf8");
  assert.doesNotMatch(src, /chatpads[^"'`]*[?&]q=/, "the page filters the list itself - what's typed stays in the page (only a full address is asked)");
});
