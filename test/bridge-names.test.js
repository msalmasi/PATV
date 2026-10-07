// Names on the Camfrog room bridge (1.99ea, bridge.js): a speaker shows as their PATV display name when
// their Camfrog LOGIN resolves to a live account (userlinks.js rules), else their Camfrog display name,
// else the login - never the bare login when something better is known. Resolution is by login only;
// anonymised people ("someone") are never looked up and never carry a login; Pepe keeps his own name;
// old payloads without a display field still render; the web relay sends the PATV display name.
//   NODE_PATH=G:/PATV/node_modules node --test test/bridge-names.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-names-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const { runQuery } = require(path.join(repo, "dbUtils"));
const bridge = require(path.join(repo, "bridge"));
const relay = require(path.join(repo, "bridge-relay"));
const UL = require(path.join(repo, "userlinks"));

const ROOM = { id: "Names.Room", name: "Names Room" };
let seq = 0;
const ev = (type, data) => ({ op: "event", id: "t-" + (++seq), ts: new Date().toISOString(), type, scope: { platform: "camfrog", room: ROOM }, data });
const msg = (user, text) => ev("message", { user, text });

test.before(async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER)`);
  const add = (id, username, displayname, cf, archived = null, avatar = null) => runQuery(
    "INSERT INTO users (userId, username, displayname, password, camfrogUsername, archived_at, avatar) VALUES (?, ?, ?, 'x', ?, ?, ?)",
    [id, username, displayname, cf, archived, avatar]);
  await add("u1", "plantbaked", "plantbaked", "foamy1111", null, "/public/img/a.png");
  await add("u2", "CFa1b2c3d4", "CFa1b2c3d4", "foamy1111");            // Pepe's random auto account: never preferred
  await add("u3", "gone", "Gone Person", "jardoo", 1700000000);         // archived: never matches
  await add("u4", "secretsam", "Secret Sam", "sam_hidden");             // has an account but is incognito in the room
  await add("u5", "pepe_site", "Pepe Site", "pepefrog");
  await add("u6", "webby", "Webby McWeb", "webby_cf");
  await add("u7", "victim", "Victim", "victim_cf");
  await add("u8", "faker", "victim_cf", "faker_cf");                    // a display name that is someone else's login
  UL._setQuery(null);
});

async function feedFor(events, rooms) {
  await bridge.ingest({ events, rooms: rooms || [] });
  const R = bridge.bySlug("names-room");
  assert.ok(R, "room exists");
  return bridge.liveView(R, 0);
}

test("PATV display name > Camfrog display name > login; resolved by login; tooltip data kept", async () => {
  bridge._nameCache.clear();
  const v = await feedFor([
    msg({ id: "foamy1111", login: "foamy1111", display: "plantbaked" }, "i love olive oil"),
    msg({ id: "j____b", login: "J____B", display: "J B" }, "hello"),
    msg({ id: "kim", login: "kim", display: "kim" }, "no account, no display"),
    msg({ id: "jardoo", login: "jardoo", display: "<b>Jardoo</b>" }, "archived account"),
  ]);
  const by = Object.fromEntries(v.feed.filter((x) => x.k === "msg").map((x) => [x.text, x.u]));
  const a = by["i love olive oil"];
  assert.equal(a.display, "plantbaked");
  assert.equal(a.login, "foamy1111", "the login stays for the tooltip");
  assert.equal(a.patv.username, "plantbaked", "a real account beats the CF auto one");
  assert.equal(a.patv.avatar, "/public/img/a.png");
  const b = by["hello"];
  assert.equal(b.display, "J B", "no account -> the Camfrog display name");
  assert.equal(b.login, "J____B");
  assert.equal(b.cf, "J B");
  assert.ok(!b.patv);
  assert.equal(by["no account, no display"].display, "kim", "nothing else known -> the login");
  const j = by["archived account"];
  assert.ok(!j.patv, "an archived account never matches");
  assert.ok(!/</.test(j.display), "markup never reaches the page");
});

test("an old payload without the display field still renders (login fallback, PATV name when linked)", async () => {
  bridge._nameCache.clear();
  const v = await feedFor([msg({ id: "foamy1111", login: "foamy1111" }, "old payload linked"), msg({ id: "zed", login: "zed" }, "old payload plain")]);
  const by = Object.fromEntries(v.feed.filter((x) => x.k === "msg").map((x) => [x.text, x.u]));
  assert.equal(by["old payload linked"].display, "plantbaked");
  assert.equal(by["old payload plain"].display, "zed");
});

test("incognito / !bridge hide stays 'someone' and is never looked up or revealed", async () => {
  bridge._nameCache.clear();
  const anon = { id: "anon-1a2b3c4d", display: "someone", anonymous: true };
  const v = await feedFor([ev("mic.grab", { user: anon })], [{ room: ROOM, members: [anon, { id: "foamy1111", login: "foamy1111", display: "plantbaked" }], mic: [anon], count: 2 }]);
  const grab = v.feed.filter((x) => x.k === "mic").pop();
  assert.equal(grab.u.anon, true);
  assert.equal(grab.u.display, "someone");
  assert.ok(!grab.u.login && !grab.u.patv, "no login / account on an anonymised user");
  const m = v.members.find((x) => x.anon);
  assert.deepEqual(m, { anon: true, display: "someone" });
  assert.ok(!JSON.stringify(v).includes("sam_hidden") && !JSON.stringify(v).includes("Secret Sam"));
  assert.ok(!bridge._nameCache.has("someone"), "the stand-in is never looked up");
  // anonymised chat lines are dropped outright (Pepe never sends them; belt and braces)
  const v2 = await feedFor([msg(anon, "hidden words")]);
  assert.ok(!v2.feed.some((x) => x.text === "hidden words"));
});

test("mic lines, transcripts, the roster and the homepage mic list use the same names", async () => {
  bridge._nameCache.clear();
  const u = { id: "foamy1111", login: "foamy1111", display: "plantbaked" };
  const v = await feedFor([ev("mic.grab", { user: u }), ev("x.pepe.transcript", { user: { id: "j____b", login: "J____B", display: "J B" }, text: "said on the mic" })],
    [{ room: ROOM, members: [u, { id: "j____b", login: "J____B" }], mic: [u], count: 2 }]);
  assert.equal(v.feed.filter((x) => x.k === "mic").pop().u.display, "plantbaked");
  assert.equal(v.feed.filter((x) => x.k === "tx").pop().u.display, "J B");
  assert.equal(v.mic[0].display, "plantbaked");
  assert.equal(v.members.find((x) => x.login === "foamy1111").display, "plantbaked");
  assert.equal(v.members.find((x) => x.login === "J____B").display, "J____B", "old roster entry without a display -> the login");
  const s = (await bridge.summary(true)).find((r) => r.slug === "names-room");
  assert.deepEqual(s.mic, ["plantbaked"]);
});

test("Pepe keeps his own name; the lookup is cached per login", async () => {
  bridge._nameCache.clear();
  const v = await feedFor([msg({ id: "pepefrog", login: "PepeFrog", display: "PepeFrog", is_self: true }, "🌐 Webby McWeb (web): hi")]);
  const p = v.feed.filter((x) => x.k === "msg").pop().u;
  assert.equal(p.display, "PepeFrog");
  assert.equal(p.self, true);
  const before = UL.stats.lookups;
  const R = bridge.bySlug("names-room");
  await bridge.liveView(R, 0);
  await bridge.liveView(R, 0);
  assert.equal(UL.stats.lookups, before, "a poll within the TTL costs no query");
});

test("a display name never impersonates: matching is by login only", async () => {
  bridge._nameCache.clear();
  // someone whose Camfrog DISPLAY name is another person's login gets no link to that person
  const v = await feedFor([msg({ id: "nobody1", login: "nobody1", display: "foamy1111" }, "i am foamy, honest")]);
  const u = v.feed.filter((x) => x.k === "msg").pop().u;
  assert.ok(!u.patv);
  assert.equal(u.login, "nobody1");
});

test("web relay: the PATV display name rides on say / clip jobs, never someone else's login or Pepe's", async () => {
  assert.equal(await relay.webName({ username: "webby", displayname: "Webby McWeb" }), "Webby McWeb");
  assert.equal(await relay.webName({ username: "faker", displayname: "victim_cf" }), "", "another account's login is refused");
  assert.equal(await relay.webName({ username: "x", displayname: "PepeFrog" }), "");
  assert.equal(await relay.webName({ username: "x", displayname: "" }), "", "none -> Pepe picks (Camfrog display, then login)");
  assert.equal(await relay.webName({ username: "plantbaked", displayname: "plantbaked" }), "plantbaked", "your own username is fine");
  const j = relay.newJob({ kind: "say", roomId: ROOM.id, userId: "u6", username: "webby", camfrog: "webby_cf", display: "Webby McWeb", text: "hi" });
  const out = relay.takeJobs(new Set([ROOM.id])).find((x) => x.id === j.id);
  assert.equal(out.display, "Webby McWeb");
  const k = relay.newJob({ kind: "say", roomId: ROOM.id, userId: "u6", username: "webby", camfrog: "webby_cf", text: "old" });
  assert.ok(!("display" in relay.takeJobs(new Set([ROOM.id])).find((x) => x.id === k.id)), "no display -> no field (old Pepe unaffected)");
});
