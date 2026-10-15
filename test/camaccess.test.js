// Offline tests for 📡 who can watch my cam (camaccess.js, 1.99aar): the modes (everyone / members / followers / request),
// asking + the owner's answer (this time / always / no), the "always" list, Pepe's notices, tightening ending live viewers,
// and camRefusal (camviewers.js) asking it after the off switch / blocks - ghosts still get past.
//   node --test test/camaccess.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "camaccess-test-"));
process.chdir(tmp);
const { runQuery } = require(path.join(repo, "dbUtils"));
const CA = require(path.join(repo, "camaccess"));
const CV = require(path.join(repo, "camviewers"));

let T = 1_800_000_000_000;
CA._setClock(() => T);
CV._setClock(() => T);
const VERIFIED = new Set(["u-ver"]);
const FOLLOWS = new Set(["u-fan"]);
const notices = [];
let live = [];
const dropped = [];
CA._setDeps({
  verified: async (uid) => VERIFIED.has(uid),
  follows: async (uid, owner) => owner === "u-owner" && FOLLOWS.has(uid),
  ownerAccount: async (login) => (login === "alice" ? { userId: "u-owner", username: "alice_patv" } : null),
  notify: async (uid, n) => { notices.push({ uid, ...n }); return true; },
  liveWatchers: () => live,
  dropViewer: (owner, uid, why) => { dropped.push([owner, uid, why]); live = live.filter((w) => w.userId !== uid); return 1; },
});
let ghosts = new Set();
CV._setDeps({ optedOut: () => false, privateLogins: async () => new Set(), isGhost: (uid) => ghosts.has(uid) });

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, camfrogUsername TEXT)`);
  for (const [id, name] of [["u-owner", "alice_patv"], ["u-ver", "vera"], ["u-fan", "fanny"], ["u-rando", "rando"], ["u-staff", "boss"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, camfrogUsername) VALUES (?, ?, ?, ?)", [id, name, name, id === "u-owner" ? "alice" : null]);
  }
  await CA.init();
  await CV.init();
});

test("verified members is the default (1.99aav); everyone is a choice that's kept; the owner always sees their own cam", async () => {
  assert.equal(CA.accessOf("alice").mode, "members");
  assert.equal(await CA.gate("alice", "u-ver"), null);
  const g = await CA.gate("alice", "u-rando");
  assert.equal(g.code, "cam_members");
  assert.equal(g.can_ask, true, "an unverified viewer can still ask");
  await CA.setMode("alice", "everyone", { via: "web" });
  assert.equal(CA.accessOf("alice").mode, "everyone");
  assert.equal(await CA.gate("alice", "u-rando"), null);
  CA._reset();
  await CA.init();
  assert.equal(CA.accessOf("alice").mode, "everyone", "an explicit everyone survives a restart");
  await CA.setMode("alice", "request", { via: "web" });
  assert.equal(await CA.gate("alice", "u-owner"), null);
  await CA.setMode("alice", "everyone", { via: "web" });
});

test("members and followers modes; others can ask unless the owner turns asking off", async () => {
  await CA.setMode("alice", "members");
  assert.equal(await CA.gate("alice", "u-ver"), null);
  const g = await CA.gate("alice", "u-rando");
  assert.equal(g.code, "cam_members");
  assert.equal(g.can_ask, true);
  await CA.setMode("alice", "followers", { ask: false });
  assert.equal(await CA.gate("alice", "u-fan"), null);
  assert.ok(await CA.gate("alice", "u-ver"), "verified isn't enough in followers mode");
  assert.equal((await CA.gate("alice", "u-rando")).can_ask, false);
  const r = await CA.ask("alice", { userId: "u-rando", username: "rando" }, "Room1");
  assert.equal(r.ok, false);
  await CA.setMode("alice", "everyone", { ask: true });
});

test("on request: ask -> Pepe's notice + the owner's inbox -> allow this time -> in for 6 h, then asks again", async () => {
  await CA.setMode("alice", "request");
  notices.length = 0;
  const r = await CA.ask("alice", { userId: "u-rando", username: "rando" }, "Room1");
  assert.equal(r.pending, true);
  assert.equal((await CA.ask("alice", { userId: "u-rando", username: "rando" }, "Room1")).id, r.id, "one open request per viewer");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].uid, "u-owner");
  const out = CA.forBot({ ca: true });
  assert.equal(out.length, 1);
  assert.equal(out[0].login, "alice");
  assert.equal(out[0].username, "rando");
  assert.equal(CA.forBot({ ca: true }).length, 0, "not again right away");
  T += 21 * 1000;
  assert.equal(CA.forBot({ ca: true, ca_ack: [r.id] }).length, 0, "acked: never again");
  assert.equal((await CA.askState("alice", "u-rando")).state, "pending");
  const g = await CA.gate("alice", "u-rando");
  assert.equal(g.pending, true);
  const a = await CA.answer("alice", "rando", "once", { via: "chat" });
  assert.equal(a.ok, true);
  assert.equal(await CA.gate("alice", "u-rando"), null);
  assert.equal((await CA.askState("alice", "u-rando")).state, "allowed");
  assert.ok(notices.some((n) => n.uid === "u-rando" && /lets you watch/.test(n.title)));
  T += CA.GRANT_MS + 1000;
  assert.ok(await CA.gate("alice", "u-rando"), "the 6 hours are up");
});

test("no: refused, can't ask again for a while; always: on the list for good; removing ends their live stream", async () => {
  await CA.setMode("alice", "request");
  await CA.ask("alice", { userId: "u-ver", username: "vera" }, "Room1");
  await CA.answer("alice", "vera", "no", { via: "web" });
  assert.equal((await CA.askState("alice", "u-ver")).state, "no");
  assert.equal((await CA.ask("alice", { userId: "u-ver", username: "vera" }, "Room1")).ok, false);
  T += CA.REASK_MS + 1000;
  assert.equal((await CA.ask("alice", { userId: "u-ver", username: "vera" }, "Room1")).ok, true);
  await CA.answer("alice", "vera", "always", { via: "web" });
  assert.deepEqual(CA.listAllow("alice").map((x) => x.username), ["vera"]);
  T += 30 * 24 * 3600 * 1000;
  assert.equal(await CA.gate("alice", "u-ver"), null, "always = always");
  live = [{ userId: "u-ver", room: "Room1" }, { userId: "u-owner" }];
  const d = await CA.disallow("alice", "vera");
  assert.equal(d.ended, 1);
  assert.deepEqual(dropped.pop(), ["alice", "u-ver", "cam_access"]);
  assert.ok(await CA.gate("alice", "u-ver"));
});

test("tightening the mode cuts off live viewers who no longer qualify", async () => {
  await CA.setMode("alice", "everyone");
  live = [{ userId: "u-fan" }, { userId: "u-rando" }, { userId: "u-staff", ghost: true }];
  const r = await CA.setMode("alice", "followers");
  assert.equal(r.ended, 1);
  assert.deepEqual(live.map((w) => w.userId).sort(), ["u-fan", "u-staff"]);
  await CA.setMode("alice", "everyone");
});

test("camRefusal asks it (with can_ask for the page); ghosts still get past to VIEW, never to save; it survives a restart", async () => {
  await CA.setMode("alice", "members");
  const ref = await CV.camRefusal("alice", "u-rando");
  assert.equal(ref.code, "cam_members");
  assert.equal(ref.can_ask, true);
  ghosts = new Set(["u-staff"]);
  assert.equal(await CV.camRefusal("alice", "u-staff"), null);
  assert.equal((await CV.camRefusal("alice", "u-staff", { strict: true })).code, "cam_members");
  assert.match(await CV.bypassOf("alice", "u-staff"), /cam_members/);
  CA._reset();
  await CA.init();
  assert.equal(CA.accessOf("alice").mode, "members", "the mode is stored");
  await CA.setMode("alice", "everyone");
});
