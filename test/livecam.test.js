// Offline tests for 📡 live cams (livecam.js, 1.99yh): who may watch (signed in + padaccess.full, on cam, not opted out),
// the per-viewer caps (1 / 4 with a Season Pass), the bandwidth budget and max live cams, Pepe's poll (wanted cams,
// opt-outs typed in Camfrog, his refusals ending a session), the MediaMTX hook (publish bearer, read ticket + a held slot
// + the pad rule), beats / ✕ freeing a slot, ending by the owner / a mod / staff (+ cooldown), the audit rows.
//   node --test test/livecam.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "livecam-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
delete process.env.STAGING;
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const LC = require(path.join(repo, "livecam"));
const PA = require(path.join(repo, "padaccess"));
const W = require(path.join(repo, "webrtc"));
const B = require(path.join(repo, "bridge"));
const premium = require(path.join(repo, "premium"));

W.enabled = () => true;
premium.hasPass = (id) => id === "sp";
let T = 1_000_000_000_000;
LC._setClock(() => T);
const kicked = [];
LC._setKick((id) => kicked.push(id));

const R = { id: "Room.One", slug: "room-one", cams: true, livecams: true, members: [
  { login: "alice", display: "Alice W", on_cam: true }, { login: "bob", on_cam: true }, { login: "carl", on_cam: false },
  { login: "dana", on_cam: true }, { login: "erin", on_cam: true }, { login: "fay", on_cam: true }, { anon: true, display: "someone", on_cam: true }] };
const LOCKED = { id: "Room.Locked", slug: "room-locked", cams: true, livecams: true, members: [{ login: "alice", on_cam: true }] };
const bySlug = (s) => (s === R.slug ? R : s === LOCKED.slug ? LOCKED : null);

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  for (const [id, cf, cls] of [["v1", "viewer1", "pleb"], ["v2", "viewer2", "pleb"], ["sp", "spfan", "pleb"], ["owner", "alice", "pleb"],
                               ["mod", "modguy", "pleb"], ["staff", "boss", "Admin"], ["v3", null, "pleb"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, 'x', ?, ?)",
      [id, id + "_patv", id, cls, cf]);
  }
  await PA.init();
  await runQuery("INSERT INTO pad_access (room_id, level) VALUES (?, 'approved')", [LOCKED.id]);
  await PA.load();
  await LC.init();
  await LC.save({ class: "Admin", userId: "staff", username: "boss" }, { cfg: { enabled: true } });
  B._rooms.set(R.id, R);
  B._rooms.set(LOCKED.id, LOCKED);
  R.mod = { modguy: { kick: true } };
  const app = express();
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use(express.json());
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u, class: u === "staff" ? "Admin" : "pleb", username: u } : null; next(); };
  LC.register(app, { addUser, isBotToken: (t) => t === "bot", bySlug, isLive: () => true });
  require(path.join(repo, "incognito")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server.close());

const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u } : {});
async function post(p, body, u) {
  const r = await fetch(base + p, { method: "POST", headers: H(u), body: JSON.stringify(body || {}) });
  return { status: r.status, d: await r.json().catch(() => ({})) };
}
const bot = (extra) => post("/api/bridge/livecam", Object.assign({ password: "bot", cap: true }, extra || {}), null);
const watch = (login, u, slug = "room-one") => post(`/api/rooms/${slug}/livecam`, { login }, u);
const ticketOf = (whep) => new URL(whep).searchParams.get("pt");
const pathOf = (whep) => new URL(whep).pathname.split("/").pop();

test("nothing without Pepe, sign-in, the kill switch, or the room's switch", async () => {
  assert.equal((await watch("alice", null)).status, 401);
  assert.equal((await watch("alice", "v1")).d.code, "nopepe", "Pepe hasn't polled yet");
  await bot();
  R.livecams = false;
  assert.equal((await watch("alice", "v1")).d.code, "room_off");
  R.livecams = true;
  await LC.save({ class: "Admin", userId: "staff", username: "boss" }, { cfg: { enabled: false } });
  assert.equal((await watch("alice", "v1")).d.code, "off");
  await LC.save({ class: "Admin", userId: "staff", username: "boss" }, { cfg: { enabled: true } });
  assert.equal((await watch("carl", "v1")).d.code, "not_on_cam", "off cam");
  assert.equal((await watch("someone", "v1")).d.code, "not_on_cam", "an anonymous (private) person has no login");
  assert.equal((await watch("alice", "v1", "room-locked")).d.code, "pad_access", "an Approved pad: outsiders refused");
});

test("a viewer starts a cam: Pepe is asked to publish it; MediaMTX lets only a slot holder read it", async () => {
  await bot();
  const r = await watch("alice", "v1");
  assert.equal(r.d.ok, true, JSON.stringify(r.d));
  assert.deepEqual(r.d.slots, { used: 1, max: 1 });
  const p = pathOf(r.d.whep);
  assert.match(p, /^room-[0-9a-f]{16}$/);
  const a = await bot();
  const w = a.d.want.find((x) => x.login === "alice");
  assert.ok(w && w.room === R.id && w.path === p && /\/whip\//.test(w.url), "Pepe gets the WHIP url + path");
  // publish: only with the path's bearer, only WHIP
  assert.equal(await LC.auth({ path: p, token: w.token }, "publish", "webrtc"), 200);
  assert.equal(await LC.auth({ path: p, token: "nope" }, "publish", "webrtc"), 403);
  assert.equal(await LC.auth({ path: p, token: w.token }, "publish", "rtmp"), 403);
  // read: the ticket + a slot; never HLS
  const q = "pt=" + encodeURIComponent(ticketOf(r.d.whep));
  assert.equal(await LC.auth({ path: p, query: q, id: "11111111-1111-1111-1111-111111111111" }, "read", "webrtc"), 200);
  assert.equal(await LC.auth({ path: p, query: q }, "read", "hls"), 403, "no HLS of a cam");
  assert.equal(await LC.auth({ path: p, query: "" }, "read", "webrtc"), 401, "no ticket");
  const other = LC.readTicket("v2", p);
  assert.equal(await LC.auth({ path: p, query: "pt=" + encodeURIComponent(other) }, "read", "webrtc"), 403, "a good ticket but no slot");
  // the webrtc.js hook routes the cam path to livecam, not to room audio
  assert.equal(await W.whipAuth({ path: p, token: w.token, action: "publish", protocol: "webrtc" }), 200);
});

test("caps: 1 live cam without a Season Pass, 4 with; the same cam again is free; ✕ frees the slot at once", async () => {
  await bot();
  assert.equal((await watch("alice", "v1")).d.ok, true, "re-asking for the same cam keeps the slot");
  const r = await watch("bob", "v1");
  assert.equal(r.status, 429);
  assert.equal(r.d.code, "viewer_cap");
  assert.deepEqual(r.d.slots, { used: 1, max: 1 });
  assert.equal((await post("/api/rooms/room-one/livecam/stop", { login: "alice" }, "v1")).d.ok, true);
  assert.equal((await watch("bob", "v1")).d.ok, true, "slot freed by ✕");
  for (const c of ["alice", "bob", "dana", "erin"]) assert.equal((await watch(c, "sp")).d.ok, true, "Season Pass: " + c);
  assert.equal((await watch("fay", "sp")).d.code, "viewer_cap", "the 5th");
  for (const c of ["alice", "bob", "dana", "erin"]) await post("/api/rooms/room-one/livecam/stop", { login: c }, "sp");
  await post("/api/rooms/room-one/livecam/stop", { login: "bob" }, "v1");
});

test("max live cams and the bandwidth budget", async () => {
  T += 5 * 60 * 1000; LC.sweep();
  await bot();                          // everything from before has ended
  await LC.save({ class: "Admin", userId: "staff", username: "boss" }, { cfg: { max_live: 1 } });
  assert.equal((await watch("alice", "v1")).d.ok, true);
  assert.equal((await watch("bob", "v2")).d.code, "slots_busy", "a second cam while max_live is 1");
  assert.equal((await watch("alice", "v2")).d.ok, true, "another viewer of the SAME cam is fine");
  await LC.save({ class: "Admin", userId: "staff", username: "boss" }, { cfg: { max_live: 4, budget_mbps: 1, kbps: 500 } });
  assert.equal(LC.viewerCap(), 2);
  assert.equal((await watch("bob", "sp")).d.code, "budget", "2 viewers x 500 kbps = the 1 Mbps budget");
  // 1.99aab: a pass-through relay counts at the bitrate Pepe measures, not cfg.kbps - alice's cam at 40 kbit/s frees room
  await bot({ live: [{ room: R.id, login: "alice", state: "live", source: "passthrough", kbps: 40 }] });
  assert.equal((await watch("alice", "sp")).d.ok, true, "3 x 40 kbps fits the 1 Mbps budget");
  const av = await LC.adminView();
  const sa = av.sessions.find((x) => x.login === "alice");
  assert.equal(sa.kbps, 40);
  assert.equal(sa.measured, true);
  assert.equal(sa.outKbps, 120);
  assert.equal(av.usage.mbps, 0.1);
  assert.equal((await watch("bob", "sp")).d.ok, true, "a new cam Pepe hasn't measured counts at cfg.kbps: 120 + 500 fits");
  assert.equal((await watch("dana", "sp")).d.code, "budget", "620 + 500 doesn't");
  for (const c of ["alice", "bob"]) await post("/api/rooms/room-one/livecam/stop", { login: c }, "sp");
  await LC.save({ class: "Admin", userId: "staff", username: "boss" }, { cfg: { budget_mbps: 100, kbps: 300 } });
  await post("/api/rooms/room-one/livecam/stop", { login: "alice" }, "v1");
  await post("/api/rooms/room-one/livecam/stop", { login: "alice" }, "v2");
});

test("opt-out: the website switch ends a relay at once and refuses new viewers; Pepe's !livecam writes through", async () => {
  T += 5 * 60 * 1000; LC.sweep();
  await bot();
  const r = await watch("alice", "v1");
  assert.equal(r.d.ok, true);
  const p = pathOf(r.d.whep);
  // the owner (linked login alice) switches it off in Settings → Privacy
  const off = await post("/api/privacy/livecam", { off: true }, "owner");
  assert.equal(off.d.ok, true);
  assert.equal(off.d.off, true);
  assert.equal(LC._sessions.get(R.id + "|alice").ended > 0, true, "the session ended");
  assert.equal(await LC.auth({ path: p, query: "pt=" + encodeURIComponent(ticketOf(r.d.whep)) }, "read", "webrtc"), 403);
  const a = await bot();
  assert.ok(!a.d.want.some((x) => x.login === "alice"), "Pepe stops publishing it");
  assert.ok(a.d.optout.includes("alice"), "...and learns the opt-out");
  assert.equal((await watch("alice", "v1")).d.code, "opted_out");
  // !livecam on typed in Camfrog: comes in with Pepe's poll
  await bot({ optout_events: [{ login: "alice", off: false, ts: T + 1 }] });
  assert.equal(LC.optedOut("alice"), false);
  assert.equal((await post("/api/privacy/livecam", { off: true }, "v3")).status, 409, "no linked login: nothing to switch");
  assert.equal((await post("/api/privacy/livecam", { off: true }, null)).status, 401);
});

test("Pepe's refusals and reports end the session with a reason the page shows", async () => {
  T += 5 * 60 * 1000; LC.sweep();
  await bot();
  assert.equal((await watch("bob", "v1")).d.ok, true);
  await bot({ refused: [{ room: R.id, login: "bob", why: "slots_busy" }] });
  const b = await post("/api/rooms/room-one/livecam/beat", { login: "bob" }, "v1");
  assert.equal(b.d.state, "ended");
  assert.equal(b.d.why, "slots_busy");
  T += 5 * 60 * 1000; LC.sweep();
  await bot();
  assert.equal((await watch("bob", "v1")).d.ok, true);
  await bot({ live: [{ room: R.id, login: "bob", state: "live" }] });
  await bot({ live: [{ room: R.id, login: "bob", state: "ended", why: "cam_closed" }] });
  assert.equal((await post("/api/rooms/room-one/livecam/beat", { login: "bob" }, "v1")).d.why, "cam_closed");
});

test("beats keep a slot; a page that stops beating loses it; an unwatched cam lingers then ends", async () => {
  T += 5 * 60 * 1000; LC.sweep();
  await bot();
  assert.equal((await watch("dana", "v1")).d.ok, true);
  T += 30 * 1000;
  assert.equal((await post("/api/rooms/room-one/livecam/beat", { login: "dana" }, "v1")).d.state, "connecting");
  await bot();
  T += 50 * 1000; await bot(); LC.sweep();
  const S = LC._sessions.get(R.id + "|dana");
  assert.equal(S.viewers.size, 0, "no beat for 50 s: the slot is gone");
  T += 25 * 1000; LC.sweep();
  assert.ok(S.ended, "and after the linger the cam ends");
  const rows = await getQuery("SELECT * FROM livecam_audit WHERE target = 'dana' ORDER BY id DESC");
  assert.equal(rows[0].end_reason, "gone");
  assert.ok(rows[0].secs >= 70 && rows[0].viewer_id === "v1", "audited: viewer, target, seconds");
});

test("ending a relay: the owner, a room mod, staff - nobody else; then a cooldown", async () => {
  T += 5 * 60 * 1000; LC.sweep();
  await bot();
  assert.equal((await watch("erin", "v1")).d.ok, true);
  assert.equal((await post("/api/rooms/room-one/livecam/end", { login: "erin" }, "v2")).status, 403, "a random viewer can't");
  assert.equal((await post("/api/rooms/room-one/livecam/end", { login: "erin" }, "mod")).d.ok, true, "a room mod can");
  assert.equal((await post("/api/rooms/room-one/livecam/beat", { login: "erin" }, "v1")).d.why, "ended_by");
  assert.equal((await watch("erin", "v1")).d.code, "ended_by", "cooldown");
  assert.equal((await post("/api/rooms/room-one/livecam/end", { login: "alice" }, "owner")).d.ok, true, "the cam's owner can");
  assert.equal((await post("/api/rooms/room-one/livecam/end", { login: "fay" }, "staff")).d.ok, true, "staff can");
});

test("padaccess: a member removed from an Approved pad loses the read at once", async () => {
  T += 20 * 60 * 1000; LC.sweep();
  await bot();
  await runQuery("INSERT INTO pad_members (room_id, user_id, status) VALUES (?, 'v2', 'approved')", [LOCKED.id]);
  await PA.load();
  const r = await watch("alice", "v2", "room-locked");
  assert.equal(r.d.ok, true, JSON.stringify(r.d));
  const p = pathOf(r.d.whep), q = "pt=" + encodeURIComponent(ticketOf(r.d.whep));
  assert.equal(await LC.auth({ path: p, query: q }, "read", "webrtc"), 200);
  await runQuery("UPDATE pad_members SET status = 'removed' WHERE room_id = ? AND user_id = 'v2'", [LOCKED.id]);
  await PA.load();
  assert.equal(await LC.auth({ path: p, query: q }, "read", "webrtc"), 403);
  assert.equal((await post("/api/rooms/room-locked/livecam/beat", { login: "alice" }, "v2")).status, 403);
});

test("the pad's live view hint and the admin view", async () => {
  await bot();
  const h = LC.hint(R, "sp");
  assert.equal(h.on, true);
  assert.equal(h.slots.max, 4);
  assert.equal(LC.hint(R, null).signin, true);
  assert.equal(LC.hint({ ...R, livecams: false }, "v1"), null);
  const v = await LC.adminView();
  assert.equal(v.usage.budget_mbps, 100);
  assert.ok(Array.isArray(v.sessions) && Array.isArray(v.recent));
  await assert.rejects(LC.save({ class: "pleb" }, { cfg: { fps: 10 } }), /Admins only/);
  await assert.rejects(LC.save({ class: "Admin", userId: "staff" }, { cfg: { fps: 99 } }), /fps/);
  // 1.99yr: the video source - prod default reencode, sent to Pepe with its fallback time; junk refused
  assert.equal((await bot()).d.cfg.source, "reencode");
  await LC.save({ class: "Admin", userId: "staff", username: "boss" }, { cfg: { source: "passthrough", pt_fallback_s: 8 } });
  const b = (await bot()).d.cfg;
  assert.equal(b.source, "passthrough");
  assert.equal(b.pt_fallback_s, 8);
  await assert.rejects(LC.save({ class: "Admin", userId: "staff" }, { cfg: { source: "magic" } }), /source/);
  await LC.save({ class: "Admin", userId: "staff", username: "boss" }, { cfg: { source: "reencode", pt_fallback_s: 6 } });
});

test("the pages: /admin/pepe/livecams for admins only; the 📡 card on /settings/privacy", async () => {
  const page = await fetch(base + "/admin/pepe/livecams", { headers: { "x-test-user": "staff" } });
  const html = await page.text();
  assert.equal(page.status, 200, html.slice(0, 300));
  assert.match(html, /id="settings"/);
  assert.match(html, /Bandwidth budget/);
  assert.equal((await fetch(base + "/admin/pepe/livecams", { headers: { "x-test-user": "v1" } })).status, 403);
  const pv = await fetch(base + "/settings/privacy", { headers: { "x-test-user": "owner" } });
  const ph = await pv.text();
  assert.equal(pv.status, 200, ph.slice(0, 300));
  assert.match(ph, /id="livecam"/);
  assert.match(ph, /id="pvLc"/);
});
