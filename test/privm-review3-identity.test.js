// 1.99aid (privacy controls, round 3 - the final verify's F1 / F2; G:/ops/privacy-controls-spec-2026-11-02.md section 8, owner Q4: every
// cam feature works for an incognito person's cam under its frog name, "including AI picture references"; captures carry the frog name,
// never the real name or login). On the V-1 harness (privm-review2-identity.test.js, verbatim: a temp DB, the real bridge ingest on
// privacy wire v2, frog-name sessions, live cams, the mic stage):
//   F1  an AI picture reference of a frog-name cam works end to end: the composer's list -> a snapshot by its id -> the claim -> Generate
//       (create no longer answers 403 "Their cam can't be used any more.") -> what Pepe is handed (/start: ref_cam says veiled + the frog
//       name, so his refusals name the frog). A veil change, incognito cams going off or !livecam off since the claim still refuse it
//   F2  the pad's 🐸 👀 / 🔥 on a frog-name cam by its opaque id: Pepe gets "<cmd> <login>" + veil {alias}; everything the website gets
//       back (the answer, the job's line / reply / replies, late replies, the command log a member downloads) names the frog only; 🎤 by id,
//       incognito cams off and the person's own cam rules refuse it with one word that names nobody; named targets as before
//   F3  (S4t wording) a reported blacked-out line in the staff report queue: "needs an admin" while text reveal roles are off; while
//       on, tr: 1 and the note says staff can reveal it on the pad too (with a reason)
//   node --test test/privm-review3-identity.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privm-review3-id-"));
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
const IC = require(path.join(repo, "incogcams"));
const RL = require(path.join(repo, "bridge-relay"));
const PP = require(path.join(repo, "padpepe"));

const D = 864e5;
const hash = (login) => crypto.createHash("sha256").update("pepe-hidden:" + String(login).trim().toLowerCase()).digest("hex").slice(0, 20);
const ROOM = { id: "V1.Room", name: "V1 Room" }, SLUG = "v1-room";
const users = new Map();
const U = {};
let base, server, seq = 0;
let T = Date.now();
W.enabled = () => true;
premium.bridgeAllowed = () => true;
MF._setClock(() => T);
MF._setBoot(0);
LC._setClock(() => T);
IC._setClock(() => T);
FN._setClock(() => T);
stage._setClock(() => T);
LC._setKick(() => {});

const ev = (type, data, ts = T) => ({ op: "event", id: "v1-" + (++seq), ts: new Date(ts).toISOString(), type, scope: { platform: "camfrog", room: ROOM }, data });
const real = (login, display) => ({ id: login.toLowerCase(), login, display: display || login });
const priv = (kind, login) => ({ kind, h: hash(login), at: T / 1000 });
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function syncAt(body, v2 = true) {
  const realNow = Date.now;
  Date.now = () => T;
  try { return await bridge.ingest(Object.assign({ events: [], rooms: [], bridge_hidden_h: [hash("hankhidden")], incog_hidden_h: [hash("frankiefettuccine")] }, body), { v2 }); }
  finally { Date.now = realNow; }
}
/** Pepe's live-cam poll, his last sync and - while `word` - his incogcam: 1, all at the test clock. */
let WORD = true;
async function fresh() {
  await LC.forBot({ cap: true, mf: 1, live: [] }, T);
  const R = bridge._rooms.get(ROOM.id);
  if (R) Object.assign(R, { updated: T, cams: true, livecams: true });
  IC.noteBot(WORD ? { incogcam: 1 } : {}, T);
}
async function stepAt(sec) {
  T += sec * 1000;
  await fresh();
  MF.stepPad(ROOM.id, T);
  await MF._idle(); await settle(10);
}
const pad = () => MF._pads.get(ROOM.id);
/** The v2 snapshot: alice named, frankie INCOGNITO, hank HIDDEN - Pepe's on_cam on each (he sends a veiled one's only with the advert;
 *  the site must keep a hidden one's off the page whatever arrives). mic: frankie, a proven holder. */
function v2Room({ mic = true, frankieCam = true } = {}) {
  return { room: ROOM, cams: true, livecams: true, count: 3, transcripts: true,
           members: [Object.assign(real("alicecf", "Alice"), { on_cam: true }),
                     Object.assign(real("frankiefettuccine", "Frankie Fett"), { priv: priv("incognito", "frankiefettuccine"), src: "list", on_mic: mic, on_cam: frankieCam }),
                     Object.assign(real("hankhidden", "Hank Hide"), { priv: priv("hidden", "hankhidden"), src: "list", on_cam: true })],
           mic: mic ? [Object.assign(real("frankiefettuccine", "Frankie Fett"), { priv: priv("incognito", "frankiefettuccine"), proven: true, since: T / 1000 - 5 })] : [] };
}
function call(method, url, { user = null, body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + url);
    const data = body == null ? null : JSON.stringify(body);
    const h = Object.assign({ "x-requested-with": "fetch", origin: base, host: u.host }, user ? { "x-test-user": user.userId } : {},
                            data != null ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}, headers);
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: h }, (res) => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { s += c; });
      res.on("end", () => { let d = null; try { d = JSON.parse(s); } catch (e) { d = null; } resolve({ status: res.statusCode, d, text: s, headers: res.headers }); });
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
  const u = { userId: uid, username: name, class: cls };
  users.set(uid, u);
  return u;
}
const live = (user) => call("GET", `/api/rooms/${SLUG}/live`, { user });
// what never reaches a member's page: frankie's identity (login, display, hash), hank's, the named WHEP path of frankie's cam, the
// engine's / session keys
const VEILED = ["frankiefettuccine", "Frankie Fett", "hankhidden", "Hank Hide"];
const leaks = (json) => [...VEILED, ...VEILED.map(hash), LC.pathFor(ROOM.id, "frankiefettuccine"), ROOM.id + "|frankiefettuccine", "~cv:", "\"_vz\"", "\"priv\"", "\"sess\""]
  .filter((x) => json.includes(x));
const ADM = () => ({ userId: U.adm.userId, username: "adm", class: "Admin" });
const frankEntry = () => (bridge._rooms.get(ROOM.id).members || []).find((e) => e && e.anon && e._vz && e._vz.login === "frankiefettuccine");
const frankId = () => (frankEntry() || {}).id;

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
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
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
  await LC.save(ADM(), { cfg: { enabled: true } });
  await CA.init();
  await CA.setMode("frankiefettuccine", "everyone");
  await CA.setMode("alicecf", "everyone");
  await MF._ready();
  await MF.setKill(ADM(), true, "test");
  await MF.setCfg(ADM(), { covers: true, cold_open: true, reason: "test" });
  await MF.setPad(ROOM.id, { on: true }, "test");
  await MF._noticed(ROOM.id, "frankiefettuccine", T - D);              // told long ago (the one courtesy notice)
  await CV.init();
  CV._clearCaches();
  await IC.init();
})();


// ── V-1..V-5 setup on top of S5's: privacy wire v2 + incognito cams ON, the stage routes, the clip switches, on-air enabled ──
const MS = stage;
const CC = require(path.join(repo, "camclip"));
const OA = require(path.join(repo, "onair"));
const SMC = require(path.join(repo, "stagemiccap"));
const GH = require(path.join(repo, "ghost"));
const v1ready = (async () => {
  await setup;
  await PW.init();
  if (!PW.isOn()) await PW.setOn(true, { userId: U.adm.userId, username: "adm" });
  await IC.setOn(true, { userId: U.adm.userId, username: "adm" });
  IC.noteBot({ incogcam: 1 }, T);
  CC._setDeps({ snapSwitch: () => true, clipSwitch: () => true });
  await require(path.join(repo, "seethrough")).init();
  await require(path.join(repo, "adminaudit")).init();
  // the stage's routes (index.js registers them on the real site)
  const app2 = express();
  app2.use((req, res, next) => (req.path === "/api/bridge/sync" ? next() : express.json()(req, res, next)));
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  MS.register(app2, { isBotToken: (t) => t === "bot", addUser });
  await new Promise((r) => { const s2 = app2.listen(0, () => { base2 = "http://127.0.0.1:" + s2.address().port; r(); }); s2.unref(); });
})();
let base2 = null;
function call2(method, url, opts = {}) { const b = base; base = base2; const p = call(method, url, opts); base = b; return p; }
/** The relay of `login`'s session is up (MediaMTX has its own path - named or veiled - and Pepe opened it by its exact name). */
async function upV(login) {
  const S0 = LC._sessions.get(LC.keyOf(ROOM.id, login));
  const p = S0 && !S0.ended ? S0.path : null;
  if (p) LC.noteSync([{ name: p, ready: true, readers: [] }], T);
  await LC.forBot({ cap: true, mf: 1, live: [{ room: ROOM.id, login, state: "live", exact: true }] }, T);
  const R = bridge._rooms.get(ROOM.id);
  if (R) Object.assign(R, { updated: T, cams: true, livecams: true });
  IC.noteBot({ incogcam: 1 }, T);
}
/** Step until `login`'s mic-stage tile is live on its relay (Pepe opened it by its exact name, MediaMTX has its path). */
async function liveTile(login) {
  for (let i = 0; i < 12; i++) {
    await upV(login);
    await stepAt(1);
    const x = pad().state.tiles.find((y) => !y.cover && y.login === login);
    if (x && x.video === "live") return x;
  }
  return null;
}
/** A clean stage: no tiles, pins, relays or hides. */
async function cleanStage() {
  for (const p of MF._pins ? [...MF._pins.values()].flatMap((m) => [...m.values()]) : []) await MF.unpin(p.roomId, p.login, "test", "system").catch(() => {});
  const P = pad();
  if (P) { P.state = require(path.join(repo, "micfollow-core")).newState(); P.ttag && P.ttag.clear(); P.vids && P.vids.clear(); P.vcam && P.vcam.clear(); P.covers && P.covers.clear(); }
  LC._sessions.clear();
  MF._hide.clear();
  T += 90 * 1000;                                    // (the cold-open rate windows of earlier tests are over)
}
const frogTiles = (alias) => pad().state.tiles.filter((x) => (x.cover ? (pad().covers.get(x.login) || {}).alias === alias : String(pad().ttag.get(x.login) || "").startsWith("v:")));




// ── round 3: F1 (AI picture references) and F2 (the 🐸 cam actions) on a frog-name cam ──
const AG = require(path.join(repo, "aigen"));
const LOGIN = "frankiefettuccine";
const NAMES = [LOGIN, "Frankie Fett", "Frankie", hash(LOGIN)];
const named = (s) => NAMES.filter((x) => String(s).toLowerCase().includes(x.toLowerCase()));
const MENU = { look: { on: true, price: 10000 }, camroast: { on: true, price: 15000 }, roast: { on: true, price: 5000 } };
async function freshRoom(extra = {}) {
  await cleanStage();
  await fresh();
  await syncAt({ rooms: [Object.assign(v2Room({ mic: false }), extra)] });
  await fresh();
}
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8]), crypto.randomBytes(64)]);
/** A member's snapshot of a cam ({id} or {login}), Pepe's frame, the page's read of it -> the claimable sid. */
async function snapOf(user, who) {
  RL._snaps.clear();                                       // (a fresh frame each time - never the cached one)
  RL._hits.clear();
  const r = await call("POST", `/api/rooms/${SLUG}/snap`, { user, body: who });
  assert.equal(r.status, 200, "snapshot: " + r.text);
  const target = who.login || LOGIN;
  const j = [...RL._jobs.values()].find((x) => x.kind === "snap" && x.target === target && x.state !== "done");
  const res = await call("POST", "/api/bridge/snap", { body: { password: "bot", id: j.id, room: ROOM.id, target, ok: true, data: JPG.toString("base64"), save: "on", viewer_ok: true } });
  assert.equal(res.status, 200, res.text);
  const g = await call("GET", `/api/rooms/${SLUG}/snap/${encodeURIComponent(who.id || who.login)}`, { user });
  assert.ok(g.d && g.d.state === "ok" && g.d.gen && g.d.gen.sid, "the frame can be used in Generate: " + g.text);
  return g.d.gen.sid;
}
const gen = (user, camref) => AG.create({ userId: user.userId }, { kind: "image", prompt: "a frog wearing a tiny hat in the rain", pad: SLUG, camref },
                                       { queue: async () => "act-" + crypto.randomBytes(3).toString("hex"), audit: async () => {} });

test("F1: an AI picture reference of a frog-name cam works end to end under the frog name - list, snapshot, claim, Generate, Pepe's hand-over", async () => {
  await v1ready;
  await freshRoom();
  const id = frankId(), alias = frankEntry().alias;
  const cl = await AG.camList({ userId: U.mem.userId }, ROOM.id);
  assert.ok((cl.cams || []).some((c) => c.veiled && c.id === id), "the frog cam is offered: " + JSON.stringify(cl));
  const sid = await snapOf(U.mem, { id });
  const c = await AG.claimCamRef({ userId: U.mem.userId }, { pad: SLUG, sid });
  assert.equal(c.display, alias, "claimed under the frog name");
  assert.deepEqual(named(JSON.stringify(c)), [], "the claim names nobody");
  const job = await gen(U.mem, c.id);                                    // (before round 3: 403 "Their cam can't be used any more.")
  assert.ok(job && job.id && !job.error, "Generate takes it: " + JSON.stringify(job));
  assert.equal(job.refCam, alias, "the composer's job shows the frog name");
  assert.deepEqual(named(JSON.stringify(job)), [], "the job view names nobody: " + JSON.stringify(job));
  // what Pepe is handed at /start: the login (he re-checks their !likeness / livecam choices by it), marked veiled with the frog name
  const st = await AG.start({ id: job.id });
  assert.deepEqual(st.ref_cam, { room: ROOM.id, login: LOGIN, veiled: true, label: alias });
  assert.ok(st.has_ref && st.ref && st.ref.data, "the frame goes to Pepe once");
  // the named flow is as before (no veiled mark)
  const sid2 = await snapOf(U.mem2, { login: "alicecf" });
  const c2 = await AG.claimCamRef({ userId: U.mem2.userId }, { pad: SLUG, sid: sid2 });
  const job2 = await gen(U.mem2, c2.id);
  const st2 = await AG.start({ id: job2.id });
  assert.deepEqual(st2.ref_cam, { room: ROOM.id, login: "alicecf" }, "a named reference: as before");
});

test("F1: a frog-name reference claimed before a veil change, incognito cams going off or !livecam off is refused at Generate (never by name)", async () => {
  await v1ready;
  const claim = async () => {
    await freshRoom();
    const sid = await snapOf(U.mem, { id: frankId() });
    return AG.claimCamRef({ userId: U.mem.userId }, { pad: SLUG, sid });
  };
  const refused = async (c, why) => {
    const e = await gen(U.mem, c.id).then(() => null, (x) => x);
    assert.ok(e && e.status === 403 && e.message === "Their cam can't be used any more.", why + ": " + (e && e.message));
    assert.deepEqual(named(e.message), [], why + ": names nobody");
  };
  // incognito cams stop being in effect (Pepe's word gone)
  let c = await claim();
  WORD = false; await fresh();
  try { await refused(c, "incognito cams off"); } finally { WORD = true; await fresh(); }
  // a new frog-name session (the old one ended - any veil change ends it)
  c = await claim();
  const R = bridge._rooms.get(ROOM.id), e0 = frankEntry();
  const sess = e0._vz.sess;
  Object.defineProperty(e0, "_vz", { value: Object.assign({}, e0._vz, { sess: String(sess) + "x" }), enumerable: false, configurable: true });
  try { await refused(c, "another frog-name session"); }
  finally { Object.defineProperty(e0, "_vz", { value: Object.assign({}, e0._vz, { sess }), enumerable: false, configurable: true }); }
  assert.ok(R);
  // !livecam off since the claim
  c = await claim();
  await LC.setOptout(LOGIN, true, { via: "web", ts: T });
  try { await refused(c, "live cam off"); } finally { await LC.setOptout(LOGIN, false, { via: "web", ts: T }); }
});

// ── F2: the pad's 🐸 cam actions ──
const pepe = (user, body) => { RL._hits.clear(); return call("POST", `/api/rooms/${SLUG}/pepe`, { user, body }); };
const pepeRoom = () => freshRoom({ relay: true, cmds: { "!look": 10000, "!camroast": 15000, "!roast": 5000 }, pepe: MENU });

test("F2: 👀 / 🔥 on a frog-name cam by its opaque id - Pepe gets the login line + veil; the website only ever gets the frog name", async () => {
  await v1ready;
  await pepeRoom();
  const id = frankId(), alias = frankEntry().alias;
  for (const [action, cmd] of [["look", "!look"], ["camroast", "!camroast"]]) {
    const r = await pepe(U.mem, { action, id });
    assert.equal(r.status, 200, action + ": " + r.text);
    assert.equal(r.d.line, `${cmd} ${alias}`, "the answer's line names the frog");
    assert.deepEqual(named(r.text), [], action + ": the answer names nobody");
    assert.deepEqual(leaks(r.text), [], action + ": no leak");
    const j = RL._jobs.get(r.d.id);
    assert.equal(j.text, `${cmd} ${LOGIN}`, "Pepe runs the usual line (the Camfrog room sees what it sees today)");
    assert.deepEqual(j.veil, { alias });
    assert.equal(Object.keys(j).includes("vmask"), false, "the mask never rides on the job's fields");
    const off = RL.takeJobs(new Set([ROOM.id])).find((x) => x.id === j.id);
    assert.deepEqual(off.veil, { alias }, "Pepe is told to word it by the frog name");
    // Pepe's answer (even one that slipped a name through) comes back under the frog name, late replies too
    RL.applyAcks([{ id: j.id, ok: true, msg: `@memcf ${LOGIN}'s cam: Frankie Fett is wearing a tiny hat`,
                    replies: [`🌐 mem (web): ${cmd} ${LOGIN}`, `@memcf Frankie looks great today, frankiefettuccine!`] }]);
    RL.applyAcks([{ id: j.id, ok: true, late: true, replies: ["FRANKIE FETT strikes again"] }]);
    const p = await call("GET", `/api/rooms/${SLUG}/pepe/job/${j.id}`, { user: U.mem });
    assert.equal(p.status, 200, p.text);
    assert.equal(p.d.line, `${cmd} ${alias}`);
    assert.deepEqual(named(p.text), [], action + ": the job's answer names nobody - " + p.text);
    assert.ok(p.d.msg.includes(alias) && p.d.replies.length === 3 && p.d.replies.every((x) => !named(x).length), JSON.stringify(p.d));
    await settle(30);
    const logs = await getQuery("SELECT command, result FROM bridge_cmd_log WHERE job = ?", [j.id]);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].command, `${cmd} ${alias} [pepe menu]`, "the command log (Download my data) names the frog");
    assert.deepEqual(named(JSON.stringify(logs)), [], "...and its result too");
  }
  // a named target is as before
  const n = await pepe(U.mem, { action: "look", target: "alicecf" });
  assert.equal(n.status, 200, n.text);
  assert.equal(n.d.line, "!look alicecf");
  assert.equal(RL._jobs.get(n.d.id).veil, undefined, "no veil on a named job");
  assert.equal(RL.takeJobs(new Set([ROOM.id])).find((x) => x.id === n.d.id).veil, undefined);
});

test("F2: refused by its id with one word that names nobody - 🎤 roast, incognito cams off, the person's live cam off or block, a stale id", async () => {
  await v1ready;
  await pepeRoom();
  const id = frankId();
  const nobody = (r, why, status) => {
    assert.equal(r.status, status, why + ": " + r.text);
    assert.deepEqual(named(r.text), [], why + ": names nobody");
    assert.deepEqual(leaks(r.text), [], why + ": no leak");
  };
  nobody(await pepe(U.mem, { action: "roast", id }), "🎤 roast by id", 400);
  nobody(await pepe(U.mem, { action: "look", id: "v-AAAAAAAAAAAA" }), "an unknown id", 409);
  await LC.setOptout(LOGIN, true, { via: "web", ts: T });
  try { nobody(await pepe(U.mem, { action: "look", id }), "live cam off", 409); } finally { await LC.setOptout(LOGIN, false, { via: "web", ts: T }); }
  await CAMV.block(LOGIN, "mem").catch(() => {});
  try { if (CAMV.blocked(LOGIN, U.mem.userId)) nobody(await pepe(U.mem, { action: "look", id }), "they blocked this viewer", 409); }
  finally { await CAMV.unblock(LOGIN, "mem").catch(() => {}); }
  WORD = false; await fresh();
  try { nobody(await pepe(U.mem, { action: "look", id }), "incognito cams off", 409); } finally { WORD = true; await fresh(); }
  // by login, an incognito person is never found (as before): no line, no job
  const byLogin = await pepe(U.mem, { action: "look", target: LOGIN });
  assert.equal(byLogin.status, 404, byLogin.text);
});

// ── F3 (S4t wording): the staff report queue's note on a blacked-out line names staff too while text reveal roles are on ──
test("F3: a reported hidden line - 'needs an admin' while text reveal roles are off; tr: 1 (staff can reveal it on the pad, with a reason) while on", async () => {
  await v1ready;
  await freshRoom();
  const TRV = require(path.join(repo, "textreveal"));
  const CM = require(path.join(repo, "chatlogmod"));
  await TRV.init();
  const hank = Object.assign(real("hankhidden", "Hank Hide"), { priv: priv("hidden", "hankhidden") });
  await syncAt({ events: [ev("message", { user: hank, text: "words hank said for round three" })] });
  let row = null;
  for (let i = 0; i < 30 && !row; i++) { await settle(30); row = (await getQuery("SELECT c, rk FROM chat_log WHERE text = ? ORDER BY c DESC LIMIT 1", ["words hank said for round three"]))[0] || null; }
  assert.ok(row, "the hidden line is in the archive");
  await runQuery("INSERT INTO chatlog_reports (c, rk, reporter, reason, note, state, created) VALUES (?, ?, ?, 'spam', '', 'open', ?)", [row.c, row.rk, U.mem.userId, Date.now()]);
  const staff = { userId: U.staff.userId, username: "helper", class: "Staff" };
  const off = await CM.reportRead(staff, row.c);
  assert.equal(off.needs_admin, true, JSON.stringify(off));
  assert.equal("tr" in off, false, "switch off: the answer as before");
  await TRV.setOn(true, ADM());
  try {
    const on = await CM.reportRead(staff, row.c);
    assert.equal(on.needs_admin, true);
    assert.equal(on.tr, 1, "switch on: staff may reveal it on the pad too");
    assert.equal(on.text, null, "never the words here");
    assert.deepEqual(named(JSON.stringify(on)).concat(JSON.stringify(on).includes("hankhidden") ? ["hankhidden"] : []), []);
  } finally { await TRV.setOn(false, ADM()); }
  // the queue's words follow tr
  const js = fs.readFileSync(path.join(repo, "public", "js", "chatlog-reports.js"), "utf8");
  assert.match(js, /L\.tr \? 'Hidden line - reveal it on the pad \(PATV admins, and staff with a reason; every reveal is logged\)'/);
  assert.match(js, /'Hidden line - needs an admin \(an admin can reveal it on the pad; every reveal is logged\)'/, "switch off: as before");
  assert.match(fs.readFileSync(path.join(repo, "views", "feedAdmin.ejs"), "utf8"), /chatlog-reports\.js\?v=[3-9]/);
});
