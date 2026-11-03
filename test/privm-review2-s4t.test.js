// 1.99aid (privacy controls, review fixes 2 - RV-D; G:/ops/privacy-controls-spec-2026-11-02.md section 8, the owner's "yes" to staff and
// room mods revealing blacked-out text): with text_reveal_roles on, a revealed veiled 🎙 line offers "Save as evidence" only to a role
// evidence.js lets save (an admin, the pad's owner), and a "Show real names" batch counts once against the non-admin limit. On the
// S4t harness (privm-s4t.test.js).
//   node --test test/privm-review2-s4t.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privm-review2-s4t-"));
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
const relay = require(path.join(repo, "bridge-relay"));
const CL = require(path.join(repo, "chatlog"));
const CV = require(path.join(repo, "chatlogview"));
const PW = require(path.join(repo, "privwire"));
const FN = require(path.join(repo, "frognames"));
const ST = require(path.join(repo, "seethrough"));

const D = 864e5;
const hash = (login) => crypto.createHash("sha256").update("pepe-hidden:" + String(login).trim().toLowerCase()).digest("hex").slice(0, 20);
const ROOM = { id: "Veil.Room", name: "Veil Room" }, SLUG = "veil-room";
const OTHER = { id: "Other.Room", name: "Other Room" };
const ALIAS_RE = /^(?:[A-Z][A-Za-z-]{1,15} [A-Z][A-Za-z]{1,15}|Mystery Frog \d{1,4})$/;
const users = new Map();
const U = {};
let base, server, seq = 0;
const ev = (type, data, ts = Date.now(), room = ROOM) => ({ op: "event", id: "vs-" + (++seq), ts: new Date(ts).toISOString(), type, scope: { platform: "camfrog", room }, data });
const real = (login, display) => ({ id: login.toLowerCase(), login, display: display || login });
const priv = (kind, login, extra = {}) => Object.assign({ kind, h: hash(login), at: Date.now() / 1000 }, extra);
const sync = (events, extra = {}) => bridge.ingest(Object.assign({ events, rooms: [], bridge_hidden_h: [], incog_hidden_h: [] }, extra), { v2: true });
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

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
const live = (user, slug = SLUG) => call("GET", `/api/rooms/${slug}/live`, { user });
// what never reaches a page: the veiled people, their hashes, the hidden words
const VEILED = ["frankiefettuccine", "Frankie Fett", "hankhidden", "Hank Hide"];
const WORDS = ["the secret hidden sentence about pizza", "only hank knows this"];
const leaks = (json) => [...VEILED, ...WORDS, ...VEILED.map(hash), "\"_vz\"", "\"vz\"", "\"vw\"", "\"priv\"", "\"ah\"", "\"ahs\""].filter((x) => json.includes(x));

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
  U.frankie = await mkUser("frankie", "pleb", "frankiefettuccine");     // the incognito speaker's own account (self view)
  await rooms.init();
  const app = express();
  app.use((req, res, next) => (req.path === "/api/bridge/sync" || req.path === "/api/bridge/sync/v2" ? next() : express.json()(req, res, next)));
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  app.set("views", path.join(repo, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => { res.locals.ogBase = "http://test"; next(); });
  bridge.register(app, { addUser, isBotToken: (t) => t === "bot" });
  require(path.join(repo, "roomsweb")).register(app, { addUser, isBotToken: (t) => t === "bot" });
  PW.register(app, { addUser, noTimers: true });
  ST.register(app, { addUser, noTimers: true });
  await new Promise((r) => { server = app.listen(0, r); });
  server.unref();
  base = "http://127.0.0.1:" + server.address().port;
  // the archive on (the notice 8 days ago) and scrollback on; the switch on (G now)
  CL._setClock(() => Date.now() - 8 * D);
  await CL.setSwitch("notice", true, "test");
  CL._setClock(() => Date.now());
  for (const s of ["archive", "history"]) await CL.setSwitch(s, true, "test");
  await PW.init();
  await PW.setOn(true, { userId: U.adm.userId, username: "adm" });
  await rooms.setOwner(ROOM.id, "own", "test");
  await rooms.setOwner(OTHER.id, "own2", "test").catch(() => {});
  // a roster with a veiled member and holder, and a few lines
  await sync([], { rooms: [{ room: ROOM, members: [real("alicecf", "Alice"), Object.assign(real("frankiefettuccine", "Frankie Fett"), { priv: priv("incognito", "frankiefettuccine"), src: "list", on_mic: true }),
                                                  Object.assign(real("hankhidden", "Hank Hide"), { priv: priv("hidden", "hankhidden"), src: "list" })],
                              mic: [Object.assign(real("frankiefettuccine", "Frankie Fett"), { priv: priv("incognito", "frankiefettuccine"), proven: true, since: Date.now() / 1000 })],
                              count: 4, transcripts: true }] });
  await sync([
    ev("message", { user: real("alicecf", "Alice"), text: "hello pond" }),
    ev("message", { user: real("frankiefettuccine", "Frankie Fett"), text: "pizza time", priv: priv("incognito", "frankiefettuccine") }),
    ev("message", { user: real("hankhidden", "Hank Hide"), priv: priv("hidden", "hankhidden", { words: WORDS[0] }) }),
    ev("x.pepe.transcript", { id: "tx-00000000000000a1", user: real("frankiefettuccine", "Frankie Fett"), text: "said on the mic by a frog", source: "mic",
                              said_at: Date.now() / 1000 - 5, priv: priv("incognito", "frankiefettuccine") }),
    ev("x.pepe.transcript", { id: "tx-00000000000000b1", user: real("hankhidden", "Hank Hide"), source: "mic", said_at: Date.now() / 1000 - 4,
                              priv: priv("hidden", "hankhidden", { words: WORDS[1] }) }),
  ]);
  await settle();
  await CV.init();
  CV._clearCaches();
})();


// ── S4t ──
const TR = require(path.join(repo, "textreveal"));
const VS = require(path.join(repo, "veilstage"));
const RS = require(path.join(repo, "roomstats"));
const s4tReady = (async () => {
  await setup;
  U.mod = await mkUser("moddy", "pleb", "modcf");
  U.mod2 = await mkUser("moddy2", "pleb", "mod2cf");
  await TR.init();
  await require(path.join(repo, "adminaudit")).init();
  const app2 = express();
  app2.use(express.json());
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  TR.register(app2, { addUser });
  await new Promise((r) => { const s2 = app2.listen(0, () => { base2 = "http://127.0.0.1:" + s2.address().port; r(); }); s2.unref(); });
})();
let base2 = null;
function call2(method, url, opts = {}) { const b = base; base = base2; const p = call(method, url, opts); base = b; return p; }
/** Pepe's mod caps: modcf moderates ROOM (never OTHER) - padmod.capsFor reads R.mod. */
function mods() { const R = bridge._rooms.get(ROOM.id); if (R) R.mod = { modcf: { kick: true } }; const O = bridge._rooms.get(OTHER.id); if (O) O.mod = {}; }
async function hiddenLine(words) {
  await sync([ev("message", { user: real("hankhidden", "Hank Hide"), priv: priv("hidden", "hankhidden", { words }) })]);
  await settle(20);
  mods();
  return bridge._rooms.get(ROOM.id).feed.filter((x) => x.u && x.u.veil === "hidden").pop();
}
const reveal = (user, c, extra = {}) => call("POST", "/api/chatlog/reveal", { user, body: Object.assign({ room: SLUG, c: [c] }, extra) });
const lastRow = async () => (await getQuery("SELECT * FROM seethrough_log ORDER BY id DESC LIMIT 1"))[0];

// ── review fixes 2 - RV-D: with text reveal roles on, every surface treats staff and room mods as revealers with their own rules ──
const EVM = require(path.join(repo, "evidence"));
const frankTx = () => (bridge._rooms.get(ROOM.id).feed || []).find((x) => x && x.k === "tx" && x._vz && x._vz.login === "frankiefettuccine");

test("RV-D: a revealed veiled 🎙 line offers 'Save as evidence' only to a role evidence.js lets save (admin / owner) - never staff or a room mod", async () => {
  await s4tReady;
  await EVM.init();
  await EVM.setOn(true, { userId: U.adm.userId, username: "adm" });
  await TR.setOn(true, { userId: U.adm.userId, username: "adm" });
  try {
    mods();
    const it = frankTx();
    assert.ok(it && EVM.offerable(bridge._rooms.get(ROOM.id), it.c), "the incognito 🎙 turn can be saved as evidence right now");
    const own = await reveal(U.own, it.c, { reason: "my pad" });
    assert.equal(own.status, 200, own.text);
    assert.equal(own.d.items[0].ev, 1, "the pad's owner: offered (evidence.js lets them save)");
    for (const [who, u] of [["staff", U.staff], ["mod", U.mod]]) {
      const r = await reveal(u, it.c, { reason: "a report" });
      assert.equal(r.status, 200, who + ": " + r.text);
      assert.equal(r.d.items.length, 1);
      assert.equal(r.d.items[0].ev, undefined, who + ": never offered a save evidence.js would refuse");
    }
    // the toggle's batch too
    const tg = await call("POST", "/api/chatlog/seethrough", { user: U.mod, body: { room: SLUG, on: true, reason: "sweep" } });
    assert.equal(tg.status, 200, tg.text);
    const bt = await reveal(U.mod, it.c, { toggle: true });
    assert.equal(bt.status, 200, bt.text);
    assert.ok(bt.d.items.every((o) => o.ev === undefined), "the mod's batch: no evidence offer");
    await call("POST", "/api/chatlog/seethrough", { user: U.mod, body: { room: SLUG, on: false } });
  } finally {
    await TR.setOn(false, { userId: U.adm.userId, username: "adm" });
    await EVM.setOn(false, { userId: U.adm.userId, username: "adm" });
  }
});

test("RV-D: a 'Show real names' batch counts once against the non-admin limit (like the toggle itself) - two full batches in a minute both answer", async () => {
  await s4tReady;
  const staff3 = await mkUser("helper3", "Staff");
  await TR.setOn(true, { userId: U.adm.userId, username: "adm" });
  try {
    const tg = await call("POST", "/api/chatlog/seethrough", { user: staff3, body: { room: SLUG, on: true, reason: "sweep" } });
    assert.equal(tg.status, 200, tg.text);
    const it = frankTx();
    const batch = Array.from({ length: 50 }, (_, i) => it.c - i);
    for (const n of [1, 2]) {
      const b = await call("POST", "/api/chatlog/reveal", { user: staff3, body: { room: SLUG, c: batch, toggle: true } });
      assert.equal(b.status, 200, `batch ${n}: ` + b.text);
    }
    await call("POST", "/api/chatlog/seethrough", { user: staff3, body: { room: SLUG, on: false } });
    // single reveals still count each line
    const many = Array.from({ length: TR.NONADMIN_PER_MIN + 5 }, (_, i) => it.c - i);
    const rl = await call("POST", "/api/chatlog/reveal", { user: staff3, body: { room: SLUG, c: many, reason: "lots" } });
    assert.equal(rl.status, 429, rl.text);
  } finally { await TR.setOn(false, { userId: U.adm.userId, username: "adm" }); }
});
