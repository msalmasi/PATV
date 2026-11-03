// 1.99?? (privacy controls, round 4 - the round-3 verify's findings; G:/ops/privacy-controls-spec-2026-11-02.md section 8, owner Q8 / Q12 /
// Q22). On the reveal review harness (privm-review3-bylogin.test.js, verbatim):
//   F4 UX       camreveal.start's can_save asks camevidence's own rule for that session: a pad's owner on a session opened by login (admins
//               only) is never offered "Save still / clip" that camevidence then refuses (403); their other reveals still are
//   F4 probing  every by-login try by a non-admin (staff, a pad's owner, a room mod) spends the reveal rate up front, hit or miss, and a
//               refused one is a see-through row (scope cam_reveal, ref miss:<code>:l, the typed login - admins read it, nobody else),
//               written before the answer; the 404 / 409 say exactly what they said before; admins as before
//   wording     /privacy names who can use ghost mode the same way in every sentence (ghost.mode: Staff and up - administrators or staff);
//               the S4t admin card names the mic-stage report queue's reveal for staff
//   node --test test/privm-review4.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privm-review4-"));
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

const stRows = async (uid, like = "%") => (await getQuery("SELECT COUNT(*) AS n FROM seethrough_log WHERE user_id = ? AND ref LIKE ?", [uid, like]))[0].n;
const byAdmin = (user, login, reason = "a report names them") => call("POST", "/api/admin/pepe/livecams/reveal", { user, body: { room: SLUG, login, reason } });
const byPad = (user, login, reason = "a report names them") => call("POST", `/api/rooms/${SLUG}/livecam/reveal`, { user, body: { login, bylogin: true, reason } });
const auditRows = async (uid) => (await getQuery("SELECT COUNT(*) AS n FROM livecam_audit WHERE viewer_id = ?", [uid]))[0].n;
const viewRows = async (uid) => (await getQuery("SELECT COUNT(*) AS n FROM cam_views WHERE user_id = ?", [uid]))[0].n;
const lastMiss = async (uid) => (await getQuery("SELECT role, scope, room_id, logins, reason, ref FROM seethrough_log WHERE user_id = ? AND ref LIKE 'miss:%' ORDER BY id DESC LIMIT 1", [uid]))[0];
const rateHits = (uid) => (RL._hits.get("camreveal|" + uid) || []).length;
const saveEv = (user, rv) => call("POST", `/api/rooms/${SLUG}/livecam/reveal/evidence`, { user, body: { rv, kind: "still", reason: "evidence of a report" } });

// ───────────────────── round 4: F4 probing - by-login misses are throttled and logged ─────────────────────
test("R4 F4 probing: a pad owner's / mod's by-login miss spends the reveal rate and is a see-through row (miss:gone:l) - the 404 as before", async () => {
  await ready;
  for (const [k, u, role] of [["own", U.own, "owner"], ["mod", U.mod, "mod"]]) {
    clean(); T += 11000; await fresh(); RL._hits.clear();
    const n0 = await stRows(u.userId, "miss:%"), a0 = await auditRows(u.userId), v0 = await viewRows(u.userId), all0 = await stRows(u.userId);
    const x = await byPad(u, "nobodycf");
    assert.deepEqual([x.status, x.d.code, x.d.error], [404, "gone", CR.MSG.gone], k + ": " + x.text);
    assert.equal(rateHits(u.userId), 1, k + ": the reveal rate is spent");                                                  // (round 3: 0)
    assert.equal(await stRows(u.userId, "miss:%"), n0 + 1, k + ": a see-through row");                                    // (round 3: none)
    assert.equal(await stRows(u.userId), all0 + 1, k + ": only that one");
    assert.deepEqual({ ...(await lastMiss(u.userId)) }, { role, scope: "cam_reveal", room_id: ROOM.id, logins: JSON.stringify(["nobodycf"]),
                                                        reason: "a report names them", ref: "miss:gone:l" });
    assert.equal(await auditRows(u.userId), a0, k + ": no livecam_audit row (that list shows logins to the livecams page's staff)");
    assert.equal(await viewRows(u.userId), v0, k + ": no cam_views row - nothing reaches the person");
    // the next try at once: throttled like any reveal (round 3: unthrottled, so logins could be tested one after another)
    const y = await byPad(u, "nobody2cf");
    assert.equal(y.status, 429, k + ": " + y.text);
    assert.equal(await stRows(u.userId, "miss:%"), n0 + 1, k + ": a throttled try opens and logs nothing");
  }
});

test("R4 F4 probing: a typed login listed under a frog name (no name-reveal right) - 409 as before, rate spent, a miss row; staff on the admin page too", async () => {
  await ready;
  clean(); T += 11000; await fresh(); RL._hits.clear();
  const m = await byPad(U.mod, "frankiefettuccine");
  assert.deepEqual([m.status, m.d.code, m.d.error], [409, "unavailable", CR.MSG.held], m.text);
  assert.equal(rateHits(U.mod.userId), 1);
  assert.deepEqual({ ...(await lastMiss(U.mod.userId)) }, { role: "mod", scope: "cam_reveal", room_id: ROOM.id, logins: JSON.stringify(["frankiefettuccine"]),
                                                          reason: "a report names them", ref: "miss:unavailable:l" });
  assert.equal(m.text.includes("frankie") || m.text.includes("Frankie"), false, "the answer still names nobody");
  clean(); T += 11000; await fresh(); RL._hits.clear();
  const s = await byAdmin(U.staff, "hankhidden");
  assert.deepEqual([s.status, s.d.code], [409, "unavailable"], s.text);
  assert.equal(rateHits(U.staff.userId), 1, "staff: the rate is spent");
  const r = await lastMiss(U.staff.userId);
  assert.deepEqual([r.role, r.ref, r.logins], ["staff", "miss:unavailable:l", JSON.stringify(["hankhidden"])]);
  // the miss rows are the admins' to read - /api/admin/seethrough: staff 403, an admin sees the typed logins
  assert.equal((await call("GET", "/api/admin/seethrough", { user: U.staff })).status, 403);
  const al = await call("GET", "/api/admin/seethrough", { user: U.adm });
  assert.equal(al.status, 200, al.text);
  assert.ok(al.d.rows.some((x) => x.ref === "miss:unavailable:l" && x.logins.includes("hankhidden")), "an admin sees the miss");
  clean();
});

test("R4 F4 probing: a hit spends the rate once and writes the usual rows (no miss row); an admin's refused try is as before - no rate, no row", async () => {
  await ready;
  clean(); T += 11000; await fresh(); RL._hits.clear();
  const n0 = await stRows(U.own.userId, "miss:%"), l0 = await stRows(U.own.userId, "cam:%:l");
  const h = await byPad(U.own, "zeldaforgot");
  assert.equal(h.status, 200, h.text);
  try {
    assert.equal(rateHits(U.own.userId), 1, "one rate hit for the try that opened it");
    assert.equal(await stRows(U.own.userId, "cam:%:l"), l0 + 1, "the reveal's own row");
    assert.equal(await stRows(U.own.userId, "miss:%"), n0, "no miss row");
  } finally { await stopRv(U.own, h.d.rv); clean(); }
  // an admin by login: a named, visible person - 409 visible, nothing spent or written (admins keep today's path)
  clean(); T += 11000; await fresh(); RL._hits.clear();
  const a0 = await stRows(U.adm.userId);
  const ad = await byAdmin(U.adm, "bobcf");
  assert.deepEqual([ad.status, ad.d.code], [409, "visible"], ad.text);
  assert.equal(rateHits(U.adm.userId), 0);
  assert.equal(await stRows(U.adm.userId), a0);
  // the pad's tile / frog-entry / named reveals (not by login): as before - a refused one spends nothing and writes nothing
  clean(); T += 11000; await fresh(); RL._hits.clear();
  const m0 = await stRows(U.mod.userId);
  const v = await reveal(U.mod, { login: "bobcf" });
  assert.deepEqual([v.status, v.d.code], [409, "visible"], v.text);
  assert.equal(rateHits(U.mod.userId), 0);
  assert.equal(await stRows(U.mod.userId), m0);
  clean();
});

test("R4 F4 probing: /admin/bridge's see-through card says what a miss row is", () => {
  const br = fs.readFileSync(path.join(repo, "views", "admin", "bridge.ejs"), "utf8");
  assert.ok(br.includes("a ref <code>miss:&lt;code&gt;:l</code> is a by-login try by staff, a pad's owner or a room moderator that opened nothing"), "the see-through card names the miss rows");
});

