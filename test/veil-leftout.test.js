// wave 2 integrate, review fixes XT-1 and XT-2 (WP-2's privacy wire v2 x WP-4's mic-stage covers x forget-me / account deletion; spec
// A.1 "left out: identity not shown, mic grab / drop not shown", A.4.8, F.4; G:/ops/incognito-micstage-design-2026-10-27.md).
//   XT-1  someone LEFT OUT (chatlogview's HARD_OUT: a staff removal, forget-me, an account deletion with "also hide my past lines") gets
//         no mic-stage cover - the people list and the chat leave them out, so the stage does too: a cover already up comes off at
//         the next step (no "recent" tile with their identity behind it), Pepe's next snapshot (he still relays them incognito)
//         doesn't bring it back, and a tile Reveal in between is refused (404, the answer for a cover that's gone). A !bridge hide
//         alone is not left out for this (a shadow cover), and a staff "undo" brings the cover back.
//   XT-2  an account deletion (without "also hide my past lines") ends the person's frog-name sessions and takes their veiled live
//         items down - as forget-me does (bridge.forgetVeiled): the cover comes off at once, no _vz is left in memory, their earlier
//         lines leave the page, and their next appearance gets a NEW frog-name session (their earlier lines can't be tied to it).
// On a temp DB with the real schema (test/fixtures/schemascan), the real bridge ingest, frog-name sessions, micfollow engine,
// see-through routes, pepeforget and accountdelete.
//   node --test test/veil-leftout.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const sqlite3 = require("sqlite3");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "veil-leftout-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
process.env.ALIAS_SECRET = "a7".repeat(32);
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
process.env.MEDIA_DIR = path.join(tmp, "media");
process.env.FEED_DIR = path.join(tmp, "feed");
const { scanSource, schemaSql } = require(path.join(__dirname, "fixtures", "schemascan"));

// the real schema (snapshot + every CREATE TABLE in the code), like test/account-delete.test.js
const built = (async () => {
  const db = new sqlite3.Database(path.join(tmp, "myapp.db"));
  const run = (q) => new Promise((res, rej) => db.exec(q, (e) => (e ? rej(e) : res())));
  await run(schemaSql());
  for (const [, v] of scanSource(repo)) for (const sql of v.creates) await run(sql).catch(() => {});
  for (const c of ["archived_at INTEGER", "password_set INTEGER", "twitchLogin TEXT", "auto_source TEXT", "displayname_auto INTEGER", "age_confirmed_at INTEGER", "age_confirmed_v TEXT", "text_style TEXT"]) await run(`ALTER TABLE users ADD COLUMN ${c}`).catch(() => {});
  await new Promise((r) => db.close(r));
})();

const D = 864e5;
const hash = (login) => crypto.createHash("sha256").update("pepe-hidden:" + String(login).trim().toLowerCase()).digest("hex").slice(0, 20);
const ROOM = { id: "Leftout.Room", name: "Leftout Room" }, SLUG = "leftout-room";
const users = new Map();
const U = {};
let base, server, seq = 0;
let T = Date.now();
let runQuery, getQuery, rooms, bridge, CL, CV, PW, FN, ST, VS, LC, W, PA, stage, premium, MF, ACCT;

const ev = (type, data, ts = T) => ({ op: "event", id: "vlo-" + (++seq), ts: new Date(ts).toISOString(), type, scope: { platform: "camfrog", room: ROOM }, data });
const real = (login, display) => ({ id: login.toLowerCase(), login, display: display || login });
const priv = (kind, login, extra = {}) => Object.assign({ kind, h: hash(login), at: T / 1000 }, extra);
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
async function syncAt(body, v2 = true) {
  const realNow = Date.now;
  Date.now = () => T;
  try { return await bridge.ingest(Object.assign({ events: [], rooms: [], bridge_hidden_h: [], incog_hidden_h: [] }, body), { v2 }); }
  finally { Date.now = realNow; }
}
async function fresh() {
  await LC.forBot({ cap: true, mf: 1, live: [] }, T);
  Object.assign(bridge._rooms.get(ROOM.id), { updated: T, cams: true, livecams: true });
}
async function stepAt(sec) {
  T += sec * 1000;
  await fresh();
  MF.stepPad(ROOM.id, T);
  await MF._idle(); await settle(10);
}
const pad = () => MF._pads.get(ROOM.id);
const coverTiles = () => pad().state.tiles.filter((x) => x.cover);
// Pepe's v2 people: alice named; the veiled ones, each incognito or hidden
const PEOPLE = { frankiefettuccine: ["Frankie Fett", "incognito"], hankhidden: ["Hank Hide", "hidden"], gretagone: ["Greta Gone", "incognito"],
                 doradeleted: ["Dora Del", "incognito"] };
const veiled = (login) => Object.assign(real(login, PEOPLE[login][0]), { priv: priv(PEOPLE[login][1], login) });
/** The v2 snapshot with `logins` as PROVEN mic holders (and in the people list). */
function v2Room(logins) {
  return { room: ROOM, cams: true, livecams: true, count: logins.length + 1, transcripts: true,
           members: [real("alicecf", "Alice"), ...logins.map((l) => Object.assign(veiled(l), { src: "list", on_mic: true }))],
           mic: logins.map((l) => Object.assign(veiled(l), { proven: true, since: T / 1000 - 5 })) };
}
/** who -> the cover {key, id} up for them now (from the pad's own state), or null */
function coverOf(login) {
  for (const [key, c] of pad().covers) { const w = MF.coverWho(ROOM.id, c.id); if (w && w.login === login) return { key, id: c.id }; }
  return null;
}
/** Bring `logins` up as covers (a fresh v2 snapshot, then steps until each has its cover). */
async function coversUp(logins) {
  await syncAt({ rooms: [v2Room(logins)] });
  for (let i = 0; i < 12 && !logins.every((l) => coverOf(l)); i++) await stepAt(3);
  const out = {};
  for (const l of logins) { const c = coverOf(l); assert.ok(c, l + "'s cover is up: " + JSON.stringify(pad().state.tiles.map((x) => x.login))); out[l] = c; }
  return out;
}
/** Nobody on the mic and every tile gone (the pad keeps recent speakers a while): a clean stage for the next test. */
async function emptyStage() {
  await syncAt({ rooms: [v2Room([])] });
  for (let i = 0; i < 60 && pad().state.tiles.length; i++) await stepAt(10);
  assert.equal(pad().state.tiles.length, 0, "(an empty stage)");
}
const micEntry = (login) => (bridge._rooms.get(ROOM.id).mic || []).find((e) => e && e._vz && e._vz.login === login) || null;

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
async function mkUser(id, cls, cf) {
  await runQuery(`INSERT INTO users (userId, username, displayname, email, password, class, camfrogUsername, points_balance, isEmailVerified)
                  VALUES (?, ?, ?, ?, 'x', ?, ?, 0, 1)`, [id, id, id, id + "@example.com", cls, cf]);
  const u = { userId: id, username: id, class: cls };
  users.set(id, u);
  return u;
}
const live = (user) => call("GET", `/api/rooms/${SLUG}/live`, { user });
const reveal = (user, body) => call("POST", "/api/chatlog/reveal", { user, body: Object.assign({ room: SLUG }, body) });
const veiledIn = (list) => (list || []).filter((e) => e && e.anon && (e.veil === "incognito" || e.veil === "hidden"));
const stageLines = async () => (await getQuery("SELECT COUNT(*) AS n FROM seethrough_log WHERE scope = 'stage_line'"))[0].n;
const ADM = () => ({ userId: U.adm.userId, username: "adm", class: "Admin" });

const setup = (async () => {
  await built;
  ({ runQuery, getQuery } = require(path.join(repo, "dbUtils")));
  rooms = require(path.join(repo, "rooms"));
  require(path.join(repo, "terms"))._setRequired(false);
  bridge = require(path.join(repo, "bridge"));
  CL = require(path.join(repo, "chatlog"));
  CV = require(path.join(repo, "chatlogview"));
  PW = require(path.join(repo, "privwire"));
  FN = require(path.join(repo, "frognames"));
  ST = require(path.join(repo, "seethrough"));
  VS = require(path.join(repo, "veilstage"));
  LC = require(path.join(repo, "livecam"));
  W = require(path.join(repo, "webrtc"));
  PA = require(path.join(repo, "padaccess"));
  stage = require(path.join(repo, "mainstage"));
  premium = require(path.join(repo, "premium"));
  MF = require(path.join(repo, "micfollow"));
  ACCT = require(path.join(repo, "accountdelete"));
  W.enabled = () => true;
  premium.bridgeAllowed = () => true;
  MF._setClock(() => T);
  MF._setBoot(0);
  LC._setClock(() => T);
  stage._setClock(() => T);
  LC._setKick(() => {});
  await ACCT.init();
  await require(path.join(repo, "sessions")).init();
  await require(path.join(repo, "ledger")).ensure();
  await require(path.join(repo, "staleaccounts")).ensure();
  await require(path.join(repo, "inbox")).ready;
  U.own = await mkUser("own", "pleb", "owncf");
  U.mem = await mkUser("mem", "pleb", "memcf");
  U.adm = await mkUser("adm", "Admin", "admcf");
  U.frankie = await mkUser("frankie", "pleb", "frankiefettuccine");
  U.hank = await mkUser("hank", "pleb", "hankhidden");
  U.greta = await mkUser("greta", "pleb", "gretagone");
  U.dora = await mkUser("dora", "pleb", "doradeleted");
  await rooms.init();
  const express = require("express");
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
  await syncAt({ rooms: [{ room: ROOM, cams: true, livecams: true, members: [real("alicecf", "Alice")], mic: [], count: 1 }] }, false);
  for (let i = 0; i < 20 && !(await rooms.get(ROOM.id)); i++) await settle(20);
  await rooms.setOwner(ROOM.id, "own", "test");
  await PA.init();
  await PA.setLevel({ userId: U.own.userId, username: "own" }, { id: ROOM.id }, "public");
  await stage.init();
  await LC.init();
  await LC.save(ADM(), { cfg: { enabled: true } });
  await require(path.join(repo, "camaccess")).init();
  await MF._ready();
  await MF.setKill(ADM(), true, "test");
  await MF.setCfg(ADM(), { covers: true, reason: "test" });
  await MF.setPad(ROOM.id, { on: true }, "test");
  await CV.init();
  CV._clearCaches();
})();

test("XT-1 (staff): a staff removal takes the person's cover off at the next step - no 'recent' tile, no identity behind it - a tile Reveal before that is refused, and Pepe's next snapshot doesn't bring it back; a !bridge hide alone keeps its shadow cover; the staff undo brings it back", async () => {
  await setup;
  const c0 = await coversUp(["frankiefettuccine", "hankhidden"]);
  assert.ok(pad().settings.keep_recent > 0, "(the pad keeps recent speakers - a released tile would linger)");
  await syncAt({ events: [ev("message", { user: real("frankiefettuccine", "Frankie Fett"), text: "frankie on the mic", priv: priv("incognito", "frankiefettuccine") })] });
  const line = (await live(U.adm)).d.feed.find((o) => o.k === "msg" && o.text === "frankie on the mic");
  assert.ok(line, "frankie's line is up");
  // a !bridge hide alone (Pepe's bridge list: left out, but maskable - the HIDDEN level) keeps the shadow cover
  await syncAt({ rooms: [v2Room(["frankiefettuccine", "hankhidden"])], bridge_hidden_h: [hash("hankhidden")] });
  for (let i = 0; i < 3; i++) await stepAt(3);
  assert.equal(CV.kindNow(hash("hankhidden")), "out");
  assert.ok(coverOf("hankhidden"), "a !bridge hide person is masked, not left out: still their (shadow) cover");
  assert.equal(VS.leftOut("hankhidden"), false);

  // the staff per-login tool's "Hide every line" (chatlogmod hide_all -> chatlog.hideNow(keys, "staff"))
  const n0 = await stageLines();
  await CL.hideNow(["frankiefettuccine"], "staff");
  try {
    CV._clearCaches();
    assert.equal(VS.leftOut("frankiefettuccine"), true, "left out (staff)");
    // before the next step the cover is still up - the tile Reveal refuses it like a cover that's gone (the chat Reveal refuses too)
    for (const u of [U.adm, U.own]) {
      const r = await reveal(u, { tile: c0.frankiefettuccine.id });
      assert.equal(r.status, 404, u.username + ": " + r.text);
      assert.equal(r.d.code, "gone");
      assert.ok(!r.text.includes("frankiefettuccine") && !r.text.includes("Frankie"), "never named");
    }
    assert.equal((await reveal(U.adm, { c: [line.c] })).d.items.length, 0, "(the chat Reveal of their line: refused, as before)");
    assert.equal(await stageLines(), n0, "nothing revealed, nothing logged");
    // the next step: off at once - not a 'recent' tile, nothing behind it for coverWho
    await stepAt(1);
    assert.ok(!pad().state.tiles.some((x) => x.login === c0.frankiefettuccine.key), "no tile with their key (not even a recent one)");
    assert.equal(MF.coverWho(ROOM.id, c0.frankiefettuccine.id), null, "no identity left behind it");
    assert.ok(coverOf("hankhidden"), "the other cover stays");
    // Pepe knows nothing of the site's staff reason: his next snapshot still has frankie incognito on the mic
    await syncAt({ rooms: [v2Room(["frankiefettuccine", "hankhidden"])] });
    for (let i = 0; i < 6; i++) await stepAt(3);
    assert.equal(coverOf("frankiefettuccine"), null, "no cover comes back");
    assert.equal(coverTiles().length, 1, "only hank's");
    assert.ok(micEntry("frankiefettuccine"), "(their veiled R.mic entry is there)");
    assert.equal(VS.veilSource(micEntry("frankiefettuccine"), bridge._rooms.get(ROOM.id)), null, "the veil source offers no cover for them");
    const m = await live(U.mem);
    assert.equal(veiledIn(m.d.members).length, 1, "the people list leaves them out");
    assert.equal(veiledIn(m.d.mic).length, 1, "the mic list too");
    assert.equal(m.d.stage_program.src.filter((s) => s.kind === "cover").length, 1, "and now the stage");
  } finally {
    // the staff undo (chatlogmod unhide_all -> chatlog.unhideStaff; also when an assertion above failed: the next tests' state)
    await CL.unhideStaff(["frankiefettuccine"]);
    CV._clearCaches();
  }
  // ...and their cover may come back
  assert.equal(VS.leftOut("frankiefettuccine"), false);
  await syncAt({ rooms: [v2Room(["frankiefettuccine", "hankhidden"])] });
  for (let i = 0; i < 12 && !coverOf("frankiefettuccine"); i++) await stepAt(3);
  assert.ok(coverOf("frankiefettuccine"), "back after the undo");
});

test("XT-1 (forget-me): after a forget-me with 'also hide my past lines' Pepe's next snapshot brings no cover back under a new frog name", async () => {
  await setup;
  await emptyStage();
  const c0 = await coversUp(["gretagone"]);
  const r = await require(path.join(repo, "pepeforget")).request(U.greta.userId, { hideLines: true });
  assert.equal(r.ok, true);
  CV._clearCaches();
  assert.equal(FN.current(ROOM.id, "gretagone"), null, "(forget-me ended the session)");
  assert.equal(MF.coverWho(ROOM.id, c0.gretagone.id), null, "(and took the cover off)");
  assert.equal(VS.leftOut("gretagone"), true, "left out (forget)");
  // Pepe still relays her incognito: a new sighting, a new frog-name session - but no cover
  await syncAt({ rooms: [v2Room(["gretagone"])] });
  for (let i = 0; i < 8; i++) await stepAt(3);
  assert.ok(FN.current(ROOM.id, "gretagone"), "(Pepe's snapshot sighted her again)");
  assert.equal(coverOf("gretagone"), null, "no cover");
  assert.equal(coverTiles().length, 0);
  assert.equal(VS.veilSource(micEntry("gretagone"), bridge._rooms.get(ROOM.id)), null);
  const m = await live(U.mem);
  assert.equal(veiledIn(m.d.mic).length, 0, "(the mic list leaves her out)");
  assert.equal(m.d.stage_program.src.filter((s) => s.kind === "cover").length, 0, "the stage too");
});

test("XT-1 + XT-2 (account deletion, 'also hide my past lines'): the cover comes off at once and Pepe's next snapshot brings none back", async () => {
  await setup;
  await emptyStage();
  const c0 = await coversUp(["doradeleted"]);
  await ACCT.schedule({ userId: U.dora.userId, username: "dora" }, { by: "self", reauth: "password", hideLines: true });
  const del = await ACCT.execute(U.dora.userId, { force: true });
  assert.equal(del.ok, true, JSON.stringify(del));
  CV._clearCaches();
  assert.equal(VS.leftOut("doradeleted"), true, "left out (delete)");
  assert.equal(FN.current(ROOM.id, "doradeleted"), null, "the session ended");
  assert.equal(MF.coverWho(ROOM.id, c0.doradeleted.id), null, "the cover is off");
  assert.equal((await reveal(U.adm, { tile: c0.doradeleted.id })).status, 404);
  await syncAt({ rooms: [v2Room(["doradeleted"])] });
  for (let i = 0; i < 8; i++) await stepAt(3);
  assert.equal(coverOf("doradeleted"), null, "no cover");
  assert.equal(coverTiles().length, 0);
});

test("XT-2: an account deletion WITHOUT hiding lines ends the frog-name session and takes the veiled live items down - the cover goes at once, no _vz left in memory, the next appearance is a NEW session", async () => {
  await setup;
  const c0 = await coversUp(["frankiefettuccine"]);
  await syncAt({ events: [ev("message", { user: real("frankiefettuccine", "Frankie Fett"), text: "BEFORE deletion one", priv: priv("incognito", "frankiefettuccine") }),
                          ev("message", { user: real("frankiefettuccine", "Frankie Fett"), text: "BEFORE deletion two", priv: priv("incognito", "frankiefettuccine") })] });
  await settle();
  CV._clearCaches();
  const R = bridge._rooms.get(ROOM.id);
  const s0 = FN.current(ROOM.id, "frankiefettuccine");
  assert.ok(s0 && s0.session != null, "an open frog-name session");
  const before = R.feed.filter((it) => it.text && it.text.startsWith("BEFORE deletion"));
  assert.equal(before.length, 2);
  assert.ok(before.every((it) => it.u.alias === s0.alias), "both lines under the session's frog name");
  assert.ok((await live(U.mem)).d.feed.some((o) => o.text === "BEFORE deletion one"), "(members see them)");

  await ACCT.schedule({ userId: U.frankie.userId, username: "frankie" }, { by: "self", reauth: "password" });
  const del = await ACCT.execute(U.frankie.userId, { force: true });
  assert.equal(del.ok, true, JSON.stringify(del));
  assert.notEqual(del.report.chat_lines_hidden, true, "(no 'also hide my past lines')");
  CV._clearCaches();
  assert.equal(VS.leftOut("frankiefettuccine"), false, "(not left out: no delete reason in the sticky set)");
  // nothing in memory names them any more
  assert.equal(FN.current(ROOM.id, "frankiefettuccine"), null, "the frog-name session ended");
  assert.equal(MF.coverWho(ROOM.id, c0.frankiefettuccine.id), null, "the cover's identity is gone");
  assert.ok(!pad().state.tiles.some((x) => x.login === c0.frankiefettuccine.key), "the cover came off at once (no step, no 'recent' tile)");
  assert.equal(micEntry("frankiefettuccine"), null, "no veiled R.mic entry carries them");
  assert.ok(!(R.members || []).some((e) => e && e._vz && e._vz.login === "frankiefettuccine"), "no people-list entry either");
  assert.equal(R.feed.filter((it) => it._vz && it._vz.login === "frankiefettuccine").length, 0, "their veiled live items are down");
  const rows = await getQuery("SELECT snap FROM bridge_rooms WHERE id = ?", [ROOM.id]);
  assert.ok(rows.length && !String(rows[0].snap).includes("frankiefettuccine"), "(the persisted snapshot never names them)");
  const v = await getQuery("SELECT COUNT(*) AS n FROM bridge_rooms_veil WHERE id = ? AND data LIKE ?", [ROOM.id, "%frankiefettuccine%"]);
  assert.equal(v[0].n, 0, "bridge_rooms_veil holds no identity of theirs (a persist didn't write it back)");
  assert.ok(!(await live(U.mem)).d.feed.some((o) => o.text && o.text.startsWith("BEFORE deletion")), "their earlier lines left the page");
  assert.equal((await reveal(U.adm, { tile: c0.frankiefettuccine.id })).status, 404, "nothing to reveal on the stage");
  // Pepe keeps relaying them incognito (an account deletion doesn't switch that off): a NEW session, a new cover
  await syncAt({ events: [ev("message", { user: real("frankiefettuccine", "Frankie Fett"), text: "AFTER deletion", priv: priv("incognito", "frankiefettuccine") })] });
  await settle();
  const s1 = FN.current(ROOM.id, "frankiefettuccine");
  assert.ok(s1 && String(s1.session) !== String(s0.session), "a new frog-name session: " + JSON.stringify([s0, s1]));
  const c1 = await coversUp(["frankiefettuccine"]);
  assert.notEqual(c1.frankiefettuccine.key, c0.frankiefettuccine.key, "a new cover (another session's key)");
  assert.notEqual(c1.frankiefettuccine.id, c0.frankiefettuccine.id);
});
