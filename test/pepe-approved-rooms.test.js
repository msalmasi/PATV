// Offline tests for gatefix site (padaccess.liveRoomsOutside / gateLiveRooms): Pepe's answers to a member - his site DMs
// (messages.pepeClaim) and his Telegram chat (telegram.whois) - are written from a live context that names who's around,
// who's on the mic and recent lines in every room he's in (camfrog-bot pepe_dmctx). An Approved pad's live room is for its
// members only, so the claim / whois now carry user.rooms_gated = the Camfrog rooms of the Approved pads this member is
// outside of, and Pepe leaves those rooms out (the same field staging's 18+ gate fills; this part is not tied to a switch).
//   * an outsider (never asked, pending, denied, removed): their Approved pads' Camfrog rooms - never a site-only pad's id
//   * the pad's approved members, its owner, site Staff / Admins: nothing left out = no field (exactly as before)
//   * no Approved pads at all: no field (as before); access changes apply at once; the class is read fresh
//   * whatever is in rooms_gated already is kept (joined, each room once); the levels unreadable -> the claim claims nothing
//   * the room ids are never logged
//   NODE_PATH=G:/PATV/node_modules node --test test/pepe-approved-rooms.test.js      (temp DB + dirs)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pepe-approved-rooms-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.DM_DIR = path.join(tmp, "dmfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
process.env.FEED_NO_NICE = "1";
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const inbox = require(path.join(repo, "inbox"));
const follows = require(path.join(repo, "follows"));
const store = require(path.join(repo, "feedstore"));
const dm = require(path.join(repo, "messages"));
const TG = require(path.join(repo, "telegram"));
const PA = require(path.join(repo, "padaccess"));
const premium = require(path.join(repo, "premium"));
require(path.join(repo, "terms"))._setRequired(false);

const APP = "hushcam.Room", APP2 = "quietcam.Room", MEM = "opencam.Room", SITE = "patv:hideout";
let T = Date.now();
dm._setClock(() => T);
const U = {};
const LOGS = [];
let tgSeq = 7100;
async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, camfrogUsername, level, created_at) VALUES (?, ?, ?, 'x', ?, ?, 5, '2026-01-01 00:00:00')`,
                 [id, name, name, extra.class || "pleb", name + "cf"]);
  const u = { userId: id, username: name, class: extra.class || "pleb", tg: String(tgSeq++) };
  await runQuery("INSERT INTO telegram_links (user_id, tg_id, linked_at) VALUES (?, ?, 1)", [id, u.tg]);
  return (U[name] = u);
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS feed_bans (user_id TEXT NOT NULL, room_id TEXT NOT NULL DEFAULT '', username TEXT, reason TEXT, by TEXT, at INTEGER,
                  until INTEGER, PRIMARY KEY (user_id, room_id))`);
  await inbox.ready; await follows.init(); await store.init(); await dm.init(); await TG.init(); await premium.init();
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES ('pepe-bot', 'pepe', 'Pepe', 'x', 'Bot', 'pepefrog')");
  for (const n of ["padowner", "invitee", "outsider", "asker", "deniedone", "removedone"]) await mkUser(n);
  await mkUser("staffer", { class: "Staff" });
  await mkUser("siteadmin", { class: "Admin" });
  await rooms.init();
  for (const id of [APP, APP2, MEM, SITE]) {
    await rooms.addRoom(id, id.split(/[.:]/)[1] + " pad", "test");
    await rooms.setOwner(id, "padowner", "test");
  }
  await PA.init();
  for (const k of ["log", "error", "warn", "info"]) {
    const orig = console[k];
    console[k] = (...a) => { LOGS.push(a.map(String).join(" ")); orig.apply(console, a); };
  }
});

/** The "who they are" object Pepe's DM claim carries for `u` (a fresh message to Pepe, claimed and answered). */
async function claimFor(u) {
  T += 120e3;
  dm._gaps.clear();
  await dm.send(u, { to: "pepe", body: "who's around in the rooms?" });
  const c = (await dm.pepeClaim()).find((x) => x.user.username === u.username);
  assert.ok(c, u.username + ": claimed");
  await dm.pepeReply({ conversation: c.conversation, upto: c.upto, text: "" });
  return c.user;
}
const whoisFor = async (u) => (await TG.whois({ tg_id: u.tg })).user;
const OUTSIDERS = ["outsider", "asker", "deniedone", "removedone"];
const INSIDERS = ["invitee", "padowner", "staffer", "siteadmin"];

test("no Approved pads: the DM claim and Telegram's whois are exactly as before - no rooms_gated", async () => {
  for (const v of OUTSIDERS.concat(INSIDERS)) {
    assert.ok(!("rooms_gated" in (await whoisFor(U[v]))), v + ": whois");
    assert.ok(!("rooms_gated" in (await claimFor(U[v]))), v + ": the DM claim");
  }
  const w = await whoisFor(U.outsider);
  assert.deepEqual(Object.keys(w).sort(), ["camfrog", "display", "user_id", "username"], "whois keeps its minimal fields");
});

test("Approved pads: an outsider's claim / whois name their Camfrog rooms (never a site-only pad); insiders get no field", async () => {
  for (const id of [APP, APP2, SITE]) await PA.setLevel(U.padowner, await rooms.get(id), "approved");
  for (const id of [APP, APP2]) {
    const R = await rooms.get(id);
    await PA.request(U.invitee, R, "hi"); await PA.decide(U.padowner, R, U.invitee.userId, true);
    await PA.request(U.asker, R, "let me in");
    await PA.request(U.deniedone, R, "please"); await PA.decide(U.padowner, R, U.deniedone.userId, false);
    await PA.request(U.removedone, R, "me too"); await PA.decide(U.padowner, R, U.removedone.userId, true);
    await PA.remove(U.padowner, R, U.removedone.userId);
  }
  for (const v of OUTSIDERS) {
    assert.deepEqual((await whoisFor(U[v])).rooms_gated.slice().sort(), [APP, APP2].sort(), v + ": Telegram - the Approved pads' rooms");
    assert.deepEqual((await claimFor(U[v])).rooms_gated.slice().sort(), [APP, APP2].sort(), v + ": the DM claim too");
  }
  for (const v of INSIDERS) {
    assert.ok(!("rooms_gated" in (await whoisFor(U[v]))), v + ": inside every Approved pad - nothing left out");
    assert.ok(!("rooms_gated" in (await claimFor(U[v]))), v + ": the claim as before");
  }
  assert.ok(!(await whoisFor(U.outsider)).rooms_gated.includes(MEM), "a Members pad's room is never left out");
});

test("access changes apply at once: approved -> that room drops off; removed -> back; the class is read fresh", async () => {
  const R = await rooms.get(APP);
  await PA.decide(U.padowner, R, U.asker.userId, true);
  assert.deepEqual((await whoisFor(U.asker)).rooms_gated, [APP2], "approved into one: only the other is left out");
  assert.deepEqual((await claimFor(U.asker)).rooms_gated, [APP2]);
  await PA.remove(U.padowner, R, U.asker.userId);
  assert.deepEqual((await whoisFor(U.asker)).rooms_gated.slice().sort(), [APP, APP2].sort(), "removed: left out again");
  await runQuery("UPDATE users SET class = 'pleb' WHERE userId = ?", [U.staffer.userId]);
  try {
    assert.deepEqual((await whoisFor(U.staffer)).rooms_gated.slice().sort(), [APP, APP2].sort(), "no longer Staff: at once (Telegram)");
    assert.deepEqual((await claimFor(U.staffer)).rooms_gated.slice().sort(), [APP, APP2].sort(), "and the DM claim");
  } finally { await runQuery("UPDATE users SET class = 'Staff' WHERE userId = ?", [U.staffer.userId]); }
  await PA.setLevel(U.padowner, await rooms.get(APP2), "members");
  try {
    assert.deepEqual((await whoisFor(U.outsider)).rooms_gated, [APP], "a pad opened to members drops off");
  } finally { await PA.setLevel(U.padowner, await rooms.get(APP2), "approved"); }
});

test("gateLiveRooms joins whatever is there (staging's 18+ rooms) - each room once; nothing to add keeps the object as it was", async () => {
  const outsider = await getQuery("SELECT userId, class FROM users WHERE userId = ?", [U.outsider.userId]).then((r) => r[0]);
  const a = await PA.gateLiveRooms({ username: "outsider", rooms_gated: ["adult.Room", APP] }, outsider);
  assert.deepEqual(a.rooms_gated.slice().sort(), ["adult.Room", APP, APP2].sort());
  const member = await getQuery("SELECT userId, class FROM users WHERE userId = ?", [U.invitee.userId]).then((r) => r[0]);
  assert.deepEqual(await PA.gateLiveRooms({ username: "invitee", rooms_gated: ["adult.Room"] }, member), { username: "invitee", rooms_gated: ["adult.Room"] });
  assert.deepEqual(await PA.gateLiveRooms({ username: "invitee" }, member), { username: "invitee" }, "no field added");
  assert.deepEqual((await PA.gateLiveRooms({}, null)).rooms_gated.slice().sort(), [APP, APP2].sort(), "no account: every Approved room (fails closed)");
  assert.deepEqual(PA.liveRoomsOutside(outsider).slice().sort(), [APP, APP2].sort(), "never the site-only pad " + SITE);
});

test("the pad levels unreadable: the DM claim claims nothing (rather than answer with every room in context); the room ids are never logged", async () => {
  T += 120e3;
  dm._gaps.clear();
  await dm.send(U.outsider, { to: "pepe", body: "still there?" });
  const init = PA.init;
  PA.init = () => Promise.reject(new Error("db down"));
  try {
    await assert.rejects(dm.pepeClaim(), /db down/);
  } finally { PA.init = init; }
  const pending = await getQuery("SELECT state FROM pepe_dm_jobs WHERE user_id = ? AND state = 'pending'", [U.outsider.userId]);
  assert.ok(pending.length >= 1, "the message still waits for his next claim");
  LOGS.length = 0;
  const c = (await dm.pepeClaim()).find((x) => x.user.username === "outsider");
  assert.deepEqual(c.user.rooms_gated.slice().sort(), [APP, APP2].sort(), "the next claim carries the list");
  await dm.pepeReply({ conversation: c.conversation, upto: c.upto, text: "" });
  assert.ok((await whoisFor(U.outsider)).rooms_gated.length === 2);
  for (const line of LOGS) assert.ok(!line.includes(APP) && !line.includes(APP2), "the claim / whois never log the rooms: " + line);
});
