// 1.99ajs mfproof: PRIVATE-ACTIVITY PRESENCE LINES (privact.js; owner report 2026-11-04 - brocklee258's "mic transcripts show with his
// username on the site, but shows his mic grabs as 'someone'"). The real facts: the PATV account brocklee258 linked to the Camfrog login
// ritchiecuh, its profile hiding the list prod's profile_layout row has (Analytics among it = private activity), and a CF auto account
// whose camfrogUsername is "brocklee258" (never his). On the real bridge feed (/live projection), chatlogview.dress and the downloads:
//   default      today's CL3 mask, exactly: his join / mic / unmic / leave lines are "someone"; his chat line and 🎙 transcript are
//                named (brocklee258, his PATV name) - and the people list and the 🎙 list name him (the incoherence the report saw)
//   mask off     (chatlog_meta 'privact_presence' {mask: false}, /admin/bridge, chatlog.admin, audited) those four lines name him too
//   never        an incognito / !bridge hide person, a former member and a purged line are unaffected; any failure = the mask
//   node --test test/mfproof-presence.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const repo = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mfproof-presence-test-"));
process.chdir(tmp);
delete process.env.STAGING;
delete process.env.CHATLOG_DB;
process.env.SECRET_KEY = "test-secret";
process.env.HLS_PLAYLIST_PATH = path.join(tmp, "no-hls", "broadcast.m3u8");
const express = require("express");
const { runQuery, getQuery } = require(path.join(repo, "dbUtils"));
const bridge = require(path.join(repo, "bridge"));
const CL = require(path.join(repo, "chatlog"));
const CV = require(path.join(repo, "chatlogview"));
const rooms = require(path.join(repo, "rooms"));
const UL = require(path.join(repo, "userlinks"));
const PA = require(path.join(repo, "privact"));

const hash = (login) => crypto.createHash("sha256").update("pepe-hidden:" + String(login).toLowerCase()).digest("hex").slice(0, 20);
const ROOM = { id: "PepeFrog.Room", name: "Pepe's Pad" };
const HIM = { id: "ritchiecuh", login: "ritchiecuh", display: "ritchiecuh" };
const SHY = { id: "shycf", login: "shycf", display: "Shy Violet" };         // goes !bridge hide
const HIDDEN = ["avatar", "gtf", "analytics", "plex", "an_words", "an_modon", "an_modlist", "an_modcmds", "px_watch", "px_pads"];
let seq = 0;
const ev = (type, data, ts) => ({ op: "event", id: "mp-" + (++seq), ts: new Date(ts || Date.now()).toISOString(), type, scope: { platform: "camfrog", room: ROOM }, data });
const users = new Map();
let base, server;

function call(method, url, user, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const u = new URL(base + url);
    const req = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: Object.assign({ "x-requested-with": "fetch" }, data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {},
                             user ? { "x-test-user": user.userId } : {}, headers || {}) }, (res) => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { s += c; });
      res.on("end", () => { let d = null; try { d = JSON.parse(s); } catch (e) { d = null; } resolve({ status: res.statusCode, d }); });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
async function mkUser(id, name, cls = "pleb", camfrog = null) {
  await runQuery("INSERT INTO users (userId, username, displayname, password, class, camfrogUsername) VALUES (?, ?, ?, 'x', ?, ?)", [id, name, name, cls, camfrog]);
  const u = { userId: id, username: name, class: cls };
  users.set(id, u);
  return u;
}
const U = {};
const settle = () => new Promise((r) => setTimeout(r, 60));
const whoOf = (it) => (it.u ? (it.u.anon ? "someone" : it.u.former ? "former" : it.u.login) : "");
const linesOf = (out, login) => out.feed.filter((it) => it.u && (it.u.login === login || it.u.anon) && ["join", "mic", "unmic", "leave", "msg", "tx"].includes(it.k));

const setup = (async () => {
  await runQuery(`CREATE TABLE IF NOT EXISTS users (userId TEXT PRIMARY KEY, username TEXT UNIQUE, displayname TEXT, password TEXT,
                  class TEXT DEFAULT 'pleb', points_balance INTEGER DEFAULT 0, camfrogUsername TEXT, avatar TEXT, archived_at INTEGER)`);
  UL._setQuery(null);
  U.mem = await mkUser("u_mem", "mem");
  U.him = await mkUser("u_brock", "brocklee258", "pleb", "ritchiecuh");
  U.auto = await mkUser("u_cfauto", "CFsa1p1bz8", "pleb", "brocklee258");
  U.adm = await mkUser("u_admin", "admin", "Admin");
  U.staff = await mkUser("u_staff", "staffer", "Staff");
  await bridge.load();
  await CL.init();
  await rooms.init();
  await CV.init();
  await require(path.join(repo, "profilelayout")).save(U.him.userId, { order: [], hidden: HIDDEN, priv: [], pub: [] });
  const app = express();
  app.use(express.json());
  const addUser = (req, res, next) => { const x = req.get("x-test-user"); req.user = x ? users.get(x) || null : null; next(); };
  bridge.register(app, { addUser, isBotToken: (t) => t === "bot" });
  PA.register(app, { addUser });
  await new Promise((r) => { server = app.listen(0, r); });
  server.unref();
  base = "http://127.0.0.1:" + server.address().port;
  const T = Date.now() - 5 * 60e3;
  await bridge.ingest({ rooms: [{ room: ROOM, members: [HIM, SHY], mic: [{ ...HIM, proven: true }], count: 2, transcripts: true }],
    events: [
      ev("member.join", { user: HIM }, T),
      ev("mic.grab", { user: HIM }, T + 1000),
      ev("x.pepe.transcript", { id: "tx-00000000000000a1", user: HIM, text: "ritchie on the mic" }, T + 2000),
      ev("mic.release", { user: HIM, held_ms: 9000 }, T + 10000),
      ev("message", { user: HIM, text: "ritchie in the chat" }, T + 11000),
      ev("member.join", { user: SHY }, T + 12000),
      ev("message", { user: SHY, text: "shy words" }, T + 13000),
      ev("member.leave", { user: HIM }, T + 20000),
    ] });
  await PA.init();
})();
const live = async () => { const R = bridge._rooms.get(ROOM.id); bridge._nameCache.clear(); return bridge.liveView(R, 0, U.mem.userId, null, "mem", true, { viewer: U.mem }); };

test("default = today's CL3 mask: his join / mic / unmic / leave lines are 'someone'; his chat line and transcript name him (his PATV name); the people list and 🎙 list name him", async () => {
  await setup;
  assert.equal(PA.masked(), true);
  assert.deepEqual(PA.state().mask, true, "no row: the mask");
  const out = await live();
  const mine = linesOf(out, "ritchiecuh");
  assert.deepEqual(mine.map((it) => it.k + ":" + whoOf(it)), ["join:someone", "mic:someone", "tx:ritchiecuh", "unmic:someone", "msg:ritchiecuh", "leave:someone"]);
  const tx = mine.find((it) => it.k === "tx"), msg = mine.find((it) => it.k === "msg");
  // (verify, rebased on 1.99ajn padppl: the impersonation guard - cfnames.clashOf - keeps the Camfrog name "ritchiecuh" on his lines once
  // it knows "brocklee258" is a Camfrog login Pepe has seen (the auto account's camfrogUsername); the line still links HIS account)
  for (const it of [tx, msg]) {
    assert.equal(it.u.patv && it.u.patv.username, "brocklee258", it.k + ": his PATV account (bridge.withPatv, lower(camfrogUsername) = ritchiecuh)");
    assert.ok(["brocklee258", "ritchiecuh"].includes(it.u.display), it.k + ": his PATV name, or his Camfrog name under the clash guard - " + it.u.display);
  }
  assert.ok(!JSON.stringify(out).includes("CFsa1p1bz8"), "the auto account whose camfrogUsername is 'brocklee258' never shows for him");
  for (const it of mine.filter((x) => x.u.anon)) assert.ok(!JSON.stringify(it).includes("ritchiecuh") && !JSON.stringify(it).includes("brocklee258"), it.k + ": no name anywhere in it");
  assert.ok(out.members.some((u) => u && u.login === "ritchiecuh"), "the people list names him (no private-activity check - CV.roster)");
  assert.ok((out.mic || []).some((u) => u && u.login === "ritchiecuh"), "the 🎙 list names him");
});

test("the switch: /api/admin/privact is chatlog.admin only, a same-site fetch, audited; mask: false names his presence lines (live and dress); mask again: today's", async () => {
  await setup;
  for (const u of [null, U.mem, U.staff]) {
    assert.equal((await call("GET", "/api/admin/privact", u)).status, 403, (u ? u.username : "signed out") + ": GET refused");
    assert.equal((await call("POST", "/api/admin/privact", u, { mask: false })).status, 403, (u ? u.username : "signed out") + ": POST refused");
  }
  assert.equal(PA.masked(), true, "nothing changed");
  assert.equal((await call("POST", "/api/admin/privact", U.adm, { mask: false }, { "x-requested-with": "xhr" })).status, 403, "not a fetch");
  assert.equal((await call("POST", "/api/admin/privact", U.adm, { mask: false }, { origin: "https://evil.example" })).status, 403, "cross-site");
  assert.equal((await call("POST", "/api/admin/privact", U.adm, { mask: "no" })).status, 400);
  const g = await call("GET", "/api/admin/privact", U.adm);
  assert.deepEqual([g.status, g.d.state.mask, g.d.state.masked], [200, true, true]);
  const off = await call("POST", "/api/admin/privact", U.adm, { mask: false });
  assert.deepEqual([off.status, off.d.state.mask, off.d.state.by], [200, false, "admin"]);
  try {
    const aud = await getQuery("SELECT * FROM admin_audit WHERE action = 'privact.presence' ORDER BY rowid DESC LIMIT 1");
    assert.equal(aud.length, 1, "audited");
    assert.deepEqual([aud[0].admin_id, JSON.parse(aud[0].detail)], [U.adm.userId, { mask: false }]);
    const out = await live();
    const mine = linesOf(out, "ritchiecuh");
    assert.deepEqual(mine.map((it) => it.k + ":" + whoOf(it)), ["join:ritchiecuh", "mic:ritchiecuh", "tx:ritchiecuh", "unmic:ritchiecuh", "msg:ritchiecuh", "leave:ritchiecuh"]);
    // (verify: named exactly like his chat line - the same account link and the same shown name, whatever the 1.99ajn clash guard picks)
    const said = mine.find((it) => it.k === "msg");
    for (const it of mine) {
      assert.equal(it.u.patv && it.u.patv.username, "brocklee258", it.k + ": his PATV account");
      assert.equal(it.u.display, said.u.display, it.k + ": the name his chat line shows");
    }
    // never anyone else's rules: the !bridge hide person stays left out, the purge / former member rules stand
    await bridge.ingest({ events: [{ op: "event", id: "mp-hd-" + (++seq), ts: new Date().toISOString(), type: "privacy.hidden", data: { h: hash("shycf"), scope: "bridge" } }],
                          rooms: [], hidden_h: [hash("shycf")] });
    await settle();
    const out2 = await live();
    assert.ok(!out2.feed.some((it) => it.u && /shycf|Shy Violet/i.test(JSON.stringify(it.u))), "a !bridge hide person: still left out");
    assert.ok(!out2.feed.some((it) => it.text === "shy words"), "...with their words");
    // dress (the history, search answers and downloads all dress through it): a lookup entry that says private activity
    const acc = { userId: U.him.userId, username: "brocklee258" };
    const items = ["join", "mic", "unmic", "leave"].map((k, i) => ({ c: 70 + i, k, ts: Date.now(), u: { login: "ritchiecuh", display: "ritchiecuh" } }));
    const dressed = () => CV.dress(items, { view: null, lookup: () => ({ acc, priv: true, at: Date.now() }) }).map((it) => (it.u.anon ? "someone" : it.u.login)).join(",");
    assert.equal(dressed(), "ritchiecuh,ritchiecuh,ritchiecuh,ritchiecuh", "mask off");
    assert.equal(CV.dress([{ c: 80, k: "join", ts: Date.now(), u: { anon: true, display: "someone" } }], { lookup: () => undefined })[0].u.anon, true, "an anonymised line stays someone");
    assert.equal(CV.dress([{ c: 81, k: "mic", ts: Date.now(), purged: 1, u: { login: "ritchiecuh" } }], { lookup: () => ({ acc, priv: true }) })[0].u.anon, true, "a purged line stays someone");
  } finally {
    const on = await call("POST", "/api/admin/privact", U.adm, { mask: true });
    assert.deepEqual([on.status, on.d.state.mask], [200, true]);
  }
  const back = linesOf(await live(), "ritchiecuh");
  assert.deepEqual(back.map((it) => it.k + ":" + whoOf(it)), ["join:someone", "mic:someone", "tx:ritchiecuh", "unmic:someone", "msg:ritchiecuh", "leave:someone"], "masked again: today's");
});

test("verify: a masked presence line never carries its hold id (Pepe's v2 hold id is on his NAMED transcript of the same hold - it paired 'someone' back to him); mask off: named lines keep it", async () => {
  await setup;
  const acc = { userId: U.him.userId, username: "brocklee258" };
  const H = "hd-0123456789abcdef";
  const u = { login: "ritchiecuh", display: "ritchiecuh" };
  const items = [{ c: 60, k: "mic", ts: Date.now(), u, hold: H }, { c: 61, k: "tx", ts: Date.now(), u, text: "ritchie on the mic", id: "tx-00000000000000b1", hold: H },
                 { c: 62, k: "unmic", ts: Date.now(), u, ms: 9000, hold: H }];
  const ctx = { view: null, lookup: () => ({ acc, priv: true, at: Date.now() }) };
  assert.equal(PA.masked(), true);
  const m = CV.dress(items, ctx);
  assert.deepEqual(m.map((it) => it.k + ":" + (it.u.anon ? "someone" : it.u.login) + ":" + (it.hold || "-")),
                   ["mic:someone:-", "tx:ritchiecuh:" + H, "unmic:someone:-"], "masked: no hold beside 'someone' (nothing pairs it with the named 🎙 line)");
  for (const it of m.filter((x) => x.u.anon)) assert.ok(!JSON.stringify(it).includes(H), it.k);
  // not private: today's named lines with their hold, untouched
  assert.deepEqual(CV.dress(items, { view: null, lookup: () => ({ acc, priv: false }) }).map((it) => it.hold), [H, H, H]);
  await PA.setMask(false, { userId: U.adm.userId, username: "admin" });
  try {
    assert.deepEqual(CV.dress(items, ctx).map((it) => it.k + ":" + it.u.login + ":" + it.hold), ["mic:ritchiecuh:" + H, "tx:ritchiecuh:" + H, "unmic:ritchiecuh:" + H],
                     "named (mask off): the hold pairs named lines, as for anyone");
  } finally { await PA.setMask(true, { userId: U.adm.userId, username: "admin" }); }
});

test("stored and fails closed: the row survives a restart; an unloaded or unreadable switch is the mask; the module failing is the mask", async () => {
  await setup;
  await PA.setMask(false, { userId: U.adm.userId, username: "admin" });
  PA._reset();
  assert.equal(PA.masked(), true, "not loaded yet: masked");
  await PA.init();
  assert.equal(PA.masked(), false, "the stored row: named");
  await runQuery("UPDATE chatlog_meta SET value = 'not json' WHERE key = ?", [PA.KEY]);
  PA._reset(); await PA.init();
  assert.equal(PA.masked(), true, "an unreadable row: masked");
  for (const bad of [null, {}, { mask: "false" }, { mask: 0 }]) assert.equal(PA.cleanState(bad).mask, true, JSON.stringify(bad));
  await PA.setMask(true, { userId: U.adm.userId, username: "admin" });
  // a module that throws: dress keeps the mask
  const m0 = PA.masked;
  PA.masked = () => { throw new Error("boom"); };
  try {
    const it = CV.dress([{ c: 90, k: "mic", ts: Date.now(), u: { login: "ritchiecuh", display: "ritchiecuh" } }], { lookup: () => ({ acc: { userId: U.him.userId }, priv: true }) })[0];
    assert.equal(it.u.anon, true);
  } finally { PA.masked = m0; }
});
