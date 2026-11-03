// 1.99?? (privacy controls S4): CAM REVEALS (G:/ops/privacy-controls-spec-2026-11-02.md 3.2 + section 5 "S4"; the owner's answers,
// section 8: Q8 admins, staff, pad owners and room mods may reveal; Q9 the ghost bypass covers veiled cams; Q10 / Q11 only cam
// reveals notify, never naming who; Q12 evidence stills / clips; Q13 the pad's switches stand; Q15 3 minutes + Extend; Q22 by login).
// On a temp DB with the real bridge ingest (privacy wire v2), frog-name sessions, live cams, the mic-stage engine and the routes:
//   switch    camreveal.js: off by default (every route 404); on only with privacy wire v2 (409); the sync answer says camreveal: 1
//             only while both are on; effective() also needs Pepe's word; /api/admin/camreveal is chatlog.admin; the bot reads the
//             same key names (PEPE_BOT_DIR)
//   who       a member gets the same 403 whatever they name; admin / staff / the pad's owner / the room's mod may; by login: admin and
//             staff only; a reason of at least 3 characters
//   which     a cover tile, a frog entry (incognito while incognito cams are off, or !bridge hide), a named person with live cam off -
//             resolved server-side; a cam visible to the moderator -> 409 visible; left out -> refused through a tile / an entry,
//             allowed by login (Q22)
//   rows      ONE transaction before the ticket: seethrough_log cam_reveal, livecam_audit (bypass reveal:<what>, veil label), cam_views
//             kind reveal, admin_audit seethrough.cam_reveal
//   session   its own key (":rv:"), a random path, only its moderators read it (MediaMTX hook), never a ▶ Live slot / hint / relayHold,
//             Pepe's want {rv, reveal, exact, bypass, quiet}, his live / refused lines by rv
//   told      at the first frame (a reader + MediaMTX's stream) - one Pepe notice {reveal} with no name + one inbox "privacy" row;
//             never before, never on a failed open (no_video), never for a ghost (until they turn ghost off)
//   limits    one open per moderator, 10 s between, 3 minutes each, Extend logged again; a beat re-checks the right and the hiding
//   pages     a member's /live: nothing new; a moderator's: cv: 1 flags and livecams.reveal - never a login or a veiled on_cam
//   admin     /admin/pepe/livecams shows a veiled reveal by its label, ghost views too; the switch off ends every reveal
//   evidence  admins / the pad's owner only, while viewing; ONE transaction; listed / served with private headers; 30 days, holds
//   node --test test/privm-s4.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privm-s4-test-"));
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
test("switch: off by default (every route 404); on only with privacy wire v2; the advert and Pepe's word; admins only", async () => {
  await setup;
  assert.equal(CR.isOn(), false);
  assert.equal(CR.advert(), false);
  let r = await reveal(U.adm, { login: "alicecf" });
  assert.equal(r.status, 404, "off: 404 " + r.text);
  assert.equal(r.d.code, "off");
  const sync = () => call("POST", "/api/bridge/sync", { body: { password: "bot", events: [], rooms: [], hidden_h: [], camreveal: 1 } });
  r = await sync();
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.camreveal, undefined, "switch off: no advert");
  const IB = require(path.join(repo, "inbox"));
  assert.equal(IB.kindList().some((k) => k.key === "privacy"), false, "the inbox's privacy category isn't listed before cam reveals were ever on");
  assert.equal("privacy" in (await IB.prefs(U.mem.userId)), false);
  await assert.rejects(CR.setOn(true, { userId: U.adm.userId, username: "adm" }), (e) => e.status === 409 && e.code === "privwire_off");
  await PW.init();
  await PW.setOn(true, { userId: U.adm.userId, username: "adm" });
  r = await sync();
  assert.equal(r.d.privwire, 2);
  assert.equal(r.d.camreveal, undefined, "privacy wire alone: no advert");
  assert.equal((await call("POST", "/api/admin/camreveal", { user: U.mem, body: { on: true } })).status, 403);
  assert.equal((await call("POST", "/api/admin/camreveal", { user: U.staff, body: { on: true } })).status, 403, "staff can't flip it");
  const on = await call("POST", "/api/admin/camreveal", { user: U.adm, body: { on: true } });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.d.state.on, true);
  assert.equal((await getQuery("SELECT action FROM admin_audit WHERE action = 'camreveal.switch'")).length, 1, "audited");
  r = await sync();
  assert.equal(r.d.camreveal, 1, "the advert while both are on");
  CR.noteBot({}, T);
  assert.equal(CR.effective(T), false, "no word from Pepe: not in effect");
  CR.noteBot({ camreveal: true }, T);
  assert.equal(CR.effective(T), false, "only camreveal: 1 exactly");
  CR.noteBot({ camreveal: 1 }, T);
  assert.equal(CR.effective(T), true);
  assert.equal(CR.effective(T + CR.BOT_FRESH_MS + 1), false, "...while his word is fresh");
  assert.equal(CR.everOn(), true);
  assert.equal(IB.kindList().some((k) => k.key === "privacy"), true, "listed from then on");
  if (process.env.PEPE_BOT_DIR) {
    const b = fs.readFileSync(path.join(process.env.PEPE_BOT_DIR, "pepe_bridge.py"), "utf8");
    assert.ok(b.includes('rj.get("camreveal")') && b.includes('payload["camreveal"] = 1'), "Pepe reads camreveal and says camreveal: 1");
    const lv = fs.readFileSync(path.join(process.env.PEPE_BOT_DIR, "pepe_livecam.py"), "utf8");
    assert.ok(/w\.get\("rv"\)/.test(lv) && /"quiet"/.test(lv), "Pepe reads want[].rv / quiet");
  }
  // the room: the v2 snapshot now (camreveal on: a veiled member's on_cam is kept server-side)
  await fresh();
  await CL.hideNow(["zeldaforgot"], "forget");
  await syncAt({ rooms: [v2Room()] });
  for (let i = 0; i < 12 && !(pad().state.tiles || []).some((x) => x.cover); i++) await stepAt(3);
  assert.equal(entryOf("hankhidden")._vz.on_cam, true, "a hidden member's on_cam, server-side");
  assert.equal(entryOf("frankiefettuccine")._vz.on_cam, true);
  assert.ok(pad().state.tiles.some((x) => x.cover), "frankie's hooded cover (incognito cams are off)");
});

// ── who ──
test("who: a member gets one 403 for anything; a reason is required; admin / staff / owner / mod may; by login: admin and staff only", async () => {
  await setup;
  clean(); await fresh();
  const hank = entryOf("hankhidden").id;
  for (const b of [{ member: hank }, { login: "alicecf" }, { login: "nobody" }, { tile: "zzz" }]) {
    const r = await reveal(U.mem, b);
    assert.equal(r.status, 403, JSON.stringify(b) + " " + r.text);
    assert.equal(r.d.code, "forbidden");
  }
  const short = await reveal(U.adm, { member: hank, reason: "x" });
  assert.equal(short.status, 400);
  assert.equal(short.d.code, "why");
  for (const [k, u] of [["adm", U.adm], ["staff", U.staff], ["own", U.own], ["mod", U.mod]]) {
    clean(); await fresh();
    const r = await reveal(u, { member: hank });
    assert.equal(r.status, 200, k + ": " + r.text);
    assert.equal(r.d.role, k === "adm" ? "admin" : k === "own" ? "owner" : k);
    assert.deepEqual(leaks(r.text), [], k + ": " + leaks(r.text).join(", "));
  }
  clean(); await fresh();
  const by = (u, login) => call("POST", "/api/admin/pepe/livecams/reveal", { user: u, body: { room: SLUG, login, reason: "a report names them" } });
  assert.equal((await by(U.own, "zeldaforgot")).status, 403, "an owner has no admin page");
  const st = await by(U.staff, "zeldaforgot");
  assert.equal(st.status, 403, "the page needs livecam.admin: " + st.text);
  const ad = await by(U.adm, "zeldaforgot");
  assert.equal(ad.status, 200, "Q22: someone left out, by login: " + ad.text);
  assert.equal(ad.d.slug, SLUG);
  assert.equal(ad.d.name, "zeldaforgot", "it shows what the admin typed - no frog name");
});

// ── which cam ──
test("which: a cover, a frog entry, a named person with live cam off; a visible cam -> 409; left out only by login; own cam refused", async () => {
  await setup;
  clean(); await fresh();
  const P = await live(U.mod);
  const cover = (P.d.stage_program.src || []).find((s) => s.kind === "cover");
  assert.ok(cover && cover.cv === 1, "the moderator's cover carries cv: 1: " + JSON.stringify(P.d.stage_program.src));
  let r = await reveal(U.mod, { tile: cover.id });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.name, entryOf("frankiefettuccine").alias, "the frog name - never the login");
  assert.equal(r.d.veiled, true);
  clean(); await fresh();
  r = await reveal(U.own, { login: "alicecf" });
  assert.equal(r.status, 200, "named, live cam off: " + r.text);
  assert.equal(r.d.name, "alicecf");
  clean(); await fresh();
  r = await reveal(U.own, { login: "bobcf" });
  assert.equal(r.status, 409, "bob's cam is visible: " + r.text);
  assert.equal(r.d.code, "visible");
  r = await reveal(U.own, { login: "zeldaforgot" });
  assert.equal(r.status, 404, "left out: never through the page's login path either");
  r = await reveal(U.alice, { login: "alicecf" });
  assert.equal(r.status, 403, "alice has no role");
  // the subject's own cam (a moderator who is the subject)
  const mine = await mkUser("hanky", "Staff", "hankhidden");
  r = await reveal(mine, { member: entryOf("hankhidden").id });
  assert.equal(r.d.code, "self");
});

// ── the rows ──
test("rows: one transaction before the ticket - see-through cam_reveal, livecam_audit, cam_views reveal, admin_audit", async () => {
  await setup;
  clean(); await fresh();
  const n0 = (await getQuery("SELECT COUNT(*) AS n FROM seethrough_log WHERE scope = 'cam_reveal'"))[0].n;
  const hank = entryOf("hankhidden");
  const r = await reveal(U.staff, { member: hank.id, reason: "nudity report" });
  assert.equal(r.status, 200, r.text);
  const st = await getQuery("SELECT role, logins, reason, ref FROM seethrough_log WHERE scope = 'cam_reveal' ORDER BY id DESC LIMIT 1");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM seethrough_log WHERE scope = 'cam_reveal'"))[0].n, n0 + 1);
  assert.deepEqual([st[0].role, JSON.parse(st[0].logins), st[0].reason, st[0].ref], ["staff", ["hankhidden"], "nudity report", "cam:" + r.d.rv]);
  const la = (await getQuery("SELECT target, viewer_id, bypass, veil, ghost FROM livecam_audit ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual([la.target, la.viewer_id, la.bypass, la.veil, la.ghost], ["hankhidden", U.staff.userId, "reveal:hidden", hank.alias, 0]);
  const cv = (await getQuery("SELECT owner, kind, bypass, veil FROM cam_views ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual([cv.owner, cv.kind, cv.bypass, cv.veil], ["hankhidden", "reveal", "reveal:hidden", hank.alias]);
  const aa = (await getQuery("SELECT action, detail FROM admin_audit WHERE action = 'seethrough.cam_reveal' ORDER BY rowid DESC LIMIT 1"))[0];
  assert.ok(aa && JSON.parse(aa.detail).sid === r.d.rv, "admin_audit");
  // a failed write refuses it: nothing opens
  clean(); await fresh();
  const realLog = require(path.join(repo, "seethrough")).log;
  require(path.join(repo, "seethrough")).log = async () => null;
  try {
    const bad = await reveal(U.adm, { member: hank.id });
    assert.equal(bad.status, 500, bad.text);
    assert.equal([...LC._sessions.values()].some((S) => S.rv), false, "no session without its rows");
  } finally { require(path.join(repo, "seethrough")).log = realLog; }
});

// ── the session ──
test("session: its own key and a random path; only its moderators read it; never a ▶ Live slot; Pepe's want and lines by rv", async () => {
  await setup;
  clean(); await fresh();
  const r = await reveal(U.adm, { member: entryOf("hankhidden").id });
  assert.equal(r.status, 200, r.text);
  const S = LC.revealSess(ROOM.id, r.d.rv);
  assert.ok(S && S.rv && S.key.includes(":rv:" + r.d.rv), "its own key");
  assert.notEqual(S.path, LC.pathFor(ROOM.id, "hankhidden"));
  assert.equal(r.d.whep.includes(S.path), true);
  assert.equal(r.d.whep.includes("hankhidden"), false);
  assert.equal(LC.sessOf(ROOM.id, "hankhidden"), null, "▶ Live never finds it");
  assert.equal(LC.relayHold(S.path, ROOM.id), null);
  assert.deepEqual(LC.hint(R0(), U.adm.userId).watching, [], "not in hint().watching");
  assert.equal(LC.hint(R0(), U.adm.userId).slots.used, 0, "no ▶ Live slot");
  // MediaMTX's read hook: the moderator's ticket, nobody else's
  const ok = await LC.auth({ path: S.path, query: "?pt=" + encodeURIComponent(pt(r.d.whep)), ip: "1.2.3.4" }, "read", "webrtc");
  assert.equal(ok, 200);
  const other = LC.readTicket(U.mem.userId, S.path, T);
  assert.equal(await LC.auth({ path: S.path, query: "?pt=" + encodeURIComponent(other), ip: "1.2.3.4" }, "read", "webrtc"), 403, "a valid ticket of someone else");
  assert.equal(await LC.auth({ path: S.path, query: "", ip: "127.0.0.1", user: "camrev", password: "0".repeat(64) }, "read", "rtsp"), 403, "no capture job: no RTSP");
  assert.equal(await LC.auth({ path: S.path, query: "", ip: "127.0.0.1" }, "read", "hls"), 403);
  // an evidence capture's loopback reader: only while its job reads THAT path, from loopback, with its own password
  const job = { id: "j1", path: S.path, expiry: T + 30000, reading: true };
  CE._jobs.set(job.id, job);
  try {
    assert.equal(await LC.auth({ path: S.path, ip: "127.0.0.1", user: "camrev", password: CE.password(job) }, "read", "rtsp"), 200);
    assert.equal(await LC.auth({ path: S.path, ip: "10.0.0.9", user: "camrev", password: CE.password(job) }, "read", "rtsp"), 403, "not loopback");
    assert.equal(await LC.auth({ path: LC.pathFor(ROOM.id, "hankhidden"), ip: "127.0.0.1", user: "camrev", password: CE.password(job) }, "read", "rtsp"), 403, "another path");
  } finally { CE._jobs.delete(job.id); }
  // Pepe's want: exact, quiet, past the opt-out
  const w = (await LC.forBot({ cap: true, mf: 1, live: [] }, T)).want.find((x) => x.rv === r.d.rv);
  assert.ok(w, "a want for it");
  assert.deepEqual([w.login, w.reveal, w.exact, w.bypass, w.quiet, w.path], ["hankhidden", true, true, true, true, S.path]);
  // his live line by rv (a line by keyOf never reaches it)
  await LC.forBot({ cap: true, mf: 1, live: [{ room: ROOM.id, login: "hankhidden", state: "live" }] }, T);
  assert.equal(S.botState, null, "a keyOf line isn't about it");
  await LC.forBot({ cap: true, mf: 1, live: [{ room: ROOM.id, login: "hankhidden", rv: r.d.rv, state: "live" }] }, T);
  assert.equal(S.botState, "live");
  // a ghost-only reveal says so to Pepe
  await GH.set(U.adm.userId, true, { via: "web" });
  try {
    const w2 = (await LC.forBot({ cap: true, mf: 1, live: [] }, T)).want.find((x) => x.rv === r.d.rv);
    assert.equal(w2.ghost_only, true);
  } finally { await GH.set(U.adm.userId, false, { via: "web" }); }
  // his refusal by rv ends it (nobody told)
  await LC.forBot({ cap: true, mf: 1, live: [], refused: [{ room: ROOM.id, login: "hankhidden", rv: r.d.rv, sid: r.d.rv, why: "not_on_cam" }] }, T);
  assert.equal(S.ended > 0, true);
  assert.equal(S.endWhy, "not_on_cam");
});

// ── told ──
test("told: at the first frame only - one notice without a name, one inbox 'privacy' row; never for a failed open or a ghost", async () => {
  await setup;
  clean(); await fresh();
  const fe = entryOf("frankiefettuccine");
  const r = await reveal(U.mod, { member: fe.id, reason: "check a report" });
  assert.equal(r.status, 200, r.text);
  const S = LC.revealSess(ROOM.id, r.d.rv);
  const reveals = () => [...CAMV._out.values()].filter((N) => N.reveal);
  assert.equal(reveals().length, 0, "nothing before a frame");
  assert.equal(await LC.auth({ path: S.path, query: "?pt=" + encodeURIComponent(pt(r.d.whep)), ip: "1.2.3.4" }, "read", "webrtc"), 200);
  assert.equal(reveals().length, 0, "a reader, but MediaMTX has no stream yet: nothing");
  LC.noteSync([{ name: S.path, ready: true, readers: [] }], T);
  assert.equal(reveals().length, 1, "the first frame: told");
  LC.noteSync([{ name: S.path, ready: true, readers: [] }], T + 1000);
  await call("POST", `/api/rooms/${SLUG}/livecam/reveal/beat`, { user: U.mod, body: { rv: r.d.rv } });
  assert.equal(reveals().length, 1, "once per moderator per session");
  // !whowatching / the privacy card: "someone moderating", never the name
  const wv = await CAMV.watching("frankiefettuccine");
  assert.equal(JSON.stringify(wv).includes("moddy"), false);
  assert.ok(wv.live.some((x) => x.mod && x.display === "someone moderating S4 Room"), JSON.stringify(wv));
  assert.ok(wv.recent.some((x) => x.mod && x.kinds[0] === "reveal"));
  T += CAMV.OWNER_GAP_MS + 1;
  const out = CAMV.forBot({ cv: true }, T);
  const n = out.find((x) => x.reveal);
  assert.ok(n, "handed to Pepe");
  assert.deepEqual([n.login, n.reveal.pad, n.viewers.length], ["frankiefettuccine", "S4 Room", 0]);
  assert.equal(JSON.stringify(n).includes("moddy") || JSON.stringify(n).includes("modcf"), false, "never who");
  await settle(50);
  const ib = await getQuery("SELECT kind, title, body, ref FROM inbox WHERE user_id = ?", [U.frankie.userId]);
  assert.equal(ib.length, 1, JSON.stringify(ib));
  assert.equal(ib[0].kind, "privacy");
  assert.equal(ib[0].title, "👁 Someone moderating S4 Room viewed your cam");
  assert.equal(ib[0].ref.includes(U.mod.userId), false, "the ref never carries the moderator's id");
  // a failed open: no frame by the dead-relay timeouts -> no_video, nobody told
  clean(); await fresh();
  const r2 = await reveal(U.adm, { member: entryOf("hankhidden").id });
  const S2 = LC.revealSess(ROOM.id, r2.d.rv);
  await LC.auth({ path: S2.path, query: "?pt=" + encodeURIComponent(pt(r2.d.whep)), ip: "1.2.3.4" }, "read", "webrtc");
  for (let i = 0; i < 3; i++) { T += 15000; await call("POST", `/api/rooms/${SLUG}/livecam/reveal/beat`, { user: U.adm, body: { rv: r2.d.rv } }); }
  LC.sweep(T);
  assert.equal(S2.endWhy, "no_video", JSON.stringify({ ended: S2.ended, created: S2.createdAt, T, liveAt: S2.liveAt, botLiveAt: S2.botLiveAt, botWhy: S2.botWhy,
                                                         viewers: [...S2.viewers.values()].map((v) => ({ beat: v.beat, until: v.until })) }));
  assert.equal(reveals().length, 0, "nobody told");
  const end = (await getQuery("SELECT end_reason FROM livecam_audit WHERE viewer_id = ? ORDER BY id DESC LIMIT 1", [U.adm.userId]))[0];
  assert.equal(end.end_reason, "no_video");
  // a ghost: logged ghost=1, nobody told - until they turn ghost off (the next beat)
  clean(); await fresh();
  await GH.set(U.staff.userId, true, { via: "web" });
  const r3 = await reveal(U.staff, { member: fe.id });
  assert.equal(r3.d.ghost, true);
  const S3 = LC.revealSess(ROOM.id, r3.d.rv);
  await LC.auth({ path: S3.path, query: "?pt=" + encodeURIComponent(pt(r3.d.whep)), ip: "1.2.3.4" }, "read", "webrtc");
  LC.noteSync([{ name: S3.path, ready: true, readers: [] }], T);
  assert.equal(reveals().length, 0, "a ghost: nobody told");
  assert.equal((await getQuery("SELECT ghost FROM livecam_audit ORDER BY id DESC LIMIT 1"))[0].ghost, 1);
  assert.equal((await getQuery("SELECT ref FROM seethrough_log WHERE scope = 'cam_reveal' ORDER BY id DESC LIMIT 1"))[0].ref, "cam:" + r3.d.rv + ":g");
  await GH.set(U.staff.userId, false, { via: "web" });
  await call("POST", `/api/rooms/${SLUG}/livecam/reveal/beat`, { user: U.staff, body: { rv: r3.d.rv } });
  assert.equal(reveals().length, 1, "ghost off mid-view: told then");
});

// ── limits ──
test("limits: one open each, 10 s between, 3 minutes each, Extend logged; a beat re-checks the right and the hiding", async () => {
  await setup;
  clean(); await fresh();
  const hank = entryOf("hankhidden").id, fe = entryOf("frankiefettuccine").id;
  const a = await reveal(U.adm, { member: hank });
  assert.equal(a.status, 200, a.text);
  const b = await reveal(U.adm, { member: fe });
  assert.equal(b.d.code, "one_open", "one open reveal per moderator");
  // a second moderator joins the same session (their own rows)
  const c = await reveal(U.staff, { member: hank });
  assert.equal(c.d.rv, a.d.rv, "one session per person");
  await call("POST", `/api/rooms/${SLUG}/livecam/reveal/stop`, { user: U.adm, body: { rv: a.d.rv } });
  assert.equal(LC.revealSess(ROOM.id, a.d.rv).ended, 0, "the other moderator keeps it");
  const d = await reveal(U.adm, { member: fe });
  assert.equal(d.status, 429, "10 s between reveals: " + d.text);
  // 3 minutes, Extend writes new rows
  const n0 = (await getQuery("SELECT COUNT(*) AS n FROM seethrough_log WHERE scope = 'cam_reveal'"))[0].n;
  for (let i = 0; i < 8; i++) { T += 15000; await call("POST", `/api/rooms/${SLUG}/livecam/reveal/beat`, { user: U.staff, body: { rv: a.d.rv } }); }
  const x = await call("POST", `/api/rooms/${SLUG}/livecam/reveal/extend`, { user: U.staff, body: { rv: a.d.rv, reason: "still checking" } });
  assert.equal(x.status, 200, x.text);
  assert.equal(x.d.until, T + LC.REVEAL_MS);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM seethrough_log WHERE scope = 'cam_reveal'"))[0].n, n0 + 1);
  assert.equal((await getQuery("SELECT ref FROM seethrough_log WHERE scope = 'cam_reveal' ORDER BY id DESC LIMIT 1"))[0].ref, "cam:" + a.d.rv + ":x");
  T += LC.REVEAL_MS + 1000;
  await fresh();
  const bt = await call("POST", `/api/rooms/${SLUG}/livecam/reveal/beat`, { user: U.staff, body: { rv: a.d.rv } });
  assert.deepEqual([bt.d.state, bt.d.why], ["ended", "gone"], "past its beat window / cap: " + bt.text);
  // the beat re-checks: a mod who loses their caps, a named cam that becomes visible
  clean(); await fresh();
  const m = await reveal(U.mod, { login: "alicecf" });
  assert.equal(m.status, 200, m.text);
  MODCAPS.modcf = null;
  try {
    R0().mod = { };
    const lb = await call("POST", `/api/rooms/${SLUG}/livecam/reveal/beat`, { user: U.mod, body: { rv: m.d.rv } });
    assert.deepEqual([lb.d.state, lb.d.why], ["ended", "lost_right"]);
  } finally { MODCAPS.modcf = { actions: ["kick", "ban"], on: true, roles: [] }; await fresh(); }
  RL._hits.clear();
  const o = await reveal(U.own, { login: "alicecf" });
  assert.equal(o.status, 200, o.text);
  await LC.setOptout("alicecf", false, { via: "web", ts: T });
  const vb = await call("POST", `/api/rooms/${SLUG}/livecam/reveal/beat`, { user: U.own, body: { rv: o.d.rv } });
  assert.deepEqual([vb.d.state, vb.d.why], ["ended", "visible"], "visible now - use ▶ Live");
  await LC.setOptout("alicecf", true, { via: "web", ts: T + 1 });
});

// ── the pad's switches, the switch ──
test("Q13: the pad's own switches stand; the switch off ends every reveal at once", async () => {
  await setup;
  clean(); await fresh();
  const r = await reveal(U.adm, { member: entryOf("hankhidden").id });
  assert.equal(r.status, 200, r.text);
  R0().livecams = false;
  await LC.forBot({ cap: true, mf: 1, live: [] }, T);
  assert.equal(LC.revealSess(ROOM.id, r.d.rv).endWhy, "room_off");
  RL._hits.clear();
  const no = await reveal(U.staff, { member: entryOf("hankhidden").id });
  assert.equal(no.d.code, "room_off");
  clean(); await fresh();
  const r2 = await reveal(U.adm, { member: entryOf("hankhidden").id });
  await CR.setOn(false, ADM());
  assert.equal(LC.revealSess(ROOM.id, r2.d.rv).endWhy, "switched_off");
  assert.equal((await reveal(U.adm, { member: entryOf("hankhidden").id })).status, 404);
  await CR.setOn(true, ADM());
});

// ── pages, admin views ──
test("pages: a member's /live carries nothing new; a moderator's carries cv: 1 + livecams.reveal - never a login or a veiled on_cam", async () => {
  await setup;
  clean(); await fresh();
  const m = await live(U.mem);
  assert.equal(m.status, 200);
  assert.equal(m.text.includes("\"cv\""), false, "no cv flag for a member");
  assert.equal(m.d.room.livecams && m.d.room.livecams.reveal, undefined);
  assert.deepEqual(leaks(m.text), []);
  for (const u of [U.mod, U.own, U.staff, U.adm]) {
    const r = await live(u);
    assert.deepEqual(leaks(r.text), [], u.username + ": " + leaks(r.text).join(", "));
    const frogs = r.d.members.filter((x) => x.anon);
    assert.ok(frogs.length >= 2 && frogs.every((x) => x.cv === 1 && x.on_cam === undefined && !x.login), u.username + ": " + JSON.stringify(frogs));
    assert.equal(r.d.room.livecams.reveal, 1, u.username);
  }
  // the switch's off: nothing at all
  WORD = false; CR.noteBot({}, T);
  const off = await live(U.adm);
  assert.equal(off.text.includes("\"cv\""), false, "not in effect: no flags");
  WORD = true; await fresh();
});
test("admin views: a veiled reveal by its label - never the login; ghost views too", async () => {
  await setup;
  clean(); await fresh();
  await GH.set(U.adm.userId, true, { via: "web" });
  let r;
  try { r = await reveal(U.adm, { member: entryOf("hankhidden").id }); } finally { await GH.set(U.adm.userId, false, { via: "web" }); }
  assert.equal(r.status, 200, r.text);
  const v = await LC.adminView();
  const s = v.sessions.find((x) => x.reveal);
  assert.ok(s && s.login === null && s.key === "rv:" + r.d.rv && s.display === entryOf("hankhidden").alias + " (veiled)", JSON.stringify(s));
  const row = v.recent.find((x) => x.reveal);
  assert.equal(row.target, entryOf("hankhidden").alias + " (veiled)");
  assert.equal(JSON.stringify(v).includes("hankhidden"), false, "nowhere on the page's data: " + JSON.stringify(v).slice(0, 400));
  const end = await call("POST", "/api/admin/pepe/livecams/end", { user: U.adm, body: { key: "rv:" + r.d.rv } });
  assert.equal(end.status, 200, end.text);
  assert.equal(LC.revealSess(ROOM.id, r.d.rv).endWhy, "ended_by_admin");
  assert.equal((await call("POST", "/api/admin/pepe/livecams/end", { user: U.adm, body: { key: ROOM.id + "|hankhidden:rv:" + r.d.rv } })).status, 404, "never by its inner key");
});

// ── evidence ──
test("evidence: admins / the pad's owner, while viewing; one transaction; served privately; 30 days; holds", async () => {
  await setup;
  clean(); await fresh();
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
  CE._setDeps({ capture: async (S, kind) => (kind === "still" ? JPEG : Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(200)])) });
  const r = await reveal(U.own, { login: "alicecf" });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.can_save, false, "evidence clips off: no save");
  const ev = (u, b) => call("POST", `/api/rooms/${SLUG}/livecam/reveal/evidence`, { user: u, body: Object.assign({ rv: r.d.rv, kind: "still", reason: "evidence of a report" }, b || {}) });
  assert.equal((await ev(U.own)).d.code, "off");
  await EV.init();
  await EV.setOn(true, ADM());
  const S = LC.revealSess(ROOM.id, r.d.rv);
  assert.equal((await ev(U.own)).d.code, "not_live", "nothing showing yet");
  LC.noteSync([{ name: S.path, ready: true, readers: [] }], T);
  const ok = await ev(U.own);
  assert.equal(ok.status, 200, ok.text);
  const row = (await getQuery("SELECT * FROM cam_evidence WHERE id = ?", [ok.d.id]))[0];
  assert.deepEqual([row.subject_login, row.kind, row.role, row.veil, row.expires_at - row.created], ["alicecf", "still", "owner", "named", CE.KEEP_MS]);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM seethrough_log WHERE scope = 'cam_evidence_save' AND ref = ?", ["cev:" + ok.d.id]))[0].n, 1);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'evidence.cam_save'"))[0].n, 1);
  // staff and mods view, never keep
  const st = await reveal(U.staff, { login: "alicecf" });
  assert.equal(st.d.can_save, false);
  RL._hits.clear();
  assert.equal((await ev(U.staff, { rv: st.d.rv })).d.code, "not_entitled");
  // listed and served: admins every pad, the owner their pad; a member never
  const la = await call("GET", "/api/evidence/cam", { user: U.adm });
  assert.equal(la.d.rows.length, 1);
  const lo = await call("GET", `/api/evidence/cam?room=${SLUG}`, { user: U.own });
  assert.equal(lo.d.rows.length, 1, lo.text);
  assert.equal((await call("GET", `/api/evidence/cam?room=${SLUG}`, { user: U.mem })).status, 403);
  const f = await call("GET", la.d.rows[0].file, { user: U.own });
  assert.equal(f.status, 200);
  assert.equal(f.headers["content-type"], "image/jpeg");
  assert.match(f.headers["cache-control"], /no-store/);
  assert.equal(f.buf.length, JPEG.length);
  assert.equal((await call("GET", la.d.rows[0].file + "?dl=1", { user: U.own })).status, 403, "download: admins only");
  assert.equal((await call("GET", la.d.rows[0].file, { user: U.mem })).status, 404);
  // a hold keeps it past 30 days; without one the sweep deletes row then file
  const h = await call("POST", `/api/evidence/cam/${ok.d.id}/hold`, { user: U.adm, body: { on: true, why: "legal request" } });
  assert.equal(h.status, 200, h.text);
  let sw = await CE.sweep(T + CE.KEEP_MS + 1);
  assert.equal(sw.deleted, 0);
  await call("POST", `/api/evidence/cam/${ok.d.id}/hold`, { user: U.adm, body: { on: false, why: "released" } });
  sw = await CE.sweep(T + CE.KEEP_MS + 1);
  assert.equal(sw.deleted, 1);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM cam_evidence"))[0].n, 0);
  await EV.setOn(false, ADM());
});

test("the client: cam-reveal.js is loaded on demand, text only, blurred, no capture controls; the stage and the people list call it", () => {
  const js = fs.readFileSync(path.join(repo, "public", "js", "cam-reveal.js"), "utf8");
  assert.doesNotMatch(js, /innerHTML/);
  assert.match(js, /disablePictureInPicture = true/);
  assert.match(js, /controlslist', 'nodownload/);
  assert.match(js, /filter:blur\(28px\)/);
  assert.match(js, /Only you can see this · logged/);
  const plc = fs.readFileSync(path.join(repo, "public", "js", "pad-livecam.js"), "utf8");
  assert.match(plc, /sc\.src = '\/public\/js\/cam-reveal\.js\?v=1'/);
  const room = fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8");
  assert.doesNotMatch(room, /cam-reveal\.js/, "never on the pad page by itself (a page with reveals off never loads it)");
  assert.match(room, /u\.cv === 1 && u\.anon && u\.id/);
  assert.match(fs.readFileSync(path.join(repo, "public", "js", "stage-mic.js"), "utf8"), /t\.s\.cv === 1/);
});

// ── the people list's own name Reveal (spec 3.1 "NEW roster_line") ──
test("roster Reveal: rvm for an admin / the pad's owner; {member} -> who, logged roster_line; a member 403; the switch off -> as before", async () => {
  await setup;
  clean(); await fresh();
  const m = await live(U.mem);
  assert.equal(m.text.includes("\"rvm\""), false, "a member: no flag");
  const a = await live(U.adm);
  const frogs = a.d.members.filter((x) => x.anon && x.alias);
  assert.ok(frogs.length >= 2 && frogs.every((x) => x.rvm === 1), JSON.stringify(frogs));
  const st = await live(U.staff);
  assert.equal(st.text.includes("\"rvm\""), false, "staff: never a name (J-2)");
  const id = entryOf("hankhidden").id;
  const r = await call("POST", "/api/chatlog/reveal", { user: U.own, body: { room: SLUG, member: id, reason: "a report" } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.d.member, r.d.login], [id, "hankhidden"]);
  const row = (await getQuery("SELECT role, scope, logins, ref FROM seethrough_log ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual([row.role, row.scope, JSON.parse(row.logins), row.ref], ["owner", "roster_line", ["hankhidden"], "member:" + id]);
  assert.equal((await call("POST", "/api/chatlog/reveal", { user: U.mem, body: { room: SLUG, member: id } })).status, 403);
  assert.equal((await call("POST", "/api/chatlog/reveal", { user: U.adm, body: { room: SLUG, member: "v-AAAAAAAAAAAA" } })).status, 404);
  await CR.setOn(false, ADM());
  try {
    const off = await call("POST", "/api/chatlog/reveal", { user: U.own, body: { room: SLUG, member: id } });
    assert.equal(off.status, 200, off.text);
    assert.deepEqual([off.d.items, off.d.refused], [[], []], "switch off: `member` is ignored, exactly as before");
    assert.equal((await live(U.adm)).text.includes("\"rvm\""), false);
  } finally { await CR.setOn(true, ADM()); }
});
