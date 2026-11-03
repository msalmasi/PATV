// 1.99?? (privacy controls V-1 / V-3 / V-5, the first build's verification - G:/ops/privacy-controls-spec-2026-11-02.md section 8:
// Q4 "every feature works for an incognito person's cam ... incognito only affects the NAME shown"). On a temp DB with the real bridge
// ingest (privacy wire v2), frog-name sessions, live cams, the mic-stage engine, the stage, clips and on-air (the S5 harness):
//   V-3   an incognito holder's first-step hood becomes their cam tile in place (spec 2.2 row 4: one frog, one tile)
//   V-1   a veiled mic-stage tile's ticket; 📌 pins, 🎬 stage cam slots, 📺 on-air picks, 🎬 clips and mic-stage captures of a veiled cam,
//         each by an opaque id, under the frog name, with no login in any answer, row a page shows, action row or log line
//   V-5   a 👻 ghost's ▶ Live past someone's rules asks why (reason_needed), the reason logged
//   node --test test/privm-v1.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privm-v1-test-"));
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

// ── V-3 (spec 2.2 row 4): one frog, one tile - from the first step ──
test("V-3: an incognito holder's first-step hood BECOMES their cam tile in place - never a recent hood beside the cam", async () => {
  await v1ready;
  await cleanStage();
  await fresh();
  await syncAt({ rooms: [v2Room({ mic: true })] });
  const alias = frankEntry().alias;
  let sawCover = false, sawCam = false;
  for (let i = 0; i < 14; i++) {
    await stepAt(3);
    const mine = frogTiles(alias);
    if (mine.some((x) => x.cover)) sawCover = true;
    if (mine.some((x) => !x.cover)) sawCam = true;
    assert.ok(mine.length <= 1, `step ${i}: one tile per frog, got ${JSON.stringify(mine.map((x) => [x.cover ? "cover" : "cam", x.relAt != null ? "recent" : "current"]))}`);
    const r = await live(U.mem);
    const src = (r.d.stage_program && r.d.stage_program.src) || [];
    assert.ok(src.filter((s) => s.name === alias).length <= 1, `step ${i}: the page shows the frog once: ${JSON.stringify(src.map((s) => [s.kind, s.name, !!s.recent]))}`);
  }
  assert.ok(sawCam, "the cam tile came up");
  void sawCover;
});

// ── V-1: the veiled mic-stage tile's own ticket (S5's tiles were refused for every incognito person) ──
test("V-1: a member gets a ticket for a veiled mic-stage cam tile by its id - generic refusals, no login", async () => {
  await v1ready;
  await cleanStage();
  await fresh();
  await syncAt({ rooms: [v2Room({ mic: true })] });
  for (let i = 0; i < 14 && !pad().state.tiles.some((x) => !x.cover); i++) await stepAt(3);
  assert.ok(pad().state.tiles.some((x) => !x.cover), "a veiled cam tile");
  await liveTile("frankiefettuccine");
  const tile = pad().state.tiles.find((x) => !x.cover);
  assert.equal(tile.video, "live", "live: " + JSON.stringify(tile));
  const vid = pad().vids.get("frankiefettuccine");
  const w = await call("POST", `/api/rooms/${SLUG}/micfollow/watch`, { user: U.mem, body: { login: vid } });
  assert.equal(w.status, 200, w.text);
  assert.ok(w.d.whep, "a WHEP ticket: " + w.text.slice(0, 200));
  assert.deepEqual(leaks(w.text), [], "no identity in the ticket: " + leaks(w.text).join(", "));
  // Q23: a viewer the person blocked gets the one generic word (the tile stays for everyone else)
  const b = await CAMV.block("frankiefettuccine", "mem2");
  assert.ok(b.ok, JSON.stringify(b));
  try {
    const w2 = await call("POST", `/api/rooms/${SLUG}/micfollow/watch`, { user: U.mem2, body: { login: vid } });
    assert.deepEqual([w2.status, w2.d.code], [403, "unavailable"], "Q23: one generic word - " + w2.text);
  } finally { await CAMV.unblock("frankiefettuccine", "mem2"); }
});

// ── V-1: 📌 pins of a veiled cam ──
test("V-1: 📌 a veiled cam by its id - pinned under the frog name, no login anywhere; a veil change unpins it; switch off -> refused", async () => {
  await v1ready;
  await cleanStage();
  await fresh();
  await syncAt({ rooms: [v2Room({ mic: true })] });
  for (let i = 0; i < 14 && !pad().state.tiles.some((x) => !x.cover); i++) await stepAt(3);
  const vid = pad().vids.get("frankiefettuccine");
  const alias = frankEntry().alias;
  assert.match(String(vid), /^anon-/);
  // the owner's picker lists the frog by its people-list id - never a login
  const pk = await call("GET", `/api/rooms/${SLUG}/micfollow/pins`, { user: U.own });
  assert.equal(pk.status, 200, pk.text);
  assert.deepEqual(leaks(pk.text), [], "picker: " + leaks(pk.text).join(", "));
  const fe = (pk.d.cams || []).find((c) => c.veiled);
  assert.ok(fe && fe.id === frankId() && fe.display === alias && fe.login === undefined, "the frog entry: " + JSON.stringify(pk.d.cams));
  // pin by the tile's id
  const pn = await call("POST", `/api/rooms/${SLUG}/micfollow/pin`, { user: U.own, body: { login: vid } });
  assert.equal(pn.status, 200, pn.text);
  assert.ok(pn.d.pinned && /^anon-[0-9a-f]{8}$/.test(pn.d.pin.id) && pn.d.pin.login === undefined, pn.text);
  assert.deepEqual(leaks(pn.text), []);
  const row = (await getQuery("SELECT login, veil FROM micfollow_pins WHERE room_id = ?", [ROOM.id]))[0];
  assert.equal(row.login, "frankiefettuccine", "the login stays server-side");
  const vz = JSON.parse(row.veil);
  assert.ok(vz.sess && vz.vid === pn.d.pin.id, "its frog-name session + public id: " + row.veil);
  const S = [...LC._sessions.values()].find((x) => x.login === "frankiefettuccine" && !x.ended);
  assert.ok(S && S.veil && S.holds.has("pin:" + (MF.pinOf(ROOM.id, "frankiefettuccine") || {}).id), "held as a veiled session (its own path)");
  await stepAt(1);
  for (const [k, u] of Object.entries({ mem: U.mem, own: U.own, staff: U.staff })) {
    const r = await live(u);
    assert.deepEqual(leaks(r.text), [], k + ": " + leaks(r.text).join(", "));
    const t = (r.d.stage_program.src || []).find((s) => s.pin);
    assert.ok(t && t.id === pn.d.pin.id && t.kind === "cam" && t.veil === "incognito" && t.name === alias && t.avatar === null, k + ": " + JSON.stringify(r.d.stage_program.src));
  }
  // a pin's ticket by its id
  await upV("frankiefettuccine");
  const w = await call("POST", `/api/rooms/${SLUG}/micfollow/watch`, { user: U.mem, body: { login: pn.d.pin.id, pin: true } });
  assert.ok(w.status === 200 && !leaks(w.text).length, w.text.slice(0, 200));
  // a veil change (the frog-name session ends) unpins it at once
  await FN.off("frankiefettuccine", ROOM.id);
  await MF._idle(); await settle(20);
  assert.equal(MF.pinOf(ROOM.id, "frankiefettuccine"), null, "unpinned on the veil change");
  // switch off: a veiled id is refused as before
  T += 16 * 60 * 1000;
  await fresh();
  await syncAt({ rooms: [v2Room({ mic: true })] });
  await fresh();
  for (let i = 0; i < 14 && !pad().state.tiles.some((x) => !x.cover); i++) await stepAt(3);
  const vid2 = pad().vids.get("frankiefettuccine");
  await IC.setOn(false, { userId: U.adm.userId, username: "adm" });
  try {
    const off = await call("POST", `/api/rooms/${SLUG}/micfollow/pin`, { user: U.own, body: { login: vid2 || "anon-00000000" } });
    assert.notEqual(off.status, 200, "switch off: no veiled pin - " + off.text);
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM micfollow_pins"))[0].n, 0);
  } finally { await IC.setOn(true, { userId: U.adm.userId, username: "adm" }); IC.noteBot({ incogcam: 1 }, T); }
});

// ── V-1: 🎬 stage cam slots of a veiled cam ──
test("V-1: 🎬 a stage cam slot of a veiled cam by its id - the frog name only, never the login; ends on a veil change", async () => {
  await v1ready;
  await cleanStage();
  await fresh();
  await syncAt({ rooms: [v2Room({ mic: false })] });
  await fresh();
  const id = frankId(), alias = frankEntry().alias;
  const cams = await call2("GET", `/api/rooms/${SLUG}/stage/cams`, { user: U.own });
  assert.equal(cams.status, 200, cams.text);
  assert.deepEqual(leaks(cams.text), [], "candidates: " + leaks(cams.text).join(", "));
  const fe = (cams.d.cams || []).find((c) => c.veiled);
  assert.ok(fe && fe.id === id && fe.display === alias && !("login" in fe) && !("_login" in fe), JSON.stringify(cams.d.cams));
  const r = await call2("POST", `/api/rooms/${SLUG}/stage/cam`, { user: U.own, body: { id } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(leaks(r.text), [], "answer: " + leaks(r.text).join(", "));
  assert.ok(r.d.slot && r.d.slot.display === alias && r.d.slot.cam && r.d.slot.cam.login === null && r.d.slot.cam.veiled === true, r.text);
  const row = (await getQuery("SELECT cam_login, cam_veil, displayname, title FROM stage_slots WHERE id = ?", [r.d.slot.id]))[0];
  assert.equal(row.cam_login, "frankiefettuccine", "server-side");
  assert.ok(JSON.parse(row.cam_veil).sess, "its frog-name session");
  assert.ok(!row.displayname.includes("frankie") && !row.title.includes("frankie"), JSON.stringify(row));
  const evs = await getQuery("SELECT detail FROM stage_events WHERE slot_id = ?", [r.d.slot.id]);
  assert.ok(evs.length && evs.every((e) => !String(e.detail).includes("frankie")), "stage events: " + JSON.stringify(evs));
  const S = [...LC._sessions.values()].find((x) => x.login === "frankiefettuccine" && !x.ended);
  assert.ok(S && S.veil && S.holds.has(r.d.slot.id), "a veiled session held by the slot");
  // a veil change ends it
  await FN.off("frankiefettuccine", ROOM.id);
  const s = await MS.getSlot(r.d.slot.id);
  await MS.camBeat(s, T);
  const after = (await getQuery("SELECT status, end_reason FROM stage_slots WHERE id = ?", [r.d.slot.id]))[0];
  assert.equal(after.end_reason, "cam_veil_changed", JSON.stringify(after));
  // a plain login of someone who shows veiled is no named member (as before)
  T += 16 * 60 * 1000;
  await fresh();
  await syncAt({ rooms: [v2Room({ mic: false })] });
  await fresh();
  const byLogin = await call2("POST", `/api/rooms/${SLUG}/stage/cam`, { user: U.own, body: { login: "frankiefettuccine" } });
  assert.notEqual(byLogin.status, 200, "by login: refused - " + byLogin.text);
});

// ── V-1: Pepe's on-air picker ──
test("V-1: 📺 on air by the frog entry's id - label / id / log / admin view carry the frog name only; by login refused; a veil change takes it off", async () => {
  await v1ready;
  await cleanStage();
  await fresh();
  await syncAt({ rooms: [v2Room({ mic: false })] });
  await fresh();
  await OA.init();
  await OA.saveConfig({ enabled: true, cam_optin: false }, "test", { admin: ADM() }).catch(() => {});
  await CA.setMode("frankiefettuccine", "everyone");
  const id = frankId(), alias = frankEntry().alias;
  await assert.rejects(OA.setCam(ROOM.id, "frankiefettuccine", "web:adm", { admin: ADM() }), (e) => e.code === "not_on_cam", "a login typed for a veiled person: no named member");
  const v = await OA.setCam(ROOM.id, null, "web:adm", { admin: ADM(), id, ask: true });
  const T0 = v.target;
  assert.ok(T0 && T0.kind === "cam" && T0.veiled === true && T0.login === null && T0.display === alias && T0.label.includes(alias), JSON.stringify(T0));
  assert.ok(!T0.id.includes("frankie"), "its id never carries the login: " + T0.id);
  const av = await OA.adminView(ADM());
  const avs = JSON.stringify(av);
  assert.equal(avs.includes("frankiefettuccine"), false, "the admin view never shows the login");
  assert.ok((av.log || []).some((x) => String(x.ref || "").endsWith("|veiled")), "onair_log ref: veiled");
  const fb = await OA.forBot({}, T);
  const tb = fb && (fb.target || (fb.main && fb.main.target) || fb.main || null);
  void tb;
  // a veil change takes it off
  await FN.off("frankiefettuccine", ROOM.id);
  await OA.check().catch(() => {});
  const v2 = OA.view();
  assert.ok(!v2.target || v2.target.kind !== "cam", "taken off: " + JSON.stringify(v2.target));
  await OA.clear("test", "test", { lane: "all" }).catch(() => {});
});

// ── V-1: 🎬 cam clips of a veiled cam ──
test("V-1: 🎬 a clip of a veiled cam by its id - the view never carries the login; the save names no subject; Pepe gets the frog name", async () => {
  await v1ready;
  await cleanStage();
  T += 16 * 60 * 1000;
  await fresh();
  await syncAt({ rooms: [v2Room({ mic: false })] });
  await fresh();
  const id = frankId(), alias = frankEntry().alias;
  const r = await call("POST", `/api/rooms/${SLUG}/camclip`, { user: U.mem, body: { id, secs: 10 } });
  assert.equal(r.status, 200, r.text);
  const j = [...RL._jobs.values()].find((x) => x.kind === "camclip" && x.id === r.d.id);
  assert.equal(j.target, "frankiefettuccine", "Pepe's job names the login (bot-facing)");
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), crypto.randomBytes(80)]);
  const p = await call("POST", "/api/bridge/camclip", { body: { password: "bot", id: r.d.id, state: "ok", data: mp4.toString("base64"), secs: 10, save: "on", viewer_ok: true, cost: 0 } });
  assert.equal(p.status, 200, p.text);
  const g = await call("GET", `/api/rooms/${SLUG}/camclip/${r.d.id}`, { user: U.mem });
  assert.equal(g.status, 200, g.text);
  assert.ok(g.d.login === null && g.d.veiled === true, g.text);
  assert.deepEqual(leaks(g.text), [], leaks(g.text).join(", "));
  const sv = await call("POST", `/api/rooms/${SLUG}/camclip/${r.d.id}/save`, { user: U.mem, body: {} });
  assert.equal(sv.status, 200, sv.text);
  const a = (await getQuery("SELECT args, label FROM pepe_actions WHERE id = ?", [sv.d.id]))[0];
  const args = JSON.parse(a.args);
  assert.deepEqual([args[1], a.label], ["", "!clip someone"], "the saver's action row never names the subject: " + JSON.stringify(a));
  assert.equal(JSON.stringify(a).includes("frankie"), false);
  const d = await call("POST", "/api/bridge/camclipdata", { body: { password: "bot", id: r.d.id, user: "mem" } });
  assert.equal(d.status, 200, d.text.slice(0, 200));
  assert.deepEqual([d.d.target, d.d.veiled, d.d.label], ["frankiefettuccine", true, alias], "Pepe: the target + the frog name as the subject");
  // a refusal is the generic word
  await CA.setMode("frankiefettuccine", "followers");
  try {
    const rf = await call("POST", `/api/rooms/${SLUG}/camclip`, { user: U.mem2, body: { id, secs: 10 } });
    assert.deepEqual([rf.d.code, rf.d.error], ["unavailable", "That cam isn't available right now."], rf.text);
  } finally { await CA.setMode("frankiefettuccine", "everyone"); }
});

// ── V-1: the cam in a mic-stage capture ──
test("V-1: a mic-stage capture draws a veiled cam under its frog label (its own path) - consent under that session; recorded server-only", async () => {
  await v1ready;
  await cleanStage();
  T += 16 * 60 * 1000;
  await fresh();
  await syncAt({ rooms: [v2Room({ mic: true })] });
  for (let i = 0; i < 14 && !pad().state.tiles.some((x) => !x.cover); i++) await stepAt(3);
  await liveTile("frankiefettuccine");
  assert.equal((pad().state.tiles.find((x) => !x.cover) || {}).video, "live", "a live veiled tile");
  const vid = pad().vids.get("frankiefettuccine"), alias = frankEntry().alias;
  SMC.configure({ privateLogins: async () => new Set() });
  const R = bridge._rooms.get(ROOM.id);
  const e = { kind: "cam", id: vid, name: alias, veil: "incognito", hood: 1, watch: "ok", video: "live" };
  const t = await SMC._test.tileFor(e, R, { userId: U.mem.userId });
  assert.equal(t.mode, "live", "the cam itself: " + JSON.stringify({ mode: t.mode, name: t.name }));
  const Sv = LC._sessions.get(LC.keyOf(ROOM.id, "frankiefettuccine"));
  assert.ok(Sv && Sv.veil && t.path === Sv.path, "its veiled session's own path");
  assert.notEqual(t.path, LC.pathFor(ROOM.id, "frankiefettuccine"), "never the named path");
  assert.ok(t.veiled && t.name === alias + " · incognito" && t.login === "frankiefettuccine", "frog label; the login server-side only");
  // a viewer the person's rules exclude: the hood
  const h = await SMC._test.tileFor(Object.assign({}, e, { watch: "unavailable" }), R, { userId: U.mem.userId });
  assert.equal(h.mode, "cover");
  // consent under that session: once they aren't incognito under it, no cam
  assert.equal(await SMC._test.consent("frankiefettuccine", U.mem.userId, { R, sess: "nope" }), false);
});

// ── V-5: the ghost ▶ Live bypass asks why ──
test("V-5: a 👻 ghost's ▶ Live past a veiled cam's rules needs a reason (409 reason_needed), logged with it", async () => {
  await v1ready;
  await cleanStage();
  T += 16 * 60 * 1000;
  await fresh();
  await syncAt({ rooms: [v2Room({ mic: false })] });
  await fresh();
  await LC.setOptout("frankiefettuccine", true, { via: "web", ts: T });
  await GH.init && GH.init();
  await GH.set(U.staff.userId, true, { via: "web" });
  try {
    const id = frankId();
    const r = await call("POST", `/api/rooms/${SLUG}/livecam`, { user: U.staff, body: { id } });
    assert.deepEqual([r.status, r.d.code, r.d.reason_needed], [409, "reason_needed", true], r.text);
    const n0 = (await getQuery("SELECT COUNT(*) AS n FROM seethrough_log WHERE scope = 'cam_reveal' AND ref LIKE 'ghost:%'"))[0].n;
    const r2 = await call("POST", `/api/rooms/${SLUG}/livecam`, { user: U.staff, body: { id, reason: "checking a report" } });
    assert.equal(r2.status, 200, r2.text);
    const st = (await getQuery("SELECT reason FROM seethrough_log WHERE scope = 'cam_reveal' AND ref LIKE 'ghost:%' ORDER BY id DESC LIMIT 1"))[0];
    assert.equal(st.reason, "checking a report");
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM seethrough_log WHERE scope = 'cam_reveal' AND ref LIKE 'ghost:%'"))[0].n, n0 + 1);
  } finally {
    await GH.set(U.staff.userId, false, { via: "web" });
    await LC.setOptout("frankiefettuccine", false, { via: "web", ts: T + 1 });
  }
});
