// 1.99?? (privacy controls, round 3 - the final verify's F4; G:/ops/privacy-controls-spec-2026-11-02.md section 8, owner Q8: pad owners,
// staff and mods can reveal hidden cams too; Q22: a left-out person's cam by login). /privacy said a left-out person's cam can be viewed
// by "PATV administrators and staff", but the by-login entry needed livecam.admin (Staff: 403 "Admins only."). Now the by-login entry
// takes the same reveal roles: staff (and admins) on any pad; a pad's owner and the room's mods on their own pad, only for someone the
// room lists now (named, under a frog name, or left out) - audited and rate-limited like every reveal, refused before any row otherwise.
// Someone listed under a frog name needs a right to reveal who is behind it (one reveal session per person: opening it by login and by
// the frog entry would pair the two). RV-C follows: a pad mod may join a by-login session of someone the room lists. The pad page offers
// the entry to its moderators. On the reveal review harness (privm-review2-reveal.test.js, verbatim).
//   node --test test/privm-review3-bylogin.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privm-review3-bl-"));
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


// ───────────────────── round 3: F4 - the by-login entry takes every reveal role ─────────────────────
const byAdmin = (user, login, reason = "a report names them") => call("POST", "/api/admin/pepe/livecams/reveal", { user, body: { room: SLUG, login, reason } });
const byPad = (user, login, reason = "a report names them") => call("POST", `/api/rooms/${SLUG}/livecam/reveal`, { user, body: { login, bylogin: true, reason } });
const auditRows = async (uid) => (await getQuery("SELECT COUNT(*) AS n FROM livecam_audit WHERE viewer_id = ?", [uid]))[0].n;

test("F4: PATV staff use the by-login entry (no livecam.admin needed) - someone left out, audited and rate-limited like every reveal", async () => {
  await ready;
  clean(); T += 11000; await fresh(); RL._hits.clear();
  const n0 = await stRows(U.staff.userId, "%:l"), a0 = await auditRows(U.staff.userId);
  const r = await byAdmin(U.staff, "zeldaforgot");               // (before round 3: 403 "Admins only." - the page's livecam.admin)
  assert.equal(r.status, 200, r.text);
  try {
    assert.equal(r.d.role, "staff");
    assert.equal(r.d.name, "zeldaforgot", "it shows what they typed - no frog name");
    assert.equal(await stRows(U.staff.userId, "%:l"), n0 + 1, "a see-through row marked by login");
    assert.equal(await auditRows(U.staff.userId), a0 + 1, "a livecam_audit row");
    assert.equal(RL._hits.has("camreveal|" + U.staff.userId), true, "the reveal rate is spent");
  } finally { await stopRv(U.staff, r.d.rv); clean(); }
  // a member still gets the one 403
  const m = await byAdmin(U.mem, "zeldaforgot");
  assert.deepEqual([m.status, m.d.code], [403, "forbidden"], m.text);
});

test("F4: a pad's owner and the room's mods open a cam by its login on their own pad - only for someone the room lists; never a login that isn't there", async () => {
  await ready;
  for (const [k, u, role] of [["own", U.own, "owner"], ["mod", U.mod, "mod"]]) {
    clean(); T += 11000; await fresh(); RL._hits.clear();
    const r = await byPad(u, "zeldaforgot");                       // (left out - listed in the room's roster the site keeps, never shown)
    assert.equal(r.status, 200, k + ": " + r.text);
    assert.equal(r.d.role, role);
    assert.equal(r.d.name, "zeldaforgot");
    const S = LC.revealSess(ROOM.id, r.d.rv);
    assert.ok(S && S.rv.bylogin, k + ": a by-login session");
    assert.equal(await CR.stillMay(u.userId, S), true, k + ": MediaMTX's read hook lets them read it");
    const b = await call("POST", `/api/rooms/${SLUG}/livecam/reveal/beat`, { user: u, body: { rv: r.d.rv } });
    assert.notEqual(b.d && b.d.why, "lost_right", k + ": the beat keeps it: " + b.text);
    await stopRv(u, r.d.rv);
    // a login the room doesn't list: refused before any row or rate (Pepe would answer not_on_cam only after the rows)
    clean(); T += 11000; await fresh(); RL._hits.clear();
    const n0 = await stRows(u.userId), a0 = await auditRows(u.userId);
    const x = await byPad(u, "nobodycf");
    assert.deepEqual([x.status, x.d.code], [404, "gone"], k + ": " + x.text);
    assert.equal(await stRows(u.userId), n0, k + ": no see-through row");
    assert.equal(await auditRows(u.userId), a0, k + ": no livecam_audit row");
    assert.equal(RL._hits.has("camreveal|" + u.userId), false, k + ": no rate spent");
  }
  // staff / admins: a login the room doesn't list is Pepe's to answer (as for admins before)
  clean(); T += 11000; await fresh(); RL._hits.clear();
  const s = await byPad(U.staff, "nobodycf");
  assert.equal(s.status, 200, s.text);
  await stopRv(U.staff, s.d.rv); clean();
});

test("F4: by login, someone the room lists under a FROG NAME needs a right to reveal who is behind it (no pairing of login and frog session)", async () => {
  await ready;
  const TRV2 = require(path.join(repo, "textreveal"));
  await TRV2.init();
  clean(); T += 11000; await fresh(); RL._hits.clear();
  const n0 = await stRows(U.mod.userId);
  const m = await byPad(U.mod, "frankiefettuccine");             // (incognito; incognito cams off here: withheld)
  assert.deepEqual([m.status, m.d.code], [409, "unavailable"], m.text);
  assert.equal(m.text.includes("frankie") || m.text.includes("Frankie"), false, "the refusal names nobody");
  assert.equal(await stRows(U.mod.userId), n0, "no row");
  const s = await byAdmin(U.staff, "hankhidden");
  assert.deepEqual([s.status, s.d.code], [409, "unavailable"], "staff without a name-reveal right: the same - " + s.text);
  // the pad's owner may reveal names: the cam opens by the login they typed
  clean(); T += 11000; await fresh(); RL._hits.clear();
  const o = await byPad(U.own, "frankiefettuccine");
  assert.equal(o.status, 200, o.text);
  assert.equal(o.d.name, "frankiefettuccine", "what they typed");
  await stopRv(U.own, o.d.rv);
  // text reveal roles on: the room's mods may too
  await TRV2.setOn(true, ADM());
  try {
    clean(); T += 11000; await fresh(); RL._hits.clear();
    const m2 = await byPad(U.mod, "frankiefettuccine");
    assert.equal(m2.status, 200, m2.text);
    await stopRv(U.mod, m2.d.rv);
  } finally { await TRV2.setOn(false, ADM()); clean(); }
});

test("F4 + RV-C: a pad mod may join a by-login session of someone the room lists (their own right); one of a login it doesn't list stays the admin's", async () => {
  await ready;
  clean(); T += 11000; await fresh(); RL._hits.clear();
  const a = await byAdmin(U.adm, "alicecf", "report by login");
  assert.equal(a.status, 200, a.text);
  try {
    const m = await reveal(U.mod, { login: "alicecf", reason: "check alice" });
    assert.equal(m.status, 200, m.text);
    assert.equal(m.d.rv, a.d.rv, "they join the one session of that person");
    assert.equal(await CR.stillMay(U.mod.userId, LC.revealSess(ROOM.id, a.d.rv)), true);
    await stopRv(U.mod, m.d.rv);
  } finally { await stopRv(U.adm, a.d.rv); clean(); }
  // an admin's by-login session of a login the room doesn't list: a mod can't reach it (refused before any row or rate)
  clean(); T += 11000; await fresh(); RL._hits.clear();
  const b = await byAdmin(U.adm, "nobodycf", "report by login");
  assert.equal(b.status, 200, b.text);
  try {
    const n0 = await stRows(U.mod.userId);
    const m = await byPad(U.mod, "nobodycf");
    assert.deepEqual([m.status, m.d.code], [404, "gone"], m.text);
    assert.equal(m.d.rv, undefined, "never the admin's session");
    assert.equal(await stRows(U.mod.userId), n0, "no see-through row");
    assert.equal(RL._hits.has("camreveal|" + U.mod.userId), false, "no rate spent");
    assert.equal(await CR.stillMay(U.mod.userId, LC.revealSess(ROOM.id, b.d.rv)), false, "MediaMTX refuses a mod on it");
  } finally { await stopRv(U.adm, b.d.rv); clean(); }
});

test("F4: the pad page offers 'View a cam by Camfrog login' to its moderators (room.livecams.reveal) through cam-reveal.js's typed-login step", () => {
  const room = fs.readFileSync(path.join(repo, "views", "room.ejs"), "utf8");
  assert.match(room, /cvLogin\(!!\(liveCams && liveCams\.reveal === 1\)\)/, "shown only while this viewer may view hidden cams here");
  assert.match(room, /window\.PATVCamRevealOpen\(\{ slug: slug, ask: true \}\)/);
  const js = fs.readFileSync(path.join(repo, "public", "js", "cam-reveal.js"), "utf8");
  assert.match(js, /body\.login = typed; body\.bylogin = true;/, "the pad's by-login request");
  assert.match(fs.readFileSync(path.join(repo, "public", "js", "pad-livecam.js"), "utf8"), /cam-reveal\.js\?v=[2-9]/);
  assert.match(fs.readFileSync(path.join(repo, "views", "admin", "pepeLivecams.ejs"), "utf8"), /cam-reveal\.js\?v=[2-9]/);
});

// ── F4: the words ──
const ejs = require("ejs");
const TERMS = require(path.join(repo, "terms"));
const PFN = path.join(repo, "views", "privacy.ejs");
const stripTags = (h) => h.replace(/<[^>]+>/g, "").replace(/&#39;/g, "'").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
function privacyPage(extra) {
  const L0 = { user: null, title: "Privacy Policy", VERSION: TERMS.VERSION, UPDATED: TERMS.PRIVACY_UPDATED, enforced: false, chatlog: null,
               hubErasure: null, micrec: null, memory: null, privwire: { on: true, g: D, g_day: "28 October 2026" }, evidence: null,
               policyDates: {}, ogBase: "http://test" };
  return ejs.render(fs.readFileSync(PFN, "utf8"), Object.assign(L0, extra || {}), { filename: PFN });
}

test("F4: who may open a cam by its login - /privacy, the admin page and the bridge card say the pad's owner and room moderators too", () => {
  const cr = stripTags(privacyPage({ camreveal: { on: true } }));
  assert.ok(cr.includes("If you've asked Pepe to forget you or to delete your account, only PATV administrators and staff - and, while you're in their room, the pad's owner and the room's moderators - can, and only your cam - never your name or your past lines."), cr.slice(0, 200));
  assert.ok(!cr.includes("only PATV administrators and staff can, and only your cam"), "the old 'admins and staff only' sentence is gone");
  assert.ok(!stripTags(privacyPage({})).includes("delete your account, only PATV administrators"), "cam reveals off: no such sentence at all");
  const adm = fs.readFileSync(path.join(repo, "views", "admin", "pepeLivecams.ejs"), "utf8");
  assert.ok(!adm.includes("Admins and staff only.</p>") && adm.includes("a pad's owner and the room's moderators have the same entry on their own pad's page"), "the admin page");
  const br = fs.readFileSync(path.join(repo, "views", "admin", "bridge.ejs"), "utf8");
  assert.ok(br.includes("\"View a cam by Camfrog login\" on /admin/pepe/livecams and under a pad's people list (admins and staff on any pad; a pad's owner and the room's moderators on their own pad"), "the bridge card");
  const en = require(path.join(repo, "locales", "en.json"));
  for (const k of ["js.camrv.login_title", "js.camrv.login_intro", "js.camrv.login", "js.camrv.need_login"]) assert.ok(en[k], "en.json: " + k);
});
