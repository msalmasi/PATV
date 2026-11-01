// wave 2: WP-4's mic-stage covers wired to WP-2's privacy wire v2 (veilstage.js; incognito / mic-stage spec F.4, E.1 / E.2 / E.6 +
// owner J-18, C.2, A.6). The stage half of track A's leak test (test/veil-site.test.js - the same harness and `leaks` rule, plus the
// stage's own keys), on a temp DB with the real bridge ingest, frog-name sessions, micfollow engine and see-through routes:
//   (d)  a v2 veiled PROVEN holder becomes a cover through the veil source: frog name + veil + hood on the page, the hood the same
//        index (and colour token) as that session's chat bubble; the identity only server-side
//   (f)  stage_program / /live with veiled fixtures - a B.1-stamped anonymous v1 holder (the neutral card), a v2 incognito holder
//        (a cover with its frog name), a v2 hidden holder (a shadow cover) - for every role: signed out (a Public pad), a member,
//        staff, the pad's owner, an admin and the person themself: no login, avatar, ref, key, session, display name or hash anywhere
//        but in the Reveal answer to an entitled viewer
//   (a)  POST /api/chatlog/reveal {room, tile}: an Admin or the pad's owner now; the line reveal's refusals (fetch-only, signed in,
//        role, rate limit) + the switch (409) + a cover shown now (404); no-store / no-referrer
//   (b)  each tile reveal = one seethrough_log row (stage_line, ref tile:<id>); while the J-18 toggle is on, {toggle: true} counts
//        on the toggle's row (chat_toggle - one toggle per pad for lines and tiles); off -> 409
//   (c)  the reveal source's role is the LIVE "owns the pad now" rule: an owner whose era nothing dates (no chat Reveal) still has
//        the stage Reveal; a former owner loses it at once, the new owner has it at once
//   follow-ups: a frog-name session that ends (off, a named sighting) takes its cover off AT ONCE - no "recent" linger, no identity
//        left for coverWho - and the stale R.mic entry never brings it back; a ✕ on a cover writes a stage_exclude row
//   dark: with the switch off the veil source gives nothing and the tile reveal refuses
//   node --test test/veil-stage.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "veil-stage-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
process.env.ALIAS_SECRET = "ab".repeat(32);
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
const ST = require(path.join(repo, "seethrough"));
const VS = require(path.join(repo, "veilstage"));
const V = require(path.join(repo, "veil"));
const LC = require(path.join(repo, "livecam"));
const W = require(path.join(repo, "webrtc"));
const PA = require(path.join(repo, "padaccess"));
const CA = require(path.join(repo, "camaccess"));
const stage = require(path.join(repo, "mainstage"));
const premium = require(path.join(repo, "premium"));
const MF = require(path.join(repo, "micfollow"));

const D = 864e5;
const hash = (login) => crypto.createHash("sha256").update("pepe-hidden:" + String(login).trim().toLowerCase()).digest("hex").slice(0, 20);
const ROOM = { id: "Stage.Room", name: "Stage Room" }, SLUG = "stage-room";
const ALIAS_RE = /^(?:[A-Z][A-Za-z-]{1,15} [A-Z][A-Za-z]{1,15}|Mystery Frog \d{1,4})$/;
const REF = "anon-3f9a1c2e";                       // Pepe's per-hold ref of a v1 anonymous holder
const COVER_KEYS = new Set(["kind", "id", "name", "hood", "veil", "pos", "newest", "since", "video", "watch", "recent", "ring", "rv", "ex", "self"]);
const users = new Map();
const U = {};
let base, server, seq = 0;
let T = Date.now();
W.enabled = () => true;
premium.bridgeAllowed = () => true;
MF._setClock(() => T);
MF._setBoot(0);
LC._setClock(() => T);
stage._setClock(() => T);
LC._setKick(() => {});

const ev = (type, data, ts = T) => ({ op: "event", id: "vst-" + (++seq), ts: new Date(ts).toISOString(), type, scope: { platform: "camfrog", room: ROOM }, data });
const real = (login, display) => ({ id: login.toLowerCase(), login, display: display || login });
const priv = (kind, login, extra = {}) => Object.assign({ kind, h: hash(login), at: T / 1000 }, extra);
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
/** One of Pepe's syncs, ingested at the test clock (the engine, the frog-name sessions and the feed all read Date.now() then). */
async function syncAt(body, v2 = true) {
  const realNow = Date.now;
  Date.now = () => T;
  try { return await bridge.ingest(Object.assign({ events: [], rooms: [], bridge_hidden_h: [], incog_hidden_h: [] }, body), { v2 }); }
  finally { Date.now = realNow; }
}
/** Pepe's live-cam poll and his last sync at the test clock now. */
async function fresh() {
  await LC.forBot({ cap: true, mf: 1, live: [] }, T);
  Object.assign(bridge._rooms.get(ROOM.id), { updated: T, cams: true, livecams: true });
}
/** One engine step `sec` seconds on (Pepe's live-cam poll fresh, his last sync just now). */
async function stepAt(sec) {
  T += sec * 1000;
  await fresh();
  MF.stepPad(ROOM.id, T);
  await MF._idle(); await settle(10);
}
/** integration review (T-5): the test clock jumps `ms` - with Pepe kept fresh - and the pad steps at it, as micfollow's own 1 s
 *  timer may do at any moment (a step at a jumped clock with a stale Pepe would cut every cover: whyOff 'pepe'). */
async function jump(ms) {
  T += ms;
  await fresh();
  MF.stepPad(ROOM.id, T);
  await MF._idle(); await settle(10);
}
/** The covers up now -> {frankie: id, hank: id} (from the pad's own state - no ids carried over from an earlier test); brings them
 *  up again from a fresh v2 sync when they aren't. */
async function coverIds() {
  const read = () => {
    const out = {};
    for (const c of pad().covers.values()) {
      const w = MF.coverWho(ROOM.id, c.id);
      if (w && w.login === "frankiefettuccine") out.frankie = c.id;
      if (w && w.login === "hankhidden") out.hank = c.id;
    }
    return out;
  };
  let ids = read();
  if (!ids.frankie || !ids.hank) {
    await syncAt({ rooms: [v2Room()] });
    for (let i = 0; i < 10 && !((ids = read()).frankie && ids.hank); i++) await stepAt(3);
  }
  return ids;
}
const pad = () => MF._pads.get(ROOM.id);
const coverTiles = () => pad().state.tiles.filter((x) => x.cover);
/** The v2 snapshot: alice named, frankie incognito and hank hidden - both PROVEN holders. */
const FRANKIE = () => Object.assign(real("frankiefettuccine", "Frankie Fett"), { priv: priv("incognito", "frankiefettuccine") });
const HANK = () => Object.assign(real("hankhidden", "Hank Hide"), { priv: priv("hidden", "hankhidden") });
function v2Room(mic) {
  return { room: ROOM, cams: true, livecams: true, count: 3, transcripts: true,
           members: [real("alicecf", "Alice"), Object.assign(FRANKIE(), { src: "list", on_mic: true }), Object.assign(HANK(), { src: "list", on_mic: true })],
           mic: (mic || [FRANKIE(), HANK()]).map((u) => Object.assign(u, { proven: true, since: T / 1000 - 5 })) };
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
const reveal = (user, body, headers) => call("POST", "/api/chatlog/reveal", { user, body: Object.assign({ room: SLUG }, body), headers });
// what never reaches a page (track A's rule + the stage's own keys): the veiled people, their hashes, Pepe's hold ref, the
// engine's cover key, a session field, the identity side props
const VEILED = ["frankiefettuccine", "Frankie Fett", "hankhidden", "Hank Hide"];
const leaks = (json) => [...VEILED, ...VEILED.map(hash), REF, "~cv:", "\"sess\"", "\"session\"", "\"_vz\"", "\"vz\"", "\"vw\"", "\"priv\"", "\"ah\"", "\"ahs\"", "\"ref\""]
  .filter((x) => json.includes(x));
// (the person themself: their OWN login comes back in their own answer - the page's "me" - never in the stage program)
const OWN = { frankie: ["frankiefettuccine", hash("frankiefettuccine")], hank: ["hankhidden", hash("hankhidden")] };
const leaksFor = (k, json) => leaks(json).filter((x) => !(OWN[k] || []).includes(x));
const ADM = () => ({ userId: U.adm.userId, username: "adm", class: "Admin" });

const setup = (async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, avatar TEXT, archived_at INTEGER)`);
  await require(path.join(repo, "inbox")).ready;
  U.own = await mkUser("own", "pleb", "owncf");
  U.own2 = await mkUser("own2", "pleb", "own2cf");
  U.mem = await mkUser("mem", "pleb", "memcf");
  U.staff = await mkUser("helper", "Staff");
  U.adm = await mkUser("adm", "Admin", "admcf");
  U.frankie = await mkUser("frankie", "pleb", "frankiefettuccine");      // the incognito holder's own account (self)
  U.hank = await mkUser("hank", "pleb", "hankhidden");                   // the hidden holder's own account (self)
  await rooms.init();
  const app = express();
  app.use((req, res, next) => (req.path === "/api/bridge/sync" || req.path === "/api/bridge/sync/v2" ? next() : express.json()(req, res, next)));
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  bridge.register(app, { addUser, isBotToken: (t) => t === "bot" });     // (registers micfollow and wires veilstage)
  PW.register(app, { addUser, noTimers: true });
  ST.register(app, { addUser, noTimers: true });
  await new Promise((r) => { server = app.listen(0, r); });
  server.unref();
  base = "http://127.0.0.1:" + server.address().port;
  CL._setClock(() => Date.now() - 8 * D);
  await CL.setSwitch("notice", true, "test");
  CL._setClock(() => Date.now());
  for (const s of ["archive", "history"]) await CL.setSwitch(s, true, "test");
  await PW.init();
  await PW.setOn(true, { userId: U.adm.userId, username: "adm" });
  // the pad, its owner, Public (a signed-out visitor gets /live), mic follows on with covers
  await syncAt({ rooms: [{ room: ROOM, cams: true, livecams: true, members: [real("alicecf", "Alice")], mic: [], count: 1 }] }, false);
  for (let i = 0; i < 20 && !(await rooms.get(ROOM.id)); i++) await settle(20);
  await rooms.setOwner(ROOM.id, "own", "test");
  await PA.init();
  await PA.setLevel({ userId: U.own.userId, username: "own" }, { id: ROOM.id }, "public");
  await stage.init();
  await LC.init();
  await LC.save(ADM(), { cfg: { enabled: true } });
  await CA.init();
  await MF._ready();
  await MF.setKill(ADM(), true, "test");
  await MF.setCfg(ADM(), { covers: true, reason: "test" });
  await MF.setPad(ROOM.id, { on: true }, "test");
  await CV.init();
  CV._clearCaches();
})();

test("veilstage.veilSource: only a veiled R.mic entry with its identity, while the switch is on and its frog-name session is the open one", async () => {
  await setup;
  const R = { id: ROOM.id };
  const view = await FN.sight(ROOM.id, "unitcf", { t: Date.now(), active: false, avoidNames: [] });
  const entry = (vz, extra) => V.hide(Object.assign({ anon: true, display: "someone", veil: "incognito", alias: view.alias, hood: view.hood }, extra || {}), "_vz",
                                      Object.assign({ login: "unitcf", display: "Unit", kind: "incognito", sess: view.session, proven: true, since: 123 }, vz || {}));
  const v = VS.veilSource(entry(), R);
  assert.deepEqual(v, { veil: "incognito", alias: view.alias, hood: view.hood, since: 123, proven: true, sess: String(view.session), began_named: false,
                        login: "unitcf", display: "Unit" });
  assert.equal(JSON.stringify(entry()).includes("unitcf"), false, "the identity is non-enumerable on the entry");
  assert.equal(VS.veilSource(entry({ beganNamed: true }), R).began_named, true, "began_named passes through (micfollow refuses it)");
  assert.equal(VS.veilSource(entry({ proven: false }), R).proven, false);
  assert.equal(VS.veilSource({ anon: true, display: "someone", veil: "incognito" }, R), null, "no identity: nothing (a v1 entry)");
  assert.equal(VS.veilSource({ login: "alicecf", display: "Alice", proven: true }, R), null, "a named holder: nothing");
  assert.equal(VS.veilSource(entry({ sess: view.session + 999 }), R), null, "not the person's open session: nothing");
  assert.deepEqual([VS.veilSource(entry({}, { alias: undefined, hood: 3 }), R).alias, VS.veilSource(entry({}, { alias: undefined, hood: 3 }), R).hood], [null, null],
                   "no frog name: no hood from the entry either (micfollow picks one)");
  await PW.setOn(false, { userId: U.adm.userId, username: "adm" });
  try { assert.equal(VS.veilSource(entry(), R), null, "switch off: nothing (dark)"); }
  finally { await PW.setOn(true, { userId: U.adm.userId, username: "adm" }); }
  await FN.off("unitcf", ROOM.id);
  assert.equal(VS.veilSource(entry(), R), null, "an ended session: nothing");
});

test("(f) a B.1-stamped anonymous v1 holder is the neutral card for every role - never a cover, never its hold ref", async () => {
  await setup;
  await syncAt({ rooms: [{ room: ROOM, cams: true, livecams: true, count: 2, members: [real("alicecf", "Alice"), { anonymous: true, id: REF, display: "someone" }],
                           mic: [{ anonymous: true, id: REF, display: "someone" }] }] }, false);
  bridge._k3Refs.set(ROOM.id, new Map([[REF, T]]));
  try {
    for (let i = 0; i < 4; i++) await stepAt(3);
    assert.deepEqual(pad().state.tiles, [], "no tile");
    assert.equal(pad().covers.size, 0, "no cover");
    assert.equal(pad().state.oseen.size, 1, "an `others` entry - today's neutral path (the card / strip when tiles were up)");
    for (const [k, u] of Object.entries({ anon: null, mem: U.mem, staff: U.staff, own: U.own, adm: U.adm, frankie: U.frankie })) {
      const r = await live(u);
      assert.equal(r.status, 200, k + ": " + r.text.slice(0, 200));
      assert.deepEqual(leaksFor(k, r.text), [], k + ": " + leaksFor(k, r.text).join(", "));
      const sp = r.d.stage_program;
      assert.deepEqual(leaks(JSON.stringify(sp)), [], k + ": the stage program");
      assert.ok(sp && !(sp.src || []).some((s) => s.kind === "cover"), k + ": no cover");
    }
  } finally { bridge._k3Refs.delete(ROOM.id); }
});

let covers = null;          // {frankie: id, hank: id} of the covers up after the next test
test("(d) + (f) v2 incognito / hidden PROVEN holders are covers - frog name, veil, the session's own hood (= its chat bubble's); every role's /live carries no identity; Reveal / ✕ flags only for the owner and admins, self for the person", async () => {
  await setup;
  await syncAt({ rooms: [v2Room()] });
  await syncAt({ events: [ev("message", { user: real("frankiefettuccine", "Frankie Fett"), text: "frog on the mic", priv: priv("incognito", "frankiefettuccine") })] });
  for (let i = 0; i < 10 && coverTiles().length < 2; i++) await stepAt(3);
  assert.equal(coverTiles().length, 2, "both proven veiled holders are covers: " + JSON.stringify(pad().state.tiles.map((x) => x.login)));
  const R = bridge._rooms.get(ROOM.id);
  const fz = R.mic.find((e) => e._vz && e._vz.login === "frankiefettuccine"), hz = R.mic.find((e) => e._vz && e._vz.login === "hankhidden");
  assert.ok(fz && fz.anon && fz.veil === "incognito" && ALIAS_RE.test(fz.alias) && Number.isInteger(fz.hood), "page-safe veil / alias / hood on R.mic's entry");
  const views = {};
  for (const [k, u] of Object.entries({ anon: null, mem: U.mem, staff: U.staff, own: U.own, adm: U.adm, frankie: U.frankie, hank: U.hank })) {
    const r = await live(u);
    assert.equal(r.status, 200, k + ": " + r.text.slice(0, 200));
    assert.deepEqual(leaksFor(k, r.text), [], k + " sees nothing of who: " + leaksFor(k, r.text).join(", "));
    assert.deepEqual(leaks(JSON.stringify(r.d.stage_program)), [], k + ": the stage program never");
    views[k] = r.d;
  }
  assert.deepEqual(views.anon.stage_program.src, [], "signed out: the program asks to sign in, no tiles");
  const cv = (k) => views[k].stage_program.src.filter((s) => s.kind === "cover");
  for (const k of ["mem", "staff", "own", "adm", "frankie", "hank"]) {
    const cs = cv(k);
    assert.equal(cs.length, 2, k);
    for (const c of cs) {
      for (const key of Object.keys(c)) assert.ok(COVER_KEYS.has(key), k + ": a cover carries " + key);
      assert.match(c.id, /^anon-[0-9a-f]{8}$/);
      assert.ok(ALIAS_RE.test(c.name), k + ": the frog name " + c.name);
    }
    const f = cs.find((c) => c.veil === "incognito"), h = cs.find((c) => c.veil === "hidden");
    assert.ok(f && h, k + ": an incognito (peek) cover and a hidden (shadow) cover");
    assert.equal(f.name, fz.alias); assert.equal(f.hood, fz.hood, "the cover's hood is the session's");
    const want = k === "own" || k === "adm" ? 1 : undefined;
    assert.deepEqual([f.rv, f.ex, h.rv, h.ex], [want, want, want, want], k + ": Reveal / ✕ only for the owner and admins");
    assert.equal(f.self, k === "frankie" ? 1 : undefined, k + ": 'this is you' only for the person");
    assert.equal(h.self, k === "hank" ? 1 : undefined, k);
  }
  // the chat bubble of the same session: the same frog name and the same hood index (chatlog-core draws hood-*-N / .hdN from it)
  const line = views.mem.feed.find((o) => o.k === "msg" && o.text === "frog on the mic");
  assert.ok(line && line.u.alias === fz.alias && line.u.hood === fz.hood, "chat bubble = stage cover: " + JSON.stringify(line && line.u));
  // the server keeps who (for the Reveal), never the program
  const f = cv("mem").find((c) => c.veil === "incognito"), h = cv("mem").find((c) => c.veil === "hidden");
  assert.deepEqual(MF.coverWho(ROOM.id, f.id), { login: "frankiefettuccine", display: "Frankie Fett" });
  assert.deepEqual(MF.coverWho(ROOM.id, h.id), { login: "hankhidden", display: "Hank Hide" });
  covers = { frankie: f.id, hank: h.id };
  // a mic-stage capture's program never carries the flags (stagemiccap: surface "capture")
  const cap = JSON.stringify(await bridge.stageProgramFor(ROOM.id, U.adm.userId));
  assert.deepEqual(leaks(cap), []);
  assert.ok(!cap.includes("\"rv\"") && !cap.includes("\"ex\""), "no Reveal / ✕ on a capture");
});

test("(a) + (b) POST /api/chatlog/reveal {room, tile}: an admin / the owner get who (one stage_line row each); members, staff, signed out, another pad's owner, a non-fetch call, an unknown tile, the switch off are refused - and no refusal names anyone", async () => {
  await setup;
  assert.ok(covers, "covers are up");
  const n0 = (await getQuery("SELECT COUNT(*) AS n FROM seethrough_log"))[0].n;
  await live(U.adm); await live(U.own);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM seethrough_log"))[0].n, n0, "viewing writes nothing");
  const r = await reveal(U.adm, { tile: covers.frankie, reason: "report #9" });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.d.ok, r.d.tile, r.d.login, r.d.display, r.d.account], [true, covers.frankie, "frankiefettuccine", "Frankie Fett", "/admin/users?q=frankie"]);
  assert.match(String(r.headers["cache-control"] || ""), /private/);
  assert.match(String(r.headers["cache-control"] || ""), /no-store/);
  assert.equal(r.headers["referrer-policy"], "no-referrer");
  let row = (await getQuery("SELECT * FROM seethrough_log ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual([row.scope, row.role, row.room_id, row.reason, row.ref, JSON.parse(row.logins), row.user_id], ["stage_line", "admin", ROOM.id, "report #9", "tile:" + covers.frankie, ["frankiefettuccine"], U.adm.userId]);
  const ro = await reveal(U.own, { tile: covers.hank });
  assert.equal(ro.status, 200, ro.text);
  assert.deepEqual([ro.d.login, ro.d.account], ["hankhidden", undefined], "the owner: who, no account link");
  row = (await getQuery("SELECT * FROM seethrough_log ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual([row.scope, row.role, JSON.parse(row.logins)], ["stage_line", "owner", ["hankhidden"]]);
  const n1 = (await getQuery("SELECT COUNT(*) AS n FROM seethrough_log"))[0].n;
  const refusals = [
    ["a member", U.mem, { tile: covers.frankie }, 403], ["staff (J-2)", U.staff, { tile: covers.frankie }, 403], ["signed out", null, { tile: covers.frankie }, 401],
    ["another pad's owner", U.own2, { tile: covers.frankie }, 403], ["the person themself", U.frankie, { tile: covers.frankie }, 403],
    ["an unknown tile", U.adm, { tile: "anon-ffffffff" }, 404], ["a login as the tile", U.adm, { tile: "frankiefettuccine" }, 404],
    ["no such pad", U.adm, { tile: covers.frankie, room: "nope" }, 404],
  ];
  for (const [what, u, body, status] of refusals) {
    const x = await reveal(u, body);
    assert.equal(x.status, status, what + ": " + x.text);
    assert.deepEqual(leaks(x.text), [], what);
  }
  const nf = await reveal(U.adm, { tile: covers.frankie }, { "x-requested-with": "" });
  assert.equal(nf.status, 403, "fetch only");
  await PW.setOn(false, { userId: U.adm.userId, username: "adm" });
  try {
    const off = await reveal(U.adm, { tile: covers.frankie });
    assert.equal(off.status, 409, "the switch off: nothing reveals");
    assert.equal(off.d.code, "privwire_off");
    assert.deepEqual(leaks(off.text), []);
  } finally { await PW.setOn(true, { userId: U.adm.userId, username: "adm" }); }
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM seethrough_log"))[0].n, n1, "a refusal writes nothing");
  // (b) the J-18 toggle - ONE per pad for its lines and its tiles: {toggle: true} counts on the chat_toggle row, no row of its own
  assert.equal((await reveal(U.adm, { tile: covers.hank, toggle: true })).status, 409, "toggle off: no toggle fetch");
  assert.equal((await reveal(U.adm, { tile: covers.hank, toggle: true })).d.code, "toggle_off");
  const on = await call("POST", "/api/chatlog/seethrough", { user: U.adm, body: { room: SLUG, on: true, reason: "sweep" } });
  assert.equal(on.status, 200, on.text);
  const tg = (await getQuery("SELECT * FROM seethrough_log WHERE scope = 'chat_toggle' AND ended IS NULL ORDER BY id DESC LIMIT 1"))[0];
  const nT = (await getQuery("SELECT COUNT(*) AS n FROM seethrough_log"))[0].n;
  const t1 = await reveal(U.adm, { tile: covers.hank, toggle: true });
  assert.equal(t1.status, 200, t1.text);
  assert.equal(t1.d.login, "hankhidden");
  const after = (await getQuery("SELECT * FROM seethrough_log WHERE id = ?", [tg.id]))[0];
  assert.deepEqual([after.n, JSON.parse(after.logins)], [1, ["hankhidden"]], "counted on the toggle's row");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM seethrough_log"))[0].n, nT, "no stage_line row while the toggle is on");
  await call("POST", "/api/chatlog/seethrough", { user: U.adm, body: { room: SLUG, on: false } });
  assert.equal((await reveal(U.adm, { tile: covers.hank, toggle: true })).status, 409, "off again");
});

test("(c) the stage Reveal follows who owns the pad NOW - an owner whose era nothing dates keeps it (no chat Reveal), a former owner loses it at once, the new owner has it", async () => {
  await setup;
  assert.ok(covers);
  const flag = async (u) => (await live(u)).d.stage_program.src.find((s) => s.id === covers.frankie).rv;
  // nothing dates the ownership (owner_since 0, no 'owner' event): the chat's owner-era rule says no - the live stage still yes
  await runQuery("UPDATE chatlog_rooms SET owner_since = 0 WHERE room_id = ?", [ROOM.id]);
  await runQuery("DELETE FROM room_events WHERE room_id = ? AND what = 'owner'", [ROOM.id]);
  assert.equal(await ST.chatRole(U.own, ROOM.id), null, "(no chat Reveal for this owner)");
  assert.equal(await VS.stageRole(U.own, ROOM.id), "owner");
  await jump(31e3);                                // (micfollow caches a viewer's role 30 s)
  assert.equal(await flag(U.own), 1);
  assert.equal((await reveal(U.own, { tile: covers.frankie })).status, 200);
  // integration review (T-3): ONE toggle, ONE rule - this owner can't turn "Show real names" on (the chat's rule), so the toggle's
  // auto-reveal says toggle_na (the page never offers them the bar); someone who could turn it on gets toggle_off
  const na = await reveal(U.own, { tile: covers.frankie, toggle: true });
  assert.deepEqual([na.status, na.d.code], [409, "toggle_na"], na.text);
  assert.deepEqual(leaks(na.text), []);
  assert.equal((await call("POST", "/api/chatlog/seethrough", { user: U.own, body: { room: SLUG, on: true } })).status, 403, "(and indeed can't)");
  assert.equal((await reveal(U.adm, { tile: covers.frankie, toggle: true })).d.code, "toggle_off");
  // the pad changes hands: the old owner is refused at once, the new one gets it
  await rooms.setOwner(ROOM.id, "own2", "test");
  await jump(31e3);
  assert.equal(await VS.stageRole(U.own, ROOM.id), null);
  assert.equal(await flag(U.own), undefined, "a former owner: no Reveal");
  assert.equal((await reveal(U.own, { tile: covers.frankie })).status, 403);
  assert.equal(await flag(U.own2), 1, "the new owner: Reveal");
  assert.equal((await reveal(U.own2, { tile: covers.frankie })).status, 200);
  await rooms.setOwner(ROOM.id, "own", "test");
  await jump(31e3);
  assert.ok(MF.coverWho(ROOM.id, covers.frankie) && MF.coverWho(ROOM.id, covers.hank), "(T-5) steps at every jump: the same two covers stay up");
});

test("integration review (P1 / T-1): a by-name exclusion never touches a cover - staff (no see-through) excluding a wrong guess and the right one see the same cover program; nothing in the see-through log", async () => {
  await setup;
  const ids = await coverIds();
  assert.ok(ids.frankie && ids.hank, "two covers up");
  const prog = async (u) => (await live(u)).d.stage_program.src.filter((s) => s.kind === "cover").map((s) => ({ id: s.id, name: s.name, veil: s.veil, recent: !!s.recent }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const n0 = (await getQuery("SELECT COUNT(*) AS n FROM seethrough_log"))[0].n;
  const before = { staff: await prog(U.staff), mem: await prog(U.mem) };
  assert.equal(before.staff.length, 2);
  const guess = async (body) => {
    const login = body.login || (body.kind === "patv" ? "frankiefettuccine" : body.name);
    try {
      const x = await call("POST", `/api/rooms/${SLUG}/micfollow/exclude`, { user: U.staff, body: Object.assign({ hours: 1 }, body) });
      assert.equal(x.status, 200, x.text);
      assert.deepEqual(leaks(x.text).filter((l) => l !== login), [], "(only the name they typed, in their own by-name row)");
      await stepAt(1); await stepAt(1);
      return { staff: await prog(U.staff), mem: await prog(U.mem) };
    } finally {
      const rm = await call("POST", `/api/rooms/${SLUG}/micfollow/exclude`, { user: U.staff, body: { login, remove: true } });
      assert.equal(rm.status, 200, rm.text);
    }
  };
  assert.deepEqual(await guess({ login: "bobguess" }), before, "a wrong guess");
  assert.deepEqual(await guess({ login: "frankiefettuccine" }), before, "the right guess by Camfrog name: the very same program (no 'recent' cover)");
  assert.deepEqual(await guess({ name: "frankie", kind: "patv" }), before, "the right guess by PATV name: the same");
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM seethrough_log"))[0].n, n0, "nothing to log - nothing was seen");
});

test("follow-up: a ✕ on a cover (a veiled exclusion matches their later named cam - it says who it was) writes a stage_exclude row first", async () => {
  await setup;
  await stepAt(1);                                 // (Pepe's sync fresh again: the clock moved on in the tests above)
  covers = await coverIds();                       // (integration review T-5: this test's own covers, read now - none carried over)
  assert.ok(covers.hank && covers.frankie, "two covers are up");
  const n0 = (await getQuery("SELECT COUNT(*) AS n FROM seethrough_log WHERE scope = 'stage_exclude'"))[0].n;
  // staff (who may manage the stage but have no see-through) and members can't, and nothing is written
  for (const u of [U.staff, U.mem]) {
    const x = await call("POST", `/api/rooms/${SLUG}/micfollow/exclude`, { user: u, body: { tile: covers.hank, hours: 1 } });
    assert.equal(x.status, 403, u.username + ": " + x.text);
    assert.deepEqual(leaks(x.text), []);
  }
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM seethrough_log WHERE scope = 'stage_exclude'"))[0].n, n0, "a refused ✕ writes nothing");
  const r = await call("POST", `/api/rooms/${SLUG}/micfollow/exclude`, { user: U.adm, body: { tile: covers.hank, hours: 1 } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(leaks(r.text), [], "the manager's answer never names them");
  const rows = await getQuery("SELECT * FROM seethrough_log WHERE scope = 'stage_exclude' ORDER BY id");
  assert.equal(rows.length, n0 + 1, "one row");
  const row = rows[rows.length - 1];
  assert.deepEqual([row.role, row.room_id, row.ref, JSON.parse(row.logins), row.reason], ["admin", ROOM.id, "tile:" + covers.hank, ["hankhidden"], "kept off: 1 h"]);
  assert.ok(!coverTiles().some((x) => pad().covers.get(x.login) && pad().covers.get(x.login).id === covers.hank), "the cover came off");
  // the owner's ✕ is the owner's row
  const own = await call("POST", `/api/rooms/${SLUG}/micfollow/exclude`, { user: U.own, body: { tile: covers.frankie, hours: 0 } });
  assert.equal(own.status, 200, own.text);
  const last = (await getQuery("SELECT * FROM seethrough_log WHERE scope = 'stage_exclude' ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual([last.role, last.user_id, JSON.parse(last.logins), last.reason], ["owner", U.own.userId, ["frankiefettuccine"], "kept off: always"]);
  // integration review (P2 / P3): staff's list carries no xid (they can't lift); a lift needs the see-through rule - staff are refused
  // and nothing is written - and each lift is a stage_exclude row of its own (lifting shows their named cam again: it says who)
  const stf = await call("POST", `/api/rooms/${SLUG}/micfollow/exclude`, { user: U.staff, body: { login: "nobodycf", hours: 1 } });
  assert.equal(stf.status, 200, stf.text);
  const stVeiled = stf.d.state.excluded.filter((e) => e.login == null);
  assert.equal(stVeiled.length, 2, "staff see the two 🕶 rows");
  assert.ok(stVeiled.every((e) => !("xid" in e)), "with no xid: " + JSON.stringify(stVeiled));
  assert.equal((await call("POST", `/api/rooms/${SLUG}/micfollow/exclude`, { user: U.staff, body: { login: "nobodycf", remove: true } })).status, 200);
  const owned = (await MF.ownerState(ROOM.id, undefined, { viewerId: U.own.userId })).excluded.filter((e) => e.login == null);
  assert.ok(owned.length === 2 && owned.every((e) => /^[0-9a-f]{16}$/.test(e.xid)), "the owner's list has them");
  const n2 = (await getQuery("SELECT COUNT(*) AS n FROM seethrough_log WHERE scope = 'stage_exclude'"))[0].n;
  const sl = await call("POST", `/api/rooms/${SLUG}/micfollow/exclude`, { user: U.staff, body: { xid: owned[0].xid, remove: true } });
  assert.deepEqual([sl.status, sl.d.code], [403, "cover"], sl.text);
  assert.deepEqual(leaks(sl.text), []);
  assert.equal((await MF.ownerState(ROOM.id, undefined, { lift: true })).excluded.filter((e) => e.login == null).length, 2, "still there");
  const ol = await call("POST", `/api/rooms/${SLUG}/micfollow/exclude`, { user: U.own, body: { xid: owned[0].xid, remove: true } });
  assert.equal(ol.status, 200, ol.text);
  assert.deepEqual(leaks(ol.text), []);
  const lr = await getQuery("SELECT * FROM seethrough_log WHERE scope = 'stage_exclude' ORDER BY id");
  assert.equal(lr.length, n2 + 1, "one row for the lift");
  assert.deepEqual([lr[lr.length - 1].role, lr[lr.length - 1].user_id, lr[lr.length - 1].ref], ["owner", U.own.userId, "lift:" + owned[0].xid]);
  for (const e of (await MF.ownerState(ROOM.id, undefined, { lift: true })).excluded) if (e.xid) await MF.unexcludeXid(ROOM.id, e.xid);
  covers = null;
});

test("follow-up (un-veil linkability): a frog-name session that ends takes its cover off AT ONCE - no 'recent' tile, no identity for coverWho - and the stale R.mic entry never brings it back", async () => {
  await setup;
  // fresh covers (new sessions after the exclusions above were lifted: a new appearance, an hour later)
  T += 2 * 3600e3;
  await FN.sweep(T);
  for (const l of ["frankiefettuccine", "hankhidden"]) await FN.off(l, ROOM.id);
  await syncAt({ rooms: [v2Room()] });
  for (let i = 0; i < 10 && coverTiles().length < 2; i++) await stepAt(3);
  assert.equal(coverTiles().length, 2, "two covers again");
  assert.equal(pad().settings.keep_recent > 0, true, "(the pad keeps recent speakers - a released tile would linger)");
  const idOf = (login) => {
    const R = bridge._rooms.get(ROOM.id);
    const e = R.mic.find((x) => x._vz && x._vz.login === login);
    const key = "~cv:s" + e._vz.sess;
    return { key, id: pad().covers.get(key) && pad().covers.get(key).id };
  };
  const f = idOf("frankiefettuccine"), h = idOf("hankhidden");
  assert.ok(f.id && h.id);
  // (1) off: incognito off / un-hidden / forget-me / the A-privacy-5 switch all end the session through frognames.off
  await FN.off("frankiefettuccine", ROOM.id);
  const shown = () => MF.snapshot(ROOM.id).tiles.filter((x) => x.cover).map((x) => x.cid);
  assert.ok(!pad().state.tiles.some((x) => x.login === f.key), "off at once - before any step");
  assert.ok(!shown().includes(f.id), "not in the program (not even as a 'recent' tile)");
  assert.equal(MF.coverWho(ROOM.id, f.id), null, "no identity left behind it");
  assert.equal((await reveal(U.adm, { tile: f.id })).status, 404, "nothing to reveal");
  for (let i = 0; i < 7; i++) await stepAt(5);    // (past the cut's cooldown_s: 20 s)
  assert.ok(!pad().state.tiles.some((x) => x.login === f.key), "the stale R.mic entry (its ended session) doesn't bring it back");
  assert.ok(!coverTiles().some((x) => !pad().covers.get(x.login) || pad().covers.get(x.login).id === f.id), "and no tile with its id");
  assert.ok(shown().includes(h.id), "the other cover stays");
  // (2) a NAMED sighting of the other one (a named line by the same login) ends their session: that cover goes at once too
  await syncAt({ events: [ev("message", { user: real("hankhidden", "Hank Hide"), text: "hi it's me" })] });
  // (veil.namedSeen ends the session fire-and-forget on frognames' per-room chain: wait - real time, the test clock stands still -
  // for it to land; no engine step runs meanwhile)
  for (let end = Date.now() + 3000; FN.current(ROOM.id, "hankhidden") && Date.now() < end;) await settle(10);
  assert.equal(FN.current(ROOM.id, "hankhidden"), null, "the named line ended their session");
  assert.ok(!pad().state.tiles.some((x) => x.login === h.key), "a named sighting: off at once");
  assert.ok(!shown().includes(h.id), "no 'recent' linger");
  assert.equal(MF.coverWho(ROOM.id, h.id), null);
  for (let i = 0; i < 7; i++) await stepAt(5);
  assert.equal(coverTiles().length, 0, "no cover comes back from the stale entries");
});

test("integration review (T-4): a veiled holder's hold start is clamped exactly like a named one's (bridge.cleanMic) - Pepe's clock 55 s fast puts both at the sync's time + 5 s; 7 h back, both at - 6 h", async () => {
  await setup;
  for (const [what, since, want] of [["55 s ahead", T / 1000 + 55, T + 5000], ["7 h back", T / 1000 - 7 * 3600, T - 6 * 3600e3]]) {
    await syncAt({ rooms: [{ room: ROOM, cams: true, livecams: true, count: 2, transcripts: true,
                             members: [real("alicecf", "Alice"), Object.assign(FRANKIE(), { src: "list", on_mic: true })],
                             mic: [Object.assign(real("alicecf", "Alice"), { proven: true, since }), Object.assign(FRANKIE(), { proven: true, since })] }] });
    const R = bridge._rooms.get(ROOM.id);
    const named = R.mic.find((u) => u.login === "alicecf"), veiled = R.mic.find((u) => u._vz && u._vz.login === "frankiefettuccine");
    assert.ok(named && veiled, what);
    assert.equal(named.since, want, what + ": the named holder (cleanMic)");
    assert.equal(veiled._vz.since, want, what + ": the veiled holder - the same clamp");
    const v = VS.veilSource(veiled, R);
    assert.ok(v, what + ": the veil source sees the hold");
    assert.equal(v.since, want, what + ": what micfollow ranks the cover by");
  }
});
