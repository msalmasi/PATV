// Offline tests (1.99yh): cam snapshots and cam clips follow the pad's access rule (padaccess.full) like the room audio:
// signed in, and on an Approved pad only its members (owner / staff / approved). The routes check it themselves (the
// /api/rooms/:slug gate isn't mounted here on purpose - the check must not depend on it).
//   node --test test/cam-padaccess.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "campad-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const relay = require(path.join(repo, "bridge-relay"));
const camclip = require(path.join(repo, "camclip"));
const PA = require(path.join(repo, "padaccess"));
require(path.join(repo, "actions"));

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
const OPEN = { id: "Room.Open", slug: "room-open", cams: true, members: [{ login: "alice", on_cam: true }] };
const LOCKED = { id: "Room.Locked", slug: "room-locked", cams: true, members: [{ login: "alice", on_cam: true }] };
const bySlug = (s) => (s === OPEN.slug ? OPEN : s === LOCKED.slug ? LOCKED : null);

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  await new Promise((r) => setTimeout(r, 100));
  for (const [id, cf, cls] of [["member", "m1", "pleb"], ["outsider", "o1", "pleb"], ["staff", "s1", "Admin"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, 'x', ?, ?)",
      [id, id + "_patv", id, cls, cf]);
  }
  await PA.init();
  await runQuery("INSERT INTO pad_access (room_id, level) VALUES (?, 'approved')", [LOCKED.id]);
  await runQuery("INSERT INTO pad_members (room_id, user_id, status) VALUES (?, 'member', 'approved')", [LOCKED.id]);
  await PA.load();
  camclip._setDeps({ snapSwitch: () => true, clipSwitch: () => true, privateLogins: async () => new Set(), modCaps: () => null });
  camclip._setDir(path.join(tmp, "clips"));
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u } : null; next(); };
  relay.register(app, { isBotToken: (t) => t === "bot-token", addUser, bySlug, isLive: () => true });
  camclip.register(app, { isBotToken: (t) => t === "bot-token", addUser, bySlug, isLive: () => true });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server.close());

const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u } : {});
async function post(p, body, u) {
  const r = await fetch(base + p, { method: "POST", headers: H(u), body: JSON.stringify(body) });
  return { status: r.status, d: await r.json().catch(() => ({})) };
}
async function get(p, u) { const r = await fetch(base + p, { headers: H(u) }); return { status: r.status, d: await r.json().catch(() => ({})) }; }

test("snapshot: signed out is refused everywhere; any signed-in account on a Members pad", async () => {
  assert.equal((await post("/api/rooms/room-open/snap", { login: "alice" }, null)).status, 401);
  assert.equal((await get("/api/rooms/room-open/snap/alice", null)).status, 401);
  assert.equal((await post("/api/rooms/room-open/snap", { login: "alice" }, "outsider")).d.ok, true);
});

test("snapshot on an Approved pad: members / staff only - asking, reading the frame and saving it", async () => {
  const no = await post("/api/rooms/room-locked/snap", { login: "alice" }, "outsider");
  assert.equal(no.status, 403);
  assert.equal(no.d.code, "pad_access");
  assert.equal((await post("/api/rooms/room-locked/snap", { login: "alice" }, "member")).d.ok, true);
  // Pepe answers; the frame is then readable by the member, never by the outsider
  const job = relay.takeJobs(new Set([LOCKED.id])).find((j) => j.kind === "snap");
  await post("/api/bridge/snap", { password: "bot-token", id: job.id, room: LOCKED.id, target: "alice", ok: true, status: "ok",
    data: JPEG.toString("base64"), save: "on", viewer_ok: true, cost: 0 }, null);
  const mine = await get("/api/rooms/room-locked/snap/alice", "member");
  assert.equal(mine.d.state, "ok");
  const theirs = await get("/api/rooms/room-locked/snap/alice", "outsider");
  assert.equal(theirs.status, 403, "an outsider can't read a member's frame");
  assert.equal(theirs.d.img, undefined);
  assert.equal((await get("/api/rooms/room-locked/snap/alice", "staff")).d.state, "ok", "site staff are inside");
  const sid = mine.d.save && mine.d.save.sid;
  assert.ok(sid);
  assert.equal((await post("/api/rooms/room-locked/snap/save", { sid }, "outsider")).status, 403);
});

test("cam clips on an Approved pad: request and every read follow the pad's rule", async () => {
  assert.equal((await post("/api/rooms/room-locked/camclip", { login: "alice", secs: 10 }, "outsider")).status, 403);
  const r = await post("/api/rooms/room-locked/camclip", { login: "alice", secs: 10 }, "member");
  assert.equal(r.d.ok, true, JSON.stringify(r.d));
  assert.equal((await get("/api/rooms/room-locked/camclip/" + r.d.id, "member")).d.ok, true);
  // the member is removed from the pad: their own clip can't be read any more
  await runQuery("UPDATE pad_members SET status = 'removed' WHERE room_id = ? AND user_id = 'member'", [LOCKED.id]);
  await PA.load();
  assert.equal((await get("/api/rooms/room-locked/camclip/" + r.d.id, "member")).status, 403);
  assert.equal((await get("/api/rooms/room-locked/camclip/" + r.d.id + "/video", "member")).status, 403);
  assert.equal((await get("/api/rooms/room-locked/camclip/" + r.d.id + "/poster", "member")).status, 403);
  assert.equal((await get("/api/rooms/room-locked/snap/alice", "member")).status, 403, "nor a snapshot");
});
