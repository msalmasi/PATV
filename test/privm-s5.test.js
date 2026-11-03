// 1.99aid (privacy controls S5): INCOGNITO CAMS (G:/ops/privacy-controls-spec-2026-11-02.md section 5 "S5"; the owner's answers,
// section 8: Q3 no migration, Q4 every cam feature works for an incognito person's cam - only the NAME is veiled, Q23 the cam is
// withheld only from viewers the person's own rules exclude). On a temp DB with the real bridge ingest (privacy wire v2), frog-name
// sessions, live cams, the mic-stage engine and the snapshot routes:
//   switch    incogcams.js: off by default; on only with privacy wire v2 (409); the sync answer says incogcam: 1 only while both are
//             on; effective() also needs Pepe's word (his sync's incogcam: 1); /api/admin/incogcams is chatlog.admin; the bot reads
//             the same key names (PEPE_BOT_DIR)
//   roster    an incognito member's on_cam (Pepe's v2 snapshot) shows on their FROG entry only while effective - never a hidden
//             member's, never with live cam off, never a login; every role's /live carries no identity
//   ▶ Live    by the entry's opaque id: the key is that id, the WHEP path is the session's own (≠ the named path, ≠ another frog
//             session's), beat / stop / hint by id - a login never reaches the veiled session; livecam_audit / admin views carry the
//             frog name; Q23's refusals are one generic word (followers, a block, live cam off) with no "ask"; a veil change, the
//             frog-name session ending and the switch going off end it; a named ▶ Live waits while the person shows veiled; a mod's
//             End names the frog name in the moderation history
//   stage     a proven incognito holder on cam is a CAM tile under the frog name ({kind: cam, id: anon-…, veil, hood}, no login /
//             avatar / nameCss); with live cam off - or the switch off - the hooded cover, exactly as before; its relay is a veiled
//             session (Pepe's want: the login + its own path); the frog-name session ending cuts it; the tile routes take its id;
//             a by-login ✕ / 📌 refuses it; staff never see the login on /stage/admin (spans by frog name)
//   snaps     POST /snap {id} -> a job for the login, its frame under its own key (a named GET never sees it, nor the reverse), a
//             generic refusal; the save is labelled "!snap someone"; ✨ Use in Generate names the frog
//   padpepe   the 🐸 Pepe actions refuse a veiled entry
//   node --test test/privm-s5.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privm-s5-test-"));
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
const ROOM = { id: "S5.Room", name: "S5 Room" }, SLUG = "s5-room";
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

const ev = (type, data, ts = T) => ({ op: "event", id: "s5-" + (++seq), ts: new Date(ts).toISOString(), type, scope: { platform: "camfrog", room: ROOM }, data });
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

// ── the switch ──
test("switch: off by default; on only with privacy wire v2; the advert and Pepe's word; admins only", async () => {
  await setup;
  assert.equal(IC.isOn(), false);
  assert.equal(IC.advert(), false);
  const sync = () => call("POST", "/api/bridge/sync", { body: { password: "bot", events: [], rooms: [], hidden_h: [], incogcam: 1 } });
  let r = await sync();
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.incogcam, undefined, "switch off: no advert");
  await assert.rejects(IC.setOn(true, { userId: U.adm.userId, username: "adm" }), (e) => e.status === 409 && e.code === "privwire_off");
  await PW.init();
  await PW.setOn(true, { userId: U.adm.userId, username: "adm" });
  r = await sync();
  assert.equal(r.d.privwire, 2);
  assert.equal(r.d.incogcam, undefined, "privacy wire alone: no advert");
  const mem = await call("POST", "/api/admin/incogcams", { user: U.mem, body: { on: true } });
  assert.equal(mem.status, 403);
  const st = await call("POST", "/api/admin/incogcams", { user: U.staff, body: { on: true } });
  assert.equal(st.status, 403, "staff can't flip it");
  const on = await call("POST", "/api/admin/incogcams", { user: U.adm, body: { on: true } });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.d.state.on, true);
  const aud = await getQuery("SELECT action FROM admin_audit WHERE action = 'incogcams.switch'");
  assert.equal(aud.length, 1, "audited");
  r = await sync();
  assert.equal(r.d.incogcam, 1, "the advert while both are on");
  WORD = false; IC.noteBot({}, T);
  assert.equal(IC.effective(T), false, "no word from Pepe: not in effect");
  IC.noteBot({ incogcam: true }, T);
  assert.equal(IC.effective(T), false, "only incogcam: 1 exactly");
  IC.noteBot({ incogcam: 1 }, T);
  assert.equal(IC.effective(T), true, "the switch, privacy wire v2 and Pepe's word");
  assert.equal(IC.effective(T + IC.BOT_FRESH_MS + 1), false, "...while his word is fresh");
  WORD = true;
  const g = await call("GET", "/api/admin/incogcams", { user: U.adm });
  assert.equal(g.d.state.effective, true);
  if (process.env.PEPE_BOT_DIR) {
    const bsrc = fs.readFileSync(path.join(process.env.PEPE_BOT_DIR, "pepe_bridge.py"), "utf8");
    assert.ok(bsrc.includes('rj.get("incogcam")') && bsrc.includes('payload["incogcam"] = 1'), "Pepe reads incogcam and says incogcam: 1 (the same keys)");
  }
});

// ── the roster ──
test("roster: an incognito member's on_cam on their frog entry only while effective - never a hidden one's, never with live cam off, never a login", async () => {
  await setup;
  await fresh();
  await syncAt({ rooms: [v2Room({ mic: false })] });
  await fresh();
  const fe = frankEntry();
  assert.ok(fe && fe._vz.on_cam === true && fe.id, "server-side on _vz, with its opaque id");
  assert.equal(JSON.stringify(fe).includes("on_cam"), false, "never on the stored page-safe entry itself");
  for (const [k, u] of Object.entries({ mem: U.mem, staff: U.staff, own: U.own, adm: U.adm })) {
    const r = await live(u);
    assert.equal(r.status, 200, k + ": " + r.text.slice(0, 200));
    assert.deepEqual(leaks(r.text).filter((x) => !(k === "adm" && false)), [], k + ": " + leaks(r.text).join(", "));
    const f = r.d.members.find((m) => m.anon && m.veil === "incognito");
    const h = r.d.members.find((m) => m.anon && m.veil === "hidden");
    assert.ok(f && f.on_cam === true && f.id === fe.id && !f.login, k + ": the frog entry carries on_cam + its id");
    assert.ok(!h || h.on_cam === undefined, k + ": a hidden member never");
  }
  WORD = false; IC.noteBot({}, T);
  let r = await live(U.mem);
  assert.equal(r.d.members.find((m) => m.anon && m.veil === "incognito").on_cam, undefined, "no word from Pepe: no on_cam");
  WORD = true; IC.noteBot({ incogcam: 1 }, T);
  await LC.setOptout("frankiefettuccine", true, { via: "web", ts: T });
  r = await live(U.mem);
  assert.equal(r.d.members.find((m) => m.anon && m.veil === "incognito").on_cam, undefined, "live cam off: no cam icon");
  await LC.setOptout("frankiefettuccine", false, { via: "web", ts: T + 1 });
  r = await live(U.mem);
  assert.equal(r.d.members.find((m) => m.anon && m.veil === "incognito").on_cam, true);
});

// ── ▶ Live by the opaque id ──
test("▶ Live by id: the key is the id, the path the session's own; beat / stop / hint by id; a login never reaches it; audit + admin views by frog name", async () => {
  await setup;
  await fresh();
  await syncAt({ rooms: [v2Room({ mic: false })] });
  await fresh();
  const id = frankId();
  const alias = frankEntry().alias;
  const r = await call("POST", `/api/rooms/${SLUG}/livecam`, { user: U.mem, body: { id } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.key, id, "the key is the opaque id");
  assert.deepEqual(leaks(r.text), [], "no login / named path in the answer: " + leaks(r.text).join(", "));
  const S = [...LC._sessions.values()].find((x) => x.login === "frankiefettuccine" && !x.ended);
  assert.ok(S && S.veil && S.veil.id === id, "a veiled session");
  assert.notEqual(S.path, LC.pathFor(ROOM.id, "frankiefettuccine"), "never the named path");
  assert.equal(S.path, LC.vpathFor(ROOM.id, "frankiefettuccine", frankEntry()._vz.sess));
  assert.ok(r.d.whep.includes(S.path));
  // beat by id: ok; by the login: nothing (no named session)
  let b = await call("POST", `/api/rooms/${SLUG}/livecam/beat`, { user: U.mem, body: { id } });
  assert.equal(b.d.state === "ended", false, "beat by id keeps it: " + b.text);
  b = await call("POST", `/api/rooms/${SLUG}/livecam/beat`, { user: U.mem, body: { login: "frankiefettuccine" } });
  assert.deepEqual([b.d.state, b.d.why], ["ended", "unwatched"], "a guessed login never reaches the veiled session");
  const h = await live(U.mem);
  assert.deepEqual(h.d.room.livecams.watching, [id], "hint().watching by id");
  // Pepe is asked for the login at that path
  const fb = await LC.forBot({ cap: true, mf: 1, live: [] }, T);
  const w = (fb.want || []).find((x) => x.login === "frankiefettuccine");
  assert.ok(w && w.url.includes(S.path), "Pepe's want: the login + the session's own path");
  // audit + admin view: the frog name, never the login
  const a = (await getQuery("SELECT target, veil FROM livecam_audit ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual([a.target, a.veil], ["frankiefettuccine", alias], "the row keeps the login server-side and the frog name");
  const av = JSON.stringify(await LC.adminView());
  assert.ok(!av.includes("frankiefettuccine") && av.includes(alias + " (incognito)"), "/admin/pepe/livecams: the frog name only");
  // stop by id
  const s = await call("POST", `/api/rooms/${SLUG}/livecam/stop`, { user: U.mem, body: { id } });
  assert.equal(s.d.ok, true);
  assert.equal(S.viewers.size, 0, "stopped by id");
});

test("Q23: followers / a block / live cam off -> one generic word, no ask; not in effect -> the id is no door", async () => {
  await setup;
  await fresh();
  await syncAt({ rooms: [v2Room({ mic: false })] });
  await fresh();
  const id = frankId();
  const GEN = "That cam isn't available right now.";
  await CA.setMode("frankiefettuccine", "followers");
  let r = await call("POST", `/api/rooms/${SLUG}/livecam`, { user: U.mem2, body: { id } });
  assert.deepEqual([r.status, r.d.code, r.d.error, r.d.can_ask, r.d.mode], [403, "unavailable", GEN, undefined, undefined], "followers: generic, no ask: " + r.text);
  const ask = await call("POST", `/api/rooms/${SLUG}/livecam/ask`, { user: U.mem2, body: { id } });
  assert.equal(ask.d.code, "unavailable", "no ask for a veiled cam");
  await CA.setMode("frankiefettuccine", "everyone");
  await CAMV.block("frankiefettuccine", "mem2", { byUserId: U.frankie.userId });
  r = await call("POST", `/api/rooms/${SLUG}/livecam`, { user: U.mem2, body: { id } });
  assert.deepEqual([r.d.code, r.d.error], ["unavailable", GEN], "blocked: generic");
  await LC.setOptout("frankiefettuccine", true, { via: "web", ts: T + 10 });
  r = await call("POST", `/api/rooms/${SLUG}/livecam`, { user: U.mem, body: { id } });
  assert.deepEqual([r.d.code, r.d.error], ["unavailable", GEN], "live cam off: generic, never 'switched their cam off'");
  await LC.setOptout("frankiefettuccine", false, { via: "web", ts: T + 11 });
  // the switch off: the id is no door at all
  WORD = false; IC.noteBot({}, T);
  r = await call("POST", `/api/rooms/${SLUG}/livecam`, { user: U.mem, body: { id } });
  assert.equal(r.d.code, "not_on_cam", "not in effect: no veiled cam");
  WORD = true; IC.noteBot({ incogcam: 1 }, T);
});

test("a veil change ends the veiled session (incognito off -> named), and the frog-name session ending ends it; a mod's End names the frog", async () => {
  await setup;
  await fresh();
  await syncAt({ rooms: [v2Room({ mic: false })] });
  await fresh();
  let id = frankId();
  const alias = frankEntry().alias;
  let r = await call("POST", `/api/rooms/${SLUG}/livecam`, { user: U.mem, body: { id } });
  assert.equal(r.status, 200, r.text);
  // the pad's owner ends it by id: the moderation history names the frog name
  const e = await call("POST", `/api/rooms/${SLUG}/livecam/end`, { user: U.own, body: { id } });
  assert.equal(e.status, 200, e.text);
  const row = (await getQuery("SELECT detail FROM room_events WHERE what = 'livecam-end' ORDER BY ts DESC LIMIT 1"))[0];
  assert.ok(row && row.detail.includes(alias) && !row.detail.includes("frankiefettuccine"), "End line: " + (row && row.detail));
  LC._sessions.clear();
  T += 11 * 60 * 1000;
  await fresh();
  await syncAt({ rooms: [v2Room({ mic: false })] });
  await fresh();
  id = frankId();
  r = await call("POST", `/api/rooms/${SLUG}/livecam`, { user: U.mem, body: { id } });
  assert.equal(r.status, 200, r.text);
  const S = [...LC._sessions.values()].find((x) => x.login === "frankiefettuccine" && !x.ended);
  // their frog-name session ends (veilstage -> livecam.veilEnded)
  await FN.off("frankiefettuccine", ROOM.id);
  assert.equal(!!S.ended, true, "the frog-name session ending ends it");
  assert.equal(S.endWhy, "veil_changed");
  // a fresh one; then incognito OFF (Pepe lists them named): the sweep ends a veiled session that no longer matches
  await syncAt({ rooms: [v2Room({ mic: false })] });
  await fresh();
  id = frankId();
  r = await call("POST", `/api/rooms/${SLUG}/livecam`, { user: U.mem, body: { id } });
  const S2 = [...LC._sessions.values()].find((x) => x.login === "frankiefettuccine" && !x.ended);
  assert.ok(S2 && S2.veil);
  const named = v2Room({ mic: false });
  named.members[1] = Object.assign(real("frankiefettuccine", "Frankie Fett"), { src: "list", on_cam: true });
  await syncAt({ rooms: [named], incog_hidden_h: [] });
  await fresh();
  LC.sweep(T);
  assert.equal(S2.endWhy, "veil_changed", "a veiled session ends when its person shows named");
  // ...and the named ▶ Live of someone who shows veiled waits (spec 2.2) - a hold frozen veiled
  const frozen = v2Room({ mic: true });
  frozen.members[1] = Object.assign(real("frankiefettuccine", "Frankie Fett"), { src: "list", on_cam: true });
  await syncAt({ rooms: [frozen], incog_hidden_h: [] });
  await fresh();
  r = await call("POST", `/api/rooms/${SLUG}/livecam`, { user: U.mem, body: { login: "frankiefettuccine" } });
  assert.equal(r.d.code, "unavailable", "a named ▶ Live waits while a hold of theirs is frozen veiled: " + r.text);
  // back to incognito for the next tests (C.2: no frog name for 15 minutes after a named sighting - the session that started in that
  // window stays nameless until it ends)
  T += 16 * 60 * 1000;
  await FN.off("frankiefettuccine", ROOM.id);
  await fresh();
  await syncAt({ rooms: [v2Room({ mic: false })] });
  await fresh();
  assert.ok(frankId(), "a frog name again after the C.2 window");
});

test("switch off ends every veiled session at once", async () => {
  await setup;
  await fresh();
  await syncAt({ rooms: [v2Room({ mic: false })] });
  await fresh();
  const r = await call("POST", `/api/rooms/${SLUG}/livecam`, { user: U.mem, body: { id: frankId() } });
  assert.equal(r.status, 200, r.text);
  const S = [...LC._sessions.values()].find((x) => x.login === "frankiefettuccine" && !x.ended);
  await IC.setOn(false, { userId: U.adm.userId, username: "adm" });
  assert.equal(S.endWhy, "switched_off");
  await IC.setOn(true, { userId: U.adm.userId, username: "adm" });
});

// ── the mic stage ──
test("stage: a proven incognito holder on cam is a CAM tile under the frog name; live cam off -> the hood; every role: no identity", async () => {
  await setup;
  LC._sessions.clear();
  await fresh();
  await syncAt({ rooms: [v2Room({ mic: true })] });
  for (let i = 0; i < 12 && !pad().state.tiles.some((x) => !x.cover); i++) await stepAt(3);
  const tile = pad().state.tiles.find((x) => !x.cover);
  assert.ok(tile && tile.login === "frankiefettuccine", "a cam tile keyed by the login (server-side): " + JSON.stringify(pad().state.tiles.map((x) => x.login)));
  assert.equal(String(pad().ttag.get("frankiefettuccine")).startsWith("v:"), true, "born under the frog-name session");
  const vid = pad().vids.get("frankiefettuccine");
  assert.match(vid, /^anon-[0-9a-f]{8}$/);
  assert.equal(MF.vidLogin(ROOM.id, vid), "frankiefettuccine");
  const alias = frankEntry().alias;
  for (const [k, u] of Object.entries({ mem: U.mem, staff: U.staff, own: U.own, adm: U.adm })) {
    const r = await live(u);
    assert.deepEqual(leaks(r.text), [], k + ": " + leaks(r.text).join(", "));
    const t = (r.d.stage_program.src || []).find((s) => s.id === vid);
    assert.ok(t, k + ": the tile " + JSON.stringify(r.d.stage_program.src));
    assert.deepEqual([t.kind, t.veil, t.name, t.avatar, t.nameCss], ["cam", "incognito", alias, null, ""], k);
    assert.ok(Number.isInteger(t.hood), k + ": its hood");
    assert.equal(t.rv, k === "own" || k === "adm" ? 1 : undefined, k + ": Reveal for the owner / admins only");
  }
  // its relay: a veiled session at its own path (Pepe's want: the login + that path)
  const S = [...LC._sessions.values()].find((x) => x.login === "frankiefettuccine" && !x.ended);
  assert.ok(S && S.veil && S.holds.has("mf:" + ROOM.id) && S.path !== LC.pathFor(ROOM.id, "frankiefettuccine"), "the mic stage's veiled session");
  // the tile routes: ✕ / 📌 by login refuse its id; ⚑ by its id hides it for the reporter by its veil
  const ex = await call("POST", `/api/rooms/${SLUG}/micfollow/exclude`, { user: U.own, body: { login: vid, hours: 1 } });
  assert.equal(ex.d.code, "cover", "a by-login ✕ refuses a veiled tile's id: " + ex.text);
  // (1.99aid privacy controls V-1: 📌 of a veiled tile by its id now pins it under the frog name - test/privm-v1.test.js)
  const rp = await call("POST", `/api/rooms/${SLUG}/micfollow/report`, { user: U.mem, body: { login: vid, reason: "other" } });
  assert.equal(rp.status, 200, rp.text);
  const hm = MF._hide.get(ROOM.id + "|" + U.mem.userId);
  assert.ok(hm && [...hm.keys()].every((k) => k.startsWith("~v:")), "hidden for the reporter by its veil, never the login");
  const rep = (await getQuery("SELECT login, veiled FROM micfollow_reports ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual([rep.login, rep.veiled], ["frankiefettuccine", 1], "the report row: server-side login, marked veiled (S0's queue)");
  const view = await MF.adminView({ userId: U.staff.userId, username: "helper", class: "Staff" });
  assert.equal(JSON.stringify(view.reports).includes("frankiefettuccine"), false, "staff never see the login in the queue");
  // live cam off: the hood (a cover), as before
  await LC.setOptout("frankiefettuccine", true, { via: "web", ts: T + 20 });
  for (let i = 0; i < 6 && pad().state.tiles.some((x) => !x.cover); i++) await stepAt(3);
  assert.equal(pad().state.tiles.some((x) => !x.cover), false, "live cam off: no cam tile");
  for (let i = 0; i < 6 && !pad().state.tiles.some((x) => x.cover); i++) await stepAt(3);
  assert.equal(pad().state.tiles.filter((x) => x.cover).length, 1, "the hooded cover instead");
  await LC.setOptout("frankiefettuccine", false, { via: "web", ts: T + 21 });
});

test("stage: the frog-name session ending cuts the cam tile at once; the switch off -> the hood, as before", async () => {
  await setup;
  MF._hide.clear();
  await fresh();
  await syncAt({ rooms: [v2Room({ mic: true })] });
  for (let i = 0; i < 15 && !pad().state.tiles.some((x) => !x.cover); i++) await stepAt(3);
  assert.ok(pad().state.tiles.some((x) => !x.cover), "a cam tile");
  await FN.off("frankiefettuccine", ROOM.id);
  assert.equal(pad().state.tiles.some((x) => !x.cover), false, "cut at once");
  assert.equal(pad().vids.has("frankiefettuccine"), false, "its public id forgotten");
  const spans = await getQuery("SELECT veil, end_reason FROM micfollow_spans WHERE login = 'frankiefettuccine' ORDER BY id DESC LIMIT 1");
  assert.ok(spans[0] && spans[0].veil && spans[0].end_reason === "cut:veil_changed", "its span: the frog name, cut:veil_changed - " + JSON.stringify(spans));
  const view = await MF.adminView({ userId: U.adm.userId, username: "adm", class: "Admin" });
  assert.equal(JSON.stringify(view.spans || []).includes("frankiefettuccine"), false, "/stage/admin spans: the frog name, never the login");
  // the switch off: the next hold is the hood
  await IC.setOn(false, { userId: U.adm.userId, username: "adm" });
  try {
    await syncAt({ rooms: [v2Room({ mic: true })] });
    for (let i = 0; i < 25 && !pad().state.tiles.some((x) => x.cover); i++) {
      await stepAt(3);
      assert.equal(pad().state.tiles.some((x) => !x.cover), false, "switch off: never a cam tile");
    }
    assert.equal(pad().state.tiles.filter((x) => x.cover).length, 1, "the cover, as before");
  } finally { await IC.setOn(true, { userId: U.adm.userId, username: "adm" }); }
});

// ── snapshots + Generate ──
test("snapshots by id: a job for the login, the frame under its own key; generic refusals; the save says 'someone'; Generate names the frog", async () => {
  await setup;
  await fresh();
  await syncAt({ rooms: [v2Room({ mic: false })] });
  await fresh();
  const id = frankId();
  const alias = frankEntry().alias;
  const r = await call("POST", `/api/rooms/${SLUG}/snap`, { user: U.mem, body: { id } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(leaks(r.text), []);
  const j = [...RL._jobs.values()].find((x) => x.kind === "snap" && x.target === "frankiefettuccine" && x.state !== "done");
  assert.ok(j && j.vkey && j.vkey.startsWith("v:"), "the job: the login for Pepe, the veil key for the frame");
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8]), crypto.randomBytes(64)]);
  const res = await call("POST", "/api/bridge/snap", { body: { password: "bot", id: j.id, room: ROOM.id, target: "frankiefettuccine", ok: true, data: jpg.toString("base64"), save: "on", viewer_ok: true } });
  assert.equal(res.status, 200, res.text);
  assert.ok(RL._snaps.has(ROOM.id + "|frankiefettuccine|" + j.vkey) && !RL._snaps.has(ROOM.id + "|frankiefettuccine"), "its own key only");
  const g = await call("GET", `/api/rooms/${SLUG}/snap/${encodeURIComponent(id)}`, { user: U.mem });
  assert.equal(g.d.state, "ok", g.text.slice(0, 200));
  // (1.99aid privacy controls V-1: 🎬 Clip now works for a veiled cam - by the frog entry's id, never a login; test/privm-v1.test.js)
  assert.ok(g.d.clip && !JSON.stringify(g.d.clip).includes("frankiefettuccine"), "🎬 Clip offered, no login: " + JSON.stringify(g.d.clip));
  assert.deepEqual(leaks(g.text), []);
  const gn = await call("GET", `/api/rooms/${SLUG}/snap/frankiefettuccine`, { user: U.mem });
  assert.notEqual(gn.d.state, "ok", "a named request never sees the veiled frame");
  // save: the action's label never names them
  const sv = await call("POST", `/api/rooms/${SLUG}/snap/save`, { user: U.mem, body: { sid: g.d.save ? g.d.save.sid : g.d.gen.sid } });
  if (sv.status === 200) {
    const a = (await getQuery("SELECT label FROM pepe_actions WHERE id = ?", [sv.d.id]))[0];
    assert.equal(a.label, "!snap someone");
  }
  // ✨ Use in Generate: the frog name
  const AG = require(path.join(repo, "aigen"));
  if (g.d.gen) {
    const c = await AG.claimCamRef({ userId: U.mem.userId }, { pad: SLUG, sid: g.d.gen.sid }).catch((e) => ({ error: e.message }));
    if (!c.error) assert.equal(c.display, alias, "Generate names the frog: " + JSON.stringify(c));
  }
  // a refusal is generic
  await CA.setMode("frankiefettuccine", "followers");
  const rf = await call("POST", `/api/rooms/${SLUG}/snap`, { user: U.mem2, body: { id } });
  assert.deepEqual([rf.d.code, rf.d.error], ["unavailable", "That cam isn't available right now."], rf.text);
  await CA.setMode("frankiefettuccine", "everyone");
});

test("padpepe: the 🐸 Pepe actions refuse a veiled entry (their command line would name them)", async () => {
  await setup;
  const R = bridge._rooms.get(ROOM.id);
  const Rp = Object.assign({}, R, { relay: true, cmds: { "!look": 0 }, pepe: { look: { on: true } } });
  const why = PP.refusal(Rp, "look", "frankiefettuccine");
  assert.ok(why && why.status === 404, "a veiled person is no target: " + JSON.stringify(why));
});

// ── 1.99aid (privacy controls S3): micfollow_cfg withheld_cover - incognito + live cam off stays the peek hood (owner Q1) ──
test("S3 (withheld_cover on): incognito + live cam off stays the PEEK hood - a veiled cam tile becomes its frog-name card in place (no relay), a new hold the hooded cover; never the named card, the cover picture or the login", async () => {
  await setup;
  MF._hide.clear();
  const SC = require(path.join(repo, "stagecover"));
  const asked = [], cov0 = SC.coverOf;
  SC.coverOf = (l) => { asked.push(String(l)); return cov0(l); };
  await MF.setCfg(ADM(), { withheld_cover: true, reason: "test" });
  try {
    await fresh();
    await syncAt({ rooms: [v2Room({ mic: true })] });
    for (let i = 0; i < 15 && !pad().state.tiles.some((x) => !x.cover); i++) await stepAt(3);
    const x0 = pad().state.tiles.find((x) => !x.cover);
    assert.ok(x0 && x0.login === "frankiefettuccine", "a veiled cam tile: " + JSON.stringify(pad().state.tiles.map((x) => x.login)));
    const vid = pad().vids.get("frankiefettuccine");
    await LC.setOptout("frankiefettuccine", true, { via: "web", ts: T + 30 });
    await stepAt(1);
    const x1 = pad().state.tiles.find((x) => x.login === "frankiefettuccine");
    assert.ok(x1, "no cut - the same tile");
    assert.deepEqual([x1.video, x1.why], ["card", "withheld"]);
    assert.equal(pad().vids.get("frankiefettuccine"), vid, "the same public id");
    assert.ok(![...LC._sessions.values()].some((S) => S.login === "frankiefettuccine" && !S.ended), "no relay of her cam");
    for (const [k, u] of Object.entries({ mem: U.mem, own: U.own, adm: U.adm })) {
      const r = await live(u);
      assert.deepEqual(leaks(r.text), [], k + ": " + leaks(r.text).join(", "));
      const t = (r.d.stage_program.src || []).find((s) => s.id === vid);
      assert.ok(t, k + ": her frog-name tile");
      assert.deepEqual([t.kind, t.veil, t.video, t.why, t.avatar, t.nameCss], ["cam", "incognito", "card", "off_cam", null, ""], k + ": the peek hood's card, 'cam off'");
      assert.ok(Number.isInteger(t.hood), k + ": its hood");
      assert.ok(!r.text.includes("/media/cover/"), k + ": no cover picture anywhere");
    }
    // she lets go; a new hold with live cam off: the hooded cover (never her named card)
    await syncAt({ rooms: [v2Room({ mic: false })] });
    for (let i = 0; i < 20 && pad().state.tiles.length; i++) await stepAt(3);
    assert.equal(pad().state.tiles.length, 0, "left");
    await syncAt({ rooms: [v2Room({ mic: true })] });
    for (let i = 0; i < 10 && !pad().state.tiles.some((x) => x.cover); i++) {
      await stepAt(3);
      assert.equal(pad().state.tiles.some((x) => !x.cover), false, "never a cam tile or her named card");
    }
    assert.equal(pad().state.tiles.filter((x) => x.cover).length, 1, "the hooded cover");
    assert.equal(asked.includes("frankiefettuccine"), false, "coverOf never asked about her");
  } finally {
    SC.coverOf = cov0;
    await LC.setOptout("frankiefettuccine", false, { via: "web", ts: T + 31 });
    await MF.setCfg(ADM(), { withheld_cover: false, reason: "test" });
  }
});

// ── 1.99aif (privacy controls round 5, the round-4 verify's low finding): withheld_cover AND incognito cams - a veiled cam whose person
// sets cam access to followers / on request becomes its WITHHELD peek-hood card; that card must read the same to every viewer who may
// see the tile at all (the named withheld card already does), or "cam off" vs "isn't available" tells a viewer whether the frog is
// someone they follow / granted. A viewer the person blocked and one who reported the tile keep today's treatment ──
test("round 5 (withheld_cover + incognito cams): a veiled WITHHELD card reads the same to a follower / someone granted and to everyone else; a blocked viewer and a reporter keep theirs", async () => {
  await setup;
  MF._hide.clear();
  if (!U.mem3) U.mem3 = await mkUser("mem3", "pleb", "mem3cf");
  if (!U.mem4) U.mem4 = await mkUser("mem4", "pleb", "mem4cf");
  const follows0 = (userId, ownerId) => require(path.join(repo, "follows")).isFollowing(String(userId), "user", String(ownerId));
  CA._setDeps({ follows: async (uid, ownerId) => String(uid) === U.mem.userId && String(ownerId) === U.frankie.userId });
  await CAMV.block("frankiefettuccine", "mem2", { byUserId: U.frankie.userId });       // (blocked by her - as the Q23 test left it)
  await MF.setCfg(ADM(), { withheld_cover: true, reason: "test" });
  try {
    for (const [mode, privileged] of [["followers", "a follower"], ["request", "someone she granted"]]) {
      if (mode === "request") await CA.allow("frankiefettuccine", { userId: U.mem.userId, username: "mem" });
      await CA.setMode("frankiefettuccine", "everyone");
      MF._hide.clear();
      await fresh();
      await syncAt({ rooms: [v2Room({ mic: true })] });
      for (let i = 0; i < 15 && !pad().state.tiles.some((x) => !x.cover && x.video !== "card"); i++) await stepAt(3);
      const vid = pad().vids.get("frankiefettuccine");
      assert.ok(vid && pad().state.tiles.some((x) => !x.cover && x.login === "frankiefettuccine"), mode + ": her veiled cam tile");
      await CA.setMode("frankiefettuccine", mode);
      for (let i = 0; i < 10 && !pad().state.tiles.some((x) => x.login === "frankiefettuccine" && x.why === "withheld"); i++) await stepAt(3);
      const x1 = pad().state.tiles.find((x) => x.login === "frankiefettuccine");
      assert.deepEqual(x1 && [x1.video, x1.why, !!x1.cover], ["card", "withheld", false], mode + ": the veiled tile is its withheld card");
      await stepAt(31);                                                                   // (past the viewer gate cache)
      const rp = await call("POST", `/api/rooms/${SLUG}/micfollow/report`, { user: U.mem4, body: { login: vid, reason: "other" } });
      assert.equal(rp.status, 200, rp.text);
      const entry = async (u) => {
        const r = await live(u);
        assert.deepEqual(leaks(r.text), [], mode + ": " + leaks(r.text).join(", "));
        return (r.d.stage_program.src || []).find((s) => s.id === vid) || null;
      };
      const p = await entry(U.mem), o = await entry(U.mem3), bl = await entry(U.mem2), rep = await entry(U.mem4);
      assert.ok(p && o && bl && rep, mode + ": every viewer has the tile");
      assert.deepEqual(p, o, mode + ": " + privileged + " and everyone else get the very same entry (no hint who the frog is)");
      assert.deepEqual([p.kind, p.veil, p.video, p.why, p.watch, p.avatar], ["cam", "incognito", "card", "off_cam", "ok", null], mode + ": the peek hood's card, 'cam off'");
      assert.equal(bl.watch, "unavailable", mode + ": a viewer she blocked - 'isn't available', as today");
      assert.equal(rep.watch, "hidden", mode + ": the reporter - hidden for them, as today");
    }
    // the switch off: the cam opt-out is today's cut again (no withheld card at all)
    await MF.setCfg(ADM(), { withheld_cover: false, reason: "test" });
    for (let i = 0; i < 4; i++) await stepAt(3);
    assert.equal(pad().state.tiles.some((x) => x.login === "frankiefettuccine" && x.why === "withheld"), false, "switch off: no withheld card");
  } finally {
    CA._setDeps({ follows: follows0 });
    try { await CA.disallow("frankiefettuccine", U.mem.userId); } catch (e) { /* none */ }
    await CA.setMode("frankiefettuccine", "everyone");
    await MF.setCfg(ADM(), { withheld_cover: false, reason: "test" });
  }
});

test("round 5: the sync answer says wcover: 1 only while micfollow_cfg withheld_cover is on (no privacy wire needed); Pepe reads the same key", async () => {
  await setup;
  const sync = () => call("POST", "/api/bridge/sync", { body: { password: "bot", events: [], rooms: [], hidden_h: [] } });
  await MF.setCfg(ADM(), { withheld_cover: false, reason: "test" });
  let r = await sync();
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.wcover, undefined, "off: no advert");
  await MF.setCfg(ADM(), { withheld_cover: true, reason: "test" });
  try {
    r = await sync();
    assert.equal(r.d.wcover, 1, "on: the advert");
    await PW.setOn(false, { userId: U.adm.userId, username: "adm" });
    r = await sync();
    assert.equal(r.d.wcover, 1, "privacy wire off: still said (S3 needs no privacy wire)");
    assert.equal(require(path.join(repo, "privacycopy")).flags().wcover, true, "the site's own copy flag (/help, /privacy) follows it");
  } finally {
    await PW.setOn(true, { userId: U.adm.userId, username: "adm" });
    await MF.setCfg(ADM(), { withheld_cover: false, reason: "test" });
  }
  r = await sync();
  assert.equal(r.d.wcover, undefined, "off again: gone");
  assert.equal(require(path.join(repo, "privacycopy")).flags().wcover, false);
  if (process.env.PEPE_BOT_DIR) {
    const bsrc = fs.readFileSync(path.join(process.env.PEPE_BOT_DIR, "pepe_bridge.py"), "utf8");
    assert.ok(bsrc.includes('rj.get("wcover")') && bsrc.includes("self._br_wc_advert(rj, now)"), "Pepe reads wcover from every sync answer (the same key)");
  }
});

// 1.99aih (privacy controls round 6 review): the one courtesy notice to someone staged under a FROG NAME, through the REAL step. stepPad
// sends it from its veiled-candidate loop and drops a candidate still at its notice gate from P.vnow at once, so courtesyPlan (which
// runs after the step) read them as named: the PM was queued under the pad OWNER's account (the ID-3 leak class 1.99aid V-1 closed on
// paper - their Download my data pairs the login with their pad's veiled speaker), and with withheld_cover on a _wh PM said "with your
// cover picture" / a _wc one "Cover picture instead" to someone the stage shows as a hooded frog. Round 6's own test set P.vnow by hand.
test("round 6 review: a frog-name candidate's one courtesy notice, through the real step - under Pepe's own account; with withheld_cover on its text says the hooded frog (each cam opt-out, and !livecam off's), never the cover picture", async () => {
  await setup;
  await runQuery(`INSERT OR IGNORE INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at)
                  VALUES ('pepe-bot', 'Pepe', 'Pepe', 'x', 'Bot', 0, NULL, 5, '2026-01-01 00:00:00')`);
  if (!IC.isOn()) await IC.setOn(true, { userId: U.adm.userId, username: "adm" });
  MF._hide.clear();
  let ts = T + 1000;
  const noop = async () => {};
  const SET = { none: [noop, noop],
                livecam: [() => LC.setOptout("frankiefettuccine", true, { via: "web", ts: ++ts }), () => LC.setOptout("frankiefettuccine", false, { via: "web", ts: ++ts })],
                mf: [() => MF.setOptout("frankiefettuccine", true), () => MF.setOptout("frankiefettuccine", false)],
                followers: [() => CA.setMode("frankiefettuccine", "followers"), () => CA.setMode("frankiefettuccine", "everyone")],
                request: [() => CA.setMode("frankiefettuccine", "request"), () => CA.setMode("frankiefettuccine", "everyone")] };
  const rowOf = async () => (await getQuery("SELECT user_id, args FROM pepe_actions WHERE kind = 'notify' ORDER BY id DESC LIMIT 1"))[0] || null;
  try {
    for (const [how, wc] of [["none", false], ["none", true], ["livecam", true], ["mf", true], ["followers", true], ["request", true]]) {
      const tag = how + (wc ? " (withheld_cover on)" : " (off)");
      await MF.setCfg(ADM(), { withheld_cover: wc, reason: "test" });
      await syncAt({ rooms: [v2Room({ mic: false })] });
      for (let i = 0; i < 40 && pad().state.tiles.length; i++) await stepAt(10);      // (a recent speaker's keep runs out)
      assert.equal(pad().state.tiles.length, 0, tag + ": set up - an empty stage " + JSON.stringify(pad().state.tiles.map((x) => [x.login, x.video, x.why, !!x.cover])));
      await runQuery("DELETE FROM pepe_actions WHERE kind = 'notify'");
      await MF._noticed(ROOM.id, "frankiefettuccine", null);                 // never told
      const [set, unset] = SET[how];
      await set();
      try {
        await fresh();
        await syncAt({ rooms: [v2Room({ mic: true })] });
        let r = null;
        for (let i = 0; i < 15 && !r; i++) { await stepAt(3); r = await rowOf(); }
        assert.ok(r, tag + ": told once");
        const [to, pm] = JSON.parse(r.args);
        assert.equal(to, "frankiefettuccine", tag + ": the PM goes to her login (Pepe sends it)");
        assert.equal(String(r.user_id), "pepe-bot", tag + ": queued under Pepe's own account, never the pad owner's (" + r.user_id + ")");
        assert.ok(pm.length <= 300, tag + ": " + pm.length);
        if (how !== "none") {
          assert.match(pm, /Your cam stays off mic stages: you can show in ~2 min as a hooded frog\. https:\/\/publicaccess\.tv\/p\//, tag + ": " + pm);
          assert.ok(!/cover picture/i.test(pm), tag + ": never the cover picture - " + pm);
        } else if (wc) {
          assert.match(pm, /Yours can show in ~2 min\. Hooded frog instead: !livecam off https:\/\/publicaccess\.tv\/p\//, tag + ": " + pm);
          assert.ok(!/cover picture/i.test(pm), tag + ": never the cover picture - " + pm);
        } else {
          assert.match(pm, /Yours can show in ~2 min\. Stop it everywhere: !livecam off https:\/\/publicaccess\.tv\/p\//, tag + ": the ordinary text, as before - " + pm);
        }
        assert.deepEqual(leaks(JSON.stringify(await live(U.own))), [], tag + ": the pad owner's page names nobody");
      } finally { await unset(); }
    }
  } finally {
    await MF.setCfg(ADM(), { withheld_cover: false, reason: "test" });
    await syncAt({ rooms: [v2Room({ mic: false })] });
    for (let i = 0; i < 40 && pad().state.tiles.length; i++) await stepAt(10);
    await MF._noticed(ROOM.id, "frankiefettuccine", T - D);
  }
});
