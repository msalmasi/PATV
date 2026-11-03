// 1.99?? (privacy controls, review fixes 2 - the reveal lens; G:/ops/privacy-controls-spec-2026-11-02.md section 8, Q8 / Q9: every
// reveal, the ghost bypass included, goes "behind the reveal audit log"). On the reveal review harness (privm-review-reveal.test.js):
//   RV-A  a 👻 ghost's SNAPSHOT / CLIP past someone's rules (a veiled cam always, a named one while cam reveals are in effect) asks why
//         first (409 reason_needed) and writes its see-through row before any job; it never reads a frame it didn't ask for; with cam
//         reveals off a named one is as before
//   RV-B  a NAMED person whose mic hold shows a frog name (veiled_hold): only a role that may reveal who is behind a frog name gets
//         their cam - refused to a mod without one, before any row
//   RV-C  a by-login reveal session is never joined from a pad - refused before any row or rate (round 3 - F4: unless the pad role may
//         hold it itself - the person is listed in the room; privm-review3-bylogin.test.js)
//   node --test test/privm-review2-reveal.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privm-review2-rv-"));
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

// ───────────────────── review fixes 2: the reveal lens ─────────────────────
const IC = require(path.join(repo, "incogcams"));
const CC = require(path.join(repo, "camclip"));
const TRV = require(path.join(repo, "textreveal"));
const stRows = async (uid, like = "%") => (await getQuery("SELECT COUNT(*) AS n FROM seethrough_log WHERE user_id = ? AND ref LIKE ?", [uid, like]))[0].n;
const snapJobs = (login) => [...RL._jobs.values()].filter((j) => j.kind === "snap" && j.target === login && j.state !== "done").length;

test("RV-A: a 👻 ghost's SNAPSHOT of a frog-name cam past live cam off asks why first and is logged before any job (a member is refused as before)", async () => {
  await ready;
  clean(); await fresh();
  await IC.init();
  await IC.setOn(true, ADM());
  IC.noteBot({ incogcam: 1 }, T);
  await syncAt({ rooms: [v2Room()] });
  await fresh(); IC.noteBot({ incogcam: 1 }, T);
  await LC.setOptout("frankiefettuccine", true, { via: "web", ts: T });
  await GH.set(U.staff.userId, true, { via: "web" });
  try {
    const fe = entryOf("frankiefettuccine");
    assert.ok(IC.camOf(R0(), fe.id, T), "the frog cam by its id");
    const n0 = await stRows(U.staff.userId), j0 = snapJobs("frankiefettuccine");
    const s1 = await call("POST", `/api/rooms/${SLUG}/snap`, { user: U.staff, body: { id: fe.id } });
    assert.deepEqual([s1.status, s1.d.code, s1.d.reason_needed], [409, "reason_needed", true], s1.text);
    assert.equal(await stRows(U.staff.userId), n0, "nothing logged");
    assert.equal(snapJobs("frankiefettuccine"), j0, "no job queued");
    const s2 = await call("POST", `/api/rooms/${SLUG}/snap`, { user: U.staff, body: { id: fe.id, reason: "checking a report" } });
    assert.equal(s2.status, 200, s2.text);
    assert.equal(await stRows(U.staff.userId, "ghost-snap:%:g"), 1, "one see-through row (scope cam_reveal, ghost-snap)");
    const row = (await getQuery("SELECT scope, reason, logins FROM seethrough_log WHERE user_id = ? AND ref LIKE 'ghost-snap:%' ORDER BY id DESC LIMIT 1", [U.staff.userId]))[0];
    assert.deepEqual([row.scope, row.reason], ["cam_reveal", "checking a report"]);
    assert.equal(s2.text.includes("frankiefettuccine"), false, "the answer never names them");
    const sm = await call("POST", `/api/rooms/${SLUG}/snap`, { user: U.mem, body: { id: fe.id } });
    assert.equal(sm.status, 403, "a member: refused as before - " + sm.text);
  } finally {
    await GH.set(U.staff.userId, false, { via: "web" });
    await LC.setOptout("frankiefettuccine", false, { via: "web", ts: T + 2 });
    await IC.setOn(false, ADM());
    clean();
  }
});

test("RV-A: a 👻 ghost's snapshot / clip of a NAMED cam past live cam off - a reason + the log while cam reveals are in effect; with them off, as before", async () => {
  await ready;
  clean(); T += 61000; await fresh(); RL._hits.clear();
  CC._setDeps({ snapSwitch: () => true, clipSwitch: () => true });
  await GH.set(U.staff.userId, true, { via: "web" });
  try {
    assert.equal(CR.effective(T), true, "cam reveals in effect");
    const n0 = await stRows(U.staff.userId);
    const s1 = await call("POST", `/api/rooms/${SLUG}/snap`, { user: U.staff, body: { login: "alicecf" } });
    assert.deepEqual([s1.status, s1.d.code], [409, "reason_needed"], s1.text);
    assert.equal(await stRows(U.staff.userId), n0);
    const s2 = await call("POST", `/api/rooms/${SLUG}/snap`, { user: U.staff, body: { login: "alicecf", reason: "a report on alice" } });
    assert.equal(s2.status, 200, s2.text);
    assert.equal(await stRows(U.staff.userId), n0 + 1);
    // 🎬 a clip the same way
    const c1 = await call("POST", `/api/rooms/${SLUG}/camclip`, { user: U.staff, body: { login: "alicecf", secs: 10 } });
    assert.deepEqual([c1.status, c1.d.code], [409, "reason_needed"], c1.text);
    assert.equal(await stRows(U.staff.userId), n0 + 1, "the refused clip logged nothing");
    const c2 = await call("POST", `/api/rooms/${SLUG}/camclip`, { user: U.staff, body: { login: "alicecf", secs: 10, reason: "a report on alice" } });
    assert.equal(c2.status, 200, c2.text);
    assert.equal(await stRows(U.staff.userId, "ghost-clip:%:g"), 1, "the clip's own row");
    // cam reveals off: a named ghost capture is as before (no reason, no new row)
    WORD = false; await fresh(); RL._hits.clear(); T += 61000;
    const n1 = await stRows(U.staff.userId);
    for (const j of [...RL._jobs.values()]) if (j.target === "alicecf") RL._jobs.delete(j.id);
    const s3 = await call("POST", `/api/rooms/${SLUG}/snap`, { user: U.staff, body: { login: "alicecf" } });
    assert.equal(s3.status, 200, "switch off: today's ghost snapshot - " + s3.text);
    assert.equal(await stRows(U.staff.userId), n1);
  } finally {
    WORD = true; await fresh();
    await GH.set(U.staff.userId, false, { via: "web" });
    clean();
  }
});

test("RV-A: a 👻 ghost never reads a frame someone else asked for past the person's rules - only after its own logged request", async () => {
  await ready;
  clean(); T += 61000; await fresh();
  for (const j of [...RL._jobs.values()]) if (j.target === "alicecf") RL._jobs.delete(j.id);     // (no request of the staff member's own left)
  await GH.set(U.staff.userId, true, { via: "web" });
  try {
    // a fresh frame of alice (live cam off) that the member asked for earlier (before she switched it off, say)
    RL._snaps.set(ROOM.id + "|alicecf", { sid: "f" + "ab".repeat(9), ts: Date.now(), ok: true, status: "", img: JPEG, viewers: new Set([U.mem.userId]),
                                          rule: null, okFor: new Map(), cost: 0, saves: new Map(), login: "alicecf", vkey: null, valias: null });
    const g = await call("GET", `/api/rooms/${SLUG}/snap/alicecf`, { user: U.staff });
    assert.equal(g.status, 200);
    assert.equal(g.d.state, "refused", "no frame without the ghost's own logged request: " + g.text.slice(0, 200));
    assert.equal(g.d.img == null, true);
    // its own request (reason, logged) joins that frame
    const p = await call("POST", `/api/rooms/${SLUG}/snap`, { user: U.staff, body: { login: "alicecf", reason: "a report on alice" } });
    assert.equal(p.status, 200, p.text);
    const g2 = await call("GET", `/api/rooms/${SLUG}/snap/alicecf`, { user: U.staff });
    assert.equal(g2.d.state, "ok", g2.text.slice(0, 200));
  } finally {
    RL._snaps.delete(ROOM.id + "|alicecf");
    await GH.set(U.staff.userId, false, { via: "web" });
    clean();
  }
});

test("RV-B: a mod with no name-reveal right can't cam-reveal a NAMED person whose mic hold still shows a frog name (veiled_hold) - refused before any row; with text reveal roles on they can", async () => {
  await ready;
  clean(); T += 11000; await fresh();
  await IC.setOn(true, ADM());
  IC.noteBot({ incogcam: 1 }, T);
  await syncAt({ rooms: [v2Room()] });
  await fresh(); IC.noteBot({ incogcam: 1 }, T);
  await TRV.init();
  try {
    const R = R0();
    R.mic = (R.mic || []).concat([{ anon: true, alias: "Soggy Bullfrog", _vz: { login: "bobcf", kind: "incognito", display: "Bob" } }]);
    assert.equal(IC.veiledPresence(R, "bobcf"), true, "bob's hold shows a frog name");
    assert.equal(await CR.withheldWhy(R, { login: "bobcf", kind: "named" }, U.mod.userId), "veiled_hold");
    const n0 = await stRows(U.mod.userId);
    const r = await reveal(U.mod, { login: "bobcf", reason: "check bob" });
    assert.deepEqual([r.status, r.d.code], [409, "unavailable"], r.text);
    assert.equal(r.text.includes("bobcf") || r.text.includes("Soggy"), false, "the refusal names nobody");
    assert.equal(await stRows(U.mod.userId), n0, "no row, no rate spent");
    // text reveal roles on: the room's mods may reveal who is behind a frog name - the reveal goes ahead
    await TRV.setOn(true, ADM());
    try {
      R.mic = (R.mic || []).filter((x) => !(x._vz && x._vz.login === "bobcf")).concat([{ anon: true, alias: "Soggy Bullfrog", _vz: { login: "bobcf", kind: "incognito", display: "Bob" } }]);
      const r2 = await reveal(U.mod, { login: "bobcf", reason: "check bob" });
      assert.equal(r2.status, 200, r2.text);
      if (r2.d && r2.d.rv) await stopRv(U.mod, r2.d.rv);
    } finally { await TRV.setOn(false, ADM()); }
  } finally { await IC.setOn(false, ADM()); clean(); }
});

test("RV-C: a by-login reveal session of a login the room doesn't list is the admin's alone - a pad mod's reveal is refused before any reveal row", async () => {
  await ready;
  clean(); T += 11000; await fresh(); RL._hits.clear();
  // (round 3 - F4: a pad mod may join a by-login session of someone the room LISTS - they may open one by login themselves,
  // privm-review3-bylogin.test.js; this session is of a login the room has no entry for)
  const a = await call("POST", "/api/admin/pepe/livecams/reveal", { user: U.adm, body: { room: SLUG, login: "nobodycf", reason: "report by login" } });
  assert.equal(a.status, 200, a.text);
  try {
    const n0 = await stRows(U.mod.userId, "cam:%"), x0 = await stRows(U.mod.userId, "miss:gone:l");
    const la0 = (await getQuery("SELECT COUNT(*) AS n FROM livecam_audit WHERE viewer_id = ?", [U.mod.userId]))[0].n;
    const m = await call("POST", `/api/rooms/${SLUG}/livecam/reveal`, { user: U.mod, body: { login: "nobodycf", bylogin: true, reason: "check them" } });
    assert.deepEqual([m.status, m.d.code], [404, "gone"], m.text);
    assert.equal(m.d.rv, undefined, "never the admin's session");
    assert.equal(await stRows(U.mod.userId, "cam:%"), n0, "no reveal row");
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM livecam_audit WHERE viewer_id = ?", [U.mod.userId]))[0].n, la0, "no livecam_audit row");
    // (1.99?? round 4 - F4 probing: a by-login try by a non-admin spends the reveal rate and a miss is a see-through row, miss:gone:l -
    // privm-review4.test.js)
    assert.equal(await stRows(U.mod.userId, "miss:gone:l"), x0 + 1, "the miss is logged");
    assert.equal(RL._hits.has("camreveal|" + U.mod.userId), true, "the try spent the rate");
  } finally { if (a.d && a.d.rv) await stopRv(U.adm, a.d.rv); clean(); }
});
