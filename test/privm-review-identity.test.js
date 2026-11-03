// 1.99aid (privacy controls, review fixes - the identity lens): what an INCOGNITO person's cam tile / frog entry lets others learn, with
// every switch on (privacy wire v2, incog_cams, cam_reveal, privacy_v3 + Pepe's words), on a temp DB with the real bridge ingest, frog
// names, live cams, the mic stage and the routes:
//   ID-2   a member who ⚑ reports a veiled cam tile (by its id) never gets the login in their Download my data
//   ID-3   a member's saved snapshot of a frog-name frame queues an action with no subject login (their export shows none); Pepe gets it
//          from /api/bridge/snapframe, bot to site
//   ID-4   a 👻 ghost's ▶ Live / a snapshot of a veiled cam is in cam_views under the frog name - the 👻 views list never shows the login
//   ID-6   ending by a typed login never touches a veiled session or its cooldown: a right guess and a wrong one look the same
//   DARK-4 with incognito cams off, a late frame (no job left) is cached as before - never dropped for a veiled presence
//   node --test test/privm-review-identity.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privm-review-id-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
process.env.ALIAS_SECRET = "cd".repeat(32);
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
require(path.join(repo, "terms"))._setRequired(false);
const bridge = require(path.join(repo, "bridge"));
const CL = require(path.join(repo, "chatlog"));
const CV = require(path.join(repo, "chatlogview"));
const PW = require(path.join(repo, "privwire"));
const FN = require(path.join(repo, "frognames"));
const LC = require(path.join(repo, "livecam"));
const W = require(path.join(repo, "webrtc"));
const PA = require(path.join(repo, "padaccess"));
const CA = require(path.join(repo, "camaccess"));
const stage = require(path.join(repo, "mainstage"));
const premium = require(path.join(repo, "premium"));
const MF = require(path.join(repo, "micfollow"));
const IC = require(path.join(repo, "incogcams"));
const CR = require(path.join(repo, "camreveal"));
const RL = require(path.join(repo, "bridge-relay"));
const AX = require(path.join(repo, "accountexport"));
const GH = require(path.join(repo, "ghost"));
const CAMV = require(path.join(repo, "camviewers"));

const D = 864e5;
const hash = (login) => crypto.createHash("sha256").update("pepe-hidden:" + String(login).trim().toLowerCase()).digest("hex").slice(0, 20);
const ROOM = { id: "S5.Room", name: "S5 Room" }, SLUG = "s5-room";
const users = new Map();
const U = {};
let base, server;
let T = Date.now();
W.enabled = () => true;
premium.bridgeAllowed = () => true;
MF._setClock(() => T); MF._setBoot(0); LC._setClock(() => T); IC._setClock(() => T); FN._setClock(() => T); stage._setClock(() => T);
CR._setClock(() => T);
LC._setKick(() => {});
const real = (login, display) => ({ id: login.toLowerCase(), login, display: display || login });
const priv = (kind, login) => ({ kind, h: hash(login), at: T / 1000 });
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function syncAt(body, v2 = true) {
  const realNow = Date.now;
  Date.now = () => T;
  try { return await bridge.ingest(Object.assign({ events: [], rooms: [], bridge_hidden_h: [hash("hankhidden")], incog_hidden_h: [hash("frankiefettuccine")] }, body), { v2 }); }
  finally { Date.now = realNow; }
}
async function fresh() {
  await LC.forBot({ cap: true, mf: 1, live: [] }, T);
  const R = bridge._rooms.get(ROOM.id);
  if (R) Object.assign(R, { updated: T, cams: true, livecams: true });
  IC.noteBot({ incogcam: 1 }, T);
  CR.noteBot({ camreveal: 1 }, T);
}
async function stepAt(sec) { T += sec * 1000; await fresh(); MF.stepPad(ROOM.id, T); await MF._idle(); await settle(10); }
const pad = () => MF._pads.get(ROOM.id);
function v2Room({ mic = true } = {}) {
  return { room: ROOM, cams: true, livecams: true, count: 3, transcripts: true,
           members: [Object.assign(real("alicecf", "Alice"), { on_cam: true }),
                     Object.assign(real("frankiefettuccine", "Frankie Fett"), { priv: priv("incognito", "frankiefettuccine"), src: "list", on_mic: mic, on_cam: true }),
                     Object.assign(real("hankhidden", "Hank Hide"), { priv: priv("hidden", "hankhidden"), src: "list", on_cam: true })],
           mic: mic ? [Object.assign(real("frankiefettuccine", "Frankie Fett"), { priv: priv("incognito", "frankiefettuccine"), proven: true, since: T / 1000 - 5 })] : [] };
}
function call(method, url, { user = null, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const data = body == null ? null : JSON.stringify(body);
    const h = Object.assign({ "x-requested-with": "fetch", origin: base, host: u.host }, user ? { "x-test-user": user.userId } : {},
                            data != null ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {});
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: h }, (res) => {
      let s = ""; res.setEncoding("utf8"); res.on("data", (c) => { s += c; });
      res.on("end", () => { let d = null; try { d = JSON.parse(s); } catch (e) { d = null; } resolve({ status: res.statusCode, d, text: s }); });
    });
    req.on("error", reject);
    if (data != null) req.write(data);
    req.end();
  });
}
async function mkUser(name, cls = "pleb", camfrog = null) {
  const uid = "id-" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, 5, '2026-01-01 00:00:00')`, [uid, name, name, cls, camfrog]);
  const u = { userId: uid, username: name, class: cls, camfrogUsername: camfrog };
  users.set(uid, u);
  return u;
}
const SECRETS = ["frankiefettuccine", "Frankie Fett", hash("frankiefettuccine")];
const found = (s) => SECRETS.filter((x) => String(s).includes(x));
const frogEntry = () => (bridge._rooms.get(ROOM.id).members || []).find((e) => e && e.anon && e._vz && e._vz.login === "frankiefettuccine");
const ADM = () => ({ userId: U.adm.userId, username: "adm", class: "Admin" });

const setup = (async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await require(path.join(repo, "inbox")).ready;
  U.own = await mkUser("own", "pleb", "owncf");
  U.mem = await mkUser("mem", "pleb", "memcf");
  U.mem2 = await mkUser("mem2", "pleb", "mem2cf");
  U.staff = await mkUser("helper", "Staff");
  U.adm = await mkUser("adm", "Admin", "admcf");
  U.frankie = await mkUser("frankie", "pleb", "frankiefettuccine");
  await rooms.init();
  const app = express();
  app.use((req, res, next) => (req.path === "/api/bridge/sync" || req.path === "/api/bridge/sync/v2" ? next() : express.json()(req, res, next)));
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  app.set("views", path.join(repo, "views")); app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  bridge.register(app, { addUser, isBotToken: (t) => t === "bot" });
  PW.register(app, { addUser, noTimers: true });
  IC.register(app, { addUser });
  await new Promise((r) => { server = app.listen(0, r); });
  server.unref();
  base = "http://127.0.0.1:" + server.address().port;
  CL._setClock(() => Date.now() - 8 * D);
  await CL.setSwitch("notice", true, "test");
  CL._setClock(() => Date.now());
  for (const s of ["archive", "history"]) await CL.setSwitch(s, true, "test");
  await syncAt({ rooms: [{ room: ROOM, cams: true, livecams: true, members: [real("alicecf", "Alice")], mic: [], count: 1 }] }, false);
  for (let i = 0; i < 20 && !(await rooms.get(ROOM.id)); i++) await settle(20);
  await rooms.setOwner(ROOM.id, "own", "test");
  await PA.init();
  await PA.setLevel({ userId: U.own.userId, username: "own" }, { id: ROOM.id }, "public");
  await stage.init();
  await LC.init();
  await LC.save(ADM(), { cfg: { enabled: true, max_live: 12 } });
  await CA.init();
  await CA.setMode("frankiefettuccine", "everyone");
  await MF._ready();
  await MF.setKill(ADM(), true, "test");
  await MF.setCfg(ADM(), { covers: true, cold_open: true, reason: "test" });
  await MF.setPad(ROOM.id, { on: true }, "test");
  await MF._noticed(ROOM.id, "frankiefettuccine", T - D);
  await CV.init(); CV._clearCaches();
  await PW.init(); await PW.setOn(true, ADM());
  await IC.init(); await IC.setOn(true, ADM());
  await CR.init(); await CR.setOn(true, ADM());
  const PS = require(path.join(repo, "privacystate"));
  await PS.init(); await PS.setOn(true, ADM()); PS.noteBot({ privstate: 1 }, T);
  await GH.init();
  await CAMV.init();
  await fresh();
  await syncAt({ rooms: [v2Room({ mic: true })] });
  for (let i = 0; i < 15 && !pad().state.tiles.some((x) => !x.cover); i++) await stepAt(3);
})();

test("setup: every switch on, frankie a veiled CAM tile on the mic stage", async () => {
  await setup;
  assert.equal(IC.effective(T), true);
  assert.equal(CR.effective(T), true);
  assert.ok(/^anon-[0-9a-f]{8}$/.test(String(pad().vids.get("frankiefettuccine"))), "a veiled cam tile id");
});

test("ID-2: a ⚑ report of a veiled cam tile never names its subject in the reporter's Download my data", async () => {
  await setup;
  const vid = pad().vids.get("frankiefettuccine");
  const rp = await call("POST", `/api/rooms/${SLUG}/micfollow/report`, { user: U.mem, body: { login: vid, reason: "other" } });
  assert.equal(rp.status, 200, rp.text);
  assert.deepEqual(found(rp.text), [], "the answer names nobody");
  const row = (await getQuery("SELECT login, veiled FROM micfollow_reports WHERE reporter_id = ?", [U.mem.userId]))[0];
  assert.equal(row.login, "frankiefettuccine", "the server keeps the login (staff review, through the logged reveal)");
  assert.equal(row.veiled, 1, "marked veiled");
  const mine = ((await AX.collect(U.mem.userId)).chat || {}).mic_stage_reports_you_made;
  assert.equal(Array.isArray(mine) && mine.length, 1, "the reporter's own report is in their export");
  assert.equal(mine[0].login, null, "...without the subject's login");
  assert.equal(mine[0].reason, "other");
  assert.deepEqual(found(JSON.stringify(mine)), [], "no identity string anywhere in it");
  // a NAMED report keeps its login (the reporter typed / saw it): the export is as before
  await runQuery("INSERT INTO micfollow_reports (room_id, login, reporter_id, reason, at, qualified, state, veiled) VALUES (?, 'alicecf', ?, 'other', ?, 0, 'open', 0)",
                 [ROOM.id, U.mem.userId, T]);
  const two = ((await AX.collect(U.mem.userId)).chat || {}).mic_stage_reports_you_made;
  assert.ok(two.some((r) => r.login === "alicecf"), "a named report still names who was reported");
});

test("ID-3 + ID-4: a member's saved snapshot of a frog-name frame queues no login; its cam_views row carries the frog name", async () => {
  await setup;
  const fe = frogEntry();
  assert.ok(fe && fe.id, "the frog entry");
  const r = await call("POST", `/api/rooms/${SLUG}/snap`, { user: U.mem2, body: { id: fe.id } });
  assert.equal(r.status, 200, r.text);
  const j = [...RL._jobs.values()].find((x) => x.kind === "snap" && x.target === "frankiefettuccine" && x.state !== "done");
  assert.ok(j && j.vkey, "a veiled snap job");
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8]), crypto.randomBytes(64)]);
  await call("POST", "/api/bridge/snap", { body: { password: "bot", id: j.id, room: ROOM.id, target: "frankiefettuccine", ok: true, data: jpg.toString("base64"), save: "on", viewer_ok: true } });
  await settle(60);
  const cv = (await getQuery("SELECT owner, kind, veil FROM cam_views WHERE user_id = ? AND kind = 'snap' ORDER BY id DESC LIMIT 1", [U.mem2.userId]))[0];
  const g = await call("GET", `/api/rooms/${SLUG}/snap/${encodeURIComponent(fe.id)}`, { user: U.mem2 });
  assert.equal(g.status, 200, g.text);
  const sid = g.d && g.d.save ? g.d.save.sid : "";
  assert.ok(sid, "Save offered: " + g.text);
  const sv = await call("POST", `/api/rooms/${SLUG}/snap/save`, { user: U.mem2, body: { sid } });
  assert.equal(sv.status, 200, sv.text);
  const act = (await getQuery("SELECT kind, args, label FROM pepe_actions WHERE id = ?", [sv.d.id]))[0];
  const args = JSON.parse(act.args);
  assert.equal(args[0], ROOM.id);
  assert.equal(args[1], "", "ID-3: no subject login in the saver's action");
  assert.ok(/^f[0-9a-f]{24}$/.test(args[2]), "the frame id");
  assert.equal(act.label, "!snap someone");
  assert.deepEqual(found(act.args + act.label), [], "nothing names them");
  const acts = (((await AX.collect(U.mem2.userId)).holdings || {}).website_game_actions || []).filter((a) => a.kind === "snap.save");
  assert.equal(acts.length, 1);
  assert.deepEqual(found(JSON.stringify(acts)), [], "the saver's export names nobody");
  // Pepe (bot to site) still gets the subject from the frame itself
  const fr = await call("POST", "/api/bridge/snapframe", { body: { password: "bot", id: args[2], user: "mem2" } });
  assert.equal(fr.status, 200, fr.text);
  assert.equal(fr.d.target, "frankiefettuccine");
  assert.equal(fr.d.room, ROOM.id);
  // ID-4: the snapshot's view row (the 👻 views list reads it) carries the frog name
  assert.ok(cv && cv.veil && !found(cv.veil).length, "ID-4: the snapshot's cam_views row carries the frog name: " + JSON.stringify(cv));
});

test("ID-4: a 👻 ghost's ▶ Live of the frog's cam is in the 👻 views list under the frog name, never the login", async () => {
  await setup;
  const gs = await GH.set(U.staff.userId, true, { via: "web" });
  assert.ok(gs && gs.ok);
  try {
    T += 1000; await fresh();
    const fe = frogEntry();
    const lv = await call("POST", `/api/rooms/${SLUG}/livecam`, { user: U.staff, body: { id: fe.id } });
    assert.equal(lv.status, 200, lv.text);
    assert.deepEqual(found(lv.text), []);
    const u = new URL(lv.d.whep);
    const st = await LC.auth({ path: u.pathname.split("/").pop(), query: "pt=" + encodeURIComponent(u.searchParams.get("pt")) }, "read", "webrtc");
    assert.equal(st, 200, "the first frame");
    await settle(80);
    const row = (await getQuery("SELECT owner, kind, ghost, veil FROM cam_views WHERE user_id = ? AND kind = 'live' ORDER BY id DESC LIMIT 1", [U.staff.userId]))[0];
    assert.equal(row.ghost, 1);
    assert.ok(row.veil && !found(row.veil).length, "the row carries the frog name: " + JSON.stringify(row));
    const av = await LC.adminView();
    const views = (av.ghost || {}).views || [];
    assert.ok(views.some((v) => /\(veiled\)$/.test(v.owner)), "listed under the frog name: " + JSON.stringify(views));
    assert.deepEqual(found(JSON.stringify(views)), [], "the 👻 views list never names the frog's login");
    LC.stop(U.staff.userId, ROOM.id, { id: fe.id }, T);
  } finally { await GH.set(U.staff.userId, false, { via: "web" }); }
});

test("ID-6: ending by a typed login never touches the frog's veiled session or its cooldown - a right guess looks like a wrong one", async () => {
  await setup;
  T += 1000; await fresh();
  const fe = frogEntry();
  const w1 = await call("POST", `/api/rooms/${SLUG}/livecam`, { user: U.mem, body: { id: fe.id } });
  assert.equal(w1.status, 200, w1.text);
  const wrong = await call("POST", `/api/rooms/${SLUG}/livecam/end`, { user: U.own, body: { login: "alicecf" } });
  let b1 = await call("POST", `/api/rooms/${SLUG}/livecam/beat`, { user: U.mem, body: { id: fe.id } });
  assert.notEqual(b1.d.state, "ended", "a wrong guess ends nothing");
  const right = await call("POST", `/api/rooms/${SLUG}/livecam/end`, { user: U.own, body: { login: "frankiefettuccine" } });
  assert.equal(right.status, wrong.status, "the same status");
  assert.deepEqual(right.d, wrong.d, "the same answer");
  b1 = await call("POST", `/api/rooms/${SLUG}/livecam/beat`, { user: U.mem, body: { id: fe.id } });
  assert.notEqual(b1.d.state, "ended", "the right guess ends nothing either: " + b1.text);
  const w2 = await call("POST", `/api/rooms/${SLUG}/livecam`, { user: U.mem2, body: { id: fe.id } });
  assert.equal(w2.status, 200, "no cooldown on the frog's cam: " + w2.text);
  // ending by the frog entry's id still works (and the history names the frog name)
  const byId = await call("POST", `/api/rooms/${SLUG}/livecam/end`, { user: U.own, body: { id: fe.id } });
  assert.equal(byId.status, 200, byId.text);
  b1 = await call("POST", `/api/rooms/${SLUG}/livecam/beat`, { user: U.mem, body: { id: fe.id } });
  assert.equal(b1.d.state, "ended", "{id} ends it");
  const ev = await getQuery("SELECT detail FROM room_events WHERE what = 'livecam-end' ORDER BY rowid DESC LIMIT 1").catch(() => []);
  if (ev.length) assert.deepEqual(found(ev[0].detail), [], "the {id} end's history line names the frog name: " + ev[0].detail);
});

test("DARK-4: with incognito cams off, a late frame (no job left) of a veiled person is cached as before - never dropped", async () => {
  await setup;
  await IC.setOn(false, ADM());
  try {
    assert.equal(IC.effective(T), false);
    const jpg = Buffer.concat([Buffer.from([0xff, 0xd8]), crypto.randomBytes(64)]);
    const r = await call("POST", "/api/bridge/snap", { body: { password: "bot", id: "w-gone", room: ROOM.id, target: "frankiefettuccine", ok: true, data: jpg.toString("base64") } });
    assert.equal(r.status, 200, r.text);
    assert.notEqual(r.d.dropped, true, "switch off: not dropped (today's behaviour)");
    await IC.setOn(true, ADM()); await fresh();
    const r2 = await call("POST", "/api/bridge/snap", { body: { password: "bot", id: "w-gone2", room: ROOM.id, target: "frankiefettuccine", ok: true, data: jpg.toString("base64") } });
    assert.equal(r2.d.dropped, true, "switch on: a late frame of someone veiled in the room is dropped");
  } finally { await IC.setOn(true, ADM()); }
});
