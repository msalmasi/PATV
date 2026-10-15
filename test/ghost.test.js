// Offline tests for 👻 staff ghost mode (ghost.js, 1.99aaf): only Admin / Staff can switch it on (web + Pepe's !ghost); a
// ghost's live / snapshot views send the cam owner no notice, aren't listed in !whowatching / the privacy card, aren't
// counted (Pepe gets ghost_only), and the snapshot job tells Pepe to keep them out of the room's mod log - but every ghost
// view is audited (cam_views ghost = 1, livecam_audit ghost = 1, the switch in ghost_log + admin_audit, all on the admin
// page); opt-outs and blocks still refuse a ghost; a demoted account stops being a ghost.
//   node --test test/ghost.test.js      (needs the repo's node_modules; uses a temp DB)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ghost-test-"));
process.chdir(tmp);
process.env.SECRET_KEY = "test-secret";
delete process.env.STAGING;
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const LC = require(path.join(repo, "livecam"));
const CV = require(path.join(repo, "camviewers"));
const G = require(path.join(repo, "ghost"));
const relay = require(path.join(repo, "bridge-relay"));
const PA = require(path.join(repo, "padaccess"));
const W = require(path.join(repo, "webrtc"));
const B = require(path.join(repo, "bridge"));
require(path.join(repo, "actions"));

W.enabled = () => true;
let T = 1_000_000_000_000;
LC._setClock(() => T);
CV._setClock(() => T);
G._setClock(() => T);
LC._setKick(() => {});
CV._setDeps({ privateLogins: async () => new Set() });

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);
const R = { id: "Room.One", slug: "room-one", cams: true, livecams: true, members: [
  { login: "alice", display: "Alice", on_cam: true }, { login: "bob", on_cam: true }] };
const bySlug = (s) => (s === R.slug ? R : null);

let base, server;
test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT)`);
  for (const [id, cls, cf] of [["adm", "Admin", "admcf"], ["stf", "Staff", "stfcf"], ["pleb", "pleb", "plebcf"], ["owner", "pleb", "alice"],
                               ["bobacct", "pleb", "bob"]]) {
    await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, 'x', ?, ?)",
      [id, id + "_u", id, cls, cf]);
  }
  await PA.init();
  await PA.load();
  await LC.init();
  await LC.save({ class: "Admin", userId: "adm", username: "adm_u" }, { cfg: { enabled: true, viewers_free: 4 } });
  await CV.init();
  await G.init();
  B._rooms.set(R.id, R);
  const app = express();
  app.use(express.json());
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  const addUser = (req, res, next) => { const u = req.get("x-test-user"); req.user = u ? { userId: u, username: u + "_u" } : null; next(); };
  const opts = { addUser, isBotToken: (t) => t === "bot", bySlug, isLive: () => true };
  LC.register(app, opts);
  CV.register(app, opts);
  G.register(app, opts);
  relay.register(app, opts);
  require(path.join(repo, "incognito")).register(app, opts);
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => server.close());

const H = (u) => Object.assign({ "content-type": "application/json", "x-requested-with": "fetch" }, u ? { "x-test-user": u } : {});
async function post(p, body, u) {
  const r = await fetch(base + p, { method: "POST", headers: H(u), body: JSON.stringify(body || {}) });
  return { status: r.status, d: await r.json().catch(() => ({})) };
}
const bot = (extra) => post("/api/bridge/livecam", Object.assign({ password: "bot", cap: true, cv: true }, extra || {}), null);
const settle = () => new Promise((r) => setTimeout(r, 60));
async function watchAndRead(login, u) {
  const r = await post(`/api/rooms/${R.slug}/livecam`, { login }, u);
  assert.equal(r.d.ok, true, JSON.stringify(r.d));
  const url = new URL(r.d.whep);
  assert.equal(await LC.auth({ path: url.pathname.split("/").pop(), query: "pt=" + encodeURIComponent(url.searchParams.get("pt")) }, "read", "webrtc"), 200);
  await settle();
  return r;
}

test("only Admin / Staff can switch it on; default off; every switch is audited", async () => {
  assert.equal((await post("/api/privacy/ghost", { on: true }, "pleb")).status, 403, "never for members");
  assert.equal(G.isGhost("pleb"), false);
  assert.equal((await post("/api/privacy/ghost", { on: true }, null)).status, 401);
  assert.equal(G.isGhost("stf"), false, "off by default");
  const on = await post("/api/privacy/ghost", { on: true }, "stf");
  assert.equal(on.d.ok, true);
  assert.equal(G.isGhost("stf"), true);
  // Pepe's !ghost: by the linked login
  const b = await post("/api/bridge/ghost", { password: "bot", login: "admcf", on: true }, null);
  assert.equal(b.d.on, true);
  assert.equal((await post("/api/bridge/ghost", { password: "bot", login: "plebcf", on: true }, null)).status, 403);
  assert.equal((await post("/api/bridge/ghost", { password: "bot", login: "admcf" }, null)).d.on, true, "status");
  const log = await getQuery("SELECT * FROM ghost_log ORDER BY id");
  assert.deepEqual(log.map((r) => [r.username, r.on_, r.via]), [["stf_u", 1, "web"], ["adm_u", 1, "chat"]]);
  const aud = await getQuery("SELECT * FROM admin_audit WHERE action = 'ghost_mode'");
  assert.equal(aud.length, 2);
});

test("a ghost's live view: no notice, not listed, not counted - but audited (cam_views + livecam_audit ghost = 1)", async () => {
  await bot();
  await watchAndRead("alice", "stf");
  await bot({ live: [{ room: R.id, login: "alice", state: "live" }] });
  const a = await bot();
  assert.deepEqual(a.d.cv_notify, [], "the owner isn't told");
  const w = a.d.want.find((x) => x.login === "alice");
  assert.equal(w.ghost_only, true, "Pepe: only a ghost watches -> no room line");
  const beat = await post(`/api/rooms/${R.slug}/livecam/beat`, { login: "alice" }, "stf");
  assert.equal(beat.d.viewers, 0, "not counted where people see it");
  assert.equal(beat.d.ghost, true);
  assert.equal(LC.hint(R, "stf").ghost, true, "the 👻 badge for the ghost");
  assert.equal(LC.hint(R, "pleb").ghost, undefined);
  const ww = await post("/api/bridge/camviewers", { password: "bot", op: "watching", owner: "alice" }, null);
  assert.deepEqual([ww.d.live.length, ww.d.recent.length], [0, 0], "not in !whowatching");
  const v = await getQuery("SELECT * FROM cam_views WHERE owner = 'alice'");
  assert.deepEqual(v.map((r) => [r.user_id, r.ghost]), [["stf", 1]]);
  const la = await getQuery("SELECT ghost FROM livecam_audit WHERE viewer_id = 'stf'");
  assert.equal(la[0].ghost, 1);
  // a normal viewer joins: they're told about THAT one only, and the count is 1
  await watchAndRead("alice", "pleb");
  const b = await bot();
  assert.deepEqual(b.d.cv_notify.flatMap((n) => n.viewers.map((x) => x.username)), ["pleb_u"]);
  const w2 = b.d.want.find((x) => x.login === "alice");
  assert.equal(w2.viewers, 1);
  assert.equal(w2.ghost_only, undefined);
  await bot({ cv_ack: b.d.cv_notify.map((n) => n.id) });
  const view = await LC.adminView();
  assert.ok(view.sessions[0].viewers.some((x) => x.ghost === true), "admins see the ghost in the live session");
  assert.ok(view.ghost.views.some((x) => x.username === "stf_u" && x.kind === "live" && x.owner === "alice"), "and in 👻 Ghost views");
  assert.ok(view.recent.some((r) => r.ghost === 1));
});

test("a ghost's snapshot: no notice, Pepe's job says ghost; 1.99aak: blocks / opt-outs don't stop a ghost (logged), saving still refused", async () => {
  relay._hits.clear();
  const r = await post(`/api/rooms/${R.slug}/snap`, { login: "bob" }, "adm");
  assert.equal(r.d.ok, true);
  const job = relay.takeJobs(new Set([R.id])).find((j) => j.kind === "snap" && j.target === "bob");
  assert.equal(job.ghost, true, "Pepe keeps it out of the room's mod log");
  await post("/api/bridge/snap", { password: "bot", id: job.id, room: R.id, target: "bob", ok: true, status: "ok", data: JPEG.toString("base64") }, null);
  await settle();
  T += CV.OWNER_GAP_MS + 1;
  assert.deepEqual((await bot()).d.cv_notify, [], "bob isn't told");
  const v = await getQuery("SELECT ghost FROM cam_views WHERE owner = 'bob'");
  assert.deepEqual(v.map((x) => x.ghost), [1]);
  // 1.99aak (the user's decision): for moderation a ghost gets past a block and the opt-out to VIEW - audited with what it got past
  await CV.block("bob", "adm_u");
  assert.equal(await CV.camRefusal("bob", "adm"), null, "a block doesn't stop a ghost viewing");
  assert.equal((await CV.camRefusal("bob", "adm", { strict: true })).code, "unavailable", "...but saving / posting keeps the block");
  CV.noteView("snap", R.id, "bob", { userId: "adm", username: "adm_u" }, T);
  await settle();
  const b1 = await getQuery("SELECT bypass FROM cam_views WHERE owner = 'bob' AND bypass IS NOT NULL ORDER BY id DESC LIMIT 1");
  assert.equal(b1[0] && b1[0].bypass, "blocked", "the bypass is logged");
  await CV.unblock("bob", "adm_u");
  await LC.setOptout("bob", true, { via: "chat", ts: T });
  assert.equal(await CV.camRefusal("bob", "adm"), null, "nor does the opt-out");
  assert.equal((await CV.camRefusal("bob", "adm", { strict: true })).code, "opted_out");
  assert.equal(await CV.bypassOf("bob", "adm"), "opted_out");
  assert.equal((await CV.camRefusal("bob", "someone_else")).code, "opted_out", "everyone else: the owner's rules");
  await LC.setOptout("bob", false, { via: "chat", ts: T + 1 });
});

test("1.99aak: !livecam off drops everyone but the ghost; a ghost can start a live view past it (audited), members can't", async () => {
  await bot();
  await watchAndRead("alice", "stf");
  await watchAndRead("alice", "pleb");
  await bot({ live: [{ room: R.id, login: "alice", state: "live" }] });
  await LC.setOptout("alice", true, { via: "chat", ts: T });
  const after = await bot();
  const w = (after.d.want || []).find((x) => x.login === "alice");
  assert.ok(w, "the session lives on for the ghost");
  assert.equal(w.bypass, true, "Pepe is told to publish it despite the opt-out");
  assert.equal((await post(`/api/rooms/${R.slug}/livecam`, { login: "alice" }, "pleb")).status, 403, "members: the owner's rule");
  await post(`/api/rooms/${R.slug}/livecam/stop`, { login: "alice" }, "stf").catch(() => {});
  const r = await post(`/api/rooms/${R.slug}/livecam`, { login: "alice" }, "stf");
  assert.equal(r.d.ok, true, JSON.stringify(r.d));
  const la = await getQuery("SELECT bypass FROM livecam_audit WHERE viewer_id = 'stf' AND bypass IS NOT NULL");
  assert.ok(la.some((x) => x.bypass === "opted_out"), "the bypass is in the audit");
  await LC.setOptout("alice", false, { via: "chat", ts: T + 1 });
});

test("ghost views are kept past the 7-day window; a demoted account stops being a ghost; switching off", async () => {
  T += 8 * 24 * 3600 * 1000;
  await CV.prune(T);
  assert.ok((await getQuery("SELECT COUNT(*) AS n FROM cam_views WHERE ghost = 1"))[0].n >= 2, "the audit stays");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM cam_views WHERE ghost = 0"))[0].n, 0, "ordinary views go after 7 days");
  await runQuery("UPDATE users SET class = 'pleb' WHERE userId = 'adm'");
  await G.load();
  assert.equal(G.isGhost("adm"), false, "demoted: no longer a ghost");
  await runQuery("UPDATE users SET class = 'Admin' WHERE userId = 'adm'");
  await G.load();
  assert.equal(G.isGhost("adm"), true, "its switch is still on for when it's staff again");
  assert.equal((await post("/api/privacy/ghost", { on: false }, "stf")).d.on, false);
  assert.equal(G.isGhost("stf"), false);
});

test("the 👻 card on /settings/privacy is for staff only", async () => {
  const s = await (await fetch(base + "/settings/privacy", { headers: { "x-test-user": "adm" } })).text();
  assert.match(s, /id="ghost"/);
  assert.match(s, /id="pvGh" checked/);
  const p = await (await fetch(base + "/settings/privacy", { headers: { "x-test-user": "pleb" } })).text();
  assert.doesNotMatch(p, /id="ghost"/);
});
