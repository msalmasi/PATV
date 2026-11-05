"use strict";
// 1.99ajw casino2 (owner 2026-11-04: "Poker table / casino tables need clickable names with the usual tipping etc." + a chat from the
// tables): GET /api/casino/t/:id/people and /pads (casino/people.js).
//   * people: signed in only (401), private no-store, 30 a minute per account; never part of the 1 s poll
//   * a veiled seat (hidden on the bridge now: the seat's login, a web seat's linked login or its account key; incognito on) is MASKED
//     (1.99ajw casino2 rework, casino/veil.js): {veil: true, display: <its label>} under the masked seat's own id, nothing else - no
//     account, no login, no tip; a failing / loading hidden check fails closed (everyone masked for that answer)
//   * a web seat: its PATV name + tip only, never a Camfrog login (1.99ajf); your own seat {me}; Pepe's account {bot}
//   * a room seat: its login only while it is a NAMED member of a live pad the table plays in or advertises in AND THE VIEWER MAY OPEN
//     (padaccess.full + the 18+ gate - review F1: an Approved / 18+ pad never says who is in its room now), with that pad's mod caps
//     for THIS viewer (padmod.viewMod - only a linked viewer Pepe gives powers) and pvp only when the room's web commands offer it
//   * incognito is looked up by the lower-case login (review F3: a mixed-case link is veiled too)
//   * tip = bridge.tipFor's rule: never yourself, never Pepe
//   * pads: the rooms the table plays in (home first), then its adverts - live bridged pads only, chat = the chat window's own gate
//   node --test test/casino-people.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "casino-people-test-"));
process.chdir(tmp);
delete process.env.STAGING;
process.env.SECRET_KEY = "test-secret";
process.env.PAD_DIR = path.join(tmp, "pad");
const express = require("express");
const { runQuery } = require(path.join(repo, "dbUtils"));
const rooms = require(path.join(repo, "rooms"));
const PA = require(path.join(repo, "padaccess"));
const PD = require(path.join(repo, "paddock"));
const bridge = require(path.join(repo, "bridge"));
const svc = require(path.join(repo, "casino", "service"));
const people = require(path.join(repo, "casino", "people"));
const Q = require(path.join(repo, "quotes")), CV = require(path.join(repo, "chatlogview")), PM = require(path.join(repo, "padmod"));
require(path.join(repo, "terms"))._setRequired(false);

const HOME = "Casino.Pad", ADV = "Advert.Pad", GONE = "Gone.Pad", TID = "abcdef0123";
const users = new Map(), U = {};
async function mkUser(name, extra = {}) {
  const id = extra.id || "u_" + name;
  await runQuery(`INSERT INTO users (userId, username, displayname, password, class, points_balance, camfrogUsername, level, created_at, casino_banned)
                  VALUES (?, ?, ?, 'x', ?, 0, ?, 5, '2026-01-01 00:00:00', 0)`, [id, name, extra.display || name, extra.class || "pleb", extra.camfrog || null]);
  const u = { userId: id, username: name, class: extra.class || "pleb" };
  users.set(id, u); return u;
}
let seq = 0;
const ev = (room, type, data) => ({ op: "event", id: "cp-" + (++seq), ts: new Date().toISOString(), type, scope: { platform: "camfrog", room }, data });
const snap = (id, extra = {}) => ({ room: { id, name: id }, topic: "", count: 4, cams: true, relay: true, mic_relay: true, audio: false, ...extra,
  members: [{ id: "pepefrog", login: "pepefrog", display: "Pepe", is_self: true }, { id: "willowcf", login: "willowcf", display: "Willow" },
            { id: "viewercf", login: "viewercf", display: "Viewer" }, { id: "hidcf", login: "hidcf", display: "Hid" }], mic: [] });
const S = { hidden: new Set(), fail: false };
const real = { isHidden: Q.isHidden, isHiddenLogin: CV.isHiddenLogin, viewMod: PM.viewMod };
let base, server;
const H = (u) => Object.assign({ "x-requested-with": "fetch" }, u ? { "x-test-user": u.userId } : {});
async function get(url, u) {
  const r = await fetch(base + url, { headers: H(u) });
  const text = await r.text(); let d = null; try { d = JSON.parse(text); } catch (e) { d = null; }
  return { status: r.status, headers: r.headers, d };
}
const mode = (m) => PD.save(U.admin, { cfg: { mode: m } });

test.before(async () => {
  await runQuery(`CREATE TABLE users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT, class TEXT DEFAULT 'pleb',
                  points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, discordUsername TEXT, twitchDisplayname TEXT, discordId TEXT, twitchId TEXT,
                  level INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, avatar TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, casino_banned INTEGER DEFAULT 0, email TEXT)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS incognito_state (login TEXT PRIMARY KEY, "on" INTEGER, updated INTEGER, reported INTEGER)`);
  U.viewer = await mkUser("viewer", { camfrog: "viewercf" });
  U.willow = await mkUser("willow", { camfrog: "willowcf", display: "Willow W" });
  U.fern = await mkUser("fern");                                   // a web player, no Camfrog link
  U.fernlinked = await mkUser("fernlinked", { camfrog: "fernlinkedcf" });   // a web player WITH a link (never shown)
  U.hid = await mkUser("hid", { camfrog: "hidcf" });
  U.gone = await mkUser("gone", { camfrog: "gonecf" });            // a room player no longer in the room
  U.unlinked = await mkUser("webonly");
  U.admin = await mkUser("boss", { class: "Admin", camfrog: "bossfrog" });
  U.adv = await mkUser("advp", { camfrog: "advcf" });               // a room player sitting in the ADVERT pad's room
  U.mixed = await mkUser("mixed", { camfrog: "MixedCF" });          // a mixed-case link (incognito_state is keyed lower-case)
  await runQuery("INSERT INTO users (userId, username, displayname, password, camfrogUsername) VALUES ('pepe-bot', 'pepe', 'Pepe', 'x', 'pepefrog')");
  users.set("pepe-bot", { userId: "pepe-bot", username: "pepe" });
  await rooms.init();
  for (const id of [HOME, ADV, GONE]) await rooms.addRoom(id, id, "test");
  await PA.init();
  for (const id of [HOME, ADV]) await runQuery("INSERT INTO pad_access (room_id, level, updated, updated_by) VALUES (?, 'public', ?, 'test')", [id, Date.now()]);
  PA._reset(); await PA.init();
  await bridge.ingest({ events: [ev({ id: HOME, name: HOME }, "message", { user: { id: "willowcf", login: "willowcf", display: "Willow" }, text: "hi" })],
                        rooms: [snap(HOME), snap(ADV, { members: [{ id: "x", login: "advcf", display: "Adv" }] })] });
  // the home room's web commands (Pepe's !bridge cmds): duel yes, brawl no
  bridge._rooms.get(HOME).cmds = { "!duel": 0, "!say": 100 };
  await PD.init();
  await mode("everyone");
  await svc.boot({ tick: false });
  const T = { id: TID, game: "bj", status: "open", room: HOME, rooms: [HOME], adverts: [ADV, GONE], host: { uid: U.fern.userId, name: "fern" },
    eng: { seats: [U.viewer.userId, U.willow.userId, U.fern.userId, U.fernlinked.userId, U.hid.userId, U.gone.userId, "pepe-bot", U.adv.userId, U.mixed.userId], names: { [U.willow.userId]: "Willow W" } },
    players: { [U.viewer.userId]: { name: "viewer", via: "web" }, [U.willow.userId]: { name: "Willow W", via: "room", camfrog: "willowcf", room: HOME },
               [U.fern.userId]: { name: "fern", via: "web" }, [U.fernlinked.userId]: { name: "fernlinked", via: "web" },
               [U.hid.userId]: { name: "Hid", via: "room", camfrog: "hidcf", room: HOME }, [U.gone.userId]: { name: "gone", via: "room", camfrog: "gonecf", room: HOME },
               "pepe-bot": { name: "Pepe", via: "room", camfrog: "pepefrog", room: HOME },
               [U.adv.userId]: { name: "Adv", via: "room", camfrog: "advcf", room: ADV }, [U.mixed.userId]: { name: "Mixed", via: "web" } } };
  svc.S.tables.set(TID, T);
  Q.isHidden = (k) => { if (S.fail) throw new Error("set loading"); return S.hidden.has(k); };
  CV.isHiddenLogin = (k) => S.hidden.has("cv:" + k);
  PM.viewMod = (R, login) => (String(login).toLowerCase() === "viewercf" && R.id === HOME ? { on: true, actions: ["kick", "ban"], login: "viewercf" } : null);
  bridge._pepeName("pepe");
  const app = express();
  const addUser = (req, res, next) => { const id = req.get("x-test-user"); req.user = id ? users.get(id) || null : null; next(); };
  require(path.join(repo, "casino", "routes")).register(app, { addUser, isBotToken: () => false });
  server = app.listen(0);
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { Object.assign(Q, { isHidden: real.isHidden }); CV.isHiddenLogin = real.isHiddenLogin; PM.viewMod = real.viewMod; svc.stop(); if (server) server.close(); });
const V = require(path.join(repo, "casino", "veil"));
test.beforeEach(() => { people._reset(); require(path.join(repo, "padweb"))._reset(); V._reset(); S.hidden.clear(); S.fail = false; });   // (padweb caches incognito 30 s; veil re-reads at most every 2 s)

const seatOf = (d, u) => d.seats[svc.uidHash(u.userId)];

test("people: signed in only, never cached; seat hashes are the table view's (no account ids on the wire)", async () => {
  const no = await get("/api/casino/t/" + TID + "/people", null);
  assert.equal(no.status, 401);
  assert.equal(no.headers.get("cache-control"), "private, no-store");
  const r = await get("/api/casino/t/" + TID + "/people", U.viewer);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Object.keys(r.d.seats).sort(), svc.S.tables.get(TID).eng.seats.map(svc.uidHash).sort());
  const wire = JSON.stringify(r.d);
  for (const u of [U.viewer, U.willow, U.fern, U.hid]) assert.ok(!wire.includes(u.userId), "no account id: " + u.userId);
  assert.equal((await get("/api/casino/t/ffffffffff/people", U.viewer)).status, 404);
});

test("people: your own seat, Pepe, a web seat (PATV name + tip, never a login - linked or not), the tip rule", async () => {
  const d = (await get("/api/casino/t/" + TID + "/people", U.viewer)).d;
  assert.deepEqual(seatOf(d, U.viewer), { me: true, display: "viewer" });
  assert.deepEqual(seatOf(d, { userId: "pepe-bot" }), { bot: true, display: "Pepe", patv: { username: "pepe" } }, "Pepe: his own menu, no tip");
  assert.deepEqual(seatOf(d, U.fern), { display: "fern", patv: { username: "fern" }, tip: { to: "fern", href: "/u/fern/tip" }, web: true });
  const fl = seatOf(d, U.fernlinked);
  assert.equal(fl.login, undefined, "a web seat never maps to a Camfrog login (1.99ajf)");
  assert.doesNotMatch(JSON.stringify(d), /fernlinkedcf/);
  assert.deepEqual(d.pepe, { username: "pepe", pad: d.pepe.pad });
  // the host looks at the table: their own seat is {me}, the viewer's seat gets a tip to the viewer
  const h = (await get("/api/casino/t/" + TID + "/people", U.fern)).d;
  assert.deepEqual(seatOf(h, U.fern), { me: true, display: "fern" });
  assert.deepEqual(seatOf(h, U.viewer).tip, { to: "viewer", href: "/u/viewer/tip" });
});

test("people: a room seat named in a live pad of the table gets its login, that pad's mod caps for THIS viewer and pvp only when offered", async () => {
  const d = (await get("/api/casino/t/" + TID + "/people", U.viewer)).d;
  const w = seatOf(d, U.willow);
  assert.equal(w.login, "willowcf");
  assert.deepEqual(w.patv, { username: "willow" }); assert.deepEqual(w.tip, { to: "willow", href: "/u/willow/tip" });
  assert.equal(w.pad.slug, (await rooms.get(HOME)).slug); assert.equal(w.pad.member, true);
  assert.deepEqual(w.pad.mod, { on: true, actions: ["kick", "ban"], login: "viewercf" }, "Pepe gives this viewer powers there");
  assert.deepEqual(w.pad.pvp, { duel: true, brawl: false }, "the room offers !duel, not !brawl");
  // a viewer with no linked login: no mod caps, no pvp (the chat's pvp needs a linked login)
  const x = seatOf((await get("/api/casino/t/" + TID + "/people", U.unlinked)).d, U.willow);
  assert.equal(x.login, "willowcf"); assert.equal(x.pad.mod, null); assert.equal(x.pad.pvp, null);
  // web commands off in the room: no pvp
  const R = bridge._rooms.get(HOME), was = R.cmds;
  R.cmds = { "!say": 100 };
  try { assert.equal(seatOf((await get("/api/casino/t/" + TID + "/people", U.viewer)).d, U.willow).pad.pvp, null); } finally { R.cmds = was; }
  // a room seat who isn't in the room any more: profile + tip, no login
  const g = seatOf(d, U.gone);
  assert.equal(g.login, undefined); assert.equal(g.pad, undefined); assert.equal(g.web, true); assert.deepEqual(g.tip, { to: "gone", href: "/u/gone/tip" });
});

test("people: a room seat in a pad the viewer may NOT open (Approved advert pad) is a web seat there - no login, no pad, no ⚔️ (review F1)", async () => {
  const RA = bridge._rooms.get(ADV);
  RA.members = RA.members.concat([{ login: "advcf", display: "Adv" }]);          // (Adv sits in the advert pad's live room)
  const open = seatOf((await get("/api/casino/t/" + TID + "/people", U.viewer)).d, U.adv);
  assert.equal(open.login, "advcf", "a Public advert pad: named as before");
  assert.equal(open.pad.slug, (await rooms.get(ADV)).slug);
  await runQuery("UPDATE pad_access SET level = 'approved' WHERE room_id = ?", [ADV]);
  PA._reset(); await PA.init(); people._reset();
  try {
    const d = (await get("/api/casino/t/" + TID + "/people", U.viewer)).d;
    const a = seatOf(d, U.adv);
    assert.equal(a.login, undefined, "the locked pad's live room isn't told");
    assert.equal(a.pad, undefined, "no pad block (no ⚔️ Duel, no mod caps) from a pad the viewer can't open");
    assert.equal(a.web, true); assert.deepEqual(a.tip, { to: "advp", href: "/u/advp/tip" }, "profile + tip, as a web seat");
    assert.doesNotMatch(JSON.stringify(d.seats), /advcf/);
    assert.equal(d.pads.find((x) => x.room === ADV).chat, false, "(its chat isn't offered either)");
    assert.equal(seatOf(d, U.willow).login, "willowcf", "the home pad (Public) as before");
    const staff = seatOf((await get("/api/casino/t/" + TID + "/people", U.admin)).d, U.adv);
    assert.equal(staff.login, "advcf", "site staff are inside every Approved pad");
  } finally {
    await runQuery("UPDATE pad_access SET level = 'public' WHERE room_id = ?", [ADV]);
    PA._reset(); await PA.init();
  }
});

test("people: a veiled seat is MASKED - {veil: true, display: its label} under the masked seat's own id and nothing else (the seat's login, a web seat's linked login, the account key, incognito); fail closed", async () => {
  const T = svc.S.tables.get(TID);
  S.hidden.add("hidcf");                                              // quotes.isHidden (the site's one rule)
  S.hidden.add("cv:fernlinkedcf");                                    // chatlogview.isHiddenLogin: a web seat's LINKED login
  await runQuery(`INSERT OR REPLACE INTO incognito_state (login, "on", updated, reported) VALUES ('u:${U.fern.userId}', 1, 1, 1)`);   // incognito by account
  const masked = (d, u) => d.seats[V.seatOf(T, u.userId)];
  try {
    const d = (await get("/api/casino/t/" + TID + "/people", U.viewer)).d;
    for (const u of [U.hid, U.fernlinked, U.fern]) {
      assert.equal(seatOf(d, u), undefined, "never under the account's seat hash (the same at every table): " + u.username);
      assert.match(V.seatOf(T, u.userId), /^v[0-9a-f]{11}$/);
      // ("someone": each was shown under their name at this table before - frognames C.2, never a frog name right after the name)
      assert.deepEqual(masked(d, u), { veil: true, display: "someone" }, u.username);
    }
    // review F3: incognito by a mixed-case linked login ('MixedCF' -> incognito_state 'mixedcf'), before the sticky set has them
    assert.equal(seatOf(d, U.mixed).veil, undefined, "(not incognito yet)");
    await runQuery(`INSERT OR REPLACE INTO incognito_state (login, "on", updated, reported) VALUES ('mixedcf', 1, 1, 1)`);
    require(path.join(repo, "padweb"))._reset(); V._reset();
    assert.deepEqual(masked((await get("/api/casino/t/" + TID + "/people", U.viewer)).d, U.mixed), { veil: true, display: "someone" }, "a mixed-case login's incognito masks the seat");
    assert.doesNotMatch(JSON.stringify(d), /hidcf|"hid"|fernlinked|"fern"/, "nothing about them on the wire");
    for (const u of [U.hid, U.fernlinked, U.fern]) assert.ok(!JSON.stringify(d).includes(svc.uidHash(u.userId)), "nor their account's seat hash");
    assert.equal(seatOf(d, U.willow).login, "willowcf", "others as before");
    S.fail = true; V._reset();
    const f = (await get("/api/casino/t/" + TID + "/people", U.viewer)).d;
    for (const u of [U.willow, U.gone]) assert.deepEqual(masked(f, u), { veil: true, display: "someone" }, "the hidden set failing: everyone masked - " + u.username);
    assert.deepEqual(masked(f, U.viewer), { me: true, display: "someone" }, "(your own seat too, for that answer - it opens no menu)");
    S.fail = false; V._reset();
    const back = (await get("/api/casino/t/" + TID + "/people", U.viewer)).d;
    assert.equal(seatOf(back, U.willow).login, "willowcf", "a failed read keeps nothing: named again once it reads");
  } finally { await runQuery("DELETE FROM incognito_state"); delete T.veil; V._reset(); require(path.join(repo, "padweb"))._reset(); }
});

test("pads: the rooms it plays in (home first), then its adverts - live bridged pads only; chat = the chat window's gate; anyone may ask", async () => {
  const d = (await get("/api/casino/t/" + TID + "/pads", null)).d;
  assert.deepEqual(d.pads.map((p) => [p.room, p.role, p.chat]), [[HOME, "home", true], [ADV, "advert", true]], "the advert pad counts; a pad Pepe isn't bridging doesn't");
  assert.equal(d.pads[0].slug, (await rooms.get(HOME)).slug);
  const p = (await get("/api/casino/t/" + TID + "/people", U.viewer)).d;
  assert.deepEqual(p.pads, d.pads, "the people answer carries the same pads");
  await mode("off");
  try { assert.deepEqual((await get("/api/casino/t/" + TID + "/pads", U.viewer)).d.pads.map((x) => x.chat), [false, false], "the Room Dock off: no chat to open"); }
  finally { await mode("everyone"); }
});

test("rate limits: 30 a minute per account (people) / per account or address (pads); never part of the table poll", async () => {
  for (let i = 0; i < 30; i++) assert.equal((await get("/api/casino/t/" + TID + "/people", U.viewer)).status, 200);
  assert.equal((await get("/api/casino/t/" + TID + "/people", U.viewer)).status, 429);
  assert.equal((await get("/api/casino/t/" + TID + "/people", U.willow)).status, 200, "per account");
  const ui = fs.readFileSync(path.join(repo, "public", "js", "casino-ui.js"), "utf8");
  assert.match(ui, /if \(sig !== ppl\.sig\) \{ ppl\.sig = sig; loadPeople\(\); \}/, "asked when the seats / rooms change");
  assert.match(ui, /Date\.now\(\) - ppl\.at > PEOPLE_CLICK_MS\) await loadPeople\(\)/, "and on a click with an answer older than a few seconds (review F4)");
  assert.match(ui, /const PEOPLE_CLICK_MS = 5000;/);
});

test("the table pages: the person menu, the Pepe menu and the 💬 Chat panel are wired, with their scripts and cache-busters", () => {
  const ejs = require(path.join(repo, "node_modules", "ejs"));
  for (const [f, js] of [["casino-hm.ejs", "casinohm.js?v=7"], ["casino-bj.ejs", "casinobj.js?v=8"]]) {
    const src = fs.readFileSync(path.join(repo, "views", f), "utf8");
    // (1.99ajw casino2 rework: room-mod v16 - 1.99ajn padppl's 🚫 Block / ✅ Unblock in the menu - with its sheet + look for signed-in viewers)
    for (const s of ["casino-ui.js?v=6", js, "room-mod.js?v=16", "pad-tip.js?v=1", "room-mod.css?v=10", "pad-dock.css?v=8", "person-sheet.css?v=3",
                     "<% if (signedIn) { %><script src=\"/public/js/block-sheet.js?v=3\"></script><% } %>", "include('partials/casino-chat'", 'data-user="']) assert.ok(src.includes(s), f + ": " + s);
  }
  const chat = fs.readFileSync(path.join(repo, "views", "partials", "casino-chat.ejs"), "utf8");
  assert.match(chat, /casino-chat\.js\?v=1/);
  assert.match(fs.readFileSync(path.join(repo, "views", "partials", "casino-top.ejs"), "utf8"), /id="cz-chatbtn" hidden/);
  assert.match(fs.readFileSync(path.join(repo, "views", "casino-bj.ejs"), "utf8"), /class="cz-who" data-pepe="1"/, "the dealer opens Pepe's menu");
  const ui = fs.readFileSync(path.join(repo, "public", "js", "casino-ui.js"), "utf8");
  // 1.99ajw casino2 rework: every seat is the same button (a masked one too - a plain seat would mark who is incognito); never your own
  // seat, never for signed-out viewers; a masked seat opens veilMenu (its label, "incognito player", one line - no profile, no tip)
  assert.match(ui, /if \(!signed \|\| !s \|\| !s\.seat \|\| mine\) return inner;/);
  assert.match(ui, /if \(p\.veil\) \{ veilMenu\(anchor, p\); return; \}/);
  const vm = ui.slice(ui.indexOf("function veilMenu("), ui.indexOf("function veilMenu(") + 700);
  assert.match(vm, /items: \[\]/, "the masked seat's menu has no items");
  assert.doesNotMatch(vm, /\/u\/|tip|patv|login/i, "nothing in it that says who");
  assert.match(ui, /if \(s\.veil\) return `<span class="av veil" aria-hidden="true">🐸/, "a masked seat has no picture");
  assert.match(ui, /wrap\.hidden = true; wrap\.className = "cz-pm-host"/, "the menu's Manage panel can never show on a table page");
  for (const f of ["casinohm.js", "casinobj.js"]) assert.match(fs.readFileSync(path.join(repo, "public", "js", f), "utf8"), /CZ\.seatWho\(s, CZ\.avatarHTML\(s\)/, f);
  const en = JSON.parse(fs.readFileSync(path.join(repo, "locales", "en.json"), "utf8"));
  const cc = fs.readFileSync(path.join(repo, "public", "js", "casino-chat.js"), "utf8");
  for (const m of cc.matchAll(/\bT\("([a-z0-9_]+)",\s*"((?:[^"\\]|\\.)*)"/g)) assert.equal(en["js.casino." + m[1]], JSON.parse('"' + m[2] + '"'), "casino-chat.js: " + m[1]);
  for (const m of chat.matchAll(/t\('(casino\.[a-z0-9_]+)'\)/g)) assert.ok(typeof en[m[1]] === "string", m[1]);
  void ejs;
});
