// 1.99aid (privacy controls S4t: TEXT REVEAL ROLES - G:/ops/privacy-controls-spec-2026-11-02.md section 8, owner 2026-11-02 ~22:05Z "yes" to
// pad owners, staff and room mods revealing blacked-out TEXT too, through the reveal audit log). On a temp DB with the real bridge ingest
// (privacy wire v2) and the real see-through routes (the veil-site harness):
//   switch   textreveal.js: off by default; chatlog.admin only; audited; the sync answer's textreveal: 1 only while on
//   off      today's roles and words exactly (staff / mods 403, owners need no reason)
//   on       staff everywhere and the room's mods (Pepe's caps on their linked login, their pad) reveal names / hidden lines - a reason
//            every time (409 reason_needed), logged with role + reason, rate-limited, counted for the admins; owners need a reason
//            too, admins don't; the live stage (veilstage.stageRole) and the boards (roomstats.seeThroughRole) follow
//   words    /privacy, /help's note and the cards' pc flags name staff and mods only while it's on
//   node --test test/privm-s4t.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "privm-s4t-test-"));
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

test("S4t switch: off by default; chatlog.admin only; audited; the sync answer says textreveal: 1 only while it's on", async () => {
  await s4tReady;
  assert.equal(TR.isOn(), false);
  const sync1 = () => call("POST", "/api/bridge/sync", { body: { password: "bot", events: [], rooms: [], hidden_h: [] } });
  let r = await sync1();
  assert.equal(r.status, 200, r.text);
  assert.equal(r.d.textreveal, undefined, "no advert while off");
  assert.equal((await call2("POST", "/api/admin/textreveal", { user: U.staff, body: { on: true } })).status, 403, "staff can't flip it");
  assert.equal((await call2("POST", "/api/admin/textreveal", { user: U.own, body: { on: true } })).status, 403, "an owner can't");
  const on = await call2("POST", "/api/admin/textreveal", { user: U.adm, body: { on: true } });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.d.state.on, true);
  assert.equal((await getQuery("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'textreveal.switch'"))[0].n, 1, "audited");
  r = await sync1();
  assert.equal(r.d.textreveal, 1, "the advert while on");
  await TR.setOn(false, { userId: U.adm.userId, username: "adm" });
  r = await sync1();
  assert.equal(r.d.textreveal, undefined, "gone again");
  if (process.env.PEPE_BOT_DIR) {
    const bsrc = fs.readFileSync(path.join(process.env.PEPE_BOT_DIR, "pepe_bridge.py"), "utf8");
    assert.ok(bsrc.includes('rj.get("textreveal")'), "Pepe reads the same key");
  }
  const SPC = require(path.join(repo, "siteperms-core"));
  const cap = SPC.CAPS.find((c) => c[0] === "chatlog.reveal_text");
  assert.deepEqual(cap && cap.slice(1), ["pads", "staff", "privacy"], "chatlog.reveal_text: Staff, locked privacy");
});

test("S4t off: today's roles exactly - staff and mods refused (the old words), the owner needs no reason", async () => {
  await s4tReady;
  await TR.setOn(false, { userId: U.adm.userId, username: "adm" });
  const it = await hiddenLine("off words");
  const st = await reveal(U.staff, it.c, { reason: "checking" });
  assert.equal(st.status, 403, st.text);
  assert.equal(st.d.error, "Only PATV admins, and a pad's owner in their own pad, can reveal who is behind a frog name.");
  assert.equal((await reveal(U.mod, it.c, { reason: "checking" })).status, 403, "a room mod");
  const ow = await reveal(U.own, it.c);
  assert.equal(ow.status, 200, "the owner, no reason (as today): " + ow.text);
  assert.equal(await VS.stageRole({ userId: U.staff.userId }, ROOM.id), null, "the live stage: no staff");
  assert.equal(await RS.seeThroughRole({ userId: U.mod.userId }, ROOM.id), null, "the boards: no mods");
  const lv = await live(U.staff);
  assert.ok(Array.isArray(lv.d.feed) && !lv.d.feed.some((x) => x.rv), "no Reveal for staff on the page");
});

test("S4t on: staff (every pad) and the room's mods (their pad) reveal - a reason each time, logged with role and reason; owners need one too; admins don't", async () => {
  await s4tReady;
  await TR.setOn(true, { userId: U.adm.userId, username: "adm" });
  try {
    const it = await hiddenLine("the staff can read this");
    // staff: a reason first
    let r = await reveal(U.staff, it.c);
    assert.deepEqual([r.status, r.d.code, r.d.reason_needed], [409, "reason_needed", true], r.text);
    const n0 = (await getQuery("SELECT COUNT(*) AS n FROM seethrough_log"))[0].n;
    assert.equal((await getQuery("SELECT COUNT(*) AS n FROM seethrough_log"))[0].n, n0, "nothing logged without one");
    r = await reveal(U.staff, it.c, { reason: "report #12" });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.d.items.map((o) => [o.login, o.words, o.account]), [["hankhidden", "the staff can read this", undefined]], "the words, no admin account link");
    let row = await lastRow();
    assert.deepEqual([row.scope, row.role, row.reason], ["chat_line", "staff", "report #12"]);
    // the room's mod: their pad only
    r = await reveal(U.mod, it.c, { reason: "mod check" });
    assert.equal(r.status, 200, r.text);
    row = await lastRow();
    assert.deepEqual([row.role, row.reason], ["mod", "mod check"]);
    assert.equal((await reveal(U.mod2, it.c, { reason: "not a mod" })).status, 403, "someone who isn't a mod here");
    const other = await call("POST", "/api/chatlog/reveal", { user: U.mod, body: { room: "other-room", c: [it.c], reason: "x y z" } });
    assert.notEqual(other.status, 200, "a mod of another room: " + other.text);
    // the owner: a reason now; an admin: none
    assert.equal((await reveal(U.own, it.c)).d.code, "reason_needed", "the owner gives a reason too while it's on");
    assert.equal((await reveal(U.own, it.c, { reason: "my pad" })).status, 200);
    assert.equal((await reveal(U.adm, it.c)).status, 200, "admins: no reason needed");
    // the toggle: on with a reason; the batch then needs none
    assert.equal((await call("POST", "/api/chatlog/seethrough", { user: U.staff, body: { room: SLUG, on: true } })).d.code, "reason_needed");
    const tg = await call("POST", "/api/chatlog/seethrough", { user: U.staff, body: { room: SLUG, on: true, reason: "sweep" } });
    assert.equal(tg.status, 200, tg.text);
    const bt = await reveal(U.staff, it.c, { toggle: true });
    assert.equal(bt.status, 200, bt.text);
    await call("POST", "/api/chatlog/seethrough", { user: U.staff, body: { room: SLUG, on: false } });
    // the page: Reveal for staff and the mod
    const lv = await live(U.staff);
    assert.ok((lv.d.feed || []).some((x) => x.rv === 1), "Reveal offered to staff on the page");
    // the live stage, the boards
    assert.equal(await VS.stageRole({ userId: U.staff.userId }, ROOM.id), "staff");
    assert.equal(await VS.stageRole({ userId: U.mod.userId }, ROOM.id), "mod");
    assert.equal(await VS.stageRole({ userId: U.mod.userId }, OTHER.id), null);
    assert.equal(await RS.seeThroughRole({ userId: U.staff.userId }, ROOM.id), "staff");
    assert.equal(await RS.seeThroughRole({ userId: U.mod.userId }, ROOM.id), "mod");
    // members never
    assert.equal((await reveal(U.mem, it.c, { reason: "nosy" })).status, 403);
    // a non-admin rate limit
    const many = Array.from({ length: TR.NONADMIN_PER_MIN + 5 }, (_, i) => it.c - i);
    const rl = await call("POST", "/api/chatlog/reveal", { user: U.staff, body: { room: SLUG, c: many, reason: "lots" } });
    assert.equal(rl.status, 429, rl.text);
    // the daily count tells the admins (as for owners)
    await ST.noteOwnerUse({ userId: U.staff.userId, username: "helper" }, ROOM.id, "lines", 101, "staff");
    const note = (await getQuery("SELECT title FROM inbox WHERE user_id = ? ORDER BY id DESC LIMIT 1", [U.adm.userId]).catch(() => []))[0];
    assert.ok(!note || /staff member/.test(note.title), "the admins' notice names the role: " + JSON.stringify(note));
  } finally { await TR.setOn(false, { userId: U.adm.userId, username: "adm" }); }
});

test("S4t words: /privacy and /help name staff and mods only while it's on; off is the page as before", async () => {
  await s4tReady;
  const ejs = require("ejs");
  const fn = path.join(repo, "views", "privacy.ejs");
  const src = fs.readFileSync(fn, "utf8");
  const L0 = { t: (k) => k, user: null, title: "Privacy", VERSION: "x", UPDATED: "1 January 2026", enforced: false, privwire: { g: 1, g_day: "1 January 2026" },
               chatlog: { notice_at: 1, notice_day: "1 January 2026", start_day: "1 January 2026" }, policyDates: {}, can: () => false };
  const off = ejs.render(src, Object.assign({}, L0), { filename: fn });
  const off2 = ejs.render(src, Object.assign({}, L0, { textreveal: null }), { filename: fn });
  assert.equal(off, off2, "switch off: byte for byte the page without it");
  assert.equal(off.includes("room's moderators can reveal") || off.includes("that room's moderators can reveal"), false);
  const on = ejs.render(src, Object.assign({}, L0, { textreveal: { on: true, on_at: Date.now(), on_day: "2 November 2026" } }), { filename: fn });
  assert.ok(on.includes("PATV administrators and staff, the owner of the pad you're in and that room's moderators can reveal"), "section 3");
  assert.ok(on.includes("Everyone but an administrator has to give a reason each time"), "who can see through it");
  assert.equal(on.includes("PATV staff and room moderators can't."), false, "the old 'can't' sentence is gone");
  assert.ok(on.includes("2 November 2026:</b> <a href=\"#incognito\">Who can see through frog names</a>"), "the change note");
  // /help's fallback note and the cards' pc flags follow the switch
  const H = require(path.join(repo, "help"));
  const card = [{ id: "bridge", summary: "s", details: "d" }];
  const n0 = H.withPrivwireNotes(card)[0].details;
  await TR.setOn(true, { userId: U.adm.userId, username: "adm" });
  try {
    const n1 = H.withPrivwireNotes(card)[0].details;
    assert.ok(n0.includes("PATV administrators and the pad's owner can reveal") && n1.includes("PATV administrators and staff, the pad's owner and the room's moderators can reveal"), n1);
    assert.equal(require(path.join(repo, "privacycopy")).flags().textreveal, true);
    assert.ok(H.PC_KEYS.includes("textreveal"));
  } finally { await TR.setOn(false, { userId: U.adm.userId, username: "adm" }); }
  assert.equal(require(path.join(repo, "privacycopy")).flags().textreveal, false);
});
