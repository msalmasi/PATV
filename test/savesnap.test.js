// Offline tests for the bridge popover's "Save snap" (bridge-relay.js, 1.99ap): only the account that
// asked for a snapshot may save it, only while it's fresh, only where Pepe's !snap rules allow it;
// the frame is handed to Pepe by id (bot token + account check), never taken from the browser.
//   node --test test/savesnap.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "savesnap-test-"));
process.chdir(tmp);                       // dbUtils opens ./myapp.db
process.env.SECRET_KEY = "test-secret";
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const relay = require(path.join(repo, "bridge-relay"));
require(path.join(repo, "actions"));      // creates pepe_actions

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3000, 7)]);
const R = { id: "Room.One", slug: "room-one", cams: true, members: [
  { login: "alice", on_cam: true }, { login: "bob", on_cam: true }, { login: "carl", on_cam: true }, { login: "dana", on_cam: true }] };

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  await new Promise((r) => setTimeout(r, 100));               // actions.js creates pepe_actions on load
  for (const [id, cf] of [["u1", "viewer1"], ["u2", "viewer2"], ["u3", null], ["u4", "viewer4"], ["u5", "viewer5"], ["u6", "viewer6"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, points_balance, camfrogUsername) VALUES (?, ?, ?, 'x', 0, ?)",
      [id, id + "_patv", id, cf]);
  }
  const app = express();
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u } : null; next(); };
  relay.register(app, { isBotToken: (t) => t === "bot-token", addUser, bySlug: (s) => (s === R.slug ? R : null), isLive: () => true });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server.close());

const H = (u, extra = {}) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u } : {}, extra);
async function post(p, body, u, headers) {
  const r = await fetch(base + p, { method: "POST", headers: headers || H(u), body: JSON.stringify(body) });
  return { status: r.status, d: await r.json() };
}
async function get(p, u) { const r = await fetch(base + p, { headers: H(u) }); return { status: r.status, d: await r.json() }; }
const snapOf = (login) => relay._snaps.get(R.id + "|" + login);

// Pepe answers a snapshot job the way pepe_relay._relay_snap does
async function pepeAnswers(login, extra) {
  const job = relay.takeJobs(new Set([R.id])).find((j) => j.kind === "snap" && j.target === login);
  assert.ok(job, "a snap job for " + login);
  const r = await post("/api/bridge/snap", Object.assign({ password: "bot-token", id: job.id, room: R.id, target: login, ok: true, status: "ok",
    data: JPEG.toString("base64") }, extra), null);
  assert.equal(r.status, 200);
  return job;
}

test("room admins-only: the requesting admin may save, the viewer riding on the frame may not", async () => {
  assert.equal((await post("/api/rooms/room-one/snap", { login: "alice" }, "u1")).d.ok, true);
  assert.equal((await post("/api/rooms/room-one/snap", { login: "alice" }, "u2")).d.pending, true);   // joins the same frame
  const job = await pepeAnswers("alice", { save: "admins", viewer_ok: true, cost: 0 });
  assert.equal(job.camfrog, "viewer1", "Pepe gets the requester's linked name to judge the rule");
  const s1 = (await get("/api/rooms/room-one/snap/alice", "u1")).d;
  assert.equal(s1.state, "ok");
  assert.ok(s1.save && s1.save.sid && s1.save.cost === 0, "u1 can save (free admin)");
  const s2 = (await get("/api/rooms/room-one/snap/alice", "u2")).d;
  assert.equal(s2.state, "ok");
  assert.equal(s2.save, null, "u2 sees the frame but no Save/Download");
  const r = await post("/api/rooms/room-one/snap/save", { sid: s1.save.sid }, "u2");
  assert.equal(r.status, 403);
});

test("only the account that asked can save, with a fresh frame, from the site's own fetch", async () => {
  const sid = snapOf("alice").sid;
  assert.equal((await post("/api/rooms/room-one/snap/save", { sid }, "u4")).status, 403, "never asked for it");
  assert.match((await post("/api/rooms/room-one/snap/save", { sid }, "u4")).d.error, /isn't a snapshot you asked for/);
  assert.equal((await post("/api/rooms/room-one/snap/save", { sid }, null)).status, 401, "signed out");
  assert.equal((await post("/api/rooms/room-one/snap/save", { sid: "fnope" }, "u1")).status, 410, "unknown frame");
  assert.equal((await post("/api/rooms/room-one/snap/save", { sid }, "u1", { "content-type": "application/json", "x-test-user": "u1" })).status, 400, "no X-Requested-With");
  // image bytes from the browser are ignored: only the sid is read
  const r = await post("/api/rooms/room-one/snap/save", { sid, data: "/9j/AAAA", img: "data:image/jpeg;base64,AAAA" }, "u1");
  assert.equal(r.status, 200);
  assert.ok(r.d.id);
  const a = (await getQuery("SELECT * FROM pepe_actions WHERE id = ?", [r.d.id]))[0];
  assert.equal(a.kind, "snap.save");
  assert.equal(a.camfrog, "viewer1");
  const args = JSON.parse(a.args);
  assert.deepEqual(args.slice(0, 2), [R.id, "alice"]);
  const fid = args[2];
  assert.ok(relay._frames.get(fid).img.equals(JPEG), "the frame Pepe captured is held under its own id");
  // a second click on the same frame doesn't queue (or charge) twice
  const again = await post("/api/rooms/room-one/snap/save", { sid }, "u1");
  assert.equal(again.d.id, r.d.id);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM pepe_actions WHERE kind = 'snap.save'"))[0].n, 1);
  // Pepe's frame fetch: bot token + the account the save was queued for
  assert.equal((await post("/api/bridge/snapframe", { password: "nope", id: fid, user: "u1_patv" })).status, 403);
  assert.equal((await post("/api/bridge/snapframe", { password: "bot-token", id: fid, user: "u2_patv" })).status, 404);
  assert.equal((await post("/api/bridge/snapframe", { password: "bot-token", id: fid })).status, 404);
  const f = await post("/api/bridge/snapframe", { password: "bot-token", id: fid, user: "u1_patv" });
  assert.equal(f.status, 200);
  assert.ok(Buffer.from(f.d.data, "base64").equals(JPEG));
  assert.equal(f.d.target, "alice");
  // the result: link to the feed item
  await runQuery("UPDATE pepe_actions SET status = 'done', message = ? WHERE id = ?",
    ["saved to the feed: https://publicaccess.tv/media/abcd1234abcd1234 (expires in 24h)", r.d.id]);
  const st = (await get("/api/rooms/room-one/snap/save/" + r.d.id, "u1")).d;
  assert.equal(st.url, "/media/abcd1234abcd1234");
  assert.equal((await get("/api/rooms/room-one/snap/save/" + r.d.id, "u2")).status, 404, "someone else's save");
  // a frame Pepe never picked up goes away
  relay._frames.get(fid).ts -= 6 * 60 * 1000;
  assert.equal((await post("/api/bridge/snapframe", { password: "bot-token", id: fid, user: "u1_patv" })).status, 404);
});

test("expired snapshot can't be saved", async () => {
  const s = snapOf("alice");
  s.ts -= 2 * 60 * 1000 + 1;
  s.saves.clear();
  const r = await post("/api/rooms/room-one/snap/save", { sid: s.sid }, "u1");
  assert.equal(r.status, 410);
  relay._snaps.delete(R.id + "|alice");
});

test("rule on: every viewer of the frame may save at the price; unlinked viewers get nothing; rate limited", async () => {
  await post("/api/rooms/room-one/snap", { login: "bob" }, "u2");
  await pepeAnswers("bob", { save: "on", viewer_ok: true, cost: 25000 });
  assert.equal((await post("/api/rooms/room-one/snap", { login: "bob" }, "u4")).d.cached, true);
  assert.equal((await post("/api/rooms/room-one/snap", { login: "bob" }, "u3")).d.cached, true);
  const s4 = (await get("/api/rooms/room-one/snap/bob", "u4")).d;
  assert.equal(s4.save.cost, 25000, "a cached viewer may save where everyone may !snap");
  assert.equal((await get("/api/rooms/room-one/snap/bob", "u3")).d.save, null, "unlinked: no Save/Download");
  assert.equal((await post("/api/rooms/room-one/snap/save", { sid: s4.save.sid }, "u3")).status, 403, "unlinked refused");
  assert.equal((await post("/api/rooms/room-one/snap/save", { sid: s4.save.sid }, "u2")).status, 200);
  // u2 just saved bob: another save within 20 s is rate limited
  await post("/api/rooms/room-one/snap", { login: "carl" }, "u5");
  await pepeAnswers("carl", { save: "on", viewer_ok: true, cost: 25000 });
  assert.equal((await post("/api/rooms/room-one/snap", { login: "carl" }, "u2")).d.cached, true);
  const r = await post("/api/rooms/room-one/snap/save", { sid: snapOf("carl").sid }, "u2");
  assert.equal(r.status, 429);
  assert.match(r.d.error, /slow down/);
});

test("opted out (rule no) and older Pepes (no rule): nobody gets Save/Download", async () => {
  await post("/api/rooms/room-one/snap", { login: "dana" }, "u4");
  await pepeAnswers("dana", { save: "no", viewer_ok: false, cost: 0 });
  assert.equal((await get("/api/rooms/room-one/snap/dana", "u4")).d.save, null);
  assert.equal((await post("/api/rooms/room-one/snap/save", { sid: snapOf("dana").sid }, "u4")).status, 403);
  relay._snaps.delete(R.id + "|dana");
  await post("/api/rooms/room-one/snap", { login: "dana" }, "u6");
  await pepeAnswers("dana", {});
  assert.equal((await get("/api/rooms/room-one/snap/dana", "u6")).d.save, null);
});
