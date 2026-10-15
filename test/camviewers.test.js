// Offline tests for 👁 who's watching your cam (camviewers.js, 1.99yq): the owner's blocks (Pepe's !blockviewer + the
// privacy card) refuse live / snapshot / clip neutrally and end a live stream at once; the owner's switch (!livecam off)
// and "private" now cover snapshots and clips too; every view is noted and Pepe gets "X opened your cam" notices on his
// live-cam poll - live always (re-opens within 2 min are the same open), snapshots / clips once per viewer per 30 min,
// one PM per owner per minute (a digest), acked / re-offered / expired; !whowatching's live + recent lists.
//   node --test test/camviewers.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "camviewers-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
delete process.env.STAGING;
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const LC = require(path.join(repo, "livecam"));
const CV = require(path.join(repo, "camviewers"));
const relay = require(path.join(repo, "bridge-relay"));
const camclip = require(path.join(repo, "camclip"));
const PA = require(path.join(repo, "padaccess"));
const W = require(path.join(repo, "webrtc"));
const B = require(path.join(repo, "bridge"));
require(path.join(repo, "actions"));

W.enabled = () => true;
let T = 1_000_000_000_000;
LC._setClock(() => T);
CV._setClock(() => T);
const kicked = [];
LC._setKick((id) => kicked.push(id));
const PRIVATE = new Set();
// 1.99aav: these tests are about notices / blocks, not who may watch (camaccess.test.js) - every cam is set to "everyone"
CV._setDeps({ privateLogins: async (list) => new Set(list.filter((l) => PRIVATE.has(l))), gate: async () => null });

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
const R = { id: "Room.One", slug: "room-one", cams: true, livecams: true, members: [
  { login: "alice", display: "Alice W", on_cam: true }, { login: "bob", on_cam: true }, { login: "gina", on_cam: true }] };
const bySlug = (s) => (s === R.slug ? R : null);

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  for (const [id, name, disp, cf] of [["v1", "creep", "Creepy Carl", "carl99"], ["v2", "nice", "nice", "nicecf"], ["v3", "lurk", "Lurky", null],
                                      ["owner", "alicepatv", "Alice", "alice"], ["gowner", "ginapatv", "Gina", "gina"], ["staff", "boss", "Boss", "boss1"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, 'x', ?, ?)",
      [id, name, disp, id === "staff" ? "Admin" : "pleb", cf]);
  }
  await PA.init();
  await PA.load();
  await LC.init();
  await LC.save({ class: "Admin", userId: "staff", username: "boss" }, { cfg: { enabled: true, viewers_free: 4 } });
  await CV.init();
  B._rooms.set(R.id, R);
  camclip._setDeps({ snapSwitch: () => true, clipSwitch: () => true, privateLogins: async () => new Set(), modCaps: () => null });
  camclip._setDir(path.join(tmp, "clips"));
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u, username: u, class: u === "staff" ? "Admin" : "pleb" } : null; next(); };
  const opts = { addUser, isBotToken: (t) => t === "bot", bySlug, isLive: () => true };
  LC.register(app, opts);
  CV.register(app, opts);
  relay.register(app, opts);
  camclip.register(app, opts);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server.close());

const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u } : {});
async function post(p, body, u) {
  const r = await fetch(base + p, { method: "POST", headers: H(u), body: JSON.stringify(body || {}) });
  return { status: r.status, d: await r.json().catch(() => ({})) };
}
async function get(p, u) { const r = await fetch(base + p, { headers: H(u) }); return { status: r.status, d: await r.json().catch(() => ({})) }; }
const bot = (extra) => post("/api/bridge/livecam", Object.assign({ password: "bot", cap: true, cv: true }, extra || {}), null);
const watch = (login, u) => post(`/api/rooms/${R.slug}/livecam`, { login }, u);
const cvBot = (op, owner, target) => post("/api/bridge/camviewers", { password: "bot", op, owner, target }, null);
const ackAll = async () => { const a = await bot(); await bot({ cv_ack: a.d.cv_notify.map((n) => n.id) }); return a.d.cv_notify; };
async function snapFrame(login, u) {
  relay._hits.clear();                                     // the per-viewer snapshot rate limit runs on the real clock
  const r = await post(`/api/rooms/${R.slug}/snap`, { login }, u);
  const job = relay.takeJobs(new Set([R.id])).find((j) => j.kind === "snap" && j.target === login);
  if (job) await post("/api/bridge/snap", { password: "bot", id: job.id, room: R.id, target: login, ok: true, status: "ok", data: JPEG.toString("base64") }, null);
  await new Promise((r2) => setTimeout(r2, 50));          // noteViewers' user lookup
  return r;
}

const readLive = async (r) => {          // the viewer's player reaches MediaMTX (the read hook) - only then is the owner told
  const u = new URL(r.d.whep);
  const st = await LC.auth({ path: u.pathname.split("/").pop(), query: "pt=" + encodeURIComponent(u.searchParams.get("pt")) }, "read", "webrtc");
  await new Promise((r2) => setTimeout(r2, 50));
  return st;
};

test("a live open: Pepe gets a notice naming the viewer (PATV name, display, Camfrog login) once he says cv: true", async () => {
  await bot();
  const first = await watch("alice", "v1");
  assert.equal(first.d.ok, true);
  assert.equal((await bot()).d.cv_notify.length, 0, "asking isn't watching: nothing until the video is read");
  assert.equal(await readLive(first), 200);
  assert.equal(await readLive(first), 200, "a second read (reconnect) of the same slot");
  const old = await post("/api/bridge/livecam", { password: "bot", cap: true }, null);
  assert.deepEqual(old.d.cv_notify, [], "an older Pepe (no cv: true) gets none");
  const a = await bot();
  assert.equal(a.d.cv_notify.length, 1);
  const n = a.d.cv_notify[0];
  assert.equal(n.login, "alice");
  assert.equal(n.room, R.id);
  assert.deepEqual(n.viewers, [{ username: "creep", display: "Creepy Carl", camfrog: "carl99", kinds: ["live"] }]);
  // not acked: offered again after RESEND_MS, never twice in one go
  assert.equal((await bot()).d.cv_notify.length, 0);
  T += CV.RESEND_MS + 1;
  assert.equal((await bot()).d.cv_notify[0].id, n.id, "re-offered");
  await bot({ cv_ack: [n.id] });
  T += CV.RESEND_MS + 1;
  assert.equal((await bot()).d.cv_notify.length, 0, "acked = gone");
  // re-opening within LIVE_GAP is the same open
  await post(`/api/rooms/${R.slug}/livecam/stop`, { login: "alice" }, "v1");
  const again = await watch("alice", "v1");
  assert.equal(again.d.ok, true);
  await readLive(again);
  T += CV.OWNER_GAP_MS + 1;
  assert.equal((await bot()).d.cv_notify.length, 0, "a reconnect isn't a new notice");
  await post(`/api/rooms/${R.slug}/livecam/stop`, { login: "alice" }, "v1");
});

test("snapshots: once per viewer per 30 min; one PM per owner per minute - the rest is ONE digest", async () => {
  T += 31 * 60 * 1000; LC.sweep();
  await bot();
  await ackAll();
  await snapFrame("bob", "v1");
  let a = await bot();
  assert.equal(a.d.cv_notify.length, 1);
  assert.deepEqual(a.d.cv_notify[0].viewers.map((v) => [v.username, v.kinds]), [["creep", ["snap"]]]);
  await bot({ cv_ack: a.d.cv_notify.map((n) => n.id) });
  // the same viewer again soon: nothing; two others within the owner gap: held, then one digest
  T += 25 * 1000;
  relay._snaps.clear();
  await snapFrame("bob", "v1");
  relay._snaps.clear();
  await snapFrame("bob", "v2");
  relay._snaps.clear();
  await snapFrame("bob", "v3");
  assert.equal((await bot()).d.cv_notify.length, 0, "held: Bob got a PM less than a minute ago");
  T += 40 * 1000;
  a = await bot();
  assert.equal(a.d.cv_notify.length, 1, "one digest");
  assert.deepEqual(a.d.cv_notify[0].viewers.map((v) => v.username).sort(), ["lurk", "nice"]);
  assert.equal(a.d.cv_notify[0].more, 0);
  await bot({ cv_ack: a.d.cv_notify.map((n) => n.id) });
  // a viewer riding on a fresh frame someone else asked for counts too
  T += 31 * 60 * 1000;
  await snapFrame("bob", "v1");
  await post(`/api/rooms/${R.slug}/snap`, { login: "bob" }, "v2");
  T += CV.OWNER_GAP_MS + 1;
  a = await bot();
  assert.deepEqual(a.d.cv_notify.flatMap((n) => n.viewers.map((v) => v.username)).sort(), ["creep", "nice"]);
  await bot({ cv_ack: a.d.cv_notify.map((n) => n.id) });
  // a notice Pepe never takes expires
  T += 31 * 60 * 1000;
  relay._snaps.clear();
  await snapFrame("bob", "v3");
  T += CV.NOTE_TTL_MS + 1;
  assert.equal((await bot()).d.cv_notify.length, 0, "expired");
});

test("!whowatching: live viewers now + snapshots / clips in the last 30 min", async () => {
  T += 31 * 60 * 1000; LC.sweep();
  await bot();
  relay._snaps.clear();
  const lv = await watch("gina", "v1");
  assert.equal(lv.d.ok, true);
  await readLive(lv);
  await snapFrame("gina", "v2");
  const w = await cvBot("watching", "gina");
  assert.equal(w.d.ok, true);
  assert.deepEqual(w.d.live.map((x) => [x.username, x.camfrog, x.room]), [["creep", "carl99", R.id]]);
  assert.deepEqual(w.d.recent.map((x) => [x.username, x.kinds]), [["nice", ["snap"]]]);
  const mine = await get("/api/privacy/camviewers", "gowner");
  assert.equal(mine.d.linked, true);
  assert.equal(mine.d.login, "gina");
  assert.equal(mine.d.live[0].username, "creep");
  assert.equal((await get("/api/privacy/camviewers", "v3")).d.linked, false, "no linked Camfrog name");
  T += 31 * 60 * 1000;
  LC.sweep();
  await bot();
  assert.equal((await cvBot("watching", "gina")).d.recent.length, 0, "older than 30 min");
});

test("!blockviewer: ends their live stream at once, refuses live / snapshot / clip neutrally; !unblockviewer lifts it", async () => {
  T += 5 * 60 * 1000; LC.sweep();
  await bot();
  relay._snaps.clear();
  const r = await watch("gina", "v1");
  assert.equal(r.d.ok, true);
  const p = new URL(r.d.whep).pathname.split("/").pop(), q = "pt=" + encodeURIComponent(new URL(r.d.whep).searchParams.get("pt"));
  assert.equal(await LC.auth({ path: p, query: q, id: "22222222-2222-2222-2222-222222222222" }, "read", "webrtc"), 200);
  kicked.length = 0;
  const b = await cvBot("block", "gina", "carl99");          // by their Camfrog login
  assert.equal(b.d.ok, true, JSON.stringify(b.d));
  assert.equal(b.d.user.username, "creep");
  assert.equal(b.d.ended, 1, "their live stream ended");
  assert.ok(kicked.includes("22222222-2222-2222-2222-222222222222"), "the MediaMTX reader was kicked");
  assert.equal(await LC.auth({ path: p, query: q }, "read", "webrtc"), 403);
  const again = await watch("gina", "v1");
  assert.equal(again.d.code, "unavailable");
  assert.equal(again.d.error, CV.UNAVAILABLE);
  assert.doesNotMatch(again.d.error, /block/i, "never says 'blocked'");
  const s = await post(`/api/rooms/${R.slug}/snap`, { login: "gina" }, "v1");
  assert.equal(s.status, 403);
  assert.equal(s.d.error, CV.UNAVAILABLE);
  const c = await post(`/api/rooms/${R.slug}/camclip`, { login: "gina", secs: 10 }, "v1");
  assert.equal(c.status, 403);
  assert.equal(c.d.error, CV.UNAVAILABLE);
  // a frame someone else took is refused to them too
  await snapFrame("gina", "v2");
  assert.equal((await get(`/api/rooms/${R.slug}/snap/gina`, "v2")).d.state, "ok");
  assert.equal((await get(`/api/rooms/${R.slug}/snap/gina`, "v1")).d.state, "refused");
  assert.equal(relay.snapForGen(R.id, relay._snaps.get(R.id + "|gina").sid, "v1").status, 403);
  // others are unaffected; the list; unblock
  assert.equal((await watch("gina", "v2")).d.ok, true);
  assert.deepEqual((await cvBot("list", "gina")).d.blocks.map((x) => x.username), ["creep"]);
  assert.equal((await cvBot("block", "gina", "creep")).d.already, true, "by PATV name: already blocked");
  assert.equal((await cvBot("block", "gina", "nobodyhere")).d.ok, false);
  assert.equal((await cvBot("block", "gina", "ginapatv")).d.error, "That's you.");
  assert.equal((await cvBot("unblock", "gina", "creep")).d.was, true);
  assert.equal((await watch("gina", "v1")).d.ok, true, "unblocked");
  const rows = await getQuery("SELECT * FROM cam_blocks");
  assert.equal(rows.length, 0);
});

test("the privacy card: block / unblock from the website (the owner's linked login), checks", async () => {
  const add = await post("/api/privacy/camviewers", { op: "block", target: "lurk" }, "gowner");
  assert.equal(add.d.ok, true, JSON.stringify(add.d));
  assert.deepEqual(add.d.blocks.map((x) => x.username), ["lurk"]);
  assert.equal(CV.blocked("gina", "v3"), true);
  assert.equal((await post("/api/privacy/camviewers", { op: "block", target: "lurk" }, "v3")).status, 409, "no linked login");
  assert.equal((await post("/api/privacy/camviewers", { op: "block", target: "ginapatv" }, "gowner")).status, 400, "not yourself");
  const nofetch = await fetch(base + "/api/privacy/camviewers", { method: "POST", headers: { "content-type": "application/json", "x-test-user": "gowner" },
    body: JSON.stringify({ op: "unblock", target: "lurk" }) });
  assert.equal(nofetch.status, 403, "JSON + X-Requested-With only");
  const del = await post("/api/privacy/camviewers", { op: "unblock", target: "lurk" }, "gowner");
  assert.equal(del.d.ok, true);
  assert.equal(CV.blocked("gina", "v3"), false);
  assert.equal((await post("/api/bridge/camviewers", { password: "nope", op: "list", owner: "gina" }, null)).status, 403);
});

test("the owner's switch and 'private' cover snapshots and clips, not just live", async () => {
  T += 5 * 60 * 1000; LC.sweep();
  await bot();
  relay._snaps.clear();
  await LC.setOptout("bob", true, { via: "chat", ts: T });
  relay._hits.clear();
  for (const r of [await watch("bob", "v2"), await post(`/api/rooms/${R.slug}/snap`, { login: "bob" }, "v2"),
                   await post(`/api/rooms/${R.slug}/camclip`, { login: "bob", secs: 10 }, "v2")]) {
    assert.equal(r.status, 403);
    assert.match(r.d.error, /switched/);
  }
  await LC.setOptout("bob", false, { via: "chat", ts: T + 1 });
  PRIVATE.add("bob");
  const s = await post(`/api/rooms/${R.slug}/snap`, { login: "bob" }, "v2");
  assert.equal(s.status, 403);
  assert.equal(s.d.code, "private");
  PRIVATE.delete("bob");
  relay._hits.clear();
  assert.equal((await post(`/api/rooms/${R.slug}/snap`, { login: "bob" }, "v2")).d.ok, true);
});

test("the pages: the 👁 card on /settings/privacy; block counts on the admin page", async () => {
  const app = express();
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  const addUser = (req, res, next) => { req.user = { userId: "gowner", username: "ginapatv" }; next(); };
  require(path.join(repo, "incognito")).register(app, { addUser, isBotToken: () => false });
  const srv = app.listen(0);
  try {
    const r = await fetch("http://127.0.0.1:" + srv.address().port + "/settings/privacy");
    const html = await r.text();
    assert.equal(r.status, 200, html.slice(0, 300));
    assert.match(html, /id="camviewers"/);
    assert.match(html, /id="pvCvForm"/);
    assert.match(html, /privacy-camviewers\.js/);
  } finally { srv.close(); }
  await CV.block("gina", "lurk");
  const v = await LC.adminView();
  assert.deepEqual([v.camviewers.blocks, v.camviewers.owners], [1, 1]);
});
