// Offline tests for gatefix site (aigen.js bridgeRoom): Generate's "📷 From a cam in this room" (GET /api/feed/aigen/cams)
// and claiming a snapshot (POST /api/feed/aigen/camref) follow the 💎 Prime Time Plus bridge gate like every other web
// view of a Camfrog room (bridge.isLiveShown - /live, /snap, room audio, clips, live cams). Before, aigen asked the raw
// bridge.isLive, so with premium plus_bridge_gate on the pad page hid a non-Plus pad's room while the cam list still
// named everyone on cam there.
//   * gate on: a pad without the bridge perk answers exactly like a room that isn't live - no names; no snapshot claim
//   * gate on: Plus pads and house pads list as before; gate off: every pad as before
// Through the REAL bridge room table and premium module (no room stub; only the snapshot store is stubbed).
//   NODE_PATH=G:/PATV/node_modules node --test test/aigen-cams-bridge.test.js      (temp DB + dirs)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aigen-cams-bridge-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.FEED_DIR = path.join(tmp, "feedfiles");
process.env.MEDIA_DIR = path.join(tmp, "mediafiles");
process.env.FEED_NO_NICE = "1";
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const store = require(path.join(repo, "feedstore"));
const AG = require(path.join(repo, "aigen"));
const PA = require(path.join(repo, "padaccess"));
const PR = require(path.join(repo, "premium"));
const bridge = require(path.join(repo, "bridge"));
const pads = require(path.join(repo, "pads"));
require(path.join(repo, "terms"))._setRequired(false);

const BOT = "bot";
const GATED = "gatecam.Room", PLUS = "pluscam.Room", HOUSE = "housecam.Room";
const ROSTER = () => [
  { login: "PepeFrog", display: "PepeFrog", self: true, on_cam: true },
  { login: "zz_secretcam", display: "Zed Secret", on_cam: true },
  { login: "aa_privatecam", display: "Ava Private", on_cam: true },
  { anon: true, display: "someone", on_cam: true },
];
const LISTED = ["aa_privatecam", "zz_secretcam"];
const SECRETS = ["zz_secretcam", "Zed Secret", "aa_privatecam", "Ava Private"];
const NOT_LIVE = { ok: true, cams: [], why: "That pad's Camfrog room isn't live on the site right now." };
const SID = "sgoodframe";

let base, server;
const U = {};
const users = new Map();
async function mkUser(name, extra = {}) {
  const id = "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, 1000, ?, 5, '2026-01-01 00:00:00', 0)`, [id, name, name, extra.class || "pleb", extra.camfrog || null]);
  const u = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, u);
  return u;
}
/** Pepe synced the room just now (bridge.isLive: a sync within STALE_MS). */
function live(id) {
  bridge._rooms.set(id, { id, name: id, slug: pads.padSlug(rooms.getCached(id)), cams: true, members: ROSTER(), mic: [], count: 4,
                          updated: Date.now(), feed: [] });
}

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, archived_at INTEGER)`);
  await runQuery("CREATE TABLE transactions (transactionId TEXT PRIMARY KEY, userId TEXT, type TEXT, points INTEGER, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  U.owner = await mkUser("padowner", { camfrog: "ownercf" });
  U.viewer = await mkUser("viewer", { camfrog: "viewercf" });
  U.staff = await mkUser("staffer", { class: "Staff" });
  await rooms.init();
  for (const id of [GATED, PLUS, HOUSE]) await rooms.addRoom(id, id.split(".")[0], "test");
  await rooms.setOwner(GATED, "padowner", "test");
  await rooms.setOwner(PLUS, "padowner", "test");
  await rooms.setOwner(HOUSE, "house", "test");
  await store.init();
  await PA.init();
  await PR.init();
  const t = Date.now();
  await runQuery("INSERT INTO premium_subs (tier, target, comped, started, updated) VALUES ('prime_plus', ?, 1, ?, ?)", [PLUS, t, t]);
  await PR.loadCache();
  // only the snapshot store is stubbed (bridge-relay snapForGen); the room comes from the real bridge table
  AG._setBridge(null, (roomId, sid) => (sid === SID ? { login: "zz_secretcam", img: Buffer.from("frame") } : null));
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? users.get(u) || null : null; next(); };
  AG.register(app, { addUser, isBotToken: (x) => x === BOT, noTimers: true, audit: async () => {} });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(async () => {
  if (server) server.close();
  await PR.setConfig({ plus_bridge_gate: false }, "test");
});

async function cams(pad, u) {
  const r = await fetch(base + "/api/feed/aigen/cams?pad=" + encodeURIComponent(pad), { headers: { "x-test-user": u.userId } });
  const text = await r.text();
  return { status: r.status, d: JSON.parse(text), text };
}
async function claim(pad, u) {
  const r = await fetch(base + "/api/feed/aigen/camref", { method: "POST", body: JSON.stringify({ pad, sid: SID }),
    headers: { "content-type": "application/json", "x-requested-with": "fetch", "x-test-user": u.userId } });
  const text = await r.text();
  return { status: r.status, d: JSON.parse(text), text };
}
const gate = (on) => PR.setConfig({ plus_bridge_gate: on }, "test");

test("gate off: every live Camfrog pad lists who's on cam and a snapshot can be claimed (as before)", async () => {
  await gate(false);
  for (const id of [GATED, PLUS, HOUSE]) {
    live(id);
    assert.equal(bridge.bridgeOk(id), true, id);
    const r = await cams(id, U.viewer);
    assert.deepEqual(r.d.cams.map((c) => c.login), LISTED, id + ": " + r.text);
    assert.equal((await claim(id, U.viewer)).status, 200, id + ": claimed");
  }
  AG._camRefs.clear();
});

test("gate on: a pad without the bridge perk answers like a room that isn't live - no names, no snapshot claim; Plus and house pads as before", async () => {
  await gate(true);
  try {
    for (const id of [GATED, PLUS, HOUSE]) live(id);
    assert.equal(bridge.bridgeOk(GATED), false, "the pad page hides this room (bridge.isLiveShown)");
    for (const u of [U.viewer, U.owner, U.staff]) {
      const r = await cams(GATED, u);
      assert.deepEqual(r.d, NOT_LIVE, u.username + ": exactly the not-live answer (" + r.text + ")");
      for (const s of SECRETS) assert.ok(!r.text.includes(s), u.username + ": never " + s);
      const c = await claim(GATED, u);
      assert.equal(c.status, 403, u.username + ": no snapshot claim (" + c.text + ")");
      for (const s of SECRETS) assert.ok(!c.text.includes(s), u.username + ": the refusal names nobody");
    }
    assert.equal(AG._camRefs.size, 0, "nothing claimed from the hidden room");
    for (const id of [PLUS, HOUSE]) {
      assert.equal(bridge.bridgeOk(id), true, id);
      assert.deepEqual((await cams(id, U.viewer)).d.cams.map((c) => c.login), LISTED, id + ": the perk (or a house pad) - as before");
      assert.equal((await claim(id, U.viewer)).status, 200, id + ": claimed");
    }
  } finally {
    AG._camRefs.clear();
    await gate(false);
  }
  live(GATED);
  assert.deepEqual((await cams(GATED, U.viewer)).d.cams.map((c) => c.login), LISTED, "gate off again: listed");
});

test("gate on: a stale room (no sync for a while) is still not live, perk or not", async () => {
  await gate(true);
  try {
    live(PLUS);
    bridge._rooms.get(PLUS).updated = Date.now() - 10 * 60e3;
    assert.deepEqual((await cams(PLUS, U.viewer)).d, NOT_LIVE);
  } finally { await gate(false); live(PLUS); }
});
