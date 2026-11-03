// 1.99?? (privacy controls, review fixes - the reveal lens): cam reveals, their evidence, the notice and the ghost bypass, on the S4
// test's harness (a temp DB with the real bridge ingest on privacy wire v2, frog-name sessions, live cams, the mic stage and the routes):
//   RV-3  a reveal is listed to its person (!whowatching / the privacy card: "someone moderating <pad>") only once they were TOLD - the
//         first frame, not a ghost; never before it, never after a failed open (no_video)
//   RV-1  a pad's owner never lists (or opens) cam evidence of their OWN cam - who saved it and why would name the moderator
//   RV-2  evidence from a by-login reveal / of a left-out person is the admins' alone - never in the owner's list or file route
//   ID-7  the owner's list names a veiled subject by the frog name it showed under, never the login (admins still see the login)
//   RV-5  a reveal notice's inbox ref never links two reveals by the same moderator
//   RV-4  a 👻 ghost's ▶ Live that gets past someone's rules writes livecam_audit + the see-through log (cam_reveal) + admin_audit in ONE
//         transaction before any ticket, and a failed write refuses it - a veiled cam's always, a named one's while cam reveals are on
//         (with that switch off: today's best-effort row)
//   RV-6  /privacy's ghost bullet names the evidence exception while cam evidence is on (and only then)
//   node --test test/privm-review-reveal.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privm-review-rv-"));
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
const CAMV = require(path.join(repo, "camviewers"));
const stage = require(path.join(repo, "mainstage"));
const premium = require(path.join(repo, "premium"));
const MF = require(path.join(repo, "micfollow"));
const CR = require(path.join(repo, "camreveal"));
const CE = require(path.join(repo, "camevidence"));
const EV = require(path.join(repo, "evidence"));
const GH = require(path.join(repo, "ghost"));
const RL = require(path.join(repo, "bridge-relay"));

const D = 864e5;
const hash = (login) => crypto.createHash("sha256").update("pepe-hidden:" + String(login).trim().toLowerCase()).digest("hex").slice(0, 20);
const ROOM = { id: "S4.Room", name: "S4 Room" }, SLUG = "s4-room";
const users = new Map();
const U = {};
let base, server;
let T = Date.now();
W.enabled = () => true;
premium.bridgeAllowed = () => true;
MF._setClock(() => T);
MF._setBoot(0);
LC._setClock(() => T);
CR._setClock(() => T);
CE._setClock(() => T);
FN._setClock(() => T);
stage._setClock(() => T);
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
let WORD = true;
const MODCAPS = { modcf: { actions: ["kick", "ban"], on: true, roles: [] } };
async function fresh() {
  await LC.forBot({ cap: true, mf: 1, live: [] }, T);
  const R = bridge._rooms.get(ROOM.id);
  if (R) Object.assign(R, { updated: T, cams: true, livecams: true, mod: MODCAPS });
  CR.noteBot(WORD ? { camreveal: 1 } : {}, T);
}
async function stepAt(sec) { T += sec * 1000; await fresh(); MF.stepPad(ROOM.id, T); await MF._idle(); await settle(10); }
const pad = () => MF._pads.get(ROOM.id);
/** v2: alice named (live cam OFF - set in setup), bob named (visible), frankie INCOGNITO (incognito cams off: withheld) holding the mic,
 *  hank HIDDEN, zelda named but left out on the site (forget-me) - each on cam. */
function v2Room() {
  return { room: ROOM, cams: true, livecams: true, count: 5, transcripts: true,
           members: [Object.assign(real("alicecf", "Alice"), { on_cam: true }), Object.assign(real("bobcf", "Bob"), { on_cam: true }),
                     Object.assign(real("zeldaforgot", "Zelda"), { on_cam: true }),
                     Object.assign(real("frankiefettuccine", "Frankie Fett"), { priv: priv("incognito", "frankiefettuccine"), src: "list", on_mic: true, on_cam: true }),
                     Object.assign(real("hankhidden", "Hank Hide"), { priv: priv("hidden", "hankhidden"), src: "list", on_cam: true })],
           mic: [Object.assign(real("frankiefettuccine", "Frankie Fett"), { priv: priv("incognito", "frankiefettuccine"), proven: true, since: T / 1000 - 5 })] };
}
function call(method, url, { user = null, body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const data = body == null ? null : JSON.stringify(body);
    const h = Object.assign({ "x-requested-with": "fetch", origin: base, host: u.host }, user ? { "x-test-user": user.userId } : {},
                            data != null ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}, headers);
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const buf = Buffer.concat(chunks), s = buf.toString("utf8"); let d = null; try { d = JSON.parse(s); } catch (e) { d = null; } resolve({ status: res.statusCode, d, text: s, buf, headers: res.headers }); });
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
const live = (user) => call("GET", `/api/rooms/${SLUG}/live`, { user });
const reveal = (user, body) => call("POST", `/api/rooms/${SLUG}/livecam/reveal`, { user, body: Object.assign({ reason: "a report" }, body) });
const R0 = () => bridge._rooms.get(ROOM.id);
const entryOf = (login) => (R0().members || []).find((e) => e && e.anon && e._vz && e._vz.login === login);
const VEILED = ["frankiefettuccine", "Frankie Fett", "hankhidden", "Hank Hide", "zeldaforgot"];
const leaks = (json) => [...VEILED, ...VEILED.map(hash), ROOM.id + "|", "\"_vz\"", "\"priv\"", "\"sess\""].filter((x) => json.includes(x));
const ADM = () => ({ userId: U.adm.userId, username: "adm", class: "Admin" });
const pt = (whep) => new URL(whep, "http://x").searchParams.get("pt");
const pathOf = (whep) => { const m = /\/((?:room|stgr)-[0-9a-f]{16})\//.exec(whep) || /\/((?:room|stgr)-[0-9a-f]{16})(?:\?|$)/.exec(whep); return m ? m[1] : null; };
function clean() { for (const S of [...LC._sessions.values()]) LC._sessions.delete(S.key); RL._hits.clear(); CAMV._out.clear(); }

const setup = (async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await require(path.join(repo, "inbox")).ready;
  U.own = await mkUser("own", "pleb", "owncf");
  U.mem = await mkUser("mem", "pleb", "memcf");
  U.mod = await mkUser("moddy", "pleb", "modcf");
  U.staff = await mkUser("helper", "Staff", "helpercf");
  U.staff2 = await mkUser("helper2", "Staff", "helper2cf");
  U.adm = await mkUser("adm", "Admin", "admcf");
  U.frankie = await mkUser("frankie", "pleb", "frankiefettuccine");
  U.alice = await mkUser("alice", "pleb", "alicecf");
  await rooms.init();
  const app = express();
  app.use((req, res, next) => (req.path === "/api/bridge/sync" || req.path === "/api/bridge/sync/v2" ? next() : express.json()(req, res, next)));
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  bridge.register(app, { addUser, isBotToken: (t) => t === "bot" });
  PW.register(app, { addUser, noTimers: true });
  CR.register(app, { addUser, bySlug: (s) => bridge.bySlug(s), isLive: (R) => bridge.isLiveShown(R) });
  CE.register(app, { addUser, bySlug: (s) => bridge.bySlug(s), noTimers: true });
  require(path.join(repo, "seethrough")).register(app, { addUser, noTimers: true });
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
  for (const l of ["frankiefettuccine", "alicecf", "bobcf", "hankhidden", "zeldaforgot"]) await CA.setMode(l, "everyone");
  await LC.setOptout("alicecf", true, { via: "web", ts: T });
  await MF._ready();
  await MF.setKill(ADM(), true, "test");
  await MF.setCfg(ADM(), { covers: true, cold_open: true, reason: "test" });
  await MF.setPad(ROOM.id, { on: true }, "test");
  await MF._noticed(ROOM.id, "frankiefettuccine", T - D);
  await CV.init();
  CV._clearCaches();
  await CAMV.init();
  await GH.init();
  await CR.init();
  EV._setDir(path.join(tmp, "evidence"));
})();

// ── the switch ──

// every switch the reveal needs: privacy wire v2, cam reveals + Pepe's word; zelda left out (forget-me); the v2 room
const ready = (async () => {
  await setup;
  await PW.init();
  await PW.setOn(true, ADM());
  await CR.setOn(true, ADM());
  CR.noteBot({ camreveal: 1 }, T);
  await fresh();
  await CL.hideNow(["zeldaforgot"], "forget");
  await syncAt({ rooms: [v2Room()] });
  for (let i = 0; i < 12 && !(pad().state.tiles || []).some((x) => x.cover); i++) await stepAt(3);
  await EV.init();
  await EV.setOn(true, ADM());
})();
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
async function firstFrame(rv, whep) {
  const S = LC.revealSess(ROOM.id, rv);
  await LC.auth({ path: S.path, query: "?pt=" + encodeURIComponent(pt(whep)), ip: "1.2.3.4" }, "read", "webrtc");
  LC.noteSync([{ name: S.path, ready: true, readers: [] }], T);
  await settle(40);
  return S;
}
const stopRv = (user, rv) => call("POST", `/api/rooms/${SLUG}/livecam/reveal/stop`, { user, body: { rv } });
const modsOf = (w) => ({ live: w.live.filter((x) => x.mod), recent: w.recent.filter((x) => x.mod) });

test("setup: cam reveals in effect; frankie's cam withheld (incognito, incognito cams off); zelda left out", async () => {
  await ready;
  assert.equal(CR.effective(T), true);
  assert.equal(entryOf("frankiefettuccine")._vz.on_cam, true);
});

test("RV-3: a reveal is listed to its person only once they were told - never before the first frame, never after a failed open", async () => {
  await ready;
  clean(); await fresh();
  const r = await reveal(U.mod, { member: entryOf("frankiefettuccine").id, reason: "check a report" });
  assert.equal(r.status, 200, r.text);
  const S = LC.revealSess(ROOM.id, r.d.rv);
  let w = modsOf(await CAMV.watching("frankiefettuccine"));
  assert.deepEqual(w, { live: [], recent: [] }, "before any frame: nobody listed - " + JSON.stringify(w));
  for (let i = 0; i < 3; i++) { T += 15000; await call("POST", `/api/rooms/${SLUG}/livecam/reveal/beat`, { user: U.mod, body: { rv: r.d.rv } }); }
  LC.sweep(T);
  assert.equal(S.endWhy, "no_video", "a failed open");
  assert.equal([...CAMV._out.values()].filter((N) => N.reveal).length, 0, "nobody told");
  w = modsOf(await CAMV.watching("frankiefettuccine"));
  assert.deepEqual(w, { live: [], recent: [] }, "after the failed open: still nobody listed - " + JSON.stringify(w));
  // a reveal that reaches its first frame: told, and listed from then on (live, then recent)
  clean(); T += 11000; await fresh();
  const r2 = await reveal(U.mod, { member: entryOf("frankiefettuccine").id, reason: "check a report again" });
  assert.equal(r2.status, 200, r2.text);
  assert.deepEqual(modsOf(await CAMV.watching("frankiefettuccine")).live, [], "not listed while waiting for its frame");
  await firstFrame(r2.d.rv, r2.d.whep);
  assert.equal([...CAMV._out.values()].filter((N) => N.reveal).length, 1, "told at the first frame");
  w = modsOf(await CAMV.watching("frankiefettuccine"));
  assert.equal(w.live.length, 1, "listed live once told");
  assert.equal(w.recent.length, 1, "and in recent");
  assert.ok(/^someone moderating /.test(w.live[0].display) && w.live[0].username === "", "never who");
  await stopRv(U.mod, r2.d.rv);
  // a 👻 ghost's reveal (an admin) - its frame tells nobody, so it is never listed
  clean(); T += 11000; await fresh();
  await GH.set(U.adm.userId, true, { via: "web" });
  try {
    const r3 = await reveal(U.adm, { member: entryOf("hankhidden").id, reason: "ghost check" });
    assert.equal(r3.status, 200, r3.text);
    await firstFrame(r3.d.rv, r3.d.whep);
    assert.deepEqual(modsOf(await CAMV.watching("hankhidden")), { live: [], recent: [] }, "a ghost's reveal is never listed");
    await stopRv(U.adm, r3.d.rv);
  } finally { await GH.set(U.adm.userId, false, { via: "web" }); }
});

test("RV-5: the inbox ref of a reveal notice never links two reveals by the same moderator", async () => {
  await ready;
  for (let i = 0; i < 2; i++) {
    clean(); T += 61000; await fresh();
    const r = await reveal(U.mod, { member: entryOf("frankiefettuccine").id, reason: "check a report " + i });
    assert.equal(r.status, 200, r.text);
    await firstFrame(r.d.rv, r.d.whep);
    await settle(40);
    await stopRv(U.mod, r.d.rv);
  }
  const refs = (await getQuery("SELECT ref FROM inbox WHERE user_id = ? AND kind = 'privacy' ORDER BY id", [U.frankie.userId])).map((x) => x.ref);
  assert.ok(refs.length >= 2, "two notices: " + JSON.stringify(refs));
  const last2 = refs.slice(-2).map((x) => x.split(":"));
  assert.ok(last2.every((p) => p[0] === "camreveal" && /^[0-9a-f]{12}$/.test(p[1]) && /^[0-9a-f]{10}$/.test(p[2])), "camreveal:<sid>:<10 hex>");
  assert.notEqual(last2[0][1], last2[1][1], "two sessions");
  assert.notEqual(last2[0][2], last2[1][2], "the same moderator's tails differ across sessions");
});

test("RV-1 + ID-7: a pad's owner never gets evidence of their OWN cam; a veiled subject shows under its frog name", async () => {
  await ready;
  clean(); T += 11000; await fresh();
  CE._setDeps({ capture: async () => JPEG });
  await CA.setMode("owncf", "everyone");
  await LC.setOptout("owncf", true, { via: "web", ts: T });
  const room = v2Room();
  room.members.push(Object.assign(real("owncf", "Own"), { on_cam: true }));      // the pad's owner is on cam in the room too
  room.count++;
  await syncAt({ rooms: [room] });
  await fresh();
  // a 👻 ghost admin checks the pad owner's own hidden cam and keeps a still
  await GH.set(U.adm.userId, true, { via: "web" });
  let own;
  try {
    RL._hits.clear();
    own = await reveal(U.adm, { login: "owncf", reason: "nudity report from viewer X" });
    assert.equal(own.status, 200, own.text);
    await firstFrame(own.d.rv, own.d.whep);
    const ev = await call("POST", `/api/rooms/${SLUG}/livecam/reveal/evidence`, { user: U.adm, body: { rv: own.d.rv, kind: "still", reason: "nudity report from viewer X" } });
    assert.equal(ev.status, 200, ev.text);
    await stopRv(U.adm, own.d.rv);
  } finally { await GH.set(U.adm.userId, false, { via: "web" }); }
  // the owner (not a ghost) checks frankie (incognito; a frog entry) and keeps a still: a veiled row of their pad
  clean(); T += 11000; await fresh(); RL._hits.clear();
  const fr = await reveal(U.own, { member: entryOf("frankiefettuccine").id, reason: "a report on the frog" });
  assert.equal(fr.status, 200, fr.text);
  await firstFrame(fr.d.rv, fr.d.whep);
  const ev2 = await call("POST", `/api/rooms/${SLUG}/livecam/reveal/evidence`, { user: U.own, body: { rv: fr.d.rv, kind: "still", reason: "a report on the frog" } });
  assert.equal(ev2.status, 200, ev2.text);
  await stopRv(U.own, fr.d.rv);
  const lo = await call("GET", `/api/evidence/cam?room=${SLUG}`, { user: U.own });
  assert.equal(lo.status, 200, lo.text);
  assert.equal(lo.d.rows.filter((x) => x.subject === "owncf").length, 0, "RV-1: the owner's list has no row of their own cam: " + JSON.stringify(lo.d.rows));
  assert.ok(!lo.text.includes("nudity report from viewer X"), "RV-1: ...nor its reason");
  const ownRow = (await getQuery("SELECT id FROM cam_evidence WHERE subject_login = 'owncf' ORDER BY created DESC LIMIT 1"))[0];
  assert.equal((await call("GET", `/api/evidence/cam/${ownRow.id}/file`, { user: U.own })).status, 404, "RV-1: ...nor its file");
  const frogRows = lo.d.rows.filter((x) => x.veil === "veiled");
  assert.equal(frogRows.length, 1, "ID-7: the veiled row is listed");
  assert.ok(frogRows[0].subject && frogRows[0].subject !== "frankiefettuccine", "ID-7: under its frog name: " + frogRows[0].subject);
  assert.ok(!lo.text.includes("frankiefettuccine"), "ID-7: the login is nowhere in the owner's list");
  assert.equal((await call("GET", frogRows[0].file, { user: U.own })).status, 200, "the owner opens their pad's veiled evidence");
  // admins see both, by login
  const la = await call("GET", `/api/evidence/cam?room=${SLUG}`, { user: U.adm });
  assert.ok(la.d.rows.some((x) => x.subject === "owncf") && la.d.rows.some((x) => x.subject === "frankiefettuccine"), "admins: every row, by login");
  // the owner's list is still audited with the real login it was about
  const stl = await getQuery("SELECT logins FROM seethrough_log WHERE scope = 'cam_evidence_list' AND user_id = ? ORDER BY id DESC LIMIT 1", [U.own.userId]);
  assert.ok(stl.length && JSON.parse(stl[0].logins).includes("frankiefettuccine"), "the see-through row records the login: " + JSON.stringify(stl));
  await LC.setOptout("owncf", false, { via: "web", ts: T });
});

test("RV-2: evidence from a by-login reveal of a LEFT-OUT person is the admins' alone - never the pad owner's list or file", async () => {
  await ready;
  clean(); T += 11000; await fresh(); RL._hits.clear();
  CE._setDeps({ capture: async () => JPEG });
  const ad = await call("POST", "/api/admin/pepe/livecams/reveal", { user: U.adm, body: { room: SLUG, login: "zeldaforgot", reason: "a report names them" } });
  assert.equal(ad.status, 200, ad.text);
  const S = await firstFrame(ad.d.rv, ad.d.whep);
  assert.equal(S.rv.why, "left_out");
  const ev = await call("POST", `/api/rooms/${SLUG}/livecam/reveal/evidence`, { user: U.adm, body: { rv: ad.d.rv, kind: "still", reason: "evidence of a report" } });
  assert.equal(ev.status, 200, ev.text);
  await stopRv(U.adm, ad.d.rv);
  const row = (await getQuery("SELECT id, admin_only FROM cam_evidence WHERE subject_login = 'zeldaforgot'"))[0];
  assert.equal(row.admin_only, 1, "marked admins-only");
  const lo = await call("GET", `/api/evidence/cam?room=${SLUG}`, { user: U.own });
  assert.ok(!lo.text.includes("zeldaforgot") && !lo.d.rows.some((x) => x.id === row.id), "the owner's list never has it: " + lo.text.slice(0, 300));
  assert.equal((await call("GET", `/api/evidence/cam/${row.id}/file`, { user: U.own })).status, 404, "nor its file");
  const la = await call("GET", `/api/evidence/cam?room=${SLUG}`, { user: U.adm });
  assert.ok(la.d.rows.some((x) => x.id === row.id && x.subject === "zeldaforgot"), "admins still list it");
  assert.equal((await call("GET", `/api/evidence/cam/${row.id}/file`, { user: U.adm })).status, 200, "and open it");
});

const STAFF = () => ({ userId: U.staff.userId, username: "helper", camfrogUsername: "helpercf", class: "Staff" });
const stCount = async () => (await getQuery("SELECT COUNT(*) AS n FROM seethrough_log WHERE user_id = ? AND scope = 'cam_reveal' AND ref LIKE 'ghost:%'", [U.staff.userId]))[0].n;

test("RV-4: a 👻 ghost's ▶ Live past a named live-cam-off cam is behind the reveal audit log while cam reveals are on", async () => {
  await ready;
  clean(); await fresh();
  await GH.set(U.staff.userId, true, { via: "web" });
  try {
    const n0 = await stCount();
    const a = await LC.start(STAFF(), R0(), "alicecf", T);
    assert.ok(a.ok && a.whep, "opened");
    const S = [...LC._sessions.values()].find((x) => !x.rv && x.login === "alicecf" && !x.ended);
    const v = S.viewers.get(U.staff.userId);
    assert.equal(v.bypass, "opted_out");
    assert.ok(v.auditId, "its livecam_audit row");
    assert.equal(await stCount(), n0 + 1, "a see-through row (cam_reveal, ghost:<id>:g)");
    const st = (await getQuery("SELECT ref, logins FROM seethrough_log WHERE user_id = ? AND ref LIKE 'ghost:%' ORDER BY id DESC LIMIT 1", [U.staff.userId]))[0];
    assert.equal(st.ref, "ghost:" + v.auditId + ":g");
    assert.deepEqual(JSON.parse(st.logins), ["alicecf"]);
    assert.ok((await getQuery("SELECT 1 FROM admin_audit WHERE action = 'seethrough.cam_reveal' AND admin_id = ?", [U.staff.userId])).length, "admin_audit");
    LC.stop(U.staff.userId, ROOM.id, "alicecf", T);
    clean();
    // a failed write refuses it - nothing opened
    await runQuery("ALTER TABLE livecam_audit RENAME TO livecam_audit_x");
    let err = null;
    try { await LC.start(STAFF(), R0(), "alicecf", T + 1); } catch (e) { err = e; }
    finally { await runQuery("ALTER TABLE livecam_audit_x RENAME TO livecam_audit"); }
    assert.ok(err && err.code === "audit" && err.status === 500, "refused: " + (err && (err.code || err.message)));
    assert.ok(![...LC._sessions.values()].some((x) => !x.rv && x.login === "alicecf" && !x.ended && x.viewers.has(U.staff.userId)), "nothing opened");
    // with cam reveals switched off: today's named bypass (a best-effort row, no see-through row)
    clean();
    await CR.setOn(false, ADM());
    try {
      const n1 = await stCount();
      const b = await LC.start(STAFF(), R0(), "alicecf", T + 2);
      assert.ok(b.ok, "opened as today");
      assert.equal(await stCount(), n1, "no see-through row while cam reveals are off (today's behaviour)");
      LC.stop(U.staff.userId, ROOM.id, "alicecf", T + 2);
    } finally { await CR.setOn(true, ADM()); CR.noteBot({ camreveal: 1 }, T); }
  } finally { await GH.set(U.staff.userId, false, { via: "web" }); clean(); }
});

test("RV-4: the ghost ▶ Live of an INCOGNITO person's cam with live cam off (S5 path) is always behind the reveal audit log", async () => {
  await ready;
  clean(); await fresh();
  const IC = require(path.join(repo, "incogcams"));
  await IC.init();
  await IC.setOn(true, ADM());
  IC.noteBot({ incogcam: 1 }, T);
  await syncAt({ rooms: [v2Room()] });
  await fresh(); IC.noteBot({ incogcam: 1 }, T);
  await LC.setOptout("frankiefettuccine", true, { via: "web", ts: T });
  await GH.set(U.staff.userId, true, { via: "web" });
  try {
    const fe = entryOf("frankiefettuccine");
    assert.ok(IC.camOf(R0(), fe.id, T), "the frog's cam by its id");
    const n0 = await stCount();
    const a = await LC.start(STAFF(), R0(), null, T, { id: fe.id });
    assert.ok(a.ok, "opened");
    assert.equal(await stCount(), n0 + 1, "a see-through row");
    const la = (await getQuery("SELECT target, ghost, bypass, veil FROM livecam_audit ORDER BY id DESC LIMIT 1"))[0];
    assert.equal(la.ghost, 1);
    assert.equal(la.bypass, "opted_out");
    assert.ok(la.veil && la.veil !== "frankiefettuccine", "the audit row's label is the frog name");
    LC.stop(U.staff.userId, ROOM.id, { id: fe.id }, T);
    clean();
    await runQuery("ALTER TABLE livecam_audit RENAME TO livecam_audit_x");
    let err = null;
    try { await LC.start(STAFF(), R0(), null, T + 1, { id: fe.id }); } catch (e) { err = e; }
    finally { await runQuery("ALTER TABLE livecam_audit_x RENAME TO livecam_audit"); }
    assert.ok(err && err.code === "audit", "a failed write refuses it: " + (err && (err.code || err.message)));
  } finally {
    await GH.set(U.staff.userId, false, { via: "web" });
    await LC.setOptout("frankiefettuccine", false, { via: "web", ts: T + 2 });
    await IC.setOn(false, ADM());
    clean();
  }
});

test("RV-6: /privacy's ghost bullet names the evidence exception only while cam evidence is on", () => {
  const ejs = require("ejs");
  const TERMS = require(path.join(repo, "terms"));
  const fn = path.join(repo, "views", "privacy.ejs");
  const src = fs.readFileSync(fn, "utf8");
  const L0 = { user: null, title: "Privacy Policy", VERSION: TERMS.VERSION, UPDATED: TERMS.PRIVACY_UPDATED, enforced: false, chatlog: null,
               hubErasure: null, micrec: null, memory: null, privwire: { on: true, g: Date.UTC(2026, 9, 28, 12), g_day: "28 October 2026" }, evidence: null,
               policyDates: {}, ogBase: "http://test", incogcam: null, pv3: null };
  const CRC = { on: true, on_at: Date.UTC(2026, 10, 4, 12), on_day: "4 November 2026" };
  const ghostLi = (html) => (/<li><b>Moderation by PATV staff:<\/b>[\s\S]*?<\/li>/.exec(html) || [""])[0];
  const withEv = ghostLi(ejs.render(src, Object.assign({}, L0, { camreveal: CRC, camevidence: { on: true, any: false, on_at: CRC.on_at, on_day: CRC.on_day } }), { filename: fn }));
  assert.ok(withEv.includes("it never lets staff save, post or reuse your cam") && withEv.includes("the one exception is moderation evidence of a hidden cam"),
            "evidence on: the exception is said - " + withEv.slice(-260));
  const noEv = ghostLi(ejs.render(src, Object.assign({}, L0, { camreveal: CRC, camevidence: null }), { filename: fn }));
  assert.ok(noEv.includes("AI picture references).</li>") && !noEv.includes("exception"), "evidence off: the sentence as before");
  const off = ghostLi(ejs.render(src, Object.assign({}, L0, { camreveal: null, camevidence: { on: true } }), { filename: fn }));
  assert.ok(!off.includes("exception"), "cam reveals off: as before");
});
