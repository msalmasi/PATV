// 1.99?? (privacy controls, review fixes 2 - the identity lens; G:/ops/privacy-controls-spec-2026-11-02.md section 8, owner Q4: every
// cam feature works for an incognito cam under its frog name, and every place that shows or stores such a capture / pin / slot carries
// the frog name and opaque ids, never the login). On the V-1 harness (privm-v1.test.js: a temp DB, the real bridge ingest on privacy
// wire v2, frog-name sessions, live cams, the mic stage, the stage, on-air):
//   ID-A  the End / Cut answers of a frog-name stage cam slot carry no login and no veil (a named slot's answer is as before)
//   ID-B  Download my data of whoever put a frog cam on the stage / pinned it: the frog name, never the login or the veil
//   ID-C  an on-air pick of a frog cam that needs OKs: Staff's admin view, the pad owner's ask and the request page never pair the
//         frog label with the login (Pepe's PM list and the cam owner's own ask keep it)
//   Q4-B  the AI composer's cam list offers frog cams by their opaque id and frog name while incognito cams are in effect
//   node --test test/privm-review2-identity.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privm-review2-id-"));
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


// ── review fixes 2: the identity lens ──
const AE = require(path.join(repo, "accountexport"));
const OC = require(path.join(repo, "onairconsent"));
const SP = require(path.join(repo, "siteperms"));
const AG = require(path.join(repo, "aigen"));
const STAFF = () => ({ userId: U.staff.userId, username: "helper", class: "Staff" });
const LOGIN = "frankiefettuccine";
async function freshRoom(mic = false) {
  await cleanStage();
  await fresh();
  await syncAt({ rooms: [v2Room({ mic })] });
  await fresh();
}

test("ID-A: the End / Cut answers for a frog-name stage cam slot never carry the login (or its veil); a named slot's answer is as before", async () => {
  await v1ready;
  await freshRoom(false);
  const alias = frankEntry().alias;
  const r = await call2("POST", `/api/rooms/${SLUG}/stage/cam`, { user: U.own, body: { id: frankId() } });
  assert.equal(r.status, 200, r.text);
  const end = await call2("POST", `/api/stage/slots/${r.d.slot.id}/end`, { user: U.own, body: {} });
  assert.equal(end.status, 200, end.text);
  assert.equal(end.text.includes(LOGIN), false, "the pad owner's End answer pairs " + alias + " with the login: " + end.text);
  assert.equal(end.d.settled.cam_login, null);
  assert.equal("cam_veil" in end.d.settled, false, "no frog-name session / ids either");
  await freshRoom(false);
  const r2 = await call2("POST", `/api/rooms/${SLUG}/stage/cam`, { user: U.own, body: { id: frankId() } });
  assert.equal(r2.status, 200, r2.text);
  const cut = await call2("POST", `/api/stage/slots/${r2.d.slot.id}/cut`, { user: U.own, body: {} });
  assert.equal(cut.status, 200, cut.text);
  assert.equal(cut.text.includes(LOGIN), false, "the pad owner's Cut answer: " + cut.text);
  assert.deepEqual([cut.d.settled.cam_login, "cam_veil" in cut.d.settled], [null, false]);
  // the server side still used them: the Cut's mic-stage exclusion is the veiled one (listed by the frog name)
  // a NAMED cam slot: its login comes back as before (switches-off behaviour), never a cam_veil key
  await freshRoom(false);
  const n = await call2("POST", `/api/rooms/${SLUG}/stage/cam`, { user: U.own, body: { login: "alicecf" } });
  assert.equal(n.status, 200, n.text);
  const ne = await call2("POST", `/api/stage/slots/${n.d.slot.id}/end`, { user: U.own, body: {} });
  assert.deepEqual([ne.d.settled.cam_login, "cam_veil" in ne.d.settled], ["alicecf", false], ne.text);
});

test("ID-B: Download my data of the pad owner who put a frog cam on the stage and pinned it - the frog name, never the login or its veil", async () => {
  await v1ready;
  // a frog-name stage cam slot this owner put up (and ended), then - its mic-stage exclusion over - a pin of the same frog cam
  await freshRoom(false);
  const s0 = await call2("POST", `/api/rooms/${SLUG}/stage/cam`, { user: U.own, body: { id: frankId() } });
  assert.equal(s0.status, 200, s0.text);
  await call2("POST", `/api/stage/slots/${s0.d.slot.id}/end`, { user: U.own, body: {} });
  T += ((MF.cfg().exclude_on_cut_min || 0) + 1) * 60000;
  await freshRoom(true);
  for (let i = 0; i < 14 && !pad().state.tiles.some((x) => !x.cover); i++) await stepAt(3);
  const vid = pad().vids.get(LOGIN);
  const pn = await call("POST", `/api/rooms/${SLUG}/micfollow/pin`, { user: U.own, body: { login: vid } });
  assert.equal(pn.status, 200, pn.text + " " + JSON.stringify({ vid, tiles: pad().state.tiles.map((x) => [x.cover ? "cover" : "cam", x.video]) }));
  const pinAlias = (JSON.parse((await getQuery("SELECT veil FROM micfollow_pins WHERE login = ?", [LOGIN]))[0].veil) || {}).alias;
  const out = await AE.collect(U.own.userId);
  const s = JSON.stringify(out);
  const hits = [];
  for (const [sec, v] of Object.entries(out)) for (const [name, val] of Object.entries(v || {})) { const js = JSON.stringify(val); if (js && js.includes(LOGIN)) hits.push(sec + "." + name); }
  assert.equal(s.includes(LOGIN), false, "the pad owner's export pairs the frog name with the login in: " + hits.join(", "));
  const slots = (out.purchases && out.purchases.stage_slots) || [];
  const fs0 = slots.filter((x) => x.source === "cam" && x.cam_login === null);
  assert.ok(fs0.length >= 1 && fs0.every((x) => !("cam_veil" in x) && x.displayname && x.displayname !== LOGIN), "a frog-name slot: its frog name, no login / veil");
  const pins = (out.chat && out.chat.mic_stage_pins_you_made) || [];
  const fp = pins.find((x) => x.login === null);
  assert.ok(fp && fp.frog_name === pinAlias && !("veil" in fp), "the pin lists the frog name it was pinned under: " + JSON.stringify(pins));
  // the SUBJECT's own export keeps their pin (their own login - nothing is paired for anyone else)
  const mine = await AE.collect(U.frankie.userId);
  assert.ok(((mine.chat && mine.chat.mic_stage_pins_of_you) || []).some((x) => x.login === LOGIN), "the subject still sees the pin of their cam");
  await MF.unpin(ROOM.id, LOGIN, "test", "system").catch(() => {});
});

test("ID-C: an on-air pick of a frog cam that needs OKs - the asks never pair the frog label with the login for Staff or the pad owner; Pepe and the cam's owner keep it", async () => {
  await v1ready;
  await freshRoom(false);
  await OA.init();
  await OA.saveConfig({ enabled: true, cam_optin: true }, "test", { admin: ADM() }).catch(() => {});
  await CA.setMode(LOGIN, "everyone");
  const PAm = require(path.join(repo, "padaccess"));
  const realApproved = PAm.isApproved;
  PAm.isApproved = () => true;            // an Approved pad whose owner hasn't said "always allow": the pad's owner is asked too
  try {
    const v = await OA.setCam(ROOM.id, null, "web:adm", { admin: ADM(), id: frankId(), ask: true });
    assert.equal((v.target.pending || []).length, 2, "a cam ask and a pad ask");
    assert.ok(SP.can(STAFF(), "onair.operate"), "Staff operate on-air (the admin view below)");
    const av = await OA.adminView(STAFF());
    assert.equal((av.pending || []).length, 2);
    assert.equal(JSON.stringify(av.pending).includes(LOGIN), false, "Staff's on-air admin view: " + JSON.stringify(av.pending));
    assert.ok(av.pending.every((p) => p.login === null && /📷 /.test(p.label)), "the frog label, login null");
    const own = await OC.mine(U.own.userId);
    assert.equal(own.length, 1); assert.equal(own[0].kind, "pad");
    assert.equal(JSON.stringify(own).includes(LOGIN), false, "the pad owner's /api/onair/consent/mine: " + JSON.stringify(own));
    const page = await OC.get(own[0].id);
    assert.equal(page.login, null, "the request page's row too");
    // the cam's own owner: their own ask, with their own login; Pepe's PM list keeps it (he PMs the cam's owner)
    const fr = await OC.mine(U.frankie.userId);
    assert.ok(fr.some((x) => x.kind === "cam" && x.login === LOGIN), "the cam owner's own ask");
    assert.ok((await OC.camAsks()).some((x) => x.login === LOGIN), "Pepe's camAsks");
    const row = (await getQuery("SELECT login, veiled FROM onair_consent WHERE id = ?", [own[0].id]))[0];
    assert.deepEqual([row.login, row.veiled], [LOGIN, 1], "stored server-side, marked veiled");
  } finally {
    PAm.isApproved = realApproved;
    await OA.clear("test", "test", { lane: "all" }).catch(() => {});
  }
  // a NAMED pick's asks are as before (the login shown)
  PAm.isApproved = () => true;
  try {
    await CA.setMode("alicecf", "everyone");
    await OA.setCam(ROOM.id, "alicecf", "web:adm", { admin: ADM(), ask: true });
    const av = await OA.adminView(STAFF());
    assert.ok((av.pending || []).length && av.pending.every((p) => p.login === "alicecf"), JSON.stringify(av.pending));
  } finally {
    PAm.isApproved = realApproved;
    await OA.clear("test", "test", { lane: "all" }).catch(() => {});
  }
});

test("Q4-B: the AI composer's 'From a cam in this room' lists a frog cam by its opaque id and frog name (never a login) while incognito cams are in effect", async () => {
  await v1ready;
  await freshRoom(false);
  const r = await AG.camList(ADM(), ROOM.id).catch((e) => ({ error: e.message }));
  assert.ok(!r.error, JSON.stringify(r));
  const s = JSON.stringify(r);
  assert.equal(s.includes(LOGIN), false, "no login of an incognito person: " + s);
  const fe = (r.cams || []).find((c) => c.veiled);
  assert.ok(fe && fe.id === frankId() && fe.display === frankEntry().alias && !("login" in fe), "the frog cam by its id: " + s);
  assert.ok((r.cams || []).some((c) => c.login === "alicecf"), "named cams as before");
  // incognito cams off: only the named ones (as before)
  WORD = false; await fresh();
  try {
    const r2 = await AG.camList(ADM(), ROOM.id);
    assert.ok(!(r2.cams || []).some((c) => c.veiled), "no frog cams without the advert: " + JSON.stringify(r2));
  } finally { WORD = true; await fresh(); }
});
